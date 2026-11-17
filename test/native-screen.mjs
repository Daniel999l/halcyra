/**
 * The native eye (src/native/screen.js).
 *
 *   A. REAL ffmpeg (x11grab) on a real Xvfb display showing a known picture
 *      (ffplay draws it): frame size, her grid equals the browser eye's grid
 *      of the same picture (src/eye.js luminanceGrid), JPEG for /api/frame.jpg
 *      from the same ffmpeg (fd 3, and the file fallback), the picture
 *      changes -> the eye follows, ffmpeg killed -> restarted with backoff.
 *   B. A stand-in ffmpeg (test/native/fake-ffmpeg.mjs) that writes numbered
 *      frames in bursts: only the newest frame is kept, a torn write is put
 *      back together, an input that never gives a frame is swapped for the
 *      next one (as ddagrab -> gdigrab on Windows).
 * Part A is skipped (and says so) if Xvfb, ffmpeg or ffplay are missing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Screen, FRAME_BYTES, splitJpegs, captureOrder, screenArgs } from '../src/native/screen.js';
import { GRID_W, GRID_H, luminanceGrid, gridDiff } from '../src/eye.js';
import { check, finish } from './service-fixtures.mjs';
import { say } from '../src/log.js';

say.quiet = true;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..');
const DATA = path.join(ROOT, 'data'); fs.mkdirSync(DATA, { recursive: true });
const FAKE = path.join(HERE, 'native', 'fake-ffmpeg.mjs');
const R = []; const ok = check(R);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (f, ms) => { const t = Date.now(); while (Date.now() - t < ms) { if (await f()) return true; await sleep(50); } return false; };
const has = (bin) => spawnSync('sh', ['-c', `command -v ${bin}`]).status === 0;
console.log('native-screen\n');

// ---- pure parts
ok(JSON.stringify(captureOrder('auto', 'win32')) === '["ddagrab","gdigrab"]' && JSON.stringify(captureOrder('auto', 'linux')) === '["x11grab"]' && JSON.stringify(captureOrder('gdigrab', 'win32')) === '["gdigrab"]', 'capture order: win32 ddagrab then gdigrab, linux x11grab, an explicit CAPTURE wins');
const wa = screenArgs({ kind: 'ddagrab', fps: 10 }).join(' ');
ok(wa.includes('-f lavfi -i ddagrab=output_idx=0:draw_mouse=0:framerate=10') && wa.includes('hwdownload,format=bgra,split=2') && wa.includes(`scale=${GRID_W}:${GRID_H}:flags=area,format=rgb24`) && wa.includes('pipe:3'), 'Windows args: ddagrab -> hwdownload -> eye 160x90 rgb24 on stdout + JPEG on fd 3');
ok(screenArgs({ kind: 'gdigrab' }).join(' ').includes('-f gdigrab -draw_mouse 0 -framerate 10 -i desktop'), 'gdigrab fallback args');
{
  const a = Buffer.from([0xff, 0xd8, 1, 2, 0xff, 0xd9]); const b = Buffer.from([0xff, 0xd8, 3, 0xff, 0xd9]);
  const r = splitJpegs(Buffer.concat([Buffer.from([9]), a, b, Buffer.from([0xff, 0xd8, 7])]));
  ok(r.jpegs.length === 2 && r.jpegs[1].equals(b) && r.rest.equals(Buffer.from([0xff, 0xd8, 7])), 'JPEG splitter: whole images out, a partial one kept for the next read');
}

// ---- the Windows stream (src/stream.js desktop mode): arguments and the picks, no Windows needed
{
  const { ffmpegArgs, pickAudio, pickEncoder, dshowAudioDevices } = await import('../src/stream.js');
  const w = ffmpegArgs({ url: 'rtmp://x/live/key', mode: 'desktop', input: 'ddagrab', encoder: 'h264_nvenc', audio: 'silent', size: '1280x720', fps: 30, kbps: 2500 }).join(' ');
  ok(w.includes('-f lavfi -i ddagrab=output_idx=0:draw_mouse=0:framerate=30') && w.includes('-vf hwdownload,format=bgra,scale=1280:720') && w.includes('-c:v h264_nvenc') && w.includes('-b:v 2500k') && w.includes('-g 60') && w.includes('anullsrc') && w.includes('-c:a aac') && w.endsWith('-f flv rtmp://x/live/key'), 'desktop stream args: ddagrab -> 1280x720 h264_nvenc 2500k, keyframe every 60 frames (2 s), silent AAC, FLV');
  const g = ffmpegArgs({ url: 'out.flv', mode: 'desktop', input: 'gdigrab', encoder: 'libx264', audio: 'dshow:CABLE Output (VB-Audio Virtual Cable)' });
  ok(g.join(' ').includes('-f gdigrab') && g.includes('audio=CABLE Output (VB-Audio Virtual Cable)') && g.join(' ').includes('-c:v libx264 -preset veryfast'), 'gdigrab + libx264 fallback + a dshow loopback device as one argument');
  ok(await pickAudio('auto', 'ffmpeg', 'linux') === 'silent' && await pickAudio('silent', 'x', 'win32') === 'silent' && await pickAudio('dshow:Foo', 'x', 'win32') === 'dshow:Foo', 'audio pick: Linux silent, explicit values kept');
  // a stand-in ffmpeg that prints a Windows dshow device list
  const fakeList = path.join(DATA, 'fake-dshow-ffmpeg.sh');
  fs.writeFileSync(fakeList, `#!/bin/sh\ncat >&2 <<'X'\n[dshow @ 000001] "Integrated Camera" (video)\n[dshow @ 000001]   Alternative name "@device_pnp_x"\n[dshow @ 000001] "Microphone (Realtek Audio)" (audio)\n[dshow @ 000001] "CABLE Output (VB-Audio Virtual Cable)" (audio)\nX\nexit 1\n`, { mode: 0o755 });
  const devs = await dshowAudioDevices(fakeList);
  ok(devs.join('|') === 'Microphone (Realtek Audio)|CABLE Output (VB-Audio Virtual Cable)', `dshow device list parsed: ${devs.join(' | ')}`);
  ok(await pickAudio('auto', fakeList, 'win32') === 'dshow:CABLE Output (VB-Audio Virtual Cable)', 'audio auto on Windows: the loopback device is picked, not the microphone');
  fs.writeFileSync(fakeList, '#!/bin/sh\necho \'[dshow @ 1] "Microphone (Realtek Audio)" (audio)\' >&2\nexit 1\n');
  ok(await pickAudio('auto', fakeList, 'win32') === 'silent', 'no loopback device -> silent AAC');
  ok(await pickEncoder('auto', 'ffmpeg') === 'libx264', 'encoder auto here (no NVIDIA GPU) -> libx264');
  fs.rmSync(fakeList, { force: true });
}

// ---- A. real ffmpeg on Xvfb
const canA = has('Xvfb') && has('ffmpeg') && has('ffplay');
if (!canA) console.log('  (part A skipped: needs Xvfb, ffmpeg and ffplay)');
else {
  const DISP = ':93';
  const xvfb = spawn('Xvfb', [DISP, '-screen', '0', '1280x720x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
  await sleep(800);
  // two known pictures: left half black / right half white, and a vertical grey ramp
  const pic1 = path.join(DATA, 'native-test-half.png'); const pic2 = path.join(DATA, 'native-test-ramp.png');
  spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'color=black:s=640x720', '-f', 'lavfi', '-i', 'color=white:s=640x720', '-filter_complex', 'hstack,format=rgb24', '-frames:v', '1', pic1]);
  spawnSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', "nullsrc=s=1280x720,geq=lum='Y*255/720':cb=128:cr=128,format=rgb24", '-frames:v', '1', pic2]);
  let viewer = null;
  const show = async (pic) => {
    const old = viewer;
    viewer = spawn('ffplay', ['-loglevel', 'error', '-an', '-noborder', '-left', '0', '-top', '0', '-x', '1280', '-y', '720', pic], { stdio: 'ignore', env: { ...process.env, DISPLAY: DISP, SDL_AUDIODRIVER: 'dummy' } });
    await sleep(1200);
    if (old) old.kill('SIGKILL');
  };
  try {
    await show(pic1);
    const jpegs = []; const states = [];
    const scr = new Screen({ display: DISP, fps: 10, jpegFps: 2, jpegWidth: 640, onJpeg: (b) => jpegs.push(b), onStatus: (s) => states.push(s.state) });
    scr.start();
    const got = await scr.waitFrame(10000);
    ok(got && scr.kind === 'x11grab', 'real ffmpeg x11grab: first eye frame arrives');
    await sleep(1500);
    ok(scr.frame.length === FRAME_BYTES && FRAME_BYTES === 160 * 90 * 3, `frame is ${GRID_W} x ${GRID_H} rgb24 (${scr.frame.length} bytes)`);
    const g = scr.look();
    ok(g instanceof Float32Array && g.length === GRID_W * GRID_H, 'look() -> Float32Array(160 * 90), the shape the brain takes');
    // the browser eye's grid of the very same picture (the png path)
    const ref = luminanceGrid(fs.readFileSync(pic1));
    const d = gridDiff(g, ref);
    let lo = 0; let hi = 0; for (let y = 0; y < GRID_H; y += 1) { lo += g[y * GRID_W + 10]; hi += g[y * GRID_W + 150]; }
    ok(d < 0.01, `same grid as src/eye.js luminanceGrid() of the same picture (mean abs diff ${d.toFixed(5)})`);
    ok(lo / GRID_H < 0.01 && hi / GRID_H > 0.99, `value range 0..1: black side ${(lo / GRID_H).toFixed(3)}, white side ${(hi / GRID_H).toFixed(3)}`);
    const fps0 = scr.frames; await sleep(2000); const rate = (scr.frames - fps0) / 2;
    ok(rate >= 7 && rate <= 12, `about EYE_FPS frames a second (${rate.toFixed(1)}/s at 10)`);
    // JPEG from the same ffmpeg
    const j = scr.jpeg;
    const sof = j ? j.indexOf(Buffer.from([0xff, 0xc0])) : -1;
    const jw = sof > 0 ? j.readUInt16BE(sof + 7) : 0; const jh = sof > 0 ? j.readUInt16BE(sof + 5) : 0;
    ok(j && j[0] === 0xff && j[1] === 0xd8 && jw === 640 && jh === 360, `JPEG for /api/frame.jpg from the same grab (fd 3): ${jw}x${jh}, ${j?.length} bytes, ${jpegs.length} so far`);
    fs.writeFileSync(path.join(DATA, 'native-screen.jpg'), j || Buffer.alloc(0));
    const procs = String(spawnSync('ps', ['-eo', 'comm=,args='], { encoding: 'utf8' }).stdout.split('\n').filter((l) => /^ffmpeg\s/.test(l) && l.includes('x11grab') && l.includes(DISP)).length);
    ok(procs === '1', `one capture process for eye + JPEG (${procs} ffmpeg grabbing ${DISP})`);
    // the picture changes -> she sees it
    await show(pic2);
    await sleep(600);
    const g2 = scr.look(); const ref2 = luminanceGrid(fs.readFileSync(pic2));
    const top = g2[5 * GRID_W + 80]; const bottom = g2[85 * GRID_W + 80];
    ok(gridDiff(g2, ref2) < 0.01 && bottom - top > 0.8, `new picture -> new grid (ramp: top ${top.toFixed(2)}, bottom ${bottom.toFixed(2)}, diff to ref ${gridDiff(g2, ref2).toFixed(5)})`);
    // restart: kill ffmpeg under it
    const oldPid = scr.proc.pid; const n0 = scr.frames;
    scr.proc.kill('SIGKILL');
    const back = await until(() => scr.proc && scr.proc.pid !== oldPid && scr.frames > n0 + 5, 8000);
    ok(back && scr.restarts >= 1 && states.includes('restarting'), `ffmpeg killed -> restarted (${scr.restarts}) and frames flow again`);
    await scr.stop();
    ok(!scr.proc && scr.status.state === 'off', 'stop(): ffmpeg gone');

    // the file fallback for the JPEG (FRAME_PIPE=file)
    const scr2 = new Screen({ display: DISP, fps: 5, jpegFps: 2, jpegMode: 'file', dataDir: DATA });
    scr2.start();
    const gotJ = await until(() => scr2.jpeg, 8000);
    ok(gotJ && scr2.jpeg[0] === 0xff && scr2.frame?.length === FRAME_BYTES, `FRAME_PIPE=file: JPEG read back from data/native-frame.jpg (${scr2.jpeg?.length} bytes), eye frames still on stdout`);
    await scr2.stop();
  } finally {
    viewer?.kill('SIGKILL');
    xvfb.kill('SIGKILL');
  }
}

// ---- B. stand-in ffmpeg: numbered frames
{
  const scr = new Screen({ ffmpeg: process.execPath, capture: 'x11grab', args: () => [FAKE, 'burst'] });
  scr.start();
  await until(() => scr.frames >= 15, 5000);
  // the fake writes bursts of 5 frames in one write; each frame is filled with its number
  ok(scr.frames >= 15 && scr.frame[0] % 5 === 4 && scr.frame.every((v) => v === scr.frame[0]), `newest only: ${scr.frames} frames came, the kept one is the last of its burst (#${scr.frame[0]})`);
  ok(scr.seq < scr.frames, `older frames dropped (${scr.frames} frames, ${scr.seq} kept in turn)`);
  await scr.stop();
}
{
  // torn writes: a frame split over several writes, and a write that ends mid-frame
  const scr = new Screen({ ffmpeg: process.execPath, capture: 'x11grab', args: () => [FAKE, 'torn'] });
  scr.start();
  await until(() => scr.frames >= 6, 5000);
  ok(scr.frames >= 6 && scr.frame.every((v) => v === scr.frame[0]), `torn writes are put back together (${scr.frames} whole frames, kept #${scr.frame[0]})`);
  await scr.stop();
}
{
  // Windows behaviour: the first input gives no frame (exits) -> the next input
  const scr = new Screen({ ffmpeg: process.execPath, capture: 'auto', args: (kind) => [FAKE, kind === 'ddagrab' ? 'die' : 'burst'] });
  scr.order = captureOrder('auto', 'win32'); scr.kind = scr.order[0];
  scr.start();
  await until(() => scr.frames > 0, 5000);
  ok(scr.kind === 'gdigrab' && scr.frames > 0, `first input died without a frame -> next input (${scr.kind}) took over`);
  await scr.stop();
}
{
  const scr = new Screen({ ffmpeg: process.execPath, capture: 'auto', firstFrameMs: 800, args: (kind) => [FAKE, kind === 'ddagrab' ? 'silent' : 'burst'] });
  scr.order = captureOrder('auto', 'win32'); scr.kind = scr.order[0];
  scr.start();
  await until(() => scr.frames > 0, 5000);
  ok(scr.kind === 'gdigrab' && scr.frames > 0, 'first input runs but never gives a frame -> killed after firstFrameMs, next input took over');
  await scr.stop();
}

finish(R, 'native-screen');
