/**
 * Screenshots of every chapter of the descent, desktop 1440x900 and phone 390x844.
 *
 *   node test/site-shots.mjs                       starts its own site-dev (empty states, no CA)
 *   URL=http://127.0.0.1:8090 node test/site-shots.mjs
 *   ONLY=desktop|mobile  CH=0,3  PREFIX=x  ROOM=a|b|c
 *
 * Software WebGL (SwiftShader) in real Chrome. Writes data/shots/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'data', 'shots');
fs.mkdirSync(OUT, { recursive: true });
const NAMES = ['arrival', 'scale', 'inside', 'sight', 'taste', 'hands', 'room'];
export const CHROME_ARGS = ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl', '--hide-scrollbars', '--force-color-profile=srgb'];

export async function startDev(env = {}, port = 8091) {
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'site-dev.mjs')], { env: { ...process.env, PORT: String(port), ...env }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('site-dev did not start')), 30000);
    child.stdout.on('data', (d) => { if (String(d).includes('site-dev on')) { clearTimeout(t); resolve(); } });
    child.on('exit', (c) => reject(new Error(`site-dev exited ${c}`)));
  });
  return { url: `http://127.0.0.1:${port}`, stop: () => new Promise((r) => { child.once('exit', r); child.kill('SIGTERM'); }) };
}

export async function launch() {
  const exe = fs.existsSync('/usr/bin/google-chrome') ? '/usr/bin/google-chrome' : undefined;
  return chromium.launch({ executablePath: exe, headless: true, args: CHROME_ARGS });
}

export async function gotoChapter(page, i, settle = 1400) {
  await page.evaluate((ch) => {
    const max = document.documentElement.scrollHeight - innerHeight;
    scrollTo(0, (ch / 6) * max);
  }, i);
  const f0 = await page.evaluate(() => window.__halcyra?.frames || 0);
  await page.waitForFunction((f) => (window.__halcyra?.frames || 0) > f + 3, f0, { timeout: 60000 });
  await page.waitForTimeout(settle);
}

async function shoot(browser, base, kind, chapters, prefix, roomSuffix) {
  const vp = kind === 'desktop' ? { width: 1440, height: 900, deviceScaleFactor: 1 } : { width: 390, height: 844, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
  const ctx = await browser.newContext({ viewport: { width: vp.width, height: vp.height }, deviceScaleFactor: vp.deviceScaleFactor, isMobile: !!vp.isMobile, hasTouch: !!vp.hasTouch });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(base + '/', { waitUntil: 'load' });
  await page.waitForFunction(() => window.__halcyra?.ready, null, { timeout: 90000 });
  await page.waitForTimeout(1800);
  const files = [];
  for (const i of chapters) {
    await gotoChapter(page, i);
    const name = `${prefix}${kind}-${i + 1}-${NAMES[i]}${i === 6 && roomSuffix ? `-${roomSuffix}` : ''}.png`;
    await page.screenshot({ path: path.join(OUT, name) });
    files.push(name);
  }
  const info = await page.evaluate(() => ({ fps: window.__halcyra.fps(), counts: window.__halcyra.counts }));
  await ctx.close();
  return { files, errors, info };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const only = process.env.ONLY;
  const chapters = process.env.CH ? process.env.CH.split(',').map(Number) : [0, 1, 2, 3, 4, 5, 6];
  let dev = null;
  let base = process.env.URL;
  if (!base) { dev = await startDev({ PROJECT_NAME: process.env.PROJECT_NAME || 'Halcyra Neuro' }); base = dev.url; }
  const browser = await launch();
  try {
    // URL2=<url> ROOM2=<suffix>: a second site shot in the same browser
    const runs = [[base, process.env.ROOM || '']];
    if (process.env.URL2) runs.push([process.env.URL2, process.env.ROOM2 || 'b']);
    for (const [u, room] of runs) for (const kind of ['desktop', 'mobile']) {
      if (only && only !== kind) continue;
      const r = await shoot(browser, u, kind, chapters, process.env.PREFIX || '', room);
      console.log(kind, JSON.stringify(r.info), r.files.join(' '));
      if (r.errors.length) console.log('page errors:', r.errors.slice(0, 5));
    }
  } finally {
    await browser.close();
    if (dev) await dev.stop();
  }
}
