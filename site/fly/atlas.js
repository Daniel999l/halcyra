/** Where every one of her cells sits, small enough to ship. */
export async function loadAtlas(base = 'fly') {
  const [binRes, jsonRes] = await Promise.all([fetch(`${base}/atlas.bin.gz`), fetch(`${base}/atlas.json`)]);
  let buf = await binRes.arrayBuffer();
  const head = new Uint8Array(buf.slice(0, 2));
  if (head[0] === 0x1f && head[1] === 0x8b) {
    buf = await new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  }
  const dv = new DataView(buf);
  const magic = String.fromCharCode(...new Uint8Array(buf.slice(0, 5)));
  if (magic !== 'FATL1') throw new Error('not an atlas');
  const N = dv.getInt32(8, true);
  let o = 12;
  const pos = new Uint16Array(buf.slice(o, o + N * 6)); o += N * 6;
  const type = new Uint16Array(buf.slice(o, o + N * 2)); o += N * 2;
  const sup = new Uint8Array(buf.slice(o, o + N)); o += N;
  const side = new Uint8Array(buf.slice(o, o + N)); o += N;
  const female = new Uint8Array(buf.slice(o, o + N)); o += N;
  const names = await jsonRes.json();
  return { N, pos, type, sup, side, female, ...names };
}
