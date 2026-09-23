// Screens that arrive in 2.1.
import { clear, h } from '../ui.js';

const ABOUT = {
  watch: {
    title: 'Watch Tracker',
    lines: [
      'Records what played while someone was actually streaming: it polls Tunarr\'s sessions and what each channel is playing, and counts a play after 5 or more minutes (optionally only from chosen devices).',
      'Sorts read it through ctx.history.watched(id) and ctx.history.lastAired(id). Until then those return 0 and null.',
    ],
  },
  automations: {
    title: 'Automations',
    lines: [
      'Rebuilds each channel on its own timetable (daily, weekly, monthly or manual), with jobs in one queue, one or two at a time, spread across an overnight window.',
      'Each automated rebuild is backed up first and stops if the new lineup is much shorter than the old one.',
    ],
  },
};

export function render(root, { screen }) {
  const about = ABOUT[screen.path];
  clear(root, h('div', { class: 'scroll-page' }, h('div', { class: 'page-width' },
    h('h2', null, about.title, ' ', h('span', { class: 'pill' }, 'coming in 2.1')),
    about.lines.map(l => h('p', { class: 'dim' }, l)))));
}
