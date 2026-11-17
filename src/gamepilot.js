/**
 * Her, attached to a console tab.
 *
 * Each step: hide the overlay, look at the tab, let her live on that picture
 * (and on the taste of the latest trades) for `ms` of brain time, turn her
 * descending neurons into a gamepad state, set the pad, draw her readout,
 * report a Tick.
 *
 * The pad is the only way she touches the game, and every number on it is a
 * documented function of her cell activity (src/gamebody.js toPad()).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { loadConnectomeNode, loadNeuronsNode } from '../site/fly/load.js';
import { findReadouts } from './gamebody.js';
import { BrainCore, makeShared } from './braincore.js';
import { Eye, OVERLAY_JS } from './eye.js';
import { GAMEPAD_INIT, padSetJs, setPad, toArrays } from './gamepad.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const FLY_DIR = path.join(HERE, '..', 'site', 'fly');

let CONNECTOME = null;
let NAMES = null;
let READOUTS = null;

/** a typed array copied once into a SharedArrayBuffer, so a worker can use it without a copy */
function toShared(arr) {
  const out = new arr.constructor(new SharedArrayBuffer(arr.byteLength));
  out.set(arr);
  return out;
}

/** loaded once and shared (22 MB of wiring, in SharedArrayBuffers so the brain worker reads the same memory) */
export async function loadFly() {
  if (CONNECTOME) return CONNECTOME;
  const c = await loadConnectomeNode(FLY_DIR);
  NAMES = await loadNeuronsNode(FLY_DIR);
  READOUTS = findReadouts(NAMES);
  CONNECTOME = { ...c, outPtr: toShared(c.outPtr), outPost: toShared(c.outPost), outW: toShared(c.outW) };
  return CONNECTOME;
}

/**
 * The brain in a worker thread, same interface as BrainCore.think but async.
 * If the worker dies it is started again (fresh brain, same seed) on the next look.
 */
class BrainThread {
  constructor(init) {
    this.init = init;
    this.worker = null; this.ready = null; this.pending = new Map(); this.nextId = 1; this.restarts = 0;
    this.start();
  }

  start() {
    this.shared = makeShared(this.init.connectome.N);
    this.a = new Float32Array(this.shared.a);
    const w = new Worker(new URL('./brainworker.js', import.meta.url), { workerData: { ...this.init, shared: this.shared } });
    this.worker = w;
    this.ready = new Promise((resolve, reject) => {
      w.once('message', (m) => (m && m.ready ? resolve() : reject(new Error('brain worker did not start'))));
      w.once('error', reject);
    });
    this.ready.catch(() => {});
    w.on('message', (m) => {
      if (!m || m.ready) return;
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error(`brain worker: ${String(m.error).split('\n')[0]}`)); else p.resolve(m);
    });
    const fail = (why) => {
      if (this.worker !== w) return;
      this.worker = null;
      for (const p of this.pending.values()) p.reject(new Error(`brain worker stopped (${why})`));
      this.pending.clear();
    };
    w.on('error', (e) => fail(e.message));
    w.on('exit', (code) => fail(`exit ${code}`));
  }

  async think(lum, ms, taste) {
    if (!this.worker) { this.restarts += 1; this.start(); }
    await this.ready;
    const id = this.nextId++;
    const t = taste ? { sweet: Number(taste.sweet) || 0, bitter: Number(taste.bitter) || 0 } : null;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker.postMessage({ id, lum, ms, taste: t }, [lum.buffer]);
    });
  }

  async close() {
    const w = this.worker; this.worker = null;
    if (w) await w.terminate().catch(() => {});
  }
}

export function flyNames() { return NAMES; }
export function flyReadouts() { return READOUTS; }

/** the fitted brain gains (site/fly/gains.json "brain"), read only */
export function brainGains() {
  try {
    return JSON.parse(fs.readFileSync(path.join(FLY_DIR, 'gains.json'), 'utf8')).brain || {};
  } catch {
    return {};
  }
}

const r4 = (v) => Math.round(v * 1e4) / 1e4;

