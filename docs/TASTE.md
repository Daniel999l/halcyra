# Taste: trades on her tongue

Files: `src/taste.js`, `src/chain/**`, `scripts/taste-probe.mjs`,
`test/taste-*.mjs`, `test/chain-*.mjs`, `test/chain-fixtures.json`.

## Packages

| package | version | why |
|---|---|---|
| `@solana/web3.js` | `1.99.0` (exact) | `PublicKey` and program address derivation only. RPC calls are plain `fetch`. |

Nothing else. No pump.fun SDKs, no `spl-token`, no websocket package. Node >= 20.

## 1. The taste cells

### What is in the data

`site/fly/neurons.tsv.gz` columns: `root_id cell_type hemibrain_type super_class
cell_class side top_nt dimorphism fru_dsx pos_* soma_* idx`.

`super_class` over all 139,255 cells: optic 77,537, central 32,383, sensory
16,904, visual_projection 8,038, ascending 1,750, descending 1,303,
sensory_ascending 612, visual_centrifugal 524, motor 110, endocrine 80, blank 14.

`cell_class` inside `super_class = sensory`: visual 11,391, mechanosensory
2,668, olfactory 2,281, **gustatory 334**, unknown_sensory 121, hygrosensory 74,
thermosensory 29.

`cell_class = gustatory` (408 cells, including 74 `sensory_ascending` SA_VTV_*),
by `cell_type` (left + right): LB3 122, claw_tpGRN 60, LB1e 23, LB1c 18,
LB1a,LB1d 17, dorsal_tpGRN 11, LB2a-b 8, LB1b 7, LB2c 7, LB2d 7, LB4a 4,
PhG1..PhG16 (2 to 5 each), SA_VTV_1..10. `hemibrain_type` is empty for all of
them. No type name says sugar, bitter or water.

So **the TSV cannot separate sweet from bitter by type alone**: LB3 holds both
the published sugar GRNs and most of the published water GRNs.

### What is used: the published IDs

Shiu et al. 2024 (Nature 634:210, the paper this model's constants come from)
list the labellar GRNs they drove by FlyWire root ID in
`github.com/philshiu/Drosophila_brain_model`, `figures.ipynb` (cloned
2026-11-17): `neu_sugar` (21, "right hemisphere"), `neu_sugar_left` (10),
`neu_bitter` (21), plus `neu_water` and `neu_ir94e` (not used). Those are
FlyWire **v630** IDs; this brain is **v783**. Matching by root ID:

| list | published | found in v783 | v783 types of the found cells | not in v783 (dropped) |
|---|---|---|---|---|
| neu_sugar | 21 | 20 | LB3 (side=left) x20 | 720575940620900446 |
| neu_sugar_left | 10 | 9 | LB3 (side=right) x9 | 720575940627961104 |
| neu_bitter | 21 | 20 | LB1c x9, LB1a,LB1d x8, LB1b x3 (side=left) | 720575940618600651 |
| neu_water (check only) | 18 | 18 | LB3 x17, LB2d x1 | |
| neu_ir94e (check only) | 18 | 18 | LB1e x11, LB2a-b x4, LB2c x3 | |

The paper's "right hemisphere" lists are `side=left` in the v783 annotation (the
viewer convention flipped). The paper's MN9 (720575940660219265) is v783
`CB0701`, side right.

`findTasteCells(names)` (default mode `paper`):

- **sweet = 29 cells**: every published sugar ID present in v783, both palps
  (LB3 left 20 + LB3 right 9).
- **bitter = 20 cells**: every published bitter ID present in v783 (LB1c 9,
  LB1a,LB1d 8, LB1b 3, all side=left). The paper only published one side.

Mode `bilateral` (`findTasteCells(names, { mode: 'bilateral' })`) adds the 21
contralateral cells typed LB1a,LB1d / LB1b / LB1c (bitter = 41). Those are
chosen **by type**, not by published ID; the support for it is that the 20
published bitter IDs are exactly the LB1a-d cells of their side (that side has
21, one published ID did not survive to v783). Off by default.

No ID was invented. The three dropped IDs are reported in `meta.missing`.
`meta` also carries the v783 root IDs, type/side counts and the source string,
for `/api/proof`.

## 2. How a trade tastes (`class Taste`)

```js
const taste = new Taste({ halfLifeMs, minSol, maxSol, floor, dp })   // all optional
taste.push(trade)              // a Trade; returns false for a repeat (same sig+side) or junk
taste.sample(nowMs)            // -> { sweet: 0..1, bitter: 0..1, applied: [{ sig, side, sol, wallet, level }] }
replayTaste([{ t, applied }])  // -> [{ sweet, bitter }] equal to what sample() gave, from the ledger alone
```

- `level(sol) = floor + (1 - floor) * clamp(log(sol / minSol) / log(maxSol / minSol), 0, 1)`
  Defaults: `minSol 0.01`, `maxSol 10`, `floor 0.08`. So 0.01 SOL or less = 0.08,
  0.05 = 0.29, 0.1 = 0.39, 0.5 = 0.60, 1 = 0.69, 5 = 0.91, 10 or more = 1.
