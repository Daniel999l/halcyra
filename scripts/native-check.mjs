/**
 * Self-test for the native console. Run it ON THE WINDOWS PC, from the repo
 * folder, with the game open (or at least the desktop showing):
 *
 *   node scripts/native-check.mjs
 *
 * Checks, in order, one PASS / FAIL line each:
 *   1. node version (>= 20)
 *   2. ffmpeg found, and which desktop capture input works (ddagrab, gdigrab)
 *   3. NVENC (h264_nvenc encodes on this GPU)
 *   4. python + `import vgamepad`
 *   5. the ViGEm virtual pad is created (the feeder says "ready")
 *   6. a 3 second stick sweep is sent to it
 *   7. 5 eye frames arrive (size, mean brightness; saved to data/native-check.png
 *      at her own 160 x 90, and data/native-check.jpg at 640 wide)
 *   8. a 5 second stream encode to a local file (data/native-check.flv)
 * Exit code 0 only if every check passed.
 *
 * Options: --dry-pad  use the feeder's --dry mode (no ViGEm; for trying the
 * script on a machine without it). Settings: FFMPEG_PATH, PYTHON, PAD_FEEDER,
 * CAPTURE, STREAM_ENCODER, STREAM_AUDIO as for the service.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { cfg } from '../src/config.js';
import { NativePad, defaultFeeder, FEEDER_PY } from '../src/native/pad.js';
import { splitCmd } from '../src/native/console.js';
import { Screen, captureOrder, captureInput, FRAME_BYTES } from '../src/native/screen.js';
import { Streamer, runFfmpeg, nvencWorks, pickAudio } from '../src/stream.js';
import { GRID_W, GRID_H } from '../src/eye.js';
import { say } from '../src/log.js';

say.quiet = true;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DRY = process.argv.includes('--dry-pad');
const ff = cfg.stream.ffmpeg || 'ffmpeg';
const results = [];
function line(ok, name, detail = '') {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
  return ok;
}
console.log(`native-check on ${process.platform} ${process.arch}${DRY ? ' (dry pad)' : ''}\n`);

// 1. node
const major = Number(process.versions.node.split('.')[0]);
line(major >= 20, 'node version', `v${process.versions.node}, need >= 20`);

// 2. ffmpeg + capture
const ver = await runFfmpeg(ff, ['-hide_banner', '-version'], 10000);
const ffOk = line(ver.code === 0, 'ffmpeg found', ver.code === 0 ? ver.out.split('\n')[0].slice(0, 90) : `"${ff}" did not run: ${ver.out.slice(0, 120)} (set FFMPEG_PATH or run scripts/setup-windows.ps1)`);
let capture = null;
if (ffOk) {
  const tried = [];
  for (const kind of captureOrder(cfg.native.capture)) {
    const inp = captureInput(kind, { fps: 10, display: cfg.stream.display || process.env.DISPLAY || ':0' });
    const vf = `${inp.pre ? `${inp.pre},` : ''}scale=160:90`;
    const r = await runFfmpeg(ff, ['-hide_banner', '-loglevel', 'error', ...inp.args, '-frames:v', '3', '-vf', vf, '-f', 'null', '-'], 20000);
    tried.push(`${kind}: ${r.code === 0 ? 'works' : `no (${r.out.trim().split('\n').slice(-1)[0]?.slice(0, 80) || r.code})`}`);
    if (r.code === 0) { capture = kind; break; }
  }
  line(Boolean(capture), 'desktop capture input', `${capture ? `using ${capture}` : 'none worked'}; ${tried.join('; ')}`);
} else line(false, 'desktop capture input', 'no ffmpeg');

// 3. NVENC
let nv = false;
if (ffOk) nv = await nvencWorks(ff);
line(nv, 'NVENC (h264_nvenc) encodes here', nv ? 'the stream will use the GPU' : 'not available: the stream falls back to libx264 (CPU). Needs an ffmpeg built with nvenc and an NVIDIA driver');

// 4. python + vgamepad
const feeder = cfg.native.feeder ? splitCmd(cfg.native.feeder) : defaultFeeder({ python: cfg.native.python });
if (DRY && !cfg.native.feeder) feeder.args = ['-u', FEEDER_PY, '--dry'];
const py = cfg.native.feeder ? null : feeder.command;
if (py) {
  const v = spawnSync(py, ['--version'], { encoding: 'utf8', windowsHide: true });
  const vg = spawnSync(py, ['-c', 'import vgamepad, sys; print(getattr(vgamepad, "__version__", "?"))'], { encoding: 'utf8', windowsHide: true });
  const pyVer = (v.stdout || v.stderr || '').trim();
  line(v.status === 0, 'python found', v.status === 0 ? pyVer : `"${py}" did not run (set PYTHON)`);
  line(vg.status === 0 || DRY, 'import vgamepad', vg.status === 0 ? `vgamepad ${vg.stdout.trim()}` : `${(vg.stderr || '').trim().split('\n').slice(-1)[0] || 'failed'}${DRY ? ' (ignored: --dry-pad)' : ' -> pip install vgamepad'}`);
} else line(true, 'python + vgamepad', `PAD_FEEDER is set (${feeder.command}); not checked separately`);

// 5. pad created  6. stick sweep
const pad = new NativePad({ ...feeder, hz: 60 });
pad.start();
let padUp = false;
try { await pad.whenReady(20000); padUp = true; } catch (e) { /* reported below */ }
line(padUp, 'ViGEm virtual pad created', padUp ? `feeder ready${DRY ? ' (dry)' : '; Windows "Set up USB game controllers" should list an Xbox 360 Controller'}` : (pad.lastError || 'the feeder did not say ready'));
if (padUp) {
  const t0 = Date.now(); const lines0 = pad.lines; let k = 0;
  while (Date.now() - t0 < 3000) {
    const ph = (Date.now() - t0) / 3000 * Math.PI * 2;
    pad.setPad({ axes: [Math.sin(ph), Math.cos(ph), 0, 0], buttons: { rt: (Math.sin(ph) + 1) / 2 } });
    k += 1; await sleep(16);
  }
  pad.neutral(); await sleep(100);
  const sent = pad.lines - lines0;
  line(sent >= 60 && pad.restarts === 0 && pad.ready, '3 second stick sweep sent', `${sent} pad updates, ${pad.restarts} feeder restarts`);
} else line(false, '3 second stick sweep sent', 'no pad');
await pad.close();

