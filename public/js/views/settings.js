// Settings: global settings, and global variables that every sort can read
// (ctx.globals) and that channel settings can link to.
import { api, busy, clear, confirmDialog, fmtAgo, h, modal, toast } from '../ui.js';
import { findChannel, loadChannels, loadGlobals, loadSettings, setUnsaved, store } from '../store.js';
import { settingsForm } from '../components/settings-form.js';
import { GLOBAL_NAME_RE, GLOBAL_TYPES, coerce } from '/shared/sort-settings.js';

export async function render(root) {
  const page = h('div', { class: 'page-width' });
  clear(root, h('div', { class: 'scroll-page' }, page));
  await Promise.all([loadSettings(true), loadGlobals(true), loadChannels().catch(() => null)]);

  const connection = h('div', { class: 'card' });
  const globalsCard = h('div', { class: 'card' });
  const aiCard = h('div', { class: 'card' });
  const aiUsageCard = h('div', { class: 'card' });
  clear(page,
    h('h2', null, 'Settings'),
    h('p', { class: 'dim' }, 'Global settings apply to the whole app. Global variables are shared values every sort can read, and any channel setting can link to.'),
    globalsCard,
    aiCard,
    aiUsageCard,
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
      title: 'Automations',
      note: 'Timetables without a set time run somewhere in this window, at a different spot for each channel. Runs wait in one queue; the time limit counts only the automation's own code (not the sorts it builds, applies or AI calls). Runs that fail because Tunarr can't be reached are tried again.',
      key: 'automations',
      fields: v => [
        checkField('Run automations on their timetables', v.enabled, x => { v.enabled = x; }),
        timeField('Window starts', v.windowStart, x => { v.windowStart = x; }),
        timeField('Window ends', v.windowEnd, x => { v.windowEnd = x; }),
        numberField('Automations at once (1 or 2)', v.concurrency, 1, x => { v.concurrency = x; }),
        numberField('Time limit per run (seconds)', v.timeLimitSec, 1, x => { v.timeLimitSec = x; }),
        numberField('Retries when Tunarr is unreachable', v.retries, 1, x => { v.retries = x; }),
        numberField('Minutes between retries', v.retryDelayMin, 1, x => { v.retryDelayMin = x; }),
        numberField('Keep run history (days)', v.keepRunsDays, 1, x => { v.keepRunsDays = x; }),
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
  drawAi().catch(err => clear(aiCard, h('p', { class: 'err-text small' }, err.message)));

  // ---------- AI ----------
  async function drawAi() {
    const cfg = await api('GET', '/api/ai');
    const unsavedKey = 'settings:ai';
    const mark = () => setUnsaved(unsavedKey, "Settings: the AI settings have changes that aren't saved.");
    const keyInput = p => h('input', {
      type: 'password', autocomplete: 'off',
      placeholder: cfg[p].apiKeySet ? `saved (${cfg[p].apiKeyHint}); type to replace` : 'not set',
      oninput: mark,
    });
    const modelInput = (p, value, placeholder) => {
      const list = h('datalist', { id: 'models-' + p });
      const input = h('input', { type: 'text', value: value || '', list: 'models-' + p, placeholder, oninput: mark });
      let loaded = false;
      input.addEventListener('focus', async () => {
        if (loaded) return;
        loaded = true;
        try { for (const m of await api('GET', '/api/ai/models/' + p)) list.append(h('option', { value: m })); }
        catch (err) { loaded = false; toast(err.message, 'warn'); }
      });
      return [input, list];
    };
    const anthropicKey = keyInput('anthropic');
    const openrouterKey = keyInput('openrouter');
    const ollamaUrl = h('input', { type: 'text', value: cfg.ollama.baseUrl, placeholder: 'http://192.168.1.50:11434', oninput: mark });
    const [anthropicModel, anthropicList] = modelInput('anthropic', cfg.anthropic.model, 'claude-opus-5');
    const [openrouterModel, openrouterList] = modelInput('openrouter', cfg.openrouter.model, 'for example anthropic/claude-sonnet-5');
    const [ollamaModel, ollamaList] = modelInput('ollama', cfg.ollama.model, 'for example llama3.2');
    const NAMES = { anthropic: 'Anthropic', openrouter: 'OpenRouter', ollama: 'Ollama' };
    const defaultSelect = h('select', { onchange: mark },
      h('option', { value: '' }, '(none: AI off)'),
      Object.keys(NAMES).map(p => h('option', { value: p, selected: cfg.defaultProvider === p }, NAMES[p])));
    const allow = Object.fromEntries(['builder', 'sorts', 'automations'].map(k => [k, h('input', { type: 'checkbox', checked: cfg.allow[k], onchange: mark })]));
    const cap = h('input', { type: 'number', min: 0, step: 1, value: String(cfg.monthlyCapUsd), oninput: mark });

    const payload = () => {
      const body = {
        defaultProvider: defaultSelect.value,
        anthropic: { model: anthropicModel.value.trim() },
        openrouter: { model: openrouterModel.value.trim() },
        ollama: { baseUrl: ollamaUrl.value.trim(), model: ollamaModel.value.trim() },
        allow: { builder: allow.builder.checked, sorts: allow.sorts.checked, automations: allow.automations.checked },
        monthlyCapUsd: Number(cap.value) || 0,
      };
      // Keys are only sent when typed; a blank box keeps the saved key.
      if (anthropicKey.value.trim()) body.anthropic.apiKey = anthropicKey.value.trim();
      if (openrouterKey.value.trim()) body.openrouter.apiKey = openrouterKey.value.trim();
      return body;
    };
    const save = async () => {
      await api('PUT', '/api/ai', payload());
      setUnsaved(unsavedKey, null);
    };
    const saveBtn = h('button', { class: 'btn primary small' }, 'Save');
    saveBtn.onclick = () => busy(saveBtn, async () => { await save(); toast('Saved the AI settings.', 'ok'); drawAi(); });

    const testBtn = p => {
      const b = h('button', { class: 'btn small' }, 'Test');
      b.onclick = () => busy(b, async () => {
        await save();
        const r = await api('POST', '/api/ai/test/' + p);
        if (r.ok) toast(NAMES[p] + ' answered "' + r.reply + '" using ' + r.model + ' in ' + (r.ms / 1000).toFixed(1) + ' s' + (r.costUsd ? ' ($' + r.costUsd.toFixed(4) + ')' : '') + '.', 'ok', 8000);
        else toast(NAMES[p] + ': ' + r.error, 'err');
        drawAi();
      });
      return b;
    };
    const removeKey = p => cfg[p].apiKeySet ? h('button', { class: 'btn small ghost', onclick: async () => {
      if (!(await confirmDialog({ title: 'Remove API key', message: 'Remove the saved ' + NAMES[p] + ' API key?', confirmLabel: 'Remove', danger: true }))) return;
      try { await api('PUT', '/api/ai', { [p]: { apiKey: '' }, ...(cfg.defaultProvider === p ? { defaultProvider: '' } : {}) }); drawAi(); }
      catch (err) { toast(err.message, 'err'); }
    } }, 'Remove key') : null;

    const field = (label, ...input) => h('label', { class: 'field' }, h('span', { class: 'lab' }, label), ...input);
    const provider = (p, note, fields) => h('div', { class: 'card flat', style: { marginBottom: '10px' } },
      h('div', { class: 'card-head' },
        h('b', null, NAMES[p], ' ', cfg.configured.includes(p) ? h('span', { class: 'pill ok' }, 'set up') : h('span', { class: 'pill' }, 'not set up')),
        h('div', { class: 'btn-row' }, removeKey(p), testBtn(p))),
      h('p', { class: 'dim small' }, note),
      h('div', { class: 'row' }, fields));

    clear(aiCard,
      h('div', { class: 'card-head' }, h('h3', null, 'AI'), saveBtn),
      h('p', { class: 'dim small' },
        'Optional. Used only by "Ask AI" buttons and by sort or automation code that calls ', h('code', null, 'ctx.ai.ask()'),
        ". With Anthropic or OpenRouter, prompts (which can include show titles) leave your network; with Ollama they stay on it. API keys are kept in Schedule Lab's database and in exports, and never shown again after saving."),
      provider('anthropic', 'Claude models with your Anthropic API key.', [field('API key', anthropicKey), field('Model', anthropicModel, anthropicList)]),
      provider('openrouter', 'Many models from different companies with one OpenRouter key; the cost of each call is reported.', [field('API key', openrouterKey), field('Model', openrouterModel, openrouterList)]),
      provider('ollama', 'Local models on your network, with no key and no cost. Use an address the Schedule Lab server can reach (inside Docker, localhost is the container itself).', [field('Address', ollamaUrl), field('Model', ollamaModel, ollamaList)]),
      h('div', { class: 'row' },
        field('Default provider', defaultSelect, h('span', { class: 'hint' }, 'Code can still pick another provider that is set up.')),
        field('Monthly spending cap (US $, 0 = none)', cap, h('span', { class: 'hint' }, 'Anthropic and OpenRouter. Spent this month: $' + cfg.spentThisMonthUsd.toFixed(2)))),
      h('span', { class: 'lab' }, 'Allow AI in'),
      h('div', { class: 'btn-row' },
        h('label', { class: 'check' }, allow.builder, 'Channel Builder'),
        h('label', { class: 'check' }, allow.sorts, 'Sorts'),
        h('label', { class: 'check' }, allow.automations, 'Automations')));
    drawAiUsage();
  }

  async function drawAiUsage() {
    const rows = await api('GET', '/api/ai/usage?limit=25').catch(() => []);
    const money = v => (v === null || v === undefined ? '?' : v === 0 ? 'free' : '$' + v.toFixed(4));
    clear(aiUsageCard,
      h('div', { class: 'card-head' }, h('h3', null, 'AI usage (latest 25 calls)')),
      rows.length
        ? h('div', { class: 'table-wrap' }, h('table', { class: 'grid' },
            h('thead', null, h('tr', null, ['When', 'For', 'Provider · model', 'Tokens in / out', 'Cost', 'Result'].map(t => h('th', null, t)))),
            h('tbody', null, rows.map(r => h('tr', null,
              h('td', { class: 'small' }, fmtAgo(r.at)),
              h('td', { class: 'small' }, r.feature, r.channelId ? h('span', { class: 'dim' }, ' · ' + (findChannel(r.channelId)?.name || r.channelId)) : ''),
              h('td', { class: 'small mono' }, r.provider + ' · ' + r.model),
              h('td', { class: 'small mono' }, r.inputTokens != null ? r.inputTokens + ' / ' + r.outputTokens : '—'),
              h('td', { class: 'small mono' }, r.ok ? money(r.costUsd) : '—'),
              h('td', { class: 'small' }, r.ok ? h('span', { class: 'ok-text' }, 'OK') : h('span', { class: 'err-text', title: r.error || '' }, (r.error || 'failed').slice(0, 90))))))))
        : h('p', { class: 'dim small' }, 'No AI calls yet.'));
  }


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

function timeField(label, value, set) {
  return h('label', { class: 'field' }, h('span', { class: 'lab' }, label),
    h('input', { type: 'time', value: String(value), oninput: e => set(e.target.value) }));
}

function checkField(label, value, set) {
  return h('div', null, h('label', { class: 'check', style: { marginTop: '20px' } },
    h('input', { type: 'checkbox', checked: value, onchange: e => set(e.target.checked) }), label));
}
