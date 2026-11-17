/**
 * The landing page. renderHome() returns the whole HTML with every real value
 * already in it (name, the three counts, the cell counts, the coin box when
 * TOKEN_CA is set, the latest numbers), so a fetch without JavaScript reads
 * complete. site/home/main.js then turns the same HTML into the WebGL descent.
 *
 *   renderHome({ config, state, ladder, meta, frame })  -> HTML string
 *   serveHomeAsset(req, res, pathname)                  -> true when it answered /home/...
 *   mountHome(app, { cfg, hub })                        -> async (req, res, pathname) => handled?
 *
 * config: { projectName, ticker, tokenCa, publicUrl, xUrl, githubUrl }   (src/config.js cfg)
 * state:  hub.stateJson() plus optional trades: [latest trade row]
 * ladder: src/ladder.js Ladder.json() (stages, playing, marketCap); read defensively
 * meta:   site/fly/meta.json (read here when not given)
 * frame:  true when a console picture exists right now
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = path.join(ROOT, 'site', 'home');
const FLY = path.join(ROOT, 'site', 'fly');

let cellsP = null;
/** cells.json from site/home/build.mjs, built once if it is missing */
export function homeCells() {
  if (!cellsP) cellsP = import('../site/home/build.mjs').then((m) => m.ensureBuilt()).catch((e) => { cellsP = null; throw e; });
  return cellsP;
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const usd = (n) => `$${Math.round(Number(n) || 0).toLocaleString('en-US')}`;
const isMint = (s) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(s || ''));

