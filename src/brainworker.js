/**
 * Her brain in its own thread (worker_threads).
 *
 * workerData: { connectome (typed arrays over SharedArrayBuffers: not copied),
 *               readouts, gains, seed, tasteCells, body, settle, shared }
 * in:  { id, lum (Float32Array, transferred), ms, taste }
 * out: { id, out, active, lit, top, brainMs } or { id, error }
 *
 * Her activity (a, V, w) lives in `shared` SharedArrayBuffers, so the main
 * thread can read all 139,255 cells between steps without a copy.
 */
import { parentPort, workerData } from 'node:worker_threads';
import { BrainCore } from './braincore.js';

const core = new BrainCore(workerData);
parentPort.postMessage({ ready: true, N: core.brain.N });

parentPort.on('message', (m) => {
  if (m && m.quit) { process.exit(0); }
  try {
    const r = core.think(m.lum, m.ms, m.taste);
    parentPort.postMessage({ id: m.id, ...r });
  } catch (e) {
    parentPort.postMessage({ id: m.id, error: e.stack || e.message });
  }
});
