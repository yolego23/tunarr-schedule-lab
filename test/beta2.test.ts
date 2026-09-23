// 2.1.0-beta.2: AI settings, channel management, guide check. Runs against a
// fake Tunarr and a fake Ollama (both tiny HTTP servers).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

// ---------- fake Tunarr ----------
const REQUIRED_CHANNEL_FIELDS = ['disableFillerOverlay', 'duration', 'groupTitle', 'guideMinimumDuration', 'icon', 'id', 'name', 'number',
  'offline', 'startTime', 'stealth', 'streamMode', 'transcodeConfigId', 'subtitlesEnabled'];
const channels = new Map<string, any>();
const lineups = new Map<string, any[]>();
const calls: string[] = [];
function addChannel(id: string, number: number, name: string) {
  channels.set(id, { id, number, name, groupTitle: 'tunarr', startTime: 1_000_000, duration: 0, icon: {}, offline: { mode: 'pic' }, stealth: false,
    streamMode: 'hls', transcodeConfigId: 'aedd5124-14dc-4c06-bb15-781797a9bcda', subtitlesEnabled: false, disableFillerOverlay: false, guideMinimumDuration: 30000,
    programCount: 0, sessions: [] });
  lineups.set(id, [{ type: 'content', id: 'ep1', duration: 600_000, durationMs: 600_000 }, { type: 'content', id: 'ep2', duration: 600_000, durationMs: 600_000 }]);
}
addChannel('11111111-1111-4111-8111-111111111111', 10, 'Cartoons');
addChannel('22222222-2222-4222-8222-222222222222', 11, 'Movies');

const fakeTunarr = http.createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  const url = new URL(req.url!, 'http://x');
  calls.push(`${req.method} ${url.pathname}`);
  const send = (status: number, data: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
  const m = url.pathname.match(/^\/api\/channels\/([^/]+)(\/.*)?$/);
  if (url.pathname === '/api/channels' && req.method === 'GET') return send(200, [...channels.values()]);
  if (url.pathname === '/api/transcode_configs') return send(200, [{ id: 'aedd5124-14dc-4c06-bb15-781797a9bcda', name: 'Default', isDefault: true }]);
  if (url.pathname === '/api/channels' && req.method === 'POST') {
    const b = JSON.parse(body);
    if (b.type === 'copy') {
      const src = channels.get(b.channelId);
      const id = '33333333-3333-4333-8333-333333333333';
      addChannel(id, 12, `${src.name} - Copy`);
      return send(201, channels.get(id));
    }
    const missing = REQUIRED_CHANNEL_FIELDS.filter(k => b.channel?.[k] === undefined);
    if (b.type !== 'new' || missing.length) return send(400, { message: `missing ${missing.join(',')}` });
    if ('programCount' in b.channel || 'sessions' in b.channel) return send(400, { message: 'unexpected key' });
    channels.set(b.channel.id, { ...b.channel });
    lineups.set(b.channel.id, []);
    return send(201, b.channel);
  }
  if (m && !m[2]) {
    const ch = channels.get(m[1]);
    if (!ch) return send(404, { message: 'no channel' });
    if (req.method === 'GET') return send(200, ch);
    if (req.method === 'PUT') { const b = JSON.parse(body); channels.set(m[1], { ...ch, ...b }); return send(200, channels.get(m[1])); }
    if (req.method === 'DELETE') { channels.delete(m[1]); return send(200, {}); }
  }
  if (m && m[2] === '/programming') {
    if (req.method === 'POST') { lineups.set(m[1], JSON.parse(body).lineup); return send(200, {}); }
    return send(200, { name: channels.get(m[1])?.name, number: channels.get(m[1])?.number, lineup: lineups.get(m[1]) || [], programs: {} });
  }
  send(404, { message: `fake Tunarr has no ${url.pathname}` });
});

// ---------- fake Ollama ----------
let ollamaReplies = 0;
const fakeOllama = http.createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  if (req.url === '/api/tags') { res.end(JSON.stringify({ models: [{ name: 'llama3.2:latest' }, { name: 'qwen3:8b' }] })); return; }
  if (req.url === '/v1/chat/completions') {
    const b = JSON.parse(body);
    ollamaReplies++;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: `echo ${b.model}: ${b.messages.at(-1).content}` } }], usage: { prompt_tokens: 12, completion_tokens: 5 } }));
    return;
  }
  res.writeHead(404); res.end();
});

let ai: typeof import('../src/ai.ts');
let admin: typeof import('../src/channel-admin.ts');
let guide: typeof import('../src/guide-check.ts');
let sandbox: typeof import('../src/sandbox/index.ts');
let ollamaUrl = '';

