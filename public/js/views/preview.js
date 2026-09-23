// Compare: run one or more library sorts on a channel, rank the candidates
// with an editable scoring function, inspect the timeline, and apply one.
// (Everyday rebuilds happen on the channel's Rebuild tab.)
import { api, busy, clear, fmtDur, fromLocalInput, h, nowMinute, toLocalInput, toast } from '../ui.js';
import { channelLabel, currentItems, expandItems, findChannel, globalsMap, loadChannelData, loadChannels, loadGlobals, loadSettings, loadSorts, selectChannel, setUnsaved, store } from '../store.js';
import { codeEditor } from '../components/code-editor.js';
import { lineupSummary, repeatRanking, timeline } from '../components/timeline.js';
import { makeHours } from '/shared/weekly-hours.js';
import { applyPreviewTo } from '../components/rebuild.js';
import { parseSettings, resolveValues } from '/shared/sort-settings.js';
import { DEFAULT_SCORE_CODE } from '/shared/analysis.js';

// Kept while the app is open so switching screens doesn't lose results.
const state = { channelId: '', startMs: 0, hours: 0, include: new Set(), candidates: 0, results: null, selected: 0, view: 'preview' };

export async function render(root, { params, go }) {
  await Promise.all([loadChannels(), loadSorts(), loadSettings(), loadGlobals()]);
  if (!state.candidates) state.candidates = store.settings.candidates;
  const requested = params.get('channel');
  if (requested) { selectChannel(requested); }
  if (state.channelId !== store.selectedChannelId) {
    state.channelId = store.selectedChannelId;
    state.results = null;
    state.include = new Set();
    state.hours = 0;
  }

  const channelSelect = h('select', null, h('option', { value: '' }, '— pick a channel —'),
    store.channels.map(c => h('option', { value: c.id, selected: c.id === state.channelId }, channelLabel(c))));
  const startInput = h('input', { type: 'datetime-local' });
  const hoursInput = h('input', { type: 'number', min: 1, step: 1 });
  const candInput = h('input', { type: 'number', min: 1, max: 30, value: String(state.candidates) });
  const sortList = h('div');
  const runBtn = h('button', { class: 'btn primary' }, 'Run');
  const resultsBox = h('div');
  const right = h('div', { class: 'panel-body', style: { padding: 0 } });
  const summary = h('span', { class: 'pill' });
  const tight = h('input', { type: 'number', min: 0, value: String(store.settings.thresholds.tight), style: { width: '70px' } });
  const loose = h('input', { type: 'number', min: 0, value: String(store.settings.thresholds.loose), style: { width: '70px' } });
  const applyBtn = h('button', { class: 'btn danger', disabled: true }, 'Apply to channel');
  const viewBtns = { preview: 'Preview', current: 'Current lineup', ranking: 'Repeat ranking' };
  const viewEls = Object.entries(viewBtns).map(([k, label]) => h('button', { class: 'btn small', onclick: () => { state.view = k; drawRight(); } }, label));
  let scoreEditor = null;
  let away = null;
  let watched = null; // Watch Tracker summary for this channel

  clear(root, h('div', { class: 'screen three' },
    h('div', { class: 'panel' },
      h('div', { class: 'panel-head' }, 'Compare'),
      h('div', { class: 'panel-body' },
        h('label', { class: 'field' }, h('span', { class: 'lab' }, 'Channel'), channelSelect),
        h('div', { class: 'row' },
          h('label', { class: 'field' }, h('span', { class: 'lab' }, 'Start'),
            h('div', { class: 'btn-row', style: { flexWrap: 'nowrap' } }, startInput,
              h('button', { class: 'btn small ghost', title: 'Now', onclick: () => { state.startMs = nowMinute(); startInput.value = toLocalInput(state.startMs); } }, 'Now'))),
          h('label', { class: 'field', style: { maxWidth: '130px' } }, h('span', { class: 'lab' }, 'Hours'), hoursInput)),
        h('h3', null, 'Sorts to run'),
        sortList,
        h('label', { class: 'field', style: { maxWidth: '220px', marginTop: '10px' } }, h('span', { class: 'lab' }, 'Candidates per sort'), candInput,
          h('span', { class: 'hint' }, 'Sorts with a "seed" setting run once per candidate with different seeds.')),
        h('div', { class: 'btn-row' }, runBtn),
        resultsBox,
        h('details', { class: 'fold' }, h('summary', null, 'Scoring function'),
          h('p', { class: 'dim small', style: { marginTop: '8px' } }, 'Ranks candidates when you compare more than one. Higher is better. Saved for next time.'),
          (scoreEditor = codeEditor({
            value: store.settings.scoreCode, minHeight: 240, onSave: () => saveScore(),
            onChange: v => setUnsaved('scoring', v !== store.settings.scoreCode ? "Compare: the scoring function has changes that aren't saved." : null),
          })),
          h('div', { class: 'btn-row', style: { marginTop: '8px' } },
            h('button', { class: 'btn small', onclick: () => saveScore() }, 'Save scoring'),
            h('button', { class: 'btn small ghost', onclick: async () => {
              const r = await api('DELETE', '/api/settings/scoreCode');
              store.settings.scoreCode = r.value || DEFAULT_SCORE_CODE;
              scoreEditor.setValue(store.settings.scoreCode);
              setUnsaved('scoring', null);
              toast('Scoring reset to the default.', 'ok');
            } }, 'Reset to default'))))),
    h('div', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('div', { class: 'seg' }, viewEls), summary),
      right,
      h('div', { class: 'panel-foot' },
        applyBtn,
        h('span', { class: 'lab', style: { margin: 0 } }, 'Colour: red under'), tight, h('span', { class: 'lab', style: { margin: 0 } }, 'min, green from'), loose,
        h('span', { class: 'lab', style: { margin: 0 } }, 'min')))));

  async function saveScore() {
    try {
      await api('PUT', '/api/settings/scoreCode', { value: scoreEditor.getValue() });
      store.settings.scoreCode = scoreEditor.getValue();
      setUnsaved('scoring', null);
      toast('Scoring function saved.', 'ok');
    } catch (err) { toast(err.message, 'err'); }
  }

  for (const input of [tight, loose]) {
    input.onchange = async () => {
      store.settings.thresholds = { tight: Number(tight.value) || 0, loose: Number(loose.value) || 0 };
      api('PUT', '/api/settings/thresholds', { value: store.settings.thresholds }).catch(err => toast(err.message, 'warn'));
      drawRight();
    };
  }

  // ---------- channel ----------
  async function onChannel() {
    const ch = findChannel(state.channelId);
    if (!state.startMs) state.startMs = nowMinute();
    if (!state.hours) state.hours = ch?.setup.targetHours || 168;
    startInput.value = toLocalInput(state.startMs);
    hoursInput.value = String(state.hours);
    if (ch && !state.include.size && ch.setup.sortId) state.include.add(ch.setup.sortId);
    drawSorts();
    away = null;
    watched = null;
    if (state.channelId) watched = await api('GET', `/api/watch/summary/${encodeURIComponent(state.channelId)}`).catch(() => null);
    if (ch?.setup.sortId) {
      // Shade rows that fall inside the channel's weekly hours settings (e.g. work and sleep).
      try {
        const v = await api('GET', `/api/sorts/${ch.setup.sortId}/versions/${ch.setup.sortVersion}`);
        const { settings } = parseSettings(v.code);
        const values = resolveValues(settings, ch.setup.values, globalsMap());
        const weekly = settings.filter(s => s.type === 'weekly hours').map(s => values[s.key]).filter(Boolean);
        if (weekly.length) away = { helper: makeHours(weekly), labels: settings.filter(s => s.type === 'weekly hours').map(s => s.label) };
      } catch { /* shading is optional */ }
    }
    drawRight();
  }
  channelSelect.onchange = () => {
    state.channelId = channelSelect.value;
    selectChannel(state.channelId);
    state.results = null; state.include = new Set(); state.hours = 0;
    drawResults();
    onChannel();
  };
  startInput.onchange = () => { state.startMs = fromLocalInput(startInput.value); };
  hoursInput.oninput = () => { state.hours = Number(hoursInput.value) || 168; };
  candInput.oninput = () => { state.candidates = Math.max(1, Math.min(30, Number(candInput.value) || 1)); };

  function drawSorts() {
    const ch = findChannel(state.channelId);
    if (!store.sorts.length) {
      clear(sortList, h('p', { class: 'dim small' }, 'The library is empty. ', h('a', { href: '#/library' }, 'Import or create sorts'), ' first.'));
      return;
    }
    clear(sortList, store.sorts.map(s => {
      const own = ch && ch.setup.sortId === s.id;
      return h('label', { class: 'check' },
        h('input', { type: 'checkbox', checked: state.include.has(s.id), onchange: e => { e.target.checked ? state.include.add(s.id) : state.include.delete(s.id); } }),
        h('span', null, s.name, ' ',
          own ? h('span', { class: 'pill info' }, `this channel's sort · v${ch.setup.sortVersion} · its settings`) : h('span', { class: 'dim small' }, `v${s.latest_version} · default settings`)));
    }));
  }

  // ---------- run ----------
  runBtn.onclick = () => busy(runBtn, async () => {
    if (!state.channelId) { toast('Pick a channel first.', 'warn'); return; }
    const entries = [...state.include].filter(id => store.sorts.some(s => s.id === id));
    if (!entries.length) { toast('Tick at least one sort.', 'warn'); return; }
    const ch = findChannel(state.channelId);
    const data = await loadChannelData(state.channelId);
    const staleMs = Date.now() - state.startMs;
    if (staleMs > 60 * 60_000) toast(`The start time is ${fmtDur(staleMs)} in the past. Click "Now" if you meant to start from now.`, 'warn', 8000);
    if (entries.length === 1 && state.candidates === 1) {
      const sortId = entries[0];
      const r = await api('POST', '/api/run', {
        channelId: state.channelId, sortId,
        sortVersion: ch?.setup.sortId === sortId ? ch.setup.sortVersion : undefined,
        targetHours: state.hours, scheduleStartMs: state.startMs,
      });
      state.results = { candidates: [r], notes: [], data };
    } else {
      const r = await api('POST', '/api/rank', {
        channelId: state.channelId, entries: entries.map(sortId => ({ sortId })), candidates: state.candidates,
        scoreCode: scoreEditor.getValue(), targetHours: state.hours, scheduleStartMs: state.startMs,
      });
      state.results = { ...r, data };
      if (r.notes.length) toast(r.notes.join(' '), 'warn');
    }
    state.selected = state.results.candidates.findIndex(c => !c.error);
    if (state.selected < 0) state.selected = 0;
    state.view = 'preview';
    drawResults();
    drawRight();
  });

  function drawResults() {
    const res = state.results;
    if (!res) { clear(resultsBox); return; }
    const withScores = res.candidates.some(c => c.score);
    const keys = [];
    res.candidates.forEach(c => c.score && Object.keys(c.score.breakdown).forEach(k => { if (!keys.includes(k)) keys.push(k); }));
    clear(resultsBox, h('h3', null, `Results (${res.candidates.length})`),
      h('div', { class: 'table-wrap' }, h('table', { class: 'grid' },
        h('thead', null, h('tr', null, h('th', null, 'Candidate'), withScores ? h('th', null, 'Score') : null, keys.map(k => h('th', null, k)), h('th', null, 'Lineup'))),
        h('tbody', null, res.candidates.map((c, i) => c.error
          ? h('tr', null, h('td', null, c.label), h('td', { colspan: keys.length + 2, class: 'err-text small', style: { whiteSpace: 'pre-wrap' } }, c.error))
          : h('tr', { class: `${i === 0 && withScores ? 'best' : ''}${i === state.selected ? ' selected' : ''}`, style: { cursor: 'pointer' }, onclick: () => { state.selected = i; state.view = 'preview'; drawResults(); drawRight(); } },
              h('td', null, i === state.selected ? '▶ ' : '', c.label),
              withScores ? h('td', { class: 'mono', style: { color: 'var(--cyan)' } }, c.score ? c.score.total.toFixed(2) : '—') : null,
              keys.map(k => h('td', { class: 'mono small' }, c.score?.breakdown[k] ?? '—')),
              h('td', { class: 'small dim' }, `${c.items.length} · ${fmtDur(c.durationMs)}`)))))));
  }

  function drawRight() {
    Object.keys(viewBtns).forEach((k, i) => viewEls[i].classList.toggle('active', state.view === k));
    const thresholds = store.settings.thresholds;
    const res = state.results;
    const cand = res?.candidates[state.selected];
    applyBtn.disabled = !cand || !!cand.error || !!cand.applied || state.channelId === 'sample';
    applyBtn.textContent = cand?.applied ? 'Applied' : 'Apply to channel';
    if (!state.channelId) {
      clear(right, h('div', { class: 'empty' }, h('b', null, 'Pick a channel'), 'Choose a channel, tick the sorts to try, and click Run.'));
      summary.textContent = '';
      return;
    }
    const legend = away ? h('div', { class: 'tl-day', style: { color: 'var(--text-dim)', position: 'static' } }, `Shaded rows fall inside: ${away.labels.join(', ')}`) : null;
    if (state.view === 'current') {
      loadChannelData(state.channelId).then(data => {
        if (state.view !== 'current') return;
        // Show the lineup from what's playing now.
        const all = currentItems(data);
        const items = all.slice(data.playingIndex).concat(all.slice(0, data.playingIndex));
        const startMs = Date.now() - data.playingOffsetMs;
        summary.textContent = `${lineupSummary(items)} · from what's playing now`;
        clear(right, legend, timeline({ items, startMs, thresholds, nowIndex: 0, away: away?.helper, watched }));
      }).catch(err => clear(right, h('div', { class: 'empty' }, h('b', null, 'Could not load the lineup'), err.message)));
      clear(right, h('div', { class: 'empty' }, h('span', { class: 'spinner' }), ' Loading lineup…'));
      return;
    }
    if (!cand || cand.error) {
      summary.textContent = '';
      clear(right, h('div', { class: 'empty' }, h('b', null, 'No preview yet'), 'Tick one or more sorts and click Run.'));
      return;
    }
    const items = expandItems(res.data, cand.items);
    const currentIds = new Set(res.data.current.map(c => c.id));
    summary.textContent = `${cand.label} · ${lineupSummary(items, currentIds)}`;
    clear(right, legend, state.view === 'ranking'
      ? repeatRanking({ items, startMs: cand.scheduleStartMs, thresholds })
      : timeline({ items, startMs: cand.scheduleStartMs, thresholds, newAgainst: currentIds, away: away?.helper, watched }));
  }

  applyBtn.onclick = () => busy(applyBtn, async () => {
    const cand = state.results?.candidates[state.selected];
    const ch = findChannel(state.channelId);
    if (!cand || cand.error || !ch) return;
    const r = await applyPreviewTo(ch, cand);
    if (!r) return;
    cand.applied = true;
    await loadChannels(true);
    toast('Undo it, restore a backup or check the guide on History.', '', 8000);
    drawRight();
  });

  drawResults();
  await onChannel();
  if (params.get('run') === '1' && state.channelId && state.include.size && !state.results) runBtn.click();
}
