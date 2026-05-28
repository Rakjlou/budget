import { db, tx } from './db.js';

const PERIOD_SELECT = `
  SELECT
    p.id,
    p.name,
    p.budget,
    p.opened_at,
    p.closed_at,
    CASE WHEN p.closed_at IS NULL THEN 'open' ELSE 'closed' END AS status,
    COALESCE(-SUM(e.amount), 0) AS spent,
    p.budget - COALESCE(-SUM(e.amount), 0) AS remaining,
    COUNT(e.id) AS expense_count
  FROM periods p
  LEFT JOIN expenses e ON e.period_id = p.id
`;

function findPeriodById(id) {
  return db.prepare(`${PERIOD_SELECT} WHERE p.id = ? GROUP BY p.id`).get(id);
}

function findCurrentPeriod() {
  return db.prepare(`${PERIOD_SELECT} WHERE p.closed_at IS NULL GROUP BY p.id`).get();
}

const SQLITE_CONSTRAINT_UNIQUE = 2067;

function isUniqueViolation(err) {
  return err && err.errcode === SQLITE_CONSTRAINT_UNIQUE;
}

function conflictResponse(res, name) {
  res.status(409).json({
    error: 'conflict',
    message: `Period name "${name}" already exists`,
  });
}

function notFound(res, message = 'Period not found') {
  res.status(404).json({ error: 'not_found', message });
}

export async function listPeriods(req, res) {
  const rows = db.prepare(`${PERIOD_SELECT} GROUP BY p.id ORDER BY p.opened_at DESC`).all();
  res.json(rows);
}

export async function createPeriod(req, res) {
  const { name, budget } = req.body;
  const now = new Date().toISOString();

  try {
    const id = tx(() => {
      db.prepare('UPDATE periods SET closed_at = ? WHERE closed_at IS NULL').run(now);
      const info = db
        .prepare(
          'INSERT INTO periods (name, budget, opened_at, closed_at) VALUES (?, ?, ?, NULL)'
        )
        .run(name, budget, now);
      return Number(info.lastInsertRowid);
    });
    res.status(201).json(findPeriodById(id));
  } catch (err) {
    if (isUniqueViolation(err)) return conflictResponse(res, name);
    throw err;
  }
}

export async function getCurrentPeriod(req, res) {
  const row = findCurrentPeriod();
  if (!row) return notFound(res, 'No open period');
  res.json(row);
}

export async function getPeriod(req, res) {
  const id = Number(req.params.id);
  const row = findPeriodById(id);
  if (!row) return notFound(res);
  res.json(row);
}

export async function updatePeriod(req, res) {
  const id = Number(req.params.id);
  const { name, budget } = req.body;

  const sets = [];
  const params = [];
  if (name !== undefined) {
    sets.push('name = ?');
    params.push(name);
  }
  if (budget !== undefined) {
    sets.push('budget = ?');
    params.push(budget);
  }
  params.push(id);

  try {
    db.prepare(`UPDATE periods SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  } catch (err) {
    if (isUniqueViolation(err)) return conflictResponse(res, name);
    throw err;
  }

  const updated = findPeriodById(id);
  if (!updated) return notFound(res);
  res.json(updated);
}
