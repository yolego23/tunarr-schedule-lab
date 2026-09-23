// Channel management: create, copy, edit the basics, delete and recreate
// Tunarr channels. Deleting first archives the channel's settings and lineup
// so it can be recreated as it was, with the same id (so Schedule Lab's setup
// and watch history reconnect).
import { randomUUID } from 'node:crypto';
import { db, transaction } from './db.ts';
import { HttpError } from './sorts.ts';
import { forgetChannelData } from './channel-data.ts';
import { tunarr, toWritableLineupItem, type LineupItem, type TunarrChannel } from './tunarr.ts';

db.exec(`
CREATE TABLE IF NOT EXISTS channel_archive (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  channel_id   TEXT NOT NULL,
  name         TEXT NOT NULL,
  number       INTEGER NOT NULL,
  deleted_at   INTEGER NOT NULL,
  channel_json TEXT NOT NULL,
  lineup_json  TEXT NOT NULL,
  recreated_at INTEGER
);
`);

// Basics every new channel needs; the rest takes Tunarr's defaults.
const NEW_CHANNEL_DEFAULTS = {
  disableFillerOverlay: false,
  duration: 0,
  fillerRepeatCooldown: 30_000,
  guideMinimumDuration: 30_000,
  icon: { path: '', width: 0, duration: 0, position: 'bottom-right', useDefaultIconFallback: true },
  offline: { mode: 'pic', picture: '', soundtrack: '' },
  stealth: false,
  onDemand: { enabled: false },
  streamMode: 'hls',
  subtitlesEnabled: false,
};

export interface ChannelBasics {
  name?: unknown;
  number?: unknown;
  groupTitle?: unknown;
}

async function channelsNow() {
  return tunarr.channels();
}

function checkName(v: unknown): string {
  const name = String(v ?? '').trim();
  if (!name) throw new HttpError(400, 'The channel needs a name.');
  if (name.length > 100) throw new HttpError(400, 'Channel names are limited to 100 characters.');
  return name;
}

function checkNumber(v: unknown, channels: TunarrChannel[], exceptId?: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 9999) throw new HttpError(400, 'The channel number must be a whole number from 1 to 9999.');
  const clash = channels.find(c => c.number === n && c.id !== exceptId);
  if (clash) throw new HttpError(409, `Channel ${n} is already taken by "${String(clash.name).trim()}".`);
  return n;
}

export async function nextFreeNumber(after = 0): Promise<number> {
  const taken = new Set((await channelsNow()).map(c => c.number));
  let n = Math.max(1, Math.floor(after) + 1);
  while (taken.has(n)) n++;
  return n;
}

async function defaultTranscodeConfigId(channels: TunarrChannel[]): Promise<string> {
  const configs = await tunarr.transcodeConfigs();
  const id = configs.find(c => c.isDefault)?.id || configs[0]?.id || (channels[0]?.transcodeConfigId as string | undefined);
  if (!id) throw new HttpError(502, 'Tunarr has no transcode profile to give the new channel.');
  return id;
}

/** A new, empty channel. */
export async function createChannel(input: ChannelBasics) {
  const channels = await channelsNow();
  const name = checkName(input.name);
  const number = input.number === undefined || input.number === '' ? await nextFreeNumber(Math.max(0, ...channels.map(c => c.number))) : checkNumber(input.number, channels);
  const created = await tunarr.createChannel({
    ...NEW_CHANNEL_DEFAULTS,
    id: randomUUID(),
    name,
    number,
    groupTitle: String(input.groupTitle ?? '').trim() || 'tunarr',
    startTime: Date.now(),
    transcodeConfigId: await defaultTranscodeConfigId(channels),
  });
  return created;
}

/**
 * Tunarr's copy (settings and lineup), then the new name/number/group, and
 * the source channel's Schedule Lab setup (sort, settings, lineup length).
 */
