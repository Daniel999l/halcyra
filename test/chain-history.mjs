/**
 * Real historical pump.fun transactions, parsed and checked by hand.
 *
 *   node test/chain-history.mjs            parse the saved raw transactions (test/chain-fixtures.json), offline
 *   node test/chain-history.mjs --refresh  fetch them again from mainnet first and rewrite the file
 *
 * For every trade: the trader's own SOL change (network fee added back, WSOL the trader holds counted)
 * must have the right sign and agree with `sol` within pump.fun fees, rent and tips.
 * Non-trades (a creator fee claim that touches the curve, a failed tx) must parse to null.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTrade } from '../src/chain/parse.js';
import { curvePda, poolPda } from '../src/chain/pump.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FILE = path.join(HERE, 'chain-fixtures.json');
const WSOL = 'So11111111111111111111111111111111111111112';

// picked from live runs on 2026-11-17 (test/chain-live.mjs)
const CASES = [
  // DOOYET, on the bonding curve
  { mint: '6WmfNhGGNNHw61AtQ521PPUBki95NLchv9Y6Rb3qpump', sig: '25EhxgVTNMEX67CozPVbpQWWTxJqXcc62MDxiQb1NQVxKTJsKxykizLo5BKh42M1dUH8MXoxNU2HXiFKgwyt9WCC', expect: 'buy' },
  { mint: '6WmfNhGGNNHw61AtQ521PPUBki95NLchv9Y6Rb3qpump', sig: '4HRZgYnCNvaefDrwzK3afrQJ9mP3wxHRtUGZHJqdPu914CjJxMwA3BDCBn8W4YPi8QrppneyZFwH28ZCsREUMqUw', expect: 'sell' },
  { mint: '6WmfNhGGNNHw61AtQ521PPUBki95NLchv9Y6Rb3qpump', sig: '2jaFSjUZhjFF4vnCe7rPSW1j2qobfpZSgHCKEzCd9DrSo34DkTDKuqbAdQk5ynHYcuJF8qnuPkTCveWMzXhaoDzm', expect: 'buy' },
  { mint: '6WmfNhGGNNHw61AtQ521PPUBki95NLchv9Y6Rb3qpump', sig: '418VCJdMnaNMspCUThniwsPuZXSwMMXTyQwYaazu2VRNUV5Sp2RSCTRqMubmwRbcruwzvfgMbj6KWNnrNiXFpezo', expect: 'buy' },
  { mint: '6WmfNhGGNNHw61AtQ521PPUBki95NLchv9Y6Rb3qpump', sig: '5vMQSaVcfVTLE1hQYTs4AXTQKuV425dtHEnJopJsKG3WB86gwqocVK5gb9BGuemH3SeHEdDgUXuBuXTnFzL22Wxk', expect: 'buy' },
  // 5Didp1, on the bonding curve: a sell, and a creator fee claim that touches the curve (not a trade)
  { mint: '5Didp19nsE5eoFS3z4JGxecoi68HYiKPYRfHyVGtpump', sig: '2CkRJi5DrWfWgeb1QzXxK4cxsq7S7stRdJQu25daxnaxi1B5eAQmjpUvFs9iiAaorCkreJ95CBZAYUJyomysgWtt', expect: 'sell' },
  { mint: '5Didp19nsE5eoFS3z4JGxecoi68HYiKPYRfHyVGtpump', sig: 'eQLvqtYMnQDj1yAciVT2ufGGXV8WKzif9WTEZ5XQ94kFXEDFB9rrMFE1TxKhMSKNXx47QXkt2kGxvP9M4MhPNpz', expect: null },
  // SOYOUARE, graduated, PumpSwap (one through Jupiter)
  { mint: '2RsvtRCFLLmfzSMHGgjKcg8stqxnPoUWYWptG4U5pump', sig: '5u2eYuLyDyvRLMQ4aq7KsMn9jjP5GRYje3DRRPnJXyfcNbxAN9H4NYXoH8qP8KjYYzvxeWyP4QtTLpzt6FEcXpLT', expect: 'sell' },
  { mint: '2RsvtRCFLLmfzSMHGgjKcg8stqxnPoUWYWptG4U5pump', sig: '3mBA4SoQLXFMXTUsax7fd1Uvh135dA8BDgeQwgJ6oVz9dasvyYRfqwDrRN6smkj3FFzbizWDzwZc6hKpmem5aVue', expect: 'buy' },
  { mint: '2RsvtRCFLLmfzSMHGgjKcg8stqxnPoUWYWptG4U5pump', sig: '2MRHrpB9T6YXQp8yqGUBXgZMhwf3sdA1KtuDdbrShpL3cfoaLLTsPPLH1evF546oqdzqCLkspkUL5dqJbM61aoFY', expect: 'buy' },
  { mint: '2RsvtRCFLLmfzSMHGgjKcg8stqxnPoUWYWptG4U5pump', sig: 'W9XKicX5CzoeTWKyQLkcBiChwsn9tLJ77kUkqsWXJrVtYoBCyHzXY91Nr4pxFm9BjpXJz9qhXP3u6Tt2awz9LA5', expect: 'sell' },
  { mint: '2RsvtRCFLLmfzSMHGgjKcg8stqxnPoUWYWptG4U5pump', sig: '2shwKCoJYWNkYdCjxoSSX93r8NcLTAUpRBiooFtYCK7wHtNNZjuoqZxnAVRJxxzcSG1HLW61vVKM4D5ezyanwhcX', expect: 'sell' },
];

if (process.argv.includes('--refresh')) {
  const { rpc } = await import('../src/chain/rpc.js');
  const out = {};
  for (const c of CASES) {
    out[c.sig] = await rpc('getTransaction', [c.sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }]);
    process.stdout.write('.');
  }
  fs.writeFileSync(FILE, JSON.stringify(out));
  console.log(`\nsaved ${Object.keys(out).length} raw transactions to ${path.relative(process.cwd(), FILE)}`);
}

const raw = JSON.parse(fs.readFileSync(FILE, 'utf8'));
let pass = 0; let fail = 0;
const ok = (cond, msg) => { if (cond) pass += 1; else { fail += 1; console.log('  FAIL', msg); } };

for (const c of CASES) {
  const tx = raw[c.sig];
  const t = parseTrade(tx, { mint: c.mint, curve: curvePda(c.mint), pool: poolPda(c.mint), sig: c.sig });
  if (c.expect === null) {
    ok(t === null, `${c.sig} should not be a trade`);
    console.log(`${c.sig.slice(0, 20)}…  not a trade (as expected: ${t === null})`);
    continue;
  }
  ok(t && t.side === c.expect, `${c.sig} side ${t?.side} != ${c.expect}`);
  if (!t) continue;
  const keys = tx.transaction.message.accountKeys.map((k) => k.pubkey);
  const i = keys.indexOf(t.wallet);
  let d = i >= 0 ? tx.meta.postBalances[i] - tx.meta.preBalances[i] : 0;
  if (i === 0) d += tx.meta.fee;
  let w = 0n;
  for (const [sg, arr] of [[-1n, tx.meta.preTokenBalances], [1n, tx.meta.postTokenBalances]]) for (const b of arr || []) if (b.owner === t.wallet && b.mint === WSOL) w += sg * BigInt(b.uiTokenAmount.amount);
  const own = (d + Number(w)) / 1e9;
  const diff = Math.abs(Math.abs(own) - t.sol);
  const signOk = t.side === 'buy' ? own < 0 : own > 0;
  ok(signOk && (diff / t.sol < 0.05 || diff < 0.0035), `${c.sig} wallet change ${own} vs sol ${t.sol}`);
  ok(t.slot === tx.slot && t.ts === tx.blockTime * 1000 && /^\d+$/.test(t.tokens), `${c.sig} slot/ts/tokens`);
  console.log(`${c.sig.slice(0, 20)}…  ${t.venue.padEnd(8)} ${t.side.padEnd(4)} sol ${t.sol.toFixed(6)}  tokens ${t.tokens.padStart(16)}  wallet ${t.wallet}  | wallet's own SOL ${own >= 0 ? '+' : ''}${own.toFixed(6)}  diff ${diff.toFixed(6)}`);
}

// robustness: junk never throws and never parses
const junk = [null, {}, { meta: null }, { meta: { err: { x: 1 } } }, { meta: {}, transaction: { message: { accountKeys: 'x' } } },
  { ...raw[CASES[0].sig], meta: { ...raw[CASES[0].sig].meta, err: { InstructionError: [0, 'x'] } } }];
for (const j of junk) ok(parseTrade(j, { mint: CASES[0].mint, curve: curvePda(CASES[0].mint), pool: poolPda(CASES[0].mint), sig: 'x' }) === null, 'junk parsed');
// another mint's view of the same tx is not a trade
ok(parseTrade(raw[CASES[0].sig], { mint: CASES[7].mint, curve: curvePda(CASES[7].mint), pool: poolPda(CASES[7].mint), sig: 'x' }) === null, 'wrong mint parsed');

console.log(`\nchain-history: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
