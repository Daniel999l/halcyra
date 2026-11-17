/**
 * Her body in a game.
 *
 * Copied from site/fly/body.js (that file is not changed) and cut down to what
 * a game needs. What goes in, line for line in look():
 * light at her lamina L1-L5, each cell placed on the retina where its soma
 * sits, an OFF sign (a lamina cell fires where its spot is darker than its
 * surround and darker than a moment ago), plus the same uniform tonic drive.
 *
 * Two differences on the way in:
 *  - Her retina covers the whole console picture. On a still page she would be a cursor on
 *    a still page, so the page had to slide across a small field of view as she
 *    walked. In a game the picture already moves with her (a chase camera), so
 *    the screen IS her field of view: left eye on the left of the screen, right
 *    eye on the right, a fly's overlap in the middle.
 *  - Taste: if the pilot is given gustatory cell lists and a taste sample, those
 *    cells are driven at level * gain for as long as she lives on that sample.
 *
 * What comes out is a gamepad state instead of an x,y. Every value is a pure
 * function of descending-neuron activity averaged over the step's window; the
 * functions are in toPad() and the table is in docs/CONTROLS.md. Which cell drives
 * which control is a design choice, not something the data says.
 */
import { blur } from '../site/fly/body.js';
import { BUTTON_NAMES } from './gamepad.js';

export { blur };

export const GAMEBODY_DEFAULTS = {
  // --- eye (site/fly/gains.json "body" block) ---
  binoc: 0.18,          // fraction of the field both eyes see
  rLamina: 1.0,         // drive at full contrast
  rTonic: 0.05,         // ...and with nothing in front of it
  kSpatial: 5.0,        // weight on darker than the surround
  kTemporal: 9.0,       // weight on it getting darker
  blurSigma: 7,         // grid cells the surround is measured over
  saccAmp: 0.006,       // her gaze is never still
  saccHz: 5.5,
  // --- taste ---
  kSweet: 1.0,          // drive on each sweet cell at sweet level 1 (same scale as full lamina contrast)
  kBitter: 1.0,         // drive on each bitter cell at bitter level 1
  // --- out (site/fly/gains.json where it has one) ---
  kTurn: 0.30,          // DN right minus left (mean activity) that is a full stick
  kFwd: 0.11,           // DN mean activity that is full throttle
  hzStop: 0.35,         // DNp09 activity that halves the throttle
  kBack: 0.11,          // MDN activity that is full brake/reverse (same scale as kFwd)
  hzLay: 0.2,           // oviDNb activity that counts as committing
  layMs: 120,           // ...held this long
  refractoryMs: 1500,   // no second commit straight after
  hzEscape: 0.2,        // DNp01 (giant fiber) activity that presses the escape button
  commitButton: 'y',    // GTA V: enter / exit vehicle
  escapeButton: 'rb',   // GTA V: handbrake (in a vehicle)
};

const LAMINA = ['L1', 'L2', 'L3', 'L4', 'L5'];

