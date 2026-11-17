/**
 * Two plain documents, server rendered from live state (no client fetch):
 *
 *   GET /proof        the ledger head, the last records, checkpoints, how to
 *                     check the chain, the last tasted trades, the ladder, the coin
 *   GET /whitepaper   what she is, how she sees, tastes and plays, the ladder
 *                     rule, the ledger rule, and one rules table. Every number
 *                     is read from the code or data when the page is rendered.
 *
 *   mountDocs(app, deps)   app = anything with .get(path, (req, res) => ...) (Express)
 *   docsRoute(deps)        -> async (req, res, pathname) => true when it answered
 *                             (for the plain node http server in src/server.js)
 *   deps = { cfg, hub, ledger }   (cfg from src/config.js, hub from src/state.js,
 *                                  ledger from src/ledger.js; hub.ladder may be null)
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TASTE_DEFAULTS, findTasteCells } from './taste.js';
import { GAMEBODY_DEFAULTS, PAD_MAPPING, findReadouts } from './gamebody.js';
import { GRID_W, GRID_H } from './eye.js';
import { parseStages } from './ladder.js';
import { RATE_DEFAULTS } from '../site/fly/rate.js';
import { loadNeuronsNode } from '../site/fly/load.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FLY = path.join(ROOT, 'site', 'fly');

// ---------------------------------------------------------------- helpers
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (n) => Number(n || 0).toLocaleString('en-US');
const usd = (n) => `$${Number(n || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const p2 = (n) => String(n).padStart(2, '0');
/** "17 Nov 2026, 14:03:22 UTC" (no dashes) */
export function when(ms) {
  if (!Number.isFinite(Number(ms)) || !ms) return '';
  const d = new Date(Number(ms));
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} UTC`;
}
const solAmt = (x) => { const v = Number(x) || 0; return v >= 100 ? v.toFixed(0) : v >= 1 ? v.toFixed(2) : v.toFixed(3); };
const short = (s, a = 6, b = 6) => { s = String(s || ''); return s.length > a + b + 3 ? `${s.slice(0, a)}…${s.slice(-b)}` : s; };
/** a formula from the code, shown with a true minus sign */
const math = (s) => esc(String(s)).replace(/ - /g, ' − ').replace(/(^|[\s(,])-(?=\d)/g, '$1−');
const solscanTx = (s) => `https://solscan.io/tx/${encodeURIComponent(s)}`;
const solscanAcc = (a) => `https://solscan.io/account/${encodeURIComponent(a)}`;
const pumpCoin = (ca) => `https://pump.fun/coin/${encodeURIComponent(ca)}`;
const ext = (href, text, cls = '') => `<a href="${esc(href)}" target="_blank" rel="noopener"${cls ? ` class="${cls}"` : ''}>${text}</a>`;
const safe = (f, d = null) => { try { const v = f(); return v ?? d; } catch { return d; } };
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(path.join(FLY, f), 'utf8')); } catch { return null; } };

// ---------------------------------------------------------------- facts read from data and code
let factsP = null;
/** everything the whitepaper states, read once from site/fly and the modules */
export function facts() {
  if (factsP) return factsP;
  factsP = (async () => {
    const meta = readJson('meta.json') || {};
    const gains = readJson('gains.json') || {};
    const eyemap = readJson('eyemap.json') || { eye: {} };
    const lam = {};
    for (const ct of ['L1', 'L2', 'L3', 'L4', 'L5']) lam[ct] = { left: eyemap.eye?.[`${ct}_left`]?.idx?.length || 0, right: eyemap.eye?.[`${ct}_right`]?.idx?.length || 0 };
    const lamLeft = Object.values(lam).reduce((s, x) => s + x.left, 0);
    const lamRight = Object.values(lam).reduce((s, x) => s + x.right, 0);
    let taste = null; let readouts = null;
    try {
      const names = await loadNeuronsNode(FLY);
      const tc = findTasteCells(names);
      taste = { sweet: tc.sweet.length, bitter: tc.bitter.length, sweetTypes: tc.meta.sweetTypes, bitterTypes: tc.meta.bitterTypes, missing: tc.meta.missing };
      const r = findReadouts(names);
      readouts = { descending: { left: r.dnLeft.length, right: r.dnRight.length }, types: Object.fromEntries(Object.entries(r.types).map(([k, v]) => [k, v.L.length + v.R.length])) };
    } catch { /* names unavailable: those rows are left out */ }
    return { meta, brain: { ...RATE_DEFAULTS, ...(gains.brain || {}) }, lam, lamLeft, lamRight, taste, readouts };
  })();
  factsP.catch(() => { factsP = null; });
  return factsP;
}

