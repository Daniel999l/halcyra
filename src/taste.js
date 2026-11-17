/**
 * Taste: buys are sugar on her tongue, sells are bitter.
 *
 * WHICH CELLS
 * The sweet and bitter cells are the labellar gustatory receptor neurons (GRNs)
 * that Shiu et al. (Nature 634:210, 2024) activated by FlyWire root ID, copied
 * here from their public repository github.com/philshiu/Drosophila_brain_model
 * (figures.ipynb: `neu_sugar`, `neu_sugar_left`, `neu_bitter`). Those IDs were
 * written against FlyWire v630; this brain is v783. An ID that is not in v783
 * is dropped, never guessed (one per list, listed in `meta.missing`).
 *
 * In the v783 annotations the published sugar cells are all cell_type LB3 and
 * the published bitter cells are all LB1a,LB1d / LB1b / LB1c. LB3 also holds
 * the water GRNs, so type alone cannot pick the sugar cells: the published IDs
 * are the only honest source, and that is what is used.
 *
 * Mode 'paper' (default): sweet = neu_sugar + neu_sugar_left (both palps, the
 * paper's two lists), bitter = neu_bitter (the paper published one side only).
 * Mode 'bilateral': the same, plus every cell typed LB1a,LB1d / LB1b / LB1c on
 * the other side, so bitter comes in on both palps too. Off by default because
 * that half is chosen by type, not by published ID.
 *
 * HOW A TRADE TASTES
 * level(sol) = floor + (1 - floor) * clamp(log(sol / minSol) / log(maxSol / minSol), 0, 1)
 * A trade starts at its level on the first sample after it was pushed, then
 * halves every `halfLifeMs`. Per side the live contributions add and saturate
 * at 1. No clock and no randomness inside: time is what the caller passes to
 * sample(), so the same pushes and the same sample times give the same output,
 * and the `applied` list in each tick is enough to replay it (see replayTaste).
 */

// Shiu et al. 2024, figures.ipynb, Figure 1D/3A ("labellar sugar-sensing GRNs on right hemisphere")
const SUGAR_R = [
  '720575940624963786', '720575940630233916', '720575940637568838', '720575940638202345', '720575940617000768',
  '720575940630797113', '720575940632889389', '720575940621754367', '720575940621502051', '720575940640649691',
  '720575940639332736', '720575940616885538', '720575940639198653', '720575940620900446', '720575940617937543',
  '720575940632425919', '720575940633143833', '720575940612670570', '720575940628853239', '720575940629176663',
  '720575940611875570',
];
// Shiu et al. 2024, figures.ipynb ("left hemisphere sugar")
const SUGAR_L = [
  '720575940620589838', '720575940631147148', '720575940608305161', '720575940629388135', '720575940630968335',
  '720575940606801282', '720575940617398502', '720575940616167218', '720575940620296641', '720575940627961104',
];
// Shiu et al. 2024, figures.ipynb, Figure 3A (`neu_bitter`)
const BITTER = [
  '720575940621778381', '720575940602353632', '720575940617094208', '720575940619197093', '720575940626287336',
  '720575940618600651', '720575940627692048', '720575940630195909', '720575940646212996', '720575940610483162',
  '720575940645743412', '720575940627578156', '720575940622298631', '720575940621008895', '720575940629146711',
  '720575940610259370', '720575940610481370', '720575940619028208', '720575940614281266', '720575940613061118',
  '720575940604027168',
];
const BITTER_TYPES = ['LB1a,LB1d', 'LB1b', 'LB1c'];

export const TASTE_SOURCE = 'Shiu et al. 2024 (Nature 634:210), github.com/philshiu/Drosophila_brain_model figures.ipynb: neu_sugar, neu_sugar_left, neu_bitter (FlyWire v630 root IDs, matched to v783 by root ID)';

function countBy(arr, f) {
  const m = {};
  for (const x of arr) { const k = f(x); m[k] = (m[k] || 0) + 1; }
  return m;
}

/**
 * names: array from loadNeuronsNode(site/fly), index = cell index.
 * opts.mode: 'paper' (default) | 'bilateral'
 * -> { sweet: number[], bitter: number[], meta }
 */
export function findTasteCells(names, opts = {}) {
  const mode = opts.mode === 'bilateral' ? 'bilateral' : 'paper';
  const byId = new Map();
  for (let i = 0; i < names.length; i += 1) if (names[i] && names[i].id) byId.set(String(names[i].id), i);
  const pick = (ids) => {
    const found = []; const missing = [];
    for (const id of ids) { const i = byId.get(id); if (i == null) missing.push(id); else found.push(i); }
    return { found, missing };
  };
  const sR = pick(SUGAR_R); const sL = pick(SUGAR_L); const b = pick(BITTER);
  const sweet = [...new Set([...sR.found, ...sL.found])].sort((x, y) => x - y);
  let bitter = [...new Set(b.found)];
  let bitterByType = [];
  if (mode === 'bilateral' && b.found.length) {
    // the side the published bitter list is on, by majority
    const sides = countBy(b.found, (i) => names[i].side);
    const pubSide = Object.entries(sides).sort((x, y) => y[1] - x[1])[0][0];
    const set = new Set(bitter);
    for (let i = 0; i < names.length; i += 1) {
      const n = names[i];
      if (!n || n.side === pubSide || set.has(i)) continue;
      if (n.cls === 'sensory' && BITTER_TYPES.includes(n.type)) bitterByType.push(i);
    }
    bitter = [...bitter, ...bitterByType];
  }
  bitter.sort((x, y) => x - y);
  // the two sets must never overlap; if they did, the data would be wrong
  const sw = new Set(sweet);
  bitter = bitter.filter((i) => !sw.has(i));
  const typeSide = (i) => `${names[i].type || '?'}|${names[i].side || '?'}`;
  return {
    sweet,
    bitter,
    meta: {
      mode,
      source: TASTE_SOURCE + (mode === 'bilateral' ? `; plus contralateral cells typed ${BITTER_TYPES.join(' / ')} for bitter (by type, not published ID)` : ''),
      sweetTypes: countBy(sweet, typeSide),
      bitterTypes: countBy(bitter, typeSide),
      sweetIds: sweet.map((i) => names[i].id),
      bitterIds: bitter.map((i) => names[i].id),
      bitterByType: bitterByType.length,
      missing: { sugarR: sR.missing, sugarL: sL.missing, bitter: b.missing },
    },
  };
}

