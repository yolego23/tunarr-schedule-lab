// Starter automations, loaded into the Automation Library by the Import
// button as ordinary entries the user can edit or delete.

export interface PresetAutomation {
  name: string;
  description: string;
  code: string;
}

const rebuild = (minDaysLeft: number) => `/* @settings
minDaysLeft: number = ${minDaysLeft}           // Only rebuild when fewer than this many days of lineup are left (0 = always)
newSeed: yes/no = yes              // Use a new random seed each run, so every rebuild is different
minLengthPercent: number = 50      // Refuse a lineup shorter than this % of the channel's lineup length
*/
// Rebuilds the channel with its own sort and settings, and applies it.
async function run(ctx){
  const now = await ctx.lineup.current();
  if (ctx.params.minDaysLeft > 0 && now.daysLeft >= ctx.params.minDaysLeft) {
    return ctx.skip(\`\${now.daysLeft.toFixed(1)} days of lineup left; rebuilds below \${ctx.params.minDaysLeft}.\`);
  }
  const candidate = await ctx.build(ctx.params.newSeed ? { seed: Date.now() % 1000000 } : {});
  ctx.log(\`Built \${candidate.items} items (\${(candidate.durationMs / 3600000).toFixed(0)} h), \${candidate.metrics.distinctShows} shows.\`);
  await ctx.apply(candidate);
}
`;

const bestOf = `/* @settings
candidates: number = 4             // Lineups to build and compare
minLengthPercent: number = 50      // Refuse a lineup shorter than this % of the channel's lineup length
*/
// Builds several lineups with different seeds, keeps the one the scoring
// function (Compare) likes best, and applies it.
async function run(ctx){
  const n = Math.max(1, Math.min(10, ctx.params.candidates || 4));
  let best = null;
  for (let i = 0; i < n; i++) {
    const c = await ctx.build({ seed: (Date.now() % 1000000) + i * 7919 });
    ctx.log(\`Candidate \${i + 1}: score \${ctx.score(c)?.toFixed(2)}\`);
    if (!best || ctx.score(c) > ctx.score(best)) best = c;
  }
  ctx.log(\`Applying the best: score \${ctx.score(best)?.toFixed(2)}\`);
  await ctx.apply(best);
}
`;

const aiPick = `/* @settings
candidates: number = 3             // Lineups to build and compare
criteria: text = Good variety, no show twice in a row, favourite shows at good times.   // What makes a lineup good
minLengthPercent: number = 50      // Refuse a lineup shorter than this % of the channel's lineup length
*/
// Builds several lineups and asks the AI (Settings → AI) to pick one. Without
// AI it falls back to the best score.
async function run(ctx){
  const n = Math.max(2, Math.min(6, ctx.params.candidates || 3));
  const list = [];
  for (let i = 0; i < n; i++) list.push(await ctx.build({ seed: (Date.now() % 1000000) + i * 7919 }));
  let pick = list.reduce((a, b) => (ctx.score(b) > ctx.score(a) ? b : a));
  if (ctx.ai.available) {
    const summary = list.map((c, i) => \`Candidate \${i}: score \${ctx.score(c)?.toFixed(1)}, \${c.metrics.distinctShows} shows, longest same-show run \${c.metrics.maxConsecutiveSameShow}, starts: \${c.sequence.slice(0, 15).join(' > ')}\`).join('\\n');
    try {
      const answer = await ctx.ai.ask({ prompt: \`Pick the best TV channel lineup. Criteria: \${ctx.params.criteria}\\n\\n\${summary}\\n\\nReply only with JSON: {"index": 0, "reason": "..."}\`, maxTokens: 2000 });
      const m = answer.match(/\\{[^}]*\\}/);
      const choice = m ? JSON.parse(m[0]) : null;
      if (choice && list[choice.index]) { pick = list[choice.index]; ctx.log(\`AI picked candidate \${choice.index}: \${choice.reason || ''}\`); }
    } catch (e) {
      ctx.log('warn: AI pick failed, using the best score:', e.message);
    }
  } else {
    ctx.log('AI is not set up or not allowed for automations; using the best score.');
  }
  await ctx.apply(pick);
}
`;

