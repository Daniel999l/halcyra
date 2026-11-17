/**
 * Her body on a web page.
 *
 * She walks. The cursor is where she is, and her eyes look out from there, so
 * the page slides across her retina as she moves - which is the only reason
 * any of this works: a fly steers on optic flow, not on a picture.
 *
 * WHAT GOES IN - two things, and only two:
 *
 *  1. Light, on her 8,452 R1-6 photoreceptors. Each one is placed on the
 *     retina by where its soma actually sits: the two principal axes of the
 *     retina carry 99% of the variance, because it really is a sheet. Left eye
 *     takes the left of her field, right eye the right, with the overlap a fly
 *     has. A photoreceptor fires at how bright its own spot of the page is.
 *
 *  2. A standing drive on her lamina cells L1-L5, carrying no picture at all -
 *     the same number on every column. A real lamina cell sits depolarised in
 *     the dark; an integrate-and-fire cell has no such thing, so it is put
 *     back by hand. This is the one place the model needs propping up, and it
 *     cannot smuggle the image in, because it is uniform.
 *
 * Then her own wiring does the rest. Her photoreceptors are histaminergic and
 * they INHIBIT the lamina (Hardie 1989; Gengs et al. 2002, histamine-gated
 * chloride channels) - so a bright spot on the page punches a hole in an
 * otherwise even sheet of lamina firing, and that hole is the image. That
 * sign inversion is the first thing any fly eye does, and it is the one
 * correction we make to the connectome's own transmitter table: the FlyWire
 * classifier predicts six transmitters and histamine is not one of them.
 *
 * WHAT COMES OUT - the cells a fly actually walks with:
 *
 *   DNa02 L vs R   turn, ipsilateral      Rayshubskiy et al. 2020
 *   DNa01 L + R    forward, and its asymmetry helps steer
 *   MDN            walk backwards         Bidaye et al. 2014, Science 344:97
 *   DNp09          stop, freeze           Bidaye et al. 2020, Neuron 108:469
 *   oviDNb         lay                    Wang et al. 2020, eLife 9:e57097
 *
 * The last one is hers alone. oviDN does not exist in a male fly: it is one of
 * the 270 cells FlyWire marks female-specific, and in the animal it is the
 * command to put an egg down. The male fly clicked a button. She lays.
 *
 * Runs in node and the browser.
 */

export const BODY_DEFAULTS = {
  width: 1280, height: 720,
  fovW: 0.62, fovH: 0.62,   // how much of the page falls on her retina at once
  binoc: 0.18,              // fraction of the field both eyes see
  speed: 300,               // px/s at full DNa01
  turn: 6.0,                // rad/s at full DNa02 asymmetry
  rLamina: 190,             // Hz a lamina cell fires at full contrast
  rTonic: 10,               // ...and with nothing in front of it
  kSpatial: 5.0,            // weight on darker than the surround
  kTemporal: 9.0,           // weight on it getting darker
  blurSigma: 7,             // grid cells the surround is measured over
  saccAmp: 0.006,           // her gaze is never still
  saccHz: 5.5,
  wall: 26,                 // px from the edge where the field runs out
  hzStop: 12,               // DNp09 Hz that counts as stopping
  hzLay: 6,                 // oviDNb Hz that counts as laying
  layMs: 120,               // ...held this long
  refractoryMs: 1500,       // no second one straight after
  commit: 'lay',            // 'lay' = oviDNb puts it down; 'stop' = DNp09 does
  kFwd: 60,                 // Hz of DNa01 that counts as full forward
  kTurn: 60,                // Hz of DNa02 difference that counts as a full turn
  bodyLen: 160,
  egocentric: false,        // eyes fixed to the page (a page does not rotate)
  ahead: 0.10,              // ...or fixed to her head, looking this far in front
};

/** separable gaussian blur - the local mean a lamina cell measures against */
export function blur(grid, w, h, sigma) {
  const r = Math.max(1, Math.ceil(sigma * 2.5));
  const k = new Float32Array(2 * r + 1);
  let ks = 0;
  for (let i = -r; i <= r; i += 1) { k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)); ks += k[i + r]; }
  for (let i = 0; i < k.length; i += 1) k[i] /= ks;
  const tmp = new Float32Array(w * h); const out = new Float32Array(w * h);
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
    let sm = 0;
    for (let i = -r; i <= r; i += 1) { const xx = x + i < 0 ? 0 : x + i >= w ? w - 1 : x + i; sm += grid[y * w + xx] * k[i + r]; }
    tmp[y * w + x] = sm;
  }
  for (let y = 0; y < h; y += 1) for (let x = 0; x < w; x += 1) {
    let sm = 0;
    for (let i = -r; i <= r; i += 1) { const yy = y + i < 0 ? 0 : y + i >= h ? h - 1 : y + i; sm += tmp[yy * w + x] * k[i + r]; }
    out[y * w + x] = sm;
  }
  return out;
}

