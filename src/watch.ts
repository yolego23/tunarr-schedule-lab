// Watch Tracker: polls Tunarr for open streams and what each streamed
// channel is playing, and records an episode as watched on that channel once
// it has streamed for the minimum minutes (a setting). Tunarr itself keeps no
// viewing history, so this is the only record.
//
// Only the newest few watches per episode per channel are kept (a setting),
// plus a running total and last-watched time that survive that pruning.
// Nothing about devices is stored.
import { db } from './db.ts';
import { appSetting } from './app-settings.ts';
import { normalizeProgram } from './channel-data.ts';
import { tunarr, type NowPlaying, type TunarrSession } from './tunarr.ts';

export const POLL_MS = 60_000;

export interface WatchDeps {
  sessions: () => Promise<Record<string, TunarrSession[]>>;
  nowPlaying: (channelId: string) => Promise<NowPlaying>;
  channelNames: () => Promise<Record<string, string>>;
}

interface Viewing {
  key: string; // program id + airing start: a new airing of the same episode is a new viewing
  programId: string;
  firstSeen: number;
  lastPoll: number;
  watchedMs: number;
  durationMs: number;
  eventId: number | null;
  showTitle: string;
  title: string;
  episodeLabel: string | null;
}

export interface TrackerStatus {
  enabled: boolean;
  lastPollAt: number | null;
  lastError: string | null;
  watching: Array<{ channelId: string; channelName: string; programId: string; showTitle: string; title: string; episodeLabel: string | null; minutes: number; counted: boolean }>;
}

export class WatchTracker {
  private active = new Map<string, Viewing>();
  private names: Record<string, string> = {};
  private namesAt = 0;
  private lastAgePrune = 0;
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  lastPollAt: number | null = null;
  lastError: string | null = null;

  private deps: WatchDeps;

  constructor(deps: WatchDeps) {
    this.deps = deps;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { this.poll().catch(() => { /* recorded in lastError */ }); }, POLL_MS);
    this.poll().catch(() => { /* recorded in lastError */ });
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  status(): TrackerStatus {
    const s = appSetting('watchTracker');
    return {
      enabled: s.enabled,
      lastPollAt: this.lastPollAt,
      lastError: this.lastError,
      watching: [...this.active.entries()].map(([channelId, v]) => ({
        channelId, channelName: this.names[channelId] || channelId, programId: v.programId,
        showTitle: v.showTitle, title: v.title, episodeLabel: v.episodeLabel,
        minutes: Math.round(v.watchedMs / 6000) / 10, counted: v.eventId !== null,
      })),
    };
  }

  /** One poll. `now` is injectable for tests. */
  async poll(now = Date.now()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const settings = appSetting('watchTracker');
      if (!settings.enabled) { this.active.clear(); return; }
      const sessions = await this.deps.sessions();
      const streamed = Object.entries(sessions || {})
        .filter(([, list]) => (list || []).some(s => (s.numConnections ?? s.connections?.length ?? 0) > 0))
        .map(([id]) => id);
      // Viewing ended on channels nobody is streaming any more.
      for (const id of [...this.active.keys()]) if (!streamed.includes(id)) this.active.delete(id);
      if (streamed.length && now - this.namesAt > 10 * 60_000) {
        this.names = await this.deps.channelNames().catch(() => this.names);
        this.namesAt = now;
      }
      for (const channelId of streamed) {
        try {
          const np = await this.deps.nowPlaying(channelId);
          this.track(channelId, np, now, settings.minMinutes);
        } catch (err: any) {
          this.lastError = `Now playing on ${this.names[channelId] || channelId}: ${err.message}`;
        }
      }
      if (now - this.lastAgePrune > 60 * 60_000) { pruneByAge(now); this.lastAgePrune = now; }
      this.lastPollAt = now;
      this.lastError = null;
    } catch (err: any) {
      this.lastError = err.message;
      throw err;
    } finally {
      this.running = false;
    }
  }

  private track(channelId: string, np: NowPlaying, now: number, minMinutes: number) {
    // Flex, redirects and filler aren't episodes.
    if (!np || np.type !== 'content' || !np.id) { this.active.delete(channelId); return; }
    const key = `${np.id}:${np.start ?? ''}`;
    let v = this.active.get(channelId);
    if (!v || v.key !== key) {
      const meta = normalizeProgram(np.id, { type: 'content', duration: np.duration, program: np.program });
      v = {
        key, programId: np.id, firstSeen: now, lastPoll: now, watchedMs: 0, durationMs: Number(np.duration) || 0, eventId: null,
        showTitle: meta.showTitle, title: meta.title, episodeLabel: meta.episodeLabel,
      };
      // Already counted this airing before a restart? Carry on with that record
      // instead of counting the same airing twice.
      if (np.start) {
        const earlier = db.prepare(`SELECT id, minutes, watched_at FROM watch_events
          WHERE channel_id = ? AND program_id = ? AND watched_at >= ? ORDER BY watched_at DESC LIMIT 1`)
          .get(channelId, np.id, Math.floor(np.start)) as { id: number; minutes: number; watched_at: number } | undefined;
        if (earlier) {
          v.eventId = earlier.id;
          v.watchedMs = earlier.minutes * 60_000;
          v.firstSeen = earlier.watched_at;
        }
      }
      this.active.set(channelId, v);
      return;
    }
    // Count the time since the last poll (capped, in case polls were missed), unless paused.
    if (!np.isPaused) v.watchedMs += Math.min(now - v.lastPoll, 2 * POLL_MS);
    if (v.durationMs) v.watchedMs = Math.min(v.watchedMs, v.durationMs);
    v.lastPoll = now;
    const minutes = Math.round(v.watchedMs / 6000) / 10;
    if (v.eventId === null && v.watchedMs >= minMinutes * 60_000) {
      v.eventId = recordWatch({ channelId, channelName: this.names[channelId] || '', v, minutes });
    } else if (v.eventId !== null) {
      db.prepare('UPDATE watch_events SET minutes = ? WHERE id = ?').run(minutes, v.eventId);
    }
  }
}

