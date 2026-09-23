// The browser code has no build step, so a syntax error only shows up when a
// screen is opened. Check every file here instead.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

function jsFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? jsFiles(p) : e.name.endsWith('.js') ? [p] : [];
  });
}

test('every browser and shared script parses', () => {
  const files = [...jsFiles('public/js'), ...jsFiles('src/shared'), ...jsFiles('src/sandbox')];
  assert.ok(files.length > 20);
  const bad = files.flatMap(f => {
    const r = spawnSync(process.execPath, ['--check', f], { encoding: 'utf8' });
    return r.status === 0 ? [] : [`${f}: ${r.stderr.split('\n').find(l => /Error/.test(l)) || r.stderr}`];
  });
  assert.deepEqual(bad, []);
});
