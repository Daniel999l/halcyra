/**
 * The proof ledger: every brain step, hash-chained.
 *
 *   record = canonical(tick without "lit"), with step = the ledger's own
 *            global step and pilotStep = the step number the pilot gave it
 *   hash   = sha256(prevHash + canonicalJSON(record))
 *
 * canonicalJSON sorts object keys at every level and drops undefined.
 * Before hashing, every non-integer number is rounded to 4 decimals (NaN and
 * Infinity become null), and that rounded record is exactly what is stored and
 * served, so anyone can recompute the hash from what the API hands out.
 *
 * Storage: records are packed ~300 at a time (about a minute) into one gzipped
 * bucket in halcyra_ticks, insert-only and unique on `from`. Each bucket also
 * writes a small checkpoint {from, to, n, prevHash, head} into halcyra_meta that
 * is never expired, so the chain of checkpoints stays linked even after the
 * full buckets age out (TICK_KEEP_H). Without Mongo: memory ring only.
 */
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { say } from './log.js';

export const GENESIS = '0'.repeat(64);
const STRIP = new Set(['lit', 'hash', 'prevHash']);

export function canonicalJSON(v) {
  if (v === null || typeof v !== 'object') {
    if (typeof v === 'number' && !Number.isFinite(v)) return 'null';
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map((x) => (x === undefined || typeof x === 'function' ? 'null' : canonicalJSON(x))).join(',')}]`;
  const keys = Object.keys(v).filter((k) => v[k] !== undefined && typeof v[k] !== 'function').sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJSON(v[k])}`).join(',')}}`;
}

/** rounds numbers, drops undefined and functions; returns a plain JSON-safe copy */
export function normalise(v, dp = 4) {
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null;
    if (Number.isInteger(v)) return v;
    const r = Number(v.toFixed(dp));
    return Object.is(r, -0) ? 0 : r;
  }
  if (typeof v === 'bigint') return v.toString();
  if (v === null || typeof v !== 'object') return v;
  if (ArrayBuffer.isView(v)) return Array.from(v, (x) => normalise(x, dp));
  if (Array.isArray(v)) return v.map((x) => (x === undefined ? null : normalise(x, dp)));
  const out = {};
  for (const k of Object.keys(v)) {
    if (v[k] === undefined || typeof v[k] === 'function') continue;
    out[k] = normalise(v[k], dp);
  }
  return out;
}

export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

/** the part of a stored record that is hashed */
export function hashBody(rec) {
  const o = {};
  for (const k of Object.keys(rec)) if (!STRIP.has(k)) o[k] = rec[k];
  return o;
}
export const hashRecord = (prevHash, rec) => sha256(prevHash + canonicalJSON(hashBody(rec)));

/**
 * Recompute a run of stored records. `prevHash` is what the first one should
 * link to (GENESIS for step 0). -> { ok, n, head, lastStep, badAt?, reason? }
 */
export function verify(records, { prevHash } = {}) {
  let prev = prevHash ?? (records[0]?.step === 0 ? GENESIS : records[0]?.prevHash);
  let lastStep = null;
  for (let i = 0; i < records.length; i += 1) {
    const r = records[i];
    if (lastStep !== null && r.step !== lastStep + 1) return { ok: false, n: i, badAt: r.step, reason: `step ${r.step} follows ${lastStep}` };
    if (r.prevHash !== prev) return { ok: false, n: i, badAt: r.step, reason: `prevHash at step ${r.step} does not match the hash before it` };
    const h = hashRecord(prev, r);
    if (h !== r.hash) return { ok: false, n: i, badAt: r.step, reason: `hash at step ${r.step} does not match its contents` };
    prev = h; lastStep = r.step;
  }
  return { ok: true, n: records.length, head: prev, lastStep };
}

const pack = (recs) => zlib.gzipSync(Buffer.from(recs.map((r) => JSON.stringify(r)).join('\n')), { level: 9 });
const unpack = (z) => zlib.gunzipSync(z).toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

export class Ledger {
  constructor({ db = null, bucketTicks = 300, flushMs = 300000, ringTicks = 6000, decimals = 4, pendingCap = 36000, onReset = null } = {}) {
    this.db = db;
    this.bucketTicks = bucketTicks;
    this.flushMs = flushMs;
    this.ringTicks = ringTicks;
    this.dp = decimals;
    this.pendingCap = pendingCap;
    this.onReset = onReset;
    this.next = 0;
    this.headHash = GENESIS;
    this.headAt = null;
    this.ring = [];
    this.pending = [];
    this.flushing = null;
    this.lastFlushAt = Date.now();
    this.cache = new Map(); // from -> records, a few decompressed buckets
    this.stored = { buckets: 0, bytes: 0, lastError: null, gaps: 0 };
    this.firstStored = null;
  }

  /** pick the chain up where the database left it */
  async resume() {
    if (!this.db) return this.head();
    let cp = await this.db.lastCheckpoint();
    const b = await this.db.lastBucketHeader();
    if (b && (!cp || b.to > cp.to)) {
      // the bucket landed but its checkpoint did not (crash between the two)
      const fix = { from: b.from, to: b.to, n: b.n, prevHash: b.prevHash, head: b.head, at: b.at };
      await this.db.insertCheckpoint(fix);
      cp = fix;
      say(`repaired the checkpoint for steps ${b.from}..${b.to}`, { kind: 'ledger' });
    }
    if (cp) { this.next = cp.to + 1; this.headHash = cp.head; this.headAt = cp.at; }
    this.firstStored = (await this.db.firstBucketHeader())?.from ?? null;
    return this.head();
  }

  head() { return { step: this.next - 1, hash: this.headHash, at: this.headAt, ticks: this.next }; }

  /** -> the stored record (with step, prevHash, hash). Synchronous. */
  append(tick) {
    const { lit, hash, prevHash, ...rest } = tick || {};
    const body = normalise({ ...rest, pilotStep: rest.step ?? null, step: this.next }, this.dp);
    const h = hashRecord(this.headHash, body);
    const rec = { ...body, prevHash: this.headHash, hash: h };
    this.headHash = h; this.headAt = Date.now(); this.next += 1;
    this.ring.push(rec);
    if (this.ring.length > this.ringTicks) this.ring.splice(0, this.ring.length - this.ringTicks);
    if (this.db) {
      this.pending.push(rec);
      if (this.pending.length > this.pendingCap) {
        // the database has been away for hours: drop the oldest rather than run out of memory
        const drop = this.pending.length - this.pendingCap;
        this.pending.splice(0, drop);
        this.stored.gaps += 1;
        say(`database away too long, ${drop} unstored ticks dropped; the stored chain will show a gap`, { kind: 'ledger' });
      }
      if (this.pending.length >= this.bucketTicks || Date.now() - this.lastFlushAt > this.flushMs) this.flush().catch(() => {});
    }
    return rec;
  }

  async flush() {
    if (!this.db) return null;
    if (this.flushing) return this.flushing;
    this.flushing = (async () => {
      try {
        while (this.pending.length) {
          const recs = this.pending.slice(0, this.bucketTicks);
          const first = recs[0]; const last = recs.at(-1);
          const cp = await this.db.lastCheckpoint();
          const linked = cp ? (cp.to === first.step - 1 && cp.head === first.prevHash) : true;
          if (!linked && !(cp && first.step > cp.to + 1 && this.stored.gaps)) {
            // another instance (a Railway deploy overlap) wrote this stretch first
            return this.rebase(cp, 'the stored chain moved on without us');
          }
          const z = pack(recs);
          const bucket = { from: first.step, to: last.step, n: recs.length, prevHash: first.prevHash, head: last.hash, at: Date.now(), z };
          const r = await this.db.insertBucket(bucket);
          if (r.dup) return this.rebase(await this.db.lastCheckpoint(), `steps from ${first.step} were already stored`);
          await this.db.insertCheckpoint({ from: bucket.from, to: bucket.to, n: bucket.n, prevHash: bucket.prevHash, head: bucket.head, at: bucket.at });
          this.pending.splice(0, recs.length);
          this.stored.buckets += 1; this.stored.bytes += z.length; this.stored.lastError = null;
          if (this.firstStored == null) this.firstStored = bucket.from;
        }
        this.lastFlushAt = Date.now();
        return true;
      } catch (e) {
        this.stored.lastError = e.message;
        this.lastFlushAt = Date.now();
        say(`store failed, kept in memory (${e.message})`, { kind: 'ledger' });
        return false;
      } finally { this.flushing = null; }
    })();
    return this.flushing;
  }

  rebase(cp, why) {
    say(`${why}; continuing from stored step ${cp ? cp.to : -1}`, { kind: 'ledger' });
    this.pending = [];
    this.ring = [];
    this.cache.clear();
    this.next = cp ? cp.to + 1 : 0;
    this.headHash = cp ? cp.head : GENESIS;
    this.headAt = cp ? cp.at : null;
    try { this.onReset?.(this.head()); } catch { /* listener */ }
    return false;
  }

  async bucketRecords(b) {
    if (this.cache.has(b.from)) return this.cache.get(b.from);
    const recs = unpack(b.z);
    this.cache.set(b.from, recs);
    if (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value);
    return recs;
  }

  /** stored records with step > after, oldest first */
  async ticks(after = -1, limit = 200) {
    limit = Math.max(1, Math.min(1000, limit | 0 || 200));
    after = Number.isFinite(+after) ? Math.floor(+after) : -1;
    const out = [];
    const ringStart = this.ring.length ? this.ring[0].step : this.next;
    let cursor = after;
    if (this.db && cursor + 1 < ringStart) {
      while (out.length < limit && cursor + 1 < ringStart) {
        const bs = await this.db.bucketsAfter(cursor, 2);
        if (!bs.length) break;
        let moved = false;
        for (const b of bs) {
          for (const r of await this.bucketRecords(b)) {
            if (r.step > cursor && r.step < ringStart && out.length < limit) { out.push(r); cursor = r.step; moved = true; }
          }
          if (out.length >= limit) break;
          if (b.to > cursor) { cursor = Math.min(b.to, ringStart - 1); moved = true; }
        }
        if (!moved) break;
      }
    }
    for (const r of this.ring) {
      if (out.length >= limit) break;
      if (r.step > cursor) out.push(r);
    }
    return out;
  }

  async tick(step) {
    step = Math.floor(+step);
    if (!Number.isFinite(step) || step < 0) return null;
    const inRing = this.ring.find((r) => r.step === step);
    if (inRing) return inRing;
    if (!this.db) return null;
    const [b] = await this.db.bucketsAfter(step - 1, 1);
    if (!b || b.from > step) return null;
    return (await this.bucketRecords(b)).find((r) => r.step === step) || null;
  }

  async checkpoints(after = -1, limit = 500) {
    if (!this.db) return [];
    return this.db.checkpoints(after, Math.max(1, Math.min(2000, limit | 0 || 500)));
  }

  stats() {
    return {
      head: this.head(),
      inMemory: this.ring.length,
      oldestInMemory: this.ring[0]?.step ?? null,
      pending: this.pending.length,
      firstStored: this.firstStored,
      ...this.stored,
    };
  }

  async close() { await this.flush(); }
}
