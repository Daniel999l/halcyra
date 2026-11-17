/**
 * What she sees of the console tab.
 *
 * Her eye: a screenshot, averaged down to a 160 x 90 luminance grid
 * (8 x 8 screen pixels per cell at 1280 x 720). gamebody.js projects that grid
 * onto her lamina.
 *
 * Two capture paths, both measured (docs/CONTROLS.md, test/pilot-eye.mjs):
 *
 *   'png'    full PNG screenshot through Playwright, decoded here
 *            with node's own zlib, every other pixel averaged into 8 x 8 cells.
 *   'small'  the compositor does the shrinking: CDP Page.captureScreenshot with
 *            a clip scaled to 1/8, so Chromium hands back a 160 x 90 PNG and
 *            each pixel is one grid cell. Same picture, far fewer bytes.
 *
 * Either way the overlay is hidden first, so she never sees herself.
 */
import zlib from 'node:zlib';

export const GRID_W = 160;
export const GRID_H = 90;

/** decode an 8-bit RGB/RGBA non-interlaced PNG (what Chromium screenshots are) */
export function decodePng(buf) {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a png');
  let off = 8; let w = 0; let h = 0; let bitDepth = 0; let colorType = 0; let interlace = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off); const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9]; interlace = data[12];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  if (bitDepth !== 8 || interlace !== 0 || ![2, 6].includes(colorType)) {
    throw new Error(`unsupported png (depth ${bitDepth}, colour ${colorType}, interlace ${interlace})`);
  }
  const bpp = colorType === 6 ? 4 : 3;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = w * bpp;
  const out = Buffer.alloc(h * stride);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y += 1) {
    const ft = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = out.subarray(y * stride, (y + 1) * stride);
    for (let x = 0; x < stride; x += 1) {
      const a = x >= bpp ? cur[x - bpp] : 0; const b = prev[x]; const c = x >= bpp ? prev[x - bpp] : 0;
      let v = line[x];
      if (ft === 1) v += a;
      else if (ft === 2) v += b;
      else if (ft === 3) v += (a + b) >> 1;
      else if (ft === 4) { const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      cur[x] = v & 255;
    }
    prev = cur;
  }
  return { w, h, bpp, data: out };
}

/** decoded RGB(A) pixels of any size -> GRID_W x GRID_H luminance in 0..1 (Rec. 709) */
export function gridFromPixels({ w, h, bpp, data }) {
  const g = new Float32Array(GRID_W * GRID_H);
  const n = new Uint32Array(GRID_W * GRID_H);
  // big frames: every other pixel, plenty for an 8x8 average;
  // a frame already at grid size: every pixel
  const st = w >= GRID_W * 2 ? 2 : 1;
  // (y * GRID_H) / h, not (y / h) * GRID_H: the latter rounds some
  // exact cell boundaries down (7/90*90 = 6.999...), which at grid size leaves
  // whole rows and columns of cells empty
  for (let y = 0; y < h; y += st) {
    const gy = Math.min(GRID_H - 1, Math.floor((y * GRID_H) / h));
    for (let x = 0; x < w; x += st) {
      const gx = Math.min(GRID_W - 1, Math.floor((x * GRID_W) / w));
      const i = (y * w + x) * bpp;
      const l = (0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]) / 255;
      g[gy * GRID_W + gx] += l; n[gy * GRID_W + gx] += 1;
    }
  }
  for (let i = 0; i < g.length; i += 1) g[i] = n[i] ? g[i] / n[i] : 0;
  return g;
}

/** PNG screenshot -> GRID_W x GRID_H luminance in 0..1  */
export function luminanceGrid(pngBuf) {
  return gridFromPixels(decodePng(pngBuf));
}

/**
 * The 'frame' eye, run inside the page: the game picture itself (the largest
 * playing <video>, else the largest <canvas>, never the overlay) is drawn into
 * a GRID_W x GRID_H canvas where it sits on the screen, and those pixels come
 * back. No screenshot is taken, nothing is resized, the window is not touched,
 * and the overlay is not in the picture (so it never has to be hidden).
 * Returns { b64 } (RGBA bytes, base64) or { err: 'none' | 'tainted' | message }.
 */
