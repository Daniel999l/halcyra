/**
 * The descent. One WebGL2 scene on white: every one of her 139,255 cells from
 * the atlas, real connections from the connectome, and the real cell groups
 * (lamina, sugar, bitter, descending) from site/home/data/cells.json.
 * Scroll moves the camera; the page itself never moves.
 */
import { compile, buffer, mat4, project, PLACE_GLSL, placeJs } from '/home/gl.js';
import { startLive } from '/home/live.js';

const boot = JSON.parse(document.getElementById('boot').textContent);
const root = document.documentElement;
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const canvas = document.getElementById('specimen');
const marks = document.getElementById('marks');
const ctx2d = marks.getContext('2d');

const gl = canvas.getContext('webgl2', { antialias: true, alpha: true, premultipliedAlpha: true, powerPreference: 'high-performance', preserveDrawingBuffer: false });
if (!gl) { root.classList.remove('gl'); throw new Error('no webgl2'); }
root.classList.add('gl');
window.__halcyra = { webgl2: true, ready: false, frames: 0 };

const ACCENT = [212 / 255, 36 / 255, 92 / 255];
const INK = [0, 0, 0];
const CH = 7;
const sections = [...document.querySelectorAll('.ch')];

// ---------- copy box ----------
document.querySelector('.ca-copy')?.addEventListener('click', async (e) => {
  const ca = e.currentTarget.closest('.ca').dataset.ca;
  try { await navigator.clipboard.writeText(ca); } catch {
    const r = document.createRange(); r.selectNodeContents(document.querySelector('.ca-value'));
    const s = getSelection(); s.removeAllRanges(); s.addRange(r); document.execCommand('copy');
  }
  e.currentTarget.textContent = 'Copied';
  setTimeout(() => { e.currentTarget.textContent = 'Copy'; }, 1600);
});

// ---------- window furniture ----------
const win = document.querySelector('.window');
win.classList.add('room-window');
document.body.insertBefore(win, canvas);
for (const k of ['a', 'b', 'c', 'd']) { const t = document.createElement('span'); t.className = `tick ${k}`; win.appendChild(t); }
const sheen = document.createElement('span'); sheen.className = 'sheen'; win.appendChild(sheen);

// ---------- data ----------
// site/fly/atlas.js format (FATL1), read here so the per cell side array is kept
// (atlas.js spreads the name lists over it)
async function loadSpecimen(base) {
  const [binRes, jsonRes] = await Promise.all([fetch(`${base}/atlas.bin.gz`, { cache: 'no-store' }), fetch(`${base}/atlas.json`, { cache: 'no-store' })]);
  let buf = await binRes.arrayBuffer();
  const head = new Uint8Array(buf.slice(0, 2));
  if (head[0] === 0x1f && head[1] === 0x8b) buf = await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  const magic = String.fromCharCode(...new Uint8Array(buf.slice(0, 5)));
  if (magic !== 'FATL1') throw new Error('not an atlas');
  const n = new DataView(buf).getInt32(8, true);
  let o = 12;
  const pos = new Uint16Array(buf.slice(o, o + n * 6)); o += n * 6;
  o += n * 2; // type
  const sup = new Uint8Array(buf.slice(o, o + n)); o += n;
  const side = new Uint8Array(buf.slice(o, o + n));
  const names = await jsonRes.json();
  return { N: n, pos, sup, side, super: names.super, sideNames: names.side };
}
let atlas, cells, pathsBuf;
try {
  [atlas, cells, pathsBuf] = await Promise.all([
    loadSpecimen('/home/fly'),
    fetch('/home/data/cells.json', { cache: 'no-store' }).then((r) => r.json()),
    fetch('/home/data/paths.bin', { cache: 'no-store' }).then((r) => r.arrayBuffer()),
  ]);
} catch (e) {
  root.classList.remove('gl');
  throw e;
}
const N = atlas.N;
const EXT = cells.extentUm;
const SUP = atlas.super;
const isOptic = new Uint8Array(N);
const opticId = SUP.indexOf('optic');
for (let i = 0; i < N; i += 1) isOptic[i] = atlas.sup[i] === opticId ? 1 : 0;
const nrm = (i) => [atlas.pos[i * 3] / 65535, atlas.pos[i * 3 + 1] / 65535, atlas.pos[i * 3 + 2] / 65535];
const placeCell = (i, split) => { const n = nrm(i); return placeJs(n[0], n[1], n[2], isOptic[i], EXT, split); };
const cMemo = new Map();
const centroid = (idx, split = 0) => {
  const key = idx; let m = cMemo.get(key);
  if (!m) { m = new Map(); cMemo.set(key, m); }
  const sk = Math.round(split * 2) / 2;
  if (m.has(sk)) return m.get(sk);
  if (m.size > 600) m.clear();
  const v = centroidRaw(idx, sk); m.set(sk, v); return v;
};
const centroidRaw = (idx, split = 0) => {
  const c = [0, 0, 0]; if (!idx.length) return c;
  for (const i of idx) { const p = placeCell(i, split); c[0] += p[0]; c[1] += p[1]; c[2] += p[2]; }
  return c.map((v) => v / idx.length);
};
const sideId = (s) => atlas.sideNames.indexOf(s);
const bySuperSide = (sup, side) => { const out = []; const a = SUP.indexOf(sup); const b = side ? sideId(side) : -1; for (let i = 0; i < N; i += 1) if (atlas.sup[i] === a && (b < 0 || atlas.side[i] === b)) out.push(i); return out; };

const opticR = bySuperSide('optic', 'right'); const opticL = bySuperSide('optic', 'left');
const centralAll = bySuperSide('central');
const lamR = []; const lamL = [];
for (const i of cells.lamina.idx) (atlas.side[i] === sideId('right') ? lamR : lamL).push(i);
const dnAll = [...cells.dn.left, ...cells.dn.right];
const named = cells.dn.named;

// ---------- paths ----------
const pv = new DataView(pathsBuf);
const nWire = pv.getUint32(4, true); const nPath = pv.getUint32(8, true);
const wireIdx = new Uint32Array(pathsBuf.slice(12, 12 + nWire * 8));
const pathNodes = new Map(); // pid -> { group, nodes: [] }
{
  let o = 12 + nWire * 8;
  for (let k = 0; k < nPath; k += 1) {
    const a = pv.getUint32(o, true); const b = pv.getUint32(o + 4, true); const g = pv.getUint8(o + 8); const h = pv.getUint8(o + 9); const pid = pv.getUint16(o + 10, true);
    let p = pathNodes.get(pid); if (!p) { p = { group: g, nodes: [a] }; pathNodes.set(pid, p); }
    if (h === p.nodes.length - 1) p.nodes.push(b);
    o += 12;
  }
}
const paths = [...pathNodes.entries()].map(([pid, p]) => ({ pid, ...p, len: p.nodes.length - 1 }));