/** bilinear sample of a w*h grid at (u,v) in 0..1, clamped at the edges */
function sample(grid, w, h, u, v) {
  const x = Math.min(w - 1.001, Math.max(0, u * (w - 1)));
  const y = Math.min(h - 1.001, Math.max(0, v * (h - 1)));
  const x0 = x | 0; const y0 = y | 0;
  const fx = x - x0; const fy = y - y0;
  const i = y0 * w + x0;
  return (grid[i] * (1 - fx) + grid[i + 1] * fx) * (1 - fy)
       + (grid[i + w] * (1 - fx) + grid[i + w + 1] * fx) * fy;
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

/**
 * Find every readout population by name in the cell table.
 * -> { dnLeft, dnRight, types: { DNa01: {L:[],R:[]}, ... } }
 */
export function findReadouts(names) {
  const dnLeft = []; const dnRight = [];
  const want = ['DNa01', 'DNa02', 'DNp09', 'MDN', 'DNp01', 'oviDNb'];
  const types = Object.fromEntries(want.map((t) => [t, { L: [], R: [] }]));
  for (let i = 0; i < names.length; i += 1) {
    const n = names[i];
    if (!n) continue;
    if (n.cls === 'descending') {
      if (n.side === 'left') dnLeft.push(i);
      else if (n.side === 'right') dnRight.push(i);
    }
    if (types[n.type]) {
      if (n.side === 'left') types[n.type].L.push(i);
      else if (n.side === 'right') types[n.type].R.push(i);
    }
  }
  return { dnLeft, dnRight, types };
}

/**
 * The mapping below, as data (served in /api/proof). `cells` names the
 * readout population, `control` the standard-mapping pad input, `fn` the
 * exact formula toPad() uses, `gains` the GAMEBODY_DEFAULTS keys it reads.
 * Which cell drives which control is a design choice, not something the data says.
 */
export const PAD_MAPPING = [
  { control: 'axes[0] left stick X (steer)', cells: 'descending class, left vs right side', fn: 'clamp((R - L) / kTurn, -1, 1)', gains: ['kTurn'] },
  { control: 'buttons[7] right trigger (gas)', cells: 'descending class (both sides), cut by DNp09', fn: 'clamp(((L + R) / 2) / kFwd, 0, 1) / (1 + DNp09 / hzStop)', gains: ['kFwd', 'hzStop'] },
  { control: 'buttons[6] left trigger (brake, then reverse)', cells: 'MDN', fn: 'clamp(MDN / kBack, 0, 1)', gains: ['kBack'] },
  { control: 'axes[1] left stick Y (walk on foot)', cells: 'the two above', fn: 'clamp(LT - RT, -1, 1)', gains: [] },
  { control: 'commitButton (Y / Triangle: enter or leave the vehicle)', cells: 'oviDNb', fn: 'pressed for the look when oviDNb >= hzLay held layMs, then refractoryMs', gains: ['hzLay', 'layMs', 'refractoryMs', 'commitButton'] },
  { control: 'escapeButton (RB / R1: handbrake)', cells: 'DNp01 (giant fiber)', fn: 'pressed for the look if DNp01 >= hzEscape at any brain step of the window', gains: ['hzEscape', 'escapeButton'] },
  { control: 'axes[2..3] right stick and every other button', cells: 'none', fn: '0', gains: [] },
];

/**
 * The mapping. Pure: readouts in, pad out. `commit` and `escape` are the
 * already-decided button presses for this step (see GameBody.live).
 */
export function toPad(r, p, { commit = false, escape = false } = {}) {
  // left stick X: right minus left descending population
  const lx = clamp((r.R - r.L) / p.kTurn, -1, 1);
  // right trigger: whole DN population drive, cut by DNp09 (the walk drive)
  const rt = clamp(((r.L + r.R) / 2) / p.kFwd, 0, 1) * (1 / (1 + r.DNp09 / p.hzStop));
  // left trigger: MDN, the moonwalker (walk backwards) = brake, then reverse
  const lt = clamp(r.MDN / p.kBack, 0, 1);
  // left stick Y: the same two drives as a walk on foot (up is negative)
  const ly = clamp(lt - rt, -1, 1);
  const buttons = Object.fromEntries(BUTTON_NAMES.map((n) => [n, 0]));
  buttons.rt = rt;
  buttons.lt = lt;
  if (commit) buttons[p.commitButton] = 1;
  if (escape) buttons[p.escapeButton] = 1;
  // right stick (camera) is not driven by anything: 0
  return { axes: [lx, ly, 0, 0], buttons };
}

export class GameBody {
  /**
   * brain: FlyRate. eyemap: from loadConnectomeNode. readouts: findReadouts(names).
   * taste: { sweet: number[], bitter: number[] } cell indices, or null.
   */
  constructor(brain, eyemap, readouts, opts = {}, taste = null) {
    this.brain = brain;
    this.p = { ...GAMEBODY_DEFAULTS, ...opts };
    const p = this.p;

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
    this.nLamina = this.eyes.reduce((s, e) => s + e.idx.length, 0);

    const T = readouts.types;
    this.R = {
      L: Int32Array.from(readouts.dnLeft), R: Int32Array.from(readouts.dnRight),
      DNa01: [...T.DNa01.L, ...T.DNa01.R], DNa02L: T.DNa02.L, DNa02R: T.DNa02.R,
      DNp09: [...T.DNp09.L, ...T.DNp09.R], MDN: [...T.MDN.L, ...T.MDN.R],
      DNp01: [...T.DNp01.L, ...T.DNp01.R], oviDNb: [...T.oviDNb.L, ...T.oviDNb.R],
    };
    this.counts = Object.fromEntries(Object.entries(T).map(([k, v]) => [k, { L: v.L.length, R: v.R.length }]));
    this.counts.descending = { L: readouts.dnLeft.length, R: readouts.dnRight.length };

    this.sweetCells = Int32Array.from((taste && taste.sweet) || []);
    this.bitterCells = Int32Array.from((taste && taste.bitter) || []);
    this.taste = { sweet: 0, bitter: 0 };

    this.sacc = 0;
    this.layMs = 0;
    this.sinceLay = 1e9;
    this.seen = 0;
    this.last = null;
  }

  /** light in at the lamina, look(), field = whole screen; then taste */
  look(lum, blurred, gw, gh) {
    const p = this.p;
    const b = this.brain;
    b.clearInput();
    this.sacc += p.saccHz * 2 * Math.PI * 0.02;
    const jx = Math.cos(this.sacc) * p.saccAmp;
    const jy = Math.sin(this.sacc * 1.7) * p.saccAmp;
    let energy = 0; let n = 0;
    for (const eye of this.eyes) {
      const prev = eye.prev;
      for (let k = 0; k < eye.idx.length; k += 1) {
        const u = eye.u[k] + jx;
        const v = eye.v[k] + jy;
        const l = sample(lum, gw, gh, u, v);
        const m = sample(blurred, gw, gh, u, v);
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
    // taste goes in after the lamina, every look, because clearInput() above
    // wipes every input each time she looks
    const s = this.taste.sweet * p.kSweet; const bt = this.taste.bitter * p.kBitter;
    if (s > 0) for (let k = 0; k < this.sweetCells.length; k += 1) b.drive(this.sweetCells[k], s);
    if (bt > 0) for (let k = 0; k < this.bitterCells.length; k += 1) b.drive(this.bitterCells[k], bt);
  }

  readouts() {
    const b = this.brain; const R = this.R;
    const a2L = b.mean(R.DNa02L); const a2R = b.mean(R.DNa02R);
    return {
      L: b.mean(R.L), R: b.mean(R.R),
      DNa01: b.mean(R.DNa01), DNa02: (a2L + a2R) / 2, DNa02L: a2L, DNa02R: a2R,
      DNp09: b.mean(R.DNp09), MDN: b.mean(R.MDN), DNp01: b.mean(R.DNp01), oviDNb: b.mean(R.oviDNb),
    };
  }

  /**
   * Live for `ms` on this view (and this taste). Readouts are averaged over the
   * window; the commit and escape decisions are taken per brain step inside it.
   * -> { dn, pad, commit, escape, drove, seen }
   */
  live(lum, gw, gh, ms, blurred, taste = null) {
    const b = this.brain; const p = this.p;
    const dt = b.p.dt;
    const steps = Math.max(1, Math.round(ms / dt));
    const bl = blurred || blur(lum, gw, gh, p.blurSigma);
    const lookEvery = Math.max(1, Math.round(4 / dt));   // a look every ~4 ms of brain time
    this.taste = {
      sweet: clamp(Number(taste && taste.sweet) || 0, 0, 1),
      bitter: clamp(Number(taste && taste.bitter) || 0, 0, 1),
    };
    const acc = {};
    let commit = false; let escape = false;
    for (let s = 0; s < steps; s += 1) {
      if (s % lookEvery === 0) this.look(lum, bl, gw, gh);
      b.step(1);
      const r = this.readouts();
      for (const k in r) acc[k] = (acc[k] || 0) + r[k];
      // commit: oviDNb held over threshold for layMs, with a refractory (the lay readout)
      this.sinceLay += dt;
      if (r.oviDNb >= p.hzLay) this.layMs += dt; else this.layMs = 0;
      if (!commit && this.layMs >= p.layMs && this.sinceLay >= p.refractoryMs) {
        commit = true; this.sinceLay = 0; this.layMs = 0;
      }
      // escape: the giant fiber over threshold at any moment of the window
      if (r.DNp01 >= p.hzEscape) escape = true;
    }
    const dn = {};
    for (const k in acc) dn[k] = acc[k] / steps;
    const pad = toPad(dn, p, { commit, escape });
    const drove = {
      lamina: this.nLamina,
      sweet: this.taste.sweet * p.kSweet > 0 ? this.sweetCells.length : 0,
      bitter: this.taste.bitter * p.kBitter > 0 ? this.bitterCells.length : 0,
    };
    this.last = { dn, pad, commit, escape, drove, seen: this.seen };
    return this.last;
  }
}
