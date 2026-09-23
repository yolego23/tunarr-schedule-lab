# Writing Schedule Lab sorts and automations: a guide for LLMs

You are writing code for **Schedule Lab**, a web app that builds and applies
episode lineups for **Tunarr** channels (Tunarr turns a media library into
live-TV channels). The user pastes your code into the app, tests it, and saves
it to a library. Read this whole guide before writing code; everything the code
can use is listed here, and nothing else exists.

There are two kinds of code:

| | A **sort** | An **automation** |
|---|---|---|
| Question it answers | "In what order should these episodes play?" | "When and how should this channel change?" |
| Entry point | `function run(ctx)` returns an array (the new lineup) | `async function run(ctx)` does things through `ctx` |
| Runs | when someone builds a preview or rebuild | on a timetable, or by hand (Run now / Dry run) |
| Changes Tunarr? | never (the app applies its result later) | yes, but only through `ctx.apply` / `ctx.pool.*`, with safety checks |
| Where the user edits it | Sort Builder | Automations → editor |

If the user's idea is about ordering (repeats, time of day, weights, work
hours), write a **sort**. If it's about *when* to rebuild, choosing between
lineups, reviewing them, or growing the pool, write an **automation** (which
usually runs the channel's sort through `ctx.build()`).

---

## 1. Rules for both

**Language.** Plain modern JavaScript (ES2022). Not TypeScript. No `import`,
`require`, `fetch`, `XMLHttpRequest`, timers (`setTimeout`), file or network
access; they don't exist in the sandbox. `Math`, `Date`, `JSON`, `Map`, `Set`,
`Array`, `String`, `Intl` and `console.log` work. Define helpers as ordinary
functions in the same code.

**Limits.**
- Sorts: 10 seconds of CPU (a setting), 512 MB, 5 minutes in total.
- Automations: 60 seconds of their own CPU (a setting), 512 MB, 20 minutes in total.
- Time spent waiting on the host (AI answers, building lineups, applying) doesn't count toward the CPU limit.
- Keep the work roughly linear in the pool size (pools can hold 10,000+ episodes). Avoid nested loops over the whole pool.

**Output.** Put the settings block first, then `run`. Give the user **one code
block** with the complete code, followed by a short list of the settings and
how to test it (see section 6).

### The settings block

Settings become form fields. Each channel stores its own values, and a value
can be linked to a global variable (the user does that in the UI). Declare them
in a comment at the very top:

```js
/* @settings
seed: number = 1                              // Random seed
repeatWindowHours: number = 72                // Don't repeat an episode within (hours)
mode: choice(shuffle, in-order, weighted) = shuffle   // Order
workHours: weekly hours = Mon-Fri 08:00-16:30 // Work hours (nobody watching)
favourites: text = Adventure Time, Regular Show       // Favourite shows, comma separated
useAi: yes/no = no                            // Ask the AI
apiKey: secret =                              // API key (optional)
bumpers: filler list =                        // Filler list
*/
```

- **Format:** one setting per line, `key: type = default // Label`.
  - The label is optional, but write one: it's what the user sees.
  - The label must be preceded by a space and `//`.
  - Keys are JavaScript identifiers.
- **Types and what `ctx.params.key` holds:**

  | Type | Value | Notes |
  |---|---|---|
  | `number` | number | empty = 0 |
  | `text` | string | parse lists yourself: `s.split(',').map(x => x.trim()).filter(Boolean)` |
  | `secret` | string | shown as a password field |
  | `yes/no` | boolean | |
  | `choice(a, b, c)` | one of the options (string) | the default must be one of them |
  | `weekly hours` | string like `Mon,Tue,Thu,Fri 08:00-16:30; Sat 07:00-15:30` | pass it to `ctx.utils.hours()`; may be `''` |
  | `filler list` | a Tunarr filler list id (string) or `''` | sorts can't read filler contents yet; don't rely on it |

- **Parsing rules.** Unknown types, duplicate keys and unreadable lines are
  errors, and the user can't save. Don't put `*/` inside the block.
- **Seeds.** If the code uses randomness, declare `seed: number = 1` and
  seed everything from it (`ctx.utils.makeRng(ctx.params.seed)`).
  Compare and "Build N, keep the best" vary `seed` to make different
  candidates, and automations pass `ctx.build({ seed })`. **Never use
  `Math.random()` in a sort.** It makes candidates impossible to reproduce.

### Weekly hours text (for defaults)

Blocks are separated by `;` or new lines. For example:

- `Mon-Fri 08:00-16:30`
- `Mon,Wed 06:00-07:00, 17:00-18:00`
- `Daily 22:30-06:00` (an end at or before the start runs overnight)
- `Weekends 09:00-12:00`
- `22:30-06:00` (no days = every day)

Times are in the server's local time zone.

---

## 2. Sorts

```js
function run(ctx) {              // may be `async function` if it awaits ctx.ai.ask
  return [ /* items from ctx.pool or ctx.current, in play order */ ];
}
```

### What `ctx` has

| Name | What it is |
|---|---|
| `ctx.pool` | Array of episodes this channel may play (from its pool sources, or its current lineup if it has none). **Return these objects.** |
| `ctx.current` | The channel's current lineup, in order (pool episodes are the same objects as in `ctx.pool`; other entries are flex/redirect/filler or episodes no longer in the pool) |
| `ctx.currentPlayingIndex` | Index in `ctx.current` of what's playing now |
| `ctx.params` | This channel's values for the declared settings |
| `ctx.targetMs` | How long the new lineup should run (ms) |
| `ctx.scheduleStartMs` | When the first returned item will start (epoch ms); `ctx.scheduleStart` is the same as an ISO string |
| `ctx.channel` | `{ id, name, number }` |
| `ctx.globals` | Global variables by name (read-only) |
| `ctx.history` | Watch Tracker data (below) |
| `ctx.utils` | Helpers (below) |
| `ctx.ai` | `{ available, ask }`, the user's AI (below) |

**An episode (item of `ctx.pool`):**

```js
{
  id: 'uuid',                 // Tunarr program id
  type: 'content' | 'custom', // 'custom' = from a Tunarr custom show
  title: 'The Froggy Apple Crumple Thumpkin',
  showTitle: 'Chowder',
  seasonNumber: 1, episodeNumber: 1,   // may be undefined (movies, odd titles)
  episodeLabel: 'S01E01' | null,
  durationMs: 1373994,
  programType: 'episode' | 'movie' | ...,
  year: 2007, releaseDate: 1194000000000,  // may be undefined
  showId: 'uuid', seasonId: 'uuid',        // may be undefined
  weight: 1,        // highest weight of the pool sources that include it (default 1)
  sources: ['Chowder'],   // labels of those pool sources
}
```

Group by `showTitle` (always set) rather than `showId` (can be missing).
`weight` is a number the user sets per source. Use it only if the sort is
meant to; for example, pick shows in proportion to weight.

### What to return

- **Items:** an array of item objects, in play order. Each one must be:
  - an object from `ctx.pool` or `ctx.current` (the same object is fine, and so is returning it many times, since repeats are allowed); or
  - a flex (dead air or filler) block: `{ type: 'flex', durationMs: 600000 }` with a positive `durationMs`.
- **Length:** the total `durationMs` should be about `ctx.targetMs`. The app shows the length, and automations refuse lineups far shorter than the channel's usual length. Add items until the running total reaches `ctx.targetMs`, and cycle through the pool again if it's shorter than the target. Tunarr loops the lineup when it ends.
- **Not allowed:** anything else throws "is not from ctx.pool or ctx.current". Items are matched by `id` (and lineup entries by their place in `ctx.current`), so an object you made up fails. A copy (`{...item}`) passes, but any fields you change on it are ignored. Return the originals.
- **Maximum:** 200,000 items.
- **Return value:** returning a non-array is an error. An empty array is allowed, but the app won't apply it.

### Helpers (`ctx.utils`)

| Helper | Does |
|---|---|
| `makeRng(seed)` | Seeded random function returning numbers in [0, 1) |
| `shuffle(array, rng)` | New shuffled copy (doesn't change the input) |
| `hours(spec, { padMinutes }?)` | Weekly-hours checker. `spec` is weekly hours text, an array of them (union), or `{ hours, padMinutes }`. Returns `{ isInside(t), fractionInside(a, b), msInside(a, b), errors }`; times are epoch ms |
| `scoreSchedule(list)` | `{ maxConsecutiveSameShow, distinctShows, count }` for an item list |
| `claude({ apiKey?, prompt, system?, model?, maxTokens? })` | Older Anthropic-only call, kept for 1.8 sorts; prefer `ctx.ai.ask` |

### Watch history (`ctx.history`)

Episode ids are `item.id`.

- `lastWatched(id)`: epoch ms of the last time someone watched it on this channel, or `null`.
- `watchCount(id)` (alias `watched(id)`): how many times it was watched on this channel.
- `watches(id)`: the newest watches, `[{ at, minutes }]`.
- `lastAired(id)`: when it last started airing on this channel's current lineup, or `null`.
- Add `{ anyChannel: true }` as a second argument to count every channel (`watches` then also has `channelId`).

Watched means it streamed at least 5 minutes (a setting). Episodes nobody
watched return `null` or `0`, so treat "never watched" as the normal case.

### AI (`ctx.ai`)

`ctx.ai.available` is `true` only if the user set up AI (Anthropic, OpenRouter
or Ollama) **and** allowed it for sorts. `await ctx.ai.ask(prompt)` or
`await ctx.ai.ask({ prompt, system, model, maxTokens })` returns the answer
**text**, and throws if AI isn't available.

- The user must never *need* AI. Make it an opt-in setting (`useAi: yes/no = no`) and always have a non-AI path.
- Wrap the call in `try/catch` and fall back if it fails or the answer can't be parsed.
- Keep prompts small: send show titles and counts, not the whole pool.
- Ask for JSON and extract it with `answer.match(/\{[\s\S]*\}/)` or `/\[[\s\S]*\]/`.
- AI calls cost the user money (except on Ollama). Make **one** call per run, not one per episode.

### Time of day

The lineup plays back to back from `ctx.scheduleStartMs`. To know when an item
airs, keep a running clock:

```js
let t = ctx.scheduleStartMs;
for (const item of result) { /* item airs from t to t + item.durationMs */ t += item.durationMs; }
```

The same clock is how you place shows in time blocks, or use
`hours.isInside(t)` / `fractionInside(t, t + d)` to treat work or sleep hours
differently (for example, put reruns or filler there and keep new episodes for
when someone's home).

### Example sort: weighted no-repeat shuffle

```js
/* @settings
seed: number = 1                     // Random seed
repeatWindowHours: number = 48       // Don't repeat an episode within (hours)
maxInARow: number = 2                // Most episodes of one show in a row
useWeights: yes/no = yes             // Favour sources with a higher weight
*/
function run(ctx) {
  const { pool, params, targetMs, scheduleStartMs, utils } = ctx;
  if (!pool.length) return [];
  const rng = utils.makeRng(Number(params.seed) || 1);
  const windowMs = Math.max(0, params.repeatWindowHours) * 3600000;
  const lastAt = new Map();             // id -> when it last started in this lineup
  const result = [];
  let t = scheduleStartMs, streakShow = null, streak = 0;

  // Pick by weight among the episodes that are allowed right now.
  const weightOf = it => (params.useWeights ? Math.max(0, it.weight ?? 1) : 1);
  const pick = candidates => {
    const total = candidates.reduce((a, it) => a + weightOf(it), 0);
    if (total <= 0) return candidates[Math.floor(rng() * candidates.length)];
    let r = rng() * total;
    for (const it of candidates) { r -= weightOf(it); if (r <= 0) return it; }
    return candidates[candidates.length - 1];
  };

  while (t - scheduleStartMs < targetMs) {
    const streakOk = it => !(it.showTitle === streakShow && streak >= params.maxInARow);
    const fresh = it => !lastAt.has(it.id) || t - lastAt.get(it.id) >= windowMs;
    // When the pool is small, relax the repeat window first, then the streak rule.
    let ok = pool.filter(it => fresh(it) && streakOk(it));
    if (!ok.length) ok = pool.filter(streakOk);
    if (!ok.length) ok = pool;
    const next = pick(ok);
    result.push(next);
    lastAt.set(next.id, t);
    streak = next.showTitle === streakShow ? streak + 1 : 1;
    streakShow = next.showTitle;
    t += next.durationMs || 0;
  }
  console.log(`Built ${result.length} items`);
  return result;
}
```

This example filters the whole pool for every item, which is fine for a few
thousand episodes. For very large pools, pre-group episodes by show and pick a
show first.

### Sort checklist

- [ ] Settings block first; every setting has a label; `seed` if random.
- [ ] Returns original objects from `ctx.pool` / `ctx.current`, or `{ type: 'flex', durationMs }`.
- [ ] Fills about `ctx.targetMs`, and handles an empty or tiny pool without looping forever. Every loop must add time or stop.
- [ ] No `Math.random()`, no `Date.now()` for ordering (use `ctx.scheduleStartMs`).
- [ ] Optional AI with a fallback; no network, imports or timers.
- [ ] `console.log` a one-line summary (it shows in the test log).

---

## 3. Automations

```js
async function run(ctx) {
  // look → decide → build/apply or change the pool, or ctx.skip(reason)
}
```

An automation is assigned to one channel, with its own settings values and a
timetable (daily, weekly, monthly, every N days or hours, or manual). Every
helper that touches the server is **async**, so `await` it.

### What `ctx` has

| Name | What it is |
|---|---|
| `ctx.channel` | `{ id, name, number }` of the channel it's assigned to |
| `ctx.params` | This channel's values for the declared settings |
| `ctx.globals`, `ctx.history`, `ctx.utils` | As in sorts (`utils` has no `claude`) |
| `ctx.dryRun` | `true` in a dry run (apply and pool changes are only reported) |
| `ctx.log(...)` | Writes to the run's log (so does `console.log`) |
| `await ctx.lineup.current(opts?)` | The channel now (below) |
| `await ctx.build(opts?)` | Runs a sort and returns a candidate lineup (below) |
| `ctx.score(candidate)` | The candidate's score (number, higher is better) or `null` |
| `await ctx.apply(candidate, { alignStart? }?)` | Applies it to this channel |
| `await ctx.skip(reason)` | Marks the run "skipped" with a reason; use `return ctx.skip('...')` |
| `ctx.ai.available`, `await ctx.ai.ask(...)` | As in sorts, but allowed separately for automations |
| `await ctx.library.search(rule)` | Shows/movies in the library matching a rule |
| `await ctx.pool.get()` | This channel's pool definition |
| `await ctx.pool.add(source)` | Adds a pool source |
| `await ctx.pool.suggest(source, reason)` | Lists a source for the user to approve |
| `await ctx.pool.exclude(item)` | Excludes a show, season or episode |
| `await ctx.pool.fromLineup({ weight? }?)` | Adds the shows on the lineup as pool sources |
| `await ctx.channels.list()` / `get(id)` | Read-only view of every channel |

Whatever `run` returns (made JSON-safe) is saved with the run as "Returned".

### The channel now: `ctx.lineup.current({ items?: true })`

```js
{
  itemCount, durationMs,           // current lineup
  startTime,                       // epoch ms the lineup started
  targetHours,                     // the channel's lineup length setting
  playingIndex,                    // what's playing now
  remainingMs, daysLeft,           // until the lineup reaches its end and loops
  lastAppliedAt,                   // last successful apply (any source) or null
  poolEpisodes,                    // episodes in the pool
  items: [{ id, type, durationMs, showTitle, title, episodeLabel }]  // only with { items: true }
}
```

### Building: `ctx.build(opts)`

Runs the channel's own sort, version and settings unless you override them:

- `seed: n` sets the sort's `seed` setting (use different seeds to get different candidates).
- `params: { key: value }` overrides other settings for this build only.
- `hours: n` sets the lineup length (default: the channel's).
- `sort: sortId` and `version: n` use a different library sort.

It returns a **candidate**:

```js
{
  id, label, sortId, sortVersion,
  items,          // number of items
  durationMs, hours,
  score,          // { total, breakdown } from the user's scoring function
  metrics,        // { maxConsecutiveSameShow, distinctShows, count }
  shows,          // [{ show, count }], most first
  sequence,       // show titles in play order (first 500)
  logs, warnings, // from the sort
}
```

If the channel has no sort, `build()` throws (catch it and `skip`). Each run
can build at most **30** lineups.

### Applying: `ctx.apply(candidate)`

The app enforces these rules, whatever the code does:

- **Only this channel.** Only candidates built by `ctx.build()` in this run can be applied, and only to this channel.
- **Once per run.** A second call throws.
- **Backed up first.** The user can undo it on History or on the channel's Rebuild tab.
- **Never empty.**
- **Not too short.** Refused if the candidate is shorter than `minLengthPercent`% of min(current lineup length, the channel's lineup length). The default is **50** if the automation doesn't declare the setting. **Declare `minLengthPercent: number = 50`** in any automation that applies, so the user can change it per channel.
- **Not after a skip.** It throws if the run was skipped.
- **Dry run:** returns `{ ok: true, dryRun: true }` and is reported as "Would apply…". Otherwise it returns `{ ok: true, backupId, warnings }`.

`alignStart` defaults to the channel's setting (the lineup starts at build time).

### Library and pool

- **`ctx.library.search(rule)`** looks up the library.
  - The rule needs at least one condition. Fields: `{ networks: ['Cartoon Network'], genres: ['Animation'], ratings: ['TV-Y7'], tags: [], libraries: [libraryId], yearFrom, yearTo, addedWithinDays, text, types: ['show', 'movie'] }` (types defaults to shows).
  - It returns `[{ id, type, title, year, rating, episodes, seasons, libraryId, durationMs, summary }]`.
  - Network matching uses the library's studio/network field. A show tagged "Cartoon Network Studios" needs that exact name.
- **`ctx.pool.get()`** returns:
  - `sources: [{ id, kind, ref, label, weight }]`
  - `exclusions: [{ kind, id, label }]`
  - `suggestions: [{ ref, status }]`, where status is open, approved or dismissed
  - `onChannel: [ids]`, the ids of every show, season, custom show, movie and episode the channel has now, **including what's only on its lineup**. To test "does the channel already have this?", check `onChannel` as well as `sources`.
- **A source** is `{ kind: 'show' | 'season' | 'movie' | 'episode' | 'custom_show' | 'smart_collection', ref: '<Tunarr id>', label: 'Title (Year)', weight?: 1 }`.
  - For a search result, use `ref: hit.id` and `kind: hit.type === 'movie' ? 'movie' : 'show'`.
- **`ctx.pool.add(source)`** returns `{ added: true }` or `{ added: false, reason }`. It refuses anything already on the channel. On a channel with **no** pool sources, the first add turns the lineup's shows into sources first, so they aren't dropped (reported in the run).
- **`ctx.pool.suggest(source, reason)`** returns `{ suggested: true }` or `{ suggested: false, reason }`. It skips anything already on the channel or suggested before (a dismissed show is never suggested again). The user approves suggestions on the channel's Automations card. **Prefer suggest over add** unless the user asked for automatic adding (make it a `mode: choice(suggest, add)` setting).
- **`ctx.pool.exclude({ kind: 'show' | 'season' | 'item', id, label })`** returns `{ excluded }`.
- **Limit:** at most 200 pool changes per run.

### Other channels (read-only)

- **`ctx.channels.list()`** returns `[{ id, number, name, groupTitle, itemCount, durationMs, sortName, poolSources: [labels] }]`.
- **`ctx.channels.get(id)`** returns `{ id, name, number, itemCount, durationMs, poolEpisodes, shows: [{ show, episodes }], poolSources: [{ kind, ref, label, weight }] }`.

An automation can read any channel but can't change any channel except its own.

### AI in automations

This works the same as in sorts: opt-in, with `ctx.ai.available`, a fallback and at most **50** calls per run.
Summarise candidates (`shows`, `metrics`, the first ~20 of `sequence`) rather
than sending whole lineups. The run log records how many AI calls were made.

### Example automation: rebuild when running low, best of three

```js
/* @settings
minDaysLeft: number = 2              // Rebuild when fewer than this many days are left
candidates: number = 3               // Lineups to build and compare
minLengthPercent: number = 50        // Refuse a lineup shorter than this % of the usual length
*/
async function run(ctx) {
  const now = await ctx.lineup.current();
  if (now.daysLeft >= ctx.params.minDaysLeft) {
    return ctx.skip(`${now.daysLeft.toFixed(1)} days left; rebuilds below ${ctx.params.minDaysLeft}.`);
  }
  const n = Math.max(1, Math.min(10, ctx.params.candidates));
  let best = null;
  for (let i = 0; i < n; i++) {
    let c;
    try { c = await ctx.build({ seed: (Date.now() % 1e6) + i * 7919 }); }
    catch (e) { return ctx.skip('Could not build: ' + e.message); }
    ctx.log(`Candidate ${i + 1}: score ${ctx.score(c)?.toFixed(1)}, ${c.metrics.distinctShows} shows`);
    if (!best || ctx.score(c) > ctx.score(best)) best = c;
  }
  await ctx.apply(best);
  return { applied: best.label, score: ctx.score(best) };
}
```

(`Date.now()` is fine here. Automations choose seeds; sorts must not.)

### Automation checklist

- [ ] `async function run(ctx)` and every `ctx.*` helper is awaited, except `score`, `log`, `ai.available` and `dryRun`.
- [ ] Settings for every limit the user might tune (`minLengthPercent` if it applies, thresholds, add/suggest mode).
- [ ] `return ctx.skip(reason)` when there's nothing to do. Don't throw for normal "nothing to do" cases.
- [ ] Only one `ctx.apply` per run, of a candidate from `ctx.build()` in this run.
- [ ] Log what it decided and why, in short lines.
- [ ] Works (does something sensible) with AI off.

---

## 4. Common mistakes

| Mistake | Fix |
|---|---|
| Returning made-up objects, or editing fields on copies (`{...ep, durationMs: 5}`) expecting it to change the lineup | Return the original `ctx.pool` / `ctx.current` objects; only order and flex blocks are yours to decide |
| Lineup far shorter than `ctx.targetMs` (one pass over a small pool) | Cycle through the pool until the running total reaches the target |
| Infinite loop when every episode is excluded by a rule | Relax the rule (fall back to the whole pool) or stop |
| `Math.random()` in a sort | `ctx.utils.makeRng(ctx.params.seed)` |
| Forgetting `await` on automation helpers | Every server call returns a Promise |
| Treating only `pool.sources` as "on the channel" | Also check `pool.onChannel` (lineup-only shows) |
| Using `import`, `fetch`, `setTimeout`, `require` | Not available; use `ctx.ai.ask` for AI, nothing else leaves the sandbox |
| One AI call per episode | One call per run, with a compact summary |
| TypeScript types or JSX | Plain JavaScript only |
| A settings line like `name: string = x` | Types are `number`, `text`, `secret`, `yes/no`, `choice(...)`, `weekly hours`, `filler list` |

## 5. Before you write: ask if unclear

If the request leaves these open, ask (or state the assumption you made):

- Sort or automation (or an automation that runs a sort)?
- Which values the user will want to tune per channel. Make those settings, with sensible defaults.
- For automations: should it apply by itself, or only suggest? How often (the user sets the timetable in the app, but say what you'd recommend)?
- Should AI be involved at all? The default is no.

## 6. How the user tests it (tell them this after the code)

- **Sort:**
  1. Paste it into **Sort Builder**.
  2. **Run test** on the sample data or a real channel; the timeline, repeat ranking and log appear.
  3. **Save** to the library.
  4. Pick it on a channel's **Setup** tab.
  5. On the **Rebuild** tab, **Build preview**, check it, then **Apply** (backed up; Undo is right there).
- **Automation:**
  1. **Automations → + New automation**, paste it, pick a channel.
  2. **Dry run** (nothing changes; the run shows what it *would* change).
  3. Save.
  4. On the channel's **Automations** card, add it, set its settings and timetable, then do **Dry run** again before **Run now**.
