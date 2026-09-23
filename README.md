# Schedule Lab 2.0

Builds and applies episode lineups for Tunarr channels. It runs as one Docker
container on your home network and makes every Tunarr call from its own
server, so there are no browser CORS problems and no `lab-server.py`.

## Run it

On the Docker server, copy `docker-compose.yml` into a folder and run:

```bash
docker compose pull && docker compose up -d
```

The image `ghcr.io/yolego23/tunarr-schedule-lab:latest` (amd64 and arm64) is
built and published by GitHub Actions on every push to `main`, after the tests
pass. Each release is also published under its version number (for example
`:2.0.0` or `:2.1.0-beta.1`); put that in place of `latest` in
`docker-compose.yml` to pin a version or roll back. The version running is
shown next to the name in the app's top bar. To build locally instead, run
`docker compose up -d --build` from a checkout.

To update later: `docker compose pull && docker compose up -d`.

Then open `http://<that-server>:8765/`. The only required setting is
`TUNARR_URL` in `docker-compose.yml` (now `http://192.168.1.197:8000`). Set
`TZ` to your time zone too: work and sleep hours are read in it.

Data lives in the `schedule-lab-data` volume (`/data/schedule-lab.db`), so
rebuilding or updating the container keeps it. **Export** in the top bar saves
everything to one JSON file; **Import** loads it on another machine.

Keeping your data across updates:
- Always update from the same folder (or the same Portainer stack). Compose
  names the volume after the project, e.g. `schedule-lab_schedule-lab-data`,
  so a different folder name means a different, empty volume.
- Don't use `docker compose down -v`: `-v` deletes the volume.
- The Settings screen shows the database file and the volume it's on, and a
  red banner appears if `/data` isn't on a volume. The container log prints
  how many sorts and channel setups it found at startup.
- Check what exists with `docker volume ls | grep schedule-lab`.

Channel settings save automatically as you change them.

Home network only: there is no login. Don't forward port 8765 on your router;
use a VPN to reach it from outside.

## First steps

1. **Sort Library → Import 1.8 sorts** loads no-repeat shuffle, full cycle,
   time-block insert, AI optimizer and the work-schedule sort as ordinary,
   editable entries. The app has no built-in sorts.
2. **Channels**: pick a channel, choose its sort, fill in that channel's
   settings (work hours are painted on a week grid) and the lineup length.
   Changes save automatically.
3. **Preview & Compare**: run the channel's sort (or several sorts, several
   seeds each) and rank the candidates. Pick one → **Send to Apply**.
4. **Apply & History**: Apply backs up the current lineup first (last 20 per
   channel), writes the new one, and sets the channel start time. **Undo last change** or **Restore** any backup.
5. **Settings**: defaults for new channels, preview defaults and repeat
   colours, backups kept per channel, the sort time limit, and **global
   variables**.

## Watch Tracker

Tunarr keeps no viewing history, so Schedule Lab records its own. Every minute
it checks which channels have an open stream and what they're playing. An
episode that streams for 5 minutes (a setting) is marked as watched on that
channel, with the date and time and how many minutes were streamed. The
newest 5 watches per episode per channel are kept (a setting; there's also an
optional age limit), and a total watch count keeps counting. Nothing about
devices is stored. It can't tell who is watching, or whether anyone is: an
open stream counts.

Sorts read it through `ctx.history`: `lastWatched(id)`, `watchCount(id)`,
`watches(id)` (newest first, `{ at, minutes }`), with `{ anyChannel: true }`
for all channels, plus `lastAired(id)` from the channel's lineup. Preview
timelines tag episodes already watched on the channel. The Watch Tracker
screen shows what's streaming now and the log, where watches can be deleted.

## Channel Builder

