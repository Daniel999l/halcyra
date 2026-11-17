# STAGES: the game ladder

## Running stage 1

Stage 1 (GTA 1) runs in one of two ways, chosen by env values alone. Set
`TOKEN_CA` in both (without it the market cap is unknown and she stays on GTA 1).

### A. Outside page (a site that already runs GTA 1 in a js-dos canvas)

```
TOKEN_CA=<coin address>
LADDER={"gta1":{"url":"https://<the outside GTA 1 page>"}}
CONSOLE_START_SELECTOR=<CSS selector of that page's play / start button>   (leave unset if the game starts by itself)
CONSOLE_START_KEYS=<keys to pass its menus, e.g. wait:4000,Enter,wait:2000,Enter>   (optional)
CONSOLE_CANVAS_SELECTOR=<CSS selector of the game canvas>   (optional; default = the largest canvas, or the largest iframe)
```

Do NOT set `CONSOLE_URL` in this mode: the ladder drives the tab, picks the GTA 1
key table by itself, and moves the tab to GTA 2 when it unlocks and its files
are present. Keys: arrows (steer by pulse width over 100 ms, Up = gas, Down =
brake), Enter = enter / exit car, Space = handbrake, as trusted key events.

Simplest alternative, if the ladder should NOT move the tab:

```
TOKEN_CA=<coin address>
CONSOLE_URL=https://<the outside GTA 1 page>
CONSOLE_KEYS=gta1
CONSOLE_START_SELECTOR=...   CONSOLE_START_KEYS=...   CONSOLE_CANVAS_SELECTOR=...   (same as above, optional)
GAME=GTA 1
```

Unlocks are still recorded (ledger, `/api/ladder`) but the tab stays on that page.

### B. Our own page (`/console/dos`, game files on the machine)

```
TOKEN_CA=<coin address>
(no CONSOLE_URL)
GAMES_DIR=/app/games   (only if the files are not in ./games, e.g. a Railway volume)
```

and once, on a machine that has the GTA 1 DOS files:

```
node scripts/make-bundle.mjs <folder with the GTA 1 DOS files> gta1
```

which writes `games/gta1/bundle.jsdos`. If it cannot tell which program starts
the game it says so: add `--exe NAME.EXE`. That file must be on the Railway
machine under `GAMES_DIR` (games/ is not in git: use a Railway volume mounted at
`/app/games` and copy the file onto it).

Both modes are covered by `node test/outside-console.mjs` (an outside page on
another origin, real Chrome, real console tab, real keys) and
`node test/ladder.mjs`.

## The ladder

She starts on the oldest game and moves up as the coin's market cap grows.

| stage | game | unlocks at (USD market cap) | where it runs |
|---|---|---|---|
| gta1 | GTA 1 | from the start | browser tab |
| gta2 | GTA 2 | 30,000 | browser tab |
| gta3 | GTA III | 100,000 | Windows PC (docs/NATIVE.md) |
| vc | GTA Vice City | 300,000 | Windows PC |
| sa | GTA San Andreas | 1,000,000 | Windows PC |
| gta4 | GTA IV | 3,000,000 | Windows PC |
| gta5 | GTA V | 10,000,000 | Windows PC |
| gta6 | GTA VI | 30,000,000 | Windows PC |

`LADDER` (JSON) overrides this. Two forms:

- patch the defaults: `{"gta2":{"usd":40000}}` or `{"gta1":{"url":"https://..."}}`
- a full list: `[{"id":"gta1","game":"GTA 1","usd":0,"kind":"browser","url":"/console/dos?b=gta1"}, ..., {"id":"gta6","game":"GTA VI","usd":30000000,"kind":"native"}]`

A `native` stage runs on a Windows PC with `CONSOLE_KIND=native`
(docs/NATIVE.md). The unlock is recorded the moment the market cap rule is
met, and `playing` always names the game that is on screen.

## The unlock rule

- Market cap in USD, read from chain only, every 20 s (`LADDER_POLL_MS`):
  coin price in SOL (pump.fun bonding curve virtual reserves before graduation,
  PumpSwap pool vault balances after) x the mint's total supply x SOL/USD from
  Pyth's on-chain SOL/USD account (`7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE`).
  All of one read comes from ONE `getMultipleAccounts` call, so everything is at
  the same slot. A Pyth price older than 180 s or with a confidence wider than
  2% counts as a failed read.
- A stage unlocks when the market cap is at or above its threshold on 3
  consecutive reads. Reads must be at least 15 s apart and at a newer slot; a
  failed read breaks the run.
- A jump over several thresholds unlocks every stage passed (one record each).
- Unlocks never go back. They are stored in Mongo `halcyra_ladder` (insert-only,
  unique on coin + stage) and survive restarts. Without Mongo: memory only.
  Another `TOKEN_CA` starts at stage 1.
- Every unlock is also its own record in the proof ledger (`kind: "unlock"`):
  stage, threshold, the three readings with their slots, the raw on-chain
  inputs (as integer strings), the oracle reading, the time.
  `scripts/verify-chain.mjs` checks it like any tick.

## What the API says

`GET /api/ladder` (and `ladder` inside `/api/state`):
`stages`, `unlocked` (highest reached), `playing` (the game REALLY on screen
right now, or `null` when the console is not playing), `waiting` (why the
unlocked game is not the one playing, when it is not), `next` (next threshold
and how many reads in a row are at or above it), `marketCap` (USD, slot,
venue, price in SOL, SOL/USD, supply, inputs, oracle). SSE `/api/live` sends an
`unlock` event. `game` in `/api/state` follows the stage on screen.
