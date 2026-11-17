/**
 * The native eye: ONE long-lived ffmpeg that captures the desktop and gives
 *   stdout  raw rgb24 frames at the eye's size (GRID_W x GRID_H = 160 x 90),
 *           EYE_FPS a second (default 10). Turned into her luminance grid by
 *           the same gridFromPixels() the browser eye uses (src/eye.js):
 *           Rec. 709 luminance, 0..1, Float32Array(160 * 90), row-major.
 *   fd 3    small JPEGs of the same capture (FRAME_W wide, FRAME_FPS a
 *           second, default 640 px, 1/s) for /api/frame.jpg. The same ffmpeg
 *           and the same grab: no second capture.
 *           FRAME_PIPE=file instead writes data/native-frame.jpg (ffmpeg
 *           -update 1) and reads it back, for any ffmpeg build where an extra
 *           pipe does not work.
 *
 * Only the newest frame is kept; frames that arrive between looks are dropped.
 * The downscale is ffmpeg's `area` filter (a plain box average, the same kind
 * of average as the browser eye's 8 x 8 cells).
 *
 * Capture input, CAPTURE=auto picks by platform:
 *   win32  ddagrab (Desktop Duplication, GPU) -> if it gives no frame, gdigrab
 *   linux  x11grab on $DISPLAY (Xvfb here, for the tests)
 * ffmpeg dying -> started again with backoff (1 s doubling to 30 s).
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { GRID_W, GRID_H, gridFromPixels } from '../eye.js';
import { say } from '../log.js';

export const FRAME_BYTES = GRID_W * GRID_H * 3;

/** which capture inputs to try, in order, for this platform */
export function captureOrder(capture = 'auto', platform = process.platform) {
  if (capture && capture !== 'auto') return [capture];
  if (platform === 'win32') return ['ddagrab', 'gdigrab'];
  if (platform === 'darwin') return ['avfoundation'];
  return ['x11grab'];
}

/**
 * ffmpeg input args + the filter prefix that brings the picture to plain
 * system-memory pixels. Shared with src/stream.js.
 */
export function captureInput(kind, { fps = 10, display = process.env.DISPLAY || ':0', size = '' } = {}) {
  if (kind === 'ddagrab') {
    // Desktop Duplication: frames come out as GPU (d3d11) frames
    return { args: ['-f', 'lavfi', '-i', `ddagrab=output_idx=0:draw_mouse=0:framerate=${fps}`], pre: 'hwdownload,format=bgra' };
  }
  if (kind === 'gdigrab') return { args: ['-f', 'gdigrab', '-draw_mouse', '0', '-framerate', String(fps), '-i', 'desktop'], pre: '' };
  if (kind === 'avfoundation') return { args: ['-f', 'avfoundation', '-capture_cursor', '0', '-framerate', String(fps), '-i', '1:none'], pre: '' };
  if (kind === 'x11grab') return { args: ['-f', 'x11grab', '-draw_mouse', '0', '-framerate', String(fps), ...(size ? ['-video_size', size] : []), '-i', `${display}+0,0`], pre: '' };
  throw new Error(`unknown capture input "${kind}"`);
}

export function screenArgs({ kind, fps = 10, jpegFps = 1, jpegWidth = 640, jpegMode = 'fd3', jpegFile = '', display } = {}) {
  const inp = captureInput(kind, { fps, display });
  const pre = inp.pre ? `${inp.pre},` : '';
  const eye = `[e]scale=${GRID_W}:${GRID_H}:flags=area,format=rgb24[eye]`;
  const jw = Math.max(64, Math.round(jpegWidth / 2) * 2);
  const jpg = `[j]fps=${jpegFps},scale=${jw}:-2:flags=bilinear,format=yuvj420p[jpg]`;
  const filter = `[0:v]${pre}split=2[e][j];${eye};${jpg}`;
  const jpegOut = jpegMode === 'file'
    ? ['-map', '[jpg]', '-c:v', 'mjpeg', '-q:v', '5', '-f', 'image2', '-update', '1', '-y', jpegFile]
    : ['-map', '[jpg]', '-c:v', 'mjpeg', '-q:v', '5', '-f', 'image2pipe', 'pipe:3'];
  return [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-thread_queue_size', '64',
    ...inp.args,
    '-filter_complex', filter, '-threads', '1',
    '-map', '[eye]', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'pipe:1',
    ...jpegOut,
  ];
}

