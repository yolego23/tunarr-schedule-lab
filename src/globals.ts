// Global variables: named values every sort can read as ctx.globals.<name>,
// and that a channel's sort setting can be linked to.
import { db, transaction } from './db.ts';
import { HttpError } from './sorts.ts';
import { GLOBAL_NAME_RE, GLOBAL_TYPES, coerce, isLink } from './shared/sort-settings.js';

export interface GlobalVar {
  name: string;
  type: string;
  value: unknown;
  description: string;
  updatedAt: number;
}

interface Row { name: string; type: string; value_json: string; description: string; updated_at: number }

const toVar = (r: Row): GlobalVar => ({ name: r.name, type: r.type, value: JSON.parse(r.value_json), description: r.description, updatedAt: r.updated_at });

export function listGlobals(): Array<GlobalVar & { usedBy: Array<{ channelId: string; key: string }> }> {
  const rows = db.prepare('SELECT * FROM global_vars ORDER BY lower(name)').all() as unknown as Row[];
  const links = globalLinks();
  return rows.map(r => ({ ...toVar(r), usedBy: links.filter(l => l.name === r.name).map(({ channelId, key }) => ({ channelId, key })) }));
}

/** name -> { type, value }, for resolving settings and building ctx.globals. */
export function globalsMap(): Record<string, { type: string; value: unknown }> {
  const rows = db.prepare('SELECT * FROM global_vars').all() as unknown as Row[];
  return Object.fromEntries(rows.map(r => [r.name, { type: r.type, value: JSON.parse(r.value_json) }]));
}

/** What sorts see as ctx.globals: every variable, converted to its type. */
export function globalsForSorts(): Record<string, unknown> {
  return Object.fromEntries(Object.entries(globalsMap()).map(([name, g]) => [name, coerce({ type: g.type }, g.value)]));
}

/** Every channel setting linked to a global. */
function globalLinks() {
  const rows = db.prepare('SELECT channel_id, values_json FROM channel_setup').all() as Array<{ channel_id: string; values_json: string }>;
  const out: Array<{ channelId: string; key: string; name: string }> = [];
  for (const r of rows) {
    for (const [key, v] of Object.entries(JSON.parse(r.values_json || '{}'))) {
      if (isLink(v)) out.push({ channelId: r.channel_id, key, name: (v as { $global: string }).$global });
    }
  }
  return out;
}

/**
 * Creates or updates a variable. `input.name` renames it; channel settings
 * linked to the old name follow.
 */
export function saveGlobal(name: string, input: { name?: unknown; type?: unknown; value?: unknown; description?: unknown }) {
  const existing = db.prepare('SELECT * FROM global_vars WHERE name = ?').get(name) as Row | undefined;
  const newName = String(input.name ?? name).trim();
  if (!GLOBAL_NAME_RE.test(newName)) throw new HttpError(400, 'Names use letters, numbers and _ and can\'t start with a number (like workHours).');
  const type = String(input.type ?? existing?.type ?? '');
  if (!GLOBAL_TYPES.includes(type)) throw new HttpError(400, `Type must be one of: ${GLOBAL_TYPES.join(', ')}.`);
  if (existing && existing.type !== type && globalLinks().some(l => l.name === name)) {
    throw new HttpError(409, `"${name}" is linked from channel settings, so its type can't change. Unlink it first.`);
  }
  const value = coerce({ type }, input.value !== undefined ? input.value : existing ? JSON.parse(existing.value_json) : '');
  const description = String(input.description ?? existing?.description ?? '');
  return transaction(() => {
    if (newName !== name) {
      if (db.prepare('SELECT 1 FROM global_vars WHERE name = ?').get(newName)) throw new HttpError(409, `A variable named "${newName}" already exists.`);
      if (existing) {
        db.prepare('DELETE FROM global_vars WHERE name = ?').run(name);
        relink(name, newName);
      }
    }
    db.prepare(`INSERT INTO global_vars (name, type, value_json, description, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(name) DO UPDATE SET type = excluded.type, value_json = excluded.value_json,
        description = excluded.description, updated_at = excluded.updated_at`)
      .run(newName, type, JSON.stringify(value), description, Date.now());
    return toVar(db.prepare('SELECT * FROM global_vars WHERE name = ?').get(newName) as unknown as Row);
  });
}

function relink(from: string, to: string) {
  const rows = db.prepare('SELECT channel_id, values_json FROM channel_setup').all() as Array<{ channel_id: string; values_json: string }>;
  for (const r of rows) {
    const values = JSON.parse(r.values_json || '{}');
    let changed = false;
    for (const [k, v] of Object.entries(values)) {
      if (isLink(v) && (v as { $global: string }).$global === from) { values[k] = { $global: to }; changed = true; }
    }
    if (changed) db.prepare('UPDATE channel_setup SET values_json = ? WHERE channel_id = ?').run(JSON.stringify(values), r.channel_id);
  }
}

export function deleteGlobal(name: string) {
  const used = globalLinks().filter(l => l.name === name);
  if (used.length) {
    throw new HttpError(409, `"${name}" is linked from ${used.length} channel setting(s). Unlink them on the Channels screen first.`);
  }
  const r = db.prepare('DELETE FROM global_vars WHERE name = ?').run(name);
  if (!r.changes) throw new HttpError(404, `No variable named "${name}".`);
}
