/**
 * Her pad -> keys, for games that only have a keyboard (the DOS stages).
 *
 * The pilot writes the same standard gamepad as always (src/gamepad.js). The
 * in-tab game page (/console/dos) reads that pad through navigator.getGamepads()
 * every 10 ms and turns it into key presses with this table:
 *
 *   axes[0]  steer  (-1..1)  -> steerLeft / steerRight, pulse width
 *   buttons[7] gas  (0..1)   -> gas, pulse width
 *   buttons[6] brake (0..1)  -> brake, pulse width
 *   buttons[3] Y             -> enterExit, held while pressed
 *   buttons[5] RB            -> handbrake, held while pressed
 *
 * Pulse width: an analog value v is a key held for v of every `periodMs`
 * (100 ms), so a small steer is a short tap and a full steer is held. Below
 * `dead` the key stays up; above 1 - dead it stays down.
 *
 * One table per stage, so GTA 2 can differ from GTA 1.
 */

// GTA 1 (DOS) default keys: arrows drive, Enter gets in/out, Space is the handbrake
// `menu`: the game's own menus run at a higher resolution than the city (640 wide
// against 320). While the picture is that wide for `afterMs`, the page taps
// `key` every `everyMs`, which walks title -> player -> city -> into the game,
// and does the same again after a game over. In the city it never fires.
const GTA1 = { steerLeft: 'ArrowLeft', steerRight: 'ArrowRight', gas: 'ArrowUp', brake: 'ArrowDown', enterExit: 'Enter', handbrake: 'Space', periodMs: 100, dead: 0.05,
  menu: { minW: 600, key: 'Enter', afterMs: 5000, everyMs: 3500, holdMs: 120 } };

export const STAGE_KEYS = Object.freeze({
  gta1: GTA1,
  // GTA 2 defaults are the same keys (arrows, Enter, Space)
  gta2: { ...GTA1, menu: null },
  default: GTA1,
});

export const keysForStage = (id) => STAGE_KEYS[id] || STAGE_KEYS.default;

/** DOM KeyboardEvent.code -> js-dos (GLFW) key code, the ones a map can use */
export const JSDOS_CODES = Object.freeze({
  ArrowLeft: 263, ArrowRight: 262, ArrowUp: 265, ArrowDown: 264,
  Enter: 257, Space: 32, Escape: 256, Tab: 258, Backspace: 259,
  ShiftLeft: 340, ControlLeft: 341, AltLeft: 342, ShiftRight: 344, ControlRight: 345, AltRight: 346,
  ...Object.fromEntries('ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((c) => [`Key${c}`, c.charCodeAt(0)])),
  ...Object.fromEntries('0123456789'.split('').map((c) => [`Digit${c}`, c.charCodeAt(0)])),
  ...Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((n) => [`F${n}`, 289 + n])),
});

/**
 * Which keys are down at time tMs for pad state { axes: [4], buttons: [17] }.
 * Pure, and written with no outside references so the page can run the same
 * source (padKeys.toString()).
 */
export function padKeys(pad, map, tMs) {
  const axes = (pad && pad.axes) || [];
  const b = (pad && pad.buttons) || [];
  const val = (x) => (typeof x === 'object' && x !== null ? Number(x.value) || 0 : Number(x) || 0);
  const period = map.periodMs || 100;
  const dead = map.dead == null ? 0.05 : map.dead;
  const phase = ((tMs % period) + period) % period;
  const pulse = (v) => {
    v = Math.max(0, Math.min(1, v));
    if (v < dead) return false;
    if (v > 1 - dead) return true;
    return phase < v * period;
  };
  const down = [];
  const lx = Math.max(-1, Math.min(1, Number(axes[0]) || 0));
  if (lx < 0 && pulse(-lx)) down.push(map.steerLeft);
  if (lx > 0 && pulse(lx)) down.push(map.steerRight);
  if (pulse(val(b[7]))) down.push(map.gas);
  if (pulse(val(b[6]))) down.push(map.brake);
  if (val(b[3]) >= 0.5 && map.enterExit) down.push(map.enterExit);
  if (val(b[5]) >= 0.5 && map.handbrake) down.push(map.handbrake);
  return down;
}

/** fraction of time each key is down over one period (for docs and tests) */
export function dutyOf(pad, map, steps = 100) {
  const period = map.periodMs || 100;
  const n = {};
  for (let i = 0; i < steps; i += 1) for (const k of padKeys(pad, map, (i * period) / steps)) n[k] = (n[k] || 0) + 1;
  return Object.fromEntries(Object.entries(n).map(([k, v]) => [k, v / steps]));
}
