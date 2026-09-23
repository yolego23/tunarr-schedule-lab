// Evaluated inside the automation sandbox after weekly-hours.js and
// analysis.js (loaded as plain scripts). Builds ctx and calls the
// automation's run(ctx). Everything that touches Tunarr or the database goes
// through __bridge to the server, which enforces the safety rules; only
// strings cross the boundary.
/* global __input, __run, makeHours, shuffle, makeRng, scoreSchedule */

var __logs = [];
function __fmt(v) {
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch (e) { return String(v); }
}
function __log(level) {
  return function () {
    if (__logs.length >= 500) return;
    __logs.push((level ? level + ': ' : '') + Array.prototype.map.call(arguments, __fmt).join(' ').slice(0, 2000));
  };
}
var console = { log: __log(''), info: __log(''), warn: __log('warn'), error: __log('error'), debug: __log('') };

// ---- bridge to the server ----
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
/** Server helpers answer with JSON. */
function __call(kind, payload) {
  return __bridge(kind, payload === undefined ? {} : payload).then(function (text) { return text === '' ? undefined : JSON.parse(text); });
}

async function __main() {
  var input = JSON.parse(__input);
  if (typeof __run !== 'function') throw new Error('The automation code must define function run(ctx).');

  var H = input.history || { channel: {}, any: {}, lastAired: {} };
  function pickHistory(id, opts) { return (opts && opts.anyChannel ? H.any : H.channel)[id]; }

  var ctx = {
    channel: input.channel,
    params: input.params,
    globals: Object.freeze(input.globals || {}),
    dryRun: !!input.dryRun,
    history: {
      lastWatched: function (id, opts) { var e = pickHistory(id, opts); return e ? e.last : null; },
      watches: function (id, opts) { var e = pickHistory(id, opts); return e ? e.watches.map(function (w) { return Object.assign({}, w); }) : []; },
      watchCount: function (id, opts) { var e = pickHistory(id, opts); return e ? e.total : 0; },
      watched: function (id, opts) { var e = pickHistory(id, opts); return e ? e.total : 0; },
      lastAired: function (id) { var t = H.lastAired[id]; return t === undefined ? null : t; },
    },
    lineup: {
      /** { itemCount, durationMs, daysLeft, remainingMs, startTime, items? } — pass { items: true } for the episodes. */
      current: function (opts) { return __call('lineup.current', opts || {}); },
    },
    /** Runs the channel's sort (or { sort: id, version }) and returns a candidate lineup. */
    build: function (opts) { return __call('build', opts || {}); },
    /** A candidate's score from the scoring function (build computes it). */
    score: function (candidate) { return candidate && candidate.score ? candidate.score.total : null; },
    /** Applies a candidate to this channel (backed up first). Once per run. */
    apply: function (candidate, opts) {
      if (!candidate || !candidate.id) return Promise.reject(new Error('apply() needs a candidate from ctx.build().'));
      return __call('apply', Object.assign({ candidateId: candidate.id }, opts || {}));
    },
    /** Ends the run without changes, with a reason for the run history. */
    skip: function (reason) { return __call('skip', { reason: String(reason || '') }); },
    log: console.log,
    ai: {
      available: !!input.aiAvailable,
      ask: function (opts) {
        if (typeof opts === 'string') opts = { prompt: opts };
        return __bridge('ai', opts || {});
      },
    },
    library: {
      /** Shows or movies matching a rule: { networks, genres, ratings, libraries, yearFrom, yearTo, addedWithinDays, text, types }. */
      search: function (rule) { return __call('library.search', { rule: rule || {} }); },
    },
    pool: {
      get: function () { return __call('pool.get'); },
      /** Adds a source: { kind: 'show' | 'season' | 'movie' | 'custom_show', ref, label, weight? }. */
      add: function (source) { return __call('pool.add', { source: source }); },
      /** Lists a source for approval on the Pool card instead of adding it. */
      suggest: function (source, reason) { return __call('pool.suggest', { source: source, reason: reason || '' }); },
      exclude: function (item) { return __call('pool.exclude', { item: item }); },
      /** Adds the shows on the channel's lineup that aren't pool sources yet; returns { added: [...] }. */
      fromLineup: function (opts) { return __call('pool.fromLineup', opts || {}); },
    },
    channels: {
      list: function () { return __call('channels.list'); },
      get: function (id) { return __call('channels.get', { id: id }); },
    },
    utils: {
      shuffle: shuffle,
      makeRng: makeRng,
      scoreSchedule: scoreSchedule,
      hours: makeHours,
    },
  };

  var result = await __run(ctx);
  var safe;
  try { safe = result === undefined ? null : JSON.parse(JSON.stringify(result)); } catch (e) { safe = String(result); }
  return JSON.stringify({ result: safe, logs: __logs });
}
