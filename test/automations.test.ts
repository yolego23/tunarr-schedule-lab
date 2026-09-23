// Automations: timetables, the queue, and the safety rules, against a fake Tunarr.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

const channels = new Map<string, any>();
const lineups = new Map<string, any[]>();
const episodes: Record<string, any[]> = {
  show1: [1, 2, 3, 4].map(i => ({ type: 'content', id: `s1-e${i}`, duration: 1_800_000, program: { uuid: `s1-e${i}`, type: 'episode', title: `Show One - S01E0${i} - Ep ${i}`, showId: 'show1', show: { title: 'Show One' } } })),
  show2: [1, 2].map(i => ({ type: 'content', id: `s2-e${i}`, duration: 1_800_000, program: { uuid: `s2-e${i}`, type: 'episode', title: `Show Two - S01E0${i} - Ep ${i}`, showId: 'show2', show: { title: 'Show Two' } } })),
};
for (const id of ['c1', 'c2']) {
  channels.set(id, { id, number: id === 'c1' ? 1 : 2, name: `Channel ${id}`, startTime: Date.now() - 60_000, duration: 0 });
  lineups.set(id, episodes.show1.map(e => ({ type: 'content', id: e.id, duration: e.duration })));
}
let writes: string[] = [];

const fake = http.createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  const url = new URL(req.url!, 'http://x');
  const send = (d: unknown, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(d)); };
  if (url.pathname === '/api/channels' && req.method === 'GET') return send([...channels.values()]);
  if (url.pathname === '/api/smart_collections/sc1') return send({ uuid: 'sc1', name: 'Toons', keywords: '', filter: { type: 'value' } });
  if (url.pathname === '/api/programs/search') {
    return send({ results: [{ uuid: 'show1', type: 'show', title: 'Show One', year: 1999 }, { uuid: 'show2', type: 'show', title: 'Show Two', year: 2001 }], page: 0, totalPages: 1, totalHits: 2 });
  }
  const d = url.pathname.match(/^\/api\/programs\/([^/]+)\/descendants$/);
  if (d) return episodes[d[1]] ? send(episodes[d[1]]) : send({ message: 'none' }, 404);
  const m = url.pathname.match(/^\/api\/channels\/([^/]+)(\/.*)?$/);
  if (m && !m[2]) {
    const ch = channels.get(m[1]);
    if (!ch) return send({ message: 'no channel' }, 404);
    if (req.method === 'PUT') { channels.set(m[1], { ...ch, ...JSON.parse(body) }); return send(channels.get(m[1])); }
    return send({ ...ch, duration: (lineups.get(m[1]) || []).reduce((a, b) => a + b.duration, 0) });
  }
  if (m && m[2] === '/programming') {
    if (req.method === 'POST') { writes.push(m[1]); lineups.set(m[1], JSON.parse(body).lineup); return send({}); }
    const all = Object.values(episodes).flat();
    const programs = Object.fromEntries(all.filter(e => (lineups.get(m[1]) || []).some((l: any) => l.id === e.id)).map(e => [e.id, e]));
    return send({ name: channels.get(m[1])?.name, number: channels.get(m[1])?.number, lineup: lineups.get(m[1]) || [], programs });
  }
  send({ message: 'no route ' + url.pathname }, 404);
});

let auto: typeof import('../src/automations.ts');
let sorts: typeof import('../src/sorts.ts');
let channelsMod: typeof import('../src/channels.ts');
let presets: typeof import('../src/automation-presets.ts');
let dbMod: typeof import('../src/db.ts');
before(async () => {
  await new Promise<void>(r => fake.listen(0, '127.0.0.1', r));
  process.env.TUNARR_URL = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-auto-'));
  auto = await import('../src/automations.ts');
  sorts = await import('../src/sorts.ts');
  channelsMod = await import('../src/channels.ts');
  presets = await import('../src/automation-presets.ts');
  dbMod = await import('../src/db.ts');
  const sort = sorts.createSort({ name: 'Reverse', code: '/* @settings\nseed: number = 1\n*/\nfunction run(ctx){ return ctx.pool.slice().reverse(); }' });
  for (const id of ['c1', 'c2']) channelsMod.saveSetup(id, { sortId: sort.id, targetHours: 2 });
});
after(() => { auto.stopAutomations(); fake.close(); });

const win = { windowStart: '01:00', windowEnd: '05:00' } as any;
const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();

