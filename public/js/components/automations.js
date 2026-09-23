// Shared pieces for automations: the timetable editor, run status and run
// details, and the Automations card on the Channels screen.
import { api, busy, clear, confirmDialog, fmtAgo, fmtWhen, h, modal, toast } from '../ui.js';
import { store } from '../store.js';
import { settingsForm } from './settings-form.js';
import { parseSettings } from '/shared/sort-settings.js';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const KINDS = [
  ['weekly', 'Weekly'], ['daily', 'Daily'], ['monthly', 'Monthly'], ['every', 'Every N days'], ['hours', 'Every N hours'], ['manual', 'Only when I run it'],
];

export function describeTimetable(t) {
  if (!t) return '';
  const when = t.at ? `at ${t.at}` : 'in the overnight window';
  switch (t.kind) {
    case 'manual': return 'Only when run by hand';
    case 'hours': return `Every ${t.everyHours} hour${t.everyHours === 1 ? '' : 's'}`;
    case 'daily': return `Daily ${when}`;
    case 'weekly': return `${t.days.length === 7 ? 'Every day' : t.days.join(', ')} ${when}`;
    case 'monthly': return `Monthly on day ${t.dayOfMonth} ${when}`;
    case 'every': return `Every ${t.everyDays} days from ${t.anchor} ${when}`;
    default: return t.kind;
  }
}

/** timetableEditor({ value, onChange, assignmentId }) -> element; `value` is edited in place. */
export function timetableEditor({ value, onChange, assignmentId }) {
  const t = value;
  const el = h('div');
  const next = h('div', { class: 'dim small', style: { marginBottom: '10px' } });
  let seq = 0;
  const showNext = async () => {
    const mine = ++seq;
    if (t.kind === 'manual') { next.textContent = ''; return; }
    try {
      const r = await api('POST', '/api/automations/timetable-preview', { timetable: t, assignmentId });
      if (mine === seq) next.textContent = r.next.length ? 'Next: ' + r.next.slice(0, 3).map(n => new Date(n).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })).join(' · ') : '';
    } catch (err) { if (mine === seq) next.textContent = err.message; }
  };
  const changed = () => { onChange(t); draw(); };

  function draw() {
    const kind = h('select', { onchange: e => {
      t.kind = e.target.value;
      if (t.kind === 'weekly' && !t.days?.length) t.days = ['Sun'];
      if (t.kind === 'monthly' && !t.dayOfMonth) t.dayOfMonth = 1;
      if (t.kind === 'every' && !t.everyDays) { t.everyDays = 3; t.anchor = new Date().toISOString().slice(0, 10); }
      if (t.kind === 'hours' && !t.everyHours) t.everyHours = 6;
      changed();
    } }, KINDS.map(([k, label]) => h('option', { value: k, selected: k === t.kind }, label)));
    const timed = !['manual', 'hours'].includes(t.kind);
    const anyTime = h('input', { type: 'checkbox', checked: !t.at, onchange: e => { t.at = e.target.checked ? null : '03:00'; changed(); } });
    const at = h('input', { type: 'time', value: t.at || '', disabled: !t.at, onchange: e => { t.at = e.target.value || null; changed(); } });
    clear(el,
      h('div', { class: 'row' },
        h('label', { class: 'field' }, h('span', { class: 'lab' }, 'Runs'), kind),
        t.kind === 'hours' ? h('label', { class: 'field' }, h('span', { class: 'lab' }, 'Every (hours)'),
          h('input', { type: 'number', min: 1, max: 168, value: String(t.everyHours), onchange: e => { t.everyHours = Number(e.target.value); changed(); } })) : null,
        t.kind === 'monthly' ? h('label', { class: 'field' }, h('span', { class: 'lab' }, 'Day of the month'),
          h('input', { type: 'number', min: 1, max: 31, value: String(t.dayOfMonth), onchange: e => { t.dayOfMonth = Number(e.target.value); changed(); } })) : null,
        t.kind === 'every' ? [
          h('label', { class: 'field' }, h('span', { class: 'lab' }, 'Every (days)'),
            h('input', { type: 'number', min: 1, max: 365, value: String(t.everyDays), onchange: e => { t.everyDays = Number(e.target.value); changed(); } })),
          h('label', { class: 'field' }, h('span', { class: 'lab' }, 'Starting'),
            h('input', { type: 'date', value: t.anchor || '', onchange: e => { t.anchor = e.target.value; changed(); } })),
        ] : null,
        timed ? h('div', { class: 'field' }, h('span', { class: 'lab' }, 'Time'),
          h('div', { class: 'btn-row' }, at, h('label', { class: 'check' }, anyTime, 'any time in the window'))) : null),
      t.kind === 'weekly' ? h('div', { class: 'btn-row', style: { marginBottom: '6px' } }, DAYS.map(d => h('button', {
        class: 'btn small' + (t.days.includes(d) ? ' active' : ''),
        onclick: () => { t.days = t.days.includes(d) ? t.days.filter(x => x !== d) : [...t.days, d]; if (!t.days.length) t.days = [d]; changed(); },
      }, d))) : null,
      next);
    showNext();
  }
  draw();
  return el;
}