function recordWatch({ channelId, channelName, v, minutes }: { channelId: string; channelName: string; v: Viewing; minutes: number }): number {
  const r = db.prepare(`INSERT INTO watch_events (channel_id, channel_name, program_id, show_title, title, episode_label, watched_at, minutes, duration_ms)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(channelId, channelName, v.programId, v.showTitle, v.title, v.episodeLabel, v.firstSeen, minutes, v.durationMs || null);
  db.prepare(`INSERT INTO watch_totals (channel_id, program_id, total_count, last_watched_at) VALUES (?, ?, 1, ?)
    ON CONFLICT(channel_id, program_id) DO UPDATE SET total_count = total_count + 1,
      last_watched_at = max(last_watched_at, excluded.last_watched_at)`)
    .run(channelId, v.programId, v.firstSeen);
  // Keep only the newest N watches of this episode on this channel.
  const keep = appSetting('watchTracker').keepPerEpisode;
  db.prepare(`DELETE FROM watch_events WHERE channel_id = ? AND program_id = ? AND id NOT IN (
      SELECT id FROM watch_events WHERE channel_id = ? AND program_id = ? ORDER BY watched_at DESC, id DESC LIMIT ?)`)
    .run(channelId, v.programId, channelId, v.programId, keep);
  return Number(r.lastInsertRowid);
}

/** Drops watches older than the age limit (if one is set). */
export function pruneByAge(now = Date.now()) {
  const days = appSetting('watchTracker').maxAgeDays;
  if (!days) return 0;
  const cutoff = now - days * 86_400_000;
  const r = db.prepare('DELETE FROM watch_events WHERE watched_at < ?').run(cutoff);
  db.prepare('DELETE FROM watch_totals WHERE last_watched_at < ?').run(cutoff);
  return Number(r.changes);
}

// ---------- reading history ----------

export interface EpisodeHistory {
  total: number;
  last: number | null;
  watches: Array<{ at: number; minutes: number; channelId?: string }>;
}

/**
 * History for a sort run: this channel's history per episode, and the same
 * across all channels, limited to the given episode ids.
 */
export function historyForSort(channelId: string, programIds: string[]) {
  const ids = new Set(programIds);
  const channel: Record<string, EpisodeHistory> = {};
  const any: Record<string, EpisodeHistory> = {};
  const totals = db.prepare('SELECT channel_id, program_id, total_count, last_watched_at FROM watch_totals').all() as Array<{ channel_id: string; program_id: string; total_count: number; last_watched_at: number }>;
  for (const t of totals) {
    if (!ids.has(t.program_id)) continue;
    const a = (any[t.program_id] ??= { total: 0, last: null, watches: [] });
    a.total += t.total_count;
    a.last = Math.max(a.last ?? 0, t.last_watched_at);
    if (t.channel_id === channelId) channel[t.program_id] = { total: t.total_count, last: t.last_watched_at, watches: [] };
  }
  const events = db.prepare('SELECT channel_id, program_id, watched_at, minutes FROM watch_events ORDER BY watched_at DESC').all() as Array<{ channel_id: string; program_id: string; watched_at: number; minutes: number }>;
  for (const e of events) {
    if (!ids.has(e.program_id)) continue;
    any[e.program_id]?.watches.push({ at: e.watched_at, minutes: e.minutes, channelId: e.channel_id });
    if (e.channel_id === channelId) channel[e.program_id]?.watches.push({ at: e.watched_at, minutes: e.minutes });
  }
  return { channel, any };
}

/** Last-watched time and total per episode on one channel (for timeline badges). */
export function channelWatchSummary(channelId: string) {
  const rows = db.prepare('SELECT program_id, total_count, last_watched_at FROM watch_totals WHERE channel_id = ?').all(channelId) as Array<{ program_id: string; total_count: number; last_watched_at: number }>;
  return Object.fromEntries(rows.map(r => [r.program_id, { total: r.total_count, last: r.last_watched_at }]));
}

export function listWatches(opts: { channelId?: string; limit?: number; before?: number }) {
  const limit = Math.min(Math.max(Number(opts.limit) || 100, 1), 1000);
  const where: string[] = [];
  const args: Array<string | number> = [];
  if (opts.channelId) { where.push('channel_id = ?'); args.push(opts.channelId); }
  if (opts.before) { where.push('watched_at < ?'); args.push(Number(opts.before)); }
  const sql = `SELECT id, channel_id AS channelId, channel_name AS channelName, program_id AS programId, show_title AS showTitle,
      title, episode_label AS episodeLabel, watched_at AS watchedAt, minutes, duration_ms AS durationMs
    FROM watch_events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY watched_at DESC, id DESC LIMIT ?`;
  return db.prepare(sql).all(...args, limit);
}

export function watchCounts() {
  const row = db.prepare('SELECT count(*) AS events, count(DISTINCT program_id) AS episodes, min(watched_at) AS since FROM watch_events').get() as { events: number; episodes: number; since: number | null };
  return row;
}

/** Deletes one watch, or all watches (for one channel or everywhere), including totals. */
export function deleteWatches(opts: { id?: number; channelId?: string }) {
  if (opts.id) {
    const e = db.prepare('SELECT channel_id, program_id FROM watch_events WHERE id = ?').get(opts.id) as { channel_id: string; program_id: string } | undefined;
    if (!e) return 0;
    db.prepare('DELETE FROM watch_events WHERE id = ?').run(opts.id);
    // Recompute that episode's totals from what's left.
    const left = db.prepare('SELECT count(*) AS n, max(watched_at) AS last FROM watch_events WHERE channel_id = ? AND program_id = ?').get(e.channel_id, e.program_id) as { n: number; last: number | null };
    const t = db.prepare('SELECT total_count FROM watch_totals WHERE channel_id = ? AND program_id = ?').get(e.channel_id, e.program_id) as { total_count: number } | undefined;
    if (t && t.total_count > 1) {
      // Older watches may have been pruned already; keep counting them.
      db.prepare('UPDATE watch_totals SET total_count = total_count - 1, last_watched_at = coalesce(?, last_watched_at) WHERE channel_id = ? AND program_id = ?')
        .run(left.last, e.channel_id, e.program_id);
    } else {
      db.prepare('DELETE FROM watch_totals WHERE channel_id = ? AND program_id = ?').run(e.channel_id, e.program_id);
    }
    return 1;
  }
  if (opts.channelId) {
    db.prepare('DELETE FROM watch_totals WHERE channel_id = ?').run(opts.channelId);
    return Number(db.prepare('DELETE FROM watch_events WHERE channel_id = ?').run(opts.channelId).changes);
  }
  db.exec('DELETE FROM watch_totals');
  return Number(db.prepare('DELETE FROM watch_events').run().changes);
}

// The tracker used by the running server.
export const tracker = new WatchTracker({
  sessions: () => tunarr.sessions(),
  nowPlaying: id => tunarr.nowPlaying(id),
  channelNames: async () => Object.fromEntries((await tunarr.channels()).map(c => [c.id, String(c.name ?? '').trim()])),
});