// 7. eye frames
if (capture) {
  const scr = new Screen({ ffmpeg: ff, capture, fps: cfg.native.eyeFps, jpegFps: 2, jpegWidth: cfg.native.jpegWidth, jpegMode: cfg.native.jpegMode, dataDir: cfg.dataDir, display: cfg.stream.display || process.env.DISPLAY || ':0' });
  scr.start();
  const t0 = Date.now();
  while (scr.frames < 5 && Date.now() - t0 < 20000) await sleep(50);
  const jWait = Date.now(); while (!scr.jpeg && Date.now() - jWait < 3000) await sleep(50);
  const g = scr.look();
  let mean = 0; if (g) { for (const v of g) mean += v; mean /= g.length; }
  if (scr.frame) fs.writeFileSync(path.join(cfg.dataDir, 'native-check.png'), pngRgb(GRID_W, GRID_H, scr.frame));
  if (scr.jpeg) fs.writeFileSync(path.join(cfg.dataDir, 'native-check.jpg'), scr.jpeg);
  const okFrames = scr.frames >= 5 && scr.frame?.length === FRAME_BYTES;
  line(okFrames, '5 eye frames received', okFrames ? `${GRID_W}x${GRID_H} rgb24, mean brightness ${mean.toFixed(3)} (0 black .. 1 white)${mean < 0.02 ? ' WARNING: almost black, is the screen locked or the game minimised?' : ''}; saved data/native-check.png` : `${scr.frames} frames in 20 s${scr.lastError ? `: ${scr.lastError}` : ''}`);
  line(Boolean(scr.jpeg), 'frame JPEG for /api/frame.jpg', scr.jpeg ? `${scr.jpeg.length} bytes via ${cfg.native.jpegMode === 'file' ? 'file' : 'fd 3'}; saved data/native-check.jpg` : `none came${cfg.native.jpegMode === 'file' ? '' : ' (try FRAME_PIPE=file)'}`);
  await scr.stop();
} else {
  line(false, '5 eye frames received', 'no capture input works');
}

// 8. 5 second stream encode to a file
if (ffOk && capture) {
  const out = path.join(cfg.dataDir, 'native-check.flv');
  fs.rmSync(out, { force: true });
  const mode = process.platform === 'win32' ? 'desktop' : 'x11';
  const audio = await pickAudio(cfg.stream.audio, ff);
  const st = new Streamer({ ...cfg.stream, url: out, mode, input: capture, durationSec: 5, restart: false, audio });
  const code = await new Promise((resolve) => { st.o.onExit = resolve; st.start(); setTimeout(() => resolve('timeout'), 40000); });
  const pr = spawnSync(ff.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1'), ['-v', 'error', '-show_entries', 'stream=codec_type,codec_name,width,height:format=duration', '-of', 'json', out], { encoding: 'utf8', windowsHide: true });
  let info = ''; let good = code === 0 && fs.existsSync(out) && fs.statSync(out).size > 10000;
  try {
    const j = JSON.parse(pr.stdout);
    const v = j.streams.find((s) => s.codec_type === 'video'); const a = j.streams.find((s) => s.codec_type === 'audio');
    info = `${v?.codec_name} ${v?.width}x${v?.height}, ${a?.codec_name} audio, ${Number(j.format.duration).toFixed(1)} s`;
    good = good && v?.codec_name === 'h264' && a?.codec_name === 'aac';
  } catch { info = `${fs.existsSync(out) ? fs.statSync(out).size : 0} bytes (no ffprobe to look inside)`; }
  line(good, '5 second stream encode to data/native-check.flv', `exit ${code}; encoder ${st.encoder}; audio ${st.audio}; ${info}${st.status.lastError ? `; ${st.status.lastError}` : ''}`);
} else line(false, '5 second stream encode', 'needs ffmpeg and a working capture input');

const bad = results.filter((r) => !r).length;
console.log(`\n${results.length - bad}/${results.length} passed${bad ? '' : ': this PC is ready for CONSOLE_KIND=native'}`);
process.exit(bad ? 1 : 0);

/** a plain RGB PNG (no dependencies) */
function pngRgb(w, h, rgb) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y += 1) rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
  const crcT = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
  const crc = (b) => { let c = -1; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
  const chunk = (type, data) => { const t = Buffer.from(type); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
