// Reads a channel's lineup and episode pool from Tunarr and normalizes it into
// the items sorts work with (the same fields 1.8 gave them).
import { tunarr, type LineupItem, type ProgrammingResponse } from './tunarr.ts';
import { makeRng } from './shared/analysis.js';

export interface PoolItem {
  id: string;
  type: 'content' | 'custom';
  title: string;
  showTitle: string;
  seasonNumber?: number;
  episodeNumber?: number;
  episodeLabel: string | null;
  durationMs: number;
  programType?: string;
  year?: number;
  releaseDate?: number;
  showId?: string;
  customShowId?: string;
  customIndex?: number;
}

/** A lineup entry: a pool episode, or a non-episode item (flex, redirect, filler). */
export interface CurrentItem {
  id?: string;
  type: string;
  durationMs: number;
}

export interface ChannelData {
  channelId: string;
  name: string;
  number: number;
  startTime: number;
  fetchedAt: number;
  pool: PoolItem[];
  current: CurrentItem[];
  /** The lineup exactly as Tunarr returned it (for backups). */
  lineupRaw: LineupItem[];
  schedule: unknown;
  totalDurationMs: number;
  /** Index into `current` of what Tunarr is playing now, and how far into it. */
  playingIndex: number;
  playingOffsetMs: number;
}

// "Show - S04E29 - Episode", also multi-part "Show - S01E21-E22 - A + B".
const COMBINED_TITLE_RE = /^(.*?)\s*-\s*S(\d{1,2})E(\d{1,3})(?:\s*-\s*E?(\d{1,3}))?\s*-\s*(.*)$/i;
const pad2 = (n: number) => String(n).padStart(2, '0');

export function normalizeProgram(id: string, entry: { type: string; duration: number; program?: Record<string, any>; customShowId?: string; index?: number }): PoolItem {
  const p = entry.program || {};
  let title: string = p.title ?? '(untitled episode)';
  let showTitle: string | undefined = p.show?.title ?? p.grandparent?.title;
  let seasonNumber: number | undefined = p.season?.index ?? p.seasonNumber;
  let episodeNumber: number | undefined = p.episodeNumber;
  // Some libraries put "Show - S04E29 - Episode" in the title field.
  const m = typeof title === 'string' ? title.match(COMBINED_TITLE_RE) : null;
  let lastEpisode: number | undefined;
  if (m) {
    if (!showTitle) showTitle = m[1].trim();
    if (seasonNumber === undefined) seasonNumber = Number(m[2]);
    if (episodeNumber === undefined) episodeNumber = Number(m[3]);
    if (m[4] && Number(m[4]) > Number(m[3])) lastEpisode = Number(m[4]);
    title = m[5].trim();
  }
  if (!showTitle) showTitle = p.type === 'movie' ? 'Movies' : '—';
  const hasSE = seasonNumber !== undefined && seasonNumber !== null && episodeNumber !== undefined && episodeNumber !== null;
  return {
    id,
    type: entry.type === 'custom' ? 'custom' : 'content',
    title,
    showTitle,
    seasonNumber,
    episodeNumber,
    episodeLabel: hasSE ? `S${pad2(seasonNumber!)}E${pad2(episodeNumber!)}${lastEpisode ? `-E${pad2(lastEpisode)}` : ''}` : null,
    durationMs: Number(entry.duration ?? p.duration) || 0,
    programType: p.type,
    year: p.year,
    releaseDate: p.releaseDate,
    showId: p.showId ?? p.show?.uuid,
    customShowId: entry.customShowId,
    customIndex: entry.index,
  };
}

function fromProgramming(channelId: string, prog: ProgrammingResponse, startTime: number): ChannelData {
  const pool: PoolItem[] = [];
  for (const [id, entry] of Object.entries(prog.programs || {})) {
    if (entry.type !== 'content' && entry.type !== 'custom') continue;
    pool.push(normalizeProgram(id, entry));
  }
  const current: CurrentItem[] = (prog.lineup || []).map(li => ({
    id: li.id,
    type: li.type,
    durationMs: Number(li.durationMs ?? li.duration) || 0,
  }));
  const totalDurationMs = current.reduce((a, b) => a + b.durationMs, 0);
  const { index, offset } = playingPosition(current, startTime, totalDurationMs, Date.now());
  return {
    channelId,
    name: prog.name,
    number: prog.number,
    startTime,
    fetchedAt: Date.now(),
    pool,
    current,
    lineupRaw: prog.lineup || [],
    schedule: prog.schedule ?? null,
    totalDurationMs,
    playingIndex: index,
    playingOffsetMs: offset,
  };
}

