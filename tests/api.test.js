import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import argon2 from 'argon2';

const TEST_USER = 'tester';
const TEST_PASS = 's3cret-pa$$';
const AUTH = 'Basic ' + Buffer.from(`${TEST_USER}:${TEST_PASS}`).toString('base64');

let server;
let dbHandle;
let workDir;
let baseUrl;

async function req(method, p, { body, auth = AUTH } = {}) {
  const opts = { method, headers: {} };
  if (auth !== null && auth !== undefined) opts.headers['Authorization'] = auth;
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${baseUrl}${p}`, opts);
  const text = await res.text();
  let json = null;
  if (text.length > 0) {
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
  }
  return { status: res.status, json, headers: res.headers };
}

function assertPeriodShape(p) {
  assert.equal(typeof p.id, 'number');
  assert.ok(p.id >= 1);
  assert.equal(typeof p.name, 'string');
  assert.ok(p.name.length >= 1);
  assert.equal(typeof p.budget, 'number');
  assert.ok(p.budget >= 0);
  assert.match(p.opened_at, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(p.closed_at === null || /^\d{4}-\d{2}-\d{2}T/.test(p.closed_at));
  assert.ok(['open', 'closed'].includes(p.status));
  assert.equal(typeof p.spent, 'number');
  assert.equal(typeof p.remaining, 'number');
  assert.equal(typeof p.expense_count, 'number');
  assert.ok(p.expense_count >= 0);
  assert.equal(p.remaining, p.budget - p.spent);
  assert.equal(p.status === 'open', p.closed_at === null);
}

function assertExpenseShape(e) {
  assert.equal(typeof e.id, 'number');
  assert.ok(e.id >= 1);
  assert.equal(typeof e.period_id, 'number');
  assert.ok(e.period_id >= 1);
  assert.equal(typeof e.amount, 'number');
  assert.equal(typeof e.label, 'string');
  assert.ok(e.label.length >= 1);
  assert.match(e.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(e.created_at, /^\d{4}-\d{2}-\d{2}T/);
}

function assertErrorShape(json) {
  assert.ok(json !== null && typeof json === 'object');
  assert.equal(typeof json.error, 'string');
  assert.equal(typeof json.message, 'string');
}

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), 'budget-test-'));
  process.env.DB_PATH = path.join(workDir, 'app.db');

  // src/db.js reads DB_PATH at import time and creates the schema on first open.
  const dbMod = await import('../src/db.js');
  dbHandle = dbMod.db;
  const hash = await argon2.hash(TEST_PASS, { type: argon2.argon2id });
  dbHandle.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)').run(TEST_USER, hash);

  const { app } = await import('../src/index.js');
  await new Promise((resolve, reject) => {
    server = app.listen(0, '127.0.0.1', resolve);
    server.once('error', reject);
  });
  const { port } = server.address();
  baseUrl = `http://127.0.0.1:${port}/api/v1`;
});

