/**
 * What the API serves, kept in memory and updated by the main loop:
 * the latest tick, totals, recent trades, the console and stream status,
 * the latest frame, and the SSE clients.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { links } from './config.js';

export class Hub {
  constructor({ cfg, ledger, db = null, dbNote = '' }) {
    this.cfg = cfg;
    this.ledger = ledger;
    this.db = db;
    this.dbNote = dbNote;
    this.boot = Date.now();
    this.latest = null; // last tick summary (with lit)
    this.trades = []; // newest first, last 200
    this.totals = { trades: 0, buys: 0, sells: 0, solIn: 0, solOut: 0 };
    this.frame = null; this.frameAt = null;
    this.console = { state: cfg.console.url ? 'starting' : 'off', detail: cfg.console.url ? '' : 'CONSOLE_URL is not set: no browser, the brain is idle', since: Date.now() };
    this.stream = { state: cfg.stream.url ? 'starting' : 'off', detail: cfg.stream.url ? '' : 'STREAM_URL is not set' };
    this.watcher = { state: cfg.tokenCa ? 'starting' : 'off', detail: cfg.tokenCa ? '' : 'TOKEN_CA is not set', lastSlot: null };
    this.brain = { state: 'starting' };
    this.loop = { steps: 0, errors: 0, lastError: null, lastStepMs: null };
    this.proof = null;
    this.view = { state: 'none', since: Date.now() }; // what her eyes get from the picture
    this.blankLooks = 0;
    this.clients = new Set();
    this.seen = new Set(); // trade sigs this process has counted
  }

  setConsole(state, detail = '') {
    if (this.console.state !== state || this.console.detail !== detail) this.console = { state, detail, since: Date.now() };
  }

  /**
   * After every look. `seen` is her body's own measure of what reached the
   * lamina (mean contrast over the 7,685 lamina cells, spatial + temporal).
   * A picture with no contrast (a flat menu, a black loading screen) gives
   * her nothing: no descending activity, a neutral pad. Said plainly here so
   * a quiet fly on a flat screen does not look like a broken service.
   */
  setView(v) {
    if (!v) return;
    this.blankLooks = v.seen < 1e-3 ? this.blankLooks + 1 : 0;
    const state = this.blankLooks >= 3 ? 'nothing to see' : 'seeing';
    const detail = state === 'nothing to see'
      ? 'the picture has no contrast (flat or still), so her eyes get nothing and her descending cells stay quiet: the pad rests at zero until the picture changes'
      : '';
    if (state !== this.view.state) this.view = { state, detail, since: Date.now() };
    Object.assign(this.view, { contrast: v.sd, range: v.range, lamina: v.seen });
  }

  setFrame(buf) { if (buf && buf.length) { this.frame = buf; this.frameAt = Date.now(); } }

  /** a stored ledger record (+ lit from the raw tick) -> summary, pushed live */
  onTick(rec, lit) {
    const s = summarise(rec, lit);
    this.latest = s;
    this.loop.steps += 1;
    this.broadcast('tick', s);
    return s;
  }

  /** a trade that was new to the store (or to memory without one) */
  onTrade(t) {
    const row = tradeRow(t);
    this.trades.unshift(row);
    if (this.trades.length > 200) this.trades.length = 200;
    this.totals.trades += 1;
    if (t.side === 'buy') { this.totals.buys += 1; this.totals.solIn += t.sol || 0; }
    if (t.side === 'sell') { this.totals.sells += 1; this.totals.solOut += t.sol || 0; }
    this.broadcast('trade', row);
    return row;
  }

  addClient(req, res) {
    res.writeHead(200, {
      'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive',
      'access-control-allow-origin': '*', 'x-accel-buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    res.write(`event: hello\ndata: ${JSON.stringify({ head: this.ledger.head(), latest: this.latest })}\n\n`);
    const c = { res };
    this.clients.add(c);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* closed */ } }, 15000);
    const drop = () => { clearInterval(ping); this.clients.delete(c); };
    req.on('close', drop); res.on('error', drop);
  }

  broadcast(event, data) {
    if (!this.clients.size) return;
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of this.clients) {
      // a slow client does not hold the loop up: if its buffer is full it misses ticks
      if (c.res.writableLength > 1 << 20) continue;
      try { c.res.write(msg); } catch { this.clients.delete(c); }
    }
  }

  closeClients() { for (const c of this.clients) { try { c.res.end(); } catch { /* gone */ } } this.clients.clear(); }

  stateJson() {
    const ca = this.cfg.tokenCa || null;
    return {
      now: Date.now(),
      upSeconds: Math.round((Date.now() - this.boot) / 1000),
      project: this.cfg.projectName,
      ticker: this.cfg.ticker || null,
      game: this.cfg.game,
      token: ca ? { ca, buy: links.buy(ca), solscan: links.account(ca) } : null,
      head: this.ledger.head(),
      tick: this.latest,
      fly: this.getTelemetry ? (safe(this.getTelemetry)) : null,
      totals: { ticks: this.ledger.head().ticks, ...roundTotals(this.totals) },
      console: this.console,
      view: this.view,
      stream: this.stream,
      watcher: this.watcher,
      brain: this.brain,
      loop: this.loop,
      ladder: this.ladder ? safe(() => this.ladder.json()) : null,
    };
  }
}

