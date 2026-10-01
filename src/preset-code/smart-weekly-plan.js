/* @settings
useAi: yes/no = yes                // Let the AI plan the week (turns on the Smart planner sort's AI for this run)
candidates: number = 1             // Lineups to build and compare (each is its own AI call when the AI is on)
minDaysLeft: number = 0            // Only rebuild when fewer than this many days of lineup are left (0 = every run)
minLengthPercent: number = 50      // Refuse a lineup shorter than this % of the channel's lineup length
*/
// SMART WEEKLY PLAN
// Rebuilds the channel with its sort, normally "Smart planner", with the AI
// planning switched on for this run only (so previews you build by hand stay
// quick and free). Logs the plan, then applies the best lineup (backed up first).
//
// Set the channel's sort to "Smart planner" and its settings (work and sleep
// hours, blocks, specials, …) on the Channels screen; this automation uses them.
// AI must be allowed for sorts under Settings → AI; without it the sort falls
// back to its built-in rules.
async function run(ctx) {
  const P = ctx.params;
  if (P.minDaysLeft > 0) {
    const now = await ctx.lineup.current();
    if (now.daysLeft >= P.minDaysLeft) return ctx.skip(`${now.daysLeft.toFixed(1)} days of lineup left; rebuilds below ${P.minDaysLeft}.`);
  }
  const n = Math.max(1, Math.min(5, Number(P.candidates) || 1));
  let best = null;
  for (let i = 0; i < n; i++) {
    let c;
    try {
      c = await ctx.build({ seed: (Date.now() % 1000000) + i * 7919, params: { useAi: !!P.useAi } });
    } catch (e) {
      if (best) { ctx.log('warn: candidate ' + (i + 1) + ' failed: ' + e.message); continue; }
      return ctx.skip('Could not build a lineup: ' + e.message);
    }
    if (i === 0 && !c.logs.some(l => l.startsWith('Smart planner:'))) {
      ctx.log('warn: this channel\'s sort isn\'t "Smart planner", so the AI planning setting may do nothing.');
    }
    ctx.log(`Candidate ${i + 1}: ${c.items} items, ${c.hours.toFixed(0)} h, ${c.metrics.distinctShows} shows, score ${ctx.score(c)?.toFixed(1) ?? '—'}`);
    if (!best || (ctx.score(c) ?? 0) > (ctx.score(best) ?? 0)) best = c;
  }
  // The sort's own notes: the AI plan, specials, blocks, warnings.
  for (const line of best.logs) {
    if (/^(AI plan|Special |Block |Smart planner:|warn)/.test(line)) ctx.log(line);
  }
  await ctx.apply(best);
  return { applied: best.label, items: best.items, hours: Math.round(best.hours) };
}
