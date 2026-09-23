// Channels: each channel's setup (pool, sort and version, its own values for
// the sort's settings, lineup length, automations), rebuilding it (build a
// preview, apply, undo) and its lineup now, in tabs. Setup saves automatically.
import { api, busy, clear, confirmDialog, fmtAgo, fmtDur, fmtWhen, h, modal, toast } from '../ui.js';
import { addFlusher, channelLabel, findChannel, findSort, forgetChannelData, loadChannelData, loadChannels, loadGlobals, loadSettings, loadSorts, selectChannel, setUnsaved, store } from '../store.js';
import { settingsForm } from '../components/settings-form.js';
import { poolEditor } from '../components/pool-editor.js';
import { automationsCard } from '../components/automations.js';
import { lineupTab, quickRebuild, rebuildTab } from '../components/rebuild.js';
import { parseSettings } from '/shared/sort-settings.js';

export async function render(root, { go }) {
  const listBody = h('div', { class: 'panel-body', style: { padding: 0 } });
  const detail = h('div', { class: 'panel' });
  const filter = h('input', { type: 'text', placeholder: 'Filter channels…', style: { width: '100%' } });
  clear(root, h('div', { class: 'screen two' },
    h('div', { class: 'panel' },
      h('div', { class: 'panel-head' }, h('span', null, 'Tunarr channels'),
        h('div', { class: 'btn-row' },
          h('button', { class: 'btn small primary', title: 'Make a new channel in the Channel Builder', onclick: () => go('channel-builder') }, '+ New'),
          h('button', { class: 'btn small ghost', onclick: e => busy(e.currentTarget, async () => { await loadChannels(true); drawList(); }) }, 'Reload'))),
      h('div', { style: { padding: '8px 10px', borderBottom: '1px solid var(--line)' } }, filter),
      listBody,
      h('div', { class: 'panel-foot' }, h('button', { class: 'btn small ghost', onclick: () => showArchive() }, 'Deleted channels'))),
    detail));

  let channels = [];
  try {
    [channels] = await Promise.all([loadChannels(), loadSorts(), loadGlobals(true), loadSettings()]);
  } catch (err) {
    clear(listBody, h('div', { class: 'empty' }, h('b', null, "Couldn't load channels"), err.message));
    return;
  }
  channels = store.channels;

  function drawList() {
    const q = filter.value.trim().toLowerCase();
    clear(listBody, h('div', { class: 'list' }, store.channels
      .filter(c => !q || `${c.number} ${c.name} ${c.sortName || ''}`.toLowerCase().includes(q))
      .map(c => {
        const outdated = c.setup.sortVersion && c.latestVersion && c.setup.sortVersion < c.latestVersion;
        return h('div', { class: `list-item${c.id === store.selectedChannelId ? ' active' : ''}`, onclick: () => { selectChannel(c.id); drawList(); drawDetail(); } },
          h('span', { class: 'num' }, c.number),
          h('div', { style: { flex: 1, minWidth: 0 } },
            h('div', { class: 'name' }, c.name),
            h('div', { class: 'sub' }, c.sortName ? `${c.sortName} v${c.setup.sortVersion}` : 'no sort assigned')),
          outdated ? h('span', { class: 'pill warn', title: `v${c.latestVersion} is available` }, 'update') : null,
          c.setup.sortId ? h('button', {
            class: 'btn small ghost quick-rebuild', title: `Rebuild ${c.name} now with its sort and settings (you confirm before it's applied)`,
            onclick: e => { e.stopPropagation(); busy(e.currentTarget, () => rebuildNow(c)); },
          }, '↻') : null);
      })));
  }
  filter.addEventListener('input', drawList);

  let removeFlusher = null;

  async function drawDetail() {
    // Push out any pending save for the channel we're leaving.
    if (removeFlusher) { removeFlusher.flush(); removeFlusher(); removeFlusher = null; }
    const ch = store.channels.find(c => c.id === store.selectedChannelId);
    if (!ch) {
      clear(detail, h('div', { class: 'panel-head' }, 'Channel'),
        h('div', { class: 'empty' }, h('b', null, 'Pick a channel'), 'Choose a channel on the left to set its sort and settings.'));
      return;
    }
    const setup = structuredClone(ch.setup);
    let settings = [];

    // ---- autosave ----
    const url = `/api/channels/${encodeURIComponent(ch.id)}/setup`;
    const unsavedKey = `channel:${ch.id}`;
    const status = h('span', { class: 'pill ok' }, 'All changes saved');
    const payload = () => ({ sortId: setup.sortId, sortVersion: setup.sortVersion, values: setup.values, targetHours: setup.targetHours, alignStart: setup.alignStart, pool: setup.pool });
    let timer = null, pending = false, inFlight = null;
    const setStatus = (kind, text) => { status.className = `pill ${kind}`; status.textContent = text; status.title = text; };
    const markDirty = () => {
      pending = true;
      setStatus('warn', 'Saving…');
      // Kept in memory until saved, so switching screens is fine; a reload would lose it.
      setUnsaved(unsavedKey, `${ch.name}: changes are still being saved.`, { inApp: false });
      clearTimeout(timer);
      timer = setTimeout(saveNow, 600);
    };
    async function saveNow() {
      clearTimeout(timer);
      timer = null;
      if (inFlight) await inFlight;
      if (!pending) return;
      pending = false;
      inFlight = api('PUT', url, payload()).then(saved => {
        ch.setup = saved;
        forgetChannelData(ch.id); // the pool may have changed
        ch.sortName = saved.sortId ? findSort(saved.sortId)?.name ?? null : null;
        ch.latestVersion = saved.sortId ? findSort(saved.sortId)?.latest_version ?? null : null;
        drawList();
        if (!pending) { setStatus('ok', `Saved ${new Date().toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' })}`); setUnsaved(unsavedKey, null); }
      }).catch(err => {
        pending = true;
        setStatus('err', `Not saved: ${err.message}`);
        setUnsaved(unsavedKey, `${ch.name}: changes were not saved (${err.message}).`);
      }).finally(() => { inFlight = null; });
      await inFlight;
    }
    const flush = ({ unloading = false } = {}) => {
      if (!pending) return;
      if (unloading) {
        // The page is going away: send it in a request that outlives the page.
        fetch(url, { method: 'PUT', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload()) });
        pending = false;
        setUnsaved(unsavedKey, null);
      } else return saveNow();
    };
    removeFlusher = addFlusher(flush);
    removeFlusher.flush = flush;

    const sortCard = h('div', { class: 'card' });
    if (!setup.pool) setup.pool = { sources: [], exclusions: [] };
    // The pool was changed on the server (a suggestion added, a rule converted): reload it.
    const reloadPool = async () => {
      await saveNow();
      ch.setup = await api('GET', url);
      forgetChannelData(ch.id);
      await drawDetail();
    };
    const convertRule = async src => {
      const ok = await confirmDialog({
        title: 'Convert library rule',
        message: `Replace "${src.label}" with the shows and movies it matches today, and add the "Add new matching shows" automation to this channel so new matches are suggested for you to approve?

Library rules now live in automations.`,
        confirmLabel: 'Convert',
      });
      if (!ok) return;
      try {
        await saveNow();
        const r = await api('POST', `/api/channels/${encodeURIComponent(ch.id)}/pool/convert-rule`, { sourceId: src.id });
        toast(`Added ${r.added} show(s) in place of the rule.${r.assignment ? ' "Add new matching shows" runs weekly in suggest mode.' : ''}${r.note ? ' ' + r.note : ''}`, 'ok', 10000);
        await reloadPool();
      } catch (err) { toast(err.message, 'err'); }
    };
    const addFromLineup = async () => {
      await saveNow();
      const url2 = `/api/channels/${encodeURIComponent(ch.id)}/pool/from-lineup`;
      const check = await api('POST', url2, { dryRun: true });
      if (!check.added.length) { toast('Every show on the lineup is already a pool source.', 'warn'); return; }
      const names = check.added.map(a => a.label);
      const ok = await confirmDialog({
        title: 'Add the lineup to the pool',
        message: `Add ${names.length} show(s) from the lineup as pool sources?\n\n${names.slice(0, 25).join('\n')}${names.length > 25 ? `\n… and ${names.length - 25} more` : ''}${setup.pool.sources.length ? '' : '\n\nThe pool then comes from these sources, so new episodes of these shows join on their own.'}`,
        confirmLabel: 'Add',
      });
      if (!ok) return;
      const r = await api('POST', url2, {});
      toast(`Added ${r.added.length} show(s) to the pool.`, 'ok');
      await reloadPool();
    };
    const poolCard = h('div', { class: 'card' }, poolEditor({ pool: setup.pool, lineupEpisodes: ch.programCount ?? '?', allowRules: false, onConvertRule: convertRule, onAddFromLineup: ch.programCount ? addFromLineup : undefined, onChange: () => markDirty() }));
    const autoCard = automationsCard({ channel: ch, go, onPoolChanged: () => reloadPool().catch(err => toast(err.message, 'err')) });
    const settingsCard = h('div', { class: 'card' });

    // ---- tabs ----
    const setupBody = h('div', { class: 'page-width' }, poolCard, sortCard, settingsCard, autoCard);
    const rebuildBody = rebuildTab({
      ch, setup, go, saveFirst: saveNow,
      onApplied: async () => { await loadChannels(true); drawList(); },
    });
    let lineupBody = null;
    const body = h('div', { class: 'panel-body' });
    const foot = h('div', { class: 'panel-foot' });
    const TABS = { setup: 'Setup', rebuild: 'Rebuild', lineup: 'Lineup now' };
    const tabBtns = Object.entries(TABS).map(([k, label]) => h('button', { class: 'tab', onclick: () => showTab(k) }, label));
    function showTab(k) {
      store.channelTab = k;
      tabBtns.forEach((b, i) => b.classList.toggle('active', Object.keys(TABS)[i] === k));
      if (k === 'setup') {
        clear(body, setupBody);
        clear(foot, h('span', { class: 'dim small' }, 'Changes save automatically, per channel. Use the small menu by a setting to link it to a global variable instead.'));
      } else if (k === 'rebuild') {
        rebuildBody.refresh();
        clear(body, h('div', { class: 'page-width' }, rebuildBody));
        clear(foot, h('span', { class: 'dim small' }, 'Builds use the saved setup. Every apply is backed up first; undo it here or on History.'));
      } else {
        lineupBody = lineupTab(ch); // fresh each time: the lineup may have changed
        clear(body, h('div', { class: 'page-width' }, lineupBody));
        clear(foot, h('span', { class: 'dim small' }, 'What Tunarr is playing on this channel now.'));
      }
    }

    clear(detail,
      h('div', { class: 'panel-head' }, h('span', null, channelLabel(ch)),
        h('div', { class: 'btn-row' }, status,
          h('button', { class: 'btn small ghost', onclick: () => editBasics(ch) }, 'Edit'),
          h('button', { class: 'btn small ghost', onclick: () => editBasics(ch, true) }, 'Copy'),
          h('button', { class: 'btn small ghost', onclick: () => removeChannel(ch) }, 'Delete'))),
      h('div', { class: 'tabs' }, tabBtns),
      body, foot);
    showTab(store.channelTab || 'setup');


    // ---- sort & version ----
    async function drawSort() {
      const sorts = store.sorts || [];
      const sortSelect = h('select', {
        onchange: async e => {
          const id = e.target.value ? Number(e.target.value) : null;
          setup.sortId = id;
          setup.sortVersion = id ? findSort(id).latest_version : null;
          markDirty();
          await drawSort();
        },
      }, h('option', { value: '' }, '(no sort)'), sorts.map(s => h('option', { value: s.id, selected: s.id === setup.sortId }, s.name)));

      if (!sorts.length) {
        clear(sortCard, h('h3', null, 'Sort'),
          h('p', null, 'The library is empty. Import the 1.8 sorts or write one in the Sort Builder.'),
          h('div', { class: 'btn-row' },
            h('button', { class: 'btn primary', onclick: e => busy(e.currentTarget, async () => {
              const r = await api('POST', '/api/sorts/import-presets');
              toast(`Imported ${r.added.length} sort(s).`, 'ok');
              await loadSorts(true);
              drawSort();
            }) }, 'Import 1.8 sorts'),
            h('button', { class: 'btn', onclick: () => go('builder') }, 'Open Sort Builder')));
        settings = [];
        drawSettings();
        return;
      }

      const sort = setup.sortId ? findSort(setup.sortId) : null;
      let versionRow = null;
      if (sort) {
        const detailSort = await api('GET', `/api/sorts/${sort.id}`);
        const versionSelect = h('select', {
          onchange: async e => { setup.sortVersion = Number(e.target.value); markDirty(); await drawSort(); },
        }, detailSort.versions.map(v => h('option', { value: v.version, selected: v.version === setup.sortVersion },
          `v${v.version}${v.version === sort.latest_version ? ' (latest)' : ''}${v.note ? ' · ' + v.note : ''}`)));
        const behind = setup.sortVersion < sort.latest_version;
        versionRow = h('div', null,
          h('label', { class: 'field' }, h('span', { class: 'lab' }, 'Version'), versionSelect,
            h('span', { class: 'hint' }, 'The channel stays on this version until you move it up, so editing the sort never changes this channel by surprise.')),
          behind ? h('div', { class: 'btn-row', style: { marginBottom: '8px' } },
            h('span', { class: 'pill warn' }, `v${sort.latest_version} is available`),
            h('button', { class: 'btn small', onclick: async () => { setup.sortVersion = sort.latest_version; markDirty(); await drawSort(); } }, `Move up to v${sort.latest_version}`)) : null,
          sort.description ? h('p', { class: 'dim small' }, sort.description) : null,
          h('button', { class: 'btn small ghost', onclick: () => go('builder', { sort: sort.id }) }, 'Open in Sort Builder'));
        const v = await api('GET', `/api/sorts/${sort.id}/versions/${setup.sortVersion}`);
        settings = parseSettings(v.code).settings;
      } else {
        settings = [];
      }
      clear(sortCard, h('h3', null, 'Sort'),
        h('label', { class: 'field' }, h('span', { class: 'lab' }, 'Sort from the library'), sortSelect),
        versionRow);
      drawSettings();
    }

    function drawSettings() {
      const hours = h('input', { type: 'number', min: 1, step: 1, value: String(setup.targetHours), oninput: e => { setup.targetHours = Number(e.target.value); daysNote.textContent = fmtDur(setup.targetHours * 3600000); markDirty(); } });
      const daysNote = h('span', { class: 'hint' }, fmtDur(setup.targetHours * 3600000));
      clear(settingsCard,
        h('h3', null, 'Settings for this channel'),
        setup.sortId
          ? settingsForm({ settings, values: setup.values, globals: store.globals, onChange: v => { setup.values = { ...setup.values, ...v }; markDirty(); } })
          : h('p', { class: 'dim small' }, 'Assign a sort to see its settings.'),
        h('h3', null, 'Lineup'),
        h('div', { class: 'row' },
          h('label', { class: 'field' }, h('span', { class: 'lab' }, 'Lineup length (hours)'), hours, daysNote),
          h('div', null,
            h('label', { class: 'check', style: { marginTop: '18px' } },
              h('input', { type: 'checkbox', checked: setup.alignStart, onchange: e => { setup.alignStart = e.target.checked; markDirty(); } }),
              'Start the lineup at the preview\'s start time'),
            h('span', { class: 'dim small' }, 'On Apply, sets the channel\'s start time so the first item plays when the preview says. Tunarr loops the lineup when it runs out.'))),
      );
    }

    await drawSort();
  }


  // ---------- quick rebuild ----------
  async function rebuildNow(c) {
    if (c.id === store.selectedChannelId && removeFlusher) await removeFlusher.flush();
    const r = await quickRebuild(findChannel(c.id) || c);
    if (!r) return;
    await loadChannels(true);
    drawList();
    if (c.id === store.selectedChannelId && store.channelTab === 'lineup') drawDetail();
  }

  // ---------- channel management ----------
  async function refreshChannels(selectId) {
    await loadChannels(true);
    if (selectId !== undefined) selectChannel(selectId);
    drawList();
    await drawDetail();
  }

  /** New channel (ch = null), edit basics (ch), or copy (ch, copy = true). */
  async function editBasics(ch, copy = false) {
    const isNew = !ch;
    const all = store.channels || [];
    // Groups, most used first.
    const counts = new Map();
    for (const c of all) if (c.groupTitle) counts.set(c.groupTitle, (counts.get(c.groupTitle) || 0) + 1);
    const groups = [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a) || a.localeCompare(b));
    const NEW_GROUP = '\u0000new';
    const startGroup = isNew ? (groups[0] || '') : (ch.groupTitle || '');

    const name = h('input', { type: 'text', value: isNew ? '' : copy ? ch.name + ' (copy)' : ch.name, placeholder: 'Saturday Morning Cartoons' });
    const groupSelect = h('select', null,
      groups.map(g => h('option', { value: g, selected: g === startGroup }, g + ' (' + counts.get(g) + ')')),
      h('option', { value: NEW_GROUP, selected: !groups.length }, '+ New group…'));
    const newGroup = h('input', { type: 'text', placeholder: 'New group name', hidden: groups.length > 0 });
    const number = h('input', { type: 'number', min: 1, max: 9999, step: 1, value: isNew || copy ? '' : String(ch.number) });
    const numberHint = h('span', { class: 'hint' });
    let numberTouched = !isNew && !copy; // editing: keep the channel's own number unless changed

    const groupValue = () => (groupSelect.value === NEW_GROUP ? newGroup.value.trim() : groupSelect.value);
    const checkTaken = () => {
      const n = Number(number.value);
      const clash = all.find(c => c.number === n && (!ch || copy || c.id !== ch.id));
      if (clash) { numberHint.textContent = 'Taken by ' + clash.name + '.'; numberHint.className = 'hint err-text'; return; }
      if (numberHint.classList.contains('err-text')) { numberHint.textContent = ''; numberHint.className = 'hint'; }
    };
    let seq = 0;
    const suggest = async () => {
      if (numberTouched) return;
      const mine = ++seq;
      const q = new URLSearchParams();
      if (copy) q.set('after', ch.id);
      else q.set('group', groupSelect.value === NEW_GROUP ? '' : groupSelect.value);
      try {
        const r = await api('GET', '/api/channels/next-number?' + q);
        if (mine !== seq || numberTouched) return;
        number.value = String(r.number);
        numberHint.textContent = 'Suggested: ' + r.reason + '.';
        numberHint.className = 'hint';
      } catch { /* leave it for the user */ }
    };
    groupSelect.onchange = () => {
      newGroup.hidden = groupSelect.value !== NEW_GROUP;
      if (!newGroup.hidden) newGroup.focus();
      suggest();
    };
    number.oninput = () => { numberTouched = true; numberHint.textContent = ''; checkTaken(); };
    suggest();

    const title = isNew ? 'New channel' : copy ? 'Copy ' + ch.name : 'Edit ' + ch.name;
    modal({
      title,
      body: h('div', null,
        isNew ? h('p', { class: 'dim small' }, 'Creates an empty channel in Tunarr with its default settings. It starts with no shows: see "Adding shows" below.') : null,
        copy ? h('p', { class: 'dim small' }, "Tunarr copies the channel's settings and lineup. Its sort and setting values in Schedule Lab are copied too.") : null,
        h('label', { class: 'field' }, h('span', { class: 'lab' }, 'Name'), name),
        h('div', { class: 'row' },
          h('div', { class: 'field' }, h('span', { class: 'lab' }, 'Group'), groupSelect, newGroup),
          h('label', { class: 'field' }, h('span', { class: 'lab' }, 'Number'), number, numberHint)),
        isNew ? h('p', { class: 'dim small' }, h('b', null, 'Adding shows: '),
          'for now, add programming to the new channel in Tunarr (its Programming page). Schedule Lab then sorts whatever the channel has. The next update (pool sources) lets you pick shows, seasons and library rules right here.') : null),
      actions: [
        { label: 'Cancel', kind: 'ghost' },
        { label: isNew ? 'Create channel' : copy ? 'Copy channel' : 'Save', kind: 'primary', onClick: async () => {
          if (groupSelect.value === NEW_GROUP && !newGroup.value.trim()) { toast('Type a name for the new group.', 'warn'); newGroup.focus(); return false; }
          const body = { name: name.value, number: number.value === '' ? undefined : Number(number.value), groupTitle: groupValue() };
          try {
            let result;
            if (isNew) result = await api('POST', '/api/channels', body);
            else if (copy) result = await api('POST', '/api/channels/' + encodeURIComponent(ch.id) + '/copy', body);
            else result = await api('PUT', '/api/channels/' + encodeURIComponent(ch.id) + '/basics', body);
            toast((isNew ? 'Created ' : copy ? 'Copied to ' : 'Saved ') + result.number + ' ' + String(result.name).trim() + '.', 'ok');
            await refreshChannels(isNew || copy ? result.id : ch.id);
            return true;
          } catch (err) { toast(err.message, 'err'); return false; }
        } },
      ],
    });
    setTimeout(() => name.focus(), 0);
  }

  async function removeChannel(ch) {
    const ok = await confirmDialog({
      title: 'Delete channel',
      message: 'Delete ' + ch.number + ' ' + ch.name + " from Tunarr?\n\nIts settings and lineup are saved first, so you can recreate it later from \"Deleted channels\" (with the same id, so its Schedule Lab setup and watch history come back too). TV apps will drop the channel until then.",
      confirmLabel: 'Delete channel',
      danger: true,
    });
    if (!ok) return;
    try {
      await api('DELETE', '/api/channels/' + encodeURIComponent(ch.id));
      forgetChannelData(ch.id);
      toast('Deleted ' + ch.name + '. It can be recreated from "Deleted channels".', 'ok', 8000);
      await refreshChannels('');
    } catch (err) { toast(err.message, 'err'); }
  }

  async function showArchive() {
    const rows = await api('GET', '/api/channels/archive').catch(err => { toast(err.message, 'err'); return null; });
    if (!rows) return;
    const close = modal({
      title: 'Deleted channels',
      wide: true,
      body: rows.length
        ? h('table', { class: 'grid' },
            h('thead', null, h('tr', null, ['Channel', 'Deleted', 'Lineup', ''].map(t => h('th', null, t)))),
            h('tbody', null, rows.map(r => h('tr', null,
              h('td', null, r.number + ' ' + r.name),
              h('td', { class: 'small' }, fmtAgo(r.deletedAt)),
              h('td', { class: 'small mono' }, r.itemCount + ' items'),
              h('td', { class: 'actions' }, r.recreatedAt
                ? h('span', { class: 'dim small' }, 'recreated ' + fmtAgo(r.recreatedAt))
                : h('button', { class: 'btn small', onclick: e => busy(e.currentTarget, async () => {
                  const back = await api('POST', '/api/channels/archive/' + r.id + '/recreate');
                  toast('Recreated ' + back.number + ' ' + String(back.name).trim() + ' with ' + back.itemCount + ' items.', 'ok');
                  close();
                  await refreshChannels(back.id);
                }) }, 'Recreate'))))))
        : h('p', { class: 'dim' }, 'No channels have been deleted from Schedule Lab.'),
    });
  }

  drawList();
  await drawDetail();
  // Leaving the screen: save anything pending.
  return () => { if (removeFlusher) { removeFlusher.flush(); removeFlusher(); } };
}
