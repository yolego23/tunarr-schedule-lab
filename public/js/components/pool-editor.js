// The Pool card: a channel's pool sources (picked shows, seasons, movies,
// custom shows, library rules), their weights, and exclusions, with a live
// summary of what they add up to.
import { api, busy, clear, fmtDur, h, modal, toast } from '../ui.js';

let optionsPromise = null;
/** Networks, genres, ratings, libraries and custom shows (cached for the session). */
export function libraryOptions() {
  if (!optionsPromise) optionsPromise = api('GET', '/api/library/options').catch(err => { optionsPromise = null; throw err; });
  return optionsPromise;
}

// crypto.randomUUID() needs HTTPS or localhost; the app is often opened by LAN IP.
const newId = () => 'src-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

const KIND_LABEL = { show: 'show', season: 'season', movie: 'movie', episode: 'episode', custom_show: 'custom show', smart_collection: 'smart collection', rule: 'rule' };

/**
 * poolEditor({ pool, lineupEpisodes, onChange, allowRules, onConvertRule }) -> element
 * allowRules: false hides "+ Rule" (library rules belong to Automations).
 * onConvertRule(source): shows "Convert" on existing rule sources.
 * `pool` is { sources, exclusions } and is edited in place; onChange() after each edit.
 */
export function poolEditor({ pool, lineupEpisodes, onChange, allowRules = true, emptyText, onConvertRule }) {
  const el = h('div');
  let resolved = null;
  let resolving = false;
  let timer = null;

  const changed = () => { onChange(); draw(); scheduleResolve(); };
  const scheduleResolve = () => { clearTimeout(timer); timer = setTimeout(resolve, 500); };

  async function resolve() {
    if (!pool.sources.length) { resolved = null; draw(); return; }
    resolving = true;
    draw();
    try { resolved = await api('POST', '/api/pool/resolve', { pool }); }
    catch (err) { resolved = { error: err.message }; }
    resolving = false;
    draw();
  }

  function summaryFor(src) {
    const s = resolved?.sources?.find(x => x.id === src.id || (x.label === src.label && x.kind === src.kind));
    if (!s) return resolving ? '…' : '';
    if (s.error) return h('span', { class: 'err-text' }, s.error);
    return `${s.kind === 'rule' || s.kind === 'smart_collection' ? `${s.shows} shows · ` : ''}${s.episodes} episodes · ${fmtDur(s.durationMs)}`;
  }

  function draw() {
    const header = !pool.sources.length
      ? h('p', { class: 'dim small' }, emptyText ||
          `No pool sources: this channel's pool is whatever is on its lineup now (${lineupEpisodes} lineup items). Add sources to build it from your library instead; new episodes then join on their own.`)
      : h('p', { class: 'small' },
          resolving ? h('span', { class: 'dim' }, h('span', { class: 'spinner' }), ' Reading the library…')
          : resolved?.error ? h('span', { class: 'err-text' }, resolved.error)
          : resolved ? [h('b', null, `${resolved.shows.length} shows · ${resolved.episodes} episodes · ${fmtDur(resolved.durationMs)}`),
              resolved.excluded ? h('span', { class: 'dim' }, ` (${resolved.excluded} excluded)`) : null] : '');

    const rows = pool.sources.map((src, i) => h('tr', null,
      h('td', null, h('span', { class: 'tag' }, KIND_LABEL[src.kind]), ' ', src.label,
        src.kind === 'rule' && src.label !== describeRule(src.rule) ? h('div', { class: 'dim small' }, describeRule(src.rule)) : null),
      h('td', { class: 'small' }, summaryFor(src)),
      h('td', null, h('input', {
        type: 'number', min: 0, max: 100, step: 0.5, value: String(src.weight ?? 1), style: { width: '70px' },
        title: 'Weight: sorts can use it to play some sources more often (each episode gets the highest weight of its sources)',
        onchange: e => { src.weight = Number(e.target.value) || 0; changed(); },
      })),
      h('td', { class: 'actions' },
        src.kind === 'rule' ? h('button', { class: 'btn small ghost', onclick: () => ruleDialog(src) }, 'Edit') : null,
        src.kind === 'rule' && onConvertRule ? h('button', { class: 'btn small', title: 'Replace the rule with the shows it matches now, plus an automation that suggests new matching shows', onclick: () => onConvertRule(src) }, 'Convert') : null,
        h('button', { class: 'btn small ghost', onclick: () => { pool.sources.splice(i, 1); changed(); } }, 'Remove'))));

    clear(el,
      h('div', { class: 'card-head' },
        h('h3', null, 'Episode pool'),
        h('div', { class: 'btn-row' },
          h('button', { class: 'btn small', onclick: () => browseDialog() }, '+ Shows & movies'),
          allowRules ? h('button', { class: 'btn small', onclick: () => ruleDialog(null) }, '+ Rule') : null,
          h('button', { class: 'btn small', onclick: () => customShowDialog() }, '+ Custom show'),
          h('button', { class: 'btn small', title: 'A Tunarr smart collection (a saved search); what it matches is read every time a lineup is built', onclick: () => smartCollectionDialog() }, '+ Smart collection'),
          pool.sources.length ? h('button', { class: 'btn small ghost', onclick: () => episodesDialog() }, 'Shows in pool') : null)),
      header,
      pool.sources.length ? h('div', { class: 'table-wrap' }, h('table', { class: 'grid' },
        h('thead', null, h('tr', null, ['Source', 'Adds', 'Weight', ''].map(t => h('th', null, t)))),
        h('tbody', null, rows))) : null,
      pool.exclusions.length ? h('div', { style: { marginTop: '8px' } }, h('span', { class: 'lab' }, 'Excluded'),
        h('div', { class: 'btn-row' }, pool.exclusions.map((x, i) => h('span', { class: 'pill' }, `${x.kind}: ${x.label} `,
          h('a', { href: '#', title: 'Stop excluding', onclick: e => { e.preventDefault(); pool.exclusions.splice(i, 1); changed(); } }, '×'))))) : null);
  }

  // ---------- add shows / seasons / movies ----------
  function browseDialog() {
    const search = h('input', { type: 'text', placeholder: 'Search titles…' });
    const type = h('select', null, h('option', { value: 'show,movie' }, 'Shows and movies'), h('option', { value: 'show' }, 'Shows'), h('option', { value: 'movie' }, 'Movies'));
    const library = h('select', null, h('option', { value: '' }, 'All libraries'));
    libraryOptions().then(o => o.libraries.forEach(l => library.append(h('option', { value: l.id }, l.name)))).catch(() => null);
    const results = h('div');
    let page = 1, hits = [], totalPages = 1, seq = 0;
    const has = (kind, ref) => pool.sources.some(s => s.kind === kind && s.ref === ref);
    const add = (kind, ref, label) => { if (has(kind, ref)) return; pool.sources.push({ id: newId(), kind, ref, label, weight: 1 }); changed(); drawResults(); };

    async function run(reset) {
      const mine = ++seq;
      if (reset) { page = 1; hits = []; }
      const q = new URLSearchParams({ types: type.value, page: String(page) });
      if (search.value.trim()) q.set('text', search.value.trim());
      if (library.value) q.set('libraryId', library.value);
      try {
        const r = await api('GET', '/api/library/search?' + q);
        if (mine !== seq) return;
        hits = hits.concat(r.hits);
        totalPages = r.totalPages;
        drawResults(r.totalHits);
      } catch (err) { clear(results, h('p', { class: 'err-text small' }, err.message)); }
    }
    let total = 0;
    function drawResults(t) {
      if (t !== undefined) total = t;
      clear(results,
        h('p', { class: 'dim small' }, `${total} found`),
        h('table', { class: 'grid' }, h('tbody', null, hits.map(hit => {
          const seasons = h('div');
          return h('tr', null,
            h('td', null, h('b', null, hit.title), hit.year ? ` (${hit.year})` : '', ' ', hit.rating ? h('span', { class: 'tag' }, hit.rating) : null,
              h('div', { class: 'dim small' }, hit.type === 'show' ? `${hit.seasons ?? '?'} seasons · ${hit.episodes ?? '?'} episodes` : hit.type),
              seasons),
            h('td', { class: 'actions' },
              hit.type === 'show' ? h('button', { class: 'btn small ghost', onclick: e => busy(e.currentTarget, async () => {
                const list = await api('GET', '/api/library/children/' + hit.id);
                clear(seasons, h('div', { class: 'btn-row', style: { marginTop: '4px' } }, list.sort((a, b) => a.index - b.index).map(sn => {
                  const label = `${hit.title} · ${sn.title || 'Season ' + sn.index}`;
                  return h('button', { class: 'btn small' + (has('season', sn.uuid) ? ' active' : ''), onclick: () => add('season', sn.uuid, label) }, sn.title || 'Season ' + sn.index);
                })));
              }) }, 'Seasons') : null,
              hit.type === 'show' ? h('button', { class: 'btn small ghost', title: 'Pick single episodes', onclick: e => busy(e.currentTarget, async () => {
                const eps = await api('GET', '/api/library/episodes/' + hit.id);
                const drawEps = () => clear(seasons, h('div', { style: { maxHeight: '240px', overflowY: 'auto', marginTop: '4px' } },
                  h('table', { class: 'grid' }, h('tbody', null, eps.map(ep => h('tr', null,
                    h('td', { class: 'small' }, ep.episodeLabel ? h('span', { class: 'mono dim' }, ep.episodeLabel + ' ') : null, ep.title),
                    h('td', { class: 'actions' }, has('episode', ep.id)
                      ? h('span', { class: 'pill ok' }, 'added')
                      : h('button', { class: 'btn small', onclick: () => { add('episode', ep.id, `${hit.title} · ${ep.episodeLabel ? ep.episodeLabel + ' ' : ''}${ep.title}`); drawEps(); } }, 'Add'))))))));
                drawEps();
              }) }, 'Episodes') : null,
              has(hit.type, hit.id)
                ? h('span', { class: 'pill ok' }, 'added')
                : h('button', { class: 'btn small primary', onclick: () => add(hit.type, hit.id, hit.title + (hit.year ? ` (${hit.year})` : '')) }, hit.type === 'show' ? 'Add show' : 'Add movie')));
        }))),
        page < totalPages ? h('div', { class: 'tl-more' }, h('button', { class: 'btn small', onclick: () => { page++; run(false); } }, 'More')) : null);
    }
    let debounce = null;
    search.addEventListener('input', () => { clearTimeout(debounce); debounce = setTimeout(() => run(true), 300); });
    type.onchange = library.onchange = () => run(true);
    modal({
      title: 'Add shows and movies',
      wide: true,
      body: h('div', null, h('div', { class: 'row' }, h('div', { style: { flex: 3 } }, search), type, library), results),
    });
    setTimeout(() => search.focus(), 0);
    run(true);
  }

  // ---------- rules ----------
  async function ruleDialog(existing) {
    let opts;
    try { opts = await libraryOptions(); } catch (err) { toast(err.message, 'err'); return; }
    const rule = structuredClone(existing?.rule || { types: ['show'] });
    const label = h('input', { type: 'text', value: existing?.label || '', placeholder: 'For example: Cartoon Network shows' });
    const text = h('input', { type: 'text', value: rule.text || '', placeholder: 'Title contains (optional)' });
    const showsBox = h('input', { type: 'checkbox', checked: (rule.types || ['show']).includes('show') });
    const moviesBox = h('input', { type: 'checkbox', checked: (rule.types || []).includes('movie') });
    const yearFrom = h('input', { type: 'number', value: rule.yearFrom ?? '', placeholder: 'from' });
    const yearTo = h('input', { type: 'number', value: rule.yearTo ?? '', placeholder: 'to' });
    const added = h('input', { type: 'number', min: 0, value: rule.addedWithinDays ?? '', placeholder: 'days' });
    const matchesBox = h('div');
    const pickers = {
      networks: chipsInput(opts.networks, rule.networks || [], 'Network or studio'),
      genres: chipsInput(opts.genres, rule.genres || [], 'Genre'),
      ratings: chipsInput(opts.ratings, rule.ratings || [], 'Rating'),
      libraries: chipsInput(opts.libraries.map(l => ({ value: l.id, label: l.name })), rule.libraries || [], 'Library'),
    };
    const collect = () => ({
      text: text.value.trim() || undefined,
      types: [showsBox.checked ? 'show' : null, moviesBox.checked ? 'movie' : null].filter(Boolean),
      networks: pickers.networks.values(), genres: pickers.genres.values(), ratings: pickers.ratings.values(), libraries: pickers.libraries.values(),
      yearFrom: yearFrom.value === '' ? undefined : Number(yearFrom.value),
      yearTo: yearTo.value === '' ? undefined : Number(yearTo.value),
      addedWithinDays: added.value === '' ? undefined : Number(added.value),
    });
    let seq = 0, debounce = null;
    const preview = () => {
      clearTimeout(debounce);
      debounce = setTimeout(async () => {
        const mine = ++seq;
        clear(matchesBox, h('p', { class: 'dim small' }, h('span', { class: 'spinner' }), ' Checking…'));
        try {
          const r = await api('POST', '/api/library/rule-search', { rule: collect() });
          if (mine !== seq) return;
          clear(matchesBox,
            h('p', { class: 'small' }, h('b', null, `Matches ${r.totalHits} ${collect().types.length === 1 && collect().types[0] === 'movie' ? 'movies' : 'shows'}`), ' right now; new matches join automatically.'),
            h('div', { class: 'dim small' }, r.hits.map(x => x.title + (x.year ? ` (${x.year})` : '')).join(' · ') + (r.totalHits > r.hits.length ? ' …' : '')));
        } catch (err) { if (mine === seq) clear(matchesBox, h('p', { class: 'dim small' }, err.message)); }
      }, 400);
    };
    for (const input of [text, showsBox, moviesBox, yearFrom, yearTo, added]) input.addEventListener('input', preview);
    for (const p of Object.values(pickers)) p.onChange(preview);
    preview();
    const field = (lab, ...c) => h('div', { class: 'field' }, h('span', { class: 'lab' }, lab), ...c);
    modal({
      title: existing ? 'Edit rule' : 'Add a library rule',
      wide: true,
      body: h('div', null,
        h('p', { class: 'dim small' }, 'A rule is checked against your library every time a lineup is built, so shows added later that match it join the channel on their own. Networks come from your library\'s metadata, so a show listed under a different name (for example "Cartoon Network Studios") needs that name too.'),
        h('div', { class: 'row' }, field('Name', label), field('Match', h('div', { class: 'btn-row' }, h('label', { class: 'check' }, showsBox, 'Shows'), h('label', { class: 'check' }, moviesBox, 'Movies')))),
        h('div', { class: 'row' }, field('Networks / studios', pickers.networks.el), field('Genres', pickers.genres.el)),
        h('div', { class: 'row' }, field('Ratings', pickers.ratings.el), field('Libraries', pickers.libraries.el)),
        h('div', { class: 'row' }, field('Years', h('div', { class: 'btn-row', style: { flexWrap: 'nowrap' } }, yearFrom, yearTo)), field('Added in the last', added), field('Title contains', text)),
        matchesBox),
      actions: [
        { label: 'Cancel', kind: 'ghost' },
        { label: existing ? 'Save rule' : 'Add rule', kind: 'primary', onClick: () => {
          const r = collect();
          if (!r.types.length) { toast('Pick shows, movies or both.', 'warn'); return false; }
          const name = label.value.trim() || describeRule(r);
          if (existing) { existing.rule = r; existing.label = name; }
          else pool.sources.push({ id: newId(), kind: 'rule', label: name, rule: r, weight: 1 });
          changed();
          return true;
        } },
      ],
    });
  }

  // ---------- custom shows ----------
  async function customShowDialog() {
    let opts;
    try { opts = await libraryOptions(); } catch (err) { toast(err.message, 'err'); return; }
    const close = modal({
      title: 'Add a custom show',
      body: opts.customShows.length
        ? h('table', { class: 'grid' }, h('tbody', null, opts.customShows.map(c => h('tr', null,
            h('td', null, c.name, h('div', { class: 'dim small' }, `${c.count} items · ${fmtDur(c.durationMs)}`)),
            h('td', { class: 'actions' }, pool.sources.some(s => s.kind === 'custom_show' && s.ref === c.id)
              ? h('span', { class: 'pill ok' }, 'added')
              : h('button', { class: 'btn small primary', onclick: () => { pool.sources.push({ id: newId(), kind: 'custom_show', ref: c.id, label: c.name, weight: 1 }); changed(); close(); } }, 'Add'))))))
        : h('p', { class: 'dim' }, 'Tunarr has no custom shows yet.'),
    });
  }

  async function smartCollectionDialog() {
    let opts;
    try { opts = await libraryOptions(); } catch (err) { toast(err.message, 'err'); return; }
    const list = opts.smartCollections || [];
    const close = modal({
      title: 'Add a smart collection',
      body: list.length
        ? h('table', { class: 'grid' }, h('tbody', null, list.map(c => h('tr', null,
            h('td', null, c.name),
            h('td', { class: 'actions' }, pool.sources.some(s => s.kind === 'smart_collection' && s.ref === c.id)
              ? h('span', { class: 'pill ok' }, 'added')
              : h('button', { class: 'btn small primary', onclick: () => { pool.sources.push({ id: newId(), kind: 'smart_collection', ref: c.id, label: c.name, weight: 1 }); changed(); close(); } }, 'Add'))))))
        : h('p', { class: 'dim' }, 'Tunarr has no smart collections yet. Make one in Tunarr (a saved library search), then add it here.'),
    });
  }

  // ---------- shows in pool / exclusions ----------
  async function episodesDialog() {
    if (!resolved || resolved.error) await resolve();
    const shows = resolved?.shows || [];
    const close = modal({
      title: `Shows in the pool (${shows.length})`,
      wide: true,
      body: h('table', { class: 'grid' },
        h('thead', null, h('tr', null, ['Show', 'Episodes', 'From', ''].map(t => h('th', null, t)))),
        h('tbody', null, shows.map(s => h('tr', null,
          h('td', null, s.showTitle),
          h('td', { class: 'mono small' }, `${s.episodes} · ${fmtDur(s.durationMs)}`),
          h('td', { class: 'small dim' }, s.sources.join(', ')),
          h('td', { class: 'actions' }, s.showId ? h('button', { class: 'btn small ghost', onclick: () => {
            pool.exclusions.push({ kind: 'show', id: s.showId, label: s.showTitle });
            changed();
            close();
          } }, 'Exclude') : null))))),
    });
  }

  draw();
  resolve();
  return el;
}