// ---------------------------------------------------------------- shell
const CSS = `
@font-face{font-family:'Inter';src:url('/home/fonts/inter-latin-opsz-normal.woff2') format('woff2');font-weight:100 900;font-style:normal;font-display:swap}
:root{--ink:#000;--ink-2:#5b5f64;--ink-3:#8d9196;--hair:#d3d6da;--glass:#f5f6f7;--pad:clamp(20px,5.6vw,88px)}
*{box-sizing:border-box}
html{background:#fff;color:var(--ink);-webkit-text-size-adjust:100%}
body{margin:0;background:#fff;font-family:'Inter',system-ui,sans-serif;font-optical-sizing:auto;font-feature-settings:'tnum' 1,'cv11' 1,'ss03' 1;font-size:15px;line-height:1.6;-webkit-font-smoothing:antialiased}
a{color:inherit;text-underline-offset:3px;text-decoration-thickness:1px}
.mast{display:flex;justify-content:space-between;align-items:baseline;gap:18px;flex-wrap:wrap;padding:26px var(--pad);border-bottom:1px solid var(--hair)}
.mark{font-size:13px;font-weight:520;text-decoration:none}
.mast nav{display:flex;gap:22px;font-size:13px}
.mast nav a{text-decoration:none;color:var(--ink-2)}
.mast nav a:hover,.mast nav a[aria-current]{color:var(--ink);text-decoration:underline}
main{padding:9vh var(--pad) 14vh;max-width:56rem}
h1{font-size:clamp(38px,5.2vw,68px);font-weight:260;letter-spacing:-0.035em;line-height:1;margin:0 0 18px}
.lede{font-size:17px;max-width:34rem;color:var(--ink);margin:0}
section{margin-top:72px}
h2{font-size:22px;font-weight:420;letter-spacing:-0.012em;line-height:1.25;margin:0 0 14px}
h3{font-size:14px;font-weight:520;margin:28px 0 8px}
p{margin:0 0 10px;color:var(--ink-2);max-width:38rem}
.sub{font-size:13px;color:var(--ink-3)}
.head{display:grid;grid-template-columns:repeat(auto-fit,minmax(12rem,1fr));gap:24px;margin:8px 0 26px}
.head .num{font-size:clamp(34px,4.4vw,56px);font-weight:200;letter-spacing:-0.035em;line-height:1}
.head .lbl{font-size:12px;color:var(--ink-2);margin-top:8px}
dl.kv{margin:0;border-top:1px solid var(--hair)}
dl.kv>div{display:grid;grid-template-columns:minmax(8rem,12rem) 1fr;gap:18px;padding:10px 0;border-bottom:1px solid var(--hair);font-size:13px}
dl.kv dt{font-weight:460}
dl.kv dd{margin:0;color:var(--ink-2);min-width:0}
.mono,code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:12px;word-break:break-all}
code{background:var(--glass);padding:1px 4px}
pre{background:var(--glass);padding:14px 16px;overflow-x:auto;font-size:12px;line-height:1.55;margin:10px 0 16px}
pre code{background:none;padding:0;word-break:normal;white-space:pre}
.wrap{overflow-x:auto;-webkit-overflow-scrolling:touch;margin:6px 0 10px}
table{border-collapse:collapse;width:100%;font-size:13px}
th{font-weight:460;text-align:left;color:var(--ink);padding:9px 14px 9px 0;border-bottom:1px solid var(--ink);white-space:nowrap}
td{padding:9px 14px 9px 0;border-bottom:1px solid var(--hair);color:var(--ink-2);vertical-align:top}
td.n{text-align:right;white-space:nowrap}
td .mono{word-break:normal;white-space:nowrap}
ol.steps{padding:0;margin:0;list-style:none;counter-reset:s;border-top:1px solid var(--hair)}
ol.steps>li{counter-increment:s;padding:14px 0 14px 34px;border-bottom:1px solid var(--hair);position:relative;color:var(--ink-2);font-size:14px}
ol.steps>li::before{content:counter(s);position:absolute;left:0;top:14px;font-weight:460;color:var(--ink)}
.empty{font-size:14px;color:var(--ink-2);border-top:1px solid var(--hair);border-bottom:1px solid var(--hair);padding:16px 0;margin:6px 0}
.coin{display:flex;flex-wrap:wrap;gap:10px 22px;align-items:baseline;border-top:1px solid var(--ink);border-bottom:1px solid var(--hair);padding:14px 0}
.coin .mono{font-size:13px;color:var(--ink)}
.coin a{font-size:13px}
.buy{display:inline-block;background:#000;color:#fff;text-decoration:none;padding:9px 18px;font-size:13px;font-weight:500}
.buy:hover{background:#2a2c2f}
footer{padding:28px var(--pad);border-top:1px solid var(--hair);font-size:12px;color:var(--ink-3)}
@media (max-width:560px){dl.kv>div{grid-template-columns:1fr;gap:2px}main{padding-top:6vh}section{margin-top:56px}}
`;