// ---------- programs ----------
const BASE_VS = `#version 300 es
precision highp float;
in vec3 aN; in float aSup;
uniform mat4 uVP; uniform mat4 uV; uniform float uDpr; uniform float uSizeK; uniform float uAlpha; uniform float uFocus; uniform float uReveal; uniform float uOpticId;
${PLACE_GLSL}
out float vA; out vec3 vC;
void main() {
  float optic = abs(aSup - uOpticId) < 0.5 ? 1.0 : 0.0;
  vec3 p = place(aN, optic);
  vec4 v = uV * vec4(p, 1.0);
  gl_Position = uVP * vec4(p, 1.0);
  float d = -v.z;
  float size = clamp(uSizeK / max(d, 1.0), 1.15, 3.2);
  gl_PointSize = size * uDpr;
  float fog = smoothstep(uFocus - 260.0, uFocus + 420.0, d);
  float nearFade = smoothstep(18.0, 140.0, d);
  float tone = optic > 0.5 ? 0.30 : (aSup > 6.5 && aSup < 8.5 ? 0.42 : 0.17);
  vC = vec3(tone);
  vA = uAlpha * (1.0 - 0.72 * fog) * nearFade * uReveal * (1.6 / (size + 0.35));
}`;
const DOT_FS = `#version 300 es
precision highp float;
in float vA; in vec3 vC; out vec4 o;
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0; float r = dot(q, q);
  float a = smoothstep(1.0, 0.45, r);
  o = vec4(vC * vA * a, vA * a);
}`;

const WIRE_VS = `#version 300 es
precision highp float;
in vec3 aN; in float aSup;
uniform mat4 uVP; uniform mat4 uV; uniform float uAlpha; uniform float uFocus; uniform float uOpticId;
${PLACE_GLSL}
out float vA;
void main() {
  float optic = abs(aSup - uOpticId) < 0.5 ? 1.0 : 0.0;
  vec3 p = place(aN, optic);
  vec4 v = uV * vec4(p, 1.0);
  gl_Position = uVP * vec4(p, 1.0);
  float d = -v.z;
  vA = uAlpha * (1.0 - 0.8 * smoothstep(uFocus - 200.0, uFocus + 380.0, d)) * smoothstep(20.0, 160.0, d);
}`;
const WIRE_FS = `#version 300 es
precision highp float;
in float vA; out vec4 o; uniform vec3 uColor;
void main() { o = vec4(uColor * vA, vA); }`;

const PATH_VS = `#version 300 es
precision highp float;
in vec3 aN; in float aOptic; in float aS; in float aPid; in float aGroup; in float aLen;
uniform mat4 uVP; uniform mat4 uV; uniform float uClock; uniform vec4 uMask; uniform float uFocus;
${PLACE_GLSL}
out float vS; out float vHead; out float vOn; out float vBitter; out float vFog;
void main() {
  vec3 p = place(aN, aOptic);
  gl_Position = uVP * vec4(p, 1.0);
  float d = -(uV * vec4(p, 1.0)).z;
  vS = aS;
  vHead = fract(uClock + aPid * 0.6180339) * (aLen + 1.6) - 0.6;
  int g = int(aGroup + 0.5);
  vOn = g == 0 ? uMask.x : g == 1 ? uMask.y : g == 2 ? uMask.z : uMask.w;
  vBitter = g == 2 ? 1.0 : 0.0;
  vFog = (1.0 - 0.7 * smoothstep(uFocus - 200.0, uFocus + 400.0, d)) * smoothstep(20.0, 120.0, d);
}`;
const PATH_FS = `#version 300 es
precision highp float;
in float vS; in float vHead; in float vOn; in float vBitter; in float vFog; out vec4 o;
uniform vec3 uAccent;
void main() {
  float x = vS - vHead;
  float pulse = exp(-x * x / 0.04) + 0.45 * exp(-max(-x, 0.0) * 3.5) * step(x, 0.0) * step(-1.0, x);
  pulse *= mix(1.0, 0.55, vBitter);
  vec3 c = mix(uAccent, vec3(0.0), vBitter);
  float base = 0.045;
  float A = (base + 0.84 * clamp(pulse, 0.0, 1.0)) * vOn * vFog;
  o = vec4(mix(vec3(0.0), c, clamp(pulse, 0.0, 1.0)) * A, A);
}`;

const MARK_VS = `#version 300 es
precision highp float;
in vec3 aN; in float aOptic; in float aVal;
uniform mat4 uVP; uniform mat4 uV; uniform float uDpr; uniform float uSize; uniform float uAlpha; uniform float uFocus;
${PLACE_GLSL}
out float vA;
void main() {
  vec3 p = place(aN, aOptic);
  gl_Position = uVP * vec4(p, 1.0);
  float d = -(uV * vec4(p, 1.0)).z;
  gl_PointSize = uSize * uDpr * clamp(900.0 / max(d, 1.0), 0.7, 1.7);
  vA = uAlpha * aVal * (1.0 - 0.55 * smoothstep(uFocus - 200.0, uFocus + 500.0, d)) * smoothstep(15.0, 90.0, d);
}`;
const MARK_FS = `#version 300 es
precision highp float;
in float vA; out vec4 o; uniform vec3 uColor; uniform float uRing;
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0; float r = length(q);
  float disc = smoothstep(1.0, 0.7, r);
  float ring = smoothstep(0.06, 0.0, abs(r - 0.86)) + smoothstep(0.42, 0.30, r);
  float a = mix(disc, ring, uRing);
  if (a < 0.01) discard;
  o = vec4(uColor * vA * a, vA * a);
}`;

