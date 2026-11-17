/**
 * The API, on a plain node http server.
 *
 *   GET /                    the landing page (src/pages.js)
 *   GET /proof, /whitepaper  the proof page and the whitepaper (src/docs-pages.js)
 *   GET /api/health          for Railway, and what is on and off
 *   GET /api/state           latest tick, totals, status of every part
 *   GET /api/trades          recent tasted trades, newest first (?limit=)
 *   GET /api/ticks           ledger records (?after=<step>&limit=<n>), oldest first
 *   GET /api/ticks/:step     one ledger record
 *   GET /api/checkpoints     ledger checkpoints (?after=<step>&limit=)
 *   GET /api/proof           the brain manifest
 *   GET /api/frame.jpg       the latest frame of the console tab
 *   GET /api/ladder          the game ladder: stages, unlocked, playing, market cap
 *   GET /api/live            SSE: "tick", "trade" and "unlock" events
 *   GET /console/dos?b=<id>  the in-tab DOS console (loopback requests only)
 *   PUT /admin/games/<id>    a game bundle coming in (needs ADMIN_KEY, src/games.js)
 *
 * Everything is Cache-Control: no-store and CORS-open for GET.
 */
import http from 'node:http';
import { links } from './config.js';
import { serveConsole } from './dos.js';
import { mountHome } from './pages.js';
import { docsRoute } from './docs-pages.js';
import { gamesRoute } from './games.js';

const H = { 'cache-control': 'no-store', 'access-control-allow-origin': '*', 'access-control-allow-methods': 'GET, OPTIONS' };

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'content-type': type, ...H });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

export function createServer({ cfg, hub, ledger, db = null }) {
  const home = mountHome(null, { cfg, hub });
  const docs = docsRoute({ cfg, hub, ledger });
  const games = gamesRoute({ cfg, hub, db });
  return http.createServer(async (req, res) => {
    try {
      if (req.method === 'OPTIONS') { res.writeHead(204, H); return res.end(); }
      const url = new URL(req.url, 'http://x');
      // a game bundle coming in (src/games.js): the only address that takes a body
      if (url.pathname.startsWith('/admin/games/')) { if (await games(req, res, url)) return undefined; }
      if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, { error: 'GET only' });
      const p = url.pathname.replace(/\/+$/, '') || '/';
      const q = (k) => url.searchParams.get(k);

      // the pages: landing (/, /home/*), /proof, /whitepaper
      if (await home(req, res, url.pathname)) return undefined;
      if (await docs(req, res, p)) return undefined;

      if (p === '/api/health') {
        return send(res, 200, {
          ok: true,
          upSeconds: Math.round((Date.now() - hub.boot) / 1000),
          storage: db ? { mode: 'mongo', note: hub.dbNote } : { mode: 'memory', note: hub.dbNote || 'MONGO_URI is not set: ticks are kept in a memory ring only and are lost on restart' },
          ledger: ledger.stats(),
          brain: hub.brain,
          console: hub.console,
          stream: hub.stream,
          watcher: hub.watcher,
          games: hub.games || {},
          loop: hub.loop,
          memoryMb: Math.round(process.memoryUsage().rss / 1048576),
        });
      }
      if (p === '/api/state') return send(res, 200, hub.stateJson());
      if (p === '/api/ladder') return send(res, 200, hub.ladder ? hub.ladder.json() : { stages: [], unlocked: null, playing: null, marketCap: { usd: null } });
      // the in-tab game console: loopback only (src/dos.js)
      if (p.startsWith('/console') && serveConsole(req, res, p, url, { gamesDir: cfg.gamesDir })) return undefined;
      if (p === '/api/trades') {
        const limit = Math.max(1, Math.min(200, Number(q('limit')) || 50));
        let rows = hub.trades.slice(0, limit);
        if (db && rows.length < limit) {
          const stored = await db.trades(limit).catch(() => []);
          const seen = new Set(rows.map((r) => r.sig));
          for (const t of stored) if (!seen.has(t.sig)) rows.push({ ...t, tx: links.tx(t.sig), walletUrl: t.wallet ? links.account(t.wallet) : null });
          rows = rows.sort((a, b) => b.ts - a.ts).slice(0, limit);
        }
        return send(res, 200, { trades: rows, totals: hub.stateJson().totals });
      }
      if (p === '/api/ticks') {
        const after = q('after') == null ? -1 : Number(q('after'));
        const limit = Number(q('limit')) || 200;
        const ticks = await ledger.ticks(Number.isFinite(after) ? after : -1, limit);
        return send(res, 200, { ticks, head: ledger.head(), oldestInMemory: ledger.stats().oldestInMemory, firstStored: ledger.firstStored });
      }
      const m = p.match(/^\/api\/ticks\/(\d+)$/);
      if (m) {
        const t = await ledger.tick(Number(m[1]));
        return t ? send(res, 200, t) : send(res, 404, { error: `no stored tick ${m[1]}` });
      }
      if (p === '/api/checkpoints') {
        const after = q('after') == null ? -1 : Number(q('after'));
        return send(res, 200, { checkpoints: await ledger.checkpoints(Number.isFinite(after) ? after : -1, Number(q('limit')) || 500), head: ledger.head() });
      }
      if (p === '/api/proof') {
        const ca = cfg.tokenCa || null;
        return send(res, 200, {
          ...(hub.proof || {}),
          chain: { head: ledger.head(), rule: 'hash = sha256(prevHash + canonicalJSON(record without hash, prevHash, lit)); keys sorted, non-integers rounded to 4 decimals', genesis: '0'.repeat(64), verify: 'node scripts/verify-chain.mjs <site url>' },
          game: cfg.game,
          ...(ca ? { token: { ca, buy: links.buy(ca), solscan: links.account(ca) } } : {}),
        });
      }
      if (p === '/api/frame.jpg') {
        if (!hub.frame) return send(res, 204, '');
        res.writeHead(200, { 'content-type': 'image/jpeg', 'content-length': hub.frame.length, ...H });
        return res.end(hub.frame);
      }
      if (p === '/api/live') return hub.addClient(req, res);
      if (p === '/') {
        return send(res, 200, {
          name: cfg.projectName, game: cfg.game,
          api: ['/api/health', '/api/state', '/api/ladder', '/api/trades', '/api/ticks', '/api/ticks/:step', '/api/checkpoints', '/api/proof', '/api/frame.jpg', '/api/live'],
        });
      }
      return send(res, 404, { error: 'not found' });
    } catch (e) {
      try { send(res, 500, { error: e.message }); } catch { /* headers already sent */ }
    }
  });
}
