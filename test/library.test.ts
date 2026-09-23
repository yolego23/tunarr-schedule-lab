import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Use a throwaway database.
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-test-'));

let sorts: typeof import('../src/sorts.ts');
let channels: typeof import('../src/channels.ts');
before(async () => {
  sorts = await import('../src/sorts.ts');
  channels = await import('../src/channels.ts');
});

test('import presets once, then skip duplicates', () => {
  const first = sorts.importPresets();
  assert.equal(first.added.length, 5);
  const again = sorts.importPresets();
  assert.equal(again.added.length, 0);
  assert.equal(again.skipped.length, 5);
});

test('saving keeps versions and channels stay on theirs until moved up', () => {
  const s = sorts.listSorts().find(x => x.name === 'No-repeat shuffle')!;
  channels.saveSetup('chan-a', { sortId: s.id, values: { repeatWindowHours: 12 } });
  const code = sorts.getVersion(s.id, 1).code.replace('= 48', '= 24');
  const saved = sorts.saveVersion(s.id, { code, note: 'shorter window' });
  assert.equal(saved.latest_version, 2);
  assert.equal(channels.getSetup('chan-a').sortVersion, 1);
  assert.equal(channels.getSetup('chan-a').values.repeatWindowHours, 12);
  // Same code again: no new version.
  assert.equal(sorts.saveVersion(s.id, { code }).latest_version, 2);
  channels.saveSetup('chan-a', { sortVersion: 2 });
  assert.equal(channels.getSetup('chan-a').sortVersion, 2);
  const run = channels.channelSortValues(channels.getSetup('chan-a'))!;
  assert.equal(run.values.repeatWindowHours, 12); // the channel's own value wins over the new default
});

test('a sort in use cannot be deleted; names are unique', () => {
  const s = sorts.listSorts().find(x => x.name === 'No-repeat shuffle')!;
  assert.throws(() => sorts.deleteSort(s.id), /assigned to 1 channel/);
  assert.throws(() => sorts.createSort({ name: 'no-repeat SHUFFLE', code: 'function run(){return []}' }), /already exists/);
  const copy = sorts.duplicateSort(s.id);
  assert.equal(copy.name, 'No-repeat shuffle copy');
  sorts.deleteSort(copy.id);
});

test('code must define run() and have a valid settings block', () => {
  assert.throws(() => sorts.createSort({ name: 'Bad', code: 'const x = 1;' }), /function run/);
  assert.throws(() => sorts.createSort({ name: 'Bad', code: '/* @settings\nx: colour = 1\n*/ function run(){}' }), /unknown type/);
});

test('sort files round-trip through export and import', () => {
  const s = sorts.listSorts().find(x => x.name === 'Full cycle')!;
  const file = sorts.exportSort(s.id);
  const r = sorts.importSortFile(JSON.parse(JSON.stringify(file)));
  assert.deepEqual(r.added, ['Full cycle (2)']);
});

test('global variables: link, rename follows links, delete refused while linked', async () => {
  const globals = await import('../src/globals.ts');
  globals.saveGlobal('shortWindow', { type: 'number', value: '6', description: 'hours' });
  assert.throws(() => globals.saveGlobal('bad name', { type: 'number', value: 1 }), /letters, numbers/);
  assert.throws(() => globals.saveGlobal('x', { type: 'choice', value: 1 }), /Type must be/);
  channels.saveSetup('chan-a', { values: { repeatWindowHours: { $global: 'shortWindow' } } });
  assert.equal(channels.channelSortValues(channels.getSetup('chan-a'))!.values.repeatWindowHours, 6);
  globals.saveGlobal('shortWindow', { name: 'tinyWindow', value: 3 });
  assert.deepEqual(channels.getSetup('chan-a').values.repeatWindowHours, { $global: 'tinyWindow' });
  assert.equal(channels.channelSortValues(channels.getSetup('chan-a'))!.values.repeatWindowHours, 3);
  assert.throws(() => globals.deleteGlobal('tinyWindow'), /linked from 1 channel/);
  assert.throws(() => globals.saveGlobal('tinyWindow', { type: 'text' }), /type can't change/);
  assert.deepEqual(globals.globalsForSorts(), { tinyWindow: 3 });
  channels.saveSetup('chan-a', { values: {} });
  globals.deleteGlobal('tinyWindow');
  assert.deepEqual(globals.listGlobals(), []);
});

test('app settings are validated and drive channel defaults', async () => {
  const app = await import('../src/app-settings.ts');
  app.saveAppSetting('channelDefaults', { targetHours: 72, alignStart: false });
  assert.equal(channels.getSetup('never-set-up').targetHours, 72);
  assert.equal(channels.getSetup('never-set-up').alignStart, false);
  assert.throws(() => app.saveAppSetting('backupsPerChannel', 0), /between 1 and 100/);
  assert.throws(() => app.saveAppSetting('thresholds', { tight: 100, loose: 50 }), /at least the red/);
  assert.throws(() => app.saveAppSetting('nope', 1), /Unknown setting/);
  assert.equal((app.resetAppSetting('channelDefaults') as { targetHours: number }).targetHours, 168);
});
