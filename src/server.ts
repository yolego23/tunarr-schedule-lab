// Schedule Lab 2.0 server: serves the web interface and makes every Tunarr
// call on the browser's behalf. Home network only; no login.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.ts';
import { db, transaction } from './db.ts';
import { tunarr, TunarrError } from './tunarr.ts';
import { getChannelData } from './channel-data.ts';
import { getSetup, listChannels, saveSetup } from './channels.ts';
import {
  HttpError, createSort, deleteSort, duplicateSort, exportSort, getSort, getVersion, importPresets, importSortFile, listSorts, saveVersion, updateSort,
} from './sorts.ts';
import { rankCandidates, runPreview } from './preview.ts';
import { applyPreview, getBackupFile, listBackups, listHistory, restoreBackup, undoLast } from './apply.ts';
import { NEW_SORT_CODE } from './presets.ts';
import { allSettings, resetAppSetting, saveAppSetting } from './app-settings.ts';
import { deleteGlobal, listGlobals, saveGlobal } from './globals.ts';
import { storageStatus } from './storage-check.ts';
import { PROVIDERS, listModels, listUsage, publicAiConfig, saveAiConfig, testProvider, type Provider } from './ai.ts';
import { copyChannel, createChannel, deleteChannel, listArchive, nextFreeNumber, recreateChannel, updateChannelBasics } from './channel-admin.ts';
import { checkGuide } from './guide-check.ts';
import { channelWatchSummary, deleteWatches, listWatches, tracker, watchCounts } from './watch.ts';

const APP_VERSION = JSON.parse(fs.readFileSync(path.join(config.publicDir, '..', 'package.json'), 'utf8')).version as string;

type Params = Record<string, string>;
type Handler = (ctx: { params: Params; query: URLSearchParams; body: any }) => Promise<unknown> | unknown;
const routes: Array<{ method: string; pattern: RegExp; keys: string[]; handler: Handler }> = [];

function route(method: string, pathPattern: string, handler: Handler) {
  const keys: string[] = [];
  const pattern = new RegExp('^' + pathPattern.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, pattern, keys, handler });
}

const num = (v: string) => {
  const n = Number(v);
  if (!Number.isInteger(n)) throw new HttpError(400, `"${v}" is not a valid id.`);
  return n;
};

// ---------- status ----------
route('GET', '/api/status', async () => {
  const status: Record<string, unknown> = {
    tunarrUrl: config.tunarrUrl, tested: config.testedTunarrVersions, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    dataDir: config.dataDir, port: config.port, appVersion: APP_VERSION,
    storage: storageStatus(),
  };
  try {
    const v = await tunarr.version();
    status.connected = true;
    status.version = v.tunarr;
    if (!config.testedTunarrVersions.includes(v.tunarr)) {
      status.warning = `Tunarr ${v.tunarr} hasn't been tested with this version of Schedule Lab (tested: ${config.testedTunarrVersions.join(', ')}). Most things should work; check an Apply carefully.`;
    }
  } catch (err: any) {
    status.connected = false;
    status.error = err.message;
  }
  return status;
});

// ---------- channels ----------
route('GET', '/api/channels', () => listChannels());
route('GET', '/api/channels/:id/data', async ({ params, query }) => {
  const d = await getChannelData(params.id, query.get('fresh') === '1');
  return {
    channelId: d.channelId, name: d.name, number: d.number, startTime: d.startTime, fetchedAt: d.fetchedAt,
    pool: d.pool, current: d.current, totalDurationMs: d.totalDurationMs,
    playingIndex: d.playingIndex, playingOffsetMs: d.playingOffsetMs,
    scheduleType: (d.schedule as any)?.type ?? null,
  };
});
// Channel management (Tunarr channels themselves).
route('POST', '/api/channels', ({ body }) => createChannel(body || {}));
route('GET', '/api/channels/next-number', async () => ({ number: await nextFreeNumber(Math.max(0, ...(await tunarr.channels()).map(c => c.number))) }));
route('GET', '/api/channels/archive', () => listArchive());
route('POST', '/api/channels/archive/:archiveId/recreate', ({ params }) => recreateChannel(num(params.archiveId)));
route('POST', '/api/channels/:id/copy', ({ params, body }) => copyChannel(params.id, body || {}));
route('PUT', '/api/channels/:id/basics', ({ params, body }) => updateChannelBasics(params.id, body || {}));
route('DELETE', '/api/channels/:id', ({ params }) => deleteChannel(params.id));
route('GET', '/api/channels/:id/guide-check', ({ params, query }) => checkGuide(params.id, Math.min(Math.max(Number(query.get('hours')) || 6, 1), 48)));
route('GET', '/api/channels/:id/setup', ({ params }) => getSetup(params.id));
route('PUT', '/api/channels/:id/setup', ({ params, body }) => saveSetup(params.id, body || {}));
route('GET', '/api/filler-lists', () => tunarr.fillerLists());

