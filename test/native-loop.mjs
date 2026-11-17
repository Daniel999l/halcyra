/**
 * The whole service in native mode (CONSOLE_KIND=native), the way it runs on
 * the Windows PC, with Linux stand-ins only where Windows is needed:
 *   - the REAL brain (worker thread) and the REAL taste module
 *   - the REAL NativeConsole, picked by cfg.consoleKind (no consoleFactory)
 *   - the eye: REAL ffmpeg x11grab on Xvfb showing a moving test picture
 *     (if Xvfb/ffplay are missing: a stand-in ffmpeg writing moving frames)
 *   - the pad: the stand-in feeder (echoes and logs every line it gets)
 * Checks: brain steps, a pad line comes out for her ticks, ticks are chained
 * and verify-chain passes, /api/frame.jpg works, no browser is started, and a
 * tick is exactly what the browser code path records for the same picture.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { startApp, tryImport } from '../src/index.js';
import { toFeederState, NEUTRAL_LINE } from '../src/native/pad.js';
import { testConfig, getJson, check, finish } from './service-fixtures.mjs';
import { say } from '../src/log.js';

say.quiet = true;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const R = []; const ok = check(R);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms) => { const t = Date.now(); while (Date.now() - t < ms) { if (await f()) return true; await sleep(100); } return false; };
const has = (bin) => spawnSync('sh', ['-c', `command -v ${bin}`]).status === 0;
console.log('native-loop\n');

const real = !process.env.NATIVE_LOOP_FAKE && has('Xvfb') && has('ffmpeg') && has('ffplay');
const DISP = ':92';
let xvfb = null; let viewer = null;
if (real) {
  xvfb = spawn('Xvfb', [DISP, '-screen', '0', '1280x720x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
  await sleep(800);
  // a moving test picture, as a game would be (10 fps keeps this box's CPU modest)
  viewer = spawn('ffplay', ['-loglevel', 'error', '-an', '-noborder', '-left', '0', '-top', '0', '-x', '1280', '-y', '720', '-f', 'lavfi', 'testsrc2=s=640x360:r=10'], { stdio: 'ignore', env: { ...process.env, DISPLAY: DISP, SDL_AUDIODRIVER: 'dummy' } });
  await sleep(1200);
} else console.log('  (no Xvfb/ffplay: the eye uses the stand-in ffmpeg)');

const padLog = path.join(os.tmpdir(), `halcyra-native-loop-${process.pid}.log`);
fs.rmSync(padLog, { force: true });
process.env.FAKE_LOG = padLog;

const modules = { pilot: await tryImport('./gamepilot.js', 'brain'), gamebody: await tryImport('./gamebody.js', 'body'), taste: await tryImport('./taste.js', 'taste') };
const cfg = testConfig({
  consoleKind: 'native',
  native: {
    feeder: `"${process.execPath}" "${path.join(HERE, 'native', 'fake-feeder.mjs')}"`,
    capture: 'x11grab', eyeFps: 10, jpegFps: 2, padHz: 60, staleMs: 3000,
  },
  stream: { display: DISP, ...(real ? {} : { ffmpeg: process.execPath }) },
  loop: { stepMs: 200 },
  ledger: { bucketTicks: 50, ringTicks: 200 },
});
if (!real) {
  // no X here: a stand-in ffmpeg that ignores its arguments and writes moving frames
  const fake = path.join(os.tmpdir(), `halcyra-fakeff-${process.pid}.mjs`);
  fs.writeFileSync(fake, "const FB=160*90*3;let n=0;setInterval(()=>{const b=Buffer.alloc(FB);for(let i=0;i<FB;i+=3){const x=(i/3)%160;b[i]=b[i+1]=b[i+2]=((x+n*7)%160)<80?20:230;}n++;process.stdout.write(b);},100);");
  cfg.__fakeFfmpeg = fake; // ffmpeg = node, and the Screen's argv is swapped for this script after start (below)
}

const app = await startApp({ cfg, modules });
if (!real) { app.consoleTab.screen.o.args = () => [cfg.__fakeFfmpeg]; app.consoleTab.screen.stop(); app.consoleTab.screen.start(); }
const base = `http://127.0.0.1:${app.port}`;

ok(app.consoleTab?.constructor?.name === 'NativeConsole', 'CONSOLE_KIND=native picks the NativeConsole (no CONSOLE_URL set)');
const played = await until(() => app.ledger.head().ticks >= 40, 120000);
ok(played, `the real brain stepped on the desktop grab (${app.ledger.head().ticks} ticks)`);
const h = (await getJson(base, '/api/health')).body;
const st = (await getJson(base, '/api/state')).body;
ok(h.console?.state === 'playing' || st.console?.state === 'playing', `console state "playing" (${h.console?.state} ${h.console?.detail || ''})`);
ok(st.brain?.eye === 'native' || h.brain?.eye === 'native', 'the brain reports eye = native');
ok(st.view?.state === 'seeing', `a moving picture: her eye says "${st.view?.state}" (contrast ${st.view?.contrast})`);
ok(st.tick && st.tick.dn && st.tick.pad && Array.isArray(st.tick.pad.axes) && st.tick.lit?.length > 0, 'ticks carry dn, pad and lit as in browser mode');
const fl = st.fly || {};
ok(fl.eye === 'native' && fl.eyePath === 'native', `telemetry: eye native (perf ${JSON.stringify(fl.perf)})`);

// pad lines
await sleep(300);
const lines = fs.readFileSync(padLog, 'utf8').trim().split('\n').filter(Boolean);
const parsed = lines.map((l) => JSON.parse(l));
const ticks = await app.ledger.ticks(-1, 1000);
const wanted = new Set(ticks.map((t) => JSON.stringify(toFeederState(t.pad))));
const matched = lines.filter((l) => wanted.has(l)).length;
ok(lines.length >= 20 && parsed.every((p) => 'lx' in p && 'rt' in p && Array.isArray(p.btn)), `pad lines came out (${lines.length} lines for ${ticks.length} ticks)`);
ok(matched >= Math.min(lines.length - 2, ticks.length) * 0.9, `${matched} of ${lines.length} lines are exactly a recorded tick's pad (the rest: the first neutral and keep-alives)`);
const moved = parsed.some((p) => p.lx !== 0 || p.rt !== 0 || p.lt !== 0);
ok(moved, 'her pad moved (some line has a stick or trigger off zero)');

// frame
const fr = await fetch(`${base}/api/frame.jpg`);
const jpg = Buffer.from(await fr.arrayBuffer());
if (real) ok(fr.status === 200 && jpg[0] === 0xff && jpg[1] === 0xd8, `/api/frame.jpg serves the desktop grab (${jpg.length} bytes)`);
else ok(fr.status === 204, '/api/frame.jpg: the stand-in ffmpeg makes no JPEG -> 204 (empty), no error');

// no browser
const kids = spawnSync('ps', ['-eo', 'ppid=,comm='], { encoding: 'utf8' }).stdout.split('\n').map((l) => l.trim().split(/\s+/)).filter(([pp]) => Number(pp) === process.pid).map(([, c]) => c);
ok(!kids.some((c) => /chrom|cloak/i.test(c)), `no browser started (children: ${[...new Set(kids)].join(', ')})`);

// verify-chain
app.consoleTab.state = 'paused-for-test';
await sleep(500);
await app.ledger.flush();
const v = await new Promise((resolve) => {
  const p = spawn(process.execPath, ['scripts/verify-chain.mjs', base], { cwd: ROOT });
  let out = ''; p.stdout.on('data', (d) => { out += d; }); p.on('close', (code) => resolve({ code, out }));
});
ok(v.code === 0, 'verify-chain passes on native ticks', v.out.split('\n').find((l) => l.startsWith('ticks')));
const rec = ticks.at(-1);
const keys = Object.keys(rec).filter((k) => !['hash', 'prevHash', 'lit'].includes(k)).sort().join(',');
ok(keys === 'active,commit,dn,drove,escape,ms,pad,pilotStep,step,t,taste,tasteAt', `recorded tick keys are the browser-mode ones: ${keys}`);

await app.stop();
const tail = fs.readFileSync(padLog, 'utf8').trim().split('\n').at(-1);
ok(tail === NEUTRAL_LINE, 'service stop -> the pad is sent neutral last');

// ---- the same picture through the browser code path gives the same tick
{
  const P = modules.pilot;
  const grid = new Float32Array(160 * 90); for (let i = 0; i < grid.length; i += 1) grid[i] = ((i % 160) < 80 ? 0.1 : 0.9) * (0.5 + 0.5 * Math.sin(i / 900));
  const A = new P.GamePilot({ seed: 4242, thread: 'main', overlay: false });
  const B = new P.GamePilot({ seed: 4242, thread: 'main', overlay: false });
  const sent = [];
  const port = { native: true, look: () => grid.slice(), setPad: (pad) => { sent.push(pad); return sent.length; } };
  await A.attach(port);
  // browser path: a page stand-in that takes the pad JS; its eye returns the same grid
  const page = { evaluate: async () => 1, addInitScript: async () => {}, viewportSize: () => ({ width: 1280, height: 720 }) };
  await B.attach(page);
  B.eye = { mode: 'frame', look: async () => grid.slice(), close: async () => {} };
  let same = true; let n = 0;
  for (let i = 0; i < 6; i += 1) {
    const taste = { sweet: i % 2 ? 0.3 : 0, bitter: 0, applied: [] };
    const ta = await A.step(port, { ms: 30, taste }); const tb = await B.step(page, { ms: 30, taste });
    const strip = (t) => JSON.stringify({ ...t, t: 0 });
    if (strip(ta) !== strip(tb)) same = false;
    if (JSON.stringify(sent.at(-1)) !== JSON.stringify(ta.pad)) same = false;
    n += 1;
  }
  ok(same, `same seed, same picture: native and browser paths record identical ticks (${n} steps), and the native pad got exactly tick.pad`);
  await A.close(); await B.close();
}

viewer?.kill('SIGKILL'); xvfb?.kill('SIGKILL');
fs.rmSync(padLog, { force: true });
finish(R, 'native-loop');
process.exit(process.exitCode || 0);
