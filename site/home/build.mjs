/**
 * Builds the specimen data the landing page draws, from her real files only.
 *
 *   node site/home/build.mjs          writes site/home/data/cells.json + paths.bin
 *
 * cells.json   counts per super class, real extent in micrometres, the taste
 *              cells (findTasteCells from src/taste.js), the descending
 *              readouts (findReadouts from src/gamebody.js), her lamina cells
 *              and their retina positions (site/fly/eyemap.json)
 * paths.bin    real edges sampled from site/fly/connectome.bin.gz:
 *              a wiring layer (each cell's strongest outgoing edge, shuffled
 *              so a phone can take a prefix) and signal paths found by
 *              breadth first search along strong edges, from the lamina, the
 *              sugar cells and the bitter cells to descending cells.
 *
 * Nothing is invented: every index is a row of the atlas, every edge is a row
 * of the connectome.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const FLY = path.join(ROOT, 'site', 'fly');
const OUT = path.join(HERE, 'data');

export const BUILD_VERSION = 4;

/** builds when missing or stale, returns cells.json parsed */
export async function ensureBuilt({ force = false, log = () => {} } = {}) {
  const f = path.join(OUT, 'cells.json');
  if (!force && fs.existsSync(f) && fs.existsSync(path.join(OUT, 'paths.bin'))) {
    try {
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (j.version === BUILD_VERSION) return j;
    } catch { /* rebuild */ }
  }
  return build({ log });
}

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6D2B79F5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

