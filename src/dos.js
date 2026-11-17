/**
 * The in-tab DOS console: /console/dos?b=<id>
 *
 * A page served by this service that runs a DOS game bundle with js-dos's
 * emulator engine (npm `emulators`, the same engine the `js-dos` player wraps,
 * used here without the player's UI). Everything comes from this machine:
 * the engine files from node_modules/emulators/dist, the game bundle from
 * <GAMES_DIR>/<id>/bundle.jsdos (made by scripts/make-bundle.mjs).
 *
 * Every /console/* path answers ONLY loopback requests (the console browser on
 * this machine). Anyone else gets a 404, so the game data is never downloadable
 * by site visitors. A request that came through a proxy (any X-Forwarded-For)
 * is not loopback, whatever the socket says.
 *
 * The page reads her virtual gamepad (src/gamepad.js) every 10 ms and turns it
 * into key presses for the emulator with the stage's key table
 * (src/stagekeys.js, pulse width over 100 ms). Real keyboard events on the page
 * (the keyboard fallback in src/gamepad.js, or a person) go in too.
 *
 *   window.__dos   { state, frames, w, h, held, sent, padReads, beats, error }
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STAGE_KEYS, keysForStage, JSDOS_CODES, padKeys } from './stagekeys.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const EMU_DIR = path.join(ROOT, 'node_modules', 'emulators', 'dist');
// the engine files the page may load (DOSBox, DOSBox-X, the zip reader)
const EMU_FILES = new Set(['emulators.js', 'wdosbox.js', 'wdosbox.wasm', 'wdosbox-x.js', 'wdosbox-x.wasm', 'wlibzip.js', 'wlibzip.wasm']);
const TYPES = { '.js': 'text/javascript; charset=utf-8', '.wasm': 'application/wasm', '.jsdos': 'application/zip' };
const NO_STORE = { 'cache-control': 'no-store', 'x-robots-tag': 'noindex' };

/** loopback socket and no proxy header */
export function isLoopback(req) {
  if (req.headers['x-forwarded-for'] || req.headers['x-real-ip'] || req.headers.forwarded) return false;
  const a = String(req.socket?.remoteAddress || '');
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

const idOk = (id) => /^[a-z0-9][a-z0-9_-]{0,31}$/i.test(String(id || ''));

export function pageHtml({ id, keys, backend = 'dosbox' }) {
  const cfg = {
    bundle: `/console/dos/bundle/${id}`,
    emu: '/console/dos/emu/',
    keys,
    codes: JSDOS_CODES,
    backend,
  };
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${id}</title>
<style>
html,body{margin:0;height:100%;background:#000;overflow:hidden}
#screen{position:absolute;display:none;image-rendering:pixelated;image-rendering:crisp-edges;background:#000}
</style></head>
<body>
<canvas id="screen" width="320" height="200"></canvas>
<script type="application/json" id="cfg">${JSON.stringify(cfg).replace(/</g, '\\u003c')}</script>
<script src="/console/dos/emu/emulators.js"></script>
<script>
(async () => {
  const P = JSON.parse(document.getElementById('cfg').textContent);
  const padKeys = ${padKeys.toString()};
  const st = window.__dos = { state: 'starting', frames: 0, w: 0, h: 0, held: {}, sent: 0, padReads: 0, error: null, backend: P.backend };
  const cv = document.getElementById('screen');
  const g = cv.getContext('2d', { alpha: false });
  let img = null;
  const fit = () => {
    if (!st.w || !st.h) return;
    const W = window.innerWidth, H = window.innerHeight;
    const k = Math.min(W / st.w, H / st.h);
    const w = Math.floor(st.w * k), h = Math.floor(st.h * k);
    Object.assign(cv.style, { width: w + 'px', height: h + 'px', left: Math.floor((W - w) / 2) + 'px', top: Math.floor((H - h) / 2) + 'px' });
  };
  window.addEventListener('resize', fit);
  try {
    emulators.pathPrefix = P.emu;
    const r = await fetch(P.bundle, { cache: 'no-store' });
    if (!r.ok) throw new Error('bundle ' + r.status);
    const bundle = new Uint8Array(await r.arrayBuffer());
    const start = P.backend === 'dosboxX' ? emulators.dosboxXWorker : emulators.dosboxWorker;
    const ci = await start.call(emulators, bundle);
    st.ci = ci;
    const ev = ci.events();
    const size = (w, h) => {
      if (!(w > 0 && h > 0)) return;
      st.w = w; st.h = h; cv.width = w; cv.height = h; img = g.createImageData(w, h); fit();
    };
    ev.onFrameSize(size);
    size(ci.width(), ci.height());
    ev.onFrame((rgb, rgba) => {
      if (!img) return;
      const d = img.data;
      if (rgba) d.set(rgba.length === d.length ? rgba : rgba.subarray(0, d.length));
      else if (rgb) { for (let i = 0, j = 0; j < d.length; i += 3, j += 4) { d[j] = rgb[i]; d[j + 1] = rgb[i + 1]; d[j + 2] = rgb[i + 2]; d[j + 3] = 255; } }
      g.putImageData(img, 0, 0);
      st.frames += 1;
      if (st.frames === 1) { cv.style.display = 'block'; st.state = 'running'; }
    });
    ev.onExit(() => { st.state = 'exited'; cv.style.display = 'none'; document.body.textContent = 'session ended'; });
    try { ci.mute(); } catch (e) {}
    // a heartbeat from the emulator itself: DOSBox only sends a frame when the
    // picture changes, so a still game screen is not a hung one. beats only
    // grows while the emulator answers.
    st.beats = 0;
    setInterval(() => { Promise.resolve(ci.asyncifyStats()).then(() => { st.beats += 1; }, () => {}); }, 1000);

    // keys: her pad (pulse width) plus real key events
    const mapped = [...new Set(Object.values(P.keys).filter((v) => typeof v === 'string'))];
    const dom = {};
    const set = (code, down) => {
      if (!!st.held[code] === down) return;
      const k = P.codes[code];
      if (!k) return;
      st.held[code] = down;
      ci.sendKeyEvent(k, down);
      st.sent += 1;
    };
    window.addEventListener('keydown', (e) => { if (P.codes[e.code]) { dom[e.code] = true; set(e.code, true); e.preventDefault(); } }, true);
    window.addEventListener('keyup', (e) => { if (P.codes[e.code]) { dom[e.code] = false; set(e.code, false); e.preventDefault(); } }, true);
    window.addEventListener('blur', () => { for (const c of Object.keys(dom)) dom[c] = false; });
    setInterval(() => {
      let want = [];
      const pads = navigator.getGamepads ? navigator.getGamepads() : [];
      const p = pads && pads[0];
      if (p) { st.padReads += 1; want = padKeys({ axes: p.axes, buttons: p.buttons }, P.keys, performance.now()); }
      for (const code of mapped) set(code, want.includes(code) || !!dom[code]);
      for (const code of Object.keys(dom)) if (!mapped.includes(code)) set(code, !!dom[code]);
    }, 10);
    // the game's own menus (P.keys.menu): tap a key while the picture is menu sized
    const M = P.keys.menu;
    if (M && P.codes[M.key]) {
      let wideSince = 0, lastTap = 0; st.menuTaps = 0;
      setInterval(() => {
        const now = performance.now();
        if (st.state !== 'running' || st.w < M.minW) { wideSince = 0; return; }
        if (!wideSince) wideSince = now;
        if (now - wideSince < M.afterMs || now - lastTap < M.everyMs) return;
        lastTap = now; st.menuTaps += 1;
        dom[M.key] = true; setTimeout(() => { dom[M.key] = false; }, M.holdMs || 120);
      }, 250);
    }
  } catch (e) {
    st.state = 'error'; st.error = String(e && e.message || e);
  }
})();
</script>
</body></html>`;
}

/** the bundle's own wish for an engine: .jsdos/jsdos.json { "backend": "dosboxX" } is copied next to it as backend.txt by make-bundle */
function backendFor(gamesDir, id) {
  try { return fs.readFileSync(path.join(gamesDir, id, 'backend.txt'), 'utf8').trim() === 'dosboxX' ? 'dosboxX' : 'dosbox'; } catch { return 'dosbox'; }
}

/**
 * Answers /console/... ; returns false for any other path.
 * gamesDir: where <id>/bundle.jsdos live (GAMES_DIR)
 */
export function serveConsole(req, res, p, url, { gamesDir }) {
  if (!p.startsWith('/console/') && p !== '/console') return false;
  const notFound = () => { res.writeHead(404, { 'content-type': 'application/json; charset=utf-8', ...NO_STORE }); res.end('{"error":"not found"}'); return true; };
  if (!isLoopback(req)) return notFound();
  if (p === '/console/dos') {
    const id = url.searchParams.get('b') || '';
    if (!idOk(id)) return notFound();
    const html = pageHtml({ id, keys: keysForStage(id), backend: backendFor(gamesDir, id) });
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...NO_STORE });
    res.end(html);
    return true;
  }
  let m = p.match(/^\/console\/dos\/emu\/([a-z0-9.-]+)$/i);
  if (m && EMU_FILES.has(m[1])) return sendFile(res, path.join(EMU_DIR, m[1]), notFound);
  m = p.match(/^\/console\/dos\/bundle\/([a-z0-9_-]+)$/i);
  if (m && idOk(m[1])) return sendFile(res, path.join(gamesDir, m[1], 'bundle.jsdos'), notFound);
  return notFound();
}

function sendFile(res, file, notFound) {
  let st;
  try { st = fs.statSync(file); } catch { return notFound(); }
  if (!st.isFile()) return notFound();
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'content-length': st.size, ...NO_STORE });
  fs.createReadStream(file).pipe(res);
  return true;
}

export { STAGE_KEYS };