export const FRAME_JS = `(() => {
  const W = ${GRID_W}, H = ${GRID_H};
  const vis = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
  const area = (el) => { const r = el.getBoundingClientRect(); return r.width * r.height; };
  let el = window.__halcyraTarget && window.__halcyraTarget.isConnected && vis(window.__halcyraTarget) ? window.__halcyraTarget : null;
  if (el && el.tagName === 'VIDEO' && !(el.readyState >= 2 && el.videoWidth > 0)) el = null;
  if (!el) {
    const vids = [...document.querySelectorAll('video')].filter((v) => vis(v) && v.readyState >= 2 && v.videoWidth > 0).sort((a, b) => area(b) - area(a));
    const cans = [...document.querySelectorAll('canvas')].filter((c) => vis(c) && c !== window.__flyEyeCanvas && !c.closest('#__fly_hud')).sort((a, b) => area(b) - area(a));
    el = vids[0] || cans[0] || null;
  }
  if (!el) return { err: 'none' };
  const r = el.getBoundingClientRect();
  const vw = window.innerWidth || document.documentElement.clientWidth; const vh = window.innerHeight || document.documentElement.clientHeight;
  const c = window.__flyEyeCanvas || (window.__flyEyeCanvas = document.createElement('canvas'));
  if (c.width !== W) c.width = W; if (c.height !== H) c.height = H;
  const g = c.getContext('2d', { willReadFrequently: true, alpha: false });
  g.imageSmoothingEnabled = true; g.imageSmoothingQuality = 'high';
  let bg = getComputedStyle(document.body || document.documentElement).backgroundColor;
  if (!bg || bg === 'transparent' || /rgba\(0, 0, 0, 0\)/.test(bg)) bg = getComputedStyle(document.documentElement).backgroundColor;
  g.fillStyle = (!bg || bg === 'transparent' || /rgba\(0, 0, 0, 0\)/.test(bg)) ? '#fff' : bg;
  g.fillRect(0, 0, W, H);
  try {
    g.drawImage(el, r.x * W / vw, r.y * H / vh, r.width * W / vw, r.height * H / vh);
    const d = g.getImageData(0, 0, W, H).data;
    let s = '';
    for (let i = 0; i < d.length; i += 0x8000) s += String.fromCharCode.apply(null, d.subarray(i, i + 0x8000));
    return { b64: btoa(s), kind: el.tagName.toLowerCase() };
  } catch (e) {
    return { err: e && e.name === 'SecurityError' ? 'tainted' : String(e && e.message || e) };
  }
})()`;

/**
 * A camera on one page.
 *   'frame' (default) the game element drawn small inside the page (FRAME_JS);
 *           falls back to 'png' for any look where there is no game element or
 *           the picture cannot be read (a cross-origin or protected video)
 *   'png'   full screenshot
 *   'small' CDP Page.captureScreenshot with clip.scale. Fast, but on a real
 *           (headed) window it re-renders the visible window small for a moment:
 *           the page sees a resize and a screen grab shows a tiny game. Kept for
 *           comparison only; see docs/CONTROLS.md.
 * 'small' falls back to 'png' if the CDP session cannot be opened.
 */
export class Eye {
  constructor({ mode = 'frame', width = 1280, height = 720 } = {}) {
    this.mode = mode;
    this.width = width; this.height = height;
    this.cdp = null;
    this.page = null;
    this.lastPath = null;      // which path the last look took
    this.fallbacks = 0;        // 'frame' looks that had to take a screenshot
    this.lastFallback = null;  // why
  }

  async open(page) {
    this.page = page;
    if (this.mode !== 'small') return this;
    try {
      this.cdp = await page.context().newCDPSession(page);
    } catch {
      this.cdp = null; this.mode = 'png';
    }
    return this;
  }

