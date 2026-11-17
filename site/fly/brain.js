/**
 * Her nervous system: 139,255 neurons of a real adult female Drosophila brain,
 * wired exactly as FlyWire traced them, run as leaky integrate-and-fire cells.
 *
 *   t_mbr dv/dt = (v_0 - v + g)          membrane
 *   tau   dg/dt = -g                     synaptic conductance, alpha-decay
 *   v > v_th  ->  spike, v = v_rst, g = 0, refractory for t_rfc
 *
 * Every constant below is published, not ours:
 *
 *   v_0  -52 mV, v_rst -52 mV, v_th -45 mV, t_mbr 20 ms
 *                        Kakaria & de Bivort 2017, Front. Behav. Neurosci.
 *   tau   5 ms           Jurgensen et al. 2021, Neuromorph. Comput. Eng.
 *   t_rfc 2.2 ms         Lazar et al. 2021, eLife
 *   t_dly 1.8 ms         Paul et al. 2015, Front. Cell. Neurosci.
 *   w_syn 0.275 mV       Shiu et al. 2024, Nature 634:210 - the one free
 *                        parameter of that model, and we did not refit it
 *
 * A spike from j adds w_syn * (number of synapses j makes onto i) to g_i,
 * 1.8 ms later, signed: GABAergic and glutamatergic cells are inhibitory,
 * everything else excitatory (Shiu et al.'s rule, from the neurotransmitter
 * predictions shipped with the connectome).
 *
 * Nothing here is trained. Not the wiring, not the weights. The only thing we
 * chose is where on her the screen is allowed to touch - her lamina - and that
 * is in body.js, not here.
 *
 * The whole thing is two typed arrays and an integer loop, so it runs
 * unchanged in node and in a browser tab. No dependencies.
 */

