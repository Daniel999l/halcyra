/**
 * The brain in a worker thread is the same brain.
 *
 *   node test/brain-worker.mjs
 *
 * 1. Same seed, same pictures, same taste: a GamePilot with thread 'main' and
 *    one with thread 'worker' give bit-identical V, a and w for every one of
 *    the 139,255 cells after every look, and identical readouts, pad, lit, top.
 * 2. BrainCore { snapshots: true } (the open noise generator the paired taste
 *    experiment uses) gives the same bits too, and restore() replays exactly.
 * 3. The wiring and her activity are shared memory, not copies.
 * 4. While she thinks in the worker the event loop keeps running (a 1 ms timer
 *    is never late by more than 50 ms); in the main thread it is blocked for the
 *    whole window.
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { loadFly, flyNames, flyReadouts, brainGains, GamePilot } from '../src/gamepilot.js';
import { BrainCore } from '../src/braincore.js';
import { findTasteCells } from '../src/taste.js';
import { GRID_W, GRID_H } from '../src/eye.js';

let fails = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) fails += 1; };
console.log('brain-worker\n');

const c = await loadFly();
const tasteCells = findTasteCells(flyNames());

/** a city-ish picture that slides, so the lamina sees spatial and temporal contrast */
function picture(i) {
  const g = new Float32Array(GRID_W * GRID_H);
  for (let y = 0; y < GRID_H; y += 1) for (let x = 0; x < GRID_W; x += 1) {
    const u = (x + i * 3) % 40; const v = (y + i) % 30;
    g[y * GRID_W + x] = (u < 12 && v < 10) ? 0.15 : (u < 20 ? 0.55 : 0.8);
  }
  return g;
}
const tastes = (i) => (i % 4 === 1 ? { sweet: 0.6, bitter: 0 } : i % 4 === 2 ? { sweet: 0.3, bitter: 0.4 } : i % 4 === 3 ? { sweet: 0, bitter: 0.9 } : null);
const sameBits = (x, y) => x.length === y.length && Buffer.compare(Buffer.from(x.buffer, x.byteOffset, x.byteLength), Buffer.from(y.buffer, y.byteOffset, y.byteLength)) === 0;

const SEED = 4242; const LOOKS = 12; const MS = 80;
const A = new GamePilot({ seed: SEED, tasteCells, thread: 'main' });
const B = new GamePilot({ seed: SEED, tasteCells, thread: 'worker' });
const C = new BrainCore({ connectome: c, readouts: flyReadouts(), gains: brainGains(), seed: SEED, tasteCells, snapshots: true });

ok(c.outW.buffer instanceof SharedArrayBuffer && c.outPost.buffer instanceof SharedArrayBuffer && c.outPtr.buffer instanceof SharedArrayBuffer, 'the wiring is in SharedArrayBuffers (the worker reads the same 22 MB, no copy)');

let allSame = true; let outSame = true; let cSame = true; let firstBad = null;
let snap = null; const afterSnap = [];
for (let i = 0; i < LOOKS; i += 1) {
  const ra = await A.think(picture(i), MS, tastes(i));
  const rb = await B.think(picture(i), MS, tastes(i));
  const rc = C.think(picture(i), MS, tastes(i));
  const sh = B.core.shared;
  const same = sameBits(A.brain.a, new Float32Array(sh.a)) && sameBits(A.brain.V, new Float32Array(sh.V)) && sameBits(A.brain.w, new Float32Array(sh.w));
  if (!same) { allSame = false; if (firstBad == null) firstBad = i; }
  const strip = (r) => JSON.stringify({ out: r.out, active: r.active, lit: r.lit, top: r.top });
  if (strip(ra) !== strip(rb)) outSame = false;
  if (!(sameBits(A.brain.a, C.brain.a) && sameBits(A.brain.V, C.brain.V) && sameBits(A.brain.w, C.brain.w)) || strip(ra) !== strip(rc)) cSame = false;
  if (i === 5) snap = C.snapshot();
  if (i > 5) afterSnap.push({ a: C.brain.a.slice(), V: C.brain.V.slice(), r: strip(rc) });
}
ok(allSame, `worker vs main thread: V, a, w of all ${c.N.toLocaleString()} cells bit-identical after each of ${LOOKS} looks of ${MS} ms (with taste on 9 of them)${firstBad != null ? `; first difference at look ${firstBad}` : ''}`);
ok(outSame, 'worker vs main thread: readouts, pad, commit/escape, drove, active, lit and top identical on every look');
ok(cSame, 'BrainCore with the open noise generator (snapshots: true) gives the same bits as FlyRate\'s own');
C.restore(snap);
let replayOk = true;
for (let i = 6; i < LOOKS; i += 1) {
  const rc = C.think(picture(i), MS, tastes(i));
  const want = afterSnap[i - 6];
  const strip = JSON.stringify({ out: rc.out, active: rc.active, lit: rc.lit, top: rc.top });
  if (!sameBits(C.brain.a, want.a) || !sameBits(C.brain.V, want.V) || strip !== want.r) replayOk = false;
}
ok(replayOk, 'snapshot() at look 6 then restore(): the next 6 looks replay bit for bit');

// the event loop while she thinks
async function lagDuring(pilot, n) {
  const h = monitorEventLoopDelay({ resolution: 5 }); h.enable();
  let maxGap = 0; let last = performance.now();
  const iv = setInterval(() => { const now = performance.now(); maxGap = Math.max(maxGap, now - last); last = now; }, 1);
  const t0 = performance.now();
  for (let i = 0; i < n; i += 1) { await pilot.think(picture(i), 160, null); await new Promise((r) => setTimeout(r, 2)); }
  const wall = performance.now() - t0;
  clearInterval(iv); h.disable();
  return { maxGap, wall, p99: h.percentile(99) / 1e6, max: h.max / 1e6 };
}
const lagMain = await lagDuring(A, 4);
const lagWorker = await lagDuring(B, 4);
console.log(`  event loop during 4 x 160 ms windows: main thread worst gap ${lagMain.maxGap.toFixed(0)} ms (${(lagMain.wall / 4).toFixed(0)} ms per window); worker worst gap ${lagWorker.maxGap.toFixed(1)} ms (${(lagWorker.wall / 4).toFixed(0)} ms per window)`);
ok(lagWorker.maxGap < 50, `with the worker the event loop is never blocked for 50 ms (worst ${lagWorker.maxGap.toFixed(1)} ms)`);
ok(lagMain.maxGap > 100, `without it, it is (worst ${lagMain.maxGap.toFixed(0)} ms): the test measures what it claims`);

await B.close();
console.log(fails ? `\nbrain-worker: ${fails} FAILED` : '\nbrain-worker: ALL PASS');
process.exit(fails ? 1 : 0);
