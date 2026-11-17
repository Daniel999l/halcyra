#!/usr/bin/env node
/**
 * Check, against a running service, that every trade she was served went into
 * her as taste, and that the taste in the ledger can be rebuilt from the
 * ledger alone.
 *
 *   node scripts/check-taste.mjs http://localhost:8080 [--json out.json]
 *
 * Reads /api/ticks (all pages), /api/trades and checks:
 *   1. every trade in /api/trades that arrived before the last tick is listed
 *      in exactly one tick's taste.applied (side and sol match)
 *   2. on every tick whose taste.sweet > 0 the sweet cells were driven
 *      (drove.sweet > 0), and the same for bitter; with taste 0, drove 0
 *   3. replayTaste (src/taste.js) over { t: tasteAt, applied } of the served
 *      ticks gives exactly the recorded taste.sweet / taste.bitter on every tick
 *   4. scripts/verify-chain.mjs is a separate check (run it too)
 * Exit 0 = all hold.
 */
import fs from 'node:fs';
import { replayTaste } from '../src/taste.js';

const args = process.argv.slice(2);
const base = (args.find((a) => /^https?:\/\//.test(a)) || '').replace(/\/$/, '');
const jsonOut = args.includes('--json') ? args[args.indexOf('--json') + 1] : null;
if (!base) { console.error('usage: node scripts/check-taste.mjs <url> [--json out.json]'); process.exit(2); }
const get = async (p) => { const r = await fetch(base + p); if (!r.ok) throw new Error(`${p}: HTTP ${r.status}`); return r.json(); };

const ticks = [];
for (let after = -1; ;) {
  const page = await get(`/api/ticks?after=${after}&limit=1000`);
  if (!page.ticks.length) break;
  ticks.push(...page.ticks.filter((t) => t.kind !== 'unlock')); // ladder unlock records (docs/STAGES.md) are not looks
  after = page.ticks.at(-1).step;
}
const { trades } = await get('/api/trades?limit=200');
const proof = await get('/api/proof');

let fails = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) fails += 1; };

console.log(`${ticks.length} ticks (steps ${ticks[0]?.step}..${ticks.at(-1)?.step}), ${trades.length} trades served`);

// 1. trades -> applied, once each
const appliedAt = new Map();
for (const tk of ticks) for (const a of tk.taste?.applied || []) {
  if (!appliedAt.has(a.sig)) appliedAt.set(a.sig, []);
  appliedAt.get(a.sig).push({ step: tk.step, a });
}
const firstT = ticks[0]?.tasteAt ?? Infinity; const lastT = ticks.at(-1)?.tasteAt ?? -Infinity;
let tasted = 0; let late = 0; let early = 0; const rows = [];
for (const t of trades) {
  const hits = appliedAt.get(t.sig) || [];
  if (!hits.length) {
    // a trade can only be missing if it arrived after the last served tick, or before the first one kept in memory
    if (t.receivedAt && t.receivedAt > lastT) { late += 1; continue; }
    if (t.receivedAt && t.receivedAt < firstT) { early += 1; continue; }
    ok(false, `trade ${t.sig.slice(0, 12)} (${t.side} ${t.sol}) is in no tick's taste.applied`);
    continue;
  }
  tasted += 1;
  if (hits.length !== 1) ok(false, `trade ${t.sig.slice(0, 12)} applied ${hits.length} times`);
  const { step, a } = hits[0];
  if (a.side !== t.side || Math.abs(a.sol - t.sol) > 1e-4) ok(false, `trade ${t.sig.slice(0, 12)} applied as ${a.side} ${a.sol}, served as ${t.side} ${t.sol}`);
  const tk = ticks.find((x) => x.step === step);
  rows.push({ sig: t.sig, side: t.side, sol: t.sol, level: a.level, step, taste: tk.taste.sweet !== undefined ? { sweet: tk.taste.sweet, bitter: tk.taste.bitter } : null, drove: tk.drove });
}
ok(tasted + late + early === trades.length, `${tasted} of ${trades.length} served trades are in exactly one tick's taste.applied (${late} arrived after the last tick, ${early} before the first tick held)`);
const sigsInTicks = [...appliedAt.keys()];
const served = new Set(trades.map((t) => t.sig));
const notServed = sigsInTicks.filter((s) => !served.has(s));
ok(notServed.length === 0 || trades.length === 200, `every applied trade is in /api/trades (${notServed.length} not, list capped at 200)`);

// 2. drove follows taste
let sweetTicks = 0; let bitterTicks = 0; let droveBad = 0;
for (const tk of ticks) {
  const s = tk.taste?.sweet || 0; const b = tk.taste?.bitter || 0;
  if (s > 0) sweetTicks += 1; if (b > 0) bitterTicks += 1;
  const nS = proof.taste?.sweet?.count; const nB = proof.taste?.bitter?.count;
  if ((s > 0) !== (tk.drove?.sweet > 0) || (b > 0) !== (tk.drove?.bitter > 0)) droveBad += 1;
  else if (s > 0 && tk.drove.sweet !== nS) droveBad += 1;
  else if (b > 0 && tk.drove.bitter !== nB) droveBad += 1;
}
ok(droveBad === 0, `drove.sweet / drove.bitter = the full taste cell sets exactly on the ticks with taste (${sweetTicks} sweet ticks, ${bitterTicks} bitter ticks, ${droveBad} wrong)`);

// 3. replay
const startsClean = ticks[0]?.step === 0;
const replay = replayTaste(ticks.map((tk) => ({ t: tk.tasteAt, applied: tk.taste?.applied || [] })), proof.tasteModel || {});
let mism = 0; let firstBad = null;
for (let i = 0; i < ticks.length; i += 1) {
  const r = replay[i]; const tk = ticks[i];
  if (r.sweet !== tk.taste.sweet || r.bitter !== tk.taste.bitter) { mism += 1; if (!firstBad) firstBad = { step: tk.step, replay: r, recorded: { sweet: tk.taste.sweet, bitter: tk.taste.bitter } }; }
}
if (!startsClean) console.log('  note: the served ticks do not start at step 0, so trades tasted before them are not in the replay');
ok(startsClean && mism === 0, `replayTaste from the served ticks equals the recorded taste on ${ticks.length - mism}/${ticks.length} ticks${firstBad ? ` (first mismatch ${JSON.stringify(firstBad)})` : ''}`);

if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify({ ticks: ticks.length, trades: trades.length, tasted, sweetTicks, bitterTicks, rows }, null, 1));
console.log(fails ? `check-taste: ${fails} FAILED` : 'check-taste: all hold');
process.exit(fails ? 1 : 0);
