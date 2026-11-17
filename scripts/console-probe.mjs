/**
 * One-hour console probe.
 *
 *   node scripts/console-probe.mjs <url>
 *
 * Opens your own Chrome (headed, its own profile folder under
 * data/probe-profile so a login survives between runs), with the virtual
 * gamepad from src/gamepad.js and a tiny read-only instrumentation put into
 * every frame before any page script runs. Waits for the human to log in and
 * start the console, then checks, one by one:
 *
 *   PICTURE     where the game picture is, and which ways of looking at it work
 *   CONTROLLER  whether the page reads the virtual pad and the console reacts
 *               (D-pad left/right and left stick left/right only)
 *   KEYBOARD    only when the controller did not pass: ArrowLeft / ArrowRight
 *   DELAY       press to first picture change, for the path that passed
 *   PAGE        WebRTC, data channels, WebSocket hosts, session text, dialogs
 *
 * Evidence goes to data/probe-<timestamp>/ (report.json, report.txt, PNGs).
 * Never closes or navigates the page on its own; Ctrl+C still writes the report.
 *
 * Options (for tests and odd setups):
 *   --auto            no Enter waits (also PROBE_AUTO=1); closes the browser at the end
 *   --out <dir>       evidence folder (default data/probe-<timestamp>)
 *   --profile <dir>   browser profile folder (default data/probe-profile)
 *   --wait <s>        --auto only: how long to wait for a picture (default 30)
 *   CHROME_PATH       a Chrome/Chromium binary instead of the installed Google Chrome
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GAMEPAD_INIT, padSetJs, neutralPad } from '../src/gamepad.js';
import { decodePng, gridFromPixels, gridDiff, GRID_W, GRID_H } from '../src/eye.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i > -1 && argv[i + 1] !== undefined ? argv[i + 1] : d; };
const flag = (k) => argv.includes(`--${k}`);
const VALUE_OPTS = new Set(['--out', '--profile', '--wait']);
const positional = argv.filter((a, i) => !a.startsWith('--') && !VALUE_OPTS.has(argv[i - 1]));
const URL_ARG = positional[0];
const AUTO = flag('auto') || /^(1|true|yes|on)$/i.test(process.env.PROBE_AUTO || '');
const STAMP = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const OUT = path.resolve(opt('out', path.join(ROOT, 'data', `probe-${STAMP}`)));
const PROFILE = path.resolve(opt('profile', path.join(ROOT, 'data', 'probe-profile')));
const AUTO_WAIT_S = Number(opt('wait', 30));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (a) => { const s = a.filter((v) => Number.isFinite(v)).sort((x, y) => x - y); if (!s.length) return null; const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const r4 = (v) => (Number.isFinite(v) ? Math.round(v * 1e4) / 1e4 : v);
const r1 = (v) => (Number.isFinite(v) ? Math.round(v * 10) / 10 : v);
const short = (e) => String((e && e.message) || e).split('\n')[0].slice(0, 200);

// ------------------------------------------------------------------ in-page code

/**
 * Read-only instrumentation, every frame, before page scripts. Wraps with
 * Proxies (so the functions still look native) and never throws into the page.
 */
const PROBE_INIT = `(() => {
  try {
    if (window.__probe) return;
    const P = { listeners: {}, pcs: 0, pcList: [], channels: [], ws: {}, hid: 0, usb: 0, keyboardApi: 0, pointerLock: 0, fullscreen: 0, shadows: [], errors: 0 };
    try { Object.defineProperty(window, '__probe', { value: P, enumerable: false, configurable: true }); } catch (e) { window.__probe = P; }
    const safe = (f) => { try { f(); } catch (e) { P.errors += 1; } };
    const tap = (obj, name, before) => safe(() => {
      if (!obj) return;
      const orig = obj[name];
      if (typeof orig !== 'function') return;
      obj[name] = new Proxy(orig, { apply(t, self, args) { try { before(self, args); } catch (e) { P.errors += 1; } return Reflect.apply(t, self, args); } });
    });
    const WATCH = /^(gamepad(dis)?connected|key(down|up|press)|pointerlockchange|fullscreenchange|visibilitychange)$/;
    tap(EventTarget.prototype, 'addEventListener', (self, a) => { if (typeof a[0] === 'string' && WATCH.test(a[0])) P.listeners[a[0]] = (P.listeners[a[0]] || 0) + 1; });
    const ctor = (name, after) => safe(() => {
      const O = window[name];
      if (typeof O !== 'function') return;
      window[name] = new Proxy(O, { construct(t, args, nt) { const o = Reflect.construct(t, args, nt); try { after(o, args); } catch (e) { P.errors += 1; } return o; } });
    });
    const onPc = (pc) => {
      P.pcs += 1; if (P.pcList.length < 8) P.pcList.push(pc);
      pc.addEventListener('datachannel', (e) => { try { if (P.channels.length < 40) P.channels.push({ label: String(e.channel.label), from: 'console side' }); } catch (x) { P.errors += 1; } });
    };
    ctor('RTCPeerConnection', onPc);
    if (window.webkitRTCPeerConnection && window.webkitRTCPeerConnection !== window.RTCPeerConnection) ctor('webkitRTCPeerConnection', onPc);
    if (window.RTCPeerConnection) tap(RTCPeerConnection.prototype, 'createDataChannel', (self, a) => { if (P.channels.length < 40) P.channels.push({ label: String(a[0]), from: 'page' }); });
    ctor('WebSocket', (ws, a) => { let h = '?'; try { h = new URL(String(a[0]), location.href).host; } catch (e) { /* bad url */ } P.ws[h] = (P.ws[h] || 0) + 1; });
    if (window.HID) { tap(HID.prototype, 'requestDevice', () => { P.hid += 1; }); tap(HID.prototype, 'getDevices', () => { P.hid += 1; }); }
    if (window.USB) { tap(USB.prototype, 'requestDevice', () => { P.usb += 1; }); tap(USB.prototype, 'getDevices', () => { P.usb += 1; }); }
    if (window.Keyboard) { tap(Keyboard.prototype, 'lock', () => { P.keyboardApi += 1; }); tap(Keyboard.prototype, 'getLayoutMap', () => { P.keyboardApi += 1; }); }
    tap(Element.prototype, 'requestPointerLock', () => { P.pointerLock += 1; });
    tap(Element.prototype, 'requestFullscreen', () => { P.fullscreen += 1; });
    tap(Element.prototype, 'webkitRequestFullscreen', () => { P.fullscreen += 1; });
    safe(() => {
      const orig = Element.prototype.attachShadow;
      Element.prototype.attachShadow = new Proxy(orig, { apply(t, self, args) { const root = Reflect.apply(t, self, args); try { if (P.shadows.length < 300) P.shadows.push(root); } catch (e) { P.errors += 1; } return root; } });
    });
  } catch (e) { /* never break the page */ }
})()`;

