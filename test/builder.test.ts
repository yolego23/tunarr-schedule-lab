// Channel Builder: draft preview, then create + setup + apply, against a fake Tunarr.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

const channels = new Map<string, any>();
const lineups = new Map<string, any[]>();
channels.set('src', { id: 'src', number: 110, name: 'Batman 24/7', groupTitle: 'DC', startTime: 1, duration: 0, icon: { path: 'https://x/bat.png' },
  watermark: { enabled: true, url: 'https://x/wm.png', position: 'top-right' }, streamMode: 'mpegts', transcodeConfigId: 'aedd5124-14dc-4c06-bb15-781797a9bcda',
  stealth: false, offline: { mode: 'pic' }, disableFillerOverlay: false, guideMinimumDuration: 30000, subtitlesEnabled: false });
lineups.set('src', [{ type: 'content', id: 'b-e1', duration: 1_200_000 }]);
const episodes: Record<string, any[]> = {
  show1: [1, 2, 3].map(i => ({ type: 'content', id: `s1-e${i}`, duration: 1_200_000, program: { uuid: `s1-e${i}`, type: 'episode', title: `Show One - S01E0${i} - Ep ${i}`, showId: 'show1', show: { title: 'Show One' } } })),
  show2: [1, 2].map(i => ({ type: 'content', id: `s2-e${i}`, duration: 1_800_000, program: { uuid: `s2-e${i}`, type: 'episode', title: `Show Two - S01E0${i} - Ep ${i}`, showId: 'show2', show: { title: 'Show Two' } } })),
};

const fake = http.createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  const url = new URL(req.url!, 'http://x');
  const send = (d: unknown, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(d)); };
  const m = url.pathname.match(/^\/api\/channels\/([^/]+)(\/.*)?$/);
  if (url.pathname === '/api/channels' && req.method === 'GET') return send([...channels.values()]);
  if (url.pathname === '/api/channels' && req.method === 'POST') {
    const b = JSON.parse(body);
    channels.set(b.channel.id, b.channel);
    lineups.set(b.channel.id, []);
    return send(b.channel, 201);
  }
  if (url.pathname === '/api/transcode_configs') return send([{ id: 'aedd5124-14dc-4c06-bb15-781797a9bcda', name: 'Default', isDefault: true }]);
  const d = url.pathname.match(/^\/api\/programs\/([^/]+)\/descendants$/);
  if (d) return episodes[d[1]] ? send(episodes[d[1]]) : send({ message: 'none' }, 404);
  if (m && !m[2]) {
    const ch = channels.get(m[1]);
    if (!ch) return send({ message: 'no channel' }, 404);
    if (req.method === 'PUT') { channels.set(m[1], { ...ch, ...JSON.parse(body) }); return send(channels.get(m[1])); }
    return send(ch);
  }
  if (m && m[2] === '/programming') {
    if (req.method === 'POST') { lineups.set(m[1], JSON.parse(body).lineup); return send({}); }
    const programs = Object.fromEntries(Object.values(episodes).flat().filter(e => (lineups.get(m[1]) || []).some((l: any) => l.id === e.id)).map(e => [e.id, e]));
    return send({ name: channels.get(m[1])?.name, number: channels.get(m[1])?.number, lineup: lineups.get(m[1]) || [], programs });
  }
  send({ message: 'no route ' + url.pathname }, 404);
});

let builder: typeof import('../src/builder.ts');
let preview: typeof import('../src/preview.ts');
let sorts: typeof import('../src/sorts.ts');
let channelsMod: typeof import('../src/channels.ts');
before(async () => {
  await new Promise<void>(r => fake.listen(0, '127.0.0.1', r));
  process.env.TUNARR_URL = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-builder-'));
  builder = await import('../src/builder.ts');
  preview = await import('../src/preview.ts');
  sorts = await import('../src/sorts.ts');
  channelsMod = await import('../src/channels.ts');
});
after(() => fake.close());

const pool = { sources: [{ id: 'a', kind: 'show', ref: 'show1', label: 'Show One', weight: 1 }, { id: 'b', kind: 'show', ref: 'show2', label: 'Show Two', weight: 2 }], exclusions: [] };

