// Runs sorts against a channel's pool and keeps the resulting lineups
// ("previews") in memory so Apply can write exactly what was previewed.
import { randomUUID } from 'node:crypto';
import { draftChannelData, getChannelData, lastAiredMap, type ChannelData } from './channel-data.ts';
import { historyForSort } from './watch.ts';
import { getSetup } from './channels.ts';
import { runSort, SortError, type BridgeHandler, type SortOutputItem } from './sandbox/index.ts';
import { aiAvailable, aiConfig, ask } from './ai.ts';
import { HttpError, getSort, getVersion } from './sorts.ts';
import { toWritableLineupItem, type LineupItem } from './tunarr.ts';
import { parseSettings, resolveValues } from './shared/sort-settings.js';
import { scoreSchedule } from './shared/analysis.js';
import { appSetting } from './app-settings.ts';
import { globalsForSorts, globalsMap } from './globals.ts';

export interface Preview {
  id: string;
  channelId: string;
  channelName: string;
  createdAt: number;
  scheduleStartMs: number;
  targetMs: number;
  label: string;
  sortId: number | null;
  sortVersion: number | null;
  items: SortOutputItem[];
  lineup: LineupItem[];
  durationMs: number;
}

const previews = new Map<string, Preview>();
const MAX_PREVIEWS = 150;

function remember(p: Preview) {
  previews.set(p.id, p);
  while (previews.size > MAX_PREVIEWS) previews.delete(previews.keys().next().value!);
}

export function getPreview(id: string): Preview {
  const p = previews.get(id);
  if (!p) throw new HttpError(404, 'That preview has expired (the server restarted or it is too old). Run the preview again.');
  return p;
}

/** Converts a sort's output into Tunarr lineup entries. */
function toLineup(data: ChannelData, items: SortOutputItem[]): { lineup: LineupItem[]; durationMs: number } {
  const byId = new Map(data.pool.map(p => [p.id, p]));
  let durationMs = 0;
  const lineup = items.map(it => {
    let entry: LineupItem;
    if ('ci' in it) entry = toWritableLineupItem(data.lineupRaw[it.ci] ?? { type: 'flex', duration: data.current[it.ci]?.durationMs || 60_000 });
    else if ('id' in it) {
      const p = byId.get(it.id)!;
      entry = p.type === 'custom'
        ? { type: 'custom', id: p.id, duration: p.durationMs, customShowId: p.customShowId, index: p.customIndex }
        : { type: 'content', id: p.id, duration: p.durationMs };
    } else entry = { type: 'flex', duration: Math.round(it.durationMs) };
    durationMs += Number(entry.duration) || 0;
    return entry;
  });
  return { lineup, durationMs };
}

function sortInput(data: ChannelData, params: Record<string, unknown>, targetMs: number, scheduleStartMs: number) {
  return {
    pool: data.pool,
    current: data.current,
    lineupItems: data.lineupItems,
    currentPlayingIndex: data.playingIndex,
    params,
    targetMs,
    scheduleStartMs,
    channel: { id: data.channelId, name: data.name, number: data.number },
    globals: globalsForSorts(),
    aiAvailable: aiAvailable('sort'),
    history: { ...historyForSort(data.channelId, data.pool.map(p => p.id)), lastAired: lastAiredMap(data) },
  };
}

const timeLimitMs = () => appSetting('sortTimeLimitSec') * 1000;

