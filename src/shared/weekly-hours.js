// Weekly hours: the `weekly hours` setting type.
//
// Text form (what is stored), blocks separated by ";" or new lines:
//   Mon,Tue,Thu,Fri 08:00-16:30; Sat 07:00-15:30
//   Daily 22:30-06:00              (an end at or before the start runs overnight)
//   Mon-Fri 06:00-07:00, 17:00-18:00
//   22:30-06:00                    (no days = every day)
// Day words: Sun..Sat (any case, 3+ letters), ranges like Mon-Fri, Daily,
// Weekdays, Weekends.
//
// This file is shared by the server, the browser and the sort sandbox (where
// it is loaded as a plain script), so it must not import anything.

export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAY_INDEX = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
const RANGE_RE = /(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})/g;

function parseDays(text, errors, blockText) {
  const t = String(text || '').trim().toLowerCase();
  if (!t || t === 'daily' || t === 'every day' || t === 'everyday' || t === 'all') return [0, 1, 2, 3, 4, 5, 6];
  if (t === 'weekdays') return [1, 2, 3, 4, 5];
  if (t === 'weekends') return [0, 6];
  const days = new Set();
  for (const part of t.split(/[,\s]+/).filter(Boolean)) {
    const range = part.split('-');
    const a = DAY_INDEX[range[0].slice(0, 3)];
    const b = range.length > 1 ? DAY_INDEX[range[1].slice(0, 3)] : a;
    if (a === undefined || b === undefined) { errors.push(`Unknown day "${part}" in "${blockText}"`); continue; }
    for (let d = a; ; d = (d + 1) % 7) { days.add(d); if (d === b) break; }
  }
  return [...days].sort((x, y) => x - y);
}

/**
 * Parses weekly hours text.
 * Returns { blocks: [{ day, startMin, endMin }], errors }. endMin may exceed
 * 1440 for blocks that run past midnight.
 */
export function parseWeeklyHours(text) {
  const blocks = [];
  const errors = [];
  const parts = String(text || '').split(/[;\n]+/).map(s => s.trim()).filter(Boolean);
  for (const part of parts) {
    const firstRange = part.search(/\d{1,2}:\d{2}/);
    if (firstRange < 0) { errors.push(`No time range in "${part}"`); continue; }
    const days = parseDays(part.slice(0, firstRange), errors, part);
    const rangesText = part.slice(firstRange);
    const leftover = rangesText.replace(RANGE_RE, '').replace(/[,\s]/g, '');
    if (leftover) errors.push(`Could not read "${part}"`);
    for (const m of rangesText.matchAll(RANGE_RE)) {
      const s = Number(m[1]) * 60 + Number(m[2]);
      let e = Number(m[3]) * 60 + Number(m[4]);
      if (s > 1440 || e > 1440 || Number(m[2]) > 59 || Number(m[4]) > 59) { errors.push(`Bad time in "${m[0]}"`); continue; }
      if (e <= s) e += 1440;
      for (const day of days) blocks.push({ day, startMin: s, endMin: e });
    }
  }
  return { blocks, errors };
}

/** 7 x slotsPerDay booleans (Sun first), for the week grid. Overnight blocks spill into the next day. */
export function weeklyHoursToMask(text, slotMinutes = 30) {
  const perDay = Math.round(1440 / slotMinutes);
  const mask = Array.from({ length: 7 }, () => new Array(perDay).fill(false));
  for (const b of parseWeeklyHours(text).blocks) {
    // A slot is on when the block covers its midpoint.
    const first = Math.floor(b.startMin / slotMinutes), last = Math.ceil(b.endMin / slotMinutes);
    for (let k = first; k < last; k++) {
      const mid = k * slotMinutes + slotMinutes / 2;
      if (mid < b.startMin || mid >= b.endMin) continue;
      mask[(b.day + Math.floor(k / perDay)) % 7][k % perDay] = true;
    }
  }
  return mask;
}

const hhmm = min => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