test('timetables: weekly, monthly (short months), every N days, hours, and spread in the window', () => {
  // 2026-09-23 is a Wednesday.
  assert.equal(auto.nextRunAt({ kind: 'weekly', days: ['Sun'], at: '03:00' }, at(2026, 9, 23, 12), 'a1', win), at(2026, 9, 27, 3));
  assert.equal(auto.nextRunAt({ kind: 'weekly', days: ['Wed'], at: '13:00' }, at(2026, 9, 23, 12), 'a1', win), at(2026, 9, 23, 13), 'later the same day');
  assert.equal(auto.nextRunAt({ kind: 'monthly', dayOfMonth: 31, at: '02:00' }, at(2027, 2, 1), 'a1', win), at(2027, 2, 28, 2), 'the last day of a short month');
  assert.equal(auto.nextRunAt({ kind: 'every', everyDays: 3, anchor: '2026-09-20', at: '04:00' }, at(2026, 9, 23, 5), 'a1', win), at(2026, 9, 26, 4));
  assert.equal(auto.nextRunAt({ kind: 'hours', everyHours: 6 }, at(2026, 9, 23, 12), 'a1', win), at(2026, 9, 23, 18));
  assert.equal(auto.nextRunAt({ kind: 'manual' }, Date.now(), 'a1', win), null);
  const spots = ['a1', 'a2', 'a3', 'a4', 'a5'].map(k => new Date(auto.nextRunAt({ kind: 'daily', at: null }, at(2026, 9, 23, 12), k, win)!));
  for (const s of spots) assert.ok(s.getHours() >= 1 && s.getHours() < 5, `inside the window: ${s}`);
  assert.ok(new Set(spots.map(s => s.getTime())).size > 1, 'spread across the window');
  assert.throws(() => auto.cleanTimetable({ kind: 'weekly', days: [] }), /at least one day/);
});

async function waitFor(runId: number) {
  for (let i = 0; i < 300; i++) {
    const r = auto.getRun(runId);
    if (r.status !== 'queued' && r.status !== 'running') return r;
    await new Promise(res => setTimeout(res, 50));
  }
  throw new Error('run did not finish');
}

test('rebuild: applies to its own channel with a backup; the dry run changes nothing', async () => {
  const a = auto.createAutomation({ name: 'Rebuild', code: presets.PRESET_AUTOMATIONS[0].code });
  const asg = auto.createAssignment('c1', { automationId: a.id, timetable: { kind: 'manual' } });
  assert.equal(asg.nextRunAt, null);

  writes = [];
  const dry = await waitFor(auto.runNow(asg.id, { dryRun: true }).id);
  assert.equal(dry.status, 'done', dry.message);
  assert.equal(writes.length, 0, 'a dry run writes nothing');
  assert.match(dry.changes[0].detail, /^Would apply/);

  const run = await waitFor(auto.runNow(asg.id).id);
  assert.equal(run.status, 'applied', run.message);
  assert.deepEqual(writes, ['c1'], 'only its own channel');
  assert.deepEqual(lineups.get('c1')!.map(l => l.id), ['s1-e4', 's1-e3', 's1-e2', 's1-e1']);
  const backups = dbMod.db.prepare("SELECT reason FROM backups WHERE channel_id = 'c1'").all() as any[];
  assert.equal(backups.length, 1);
  assert.match(backups[0].reason, /Rebuild/);
});

test('safety: once per run, not too short, only its own builds; skip stops it', async () => {
  const twice = `/* @settings\nminLengthPercent: number = 50\n*/\nasync function run(ctx){ const c = await ctx.build(); await ctx.apply(c); await ctx.apply(c); }`;
  let r = await auto.testCode({ code: twice, channelId: 'c2' });
  assert.equal(r.status, 'failed');
  assert.match(r.message, /only once per run/);

  const short = `async function run(ctx){ const c = await ctx.build({ hours: 0.5 }); await ctx.apply(c); }`;
  channelsMod.saveSetup('c2', { values: {} });
  const sortShort = sorts.createSort({ name: 'One', code: 'function run(ctx){ return ctx.pool.slice(0, 1); }' });
  r = await auto.testCode({ code: short.replace('hours: 0.5', `sort: ${sortShort.id}`), channelId: 'c2' });
  assert.equal(r.status, 'failed');
  assert.match(r.message, /under 50%/);

  r = await auto.testCode({ code: `async function run(ctx){ await ctx.apply({ id: 'someone-elses' }); }`, channelId: 'c2' });
  assert.match(r.message, /built by ctx.build\(\) in this run/);

  r = await auto.testCode({ code: `async function run(ctx){ await ctx.skip('nothing to do'); }`, channelId: 'c2' });
  assert.equal(r.status, 'skipped');
  assert.equal(r.message, 'nothing to do');

  r = await auto.testCode({ code: `async function run(ctx){ return (await ctx.channels.list()).map(c => c.name); }`, channelId: 'c2' });
  assert.deepEqual(r.result, ['Channel c1', 'Channel c2'], 'can read every channel');
});

