/**
 * The ladder: she starts on the oldest game and moves up as the coin's market
 * cap grows.
 *
 *   stage   { id, game, usd, kind: 'browser'|'native', url }
 *   rule    a stage unlocks when the market cap (USD, read on chain, see
 *           src/chain/mcap.js) is at or above its threshold on 3 consecutive
 *           reads taken ~20 s apart. A read that fails (RPC down, stale oracle)
 *           breaks the run. Unlocks are permanent for that coin.
 *   store   halcyra_ladder (insert-only, unique on mint + stage), memory without
 *           Mongo; every unlock is also its own record in the proof ledger
 *           (kind "unlock", with the three readings and their slots).
 *
 * `unlocked` = the highest stage the market cap has reached.
 * `playing`  = the stage whose game is REALLY on screen right now (the console
 *              is playing and pointed at that stage), else null. A native stage
 *              (GTA III and later, on a Windows machine with a graphics card) is never played by this
 *              process in browser mode: it is recorded as unlocked and the
 *              current game carries on until that machine takes over.
 */
import fs from 'node:fs';
import path from 'node:path';
import { say } from './log.js';

export const DEFAULT_STAGES = Object.freeze([
  { id: 'gta1', game: 'GTA 1', usd: 0, kind: 'browser', url: '/console/dos?b=gta1' },
  { id: 'gta2', game: 'GTA 2', usd: 30000, kind: 'browser', url: '/console/dos?b=gta2' },
  { id: 'gta3', game: 'GTA III', usd: 100000, kind: 'native', url: '' },
  { id: 'vc', game: 'GTA Vice City', usd: 300000, kind: 'native', url: '' },
  { id: 'sa', game: 'GTA San Andreas', usd: 1000000, kind: 'native', url: '' },
  { id: 'gta4', game: 'GTA IV', usd: 3000000, kind: 'native', url: '' },
  { id: 'gta5', game: 'GTA V', usd: 10000000, kind: 'native', url: '' },
  { id: 'gta6', game: 'GTA VI', usd: 30000000, kind: 'native', url: '' },
]);

export const RULE = 'a stage unlocks when the market cap in USD is at or above its threshold on 3 consecutive reads about 20 s apart (each read at a newer slot; a failed read breaks the run). Market cap = coin price in SOL (pump.fun bonding curve virtual reserves, or the PumpSwap pool vaults after graduation) x the mint supply x SOL/USD from the Pyth SOL/USD account, all read in one getMultipleAccounts call. Unlocks never go back.';

/**
 * LADDER env (JSON) -> stages. Either a full array of stages, or an object
 * { "<id>": { ...fields to change } } patching the defaults. Bad JSON -> defaults
 * with a warning. Sorted by threshold; the first stage always starts at 0.
 */
export function parseStages(raw = '') {
  let stages = DEFAULT_STAGES.map((s) => ({ ...s }));
  const txt = String(raw || '').trim();
  if (txt) {
    try {
      const j = JSON.parse(txt);
      if (Array.isArray(j)) stages = j.map((s) => ({ ...s }));
      else if (j && typeof j === 'object') stages = stages.map((s) => ({ ...s, ...(j[s.id] || {}) }));
    } catch (e) { say(`LADDER is not valid JSON (${e.message}); using the default stages`, { kind: 'ladder' }); }
  }
  const out = [];
  for (const s of stages) {
    const id = String(s.id || '').trim();
    if (!/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(id) || out.some((x) => x.id === id)) continue;
    const usd = Math.max(0, Number(s.usd) || 0);
    out.push({ id, game: String(s.game || id), usd, kind: s.kind === 'native' ? 'native' : 'browser', url: s.kind === 'native' ? '' : String(s.url || '') });
  }
  out.sort((a, b) => a.usd - b.usd);
  if (!out.length) return parseStages('');
  out[0].usd = 0;
  return out.map((s, index) => ({ ...s, index }));
}

/** the local game bundle a /console/dos?b=<id> url needs, or null for any other url */
export function localBundleId(url) {
  const m = String(url || '').match(/^\/console\/dos\?(?:.*&)?b=([a-z0-9_-]+)/i);
  return m ? m[1] : null;
}
export const bundlePath = (gamesDir, id) => path.join(gamesDir, id, 'bundle.jsdos');