/** pull whole JPEGs (SOI .. EOI) out of a byte stream; -> [jpegs], rest */
export function splitJpegs(buf) {
  const out = [];
  let start = buf.indexOf(Buffer.from([0xff, 0xd8]));
  while (start >= 0) {
    const end = buf.indexOf(Buffer.from([0xff, 0xd9]), start + 2);
    if (end < 0) break;
    out.push(buf.subarray(start, end + 2));
    buf = buf.subarray(end + 2);
    start = buf.indexOf(Buffer.from([0xff, 0xd8]));
  }
  return { jpegs: out, rest: start >= 0 ? buf.subarray(start) : Buffer.alloc(0) };
}

export class Screen {
  /**
   * ffmpeg      path (default 'ffmpeg')
   * capture     'auto' | 'ddagrab' | 'gdigrab' | 'x11grab' | 'avfoundation'
   * fps         eye frames a second (default 10)
   * jpegFps, jpegWidth, jpegMode ('fd3' | 'file'), dataDir (for 'file')
   * onJpeg(buf), onStatus(status)
   * args        (tests) a function kind -> argv for a stand-in ffmpeg
   */
  constructor(o = {}) {
    this.o = { ffmpeg: 'ffmpeg', capture: 'auto', fps: 10, jpegFps: 1, jpegWidth: 640, jpegMode: 'fd3', dataDir: 'data', display: process.env.DISPLAY || ':0', firstFrameMs: 8000, ...o };
    this.order = captureOrder(this.o.capture);
    this.kindIdx = 0; this.kind = this.order[0]; this.kindWorks = false;
    this.proc = null; this.stopped = false; this.backoff = 1000; this.restarts = 0;
    this.frame = null; this.frameAt = 0; this.frames = 0; this.seq = 0;
    this.jpeg = null; this.jpegAt = 0; this.jpegs = 0; this.jpegMtime = 0;
    this.lastError = null; this.status = { state: 'off' };
    this.jpegFile = path.join(this.o.dataDir, 'native-frame.jpg');
  }

  set(p) { this.status = { ...this.status, ...p, input: this.kind, restarts: this.restarts, frames: this.frames, lastError: this.lastError }; try { this.o.onStatus?.(this.status); } catch { /* listener */ } }

  start() { this.stopped = false; this.spawn(); return this; }