const STATUS = {
  queued: ['pill', 'queued'], running: ['pill warn', 'running'], applied: ['pill ok', 'applied'], done: ['pill ok', 'done'],
  skipped: ['pill', 'skipped'], failed: ['pill err', 'failed'],
};
export function statusPill(run) {
  const [cls, text] = STATUS[run.status] || ['pill', run.status];
  return h('span', { class: cls, title: run.message || '' }, run.dryRun && run.status !== 'failed' ? `${text} (dry run)` : text);
}

/** Polls a queued run until it finishes; resolves with the finished run. */
export async function waitForRun(id, onProgress) {
  for (;;) {
    const r = await api('GET', `/api/automations/runs/${id}`);
    onProgress?.(r);
    if (r.status !== 'queued' && r.status !== 'running') return r;
    await new Promise(res => setTimeout(res, 1500));
  }
}

export function runBody(run) {
  return h('div', null,
    h('div', { class: 'btn-row', style: { marginBottom: '8px' } }, statusPill(run),
      h('span', { class: 'dim small' }, `${run.trigger} · ${run.channelName || run.channelId} · ${run.finishedAt ? fmtWhen(run.finishedAt) : run.startedAt ? 'started ' + fmtAgo(run.startedAt) : 'queued ' + fmtAgo(run.queuedAt)}${run.attempt > 1 ? ` · try ${run.attempt}` : ''}`)),
    run.message ? h('p', { class: run.status === 'failed' ? 'err-text' : '', style: { whiteSpace: 'pre-wrap' } }, run.message) : null,
    run.changes?.length ? [h('h3', null, run.dryRun ? 'Would change' : 'Changes'),
      h('ul', null, run.changes.map(c => h('li', null, c.detail, c.backupId ? h('span', { class: 'dim small' }, ` (backup #${c.backupId})`) : null)))] : null,
    run.logs?.length ? [h('h3', null, 'Log'), h('div', { class: 'log' }, run.logs.map(l => h('div', { class: 'line' + (/^error:/.test(l) ? ' err' : /^warn:/.test(l) ? ' warn' : '') }, l)))] : null,
    run.result !== null && run.result !== undefined ? [h('h3', null, 'Returned'), h('pre', { class: 'code-view' }, JSON.stringify(run.result, null, 2))] : null);
}

export async function showRun(id) {
  const run = await api('GET', `/api/automations/runs/${id}`).catch(err => { toast(err.message, 'err'); return null; });
  if (!run) return;
  modal({ title: `${run.automationName} v${run.version ?? '?'}: run #${run.id}`, wide: true, body: runBody(run) });
}

/**
 * The Automations card for one channel: its assigned automations with their
 * settings and timetables, Run now / Dry run, recent runs, and pool
 * suggestions. onPoolChanged(pool) after a suggestion is approved.
 */