const QUAD_VS = `#version 300 es
precision highp float;
in vec2 aUv;
uniform mat4 uVP; uniform vec3 uCenter; uniform vec3 uAxisU; uniform vec3 uAxisV;
out vec2 vUv;
void main() {
  vUv = aUv;
  vec3 p = uCenter + (aUv.x - 0.5) * uAxisU + (aUv.y - 0.5) * uAxisV;
  gl_Position = uVP * vec4(p, 1.0);
}`;
const SHADOW_FS = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o; uniform float uAlpha;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
void main() {
  vec2 q = (vUv - 0.5) * vec2(2.0, 2.0);
  float d = dot(q, q);
  float a = uAlpha * exp(-d * 3.2);
  a += (hash(gl_FragCoord.xy) - 0.5) / 255.0;
  a = max(a, 0.0);
  o = vec4(vec3(0.07, 0.08, 0.09) * a, a);
}`;
const SCREEN_FS = `#version 300 es
precision highp float;
in vec2 vUv; out vec4 o; uniform float uAlpha; uniform float uHasTex; uniform sampler2D uTex;
void main() {
  vec2 w = fwidth(vUv);
  vec2 e = min(vUv, 1.0 - vUv) / w;
  float edge = 1.0 - smoothstep(0.0, 1.2, min(e.x, e.y));
  vec3 img = texture(uTex, vec2(vUv.x, 1.0 - vUv.y)).rgb;
  vec3 glass = vec3(0.955, 0.96, 0.968);
  vec3 c = mix(glass, img, uHasTex);
  float a = mix(0.32, 0.96, uHasTex) * uAlpha;
  c = mix(c, vec3(0.0), edge);
  a = max(a, edge * 0.45 * uAlpha);
  o = vec4(c * a, a);
}`;

const prog = {
  base: compile(gl, BASE_VS, DOT_FS),
  wire: compile(gl, WIRE_VS, WIRE_FS),
  path: compile(gl, PATH_VS, PATH_FS),
  mark: compile(gl, MARK_VS, MARK_FS),
  shadow: compile(gl, QUAD_VS, SHADOW_FS),
  screen: compile(gl, QUAD_VS, SCREEN_FS),
};

// ---------- buffers ----------
const posBuf = buffer(gl, atlas.pos);
const supF = new Float32Array(N); for (let i = 0; i < N; i += 1) supF[i] = atlas.sup[i];
const supBuf = buffer(gl, supF);
function baseVao(p) {
  const v = gl.createVertexArray(); gl.bindVertexArray(v);
  gl.bindBuffer(gl.ARRAY_BUFFER, posBuf); gl.enableVertexAttribArray(p.a.aN); gl.vertexAttribPointer(p.a.aN, 3, gl.UNSIGNED_SHORT, true, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, supBuf); gl.enableVertexAttribArray(p.a.aSup); gl.vertexAttribPointer(p.a.aSup, 1, gl.FLOAT, false, 0, 0);
  return v;
}
const vaoBase = baseVao(prog.base);
const vaoWire = baseVao(prog.wire);
gl.bindVertexArray(vaoWire);
gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, buffer(gl, wireIdx, gl.ELEMENT_ARRAY_BUFFER));
gl.bindVertexArray(null);

function vaoFrom(p, attrs) {
  const v = gl.createVertexArray(); gl.bindVertexArray(v);
  for (const [name, data, size] of attrs) {
    if (p.a[name] == null || p.a[name] < 0) continue;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer(gl, data)); gl.enableVertexAttribArray(p.a[name]); gl.vertexAttribPointer(p.a[name], size, gl.FLOAT, false, 0, 0);
  }
  gl.bindVertexArray(null);
  return v;
}

// path edges
const pathCount = paths.reduce((s, p) => s + p.len, 0) * 2;
{
  const n = new Float32Array(pathCount * 3); const op = new Float32Array(pathCount); const s = new Float32Array(pathCount);
  const pid = new Float32Array(pathCount); const grp = new Float32Array(pathCount); const len = new Float32Array(pathCount);
  let k = 0;
  for (const p of paths) {
    for (let h = 0; h < p.len; h += 1) {
      for (const [ci, t] of [[p.nodes[h], 0], [p.nodes[h + 1], 1]]) {
        const q = nrm(ci); n.set(q, k * 3); op[k] = isOptic[ci]; s[k] = h + t; pid[k] = p.pid; grp[k] = p.group; len[k] = p.len; k += 1;
      }
    }
  }
  var vaoPath = vaoFrom(prog.path, [['aN', n, 3], ['aOptic', op, 1], ['aS', s, 1], ['aPid', pid, 1], ['aGroup', grp, 1], ['aLen', len, 1]]);
}

// marker sets: static positions, dynamic value
function markSet(idx, initial = 1) {
  const n = new Float32Array(idx.length * 3); const op = new Float32Array(idx.length);
  idx.forEach((ci, k) => { n.set(nrm(ci), k * 3); op[k] = isOptic[ci]; });
  const val = new Float32Array(idx.length).fill(initial);
  const v = gl.createVertexArray(); gl.bindVertexArray(v);
  const p = prog.mark;
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer(gl, n)); gl.enableVertexAttribArray(p.a.aN); gl.vertexAttribPointer(p.a.aN, 3, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer(gl, op)); gl.enableVertexAttribArray(p.a.aOptic); gl.vertexAttribPointer(p.a.aOptic, 1, gl.FLOAT, false, 0, 0);
  const vb = buffer(gl, val, gl.ARRAY_BUFFER, gl.DYNAMIC_DRAW); gl.enableVertexAttribArray(p.a.aVal); gl.vertexAttribPointer(p.a.aVal, 1, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);
  return { idx, vao: v, val, vb, count: idx.length, upload() { gl.bindBuffer(gl.ARRAY_BUFFER, vb); gl.bufferSubData(gl.ARRAY_BUFFER, 0, val); } };
}
const lamSet = markSet(cells.lamina.idx, 0);
const sweetSet = markSet(cells.taste.sweet);
const bitterSet = markSet(cells.taste.bitter);
const dnSet = markSet(dnAll);
const namedIdx = [...named.MDN, ...named.DNp01, ...named.oviDNb];
const namedSet = markSet(namedIdx);
const LIVE_MAX = 512;
const live = { n: new Float32Array(LIVE_MAX * 3), op: new Float32Array(LIVE_MAX), val: new Float32Array(LIVE_MAX), count: 0 };
const liveVao = gl.createVertexArray();
const liveBufs = {};
{
  gl.bindVertexArray(liveVao); const p = prog.mark;
  for (const [name, arr, size] of [['aN', live.n, 3], ['aOptic', live.op, 1], ['aVal', live.val, 1]]) {
    liveBufs[name] = buffer(gl, arr, gl.ARRAY_BUFFER, gl.DYNAMIC_DRAW); gl.enableVertexAttribArray(p.a[name]); gl.vertexAttribPointer(p.a[name], size, gl.FLOAT, false, 0, 0);
  }
  gl.bindVertexArray(null);
}
// pulse heads (positions computed on the CPU, in micrometres, placed with split already applied: aOptic 0)
const heads = { n: new Float32Array(paths.length * 3), val: new Float32Array(paths.length) };
const headVao = gl.createVertexArray();
const headBufs = {};
{
  gl.bindVertexArray(headVao); const p = prog.mark;
  for (const [name, arr, size] of [['aN', heads.n, 3], ['aOptic', new Float32Array(paths.length), 1], ['aVal', heads.val, 1]]) {
    headBufs[name] = buffer(gl, arr, gl.ARRAY_BUFFER, gl.DYNAMIC_DRAW); gl.enableVertexAttribArray(p.a[name]); gl.vertexAttribPointer(p.a[name], size, gl.FLOAT, false, 0, 0);
  }
  gl.bindVertexArray(null);
}
const quadVao = vaoFrom(prog.shadow, [['aUv', new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), 2]]);
const quadVao2 = vaoFrom(prog.screen, [['aUv', new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), 2]]);
const tex = gl.createTexture();
gl.bindTexture(gl.TEXTURE_2D, tex);
gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([245, 246, 247, 255]));
gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
let hasTex = 0;

// ---------- the staging ----------
const SPLIT = 120;
const C0 = [0, 0, 0];
const lamRc = centroid(lamR, SPLIT);
const lamOut = (() => { const d = [lamRc[0], 0, lamRc[2] - 0]; const l = Math.hypot(d[0], d[2]); return [d[0] / l, 0, d[2] / l]; })();
const tasteC = centroid([...cells.taste.sweet, ...cells.taste.bitter]);
const dnC = centroid(dnAll);
const rad = (d) => d * Math.PI / 180;
// yaw: 0 = in front of her face. fit: micrometres across the frame width.
// mask: path groups [sight, sweet, bitter, inside]
const KEYS = {
  wide: [
    { at: [0, 6, 0], yaw: -4, pitch: 11, fit: 1400, sx: 0.2, sy: 0.05, split: 0, wire: 0, mask: [0, 0, 0, 0], base: 1, lam: 0, taste: 0, dn: 0, shadow: 1, screen: 0 },
    { at: [0, 0, 0], yaw: 30, pitch: 22, fit: 1450, sx: 0.36, sy: 0.04, split: 0, wire: 0.35, mask: [0, 0, 0, 0], base: 1, lam: 0, taste: 0, dn: 0, shadow: 0.8, screen: 0 },
    { at: [0, 8, 0], yaw: -10, pitch: 14, fit: 1550, sx: 0.22, sy: 0.12, split: SPLIT, wire: 1, mask: [0, 0, 0, 1], base: 0.85, lam: 0, taste: 0, dn: 0, shadow: 0.5, screen: 0 },
    { at: lamRc, yaw: 64, pitch: 8, fit: 760, sx: 0.2, sy: 0.04, split: SPLIT, wire: 0.25, mask: [1, 0, 0, 0], base: 0.6, lam: 1, taste: 0, dn: 0, shadow: 0, screen: 1 },
    { at: tasteC, yaw: -24, pitch: -10, fit: 950, sx: 0.24, sy: 0.1, split: SPLIT * 0.4, wire: 0.2, mask: [0, 1, 1, 0], base: 0.42, lam: 0, taste: 1, dn: 0, shadow: 0, screen: 0 },
    { at: [dnC[0], dnC[1] - 10, dnC[2]], yaw: 0, pitch: 4, fit: 1250, sx: 0.24, sy: 0.3, split: 0, wire: 0.2, mask: [0.5, 0.5, 0.5, 0], base: 0.5, lam: 0, taste: 0, dn: 1, shadow: 0, screen: 0 },
    { at: [0, 0, 0], yaw: -14, pitch: 9, fit: 2500, sx: -0.5, sy: 0.24, split: 0, wire: 0, mask: [0, 0, 0, 0], base: 0.95, lam: 0, taste: 0, dn: 0, shadow: 0.8, screen: 0 },
  ],
  tall: [
    { at: [0, 6, 0], yaw: -4, pitch: 11, fit: 820, sx: 0, sy: 0.2, split: 0, wire: 0, mask: [0, 0, 0, 0], base: 1, lam: 0, taste: 0, dn: 0, shadow: 1, screen: 0 },
    { at: [0, 0, 0], yaw: 30, pitch: 22, fit: 900, sx: 0, sy: 0.42, split: 0, wire: 0.35, mask: [0, 0, 0, 0], base: 1, lam: 0, taste: 0, dn: 0, shadow: 0.8, screen: 0 },
    { at: [0, 8, 0], yaw: -10, pitch: 14, fit: 960, sx: 0, sy: 0.2, split: SPLIT, wire: 1, mask: [0, 0, 0, 1], base: 0.85, lam: 0, taste: 0, dn: 0, shadow: 0.5, screen: 0 },
    { at: lamRc, yaw: 64, pitch: 8, fit: 600, sx: -0.1, sy: 0.08, split: SPLIT, wire: 0.25, mask: [1, 0, 0, 0], base: 0.6, lam: 1, taste: 0, dn: 0, shadow: 0, screen: 1 },
    { at: tasteC, yaw: -24, pitch: -14, fit: 440, sx: 0, sy: 0.14, split: SPLIT * 0.4, wire: 0.2, mask: [0, 1, 1, 0], base: 0.42, lam: 0, taste: 1, dn: 0, shadow: 0, screen: 0 },
    { at: [dnC[0], dnC[1] - 10, dnC[2]], yaw: 0, pitch: 4, fit: 860, sx: 0, sy: 0.56, split: 0, wire: 0.2, mask: [0.5, 0.5, 0.5, 0], base: 0.5, lam: 0, taste: 0, dn: 1, shadow: 0, screen: 0 },
    { at: [0, 0, 0], yaw: -14, pitch: 9, fit: 1150, sx: 0, sy: 0.02, split: 0, wire: 0, mask: [0, 0, 0, 0], base: 0.95, lam: 0, taste: 0, dn: 0, shadow: 0.4, screen: 0 },
  ],
};
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (e0, e1, x) => { const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };
function lerpKey(a, b, t) {
  const o = {};
  for (const k of Object.keys(a)) {
    if (Array.isArray(a[k])) o[k] = a[k].map((v, i) => lerp(v, b[k][i], t));
    else o[k] = lerp(a[k], b[k], t);
  }
  return o;
}

// ---------- labels and the keys ----------
const labelsHost = document.body;
function label(ch, title, sub, world, dx, dy, cls = '', reach = 1) {
  const el = document.createElement('div'); el.className = `label ${cls}`; el.setAttribute('aria-hidden', 'true');
  el.innerHTML = `<b></b>${sub ? '<span></span>' : ''}`; el.querySelector('b').textContent = title; if (sub) el.querySelector('span').textContent = sub;
  labelsHost.appendChild(el);
  return { ch, el, world, dx, dy, reach };
}
const fmt = (n) => Number(n).toLocaleString('en-US');
const opticRs = opticR.filter((_, i) => i % 8 === 0); const opticLs = opticL.filter((_, i) => i % 8 === 0); const centralS = centralAll.filter((_, i) => i % 4 === 0);
const LABELS = [
  label(2, 'Optic lobe, right', `${fmt(opticR.length)} cells`, () => centroid(opticRs, view.split), 0, -1),
  label(2, 'Optic lobe, left', `${fmt(opticL.length)} cells`, () => centroid(opticLs, view.split), 0, -1),
  label(2, 'Central brain', `${fmt(centralAll.length)} cells`, () => centroid(centralS, view.split), 1, 1),
  Object.assign(label(3, 'Lamina, right eye', `${fmt(lamR.length)} cells`, () => lamRc, 1, -1, '', 2.4), { side: true }),
  label(4, 'Sugar cells', `${cells.taste.sweet.length}`, () => centroid(cells.taste.sweet, view.split), -1, -1, 'sweet'),
  label(4, 'Bitter cells', `${cells.taste.bitter.length}`, () => centroid(cells.taste.bitter, view.split), 1, 1),
];
const labelCache = new Map();

const padArt = document.createElement('div');
padArt.className = 'pad-art';
padArt.setAttribute('aria-hidden', 'true');
padArt.innerHTML = `<svg viewBox="0 0 400 250" width="100%" height="100%" fill="none" stroke-linecap="round" stroke-linejoin="round">
  <g stroke="#000" stroke-width="1">
    <rect id="pad-up" x="108" y="40" width="54" height="54" rx="5" fill="#fff"/>
    <rect id="pad-left" x="48" y="102" width="54" height="54" rx="5" fill="#fff"/>
    <rect id="pad-down" x="108" y="102" width="54" height="54" rx="5" fill="#fff"/>
    <rect id="pad-right" x="168" y="102" width="54" height="54" rx="5" fill="#fff"/>
    <path id="pad-enter" d="M262 40 H346 C349 40 351 42 351 45 V151 C351 154 349 156 346 156 H285 C282 156 280 154 280 151 V99 H262 C259 99 257 97 257 94 V45 C257 42 259 40 262 40 Z" fill="#fff"/>
    <rect id="pad-space" x="78" y="178" width="244" height="40" rx="5" fill="#fff"/>
  </g>
  <g stroke="#8d9196" stroke-width="1">
    <path d="M135 76 V58 M128 65 L135 58 L142 65"/>
    <path d="M84 129 H66 M73 122 L66 129 L73 136"/>
    <path d="M135 120 V138 M128 131 L135 138 L142 131"/>
    <path d="M186 129 H204 M197 122 L204 129 L197 136"/>
    <path d="M330 64 V96 H300 M307 89 L300 96 L307 103"/>
    <path d="M182 204 V210 H218 V204"/>
  </g>