/** bilinear sample of a w*h grid at (u,v) in 0..1 */
function sample(grid, w, h, u, v) {
  const x = Math.min(w - 1.001, Math.max(0, u * (w - 1)));
  const y = Math.min(h - 1.001, Math.max(0, v * (h - 1)));
  const x0 = x | 0; const y0 = y | 0;
  const fx = x - x0; const fy = y - y0;
  const i = y0 * w + x0;
  return (grid[i] * (1 - fx) + grid[i + 1] * fx) * (1 - fy)
       + (grid[i + w] * (1 - fx) + grid[i + w + 1] * fx) * fy;
}

// FAFB was cut at the lamina, so the R1-6 terminals are mostly outside the
// imaged volume. The image therefore goes in one synapse further in, at the
// lamina monopolar cells - the same door the fruit-fly project used.
const LAMINA = ['L1', 'L2', 'L3', 'L4', 'L5'];

export class FlyBody {
  constructor(brain, eyemap, opts = {}) {
    this.brain = brain;
    this.p = { ...BODY_DEFAULTS, ...opts };
    const p = this.p;

    // --- the retina -------------------------------------------------------
    this.eyes = [];
    for (const ct of LAMINA) {
      for (const side of ['left', 'right']) {
        const e = eyemap.eye[`${ct}_${side}`];
        if (!e) continue;
        const n = e.idx.length;
        const idx = Int32Array.from(e.idx);
        const u = new Float32Array(n); const v = new Float32Array(n);
        const half = 0.5 + p.binoc / 2;
        for (let k = 0; k < n; k += 1) {
          const [a, bb] = e.uv[k];
          u[k] = side === 'left' ? a * half : 1 - half + a * half;
          v[k] = bb;
        }
        this.eyes.push({ ct, side, idx, u, v, prev: new Float32Array(n), seen: false });
      }
    }
    this.nLamina = this.eyes.reduce((s2, e) => s2 + e.idx.length, 0);

    // --- the cells she is read out from -----------------------------------
    // Her whole descending population, split left and right. A fly does not
    // steer on one cell; it steers on the difference between the two sides of
    // a population of about 1,300. Nothing here is hand-picked - the named
    // cells below are read out too, and reported, but they do not drive her.
    this.DNL = Int32Array.from(opts.dnLeft || []);
    this.DNR = Int32Array.from(opts.dnRight || []);
    const m = eyemap.motor;
    this.M = {
      fwdL: m.forward.L, fwdR: m.forward.R,
      steerL: m.steer.L, steerR: m.steer.R,
      back: [...m.backward.L, ...m.backward.R],
      stop: [...m.stop.L, ...m.stop.R],
      lay: [...m.lay.L, ...m.lay.R],
      oviIN: [...m.oviIN.L, ...m.oviIN.R],
      pC1: m.pC1,
    };

    this.x = opts.x ?? p.width * 0.45;
    this.y = opts.y ?? p.height * 0.45;
    this.heading = opts.heading ?? Math.random() * Math.PI * 2;
    this.dir = 1;
    this.sacc = 0;
    this.layMs = 0;
    this.sinceLay = 1e9;
    this.trail = [];
    this.tick = 0;
    this.seen = 0;
    this.last = {};
  }

  /**
   * Point her retina at the page from where she is standing.
   *
   * A lamina cell fires hardest where its own spot is DARKER than the spot
   * around it, and darker than it was a moment ago. That sign is not a choice:
   * a fly's photoreceptors inhibit its lamina cells (histamine-gated chloride
   * channels, Hardie 1989), so light turns a lamina cell down and dark turns
   * it up. It makes her an OFF animal - she sees dark things against light -
   * and it is why the light form is the one she can read.
   */
  look(lum, blurred, gw, gh) {
    const p = this.p;
    const b = this.brain;
    const cx = this.x / p.width; const cy = this.y / p.height;
    b.clearInput();
    this.sacc += p.saccHz * 2 * Math.PI * 0.02;
    const jx = Math.cos(this.sacc) * p.saccAmp;
    const jy = Math.sin(this.sacc * 1.7) * p.saccAmp;
    let energy = 0; let n = 0;
    // Her eyes are on her head, so they point where she is going. On a web
    // page that does not matter, because a page is upright and never turns.
    // On a surface she is marking it matters completely: a trail curving away
    // to her left only IS on her left if the retina turns with her.
    const ego = p.egocentric;
    const ch = Math.cos(this.heading); const sh = Math.sin(this.heading);
    const ax = ego ? ch * p.ahead : 0; const ay = ego ? sh * p.ahead : 0;
    for (const eye of this.eyes) {
      const prev = eye.prev;
      for (let k = 0; k < eye.idx.length; k += 1) {
        let u; let v;
        if (ego) {
          const a = (eye.u[k] - 0.5) * p.fovW;     // across her field
          const b = (0.5 - eye.v[k]) * p.fovH;     // out in front of her
          u = cx + ax + ch * b - sh * a + jx;
          v = cy + ay + sh * b + ch * a + jy;
        } else {
          u = cx + (eye.u[k] - 0.5) * p.fovW + jx;
          v = cy + (eye.v[k] - 0.5) * p.fovH + jy;
        }
        const out = u < 0 || u > 1 || v < 0 || v > 1;
        const l = out ? 1 : sample(lum, gw, gh, u, v);
        const m = out ? 1 : sample(blurred, gw, gh, u, v);
        const spatial = Math.max(0, m - l);
        const d = eye.seen ? Math.max(0, prev[k] - l) : 0;
        prev[k] = l;
        const c = Math.min(1, spatial * p.kSpatial + d * p.kTemporal);
        b.drive(eye.idx[k], p.rTonic + (p.rLamina - p.rTonic) * c);
        energy += c; n += 1;
      }
      eye.seen = true;
    }
    this.seen = n ? energy / n : 0;
  }

