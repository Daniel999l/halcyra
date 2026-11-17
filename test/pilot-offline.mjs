/**
 * Her game body with no browser at all.
 *
 *   node test/pilot-offline.mjs
 *
 * The real brain (site/fly/rate.js, fitted gains) and src/gamebody.js,
 * fed hand-made 160 x 90 luminance grids. Proves:
 *   1. every readout and pad value is finite and in range
 *   2. the pad changes with what she sees (a blank light screen vs a city of
 *      dark shapes moving past)
 *   3. a left/right asymmetric stimulus gives asymmetric steering: a dark
 *      grating drifting on the left half only vs the right half only
 *   4. the taste path: hand-picked gustatory cells are really driven, stay
 *      driven through the step (clearInput is called on every look), and the
 *      Tick says so
 *   5. the zero control: a brain that is all zeros gives a neutral pad
 *   6. what one brain step costs here
 * Nothing is tuned to make her drive well. Numbers are printed as they come.
 */
import { loadFly, flyNames, flyReadouts, GamePilot } from '../src/gamepilot.js';
import { toPad, GAMEBODY_DEFAULTS } from '../src/gamebody.js';
import { GRID_W as GW, GRID_H as GH } from '../src/eye.js';
import zlib from 'node:zlib';

let fails = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) fails += 1; };
const f4 = (v) => (v >= 0 ? ' ' : '') + v.toFixed(4);

// ---------- stimuli ----------
const blank = () => new Float32Array(GW * GH).fill(0.9);
/** dark buildings and cars sliding down the screen, like driving forward */
function city(i) {
  const g = blank();
  for (let k = 0; k < 14; k += 1) {
    const w = 8 + (k * 7) % 14; const h = 6 + (k * 5) % 12;
    const x0 = (k * 37) % (GW - w); const y0 = ((k * 23 + i * 4) % (GH + h)) - h;
    for (let y = Math.max(0, y0); y < Math.min(GH, y0 + h); y += 1) for (let x = x0; x < x0 + w; x += 1) g[y * GW + x] = 0.12 + (k % 3) * 0.08;
  }
  return g;
}
/** a dark grating drifting on one half only */
function grating(side, i) {
  const g = blank();
  for (let y = 0; y < GH; y += 1) for (let x = 0; x < GW; x += 1) {
    if ((side === 'left' ? x < 72 : x >= 88) && ((x + i * 3) % 16) < 8) g[y * GW + x] = 0.1;
  }
  return g;
}

const t0 = Date.now();
await loadFly();
const names = flyNames();
const ro = flyReadouts();
console.log(`brain loaded in ${Date.now() - t0} ms: ${names.filter(Boolean).length} cells`);
console.log(`readouts found: descending L ${ro.dnLeft.length} R ${ro.dnRight.length}; `
  + Object.entries(ro.types).map(([k, v]) => `${k} L${v.L.length} R${v.R.length}`).join(', '));
ok(ro.dnLeft.length > 500 && ro.dnRight.length > 500, 'both descending populations present');
for (const t of ['DNa01', 'DNa02', 'DNp09', 'MDN', 'DNp01', 'oviDNb']) ok(ro.types[t].L.length > 0 && ro.types[t].R.length > 0, `${t} exists on both sides`);

/** run a fresh pilot body on a stimulus sequence -> per-step outputs */
function run(seed, stim, steps, { ms = 160, taste = null, tasteCells = null } = {}) {
  const p = new GamePilot({ seed, tasteCells });
  const outs = [];
  for (let i = 0; i < steps; i += 1) outs.push(JSON.parse(JSON.stringify(p.body.live(stim(i), GW, GH, ms, null, taste))));
  return { p, outs };
}
const mean = (arr, f) => arr.reduce((s, o) => s + f(o), 0) / arr.length;
const finitePad = (o) => o.pad.axes.every((v) => Number.isFinite(v) && v >= -1 && v <= 1)
  && Object.values(o.pad.buttons).every((v) => Number.isFinite(v) && v >= 0 && v <= 1)
  && Object.values(o.dn).every(Number.isFinite);

