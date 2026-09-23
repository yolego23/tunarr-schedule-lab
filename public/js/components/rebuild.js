// Building and applying a channel's lineup where you are: the Rebuild and
// Lineup now tabs on the Channels screen, the quick Rebuild button, and the
// apply / undo / guide-check pieces that Compare and History share.
import { api, busy, clear, confirmDialog, fmtAgo, fmtDur, fmtWhen, fromLocalInput, h, nowMinute, toLocalInput, toast } from '../ui.js';
import { currentItems, expandItems, forgetChannelData, globalsMap, loadChannelData, store } from '../store.js';
import { lineupSummary, repeatRanking, timeline } from './timeline.js';
import { makeHours } from '/shared/weekly-hours.js';
import { parseSettings, resolveValues } from '/shared/sort-settings.js';

// ---------- apply, undo ----------
/**
 * Confirms and applies a preview ({ previewId, label, items, durationMs,
 * scheduleStartMs }) to a channel. Returns Tunarr's result, or null if cancelled.
 */
export async function applyPreviewTo(ch, preview, { alignStart = ch.setup.alignStart } = {}) {
  const data = await loadChannelData(ch.id).catch(() => null);
  const staleMs = Date.now() - preview.scheduleStartMs;
  const lines = [
    `Replace the lineup on ${ch.number} ${ch.name}` + (data ? ` (${data.current.length} items, ${fmtDur(data.totalDurationMs)})` : '') + ' with:',
    `  ${preview.label}: ${preview.items.length} items, ${fmtDur(preview.durationMs)}, starting ${fmtWhen(preview.scheduleStartMs)}.`,
    '',
    'The current lineup is backed up first, so you can undo this.',
  ];
  if (!preview.items.length) { toast('The preview is empty; there is nothing to apply.', 'warn'); return null; }
  if (data && preview.durationMs < data.totalDurationMs * 0.5) {
    lines.push('', `Note: the new lineup is much shorter than the current one. Tunarr repeats it every ${fmtDur(preview.durationMs)}.`);
  }
  if (data?.scheduleType) lines.push('', `This replaces the lineup Tunarr generated from its "${data.scheduleType}" slot schedule with a fixed one.`);
  if (alignStart && staleMs > 60 * 60_000) lines.push('', `The preview starts ${fmtDur(staleMs)} ago, so the channel will pick up partway through it.`);
  for (const w of preview.warnings || []) lines.push('', `Warning: ${w}`);
  if (!(await confirmDialog({ title: `Apply to ${ch.name}`, message: lines.join('\n'), confirmLabel: 'Apply', danger: true }))) return null;
  const r = await api('POST', `/api/channels/${encodeURIComponent(ch.id)}/apply`, { previewId: preview.previewId, alignStart });
  report(r, 'Applied');
  forgetChannelData(ch.id);
  return r;
}

export async function undoLast(ch) {
  const ok = await confirmDialog({
    title: 'Undo last change',
    message: `Put ${ch.name} back the way it was before its most recent apply, undo or restore?\n\nThe lineup as it is now is backed up first, so this can be undone too.`,
    confirmLabel: 'Undo',
  });
  if (!ok) return null;
  const r = await api('POST', `/api/channels/${encodeURIComponent(ch.id)}/undo`);
  report(r, 'Undone');
  forgetChannelData(ch.id);
  return r;
}

export function report(r, verb) {
  toast(`${verb}: ${r.itemCount} items, ${fmtDur(r.durationMs)}. Backup #${r.backupId} saved first.`, 'ok', 7000);
  for (const w of r.warnings || []) toast(w, 'warn', 12000);
}

// ---------- guide check ----------
const guideResults = new Map(); // channelId -> last result (kept while the app is open)