- A trade starts at its level on the **first `sample()` after it was pushed**
  (that sample lists it in `applied`, once) and halves every `halfLifeMs`
  (default **4000 ms**). Buys add into `sweet`, sells into `bitter`, each capped
  at 1. A contribution under 0.001 is forgotten.
- No clock and no randomness inside: time is what the caller passes in, and a
  time earlier than the last one is read as the last one. Levels and outputs
  are rounded to `dp` decimals (default 6). The service uses `dp: 4`, the
  ledger's own rounding, so the stored tick is exactly what drove her.
- Replaying from the ledger: each tick stores `tasteAt` (the time passed to
  `sample`) and `taste.applied`. `replayTaste(ticks.map(t => ({ t: t.tasteAt,
  applied: t.taste.applied })), proof.tasteModel)` rebuilds every
  `sweet`/`bitter` from those alone. On a live run against mainnet trades:
  633/633 ticks equal (`scripts/check-taste.mjs`).
- How hard a level drives the cells is set in `src/gamebody.js` (`kSweet`,
  `kBitter`, see docs/CONTROLS.md).

## 3. The trade watcher (`src/chain/`)

```js
import { createTradeWatcher, readCoin, marketFor, isMint } from './src/chain/index.js'
const w = createTradeWatcher({ mint, onTrade, fromSlot, onSlot, pollMs })  // -> { start(), stop(), pollOnce() }
```

Trade = `{ sig, side: 'buy'|'sell', wallet, sol, tokens (raw string, 6 decimals), slot, ts (ms, block time), venue: 'curve'|'pumpswap' }`

| file | what |
|---|---|
| `rpc.js` | JSON-RPC over `fetch`. One call at a time, 120 ms apart, backoff and retry on 429 / 5xx / timeouts, adaptive gap after 429s. `RPC_URL` env, default `https://api.mainnet-beta.solana.com`. `RPC_GAP_MS` env overrides the 120 ms. |
| `pump.js` | program IDs, bonding curve PDA (`["bonding-curve", mint]`), canonical PumpSwap pool PDA (`["pool", 0u16, pool-authority(mint), mint, WSOL]`), curve and pool layouts. Checked against live accounts. |
| `parse.js` | one transaction -> one Trade or null. The venue's own balance of the mint must move, so fee claims and other mints are not trades. `sol` = curve PDA lamport change, or the pool's WSOL change. `wallet` = fee payer if its balance moved the other way, else the owner that moved most the other way. Never throws. |
| `watch.js` | polls the venue address (curve PDA, then the pool after graduation; checks for graduation every 30 s), oldest first, de-duplicated by signature. |
| `coin.js` | `readCoin` (name/symbol from Token-2022 metadata or Metaplex, curve state, pool price after graduation), `marketFor` (price on chain; SOL/USD from Jupiter lite, then Coinbase; 24 h volume from DexScreener if it answers, else 0, `vol24hSource` says which). |

Watcher rules:
- Without `fromSlot` it starts at the chain tip (nothing old is emitted; `backfill: n` option takes the last n).
- `onSlot(S)` fires once every venue transaction in slots <= S is handled. Persist S and pass it back as
  `fromSlot`: a restart then emits only later slots. If the process dies in the middle of one slot, that one
  slot's trades can come again after a restart, so store trades keyed by `sig`.
- A transaction the RPC has not served yet stops the round there; it is retried next round (given up after 4 tries).
- A bad transaction or a throwing `onTrade` / `onSlot` is logged, never thrown.
- Trades on DEXes other than the bonding curve and the canonical PumpSwap pool are not emitted.
- No launching, claiming, keys or signing anywhere in `src/chain`.

Optional env overrides (all defaulted in code): `RPC_URL`, `SOL_POLL_MS` (4000), `RPC_GAP_MS` (120).

## 4. Verified on mainnet (2026-11-17)

- Layouts: curve account (166 bytes) and pool account (301 bytes) decoded on
  live coins; pool `base_mint` = the coin, quote = WSOL; the derived pool PDA is
  the live pool owned by PumpSwap.
- `test/chain-history.mjs`: 12 saved real transactions (5 curve trades of one
  coin including a Mayhem-agent buy, a sell and a creator fee claim on another
  curve coin, 5 PumpSwap trades of a graduated coin including one routed through
  Jupiter). All sides right, the fee claim is not a trade, every trader's own SOL
  change agrees with `sol` within fees/rent (raw transactions in
  `test/chain-fixtures.json`).
- `test/chain-live.mjs`: watcher on live coins; 0 duplicates; every hand check
  agrees; coverage check (every successful venue tx in the handled range is
  either emitted or confirmed not a trade).
- For a busy coin set `RPC_URL` to a dedicated endpoint: the watcher reads one
  transaction per call.
