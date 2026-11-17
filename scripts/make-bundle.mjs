#!/usr/bin/env node
/**
 * Turn a folder holding a DOS game into the bundle the in-tab console loads.
 *
 *   node scripts/make-bundle.mjs <game folder> <stage id> [--exe NAME.EXE] [--cycles 30000]
 *        [--memsize 16] [--machine svga_s3] [--backend dosbox|dosboxX] [--out <games dir>]
 *
 *   e.g. node scripts/make-bundle.mjs "C:\Games\GTA" gta1
 *
 * Writes <games dir>/<stage id>/bundle.jsdos (games dir = GAMES_DIR, default
 * ./games, which is not in git and is served to loopback requests only).
 *
 * The bundle is a plain zip: every file of the folder at its root, plus
 * .jsdos/dosbox.conf and .jsdos/jsdos.json. The DOSBox settings are tuned for
 * low CPU: fixed cycles (no "max" or "auto": the emulator never takes more than
 * that), no scaler, no sound card, no music device, no joystick, no network.
 * The game's own video mode stays as the game sets it (GTA 1 is 640x480).
 * [autoexec] mounts the folder as C: and starts the exe.
 *
 * Files are stored without compression (it is read over loopback only, and an
 * uncompressed zip is the cheapest to unpack in the tab).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------- zip (store only)
const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** entries [{ name, data: Buffer }] -> zip Buffer (method 0, no zip64: under 4 GB) */
export function zipStore(entries) {
  const parts = []; const central = []; let off = 0;
  const dosTime = 0; const dosDate = (2026 - 1980) << 9 | 1 << 5 | 1;
  for (const e of entries) {
    const name = Buffer.from(e.name.replace(/\\/g, '/'), 'utf8');
    const data = e.data;
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(0, 8);
    lh.writeUInt16LE(dosTime, 10); lh.writeUInt16LE(dosDate, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    parts.push(lh, name, data);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(0, 10);
    ch.writeUInt16LE(dosTime, 12); ch.writeUInt16LE(dosDate, 14); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(off, 42);
    central.push(ch, name);
    off += 30 + name.length + data.length;
    if (off > 0xffffffff) throw new Error('the game folder is over 4 GB; a store-only zip cannot hold it');
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...parts, cd, end]);
}

// ---------------------------------------------------------------- dosbox.conf
export function dosboxConf({ exe, cycles = 30000, memsize = 16, machine = 'svga_s3', cputype = 'pentium_slow' }) {
  return `[sdl]
autolock=false
fullscreen=false
output=surface

[dosbox]
machine=${machine}
memsize=${memsize}

[render]
frameskip=0
aspect=false
scaler=none

[cpu]
core=normal
cputype=${cputype}
cycles=fixed ${cycles}

[mixer]
nosound=true

[speaker]
pcspeaker=false
tandy=off
disney=false

[sblaster]
sbtype=none

[gus]
gus=false

[midi]
mpu401=none
mididevice=none

[joystick]
joysticktype=none

[serial]
serial1=disabled
serial2=disabled
serial3=disabled
serial4=disabled

[dos]
xms=true
ems=true
umb=true
keyboardlayout=auto

[ipx]
ipx=false

[autoexec]
@echo off
mount c .
c:
${exe}
`;
}

// GTA 1 (DOS) and the usual names, in order of preference
const KNOWN_EXES = ['GTA.EXE', 'GTADOS.EXE', 'GTA.BAT', 'GTA8.EXE', 'GTA24.EXE'];

function walk(dir, base = dir, out = []) {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, d.name);
    if (d.isDirectory()) { if (d.name !== '.jsdos') walk(f, base, out); } else if (d.isFile()) out.push(path.relative(base, f));
  }
  return out;
}

