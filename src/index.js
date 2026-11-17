/**
 * The whole thing, one process.
 *
 *   config -> db (if MONGO_URI) -> ledger resume -> API up -> brain (loadFly)
 *   -> taste cells -> trade watcher (if TOKEN_CA) -> ladder (src/ladder.js)
 *   -> console tab (CONSOLE_URL, else the ladder's stage when its game files are here)
 *   -> loop every STEP_MS { taste.sample, pilot.step, ledger.append, state, SSE }
 *   -> livestream (if STREAM_URL)
 *
 * Nothing in this list is allowed to take the process down: a missing module,
 * a dead database or a bad step is logged, shown in /api/health, and skipped.
 */
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { say } from './log.js';
import { Ledger } from './ledger.js';
import { Hub, buildProof } from './state.js';
import { createServer } from './server.js';
import { Ladder } from './ladder.js';
import { Keyer } from './keyer.js';
import { STAGE_KEYS } from './stagekeys.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** import a sibling module; a missing file is a clear message, not a crash */
export async function tryImport(rel, what) {
  try {
    return await import(new URL(rel, import.meta.url).href);
  } catch (e) {
    const missing = e.code === 'ERR_MODULE_NOT_FOUND' && String(e.message).includes(rel.replace(/^\.\//, ''));
    say(`${what}: ${missing ? `${rel} is not there yet` : `${rel} failed to load: ${String(e.message).split('\n')[0]}`}`, { kind: 'boot' });
    return null;
  }
}

/**
 * Everything but process wiring, so tests can run it with stand-ins.
 *   modules: { pilot, taste, chain, gamebody } (module namespaces, any may be null)
 *   consoleFactory(opts) -> { start(), stop(), playing, page }   (default: src/console.js)
 *   streamFactory(opts)  -> { start(), stop() }                  (default: src/stream.js)
 */
export async function startApp({ cfg, db = null, dbNote = '', modules = {}, consoleFactory = null, streamFactory = null, listen = true, ladderRead = null }) {
  const ledger = new Ledger({ db, ...cfg.ledger });
  const hub = new Hub({ cfg, ledger, db, dbNote });
  ledger.onReset = (head) => hub.broadcast('reset', head);
  const head = await ledger.resume().catch((e) => { say(`ledger resume failed: ${e.message}`, { kind: 'boot' }); return ledger.head(); });
  say(`ledger at step ${head.step} (${head.hash.slice(0, 12)})`, { kind: 'boot' });

  const server = createServer({ cfg, hub, ledger, db });
  if (listen) await new Promise((r) => server.listen(cfg.port, '0.0.0.0', r));
  const port = listen ? server.address().port : null;
  if (listen) say(`API on http://0.0.0.0:${port}`, { kind: 'boot' });

  const app = { cfg, db, ledger, hub, server, port, pilot: null, taste: null, watcher: null, consoleTab: null, streamer: null, stopping: false };

  // the file-based half of the proof first, so /api/proof is right from the first second
  hub.proof = await buildProof({ cfg }).catch((e) => { say(`proof: ${e.message}`); return null; });

  // ---- the brain
  const P = modules.pilot; const T = modules.taste; const C = modules.chain;
  let names = null; let tasteCells = null;
  if (P?.loadFly && P?.GamePilot) {
    try {
      const t0 = Date.now();
      const c = await P.loadFly();
      names = P.flyNames?.() || null;
      hub.brain = { state: 'starting', neurons: c.N, connections: c.E, loadMs: Date.now() - t0 };
      say(`brain loaded: ${c.N.toLocaleString()} neurons, ${c.E.toLocaleString()} connections (${Date.now() - t0} ms, rss ${Math.round(process.memoryUsage().rss / 1048576)} MB)`, { kind: 'boot' });
    } catch (e) {
      hub.brain = { state: 'error', detail: e.message };
      say(`brain failed to load: ${e.message}`, { kind: 'boot' });
    }
  } else hub.brain = { state: 'missing', detail: 'src/gamepilot.js is not available' };

  if (T?.findTasteCells && names) {
    try {
      tasteCells = T.findTasteCells(names);
      say(`taste cells: ${tasteCells.sweet.length} sweet, ${tasteCells.bitter.length} bitter`, { kind: 'boot' });
    } catch (e) { say(`taste cells not found: ${e.message}`, { kind: 'boot' }); }
  }
  // the taste is rounded to the ledger's own decimals, so the stored tick is
  // exactly what drove her and replayTaste() rebuilds it from the ledger alone
  if (T?.Taste) app.taste = new T.Taste({ dp: cfg.ledger.decimals });
  if (hub.brain.state === 'starting') {
    try {
      // 'frame': the game element is read inside the page, so the visible
      // window is never touched (the CDP 'small' capture re-renders a real
      // window small for a moment, which a screen grab shows as a tiny game)
      const eye = ['frame', 'png', 'small'].includes(cfg.loop.eye) ? cfg.loop.eye : 'frame';
      app.pilot = new P.GamePilot({ seed: cfg.loop.seed, tasteCells, eye, thread: cfg.loop.thread });
      hub.brain.eye = eye;
      hub.brain.thread = app.pilot.thread || 'main';
      hub.brain.brainMs = cfg.loop.brainMs;
      hub.brain.seed = cfg.loop.seed;
      hub.getTelemetry = () => app.pilot?.telemetry?.() ?? null;
      hub.brain = { ...hub.brain, rssMb: Math.round(process.memoryUsage().rss / 1048576) };
      say(`pilot ready (rss ${hub.brain.rssMb} MB)`, { kind: 'boot' });
    } catch (e) { hub.brain = { state: 'error', detail: e.message }; say(`pilot: ${e.message}`, { kind: 'boot' }); }
  }

  hub.proof = await buildProof({ cfg, tasteCells, names, pilotInfo: pilotInfo(P, modules.gamebody), pilot: app.pilot, taste: app.taste }).catch((e) => { say(`proof: ${e.message}`); return hub.proof; });
  if (app.pilot) hub.brain.state = 'loaded';

  // ---- trades
  if (db) {
    try {
      Object.assign(hub.totals, await db.tradeTotals());
      hub.trades = (await db.trades(200)).map((t) => ({ ...t }));
      for (const t of hub.trades) hub.seen.add(t.sig);
      const { tradeRow } = await import('./state.js');
      hub.trades = hub.trades.map(tradeRow);
    } catch (e) { say(`stored trades not read: ${e.message}`, { kind: 'boot' }); }
  }
  if (cfg.tokenCa && C?.createTradeWatcher) {
    try {
      const saved = db ? await db.getState('watcher').catch(() => null) : null;
      const fromSlot = saved?.mint === cfg.tokenCa ? (saved.lastSlot ?? null) : (db ? await db.lastTradeSlot().catch(() => null) : null);
      let lastSave = 0;
      app.watcher = C.createTradeWatcher({
        mint: cfg.tokenCa,
        fromSlot,
        pollMs: cfg.tradePollMs,
        onTrade: (t) => onTrade(app, t),
        onSlot: (slot) => {
          hub.watcher.lastSlot = slot; hub.watcher.state = 'on';
          if (db && Date.now() - lastSave > 30000) { lastSave = Date.now(); db.setState('watcher', { mint: cfg.tokenCa, lastSlot: slot }).catch(() => {}); }
        },
      });
      app.watcher.start();
      hub.watcher = { state: 'on', detail: `watching ${cfg.tokenCa}`, lastSlot: fromSlot };
      say(`trade watcher on for ${cfg.tokenCa}${fromSlot ? ` from slot ${fromSlot}` : ''}`, { kind: 'boot' });
    } catch (e) { hub.watcher = { state: 'error', detail: e.message }; say(`trade watcher: ${e.message}`, { kind: 'boot' }); }
  } else if (cfg.tokenCa) hub.watcher = { state: 'error', detail: 'src/chain/index.js is not available' };

  // ---- the ladder: which game, by market cap (src/ladder.js)
  const native = cfg.consoleKind === 'native';
  const ladder = new Ladder({
    cfg, db, ledger,
    read: ladderRead || modules.mcap?.readMarketCap || null,
    onUnlock: (s, rec) => hub.broadcast('unlock', { stage: { id: s.id, game: s.game, usd: s.usd }, step: rec?.step ?? null, hash: rec?.hash ?? null }),
    onTarget: async (s) => {
      cfg.game = s.game;
      const url = ladder.urlFor(s);
      if (app.consoleTab?.goTo) app.consoleTab.goTo(url);
      else if (!app.consoleTab) await openConsole(url);
    },
  });
  ladder.port = port ?? cfg.port;
  app.ladder = ladder; hub.ladder = ladder;
  await ladder.load();
  if (native) {
    // the Windows PC: the game there is the last native stage
    const s = [...ladder.stages].reverse().find((x) => x.kind === 'native') || null;
    ladder.setMode('native');
    ladder.setTarget(s ? { ...s, game: process.env.GAME ? cfg.game : s.game } : { id: null, game: cfg.game, kind: 'native' });
    if (s && !process.env.GAME) cfg.game = s.game;
  } else if (cfg.console.url) {
    // a fixed console page: the ladder records unlocks, the tab stays where it is
    ladder.setMode('fixed');
    ladder.setTarget({ id: null, game: cfg.game, kind: 'browser' });
  } else ladder.setMode('ladder');

  // ---- the console tab
  let page = null;
  if (native && app.pilot) hub.brain.eye = 'native';
  /** which key table turns her pad into keys on this page (src/keyer.js), or null */
  function keyTable() {
    const k = cfg.console.keys;
    if (k === 'off') return null;
    if (k) return { id: k, map: STAGE_KEYS[k] || STAGE_KEYS.default };
    // auto: a ladder stage played on an outside page gets its own table; our own
    // /console/dos page maps the pad to keys inside the page
    const t = ladder.target;
    if (ladder.mode === 'ladder' && t?.url && !t.url.startsWith('/')) return { id: t.id, map: STAGE_KEYS[t.id] || STAGE_KEYS.default };
    return null;
  }
  async function openConsole(url) {
    // native: the game runs on this machine, no browser is launched (src/native/console.js)
    const make = consoleFactory || (native
      ? async (o) => new (await import('./native/console.js')).NativeConsole(o)
      : async (o) => new (await import('./console.js')).ConsoleTab(o));
    app.consoleTab = await make({
      cfg, db, url,
      onStatus: (s, d) => { hub.setConsole(s, d); ladder.setConsole(s, d); },
      onFrame: (buf) => hub.setFrame(buf),
      // the pad goes in before the console page's own scripts run, then again
      // after load for the overlay (attach is idempotent)
      onPage: async (p) => { if (app.pilot) await reattach(app.pilot, p); },
      onReady: async (p) => {
        if (app.pilot) await reattach(app.pilot, p);
        page = p;
        await app.keyer?.stop().catch(() => {}); app.keyer = null;
        const k = keyTable();
        if (k && !p.native && p.keyboard) app.keyer = new Keyer({ page: p, map: k.map, name: k.id }).start();
      },
      onLost: async () => { page = null; await app.keyer?.stop().catch(() => {}); app.keyer = null; },
    });
    app.consoleTab.start();
  }
  if (cfg.console.url || native) await openConsole(cfg.console.url);
  else {
    const best = ladder.bestPlayable();
    if (best) {
      ladder.setTarget(best);
      cfg.game = best.game;
      say(`console: ${best.game} (ladder stage ${best.index + 1})`, { kind: 'boot' });
      await openConsole(ladder.urlFor(best));
    } else hub.setConsole('off', `CONSOLE_URL is not set and no game files for ${ladder.stages[0].game} are on this machine (GAMES_DIR): no browser, the brain is idle`);
  }
  ladder.start();

  // ---- how long the event loop was ever held up (HTTP, SSE and the trade watcher wait for it)
  const lag = monitorEventLoopDelay({ resolution: 10 });
  lag.enable();
  let lagWindowStart = Date.now(); let lagMaxEver = 0;
  const lagTimer = setInterval(() => {
    const max = lag.max / 1e6; lagMaxEver = Math.max(lagMaxEver, max);
    hub.loop.eventLoopLagMs = { p50: +(lag.percentile(50) / 1e6).toFixed(1), p99: +(lag.percentile(99) / 1e6).toFixed(1), max: +max.toFixed(1), overSeconds: Math.round((Date.now() - lagWindowStart) / 1000), maxSinceBoot: +lagMaxEver.toFixed(1) };
    if (Date.now() - lagWindowStart >= 60000) { lag.reset(); lagWindowStart = Date.now(); }
  }, 5000);
  lagTimer.unref();
  app.lag = lag;

  // ---- the loop
  const loop = (async () => {
    let fails = 0;
    while (!app.stopping) {
      const t0 = Date.now();
      if (page && app.pilot && (!app.consoleTab || app.consoleTab.playing)) {
        try {
          const tasteAt = Date.now();
          const taste = app.taste ? app.taste.sample(tasteAt) : null;
          const tick = await app.pilot.step(page, { ms: cfg.loop.brainMs, taste });
          // tasteAt = the time handed to Taste.sample, so the taste can be replayed from the ledger alone
          app.keyer?.setPad(tick.pad);
          const rec = ledger.append(app.taste ? { ...tick, tasteAt } : tick);
          hub.onTick(rec, tick.lit);
          hub.setView(app.pilot.lastView);
          hub.loop.lastStepMs = Date.now() - t0;
          hub.loop.avgStepMs = Math.round(hub.loop.avgStepMs ? hub.loop.avgStepMs * 0.9 + hub.loop.lastStepMs * 0.1 : hub.loop.lastStepMs);
          fails = 0;
        } catch (e) {
          fails += 1;
          hub.loop.errors += 1;
          hub.loop.lastError = String(e.message).split('\n')[0].slice(0, 200);
          if (fails === 1 || fails % 50 === 0) say(`step failed (${fails} in a row): ${hub.loop.lastError}`, { kind: 'loop' });
        }
      }
      await sleep(Math.max(5, cfg.loop.stepMs - (Date.now() - t0)));
    }
  })();
  app.loopDone = loop;
  // a partial bucket is stored after FLUSH_MS even if no more ticks come (console down)
  const flushTimer = setInterval(() => {
    if (ledger.pending.length && Date.now() - ledger.lastFlushAt > ledger.flushMs) ledger.flush().catch(() => {});
    storeUnsaved(app).catch(() => {});
  }, 30000);
  flushTimer.unref();

  // ---- the stream
  if (cfg.stream.url) {
    const make = streamFactory || (async (o) => new (await import('./stream.js')).Streamer(o));
    // native on Windows: the stream grabs the desktop itself ('desktop' mode in src/stream.js)
    app.streamer = await make({ ...cfg.stream, ...(native && process.platform === 'win32' ? { mode: 'desktop' } : {}), getFrame: () => hub.frame, onStatus: (s) => { hub.stream = { ...s }; } });
    app.streamer.start();
  }

  app.stop = async () => {
    if (app.stopping) return;
    app.stopping = true;
    clearInterval(flushTimer); clearInterval(lagTimer); lag.disable();
    say('shutting down', { kind: 'boot' });
    try { app.watcher?.stop(); } catch { /* gone */ }
    try { app.ladder?.stop(); } catch { /* gone */ }
    await app.keyer?.stop().catch(() => {});
    await Promise.race([app.loopDone, sleep(5000)]);
    await Promise.allSettled([app.consoleTab?.stop?.(), app.streamer?.stop?.()]);
    await app.pilot?.close?.().catch(() => {});
    await ledger.flush().catch(() => {});
    await storeUnsaved(app).catch(() => {});
    hub.closeClients();
    await new Promise((r) => { server.close(() => r()); server.closeAllConnections?.(); setTimeout(r, 2000); });
    await db?.close?.();
  };
  return app;
}

async function reattach(pilot, p) {
  try { await pilot.detach?.(); } catch { /* fresh */ }
  await pilot.attach(p);
}

/**
 * A trade from the watcher. Keyed by its signature: the store has a unique
 * index on sig, so a trade the watcher hands over again (after a restart it
 * may replay the last slot) is neither stored, counted nor tasted twice.
 */
async function onTrade(app, t) {
  try {
    if (!t || !t.sig) return;
    if (app.hub.seen.has(t.sig)) return;
    let fresh = true;
    t = { ...t, receivedAt: Date.now() }; // when she got it (stored with it; trades older than the first tick held are not in the replay)
    if (app.db) {
      try { fresh = (await app.db.insertTrade(t)).ok; } catch (e) {
        // tasted now, stored later: kept until an insert goes through (a duplicate then means it was stored after all)
        app.unsaved = app.unsaved || new Map();
        app.unsaved.set(t.sig, t);
        say(`trade not stored yet (${e.message}); tasted, will store it on the next try`, { kind: 'trade' });
      }
    }
    app.hub.seen.add(t.sig);
    if (!fresh) return; // stored by an earlier run: already tasted then
    app.taste?.push(t);
    app.hub.onTrade(t);
  } catch (e) { say(`trade handler: ${e.message}`, { kind: 'trade' }); }
}

/** retry trades whose insert failed (database away) */
async function storeUnsaved(app) {
  if (!app.db || !app.unsaved?.size) return;
  for (const [sig, t] of app.unsaved) {
    try { await app.db.insertTrade(t); app.unsaved.delete(sig); } catch { return; }
  }
}

/** what the pilot modules say about the readout, if they say it; nothing invented */
function pilotInfo(P, gb) {
  const out = {};
  try {
    const rd = P?.flyReadouts?.();
    if (rd) {
      out.descending = { left: rd.dnLeft?.length, right: rd.dnRight?.length };
      const nm = P?.flyNames?.() || [];
      const cell = (i, side) => ({ index: i, rootId: nm[i]?.id, side });
      out.descendingRule = 'every cell whose super_class is "descending", split by side (cells with no side are not used)';
      if (rd.types) out.types = Object.fromEntries(Object.entries(rd.types).map(([k, v]) => [k, { left: v.L?.length ?? 0, right: v.R?.length ?? 0, cells: [...(v.L || []).map((i) => cell(i, 'left')), ...(v.R || []).map((i) => cell(i, 'right'))] }]));
    }
  } catch { /* not there */ }
  if (gb) {
    if (gb.PAD_MAPPING) out.mapping = gb.PAD_MAPPING;
    if (gb.GAMEBODY_DEFAULTS) out.bodyGains = gb.GAMEBODY_DEFAULTS;
  }
  return out;
}

async function main() {
  const { cfg } = await import('./config.js');
  say(`${cfg.projectName} booting (${cfg.game})`, { kind: 'boot' });
  let db = null; let dbNote = '';
  if (cfg.mongo.uri) {
    try {
      const { connectMongo } = await import('./db.js');
      db = await connectMongo({ uri: cfg.mongo.uri, db: cfg.mongo.db, keepHours: cfg.ledger.keepHours });
      dbNote = `connected (db "${cfg.mongo.db}")`;
      say(`MongoDB ${dbNote}`, { kind: 'boot' });
    } catch (e) {
      dbNote = `MongoDB did not connect (${e.message}): ticks are kept in a memory ring only until a restart`;
      say(dbNote, { kind: 'boot' });
    }
  } else say('no MONGO_URI: ticks are kept in a memory ring only', { kind: 'boot' });

  const modules = {
    pilot: await tryImport('./gamepilot.js', 'brain'),
    gamebody: await tryImport('./gamebody.js', 'body'),
    taste: await tryImport('./taste.js', 'taste'),
    chain: cfg.tokenCa ? await tryImport('./chain/index.js', 'trade watcher') : null,
    mcap: cfg.tokenCa ? await tryImport('./chain/mcap.js', 'market cap') : null,
  };
  if (!cfg.tokenCa) say('no TOKEN_CA: trade watcher off', { kind: 'boot' });
  if (cfg.consoleKind === 'native') say('CONSOLE_KIND=native: virtual pad + desktop capture, no browser', { kind: 'boot' });
  else if (!cfg.console.url) say('no CONSOLE_URL: the console follows the game ladder (docs/STAGES.md)', { kind: 'boot' });
  if (!cfg.stream.url) say('no STREAM_URL: no livestream', { kind: 'boot' });

  const app = await startApp({ cfg, db, dbNote, modules });
  const bye = async (sig) => {
    say(`${sig}`, { kind: 'boot' });
    const force = setTimeout(() => process.exit(0), 15000); force.unref();
    await app.stop().catch(() => {});
    process.exit(0);
  };
  process.once('SIGTERM', () => bye('SIGTERM'));
  process.once('SIGINT', () => bye('SIGINT'));
}

if (process.argv[1] && /src[\\/]index\.js$/.test(process.argv[1])) {
  process.on('unhandledRejection', (e) => say(`unhandled: ${e?.stack || e?.message || e}`));
  process.on('uncaughtException', (e) => say(`uncaught: ${e?.stack || e?.message || e}`));
  main().catch((e) => { say(`fatal at boot: ${e.stack || e.message}`); process.exit(1); });
}
