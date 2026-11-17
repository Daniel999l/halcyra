/**
 * The livestream out: ffmpeg -> STREAM_URL (RTMP ingest, key included).
 *
 *   x11   (DISPLAY is set, i.e. under Xvfb in the container) grab the whole
 *         virtual screen, where the console tab runs fullscreen
 *   pipe  (no display) encode the console tab's screenshots, written into
 *         ffmpeg's stdin at STREAM_PIPE_FPS
 *
 * H.264 (veryfast, zerolatency, CBR-ish, keyframe every 2 s) + a silent AAC
 * track, FLV. Defaults: 1280x720, 30 fps (x11) / 10 fps (pipe), 2500 kbps.
 * ffmpeg exiting -> restart with backoff (2 s doubling to 60 s).
 * The URL is never logged (it carries the stream key).
 *
 *   desktop  (Windows, CONSOLE_KIND=native) grab the whole desktop, where the
 *            game runs: ddagrab (Desktop Duplication), gdigrab if ddagrab gives
 *            nothing (STREAM_INPUT)
 *
 * Encoder (STREAM_ENCODER=auto): h264_nvenc when this ffmpeg has it AND a
 * one-second test encode works on this machine, else libx264.
 * Audio (STREAM_AUDIO=auto): on Windows a loopback capture device if one is
 * installed (docs/NATIVE.md: "Stereo Mix", VB-Audio "CABLE Output",
 * "virtual-audio-capturer"), else silence. Elsewhere silence. A silent AAC
 * track is always there, so an RTMP ingest that wants audio accepts it.
 */
import { spawn } from 'node:child_process';
import { say } from './log.js';
import { captureInput, captureOrder } from './native/screen.js';

const redact = (u) => String(u).replace(/^(rtmps?:\/\/[^/]+\/).*/i, '$1***');
/** take every form of the URL and its key out of a piece of text */
export function scrub(text, url) {
  let t = String(text || '');
  if (!url) return t;
  const pathPart = String(url).replace(/^[a-z]+:\/\/[^/]+\/?/i, '');
  const parts = [url, pathPart, ...pathPart.split(/[/?&=]/)].filter((x) => x && x.length >= 6).sort((a, b) => b.length - a.length);
  for (const p of parts) t = t.split(p).join('***');
  return t;
}

/** audio input args: silence, or a capture device ('dshow:<name>' on Windows, 'pulse:<source>' on Linux) */
export function audioInput(audio) {
  const a = String(audio || 'silent');
  if (a.startsWith('dshow:')) return ['-thread_queue_size', '512', '-f', 'dshow', '-audio_buffer_size', '50', '-i', `audio=${a.slice(6)}`];
  if (a.startsWith('pulse:')) return ['-thread_queue_size', '512', '-f', 'pulse', '-i', a.slice(6) || 'default'];
  return ['-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100'];
}

export function ffmpegArgs({ url, mode, size = '1280x720', fps = 30, pipeFps = 10, kbps = 2500, preset = 'veryfast', display = ':99', durationSec = 0, input: grab = 'ddagrab', encoder = 'libx264', audio = 'silent' }) {
  const [w, h] = size.split('x').map(Number);
  const outFps = mode === 'pipe' ? pipeFps : fps;
  let pre = '';
  let input;
  if (mode === 'x11') input = ['-f', 'x11grab', '-draw_mouse', '0', '-framerate', String(fps), '-video_size', `${w}x${h}`, '-i', `${display}+0,0`];
  else if (mode === 'desktop') { const c = captureInput(grab, { fps, display }); input = c.args; pre = c.pre ? `${c.pre},` : ''; }
  else input = ['-f', 'image2pipe', '-probesize', '32', '-analyzeduration', '0', '-fpsprobesize', '0', '-framerate', String(pipeFps), '-c:v', 'mjpeg', '-i', 'pipe:0'];
  const vf = `${pre}scale=${w}:${h}:force_original_aspect_ratio=decrease,pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2,format=yuv420p`;
  const isFile = !/^rtmps?:\/\//i.test(url);
  const video = encoder === 'h264_nvenc'
    ? ['-c:v', 'h264_nvenc', '-preset', 'p4', '-tune', 'll', '-rc', 'cbr', '-profile:v', 'high', '-bf', '0',
      '-b:v', `${kbps}k`, '-maxrate', `${kbps}k`, '-bufsize', `${kbps * 2}k`,
      '-g', String(outFps * 2), '-no-scenecut', '1', '-forced-idr', '1']
    : ['-c:v', 'libx264', '-preset', preset, '-tune', 'zerolatency', '-profile:v', 'high',
      '-b:v', `${kbps}k`, '-maxrate', `${kbps}k`, '-bufsize', `${kbps * 2}k`,
      '-g', String(outFps * 2), '-keyint_min', String(outFps * 2), '-sc_threshold', '0'];
  return [
    '-hide_banner', '-loglevel', 'error', '-stats_period', '2', '-progress', 'pipe:2', '-nostats',
    ...(mode === 'x11' || mode === 'desktop' ? ['-thread_queue_size', '512'] : []),
    ...input,
    ...audioInput(audio),
    '-map', '0:v:0', '-map', '1:a:0',
    '-vf', vf, '-r', String(outFps),
    ...video,
    '-c:a', 'aac', '-b:a', '128k', '-ar', '44100', '-ac', '2',
    ...(durationSec ? ['-t', String(durationSec)] : []),
    ...(isFile ? ['-y'] : ['-flvflags', 'no_duration_filesize']),
    '-f', 'flv', url,
  ];
}