export function pickExe(files, wanted) {
  const top = files.filter((f) => !f.includes(path.sep) && !f.includes('/'));
  if (wanted) {
    const hit = files.find((f) => f.toUpperCase() === wanted.toUpperCase().replace(/\\/g, path.sep));
    if (!hit) throw new Error(`--exe ${wanted} is not in the folder`);
    return hit;
  }
  for (const k of KNOWN_EXES) { const hit = top.find((f) => f.toUpperCase() === k); if (hit) return hit; }
  const runnable = top.filter((f) => /\.(exe|com|bat)$/i.test(f));
  if (runnable.length === 1) return runnable[0];
  throw new Error(`cannot tell which program starts the game (${runnable.length ? runnable.join(', ') : 'no .EXE/.COM/.BAT at the top'}); pass --exe NAME.EXE`);
}

export function makeBundle({ src, id, exe = null, cycles = 30000, memsize = 16, machine = 'svga_s3', backend = 'dosbox', out = null }) {
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/i.test(id)) throw new Error(`bad stage id "${id}" (letters, digits, _ and -)`);
  if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) throw new Error(`no folder at ${src}`);
  const files = walk(src).sort();
  if (!files.length) throw new Error(`${src} is empty`);
  const start = pickExe(files, exe);
  const dosStart = start.split(path.sep).join('\\');
  // a program in a subfolder: cd into it first
  const dir = dosStart.includes('\\') ? dosStart.slice(0, dosStart.lastIndexOf('\\')) : '';
  const name = dosStart.slice(dosStart.lastIndexOf('\\') + 1);
  const exeLine = (dir ? `cd ${dir}\n` : '') + (/\.bat$/i.test(name) ? `call ${name}` : name);
  const conf = dosboxConf({ exe: exeLine, cycles, memsize, machine });
  const entries = files.map((f) => ({ name: f.split(path.sep).join('/'), data: fs.readFileSync(path.join(src, f)) }));
  entries.push({ name: '.jsdos/dosbox.conf', data: Buffer.from(conf) });
  entries.push({ name: '.jsdos/jsdos.json', data: Buffer.from(JSON.stringify({ version: '8', backend })) });
  const zip = zipStore(entries);
  const gamesDir = path.resolve(out || process.env.GAMES_DIR || path.join(ROOT, 'games'));
  const dest = path.join(gamesDir, id);
  fs.mkdirSync(dest, { recursive: true });
  const tmp = path.join(dest, `bundle.jsdos.${process.pid}.tmp`);
  fs.writeFileSync(tmp, zip);
  fs.renameSync(tmp, path.join(dest, 'bundle.jsdos'));
  fs.writeFileSync(path.join(dest, 'backend.txt'), backend === 'dosboxX' ? 'dosboxX\n' : 'dosbox\n');
  return { file: path.join(dest, 'bundle.jsdos'), bytes: zip.length, files: files.length, exe: dosStart, conf };
}

if (process.argv[1] && /make-bundle\.mjs$/.test(process.argv[1])) {
  const a = process.argv.slice(2);
  const opt = (k, d) => { const i = a.indexOf(`--${k}`); if (i < 0) return d; const v = a[i + 1]; a.splice(i, 2); return v; };
  const exe = opt('exe', null); const cycles = Number(opt('cycles', 30000)); const memsize = Number(opt('memsize', 16));
  const machine = opt('machine', 'svga_s3'); const backend = opt('backend', 'dosbox'); const out = opt('out', null);
  const [src, id] = a;
  if (!src || !id) { console.error('usage: node scripts/make-bundle.mjs <game folder> <stage id> [--exe NAME.EXE] [--cycles 30000] [--memsize 16] [--backend dosbox|dosboxX] [--out <games dir>]'); process.exit(2); }
  try {
    const r = makeBundle({ src: path.resolve(src), id, exe, cycles, memsize, machine, backend, out });
    console.log(`bundle written: ${r.file}\n  ${r.files} files, ${(r.bytes / 1048576).toFixed(1)} MB, starts ${r.exe}, cycles fixed ${cycles}`);
  } catch (e) { console.error(e.message); process.exit(1); }
}
