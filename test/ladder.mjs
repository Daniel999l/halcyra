/**
 * The game ladder with fake market caps (no network, no browser):
 *   1. stages: defaults, LADDER patches, a full array, bad JSON
 *   2. the unlock rule: 3 reads in a row at or above, spaced, newer slots,
 *      a failed read breaks the run, jumps unlock every stage passed
 *   3. permanence and restart (stored in the in-memory Mongo stand-in; another
 *      coin starts over), ledger records (kind "unlock", readings with slots),
 *      the chain still verifies
 *   4. playing vs unlocked: a native stage is recorded, the game on screen
 *      carries on; a stage without game files is skipped; nothing plays when
 *      the console is not playing
 *   5. the whole service: /api/ladder and /api/state (no-store), SSE "unlock",
 *      the console moves to the new stage, scripts/verify-chain.mjs passes with
 *      unlock records in the chain, /console/* is loopback only, restart keeps
 *      the stage
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Ladder, parseStages, DEFAULT_STAGES } from '../src/ladder.js';
import { Ledger, verify } from '../src/ledger.js';
import { startApp } from '../src/index.js';
import { memDb } from './memdb.mjs';
import { standinPilot, standinTaste, testConfig, getJson, sse, check, finish } from './service-fixtures.mjs';
import { say } from '../src/log.js';

say.quiet = true;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const R = []; const ok = check(R);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
console.log('ladder\n');

const MINT = 'LadderMint1111111111111111111111111111111pump';
const OTHER = 'OtherMint11111111111111111111111111111111pump';

// game files for gta1 and gta2 only (dummy bytes: nothing here runs them)
const gamesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyra-games-'));
for (const id of ['gta1', 'gta2']) { fs.mkdirSync(path.join(gamesDir, id)); fs.writeFileSync(path.join(gamesDir, id, 'bundle.jsdos'), Buffer.from(`PK fake ${id}`)); }

// the rule tests run on four stages (the defaults plus a native GTA IV from the env override)
const FOUR = JSON.stringify([
  { id: 'gta1', game: 'GTA 1', usd: 0, kind: 'browser', url: '/console/dos?b=gta1' },
  { id: 'gta2', game: 'GTA 2', usd: 10000, kind: 'browser', url: '/console/dos?b=gta2' },
  { id: 'gta3', game: 'GTA III', usd: 30000, kind: 'browser', url: '' },
  { id: 'gta4', game: 'GTA IV', usd: 150000, kind: 'native' },
]);

// ---------------------------------------------------------------- 1. stages
{
  const d = parseStages('');
  ok(d.length === 8 && d.map((s) => s.id).join() === 'gta1,gta2,gta3,vc,sa,gta4,gta5,gta6' && d.map((s) => s.usd).join() === '0,30000,100000,300000,1000000,3000000,10000000,30000000' && d.slice(2).every((s) => s.kind === 'native'), 'default stages: GTA 1, GTA 2 at 30k, GTA III at 100k, Vice City at 300k, San Andreas at 1M, GTA IV at 3M, GTA V at 10M, GTA VI at 30M');
  ok(d.slice(0, 2).every((s) => s.kind === 'browser') && d.slice(2).every((s) => s.kind === 'native'), 'GTA 1 and GTA 2 are browser stages, GTA III and later are native stages');
  const p = parseStages('{"gta2":{"usd":20000,"url":"https://example.invalid/gta2"}}');
  ok(p[1].usd === 20000 && p[1].url === 'https://example.invalid/gta2' && p[2].usd === 100000, 'LADDER patch form changes one stage');
  const n = parseStages(FOUR);
  ok(n.length === 4 && n[3].kind === 'native' && n[3].usd === 150000, 'LADDER array form can add a native GTA IV stage');
  const a = parseStages('[{"id":"b","game":"B","usd":500},{"id":"a","game":"A","usd":100,"kind":"browser","url":"/console/dos?b=a"}]');
  ok(a.length === 2 && a[0].id === 'a' && a[0].usd === 0 && a[1].index === 1, 'LADDER array form: sorted by threshold, the first starts at 0');
  ok(parseStages('{nope').length === DEFAULT_STAGES.length, 'bad LADDER JSON falls back to the defaults');
}

// ---------------------------------------------------------------- 2. the rule
const mkCfg = (over = {}) => ({ root: ROOT, gamesDir, tokenCa: MINT, port: 9999, ladder: { stages: FOUR, pollMs: 20000, reads: 3 }, ...over });
const fake = (mcapUsd, at, slot) => ({ ok: true, at, slot, mcapUsd, venue: 'curve', priceSol: mcapUsd / 1e9 / 150, solUsd: 150, supplyRaw: '1000000000000000', inputs: { curve: 'x', virtualSolReserves: '30000000000', virtualTokenReserves: '1073000000000000' }, oracle: { account: 'pyth', price: 150, publishTime: Math.floor(at / 1000), postedSlot: slot - 2 } });

const db = memDb();
const ledger = new Ledger({ db: null, ringTicks: 1000 });
ledger.append({ step: 1, t: 1, taste: { sweet: 0, bitter: 0, applied: [] } }); // a tick before, like the real loop
const moves = [];
let L = new Ladder({ cfg: mkCfg(), db, ledger, onTarget: async (s) => { moves.push(s.id); } });
await L.load();
L.setMode('ladder');
await L.follow();
L.setConsole('playing');
ok(L.unlocked.id === 'gta1' && L.target?.id === 'gta1' && moves.join() === 'gta1', 'starts on GTA 1 and the console is sent there');

let t = 1_000_000; let slot = 5000;
const step = async (usd, { dt = 20000, ds = 50, ok: good = true } = {}) => { t += dt; slot += ds; return L.observe(good ? fake(usd, t, slot) : { ok: false, why: 'rpc down', at: t }); };

let u = [];
u.push(...await step(12000)); u.push(...await step(12000)); u.push(...await step(9000));
ok(u.length === 0 && L.unlocked.id === 'gta1', '12k, 12k, 9k: no unlock');
u.push(...await step(12000)); u.push(...await step(12000));
ok(u.length === 0, '12k, 12k after the dip: only two in a row, no unlock');
u.push(...await step(12000, { dt: 5000 }));
ok(u.length === 0 && L.json().next.readsInARow === 2, 'a read only 5 s after the last does not count');
u.push(...await step(12000, { ds: -200 }));
ok(u.length === 0, 'a read at an older slot does not count');
u.push(...await step(0, { ok: false }));
ok(L.run.length === 0 && L.json().marketCap.why === 'rpc down', 'a failed read breaks the run and is shown with its reason');
u.push(...await step(10000)); u.push(...await step(10500));
ok(u.length === 0, 'two good reads after the failure: not yet');
u.push(...await step(10000));
ok(u.length === 1 && u[0].stage.id === 'gta2' && L.unlocked.id === 'gta2', 'exactly at the threshold on the third read in a row: GTA 2 unlocks');
ok(L.target?.id === 'gta2' && moves.join() === 'gta1,gta2', 'the console is moved to GTA 2');
const rec2 = u[0].record;
ok(rec2 && rec2.kind === 'unlock' && rec2.stage.id === 'gta2' && rec2.stage.usd === 10000 && rec2.readings.length === 3 && rec2.readings.every((x) => Number.isInteger(x.slot) && x.mcapUsd >= 10000), 'ledger record: kind unlock, stage, threshold, the three readings with their slots');
ok(rec2.readings[0].inputs.virtualSolReserves === '30000000000' && rec2.readings[0].supplyRaw === '1000000000000000', 'the record keeps the raw on-chain inputs as strings, so the market cap can be recomputed');

for (let i = 0; i < 5; i += 1) u.push(...await step(3000));
ok(L.unlocked.id === 'gta2', 'market cap falls to 3k: still GTA 2 (never goes back)');

u = [];
u.push(...await step(45000)); u.push(...await step(200000)); u.push(...await step(41000));
ok(u.length === 1 && u[0].stage.id === 'gta3' && L.unlocked.id === 'gta3', '45k, 200k, 41k: GTA III unlocks (not GTA IV: one read was under 150k)');
ok(L.target?.id === 'gta2' && L.playing()?.id === 'gta2' && /no in-tab player/.test(L.json().waiting), 'GTA III has no player here: GTA 2 keeps playing, playing = GTA 2, unlocked = GTA III, and it says why');

u = [];
u.push(...await step(160000)); u.push(...await step(170000)); u.push(...await step(180000));
ok(u.length === 1 && u[0].stage.id === 'gta4' && L.unlocked.id === 'gta4', 'three reads over 150k: GTA IV unlocked');
const j = L.json();
ok(j.playing?.game === 'GTA 2' && j.unlocked.game === 'GTA IV' && /Windows machine/.test(j.waiting), 'GTA IV is native: recorded as unlocked, the browser keeps playing GTA 2 and says so');
L.setConsole('loading');
ok(L.playing() === null && L.json().playing === null, 'console not playing: playing is null (never claims a game)');
L.setConsole('playing');

const v = verify(ledger.ring, { prevHash: '0'.repeat(64) });
ok(v.ok && ledger.ring.filter((r) => r.kind === 'unlock').length === 3, `the ledger with 3 unlock records verifies (${v.n} records)`);
ok(db._raw.ladder.length === 3 && db._raw.ladder.every((d) => d.mint === MINT && Number.isInteger(d.ledgerStep) && /^[0-9a-f]{64}$/.test(d.ledgerHash)), 'halcyra_ladder holds the 3 unlocks with their ledger step and hash');
ok((await db.insertLadderUnlock({ ...db._raw.ladder[0] })).dup === true, 'halcyra_ladder is unique on coin + stage (insert-only)');

// one jump over two stages writes two records
{
  const lg = new Ledger({ ringTicks: 100 });
  const L2 = new Ladder({ cfg: mkCfg({ tokenCa: 'JumpMint' }), db: memDb(), ledger: lg });
  let tt = 0; let sl = 1;
  for (const m of [40000, 40000, 40000]) { tt += 20000; sl += 1; await L2.observe(fake(m, tt, sl)); }
  ok(L2.unlocked.id === 'gta3' && lg.ring.filter((r) => r.kind === 'unlock').map((r) => r.stage.id).join() === 'gta2,gta3', 'a jump to 40k unlocks GTA 2 and GTA III, one record each');
}

// restart
{
  const L3 = new Ladder({ cfg: mkCfg(), db, ledger: new Ledger() });
  await L3.load();
  ok(L3.unlocked.id === 'gta4', 'restart: the highest unlocked stage comes back from the store');
  L3.setMode('ladder'); await L3.follow();
  ok(L3.target?.id === 'gta2', 'restart: the console goes straight to the best stage it can play (GTA 2)');
  const L4 = new Ladder({ cfg: mkCfg({ tokenCa: OTHER }), db, ledger: new Ledger() });
  await L4.load();
  ok(L4.unlocked.id === 'gta1', 'another coin address starts at GTA 1');
  const L5 = new Ladder({ cfg: mkCfg({ tokenCa: '' }), db, ledger: new Ledger() });
  await L5.load();
  ok(L5.unlocked.id === 'gta1' && L5.json().marketCap.usd === null && /TOKEN_CA is not set/.test(L5.json().marketCap.why), 'no coin address: market cap unknown, stays on GTA 1');
}

// ---------------------------------------------------------------- 5. the whole service
const verifyAgainst = (url) => new Promise((resolve) => {
  const p = spawn(process.execPath, ['scripts/verify-chain.mjs', url], { cwd: ROOT });
  let out = ''; p.stdout.on('data', (d) => { out += d; }); p.stderr.on('data', (d) => { out += d; });
  p.on('close', (code) => resolve({ code, out }));
});

function recordingConsoleFactory(log) {
  return async (o) => {
    const c = {
      playing: false, url: o.url, goes: [],
      start() { log.push(['open', o.url]); this.playing = true; o.onStatus('playing', ''); o.onReady({ fake: true }).catch(() => {}); return this; },
      goTo(url) { log.push(['goTo', url]); this.url = url; o.onStatus('loading', 'moving'); setTimeout(() => { o.onStatus('playing', ''); o.onReady({ fake: true }).catch(() => {}); }, 50); },
      async stop() { this.playing = false; },
    };
    return c;
  };
}

// a market cap that climbs; one read per call
const script = [2000, 9000, 35000, 35000, 35000, 35000];
let calls = 0; let slotS = 9000;
const read = async () => { const m = script[Math.min(calls, script.length - 1)]; calls += 1; slotS += 40; return fake(m, Date.now(), slotS); };

const sdb = memDb();
const clog = [];
const cfg = testConfig({ tokenCa: MINT, gamesDir, loop: { stepMs: 20 }, ledger: { bucketTicks: 20, ringTicks: 2000, flushMs: 1000 }, ladder: { pollMs: 1000 } });
const app = await startApp({ cfg, db: sdb, modules: { pilot: standinPilot, taste: standinTaste }, consoleFactory: recordingConsoleFactory(clog), ladderRead: read });
const base = `http://127.0.0.1:${app.port}`;
const live = await sse(`${base}/api/live`);
ok(clog[0]?.[0] === 'open' && clog[0][1] === `http://127.0.0.1:${app.port}/console/dos?b=gta1`, 'no CONSOLE_URL: the console opens on our own GTA 1 page (game files present)');
let lad = await getJson(base, '/api/ladder');
ok(lad.status === 200 && lad.headers.get('cache-control') === 'no-store' && lad.body.stages.length === 8 && lad.body.unlocked.id === 'gta1', '/api/ladder: 200, no-store, 8 default stages, unlocked GTA 1');
const t0 = Date.now();
while (Date.now() - t0 < 15000 && app.ladder.unlocked.id !== 'gta2') await sleep(100);
await sleep(300);
lad = await getJson(base, '/api/ladder');
ok(lad.body.unlocked.id === 'gta2' && lad.body.playing?.id === 'gta2' && lad.body.playing.game === 'GTA 2', `market cap 15k on 3 reads: GTA 2 unlocked and playing (${calls} reads)`);
ok(clog.some(([k, url]) => k === 'goTo' && url.endsWith('/console/dos?b=gta2')), 'the console tab was moved to the GTA 2 page');
ok(lad.body.marketCap.usd === 35000 && Number.isInteger(lad.body.marketCap.slot) && lad.body.marketCap.inputs && lad.body.marketCap.oracle, '/api/ladder shows the latest market cap with its slot, inputs and oracle reading');
const st = await getJson(base, '/api/state');
ok(st.body.ladder?.unlocked.id === 'gta2' && st.body.game === 'GTA 2' && st.headers.get('cache-control') === 'no-store', '/api/state carries the ladder and game = the game really playing');
ok(live.events.some((e) => e.event === 'unlock' && e.data.stage.id === 'gta2' && Number.isInteger(e.data.step)), 'SSE sends an "unlock" event');
const ticks = [];
for (let after = -1; ;) { const pg = (await getJson(base, `/api/ticks?after=${after}&limit=1000`)).body; if (!pg.ticks.length) break; ticks.push(...pg.ticks); after = pg.ticks.at(-1).step; if (after >= pg.head.step) break; }
ok(ticks.some((x) => x.kind === 'unlock' && x.stage.id === 'gta2') && ticks.some((x) => x.kind !== 'unlock'), 'the unlock record sits in the same chain as her ticks');
await app.ledger.flush();
const vr = await verifyAgainst(base);
ok(vr.code === 0 && /OK: the chain holds/.test(vr.out), 'scripts/verify-chain.mjs passes with an unlock record in the chain', vr.out.split('\n').filter(Boolean).slice(-2).join(' | '));

// /console is loopback only
const bundle = await fetch(`${base}/console/dos/bundle/gta2`);
ok(bundle.status === 200 && (await bundle.text()) === 'PK fake gta2', 'the game bundle is served to a loopback request');
const viaProxy = await new Promise((resolve) => {
  http.get(`${base}/console/dos/bundle/gta2`, { headers: { 'x-forwarded-for': '203.0.113.9' } }, (res) => { res.resume(); resolve(res.statusCode); });
});
const pageViaProxy = await new Promise((resolve) => {
  http.get(`${base}/console/dos?b=gta2`, { headers: { 'x-forwarded-for': '203.0.113.9' } }, (res) => { res.resume(); resolve(res.statusCode); });
});
ok(viaProxy === 404 && pageViaProxy === 404, 'a proxied request (a site visitor) gets 404 for the bundle and the page');
const ifaces = Object.values(os.networkInterfaces()).flat().filter((i) => i && i.family === 'IPv4' && !i.internal);
if (ifaces.length) {
  const code = await new Promise((resolve) => {
    const rq = http.get({ host: ifaces[0].address, port: app.port, path: '/console/dos/bundle/gta2' }, (res) => { res.resume(); resolve(res.statusCode); });
    rq.on('error', () => resolve('error'));
  });
  ok(code === 404, `a request from a non-loopback address (${ifaces[0].address}) gets 404`);
}
const emu = await fetch(`${base}/console/dos/emu/wdosbox.wasm`);
ok(emu.status === 200 && emu.headers.get('content-type') === 'application/wasm', 'the emulator engine is served locally (no CDN), wasm type');

live.close();
await app.stop();

// restart: the stage stays, the console opens at GTA 2 directly
const clog2 = [];
const cfg2 = testConfig({ tokenCa: MINT, gamesDir, loop: { stepMs: 20 }, ladder: { pollMs: 1000 } });
const app2 = await startApp({ cfg: cfg2, db: sdb, modules: { pilot: standinPilot, taste: standinTaste }, consoleFactory: recordingConsoleFactory(clog2), ladderRead: async () => fake(100, Date.now(), (slotS += 40)) });
await sleep(200);
const lad2 = (await getJson(`http://127.0.0.1:${app2.port}`, '/api/ladder')).body;
ok(lad2.unlocked.id === 'gta2' && clog2[0]?.[1]?.endsWith('/console/dos?b=gta2') && lad2.playing?.id === 'gta2', 'restart with the market cap at $100: still GTA 2, the console opens there');
await app2.stop();

// fixed CONSOLE_URL: the ladder records, the tab stays
const clog3 = [];
const cfg3 = testConfig({ tokenCa: MINT, gamesDir, console: { url: 'http://mock.invalid/' }, game: 'Mock', ladder: { pollMs: 1000 } });
const app3 = await startApp({ cfg: cfg3, db: memDb(), modules: { pilot: standinPilot, taste: standinTaste }, consoleFactory: recordingConsoleFactory(clog3), ladderRead: async () => fake(120000, Date.now(), (slotS += 40)) });
const t3 = Date.now();
while (Date.now() - t3 < 8000 && app3.ladder.unlocked.id === 'gta1') await sleep(100);
const lad3 = (await getJson(`http://127.0.0.1:${app3.port}`, '/api/ladder')).body;
ok(lad3.unlocked.id === 'gta3' && lad3.playing?.game === 'Mock' && lad3.playing.id === null && !clog3.some(([k]) => k === 'goTo'), 'CONSOLE_URL set: unlocks are recorded, the fixed page keeps playing and is reported as itself');
await app3.stop();

fs.rmSync(gamesDir, { recursive: true, force: true });
finish(R, 'ladder');
process.exit(process.exitCode || 0);
