// Pool sources: a channel's episode pool, defined in Schedule Lab as picked
// shows, seasons, movies, episodes, custom shows and library rules, minus
// exclusions. Read from the library each time a lineup is built, so new
// episodes (and new shows matching a rule) join on their own.
//
// Each episode carries `weight` (the highest weight of the sources that
// include it) and `sources` (their labels). Sorts decide how to use them.
import { randomUUID } from 'node:crypto';
import { tunarr } from './tunarr.ts';
import { HttpError } from './sorts.ts';
import { normalizeProgram, type PoolItem } from './channel-data.ts';

export type SourceKind = 'show' | 'season' | 'movie' | 'episode' | 'custom_show' | 'smart_collection' | 'rule';

export interface PoolRule {
  text?: string;
  types?: Array<'show' | 'movie'>;
  networks?: string[];
  genres?: string[];
  ratings?: string[];
  tags?: string[];
  libraries?: string[];
  yearFrom?: number;
  yearTo?: number;
  addedWithinDays?: number;
}

export interface PoolSource {
  id: string;
  kind: SourceKind;
  /** The Tunarr id of the show, season, movie, episode or custom show. */
  ref?: string;
  rule?: PoolRule;
  label: string;
  weight: number;
}

export interface PoolExclusion {
  kind: 'show' | 'season' | 'item';
  id: string;
  label: string;
}

export interface PoolDefinition {
  sources: PoolSource[];
  exclusions: PoolExclusion[];
}

export const EMPTY_POOL: PoolDefinition = { sources: [], exclusions: [] };

const KINDS: SourceKind[] = ['show', 'season', 'movie', 'episode', 'custom_show', 'smart_collection', 'rule'];

/** Checks and cleans a pool definition from the browser. */
export function cleanPool(input: any): PoolDefinition {
  const sources: PoolSource[] = [];
  for (const s of Array.isArray(input?.sources) ? input.sources : []) {
    if (!KINDS.includes(s?.kind)) throw new HttpError(400, `Unknown pool source kind "${s?.kind}".`);
    const weight = s.weight === undefined || s.weight === '' ? 1 : Number(s.weight);
    if (!Number.isFinite(weight) || weight < 0 || weight > 100) throw new HttpError(400, 'Weights must be between 0 and 100.');
    const src: PoolSource = { id: String(s.id || randomUUID()), kind: s.kind, label: String(s.label || s.kind).slice(0, 200), weight };
    if (s.kind === 'rule') src.rule = cleanRule(s.rule);
    else {
      if (!s.ref) throw new HttpError(400, `The ${s.kind} source "${src.label}" has no id.`);
      src.ref = String(s.ref);
    }
    sources.push(src);
  }
  const exclusions: PoolExclusion[] = [];
  for (const e of Array.isArray(input?.exclusions) ? input.exclusions : []) {
    if (!['show', 'season', 'item'].includes(e?.kind) || !e.id) throw new HttpError(400, 'Bad exclusion.');
    exclusions.push({ kind: e.kind, id: String(e.id), label: String(e.label || e.id).slice(0, 200) });
  }
  return { sources, exclusions };
}

export function cleanRule(r: any): PoolRule {
  const list = (v: unknown) => (Array.isArray(v) ? v.map(x => String(x).trim()).filter(Boolean).slice(0, 100) : undefined);
  const num = (v: unknown) => (v === undefined || v === null || v === '' ? undefined : Number(v));
  const rule: PoolRule = {
    text: r?.text ? String(r.text).trim().slice(0, 200) : undefined,
    types: (list(r?.types) as PoolRule['types'])?.filter(t => t === 'show' || t === 'movie'),
    networks: list(r?.networks), genres: list(r?.genres), ratings: list(r?.ratings), tags: list(r?.tags), libraries: list(r?.libraries),
    yearFrom: num(r?.yearFrom), yearTo: num(r?.yearTo), addedWithinDays: num(r?.addedWithinDays),
  };
  for (const k of ['yearFrom', 'yearTo', 'addedWithinDays'] as const) {
    if (rule[k] !== undefined && !(Number.isFinite(rule[k]) && rule[k]! >= 0)) throw new HttpError(400, `Rule: ${k} must be a positive number.`);
  }
  const hasCondition = rule.text || rule.networks?.length || rule.genres?.length || rule.ratings?.length || rule.tags?.length
    || rule.libraries?.length || rule.yearFrom || rule.yearTo || rule.addedWithinDays;
  if (!hasCondition) throw new HttpError(400, 'A rule needs at least one condition (for example a network or a genre).');
  return rule;
}

// ---------- library search ----------
/**
 * Tunarr 1.3.15 numbers search pages from 0 when browsing by filter only,
 * but from 1 when there is search text. `page` here always starts at 1.
 */