test('add new matching shows: suggests what the channel lacks; approving adds it to the pool', async () => {
  channelsMod.saveSetup('c2', { pool: { sources: [{ id: 'x', kind: 'show', ref: 'show1', label: 'Show One', weight: 1 }], exclusions: [] } });
  const code = presets.PRESET_AUTOMATIONS.find(p => p.name === 'Add new matching shows')!.code;
  let r = await auto.testCode({ code, channelId: 'c2', values: { networks: 'Cartoon Network' } });
  assert.equal(r.status, 'done', r.message);
  assert.deepEqual(r.changes.map((c: any) => c.detail), ['Would suggest Show Two (2001) (Matches Cartoon Network)']);
  assert.equal(auto.listSuggestions('c2').length, 0, 'a dry run suggests nothing');

  const a = auto.createAutomation({ name: 'Matching', code });
  const asg = auto.createAssignment('c2', { automationId: a.id, values: { networks: 'Cartoon Network' }, timetable: { kind: 'manual' } });
  r = await waitFor(auto.runNow(asg.id).id);
  const sugg = auto.listSuggestions('c2');
  assert.equal(sugg.length, 1);
  assert.equal(sugg[0].ref, 'show2');
  await auto.decideSuggestion(sugg[0].id, true);
  assert.deepEqual(channelsMod.getSetup('c2').pool.sources.map(s => s.ref), ['show1', 'show2']);
  r = await waitFor(auto.runNow(asg.id).id);
  assert.equal(r.status, 'skipped', 'nothing new the second time');
});

test('the timetable queues due runs and moves on', async () => {
  const a = auto.createAutomation({ name: 'Noop', code: 'async function run(ctx){ ctx.log("hi"); }' });
  const asg = auto.createAssignment('c1', { automationId: a.id, timetable: { kind: 'hours', everyHours: 1 } });
  dbMod.db.prepare('UPDATE channel_automations SET next_run_at = ? WHERE id = ?').run(Date.now() - 1000, asg.id);
  auto.tick();
  const [run] = auto.listRuns({ assignmentId: asg.id });
  assert.equal(run.trigger, 'timetable');
  const done: any = await waitFor(run.id);
  assert.equal(done.status, 'done');
  assert.deepEqual(done.logs, ['hi']);
  const next = auto.listAssignments('c1').find(x => x.id === asg.id)!.nextRunAt!;
  assert.ok(next > Date.now() + 50 * 60_000, 'next run an hour later');
});

test('convert a library rule: picked shows plus an "Add new matching shows" assignment', async () => {
  channelsMod.saveSetup('c1', { pool: { sources: [{ id: 'r', kind: 'rule', rule: { networks: ['Cartoon Network'] }, label: 'CN', weight: 2 }], exclusions: [] } });
  const r = await auto.convertRule('c1', 'r');
  assert.equal(r.added, 2);
  assert.deepEqual(r.pool.sources.map(s => [s.kind, s.ref, s.weight]), [['show', 'show1', 2], ['show', 'show2', 2]]);
  assert.equal(r.assignment!.values.networks, 'Cartoon Network');
  assert.equal(r.assignment!.automationName, 'Add new matching shows');
});

test('a smart collection source reads what its saved search matches', async () => {
  const { resolvePool } = await import('../src/pool.ts');
  const r = await resolvePool({ sources: [{ id: 's', kind: 'smart_collection', ref: 'sc1', label: 'Toons', weight: 1 }], exclusions: [] });
  assert.equal(r.items.length, 6);
  assert.deepEqual(r.sources[0].matches!.map(m => m.title), ['Show One', 'Show Two']);
});

test('a channel without pool sources: lineup shows count as on the channel, and they stay when a show is added', async () => {
  for (const id of ['c3', 'c4']) {
    channels.set(id, { id, number: 3, name: `Channel ${id}`, startTime: Date.now(), duration: 0 });
    lineups.set(id, episodes.show1.map(e => ({ type: 'content', id: e.id, duration: e.duration })));
  }
  const code = presets.PRESET_AUTOMATIONS.find(p => p.name === 'Add new matching shows')!.code;
  let r = await auto.testCode({ code, channelId: 'c3', values: { networks: 'Cartoon Network', mode: 'add' } });
  assert.deepEqual(r.changes.map((c: any) => c.detail), [
    'Would turn the 1 shows on the lineup into pool sources first, so they stay',
    'Would add Show Two (2001)',
  ], 'Show One is on the lineup, so only Show Two is new');

  const a = auto.createAutomation({ name: 'Matching (c4)', code });
  const asg = auto.createAssignment('c4', { automationId: a.id, values: { networks: 'Cartoon Network' }, timetable: { kind: 'manual' } });
  r = await waitFor(auto.runNow(asg.id).id);
  const sugg = auto.listSuggestions('c4');
  assert.deepEqual(sugg.map(s => s.ref), ['show2']);
  const approved = await auto.decideSuggestion(sugg[0].id, true);
  assert.equal(approved.converted, 1);
  assert.deepEqual(channelsMod.getSetup('c4').pool.sources.map(s => s.ref), ['show1', 'show2'], 'the lineup show stayed');
});
