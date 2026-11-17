/**
 * The site. It shows what she is actually doing.
 *
 * Everything on this page comes from the rig behind it, over /api/state, every
 * two seconds. The brain map is her real cells at their real soma positions,
 * lit by whichever of them are firing in the run that is happening now. There
 * is no simulation in this page and nothing here is a recording.
 */
import { loadAtlas } from './atlas.js';

const $ = (id) => document.getElementById(id);
const fmtUsd = (n) => (n == null ? '–'
  : n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B`
  : n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M`
  : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${Number(n).toFixed(2)}`);
const num = (n) => Number(n || 0).toLocaleString();

const atlas = await loadAtlas('fly');

/* ------------------------------------------------------------------ her brain */
const ac = $('atlas'); const ag = ac.getContext('2d');
const AW = ac.width; const AH = ac.height;
const px = new Int32Array(atlas.N);
{
  const pad = 18;
  for (let i = 0; i < atlas.N; i += 1) {
    const x = pad + (atlas.pos[i * 3] / 65535) * (AW - pad * 2);
    const y = pad + (atlas.pos[i * 3 + 1] / 65535) * (AH - pad * 2);
    px[i] = ((y | 0) * AW + (x | 0)) * 4;
  }
}
const img = ag.createImageData(AW, AH);
const buf = img.data;
const BASE = new Uint8ClampedArray(AW * AH * 4);
for (let i = 0; i < AW * AH; i += 1) { BASE[i * 4] = 16; BASE[i * 4 + 1] = 17; BASE[i * 4 + 2] = 23; BASE[i * 4 + 3] = 255; }
// a faint resting outline, so it reads as an animal even when she is quiet
for (let i = 0; i < atlas.N; i += 1) {
  const o = px[i];
  BASE[o] = Math.min(255, BASE[o] + 7);
  BASE[o + 1] = Math.min(255, BASE[o + 1] + 8);
  BASE[o + 2] = Math.min(255, BASE[o + 2] + 12);
}
buf.set(BASE); ag.putImageData(img, 0, 0);

/** the rig sends only the cells that are lit, as [index, level] pairs */
function paintBrain(pairs) {
  buf.set(BASE);
  for (let k = 0; k < pairs.length; k += 1) {
    const i = pairs[k][0]; const v = pairs[k][1];
    if (i < 0 || i >= atlas.N) continue;
    const o = px[i]; const s = v > 1 ? 1 : v;
    if (atlas.female[i]) {
      buf[o] = Math.min(255, buf[o] + 240 * s);
      buf[o + 1] = Math.min(255, buf[o + 1] + 40 * s);
      buf[o + 2] = Math.min(255, buf[o + 2] + 110 * s);
    } else {
      buf[o] = Math.min(255, buf[o] + 120 * s);
      buf[o + 1] = Math.min(255, buf[o + 1] + 200 * s);
      buf[o + 2] = Math.min(255, buf[o + 2] + 230 * s);
    }
  }
  ag.putImageData(img, 0, 0);
}

/* ------------------------------------------------------------------ readouts */
const READS = [
  ['fDnL', 'vDnL', (f) => f.dnL, 10],
  ['fDnR', 'vDnR', (f) => f.dnR, 10],
  ['fDrive', 'vDrive', (f) => f.drive, 1],
  ['fStop', 'vStop', (f) => f.DNp09, 6],
  ['fLay', 'vLay', (f) => f.oviDNb, 10],
];
function paintReads(f) {
  for (const [bar, val, get, k] of READS) {
    const v = get(f) || 0;
    $(bar).style.width = `${Math.min(100, Math.max(0, v * k * 100))}%`;
    $(val).textContent = v.toFixed(3);
  }
}

function setCa(ca, url) {
  const el = $('lvCa');
  const pons = $('lvPons');
  if (!ca) {
    el.textContent = 'not launched yet'; el.style.color = 'var(--ink3)'; el.onclick = null;
    pons.hidden = true; return;
  }
  pons.hidden = !url; if (url) pons.href = url;
  if (el.dataset.ca === ca) return;
  el.dataset.ca = ca;
  el.textContent = ca;
  el.style.color = 'var(--ink)';
  el.onclick = () => {
    navigator.clipboard?.writeText(ca).then(() => {
      el.textContent = 'copied'; el.style.color = 'var(--hot)';
      setTimeout(() => { el.textContent = ca; el.style.color = 'var(--ink)'; }, 1100);
    }).catch(() => {});
  };
  document.title = `FAFB ${ca.slice(0, 6)}...`;
}

/* ------------------------------------------------------------------ the feed */
const feedImg = $('feedImg');
feedImg.onload = () => { feedImg.hidden = false; $('feedMsg').hidden = true; };
feedImg.onerror = () => { feedImg.hidden = true; $('feedMsg').hidden = false; };
// while she is painting, the panel is the piece in progress (fly/livepanel.js)
setInterval(() => {
  if (window.__artLive) return;
  if (document.visibilityState === 'visible') feedImg.src = `api/frame.jpg?t=${Date.now()}`;
}, 900);

// the launch video only exists once she has been recorded doing it
fetch('api/video.mp4', { method: 'HEAD' })
  .then((r) => { if (r.ok) $('videopanel').hidden = false; })
  .catch(() => {});

const MSG = {
  idle: 'she is not running',
  roaming: 'she is between pages',
  offline: 'the rig is not answering',
};

async function poll() {
  let st = null;
  try {
    const r = await fetch('api/state', { cache: 'no-store' });
    if (r.ok) st = await r.json();
  } catch { /* down */ }

  if (!st) {
    $('livebar').hidden = true;
    $('feedNote').textContent = 'offline';
    $('feedMsg').textContent = MSG.offline;
    $('uptime').textContent = '';
    return;
  }
  $('livebar').hidden = false;

  setCa(st.token?.address || null, st.token?.url || null);
  $('lvTicker').textContent = st.coin?.ticker ? `$${st.coin.ticker}` : '–';
  $('lvMcap').textContent = fmtUsd(st.stats?.marketCap ?? st.stats?.fdv ?? null);
  $('lvMode').textContent = st.phase ? `${st.mode} · ${st.phase}` : st.mode;
  $('lvDot').className = `dot${st.mode === 'idle' ? ' idle' : ''}`;
  const up = st.upSeconds || 0;
  $('uptime').textContent = `up ${up > 3600 ? `${Math.floor(up / 3600)}h ${Math.floor((up % 3600) / 60)}m` : `${Math.floor(up / 60)}m`}`;

  if (!window.__artLive) $('feedNote').textContent = st.mode;
  if (!window.__artLive) $('feedMsg').textContent = MSG[st.mode] || 'waiting for her';

  const f = st.fly;
  if (f) {
    if (f.lit) paintBrain(f.lit);
    $('cActive').textContent = num(f.active);
    $('cSteps').textContent = num(f.step);
    $('cLays').textContent = String(f.lays ?? 0);
    paintReads(f);
    const where = st.phase ? `pons: ${st.phase}` : (st.roam?.title || st.roam?.url || '');
    if (!window.__artLive) $('feedCap').textContent = `${where}${where ? '  ·  ' : ''}step ${f.step}  ·  at ${f.at[0]}, ${f.at[1]}${f.lay ? '  ·  SHE LAID' : ''}`;
    if (f.top?.length) {
      $('topcells').innerHTML = f.top.map((c) =>
        `<li class="${c.fem ? 'fem' : ''}"><b>${c.type}</b><i>${c.cls}</i><u>${c.v.toFixed(2)}</u></li>`).join('');
    }
  } else {
    if (!window.__artLive) $('feedCap').innerHTML = '&nbsp;';
  }

  $('feedLog').innerHTML = (st.log || []).slice(-14).reverse()
    .map((l) => `<div><b>${new Date(l.at).toLocaleTimeString()}</b> ${String(l.msg).replace(/[<>]/g, '')}</div>`).join('');
}
poll();
setInterval(poll, 2000);
