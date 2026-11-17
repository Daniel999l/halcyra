/**
 * Production-shaped run, as close to the Railway container as this workspace
 * allows: docker-entrypoint.sh starts Xvfb, then the real `node src/index.js`
 * with the real brain, the stealth browser (cloakbrowser, HEADED on the
 * virtual display) on the mock console, and the stream grabbing that
 * display. The stream goes to a local file (there is no RTMP server here).
 * Measures memory and CPU of the whole thing.
 *
 *   CLOAKBROWSER_CACHE_DIR must point at an installed cloakbrowser binary
 *   (npx cloakbrowser install); default /tmp/cloakbrowser. Set CHROME_PATH to
 *   use a plain Chrome instead.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { getJson, check, finish } from './service-fixtures.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const R = []; const ok = check(R);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
console.log('service-e2e\n');

const { serveMock } = await import('./mock-console/serve.mjs');
const mock = await serveMock(0);
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
const port = await freePort();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyra-e2e-'));
const out = path.join(ROOT, 'data', 'e2e-stream.flv'); fs.rmSync(out, { force: true });
const env = {
  PATH: process.env.PATH, HOME: process.env.HOME,
  PORT: String(port), DATA_DIR: dataDir, DISPLAY_NUM: '94',
  CONSOLE_URL: mock.url, STREAM_URL: out, HEADLESS: 'false',
  CLOAKBROWSER_CACHE_DIR: process.env.CLOAKBROWSER_CACHE_DIR || '/tmp/cloakbrowser',
  CLOAKBROWSER_SUPPRESS_FONT_WARNING: '1',
  ...(process.env.CHROME_PATH ? { CHROME_PATH: process.env.CHROME_PATH } : {}),
  ...(process.env.FRAME_MS ? { FRAME_MS: process.env.FRAME_MS } : {}),
  ...(process.env.STEP_MS ? { STEP_MS: process.env.STEP_MS } : {}),
};
const child = spawn(path.join(ROOT, 'docker-entrypoint.sh'), ['node', 'src/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
const base = `http://127.0.0.1:${port}`;

// tree memory/cpu
function tree(pid) {
  const r = spawnSync('ps', ['-eo', 'pid,ppid,rss,times,comm', '--no-headers'], { encoding: 'utf8' });
  const rows = r.stdout.trim().split('\n').map((l) => l.trim().split(/\s+/)).map(([p, pp, rss, t, ...c]) => ({ pid: +p, ppid: +pp, rss: +rss, t: +t, comm: c.join(' ') }));
  const keep = new Set([pid]); let grew = true;
  while (grew) { grew = false; for (const x of rows) if (keep.has(x.ppid) && !keep.has(x.pid)) { keep.add(x.pid); grew = true; } }
  const mine = rows.filter((x) => keep.has(x.pid));
  const by = {};
  for (const x of mine) { const k = /node/.test(x.comm) ? 'node' : /Xvfb/.test(x.comm) ? 'Xvfb' : /ffmpeg/.test(x.comm) ? 'ffmpeg' : /chrom|chrome/i.test(x.comm) ? 'chrome' : x.comm; by[k] = by[k] || { rssMb: 0, cpuS: 0, n: 0 }; by[k].rssMb += x.rss / 1024; by[k].cpuS += x.t; by[k].n += 1; }
  for (const v of Object.values(by)) v.rssMb = Math.round(v.rssMb);
  return { total: Math.round(mine.reduce((a, x) => a + x.rss, 0) / 1024), cpuS: mine.reduce((a, x) => a + x.t, 0), by };
}

let st = null;
const t0 = Date.now();
for (let i = 0; i < 900; i += 1) {
  try { st = (await getJson(base, '/api/state')).body; if (st.head.ticks >= 10 && st.stream.state === 'live') break; } catch { /* booting */ }
  await sleep(200);
}
ok(st && st.console.state === 'playing', `console tab playing in the headed browser on Xvfb (${st?.console.state})`, `${((Date.now() - t0) / 1000).toFixed(0)} s to first ticks`);
const h0 = (await getJson(base, '/api/health')).body;
const m0 = tree(child.pid);
const c0 = m0.cpuS; const w0 = Date.now(); const k0 = st.head.ticks;
await sleep(30000);
const st2 = (await getJson(base, '/api/state')).body;
const m1 = tree(child.pid);
const secs = (Date.now() - w0) / 1000;
const rate = (st2.head.ticks - k0) / secs;
ok(st2.head.ticks > k0 + 10, `the brain kept playing (${(st2.head.ticks - k0)} ticks in ${secs.toFixed(0)} s = ${rate.toFixed(2)} ticks/s)`);
ok(st2.stream.state === 'live' && st2.stream.fps > 20, `stream live from the display (${st2.stream.fps} fps, ${st2.stream.kbps} kbps, restarts ${st2.stream.restarts})`);
ok(/cloakbrowser|playwright/.test(log), `browser: ${(log.match(/browser up \(([^)]+)\)/) || [])[1]}`);
console.log(`\n  memory (RSS): total ${m1.total} MB ${JSON.stringify(m1.by)}`);
console.log(`  cpu over ${secs.toFixed(0)} s: ${(((m1.cpuS - c0) / secs) * 100).toFixed(0)}% of one core for the whole tree (2 vCPU = 200%)`);
console.log(`  eye: ${h0.brain.eye}; node rss per /api/health: ${h0.memoryMb} MB; loop avg ${st2.loop.avgStepMs} ms/step; last pilot perf: ${JSON.stringify(st2.fly?.perf)}\n`);
fs.writeFileSync(path.join(ROOT, 'data', 'e2e-measure.json'), JSON.stringify({ memory: m1, cpuPct: ((m1.cpuS - c0) / secs) * 100, ticksPerSec: rate, avgStepMs: st2.loop.avgStepMs, perf: st2.fly?.perf, stream: st2.stream }, null, 1));

