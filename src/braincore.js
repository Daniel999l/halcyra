/**
 * Her brain and body without a page: FlyRate (site/fly/rate.js, untouched)
 * plus GameBody (src/gamebody.js). One look in, one window of brain time,
 * readouts and pad out.
 *
 * The same class runs in two places:
 *   - in the main thread (GamePilot { thread: 'main' }, tests, offline scripts)
 *   - inside src/brainworker.js (GamePilot { thread: 'worker' }, the service),
 *     so the brain's hundreds of ms of maths never block the event loop.
 * Same code, same seed, same inputs -> bit-identical activity in both places
 * (test/brain-worker.mjs checks every cell's V, a and w after every step).
 *
 * `shared`: optional SharedArrayBuffers for the state arrays (a, V, w). The
 * worker uses them so the main thread can read her whole activity without a
 * copy. Swapping the arrays happens before the first step, while they are
 * still all zero, so nothing she computes changes.
 *
 * `snapshots: true` replaces FlyRate's noise generator with the same
 * mulberry32 written as an object, so its state can be saved and restored
 * (the stream of numbers is identical; checked in test/brain-worker.mjs).
 * Only the paired taste experiment uses it, to branch one run into several.
 */
import { FlyRate } from '../site/fly/rate.js';
import { GameBody, blur } from './gamebody.js';
import { GRID_W, GRID_H } from './eye.js';

/** mulberry32 exactly as site/fly/rate.js, with its state in the open */
export class Mulberry32 {
  constructor(seed) { this.a = seed >>> 0; }
  next() {
    let a = this.a;
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    this.a = a;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
}

const STATE = ['V', 'a', 'w'];

export function makeShared(N) {
  return Object.fromEntries(STATE.map((k) => [k, new SharedArrayBuffer(N * 4)]));
}

export class BrainCore {
  /**
   * connectome  { N, E, outPtr, outPost, outW, eyemap }
   * readouts    findReadouts(names)
   * gains       site/fly/gains.json "brain"
   */
  constructor({ connectome, readouts, gains = {}, seed = 783, tasteCells = null, body = {}, settle = 20, shared = null, snapshots = false }) {
    this.brain = new FlyRate(connectome, { ...gains, seed });
    if (shared) {
      for (const k of STATE) {
        const arr = new Float32Array(shared[k]);
        if (arr.length !== this.brain.N) throw new Error(`shared ${k} has ${arr.length} cells, brain has ${this.brain.N}`);
        arr.set(this.brain[k]);
        this.brain[k] = arr;
      }
    }
    if (snapshots) {
      this.rng = new Mulberry32(seed ?? 783);
      this.brain.rand = () => this.rng.next();
    }
    this.tasteCells = tasteCells ? { sweet: [...(tasteCells.sweet || [])], bitter: [...(tasteCells.bitter || [])] } : null;
    this.body = new GameBody(this.brain, connectome.eyemap, readouts, body, this.tasteCells);
    this.brain.step(settle); // let her settle
  }

  /** one look: lum = Float32Array GRID_W*GRID_H, ms of brain time, taste sample or null */
  think(lum, ms, taste = null) {
    const t0 = performance.now();
    const bl = blur(lum, GRID_W, GRID_H, this.body.p.blurSigma);
    const out = this.body.live(lum, GRID_W, GRID_H, ms, bl, taste);
    const b = this.body.brain; // the brain the body drives (a test may swap in a zero brain)
    const active = b.activeCount(0.12);
    const lit = this.lit(600, 0.12, b);
    const top = b.top(6, 0.12).map((i) => [i, Math.round(b.a[i] * 100) / 100]);
    return { out, active, lit, top, brainMs: performance.now() - t0 };
  }

  /** the cells that are busiest right now, for the brain map */
  lit(k = 600, th = 0.12, b = this.brain) {
    const a = b.a;
    const out = [];
    for (let i = 0; i < a.length; i += 1) if (a[i] >= th) out.push(i);
    out.sort((x, y) => a[y] - a[x]);
    return out.slice(0, k).map((i) => [i, Math.round(a[i] * 100) / 100]);
  }

  /** everything that makes her future, copied (needs snapshots: true for the noise) */
  snapshot() {
    if (!this.rng) throw new Error('snapshot() needs a BrainCore made with snapshots: true');
    const b = this.brain; const y = this.body;
    return {
      V: b.V.slice(), a: b.a.slice(), w: b.w.slice(), input: b.input.slice(), driven: b.driven.slice(),
      nDriven: b.nDriven, t: b.t, steps: b.steps, rng: this.rng.a,
      eyes: y.eyes.map((e) => ({ prev: e.prev.slice(), seen: e.seen })),
      sacc: y.sacc, layMs: y.layMs, sinceLay: y.sinceLay, seen: y.seen, taste: { ...y.taste },
    };
  }

  restore(s) {
    const b = this.brain; const y = this.body;
    b.V.set(s.V); b.a.set(s.a); b.w.set(s.w); b.input.set(s.input); b.driven.set(s.driven);
    b.nDriven = s.nDriven; b.t = s.t; b.steps = s.steps; this.rng.a = s.rng;
    s.eyes.forEach((e, i) => { y.eyes[i].prev.set(e.prev); y.eyes[i].seen = e.seen; });
    y.sacc = s.sacc; y.layMs = s.layMs; y.sinceLay = s.sinceLay; y.seen = s.seen; y.taste = { ...s.taste };
  }
}
