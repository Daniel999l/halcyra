/**
 * The paint surface and the brush.
 *
 * No node imports here on purpose: the same code runs in the worker that makes
 * the piece and in the tab that watches her make it, so what a viewer sees is
 * the actual surface, painted by the same brush, not a re-encode of a video.
 *
 * The canvas is not blank. It is toned, the way a painter primes one, and she
 * is the brush: bristles spread across her line of travel, each one carrying
 * its own load, each one both LIFTING colour off the canvas and laying its own
 * down. Nothing here invents a shape. Every property is read off her run:
 *
 *   which pigment is loaded   her activity, how much of the brain is releasing
 *   how dark it goes          how slowly she passed, paint accumulates
 *   how wide the line         how sharply she was turning
 *   the pressed prints        where oviDNb fired and she laid
 */

export const BRUSH_LOOK = {
  scale: 6,        // brush width, in nibs
  wetK: 30,        // how wet the paint is for a given deposit
  alpha: 0.88,     // how hard one bristle bites
  pickup: 0.06,    // how much colour a bristle lifts off the canvas
  reload: 0.26,    // ...and how fast it comes back to its own pigment
  tuft: 3.2,       // bristle overlap, so the stroke is continuous
  nb: 24,          // bristles
};

const hex = (h) => [
  parseInt(h.slice(1, 3), 16) / 255,
  parseInt(h.slice(3, 5), 16) / 255,
  parseInt(h.slice(5, 7), 16) / 255,
];
const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Surface {
  /**
   * @param head { size, off, params, seed32 } - everything about the piece that
   *   is fixed before she starts, which is all a viewer needs to join mid-run.
   */
  constructor(head, look = {}) {
    this.S = head.size;
    this.OFF = head.off || 0;
    this.P = head.params;
    this.look = { ...BRUSH_LOOK, ...look };
    this.pal = head.params.palette;
    this.inks = this.pal.inks.map(hex);
    this.accent = hex(this.pal.accent);
    this.seed32 = (head.seed32 >>> 0) || 783;

    const S = this.S;
    this.R = new Float32Array(S * S);
    this.G = new Float32Array(S * S);
    this.B = new Float32Array(S * S);
    this.tone();

    const r = mulberry32(this.seed32 ^ 0x9e3779b9);
    this.r = r;
    const NB = Math.round(this.look.nb);
    this.bris = [];
    for (let k = 0; k < NB; k += 1) {
      const o = NB === 1 ? 0 : (k / (NB - 1) - 0.5) * 2;
      const t0 = (o + 1) / 2;
      const home = t0 < 0.5 ? mix(this.inks[0], this.inks[1], t0 * 2)
        : mix(this.inks[1], this.inks[2], (t0 - 0.5) * 2);
      this.bris.push({ o, home, load: 0.55 + r() * 0.45, col: home.slice(), ph: r() * 1000, life: 0.75 + r() * 0.5 });
    }
    this.arc = 0;
    this.prev = null;
    this.n = 0;
  }

  /** the toned ground: one colour, breathed on at a scale too large to read as a shape */
  tone() {
    const S = this.S;
    const r = mulberry32(this.seed32);
    const base = hex(this.pal.ground);
    const warm = mix(base, this.inks[2], 0.10);
    const cool = mix(base, this.inks[0], 0.06);
    const lobes = [];
    for (let k = 0; k < 3; k += 1) {
      lobes.push({ x: r() * S, y: r() * S, s: S * (0.45 + r() * 0.5), a: 0.5 + r() * 0.5, c: k === 0 ? warm : cool });
    }
    for (let y = 0; y < S; y += 1) {
      for (let x = 0; x < S; x += 1) {
        let c = base;
        for (const L of lobes) {
          const dx = x - L.x; const dy = y - L.y;
          c = mix(c, L.c, L.a * Math.exp(-(dx * dx + dy * dy) / (2 * L.s * L.s)) * 0.55);
        }
        const g = (r() - 0.5) * 0.012;                 // canvas tooth
        const i = y * S + x;
        this.R[i] = c[0] + g; this.G[i] = c[1] + g; this.B[i] = c[2] + g;
      }
    }
  }

  /**
   * One recorded frame. `f` is [x, y, heading, drive, turnRate, act, ink, ...]
   * in world coordinates; `laid` is true if oviDNb fired on this frame.
   */
  step(f, laid) {
    this.n += 1;
    if (!this.prev) { this.prev = f; return; }
    const S = this.S; const P = this.P; const L = this.look;
    const x0 = this.prev[0] - this.OFF; const y0 = this.prev[1] - this.OFF;
    const x = f[0] - this.OFF; const y = f[1] - this.OFF;
    const drive = f[3]; const turnRate = f[4]; const act = f[5]; const ink = f[6];
    this.prev = f;

    const dx = x - x0; const dy = y - y0;
    const d = Math.hypot(dx, dy) || 1e-6;
    const nx = -dy / d; const ny = dx / d;

    // how much of her is awake shifts the loaded pigment across the ferrule
    const t = Math.min(1, act / (P.actRef * 1.6));
    for (const b of this.bris) {
      const t0 = (b.o + 1) / 2;
      const tt = Math.max(0, Math.min(1, t0 * 0.55 + t * 0.55));
      b.home = tt < 0.5 ? mix(this.inks[0], this.inks[1], tt * 2)
        : mix(this.inks[1], this.inks[2], (tt - 0.5) * 2);
    }

    const wide = L.scale * P.nib * (1.5 + P.widthGain * 1.7 * Math.min(1, turnRate / 3.0));
    const wet = Math.min(1, ink * L.wetK) * (1.15 - 0.6 * Math.min(1, drive));
    const steps = Math.max(1, Math.ceil(d / 1.0));
    const tuftW = Math.max(1.3, wide / this.bris.length * L.tuft);

    for (let s = 1; s <= steps; s += 1) {
      const u = s / steps;
      const cx = x0 + dx * u; const cy = y0 + dy * u;
      const sArc = this.arc + d * u;
      for (let k = 0; k < this.bris.length; k += 1) {
        const b = this.bris[k];
        // slow drift along the stroke: a bristle wanders sideways over its
        // length instead of oscillating, which would put rungs across it
        const dr = Math.sin(sArc * 0.013 + b.ph) * 0.20 + Math.sin(sArc * 0.041 + b.ph * 1.7) * 0.09;
        const off = (b.o + dr) * wide * 0.5;
        const px = cx + nx * off; const py = cy + ny * off;
        if (px < -6 || py < -6 || px > S + 6 || py > S + 6) continue;
        const edge = 1 - Math.abs(b.o) * 0.42;
        const skip = 0.72 + 0.28 * Math.sin(sArc * (0.06 + k * 0.004) + b.ph * 3.1);
        const a = Math.min(0.95, wet * b.load * b.life * edge * skip * L.alpha);
        if (a < 0.004) continue;
        this.bristle(px, py, tuftW, a, b);
      }
    }
    this.arc += d;

    if (laid) {
      this.blot(x, y, P.accentSize * L.scale * 0.30);
      for (const b of this.bris) {
        b.load = 0.6 + this.r() * 0.4;
        b.life = 0.85 + this.r() * 0.45;
        b.col = mix(b.col, this.accent, 0.55);
      }
    }
    for (const b of this.bris) b.life = Math.max(0.22, b.life - 0.0016);
  }

  /** one bristle: lift what is there, mix it with what it carries, lay the result */
  bristle(cx, cy, w, a, b) {
    const S = this.S; const L = this.look;
    const R = this.R; const G = this.G; const B = this.B;
    const si = Math.min(S - 1, Math.max(0, Math.round(cy))) * S
             + Math.min(S - 1, Math.max(0, Math.round(cx)));
    b.col[0] += (R[si] - b.col[0]) * L.pickup + (b.home[0] - b.col[0]) * L.reload;
    b.col[1] += (G[si] - b.col[1]) * L.pickup + (b.home[1] - b.col[1]) * L.reload;
    b.col[2] += (B[si] - b.col[2]) * L.pickup + (b.home[2] - b.col[2]) * L.reload;

    const hw = w * 0.5; const rad = hw + 1;
    const x0 = Math.max(0, Math.floor(cx - rad)); const x1 = Math.min(S - 1, Math.ceil(cx + rad));
    const y0 = Math.max(0, Math.floor(cy - rad)); const y1 = Math.min(S - 1, Math.ceil(cy + rad));
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        const ddx = x + 0.5 - cx; const ddy = y + 0.5 - cy;
        const dd = Math.sqrt(ddx * ddx + ddy * ddy);
        const cov = dd <= hw - 0.5 ? 1 : dd >= hw + 0.5 ? 0 : hw + 0.5 - dd;
        if (cov <= 0) continue;
        const al = a * cov; const i = y * S + x;
        R[i] += (b.col[0] - R[i]) * al;
        G[i] += (b.col[1] - G[i]) * al;
        B[i] += (b.col[2] - B[i]) * al;
      }
    }
  }

  /** a lay: the brush pressed flat, paint pooling at the rim of the print */
  blot(cx, cy, rad) {
    const S = this.S; const col = this.accent; const r = this.r;
    const R = this.R; const G = this.G; const B = this.B;
    const rr = Math.max(3, rad);
    const x0 = Math.max(0, Math.floor(cx - rr * 1.6)); const x1 = Math.min(S - 1, Math.ceil(cx + rr * 1.6));
    const y0 = Math.max(0, Math.floor(cy - rr * 1.6)); const y1 = Math.min(S - 1, Math.ceil(cy + rr * 1.6));
    const lob = [];
    for (let k = 0; k < 5; k += 1) lob.push({ a: r() * 6.283, d: 0.10 + r() * 0.22, s: 0.45 + r() * 0.6 });
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        const px = x + 0.5 - cx; const py = y + 0.5 - cy;
        let d = Math.sqrt(px * px + py * py) / rr;
        const th = Math.atan2(py, px);
        for (const Lb of lob) {
          const dth = ((th - Lb.a + Math.PI * 3) % 6.283) - Math.PI;
          d -= Lb.d * Math.exp(-(dth * dth) / (2 * Lb.s * Lb.s));
        }
        if (d > 1 || d < -0.6) continue;
        const al = 0.30 + 0.5 * Math.max(0, 1 - Math.abs(d - 0.74) / 0.55);
        const i = y * S + x;
        R[i] += (col[0] - R[i]) * al;
        G[i] += (col[1] - G[i]) * al;
        B[i] += (col[2] - B[i]) * al;
      }
    }
  }

  /** 8 bit RGB, for a PNG or a video frame */
  toRGB(out) {
    const S = this.S; const n = S * S;
    const o = out || new Uint8Array(n * 3);
    for (let i = 0; i < n; i += 1) {
      const r = this.R[i]; const g = this.G[i]; const b = this.B[i];
      o[i * 3] = r <= 0 ? 0 : r >= 1 ? 255 : (r * 255 + 0.5) | 0;
      o[i * 3 + 1] = g <= 0 ? 0 : g >= 1 ? 255 : (g * 255 + 0.5) | 0;
      o[i * 3 + 2] = b <= 0 ? 0 : b >= 1 ? 255 : (b * 255 + 0.5) | 0;
    }
    return o;
  }

  /** RGBA, for putImageData in a tab */
  toRGBA(out) {
    const S = this.S; const n = S * S;
    const o = out || new Uint8ClampedArray(n * 4);
    for (let i = 0; i < n; i += 1) {
      o[i * 4] = this.R[i] * 255;
      o[i * 4 + 1] = this.G[i] * 255;
      o[i * 4 + 2] = this.B[i] * 255;
      o[i * 4 + 3] = 255;
    }
    return o;
  }
}
