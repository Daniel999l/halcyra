// Solana JSON-RPC over plain fetch, gentle on the public endpoint.
// Calls go out one at a time with a small gap; 429 and network errors back off and retry.
// RPC_URL env overrides the public mainnet endpoint.

export const DEFAULT_RPC = 'https://api.mainnet-beta.solana.com';
export function rpcUrl() {
  const v = String(process.env.RPC_URL || '').trim();
  return v || DEFAULT_RPC;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const GAP_MS = Math.max(0, Number(process.env.RPC_GAP_MS || 120));

let chain = Promise.resolve();
let lastAt = 0;
let idSeq = 1;
// adaptive pacing: every 429 widens the gap between calls, every success narrows it back.
// The public endpoint sustains roughly one getTransaction per second from one IP (measured 2026-11-17).
let gap = GAP_MS;
export const rpcStats = { calls: 0, r429: 0, retries: 0, errors: 0, gapMs: () => Math.round(gap) };

export class RpcError extends Error {
  constructor(message, code) { super(message); this.name = 'RpcError'; this.code = code; }
}

async function once(method, params, timeoutMs) {
  const wait = lastAt + gap - Date.now();
  if (wait > 0) await sleep(wait);
  lastAt = Date.now();
  const r = await fetch(rpcUrl(), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: idSeq++, method, params }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  rpcStats.calls += 1;
  if (r.status === 429) { rpcStats.r429 += 1; gap = Math.min(1500, gap * 1.3 + 100); throw new RpcError('429 Too Many Requests', 429); }
  if (r.status >= 500) throw new RpcError(`http ${r.status}`, r.status);
  const j = await r.json();
  if (j.error) {
    if (j.error.code === 429) { rpcStats.r429 += 1; gap = Math.min(1500, gap * 1.3 + 100); }
    throw new RpcError(j.error.message || JSON.stringify(j.error), j.error.code);
  }
  gap = Math.max(GAP_MS, gap * 0.9);
  return j.result;
}

const retryable = (e) => e?.code === 429 || (typeof e?.code === 'number' && e.code >= 500 && e.code < 600)
  || e?.code === -32005 || e?.code === -32004 || e?.code === -32014
  || e?.name === 'TimeoutError' || e?.name === 'AbortError' || e?.name === 'TypeError';

/** rpc('getSlot', [...]) -> result. Serialised, retried with backoff on 429 / 5xx / network errors. */
export function rpc(method, params = [], { tries = 6, timeoutMs = 15000 } = {}) {
  const run = async () => {
    let err;
    for (let i = 0; i < tries; i += 1) {
      try { return await once(method, params, timeoutMs); } catch (e) {
        err = e;
        if (!retryable(e)) { rpcStats.errors += 1; throw e; }
        rpcStats.retries += 1;
        await sleep(Math.min(10000, 1000 * 1.7 ** i));
      }
    }
    throw err;
  };
  const p = chain.then(run, run);
  chain = p.catch(() => {});
  return p;
}
