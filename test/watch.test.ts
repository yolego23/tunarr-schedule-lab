import { test, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-watch-'));

let watch: typeof import('../src/watch.ts');
let app: typeof import('../src/app-settings.ts');
before(async () => {
  watch = await import('../src/watch.ts');
  app = await import('../src/app-settings.ts');
});

const MIN = 60_000;
const ep = (id: string, start: number, extra: Record<string, unknown> = {}) => ({
  type: 'content', id, duration: 22 * MIN, start, stop: start + 22 * MIN,
  program: { title: `Gumball - S01E0${id.slice(-1)} - Episode ${id}`, show: { title: 'Gumball' } }, ...extra,
});

/** A fake Tunarr: set who's streaming and what's playing, then poll. */
function fakeTracker() {
  const state: { streaming: string[]; playing: Record<string, any> } = { streaming: [], playing: {} };
  const tracker = new watch.WatchTracker({
    sessions: async () => Object.fromEntries(state.streaming.map(id => [id, [{ type: 'hls', state: 'started', numConnections: 1, connections: [{ ip: '10.0.0.5' }] }]])),
    nowPlaying: async id => state.playing[id],
    channelNames: async () => ({ ch1: 'Gumball 24/7', ch2: 'Other' }),
  });
  return { state, tracker };
}

beforeEach(() => {
  watch.deleteWatches({});
  app.resetAppSetting('watchTracker');
});

test('counts an episode once it has streamed 5 minutes, then keeps updating minutes', async () => {
  const { state, tracker } = fakeTracker();
  const t0 = Date.UTC(2026, 8, 21, 19, 0);
  state.streaming = ['ch1'];
  state.playing.ch1 = ep('e1', t0);
  for (let m = 0; m <= 4; m++) await tracker.poll(t0 + m * MIN);
  assert.equal(watch.listWatches({}).length, 0, 'not counted before 5 minutes');
  await tracker.poll(t0 + 5 * MIN);
  let rows = watch.listWatches({}) as any[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].watchedAt, t0);
  assert.equal(rows[0].minutes, 5);
  assert.equal(rows[0].showTitle, 'Gumball');
  assert.equal(rows[0].channelName, 'Gumball 24/7');
  await tracker.poll(t0 + 9 * MIN);
  rows = watch.listWatches({}) as any[];
  assert.equal(rows.length, 1, 'still one watch');
  assert.equal(rows[0].minutes, 7, 'a missed poll counts at most 2 minutes');
  assert.equal(tracker.status().watching[0].counted, true);
});

test('stopping early, flex, and paused streams do not count', async () => {
  const { state, tracker } = fakeTracker();
  const t0 = Date.UTC(2026, 8, 21, 19, 0);
  state.streaming = ['ch1'];
  state.playing.ch1 = ep('e1', t0);
  await tracker.poll(t0);
  await tracker.poll(t0 + 3 * MIN);
  state.streaming = []; // viewer left
  await tracker.poll(t0 + 4 * MIN);
  state.streaming = ['ch1'];
  await tracker.poll(t0 + 5 * MIN);
  await tracker.poll(t0 + 7 * MIN);
  assert.equal(watch.listWatches({}).length, 0, 'the gap restarts the count');
  state.playing.ch1 = { type: 'flex', duration: 10 * MIN };
  for (let m = 8; m < 20; m++) await tracker.poll(t0 + m * MIN);
  assert.equal(watch.listWatches({}).length, 0, 'flex is not an episode');
  state.playing.ch1 = ep('e2', t0 + 20 * MIN, { isPaused: true });
  for (let m = 20; m < 30; m++) await tracker.poll(t0 + m * MIN);
  assert.equal(watch.listWatches({}).length, 0, 'paused time does not count');
});

