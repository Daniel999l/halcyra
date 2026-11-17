/**
 * /proof and /whitepaper (src/docs-pages.js), fetched over real HTTP:
 *   1. mountDocs on an Express style app (a minimal .get() router over node:http)
 *      with an EMPTY state: no coin, no ticks, no trades, no ladder object
 *   2. docsRoute on a plain node http server with a POPULATED state: fixture
 *      ticks in a real Ledger, fixture trades, a real Ladder that unlocked GTA 2
 * Checks: 200, no-store, canonical, values in the raw HTML, links, banned words,
 * no ".html" links, and that a populated ledger still verifies.
 */
import http from 'node:http';
import { mountDocs, docsRoute } from '../src/docs-pages.js';
import { Ledger, verify } from '../src/ledger.js';
import { Ladder } from '../src/ladder.js';

const R = [];
const ok = (cond, name, extra = '') => { R.push(Boolean(cond)); console.log(`  ${cond ? 'ok  ' : 'FAIL'} ${name}${extra && !cond ? `  (${extra})` : ''}`); };

const baseCfg = (over = {}) => ({
  projectName: 'Halcyra Neuro', ticker: '', publicUrl: 'https://halcyra.example', xUrl: 'https://x.com/halcyratest', game: 'GTA 1',
  tokenCa: '', root: process.cwd(), gamesDir: '/nonexistent-games',
  ledger: { decimals: 4, bucketTicks: 300 }, loop: { brainMs: 70 }, ladder: { stages: '', pollMs: 20000, reads: 3 }, mongo: { uri: '' },
  ...over,
});

