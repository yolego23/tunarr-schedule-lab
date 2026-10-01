// The "Smart planner" starter sort, run in the real sandbox on a made-up
// library during Halloween week, with and without a (fake) AI plan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runSort } from '../src/sandbox/index.ts';
import { parseSettings, resolveValues } from '../src/shared/sort-settings.js';

const CODE = fs.readFileSync(new URL('../src/preset-code/smart-planner.js', import.meta.url), 'utf8');
const MIN = 60000, HOUR = 3600000, DAY = 86400000;
const START = new Date(2026, 9, 5, 0, 0).getTime(); // Mon Oct 5 2026, local time

function ep(show: string, s: number, e: number, title: string, minutes = 22) {
  return { id: `${show}-${s}-${e}`, type: 'content', title, showTitle: show, seasonNumber: s, episodeNumber: e,
    episodeLabel: `S${String(s).padStart(2, '0')}E${String(e).padStart(2, '0')}`, durationMs: minutes * MIN, weight: 1, sources: [show] };
}
const pool = [
  ...Array.from({ length: 30 }, (_, i) => ep('Alpha', 1, i + 1, `Alpha Story ${i + 1}`)),
  ...Array.from({ length: 30 }, (_, i) => ep('Beta', 1, i + 1, `Beta Tale ${i + 1}`)),
  ep('Alpha', 2, 1, 'A Very Alpha Christmas'),
  ep('Beta', 2, 1, 'Santa Claus Is Coming'),
  ep('Alpha', 2, 2, 'Spooky Halloween Night'),
  ep('Beta', 2, 2, 'The Haunted House'),
  ep('Alpha', 0, 1, 'Alpha Halloween Special', 44),
  ep('Beta', 0, 1, 'Beta Christmas Special', 44),
  ep('Beta', 0, 2, 'Beta Reunion Special', 44),
];
const byId = new Map(pool.map(p => [p.id, p]));

function run(values: Record<string, unknown>, opts: { history?: any; ai?: (p: any) => string; hours?: number } = {}) {
  const { settings } = parseSettings(CODE);
  return runSort(CODE, {
    pool, current: [], currentPlayingIndex: 0, params: resolveValues(settings, values, {}),
    targetMs: (opts.hours ?? 168) * HOUR, scheduleStartMs: START, channel: { id: 'c1', name: 'Test TV', number: 1 }, globals: {},
    history: opts.history ?? { channel: {}, any: {}, lastAired: {} }, aiAvailable: !!opts.ai,
  }, undefined, {
    timeLimitMs: 20_000,
    bridge: async (kind, p) => { if (kind !== 'ai' || !opts.ai) throw new Error('no AI'); return opts.ai(p); },
  });
}

/** The lineup with each item's start time. */
function timeline(items: any[]): any[] {
  let t = START;
  return items.map(i => {
    const it = 'id' in i ? byId.get(i.id)! : { title: '(flex)', showTitle: '', durationMs: i.durationMs, id: '' };
    const at = t; t += it.durationMs;
    return { ...it, at };
  });
}

test('rules: Halloween episodes and the Halloween special air in October; Christmas ones stay off', async () => {
  const r = await run({});
  const lineup = timeline(r.items);
  const titles = lineup.map(i => i.title);
  assert.ok(lineup.reduce((a, i) => a + i.durationMs, 0) >= 168 * HOUR, 'fills the week');
  assert.ok(!titles.some(t => /Christmas|Santa/.test(t)), 'no Christmas episodes in October');
  assert.ok(titles.includes('Spooky Halloween Night') && titles.includes('The Haunted House'), 'Halloween episodes are featured');
  const special = lineup.find(i => i.title === 'Alpha Halloween Special')!;
  const d = new Date(special.at);
  assert.equal(d.getDay(), 5, 'the special airs on Friday');
  assert.ok(Math.abs(d.getHours() * 60 + d.getMinutes() - 20 * 60) <= 30, `around 20:00 (got ${d.toTimeString()})`);
  assert.equal(titles.filter(t => /(Halloween|Christmas) Special/.test(t)).length, 1, 'only the seasonal special that fits');
  assert.ok(titles.includes('Beta Reunion Special'), 'a special with no season rotates like an episode');
  assert.ok(r.logs.some(l => l.startsWith('Smart planner:')));
});

