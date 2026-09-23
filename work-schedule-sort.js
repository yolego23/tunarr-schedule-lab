// WORK-SCHEDULE-AWARE SORT
// ------------------------------------------------------------------
// Walks the schedule minute-by-minute from "Schedule start" and picks the
// next episode by scoring every candidate (lowest cost wins):
//
//  • WATCH TIME (when you're not at work): strongly prefers episodes you
//    haven't had a chance to see yet, so fresh episodes land when you're
//    home and repeats are pushed as late as possible.
//  • WORK TIME: prefers episodes that already aired during watch time
//    (reruns nobody is watching) so fresh ones are saved for when you're home.
//  • Anywhere: penalizes the same episode airing again within the repeat
//    window, airing again near the same time of day it last aired, and the
//    same show playing back-to-back / too close together.
//
// Everything below is tunable. To change a setting from the UI without
// editing code, add a parameter on this tab with the same key
// (e.g. key "workHours", type text) — UI values override these defaults.
function run(ctx){
  const P = Object.assign({
    // Days: Sun Mon Tue Wed Thu Fri Sat. Blocks separated by ";".
    workHours: 'Mon,Tue,Thu,Fri 08:00-16:30; Sat 07:00-15:30',
    // Extra minutes counted as "away" before and after each work block
    // (commute / getting ready). 0 = exactly the hours above.
    bufferMin: 0,
    // Daily sleep window (bedtime-wakeup, 24h clock). Blank = none.
    // Sleep time is treated like work time (nobody's watching).
    sleepHours: '22:30-06:00',
    // Don't repeat an episode within this many hours if avoidable.
    repeatWindowHours: 72,
    // A repeat within this many minutes of the SAME time of day it
    // previously aired gets penalized (closer = bigger penalty).
    clockWindowMin: 120,
    // Minutes before the same show may play again without penalty.
    showGapMin: 90,
    seed: 1,
  }, ctx.params || {});

  const { pool, targetMs, utils } = ctx;
  if (!pool || !pool.length) return [];
  const rng = utils.makeRng(Number(P.seed) || 1);
  const start = ctx.scheduleStart ? new Date(ctx.scheduleStart).getTime() : Date.now();
  const MIN = 60000, HOUR = 3600000, DAY = 86400000;
  const DEFAULT_DUR = 30 * MIN;

  // Weights (bigger = the algorithm cares more)
  const W = {
    freshInWatch: 1000,  // per previous watch-time airing, scaled by how much of the slot is watch time
    saveFresh:    400,   // cost of "spending" an unseen episode during work
    recentRepeat: 600,   // repeat inside repeatWindowHours (scaled by how recent)
    sameClock:    300,   // repeat near the same time of day (scaled by closeness)
    backToBack:   250,   // same show as the previous item
    showTooSoon:  80,    // same show within showGapMin
    staleBonus:   50,    // slight preference for whatever has waited longest
    jitter:       15,    // randomness so different seeds give different lineups
  };

  // ---------- parse "away" windows ----------
  const DAYS = { sun:0, mon:1, tue:2, wed:3, thu:4, fri:5, sat:6 };
  const toMin = s => { const [h, m] = String(s).trim().split(':').map(Number); return (h||0)*60 + (m||0); };
  const blocks = []; // { day, startMin, endMin }  (endMin may exceed 1440 for overnight)
  String(P.workHours || '').split(';').forEach(part => {
    const m = part.trim().match(/^([A-Za-z,\s]+)\s+(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})$/);
    if (!m) return;
    let s = toMin(m[2]) - (Number(P.bufferMin)||0), e = toMin(m[3]) + (Number(P.bufferMin)||0);
    if (e <= s) e += 1440;
    m[1].split(',').map(d => DAYS[d.trim().slice(0,3).toLowerCase()]).filter(d => d !== undefined)
      .forEach(day => blocks.push({ day, startMin: s, endMin: e }));
  });
  const sleep = String(P.sleepHours || '').match(/(\d{1,2}:\d{2})\s*-\s*(\d{1,2}:\d{2})/);
  if (sleep) {
    let s = toMin(sleep[1]), e = toMin(sleep[2]);
    if (e <= s) e += 1440;
    for (let d = 0; d < 7; d++) blocks.push({ day: d, startMin: s, endMin: e });
  }

  // Milliseconds of [a, b) that fall inside any away block (local time).
  function awayMs(a, b){
    let total = 0;
    const d0 = new Date(a); d0.setHours(0,0,0,0);
    for (let dayStart = d0.getTime() - DAY; dayStart < b; ) {
      const date = new Date(dayStart);
      const dow = date.getDay();
      for (const blk of blocks) {
        if (blk.day !== dow) continue;
        const bs = new Date(dayStart); bs.setMinutes(blk.startMin);
        const be = new Date(dayStart); be.setMinutes(blk.endMin);
        total += Math.max(0, Math.min(b, be.getTime()) - Math.max(a, bs.getTime()));
      }
      date.setDate(date.getDate() + 1); // DST-safe next day
      dayStart = date.getTime();
    }
    return Math.min(total, b - a);
  }
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

      // Fresh episodes for watch time; burn reruns during work.
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