// ---------- sort library ----------
route('GET', '/api/sorts', () => listSorts());
route('GET', '/api/sorts/template', () => ({ code: NEW_SORT_CODE }));
route('POST', '/api/sorts', ({ body }) => createSort(body || {}));
route('POST', '/api/sorts/import-presets', () => importPresets());
route('POST', '/api/sorts/import', ({ body }) => importSortFile(body));
route('GET', '/api/sorts/:id', ({ params }) => getSort(num(params.id)));
route('PUT', '/api/sorts/:id', ({ params, body }) => updateSort(num(params.id), body || {}));
route('DELETE', '/api/sorts/:id', ({ params }) => { deleteSort(num(params.id)); return { ok: true }; });
route('POST', '/api/sorts/:id/versions', ({ params, body }) => saveVersion(num(params.id), body || {}));
route('GET', '/api/sorts/:id/versions/:v', ({ params }) => getVersion(num(params.id), num(params.v)));
route('POST', '/api/sorts/:id/duplicate', ({ params }) => duplicateSort(num(params.id)));
route('GET', '/api/sorts/:id/export', ({ params }) => exportSort(num(params.id)));

// ---------- preview & compare ----------
route('POST', '/api/run', ({ body }) => runPreview(body || {}));
route('POST', '/api/rank', ({ body }) => rankCandidates(body || {}));

// ---------- apply & history ----------
route('POST', '/api/channels/:id/apply', ({ params, body }) => applyPreview(params.id, String(body?.previewId || ''), body?.alignStart !== false));
route('POST', '/api/channels/:id/undo', ({ params }) => undoLast(params.id));
route('GET', '/api/channels/:id/backups', ({ params }) => listBackups(params.id));
route('GET', '/api/backups/:id', ({ params }) => getBackupFile(num(params.id)));
route('POST', '/api/backups/:id/restore', ({ params }) => restoreBackup(num(params.id)));
route('GET', '/api/history', ({ query }) => listHistory(query.get('channelId') || undefined));

// ---------- watch tracker ----------
route('GET', '/api/watch/status', () => ({ ...tracker.status(), ...watchCounts() }));
route('GET', '/api/watch', ({ query }) => listWatches({
  channelId: query.get('channelId') || undefined, limit: Number(query.get('limit')) || 100, before: Number(query.get('before')) || undefined,
}));
route('GET', '/api/watch/summary/:channelId', ({ params }) => channelWatchSummary(params.channelId));
route('DELETE', '/api/watch/:id', ({ params }) => ({ deleted: deleteWatches({ id: num(params.id) }) }));
route('DELETE', '/api/watch', ({ query }) => ({ deleted: deleteWatches({ channelId: query.get('channelId') || undefined }) }));

// ---------- AI ----------
const providerParam = (p: string) => {
  if (!PROVIDERS.includes(p as Provider)) throw new HttpError(404, `Unknown provider "${p}".`);
  return p as Provider;
};

route('GET', '/api/ai', () => publicAiConfig());
route('PUT', '/api/ai', ({ body }) => saveAiConfig(body || {}));
route('POST', '/api/ai/test/:provider', async ({ params }) => {
  try { return await testProvider(providerParam(params.provider)); }
  catch (err: any) { if (err instanceof HttpError) throw err; return { ok: false, provider: params.provider, error: err.message }; }
});
route('GET', '/api/ai/models/:provider', ({ params }) => listModels(providerParam(params.provider)));
route('GET', '/api/ai/usage', ({ query }) => listUsage(Number(query.get('limit')) || 100));

// ---------- global settings ----------
route('GET', '/api/settings', () => allSettings());
route('PUT', '/api/settings/:key', ({ params, body }) => ({ value: saveAppSetting(params.key, body?.value) }));
route('DELETE', '/api/settings/:key', ({ params }) => ({ value: resetAppSetting(params.key) }));

// ---------- global variables ----------
route('GET', '/api/globals', () => listGlobals());
route('PUT', '/api/globals/:name', ({ params, body }) => saveGlobal(params.name, body || {}));
route('DELETE', '/api/globals/:name', ({ params }) => { deleteGlobal(params.name); return { ok: true }; });