/** Turns a week-grid mask back into text, grouping days that share the same hours. */
export function maskToWeeklyHours(mask, slotMinutes = 30) {
  const rangesByDay = mask.map(row => {
    const ranges = [];
    let start = -1;
    for (let i = 0; i <= row.length; i++) {
      if (i < row.length && row[i]) { if (start < 0) start = i; }
      else if (start >= 0) { ranges.push([start * slotMinutes, i * slotMinutes]); start = -1; }
    }
    return ranges;
  });
  const groups = new Map();
  // Monday first reads more naturally ("Mon,Tue,Thu,Fri").
  for (const day of [1, 2, 3, 4, 5, 6, 0]) {
    if (!rangesByDay[day].length) continue;
    const key = JSON.stringify(rangesByDay[day]);
    if (!groups.has(key)) groups.set(key, { days: [], ranges: rangesByDay[day] });
    groups.get(key).days.push(day);
  }
  const out = [];
  for (const { days, ranges } of groups.values()) {
    let label = days.map(d => DAY_NAMES[d]).join(',');
    let rs = ranges.map(([a, b]) => `${hhmm(a)}-${hhmm(b)}`);
    if (days.length === 7) {
      label = 'Daily';
      // Daily 00:00-06:00, 22:30-24:00 reads better as 22:30-06:00.
      const first = ranges[0], last = ranges[ranges.length - 1];
      if (ranges.length > 1 && first[0] === 0 && last[1] === 1440) {
        rs = [`${hhmm(last[0])}-${hhmm(first[1])}`, ...ranges.slice(1, -1).map(([a, b]) => `${hhmm(a)}-${hhmm(b)}`)];
      }
    }
    out.push(`${label} ${rs.join(', ')}`);
  }
  return out.join('; ');
}

/**
 * The ctx.utils.hours() helper. `specs` is weekly hours text, or an array of
 * them (combined as a union). An array entry can also be
 * { hours: text, padMinutes } to widen each block on both sides.
 *
 * Returns { isInside(t), fractionInside(a, b), msInside(a, b), errors }.
 * Times are epoch ms, read in the server's local time zone.
 */
export function makeHours(specs, options) {
  const list = Array.isArray(specs) ? specs : [specs];
  const defaultPad = Number(options && options.padMinutes) || 0;
  const blocks = [];
  const errors = [];
  for (const s of list) {
    const text = s && typeof s === 'object' ? s.hours : s;
    const pad = s && typeof s === 'object' && s.padMinutes !== undefined ? Number(s.padMinutes) || 0 : defaultPad;
    const parsed = parseWeeklyHours(text);
    errors.push(...parsed.errors);
    for (const b of parsed.blocks) blocks.push({ day: b.day, startMin: b.startMin - pad, endMin: b.endMin + pad });
  }

  // Merged, sorted [start, end) intervals, built a day at a time as needed.
  const DAY = 86400000;
  const intervals = [];
  let fromDay = null, toDay = null; // covered local-midnight range [fromDay, toDay)
  const midnight = t => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
  const nextMidnight = t => { const d = new Date(t); d.setDate(d.getDate() + 1); d.setHours(0, 0, 0, 0); return d.getTime(); };

  function intervalsForDay(dayStart) {
    const out = [];
    const dow = new Date(dayStart).getDay();
    for (const b of blocks) {
      if (b.day !== dow) continue;
      const s = new Date(dayStart); s.setMinutes(b.startMin);
      const e = new Date(dayStart); e.setMinutes(b.endMin);
      out.push([s.getTime(), e.getTime()]);
    }
    return out;
  }
  function rebuild(from, to) {
    // Blocks can reach up to a day before their own date (padding) and past
    // midnight (overnight), so look one day either side.
    const raw = [];
    for (let d = midnight(from - DAY); d < to + DAY; d = nextMidnight(d)) raw.push(...intervalsForDay(d));
    raw.sort((x, y) => x[0] - y[0]);
    intervals.length = 0;
    for (const iv of raw) {
      const last = intervals[intervals.length - 1];
      if (last && iv[0] <= last[1]) last[1] = Math.max(last[1], iv[1]);
      else intervals.push([iv[0], iv[1]]);
    }
    fromDay = from; toDay = to;
  }
  function ensure(a, b) {
    if (fromDay !== null && a >= fromDay && b <= toDay) return;
    const from = midnight(Math.min(a, fromDay ?? a));
    // Grow 14 days past what was asked so a long walk through time rebuilds rarely.
    const to = Math.max(nextMidnight(b), toDay ?? 0) + 14 * DAY;
    rebuild(from, to);
  }
  function msInside(a, b) {
    if (!(b > a) || !blocks.length) return 0;
    ensure(a, b);
    let lo = 0, hi = intervals.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (intervals[mid][1] <= a) lo = mid + 1; else hi = mid; }
    let total = 0;
    for (let i = lo; i < intervals.length && intervals[i][0] < b; i++) {
      total += Math.max(0, Math.min(b, intervals[i][1]) - Math.max(a, intervals[i][0]));
    }
    return total;
  }
  return {
    errors,
    msInside,
    fractionInside(a, b) { return b > a ? msInside(a, b) / (b - a) : (this.isInside(a) ? 1 : 0); },
    isInside(t) { return msInside(t, t + 1) > 0; },
  };
}
