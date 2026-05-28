import { db } from './db.js';

const EXPENSE_SELECT = `
  SELECT id, period_id, amount, label, date, created_at
  FROM expenses
`;

function findExpenseById(id) {
  return db.prepare(`${EXPENSE_SELECT} WHERE id = ?`).get(id);
}

function findCurrentPeriodId() {
  return db.prepare('SELECT id FROM periods WHERE closed_at IS NULL').get();
}

function notFound(res, message) {
  res.status(404).json({ error: 'not_found', message });
}

export async function listCurrentExpenses(req, res) {
  const current = findCurrentPeriodId();
  if (!current) return notFound(res, 'No open period');
  const rows = db
    .prepare(`${EXPENSE_SELECT} WHERE period_id = ? ORDER BY date DESC, created_at DESC`)
    .all(current.id);
  res.json(rows);
}

export async function createCurrentExpense(req, res) {
  const current = findCurrentPeriodId();
  if (!current) return notFound(res, 'No open period');

  const { amount, label, date } = req.body;
  const createdAt = new Date().toISOString();
  const expenseDate = date || createdAt.slice(0, 10);

  const info = db
    .prepare(
      `INSERT INTO expenses (period_id, amount, label, date, created_at)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(current.id, amount, label, expenseDate, createdAt);

  res.status(201).json(findExpenseById(Number(info.lastInsertRowid)));
}

export async function listExpensesByPeriod(req, res) {
  const periodId = Number(req.params.id);
  const period = db.prepare('SELECT id FROM periods WHERE id = ?').get(periodId);
  if (!period) return notFound(res, 'Period not found');

  const rows = db
    .prepare(`${EXPENSE_SELECT} WHERE period_id = ? ORDER BY date DESC, created_at DESC`)
    .all(periodId);
  res.json(rows);
}

export async function getExpense(req, res) {
  const id = Number(req.params.id);
  const row = findExpenseById(id);
  if (!row) return notFound(res, 'Expense not found');
  res.json(row);
}

export async function updateExpense(req, res) {
  const id = Number(req.params.id);
  const existing = findExpenseById(id);
  if (!existing) return notFound(res, 'Expense not found');

  const { amount, label, date, period_id } = req.body;

  if (period_id !== undefined && period_id !== existing.period_id) {
    const target = db.prepare('SELECT id FROM periods WHERE id = ?').get(period_id);
    if (!target) return notFound(res, 'Target period not found');
  }

  const sets = [];
  const params = [];
  if (amount !== undefined) {
    sets.push('amount = ?');
    params.push(amount);
  }
  if (label !== undefined) {
    sets.push('label = ?');
    params.push(label);
  }
  if (date !== undefined) {
    sets.push('date = ?');
    params.push(date);
  }
  if (period_id !== undefined) {
    sets.push('period_id = ?');
    params.push(period_id);
  }
  params.push(id);

  db.prepare(`UPDATE expenses SET ${sets.join(', ')} WHERE id = ?`).run(...params);

  res.json(findExpenseById(id));
}

export async function deleteExpense(req, res) {
  const id = Number(req.params.id);
  const info = db.prepare('DELETE FROM expenses WHERE id = ?').run(id);
  if (info.changes === 0) return notFound(res, 'Expense not found');
  res.status(204).end();
}
