// Automations: code in an Automation Library (versions kept, like sorts),
// assigned to channels with their own settings values and timetable. Runs go
// through one queue (1-2 at a time) and run in the sandbox; everything they do
// to Tunarr goes through the bridge below, which enforces the rules:
//   - an automation changes only the channel it's assigned to (it can read all);
//   - applies back up first (applyPreview), once per run, never empty, and not
//     shorter than minLengthPercent (a setting, default 50) of the lineup length;
//   - a dry run only reports what it would change.
import { db, transaction } from './db.ts';
import { HttpError } from './sorts.ts';
import { appSetting } from './app-settings.ts';
import { parseSettings, resolveValues } from './shared/sort-settings.js';
import { globalsForSorts, globalsMap } from './globals.ts';
import { getSetup, listChannels, saveSetup } from './channels.ts';
import { getChannelData, lastAiredMap, type ChannelData } from './channel-data.ts';
import { historyForSort } from './watch.ts';
import { getPreview, runPreview } from './preview.ts';
import { applyPreview } from './apply.ts';
import { aiAvailable, ask } from './ai.ts';
import { cleanPool, cleanRule, ruleMatches, sourcesFromItems, type PoolDefinition, type PoolSource } from './pool.ts';
import { runAutomation, SortError, type BridgeHandler } from './sandbox/index.ts';
import { PRESET_AUTOMATIONS } from './automation-presets.ts';

db.exec(`
CREATE TABLE IF NOT EXISTS automations (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL,
  description    TEXT NOT NULL DEFAULT '',
  latest_version INTEGER NOT NULL DEFAULT 0,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS automation_versions (
  automation_id INTEGER NOT NULL REFERENCES automations(id) ON DELETE CASCADE,
  version       INTEGER NOT NULL,
  code          TEXT NOT NULL,
  note          TEXT NOT NULL DEFAULT '',
  created_at    INTEGER NOT NULL,
  PRIMARY KEY (automation_id, version)
);
-- An automation assigned to a channel: its version, values and timetable.
CREATE TABLE IF NOT EXISTS channel_automations (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id         TEXT NOT NULL,
  automation_id      INTEGER NOT NULL,
  automation_version INTEGER NOT NULL,
  values_json        TEXT NOT NULL DEFAULT '{}',
  timetable_json     TEXT NOT NULL,
  enabled            INTEGER NOT NULL DEFAULT 1,
  next_run_at        INTEGER,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS channel_automations_channel ON channel_automations(channel_id);
CREATE TABLE IF NOT EXISTS automation_runs (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  assignment_id      INTEGER,
  channel_id         TEXT NOT NULL,
  channel_name       TEXT NOT NULL DEFAULT '',
  automation_id      INTEGER,
  automation_name    TEXT NOT NULL DEFAULT '',
  automation_version INTEGER,
  trigger            TEXT NOT NULL,
  dry_run            INTEGER NOT NULL DEFAULT 0,
  status             TEXT NOT NULL,
  attempt            INTEGER NOT NULL DEFAULT 1,
  not_before         INTEGER NOT NULL,
  queued_at          INTEGER NOT NULL,
  started_at         INTEGER,
  finished_at        INTEGER,
  message            TEXT NOT NULL DEFAULT '',
  result_json        TEXT,
  logs_json          TEXT,
  changes_json       TEXT
);
CREATE INDEX IF NOT EXISTS automation_runs_status ON automation_runs(status, not_before);
CREATE INDEX IF NOT EXISTS automation_runs_channel ON automation_runs(channel_id, queued_at DESC);
-- Shows or movies an automation suggested for a channel's pool.
CREATE TABLE IF NOT EXISTS pool_suggestions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id      TEXT NOT NULL,
  ref             TEXT NOT NULL,
  source_json     TEXT NOT NULL,
  reason          TEXT NOT NULL DEFAULT '',
  automation_name TEXT NOT NULL DEFAULT '',
  run_id          INTEGER,
  status          TEXT NOT NULL DEFAULT 'open',
  created_at      INTEGER NOT NULL,
  decided_at      INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS pool_suggestions_ref ON pool_suggestions(channel_id, ref);
`);

// ---------- library ----------
interface AutomationRow { id: number; name: string; description: string; latest_version: number; created_at: number; updated_at: number }
interface VersionRow { automation_id: number; version: number; code: string; note: string; created_at: number }