/** every <video>/<canvas> in this frame, shadow roots included. Elements kept in window.__probeEls */
const FIND_JS = `(() => {
  const seen = new Set(); const els = [];
  const roots = [document];
  const P = window.__probe;
  if (P && P.shadows) for (const r of P.shadows) roots.push(r);
  for (let i = 0; i < roots.length && i < 2000; i += 1) {
    const root = roots[i];
    let all = [];
    try { all = root.querySelectorAll('*'); } catch (e) { continue; }
    for (const el of all) {
      if (el.shadowRoot && !roots.includes(el.shadowRoot)) roots.push(el.shadowRoot);
      const t = el.tagName;
      if ((t === 'VIDEO' || t === 'CANVAS') && !seen.has(el)) { seen.add(el); els.push(el); }
    }
  }
  window.__probeEls = els;
  const vw = innerWidth, vh = innerHeight;
  return els.map((el, i) => {
    const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    const vis = r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && r.right > 0 && r.bottom > 0 && r.left < vw && r.top < vh;
    const o = { i, tag: el.tagName.toLowerCase(), w: Math.round(r.width), h: Math.round(r.height), visible: vis, inShadow: el.getRootNode() !== document, id: el.id || '', cls: String(el.className || '').slice(0, 60) };
    if (el.tagName === 'VIDEO') {
      Object.assign(o, { videoW: el.videoWidth, videoH: el.videoHeight, readyState: el.readyState, paused: el.paused, ended: el.ended,
        playing: !el.paused && !el.ended && el.readyState >= 2 && el.videoWidth > 0,
        source: el.srcObject ? 'live stream (srcObject)' : (el.currentSrc ? (el.currentSrc.startsWith('blob:') ? 'blob' : 'url') : 'none'),
        protectedMedia: !!el.mediaKeys, crossOrigin: el.crossOrigin || null });
    } else {
      o.canvasW = el.width; o.canvasH = el.height;
    }
    return o;
  });
})()`;

/** per-frame facts the instrumentation and the virtual pad collected */
const FACTS_JS = `(() => {
  const P = window.__probe; const pad = window.__pad ? window.__pad.stats() : null;
  let pcStates = [];
  try { pcStates = P ? P.pcList.map((pc) => pc.connectionState) : []; } catch (e) { /* gone */ }
  return {
    url: location.href.split('?')[0].slice(0, 200), host: location.host, top: window === window.top,
    padReads: pad ? pad.reads : null, padConnectedFired: pad ? pad.connectedFired : null,
    listeners: P ? P.listeners : null, ongamepadconnected: typeof window.ongamepadconnected === 'function',
    pcs: P ? P.pcs : 0, pcStates, channels: P ? P.channels : [], ws: P ? P.ws : {},
    hid: P ? P.hid : 0, usb: P ? P.usb : 0, keyboardApi: P ? P.keyboardApi : 0, pointerLock: P ? P.pointerLock : 0, fullscreen: P ? P.fullscreen : 0,
    instrumentErrors: P ? P.errors : null,
    hasFocus: document.hasFocus(), visibility: document.visibilityState,
    fullscreenNow: !!document.fullscreenElement, pointerLockNow: !!document.pointerLockElement,
  };
})()`;

/** WebRTC stats of the connections this frame made (codec, size, fps, round trip) */
const RTC_JS = `(async () => {
  const P = window.__probe; if (!P || !P.pcList.length) return [];
  const out = [];
  for (const pc of P.pcList) {
    const o = { state: pc.connectionState, video: null, rttMs: null, transport: null };
    try {
      const st = await pc.getStats(); const by = {}; st.forEach((r) => { by[r.id] = r; });
      st.forEach((r) => {
        if (r.type === 'inbound-rtp' && (r.kind === 'video' || r.mediaType === 'video')) {
          const c = r.codecId && by[r.codecId];
          o.video = { codec: c ? c.mimeType + (c.sdpFmtpLine ? ' ' + c.sdpFmtpLine.slice(0, 80) : '') : null, width: r.frameWidth, height: r.frameHeight, fps: r.framesPerSecond,
            framesDecoded: r.framesDecoded, framesDropped: r.framesDropped, decoder: r.decoderImplementation || null, powerEfficientDecoder: r.powerEfficientDecoder,
            jitterBufferMs: r.jitterBufferEmittedCount ? Math.round(1000 * r.jitterBufferDelay / r.jitterBufferEmittedCount) : null, packetsLost: r.packetsLost };
        }
        if (r.type === 'candidate-pair' && (r.nominated || r.selected) && r.state === 'succeeded') {
          if (Number.isFinite(r.currentRoundTripTime)) o.rttMs = Math.round(r.currentRoundTripTime * 1000);
          const rc = by[r.remoteCandidateId];
          if (rc) o.transport = { protocol: rc.protocol, candidateType: rc.candidateType };
        }
      });
    } catch (e) { o.err = String(e && e.message || e).slice(0, 120); }
    out.push(o);
  }
  return out;
})()`;

