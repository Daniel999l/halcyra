/**
 * The whole loop, in process: stand-in pilot, taste and trade watcher (same
 * interfaces as the real ones), the in-memory db, a console that plays at once,
 * real HTTP and SSE against the running server, scripts/verify-chain.mjs
 * against it (passes, then fails on a tampered stored tick), and a restart
 * that carries the chain on.
 */
import { spawn } from 'node:child_process';
import zlib from 'node:zlib';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startApp } from '../src/index.js';
import { memDb } from './memdb.mjs';
import { standinPilot, standinTaste, standinChain, fakeConsoleFactory, testConfig, getJson, sse, check, finish } from './service-fixtures.mjs';
import { say } from '../src/log.js';

say.quiet = true;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const R = []; const ok = check(R);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
console.log('service-loop\n');

// the verifier runs as its own process, exactly as anyone would run it
const verifyAgainst = (url) => new Promise((resolve) => {
  const p = spawn(process.execPath, ['scripts/verify-chain.mjs', url], { cwd: ROOT });
  let out = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
  p.on('close', (code) => resolve({ code, out }));
});

const MINT = 'TestMint11111111111111111111111111111111pump';
const cfg = testConfig({
  tokenCa: MINT,
  console: { url: 'http://mock.invalid/' },
  loop: { stepMs: 15 },
  ledger: { bucketTicks: 40, ringTicks: 100, flushMs: 1000 },
});
const db = memDb();
const chain = standinChain({ every: 3 });
const modules = { pilot: standinPilot, taste: standinTaste, chain };
const app = await startApp({ cfg, db, modules, consoleFactory: fakeConsoleFactory() });
const base = `http://127.0.0.1:${app.port}`;
const live = await sse(`${base}/api/live`);

const t0 = Date.now();
while (app.ledger.head().ticks < 200 && Date.now() - t0 < 30000) await sleep(20);
const head = app.ledger.head();
ok(head.ticks >= 200, `the loop ran 200+ steps (${head.ticks} in ${Date.now() - t0} ms)`);
ok(chain.last && chain.last.mint === MINT, 'the trade watcher was started for TOKEN_CA');

const st = (await getJson(base, '/api/state')).body;
ok(st.tick && st.tick.step >= 199 && /^[0-9a-f]{64}$/.test(st.tick.hash) && Array.isArray(st.tick.lit) && st.tick.lit.length === 50, '/api/state carries the latest tick with its hash and lit cells');
ok(st.totals.trades > 10 && st.totals.buys > 0 && st.totals.sells > 0 && st.totals.trades === st.totals.buys + st.totals.sells, `/api/state totals count trades (${st.totals.buys} buys, ${st.totals.sells} sells)`);
ok(Math.abs(st.totals.solIn - st.totals.buys * 0.25) < 1e-9, 'SOL in = sum of buys');
ok(st.token && st.token.buy === `https://pump.fun/coin/${MINT}` && st.token.solscan === `https://solscan.io/account/${MINT}`, 'token links use the pump.fun and solscan formats');
ok(st.console.state === 'playing' && st.fly && st.fly.step > 0, 'console status and pilot telemetry are in /api/state');

const trades = (await getJson(base, '/api/trades?limit=5')).body.trades;
ok(trades.length === 5 && trades[0].tx === `https://solscan.io/tx/${trades[0].sig}` && trades[0].walletUrl.startsWith('https://solscan.io/account/'), '/api/trades links each trade to solscan');
ok(db._raw.trades.length === st.totals.trades, 'every tasted trade is stored once in halcyra_trades');
chain.last.stop();
const ticksWithTaste = (await app.ledger.ticks(-1, 1000)).filter((t) => t.taste.applied.length);
ok(ticksWithTaste.length > 0 && typeof ticksWithTaste[0].tasteAt === 'number', `trades reached the brain as taste (${ticksWithTaste.length} ticks with applied trades, tasteAt recorded)`);
const appliedSigs = ticksWithTaste.flatMap((t) => t.taste.applied.map((a) => a.sig));
ok(new Set(appliedSigs).size === appliedSigs.length, 'each trade applied to the brain exactly once');

// SSE
await sleep(100);
const tickEv = live.events.filter((e) => e.event === 'tick');
const tradeEv = live.events.filter((e) => e.event === 'trade');
ok(live.events[0].event === 'hello', 'SSE says hello first');
ok(tickEv.length >= 150 && tickEv.every((e, i) => i === 0 || e.data.step === tickEv[i - 1].data.step + 1), `SSE pushed every tick in order (${tickEv.length})`);
ok(tradeEv.length >= 10 && tradeEv[0].data.tx.startsWith('https://solscan.io/tx/'), `SSE pushed trades (${tradeEv.length})`);

// the API's ticks, paged, include stored buckets (the ring only holds 100)
const page1 = (await getJson(base, '/api/ticks?after=-1&limit=30')).body;
ok(page1.ticks.length === 30 && page1.ticks[0].step === 0 && page1.ticks[0].prevHash === '0'.repeat(64), '/api/ticks pages from step 0');
ok(!('lit' in page1.ticks[0]), 'stored ticks carry no lit');
const t17 = (await getJson(base, '/api/ticks/17')).body;
ok(t17.step === 17 && t17.hash === page1.ticks[17].hash, '/api/ticks/17 matches the paged copy');
const cps = (await getJson(base, '/api/checkpoints')).body.checkpoints;
ok(cps.length >= 4 && cps[0].from === 0 && cps[1].prevHash === cps[0].head, `/api/checkpoints are linked (${cps.length})`);

