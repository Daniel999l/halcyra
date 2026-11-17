/**
 * What she is doing now: her picture (/api/frame.jpg), the counts
 * (/api/state, /api/trades) and her looks and tastes as they happen
 * (/api/live). Nothing is shown that the service did not send.
 */
const fmt = (n) => Number(n || 0).toLocaleString('en-US');
function sol(x) { const v = Number(x) || 0; return v >= 100 ? v.toFixed(0) : v >= 1 ? v.toFixed(2) : v.toFixed(3); }
function ago(ts) {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s} s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

export function startLive({ onFrame, onTick, onTrade, wantFrame }) {
  const win = document.querySelector('.window');
  const dl = document.querySelector('.readouts');
  let totals = null; let lastTrade = null; let hadFrame = false;

  function row(k, label, value, cls = '') {
    let el = dl.querySelector(`[data-k="${k}"]`);
    if (!el) {
      el = document.createElement('div'); el.className = 'ro'; el.dataset.k = k;
      el.innerHTML = '<dt></dt><dd></dd>';
      const order = ['looks', 'trades', 'last'];
      const after = [...dl.children].find((c) => order.indexOf(c.dataset.k) > order.indexOf(k));
      dl.insertBefore(el, after || null);
    }
    el.querySelector('dt').textContent = label;
    el.querySelector('dd').textContent = value;
    el.classList.toggle('sweet', cls === 'sweet');
  }
  function render() {
    if (totals?.ticks > 0) row('looks', 'Looks so far', fmt(totals.ticks));
    if (totals?.trades > 0) row('trades', 'Trades tasted', fmt(totals.trades));
    if (lastTrade && (lastTrade.side === 'buy' || lastTrade.side === 'sell')) {
      row('last', lastTrade.side === 'buy' ? 'Last buy, sugar' : 'Last sell, bitter', `${sol(lastTrade.sol)} SOL, ${ago(lastTrade.ts)}`, lastTrade.side === 'buy' ? 'sweet' : '');
    }
  }
  const last0 = dl.querySelector('[data-k="last"]');
  if (last0 && /buy/i.test(last0.textContent)) last0.classList.add('sweet');

  async function poll() {
    try {
      const [s, t] = await Promise.all([
        fetch('/api/state', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)),
        fetch('/api/trades?limit=1', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      ]);
      if (s?.totals) totals = s.totals;
      if (t?.trades?.[0]) lastTrade = t.trades[0];
      render();
    } catch { /* keep what is shown */ }
  }

  let busy = false;
  async function pullFrame(force = false) {
    if (busy || document.hidden || (!force && !wantFrame())) return;
    busy = true;
    try {
      const r = await fetch(`/api/frame.jpg?t=${Date.now()}`, { cache: 'no-store' });
      if (r.status === 200) {
        const blob = await r.blob();
        const bmp = await createImageBitmap(blob);
        onFrame(bmp);
        showInWindow(blob);
        hadFrame = true;
      } else if (r.status === 204 && hadFrame) {
        onFrame(null); clearWindow(); hadFrame = false;
      }
    } catch { /* next time */ }
    busy = false;
  }
  function clearWindow() { win.querySelectorAll('img.frame').forEach((i) => i.remove()); win.dataset.frame = '0'; }
  function showInWindow(blob) {
    const url = URL.createObjectURL(blob);
    const img = new Image(); img.className = 'frame next'; img.alt = 'Her game screen';
    img.onload = () => {
      win.insertBefore(img, win.querySelector('.tick'));
      requestAnimationFrame(() => img.classList.add('in'));
      const olds = [...win.querySelectorAll('img.frame')].filter((i) => i !== img);
      setTimeout(() => { for (const o of olds) { if (o.src.startsWith('blob:')) URL.revokeObjectURL(o.src); o.remove(); } }, 1000);
      win.dataset.frame = '1';
    };
    img.src = url;
  }

  try {
    const es = new EventSource('/api/live');
    es.addEventListener('tick', (e) => { try { const t = JSON.parse(e.data); onTick(t); if (totals) { totals.ticks = Math.max(totals.ticks || 0, (t.step ?? -1) + 1); render(); } } catch { /* skip */ } });
    es.addEventListener('trade', (e) => { try { const t = JSON.parse(e.data); lastTrade = t; if (totals) totals.trades = (totals.trades || 0) + 1; onTrade(t); render(); } catch { /* skip */ } });
    es.addEventListener('hello', (e) => { try { const h = JSON.parse(e.data); if (h.latest) onTick(h.latest); } catch { /* skip */ } });
  } catch { /* no live stream */ }

  poll();
  setInterval(poll, 8000);
  pullFrame(true);
  setInterval(() => pullFrame(false), 3000);
  setInterval(() => { if (lastTrade) render(); }, 15000);
}
