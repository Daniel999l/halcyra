/**
 * Taste math: bounded, deterministic, each trade applied once, replayable from the ledger alone.
 *   node test/taste-math.mjs
 */
import { Taste, tasteLevel, replayTaste, TASTE_DEFAULTS } from '../src/taste.js';

let pass = 0; let fail = 0;
const ok = (c, m) => { if (c) pass += 1; else { fail += 1; console.log('  FAIL', m); } };
const near = (a, b, e = 1e-5) => Math.abs(a - b) <= e;

// size curve
const L = (s) => tasteLevel(s);
ok(near(L(0), TASTE_DEFAULTS.floor) && near(L(-3), TASTE_DEFAULTS.floor) && near(L(NaN), TASTE_DEFAULTS.floor), 'floor');
ok(near(L(0.01), TASTE_DEFAULTS.floor) && near(L(10), 1) && near(L(500), 1), 'ends');
ok(L(0.05) < L(0.5) && L(0.5) < L(5), 'not increasing');
ok(near(L(Math.sqrt(0.01 * 10)), TASTE_DEFAULTS.floor + (1 - TASTE_DEFAULTS.floor) / 2), 'not log-scaled');
console.log('level by SOL: ' + [0.001, 0.01, 0.05, 0.1, 0.5, 1, 5, 10, 50].map((s) => `${s}:${L(s).toFixed(3)}`).join(' '));

// a deterministic pseudo-random tape (fixed seed), mixed buys and sells and repeats
function tape(seed = 7, n = 400) {
  let a = seed >>> 0; const rnd = () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const ev = []; let t = 1_700_000_000_000;
  for (let i = 0; i < n; i += 1) {
    t += Math.floor(rnd() * 600);
    if (rnd() < 0.45) {
      const sig = `sig${Math.floor(rnd() * 300)}`; // repeats happen on purpose
      ev.push({ push: { sig, side: rnd() < 0.55 ? 'buy' : 'sell', sol: Math.exp((rnd() - 0.5) * 12), wallet: `w${i % 17}`, slot: i, ts: t, venue: 'curve', tokens: '1' } });
    } else ev.push({ sample: t });
  }
  return ev;
}
function run(events, opts) {
  const tt = new Taste(opts); const out = [];
  for (const e of events) { if (e.push) tt.push(e.push); else out.push({ t: e.sample, ...tt.sample(e.sample) }); }
  return out;
}
const ev = tape();
const a = run(ev); const b = run(ev);
ok(JSON.stringify(a) === JSON.stringify(b), 'same tape, different output');
ok(a.every((s) => s.sweet >= 0 && s.sweet <= 1 && s.bitter >= 0 && s.bitter <= 1), 'out of 0..1');
const appliedSigs = a.flatMap((s) => s.applied.map((x) => `${x.sig}:${x.side}`));
ok(appliedSigs.length === new Set(appliedSigs).size, 'a trade applied twice');
const pushedUnique = new Set(ev.filter((e) => e.push).map((e) => `${e.push.sig}:${e.push.side}`));
const lastSample = ev.map((e, i) => (e.sample ? i : -1)).filter((i) => i >= 0).pop();
const pushedBeforeLast = new Set(ev.slice(0, lastSample).filter((e) => e.push).map((e) => `${e.push.sig}:${e.push.side}`));
ok(appliedSigs.length === pushedBeforeLast.size, `applied ${appliedSigs.length} != unique pushed ${pushedBeforeLast.size}`);
ok(pushedUnique.size >= pushedBeforeLast.size, 'count sanity');

// replay from the ledger alone (tick time + applied list) gives identical samples
const re = replayTaste(a.map((s) => ({ t: s.t, applied: s.applied })));
ok(re.length === a.length && re.every((r, i) => r.sweet === a[i].sweet && r.bitter === a[i].bitter), 'replay differs');
// and survives a JSON round trip, as it would from Mongo
const re2 = replayTaste(JSON.parse(JSON.stringify(a.map((s) => ({ t: s.t, applied: s.applied })))));
ok(JSON.stringify(re2) === JSON.stringify(re), 'replay after JSON differs');
console.log(`tape: ${ev.length} events, ${a.length} samples, ${appliedSigs.length} trades applied, max sweet ${Math.max(...a.map((s) => s.sweet))}, max bitter ${Math.max(...a.map((s) => s.bitter))}; replay identical: ${JSON.stringify(re) === JSON.stringify(a.map(({ sweet, bitter }) => ({ sweet, bitter })))}`);

// half-life and saturation, exact numbers
{
  const t = new Taste();
  t.push({ sig: 'x', side: 'buy', sol: 10, wallet: 'w' });
  const s0 = t.sample(1000); const s1 = t.sample(5000); const s2 = t.sample(9000);
  ok(s0.sweet === 1 && near(s1.sweet, 0.5) && near(s2.sweet, 0.25) && s0.bitter === 0, `half-life ${s0.sweet} ${s1.sweet} ${s2.sweet}`);
  ok(s0.applied.length === 1 && s1.applied.length === 0, 'applied not once');
  t.push({ sig: 'y', side: 'buy', sol: 10, wallet: 'w' }); t.push({ sig: 'z', side: 'buy', sol: 10, wallet: 'w' });
  ok(t.sample(9000).sweet === 1, 'no saturation at 1');
  ok(!t.push({ sig: 'y', side: 'buy', sol: 10 }) && !t.push(null) && !t.push({ sig: 'q', side: 'hold' }), 'bad or repeated push taken');
  const late = t.sample(1000); // time going backwards is read as the last time
  ok(late.sweet === 1, 'time went backwards');
  const far = t.sample(9000 + 4000 * 40);
  ok(far.sweet === 0 && t.live.length === 0, 'old trades not forgotten');
  console.log(`one 10 SOL buy: t0 ${s0.sweet}, +4 s ${s1.sweet}, +8 s ${s2.sweet}; three at once ${1}`);
}
// options
{
  const t = new Taste({ halfLifeMs: 1000, minSol: 0.1, maxSol: 1, floor: 0.2 });
  t.push({ sig: 'a', side: 'sell', sol: 0.05 });
  const s = t.sample(0); ok(near(s.bitter, 0.2), 'floor option');
  ok(near(t.sample(1000).bitter, 0.1), 'half-life option');
  let threw = false; try { new Taste({ halfLifeMs: 0 }); } catch { threw = true; } ok(threw, 'bad options accepted');
  threw = false; try { t.sample(undefined); } catch { threw = true; } ok(threw, 'sample without time accepted');
}
console.log(`\ntaste-math: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
