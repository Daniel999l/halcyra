/**
 * The livestream pipeline, pointed at a local file instead of an RTMP server
 * (there is no ingest to hit from here). Same ffmpeg arguments apart from the
 * output, checked with ffprobe:
 *   1. pipe mode: page screenshots fed through stdin, 10 s -> data/test.flv
 *   2. x11 mode: a real Xvfb display with a headed Chrome on it, 10 s -> data/test-x11.flv
 *   3. a dead RTMP target -> ffmpeg exits -> restart with backoff, key never logged
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Streamer, ffmpegArgs } from '../src/stream.js';
import { check, finish } from './service-fixtures.mjs';
import { say, recent } from '../src/log.js';

say.quiet = true;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data'); fs.mkdirSync(DATA, { recursive: true });
const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const R = []; const ok = check(R);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
console.log('service-stream\n');

function probe(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height,avg_frame_rate,sample_rate,channels:format=duration,format_name,bit_rate', '-of', 'json', file], { encoding: 'utf8' });
  return JSON.parse(r.stdout || '{}');
}
function cpuSeconds(pid) {
  try { const f = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' '); return (Number(f[11]) + Number(f[12])) / 100; } catch { return null; }
}
const runFor = (st, secs) => new Promise((resolve) => {
  let cpu = null; let pid = null;
  const poll = setInterval(() => { if (st.proc) { pid = st.proc.pid; const c = cpuSeconds(pid); if (c != null) cpu = c; } }, 200);
  st.o.onExit = (code) => { clearInterval(poll); resolve({ code, cpu, secs }); };
  st.start();
});
const describe = (p) => {
  const v = p.streams?.find((s) => s.codec_type === 'video'); const a = p.streams?.find((s) => s.codec_type === 'audio');
  return { v, a, dur: Number(p.format?.duration), fmt: p.format?.format_name, kbps: Math.round(Number(p.format?.bit_rate) / 1000) };
};

// frames for pipe mode: real screenshots of a moving page, taken with Chrome
const { chromium } = await import('playwright-core');
const browser = await chromium.launch({ headless: true, executablePath: CHROME });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await page.setContent(`<body style="margin:0;background:#123"><div id="b" style="position:absolute;top:300px;width:120px;height:120px;background:#fc0"></div>
<script>let x=0;setInterval(()=>{x=(x+23)%1160;b.style.left=x+'px';document.body.style.background='hsl('+x%360+',50%,25%)'},100)</script></body>`);
let latest = await page.screenshot({ type: 'jpeg', quality: 70 });
let grabbing = true;
(async () => { while (grabbing) { latest = await page.screenshot({ type: 'jpeg', quality: 70 }).catch(() => latest); await sleep(100); } })();

// 1. pipe mode
const out1 = path.join(DATA, 'test.flv'); fs.rmSync(out1, { force: true });
const s1 = new Streamer({ url: out1, mode: 'pipe', size: '1280x720', pipeFps: 10, kbps: 2500, preset: 'veryfast', getFrame: () => latest, durationSec: 10, restart: false });
const r1 = await runFor(s1, 10);
grabbing = false;
const p1 = describe(probe(out1));
console.log(`  pipe: ${JSON.stringify({ video: p1.v && `${p1.v.codec_name} ${p1.v.width}x${p1.v.height} @${p1.v.avg_frame_rate}`, audio: p1.a && `${p1.a.codec_name} ${p1.a.sample_rate}Hz ${p1.a.channels}ch`, duration: p1.dur, kbps: p1.kbps, ffmpegCpuS: r1.cpu })}`);
ok(r1.code === 0 && fs.existsSync(out1), 'pipe mode: ffmpeg wrote data/test.flv and exited 0');
ok(p1.fmt === 'flv' && p1.v?.codec_name === 'h264' && p1.v.width === 1280 && p1.v.height === 720, 'pipe mode: FLV with H.264 1280x720');
ok(p1.a?.codec_name === 'aac' && Number(p1.a.sample_rate) === 44100, 'pipe mode: AAC 44.1 kHz (silent) audio track');
ok(p1.dur >= 9.5 && p1.dur <= 10.6, `pipe mode: ${p1.dur.toFixed(2)} s long`);
await browser.close();

// 2. x11 mode under a real Xvfb with a headed browser on it
const DISP = ':97';
const xvfb = spawn('Xvfb', [DISP, '-screen', '0', '1280x720x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
await sleep(800);
let x11ok = false;
try {
  const b2 = await chromium.launch({ headless: false, executablePath: CHROME, env: { ...process.env, DISPLAY: DISP }, args: ['--kiosk', '--window-size=1280,720', '--window-position=0,0', '--no-sandbox'] });
  const p2 = await b2.newPage({ viewport: { width: 1280, height: 720 } });
  await p2.setContent(`<body style="margin:0;background:#222"><canvas id=c width=1280 height=720></canvas><script>const g=c.getContext('2d');let n=0;(function f(){g.fillStyle='hsl('+(n%360)+',60%,40%)';g.fillRect(0,0,1280,720);g.fillStyle='#fff';g.fillRect((n*7)%1200,320,80,80);n++;requestAnimationFrame(f)})()</script></body>`);
  const out2 = path.join(DATA, 'test-x11.flv'); fs.rmSync(out2, { force: true });
  const s2 = new Streamer({ url: out2, mode: 'x11', display: DISP, size: '1280x720', fps: 30, kbps: 2500, preset: 'veryfast', durationSec: 10, restart: false });
  const r2 = await runFor(s2, 10);
  const pr2 = describe(probe(out2));
  const cpuPct = r2.cpu != null ? Math.round((r2.cpu / 10) * 100) : null;
  console.log(`  x11:  ${JSON.stringify({ video: pr2.v && `${pr2.v.codec_name} ${pr2.v.width}x${pr2.v.height} @${pr2.v.avg_frame_rate}`, audio: pr2.a && `${pr2.a.codec_name}`, duration: pr2.dur, kbps: pr2.kbps, ffmpegCpu: `${cpuPct}% of one core` })}`);
  ok(r2.code === 0 && pr2.v?.codec_name === 'h264' && pr2.v.width === 1280 && pr2.v.height === 720 && pr2.v.avg_frame_rate === '30/1', 'x11 mode: grabbed the Xvfb screen to H.264 1280x720 30 fps');
  ok(pr2.a?.codec_name === 'aac' && pr2.dur >= 9.5 && pr2.dur <= 10.6, `x11 mode: AAC track, ${pr2.dur.toFixed(2)} s long`);
  // a frame from the middle must not be a blank screen
  const png = spawnSync('ffmpeg', ['-hide_banner', '-ss', '5', '-i', out2, '-frames:v', '1', '-vf', 'signalstats,metadata=print:key=lavfi.signalstats.YAVG', '-f', 'null', '-'], { encoding: 'utf8' });
  const yavg = Number((png.stderr.match(/YAVG=([\d.]+)/) || [])[1]);
  ok(yavg > 20, `x11 mode: the picture has the page on it (mean luma ${yavg.toFixed(1)})`);
  x11ok = true;
  await b2.close();
} catch (e) { ok(false, `x11 mode: ${e.message}`); }
xvfb.kill();
void x11ok;

// 3. dead RTMP target: restarts with backoff, never logs the key
const s3 = new Streamer({ url: 'rtmp://127.0.0.1:1/live/SECRETKEY123', mode: 'pipe', pipeFps: 10, getFrame: () => latest });
s3.backoff = 300; // speed the test up; production starts at 2 s
s3.start();
await sleep(3000);
const st3 = { ...s3.status };
await s3.stop();
ok(st3.restarts >= 2 && ['restarting', 'starting'].includes(st3.state), `a dead target -> ffmpeg exits -> restarted (${st3.restarts} restarts, backoff doubling)`);
const leaks = recent(300).filter((r) => r.msg.includes('SECRETKEY123')).map((r) => r.msg);
ok(!leaks.length && !JSON.stringify(st3).includes('SECRETKEY123'), 'the stream key never appears in the log or the status', leaks[0]);
const a = ffmpegArgs({ url: 'rtmp://x/y', mode: 'x11', fps: 30, kbps: 2500 });
ok(a.includes('-g') && a[a.indexOf('-g') + 1] === '60' && a.includes('zerolatency') && a.at(-2) === 'flv', 'RTMP args: keyframe every 2 s, zerolatency, FLV');

finish(R, 'service-stream');
process.exit(process.exitCode || 0);
