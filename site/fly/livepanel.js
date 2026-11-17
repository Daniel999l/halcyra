/**
 * The front page panel, while she is painting.
 *
 * If the drawing run is on, this takes over the "what she is doing" panel and
 * paints the piece in progress from her state, the same way /draw.html does. If
 * it is off, it does nothing at all and the panel keeps showing the browser
 * frame as before.
 */
import { Surface } from './surface.js';

const $ = (id) => document.getElementById(id);

const cv = $('liveCv');
const img = $('feedImg');
const msg = $('feedMsg');
const note = $('feedNote');
const cap = $('feedCap');
if (cv) start();

async function start() {
  let on = false;
  try {
    const r = await fetch('api/art/state', { cache: 'no-store' });
    if (r.ok) {
      const s = await r.json();
      const phase = s.status?.phase;
      on = s.running === true
        || ['starting', 'drawing', 'saving', 'saved', 'complete'].includes(phase);
    }
  } catch { /* the run is not there */ }
  if (!on) return;

  // the browser feed is not what she is doing any more
  window.__artLive = true;
  if (img) { img.hidden = true; img.removeAttribute('src'); }
  if (msg) msg.hidden = true;
  cv.hidden = false;

  const ctx = cv.getContext('2d', { alpha: false });
  let surf = null; let head = null; let image = null; let dirty = false;
  let next = 0; const pending = new Map(); let lays = new Set();

  const draw = () => {
    if (dirty && surf && image) { surf.toRGBA(image.data); ctx.putImageData(image, 0, 0); dirty = false; }
    requestAnimationFrame(draw);
  };
  requestAnimationFrame(draw);

  const es = new EventSource('api/art/stream');

  es.addEventListener('start', (e) => {
    head = JSON.parse(e.data);
    cv.width = head.size; cv.height = head.size;
    surf = new Surface(head);
    image = ctx.createImageData(head.size, head.size);
    next = 0; pending.clear(); lays = new Set(); dirty = true;
    if (note) note.textContent = `piece ${String(head.i).padStart(4, '0')} of ${head.total}`;
  });

  es.addEventListener('frames', (e) => {
    if (!surf) return;
    const d = JSON.parse(e.data);
    lays = new Set(d.lays);
    for (let k = 0; k < d.f.length; k += 1) pending.set(d.from + k, d.f[k]);
    while (pending.has(next)) { surf.step(pending.get(next), lays.has(next)); pending.delete(next); next += 1; }
    dirty = true;
    if (cap && head) {
      const f = d.f[d.f.length - 1];
      cap.textContent = `${head.params.palette.name}  ·  ${(next / (head.fps || 30)).toFixed(0)}s  ·  `
        + `${Math.round((f ? f[5] : 0) * 139255).toLocaleString()} cells firing  ·  ${lays.size} lays`;
    }
  });

  es.addEventListener('status', (e) => {
    const s = JSON.parse(e.data);
    if (note && s.phase !== 'drawing') note.textContent = s.phase === 'saving' ? 'saving the piece' : s.phase;
  });

  es.addEventListener('done', () => { if (note) note.textContent = 'saved'; });
}
