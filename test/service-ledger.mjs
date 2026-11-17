/**
 * The proof ledger: append, verify, tamper detection, resume after restart,
 * crash repair, two instances at once, and what it costs to store.
 */
import zlib from 'node:zlib';
import { Ledger, verify, canonicalJSON, hashRecord, GENESIS, normalise } from '../src/ledger.js';
import { memDb } from './memdb.mjs';
import { fakeTick, check, finish } from './service-fixtures.mjs';
import { say } from '../src/log.js';

say.quiet = true;
const R = []; const ok = check(R);
console.log('service-ledger\n');

// canonical form
ok(canonicalJSON({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: 2 } }) === '{"a":{"c":2,"d":[1,{"y":2,"z":1}]},"b":1}', 'canonical JSON sorts keys at every level');
ok(canonicalJSON({ a: 1, b: undefined }) === canonicalJSON({ a: 1 }), 'undefined fields are dropped');
ok(JSON.stringify(normalise({ x: 0.123456789, n: 3, z: NaN, neg: -0.000001 })) === '{"x":0.1235,"n":3,"z":null,"neg":0}', 'numbers rounded to 4 dp, NaN -> null, -0 -> 0');

// append + verify in memory
const L0 = new Ledger();
const recs0 = [];
for (let i = 1; i <= 500; i += 1) recs0.push(L0.append(fakeTick(i)));
ok(recs0[0].prevHash === GENESIS && recs0[0].step === 0, 'first record links to genesis at step 0');
ok(recs0[499].step === 499 && recs0[499].pilotStep === 500, 'ledger keeps its own step; pilot step kept as pilotStep');
ok(!('lit' in recs0[10]), 'lit is not stored');
const v0 = verify(recs0);
ok(v0.ok && v0.n === 500 && v0.head === L0.head().hash, 'verify recomputes 500 records to the head');
const withLit = { ...recs0[5], lit: [[1, 0.9]] };
ok(hashRecord(recs0[5].prevHash, withLit) === recs0[5].hash, 'changing lit does not change the hash');
const tampered = recs0.map((r) => ({ ...r }));
tampered[250] = { ...tampered[250], dn: { ...tampered[250].dn, L: 0.9999 } };
const vt = verify(tampered);
ok(!vt.ok && vt.badAt === 250, 'a changed value is caught at its step', vt.reason);
const swapped = recs0.slice(); [swapped[100], swapped[101]] = [swapped[101], swapped[100]];
ok(!verify(swapped).ok, 'reordered records are caught');
const dropped = recs0.slice(0, 200).concat(recs0.slice(201));
ok(!verify(dropped).ok, 'a removed record is caught');

// with a store
const db = memDb();
const L1 = new Ledger({ db, bucketTicks: 100, ringTicks: 100 });
await L1.resume();
for (let i = 1; i <= 1050; i += 1) L1.append(fakeTick(i));
await L1.flush();
ok(db._raw.ticks.length === 11 && db._raw.cps.length === 11, 'stored as 11 buckets (100 each + 50) with 11 checkpoints', `${db._raw.ticks.length} buckets`);
ok(L1.pending.length === 0, 'nothing left pending after flush');
const all = [];
for (let after = -1; ;) { const page = await L1.ticks(after, 137); if (!page.length) break; all.push(...page); after = page.at(-1).step; }
ok(all.length === 1050 && all[0].step === 0 && all.at(-1).step === 1049, 'paging ticks() returns all 1050 from store + ring', `${all.length}`);
ok(verify(all).ok, 'the stored chain verifies end to end');
const one = await L1.tick(42);
ok(one && one.step === 42 && one.hash === all[42].hash, 'tick(42) is served from a stored bucket');

// tamper inside a stored bucket
const b3 = db._raw.ticks.find((b) => b.from === 300);
const lines = zlib.gunzipSync(b3.z).toString().split('\n').map((l) => JSON.parse(l));
lines[7].active += 1;
b3.z = zlib.gzipSync(Buffer.from(lines.map((l) => JSON.stringify(l)).join('\n')));
L1.cache.clear();
const all2 = [];
for (let after = -1; ;) { const page = await L1.ticks(after, 500); if (!page.length) break; all2.push(...page); after = page.at(-1).step; }
const vt2 = verify(all2);
ok(!vt2.ok && vt2.badAt === 307, 'an edit inside a stored bucket is caught at step 307', vt2.reason);