const r2 = (x) => (x == null ? null : Math.round(x * 100) / 100);

export class Ladder {
  /**
   * cfg        the whole config (cfg.ladder, cfg.root, cfg.tokenCa, cfg.port)
   * db         src/db.js store or null (memory)
   * ledger     the proof ledger (unlock records go into it)
   * read       async (mint) -> a src/chain/mcap.js readMarketCap result (injectable for tests)
   * onUnlock   (stage, record) after an unlock is stored
   * onTarget   async (stage) when the console should move to a new stage
   */
  constructor({ cfg, db = null, ledger = null, read = null, onUnlock = () => {}, onTarget = async () => {}, now = () => Date.now() }) {
    this.cfg = cfg; this.db = db; this.ledger = ledger;
    this.read = read; this.onUnlock = onUnlock; this.onTarget = onTarget; this.now = now;
    this.stages = parseStages(cfg.ladder?.stages || '');
    this.mint = cfg.tokenCa || null;
    this.pollMs = Math.max(1000, Number(cfg.ladder?.pollMs) || 20000);
    this.need = Math.max(1, Number(cfg.ladder?.reads) || 3);
    this.unlockedIndex = 0;
    this.unlocks = []; // stored unlock docs, oldest first
    this.unsaved = []; // unlock docs whose insert failed (db away), retried
    this.run = []; // the current run of good readings (oldest first)
    this.last = null; // the latest reading (good or not)
    this.reads = 0; this.fails = 0;
    this.target = null; // the stage the console is set to (browser mode, driven by the ladder)
    this.targetSince = null;
    this.mode = 'ladder'; // 'ladder' (console follows the ladder), 'fixed' (CONSOLE_URL), 'native', 'off'
    this.console = { state: 'off' };
    this.timer = null; this.stopped = false;
  }

  stage(id) { return this.stages.find((s) => s.id === id) || null; }
  get unlocked() { return this.stages[this.unlockedIndex]; }

  /** a browser stage the console can open right now (url set; a local bundle present) */
  ready(s) {
    if (!s || s.kind !== 'browser' || !s.url) return false;
    const id = localBundleId(s.url);
    return id ? fs.existsSync(bundlePath(this.cfg.gamesDir || path.join(this.cfg.root, 'games'), id)) : true;
  }

  /** the highest unlocked stage the console can open, or null */
  bestPlayable() {
    for (let i = this.unlockedIndex; i >= 0; i -= 1) if (this.ready(this.stages[i])) return this.stages[i];
    return null;
  }

  /** the console's own url for a stage (relative urls are our own pages, over loopback) */
  urlFor(s) {
    if (!s?.url) return '';
    return s.url.startsWith('/') ? `http://127.0.0.1:${this.port ?? this.cfg.port}${s.url}` : s.url;
  }

  /** read the stored unlocks for this coin */
  async load() {
    if (this.db?.ladderUnlocks && this.mint) {
      try {
        const rows = await this.db.ladderUnlocks(this.mint);
        for (const d of rows) this.absorb(d);
      } catch (e) { say(`stored unlocks not read: ${e.message}`, { kind: 'ladder' }); }
    }
    if (this.unlockedIndex > 0) say(`unlocked so far: ${this.unlocked.game} (stage ${this.unlockedIndex + 1} of ${this.stages.length})`, { kind: 'ladder' });
    return this;
  }

  absorb(d) {
    if (this.unlocks.some((u) => u.stageId === d.stageId)) return;
    this.unlocks.push(d);
    const s = this.stage(d.stageId);
    if (s && s.index > this.unlockedIndex) this.unlockedIndex = s.index;
  }

  /** console mode, decided once at boot by index.js */
  setMode(mode) { this.mode = mode; }
  setConsole(state, detail = '') {
    if (state !== this.console.state) this.console = { state, detail, since: this.now() };
    else this.console.detail = detail;
  }
  setTarget(s) {
    if (this.target?.id !== s?.id) { this.target = s || null; this.targetSince = this.now(); }
  }

