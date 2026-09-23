// Settings: global settings, and global variables that every sort can read
// (ctx.globals) and that channel settings can link to.
import { api, busy, clear, confirmDialog, h, modal, toast } from '../ui.js';
import { findChannel, loadChannels, loadGlobals, loadSettings, setUnsaved, store } from '../store.js';
import { settingsForm } from '../components/settings-form.js';
import { GLOBAL_NAME_RE, GLOBAL_TYPES, coerce } from '/shared/sort-settings.js';

export async function render(root) {
  const page = h('div', { class: 'page-width' });
  clear(root, h('div', { class: 'scroll-page' }, page));
  await Promise.all([loadSettings(true), loadGlobals(true), loadChannels().catch(() => null)]);

  const connection = h('div', { class: 'card' });
  const globalsCard = h('div', { class: 'card' });
  clear(page,
    h('h2', null, 'Settings'),
    h('p', { class: 'dim' }, 'Global settings apply to the whole app. Global variables are shared values every sort can read, and any channel setting can link to.'),
    globalsCard,
    settingCard({
      title: 'Watch Tracker',
      note: 'An episode counts as watched on a channel once it has streamed for the minimum minutes. Only the newest watches per episode per channel are kept; the watch count keeps counting. Set "forget after" to 0 to keep watches until newer ones replace them.',
      key: 'watchTracker',
      fields: v => [
        checkField('Track what\'s watched', v.enabled, x => { v.enabled = x; }),
        numberField('Minutes before it counts', v.minMinutes, 1, x => { v.minMinutes = x; }),
        numberField('Watches kept per episode', v.keepPerEpisode, 1, x => { v.keepPerEpisode = x; }),
        numberField('Forget watches after (days, 0 = never)', v.maxAgeDays, 1, x => { v.maxAgeDays = x; }),
      ],
    }),
    settingCard({
      title: 'Defaults for new channels',
      note: 'Used for channels you haven\'t set up yet. Channels you\'ve saved keep their own values.',
      key: 'channelDefaults',
      fields: v => [
        numberField('Lineup length (hours)', v.targetHours, 1, x => { v.targetHours = x; }),
        checkField('Start the lineup at the preview\'s start time', v.alignStart, x => { v.alignStart = x; }),
      ],
    }),
    settingCard({
      title: 'Preview & Compare',
      note: 'Repeat colours on timelines are minutes between an episode\'s airings at the same time of day: red below the first number, green from the second.',
      keys: ['candidates', 'thresholds'],
      fields: (v) => [
        numberField('Candidates per sort', v.candidates, 1, x => { v.candidates = x; }),
        numberField('Red below (minutes)', v.thresholds.tight, 1, x => { v.thresholds.tight = x; }),
        numberField('Green from (minutes)', v.thresholds.loose, 1, x => { v.thresholds.loose = x; }),
      ],
    }),
    settingCard({
      title: 'Safety limits',
      note: 'Backups are taken before every apply, undo and restore; older ones are deleted beyond this number. Sorts that run longer than the time limit are stopped (time waiting on Claude doesn\'t count).',
      keys: ['backupsPerChannel', 'sortTimeLimitSec'],
      fields: v => [
        numberField('Backups kept per channel', v.backupsPerChannel, 1, x => { v.backupsPerChannel = x; }),
        numberField('Sort time limit (seconds)', v.sortTimeLimitSec, 1, x => { v.sortTimeLimitSec = x; }),
      ],
    }),
    h('div', { class: 'card' },
      h('div', { class: 'card-head' }, h('h3', null, 'Scoring function')),
      h('p', { class: 'dim small' }, 'Ranks candidates on Preview & Compare, where you edit it.'),
      h('button', { class: 'btn small', onclick: async () => {
        if (!(await confirmDialog({ title: 'Reset scoring', message: 'Replace your scoring function with the default one?', confirmLabel: 'Reset' }))) return;
        const r = await api('DELETE', '/api/settings/scoreCode');
        store.settings.scoreCode = r.value;
        toast('Scoring function reset to the default.', 'ok');
      } }, 'Reset to default')),
    connection,
  );

  drawGlobals();
  drawConnection();

  // ---------- global settings cards ----------
  function settingCard({ title, note, key, keys, fields }) {
    const card = h('div', { class: 'card' });
    const allKeys = keys || [key];
    const unsavedKey = `settings:${title}`;
    const markUnsaved = () => setUnsaved(unsavedKey, `Settings: "${title}" has changes that aren't saved.`);
    card.addEventListener('input', markUnsaved);
    card.addEventListener('change', markUnsaved);
    const draw = () => {
      setUnsaved(unsavedKey, null);
      // Edit a copy; single-key cards edit that value, multi-key cards an object of values.
      const draft = structuredClone(key ? store.settings[key] : Object.fromEntries(allKeys.map(k => [k, store.settings[k]])));
      const saveBtn = h('button', { class: 'btn primary small' }, 'Save');
      saveBtn.onclick = () => busy(saveBtn, async () => {
        for (const k of allKeys) {
          const value = key ? draft : draft[k];
          const r = await api('PUT', `/api/settings/${k}`, { value });
          store.settings[k] = r.value;
        }
        toast(`Saved ${title.toLowerCase()}.`, 'ok');
        draw();
      });
      clear(card,
        h('div', { class: 'card-head' }, h('h3', null, title)),
        note ? h('p', { class: 'dim small' }, note) : null,
        h('div', { class: 'row' }, fields(draft)),
        h('div', { class: 'card-foot' }, saveBtn,
          h('button', { class: 'btn ghost small', onclick: e => busy(e.currentTarget, async () => {
            for (const k of allKeys) store.settings[k] = (await api('DELETE', `/api/settings/${k}`)).value;
            toast(`${title}: back to defaults.`, 'ok');
            draw();
          }) }, 'Reset to defaults')));
    };
    draw();
    return card;
  }

  // ---------- global variables ----------
  function drawGlobals() {
    const list = store.globals;
    clear(globalsCard,
      h('div', { class: 'card-head' },
        h('h3', null, `Global variables (${list.length})`),
        h('button', { class: 'btn primary small', onclick: () => editGlobal(null) }, '+ Add variable')),
      h('p', { class: 'dim small' },
        'Every sort can read these as ', h('code', null, 'ctx.globals.name'),
        '. On the Channels screen, any sort setting of a matching type can be linked to one, so a shared API key or your household\'s work hours live in one place.'),
      list.length
        ? h('div', { class: 'table-wrap' }, h('table', { class: 'grid' },
            h('thead', null, h('tr', null, ['Name', 'Type', 'Value', 'Description', 'Linked from', ''].map(t => h('th', null, t)))),
            h('tbody', null, list.map(g => h('tr', null,
              h('td', { class: 'mono' }, g.name),
              h('td', { class: 'small' }, g.type),
              h('td', { class: 'mono small', style: { maxWidth: '280px', wordBreak: 'break-word' } }, showValue(g)),
              h('td', { class: 'small' }, g.description || h('span', { class: 'dim' }, '—')),
              h('td', { class: 'small' }, g.usedBy.length
                ? g.usedBy.map(u => h('div', null, `${findChannel(u.channelId)?.name || u.channelId}: `, h('span', { class: 'mono dim' }, u.key)))
                : h('span', { class: 'dim' }, 'no channels')),
              h('td', { class: 'actions' },
                h('button', { class: 'btn small', onclick: () => editGlobal(g) }, 'Edit'),
                h('button', { class: 'btn small ghost', onclick: async () => {
                  if (!(await confirmDialog({ title: 'Delete variable', message: `Delete "${g.name}"? Sorts that read ctx.globals.${g.name} will get undefined.`, confirmLabel: 'Delete', danger: true }))) return;
                  try {
                    await api('DELETE', `/api/globals/${encodeURIComponent(g.name)}`);
                    await loadGlobals(true);
                    drawGlobals();
                  } catch (err) { toast(err.message, 'err'); }
                } }, 'Delete')))))))
        : h('p', { class: 'dim small' }, 'No variables yet.'));
  }

  function showValue(g) {
    if (g.type === 'secret') return g.value ? '••••••••' : '(empty)';
    if (g.type === 'yes/no') return coerce({ type: 'yes/no' }, g.value) ? 'yes' : 'no';
    return String(g.value ?? '') || h('span', { class: 'dim' }, '(empty)');
  }

  function editGlobal(existing) {
    const draft = existing ? { ...existing } : { name: '', type: 'text', value: '', description: '' };
    const name = h('input', { type: 'text', value: draft.name, placeholder: 'householdWorkHours' });
    const typeSelect = h('select', null, GLOBAL_TYPES.map(t => h('option', { value: t, selected: t === draft.type }, t)));
    const linked = existing?.usedBy.length || 0;
    if (linked) typeSelect.disabled = true;
    const description = h('input', { type: 'text', value: draft.description, placeholder: 'What it is for' });
    const valueBox = h('div');
    const drawValue = () => {
      // Reuse the settings form: one field of the chosen type.
      const setting = { key: 'value', type: draft.type, label: 'Value', default: coerce({ type: draft.type }, '') };
      clear(valueBox, settingsForm({ settings: [setting], values: { value: draft.value }, onChange: v => { draft.value = v.value; } }));
    };
    typeSelect.onchange = () => { draft.type = typeSelect.value; draft.value = coerce({ type: draft.type }, ''); drawValue(); };
    drawValue();
    modal({
      title: existing ? `Edit ${existing.name}` : 'Add a global variable',
      wide: draft.type === 'weekly hours',
      body: h('div', null,
        h('div', { class: 'row' },
          h('label', { class: 'field' }, h('span', { class: 'lab' }, 'Name (as in ctx.globals.name)'), name),
          h('label', { class: 'field' }, h('span', { class: 'lab' }, 'Type'), typeSelect,
            linked ? h('span', { class: 'hint' }, `Linked from ${linked} channel setting(s), so the type is fixed.`) : null)),
        valueBox,
        h('label', { class: 'field' }, h('span', { class: 'lab' }, 'Description'), description),
        existing && linked ? h('p', { class: 'dim small' }, 'Renaming keeps the links: linked channel settings follow the new name. Sorts that read ctx.globals by name need updating.') : null),
      actions: [
        { label: 'Cancel', kind: 'ghost' },
        { label: 'Save', kind: 'primary', onClick: async () => {
          const newName = name.value.trim();
          if (!GLOBAL_NAME_RE.test(newName)) { toast('Use letters, numbers and _ for the name, not starting with a number.', 'warn'); return false; }
          try {
            await api('PUT', `/api/globals/${encodeURIComponent(existing ? existing.name : newName)}`, {
              name: newName, type: draft.type, value: draft.value, description: description.value,
            });
            await loadGlobals(true);
            drawGlobals();
            toast(`Saved ${newName}.`, 'ok');
            return true;
          } catch (err) { toast(err.message, 'err'); return false; }
        } },
      ],
    });
    setTimeout(() => (existing ? description : name).focus(), 0);
  }

  // ---------- connection (read-only) ----------
  async function drawConnection() {
    const s = await api('GET', '/api/status').catch(() => null);
    const row = (k, v) => h('div', { class: 'stat' }, h('span', null, k), h('span', { class: 'v' }, v));
    clear(connection,
      h('div', { class: 'card-head' }, h('h3', null, 'Connection')),
      s ? [
        row('Tunarr address', s.tunarrUrl || '(not set)'),
        row('Tunarr', s.connected ? `connected · version ${s.version}` : `not reachable${s.error ? ` · ${s.error}` : ''}`),
        row('Server time zone', s.timeZone),
        row('Database', s.storage.dbFile),
        row('Kept across updates', s.storage.persistent === true ? `yes${s.storage.volume ? ` (volume ${s.storage.volume})` : ' (mounted folder)'}`
          : s.storage.persistent === false ? 'NO: not on a volume' : 'not running in Docker'),
        row('Schedule Lab version', s.appVersion),
      ] : h('p', { class: 'err-text small' }, 'Could not read the server status.'),
      h('p', { class: 'dim small', style: { marginTop: '10px' } },
        'The Tunarr address and time zone are set by TUNARR_URL and TZ in docker-compose.yml, so the container restarts cleanly with them.'));
  }
}

function numberField(label, value, step, set) {
  return h('label', { class: 'field' }, h('span', { class: 'lab' }, label),
    h('input', { type: 'number', value: String(value), step, min: 0, oninput: e => set(Number(e.target.value)) }));
}

function checkField(label, value, set) {
  return h('div', null, h('label', { class: 'check', style: { marginTop: '20px' } },
    h('input', { type: 'checkbox', checked: value, onchange: e => set(e.target.checked) }), label));
}