/** A card that compares the next 6 hours of what was applied with Tunarr's guide. el.run() checks now. */
export function guideCheckCard(channelId) {
  const card = h('div', { class: 'card' });
  const run = async (button) => {
    const go = async () => {
      draw(true);
      try { guideResults.set(channelId, await api('GET', `/api/channels/${encodeURIComponent(channelId)}/guide-check?hours=6`)); }
      catch (err) { guideResults.set(channelId, { verdict: 'error', message: err.message }); }
      draw();
    };
    return button ? busy(button, go) : go();
  };
  function draw(checking = false) {
    const r = guideResults.get(channelId);
    const btn = h('button', { class: 'btn small' }, 'Check guide');
    btn.onclick = () => run(btn);
    const pill = !r ? null
      : h('span', { class: `pill ${r.verdict === 'ok' ? 'ok' : r.verdict === 'guide-behind' ? 'warn' : r.verdict === 'no-data' ? '' : 'err'}` },
          { ok: 'guide matches', 'guide-behind': 'guide not updated yet', mismatch: 'schedule differs', 'no-data': 'nothing to compare', error: 'check failed' }[r.verdict] || r.verdict);
    clear(card,
      h('div', { class: 'card-head' }, h('h3', null, 'Guide check'), h('div', { class: 'btn-row' }, pill, btn)),
      checking ? h('p', { class: 'dim small' }, h('span', { class: 'spinner' }), ' Checking the next 6 hours…')
        : r ? h('div', null,
            h('p', { class: 'small' }, r.message),
            r.tunarr ? h('div', { class: 'stat' }, h('span', null, "Tunarr's schedule"), h('span', { class: 'v' }, `${r.tunarr.matched} of ${r.tunarr.total} airings match`)) : null,
            r.xmltv ? h('div', { class: 'stat' }, h('span', null, 'TV guide file (XMLTV)'), h('span', { class: 'v' },
              r.xmltv.found ? `${r.xmltv.matched} of ${r.xmltv.total} match${r.xmltv.builtAt ? ` · built ${fmtAgo(r.xmltv.builtAt)}` : ''}` : 'channel not in the file')) : null,
            r.checkedAt ? h('p', { class: 'dim small', style: { marginTop: '6px' } }, `Checked ${fmtAgo(r.checkedAt)}. Tunarr rebuilds the guide file on its own schedule; it can't be triggered from the API.`) : null)
        : h('p', { class: 'dim small' }, "Compares the next 6 hours of what was applied with Tunarr's schedule and with the guide file TV apps download."));
  }
  draw();
  card.run = () => run();
  return card;
}

// ---------- timeline extras ----------
/** Shading for the channel's weekly-hours settings (work, sleep) and its watch history. */
export async function channelExtras(ch) {
  let away = null, watched = null;
  watched = await api('GET', `/api/watch/summary/${encodeURIComponent(ch.id)}`).catch(() => null);
  if (ch.setup.sortId && ch.setup.sortVersion) {
    try {
      const v = await api('GET', `/api/sorts/${ch.setup.sortId}/versions/${ch.setup.sortVersion}`);
      const { settings } = parseSettings(v.code);
      const values = resolveValues(settings, ch.setup.values, globalsMap());
      const weekly = settings.filter(s => s.type === 'weekly hours').map(s => values[s.key]).filter(Boolean);
      if (weekly.length) away = { helper: makeHours(weekly), labels: settings.filter(s => s.type === 'weekly hours').map(s => s.label) };
    } catch { /* shading is optional */ }
  }
  return { away, watched };
}

const awayLegend = away => (away ? h('div', { class: 'tl-day', style: { color: 'var(--text-dim)', position: 'static' } }, `Shaded rows fall inside: ${away.labels.join(', ')}`) : null);

// ---------- quick rebuild ----------
/** Builds a lineup with the channel's own sort and settings, then asks to apply it. */
export async function quickRebuild(ch) {
  if (!ch.setup.sortId) { toast(`${ch.name} has no sort yet. Pick one on its Setup tab.`, 'warn'); return null; }
  const r = await api('POST', '/api/run', {
    channelId: ch.id, sortId: ch.setup.sortId, sortVersion: ch.setup.sortVersion,
    targetHours: ch.setup.targetHours, scheduleStartMs: nowMinute(),
  });
  return applyPreviewTo(ch, r);
}

// ---------- Rebuild tab ----------
// Built previews survive switching tabs, channels and screens (not a reload).
const built = new Map(); // channelId -> { result, snapshot, applied? }

const snapshotOf = s => JSON.stringify({ sortId: s.sortId, sortVersion: s.sortVersion, values: s.values, targetHours: s.targetHours, pool: s.pool });

/**
 * rebuildTab({ ch, setup, saveFirst, go, onApplied }) -> element.
 * `setup` is the channel page's live setup (unsaved edits included);
 * saveFirst() pushes pending edits to the server before a build.
 */
