// Sort Builder: write or edit a sort, declare its settings, test it against
// sample data or a real channel's pool, and save it to the library.
import { api, busy, clear, confirmDialog, fmtDur, fromLocalInput, h, modal, nowMinute, promptDialog, toLocalInput, toast } from '../ui.js';
import { channelLabel, expandItems, findSort, loadChannelData, loadChannels, loadGlobals, loadSettings, loadSorts, setUnsaved, store } from '../store.js';
import { codeEditor } from '../components/code-editor.js';
import { settingsForm } from '../components/settings-form.js';
import { lineupSummary, repeatRanking, timeline } from '../components/timeline.js';
import { SETTING_TYPES, addSettingLine, formatSettingLine, parseSettings } from '/shared/sort-settings.js';

// The draft survives switching screens.
let draft = null; // { sortId, baseVersion, name, description, code, savedCode, testValues, source, hours, startMs }

export async function render(root, { params, go }) {
  await Promise.all([loadSorts(), loadSettings(), loadGlobals(true), loadChannels().catch(() => null)]);
  const wanted = params.get('sort');
  const isNew = wanted === 'new';
  if (wanted && (!draft || isNew || draft.sortId !== Number(wanted))) {
    if (draft && draft.code !== draft.savedCode && !(await confirmDialog({ title: 'Unsaved changes', message: `Discard your unsaved changes to "${draft.name || 'the new sort'}"?`, confirmLabel: 'Discard', danger: true }))) {
      go('builder', draft.sortId ? { sort: draft.sortId } : undefined);
      return;
    }
    if (isNew) {
      await newDraft();
      go('builder');
      return;
    }
    await openSort(Number(wanted));
  }
  if (!draft) await newDraft();

  const picker = h('select');
  const status = h('span', { class: 'pill' });
  const nameInput = h('input', { type: 'text', placeholder: 'Sort name' });
  const descInput = h('input', { type: 'text', placeholder: 'What this sort does, in a sentence' });
  const settingsInfo = h('div');
  const editor = codeEditor({ value: draft.code, onChange: v => { draft.code = v; onCodeChange(); }, onSave: () => save(), minHeight: 320 });
  const testForm = h('div');
  const results = h('div', { class: 'panel-body', style: { padding: 0 } });
  const logBox = h('div', { class: 'log', hidden: true });
  const summary = h('span', { class: 'pill' });
  const saveBtn = h('button', { class: 'btn primary' }, 'Save');
  const runBtn = h('button', { class: 'btn primary' }, 'Run test');
  let view = 'timeline';
  let lastRun = null;

  const sourceSelect = h('select', { onchange: e => { draft.source = e.target.value; } },
    h('option', { value: 'sample' }, 'Sample data (3 made-up shows)'),
    (store.channels || []).map(c => h('option', { value: c.id }, channelLabel(c))));
  const startInput = h('input', { type: 'datetime-local' });
  const hoursInput = h('input', { type: 'number', min: 1, step: 1 });

  const viewBtns = ['timeline', 'ranking'].map(v => h('button', { class: 'btn small', onclick: () => { view = v; drawResults(); } }, v === 'timeline' ? 'Timeline' : 'Repeat ranking'));

  clear(root, h('div', { class: 'screen three' },
    h('div', { class: 'panel' },
      h('div', { class: 'panel-head' },
        h('div', { class: 'btn-row', style: { flex: 1 } }, h('span', null, 'Sort'), h('div', { style: { flex: 1, maxWidth: '280px' } }, picker)),
        status),
      h('div', { class: 'panel-body' },
        h('div', { class: 'row' },
          h('label', { class: 'field' }, h('span', { class: 'lab' }, 'Name'), nameInput),
          h('label', { class: 'field', style: { flex: 2 } }, h('span', { class: 'lab' }, 'Description'), descInput)),
        editor,
        settingsInfo),
      h('div', { class: 'panel-foot' },
        saveBtn,
        h('button', { class: 'btn ghost', onclick: () => saveAsNew() }, 'Save as new sort'),
        h('button', { class: 'btn ghost', onclick: () => showHelp() }, 'How sorts work'),
        h('span', { class: 'spacer', style: { flex: 1 } }),
        h('span', { class: 'dim small' }, 'Ctrl+S saves'))),
    h('div', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('span', null, 'Test'), h('div', { class: 'seg' }, viewBtns)),
      h('div', { style: { padding: '12px 14px', borderBottom: '1px solid var(--line)', maxHeight: '45%', overflowY: 'auto' } },
        h('div', { class: 'row' },
          h('label', { class: 'field', style: { flex: 2 } }, h('span', { class: 'lab' }, 'Test against'), sourceSelect),
          h('label', { class: 'field' }, h('span', { class: 'lab' }, 'Start'), startInput),
          h('label', { class: 'field', style: { maxWidth: '120px' } }, h('span', { class: 'lab' }, 'Hours'), hoursInput)),
        testForm,
        h('div', { class: 'btn-row' }, runBtn, summary)),
      results,
      logBox)));

  // ---------- sort picker ----------
  function drawPicker() {
    clear(picker,
      h('option', { value: 'new', selected: !draft.sortId }, '+ New sort'),
      (store.sorts || []).map(s => h('option', { value: s.id, selected: s.id === draft.sortId }, s.name)));
  }
  picker.onchange = async () => {
    const v = picker.value;
    if (draft.code !== draft.savedCode && !(await confirmDialog({ title: 'Unsaved changes', message: `Discard your unsaved changes to "${draft.name || 'this sort'}"?`, confirmLabel: 'Discard', danger: true }))) {
      drawPicker();
      return;
    }
    if (v === 'new') { await newDraft(); go('builder'); }
    else { await openSort(Number(v)); go('builder', { sort: v }); }
    lastRun = null;
    loadDraftIntoForm();
    drawResults();
  };

  function loadDraftIntoForm() {
    drawPicker();
    nameInput.value = draft.name;
    descInput.value = draft.description;
    editor.setValue(draft.code);
    sourceSelect.value = draft.source;
    startInput.value = toLocalInput(draft.startMs);
    hoursInput.value = String(draft.hours);
    onCodeChange();
  }

  nameInput.oninput = () => { draft.name = nameInput.value; };
  descInput.oninput = () => { draft.description = descInput.value; };
  startInput.onchange = () => { draft.startMs = fromLocalInput(startInput.value); };
  hoursInput.oninput = () => { draft.hours = Number(hoursInput.value) || 48; };

  // ---------- live settings parse ----------
  let lastSettingsKey = '';
  function onCodeChange() {
    const unsaved = draft.code !== draft.savedCode;
    // The draft survives switching screens, so only a page reload would lose it.
    setUnsaved('builder', unsaved ? `Sort Builder: unsaved changes to "${draft.name || 'the new sort'}".` : null, { inApp: false });
    status.textContent = draft.sortId ? `v${draft.baseVersion}${unsaved ? ' · unsaved' : ''}` : (unsaved ? 'new · unsaved' : 'new');
    status.className = `pill${unsaved ? ' warn' : ''}`;
    const { settings, errors, hasBlock } = parseSettings(draft.code);
    clear(settingsInfo,
      h('h3', null, `Declared settings (${settings.length})`),
      errors.length ? h('p', { class: 'err-text small' }, errors.join(' · ')) : null,
      settings.length
        ? h('table', { class: 'grid' },
            h('thead', null, h('tr', null, ['Key', 'Type', 'Default', 'Label'].map(t => h('th', null, t)))),
            h('tbody', null, settings.map(s => h('tr', null,
              h('td', { class: 'mono' }, s.key),
              h('td', null, s.type === 'choice' ? `choice: ${s.options.join(', ')}` : s.type),
              h('td', { class: 'mono' }, s.type === 'secret' && s.default ? '••••' : String(s.default)),
              h('td', null, s.label)))))
        : h('p', { class: 'dim small' }, hasBlock ? 'The @settings block is empty.' : 'No @settings block. Add one at the top of the code, or use the button below.'),
      h('button', { class: 'btn small', style: { marginTop: '8px' }, onclick: addSettingDialog }, '+ Add setting'));
    // Only rebuild the test form when the declared settings change.
    const key = JSON.stringify(settings);
    if (key !== lastSettingsKey) {
      lastSettingsKey = key;
      clear(testForm, settings.length ? h('div', null, h('span', { class: 'lab' }, 'Test values'),
        settingsForm({ settings, values: draft.testValues, globals: store.globals, onChange: v => { draft.testValues = v; } })) : null);
    }
  }

  function addSettingDialog() {
    const key = h('input', { type: 'text', placeholder: 'repeatWindowHours' });
    const label = h('input', { type: 'text', placeholder: 'Repeat window (hours)' });
    const type = h('select', null, SETTING_TYPES.map(t => h('option', { value: t }, t)));
    const options = h('input', { type: 'text', placeholder: 'a, b, c' });
    const def = h('input', { type: 'text', placeholder: '72' });
    const optRow = h('label', { class: 'field', hidden: true }, h('span', { class: 'lab' }, 'Choices (comma separated)'), options);
    type.onchange = () => { optRow.hidden = type.value !== 'choice'; };
    modal({
      title: 'Add a setting',
      body: h('div', null,
        h('p', { class: 'dim small' }, 'Adds a line to the @settings block. The sort reads it as ctx.params.<key>.'),
        h('div', { class: 'row' },
          h('label', { class: 'field' }, h('span', { class: 'lab' }, 'Key'), key),
          h('label', { class: 'field' }, h('span', { class: 'lab' }, 'Type'), type)),
        optRow,
        h('div', { class: 'row' },
          h('label', { class: 'field' }, h('span', { class: 'lab' }, 'Label'), label),
          h('label', { class: 'field' }, h('span', { class: 'lab' }, 'Default'), def))),
      actions: [
        { label: 'Cancel', kind: 'ghost' },
        { label: 'Add', kind: 'primary', onClick: () => {
          if (!/^[A-Za-z_$][\w$]*$/.test(key.value.trim())) { toast('The key must be a plain identifier, like repeatWindowHours.', 'warn'); return false; }
          const line = formatSettingLine({
            key: key.value.trim(), type: type.value, label: label.value.trim(), default: def.value.trim(),
            options: options.value.split(',').map(s => s.trim()).filter(Boolean),
          });
          draft.code = addSettingLine(draft.code, line);
          editor.setValue(draft.code);
          onCodeChange();
          return true;
        } },
      ],
    });
    setTimeout(() => key.focus(), 0);
  }

  // ---------- test run ----------
  runBtn.onclick = () => busy(runBtn, async () => {
    const channelId = draft.source || 'sample';
    let data, r;
    try {
      [data, r] = await Promise.all([
        loadChannelData(channelId),
        api('POST', '/api/run', { channelId, code: draft.code, params: draft.testValues, targetHours: draft.hours, scheduleStartMs: draft.startMs, label: `Test of ${draft.name || 'new sort'}` }),
      ]);
    } catch (err) {
      summary.textContent = 'error';
      summary.className = 'pill err';
      throw err;
    }
    lastRun = { data, r, items: expandItems(data, r.items) };
    summary.textContent = `${lineupSummary(lastRun.items)} · ran in ${r.ms} ms`;
    summary.className = 'pill ok';
    drawResults();
    logBox.hidden = !r.logs.length;
    clear(logBox, r.logs.map(l => h('div', { class: `line${/^warn/.test(l) ? ' warn' : /^error/.test(l) ? ' err' : ''}` }, l)));
    if (r.warnings?.length) toast(r.warnings.join(' '), 'warn');
  });

  function drawResults() {
    viewBtns.forEach((b, i) => b.classList.toggle('active', ['timeline', 'ranking'][i] === view));
    if (!lastRun) {
      clear(results, h('div', { class: 'empty' }, h('b', null, 'No test run yet'), 'Pick sample data or a channel, set test values, and click Run test.'));
      return;
    }
    const thresholds = store.settings.thresholds;
    const current = new Set(lastRun.data.current.map(c => c.id));
    clear(results, view === 'timeline'
      ? timeline({ items: lastRun.items, startMs: lastRun.r.scheduleStartMs, thresholds, newAgainst: current })
      : repeatRanking({ items: lastRun.items, startMs: lastRun.r.scheduleStartMs, thresholds }));
  }

  // ---------- save ----------
  async function save() {
    return busy(saveBtn, async () => {
      if (!draft.name.trim()) { toast('Give the sort a name first.', 'warn'); nameInput.focus(); return; }
      if (!draft.sortId) {
        const created = await api('POST', '/api/sorts', { name: draft.name, description: draft.description, code: draft.code });
        await loadSorts(true);
        Object.assign(draft, { sortId: created.id, baseVersion: created.latest_version, savedCode: draft.code });
        toast(`Saved "${created.name}" to the library as v1.`, 'ok');
        go('builder', { sort: created.id });
      } else {
        const sort = findSort(draft.sortId);
        const codeChanged = draft.code !== draft.savedCode;
        let note = '';
        if (codeChanged) {
          note = await promptDialog({ title: `Save "${draft.name}" v${sort.latest_version + 1}`, label: 'What changed? (optional)', confirmLabel: 'Save version' });
          if (note === null) return;
        }
        const saved = await api('POST', `/api/sorts/${draft.sortId}/versions`, { code: draft.code, note, name: draft.name, description: draft.description });
        await loadSorts(true);
        const moved = saved.latest_version !== draft.baseVersion;
        Object.assign(draft, { baseVersion: saved.latest_version, savedCode: draft.code });
        const users = saved.usedBy.length;
        toast(moved
          ? `Saved v${saved.latest_version}.${users ? ` ${users} channel(s) stay on their current version until you move them up on the Channels screen.` : ''}`
          : 'Saved name and description (the code was unchanged, so no new version).', 'ok');
      }
      drawPicker();
      onCodeChange();
    });
  }
  saveBtn.onclick = () => save();

  async function saveAsNew() {
    const name = await promptDialog({ title: 'Save as a new sort', label: 'Name', value: draft.name ? `${draft.name} copy` : '' });
    if (!name) return;
    try {
      const created = await api('POST', '/api/sorts', { name, description: draft.description, code: draft.code });
      await loadSorts(true);
      draft = { ...draft, sortId: created.id, baseVersion: 1, name: created.name, savedCode: draft.code };
      toast(`Saved "${created.name}" as a new sort.`, 'ok');
      go('builder', { sort: created.id });
    } catch (err) { toast(err.message, 'err'); }
  }

  loadDraftIntoForm();
  drawResults();
}

