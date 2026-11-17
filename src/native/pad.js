/**
 * The native gamepad: a virtual Xbox 360 controller at OS level, held by a
 * small Python child (src/native/feeder.py, `vgamepad` + the ViGEmBus driver).
 *
 * In:  the SAME pad state the browser path uses (src/gamepad.js, what
 *      GamePilot puts in every Tick):
 *        { axes: [lx, ly, rx, ry], buttons: { a, b, x, y, lb, rb, lt, rt, back, start, ... } }
 *      W3C standard mapping: stick Y positive = DOWN, triggers are buttons 6/7.
 * Out: one JSON line per update on the feeder's stdin, in XInput terms
 *      (stick Y positive = UP, so Y is negated here):
 *        {"lx":0.12,"ly":0.5,"rx":0,"ry":0,"lt":0,"rt":0.8,"btn":["Y"]}
 *      A digital button is held when its value is >= 0.5.
 *
 * Rate: at most one line per 1000 / hz ms (default 60 Hz). Newer states that
 * arrive in between replace the waiting one (only the newest is sent). A line
 * equal to the last one sent is not repeated, except once a second.
 * The feeder dying -> started again with backoff (0.5 s doubling to 30 s), and
 * the newest state is sent again as soon as it says "ready".
 * close() -> a neutral line, stdin closed (the feeder also goes neutral on EOF).
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toArrays, BUTTON } from '../gamepad.js';
import { say } from '../log.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FEEDER_PY = path.join(HERE, 'feeder.py');

/** standard-mapping name -> XInput name the feeder knows */
export const XINPUT_NAMES = Object.freeze({
  a: 'A', b: 'B', x: 'X', y: 'Y', lb: 'LB', rb: 'RB', back: 'BACK', start: 'START',
  ls: 'LS', rs: 'RS', up: 'UP', down: 'DOWN', left: 'LEFT', right: 'RIGHT', home: 'GUIDE',
});
const r4 = (v) => Math.round(v * 1e4) / 1e4;

/** GamePilot pad state -> the feeder's line object (pure) */
export function toFeederState(state) {
  const { axes, buttons } = toArrays(state);
  const btn = [];
  for (const [k, X] of Object.entries(XINPUT_NAMES)) if (buttons[BUTTON[k]] >= 0.5) btn.push(X);
  return {
    lx: r4(axes[0]), ly: r4(-axes[1]) || 0, rx: r4(axes[2]), ry: r4(-axes[3]) || 0,
    lt: r4(buttons[BUTTON.lt]), rt: r4(buttons[BUTTON.rt]), btn,
  };
}
export const NEUTRAL_LINE = JSON.stringify({ lx: 0, ly: 0, rx: 0, ry: 0, lt: 0, rt: 0, btn: [] });

/** the default way to start the feeder on this machine */
export function defaultFeeder({ python = '' } = {}) {
  const py = python || (process.platform === 'win32' ? 'python' : 'python3');
  return { command: py, args: ['-u', FEEDER_PY] };
}

export class NativePad {
  /**
   * command, args   how to start the feeder (default: python feeder.py)
   * hz              most lines per second (default 60)
   * onStatus(s)     { state: 'starting'|'ready'|'restarting'|'off', restarts, lines, lastError }
   */
  constructor({ command, args, hz = 60, onStatus = () => {}, onOutput = null, env } = {}) {
    const d = defaultFeeder();
    this.command = command || d.command; this.args = args || d.args; this.env = env;
    this.minMs = Math.max(1, Math.round(1000 / Math.max(1, hz)));
    this.onStatus = onStatus; this.onOutput = onOutput; // onOutput(line): every other line the feeder prints
    this.proc = null; this.ready = false; this.closed = false;
    this.latest = NEUTRAL_LINE; this.lastSent = null; this.lastSentAt = 0; this.timer = null;
    this.backoff = 500; this.restarts = 0; this.lines = 0; this.lastError = null; this.startedAt = 0;
    this.status = { state: 'off' };
  }

  set(p) { this.status = { ...this.status, ...p, restarts: this.restarts, lines: this.lines, lastError: this.lastError }; try { this.onStatus(this.status); } catch { /* listener */ } }

  start() { this.closed = false; this.spawn(); return this; }