  spawn() {
    const kind = this.kind;
    const argv = this.o.args ? this.o.args(kind) : screenArgs({ kind, fps: this.o.fps, jpegFps: this.o.jpegFps, jpegWidth: this.o.jpegWidth, jpegMode: this.o.jpegMode, jpegFile: this.jpegFile, display: this.o.display });
    const useFd3 = this.o.jpegMode !== 'file';
    let p;
    try {
      p = spawn(this.o.ffmpeg, argv, { stdio: ['ignore', 'pipe', 'pipe', ...(useFd3 ? ['pipe'] : [])], windowsHide: true });
    } catch (e) { this.lastError = e.message; this.restart(); return; }
    this.proc = p;
    const startedAt = Date.now(); let gotFrame = false;
    this.set({ state: 'starting' });
    let pend = []; let pendLen = 0; let errTail = '';
    p.stdout.on('data', (d) => {
      pend.push(d); pendLen += d.length;
      if (pendLen < FRAME_BYTES) return;
      let buf = pend.length === 1 ? pend[0] : Buffer.concat(pend, pendLen);
      // newest whole frame only
      const whole = Math.floor(buf.length / FRAME_BYTES);
      const last = buf.subarray((whole - 1) * FRAME_BYTES, whole * FRAME_BYTES);
      this.frame = Buffer.from(last); this.frameAt = Date.now(); this.frames += whole; this.seq += 1;
      buf = buf.subarray(whole * FRAME_BYTES);
      pend = buf.length ? [Buffer.from(buf)] : []; pendLen = buf.length;
      if (!gotFrame) { gotFrame = true; this.kindWorks = true; this.backoff = 1000; this.set({ state: 'on' }); say(`screen capture on (${kind})`, { kind: 'screen' }); }
    });
    if (useFd3 && p.stdio[3]) {
      let jb = Buffer.alloc(0);
      p.stdio[3].on('data', (d) => {
        jb = jb.length ? Buffer.concat([jb, d]) : d;
        const { jpegs, rest } = splitJpegs(jb);
        jb = rest.length > 8 << 20 ? Buffer.alloc(0) : Buffer.from(rest);
        if (jpegs.length) this.gotJpeg(Buffer.from(jpegs[jpegs.length - 1]));
      });
      p.stdio[3].on('error', () => {});
    } else if (!useFd3) {
      this.fileTimer = setInterval(() => this.readJpegFile(), Math.max(250, Math.round(1000 / Math.max(0.1, this.o.jpegFps))));
    }
    p.stderr.on('data', (d) => { errTail = (errTail + d.toString()).slice(-800); });
    p.on('error', (e) => { this.lastError = e.message; });
    p.on('close', (code) => {
      clearInterval(this.fileTimer); this.fileTimer = null;
      if (this.proc !== p) return;
      this.proc = null;
      if (this.stopped) { this.set({ state: 'off' }); return; }
      const tail = errTail.trim().split('\n').slice(-2).join(' | ');
      this.lastError = `ffmpeg (${kind}) exited ${code}${tail ? `: ${tail}` : ''}`;
      // an input that never gave a frame: try the next one (ddagrab -> gdigrab)
      if (!gotFrame && !this.kindWorks && this.kindIdx < this.order.length - 1 && Date.now() - startedAt < 60000) {
        this.kindIdx += 1; this.kind = this.order[this.kindIdx];
        say(`${this.lastError}; trying ${this.kind}`, { kind: 'screen' });
        this.restarts += 1; this.set({ state: 'restarting' });
        setTimeout(() => { if (!this.stopped) this.spawn(); }, 200);
        return;
      }
      if (Date.now() - startedAt > 60000) this.backoff = 1000;
      say(`${this.lastError}; again in ${this.backoff / 1000} s`, { kind: 'screen' });
      this.restart();
    });
    // an input that starts but never delivers (a ddagrab with no desktop to duplicate)
    if (this.order.length > 1) {
      setTimeout(() => { if (this.proc === p && !gotFrame && !this.kindWorks) { this.lastError = `no frame from ${kind} in ${this.o.firstFrameMs} ms`; try { p.kill(); } catch { /* gone */ } } }, this.o.firstFrameMs).unref?.();
    }
  }

  restart() {
    if (this.stopped) return;
    this.restarts += 1;
    this.set({ state: 'restarting' });
    const wait = this.backoff;
    this.backoff = Math.min(30000, this.backoff * 2);
    setTimeout(() => { if (!this.stopped) this.spawn(); }, wait);
  }

  gotJpeg(buf) { this.jpeg = buf; this.jpegAt = Date.now(); this.jpegs += 1; try { this.o.onJpeg?.(buf); } catch { /* listener */ } }

  readJpegFile() {
    try {
      const st = fs.statSync(this.jpegFile);
      if (st.mtimeMs <= this.jpegMtime) return;
      const b = fs.readFileSync(this.jpegFile);
      // a half-written file is skipped; the next one comes in a second
      if (b.length > 4 && b[0] === 0xff && b[1] === 0xd8 && b[b.length - 2] === 0xff && b[b.length - 1] === 0xd9) { this.jpegMtime = st.mtimeMs; this.gotJpeg(b); }
    } catch { /* not there yet */ }
  }

  /** age of the newest eye frame in ms (Infinity if none yet) */
  age() { return this.frame ? Date.now() - this.frameAt : Infinity; }

  /** the newest frame as her luminance grid (Float32Array GRID_W * GRID_H, 0..1); null if none yet */
  look() {
    if (!this.frame) return null;
    return gridFromPixels({ w: GRID_W, h: GRID_H, bpp: 3, data: this.frame });
  }

  async waitFrame(ms = 15000) {
    const t0 = Date.now();
    while (!this.frame && Date.now() - t0 < ms && !this.stopped) await new Promise((r) => setTimeout(r, 30));
    return Boolean(this.frame);
  }

  stop() {
    this.stopped = true;
    clearInterval(this.fileTimer);
    const p = this.proc;
    if (!p) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* gone */ } resolve(); }, 3000);
      p.once('close', () => { clearTimeout(t); resolve(); });
      try { p.kill(); } catch { /* gone */ }
    });
  }
}