function shell({ cfg, page, title, desc, body }) {
  const name = cfg?.projectName || 'Halcyra Neuro';
  const pub = String(cfg?.publicUrl || '').replace(/\/$/, '');
  const x = cfg?.xUrl || '';
  const nav = [
    `<a href="/proof"${page === 'proof' ? ' aria-current="page"' : ''}>Proof</a>`,
    `<a href="/whitepaper"${page === 'whitepaper' ? ' aria-current="page"' : ''}>Whitepaper</a>`,
    x ? ext(x, 'X') : '',
  ].join('');
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)} · ${esc(name)}</title>
<meta name="description" content="${esc(desc)}">
${pub ? `<link rel="canonical" href="${esc(`${pub}/${page}`)}">` : ''}
<meta name="theme-color" content="#ffffff">
<link rel="preload" href="/home/fonts/inter-latin-opsz-normal.woff2" as="font" type="font/woff2" crossorigin>
<style>${CSS}</style>
</head>
<body>
<header class="mast"><a class="mark" href="/">${esc(name)}</a><nav>${nav}</nav></header>
<main>
${body}
</main>
<footer>${esc(name)}</footer>
</body>
</html>`;
}

function coinBlock(cfg) {
  const ca = cfg?.tokenCa;
  if (!ca) return '';
  const tk = cfg.ticker ? `$${esc(cfg.ticker)}` : 'the coin';
  return `<div class="coin"><span class="mono">${esc(ca)}</span>${ext(solscanAcc(ca), 'Solscan')}${ext(pumpCoin(ca), `Buy ${tk}`, 'buy')}</div>`;
}

// ---------------------------------------------------------------- ladder (read defensively: another agent owns it)
function ladderView(cfg, hub) {
  const L = hub?.ladder || null;
  const j = L ? safe(() => L.json(), null) : null;
  let stages = Array.isArray(j?.stages) ? j.stages : null;
  if (!stages) stages = safe(() => parseStages(cfg?.ladder?.stages || ''), []).map((s, i) => ({ ...s, unlocked: i === 0 }));
  const unlocks = Array.isArray(L?.unlocks) ? L.unlocks : [];
  return {
    stages,
    unlocks,
    playing: j?.playing || null,
    unlocked: j?.unlocked || null,
    mcap: j?.marketCap && Number.isFinite(Number(j.marketCap.usd)) && j.marketCap.usd != null ? j.marketCap : null,
    reads: Number(L?.need ?? j?.reads?.need ?? cfg?.ladder?.reads ?? 3),
    everyMs: Number(L?.pollMs ?? j?.reads?.everyMs ?? cfg?.ladder?.pollMs ?? 20000),
  };
}

// ---------------------------------------------------------------- /proof
export async function renderProof({ cfg, hub, ledger }) {
  const head = safe(() => ledger.head(), { step: -1, hash: '0'.repeat(64), at: null, ticks: 0 });
  const total = Number(head.ticks || 0);
  let recent = [];
  if (total > 0 && ledger?.ticks) recent = await ledger.ticks(Math.max(-1, head.step - 10), 10).catch(() => []);
  recent = recent.slice(-10).reverse();
  const top = recent[0] && recent[0].step === head.step ? recent[0] : null;
  let cps = [];
  if (ledger?.checkpoints) {
    const span = (ledger.bucketTicks || cfg?.ledger?.bucketTicks || 300) * 6;
    cps = await ledger.checkpoints(Math.max(-1, head.step - span), 500).catch(() => []);
    cps = (Array.isArray(cps) ? cps : []).slice(-5).reverse();
  }
  const f = await facts().catch(() => null);
  const sweetN = f?.taste?.sweet ?? hub?.proof?.taste?.sweet?.count ?? null;
  const bitterN = f?.taste?.bitter ?? hub?.proof?.taste?.bitter?.count ?? null;
  const dp = cfg?.ledger?.decimals ?? 4;

  // ---- ledger
  const headHtml = total > 0 ? `
<div class="head">
  <div><div class="num">${fmt(head.step)}</div><div class="lbl">Latest step</div></div>
  <div><div class="num">${fmt(total)}</div><div class="lbl">Records in the chain</div></div>
