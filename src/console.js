/**
 * The console tab.
 *
 * Generic on purpose (the real remote console account does not exist yet):
 * open the browser with the saved login, go to CONSOLE_URL, wait for a playing
 * <video> or a large <canvas>, click it for focus, ask for fullscreen, then hand
 * the page over (onReady). While it plays: a frame every FRAME_MS for the API
 * and the freeze check, and the login state saved when it changes.
 *
 * States: off, starting, loading, login (not logged in), playing, frozen
 * (same picture for FROZEN_S), ended (stream or session over), crashed, error.
 * Anything but playing -> reload with backoff (5 s doubling to 5 min).
 *
 * Login: a Playwright storageState, versioned insert-only in halcyra_session
 * (kind "console"); without Mongo, data/console-state.json.
 *
 *   node src/console.js --login            open it headed, log in by hand,
 *                                          press Enter here: the login is saved
 *   node src/console.js --import <file>    store a storageState JSON file
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { say } from './log.js';
import { openBrowser, fullscreenWindow } from './browser.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const KIND = 'console';

// what is on the page right now
// what is on the page right now. sel = CONSOLE_CANVAS_SELECTOR (optional): that
// element is the game picture. Without it: the largest playing <video>, else
// the largest <canvas>, else (a game inside an iframe) the largest <iframe>.
const detectJs = (sel = '') => `(() => {
  const SEL = ${JSON.stringify(sel || '')};
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const area = (el) => { const r = el.getBoundingClientRect(); return r.width * r.height; };
  let pick = null; let kind = null;
  if (SEL) { try { const el = document.querySelector(SEL); if (el && vis(el)) { pick = el; kind = el.tagName.toLowerCase(); } } catch (e) {} }
  if (!pick) {
    const vids = [...document.querySelectorAll('video')].filter(vis).map((v) => ({ el: v, a: area(v), playing: !v.paused && !v.ended && v.readyState >= 2 && v.videoWidth > 0 }));
    const cans = [...document.querySelectorAll('canvas')].filter((c) => vis(c) && !c.closest('#__fly') && !c.closest('#__fly_hud')).map((c) => ({ el: c, a: area(c) }));
    const frs = [...document.querySelectorAll('iframe')].filter(vis).map((f) => ({ el: f, a: area(f) }));
    const pv = vids.filter((v) => v.playing).sort((a, b) => b.a - a.a)[0];
    const cv = cans.sort((a, b) => b.a - a.a)[0];
    const fr = frs.sort((a, b) => b.a - a.a)[0];
    const best = pv || cv || fr || null;
    if (best) { pick = best.el; kind = best === pv ? 'video' : best === cv ? 'canvas' : 'iframe'; }
  }
  let box = null;
  if (pick) { const r = pick.getBoundingClientRect(); box = { x: r.x, y: r.y, w: r.width, h: r.height, kind }; window.__halcyraTarget = pick; }
  const pw = [...document.querySelectorAll('input[type=password]')].some(vis);
  const text = (document.body && document.body.innerText || '').slice(0, 4000);
  return { box, password: pw, url: location.href, text, title: document.title };
})()`;

// a cheap signature of the game picture, to tell a frozen stream from a live one
const SIG_JS = `(() => {
  const el = window.__halcyraTarget;
  if (!el || !el.isConnected) return 'none';
  try {
    const c = window.__halcyraSigCanvas || (window.__halcyraSigCanvas = document.createElement('canvas'));
    c.width = 32; c.height = 18;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(el, 0, 0, 32, 18);
    const d = g.getImageData(0, 0, 32, 18).data;
    let h = 2166136261, sum = 0;
    for (let i = 0; i < d.length; i += 1) { h = Math.imul(h ^ d[i], 16777619); sum += d[i]; }
    // the in-tab DOS console (src/dos.js) only redraws when the picture changes;
    // its emulator heartbeat tells a still screen from a hung emulator
    const dos = window.__dos && window.__dos.state === 'running' ? ':b' + window.__dos.beats : '';
    if (sum > 0) return 'px:' + (h >>> 0).toString(16) + dos;
  } catch (e) { /* a cross-origin video taints the canvas */ }
  if (el.tagName === 'VIDEO') {
    const q = el.getVideoPlaybackQuality ? el.getVideoPlaybackQuality() : null;
    return 'v:' + (q ? q.totalVideoFrames : '') + ':' + el.currentTime.toFixed(2);
  }
  return 'shot';
})()`;

const LOGIN_URL = /\/(login|log-in|signin|sign-in|auth|oauth)\b/i;
const ENDED_TEXT = /(stream|session|game) (has )?(ended|expired|closed)|connection (was )?lost|disconnected|time('?s| is) up|your session (has )?ended/i;

export async function loadLogin({ db, dataDir }) {
  if (db) {
    const d = await db.latestSession(KIND).catch(() => null);
    if (d?.state) return { state: d.state, v: d.v, hash: d.hash, from: 'mongo' };
  }
  const f = path.join(dataDir, 'console-state.json');
  if (fs.existsSync(f)) {
    try { const state = JSON.parse(fs.readFileSync(f, 'utf8')); return { state, hash: hashState(state), from: 'file' }; } catch { /* bad file */ }
  }
  return null;
}

export const hashState = (s) => crypto.createHash('sha256').update(JSON.stringify(s)).digest('hex');

/** insert a new version only when the login changed. Never overwrites. */
export async function saveLogin({ db, dataDir, state, lastHash }) {
  const hash = hashState(state);
  if (hash === lastHash) return { saved: false, hash };
  if (db) {
    const r = await db.insertSession({ kind: KIND, hash, state, cookies: (state.cookies || []).length });
    return { saved: true, hash, v: r.v, to: 'mongo' };
  }
  const dir = dataDir; fs.mkdirSync(dir, { recursive: true });
  // keep the old one too: insert-only in spirit
  const f = path.join(dir, 'console-state.json');
  if (fs.existsSync(f)) fs.copyFileSync(f, path.join(dir, `console-state.${Date.now()}.json`));
  fs.writeFileSync(f, JSON.stringify(state));
  return { saved: true, hash, to: 'file' };
}

export class ConsoleTab {
  /**
   * cfg      the whole config (cfg.console, cfg.browser, cfg.dataDir)
   * db       src/db.js store or null
   * onStatus (state, detail)
   * onPage   async (page) for every new page, BEFORE its first navigation
   *          (init scripts such as the virtual gamepad go in here)
   * onReady  async (page) when the game picture is up (after every (re)load)
   * onLost   async () when it stops playing
   * onFrame  (jpegBuffer)
   */
  constructor({ cfg, db = null, url = '', onStatus = () => {}, onPage = async () => {}, onReady = async () => {}, onLost = async () => {}, onFrame = () => {} }) {
    this.cfg = cfg; this.db = db;
    this.url = url || cfg.console.url; // the ladder moves it with goTo()
    this.switching = false;
    this.onStatus = onStatus; this.onPage = onPage; this.onReady = onReady; this.onLost = onLost; this.onFrame = onFrame;
    this.state = 'off'; this.detail = '';
    this.page = null; this.ctx = null; this.browser = null;
    this.stopped = false; this.crashed = false; this.fails = 0;
    this.loginHash = null; this.lastSave = 0;
    this.playingSince = 0;
  }

  set(state, detail = '') {
    if (state !== this.state || detail !== this.detail) say(`${state}${detail ? ` (${detail})` : ''}`, { kind: 'console' });
    this.state = state; this.detail = detail;
    try { this.onStatus(state, detail); } catch { /* listener */ }
  }

  get playing() { return this.state === 'playing' && this.page && !this.page.isClosed(); }

  start() { this.run().catch((e) => this.set('error', e.message)); return this; }

  /** move the tab to another game (the ladder). The current session ends at its next check and the new url loads at once. */
  goTo(url) {
    if (!url || url === this.url) return;
    this.url = url;
    this.switching = true;
    this.fails = 0;
  }

  async stop() {
    this.stopped = true;
    await this.saveLogin().catch(() => {});
    try { await this.ctx?.close(); } catch { /* gone */ }
    try { await this.browser?.close(); } catch { /* gone */ }
    this.page = null;
  }

  async openContext() {
    const login = await loadLogin({ db: this.db, dataDir: this.cfg.dataDir });
    this.loginHash = login?.hash || null;
    const b = this.cfg.browser;
    const r = await openBrowser({ headless: b.headless, executablePath: b.executablePath, flavour: b.flavour, width: b.width, height: b.height, proxy: b.proxy, canvasNoise: b.canvasNoise, extraArgs: b.extraArgs, storageState: login?.state });
    this.ctx = r.context; this.browser = r.browser;
    say(`login ${login ? `restored (${login.from}${login.v ? ` v${login.v}` : ''})` : 'none saved yet'}`, { kind: 'console' });
  }

  async newPage() {
    if (!this.ctx) await this.openContext();
    try { if (this.page && !this.page.isClosed()) await this.page.close(); } catch { /* gone */ }
    this.page = await this.ctx.newPage();
    this.crashed = false;
    this.page.on('crash', () => { this.crashed = true; });
    this.page.on('close', () => { if (!this.stopped) this.crashed = true; });
    this.page.setDefaultTimeout(30000);
    if (!this.cfg.browser.headless) await fullscreenWindow(this.page);
    await this.onPage(this.page);
    return this.page;
  }

  async run() {
    this.set('starting');
    while (!this.stopped) {
      try {
        const outcome = await this.session();
        if (this.stopped) break;
        if (outcome === 'switch' || this.switching) { try { await this.onLost(); } catch { /* listener */ } continue; }
        const wait = Math.min(300000, 5000 * 2 ** Math.min(this.fails, 6));
        this.fails += 1;
        try { await this.onLost(); } catch { /* listener */ }
        if (outcome === 'login') say(`not logged in. run "npm run login" once (see README); retrying in ${Math.round(wait / 1000)} s`, { kind: 'console' });
        await this.pause(wait);
      } catch (e) {
        this.set('error', String(e.message).split('\n')[0].slice(0, 200));
        try { await this.onLost(); } catch { /* listener */ }
        // a broken browser is thrown away entirely
        try { await this.ctx?.close(); } catch { /* gone */ }
        try { await this.browser?.close(); } catch { /* gone */ }
        this.ctx = null; this.browser = null; this.page = null;
        const wait = Math.min(300000, 5000 * 2 ** Math.min(this.fails, 6));
        this.fails += 1;
        await this.pause(wait);
      }
    }
  }

  /** a backoff wait that a goTo() or stop() cuts short */
  async pause(ms) {
    const until = Date.now() + ms;
    while (Date.now() < until && !this.stopped && !this.switching) await sleep(Math.min(500, until - Date.now()));
  }

  /** one load of the page, until it stops playing. -> why it stopped */
  async session() {
    if (this.state === 'login') {
      // the login may have been saved since (npm run login): start over with it
      try { await this.ctx?.close(); } catch { /* gone */ }
      try { await this.browser?.close(); } catch { /* gone */ }
      this.ctx = null; this.browser = null;
    }
    const page = (this.crashed || !this.page || this.page.isClosed()) ? await this.newPage() : this.page;
    this.switching = false;
    this.set('loading', this.url);
    await page.goto(this.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const found = await this.waitForGame(page);
    if (found !== 'ok') { this.set(found.state, found.detail); return found.state; }
    await this.focus(page);
    await this.startKeys(page);
    this.set('playing');
    this.playingSince = Date.now();
    if (!this.lastSave) this.lastSave = Date.now(); // first check one period in, not at once
    await this.onReady(page);
    return this.watch(page);
  }

  async detect(page) {
    const d = await page.evaluate(detectJs(this.cfg.console.canvasSelector));
    if (d.password || LOGIN_URL.test(new URL(d.url).pathname)) return { state: 'login', detail: 'the console page asks for a login' };
    if (ENDED_TEXT.test(d.text)) return { state: 'ended', detail: (d.text.match(ENDED_TEXT) || [''])[0] };
    if (d.box && d.box.w * d.box.h >= this.cfg.console.minCanvas) return { state: 'ok', box: d.box };
    return { state: 'waiting' };
  }

  async waitForGame(page) {
    const until = Date.now() + this.cfg.console.waitSec * 1000;
    let last = null; let lastClick = 0;
    while (Date.now() < until && !this.stopped) {
      // an outside page with a start / play control (CONSOLE_START_SELECTOR): click it until the game shows
      if (this.cfg.console.startSelector && Date.now() - lastClick > 3000) { lastClick = Date.now(); await this.clickStart(page); }
      if (this.switching) return { state: 'loading', detail: 'moving to another game' };
      if (this.crashed) return { state: 'crashed', detail: 'the page crashed' };
      last = await this.detect(page).catch((e) => ({ state: 'waiting', detail: e.message }));
      if (last.state === 'ok') { this.box = last.box; return 'ok'; }
      if (last.state === 'login' || last.state === 'ended') return last;
      await sleep(1000);
    }
    return { state: 'ended', detail: `no playing video or large canvas after ${this.cfg.console.waitSec} s` };
  }

  /** click CONSOLE_START_SELECTOR in the page or any of its frames; -> true if clicked */
  async clickStart(page) {
    const sel = this.cfg.console.startSelector;
    for (const f of page.frames()) {
      try {
        const loc = f.locator(sel).first();
        if (await loc.count() && await loc.isVisible()) { await loc.click({ timeout: 3000 }); say(`clicked the start control (${sel})`, { kind: 'console' }); return true; }
      } catch { /* not in this frame */ }
    }
    return false;
  }

  /**
   * CONSOLE_START_KEYS after the game shows, to pass menus: comma separated
   * key names (Playwright / KeyboardEvent.code names), "Name*3" to repeat,
   * "wait:2000" to wait. e.g. "wait:3000,Enter,wait:1500,Enter"
   */
  async startKeys(page) {
    const list = String(this.cfg.console.startKeys || '').split(',').map((x) => x.trim()).filter(Boolean);
    for (const item of list) {
      if (this.stopped || this.switching) return;
      const w = item.match(/^wait:(\d+)$/i);
      if (w) { await sleep(Number(w[1])); continue; }
      const m = item.match(/^(.+?)(?:\*(\d+))?$/);
      for (let i = 0; i < Number(m[2] || 1); i += 1) {
        await page.keyboard.press(m[1], { delay: 80 }).catch((e) => say(`start key ${m[1]}: ${String(e.message).split('\n')[0]}`, { kind: 'console' }));
        await sleep(250);
      }
    }
    if (list.length) say(`start keys sent (${list.join(', ')})`, { kind: 'console' });
  }

  async focus(page) {
    const b = this.box;
    if (!b) return;
    await page.mouse.click(Math.round(b.x + b.w / 2), Math.round(b.y + b.h / 2)).catch(() => {});
    // the click is a user gesture, so fullscreen is allowed right after it
    await page.evaluate(`(() => { const el = window.__halcyraTarget; try { if (el && !document.fullscreenElement && el.requestFullscreen) el.requestFullscreen().catch(() => {}); } catch (e) {} })()`).catch(() => {});
  }

  async watch(page) {
    const c = this.cfg.console;
    let sig = null; let sigSince = Date.now(); let lastDetect = Date.now(); let lastShot = 0;
    while (!this.stopped) {
      if (this.switching) { this.set('loading', 'moving to another game'); return 'switch'; }
      if (this.crashed || page.isClosed()) { this.set('crashed', 'the page crashed'); return 'crashed'; }
      const t0 = Date.now();
      try {
        // the picture for /api/frame.jpg: scaled down and not too often, because
        // every capture takes renderer time away from her own eye
        if (Date.now() - lastShot >= c.shotMs) {
          lastShot = Date.now();
          const shot = await this.capture(page, 60);
          if (shot) this.onFrame(shot);
        }
        let s = await page.evaluate(SIG_JS);
        if (s === 'shot') { const tiny = await this.capture(page, 30); s = tiny ? `shot:${crypto.createHash('sha1').update(tiny).digest('hex')}` : 'shot'; }
        if (s === 'none') {
          const d = await this.detect(page);
          if (d.state !== 'ok') { this.set(d.state === 'waiting' ? 'ended' : d.state, d.detail || 'the game picture is gone'); return this.state; }
          this.box = d.box; s = await page.evaluate(SIG_JS);
        }
        if (s !== sig) { sig = s; sigSince = Date.now(); }
        else if (Date.now() - sigSince > c.frozenSec * 1000) { this.set('frozen', `same picture for ${c.frozenSec} s`); return 'frozen'; }
        if (Date.now() - lastDetect > 5000) {
          lastDetect = Date.now();
          const d = await this.detect(page);
          if (d.state === 'login' || d.state === 'ended') { this.set(d.state, d.detail); return d.state; }
        }
        if (Date.now() - this.playingSince > 120000) this.fails = 0;
        if (Date.now() - this.lastSave > this.cfg.browser.saveStateMs) await this.saveLogin();
      } catch (e) {
        if (this.crashed || page.isClosed()) { this.set('crashed', 'the page crashed'); return 'crashed'; }
        say(`check failed (${String(e.message).split('\n')[0].slice(0, 160)})`, { kind: 'console' });
      }
      await sleep(Math.max(50, c.frameMs - (Date.now() - t0)));
    }
    return 'stopped';
  }

  /**
   * A JPEG of the page. A plain screenshot on purpose: a CDP capture with
   * clip.scale re-renders the visible window at that scale for a moment, and
   * that flicker lands in the x11 stream (measured: ~20% of grabbed frames).
   */
  async capture(page, quality = 60) {
    return page.screenshot({ type: 'jpeg', quality, timeout: 10000 }).catch(() => null);
  }

  async saveLogin() {
    if (!this.ctx) return null;
    this.lastSave = Date.now();
    const state = await this.ctx.storageState();
    const r = await saveLogin({ db: this.db, dataDir: this.cfg.dataDir, state, lastHash: this.loginHash });
    if (r.saved) { this.loginHash = r.hash; say(`login saved (${r.to}${r.v ? ` v${r.v}` : ''})`, { kind: 'console' }); }
    return r;
  }
}

// ---------------------------------------------------------------- CLI
async function cli() {
  const { cfg } = await import('./config.js');
  const args = process.argv.slice(2);
  let db = null;
  if (cfg.mongo.uri) {
    const { connectMongo } = await import('./db.js');
    db = await connectMongo({ uri: cfg.mongo.uri, db: cfg.mongo.db, keepHours: cfg.ledger.keepHours });
  }
  const where = db ? 'MongoDB (halcyra_session)' : `${path.join(cfg.dataDir, 'console-state.json')} (no MONGO_URI)`;

  if (args[0] === '--import') {
    const state = JSON.parse(fs.readFileSync(args[1], 'utf8'));
    if (!Array.isArray(state.cookies)) throw new Error('not a Playwright storageState file (no cookies array)');
    const prev = await loadLogin({ db, dataDir: cfg.dataDir });
    const r = await saveLogin({ db, dataDir: cfg.dataDir, state, lastHash: prev?.hash });
    console.log(r.saved ? `login stored in ${where}${r.v ? ` as v${r.v}` : ''}` : 'same login as the one already stored; nothing written');
    await db?.close(); return;
  }

  if (args[0] === '--login') {
    if (!cfg.console.url) throw new Error('set CONSOLE_URL first');
    const prev = await loadLogin({ db, dataDir: cfg.dataDir });
    const { context, browser } = await openBrowser({ ...cfg.browser, headless: false, storageState: prev?.state });
    const page = await context.newPage();
    await page.goto(cfg.console.url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch((e) => console.log(`goto: ${e.message}`));
    console.log(`\nLog in to the console in the browser window that just opened.\nWhen the game picture is showing, come back here and press Enter.\nThe login will be stored in ${where}.\n`);
    await new Promise((r) => { process.stdin.resume(); process.stdin.once('data', r); });
    const state = await context.storageState();
    const r = await saveLogin({ db, dataDir: cfg.dataDir, state, lastHash: prev?.hash });
    console.log(r.saved ? `login stored (${state.cookies.length} cookies)${r.v ? ` as v${r.v}` : ''}` : 'login unchanged; nothing written');
    await context.close().catch(() => {}); await browser?.close().catch(() => {});
    await db?.close(); process.exit(0);
  }
  console.log('usage: node src/console.js --login | --import <storageState.json>');
}

if (process.argv[1] && /console\.js$/.test(process.argv[1])) {
  cli().catch((e) => { console.error(e.message); process.exit(1); });
}
