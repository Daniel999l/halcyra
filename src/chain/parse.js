// One parsed transaction -> one Trade for our mint, or null.
//
// Balance deltas, no SDK:
// - the venue is the bonding curve PDA (before graduation) or the canonical PumpSwap pool (after);
//   it is the venue's own balance of the mint that has to move, so transactions that only touch
//   the address (fee claims, transfers, other mints) are not trades
// - side: the venue gave tokens out = buy, took tokens in = sell
// - sol: lamport change of the curve PDA, or the pool's WSOL change (what went into or out of the
//   pool, before platform/creator fees and the network fee)
// - tokens: the venue's change in the mint, raw (6 decimals)
// - wallet: the fee payer when its balance of the mint moved the other way, else the owner whose
//   balance moved most the other way (routers that pay for someone else)

const keyStr = (k) => (typeof k === 'string' ? k : k?.pubkey ? String(k.pubkey) : String(k));
const abs = (x) => (x < 0n ? -x : x);

/**
 * tx: getTransaction(sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1 }) result
 * ctx: { mint, curve, pool, sig?, blockTime? }
 * -> { sig, side, wallet, sol, tokens, slot, ts, venue } | null
 */
export function parseTrade(tx, ctx) {
  try {
    if (!tx || !tx.meta || tx.meta.err) return null;
    const { mint, curve, pool } = ctx;
    const msg = tx.transaction?.message;
    if (!msg || !Array.isArray(msg.accountKeys)) return null;
    const keys = msg.accountKeys.map(keyStr);
    const sig = ctx.sig || tx.transaction.signatures?.[0];
    if (!sig) return null;

    const tokenD = new Map(); const wsolD = new Map();
    const add = (b, sign) => {
      if (!b || !b.owner || !b.uiTokenAmount) return;
      const m = b.mint === mint ? tokenD : b.mint === 'So11111111111111111111111111111111111111112' ? wsolD : null;
      if (!m) return;
      m.set(b.owner, (m.get(b.owner) || 0n) + sign * BigInt(b.uiTokenAmount.amount));
    };
    for (const b of tx.meta.preTokenBalances || []) add(b, -1n);
    for (const b of tx.meta.postTokenBalances || []) add(b, 1n);

    let venue = null; let venueD = 0n; let lamports = 0;
    const cD = curve ? tokenD.get(curve) || 0n : 0n;
    const pD = pool ? tokenD.get(pool) || 0n : 0n;
    if (cD) {
      const ci = keys.indexOf(curve);
      if (ci < 0) return null;
      venue = 'curve'; venueD = cD;
      lamports = Math.abs(Number(tx.meta.postBalances[ci]) - Number(tx.meta.preBalances[ci]));
    } else if (pD) {
      venue = 'pumpswap'; venueD = pD;
      lamports = Number(abs(wsolD.get(pool) || 0n));
    } else return null;

    const side = venueD < 0n ? 'buy' : 'sell';
    const tokens = abs(venueD);
    // the trader moved the other way from the venue
    const other = (d) => d && ((d > 0n) !== (venueD > 0n));
    const payer = keys[0];
    let wallet = null;
    if (other(tokenD.get(payer))) wallet = payer;
    else {
      let best = 0n;
      for (const [o, d] of tokenD) {
        if (o === curve || o === pool || !other(d)) continue;
        if (abs(d) > best) { best = abs(d); wallet = o; }
      }
    }
    if (!wallet) wallet = payer; // tokens went to an account owned by a program; the signer still paid
    if (!lamports || !tokens) return null;
    const bt = tx.blockTime ?? ctx.blockTime ?? null;
    return {
      sig, side, wallet,
      sol: lamports / 1e9,
      tokens: tokens.toString(),
      slot: Number(tx.slot),
      ts: bt != null ? Number(bt) * 1000 : 0,
      venue,
    };
  } catch {
    return null; // a malformed transaction is never a trade and never a crash
  }
}
