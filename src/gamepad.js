/**
 * A virtual gamepad inside a Playwright page.
 *
 * The console tab reads the standard browser Gamepad API. This makes
 * navigator.getGamepads() return one connected pad in the W3C "standard"
 * mapping (4 axes, 17 buttons) whose state the Node side sets every step.
 * Nothing in here decides anything: it holds exactly the numbers it was last
 * given, and stamps them with a fresh timestamp.
 *
 * Works both ways it can be put in:
 *   await page.addInitScript(GAMEPAD_INIT)   before the console page loads
 *   await page.evaluate(GAMEPAD_INIT)         into a page that is already up
 * (idempotent: a second injection is a no-op).
 *
 * Fallback: if a console page ignores synthetic gamepads, `setPad(page, state,
 * { mode: 'keyboard' })` sends the same intents as keys through page.keyboard.
 */

/** W3C standard gamepad mapping, button indices */
export const BUTTON = Object.freeze({
  a: 0,       // A / Cross
  b: 1,       // B / Circle
  x: 2,       // X / Square
  y: 3,       // Y / Triangle
  lb: 4,      // LB / L1
  rb: 5,      // RB / R1
  lt: 6,      // LT / L2 (analog)
  rt: 7,      // RT / R2 (analog)
  back: 8,    // View / Share
  start: 9,   // Menu / Options
  ls: 10,     // left stick press
  rs: 11,     // right stick press
  up: 12, down: 13, left: 14, right: 15,
  home: 16,   // Xbox / PS
});
export const BUTTON_NAMES = Object.freeze(Object.keys(BUTTON));
/** standard mapping axes */
export const AXIS = Object.freeze({ lx: 0, ly: 1, rx: 2, ry: 3 });

export const PAD_ID = 'Xbox 360 Controller (XInput STANDARD GAMEPAD)';

/** a neutral pad: sticks centred, nothing pressed */
export function neutralPad() {
  return { axes: [0, 0, 0, 0], buttons: Object.fromEntries(BUTTON_NAMES.map((n) => [n, 0])) };
}

/** {axes, buttons: {name: value} | number[]} -> {axes: number[4], buttons: number[17]}, clamped */
export function toArrays(state) {
  const axes = [0, 0, 0, 0];
  const buttons = new Array(17).fill(0);
  const ax = (state && state.axes) || [];
  for (let i = 0; i < 4; i += 1) {
    const v = Number(ax[i]) || 0;
    axes[i] = Math.max(-1, Math.min(1, v));
  }
  const b = (state && state.buttons) || {};
  if (Array.isArray(b)) {
    for (let i = 0; i < 17; i += 1) buttons[i] = Math.max(0, Math.min(1, Number(b[i]) || 0));
  } else {
    for (const [k, v] of Object.entries(b)) {
      const i = BUTTON[k] ?? (Number.isInteger(+k) ? +k : -1);
      if (i >= 0 && i < 17) buttons[i] = Math.max(0, Math.min(1, Number(v) || 0));
    }
  }
  return { axes, buttons };
}

/**
 * The page side. A string so it can go into addInitScript and evaluate alike.
 * window.__pad.set({axes:[4], buttons:[17]}) sets the state;
 * window.__pad.stats() says how often the page has read it.
 */
