// A stand-in ffmpeg for test/native-screen.mjs: writes 160x90 rgb24 frames to
// stdout, each filled with its own number (0..255, wrapping).
//   burst   5 frames per write, every 50 ms
//   torn    one frame per ~3 writes, cut at odd places
//   die     exits 1 at once (an input that does not work)
//   silent  runs, never writes (an input that gives nothing)
const FB = 160 * 90 * 3;
const mode = process.argv[2] || 'burst';
let n = 0;
const frame = () => Buffer.alloc(FB, n++ % 256);
if (mode === 'die') { process.stderr.write('fake: no such input\n'); process.exit(1); }
if (mode === 'silent') setInterval(() => {}, 1000);
if (mode === 'burst') setInterval(() => { process.stdout.write(Buffer.concat([frame(), frame(), frame(), frame(), frame()])); }, 50);
if (mode === 'torn') {
  let pend = Buffer.alloc(0);
  setInterval(() => {
    if (pend.length < FB * 2) pend = Buffer.concat([pend, frame()]);
    const cut = 1 + Math.floor(FB / 3) + (n % 7) * 13;
    process.stdout.write(pend.subarray(0, cut)); pend = pend.subarray(cut);
  }, 20);
}
process.on('SIGTERM', () => process.exit(0));
