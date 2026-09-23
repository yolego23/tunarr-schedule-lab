// Automations: what's scheduled and queued, the Automation Library (code
// with versions, like sorts), run history, and the editor with dry-run tests.
import { api, busy, clear, confirmDialog, download, fmtAgo, fmtWhen, h, modal, pickJsonFile, promptDialog, slug, toast } from '../ui.js';
import { channelLabel, findChannel, loadChannels, loadGlobals, setUnsaved, store } from '../store.js';
import { codeEditor } from '../components/code-editor.js';
import { settingsForm } from '../components/settings-form.js';
import { describeTimetable, runBody, showRun, statusPill } from '../components/automations.js';
import { parseSettings } from '/shared/sort-settings.js';

const chName = id => { const c = findChannel(id); return c ? `${c.number} ${c.name}` : id; };

export async function render(root, { params, go }) {
  await Promise.all([loadChannels().catch(() => null), loadGlobals(true)]);
  const edit = params.get('edit');
  if (edit) return renderEditor(root, { id: edit === 'new' ? null : Number(edit), go });

  const page = h('div', { class: 'page-width' });
  clear(root, h('div', { class: 'scroll-page' }, page));
  const overview = h('div', { class: 'card' });
  const libraryCard = h('div', { class: 'card', style: { padding: 0 } });
  const runsCard = h('div', { class: 'card' });
  clear(page,
    h('h2', null, 'Automations'),
    h('p', { class: 'dim' }, 'Automations are code, like sorts: they rebuild lineups on a timetable, look for new shows, ask the AI for help if you let them, and more. Add them to channels on the Channels screen, where each channel gets its own settings and timetable. An automation can read every channel but only changes its own.'),
    overview, libraryCard, runsCard);

  let timer = null;
  async function drawOverview() {
    let s;
    try { s = await api('GET', '/api/automations/status'); } catch (err) { clear(overview, h('p', { class: 'err-text' }, err.message)); return; }
    const cfg = s.settings;
    clear(overview,
      h('div', { class: 'card-head' }, h('h3', null, 'Schedule'),
        h('div', { class: 'btn-row' },
          cfg.enabled ? h('span', { class: 'pill ok' }, 'timetables on') : h('span', { class: 'pill warn' }, 'timetables off'),
          h('span', { class: 'dim small' }, `window ${cfg.windowStart}–${cfg.windowEnd} · ${cfg.concurrency} at a time · ${cfg.timeLimitSec}s limit`),
          h('button', { class: 'btn small ghost', onclick: () => go('settings') }, 'Change in Settings'))),
      s.queue.length ? [h('span', { class: 'lab' }, 'Queue'),
        h('table', { class: 'grid' }, h('tbody', null, s.queue.map(r => h('tr', { class: 'clickable', onclick: () => showRun(r.id) },
          h('td', null, statusPill(r)), h('td', null, r.automationName), h('td', { class: 'small' }, chName(r.channelId)),
          h('td', { class: 'small dim' }, r.status === 'queued' && r.notBefore > Date.now() ? 'retry ' + fmtWhen(r.notBefore) : r.trigger)))))] : null,
      h('span', { class: 'lab' }, 'Coming up'),
      s.upcoming.length
        ? h('table', { class: 'grid' }, h('tbody', null, s.upcoming.map(a => h('tr', null,
            h('td', { class: 'small mono' }, fmtWhen(a.nextRunAt)),
            h('td', null, a.automationName, h('span', { class: 'dim mono' }, ` v${a.version}`)),
            h('td', { class: 'small' }, h('a', { href: '#', onclick: e => { e.preventDefault(); store.selectedChannelId = a.channelId; go('channels'); } }, chName(a.channelId))),
            h('td', { class: 'small dim' }, describeTimetable(a.timetable))))))
        : h('p', { class: 'dim small' }, 'Nothing scheduled. Add an automation to a channel on the Channels screen.'));
    clearTimeout(timer);
    timer = setTimeout(() => { if (overview.isConnected) { drawOverview(); drawRuns(); } }, s.queue.length ? 3000 : 30000);
  }

  async function drawLibrary() {
    const list = await api('GET', '/api/automations');
    const toolbar = h('div', { class: 'btn-row' },
      h('button', { class: 'btn small primary', onclick: () => go('automations', { edit: 'new' }) }, '+ New automation'),
      h('button', { class: 'btn small', onclick: e => busy(e.currentTarget, async () => {
        const r = await api('POST', '/api/automations/import-presets');
        const parts = [r.added.length ? `Imported ${r.added.join(', ')}.` : '', r.updated.length ? `New version of ${r.updated.join(', ')} (channels move up to it under their Settings).` : ''].filter(Boolean);
        toast(parts.length ? parts.join(' ') : 'The starter automations are already in the library and up to date.', parts.length ? 'ok' : 'warn', 9000);
        drawLibrary();
      }) }, 'Import starter automations'),
      h('button', { class: 'btn small', onclick: async () => {
        const data = await pickJsonFile();
        if (!data) return;
        try { const r = await api('POST', '/api/automations/import', data); toast(r.added.length ? `Added ${r.added.join(', ')}.` : 'No automations in that file.', r.added.length ? 'ok' : 'warn'); drawLibrary(); } catch (err) { toast(err.message, 'err'); }
      } }, 'Import from file'),
      list.length ? h('button', { class: 'btn small ghost', onclick: async () => {
        const all = await Promise.all(list.map(a => api('GET', `/api/automations/${a.id}/export`)));
        download(`schedule-lab-automations-${new Date().toISOString().slice(0, 10)}.json`, { kind: 'schedule-lab-automations', formatVersion: 1, automations: all });
      } }, 'Export all') : null);
    clear(libraryCard,
      h('div', { class: 'card-head', style: { padding: '12px 14px 0' } }, h('h3', null, 'Automation Library'), toolbar),
      list.length
        ? h('div', { class: 'table-wrap' }, h('table', { class: 'grid' },
            h('thead', null, h('tr', null, ['Automation', 'Latest', 'Settings', 'Channels', ''].map(t => h('th', null, t)))),
            h('tbody', null, list.map(a => h('tr', null,
              h('td', null, h('b', null, a.name), a.description ? h('div', { class: 'dim small' }, a.description) : null),
              h('td', { class: 'mono' }, `v${a.latest_version}`),
              h('td', { class: 'small' }, a.settings.length ? a.settings.map(x => x.key).join(', ') : h('span', { class: 'dim' }, 'none')),
              h('td', { class: 'small' }, a.usedBy.length ? a.usedBy.map(u => h('div', { class: u.enabled ? '' : 'dim' }, chName(u.channelId), ' ',
                h('span', { class: `mono ${u.version < a.latest_version ? 'warn-text' : 'dim'}` }, `v${u.version}`), u.enabled ? '' : ' (off)')) : h('span', { class: 'dim' }, 'none')),
              h('td', { class: 'actions' },
                h('button', { class: 'btn small primary', onclick: () => go('automations', { edit: a.id }) }, 'Edit'),
                h('button', { class: 'btn small', onclick: e => busy(e.currentTarget, async () => { const c = await api('POST', `/api/automations/${a.id}/duplicate`); toast(`Created "${c.name}".`, 'ok'); drawLibrary(); }) }, 'Duplicate'),
                h('button', { class: 'btn small', onclick: async () => {
                  const name = await promptDialog({ title: 'Rename automation', label: 'Name', value: a.name });
                  if (!name || name === a.name) return;
                  try { await api('PUT', `/api/automations/${a.id}`, { name }); drawLibrary(); } catch (err) { toast(err.message, 'err'); }
                } }, 'Rename'),
                h('button', { class: 'btn small', onclick: async () => { try { download(`automation-${slug(a.name)}.json`, await api('GET', `/api/automations/${a.id}/export`)); } catch (err) { toast(err.message, 'err'); } } }, 'Export'),
                h('button', { class: 'btn small ghost', onclick: async () => {
                  if (!(await confirmDialog({ title: 'Delete automation', message: `Delete "${a.name}" and all its versions? This can't be undone.`, confirmLabel: 'Delete', danger: true }))) return;
                  try { await api('DELETE', `/api/automations/${a.id}`); toast(`Deleted "${a.name}".`, 'ok'); drawLibrary(); } catch (err) { toast(err.message, 'err'); }
                } }, 'Delete')))))))
        : h('div', { class: 'empty' }, h('b', null, 'The library is empty'),
            'Import the starter automations (weekly rebuild, rebuild when running low, best of several, AI picks the best, AI review before applying, add new matching shows), or write your own.'));
  }

  const runFilter = h('select', { onchange: () => drawRuns() }, h('option', { value: '' }, 'All channels'),
    (store.channels || []).map(c => h('option', { value: c.id }, channelLabel(c))));
  async function drawRuns() {
    const q = new URLSearchParams({ limit: '100' });
    if (runFilter.value) q.set('channelId', runFilter.value);
    const runs = await api('GET', '/api/automations/runs?' + q).catch(() => []);
    clear(runsCard,
      h('div', { class: 'card-head' }, h('h3', null, 'Run history'), runFilter),
      runs.length
        ? h('div', { class: 'table-wrap' }, h('table', { class: 'grid' },
            h('thead', null, h('tr', null, ['', 'When', 'Automation', 'Channel', 'Result'].map(t => h('th', null, t)))),
            h('tbody', null, runs.map(r => h('tr', { class: 'clickable', onclick: () => showRun(r.id) },
              h('td', null, statusPill(r)),
              h('td', { class: 'small', title: new Date(r.finishedAt || r.queuedAt).toLocaleString() }, fmtAgo(r.finishedAt || r.queuedAt)),
              h('td', { class: 'small' }, r.automationName, r.version ? h('span', { class: 'dim mono' }, ` v${r.version}`) : null, h('div', { class: 'dim small' }, r.trigger)),
              h('td', { class: 'small' }, r.channelName || chName(r.channelId)),
              h('td', { class: 'small dim' }, r.message.slice(0, 200)))))))
        : h('p', { class: 'dim small' }, 'No runs yet.'));
  }

  await Promise.all([drawOverview(), drawLibrary(), drawRuns()]);
  return () => clearTimeout(timer);
}