  /** one look: -> Float32Array GRID_W*GRID_H, luminance 0..1 */
  async look(page = this.page) {
    if (this.mode === 'frame') {
      const r = await page.evaluate(FRAME_JS).catch((e) => ({ err: String(e.message).split('\n')[0] }));
      if (r && r.b64) {
        this.lastPath = 'frame'; this.lastKind = r.kind;
        return gridFromPixels({ w: GRID_W, h: GRID_H, bpp: 4, data: Buffer.from(r.b64, 'base64') });
      }
      this.fallbacks += 1; this.lastFallback = r && r.err; this.lastPath = 'png';
      return luminanceGrid(await page.screenshot({ type: 'png' }));
    }
    if (this.mode === 'small' && this.cdp) {
      this.lastPath = 'small';
      const vp = (page.viewportSize && page.viewportSize()) || { width: this.width, height: this.height };
      const r = await this.cdp.send('Page.captureScreenshot', {
        format: 'png',
        clip: { x: 0, y: 0, width: vp.width, height: vp.height, scale: GRID_W / vp.width },
        captureBeyondViewport: false,
      });
      return luminanceGrid(Buffer.from(r.data, 'base64'));
    }
    this.lastPath = 'png';
    return luminanceGrid(await page.screenshot({ type: 'png' }));
  }

  async close() {
    try { await this.cdp?.detach(); } catch { /* gone */ }
    this.cdp = null;
  }
}

/** mean absolute difference between two grids (for the equivalence check) */
export function gridDiff(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) s += Math.abs(a[i] - b[i]);
  return s / a.length;
}

/**
 * Her readout drawn over the console picture, for the camera and for anyone
 * watching. Hidden while she looks, so she never sees it.
 */
export const OVERLAY_JS = `(() => {
  if (window.__fly) return;
  const hud = document.createElement('div');
  hud.id = '__fly_hud';
  Object.assign(hud.style, { position: 'fixed', left: '14px', bottom: '14px', pointerEvents: 'none', zIndex: 2147483647,
    font: '11px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', color: '#f6f1e6', background: 'rgba(10,9,12,.80)',
    border: '1px solid rgba(246,241,230,.14)', borderRadius: '10px', padding: '10px 12px', minWidth: '250px', letterSpacing: '.02em', whiteSpace: 'pre' });
  const put = () => { if (!document.documentElement.contains(hud)) document.documentElement.appendChild(hud); };
  put();
  const bar = (v) => '\\u2588'.repeat(Math.round(Math.max(0, Math.min(1, v)) * 12)).padEnd(12, '\\u00b7');
  const sbar = (v) => {
    const k = Math.round(Math.max(-1, Math.min(1, v)) * 6);
    let s = '';
    for (let i = -6; i <= 6; i += 1) s += i === 0 ? '|' : (k < 0 && i >= k && i < 0) || (k > 0 && i <= k && i > 0) ? '\\u2588' : '\\u00b7';
    return s;
  };
  window.__fly = {
    hide() { hud.style.visibility = 'hidden'; },
    show() { put(); hud.style.visibility = 'visible'; },
    draw(s) {
      put();
      const p = s.pad || { axes: [0, 0, 0, 0], buttons: {} };
      const b = p.buttons || {};
      hud.innerHTML = '<div style="opacity:.55;margin-bottom:4px">139,255 NEURONS \\u00b7 ' + (s.active ?? 0) + ' ACTIVE</div>'
        + '<div>DN left   ' + bar((s.L || 0) * 4) + '</div>'
        + '<div>DN right  ' + bar((s.R || 0) * 4) + '</div>'
        + '<div>steer     ' + sbar(p.axes[0] || 0) + '</div>'
        + '<div>gas       ' + bar(b.rt || 0) + '</div>'
        + '<div>brake     ' + bar(b.lt || 0) + '</div>'
        + '<div>Y enter   ' + (b.y ? 'PRESSED' : '\\u00b7') + '</div>'
        + '<div>RB brake  ' + (b.rb ? 'PRESSED' : '\\u00b7') + '</div>';
    },
  };
})()`;