export const DEFAULTS = {
  dt: 0.45,      // ms per step; 4 steps is exactly the 1.8 ms synaptic delay
  v0: -52,       // mV resting potential
  vRst: -52,     // mV reset after a spike
  vTh: -45,      // mV firing threshold
  tMbr: 20,      // ms membrane time constant
  tau: 5,        // ms synaptic time constant
  tRfc: 2.2,     // ms refractory period
  tDly: 1.8,     // ms delay before a spike reaches the next cell
  wSyn: 0.275,   // mV per synapse
  fPoi: 250,     // scaling of a Poisson input synapse (Shiu et al.)
  rateTau: 60,   // ms window the firing-rate readout averages over
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

/**
 * connectome: { N, E, outPtr: Int32Array(N+1), outPost: Int32Array(E),
 *               outW: Float32Array(E) }  - CSR by presynaptic cell, signed.
 */
export class FlyBrain {
  constructor(connectome, opts = {}) {
    this.p = { ...DEFAULTS, ...opts };
    const p = this.p;
    const N = connectome.N;
    this.N = N;
    this.outPtr = connectome.outPtr;
    this.outPost = connectome.outPost;
    this.outW = connectome.outW;

    this.v = new Float32Array(N).fill(p.v0);
    this.g = new Float32Array(N);
    this.rfcUntil = new Float32Array(N).fill(-1e9);
    this.spikes = 0;
    this.t = 0;                            // ms

    // Only cells that are doing something are stepped. A cell wakes when
    // something arrives at it and sleeps again when it has settled back to
    // rest - the arithmetic is identical, there is just no point integrating
    // 130,000 cells sitting at -52 mV.
    this.act = new Int32Array(N);
    this.inAct = new Uint8Array(N);
    this.nAct = 0;

    // spikes in flight, as (cell, millivolts) pairs, one bucket per delay step
    this.L = Math.max(1, Math.round(p.tDly / p.dt));
    this.ring = [];
    for (let i = 0; i < this.L; i += 1) {
      this.ring.push({ idx: new Int32Array(1 << 14), w: new Float32Array(1 << 14), n: 0 });
    }
    this.head = 0;

    // Poisson drive, in Hz. `driven` is the short list the body sets.
    this.poi = new Float32Array(N);
    this.driven = new Int32Array(N);
    this.nDriven = 0;

    // firing rate readout, kept as raw counts against a running scale so the
    // decay costs nothing per step
    this.raw = new Float32Array(N);
    this.scale = 1;

    this.fired = new Int32Array(N);
    this.nFired = 0;
    this.rand = mulberry32(opts.seed ?? 783);

    this.kV = p.dt / p.tMbr;
    this.kG = Math.exp(-p.dt / p.tau);
    this.kR = Math.exp(-p.dt / p.rateTau);
    this.rateUp = (1 - this.kR) * (1000 / p.dt);
  }

  wake(i) { if (!this.inAct[i]) { this.inAct[i] = 1; this.act[this.nAct++] = i; } }

  /** firing rate of one cell, Hz */
  rateOf(i) { return this.raw[i] / this.scale; }

  /** clear every external drive */
  clearInput() {
    for (let k = 0; k < this.nDriven; k += 1) this.poi[this.driven[k]] = 0;
    this.nDriven = 0;
  }

  /** drive cell i with a Poisson input train of `hz` spikes per second */
  drive(i, hz) {
    if (this.poi[i] === 0 && hz > 0) this.driven[this.nDriven++] = i;
    this.poi[i] = hz;
    if (hz > 0) this.wake(i);
  }

  push(slot, i, w) {
    const r = this.ring[slot];
    if (r.n === r.idx.length) {
      const ni = new Int32Array(r.n * 2); ni.set(r.idx); r.idx = ni;
      const nw = new Float32Array(r.n * 2); nw.set(r.w); r.w = nw;
    }
    r.idx[r.n] = i; r.w[r.n] = w; r.n += 1;
  }

  /** advance n steps of dt */
  step(n = 1) {
    const { dt, v0, vRst, vTh, tRfc, wSyn, fPoi } = this.p;
    const { v, g, rfcUntil, poi, outPtr, outPost, outW, raw, inAct, act } = this;
    const kV = this.kV; const kG = this.kG; const kR = this.kR;
    const pBump = wSyn * fPoi;
    const pr = dt / 1000;
    const REST = 0.02;
    for (let s = 0; s < n; s += 1) {
      const t = this.t;
      // 1. everything that was in flight and is due now
      const due = this.ring[this.head];
      for (let k = 0; k < due.n; k += 1) { const i = due.idx[k]; g[i] += due.w[k]; this.wake(i); }
      due.n = 0;
      // 2. the world knocking on the sensory cells
      for (let k = 0; k < this.nDriven; k += 1) {
        const i = this.driven[k];
        if (this.rand() < poi[i] * pr) { g[i] += pBump; this.wake(i); }
      }
      // 3. integrate whoever is awake
      this.nFired = 0;
      this.scale /= kR;
      let w = 0;
      for (let k = 0; k < this.nAct; k += 1) {
        const i = act[k];
        if (t < rfcUntil[i]) { act[w++] = i; continue; }
        g[i] *= kG;
        v[i] += kV * (v0 - v[i] + g[i]);
        if (v[i] > vTh) {
          v[i] = vRst; g[i] = 0;
          rfcUntil[i] = t + tRfc;
          this.fired[this.nFired++] = i;
          raw[i] += this.rateUp * this.scale;
          act[w++] = i;
        } else if (poi[i] > 0 || g[i] > REST || g[i] < -REST || v[i] > v0 + REST || v[i] < v0 - REST) {
          act[w++] = i;
        } else {
          v[i] = v0; g[i] = 0; inAct[i] = 0;
        }
      }
      this.nAct = w;
      // 4. send those spikes on, to arrive t_dly from now
      const slot = (this.head + this.L - 1) % this.L;
      for (let k = 0; k < this.nFired; k += 1) {
        const j = this.fired[k];
        const e1 = outPtr[j + 1];
        for (let e = outPtr[j]; e < e1; e += 1) this.push(slot, outPost[e], wSyn * outW[e]);
      }
      this.spikes += this.nFired;
      if (this.scale > 1e12) {             // keep the rate readout in range
        const inv = 1 / this.scale;
        for (let i = 0; i < this.N; i += 1) raw[i] *= inv;
        this.scale = 1;
      }
      this.head = (this.head + 1) % this.L;
      this.t += dt;
    }
  }

  /** mean firing rate (Hz) over a list of neuron indices */
  mean(idxs) {
    if (!idxs || !idxs.length) return 0;
    let s = 0;
    for (let k = 0; k < idxs.length; k += 1) s += this.raw[idxs[k]];
    return s / idxs.length / this.scale;
  }

  /** how many cells are firing above `hz` right now */
  activeCount(hz = 5) {
    let n = 0;
    const th = hz * this.scale;
    for (let k = 0; k < this.nAct; k += 1) if (this.raw[this.act[k]] >= th) n += 1;
    return n;
  }

  /** the `k` busiest cells right now, as indices */
  top(k = 12, hz = 5) {
    const th = hz * this.scale;
    const out = [];
    for (let i = 0; i < this.nAct; i += 1) if (this.raw[this.act[i]] >= th) out.push(this.act[i]);
    out.sort((a, b) => this.raw[b] - this.raw[a]);
    return out.slice(0, k);
  }
}