test('specials: "never" leaves them in normal rotation; "one a week" airs one even out of its season', async () => {
  const never = timeline((await run({ specials: 'never' })).items).map(i => i.title);
  assert.ok(never.includes('Alpha Halloween Special'), 'in rotation');
  assert.ok(!never.includes('Beta Christmas Special'), 'still kept to its season');
  const weekly = timeline((await run({ specials: 'one a week', seasonal: 'ignore' })).items).filter(i => /Special/.test(i.title));
  assert.equal(weekly.length, 1, 'all specials held for the one weekly slot');
});

test('watch history: episodes watched recently stay out of home time', async () => {
  const watched: Record<string, any> = {};
  for (let i = 1; i <= 20; i++) watched[`Alpha-1-${i}`] = { total: 1, last: START - 2 * DAY, watches: [{ at: START - 2 * DAY, minutes: 20 }] };
  const r = await run({}, { history: { channel: watched, any: watched, lastAired: {} } });
  const away = (await import('../src/shared/weekly-hours.js')).makeHours(['Mon,Tue,Thu,Fri 08:00-16:30; Sat 07:00-15:30', 'Daily 22:30-06:00']);
  const home = timeline(r.items).filter(i => i.at < START + 2 * DAY && !away.isInside(i.at));
  const rewatched = home.filter(i => watched[i.id]);
  assert.ok(home.length > 10);
  assert.ok(rewatched.length <= 1, `at most one recently watched episode while home in the first 2 days (got ${rewatched.length})`);
});

test('blocks: only the block\'s shows play during it', async () => {
  const r = await run({ blocks: 'Sat 08:00-11:00 = Beta' });
  const sat = timeline(r.items).filter(i => { const d = new Date(i.at); return d.getDay() === 6 && d.getHours() >= 8 && d.getHours() < 11; });
  assert.ok(sat.length >= 6);
  assert.ok(sat.every(i => i.showTitle === 'Beta'), sat.map(i => i.showTitle).join(','));
});

test('in order per show: carries on after the last watched episode', async () => {
  const watched = { 'Alpha-1-5': { total: 1, last: START - 30 * DAY, watches: [] } };
  const r = await run({ order: 'in order per show' }, { history: { channel: watched, any: watched, lastAired: {} }, hours: 24 });
  const alpha = timeline(r.items).filter(i => i.showTitle === 'Alpha' && i.seasonNumber === 1).map(i => i.episodeNumber);
  assert.deepEqual(alpha.slice(0, 4), [6, 7, 8, 9]);
});

test('AI plan: avoid, blocks and specials from the answer; a bad answer falls back to the rules', async () => {
  let prompt = '';
  const ai = (p: any) => {
    prompt = p.prompt;
    const n = (title: string) => prompt.split('\n').find(l => l.includes(`|${title}|`))!.split('|')[0];
    return 'Here you go: ' + JSON.stringify({
      avoid: [Number(n('Alpha Story 3'))],
      feature: [Number(n('The Haunted House'))],
      blocks: [{ when: 'Sun 09:00-12:00', shows: ['alpha'], label: 'Sunday Alpha' }],
      specials: [{ n: Number(n('Alpha Halloween Special')), when: 'Sat 19:00', why: 'Halloween month' }],
      notes: 'Halloween week.',
    });
  };
  const r = await run({ useAi: true }, { ai });
  assert.match(prompt, /Test TV/);
  assert.match(prompt, /\|S$/m, 'specials are flagged');
  const lineup = timeline(r.items);
  assert.ok(!lineup.some(i => i.title === 'Alpha Story 3'), 'avoided');
  const special = lineup.find(i => i.title === 'Alpha Halloween Special')!;
  assert.equal(new Date(special.at).getDay(), 6);
  const sun = lineup.filter(i => { const d = new Date(i.at); return d.getDay() === 0 && d.getHours() >= 9 && d.getHours() < 12; });
  assert.ok(sun.length && sun.every(i => i.showTitle === 'Alpha'));
  assert.ok(r.logs.some(l => /^AI plan: 1 kept off the air, 1 featured, 1 block\(s\), 1 special\(s\)\. Halloween week\./.test(l)), r.logs.join('\n'));

  const bad = await run({ useAi: true }, { ai: () => 'Sorry, no.' });
  assert.ok(bad.logs.some(l => /AI plan failed, using the built-in rules/.test(l)));
  assert.ok(!timeline(bad.items).some(i => /Christmas|Santa/.test(i.title)), 'rules still keep Christmas off');
});