/** visible text lines that look like a session timer or limit, and open dialogs */
const TEXT_JS = `(() => {
  const txt = (document.body && document.body.innerText) || '';
  const lines = txt.split(/\\n+/).map((s) => s.trim()).filter(Boolean);
  const hits = [];
  const RX = /(minute|credit|session|remaining|time left|hour|\\b\\d{1,2}:\\d{2}(:\\d{2})?\\b)/i;
  for (const l of lines) { if (RX.test(l) && l.length < 200 && !hits.includes(l)) hits.push(l); if (hits.length >= 15) break; }
  const dlg = [...document.querySelectorAll('dialog[open], [role=dialog], [role=alertdialog], [aria-modal=true]')]
    .filter((d) => { const r = d.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
    .map((d) => (d.innerText || '').trim().replace(/\\s+/g, ' ').slice(0, 200)).filter(Boolean).slice(0, 5);
  const html = document.documentElement ? document.documentElement.outerHTML.slice(0, 3000000) : '';
  const words = {};
  for (const m of html.matchAll(/moonlight|sunshine|gamestream|nvstream|parsec|webrtc|janus|mediasoup|livekit|selkies|neko/gi)) { const k = m[0].toLowerCase(); words[k] = (words[k] || 0) + 1; }
  return { timerText: hits, dialogs: dlg, words, title: document.title };
})()`;

// element-level functions (run with handle.evaluate)
function elFrameRead(el, [W, H]) {
  try {
    const c = window.__probeCanvas || (window.__probeCanvas = document.createElement('canvas'));
    if (c.width !== W) c.width = W; if (c.height !== H) c.height = H;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.fillStyle = '#000'; g.fillRect(0, 0, W, H);
    g.drawImage(el, 0, 0, W, H);
    const d = g.getImageData(0, 0, W, H).data;
    let s = '';
    for (let i = 0; i < d.length; i += 0x8000) s += String.fromCharCode.apply(null, d.subarray(i, i + 0x8000));
    return { b64: btoa(s) };
  } catch (e) {
    return { err: e && e.name === 'SecurityError' ? 'tainted' : String((e && e.name) || '') + ': ' + String((e && e.message) || e).slice(0, 160) };
  }
}
function elFramePng(el) {
  try {
    const sw = el.videoWidth || el.width || 640; const sh = el.videoHeight || el.height || 360;
    const k = Math.min(1, 960 / sw);
    const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(sw * k)); c.height = Math.max(1, Math.round(sh * k));
    c.getContext('2d').drawImage(el, 0, 0, c.width, c.height);
    return { url: c.toDataURL('image/png') };
  } catch (e) { return { err: String((e && e.name) || e) }; }
}
function elVideoFacts(el) {
  return new Promise((resolve) => {
    const q0 = el.getVideoPlaybackQuality ? el.getVideoPlaybackQuality() : null;
    const quality = () => { const q = el.getVideoPlaybackQuality ? el.getVideoPlaybackQuality() : null; return q ? { totalVideoFrames: q.totalVideoFrames, droppedVideoFrames: q.droppedVideoFrames } : null; };
    const base = { videoW: el.videoWidth, videoH: el.videoHeight, startQuality: q0 ? { totalVideoFrames: q0.totalVideoFrames, droppedVideoFrames: q0.droppedVideoFrames } : null };
    if (!el.requestVideoFrameCallback) { setTimeout(() => resolve({ ...base, endQuality: quality(), rvfc: 'not available' }), 5000); return; }
    let n = 0; let first = null; let last = null; let done = false; const t0 = performance.now();
    const finish = (why) => {
      if (done) return; done = true;
      const secs = (performance.now() - t0) / 1000;
      resolve({ ...base, endQuality: quality(), rvfc: { callbacks: n, perSecond: Math.round((n / secs) * 10) / 10, presentedFrames: first && last ? last.presentedFrames - first.presentedFrames : 0, frameW: last && last.width, frameH: last && last.height, why } });
    };
    const cb = (now, md) => { n += 1; if (!first) first = md; last = md; if (performance.now() - t0 < 5000) el.requestVideoFrameCallback(cb); else finish('5 s'); };
    el.requestVideoFrameCallback(cb);
    setTimeout(() => finish('timer'), 6000);
  });
}
function elCanvasChanges(el) {
  // how often the canvas picture changes, sampled every animation frame for 5 s
  return new Promise((resolve) => {
    const c = document.createElement('canvas'); c.width = 32; c.height = 18;
    const g = c.getContext('2d', { willReadFrequently: true });
    let last = null; let changes = 0; let samples = 0; const t0 = performance.now(); let err = null;
    const tick = () => {
      try {
        g.drawImage(el, 0, 0, 32, 18);
        const d = g.getImageData(0, 0, 32, 18).data;
        let h = 2166136261; for (let i = 0; i < d.length; i += 1) h = Math.imul(h ^ d[i], 16777619);
        if (last !== null && h !== last) changes += 1; last = h; samples += 1;
      } catch (e) { err = String(e && e.name || e); }
      if (!err && performance.now() - t0 < 5000) requestAnimationFrame(tick);
      else resolve({ canvasW: el.width, canvasH: el.height, changesPerSecond: Math.round(changes / ((performance.now() - t0) / 1000) * 10) / 10, samples, err });
    };
    requestAnimationFrame(tick);
    setTimeout(() => resolve({ canvasW: el.width, canvasH: el.height, changesPerSecond: Math.round(changes / 6 * 10) / 10, samples, err: err || 'timer' }), 6500);
  });
}

// ------------------------------------------------------------------ report

const report = {
  tool: 'console-probe', version: 1, startedAt: new Date().toISOString(), url: URL_ARG ? redact(URL_ARG) : null,
  platform: `${process.platform} ${process.arch}, node ${process.versions.node}`, auto: AUTO,
  browser: null, picture: null, controller: null, keyboard: null, delay: null, page: null,
  dialogs: [], popups: [], notes: [], finished: false, interrupted: false,
};
const results = { PICTURE: 'not run', CONTROLLER: 'not run', KEYBOARD: 'not run', DELAY: 'not run', PAGE: 'not run' };
const lines = {};

function redact(u) { try { const x = new URL(u); return `${x.origin}${x.pathname}`; } catch { return String(u).slice(0, 200); } }

function saveJson() {
  try {
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ ...report, results }, null, 2));
  } catch (e) { console.error(`could not write report.json: ${short(e)}`); }
}

function line(name, status, text) {
  results[name] = status; lines[name] = text;
  console.log(`${name.padEnd(11)} ${status.padEnd(8)} ${text}`);
  saveJson();
}