const aiReview = `/* @settings
instructions: text = Stop it if one show takes over, the same show plays back to back a lot, or it looks broken.   // What the AI should check
minLengthPercent: number = 50      // Refuse a lineup shorter than this % of the channel's lineup length
*/
// Builds the lineup, asks the AI to review it, and only applies it if the AI
// agrees. Without AI it applies as normal.
async function run(ctx){
  const c = await ctx.build({ seed: Date.now() % 1000000 });
  if (ctx.ai.available) {
    const shows = c.shows.map(s => \`\${s.show}: \${s.count}\`).join(', ');
    const answer = await ctx.ai.ask({
      prompt: \`Review a new lineup for the TV channel "\${ctx.channel.name}". \${ctx.params.instructions}\\n\\nItems: \${c.items}, hours: \${(c.durationMs / 3600000).toFixed(0)}, distinct shows: \${c.metrics.distinctShows}, longest same-show run: \${c.metrics.maxConsecutiveSameShow}\\nEpisodes per show: \${shows}\\nFirst items: \${c.sequence.slice(0, 30).join(' > ')}\\n\\nReply only with JSON: {"ok": true or false, "reason": "..."}\`,
      maxTokens: 2000,
    });
    const m = answer.match(/\\{[^}]*\\}/);
    const verdict = m ? JSON.parse(m[0]) : { ok: false, reason: 'The AI answer could not be read.' };
    if (!verdict.ok) return ctx.skip('AI review stopped it: ' + verdict.reason);
    ctx.log('AI review passed: ' + (verdict.reason || ''));
  }
  await ctx.apply(c);
}
`;

const addMatching = `/* @settings
networks: text =                   // Networks or studios, comma separated (e.g. Cartoon Network)
genres: text =                     // Genres, comma separated (optional)
yearFrom: number = 0               // From year (0 = any)
yearTo: number = 0                 // To year (0 = any)
mode: choice(suggest, add) = suggest   // Suggest new shows for approval, or add them straight away
aiCheck: yes/no = no               // Ask the AI whether each new show fits the channel
channelIdea: text =                // What the channel is about (for the AI check)
*/
// Looks for shows in the library that match, and adds (or suggests) the ones
// this channel doesn't have yet. Rebuilds pick them up next time.
async function run(ctx){
  const split = s => String(s || '').split(',').map(x => x.trim()).filter(Boolean);
  const rule = { networks: split(ctx.params.networks), genres: split(ctx.params.genres) };
  if (ctx.params.yearFrom) rule.yearFrom = ctx.params.yearFrom;
  if (ctx.params.yearTo) rule.yearTo = ctx.params.yearTo;
  if (!rule.networks.length && !rule.genres.length) return ctx.skip('Set networks or genres in this automation\\'s settings.');
  const pool = await ctx.pool.get();
  const have = new Set([...pool.sources.map(s => s.ref), ...(pool.onChannel || [])]);
  const excluded = new Set(pool.exclusions.map(e => e.id));
  const found = await ctx.library.search(rule);
  const fresh = found.filter(s => !have.has(s.id) && !excluded.has(s.id));
  ctx.log(\`\${found.length} match, \${fresh.length} not on this channel yet.\`);
  if (!fresh.length) return ctx.skip('No new matching shows.');
  for (const show of fresh) {
    let reason = 'Matches ' + [...rule.networks, ...rule.genres].join(', ');
    if (ctx.params.aiCheck && ctx.ai.available) {
      const answer = await ctx.ai.ask({ prompt: \`Channel "\${ctx.channel.name}": \${ctx.params.channelIdea || 'no description'}. Does the \${show.type} "\${show.title}" (\${show.year || '?'}, rated \${show.rating || '?'}) fit? Reply only with JSON: {"fits": true or false, "reason": "..."}\`, maxTokens: 1000 });
      const m = answer.match(/\\{[^}]*\\}/);
      const v = m ? JSON.parse(m[0]) : { fits: false, reason: 'unreadable answer' };
      if (!v.fits) { ctx.log(\`Skipped \${show.title}: \${v.reason}\`); continue; }
      reason = v.reason || reason;
    }
    const source = { kind: show.type === 'movie' ? 'movie' : 'show', ref: show.id, label: show.title + (show.year ? \` (\${show.year})\` : '') };
    const r = ctx.params.mode === 'add' ? await ctx.pool.add(source) : await ctx.pool.suggest(source, reason);
    const done = r.added || r.suggested;
    ctx.log(done ? (ctx.params.mode === 'add' ? 'Added ' : 'Suggested ') + source.label : 'Skipped ' + source.label + ': ' + r.reason);
  }
}
`;

