// The 1.8 sorts, loaded into the library by the Import button as ordinary
// entries the user can edit or delete. Nothing in the app depends on them.

export interface PresetSort {
  name: string;
  description: string;
  code: string;
}

const shuffle = `/* @settings
repeatWindowHours: number = 48   // Repeat window (hours)
seed: number = 1                 // Random seed
*/
// Shuffles the pool and fills the target duration while trying not to
// repeat the same episode within "repeatWindowHours" of itself.
function run(ctx){
  const { pool, params, targetMs, utils } = ctx;
  const windowMs = (params.repeatWindowHours || 48) * 3600000;
  const rng = utils.makeRng(Number(params.seed) || 1);

  let remaining = utils.shuffle(pool, rng);
  let cursor = 0;
  let elapsed = 0;
  const lastPlayed = new Map();
  const result = [];
  let guard = 0;
  const guardMax = pool.length * 50 + 2000;

  while (elapsed < targetMs && guard < guardMax) {
    guard++;
    if (cursor >= remaining.length) {
      remaining = utils.shuffle(pool, rng);
      cursor = 0;
    }
    const item = remaining[cursor];
    const key = item.showTitle + '::' + item.title;
    const last = lastPlayed.get(key);
    if (last !== undefined && (elapsed - last) < windowMs) {
      cursor++;
      continue;
    }
    result.push(item);
    lastPlayed.set(key, elapsed);
    elapsed += item.durationMs || 0;
    cursor++;
  }
  return result;
}
`;

const fullCycle = `/* @settings
order: choice(as-listed, shuffle, by-season-episode) = as-listed   // Cycle order
seed: number = 1                                                  // Random seed (only used by "shuffle")
*/
// Guarantees that EVERY item in the pool plays exactly once before
// anything plays a second time: no time-window math, no probability,
// just a strict cycle. Once the full pool has played through, a new
// cycle starts (re-shuffled if order = "shuffle").
function run(ctx){
  const { pool, params, targetMs, utils } = ctx;
  const order = (params.order || 'as-listed').trim();
  const rng = utils.makeRng(Number(params.seed) || 1);

  function buildCycle(){
    if (order === 'shuffle') return utils.shuffle(pool, rng);
    if (order === 'by-season-episode') {
      return [...pool].sort((a, b) =>
        (a.showTitle || '').localeCompare(b.showTitle || '') ||
        (a.seasonNumber || 0) - (b.seasonNumber || 0) ||
        (a.episodeNumber || 0) - (b.episodeNumber || 0)
      );
    }
    return [...pool]; // as-listed: whatever order Tunarr gave us
  }

  let queue = buildCycle();
  let cursor = 0;
  let elapsed = 0;
  const result = [];

  while (elapsed < targetMs && pool.length) {
    if (cursor >= queue.length) {
      queue = buildCycle(); // pool exhausted: start a fresh cycle
      cursor = 0;
    }
    const item = queue[cursor];
    result.push(item);
    elapsed += item.durationMs || 0;
    cursor++;
  }
  return result;
}
`;

const timeBlock = `/* @settings
blockStartHour: number = 7   // Block start hour (0-23)
blockEndHour: number = 8     // Block end hour (0-23)
*/
// Keeps the existing lineup mostly intact. Any pool item NOT already in
// the current lineup is treated as "new" and gets slotted into the next
// occurrence of the daily time block, pushing the rest of the schedule
// later. Outside the block, the original lineup repeats.
// (2.0: the block now uses the real clock time from the schedule start;
// 1.8 counted hours from the start of the lineup.)
function run(ctx){
  const { pool, current, params, targetMs } = ctx;
  const blockStartMin = (Number(params.blockStartHour)||0) * 60;
  const blockEndMin = (Number(params.blockEndHour)||0) * 60;
  const currentIds = new Set(current.map(i=>i.id));
  const newQueue = pool.filter(p=>!currentIds.has(p.id));
  const base = current.length ? current : pool;
  const start = ctx.scheduleStartMs;

  const result = [];
  let elapsed = 0;
  let i = 0;
  let guard = 0;
  const guardMax = (base.length + newQueue.length) * 50 + 2000;

  while (elapsed < targetMs && guard < guardMax) {
    guard++;
    const clock = new Date(start + elapsed);
    const minuteOfDay = clock.getHours() * 60 + clock.getMinutes();
    const inBlock = minuteOfDay >= blockStartMin && minuteOfDay < blockEndMin;
    if (inBlock && newQueue.length) {
      const item = newQueue.shift();
      result.push(item);
      elapsed += item.durationMs || 0;
      continue;
    }
    const item = base[i % base.length];
    result.push(item);
    elapsed += item.durationMs || 0;
    i++;
  }
  return result;
}
`;

