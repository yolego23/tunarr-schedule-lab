// State shared between screens. Everything durable lives on the server; this
// is only a cache so switching screens is instant.
import { api } from './ui.js';

const listeners = new Set();

export const store = {
  status: null,
  channels: null,        // Tunarr channels with their setup
  sorts: null,           // library
  settings: null,        // global settings (see src/app-settings.ts)
  globals: null,         // global variables
  fillerLists: null,
  channelData: new Map(), // channelId -> { pool, current, ... , byId }
  /** Last preview per channel, so Apply & History can pick it up. */
  lastPreview: new Map(), // channelId -> { previewId, label, items, durationMs, scheduleStartMs, createdAt }
  /** Screen selections that should survive switching screens. */
  selectedChannelId: localStorage.getItem('lab.channel') || '',
};

// ---------- unsaved changes ----------
// Screens register what would be lost. `inApp: false` means it survives
// switching screens (kept in memory) and is only lost on a page reload.
const unsaved = new Map(); // key -> { message, inApp }
const flushers = new Set();

export function setUnsaved(key, message, { inApp = true } = {}) {
  if (message) unsaved.set(key, { message, inApp }); else unsaved.delete(key);
}
export function unsavedMessages({ inAppOnly = false } = {}) {
  return [...unsaved.values()].filter(u => !inAppOnly || u.inApp).map(u => u.message);
}
export function forgetInAppUnsaved() {
  for (const [k, u] of unsaved) if (u.inApp) unsaved.delete(k);
}
/** Functions that push pending saves out right away (on leaving a screen or the page). */
export function addFlusher(fn) {
  flushers.add(fn);
  return () => flushers.delete(fn);
}
export function flushAll({ unloading = false } = {}) {
  for (const fn of flushers) { try { fn({ unloading }); } catch { /* best effort */ } }
}

export function onStoreChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
function emit(what) {
  for (const fn of listeners) fn(what);
}

export function selectChannel(id) {
  store.selectedChannelId = id || '';
  try { localStorage.setItem('lab.channel', store.selectedChannelId); } catch { /* private mode */ }
}

export async function loadChannels(force = false) {
  if (store.channels && !force) return store.channels;
  store.channels = await api('GET', '/api/channels');
  emit('channels');
  return store.channels;
}

export async function loadSorts(force = false) {
  if (store.sorts && !force) return store.sorts;
  store.sorts = await api('GET', '/api/sorts');
  emit('sorts');
  return store.sorts;
}

export async function loadSettings(force = false) {
  if (!store.settings || force) store.settings = await api('GET', '/api/settings');
  return store.settings;
}

/** Global variables: [{ name, type, value, description, usedBy }]. */
export async function loadGlobals(force = false) {
  if (!store.globals || force) store.globals = await api('GET', '/api/globals');
  return store.globals;
}

/** name -> { type, value }, the shape resolveValues() takes. */
export function globalsMap() {
  return Object.fromEntries((store.globals || []).map(g => [g.name, { type: g.type, value: g.value }]));
}

export async function loadFillerLists() {
  if (!store.fillerLists) {
    try { store.fillerLists = await api('GET', '/api/filler-lists'); } catch { store.fillerLists = []; }
  }
  return store.fillerLists;
}

/** A channel's pool and current lineup (or the sample data when id is "sample"). */
export async function loadChannelData(channelId, fresh = false) {
  const cached = store.channelData.get(channelId);
  if (cached && !fresh && Date.now() - cached.loadedAt < 120_000) return cached;
  const d = await api('GET', `/api/channels/${encodeURIComponent(channelId)}/data${fresh ? '?fresh=1' : ''}`);
  d.byId = new Map(d.pool.map(p => [p.id, p]));
  d.loadedAt = Date.now();
  store.channelData.set(channelId, d);
  return d;
}

export function forgetChannelData(channelId) {
  store.channelData.delete(channelId);
}

export function channelLabel(c) {
  if (!c) return '';
  return `${c.number} · ${c.name}`;
}

export function findChannel(id) {
  return (store.channels || []).find(c => c.id === id) || null;
}

export function findSort(id) {
  return (store.sorts || []).find(s => s.id === Number(id)) || null;
}

/** Turns a sort's output items into display items using the channel's pool. */
export function expandItems(data, items) {
  return items.map(it => {
    if (it.id !== undefined) return data.byId.get(it.id) || { id: it.id, title: '(unknown episode)', showTitle: '—', durationMs: 0 };
    if (it.ci !== undefined) {
      const c = data.current[it.ci] || { type: 'flex', durationMs: 0 };
      return c.id && data.byId.has(c.id) ? data.byId.get(c.id) : { ...c, title: `(${c.type})`, showTitle: `(${c.type})` };
    }
    return { type: 'flex', durationMs: it.durationMs, title: 'Flex (filler)', showTitle: '' };
  });
}

/** The channel's current lineup as display items. */
export function currentItems(data) {
  return data.current.map(c => (c.id && data.byId.has(c.id)) ? data.byId.get(c.id) : { ...c, title: `(${c.type})`, showTitle: `(${c.type})` });
}