function checkCode(code: unknown): string {
  if (typeof code !== 'string' || !code.trim()) throw new HttpError(400, 'The automation has no code.');
  if (!/function\s+run\s*\(|\brun\s*=/.test(code)) throw new HttpError(400, 'The code must define function run(ctx).');
  const { errors } = parseSettings(code);
  if (errors.length) throw new HttpError(400, `Settings block: ${errors.join('; ')}`);
  return code;
}

function checkName(name: unknown, exceptId?: number): string {
  const n = String(name ?? '').trim();
  if (!n) throw new HttpError(400, 'The automation needs a name.');
  if (n.length > 120) throw new HttpError(400, 'Names are limited to 120 characters.');
  const clash = db.prepare('SELECT id FROM automations WHERE lower(name) = lower(?)').get(n) as { id: number } | undefined;
  if (clash && clash.id !== exceptId) throw new HttpError(409, `An automation named "${n}" already exists.`);
  return n;
}

function uniqueName(base: string): string {
  let name = base;
  for (let i = 2; db.prepare('SELECT 1 FROM automations WHERE lower(name) = lower(?)').get(name); i++) name = `${base} (${i})`;
  return name;
}

export function listAutomations() {
  const rows = db.prepare('SELECT * FROM automations ORDER BY lower(name)').all() as unknown as AutomationRow[];
  const usage = db.prepare('SELECT id, automation_id, automation_version, channel_id, enabled FROM channel_automations').all() as Array<{ id: number; automation_id: number; automation_version: number; channel_id: string; enabled: number }>;
  return rows.map(a => ({
    ...a,
    settings: parseSettings(getAutomationVersion(a.id, a.latest_version).code).settings,
    usedBy: usage.filter(u => u.automation_id === a.id).map(u => ({ assignmentId: u.id, channelId: u.channel_id, version: u.automation_version, enabled: !!u.enabled })),
  }));
}

export function getAutomation(id: number) {
  const a = db.prepare('SELECT * FROM automations WHERE id = ?').get(id) as AutomationRow | undefined;
  if (!a) throw new HttpError(404, `Automation ${id} not found.`);
  const versions = db.prepare('SELECT version, note, created_at FROM automation_versions WHERE automation_id = ? ORDER BY version DESC').all(id);
  const usedBy = db.prepare('SELECT id AS assignmentId, channel_id AS channelId, automation_version AS version, enabled FROM channel_automations WHERE automation_id = ?').all(id);
  return { ...a, versions, usedBy };
}

export function getAutomationVersion(id: number, version: number): VersionRow {
  const v = db.prepare('SELECT * FROM automation_versions WHERE automation_id = ? AND version = ?').get(id, version) as VersionRow | undefined;
  if (!v) throw new HttpError(404, `Automation ${id} has no version ${version}.`);
  return v;
}

export function createAutomation(input: { name: unknown; description?: unknown; code: unknown; note?: unknown }) {
  const code = checkCode(input.code);
  return transaction(() => {
    const name = checkName(input.name);
    const now = Date.now();
    const r = db.prepare('INSERT INTO automations (name, description, latest_version, created_at, updated_at) VALUES (?, ?, 1, ?, ?)')
      .run(name, String(input.description ?? ''), now, now);
    const id = Number(r.lastInsertRowid);
    db.prepare('INSERT INTO automation_versions (automation_id, version, code, note, created_at) VALUES (?, 1, ?, ?, ?)')
      .run(id, code, String(input.note ?? 'First version'), now);
    return getAutomation(id);
  });
}

export function saveAutomationVersion(id: number, input: { code: unknown; note?: unknown; name?: unknown; description?: unknown }) {
  const code = checkCode(input.code);
  return transaction(() => {
    const a = getAutomation(id);
    if (input.name !== undefined || input.description !== undefined) updateAutomation(id, input);
    if (getAutomationVersion(id, a.latest_version).code === code) return getAutomation(id);
    const version = a.latest_version + 1;
    const now = Date.now();
    db.prepare('INSERT INTO automation_versions (automation_id, version, code, note, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, version, code, String(input.note ?? ''), now);
    db.prepare('UPDATE automations SET latest_version = ?, updated_at = ? WHERE id = ?').run(version, now, id);
    return getAutomation(id);
  });
}

export function updateAutomation(id: number, input: { name?: unknown; description?: unknown }) {
  getAutomation(id);
  if (input.name !== undefined) db.prepare('UPDATE automations SET name = ?, updated_at = ? WHERE id = ?').run(checkName(input.name, id), Date.now(), id);
  if (input.description !== undefined) db.prepare('UPDATE automations SET description = ?, updated_at = ? WHERE id = ?').run(String(input.description), Date.now(), id);
  return getAutomation(id);
}

export function duplicateAutomation(id: number) {
  const a = getAutomation(id);
  const latest = getAutomationVersion(id, a.latest_version);
  return createAutomation({ name: uniqueName(`${a.name} copy`), description: a.description, code: latest.code, note: `Copied from ${a.name} v${a.latest_version}` });
}

export function deleteAutomation(id: number) {
  const a = getAutomation(id);
  if (a.usedBy.length) throw new HttpError(409, `"${a.name}" is assigned to ${a.usedBy.length} channel(s). Remove it from them first.`);
  db.prepare('DELETE FROM automations WHERE id = ?').run(id);
}

/** Loads the starter automations. Skips any whose name is already taken. */
export function importPresetAutomations() {
  const added: string[] = [];
  const skipped: string[] = [];
  const updated: string[] = [];
  for (const p of PRESET_AUTOMATIONS) {
    const have = db.prepare('SELECT id, latest_version FROM automations WHERE lower(name) = lower(?)').get(p.name) as { id: number; latest_version: number } | undefined;
    if (have) {
      // A starter nobody has edited gets the newer starter code as a new version.
      const versions = db.prepare('SELECT code, note FROM automation_versions WHERE automation_id = ?').all(have.id) as Array<{ code: string; note: string }>;
      const untouched = versions.every(v => /^(Starter automation|Updated starter automation)$/.test(v.note));
      if (untouched && getAutomationVersion(have.id, have.latest_version).code !== p.code) {
        saveAutomationVersion(have.id, { code: p.code, note: 'Updated starter automation' });
        updated.push(p.name);
      } else skipped.push(p.name);
      continue;
    }
    createAutomation({ ...p, note: 'Starter automation' });
    added.push(p.name);
  }
  return { added, skipped, updated };
}

export function exportAutomation(id: number) {
  const a = getAutomation(id);
  const versions = db.prepare('SELECT version, code, note, created_at FROM automation_versions WHERE automation_id = ? ORDER BY version').all(id);
  return { kind: 'schedule-lab-automation', formatVersion: 1, name: a.name, description: a.description, versions };
}

export function importAutomationFile(data: any) {
  const entries = data?.kind === 'schedule-lab-automation' ? [data] : Array.isArray(data?.automations) ? data.automations : null;
  if (!entries) throw new HttpError(400, 'This is not a Schedule Lab automation file.');
  const added: string[] = [];
  transaction(() => {
    for (const e of entries) {
      const versions = (e.versions || []).filter((v: any) => typeof v.code === 'string');
      if (!versions.length) continue;
      versions.forEach((v: any) => checkCode(v.code));
      const name = uniqueName(String(e.name || 'Imported automation'));
      const now = Date.now();
      const r = db.prepare('INSERT INTO automations (name, description, latest_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(name, String(e.description || ''), versions.length, now, now);
      const id = Number(r.lastInsertRowid);
      versions.forEach((v: any, i: number) => db.prepare('INSERT INTO automation_versions (automation_id, version, code, note, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(id, i + 1, v.code, String(v.note || ''), Number(v.created_at) || now));
      added.push(name);
    }
  });
  return { added };
}

// ---------- timetables ----------
export interface Timetable {
  kind: 'manual' | 'hours' | 'daily' | 'weekly' | 'monthly' | 'every';
  /** weekly: e.g. ['Sun', 'Wed'] */
  days?: string[];
  /** monthly: 1-31 (the last day in shorter months) */
  dayOfMonth?: number;
  /** every: every N days, counted from `anchor` (YYYY-MM-DD) */
  everyDays?: number;
  anchor?: string;
  /** hours: every N hours */
  everyHours?: number;
  /** HH:MM; empty = somewhere in the automation window, spread per assignment */
  at?: string | null;
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export const DEFAULT_TIMETABLE: Timetable = { kind: 'weekly', days: ['Sun'], at: null };

const toMinutes = (hhmm: string) => { const [h, m] = hhmm.split(':').map(Number); return h * 60 + m; };

export function cleanTimetable(t: any): Timetable {
  const kind = t?.kind;
  if (!['manual', 'hours', 'daily', 'weekly', 'monthly', 'every'].includes(kind)) throw new HttpError(400, `Unknown timetable "${kind}".`);
  const out: Timetable = { kind };
  if (kind !== 'manual' && kind !== 'hours') {
    const at = String(t.at ?? '').trim();
    if (at && !/^([01]?\d|2[0-3]):[0-5]\d$/.test(at)) throw new HttpError(400, 'The time must look like 03:30.');
    out.at = at ? at.padStart(5, '0') : null;
  }
  if (kind === 'weekly') {
    const days = (Array.isArray(t.days) ? t.days : []).map((d: unknown) => String(d).slice(0, 3)).map((d: string) => d[0]?.toUpperCase() + d.slice(1).toLowerCase());
    out.days = DAY_NAMES.filter(d => days.includes(d));
    if (!out.days.length) throw new HttpError(400, 'Pick at least one day.');
  }
  if (kind === 'monthly') {
    const d = Math.round(Number(t.dayOfMonth));
    if (!(d >= 1 && d <= 31)) throw new HttpError(400, 'The day of the month must be 1 to 31.');
    out.dayOfMonth = d;
  }
  if (kind === 'every') {
    const n = Math.round(Number(t.everyDays));
    if (!(n >= 1 && n <= 365)) throw new HttpError(400, 'Every N days: N must be 1 to 365.');
    out.everyDays = n;
    const anchor = String(t.anchor || '').trim() || localDate(Date.now());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(anchor)) throw new HttpError(400, 'The start date must look like 2026-01-31.');
    out.anchor = anchor;
  }
  if (kind === 'hours') {
    const n = Number(t.everyHours);
    if (!(n >= 1 && n <= 24 * 7)) throw new HttpError(400, 'Every N hours: N must be 1 to 168.');
    out.everyHours = n;
  }
  return out;
}

function localDate(ms: number) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function hash(s: string) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/**
 * When a timetable next fires after `after` (local server time). Timetables
 * without a set time get a fixed spot inside the window, different per
 * assignment (`key`), so channels don't all rebuild at once.
 */
export function nextRunAt(t: Timetable, after: number, key: string, window = appSetting('automations')): number | null {
  if (t.kind === 'manual') return null;
  if (t.kind === 'hours') return Math.ceil((after + t.everyHours! * 3_600_000) / 60_000) * 60_000;
  let minute: number;
  if (t.at) minute = toMinutes(t.at);
  else {
    const start = toMinutes(window.windowStart);
    const end = toMinutes(window.windowEnd);
    const len = end > start ? end - start : end + 1440 - start;
    minute = start + (len > 0 ? hash(key) % len : 0);
  }
  const anchor = t.anchor ? new Date(`${t.anchor}T00:00:00`) : null;
  for (let d = 0; d <= 400; d++) {
    const day = new Date(after);
    day.setHours(0, 0, 0, 0);
    day.setDate(day.getDate() + d);
    if (t.kind === 'weekly' && !t.days!.includes(DAY_NAMES[day.getDay()])) continue;
    if (t.kind === 'monthly') {
      const last = new Date(day.getFullYear(), day.getMonth() + 1, 0).getDate();
      if (day.getDate() !== Math.min(t.dayOfMonth!, last)) continue;
    }
    if (t.kind === 'every') {
      const diff = Math.round((day.getTime() - anchor!.getTime()) / 86_400_000);
      if (diff < 0 || diff % t.everyDays! !== 0) continue;
    }
    const at = new Date(day);
    at.setMinutes(minute);
    if (at.getTime() > after) return at.getTime();
  }
  return null;
}

// ---------- assignments ----------
interface AssignmentRow {
  id: number; channel_id: string; automation_id: number; automation_version: number; values_json: string;
  timetable_json: string; enabled: number; next_run_at: number | null; created_at: number; updated_at: number;
}

function assignmentRow(id: number): AssignmentRow {
  const row = db.prepare('SELECT * FROM channel_automations WHERE id = ?').get(id) as AssignmentRow | undefined;
  if (!row) throw new HttpError(404, `Automation assignment ${id} not found.`);
  return row;
}

function describeAssignment(row: AssignmentRow) {
  const a = db.prepare('SELECT name, latest_version FROM automations WHERE id = ?').get(row.automation_id) as { name: string; latest_version: number } | undefined;
  const v = db.prepare('SELECT code FROM automation_versions WHERE automation_id = ? AND version = ?').get(row.automation_id, row.automation_version) as { code: string } | undefined;
  const lastRun = db.prepare(`SELECT id, status, trigger, dry_run AS dryRun, queued_at AS queuedAt, finished_at AS finishedAt, message
    FROM automation_runs WHERE assignment_id = ? ORDER BY id DESC LIMIT 1`).get(row.id);
  return {
    id: row.id,
    channelId: row.channel_id,
    automationId: row.automation_id,
    automationName: a?.name ?? '(deleted)',
    version: row.automation_version,
    latestVersion: a?.latest_version ?? null,
    settings: v ? parseSettings(v.code).settings : [],
    values: JSON.parse(row.values_json || '{}'),
    timetable: JSON.parse(row.timetable_json),
    enabled: !!row.enabled,
    nextRunAt: row.enabled ? row.next_run_at : null,
    lastRun: lastRun ?? null,
  };
}

export function listAssignments(channelId?: string) {
  const rows = (channelId
    ? db.prepare('SELECT * FROM channel_automations WHERE channel_id = ? ORDER BY id').all(channelId)
    : db.prepare('SELECT * FROM channel_automations ORDER BY channel_id, id').all()) as unknown as AssignmentRow[];
  return rows.map(describeAssignment);
}

function schedule(row: Pick<AssignmentRow, 'id' | 'enabled' | 'timetable_json'>, after = Date.now()) {
  return row.enabled ? nextRunAt(JSON.parse(row.timetable_json), after, `a${row.id}`) : null;
}

export function createAssignment(channelId: string, input: { automationId?: unknown; values?: unknown; timetable?: unknown; enabled?: unknown }) {
  if (!channelId || channelId === 'sample' || channelId === 'draft') throw new HttpError(400, 'Pick a Tunarr channel.');
  const a = getAutomation(Number(input.automationId));
  const timetable = input.timetable === undefined ? DEFAULT_TIMETABLE : cleanTimetable(input.timetable);
  const values = input.values && typeof input.values === 'object' ? input.values : {};
  const enabled = input.enabled === false ? 0 : 1;
  const now = Date.now();
  const r = db.prepare(`INSERT INTO channel_automations (channel_id, automation_id, automation_version, values_json, timetable_json, enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(channelId, a.id, a.latest_version, JSON.stringify(values), JSON.stringify(timetable), enabled, now, now);
  const id = Number(r.lastInsertRowid);
  db.prepare('UPDATE channel_automations SET next_run_at = ? WHERE id = ?').run(schedule(assignmentRow(id)), id);
  return describeAssignment(assignmentRow(id));
}

export function updateAssignment(id: number, input: { version?: unknown; values?: unknown; timetable?: unknown; enabled?: unknown }) {
  const row = assignmentRow(id);
  if (input.version !== undefined) {
    getAutomationVersion(row.automation_id, Number(input.version));
    row.automation_version = Number(input.version);
  }
  if (input.values !== undefined) {
    if (!input.values || typeof input.values !== 'object') throw new HttpError(400, 'values must be an object.');
    row.values_json = JSON.stringify(input.values);
  }
  const retime = input.timetable !== undefined || input.enabled !== undefined;
  if (input.timetable !== undefined) row.timetable_json = JSON.stringify(cleanTimetable(input.timetable));
  if (input.enabled !== undefined) row.enabled = input.enabled ? 1 : 0;
  if (retime) row.next_run_at = schedule(row);
  db.prepare(`UPDATE channel_automations SET automation_version = ?, values_json = ?, timetable_json = ?, enabled = ?, next_run_at = ?, updated_at = ? WHERE id = ?`)
    .run(row.automation_version, row.values_json, row.timetable_json, row.enabled, row.next_run_at, Date.now(), id);
  return describeAssignment(assignmentRow(id));
}

export function deleteAssignment(id: number) {
  assignmentRow(id);
  db.prepare("UPDATE automation_runs SET status = 'failed', message = 'The automation was removed from the channel.', finished_at = ? WHERE assignment_id = ? AND status = 'queued'").run(Date.now(), id);
  db.prepare('DELETE FROM channel_automations WHERE id = ?').run(id);
}

/** A deleted channel's automations stop (they stay, so a recreated channel gets them back, turned off). */
export function pauseChannelAutomations(channelId: string) {
  db.prepare('UPDATE channel_automations SET enabled = 0, next_run_at = NULL WHERE channel_id = ?').run(channelId);
}

/** A copied channel gets the same automations. */
export function copyChannelAutomations(fromId: string, toId: string) {
  const rows = db.prepare('SELECT * FROM channel_automations WHERE channel_id = ?').all(fromId) as unknown as AssignmentRow[];
  for (const r of rows) {
    const now = Date.now();
    const ins = db.prepare(`INSERT INTO channel_automations (channel_id, automation_id, automation_version, values_json, timetable_json, enabled, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(toId, r.automation_id, r.automation_version, r.values_json, r.timetable_json, r.enabled, now, now);
    const id = Number(ins.lastInsertRowid);
    db.prepare('UPDATE channel_automations SET next_run_at = ? WHERE id = ?').run(schedule(assignmentRow(id)), id);
  }
}

// ---------- runs ----------
interface RunRow {
  id: number; assignment_id: number | null; channel_id: string; channel_name: string; automation_id: number | null; automation_name: string;
  automation_version: number | null; trigger: string; dry_run: number; status: string; attempt: number; not_before: number; queued_at: number;
  started_at: number | null; finished_at: number | null; message: string; result_json: string | null; logs_json: string | null; changes_json: string | null;
}

export interface Change { kind: 'apply' | 'pool.add' | 'pool.suggest' | 'pool.exclude'; detail: string; dryRun?: boolean; backupId?: number }

function describeRun(r: RunRow, full = false) {
  return {
    id: r.id, assignmentId: r.assignment_id, channelId: r.channel_id, channelName: r.channel_name,
    automationId: r.automation_id, automationName: r.automation_name, version: r.automation_version,
    trigger: r.trigger, dryRun: !!r.dry_run, status: r.status, attempt: r.attempt, notBefore: r.not_before,
    queuedAt: r.queued_at, startedAt: r.started_at, finishedAt: r.finished_at, message: r.message,
    changes: r.changes_json ? JSON.parse(r.changes_json) as Change[] : [],
    ...(full ? { logs: r.logs_json ? JSON.parse(r.logs_json) : [], result: r.result_json ? JSON.parse(r.result_json) : null } : {}),
  };
}

export function getRun(id: number) {
  const r = db.prepare('SELECT * FROM automation_runs WHERE id = ?').get(id) as RunRow | undefined;
  if (!r) throw new HttpError(404, `Run ${id} not found.`);
  return describeRun(r, true);
}

export function listRuns(opts: { channelId?: string; assignmentId?: number; limit?: number }) {
  const where: string[] = [];
  const args: Array<string | number> = [];
  if (opts.channelId) { where.push('channel_id = ?'); args.push(opts.channelId); }
  if (opts.assignmentId) { where.push('assignment_id = ?'); args.push(opts.assignmentId); }
  const limit = Math.min(Math.max(Number(opts.limit) || 100, 1), 500);
  const rows = db.prepare(`SELECT * FROM automation_runs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`).all(...args, limit) as unknown as RunRow[];
  return rows.map(r => describeRun(r));
}

function insertRun(a: AssignmentRow, automationName: string, channelName: string, trigger: string, dryRun: boolean, status: 'queued' | 'running') {
  const now = Date.now();
  const r = db.prepare(`INSERT INTO automation_runs (assignment_id, channel_id, channel_name, automation_id, automation_name, automation_version, trigger, dry_run, status, not_before, queued_at, started_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(a.id, a.channel_id, channelName, a.automation_id, automationName, a.automation_version, trigger, dryRun ? 1 : 0, status, now, now, status === 'running' ? now : null);
  return Number(r.lastInsertRowid);
}

const automationName = (id: number) => (db.prepare('SELECT name FROM automations WHERE id = ?').get(id) as { name: string } | undefined)?.name ?? '(deleted)';

/** Run now: queued like a timetable run (dry runs go through the queue too). */
export function runNow(assignmentId: number, opts: { dryRun?: boolean } = {}) {
  const a = assignmentRow(assignmentId);
  const busy = db.prepare("SELECT id FROM automation_runs WHERE assignment_id = ? AND status IN ('queued', 'running') AND dry_run = ?").get(a.id, opts.dryRun ? 1 : 0);
  if (busy) throw new HttpError(409, 'This automation is already queued or running for this channel.');
  const id = insertRun(a, automationName(a.automation_id), '', opts.dryRun ? 'dry run' : 'run now', !!opts.dryRun, 'queued');
  setImmediate(pump);
  return getRun(id);
}

/**
 * Dry run of code from the library editor (saved or not) on a channel. Runs
 * straight away and returns the finished run.
 */
export async function testCode(input: { code?: unknown; channelId?: unknown; values?: unknown; automationId?: unknown }) {
  const code = checkCode(input.code);
  const channelId = String(input.channelId || '');
  if (!channelId || channelId === 'sample' || channelId === 'draft') throw new HttpError(400, 'Pick a Tunarr channel to test on.');
  const automationId = input.automationId ? Number(input.automationId) : null;
  const name = automationId ? `${automationName(automationId)} (editor)` : 'Editor test';
  const now = Date.now();
  const r = db.prepare(`INSERT INTO automation_runs (assignment_id, channel_id, automation_id, automation_name, trigger, dry_run, status, not_before, queued_at, started_at)
    VALUES (NULL, ?, ?, ?, 'test', 1, 'running', ?, ?, ?)`).run(channelId, automationId, name, now, now, now);
  const runId = Number(r.lastInsertRowid);
  await execute(runId, { channelId, code, stored: (input.values && typeof input.values === 'object' ? input.values : {}) as Record<string, unknown>, name, dryRun: true });
  return getRun(runId);
}

// ---------- executing a run ----------
const MAX_BUILDS = 30;
const MAX_AI_CALLS = 50;
const MAX_POOL_CHANGES = 200;
const hoursText = (ms: number) => `${(ms / 3_600_000).toFixed(ms < 36_000_000 ? 1 : 0)} h`;

interface RunState {
  runId: number;
  channelId: string;
  name: string;
  dryRun: boolean;
  params: Record<string, unknown>;
  candidates: Set<string>;
  applied: boolean;
  skipped: string | null;
  changes: Change[];
  builds: number;
  aiCalls: number;
  poolChanges: number;
  convertedLineup?: boolean;
}

function showTitleOf(data: ChannelData) {
  const byId = new Map([...data.pool, ...data.lineupItems].map(p => [p.id, p]));
  return (it: any): string => {
    if ('id' in it) return byId.get(it.id)?.showTitle || '?';
    if ('ci' in it) { const c = data.current[it.ci]; return (c?.id && byId.get(c.id)?.showTitle) || `(${c?.type || 'item'})`; }
    return '(flex)';
  };
}

function checkSource(s: any): Omit<PoolSource, 'id'> & { ref: string } {
  const kinds = ['show', 'season', 'movie', 'episode', 'custom_show', 'smart_collection'];
  if (!kinds.includes(s?.kind)) throw new Error(`Pool sources an automation adds must be one of: ${kinds.join(', ')}.`);
  if (!s.ref || typeof s.ref !== 'string') throw new Error('The source needs ref: the Tunarr id of the show, season, movie, episode or custom show.');
  const weight = s.weight === undefined ? 1 : Number(s.weight);
  return { kind: s.kind, ref: s.ref, label: String(s.label || s.ref).slice(0, 200), weight };
}

/** Ids of everything on the channel now: its shows, custom shows, movies and episodes (from pool sources or the lineup). */
async function onChannel(channelId: string): Promise<Set<string>> {
  const data = await getChannelData(channelId);
  const ids = new Set<string>();
  for (const p of [...data.pool, ...data.lineupItems]) {
    ids.add(p.id);
    if (p.showId) ids.add(p.showId);
    if (p.seasonId) ids.add(p.seasonId);
    if (p.customShowId) ids.add(p.customShowId);
  }
  for (const s of getSetup(channelId).pool.sources) if (s.ref) ids.add(s.ref);
  return ids;
}

/**
 * The pool to add a source to. A channel without pool sources plays what's on
 * its lineup, so its shows become sources first; otherwise the first added
 * source would replace them all.
 */
async function poolForAdding(channelId: string): Promise<{ pool: PoolDefinition; converted: number }> {
  const pool = getSetup(channelId).pool;
  if (pool.sources.length) return { pool, converted: 0 };
  const sources = sourcesFromItems((await getChannelData(channelId)).pool);
  return { pool: { ...pool, sources }, converted: sources.length };
}

function makeBridge(st: RunState): BridgeHandler {
  const { channelId } = st;
  const json = (v: unknown) => JSON.stringify(v ?? null);
  const change = (c: Change) => { st.changes.push(st.dryRun ? { ...c, dryRun: true } : c); };
  const poolChange = () => { if (++st.poolChanges > MAX_POOL_CHANGES) throw new Error(`An automation run can change the pool at most ${MAX_POOL_CHANGES} times.`); };

  return async (kind, p) => {
    switch (kind) {
      case 'lineup.current': {
        const data = await getChannelData(channelId, true);
        const setup = getSetup(channelId);
        const remainingMs = data.current.slice(data.playingIndex).reduce((a, b) => a + b.durationMs, 0) - data.playingOffsetMs;
        const lastApply = db.prepare("SELECT created_at FROM apply_log WHERE channel_id = ? AND ok = 1 AND action = 'apply' ORDER BY created_at DESC LIMIT 1").get(channelId) as { created_at: number } | undefined;
        const byId = new Map([...data.pool, ...data.lineupItems].map(x => [x.id, x]));
        return json({
          itemCount: data.current.length,
          durationMs: data.totalDurationMs,
          startTime: data.startTime,
          targetHours: setup.targetHours,
          playingIndex: data.playingIndex,
          remainingMs,
          daysLeft: remainingMs / 86_400_000,
          lastAppliedAt: lastApply?.created_at ?? null,
          poolEpisodes: data.pool.length,
          items: p.items ? data.current.map(c => {
            const e = c.id ? byId.get(c.id) : undefined;
            return { id: c.id ?? null, type: c.type, durationMs: c.durationMs, showTitle: e ? e.showTitle : `(${c.type})`, title: e?.title ?? null, episodeLabel: e?.episodeLabel ?? null };
          }) : undefined,
        });
      }
      case 'build': {
        if (st.skipped) throw new Error('This run was skipped.');
        if (++st.builds > MAX_BUILDS) throw new Error(`An automation run can build at most ${MAX_BUILDS} lineups.`);
        const setup = getSetup(channelId);
        const sortId = p.sort ? Number(p.sort) : setup.sortId;
        if (!sortId) throw new Error('This channel has no sort. Pick one on the Channels screen, or pass { sort: id } to ctx.build().');
        const same = sortId === setup.sortId;
        const version = p.version ? Number(p.version) : same && setup.sortVersion ? setup.sortVersion : undefined;
        const stored: Record<string, unknown> = { ...(same ? setup.values : {}), ...(p.params && typeof p.params === 'object' ? p.params : {}) };
        if (p.seed !== undefined && p.seed !== null) stored.seed = Number(p.seed);
        const r = await runPreview({
          channelId, sortId, sortVersion: version, params: stored,
          targetHours: p.hours ? Number(p.hours) : setup.targetHours,
          scheduleStartMs: Math.floor(Date.now() / 60_000) * 60_000,
          scoreCode: appSetting('scoreCode'),
        });
        const preview = getPreview(r.previewId);
        preview.label = `${r.label} · ${st.name}`;
        st.candidates.add(r.previewId);
        const data = await getChannelData(channelId);
        const title = showTitleOf(data);
        const counts = new Map<string, number>();
        const sequence = r.items.map(title);
        for (const s of sequence) if (s !== '(flex)') counts.set(s, (counts.get(s) || 0) + 1);
        return json({
          id: r.previewId, label: preview.label, sortId: r.sortId, sortVersion: r.sortVersion,
          items: r.items.length, durationMs: r.durationMs, hours: r.durationMs / 3_600_000,
          score: r.score, metrics: r.metrics,
          shows: [...counts].map(([show, count]) => ({ show, count })).sort((a, b) => b.count - a.count),
          sequence: sequence.slice(0, 500), logs: r.logs.slice(0, 100), warnings: r.warnings,
        });
      }
      case 'apply': {
        if (st.skipped) throw new Error('This run was skipped, so it can\'t apply.');
        if (st.applied) throw new Error('An automation can apply only once per run.');
        const id = String(p.candidateId || '');
        if (!st.candidates.has(id)) throw new Error('apply() needs a lineup built by ctx.build() in this run.');
        const preview = getPreview(id);
        if (preview.channelId !== channelId) throw new Error('An automation can only change its own channel.');
        if (!preview.lineup.length) throw new Error('The lineup is empty; nothing was applied.');
        const setup = getSetup(channelId);
        const pct = st.params.minLengthPercent === undefined ? 50 : Number(st.params.minLengthPercent) || 0;
        const data = await getChannelData(channelId);
        const targetMs = setup.targetHours * 3_600_000;
        const refMs = data.totalDurationMs > 0 ? Math.min(data.totalDurationMs, targetMs) : targetMs;
        if (pct > 0 && preview.durationMs < refMs * pct / 100) {
          throw new Error(`The new lineup is ${hoursText(preview.durationMs)}, under ${pct}% of ${hoursText(refMs)}, so it wasn't applied (the automation's minLengthPercent setting).`);
        }
        const align = p.alignStart === undefined ? setup.alignStart : !!p.alignStart;
        const detail = `${preview.label}: ${preview.lineup.length} items, ${hoursText(preview.durationMs)}`;
        st.applied = true;
        if (st.dryRun) {
          change({ kind: 'apply', detail: `Would apply ${detail}` });
          return json({ ok: true, dryRun: true });
        }
        try {
          const r = await applyPreview(channelId, id, align);
          change({ kind: 'apply', detail: `Applied ${detail}`, backupId: r.backupId });
          return json({ ok: true, backupId: r.backupId, warnings: r.warnings });
        } catch (err) {
          st.applied = false;
          throw err;
        }
      }
      case 'skip':
        st.skipped = String(p.reason || 'Skipped');
        return '';
      case 'ai': {
        if (!aiAvailable('automation')) throw new Error('AI isn\'t set up or isn\'t allowed for automations (Settings → AI). Check ctx.ai.available first.');
        if (++st.aiCalls > MAX_AI_CALLS) throw new Error(`An automation run can ask the AI at most ${MAX_AI_CALLS} times.`);
        const r = await ask({ prompt: p.prompt, system: p.system, provider: p.provider, model: p.model, maxTokens: p.maxTokens, feature: 'automation', channelId });
        return r.text;
      }
      case 'library.search': {
        let rule;
        try { rule = cleanRule(p.rule); } catch (err: any) { throw new Error(err.message); }
        return json(await ruleMatches(rule));
      }
      case 'pool.get': {
        const pool = getSetup(channelId).pool;
        const suggestions = db.prepare('SELECT ref, status FROM pool_suggestions WHERE channel_id = ?').all(channelId);
        // onChannel: ids of the shows, seasons, custom shows, movies and episodes the channel has now.
        return json({ ...pool, suggestions, onChannel: [...await onChannel(channelId)] });
      }
      case 'pool.add': {
        const src = checkSource(p.source);
        if ((await onChannel(channelId)).has(src.ref)) return json({ added: false, reason: 'already on the channel' });
        poolChange();
        const { pool, converted } = await poolForAdding(channelId);
        if (converted && !st.convertedLineup) {
          st.convertedLineup = true;
          change({ kind: 'pool.add', detail: `${st.dryRun ? 'Would turn' : 'Turned'} the ${converted} shows on the lineup into pool sources first, so they stay` });
        }
        change({ kind: 'pool.add', detail: `${st.dryRun ? 'Would add' : 'Added'} ${src.label}` });
        if (st.dryRun) return json({ added: true, dryRun: true });
        saveSetup(channelId, { pool: cleanPool({ ...pool, sources: [...pool.sources, src] }) });
        db.prepare("UPDATE pool_suggestions SET status = 'approved', decided_at = ? WHERE channel_id = ? AND ref = ? AND status = 'open'").run(Date.now(), channelId, src.ref);
        return json({ added: true });
      }
      case 'pool.suggest': {
        const src = checkSource(p.source);
        if ((await onChannel(channelId)).has(src.ref)) return json({ suggested: false, reason: 'already on the channel' });
        const had = db.prepare('SELECT status FROM pool_suggestions WHERE channel_id = ? AND ref = ?').get(channelId, src.ref) as { status: string } | undefined;
        if (had) return json({ suggested: false, reason: `already suggested (${had.status})` });
        poolChange();
        change({ kind: 'pool.suggest', detail: `${st.dryRun ? 'Would suggest' : 'Suggested'} ${src.label}${p.reason ? ` (${String(p.reason).slice(0, 200)})` : ''}` });
        if (st.dryRun) return json({ suggested: true, dryRun: true });
        db.prepare(`INSERT INTO pool_suggestions (channel_id, ref, source_json, reason, automation_name, run_id, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`)
          .run(channelId, src.ref, JSON.stringify(src), String(p.reason || '').slice(0, 1000), st.name, st.runId, Date.now());
        return json({ suggested: true });
      }
      case 'pool.exclude': {
        const it = p.item || {};
        if (!['show', 'season', 'item'].includes(it.kind) || !it.id) throw new Error('exclude() needs { kind: "show" | "season" | "item", id, label }.');
        const pool = getSetup(channelId).pool;
        if (pool.exclusions.some(e => e.kind === it.kind && e.id === String(it.id))) return json({ excluded: false, reason: 'already excluded' });
        poolChange();
        const label = String(it.label || it.id).slice(0, 200);
        change({ kind: 'pool.exclude', detail: `${st.dryRun ? 'Would exclude' : 'Excluded'} ${label}` });
        if (st.dryRun) return json({ excluded: true, dryRun: true });
        saveSetup(channelId, { pool: cleanPool({ ...pool, exclusions: [...pool.exclusions, { kind: it.kind, id: String(it.id), label }] }) });
        return json({ excluded: true });
      }
      case 'channels.list':
        return json((await listChannels()).map(c => ({
          id: c.id, number: c.number, name: c.name, groupTitle: c.groupTitle ?? null, itemCount: c.programCount ?? null, durationMs: c.durationMs,
          sortName: c.sortName, poolSources: c.setup.pool.sources.map(s => s.label),
        })));
      case 'channels.get': {
        const data = await getChannelData(String(p.id || ''));
        const shows = new Map<string, number>();
        for (const e of data.pool) shows.set(e.showTitle, (shows.get(e.showTitle) || 0) + 1);
        return json({
          id: data.channelId, name: data.name, number: data.number, itemCount: data.current.length, durationMs: data.totalDurationMs,
          poolEpisodes: data.pool.length, shows: [...shows].map(([show, episodes]) => ({ show, episodes })),
          poolSources: getSetup(data.channelId).pool.sources.map(s => ({ kind: s.kind, ref: s.ref ?? null, label: s.label, weight: s.weight })),
        });
      }
      default:
        throw new Error(`Unknown helper "${kind}".`);
    }
  };
}

const unreachable = (msg: string) => /Can't reach Tunarr/.test(msg);

/** Runs one automation and records the outcome on its run row. */
async function execute(runId: number, spec: { channelId: string; code: string; stored: Record<string, unknown>; name: string; dryRun: boolean }) {
  const st: RunState = {
    runId, channelId: spec.channelId, name: spec.name, dryRun: spec.dryRun, params: {}, candidates: new Set(),
    applied: false, skipped: null, changes: [], builds: 0, aiCalls: 0, poolChanges: 0,
  };
  let status = 'failed', message = '', result: unknown = null, logs: string[] = [];
  let retry = false;
  try {
    const { settings } = parseSettings(spec.code);
    st.params = resolveValues(settings, spec.stored, globalsMap());
    const data = await getChannelData(spec.channelId, true);
    db.prepare('UPDATE automation_runs SET channel_name = ? WHERE id = ?').run(data.name, runId);
    const ids = [...data.pool, ...data.lineupItems].map(p => p.id);
    const out = await runAutomation(spec.code, {
      channel: { id: data.channelId, name: data.name, number: data.number },
      params: st.params,
      globals: globalsForSorts(),
      dryRun: spec.dryRun,
      aiAvailable: aiAvailable('automation'),
      history: { ...historyForSort(spec.channelId, ids), lastAired: lastAiredMap(data) },
    }, { timeLimitMs: appSetting('automations').timeLimitSec * 1000, bridge: makeBridge(st) });
    result = out.result;
    logs = out.logs;
    if (st.skipped) { status = 'skipped'; message = st.skipped; }
    else if (st.applied && !spec.dryRun) { status = 'applied'; message = st.changes.find(c => c.kind === 'apply')?.detail || 'Applied'; }
    else {
      status = 'done';
      message = st.changes.length ? st.changes.map(c => c.detail).slice(0, 3).join('; ') + (st.changes.length > 3 ? ` (+${st.changes.length - 3} more)` : '') : 'Finished without changes.';
    }
  } catch (err: any) {
    message = err instanceof SortError || err instanceof Error ? err.message : String(err);
    if (err instanceof SortError) logs = err.logs;
    // Tunarr down: try again later, as long as nothing was changed yet.
    retry = unreachable(message) && !st.changes.some(c => !c.dryRun);
  }
  if (st.aiCalls) logs = [...logs, `AI: ${st.aiCalls} call${st.aiCalls === 1 ? '' : 's'} (tokens and cost under Settings → AI usage).`];
  const row = db.prepare('SELECT attempt, trigger FROM automation_runs WHERE id = ?').get(runId) as { attempt: number; trigger: string };
  const s = appSetting('automations');
  if (retry && row.trigger !== 'test' && row.attempt <= s.retries) {
    db.prepare(`UPDATE automation_runs SET status = 'queued', attempt = attempt + 1, not_before = ?, started_at = NULL, message = ? WHERE id = ?`)
      .run(Date.now() + s.retryDelayMin * 60_000, `Try ${row.attempt} failed, retrying in ${s.retryDelayMin} min: ${message}`, runId);
    return;
  }
  db.prepare(`UPDATE automation_runs SET status = ?, finished_at = ?, message = ?, result_json = ?, logs_json = ?, changes_json = ? WHERE id = ?`)
    .run(status, Date.now(), message.slice(0, 4000), JSON.stringify(result ?? null), JSON.stringify(logs), JSON.stringify(st.changes), runId);
}

async function executeQueued(run: RunRow) {
  const a = run.assignment_id ? db.prepare('SELECT * FROM channel_automations WHERE id = ?').get(run.assignment_id) as AssignmentRow | undefined : undefined;
  if (!a) {
    db.prepare("UPDATE automation_runs SET status = 'failed', finished_at = ?, message = 'The automation was removed from the channel.' WHERE id = ?").run(Date.now(), run.id);
    return;
  }
  let code: string;
  try { code = getAutomationVersion(a.automation_id, a.automation_version).code; } catch (err: any) {
    db.prepare("UPDATE automation_runs SET status = 'failed', finished_at = ?, message = ? WHERE id = ?").run(Date.now(), err.message, run.id);
    return;
  }
  db.prepare('UPDATE automation_runs SET automation_version = ? WHERE id = ?').run(a.automation_version, run.id);
  await execute(run.id, { channelId: a.channel_id, code, stored: JSON.parse(a.values_json || '{}'), name: automationName(a.automation_id), dryRun: !!run.dry_run });
}

// ---------- queue and timetable ----------
const active = new Map<number, string>();

function pump() {
  const limit = appSetting('automations').concurrency;
  while (active.size < limit) {
    const busy = [...active.values()];
    const run = db.prepare(`SELECT * FROM automation_runs WHERE status = 'queued' AND not_before <= ?
      ${busy.length ? `AND channel_id NOT IN (${busy.map(() => '?').join(',')})` : ''} ORDER BY not_before, id LIMIT 1`).get(Date.now(), ...busy) as RunRow | undefined;
    if (!run) return;
    db.prepare("UPDATE automation_runs SET status = 'running', started_at = ? WHERE id = ?").run(Date.now(), run.id);
    active.set(run.id, run.channel_id);
    executeQueued(run)
      .catch(err => {
        console.error('[automations] run', run.id, err);
        db.prepare("UPDATE automation_runs SET status = 'failed', finished_at = ?, message = ? WHERE id = ?").run(Date.now(), String(err?.message || err), run.id);
      })
      .finally(() => { active.delete(run.id); setImmediate(pump); });
  }
}

/** Queues assignments whose time has come, and works the queue. */
export function tick(now = Date.now()) {
  const s = appSetting('automations');
  const due = db.prepare('SELECT * FROM channel_automations WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ?').all(now) as unknown as AssignmentRow[];
  for (const a of due) {
    const pending = db.prepare("SELECT 1 FROM automation_runs WHERE assignment_id = ? AND dry_run = 0 AND status IN ('queued', 'running')").get(a.id);
    // Turned off in Settings: timetables move on without running.
    if (s.enabled && !pending) insertRun(a, automationName(a.automation_id), '', 'timetable', false, 'queued');
    db.prepare('UPDATE channel_automations SET next_run_at = ? WHERE id = ?').run(schedule(a, now), a.id);
  }
  db.prepare("DELETE FROM automation_runs WHERE status NOT IN ('queued', 'running') AND queued_at < ?").run(now - s.keepRunsDays * 86_400_000);
  pump();
}

/** Recomputes every enabled assignment's next run (after the window setting changes). */
export function rescheduleAll() {
  const rows = db.prepare('SELECT * FROM channel_automations').all() as unknown as AssignmentRow[];
  for (const a of rows) db.prepare('UPDATE channel_automations SET next_run_at = ? WHERE id = ?').run(schedule(a), a.id);
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startAutomations() {
  // Runs cut short by a restart are marked failed (queued ones still run).
  db.prepare("UPDATE automation_runs SET status = 'failed', finished_at = ?, message = 'The server restarted during this run.' WHERE status = 'running'").run(Date.now());
  db.prepare('SELECT id FROM channel_automations WHERE enabled = 1 AND next_run_at IS NULL').all()
    .forEach((r: any) => db.prepare('UPDATE channel_automations SET next_run_at = ? WHERE id = ?').run(schedule(assignmentRow(r.id)), r.id));
  tick();
  timer = setInterval(() => { try { tick(); } catch (err) { console.error('[automations] tick', err); } }, 60_000);
}

export function stopAutomations() {
  if (timer) clearInterval(timer);
  timer = null;
}

export function automationStatus() {
  const s = appSetting('automations');
  const queued = db.prepare("SELECT * FROM automation_runs WHERE status IN ('queued', 'running') ORDER BY status DESC, not_before, id").all() as unknown as RunRow[];
  const upcoming = db.prepare('SELECT * FROM channel_automations WHERE enabled = 1 AND next_run_at IS NOT NULL ORDER BY next_run_at LIMIT 30').all() as unknown as AssignmentRow[];
  return {
    settings: s,
    running: active.size,
    queue: queued.map(r => describeRun(r)),
    upcoming: upcoming.map(describeAssignment),
  };
}

// ---------- pool suggestions ----------
export function listSuggestions(channelId: string, status = 'open') {
  return (db.prepare('SELECT * FROM pool_suggestions WHERE channel_id = ? AND status = ? ORDER BY created_at DESC').all(channelId, status) as Array<any>)
    .map(r => ({ id: r.id, ref: r.ref, source: JSON.parse(r.source_json), reason: r.reason, automationName: r.automation_name, runId: r.run_id, createdAt: r.created_at, status: r.status }));
}

export async function decideSuggestion(id: number, approve: boolean) {
  const r = db.prepare('SELECT * FROM pool_suggestions WHERE id = ?').get(id) as any;
  if (!r) throw new HttpError(404, 'That suggestion no longer exists.');
  let converted = 0;
  if (approve && !getSetup(r.channel_id).pool.sources.some(s => s.ref === r.ref)) {
    const got = await poolForAdding(r.channel_id);
    converted = got.converted;
    saveSetup(r.channel_id, { pool: cleanPool({ ...got.pool, sources: [...got.pool.sources, JSON.parse(r.source_json)] }) });
  }
  db.prepare('UPDATE pool_suggestions SET status = ?, decided_at = ? WHERE id = ?').run(approve ? 'approved' : 'dismissed', Date.now(), id);
  return { ok: true, converted, pool: getSetup(r.channel_id).pool };
}

// ---------- turning a library rule into picked shows + an automation ----------
/**
 * Library rules belong to automations: replaces a rule source with the shows
 * and movies it matches today, and assigns "Add new matching shows" so new
 * ones are suggested later.
 */
export async function convertRule(channelId: string, sourceId: string) {
  const setup = getSetup(channelId);
  const src = setup.pool.sources.find(s => s.id === sourceId);
  if (!src || src.kind !== 'rule' || !src.rule) throw new HttpError(404, 'That library rule isn\'t in this channel\'s pool.');
  const rule = src.rule;
  const matches = await ruleMatches(rule);
  const have = new Set(setup.pool.sources.map(s => s.ref).filter(Boolean));
  const added = matches.filter(m => !have.has(m.id)).map(m => ({
    kind: m.type === 'movie' ? 'movie' as const : 'show' as const, ref: m.id, label: m.title + (m.year ? ` (${m.year})` : ''), weight: src.weight,
  }));
  const sources: unknown[] = setup.pool.sources.flatMap((s): unknown[] => (s.id === sourceId ? added : [s]));
  let automation = db.prepare('SELECT id FROM automations WHERE lower(name) = lower(?)').get('Add new matching shows') as { id: number } | undefined;
  if (!automation) {
    const preset = PRESET_AUTOMATIONS.find(p => p.name === 'Add new matching shows')!;
    automation = { id: createAutomation({ ...preset, note: 'Starter automation' }).id };
  }
  const notCarried = (['text', 'ratings', 'tags', 'libraries', 'addedWithinDays'] as const).filter(k => (Array.isArray(rule[k]) ? (rule[k] as unknown[]).length : rule[k]));
  return transaction(() => {
    saveSetup(channelId, { pool: cleanPool({ ...setup.pool, sources }) });
    const assignment = rule.networks?.length || rule.genres?.length
      ? createAssignment(channelId, {
          automationId: automation!.id,
          values: { networks: (rule.networks || []).join(', '), genres: (rule.genres || []).join(', '), yearFrom: rule.yearFrom || 0, yearTo: rule.yearTo || 0, mode: 'suggest' },
          timetable: DEFAULT_TIMETABLE,
        })
      : null;
    return {
      added: added.length,
      assignment,
      note: [
        assignment ? null : 'The rule had no networks or genres, so no automation was added.',
        notCarried.length ? `These rule conditions aren't used by "Add new matching shows": ${notCarried.join(', ')}.` : null,
      ].filter(Boolean).join(' '),
      pool: getSetup(channelId).pool,
    };
  });
}