/** mean and spread of a luminance grid: a picture with no contrast gives her nothing to see */
export function gridStats(g) {
  let s = 0; let s2 = 0; let lo = 1; let hi = 0;
  for (let i = 0; i < g.length; i += 1) { const v = g[i]; s += v; s2 += v * v; if (v < lo) lo = v; if (v > hi) hi = v; }
  const mean = s / g.length;
  return { mean: r4(mean), sd: r4(Math.sqrt(Math.max(0, s2 / g.length - mean * mean))), range: r4(hi - lo) };
}

export class GamePilot {
  /**
   * seed        brain noise seed
   * tasteCells  { sweet: number[], bitter: number[] } (findTasteCells) or null
   * body        overrides for GAMEBODY_DEFAULTS
   * eye         'frame' (default: the game element drawn small inside the page, see src/eye.js),
   *             'png' (full screenshot) or 'small' (CDP downscale; shrinks a real window, comparison only)
   * input       'gamepad' (default) or 'keyboard' (fallback)
   * overlay     draw her readout over the tab (default true)
   * thread      'main' (default: brain in this thread, pilot.brain / pilot.body usable)
   *             or 'worker' (brain in a worker thread: the event loop stays free
   *             while she thinks; same results bit for bit)
   */
  constructor({ seed = Date.now() % 100000, tasteCells = null, body = {}, eye = 'frame', input = 'gamepad', overlay = true, settle = 20, thread = 'main' } = {}) {
    if (!CONNECTOME) throw new Error('call await loadFly() before making a GamePilot');
    this.gains = brainGains();
    this.seed = seed;
    this.tasteCells = tasteCells ? { sweet: [...(tasteCells.sweet || [])], bitter: [...(tasteCells.bitter || [])] } : null;
    const init = { connectome: CONNECTOME, readouts: READOUTS, gains: this.gains, seed, tasteCells: this.tasteCells, body, settle };
    this.thread = thread === 'worker' ? 'worker' : 'main';
    if (this.thread === 'worker') {
      this.core = new BrainThread(init);
      this.brain = null; this.body = null;
    } else {
      this.core = new BrainCore(init);
      this.brain = this.core.brain; this.body = this.core.body;
    }
    this.N = CONNECTOME.N;
    this.names = NAMES;
    this.eyeMode = eye;
    this.input = input;
    this.overlay = overlay;
    this.eye = null;
    this.steps = 0;
    this.commits = 0;
    this.escapes = 0;
    this.last = null;
    this.lastPerf = null;
    this.top = [];
  }

  /** her activity right now, all cells (in worker mode: a view of the shared memory, read it between steps) */
  activity() { return this.thread === 'worker' ? this.core.a : this.brain.a; }

  /** put the virtual gamepad and the overlay into a page (idempotent) */
  async attach(page) {
    // native console (src/native/console.js): no page, the port is the eye and the pad
    if (page && page.native) { this.eye = { mode: 'native', lastPath: 'native', fallbacks: 0, look: async (p) => { const g = p.look(); if (!g) throw new Error('no screen frame yet'); return g; }, close: async () => {} }; this.eyeMode = 'native'; return this; }
    await page.addInitScript(GAMEPAD_INIT);
    await page.evaluate(GAMEPAD_INIT).catch(() => {});
    if (this.overlay) await page.evaluate(OVERLAY_JS).catch(() => {});
    const vp = (page.viewportSize && page.viewportSize()) || { width: 1280, height: 720 };
    this.eye = await new Eye({ mode: this.eyeMode, width: vp.width, height: vp.height }).open(page);
    this.eyeMode = this.eye.mode;
    return this;
  }