export const PRESET_AUTOMATIONS: PresetAutomation[] = [
  { name: 'Weekly rebuild', description: 'Rebuilds the channel with its own sort and a new seed, and applies it.', code: rebuild(0) },
  { name: 'Rebuild when running low', description: 'Rebuilds only when fewer than a set number of days of lineup are left.', code: rebuild(2) },
  { name: 'Best of several', description: 'Builds several lineups and applies the one the scoring function rates highest.', code: bestOf },
  { name: 'AI picks the best', description: 'Builds several lineups and lets the AI pick one (falls back to the best score without AI).', code: aiPick },
  { name: 'AI review before applying', description: 'Builds a lineup and applies it only if the AI review passes (applies as normal without AI).', code: aiReview },
  { name: 'Add new matching shows', description: 'Finds library shows matching networks/genres that the channel lacks, and suggests or adds them.', code: addMatching },
];

export const NEW_AUTOMATION_CODE = `/* @settings
minLengthPercent: number = 50      // Refuse a lineup shorter than this % of the channel's lineup length
*/
// run(ctx) is called on this automation's timetable (or Run now / Dry run).
//
// ctx.channel            { id, name, number } of the channel it's assigned to
// ctx.params             this channel's values for the settings above
// ctx.globals, ctx.history, ctx.utils   as in sorts
// ctx.dryRun             true in a dry run: apply and pool changes are only reported
// await ctx.lineup.current()   { itemCount, durationMs, daysLeft, ... } ({ items: true } adds episodes)
// await ctx.build(opts)  runs the channel's sort; opts: { seed, params, hours, sort, version }
//                        -> { id, items, durationMs, score, metrics, shows, sequence }
// ctx.score(candidate)   its score from the scoring function
// await ctx.apply(candidate)   backs up and applies (once per run; minLengthPercent is enforced)
// await ctx.skip(reason) ends the run without changes
// ctx.log(...)           written to the run history
// ctx.ai.available / await ctx.ai.ask(prompt)   Settings → AI, if allowed for automations
// await ctx.library.search(rule)   shows/movies matching { networks, genres, ratings, yearFrom, yearTo, addedWithinDays, text }
// await ctx.pool.get()  { sources, exclusions, suggestions, onChannel: ids of shows etc. on the channel now }
// await ctx.pool.add(source) / suggest(source, reason) / exclude(item) / fromLineup({ weight? })   (a channel without sources keeps
//                        its lineup's shows: they become sources before the first add)
// await ctx.channels.list() / get(id)   read-only view of every channel
async function run(ctx){
  const now = await ctx.lineup.current();
  ctx.log(\`\${now.daysLeft.toFixed(1)} days of lineup left.\`);
  const candidate = await ctx.build({ seed: Date.now() % 1000000 });
  await ctx.apply(candidate);
}
`;