export function rebuildTab({ ch, setup, saveFirst, go, onApplied }) {
  const el = h('div');
  const startInput = h('input', { type: 'datetime-local', value: toLocalInput(nowMinute()) });
  let view = 'timeline';
  let extras = null;
  channelExtras(ch).then(x => { extras = x; draw(); });

  async function build(kind) {
    await saveFirst();
    if (!setup.sortId) { toast('Pick a sort on the Setup tab first.', 'warn'); return; }
    const startMs = fromLocalInput(startInput.value) || nowMinute();
    const base = { channelId: ch.id, sortId: setup.sortId, sortVersion: setup.sortVersion, targetHours: setup.targetHours, scheduleStartMs: startMs };
    let result;
    if (kind === 'best') {
      const r = await api('POST', '/api/rank', { ...base, entries: [{ sortId: setup.sortId, sortVersion: setup.sortVersion }], candidates: store.settings.candidates, scoreCode: store.settings.scoreCode });
      if (r.notes.length) toast(r.notes.join(' '), 'warn', 8000);
      result = r.candidates.find(c => !c.error);
      if (!result) throw new Error(r.candidates[0]?.error || 'Every candidate failed.');
      result.note = `best of ${r.candidates.length} by score`;
    } else if (kind === 'seed') {
      const seed = Math.floor(Math.random() * 1_000_000);
      result = await api('POST', '/api/run', { ...base, params: { ...setup.values, seed } });
      result.note = `seed ${seed}`;
    } else {
      result = await api('POST', '/api/run', base);
    }
    built.set(ch.id, { result, snapshot: snapshotOf(setup), data: await loadChannelData(ch.id) });
    draw();
  }

  function draw() {
    const b = built.get(ch.id);
    const sort = setup.sortId ? store.sorts?.find(s => s.id === setup.sortId) : null;
    const hasSeed = !!sort?.settings?.some(s => s.key === 'seed');
    const btn = (label, kind, primary) => { const x = h('button', { class: `btn ${primary ? 'primary' : ''}`, disabled: !setup.sortId }, label); x.onclick = () => busy(x, () => build(kind)); return x; };

    const head = h('div', { class: 'card' },
      h('div', { class: 'row', style: { alignItems: 'flex-end' } },
        h('div', { class: 'field' }, h('span', { class: 'lab' }, 'Sort'),
          h('div', null, sort ? `${sort.name} v${setup.sortVersion}` : h('span', { class: 'warn-text' }, 'none: pick one on the Setup tab'), h('span', { class: 'dim small' }, ` · ${fmtDur(setup.targetHours * 3_600_000)}`))),
        h('label', { class: 'field', style: { maxWidth: '260px' } }, h('span', { class: 'lab' }, 'Starts'),
          h('div', { class: 'btn-row', style: { flexWrap: 'nowrap' } }, startInput,
            h('button', { class: 'btn small ghost', onclick: () => { startInput.value = toLocalInput(nowMinute()); } }, 'Now')))),
      h('div', { class: 'btn-row' },
        btn('Build preview', 'one', true),
        btn(`Build ${store.settings.candidates}, keep the best`, 'best'),
        h('button', { class: 'btn ghost', onclick: async () => { await saveFirst(); go('preview', { channel: ch.id }); } }, 'Compare sorts…')));

    if (!b) {
      clear(el, head, h('div', { class: 'card' }, h('p', { class: 'dim' }, 'Build a preview to see the new lineup here before applying it. The channel keeps playing its current lineup until you apply.')));
      return;
    }
    const { result, data } = b;
    const stale = b.snapshot !== snapshotOf(setup);
    const items = expandItems(data, result.items);
    const currentIds = new Set(data.current.map(c => c.id));
    const viewBox = h('div', { style: { maxHeight: '60vh', overflowY: 'auto' } });
    const tabs = ['timeline', 'ranking'].map(v => h('button', { class: 'btn small' + (view === v ? ' active' : ''), onclick: () => { view = v; draw(); } }, v === 'timeline' ? 'Timeline' : 'Repeat ranking'));
    clear(viewBox, awayLegend(extras?.away), view === 'ranking'
      ? repeatRanking({ items, startMs: result.scheduleStartMs, thresholds: store.settings.thresholds })
      : timeline({ items, startMs: result.scheduleStartMs, thresholds: store.settings.thresholds, newAgainst: currentIds, away: extras?.away?.helper, watched: extras?.watched }));

    const applyBtn = h('button', { class: 'btn danger', disabled: stale || !!b.applied }, b.applied ? 'Applied' : `Apply to ${ch.name}`);
    applyBtn.onclick = () => busy(applyBtn, async () => {
      const r = await applyPreviewTo(ch, result, { alignStart: setup.alignStart });
      if (!r) return;
      b.applied = { at: Date.now(), backupId: r.backupId };
      draw();
      onApplied?.();
    });
    const undoBtn = h('button', { class: 'btn' }, 'Undo');
    undoBtn.onclick = () => busy(undoBtn, async () => { if (await undoLast(ch)) { built.delete(ch.id); draw(); onApplied?.(); } });
    const guide = b.applied ? guideCheckCard(ch.id) : null;
    if (guide && !b.guideRan) { b.guideRan = true; setTimeout(() => guide.run(), 3000); }

    clear(el, head,
      h('div', { class: 'card', style: { padding: 0 } },
        h('div', { class: 'card-head', style: { padding: '10px 14px' } },
          h('div', { class: 'btn-row' },
            h('span', { class: 'pill ok' }, lineupSummary(items, currentIds)),
            result.score ? h('span', { class: 'pill', title: 'From the scoring function (Compare)' }, `score ${result.score.total.toFixed(1)}`) : null,
            h('span', { class: 'dim small' }, `${result.label}${result.note ? ' · ' + result.note : ''} · starts ${fmtWhen(result.scheduleStartMs)}`)),
          h('div', { class: 'seg' }, tabs)),
        stale ? h('p', { class: 'warn-text small', style: { padding: '0 14px' } }, 'The setup changed after this preview was built (sort, settings, pool or length). Build again before applying.') : null,
        (result.warnings || []).map(w => h('p', { class: 'warn-text small', style: { padding: '0 14px' } }, w)),
        viewBox,
        h('div', { class: 'panel-foot' },
          b.applied
            ? h('div', { class: 'btn-row' }, h('span', { class: 'pill ok' }, `Applied ${fmtAgo(b.applied.at)} · backup #${b.applied.backupId}`), undoBtn)
            : h('div', { class: 'btn-row' }, applyBtn, hasSeed ? btn('Try another seed', 'seed') : null),
          h('a', { href: '#', class: 'small', onclick: e => { e.preventDefault(); go('history', { channel: ch.id }); } }, 'Backups and history →'))),
      guide);
  }
  draw();
  el.refresh = draw;
  return el;
}

