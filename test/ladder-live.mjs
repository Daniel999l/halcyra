/**
 * Live, read only, mainnet: the ladder's market cap maths on a real coin still
 * on the pump.fun bonding curve and a real graduated coin on PumpSwap.
 *
 *   node test/ladder-live.mjs [--curve <mint>] [--pool <mint>]
 *
 * Checks for each coin: readMarketCap answers ok at one slot; the venue is
 * right; price in SOL matches the existing reader (src/chain/coin.js readCoin,
 * a separate code path over the same accounts) within 2% (a few seconds pass
 * between the two reads); mcap = price x supply x SOL/USD exactly.
 * SOL/USD: Pyth vs Orca's SOL/USDC Whirlpool, read at one slot, must agree
 * within 1%; prints how far apart they are.
 */
import { readMarketCap, solUsdBoth } from '../src/chain/mcap.js';
import { readCoin } from '../src/chain/coin.js';
import { rpc } from '../src/chain/rpc.js';
import { PUMP, PUMP_AMM } from '../src/chain/pump.js';
import { check, finish } from './service-fixtures.mjs';

const R = []; const ok = check(R);
const argv = process.argv.slice(2);
const arg = (k) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : null; };
console.log('ladder-live (mainnet, read only)\n');

async function find(program, graduated) {
  const sigs = (await rpc('getSignaturesForAddress', [program, { limit: 12 }])).filter((s) => !s.err);
  for (const s of sigs) {
    const tx = await rpc('getTransaction', [s.signature, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 0 }]).catch(() => null);
    for (const m of new Set((tx?.meta?.postTokenBalances || []).map((b) => b.mint))) {
      if (!m.endsWith('pump')) continue;
      const c = await readCoin(m).catch(() => null);
      if (c && c.graduated === graduated && (!graduated || c.poolLive)) return m;
    }
  }
  return null;
}

const both = await solUsdBoth();
ok(both.pyth && both.orca && both.diffPct < 1, `SOL/USD at slot ${both.slot}: Pyth ${both.pyth?.price.toFixed(4)} (published ${Math.round(Date.now() / 1000 - both.pyth?.publishTime)} s ago, conf ${both.pyth?.conf.toFixed(4)}), Orca Whirlpool ${both.orca?.toFixed(4)}: ${both.diffPct?.toFixed(3)}% apart`);

for (const [label, graduated, given] of [['bonding curve', false, arg('curve')], ['graduated (PumpSwap)', true, arg('pool')]]) {
  const mint = given || await find(graduated ? PUMP_AMM : PUMP, graduated);
  if (!mint) { ok(false, `found a live ${label} coin`); continue; }
  const m = await readMarketCap(mint);
  const c = await readCoin(mint);
  console.log(`\n  ${label}: ${mint} (${c?.symbol || '?'})`);
  console.log(`    ${JSON.stringify({ ok: m.ok, why: m.why, venue: m.venue, slot: m.slot, priceSol: m.priceSol, supply: m.supply, solUsd: m.solUsd, mcapUsd: m.mcapUsd && Math.round(m.mcapUsd), oracleAgeS: m.oracle?.ageS })}`);
  ok(m.ok && m.venue === (graduated ? 'pumpswap' : 'curve') && Number.isInteger(m.slot), `${label}: read ok at one slot (${m.slot}), venue ${m.venue}`);
  const d = c?.priceSol ? Math.abs(m.priceSol - c.priceSol) / c.priceSol * 100 : null;
  ok(d != null && d < 2, `${label}: price in SOL ${m.priceSol?.toExponential(4)} vs readCoin ${c?.priceSol?.toExponential(4)} (${d?.toFixed(3)}% apart)`);
  ok(m.ok && Math.abs(m.mcapUsd - m.priceSol * m.supply * m.solUsd) < 1e-6 * m.mcapUsd, `${label}: market cap $${Math.round(m.mcapUsd || 0).toLocaleString('en-US')} = price x ${m.supply?.toLocaleString('en-US')} supply x $${m.solUsd?.toFixed(2)}`);
}
finish(R, 'ladder-live');
process.exit(process.exitCode || 0);
