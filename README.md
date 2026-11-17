# Halcyra Neuro

A complete fruit fly brain plays Grand Theft Auto, live, and every trade of her
coin fires her taste cells.

Her brain is the FlyWire FAFB v783 connectome, wired cell for cell: 139,255
neurons, 2,700,513 connections, 34,153,566 synapses. Nothing in it was trained
on a game. What she does comes out of the wiring.

- Site: https://halcyra.bio
- Proof: https://halcyra.bio/proof
- Whitepaper: https://halcyra.bio/whitepaper
- X: https://x.com/halcyrabio

## How it works

| part | what happens | code | more |
|---|---|---|---|
| Eye | the game picture becomes a 160 x 90 luminance grid and drives her 7,685 lamina cells, the first layer behind a fly's eye | `src/eye.js`, `src/gamebody.js` | docs/CONTROLS.md |
| Brain | all 139,255 cells step on the graded rate model (`site/fly/rate.js`, three fitted global gains); the published spiking model ships beside it (`site/fly/brain.js`) | `src/braincore.js`, `src/brainworker.js` | |
| Controls | the activity of her 1,295 descending cells is read as a game pad: steer, gas, brake, enter and exit, handbrake. The whole mapping is one pure function | `toPad()` in `src/gamebody.js` | docs/CONTROLS.md |
| Taste | every buy reaches her 29 sugar cells, every sell her 20 bitter cells, both taken from published FlyWire IDs. Trades are read from chain (pump.fun curve, then PumpSwap) | `src/taste.js`, `src/chain/` | docs/TASTE.md |
| Ladder | she starts on GTA 1 and moves up a game each time the coin's market cap, read from chain, holds above a threshold | `src/ladder.js`, `src/chain/mcap.js` | docs/STAGES.md |
| Record | every step of her brain is hashed onto the step before it, stored and served, so anyone can replay the run and check it | `src/ledger.js`, `scripts/verify-chain.mjs` | /proof |
| Stream | her screen goes out as a 24/7 video stream | `src/stream.js` | |

One Node service does all of it.

## The ladder

| game | unlocks at (USD market cap) |
|---|---|
| GTA 1 | from the start |
| GTA 2 | 30,000 |
| GTA III | 100,000 |
| GTA Vice City | 300,000 |
| GTA San Andreas | 1,000,000 |
| GTA IV | 3,000,000 |
| GTA V | 10,000,000 |
| GTA VI | 30,000,000 |

A game unlocks when the market cap is at or above its threshold on three reads
in a row, about 20 seconds apart. Unlocks are permanent and each one is its own
record in the proof ledger, with the three readings and their slots.

## Check it yourself

```bash
npm run verify -- https://halcyra.bio     # replays the hash chain from the served ticks
```

| address | what it gives |
|---|---|
| `/api/health` | every part and its state |
| `/api/state` | the game on screen, her last step, market data |
| `/api/proof` | dataset, counts, the taste cells by FlyWire root ID, and what is needed to replay her |
| `/api/ticks`, `/api/checkpoints` | the ledger itself |
| `/api/ladder` | stages, unlocks, the market cap reading and its on-chain inputs |
| `/api/trades` | the trades she tasted |
| `/api/live` | server-sent events: steps, trades, unlocks |
| `/api/frame.jpg` | what is on her screen right now |

## Run

```bash
npm install
npm start                    # http://localhost:8080/api/state
npm run doctor               # checks every outside piece, starts nothing
```

It boots with nothing set. Each missing value turns one part off and
`/api/health` says which:

| not set | what happens |
|---|---|
| `MONGO_URI` | ticks live in a memory ring only (lost on restart) |
| `TOKEN_CA` | trade watcher off, no taste, empty trades |
| `CONSOLE_URL` | the console follows the game ladder (docs/STAGES.md): our own `/console/dos` page when the stage's game files are in `GAMES_DIR`, else no browser and the brain idles |
| `STREAM_URL` | no livestream |

