# Schedule Lab 2.0

Schedule Lab builds and applies episode lineups for Tunarr channels. Version 1.8 is a
single HTML page (`tunarr-schedule-labV1.8.html`); 2.0 turns it into a Dockerized web app.
Full plan: the "Schedule Lab 2.0 Plan" doc on claude.ai (see the owner's artifacts).

## Environment
- Tunarr 1.3.15, running in Docker on a separate server at http://192.168.1.197:8000.
  API spec: save `http://192.168.1.197:8000/openapi.json` into `docs/` and read it
  before calling any endpoint.
- Schedule Lab runs in its own Docker container on a different server and reaches Tunarr
  by IP over the LAN (no shared Docker network).
- Home network only. No login. Never exposed to the internet.

## Decisions
- Server: Node.js + TypeScript. Storage: SQLite in a mounted `/data` volume.
- Only required config: `TUNARR_URL`. Web UI on port 8765.
- The browser talks only to Schedule Lab; the server makes all Tunarr calls (this removes CORS).
- NO hard-coded sorts. Sorts are created in a Sort Builder, saved to a Sort Library, and
  assigned per channel. Each channel stores its own values for the sort's settings.
- A sort = name, description, declared settings with defaults, and `run(ctx)` code
  (same contract as 1.8). Saved versions are kept, and a channel stays on its version
  until it's moved up.
- Setting types: number, text, yes/no, choice, `weekly hours` (a week grid, stored like
  `Mon,Tue,Thu,Fri 08:00-16:30; Sat 07:00-15:30`) and filler list.
- No separate Routines tool. Work and sleep hours are `weekly hours` settings of the sorts
  that use them. Anything that varies by day is also handled through a sort's settings.
- Helpers for sorts: `ctx.utils.hours(setting)` -> `isInside(t)` and `fractionInside(a, b)`;
  `ctx.history.watched(id)` and `ctx.history.lastAired(id)` (2.1).
- Custom sort code runs sandboxed on the server with a 10 s limit and no network or file access.
- Import button loads the 1.8 sorts as ordinary library entries: no-repeat shuffle, full
  cycle, time-block insert, AI optimizer (API key is a setting) and the work-schedule
  sort (`work-schedule-sort.js`).
- Up to 64 channels. Each channel has its own rebuild timetable. Jobs run from one queue,
  1-2 at a time, spread across an overnight window.

## Tools (screens)
Channels, Sort Builder, Sort Library, Preview & Compare, Apply & History, Watch Tracker,
Automations, Settings (global settings and global variables).

## Releases
- **2.0** (tag v2.0.0, done):
  - Docker container and compose file; server-side Tunarr client.
  - Split UI; Sort Builder and Library; per-channel sort and settings; Import.
  - Apply with backup first, undo/restore. Settings screen and global variables.
- **2.1** (in progress, 2.1.0-beta.N):
  - Watch Tracker and `ctx.history` (done in 2.1.0-beta.1).
  - AI settings (Anthropic, OpenRouter, Ollama), channel management, guide check (done in 2.1.0-beta.2).
  - New-channel dialog: group dropdown, group-aware number suggestions (done in 2.1.0-beta.3).
  - Pool sources + library rules (done in 2.1.0-beta.4).
  - Channel Builder (done in 2.1.0-beta.5; picks shows/movies only, no rules).
  - Channels "+ New" opens the Channel Builder (2.1.0-beta.6).
  - Coded Automations + Automation Library; library rules moved out of the Pool card (Convert button)
    into the "Add new matching shows" automation (done in 2.1.0-beta.7).
  - Builder step 4 adds automations; smart collections and single episodes as pool sources; AI call
    count in run logs; fix for the Settings screen not loading in beta.7 (2.1.0-beta.8).
  - Add new matching shows: skips shows already on the lineup (pool.get onChannel); the first add on a
    channel without sources turns its lineup shows into sources (sourcesFromItems); re-importing starters
    updates unedited ones as a new version (2.1.0-beta.9).
  - Pool card "+ From lineup" and ctx.pool.fromLineup() (addLineupToPool) (2.1.0-beta.10).
  - 2.1.0 = the owner has tested all of 2.1 on the server.
  - Full 2.1 plan: the claude.ai plan doc, section "2.1 plan". Library search is
    `POST /api/programs/search` (filter on e.g. `studio.name`, `genres.name`, `type`; facets via
    `POST /api/programs/facets/{field}`); the show's network is `studio.name` on show records.
- **2.2**: filler and channel immersion: filler padding with `flex` lineup items, dynamic
  bumpers, and similar things that make a channel feel like real TV.
- **2.3**:
  - Checks across channels (`/api/channels/all/lineups`).
  - `append: true` applies; export as a Tunarr time-slot schedule.

## Versioning (Claude does this, unasked)
- Every push to `main` that changes what the owner sees or runs gets a version bump in
  `package.json` (`npm version <v> --no-git-tag-version`), shown in the app's top bar.
- Semver: patch for fixes, minor for a finished release (2.1.0), `-beta.N` while a
  release is still in progress. After pushing, tag it (`git tag vX.Y.Z && git push --tags`);
  GitHub Actions publishes `ghcr.io/yolego23/tunarr-schedule-lab:X.Y.Z` (and `:latest` from main).
- CI fails a tag that doesn't match `package.json`.

## Code layout (2.0 built)
- Node 24 runs `src/*.ts` directly (type stripping, no build). `npm run dev` (reads `.env`),
  `npm test`, `npm run typecheck`. Local dev uses port 8766; 8765 is often the 1.8 `lab-server.py`.
- `src/tunarr.ts` is the only module that calls Tunarr. `src/sandbox/` runs sort code in a
  child process (`--permission`) inside a `DONT_CONTEXTIFY` vm context; only strings cross.
- `test/ui-syntax.test.ts` runs `node --check` on every browser file (no build step, so a syntax
  error otherwise only shows when a screen is opened). Write patch scripts to files (not bash
  heredocs): Git Bash heredocs mangled `\\'` and `\\n` escapes and broke a screen once.
- `src/shared/*.js` (weekly hours, settings parser, analysis) is shared by server, browser
  (served at `/shared/`) and sandbox (loaded as a script, `export ` stripped), so no imports there.
- UI is plain ES modules in `public/js` (no framework, no bundler).
- Previews live in server memory; Apply writes exactly the stored preview.
- Settings screen: global settings in `app_settings` (`src/app-settings.ts`, validated) and
  global variables in `global_vars` (`src/globals.ts`). Sorts get `ctx.globals`; a channel
  setting value `{ "$global": "name" }` links to a variable (resolved in `resolveValues`).
- Watch Tracker (`src/watch.ts`): polls `/api/sessions` + `/now_playing` every 60 s; an airing
  that streams `minMinutes` (default 5) is recorded in `watch_events` (newest `keepPerEpisode`,
  default 5, per channel+episode) and `watch_totals` (running count, last watched). No device data
  is stored. Tunarr 1.3.15 has no viewing history of its own (checked all endpoints and logs).
  Sorts get it via `ctx.history` (`historyForSort`); Automations should use the same functions.
- AI (`src/ai.ts`): providers anthropic (SDK) / openrouter / ollama (OpenAI-compatible fetch), config in
  app_settings key `aiConfig` (keys never returned to the browser), `ai_usage` log + monthly cap. Sandbox
  code reaches it only through a caller-supplied bridge (`runSort(..., { bridge })`): `ctx.ai.ask`,
  legacy `ctx.utils.claude`. AI is never required (owner's rule).
- Channel management (`src/channel-admin.ts`): create/copy/basics/delete; delete archives channel JSON +
  lineup in `channel_archive`; recreate uses the same id. Guide check (`src/guide-check.ts`) compares
  expectations saved on apply/restore with `/api/guide/channels/{id}` and the XMLTV file.
- Pool sources (`src/pool.ts`): `channel_setup.pool_json` = { sources, exclusions }. Kinds: show, season,
  movie, episode (all via `/api/programs/{id}/descendants`), custom_show, smart_collection (its saved
  filter + keywords through search, then descendants), rule (search, then descendants).
  Tunarr search pages are 0-based. Items get `weight` (max of sources) and `sources`; sorts decide use.
  With sources, `getChannelData` builds `pool` from them; `lineupItems` keeps lineup episodes not in it.
- Channel Builder (`src/builder.ts`, `public/js/views/channel-builder.js`): previews a draft with
  `/api/run` channelId `draft` + `pool` (no channel yet); `/api/builder/create` creates the channel,
  saves setup, and applies that draft preview (`applyPreview(..., { adoptDraft: true })`). Optional AI
  tasks: basics, shows (from the whole library catalog), settings; feature 'builder'.

- Automations (`src/automations.ts`, starters in `src/automation-presets.ts`): tables automations,
  automation_versions, channel_automations (assignment: version, values, timetable, enabled, next_run_at),
  automation_runs (queue + history, status queued/running/applied/done/skipped/failed), pool_suggestions.
  Sandbox: `runAutomation` with `bootstrap-automation.js` (no sort slot; builds run sorts through
  `runPreview`, which takes the slot). Everything goes through the bridge in `makeBridge`, which enforces:
  own channel only, apply via `applyPreview` (backup), once per run, not empty, `minLengthPercent`
  (default 50) of min(current duration, targetHours); dry runs only record changes. Timetables are local
  server time; no set time = hashed spot in the window. Tick every 60 s; retries only for "Can't reach
  Tunarr" and only if nothing changed yet. Deleting a channel turns its automations off; copying copies them.

## Tunarr API notes (1.3.15)
- Lineup write: `POST /api/channels/{id}/programming` with `{type:"manual", lineup:[...], append?}`.
  Item types: content, custom, filler, redirect, flex. `time` and `random` slot schedules are also accepted.
- Read: `GET /api/channels/{id}/programming`, `/lineup`, `/programs`.
- `GET /programming` returns `lineup` (ids + durations) and a `programs` map (metadata under
  `.program`; show title `.program.show.title`, titles like `Show - S01E21-E22 - A + B`).
  Existing channels were generated by Tunarr random slot schedules (`schedule` field).
- Playback position = (now - channel.startTime) mod lineup duration; Apply PUTs `startTime`.
- Guide refresh doesn't work in Tunarr 1.3.15 (owner tested `POST /api/xmltv/refresh`), so the app
  has no guide refresh; Tunarr rebuilds the guide on its own schedule.
- The 1.8 page's guide-refresh endpoints (`/api/debug/helpers/build_guide`, `/refresh`,
  `/reload`) don't exist either.