</div>
<dl class="kv">
  <div><dt>Hash</dt><dd class="mono">${esc(head.hash)}</dd></div>
  <div><dt>Previous hash</dt><dd class="mono">${esc(top?.prevHash || '')}</dd></div>
  <div><dt>Time</dt><dd>${esc(when(top?.t || head.at))}</dd></div>
</dl>` : `<p class="empty">The chain is empty. Her first look writes step 0, linked to a start hash of 64 zeros, and every look after it adds one record here.</p>`;

  const recRows = recent.map((r) => `<tr><td class="n">${fmt(r.step)}</td><td>${esc(r.kind === 'unlock' ? `Unlock, ${r.stage?.game || ''}` : 'Look')}</td><td>${esc(when(r.t))}</td><td><span class="mono" title="${esc(r.hash)}">${esc(short(r.hash, 12, 8))}</span></td><td><span class="mono" title="${esc(r.prevHash)}">${esc(short(r.prevHash, 12, 8))}</span></td></tr>`).join('');
  const recHtml = recent.length ? `<h3>Last ${recent.length} records</h3><div class="wrap"><table><thead><tr><th>Step</th><th>Record</th><th>Time</th><th>Hash</th><th>Previous hash</th></tr></thead><tbody>${recRows}</tbody></table></div>` : '';

  const cpHtml = cps.length ? `<h3>Checkpoints</h3><p class="sub">One per stored block of records, kept for good, each linked to the one before it.</p><div class="wrap"><table><thead><tr><th>Steps</th><th>Records</th><th>Starts from</th><th>Ends at</th></tr></thead><tbody>${cps.map((c) => `<tr><td class="n">${fmt(c.from)} to ${fmt(c.to)}</td><td class="n">${fmt(c.n)}</td><td><span class="mono" title="${esc(c.prevHash)}">${esc(short(c.prevHash, 12, 8))}</span></td><td><span class="mono" title="${esc(c.head)}">${esc(short(c.head, 12, 8))}</span></td></tr>`).join('')}</tbody></table></div>` : '';

  // ---- how to check
  const check = `
<ol class="steps">
  <li>Get the records, oldest first, a thousand at a time: <code>/api/ticks?after=-1&amp;limit=1000</code>, then <code>after=</code> the last step you got. One record by step: <code>/api/ticks/:step</code>.</li>
  <li>For each record, drop the keys <code>hash</code>, <code>prevHash</code> and <code>lit</code>. Write the rest as JSON with the keys sorted at every level and no spaces. Take sha256 of the previous hash (64 hex characters) followed by that JSON. It must equal the record's <code>hash</code>, and the next record's <code>prevHash</code>. Step 0 starts from 64 zeros.</li>
  <li>The last hash you compute must equal the head in <code>/api/proof</code> (<code>chain.head.hash</code>). Checkpoints for older stretches are at <code>/api/checkpoints</code>.</li>
