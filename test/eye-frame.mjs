/**
 * Her eye, the 'frame' path: fast, sees what the png path sees, and does not
 * touch the visible page.
 *
 *   node test/eye-frame.mjs            (needs Xvfb and ffmpeg for part 3)
 *
 * 1. Speed per look on the mock console (headless Chrome): png, small, frame.
 * 2. Same picture: a still frame of the console shown three ways (a <canvas>,
 *    a playing <video> fed from that canvas, and as the source PNG itself);
 *    the frame grid vs the png grid, mean abs luminance difference on the
 *    160 x 90 grid, as measured for 'small'.
 * 3. Nothing shrinks: a HEADED Chrome on a virtual display (Xvfb), window made
 *    fullscreen the way the service does it, ffmpeg grabbing the display (as
 *    the stream does) while she looks 60 times with 'small' and then with
 *    'frame'. Counted: resize events the page saw, innerWidth changes, and
 *    grabbed frames whose bottom-right corner is blank (the page drawn shrunk
 *    into the top-left).
 */
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { serveMock } from './mock-console/serve.mjs';
import { installPad } from '../src/gamepad.js';
import { Eye, luminanceGrid, gridDiff } from '../src/eye.js';
import { fullscreenWindow } from '../src/browser.js';

const CHROME = process.env.CHROME_PATH || '/usr/bin/google-chrome';
let fails = 0;
const ok = (c, m) => { console.log(`  ${c ? 'ok  ' : 'FAIL'} ${m}`); if (!c) fails += 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const out = {};
console.log('eye-frame\n');

const srv = await serveMock();

// ---------------------------------------------------------------- 1 + 2 headless
{
  const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await installPad(page);
  await page.goto(srv.url);
  await page.waitForTimeout(600);
  await page.evaluate(() => window.__pad.set({ axes: [0.3, 0, 0, 0], buttons: [0, 0, 0, 0, 0, 0, 0, 0.6] }));
  const bench = async (label, eye, n = 40) => {
    for (let i = 0; i < 3; i += 1) await eye.look(page);
    const t = performance.now();
    for (let i = 0; i < n; i += 1) await eye.look(page);
    const ms = (performance.now() - t) / n;
    console.log(`  ${label.padEnd(40)} ${ms.toFixed(1).padStart(6)} ms/look  ${(1000 / ms).toFixed(1).padStart(6)} looks/s`);
    return ms;
  };
  const eyes = { png: await new Eye({ mode: 'png' }).open(page), small: await new Eye({ mode: 'small' }).open(page), frame: await new Eye({ mode: 'frame' }).open(page) };
  out.msPerLook = {};
  out.msPerLook.png = await bench('png   (full screenshot + decode)', eyes.png);
  out.msPerLook.small = await bench('small (CDP clip.scale 1/8 + decode)', eyes.small);
  out.msPerLook.frame = await bench('frame (game element drawn small in page)', eyes.frame);
  ok(eyes.frame.lastPath === 'frame' && eyes.frame.fallbacks === 0, `frame path used on every look (fallbacks ${eyes.frame.fallbacks})`);
  ok(out.msPerLook.frame < out.msPerLook.png / 3, `frame is much faster than png (${out.msPerLook.frame.toFixed(1)} vs ${out.msPerLook.png.toFixed(1)} ms)`);

  // a still picture of the console, three ways
  const still = await page.screenshot({ type: 'png' });
  const ref = luminanceGrid(still);
  const p2 = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const b64 = still.toString('base64');
  await p2.setContent(`<html><body style="margin:0;overflow:hidden;background:#000"><canvas id="c" width="1280" height="720" style="display:block;width:1280px;height:720px"></canvas></body></html>`);
  await p2.evaluate(async (src) => { const im = new Image(); im.src = src; await im.decode(); document.getElementById('c').getContext('2d').drawImage(im, 0, 0); }, `data:image/png;base64,${b64}`);
  await p2.waitForTimeout(100);
  const e2 = await new Eye({ mode: 'frame' }).open(p2);
  const gCanvasFrame = await e2.look(p2);
  const pathCanvas = `${e2.lastPath}:${e2.lastKind}`;
  const gCanvasPng = await new Eye({ mode: 'png' }).open(p2).then((e) => e.look(p2));
  // the same canvas as a live <video> (a console is a video element)
  await p2.evaluate(async () => {
    const c = document.getElementById('c');
    const v = document.createElement('video');
    v.muted = true; v.autoplay = true; v.playsInline = true;
    Object.assign(v.style, { position: 'fixed', left: 0, top: 0, width: '1280px', height: '720px', display: 'block' });
    v.srcObject = c.captureStream(30);
    document.body.appendChild(v);
    // keep the canvas producing frames, hidden behind the video
    const g = c.getContext('2d'); const img = g.getImageData(0, 0, 1280, 720);
    setInterval(() => g.putImageData(img, 0, 0), 33);
    await v.play();
    await new Promise((r) => setTimeout(r, 400));
    c.style.visibility = 'hidden';
  });
  await p2.waitForTimeout(300);
  const e3 = await new Eye({ mode: 'frame' }).open(p2);
  const gVideoFrame = await e3.look(p2);
  const pathVideo = `${e3.lastPath}:${e3.lastKind}`;
  const kindVideo = await p2.evaluate(() => document.querySelector('video').videoWidth);
  const gVideoPng = await new Eye({ mode: 'png' }).open(p2).then((e) => e.look(p2));
  const maxCell = (a, b) => { let m = 0; for (let i = 0; i < a.length; i += 1) m = Math.max(m, Math.abs(a[i] - b[i])); return m; };
  out.diff = {
    canvas: { frameVsSource: gridDiff(gCanvasFrame, ref), pngVsSource: gridDiff(gCanvasPng, ref), frameVsPng: gridDiff(gCanvasFrame, gCanvasPng), maxCell: maxCell(gCanvasFrame, gCanvasPng) },
    video: { frameVsSource: gridDiff(gVideoFrame, ref), pngVsSource: gridDiff(gVideoPng, ref), frameVsPng: gridDiff(gVideoFrame, gVideoPng), maxCell: maxCell(gVideoFrame, gVideoPng) },
  };
  for (const k of ['canvas', 'video']) {
    const d = out.diff[k];
    console.log(`  still picture in a <${k}>: frame vs png ${d.frameVsPng.toFixed(4)} mean abs (max cell ${d.maxCell.toFixed(3)}); frame vs source ${d.frameVsSource.toFixed(4)}, png vs source ${d.pngVsSource.toFixed(4)}`);
  }
  ok(pathCanvas === 'frame:canvas' && pathVideo === 'frame:video' && kindVideo === 1280, `frame path read the <canvas> and the playing <video> directly (${pathCanvas}, ${pathVideo})`);
  ok(out.diff.canvas.frameVsPng < 0.01, `canvas: frame sees the same picture as png (${out.diff.canvas.frameVsPng.toFixed(4)} < 0.01; 'small' was 0.0041 to 0.0048)`);
  ok(out.diff.video.frameVsPng < 0.02, `video: frame sees the same picture as png (${out.diff.video.frameVsPng.toFixed(4)} < 0.02; png vs source ${out.diff.video.pngVsSource.toFixed(4)})`);

  // nothing to look at: falls back to a screenshot, says so
  const p3 = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  await p3.setContent('<html><body style="margin:0;background:#888"></body></html>');
  const e4 = await new Eye({ mode: 'frame' }).open(p3);
  const g4 = await e4.look(p3);
  ok(e4.lastPath === 'png' && e4.lastFallback === 'none' && Math.abs(g4[0] - luminanceGrid(await p3.screenshot({ type: 'png' }))[0]) < 1e-6, `no video or canvas on the page: that look falls back to a screenshot (${e4.lastPath}, ${e4.lastFallback})`);
  await browser.close();
}

// ---------------------------------------------------------------- 3 headed + screen grab
const ffmpeg = process.env.FFMPEG_PATH || 'ffmpeg';
const haveX = spawnSync('which', ['Xvfb']).status === 0 && spawnSync('which', [ffmpeg]).status === 0;
if (!haveX) { ok(false, 'Xvfb and ffmpeg are needed for the headed part'); } else {
  const disp = ':' + (90 + Math.floor(Math.random() * 9));
  const xvfb = spawn('Xvfb', [disp, '-screen', '0', '1280x720x24', '-nolisten', 'tcp'], { stdio: 'ignore' });
  await sleep(800);
  process.env.DISPLAY = disp;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'eyeframe-'));
  const browser = await chromium.launch({ executablePath: CHROME, headless: false, args: ['--no-sandbox', '--disable-dev-shm-usage', '--window-size=1280,720', '--window-position=0,0', '--autoplay-policy=no-user-gesture-required'], env: { ...process.env, DISPLAY: disp } });
  const ctx = await browser.newContext({ viewport: null });
  const page = await ctx.newPage();
  await fullscreenWindow(page);
  await installPad(page);
  await page.goto(srv.url);
  await page.waitForTimeout(1500);
  await page.evaluate(() => { window.__resizes = 0; window.__widths = new Set([innerWidth]); addEventListener('resize', () => { window.__resizes += 1; window.__widths.add(innerWidth); }); });
  await page.evaluate(() => window.__pad.set({ axes: [0.2, 0, 0, 0], buttons: [0, 0, 0, 0, 0, 0, 0, 0.5] }));
  out.headed = {};
  for (const mode of ['small', 'frame']) {
    await page.evaluate(() => { window.__resizes = 0; window.__widths = new Set([innerWidth]); });
    const file = path.join(dir, `${mode}.mkv`);
    const ff = spawn(ffmpeg, ['-v', 'error', '-f', 'x11grab', '-draw_mouse', '0', '-framerate', '30', '-video_size', '1280x720', '-i', `${disp}+0,0`, '-c:v', 'libx264', '-preset', 'ultrafast', '-qp', '0', '-y', file], { stdio: ['pipe', 'ignore', 'pipe'] });
    await sleep(800);
    const eye = await new Eye({ mode, width: 1280, height: 720 }).open(page);
    const t = performance.now();
    for (let i = 0; i < 60; i += 1) { await eye.look(page); await sleep(30); }
    const ms = (performance.now() - t) / 60 - 30;
    await sleep(500);
    ff.stdin.write('q'); await new Promise((r) => ff.on('close', r));
    await eye.close();
    const pg = await page.evaluate(() => ({ resizes: window.__resizes, widths: [...window.__widths], w: innerWidth, h: innerHeight }));
    const corner = spawnSync(ffmpeg, ['-v', 'error', '-i', file, '-vf', 'crop=40:40:1200:640,scale=1:1', '-f', 'rawvideo', '-pix_fmt', 'gray', '-'], { maxBuffer: 1 << 24 }).stdout;
    const blank = [...corner].filter((px) => px > 245).length;
    out.headed[mode] = { msPerLook: +ms.toFixed(1), resizes: pg.resizes, widths: pg.widths, frames: corner.length, blankCornerFrames: blank, path: eye.lastPath };
    console.log(`  headed + screen grab, ${mode.padEnd(5)}: ${ms.toFixed(1)} ms/look, page saw ${pg.resizes} resize events (innerWidth values ${pg.widths.join(', ')}), ${blank} of ${corner.length} grabbed frames with a blank corner`);
    if (mode === 'frame') spawnSync(ffmpeg, ['-v', 'error', '-y', '-sseof', '-1', '-i', file, '-frames:v', '1', path.join(process.cwd(), 'data', 'eye-frame-headed.jpg')]);
  }
  ok(out.headed.small.resizes > 0 || out.headed.small.blankCornerFrames > 0, `'small' does disturb the real window (${out.headed.small.resizes} resizes, ${out.headed.small.blankCornerFrames} shrunk frames): the check can see the problem`);
  ok(out.headed.frame.resizes === 0 && out.headed.frame.widths.length === 1 && out.headed.frame.blankCornerFrames === 0 && out.headed.frame.frames > 30, `'frame' does not: 0 resize events, innerWidth always ${out.headed.frame.widths[0]}, 0 of ${out.headed.frame.frames} grabbed frames shrunk`);
  ok(out.headed.frame.path === 'frame', 'headed: the frame path was used (no screenshot fallback)');
  await browser.close();
  xvfb.kill();
  fs.rmSync(dir, { recursive: true, force: true });
}
await srv.close();
fs.writeFileSync(path.join(process.cwd(), 'data', 'eye-frame.json'), JSON.stringify(out, null, 1));
console.log(fails ? `\neye-frame: ${fails} FAILED` : '\neye-frame: ALL PASS');
process.exit(fails ? 1 : 0);
