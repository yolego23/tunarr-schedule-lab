// History: every apply, undo and restore across channels (by hand, quick
// rebuilds, Compare and automations), and for one channel its backups,
// undo and the guide check. Building and applying happens on the channel's
// Rebuild tab.
import { api, busy, clear, confirmDialog, download, fmtDur, h, slug, toast } from '../ui.js';
import { channelLabel, findChannel, forgetChannelData, loadChannels, loadSettings, selectChannel, store } from '../store.js';
import { guideCheckCard, report, undoLast } from '../components/rebuild.js';

export async function render(root, { params, go }) {
  await Promise.all([loadChannels(), loadSettings()]);
  let channelId = params.get('channel') || '';
  if (channelId) selectChannel(channelId);

  const channelSelect = h('select', null, h('option', { value: '' }, 'All channels'),
    store.channels.map(c => h('option', { value: c.id, selected: c.id === channelId }, channelLabel(c))));
  const historyBox = h('div');
  const side = h('div', { class: 'panel-body' });

  clear(root, h('div', { class: 'screen two' },
    h('div', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('span', null, 'History'), h('div', { style: { minWidth: '240px' } }, channelSelect)),
      h('div', { class: 'panel-body' }, historyBox),
      h('div', { class: 'panel-foot' }, h('span', { class: 'dim small' }, 'Applies, undos and restores, newest first. Automation runs (including ones that changed nothing) are on the '),
        h('a', { href: '#/automations', class: 'small' }, 'Automations'), h('span', { class: 'dim small' }, ' screen.'))),
    h('div', { class: 'panel' }, h('div', { class: 'panel-head' }, 'Channel'), side)));

  channelSelect.onchange = () => {
    channelId = channelSelect.value;
    if (channelId) selectChannel(channelId);
    drawAll();
  };

  async function drawHistory() {
    const rows = await api('GET', `/api/history${channelId ? `?channelId=${encodeURIComponent(channelId)}` : ''}`);
    if (!rows.length) { clear(historyBox, h('p', { class: 'dim small' }, 'Nothing applied yet.')); return; }
    clear(historyBox, h('div', { class: 'table-wrap' }, h('table', { class: 'grid' },
      h('thead', null, h('tr', null, ['When', channelId ? null : 'Channel', 'What', 'Lineup', 'Result'].filter(Boolean).map(t => h('th', null, t)))),
      h('tbody', null, rows.map(r => h('tr', null,
        h('td', { class: 'small' }, new Date(r.createdAt).toLocaleString()),
        channelId ? null : h('td', { class: 'small' }, h('a', { href: '#', onclick: e => { e.preventDefault(); channelSelect.value = r.channelId; channelSelect.onchange(); } }, r.channelName || r.channelId)),
        h('td', { class: 'small' }, h('b', null, r.action), ' ', r.detail),
        h('td', { class: 'small mono' }, r.itemCount != null ? `${r.itemCount} · ${fmtDur(r.durationMs)}` : ''),
        h('td', { class: 'small' }, r.ok ? h('span', { class: 'ok-text' }, 'OK') : h('span', { class: 'err-text' }, 'Failed'),
          r.message ? h('div', { class: r.ok ? 'warn-text' : 'err-text', style: { whiteSpace: 'pre-wrap', maxWidth: '420px' } }, r.message) : null)))))));
  }

  async function drawSide() {
    const ch = findChannel(channelId);
    if (!ch) {
      clear(side, h('div', { class: 'empty' }, h('b', null, 'Pick a channel'), 'Choose a channel above (or click one in the list) to see its backups, undo its last change, or check the guide.'));
      return;
    }
    const guide = guideCheckCard(ch.id);
    const backupsBox = h('div', null, h('p', { class: 'dim small' }, h('span', { class: 'spinner' }), ' Loading…'));
    const afterChange = r => { report(r, 'Done'); forgetChannelData(ch.id); drawAll(); setTimeout(() => guide.run(), 3000); };
    clear(side,
      h('div', { class: 'card' },
        h('h3', null, channelLabel(ch)),
        h('div', { class: 'btn-row' },
          h('button', { class: 'btn', onclick: e => busy(e.currentTarget, async () => { const r = await undoLast(ch); if (r) { forgetChannelData(ch.id); drawAll(); setTimeout(() => guide.run(), 3000); } }) }, 'Undo last change'),
          h('button', { class: 'btn ghost', onclick: () => { store.channelTab = 'rebuild'; selectChannel(ch.id); go('channels'); } }, 'Rebuild this channel…'))),
      guide,
      h('div', { class: 'card' }, h('h3', null, `Backups (last ${store.settings.backupsPerChannel})`), backupsBox));

    const backups = await api('GET', `/api/channels/${encodeURIComponent(ch.id)}/backups`);
    if (!backups.length) { clear(backupsBox, h('p', { class: 'dim small' }, 'No backups yet. One is saved automatically before every change.')); return; }
    clear(backupsBox, h('div', { class: 'table-wrap' }, h('table', { class: 'grid' },
      h('thead', null, h('tr', null, ['#', 'Saved', 'Why', 'Lineup', ''].map(t => h('th', null, t)))),
      h('tbody', null, backups.map(b => h('tr', null,
        h('td', { class: 'mono dim' }, b.id),
        h('td', { class: 'small' }, new Date(b.createdAt).toLocaleString()),
        h('td', { class: 'small' }, b.reason),
        h('td', { class: 'small mono' }, `${b.itemCount} · ${fmtDur(b.durationMs)}`),
        h('td', { class: 'actions' },
          h('button', { class: 'btn small', onclick: e => busy(e.currentTarget, async () => {
            const ok = await confirmDialog({
              title: 'Restore backup',
              message: `Put ${ch.name} back to backup #${b.id} from ${new Date(b.createdAt).toLocaleString()} (${b.itemCount} items, ${fmtDur(b.durationMs)})?\n\nThe lineup as it is now is backed up first.`,
              confirmLabel: 'Restore', danger: true,
            });
            if (!ok) return;
            afterChange(await api('POST', `/api/backups/${b.id}/restore`));
          }) }, 'Restore'),
          h('button', { class: 'btn small ghost', onclick: async () => {
            try { download(`backup-${slug(ch.name)}-${b.id}.json`, await api('GET', `/api/backups/${b.id}`)); } catch (err) { toast(err.message, 'err'); }
          } }, 'Download'))))))));
  }

  function drawAll() {
    drawHistory().catch(err => clear(historyBox, h('p', { class: 'err-text small' }, err.message)));
    drawSide().catch(err => clear(side, h('p', { class: 'err-text small' }, err.message)));
  }
  drawAll();
}