after(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  if (dbHandle) dbHandle.close();
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

// Module-scoped state — tests run sequentially and progressively build up the DB.
let period1Id;
let period2Id;
let expGroceriesId;
let expRestaurantId;
let expZeroId;

describe('Authentication', () => {
  test('GET /periods without auth → 401 + WWW-Authenticate', async () => {
    const { status, json, headers } = await req('GET', '/periods', { auth: null });
    assert.equal(status, 401);
    assertErrorShape(json);
    assert.equal(json.error, 'unauthorized');
    assert.match(headers.get('www-authenticate') ?? '', /^Basic /);
  });

  test('non-Basic Authorization header → 401', async () => {
    const { status, json } = await req('GET', '/periods', { auth: 'Bearer token' });
    assert.equal(status, 401);
    assertErrorShape(json);
  });

  test('Basic without colon → 401', async () => {
    const bad = 'Basic ' + Buffer.from('no-colon-here').toString('base64');
    const { status } = await req('GET', '/periods', { auth: bad });
    assert.equal(status, 401);
  });

  test('unknown user → 401', async () => {
    const bad = 'Basic ' + Buffer.from('nobody:nope').toString('base64');
    const { status } = await req('GET', '/periods', { auth: bad });
    assert.equal(status, 401);
  });

  test('wrong password → 401', async () => {
    const bad = 'Basic ' + Buffer.from(`${TEST_USER}:wrong-pass`).toString('base64');
    const { status } = await req('GET', '/periods', { auth: bad });
    assert.equal(status, 401);
  });

  test('valid credentials → 200', async () => {
    const { status } = await req('GET', '/periods');
    assert.equal(status, 200);
  });
});

describe('Initial state — no period exists yet', () => {
  test('GET /periods → 200 []', async () => {
    const { status, json } = await req('GET', '/periods');
    assert.equal(status, 200);
    assert.deepEqual(json, []);
  });

  test('GET /periods/current → 404', async () => {
    const { status, json } = await req('GET', '/periods/current');
    assert.equal(status, 404);
    assertErrorShape(json);
    assert.equal(json.error, 'not_found');
  });

  test('GET /periods/current/expenses → 404', async () => {
    const { status, json } = await req('GET', '/periods/current/expenses');
    assert.equal(status, 404);
    assertErrorShape(json);
  });

  test('POST /periods/current/expenses → 404 when no open period', async () => {
    const { status, json } = await req('POST', '/periods/current/expenses', {
      body: { amount: -100, label: 'nope' },
    });
    assert.equal(status, 404);
    assertErrorShape(json);
  });

  test('GET /periods/{id} on unknown id → 404', async () => {
    const { status, json } = await req('GET', '/periods/999999');
    assert.equal(status, 404);
    assertErrorShape(json);
  });
});

describe('POST /periods — creation', () => {
  test('creates the first period and exposes it as current', async () => {
    const before = Date.now();
    const { status, json } = await req('POST', '/periods', {
      body: { name: 'January 2026', budget: 50000 },
    });
    assert.equal(status, 201);
    assertPeriodShape(json);
    assert.equal(json.name, 'January 2026');
    assert.equal(json.budget, 50000);
    assert.equal(json.status, 'open');
    assert.equal(json.closed_at, null);
    assert.equal(json.spent, 0);
    assert.equal(json.remaining, 50000);
    assert.equal(json.expense_count, 0);
    const openedMs = Date.parse(json.opened_at);
    assert.ok(openedMs >= before - 1000 && openedMs <= Date.now() + 1000);
    period1Id = json.id;

    const { status: cStatus, json: current } = await req('GET', '/periods/current');
    assert.equal(cStatus, 200);
    assert.equal(current.id, period1Id);
  });

  test('400 when required field is missing', async () => {
    const { status, json } = await req('POST', '/periods', { body: { name: 'Orphan' } });
    assert.equal(status, 400);
    assertErrorShape(json);
    assert.equal(json.error, 'validation_failed');
  });

  test('400 on invalid budget (negative)', async () => {
    const { status } = await req('POST', '/periods', { body: { name: 'Neg', budget: -1 } });
    assert.equal(status, 400);
  });

  test('400 on empty name', async () => {
    const { status } = await req('POST', '/periods', { body: { name: '', budget: 100 } });
    assert.equal(status, 400);
  });

  test('400 on additional property', async () => {
    const { status } = await req('POST', '/periods', {
      body: { name: 'X', budget: 1, extra: true },
    });
    assert.equal(status, 400);
  });

  test('400 on missing body', async () => {
    const res = await fetch(`${baseUrl}/periods`, {
      method: 'POST',
      headers: { Authorization: AUTH, 'Content-Type': 'application/json' },
    });
    assert.equal(res.status, 400);
  });

  test('409 on duplicate name', async () => {
    const { status, json } = await req('POST', '/periods', {
      body: { name: 'January 2026', budget: 12345 },
    });
    assert.equal(status, 409);
    assertErrorShape(json);
    assert.equal(json.error, 'conflict');
  });

  test('creating a second period closes the first one atomically', async () => {
    const { status, json } = await req('POST', '/periods', {
      body: { name: 'February 2026', budget: 75000 },
    });
    assert.equal(status, 201);
    assertPeriodShape(json);
    assert.equal(json.status, 'open');
    period2Id = json.id;
    assert.notEqual(period2Id, period1Id);

    const { json: first } = await req('GET', `/periods/${period1Id}`);
    assert.equal(first.status, 'closed');
    assert.notEqual(first.closed_at, null);

    const { json: current } = await req('GET', '/periods/current');
    assert.equal(current.id, period2Id);
  });
});

describe('GET /periods — list', () => {
  test('returns both periods sorted by opened_at DESC', async () => {
    const { status, json } = await req('GET', '/periods');
    assert.equal(status, 200);
    assert.ok(Array.isArray(json));
    assert.equal(json.length, 2);
    json.forEach(assertPeriodShape);
    assert.equal(json[0].id, period2Id);
    assert.equal(json[1].id, period1Id);
    assert.ok(json[0].opened_at >= json[1].opened_at);
  });
});

describe('GET /periods/{id}', () => {
  test('returns the requested period', async () => {
    const { status, json } = await req('GET', `/periods/${period1Id}`);
    assert.equal(status, 200);
    assertPeriodShape(json);
    assert.equal(json.id, period1Id);
    assert.equal(json.status, 'closed');
  });

  test('404 on unknown id', async () => {
    const { status, json } = await req('GET', '/periods/999999');
    assert.equal(status, 404);
    assertErrorShape(json);
  });

  test('400 on non-integer id', async () => {
    const { status } = await req('GET', '/periods/abc');
    assert.equal(status, 400);
  });
});

describe('PATCH /periods/{id}', () => {
  test('updates name only', async () => {
    const { status, json } = await req('PATCH', `/periods/${period1Id}`, {
      body: { name: 'January 2026 (archived)' },
    });
    assert.equal(status, 200);
    assertPeriodShape(json);
    assert.equal(json.name, 'January 2026 (archived)');
    assert.equal(json.status, 'closed');
  });

  test('updates budget only', async () => {
    const { status, json } = await req('PATCH', `/periods/${period1Id}`, {
      body: { budget: 60000 },
    });
    assert.equal(status, 200);
    assert.equal(json.budget, 60000);
  });

  test('updates name and budget together', async () => {
    const { status, json } = await req('PATCH', `/periods/${period2Id}`, {
      body: { name: 'Feb 2026', budget: 80000 },
    });
    assert.equal(status, 200);
    assert.equal(json.name, 'Feb 2026');
    assert.equal(json.budget, 80000);
  });

  test('400 with empty body (minProperties: 1)', async () => {
    const { status } = await req('PATCH', `/periods/${period2Id}`, { body: {} });
    assert.equal(status, 400);
  });

  test('400 on additional property', async () => {
    const { status } = await req('PATCH', `/periods/${period2Id}`, { body: { foo: 'bar' } });
    assert.equal(status, 400);
  });

  test('400 on invalid budget', async () => {
    const { status } = await req('PATCH', `/periods/${period2Id}`, { body: { budget: -10 } });
    assert.equal(status, 400);
  });

  test('409 when renaming to an already-used name', async () => {
    const { status, json } = await req('PATCH', `/periods/${period1Id}`, {
      body: { name: 'Feb 2026' },
    });
    assert.equal(status, 409);
    assertErrorShape(json);
    assert.equal(json.error, 'conflict');
  });

  test('404 on unknown id', async () => {
    const { status } = await req('PATCH', '/periods/999999', { body: { name: 'X' } });
    assert.equal(status, 404);
  });
});

describe('POST /periods/current/expenses', () => {
  test('201 — negative amount (dépense)', async () => {
    const { status, json } = await req('POST', '/periods/current/expenses', {
      body: { amount: -1500, label: 'Groceries' },
    });
    assert.equal(status, 201);
    assertExpenseShape(json);
    assert.equal(json.period_id, period2Id);
    assert.equal(json.amount, -1500);
    assert.equal(json.label, 'Groceries');
    expGroceriesId = json.id;
  });

  test('201 — explicit date is honored', async () => {
    const { status, json } = await req('POST', '/periods/current/expenses', {
      body: { amount: -2500, label: 'Restaurant', date: '2026-02-14' },
    });
    assert.equal(status, 201);
    assertExpenseShape(json);
    assert.equal(json.date, '2026-02-14');
    expRestaurantId = json.id;
  });

  test('201 — positive amount (remboursement)', async () => {
    const { status, json } = await req('POST', '/periods/current/expenses', {
      body: { amount: 1000, label: 'Refund' },
    });
    assert.equal(status, 201);
    assert.equal(json.amount, 1000);
  });

  test('201 — zero amount allowed', async () => {
    const { status, json } = await req('POST', '/periods/current/expenses', {
      body: { amount: 0, label: 'Free sample' },
    });
    assert.equal(status, 201);
    assert.equal(json.amount, 0);
    expZeroId = json.id;
  });

  test('400 — missing amount', async () => {
    const { status, json } = await req('POST', '/periods/current/expenses', {
      body: { label: 'No amount' },
    });
    assert.equal(status, 400);
    assertErrorShape(json);
  });

  test('400 — missing label', async () => {
    const { status } = await req('POST', '/periods/current/expenses', {
      body: { amount: -100 },
    });
    assert.equal(status, 400);
  });

  test('400 — empty label', async () => {
    const { status } = await req('POST', '/periods/current/expenses', {
      body: { amount: -100, label: '' },
    });
    assert.equal(status, 400);
  });

  test('400 — non-integer amount', async () => {
    const { status } = await req('POST', '/periods/current/expenses', {
      body: { amount: 1.5, label: 'Half' },
    });
    assert.equal(status, 400);
  });

  test('400 — malformed date', async () => {
    const { status } = await req('POST', '/periods/current/expenses', {
      body: { amount: -100, label: 'X', date: 'not-a-date' },
    });
    assert.equal(status, 400);
  });

  test('400 — additional property', async () => {
    const { status } = await req('POST', '/periods/current/expenses', {
      body: { amount: -100, label: 'X', period_id: period1Id },
    });
    assert.equal(status, 400);
  });
});

describe('Period computed fields', () => {
  test('spent / remaining / expense_count reflect the current period', async () => {
    // Current period (period2) holds 4 expenses: -1500, -2500, +1000, 0
    // sum = -3000 → spent = 3000 → remaining = 80000 - 3000 = 77000
    const { json } = await req('GET', `/periods/${period2Id}`);
    assert.equal(json.spent, 3000);
    assert.equal(json.remaining, 77000);
    assert.equal(json.expense_count, 4);
  });

  test('closed period without expenses has zero spent / full remaining', async () => {
    const { json } = await req('GET', `/periods/${period1Id}`);
    assert.equal(json.spent, 0);
    assert.equal(json.remaining, json.budget);
    assert.equal(json.expense_count, 0);
  });
});

describe('GET expenses listings', () => {
  test('GET /periods/current/expenses — 200, sorted by date DESC then created_at DESC', async () => {
    const { status, json } = await req('GET', '/periods/current/expenses');
    assert.equal(status, 200);
    assert.ok(Array.isArray(json));
    assert.equal(json.length, 4);
    json.forEach(assertExpenseShape);
    for (let i = 1; i < json.length; i++) {
      const prev = json[i - 1];
      const cur = json[i];
      if (prev.date === cur.date) {
        assert.ok(prev.created_at >= cur.created_at, 'within same date: created_at DESC');
      } else {
        assert.ok(prev.date > cur.date, 'across dates: date DESC');
      }
    }
  });

  test('GET /periods/{id}/expenses — same data when id matches current', async () => {
    const { status, json } = await req('GET', `/periods/${period2Id}/expenses`);
    assert.equal(status, 200);
    assert.equal(json.length, 4);
  });

  test('GET /periods/{id}/expenses — empty list for a period without expenses', async () => {
    const { status, json } = await req('GET', `/periods/${period1Id}/expenses`);
    assert.equal(status, 200);
    assert.deepEqual(json, []);
  });

  test('GET /periods/{id}/expenses — 404 on unknown period', async () => {
    const { status, json } = await req('GET', '/periods/999999/expenses');
    assert.equal(status, 404);
    assertErrorShape(json);
  });
});

describe('GET /expenses/{id}', () => {
  test('200 returns the expense', async () => {
    const { status, json } = await req('GET', `/expenses/${expGroceriesId}`);
    assert.equal(status, 200);
    assertExpenseShape(json);
    assert.equal(json.id, expGroceriesId);
    assert.equal(json.label, 'Groceries');
  });

  test('404 on unknown id', async () => {
    const { status, json } = await req('GET', '/expenses/999999');
    assert.equal(status, 404);
    assertErrorShape(json);
  });

  test('400 on non-integer id', async () => {
    const { status } = await req('GET', '/expenses/not-a-number');
    assert.equal(status, 400);
  });
});

describe('PATCH /expenses/{id}', () => {
  test('updates the amount', async () => {
    const { status, json } = await req('PATCH', `/expenses/${expGroceriesId}`, {
      body: { amount: -2000 },
    });
    assert.equal(status, 200);
    assertExpenseShape(json);
    assert.equal(json.amount, -2000);
  });

  test('updates the label', async () => {
    const { status, json } = await req('PATCH', `/expenses/${expGroceriesId}`, {
      body: { label: 'Big groceries' },
    });
    assert.equal(status, 200);
    assert.equal(json.label, 'Big groceries');
  });

  test('updates the date', async () => {
    const { status, json } = await req('PATCH', `/expenses/${expGroceriesId}`, {
      body: { date: '2026-02-01' },
    });
    assert.equal(status, 200);
    assert.equal(json.date, '2026-02-01');
  });

  test('moves the expense to a closed period via period_id', async () => {
    // Move the modified groceries expense (amount -2000) from period2 (open) to period1 (closed).
    const { status, json } = await req('PATCH', `/expenses/${expGroceriesId}`, {
      body: { period_id: period1Id },
    });
    assert.equal(status, 200);
    assert.equal(json.period_id, period1Id);

    const { json: closed } = await req('GET', `/periods/${period1Id}`);
    assert.equal(closed.status, 'closed');
    assert.equal(closed.expense_count, 1);
    assert.equal(closed.spent, 2000);
    assert.equal(closed.remaining, closed.budget - 2000);

    const { json: current } = await req('GET', `/periods/${period2Id}`);
    assert.equal(current.expense_count, 3);
    // remaining current sum: -2500 + 1000 + 0 = -1500 → spent = 1500
    assert.equal(current.spent, 1500);
  });

  test('400 with empty body (minProperties: 1)', async () => {
    const { status } = await req('PATCH', `/expenses/${expRestaurantId}`, { body: {} });
    assert.equal(status, 400);
  });

  test('400 on additional property', async () => {
    const { status } = await req('PATCH', `/expenses/${expRestaurantId}`, {
      body: { other: 1 },
    });
    assert.equal(status, 400);
  });

  test('400 on invalid date format', async () => {
    const { status } = await req('PATCH', `/expenses/${expRestaurantId}`, {
      body: { date: '14/02/2026' },
    });
    assert.equal(status, 400);
  });

  test('400 on empty label', async () => {
    const { status } = await req('PATCH', `/expenses/${expRestaurantId}`, {
      body: { label: '' },
    });
    assert.equal(status, 400);
  });

  test('404 on unknown expense id', async () => {
    const { status } = await req('PATCH', '/expenses/999999', { body: { amount: 0 } });
    assert.equal(status, 404);
  });

  test('404 when target period_id does not exist', async () => {
    const { status, json } = await req('PATCH', `/expenses/${expRestaurantId}`, {
      body: { period_id: 999999 },
    });
    assert.equal(status, 404);
    assertErrorShape(json);
  });
});

describe('DELETE /expenses/{id}', () => {
  test('204 then 404 on second GET', async () => {
    const { status, json } = await req('DELETE', `/expenses/${expZeroId}`);
    assert.equal(status, 204);
    assert.equal(json, null);

    const { status: getStatus } = await req('GET', `/expenses/${expZeroId}`);
    assert.equal(getStatus, 404);
  });

  test('404 on unknown id', async () => {
    const { status, json } = await req('DELETE', '/expenses/999999');
    assert.equal(status, 404);
    assertErrorShape(json);
  });

  test('current period reflects the deletion', async () => {
    const { json } = await req('GET', `/periods/${period2Id}`);
    // Was 3 expenses (-2500, +1000, 0); removed the zero → 2 expenses, sum unchanged.
    assert.equal(json.expense_count, 2);
    assert.equal(json.spent, 1500);
  });
});

describe('Unknown route', () => {
  test('returns 404 with the documented error shape', async () => {
    const { status, json } = await req('GET', '/does-not-exist');
    assert.equal(status, 404);
    assertErrorShape(json);
  });
});