export async function build({ log = () => {} } = {}) {
  const t0 = Date.now();
  const { loadNeuronsNode, parseConnectome } = await import(path.join(FLY, 'load.js'));
  const { findTasteCells } = await import(path.join(ROOT, 'src', 'taste.js'));
  const { findReadouts, GAMEBODY_DEFAULTS } = await import(path.join(ROOT, 'src', 'gamebody.js'));

  const names = await loadNeuronsNode(FLY);

  // atlas (positions normalised per axis to 0..65535)
  const ab = zlib.gunzipSync(fs.readFileSync(path.join(FLY, 'atlas.bin.gz')));
  const abuf = ab.buffer.slice(ab.byteOffset, ab.byteOffset + ab.byteLength);
  const AN = new DataView(abuf).getInt32(8, true);
  const N = AN;
  let named0 = 0; for (let i = 0; i < names.length; i += 1) if (names[i]) named0 = i + 1;
  if (named0 !== N) throw new Error(`atlas has ${AN} cells, names ${named0}`);
  const pos = new Uint16Array(abuf.slice(12, 12 + AN * 6));
  const atlasJson = JSON.parse(fs.readFileSync(path.join(FLY, 'atlas.json'), 'utf8'));
  const sup = new Uint8Array(abuf.slice(12 + AN * 8, 12 + AN * 9));

  // real scale per axis: least squares of soma position (nm) against atlas units
  const tsv = zlib.gunzipSync(fs.readFileSync(path.join(FLY, 'neurons.tsv.gz'))).toString('utf8').split('\n');
  const head = tsv[0].split('\t'); const col = Object.fromEntries(head.map((h, i) => [h, i]));
  const vox = [4, 4, 40];
  const fit = [];
  for (const [a, key] of [[0, 'x'], [1, 'y'], [2, 'z']]) {
    let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const which of ['pos_', 'soma_']) {
      n = 0; sx = 0; sy = 0; sxx = 0; sxy = 0;
      for (let r = 1; r < tsv.length; r += 1) {
        if (!tsv[r]) continue;
        const f = tsv[r].split('\t'); const v = Number(f[col[which + key]]); const i = Number(f[col.idx]);
        if (!f[col[which + key]] || !Number.isFinite(v)) continue;
        const x = pos[i * 3 + a]; n += 1; sx += x; sy += v; sxx += x * x; sxy += x * v;
      }
      const slope = (n * sxy - sx * sy) / (n * sxx - sx * sx);
      // residual
      const icpt = (sy - slope * sx) / n;
      let res = 0; let m = 0;
      for (let r = 1; r < tsv.length; r += 97) {
        if (!tsv[r]) continue;
        const f = tsv[r].split('\t'); const v = Number(f[col[which + key]]); const i = Number(f[col.idx]);
        if (!f[col[which + key]] || !Number.isFinite(v)) continue;
        res += Math.abs(icpt + slope * pos[i * 3 + a] - v); m += 1;
      }
      const cand = { axis: key, from: which, slope, res: res / m };
      if (!fit[a] || cand.res < fit[a].res) fit[a] = cand;
    }
  }
  const extentUm = fit.map((f, a) => Math.round(65535 * f.slope * vox[a] / 10) / 100);
  log(`extent ${extentUm.join(' x ')} um (fit from ${fit.map((f) => f.from + f.axis).join(', ')})`);

  // counts per super class
  const supCount = {};
  for (let i = 0; i < N; i += 1) { const k = atlasJson.super[sup[i]] || 'unknown'; supCount[k] = (supCount[k] || 0) + 1; }

  // taste
  const taste = findTasteCells(names);
  // descending readouts, the exact populations the pad reads
  const ro = findReadouts(names);
  const T = ro.types;
  const named = Object.fromEntries(Object.entries(T).map(([k, v]) => [k, [...v.L, ...v.R]]));

  // lamina
  const eyemap = JSON.parse(fs.readFileSync(path.join(FLY, 'eyemap.json'), 'utf8'));
  const lamIdx = []; const lamUv = [];
  for (const ct of ['L1', 'L2', 'L3', 'L4', 'L5']) {
    for (const side of ['left', 'right']) {
      const e = eyemap.eye[`${ct}_${side}`];
      if (!e) continue;
      for (let k = 0; k < e.idx.length; k += 1) {
        lamIdx.push(e.idx[k]);
        // the pilot's binocular layout (GameBody, binoc 0.18): each eye sees 59% of the screen, overlapping in the middle
        const [u, v] = e.uv[k];
        const half = 0.5 + GAMEBODY_DEFAULTS.binoc / 2;
        lamUv.push(Math.round((side === 'left' ? u * half : 1 - half + u * half) * 1000) / 1000, Math.round(v * 1000) / 1000);
      }
    }
  }

  // connectome
  const cz = zlib.gunzipSync(fs.readFileSync(path.join(FLY, 'connectome.bin.gz')));
  const C = parseConnectome(cz.buffer.slice(cz.byteOffset, cz.byteOffset + cz.byteLength));
  const { outPtr, outPost, outW } = C;
  log(`connectome ${C.N} cells, ${C.E} connections`);

  // wiring layer: every cell's strongest outgoing edge, shuffled (seeded)
  const wiring = [];
  for (let i = 0; i < N; i += 1) {
    let best = -1; let bw = 0;
    for (let e = outPtr[i]; e < outPtr[i + 1]; e += 1) { const w = Math.abs(outW[e]); if (w > bw) { bw = w; best = e; } }
    if (best >= 0 && bw >= 6) wiring.push([i, outPost[best]]);
  }
  const R = rng(783);
  for (let i = wiring.length - 1; i > 0; i -= 1) { const j = Math.floor(R() * (i + 1)); [wiring[i], wiring[j]] = [wiring[j], wiring[i]]; }
  const WIRING_MAX = 42000;
  wiring.length = Math.min(wiring.length, WIRING_MAX);

  // signal paths: multi source BFS along strong edges
  const isDn = new Uint8Array(N);
  for (const i of [...ro.dnLeft, ...ro.dnRight]) isDn[i] = 1;
  function bfsPaths(sources, minW, want, maxHops = 7, preferTargets = []) {
    const prev = new Int32Array(N).fill(-2);
    const hop = new Uint8Array(N);
    let frontier = [];
    for (const s of sources) { prev[s] = -1; frontier.push(s); }
    const reached = [];
    for (let h = 1; h <= maxHops && frontier.length; h += 1) {
      const next = [];
      for (const u of frontier) {
        for (let e = outPtr[u]; e < outPtr[u + 1]; e += 1) {
          if (Math.abs(outW[e]) < minW) continue;
          const v = outPost[e];
          if (prev[v] !== -2) continue;
          prev[v] = u; hop[v] = h; next.push(v);
          if (isDn[v]) reached.push(v);
        }
      }
      frontier = next;
    }
    const chosen = [];
    const taken = new Set();
    for (const t of preferTargets) if (prev[t] !== -2 && prev[t] !== -1 && !taken.has(t)) { chosen.push(t); taken.add(t); }
    const R2 = rng(want * 7 + sources.length);
    const pool = reached.filter((t) => !taken.has(t));
    while (chosen.length < want && pool.length) { const k = Math.floor(R2() * pool.length); chosen.push(pool[k]); pool.splice(k, 1); }
    return chosen.map((t) => { const p = [t]; let u = t; while (prev[u] >= 0) { u = prev[u]; p.push(u); } return p.reverse(); });
  }
  const namedDn = [...named.MDN, ...named.DNp01, ...named.oviDNb, ...named.DNp09];
  const sightPaths = bfsPaths(lamIdx, 10, 36, 8, namedDn);
  const sweetPaths = bfsPaths(taste.sweet, 5, 18, 7, namedDn);
  const bitterPaths = bfsPaths(taste.bitter, 5, 18, 7, namedDn);
  // inside: from a seeded sample of central cells, follow the strongest edge for up to 6 hops
  const central = []; for (let i = 0; i < N; i += 1) if (atlasJson.super[sup[i]] === 'central') central.push(i);
  const insidePaths = [];
  const R3 = rng(630);
  while (insidePaths.length < 70) {
    let u = central[Math.floor(R3() * central.length)]; const p = [u]; const seen = new Set(p);
    for (let h = 0; h < 6; h += 1) {
      let best = -1; let bw = 0;
      for (let e = outPtr[u]; e < outPtr[u + 1]; e += 1) { const v = outPost[e]; const w = Math.abs(outW[e]); if (w > bw && !seen.has(v)) { bw = w; best = v; } }
      if (best < 0 || bw < 8) break;
      u = best; p.push(u); seen.add(u);
    }
    if (p.length >= 4) insidePaths.push(p);
  }

  // check every path edge really exists
  const hasEdge = (a, b) => { for (let e = outPtr[a]; e < outPtr[a + 1]; e += 1) if (outPost[e] === b) return true; return false; };
  const groups = [['sight', sightPaths], ['sweet', sweetPaths], ['bitter', bitterPaths], ['inside', insidePaths]];
  for (const [g, ps] of groups) for (const p of ps) for (let k = 1; k < p.length; k += 1) if (!hasEdge(p[k - 1], p[k])) throw new Error(`${g}: ${p[k - 1]}->${p[k]} is not an edge`);

  // paths.bin: "HNP1", u32 wiringCount, u32 pathEdgeCount, then wiring pairs (u32,u32),
  // then path edges (u32 a, u32 b, u8 group, u8 hop, u16 pathId)
  const pathEdges = [];
  let pid = 0;
  groups.forEach(([, ps], g) => { for (const p of ps) { for (let k = 1; k < p.length; k += 1) pathEdges.push([p[k - 1], p[k], g, k - 1, pid]); pid += 1; } });
  const bin = Buffer.alloc(12 + wiring.length * 8 + pathEdges.length * 12);
  bin.write('HNP1', 0, 'latin1');
  bin.writeUInt32LE(wiring.length, 4); bin.writeUInt32LE(pathEdges.length, 8);
  let o = 12;
  for (const [a, b] of wiring) { bin.writeUInt32LE(a, o); bin.writeUInt32LE(b, o + 4); o += 8; }
  for (const [a, b, g, h, p] of pathEdges) { bin.writeUInt32LE(a, o); bin.writeUInt32LE(b, o + 4); bin.writeUInt8(g, o + 8); bin.writeUInt8(Math.min(h, 255), o + 9); bin.writeUInt16LE(p, o + 10); o += 12; }

  const meta = JSON.parse(fs.readFileSync(path.join(FLY, 'meta.json'), 'utf8'));
  const cells = {
    version: BUILD_VERSION,
    dataset: meta.dataset,
    neurons: meta.neurons, connections: meta.connections, synapses: meta.synapses,
    extentUm,
    superCount: supCount,
    optic: (supCount.optic || 0) + (supCount.visual_projection || 0) + (supCount.visual_centrifugal || 0),
    taste: { sweet: taste.sweet, bitter: taste.bitter, sweetTypes: taste.meta?.sweetTypes, bitterTypes: taste.meta?.bitterTypes, source: taste.meta?.source },
    dn: { left: ro.dnLeft, right: ro.dnRight, count: ro.dnLeft.length + ro.dnRight.length, named },
    lamina: { idx: lamIdx, uv: lamUv, count: lamIdx.length },
    paths: { file: 'paths.bin', wiring: wiring.length, edges: pathEdges.length, groups: groups.map(([g, ps]) => ({ group: g, paths: ps.length })) },
    builtFrom: ['site/fly/atlas.bin.gz', 'site/fly/neurons.tsv.gz', 'site/fly/eyemap.json', 'site/fly/connectome.bin.gz', 'src/taste.js findTasteCells', 'src/gamebody.js findReadouts'],
  };
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, 'paths.bin'), bin);
  fs.writeFileSync(path.join(OUT, 'cells.json'), JSON.stringify(cells));
  log(`built in ${Date.now() - t0} ms: sweet ${taste.sweet.length}, bitter ${taste.bitter.length}, dn ${cells.dn.count}, lamina ${lamIdx.length}, wiring ${wiring.length}, path edges ${pathEdges.length}`);
  return cells;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  build({ log: (m) => console.log(m) }).catch((e) => { console.error(e); process.exit(1); });
}