async function newDraft() {
  const { code } = await api('GET', '/api/sorts/template');
  draft = { sortId: null, baseVersion: 0, name: '', description: '', code, savedCode: code, testValues: {}, source: 'sample', hours: 48, startMs: nowMinute() };
}

async function openSort(id) {
  const s = await api('GET', `/api/sorts/${id}`);
  const v = await api('GET', `/api/sorts/${id}/versions/${s.latest_version}`);
  draft = {
    sortId: id, baseVersion: s.latest_version, name: s.name, description: s.description, code: v.code, savedCode: v.code,
    testValues: {}, source: draft?.source || 'sample', hours: draft?.hours || 48, startMs: nowMinute(),
  };
}

function showHelp() {
  modal({
    title: 'How sorts work',
    wide: true,
    body: h('div', { class: 'small' },
      h('p', null, 'A sort is a function ', h('code', null, 'run(ctx)'), ' that returns the new lineup: items from ', h('code', null, 'ctx.pool'), ' (or ', h('code', null, 'ctx.current'), ') in play order. It is the same contract as Schedule Lab 1.8, so 1.8 sorts work unchanged.'),
      h('h3', null, 'Settings'),
      h('p', null, 'Declare settings in a comment at the top. Each channel that uses the sort stores its own values, and the sort reads them from ', h('code', null, 'ctx.params'), '.'),
      h('pre', { class: 'code-view' }, `/* @settings
repeatWindowHours: number = 72                    // Repeat window (hours)
order: choice(as-listed, shuffle) = shuffle       // Cycle order
workHours: weekly hours = Mon-Fri 08:00-16:30     // Work hours
useWeekendStyle: yes/no = no
apiKey: secret =                                  // API key
padWith: filler list =                            // Filler list
*/`),
      h('p', null, 'Types: number, text, secret, yes/no, choice(...), weekly hours, filler list.'),
      h('h3', null, 'ctx'),
      h('div', { class: 'kv' },
        h('span', { class: 'k' }, 'pool'), h('span', null, 'Episodes: { id, title, showTitle, seasonNumber, episodeNumber, episodeLabel, durationMs }'),
        h('span', { class: 'k' }, 'current'), h('span', null, "The channel's lineup now (same item shape). currentPlayingIndex = what's playing."),
        h('span', { class: 'k' }, 'params'), h('span', null, "This channel's setting values"),
        h('span', { class: 'k' }, 'targetMs'), h('span', null, 'How long the lineup should run'),
        h('span', { class: 'k' }, 'scheduleStartMs'), h('span', null, 'When the first item starts (also scheduleStart as an ISO string)'),
        h('span', { class: 'k' }, 'utils.hours(x)'), h('span', null, 'From a weekly hours setting (or an array of them): isInside(t), fractionInside(a, b), msInside(a, b). Pass { hours, padMinutes } to widen blocks.'),
        h('span', { class: 'k' }, 'utils'), h('span', null, 'shuffle(arr, rng), makeRng(seed), scoreSchedule(list)'),
        h('span', { class: 'k' }, 'utils.claude(o)'), h('span', null, '{ apiKey, prompt, model?, system?, maxTokens? } -> Promise<text>. The server makes the call; waiting on it does not count toward the time limit.'),
        h('span', { class: 'k' }, 'globals'), h('span', null, 'Global variables from the Settings screen, by name (read-only). A setting can also be linked to one per channel.'),
        h('span', { class: 'k' }, 'history'), h('span', null, 'From the Watch Tracker, for this channel: lastWatched(id) (time or null), watchCount(id) (also watched(id)), watches(id) ([{ at, minutes }], newest first). Pass { anyChannel: true } for all channels. lastAired(id): when it last started airing on this channel.'),
        h('span', { class: 'k' }, 'console.log'), h('span', null, 'Shows under the test results')),
      h('h3', null, 'Filler'),
      h('p', null, 'Return ', h('code', null, "{ type: 'flex', durationMs }"), ' items to pad, for example so shows start on the half hour.'),
      h('h3', null, 'Limits'),
      h('p', null, 'Sorts run on the server in a sandbox: 10 seconds, 512 MB, no network or file access.')),
  });
}
