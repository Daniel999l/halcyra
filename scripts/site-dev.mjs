/**
 * A small server for working on the landing page and taking screenshots,
 * without touching src/server.js.
 *
 *   node scripts/site-dev.mjs
 *   PORT=8090 API=http://127.0.0.1:8080 PROJECT_NAME="Halcyra Neuro" TICKER=ABC TOKEN_CA=<mint> node scripts/site-dev.mjs
 *
 * /            renderHome() with the real state (from API when set)
 * /home/...    site/home and site/fly (serveHomeAsset)
 * /api/*       proxied to API when set; otherwise truthful empty states:
 *              zero counts, empty lists, 204 for the frame, an SSE stream
 *              that only says hello.
 * DEV_LADDER=1 / DEV_MCAP=4321 (screenshots only, no API): an 8 stage ladder
 *              on its first stage, playing GTA 1, with that market cap in USD.
 */
import http from 'node:http';
import { renderHome, serveHomeAsset, homeCells } from '../src/pages.js';

const env = (k, d = '') => (process.env[k] ? String(process.env[k]).trim() : d);
const PORT = Number(env('PORT', '8090'));
const API = env('API').replace(/\/$/, '');
const config = {
  projectName: env('PROJECT_NAME', 'Halcyra Neuro'),
  ticker: env('TICKER').replace(/^\$/, ''),
  tokenCa: env('TOKEN_CA'),
  publicUrl: env('PUBLIC_URL', 'https://halcyra.bio'),
  xUrl: env('X_URL', 'https://x.com/halcyrabio'),
};
const boot = Date.now();

function emptyState() {
  const ca = config.tokenCa || null;
  return {
    now: Date.now(), upSeconds: Math.round((Date.now() - boot) / 1000), project: config.projectName, ticker: config.ticker || null,
    token: ca ? { ca, buy: `https://pump.fun/coin/${ca}`, solscan: `https://solscan.io/account/${ca}` } : null,
    head: { step: -1, hash: '0'.repeat(64), ticks: 0 }, tick: null, fly: null,
    totals: { ticks: 0, trades: 0, buys: 0, sells: 0, solIn: 0, solOut: 0 },
  };
}

async function apiJson(p) {
  const r = await fetch(API + p, { signal: AbortSignal.timeout(4000) });
  if (!r.ok) throw new Error(`${p} ${r.status}`);
  return r.json();
}

// screenshot fixture only (never used by the real page): an 8 stage ladder on its first stage
function devLadder() {
  const mc = env('DEV_MCAP');
  if (!mc && !env('DEV_LADDER')) return null;
  const v = mc ? Number(mc) : null;
  const stages = [['gta1', 'GTA 1', 0], ['gta2', 'GTA 2', 30000], ['gta3', 'GTA III', 100000], ['gtavc', 'GTA Vice City', 300000],
    ['gtasa', 'GTA San Andreas', 1000000], ['gta4', 'GTA IV', 3000000], ['gta5', 'GTA V', 10000000], ['gta6', 'GTA VI', 30000000]]
    .map(([id, game, usd], i) => ({ id, game, usd, unlocked: i === 0 || (v != null && v >= usd), index: i }));
  return { stages, playing: { id: 'gta1', game: 'GTA 1' }, marketCap: { usd: v } };
}

async function liveState() {
  if (!API) return { state: emptyState(), ladder: devLadder(), frame: false };
  try {
    const [state, trades, fr, ladder] = await Promise.all([
      apiJson('/api/state'),
      apiJson('/api/trades?limit=1').catch(() => ({ trades: [] })),
      fetch(API + '/api/frame.jpg', { method: 'GET', signal: AbortSignal.timeout(4000) }).then(async (r) => { await r.arrayBuffer(); return r.status === 200; }).catch(() => false),
      apiJson('/api/ladder').catch(() => null),
    ]);
    return { state: { ...state, trades: trades.trades || [] }, ladder, frame: fr };
  } catch {
    return { state: emptyState(), ladder: null, frame: false };
  }
}

const H = { 'cache-control': 'no-store' };

function proxy(req, res, url) {
  const target = new URL(url.pathname + url.search, API);
  const up = http.request(target, { method: req.method, headers: { accept: req.headers.accept || '*/*' } }, (r) => {
    res.writeHead(r.statusCode || 502, { ...r.headers, ...H });
    r.pipe(res);
  });
  up.on('error', () => { if (!res.headersSent) { res.writeHead(502, { 'content-type': 'application/json', ...H }); } res.end('{}'); });
  req.on('close', () => up.destroy());
  up.end();
}

function emptyApi(req, res, p) {
  const json = (b, code = 200) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', ...H }); res.end(JSON.stringify(b)); };
  if (p === '/api/state') return json(emptyState());
  if (p === '/api/trades') return json({ trades: [], totals: emptyState().totals });
  if (p === '/api/health') return json({ ok: true, upSeconds: Math.round((Date.now() - boot) / 1000) });
  if (p === '/api/frame.jpg') { res.writeHead(204, H); return res.end(); }
  if (p === '/api/live') {
    res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'keep-alive', ...H });
    res.write('retry: 3000\n\n');
    res.write(`event: hello\ndata: ${JSON.stringify({ head: emptyState().head, latest: null })}\n\n`);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.on('close', () => clearInterval(ping));
    return undefined;
  }
  return json({ error: 'not found' }, 404);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname.replace(/\/+$/, '') || '/';
    if (p === '/') {
      const { state, ladder, frame } = await liveState();
      const html = await renderHome({ config, state, ladder, frame });
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...H });
      return res.end(html);
    }
    if (serveHomeAsset(req, res, url.pathname)) return undefined;
    if (p.startsWith('/api/')) return API ? proxy(req, res, url) : emptyApi(req, res, p);
    res.writeHead(404, { 'content-type': 'text/plain', ...H });
    return res.end('not found');
  } catch (e) {
    if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain', ...H });
    return res.end(String(e.message));
  }
});

await homeCells();
server.listen(PORT, '127.0.0.1', () => console.log(`site-dev on http://127.0.0.1:${PORT}  (api: ${API || 'empty states'}, name: ${config.projectName}, ca: ${config.tokenCa || 'none'})`));
const stop = () => { server.close(); server.closeAllConnections?.(); process.exit(0); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);