function nextStep() {
  const p = report.picture; const k = report.keyboard;
  if (!p || !p.found) return 'We could not find the game picture on the page. The screenshot in this folder shows what the page looked like.';
  const seeing = p.best;
  if (!seeing) return 'The picture is there but every way of looking at it came back black or blocked (protected video). Next: this page will not let a browser tab read its picture, so it needs a different way in.';
  if (results.CONTROLLER === 'PASS') return `Everything needed works: the console reacted to the virtual controller and the picture can be read (${seeing}). Next: point the real service at this page (CONSOLE_URL) and let her play.`;
  if (k && results.KEYBOARD === 'PASS') return `The console did not react to the virtual controller but did react to arrow keys. Next: the service has to drive this page with keys instead of the controller (a small change on our side).`;
  if (results.CONTROLLER === 'UNCLEAR' || results.KEYBOARD === 'UNCLEAR') {
    const c = report.controller || {}; const kk = report.keyboard || {};
    const busy = [c.dpadResult, c.stickResult, kk.result].some((j) => j && j.why);
    return busy
      ? 'The picture kept moving by itself, so we could not tell if the presses did anything. Next: run the probe again while a still menu screen is showing (not gameplay or a video), and do not touch anything during the test.'
      : 'Some presses changed the picture but not clearly. Next: run the probe once more on a still menu screen, and do not touch anything during the test.';
  }
  return 'The console did not react to the virtual controller or to keys. The page facts in this folder show how this page takes input.';
}

function writeText() {
  const order = ['PICTURE', 'CONTROLLER', 'KEYBOARD', 'DELAY', 'PAGE'];
  const out = [
    `Console probe, ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC${report.interrupted ? ' (stopped early with Ctrl+C)' : ''}`,
    `Page: ${report.url || '-'}`,
    '',
    ...order.map((k) => `${k.padEnd(11)} ${String(results[k]).padEnd(8)} ${lines[k] || ''}`),
    '',
    `Next step: ${nextStep()}`,
    '',
    `Evidence: ${OUT}`,
  ];
  const txt = out.join('\n');
  try { fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(path.join(OUT, 'report.txt'), `${txt}\n`); } catch (e) { console.error(`could not write report.txt: ${short(e)}`); }
  return txt;
}

let finishing = false;
function finishAndExit(code, why) {
  if (finishing) return; finishing = true;
  report.interrupted = report.interrupted || code !== 0;
  if (why) report.notes.push(why);
  report.endedAt = new Date().toISOString();
  saveJson();
  const txt = writeText();
  console.log(`\n${why || 'Stopped.'} What was measured so far is saved.\n\n${txt}\n`);
  process.exit(code);
}
process.on('SIGINT', () => finishAndExit(130, 'Stopped with Ctrl+C.'));
process.on('SIGTERM', () => finishAndExit(143, 'Stopped.'));
process.on('uncaughtException', (e) => { report.error = short(e); finishAndExit(1, `The probe hit an error: ${short(e)}`); });
process.on('unhandledRejection', (e) => { report.error = short(e); finishAndExit(1, `The probe hit an error: ${short(e)}`); });

function waitEnter(prompt) {
  if (AUTO) return Promise.resolve();
  if (prompt) process.stdout.write(prompt);
  return new Promise((resolve) => {
    process.stdin.resume();
    process.stdin.once('data', () => { process.stdin.pause(); resolve(); });
  });
}

// ------------------------------------------------------------------ browser

async function launch() {
  const { chromium } = await import('playwright-core');
  fs.mkdirSync(PROFILE, { recursive: true });
  const args = ['--disable-blink-features=AutomationControlled', '--autoplay-policy=no-user-gesture-required', '--start-maximized'];
  if (process.platform === 'linux' && process.getuid && process.getuid() === 0) args.push('--no-sandbox');
  const base = { headless: false, viewport: null, args, ignoreDefaultArgs: ['--enable-automation'] };
  const tries = process.env.CHROME_PATH
    ? [{ ...base, executablePath: process.env.CHROME_PATH, label: process.env.CHROME_PATH }]
    : [{ ...base, channel: 'chrome', label: 'Google Chrome' }, { ...base, channel: 'msedge', label: 'Microsoft Edge' }];
  let lastErr = null;
  for (const t of tries) {
    const { label, ...o } = t;
    try {
      const ctx = await chromium.launchPersistentContext(PROFILE, o);
      report.browser = { label, version: ctx.browser() ? ctx.browser().version() : null, profile: PROFILE };
      return ctx;
    } catch (e) { lastErr = e; }
  }
  throw new Error(`could not open Chrome (${short(lastErr)}). Is Google Chrome installed? You can also set CHROME_PATH to chrome.exe.`);
}

async function eachFrame(page, js) {
  const out = [];
  for (const f of page.frames()) {
    try { out.push({ frame: f, v: await f.evaluate(js) }); } catch (e) { out.push({ frame: f, err: short(e) }); }
  }
  return out;
}

/** the biggest playing video, else the biggest canvas, else the biggest video, over every page and frame */
async function findPicture(ctx) {
  const all = [];
  for (const page of ctx.pages()) {
    if (page.isClosed()) continue;
    for (const { frame, v } of await eachFrame(page, FIND_JS)) {
      if (!Array.isArray(v)) continue;
      for (const c of v) all.push({ ...c, page, frame, frameUrl: redact(frame.url()) });
    }
  }
  const vis = all.filter((c) => c.visible && c.w * c.h > 0);
  const area = (c) => c.w * c.h;
  const pick = vis.filter((c) => c.tag === 'video' && c.playing).concat(vis.filter((c) => c.tag === 'canvas')).sort((a, b) => area(b) - area(a))[0]
    || vis.filter((c) => c.tag === 'video').sort((a, b) => area(b) - area(a))[0] || null;
  return { all, pick };
}

const strip = (c) => { if (!c) return c; const { page, frame, ...rest } = c; return rest; };

function gridStats(g) {
  let s = 0; for (const v of g) s += v;
  const mean = s / g.length;
  let q = 0; for (const v of g) q += (v - mean) ** 2;
  const sd = Math.sqrt(q / g.length);
  return { meanLuminance: r4(mean), sd: r4(sd), black: mean < 0.04 && sd < 0.02, flat: sd < 0.004 };
}

