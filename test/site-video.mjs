/**
 * A screen recording of the whole descent: deterministic scroll, one
 * screenshot per video frame, encoded with ffmpeg to data/shots/descent.mp4.
 *
 *   URL=http://127.0.0.1:8093 node test/site-video.mjs     (SECONDS=20 FPS=25 W=1280 H=800)
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { launch, startDev } from './site-shots.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'data', 'shots', 'descent.mp4');
const FPS = Number(process.env.FPS || 25);
const W = Number(process.env.W || 1280); const H = Number(process.env.H || 800);
const HOLD = Number(process.env.HOLD || 1.6); const MOVE = Number(process.env.MOVE || 1.35);
const total = 7 * HOLD + 6 * MOVE;
const ease = (x) => x * x * (3 - 2 * x);
function P(t) {
  let at = 0;
  for (let i = 0; i < 7; i += 1) {
    if (t < at + HOLD) return i;
    at += HOLD;
    if (i < 6 && t < at + MOVE) return i + ease((t - at) / MOVE);
    at += MOVE;
  }
  return 6;
}

let dev = null; let base = process.env.URL;
if (!base) { dev = await startDev({ PROJECT_NAME: 'Halcyra Neuro' }, 8094); base = dev.url; }
const dir = fs.mkdtempSync('/tmp/descent-');
const browser = await launch();
try {
  const ctx = await browser.newContext({ viewport: { width: W, height: H } });
  const page = await ctx.newPage();
  await page.goto(base + '/', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__halcyra?.ready, null, { timeout: 90000 });
  await page.waitForTimeout(2500);
  const n = Math.round(total * FPS);
  for (let k = 0; k < n; k += 1) {
    const p = P(k / FPS);
    const f0 = await page.evaluate((pp) => { const max = document.documentElement.scrollHeight - innerHeight; scrollTo(0, (pp / 6) * max); return window.__halcyra.frames; }, p);
    await page.waitForFunction((f) => window.__halcyra.frames > f + 1, f0, { timeout: 30000 });
    await page.screenshot({ path: path.join(dir, `f${String(k).padStart(4, '0')}.jpg`), type: 'jpeg', quality: 92 });
  }
  await ctx.close();
  const r = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(FPS), '-i', path.join(dir, 'f%04d.jpg'), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart', OUT], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error('ffmpeg failed');
  console.log(`wrote ${OUT}: ${n} frames, ${(n / FPS).toFixed(1)} s`);
} finally {
  await browser.close();
  fs.rmSync(dir, { recursive: true, force: true });
  if (dev) await dev.stop();
}
