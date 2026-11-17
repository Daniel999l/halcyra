// src/chain: one pump.fun coin on Solana, read only. No keys, no signing, no sending.
//
//   createTradeWatcher({ mint, onTrade, fromSlot, onSlot, pollMs })  -> { start(), stop(), pollOnce() }
//   readCoin(mint)   -> null | { mint, name, symbol, graduated, progress, priceSol, ... }
//   marketFor(mint)  -> { priceUsd, mcapUsd, vol24hUsd, graduated, progress, source, ... }
//   isMint(s)
//
// Trade = { sig, side: 'buy'|'sell', wallet, sol, tokens (raw string), slot, ts (ms), venue: 'curve'|'pumpswap' }
// RPC: RPC_URL env, default https://api.mainnet-beta.solana.com
export { createTradeWatcher } from './watch.js';
export { readCoin, marketFor, solUsd, venueOf } from './coin.js';
export { isMint, curvePda, poolPda } from './pump.js';
export { parseTrade } from './parse.js';
export { rpcUrl } from './rpc.js';