/** run ffmpeg briefly; -> { code, out } (stdout + stderr) */
export function runFfmpeg(ffmpeg, args, timeoutMs = 15000) {
  return new Promise((resolve) => {
    let out = ''; let done = false;
    let p;
    try { p = spawn(ffmpeg || 'ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }); } catch (e) { resolve({ code: -1, out: e.message }); return; }
    const fin = (code) => { if (done) return; done = true; clearTimeout(t); resolve({ code, out }); };
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* gone */ } fin(-2); }, timeoutMs);
    p.stdout.on('data', (d) => { out = (out + d).slice(-200000); });
    p.stderr.on('data', (d) => { out = (out + d).slice(-200000); });
    p.on('error', (e) => { out += e.message; fin(-1); });
    p.on('close', (code) => fin(code));
  });
}

const nvencCache = new Map();
/** true if this ffmpeg lists h264_nvenc AND can encode a tiny clip with it on this machine (a GPU is there) */
export async function nvencWorks(ffmpeg = 'ffmpeg') {
  if (nvencCache.has(ffmpeg)) return nvencCache.get(ffmpeg);
  const enc = await runFfmpeg(ffmpeg, ['-hide_banner', '-encoders']);
  let ok = /h264_nvenc/.test(enc.out);
  if (ok) {
    const r = await runFfmpeg(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=640x360:r=30:d=1', '-c:v', 'h264_nvenc', '-f', 'null', '-']);
    ok = r.code === 0;
  }
  nvencCache.set(ffmpeg, ok);
  return ok;
}

const LOOPBACK = /stereo mix|what u hear|wave out mix|cable output|virtual-audio-capturer|voicemeeter out|loopback/i;
/** Windows: the names of the DirectShow audio capture devices */
export async function dshowAudioDevices(ffmpeg = 'ffmpeg') {
  const r = await runFfmpeg(ffmpeg, ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy']);
  const names = [];
  for (const line of r.out.split(/\r?\n/)) {
    const m = /"([^"]+)"\s*\(audio\)/.exec(line);
    if (m) names.push(m[1]);
  }
  if (!names.length) { // older ffmpeg: a header line, then the devices
    let inAudio = false;
    for (const line of r.out.split(/\r?\n/)) {
      if (/DirectShow audio devices/i.test(line)) { inAudio = true; continue; }
      if (/DirectShow video devices/i.test(line)) { inAudio = false; continue; }
      const m = /\]\s+"([^"]+)"/.exec(line);
      if (inAudio && m && !/Alternative name/i.test(line)) names.push(m[1]);
    }
  }
  return names;
}

/** STREAM_AUDIO -> 'silent' | 'dshow:<name>' | 'pulse:<src>' */
export async function pickAudio(audio = 'auto', ffmpeg = 'ffmpeg', platform = process.platform) {
  if (audio && audio !== 'auto') return audio;
  if (platform !== 'win32') return 'silent';
  const names = await dshowAudioDevices(ffmpeg).catch(() => []);
  const hit = names.find((n) => LOOPBACK.test(n));
  return hit ? `dshow:${hit}` : 'silent';
}

/** STREAM_ENCODER -> 'h264_nvenc' | 'libx264' */
export async function pickEncoder(encoder = 'auto', ffmpeg = 'ffmpeg') {
  if (encoder === 'h264_nvenc' || encoder === 'libx264') return encoder;
  return (await nvencWorks(ffmpeg)) ? 'h264_nvenc' : 'libx264';
}

export class Streamer {
  /**
   * opts: cfg.stream fields + getFrame() -> latest jpeg (pipe mode),
   * onStatus(status), durationSec (tests), restart (default true)
   */
  constructor(opts) {
    this.o = { restart: true, ...opts };
    this.mode = this.o.mode || (process.platform === 'win32' ? 'desktop' : this.o.display ? 'x11' : 'pipe');
    // desktop mode tries the capture inputs in order (ddagrab, then gdigrab)
    this.inputs = captureOrder(this.o.input || 'auto', 'win32'); this.inputIdx = 0; this.inputWorks = false;
    this.proc = null; this.timer = null; this.stopped = false;
    this.restarts = 0; this.backoff = 2000;
    this.status = { state: 'off', mode: this.mode, restarts: 0, fps: null, kbps: null, frames: 0, lastError: null, since: null };
  }

  set(p) { Object.assign(this.status, p); try { this.o.onStatus?.(this.status); } catch { /* listener */ } }

