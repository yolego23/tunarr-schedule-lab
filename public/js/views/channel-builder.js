// Channel Builder: make a channel step by step (basics, content, look and
// feel, schedule, preview and create), from blank or from an existing
// channel. Every step works by hand; "Ask AI" buttons only suggest.
import { api, busy, clear, confirmDialog, fmtDur, fromLocalInput, h, nowMinute, toLocalInput, toast } from '../ui.js';
import { findSort, loadChannels, loadGlobals, loadSettings, loadSorts, selectChannel, setUnsaved, store } from '../store.js';
import { poolEditor } from '../components/pool-editor.js';
import { settingsForm } from '../components/settings-form.js';
import { lineupSummary, repeatRanking, timeline } from '../components/timeline.js';
import { describeTimetable, timetableEditor } from '../components/automations.js';
import { parseSettings } from '/shared/sort-settings.js';

const STEPS = ['Basics', 'Content', 'Look & feel', 'Schedule', 'Preview & create'];
const NEW_GROUP = '\u0000new';

// The draft survives switching screens (not a page reload).
let draft = null;

function freshDraft() {
  return {
    step: 0,
    startFrom: '',
    description: '',
    basics: { name: '', group: '', newGroup: '', number: '', numberTouched: false },
    look: { iconUrl: '', watermarkEnabled: false, watermarkUrl: '', watermarkPosition: 'bottom-right', streamMode: 'hls', transcodeConfigId: '', stealth: false, guideFlexTitle: '', fillerListIds: [] },
    pool: { sources: [], exclusions: [] },
    schedule: { sortId: null, sortVersion: null, values: {}, targetHours: store.settings?.channelDefaults?.targetHours || 168, alignStart: store.settings?.channelDefaults?.alignStart !== false },
    automations: [], // { automationId, name, timetable, values, enabled }
    startMs: nowMinute(),
    preview: null,
    dirty: false,
  };
}