const aiOptimizer = `/* @settings
candidateCount: number = 5         // Candidates to generate
repeatWindowHours: number = 48     // Repeat window (hours)
criteria: text = Maximize variety, avoid back-to-back episodes of the same show, prefer spreading shows evenly across the schedule.   // Scoring criteria
apiKey: secret =                   // Anthropic API key (blank = local heuristic)
model: text = claude-opus-5        // Claude model
*/
// Generates several candidate no-repeat shuffles, then either:
//  - asks Claude to pick the best one (if an API key is set), or
//  - falls back to a local heuristic (fewest back-to-back repeats, most
//    distinct shows).
// The Claude call goes through ctx.utils.claude, which the server makes on
// the sort's behalf; the key never leaves this app except to Anthropic.
async function run(ctx){
  const { pool, params, targetMs, utils } = ctx;
  const n = Math.max(1, Number(params.candidateCount) || 5);
  const windowMs = (Number(params.repeatWindowHours) || 48) * 3600000;

  function shuffleOnce(seed){
    const rng = utils.makeRng(seed);
    let remaining = utils.shuffle(pool, rng);
    let cursor = 0, elapsed = 0;
    const lastPlayed = new Map();
    const result = [];
    let guard = 0;
    const guardMax = pool.length * 50 + 2000;
    while (elapsed < targetMs && guard < guardMax) {
      guard++;
      if (cursor >= remaining.length) { remaining = utils.shuffle(pool, rng); cursor = 0; }
      const item = remaining[cursor];
      const key = item.showTitle + '::' + item.title;
      const last = lastPlayed.get(key);
      if (last !== undefined && (elapsed - last) < windowMs) { cursor++; continue; }
      result.push(item);
      lastPlayed.set(key, elapsed);
      elapsed += item.durationMs || 0;
      cursor++;
    }
    return result;
  }

  const candidates = [];
  for (let s = 0; s < n; s++) candidates.push(shuffleOnce(1000 + s * 7919));
  const scored = candidates.map(list => ({ list, metrics: utils.scoreSchedule(list) }));

  if (params.apiKey && params.apiKey.trim()) {
    const summary = scored.map((c, idx) =>
      \`Candidate \${idx}: maxConsecutiveSameShow=\${c.metrics.maxConsecutiveSameShow}, distinctShows=\${c.metrics.distinctShows}, sequence=\${c.list.slice(0,25).map(i=>i.showTitle).join(' > ')}\`
    ).join('\\n');
    const prompt = \`You are picking the best TV channel schedule ordering out of several candidates.
Criteria: \${params.criteria}

\${summary}

Respond with ONLY a JSON object like {"index": 0} naming the best candidate index. No other text.\`;
    try {
      const text = await utils.claude({ apiKey: params.apiKey, model: params.model, prompt, maxTokens: 2000 });
      const match = text.match(/\\{[^}]*\\}/);
      const idx = match ? (JSON.parse(match[0]).index ?? 0) : 0;
      console.log('Claude picked candidate', idx);
      return scored[Math.min(Math.max(0, idx), scored.length - 1)].list;
    } catch (e) {
      console.warn('AI scoring failed, using the local heuristic:', e.message);
    }
  }

  scored.sort((a, b) =>
    (a.metrics.maxConsecutiveSameShow - b.metrics.maxConsecutiveSameShow) ||
    (b.metrics.distinctShows - a.metrics.distinctShows)
  );
  return scored[0].list;
}
`;

