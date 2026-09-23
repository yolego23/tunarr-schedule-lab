// The `weekly hours` setting: a week grid you paint (30-minute steps) plus
// the text it is stored as. Typing exact times in the text box also works.
import { h } from '../ui.js';
import { DAY_NAMES, maskToWeeklyHours, parseWeeklyHours, weeklyHoursToMask } from '/shared/weekly-hours.js';

const ROWS = [1, 2, 3, 4, 5, 6, 0]; // Mon..Sun

export function weekGrid({ value, onChange }) {
  let mask = weeklyHoursToMask(value);
  const text = h('input', { type: 'text', value: value || '', placeholder: 'e.g. Mon-Fri 08:00-16:30; Daily 22:30-06:00' });
  const errorLine = h('span', { class: 'small err-text' });
  const cells = [];
  const grid = h('div', { class: 'week-grid' });

  for (const day of ROWS) {
    grid.append(h('div', { class: 'dlabel' }, DAY_NAMES[day]));
    for (let slot = 0; slot < 48; slot++) {
      const cell = h('div', { class: `cell${slot % 2 === 0 ? ' hour' : ''}`, title: `${DAY_NAMES[day]} ${String(Math.floor(slot / 2)).padStart(2, '0')}:${slot % 2 ? '30' : '00'}` });
      cell.dataset.day = day;
      cell.dataset.slot = slot;
      cells.push(cell);
      grid.append(cell);
    }
  }
  const paintCells = () => cells.forEach(c => c.classList.toggle('on', mask[c.dataset.day][c.dataset.slot]));

  // Drag to paint; the first cell decides whether the drag adds or removes.
  let painting = null;
  let last = null; // last painted cell, so fast drags don't leave gaps
  const cellAt = (day, slot) => cells[ROWS.indexOf(day) * 48 + slot];
  const paintAt = target => {
    if (!target?.classList?.contains('cell') || painting === null) return;
    const day = Number(target.dataset.day), slot = Number(target.dataset.slot);
    const from = last && last.day === day ? Math.min(last.slot, slot) : slot;
    const to = last && last.day === day ? Math.max(last.slot, slot) : slot;
    for (let s = from; s <= to; s++) {
      mask[day][s] = painting;
      cellAt(day, s).classList.toggle('on', painting);
    }
    last = { day, slot };
  };
  grid.addEventListener('pointerdown', e => {
    if (!e.target.classList.contains('cell')) return;
    e.preventDefault();
    painting = !mask[e.target.dataset.day][e.target.dataset.slot];
    last = null;
    paintAt(e.target);
  });
  grid.addEventListener('pointermove', e => {
    if (painting === null) return;
    paintAt(document.elementFromPoint(e.clientX, e.clientY));
  });
  const endPaint = () => {
    if (!grid.isConnected && painting === null) { window.removeEventListener('pointerup', endPaint); return; }
    if (painting === null) return;
    painting = null;
    text.value = maskToWeeklyHours(mask);
    errorLine.textContent = '';
    onChange(text.value);
  };
  window.addEventListener('pointerup', endPaint);

  text.addEventListener('input', () => {
    const { errors } = parseWeeklyHours(text.value);
    errorLine.textContent = errors.join('; ');
    mask = weeklyHoursToMask(text.value);
    paintCells();
    onChange(text.value);
  });

  paintCells();
  const hours = h('div', { class: 'week-hours' }, h('span'), Array.from({ length: 24 }, (_, i) => h('span', null, i % 3 === 0 ? String(i) : '')));
  return h('div', { class: 'week' },
    grid, hours,
    h('div', { class: 'week-tools' },
      text,
      h('button', { class: 'btn small ghost', type: 'button', onclick: () => { mask = weeklyHoursToMask(''); paintCells(); text.value = ''; onChange(''); } }, 'Clear'),
    ),
    errorLine,
  );
}
