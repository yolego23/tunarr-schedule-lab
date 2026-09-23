// Channel Builder: everything a new channel needs in one go (basics, pool,
// look and feel, sort and settings), a preview before the channel exists,
// then create + save setup + apply. AI help is optional and only suggests.
import { tunarr } from './tunarr.ts';
import { HttpError, getSort, getVersion } from './sorts.ts';
import { createChannel } from './channel-admin.ts';
import { getChannelData } from './channel-data.ts';
import { getSetup, saveSetup } from './channels.ts';
import { applyPreview } from './apply.ts';
import { aiAvailable, ask } from './ai.ts';
import { cleanPool, type PoolDefinition, type PoolSource } from './pool.ts';
import { parseSettings } from './shared/sort-settings.js';

const STREAM_MODES = ['hls', 'hls_slower', 'mpegts', 'hls_direct', 'hls_direct_v2'];

export async function builderOptions() {
  const [channels, transcodeConfigs, fillerLists] = await Promise.all([
    tunarr.channels(), tunarr.transcodeConfigs().catch(() => []), tunarr.fillerLists().catch(() => []),
  ]);
  const counts = new Map<string, number>();
  for (const c of channels) if (c.groupTitle) counts.set(String(c.groupTitle), (counts.get(String(c.groupTitle)) || 0) + 1);
  return {
    channels: channels.sort((a, b) => a.number - b.number).map(c => ({ id: c.id, number: c.number, name: String(c.name).trim() })),
    groups: [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([name, count]) => ({ name, count })),
    transcodeConfigs: transcodeConfigs.map(t => ({ id: t.id, name: t.name, isDefault: !!t.isDefault })),
    fillerLists: fillerLists.map(f => ({ id: f.id, name: f.name })),
    streamModes: STREAM_MODES,
    ai: aiAvailable('builder'),
  };
}

export interface Look {
  iconUrl?: string;
  watermarkEnabled?: boolean;
  watermarkUrl?: string;
  watermarkPosition?: string;
  streamMode?: string;
  transcodeConfigId?: string;
  stealth?: boolean;
  guideFlexTitle?: string;
  fillerListIds?: string[];
}

/** Tunarr channel fields for a Look. */
function lookToChannel(look: Look | undefined): Record<string, unknown> {
  if (!look) return {};
  const out: Record<string, unknown> = {};
  if (look.iconUrl !== undefined) out.icon = { path: String(look.iconUrl).trim(), width: 0, duration: 0, position: 'bottom-right', useDefaultIconFallback: !look.iconUrl };
  if (look.watermarkEnabled !== undefined || look.watermarkUrl) {
    out.watermark = {
      enabled: !!look.watermarkEnabled, url: String(look.watermarkUrl || '').trim(),
      position: ['top-left', 'top-right', 'bottom-left', 'bottom-right'].includes(String(look.watermarkPosition)) ? look.watermarkPosition : 'bottom-right',
      width: 10, verticalMargin: 1, horizontalMargin: 1, duration: 0, fixedSize: false, animated: false, opacity: 100,
    };
  }
  if (look.streamMode) {
    if (!STREAM_MODES.includes(look.streamMode)) throw new HttpError(400, `Unknown stream mode "${look.streamMode}".`);
    out.streamMode = look.streamMode;
  }
  if (look.transcodeConfigId) out.transcodeConfigId = look.transcodeConfigId;
  if (look.stealth !== undefined) out.stealth = !!look.stealth;
  if (look.guideFlexTitle !== undefined) out.guideFlexTitle = String(look.guideFlexTitle);
  if (Array.isArray(look.fillerListIds)) out.fillerCollections = look.fillerListIds.map(id => ({ id, weight: 1, cooldownSeconds: 0 }));
  return out;
}

/**
 * Starting values from an existing channel: its look, its sort and settings,
 * and its pool (its pool sources, or the shows on its lineup as picked shows).
 */
