/**
 * The console probe (scripts/console-probe.mjs) run for real, non-interactively
 * (--auto), headed Chrome on its own Xvfb display, against local pages:
 *
 *   1. the mock console (driving game): picture found, a capture path works and
 *      is not black, the page polls the virtual pad, report files written
 *   2. test/probe-pages/menu.html (tiles, Gamepad API only): CONTROLLER PASS
 *   3. test/probe-pages/menu-keys.html (arrow keys only): CONTROLLER FAIL, KEYBOARD PASS
 *   4. test/probe-pages/tainted.html (cross-origin video, no CORS): the in-page
 *      frame path is reported blocked (tainted), the probe does not crash
 *
 * Output and profile folders have spaces in their names on purpose.
 *
 *   CHROME_PATH (default /usr/bin/google-chrome), FFMPEG_PATH (default ffmpeg)
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { serveMock } from './mock-console/serve.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGES = path.join(ROOT, 'test', 'probe-pages');
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const FFMPEG = process.env.FFMPEG_PATH || 'ffmpeg';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let fails = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) fails += 1; };

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'probe test '));
const PROFILE = path.join(TMP, 'probe profile with spaces');
const children = [];
const servers = [];

function cleanup() {
  for (const c of children) { try { c.kill(c === xvfb ? 'SIGTERM' : 'SIGKILL'); } catch { /* gone */ } }
  for (const s of servers) { try { s.close(); } catch { /* gone */ } }
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* fine */ }
}
process.on('exit', cleanup);
process.on('SIGINT', () => process.exit(130));

