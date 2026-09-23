// Applying lineups: every change to a channel's lineup is backed up first
// (last 20 per channel) and can be undone.
import { appSetting } from './app-settings.ts';
import { db } from './db.ts';
import { forgetChannelData } from './channel-data.ts';
import { getPreview } from './preview.ts';
import { HttpError } from './sorts.ts';
import { tunarr, toWritableLineupItem, type LineupItem } from './tunarr.ts';
import { recordExpectation } from './guide-check.ts';

// One change at a time per channel.
const locks = new Map<string, Promise<unknown>>();
async function withChannelLock<T>(channelId: string, fn: () => Promise<T>): Promise<T> {
  if (locks.has(channelId)) throw new HttpError(409, 'Another change to this channel is still running.');
  const p = fn();
  locks.set(channelId, p);
  try { return await p; } finally { locks.delete(channelId); }
}

interface BackupRow {
  id: number;
  channel_id: string;
  channel_name: string;
  created_at: number;
  reason: string;
  item_count: number;
  duration_ms: number;
  start_time: number | null;
  lineup_json: string;
  schedule_json: string | null;
}

/** Saves the channel's lineup as Tunarr has it right now. */
export async function backupChannel(channelId: string, reason: string): Promise<number> {
  const [prog, ch] = await Promise.all([tunarr.programming(channelId), tunarr.channel(channelId)]);
  const lineup = (prog.lineup || []).map(toWritableLineupItem);
  const durationMs = lineup.reduce((a, b) => a + (Number(b.duration) || 0), 0);
  const r = db.prepare(`INSERT INTO backups (channel_id, channel_name, created_at, reason, item_count, duration_ms, start_time, lineup_json, schedule_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(channelId, String(ch.name ?? '').trim(), Date.now(), reason, lineup.length, durationMs, Number(ch.startTime) || null,
      JSON.stringify(lineup), prog.schedule ? JSON.stringify(prog.schedule) : null);
  const keep = db.prepare('SELECT id FROM backups WHERE channel_id = ? ORDER BY created_at DESC, id DESC LIMIT ?').all(channelId, appSetting('backupsPerChannel')) as Array<{ id: number }>;
  if (keep.length >= appSetting('backupsPerChannel')) {
    db.prepare(`DELETE FROM backups WHERE channel_id = ? AND id NOT IN (${keep.map(() => '?').join(',')})`).run(channelId, ...keep.map(k => k.id));
  }
  return Number(r.lastInsertRowid);
}

function log(entry: { channelId: string; channelName: string; action: string; detail: string; itemCount?: number; durationMs?: number; backupId?: number; ok: boolean; message: string }) {
  db.prepare(`INSERT INTO apply_log (channel_id, channel_name, created_at, action, detail, item_count, duration_ms, backup_id, ok, message)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(entry.channelId, entry.channelName, Date.now(), entry.action, entry.detail, entry.itemCount ?? null, entry.durationMs ?? null,
      entry.backupId ?? null, entry.ok ? 1 : 0, entry.message);
}

/** Writes a lineup and sets the start time. Returns warnings for the non-fatal steps. */
async function writeChannel(channelId: string, lineup: LineupItem[], startTime: number | null, label: string): Promise<string[]> {
  const warnings: string[] = [];
  await tunarr.writeLineup(channelId, lineup);
  let aligned = false;
  if (startTime) {
    try {
      await tunarr.setStartTime(channelId, startTime);
      aligned = true;
    } catch (err: any) {
      warnings.push(`The lineup was saved, but setting the channel's start time failed, so Tunarr may start the lineup at a different point: ${err.message}`);
    }
  }
  // Remember what should air next, for the guide check.
  try {
    const start = aligned ? startTime! : Number((await tunarr.channel(channelId)).startTime);
    recordExpectation(channelId, label, lineup, start);
  } catch { /* the guide check falls back to the current lineup */ }
  forgetChannelData(channelId);
  return warnings;
}

export async function applyPreview(channelId: string, previewId: string, alignStart: boolean, opts: { adoptDraft?: boolean } = {}) {
  if (channelId === 'sample') throw new HttpError(400, 'Sample data can\'t be applied to Tunarr.');
  const preview = getPreview(previewId);
  if (preview.channelId !== channelId && !(opts.adoptDraft && preview.channelId === 'draft')) throw new HttpError(400, 'That preview was made for a different channel.');
  if (!preview.lineup.length) throw new HttpError(400, 'The preview is empty; there is nothing to apply.');
  return withChannelLock(channelId, async () => {
    const ch = await tunarr.channel(channelId);
    const channelName = String(ch.name ?? '').trim();
    const backupId = await backupChannel(channelId, `Before applying ${preview.label}`);
    try {
      const warnings = await writeChannel(channelId, preview.lineup, alignStart ? preview.scheduleStartMs : null, `the applied lineup (${preview.label})`);
      log({ channelId, channelName, action: 'apply', detail: preview.label, itemCount: preview.lineup.length, durationMs: preview.durationMs, backupId, ok: true, message: warnings.join(' ') });
      return { ok: true, backupId, warnings, itemCount: preview.lineup.length, durationMs: preview.durationMs };
    } catch (err: any) {
      log({ channelId, channelName, action: 'apply', detail: preview.label, itemCount: preview.lineup.length, durationMs: preview.durationMs, backupId, ok: false, message: err.message });
      throw err;
    }
  });
}

export async function restoreBackup(backupId: number, action: 'restore' | 'undo' = 'restore') {
  const b = db.prepare('SELECT * FROM backups WHERE id = ?').get(backupId) as BackupRow | undefined;
  if (!b) throw new HttpError(404, `Backup ${backupId} not found (only the last ${appSetting('backupsPerChannel')} per channel are kept).`);
  return withChannelLock(b.channel_id, async () => {
    const lineup = JSON.parse(b.lineup_json) as LineupItem[];
    const when = new Date(b.created_at).toLocaleString();
    // Restoring is itself a change, so it gets a backup too (and can be undone).
    const newBackupId = await backupChannel(b.channel_id, `Before ${action === 'undo' ? 'undo' : 'restoring the backup'} from ${when}`);
    const detail = `Backup from ${when} (${b.reason})`;
    try {
      const warnings = await writeChannel(b.channel_id, lineup, b.start_time, `the restored lineup (backup #${b.id})`);
      log({ channelId: b.channel_id, channelName: b.channel_name, action, detail, itemCount: lineup.length, durationMs: b.duration_ms, backupId: newBackupId, ok: true, message: warnings.join(' ') });
      return { ok: true, backupId: newBackupId, warnings, itemCount: lineup.length, durationMs: b.duration_ms };
    } catch (err: any) {
      log({ channelId: b.channel_id, channelName: b.channel_name, action, detail, itemCount: lineup.length, durationMs: b.duration_ms, backupId: newBackupId, ok: false, message: err.message });
      throw err;
    }
  });
}

/** Undo reverts the channel's most recent successful change (apply, restore or undo). */
export async function undoLast(channelId: string) {
  const last = db.prepare('SELECT backup_id FROM apply_log WHERE channel_id = ? AND ok = 1 AND backup_id IS NOT NULL ORDER BY created_at DESC, id DESC LIMIT 1')
    .get(channelId) as { backup_id: number } | undefined;
  if (!last) throw new HttpError(404, 'Nothing to undo for this channel yet.');
  return restoreBackup(last.backup_id, 'undo');
}

export function listBackups(channelId: string) {
  return db.prepare(`SELECT id, channel_id AS channelId, channel_name AS channelName, created_at AS createdAt, reason,
      item_count AS itemCount, duration_ms AS durationMs, start_time AS startTime
    FROM backups WHERE channel_id = ? ORDER BY created_at DESC, id DESC`).all(channelId);
}

export function getBackupFile(backupId: number) {
  const b = db.prepare('SELECT * FROM backups WHERE id = ?').get(backupId) as BackupRow | undefined;
  if (!b) throw new HttpError(404, `Backup ${backupId} not found.`);
  return {
    kind: 'schedule-lab-backup', channelId: b.channel_id, channelName: b.channel_name, createdAt: b.created_at, reason: b.reason,
    startTime: b.start_time, lineup: JSON.parse(b.lineup_json), schedule: b.schedule_json ? JSON.parse(b.schedule_json) : null,
  };
}

export function listHistory(channelId?: string, limit = 100) {
  const sql = `SELECT id, channel_id AS channelId, channel_name AS channelName, created_at AS createdAt, action, detail,
      item_count AS itemCount, duration_ms AS durationMs, backup_id AS backupId, ok, message
    FROM apply_log ${channelId ? 'WHERE channel_id = ?' : ''} ORDER BY created_at DESC, id DESC LIMIT ?`;
  return channelId ? db.prepare(sql).all(channelId, limit) : db.prepare(sql).all(limit);
}

