// Channel setup, sorts, settings and variables must survive a server restart
// (which is what a container update is, as long as /data is kept).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-persist-'));
const port = 20000 + Math.floor(Math.random() * 20000);
const base = `http://127.0.0.1:${port}`;

async function startServer(): Promise<ChildProcess> {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/server.ts'], {
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(port), TUNARR_URL: 'http://127.0.0.1:9' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/api/sorts`)).ok) return child; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 100));
  }
  child.kill();
  throw new Error('server did not start');
}

async function stopServer(child: ChildProcess) {
  const exited = new Promise(r => child.once('exit', r));
  child.kill('SIGTERM');
  await exited;
}

const call = async (method: string, p: string, body?: unknown) => {
  const res = await fetch(base + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data;
};

test('everything saved is still there after a restart', async () => {
  let server = await startServer();
  await call('POST', '/api/sorts/import-presets');
  const sorts = await call('GET', '/api/sorts');
  const work = sorts.find((s: any) => s.name === 'Work-schedule sort');
  await call('PUT', '/api/globals/houseHours', { type: 'weekly hours', value: 'Mon-Fri 09:00-17:00' });
  await call('PUT', '/api/channels/chan-1/setup', {
    sortId: work.id, values: { workHours: { $global: 'houseHours' }, bufferMin: 15 }, targetHours: 96, alignStart: false,
  });
  await call('PUT', '/api/settings/backupsPerChannel', { value: 7 });
  await stopServer(server);

  server = await startServer();
  try {
    const setup = await call('GET', '/api/channels/chan-1/setup');
    assert.equal(setup.sortId, work.id);
    assert.equal(setup.sortVersion, 1);
    assert.deepEqual(setup.values, { workHours: { $global: 'houseHours' }, bufferMin: 15 });
    assert.equal(setup.targetHours, 96);
    assert.equal(setup.alignStart, false);
    assert.equal((await call('GET', '/api/sorts')).length, 5);
    assert.equal((await call('GET', '/api/settings')).backupsPerChannel, 7);
    assert.equal((await call('GET', '/api/globals'))[0].value, 'Mon-Fri 09:00-17:00');
  } finally {
    await stopServer(server);
  }
});