const workSchedule = `/* @settings
workHours: weekly hours = Mon,Tue,Thu,Fri 08:00-16:30; Sat 07:00-15:30   // Work hours
bufferMin: number = 0              // Minutes "away" before and after each work block (commute)
sleepHours: weekly hours = Daily 22:30-06:00   // Sleep hours (treated like work: nobody's watching)
repeatWindowHours: number = 72     // Don't repeat an episode within this many hours if avoidable
clockWindowMin: number = 120       // Penalize a repeat within this many minutes of the same time of day
showGapMin: number = 90            // Minutes before the same show may play again without penalty
seed: number = 1                   // Random seed
*/
// WORK-SCHEDULE-AWARE SORT
// Walks the schedule from "Schedule start" and picks the next episode by
// scoring every candidate (lowest cost wins):
//
//  • WATCH TIME (when you're not at work or asleep): strongly prefers
//    episodes you haven't had a chance to see yet, so fresh episodes land
//    when you're home and repeats are pushed as late as possible.
//  • AWAY TIME: prefers episodes that already aired during watch time
//    (reruns nobody is watching) so fresh ones are saved for when you're home.
//  • Anywhere: penalizes the same episode airing again within the repeat
//    window, airing again near the same time of day it last aired, and the
//    same show playing back-to-back / too close together.
function run(ctx){
  const P = ctx.params;
  const { pool, targetMs, utils } = ctx;
  if (!pool || !pool.length) return [];
  const rng = utils.makeRng(Number(P.seed) || 1);
  const start = ctx.scheduleStartMs;
  const MIN = 60000, HOUR = 3600000;
  const DEFAULT_DUR = 30 * MIN;

  // Weights (bigger = the algorithm cares more)
  const W = {
    freshInWatch: 1000,  // per previous watch-time airing, scaled by how much of the slot is watch time
    saveFresh:    400,   // cost of "spending" an unseen episode while away
    recentRepeat: 600,   // repeat inside repeatWindowHours (scaled by how recent)
    sameClock:    300,   // repeat near the same time of day (scaled by closeness)
    backToBack:   250,   // same show as the previous item
    showTooSoon:  80,    // same show within showGapMin
    staleBonus:   50,    // slight preference for whatever has waited longest
    jitter:       15,    // randomness so different seeds give different lineups
  };

  // Away = work hours (widened by the buffer) plus sleep hours.
  const away = utils.hours([{ hours: P.workHours, padMinutes: Number(P.bufferMin) || 0 }, P.sleepHours]);
  const awayMs = (a, b) => away.msInside(a, b);
  const clockOf = ms => { const d = new Date(ms); return d.getHours()*60 + d.getMinutes(); };

  // ---------- state ----------
  const keyOf = it => it.id;
  const watchPlays = new Map();   // times aired during watch time
  const lastPlay = new Map();     // last airing time (ms)
  const clocks = new Map();       // previous time-of-day airings (minutes)
  const showLast = new Map();     // last time each show aired (ms)

  // Big libraries: score a random sample each slot to keep it fast.
  const SAMPLE = 600;
  const result = [];
  let t = start, prevShow = null;
  const end = start + targetMs;

  while (t < end) {
    const cands = pool.length > SAMPLE ? utils.shuffle(pool, rng).slice(0, SAMPLE) : pool;
    let best = null, bestCost = Infinity;

    for (const it of cands) {
      const k = keyOf(it);
      const dur = it.durationMs || DEFAULT_DUR;
      const watchFrac = 1 - awayMs(t, t + dur) / dur;
      const wp = watchPlays.get(k) || 0;
      let cost = 0;

      // Fresh episodes for watch time; burn reruns while away.
      cost += watchFrac * wp * W.freshInWatch;
      if (wp === 0) cost += (1 - watchFrac) * W.saveFresh;

      // Recent repeat penalty
      const lp = lastPlay.get(k);
      const windowMs = Number(P.repeatWindowHours) * HOUR;
      if (lp !== undefined) {
        const since = t - lp;
        if (since < windowMs) cost += W.recentRepeat * (1 - since / windowMs);
        cost -= W.staleBonus * Math.min(1, since / (windowMs * 3));
      } else {
        cost -= W.staleBonus;
      }

      // Same time-of-day penalty (matters most when you're watching)
      const cw = Number(P.clockWindowMin) || 0;
      if (cw > 0 && clocks.has(k)) {
        const now = clockOf(t);
        for (const c of clocks.get(k)) {
          const diff = Math.abs(now - c), delta = Math.min(diff, 1440 - diff);
          if (delta < cw) cost += W.sameClock * (1 - delta / cw) * (0.3 + 0.7 * watchFrac);
        }
      }

      // Show spacing
      if (it.showTitle === prevShow) cost += W.backToBack;
      const sl = showLast.get(it.showTitle);
      if (sl !== undefined && t - sl < P.showGapMin * MIN) cost += W.showTooSoon * (1 - (t - sl) / (P.showGapMin * MIN));

      cost += rng() * W.jitter;
      if (cost < bestCost) { bestCost = cost; best = it; }
    }

    const k = keyOf(best);
    const dur = best.durationMs || DEFAULT_DUR;
    const watchFrac = 1 - awayMs(t, t + dur) / dur;
    if (watchFrac >= 0.5) watchPlays.set(k, (watchPlays.get(k) || 0) + 1);
    lastPlay.set(k, t);
    if (!clocks.has(k)) clocks.set(k, []);
    const cl = clocks.get(k); cl.push(clockOf(t)); if (cl.length > 6) cl.shift();
    showLast.set(best.showTitle, t);
    prevShow = best.showTitle;

    result.push(best);
    t += dur;
  }
  return result;
}
`;

