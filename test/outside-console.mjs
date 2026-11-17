/**
 * Stage 1 against an OUTSIDE page (not our /console/dos): a stand-in site on
 * another origin (test/outside-page/) runs a DOS program in a js-dos canvas
 * behind a "Play" button and reads real key events, like a js-dos player does.
 *
 * The real service (startApp) with the real ConsoleTab in headless Chrome,
 * configured only through config values (the env names in brackets):
 *   console.url            (CONSOLE_URL)             the outside page
 *   console.startSelector  (CONSOLE_START_SELECTOR)  "#play"
 *   console.startKeys      (CONSOLE_START_KEYS)      "wait:300,KeyM"
 *   console.canvasSelector (CONSOLE_CANVAS_SELECTOR) "#game"
 *   console.keys           (CONSOLE_KEYS)            "gta1"
 * A stand-in pilot gives fixed pads, so the effect of each one is known:
 *   gas full        -> ArrowUp held,             the square goes up
 *   steer +0.3      -> ArrowRight 30% of 100 ms, the square goes right, slower
 *   Y               -> Enter held
 * Checks the start control was clicked, the start key arrived, focus is on the
 * canvas, the keys are trusted events, the duty cycle, the movement, and that
 * her real eye reads the canvas ('frame' path) with contrast.
 * Also: the same page through the LADDER (stage 1 url = the outside page,
 * no CONSOLE_URL) picks the gta1 key table by itself.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startApp } from '../src/index.js';
import { makeBundle } from '../scripts/make-bundle.mjs';
import { Eye } from '../src/eye.js';
import { gridStats } from '../src/gamepilot.js';
import { memDb } from './memdb.mjs';
import { fakeTick, standinTaste, testConfig, check, finish } from './service-fixtures.mjs';
import { say } from '../src/log.js';

say.quiet = !process.argv.includes('--verbose');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const R = []; const ok = check(R);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
console.log('outside-console\n');

// the outside site: its own port (another origin), its own copy of the engine and the test program
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyra-outside-'));
const b = makeBundle({ src: path.join(ROOT, 'test', 'dos-prog'), id: 'outside', exe: 'MOVE.COM', out: tmp });
const EMU = path.join(ROOT, 'node_modules', 'emulators', 'dist');
const site = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x').pathname;
  let f = null; let type = 'text/html';
  if (u === '/' || u === '/index.html') f = path.join(ROOT, 'test', 'outside-page', 'index.html');
  else if (u === '/bundle.jsdos') { f = b.file; type = 'application/zip'; } else if (/^\/emu\/[a-z0-9.-]+$/i.test(u)) { f = path.join(EMU, u.slice(5)); type = u.endsWith('.wasm') ? 'application/wasm' : 'text/javascript'; }
  if (!f || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': type }); fs.createReadStream(f).pipe(res);
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const SITE = `http://127.0.0.1:${site.address().port}/`;

// a pilot whose pad is set by the test
let PAD = { axes: [0, 0, 0, 0], buttons: {} };
const pilot = {
  async loadFly() { return { N: 139255, E: 2700513 }; },
  flyNames() { return []; },
  GamePilot: class {
    constructor() { this.n = 0; }
    async attach() { return this; }
    async detach() {}
    async step() { this.n += 1; const t = fakeTick(this.n); t.pad = JSON.parse(JSON.stringify(PAD)); return t; }
    telemetry() { return { step: this.n }; }
  },
};
const B = (o) => ({ a: 0, b: 0, x: 0, y: 0, lb: 0, rb: 0, lt: 0, rt: 0, back: 0, start: 0, ls: 0, rs: 0, up: 0, down: 0, left: 0, right: 0, home: 0, ...o });

const SQUARE_JS = `(() => {
  const c = document.querySelector('#game'); const g = c.getContext('2d'); const d = g.getImageData(0, 0, c.width, c.height).data;
  let n = 0, sx = 0, sy = 0;
  for (let y = 0; y < c.height; y += 1) for (let x = 0; x < c.width; x += 1) { const i = (y * c.width + x) * 4; if (d[i] > 200 && d[i + 1] > 200 && d[i + 2] < 120) { n += 1; sx += x; sy += y; } }
  return n ? { x: sx / n / (c.width / 320), y: sy / n / (c.height / 200), n } : null;
})()`;
const duty = (log, code, from, to) => {
  let held = 0; let down = null; let state = false;
  for (const e of log) {
    if (e.code !== code) continue;
    if (e.t < from) { state = e.down; continue; }
    if (e.t > to) break;
    if (e.down && !state) down = e.t; if (!e.down && state) held += e.t - (down ?? from);
    state = e.down; if (!e.down) down = null;
  }
  if (state) held += to - (down ?? from);
  return held / (to - from);
};

async function run({ ladderMode }) {
  const browser = { headless: true, flavour: 'playwright', executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', width: 1280, height: 720, extraArgs: [] };
  const consoleCfg = { startSelector: '#play', startKeys: 'wait:300,KeyM', canvasSelector: '#game', waitSec: 40, frozenSec: 60 };
  const cfg = ladderMode
    ? testConfig({ browser, console: { ...consoleCfg, url: '', keys: '' }, ladder: { stages: JSON.stringify({ gta1: { url: SITE } }), pollMs: 5000 }, loop: { stepMs: 100 } })
    : testConfig({ browser, console: { ...consoleCfg, url: SITE, keys: 'gta1' }, loop: { stepMs: 100 } });
  const app = await startApp({ cfg, db: memDb(), modules: { pilot, taste: standinTaste } });
  const t0 = Date.now();
  while (Date.now() - t0 < 60000 && !(app.consoleTab?.playing && app.keyer)) await sleep(200);
  return app;
}

// ---------------------------------------------------------------- fixed CONSOLE_URL + CONSOLE_KEYS=gta1
let app = await run({ ladderMode: false });
const page = app.consoleTab?.page;
ok(app.consoleTab?.playing === true, `the console reached "playing" on the outside page (state ${app.consoleTab?.state})`);
ok(Boolean(app.keyer) && app.keyer.map.gas === 'ArrowUp', 'CONSOLE_KEYS=gta1: the keyer is on with the GTA 1 table');
if (page && app.keyer) {
  await page.waitForFunction('window.__frames > 0', null, { timeout: 30000 }).catch(() => {});
  ok(await page.evaluate('!document.querySelector("#play") && window.__frames > 0'), 'the "Play" control was clicked (CONSOLE_START_SELECTOR) and the game draws frames');
  await sleep(700);
  const log0 = await page.evaluate('window.__log');
  ok(log0.some((e) => e.code === 'KeyM' && e.down && e.trusted), 'CONSOLE_START_KEYS: the start key arrived as a trusted key event');
  ok(await page.evaluate('document.activeElement === document.querySelector("#game")'), 'keyboard focus is on the game canvas (CONSOLE_CANVAS_SELECTOR)');

  const p0 = await page.evaluate(SQUARE_JS);
  PAD = { axes: [0, -1, 0, 0], buttons: B({ rt: 1 }) };
  await sleep(1200);
  const p1 = await page.evaluate(SQUARE_JS);
  PAD = { axes: [0, 0, 0, 0], buttons: B({}) };
  await sleep(400);
  ok(p0 && p1 && p0.y - p1.y > 30 && Math.abs(p1.x - p0.x) < 3, `gas full: the square went up ${p0 && p1 ? (p0.y - p1.y).toFixed(0) : '?'} px, not sideways`);

  // a small steer is a short tap: 30% duty
  const pA = await page.evaluate(SQUARE_JS);
  const tA = await page.evaluate('performance.now()');
  PAD = { axes: [0.3, 0, 0, 0], buttons: B({}) };
  await sleep(2000);
  const tB = await page.evaluate('performance.now()');
  const pB = await page.evaluate(SQUARE_JS);
  PAD = { axes: [0, 0, 0, 0], buttons: B({}) };
  await sleep(300);
  const log1 = await page.evaluate('window.__log');
  const dR = duty(log1, 'ArrowRight', tA + 300, tB - 100);
  const taps = log1.filter((e) => e.code === 'ArrowRight' && e.down && e.t > tA && e.t < tB).length;
  ok(dR > 0.2 && dR < 0.42, `steer +0.3: ArrowRight held ${(dR * 100).toFixed(0)}% of the time (pulse width over 100 ms)`);
  ok(taps >= 12 && taps <= 24, `steer +0.3: ${taps} short taps in 2 s (one per 100 ms period)`);
  ok(log1.filter((e) => e.t > tA).every((e) => e.trusted), 'every key the page saw is a trusted event');
  const moved = pA && pB ? pB.x - pA.x : 0;
  ok(moved > 15 && moved < 2 * 70 * 2 * 0.6, `the square went right ${moved.toFixed(0)} px in 2 s (a held key would move it ~${2 * 70 * 2} px or to the edge)`);

  PAD = { axes: [0, 0, 0, 0], buttons: B({ y: 1 }) };
  await sleep(400);
  const enterDown = await page.evaluate('window.__log.filter((e) => e.code === "Enter").slice(-1)[0]');
  PAD = { axes: [0, 0, 0, 0], buttons: B({}) };
  await sleep(300);
  ok(enterDown && enterDown.down === true, 'Y (enter / exit car) holds Enter');

  // her real eye on that page
  const eye = await new Eye({ mode: 'frame' }).open(page);
  const g1 = await eye.look(page);
  const s1 = gridStats(g1);
  ok(eye.lastPath === 'frame' && s1.sd > 0.02, `her eye reads the game canvas in the page ('${eye.lastPath}' path, contrast sd ${s1.sd})`);
}
await app.stop();

// ---------------------------------------------------------------- the ladder with stage 1 on the outside page
app = await run({ ladderMode: true });
ok(app.consoleTab?.playing === true && app.keyer?.name === 'gta1' && app.ladder.json().playing?.id === 'gta1', 'LADDER {"gta1":{"url":<outside page>}}: the console plays stage 1 there, GTA 1 keys picked automatically, playing = gta1');
await app.stop();

site.close();
fs.rmSync(tmp, { recursive: true, force: true });
finish(R, 'outside-console');
process.exit(process.exitCode || 0);