export const GAMEPAD_INIT = `(() => {
  if (window.__pad) return;
  const ID = ${JSON.stringify(PAD_ID)};
  const st = { axes: [0, 0, 0, 0], buttons: new Array(17).fill(0), ts: performance.now(), sets: 0, reads: 0, connectedFired: 0 };
  const GP = typeof Gamepad === 'function' ? Gamepad.prototype : Object.prototype;
  const GB = typeof GamepadButton === 'function' ? GamepadButton.prototype : Object.prototype;
  const ro = (o, k, v) => Object.defineProperty(o, k, { value: v, enumerable: true, configurable: true, writable: false });
  // a fresh snapshot per read, as Chrome does
  const snapshot = () => {
    const pad = Object.create(GP);
    ro(pad, 'id', ID); ro(pad, 'index', 0); ro(pad, 'connected', true); ro(pad, 'mapping', 'standard');
    ro(pad, 'timestamp', st.ts);
    ro(pad, 'axes', Object.freeze(st.axes.slice()));
    ro(pad, 'buttons', Object.freeze(st.buttons.map((v) => {
      const b = Object.create(GB);
      ro(b, 'pressed', v > 0.5); ro(b, 'touched', v > 0); ro(b, 'value', v);
      return b;
    })));
    ro(pad, 'vibrationActuator', null); ro(pad, 'hapticActuators', Object.freeze([]));
    return pad;
  };
  const getGamepads = function getGamepads() { st.reads += 1; return [snapshot(), null, null, null]; };
  try { Object.defineProperty(Navigator.prototype, 'getGamepads', { value: getGamepads, configurable: true, writable: true }); } catch (e) { /* locked */ }
  try { Object.defineProperty(navigator, 'getGamepads', { value: getGamepads, configurable: true, writable: true }); } catch (e) { /* locked */ }
  const fire = () => {
    const ev = new Event('gamepadconnected');
    Object.defineProperty(ev, 'gamepad', { value: snapshot() });
    st.connectedFired += 1;
    window.dispatchEvent(ev);
  };
  if (document.readyState === 'complete') setTimeout(fire, 0);
  else window.addEventListener('load', () => setTimeout(fire, 0), { once: true });
  window.__pad = {
    set(s) {
      const a = (s && s.axes) || [];
      const b = (s && s.buttons) || [];
      for (let i = 0; i < 4; i += 1) st.axes[i] = Math.max(-1, Math.min(1, +a[i] || 0));
      for (let i = 0; i < 17; i += 1) st.buttons[i] = Math.max(0, Math.min(1, +b[i] || 0));
      st.ts = performance.now(); st.sets += 1;
      return st.reads;
    },
    stats() { return { id: ID, sets: st.sets, reads: st.reads, connectedFired: st.connectedFired, ts: st.ts, axes: st.axes.slice(), buttons: st.buttons.slice() }; },
    reconnect: fire,
  };
})()`;

/** put the virtual pad into a page: for future loads and for the one already there */
export async function installPad(page) {
  await page.addInitScript(GAMEPAD_INIT);
  await page.evaluate(GAMEPAD_INIT).catch(() => {});
}

/** the JS that sets the pad, for folding into another evaluate */
export function padSetJs(state) {
  const { axes, buttons } = toArrays(state);
  return `window.__pad && window.__pad.set(${JSON.stringify({ axes, buttons })})`;
}

/**
 * Keyboard fallback. Intents -> keys (GTA V on PC defaults). Keys are binary,
 * so an analog value counts as held when it passes `threshold`.
 */
export const KEYMAP = Object.freeze({
  steerLeft: 'KeyA', steerRight: 'KeyD',
  gas: 'KeyW', brake: 'KeyS',
  y: 'KeyF',          // enter / exit vehicle
  rb: 'Space',        // handbrake
  a: 'Enter', b: 'Backspace', x: 'KeyR', lb: 'KeyQ', back: 'Escape', start: 'KeyP',
});
const keysDown = new WeakMap();

/** which keys the state holds down */
export function keysFor(state, { keymap = KEYMAP, threshold = 0.35 } = {}) {
  const { axes, buttons } = toArrays(state);
  const want = new Set();
  if (axes[0] <= -threshold) want.add(keymap.steerLeft);
  if (axes[0] >= threshold) want.add(keymap.steerRight);
  if (buttons[BUTTON.rt] >= threshold) want.add(keymap.gas);
  if (buttons[BUTTON.lt] >= threshold) want.add(keymap.brake);
  for (const name of ['a', 'b', 'x', 'y', 'lb', 'rb', 'back', 'start']) {
    if (keymap[name] && buttons[BUTTON[name]] >= 0.5) want.add(keymap[name]);
  }
  return want;
}

/**
 * Node side, once per step. mode 'gamepad' (default) sets the virtual pad;
 * mode 'keyboard' presses/releases keys so the held set matches the state.
 * -> how many times the page has read the pad so far (gamepad mode), or the
 *    held keys (keyboard mode)
 */
export async function setPad(page, state, { mode = 'gamepad', keymap = KEYMAP, threshold = 0.35 } = {}) {
  if (mode === 'keyboard') {
    const want = keysFor(state, { keymap, threshold });
    const held = keysDown.get(page) || new Set();
    for (const k of held) if (!want.has(k)) await page.keyboard.up(k);
    for (const k of want) if (!held.has(k)) await page.keyboard.down(k);
    keysDown.set(page, want);
    return [...want];
  }
  return page.evaluate(padSetJs(state));
}

/** let go of everything (both paths) */
export async function releasePad(page) {
  const held = keysDown.get(page);
  if (held) for (const k of held) await page.keyboard.up(k).catch(() => {});
  keysDown.delete(page);
  await page.evaluate(padSetJs(neutralPad())).catch(() => {});
}
