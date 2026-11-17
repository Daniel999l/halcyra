/**
 * Her pad as real key presses on ANY page (an outside page running a DOS game
 * in a js-dos canvas, for example). The pilot keeps writing the standard pad;
 * this turns the latest pad into keys with a stage's key table
 * (src/stagekeys.js): steering, gas and brake by pulse width over 100 ms,
 * enter/exit and handbrake held while pressed.
 *
 * The keys go through Playwright's page.keyboard (CDP Input.dispatchKeyEvent),
 * so the page gets trusted key events in whatever element has focus. Every
 * second the game element (window.__halcyraTarget, set by the console's detect:
 * CONSOLE_CANVAS_SELECTOR or the largest canvas / iframe) is given focus again
 * if something else took it.
 */
import { padKeys } from './stagekeys.js';
import { toArrays } from './gamepad.js';
import { say } from './log.js';

const FOCUS_JS = `(() => {
  const el = window.__halcyraTarget;
  if (!el || !el.isConnected) return 'none';
  const a = document.activeElement;
  if (a === el || (el.contains && el.contains(a))) return 'kept';
  if (el.tagName !== 'IFRAME' && !el.hasAttribute('tabindex')) el.tabIndex = -1;
  try { el.focus({ preventScroll: true }); } catch (e) { return 'failed'; }
  return 'refocused';
})()`;

export class Keyer {
  constructor({ page, map, tickMs = 10, name = '' }) {
    this.page = page; this.map = map; this.tickMs = tickMs; this.name = name;
    this.pad = { axes: [0, 0, 0, 0], buttons: new Array(17).fill(0) };
    this.held = new Set();
    this.timer = null; this.busy = false; this.stopped = false;
    this.stats = { downs: 0, ups: 0, refocused: 0, errors: 0 };
    this.lastFocus = 0;
  }

  /** the latest pad from her tick ({ axes, buttons: {name: v} } as in a Tick) */
  setPad(pad) { if (pad) this.pad = toArrays(pad); }

  start() {
    if (this.timer) return this;
    this.timer = setInterval(() => { this.tick().catch(() => {}); }, this.tickMs);
    say(`keys on (${this.name || 'table'}: ${[this.map.steerLeft, this.map.steerRight, this.map.gas, this.map.brake, this.map.enterExit, this.map.handbrake].join(' ')}, pulse width over ${this.map.periodMs} ms)`, { kind: 'console' });
    return this;
  }

  async tick() {
    if (this.busy || this.stopped) return;
    this.busy = true;
    try {
      if (this.page.isClosed?.()) return;
      const want = new Set(padKeys(this.pad, this.map, performance.now()));
      for (const k of [...this.held]) if (!want.has(k)) { await this.page.keyboard.up(k); this.held.delete(k); this.stats.ups += 1; }
      for (const k of want) if (!this.held.has(k)) { await this.page.keyboard.down(k); this.held.add(k); this.stats.downs += 1; }
      if (Date.now() - this.lastFocus > 1000) {
        this.lastFocus = Date.now();
        if ((await this.page.evaluate(FOCUS_JS).catch(() => 'none')) === 'refocused') this.stats.refocused += 1;
      }
    } catch { this.stats.errors += 1; } finally { this.busy = false; }
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.timer); this.timer = null;
    for (const k of this.held) await this.page.keyboard.up(k).catch(() => {});
    this.held.clear();
  }
}
