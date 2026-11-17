// Reading the coin: bonding curve and PumpSwap pool straight from chain; SOL/USD and 24h volume from public APIs.
import { rpc } from './rpc.js';
import {
  web3, isMint, curvePda, poolPda, metaplexPda, decodeCurve, decodePool,
  PUMP, PUMP_AMM, TOKEN_DECIMALS, LAMPORTS, CURVE_TOKENS_WHOLE,
} from './pump.js';

const b64 = (v) => (v && Array.isArray(v.data) ? Buffer.from(v.data[0], 'base64') : null);

async function account(addr) {
  const r = await rpc('getAccountInfo', [addr, { encoding: 'base64', commitment: 'confirmed' }]);
  return r?.value ? { owner: r.value.owner, data: b64(r.value), lamports: r.value.lamports, slot: r.context?.slot ?? null } : null;
}

/** curve + pool state of a mint. -> null (no pump.fun curve) | { curve, pool, state, poolState, slot } */
export async function venueOf(mint) {
  if (!isMint(mint)) return null;
  const curve = curvePda(mint);
  const c = await account(curve);
  if (!c || c.owner !== PUMP) return null;
  const state = decodeCurve(c.data);
  if (!state) return null;
  const pool = poolPda(mint);
  let poolState = null;
  if (state.complete) {
    const p = await account(pool);
    if (p && p.owner === PUMP_AMM) {
      const d = decodePool(p.data);
      if (d && d.baseMint === mint) poolState = d;
    }
  }
  return { curve, pool, state, poolState, slot: c.slot };
}

function readBorshString(buf, off) {
  const len = buf.readUInt32LE(off);
  return [buf.subarray(off + 4, off + 4 + len).toString('utf8').replace(/\0+$/, ''), off + 4 + len];
}

