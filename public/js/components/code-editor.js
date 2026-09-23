// A plain code editor: textarea with line numbers, Tab indents, Ctrl/Cmd+S saves.
import { h } from '../ui.js';

export function codeEditor({ value, onChange, onSave, minHeight = 260 }) {
  const gutter = h('div', { class: 'gutter' });
  const ta = h('textarea', { spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', value: value || '' });
  const renderGutter = () => {
    const lines = ta.value.split('\n').length;
    gutter.textContent = Array.from({ length: lines }, (_, i) => i + 1).join('\n');
  };
  ta.addEventListener('scroll', () => { gutter.scrollTop = ta.scrollTop; });
  ta.addEventListener('input', () => { renderGutter(); onChange?.(ta.value); });
  ta.addEventListener('keydown', e => {
    if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      const { selectionStart: s, selectionEnd: end, value: v } = ta;
      if (e.shiftKey) {
        const lineStart = v.lastIndexOf('\n', s - 1) + 1;
        if (v.slice(lineStart, lineStart + 2) === '  ') {
          ta.value = v.slice(0, lineStart) + v.slice(lineStart + 2);
          ta.selectionStart = ta.selectionEnd = Math.max(lineStart, s - 2);
        }
      } else {
        ta.value = v.slice(0, s) + '  ' + v.slice(end);
        ta.selectionStart = ta.selectionEnd = s + 2;
      }
      renderGutter();
      onChange?.(ta.value);
    } else if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      onSave?.();
    }
  });
  renderGutter();
  const el = h('div', { class: 'editor', style: { minHeight: `${minHeight}px` } }, gutter, ta);
  el.getValue = () => ta.value;
  el.setValue = v => { ta.value = v; renderGutter(); };
  el.textarea = ta;
  return el;
}
