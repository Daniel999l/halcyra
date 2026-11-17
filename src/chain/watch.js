// The trade watcher for one pump.fun coin: bonding curve, then PumpSwap after graduation.
//
// It polls the history of the venue address (the bonding curve PDA while on the curve, the
// canonical PumpSwap pool after graduation), oldest first, fetches each new transaction and
// parses it (parse.js). Every trade is emitted once: signatures are remembered in memory, and
// `fromSlot` (the last slot onSlot reported) makes a restart pick up after it.
//
// onSlot(S) is called once every transaction of the venue in slots <= S has been handled, so a
// restart with fromSlot = S emits only slots > S. If the process dies in the middle of a slot,
// the trades of that one slot can come again after a restart: key stored trades by `sig`.
import { rpc as defaultRpc } from './rpc.js';
import { parseTrade } from './parse.js';
import { venueOf as defaultVenueOf } from './coin.js';
import { isMint } from './pump.js';

/**
 * createTradeWatcher({ mint, onTrade, fromSlot, onSlot, pollMs, backfill = 0, log })
 *   onTrade(trade) trade = { sig, side, wallet, sol, tokens, slot, ts, venue }
 *   fromSlot: only trades in later slots are emitted. Without it, the watcher starts at the
 *     chain tip (plus the last `backfill` signatures of the venue, default none).
 *   onSlot(slot): the slot everything up to has been handled; persist it and pass it back as fromSlot.
 *   pollMs: default SOL_POLL_MS env or 4000.
 * -> { start(), stop(), pollOnce() }
 */