export function describeRule(r) {
  if (!r) return '';
  const parts = [];
  const what = (r.types || ['show']).length === 2 ? 'Shows and movies' : (r.types || ['show'])[0] === 'movie' ? 'Movies' : 'Shows';
  if (r.networks?.length) parts.push('on ' + r.networks.join(' / '));
  if (r.genres?.length) parts.push(r.genres.join(' / '));
  if (r.ratings?.length) parts.push('rated ' + r.ratings.join(', '));
  if (r.yearFrom || r.yearTo) parts.push(`${r.yearFrom || '…'}–${r.yearTo || '…'}`);
  if (r.addedWithinDays) parts.push(`added in the last ${r.addedWithinDays} days`);
  if (r.text) parts.push(`title contains "${r.text}"`);
  if (r.libraries?.length) parts.push(`${r.libraries.length} librar${r.libraries.length === 1 ? 'y' : 'ies'}`);
  return `${what} ${parts.join(', ')}`.trim();
}

/** A text box with suggestions that turns picks into removable chips. */
function chipsInput(options, initial, placeholder) {
  const items = (options || []).map(o => ({ value: o.value, label: o.label || o.value, count: o.count }));
  const selected = [...initial];
  const listeners = [];
  const chips = h('div', { class: 'btn-row', style: { marginTop: '4px' } });
  const id = 'chips-' + Math.random().toString(36).slice(2);
  const input = h('input', { type: 'text', list: id, placeholder: placeholder + '…' });
  const list = h('datalist', { id }, items.map(o => h('option', { value: o.label }, o.count !== undefined ? `${o.count} episodes` : '')));
  const labelOf = v => items.find(o => o.value === v)?.label || v;
  const draw = () => clear(chips, selected.map((v, i) => h('span', { class: 'pill info' }, labelOf(v) + ' ',
    h('a', { href: '#', onclick: e => { e.preventDefault(); selected.splice(i, 1); draw(); listeners.forEach(f => f()); } }, '×'))));
  const addTyped = () => {
    const t = input.value.trim();
    if (!t) return;
    const match = items.find(o => o.label.toLowerCase() === t.toLowerCase());
    const value = match ? match.value : t;
    if (!selected.includes(value)) selected.push(value);
    input.value = '';
    draw();
    listeners.forEach(f => f());
  };
  input.addEventListener('change', addTyped);
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addTyped(); } });
  draw();
  return { el: h('div', null, input, list, chips), values: () => [...selected], onChange: f => listeners.push(f) };
}