  /**
   * Every pollMs: one market cap read (when TOKEN_CA is set and a reader is
   * there), then follow(): the console moves to the best stage it can play
   * (also picks up game files that appear while running).
   */
  start() {
    if (this.timer) return this;
    const tick = async () => {
      if (this.stopped) return;
      if (this.mint && this.read) await this.pollOnce().catch((e) => say(`ladder read failed: ${e.message}`, { kind: 'ladder' }));
      await this.follow().catch(() => {});
      if (!this.stopped) { this.timer = setTimeout(tick, this.pollMs); this.timer.unref?.(); }
    };
    this.timer = setTimeout(tick, 1000); this.timer.unref?.();
    return this;
  }

  stop() { this.stopped = true; clearTimeout(this.timer); this.timer = null; }

  /** one read of the market cap and the rule */
  async pollOnce() {
    let r;
    try { r = await this.read(this.mint); } catch (e) { r = { ok: false, why: String(e.message).split('\n')[0].slice(0, 200), at: this.now(), mcapUsd: null }; }
    return this.observe(r);
  }

  /**
   * The rule, on one reading. -> the stages unlocked by it ([] mostly).
   * Pure apart from storing: tests feed fake readings straight in here.
   */
  async observe(r) {
    this.reads += 1;
    const at = r?.at ?? this.now();
    const reading = r?.ok ? {
      at, slot: r.slot ?? null, mcapUsd: r.mcapUsd, venue: r.venue, priceSol: r.priceSol, solUsd: r.solUsd,
      supplyRaw: r.supplyRaw ?? null, inputs: r.inputs ?? null, oracle: r.oracle ? { account: r.oracle.account, price: r.oracle.price, publishTime: r.oracle.publishTime, postedSlot: r.oracle.postedSlot } : null,
    } : { at, ok: false, why: r?.why || 'no reading' };
    this.last = { ok: Boolean(r?.ok), ...reading };
    if (!r?.ok || !(Number(r.mcapUsd) >= 0)) {
      this.fails += 1;
      this.run = [];
      return [];
    }
    const prev = this.run.at(-1);
    // reads must be spaced (at least 3/4 of the poll period) and at a newer slot, so one
    // moment can never count three times
    if (prev) {
      const tooSoon = at - prev.at < this.pollMs * 0.75;
      const sameSlot = reading.slot != null && prev.slot != null && reading.slot <= prev.slot;
      if (tooSoon || sameSlot) return [];
    }
    this.run.push(reading);
    if (this.run.length > this.need) this.run.splice(0, this.run.length - this.need);
    if (this.run.length < this.need) return [];
    // the highest stage every reading of the run clears
    const low = Math.min(...this.run.map((x) => x.mcapUsd));
    let top = this.unlockedIndex;
    for (const s of this.stages) if (s.index > top && low >= s.usd) top = s.index;
    if (top <= this.unlockedIndex) return [];
    const readings = this.run.map((x) => ({ ...x }));
    const done = [];
    for (let i = this.unlockedIndex + 1; i <= top; i += 1) done.push(await this.unlock(this.stages[i], readings));
    this.unlockedIndex = top;
    this.run = [];
    await this.follow();
    return done;
  }

  /** store one unlock: the ledger record first (it is synchronous), then the doc */
  async unlock(s, readings) {
    const t = this.now();
    const rec = this.ledger ? this.ledger.append({
      kind: 'unlock', t, mint: this.mint,
      stage: { id: s.id, game: s.game, usd: s.usd, index: s.index, kind: s.kind },
      rule: { reads: this.need, everyMs: this.pollMs, atOrAbove: s.usd },
      readings: readings.map((x) => ({
        at: x.at, slot: x.slot, mcapUsd: r2(x.mcapUsd), solUsd: x.solUsd, venue: x.venue,
        supplyRaw: x.supplyRaw, inputs: x.inputs, oracle: x.oracle,
      })),
    }) : null;
    const doc = { mint: this.mint, stageId: s.id, game: s.game, usd: s.usd, index: s.index, kind: s.kind, at: t, readings, ledgerStep: rec?.step ?? null, ledgerHash: rec?.hash ?? null };
    this.unlocks.push(doc);
    say(`UNLOCKED ${s.game} (market cap at or above $${s.usd.toLocaleString('en-US')} on ${readings.length} reads${rec ? `, ledger step ${rec.step}` : ''})`, { kind: 'ladder' });
    await this.store(doc);
    try { this.onUnlock(s, rec, doc); } catch { /* listener */ }
    return { stage: s, record: rec, doc };
  }