// ---------- 1 + 2: finite, and changes with input ----------
const tb = performance.now();
const A = run(11, () => blank(), 10);
const B = run(11, city, 10);
const perStep = (performance.now() - tb) / 20;
ok(A.outs.every(finitePad) && B.outs.every(finitePad), 'every readout and pad value finite and in range (20 steps)');
const lastA = A.outs.slice(3); const lastB = B.outs.slice(3);
console.log(`  blank light screen: DN L ${f4(mean(lastA, (o) => o.dn.L))} R ${f4(mean(lastA, (o) => o.dn.R))}  steer ${f4(mean(lastA, (o) => o.pad.axes[0]))}  gas ${f4(mean(lastA, (o) => o.pad.buttons.rt))}  brake ${f4(mean(lastA, (o) => o.pad.buttons.lt))}`);
console.log(`  city sliding past : DN L ${f4(mean(lastB, (o) => o.dn.L))} R ${f4(mean(lastB, (o) => o.dn.R))}  steer ${f4(mean(lastB, (o) => o.pad.axes[0]))}  gas ${f4(mean(lastB, (o) => o.pad.buttons.rt))}  brake ${f4(mean(lastB, (o) => o.pad.buttons.lt))}`);
const padDist = lastB.reduce((s, o, i) => s + Math.abs(o.pad.buttons.rt - lastA[i].pad.buttons.rt) + Math.abs(o.pad.axes[0] - lastA[i].pad.axes[0]), 0) / lastB.length;
ok(padDist > 0.05, `pad changes with what she sees (mean |gas|+|steer| difference ${padDist.toFixed(3)})`);
const vary = new Set(lastB.map((o) => o.pad.buttons.rt.toFixed(3) + o.pad.axes[0].toFixed(3))).size;
ok(vary > 3, `pad varies step to step on a moving scene (${vary} distinct of ${lastB.length})`);

// ---------- 3: left/right asymmetry ----------
console.log('  one-sided drifting grating, mean over steps 3..11, steer = (R-L)/kTurn:');
let asymOk = 0; const seeds = [1, 2, 3];
for (const seed of seeds) {
  const r = {};
  for (const side of ['left', 'right']) {
    const { outs } = run(seed, (i) => grating(side, i), 12);
    const o = outs.slice(3);
    r[side] = { d: mean(o, (x) => x.dn.R - x.dn.L), lx: mean(o, (x) => x.pad.axes[0]), a2: mean(o, (x) => x.dn.DNa02R - x.dn.DNa02L), gf: Math.max(...o.map((x) => x.dn.DNp01)) };
  }
  const diff = r.right.lx - r.left.lx;
  if (diff > 0) asymOk += 1;
  console.log(`  seed ${seed}: left stim  R-L ${f4(r.left.d)} steer ${f4(r.left.lx)} DNa02 R-L ${f4(r.left.a2)} DNp01 max ${r.left.gf.toFixed(3)}`);
  console.log(`          right stim R-L ${f4(r.right.d)} steer ${f4(r.right.lx)} DNa02 R-L ${f4(r.right.a2)} DNp01 max ${r.right.gf.toFixed(3)}   right minus left steer ${f4(diff)}`);
}
ok(asymOk === seeds.length, `steering is asymmetric and in the same direction for every seed (${asymOk}/${seeds.length}: stimulus on her right steers further right than on her left)`);

// ---------- 4: taste wiring ----------
// Hand-picked for this wiring test only (TASTE picks the real sweet/bitter
// cells in src/taste.js): two gustatory sensory types from the cell table.
const pick = (type) => names.map((n, i) => (n && n.type === type && n.cls === 'sensory' ? i : -1)).filter((i) => i >= 0);
const tasteCells = { sweet: pick('claw_tpGRN'), bitter: pick('LB3') };
console.log(`  test taste cells: "sweet" = claw_tpGRN x${tasteCells.sweet.length}, "bitter" = LB3 x${tasteCells.bitter.length} (wiring test only)`);
const pT = new GamePilot({ seed: 5, tasteCells });
const pN = new GamePilot({ seed: 5, tasteCells });
const fakeTaste = { sweet: 0.8, bitter: 0, applied: [{ sig: 'test', side: 'buy', sol: 1, wallet: 'test', level: 0.8 }] };
let outT; let outN;
for (let i = 0; i < 6; i += 1) {
  outT = pT.body.live(city(i), GW, GH, 160, null, fakeTaste);
  outN = pN.body.live(city(i), GW, GH, 160, null, null);
}
const aSweetT = pT.brain.mean(tasteCells.sweet); const aSweetN = pN.brain.mean(tasteCells.sweet);
const inStill = tasteCells.sweet.every((i) => Math.abs(pT.brain.input[i] - 0.8 * GAMEBODY_DEFAULTS.kSweet) < 1e-6);
ok(outT.drove.sweet === tasteCells.sweet.length && outT.drove.bitter === 0 && outN.drove.sweet === 0, `Tick.drove counts taste cells (sweet ${outT.drove.sweet}, bitter ${outT.drove.bitter}; without taste ${outN.drove.sweet})`);
ok(inStill, 'taste drive is still on the cells at the end of the step (not wiped by clearInput)');
ok(aSweetT > aSweetN + 0.1, `driven sweet cells are active (mean ${aSweetT.toFixed(3)} with taste vs ${aSweetN.toFixed(3)} without)`);
let changed = 0;
for (let i = 0; i < pT.brain.N; i += 1) if (Math.abs(pT.brain.a[i] - pN.brain.a[i]) > 0.05 && !tasteCells.sweet.includes(i)) changed += 1;
console.log(`  cells other than the driven ones whose activity differs by > 0.05 with taste: ${changed}`);
console.log(`  pad with taste: steer ${f4(outT.pad.axes[0])} gas ${f4(outT.pad.buttons.rt)}; without: steer ${f4(outN.pad.axes[0])} gas ${f4(outN.pad.buttons.rt)} (whatever the wiring does; not asserted)`);
const pBit = new GamePilot({ seed: 5, tasteCells });
const oBit = pBit.body.live(city(0), GW, GH, 160, null, { sweet: 0, bitter: 0.5 });
ok(oBit.drove.bitter === tasteCells.bitter.length && oBit.drove.sweet === 0, `bitter path drives bitter cells only (${oBit.drove.bitter})`);

