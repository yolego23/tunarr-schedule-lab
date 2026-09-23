// Screens that arrive in 2.1.
import { clear, h } from '../ui.js';

const ABOUT = {
  automations: {
    title: 'Automations',
    lines: [
      'Rebuilds each channel on its own timetable (daily, weekly, monthly or manual), with jobs in one queue, one or two at a time, spread across an overnight window.',
      'Each automated rebuild is backed up first and stops if the new lineup is much shorter than the old one. Rebuilds can use the Watch Tracker\'s history.',
    ],
  },
};

export function render(root, { screen }) {
  const about = ABOUT[screen.path];
  clear(root, h('div', { class: 'scroll-page' }, h('div', { class: 'page-width' },
    h('h2', null, about.title, ' ', h('span', { class: 'pill' }, 'coming in 2.1')),
    about.lines.map(l => h('p', { class: 'dim' }, l)))));
}
