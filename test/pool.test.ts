// Pool sources against a fake Tunarr library.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';

// Library: 3 Cartoon Network shows (2 episodes each), 1 Nick show, 1 movie, a custom show.
const shows: Record<string, { title: string; studio: string; seasons: Record<string, string[]> }> = {
  cn1: { title: 'Gumball', studio: 'Cartoon Network', seasons: { 'cn1-s1': ['cn1-e1', 'cn1-e2'] } },
  cn2: { title: 'Chowder', studio: 'Cartoon Network', seasons: { 'cn2-s1': ['cn2-e1'], 'cn2-s2': ['cn2-e2'] } },
  cn3: { title: 'Regular Show', studio: 'Cartoon Network', seasons: { 'cn3-s1': ['cn3-e1', 'cn3-e2'] } },
  nk1: { title: 'Jimmy Neutron', studio: 'Nickelodeon', seasons: { 'nk1-s1': ['nk1-e1', 'nk1-e2'] } },
};
const episode = (showId: string, seasonId: string, id: string) => ({
  type: 'content', id, duration: 600_000,
  program: { uuid: id, type: 'episode', title: `${shows[showId].title} - S01E0${id.slice(-1)} - Ep ${id}`, showId, seasonId, show: { title: shows[showId].title } },
});
const searches: any[] = [];

const fake = http.createServer(async (req, res) => {
  let body = '';
  for await (const c of req) body += c;
  const url = new URL(req.url!, 'http://x');
  const send = (d: unknown) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(d)); };
  if (url.pathname === '/api/programs/search') {
    const b = JSON.parse(body);
    searches.push(b);
    const want = JSON.stringify(b.query.filter).match(/"studio.name","type":"faceted_string","op":"in","value":\[([^\]]*)\]/);
    const networks = want ? JSON.parse(`[${want[1]}]`) : null;
    const all = Object.entries(shows).filter(([, s]) => !networks || networks.includes(s.studio))
      .map(([id, s]) => ({ uuid: id, type: 'show', title: s.title, childCount: Object.keys(s.seasons).length, grandchildCount: 2 }));
    // Like Tunarr 1.3.15: pages start at 0 without search text, at 1 with it. 2 per page to exercise paging.
    const per = 2;
    const withText = all.filter(x => !b.query.query || x.title.toLowerCase().includes(b.query.query.toLowerCase()));
    const index = b.query.query ? b.page - 1 : b.page;
    return send({ results: withText.slice(index * per, index * per + per), page: b.page, totalPages: Math.ceil(withText.length / per), totalHits: withText.length });
  }
  const d = url.pathname.match(/^\/api\/programs\/([^/]+)\/descendants$/);
  if (d) {
    const id = d[1];
    if (shows[id]) return send(Object.entries(shows[id].seasons).flatMap(([sid, eps]) => eps.map(e => episode(id, sid, e))));
    for (const [showId, s] of Object.entries(shows)) if (s.seasons[id]) return send(s.seasons[id].map(e => episode(showId, id, e)));
    if (id === 'mv1') return send([{ type: 'content', id: 'mv1', duration: 5_400_000, program: { uuid: 'mv1', type: 'movie', title: 'The Movie' } }]);
    res.writeHead(404); return res.end('{"message":"no such program"}');
  }
  if (url.pathname === '/api/custom-shows/cs1/programs') {
    return send([{ type: 'custom', id: 'nk1-e1', duration: 600_000, customShowId: 'cs1', index: 0,
      program: { type: 'content', id: 'nk1-e1', duration: 600_000, program: { uuid: 'nk1-e1', title: 'Jimmy Neutron - S01E01 - Ep nk1-e1', show: { title: 'Jimmy Neutron' }, showId: 'nk1' } } }]);
  }
  res.writeHead(404); res.end('{}');
});

let pool: typeof import('../src/pool.ts');
before(async () => {
  await new Promise<void>(r => fake.listen(0, '127.0.0.1', r));
  process.env.TUNARR_URL = `http://127.0.0.1:${(fake.address() as AddressInfo).port}`;
  process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'lab-pool-'));
  pool = await import('../src/pool.ts');
});
after(() => fake.close());

test('cleanPool checks sources, weights and rules', () => {
  assert.throws(() => pool.cleanPool({ sources: [{ kind: 'nope' }] }), /Unknown pool source kind/);
  assert.throws(() => pool.cleanPool({ sources: [{ kind: 'show', label: 'x' }] }), /has no id/);
  assert.throws(() => pool.cleanPool({ sources: [{ kind: 'show', ref: 'a', weight: 500 }] }), /between 0 and 100/);
  assert.throws(() => pool.cleanPool({ sources: [{ kind: 'rule', rule: { types: ['show'] } }] }), /at least one condition/);
  const p = pool.cleanPool({ sources: [{ kind: 'rule', label: 'CN', rule: { networks: ['Cartoon Network'], yearFrom: '1995', bogus: 1 } }] });
  assert.deepEqual(p.sources[0].rule!.networks, ['Cartoon Network']);
  assert.equal(p.sources[0].rule!.yearFrom, 1995);
  assert.equal(p.sources[0].weight, 1);
  assert.ok(p.sources[0].id);
});

