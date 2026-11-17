/**
 * Game bundles: getting a stage's bundle.jsdos onto this machine and keeping it
 * across restarts.
 *
 *   PUT /admin/games/<stage id>     body = the bundle file, header x-admin-key
 *                                   (ADMIN_KEY). Written to
 *                                   <GAMES_DIR>/<id>/bundle.jsdos, then stored in
 *                                   Mongo (halcyra_games), then the console is
 *                                   told so it can start on it.
 *   restoreGames()                  at boot: every ladder stage with our own
 *                                   /console/dos page and no bundle on disk is
 *                                   read back from Mongo.
 *
 * The bundle is never served to anyone but the console tab on this machine
 * (src/dos.js). Without ADMIN_KEY the upload address answers 404.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { say } from './log.js';

const MAX_BYTES = 900 * 1024 * 1024;
const idOk = (id) => /^[a-z0-9][a-z0-9_-]{0,31}$/i.test(String(id || ''));
export const bundleFile = (gamesDir, id) => path.join(gamesDir, id, 'bundle.jsdos');

function sameKey(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

/** the stage ids that play on our own page: /console/dos?b=<id> */
export function localIds(stages) {
  const out = [];
  for (const s of stages || []) {
    const m = s?.kind === 'browser' && String(s.url || '').match(/^\/console\/dos\?b=([a-z0-9_-]+)$/i);
    if (m) out.push(m[1]);
  }
  return out;
}

/** at boot: bring back every bundle that is stored but not on this disk */
export async function restoreGames({ db, gamesDir, stages, hub }) {
  if (!db?.loadGame) return [];
  const got = [];
  for (const id of localIds(stages)) {
    const file = bundleFile(gamesDir, id);
    if (fs.existsSync(file)) { note(hub, id, { bytes: fs.statSync(file).size, kept: 'disk' }); continue; }
    try {
      const r = await db.loadGame(id, file);
      if (!r) continue;
      if (r.meta?.backend === 'dosboxX') fs.writeFileSync(path.join(gamesDir, id, 'backend.txt'), 'dosboxX');
      note(hub, id, { bytes: r.bytes, kept: 'stored' });
      say(`game bundle ${id} restored (${Math.round(r.bytes / 1048576)} MB)`, { kind: 'games' });
      got.push(id);
    } catch (e) { say(`game bundle ${id} could not be restored: ${e.message}`, { kind: 'games', level: 'warn' }); }
  }
  return got;
}

function note(hub, id, v) { if (hub) { hub.games = hub.games || {}; hub.games[id] = { ...v, at: Date.now() }; } }

/**
 * PUT /admin/games/<id>. Returns false when the request is not for this.
 * onGame(id) is called after the file is in place (index.js starts the console on it).
 */
export function gamesRoute({ cfg, hub, db }) {
  return async function route(req, res, url) {
    const m = url.pathname.match(/^\/admin\/games\/([^/]+)\/?$/);
    if (!m) return false;
    const send = (code, body) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); return true; };
    if (!cfg.adminKey) return send(404, { error: 'not found' });
    if (req.method !== 'PUT' && req.method !== 'POST') return send(405, { error: 'PUT the bundle file' });
    if (!sameKey(req.headers['x-admin-key'] || '', cfg.adminKey)) { req.resume(); return send(401, { error: 'wrong key' }); }
    const id = m[1];
    if (!idOk(id)) { req.resume(); return send(400, { error: 'bad stage id' }); }
    const dir = path.join(cfg.gamesDir, id);
    const file = bundleFile(cfg.gamesDir, id);
    const tmp = `${file}.${process.pid}.part`;
    await fs.promises.mkdir(dir, { recursive: true });
    let bytes = 0; let head = null; let failed = '';
    const out = fs.createWriteStream(tmp);
    try {
      await new Promise((resolve, reject) => {
        req.on('data', (c) => {
          if (failed) return;
          if (!head) head = Buffer.from(c.subarray(0, 4));
          bytes += c.length;
          if (bytes > MAX_BYTES) { failed = 'too big'; req.unpipe(out); out.destroy(); resolve(); return; }
        });
        req.on('error', reject); out.on('error', reject);
        out.on('finish', resolve);
        req.pipe(out);
      });
    } catch (e) { failed = failed || e.message; }
    const zip = head && head[0] === 0x50 && head[1] === 0x4b;
    if (failed || !bytes || !zip) {
      await fs.promises.rm(tmp, { force: true }).catch(() => {});
      return send(400, { error: failed || (!bytes ? 'empty body' : 'not a bundle (a .jsdos file is a zip)') });
    }
    await fs.promises.rename(tmp, file);
    const backend = url.searchParams.get('backend') === 'dosboxX' ? 'dosboxX' : 'dosbox';
    const bt = path.join(dir, 'backend.txt');
    if (backend === 'dosboxX') await fs.promises.writeFile(bt, 'dosboxX'); else await fs.promises.rm(bt, { force: true }).catch(() => {});
    note(hub, id, { bytes, kept: 'disk' });
    say(`game bundle ${id} received (${Math.round(bytes / 1048576)} MB)`, { kind: 'games' });
    // keep a copy so a restart brings it back, then tell the console
    let stored = false; let why = '';
    if (db?.saveGame) {
      try { await db.saveGame(id, file, { backend, bytes }); stored = true; note(hub, id, { bytes, kept: 'stored' }); } catch (e) { why = e.message; say(`game bundle ${id} was not stored: ${e.message}`, { kind: 'games', level: 'warn' }); }
    } else why = 'no database';
    try { await hub.onGame?.(id); } catch (e) { say(`console did not start on ${id}: ${e.message}`, { kind: 'games', level: 'warn' }); }
    return send(200, { ok: true, id, bytes, stored, ...(stored ? {} : { note: `on this machine only (${why}): send it again after a restart` }) });
  };
}
