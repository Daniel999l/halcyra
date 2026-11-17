/**
 * How fast can she look, and do the capture paths see the same thing?
 *
 *   node test/pilot-eye.mjs
 *
 * On the mock console in real Chrome (headless), measures per look:
 *   png        Playwright PNG screenshot of the whole tab + decode
 *   small      CDP Page.captureScreenshot clipped and scaled to 160 x 90 + decode
 *   jpeg       Playwright JPEG screenshot, capture only (no decoder here, for reference)
 *   screencast CDP Page.startScreencast at 160 x 90 PNG: frames pushed per second
 * Then checks png and small give the same grid on the same still picture.
 */
import { chromium } from 'playwright-core';
import { serveMock } from './mock-console/serve.mjs';
import { installPad } from '../src/gamepad.js';
import { Eye, luminanceGrid, gridDiff, GRID_W, GRID_H } from '../src/eye.js';

let fails = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) fails += 1; };

const srv = await serveMock();
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
  headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await installPad(page);
await page.goto(srv.url);
await page.waitForTimeout(600);
await page.evaluate(() => window.__pad.set({ axes: [0.3, 0, 0, 0], buttons: [0, 0, 0, 0, 0, 0, 0, 0.6] }));

async function bench(label, fn, n = 40) {
  for (let i = 0; i < 3; i += 1) await fn();
  const t = performance.now();
  for (let i = 0; i < n; i += 1) await fn();
  const ms = (performance.now() - t) / n;
  console.log(`${label.padEnd(34)} ${ms.toFixed(1).padStart(6)} ms/look  ${(1000 / ms).toFixed(1).padStart(6)} looks/s`);
  return ms;
}

const png = await new Eye({ mode: 'png' }).open(page);
const small = await new Eye({ mode: 'small' }).open(page);
ok(small.mode === 'small', 'CDP session opened for the small path');
const res = {};
res.png = await bench('png  (full screenshot + decode)', () => png.look(page));
res.small = await bench('small (CDP 1/8 clip + decode)', () => small.look(page));
res.jpeg = await bench('jpeg (full screenshot, capture only)', () => page.screenshot({ type: 'jpeg', quality: 60 }));

// screencast: frames pushed by the compositor
const cdp = await page.context().newCDPSession(page);
let frames = 0; let lastGrid = null;
cdp.on('Page.screencastFrame', async (f) => {
  frames += 1;
  lastGrid = luminanceGrid(Buffer.from(f.data, 'base64'));
  await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
});
await cdp.send('Page.startScreencast', { format: 'png', maxWidth: GRID_W, maxHeight: GRID_H, everyNthFrame: 1 });
await page.waitForTimeout(3000);
await cdp.send('Page.stopScreencast');
console.log(`${'screencast (pushed, 160x90 png)'.padEnd(34)} ${(frames / 3).toFixed(1).padStart(6)} frames/s pushed (${frames} in 3 s)${lastGrid ? '' : ' none decoded'}`);
res.screencast = frames / 3;

// equivalence on a still picture: freeze one frame of the console into an <img>
const still = await page.screenshot({ type: 'png' });
const p2 = await browser.newPage({ viewport: { width: 1280, height: 720 } });
await p2.setContent(`<html><body style="margin:0;overflow:hidden"><img src="data:image/png;base64,${still.toString('base64')}" style="display:block;width:1280px;height:720px"></body></html>`);
await p2.waitForTimeout(200);
const gPng = await new Eye({ mode: 'png' }).open(p2).then((e) => e.look(p2));
const gSmall = await new Eye({ mode: 'small' }).open(p2).then((e) => e.look(p2));
const gRef = luminanceGrid(still);
const dPng = gridDiff(gPng, gRef); const dSmall = gridDiff(gSmall, gRef);
let maxD = 0; for (let i = 0; i < gPng.length; i += 1) maxD = Math.max(maxD, Math.abs(gPng[i] - gSmall[i]));
console.log(`grid difference on the same still picture: png vs source ${dPng.toFixed(4)}, small vs source ${dSmall.toFixed(4)} (mean abs, luminance 0..1), png vs small max cell ${maxD.toFixed(3)}`);
ok(dPng < 0.005, 'png path reproduces the source grid');
ok(dSmall < 0.01, `small path sees the same picture as png (mean abs diff ${dSmall.toFixed(4)} < 0.01)`);
ok(res.small < res.png, `small path is faster than png (${res.small.toFixed(1)} vs ${res.png.toFixed(1)} ms)`);

await browser.close();
await srv.close();
console.log(JSON.stringify({ msPerLook: { png: +res.png.toFixed(1), small: +res.small.toFixed(1), jpegCaptureOnly: +res.jpeg.toFixed(1) }, screencastFps: +res.screencast.toFixed(1), diff: { png: +dPng.toFixed(4), small: +dSmall.toFixed(4), maxCell: +maxD.toFixed(3) } }));
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