</ol>
<pre><code>hash = sha256(prevHash + canonicalJSON(record without hash, prevHash, lit))
canonicalJSON: keys sorted at every level, undefined dropped, NaN and Infinity as null
numbers that are not whole are stored rounded to ${dp} decimals, so the served record hashes as is</code></pre>`;

  // ---- trades
  const trades = Array.isArray(hub?.trades) ? hub.trades.filter((t) => t && (t.side === 'buy' || t.side === 'sell')).slice(0, 10) : [];
  const stepOf = new Map();
  if (trades.length && Array.isArray(ledger?.ring)) {
    const want = new Set(trades.map((t) => t.sig));
    for (let i = ledger.ring.length - 1; i >= 0 && want.size; i -= 1) {
      const ap = ledger.ring[i]?.taste?.applied;
      if (Array.isArray(ap)) for (const a of ap) if (want.has(a.sig)) { stepOf.set(a.sig, ledger.ring[i].step); want.delete(a.sig); }
    }
  }
  const cells = (side) => (side === 'buy' ? `${sweetN != null ? fmt(sweetN) : ''} sugar cells` : `${bitterN != null ? fmt(bitterN) : ''} bitter cells`).trim();
  const tradeHtml = trades.length ? `<div class="wrap"><table><thead><tr><th>Time</th><th>Side</th><th>SOL</th><th>Fired</th><th>Step</th><th>Transaction</th><th>Wallet</th></tr></thead><tbody>${trades.map((t) => `<tr><td>${esc(when(t.ts))}</td><td>${t.side === 'buy' ? 'Buy' : 'Sell'}</td><td class="n">${esc(solAmt(t.sol))}</td><td>${esc(cells(t.side))}</td><td class="n">${stepOf.has(t.sig) ? fmt(stepOf.get(t.sig)) : ''}</td><td>${ext(solscanTx(t.sig), `<span class="mono">${esc(short(t.sig, 8, 6))}</span>`)}</td><td>${t.wallet ? ext(solscanAcc(t.wallet), `<span class="mono">${esc(short(t.wallet, 4, 4))}</span>`) : ''}</td></tr>`).join('')}</tbody></table></div>`
    : `<p class="empty">${cfg?.tokenCa ? 'The first buy or sell of the coin appears here' : 'Once the coin is live, every buy and sell appears here'} with its transaction, wallet, size in SOL, the cells it fired and the step it reached her.</p>`;

  // ---- ladder
  const lv = ladderView(cfg, hub);
  const unlockOf = (id) => lv.unlocks.find((u) => u.stageId === id) || null;
  const stageRows = lv.stages.map((s) => {
    const u = unlockOf(s.id);
    const state = s.unlocked ? (u ? `Unlocked ${esc(when(u.at))}` : (Number(s.usd) === 0 ? 'Open from the start' : 'Unlocked')) : 'Locked';
    const here = lv.playing && lv.playing.id === s.id ? ', on screen now' : '';
    return `<tr><td>${esc(s.game)}</td><td class="n">${Number(s.usd) === 0 ? 'Start' : esc(usd(s.usd))}</td><td>${state}${here}</td><td class="n">${u?.ledgerStep != null ? fmt(u.ledgerStep) : (s.ledgerStep != null ? fmt(s.ledgerStep) : '')}</td></tr>`;
  }).join('');
  const unlockDetail = lv.unlocks.filter((u) => Array.isArray(u.readings) && u.readings.length).map((u) => `
<h3>${esc(u.game)} unlock${u.ledgerStep != null ? `, step ${fmt(u.ledgerStep)}` : ''}</h3>
${u.ledgerHash ? `<p class="sub">Record hash <span class="mono">${esc(u.ledgerHash)}</span></p>` : ''}
<div class="wrap"><table><thead><tr><th>Reading</th><th>Time</th><th>Slot</th><th>Market cap</th></tr></thead><tbody>${u.readings.map((r, i) => `<tr><td class="n">${i + 1}</td><td>${esc(when(r.at))}</td><td class="n">${r.slot != null ? fmt(r.slot) : ''}</td><td class="n">${r.mcapUsd != null ? esc(usd(r.mcapUsd)) : ''}</td></tr>`).join('')}</tbody></table></div>`).join('');
  const nowLine = [
    lv.playing ? `On screen now: <strong>${esc(lv.playing.game)}</strong>.` : '',
    lv.mcap ? `Market cap at the last reading: <strong>${esc(usd(lv.mcap.usd))}</strong>${lv.mcap.at ? `, ${esc(when(lv.mcap.at))}` : ''}.` : '',
  ].filter(Boolean).join(' ');
  const ladderHtml = `
<p>A stage opens when the market cap is at or above its mark on ${fmt(lv.reads)} readings in a row, one every ${fmt(Math.round(lv.everyMs / 1000))} s. Each unlock is written into the chain with its readings and stays open for good.</p>
${nowLine ? `<p>${nowLine}</p>` : ''}
<div class="wrap"><table><thead><tr><th>Game</th><th>Market cap</th><th>State</th><th>Step</th></tr></thead><tbody>${stageRows}</tbody></table></div>
${unlockDetail || ''}`;

  const coin = cfg?.tokenCa ? `<section id="coin"><h2>The coin</h2>${coinBlock(cfg)}</section>` : '';

  const body = `