/** crop decoded pixels to a box (in image pixels) */
function crop(img, x, y, w, h) {
  x = Math.max(0, Math.min(img.w - 1, Math.round(x))); y = Math.max(0, Math.min(img.h - 1, Math.round(y)));
  w = Math.max(1, Math.min(img.w - x, Math.round(w))); h = Math.max(1, Math.min(img.h - y, Math.round(h)));
  const out = Buffer.alloc(w * h * img.bpp);
  for (let r = 0; r < h; r += 1) img.data.copy(out, r * w * img.bpp, ((y + r) * img.w + x) * img.bpp, ((y + r) * img.w + x + w) * img.bpp);
  return { w, h, bpp: img.bpp, data: out };
}

// ------------------------------------------------------------------ looks (capture paths)

function makeLooks(target, box) {
  const { page, handle } = target;
  let cast = null;
  const looks = {
    async screenshot() {
      const buf = await handle.screenshot({ type: 'png', timeout: 10000 });
      return { grid: gridFromPixels(decodePng(buf)), png: buf };
    },
    async frame() {
      const r = await handle.evaluate(elFrameRead, [GRID_W, GRID_H]);
      if (!r || !r.b64) throw new Error(r && r.err === 'tainted' ? 'tainted: the page blocks reading this picture (cross origin or protected)' : (r && r.err) || 'no picture');
      return { grid: gridFromPixels({ w: GRID_W, h: GRID_H, bpp: 4, data: Buffer.from(r.b64, 'base64') }) };
    },
    async screencast() {
      if (!cast) throw new Error('screencast not running');
      const t0 = Date.now();
      while (!cast.latest && Date.now() - t0 < 2000) await sleep(20);
      if (!cast.latest) throw new Error('no screencast frame arrived');
      const { buf, meta } = cast.latest;
      const img = decodePng(buf);
      const k = img.w / (meta.deviceWidth || img.w);
      const bb = box();
      const part = bb ? crop(img, bb.x * k, (bb.y - (meta.offsetTop || 0)) * k, bb.width * k, bb.height * k) : img;
      return { grid: gridFromPixels(part), png: buf };
    },
    async startCast() {
      if (cast) return;
      const cdp = await page.context().newCDPSession(page);
      cast = { cdp, latest: null, frames: 0 };
      cdp.on('Page.screencastFrame', (f) => {
        cast.frames += 1;
        cast.latest = { buf: Buffer.from(f.data, 'base64'), meta: f.metadata || {}, at: Date.now() };
        cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
      });
      await cdp.send('Page.startScreencast', { format: 'png', maxWidth: 1280, maxHeight: 720, everyNthFrame: 1 });
    },
    async stopCast() {
      if (!cast) return;
      try { await cast.cdp.send('Page.stopScreencast'); } catch { /* gone */ }
      try { await cast.cdp.detach(); } catch { /* gone */ }
      cast = null;
    },
    castFrames: () => (cast ? cast.frames : 0),
    resetCast: () => { if (cast) { cast.frames = 0; cast.latest = null; } },
  };
  return looks;
}

async function rate(fn, ms = 5000) {
  const t0 = Date.now(); let n = 0; const costs = [];
  while (Date.now() - t0 < ms) { const a = Date.now(); await fn(); costs.push(Date.now() - a); n += 1; }
  return { perSecond: r1(n / ((Date.now() - t0) / 1000)), msPerLook: median(costs) };
}

// ------------------------------------------------------------------ checks

async function checkPicture(ctx) {
  const { all, pick } = await findPicture(ctx);
  const res = { found: !!pick, candidates: all.map(strip).slice(0, 30), element: strip(pick), paths: {}, best: null };
  report.picture = res;
  if (!pick) {
    const page = ctx.pages().find((p) => !p.isClosed());
    if (page) { try { fs.writeFileSync(path.join(OUT, 'page-no-picture.png'), await page.screenshot({ type: 'png' })); res.pageScreenshot = 'page-no-picture.png'; } catch { /* closed */ } }
    line('PICTURE', 'FAIL', `no video or canvas found in ${all.length ? `${all.length} elements` : 'any frame'} (saved page-no-picture.png)`);
    return null;
  }
  const handle = await pick.frame.evaluateHandle(`window.__probeEls[${pick.i}]`);
  const target = { page: pick.page, frame: pick.frame, handle, pick };
  try { await pick.page.bringToFront(); } catch { /* fine */ }
  let lastBox = await handle.boundingBox().catch(() => null);
  const box = () => lastBox;
  res.box = lastBox;
  res.inIframe = pick.frame !== pick.page.mainFrame();

  // facts about the picture itself
  try {
    res.facts = pick.tag === 'video' ? await handle.evaluate(elVideoFacts) : await handle.evaluate(elCanvasChanges);
  } catch (e) { res.facts = { err: short(e) }; }
  lastBox = await handle.boundingBox().catch(() => lastBox);

  const looks = makeLooks(target, box);
  target.looks = looks;

  // path 1: screenshot of the element
  for (const name of ['screenshot', 'frame', 'screencast']) {
    const p = { works: false };
    res.paths[name] = p;
    try {
      if (name === 'screencast') { await looks.startCast(); await sleep(400); }
      const one = await looks[name]();
      Object.assign(p, gridStats(one.grid));
      if (name === 'frame') {
        const png = await handle.evaluate(elFramePng);
        if (png && png.url) { fs.writeFileSync(path.join(OUT, 'picture-frame.png'), Buffer.from(png.url.split(',')[1], 'base64')); p.file = 'picture-frame.png'; }
      } else if (one.png) {
        const f = `picture-${name}.png`; fs.writeFileSync(path.join(OUT, f), one.png); p.file = f;
      }
      if (name === 'screencast') {
        looks.resetCast();
        await sleep(5000);
        p.perSecond = r1(looks.castFrames() / 5);
        p.note = 'a screencast frame only comes when something on the page changes';
        if (!p.perSecond) p.works = false;
      } else {
        Object.assign(p, await rate(() => looks[name]()));
      }
      p.works = !p.black && !(name === 'screencast' && !p.perSecond);
      if (p.black) p.why = 'the picture comes back black';
      if (name === 'screencast' && !p.perSecond) p.why = p.why || 'no frames in 5 s';
    } catch (e) {
      p.works = false; p.why = short(e);
      if (/tainted/.test(p.why)) p.tainted = true;
    }
    if (name === 'screencast') await looks.stopCast();
  }
  // the best path for watching the console react: fastest that works
  const order = ['frame', 'screenshot', 'screencast'];
  res.best = order.find((n) => res.paths[n].works) || null;
  const kind = pick.tag === 'video' ? `${pick.videoW}x${pick.videoH} video` : `${pick.canvasW}x${pick.canvasH} canvas`;
  const fps = res.facts && res.facts.rvfc && res.facts.rvfc.perSecond !== undefined ? `, ${res.facts.rvfc.perSecond} new frames/s`
    : res.facts && res.facts.changesPerSecond !== undefined ? `, changes ${res.facts.changesPerSecond}/s` : '';
  const pathsTxt = order.map((n) => `${n} ${res.paths[n].works ? `works (${res.paths[n].perSecond}/s)` : res.paths[n].tainted ? 'blocked' : res.paths[n].black ? 'black' : 'no'}`).join(', ');
  line('PICTURE', res.best ? 'PASS' : 'FAIL', `${kind} shown at ${pick.w}x${pick.h}${res.inIframe ? ' (inside a frame)' : ''}${fps}. Looks: ${pathsTxt}`);
  return target;
}

