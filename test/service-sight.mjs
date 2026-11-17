/**
 * A flat screen (a menu, a loading screen) gives her nothing to see. The
 * service must say so instead of looking broken, and must not invent input.
 *
 *   node test/service-sight.mjs
 *
 * The real service (startApp, real brain in its worker, real taste module, the
 * real console tab in headless Chrome) on two local pages:
 *   flat  a canvas of one grey that keeps redrawing (one pixel flickers by one
 *         grey level, so the console's freeze check sees a live picture)
 *   busy  a moving pattern
 * Checks: on flat the ticks keep coming, console "playing", view "nothing to
 * see", descending L and R exactly 0, the pad at rest; on busy, view "seeing".
 */
import http from 'node:http';
import { memDb } from './memdb.mjs';
import { testConfig, getJson, check, finish } from './service-fixtures.mjs';
import { say } from '../src/log.js';

say.quiet = true;
const R = []; const ok = check(R);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
console.log('service-sight\n');

const FLAT = `<!doctype html><html><body style="margin:0;background:#000">
<canvas id="c" width="1280" height="720" style="width:100vw;height:100vh;display:block"></canvas>
<script>const c=document.getElementById('c'),g=c.getContext('2d');let n=0;
(function f(){g.fillStyle='#808080';g.fillRect(0,0,1280,720);g.fillStyle=(n++%2)?'#818181':'#808080';g.fillRect(0,0,1,1);requestAnimationFrame(f)})();</script></body></html>`;
const BUSY = `<!doctype html><html><body style="margin:0;background:#000">
<canvas id="c" width="1280" height="720" style="width:100vw;height:100vh;display:block"></canvas>
<script>const c=document.getElementById('c'),g=c.getContext('2d');const t0=performance.now();
(function f(t){const s=(t-t0)/1000;g.fillStyle='#ddd';g.fillRect(0,0,1280,720);g.fillStyle='#222';
for(let i=0;i<12;i++){g.fillRect(((i*140+s*200)%1400)-100,200+(i%3)*120,70,70);}requestAnimationFrame(f)})(performance.now());</script></body></html>`;
const pages = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(req.url.startsWith('/flat') ? FLAT : BUSY); });
await new Promise((r) => pages.listen(0, '127.0.0.1', r));
const site = `http://127.0.0.1:${pages.address().port}`;

const { startApp, tryImport } = await import('../src/index.js');
const modules = { pilot: await tryImport('./gamepilot.js', 'brain'), gamebody: await tryImport('./gamebody.js', 'body'), taste: await tryImport('./taste.js', 'taste') };

async function run(path, n) {
  const cfg = testConfig({
    console: { url: site + path, frameMs: 500, frozenSec: 20, waitSec: 20 },
    browser: { headless: true, executablePath: CHROME },
    loop: { stepMs: 200, brainMs: 80 },
  });
  const app = await startApp({ cfg, db: memDb(), modules });
  const base = `http://127.0.0.1:${app.port}`;
  const t0 = Date.now();
  while (app.ledger.head().ticks < n && Date.now() - t0 < 120000) await sleep(200);
  const st = (await getJson(base, '/api/state')).body;
  const ticks = (await getJson(base, `/api/ticks?after=${Math.max(-1, app.ledger.head().step - 6)}&limit=6`)).body.ticks;
  await app.stop();
  return { st, ticks };
}

const flat = await run('/flat', 12);
const last = flat.ticks.slice(-5);
ok(flat.st.head.ticks >= 12, `flat screen: the loop keeps ticking (${flat.st.head.ticks} ticks)`);
ok(flat.st.console.state === 'playing', `flat screen: console is "${flat.st.console.state}"`);
ok(flat.st.view.state === 'nothing to see', `flat screen: view says "${flat.st.view.state}" (lamina contrast ${flat.st.view.lamina}, picture spread ${flat.st.view.contrast})`, flat.st.view.detail);
ok(last.every((t) => t.dn.L === 0 && t.dn.R === 0), `flat screen: descending L and R exactly 0 on the last ${last.length} ticks`);
ok(last.every((t) => t.pad.axes.every((v) => v === 0) && Object.values(t.pad.buttons).every((v) => v === 0)), 'flat screen: the pad rests at zero (nothing is made up)');
const busy = await run('/busy', 12);
ok(busy.st.view.state === 'seeing', `moving picture: view says "${busy.st.view.state}" (lamina contrast ${busy.st.view.lamina})`);
ok(busy.ticks.slice(-5).some((t) => t.dn.L > 0 || t.dn.R > 0), 'moving picture: her descending cells are active');
pages.close();
finish(R, 'service-sight');
process.exit(process.exitCode || 0);
