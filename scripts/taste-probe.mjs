/**
 * What do her taste cells do? Measured on the model she runs on.
 *
 *   node scripts/taste-probe.mjs [--seeds 783,1,2] [--levels 0.25,0.5,1] [--base 600] [--drive 2000]
 *                                [--mode paper|bilateral] [--bg 0] [--json out.json]
 *
 * Protocol, per seed and condition, on a fresh FlyRate with the "brain" gains
 * from site/fly/gains.json:
 *   1. `base` ms with no drive (or only the uniform lamina background --bg).
 *      Baseline = mean over its last half.
 *   2. `drive` ms with the taste set(s) driven at `level` (FlyRate.drive, the
 *      same call the body uses for lamina cells; 1 is a hard push).
 *      Response = mean over the last half of the drive.
 *   delta = response - baseline, for each readout.
 * Nothing in the wiring or gains is changed.
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { FlyRate } from '../site/fly/rate.js';
import { loadConnectomeNode, loadNeuronsNode } from '../site/fly/load.js';
import { findTasteCells } from '../src/taste.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIR = path.join(ROOT, 'site', 'fly');

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const SEEDS = arg('seeds', '783,1,2').split(',').map(Number);
const LEVELS = arg('levels', '0.25,0.5,1').split(',').map(Number);
const BASE = Number(arg('base', 600));
const DRIVE = Number(arg('drive', 2000));
const MODE = arg('mode', 'paper');
const BG = Number(arg('bg', 0));
const JSON_OUT = arg('json', '');

const gains = JSON.parse(fs.readFileSync(path.join(DIR, 'gains.json'), 'utf8')).brain;
const t0 = Date.now();
const c = await loadConnectomeNode(DIR);
const names = await loadNeuronsNode(DIR);
const cells = findTasteCells(names, { mode: MODE });
console.log(`loaded ${c.N} cells, ${c.E} edges in ${Date.now() - t0} ms; gains ${JSON.stringify(gains)}`);
console.log(`taste mode ${MODE}: sweet ${cells.sweet.length} ${JSON.stringify(cells.meta.sweetTypes)}  bitter ${cells.bitter.length} ${JSON.stringify(cells.meta.bitterTypes)}`);
console.log(`missing in v783: ${JSON.stringify(cells.meta.missing)}`);

// --- readouts --------------------------------------------------------------
const byType = new Map();
const DNL = []; const DNR = []; const MOTOR = [];
for (let i = 0; i < c.N; i += 1) {
  const n = names[i]; if (!n) continue;
  if (n.type) { if (!byType.has(n.type)) byType.set(n.type, []); byType.get(n.type).push(i); }
  if (n.cls === 'descending') (n.side === 'right' ? DNR : DNL).push(i);
  if (n.cls === 'motor') MOTOR.push(i);
}
const NAMED = [
  ['DNa01', 'DNa01'], ['DNa02', 'DNa02'], ['DNp09', 'DNp09'], ['MDN', 'MDN'], ['oviDNb', 'oviDNb'],
  ['DNp01(GF)', 'DNp01'], ['MN9(CB0701)', 'CB0701'],
];
const READ = [
  ['DN_L', DNL], ['DN_R', DNR],
  ...NAMED.filter(([, t]) => byType.has(t)).map(([k, t]) => [k, byType.get(t)]),
  ['motor_all', MOTOR],
];
console.log('readouts: ' + READ.map(([k, v]) => `${k}=${v.length}`).join(' '));
const lamina = [];
for (const [k, e] of Object.entries(c.eyemap.eye)) if (/^L[1-5]_/.test(k)) lamina.push(...e.idx);

function snapshot(b) {
  const o = {};
  for (const [k, v] of READ) o[k] = b.mean(v);
  o.dnActive = 0; for (const i of DNL) if (b.a[i] > 0.1) o.dnActive += 1; for (const i of DNR) if (b.a[i] > 0.1) o.dnActive += 1;
  o.active = b.activeCount(0.15);
  return o;
}
const EARLY_MS = [100, 250, 500];
function runPhase(b, ms, setDrive, early = null) {
  const steps = Math.round(ms / b.p.dt); const from = Math.floor(steps / 2);
  const acc = {}; let n = 0;
  for (let s = 0; s < steps; s += 1) {
    b.clearInput();
    if (BG > 0) for (const i of lamina) b.drive(i, BG);
    setDrive(b);
    b.step(1);
    if (early && EARLY_MS.includes((s + 1) * b.p.dt)) early.push({ ms: (s + 1) * b.p.dt, active: b.activeCount(0.15), dnL: b.mean(DNL), dnR: b.mean(DNR), top: topTypes(b, driven, 6) });
    if (s >= from) {
      const snap = snapshot(b); n += 1;
      for (const [k, v] of Object.entries(snap)) acc[k] = (acc[k] || 0) + v;
    }
  }
  for (const k of Object.keys(acc)) acc[k] /= n;
  return acc;
}
function topTypes(b, exclude, k = 8) {
  const m = new Map();
  for (let i = 0; i < b.N; i += 1) {
    if (b.a[i] < 0.15 || exclude.has(i)) continue;
    const t = names[i]?.type || `(${names[i]?.cls || '?'})`;
    m.set(t, (m.get(t) || 0) + 1);
  }
  return [...m.entries()].sort((x, y) => y[1] - x[1]).slice(0, k).map(([t, n]) => `${t}:${n}`).join(' ');
}

const CONDS = [{ name: 'none (sham)', s: 0, b: 0 }];
for (const L of LEVELS) CONDS.push({ name: `sweet ${L}`, s: L, b: 0 });
for (const L of LEVELS) CONDS.push({ name: `bitter ${L}`, s: 0, b: L });
const top = Math.max(...LEVELS);
CONDS.push({ name: `both ${top}`, s: top, b: top });

const rows = [];
const sham = new Map();
const driven = new Set([...cells.sweet, ...cells.bitter]);
for (const cond of CONDS) {
  for (const seed of SEEDS) {
    const tt = Date.now();
    const b = new FlyRate(c, { ...gains, seed });
    const base = runPhase(b, BASE, () => {});
    const early = [];
    const resp = runPhase(b, DRIVE, (br) => {
      if (cond.s) for (const i of cells.sweet) br.drive(i, cond.s);
      if (cond.b) for (const i of cells.bitter) br.drive(i, cond.b);
    }, early);
    const delta = {}; for (const k of Object.keys(resp)) delta[k] = resp[k] - base[k];
    // same seed = same noise sequence, so taste minus sham is the paired effect of the taste alone
    if (!cond.s && !cond.b) sham.set(seed, resp);
    const vsSham = {}; const sh = sham.get(seed);
    if (sh) for (const k of Object.keys(resp)) vsSham[k] = resp[k] - sh[k];
    const drivenMean = { sweet: b.mean(cells.sweet), bitter: b.mean(cells.bitter) };
    const row = { cond: cond.name, seed, base, resp, delta, vsSham, drivenMean, early, top: topTypes(b, driven), ms: Date.now() - tt };
    rows.push(row);
    console.log(`${cond.name.padEnd(12)} seed ${String(seed).padStart(4)} | ` +
      READ.map(([k]) => `${k} ${delta[k] >= 0 ? '+' : ''}${delta[k].toFixed(4)}`).join(' ') +
      ` | DN>0.1 ${base.dnActive.toFixed(1)}->${resp.dnActive.toFixed(1)} | active ${Math.round(base.active)}->${Math.round(resp.active)}` +
      ` | taste cells a=${drivenMean.sweet.toFixed(2)}/${drivenMean.bitter.toFixed(2)} | ${row.ms} ms`);
    if (sh && (cond.s || cond.b)) console.log('             vs sham: ' + READ.map(([k]) => `${k} ${vsSham[k] >= 0 ? '+' : ''}${vsSham[k].toFixed(4)}`).join(' ') + ` | DN>0.1 ${vsSham.dnActive >= 0 ? '+' : ''}${vsSham.dnActive.toFixed(1)} | active ${vsSham.active >= 0 ? '+' : ''}${Math.round(vsSham.active)}`);
    for (const e of early) console.log(`             at ${String(e.ms).padStart(3)} ms: active ${e.active}, DN L/R ${e.dnL.toFixed(4)}/${e.dnR.toFixed(4)}, busiest ${e.top}`);
    console.log(`             end, busiest (not driven): ${row.top}`);
  }
}
// summary: mean and spread across seeds of (taste - sham), same seed, last half of the drive
{
  const keys = [...READ.map(([k]) => k), 'R-L', 'dnActive', 'active'];
  console.log(`\nSUMMARY (taste minus sham, mean ±sd over seeds ${SEEDS.join(',')}; sham row is the absolute level)`);
  console.log('| condition | ' + keys.join(' | ') + ' |');
  console.log('|' + '---|'.repeat(keys.length + 1));
  const val = (x, k) => (k === 'R-L' ? x.DN_R - x.DN_L : x[k]);
  for (const cond of CONDS) {
    const rs = rows.filter((r) => r.cond === cond.name);
    const isSham = !cond.s && !cond.b;
    const cells = keys.map((k) => {
      const v = rs.map((r) => val(isSham ? r.resp : r.vsSham, k));
      const m = v.reduce((a, b) => a + b, 0) / v.length;
      const sd = Math.sqrt(v.reduce((a, b) => a + (b - m) ** 2, 0) / v.length);
      const big = k === 'dnActive' || k === 'active';
      const f = (x) => (big ? x.toFixed(0) : x.toFixed(4));
      return `${!isSham && m >= 0 ? '+' : ''}${f(m)} ±${f(sd)}`;
    });
    console.log(`| ${cond.name} | ${cells.join(' | ')} |`);
  }
}
if (JSON_OUT) fs.writeFileSync(JSON_OUT, JSON.stringify({ args: { SEEDS, LEVELS, BASE, DRIVE, MODE, BG }, gains, sets: { sweet: cells.sweet.length, bitter: cells.bitter.length, meta: cells.meta }, rows }, null, 1));
console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