// ---------- editor ----------
// The draft survives switching screens.
let draft = null; // { id, baseVersion, name, description, code, savedCode, channelId, values }

async function renderEditor(root, { id, go }) {
  if (!draft || draft.id !== id || id === null && draft.id !== null) {
    if (id) {
      const a = await api('GET', `/api/automations/${id}`);
      const v = await api('GET', `/api/automations/${id}/versions/${a.latest_version}`);
      draft = { id, baseVersion: a.latest_version, name: a.name, description: a.description, code: v.code, savedCode: v.code, channelId: draft?.channelId || '', values: {} };
    } else if (!draft || draft.id !== null) {
      const { code } = await api('GET', '/api/automations/template');
      draft = { id: null, baseVersion: 0, name: '', description: '', code, savedCode: code, channelId: draft?.channelId || '', values: {} };
    }
  }
  const unsavedKey = 'automation-editor';
  const markUnsaved = () => setUnsaved(unsavedKey, draft.code !== draft.savedCode ? `Automation "${draft.name || 'new'}" has unsaved code.` : null);

  const nameInput = h('input', { type: 'text', value: draft.name, placeholder: 'Automation name', oninput: e => { draft.name = e.target.value; } });
  const descInput = h('input', { type: 'text', value: draft.description, placeholder: 'What it does, in a sentence', oninput: e => { draft.description = e.target.value; } });
  const testForm = h('div');
  const result = h('div');
  let lastKeys = '';
  const drawTestForm = () => {
    const { settings, errors } = parseSettings(draft.code);
    const keys = JSON.stringify(settings) + errors.join();
    if (keys === lastKeys) return;
    lastKeys = keys;
    clear(testForm,
      errors.length ? h('p', { class: 'err-text small' }, errors.join('; ')) : null,
      settings.length ? [h('span', { class: 'lab' }, 'Test values'),
        settingsForm({ settings, values: draft.values, globals: store.globals || [], emptyText: '', onChange: v => { draft.values = v; } })] : null);
  };
  const editor = codeEditor({ value: draft.code, onChange: v => { draft.code = v; markUnsaved(); drawTestForm(); }, onSave: () => save(), minHeight: 420 });

  const channelSelect = h('select', { onchange: async e => {
    draft.channelId = e.target.value;
    // Start from the channel's own values if this automation is on it.
    if (draft.id && draft.channelId) {
      const list = await api('GET', `/api/assignments?channelId=${encodeURIComponent(draft.channelId)}`).catch(() => []);
      const mine = list.find(a => a.automationId === draft.id);
      if (mine) { draft.values = { ...mine.values }; lastKeys = ''; drawTestForm(); }
    }
  } }, h('option', { value: '' }, 'Pick a channel…'), (store.channels || []).map(c => h('option', { value: c.id, selected: c.id === draft.channelId }, channelLabel(c))));

  const saveBtn = h('button', { class: 'btn primary' }, 'Save');
  const testBtn = h('button', { class: 'btn primary', title: 'Runs the code in the editor (saved or not) as a dry run: nothing is applied or added.' }, 'Dry run');
  testBtn.onclick = () => busy(testBtn, async () => {
    if (!draft.channelId) { toast('Pick a channel to test on.', 'warn'); return; }
    clear(result, h('p', { class: 'dim small' }, h('span', { class: 'spinner' }), ' Running…'));
    try {
      const run = await api('POST', '/api/automations/test', { code: draft.code, channelId: draft.channelId, values: draft.values, automationId: draft.id });
      clear(result, runBody(run));
    } catch (err) { clear(result, h('p', { class: 'err-text' }, err.message)); }
  });

  async function save() {
    return busy(saveBtn, async () => {
      if (!draft.name.trim()) { toast('Give the automation a name first.', 'warn'); nameInput.focus(); return; }
      if (!draft.id) {
        const created = await api('POST', '/api/automations', { name: draft.name, description: draft.description, code: draft.code });
        Object.assign(draft, { id: created.id, baseVersion: created.latest_version, savedCode: draft.code });
        markUnsaved();
        toast(`Saved "${created.name}" to the library as v1.`, 'ok');
        go('automations', { edit: created.id });
        return;
      }
      let note = '';
      if (draft.code !== draft.savedCode) {
        note = await promptDialog({ title: `Save "${draft.name}" as a new version`, label: 'What changed? (optional)', confirmLabel: 'Save version' });
        if (note === null) return;
      }
      const saved = await api('POST', `/api/automations/${draft.id}/versions`, { code: draft.code, note, name: draft.name, description: draft.description });
      const moved = saved.latest_version !== draft.baseVersion;
      Object.assign(draft, { baseVersion: saved.latest_version, savedCode: draft.code });
      markUnsaved();
      toast(moved
        ? `Saved v${saved.latest_version}.${saved.usedBy.length ? ` Channels stay on their version until you move them up (channel → Automations → Settings).` : ''}`
        : 'Saved name and description (the code was unchanged, so no new version).', 'ok', 8000);
    });
  }
  saveBtn.onclick = () => save();

  clear(root, h('div', { class: 'screen two' },
    h('div', { class: 'panel' },
      h('div', { class: 'panel-head' },
        h('div', { class: 'btn-row' }, h('button', { class: 'btn small ghost', onclick: () => go('automations') }, '← Automations'),
          h('span', null, draft.id ? `Edit automation (v${draft.baseVersion})` : 'New automation')),
        saveBtn),
      h('div', { class: 'panel-body' },
        h('div', { class: 'row' },
          h('label', { class: 'field' }, h('span', { class: 'lab' }, 'Name'), nameInput),
          h('label', { class: 'field' }, h('span', { class: 'lab' }, 'Description'), descInput)),
        editor,
        h('p', { class: 'dim small' }, 'Declare settings in the /* @settings */ block, like sorts. Each channel sets its own values. minLengthPercent (default 50) stops an apply that would leave the channel with a much shorter lineup.'))),
    h('div', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('span', null, 'Test'), testBtn),
      h('div', { class: 'panel-body' },
        h('label', { class: 'field' }, h('span', { class: 'lab' }, 'Channel'), channelSelect),
        testForm,
        result))));
  drawTestForm();
}