const tunarrPage = (page: number, hasText: boolean) => (hasText ? page : page - 1);

const fs = (key: string, type: string, op: string, value: unknown) => ({ type: 'value', fieldSpec: { key, type, op, value } });

/** Turns a rule into Tunarr's search filter. */
export function ruleToFilter(rule: PoolRule, now = Date.now()) {
  const children: unknown[] = [fs('type', 'faceted_string', 'in', rule.types?.length ? rule.types : ['show'])];
  if (rule.networks?.length) children.push(fs('studio.name', 'faceted_string', 'in', rule.networks));
  if (rule.genres?.length) children.push(fs('genres.name', 'faceted_string', 'in', rule.genres));
  if (rule.ratings?.length) children.push(fs('rating', 'faceted_string', 'in', rule.ratings));
  if (rule.tags?.length) children.push(fs('tags', 'faceted_string', 'in', rule.tags));
  if (rule.libraries?.length) children.push(fs('libraryId', 'faceted_string', 'in', rule.libraries));
  if (rule.yearFrom || rule.yearTo) children.push(fs('originalReleaseYear', 'numeric', 'to', [rule.yearFrom || 0, rule.yearTo || 9999]));
  if (rule.addedWithinDays) children.push(fs('addedAt', 'numeric', '>=', now - rule.addedWithinDays * 86_400_000));
  return { type: 'op', op: 'and', children };
}

export interface LibraryHit {
  id: string;
  type: string;
  title: string;
  year?: number;
  rating?: string;
  episodes?: number;
  seasons?: number;
  libraryId?: string;
  durationMs?: number;
  showTitle?: string;
  summary?: string;
}

function toHit(r: Record<string, any>): LibraryHit {
  return {
    id: r.uuid, type: r.type, title: r.title, year: r.year, rating: r.rating,
    episodes: r.grandchildCount, seasons: r.childCount, libraryId: r.libraryId,
    durationMs: r.duration, summary: typeof r.summary === 'string' ? r.summary.slice(0, 300) : undefined,
  };
}

/** One page of library search, for browsing. */
export async function searchLibrary(opts: { text?: string; types?: string[]; libraryId?: string; page?: number; rule?: PoolRule }) {
  const filter = opts.rule
    ? ruleToFilter(cleanRule(opts.rule))
    : { type: 'op', op: 'and', children: [
        fs('type', 'faceted_string', 'in', opts.types?.length ? opts.types : ['show', 'movie']),
        ...(opts.libraryId ? [fs('libraryId', 'faceted_string', 'in', [opts.libraryId])] : []),
      ] };
  const text = opts.rule?.text || opts.text;
  const page = Math.max(1, Number(opts.page) || 1);
  const r = await tunarr.searchPrograms({ query: { ...(text ? { query: text } : {}), filter }, page: tunarrPage(page, !!text), limit: 50 });
  return { hits: (r.results || []).map(toHit), page, totalPages: r.totalPages, totalHits: r.totalHits };
}

/** Every show or movie a rule matches (all pages). */
export async function ruleMatches(rule: PoolRule): Promise<LibraryHit[]> {
  const out: LibraryHit[] = [];
  for (let page = 1; page <= 40; page++) {
    const r = await tunarr.searchPrograms({ query: { ...(rule.text ? { query: rule.text } : {}), filter: ruleToFilter(rule) }, page: tunarrPage(page, !!rule.text), limit: 100 });
    out.push(...(r.results || []).map(toHit));
    if (page >= (r.totalPages || 1)) break;
  }
  return out;
}

/** Values to pick from in the rule builder. */
export async function ruleOptions() {
  const facet = async (field: string) => {
    try { return Object.entries((await tunarr.facetValues(field)).facetValues || {}).sort((a, b) => b[1] - a[1]).map(([value, count]) => ({ value, count })); }
    catch { return []; }
  };
  const [networks, genres, ratings, sources, customShows, smartCollections] = await Promise.all([
    facet('studio.name'), facet('grandparent.genres'), facet('rating'), tunarr.mediaSources().catch(() => []), tunarr.customShows().catch(() => []),
    tunarr.smartCollections().catch(() => []),
  ]);
  const libraries = sources.flatMap(s => (s.libraries || []).filter(l => l.mediaType !== 'tracks').map(l => ({ id: l.id, name: l.name, type: l.mediaType, source: s.name })));
  return { networks, genres, ratings, libraries, customShows: customShows.map(c => ({ id: c.id, name: c.name, count: c.contentCount, durationMs: c.totalDuration })),
    smartCollections: smartCollections.map(c => ({ id: c.uuid, name: c.name })) };
}