export async function prefillFrom(channelId: string) {
  const [ch, data] = await Promise.all([tunarr.channel(channelId), getChannelData(channelId)]);
  const setup = getSetup(channelId);
  let pool: PoolDefinition = setup.pool;
  if (!pool.sources.length) {
    const sources: PoolSource[] = [];
    const seen = new Set<string>();
    for (const p of data.pool) {
      if (p.customShowId) {
        if (seen.has('c' + p.customShowId)) continue;
        seen.add('c' + p.customShowId);
        sources.push({ id: 'src-c-' + p.customShowId, kind: 'custom_show', ref: p.customShowId, label: `Custom show (${p.showTitle})`, weight: 1 });
      } else if (p.showId) {
        if (seen.has(p.showId)) continue;
        seen.add(p.showId);
        sources.push({ id: 'src-s-' + p.showId, kind: 'show', ref: p.showId, label: p.showTitle, weight: 1 });
      } else if (p.programType === 'movie') {
        sources.push({ id: 'src-m-' + p.id, kind: 'movie', ref: p.id, label: p.title + (p.year ? ` (${p.year})` : ''), weight: 1 });
      }
    }
    pool = { sources, exclusions: [] };
  }
  const icon = (ch.icon || {}) as Record<string, any>;
  const wm = (ch.watermark || {}) as Record<string, any>;
  return {
    basics: { name: `${String(ch.name).trim()} (copy)`, groupTitle: ch.groupTitle },
    look: {
      iconUrl: icon.path || '', watermarkEnabled: !!wm.enabled, watermarkUrl: wm.url || '', watermarkPosition: wm.position || 'bottom-right',
      streamMode: ch.streamMode, transcodeConfigId: ch.transcodeConfigId, stealth: !!ch.stealth, guideFlexTitle: ch.guideFlexTitle || '',
      fillerListIds: Array.isArray(ch.fillerCollections) ? (ch.fillerCollections as Array<{ id: string }>).map(f => f.id) : [],
    } as Look,
    pool,
    schedule: { sortId: setup.sortId, sortVersion: setup.sortVersion, values: setup.values, targetHours: setup.targetHours, alignStart: setup.alignStart },
  };
}

export interface CreateInput {
  basics: { name: unknown; number?: unknown; groupTitle?: unknown };
  look?: Look;
  pool: unknown;
  schedule: { sortId?: number | null; sortVersion?: number | null; values?: Record<string, unknown>; targetHours?: number; alignStart?: boolean };
  previewId?: string;
}

/** Creates the channel in Tunarr, saves its Schedule Lab setup, and applies the preview. */
export async function createFromBuilder(input: CreateInput) {
  const pool = cleanPool(input.pool);
  if (input.schedule?.sortId) getVersion(Number(input.schedule.sortId), Number(input.schedule.sortVersion || getSort(Number(input.schedule.sortId)).latest_version));
  const channel = await createChannel({ ...input.basics, look: lookToChannel(input.look) });
  const setup = saveSetup(channel.id, {
    sortId: input.schedule?.sortId ?? null,
    sortVersion: input.schedule?.sortVersion ?? null,
    values: input.schedule?.values ?? {},
    ...(input.schedule?.targetHours ? { targetHours: input.schedule.targetHours } : {}),
    ...(input.schedule?.alignStart !== undefined ? { alignStart: input.schedule.alignStart } : {}),
    pool,
  });
  let apply: unknown = null;
  let applyError: string | null = null;
  if (input.previewId) {
    try { apply = await applyPreview(channel.id, input.previewId, setup.alignStart, { adoptDraft: true }); }
    catch (err: any) { applyError = err?.message || String(err); }
  }
  return { channel, setup, apply, applyError };
}

// ---------- optional AI help ----------
function parseJson<T>(text: string, open: '{' | '['): T {
  const close = open === '{' ? '}' : ']';
  const start = text.indexOf(open), end = text.lastIndexOf(close);
  if (start < 0 || end <= start) throw new Error('The AI\'s answer had no usable list.');
  return JSON.parse(text.slice(start, end + 1)) as T;
}

const SYSTEM = 'You help set up channels for Tunarr, a live-TV channel server that plays a home media library. Answer only with the JSON asked for.';