child.kill('SIGTERM'); // the app (exec'd by the entrypoint) gets it, as on Railway
const code = await Promise.race([new Promise((r) => child.on('exit', (c) => r(c))), sleep(25000).then(() => 'timeout')]);
ok(code === 0, `SIGTERM -> clean exit (${code})`);
try { process.kill(-child.pid, 'SIGKILL'); } catch { /* all gone */ }
const pr = JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-show_entries', 'stream=codec_name,width,height,nb_read_frames', '-of', 'json', out], { encoding: 'utf8' }).stdout || '{}');
const v = pr.streams?.find((s) => s.width);
ok(v && v.codec_name === 'h264' && v.width === 1280 && Number(v.nb_read_frames) > 25 * 30, `the stream file is H.264 1280x720, ${v?.nb_read_frames} frames (~${Math.round((v?.nb_read_frames || 0) / 30)} s at 30 fps)`);
// the game must fill the streamed picture: count frames whose bottom-right corner is
// blank white (the page drawn shrunk into the top-left, which a scaled CDP capture causes)
const corner = spawnSync('ffmpeg', ['-v', 'error', '-i', out, '-vf', 'crop=40:40:1200:640,scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1 << 24 }).stdout;
const blank = [...corner].filter((px) => px > 245).length;
ok(blank / corner.length < 0.02, `the game fills the streamed picture (${blank} of ${corner.length} frames with a blank corner)`);
const y = spawnSync('ffmpeg', ['-hide_banner', '-ss', '15', '-i', out, '-frames:v', '1', '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YAVG', '-f', 'null', '-'], { encoding: 'utf8' });
const shot = path.join(ROOT, 'data', 'e2e-frame.jpg');
spawnSync('ffmpeg', ['-v', 'error', '-y', '-ss', '15', '-i', out, '-frames:v', '1', shot]);
ok(Number((y.stderr.match(/YAVG=([\d.]+)/) || [])[1]) > 5, `the streamed picture is not blank (frame saved to data/e2e-frame.jpg)`);
if (!R.every((r) => r.ok)) console.log(log.slice(-4000));
await mock.close();
fs.rmSync(dataDir, { recursive: true, force: true });
finish(R, 'service-e2e');
process.exit(process.exitCode || 0);
