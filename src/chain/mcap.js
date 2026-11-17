// Market cap in USD, read from chain only (no price websites).
//
//   coin price in SOL   bonding curve virtual reserves before graduation,
//                       PumpSwap pool vault balances after
//   x total supply      the mint account's own supply
//   x SOL/USD           Pyth's on-chain SOL/USD price account (push oracle,
//                       owned by the Pyth receiver program), read through the
//                       same RPC
//
// Every number for one reading comes from ONE getMultipleAccounts call, so
// the coin and the oracle are read at the same slot.
//
// orcaSolUsd() reads a second on-chain SOL/USD (Orca's SOL/USDC Whirlpool
// price) for cross-checks; the ladder itself uses Pyth only.
import { rpc } from './rpc.js';
import { isMint, curvePda, poolPda, decodeCurve, decodePool, PUMP, PUMP_AMM, WSOL, TOKEN_DECIMALS, LAMPORTS } from './pump.js';

// Pyth push oracle, SOL/USD (shard 0 sponsored feed). Checked 2026-11-17:
// owner rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ, feed id below.
export const PYTH_SOL_USD = '7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE';
export const PYTH_RECEIVER = 'rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ';
export const PYTH_SOL_FEED = 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d';
// Orca Whirlpool SOL/USDC (cross-check only)
export const ORCA_SOL_USDC = 'Czfq3xZZDmsdGdUyrNLtRhGc47cXcZtLG4crryfu44zE';
export const ORCA_PROGRAM = 'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc';

const MAX_ORACLE_AGE_S = Number(process.env.ORACLE_MAX_AGE_S || 180);

const raw = (v) => (v && Array.isArray(v.data) && v.data[1] === 'base64' ? Buffer.from(v.data[0], 'base64') : null);

/**
 * PriceUpdateV2: disc(8) write_authority(32) verification_level(1 Full | 2 Partial)
 * feed_id(32) price(i64) conf(u64) exponent(i32) publish_time(i64)
 * prev_publish_time(i64) ema_price(i64) ema_conf(u64) posted_slot(u64)
 */
export function decodePyth(buf) {
  if (!buf || buf.length < 133) return null;
  let o = 40;
  const level = buf[o];
  o += level === 0 ? 2 : 1;
  const feed = buf.subarray(o, o + 32).toString('hex'); o += 32;
  const expo = buf.readInt32LE(o + 16);
  const scale = 10 ** expo;
  return {
    verified: level === 1 ? 'full' : 'partial',
    feed,
    price: Number(buf.readBigInt64LE(o)) * scale,
    conf: Number(buf.readBigUInt64LE(o + 8)) * scale,
    publishTime: Number(buf.readBigInt64LE(o + 20)),
    postedSlot: Number(buf.readBigUInt64LE(o + 52)),
  };
}

/** Orca Whirlpool: sqrt_price (u128, Q64.64) at offset 65; SOL (9 dp) / USDC (6 dp) */
export function decodeWhirlpoolSolUsd(buf) {
  if (!buf || buf.length < 81) return null;
  const sp = buf.readBigUInt64LE(65) + (buf.readBigUInt64LE(73) << 64n);
  const s = Number(sp) / 2 ** 64;
  return s * s * 1e3;
}

function checkPyth(acc, nowS) {
  if (!acc) return { ok: false, why: 'the Pyth SOL/USD account was not found' };
  if (acc.owner !== PYTH_RECEIVER) return { ok: false, why: 'the Pyth SOL/USD account has an unexpected owner' };
  const p = decodePyth(raw(acc));
  if (!p) return { ok: false, why: 'the Pyth SOL/USD account could not be read' };
  if (p.feed !== PYTH_SOL_FEED) return { ok: false, why: 'the Pyth account is not the SOL/USD feed' };
  const age = nowS - p.publishTime;
  if (!(p.price > 0)) return { ok: false, why: 'Pyth SOL/USD price is not positive', pyth: p };
  if (age > MAX_ORACLE_AGE_S) return { ok: false, why: `Pyth SOL/USD is ${Math.round(age)} s old`, pyth: p };
  if (p.conf > p.price * 0.02) return { ok: false, why: 'Pyth SOL/USD confidence is wider than 2%', pyth: p };
  return { ok: true, pyth: { ...p, ageS: Math.round(age) } };
}

const vaultCache = new Map(); // mint -> { baseVault, quoteVault } (fixed for a pool)

const tokenAmount = (v) => {
  const a = v?.data?.parsed?.info?.tokenAmount;
  return a ? { raw: String(a.amount), ui: Number(a.amount) / 10 ** Number(a.decimals) } : null;
};

