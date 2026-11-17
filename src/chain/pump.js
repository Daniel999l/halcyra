// pump.fun constants, addresses and account layouts, with nothing but @solana/web3.js.
// Layouts checked against live mainnet accounts on 2026-11-17 (see docs/TASTE.md).
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
// CJS build: the ESM build of web3.js 1.x is fine too, CJS keeps one copy with other packages
export const web3 = require('@solana/web3.js');
const { PublicKey } = web3;

export const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';      // bonding curve program
export const PUMP_AMM = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';  // PumpSwap
export const WSOL = 'So11111111111111111111111111111111111111112';
export const TOKEN_2022 = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const METAPLEX = 'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s';
export const LAMPORTS = 1_000_000_000;
export const TOKEN_DECIMALS = 6;
export const CURVE_TOKENS_WHOLE = 793_100_000; // real token reserves a fresh curve starts with

/** valid base58 32-byte public key. Case-sensitive. */
export function isMint(s) {
  if (typeof s !== 'string' || s.length < 32 || s.length > 44 || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(s)) return false;
  try { return new PublicKey(s).toBase58() === s; } catch { return false; }
}

const pda = (seeds, program) => PublicKey.findProgramAddressSync(seeds, new PublicKey(program))[0].toBase58();

export function curvePda(mint) {
  return pda([Buffer.from('bonding-curve'), new PublicKey(mint).toBuffer()], PUMP);
}
/** the canonical PumpSwap pool a pump.fun coin migrates into (index 0, quote WSOL) */
export function poolPda(mint) {
  const m = new PublicKey(mint);
  const auth = PublicKey.findProgramAddressSync([Buffer.from('pool-authority'), m.toBuffer()], new PublicKey(PUMP))[0];
  return pda([Buffer.from('pool'), Buffer.alloc(2), auth.toBuffer(), m.toBuffer(), new PublicKey(WSOL).toBuffer()], PUMP_AMM);
}
export function metaplexPda(mint) {
  return pda([Buffer.from('metadata'), new PublicKey(METAPLEX).toBuffer(), new PublicKey(mint).toBuffer()], METAPLEX);
}

const key = (buf, off) => new PublicKey(buf.subarray(off, off + 32)).toBase58();

/** BondingCurve: disc(8) vToken vSol rToken rSol supply (u64 x5) complete(bool) creator(32) ... */
export function decodeCurve(buf) {
  if (!buf || buf.length < 81) return null;
  const u = (o) => buf.readBigUInt64LE(o);
  return {
    virtualTokenReserves: u(8), virtualSolReserves: u(16), realTokenReserves: u(24), realSolReserves: u(32),
    tokenTotalSupply: u(40), complete: buf[48] === 1, creator: key(buf, 49),
  };
}

/** PumpSwap Pool: disc(8) bump(1) index(u16) creator base quote lp baseVault quoteVault (32 each) lpSupply(u64) coinCreator(32) */
export function decodePool(buf) {
  if (!buf || buf.length < 211) return null;
  return {
    index: buf.readUInt16LE(9), creator: key(buf, 11), baseMint: key(buf, 43), quoteMint: key(buf, 75), lpMint: key(buf, 107),
    baseVault: key(buf, 139), quoteVault: key(buf, 171), coinCreator: buf.length >= 243 ? key(buf, 211) : null,
  };
}