// ---------- resolving a pool into episodes ----------
const CACHE_MS = 10 * 60_000;
const cache = new Map<string, { at: number; value: Promise<PoolItem[]> }>();

function cached(key: string, load: () => Promise<PoolItem[]>): Promise<PoolItem[]> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = load().catch(err => { cache.delete(key); throw err; });
  cache.set(key, { at: Date.now(), value });
  return value;
}

export function forgetPoolCache() {
  cache.clear();
}

async function episodesUnder(id: string): Promise<PoolItem[]> {
  return cached(`d:${id}`, async () => {
    const rows = await tunarr.descendants(id);
    return rows.filter(r => r.type === 'content' && r.id).map(r => normalizeProgram(r.id, r));
  });
}

async function customShowItems(id: string): Promise<PoolItem[]> {
  return cached(`c:${id}`, async () => {
    const rows = await tunarr.customShowPrograms(id);
    return rows.filter(r => r.id).map(r => {
      // Custom show entries wrap the content entry one level deeper.
      const inner = r.program?.program ? r.program.program : r.program;
      return normalizeProgram(String(r.id), { type: 'custom', duration: Number(r.duration) || 0, program: inner, customShowId: r.customShowId, index: r.index });
    });
  });
}

/** Runs `fn` over items with at most `n` at a time. */
async function mapLimit<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
  }));
  return out;
}

/** Everything a Tunarr smart collection (a saved search) matches today. */
async function smartCollectionMatches(id: string): Promise<LibraryHit[]> {
  const sc = await tunarr.smartCollection(id);
  const text = (sc.keywords || '').trim();
  const out: LibraryHit[] = [];
  for (let page = 1; page <= 40; page++) {
    const r = await tunarr.searchPrograms({ query: { ...(text ? { query: text } : {}), ...(sc.filter ? { filter: sc.filter } : {}) }, page: tunarrPage(page, !!text), limit: 100 });
    out.push(...(r.results || []).map(toHit));
    if (page >= (r.totalPages || 1)) break;
  }
  return out;
}

export interface ResolvedPool {
  items: Array<PoolItem & { weight: number; sources: string[] }>;
  sources: Array<{ id: string; label: string; kind: SourceKind; shows: number; episodes: number; durationMs: number; matches?: LibraryHit[]; error?: string }>;
  excluded: number;
  durationMs: number;
}

export async function resolvePool(def: PoolDefinition): Promise<ResolvedPool> {
  const byId = new Map<string, PoolItem & { weight: number; sources: string[] }>();
  const summaries: ResolvedPool['sources'] = [];
  for (const src of def.sources) {
    let items: PoolItem[] = [];
    let matches: LibraryHit[] | undefined;
    let error: string | undefined;
    try {
      if (src.kind === 'custom_show') items = await customShowItems(src.ref!);
      else if (src.kind === 'smart_collection') {
        matches = await smartCollectionMatches(src.ref!);
        items = (await mapLimit(matches, 4, m => episodesUnder(m.id))).flat();
      }
      else if (src.kind === 'rule') {
        matches = await ruleMatches(src.rule!);
        items = (await mapLimit(matches, 4, m => episodesUnder(m.id))).flat();
      } else items = await episodesUnder(src.ref!);
    } catch (err: any) {
      error = err?.message || String(err);
    }
    const shows = new Set(items.map(i => i.showId || i.showTitle)).size;
    summaries.push({
      id: src.id, label: src.label, kind: src.kind, shows, episodes: items.length,
      durationMs: items.reduce((a, b) => a + b.durationMs, 0), matches: matches?.map(m => ({ id: m.id, type: m.type, title: m.title, year: m.year })), error,
    });
    for (const it of items) {
      const have = byId.get(it.id);
      if (have) {
        have.weight = Math.max(have.weight, src.weight);
        if (!have.sources.includes(src.label)) have.sources.push(src.label);
      } else byId.set(it.id, { ...it, weight: src.weight, sources: [src.label] });
    }
  }
  const exShows = new Set(def.exclusions.filter(e => e.kind === 'show').map(e => e.id));
  const exSeasons = new Set(def.exclusions.filter(e => e.kind === 'season').map(e => e.id));
  const exItems = new Set(def.exclusions.filter(e => e.kind === 'item').map(e => e.id));
  let excluded = 0;
  const items = [...byId.values()].filter(i => {
    const out = (i.showId && exShows.has(i.showId)) || (i.seasonId && exSeasons.has(i.seasonId)) || exItems.has(i.id);
    if (out) excluded++;
    return !out;
  });
  return { items, sources: summaries, excluded, durationMs: items.reduce((a, b) => a + b.durationMs, 0) };
}