  /** one look-and-act. -> Tick */
  async step(page, { ms = 160, taste = null } = {}) {
    if (!this.eye) await this.attach(page);
    const t0 = performance.now();
    // the 'frame' eye reads the game element itself, so the overlay is never in
    // her picture; the screenshot eyes hide it for the capture
    const hide = this.overlay && this.eye.mode !== 'frame' && this.eye.mode !== 'native';
    if (hide) await page.evaluate('window.__fly && window.__fly.hide()').catch(() => {});
    const lum = await this.eye.look(page);
    // back on straight away: she has her picture, and the brain step below
    // takes hundreds of ms, which would otherwise leave the overlay off-screen
    // for almost the whole step
    if (hide) await page.evaluate('window.__fly && window.__fly.show()').catch(() => {});
    const t1 = performance.now();
    const sight = gridStats(lum); // before the grid is handed (transferred) to the worker
    const r = await this.think(lum, ms, taste);
    const { out, active } = r;
    this.top = r.top;
    const t2 = performance.now();

    this.steps += 1;
    if (out.commit) this.commits += 1;
    if (out.escape) this.escapes += 1;
    const dn = {};
    for (const [k, v] of Object.entries(out.dn)) dn[k] = r4(v);
    const pad = {
      axes: out.pad.axes.map(r4),
      buttons: Object.fromEntries(Object.entries(out.pad.buttons).map(([k, v]) => [k, r4(v)])),
    };
    const view = { active, L: dn.L, R: dn.R, pad };
    const drawJs = this.overlay
      ? `window.__fly && (window.__fly.show(), window.__fly.draw(${JSON.stringify(view)}))`
      : '0';
    let reads = null;
    if (page && page.native) {
      reads = page.setPad(pad); // the same pad state, to the OS-level virtual controller
    } else if (this.input === 'keyboard') {
      await setPad(page, pad, { mode: 'keyboard' });
      await page.evaluate(drawJs).catch(() => {});
    } else {
      // pad and overlay in one round trip
      reads = await page.evaluate(`(() => { const r = ${padSetJs(pad)}; ${drawJs}; return r; })()`).catch(() => null);
    }
    const t3 = performance.now();

    this.lastPerf = { capture: t1 - t0, brain: t2 - t1, brainCompute: r.brainMs, pad: t3 - t2, total: t3 - t0, reads };
    const tasteIn = taste ? {
      sweet: r4(Number(taste.sweet) || 0), bitter: r4(Number(taste.bitter) || 0),
      applied: Array.isArray(taste.applied) ? taste.applied : [],
    } : { sweet: 0, bitter: 0, applied: [] };
    this.last = {
      step: this.steps,
      t: Date.now(),
      ms,
      taste: tasteIn,
      drove: out.drove,
      dn,
      active,
      pad,
      commit: out.commit,
      escape: out.escape,
      lit: r.lit,
    };
    this.lastView = { ...sight, seen: r4(out.seen) };
    return this.last;
  }

  /** one window of brain time on a luminance grid, no page (main thread or worker) */
  async think(lum, ms = 160, taste = null) {
    return this.core.think(lum, ms, taste);
  }

  /** the pad as the page's arrays, for anyone checking the page read it */
  padArrays() { return this.last ? toArrays(this.last.pad) : null; }

  /** the cells that are busiest right now, for the brain map */
  lit(k = 600, th = 0.12) {
    const a = this.activity();
    const out = [];
    for (let i = 0; i < a.length; i += 1) if (a[i] >= th) out.push(i);
    out.sort((x, y) => a[y] - a[x]);
    return out.slice(0, k).map((i) => [i, Math.round(a[i] * 100) / 100]);
  }

  /** compact snapshot for the site */
  telemetry() {
    const l = this.last;
    if (!l) return null;
    const names = this.names;
    const top = (this.top || []).map(([i, v]) => ({
      i,
      type: (names[i] && (names[i].type || names[i].cls)) || String(i),
      cls: (names[i] && names[i].cls) || '',
      v,
    }));
    return {
      t: l.t, step: l.step, ms: l.ms,
      dn: l.dn, pad: l.pad, active: l.active,
      commit: l.commit, escape: l.escape,
      commits: this.commits, escapes: this.escapes,
      taste: { sweet: l.taste.sweet, bitter: l.taste.bitter }, drove: l.drove,
      top,
      eye: this.eyeMode, eyePath: this.eye?.lastPath || null, eyeFallbacks: this.eye?.fallbacks || 0, input: this.input, thread: this.thread,
      perf: this.lastPerf && {
        capture: Math.round(this.lastPerf.capture), brain: Math.round(this.lastPerf.brain),
        pad: Math.round(this.lastPerf.pad), total: Math.round(this.lastPerf.total),
      },
    };
  }

  async detach() { await this.eye?.close(); this.eye = null; }

  /** stop the brain worker (worker mode); the pilot cannot step after this */
  async close() { await this.detach().catch(() => {}); if (this.thread === 'worker') await this.core.close(); }
}
