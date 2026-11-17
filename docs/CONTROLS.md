# Controls: what goes in, what comes out

Her brain is the FlyWire FAFB v783 connectome (139,255 neurons) running as a
rate model (`site/fly/rate.js`). Two things go in: light and taste. One thing
comes out: the activity of her descending cells, read as a game pad.

Code: `src/eye.js` (the picture to a 160 x 90 luminance grid), `src/gamebody.js`
(light and taste in, readouts out, `toPad()`), `src/gamepad.js` (the pad a
browser game reads), `src/stagekeys.js` and `src/keyer.js` (the pad as key
presses for the DOS games), `src/native/pad.js` (the pad as an OS-level Xbox
controller for the Windows games).

## What goes in

**Light** (the same `look()` as `site/fly/body.js`):
her L1 to L5 lamina cells (7,685 cells, both eyes) each placed on the retina
where its soma sits; a cell is driven at `rTonic + (rLamina - rTonic) * c` with
`c = min(1, kSpatial * max(0, surround - here) + kTemporal * max(0, before - now))`,
the OFF sign. Gains from the `gains.json` body block
(`rLamina 1.0, rTonic 0.05, kSpatial 5, kTemporal 9, blurSigma 7`), same saccade
jitter. Brain gains are read from `site/fly/gains.json` "brain" (`Gc 8` etc.),
unchanged.

A game picture already moves with the player (chase camera), so her field is
the whole screen: left eye on
the left of the screen, right eye on the right, the same 0.18 binocular overlap.

**Taste**: `tasteCells.sweet` / `.bitter` are driven at `level * kSweet` /
`level * kBitter` (both default 1.0, the same scale as a lamina cell at full
contrast). `body.js` calls `brain.clearInput()` on every look (every brain step
at dt 5 ms), which wipes all inputs, so taste is re-applied inside `look()`
right after the lamina, every look. The offline test checks the drive is still
on those cells at the end of the step.

## What comes out: the mapping

Which cell drives which control is a design choice, and this table is all of
it. Every pad value is a pure function (`toPad()` in `src/gamebody.js`) of
cell activity averaged over the step's window (activity is the rate model's
0..1 release). Nothing else writes to the pad: no controller, no script, no
smoothing.

Counts are from `site/fly/neurons.tsv.gz` via `loadNeuronsNode`, matched on
`cell_type` and `side`:

| readout | cells (L / R) | control (standard mapping) | function | gain (default) | where the gain comes from |
|---|---|---|---|---|---|
| all `descending` class | 646 / 649 (+8 unsided, unused) | left stick X `axes[0]` (steer) | `clamp((R - L) / kTurn, -1, 1)` | `kTurn 0.30` | `gains.json` body block |
| all `descending` class, cut by DNp09 | 646 / 649, DNp09 1 / 1 | right trigger `buttons[7]` (gas) | `clamp(((L + R) / 2) / kFwd, 0, 1) / (1 + DNp09 / hzStop)` | `kFwd 0.11`, `hzStop 0.35` | walk drive and DNp09 brake, `gains.json` body block |
| MDN (moonwalker) | 2 / 2 | left trigger `buttons[6]` (brake, then reverse in GTA) | `clamp(MDN / kBack, 0, 1)` | `kBack 0.11` | set equal to `kFwd` |
| the two above | | left stick Y `axes[1]` (walk on foot) | `clamp(LT - RT, -1, 1)` (up is negative) | | same drives, so she can walk if she is ever out of the car |
| oviDNb | 1 / 1 | Y / Triangle `buttons[3]` (enter / exit vehicle) | pressed for the step when oviDNb >= `hzLay` held `layMs`, then `refractoryMs` | `0.2`, `120 ms`, `1500 ms` | lay (commit), `gains.json` body block |
| DNp01 (giant fiber) | 1 / 1 | RB / R1 `buttons[5]` (handbrake) | pressed for the step if DNp01 >= `hzEscape` at any brain step in the window | `hzEscape 0.2` | same threshold convention as `hzLay` |
| none | | right stick `axes[2..3]` (camera), every other button | always 0 | | |

Reported, not driving: `DNa01` (1/1), `DNa02` (1/1, also per side).
All six named types exist on both sides in the data; nothing in the table is
absent from the dataset.

Commit and escape button indices are `commitButton: 'y'`, `escapeButton: 'rb'`
in `GAMEBODY_DEFAULTS` (Triangle / Y enter and exit, R1 / RB handbrake, R2 / RT
gas, L2 / LT brake and reverse, left stick steer).

## The virtual gamepad

`navigator.getGamepads()` returns `[pad, null, null, null]`; a fresh snapshot
per call, as Chrome does. `pad` is built on `Gamepad.prototype` (so
`instanceof Gamepad` holds) with own read-only `id 'Xbox 360 Controller (XInput
STANDARD GAMEPAD)'`, `index 0`, `connected true`, `mapping 'standard'`,
`timestamp` (refreshed on every `set`), 4 `axes`, 17 `buttons` each
`{ pressed: value > 0.5, touched: value > 0, value }` on `GamepadButton.prototype`.
`gamepadconnected` (with `.gamepad`) fires once on window load, or at once if
injected into a loaded page. `window.__pad.stats()` reports how often the page
read it.

Keyboard fallback (`input: 'keyboard'` or `setPad(page, s, { mode: 'keyboard' })`):
`A`/`D` steer, `W` gas, `S` brake, `F` enter/exit, `Space` handbrake (GTA V PC
defaults), held while the analog value is >= 0.35; only changes are sent.

## The pad as keys (GTA 1 and GTA 2)

The DOS games take keys, so the same pad is turned into key presses
(`src/stagekeys.js`):

| pad | key | how |
|---|---|---|
| left stick X (steer) | Left / Right arrow | pulse width over 100 ms: the further the stick, the longer the key is held in each 100 ms |
| right trigger (gas) | Up arrow | held while the trigger is past its dead zone |
| left trigger (brake, reverse) | Down arrow | held while the trigger is past its dead zone |
| Y (enter / exit car) | Enter | one press per commit |
| RB (handbrake) | Space | one press per escape |

## The pad on Windows (GTA III and later)

`CONSOLE_KIND=native` gives the same pad to the game as a virtual Xbox 360
controller at OS level. See `docs/NATIVE.md`.