test('a draft previews from its pool before the channel exists', async () => {
  await assert.rejects(preview.runPreview({ channelId: 'draft', pool: { sources: [] }, code: 'function run(){return []}', targetHours: 1, scheduleStartMs: 0 }), /Add some shows/);
  const r: any = await preview.runPreview({
    channelId: 'draft', pool, targetHours: 2, scheduleStartMs: 0,
    code: 'function run(ctx){ return ctx.pool.slice().sort((a,b)=>b.weight-a.weight); }',
  });
  assert.equal(r.pool.length, 5, 'the draft sends its episodes back for display');
  assert.deepEqual(r.items.slice(0, 2).map((i: any) => i.id), ['s2-e1', 's2-e2'], 'weights reach the sort');
});

test('create: channel with its look, setup with pool and sort, and the previewed lineup applied', async () => {
  const sort = sorts.createSort({ name: 'Straight', code: '/* @settings\nseed: number = 1\n*/\nfunction run(ctx){ return ctx.pool; }' });
  const r0: any = await preview.runPreview({ channelId: 'draft', pool, sortId: sort.id, params: { seed: 4 }, targetHours: 1, scheduleStartMs: Date.now() });
  const r = await builder.createFromBuilder({
    basics: { name: 'Saturday Morning', groupTitle: 'Personal' },
    look: { iconUrl: 'https://x/icon.png', watermarkEnabled: true, watermarkUrl: '', streamMode: 'mpegts', stealth: true, guideFlexTitle: 'Back soon' },
    pool,
    schedule: { sortId: sort.id, sortVersion: 1, values: { seed: 4 }, targetHours: 72, alignStart: true },
    previewId: r0.previewId,
  });
  assert.equal(r.applyError, null);
  const ch = channels.get(r.channel.id);
  assert.equal(ch.name, 'Saturday Morning');
  assert.equal(ch.number, 200, 'Personal is a new group here, so the next block of 100');
  assert.equal(ch.icon.path, 'https://x/icon.png');
  assert.deepEqual([ch.watermark.enabled, ch.streamMode, ch.stealth, ch.guideFlexTitle], [true, 'mpegts', true, 'Back soon']);
  assert.deepEqual(lineups.get(r.channel.id)!.map((l: any) => l.id), ['s1-e1', 's1-e2', 's1-e3', 's2-e1', 's2-e2']);
  const setup = channelsMod.getSetup(r.channel.id);
  assert.deepEqual([setup.sortId, setup.sortVersion, setup.values.seed, setup.targetHours, setup.pool.sources.length], [sort.id, 1, 4, 72, 2]);
});

test('prefill from an existing channel turns its shows into picked sources and copies its look', async () => {
  const p = await builder.prefillFrom('src');
  assert.equal(p.basics.name, 'Batman 24/7 (copy)');
  assert.deepEqual([p.look.iconUrl, p.look.watermarkUrl, p.look.watermarkPosition, p.look.streamMode], ['https://x/bat.png', 'https://x/wm.png', 'top-right', 'mpegts']);
  // Its lineup has one episode whose program isn't known to the fake, so the pool is empty here;
  // a channel with pool sources keeps them as they are.
  channelsMod.saveSetup('src', { pool: { sources: [{ id: 'z', kind: 'show', ref: 'show1', label: 'Show One', weight: 1 }], exclusions: [] } as any });
  const p2 = await builder.prefillFrom('src');
  assert.deepEqual(p2.pool.sources.map(s => s.ref), ['show1']);
});

test('the builder can add automations; a bad timetable stops it before anything is created', async () => {
  const auto = await import('../src/automations.ts');
  const a = auto.createAutomation({ name: 'Rebuild', code: 'async function run(ctx){}' });
  const before = channels.size;
  await assert.rejects(builder.createFromBuilder({ basics: { name: 'Nope' }, pool, schedule: {}, automations: [{ automationId: a.id, timetable: { kind: 'weekly', days: [] } }] }), /at least one day/);
  assert.equal(channels.size, before, 'no channel was created');
  const r = await builder.createFromBuilder({ basics: { name: 'With automation' }, pool, schedule: {}, automations: [{ automationId: a.id, timetable: { kind: 'daily', at: '02:00' }, values: { x: 1 } }] });
  assert.equal(r.automations.length, 1);
  const list = auto.listAssignments(r.channel.id);
  assert.deepEqual([list[0].automationName, list[0].timetable.kind, list[0].values.x], ['Rebuild', 'daily', 1]);
  assert.equal((await builder.prefillFrom(r.channel.id)).automations.length, 1, 'copying the channel in the builder brings its automations');
});