// resume after restart
const db2 = memDb();
const A = new Ledger({ db: db2, bucketTicks: 50, ringTicks: 100 });
await A.resume();
for (let i = 1; i <= 120; i += 1) A.append(fakeTick(i));
await A.close();
const headA = A.head();
const B = new Ledger({ db: db2, bucketTicks: 50, ringTicks: 100 });
const hb = await B.resume();
ok(hb.step === headA.step && hb.hash === headA.hash, 'a new process resumes at the stored head', `step ${hb.step}`);
for (let i = 1; i <= 80; i += 1) B.append(fakeTick(i));
await B.close();
const chain = [];
for (let after = -1; ;) { const page = await B.ticks(after, 1000); if (!page.length) break; chain.push(...page); after = page.at(-1).step; }
ok(chain.length === 200 && verify(chain).ok, 'the chain runs on across the restart (200 records verify)');

// crash between bucket and checkpoint
const db3 = memDb();
const C = new Ledger({ db: db3, bucketTicks: 50 });
for (let i = 1; i <= 100; i += 1) C.append(fakeTick(i));
await C.flush();
db3._raw.cps.pop(); // the last checkpoint never landed
const D = new Ledger({ db: db3, bucketTicks: 50 });
const hd = await D.resume();
ok(hd.step === 99 && db3._raw.cps.length === 2, 'a missing checkpoint is repaired from its bucket on resume');

// two instances at once (a deploy overlap)
const db4 = memDb();
const E = new Ledger({ db: db4, bucketTicks: 50 }); await E.resume();
const F = new Ledger({ db: db4, bucketTicks: 50 }); await F.resume();
let resets = 0; F.onReset = () => { resets += 1; };
for (let i = 1; i <= 50; i += 1) E.append(fakeTick(i));
await E.flush();
for (let i = 1; i <= 50; i += 1) F.append(fakeTick(1000 + i));
await F.flush();
ok(resets === 1 && F.head().step === 49 && F.head().hash === E.head().hash, 'the second writer rebases onto the stored chain instead of forking it');
for (let i = 1; i <= 50; i += 1) F.append(fakeTick(i));
await F.flush();
const both = [];
for (let after = -1; ;) { const page = await F.ticks(after, 1000); if (!page.length) break; both.push(...page); after = page.at(-1).step; }
ok(both.length === 100 && verify(both).ok, 'after the rebase the stored chain is one chain (100 records verify)');

// storage cost
const db5 = memDb();
const S = new Ledger({ db: db5, bucketTicks: 300 });
for (let i = 1; i <= 3000; i += 1) {
  const taste = i % 40 === 0 ? { sweet: 0.4, bitter: 0, applied: [{ sig: '5'.repeat(88), side: 'buy', sol: 0.5, wallet: 'W'.repeat(44), level: 0.42 }] } : { sweet: 0.1, bitter: 0.02, applied: [] };
  S.append(fakeTick(i, taste));
}
await S.flush();
const zBytes = db5._raw.ticks.reduce((a, b) => a + b.z.length, 0);
const rawBytes = S.ring.slice(-3000).reduce((a, r) => a + JSON.stringify(r).length, 0);
const perTick = zBytes / 3000;
const perDay = (perTick * 5 * 86400) / 1048576;
const cpPerDay = (5 * 86400 / 300) * 220 / 1048576;
console.log(`\n  storage (stand-in ticks): ${Math.round(rawBytes / 3000)} B/tick raw JSON, ${perTick.toFixed(1)} B/tick gzipped in buckets`);
console.log(`  at 5 ticks/s: ${perDay.toFixed(1)} MB/day of buckets, checkpoints ~${cpPerDay.toFixed(2)} MB/day`);
ok(perTick < rawBytes / 3000 / 2, 'buckets are at least 2x smaller than raw JSON');

finish(R, 'service-ledger');
