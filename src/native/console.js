/**
 * The native console: the game is a normal program on THIS machine (a
 * Windows cloud PC), so there is no browser tab at all.
 *
 *   pad     a virtual Xbox 360 controller at OS level (src/native/pad.js)
 *   eye     one ffmpeg grabbing the desktop (src/native/screen.js)
 *   frame   /api/frame.jpg from that same grab
 *
 * Same interface the main loop uses for the browser ConsoleTab
 * (src/index.js): start(), stop(), playing, and the onStatus / onReady /
 * onLost / onFrame callbacks. What it hands to onReady is a "port" that
 * GamePilot accepts in place of a Playwright page (port.native === true):
 *   port.look()       -> her luminance grid (Float32Array 160 x 90, 0..1) of the newest frame
 *   port.setPad(pad)  -> the Tick's pad state, unchanged, goes to the feeder
 *
 * States: off, starting, playing (a fresh frame in the last STALE_MS),
 * no-picture (no fresh frame), error. The pad's own state is in the detail.
 */
import { say } from '../log.js';
import { NativePad, defaultFeeder } from './pad.js';
import { Screen } from './screen.js';

export class NativeConsole {
  /**
   * cfg        whole config (cfg.native, cfg.stream.ffmpeg, cfg.dataDir)
   * pad, screen  (tests) ready-made stand-ins with the same methods
   */
  constructor({ cfg, onStatus = () => {}, onReady = async () => {}, onLost = async () => {}, onFrame = () => {}, onPage = null, pad = null, screen = null }) {
    this.cfg = cfg; const n = cfg.native || {};
    this.onStatus = onStatus; this.onReady = onReady; this.onLost = onLost; this.onFrame = onFrame;
    this.staleMs = n.staleMs || 3000;
    const feeder = n.feeder ? splitCmd(n.feeder) : defaultFeeder({ python: n.python });
    this.pad = pad || new NativePad({ ...feeder, hz: n.padHz || 60, onStatus: (s) => { this.padStatus = s; } });
    this.screen = screen || new Screen({
      ffmpeg: cfg.stream?.ffmpeg || 'ffmpeg', capture: n.capture || 'auto', fps: n.eyeFps || 10,
      jpegFps: n.jpegFps || 1, jpegWidth: n.jpegWidth || 640, jpegMode: n.jpegMode || 'fd3',
      dataDir: cfg.dataDir, display: cfg.stream?.display || process.env.DISPLAY || ':0',
      onJpeg: (b) => { try { this.onFrame(b); } catch { /* listener */ } },
    });
    this.state = 'off'; this.detail = ''; this.stopped = false; this.timer = null;
    this.padStatus = { state: 'off' };
    const self = this;
    this.port = {
      native: true,
      kind: 'native',
      look() { return self.screen.look(); },
      setPad(state) { return self.pad.setPad(state); },
      screenInput() { return self.screen.kind; },
    };
  }

  set(state, detail = '') {
    if (state !== this.state || detail !== this.detail) say(`${state}${detail ? ` (${detail})` : ''}`, { kind: 'console' });
    this.state = state; this.detail = detail;
    try { this.onStatus(state, detail); } catch { /* listener */ }
  }

  get playing() { return this.state === 'playing' && this.screen.age() < this.staleMs; }
  get page() { return this.port; }

  start() {
    this.stopped = false;
    this.set('starting', 'native: virtual pad + desktop capture');
    this.pad.start();
    this.screen.start();
    this.timer = setInterval(() => this.check().catch(() => {}), 250);
    return this;
  }

  async check() {
    if (this.stopped) return;
    const fresh = this.screen.age() < this.staleMs;
    const padNote = `pad ${this.padStatus?.state || this.pad.status?.state || 'off'}, screen ${this.screen.kind}`;
    if (fresh && this.state !== 'playing') {
      this.set('playing', padNote);
      try { await this.onReady(this.port); } catch (e) { say(`onReady: ${e.message}`, { kind: 'console' }); }
    } else if (!fresh && this.state === 'playing') {
      this.set('no-picture', `no screen frame for ${Math.round(this.staleMs / 1000)} s (${this.screen.lastError || 'capture restarting'})`);
      try { await this.onLost(); } catch { /* listener */ }
    } else if (this.state === 'playing' && padNote !== this.detail) {
      this.set('playing', padNote);
    } else if (this.state === 'starting' && this.screen.lastError && this.detail !== this.screen.lastError) {
      this.set('starting', this.screen.lastError);
    }
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.timer); this.timer = null;
    await Promise.allSettled([this.pad.close(), this.screen.stop()]);
    this.set('off');
  }
}

/** "python C:\\x\\feeder.py --dry" -> { command, args } (quotes allowed) */
export function splitCmd(s) {
  const parts = String(s).match(/"[^"]*"|'[^']*'|\S+/g) || [];
  const clean = parts.map((p) => p.replace(/^["']|["']$/g, ''));
  return { command: clean[0], args: clean.slice(1) };
}
