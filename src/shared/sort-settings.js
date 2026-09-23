// Sort settings: declared in a comment block at the top of a sort's code.
//
//   /* @settings
//   repeatWindowHours: number = 72        // Repeat window (hours)
//   order: choice(as-listed, shuffle) = shuffle
//   workHours: weekly hours = Mon-Fri 08:00-16:30   // Work hours
//   apiKey: secret =                      // Anthropic API key
//   */
//
// One setting per line: `key: type = default   // Label`. The label is
// optional and must follow " // " (space before the slashes, so URLs in a
// default survive). Types:
//   number, text, secret (text shown as a password field), yes/no,
//   choice(a, b, c), weekly hours, filler list
//
// Shared by the server and the browser; no imports.

export const SETTING_TYPES = ['number', 'text', 'secret', 'yes/no', 'choice', 'weekly hours', 'filler list'];

const BLOCK_RE = /\/\*\s*@settings\b([\s\S]*?)\*\//;
const LINE_RE = /^([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z/ ]+?)(?:\(([^)]*)\))?\s*(?:=\s*(.*))?$/;

function splitLabel(line) {
  const i = line.search(/\s\/\/\s?/);
  if (i < 0) return [line.trim(), ''];
  return [line.slice(0, i).trim(), line.slice(i).replace(/^\s*\/\/\s?/, '').trim()];
}

/** Returns { settings: [{ key, type, options, default, label }], errors, hasBlock }. */
export function parseSettings(code) {
  const settings = [];
  const errors = [];
  const m = BLOCK_RE.exec(String(code || ''));
  if (!m) return { settings, errors, hasBlock: false };
  const seen = new Set();
  for (const rawLine of m[1].split('\n')) {
    const trimmed = rawLine.replace(/^\s*\*?\s?/, '').trim();
    if (!trimmed || trimmed.startsWith('//')) continue;
    const [body, label] = splitLabel(trimmed);
    const lm = LINE_RE.exec(body);
    if (!lm) { errors.push(`Can't read setting line: "${trimmed}"`); continue; }
    const key = lm[1];
    const type = lm[2].trim().toLowerCase().replace(/\s+/g, ' ');
    if (!SETTING_TYPES.includes(type)) { errors.push(`"${key}": unknown type "${type}". Use one of: ${SETTING_TYPES.join(', ')}`); continue; }
    if (seen.has(key)) { errors.push(`"${key}" is declared twice`); continue; }
    seen.add(key);
    const options = type === 'choice' ? String(lm[3] || '').split(',').map(s => s.trim()).filter(Boolean) : undefined;
    if (type === 'choice' && !options.length) { errors.push(`"${key}": choice needs options, like choice(a, b)`); continue; }
    let def = coerce({ type, options }, lm[4] === undefined ? '' : lm[4].trim());
    if (type === 'choice' && !options.includes(def)) def = options[0];
    settings.push({ key, type, options, default: def, label: label || key });
  }
  return { settings, errors, hasBlock: true };
}

/** Converts a stored or typed value to what the sort receives in ctx.params. */
export function coerce(setting, raw) {
  switch (setting.type) {
    case 'number': {
      if (raw === '' || raw === null || raw === undefined) return 0;
      const n = Number(raw);
      return Number.isFinite(n) ? n : 0;
    }
    case 'yes/no':
      if (typeof raw === 'boolean') return raw;
      return /^(yes|y|true|1|on)$/i.test(String(raw ?? '').trim());
    default:
      return raw === null || raw === undefined ? '' : String(raw);
  }
}

// ---------- global variables ----------
// Named values shared by every sort (ctx.globals) that a channel's setting
// can also be linked to. A linked setting is stored as { $global: "name" }.

export const GLOBAL_TYPES = ['number', 'text', 'secret', 'yes/no', 'weekly hours', 'filler list'];
export const GLOBAL_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function isLink(v) {
  return !!v && typeof v === 'object' && typeof v.$global === 'string';
}

/** Whether a setting of this type can take its value from a global of that type. */
export function canLink(settingType, globalType) {
  if (settingType === globalType) return true;
  const textual = ['text', 'secret'];
  return (textual.includes(settingType) || settingType === 'choice') && textual.includes(globalType);
}

/**
 * The values a channel runs with: its stored values for declared keys, else
 * defaults. `globals` maps name -> { type, value }; linked settings take the
 * global's value (or the default if that global is gone).
 * @returns {Record<string, any>}
 */
export function resolveValues(settings, stored, globals) {
  /** @type {Record<string, any>} */
  const out = {};
  for (const s of settings) {
    const has = stored && Object.prototype.hasOwnProperty.call(stored, s.key);
    let raw = has ? stored[s.key] : undefined;
    if (isLink(raw)) {
      const g = globals && globals[raw.$global];
      raw = g && canLink(s.type, g.type) ? g.value : undefined;
    }
    let v = raw === undefined ? s.default : coerce(s, raw);
    if (s.type === 'choice' && !s.options.includes(v)) v = s.default;
    out[s.key] = v;
  }
  return out;
}

/** Adds a setting line to the code's @settings block, creating the block if needed. */
export function addSettingLine(code, line) {
  const src = String(code || '');
  const m = BLOCK_RE.exec(src);
  if (!m) return `/* @settings\n${line}\n*/\n${src}`;
  const end = m.index + m[0].length - 2; // just before the closing */
  const before = src.slice(0, end).replace(/[ \t]*$/, '');
  return `${before}${before.endsWith('\n') ? '' : '\n'}${line}\n${src.slice(end)}`;
}

/** Formats a declaration line, e.g. for the Sort Builder's "Add setting" form. */
export function formatSettingLine({ key, type, options, default: def, label }) {
  const t = type === 'choice' ? `choice(${(options || []).join(', ')})` : type;
  const d = def === undefined || def === null ? '' : (typeof def === 'boolean' ? (def ? 'yes' : 'no') : String(def));
  const lbl = label && label !== key ? `   // ${label}` : '';
  return `${key}: ${t} = ${d}${lbl}`.replace(/ = $/, ' =');
}
