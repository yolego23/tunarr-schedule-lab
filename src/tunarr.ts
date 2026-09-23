// Every Tunarr API call goes through this module, so a Tunarr update that
// changes the API only needs fixing here. Written against Tunarr 1.3.15
// (docs/openapi.json).
import { config } from './config.ts';

export class TunarrError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export interface TunarrChannel {
  id: string;
  number: number;
  name: string;
  duration: number;
  startTime: number;
  programCount?: number;
  groupTitle?: string;
  [key: string]: unknown;
}

/** One entry of a channel's lineup, as GET /programming returns it. */
export interface LineupItem {
  type: 'content' | 'custom' | 'filler' | 'redirect' | 'flex';
  id?: string;
  duration?: number;
  durationMs?: number;
  [key: string]: unknown;
}

export interface TunarrSession {
  type: string;
  state: string;
  numConnections: number;
  connections: Array<{ ip: string; userAgent?: string; lastHeartbeat?: number }>;
}

export interface NowPlaying {
  type: string;
  id?: string;
  duration: number;
  start?: number;
  stop?: number;
  isPaused?: boolean;
  program?: Record<string, any>;
}

export interface ProgrammingResponse {
  name: string;
  number: number;
  totalPrograms: number;
  lineup: LineupItem[];
  programs: Record<string, { type: string; id: string; duration: number; program?: Record<string, any> }>;
  startTimeOffsets?: number[];
  schedule?: unknown;
}

async function call<T>(method: string, path: string, body?: unknown, timeoutMs = 60_000): Promise<T> {
  if (!config.tunarrUrl) throw new TunarrError('TUNARR_URL is not set. Set it in docker-compose.yml.', 503);
  let res: Response;
  try {
    res = await fetch(config.tunarrUrl + path, {
      method,
      headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err: any) {
    const why = err?.name === 'TimeoutError' ? `timed out after ${timeoutMs / 1000}s` : (err?.cause?.code || err?.message || String(err));
    throw new TunarrError(`Can't reach Tunarr at ${config.tunarrUrl} (${method} ${path}): ${why}`, 502);
  }
  const text = await res.text();
  if (!res.ok) throw new TunarrError(`Tunarr ${method} ${path} returned ${res.status}: ${text.slice(0, 1500)}`, res.status >= 500 ? 502 : res.status);
  if (!text) return undefined as T;
  try { return JSON.parse(text) as T; } catch { return text as T; }
}

export const tunarr = {
  version: () => call<{ tunarr: string }>('GET', '/api/version', undefined, 8_000),
  channels: () => call<TunarrChannel[]>('GET', '/api/channels'),
  channel: (id: string) => call<TunarrChannel>('GET', `/api/channels/${encodeURIComponent(id)}`),
  programming: (id: string) => call<ProgrammingResponse>('GET', `/api/channels/${encodeURIComponent(id)}/programming`, undefined, 120_000),
  /** Open streams right now, by channel id. */
  sessions: () => call<Record<string, TunarrSession[]>>('GET', '/api/sessions', undefined, 10_000),
  /** What a channel is playing right now. */
  nowPlaying: (id: string) => call<NowPlaying>('GET', `/api/channels/${encodeURIComponent(id)}/now_playing`, undefined, 10_000),
  fillerLists: () => call<Array<{ id: string; name: string; contentCount?: number }>>('GET', '/api/filler-lists'),

  /** Replaces (or with append, extends) a channel's lineup. */
  writeLineup: (id: string, lineup: LineupItem[], append = false) =>
    call<unknown>('POST', `/api/channels/${encodeURIComponent(id)}/programming`, { type: 'manual', lineup, append }, 180_000),

  /** Changes only the channel's start time (the moment its lineup's first item began). */
  async setStartTime(id: string, startTime: number): Promise<void> {
    const ch = await tunarr.channel(id);
    const body: Record<string, unknown> = {};
    for (const key of CHANNEL_PUT_KEYS) if (ch[key] !== undefined) body[key] = ch[key];
    body.startTime = Math.round(startTime);
    await call<unknown>('PUT', `/api/channels/${encodeURIComponent(id)}`, body);
  },

};

// Properties the PUT /api/channels/{id} schema accepts (openapi.json, 1.3.15).
const CHANNEL_PUT_KEYS = [
  'disableFillerOverlay', 'duration', 'fillerCollections', 'fillerRepeatCooldown', 'groupTitle', 'guideFlexTitle',
  'guideMinimumDuration', 'icon', 'id', 'name', 'number', 'offline', 'startTime', 'stealth', 'watermark', 'onDemand',
  'streamMode', 'transcodeConfigId', 'subtitlesEnabled', 'subtitlePreferences',
];

/** Converts a lineup entry read from Tunarr into the shape the write endpoint accepts. */
export function toWritableLineupItem(item: LineupItem): LineupItem {
  const duration = Number(item.duration ?? item.durationMs) || 0;
  switch (item.type) {
    case 'content': return { type: 'content', id: item.id, duration };
    case 'custom': return { type: 'custom', id: item.id, duration, customShowId: item.customShowId, index: item.index };
    case 'filler': return pick({ type: 'filler', id: item.id, duration, fillerListId: item.fillerListId, fillerType: item.fillerType });
    case 'redirect': return { type: 'redirect', duration, channel: item.channel, channelNumber: item.channelNumber, channelName: item.channelName };
    case 'flex': return pick({ type: 'flex', duration, fillerConfig: item.fillerConfig });
    default: return { ...item, duration };
  }
}

function pick(o: Record<string, unknown>): LineupItem {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as LineupItem;
}