  /**
   * Live for `ms` on this view. The brain runs at its own dt; the body moves
   * alongside it. Returns what happened, and where she laid if she did.
   */
  live(lum, gw, gh, ms, blurred) {
    const b = this.brain; const p = this.p;
    const dt = b.p.dt;
    const steps = Math.max(1, Math.round(ms / dt));
    const bl = blurred || blur(lum, gw, gh, p.blurSigma);
    const lookEvery = Math.max(1, Math.round(4 / dt));
    let laid = null;
    for (let s = 0; s < steps; s += 1) {
      if (s % lookEvery === 0) this.look(lum, bl, gw, gh);
      b.step(1);

      const dnL = b.mean(this.DNL); const dnR = b.mean(this.DNR);
      const fwdL = b.mean(this.M.fwdL); const fwdR = b.mean(this.M.fwdR);
      const stL = b.mean(this.M.steerL); const stR = b.mean(this.M.steerR);
      const back = b.mean(this.M.back);
      const stop = b.mean(this.M.stop);
      const lay = Math.max(b.mean(this.M.lay), b.mean(this.M.oviIN), b.mean(this.M.pC1));

      const fwd = (dnL + dnR) / 2;
      const asym = (dnR - dnL) / Math.max(1e-6, p.kTurn);
      const brake = 1 / (1 + stop / p.hzStop);
      if (this.dir > 0 && back > fwd + 3) this.dir = -1;
      else if (this.dir < 0 && fwd > back + 3) this.dir = 1;

      const drive = Math.min(1, fwd / p.kFwd) * brake;
      const v = p.speed * drive * this.dir;
      this.heading += p.turn * Math.max(-1, Math.min(1, asym)) * (dt / 1000);
      this.x += Math.cos(this.heading) * v * (dt / 1000);
      this.y += Math.sin(this.heading) * v * (dt / 1000);
      // the edge of the page is the edge of the world: she turns back into it
      // the way a fly turns off a wall, not by bouncing like a billiard ball
      const mx = p.width / 2; const my = p.height / 2;
      const outX = this.x < p.wall || this.x > p.width - p.wall;
      const outY = this.y < p.wall || this.y > p.height - p.wall;
      if (outX || outY) {
        this.x = Math.min(p.width - p.wall, Math.max(p.wall, this.x));
        this.y = Math.min(p.height - p.wall, Math.max(p.wall, this.y));
        const home = Math.atan2(my - this.y, mx - this.x);
        let d = home - this.heading;
        while (d > Math.PI) d -= 2 * Math.PI;
        while (d < -Math.PI) d += 2 * Math.PI;
        this.heading += Math.sign(d) * Math.min(Math.abs(d), 6 * (dt / 1000));
      }

      this.sinceLay += dt;
      const committing = p.commit === 'lay'
        ? lay >= p.hzLay
        : (stop >= p.hzStop && drive < 0.25);
      if (committing) this.layMs += dt; else this.layMs = 0;
      if (!laid && this.layMs >= p.layMs && this.sinceLay >= p.refractoryMs) {
        laid = { x: this.x, y: this.y };
        this.sinceLay = 0; this.layMs = 0;
      }

      this.last = {
        fwd, back, stop, lay, steerL: stL, steerR: stR, asym, dnL, dnR,
        DNa01: (b.mean(this.M.fwdL) + b.mean(this.M.fwdR)) / 2,
        DNa02: (stL + stR) / 2, DNp09: stop, oviDNb: b.mean(this.M.lay),
        oviIN: b.mean(this.M.oviIN), pC1: b.mean(this.M.pC1),
        drive, dir: this.dir, seen: this.seen,
      };
      if (++this.tick % 12 === 0) {
        const lp = this.trail[this.trail.length - 1];
        if (!lp || Math.hypot(this.x - lp[0], this.y - lp[1]) > 2) this.trail.push([this.x, this.y]);
        let len = 0;
        for (let i = this.trail.length - 1; i > 0; i -= 1) {
          len += Math.hypot(this.trail[i][0] - this.trail[i - 1][0], this.trail[i][1] - this.trail[i - 1][1]);
          if (len > p.bodyLen) { this.trail.splice(0, i); break; }
        }
      }
    }
    return { x: this.x, y: this.y, at: [this.x, this.y], heading: this.heading, laid, ...this.last };
  }
}
