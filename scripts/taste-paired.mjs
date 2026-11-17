#!/usr/bin/env node
/**
 * What one trade does to her, measured as a paired difference.
 *
 *   node scripts/taste-paired.mjs record [--looks 300] [--look-ms 233] [--brain-ms 70]
 *       She plays the mock console (headless Chrome, worker brain, 'frame' eye,
 *       seed 783, no taste), one look every --look-ms of wall time (the live rate
 *       at the default BRAIN_MS). Every luminance grid she saw is
 *       saved to data/taste-frames.bin.gz with a JSON header.
 *
 *   node scripts/taste-paired.mjs run --seeds 1,2,3 --out data/taste-paired-a.json [--trade-at 40]
 *       Offline, no browser. For each seed: one brain plays the recorded frames
 *       up to look --trade-at with no taste, then is copied (BrainCore snapshot:
 *       every cell's V, a, w, input, the noise generator's state, the body's
 *       eye memory) into one brain per condition. From there all of them see the
 *       same frames at the same moments with the same noise; the ONLY difference
 *       is one trade pushed into Taste right before the sample at look --trade-at:
 *         none | buy 0.1 / 1 / 10 SOL | sell 0.1 / 1 / 10 SOL
 *       plus clearly labelled extras: the same six at taste gain 2 (kSweet =
 *       kBitter = 2 instead of 1), and the three sells with 'bilateral' bitter
 *       cells. Same seed + same input = same bits (test/brain-worker.mjs), so
 *       condition minus none is exactly the trade's effect.
 *       Taste is the service's (src/taste.js, dp 4); its clock advances
 *       --look-ms per look, so the trade fades on the live schedule (half-life 4 s).
 *
 *   node scripts/taste-paired.mjs report data/taste-paired-*.json [--md out.md]
 *       Tables: per readout and per pad control, the mean paired difference in
 *       the 2, 5 and 10 s after the trade, its spread across seeds, how many seeds
 *       agree in sign, how many pad values differ at all; and how long the paired
 *       runs stay different.
 *
 *   node scripts/taste-paired.mjs all --seeds 1,...,8 [--procs 2]
 *       run in --procs processes, then report.
 *
 * Nothing here changes a gain, a cell set or the model to make an effect.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const mode = argv[0];
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const FRAMES = path.join(ROOT, 'data', 'taste-frames.bin.gz');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const READOUTS = ['L', 'R', 'DNa01', 'DNa02', 'DNp09', 'MDN', 'DNp01', 'oviDNb'];
const PAD = {
  steer: (o) => o.pad.axes[0],
  gas: (o) => o.pad.buttons.rt,
  brake: (o) => o.pad.buttons.lt,
  'handbrake (escape)': (o) => (o.escape ? 1 : 0),
  'commit (Y)': (o) => (o.commit ? 1 : 0),
};
const CONDITIONS = [
  { id: 'none', side: null, sol: 0 },
  ...[0.1, 1, 10].map((sol) => ({ id: `buy ${sol}`, side: 'buy', sol })),
  ...[0.1, 1, 10].map((sol) => ({ id: `sell ${sol}`, side: 'sell', sol })),
  ...[0.1, 1, 10].map((sol) => ({ id: `gain2 buy ${sol}`, side: 'buy', sol, gain: 2, extra: 'taste gain 2' })),
  ...[0.1, 1, 10].map((sol) => ({ id: `gain2 sell ${sol}`, side: 'sell', sol, gain: 2, extra: 'taste gain 2' })),
  ...[0.1, 1, 10].map((sol) => ({ id: `bilateral sell ${sol}`, side: 'sell', sol, bilateral: true, extra: 'bilateral bitter' })),
];

// ------------------------------------------------------------------ record
async function record() {
  const LOOKS = Number(arg('looks', 300)); const LOOK_MS = Number(arg('look-ms', 233)); const BRAIN_MS = Number(arg('brain-ms', 70));
  const { chromium } = await import('playwright-core');
  const { serveMock } = await import('../test/mock-console/serve.mjs');
  const { loadFly, GamePilot } = await import('../src/gamepilot.js');
  const { GRID_W, GRID_H } = await import('../src/eye.js');
  await loadFly();
  const srv = await serveMock(0);
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const pilot = new GamePilot({ seed: 783, eye: 'frame', thread: 'worker' });
  await pilot.attach(page);
  await page.goto(srv.url);
  await page.waitForTimeout(800);
  await pilot.attach(page);
  const grids = new Float32Array(LOOKS * GRID_W * GRID_H);
  const look = pilot.eye.look.bind(pilot.eye);
  let k = 0;
  pilot.eye.look = async (p) => { const g = await look(p); if (k < LOOKS) grids.set(g, k * GRID_W * GRID_H); return g; };
  const paths = {}; const late = [];
  const t0 = performance.now();
  for (k = 0; k < LOOKS; k += 1) {
    const due = t0 + k * LOOK_MS;
    const wait = due - performance.now();
    if (wait > 0) await sleep(wait); else late.push(-wait);
    await pilot.step(page, { ms: BRAIN_MS, taste: null });
    paths[pilot.eye.lastPath] = (paths[pilot.eye.lastPath] || 0) + 1;
  }
  const game = await page.evaluate(() => window.__game);
  await pilot.close(); await browser.close(); await srv.close();
  const header = { looks: LOOKS, lookMs: LOOK_MS, brainMs: BRAIN_MS, w: GRID_W, h: GRID_H, seed: 783, eye: 'frame', paths, lateLooks: late.length, game: { dist: game.dist, collisions: game.collisions }, at: new Date().toISOString(), source: 'test/mock-console, she drove (seed 783, no taste), headless Chrome' };
  const hb = Buffer.from(JSON.stringify(header));
  const len = Buffer.alloc(4); len.writeUInt32LE(hb.length);
  fs.writeFileSync(FRAMES, zlib.gzipSync(Buffer.concat([len, hb, Buffer.from(grids.buffer)])));
  console.log(`recorded ${LOOKS} looks -> ${path.relative(ROOT, FRAMES)} (${(fs.statSync(FRAMES).size / 1e6).toFixed(1)} MB); ${JSON.stringify(header)}`);
}

function loadFrames() {
  const raw = zlib.gunzipSync(fs.readFileSync(FRAMES));
  const n = raw.readUInt32LE(0);
  const header = JSON.parse(raw.subarray(4, 4 + n).toString('utf8'));
  const body = raw.subarray(4 + n);
  const all = new Float32Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength));
  const sz = header.w * header.h;
  return { header, frame: (i) => all.slice(i * sz, (i + 1) * sz) };
}

// ------------------------------------------------------------------ run
async function run() {
  const seeds = arg('seeds', '1').split(',').map(Number);
  const out = arg('out', path.join(ROOT, 'data', 'taste-paired-part.json'));
  const TRADE_AT = Number(arg('trade-at', 40));
  const only = arg('conditions', null);
  const conds = only ? CONDITIONS.filter((c) => c.id === 'none' || only.split(',').includes(c.id)) : CONDITIONS;
  const { loadFly, flyNames, flyReadouts, brainGains } = await import('../src/gamepilot.js');
  const { BrainCore } = await import('../src/braincore.js');
  const { Taste, findTasteCells } = await import('../src/taste.js');
  const c = await loadFly();
  const names = flyNames();
  const paper = findTasteCells(names); const bilateral = findTasteCells(names, { mode: 'bilateral' });
  const { header, frame } = loadFrames();
  const MS = header.brainMs; const LOOK_MS = header.lookMs; const LOOKS = header.looks;
  const result = { header, tradeAt: TRADE_AT, brainMs: MS, lookMs: LOOK_MS, conditions: conds.map(({ id, side, sol, gain, bilateral: bl, extra }) => ({ id, side, sol, gain: gain || 1, bilateral: !!bl, extra: extra || null })), cells: { sweet: paper.sweet.length, bitter: paper.bitter.length, bitterBilateral: bilateral.bitter.length }, seeds: {} };
  for (const seed of seeds) {
    const t0 = Date.now();
    const mk = (cond) => new BrainCore({
      connectome: c, readouts: flyReadouts(), gains: brainGains(), seed, snapshots: true,
      tasteCells: cond.bilateral ? bilateral : paper,
      body: cond.gain ? { kSweet: cond.gain, kBitter: cond.gain } : {},
    });
    const base = mk(conds[0]);
    for (let i = 0; i < TRADE_AT; i += 1) base.think(frame(i), MS, null);
    const snap = base.snapshot();
    const runs = conds.map((cond) => {
      const core = cond.id === 'none' ? base : mk(cond);
      if (core !== base) core.restore(snap);
      const taste = new Taste({ dp: 4 });
      // the taste clock before the trade: same samples as the live loop would take
      for (let i = 0; i < TRADE_AT; i += 1) taste.sample(i * LOOK_MS);
      return { cond, core, taste, rows: [] };
    });
    for (let i = TRADE_AT; i < LOOKS; i += 1) {
      const lum = frame(i);
      for (const r of runs) {
        if (i === TRADE_AT && r.cond.side) r.taste.push({ sig: `paired-${seed}-${r.cond.id}`, side: r.cond.side, sol: r.cond.sol, wallet: 'experiment' });
        const s = r.taste.sample(i * LOOK_MS);
        const o = r.core.think(lum.slice(), MS, (s.sweet || s.bitter) ? s : null);
        r.last = o;
        r.rows.push({ dn: Object.fromEntries(READOUTS.map((k) => [k, o.out.dn[k]])), pad: Object.fromEntries(Object.entries(PAD).map(([k, f]) => [k, f(o.out)])), active: o.active, sweet: s.sweet, bitter: s.bitter, drove: o.out.drove });
      }
      // how different are the brains, cell by cell, from the no-trade brain
      const a0 = runs[0].core.brain.a;
      for (const r of runs.slice(1)) {
        const a = r.core.brain.a; let nd = 0; let sum = 0;
        for (let j = 0; j < a.length; j += 1) { const d = a[j] - a0[j]; if (d !== 0) { nd += 1; sum += Math.abs(d); } }
        const row = r.rows.at(-1); row.cellsDiffer = nd; row.meanAbsDa = sum / a.length;
      }
    }
    result.seeds[seed] = Object.fromEntries(runs.map((r) => [r.cond.id, r.rows]));
    console.log(`seed ${seed}: ${runs.length} conditions x ${LOOKS - TRADE_AT} looks in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    fs.writeFileSync(out, JSON.stringify(result));
  }
  console.log(`-> ${path.relative(ROOT, out)}`);
}

// ------------------------------------------------------------------ report
function stats(xs) {
  const n = xs.length; const m = xs.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1)) : 0;
  return { mean: m, sd, pos: xs.filter((x) => x > 0).length, neg: xs.filter((x) => x < 0).length, zero: xs.filter((x) => x === 0).length, n };
}
const fmt = (v, dp = 4) => (v === 0 ? '0' : (v > 0 ? '+' : '') + v.toFixed(dp));

function report(files) {
  const parts = files.map((f) => JSON.parse(fs.readFileSync(f, 'utf8')));
  const P = parts[0]; const seeds = {};
  for (const p of parts) Object.assign(seeds, p.seeds);
  const seedIds = Object.keys(seeds).sort((a, b) => a - b);
  const LOOK_MS = P.lookMs;
  const W = [2, 5, 10];
  const nLooks = (s) => Math.round((s * 1000) / LOOK_MS);
  const conds = P.conditions.filter((c) => c.id !== 'none');
  const vars = [...READOUTS.map((k) => ({ k, kind: 'dn', get: (r) => r.dn[k] })), { k: 'active cells', kind: 'n', get: (r) => r.active }, ...Object.keys(PAD).map((k) => ({ k, kind: 'pad', get: (r) => r.pad[k] }))];
  const table = {};
  const lines = [];
  const consistent = [];
  for (const cond of conds) {
    table[cond.id] = {};
    for (const v of vars) {
      table[cond.id][v.k] = {};
      for (const w of W) {
        const per = seedIds.map((sd) => {
          const a = seeds[sd][cond.id].slice(0, nLooks(w)); const b = seeds[sd].none.slice(0, nLooks(w));
          return a.reduce((s, r, i) => s + (v.get(r) - v.get(b[i])), 0) / a.length;
        });
        const st = stats(per);
        let differ = 0; let total = 0;
        if (v.kind === 'pad') for (const sd of seedIds) { const a = seeds[sd][cond.id].slice(0, nLooks(w)); const b = seeds[sd].none.slice(0, nLooks(w)); for (let i = 0; i < a.length; i += 1) { total += 1; if (v.get(a[i]) !== v.get(b[i])) differ += 1; } }
        table[cond.id][v.k][w] = { ...st, perSeed: per, ...(v.kind === 'pad' ? { padDiffer: differ, padTotal: total } : {}) };
        const agree = Math.max(st.pos, st.neg);
        if (agree >= Math.ceil(0.875 * st.n) && st.n >= 8 && st.mean !== 0) consistent.push({ cond: cond.id, extra: cond.extra, v: v.k, w, mean: st.mean, sd: st.sd, pos: st.pos, neg: st.neg, n: st.n });
      }
    }
  }
  // memory: how long the paired runs stay different
  const memory = {};
  for (const cond of conds) {
    const rows = seedIds.map((sd) => seeds[sd][cond.id]);
    const at = (s) => { const i = Math.min(rows[0].length - 1, Math.max(0, nLooks(s) - 1)); return { cellsDiffer: stats(rows.map((r) => r[i].cellsDiffer)).mean, meanAbsDa: stats(rows.map((r) => r[i].meanAbsDa)).mean }; };
    const lastPadDiff = rows.map((r, si) => { const b = seeds[seedIds[si]].none; let last = -1; for (let i = 0; i < r.length; i += 1) if (Object.keys(PAD).some((k) => r[i].pad[k] !== b[i].pad[k])) last = i; return last; });
    const identicalAgain = rows.map((r) => r.findIndex((x, i) => i > 0 && x.cellsDiffer === 0));
    const tasteGone = rows[0].findIndex((x, i) => i > 0 && x.sweet === 0 && x.bitter === 0);
    memory[cond.id] = { at1s: at(1), at5s: at(5), at10s: at(10), at30s: at(30), atEnd: at((rows[0].length * LOOK_MS) / 1000), lastLookPadDiffersS: lastPadDiff.map((i) => +(((i + 1) * LOOK_MS) / 1000).toFixed(1)), bitIdenticalAgainAtS: identicalAgain.map((i) => (i < 0 ? null : +(((i + 1) * LOOK_MS) / 1000).toFixed(1))), tasteBackToZeroS: tasteGone < 0 ? null : +(((tasteGone + 1) * LOOK_MS) / 1000).toFixed(1), windowS: +((rows[0].length * LOOK_MS) / 1000).toFixed(1) };
  }
  // markdown
  const md = [];
  md.push(`Seeds: ${seedIds.join(', ')} (${seedIds.length}). Frames: ${P.header.looks} recorded looks of the mock console (${P.header.source}), one look per ${LOOK_MS} ms of wall time, ${P.brainMs} ms of brain time per look (the service defaults). Trade injected at look ${P.tradeAt} (${((P.tradeAt * LOOK_MS) / 1000).toFixed(1)} s in), followed for ${P.header.looks - P.tradeAt} looks (${(((P.header.looks - P.tradeAt) * LOOK_MS) / 1000).toFixed(0)} s). Taste cells: ${P.cells.sweet} sweet, ${P.cells.bitter} bitter (paper), ${P.cells.bitterBilateral} bitter (bilateral). Taste levels: 0.1 SOL = ${tl(0.1)}, 1 SOL = ${tl(1)}, 10 SOL = ${tl(10)}.`);
  md.push('');
  md.push('Each cell: mean over seeds of (trade run minus no-trade run, averaged over the window) ± sd across seeds, then [seeds above zero / below zero]. Pad rows also give how many pad values differed at all (looks x seeds). Readouts are mean release 0..1; `active cells` is a count.');
  for (const group of [null, 'taste gain 2', 'bilateral bitter']) {
    const cs = conds.filter((c) => c.extra === group);
    if (!cs.length) continue;
    md.push('');
    md.push(`#### ${group ? `Extra columns: ${group} (NOT the product setting)` : 'Product setting (taste gain 1, paper cells)'}`);
    for (const w of W) {
      md.push('');
      md.push(`**${w} s after the trade (${nLooks(w)} looks)**`);
      md.push('');
      md.push(`| | ${cs.map((c) => c.id).join(' | ')} |`);
      md.push(`|---|${cs.map(() => '---').join('|')}|`);
      for (const v of vars) {
        md.push(`| ${v.k} | ${cs.map((c) => { const s = table[c.id][v.k][w]; const dp = v.kind === 'n' ? 0 : 4; return `${fmt(s.mean, dp)} ±${s.sd.toFixed(dp)} [${s.pos}/${s.neg}]${v.kind === 'pad' ? ` (${s.padDiffer}/${s.padTotal} differ)` : ''}`; }).join(' | ')} |`);
      }
    }
  }
  // for scale: how much each value moves on its own, look to look, with no trade
  md.push('');
  md.push('#### For scale: the no-trade run on its own (same windows)');
  md.push('');
  md.push(`| | mean | sd across looks (10 s window, mean over seeds) |`);
  md.push('|---|---|---|');
  for (const v of vars) {
    const per = seedIds.map((sd) => { const b = seeds[sd].none.slice(0, nLooks(10)).map(v.get); const m = b.reduce((a, x) => a + x, 0) / b.length; return { m, sd: Math.sqrt(b.reduce((a, x) => a + (x - m) ** 2, 0) / Math.max(1, b.length - 1)) }; });
    const dp = v.kind === 'n' ? 0 : 4;
    md.push(`| ${v.k} | ${(per.reduce((a, x) => a + x.m, 0) / per.length).toFixed(dp)} | ${(per.reduce((a, x) => a + x.sd, 0) / per.length).toFixed(dp)} |`);
  }
  md.push('');
  md.push('#### How long the paired runs stay different');
  md.push('');
  md.push('| condition | taste back to 0 after | cells differing 1 s / 5 s / 10 s / 30 s / end | mean abs activity difference 1 s / 10 s / end | last look a pad value differs (per seed, s) | bit-identical again |');
  md.push('|---|---|---|---|---|---|');
  for (const c of conds) {
    const m = memory[c.id];
    md.push(`| ${c.id} | ${m.tasteBackToZeroS ?? '>' + m.windowS} s | ${[m.at1s, m.at5s, m.at10s, m.at30s, m.atEnd].map((x) => Math.round(x.cellsDiffer).toLocaleString()).join(' / ')} | ${[m.at1s, m.at10s, m.atEnd].map((x) => x.meanAbsDa.toFixed(4)).join(' / ')} | ${m.lastLookPadDiffersS.join(', ')} | ${m.bitIdenticalAgainAtS.every((x) => x == null) ? 'never (in ' + m.windowS + ' s)' : m.bitIdenticalAgainAtS.join(', ')} |`);
  }
  md.push('');
  md.push(`Consistent in direction (at least ${Math.ceil(0.875 * seedIds.length)} of ${seedIds.length} seeds agree in sign): ${consistent.length ? '' : 'none.'}`);
  for (const x of consistent) md.push(`- ${x.cond}${x.extra ? ` (${x.extra})` : ''}, ${x.v}, ${x.w} s: ${fmt(x.mean)} ±${x.sd.toFixed(4)} [${x.pos}/${x.neg}]`);
  const text = md.join('\n');
  const mdOut = arg('md', path.join(ROOT, 'data', 'taste-paired.md'));
  fs.writeFileSync(mdOut, text + '\n');
  fs.writeFileSync(path.join(ROOT, 'data', 'taste-paired.json'), JSON.stringify({ seeds: seedIds, lookMs: LOOK_MS, brainMs: P.brainMs, tradeAt: P.tradeAt, table, memory, consistent }, null, 1));
  console.log(text);
}
function tl(sol) { const p = { minSol: 0.01, maxSol: 10, floor: 0.08 }; const x = Math.log(sol / p.minSol) / Math.log(p.maxSol / p.minSol); return (p.floor + (1 - p.floor) * Math.min(1, Math.max(0, x))).toFixed(2); }

// ------------------------------------------------------------------ all
async function all() {
  const seeds = arg('seeds', '1,2,3,4,5,6,7,8').split(',');
  const procs = Number(arg('procs', 2));
  const groups = Array.from({ length: procs }, (_, i) => seeds.filter((_, j) => j % procs === i)).filter((g) => g.length);
  const files = groups.map((_, i) => path.join(ROOT, 'data', `taste-paired-part${i + 1}.json`));
  await Promise.all(groups.map((g, i) => new Promise((resolve, reject) => {
    const extra = arg('trade-at', null) ? ['--trade-at', arg('trade-at')] : [];
    const p = spawn(process.execPath, [fileURLToPath(import.meta.url), 'run', '--seeds', g.join(','), '--out', files[i], ...extra], { stdio: 'inherit' });
    p.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`part ${i + 1} exited ${code}`))));
  })));
  report(files);
}

if (mode === 'record') await record();
else if (mode === 'run') await run();
else if (mode === 'report') report(argv.slice(1).filter((a) => a.endsWith('.json')));
else if (mode === 'all') await all();
else { console.log('usage: node scripts/taste-paired.mjs record | run --seeds 1,2 --out f.json | report f1.json f2.json | all --seeds 1,...,8'); process.exit(2); }
process.exit(0);