  async store(doc) {
    if (!this.db?.insertLadderUnlock) return;
    try { await this.db.insertLadderUnlock(doc); } catch (e) {
      this.unsaved.push(doc);
      say(`unlock not stored yet (${e.message}); will retry`, { kind: 'ladder' });
    }
  }

  async retryUnsaved() {
    while (this.unsaved.length && this.db?.insertLadderUnlock) {
      try { await this.db.insertLadderUnlock(this.unsaved[0]); this.unsaved.shift(); } catch { return; }
    }
  }

  /** move the console to the best stage it can play, if that is not where it is */
  async follow() {
    await this.retryUnsaved();
    if (this.mode !== 'ladder') return null;
    const best = this.bestPlayable();
    if (!best || best.id === this.target?.id) return null;
    this.setTarget(best);
    say(`console moves to ${best.game}`, { kind: 'ladder' });
    try { await this.onTarget(best); } catch (e) { say(`could not move the console: ${e.message}`, { kind: 'ladder' }); }
    return best;
  }

  /** what is really on screen */
  playing() {
    if (this.console.state !== 'playing') return null;
    if (this.mode === 'native' || this.mode === 'fixed' || this.mode === 'ladder') {
      const s = this.target;
      if (!s) return null;
      return { id: s.id ?? null, game: s.game, kind: s.kind, since: Math.max(this.targetSince || 0, this.console.since || 0) };
    }
    return null;
  }

  /** the next stage and how many reads in a row (newest back) have been at or above it */
  nextJson() {
    const n = this.stages[this.unlockedIndex + 1];
    if (!n) return null;
    let k = 0;
    for (let i = this.run.length - 1; i >= 0 && this.run[i].mcapUsd >= n.usd; i -= 1) k += 1;
    return { id: n.id, game: n.game, usd: n.usd, readsInARow: k, need: this.need };
  }

  json() {
    const u = this.unlocked;
    const playing = this.playing();
    const best = this.mode === 'ladder' ? this.bestPlayable() : null;
    let waiting = null;
    if (u && (!playing || playing.id !== u.id)) {
      if (u.kind === 'native') waiting = `${u.game} is unlocked; it runs on the Windows machine`;
      else if (!u.url) waiting = `${u.game} is unlocked; there is no in-tab player for it yet`;
      else if (!this.ready(u)) waiting = `${u.game} is unlocked; its game files are not on this machine yet`;
    }
    return {
      rule: RULE,
      mint: this.mint,
      stages: this.stages.map((s) => ({
        id: s.id, game: s.game, usd: s.usd, kind: s.kind, unlocked: s.index <= this.unlockedIndex,
        playable: s.kind === 'browser' ? this.ready(s) : false,
        unlockedAt: this.unlocks.find((x) => x.stageId === s.id)?.at ?? null,
        ledgerStep: this.unlocks.find((x) => x.stageId === s.id)?.ledgerStep ?? null,
      })),
      unlocked: u ? { id: u.id, game: u.game, usd: u.usd, index: u.index } : null,
      playing,
      console: { mode: this.mode, state: this.console.state, target: this.target ? { id: this.target.id ?? null, game: this.target.game } : null, best: best ? best.id : null },
      waiting,
      next: this.nextJson(),
      marketCap: this.last ? (this.last.ok ? {
        usd: r2(this.last.mcapUsd), at: this.last.at, slot: this.last.slot, venue: this.last.venue,
        priceSol: this.last.priceSol, solUsd: this.last.solUsd, supplyRaw: this.last.supplyRaw,
        inputs: this.last.inputs, oracle: this.last.oracle,
      } : { usd: null, at: this.last.at, why: this.last.why }) : { usd: null, why: this.mint ? 'no reading yet' : 'TOKEN_CA is not set: market cap unknown, the ladder stays on the first stage' },
      reads: { total: this.reads, failed: this.fails, everyMs: this.pollMs, need: this.need },
    };
  }
}