before(async () => {
  await new Promise<void>(r => fakeTunarr.listen(0, '127.0.0.1', r));
  await new Promise<void>(r => fakeOllama.listen(0, '127.0.0.1', r));
  process.env.TUNARR_URL = `http://127.0.0.1:${(fakeTunarr.address() as AddressInfo).port}`;
  ollamaUrl = `http://127.0.0.1:${(fakeOllama.address() as AddressInfo).port}`;
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-beta2-'));
  ai = await import('../src/ai.ts');
  admin = await import('../src/channel-admin.ts');
  guide = await import('../src/guide-check.ts');
  sandbox = await import('../src/sandbox/index.ts');
});
after(() => { fakeTunarr.close(); fakeOllama.close(); });

test('AI settings: keys are never sent back, and a default provider must be set up', () => {
  assert.throws(() => ai.saveAiConfig({ defaultProvider: 'ollama' }), /isn't fully set up/);
  const pub = ai.saveAiConfig({ anthropic: { apiKey: 'sk-ant-secret-1234' }, ollama: { baseUrl: `${ollamaUrl}/v1/`, model: 'llama3.2:latest' }, defaultProvider: 'ollama' });
  assert.equal(JSON.stringify(pub).includes('secret'), false);
  assert.equal(pub.anthropic.apiKeySet, true);
  assert.equal(pub.anthropic.apiKeyHint, '…1234');
  assert.equal(pub.ollama.baseUrl, ollamaUrl, 'trailing /v1 and slash removed');
  assert.deepEqual(pub.configured, ['anthropic', 'ollama']);
  // Leaving the key out keeps it; an empty string removes it.
  assert.equal(ai.saveAiConfig({ anthropic: { model: 'claude-sonnet-5' } }).anthropic.apiKeySet, true);
  assert.equal(ai.saveAiConfig({ anthropic: { apiKey: '' } }).anthropic.apiKeySet, false);
  assert.throws(() => ai.saveAiConfig({ ollama: { baseUrl: 'not a url' } }), /must look like/);
});

test('AI calls go to the provider, are logged, and respect the allow switches', async () => {
  const r = await ai.ask({ prompt: 'hello', feature: 'sort', channelId: 'c1' });
  assert.equal(r.text, 'echo llama3.2:latest: hello');
  assert.equal(r.provider, 'ollama');
  const [row] = ai.listUsage(1) as any[];
  assert.deepEqual([row.feature, row.channelId, row.provider, row.inputTokens, row.outputTokens, row.costUsd, row.ok], ['sort', 'c1', 'ollama', 12, 5, 0, 1]);
  ai.saveAiConfig({ allow: { sorts: false } });
  assert.equal(ai.aiAvailable('sort'), false);
  await assert.rejects(ai.ask({ prompt: 'x', feature: 'sort' }), /turned off for sorts/);
  ai.saveAiConfig({ allow: { sorts: true } });
  assert.deepEqual(await ai.listModels('ollama'), ['llama3.2:latest', 'qwen3:8b']);
  const t = await ai.testProvider('ollama');
  assert.equal(t.ok, true);
});

test('the monthly cap stops paid providers but not Ollama', async () => {
  const { db } = await import('../src/db.ts');
  db.prepare(`INSERT INTO ai_usage (at, feature, provider, model, cost_usd, ok) VALUES (?, 'sort', 'anthropic', 'claude-opus-5', 5.5, 1)`).run(Date.now());
  ai.saveAiConfig({ monthlyCapUsd: 5, anthropic: { apiKey: 'sk-ant-x', model: 'claude-opus-5' } });
  assert.equal(ai.publicAiConfig().spentThisMonthUsd, 5.5);
  await assert.rejects(ai.ask({ prompt: 'x', feature: 'sort', provider: 'anthropic' }), /spending cap/);
  const before = ollamaReplies;
  await ai.ask({ prompt: 'still fine', feature: 'sort', provider: 'ollama' });
  assert.equal(ollamaReplies, before + 1);
});

test('sorts reach the AI through ctx.ai', async () => {
  const input = { pool: [], current: [], currentPlayingIndex: 0, params: {}, targetMs: 1, scheduleStartMs: 0, channel: { id: 'c1', name: 'C', number: 1 }, globals: {}, aiAvailable: true };
  const code = `async function run(ctx){ console.log(ctx.ai.available, await ctx.ai.ask('pick one'), await ctx.ai.ask({ prompt: 'again', model: 'qwen3:8b' })); return []; }`;
  const r = await sandbox.runSort(code, input, undefined, {
    bridge: async (kind, p) => (await ai.ask({ prompt: p.prompt, model: p.model, feature: 'sort', channelId: 'c1' })).text,
  });
  assert.equal(r.logs[0], 'true echo llama3.2:latest: pick one echo qwen3:8b: again');
  await assert.rejects(sandbox.runSort(`async function run(ctx){ await ctx.ai.ask('x'); return []; }`, input), /AI isn't available/);
});

test('create a channel: every required field, default transcode profile, next free number', async () => {
  const created = await admin.createChannel({ name: '  Saturday Morning ', groupTitle: 'Personal' });
  assert.equal(created.name, 'Saturday Morning');
  assert.equal(created.number, 12);
  assert.equal(created.transcodeConfigId, 'aedd5124-14dc-4c06-bb15-781797a9bcda');
  await assert.rejects(admin.createChannel({ name: 'Dup', number: 10 }), /already taken by "Cartoons"/);
  await assert.rejects(admin.createChannel({ name: '' }), /needs a name/);
  await assert.rejects(admin.createChannel({ name: 'X', number: 0 }), /whole number/);
});

test('rename and renumber keep the rest of the channel', async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  const updated = await admin.updateChannelBasics(id, { name: 'Cartoon Classics', number: 20 });
  assert.equal(updated.name, 'Cartoon Classics');
  assert.equal(updated.number, 20);
  assert.equal(updated.streamMode, 'hls');
  await assert.rejects(admin.updateChannelBasics(id, { number: 11 }), /already taken by "Movies"/);
});

test('copy takes the new name and the source\'s Schedule Lab setup', async () => {
  const { db } = await import('../src/db.ts');
  db.prepare(`INSERT INTO channel_setup (channel_id, sort_id, sort_version, values_json, target_hours, align_start, updated_at) VALUES (?, NULL, NULL, '{"seed":7}', 96, 1, 0)`)
    .run('22222222-2222-4222-8222-222222222222');
  const copy = await admin.copyChannel('22222222-2222-4222-8222-222222222222', { name: 'Movies 2', number: 30 });
  assert.deepEqual([copy.name, copy.number], ['Movies 2', 30]);
  const row = db.prepare('SELECT target_hours, values_json FROM channel_setup WHERE channel_id = ?').get(copy.id) as any;
  assert.deepEqual([row.target_hours, row.values_json], [96, '{"seed":7}']);
});

test('delete archives the channel, and recreate brings it back with its id and lineup', async () => {
  const id = '22222222-2222-4222-8222-222222222222';
  const r = await admin.deleteChannel(id);
  assert.equal(channels.has(id), false);
  const [entry] = admin.listArchive() as any[];
  assert.deepEqual([entry.channelId, entry.name, entry.itemCount], [id, 'Movies', 2]);
  const back = await admin.recreateChannel(r.archiveId);
  assert.equal(back.id, id);
  assert.equal(channels.get(id).number, 11);
  assert.deepEqual(lineups.get(id)!.map((i: any) => i.id), ['ep1', 'ep2']);
  await assert.rejects(admin.recreateChannel(r.archiveId), /already exists/);
});

test('scheduleWindow walks a looping lineup from the channel start time', () => {
  const lineup = [{ type: 'content', id: 'a', duration: 10 }, { type: 'content', id: 'b', duration: 20 }] as any;
  // start 100: a 100-110, b 110-130, a 130-140, b 140-160 ...
  assert.deepEqual(guide.scheduleWindow(lineup, 100, 135, 165).map(e => `${e.id}@${e.start}`), ['a@130', 'b@140', 'a@160']);
  assert.deepEqual(guide.scheduleWindow(lineup, 100, 95, 105).map(e => `${e.id}@${e.start}`), ['b@80', 'a@100']);
});

test('number suggestions follow the group, the copied channel, or the next block of 100', async () => {
  const taken = new Set([...channels.values()].map(c => c.number));
  const byGroup = await admin.suggestNumber({ group: 'tunarr' });
  const groupTop = Math.max(...[...channels.values()].filter(c => c.groupTitle === 'tunarr').map(c => c.number));
  assert.ok(byGroup.number > groupTop && !taken.has(byGroup.number), JSON.stringify(byGroup));
  const afterCopy = await admin.suggestNumber({ afterId: '11111111-1111-4111-8111-111111111111' });
  assert.ok(afterCopy.number > channels.get('11111111-1111-4111-8111-111111111111').number && !taken.has(afterCopy.number));
  addChannel('44444444-4444-4444-8444-444444444444', 212, 'Cartoon Network');
  assert.deepEqual(await admin.suggestNumber({ group: 'Brand new' }), { number: 300, reason: 'start of the next free block of 100 (300)' });
});
