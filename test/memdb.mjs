/**
 * In-memory stand-in for src/db.js (tests only, not a dependency).
 * Same methods, same insert-only and unique rules.
 */
import { totalsFrom } from '../src/db.js';

export function memDb() {
  const ticks = []; // buckets
  const cps = [];
  const trades = [];
  const sessions = [];
  const state = new Map();
  const ladder = [];
  const copy = (x) => (x == null ? x : structuredClone(x));
  return {
    kind: 'memory-test',
    _raw: { ticks, cps, trades, sessions, ladder },
    async insertBucket(b) {
      if (ticks.some((x) => x.from === b.from)) return { ok: false, dup: true };
      ticks.push({ ...b, z: Buffer.from(b.z) }); return { ok: true };
    },
    async insertCheckpoint(cp) {
      if (cps.some((x) => x.from === cp.from)) return { ok: false, dup: true };
      cps.push(copy(cp)); return { ok: true };
    },
    async lastCheckpoint() { return copy(cps.slice().sort((a, b) => b.to - a.to)[0] || null); },
    async lastBucketHeader() { const b = ticks.slice().sort((a, c) => c.to - a.to)[0]; if (!b) return null; const { z, ...h } = b; return copy(h); },
    async firstBucketHeader() { const b = ticks.slice().sort((a, c) => a.from - c.from)[0]; if (!b) return null; const { z, ...h } = b; return copy(h); },
    async bucketsAfter(step, limit = 4) {
      return ticks.filter((b) => b.to > step).sort((a, c) => a.from - c.from).slice(0, limit).map((b) => ({ ...copy({ ...b, z: null }), z: Buffer.from(b.z) }));
    },
    async checkpoints(after = -1, limit = 500) { return copy(cps.filter((c) => c.to > after).sort((a, b) => a.to - b.to).slice(0, limit)); },
    async insertTrade(t) {
      if (trades.some((x) => x.sig === t.sig)) return { ok: false, dup: true };
      trades.push(copy(t)); return { ok: true };
    },
    async trades(limit = 50) { return copy(trades.slice().sort((a, b) => b.ts - a.ts).slice(0, limit)); },
    async tradeTotals() {
      const g = {};
      for (const t of trades) { g[t.side] = g[t.side] || { side: t.side, n: 0, sol: 0 }; g[t.side].n += 1; g[t.side].sol += t.sol; }
      return totalsFrom(Object.values(g));
    },
    async lastTradeSlot() { return trades.length ? Math.max(...trades.map((t) => t.slot)) : null; },
    async getState(id) { return copy(state.get(id) || null); },
    async setState(id, patch) { state.set(id, { ...(state.get(id) || {}), ...patch }); },
    async insertSession(doc) {
      const v = sessions.filter((s) => s.kind === doc.kind).length + 1;
      sessions.push(copy({ ...doc, v, at: Date.now() })); return { ok: true, v };
    },
    async latestSession(kind) { return copy(sessions.filter((s) => s.kind === kind).sort((a, b) => b.v - a.v)[0] || null); },
    async insertLadderUnlock(doc) {
      if (ladder.some((x) => x.mint === doc.mint && x.stageId === doc.stageId)) return { ok: false, dup: true };
      ladder.push(copy(doc)); return { ok: true };
    },
    async ladderUnlocks(mint) { return copy(ladder.filter((x) => x.mint === mint).sort((a, b) => a.index - b.index)); },
    async ping() { return true; },
    async close() {},
  };
}