test('ruleToFilter builds Tunarr search filters', () => {
  const f = pool.ruleToFilter({ networks: ['CN'], genres: ['Animation'], yearFrom: 1995, yearTo: 2005, addedWithinDays: 30, types: ['show', 'movie'] }, 1_000_000_000_000) as any;
  const keys = f.children.map((c: any) => `${c.fieldSpec.key} ${c.fieldSpec.op} ${JSON.stringify(c.fieldSpec.value)}`);
  assert.deepEqual(keys, [
    'type in ["show","movie"]', 'studio.name in ["CN"]', 'genres.name in ["Animation"]',
    'originalReleaseYear to [1995,2005]', `addedAt >= ${1_000_000_000_000 - 30 * 86_400_000}`,
  ]);
});

test('rules and search read every page, however Tunarr numbers them', async () => {
  searches.length = 0;
  const matches = await pool.ruleMatches({ networks: ['Cartoon Network'] });
  assert.deepEqual(matches.map(m => m.title), ['Gumball', 'Chowder', 'Regular Show']);
  assert.deepEqual(searches.map(s => s.page), [0, 1], 'no text: pages from 0');
  searches.length = 0;
  assert.deepEqual((await pool.ruleMatches({ networks: ['Cartoon Network'], text: 'o' })).map(m => m.title), ['Chowder', 'Regular Show']);
  assert.deepEqual(searches.map(s => s.page), [1], 'with text: pages from 1');
  const page1 = await pool.searchLibrary({ text: 'gumball' });
  assert.deepEqual(page1.hits.map(h => h.title), ['Gumball']);
  assert.deepEqual((await pool.searchLibrary({ types: ['show'], page: 2 })).hits.map(h => h.title), ['Regular Show', 'Jimmy Neutron']);
});

test('resolvePool: union of sources, highest weight wins, labels kept, exclusions applied', async () => {
  const def = pool.cleanPool({
    sources: [
      { kind: 'rule', label: 'CN', rule: { networks: ['Cartoon Network'] }, weight: 1 },
      { kind: 'show', ref: 'cn1', label: 'Gumball', weight: 3 },
      { kind: 'season', ref: 'nk1-s1', label: 'Jimmy S1', weight: 0.5 },
      { kind: 'movie', ref: 'mv1', label: 'The Movie', weight: 1 },
      { kind: 'custom_show', ref: 'cs1', label: 'Nick picks', weight: 2 },
    ],
    exclusions: [{ kind: 'show', id: 'cn3', label: 'Regular Show' }, { kind: 'season', id: 'cn2-s2', label: 'Chowder S2' }],
  });
  const r = await pool.resolvePool(def);
  const byId = new Map(r.items.map(i => [i.id, i]));
  assert.deepEqual([...byId.keys()].sort(), ['cn1-e1', 'cn1-e2', 'cn2-e1', 'mv1', 'nk1-e1', 'nk1-e2']);
  assert.equal(r.excluded, 3); // cn3 x2 + cn2-e2
  assert.equal(byId.get('cn1-e1')!.weight, 3);
  assert.deepEqual(byId.get('cn1-e1')!.sources, ['CN', 'Gumball']);
  assert.equal(byId.get('nk1-e1')!.weight, 2, 'custom show weight beats the season');
  assert.equal(byId.get('nk1-e2')!.weight, 0.5);
  assert.equal(byId.get('mv1')!.durationMs, 5_400_000);
  assert.equal(byId.get('cn1-e1')!.showTitle, 'Gumball');
  assert.equal(byId.get('cn1-e1')!.seasonId, 'cn1-s1');
  const cn = r.sources.find(s => s.label === 'CN')!;
  assert.deepEqual([cn.shows, cn.episodes], [3, 6]);
  assert.equal(cn.matches!.length, 3);
});

test('a broken source is reported without breaking the others', async () => {
  const r = await pool.resolvePool(pool.cleanPool({ sources: [{ kind: 'show', ref: 'gone', label: 'Deleted show' }, { kind: 'show', ref: 'cn1', label: 'Gumball' }] }));
  assert.equal(r.items.length, 2);
  assert.match(r.sources[0].error!, /404/);
});
