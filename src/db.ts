import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { config } from './config.ts';

fs.mkdirSync(config.dataDir, { recursive: true });

export const db = new DatabaseSync(path.join(config.dataDir, 'schedule-lab.db'));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS app_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sorts (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  latest_version INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sort_versions (
  sort_id     INTEGER NOT NULL REFERENCES sorts(id) ON DELETE CASCADE,
  version     INTEGER NOT NULL,
  code        TEXT NOT NULL,
  note        TEXT NOT NULL DEFAULT '',
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (sort_id, version)
);

CREATE TABLE IF NOT EXISTS channel_setup (
  channel_id    TEXT PRIMARY KEY,
  sort_id       INTEGER REFERENCES sorts(id) ON DELETE SET NULL,
  sort_version  INTEGER,
  values_json   TEXT NOT NULL DEFAULT '{}',
  target_hours  REAL NOT NULL DEFAULT 168,
  align_start   INTEGER NOT NULL DEFAULT 1,
  timetable_json TEXT,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS backups (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id    TEXT NOT NULL,
  channel_name  TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  reason        TEXT NOT NULL,
  item_count    INTEGER NOT NULL,
  duration_ms   REAL NOT NULL,
  start_time    INTEGER,
  lineup_json   TEXT NOT NULL,
  schedule_json TEXT
);
CREATE INDEX IF NOT EXISTS backups_channel ON backups(channel_id, created_at DESC);

CREATE TABLE IF NOT EXISTS apply_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id   TEXT NOT NULL,
  channel_name TEXT NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  action       TEXT NOT NULL,
  detail       TEXT NOT NULL DEFAULT '',
  item_count   INTEGER,
  duration_ms  REAL,
  backup_id    INTEGER,
  ok           INTEGER NOT NULL,
  message      TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS apply_log_channel ON apply_log(channel_id, created_at DESC);

CREATE TABLE IF NOT EXISTS global_vars (
  name        TEXT PRIMARY KEY,
  type        TEXT NOT NULL,
  value_json  TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  updated_at  INTEGER NOT NULL
);
`);

export function getSetting<T>(key: string, fallback: T): T {
  const row = db.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined;
  if (!row) return fallback;
  try { return JSON.parse(row.value) as T; } catch { return fallback; }
}

export function setSetting(key: string, value: unknown): void {
  db.prepare('INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
    .run(key, JSON.stringify(value));
}

export function transaction<T>(fn: () => T): T {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