<h1>Proof</h1>
<p class="lede">Every look she takes is one record, chained by hash to the one before it. Every trade she tastes is on Solana.</p>
${coin}
<section id="ledger"><h2>The ledger</h2>${headHtml}${recHtml}${cpHtml}</section>
<section id="check"><h2>Check it yourself</h2>${check}</section>
<section id="trades"><h2>Trades she tasted</h2><p>A buy drives her sugar cells, a sell her bitter cells.</p>${tradeHtml}</section>
<section id="ladder"><h2>The ladder</h2>${ladderHtml}</section>`;
  return shell({ cfg, page: 'proof', title: 'Proof', desc: 'The ledger of every brain step, the trades she tasted and the game ladder, live.', body });
}

// ---------------------------------------------------------------- /whitepaper
export async function renderWhitepaper({ cfg, hub }) {
  const f = await facts();
  const m = f.meta || {};
  const b = f.brain;
  const g = GAMEBODY_DEFAULTS;
  const t = TASTE_DEFAULTS;
  const brainMs = Number(cfg?.loop?.brainMs ?? 70);
  const dp = cfg?.ledger?.decimals ?? 4;
  const lookEvery = Math.max(1, Math.round(4 / b.dt));
  const steps = Math.max(1, Math.round(brainMs / b.dt));
  const lamTotal = f.lamLeft + f.lamRight;
  const lv = ladderView(cfg, hub);
  const sweetN = f.taste?.sweet; const bitterN = f.taste?.bitter;
  const sweetTypes = f.taste ? Object.keys(f.taste.sweetTypes).map((k) => k.split('|')[0]).filter((v, i, a) => a.indexOf(v) === i).join(', ') : '';
  const bitterTypes = f.taste ? Object.keys(f.taste.bitterTypes).map((k) => k.split('|')[0]).filter((v, i, a) => a.indexOf(v) === i).join(', ') : '';
  const rt = f.readouts?.types || {};
  const dnN = f.readouts ? f.readouts.descending.left + f.readouts.descending.right : null;
  const cellsOf = (k) => (rt[k] != null ? ` (${fmt(rt[k])} cells)` : '');

  const what = `
<p>She is the female adult fruit fly brain mapped by FlyWire, dataset ${esc(m.dataset)}: ${fmt(m.neurons)} neurons and ${fmt(m.connections)} connections carrying ${fmt(m.synapses)} synapses (pairs with at least ${fmt(m.minSynapses)} synapses). ${fmt(m.inhibitory)} cells are inhibitory. The wiring is used as mapped. The one change is the sign of her ${fmt(m.photoreceptors)} photoreceptors, set inhibitory because they are histaminergic.</p>
<p>She runs on a graded rate model in steps of ${fmt(b.dt)} ms, with three fitted global gains and nothing fitted per cell. Each look she lives ${fmt(brainMs)} ms of brain time, ${fmt(steps)} steps.</p>
<pre><code>tau dV/dt = −V + Gc · Σ sign · synapses · a / (synapses in) + input − Ga · w
a = clamp((V − theta) / beta, 0, 1)
tauA dw/dt = a − w</code></pre>`;

  const sees = `
<p>The game picture is shrunk to a ${fmt(GRID_W)} by ${fmt(GRID_H)} grid of brightness and laid across her lamina cells L1 to L5: ${fmt(lamTotal)} cells, ${fmt(f.lamLeft)} in the left eye and ${fmt(f.lamRight)} in the right. Each cell sits on the picture where its body sits on her retina. The left eye covers the left of the screen, the right eye the right, and both share the middle ${fmt(Math.round(g.binoc * 100))}%.</p>
<p>A lamina cell is driven hardest where its spot is darker than its surround and darker than a moment ago, as a fly's lamina is:</p>
<pre><code>drive = rTonic + (rLamina − rTonic) · min(1, kSpatial · max(0, surround − spot) + kTemporal · max(0, before − spot))
rTonic ${g.rTonic}, rLamina ${g.rLamina}, kSpatial ${g.kSpatial}, kTemporal ${g.kTemporal}, surround = blur over ${g.blurSigma} grid cells</code></pre>
<p>She takes the picture in again every ${fmt(lookEvery * b.dt)} ms of brain time, and her gaze jitters by ${g.saccAmp} of the screen width each time.</p>`;

  const tastes = `
<p>A buy drives her ${sweetN != null ? fmt(sweetN) : ''} sugar sensing cells${sweetTypes ? ` (type ${esc(sweetTypes)})` : ''}. A sell drives her ${bitterN != null ? fmt(bitterN) : ''} bitter sensing cells${bitterTypes ? ` (types ${esc(bitterTypes)})` : ''}. These are the labellar taste cells published by Shiu et al. 2024 (Nature 634:210), matched to ${esc(m.dataset)} by FlyWire root ID.</p>
<p>The size of a trade sets how strong the taste is, on a log scale:</p>
<pre><code>level(sol) = ${t.floor} + (1 − ${t.floor}) · clamp(log(sol / ${t.minSol}) / log(${t.maxSol} / ${t.minSol}), 0, 1)</code></pre>
<p>A trade of ${t.minSol} SOL or less tastes at ${t.floor}; ${t.maxSol} SOL or more tastes at 1. Each taste halves every ${fmt(t.halfLifeMs / 1000)} s. Buys add up on the sugar side and sells on the bitter side, each capped at 1. A taste below ${t.dropBelow} is dropped. Each sugar cell is driven at sugar level × ${g.kSweet}, each bitter cell at bitter level × ${g.kBitter}, on every look. The levels are rounded to ${dp} decimals and stored in the record of the look that used them.</p>`;

  const mapRows = PAD_MAPPING.map((r) => `<tr><td>${esc(r.control)}</td><td>${esc(r.cells)}</td><td><code>${math(r.fn)}</code></td></tr>`).join('');
  const plays = `
