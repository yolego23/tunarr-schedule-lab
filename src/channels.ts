// Per-channel setup: which library sort (and version) a channel uses, its own
// values for that sort's settings, and how long a lineup to build.
import { db } from './db.ts';
import { tunarr } from './tunarr.ts';
import { HttpError, getVersion } from './sorts.ts';
import { parseSettings, resolveValues } from './shared/sort-settings.js';
import { appSetting } from './app-settings.ts';
import { globalsMap } from './globals.ts';
import { EMPTY_POOL, cleanPool, type PoolDefinition } from './pool.ts';
import { forgetChannelData } from './channel-data.ts';

export interface ChannelSetup {
  channelId: string;
  sortId: number | null;
  sortVersion: number | null;
  values: Record<string, unknown>;
  targetHours: number;
  alignStart: boolean;
  timetable: unknown;
  /** Pool sources and exclusions; none = the pool is what's on the lineup. */
  pool: PoolDefinition;
  updatedAt: number | null;
}

interface SetupRow {
  channel_id: string;
  sort_id: number | null;
  sort_version: number | null;
  values_json: string;
  target_hours: number;
  align_start: number;
  timetable_json: string | null;
  pool_json: string | null;
  updated_at: number;
}

export function getSetup(channelId: string): ChannelSetup {
  const row = db.prepare('SELECT * FROM channel_setup WHERE channel_id = ?').get(channelId) as SetupRow | undefined;
  if (!row) {
    const d = appSetting('channelDefaults');
    return { channelId, sortId: null, sortVersion: null, values: {}, targetHours: d.targetHours, alignStart: d.alignStart, timetable: null, pool: structuredClone(EMPTY_POOL), updatedAt: null };
  }
  return {
    channelId,
    sortId: row.sort_id,
    sortVersion: row.sort_version,
    values: JSON.parse(row.values_json || '{}'),
    targetHours: row.target_hours,
    alignStart: !!row.align_start,
    timetable: row.timetable_json ? JSON.parse(row.timetable_json) : null,
    pool: row.pool_json ? { ...EMPTY_POOL, ...JSON.parse(row.pool_json) } : structuredClone(EMPTY_POOL),
    updatedAt: row.updated_at,
  };
}

export function saveSetup(channelId: string, input: Partial<ChannelSetup>): ChannelSetup {
  const cur = getSetup(channelId);
  const next = { ...cur };
  if (input.sortId !== undefined) {
    if (input.sortId === null) {
      next.sortId = null;
      next.sortVersion = null;
    } else {
      const sortId = Number(input.sortId);
      const s = db.prepare('SELECT latest_version FROM sorts WHERE id = ?').get(sortId) as { latest_version: number } | undefined;
      if (!s) throw new HttpError(404, `Sort ${sortId} not found.`);
      const version = input.sortVersion != null ? Number(input.sortVersion) : (sortId === cur.sortId && cur.sortVersion ? cur.sortVersion : s.latest_version);
      getVersion(sortId, version);
      next.sortId = sortId;
      next.sortVersion = version;
    }
  } else if (input.sortVersion != null && next.sortId) {
    getVersion(next.sortId, Number(input.sortVersion));
    next.sortVersion = Number(input.sortVersion);
  }
  if (input.values !== undefined) {
    if (!input.values || typeof input.values !== 'object') throw new HttpError(400, 'values must be an object.');
    next.values = input.values as Record<string, unknown>;
  }
  if (input.targetHours !== undefined) {
    const h = Number(input.targetHours);
    if (!(h >= 1 && h <= 24 * 400)) throw new HttpError(400, 'Lineup length must be between 1 hour and 400 days.');
    next.targetHours = h;
  }
  if (input.alignStart !== undefined) next.alignStart = !!input.alignStart;
  if (input.timetable !== undefined) next.timetable = input.timetable;
  const poolChanged = input.pool !== undefined;
  if (poolChanged) next.pool = cleanPool(input.pool);
  next.updatedAt = Date.now();
  db.prepare(`INSERT INTO channel_setup (channel_id, sort_id, sort_version, values_json, target_hours, align_start, timetable_json, pool_json, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(channel_id) DO UPDATE SET sort_id = excluded.sort_id, sort_version = excluded.sort_version,
      values_json = excluded.values_json, target_hours = excluded.target_hours, align_start = excluded.align_start,
      timetable_json = excluded.timetable_json, pool_json = excluded.pool_json, updated_at = excluded.updated_at`)
    .run(channelId, next.sortId, next.sortVersion, JSON.stringify(next.values), next.targetHours, next.alignStart ? 1 : 0,
      next.timetable == null ? null : JSON.stringify(next.timetable), JSON.stringify(next.pool), next.updatedAt);
  if (poolChanged) forgetChannelData(channelId);
  return getSetup(channelId);
}

/** The settings and values this channel's sort runs with. */
export function channelSortValues(setup: ChannelSetup) {
  if (!setup.sortId || !setup.sortVersion) return null;
  const v = getVersion(setup.sortId, setup.sortVersion);
  const { settings } = parseSettings(v.code);
  return { code: v.code, settings, values: resolveValues(settings, setup.values, globalsMap()) };
}

/** Tunarr's channels, each with its Schedule Lab setup. */
export async function listChannels() {
  const channels = await tunarr.channels();
  const sorts = new Map((db.prepare('SELECT id, name, latest_version FROM sorts').all() as Array<{ id: number; name: string; latest_version: number }>).map(s => [s.id, s]));
  return channels
    .sort((a, b) => (a.number ?? 0) - (b.number ?? 0))
    .map(c => {
      const setup = getSetup(c.id);
      const sort = setup.sortId ? sorts.get(setup.sortId) : undefined;
      return {
        id: c.id,
        number: c.number,
        name: String(c.name ?? '').trim(),
        groupTitle: c.groupTitle,
        programCount: c.programCount,
        durationMs: c.duration,
        startTime: c.startTime,
        setup,
        sortName: sort?.name ?? null,
        latestVersion: sort?.latest_version ?? null,
      };
    });
}