/** a minimal Express style app: .get(path, handler) and a node http listener */
function miniExpress() {
  const routes = new Map();
  const app = { get: (p, h) => routes.set(p, h) };
  const server = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname.replace(/\/+$/, '') || '/';
    const h = routes.get(p);
    if (!h) { res.writeHead(404); return res.end('nope'); }
    return h(req, res);
  });
  return { app, server };
}
const listen = (s) => new Promise((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${s.address().port}`)));

/** visible text: no style, no tags, entities decoded */
const visible = (html) => html.replace(/<style>[\s\S]*?<\/style>/g, ' ').replace(/<head>[\s\S]*?<\/head>/, ' ').replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ');

const BANNED = [
  [/loading/i, 'loading'], [/coming soon/i, 'coming soon'], [/\bsoon\b/i, 'soon'], [/\bTBA\b/, 'TBA'], [/not deployed/i, 'not deployed'],
  [/\bserver\b/i, 'server'], [/indexer/i, 'indexer'], [/backend/i, 'backend'], [/\bAPI\b/, 'API'], [/not audited/i, 'not audited'], [/not tested/i, 'not tested'],
  [/untested/i, 'untested'], [/financial advice/i, 'financial advice'], [/\bfees?\b/i, 'fee'], [/—|–/, 'em or en dash'], [/ - /, 'spaced hyphen'], [/\/\//, '//'],
  [/TOKEN_CA/, 'env name'], [/\bTICKER\b/, 'TICKER placeholder'], [/undefined|NaN|null\b|\[object/, 'broken value'],
];
const EMOJI = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;

function common(label, html, res, page, cfg) {
  ok(res.status === 200, `${label}: 200`);
  ok(/no-store/.test(res.headers.get('cache-control') || ''), `${label}: cache-control no-store`, res.headers.get('cache-control'));
  ok(/text\/html/.test(res.headers.get('content-type') || ''), `${label}: html`);
  ok(html.includes(`<link rel="canonical" href="${cfg.publicUrl}/${page}">`), `${label}: canonical from publicUrl`);
  ok(html.includes('<a class="mark" href="/">Halcyra Neuro</a>'), `${label}: name links home`);
  ok(html.includes('href="/proof"') && html.includes('href="/whitepaper"') && html.includes(`href="${cfg.xUrl}"`), `${label}: header links to proof, whitepaper, X`);
  ok(html.includes('name="viewport"') && html.includes('@media (max-width:560px)'), `${label}: phone viewport`);
  ok(!/href="[^"]*\.html?"/i.test(html), `${label}: no .html links`);
  ok(html.includes('/home/fonts/inter-latin-opsz-normal.woff2'), `${label}: Inter from the home fonts`);
  ok(!/<script/i.test(html), `${label}: no client script needed`);
  const text = visible(html);
  const prose = visible(html.replace(/<pre>[\s\S]*?<\/pre>/g, ' '));
  for (const [re, name] of BANNED) { const m = (name === 'broken value' ? prose : text).match(re); ok(!m, `${label}: no "${name}" in visible copy`, m && text.slice(Math.max(0, m.index - 50), m.index + 50)); }
  ok(!EMOJI.test(text), `${label}: no emoji`);
  return text;
}

const get = async (base, p) => { const r = await fetch(base + p); return { r, html: await r.text() }; };

// ------------------------------------------------------------------ 1. empty
console.log('docs-pages\n\n1. empty state, mountDocs on an Express style app');
{
  const cfg = baseCfg();
  const ledger = new Ledger({});
  const hub = { trades: [], ladder: null, proof: null };
  const { app, server } = miniExpress();
  mountDocs(app, { cfg, hub, ledger });
  const base = await listen(server);

  const { r, html } = await get(base, '/proof');
  const text = common('proof empty', html, r, 'proof', cfg);
  ok(/The chain is empty\. Her first look writes step 0/.test(text), 'proof empty: ledger empty state in plain words');
  ok(/every buy and sell appears here/.test(text), 'proof empty: trades empty state in plain words');
  ok(!html.includes('pump.fun') && !html.includes('class="coin"'), 'proof empty: no coin box without a coin address');
  ok(/GTA 1.*Open from the start.*GTA 2.*\$30,000.*Locked.*GTA III.*\$100,000.*Locked/.test(text), 'proof empty: ladder stages and USD thresholds');
  ok(text.includes('/api/ticks?after=-1&limit=1000') && text.includes('/api/ticks/:step') && text.includes('/api/proof'), 'proof empty: real endpoints in the steps');
  ok(text.includes('hash = sha256(prevHash + canonicalJSON(record without hash, prevHash, lit))') && text.includes('rounded to 4 decimals'), 'proof empty: exact hash rule');

  const w = await get(base, '/whitepaper');
  const wt = common('whitepaper', w.html, w.r, 'whitepaper', cfg);
  ok(wt.includes('139,255 neurons') && wt.includes('2,700,513 connections') && wt.includes('FlyWire FAFB v783'), 'whitepaper: counts from meta.json');
  ok(wt.includes('29 sugar sensing cells') && wt.includes('20 bitter sensing cells'), 'whitepaper: taste cell counts found in the data');
  ok(wt.includes('7,685 cells') && wt.includes('160 by 90'), 'whitepaper: lamina count and picture grid');
  ok(wt.includes('halves every 4 s') && wt.includes('level(sol) = 0.08 + (1 − 0.08) · clamp(log(sol / 0.01) / log(10 / 0.01), 0, 1)'), 'whitepaper: taste curve and half life from src/taste.js');
  ok(wt.includes('kTurn 0.3, kFwd 0.11, hzStop 0.35, kBack 0.11, hzLay 0.2 held 120 ms then 1,500 ms rest, hzEscape 0.2'), 'whitepaper: control thresholds from src/gamebody.js');
  ok(/3 readings in a row, about 20 s apart/.test(wt), 'whitepaper: ladder rule');
  ok(wt.includes('Rules table') && wt.includes('Gains Gc, tau, theta, beta 8, 30 ms, 0.12, 0.55'), 'whitepaper: rules table with the fitted gains');
  const trail = await get(base, '/proof/');
  ok(trail.r.status === 200, 'trailing slash works');
  const head = await fetch(`${base}/whitepaper`, { method: 'HEAD' }).catch(() => null);
  ok(!head || head.status === 404 || head.status === 200, 'HEAD does not crash');
  server.close();
}

// ------------------------------------------------------------------ 2. populated
console.log('\n2. populated state, docsRoute on a plain http server');
{
  const CA = 'Ha1cyraTestMint1111111111111111111111pump';
  const cfg = baseCfg({ tokenCa: CA, ticker: 'HALC' });
  const ledger = new Ledger({});
  const SIG1 = '5xBuySig' + 'a'.repeat(80); const SIG2 = '3ySellSig' + 'b'.repeat(79);
  const W1 = 'BuyWa11et1111111111111111111111111111111111'; const W2 = 'Se11Wa11et111111111111111111111111111111111';
  const base0 = Date.UTC(2026, 10, 17, 12, 0, 0);
  for (let i = 0; i < 25; i += 1) {
    const applied = i === 20 ? [{ sig: SIG1, side: 'buy', sol: 1.5, wallet: W1, level: 0.7 }] : i === 22 ? [{ sig: SIG2, side: 'sell', sol: 0.25, wallet: W2, level: 0.5 }] : [];
    ledger.append({ step: i + 1, t: base0 + i * 233, ms: 70, tasteAt: base0 + i * 233, taste: { sweet: i >= 20 ? 0.7 : 0, bitter: i >= 22 ? 0.5 : 0, applied }, drove: { lamina: 7685, sweet: i >= 20 ? 29 : 0, bitter: i >= 22 ? 20 : 0 }, dn: { L: 0.01 * i, R: 0.02 }, active: 1000 + i, pad: { axes: [0.1, 0, 0, 0], buttons: { rt: 0.3 } }, commit: false, escape: false, lit: [[1, 0.5]] });
  }
  // the ladder: three spaced readings over 10k unlock GTA 2 (a record in the same ledger)
  let clock = base0 + 10000;
  const ladder = new Ladder({ cfg, ledger, now: () => clock });
  for (const [k, mc] of [[0, 32000], [1, 33500.5], [2, 35000]]) {
    clock = base0 + 10000 + k * 20000;
    await ladder.observe({ ok: true, at: clock, slot: 380000000 + k * 50, mcapUsd: mc, venue: 'curve', priceSol: 0.0000001, solUsd: 140 });
  }
  ok(ladder.unlockedIndex === 1, 'fixture: the ladder unlocked GTA 2');
  const trades = [
    { sig: SIG2, side: 'sell', wallet: W2, sol: 0.25, ts: base0 + 5000, venue: 'curve' },
    { sig: SIG1, side: 'buy', wallet: W1, sol: 1.5, ts: base0 + 4000, venue: 'curve' },
  ];
  const hub = { trades, ladder, proof: null };
  const route = docsRoute({ cfg, hub, ledger });
  const server = http.createServer(async (req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    if (await route(req, res, p)) return;
    res.writeHead(404); res.end('nope');
  });
  const base = await listen(server);
  const head = ledger.head();
  ok(verify(await ledger.ticks(-1, 1000)).ok, 'fixture: the chain verifies');

  const { r, html } = await get(base, '/proof');
  const text = common('proof populated', html, r, 'proof', cfg);
  ok(text.includes(String(head.step)) && html.includes(head.hash), 'proof: latest step and full head hash');
  const lastRec = await ledger.tick(head.step);
  ok(html.includes(lastRec.prevHash), 'proof: previous hash of the head');
  ok(/Records in the chain/.test(text) && text.includes(String(head.ticks)), 'proof: total records');
  ok((html.match(/<tr><td class="n">\d+<\/td><td>(Look|Unlock)/g) || []).length === 10, 'proof: exactly the last 10 records');
  ok(text.includes('Unlock, GTA 2'), 'proof: the unlock record is listed');
  ok(html.includes(`href="https://solscan.io/tx/${SIG1}"`) && html.includes(`href="https://solscan.io/tx/${SIG2}"`), 'proof: transactions linked to solscan');
  ok(html.includes(`href="https://solscan.io/account/${W1}"`) && html.includes(`href="https://solscan.io/account/${W2}"`), 'proof: wallets linked to solscan');
  ok(/Buy 1\.50 29 sugar cells 20/.test(text) && /Sell 0\.250 20 bitter cells 22/.test(text), 'proof: side, SOL, cells fired, step reached', text.match(/Trades she tasted.{0,400}/)?.[0]);
  ok(html.includes(`href="https://pump.fun/coin/${CA}"`) && html.includes(`href="https://solscan.io/account/${CA}"`) && text.includes(CA), 'proof: coin address linked to solscan and pump.fun');
  ok(text.includes('Buy $HALC'), 'proof: buy button with the real ticker');
  ok(/GTA 2 \$30,000 Unlocked 17 Nov 2026/.test(text), 'proof: GTA 2 unlocked with its time');
  ok(/GTA 2 unlock, step \d+/.test(text) && text.includes('$32,000') && text.includes('$33,501') && text.includes('$35,000'), 'proof: the three readings');
  ok(text.includes('380,000,000') && text.includes('380,000,100'), 'proof: the reading slots');
  ok(html.includes(ladder.unlocks[0].ledgerHash), 'proof: unlock record hash');

  const w = await get(base, '/whitepaper');
  const wt = common('whitepaper with coin', w.html, w.r, 'whitepaper', cfg);
  ok(w.html.includes(`href="https://pump.fun/coin/${CA}"`), 'whitepaper: coin box when the address is set');
  ok(wt.includes('Stage 2, GTA 2 $30,000 market cap'), 'whitepaper: rules table lists the stages');
  const nf = await fetch(`${base}/proof.html`);
  ok(nf.status === 404, '/proof.html is not a page (clean URLs only)');
  server.close();
}

const pass = R.filter(Boolean).length;
console.log(`\n${pass}/${R.length} passed`);
process.exit(pass === R.length ? 0 : 1);