// ---------------------------------------------------------------- Xvfb
function freeDisplay() {
  for (let n = 90; n < 140; n += 1) if (!fs.existsSync(`/tmp/.X11-unix/X${n}`) && !fs.existsSync(`/tmp/.X${n}-lock`)) return n;
  throw new Error('no free X display');
}
const DNUM = freeDisplay();
const xvfb = spawn('Xvfb', [`:${DNUM}`, '-screen', '0', '1280x800x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
children.push(xvfb);
for (let i = 0; i < 50 && !fs.existsSync(`/tmp/.X11-unix/X${DNUM}`); i += 1) await sleep(100);
ok(fs.existsSync(`/tmp/.X11-unix/X${DNUM}`), `Xvfb up on :${DNUM}`);

// ---------------------------------------------------------------- servers
function serveDir(dir) {
  const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mp4': 'video/mp4' };
  const server = http.createServer((req, res) => {
    const p = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '');
    const f = path.join(dir, path.normalize(p));
    if (!f.startsWith(dir) || !fs.existsSync(f) || !fs.statSync(f).isFile()) { res.writeHead(404); res.end(); return; }
    const size = fs.statSync(f).size;
    const type = TYPES[path.extname(f)] || 'application/octet-stream';
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.range || '');
    if (m) {
      const a = m[1] ? +m[1] : 0; const b = m[2] ? +m[2] : size - 1;
      res.writeHead(206, { 'content-type': type, 'content-range': `bytes ${a}-${b}/${size}`, 'accept-ranges': 'bytes', 'content-length': b - a + 1 });
      fs.createReadStream(f, { start: a, end: b }).pipe(res); return;
    }
    res.writeHead(200, { 'content-type': type, 'content-length': size, 'accept-ranges': 'bytes', 'cache-control': 'no-store' });
    fs.createReadStream(f).pipe(res);
  });
  servers.push(server);
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${server.address().port}/`)));
}

// a video on ANOTHER origin, served without CORS headers
const VID_DIR = path.join(TMP, 'video');
fs.mkdirSync(VID_DIR);
const ff = spawnSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=30', '-t', '6',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', path.join(VID_DIR, 'clip.mp4')]);
ok(ff.status === 0, `test video made with ffmpeg${ff.status ? `: ${String(ff.stderr).slice(0, 200)}` : ''}`);

const pagesUrl = await serveDir(PAGES);
const videoUrl = await serveDir(VID_DIR);
const mock = await serveMock();
servers.push({ close: () => mock.close() });

// ---------------------------------------------------------------- run the probe
async function runProbe(name, url) {
  const out = path.join(TMP, `out ${name} with spaces`);
  console.log(`\n--- probe: ${name} (${url}) ---`);
  const t0 = Date.now();
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'console-probe.mjs'), url, '--auto', '--wait', '20', '--out', out, '--profile', PROFILE], {
    cwd: ROOT, env: { ...process.env, DISPLAY: `:${DNUM}`, CHROME_PATH: CHROME }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  children.push(child);
  let text = '';
  child.stdout.on('data', (d) => { text += d; process.stdout.write(String(d).replace(/^/gm, '  | ')); });
  child.stderr.on('data', (d) => { text += d; process.stdout.write(String(d).replace(/^/gm, '  ! ')); });
  const code = await new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve('timeout'); }, 6 * 60 * 1000);
    child.on('exit', (c) => { clearTimeout(timer); resolve(c); });
  });
  const secs = Math.round((Date.now() - t0) / 1000);
  const jf = path.join(out, 'report.json');
  const rep = fs.existsSync(jf) ? JSON.parse(fs.readFileSync(jf, 'utf8')) : null;
  return { code, secs, out, rep, text, files: fs.existsSync(out) ? fs.readdirSync(out) : [] };
}

// 1. mock console
{
  const r = await runProbe('mock console', mock.url);
  const p = r.rep && r.rep.picture;
  ok(r.code === 0 && r.rep && r.rep.finished, `mock: probe exited 0 and finished (${r.secs} s)`);
  ok(r.files.includes('report.json') && r.files.includes('report.txt'), `mock: report.json and report.txt written (${r.files.join(', ')})`);
  ok(p && p.found && p.element && p.element.tag === 'canvas', `mock: picture found (${p && p.element && `${p.element.tag} ${p.element.w}x${p.element.h}`})`);
  const working = p ? Object.entries(p.paths).filter(([, v]) => v.works && !v.black) : [];
  ok(working.length >= 1, `mock: capture paths that work and are not black: ${working.map(([k, v]) => `${k} (mean ${v.meanLuminance}, sd ${v.sd}, ${v.perSecond}/s)`).join(', ')}`);
  ok(working.every(([k, v]) => !v.file || r.files.includes(v.file)), `mock: one PNG saved per working path (${working.map(([, v]) => v.file).join(', ')})`);
  const c = r.rep && r.rep.controller;
  ok(c && c.polled, `mock: the page polls the virtual pad (${c && c.polling.map((f) => `${f.readsPerSecond}/s`).join(', ')})`);
  ok(r.rep && r.rep.results && ['PASS', 'FAIL', 'UNCLEAR'].includes(r.rep.results.CONTROLLER), `mock: controller result reported (${r.rep && r.rep.results.CONTROLLER}; a driving game, any of the three is acceptable)`);
  ok(r.rep && r.rep.page && r.rep.page.summary && r.rep.page.summary.instrumentErrors === 0, 'mock: instrumentation threw nothing in the page');
}

// 2. gamepad menu
{
  const r = await runProbe('menu pad', `${pagesUrl}menu.html`);
  const res = r.rep && r.rep.results;
  ok(r.code === 0 && r.rep && r.rep.finished, `menu: probe exited 0 and finished (${r.secs} s)`);
  ok(res && res.PICTURE === 'PASS', `menu: PICTURE ${res && res.PICTURE}`);
  ok(res && res.CONTROLLER === 'PASS', `menu: CONTROLLER ${res && res.CONTROLLER} (dpad ${r.rep && r.rep.controller && r.rep.controller.dpad}, stick ${r.rep && r.rep.controller && r.rep.controller.stick}, baseline ${r.rep && r.rep.controller && r.rep.controller.baseline})`);
  ok(res && res.KEYBOARD === 'skipped', `menu: KEYBOARD ${res && res.KEYBOARD} (not run when the controller passes)`);
  const d = r.rep && r.rep.delay;
  ok(d && Number.isFinite(d.medianMs), `menu: DELAY median ${d && d.medianMs} ms (samples ${d && d.samplesMs})`);
  const s = r.rep && r.rep.page && r.rep.page.summary;
  ok(s && s.webrtcConnections === 0 && s.dataChannels.length === 0, 'menu: page facts say no WebRTC, no data channels');
}

// 3. keys-only menu
{
  const r = await runProbe('menu keys', `${pagesUrl}menu-keys.html`);
  const res = r.rep && r.rep.results;
  ok(r.code === 0 && r.rep && r.rep.finished, `keys: probe exited 0 and finished (${r.secs} s)`);
  ok(res && res.CONTROLLER === 'FAIL', `keys: CONTROLLER ${res && res.CONTROLLER} (polled: ${r.rep && r.rep.controller && r.rep.controller.polled})`);
  ok(res && res.KEYBOARD === 'PASS', `keys: KEYBOARD ${res && res.KEYBOARD} (arrows ${r.rep && r.rep.keyboard && r.rep.keyboard.arrows})`);
  ok(r.rep && r.rep.delay && r.rep.delay.how === 'keys' && Number.isFinite(r.rep.delay.medianMs), `keys: DELAY timed with keys, median ${r.rep && r.rep.delay && r.rep.delay.medianMs} ms`);
  ok(r.rep && r.rep.page.summary.keyListeners >= 1, `keys: page facts count ${r.rep && r.rep.page.summary.keyListeners} key listener(s)`);
  const txt = fs.existsSync(path.join(r.out, 'report.txt')) ? fs.readFileSync(path.join(r.out, 'report.txt'), 'utf8') : '';
  ok(/arrow keys/.test(txt), 'keys: report.txt next step says to use keys');
}

// 4. cross-origin (tainted) video
{
  const r = await runProbe('tainted video', `${pagesUrl}tainted.html?src=${encodeURIComponent(`${videoUrl}clip.mp4`)}`);
  const p = r.rep && r.rep.picture;
  ok(r.code === 0 && r.rep && r.rep.finished, `tainted: probe exited 0 and finished, no crash (${r.secs} s)`);
  ok(p && p.found && p.element.tag === 'video' && p.element.playing, `tainted: playing video found (${p && p.element && `${p.element.videoW}x${p.element.videoH}`})`);
  ok(p && p.paths.frame && p.paths.frame.works === false && p.paths.frame.tainted === true, `tainted: frame path reported blocked: "${p && p.paths.frame && p.paths.frame.why}"`);
  ok(p && p.paths.screenshot && p.paths.screenshot.works, `tainted: screenshot path still works (mean ${p && p.paths.screenshot.meanLuminance})`);
  ok(p && p.facts && p.facts.rvfc && p.facts.rvfc.perSecond > 0, `tainted: video frame rate measured (${p && p.facts && p.facts.rvfc && p.facts.rvfc.perSecond}/s)`);
  ok(/frame (no|blocked)/.test(r.rep.results ? r.text : ''), 'tainted: the PICTURE line says the frame path is blocked');
}

console.log(`\n${fails ? `${fails} FAILED` : 'all passed'}`);
cleanup();
process.exit(fails ? 1 : 0);