/** Tunarr loops the lineup from the channel's start time. */
export function playingPosition(items: { durationMs: number }[], startTime: number, totalMs: number, now: number) {
  if (!items.length || !(totalMs > 0)) return { index: 0, offset: 0 };
  let pos = (now - startTime) % totalMs;
  if (pos < 0) pos += totalMs;
  for (let i = 0; i < items.length; i++) {
    if (pos < items[i].durationMs) return { index: i, offset: pos };
    pos -= items[i].durationMs;
  }
  return { index: 0, offset: 0 };
}

const cache = new Map<string, ChannelData>();
const CACHE_MS = 2 * 60_000;

export async function getChannelData(channelId: string, fresh = false): Promise<ChannelData> {
  if (channelId === 'sample') return sampleChannel();
  const hit = cache.get(channelId);
  if (hit && !fresh && Date.now() - hit.fetchedAt < CACHE_MS) return hit;
  const [prog, ch] = await Promise.all([tunarr.programming(channelId), tunarr.channel(channelId)]);
  const data = fromProgramming(channelId, prog, Number(ch.startTime) || Date.now());
  cache.set(channelId, data);
  return data;
}

export function forgetChannelData(channelId: string): void {
  cache.delete(channelId);
}

// ---------- sample data (offline testing, same shows as 1.8) ----------
let sample: ChannelData | null = null;

function sampleChannel(): ChannelData {
  if (sample) return sample;
  const rng = makeRng(42);
  const shows = [
    { name: 'Static Avenue', eps: 24, dur: 22, titles: ['Pilot Light', 'The Long Weekend', 'Aerial View', 'Lost Channel', 'Rerun Season', 'Static Cling', 'The Cooldown', 'Off the Air', 'Wide Signal', 'Test Pattern'] },
    { name: 'Bluefin Detectives', eps: 18, dur: 24, titles: ['The Wet Alibi', 'Tideline', 'Low Tide Confession', 'Salt and Static', 'The Drift Case', 'Anchor Point', 'Brackish', 'Undertow'] },
    { name: 'Cul-de-Sac Theatre', eps: 30, dur: 21, titles: ['Lawn Order', 'The New Neighbors', 'Garage Sale Justice', 'Curbside', 'Block Party', 'Sprinkler Wars', 'The HOA Letter', 'Trash Day', 'Porch Light'] },
  ];
  const pool: PoolItem[] = [];
  for (const s of shows) {
    for (let e = 1; e <= s.eps; e++) {
      const season = Math.ceil(e / 10);
      const ep = e - (season - 1) * 10;
      const title = s.titles[(e - 1) % s.titles.length] + (e > s.titles.length ? ` Part ${Math.ceil(e / s.titles.length)}` : '');
      pool.push({
        id: `s-${s.name}-e${e}`, type: 'content', title, showTitle: s.name,
        seasonNumber: season, episodeNumber: ep, episodeLabel: `S${pad2(season)}E${pad2(ep)}`,
        durationMs: (s.dur * 60 + Math.floor(rng() * 120)) * 1000,
      });
    }
  }
  const current: CurrentItem[] = pool.slice(0, 40).map(p => ({ id: p.id, type: 'content', durationMs: p.durationMs }));
  const totalDurationMs = current.reduce((a, b) => a + b.durationMs, 0);
  sample = {
    channelId: 'sample', name: 'Sample data', number: 0, startTime: Date.now(), fetchedAt: Date.now(),
    pool, current, lineupRaw: [], schedule: null, totalDurationMs, playingIndex: 0, playingOffsetMs: 0,
  };
  return sample;
}