export function createTradeWatcher(opts = {}) {
  const { mint, onTrade, onSlot } = opts;
  if (!isMint(mint)) throw new Error('createTradeWatcher needs a valid mint');
  if (typeof onTrade !== 'function') throw new Error('createTradeWatcher needs onTrade');
  const rpc = opts._rpc || defaultRpc;            // injectable for tests
  const venueOf = opts._venueOf || defaultVenueOf;
  const log = opts.log || console;
  const every = Math.max(1000, Number(opts.pollMs || process.env.SOL_POLL_MS || 4000));
  const backfill = Math.max(0, Math.min(100, Number(opts.backfill || 0)));
  const PAGE = 100; const MAX_PAGES = 10;
  const venueTtl = opts._venueTtl ?? 30000; // how often a coin on the curve is checked for graduation

  let watermark = opts.fromSlot != null && Number.isFinite(Number(opts.fromSlot)) ? Number(opts.fromSlot) : null;
  const seen = new Set();
  const remember = (sig) => { seen.add(sig); if (seen.size > 50000) seen.delete(seen.values().next().value); };
  const fails = new Map();
  const cursor = new Map();     // address -> newest signature fully handled
  let venue = null;             // { addr, kind, curve, pool, graduated, checkedAt }
  let lastIncompleteSlot = null;
  let stopped = true; let running = false; let timer = null; let gen = 0;
  let warnedNoCoin = false;

  async function resolveVenue() {
    if (venue && (venue.graduated || Date.now() - venue.checkedAt < venueTtl)) return venue;
    const v = await venueOf(mint);
    if (!v) {
      if (!warnedNoCoin) { log.warn?.(`[chain] ${mint} has no pump.fun bonding curve (yet)`); warnedNoCoin = true; }
      return null;
    }
    warnedNoCoin = false;
    if (!v.state.complete) {
      lastIncompleteSlot = v.slot ?? lastIncompleteSlot;
      venue = { addr: v.curve, kind: 'curve', curve: v.curve, pool: v.pool, graduated: false, checkedAt: Date.now() };
    } else if (v.poolState) {
      if (venue?.kind !== 'pool') log.info?.(`[chain] ${mint} is graduated, reading PumpSwap pool ${v.pool}`);
      venue = { addr: v.pool, kind: 'pool', curve: v.curve, pool: v.pool, graduated: true, checkedAt: Date.now() };
    } else {
      // complete but the canonical pool is not there (yet): keep reading the curve, check again soon
      venue = { addr: v.curve, kind: 'curve', curve: v.curve, pool: v.pool, graduated: false, checkedAt: Date.now() };
    }
    return venue;
  }

  // newest-first list of signatures of `addr` newer than the cursor / floor slot
  async function collect(addr, floor) {
    const until = cursor.get(addr);
    if (!until && floor == null) {
      // fresh start at the tip
      const tip = await rpc('getSignaturesForAddress', [addr, { limit: Math.max(1, backfill), commitment: 'confirmed' }]);
      if (!tip.length) return { list: [], tipOnly: true };
      if (!backfill) { cursor.set(addr, tip[0].signature); await reportSlot(tip[0].slot); return { list: [], tipOnly: true }; }
      return { list: tip, tipOnly: false };
    }
    const out = []; let before; let truncated = true;
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const q = { limit: PAGE, commitment: 'confirmed' };
      if (until) q.until = until;
      if (before) q.before = before;
      const batch = await rpc('getSignaturesForAddress', [addr, q]);
      let reachedFloor = false;
      for (const s of batch) {
        // with a cursor, `until` bounds the list; the floor only applies to a first look (restart, new venue)
        if (!until && floor != null && s.slot <= floor) { reachedFloor = true; break; }
        out.push(s);
      }
      if (reachedFloor || batch.length < PAGE) { truncated = false; break; }
      before = batch[batch.length - 1].signature;
    }
    if (truncated) log.warn?.(`[chain] more than ${PAGE * MAX_PAGES} new signatures on ${addr} in one round; older ones in this gap were skipped`);
    return { list: out, tipOnly: false };
  }

  async function fetchTx(sig) {
    return rpc('getTransaction', [sig, { encoding: 'jsonParsed', maxSupportedTransactionVersion: 1, commitment: 'confirmed' }]);
  }

  async function reportSlot(s) {
    if (s == null || (watermark != null && s <= watermark)) return;
    watermark = s;
    if (onSlot) { try { await onSlot(s); } catch (e) { log.error?.('[chain] onSlot failed', e?.message || e); } }
  }

  async function pollOnce(myGen = null) {
    if (running) return { skipped: true };
    running = true;
    let emitted = 0;
    try {
      const v = await resolveVenue();
      if (!v) return { emitted };
      // first look at the pool after graduation: start just after the last slot the curve was open
      let floor = watermark;
      if (v.kind === 'pool' && !cursor.has(v.addr) && lastIncompleteSlot != null) floor = Math.min(floor ?? lastIncompleteSlot, lastIncompleteSlot);
      const { list } = await collect(v.addr, floor);
      const sigs = list.slice().reverse(); // oldest first
      let curSlot = null;
      for (const s of sigs) {
        if (myGen != null && (stopped || myGen !== gen)) { curSlot = null; break; } // stopped mid-slot: that slot is not done
        if (curSlot != null && s.slot > curSlot) await reportSlot(curSlot);
        curSlot = s.slot;
        if (!seen.has(s.signature) && !s.err) {
          let tx = null; let err = null;
          try { tx = await fetchTx(s.signature); } catch (e) { err = e; }
          if (!tx) {
            const n = (fails.get(s.signature) || 0) + 1; fails.set(s.signature, n);
            if (n < 4) { // not served yet: stop here and pick it up next round
              if (err) log.warn?.(`[chain] could not fetch ${s.signature}: ${err.message || err}`);
              curSlot = null;
              break;
            }
            log.warn?.(`[chain] giving up on ${s.signature} after ${n} tries`);
          } else {
            fails.delete(s.signature);
            const t = parseTrade(tx, { mint, curve: v.curve, pool: v.pool, sig: s.signature, blockTime: s.blockTime });
            if (t) {
              remember(s.signature);
              emitted += 1;
              try { await onTrade(t); } catch (e) { log.error?.('[chain] onTrade failed', e?.message || e); }
            }
          }
        }
        remember(s.signature);
        cursor.set(v.addr, s.signature);
      }
      if (curSlot != null) await reportSlot(curSlot);
      return { emitted, venue: v.kind };
    } catch (e) {
      log.error?.('[chain] poll failed', e?.message || e);
      return { emitted, error: String(e?.message || e) };
    } finally {
      running = false;
    }
  }

  async function loop(myGen) {
    if (stopped || myGen !== gen) return;
    await pollOnce(myGen);
    if (!stopped && myGen === gen) timer = setTimeout(() => loop(myGen), every);
  }

  return {
    start() { if (!stopped) return; stopped = false; gen += 1; loop(gen); },
    stop() { stopped = true; gen += 1; if (timer) clearTimeout(timer); timer = null; },
    pollOnce: () => pollOnce(null),
    get slot() { return watermark; },
  };
}