A step-by-step screen for making a new channel, from blank or by copying and
reshaping an existing one (the original isn't touched):

1. **Basics:** name, group (or a new one), suggested number, and an optional
   description.
2. **Content:** pick shows, seasons, single episodes, movies, custom shows
   and smart collections.
3. **Look & feel:** icon, watermark, stream mode, transcode profile, flex
   title, hidden from the guide, filler lists.
4. **Schedule:** sort, its settings, lineup length, and optionally
   automations with their timetables and settings (copied too when you start
   from an existing channel).
5. **Preview & create:** preview the lineup before the channel exists, then
   **Create** makes the channel in Tunarr, saves its Schedule Lab setup and
   applies that lineup.

If AI is set up and allowed for the Channel Builder, optional **✦ Ask AI**
buttons suggest a name and group, shows from your library (you add the ones
you want), and sort settings, all from the description. Everything works
without them.

## Pool sources

Each channel's **Episode pool** card (Channels screen) says where its episodes
come from:

- **+ Shows & movies:** search and browse your library; add whole shows,
  single seasons (**Seasons**), single episodes (**Episodes**), or movies.
- **+ From lineup:** adds the shows (and custom shows, movies) on the channel's
  lineup now as pool sources, skipping ones already there. Handy before adding
  other sources to a channel whose pool was its lineup.
- **+ Custom show:** a Tunarr custom show.
- **+ Smart collection:** a Tunarr smart collection (a saved search made in
  Tunarr); what it matches is read every time a lineup is built.
- **Library rules** ("shows on Cartoon Network") now belong to automations.
  A channel that still has a rule from 2.1.0-beta.4–6 shows a **Convert**
  button: it swaps the rule for the shows it matches today and adds the
  "Add new matching shows" automation, which suggests new matches for you to
  approve (or adds them itself, if you set it to).
- **Shows in pool:** everything the sources add up to, with **Exclude** per show.

Each source has a **weight**; every episode carries `weight` (the highest of
its sources) and `sources` (their names). Sorts decide whether and how to use
them. A channel without sources works as before: its pool is what's on its
lineup. `ctx.current` always has the lineup, so sort code can keep episodes
that aren't in the sources if it wants to. A new, empty channel can be filled
entirely from its pool sources.

## Automations

Automations are code, like sorts, kept in the **Automation Library** with
every version. Add one to a channel on the Channels screen (Automations card).
Each channel gets its own values for the automation's settings and its own
timetable: weekly on chosen days, daily, monthly, every N days, every N
hours, or only when you run it. Without a set time, it runs somewhere in the
overnight window (Settings → Automations), at a different spot per channel.
Runs wait in one queue, one or two at a time.

**Import starter automations** loads: Weekly rebuild, Rebuild when running
low, Best of several, AI picks the best, AI review before applying, and Add
new matching shows. They are ordinary entries: edit, copy or delete them.

Rules every automation follows, whatever its code says:

- it can read every channel but only changes the channel it's on;
- an apply is backed up first (undo it on Apply & History), happens at most
  once per run, is never empty, and is refused if the new lineup is shorter
  than `minLengthPercent` (a setting, 50 by default) of the channel's lineup
  length;
- **Dry run** (on the channel's card, or in the editor for unsaved code) shows
  what it would change without changing anything.

Each run's result, changes and log are in the run history. If Tunarr can't be
reached, the run is tried again later (as long as it hadn't changed anything).
Pool suggestions from automations show on the channel's card with **Add** and
**Dismiss**; a dismissed show isn't suggested again. Shows already on the channel (in its pool
sources or on its lineup) are never suggested. On a channel without pool
sources, adding a show first turns the shows on its lineup into sources, so
they stay.

```js
/* @settings
candidates: number = 4
minLengthPercent: number = 50
*/
async function run(ctx) {
  const now = await ctx.lineup.current();            // { itemCount, durationMs, daysLeft, lastAppliedAt, ... }
  if (now.daysLeft > 3) return ctx.skip('Plenty left');
  const c = await ctx.build({ seed: Date.now() % 1e6 }); // runs the channel's sort
  ctx.log('score', ctx.score(c));
  await ctx.apply(c);
}
```

Also: `ctx.params`, `ctx.channel`, `ctx.globals`, `ctx.history`, `ctx.dryRun`,
`ctx.ai.available` / `ctx.ai.ask()`, `ctx.library.search(rule)`,
`ctx.pool.get/add/suggest/exclude/fromLineup`, `ctx.channels.list/get` (read-only) and
`ctx.utils`. New automations start from a template that lists them all. The
time limit (60 s by default) counts only the automation's own code, not the
sorts it builds, applies or AI answers.

## AI (optional)

Settings → AI sets up Anthropic (Claude), OpenRouter, and/or Ollama on your
network, with a default provider, on/off switches for the Channel Builder,
sorts and automations, and a monthly spending cap for the paid providers.
Nothing uses AI unless you click an "Ask AI" button or your sort or automation
code calls `ctx.ai.ask(...)`. Every call is logged with its tokens and cost
under AI usage. API keys are never shown again after saving (they are kept in
the database and in exports). With Anthropic or OpenRouter, prompts leave your
network; with Ollama they stay on it. For Ollama in Docker, use the Ollama
server's LAN address, not localhost.

## Channels in Tunarr

The Channels screen's **+ New** opens the Channel Builder. It can also copy a channel (Tunarr copies the
settings and lineup; Schedule Lab copies the sort and its settings), rename,
renumber, change the group, and delete. New channels pick their group from a
list (or a new one) and get a suggested number: next to their group, right
after the channel being copied, or the next free block of 100 for a new group.
A new channel starts empty: add pool sources to it (below), pick a sort,
preview and apply. Deleting saves the channel's settings
and lineup first; "Deleted channels" recreates it with the same id, so its
Schedule Lab setup and watch history come back too.

## Guide check

Tunarr can't be told to rebuild its guide, so after every apply, undo or
restore, Apply & History checks the next 6 hours: whether Tunarr's schedule
matches what was applied, and whether the XMLTV guide file TV apps download
has caught up. "Check guide" runs it again at any time.

## Global variables

Named values on the Settings screen (number, text, secret, yes/no, weekly
hours or filler list). Every sort reads them as `ctx.globals.name`. On the
Channels screen, the small menu next to any sort setting links it to a
variable of a matching type, so one API key or one set of household work
hours can feed many channels; change the variable once and they all follow.
Renaming a variable keeps its links; one that's still linked can't be deleted.

## Things to know

- Tunarr loops a lineup when it reaches the end. A 7-day lineup repeats every
  7 days; lengthen it in the channel's settings if you want longer.
- Channels whose lineup came from a Tunarr slot schedule ("random" or "time")
  get a fixed lineup when you Apply. The backup holds the old lineup exactly.
- "Start the lineup at the preview's start time" sets the channel's
  `startTime`, so what the preview shows at 8:00 plays at 8:00.
- Setting values are stored per channel, including API keys (the AI
  optimizer's), unless linked to a global variable. They are in the database
  and in exports.
- Schedule Lab doesn't refresh Tunarr's guide (the refresh endpoint doesn't
  work in Tunarr 1.3.15); Tunarr rebuilds it on its own schedule.
- Saving a sort creates a new version. Channels stay on their version until
  you move them up on the Channels screen.

## Writing sorts

A sort is `function run(ctx)` returning the new lineup (items from `ctx.pool`
or `ctx.current`, in play order), the same contract as 1.8. Settings are
declared at the top and become form fields:

```js
/* @settings
repeatWindowHours: number = 72                  // Repeat window (hours)
order: choice(as-listed, shuffle) = shuffle
workHours: weekly hours = Mon-Fri 08:00-16:30   // Work hours
apiKey: secret =                                // API key
*/
function run(ctx) { ... }
```

Types: `number`, `text`, `secret`, `yes/no`, `choice(...)`, `weekly hours`,
`filler list`. `ctx.utils.hours(ctx.params.workHours)` gives `isInside(t)` and
`fractionInside(a, b)`. The Sort Builder's **How sorts work** button lists the
whole `ctx`.

Sorts run on the server in a sandbox: 10 seconds (changeable in Settings), 512 MB, no network or file
access (`ctx.utils.claude()` is the one way out, for the AI optimizer).

## Development

Needs Node 24 (it runs the TypeScript directly; there is no build step).

```bash
npm install
npm run dev
```

`npm run dev` reads `.env` (e.g. `TUNARR_URL=...`, `PORT=8766`,
`DATA_DIR=./data`). `npm test` runs the tests; `npm run typecheck` runs `tsc`.

## Releases

- **2.0.0**: the Docker app: tools split out, Sort Builder and Library,
  per-channel sorts and settings, Apply with backup/undo/restore, Settings
  and global variables.
- **2.1** (now 2.1.0-beta.10): Watch Tracker and `ctx.history`, AI settings,
  channel management, the guide check, pool sources, the Channel Builder and
  coded Automations with their library are done; library rules moved into
  automations.
- **2.2**: filler and channel immersion: filler padding, dynamic bumpers and
  similar touches that make a channel feel like real TV.
- **2.3**: library search for pools, custom shows and smart collections as
  pools, checks across channels, add-to-the-end applies, export as a Tunarr
  time-slot schedule.