  /** resolves when the feeder said "ready" (or rejects after ms) */
  whenReady(ms = 15000) {
    if (this.ready) return Promise.resolve(true);
    return new Promise((resolve, reject) => {
      const t0 = Date.now();
      const iv = setInterval(() => {
        if (this.ready) { clearInterval(iv); resolve(true); }
        else if (Date.now() - t0 > ms) { clearInterval(iv); reject(new Error(`the pad feeder did not say ready in ${ms} ms${this.lastError ? `: ${this.lastError}` : ''}`)); }
      }, 20);
    });
  }

  spawn() {
    this.ready = false;
    this.startedAt = Date.now();
    this.set({ state: 'starting' });
    let p;
    try {
      p = spawn(this.command, this.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: this.env || process.env });
    } catch (e) { this.lastError = e.message; this.scheduleRestart(); return; }
    this.proc = p;
    let out = ''; let errTail = '';
    p.stdout.on('data', (d) => {
      out += d.toString();
      let i;
      while ((i = out.indexOf('\n')) >= 0) {
        const line = out.slice(0, i).trim(); out = out.slice(i + 1);
        if (line === 'ready' && !this.ready) {
          this.ready = true;
          this.set({ state: 'ready' });
          this.lastSent = null; // send the newest state again to a fresh pad
          this.flush();
        } else if (line && this.onOutput) { try { this.onOutput(line); } catch { /* listener */ } }
      }
      if (out.length > 1 << 16) out = '';
    });
    p.stderr.on('data', (d) => { errTail = (errTail + d.toString()).slice(-600); });
    p.stdin.on('error', () => { /* the feeder went away; close handler restarts it */ });
    p.on('error', (e) => { this.lastError = e.message; });
    p.on('close', (code) => {
      if (this.proc !== p) return;
      this.proc = null; this.ready = false;
      clearTimeout(this.timer); this.timer = null;
      if (this.closed) { this.set({ state: 'off', exitCode: code }); return; }
      const tail = errTail.trim().split('\n').slice(-2).join(' | ');
      this.lastError = `feeder exited ${code}${tail ? `: ${tail}` : ''}`;
      say(`${this.lastError}; again in ${this.backoff / 1000} s`, { kind: 'pad' });
      this.scheduleRestart();
    });
  }

  scheduleRestart() {
    if (this.closed) return;
    if (Date.now() - this.startedAt > 60000) this.backoff = 500; // it ran fine for a while
    this.restarts += 1;
    this.set({ state: 'restarting' });
    const wait = this.backoff;
    this.backoff = Math.min(30000, this.backoff * 2);
    setTimeout(() => { if (!this.closed) this.spawn(); }, wait);
  }

  /** the pad state from GamePilot (standard mapping); -> lines sent so far */
  setPad(state) {
    this.latest = JSON.stringify(toFeederState(state));
    this.flush();
    return this.lines;
  }

  /** send the newest line now if the rate allows, else once it does */
  flush() {
    // a waiting keep-alive never holds back a new state
    if (this.timer && this.timerKind === 'keepalive' && this.latest !== this.lastSent) { clearTimeout(this.timer); this.timer = null; }
    if (this.timer || !this.ready || !this.proc) return;
    const since = Date.now() - this.lastSentAt;
    if (since < this.minMs) { this.later('rate', this.minMs - since); return; }
    if (this.latest === this.lastSent && since < 1000) {
      // nothing new: a keep-alive copy once a second
      this.later('keepalive', 1000 - since);
      return;
    }
    this.write(this.latest);
    this.later('keepalive', 1000);
  }

  later(kind, ms) {
    this.timerKind = kind;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, ms);
    this.timer.unref?.();
  }

  write(line) {
    const p = this.proc;
    if (!p || !p.stdin.writable) return false;
    p.stdin.write(`${line}\n`);
    this.lastSent = line; this.lastSentAt = Date.now(); this.lines += 1;
    return true;
  }

  /** sticks centred, nothing pressed, right now (no rate limit) */
  neutral() { this.latest = NEUTRAL_LINE; clearTimeout(this.timer); this.timer = null; return this.write(NEUTRAL_LINE); }

  /** a neutral line, then stdin closed; resolves when the feeder is gone */
  close() {
    this.closed = true;
    clearTimeout(this.timer); this.timer = null;
    const p = this.proc;
    if (!p) { this.set({ state: 'off' }); return Promise.resolve(); }
    return new Promise((resolve) => {
      const t = setTimeout(() => { try { p.kill(); } catch { /* gone */ } resolve(); }, 3000);
      p.once('close', () => { clearTimeout(t); resolve(); });
      try { this.write(NEUTRAL_LINE); p.stdin.end(); } catch { try { p.kill(); } catch { /* gone */ } }
    });
  }
}
