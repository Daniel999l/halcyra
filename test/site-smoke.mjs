/**
 * The landing page, checked from outside:
 *  - raw HTML (no JavaScript) holds the name and the three real counts
 *  - no dash characters and no forbidden words in visible text (raw and after JS)
 *  - no third party host is loaded by the page
 *  - contract box and buttons absent without TOKEN_CA, present with it
 *  - in Chrome: a WebGL2 context exists and the canvas is not blank
 *
 *   node test/site-smoke.mjs
 *   NO_BROWSER=1 node test/site-smoke.mjs     raw HTML checks only
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { startDev, launch } from './site-shots.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const meta = JSON.parse(fs.readFileSync(path.join(ROOT, 'site', 'fly', 'meta.json'), 'utf8'));
const NAME = 'Halcyra Neuro';
const MINT = 'Et7p5gMerFRQFBSAtLh554ZhQx57W98Lohe65haNpump'; // random, syntactically valid, test only
const fmt = (n) => n.toLocaleString('en-US');
const DASHES = /[-‐‑‒–—―−]/;
const FORBIDDEN = /\b(server|indexer|api|backend|worker|node|database|coming soon|soon|loading|tba|not deployed|offline|untested|experimental|financial advice|fees?|dev|ticker|19 november|gamepad|controller|audited|coming clean|up front)\b/i;
const NIGERIAN = /\b(nigeria|lagos|ilorin|abuja|naira|tunde|chinedu|emeka|ngozi|bola|ade(?:ola|bayo)?)\b/i;
let pass = 0;
const ok = (name) => { pass += 1; console.log(`ok ${pass} ${name}`); };

function visibleText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<head[\s\S]*?<\/head>/i, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ').trim();
}
function checkCopy(text, where) {
  assert.equal(/\/\//.test(text.replace(/https?:\/\//g, '')), false, `${where}: "//" label`);
  assert.equal(/\p{Extended_Pictographic}/u.test(text), false, `${where}: emoji`);
  const d = text.match(DASHES); assert.equal(d, null, `${where}: dash character "${d?.[0]}" in "${text.slice(Math.max(0, d?.index - 40), d?.index + 40)}"`);
  const f = text.match(FORBIDDEN); assert.equal(f, null, `${where}: forbidden word "${f?.[0]}"`);
  const n = text.match(NIGERIAN); assert.equal(n, null, `${where}: "${n?.[0]}"`);
}
function checkHosts(html, allowedLinks) {
  // anything the page loads: src=, link href=, url( ), fetch / import of absolute URLs
  const loads = [...html.matchAll(/\s(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
  for (const u of loads) {
    if (/^https?:/i.test(u)) assert.ok(allowedLinks.includes(u), `external URL in page: ${u}`);
  }
  for (const f of fs.readdirSync(path.join(ROOT, 'site', 'home'))) {
    if (!/\.(js|css)$/.test(f)) continue;
    const src = fs.readFileSync(path.join(ROOT, 'site', 'home', f), 'utf8');
    assert.equal(/https?:\/\//.test(src), false, `site/home/${f} references an absolute URL`);
  }
}

const browser = process.env.NO_BROWSER ? null : await launch();
const devs = [];
try {
  // ---- without CA
  const a = await startDev({ PROJECT_NAME: NAME, TOKEN_CA: '', TICKER: '' }, 8095); devs.push(a);
  const res = await fetch(a.url + '/');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/html/);
  const html = await res.text();
  for (const s of [NAME, fmt(meta.neurons), fmt(meta.connections), fmt(meta.synapses)]) {
    const flat = html.replace(/<i class="sep">,<\/i>/g, ',').replace(/<\/?i>/g, '');
    assert.ok(flat.includes(s), `raw HTML lacks ${s}`);
  }
  ok('raw HTML has the name and the three real counts');
  checkCopy(visibleText(html), 'raw HTML without CA');
  ok('raw visible text: no dashes, no forbidden words');
  const GH = (html.match(/class="xlink ghlink" href="([^"]+)"/) || [])[1];
  checkHosts(html, ['https://halcyra.bio/', 'https://x.com/halcyrabio', 'https://halcyra.bio/home/brand/og.png', GH]);
  assert.ok(html.includes('<link rel="canonical" href="https://halcyra.bio/">') && html.includes('class="xlink" href="https://x.com/halcyrabio"'), 'canonical and X link');
  ok('no third party host loaded (page and site/home assets); canonical from PUBLIC_URL, one X link');
  assert.equal(/class="ca"|Watch the stream|pump\.fun|class="buy"/.test(html), false, 'coin layer present without CA');
  assert.equal(/solscan|>Buy( \$\w+)?<|Market cap/.test(html), false, 'buy, solscan or market cap without CA');
  ok('no contract box, stream, buy button or market cap without TOKEN_CA');
  assert.match(html, /playing GTA 1\.<\/p>/, 'hero line');
  assert.match(html, /Her game is <b>GTA 1<\/b>\./, 'room line (nothing on screen yet: no live claim)');
  const { DEFAULT_STAGES } = await import('../src/ladder.js');
  for (const st of DEFAULT_STAGES) {
    assert.match(html, new RegExp(`<span class="rg">${st.game}</span><span class="rt">${st.usd > 0 ? `\\$${st.usd.toLocaleString('en-US')}` : 'start'}`), `rung ${st.game}`);
  }
  assert.match(html, /class="xlink ghlink" href="https:\/\/github\.com\//, 'GitHub link in the mast');
  assert.match(html, /<footer class="foot">.*>GitHub<\/a><\/footer>/, 'GitHub link in the footer');
  assert.match(html, /Her descending cells hold the controls</, 'controls heading');
  const eye = JSON.parse(fs.readFileSync(path.join(ROOT, 'site', 'fly', 'eyemap.json'), 'utf8')).eye;
  const side = (sd) => ['L1', 'L2', 'L3', 'L4', 'L5'].reduce((x, c) => x + eye[`${c}_${sd}`].idx.length, 0);
  assert.ok(html.includes(`through ${fmt(side('right') + side('left'))} lamina cells, ${fmt(side('right'))} in her right eye and ${fmt(side('left'))} in her left`), 'lamina numbers from eyemap.json');
  assert.equal(res.headers.get('cache-control'), 'no-store', 'no-store on the page');
  for (const b of ['/home/brand/mark.svg', '/home/brand/mark-32.png', '/home/brand/mark-180.png', '/home/brand/og.png']) {
    assert.ok(html.includes(b.replace('/og.png', '')), `page links ${b}`);
    const r = await fetch(a.url + b); assert.equal(r.status, 200, b); await r.arrayBuffer();
  }
  assert.ok(html.includes('content="https://halcyra.bio/home/brand/og.png"') && html.includes('href="/proof"') && html.includes('href="/whitepaper"'), 'og image, proof and whitepaper links');
  ok('hero and room say GTA 1, ladder rungs from src/ladder.js with USD thresholds, GitHub links, controls, lamina numbers from the data, brand icons, footer links, no-store');
  for (const p of ['/home/main.js', '/home/home.css', '/home/data/cells.json', '/home/data/paths.bin', '/home/fly/atlas.bin.gz', '/home/fonts/inter-latin-opsz-normal.woff2']) {
    const r = await fetch(a.url + p); assert.equal(r.status, 200, p); await r.arrayBuffer();
  }
  for (const p of ['/home/build.mjs', '/home/../package.json', '/home/fly/../../package.json']) {
    const r = await fetch(a.url + p); assert.equal(r.status, 404, p); await r.arrayBuffer();
  }
  assert.equal(/\.html\b/.test(html.replace(/text\/html/g, '')), false, 'a link ends in .html');
  ok('assets served under /home, build script and traversal refused, clean URLs');

  // ---- in Chrome
  for (const vp of browser ? [{ width: 1440, height: 900 }, { width: 390, height: 844 }] : []) {
    const ctx = await browser.newContext({ viewport: vp, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    const external = [];
    page.on('request', (r) => { const u = new URL(r.url()); if (!['127.0.0.1', 'localhost'].includes(u.hostname) && !u.protocol.startsWith('data')) external.push(r.url()); });
    const errors = []; page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(a.url + '/', { waitUntil: 'load' });
    await page.waitForFunction(() => window.__halcyra?.ready, null, { timeout: 90000 });
    const gl = await page.evaluate(() => ({ webgl2: window.__halcyra.webgl2, cls: document.documentElement.className, ctx: !!document.getElementById('specimen').getContext('webgl2') }));
    assert.ok(gl.webgl2 && gl.ctx && /\bgl\b/.test(gl.cls), `no WebGL2 at ${vp.width}`);
    await page.waitForTimeout(1600);
    await page.evaluate(() => { window.__halcyra.wantSample = true; });
    await page.waitForFunction(() => window.__halcyra.wantSample === false, null, { timeout: 30000 });
    const ink = await page.evaluate(() => window.__halcyra.inkRatio);
    assert.ok(ink > 0.01 && ink < 0.6, `canvas ink ratio ${ink}`);
    ok(`${vp.width}x${vp.height}: WebGL2 context, canvas drawn (${(ink * 100).toFixed(1)}% of pixels carry the specimen)`);
    // walk every chapter and check the text that JS adds
    for (let i = 0; i < 7; i += 1) {
      const f0 = await page.evaluate((ch) => { const max = document.documentElement.scrollHeight - innerHeight; scrollTo(0, (ch / 6) * max); return window.__halcyra.frames; }, i);
      await page.waitForFunction((f) => window.__halcyra.frames > f + 2, f0, { timeout: 30000 });
    }
    const live = await page.evaluate(() => document.body.innerText);
    checkCopy(live.replace(/\s+/g, ' '), `live text ${vp.width}`);
    assert.deepEqual(external, [], `external requests: ${external.join(', ')}`);
    assert.deepEqual(errors, [], `page errors: ${errors.join(' | ')}`);
    ok(`${vp.width}x${vp.height}: all chapters render, live text clean, no external requests, no page errors`);
    await ctx.close();
  }

  // ---- with CA, no ticker, then with ticker
  const b = await startDev({ PROJECT_NAME: NAME, TOKEN_CA: MINT, TICKER: '' }, 8096); devs.push(b);
  const hb = await (await fetch(b.url + '/')).text();
  const buy = `https://pump.fun/coin/${MINT}`;
  assert.ok(hb.includes(`data-ca="${MINT}"`) && hb.includes(`>${MINT}</code>`), 'contract box');
  assert.ok(hb.includes(`class="watch" href="${buy}"`) && hb.includes('>Watch the stream</a>'), 'watch the stream');
  assert.ok(hb.includes(`class="buy" href="${buy}"`) && />Buy<\/a>/.test(hb), 'plain Buy');
  checkCopy(visibleText(hb), 'raw HTML with CA');
  checkHosts(hb, [buy, `https://solscan.io/token/${MINT}`, 'https://halcyra.bio/', 'https://x.com/halcyrabio', 'https://halcyra.bio/home/brand/og.png', GH]);
  assert.ok(hb.includes(`href="https://solscan.io/token/${MINT}"`), 'contract links to solscan');
  assert.equal(/TICKER|\$<\/a>/.test(visibleText(hb)), false, 'placeholder in buy');
  ok('with TOKEN_CA: contract box, Watch the stream and Buy link to pump.fun');
  const c = await startDev({ PROJECT_NAME: NAME, TOKEN_CA: MINT, TICKER: '$HALC', DEV_MCAP: '4321.5' }, 8097); devs.push(c);
  const hc = await (await fetch(c.url + '/')).text();
  assert.ok(/>Buy \$HALC<\/a>/.test(hc), 'Buy $TICKER');
  checkCopy(visibleText(hc), 'raw HTML with CA and ticker');
  assert.match(hc, /Market cap <b>\$4,322<\/b>/, 'market cap in USD with separators');
  assert.match(hc, /class="rung open now" data-id="gta1"><span class="rg">GTA 1<\/span><span class="rt">start, playing</, 'stage 1 playing');
  assert.equal((hc.match(/<li class="rung/g) || []).length, 8, 'eight rungs from the ladder state');
  for (const t of ['$30,000', '$1,000,000', '$30,000,000']) assert.ok(hc.includes(`<span class="rt">${t}</span>`), `threshold ${t}`);
  assert.match(hc, /class="ladder wide" aria-label="Evolution" style="--cols:4"/, 'two rows of four');
  ok('with TICKER and an 8 stage ladder reading: Buy $HALC, market cap $4,322, eight rungs, GTA 1 playing, copy clean');
  const d = await startDev({ PROJECT_NAME: NAME, TOKEN_CA: 'not-a-mint', TICKER: '' }, 8098); devs.push(d);
  const hd = await (await fetch(d.url + '/')).text();
  assert.equal(/class="ca"|Watch the stream/.test(hd), false, 'coin layer shown for an invalid CA');
  ok('an invalid TOKEN_CA shows no coin layer');
} finally {
  await browser?.close();
  for (const d of devs) await d.stop();
}
console.log(`\n${pass} passed`);
