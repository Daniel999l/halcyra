/**
 * A game bundle coming in over PUT /admin/games/<id> (src/games.js):
 *   - the address does not exist without ADMIN_KEY, and refuses a wrong key
 *   - a bundle lands in GAMES_DIR, is kept in the database, and the console
 *     starts on it without a restart
 *   - a fresh start with an empty GAMES_DIR brings it back from the database
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startApp } from '../src/index.js';
import { memDb } from './memdb.mjs';
import { standinPilot, standinTaste, fakeConsoleFactory, testConfig, getJson, check, finish } from './service-fixtures.mjs';
import { say } from '../src/log.js';

say.quiet = true;
const R = []; const ok = check(R);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
console.log('games upload\n');

const KEY = 'test-key-123';
const zip = Buffer.concat([Buffer.from('PK\u0003\u0004'), Buffer.alloc(300000, 7)]);
const put = (base, id, body, key, q = '') => fetch(`${base}/admin/games/${id}${q}`, { method: 'PUT', headers: key ? { 'x-admin-key': key } : {}, body });
const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'halcyra-up-'));
const mods = { pilot: standinPilot, taste: standinTaste };

// ---- 1. no ADMIN_KEY: the address is not there
{
  const g = dir();
  const app = await startApp({ cfg: testConfig({ gamesDir: g, adminKey: '' }), db: memDb(), modules: mods, consoleFactory: fakeConsoleFactory() });
  const r = await put(`http://127.0.0.1:${app.port}`, 'gta1', zip, KEY);
  ok(r.status === 404 && !fs.existsSync(path.join(g, 'gta1', 'bundle.jsdos')), 'without ADMIN_KEY the upload address answers 404 and writes nothing', String(r.status));
  await app.stop();
}

// ---- 2. upload, hot start, stored
const db = memDb();
const g1 = dir();
const app = await startApp({ cfg: testConfig({ gamesDir: g1, adminKey: KEY }), db, modules: mods, consoleFactory: fakeConsoleFactory() });
const base = `http://127.0.0.1:${app.port}`;
let h = (await getJson(base, '/api/health')).body;
ok(h.console.state === 'off', 'no bundle yet: the console is off', h.console.state);
let r = await put(base, 'gta1', zip, 'wrong');
ok(r.status === 401, 'a wrong key is refused', String(r.status));
r = await put(base, 'gta1', zip, '');
ok(r.status === 401, 'no key is refused', String(r.status));
r = await put(base, '..%2Fx', zip, KEY);
ok(r.status === 400, 'a bad stage id is refused', String(r.status));
r = await put(base, 'gta1', Buffer.from('hello, not a zip'), KEY);
ok(r.status === 400 && !fs.existsSync(path.join(g1, 'gta1', 'bundle.jsdos')), 'a body that is not a bundle is refused and leaves no file', String(r.status));
r = await put(base, 'gta1', zip, KEY);
const j = await r.json();
const onDisk = fs.existsSync(path.join(g1, 'gta1', 'bundle.jsdos')) ? fs.readFileSync(path.join(g1, 'gta1', 'bundle.jsdos')) : Buffer.alloc(0);
ok(r.status === 200 && j.ok && j.bytes === zip.length && j.stored === true, 'the bundle is accepted and stored', JSON.stringify(j));
ok(onDisk.equals(zip), 'the file on disk is byte for byte what was sent');
ok(!fs.readdirSync(path.join(g1, 'gta1')).some((f) => f.endsWith('.part')), 'no partial file is left behind');
for (let i = 0; i < 50; i += 1) { h = (await getJson(base, '/api/health')).body; if (h.console.state === 'playing') break; await sleep(50); }
ok(h.console.state === 'playing', 'the console starts on the new bundle without a restart', h.console.state);
const lad = (await getJson(base, '/api/ladder')).body;
ok(lad.playing?.id === 'gta1', 'the ladder says GTA 1 is on screen', JSON.stringify(lad.playing));
ok(h.games?.gta1?.bytes === zip.length && h.games.gta1.kept === 'stored', '/api/health lists the bundle', JSON.stringify(h.games));
const page = await fetch(`${base}/admin/games/gta1`);
ok(page.status === 405, 'the address takes no GET', String(page.status));
const leak = await fetch(`${base}/console/dos/bundle/gta1`, { headers: { 'x-forwarded-for': '203.0.113.9' } });
ok(leak.status === 404, 'the bundle is not downloadable by a visitor', String(leak.status));
await app.stop();

// ---- 3. restart on an empty disk: restored from the database
{
  const g2 = dir();
  const app2 = await startApp({ cfg: testConfig({ gamesDir: g2, adminKey: KEY }), db, modules: mods, consoleFactory: fakeConsoleFactory() });
  const b2 = `http://127.0.0.1:${app2.port}`;
  const f = path.join(g2, 'gta1', 'bundle.jsdos');
  ok(fs.existsSync(f) && fs.readFileSync(f).equals(zip), 'after a restart on an empty disk the bundle is back, byte for byte');
  let h2;
  for (let i = 0; i < 50; i += 1) { h2 = (await getJson(b2, '/api/health')).body; if (h2.console.state === 'playing') break; await sleep(50); }
  ok(h2.console.state === 'playing' && h2.games?.gta1?.kept === 'stored', 'and she starts on it by herself', `${h2.console.state} ${JSON.stringify(h2.games)}`);
  await app2.stop();
}

finish(R, 'games-upload');
