// Watch Tracker: what's being watched now, and the log of counted watches
// that sorts read through ctx.history.
import { api, busy, clear, confirmDialog, fmtAgo, fmtDur, h, toast } from '../ui.js';
import { channelLabel, loadChannels, loadSettings, store } from '../store.js';

export async function render(root, { go }) {
  await Promise.all([loadChannels().catch(() => null), loadSettings(true)]);
  const statusCard = h('div', { class: 'card' });
  const logCard = h('div', { class: 'card' });
  const filter = h('select', null, h('option', { value: '' }, 'All channels'),
    (store.channels || []).map(c => h('option', { value: c.id }, channelLabel(c))));
  clear(root, h('div', { class: 'scroll-page' }, h('div', { class: 'page-width' },
    h('h2', null, 'Watch Tracker'),
    h('p', { class: 'dim' },
      'Checks Tunarr every minute for open streams. An episode that streams for ',
      h('b', null, `${store.settings.watchTracker.minMinutes} minutes`),
      ' counts as watched on that channel. Sorts read this through ', h('code', null, 'ctx.history'),
      '. Tunarr keeps no viewing history of its own, so this starts from when the tracker was switched on.'),
    statusCard,
    logCard)));

  // ---------- status (refreshes every 20 s while this screen is open) ----------
  async function drawStatus() {
    let s;
    try { s = await api('GET', '/api/watch/status'); } catch (err) {
      clear(statusCard, h('p', { class: 'err-text small' }, err.message));
      return;
    }
    const cfg = store.settings.watchTracker;
    clear(statusCard,
      h('div', { class: 'card-head' },
        h('h3', null, 'Now'),
        h('div', { class: 'btn-row' },
          h('span', { class: `pill ${s.enabled ? 'ok' : 'warn'}` }, s.enabled ? 'Tracking' : 'Off'),
          h('button', { class: 'btn small ghost', onclick: () => go('settings') }, 'Tracker settings'))),
      h('div', { class: 'stat' }, h('span', null, 'Last check'), h('span', { class: 'v' }, s.lastPollAt ? fmtAgo(s.lastPollAt) : 'not yet')),
      s.lastError ? h('p', { class: 'err-text small' }, s.lastError) : null,
      h('div', { class: 'stat' }, h('span', null, 'Kept'), h('span', { class: 'v' },
        `${s.events} watch${s.events === 1 ? '' : 'es'} of ${s.episodes} episode${s.episodes === 1 ? '' : 's'}${s.since ? ` since ${new Date(s.since).toLocaleDateString()}` : ''} · up to ${cfg.keepPerEpisode} per episode per channel`
        + (cfg.maxAgeDays ? ` · forgotten after ${cfg.maxAgeDays} days` : ''))),
      h('h3', null, `Streaming now (${s.watching.length})`),
      !s.enabled ? h('p', { class: 'dim small' }, 'The tracker is off. Turn it on in Settings.')
        : s.watching.length
          ? h('table', { class: 'grid' },
              h('thead', null, h('tr', null, ['Channel', 'Episode', 'Streamed', ''].map(t => h('th', null, t)))),
              h('tbody', null, s.watching.map(w => h('tr', null,
                h('td', null, w.channelName),
                h('td', null, h('span', { class: 'dim' }, w.showTitle), ' ', w.episodeLabel ? `${w.episodeLabel} · ` : '', w.title),
                h('td', { class: 'mono' }, `${w.minutes} min`),
                h('td', null, w.counted
                  ? h('span', { class: 'pill ok' }, 'counted as watched')
                  : h('span', { class: 'pill' }, `counts at ${cfg.minMinutes} min`))))))
          : h('p', { class: 'dim small' }, 'Nothing is streaming.'));
  }

  // ---------- log ----------
  let rows = [];
  let more = false;
  async function loadLog(reset) {
    const before = !reset && rows.length ? rows[rows.length - 1].watchedAt : undefined;
    const q = new URLSearchParams({ limit: '100' });
    if (filter.value) q.set('channelId', filter.value);
    if (before) q.set('before', String(before));
    const page = await api('GET', `/api/watch?${q}`);
    rows = reset ? page : rows.concat(page);
    more = page.length === 100;
    drawLog();
  }
  filter.onchange = () => loadLog(true).catch(err => toast(err.message, 'err'));

  function drawLog() {
    const clearBtn = h('button', { class: 'btn small ghost', disabled: !rows.length }, filter.value ? 'Clear this channel\'s history' : 'Clear all history');
    clearBtn.onclick = () => busy(clearBtn, async () => {
      const which = filter.value ? `for ${filter.selectedOptions[0].textContent}` : 'for every channel';
      if (!(await confirmDialog({
        title: 'Clear watch history',
        message: `Delete all recorded watches ${which}, including the watch counts? Sorts will treat those episodes as never watched. This can't be undone.`,
        confirmLabel: 'Delete history', danger: true,
      }))) return;
      const r = await api('DELETE', `/api/watch${filter.value ? `?channelId=${encodeURIComponent(filter.value)}` : ''}`);
      toast(`Deleted ${r.deleted} watch${r.deleted === 1 ? '' : 'es'}.`, 'ok');
      await loadLog(true);
      drawStatus();
    });
    clear(logCard,
      h('div', { class: 'card-head' },
        h('h3', null, 'Watched'),
        h('div', { class: 'btn-row' }, h('div', { style: { minWidth: '220px' } }, filter), clearBtn)),
      rows.length
        ? h('div', { class: 'table-wrap' }, h('table', { class: 'grid' },
            h('thead', null, h('tr', null, ['When', 'Channel', 'Episode', 'Watched', ''].map(t => h('th', null, t)))),
            h('tbody', null, rows.map(r => h('tr', null,
              h('td', { class: 'small', style: { whiteSpace: 'nowrap' } }, new Date(r.watchedAt).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })),
              h('td', { class: 'small' }, r.channelName || r.channelId),
              h('td', null, h('span', { class: 'dim' }, r.showTitle), ' ', r.episodeLabel ? `${r.episodeLabel} · ` : '', r.title),
              h('td', { class: 'mono small' }, `${r.minutes} min${r.durationMs ? ` of ${fmtDur(r.durationMs)}` : ''}`),
              h('td', { class: 'actions' }, h('button', { class: 'btn small ghost', title: 'Delete this watch', onclick: async () => {
                try {
                  await api('DELETE', `/api/watch/${r.id}`);
                  rows = rows.filter(x => x.id !== r.id);
                  drawLog();
                  drawStatus();
                } catch (err) { toast(err.message, 'err'); }
              } }, 'Delete')))))))
        : h('p', { class: 'dim small' }, 'No watches recorded yet.'),
      more ? h('div', { class: 'tl-more' }, h('button', { class: 'btn small', onclick: () => loadLog(false).catch(err => toast(err.message, 'err')) }, 'Show older')) : null);
  }

  await Promise.all([drawStatus(), loadLog(true).catch(err => clear(logCard, h('p', { class: 'err-text small' }, err.message)))]);
  const timer = setInterval(() => {
    drawStatus();
    // Pick up new watches, unless older pages are open (that would jump back to the top).
    if (rows.length <= 100) loadLog(true).catch(() => null);
  }, 20_000);
  return () => clearInterval(timer);
}
