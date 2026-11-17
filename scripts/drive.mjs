/**
 * Watch her drive the mock console.
 *
 *   node scripts/drive.mjs [seconds=30] [--ms 160] [--eye small|png] [--seed 783] [--fps 30] [--frames]
 *
 * Runs her on test/mock-console for N seconds of wall time and records the tab
 * (CDP screencast, so the video is smooth even though she acts ~2x a second)
 * to data/drive-<time>.mp4 with ffmpeg, plus data/drive-<time>.json with her
 * ticks (pad, descending readouts) and the game's ground truth.
 * The recorder runs in a child process attached to the same Chrome over CDP:
 * her brain step is synchronous and would otherwise starve it.
 * --frames keeps the JPEG frames in data/drive-<time>/ instead of deleting them.
 *
 * Her readout box is hidden for the ~35 ms of each look, so a few frames in the
 * video show the game without it. Nothing else is edited.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { serveMock } from '../test/mock-console/serve.mjs';
import { loadFly, GamePilot } from '../src/gamepilot.js';
import { releasePad } from '../src/gamepad.js';

// ---------- child: the recorder ----------
if (process.argv[2] === '--record-child') {
  const [, , , port, dir, everyNth] = process.argv;
  const { chromium: cr } = await import('playwright-core');
  const b = await cr.connectOverCDP(`http://127.0.0.1:${port}`);
  let page = null;
  for (let i = 0; i < 50 && !page; i += 1) {
    page = b.contexts().flatMap((c) => c.pages()).find((pg) => pg.url().startsWith('http://127.0.0.1')) || null;
    if (!page) await new Promise((r) => setTimeout(r, 100));
  }
  if (!page) { console.error('recorder: console page not found'); process.exit(1); }
  const cam = await page.context().newCDPSession(page);
  const frames = [];
  cam.on('Page.screencastFrame', (f) => {
    const name = `f${String(frames.length + 1).padStart(6, '0')}.jpg`;
    fs.writeFileSync(path.join(dir, name), Buffer.from(f.data, 'base64'));
    frames.push({ name, ts: f.metadata.timestamp });
    cam.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
  });
  await cam.send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: 1280, maxHeight: 720, everyNthFrame: Number(everyNth) || 2 });
  process.stdout.write('ready\n');
  process.stdin.on('data', async () => {
    await cam.send('Page.stopScreencast').catch(() => {});
    fs.writeFileSync(path.join(dir, 'frames.json'), JSON.stringify(frames));
    process.exit(0);
  });
  await new Promise(() => {});
}

const freePort = () => new Promise((resolve) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > -1 ? process.argv[i + 1] : d; };
const SECONDS = Number(process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 30);
const PORT = await freePort();
const MS = Number(arg('ms', 70));
const EYE = arg('eye', 'frame');
const SEED = Number(arg('seed', 783));
const FPS = Number(arg('fps', 30));
const KEEP = process.argv.includes('--frames');
const FFMPEG = process.env.FFMPEG_PATH || (fs.existsSync('/usr/local/bin/ffmpeg') ? '/usr/local/bin/ffmpeg' : 'ffmpeg');

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const DATA = path.join(ROOT, 'data');
const FR = path.join(DATA, `drive-${stamp}`);
fs.mkdirSync(FR, { recursive: true });

await loadFly();
const srv = await serveMock();
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
  headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage', `--remote-debugging-port=${PORT}`],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const pilot = new GamePilot({ seed: SEED, eye: EYE });
await pilot.attach(page);
await page.goto(srv.url);
await page.waitForTimeout(400);
await pilot.attach(page);

// the recording camera (separate from her eye), in its own process
const rec = spawn(process.execPath, [fileURLToPath(import.meta.url), '--record-child', String(PORT), FR, String(Math.max(1, Math.round(60 / FPS)))], { stdio: ['pipe', 'pipe', 'inherit'] });
await new Promise((resolve, reject) => {
  rec.stdout.on('data', (d) => { if (String(d).includes('ready')) resolve(); });
  rec.on('exit', (c) => reject(new Error(`recorder exited ${c}`)));
});
const ticks = [];
const t0 = performance.now();
console.log(`driving for ${SECONDS} s (seed ${SEED}, eye ${EYE}, ${MS} ms brain time per step)`);
while ((performance.now() - t0) / 1000 < SECONDS) {
  const tick = await pilot.step(page, { ms: MS });
  const g = await page.evaluate(() => window.__game);
  const { lit, ...rest } = tick;
  ticks.push({ ...rest, perf: pilot.lastPerf, game: { x: g.x, y: g.y, heading: g.heading, speed: g.speed, dist: g.dist, collisions: g.collisions, inCar: g.inCar } });
  if (ticks.length % 10 === 0) console.log(`  step ${ticks.length}: steer ${tick.pad.axes[0].toFixed(3)} gas ${tick.pad.buttons.rt.toFixed(2)} brake ${tick.pad.buttons.lt.toFixed(2)}  dist ${g.dist.toFixed(0)} px  hits ${g.collisions}`);
}
const wall = (performance.now() - t0) / 1000;
const recDone = new Promise((r) => rec.on('exit', r));
rec.stdin.write('stop\n');
await recDone;
const frames = JSON.parse(fs.readFileSync(path.join(FR, 'frames.json'), 'utf8'));
await releasePad(page);
const gEnd = await page.evaluate(() => window.__game);
await browser.close();
await srv.close();

const summary = {
  seconds: +wall.toFixed(1), steps: ticks.length, stepsPerSec: +(ticks.length / wall).toFixed(2), msBrainPerStep: MS, seed: SEED, eye: EYE,
  dist: Math.round(gEnd.dist), distFoot: Math.round(gEnd.distFoot), collisions: gEnd.collisions, toggles: gEnd.toggles, frames: frames.length,
};
fs.writeFileSync(path.join(DATA, `drive-${stamp}.json`), JSON.stringify({ summary, ticks }, null, 1));

let mp4 = null;
if (frames.length > 1) {
  const list = [];
  for (let i = 0; i < frames.length; i += 1) {
    const d = i + 1 < frames.length ? Math.max(0.001, frames[i + 1].ts - frames[i].ts) : 1 / FPS;
    list.push(`file '${frames[i].name}'`, `duration ${d.toFixed(4)}`);
  }
  list.push(`file '${frames[frames.length - 1].name}'`);
  fs.writeFileSync(path.join(FR, 'list.txt'), list.join('\n'));
  mp4 = path.join(DATA, `drive-${stamp}.mp4`);
  const r = spawnSync(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', path.join(FR, 'list.txt'),
    '-vf', `fps=${FPS},format=yuv420p`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-movflags', '+faststart', mp4], { stdio: 'inherit' });
  if (r.status !== 0) { console.log(`ffmpeg failed (${r.status}); frames kept in ${FR}`); mp4 = null; }
}
if (mp4 && !KEEP) fs.rmSync(FR, { recursive: true, force: true });
console.log(JSON.stringify(summary));
console.log(mp4 ? `video: ${mp4}` : `frames: ${FR}`);
console.log(`ticks: ${path.join(DATA, `drive-${stamp}.json`)}`);
