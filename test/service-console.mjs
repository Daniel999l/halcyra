/**
 * The console tab against local pages (headless Chrome here; headed under Xvfb
 * in production):
 *   - the mock console (test/mock-console) with the REAL brain: the whole
 *     service plays it, ticks are chained and verified, real tick size measured
 *   - states: playing, frozen -> reload -> playing, ended, login, crashed -> new page
 *   - the login (storageState) saved insert-only, only when it changed, and restored
 */
import http from 'node:http';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ConsoleTab } from '../src/console.js';
import { memDb } from './memdb.mjs';
import { testConfig, getJson, check, finish } from './service-fixtures.mjs';
import { say, recent } from '../src/log.js';

say.quiet = true;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const R = []; const ok = check(R);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
console.log('service-console\n');

// ---- small pages of our own
const PLAY = (freezeAfter) => `<!doctype html><html><body style="margin:0;background:#000">
<canvas id="c" width="1280" height="720" style="width:100vw;height:100vh;display:block"></canvas>
<script>
const c = document.getElementById('c'), g = c.getContext('2d'); const t0 = performance.now();
function f(t) { const s = (t - t0) / 1000;
  if (${freezeAfter} > 0 && s > ${freezeAfter}) return;
  g.fillStyle = 'hsl(' + ((s * 90) % 360) + ',70%,40%)'; g.fillRect(0, 0, 1280, 720);
  g.fillStyle = '#fff'; g.fillRect(100 + (s * 300) % 1000, 300, 80, 80); requestAnimationFrame(f); }
requestAnimationFrame(f);
</script></body></html>`;
const ENDED = `<!doctype html><html><body style="margin:0;background:#000;color:#fff">
<canvas id="c" width="1280" height="720" style="width:100vw;height:100vh;display:block"></canvas><div id="m"></div>
<script>const c=document.getElementById('c'),g=c.getContext('2d');let n=0;(function f(){g.fillStyle='hsl('+(n++%360)+',60%,40%)';g.fillRect(0,0,1280,720);requestAnimationFrame(f)})();
setTimeout(()=>{document.getElementById('m').textContent='Your session has ended';c.remove()},2500);</script></body></html>`;
const LOGIN = `<!doctype html><html><body><form><input name="u"><input type="password" name="p"><button>Sign in</button></form></body></html>`;
const pages = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const body = u.pathname === '/login' ? LOGIN : u.pathname === '/ended' ? ENDED : PLAY(Number(u.searchParams.get('freezeAfter') || 0));
  res.writeHead(200, { 'content-type': 'text/html' }); res.end(body);
});
await new Promise((r) => pages.listen(0, '127.0.0.1', r));
const site = `http://127.0.0.1:${pages.address().port}`;

function makeTab(url, db = memDb(), extra = {}) {
  const cfg = testConfig({
    console: { url, frameMs: 250, shotMs: 500, frozenSec: 5, waitSec: 6 },
    browser: { headless: true, executablePath: CHROME, saveStateMs: 3600000 },
  });
  const log = [];
  const frames = [];
  const tab = new ConsoleTab({
    cfg, db,
    onStatus: (s) => { if (log.at(-1) !== s) log.push(s); },
    onFrame: (b) => frames.push(b.length),
    ...extra,
  });
  return { tab, log, frames, db, cfg };
}
const until = async (f, ms) => { const t = Date.now(); while (Date.now() - t < ms) { if (await f()) return true; await sleep(100); } return false; };

// ---- 1. the real service on the mock console
let mock = null;
try { mock = await (await import('./mock-console/serve.mjs')).serveMock(0); } catch (e) { console.log(`  (no mock console: ${e.message})`); }
if (mock) {
  const { startApp, tryImport } = await import('../src/index.js');
  const modules = { pilot: await tryImport('./gamepilot.js', 'brain'), gamebody: await tryImport('./gamebody.js', 'body'), taste: await tryImport('./taste.js', 'taste') };
  if (!modules.pilot) console.log('  (src/gamepilot.js not loadable: skipping the real-brain run)');
  else {
    const db = memDb();
    const cfg = testConfig({
      console: { url: mock.url, frameMs: 500, frozenSec: 20, waitSec: 20 },
      browser: { headless: true, executablePath: CHROME },
      loop: { stepMs: 200 },
      ledger: { bucketTicks: 50, ringTicks: 100 },
    });
    const app = await startApp({ cfg, db, modules });
    const base = `http://127.0.0.1:${app.port}`;
    const t0 = Date.now();
    const played = await until(() => app.ledger.head().ticks >= 60, 120000);
    const secs = (Date.now() - t0) / 1000;
    const h = (await getJson(base, '/api/health')).body;
    const st = (await getJson(base, '/api/state')).body;
    ok(played, `the real brain played the mock console through the service (${app.ledger.head().ticks} ticks)`, `console ${h.console.state}`);
    ok(st.tick && st.tick.dn && st.tick.pad && Array.isArray(st.tick.pad.axes) && st.tick.lit.length > 0, 'real ticks carry dn, pad and lit');
    const fr = await fetch(`${base}/api/frame.jpg`);
    const jpg = Buffer.from(await fr.arrayBuffer());
    ok(fr.status === 200 && jpg[0] === 0xff && jpg[1] === 0xd8, `/api/frame.jpg serves the tab (${jpg.length} bytes)`);
    const proof = (await getJson(base, '/api/proof')).body;
    ok(proof.taste && proof.taste.sweet.count > 0 && proof.readout && proof.readout.descending, 'proof lists taste cells and readout populations from the loaded modules', `${proof.taste?.sweet.count} sweet, ${proof.taste?.bitter.count} bitter, DN ${proof.readout?.descending?.left}/${proof.readout?.descending?.right}`);
    app.consoleTab.state = 'paused-for-test'; // hold the chain still for the verifier
    await sleep(400);
    await app.ledger.flush();
    const v = await new Promise((resolve) => {
      const p = spawn(process.execPath, ['scripts/verify-chain.mjs', base], { cwd: ROOT });
      let out = ''; p.stdout.on('data', (d) => { out += d; }); p.on('close', (code) => resolve({ code, out }));
    });
    ok(v.code === 0, 'verify-chain passes on real brain ticks', v.out.split('\n').find((l) => l.startsWith('ticks')));
    // real storage cost
    const zBytes = db._raw.ticks.reduce((a, b) => a + b.z.length, 0);
    const nStored = db._raw.ticks.reduce((a, b) => a + b.n, 0);
    const raw = (await app.ledger.ticks(-1, 1000)).reduce((a, r) => a + JSON.stringify(r).length, 0) / app.ledger.head().ticks;
    const per = zBytes / nStored;
    console.log(`\n  real ticks: ${(app.ledger.head().ticks / secs).toFixed(2)} ticks/s here, ${Math.round(raw)} B/tick raw, ${per.toFixed(0)} B/tick gzipped (${nStored} stored)`);
    console.log(`  -> at 5 ticks/s: ${(per * 5 * 86400 / 1048576).toFixed(1)} MB/day of buckets; rss now ${h.memoryMb} MB (brain + Chrome is a separate process)`);
    console.log(`  step timing (pilot.telemetry().perf): ${JSON.stringify(st.fly?.perf)}\n`);
    fs.writeFileSync(path.join(ROOT, 'data', 'real-tick-sample.json'), JSON.stringify({ perTickGz: per, rawPerTick: raw, ticksPerSec: app.ledger.head().ticks / secs, rssMb: h.memoryMb, perf: st.fly?.perf }, null, 1));
    await app.stop();
  }
  await mock.close();
}

