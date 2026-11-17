/**
 * Mongo, on a cluster shared with other projects. This file only ever touches
 * four collections, all prefixed halcyra_:
 *
 *   halcyra_ticks     the proof ledger, in compressed buckets of ~1 minute
 *                    (insert-only, unique on `from`; expire after TICK_KEEP_H)
 *   halcyra_meta      ledger checkpoints, one per bucket (insert-only, kept
 *                    forever) plus a small state doc for the trade cursor
 *   halcyra_trades    every trade she tasted (insert-only, unique on sig)
 *   halcyra_session   console login storageState versions (insert-only)
 *   halcyra_ladder    game ladder unlocks (insert-only, unique on mint + stage)
 *
 * Nothing here drops, renames or reads any other collection.
 * test/memdb.mjs implements the same methods in memory for tests.
 */
import { say } from './log.js';

export const COLLECTIONS = ['halcyra_ticks', 'halcyra_meta', 'halcyra_trades', 'halcyra_session', 'halcyra_ladder'];

const isDup = (e) => e && (e.code === 11000 || /E11000/.test(String(e.message)));
const strip = (d) => { if (!d) return d; const { _id, ...r } = d; return r; };

export async function connectMongo({ uri, db: dbName = 'halcyra', keepHours = 48 }) {
  const { MongoClient, Binary } = await import('mongodb');
  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000, maxPoolSize: 5 });
  await client.connect();
  const db = client.db(dbName);
  const ticks = db.collection('halcyra_ticks');
  const meta = db.collection('halcyra_meta');
  const trades = db.collection('halcyra_trades');
  const session = db.collection('halcyra_session');
  const ladder = db.collection('halcyra_ladder');

  await ticks.createIndex({ from: 1 }, { unique: true, name: 'from_unique' });
  await ticks.createIndex({ to: 1 }, { name: 'to' });
  await setTtl(db, ticks, keepHours);
  await meta.createIndex({ kind: 1, to: 1 }, { name: 'kind_to' });
  await meta.createIndex({ cpFrom: 1 }, { unique: true, sparse: true, name: 'cp_unique' });
  await trades.createIndex({ sig: 1 }, { unique: true, name: 'sig_unique' });
  await trades.createIndex({ ts: -1 }, { name: 'ts' });
  await session.createIndex({ kind: 1, v: -1 }, { name: 'kind_v' });
  await ladder.createIndex({ mint: 1, stageId: 1 }, { unique: true, name: 'mint_stage_unique' });

  const insert = async (col, doc) => {
    try { await col.insertOne(doc); return { ok: true }; } catch (e) { if (isDup(e)) return { ok: false, dup: true }; throw e; }
  };

  return {
    kind: 'mongo',
    async insertBucket(b) { return insert(ticks, { ...b, z: new Binary(b.z), at: new Date(b.at) }); },
    async insertCheckpoint(cp) { return insert(meta, { kind: 'cp', cpFrom: cp.from, ...cp, at: new Date(cp.at) }); },
    async lastCheckpoint() {
      const d = await meta.find({ kind: 'cp' }).sort({ to: -1 }).limit(1).next();
      return d ? cpOut(d) : null;
    },
    async lastBucketHeader() {
      const d = await ticks.find({}, { projection: { z: 0 } }).sort({ to: -1 }).limit(1).next();
      return d ? { ...strip(d), at: +d.at } : null;
    },
    async firstBucketHeader() {
      const d = await ticks.find({}, { projection: { z: 0 } }).sort({ from: 1 }).limit(1).next();
      return d ? { ...strip(d), at: +d.at } : null;
    },
    async bucketsAfter(step, limit = 4) {
      const rows = await ticks.find({ to: { $gt: step } }).sort({ from: 1 }).limit(limit).toArray();
      return rows.map((d) => ({ ...strip(d), at: +d.at, z: Buffer.from(d.z.buffer) }));
    },
    async checkpoints(after = -1, limit = 500) {
      const rows = await meta.find({ kind: 'cp', to: { $gt: after } }).sort({ to: 1 }).limit(limit).toArray();
      return rows.map(cpOut);
    },
    async insertTrade(t) { return insert(trades, { ...t }); },
    async trades(limit = 50) { return (await trades.find({}).sort({ ts: -1 }).limit(limit).toArray()).map(strip); },
    async tradeTotals() {
      const rows = await trades.aggregate([{ $group: { _id: '$side', n: { $sum: 1 }, sol: { $sum: '$sol' } } }]).toArray();
      return totalsFrom(rows.map((r) => ({ side: r._id, n: r.n, sol: r.sol })));
    },
    async lastTradeSlot() {
      const d = await trades.find({}, { projection: { slot: 1 } }).sort({ slot: -1 }).limit(1).next();
      return d ? d.slot : null;
    },
    async getState(id) { return strip(await meta.findOne({ _id: `state:${id}` })); },
    async setState(id, patch) { await meta.updateOne({ _id: `state:${id}` }, { $set: { ...patch, kind: 'state' } }, { upsert: true }); },
    async insertSession(doc) {
      const last = await session.find({ kind: doc.kind }).sort({ v: -1 }).limit(1).next();
      const v = (last?.v || 0) + 1;
      const r = await insert(session, { ...doc, v, at: new Date() });
      return { ...r, v };
    },
    async latestSession(kind) { return strip(await session.find({ kind }).sort({ v: -1 }).limit(1).next()); },
    async insertLadderUnlock(doc) { return insert(ladder, { ...doc, at: new Date(doc.at) }); },
    async ladderUnlocks(mint) { return (await ladder.find({ mint }).sort({ index: 1 }).toArray()).map((d) => ({ ...strip(d), at: +d.at })); },
    async ping() { await db.command({ ping: 1 }); return true; },
    async close() { try { await client.close(); } catch { /* gone */ } },
  };
}

function cpOut(d) {
  const { _id, kind, cpFrom, ...r } = d;
  return { ...r, at: +new Date(r.at) };
}

export function totalsFrom(rows) {
  const t = { trades: 0, buys: 0, sells: 0, solIn: 0, solOut: 0 };
  for (const r of rows) {
    t.trades += r.n;
    if (r.side === 'buy') { t.buys += r.n; t.solIn += r.sol || 0; }
    if (r.side === 'sell') { t.sells += r.n; t.solOut += r.sol || 0; }
  }
  return t;
}

/** TTL on full tick buckets. 0 = keep forever. Checkpoints are never expired. */
async function setTtl(db, ticks, keepHours) {
  const secs = keepHours > 0 ? Math.round(keepHours * 3600) : 100 * 365 * 86400;
  try {
    await ticks.createIndex({ at: 1 }, { expireAfterSeconds: secs, name: 'at_ttl' });
  } catch (e) {
    if (!/already exists|IndexOptionsConflict|equivalent index/i.test(e.message) && e.code !== 85) throw e;
    await db.command({ collMod: 'halcyra_ticks', index: { name: 'at_ttl', expireAfterSeconds: secs } });
    say(`tick retention changed to ${keepHours > 0 ? `${keepHours} h` : 'forever'}`, { kind: 'db' });
  }
}
