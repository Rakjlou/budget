import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';

const DB_PATH = process.env.DB_PATH || './data/app.db';

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);

db.exec('PRAGMA journal_mode = WAL;');
db.exec('PRAGMA foreign_keys = ON;');
db.exec('PRAGMA synchronous = NORMAL;');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id            INTEGER PRIMARY KEY,
    username      TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS periods (
    id        INTEGER PRIMARY KEY,
    name      TEXT NOT NULL UNIQUE,
    budget    INTEGER NOT NULL,
    opened_at TEXT NOT NULL,
    closed_at TEXT
  ) STRICT;

  CREATE UNIQUE INDEX IF NOT EXISTS idx_periods_one_open
    ON periods((1)) WHERE closed_at IS NULL;

  CREATE TABLE IF NOT EXISTS expenses (
    id         INTEGER PRIMARY KEY,
    period_id  INTEGER NOT NULL REFERENCES periods(id) ON DELETE RESTRICT,
    amount     INTEGER NOT NULL,
    label      TEXT NOT NULL,
    date       TEXT NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT;

  CREATE INDEX IF NOT EXISTS idx_expenses_period ON expenses(period_id);
`);

export function tx(fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
