// Timeline and repeat ranking views (from 1.8), shared by the Sort Builder
// Compare and the channel's Rebuild and Lineup now tabs.
import { h, escapeHtml, fmtDur } from '../ui.js';
import { analyzeRepeats } from '/shared/analysis.js';

const SHOW_COLORS = ['#5CC8FF', '#FFB454', '#5CFFB4', '#FF8AD8', '#C9A0FF', '#FF8A65'];
export function colorFor(show) {
  let hsh = 0;
  const s = String(show || '');
  for (let i = 0; i < s.length; i++) hsh = (hsh * 31 + s.charCodeAt(i)) >>> 0;
  return SHOW_COLORS[hsh % SHOW_COLORS.length];
}

function tagClass(clockDeltaMin, thresholds) {
  if (clockDeltaMin < thresholds.tight) return 'repeat-tight';
  if (clockDeltaMin < thresholds.loose) return 'repeat-mid';
  return 'repeat-loose';
}

const PAGE = 400;

/**
 * timeline({ items, startMs, thresholds, newAgainst?: Set of ids, nowIndex?, away?: hours helper,
 *            watched?: { [id]: { total, last } } from the Watch Tracker })
 * Renders rows in pages of 400 with a day header whenever the date changes.
 */
export function timeline({ items, startMs, thresholds, newAgainst, nowIndex, away, watched }) {
  if (!items.length) return h('div', { class: 'empty' }, h('b', null, 'Empty lineup'), 'The sort returned no items.');
  const { annotated } = analyzeRepeats(items, startMs);
  const list = h('div', { class: 'tl-list' });
  let shown = 0;
  let lastDay = '';

  const renderPage = () => {
    const end = Math.min(annotated.length, shown + PAGE);
    let html = '';
    for (let i = shown; i < end; i++) {
      const item = annotated[i];
      const at = new Date(item._startMs);
      const day = at.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
      if (day !== lastDay) { html += `<div class="tl-day">${escapeHtml(day)}</div>`; lastDay = day; }
      const time = at.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
      const isAway = away && away.fractionInside(item._startMs, item._startMs + (item.durationMs || 0)) >= 0.5;
      if (item.type === 'flex') {
        html += `<div class="tl-row flex${isAway ? ' away' : ''}"><div class="tc">${time}</div><div class="bar" style="background:#2a3142"></div>
          <div class="title">${escapeHtml(item.title || 'Flex')}</div><div class="dur">${fmtDur(item.durationMs)}</div></div>`;
        continue;
      }
      const isNew = newAgainst && !newAgainst.has(item.id);
      let tags;
      if (item._occurrence === 1) tags = '<span class="tag first-air">1st airing</span>';
      else {
        const cls = tagClass(item._clockDeltaMin, thresholds);
        tags = `<span class="tag ${cls}">↻ ${fmtDur(item._gapMs)} since last</span><span class="tag ${cls}">⏰ ${Math.round(item._clockDeltaMin)}m from last time of day</span>`;
      }
      const w = watched && watched[item.id];
      if (w) tags += `<span class="tag watched" title="Watched ${w.total} time${w.total === 1 ? '' : 's'} on this channel">👁 watched ${escapeHtml(new Date(w.last).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }))}${w.total > 1 ? ` · ${w.total}×` : ''}</span>`;
      const label = item.episodeLabel ? `${item.episodeLabel} · ` : '';
      html += `<div class="tl-row${isNew ? ' is-new' : ''}${i === nowIndex ? ' now' : ''}${isAway ? ' away' : ''}">
        <div class="tc">${time}</div>
        <div class="bar" style="background:${colorFor(item.showTitle)}"></div>
        <div class="title"><div><span class="show">${escapeHtml(item.showTitle)}</span>${label}<span class="ep">${escapeHtml(item.title)}</span>${isNew ? '<span class="badge">NEW</span>' : ''}${i === nowIndex ? '<span class="badge cyan">PLAYING</span>' : ''}</div>
        <div class="meta">${tags}</div></div>
        <div class="dur">${fmtDur(item.durationMs)}</div></div>`;
    }
    list.querySelector('.tl-more')?.remove();
    list.insertAdjacentHTML('beforeend', html);
    shown = end;
    if (shown < annotated.length) {
      list.append(h('div', { class: 'tl-more' },
        h('button', { class: 'btn small', onclick: renderPage }, `Show ${Math.min(PAGE, annotated.length - shown)} more`),
        h('span', { class: 'dim small', style: { marginLeft: '10px' } }, `${shown} of ${annotated.length} shown`)));
    }
  };
  renderPage();
  return list;
}

/** Per-episode repeat table, worst first, with an average row. */
export function repeatRanking({ items, startMs, thresholds }) {
  const { summary } = analyzeRepeats(items, startMs);
  if (!summary.length) return h('div', { class: 'empty' }, h('b', null, 'No repeats'), 'Every episode in this lineup airs once.');
  const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  const rows = summary.slice(0, 1000).map(s => h('tr', null,
    h('td', null, h('span', { style: { color: colorFor(s.showTitle) } }, s.showTitle), ' ', s.episodeLabel ? `${s.episodeLabel} · ` : '', s.title),
    h('td', null, s.count),
    h('td', null, h('span', { class: `tag ${tagClass(s.minClockDeltaMin, thresholds)}` }, fmtDur(s.minGapMs))),
    h('td', null, fmtDur(s.avgGapMs)),
    h('td', null, h('span', { class: `tag ${tagClass(s.minClockDeltaMin, thresholds)}` }, `${Math.round(s.minClockDeltaMin)}m`)),
    h('td', null, `${Math.round(s.avgClockDeltaMin)}m`),
  ));
  return h('div', null,
    h('table', { class: 'grid' },
      h('thead', null, h('tr', null, ['Episode', 'Times aired', 'Shortest gap', 'Avg gap', 'Closest time-of-day Δ', 'Avg time-of-day Δ'].map(t => h('th', null, t)))),
      h('tbody', null,
        h('tr', { class: 'avg-row' },
          h('td', null, `Average across ${summary.length} repeating episode(s)`),
          h('td', null, mean(summary.map(s => s.count)).toFixed(1)),
          h('td', null, fmtDur(mean(summary.map(s => s.minGapMs)))),
          h('td', null, fmtDur(mean(summary.map(s => s.avgGapMs)))),
          h('td', null, `${Math.round(mean(summary.map(s => s.minClockDeltaMin)))}m`),
          h('td', null, `${Math.round(mean(summary.map(s => s.avgClockDeltaMin)))}m`),
        ),
        rows,
      ),
    ),
    h('p', { class: 'dim small', style: { padding: '10px 14px' } },
      'Worst first. A small "closest time-of-day Δ" means the episode keeps landing at nearly the same hour; a small "shortest gap" means it repeats soon.'),
  );
}

/** One-line summary of a lineup. */
export function lineupSummary(items, newAgainst) {
  const total = items.reduce((a, b) => a + (b.durationMs || 0), 0);
  const eps = items.filter(i => i.type !== 'flex');
  const distinct = new Set(eps.map(i => i.id)).size;
  const shows = new Set(eps.map(i => i.showTitle)).size;
  const parts = [`${items.length} items`, fmtDur(total), `${distinct} distinct episodes`, `${shows} show${shows === 1 ? '' : 's'}`];
  if (newAgainst) parts.push(`${eps.filter(i => !newAgainst.has(i.id)).length} not in current lineup`);
  return parts.join(' · ');
}
