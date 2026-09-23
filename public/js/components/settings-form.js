// Turns a sort's declared settings into form fields. Any field can instead be
// linked to a global variable of a compatible type.
import { h } from '../ui.js';
import { weekGrid } from './week-grid.js';
import { canLink, coerce, isLink, resolveValues } from '/shared/sort-settings.js';
import { loadFillerLists } from '../store.js';

/**
 * settingsForm({ settings, values, onChange, globals }) -> element.
 * `values` are stored values (may be partial, may hold { $global } links).
 * onChange gets the full stored form: own values plus links.
 * `globals` is the list from /api/globals; omit it to hide linking.
 */
export function settingsForm({ settings, values, onChange, globals = [] }) {
  const stored = values || {};
  const own = resolveValues(settings, Object.fromEntries(Object.entries(stored).filter(([, v]) => !isLink(v))));
  const links = {};
  for (const s of settings) if (isLink(stored[s.key])) links[s.key] = stored[s.key].$global;
  const emit = () => onChange(Object.fromEntries(settings.map(s => [s.key, links[s.key] ? { $global: links[s.key] } : own[s.key]])));

  if (!settings.length) return h('p', { class: 'dim small' }, 'This sort declares no settings.');

  const renderField = s => {
    let fieldEl; // this field's element, replaced when the link changes
    const compatible = globals.filter(g => canLink(s.type, g.type));
    const linkedName = links[s.key];
    const linkSelect = compatible.length || linkedName ? h('select', {
      class: 'link-select',
      title: 'Use this channel\'s own value, or take it from a global variable',
      onchange: e => {
        if (e.target.value) links[s.key] = e.target.value; else delete links[s.key];
        fieldEl.replaceWith(renderField(s));
        emit();
      },
    },
      h('option', { value: '' }, 'own value'),
      compatible.map(g => h('option', { value: g.name, selected: g.name === linkedName }, `global: ${g.name}`)),
      linkedName && !compatible.some(g => g.name === linkedName) ? h('option', { value: linkedName, selected: true }, `global: ${linkedName} (missing)`) : null,
    ) : null;
    const labelRow = h('span', { class: 'lab label-row' }, h('span', { title: s.key }, s.label), linkSelect);
    const wide = s.type === 'weekly hours' || (s.type === 'text' && String(own[s.key]).length > 40);

    if (linkedName) {
      const g = globals.find(x => x.name === linkedName);
      const shown = !g ? 'That variable no longer exists, so the sort\'s default is used.'
        : g.type === 'secret' ? (g.value ? '••••••••' : '(empty)')
        : g.type === 'yes/no' ? (coerce({ type: 'yes/no' }, g.value) ? 'yes' : 'no')
        : String(g.value ?? '') || '(empty)';
      return fieldEl = h('div', { class: `field${wide ? ' wide' : ''}` }, labelRow,
        h('div', { class: `linked${g ? '' : ' missing'}` }, shown),
        h('span', { class: 'hint' }, g ? 'Edit it on the Settings screen; every linked setting follows.' : ''));
    }

    const set = raw => { own[s.key] = coerce(s, raw); emit(); };
    let input;
    switch (s.type) {
      case 'number':
        input = h('input', { type: 'number', value: String(own[s.key]), step: 'any', oninput: e => set(e.target.value) });
        break;
      case 'secret':
        input = h('input', { type: 'password', value: own[s.key], autocomplete: 'off', oninput: e => set(e.target.value) });
        break;
      case 'yes/no':
        input = h('label', { class: 'check', style: { margin: '4px 0 0' } },
          h('input', { type: 'checkbox', checked: !!own[s.key], onchange: e => set(e.target.checked) }), own[s.key] ? 'yes' : 'no');
        input.querySelector('input').addEventListener('change', e => { input.lastChild.textContent = e.target.checked ? 'yes' : 'no'; });
        break;
      case 'choice':
        input = h('select', { onchange: e => set(e.target.value) },
          s.options.map(o => h('option', { value: o, selected: o === own[s.key] }, o)));
        break;
      case 'weekly hours':
        input = weekGrid({ value: own[s.key], onChange: v => set(v) });
        break;
      case 'filler list': {
        input = h('select', { onchange: e => set(e.target.value) }, h('option', { value: '' }, '(none)'));
        loadFillerLists().then(lists => {
          if (!lists.length) input.append(h('option', { disabled: true }, 'No filler lists in Tunarr yet'));
          for (const l of lists) input.append(h('option', { value: l.id, selected: l.id === own[s.key] }, l.name));
        });
        break;
      }
      default:
        input = h('input', { type: 'text', value: own[s.key], oninput: e => set(e.target.value) });
    }
    return fieldEl = h('div', { class: `field${wide ? ' wide' : ''}` }, labelRow, input);
  };

  return h('div', { class: 'settings-form' }, settings.map(renderField));
}