</svg>`;
document.body.appendChild(padArt);
const padPart = (id) => padArt.querySelector(`#${id}`);
// the GTA 1 keys (src/stagekeys.js): arrows steer, Up is gas, Down brakes, Space is the handbrake, Enter gets in and out
const PADLINKS = [
  { from: () => centroid(cells.dn.left), to: 'pad-left' },
  { from: () => centroid(cells.dn.left), to: 'pad-right' },
  { from: () => centroid(cells.dn.right), to: 'pad-up' },
  { from: () => centroid(named.MDN), to: 'pad-down' },
  { from: () => centroid(named.DNp01), to: 'pad-space' },
  { from: () => centroid(named.oviDNb), to: 'pad-enter' },
];

// ---------- scroll ----------
let P = 0;
function readScroll() {
  const max = Math.max(1, document.documentElement.scrollHeight - innerHeight);
  P = Math.min(CH - 1, Math.max(0, (scrollY / max) * (CH - 1)));
}
addEventListener('scroll', readScroll, { passive: true });
const gaugeLinks = [...document.querySelectorAll('.gauge a')];
gaugeLinks.forEach((a) => a.addEventListener('click', (e) => {
  e.preventDefault();
  const max = document.documentElement.scrollHeight - innerHeight;
  scrollTo({ top: (Number(a.dataset.to) / (CH - 1)) * max, behavior: reduced ? 'auto' : 'smooth' });
}));
addEventListener('keydown', (e) => {
  if (!['PageDown', 'PageUp', 'ArrowDown', 'ArrowUp', ' '].includes(e.key) || e.target.closest('a,button,input')) return;
  const dir = e.key === 'PageUp' || e.key === 'ArrowUp' ? -1 : 1;
  const target = Math.min(CH - 1, Math.max(0, Math.round(P) + dir));
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') return;
  e.preventDefault();
  const max = document.documentElement.scrollHeight - innerHeight;
  scrollTo({ top: (target / (CH - 1)) * max, behavior: reduced ? 'auto' : 'smooth' });
});

