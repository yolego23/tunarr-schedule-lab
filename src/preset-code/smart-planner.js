/* @settings
workHours: weekly hours = Mon,Tue,Thu,Fri 08:00-16:30; Sat 07:00-15:30   // Work hours
bufferMin: number = 0              // Minutes "away" before and after each work block (commute)
sleepHours: weekly hours = Daily 22:30-06:00   // Sleep hours (treated like work: nobody's watching)
noRepeatDays: number = 14          // While you're home, don't replay episodes watched in the last N days
repeatWindowHours: number = 72     // Don't repeat an episode within this lineup within N hours if avoidable
showGapMin: number = 90            // Minutes before the same show may play again without penalty
order: choice(shuffled, in order per show) = shuffled   // Episode order
seasonal: choice(fit the season, ignore) = fit the season   // Keep holiday episodes to their time of year
blocks: text =                     // Themed blocks, e.g. Sat 08:00-11:00 = Adventure Time, Regular Show; Fri 19:00-21:00 = Teen Titans
specials: choice(never, when they fit, one a week) = when they fit   // Specials (season 0 or "special" in the title)
specialTime: text = Fri 20:00      // When specials air (day and time)
useAi: yes/no = no                 // Let the AI plan the week (one AI call per lineup built)
aiNotes: text =                    // Extra instructions for the AI (e.g. nothing scary before 8 PM)
aiMaxEpisodes: number = 2500       // Most episodes sent to the AI (use fewer for small local models)
seed: number = 1                   // Random seed
*/
// SMART PLANNER
// Plans a lineup the way a programmer would, from the start time on:
//
//  • HOME vs AWAY: fresh episodes (not watched in the last noRepeatDays, not
//    played yet in this lineup) go where you're home and awake; work and sleep
//    hours get reruns nobody is watching. (Same idea as the Work-schedule sort.)
//  • SEASONS: holiday and seasonal episodes (Christmas, Halloween, …) stay off
//    the air outside their time of year and are featured during it.
//  • BLOCKS: optional themed blocks (e.g. a Saturday-morning block) play only
//    the listed shows during their hours.
//  • SPECIALS: optional; season-0 / "special" episodes. Seasonal ones air at the
//    special time when in season ("when they fit"); others rotate like normal
//    episodes. "one a week" holds them all for one weekly slot; "never" = no slots.
//  • AI (optional): one call reads every episode title and plans the week:
//    what to keep off the air, what to feature, themed blocks and specials.
//    Without AI (or if the call fails) the built-in rules above are used.
async function run(ctx) {
  const P = ctx.params;
  const { pool, targetMs, utils, history } = ctx;
  if (!pool || !pool.length) return [];
  const rng = utils.makeRng(Number(P.seed) || 1);
  const MIN = 60000, HOUR = 3600000, DAY = 86400000;
  const DEFAULT_DUR = 30 * MIN;
  const start = ctx.scheduleStartMs, end = start + targetMs;
  const noRepeatMs = Math.max(0, Number(P.noRepeatDays) || 0) * DAY;
  const DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

  const W = {
    freshInWatch: 1000,   // per earlier watch-time airing in this lineup
    saveFresh: 400,       // spending a fresh episode while nobody's watching
    watchedRecently: 900, // watched in the last noRepeatDays, during watch time
    airedRecently: 150,   // aired on the old lineup in the last noRepeatDays
    rerunAway: 120,       // bonus: already-watched episodes fill away time
    recentRepeat: 600,    // repeat inside repeatWindowHours (scaled)
    backToBack: 250,      // same show as the previous item
    showTooSoon: 80,      // same show within showGapMin
    outOfSeason: 5000,    // effectively off the air
    inSeason: 400,        // featured during watch time
    offBlock: 3000,       // not one of the block's shows
    staleBonus: 50,
    jitter: 15,
  };

  const away = utils.hours([{ hours: P.workHours, padMinutes: Number(P.bufferMin) || 0 }, P.sleepHours]);
  const watchFracAt = (t, dur) => 1 - away.msInside(t, t + dur) / dur;
  const fmt = ms => new Date(ms).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const lower = s => String(s || '').trim().toLowerCase();
  const showTitles = new Map(pool.map(it => [lower(it.showTitle), it.showTitle]));

  // ---------- specials ----------
  const isSpecial = it => it.seasonNumber === 0 || /\bspecials?\b/i.test(it.title || '');
  const specialEps = P.specials === 'never' ? [] : pool.filter(isSpecial);

  // ---------- built-in seasonal rules ----------
  const SEASONS = [
    { name: 'Christmas', re: /christmas|x-?mas|santa|holiday|sleigh|reindeer|mistletoe|nutcracker|grinch|snowm[ae]n|north pole|stocking/i, from: [11, 20], to: [12, 31] },
    { name: 'New Year', re: /new year/i, from: [12, 26], to: [1, 3] },
    { name: 'Halloween', re: /hallowe'?en|spooky|haunt|trick.or.treat|pumpkin|zombie|vampire|werewolf|jack.o|ghoul/i, from: [10, 1], to: [10, 31] },
    { name: 'Thanksgiving', re: /thanksgiving|pilgrim/i, from: [11, 10], to: [11, 30] },
    { name: "Valentine's Day", re: /valentine|cupid/i, from: [2, 1], to: [2, 14] },
    { name: 'Easter', re: /easter|egg hunt/i, from: [3, 15], to: [4, 25] },
    { name: 'Summer', re: /summer|beach|vacation/i, from: [6, 1], to: [8, 31] },
    { name: 'Winter', re: /\bsnow|winter|blizzard|snowball/i, from: [12, 1], to: [2, 28] },
  ];
  const inRange = (ms, s) => {
    const d = new Date(ms), v = (d.getMonth() + 1) * 100 + d.getDate();
    const a = s.from[0] * 100 + s.from[1], b = s.to[0] * 100 + s.to[1];
    return a <= b ? v >= a && v <= b : v >= a || v <= b; // ranges may wrap the new year
  };
  const seasonsOf = new Map();
  if (P.seasonal !== 'ignore') {
    for (const it of pool) {
      const tags = SEASONS.filter(s => s.re.test(`${it.title} ${it.showTitle}`));
      if (tags.length) seasonsOf.set(it.id, tags);
    }
  }

  // ---------- blocks ("Sat 08:00-11:00 = Show A, Show B; ...") ----------
  const blocks = [];
  const addBlock = (when, shows, label, from) => {
    const h = utils.hours(when);
    const known = shows.map(s => showTitles.get(lower(s))).filter(Boolean);
    if (h.errors && h.errors.length) { console.warn(`Block "${when}" skipped: ${h.errors.join('; ')}`); return; }
    if (!known.length) { console.warn(`Block "${when}" skipped: none of its shows are in the pool (${shows.join(', ')})`); return; }
    blocks.push({ when, hours: h, shows: new Set(known.map(lower)), label: label || known.join(', '), from });
  };
  for (const part of String(P.blocks || '').split(/[;\n]/)) {
    const m = part.match(/^(.*?)=(.*)$/);
    if (m && m[1].trim() && m[2].trim()) addBlock(m[1].trim(), m[2].split(',').map(s => s.trim()).filter(Boolean), null, 'settings');
  }

  // ---------- "Fri 20:00" -> times inside the lineup ----------
  const occurrences = when => {
    const m = String(when || '').trim().toLowerCase().match(/^([a-z]{3})[a-z]*\s+(\d{1,2}):(\d{2})$/);
    if (!m || DAYS.indexOf(m[1]) < 0) return [];
    const out = [];
    const d = new Date(start); d.setHours(0, 0, 0, 0);
    for (let i = 0; i <= Math.ceil(targetMs / DAY) + 1; i++, d.setDate(d.getDate() + 1)) {
      if (d.getDay() !== DAYS.indexOf(m[1])) continue;
      const at = new Date(d); at.setHours(Number(m[2]), Number(m[3]), 0, 0);
      if (at.getTime() >= start && at.getTime() < end) out.push(at.getTime());
    }
    return out;
  };

  // ---------- optional AI plan ----------
  let aiAvoid = null, aiFeature = null, aiSpecials = null;
  if (P.useAi && !ctx.ai.available) console.warn('AI isn\'t available for sorts (Settings → AI); using the built-in rules.');
  if (P.useAi && ctx.ai.available) {
    try {
      const plan = await askAi();
      aiAvoid = plan.avoid; aiFeature = plan.feature; aiSpecials = plan.specials;
      for (const b of plan.blocks) addBlock(b.when, b.shows, b.label, 'AI');
      console.log(`AI plan: ${aiAvoid.size} kept off the air, ${aiFeature.size} featured, ${plan.blocks.length} block(s), ${aiSpecials.length} special(s).${plan.notes ? ' ' + plan.notes : ''}`);
    } catch (e) {
      aiAvoid = aiFeature = aiSpecials = null;
      console.warn('AI plan failed, using the built-in rules: ' + e.message);
    }
  }

  async function askAi() {
    const watchedRecently = it => { const lw = history.lastWatched(it.id); return lw && start - lw < noRepeatMs; };
    // Send everything that matters first: specials and seasonal-looking titles, then the rest.
    const maxEps = Math.max(50, Number(P.aiMaxEpisodes) || 2500);
    const important = pool.filter(it => isSpecial(it) || SEASONS.some(s => s.re.test(it.title || '')));
    const others = utils.shuffle(pool.filter(it => !important.includes(it)), rng);
    const list = important.concat(others).slice(0, maxEps);
    if (list.length < pool.length) console.warn(`Sent ${list.length} of ${pool.length} episodes to the AI (aiMaxEpisodes).`);
    const lines = list.map((it, n) => `${n}|${it.showTitle}|${it.episodeLabel || ''}|${(it.title || '').slice(0, 90)}|${Math.round((it.durationMs || 0) / MIN)}m${isSpecial(it) ? '|S' : ''}${watchedRecently(it) ? '|W' : ''}`);
    const specialRule = P.specials === 'never' ? 'Do not schedule any specials: return "specials": [].'
      : P.specials === 'one a week' ? `Pick exactly one special (flag S) per week of lineup, the best fit for the time of year, at a good home-time slot (default "${P.specialTime}").`
      : `Schedule a special (flag S) only if one clearly fits this time of year or an event in it; usually none, at most 2 a week. Default time "${P.specialTime}".`;
    const prompt = [
      `Plan the programming for the TV channel "${ctx.channel.name}".`,
      `The new lineup runs from ${fmt(start)} to ${fmt(end)}.`,
      `Viewers are away (work) during: ${P.workHours || 'none'}; asleep during: ${P.sleepHours || 'none'}. Plan blocks and specials for when they're home and awake.`,
      '',
      'Return JSON with:',
      '- "avoid": episode numbers that do not fit this period, mainly holiday/seasonal episodes out of season (Christmas episodes outside late November–December, Halloween outside October, summer episodes in winter, and so on). Do not avoid ordinary episodes.',
      '- "feature": episode numbers that fit this period especially well (in-season holiday or event episodes). Keep it short.',
      '- "blocks": optional themed blocks, at most 6: {"when": "Sat 08:00-11:00", "shows": ["exact show titles from the list"], "label": "Saturday morning"}. An empty list is fine.',
      `- "specials": ${specialRule} Each: {"n": number, "when": "Fri 20:00", "why": "..."}.`,
      '- "notes": one or two sentences about the plan.',
      P.blocks ? `The owner already set these blocks (keep them, you may add others): ${P.blocks}` : '',
      P.aiNotes ? `Owner's instructions: ${P.aiNotes}` : '',
      '',
      'Reply with only the JSON object.',
      '',
      'Episodes (n|show|episode|title|length|S = special|W = watched recently):',
      ...lines,
    ].filter(l => l !== null).join('\n');
    const answer = await ctx.ai.ask({
      prompt, maxTokens: 8000,
      system: 'You are a TV programming planner for a home live-TV channel. You answer only with a JSON object.',
    });
    const m = String(answer).match(/\{[\s\S]*\}/);
    if (!m) throw new Error('the answer had no JSON');
    const j = JSON.parse(m[0]);
    const pick = arr => new Set((Array.isArray(arr) ? arr : []).map(Number).filter(n => Number.isInteger(n) && list[n]).map(n => list[n].id));
    return {
      avoid: pick(j.avoid),
      feature: pick(j.feature),
      blocks: (Array.isArray(j.blocks) ? j.blocks : []).slice(0, 6)
        .filter(b => b && typeof b.when === 'string' && Array.isArray(b.shows))
        .map(b => ({ when: b.when, shows: b.shows.map(String), label: b.label ? String(b.label) : null })),
      specials: P.specials === 'never' ? [] : (Array.isArray(j.specials) ? j.specials : [])
        .filter(s => s && Number.isInteger(Number(s.n)) && list[Number(s.n)])
        .map(s => ({ it: list[Number(s.n)], when: String(s.when || P.specialTime), why: s.why ? String(s.why) : '' })),
      notes: j.notes ? String(j.notes).slice(0, 300) : '',
    };
  }

  // Off the air / featured at time t.
  const outOfSeason = (it, t) => {
    if (aiAvoid) return aiAvoid.has(it.id);
    const tags = seasonsOf.get(it.id);
    return !!tags && !tags.some(s => inRange(t, s));
  };
  const featured = (it, t) => {
    if (aiFeature) return aiFeature.has(it.id);
    const tags = seasonsOf.get(it.id);
    return !!tags && tags.some(s => inRange(t, s));
  };

  // ---------- plan the specials ----------
  const planned = []; // { it, at, why }
  if (aiSpecials) {
    for (const s of aiSpecials) {
      const at = occurrences(s.when).find(a => !planned.some(p => Math.abs(p.at - a) < 2 * HOUR));
      if (at) planned.push({ it: s.it, at, why: s.why || 'AI pick' });
    }
  } else if (specialEps.length) {
    const used = new Set();
    for (const at of occurrences(P.specialTime)) {
      const fits = specialEps.filter(it => !used.has(it.id) && !outOfSeason(it, at) && (P.specials === 'one a week' || featured(it, at)));
      if (!fits.length) continue;
      // In season first, then the one watched longest ago (or never).
      fits.sort((a, b) => (featured(b, at) - featured(a, at)) || ((history.lastWatched(a.id) || 0) - (history.lastWatched(b.id) || 0)) || (rng() - 0.5));
      used.add(fits[0].id);
      planned.push({ it: fits[0], at, why: featured(fits[0], at) ? 'in season' : 'weekly special' });
    }
  }
  planned.sort((a, b) => a.at - b.at);
  // Specials held for their slot: all of them for "one a week"; otherwise the
  // seasonal ones and any the AI scheduled. Other specials rotate like episodes.
  const reserved = new Set(specialEps
    .filter(it => P.specials === 'one a week' || seasonsOf.has(it.id) || planned.some(p => p.it.id === it.id))
    .map(it => it.id));

  // ---------- episode order ----------
  const inOrder = P.order === 'in order per show';
  const byShow = new Map();
  if (inOrder) {
    for (const it of pool) {
      if (reserved.has(it.id)) continue;
      const k = lower(it.showTitle);
      if (!byShow.has(k)) byShow.set(k, []);
      byShow.get(k).push(it);
    }
    for (const [k, eps] of byShow) {
      eps.sort((a, b) => ((a.seasonNumber ?? 999) - (b.seasonNumber ?? 999)) || ((a.episodeNumber ?? 0) - (b.episodeNumber ?? 0)) || String(a.title).localeCompare(String(b.title)));
      // Carry on after the episode watched most recently.
      let at = 0, best = 0;
      eps.forEach((it, i) => { const lw = history.lastWatched(it.id) || 0; if (lw > best) { best = lw; at = i + 1; } });
      byShow.set(k, { eps, ptr: at % eps.length });
    }
  }

  // ---------- walk the schedule ----------
  const watchPlays = new Map(), lastPlay = new Map(), showLast = new Map();
  const blockAt = t => blocks.find(b => b.hours.isInside(t)) || null;
  const SAMPLE = 600;
  const rotation = pool.filter(it => !reserved.has(it.id));
  if (!rotation.length) { console.warn('Every episode is a special; nothing to fill the week with.'); }
  const result = [];
  let t = start, prevShow = null, si = 0, placedSpecials = 0;
  let featuredAired = 0, offAir = 0;

  const costOf = (it, t, blk) => {
    const k = it.id, dur = it.durationMs || DEFAULT_DUR;
    const wf = watchFracAt(t, dur);
    let cost = 0;
    if (outOfSeason(it, t)) cost += W.outOfSeason;
    else if (featured(it, t)) cost -= W.inSeason * wf;
    const wp = watchPlays.get(k) || 0;
    const lw = history.lastWatched(k);
    const watchedRecently = lw && start - lw < noRepeatMs;
    cost += wf * wp * W.freshInWatch;
    if (watchedRecently) cost += W.watchedRecently * wf;
    if (lw) cost -= W.rerunAway * (1 - wf);
    if (wp === 0 && !watchedRecently) cost += (1 - wf) * W.saveFresh;
    const la = history.lastAired(k);
    if (la && start - la < noRepeatMs) cost += W.airedRecently * wf;
    const lp = lastPlay.get(k), windowMs = Number(P.repeatWindowHours) * HOUR;
    if (lp !== undefined) {
      const since = t - lp;
      if (since < windowMs) cost += W.recentRepeat * (1 - since / windowMs);
      cost -= W.staleBonus * Math.min(1, since / (windowMs * 3));
    } else cost -= W.staleBonus;
    if (it.showTitle === prevShow) cost += W.backToBack;
    const sl = showLast.get(it.showTitle), gap = Number(P.showGapMin) * MIN;
    if (sl !== undefined && gap > 0 && t - sl < gap) cost += W.showTooSoon * (1 - (t - sl) / gap);
    if (blk && !blk.shows.has(lower(it.showTitle))) cost += W.offBlock;
    return cost + rng() * W.jitter;
  };

  const place = (it, why) => {
    const dur = it.durationMs || DEFAULT_DUR;
    if (watchFracAt(t, dur) >= 0.5) watchPlays.set(it.id, (watchPlays.get(it.id) || 0) + 1);
    if (outOfSeason(it, t)) offAir++;
    else if (featured(it, t)) featuredAired++;
    lastPlay.set(it.id, t);
    showLast.set(it.showTitle, t);
    prevShow = it.showTitle;
    result.push(it);
    if (why) console.log(`Special ${fmt(t)}: ${it.showTitle} · ${it.title} (${why})`);
    t += dur;
  };

  while (t < end && (rotation.length || si < planned.length)) {
    // A special is due: air it at the first break at or after its time.
    if (si < planned.length && t >= planned[si].at - 5 * MIN) {
      place(planned[si].it, planned[si].why);
      si++; placedSpecials++;
      continue;
    }
    if (!rotation.length) {
      // Nothing to play until the next special: fill the gap with flex.
      const gap = planned[si].at - t;
      result.push({ type: 'flex', durationMs: gap });
      t += gap;
      continue;
    }
    const blk = blockAt(t);
    let cands;
    if (inOrder) {
      cands = [];
      for (const s of byShow.values()) {
        // The show's next episode that isn't off the air right now.
        for (let n = 0; n < s.eps.length; n++) {
          const it = s.eps[(s.ptr + n) % s.eps.length];
          if (!outOfSeason(it, t)) { cands.push({ it, s, idx: (s.ptr + n) % s.eps.length }); break; }
        }
      }
      if (!cands.length) cands = [...byShow.values()].map(s => ({ it: s.eps[s.ptr], s, idx: s.ptr }));
    } else {
      cands = (rotation.length > SAMPLE ? utils.shuffle(rotation, rng).slice(0, SAMPLE) : rotation).map(it => ({ it }));
    }
    let best = null, bestCost = Infinity;
    for (const c of cands) {
      const cost = costOf(c.it, t, blk);
      if (cost < bestCost) { bestCost = cost; best = c; }
    }
    if (best.s) best.s.ptr = (best.idx + 1) % best.s.eps.length;
    place(best.it, null);
  }

  console.log(`Smart planner: ${result.length} items from ${fmt(start)}; ${featuredAired} in-season airings, ${offAir} out-of-season (only when nothing else fit), ${placedSpecials} special(s), ${blocks.length} block(s)${aiAvoid ? ', planned by the AI' : ''}.`);
  for (const b of blocks) console.log(`Block (${b.from}): ${b.when} = ${b.label}`);
  return result;
}
