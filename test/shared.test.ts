import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHours, maskToWeeklyHours, parseWeeklyHours, weeklyHoursToMask } from '../src/shared/weekly-hours.js';
import { addSettingLine, parseSettings, resolveValues } from '../src/shared/sort-settings.js';
import { analyzeRepeats, makeRng } from '../src/shared/analysis.js';

const at = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

test('weekly hours: parse days, ranges and overnight blocks', () => {
  const { blocks, errors } = parseWeeklyHours('Mon,Tue,Thu,Fri 08:00-16:30; Sat 07:00-15:30; Daily 22:30-06:00');
  assert.deepEqual(errors, []);
  assert.equal(blocks.filter(b => b.day === 1 && b.startMin === 480 && b.endMin === 990).length, 1);
  assert.equal(blocks.filter(b => b.startMin === 1350 && b.endMin === 1440 + 360).length, 7);
  assert.equal(parseWeeklyHours('Mon-Fri 09:00-17:00').blocks.length, 5);
  assert.equal(parseWeeklyHours('Weekends 10:00-11:00, 12:00-13:00').blocks.length, 4);
  assert.ok(parseWeeklyHours('Funday 09:00-10:00').errors.length);
});

test('weekly hours: grid round trip keeps the text', () => {
  for (const text of ['Mon,Tue,Thu,Fri 08:00-16:30; Sat 07:00-15:30', 'Daily 22:30-06:00', 'Mon,Wed 06:00-07:00, 17:00-18:30']) {
    assert.equal(maskToWeeklyHours(weeklyHoursToMask(text)), text);
  }
});

test('hours(): isInside, fractionInside, overnight, padding and unions', () => {
  // 2026-09-21 is a Monday.
  const work = makeHours('Mon,Tue,Thu,Fri 08:00-16:30');
  assert.equal(work.isInside(at(2026, 9, 21, 12)), true);
  assert.equal(work.isInside(at(2026, 9, 23, 12)), false); // Wednesday
  assert.equal(work.fractionInside(at(2026, 9, 21, 16), at(2026, 9, 21, 17)), 0.5);
  const sleep = makeHours('Daily 22:30-06:00');
  assert.equal(sleep.isInside(at(2026, 9, 22, 3)), true);
  assert.equal(sleep.isInside(at(2026, 9, 22, 7)), false);
  const padded = makeHours([{ hours: 'Mon 08:00-16:00', padMinutes: 30 }]);
  assert.equal(padded.isInside(at(2026, 9, 21, 7, 45)), true);
  const both = makeHours(['Mon 08:00-12:00', 'Mon 10:00-14:00']);
  assert.equal(both.msInside(at(2026, 9, 21, 0), at(2026, 9, 22, 0)), 6 * 3_600_000); // overlap counted once
  // A walk far into the future still works (cache grows).
  assert.equal(work.isInside(at(2027, 3, 1, 9)), true); // Monday
});

test('settings block: parse types, labels and defaults', () => {
  const code = `/* @settings
repeatWindowHours: number = 72   // Repeat window (hours)
order: choice(as-listed, shuffle) = shuffle
workHours: weekly hours = Mon-Fri 08:00-16:30   // Work hours
apiKey: secret =
url: text = http://example.com/x   // Where
enabled: yes/no = yes
*/
function run(ctx){ return []; }`;
  const { settings, errors } = parseSettings(code);
  assert.deepEqual(errors, []);
  assert.deepEqual(settings.map(s => [s.key, s.type, s.default]), [
    ['repeatWindowHours', 'number', 72], ['order', 'choice', 'shuffle'], ['workHours', 'weekly hours', 'Mon-Fri 08:00-16:30'],
    ['apiKey', 'secret', ''], ['url', 'text', 'http://example.com/x'], ['enabled', 'yes/no', true],
  ]);
  assert.equal(settings[0].label, 'Repeat window (hours)');
  assert.deepEqual(resolveValues(settings, { repeatWindowHours: '24', order: 'bogus', extra: 1 }), {
    repeatWindowHours: 24, order: 'shuffle', workHours: 'Mon-Fri 08:00-16:30', apiKey: '', url: 'http://example.com/x', enabled: true,
  });
  assert.ok(parseSettings('/* @settings\nx: colour = red\n*/').errors.length);
  const added = addSettingLine('function run(){}', 'seed: number = 1');
  assert.equal(parseSettings(added).settings[0].key, 'seed');
});

test('analyzeRepeats uses local time of day and skips flex', () => {
  const ep = { id: 'a', title: 'A', showTitle: 'S', durationMs: 3_600_000 };
  const flex = { type: 'flex', durationMs: 23 * 3_600_000 };
  const { summary } = analyzeRepeats([ep, flex, ep], at(2026, 9, 21, 20));
  assert.equal(summary.length, 1);
  assert.equal(summary[0].minClockDeltaMin, 0); // same clock time a day later
  assert.equal(summary[0].minGapMs, 24 * 3_600_000);
  assert.equal(makeRng(1)(), makeRng(1)()); // seeded
});

test('settings linked to global variables', async () => {
  const { settings } = parseSettings(`/* @settings
apiKey: secret =
workHours: weekly hours = Mon 09:00-17:00
order: choice(a, b) = a
window: number = 48
*/`);
  const globals = { key: { type: 'secret', value: 'sk-1' }, hours: { type: 'weekly hours', value: 'Tue 08:00-12:00' }, pick: { type: 'text', value: 'b' }, n: { type: 'text', value: '5' } };
  const v = resolveValues(settings, { apiKey: { $global: 'key' }, workHours: { $global: 'hours' }, order: { $global: 'pick' }, window: { $global: 'n' } }, globals);
  // text can't feed a number setting, so window falls back to its default
  assert.deepEqual(v, { apiKey: 'sk-1', workHours: 'Tue 08:00-12:00', order: 'b', window: 48 });
  assert.equal(resolveValues(settings, { apiKey: { $global: 'gone' } }, globals).apiKey, '');
});

test('episode titles in the formats seen in the library', async () => {
  const { normalizeProgram } = await import('../src/channel-data.ts');
  const t = (title: string, extra: Record<string, unknown> = {}) => normalizeProgram('x', { type: 'content', duration: 1, program: { title, ...extra } });
  assert.deepEqual([t('The Amazing World of Gumball - S04E29 - The Points')].map(p => [p.showTitle, p.episodeLabel, p.title])[0],
    ['The Amazing World of Gumball', 'S04E29', 'The Points']);
  assert.equal(t('The Amazing World of Gumball - S01E21-E22 - The Goons + The Secret').episodeLabel, 'S01E21-E22');
  const pf = t('Phineas and Ferb_S02E15_No More Bunny Business _ Spa Day', { show: { title: 'Phineas and Ferb' }, season: { index: 2 }, episodeNumber: 15 });
  assert.deepEqual([pf.showTitle, pf.episodeLabel, pf.title], ['Phineas and Ferb', 'S02E15', 'No More Bunny Business / Spa Day']);
  const jn = t('The Adventures of Jimmy Neutron, Boy Genius_S03E04_Fundemonium');
  assert.deepEqual([jn.showTitle, jn.episodeLabel, jn.title], ['The Adventures of Jimmy Neutron, Boy Genius', 'S03E04', 'Fundemonium']);
  assert.equal(t('Episode 1 / Episode 2').title, 'Episode 1 / Episode 2');
});
