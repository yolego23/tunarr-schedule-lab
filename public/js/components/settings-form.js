// Turns a sort's declared settings into form fields.
import { h } from '../ui.js';
import { weekGrid } from './week-grid.js';
import { coerce, resolveValues } from '/shared/sort-settings.js';
import { loadFillerLists } from '../store.js';

/**
 * settingsForm({ settings, values, onChange }) -> element.
 * `values` are stored values (may be partial); onChange gets the full resolved object.
 */
export function settingsForm({ settings, values, onChange }) {
  const current = resolveValues(settings, values || {});
  const emit = () => onChange({ ...current });
  if (!settings.length) return h('p', { class: 'dim small' }, 'This sort declares no settings.');

  const fields = settings.map(s => {
    const set = raw => { current[s.key] = coerce(s, raw); emit(); };
    let input;
    switch (s.type) {
      case 'number':
        input = h('input', { type: 'number', value: String(current[s.key]), step: 'any', oninput: e => set(e.target.value) });
        break;
      case 'secret':
        input = h('input', { type: 'password', value: current[s.key], autocomplete: 'off', oninput: e => set(e.target.value) });
        break;
      case 'yes/no':
        return h('label', { class: 'check', style: { marginTop: '18px' } },
          h('input', { type: 'checkbox', checked: !!current[s.key], onchange: e => set(e.target.checked) }), s.label);
      case 'choice':
        input = h('select', { onchange: e => set(e.target.value) },
          s.options.map(o => h('option', { value: o, selected: o === current[s.key] }, o)));
        break;
      case 'weekly hours':
        return h('label', { class: 'field wide' }, h('span', { class: 'lab' }, s.label),
          weekGrid({ value: current[s.key], onChange: v => set(v) }));
      case 'filler list': {
        input = h('select', { onchange: e => set(e.target.value) }, h('option', { value: '' }, '(none)'));
        loadFillerLists().then(lists => {
          if (!lists.length) input.append(h('option', { disabled: true }, 'No filler lists in Tunarr yet'));
          for (const l of lists) input.append(h('option', { value: l.id, selected: l.id === current[s.key] }, l.name));
        });
        break;
      }
      default:
        input = h('input', { type: 'text', value: current[s.key], oninput: e => set(e.target.value) });
    }
    const wide = s.type === 'text' && String(current[s.key]).length > 40;
    return h('label', { class: `field${wide ? ' wide' : ''}` }, h('span', { class: 'lab', title: s.key }, s.label), input);
  });
  return h('div', { class: 'settings-form' }, fields);
}
