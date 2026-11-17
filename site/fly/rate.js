/**
 * Her nervous system, graded.
 *
 * The spiking model in brain.js is the published one, constant for constant
 * (Shiu et al. 2024). It is also silent past the medulla: an integrate-and-
 * fire chain six synapses long, against that much GABA, does not carry a
 * picture to a descending neuron. So the model she actually walks on is the
 * graded one below - the same one the fly ran on, at 460 times the size:
 *
 *   tau dV_i/dt = -V_i + Gc * sum_j sign_j * n_ji * a_j / S_i + input_i - Ga * w_i
 *   a_i         = clamp((V_i - theta) / beta, 0, 1)
 *   tauA dw_i/dt = a_i - w_i                                   slow adaptation
 *
 * S_i is cell i's total incoming synapse count, so a cell with four thousand
 * inputs and a cell with nine are on the same scale: every cell sees the
 * synapse-weighted average of what drives it. Without that, a network this
 * recurrent either pins at full or dies.
 *
 * n_ji is the number of synapses EM counted from j onto i. sign_j is -1 for a
 * GABAergic or glutamatergic cell and +1 otherwise - Shiu et al.'s rule, on
 * the transmitter predictions shipped with the connectome - and -1 for a
 * photoreceptor, which is histaminergic and therefore inhibitory, which the
 * six-way classifier cannot say.
 *
 * The wiring is never touched. What is free is the gain on it: three global
 * scalars, and that is all that was ever fitted.
 *
 * Runs unchanged in node and in a browser tab. No dependencies.
 */

export const RATE_DEFAULTS = {
  dt: 5,          // ms per step
  tau: 30,        // ms membrane time constant
  theta: 0.12,    // release threshold
  beta: 0.55,     // range from threshold to full release
  Gc: 3.2,        // synaptic gain (inputs normalised per cell)
  Ga: 0.5,        // adaptation strength
  tauA: 400,      // ms adaptation time constant
  noise: 0.05,    // membrane noise (std per sqrt second)
  senseIn: 0.25,  // how much of the network a driven cell hears back
};

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class FlyRate {
  constructor(connectome, opts = {}) {
    this.p = { ...RATE_DEFAULTS, ...opts };
    const N = connectome.N;
    this.N = N; this.E = connectome.E;
    this.outPtr = connectome.outPtr;
    this.outPost = connectome.outPost;
    this.outW = connectome.outW;

    // every cell's total incoming synapse count, for the normalisation
    const S = new Float64Array(N);
    for (let e = 0; e < connectome.E; e += 1) S[connectome.outPost[e]] += Math.abs(connectome.outW[e]);
    this.inNorm = new Float32Array(N);
    for (let i = 0; i < N; i += 1) this.inNorm[i] = S[i] > 0 ? 1 / S[i] : 0;

    this.V = new Float32Array(N);
    this.a = new Float32Array(N);
    this.w = new Float32Array(N);
    this.syn = new Float32Array(N);
    this.input = new Float32Array(N);
    this.driven = new Int32Array(N); this.nDriven = 0;
    this.rand = mulberry32(opts.seed ?? 783);
    this.t = 0;
    this.steps = 0;
  }

  clearInput() {
    for (let k = 0; k < this.nDriven; k += 1) this.input[this.driven[k]] = 0;
    this.nDriven = 0;
  }

  /** drive cell i. `x` is dimensionless, 1 is a hard push. */
  drive(i, x) {
    if (this.input[i] === 0 && x !== 0) this.driven[this.nDriven++] = i;
    this.input[i] = x;
  }

  step(n = 1) {
    const { dt, tau, theta, beta, Gc, Ga, tauA, noise, senseIn } = this.p;
    const { N, V, a, w, syn, input, outPtr, outPost, outW, inNorm } = this;
    const k = dt / tau; const kA = dt / tauA;
    const nz = noise * Math.sqrt(dt / 1000);
    for (let s = 0; s < n; s += 1) {
      syn.fill(0);
      // only cells that are releasing anything have to be walked
      for (let j = 0; j < N; j += 1) {
        const aj = a[j];
        if (aj <= 0) continue;
        const e1 = outPtr[j + 1];
        for (let e = outPtr[j]; e < e1; e += 1) syn[outPost[e]] += outW[e] * aj;
      }
      for (let i = 0; i < N; i += 1) {
        let norm = inNorm[i];
        if (input[i] !== 0) norm *= senseIn;   // a driven cell mostly hears the world
        const dV = -V[i] + Gc * syn[i] * norm + input[i] - Ga * w[i];
        let v = V[i] + k * dV;
        if (nz > 0) {
          const u = Math.max(1e-12, this.rand());
          v += nz * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.rand());
        }
        if (v > 3) v = 3; else if (v < -3) v = -3;
        V[i] = v;
        w[i] += kA * (a[i] - w[i]);
        const x = (v - theta) / beta;
        a[i] = x <= 0 ? 0 : x >= 1 ? 1 : x;
      }
      this.t += dt; this.steps += 1;
    }
  }

  /** mean release over a list of cells, 0..1 */
  mean(idxs) {
    if (!idxs || !idxs.length) return 0;
    let s = 0;
    for (let k = 0; k < idxs.length; k += 1) s += this.a[idxs[k]];
    return s / idxs.length;
  }

  rateOf(i) { return this.a[i]; }

  activeCount(th = 0.15) {
    let n = 0;
    for (let i = 0; i < this.N; i += 1) if (this.a[i] >= th) n += 1;
    return n;
  }

  top(k = 12, th = 0.15) {
    const out = [];
    for (let i = 0; i < this.N; i += 1) if (this.a[i] >= th) out.push(i);
    out.sort((x, y) => this.a[y] - this.a[x]);
    return out.slice(0, k);
  }
}