export async function copyChannel(sourceId: string, input: ChannelBasics) {
  const channels = await channelsNow();
  const source = channels.find(c => c.id === sourceId);
  if (!source) throw new HttpError(404, 'That channel no longer exists in Tunarr.');
  const name = input.name !== undefined ? checkName(input.name) : `${String(source.name).trim()} (copy)`;
  const number = input.number !== undefined && input.number !== '' ? checkNumber(input.number, channels) : undefined;
  const copy = await tunarr.copyChannel(sourceId);
  const changes: Record<string, unknown> = { name };
  if (number !== undefined) changes.number = number;
  if (input.groupTitle !== undefined) changes.groupTitle = String(input.groupTitle).trim() || source.groupTitle;
  const updated = await tunarr.updateChannel(copy.id, changes);
  db.prepare(`INSERT OR IGNORE INTO channel_setup (channel_id, sort_id, sort_version, values_json, target_hours, align_start, timetable_json, updated_at)
    SELECT ?, sort_id, sort_version, values_json, target_hours, align_start, timetable_json, ? FROM channel_setup WHERE channel_id = ?`)
    .run(copy.id, Date.now(), sourceId);
  return updated;
}

/** Rename, renumber, change group. */
export async function updateChannelBasics(id: string, input: ChannelBasics) {
  const channels = await channelsNow();
  if (!channels.some(c => c.id === id)) throw new HttpError(404, 'That channel no longer exists in Tunarr.');
  const changes: Record<string, unknown> = {};
  if (input.name !== undefined) changes.name = checkName(input.name);
  if (input.number !== undefined) changes.number = checkNumber(input.number, channels, id);
  if (input.groupTitle !== undefined) changes.groupTitle = String(input.groupTitle).trim();
  if (!Object.keys(changes).length) throw new HttpError(400, 'Nothing to change.');
  return tunarr.updateChannel(id, changes);
}

/** Archives the channel's settings and lineup, then deletes it in Tunarr. */
export async function deleteChannel(id: string) {
  const [ch, prog] = await Promise.all([tunarr.channel(id), tunarr.programming(id)]);
  const lineup = (prog.lineup || []).map(toWritableLineupItem);
  const r = db.prepare(`INSERT INTO channel_archive (channel_id, name, number, deleted_at, channel_json, lineup_json) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(id, String(ch.name ?? '').trim(), Number(ch.number), Date.now(), JSON.stringify(ch), JSON.stringify(lineup));
  try {
    await tunarr.deleteChannel(id);
  } catch (err) {
    db.prepare('DELETE FROM channel_archive WHERE id = ?').run(Number(r.lastInsertRowid));
    throw err;
  }
  forgetChannelData(id);
  return { archiveId: Number(r.lastInsertRowid), name: String(ch.name ?? '').trim(), number: ch.number };
}

export function listArchive() {
  return db.prepare(`SELECT id, channel_id AS channelId, name, number, deleted_at AS deletedAt, recreated_at AS recreatedAt,
      json_array_length(lineup_json) AS itemCount FROM channel_archive ORDER BY deleted_at DESC LIMIT 100`).all();
}

/**
 * Recreates a deleted channel with its old id, settings and lineup. If its
 * number has been taken since, it gets the next free one.
 */
export async function recreateChannel(archiveId: number) {
  const row = db.prepare('SELECT * FROM channel_archive WHERE id = ?').get(archiveId) as
    { id: number; channel_id: string; channel_json: string; lineup_json: string; recreated_at: number | null } | undefined;
  if (!row) throw new HttpError(404, 'That deleted channel isn\'t in the archive.');
  const channels = await channelsNow();
  if (channels.some(c => c.id === row.channel_id)) throw new HttpError(409, 'That channel already exists in Tunarr.');
  const saved = JSON.parse(row.channel_json) as TunarrChannel;
  const number = channels.some(c => c.number === saved.number) ? await nextFreeNumber(saved.number) : saved.number;
  const lineup = JSON.parse(row.lineup_json) as LineupItem[];
  const created = await tunarr.createChannel({ ...saved, number });
  if (lineup.length) {
    await tunarr.writeLineup(created.id, lineup);
    await tunarr.setStartTime(created.id, Number(saved.startTime) || Date.now());
  }
  transaction(() => db.prepare('UPDATE channel_archive SET recreated_at = ? WHERE id = ?').run(Date.now(), archiveId));
  return { ...created, number, itemCount: lineup.length };
}
