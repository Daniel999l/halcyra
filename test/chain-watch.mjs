/**
 * The watcher's bookkeeping, offline: a fake RPC that serves the real raw transactions in
 * test/chain-fixtures.json. Checks: starts at the tip, emits oldest first, never twice,
 * restarts from fromSlot, waits for a transaction the RPC has not served yet, survives junk
 * and a throwing onTrade, and follows the coin from the curve to its PumpSwap pool.
 *
 *   node test/chain-watch.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTradeWatcher } from '../src/chain/watch.js';
import { curvePda, poolPda } from '../src/chain/pump.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const raw = JSON.parse(fs.readFileSync(path.join(HERE, 'chain-fixtures.json'), 'utf8'));

// one fake coin that uses DOOYET's curve trades and then SOYOUARE's pool trades: to make the
// pool ones parse as the same coin, the fake venueOf reports SOYOUARE's addresses after graduation
const CURVE_MINT = '6WmfNhGGNNHw61AtQ521PPUBki95NLchv9Y6Rb3qpump';
const POOL_MINT = '2RsvtRCFLLmfzSMHGgjKcg8stqxnPoUWYWptG4U5pump';
const curveSigs = ['25EhxgVTNMEX67CozPVbpQWWTxJqXcc62MDxiQb1NQVxKTJsKxykizLo5BKh42M1dUH8MXoxNU2HXiFKgwyt9WCC',
  '4HRZgYnCNvaefDrwzK3afrQJ9mP3wxHRtUGZHJqdPu914CjJxMwA3BDCBn8W4YPi8QrppneyZFwH28ZCsREUMqUw',
  '2jaFSjUZhjFF4vnCe7rPSW1j2qobfpZSgHCKEzCd9DrSo34DkTDKuqbAdQk5ynHYcuJF8qnuPkTCveWMzXhaoDzm',
  '418VCJdMnaNMspCUThniwsPuZXSwMMXTyQwYaazu2VRNUV5Sp2RSCTRqMubmwRbcruwzvfgMbj6KWNnrNiXFpezo',
  '5vMQSaVcfVTLE1hQYTs4AXTQKuV425dtHEnJopJsKG3WB86gwqocVK5gb9BGuemH3SeHEdDgUXuBuXTnFzL22Wxk'];
const poolSigs = ['3mBA4SoQLXFMXTUsax7fd1Uvh135dA8BDgeQwgJ6oVz9dasvyYRfqwDrRN6smkj3FFzbizWDzwZc6hKpmem5aVue',
  '5u2eYuLyDyvRLMQ4aq7KsMn9jjP5GRYje3DRRPnJXyfcNbxAN9H4NYXoH8qP8KjYYzvxeWyP4QtTLpzt6FEcXpLT',
  '2MRHrpB9T6YXQp8yqGUBXgZMhwf3sdA1KtuDdbrShpL3cfoaLLTsPPLH1evF546oqdzqCLkspkUL5dqJbM61aoFY',
  'W9XKicX5CzoeTWKyQLkcBiChwsn9tLJ77kUkqsWXJrVtYoBCyHzXY91Nr4pxFm9BjpXJz9qhXP3u6Tt2awz9LA5'];

let pass = 0; let fail = 0;
const ok = (c, m) => { if (c) pass += 1; else { fail += 1; console.log('  FAIL', m); } };
const quiet = { info() {}, warn() {}, error() {} };

function makeChain() {
  const hist = new Map(); // addr -> newest-first [{ signature, slot, err, blockTime }]
  const hold = new Set(); // signatures getTransaction does not serve yet
  const junk = new Set(); // signatures served as garbage
  const calls = { tx: 0 };
  const push = (addr, sig, err = null) => {
    const tx = raw[sig];
    const slot = tx ? tx.slot : (hist.get(addr)?.[0]?.slot || 1) + 1;
    if (!hist.has(addr)) hist.set(addr, []);
    hist.get(addr).unshift({ signature: sig, slot, err, blockTime: tx?.blockTime ?? null });
  };
  const rpc = async (method, params) => {
    if (method === 'getSignaturesForAddress') {
      const [addr, q] = params; let list = hist.get(addr) || [];
      if (q.until) { const i = list.findIndex((s) => s.signature === q.until); if (i >= 0) list = list.slice(0, i); }
      if (q.before) { const i = list.findIndex((s) => s.signature === q.before); list = i >= 0 ? list.slice(i + 1) : []; }
      return list.slice(0, q.limit || 1000);
    }
    if (method === 'getTransaction') {
      calls.tx += 1;
      const sig = params[0];
      if (hold.has(sig)) return null;
      if (junk.has(sig)) return { meta: { err: null, preTokenBalances: 'nope' }, transaction: { message: { accountKeys: [7] } } };
      return raw[sig] || null;
    }
    throw new Error('fake rpc: ' + method);
  };
  let graduated = false;
  const venueOf = async () => (graduated
    ? { curve: curvePda(POOL_MINT), pool: poolPda(POOL_MINT), state: { complete: true }, poolState: { baseMint: POOL_MINT }, slot: 9e9 }
    : { curve: curvePda(CURVE_MINT), pool: poolPda(CURVE_MINT), state: { complete: false }, poolState: null, slot: raw[curveSigs[0]].slot - 1 });
  return { hist, hold, junk, calls, push, rpc, venueOf, graduate() { graduated = true; } };
}

// the curve-phase sigs are pushed in slot order (oldest first)
const bySlot = (sigs) => sigs.slice().sort((a, b) => raw[a].slot - raw[b].slot);
const cS = bySlot(curveSigs); const pS = bySlot(poolSigs);
const curveAddr = curvePda(CURVE_MINT); const poolAddr = poolPda(POOL_MINT);

// 1. fresh start: nothing old is emitted
{
  const ch = makeChain(); ch.push(curveAddr, cS[0]);
  const got = []; const slots = [];
  const w = createTradeWatcher({ mint: CURVE_MINT, onTrade: (t) => got.push(t), onSlot: (s) => slots.push(s), _rpc: ch.rpc, _venueOf: ch.venueOf, log: quiet });
  await w.pollOnce();
  ok(got.length === 0, 'fresh start emitted old trades');
  // 2. new trades arrive: emitted once, oldest first, with onSlot rising
  for (const s of cS.slice(1)) ch.push(curveAddr, s);
  ch.push(curveAddr, 'FAILEDTX111111111111111111111111111111111111111111111111111111111111111111111111111111', { InstructionError: [0, 'x'] });
  await w.pollOnce();
  ok(got.length === 4, `expected 4 new trades, got ${got.length}`);
  ok(got.every((t, i) => i === 0 || got[i - 1].slot <= t.slot), 'not oldest first');
  ok(slots.length > 0 && slots.every((s, i) => i === 0 || slots[i - 1] < s), 'onSlot not rising');
  const before = ch.calls.tx;
  await w.pollOnce(); await w.pollOnce();
  ok(got.length === 4 && ch.calls.tx === before, 'repeated polls re-emitted or refetched');
  console.log(`fresh start + 4 new: ${got.map((t) => `${t.side}:${t.sol}`).join(' ')}  onSlot ${slots.join(',')}`);

  // 3. restart from the reported slot: nothing again; from an earlier slot: only the later trades
  const again = [];
  const w2 = createTradeWatcher({ mint: CURVE_MINT, fromSlot: slots[slots.length - 1], onTrade: (t) => again.push(t), _rpc: ch.rpc, _venueOf: ch.venueOf, log: quiet });
  await w2.pollOnce();
  ok(again.length === 0, `restart at last slot re-emitted ${again.length}`);
  const mid = raw[cS[2]].slot;
  const part = [];
  const w3 = createTradeWatcher({ mint: CURVE_MINT, fromSlot: mid, onTrade: (t) => part.push(t), _rpc: ch.rpc, _venueOf: ch.venueOf, log: quiet });
  await w3.pollOnce();
  const want = cS.filter((s) => raw[s].slot > mid).length;
  ok(part.length === want && part.every((t) => t.slot > mid), `restart from ${mid}: got ${part.length}, want ${want}`);
  console.log(`restart: from last slot -> ${again.length} trades, from slot ${mid} -> ${part.length} trades (want ${want})`);
}

// 4. a transaction not served yet holds the line; junk and a throwing onTrade do not crash
{
  const ch = makeChain(); ch.push(curveAddr, cS[0]);
  const got = [];
  let throwOnce = true;
  const w = createTradeWatcher({ mint: CURVE_MINT, onTrade: (t) => { got.push(t); if (throwOnce) { throwOnce = false; throw new Error('db down'); } }, _rpc: ch.rpc, _venueOf: ch.venueOf, log: quiet });
  await w.pollOnce();
  ch.push(curveAddr, cS[1]); ch.push(curveAddr, cS[2]); ch.push(curveAddr, cS[3]);
  ch.hold.add(cS[2]);
  ch.junk.add('JUNK');
  await w.pollOnce();
  ok(got.length === 1 && got[0].sig === cS[1], `held tx: got ${got.map((t) => t.sig.slice(0, 6))}`);
  ch.hold.delete(cS[2]);
  await w.pollOnce();
  ok(got.length === 3 && got[1].sig === cS[2] && got[2].sig === cS[3], 'held tx not picked up in order');
  // junk tx in the history
  ch.hist.get(curveAddr).unshift({ signature: 'JUNK', slot: raw[cS[3]].slot + 1, err: null });
  ch.push(curveAddr, cS[4]);
  await w.pollOnce();
  ok(got.length === 4 && got[3].sig === cS[4], 'junk tx broke the watcher');
  // a tx that never comes is given up on after 4 tries and the watcher moves on
  ch.hist.get(curveAddr).unshift({ signature: 'GONE', slot: raw[cS[4]].slot + 2, err: null });
  ch.hold.add('GONE');
  for (let i = 0; i < 5; i += 1) await w.pollOnce();
  ok(ch.calls.tx < 30, 'kept refetching a missing tx');
  console.log(`held/junk/throwing onTrade: emitted ${got.length} trades in order, no crash`);

}

// 5. graduation: one watcher on one coin follows it from the curve to its PumpSwap pool
{
  const ch = makeChain();
  const cAddr = curvePda(POOL_MINT);
  let grad = false;
  const venueOf = async () => (grad
    ? { curve: cAddr, pool: poolAddr, state: { complete: true }, poolState: { baseMint: POOL_MINT }, slot: 470538100 }
    : { curve: cAddr, pool: poolAddr, state: { complete: false }, poolState: null, slot: raw[pS[0]].slot - 1 });
  ch.hist.set(cAddr, [{ signature: 'CURVEOLD', slot: raw[pS[0]].slot - 5, err: null, blockTime: 0 }]);
  const got = [];
  const w = createTradeWatcher({ mint: POOL_MINT, onTrade: (t) => got.push(t), _rpc: ch.rpc, _venueOf: venueOf, _venueTtl: 0, log: quiet });
  await w.pollOnce();
  ok(got.length === 0, 'curve tip emitted');
  grad = true;
  for (const s of pS) ch.push(poolAddr, s);
  await w.pollOnce();
  ok(got.length === 4 && got.every((t) => t.venue === 'pumpswap'), `pool phase: ${got.length} trades`);
  await w.pollOnce();
  ok(got.length === 4, 'pool trades emitted twice');
  console.log(`curve -> graduation -> pool: ${got.map((t) => `${t.venue}:${t.side}:${t.sol}`).join(' ')}`);
}

// 6. start/stop loop does not throw and stops
{
  const ch = makeChain(); ch.push(curveAddr, cS[0]);
  const w = createTradeWatcher({ mint: CURVE_MINT, onTrade: () => {}, pollMs: 1000, _rpc: ch.rpc, _venueOf: ch.venueOf, log: quiet });
  w.start(); await new Promise((r) => setTimeout(r, 50)); w.stop();
  ok(true, 'start/stop');
  let threw = false; try { createTradeWatcher({ mint: 'nope', onTrade() {} }); } catch { threw = true; }
  ok(threw, 'bad mint accepted');
}

console.log(`\nchain-watch: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