/**
 * readMarketCap(mint) -> {
 *   ok, why?, mcapUsd, priceSol, solUsd, supply, venue: 'curve'|'pumpswap',
 *   slot, at, mint, inputs: { ... every raw number used, with the accounts }
 * }
 * Never throws for a missing or odd coin: ok false with the reason.
 */
export async function readMarketCap(mint, { now = Date.now() } = {}) {
  const at = now;
  if (!isMint(mint)) return { ok: false, why: 'no coin address', at, mcapUsd: null };
  const curve = curvePda(mint);
  const pool = poolPda(mint);
  let vaults = vaultCache.get(mint) || null;
  const list = [curve, mint, PYTH_SOL_USD];
  if (vaults) list.push(vaults.baseVault, vaults.quoteVault);
  else list.push(pool);
  const r = await rpc('getMultipleAccounts', [list, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
  const slot = r?.context?.slot ?? null;
  const [cAcc, mAcc, pAcc, x1, x2] = r?.value || [];
  const nowS = Math.floor(at / 1000);

  if (!cAcc || cAcc.owner !== PUMP) return { ok: false, why: 'not a pump.fun coin (no bonding curve account)', at, slot, mcapUsd: null };
  const st = decodeCurve(raw(cAcc));
  if (!st) return { ok: false, why: 'the bonding curve account could not be read', at, slot, mcapUsd: null };
  const info = mAcc?.data?.parsed?.info;
  if (!info?.supply) return { ok: false, why: 'the mint account could not be read', at, slot, mcapUsd: null };
  const supply = Number(info.supply) / 10 ** Number(info.decimals ?? TOKEN_DECIMALS);

  const o = checkPyth(pAcc, nowS);
  const base = { at, slot, mint, supply, supplyRaw: String(info.supply) };
  if (!o.ok) return { ...base, ok: false, why: o.why, mcapUsd: null, oracle: o.pyth || null };

  let priceSol = null; let venue; let inputs;
  if (!st.complete) {
    venue = 'curve';
    const vt = Number(st.virtualTokenReserves) / 10 ** TOKEN_DECIMALS;
    const vs = Number(st.virtualSolReserves) / LAMPORTS;
    priceSol = vt > 0 ? vs / vt : null;
    inputs = { curve, virtualSolReserves: st.virtualSolReserves.toString(), virtualTokenReserves: st.virtualTokenReserves.toString() };
  } else {
    venue = 'pumpswap';
    if (!vaults) {
      // first read after graduation: learn the vaults from the pool, then read them at one slot
      if (!x1 || x1.owner !== PUMP_AMM) return { ...base, ok: false, why: 'graduated, but the PumpSwap pool was not found yet', mcapUsd: null };
      const d = decodePool(raw(x1));
      if (!d || d.baseMint !== mint || d.quoteMint !== WSOL) {
        return { ...base, ok: false, why: 'the PumpSwap pool is not a SOL pool of this coin', mcapUsd: null };
      }
      vaults = { baseVault: d.baseVault, quoteVault: d.quoteVault };
      vaultCache.set(mint, vaults);
      return readMarketCap(mint, { now });
    }
    const b = tokenAmount(x1); const q = tokenAmount(x2);
    if (!b || !q || !(b.ui > 0)) return { ...base, ok: false, why: 'the PumpSwap pool vaults could not be read', mcapUsd: null };
    priceSol = q.ui / b.ui;
    inputs = { pool, baseVault: vaults.baseVault, quoteVault: vaults.quoteVault, baseRaw: b.raw, quoteLamports: q.raw };
  }
  if (!(priceSol > 0)) return { ...base, ok: false, why: 'no price', mcapUsd: null };
  const solUsd = o.pyth.price;
  const mcapUsd = priceSol * supply * solUsd;
  return {
    ...base, ok: true, venue, priceSol, solUsd, mcapUsd,
    oracle: { source: 'pyth', account: PYTH_SOL_USD, price: o.pyth.price, conf: o.pyth.conf, publishTime: o.pyth.publishTime, ageS: o.pyth.ageS, postedSlot: o.pyth.postedSlot, verified: o.pyth.verified },
    inputs,
  };
}

/** both on-chain SOL/USD numbers at one slot: { slot, pyth, orca, diffPct } */
export async function solUsdBoth() {
  const r = await rpc('getMultipleAccounts', [[PYTH_SOL_USD, ORCA_SOL_USDC], { encoding: 'base64', commitment: 'confirmed' }]);
  const [p, w] = r?.value || [];
  const pyth = p && p.owner === PYTH_RECEIVER ? decodePyth(raw(p)) : null;
  const orca = w && w.owner === ORCA_PROGRAM ? decodeWhirlpoolSolUsd(raw(w)) : null;
  const diffPct = pyth && orca ? (Math.abs(pyth.price - orca) / pyth.price) * 100 : null;
  return { slot: r?.context?.slot ?? null, pyth, orca, diffPct };
}
