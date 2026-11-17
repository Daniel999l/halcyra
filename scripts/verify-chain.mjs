#!/usr/bin/env node
/**
 * Check her proof ledger yourself. Needs Node 18+ and nothing else.
 *
 *   node verify-chain.mjs https://<site>            every stored tick
 *   node verify-chain.mjs https://<site> --last 5000 only the last 5000
 *
 * What it checks:
 *   1. every tick the API serves:  hash == sha256(prevHash + canonicalJSON(tick
 *      without hash, prevHash, lit)), keys sorted at every level, and each
 *      tick's prevHash is the hash of the tick before it (no step missing)
 *   2. the checkpoints (one per stored bucket, kept forever): each links to the
 *      one before it, the first starts at step 0 from 64 zeros, and every one
 *      that covers served ticks matches them exactly
 *   3. the last tick it checked is the head the API reports
 *
 * Exit code 0 = the chain holds. 1 = it does not (the reason is printed).
 */
import crypto from 'node:crypto';

const GENESIS = '0'.repeat(64);
const args = process.argv.slice(2);
const base = (args.find((a) => /^https?:\/\//.test(a)) || '').replace(/\/$/, '');
const lastN = args.includes('--last') ? Number(args[args.indexOf('--last') + 1]) : 0;
if (!base) { console.error('usage: node verify-chain.mjs <site url> [--last N]'); process.exit(2); }

function canonicalJSON(v) {
  if (v === null || typeof v !== 'object') return typeof v === 'number' && !Number.isFinite(v) ? 'null' : JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? 'null' : canonicalJSON(x))).join(',')}]`;
  const keys = Object.keys(v).filter((k) => v[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJSON(v[k])}`).join(',')}}`;
}
function hashOf(prev, rec) {
  const body = {};
  for (const k of Object.keys(rec)) if (k !== 'hash' && k !== 'prevHash' && k !== 'lit') body[k] = rec[k];
  return crypto.createHash('sha256').update(prev + canonicalJSON(body)).digest('hex');
}
async function get(path) {
  const r = await fetch(base + path, { headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`${path}: HTTP ${r.status}`);
  return r.json();
}
const fail = (why) => { console.log(`\nFAIL: ${why}`); process.exit(1); };

const t0 = Date.now();
const first = await get('/api/ticks?after=-1&limit=1');
let after = -1;
if (lastN > 0 && first.head.step >= 0) after = Math.max(-1, first.head.step - lastN);
console.log(`checking ${base}\nhead reported: step ${first.head.step}, ${first.head.hash}`);

// 1. the ticks
let prev = null; let lastStep = null; let firstStep = null; let n = 0; let headSeen = first.head;
const byStep = new Map(); // only the ones checkpoints need: bucket edges
const recs = [];
for (;;) {
  const page = await get(`/api/ticks?after=${after}&limit=1000`);
  headSeen = page.head;
  if (!page.ticks.length) break;
  for (const r of page.ticks) {
    if (firstStep === null) {
      firstStep = r.step;
      prev = r.step === 0 ? GENESIS : r.prevHash;
      if (r.step === 0 && r.prevHash !== GENESIS) fail('step 0 does not start from the genesis hash');
    } else if (r.step !== lastStep + 1) fail(`step ${lastStep + 1} is missing (next served is ${r.step})`);
    if (r.prevHash !== prev) fail(`step ${r.step}: prevHash does not match the hash of step ${lastStep}`);
    const h = hashOf(prev, r);
    if (h !== r.hash) fail(`step ${r.step}: hash does not match its contents (computed ${h}, served ${r.hash})`);
    prev = h; lastStep = r.step; n += 1;
    recs.push({ step: r.step, prevHash: r.prevHash, hash: r.hash });
    if (recs.length > 400000) recs.splice(0, 100000);
  }
  after = lastStep;
  if (lastStep >= page.head.step) break;
}
for (const r of recs) byStep.set(r.step, r);
if (n === 0) { console.log('no ticks stored yet: nothing to check (an empty chain is valid)'); process.exit(0); }
console.log(`ticks ${firstStep}..${lastStep}: ${n} recomputed, every hash matches`);
if (firstStep > 0 && lastN === 0) console.log(`  (steps before ${firstStep} are past the full-tick window; the checkpoints below cover them)`);

// 2. the checkpoints
let cps = []; let ca = -1;
for (;;) {
  const page = await get(`/api/checkpoints?after=${ca}&limit=2000`);
  if (!page.checkpoints.length) break;
  cps = cps.concat(page.checkpoints);
  ca = page.checkpoints.at(-1).to;
}
if (cps.length) {
  if (cps[0].from !== 0 || cps[0].prevHash !== GENESIS) fail('the first checkpoint does not start at step 0 from the genesis hash');
  let gaps = 0;
  for (let i = 1; i < cps.length; i += 1) {
    if (cps[i].from !== cps[i - 1].to + 1 || cps[i].prevHash !== cps[i - 1].head) {
      gaps += 1;
      console.log(`  gap: checkpoint ${cps[i].from}..${cps[i].to} does not link to ${cps[i - 1].from}..${cps[i - 1].to}`);
    }
  }
  let matched = 0;
  for (const c of cps) {
    const a = byStep.get(c.from); const b = byStep.get(c.to);
    if (a && a.prevHash !== c.prevHash) fail(`checkpoint ${c.from}..${c.to} does not match the served tick ${c.from}`);
    if (b && b.hash !== c.head) fail(`checkpoint ${c.from}..${c.to} does not match the served tick ${c.to}`);
    if (a || b) matched += 1;
  }
  // the served window must hang off the checkpoint chain
  if (firstStep > 0) {
    const before = cps.find((c) => c.to === firstStep - 1);
    if (before && before.head !== byStep.get(firstStep)?.prevHash) fail(`the first served tick (${firstStep}) does not link to checkpoint ${before.from}..${before.to}`);
  }
  console.log(`checkpoints: ${cps.length} (steps 0..${cps.at(-1).to}), ${cps.length - 1 - gaps} links hold${gaps ? `, ${gaps} gap(s) listed above` : ''}, ${matched} matched against served ticks`);
  if (gaps) fail(`${gaps} checkpoint gap(s)`);
} else console.log('checkpoints: none (no database: the chain lives in memory only)');

// 3. the head
if (lastStep === headSeen.step && prev !== headSeen.hash) fail('the last checked tick is not the head the API reports');
console.log(`head: step ${lastStep} ${prev}${lastStep === headSeen.step ? ' = reported head' : ` (head has moved on to ${headSeen.step} while checking)`}`);
console.log(`\nOK: the chain holds (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