export const TASTE_DEFAULTS = {
  halfLifeMs: 4000,  // each trade halves every 4 s
  minSol: 0.01,      // at or below this a trade tastes at `floor`
  maxSol: 10,        // at or above this a trade tastes at 1.0
  floor: 0.08,       // the smallest trade still tastes of something
  dropBelow: 1e-3,   // a contribution this small is forgotten
  maxSeen: 20000,    // how many signatures are remembered for de-duplication
  dp: 6,             // levels and outputs are rounded to this many decimals (the service uses 4,
                     // the ledger's own rounding, so the stored record is exactly what drove her)
};

export function tasteLevel(sol, p = TASTE_DEFAULTS) {
  const s = Number(sol);
  if (!Number.isFinite(s) || s <= p.minSol) return p.floor;
  const x = Math.log(s / p.minSol) / Math.log(p.maxSol / p.minSol);
  const c = x <= 0 ? 0 : x >= 1 ? 1 : x;
  return p.floor + (1 - p.floor) * c;
}

const roundTo = (x, dp) => { const f = 10 ** dp; return Math.round(x * f) / f; };

export class Taste {
  constructor(opts = {}) {
    this.p = { ...TASTE_DEFAULTS, ...opts };
    if (!(this.p.halfLifeMs > 0)) throw new Error('halfLifeMs must be > 0');
    if (!(this.p.maxSol > this.p.minSol && this.p.minSol > 0)) throw new Error('need 0 < minSol < maxSol');
    this.pending = [];   // pushed, not yet sampled
    this.live = [];      // { side, level, t0 }
    this.seen = new Set();
    this.lastNow = -Infinity;
  }

  /** a Trade from src/chain. Returns true if it was taken, false if invalid or a repeat. */
  push(trade) {
    if (!trade || (trade.side !== 'buy' && trade.side !== 'sell') || !trade.sig) return false;
    const key = `${trade.sig}:${trade.side}`;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    if (this.seen.size > this.p.maxSeen) this.seen.delete(this.seen.values().next().value);
    const sol = Number(trade.sol);
    this.pending.push({ sig: String(trade.sig), side: trade.side, sol: Number.isFinite(sol) ? sol : 0, wallet: String(trade.wallet || '') });
    return true;
  }

  /** -> { sweet: 0..1, bitter: 0..1, applied: [{ sig, side, sol, wallet, level }] } */
  sample(nowMs) {
    const now = Number(nowMs);
    if (!Number.isFinite(now)) throw new Error('sample(nowMs) needs a time');
    // time never runs backwards inside one Taste: an earlier time is read as the last one
    const t = now < this.lastNow ? this.lastNow : now;
    this.lastNow = t;
    const applied = [];
    for (const tr of this.pending) {
      const level = roundTo(tasteLevel(tr.sol, this.p), this.p.dp);
      applied.push({ sig: tr.sig, side: tr.side, sol: tr.sol, wallet: tr.wallet, level });
      this.live.push({ side: tr.side, level, t0: t });
    }
    this.pending = [];
    let sweet = 0; let bitter = 0;
    const keep = [];
    for (const c of this.live) {
      const v = c.level * Math.pow(0.5, (t - c.t0) / this.p.halfLifeMs);
      if (v < this.p.dropBelow) continue;
      keep.push(c);
      if (c.side === 'buy') sweet += v; else bitter += v;
    }
    this.live = keep;
    return { sweet: roundTo(Math.min(1, sweet), this.p.dp), bitter: roundTo(Math.min(1, bitter), this.p.dp), applied };
  }
}

/**
 * Rebuild the taste from a ledger alone: ticks = [{ t, applied }] in order,
 * where t is the time that was passed to sample(). Returns [{ sweet, bitter }]
 * for each tick, equal to what sample() returned live.
 */
export function replayTaste(ticks, opts = {}) {
  const p = { ...TASTE_DEFAULTS, ...opts };
  let live = []; let last = -Infinity; const out = [];
  for (const tk of ticks) {
    const t = Math.max(last, Number(tk.t)); last = t;
    for (const a of tk.applied || []) live.push({ side: a.side, level: a.level, t0: t });
    let sweet = 0; let bitter = 0;
    const keep = [];
    for (const c of live) {
      const v = c.level * Math.pow(0.5, (t - c.t0) / p.halfLifeMs);
      if (v < p.dropBelow) continue;
      keep.push(c);
      if (c.side === 'buy') sweet += v; else bitter += v;
    }
    live = keep;
    out.push({ sweet: roundTo(Math.min(1, sweet), p.dp), bitter: roundTo(Math.min(1, bitter), p.dp) });
  }
  return out;
}
