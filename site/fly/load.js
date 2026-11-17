/**
 * Loading her. The same two files in node and in a browser tab.
 *
 *   connectome.bin.gz   FAFB1 header, then outPtr (N+1 int32),
 *                       outPost (E int32), outW (E float32) - CSR by
 *                       presynaptic cell, weight = +/- synapse count
 *   eyemap.json         which cells her lamina is, where each one sits on the
 *                       retina, and which cells the body reads
 *   neurons.tsv.gz      one line per cell: type, class, side, transmitter
 *                       (only needed to name what lit up)
 */

const MAGIC = 'FAFB1';

export function parseConnectome(buf) {
  const dv = new DataView(buf);
  const magic = String.fromCharCode(dv.getUint8(0), dv.getUint8(1), dv.getUint8(2), dv.getUint8(3), dv.getUint8(4));
  if (magic !== MAGIC) throw new Error(`not a connectome file (${magic})`);
  const N = dv.getInt32(8, true);
  const E = dv.getInt32(12, true);
  let off = 16;
  const outPtr = new Int32Array(buf.slice(off, off + (N + 1) * 4)); off += (N + 1) * 4;
  const outPost = new Int32Array(buf.slice(off, off + E * 4)); off += E * 4;
  const outW = new Float32Array(buf.slice(off, off + E * 4)); off += E * 4;
  if (off !== buf.byteLength) throw new Error(`connectome file is ${buf.byteLength - off} bytes off`);
  return { N, E, outPtr, outPost, outW };
}

/** node */
export async function loadConnectomeNode(dir) {
  const [{ default: fs }, { default: path }, { default: zlib }] = await Promise.all([
    import('node:fs'), import('node:path'), import('node:zlib'),
  ]);
  const gz = fs.readFileSync(path.join(dir, 'connectome.bin.gz'));
  const raw = zlib.gunzipSync(gz);
  const ab = raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength);
  const c = parseConnectome(ab);
  const eyemap = JSON.parse(fs.readFileSync(path.join(dir, 'eyemap.json'), 'utf8'));
  return { ...c, eyemap };
}

/** browser */
export async function loadConnectomeWeb(base = 'fly') {
  const [cRes, eRes] = await Promise.all([
    fetch(`${base}/connectome.bin.gz`), fetch(`${base}/eyemap.json`),
  ]);
  let ab;
  // a server that already un-gzips it for us hands over plain bytes
  const buf = await cRes.arrayBuffer();
  const looksGz = new Uint8Array(buf.slice(0, 2));
  if (looksGz[0] === 0x1f && looksGz[1] === 0x8b) {
    const ds = new DecompressionStream('gzip');
    ab = await new Response(new Blob([buf]).stream().pipeThrough(ds)).arrayBuffer();
  } else ab = buf;
  return { ...parseConnectome(ab), eyemap: await eRes.json() };
}

/** the names, only when something wants to say what fired */
export async function loadNeuronsNode(dir) {
  const [{ default: fs }, { default: path }, { default: zlib }] = await Promise.all([
    import('node:fs'), import('node:path'), import('node:zlib'),
  ]);
  const txt = zlib.gunzipSync(fs.readFileSync(path.join(dir, 'neurons.tsv.gz'))).toString('utf8');
  const lines = txt.split('\n');
  const head = lines[0].split('\t');
  const col = Object.fromEntries(head.map((h, i) => [h, i]));
  const rows = new Array(lines.length - 1);
  for (let i = 1; i < lines.length; i += 1) {
    if (!lines[i]) continue;
    const f = lines[i].split('\t');
    rows[+f[col.idx]] = {
      id: f[col.root_id],
      type: f[col.cell_type] || f[col.hemibrain_type] || '',
      cls: f[col.super_class] || '',
      side: f[col.side] || '',
      nt: f[col.top_nt] || '',
      dim: f[col.dimorphism] || '',
    };
  }
  return rows;
}