/** ctx.ai.ask and the older ctx.utils.claude, for sorts run on a channel. */
function sortBridge(channelId: string): BridgeHandler {
  return async (kind, p) => {
    if (kind !== 'ai' && kind !== 'claude') throw new Error(`Unknown helper "${kind}"`);
    const channel = channelId === 'sample' || channelId === 'draft' ? undefined : channelId;
    if (kind === 'claude') {
      // 1.8-style call: the sort's own key if it has one, else the Anthropic
      // provider from Settings → AI, else whatever the default provider is.
      const anthropicReady = !!aiConfig().anthropic.apiKey;
      const useDefault = !p.apiKey && !anthropicReady;
      const r = await ask({
        prompt: p.prompt, system: p.system, maxTokens: p.maxTokens, feature: 'sort', channelId: channel,
        apiKey: p.apiKey || undefined, provider: useDefault ? undefined : 'anthropic', model: useDefault ? undefined : p.model,
      });
      return r.text;
    }
    const r = await ask({ prompt: p.prompt, system: p.system, provider: p.provider, model: p.model, maxTokens: p.maxTokens, feature: 'sort', channelId: channel });
    return r.text;
  };
}

function checkTiming(targetHours: unknown, scheduleStartMs: unknown) {
  const hours = Number(targetHours);
  if (!(hours >= 1 && hours <= 24 * 400)) throw new HttpError(400, 'Lineup length must be between 1 hour and 400 days.');
  const start = Number(scheduleStartMs);
  if (!Number.isFinite(start)) throw new HttpError(400, 'scheduleStartMs is required.');
  return { targetMs: hours * 3_600_000, start };
}

/** The code and settings values to run for a library sort on a channel. */
function resolveSort(channelId: string, sortId: number, version: number | undefined, explicitParams?: Record<string, unknown>) {
  const setup = channelId === 'sample' || channelId === 'draft' ? null : getSetup(channelId);
  const v = version ?? (setup?.sortId === sortId && setup.sortVersion ? setup.sortVersion : undefined);
  const row = v ? getVersion(sortId, v) : latestVersion(sortId);
  const { settings } = parseSettings(row.code);
  // The channel's own values apply when this is the channel's sort.
  const stored = explicitParams ?? (setup?.sortId === sortId ? setup.values : {});
  return { code: row.code, version: row.version, settings, params: resolveValues(settings, stored, globalsMap()) };
}

function latestVersion(sortId: number) {
  return getVersion(sortId, getSort(sortId).latest_version);
}

export interface RunRequest {
  channelId: string;
  /** Either code (Sort Builder test) or a library sort. */
  code?: string;
  sortId?: number;
  sortVersion?: number;
  params?: Record<string, unknown>;
  targetHours: number;
  scheduleStartMs: number;
  label?: string;
  /** channelId 'draft' only: the pool sources to preview (Channel Builder). */
  pool?: unknown;
  name?: string;
  /** Also score the result with this scoring code (automations). */
  scoreCode?: string;
}

export async function runPreview(req: RunRequest) {
  const { targetMs, start } = checkTiming(req.targetHours, req.scheduleStartMs);
  const data = req.channelId === 'draft' ? await draftChannelData(req.pool, req.name) : await getChannelData(req.channelId);
  let code: string, params: Record<string, unknown>, label = req.label || 'Test run', sortId: number | null = null, sortVersion: number | null = null;
  if (req.code !== undefined) {
    code = String(req.code);
    const { settings, errors } = parseSettings(code);
    if (errors.length) throw new HttpError(400, `Settings block: ${errors.join('; ')}`);
    params = resolveValues(settings, req.params || {}, globalsMap());
  } else if (req.sortId) {
    const r = resolveSort(req.channelId, Number(req.sortId), req.sortVersion ? Number(req.sortVersion) : undefined, req.params);
    code = r.code; params = r.params; sortId = Number(req.sortId); sortVersion = r.version;
    if (!req.label) label = `${getSort(sortId).name} v${sortVersion}`;
  } else {
    throw new HttpError(400, 'Pick a sort to run.');
  }
  const result = await runOrExplain(code, sortInput(data, params, targetMs, start), req.scoreCode);
  return finishPreview(data, result, { label, sortId, sortVersion, start, targetMs });
}

async function runOrExplain(code: string, input: ReturnType<typeof sortInput>, scoreCode?: string) {
  try {
    return await runSort(code, input, scoreCode, { timeLimitMs: timeLimitMs(), bridge: sortBridge(input.channel.id) });
  } catch (err) {
    if (err instanceof SortError) throw new HttpError(422, err.message);
    throw err;
  }
}