// ---------- export / import everything ----------
route('GET', '/api/export', ({ query }) => {
  const data: Record<string, unknown> = {
    kind: 'schedule-lab-export', formatVersion: 1, exportedAt: Date.now(),
    appSettings: db.prepare('SELECT key, value FROM app_settings').all(),
    sorts: db.prepare('SELECT * FROM sorts').all(),
    sortVersions: db.prepare('SELECT * FROM sort_versions').all(),
    channelSetup: db.prepare('SELECT * FROM channel_setup').all(),
    globalVars: db.prepare('SELECT * FROM global_vars').all(),
    watchEvents: db.prepare('SELECT * FROM watch_events').all(),
    watchTotals: db.prepare('SELECT * FROM watch_totals').all(),
    channelArchive: db.prepare('SELECT * FROM channel_archive').all(),
    applyLog: db.prepare('SELECT * FROM apply_log').all(),
  };
  if (query.get('backups') === '1') data.backups = db.prepare('SELECT * FROM backups').all();
  return data;
});
route('POST', '/api/import', ({ body }) => {
  if (body?.kind !== 'schedule-lab-export') throw new HttpError(400, 'This is not a Schedule Lab export file.');
  const tables: Array<[string, unknown]> = [
    ['app_settings', body.appSettings], ['sorts', body.sorts], ['sort_versions', body.sortVersions],
    ['channel_setup', body.channelSetup], ['global_vars', body.globalVars], ['watch_events', body.watchEvents], ['watch_totals', body.watchTotals], ['channel_archive', body.channelArchive], ['apply_log', body.applyLog], ['backups', body.backups],
  ];
  const counts: Record<string, number> = {};
  transaction(() => {
    // Replaces what's here with the file's contents (backups only if the file has them).
    for (const [table, rows] of tables) {
      if (!Array.isArray(rows)) continue;
      db.exec(`DELETE FROM ${table}`);
      const cols = (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(c => c.name);
      const insert = db.prepare(`INSERT INTO ${table} (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`);
      for (const row of rows as Array<Record<string, any>>) insert.run(...cols.map(c => row[c] ?? null));
      counts[table] = rows.length;
    }
  });
  return { ok: true, counts };
});

// ---------- HTTP plumbing ----------
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json',
};

function sendJson(res: http.ServerResponse, status: number, data: unknown) {
  const body = JSON.stringify(data ?? null);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function serveFile(res: http.ServerResponse, root: string, rel: string): boolean {
  const file = path.resolve(root, '.' + path.posix.normalize('/' + rel));
  if (!file.startsWith(root + path.sep) && file !== root) return false;
  let stat: fs.Stats;
  try { stat = fs.statSync(file); } catch { return false; }
  if (!stat.isFile()) return false;
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
  return true;
}

async function readBody(req: http.IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 100 * 1024 * 1024) throw new HttpError(413, 'Request too large.');
    chunks.push(chunk);
  }
  if (!size) return undefined;
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new HttpError(400, 'Request body is not valid JSON.'); }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', 'http://local');
  const method = req.method || 'GET';
  try {
    if (url.pathname.startsWith('/api/')) {
      for (const r of routes) {
        if (r.method !== method) continue;
        const m = r.pattern.exec(url.pathname);
        if (!m) continue;
        const params: Params = {};
        r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
        const body = method === 'GET' ? undefined : await readBody(req);
        return sendJson(res, 200, await r.handler({ params, query: url.searchParams, body }));
      }
      return sendJson(res, 404, { error: `No such endpoint: ${method} ${url.pathname}` });
    }
    if (method !== 'GET' && method !== 'HEAD') return sendJson(res, 405, { error: 'Method not allowed' });
    if (url.pathname.startsWith('/shared/') && serveFile(res, config.sharedDir, url.pathname.slice('/shared/'.length))) return;
    if (serveFile(res, config.publicDir, url.pathname === '/' ? 'index.html' : url.pathname.slice(1))) return;
    // Screens are client-side routes; hand back the app.
    serveFile(res, config.publicDir, 'index.html');
  } catch (err: any) {
    const status = err instanceof HttpError || err instanceof TunarrError ? err.status : 500;
    if (status >= 500) console.error(`[lab] ${method} ${url.pathname}:`, err);
    if (!res.headersSent) sendJson(res, status, { error: err?.message || String(err) });
    else res.end();
  }
});

server.listen(config.port, '0.0.0.0', () => {
  console.log(`[lab] Schedule Lab 2.0 on http://0.0.0.0:${config.port}/`);
  console.log(`[lab] Tunarr: ${config.tunarrUrl || '(TUNARR_URL not set)'}   Time zone: ${Intl.DateTimeFormat().resolvedOptions().timeZone}`);
  const count = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  const storage = storageStatus();
  console.log(`[lab] Data: ${storage.dbFile}${storage.volume ? ` (volume ${storage.volume})` : ''}: ${count('SELECT count(*) AS n FROM sorts')} sorts, `
    + `${count('SELECT count(*) AS n FROM channel_setup WHERE sort_id IS NOT NULL')} channels with a sort, ${count('SELECT count(*) AS n FROM backups')} backups`);
  if (storage.warning) console.warn(`[lab] WARNING: ${storage.warning}`);
  if (config.tunarrUrl) tracker.start();
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => {
    tracker.stop();
    server.close();
    db.close();
    process.exit(0);
  });
}
