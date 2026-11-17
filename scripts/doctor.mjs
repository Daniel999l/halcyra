/**
 * npm run doctor - check every outside piece without starting anything.
 * Prints ok / -- (off, by choice) / FAIL. Exit 1 if anything FAILs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { cfg } from '../src/config.js';
import { fileSha256 } from '../src/state.js';

const ok = (m) => console.log(`  \x1b[32mok\x1b[0m   ${m}`);
const off = (m) => console.log(`  \x1b[33m--\x1b[0m   ${m}`);
let fails = 0;
const fail = (m) => { fails += 1; console.log(`  \x1b[31mFAIL\x1b[0m ${m}`); };
console.log(`\n${cfg.projectName} doctor\n`);

const [maj] = process.versions.node.split('.').map(Number);
if (maj >= 20) ok(`node ${process.versions.node}`); else fail(`node ${process.versions.node}: needs 20 or newer`);

// the brain files
for (const f of ['connectome.bin.gz', 'neurons.tsv.gz', 'eyemap.json', 'meta.json', 'gains.json', 'rate.js']) {
  if (!fs.existsSync(path.join(cfg.flyDir, f))) fail(`site/fly/${f} is missing`);
}
if (fs.existsSync(path.join(cfg.flyDir, 'connectome.bin.gz'))) ok(`connectome.bin.gz sha256 ${await fileSha256(path.join(cfg.flyDir, 'connectome.bin.gz'))}`);
for (const [f, what] of [['gamepilot.js', 'brain + pad'], ['braincore.js', 'brain core'], ['brainworker.js', 'brain worker thread'], ['taste.js', 'taste'], ['chain/index.js', 'trade watcher (TASTE)']]) {
  if (fs.existsSync(path.join(cfg.root, 'src', f))) ok(`src/${f} present (${what})`); else fail(`src/${f} is missing (${what})`);
}

// mongo
if (!cfg.mongo.uri) off('no MONGO_URI: ticks live in a memory ring only and are lost on restart');
else {
  try {
    const { MongoClient } = await import('mongodb');
    const c = new MongoClient(cfg.mongo.uri, { serverSelectionTimeoutMS: 10000 });
    await c.connect(); await c.db(cfg.mongo.db).command({ ping: 1 });
    const mine = (await c.db(cfg.mongo.db).listCollections({}, { nameOnly: true }).toArray()).map((x) => x.name).filter((n) => n.startsWith('halcyra_'));
    await c.close();
    ok(`MongoDB reachable (db "${cfg.mongo.db}", halcyra_ collections: ${mine.join(', ') || 'none yet'})`);
  } catch (e) { fail(`MongoDB: ${e.message}`); }
}

// token + rpc
if (!cfg.tokenCa) off('no TOKEN_CA: the trade watcher stays off');
else {
  try {
    const chain = await import('../src/chain/index.js');
    if (!chain.isMint(cfg.tokenCa)) fail(`TOKEN_CA ${cfg.tokenCa} is not a Solana mint address`);
    else {
      const coin = await chain.readCoin(cfg.tokenCa).catch((e) => { throw new Error(`readCoin: ${e.message}`); });
      if (coin) ok(`TOKEN_CA ${cfg.tokenCa}: ${coin.name || '?'} ($${coin.symbol || '?'})${coin.graduated ? ', graduated' : ''}`);
      else fail(`TOKEN_CA ${cfg.tokenCa}: no pump.fun coin found at that mint`);
    }
  } catch (e) { fail(`TOKEN_CA check: ${e.message}`); }
}
try {
  const r = await fetch(cfg.rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSlot' }), signal: AbortSignal.timeout(10000) });
  const j = await r.json();
  if (j.result) ok(`Solana RPC answers (slot ${j.result})`); else fail(`Solana RPC: ${JSON.stringify(j.error || j).slice(0, 120)}`);
} catch (e) { fail(`Solana RPC ${cfg.rpcUrl}: ${e.message}`); }

// console
if (!cfg.console.url) off('no CONSOLE_URL: no browser, the brain idles');
else {
  try {
    const r = await fetch(cfg.console.url, { redirect: 'manual', signal: AbortSignal.timeout(15000) });
    ok(`CONSOLE_URL answers HTTP ${r.status}`);
  } catch (e) { fail(`CONSOLE_URL: ${e.message}`); }
  try {
    const { connectMongo } = await import('../src/db.js');
    const { loadLogin } = await import('../src/console.js');
    const db = cfg.mongo.uri ? await connectMongo({ uri: cfg.mongo.uri, db: cfg.mongo.db, keepHours: cfg.ledger.keepHours }) : null;
    const l = await loadLogin({ db, dataDir: cfg.dataDir });
    await db?.close();
    if (l) ok(`console login saved (${l.from}${l.v ? ` v${l.v}` : ''}, ${(l.state.cookies || []).length} cookies)`); else fail('no console login saved yet: run "npm run login" once');
  } catch (e) { fail(`console login: ${e.message}`); }
}

// browser
if (cfg.browser.executablePath) {
  if (fs.existsSync(cfg.browser.executablePath)) ok(`CHROME_PATH ${cfg.browser.executablePath}`); else fail(`CHROME_PATH ${cfg.browser.executablePath} does not exist`);
} else {
  try {
    const cb = await import('cloakbrowser');
    const info = await cb.binaryInfo();
    if (info.installed) ok(`cloakbrowser ${info.version} at ${info.binaryPath}`); else fail('cloakbrowser binary not installed: npm run browser:install');
  } catch (e) { fail(`cloakbrowser: ${e.message}`); }
}
if (!cfg.browser.headless) {
  if (process.env.DISPLAY) ok(`DISPLAY ${process.env.DISPLAY} (headed browser)`); else fail('HEADLESS=false but no DISPLAY: run inside the container (Xvfb) or set HEADLESS=true locally');
}

// stream
const ff = spawnSync(cfg.stream.ffmpeg, ['-version'], { encoding: 'utf8' });
if (ff.status === 0) ok(`ffmpeg: ${ff.stdout.split('\n')[0].slice(0, 60)}`); else (cfg.stream.url ? fail : off)(`no ffmpeg at "${cfg.stream.ffmpeg}"`);
if (!cfg.stream.url) off('no STREAM_URL: no livestream');
else if (!/^rtmps?:\/\/[^/]+\/.+/i.test(cfg.stream.url)) fail('STREAM_URL should look like rtmp(s)://host/app/<stream key>');
else ok(`STREAM_URL ${cfg.stream.url.replace(/^(rtmps?:\/\/[^/]+\/).*/i, '$1***')} (${cfg.stream.size} @ ${cfg.stream.fps} fps, ${cfg.stream.kbps} kbps, ${process.env.DISPLAY ? 'x11 grab' : 'screenshot pipe'})`);

console.log(`\n  ${cfg.projectName}${cfg.ticker ? ` / $${cfg.ticker}` : ''}, game "${cfg.game}", step ${cfg.loop.stepMs} ms, ticks kept ${cfg.ledger.keepHours || 'forever'} h\n`);
console.log(fails ? `\x1b[31m${fails} problem(s) above.\x1b[0m\n` : '\x1b[32mall good.\x1b[0m\n');
process.exit(fails ? 1 : 0);