async function tokenMeta(mint) {
  const out = { name: '', symbol: '', uri: '', tokenProgram: null, supply: null };
  try {
    const r = await rpc('getAccountInfo', [mint, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
    const v = r?.value;
    if (v) {
      out.tokenProgram = v.owner;
      const info = v.data?.parsed?.info || {};
      out.supply = info.supply ?? null;
      const ext = (info.extensions || []).find((e) => e.extension === 'tokenMetadata');
      if (ext?.state) { out.name = ext.state.name || ''; out.symbol = ext.state.symbol || ''; out.uri = ext.state.uri || ''; return out; }
    }
  } catch {}
  try {
    const m = await account(metaplexPda(mint));
    if (m?.data) {
      let off = 1 + 32 + 32; let name; let symbol; let uri;
      [name, off] = readBorshString(m.data, off);
      [symbol, off] = readBorshString(m.data, off);
      [uri] = readBorshString(m.data, off);
      Object.assign(out, { name, symbol, uri });
    }
  } catch {}
  return out;
}

async function poolPriceSol(poolState) {
  const r = await rpc('getMultipleAccounts', [[poolState.baseVault, poolState.quoteVault], { encoding: 'jsonParsed', commitment: 'confirmed' }]);
  const [b, q] = r?.value || [];
  const base = Number(b?.data?.parsed?.info?.tokenAmount?.amount || 0) / 10 ** TOKEN_DECIMALS;
  const quote = Number(q?.data?.parsed?.info?.tokenAmount?.amount || 0) / LAMPORTS;
  return base > 0 ? { priceSol: quote / base, liquiditySol: quote } : { priceSol: null, liquiditySol: 0 };
}

const coinCache = new Map();
/** readCoin(mint) -> null when it is not a pump.fun coin, else its state. Cached 5 s. */
export async function readCoin(mint) {
  if (!isMint(mint)) return null;
  const hit = coinCache.get(mint);
  if (hit && Date.now() - hit.at < 5000) return hit.data;
  const v = await venueOf(mint);
  if (!v) return null;
  const meta = await tokenMeta(mint);
  const s = v.state;
  const graduated = s.complete;
  const realWhole = Number(s.realTokenReserves) / 10 ** TOKEN_DECIMALS;
  const progress = graduated ? 1 : Math.max(0, Math.min(1, 1 - realWhole / CURVE_TOKENS_WHOLE));
  let priceSol = null; let liquiditySol = null;
  if (!graduated) {
    const vt = Number(s.virtualTokenReserves) / 10 ** TOKEN_DECIMALS;
    priceSol = vt > 0 ? (Number(s.virtualSolReserves) / LAMPORTS) / vt : null;
    liquiditySol = Number(s.realSolReserves) / LAMPORTS;
  } else if (v.poolState) {
    ({ priceSol, liquiditySol } = await poolPriceSol(v.poolState));
  }
  const supplyRaw = meta.supply ?? s.tokenTotalSupply.toString();
  const data = {
    mint, name: meta.name, symbol: meta.symbol, uri: meta.uri, decimals: TOKEN_DECIMALS,
    totalSupply: String(supplyRaw), tokenProgram: meta.tokenProgram,
    curve: v.curve, pool: v.pool, poolLive: Boolean(v.poolState), creator: s.creator,
    graduated, progress, priceSol, liquiditySol, slot: v.slot,
  };
  coinCache.set(mint, { at: Date.now(), data });
  return data;
}

const UA = { accept: 'application/json', 'user-agent': 'Mozilla/5.0' };
async function getJson(url, ms = 8000) {
  const r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error('http ' + r.status);
  return r.json();
}
const num = (x) => { const n = Number(x); return Number.isFinite(n) ? n : null; };

let solCache = { at: 0, v: 0 };
/** USD per SOL: Jupiter lite v3, then Coinbase. Cached 60 s. 0 if both fail. */
export async function solUsd() {
  if (solCache.v && Date.now() - solCache.at < 60000) return solCache.v;
  let v = 0;
  try { const j = await getJson('https://lite-api.jup.ag/price/v3?ids=So11111111111111111111111111111111111111112', 6000); v = num(j?.So11111111111111111111111111111111111111112?.usdPrice) || 0; } catch {}
  if (!v) { try { const j = await getJson('https://api.coinbase.com/v2/prices/SOL-USD/spot', 6000); v = num(j?.data?.amount) || 0; } catch {} }
  if (v > 0) solCache = { at: Date.now(), v };
  return solCache.v || 0;
}

async function vol24h(mint) {
  try {
    const j = await getJson(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
    const pairs = (j?.pairs || []).filter((p) => p.chainId === 'solana' && p.baseToken?.address === mint);
    if (!pairs.length) return null;
    return pairs.reduce((s, p) => s + (num(p.volume?.h24) || 0), 0);
  } catch { return null; }
}

const mCache = new Map();
/**
 * marketFor(mint) -> { priceUsd, mcapUsd, vol24hUsd, graduated, progress, source, priceSol, solUsd, vol24hSource }
 * Price is read on chain (curve reserves, or PumpSwap pool vaults after graduation). Cached 10 s.
 */
export async function marketFor(mint) {
  const empty = { priceUsd: null, mcapUsd: null, vol24hUsd: 0, graduated: false, progress: 0, source: 'none', priceSol: null, solUsd: 0, vol24hSource: 'none' };
  if (!isMint(mint)) return empty;
  const hit = mCache.get(mint);
  if (hit && Date.now() - hit.at < 10000) return hit.data;
  const [coin, sol, vol] = await Promise.all([readCoin(mint).catch(() => null), solUsd(), vol24h(mint)]);
  if (!coin) return { ...empty, vol24hUsd: vol ?? 0, vol24hSource: vol != null ? 'dexscreener' : 'none' };
  const supply = Number(coin.totalSupply) / 10 ** TOKEN_DECIMALS;
  const priceUsd = coin.priceSol != null && sol ? coin.priceSol * sol : null;
  const data = {
    priceUsd, mcapUsd: priceUsd != null ? priceUsd * supply : null,
    vol24hUsd: vol ?? 0, vol24hSource: vol != null ? 'dexscreener' : 'none',
    graduated: coin.graduated, progress: coin.progress,
    source: coin.priceSol == null ? 'none' : coin.graduated ? 'pumpswap' : 'curve',
    priceSol: coin.priceSol, solUsd: sol,
  };
  mCache.set(mint, { at: Date.now(), data });
  return data;
}

export { web3 };
