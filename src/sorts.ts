// Sort Library: sorts with every saved version kept. Channels point at a
// (sort, version) pair and stay there until moved up.
import { db, transaction } from './db.ts';
import { parseSettings } from './shared/sort-settings.js';
import { PRESET_SORTS } from './presets.ts';

export class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface SortRow {
  id: number;
  name: string;
  description: string;
  latest_version: number;
  created_at: number;
  updated_at: number;
}

export interface SortVersion {
  sort_id: number;
  version: number;
  code: string;
  note: string;
  created_at: number;
}

function checkCode(code: unknown): string {
  if (typeof code !== 'string' || !code.trim()) throw new HttpError(400, 'The sort has no code.');
  if (!/function\s+run\s*\(|\brun\s*=/.test(code)) throw new HttpError(400, 'The code must define function run(ctx).');
  const { errors } = parseSettings(code);
  if (errors.length) throw new HttpError(400, `Settings block: ${errors.join('; ')}`);
  return code;
}

function checkName(name: unknown, exceptId?: number): string {
  const n = String(name ?? '').trim();
  if (!n) throw new HttpError(400, 'The sort needs a name.');
  if (n.length > 120) throw new HttpError(400, 'Names are limited to 120 characters.');
  const clash = db.prepare('SELECT id FROM sorts WHERE lower(name) = lower(?)').get(n) as { id: number } | undefined;
  if (clash && clash.id !== exceptId) throw new HttpError(409, `A sort named "${n}" already exists.`);
  return n;
}

function uniqueName(base: string): string {
  let name = base;
  for (let i = 2; db.prepare('SELECT 1 FROM sorts WHERE lower(name) = lower(?)').get(name); i++) name = `${base} (${i})`;
  return name;
}

export function listSorts() {
  const sorts = db.prepare('SELECT * FROM sorts ORDER BY lower(name)').all() as unknown as SortRow[];
  const usage = db.prepare('SELECT sort_id, sort_version, channel_id FROM channel_setup WHERE sort_id IS NOT NULL').all() as Array<{ sort_id: number; sort_version: number; channel_id: string }>;
  return sorts.map(s => {
    const latest = getVersion(s.id, s.latest_version);
    return {
      ...s,
      settings: parseSettings(latest.code).settings,
      usedBy: usage.filter(u => u.sort_id === s.id).map(u => ({ channelId: u.channel_id, version: u.sort_version })),
    };
  });
}

export function getSort(id: number) {
  const s = db.prepare('SELECT * FROM sorts WHERE id = ?').get(id) as SortRow | undefined;
  if (!s) throw new HttpError(404, `Sort ${id} not found.`);
  const versions = db.prepare('SELECT version, note, created_at FROM sort_versions WHERE sort_id = ? ORDER BY version DESC').all(id);
  const usedBy = db.prepare('SELECT channel_id AS channelId, sort_version AS version FROM channel_setup WHERE sort_id = ?').all(id);
  return { ...s, versions, usedBy };
}

export function getVersion(sortId: number, version: number): SortVersion {
  const v = db.prepare('SELECT * FROM sort_versions WHERE sort_id = ? AND version = ?').get(sortId, version) as SortVersion | undefined;
  if (!v) throw new HttpError(404, `Sort ${sortId} has no version ${version}.`);
  return v;
}

export function createSort(input: { name: unknown; description?: unknown; code: unknown; note?: unknown }) {
  const code = checkCode(input.code);
  return transaction(() => {
    const name = checkName(input.name);
    const now = Date.now();
    const r = db.prepare('INSERT INTO sorts (name, description, latest_version, created_at, updated_at) VALUES (?, ?, 1, ?, ?)')
      .run(name, String(input.description ?? ''), now, now);
    const id = Number(r.lastInsertRowid);
    db.prepare('INSERT INTO sort_versions (sort_id, version, code, note, created_at) VALUES (?, 1, ?, ?, ?)')
      .run(id, code, String(input.note ?? 'First version'), now);
    return getSort(id);
  });
}

/** Saves code as a new version. Channels on older versions don't change. */
export function saveVersion(sortId: number, input: { code: unknown; note?: unknown; name?: unknown; description?: unknown }) {
  const code = checkCode(input.code);
  return transaction(() => {
    const s = getSort(sortId);
    const latest = getVersion(sortId, s.latest_version);
    const now = Date.now();
    if (input.name !== undefined || input.description !== undefined) updateSort(sortId, input);
    if (latest.code === code) return getSort(sortId); // nothing changed in the code
    const version = s.latest_version + 1;
    db.prepare('INSERT INTO sort_versions (sort_id, version, code, note, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(sortId, version, code, String(input.note ?? ''), now);
    db.prepare('UPDATE sorts SET latest_version = ?, updated_at = ? WHERE id = ?').run(version, now, sortId);
    return getSort(sortId);
  });
}

export function updateSort(sortId: number, input: { name?: unknown; description?: unknown }) {
  getSort(sortId);
  if (input.name !== undefined) {
    db.prepare('UPDATE sorts SET name = ?, updated_at = ? WHERE id = ?').run(checkName(input.name, sortId), Date.now(), sortId);
  }
  if (input.description !== undefined) {
    db.prepare('UPDATE sorts SET description = ?, updated_at = ? WHERE id = ?').run(String(input.description), Date.now(), sortId);
  }
  return getSort(sortId);
}

export function duplicateSort(sortId: number) {
  const s = getSort(sortId);
  const latest = getVersion(sortId, s.latest_version);
  return createSort({ name: uniqueName(`${s.name} copy`), description: s.description, code: latest.code, note: `Copied from ${s.name} v${s.latest_version}` });
}

export function deleteSort(sortId: number) {
  const s = getSort(sortId);
  if (s.usedBy.length) {
    throw new HttpError(409, `"${s.name}" is assigned to ${s.usedBy.length} channel(s). Pick another sort for them first.`);
  }
  db.prepare('DELETE FROM sorts WHERE id = ?').run(sortId);
}

/** Loads the 1.8 sorts as ordinary entries. Skips any whose name is already taken. */
export function importPresets() {
  const added: string[] = [];
  const skipped: string[] = [];
  for (const p of PRESET_SORTS) {
    if (db.prepare('SELECT 1 FROM sorts WHERE lower(name) = lower(?)').get(p.name)) { skipped.push(p.name); continue; }
    createSort({ ...p, note: 'Imported from Schedule Lab 1.8' });
    added.push(p.name);
  }
  return { added, skipped };
}

// ---------- export / import of sorts as JSON files ----------
export function exportSort(sortId: number) {
  const s = getSort(sortId);
  const versions = db.prepare('SELECT version, code, note, created_at FROM sort_versions WHERE sort_id = ? ORDER BY version').all(sortId);
  return { kind: 'schedule-lab-sort', formatVersion: 1, name: s.name, description: s.description, versions };
}

export function importSortFile(data: any) {
  const entries = data?.kind === 'schedule-lab-sort' ? [data]
    : Array.isArray(data?.sorts) ? data.sorts
    : null;
  if (!entries) throw new HttpError(400, 'This is not a Schedule Lab sort file.');
  const added: string[] = [];
  transaction(() => {
    for (const e of entries) {
      const versions = (e.versions || []).filter((v: any) => typeof v.code === 'string');
      if (!versions.length) continue;
      const name = uniqueName(String(e.name || 'Imported sort'));
      const now = Date.now();
      versions.forEach((v: any) => checkCode(v.code));
      const r = db.prepare('INSERT INTO sorts (name, description, latest_version, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run(name, String(e.description || ''), versions.length, now, now);
      const id = Number(r.lastInsertRowid);
      versions.forEach((v: any, i: number) => {
        db.prepare('INSERT INTO sort_versions (sort_id, version, code, note, created_at) VALUES (?, ?, ?, ?, ?)')
          .run(id, i + 1, v.code, String(v.note || ''), Number(v.created_at) || now);
      });
      added.push(name);
    }
  });
  return { added };
}