// ---------- size ----------
let W = 0, H = 0, dpr = 1, tall = false;
function resize() {
  W = innerWidth; H = innerHeight;
  const phone = Math.min(W, H) < 600;
  dpr = Math.min(devicePixelRatio || 1, phone ? 2 : 2);
  canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
  marks.width = Math.round(W * dpr); marks.height = Math.round(H * dpr);
  tall = W / H < 0.9;
  document.documentElement.style.setProperty('--travel', `${(CH - 1) * (tall ? 125 : 115) + 100}vh`);
  readScroll();
}
addEventListener('resize', resize);
resize();

// ---------- live data ----------
const flash = { sweet: 0, bitter: 0 };
const liveLit = new Map(); // cell -> activity
let frameBitmap = null;
const lumCanvas = document.createElement('canvas'); lumCanvas.width = 96; lumCanvas.height = 54;
const lumCtx = lumCanvas.getContext('2d', { willReadFrequently: true });
let lum = null;
startLive({
  boot,
  wantFrame: () => P > 2.4,
  onFrame(bitmap) {
    frameBitmap = bitmap;
    if (bitmap) {
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
      hasTex = 1;
      lumCtx.drawImage(bitmap, 0, 0, 96, 54);
      lum = lumCtx.getImageData(0, 0, 96, 54).data;
    } else { hasTex = 0; lum = null; }
  },
  onTick(t) {
    if (!Array.isArray(t?.lit)) return;
    for (const [i, a] of t.lit) if (i >= 0 && i < N) liveLit.set(i, Math.max(liveLit.get(i) || 0, Math.min(1, a)));
  },
  onTrade(tr) { if (tr.side === 'buy') flash.sweet = 1; if (tr.side === 'sell') flash.bitter = 1; },
});

// ---------- draw ----------
let view = { split: 0 };
const box = { left: 0, right: 0, top: 0, bottom: 0 };
const t0 = performance.now();
let reveal = reduced ? 1 : 0;
let last = t0;
const fpsLog = [];

function setLabel(L, vis, VP) {
  if (vis < 0.01) { if (L.el.style.opacity !== '0') L.el.style.opacity = '0'; return null; }
  const w = L.world();
  const s = project(VP, w, W, H);
  if (!s) { L.el.style.opacity = '0'; return null; }
  const off = tall ? 54 : 84;
  let dx = L.dx;
  if (!dx) { const c = project(VP, view.at, W, H); dx = c && s[0] < c[0] ? -1 : 1; }
  const lx = s[0] + dx * off * (L.reach > 1 ? 1.3 : 1);
  let ly = s[1] + L.dy * off * 0.7 * L.reach;
  // land the label in clear white outside her outline when there is room for it
  if (L.dy < 0 && box.top - 30 > 78) ly = Math.min(ly, box.top - 30);
  if (L.dy > 0 && box.bottom + 46 < H - 160) ly = Math.max(ly, box.bottom + 30);
  const r = L.el.getBoundingClientRect();
  let x = dx < 0 ? lx - r.width - 6 : lx + 6;
  // wide screens: a label that would sit on her lands in the white beside her outline instead
  if (L.side && !tall) { x = s[0] - 230 - r.width; ly = s[1] - 170; }
  x = Math.min(W - r.width - 14, Math.max(14, x));
  const y = Math.min(H - r.height - 14, Math.max(70, L.dy < 0 ? ly - r.height : ly));
  L.el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
  L.el.style.opacity = String(vis);
  const ex = x > s[0] ? x - 4 : x + r.width + 4;
  return { ax: s[0], ay: s[1], lx: L.side && !tall ? ex : lx, ly: L.side && !tall ? Math.max(y, Math.min(y + r.height, ly)) : ly, vis };
}