const safe = (f) => { try { return f() ?? null; } catch { return null; } };
const r6 = (x) => Math.round((x || 0) * 1e6) / 1e6;
const roundTotals = (t) => ({ ...t, solIn: r6(t.solIn), solOut: r6(t.solOut) });

export function summarise(rec, lit) {
  return {
    step: rec.step, pilotStep: rec.pilotStep, t: rec.t, ms: rec.ms, hash: rec.hash, prevHash: rec.prevHash,
    taste: rec.taste ?? null, drove: rec.drove ?? null, dn: rec.dn ?? null, active: rec.active ?? null,
    pad: rec.pad ?? null, lit: Array.isArray(lit) ? lit : [],
  };
}

export function tradeRow(t) {
  return {
    sig: t.sig, side: t.side, wallet: t.wallet, sol: t.sol, tokens: t.tokens, slot: t.slot, ts: t.ts, venue: t.venue, receivedAt: t.receivedAt ?? null,
    tx: links.tx(t.sig), walletUrl: t.wallet ? links.account(t.wallet) : null,
  };
}

/** sha256 of a file, streamed */
export function fileSha256(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(file).on('data', (d) => h.update(d)).on('error', reject).on('end', () => resolve(h.digest('hex')));
  });
}

/**
 * The brain manifest, from files and modules that are actually loaded.
 * Fields that are not available are left out, never filled in.
 */
export async function buildProof({ cfg, tasteCells = null, names = null, pilotInfo = null, pilot = null, taste = null }) {
  const dir = cfg.flyDir;
  const readJson = (f) => { try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch { return null; } };
  const meta = readJson('meta.json');
  const gains = readJson('gains.json');
  const proof = { brain: {} };
  if (meta) {
    proof.brain.dataset = meta.dataset;
    for (const k of ['neurons', 'connections', 'synapses', 'minSynapses', 'inhibitory', 'photoreceptors']) if (meta[k] != null) proof.brain[k] = meta[k];
  }
  const bin = path.join(dir, 'connectome.bin.gz');
  if (fs.existsSync(bin)) proof.brain.connectome = { file: 'site/fly/connectome.bin.gz', bytes: fs.statSync(bin).size, sha256: await fileSha256(bin) };
  if (gains?.brain) proof.brain.model = { file: 'site/fly/rate.js', gains: gains.brain };
  if (pilot) {
    // how she is being run right now, read off the running pilot
    proof.brain.run = {
      thread: pilot.thread === 'worker' ? 'worker thread (node:worker_threads); the wiring and her activity are shared memory' : 'main thread',
      brainMsPerLook: cfg.loop.brainMs,
      eye: pilot.eyeMode,
      seed: pilot.seed,
    };
  }
  if (tasteCells) {
    const cell = (i) => ({ index: i, rootId: names?.[i]?.id, type: names?.[i]?.type || undefined, side: names?.[i]?.side || undefined });
    proof.taste = {
      sweet: { count: tasteCells.sweet.length, types: tasteCells.meta?.sweetTypes, cells: tasteCells.sweet.map(cell) },
      bitter: { count: tasteCells.bitter.length, types: tasteCells.meta?.bitterTypes, cells: tasteCells.bitter.map(cell) },
      mode: tasteCells.meta?.mode,
      missing: tasteCells.meta?.missing,
      source: tasteCells.meta?.source,
    };
    if (taste?.p) proof.taste.model = { ...taste.p, rule: 'level(sol) = floor + (1 - floor) * clamp(log(sol / minSol) / log(maxSol / minSol), 0, 1); each trade starts at its level on the first look after it arrived and halves every halfLifeMs; buys add to sweet, sells to bitter, each capped at 1; rounded to dp decimals' };
  }
  if (taste?.p) proof.tasteModel = { ...taste.p };
  if (pilotInfo && Object.keys(pilotInfo).length) proof.readout = pilotInfo;
  return proof;
}
