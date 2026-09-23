# Schedule Lab 2.0

Builds and applies episode lineups for Tunarr channels. It runs as one Docker
container on your home network and makes every Tunarr call from its own
server, so there are no browser CORS problems and no `lab-server.py`.

## Run it

On the Docker server:

```bash
docker compose up -d --build
```

Then open `http://<that-server>:8765/`. The only required setting is
`TUNARR_URL` in `docker-compose.yml` (now `http://192.168.1.197:8000`). Set
`TZ` to your time zone too: work and sleep hours are read in it.

Data lives in the `schedule-lab-data` volume (`/data/schedule-lab.db`), so
rebuilding or updating the container keeps it. **Export** in the top bar saves
everything to one JSON file; **Import** loads it on another machine.

Home network only: there is no login. Don't forward port 8765 on your router;
use a VPN to reach it from outside.

## First steps

1. **Sort Library → Import 1.8 sorts** loads no-repeat shuffle, full cycle,
   time-block insert, AI optimizer and the work-schedule sort as ordinary,
   editable entries. The app has no built-in sorts.
2. **Channels**: pick a channel, choose its sort, fill in that channel's
   settings (work hours are painted on a week grid), set the lineup length, Save.
3. **Preview & Compare**: run the channel's sort (or several sorts, several
   seeds each) and rank the candidates. Pick one → **Send to Apply**.
4. **Apply & History**: Apply backs up the current lineup first (last 20 per
   channel), writes the new one, sets the channel start time, and refreshes
   the guide. **Undo last change** or **Restore** any backup.

## Things to know

- Tunarr loops a lineup when it reaches the end. A 7-day lineup repeats every
  7 days; lengthen it in the channel's settings if you want longer.
- Channels whose lineup came from a Tunarr slot schedule ("random" or "time")
  get a fixed lineup when you Apply. The backup holds the old lineup exactly.
- "Start the lineup at the preview's start time" sets the channel's
  `startTime`, so what the preview shows at 8:00 plays at 8:00.
- Setting values are stored per channel, including API keys (the AI
  optimizer's). They are in the database and in exports.
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

Sorts run on the server in a sandbox: 10 seconds, 512 MB, no network or file
access (`ctx.utils.claude()` is the one way out, for the AI optimizer).

## Development

Needs Node 24 (it runs the TypeScript directly; there is no build step).

```bash
npm install
npm run dev
```

`npm run dev` reads `.env` (e.g. `TUNARR_URL=...`, `PORT=8766`,
`DATA_DIR=./data`). `npm test` runs the tests; `npm run typecheck` runs `tsc`.

## Coming next

- **2.1**: Watch Tracker and `ctx.history`, filler padding, guide check after
  Apply, Automations with per-channel timetables, create/copy/rename/delete channels.
- **2.2**: library search for pools, custom shows and smart collections as
  pools, checks across channels, append applies, export as a time-slot schedule.