export const PRESET_SORTS: PresetSort[] = [
  { name: 'No-repeat shuffle', description: 'Shuffles the pool and avoids repeating an episode within the repeat window.', code: shuffle },
  { name: 'Full cycle', description: 'Plays every episode once before any plays again, in listed, shuffled or season/episode order.', code: fullCycle },
  { name: 'Time-block insert', description: 'Keeps the current lineup and slots new episodes into a daily time block.', code: timeBlock },
  { name: 'AI optimizer', description: 'Builds several shuffles and asks Claude to pick the best (needs an Anthropic API key), else uses a local heuristic.', code: aiOptimizer },
  { name: 'Work-schedule sort', description: 'Saves fresh episodes for when you are home and awake; plays reruns during work and sleep hours.', code: workSchedule },
];

/** Starting code for a new sort in the Sort Builder. */
export const NEW_SORT_CODE = `/* @settings
seed: number = 1   // Random seed
*/
// run(ctx) returns the new lineup: an array of items from ctx.pool (or
// ctx.current), in play order, adding up to about ctx.targetMs.
//
// ctx.pool          episodes available to this channel
//                   { id, title, showTitle, seasonNumber, episodeNumber,
//                     episodeLabel, durationMs, ... }
// ctx.current       the channel's current lineup (same item shape)
// ctx.params        this channel's values for the settings declared above
// ctx.targetMs      how long the lineup should run
// ctx.scheduleStartMs  when the first item starts (epoch ms)
// ctx.utils         shuffle(arr, rng), makeRng(seed), scoreSchedule(list),
//                   hours(weeklyHours) -> { isInside(t), fractionInside(a, b) },
//                   claude({ apiKey, prompt }) -> Promise<text>
// ctx.globals       global variables from the Settings screen, by name
// ctx.history       from the Watch Tracker: lastWatched(id), watchCount(id),
//                   watches(id) -> [{ at, minutes }]; add { anyChannel: true }
//                   for all channels. lastAired(id) = last airing here.
//
// To pad with filler, return { type: 'flex', durationMs } items.
function run(ctx){
  const { pool, params, targetMs, utils } = ctx;
  const rng = utils.makeRng(Number(params.seed) || 1);
  const result = [];
  let elapsed = 0;
  while (elapsed < targetMs && pool.length) {
    for (const item of utils.shuffle(pool, rng)) {
      if (elapsed >= targetMs) break;
      result.push(item);
      elapsed += item.durationMs || 0;
    }
  }
  return result;
}
`;
