/**
 * Every setting, each with a default in code. The service boots and serves its
 * API with none of them set.
 *
 * Required for the real thing (and the only ones in .env.example):
 *   MONGO_URI    without it: ticks live in a memory ring only
 *   TOKEN_CA     without it: the trade watcher does not start
 *   CONSOLE_URL  without it: no browser, the brain idles (not used with CONSOLE_KIND=native)
 *   STREAM_URL   without it: no livestream
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// dotenv is optional: on Railway the variables are already in the environment
try { (await import('dotenv')).config({ path: path.join(ROOT, '.env'), quiet: true }); } catch { /* not installed */ }

const env = (k, d = '') => (process.env[k] === undefined || process.env[k] === '' ? d : String(process.env[k]).trim());
const num = (k, d) => { const v = Number(env(k)); return env(k) === '' || !Number.isFinite(v) ? d : v; };
const bool = (k, d) => (env(k) === '' ? d : /^(1|true|yes|on)$/i.test(env(k)));

export function makeConfig() {
  const port = num('PORT', 8080);
  const tokenCa = env('TOKEN_CA');
  return {
    root: ROOT,
    flyDir: path.join(ROOT, 'site', 'fly'),
    dataDir: path.resolve(ROOT, env('DATA_DIR', 'data')),
    gamesDir: path.resolve(ROOT, env('GAMES_DIR', 'games')), // <id>/bundle.jsdos per stage (not in git; served to loopback only)
    port,
    publicUrl: env('PUBLIC_URL', 'https://halcyra.bio').replace(/\/$/, ''),
    xUrl: env('X_URL', 'https://x.com/halcyrabio'),
    githubUrl: env('GITHUB_URL', 'https://github.com/Daniel999l/halcyra'),

    projectName: env('PROJECT_NAME', 'Halcyra Neuro'),
    ticker: env('TICKER', 'HALCYRA').replace(/^\$/, ''),
    game: env('GAME', 'GTA 1'),

    tokenCa,
    rpcUrl: env('RPC_URL', 'https://api.mainnet-beta.solana.com'),
    tradePollMs: num('TRADE_POLL_MS', 4000),

    mongo: { uri: env('MONGO_URI'), db: env('MONGO_DB', 'halcyra') },

    loop: {
      stepMs: Math.max(40, num('STEP_MS', 200)), // one tick per STEP_MS at most (~5 per second)
      brainMs: Math.max(10, num('BRAIN_MS', 70)), // brain time she lives per look (70 ms = 14 model steps: ~4.3 looks/s on 2 vCPU with the stream on)
      eye: env('EYE', 'frame'), // 'frame' (the game element read inside the page), 'png' or 'small'; see src/eye.js
      thread: env('BRAIN_THREAD', 'worker'), // 'worker': her brain in a worker thread, so the API never stalls; 'main' for comparison
      seed: num('SEED', 0) || (Date.now() % 100000),
    },

    ledger: {
      bucketTicks: Math.max(10, num('BUCKET_TICKS', 300)), // ~1 minute at 5 ticks/s
      flushMs: Math.max(1000, num('FLUSH_MS', 300000)), // a partial bucket is stored after this long
      ringTicks: Math.max(100, num('RING_TICKS', 6000)), // ~20 minutes in memory
      keepHours: Math.max(0, num('TICK_KEEP_H', 48)), // full ticks kept this long; 0 = forever
      decimals: 4,
    },

    // the game ladder (src/ladder.js, docs/STAGES.md): LADDER = JSON stages or patches of the defaults
    ladder: {
      stages: env('LADDER', ''),
      pollMs: Math.max(5000, num('LADDER_POLL_MS', 20000)), // one market cap read this often; 3 in a row at or above a threshold unlock it
      reads: 3,
    },

    // 'browser' (default): the game in a browser tab (CONSOLE_URL). 'native': the game is a
    // normal program on this machine; OS-level virtual pad + desktop capture, no browser (docs/NATIVE.md)
    consoleKind: env('CONSOLE_KIND', 'browser') === 'native' ? 'native' : 'browser',

    native: {
      python: env('PYTHON', ''), // default: 'python' on Windows, 'python3' elsewhere
      feeder: env('PAD_FEEDER', ''), // full command for the pad feeder; default: <python> -u src/native/feeder.py
      padHz: Math.max(1, num('PAD_HZ', 60)), // most pad updates a second
      capture: env('CAPTURE', 'auto'), // 'auto' (win32: ddagrab then gdigrab; linux: x11grab), or one of them
      eyeFps: Math.max(1, num('EYE_FPS', 10)), // eye frames a second from the desktop grab
      jpegFps: Math.max(0.2, num('FRAME_FPS', 1)), // /api/frame.jpg updates a second (same grab)
      jpegWidth: Math.max(64, num('FRAME_W', 640)),
      jpegMode: env('FRAME_PIPE', 'fd3') === 'file' ? 'file' : 'fd3', // how the JPEGs come back from ffmpeg
      staleMs: Math.max(500, num('STALE_MS', 3000)), // no fresh frame this long -> not playing
    },

    console: {
      url: env('CONSOLE_URL'),
      frameMs: Math.max(250, num('FRAME_MS', 1000)), // freeze check
      shotMs: Math.max(250, num('SHOT_MS', 3000)), // picture for /api/frame.jpg (and the pipe stream)
      frozenSec: Math.max(5, num('FROZEN_S', 20)),
      waitSec: Math.max(5, num('CONSOLE_WAIT_S', 60)),
      minCanvas: num('MIN_CANVAS_PX', 320 * 180),
      // an outside page that runs the game (docs/STAGES.md "Launch checklist")
      startSelector: env('CONSOLE_START_SELECTOR'), // CSS selector of a start / play control, clicked until the game shows
      startKeys: env('CONSOLE_START_KEYS'), // keys sent once the game shows, e.g. "wait:3000,Enter,wait:1500,Enter"
      canvasSelector: env('CONSOLE_CANVAS_SELECTOR'), // the game picture element (default: the largest canvas)
      // her pad as key presses (src/keyer.js): a key table id from src/stagekeys.js ("gta1", "gta2"), "off",
      // or empty = auto (an outside page for a ladder stage uses that stage's table; our own /console/dos maps keys itself)
      keys: env('CONSOLE_KEYS'),
    },

    browser: {
      headless: bool('HEADLESS', false),
      executablePath: env('CHROME_PATH') || undefined,
      flavour: env('BROWSER', ''), // 'playwright' forces plain playwright-core
      width: num('VIEW_W', 1280),
      height: num('VIEW_H', 720),
      proxy: env('PROXY_URL') || undefined,
      extraArgs: env('BROWSER_ARGS', '').split(/\s+/).filter(Boolean), // extra Chromium flags, e.g. "--disable-gpu"
      canvasNoise: bool('CANVAS_NOISE', false), // cloakbrowser's canvas fingerprint noise; off so her eye gets the real pixels
      saveStateMs: Math.max(60000, num('SAVE_STATE_MS', 10 * 60000)),
    },

    stream: {
      url: env('STREAM_URL'),
      ffmpeg: env('FFMPEG_PATH', 'ffmpeg'),
      size: env('STREAM_SIZE', '1280x720'),
      fps: num('STREAM_FPS', 30),
      kbps: num('STREAM_KBPS', 2500),
      preset: env('STREAM_PRESET', 'veryfast'),
      display: env('DISPLAY', ''),
      pipeFps: num('STREAM_PIPE_FPS', 10),
      input: env('STREAM_INPUT', 'auto'), // desktop mode (Windows): 'auto' (ddagrab then gdigrab), 'ddagrab', 'gdigrab'
      encoder: env('STREAM_ENCODER', 'auto'), // 'auto' (h264_nvenc if it works here, else libx264), 'h264_nvenc', 'libx264'
      audio: env('STREAM_AUDIO', 'auto'), // 'auto' (a loopback device if one exists, else silence), 'silent', 'dshow:<device name>', 'pulse:<source>'
    },
  };
}

export const cfg = makeConfig();
fs.mkdirSync(cfg.dataDir, { recursive: true });

export const links = {
  buy: (ca) => `https://pump.fun/coin/${ca}`,
  account: (a) => `https://solscan.io/account/${a}`,
  tx: (s) => `https://solscan.io/tx/${s}`,
};