function frame(now) {
  const dt = Math.min(0.1, (now - last) / 1000); last = now;
  if (!reduced) reveal = Math.min(1, reveal + dt / 1.4);
  const time = (now - t0) / 1000;
  const keys = tall ? KEYS.tall : KEYS.wide;
  const seg = Math.min(CH - 2, Math.floor(P)); const f = P - seg;
  const k = smooth(0.1, 0.9, f);
  const v = lerpKey(keys[seg], keys[seg + 1], k);
  view = v;

  // camera
  const idle = reduced ? 0 : Math.sin(time * 0.05) * 2.2;
  const yaw = rad(v.yaw + idle); const pitch = rad(v.pitch);
  const aspect = W / H; const fovy = rad(30);
  const dist = v.fit / (2 * Math.tan(fovy / 2) * aspect);
  const eye = [v.at[0] + Math.sin(yaw) * Math.cos(pitch) * dist, v.at[1] + Math.sin(pitch) * dist, v.at[2] - Math.cos(yaw) * Math.cos(pitch) * dist];
  const V = mat4.lookAt(eye, v.at, [0, 1, 0]);
  const Pm = mat4.perspective(fovy, aspect, Math.max(4, dist * 0.02), dist * 6, v.sx, v.sy);
  const VP = mat4.mul(Pm, V);
  const density = Math.min(1, Math.max(0.55, Math.sqrt((W * H) / (1440 * 900)) * 1.15));
  const clock = reduced ? P * 0.45 : time * 0.09 + P * 0.45;

  gl.viewport(0, 0, canvas.width, canvas.height);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  gl.disable(gl.DEPTH_TEST);

  const common = (p) => {
    gl.useProgram(p.p);
    if (p.u.uVP) gl.uniformMatrix4fv(p.u.uVP, false, VP);
    if (p.u.uV) gl.uniformMatrix4fv(p.u.uV, false, V);
    if (p.u.uExtent) gl.uniform3fv(p.u.uExtent, EXT);
    if (p.u.uSplit) gl.uniform1f(p.u.uSplit, v.split);
    if (p.u.uFocus) gl.uniform1f(p.u.uFocus, dist);
    if (p.u.uDpr) gl.uniform1f(p.u.uDpr, dpr);
    if (p.u.uOpticId) gl.uniform1f(p.u.uOpticId, opticId);
  };

  // contact shadow on the floor under her
  if (v.shadow > 0.01) {
    const p = prog.shadow; gl.useProgram(p.p);
    gl.uniformMatrix4fv(p.u.uVP, false, VP);
    gl.uniform3fv(p.u.uCenter, [0, -EXT[1] / 2 - 70, 0]);
    gl.uniform3fv(p.u.uAxisU, [EXT[0] * 1.25 + v.split * 2, 0, 0]);
    gl.uniform3fv(p.u.uAxisV, [0, 0, EXT[2] * 1.7]);
    gl.uniform1f(p.u.uAlpha, 0.055 * v.shadow * reveal);
    gl.bindVertexArray(quadVao); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  // wiring
  if (v.wire > 0.01) {
    const p = prog.wire; common(p);
    gl.uniform1f(p.u.uAlpha, 0.03 * v.wire * reveal);
    gl.uniform3fv(p.u.uColor, INK);
    gl.bindVertexArray(vaoWire);
    const count = Math.min(wireIdx.length, (Math.min(W, H) < 600 ? 14000 : 42000) * 2);
    gl.drawElements(gl.LINES, count, gl.UNSIGNED_INT, 0);
  }

  // every cell
  {
    const p = prog.base; common(p);
    gl.uniform1f(p.u.uAlpha, 0.44 * v.base * density);
    gl.uniform1f(p.u.uSizeK, 2300);
    gl.uniform1f(p.u.uReveal, reveal);
    gl.bindVertexArray(vaoBase); gl.drawArrays(gl.POINTS, 0, N);
  }

  // real paths and their signal
  const mask = v.mask;
  if (mask.some((m) => m > 0.01)) {
    const p = prog.path; common(p);
    gl.uniform1f(p.u.uClock, clock);
    gl.uniform4fv(p.u.uMask, mask);
    gl.uniform3fv(p.u.uAccent, ACCENT);
    gl.bindVertexArray(vaoPath); gl.drawArrays(gl.LINES, 0, pathCount);
    // heads
    let k = 0;
    for (const pa of paths) {
      const on = mask[pa.group];
      const h = ((clock + pa.pid * 0.6180339) % 1 + 1) % 1 * (pa.len + 1.6) - 0.6;
      if (on < 0.01 || h < 0 || h > pa.len) { heads.val[k] = 0; k += 1; continue; }
      const i = Math.min(pa.len - 1, Math.floor(h)); const t = h - i;
      const a = placeCell(pa.nodes[i], v.split); const b = placeCell(pa.nodes[i + 1], v.split);
      // back to normalised space so the shader places it (aOptic 0 = no extra split)
      const w = [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
      heads.n[k * 3] = w[0] / EXT[0] + 0.5; heads.n[k * 3 + 1] = -w[1] / EXT[1] + 0.5; heads.n[k * 3 + 2] = w[2] / EXT[2] + 0.5;
      heads.val[k] = on * (pa.group === 2 ? 0.9 : 1);
      k += 1;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, headBufs.aN); gl.bufferSubData(gl.ARRAY_BUFFER, 0, heads.n);
    gl.bindBuffer(gl.ARRAY_BUFFER, headBufs.aVal); gl.bufferSubData(gl.ARRAY_BUFFER, 0, heads.val);
    const m = prog.mark; common(m); gl.uniform1f(m.u.uSplit, 0);
    gl.uniform1f(m.u.uRing, 0); gl.uniform1f(m.u.uSize, 4.2); gl.uniform1f(m.u.uAlpha, 1);
    gl.bindVertexArray(headVao);
    // bitter heads in ink, the rest in the accent
    gl.uniform3fv(m.u.uColor, ACCENT);
    drawHeadsBy((g) => g !== 2);
    gl.uniform3fv(m.u.uColor, INK);
    drawHeadsBy((g) => g === 2);
  }
  function drawHeadsBy(pred) {
    // contiguous runs by group: paths are stored grouped, so find the range
    let s = -1;
    for (let i = 0; i <= paths.length; i += 1) {
      const ok = i < paths.length && pred(paths[i].group);
      if (ok && s < 0) s = i;
      if (!ok && s >= 0) { gl.drawArrays(gl.POINTS, s, i - s); s = -1; }
    }
  }

  // lamina: the screen goes in
  const sightLocal = Math.min(1, Math.max(0, P - 2.5));
  if (v.lam > 0.01) {
    const L = lamSet; const uv = cells.lamina.uv;
    const band = sightLocal * 1.5 - 0.25;
    for (let i = 0; i < L.count; i += 1) {
      const u = uv[i * 2]; const vv = uv[i * 2 + 1];
      let val;
      if (lum) {
        const px = Math.min(95, Math.max(0, Math.round(u * 95))); const py = Math.min(53, Math.max(0, Math.round(vv * 53)));
        const o = (py * 96 + px) * 4; const y = (0.2126 * lum[o] + 0.7152 * lum[o + 1] + 0.0722 * lum[o + 2]) / 255;
        val = 0.25 + 0.75 * y;
      } else {
        const x = (u - band) / 0.16; val = 0.18 + 0.82 * Math.exp(-x * x);
      }
      L.val[i] = val * smooth(0.0, 0.5, sightLocal);
    }
    L.upload();
    const m = prog.mark; common(m);
    gl.uniform1f(m.u.uRing, 0); gl.uniform1f(m.u.uSize, 2.4); gl.uniform1f(m.u.uAlpha, 0.8 * v.lam);
    gl.uniform3fv(m.u.uColor, ACCENT);
    gl.bindVertexArray(L.vao); gl.drawArrays(gl.POINTS, 0, L.count);
  }

  // the screen entering her eye
  if (v.screen > 0.01) {
    const d = lerp(360, 20, smooth(0.05, 0.85, sightLocal));
    const alpha = v.screen * (1 - smooth(0.62, 0.95, sightLocal));
    if (alpha > 0.01) {
      const p = prog.screen; gl.useProgram(p.p);
      gl.uniformMatrix4fv(p.u.uVP, false, VP);
      const c = [lamRc[0] + lamOut[0] * d, lamRc[1] + 6, lamRc[2] + lamOut[2] * d];
      // facing the eye: the plane spans the tangent and up
      const tng = [lamOut[2], 0, -lamOut[0]];
      const wq = 200; const hq = wq * 9 / 16;
      gl.uniform3fv(p.u.uCenter, c); gl.uniform3fv(p.u.uAxisU, tng.map((x) => x * wq)); gl.uniform3fv(p.u.uAxisV, [0, hq, 0]);
      gl.uniform1f(p.u.uAlpha, alpha); gl.uniform1f(p.u.uHasTex, hasTex);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tex); gl.uniform1i(p.u.uTex, 0);
      gl.bindVertexArray(quadVao2); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
  }

  // taste cells
  flash.sweet = Math.max(0, flash.sweet - dt / 4); flash.bitter = Math.max(0, flash.bitter - dt / 4);
  const tasteAmt = Math.max(v.taste, P > 5.4 ? Math.max(flash.sweet, flash.bitter) : 0);
  if (tasteAmt > 0.01 || flash.sweet > 0 || flash.bitter > 0) {
    const m = prog.mark; common(m);
    gl.uniform1f(m.u.uRing, 1); gl.uniform1f(m.u.uSize, tall ? 13 : 16);
    gl.uniform1f(m.u.uAlpha, Math.max(v.taste, flash.sweet));
    gl.uniform3fv(m.u.uColor, ACCENT); gl.bindVertexArray(sweetSet.vao); gl.drawArrays(gl.POINTS, 0, sweetSet.count);
    gl.uniform1f(m.u.uAlpha, Math.max(v.taste, flash.bitter));
    gl.uniform3fv(m.u.uColor, INK); gl.bindVertexArray(bitterSet.vao); gl.drawArrays(gl.POINTS, 0, bitterSet.count);
  }

  // descending cells
  if (v.dn > 0.01) {
    const m = prog.mark; common(m);
    gl.uniform1f(m.u.uRing, 0); gl.uniform1f(m.u.uSize, 2.6); gl.uniform1f(m.u.uAlpha, 0.75 * v.dn);
    gl.uniform3fv(m.u.uColor, INK); gl.bindVertexArray(dnSet.vao); gl.drawArrays(gl.POINTS, 0, dnSet.count);
    gl.uniform1f(m.u.uRing, 1); gl.uniform1f(m.u.uSize, 10); gl.uniform1f(m.u.uAlpha, v.dn);
    gl.bindVertexArray(namedSet.vao); gl.drawArrays(gl.POINTS, 0, namedSet.count);
  }

  // live: the cells that were most active in her last looks
  if (liveLit.size) {
    let n = 0;
    for (const [i, a] of liveLit) {
      const na = a - dt * 0.9;
      if (na <= 0.02) { liveLit.delete(i); continue; }
      liveLit.set(i, na);
      if (n >= LIVE_MAX) continue;
      live.n.set(nrm(i), n * 3); live.op[n] = isOptic[i]; live.val[n] = na; n += 1;
    }
    live.count = n;
    const roomish = smooth(4.6, 5.6, P);
    if (n && roomish > 0.01) {
      for (const [name, arr] of [['aN', live.n], ['aOptic', live.op], ['aVal', live.val]]) { gl.bindBuffer(gl.ARRAY_BUFFER, liveBufs[name]); gl.bufferSubData(gl.ARRAY_BUFFER, 0, arr); }
      const m = prog.mark; common(m);
      gl.uniform1f(m.u.uRing, 0); gl.uniform1f(m.u.uSize, tall ? 2.6 : 3); gl.uniform1f(m.u.uAlpha, 0.85 * roomish);
      gl.uniform3fv(m.u.uColor, ACCENT); gl.bindVertexArray(liveVao); gl.drawArrays(gl.POINTS, 0, n);
    }
  }
  gl.bindVertexArray(null);
  if (window.__halcyra.wantSample) {
    // test hook: share of canvas pixels the specimen covers (the canvas is transparent over the white page), read in the frame that drew them
    const px = new Uint8Array(canvas.width * canvas.height * 4);
    gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, px);
    let ink = 0; for (let i = 0; i < px.length; i += 4) if (px[i + 3] > 10) ink += 1;
    window.__halcyra.inkRatio = ink / (canvas.width * canvas.height);
    window.__halcyra.wantSample = false;
  }

  // her outline on screen: the projected box of the (opened) specimen
  {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const hx = EXT[0] / 2 + v.split; const hy = EXT[1] / 2; const hz = EXT[2] / 2;
    for (const cx of [-hx, hx]) for (const cy of [-hy * 0.8, hy * 0.8]) for (const cz of [-hz, hz]) {
      const q = project(VP, [cx, cy, cz], W, H); if (!q) continue;
      x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]); y0 = Math.min(y0, q[1]); y1 = Math.max(y1, q[1]);
    }
    box.left = x0; box.right = x1; box.top = y0; box.bottom = y1;
  }

  // ---------- overlay: text, labels, leaders, scale bar ----------
  ctx2d.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx2d.clearRect(0, 0, W, H);
  sections.forEach((s, i) => {
    const d = Math.abs(P - i);
    const vis = 1 - smooth(0.26, 0.48, d);
    s.style.opacity = vis.toFixed(3);
    s.classList.toggle('on', vis > 0.01);
    s.style.transform = reduced ? '' : `translateY(${((i - P) * 22).toFixed(1)}px)`;
  });
  if (!reduced) {
    countNums.forEach((digs, k) => {
      digs.forEach((d, j) => {
        const a = smooth(0.48 + k * 0.07 + (j / digs.length) * 0.22, 0.56 + k * 0.07 + (j / digs.length) * 0.22, Math.min(P, 1));
        const o = P > 1 ? '1' : a.toFixed(3);
        if (d.style.opacity !== o) d.style.opacity = o;
      });
    });
  }
  document.querySelector('.mast').style.opacity = String(smooth(0.25, 0.55, P));
  const at = Math.round(P);
  gaugeLinks.forEach((a, i) => a.classList.toggle('at', i === at));

  ctx2d.lineWidth = 1;
  for (const L of LABELS) {
    const vis = (1 - smooth(0.22, 0.45, Math.abs(P - L.ch))) * reveal;
    const r = setLabel(L, vis, VP);
    if (!r) continue;
    ctx2d.strokeStyle = `rgba(0,0,0,${0.55 * vis})`;
    ctx2d.beginPath(); ctx2d.moveTo(r.ax + 0.5, r.ay + 0.5); ctx2d.lineTo(r.lx + 0.5, r.ly + 0.5); ctx2d.stroke();
    ctx2d.fillStyle = `rgba(0,0,0,${0.8 * vis})`;
    ctx2d.beginPath(); ctx2d.arc(r.ax, r.ay, 2, 0, Math.PI * 2); ctx2d.fill();
  }

  // the keys and the leaders from her descending cells
  const padVis = (1 - smooth(0.24, 0.46, Math.abs(P - 5))) * reveal;
  padArt.style.opacity = padVis.toFixed(3);
  if (padVis > 0.01) {
    const pw = tall ? Math.min(W - 80, 270) : Math.min(360, W * 0.24);
    const cx = tall ? W / 2 : W * (0.5 + v.sx / 2);
    const cy = tall ? H * 0.5 : H * 0.72;
    padArt.style.width = `${pw}px`; padArt.style.height = `${pw * 250 / 400}px`;
    padArt.style.transform = `translate(${Math.round(cx - pw / 2)}px, ${Math.round(cy - pw * 250 / 800)}px)`;
    padArt.style.left = '0'; padArt.style.top = '0';
    for (const link of PADLINKS) {
      const s = project(VP, link.from(), W, H); const el = padPart(link.to);
      if (!s || !el) continue;
      const b = el.getBoundingClientRect();
      const tx = b.left + b.width / 2; const ty = b.top + Math.min(b.height / 2, 6);
      ctx2d.strokeStyle = `rgba(0,0,0,${0.5 * padVis})`;
      ctx2d.beginPath(); ctx2d.moveTo(s[0], s[1]);
      ctx2d.bezierCurveTo(s[0], s[1] + (ty - s[1]) * 0.55, tx, ty - (ty - s[1]) * 0.45, tx, ty);
      ctx2d.stroke();
      ctx2d.fillStyle = `rgba(0,0,0,${0.85 * padVis})`; ctx2d.beginPath(); ctx2d.arc(s[0], s[1], 2, 0, Math.PI * 2); ctx2d.fill();
    }
  }

  // the room: the glass fades in with the chapter, and her two eyes are tied to it
  {
    const rv = 1 - smooth(0.3, 0.55, Math.abs(P - 6));
    win.style.opacity = rv.toFixed(3);
    win.style.visibility = rv > 0.01 ? 'visible' : 'hidden';
    if (rv > 0.01) {
      const b = win.getBoundingClientRect();
      const eyes = [project(VP, centroid(lamR, v.split), W, H), project(VP, centroid(lamL, v.split), W, H)];
      const corners = tall ? [[b.left, b.bottom], [b.right, b.bottom]] : [[b.left, b.top], [b.left, b.bottom]];
      ctx2d.strokeStyle = `rgba(0,0,0,${0.42 * rv})`;
      ctx2d.fillStyle = `rgba(0,0,0,${0.8 * rv})`;
      const ex = eyes.filter(Boolean).sort((a, c) => a[0] - c[0]);
      const pairs = tall ? [[ex[0], corners[0]], [ex[1], corners[1]]] : [[ex[ex.length - 1], corners[0]], [ex[ex.length - 1], corners[1]]];
      for (const [e, c] of pairs) {
        if (!e) continue;
        ctx2d.beginPath(); ctx2d.moveTo(e[0], e[1]); ctx2d.lineTo(c[0], c[1]); ctx2d.stroke();
        ctx2d.beginPath(); ctx2d.arc(e[0], e[1], 2, 0, Math.PI * 2); ctx2d.fill();
      }
    }
  }

  // microscope scale bar at the focus plane
  {
    const pxPerUm = (H / 2) / Math.tan(fovy / 2) / dist;
    const nice = [5, 10, 20, 50, 100, 200, 500, 1000];
    let um = nice[0];
    for (const n of nice) if (n * pxPerUm <= (tall ? 90 : 120)) um = n;
    sbLine.style.width = `${Math.max(8, Math.round(um * pxPerUm))}px`;
    const txt = `${um} µm`;
    if (sbText.textContent !== txt) sbText.textContent = txt;
    scalebar.style.opacity = String(reveal * (1 - smooth(5.3, 5.8, P)));
  }

  // room window glass when there is no frame: nothing to say, just glass
  window.__halcyra.frames += 1;
  window.__halcyra.P = P;
  if (dt > 0) { fpsLog.push(dt); if (fpsLog.length > 120) fpsLog.shift(); }
  requestAnimationFrame(frame);
}
const countNums = [...document.querySelectorAll('.count .num')].map((n) => [...n.querySelectorAll('i')]);
const scalebar = document.querySelector('.scalebar');
const sbLine = scalebar.querySelector('.sb-line');
const sbText = scalebar.querySelector('.sb-text');

window.__halcyra.fps = () => fpsLog.length / fpsLog.reduce((a, b) => a + b, 0);
window.__halcyra.counts = { cells: N, wiring: nWire, pathEdges: nPath, lamina: lamSet.count, sweet: sweetSet.count, bitter: bitterSet.count, dn: dnSet.count };
window.__halcyra.ready = true;
requestAnimationFrame(frame);
