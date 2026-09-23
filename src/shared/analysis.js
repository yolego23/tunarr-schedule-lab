// Schedule helpers shared by the server, the browser and the sort sandbox
// (where this file is loaded as a plain script). No imports.

/** Seeded random numbers in [0, 1). Same generator as 1.8, so seeds give the same lineups. */
export function makeRng(seed) {
  let a = seed >>> 0 || 1;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle(arr, rng) {
  const r = rng || Math.random;
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const isFlex = item => item && item.type === 'flex';

export function scoreSchedule(list) {
  let maxStreak = 1, streak = 1;
  const shows = new Set();
  let prev = null;
  for (const item of list) {
    if (isFlex(item)) continue;
    shows.add(item.showTitle);
    if (prev && item.showTitle === prev.showTitle) { streak++; maxStreak = Math.max(maxStreak, streak); }
    else streak = 1;
    prev = item;
  }
  return { maxConsecutiveSameShow: list.length ? maxStreak : 0, distinctShows: shows.size, count: list.length };
}

const clockOf = ms => { const d = new Date(ms); return d.getHours() * 60 + d.getMinutes(); };

/**
 * Walks a lineup in order and records, for each airing of an episode, how
 * long since it last aired and how far its time of day moved (local time).
 * Returns { annotated, summary } where summary lists repeating episodes,
 * worst first (closest time of day, then shortest gap).
 */
export function analyzeRepeats(list, startMs) {
  const start = Number.isFinite(startMs) ? startMs : Date.now();
  const lastByKey = new Map();
  const summaryByKey = new Map();
  let elapsed = 0;
  const annotated = list.map(item => {
    const at = start + elapsed;
    elapsed += item.durationMs || 0;
    if (isFlex(item)) return { ...item, _startMs: at };
    const key = item.id;
    const clockMin = clockOf(at);
    const prev = lastByKey.get(key);
    let gapMs = null, clockDeltaMin = null, occurrence = 1;
    if (prev) {
      gapMs = at - prev.at;
      const diff = Math.abs(clockMin - prev.clockMin);
      clockDeltaMin = Math.min(diff, 1440 - diff);
      occurrence = prev.occurrence + 1;
    }
    lastByKey.set(key, { at, clockMin, occurrence });
    if (!summaryByKey.has(key)) {
      summaryByKey.set(key, { id: key, title: item.title, showTitle: item.showTitle, episodeLabel: item.episodeLabel, count: 0, gaps: [], clockDeltas: [] });
    }
    const s = summaryByKey.get(key);
    s.count++;
    if (gapMs !== null) s.gaps.push(gapMs);
    if (clockDeltaMin !== null) s.clockDeltas.push(clockDeltaMin);
    return { ...item, _startMs: at, _occurrence: occurrence, _gapMs: gapMs, _clockDeltaMin: clockDeltaMin };
  });
  const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  const summary = [...summaryByKey.values()]
    .filter(s => s.gaps.length)
    .map(s => ({
      id: s.id, title: s.title, showTitle: s.showTitle, episodeLabel: s.episodeLabel, count: s.count,
      avgGapMs: mean(s.gaps), minGapMs: Math.min(...s.gaps),
      avgClockDeltaMin: mean(s.clockDeltas), minClockDeltaMin: Math.min(...s.clockDeltas),
    }))
    .sort((a, b) => (a.minClockDeltaMin - b.minClockDeltaMin) || (a.minGapMs - b.minGapMs));
  return { annotated, summary };
}

/**
 * For each repeat airing, how many of its two neighbours match the previous
 * airing's neighbours (0, 1 or 2). 2 = the exact same "sandwich" as before.
 */
export function computeNeighborOverlaps(list) {
  const items = list.filter(i => !isFlex(i));
  const positions = new Map();
  items.forEach((item, idx) => {
    if (!positions.has(item.id)) positions.set(item.id, []);
    positions.get(item.id).push(idx);
  });
  const overlaps = [];
  const idAt = i => (items[i] ? items[i].id : undefined);
  positions.forEach(idxs => {
    for (let k = 1; k < idxs.length; k++) {
      const prev = new Set([idAt(idxs[k - 1] - 1), idAt(idxs[k - 1] + 1)].filter(v => v !== undefined));
      const cur = [idAt(idxs[k] - 1), idAt(idxs[k] + 1)].filter(v => v !== undefined);
      overlaps.push(cur.filter(n => prev.has(n)).length);
    }
  });
  return overlaps;
}

export const DEFAULT_SCORE_CODE = `// Scores ONE candidate schedule. Higher = better.
// ctx.list             the full ordered schedule
// ctx.repeatSummary    per-episode repeat stats (only episodes that repeat):
//                      [{ id, title, showTitle, count, avgGapMs, minGapMs,
//                         avgClockDeltaMin, minClockDeltaMin }, ...]
// ctx.neighborOverlaps for each repeat, how many of its two neighbours match
//                      the last time it aired (0, 1 or 2)
// ctx.targetHours      the schedule length this candidate was built for
//
// Must return { total: number, breakdown: { label: value, ... } }
function score(ctx){
  const { repeatSummary, neighborOverlaps, targetHours } = ctx;

  if (!repeatSummary.length) {
    // Nothing repeats at all within this window: best possible outcome.
    return { total: 1000, breakdown: {
      'avg gap (h)': targetHours, 'avg time-of-day Δ (m)': 720,
      'avg closest Δ (m)': 720, 'worst Δ (m)': 720, 'avg neighbor overlap': 0,
    } };
  }

  const avgGapHours = repeatSummary.reduce((a,s)=>a+s.avgGapMs,0) / repeatSummary.length / 3600000;
  const avgClockDeltaMin = repeatSummary.reduce((a,s)=>a+s.avgClockDeltaMin,0) / repeatSummary.length;
  // Each episode's own nearest repeat to the same time of day, averaged.
  const avgMinClockDeltaMin = repeatSummary.reduce((a,s)=>a+s.minClockDeltaMin,0) / repeatSummary.length;
  // The single worst offender in the whole candidate.
  const worstClockDeltaMin = Math.min(...repeatSummary.map(s=>s.minClockDeltaMin));
  const avgNeighborOverlap = neighborOverlaps.length
    ? neighborOverlaps.reduce((a,b)=>a+b,0) / neighborOverlaps.length
    : 0;

  // Weights are starting points; tune freely.
  const total =
    (avgGapHours * 1) +
    (avgClockDeltaMin / 60 * 2) +
    (avgMinClockDeltaMin / 60 * 2) +
    (worstClockDeltaMin / 60 * 3) -
    (avgNeighborOverlap * 10);

  return {
    total,
    breakdown: {
      'avg gap (h)': avgGapHours.toFixed(1),
      'avg time-of-day Δ (m)': Math.round(avgClockDeltaMin),
      'avg closest Δ (m)': Math.round(avgMinClockDeltaMin),
      'worst Δ (m)': Math.round(worstClockDeltaMin),
      'avg neighbor overlap': avgNeighborOverlap.toFixed(2),
      'episodes that repeat': repeatSummary.length,
    },
  };
}`;