  start() {
    if (!this.o.url) { this.set({ state: 'off', lastError: 'STREAM_URL is not set' }); return this; }
    this.stopped = false;
    // the encoder and audio are decided once (each needs a short ffmpeg run), then ffmpeg starts
    this.ready = (async () => {
      const ff = this.o.ffmpeg || 'ffmpeg';
      // the Linux defaults stay exactly as they were: libx264, silence, no probing
      const enc = this.o.encoder && this.o.encoder !== 'auto' ? this.o.encoder : (this.mode === 'desktop' ? await pickEncoder('auto', ff) : 'libx264');
      const aud = this.o.audio && this.o.audio !== 'auto' ? this.o.audio : (this.mode === 'desktop' ? await pickAudio('auto', ff) : 'silent');
      this.encoder = enc; this.audio = aud;
      this.set({ encoder: enc, audio: aud === 'silent' ? 'silent' : aud });
      if (!this.stopped) this.spawn();
    })().catch((e) => { this.set({ state: 'error', lastError: e.message }); });
    return this;
  }

  spawn() {
    const input = this.inputs[this.inputIdx];
    const args = ffmpegArgs({ ...this.o, mode: this.mode, input, encoder: this.encoder || 'libx264', audio: this.audio || 'silent' });
    say(`ffmpeg (${this.mode}${this.mode === 'desktop' ? ` ${input}` : ''}, ${this.encoder || 'libx264'}, audio ${this.audio || 'silent'}) -> ${redact(this.o.url)}`, { kind: 'stream' });
    const p = spawn(this.o.ffmpeg || 'ffmpeg', args, { stdio: [this.mode === 'pipe' ? 'pipe' : 'ignore', 'ignore', 'pipe'] });
    this.proc = p;
    const startedAt = Date.now();
    this.set({ state: 'starting', since: startedAt, frames: 0 });
    let errTail = '';
    p.stderr.on('data', (d) => {
      const s = d.toString();
      const prog = Object.fromEntries(s.split('\n').map((l) => l.split('=')).filter((kv) => kv.length === 2).map(([k, v]) => [k.trim(), v.trim()]));
      if (prog.frame) {
        if (Number(prog.frame) > 0) this.inputWorks = true;
        const kb = parseFloat(prog.bitrate);
        this.set({ state: 'live', frames: Number(prog.frame), fps: parseFloat(prog.fps) || null, kbps: Number.isFinite(kb) ? Math.round(kb) : null });
      }
      const errs = s.split('\n').filter((l) => l && !l.includes('='));
      if (errs.length) errTail = (errTail + errs.join('\n') + '\n').slice(-1500); // raw here, scrubbed before it is shown
    });
    if (this.mode === 'pipe') {
      p.stdin.on('error', () => { /* ffmpeg went away; the exit handler deals with it */ });
      const every = Math.round(1000 / (this.o.pipeFps || 10));
      this.timer = setInterval(() => {
        const f = this.o.getFrame?.();
        if (!f || !p.stdin.writable) return;
        if (p.stdin.writableLength > 4 << 20) return; // ffmpeg is behind: skip, do not queue
        p.stdin.write(f);
      }, every);
    }
    p.on('error', (e) => { errTail = e.message; });
    p.on('close', (code) => {
      clearInterval(this.timer); this.timer = null; this.proc = null;
      const last = scrub(errTail.split('\n').filter(Boolean).slice(-2).join(' | '), this.o.url);
      if (this.stopped || (this.o.durationSec && code === 0)) { this.set({ state: this.stopped ? 'off' : 'done', exitCode: code }); this.o.onExit?.(code); return; }
      // desktop: an input that never gave a frame -> the next one (ddagrab -> gdigrab); a loopback device that fails -> silence
      if (this.mode === 'desktop' && !this.inputWorks && this.inputIdx < this.inputs.length - 1) { this.inputIdx += 1; say(`desktop capture failed; trying ${this.inputs[this.inputIdx]}`, { kind: 'stream' }); }
      else if (this.mode === 'desktop' && !this.inputWorks && this.audio !== 'silent' && (!this.o.audio || this.o.audio === 'auto')) { say(`audio device ${this.audio} failed; using silence`, { kind: 'stream' }); this.audio = 'silent'; this.set({ audio: 'silent' }); }
      if (Date.now() - startedAt > 60000) this.backoff = 2000; // it ran fine for a while
      this.restarts += 1;
      this.set({ state: 'restarting', restarts: this.restarts, lastError: `ffmpeg exited ${code}${last ? `: ${last}` : ''}`, exitCode: code });
      say(`ffmpeg exited (${code})${last ? `: ${last}` : ''}; again in ${this.backoff / 1000} s`, { kind: 'stream' });
      if (!this.o.restart) { this.o.onExit?.(code); return; }
      setTimeout(() => { if (!this.stopped) this.spawn(); }, this.backoff);
      this.backoff = Math.min(60000, this.backoff * 2);
    });
  }

  stop() {
    this.stopped = true;
    clearInterval(this.timer);
    const p = this.proc;
    if (!p) return Promise.resolve();
    return new Promise((resolve) => {
      const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* gone */ } resolve(); }, 4000);
      p.once('close', () => { clearTimeout(t); resolve(); });
      try { if (this.mode === 'pipe') p.stdin.end(); p.kill('SIGINT'); } catch { /* gone */ }
    });
  }
}
