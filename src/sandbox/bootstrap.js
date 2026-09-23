// Evaluated inside the sort sandbox after weekly-hours.js and analysis.js
// (loaded as plain scripts). Builds ctx, calls the sort's run(ctx), and
// returns the result as a JSON string. Only strings cross the boundary.
/* global __input, __run, __score, makeHours, shuffle, makeRng, scoreSchedule, analyzeRepeats, computeNeighborOverlaps */

var __logs = [];
function __fmt(v) {
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch (e) { return String(v); }
}
function __log(level) {
  return function () {
    if (__logs.length >= 300) return;
    __logs.push((level ? level + ': ' : '') + Array.prototype.map.call(arguments, __fmt).join(' ').slice(0, 2000));
  };
}
var console = { log: __log(''), info: __log(''), warn: __log('warn'), error: __log('error'), debug: __log('') };

// ---- bridge to host-side helpers (ctx.utils.claude) ----
var __bridgeQueue = [];
var __bridgeWaiters = new Map();
var __bridgeSeq = 0;
function __bridge(kind, payload) {
  var id = ++__bridgeSeq;
  __bridgeQueue.push(JSON.stringify({ id: id, kind: kind, payload: payload }));
  return new Promise(function (resolve, reject) { __bridgeWaiters.set(id, { resolve: resolve, reject: reject }); });
}
function __bridgeDrain() {
  var q = __bridgeQueue;
  __bridgeQueue = [];
  return JSON.stringify(q);
}
function __bridgeSettle(id, ok, value) {
  var w = __bridgeWaiters.get(id);
  if (!w) return;
  __bridgeWaiters.delete(id);
  if (ok) w.resolve(value); else w.reject(new Error(value));
}

async function __main() {
  var input = JSON.parse(__input);
  if (typeof __run !== 'function') throw new Error('The sort code must define function run(ctx).');

  var byId = new Map();
  input.pool.forEach(function (p) { byId.set(p.id, p); });
  // Lineup entries that are pool episodes are the same objects as in the pool.
  // Anything else (flex, redirect, filler) keeps its place via __ci.
  var current = input.current.map(function (c, i) {
    if (c.id !== undefined && byId.has(c.id)) return byId.get(c.id);
    return { id: c.id, type: c.type, durationMs: c.durationMs, title: '(' + c.type + ')', showTitle: '(' + c.type + ')', episodeLabel: null, __ci: i };
  });

  var utils = {
    shuffle: shuffle,
    makeRng: makeRng,
    scoreSchedule: scoreSchedule,
    hours: makeHours,
    claude: function (opts) { return __bridge('claude', opts || {}); },
  };
  // Watch Tracker data for this channel ({ anyChannel: true } = all channels).
  var H = input.history || { channel: {}, any: {}, lastAired: {} };
  function pickHistory(id, opts) { return (opts && opts.anyChannel ? H.any : H.channel)[id]; }
  var history = {
    lastWatched: function (id, opts) { var e = pickHistory(id, opts); return e ? e.last : null; },
    watches: function (id, opts) { var e = pickHistory(id, opts); return e ? e.watches.map(function (w) { return Object.assign({}, w); }) : []; },
    watchCount: function (id, opts) { var e = pickHistory(id, opts); return e ? e.total : 0; },
    watched: function (id, opts) { var e = pickHistory(id, opts); return e ? e.total : 0; },
    lastAired: function (id) { var t = H.lastAired[id]; return t === undefined ? null : t; },
  };
  var ctx = {
    pool: input.pool,
    current: current,
    currentPlayingIndex: input.currentPlayingIndex,
    params: input.params,
    targetMs: input.targetMs,
    scheduleStart: new Date(input.scheduleStartMs).toISOString(),
    scheduleStartMs: input.scheduleStartMs,
    channel: input.channel,
    globals: Object.freeze(input.globals || {}),
    utils: utils,
    history: history,
  };

  var result = await __run(ctx);
  if (!Array.isArray(result)) throw new Error('run() must return an array of items (got ' + (result === null ? 'null' : typeof result) + ').');
  if (result.length > 200000) throw new Error('run() returned ' + result.length + ' items; the limit is 200,000.');

  var out = [];
  var list = [];
  for (var k = 0; k < result.length; k++) {
    var it = result[k];
    if (!it) continue;
    if (it.type === 'flex') {
      var d = Number(it.durationMs !== undefined ? it.durationMs : it.duration);
      if (!(d > 0)) throw new Error('Item ' + k + ' is a flex item without a positive durationMs.');
      out.push({ type: 'flex', durationMs: d });
      list.push({ type: 'flex', durationMs: d });
      continue;
    }
    if (it.__ci !== undefined) { out.push({ ci: it.__ci }); list.push(it); continue; }
    if (it.id === undefined || !byId.has(it.id)) {
      throw new Error('Item ' + k + ' (' + (it.title || it.id) + ') is not from ctx.pool or ctx.current. Return items from those lists.');
    }
    out.push({ id: it.id });
    list.push(byId.get(it.id));
  }

  var scored = null;
  if (typeof __score === 'function') {
    var analysis = analyzeRepeats(list, input.scheduleStartMs);
    var s = await __score({
      list: list,
      repeatSummary: analysis.summary,
      neighborOverlaps: computeNeighborOverlaps(list),
      targetHours: input.targetMs / 3600000,
      utils: utils,
    });
    if (!s || typeof s.total !== 'number' || !isFinite(s.total)) throw new Error('score() must return { total: number, breakdown }.');
    scored = { total: s.total, breakdown: s.breakdown || {} };
  }
  return JSON.stringify({ items: out, score: scored, logs: __logs });
}