<p>She plays through a virtual gamepad. Every value on it is a fixed function of her descending neurons, averaged over the look. Which cell drives which control is our choice of mapping; what the cells do is her own wiring.</p>
<p>L and R are the mean activity of all ${dnN != null ? fmt(dnN) : ''} descending cells on her left and right side. DNp09${cellsOf('DNp09')}, MDN${cellsOf('MDN')}, oviDNb${cellsOf('oviDNb')} and DNp01${cellsOf('DNp01')} are read by cell type.</p>
<div class="wrap"><table><thead><tr><th>Control</th><th>Cells</th><th>Rule</th></tr></thead><tbody>${mapRows}</tbody></table></div>
<p class="sub">kTurn ${g.kTurn}, kFwd ${g.kFwd}, hzStop ${g.hzStop}, kBack ${g.kBack}, hzLay ${g.hzLay} held ${fmt(g.layMs)} ms then ${fmt(g.refractoryMs)} ms rest, hzEscape ${g.hzEscape}. Enter or leave a vehicle is button ${esc(String(g.commitButton).toUpperCase())}, handbrake is ${esc(String(g.escapeButton).toUpperCase())}.</p>`;

  const stageList = lv.stages.map((s) => `<tr><td>${esc(s.game)}</td><td class="n">${Number(s.usd) === 0 ? 'Start' : esc(usd(s.usd))}</td></tr>`).join('');
  const ladder = `
<p>She starts on ${esc(lv.stages[0]?.game || '')} and moves up as the coin's market cap in USD grows. A stage opens when the market cap is at or above its mark on ${fmt(lv.reads)} readings in a row, about ${fmt(Math.round(lv.everyMs / 1000))} s apart, each at a newer Solana slot. A failed reading starts the count again. Market cap is the coin's price in SOL, from the bonding curve or the PumpSwap pool, times its supply, times SOL in USD from the Pyth SOL/USD account, all read on chain in one call. An unlock is permanent and is written into the ledger with its readings and slots.</p>
<div class="wrap"><table><thead><tr><th>Game</th><th>Market cap</th></tr></thead><tbody>${stageList}</tbody></table></div>`;

  const ledgerTxt = `