function finishPreview(data: ChannelData, result: Awaited<ReturnType<typeof runSort>>,
  meta: { label: string; sortId: number | null; sortVersion: number | null; start: number; targetMs: number }) {
  const { lineup, durationMs } = toLineup(data, result.items);
  const preview: Preview = {
    id: randomUUID(),
    channelId: data.channelId,
    channelName: data.name,
    createdAt: Date.now(),
    scheduleStartMs: meta.start,
    targetMs: meta.targetMs,
    label: meta.label,
    sortId: meta.sortId,
    sortVersion: meta.sortVersion,
    items: result.items,
    lineup,
    durationMs,
  };
  remember(preview);
  const byId = new Map(data.pool.map(p => [p.id, p]));
  const metrics = scoreSchedule(result.items.map(i => ('id' in i ? byId.get(i.id) : { type: 'flex' })));
  return {
    previewId: preview.id,
    // A draft has no channel to load its episodes from, so send them along.
    pool: data.channelId === 'draft' ? data.pool : undefined,
    label: preview.label,
    sortId: preview.sortId,
    sortVersion: preview.sortVersion,
    items: result.items,
    durationMs,
    scheduleStartMs: meta.start,
    ms: result.ms,
    logs: result.logs,
    score: result.score,
    metrics,
    warnings: result.items.length ? [] : ['The sort returned an empty lineup.'],
  };
}

export interface RankRequest {
  channelId: string;
  entries: Array<{ sortId: number; sortVersion?: number }>;
  candidates: number;
  scoreCode: string;
  targetHours: number;
  scheduleStartMs: number;
}

/** Runs each sort several times (varying its seed setting, if it has one) and scores every result. */
export async function rankCandidates(req: RankRequest) {
  const { targetMs, start } = checkTiming(req.targetHours, req.scheduleStartMs);
  if (!Array.isArray(req.entries) || !req.entries.length) throw new HttpError(400, 'Pick at least one sort to compare.');
  if (!req.scoreCode || !/function\s+score\s*\(/.test(req.scoreCode)) throw new HttpError(400, 'The scoring code must define function score(ctx).');
  const n = Math.max(1, Math.min(30, Number(req.candidates) || 6));
  const data = await getChannelData(req.channelId);
  const jobs: Array<Promise<any>> = [];
  const notes: string[] = [];
  for (const entry of req.entries) {
    const r = resolveSort(req.channelId, Number(entry.sortId), entry.sortVersion ? Number(entry.sortVersion) : undefined);
    const name = getSort(Number(entry.sortId)).name;
    const hasSeed = r.settings.some(s => s.key === 'seed');
    if (!hasSeed && n > 1) notes.push(`${name} has no "seed" setting, so it ran once.`);
    const runs = hasSeed ? n : 1;
    for (let i = 0; i < runs; i++) {
      const params = { ...r.params };
      if (hasSeed) params.seed = (Number(r.params.seed) || 1) + i * 7919;
      const label = `${name} v${r.version}` + (hasSeed ? ` · seed ${params.seed}` : '');
      jobs.push(
        runSort(r.code, sortInput(data, params, targetMs, start), req.scoreCode, { timeLimitMs: timeLimitMs(), bridge: sortBridge(data.channelId) })
          .then(result => finishPreview(data, result, { label, sortId: Number(entry.sortId), sortVersion: r.version, start, targetMs }))
          .catch(err => ({ label, error: err instanceof Error ? err.message : String(err) })),
      );
    }
  }
  const results = await Promise.all(jobs);
  results.sort((a, b) => (a.error ? 1 : 0) - (b.error ? 1 : 0) || (b.score?.total ?? -Infinity) - (a.score?.total ?? -Infinity));
  return { candidates: results, notes };
}