test('keeps the newest N watches per episode but the total keeps counting', async () => {
  const { state, tracker } = fakeTracker();
  app.saveAppSetting('watchTracker', { enabled: true, minMinutes: 5, keepPerEpisode: 3, maxAgeDays: 0 });
  state.streaming = ['ch1'];
  const day = 86_400_000;
  const base = Date.UTC(2026, 8, 1, 19, 0);
  for (let d = 0; d < 5; d++) {
    const start = base + d * day;
    state.playing.ch1 = ep('e1', start);
    for (let m = 0; m <= 6; m++) await tracker.poll(start + m * MIN);
  }
  const rows = watch.listWatches({ channelId: 'ch1' }) as any[];
  assert.deepEqual(rows.map(r => r.watchedAt), [base + 4 * day, base + 3 * day, base + 2 * day]);
  const h = watch.historyForSort('ch1', ['e1', 'e9']);
  assert.equal(h.channel.e1.total, 5);
  assert.equal(h.channel.e1.last, base + 4 * day);
  assert.equal(h.channel.e1.watches.length, 3);
  assert.equal(h.channel.e9, undefined);
  assert.deepEqual(watch.channelWatchSummary('ch1'), { e1: { total: 5, last: base + 4 * day } });
});

test('history is per channel, with an all-channels view', async () => {
  const { state, tracker } = fakeTracker();
  const t0 = Date.UTC(2026, 8, 21, 19, 0);
  state.streaming = ['ch1', 'ch2'];
  state.playing.ch1 = ep('e1', t0);
  state.playing.ch2 = ep('e1', t0);
  for (let m = 0; m <= 6; m++) await tracker.poll(t0 + m * MIN);
  const h = watch.historyForSort('ch1', ['e1']);
  assert.equal(h.channel.e1.total, 1);
  assert.equal(h.any.e1.total, 2);
  assert.deepEqual(h.any.e1.watches.map(w => w.channelId).sort(), ['ch1', 'ch2']);
});

test('age limit, disabled tracker, and deleting', async () => {
  const { state, tracker } = fakeTracker();
  const now = Date.UTC(2026, 8, 21, 19, 0);
  state.streaming = ['ch1'];
  state.playing.ch1 = ep('e1', now - 40 * 86_400_000);
  for (let m = 0; m <= 6; m++) await tracker.poll(now - 40 * 86_400_000 + m * MIN);
  state.playing.ch1 = ep('e2', now);
  for (let m = 0; m <= 6; m++) await tracker.poll(now + m * MIN);
  app.saveAppSetting('watchTracker', { enabled: true, minMinutes: 5, keepPerEpisode: 5, maxAgeDays: 30 });
  assert.equal(watch.pruneByAge(now), 1);
  assert.deepEqual((watch.listWatches({}) as any[]).map(r => r.programId), ['e2']);

  app.saveAppSetting('watchTracker', { enabled: false, minMinutes: 5, keepPerEpisode: 5, maxAgeDays: 0 });
  state.playing.ch1 = ep('e3', now + 60 * MIN);
  for (let m = 60; m <= 70; m++) await tracker.poll(now + m * MIN);
  assert.equal(watch.listWatches({}).length, 1, 'nothing recorded while off');

  const [row] = watch.listWatches({}) as any[];
  assert.equal(watch.deleteWatches({ id: row.id }), 1);
  assert.deepEqual(watch.channelWatchSummary('ch1'), {});
});

test('a restart mid-episode continues the same watch instead of counting it twice', async () => {
  const t0 = Date.UTC(2026, 8, 21, 19, 0);
  const first = fakeTracker();
  first.state.streaming = ['ch1'];
  first.state.playing.ch1 = ep('e1', t0);
  for (let m = 0; m <= 6; m++) await first.tracker.poll(t0 + m * MIN);
  // Server restarts: a new tracker with no memory, same airing still playing.
  const second = fakeTracker();
  second.state.streaming = ['ch1'];
  second.state.playing.ch1 = ep('e1', t0);
  for (let m = 8; m <= 16; m++) await second.tracker.poll(t0 + m * MIN);
  const rows = watch.listWatches({}) as any[];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].minutes, 14, '6 before the restart + 8 after');
  assert.equal(watch.historyForSort('ch1', ['e1']).channel.e1.total, 1);
});
