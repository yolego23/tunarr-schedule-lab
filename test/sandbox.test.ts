import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSort } from '../src/sandbox/index.ts';

const pool = Array.from({ length: 30 }, (_, i) => ({ id: 'e' + i, type: 'content', title: 'Ep ' + i, showTitle: 'Show ' + (i % 3), episodeLabel: null, durationMs: 1_800_000 }));
const input = (params = {}) => ({ pool, current: pool.slice(0, 5).map(p => ({ id: p.id, type: 'content', durationMs: p.durationMs })), currentPlayingIndex: 0, params, targetMs: 24 * 3_600_000, scheduleStartMs: Date.UTC(2026, 8, 21, 12), channel: { id: 'x', name: 'X', number: 1 }, globals: { householdName: 'Home', budget: 3 } });

test('runs a 1.8-style sort and maps results', async () => {
  const code = `function run(ctx){ const rng = ctx.utils.makeRng(ctx.params.seed||1); const out=[]; let t=0; const list = ctx.utils.shuffle(ctx.pool, rng); for(const it of list){ if(t>=ctx.targetMs) break; out.push(it); t+=it.durationMs; } console.log('made', out.length); return out; }`;
  const r = await runSort(code, input({ seed: 3 }));
  assert.equal(r.items.length, 30 > 48 ? 48 : 30);
  assert.ok('id' in r.items[0]);
  assert.deepEqual(r.logs, ['made 30']);
});

test('blocks escapes, fetch, and host access', async () => {
  const code = `function run(ctx){ const probes = [typeof fetch, typeof process, typeof require, typeof setTimeout,
    (()=>{ try { return typeof ctx.constructor.constructor('return process')() } catch(e) { return 'blocked' } })(),
    (()=>{ try { return typeof ctx.pool.constructor.constructor('return process')() } catch(e) { return 'blocked' } })(),
    (()=>{ try { return typeof ctx.utils.claude.constructor('return process')() } catch(e) { return 'blocked' } })(),
    (()=>{ try { return typeof this.constructor.constructor('return process')() } catch(e) { return 'blocked' } })() ];
    console.log(probes.join(',')); return []; }`;
  const r = await runSort(code, input());
  assert.equal(r.logs[0], 'undefined,undefined,undefined,undefined,blocked,blocked,blocked,blocked');
});

test('stops an endless loop', async () => {
  await assert.rejects(runSort('function run(){ while(true){} }', input()), /longer than 10 seconds/);
});

test('stops an endless async loop', async () => {
  await assert.rejects(runSort('async function run(){ while(true){ await null; } }', input()), /longer than 10 seconds|stopped/);
});

test('reports errors with the sort line', async () => {
  await assert.rejects(runSort('function run(ctx){\n  return ctx.nope.x;\n}', input()), /sort\.js:2/);
});

test('rejects items not from the pool', async () => {
  await assert.rejects(runSort('function run(){ return [{ id: "zzz", title: "fake" }]; }', input()), /not from ctx.pool/);
});

test('flex items, current passthrough, and scoring', async () => {
  const code = `function run(ctx){ return [ctx.current[0], {type:'flex', durationMs: 60000}, ctx.pool[1]]; }`;
  const score = `function score(ctx){ return { total: ctx.list.length, breakdown: { n: ctx.list.length } }; }`;
  const r = await runSort(code, input(), score);
  assert.deepEqual(r.items, [{ id: 'e0' }, { type: 'flex', durationMs: 60000 }, { id: 'e1' }]);
  assert.equal(r.score?.total, 3);
});

test('hours helper', async () => {
  const code = `function run(ctx){ const h = ctx.utils.hours('Mon-Fri 09:00-17:00'); const monNoon = new Date(2026, 8, 21, 12).getTime(); const sunNoon = new Date(2026, 8, 20, 12).getTime();
    console.log(h.isInside(monNoon), h.isInside(sunNoon), h.fractionInside(new Date(2026,8,21,16).getTime(), new Date(2026,8,21,18).getTime())); return []; }`;
  const r = await runSort(code, input());
  assert.equal(r.logs[0], 'true false 0.5');
});

test('sandbox uses the server time zone', async () => {
  const r = await runSort('function run(){ console.log(new Date(2026, 0, 15, 12).getTimezoneOffset(), new Date(2026, 6, 15, 12).getTimezoneOffset()); return []; }', input());
  assert.equal(r.logs[0], `${new Date(2026, 0, 15, 12).getTimezoneOffset()} ${new Date(2026, 6, 15, 12).getTimezoneOffset()}`);
});

test('ctx.globals is readable and frozen', async () => {
  const r = await runSort('function run(ctx){ "use strict"; let err = "none"; try { ctx.globals.budget = 9; } catch (e) { err = "frozen"; } console.log(ctx.globals.householdName, ctx.globals.budget, err); return []; }', input());
  assert.equal(r.logs[0], 'Home 3 frozen');
});

test('a shorter time limit applies', async () => {
  const t0 = Date.now();
  await assert.rejects(runSort('function run(){ while(true){} }', input(), undefined, 1000), /longer than 1 seconds/);
  assert.ok(Date.now() - t0 < 5000);
});
