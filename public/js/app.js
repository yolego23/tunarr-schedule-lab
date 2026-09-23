// App shell: navigation between the tools, Tunarr connection status, and
// export/import of all Schedule Lab data.
import { api, clear, confirmDialog, download, h, pickJsonFile, toast } from './ui.js';
import { flushAll, forgetInAppUnsaved, loadChannels, loadSorts, store, unsavedMessages } from './store.js';

const SCREENS = [
  { path: 'channels', label: 'Channels', load: () => import('./views/channels.js') },
  { path: 'builder', label: 'Sort Builder', load: () => import('./views/builder.js') },
  { path: 'library', label: 'Sort Library', load: () => import('./views/library.js') },
  { path: 'preview', label: 'Preview & Compare', load: () => import('./views/preview.js') },
  { path: 'apply', label: 'Apply & History', load: () => import('./views/apply.js') },
  { path: 'watch', label: 'Watch Tracker', load: () => import('./views/watch.js') },
  { path: 'automations', label: 'Automations', later: '2.1', load: () => import('./views/later.js') },
  { path: 'settings', label: 'Settings', load: () => import('./views/settings.js') },
];

const main = document.getElementById('main');
const nav = document.getElementById('nav');
let cleanup = null;
let renderSeq = 0;

export function go(path, params) {
  const q = params ? '?' + new URLSearchParams(params).toString() : '';
  location.hash = `#/${path}${q}`;
}

function parseHash() {
  const raw = location.hash.replace(/^#\/?/, '');
  const [path, query] = raw.split('?');
  return { path: path || 'channels', params: new URLSearchParams(query || '') };
}

// Leaving a screen with unsaved changes asks first; saying no stays put.
let currentHash = location.hash;
let revertingHash = false;
async function onHashChange() {
  if (revertingHash) { revertingHash = false; return; }
  const lost = unsavedMessages({ inAppOnly: true });
  if (lost.length) {
    const target = location.hash;
    revertingHash = true;
    location.hash = currentHash; // stay here while asking
    const leave = await confirmDialog({
      title: 'Unsaved changes',
      message: `${lost.join('\n')}\n\nLeave this screen and lose them?`,
      confirmLabel: 'Leave without saving',
      danger: true,
    });
    if (!leave) return;
    forgetInAppUnsaved();
    revertingHash = false;
    location.hash = target;
    return;
  }
  currentHash = location.hash;
  route();
}

window.addEventListener('beforeunload', e => {
  flushAll({ unloading: true });
  if (unsavedMessages().length) { e.preventDefault(); e.returnValue = ''; }
});

async function route() {
  flushAll();
  const { path, params } = parseHash();
  const screen = SCREENS.find(s => s.path === path) || SCREENS[0];
  for (const a of nav.children) a.classList.toggle('active', a.dataset.path === screen.path);
  document.title = `${screen.label} · Schedule Lab`;
  const seq = ++renderSeq;
  try { cleanup?.(); } catch { /* ignore */ }
  cleanup = null;
  const mod = await screen.load();
  if (seq !== renderSeq) return;
  clear(main);
  try {
    cleanup = (await mod.render(main, { params, screen, go })) || null;
  } catch (err) {
    console.error(err);
    clear(main, h('div', { class: 'scroll-page' }, h('div', { class: 'empty' }, h('b', null, 'This screen hit an error'), err.message)));
  }
}

function buildNav() {
  for (const s of SCREENS) {
    nav.append(h('a', { href: `#/${s.path}`, class: s.later ? 'later' : '', title: s.later ? `Coming in ${s.later}` : '' },
      s.label, s.later ? h('span', { class: 'soon' }, s.later) : null));
    nav.lastChild.dataset.path = s.path;
  }
}

async function checkStatus() {
  const dot = document.getElementById('connDot');
  const text = document.getElementById('connText');
  const banner = document.getElementById('banner');
  try {
    const s = await api('GET', '/api/status');
    store.status = s;
    if (s.connected) {
      dot.className = 'dot live';
      text.textContent = `Tunarr ${s.version}`;
      text.className = s.warning ? 'pill warn' : 'pill ok';
      text.title = `${s.tunarrUrl} · server time zone ${s.timeZone}`;
    } else {
      dot.className = 'dot err';
      text.textContent = 'Tunarr offline';
      text.className = 'pill err';
      text.title = s.error || '';
    }
    const storageWarning = s.storage?.warning;
    const msg = storageWarning || (s.connected ? s.warning : `Can't reach Tunarr. ${s.error || ''}`);
    banner.hidden = !msg;
    banner.className = `banner${storageWarning || !s.connected ? ' err' : ''}`;
    banner.textContent = msg || '';
  } catch (err) {
    dot.className = 'dot err';
    text.textContent = 'Server offline';
    text.className = 'pill err';
  }
}

document.getElementById('btnExport').onclick = async () => {
  const withBackups = await confirmDialog({
    title: 'Export all data',
    message: 'Exports your sort library (every version), channel setup and apply history as one JSON file.\n\nInclude lineup backups too? They can make the file large.',
    confirmLabel: 'Include backups',
  });
  try {
    const data = await api('GET', `/api/export${withBackups ? '?backups=1' : ''}`);
    download(`schedule-lab-export-${new Date().toISOString().slice(0, 10)}.json`, data);
  } catch (err) { toast(err.message, 'err'); }
};

document.getElementById('btnImport').onclick = async () => {
  const data = await pickJsonFile();
  if (!data) return;
  if (data.kind !== 'schedule-lab-export') {
    toast('That file is not a Schedule Lab export. (To add a single sort, use Import on the Sort Library screen.)', 'err');
    return;
  }
  const ok = await confirmDialog({
    title: 'Import data',
    message: `This replaces the sort library, channel setup and history here with the file's contents (exported ${new Date(data.exportedAt).toLocaleString()}).${data.backups ? ' Backups in the file replace the backups here.' : ' Backups here are kept.'}\n\nTunarr itself is not changed.`,
    confirmLabel: 'Replace my data',
    danger: true,
  });
  if (!ok) return;
  try {
    await api('POST', '/api/import', data);
    toast('Import finished.', 'ok');
    store.sorts = null; store.channels = null; store.settings = null; store.globals = null;
    await Promise.all([loadSorts(true), loadChannels(true).catch(() => null)]);
    route();
  } catch (err) { toast(err.message, 'err'); }
};

buildNav();
window.addEventListener('hashchange', onHashChange);
checkStatus();
setInterval(checkStatus, 60_000);
route();
