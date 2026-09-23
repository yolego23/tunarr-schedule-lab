// Apply & History: apply a preview (after a backup), undo, restore any of the
// last 20 backups, check the guide, and see what changed when.
import { api, busy, clear, confirmDialog, download, fmtAgo, fmtDur, fmtWhen, h, slug, toast } from '../ui.js';
import { channelLabel, findChannel, forgetChannelData, loadChannelData, loadChannels, loadSettings, selectChannel, store } from '../store.js';

export async function render(root, { params, go }) {
  await Promise.all([loadChannels(), loadSettings()]);
  const requested = params.get('channel');
  if (requested) selectChannel(requested);

  const channelSelect = h('select', null, h('option', { value: '' }, '— pick a channel —'),
    store.channels.map(c => h('option', { value: c.id, selected: c.id === store.selectedChannelId }, channelLabel(c))));
  const readyCard = h('div', { class: 'card' });
  const guideCard = h('div', { class: 'card' });
  const backupsBox = h('div');
  const historyBox = h('div');
  const allHistory = h('input', { type: 'checkbox' });

  clear(root, h('div', { class: 'screen three' },
    h('div', { class: 'panel' },
      h('div', { class: 'panel-head' }, 'Apply'),
      h('div', { class: 'panel-body' },
        h('label', { class: 'field' }, h('span', { class: 'lab' }, 'Channel'), channelSelect),
        readyCard,
        guideCard)),
    h('div', { class: 'panel' },
      h('div', { class: 'panel-head' }, 'Backups & history'),
      h('div', { class: 'panel-body' },
        h('h3', null, `Backups (last ${store.settings.backupsPerChannel} for this channel)`),
        backupsBox,
        h('div', { class: 'btn-row', style: { justifyContent: 'space-between', marginTop: '18px' } },
          h('h3', { style: { margin: 0 } }, 'History'),
          h('label', { class: 'check', style: { margin: 0 } }, allHistory, 'All channels')),
        historyBox))));

  channelSelect.onchange = () => { selectChannel(channelSelect.value); drawAll(); };
  allHistory.onchange = () => drawHistory();

  async function drawReady() {
    const ch = findChannel(store.selectedChannelId);
    if (!ch) {
      clear(readyCard, h('div', { class: 'empty' }, h('b', null, 'Pick a channel'), 'Choose the channel to apply to or undo.'));
      return;
    }
    const preview = store.lastPreview.get(ch.id);
    const undoBtn = h('button', { class: 'btn', onclick: e => busy(e.currentTarget, async () => {
      const ok = await confirmDialog({
        title: 'Undo last change',
        message: `Put ${ch.name} back the way it was before its most recent apply, undo or restore?\n\nThe lineup as it is now is backed up first, so this can be undone too.`,
        confirmLabel: 'Undo',
      });
      if (!ok) return;
      const r = await api('POST', `/api/channels/${encodeURIComponent(ch.id)}/undo`);
      report(r, 'Undone');
      forgetChannelData(ch.id);
      drawAll();
    }) }, 'Undo last change');

    if (!preview) {
      clear(readyCard, h('h3', null, 'Ready to apply'),
        h('p', { class: 'dim' }, 'No preview for this channel yet.'),
        h('div', { class: 'btn-row' },
          h('button', { class: 'btn primary', onclick: () => go('preview', { channel: ch.id, run: ch.setup.sortId ? '1' : '0' }) }, 'Make a preview'),
          undoBtn));
      return;
    }

    const data = await loadChannelData(ch.id).catch(() => null);
    const align = h('input', { type: 'checkbox', checked: ch.setup.alignStart });
    const staleMs = Date.now() - preview.scheduleStartMs;
    const applyBtn = h('button', { class: 'btn danger' }, 'Apply to channel');
    applyBtn.onclick = () => busy(applyBtn, async () => {
      const lines = [
        `Replace the lineup on ${ch.number} ${ch.name}` + (data ? ` (${data.current.length} items, ${fmtDur(data.totalDurationMs)})` : '') + ` with:`,
        `  ${preview.label}: ${preview.items.length} items, ${fmtDur(preview.durationMs)}, starting ${fmtWhen(preview.scheduleStartMs)}.`,
        '',
        'The current lineup is backed up first, so you can undo this.',
      ];
      if (data && preview.durationMs < data.totalDurationMs * 0.5) {
        lines.push('', `Note: the new lineup is much shorter than the current one. Tunarr repeats it every ${fmtDur(preview.durationMs)}.`);
      }
      if (data?.scheduleType) lines.push('', `This replaces the lineup Tunarr generated from its "${data.scheduleType}" slot schedule with a fixed one.`);
      if (align.checked && staleMs > 60 * 60_000) lines.push('', `The preview starts ${fmtDur(staleMs)} ago, so the channel will pick up partway through it.`);
      if (!(await confirmDialog({ title: 'Apply to channel', message: lines.join('\n'), confirmLabel: 'Apply', danger: true }))) return;
      const r = await api('POST', `/api/channels/${encodeURIComponent(ch.id)}/apply`, { previewId: preview.previewId, alignStart: align.checked });
      report(r, 'Applied');
      store.lastPreview.delete(ch.id);
      forgetChannelData(ch.id);
      drawAll();
    });

    clear(readyCard,
      h('h3', null, 'Ready to apply'),
      h('div', { class: 'stat' }, h('span', null, 'Preview'), h('span', { class: 'v' }, preview.label)),
      h('div', { class: 'stat' }, h('span', null, 'New lineup'), h('span', { class: 'v' }, `${preview.items.length} items · ${fmtDur(preview.durationMs)}`)),
      h('div', { class: 'stat' }, h('span', null, 'Starts'), h('span', { class: 'v' }, fmtWhen(preview.scheduleStartMs))),
      data ? h('div', { class: 'stat' }, h('span', null, 'Current lineup'), h('span', { class: 'v' }, `${data.current.length} items · ${fmtDur(data.totalDurationMs)}`)) : null,
      h('div', { class: 'stat' }, h('span', null, 'Previewed'), h('span', { class: 'v' }, fmtAgo(preview.createdAt))),
      h('label', { class: 'check', style: { marginTop: '12px' } }, align, 'Start the lineup at the preview\'s start time'),
      h('div', { class: 'btn-row' },
        applyBtn,
        h('button', { class: 'btn ghost', onclick: () => go('preview', { channel: ch.id }) }, 'Back to preview'),
        undoBtn));
  }

  function report(r, verb) {
    toast(`${verb}: ${r.itemCount} items, ${fmtDur(r.durationMs)}. Backup #${r.backupId} saved first.`, 'ok', 7000);
    for (const w of r.warnings || []) toast(w, 'warn', 12000);
    // Check the guide once Tunarr has had a moment.
    setTimeout(() => runGuideCheck(), 3000);
  }

  // ---------- guide check ----------
  const guideResults = new Map(); // channelId -> result (kept while the screen is open)
  async function runGuideCheck(button) {
    const id = store.selectedChannelId;
    if (!id) return;
    const run = async () => {
      drawGuide(true);
      try { guideResults.set(id, await api('GET', `/api/channels/${encodeURIComponent(id)}/guide-check?hours=6`)); }
      catch (err) { guideResults.set(id, { verdict: 'error', message: err.message }); }
      drawGuide();
    };
    return button ? busy(button, run) : run();
  }
  function drawGuide(checking = false) {
    const id = store.selectedChannelId;
    if (!id) { clear(guideCard); return; }
    const r = guideResults.get(id);
    const btn = h('button', { class: 'btn small' }, 'Check guide');
    btn.onclick = () => runGuideCheck(btn);
    const pill = !r ? null
      : h('span', { class: `pill ${r.verdict === 'ok' ? 'ok' : r.verdict === 'guide-behind' ? 'warn' : r.verdict === 'no-data' ? '' : 'err'}` },
          { ok: 'guide matches', 'guide-behind': 'guide not updated yet', mismatch: 'schedule differs', 'no-data': 'nothing to compare', error: 'check failed' }[r.verdict] || r.verdict);
    clear(guideCard,
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

  async function drawBackups() {
    const ch = findChannel(store.selectedChannelId);
    if (!ch) { clear(backupsBox, h('p', { class: 'dim small' }, 'Pick a channel.')); return; }
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
            const r = await api('POST', `/api/backups/${b.id}/restore`);
            report(r, 'Restored');
            forgetChannelData(ch.id);
            drawAll();
          }) }, 'Restore'),
          h('button', { class: 'btn small ghost', onclick: async () => {
            try { download(`backup-${slug(ch.name)}-${b.id}.json`, await api('GET', `/api/backups/${b.id}`)); } catch (err) { toast(err.message, 'err'); }
          } }, 'Download'))))))));
  }

  async function drawHistory() {
    const id = allHistory.checked ? '' : store.selectedChannelId;
    if (!id && !allHistory.checked) { clear(historyBox, h('p', { class: 'dim small' }, 'Pick a channel, or tick "All channels".')); return; }
    const rows = await api('GET', `/api/history${id ? `?channelId=${encodeURIComponent(id)}` : ''}`);
    if (!rows.length) { clear(historyBox, h('p', { class: 'dim small' }, 'Nothing applied yet.')); return; }
    clear(historyBox, h('div', { class: 'table-wrap' }, h('table', { class: 'grid' },
      h('thead', null, h('tr', null, ['When', allHistory.checked ? 'Channel' : null, 'What', 'Lineup', 'Result'].filter(Boolean).map(t => h('th', null, t)))),
      h('tbody', null, rows.map(r => h('tr', null,
        h('td', { class: 'small' }, new Date(r.createdAt).toLocaleString()),
        allHistory.checked ? h('td', { class: 'small' }, r.channelName) : null,
        h('td', { class: 'small' }, h('b', null, r.action), ' ', r.detail),
        h('td', { class: 'small mono' }, r.itemCount != null ? `${r.itemCount} · ${fmtDur(r.durationMs)}` : ''),
        h('td', { class: 'small' }, r.ok ? h('span', { class: 'ok-text' }, 'OK') : h('span', { class: 'err-text' }, 'Failed'),
          r.message ? h('div', { class: r.ok ? 'warn-text' : 'err-text', style: { whiteSpace: 'pre-wrap', maxWidth: '420px' } }, r.message) : null)))))));
  }

  function drawAll() {
    drawGuide();
    drawReady().catch(err => toast(err.message, 'err'));
    drawBackups().catch(err => clear(backupsBox, h('p', { class: 'err-text small' }, err.message)));
    drawHistory().catch(err => clear(historyBox, h('p', { class: 'err-text small' }, err.message)));
  }
  drawAll();
}