/** Every show and movie in the library, compactly (for AI show suggestions). */
async function libraryCatalog() {
  const out: Array<{ id: string; type: string; title: string; year?: number; rating?: string; episodes?: number }> = [];
  for (let page = 0; page < 40; page++) {
    const r = await tunarr.searchPrograms({ query: { filter: { type: 'value', fieldSpec: { key: 'type', type: 'faceted_string', op: 'in', value: ['show', 'movie'] } } }, page, limit: 100 });
    for (const x of r.results || []) out.push({ id: x.uuid, type: x.type, title: x.title, year: x.year, rating: x.rating, episodes: x.grandchildCount });
    if (page + 1 >= (r.totalPages || 1)) break;
  }
  return out;
}

export async function builderAi(task: string, input: any) {
  if (!aiAvailable('builder')) throw new HttpError(400, 'AI isn\'t set up or is turned off for the Channel Builder (Settings → AI).');
  const description = String(input?.description || '').trim();
  if (!description) throw new HttpError(400, 'Describe the channel first.');

  if (task === 'basics') {
    const groups = (await tunarr.channels()).map(c => c.groupTitle).filter(Boolean);
    const r = await ask({
      feature: 'builder', system: SYSTEM, maxTokens: 2000,
      prompt: `A channel is described as: "${description}".\nExisting channel groups: ${[...new Set(groups)].join(', ') || '(none)'}.\nSuggest a short channel name and a group (reuse an existing group if one fits). Reply as {"name": "...", "group": "...", "reason": "..."}.`,
    });
    return parseJson<{ name: string; group: string; reason?: string }>(r.text, '{');
  }

  if (task === 'shows') {
    const catalog = await libraryCatalog();
    const max = Math.min(Math.max(Number(input?.max) || 12, 1), 40);
    const lines = catalog.map((c, i) => `${i}\t${c.type}\t${c.title}${c.year ? ` (${c.year})` : ''}${c.rating ? `\t${c.rating}` : ''}`).join('\n');
    const r = await ask({
      feature: 'builder', system: SYSTEM, maxTokens: 4000,
      prompt: `A channel is described as: "${description}".\nHere is the whole library (index, type, title, rating):\n${lines}\n\nPick up to ${max} shows or movies from this list that fit the channel best. Only use items from the list. Reply as a JSON array: [{"index": 0, "reason": "one short sentence"}].`,
    });
    const picks = parseJson<Array<{ index: number; reason?: string }>>(r.text, '[');
    const seen = new Set<number>();
    return picks
      .filter(p => Number.isInteger(p.index) && catalog[p.index] && !seen.has(p.index) && seen.add(p.index))
      .slice(0, max)
      .map(p => ({ ...catalog[p.index], reason: String(p.reason || '') }));
  }

  if (task === 'settings') {
    const sortId = Number(input?.sortId);
    const v = getVersion(sortId, Number(input?.sortVersion) || getSort(sortId).latest_version);
    const { settings } = parseSettings(v.code);
    const usable = settings.filter(s => s.type !== 'secret' && s.type !== 'filler list');
    if (!usable.length) throw new HttpError(400, 'This sort has no settings the AI can suggest.');
    const decl = usable.map(s => `${s.key} (${s.type}${s.options ? ': ' + s.options.join('|') : ''}; default ${JSON.stringify(s.default)}): ${s.label}`).join('\n');
    const r = await ask({
      feature: 'builder', system: SYSTEM, maxTokens: 2000,
      prompt: `A channel is described as: "${description}".\nIts scheduling sort has these settings:\n${decl}\n\nWeekly hours are written like "Mon-Fri 08:00-16:30; Daily 22:30-06:00". Suggest values that suit the channel; leave out settings where the default is fine. Reply as {"values": {"key": value}, "reason": "one or two sentences"}.`,
    });
    const out = parseJson<{ values?: Record<string, unknown>; reason?: string }>(r.text, '{');
    const allowed = new Set(usable.map(s => s.key));
    return { values: Object.fromEntries(Object.entries(out.values || {}).filter(([k]) => allowed.has(k))), reason: out.reason || '' };
  }

  throw new HttpError(404, `Unknown builder AI task "${task}".`);
}