// ---------- Lineup now tab ----------
export function lineupTab(ch) {
  const el = h('div', null, h('div', { class: 'card' }, h('div', { class: 'dim small' }, h('span', { class: 'spinner' }), ' Loading lineup…')));
  Promise.all([loadChannelData(ch.id), channelExtras(ch)]).then(([d, extras]) => {
    const shows = new Set(d.pool.map(p => p.showTitle)).size;
    const playing = d.current[d.playingIndex];
    const playingItem = playing?.id ? d.byId.get(playing.id) : null;
    const all = currentItems(d);
    const items = all.slice(d.playingIndex).concat(all.slice(0, d.playingIndex));
    clear(el,
      h('div', { class: 'card' },
        h('div', { class: 'stat' }, h('span', null, 'Lineup'), h('span', { class: 'v' }, `${d.current.length} items · ${fmtDur(d.totalDurationMs)}`)),
        h('div', { class: 'stat' }, h('span', null, 'Episode pool'), h('span', { class: 'v' }, `${d.pool.length} episodes · ${shows} show${shows === 1 ? '' : 's'}`)),
        h('div', { class: 'stat' }, h('span', null, 'Lineup started'), h('span', { class: 'v' }, fmtWhen(d.startTime))),
        playingItem ? h('div', { class: 'stat' }, h('span', null, 'Playing now'), h('span', { class: 'v' }, `${playingItem.showTitle} · ${playingItem.episodeLabel ? playingItem.episodeLabel + ' · ' : ''}${playingItem.title}`)) : null,
        d.scheduleType ? h('p', { class: 'small warn-text', style: { marginTop: '10px' } },
          `This lineup was generated in Tunarr by a "${d.scheduleType}" slot schedule. Applying from Schedule Lab replaces it with a fixed lineup; a backup is taken first so it can be restored.`) : null),
      h('div', { class: 'card', style: { padding: 0 } },
        h('div', { class: 'card-head', style: { padding: '10px 14px' } }, h('span', { class: 'pill' }, `${lineupSummary(items)} · from what's playing now`)),
        h('div', { style: { maxHeight: '65vh', overflowY: 'auto' } }, awayLegend(extras.away),
          timeline({ items, startMs: Date.now() - d.playingOffsetMs, thresholds: store.settings.thresholds, nowIndex: 0, away: extras.away?.helper, watched: extras.watched }))));
  }).catch(err => clear(el, h('div', { class: 'card' }, h('p', { class: 'err-text small' }, err.message))));
  return el;
}