## Env

Required for the real thing (these are all `.env.example` holds):

| var | what |
|---|---|
| `MONGO_URI` | Mongo cluster. Only `halcyra_ticks`, `halcyra_meta`, `halcyra_trades`, `halcyra_session`, `halcyra_ladder` are touched |
| `TOKEN_CA` | the coin's mint |
| `CONSOLE_URL` | a fixed console page (the ladder then only records unlocks). Leave it unset to let the ladder drive the tab (docs/STAGES.md, Launch checklist) |
| `STREAM_URL` | RTMP ingest URL with the stream key on the end (`rtmp://host/app/<key>`) |
| `ADMIN_KEY` | a secret of your own. With it set, `PUT /admin/games/<stage id>` takes a game bundle (header `x-admin-key`), keeps a copy in Mongo and starts her on it. Unset: that address does not exist |

Optional overrides (defaults in `src/config.js`):

| var | default | what |
|---|---|---|
| `PROJECT_NAME` | `Halcyra Neuro` | name in the API |
| `TICKER` | `HALCYRA` | ticker in the API |
| `GAME` | `GTA 1` | game label |
| `PUBLIC_URL` | `https://halcyra.bio` | the site's public URL |
| `X_URL` | `https://x.com/halcyrabio` | the project's X account |
| `PORT` | `8080` | |
| `RPC_URL` | public Solana mainnet | read by `src/chain` |
| `TRADE_POLL_MS` | `4000` | trade watcher poll |
| `STEP_MS` | `200` | loop period (at most one look per period, so at most 5 per second) |
| `BRAIN_MS` | `70` | brain time she lives per look (14 model steps of 5 ms). Measured on 2 vCPU with the stream on: 70 gives ~4.3 looks/s, 160 gives ~1.8 |
| `BRAIN_THREAD` | `worker` | `worker`: her brain runs in a worker thread so the API, SSE and trade watcher never wait for her; `main` runs it in the main thread (same results bit for bit, but the event loop stalls ~0.5 s per look) |
| `EYE` | `frame` | `frame`: the game picture is read inside the page (fast, never touches the visible window); `png`: full screenshot; `small`: CDP scaled capture (shrinks a real window for a moment, comparison only) |
| `SEED` | time based | brain noise seed |
| `MONGO_DB` | `halcyra` | database name |
| `TICK_KEEP_H` | `48` | hours full ticks are kept; `0` = forever. Checkpoints are kept forever |
| `BUCKET_TICKS` | `300` | ticks per stored bucket |
| `FLUSH_MS` | `300000` | store a partial bucket after this long (a hard crash loses at most this much; SIGTERM stores everything) |
| `RING_TICKS` | `6000` | ticks kept in memory |
| `CHROME_PATH` | cloakbrowser | use this Chrome instead |
| `BROWSER` | | `playwright` forces plain playwright-core |
| `HEADLESS` | `false` | the container runs headed under Xvfb |
| `VIEW_W` / `VIEW_H` | `1280` / `720` | window size (= Xvfb screen in the container) |
| `PROXY_URL` | | browser proxy |
| `FRAME_MS` | `1000` | console freeze check period |
| `SHOT_MS` | `3000` | how often `/api/frame.jpg` is refreshed |
| `FROZEN_S` | `20` | same picture this long = frozen, reload |
| `CONSOLE_WAIT_S` | `60` | wait this long for a playing video or canvas |
| `SAVE_STATE_MS` | `600000` | how often the console login is checked for changes |
| `FFMPEG_PATH` | `ffmpeg` | |
| `STREAM_SIZE` | `1280x720` | |
| `STREAM_FPS` | `30` | x11 grab rate |
| `STREAM_KBPS` | `2500` | video bitrate (CBR-ish), audio is 128k silent AAC |
| `STREAM_PRESET` | `veryfast` | x264 preset |
| `STREAM_PIPE_FPS` | `10` | only without a display |
| `DATA_DIR` | `data` | local files |
| `CONSOLE_KIND` | `browser` | `native`: the game is a normal program on this machine (a Windows PC). OS-level virtual pad + desktop capture, no browser, `CONSOLE_URL` not used. See docs/NATIVE.md |
| `PYTHON` | `python` (Windows) / `python3` | native: Python that runs the pad feeder |
| `PAD_FEEDER` | `<PYTHON> -u src/native/feeder.py` | native: full command for the pad feeder |
| `PAD_HZ` | `60` | native: most pad updates a second |
| `CAPTURE` | `auto` | native eye: `auto` (Windows: ddagrab, then gdigrab; Linux: x11grab), or one of them |
| `EYE_FPS` | `10` | native eye: frames a second from the desktop grab |
| `FRAME_FPS` / `FRAME_W` | `1` / `640` | native: `/api/frame.jpg` rate and width (made by the same ffmpeg as the eye) |
| `FRAME_PIPE` | `fd3` | native: how the JPEGs come back from ffmpeg; `file` uses data/native-frame.jpg instead |
| `STALE_MS` | `3000` | native: no fresh screen frame this long = not playing |
| `STREAM_INPUT` | `auto` | Windows stream grab: `auto` (ddagrab, then gdigrab), `ddagrab`, `gdigrab` |
| `STREAM_ENCODER` | `auto` | Windows: `h264_nvenc` if it works on this PC, else `libx264`. Linux keeps `libx264` unless set |
| `STREAM_AUDIO` | `auto` | Windows: a loopback device if installed (docs/NATIVE.md), else silent AAC. `silent`, `dshow:<device>`, `pulse:<source>` |
| `LADDER` | GTA 1 from 0, GTA 2 at 30,000, GTA III at 100,000, Vice City at 300,000, San Andreas at 1,000,000, GTA IV at 3,000,000, GTA V at 10,000,000, GTA VI at 30,000,000 USD | the game ladder as JSON: a patch (`{"gta1":{"url":"https://..."}}`) or a full stage list; see docs/STAGES.md |
| `LADDER_POLL_MS` | `20000` | one on-chain market cap read this often; 3 reads in a row at or above a threshold unlock it |
| `ORACLE_MAX_AGE_S` | `180` | a Pyth SOL/USD price older than this counts as a failed read |
| `GAMES_DIR` | `games` | where `<stage id>/bundle.jsdos` live (made by `scripts/make-bundle.mjs`; not in git; served to loopback only) |
| `CONSOLE_START_SELECTOR` | | an outside console page: CSS selector of its start / play control, clicked until the game shows |
| `CONSOLE_START_KEYS` | | keys sent once the game shows, to pass menus: `wait:3000,Enter,wait:1500,Enter` (`Name*3` repeats) |
| `CONSOLE_CANVAS_SELECTOR` | largest canvas (else largest iframe) | the game picture element on the console page |
| `CONSOLE_KEYS` | auto | her pad as key presses (`src/keyer.js`): `gta1` / `gta2` key table, `off`, or auto (a ladder stage on an outside page uses its own table; `/console/dos` maps keys itself) |

## Layout

| folder | what |
|---|---|
| `src/` | the service: brain, eye, controls, taste, chain reader, ladder, ledger, pages, stream |
| `src/native/` | the Windows path: OS-level pad, desktop eye |
| `site/fly/` | the connectome, the neuron table, the models |
| `site/home/` | the landing page |
| `scripts/` | doctor, chain verify, taste checks, game bundle maker, Windows setup |
| `test/` | the test suites (`npm test`) |
| `docs/` | CONTROLS, TASTE, STAGES, NATIVE, PROBE |

## Data

FlyWire FAFB v783 (Dorkenwald et al. 2024, Schlegel et al. 2024). Model
constants and the taste cell IDs follow Shiu et al. 2024 (Nature 634:210).