async function padAll(page, state) {
  const js = padSetJs(state);
  await Promise.all(page.frames().map((f) => f.evaluate(js).catch(() => null)));
}

async function padReads(page) {
  const out = [];
  for (const { frame, v } of await eachFrame(page, 'window.__pad ? window.__pad.stats().reads : null')) out.push({ url: redact(frame.url()), reads: v });
  return out;
}

/** one trial: picture, action, wait 700 ms, picture -> how much it changed */
async function trial(look, action) {
  const a = await look();
  await action();
  await sleep(700);
  const b = await look();
  return r4(gridDiff(a.grid, b.grid));
}

const MIN_CHANGE = 0.004;
function judge(press, base) {
  const bmax = Math.max(0, ...base);
  const thr = Math.max(MIN_CHANGE, 2 * bmax);
  const hits = press.filter((d) => d > thr).length;
  const need = Math.ceil(press.length * 0.66);
  let status;
  if (hits >= need) status = 'PASS';
  else if (hits <= 1 && bmax < 0.02) status = 'FAIL';
  else status = 'UNCLEAR';
  return { status, threshold: r4(thr), hits, of: press.length, baselineMax: r4(bmax), why: status === 'UNCLEAR' && bmax >= 0.02 ? 'the picture keeps changing on its own, so a press cannot be told apart' : undefined };
}

async function checkController(target) {
  const { page, looks } = target;
  const look = looks[report.picture.best];
  const res = { lookPath: report.picture.best };
  report.controller = res;
  try { await page.bringToFront(); } catch { /* fine */ }
  // is the page reading the pad at all?
  const r0 = await padReads(page); await sleep(3000); const r1x = await padReads(page);
  res.polling = r1x.map((f, i) => ({ url: f.url, readsPerSecond: f.reads != null && r0[i] && r0[i].reads != null ? r1(Math.max(0, f.reads - r0[i].reads) / 3) : null }));
  res.polled = res.polling.some((f) => f.readsPerSecond > 0);
  if (!look) {
    line('CONTROLLER', res.polled ? 'UNCLEAR' : 'FAIL', `the page ${res.polled ? 'reads' : 'never reads'} the virtual controller, but there is no readable picture to see if the console reacts`);
    return;
  }
  const idle = () => sleep(150);
  const press = (state) => async () => { await padAll(page, state); await sleep(150); await padAll(page, neutralPad()); };
  const RIGHT = { buttons: { right: 1 } }; const LEFT = { buttons: { left: 1 } };
  const SR = { axes: [1, 0, 0, 0] }; const SL = { axes: [-1, 0, 0, 0] };
  await padAll(page, neutralPad());
  res.baseline = [];
  for (let i = 0; i < 6; i += 1) res.baseline.push(await trial(look, idle));
  res.dpad = [];
  for (let i = 0; i < 3; i += 1) { res.dpad.push(await trial(look, press(RIGHT))); res.dpad.push(await trial(look, press(LEFT))); }
  res.stick = [];
  for (let i = 0; i < 3; i += 1) { res.stick.push(await trial(look, press(SR))); res.stick.push(await trial(look, press(SL))); }
  await padAll(page, neutralPad());
  res.dpadResult = judge(res.dpad, res.baseline);
  res.stickResult = judge(res.stick, res.baseline);
  const st = [res.dpadResult.status, res.stickResult.status];
  let status = st.includes('PASS') ? 'PASS' : st.includes('UNCLEAR') ? 'UNCLEAR' : 'FAIL';
  // a page that never calls getGamepads cannot have received the virtual controller
  if (status === 'UNCLEAR' && !res.polled) { status = 'FAIL'; res.note = 'the page never reads the controller, so the virtual controller cannot reach the console'; }
  if (status === 'FAIL' && res.polled) res.note = 'the page reads the controller but the picture did not react';
  const pollTxt = res.polled ? `page reads the controller (${Math.max(...res.polling.map((f) => f.readsPerSecond || 0))}/s)` : 'page never reads the controller';
  line('CONTROLLER', status, `${pollTxt}; D-pad changed the picture ${res.dpadResult.hits} of 6, stick ${res.stickResult.hits} of 6 (no press: up to ${res.dpadResult.baselineMax})`);
}