export function automationsCard({ channel, go, onPoolChanged }) {
  const el = h('div', { class: 'card' }, h('h3', null, 'Automations'), h('div', { class: 'dim small' }, h('span', { class: 'spinner' }), ' Loading…'));
  const open = new Set();
  const saveTimers = new Map();

  async function draw() {
    let library, assignments, runs, suggestions;
    try {
      [library, assignments, runs, suggestions] = await Promise.all([
        api('GET', '/api/automations'),
        api('GET', `/api/assignments?channelId=${encodeURIComponent(channel.id)}`),
        api('GET', `/api/automations/runs?channelId=${encodeURIComponent(channel.id)}&limit=5`),
        api('GET', `/api/channels/${encodeURIComponent(channel.id)}/suggestions`),
      ]);
    } catch (err) {
      clear(el, h('h3', null, 'Automations'), h('p', { class: 'err-text small' }, err.message));
      return;
    }
    const addSelect = h('select', null, h('option', { value: '' }, '+ Add an automation…'), library.map(a => h('option', { value: a.id }, a.name)));
    addSelect.onchange = async () => {
      const id = Number(addSelect.value);
      if (!id) return;
      try {
        const a = await api('POST', `/api/channels/${encodeURIComponent(channel.id)}/automations`, { automationId: id });
        open.add(a.id);
        toast(`Added "${a.automationName}" (${describeTimetable(a.timetable)}). Change when it runs and its settings below.`, 'ok', 7000);
      } catch (err) { toast(err.message, 'err'); }
      draw();
    };

    clear(el,
      h('div', { class: 'card-head' }, h('h3', null, 'Automations'),
        h('div', { class: 'btn-row' },
          library.length ? addSelect : h('button', { class: 'btn small', onclick: e => busy(e.currentTarget, async () => {
            const r = await api('POST', '/api/automations/import-presets');
            toast(`Imported ${r.added.length} starter automation(s).`, 'ok');
            draw();
          }) }, 'Import starter automations'),
          h('button', { class: 'btn small ghost', onclick: () => go('automations') }, 'Library'))),
      assignments.length ? null : h('p', { class: 'dim small' }, 'No automations on this channel. Automations rebuild the lineup on a timetable, look for new shows, and more; each one only changes this channel.'),
      assignments.map(a => assignmentRow(a)),
      suggestions.length ? suggestionsBox(suggestions) : null,
      runs.length ? h('div', { style: { marginTop: '10px' } }, h('span', { class: 'lab' }, 'Recent runs'),
        h('table', { class: 'grid' }, h('tbody', null, runs.map(r => h('tr', { class: 'clickable', onclick: () => showRun(r.id) },
          h('td', null, statusPill(r)),
          h('td', { class: 'small' }, r.automationName),
          h('td', { class: 'small dim' }, r.message.slice(0, 120)),
          h('td', { class: 'small dim' }, fmtAgo(r.finishedAt || r.queuedAt))))))) : null);
  }

  function saveSoon(a, body) {
    clearTimeout(saveTimers.get(a.id));
    saveTimers.set(a.id, setTimeout(async () => {
      try { Object.assign(a, await api('PUT', `/api/assignments/${a.id}`, body())); }
      catch (err) { toast(err.message, 'err'); }
    }, 500));
  }

  function assignmentRow(a) {
    const behind = a.latestVersion && a.version < a.latestVersion;
    const settingsBox = h('div', { hidden: !open.has(a.id), style: { padding: '8px 0 4px' } });
    const nextText = h('span', { class: 'dim small' }, !a.enabled ? 'off' : a.nextRunAt ? 'next ' + fmtWhen(a.nextRunAt) : describeTimetable(a.timetable));
    const run = (dryRun) => async e => busy(e.currentTarget, async () => {
      const q = await api('POST', `/api/assignments/${a.id}/run`, { dryRun });
      toast(`${dryRun ? 'Dry run' : 'Run'} queued…`, '');
      const done = await waitForRun(q.id);
      toast(`${a.automationName}: ${done.status}${done.message ? ' · ' + done.message.slice(0, 160) : ''}`, done.status === 'failed' ? 'err' : 'ok', 9000);
      if (!dryRun && done.changes.some(c => c.kind.startsWith('pool'))) onPoolChanged?.();
      await draw();
      showRun(done.id);
    });

    const drawSettings = async () => {
      const v = await api('GET', `/api/automations/${a.automationId}/versions/${a.version}`);
      const settings = parseSettings(v.code).settings;
      const detail = await api('GET', `/api/automations/${a.automationId}`);
      const versionSelect = h('select', { onchange: async e => {
        try { Object.assign(a, await api('PUT', `/api/assignments/${a.id}`, { version: Number(e.target.value) })); draw(); } catch (err) { toast(err.message, 'err'); }
      } }, detail.versions.map(x => h('option', { value: x.version, selected: x.version === a.version }, `v${x.version}${x.version === detail.latest_version ? ' (latest)' : ''}${x.note ? ' · ' + x.note : ''}`)));
      clear(settingsBox,
        h('div', { class: 'row' }, h('label', { class: 'field' }, h('span', { class: 'lab' }, 'Version'), versionSelect)),
        h('span', { class: 'lab' }, 'When'),
        timetableEditor({ value: structuredClone(a.timetable), assignmentId: a.id, onChange: t => saveSoon(a, () => ({ timetable: t })) }),
        h('span', { class: 'lab' }, 'Settings for this channel'),
        settingsForm({ settings, values: a.values, globals: store.globals || [], emptyText: 'This automation declares no settings.',
          onChange: vals => { a.values = { ...a.values, ...vals }; saveSoon(a, () => ({ values: a.values })); } }));
    };
    if (open.has(a.id)) drawSettings().catch(err => clear(settingsBox, h('p', { class: 'err-text small' }, err.message)));

    return h('div', { class: 'assignment' },
      h('div', { class: 'btn-row' },
        h('label', { class: 'check', title: 'Run on its timetable' },
          h('input', { type: 'checkbox', checked: a.enabled, onchange: async e => {
            try { Object.assign(a, await api('PUT', `/api/assignments/${a.id}`, { enabled: e.target.checked })); draw(); } catch (err) { toast(err.message, 'err'); }
          } })),
        h('b', null, a.automationName), h('span', { class: 'mono dim' }, `v${a.version}`),
        behind ? h('span', { class: 'pill warn', title: `v${a.latestVersion} is available (change it under Settings)` }, 'update') : null,
        a.lastRun ? statusPill(a.lastRun) : null,
        nextText,
        h('span', { style: { flex: 1 } }),
        h('button', { class: 'btn small ghost', onclick: () => {
          if (open.has(a.id)) open.delete(a.id); else open.add(a.id);
          settingsBox.hidden = !open.has(a.id);
          if (open.has(a.id)) drawSettings().catch(err => clear(settingsBox, h('p', { class: 'err-text small' }, err.message)));
        } }, 'Settings'),
        h('button', { class: 'btn small', title: 'Run it and show what it would change, without changing anything', onclick: run(true) }, 'Dry run'),
        h('button', { class: 'btn small', title: 'Run it now (backs up first if it applies)', onclick: run(false) }, 'Run now'),
        h('button', { class: 'btn small ghost', onclick: async () => {
          if (!(await confirmDialog({ title: 'Remove automation', message: `Remove "${a.automationName}" from ${channel.name}? Its settings for this channel are lost; the automation stays in the library.`, confirmLabel: 'Remove', danger: true }))) return;
          try { await api('DELETE', `/api/assignments/${a.id}`); draw(); } catch (err) { toast(err.message, 'err'); }
        } }, 'Remove')),
      settingsBox);
  }

  function suggestionsBox(list) {
    return h('div', { style: { marginTop: '10px' } },
      h('span', { class: 'lab' }, `Suggested for the pool (${list.length})`),
      h('table', { class: 'grid' }, h('tbody', null, list.map(s => h('tr', null,
        h('td', null, h('span', { class: 'tag' }, s.source.kind), ' ', s.source.label, s.reason ? h('div', { class: 'dim small' }, s.reason) : null),
        h('td', { class: 'small dim' }, `${s.automationName} · ${fmtAgo(s.createdAt)}`),
        h('td', { class: 'actions' },
          h('button', { class: 'btn small primary', onclick: e => busy(e.currentTarget, async () => {
            const r = await api('POST', `/api/suggestions/${s.id}/approve`);
            toast(`Added ${s.source.label} to the pool.${r.converted ? ` The ${r.converted} shows on the lineup became pool sources first, so they stay.` : ''}`, 'ok', 9000);
            onPoolChanged?.(r.pool);
            draw();
          }) }, 'Add'),
          h('button', { class: 'btn small ghost', title: 'Dismiss; it won\'t be suggested again', onclick: e => busy(e.currentTarget, async () => {
            await api('POST', `/api/suggestions/${s.id}/dismiss`);
            draw();
          }) }, 'Dismiss')))))));
  }

  draw();
  el.refresh = draw;
  return el;
}
