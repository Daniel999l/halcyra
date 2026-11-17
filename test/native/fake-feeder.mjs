// A stand-in for src/native/feeder.py (tests only): says "ready", echoes every
// line it gets as "got <line>", says "eof" when stdin closes.
// FAKE_CRASH_AFTER=n: exits 1 after n lines (only on the first run; marker file).
// FAKE_NO_READY=1: never says ready.
// FAKE_LOG=<file>: also appends every line it gets to that file.
import fs from 'node:fs';
const crashAfter = Number(process.env.FAKE_CRASH_AFTER || 0);
const marker = process.env.FAKE_MARKER || '';
const firstRun = marker ? !fs.existsSync(marker) : true;
if (marker && firstRun) fs.writeFileSync(marker, String(process.pid));
if (!process.env.FAKE_NO_READY) process.stdout.write('ready\n');
let buf = ''; let n = 0;
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    n += 1;
    process.stdout.write(`got ${line}\n`);
    if (process.env.FAKE_LOG) fs.appendFileSync(process.env.FAKE_LOG, `${line}\n`);
    if (crashAfter && firstRun && n >= crashAfter) process.exit(1);
  }
});
process.stdin.on('end', () => { process.stdout.write('eof\n'); setTimeout(() => process.exit(0), 20); });