async function checkKeyboard(target) {
  const { page, looks } = target;
  const look = looks[report.picture.best];
  const res = { lookPath: report.picture.best };
  report.keyboard = res;
  if (!look) { line('KEYBOARD', 'UNCLEAR', 'no readable picture to see if the console reacts'); return; }
  const bb = await target.handle.boundingBox().catch(() => null);
  if (bb) {
    await page.mouse.click(Math.round(bb.x + bb.width / 2), Math.round(bb.y + bb.height / 2));
    res.clicked = { x: Math.round(bb.x + bb.width / 2), y: Math.round(bb.y + bb.height / 2) };
    await sleep(1000);
  }
  const key = (k) => async () => { await page.keyboard.down(k); await sleep(150); await page.keyboard.up(k); };
  res.baseline = [];
  for (let i = 0; i < 6; i += 1) res.baseline.push(await trial(look, () => sleep(150)));
  res.arrows = [];
  for (let i = 0; i < 3; i += 1) { res.arrows.push(await trial(look, key('ArrowRight'))); res.arrows.push(await trial(look, key('ArrowLeft'))); }
  res.result = judge(res.arrows, res.baseline);
  line('KEYBOARD', res.result.status, `arrow keys changed the picture ${res.result.hits} of 6 (no press: up to ${res.result.baselineMax})`);
}

async function checkDelay(target) {
  const { page, looks } = target;
  const c = report.controller; const k = report.keyboard;
  let how = null; let thr = MIN_CHANGE;
  if (c && c.dpadResult && c.dpadResult.status === 'PASS') { how = 'dpad'; thr = c.dpadResult.threshold; }
  else if (c && c.stickResult && c.stickResult.status === 'PASS') { how = 'stick'; thr = c.stickResult.threshold; }
  else if (k && k.result && k.result.status === 'PASS') { how = 'keys'; thr = k.result.threshold; }
  const res = { how, threshold: thr, lookPath: report.picture && report.picture.best, samplesMs: [] };
  report.delay = res;
  if (!how) { line('DELAY', 'skipped', 'nothing passed, so there is nothing to time'); return; }
  const look = looks[res.lookPath];
  const down = async (dir) => {
    if (how === 'dpad') await padAll(page, { buttons: { [dir]: 1 } });
    else if (how === 'stick') await padAll(page, { axes: [dir === 'right' ? 1 : -1, 0, 0, 0] });
    else await page.keyboard.down(dir === 'right' ? 'ArrowRight' : 'ArrowLeft');
  };
  const up = async (dir) => {
    if (how === 'keys') await page.keyboard.up(dir === 'right' ? 'ArrowRight' : 'ArrowLeft');
    else await padAll(page, neutralPad());
  };
  const costs = [];
  for (let i = 0; i < 5; i += 1) {
    const dir = i % 2 ? 'left' : 'right';
    const ref = await look();
    const t0 = Date.now();
    await down(dir);
    const release = sleep(150).then(() => up(dir));
    let found = null;
    while (Date.now() - t0 < 2500) {
      const ts = Date.now();
      const g = await look();
      costs.push(Date.now() - ts);
      if (gridDiff(ref.grid, g.grid) > thr) { found = Math.round((ts + Date.now()) / 2 - t0); break; }
      const spent = Date.now() - ts; if (spent < 30) await sleep(30 - spent);
    }
    await release;
    res.samplesMs.push(found);
    await sleep(800);
  }
  res.medianMs = median(res.samplesMs);
  res.lookCostMs = median(costs);
  res.note = 'measured on this computer and this internet line; the server in the data centre will see a different number';
  const miss = res.samplesMs.filter((v) => v == null).length;
  line('DELAY', res.medianMs != null ? 'measured' : 'UNCLEAR', res.medianMs != null
    ? `about ${res.medianMs} ms from press to picture change (median of ${5 - miss}, each look takes ~${res.lookCostMs} ms). This is your home line, not what the server will get.`
    : 'no picture change seen within 2.5 s of a press');
}

async function checkPage(ctx, target) {
  const res = { frames: [], rtc: [], text: [], words: {} };
  report.page = res;
  for (const page of ctx.pages()) {
    if (page.isClosed()) continue;
    for (const { frame, v, err } of await eachFrame(page, FACTS_JS)) res.frames.push(v || { url: redact(frame.url()), err });
    for (const f of page.frames()) {
      try {
        const rtc = await f.evaluate(RTC_JS);
        if (rtc && rtc.length) res.rtc.push({ url: redact(f.url()), connections: rtc });
      } catch { /* frame gone */ }
      try {
        const t = await f.evaluate(TEXT_JS);
        res.text.push({ url: redact(f.url()), ...t });
        for (const [w, n] of Object.entries(t.words || {})) res.words[w] = (res.words[w] || 0) + n;
      } catch { /* frame gone */ }
    }
  }
  const F = res.frames.filter((f) => f && f.listeners !== undefined);
  const sum = (k) => F.reduce((s, f) => s + (Number(f[k]) || 0), 0);
  const listeners = {};
  for (const f of F) for (const [k, n] of Object.entries(f.listeners || {})) listeners[k] = (listeners[k] || 0) + n;
  const ws = {};
  for (const f of F) for (const [h, n] of Object.entries(f.ws || {})) ws[h] = (ws[h] || 0) + n;
  const channels = [...new Set(F.flatMap((f) => (f.channels || []).map((c) => c.label)))];
  res.summary = {
    webrtcConnections: sum('pcs'), dataChannels: channels, webSocketHosts: Object.keys(ws), listeners,
    gamepadEventListeners: (listeners.gamepadconnected || 0) + (listeners.gamepaddisconnected || 0) + F.filter((f) => f.ongamepadconnected).length,
    keyListeners: (listeners.keydown || 0) + (listeners.keyup || 0),
    webHid: sum('hid'), webUsb: sum('usb'), keyboardLock: sum('keyboardApi'), pointerLock: sum('pointerLock'), fullscreen: sum('fullscreen'),
    instrumentErrors: sum('instrumentErrors'),
    focused: F.some((f) => f.hasFocus), visibility: [...new Set(F.map((f) => f.visibility))],
    video: res.rtc.flatMap((r) => r.connections.map((c) => c.video)).filter(Boolean)[0] || null,
    roundTripMs: res.rtc.flatMap((r) => r.connections.map((c) => c.rttMs)).filter((v) => v != null)[0] ?? null,
    streamWords: res.words,
    sessionText: [...new Set(res.text.flatMap((t) => t.timerText || []))].slice(0, 15),
    pageDialogs: [...new Set(res.text.flatMap((t) => t.dialogs || []))],
    browserDialogs: report.dialogs, popups: report.popups,
  };
  const s = res.summary;
  if (target && target.page) { try { fs.writeFileSync(path.join(OUT, 'page-end.png'), await target.page.screenshot({ type: 'png' })); res.pageScreenshot = 'page-end.png'; } catch { /* closed */ } }
  const bits = [];
  bits.push(s.webrtcConnections ? `WebRTC yes (${s.webrtcConnections} connection${s.webrtcConnections > 1 ? 's' : ''}${s.video && s.video.codec ? `, ${s.video.codec.split(' ')[0]} ${s.video.width}x${s.video.height} ${s.video.fps || '?'} fps` : ''}${s.roundTripMs != null ? `, round trip ${s.roundTripMs} ms` : ''})` : 'no WebRTC');
  bits.push(s.dataChannels.length ? `data channels: ${s.dataChannels.join(', ')}` : 'no data channels');
  bits.push(s.webSocketHosts.length ? `WebSocket hosts: ${s.webSocketHosts.join(', ')}` : 'no WebSockets');
  bits.push(`gamepad listeners ${s.gamepadEventListeners}, key listeners ${s.keyListeners}`);
  if (s.webHid || s.webUsb || s.keyboardLock) bits.push(`WebHID ${s.webHid}, WebUSB ${s.webUsb}, keyboard lock ${s.keyboardLock}`);
  if (s.pointerLock || s.fullscreen) bits.push(`pointer lock ${s.pointerLock}, fullscreen ${s.fullscreen}`);
  if (Object.keys(s.streamWords).length) bits.push(`words in page: ${Object.entries(s.streamWords).map(([w, n]) => `${w} x${n}`).join(', ')}`);
  if (s.sessionText.length) bits.push(`session text: "${s.sessionText.slice(0, 3).join('" / "')}"`);
  if (s.browserDialogs.length || s.pageDialogs.length) bits.push(`dialogs: ${[...s.browserDialogs.map((d) => d.message), ...s.pageDialogs].slice(0, 3).join(' / ')}`);
  line('PAGE', 'facts', `${bits.join('; ')}.`);
}

