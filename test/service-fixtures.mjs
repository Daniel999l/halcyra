/**
 * Stand-ins for the other parts, used only by test/service-*.mjs. Each one
 * implements the pilot interface and nothing more. Not served, not
 * imported by src/.
 */
import { makeConfig } from '../src/config.js';

let rnd = 12345;
const rand = () => { rnd = (rnd * 1103515245 + 12345) % 2147483648; return rnd / 2147483648; };
const BUTTONS = ['a', 'b', 'x', 'y', 'lb', 'rb', 'lt', 'rt', 'back', 'start', 'ls', 'rs', 'up', 'down', 'left', 'right', 'home'];

/** a tick shaped like the pilot's: smooth, so it compresses like the real thing roughly would */
export function fakeTick(step, taste = null) {
  const s = step / 10;
  const w = (k) => Math.max(0, Math.sin(s + k) * 0.5 + 0.5 + (rand() - 0.5) * 0.05);
  return {
    step,
    t: Date.now(),
    ms: 160,
    taste: taste || { sweet: 0, bitter: 0, applied: [] },
    drove: { lamina: 3288, sweet: taste?.sweet > 0 ? 21 : 0, bitter: taste?.bitter > 0 ? 10 : 0 },
    dn: { L: w(0), R: w(1), DNa01: w(2), DNa02: w(3), DNp09: w(4), oviDNb: w(5), MDN: w(6), DNg11: w(7) },
    active: 2000 + Math.round(w(8) * 3000),
    pad: { axes: [w(9) * 2 - 1, w(10) * 2 - 1, 0, 0], buttons: Object.fromEntries(BUTTONS.map((b, i) => [b, i < 4 ? (w(11 + i) > 0.9 ? 1 : 0) : 0])) },
    commit: false,
    escape: false,
    lit: Array.from({ length: 50 }, (_, i) => [i * 97 % 139255, Math.round(w(i) * 100) / 100]),
  };
}

export const standinPilot = {
  async loadFly() { return { N: 139255, E: 2700513 }; },
  flyNames() { return Array.from({ length: 10 }, (_, i) => ({ id: `72057594037${i}`, type: i < 3 ? 'GRN-sweet' : 'GRN-bitter', side: 'right', cls: 'sensory' })); },
  flyReadouts() { return { dnLeft: [1, 2], dnRight: [3], types: { DNa01: { L: [1], R: [3] } } }; },
  GamePilot: class {
    constructor() { this.n = 0; this.attached = 0; }
    async attach() { this.attached += 1; return this; }
    async detach() {}
    async step(page, { taste } = {}) { this.n += 1; return fakeTick(this.n, taste); }
    telemetry() { return { step: this.n }; }
  },
};

export const standinTaste = {
  findTasteCells() { return { sweet: [0, 1, 2], bitter: [3, 4], meta: { sweetTypes: { 'GRN-sweet|right': 3 }, bitterTypes: { 'GRN-bitter|right': 2 }, source: 'test stand-in' } }; },
  Taste: class {
    constructor() { this.pending = []; }
    push(t) { this.pending.push(t); return true; }
    sample() {
      const applied = this.pending.map((t) => ({ sig: t.sig, side: t.side, sol: t.sol, wallet: t.wallet, level: 0.5 }));
      this.pending = [];
      return { sweet: applied.some((a) => a.side === 'buy') ? 0.5 : 0, bitter: applied.some((a) => a.side === 'sell') ? 0.5 : 0, applied };
    }
  },
};

/** emits one trade every `every` polls; the last created watcher is exposed for tests */
export function standinChain({ every = 3 } = {}) {
  const m = {
    last: null,
    createTradeWatcher({ mint, onTrade, onSlot, fromSlot }) {
      let slot = fromSlot || 1000; let n = 0; let timer = null;
      const w = {
        mint, fromSlot,
        pollOnce() {
          slot += 1; n += 1;
          if (n % every === 0) onTrade({ sig: `testsig${slot}`, side: n % (every * 2) === 0 ? 'sell' : 'buy', wallet: 'TestWallet1111111111111111111111111111111111', sol: 0.25, tokens: '1000000', slot, ts: Date.now(), venue: 'curve' });
          onSlot?.(slot);
        },
        start() { timer = setInterval(() => w.pollOnce(), 30); },
        stop() { clearInterval(timer); },
      };
      m.last = w;
      return w;
    },
  };
  return m;
}

/** a console that is "playing" at once; page is a plain object */
export function fakeConsoleFactory() {
  return async (o) => ({
    playing: false,
    start() { this.playing = true; o.onStatus('playing', ''); o.onReady({ fake: true }).catch(() => {}); o.onFrame(Buffer.from([0xff, 0xd8, 0xff, 0xd9])); return this; },
    async stop() { this.playing = false; },
  });
}

export function testConfig(over = {}) {
  const c = makeConfig();
  const merge = (a, b) => { for (const [k, v] of Object.entries(b)) { if (v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object') merge(a[k], v); else a[k] = v; } return a; };
  // nothing from the environment leaks into a test
  c.tokenCa = ''; c.console.url = ''; c.stream.url = ''; c.mongo.uri = ''; c.port = 0;
  return merge(c, over);
}

export async function getJson(base, path) {
  const r = await fetch(base + path);
  const text = await r.text();
  return { status: r.status, headers: r.headers, body: text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : null, text };
}

/** minimal SSE reader -> { events: [{event, data}], close() } */
export async function sse(url) {
  const ctl = new AbortController();
  const r = await fetch(url, { signal: ctl.signal });
  const events = [];
  const reader = r.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, i); buf = buf.slice(i + 2);
          const ev = /^event: (.*)$/m.exec(block)?.[1];
          const data = /^data: (.*)$/m.exec(block)?.[1];
          if (ev && data) events.push({ event: ev, data: JSON.parse(data) });
        }
      }
    } catch { /* aborted */ }
  })();
  return { events, headers: r.headers, close: () => ctl.abort() };
}

export function check(results) {
  return (ok, name, detail = '') => {
    results.push({ ok, name });
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  (${detail})` : ''}`);
    return ok;
  };
}

export function finish(results, title) {
  const bad = results.filter((r) => !r.ok);
  console.log(`\n${title}: ${results.length - bad.length}/${results.length} passed`);
  if (bad.length) process.exitCode = 1;
}