// GamePilot.step on a stand-in page: the Tick shape
function pngOf(grid) {
  const raw = Buffer.alloc(GH * (GW * 3 + 1));
  for (let y = 0; y < GH; y += 1) {
    raw[y * (GW * 3 + 1)] = 0;
    for (let x = 0; x < GW; x += 1) { const v = Math.round(grid[y * GW + x] * 255); const o = y * (GW * 3 + 1) + 1 + x * 3; raw[o] = v; raw[o + 1] = v; raw[o + 2] = v; }
  }
  const crcT = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
  const crc = (b) => { let c = -1; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const chunk = (t, d) => { const l = Buffer.alloc(4); l.writeUInt32BE(d.length); const body = Buffer.concat([Buffer.from(t), d]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(body)); return Buffer.concat([l, body, c]); };
  const ih = Buffer.alloc(13); ih.writeUInt32BE(GW, 0); ih.writeUInt32BE(GH, 4); ih[8] = 8; ih[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ih), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
let frameI = 0;
const evals = [];
const fakePage = {
  screenshot: async () => pngOf(city(frameI++)),
  evaluate: async (js) => { evals.push(String(js)); return 1; },
  addInitScript: async () => {},
  viewportSize: () => ({ width: 1280, height: 720 }),
  context: () => { throw new Error('no cdp here'); },
};
const gp = new GamePilot({ seed: 9, tasteCells, eye: 'small' });
await gp.attach(fakePage);
let tick;
for (let i = 0; i < 3; i += 1) tick = await gp.step(fakePage, { ms: 160, taste: fakeTaste });
const shapeOk = ['step', 't', 'ms', 'taste', 'drove', 'dn', 'active', 'pad', 'lit'].every((k) => k in tick)
  && ['L', 'R', 'DNa01', 'DNa02', 'DNp09', 'oviDNb'].every((k) => Number.isFinite(tick.dn[k]))
  && tick.pad.axes.length === 4 && Object.keys(tick.pad.buttons).length === 17
  && Array.isArray(tick.lit) && tick.taste.applied.length === 1;
ok(shapeOk, `GamePilot.step returns the Tick shape (step ${tick.step}, ${tick.active} active, ${tick.lit.length} lit, eye fell back to "${gp.eyeMode}")`);
ok(evals.some((s) => s.includes('__pad.set')), 'GamePilot.step sets the virtual pad on the page');
ok(gp.telemetry() && gp.telemetry().pad, 'telemetry() returns a snapshot');

// ---------- 5: zero control ----------
const zero = toPad({ L: 0, R: 0, DNa01: 0, DNa02: 0, DNp09: 0, MDN: 0, DNp01: 0, oviDNb: 0 }, GAMEBODY_DEFAULTS);
ok(zero.axes.every((v) => v === 0) && Object.values(zero.buttons).every((v) => v === 0), 'all-zero brain gives a neutral pad (no hidden drive)');

// ---------- 6: cost ----------
const bb = new GamePilot({ seed: 3 });
for (let i = 0; i < 3; i += 1) bb.body.live(city(i), GW, GH, 160, null, null);
const tq = performance.now();
const N = 64;
for (let i = 0; i < N / 32; i += 1) bb.body.live(city(i + 3), GW, GH, 160, null, null);
const msPerBrainStep = (performance.now() - tq) / N;
console.log(`cost: ${msPerBrainStep.toFixed(2)} ms per brain step (dt ${bb.brain.p.dt} ms of brain time, look + step + readouts), `
  + `${(msPerBrainStep * 32).toFixed(0)} ms per 160 ms window, ${bb.brain.activeCount(0.12)} cells active; `
  + `brain runs at ${(bb.brain.p.dt / msPerBrainStep).toFixed(2)}x real time on this CPU`);
console.log(`(average live() call in sections 1-2: ${perStep.toFixed(0)} ms for a 160 ms window)`);

console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
