// Sort Library: every saved sort with its description, settings and
// versions. Duplicate, rename, delete, import or export.
import { api, busy, clear, confirmDialog, download, fmtAgo, h, modal, pickJsonFile, promptDialog, slug, toast } from '../ui.js';
import { findChannel, loadChannels, loadSorts, store } from '../store.js';

export async function render(root, { go }) {
  const body = h('div', { class: 'page-width' });
  clear(root, h('div', { class: 'scroll-page' }, body));
  await loadChannels().catch(() => null);

  async function draw(force = false) {
    const sorts = await loadSorts(force);
    const toolbar = h('div', { class: 'btn-row', style: { marginBottom: '14px' } },
      h('button', { class: 'btn primary', onclick: () => go('builder', { sort: 'new' }) }, '+ New sort'),
      h('button', { class: 'btn', onclick: e => busy(e.currentTarget, async () => {
        const r = await api('POST', '/api/sorts/import-presets');
        toast(r.added.length
          ? `Imported ${r.added.join(', ')}.${r.skipped.length ? ` Skipped ${r.skipped.join(', ')} (already in the library).` : ''}`
          : 'All the 1.8 sorts are already in the library (by name). Rename or delete one to import it again.', r.added.length ? 'ok' : 'warn', 8000);
        await draw(true);
      }) }, 'Import 1.8 sorts'),
      h('button', { class: 'btn', onclick: async () => {
        const data = await pickJsonFile();
        if (!data) return;
        try {
          const r = await api('POST', '/api/sorts/import', data);
          toast(r.added.length ? `Added ${r.added.join(', ')}.` : 'No sorts found in that file.', r.added.length ? 'ok' : 'warn');
          await draw(true);
        } catch (err) { toast(err.message, 'err'); }
      } }, 'Import from file'),
      sorts.length ? h('button', { class: 'btn ghost', onclick: async () => {
        const all = await Promise.all(sorts.map(s => api('GET', `/api/sorts/${s.id}/export`)));
        download(`schedule-lab-sorts-${new Date().toISOString().slice(0, 10)}.json`, { kind: 'schedule-lab-sorts', formatVersion: 1, sorts: all });
      } }, 'Export all') : null);

    if (!sorts.length) {
      clear(body, h('h2', null, 'Sort Library'), toolbar,
        h('div', { class: 'card' }, h('div', { class: 'empty' },
          h('b', null, 'The library is empty'),
          'Schedule Lab has no built-in sorts. Import the five 1.8 sorts (no-repeat shuffle, full cycle, time-block insert, AI optimizer, work-schedule sort) as a starting point, or write your own in the Sort Builder.')));
      return;
    }

    const rows = sorts.map(s => h('tr', null,
      h('td', null,
        h('div', null, h('b', null, s.name)),
        s.description ? h('div', { class: 'dim small' }, s.description) : null),
      h('td', { class: 'mono' }, `v${s.latest_version}`),
      h('td', { class: 'small' }, s.settings.length ? s.settings.map(x => x.key).join(', ') : h('span', { class: 'dim' }, 'none')),
      h('td', { class: 'small' }, s.usedBy.length
        ? s.usedBy.map(u => {
          const c = findChannel(u.channelId);
          return h('div', null, c ? `${c.number} ${c.name}` : u.channelId, ' ',
            h('span', { class: `mono ${u.version < s.latest_version ? 'warn-text' : 'dim'}` }, `v${u.version}`));
        })
        : h('span', { class: 'dim' }, 'no channels')),
      h('td', { class: 'small dim' }, fmtAgo(s.updated_at)),
      h('td', { class: 'actions' },
        h('button', { class: 'btn small primary', onclick: () => go('builder', { sort: s.id }) }, 'Edit'),
        h('button', { class: 'btn small', onclick: () => showVersions(s) }, 'Versions'),
        h('button', { class: 'btn small', onclick: e => busy(e.currentTarget, async () => {
          const copy = await api('POST', `/api/sorts/${s.id}/duplicate`);
          toast(`Created "${copy.name}".`, 'ok');
          await draw(true);
        }) }, 'Duplicate'),
        h('button', { class: 'btn small', onclick: async () => {
          const name = await promptDialog({ title: 'Rename sort', label: 'Name', value: s.name });
          if (!name || name === s.name) return;
          try { await api('PUT', `/api/sorts/${s.id}`, { name }); await draw(true); } catch (err) { toast(err.message, 'err'); }
        } }, 'Rename'),
        h('button', { class: 'btn small', onclick: async () => {
          try { download(`sort-${slug(s.name)}.json`, await api('GET', `/api/sorts/${s.id}/export`)); } catch (err) { toast(err.message, 'err'); }
        } }, 'Export'),
        h('button', { class: 'btn small ghost', onclick: async () => {
          if (!(await confirmDialog({ title: 'Delete sort', message: `Delete "${s.name}" and all ${s.latest_version} version(s)? This can't be undone (export it first if you might want it back).`, confirmLabel: 'Delete', danger: true }))) return;
          try { await api('DELETE', `/api/sorts/${s.id}`); toast(`Deleted "${s.name}".`, 'ok'); await draw(true); } catch (err) { toast(err.message, 'err'); }
        } }, 'Delete'))));

    clear(body,
      h('h2', null, 'Sort Library'),
      h('p', { class: 'dim' }, 'Every saved sort and version. Channels stay on the version they were set up with until you move them up on the Channels screen.'),
      toolbar,
      h('div', { class: 'card', style: { padding: 0 } }, h('div', { class: 'table-wrap' },
        h('table', { class: 'grid' },
          h('thead', null, h('tr', null, ['Sort', 'Latest', 'Settings', 'Used by', 'Updated', ''].map(t => h('th', null, t)))),
          h('tbody', null, rows)))));
  }

  async function showVersions(s) {
    const detail = await api('GET', `/api/sorts/${s.id}`);
    const viewer = h('div');
    const close = modal({
      title: `${s.name}: versions`,
      wide: true,
      body: h('div', null,
        h('table', { class: 'grid' },
          h('thead', null, h('tr', null, ['Version', 'Note', 'Saved', 'Channels on it', ''].map(t => h('th', null, t)))),
          h('tbody', null, detail.versions.map(v => h('tr', null,
            h('td', { class: 'mono' }, `v${v.version}${v.version === detail.latest_version ? ' (latest)' : ''}`),
            h('td', null, v.note || h('span', { class: 'dim' }, '—')),
            h('td', { class: 'small dim' }, new Date(v.created_at).toLocaleString()),
            h('td', { class: 'small' }, detail.usedBy.filter(u => u.version === v.version).map(u => findChannel(u.channelId)?.name || u.channelId).join(', ') || h('span', { class: 'dim' }, '—')),
            h('td', { class: 'actions' },
              h('button', { class: 'btn small', onclick: async () => {
                const full = await api('GET', `/api/sorts/${s.id}/versions/${v.version}`);
                clear(viewer, h('h3', null, `v${v.version} code`), h('pre', { class: 'code-view' }, full.code));
              } }, 'View code'),
              v.version !== detail.latest_version ? h('button', { class: 'btn small', onclick: async () => {
                const full = await api('GET', `/api/sorts/${s.id}/versions/${v.version}`);
                const saved = await api('POST', `/api/sorts/${s.id}/versions`, { code: full.code, note: `Brought back v${v.version}` });
                toast(`Saved v${v.version}'s code as v${saved.latest_version}.`, 'ok');
                close();
                draw(true);
              } }, 'Make latest') : null))))),
        viewer),
    });
  }

  await draw();
}
