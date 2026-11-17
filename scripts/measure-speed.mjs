#!/usr/bin/env node
/**
 * How many looks per second she gets, production-shaped: docker-entrypoint.sh
 * (Xvfb) -> node src/index.js, headed browser on the mock console, the stream
 * grabbing the display into a local file. One run per BRAIN_MS value.
 *
 *   node scripts/measure-speed.mjs [--brain 160,80,40] [--seconds 60] [--step 40] [--json data/speed.json]
 *
 * STEP_MS is set low (default 40) so the loop period never caps the rate:
 * what is measured is how fast she can actually look and act.
 * Reported per run: looks/s, ms per look (capture, brain wall, brain compute,
 * pad), brain time per wall second, event loop worst lag, CPU % of one core
 * and RSS for node, Chrome, ffmpeg, Xvfb.
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { serveMock } from '../test/mock-console/serve.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const BRAINS = arg('brain', '160,80,40').split(',').map(Number);
const SECONDS = Number(arg('seconds', 60));
const STEP = Number(arg('step', 40));
const JSON_OUT = arg('json', path.join(ROOT, 'data', 'speed.json'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
const getJson = async (u) => (await fetch(u)).json();

function tree(pid) {
  const r = spawnSync('ps', ['-eo', 'pid,ppid,rss,times,comm', '--no-headers'], { encoding: 'utf8' });
  const rows = r.stdout.trim().split('\n').map((l) => l.trim().split(/\s+/)).map(([p, pp, rss, t, ...c]) => ({ pid: +p, ppid: +pp, rss: +rss, t: +t, comm: c.join(' ') }));
  const keep = new Set([pid]); let grew = true;
  while (grew) { grew = false; for (const x of rows) if (keep.has(x.ppid) && !keep.has(x.pid)) { keep.add(x.pid); grew = true; } }
  const by = {};
  for (const x of rows.filter((y) => keep.has(y.pid))) {
    const k = /node|MainThread/.test(x.comm) ? 'node' : /Xvfb/.test(x.comm) ? 'Xvfb' : /ffmpeg/.test(x.comm) ? 'ffmpeg' : /chrom|chrome/i.test(x.comm) ? 'chrome' : x.comm;
    by[k] = by[k] || { rssMb: 0, cpuS: 0 }; by[k].rssMb += x.rss / 1024; by[k].cpuS += x.t;
  }
  return by;
}
// `ps times` has 1 s resolution; read utime+stime from /proc for the CPU deltas
function cpuTicks(pid) {
  const r = spawnSync('ps', ['-eo', 'pid,ppid,comm', '--no-headers'], { encoding: 'utf8' });
  const rows = r.stdout.trim().split('\n').map((l) => l.trim().split(/\s+/)).map(([p, pp, ...c]) => ({ pid: +p, ppid: +pp, comm: c.join(' ') }));
  const keep = new Set([pid]); let grew = true;
  while (grew) { grew = false; for (const x of rows) if (keep.has(x.ppid) && !keep.has(x.pid)) { keep.add(x.pid); grew = true; } }
  const by = {};
  for (const x of rows.filter((y) => keep.has(y.pid))) {
    let st; try { st = fs.readFileSync(`/proc/${x.pid}/stat`, 'utf8'); } catch { continue; }
    const f = st.slice(st.lastIndexOf(')') + 2).split(' ');
    const k = /node|MainThread/.test(x.comm) ? 'node' : /Xvfb/.test(x.comm) ? 'Xvfb' : /ffmpeg/.test(x.comm) ? 'ffmpeg' : /chrom|chrome/i.test(x.comm) ? 'chrome' : x.comm;
    by[k] = (by[k] || 0) + Number(f[11]) + Number(f[12]);
  }
  return by;
}

const mock = await serveMock(0);
const results = [];
for (const brainMs of BRAINS) {
  const port = await freePort();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyra-speed-'));
  const out = path.join(dataDir, 'stream.flv');
  const env = {
    PATH: process.env.PATH, HOME: process.env.HOME, PORT: String(port), DATA_DIR: dataDir, DISPLAY_NUM: String(80 + results.length),
    CONSOLE_URL: mock.url, STREAM_URL: out, HEADLESS: 'false', BRAIN_MS: String(brainMs), STEP_MS: String(STEP), SEED: '783',
    CLOAKBROWSER_CACHE_DIR: process.env.CLOAKBROWSER_CACHE_DIR || '/tmp/cloakbrowser', CLOAKBROWSER_SUPPRESS_FONT_WARNING: '1',
    ...(process.env.CHROME_PATH ? { CHROME_PATH: process.env.CHROME_PATH } : {}),
    ...(process.env.BROWSER_ARGS ? { BROWSER_ARGS: process.env.BROWSER_ARGS } : {}),
  };
  const child = spawn(path.join(ROOT, 'docker-entrypoint.sh'), ['node', 'src/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let log = ''; child.stdout.on('data', (d) => { log += d; }); child.stderr.on('data', (d) => { log += d; });
  const base = `http://127.0.0.1:${port}`;
  let st = null;
  for (let i = 0; i < 600; i += 1) {
    try { st = await getJson(`${base}/api/state`); if (st.head.ticks >= 15 && st.stream.state === 'live') break; } catch { /* booting */ }
    await sleep(200);
  }
  await sleep(5000); // warm
  const s0 = await getJson(`${base}/api/state`); const c0 = cpuTicks(child.pid); const w0 = Date.now();
  // sample per-look perf while it runs
  const perf = [];
  const t0 = Date.now();
  while (Date.now() - t0 < SECONDS * 1000) {
    const s = await getJson(`${base}/api/state`).catch(() => null);
    if (s?.fly?.perf) perf.push(s.fly.perf);
    await sleep(1000);
  }
  const s1 = await getJson(`${base}/api/state`); const c1 = cpuTicks(child.pid); const mem = tree(child.pid);
  const h1 = await getJson(`${base}/api/health`);
  const secs = (Date.now() - w0) / 1000;
  const looks = (s1.head.ticks - s0.head.ticks) / secs;
  const hz = os.constants?.signals ? 100 : 100; // USER_HZ
  const cpu = {}; for (const k of Object.keys(c1)) cpu[k] = Math.round(((c1[k] - (c0[k] || 0)) / hz / secs) * 100);
  const avg = (k) => +(perf.reduce((a, p) => a + (p[k] ?? 0), 0) / Math.max(1, perf.length)).toFixed(1);
  const r = {
    brainMs, looksPerSec: +looks.toFixed(2), msPerLook: +(1000 / looks).toFixed(0),
    perfSampled: { capture: avg('capture'), brain: avg('brain'), pad: avg('pad'), total: avg('total') },
    brainSecondsPerWallSecond: +((looks * brainMs) / 1000).toFixed(3),
    eventLoopLagMs: h1.loop.eventLoopLagMs, stream: { state: s1.stream.state, fps: s1.stream.fps, kbps: s1.stream.kbps },
    cpuPctOfOneCore: { ...cpu, total: Object.values(cpu).reduce((a, b) => a + b, 0) },
    rssMb: Object.fromEntries(Object.entries(mem).map(([k, v]) => [k, Math.round(v.rssMb)])),
    eye: h1.brain.eye, eyePath: s1.fly?.eyePath, eyeFallbacks: s1.fly?.eyeFallbacks, thread: h1.brain.thread, view: s1.view?.state, loopErrors: s1.loop.errors,
    browser: (log.match(/browser up \(([^)]+)\)/) || [])[1] || null, browserArgs: process.env.BROWSER_ARGS || '',
  };
  r.rssMb.total = Object.values(r.rssMb).reduce((a, b) => a + b, 0);
  results.push(r);
  console.log(JSON.stringify(r));
  child.kill('SIGTERM');
  await Promise.race([new Promise((res) => child.on('exit', res)), sleep(20000)]);
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ }
  const pr = JSON.parse(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name,width,height', '-of', 'json', out], { encoding: 'utf8' }).stdout || '{}');
  r.streamFile = pr.streams?.find((x) => x.width) || null;
  if (!r.streamFile) console.log(log.slice(-2000));
  fs.rmSync(dataDir, { recursive: true, force: true });
  await sleep(3000);
}
await mock.close();
fs.writeFileSync(JSON_OUT, JSON.stringify({ at: new Date().toISOString(), cpus: os.cpus().length, stepMs: STEP, seconds: SECONDS, results }, null, 1));
console.log(`\n| BRAIN_MS | looks/s | ms per look | brain wall ms | capture ms | brain s per wall s | loop lag max ms | CPU % (node / chrome / ffmpeg / Xvfb / total) | RSS MB total |`);
for (const r of results) console.log(`| ${r.brainMs} | ${r.looksPerSec} | ${r.msPerLook} | ${r.perfSampled.brain} | ${r.perfSampled.capture} | ${r.brainSecondsPerWallSecond} | ${r.eventLoopLagMs?.max} | ${r.cpuPctOfOneCore.node} / ${r.cpuPctOfOneCore.chrome} / ${r.cpuPctOfOneCore.ffmpeg} / ${r.cpuPctOfOneCore.Xvfb} / ${r.cpuPctOfOneCore.total} | ${r.rssMb.total} |`);
process.exit(0);
