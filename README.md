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

The Channels screen can create a new channel, copy one (Tunarr copies the
settings and lineup; Schedule Lab copies the sort and its settings), rename,
renumber, change the group, and delete. Deleting saves the channel's settings
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
- **2.1** (now 2.1.0-beta.2): Watch Tracker and `ctx.history`, AI settings,
  channel management and the guide check are done; pool sources and library
  rules (beta.3), the Channel Builder (beta.4) and coded Automations (beta.5)
  are next.
- **2.2**: filler and channel immersion: filler padding, dynamic bumpers and
  similar touches that make a channel feel like real TV.
- **2.3**: library search for pools, custom shows and smart collections as
  pools, checks across channels, add-to-the-end applies, export as a Tunarr
  time-slot schedule.
