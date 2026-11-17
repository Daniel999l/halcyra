/**
 * Our own in-tab DOS console (/console/dos) with a tiny DOS program written
 * for this project (test/dos-prog/MOVE.COM: a square that moves while arrow
 * keys are held, six boxes that light while Up, Down, Left, Right, Enter,
 * Space are down). No game data.
 *
 * The real service in ladder mode (no CONSOLE_URL), stage gta1's bundle made
 * by scripts/make-bundle.mjs into a temp GAMES_DIR, the real ConsoleTab in
 * headless Chrome. A stand-in pilot sets the standard pad; the PAGE turns it
 * into keys (src/stagekeys.js, pulse width) and the program shows them:
 *   gas full -> up; brake -> down; steer -1 -> left; steer +0.3 -> right, slower
 *   Y -> Enter box lit; RB -> Space box lit
 * Then her real eye reads the page ('frame' path) and the picture changes.
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startApp } from '../src/index.js';
import { makeBundle } from '../scripts/make-bundle.mjs';
import { Eye } from '../src/eye.js';
import { GAMEPAD_INIT, padSetJs } from '../src/gamepad.js';
import { gridStats } from '../src/gamepilot.js';
import { memDb } from './memdb.mjs';
import { fakeTick, standinTaste, testConfig, check, finish } from './service-fixtures.mjs';
import { say } from '../src/log.js';

say.quiet = !process.argv.includes('--verbose');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const R = []; const ok = check(R);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
console.log('dos-console\n');

const gamesDir = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyra-dosgames-'));
const bundle = makeBundle({ src: path.join(ROOT, 'test', 'dos-prog'), id: 'gta1', exe: 'MOVE.COM', out: gamesDir });
ok(fs.existsSync(bundle.file) && /cycles=fixed 30000/.test(bundle.conf) && /scaler=none/.test(bundle.conf) && /nosound=true/.test(bundle.conf) && /\nMOVE\.COM\n/.test(bundle.conf), 'make-bundle: bundle written with fixed cycles, no scaler, no sound, autostart MOVE.COM');

let PAD = { axes: [0, 0, 0, 0], buttons: {} };
const pilot = {
  async loadFly() { return { N: 139255, E: 2700513 }; },
  flyNames() { return []; },
  GamePilot: class {
    constructor() { this.n = 0; this.page = null; }
    // the real pilot writes the virtual pad into the page each step; same here
    async attach(p) { this.page = p; await p.addInitScript(GAMEPAD_INIT); await p.evaluate(GAMEPAD_INIT).catch(() => {}); return this; }
    async detach() {}
    async step(p) { this.n += 1; const t = fakeTick(this.n); t.pad = JSON.parse(JSON.stringify(PAD)); await p.evaluate(padSetJs(t.pad)); return t; }
    telemetry() { return { step: this.n }; }
  },
};
const B = (o) => ({ a: 0, b: 0, x: 0, y: 0, lb: 0, rb: 0, lt: 0, rt: 0, back: 0, start: 0, ls: 0, rs: 0, up: 0, down: 0, left: 0, right: 0, home: 0, ...o });
const SQ = `(() => {
  const c = document.querySelector('#screen'); const g = c.getContext('2d'); const d = g.getImageData(0, 0, c.width, c.height).data;
  let n = 0, sx = 0, sy = 0;
  for (let y = 0; y < 170; y += 1) for (let x = 0; x < c.width; x += 1) { const i = (y * c.width + x) * 4; if (d[i] > 200 && d[i + 1] > 200 && d[i + 2] < 120) { n += 1; sx += x; sy += y; } }
  const lit = [0, 1, 2, 3, 4, 5].map((k) => { const i = ((176 + 8) * c.width + 20 + k * 50 + 20) * 4; return d[i + 1] > 200 && d[i] < 150; });
  return { x: n ? sx / n : null, y: n ? sy / n : null, lit };
})()`;

const browser = { headless: true, flavour: 'playwright', executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', width: 1280, height: 720, extraArgs: [] };
const cfg = testConfig({ browser, gamesDir, console: { url: '', keys: '', frozenSec: 60 }, loop: { stepMs: 100 }, ladder: { pollMs: 5000 } });
const app = await startApp({ cfg, db: memDb(), modules: { pilot, taste: standinTaste } });
const t0 = Date.now();
while (Date.now() - t0 < 60000 && !app.consoleTab?.playing) await sleep(200);
const page = app.consoleTab?.page;
ok(app.consoleTab?.playing && page && page.url().endsWith('/console/dos?b=gta1'), 'no CONSOLE_URL, gta1 files present: the console plays our own /console/dos?b=gta1');
ok(!app.keyer, 'own page: no keyer in Node (the page maps the pad itself)');
if (page) {
  await page.waitForFunction('window.__dos && window.__dos.frames > 0', null, { timeout: 30000 }).catch(() => {});
  const lad = app.ladder.json();
  ok(lad.playing?.id === 'gta1' && lad.playing.game === 'GTA 1', '/api/ladder: playing = GTA 1');
  const move = async (pad, ms) => { const a = await page.evaluate(SQ); PAD = pad; await sleep(ms); const b2 = await page.evaluate(SQ); const lit = b2.lit; PAD = { axes: [0, 0, 0, 0], buttons: B({}) }; await sleep(300); return { dx: b2.x - a.x, dy: b2.y - a.y, lit }; };
  let m = await move({ axes: [0, -1, 0, 0], buttons: B({ rt: 1 }) }, 800);
  ok(m.dy < -20 && Math.abs(m.dx) < 2 && m.lit[0], `gas -> Up: the square went up ${(-m.dy).toFixed(0)} px, Up box lit`);
  m = await move({ axes: [0, 1, 0, 0], buttons: B({ lt: 1 }) }, 800);
  ok(m.dy > 20 && m.lit[1], `brake -> Down: the square went down ${m.dy.toFixed(0)} px, Down box lit`);
  m = await move({ axes: [-1, 0, 0, 0], buttons: B({}) }, 800);
  ok(m.dx < -20 && m.lit[2], `steer -1 -> Left: the square went left ${(-m.dx).toFixed(0)} px`);
  const full = -m.dx;
  m = await move({ axes: [0.3, 0, 0, 0], buttons: B({}) }, 800);
  ok(m.dx > 3 && m.dx < full * 0.6, `steer +0.3 -> Right taps: ${m.dx.toFixed(0)} px vs ${full.toFixed(0)} px for a full steer`);
  m = await move({ axes: [0, 0, 0, 0], buttons: B({ y: 1, rb: 1 }) }, 500);
  ok(m.lit[4] && m.lit[5] && Math.abs(m.dx) < 1 && Math.abs(m.dy) < 1, 'Y -> Enter box lit, RB -> Space box lit, no movement');
  const st = await page.evaluate('({ padReads: window.__dos.padReads, sent: window.__dos.sent, frames: window.__dos.frames })');
  ok(st.padReads > 100 && st.sent > 20, `the page read her pad ${st.padReads} times and sent ${st.sent} key changes to the emulator`);
  const eye = await new Eye({ mode: 'frame' }).open(page);
  const g1 = await eye.look(page);
  PAD = { axes: [1, 0, 0, 0], buttons: B({}) }; await sleep(500); PAD = { axes: [0, 0, 0, 0], buttons: B({}) };
  const g2 = await eye.look(page);
  let diff = 0; for (let i = 0; i < g1.length; i += 1) diff += Math.abs(g1[i] - g2[i]);
  ok(eye.lastPath === 'frame' && gridStats(g1).sd > 0.02 && diff > 1, `her eye gets frames from the page ('frame' path, sd ${gridStats(g1).sd}, change ${diff.toFixed(2)})`);
}
await app.stop();
fs.rmSync(gamesDir, { recursive: true, force: true });
finish(R, 'dos-console');
process.exit(process.exitCode || 0);