function sol(x) {
  const v = Number(x) || 0;
  if (v >= 100) return v.toFixed(0);
  if (v >= 1) return v.toFixed(2);
  return v.toFixed(3);
}
function ago(ts, now) {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

/** numerals split into digits so the page can resolve them one by one */
const digits = (n) => fmt(n).split('').map((c) => (c === ',' ? '<i class="sep">,</i>' : `<i>${c}</i>`)).join('');

export function readouts(state) {
  const now = state?.now || Date.now();
  const ticks = state?.totals?.ticks || 0;
  const trades = state?.totals?.trades || 0;
  const last = Array.isArray(state?.trades) && state.trades[0] ? state.trades[0] : null;
  const rows = [];
  if (ticks > 0) rows.push(['looks', 'Looks so far', fmt(ticks)]);
  if (trades > 0) rows.push(['trades', 'Trades tasted', fmt(trades)]);
  if (last && (last.side === 'buy' || last.side === 'sell')) {
    rows.push(['last', last.side === 'buy' ? 'Last buy, sugar' : 'Last sell, bitter', `${sol(last.sol)} SOL, ${ago(last.ts, now)}`]);
  }
  return rows;
}

let defaultStages = null;
/** the stages src/ladder.js defines, used when no ladder state is given (never written out here) */
async function ladderDefaults() {
  if (!defaultStages) {
    try { defaultStages = (await import('./ladder.js')).DEFAULT_STAGES || []; } catch { defaultStages = []; }
  }
  return defaultStages;
}

/**
 * The ladder as the page shows it, from Ladder.json() (or anything close to it).
 * -> { rungs: [{ id, game, usd, unlocked, playing }], playing: label, mcapUsd: number|null }
 */
export function ladderView(ladder, hasCa, fallback = []) {
  const l = ladder && typeof ladder === 'object' ? ladder : {};
  const src = Array.isArray(l.stages) && l.stages.length ? l.stages : fallback;
  const label = (s) => String(s?.game ?? s?.label ?? s?.name ?? s?.id ?? '').trim();
  const pl = l.playing;
  const playingLabel = (typeof pl === 'string' ? pl : label(pl)) || label(l.console?.target) || 'GTA 1';
  const playingId = pl && typeof pl === 'object' ? (pl.id ?? null) : null;
  const unlockedIdx = Number.isInteger(l.unlocked?.index) ? l.unlocked.index : null;
  let rungs = src.map((s, i) => ({
    id: String(s.id ?? i),
    game: label(s) || `Stage ${i + 1}`,
    usd: Math.max(0, Number(s.usd ?? s.threshold ?? s.mcapUsd ?? 0) || 0),
    unlocked: typeof s.unlocked === 'boolean' ? s.unlocked : unlockedIdx != null ? i <= unlockedIdx : i === 0,
  }));
  rungs = rungs.map((r) => ({ ...r, playing: playingId != null ? r.id === playingId : r.game === playingLabel }));
  if (!rungs.some((r) => r.playing)) { const m = rungs.find((r) => r.game === playingLabel); if (m) m.playing = true; }
  const mc = l.marketCap && typeof l.marketCap === 'object' ? l.marketCap.usd : (l.marketCapUsd ?? l.mcapUsd ?? null);
  const mcapUsd = hasCa && mc != null && Number.isFinite(Number(mc)) && Number(mc) >= 0 ? Number(mc) : null;
  return { rungs, playing: playingLabel, live: !!pl, mcapUsd };
}

let eyeSides = null;
/** lamina cells per eye, straight from site/fly/eyemap.json (L1 to L5) */
export function laminaSides() {
  if (!eyeSides) {
    const eye = JSON.parse(fs.readFileSync(path.join(FLY, 'eyemap.json'), 'utf8')).eye;
    const n = (side) => ['L1', 'L2', 'L3', 'L4', 'L5'].reduce((a, ct) => a + (eye[`${ct}_${side}`]?.idx?.length || 0), 0);
    eyeSides = { right: n('right'), left: n('left') };
  }
  return eyeSides;
}

export async function renderHome({ config = {}, state = null, ladder = null, meta = null, frame = false } = {}) {
  const m = meta || JSON.parse(fs.readFileSync(path.join(FLY, 'meta.json'), 'utf8'));
  const cells = await homeCells();
  const name = config.projectName || 'Halcyra Neuro';
  const ticker = String(config.ticker || '').replace(/^\$/, '');
  const ca = isMint(config.tokenCa) ? config.tokenCa : '';
  const lad = ladderView(ladder, !!ca, await ladderDefaults());
  const game = lad.playing;
  const eyes = laminaSides();
  const buy = ca ? `https://pump.fun/coin/${ca}` : '';
  const site = /^https:\/\//.test(config.publicUrl || '') ? String(config.publicUrl).replace(/\/$/, '') : '';
  const xUrl = /^https:\/\/(x|twitter)\.com\//.test(config.xUrl || '') ? config.xUrl : '';
  const ghRaw = config.githubUrl === undefined ? 'https://github.com/Daniel999l/halcyra' : config.githubUrl;
  const ghUrl = /^https:\/\/github\.com\//.test(ghRaw || '') ? ghRaw : '';
  const sc = cells.superCount;
  const rows = readouts(state);

  const boot = {
    name, ticker, ca, buy, game, ladder: lad,
    counts: { neurons: m.neurons, connections: m.connections, synapses: m.synapses },
    extentUm: cells.extentUm,
    frame: !!frame,
  };

  const coin = ca ? `
      <div class="coin">
        <a class="watch" href="${esc(buy)}" target="_blank" rel="noopener">Watch the stream</a>
        <div class="ca" data-ca="${esc(ca)}">
          <span class="ca-label">Contract</span>
          <a class="ca-value" href="https://solscan.io/token/${esc(ca)}" target="_blank" rel="noopener"><code>${esc(ca)}</code></a>
          <button class="ca-copy" type="button" aria-label="Copy contract address">Copy</button>
        </div>
        <a class="buy" href="${esc(buy)}" target="_blank" rel="noopener">${ticker ? `Buy $${esc(ticker)}` : 'Buy'}</a>
      </div>` : '';

  const nR = lad.rungs.length;
  const cols = nR <= 4 ? nR : Math.ceil(nR / 2);
  const rungNote = (r) => [r.usd > 0 ? usd(r.usd) : 'start', r.playing ? (lad.live ? 'playing' : 'her game') : r.unlocked ? 'unlocked' : ''].filter(Boolean).join(', ');
  const ladderHtml = (nR ? `<ol class="ladder${nR > 4 ? ' wide' : ''}" aria-label="Evolution" style="--cols:${cols}">${lad.rungs.map((r) => `
        <li class="rung${r.unlocked ? ' open' : ''}${r.playing ? ' now' : ''}" data-id="${esc(r.id)}"><span class="rg">${esc(r.game)}</span><span class="rt">${rungNote(r)}</span></li>`).join('')}
      </ol>` : '') + (lad.mcapUsd != null ? `
      <p class="mcap">Market cap <b>${usd(lad.mcapUsd)}</b></p>` : '');

  const readHtml = rows.map(([k, label, v]) => `<div class="ro" data-k="${k}"><dt>${esc(label)}</dt><dd>${esc(v)}</dd></div>`).join('');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(name)}</title>
<meta name="description" content="The complete brain of a fruit fly, ${fmt(m.neurons)} neurons, playing ${esc(game)}. Every buy is sugar, every sell is bitter.">
<meta name="theme-color" content="#ffffff">${site ? `
<link rel="canonical" href="${esc(site)}/">
<meta property="og:url" content="${esc(site)}/">` : ''}
<meta property="og:title" content="${esc(name)}">
<meta property="og:type" content="website">${site ? `
<meta property="og:image" content="${esc(site)}/home/brand/og.png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:image" content="${esc(site)}/home/brand/og.png">` : ''}
<meta name="twitter:title" content="${esc(name)}">
<link rel="icon" href="/home/brand/mark.svg" type="image/svg+xml">
<link rel="icon" href="/home/brand/mark-32.png" type="image/png" sizes="32x32">
<link rel="apple-touch-icon" href="/home/brand/mark-180.png">
<link rel="preload" href="/home/fonts/inter-latin-opsz-normal.woff2" as="font" type="font/woff2" crossorigin>
<link rel="stylesheet" href="/home/home.css">
<script>try{if(document.createElement('canvas').getContext('webgl2')){document.documentElement.classList.add('gl');setTimeout(function(){if(!(window.__halcyra&&window.__halcyra.ready))document.documentElement.classList.remove('gl')},15000)}}catch(e){}</script>
</head>
<body>
<canvas id="specimen" aria-hidden="true"></canvas>
<canvas id="marks" aria-hidden="true"></canvas>

<header class="mast">
  <span class="mark"><img class="mark-logo" src="/home/brand/mark.svg" width="18" height="18" alt="">${esc(name)}</span>${xUrl ? `
  <span class="links"><a class="xlink" href="${esc(xUrl)}" target="_blank" rel="noopener">X</a>${ghUrl ? `<a class="xlink ghlink" href="${esc(ghUrl)}" target="_blank" rel="noopener">GitHub</a>` : ''}</span>` : ghUrl ? `
  <span class="links"><a class="xlink ghlink" href="${esc(ghUrl)}" target="_blank" rel="noopener">GitHub</a></span>` : ''}
</header>

<nav class="gauge" aria-label="Depth">
  <ol>
    <li><a href="#arrival" data-to="0" aria-label="Arrival"></a></li>
    <li><a href="#scale" data-to="1" aria-label="Scale"></a></li>
    <li><a href="#inside" data-to="2" aria-label="Inside"></a></li>
    <li><a href="#sight" data-to="3" aria-label="Sight"></a></li>
    <li><a href="#taste" data-to="4" aria-label="Taste"></a></li>
    <li><a href="#hands" data-to="5" aria-label="Hands"></a></li>
    <li><a href="#room" data-to="6" aria-label="The room"></a></li>
  </ol>
  <span class="gauge-read"></span>
</nav>

<div class="scalebar" aria-hidden="true"><span class="sb-line"></span><span class="sb-text"></span></div>

<main class="descent">
  <section class="ch" id="arrival" data-ch="0">
    <h1 class="title">${esc(name)}</h1>
    <p class="lede">The complete brain of a fruit fly, wired cell for cell, playing ${esc(game)}.</p>
    <p class="cue" aria-hidden="true"><span></span>Scroll to descend</p>
  </section>

  <section class="ch" id="scale" data-ch="1">
    <dl class="counts">
      <div class="count"><dd class="num">${digits(m.neurons)}</dd><dt>neurons</dt></div>
      <div class="count"><dd class="num">${digits(m.connections)}</dd><dt>connections</dt></div>
      <div class="count"><dd class="num">${digits(m.synapses)}</dd><dt>synapses</dt></div>
    </dl>
    <p class="note">One adult female fruit fly, mapped synapse by synapse. ${esc(m.dataset)}.</p>
  </section>

  <section class="ch" id="inside" data-ch="2">
    <h2>Inside her</h2>
    <p>Two optic lobes of ${fmt(sc.optic)} cells open away from a central brain of ${fmt(sc.central)}.</p>
    <p class="sub">Each line is one of her real connections.</p>
  </section>

  <section class="ch" id="sight" data-ch="3">
    <h2>Her eye is her lamina</h2>
    <p>The game screen goes in through ${fmt(cells.lamina.count)} lamina cells, ${fmt(eyes.right)} in her right eye and ${fmt(eyes.left)} in her left, each at its own point on her retina.</p>
  </section>

  <section class="ch" id="taste" data-ch="4">
    <h2>Buys are sweet. Sells are bitter.</h2>
    <p>Every buy of the coin reaches her ${fmt(cells.taste.sweet.length)} sugar taste cells. Every sell reaches her ${fmt(cells.taste.bitter.length)} bitter taste cells.</p>
  </section>

  <section class="ch" id="hands" data-ch="5">
    <h2>Her descending cells hold the controls</h2>
    <dl class="map">
      <div><dt>All ${fmt(cells.dn.count)} descending cells</dt><dd>steer and gas</dd></div>
      <div><dt>MDN</dt><dd>brake</dd></div>
      <div><dt>Giant fiber</dt><dd>handbrake</dd></div>
      <div><dt>oviDNb</dt><dd>in and out of the car</dd></div>
    </dl>
  </section>

  <section class="ch" id="room" data-ch="6">
    <div class="window" data-frame="${frame ? '1' : '0'}">
      ${frame ? '<img class="frame" src="/api/frame.jpg" alt="Her game screen">' : ''}
    </div>
    <div class="room-text">
      <h2>The room where she plays</h2>
      <p class="playing">${lad.live ? `Playing <b>${esc(game)}</b>, live.` : `Her game is <b>${esc(game)}</b>.`}</p>
      ${ladderHtml}
      <dl class="readouts">${readHtml}</dl>${coin}
      <footer class="foot"><a href="/proof">Proof</a><a href="/whitepaper">Whitepaper</a>${ghUrl ? `<a href="${esc(ghUrl)}" target="_blank" rel="noopener">GitHub</a>` : ''}</footer>
    </div>
  </section>
</main>

<script type="application/json" id="boot">${JSON.stringify(boot).replace(/</g, '\\u003c')}</script>
<script type="module" src="/home/main.js"></script>
</body>
</html>`;
}

const TYPES = {
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.woff2': 'font/woff2', '.bin': 'application/octet-stream',
  '.gz': 'application/octet-stream', '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png',
};

/**
 * /home/...       -> site/home/...
 * /home/fly/...   -> site/fly/... (her atlas and eye map, read only)
 * Answers and returns true for those paths, false for anything else.
 */
export function serveHomeAsset(req, res, pathname) {
  if (!pathname.startsWith('/home/')) return false;
  let rel = decodeURIComponent(pathname.slice('/home/'.length));
  let base = HOME;
  if (rel.startsWith('fly/')) { base = FLY; rel = rel.slice(4); }
  const file = path.resolve(base, rel);
  const ext = path.extname(file);
  if (!file.startsWith(base + path.sep) || !TYPES[ext] || rel.endsWith('.mjs') || /(^|\/)\./.test(rel)) {
    res.writeHead(404, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
    res.end('not found');
    return true;
  }
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404, { 'content-type': 'text/plain', 'cache-control': 'no-store' }); res.end('not found'); return; }
    res.writeHead(200, { 'content-type': TYPES[ext], 'content-length': st.size, 'cache-control': 'no-store' });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });
  return true;
}

/**
 * Switch the landing page on in a plain node:http handler (or register it on an
 * app with .get, such as express). Returns a handler that answers GET/HEAD /
 * and /home/... (site/home, site/fly, site/home/brand) and returns true when it
 * answered, false for every other path.
 *
 *   deps: { cfg, hub }   hub.stateJson(), hub.trades, hub.frame, hub.ladder.json()
 */
export function mountHome(app, deps = {}) {
  const { cfg = {}, hub = null } = deps;
  const page = async (req, res) => {
    let state = null; let ladder = null; let frame = false;
    try { state = hub?.stateJson ? { ...hub.stateJson(), trades: Array.isArray(hub.trades) ? hub.trades.slice(0, 1) : [] } : null; } catch { state = null; }
    try { ladder = hub?.ladder?.json ? hub.ladder.json() : null; } catch { ladder = null; }
    frame = !!hub?.frame;
    const html = await renderHome({ config: cfg, state, ladder, frame });
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : html);
  };
  const handle = async (req, res, pathname) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return false;
    const raw = pathname ?? new URL(req.url, 'http://x').pathname;
    if (raw.startsWith('/home/')) return serveHomeAsset(req, res, raw);
    if ((raw.replace(/\/+$/, '') || '/') === '/') { await page(req, res); return true; }
    return false;
  };
  if (app && typeof app.get === 'function') {
    app.get('/', (req, res, next) => page(req, res).catch(next));
    app.get(/^\/home\//, (req, res, next) => { if (!serveHomeAsset(req, res, req.path || new URL(req.url, 'http://x').pathname)) next(); });
  }
  return handle;
}
