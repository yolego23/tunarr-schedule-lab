// Guide check: after an Apply, is Tunarr playing what was applied, and has
// the guide file TV apps download (XMLTV) caught up? Tunarr 1.3.15 can't be
// told to rebuild its guide, so this only reports.
import { db } from './db.ts';
import { tunarr, type LineupItem } from './tunarr.ts';

db.exec(`
CREATE TABLE IF NOT EXISTS guide_expectations (
  channel_id TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  label      TEXT NOT NULL,
  items_json TEXT NOT NULL
);
`);

const HOUR = 3_600_000;

/** Start times and ids of what should air in [from, to), for a looping lineup. */
export function scheduleWindow(lineup: LineupItem[], startTime: number, from: number, to: number) {
  const durations = lineup.map(i => Number(i.duration ?? i.durationMs) || 0);
  const total = durations.reduce((a, b) => a + b, 0);
  const out: Array<{ start: number; id: string | null; type: string }> = [];
  if (!lineup.length || !(total > 0)) return out;
  let offset = (from - startTime) % total;
  if (offset < 0) offset += total;
  let i = 0;
  while (offset >= durations[i]) { offset -= durations[i]; i = (i + 1) % lineup.length; }
  let t = from - offset;
  while (t < to && out.length < 5000) {
    out.push({ start: Math.round(t), id: (lineup[i].id as string) ?? null, type: lineup[i].type });
    t += durations[i];
    i = (i + 1) % lineup.length;
  }
  return out;
}

/** Remembers what should air for the next two days after an apply, undo or restore. */
export function recordExpectation(channelId: string, label: string, lineup: LineupItem[], startTime: number) {
  const now = Date.now();
  const items = scheduleWindow(lineup, startTime, now, now + 48 * HOUR);
  db.prepare(`INSERT INTO guide_expectations (channel_id, created_at, label, items_json) VALUES (?, ?, ?, ?)
    ON CONFLICT(channel_id) DO UPDATE SET created_at = excluded.created_at, label = excluded.label, items_json = excluded.items_json`)
    .run(channelId, now, label, JSON.stringify(items));
}

// "20260923114202 +0000" -> ms
function xmltvTime(s: string): number {
  const m = /^(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)\s*([+-])(\d\d)(\d\d)$/.exec(s.trim());
  if (!m) return NaN;
  const utc = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  const off = (+m[8] * 60 + +m[9]) * 60_000 * (m[7] === '+' ? 1 : -1);
  return utc - off;
}

export interface GuideCheck {
  checkedAt: number;
  window: { from: number; to: number };
  expected: { source: 'applied' | 'lineup'; label: string; count: number };
  tunarr: { matched: number; total: number; firstMismatchAt: number | null };
  xmltv: { found: boolean; matched: number; total: number; builtAt: number | null };
  verdict: 'ok' | 'guide-behind' | 'mismatch' | 'no-data';
  message: string;
}

/**
 * Compares the next `hours` of expected airings with Tunarr's schedule and
 * with the XMLTV file. Expected = what Schedule Lab last applied (if within
 * two days), else the channel's current lineup.
 */
export async function checkGuide(channelId: string, hours = 6): Promise<GuideCheck> {
  const now = Date.now();
  const from = now, to = now + hours * HOUR;
  const tolerance = 90_000;

  const [ch, guideRows, lastRefresh] = await Promise.all([
    tunarr.channel(channelId),
    tunarr.guide(channelId, from, to).catch(() => [] as Awaited<ReturnType<typeof tunarr.guide>>),
    tunarr.xmltvLastRefresh().catch(() => null),
  ]);

  let expected: Array<{ start: number; id: string | null }>;
  let source: 'applied' | 'lineup' = 'lineup';
  let label = 'the channel\'s current lineup';
  const saved = db.prepare('SELECT created_at, label, items_json FROM guide_expectations WHERE channel_id = ?').get(channelId) as
    { created_at: number; label: string; items_json: string } | undefined;
  if (saved && saved.created_at > now - 47 * HOUR) {
    expected = (JSON.parse(saved.items_json) as Array<{ start: number; id: string | null }>).filter(e => e.start < to && e.start >= from - 12 * HOUR);
    source = 'applied';
    label = saved.label;
  } else {
    const prog = await tunarr.programming(channelId);
    expected = scheduleWindow(prog.lineup || [], Number(ch.startTime), from, to);
  }
  // Only what starts inside the window (plus what's on now).
  const nowItem = [...expected].reverse().find(e => e.start <= from);
  expected = expected.filter(e => e.start >= from || e === nowItem);

  // Tunarr's own schedule.
  const tunarrStarts = new Map(guideRows.map(g => [Math.round(g.startTimeMs), (g.lineupItem?.id as string) ?? null]));
  let tMatched = 0;
  let firstMismatchAt: number | null = null;
  for (const e of expected) {
    const hit = [...tunarrStarts.entries()].find(([s]) => Math.abs(s - e.start) <= tolerance);
    if (hit && hit[1] === e.id) tMatched++;
    else if (firstMismatchAt === null) firstMismatchAt = e.start;
  }

  // The XMLTV file TV apps read. Programmes are matched by start time.
  let found = false, xMatched = 0, xTotal = 0;
  try {
    const xml = await tunarr.xmltv();
    const idMatch = new RegExp(`<channel id="([^"]+)"><display-name>${ch.number}\\s`).exec(xml);
    if (idMatch) {
      found = true;
      const cid = idMatch[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const starts: number[] = [];
      for (const m of xml.matchAll(new RegExp(`<programme start="([^"]+)" stop="[^"]+" channel="${cid}"`, 'g'))) {
        const s = xmltvTime(m[1]);
        if (s >= from - 12 * HOUR && s < to) starts.push(s);
      }
      for (const e of expected) {
        if (e.id === null) continue; // flex and redirects aren't separate guide entries
        xTotal++;
        if (starts.some(s => Math.abs(s - e.start) <= tolerance)) xMatched++;
      }
    }
  } catch { /* reported as not found */ }

  const total = expected.length;
  let verdict: GuideCheck['verdict'];
  let message: string;
  if (!total) { verdict = 'no-data'; message = 'Nothing is scheduled in the next few hours to compare.'; }
  else if (tMatched < total) {
    verdict = 'mismatch';
    message = `Tunarr's schedule differs from ${label} from ${new Date(firstMismatchAt!).toLocaleString()}. Something else may have changed the channel since.`;
  } else if (!found || xMatched < xTotal) {
    verdict = 'guide-behind';
    message = `Tunarr is playing ${label}, but the TV guide file hasn't caught up yet${lastRefresh?.value ? ` (last built ${new Date(lastRefresh.value).toLocaleString()})` : ''}. Tunarr rebuilds it on its own schedule.`;
  } else {
    verdict = 'ok';
    message = `Tunarr and the TV guide file both match ${label} for the next ${hours} hours.`;
  }
  return {
    checkedAt: now,
    window: { from, to },
    expected: { source, label, count: total },
    tunarr: { matched: tMatched, total, firstMismatchAt },
    xmltv: { found, matched: xMatched, total: xTotal, builtAt: lastRefresh?.value ?? null },
    verdict,
    message,
  };
}