export async function render(root, { go }) {
  const [opts] = await Promise.all([api('GET', '/api/builder/options'), loadSorts(), loadSettings(), loadGlobals(), loadChannels()]);
  if (!draft) draft = freshDraft();
  if (!draft.basics.group) draft.basics.group = opts.groups[0]?.name || NEW_GROUP;
  if (!draft.look.transcodeConfigId) draft.look.transcodeConfigId = opts.transcodeConfigs.find(t => t.isDefault)?.id || opts.transcodeConfigs[0]?.id || '';

  const stepNav = h('div', { class: 'list' });
  const body = h('div', { class: 'panel-body' });
  const foot = h('div', { class: 'panel-foot' });
  clear(root, h('div', { class: 'screen two' },
    h('div', { class: 'panel' }, h('div', { class: 'panel-head' }, 'Channel Builder'), stepNav,
      h('div', { class: 'panel-foot' }, h('button', { class: 'btn small ghost', onclick: startOver }, 'Start over'))),
    h('div', { class: 'panel' }, h('div', { class: 'panel-head' }, h('span', { id: 'stepTitle' }), h('span', { class: 'dim small' }, 'Nothing is created in Tunarr until the last step.')), body, foot)));

  const touch = () => {
    draft.dirty = true;
    draft.preview = null; // any change makes the preview stale
    setUnsaved('channel-builder', 'Channel Builder: a channel is being set up.', { inApp: false });
  };
  const aiButton = (label, fn) => opts.ai ? h('button', { class: 'btn small', title: 'Optional: asks the AI from Settings → AI for a suggestion you can accept or change', onclick: e => busy(e.currentTarget, fn) }, '✦ ' + label) : null;

  async function startOver() {
    if (draft.dirty && !(await confirmDialog({ title: 'Start over', message: 'Clear everything entered so far?', confirmLabel: 'Start over', danger: true }))) return;
    draft = freshDraft();
    draft.basics.group = opts.groups[0]?.name || NEW_GROUP;
    draft.look.transcodeConfigId = opts.transcodeConfigs.find(t => t.isDefault)?.id || opts.transcodeConfigs[0]?.id || '';
    setUnsaved('channel-builder', null);
    draw();
  }

  function draw() {
    clear(stepNav, STEPS.map((name, i) => h('div', { class: `list-item${i === draft.step ? ' active' : ''}`, onclick: () => { draft.step = i; draw(); } },
      h('span', { class: 'num' }, String(i + 1)), h('div', { class: 'name' }, name), stepStatus(i))));
    document.getElementById('stepTitle').textContent = `${draft.step + 1}. ${STEPS[draft.step]}`;
    const view = [basicsStep, contentStep, lookStep, scheduleStep, createStep][draft.step]();
    clear(body, h('div', { class: 'page-width' }, view));
    clear(foot,
      draft.step > 0 ? h('button', { class: 'btn ghost', onclick: () => { draft.step--; draw(); } }, '← Back') : null,
      draft.step < STEPS.length - 1 ? h('button', { class: 'btn primary', onclick: () => { draft.step++; draw(); } }, 'Next →') : null);
  }

  function stepStatus(i) {
    const ok = [
      !!draft.basics.name.trim(),
      draft.pool.sources.length > 0,
      true,
      !!draft.schedule.sortId,
      !!draft.preview,
    ][i];
    return ok ? h('span', { class: 'pill ok' }, '✓') : null;
  }

  // ---------- 1. basics ----------
  function basicsStep() {
    const b = draft.basics;
    const startSelect = h('select', { onchange: e => startFrom(e.target.value) },
      h('option', { value: '' }, 'Blank channel'),
      opts.channels.map(c => h('option', { value: c.id, selected: c.id === draft.startFrom }, `Copy and reshape: ${c.number} ${c.name}`)));
    const description = h('textarea', { rows: 2, placeholder: 'Optional: what is this channel? e.g. "90s Saturday-morning cartoons, nothing scary". Used by the Ask AI buttons.', oninput: e => { draft.description = e.target.value; touch(); } });
    description.value = draft.description;
    const name = h('input', { type: 'text', value: b.name, placeholder: 'Saturday Morning Cartoons', oninput: e => { b.name = e.target.value; touch(); } });
    const groupSelect = h('select', { onchange: e => { b.group = e.target.value; newGroup.hidden = b.group !== NEW_GROUP; touch(); suggest(); } },
      opts.groups.map(g => h('option', { value: g.name, selected: g.name === b.group }, `${g.name} (${g.count})`)),
      h('option', { value: NEW_GROUP, selected: b.group === NEW_GROUP }, '+ New group…'));
    const newGroup = h('input', { type: 'text', value: b.newGroup, placeholder: 'New group name', hidden: b.group !== NEW_GROUP, oninput: e => { b.newGroup = e.target.value; touch(); } });
    const number = h('input', { type: 'number', min: 1, max: 9999, value: b.number, oninput: e => { b.number = e.target.value; b.numberTouched = true; touch(); hint.textContent = ''; } });
    const hint = h('span', { class: 'hint' });
    async function suggest() {
      if (b.numberTouched) return;
      const q = new URLSearchParams({ group: b.group === NEW_GROUP ? '' : b.group });
      try { const r = await api('GET', '/api/channels/next-number?' + q); b.number = String(r.number); number.value = b.number; hint.textContent = 'Suggested: ' + r.reason + '.'; } catch { /* leave it */ }
    }
    if (!b.number) suggest();
    return h('div', null,
      h('div', { class: 'card' },
        h('label', { class: 'field' }, h('span', { class: 'lab' }, 'Start from'), startSelect,
          h('span', { class: 'hint' }, 'Copying fills in the look, sort, settings and shows of an existing channel for you to change. The original is not touched.')),
        h('label', { class: 'field' }, h('span', { class: 'lab' }, 'Description (optional)'), description)),
      h('div', { class: 'card' },
        h('div', { class: 'card-head' }, h('h3', null, 'Channel'), aiButton('Suggest name and group', async () => {
          const r = await api('POST', '/api/builder/ai/basics', { description: draft.description });
          b.name = r.name || b.name;
          if (r.group) {
            if (opts.groups.some(g => g.name === r.group)) b.group = r.group; else { b.group = NEW_GROUP; b.newGroup = r.group; }
          }
          b.numberTouched = false; b.number = '';
          touch(); draw();
          if (r.reason) toast(r.reason, '', 7000);
        })),
        h('label', { class: 'field' }, h('span', { class: 'lab' }, 'Name'), name),
        h('div', { class: 'row' },
          h('div', { class: 'field' }, h('span', { class: 'lab' }, 'Group'), groupSelect, newGroup),
          h('label', { class: 'field' }, h('span', { class: 'lab' }, 'Number'), number, hint))));
  }

  async function startFrom(channelId) {
    if (draft.dirty && !(await confirmDialog({ title: 'Replace what you entered?', message: channelId ? 'Fill in everything from that channel? This replaces what you entered so far.' : 'Start from a blank channel? This clears what you entered so far.', confirmLabel: 'Replace' }))) { draw(); return; }
    const keepDescription = draft.description;
    draft = freshDraft();
    draft.description = keepDescription;
    draft.startFrom = channelId;
    draft.look.transcodeConfigId = opts.transcodeConfigs.find(t => t.isDefault)?.id || opts.transcodeConfigs[0]?.id || '';
    draft.basics.group = opts.groups[0]?.name || NEW_GROUP;
    if (channelId) {
      try {
        const p = await api('GET', '/api/builder/prefill/' + encodeURIComponent(channelId));
        draft.basics.name = p.basics.name;
        draft.basics.group = opts.groups.some(g => g.name === p.basics.groupTitle) ? p.basics.groupTitle : draft.basics.group;
        draft.look = { ...draft.look, ...p.look };
        draft.pool = p.pool;
        draft.schedule = { ...draft.schedule, ...Object.fromEntries(Object.entries(p.schedule).filter(([, v]) => v !== null && v !== undefined)) };
        draft.automations = p.automations || [];
        toast(`Filled in from that channel: ${p.pool.sources.length} pool sources${p.schedule.sortId ? ', its sort' : ''}${draft.automations.length ? ` and ${draft.automations.length} automation(s)` : ''}.`, 'ok');
      } catch (err) { toast(err.message, 'err'); }
    }
    touch();
    draw();
  }

  // ---------- 2. content ----------
  function contentStep() {
    const suggestions = h('div');
    const card = h('div', { class: 'card' }, poolEditor({
      pool: draft.pool, lineupEpisodes: 0, allowRules: false, onChange: () => touch(),
      emptyText: 'Add the shows, seasons and movies this channel plays. New episodes of the picked shows join on their own.',
    }));
    return h('div', null,
      opts.ai ? h('div', { class: 'card' },
        h('div', { class: 'card-head' }, h('h3', null, 'Suggestions (optional)'), aiButton('Suggest shows from my library', async () => {
          if (!draft.description.trim()) { toast('Add a description on the Basics step first.', 'warn'); return; }
          const list = await api('POST', '/api/builder/ai/shows', { description: draft.description, max: 12 });
          drawSuggestions(list);
        })),
        h('p', { class: 'dim small' }, 'The AI picks from your library using the description. Add the ones you want.'),
        suggestions) : null,
      card);

    function drawSuggestions(list) {
      const has = s => draft.pool.sources.some(x => x.ref === s.id);
      clear(suggestions, list.length ? h('table', { class: 'grid' }, h('tbody', null, list.map(s => h('tr', null,
        h('td', null, h('b', null, s.title), s.year ? ` (${s.year})` : '', ' ', h('span', { class: 'tag' }, s.type), h('div', { class: 'dim small' }, s.reason)),
        h('td', { class: 'actions' }, has(s) ? h('span', { class: 'pill ok' }, 'added') : h('button', { class: 'btn small primary', onclick: () => {
          draft.pool.sources.push({ id: 'src-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8), kind: s.type === 'movie' ? 'movie' : 'show', ref: s.id, label: s.title + (s.year ? ` (${s.year})` : ''), weight: 1 });
          touch();
          draw();
          drawSuggestions(list);
        } }, 'Add')))))) : h('p', { class: 'dim small' }, 'No suggestions.'));
    }
  }

  // ---------- 3. look & feel ----------
  function lookStep() {
    const l = draft.look;
    const set = (k, v) => { l[k] = v; touch(); };
    const icon = h('input', { type: 'text', value: l.iconUrl, placeholder: 'https://… (blank = Tunarr default)', oninput: e => { set('iconUrl', e.target.value); img.src = e.target.value; img.hidden = !e.target.value; } });
    const img = h('img', { src: l.iconUrl || '', hidden: !l.iconUrl, style: { maxHeight: '48px', maxWidth: '160px', marginTop: '6px', background: '#0E121B', padding: '4px', borderRadius: '4px' } });
    const positions = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
    return h('div', null,
      h('div', { class: 'card' }, h('h3', null, 'Look'),
        h('label', { class: 'field' }, h('span', { class: 'lab' }, 'Channel icon (image address)'), icon, img),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: l.watermarkEnabled, onchange: e => set('watermarkEnabled', e.target.checked) }), 'Show a watermark on the video'),
        h('div', { class: 'row' },
          h('label', { class: 'field' }, h('span', { class: 'lab' }, 'Watermark image (blank = the icon)'), h('input', { type: 'text', value: l.watermarkUrl, oninput: e => set('watermarkUrl', e.target.value) })),
          h('label', { class: 'field' }, h('span', { class: 'lab' }, 'Watermark position'), h('select', { onchange: e => set('watermarkPosition', e.target.value) }, positions.map(p => h('option', { value: p, selected: p === l.watermarkPosition }, p)))))),
      h('div', { class: 'card' }, h('h3', null, 'Streaming and guide'),
        h('div', { class: 'row' },
          h('label', { class: 'field' }, h('span', { class: 'lab' }, 'Stream mode'), h('select', { onchange: e => set('streamMode', e.target.value) }, opts.streamModes.map(m => h('option', { value: m, selected: m === l.streamMode }, m)))),
          h('label', { class: 'field' }, h('span', { class: 'lab' }, 'Transcode profile'), h('select', { onchange: e => set('transcodeConfigId', e.target.value) }, opts.transcodeConfigs.map(t => h('option', { value: t.id, selected: t.id === l.transcodeConfigId }, t.name + (t.isDefault ? ' (default)' : '')))))),
        h('label', { class: 'field' }, h('span', { class: 'lab' }, 'Guide title for flex time'), h('input', { type: 'text', value: l.guideFlexTitle, placeholder: 'blank = Tunarr default', oninput: e => set('guideFlexTitle', e.target.value) })),
        h('label', { class: 'check' }, h('input', { type: 'checkbox', checked: l.stealth, onchange: e => set('stealth', e.target.checked) }), 'Hide from the guide and channel list (stealth)'),
        opts.fillerLists.length
          ? h('div', { class: 'field' }, h('span', { class: 'lab' }, 'Filler lists'), h('div', { class: 'btn-row' }, opts.fillerLists.map(f => h('label', { class: 'check' },
              h('input', { type: 'checkbox', checked: l.fillerListIds.includes(f.id), onchange: e => set('fillerListIds', e.target.checked ? [...l.fillerListIds, f.id] : l.fillerListIds.filter(x => x !== f.id)) }), f.name))))
          : h('p', { class: 'dim small' }, 'Tunarr has no filler lists yet. Filler comes in 2.2.')));
  }

  // ---------- 4. schedule ----------
  function scheduleStep() {
    const s = draft.schedule;
    const settingsBox = h('div');
    const sortSelect = h('select', { onchange: e => { s.sortId = e.target.value ? Number(e.target.value) : null; s.sortVersion = s.sortId ? findSort(s.sortId).latest_version : null; touch(); drawSettings(); } },
      h('option', { value: '' }, '(pick a sort)'),
      (store.sorts || []).map(x => h('option', { value: x.id, selected: x.id === s.sortId }, x.name)));
    async function drawSettings() {
      if (!s.sortId) { clear(settingsBox, h('p', { class: 'dim small' }, store.sorts?.length ? 'Pick a sort to see its settings.' : 'The Sort Library is empty: import the 1.8 sorts or write one first.')); return; }
      const v = await api('GET', `/api/sorts/${s.sortId}/versions/${s.sortVersion}`);
      const { settings } = parseSettings(v.code);
      clear(settingsBox,
        h('div', { class: 'card-head' }, h('span', { class: 'lab' }, `Settings (${findSort(s.sortId)?.name} v${s.sortVersion})`),
          aiButton('Suggest settings', async () => {
            if (!draft.description.trim()) { toast('Add a description on the Basics step first.', 'warn'); return; }
            const r = await api('POST', '/api/builder/ai/settings', { description: draft.description, sortId: s.sortId, sortVersion: s.sortVersion });
            s.values = { ...s.values, ...r.values };
            touch();
            drawSettings();
            toast((r.reason ? r.reason + ' ' : '') + `Changed: ${Object.keys(r.values).join(', ') || 'nothing'}. Check them before creating.`, '', 9000);
          })),
        settingsForm({ settings, values: s.values, globals: store.globals, onChange: vals => { s.values = vals; touch(); } }));
    }
    drawSettings();

    // Optional automations for the new channel.
    const autoBox = h('div', { class: 'card' });
    async function drawAutomations() {
      let library = [];
      try { library = await api('GET', '/api/automations'); } catch (err) { clear(autoBox, h('p', { class: 'err-text small' }, err.message)); return; }
      const add = h('select', { onchange: () => {
        const a = library.find(x => x.id === Number(add.value));
        if (!a) return;
        draft.automations.push({ automationId: a.id, name: a.name, timetable: { kind: 'weekly', days: ['Sun'], at: null }, values: {}, enabled: true });
        touch();
        drawAutomations();
      } }, h('option', { value: '' }, '+ Add an automation…'), library.map(a => h('option', { value: a.id }, a.name)));
      const rows = await Promise.all(draft.automations.map(async (a, i) => {
        const lib = library.find(x => x.id === a.automationId);
        return h('div', { class: 'assignment' },
          h('div', { class: 'btn-row' }, h('b', null, a.name), lib ? h('span', { class: 'mono dim' }, `v${lib.latest_version}`) : h('span', { class: 'err-text small' }, 'no longer in the library'),
            h('span', { class: 'dim small' }, describeTimetable(a.timetable)), h('span', { style: { flex: 1 } }),
            h('button', { class: 'btn small ghost', onclick: () => { draft.automations.splice(i, 1); touch(); drawAutomations(); } }, 'Remove')),
          timetableEditor({ value: a.timetable, onChange: () => touch() }),
          lib ? settingsForm({ settings: lib.settings, values: a.values, globals: store.globals, emptyText: 'This automation declares no settings.', onChange: v => { a.values = v; touch(); } }) : null);
      }));
      clear(autoBox,
        h('div', { class: 'card-head' }, h('h3', null, 'Automations (optional)'),
          library.length ? add : h('button', { class: 'btn small', onclick: e => busy(e.currentTarget, async () => { await api('POST', '/api/automations/import-presets'); drawAutomations(); }) }, 'Import starter automations')),
        draft.automations.length ? rows : h('p', { class: 'dim small' }, 'For example a weekly rebuild, or one that suggests new matching shows. They are added when the channel is created, and can be changed later on the Channels screen.'));
    }
    drawAutomations();

    return h('div', null,
      h('div', { class: 'card' }, h('h3', null, 'Sort'),
        h('label', { class: 'field' }, h('span', { class: 'lab' }, 'Sort from the library'), sortSelect),
        settingsBox),
      h('div', { class: 'card' }, h('h3', null, 'Lineup'),
        h('div', { class: 'row' },
          h('label', { class: 'field' }, h('span', { class: 'lab' }, 'Lineup length (hours)'), h('input', { type: 'number', min: 1, value: String(s.targetHours), oninput: e => { s.targetHours = Number(e.target.value) || 168; touch(); } })),
          h('div', null, h('label', { class: 'check', style: { marginTop: '18px' } },
            h('input', { type: 'checkbox', checked: s.alignStart, onchange: e => { s.alignStart = e.target.checked; touch(); } }), 'Start the lineup at the preview\'s start time')))),
      autoBox);
  }

  // ---------- 5. preview & create ----------
  function createStep() {
    const b = draft.basics;
    const groupName = b.group === NEW_GROUP ? b.newGroup.trim() : b.group;
    const problems = [];
    if (!b.name.trim()) problems.push('a name (step 1)');
    if (b.group === NEW_GROUP && !groupName) problems.push('a group name (step 1)');
    if (!draft.pool.sources.length) problems.push('some shows or movies (step 2)');
    if (!draft.schedule.sortId) problems.push('a sort (step 4)');
    const start = h('input', { type: 'datetime-local', value: toLocalInput(draft.startMs), onchange: e => { draft.startMs = fromLocalInput(e.target.value); draft.preview = null; draw(); } });
    const previewBox = h('div');
    const runBtn = h('button', { class: 'btn primary', disabled: problems.length > 0 }, draft.preview ? 'Run preview again' : 'Run preview');
    runBtn.onclick = () => busy(runBtn, async () => {
      const r = await api('POST', '/api/run', {
        channelId: 'draft', name: b.name, pool: draft.pool, sortId: draft.schedule.sortId, sortVersion: draft.schedule.sortVersion,
        params: draft.schedule.values, targetHours: draft.schedule.targetHours, scheduleStartMs: draft.startMs,
      });
      draft.preview = r;
      draw();
    });
    const createBtn = h('button', { class: 'btn danger', disabled: problems.length > 0 }, draft.preview ? 'Create channel and apply this lineup' : 'Create channel');
    createBtn.onclick = () => busy(createBtn, async () => {
      const lines = [
        `Create ${b.number || '(next free number)'} ${b.name} in group "${groupName}" in Tunarr,`,
        `with ${draft.pool.sources.length} pool sources and ${findSort(draft.schedule.sortId)?.name}.`,
        draft.automations.length ? `Add ${draft.automations.length} automation(s): ${draft.automations.map(a => a.name).join(', ')}.` : null,
        draft.preview ? `Then apply the previewed lineup: ${draft.preview.items.length} items, ${fmtDur(draft.preview.durationMs)}.` : 'No lineup is applied (no preview was run); the channel starts empty.',
      ];
      if (!(await confirmDialog({ title: 'Create channel', message: lines.filter(Boolean).join('\n'), confirmLabel: 'Create', danger: true }))) return;
      const r = await api('POST', '/api/builder/create', {
        basics: { name: b.name, number: b.number === '' ? undefined : Number(b.number), groupTitle: groupName },
        look: draft.look, pool: draft.pool, schedule: draft.schedule, previewId: draft.preview?.previewId,
        automations: draft.automations.map(a => ({ automationId: a.automationId, timetable: a.timetable, values: a.values, enabled: a.enabled !== false })),
      });
      if (r.applyError) toast(`Created the channel, but applying the lineup failed: ${r.applyError}. Open it on the Channels screen to preview and apply again.`, 'err', 15000);
      else toast(`Created ${r.channel.number} ${String(r.channel.name).trim()}${r.apply ? ` and applied ${r.apply.itemCount} items` : ''}.`, 'ok', 8000);
      setUnsaved('channel-builder', null);
      draft = null;
      await loadChannels(true);
      selectChannel(r.channel.id);
      go('channels');
    });

    if (draft.preview) {
      const byId = new Map(draft.preview.pool.map(p => [p.id, p]));
      const items = draft.preview.items.map(it => byId.get(it.id) || { type: 'flex', durationMs: it.durationMs, title: 'Flex' });
      let view = 'timeline';
      const viewBox = h('div');
      const tabs = ['timeline', 'ranking'].map(v => h('button', { class: 'btn small', onclick: () => { view = v; drawView(); } }, v === 'timeline' ? 'Timeline' : 'Repeat ranking'));
      const drawView = () => {
        tabs.forEach((t, i) => t.classList.toggle('active', ['timeline', 'ranking'][i] === view));
        clear(viewBox, view === 'timeline'
          ? timeline({ items, startMs: draft.preview.scheduleStartMs, thresholds: store.settings.thresholds })
          : repeatRanking({ items, startMs: draft.preview.scheduleStartMs, thresholds: store.settings.thresholds }));
      };
      drawView();
      clear(previewBox, h('div', { class: 'card', style: { padding: 0 } },
        h('div', { class: 'card-head', style: { padding: '10px 14px' } }, h('span', { class: 'pill ok' }, lineupSummary(items)), h('div', { class: 'seg' }, tabs)),
        h('div', { style: { maxHeight: '55vh', overflowY: 'auto' } }, viewBox)));
    }

    return h('div', null,
      problems.length ? h('div', { class: 'card' }, h('p', { class: 'warn-text' }, 'Still needed: ' + problems.join(', ') + '.')) : null,
      h('div', { class: 'card' },
        h('div', { class: 'kv' },
          h('span', { class: 'k' }, 'Channel'), h('span', null, `${b.number || '(next free)'} · ${b.name || '—'} · group ${groupName || '—'}`),
          h('span', { class: 'k' }, 'Pool'), h('span', null, `${draft.pool.sources.length} sources${draft.pool.exclusions.length ? `, ${draft.pool.exclusions.length} excluded` : ''}`),
          h('span', { class: 'k' }, 'Sort'), h('span', null, draft.schedule.sortId ? `${findSort(draft.schedule.sortId)?.name} v${draft.schedule.sortVersion}` : '—'),
          h('span', { class: 'k' }, 'Lineup'), h('span', null, fmtDur(draft.schedule.targetHours * 3_600_000)),
          h('span', { class: 'k' }, 'Automations'), h('span', null, draft.automations.length ? draft.automations.map(a => a.name).join(', ') : '—')),
        h('div', { class: 'row', style: { marginTop: '12px', alignItems: 'flex-end' } },
          h('label', { class: 'field', style: { maxWidth: '260px' } }, h('span', { class: 'lab' }, 'Lineup starts'), start),
          h('div', { class: 'btn-row', style: { marginBottom: '12px' } }, runBtn, createBtn))),
      previewBox);
  }

  draw();
}
