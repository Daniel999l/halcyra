/**
 * Live check against Solana mainnet (needs network; uses RPC_URL or the public endpoint).
 *
 *   node test/chain-live.mjs [--seconds 90] [--curve <mint>] [--pool <mint>]
 *
 * 1. Finds one active coin still on the bonding curve and one graduated coin trading on
 *    PumpSwap by reading the latest transactions of the two programs (or takes them from args).
 * 2. readCoin + marketFor on both.
 * 3. Runs the watcher on both for --seconds and prints every trade.
 * 4. Hand check: for up to 4 emitted trades per coin, refetches the raw transaction and compares
 *    the trader's own SOL balance change (network fee added back) with the trade's `sol`.
 */
import { createTradeWatcher, readCoin, marketFor, isMint } from '../src/chain/index.js';
import { rpc } from '../src/chain/rpc.js';
import { PUMP, PUMP_AMM } from '../src/chain/pump.js';

const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const SECONDS = Number(arg('seconds', 90));

async function busiest(program, wantGraduated) {
  const sigs = (await rpc('getSignaturesForAddress', [program, { limit: 30 }])).filter((s) => !s.err).slice(0, 10);
  const count = new Map();
  for (const s of sigs) {
    const tx = await rpc('getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1 }]).catch(() => null);
    for (const m of new Set((tx?.meta?.postTokenBalances || []).map((b) => b.mint))) if (m.endsWith('pump')) count.set(m, (count.get(m) || 0) + 1);
  }
  const now = Date.now() / 1000; const scored = [];
  for (const m of count.keys()) {
    const c = await readCoin(m).catch(() => null);
    if (!c || c.graduated !== wantGraduated || (wantGraduated && !c.poolLive)) continue;
    const addr = wantGraduated ? c.pool : c.curve;
    const ss = await rpc('getSignaturesForAddress', [addr, { limit: 50 }]);
    scored.push([m, ss.filter((s) => !s.err && now - s.blockTime < 120).length]);
  }
  scored.sort((a, b) => b[1] - a[1]);
  return scored[0]?.[0] || null;
}

const curveMint = arg('curve') || await busiest(PUMP, false);
const poolMint = arg('pool') === 'none' ? null : (arg('pool') || await busiest(PUMP_AMM, true));
console.log('curve coin:', curveMint, ' graduated coin:', poolMint);

const all = [];
const watchers = [];
for (const mint of [curveMint, poolMint].filter(isMint)) {
  const coin = await readCoin(mint);
  const mk = await marketFor(mint);
  console.log(`\n${mint}: ${JSON.stringify({ name: coin?.name, symbol: coin?.symbol, graduated: coin?.graduated, progress: coin?.progress, priceSol: coin?.priceSol, pool: coin?.pool, poolLive: coin?.poolLive })}`);
  console.log(`  market: ${JSON.stringify(mk)}`);
  let lastSlot = null; let firstSlot = null;
  const w = createTradeWatcher({
    mint, pollMs: 4000, backfill: 5,
    onTrade: (t) => { all.push({ mint, t }); console.log(`  TRADE ${mint.slice(0, 6)} ${t.venue.padEnd(8)} ${t.side.padEnd(4)} ${t.sol.toFixed(6)} SOL  wallet ${t.wallet}  slot ${t.slot}  sig ${t.sig}`); },
    onSlot: (s) => { if (firstSlot == null) firstSlot = s; lastSlot = s; },
  });
  watchers.push({ mint, w, coin, last: () => lastSlot, first: () => firstSlot });
  w.start();
}
await new Promise((r) => setTimeout(r, SECONDS * 1000));
for (const { w } of watchers) w.stop();

const sigs = all.map((x) => x.t.sig);
const dup = sigs.length - new Set(sigs).size;
const tip = await rpc('getSlot', [{ commitment: 'confirmed' }]);
console.log(`\n${all.length} trades in ${SECONDS}s, duplicates: ${dup}; handled up to slots ${watchers.map((x) => x.last()).join(', ')}; chain tip ${tip} (behind by ${watchers.map((x) => tip - x.last()).join(', ')} slots)`);

// coverage: every successful venue transaction in the watched slot range is either an emitted trade or not a trade
const { parseTrade } = await import('../src/chain/parse.js');
for (const { mint, coin, first, last } of watchers) {
  if (first() == null || last() == null) continue;
  const addr = coin.graduated ? coin.pool : coin.curve;
  let before; const inRange = [];
  for (let page = 0; page < 10; page += 1) {
    const batch = await rpc('getSignaturesForAddress', [addr, { limit: 100, ...(before ? { before } : {}) }]);
    for (const s of batch) if (s.slot >= first() && s.slot <= last() && !s.err) inRange.push(s);
    if (batch.length < 100 || batch[batch.length - 1].slot < first()) break;
    before = batch[batch.length - 1].signature;
  }
  const emitted = new Set(all.filter((x) => x.mint === mint).map((x) => x.t.sig));
  const missing = inRange.filter((s) => !emitted.has(s.signature));
  let nonTrades = 0; let missed = 0;
  for (const s of missing) {
    const tx = await rpc('getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1 }]);
    if (parseTrade(tx, { mint, curve: coin.curve, pool: coin.pool, sig: s.signature })) { missed += 1; console.log(`  MISSED trade ${s.signature} slot ${s.slot}`); } else nonTrades += 1;
  }
  console.log(`coverage ${mint.slice(0, 6)}: slots ${first()}..${last()}: ${inRange.length} successful venue txs, ${emitted.size} emitted trades, ${nonTrades} non-trades, ${missed} missed`);
}

// hand check
let checked = 0; let ok = 0;
for (const mint of [curveMint, poolMint].filter(Boolean)) {
  for (const { t } of all.filter((x) => x.mint === mint).slice(0, 4)) {
    const tx = await rpc('getTransaction', [t.sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1 }]);
    const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey);
    const i = keys.indexOf(t.wallet);
    if (i < 0) { console.log(`  check ${t.sig.slice(0, 12)}: wallet not in account keys`); continue; }
    let d = (tx.meta.postBalances[i] - tx.meta.preBalances[i]);
    if (i === 0) d += tx.meta.fee;
    // WSOL the wallet holds moves with it on PumpSwap
    let wsol = 0n;
    for (const [sgn, arr] of [[-1n, tx.meta.preTokenBalances], [1n, tx.meta.postTokenBalances]]) for (const b of arr || []) if (b.owner === t.wallet && b.mint === 'So11111111111111111111111111111111111111112') wsol += sgn * BigInt(b.uiTokenAmount.amount);
    const own = (d + Number(wsol)) / 1e9;
    const diff = Math.abs(Math.abs(own) - t.sol);
    const rel = t.sol ? diff / t.sol : 1;
    const signOk = t.side === 'buy' ? own < 0 : own > 0;
    const good = signOk && (rel < 0.05 || diff < 0.0035); // pump fees ~1-2%, ATA rent 0.00204 SOL, tips
    checked += 1; if (good) ok += 1;
    console.log(`  check ${t.side} ${t.sig.slice(0, 16)}… trade sol ${t.sol.toFixed(6)} | wallet SOL change ${own >= 0 ? '+' : ''}${own.toFixed(6)} (fee added back) | diff ${diff.toFixed(6)} (${(rel * 100).toFixed(2)}%) ${good ? 'OK' : 'CHECK'}`);
  }
}
console.log(`\nhand-checked ${checked}, agree within fees: ${ok}`);
process.exit(0);
