// Small DOM and formatting helpers shared by every screen.

/**
 * h('div', { class: 'x', onclick: fn }, child, [children], 'text')
 * Attributes starting with "on" become listeners; `style` may be an object;
 * `html` sets innerHTML (only for trusted markup); false/null children are skipped.
 */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected' || k === 'hidden') el[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export function clear(el, ...children) {
  el.replaceChildren();
  append(el, children);
  return el;
}

export function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ---------- API ----------
export async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  const text = await res.text();
  if (text) { try { data = JSON.parse(text); } catch { data = text; } }
  if (!res.ok) throw new Error((data && data.error) || `${method} ${path} failed (${res.status})`);
  return data;
}

// ---------- formatting ----------
export function fmtDur(ms) {
  if (!ms || isNaN(ms)) return '0m';
  const totalMin = Math.round(ms / 60000);
  const d = Math.floor(totalMin / 1440), h = Math.floor((totalMin % 1440) / 60), m = totalMin % 60;
  if (d) return `${d}d${h ? ` ${h}h` : ''}`;
  return h ? `${h}h${m ? m + 'm' : ''}` : `${m}m`;
}
export function fmtWhen(ms) {
  return new Date(ms).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}
export function fmtAgo(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return fmtWhen(ms);
}
/** Value for <input type="datetime-local"> in local time. */
export function toLocalInput(ms) {
  const d = new Date(ms);
  return new Date(ms - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
export function fromLocalInput(value) {
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? t : Date.now();
}
/** Now, rounded down to the minute. */
export function nowMinute() {
  return Math.floor(Date.now() / 60000) * 60000;
}

// ---------- toasts ----------
export function toast(message, kind = '', ms = 5000) {
  const el = h('div', { class: `toast ${kind}` }, message);
  document.getElementById('toasts').append(el);
  setTimeout(() => el.remove(), kind === 'err' ? Math.max(ms, 9000) : ms);
  el.addEventListener('click', () => el.remove());
}

// ---------- modal dialogs ----------
export function modal({ title, body, actions = [], wide = false, onClose }) {
  const root = document.getElementById('modal');
  const close = () => { root.classList.remove('open'); root.replaceChildren(); onClose?.(); document.removeEventListener('keydown', onKey); };
  const onKey = e => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  const buttons = actions.map(a => h('button', {
    class: `btn ${a.kind || ''}`,
    onclick: async () => { if ((await a.onClick?.()) !== false) close(); },
  }, a.label));
  clear(root, h('div', { class: `modal ${wide ? 'wide' : ''}`, onclick: e => e.stopPropagation() },
    h('div', { class: 'modal-head' }, h('span', null, title), h('button', { class: 'btn small ghost', onclick: close }, 'Close')),
    h('div', { class: 'modal-body' }, body),
    buttons.length ? h('div', { class: 'modal-foot' }, buttons) : null,
  ));
  root.onclick = close;
  root.classList.add('open');
  return close;
}

export function confirmDialog({ title, message, confirmLabel = 'OK', danger = false }) {
  return new Promise(resolve => {
    let answered = false;
    modal({
      title,
      body: typeof message === 'string' ? h('div', { style: { whiteSpace: 'pre-wrap' } }, message) : message,
      actions: [
        { label: 'Cancel', kind: 'ghost', onClick: () => { answered = true; resolve(false); } },
        { label: confirmLabel, kind: danger ? 'danger' : 'primary', onClick: () => { answered = true; resolve(true); } },
      ],
      onClose: () => { if (!answered) resolve(false); },
    });
  });
}

export function promptDialog({ title, label, value = '', confirmLabel = 'Save' }) {
  return new Promise(resolve => {
    let answered = false;
    const input = h('input', { type: 'text', value });
    const close = modal({
      title,
      body: h('label', { class: 'field' }, h('span', { class: 'lab' }, label), input),
      actions: [
        { label: 'Cancel', kind: 'ghost', onClick: () => { answered = true; resolve(null); } },
        { label: confirmLabel, kind: 'primary', onClick: () => { answered = true; resolve(input.value); } },
      ],
      onClose: () => { if (!answered) resolve(null); },
    });
    input.addEventListener('keydown', e => { if (e.key === 'Enter') { answered = true; resolve(input.value); close(); } });
    setTimeout(() => input.select(), 0);
  });
}

export function download(filename, data) {
  const blob = new Blob([typeof data === 'string' ? data : JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function pickJsonFile() {
  return new Promise(resolve => {
    const input = h('input', { type: 'file', accept: 'application/json,.json', hidden: true });
    input.addEventListener('change', async () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) return resolve(null);
      try { resolve(JSON.parse(await file.text())); } catch (err) { toast(`Could not read ${file.name}: ${err.message}`, 'err'); resolve(null); }
    });
    document.body.append(input);
    input.click();
  });
}

/** Wraps a button action: disables it and shows a spinner while running, reports errors. */
export async function busy(button, fn) {
  const label = button?.innerHTML;
  if (button) { button.disabled = true; button.innerHTML = `<span class="spinner"></span> ${label}`; }
  try {
    return await fn();
  } catch (err) {
    toast(err.message || String(err), 'err');
    return undefined;
  } finally {
    if (button) { button.disabled = false; button.innerHTML = label; }
  }
}

export function slug(s) {
  return String(s || 'file').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'file';
}