// stop the brain so the chain holds still for the verifier
app.consoleTab.playing = false;
await sleep(100);
await app.ledger.flush();
const v1 = await verifyAgainst(base);
console.log(v1.out.split('\n').filter(Boolean).map((l) => `      | ${l}`).join('\n'));
ok(v1.code === 0, 'scripts/verify-chain.mjs passes against the running server');

// tamper with one stored tick (inside a gzipped bucket in the db)
const b = db._raw.ticks.find((x) => x.from === 40);
const recs = zlib.gunzipSync(b.z).toString().split('\n').map((l) => JSON.parse(l));
recs[3].dn.L = 0.5; // step 43
b.z = zlib.gzipSync(Buffer.from(recs.map((r) => JSON.stringify(r)).join('\n')));
app.ledger.cache.clear();
const v2 = await verifyAgainst(base);
console.log(v2.out.split('\n').filter(Boolean).map((l) => `      | ${l}`).join('\n'));
ok(v2.code === 1 && /step 43/.test(v2.out), 'verify-chain fails when a stored tick is altered (and names step 43)');
const headBefore = app.ledger.head();
await app.stop();
ok(db._raw.cps.at(-1).to === headBefore.step, 'shutdown flushed every pending tick to the store', `stored to ${db._raw.cps.at(-1).to}, head ${headBefore.step}`);

// restart on the same store with a watcher that hands the SAME trades over again
// (a crash in the middle of a slot can do that): nothing is stored, counted or tasted twice
{
  const storedBefore = db._raw.trades.length;
  const sigsBefore = new Set(db._raw.trades.map((t) => t.sig));
  const replay = standinChain({ every: 3 });
  const replayFrom1000 = { createTradeWatcher: (o) => replay.createTradeWatcher({ ...o, fromSlot: null }) };
  const aR = await startApp({ cfg, db, modules: { pilot: standinPilot, taste: standinTaste, chain: replayFrom1000 }, consoleFactory: fakeConsoleFactory() });
  const tR = Date.now();
  while (Date.now() - tR < 15000 && db._raw.trades.length < storedBefore + 5) await sleep(20);
  replay.last.stop();
  const headR = aR.ledger.head();
  const recs = await aR.ledger.ticks(headBefore.step, 1000);
  const appliedR = recs.flatMap((r) => (r.taste?.applied || []).map((a) => a.sig));
  const stR = (await getJson(`http://127.0.0.1:${aR.port}`, '/api/state')).body;
  await aR.stop();
  const sigs = db._raw.trades.map((t) => t.sig);
  ok(new Set(sigs).size === sigs.length, `after a restart that replays old trades, every sig is stored once (${sigs.length} stored, ${sigs.length - storedBefore} new)`);
  ok(appliedR.every((s) => !sigsBefore.has(s)) && appliedR.length > 0, `...no trade from before the restart is tasted again (${appliedR.length} tasted after it, all new)`, `head ${headR.step}`);
  ok(stR.totals.trades === sigs.length, `...and the totals count each once (${stR.totals.trades} = ${sigs.length} stored)`);
  ok(db._raw.trades.every((t) => typeof t.receivedAt === 'number'), 'stored trades carry when they were received');
}

// restart: a new service on the same store carries the chain on
const dbR = memDb();
const cfgR = testConfig({ console: { url: 'http://mock.invalid/' }, loop: { stepMs: 10 }, ledger: { bucketTicks: 40, ringTicks: 100, flushMs: 1000 } });
const a1 = await startApp({ cfg: cfgR, db: dbR, modules: { pilot: standinPilot, taste: standinTaste }, consoleFactory: fakeConsoleFactory() });
while (a1.ledger.head().ticks < 120) await sleep(10);
await a1.stop();
const h1 = a1.ledger.head();
const a2 = await startApp({ cfg: cfgR, db: dbR, modules: { pilot: standinPilot, taste: standinTaste }, consoleFactory: fakeConsoleFactory() });
ok(a2.ledger.head().hash === h1.hash, `a restarted service resumes at the stored head (step ${h1.step})`);
while (a2.ledger.head().ticks < h1.ticks + 100) await sleep(10);
a2.consoleTab.playing = false;
await sleep(50);
await a2.ledger.flush();
const base2 = `http://127.0.0.1:${a2.port}`;
const v3 = await verifyAgainst(base2);
console.log(v3.out.split('\n').filter(Boolean).map((l) => `      | ${l}`).join('\n'));
ok(v3.code === 0 && /= reported head/.test(v3.out), 'verify-chain passes across the restart, up to the reported head');

// a tick altered in memory (served from the ring) is caught too
const ringRec = a2.ledger.ring.at(-5);
ringRec.active += 1;
const v4 = await verifyAgainst(base2);
ok(v4.code === 1, 'verify-chain fails when a tick served from memory is altered', v4.out.split('\n').find((l) => l.startsWith('FAIL')));
await a2.stop();
live.close();
finish(R, 'service-loop');
process.exit(process.exitCode || 0);