<p>Every look is one record. It holds the step number, the time, the brain time lived, the taste going in with every trade first tasted on that look (signature, side, SOL, wallet, level), how many cells were driven (lamina, sugar, bitter), the descending readouts, how many cells were active, and the full gamepad state. Each unlock is a record too.</p>
<pre><code>hash = sha256(prevHash + canonicalJSON(record without hash, prevHash, lit))</code></pre>
<p>canonicalJSON sorts keys at every level and leaves out keys with no value, with no spaces. Numbers that are not whole are rounded to ${dp} decimals before hashing, and that rounded record is what is stored and served. Step 0 links to 64 zeros.${cfg?.mongo?.uri ? ` Records are stored in blocks of ${fmt(cfg?.ledger?.bucketTicks ?? 300)}, each with a checkpoint that is kept for good.` : ''} The <a href="/proof">proof page</a> shows the head and how to check it.</p>`;

  const rules = [
    ['Dataset', esc(m.dataset)], ['Neurons', fmt(m.neurons)], ['Connections', fmt(m.connections)], ['Synapses', fmt(m.synapses)],
    ['Least synapses per connection', fmt(m.minSynapses)], ['Inhibitory cells', fmt(m.inhibitory)],
    ['Model step', `${fmt(b.dt)} ms`], ['Brain time per look', `${fmt(brainMs)} ms`],
    ['Gains Gc, tau, theta, beta', `${b.Gc}, ${b.tau} ms, ${b.theta}, ${b.beta}`], ['Adaptation Ga, tauA', `${b.Ga}, ${b.tauA} ms`], ['Noise, senseIn', `${b.noise}, ${b.senseIn}`],
    ['Picture grid', `${fmt(GRID_W)} × ${fmt(GRID_H)}`], ['Lamina cells (L1 to L5)', `${fmt(lamTotal)} (left ${fmt(f.lamLeft)}, right ${fmt(f.lamRight)})`],
    ['Shared field of both eyes', `${Math.round(g.binoc * 100)}%`], ['rTonic, rLamina', `${g.rTonic}, ${g.rLamina}`], ['kSpatial, kTemporal', `${g.kSpatial}, ${g.kTemporal}`], ['Surround blur', `${g.blurSigma} grid cells`],
    ['Sugar cells (buys)', sweetN != null ? fmt(sweetN) : ''], ['Bitter cells (sells)', bitterN != null ? fmt(bitterN) : ''],
    ['Taste floor, at SOL', `${t.floor}, ${t.minSol} SOL or less`], ['Full taste at', `${t.maxSol} SOL or more`], ['Taste half life', `${fmt(t.halfLifeMs / 1000)} s`], ['Taste cap per side', '1'], ['Taste drive gain sugar, bitter', `${g.kSweet}, ${g.kBitter}`],
    ['Descending cells (L, R)', f.readouts ? `${fmt(f.readouts.descending.left)}, ${fmt(f.readouts.descending.right)}` : ''],
    ['Steer full lock at R − L', `${g.kTurn}`], ['Full gas at mean descending activity', `${g.kFwd}`], ['DNp09 that halves gas', `${g.hzStop}`], ['Full brake at MDN', `${g.kBack}`],
    ['Vehicle enter or exit, oviDNb', `${g.hzLay} held ${fmt(g.layMs)} ms, then ${fmt(g.refractoryMs)} ms rest`], ['Handbrake, DNp01', `${g.hzEscape}`],
    ...lv.stages.map((s, i) => [`Stage ${i + 1}, ${esc(s.game)}`, Number(s.usd) === 0 ? 'from the start' : `${esc(usd(s.usd))} market cap`]),
    ['Readings to unlock', `${fmt(lv.reads)} in a row, ${fmt(Math.round(lv.everyMs / 1000))} s apart`],
    ['Ledger rounding', `${dp} decimals`], ['Ledger start hash', '64 zeros'], ...(cfg?.mongo?.uri ? [['Records per stored block', fmt(cfg?.ledger?.bucketTicks ?? 300)]] : []),
  ].filter((r) => r[1] !== '');
  const table = `<div class="wrap"><table><thead><tr><th>Rule</th><th>Value</th></tr></thead><tbody>${rules.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('')}</tbody></table></div>`;

  const body = `
<h1>Whitepaper</h1>
<p class="lede">A fruit fly brain, mapped cell by cell, plays GTA live. Her eyes get the game, her tongue gets the trades of one coin, her descending neurons hold the controller.</p>
${coinBlock(cfg)}
<section id="what"><h2>What she is</h2>${what}</section>
<section id="sight"><h2>How she sees</h2>${sees}</section>
<section id="taste"><h2>How trades reach her</h2>${tastes}</section>
<section id="control"><h2>How she controls the game</h2>${plays}</section>
<section id="ladder"><h2>The ladder</h2>${ladder}</section>
<section id="ledger"><h2>The ledger</h2>${ledgerTxt}</section>
<section id="rules"><h2>Rules table</h2>${table}</section>`;
  return shell({ cfg, page: 'whitepaper', title: 'Whitepaper', desc: `How a ${fmt(m.neurons)} neuron fruit fly brain plays GTA, tastes trades and writes every step to a public ledger.`, body });
}

// ---------------------------------------------------------------- mounting
const HEADERS = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store, max-age=0', pragma: 'no-cache', 'x-content-type-options': 'nosniff' };

async function answer(res, render, deps, head = false) {
  try {
    const html = await render(deps);
    res.writeHead(200, { ...HEADERS, 'content-length': Buffer.byteLength(html) });
    res.end(head ? undefined : html);
  } catch (e) {
    const msg = '<!doctype html><title>Proof</title><p>This page could not be built right now. Refresh in a moment.</p>';
    try { res.writeHead(500, HEADERS); res.end(msg); } catch { /* sent */ }
    void e;
  }
}

/** for the plain node http server: -> async (req, res, pathname) => boolean */
export function docsRoute(deps) {
  return async (req, res, pathname) => {
    const p = String(pathname || '').replace(/\/+$/, '') || '/';
    const head = req.method === 'HEAD';
    if (p === '/proof') { await answer(res, renderProof, deps, head); return true; }
    if (p === '/whitepaper') { await answer(res, renderWhitepaper, deps, head); return true; }
    return false;
  };
}

/** for an Express style app (anything with .get(path, handler)) */
export function mountDocs(app, deps) {
  app.get('/proof', (req, res) => answer(res, renderProof, deps, req.method === 'HEAD'));
  app.get('/whitepaper', (req, res) => answer(res, renderWhitepaper, deps, req.method === 'HEAD'));
  facts().catch(() => {}); // warm the cell counts
  return app;
}