// ------------------------------------------------------------------ main

async function main() {
  if (!URL_ARG) {
    console.log('Usage: node scripts/console-probe.mjs <console page address>');
    process.exit(2);
  }
  fs.mkdirSync(OUT, { recursive: true });
  saveJson();
  console.log(`\nOpening Chrome... (evidence will be saved in ${OUT})`);
  const ctx = await launch();
  report.browser.closedByUser = false;
  ctx.on('close', () => { if (!finishing) { report.browser.closedByUser = true; finishAndExit(3, 'The Chrome window was closed.'); } });
  await ctx.addInitScript(PROBE_INIT);
  await ctx.addInitScript(GAMEPAD_INIT);
  const watchPage = (p) => {
    p.on('dialog', (d) => {
      report.dialogs.push({ type: d.type(), message: d.message().slice(0, 200), at: new Date().toISOString() });
      saveJson();
      d.dismiss().catch(() => {}); // the safe answer: Cancel / close
    });
  };
  ctx.pages().forEach(watchPage);
  ctx.on('page', (p) => { watchPage(p); report.popups.push({ at: new Date().toISOString() }); });
  const page = ctx.pages()[0] || await ctx.newPage();
  try { await page.goto(URL_ARG, { waitUntil: 'domcontentloaded', timeout: 90000 }); } catch (e) { report.notes.push(`first load: ${short(e)}`); console.log(`(the page is slow to load: ${short(e)}; carry on in the window)`); }
  // pages opened before the init script existed get it now (idempotent)
  for (const p of ctx.pages()) for (const f of p.frames()) { await f.evaluate(PROBE_INIT).catch(() => {}); await f.evaluate(GAMEPAD_INIT).catch(() => {}); }

  if (AUTO) {
    const until = Date.now() + AUTO_WAIT_S * 1000;
    while (Date.now() < until) { const { pick } = await findPicture(ctx); if (pick) break; await sleep(500); }
    await sleep(1500);
  } else {
    console.log(`
-------------------------------------------------------------
 What to do now:

 1. Log in to the game service in the Chrome window that just opened.
 2. Start the game and wait until you see a still screen
    (a menu or the pause screen), not a moving video.
 3. Stay on that screen. Do not touch anything.
 4. Come back to this black window and press Enter.

 Take your time. There is no time limit here.
-------------------------------------------------------------
`);
    await waitEnter('Press Enter when the still screen is showing... ');
    console.log(`
 Now click once on the TOP BAR of the Chrome window (where the tab
 title is, NOT on the game), so Chrome is in front.
 Then do not touch the mouse, keyboard or controller.
 The tests start in 10 seconds and take about 2 minutes.
`);
    for (let s = 10; s > 0; s -= 1) { process.stdout.write(`\r starting in ${s} s  `); await sleep(1000); }
    process.stdout.write('\r                         \n');
  }

  console.log('Running the checks:\n');
  const target = await checkPicture(ctx);
  if (target) {
    await checkController(target);
    if (results.CONTROLLER !== 'PASS') await checkKeyboard(target);
    else line('KEYBOARD', 'skipped', 'not needed, the controller works');
    await checkDelay(target);
  } else {
    line('CONTROLLER', 'skipped', 'no picture found');
    line('KEYBOARD', 'skipped', 'no picture found');
    line('DELAY', 'skipped', 'no picture found');
  }
  await checkPage(ctx, target);

  report.finished = true;
  report.endedAt = new Date().toISOString();
  saveJson();
  const txt = writeText();
  console.log(`\n${'='.repeat(61)}\n${txt}\n${'='.repeat(61)}\n`);
  if (AUTO) {
    finishing = true;
    await ctx.close().catch(() => {});
    process.exit(0);
  }
  console.log('You can now end your game session in the Chrome window.');
  await waitEnter('When you are done, press Enter here to close Chrome... ');
  finishing = true;
  await ctx.close().catch(() => {});
  process.exit(0);
}

main().catch((e) => { report.error = short(e); finishAndExit(1, `The probe hit an error: ${short(e)}`); });
