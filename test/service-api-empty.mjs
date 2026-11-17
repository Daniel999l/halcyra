/**
 * The real service (node src/index.js) with NOTHING configured: it must boot,
 * load the brain, serve every endpoint with real empty states, and stop
 * cleanly on SIGTERM.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { getJson, sse, check, finish } from './service-fixtures.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const R = []; const ok = check(R);
console.log('service-api-empty\n');

const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => r(p)); }); });
const port = await freePort();
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'halcyra-empty-'));
// a clean environment: only what a shell needs, none of the service's variables
const env = { PATH: process.env.PATH, HOME: process.env.HOME, PORT: String(port), DATA_DIR: dataDir };
const t0 = Date.now();
const child = spawn(process.execPath, ['src/index.js'], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
let out = '';
child.stdout.on('data', (d) => { out += d; });
child.stderr.on('data', (d) => { out += d; });
const base = `http://127.0.0.1:${port}`;

// wait for the API, then for the brain
for (let i = 0; i < 200; i += 1) { try { if ((await fetch(`${base}/api/health`)).ok) break; } catch { /* not yet */ } await new Promise((r) => setTimeout(r, 100)); }
let h;
for (let i = 0; i < 600; i += 1) { h = (await getJson(base, '/api/health')).body; if (h.brain.state !== 'starting') break; await new Promise((r) => setTimeout(r, 100)); }
console.log(`  booted, brain ${h.brain.state} after ${((Date.now() - t0) / 1000).toFixed(1)} s, rss ${h.memoryMb} MB`);

ok(h.ok === true, '/api/health ok');
ok(h.storage.mode === 'memory' && /memory ring only/.test(h.storage.note), '/api/health says there is no Mongo and ticks are memory only', h.storage.note);
ok(h.console.state === 'off' && h.stream.state === 'off' && h.watcher.state === 'off', 'console, stream and watcher are off');
ok(['loaded', 'missing'].includes(h.brain.state), `brain state is "${h.brain.state}"`, h.brain.detail || `${h.brain.neurons} neurons`);

const all = [];
const st = await getJson(base, '/api/state'); all.push(st);
ok(st.status === 200 && st.body.totals.ticks === 0 && st.body.totals.trades === 0 && st.body.totals.buys === 0 && st.body.totals.solIn === 0, '/api/state totals are all zero');
ok(st.body.token === null && st.body.tick === null && st.body.head.step === -1, '/api/state: no token, no tick, head at -1');
ok(st.body.game === 'GTA 1' && st.body.project === 'Halcyra Neuro' && st.body.ticker === 'HALCYRA', '/api/state defaults: game "GTA 1", project "Halcyra Neuro", ticker HALCYRA');

const tr = await getJson(base, '/api/trades'); all.push(tr);
ok(tr.status === 200 && Array.isArray(tr.body.trades) && tr.body.trades.length === 0, '/api/trades is an empty array');
const tk = await getJson(base, '/api/ticks?after=-1&limit=50'); all.push(tk);
ok(tk.status === 200 && tk.body.ticks.length === 0, '/api/ticks is an empty array');
const t0r = await getJson(base, '/api/ticks/0'); all.push(t0r);
ok(t0r.status === 404, '/api/ticks/0 is 404 before any tick');
const cp = await getJson(base, '/api/checkpoints'); all.push(cp);
ok(cp.status === 200 && cp.body.checkpoints.length === 0, '/api/checkpoints is an empty array');
const pr = await getJson(base, '/api/proof'); all.push(pr);
const b = pr.body.brain || {};
ok(b.dataset === 'FlyWire FAFB v783' && b.neurons === 139255 && b.connections === 2700513, '/api/proof reads dataset and counts from site/fly/meta.json');
ok(/^[0-9a-f]{64}$/.test(b.connectome?.sha256 || ''), '/api/proof carries the sha256 of connectome.bin.gz', b.connectome?.sha256);
ok(b.model?.gains?.Gc === 8, '/api/proof carries the fitted gains from gains.json');
ok(!('token' in pr.body), '/api/proof has no token block without TOKEN_CA');
if (h.brain.state === 'loaded') ok(pr.body.taste ? pr.body.taste.sweet.count > 0 : true, '/api/proof taste cells (when taste.js is present)', pr.body.taste ? `${pr.body.taste.sweet.count} sweet, ${pr.body.taste.bitter.count} bitter` : 'taste.js absent');
const fr = await fetch(`${base}/api/frame.jpg`);
ok(fr.status === 204, '/api/frame.jpg is 204 with no console');
{
  const r = await fetch(base + '/'); const html = await r.text();
  ok(r.status === 200 && r.headers.get('cache-control') === 'no-store' && /text\/html/.test(r.headers.get('content-type') || '') && html.includes('Halcyra Neuro') && html.includes('GTA 1'), '/ is the landing page: 200, no-store, names the project and the game');
  ok(!/Buy \$|pump\.fun\/coin/.test(html), '/ has no Buy button and no coin link without TOKEN_CA');
  for (const pth of ['/proof', '/whitepaper']) {
    const d = await fetch(base + pth); const t = await d.text();
    ok(d.status === 200 && /no-store/.test(d.headers.get('cache-control') || '') && t.includes('Halcyra Neuro'), `${pth}: 200, no-store`, `status ${d.status} cc ${d.headers.get('cache-control')} len ${t.length} ${t.slice(0, 160).replace(/\s+/g, ' ')}`);
  }
}
const nf = await getJson(base, '/nope');
ok(nf.status === 404, 'unknown path is 404');

ok(all.every((r) => r.headers.get('cache-control') === 'no-store'), 'every response is Cache-Control: no-store');
ok(all.every((r) => r.headers.get('access-control-allow-origin') === '*'), 'every response is CORS open');
const banned = /coming soon|\bsoon\b|loading|\bTBA\b|not deployed/i;
const hits = all.filter((r) => banned.test(r.text)).map((r) => r.text.match(banned)[0]);
ok(hits.length === 0, 'no "coming soon / soon / loading / TBA / not deployed" anywhere', hits.join(','));

const live = await sse(`${base}/api/live`);
await new Promise((r) => setTimeout(r, 400));
ok(live.headers.get('content-type') === 'text/event-stream' && live.events[0]?.event === 'hello', '/api/live answers with an SSE hello');
live.close();

const exited = new Promise((r) => child.on('exit', (code, sig) => r({ code, sig })));
child.kill('SIGTERM');
const ex = await Promise.race([exited, new Promise((r) => setTimeout(() => r({ code: 'timeout' }), 20000))]);
ok(ex.code === 0, 'SIGTERM -> clean exit 0', JSON.stringify(ex));
if (!R.every((r) => r.ok)) console.log(`\n--- service log ---\n${out}`);
else console.log(`\n  service log (first lines):\n${out.split('\n').slice(0, 14).map((l) => `    ${l}`).join('\n')}`);
fs.rmSync(dataDir, { recursive: true, force: true });
finish(R, 'service-api-empty');