// ---- 2. playing -> frozen -> reload -> playing
{
  const { tab, log, frames } = makeTab(`${site}/play?freezeAfter=3`);
  let readies = 0; let losts = 0;
  tab.onReady = async () => { readies += 1; };
  tab.onLost = async () => { losts += 1; };
  tab.start();
  ok(await until(() => tab.state === 'playing', 20000), 'a playing canvas -> "playing"');
  ok(await until(() => frames.length >= 3, 5000), `frames come in while playing (${frames.length})`);
  ok(await until(() => log.includes('frozen'), 15000), 'a picture that stops changing -> "frozen"');
  ok(await until(() => readies >= 2, 20000), 'frozen -> reload -> "playing" again (onReady called again)', log.join(' > '));
  ok(losts >= 1, 'onLost told the loop to stop stepping while it was down');
  await tab.stop();
}

// ---- 3. ended
{
  const { tab, log } = makeTab(`${site}/ended`);
  tab.start();
  ok(await until(() => log.includes('ended'), 20000), 'a page that says the session ended -> "ended"', log.join(' > '));
  await tab.stop();
}

// ---- 4. login
{
  const { tab, log } = makeTab(`${site}/login`);
  tab.start();
  ok(await until(() => tab.state === 'login', 20000), 'a password form -> "login"', log.join(' > '));
  const said = recent(40).some((r) => /npm run login/.test(r.msg));
  ok(said, 'the log says to run "npm run login"');
  await tab.stop();
}

// ---- 5. crash -> new page -> playing
{
  const { tab, log } = makeTab(`${site}/play`);
  let readies = 0; tab.onReady = async () => { readies += 1; };
  tab.start();
  await until(() => tab.state === 'playing', 20000);
  const first = tab.page;
  const cdp = await tab.ctx.newCDPSession(first);
  cdp.send('Page.crash').catch(() => {});
  ok(await until(() => log.includes('crashed'), 10000), 'a crashed page -> "crashed"');
  ok(await until(() => readies >= 2 && tab.state === 'playing', 25000) && tab.page !== first, 'crashed -> a fresh page -> "playing" again', log.join(' > '));
  await tab.stop();
}

// ---- 6. the login state: insert-only, only on change, restored
{
  const db = memDb();
  const { tab } = makeTab(`${site}/play`, db);
  tab.start();
  await until(() => tab.state === 'playing', 20000);
  await tab.ctx.addCookies([{ name: 'sess', value: 'one', url: site }]);
  const r1 = await tab.saveLogin();
  const r2 = await tab.saveLogin();
  await tab.ctx.addCookies([{ name: 'sess', value: 'two', url: site }]);
  const r3 = await tab.saveLogin();
  ok(r1.saved && r1.v === 1 && !r2.saved && r3.saved && r3.v === 2, 'login saved as v1, unchanged -> nothing written, changed -> v2');
  ok(db._raw.sessions.length === 2 && db._raw.sessions[0].state.cookies.find((c) => c.name === 'sess').value === 'one', 'v1 is still there (never overwritten)');
  await tab.stop();
  const again = makeTab(`${site}/play`, db);
  again.tab.start();
  await until(() => again.tab.state === 'playing', 20000);
  const cookies = await again.tab.ctx.cookies(site);
  ok(cookies.find((c) => c.name === 'sess')?.value === 'two', 'a new browser starts with the latest saved login');
  await again.tab.stop();
}

pages.close();
finish(R, 'service-console');
process.exit(process.exitCode || 0);
