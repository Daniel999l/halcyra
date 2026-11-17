/**
 * The native pad (src/native/pad.js) against a stand-in feeder that echoes what
 * it gets (test/native/fake-feeder.mjs), and against the REAL feeder.py in
 * --dry mode (no vgamepad here):
 *   line format and the standard -> XInput conversion, rate limit (newest
 *   only), no repeats but a keep-alive, neutral on close, restart on crash,
 *   bad lines never crash feeder.py, feeder.py goes neutral on EOF.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NativePad, toFeederState, NEUTRAL_LINE, FEEDER_PY } from '../src/native/pad.js';
import { check, finish } from './service-fixtures.mjs';
import { say } from '../src/log.js';

say.quiet = true;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FAKE = path.join(HERE, 'native', 'fake-feeder.mjs');
const R = []; const ok = check(R);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
console.log('native-pad\n');

function fakePad(opts = {}, env = {}) {
  const got = []; const other = [];
  const pad = new NativePad({
    command: process.execPath, args: [FAKE], env: { ...process.env, ...env }, ...opts,
    onOutput: (l) => { if (l.startsWith('got ')) got.push(l.slice(4)); else other.push(l); },
  });
  return { pad, got, other };
}

// ---- 1. conversion (pure)
const s1 = toFeederState({ axes: [0.25, -0.5, 1.5, 0.2], buttons: { y: 1, rb: 0.6, a: 0.49, rt: 0.8, lt: 0.1, up: 1, home: 1 } });
ok(s1.lx === 0.25 && s1.ly === 0.5 && s1.rx === 1 && s1.ry === -0.2, 'sticks: X kept, Y flipped to XInput (up = +), clamped to -1..1', JSON.stringify(s1));
ok(s1.lt === 0.1 && s1.rt === 0.8, 'triggers: buttons[6]/[7] values -> lt/rt');
ok(JSON.stringify(s1.btn) === JSON.stringify(['Y', 'RB', 'UP', 'GUIDE']), 'buttons: held at >= 0.5, XInput names', s1.btn.join(','));
const s0 = toFeederState({ axes: [0, 0, 0, 0], buttons: {} });
ok(JSON.stringify(s0) === NEUTRAL_LINE, 'a neutral GamePilot pad is exactly the neutral line');
// a real Tick pad (all 17 names, as GamePilot makes them) passes through unchanged in meaning
const tickPad = { axes: [-0.3127, 0.1, 0, 0], buttons: { a: 0, b: 0, x: 0, y: 1, lb: 0, rb: 0, lt: 0.1, rt: 0, back: 0, start: 0, ls: 0, rs: 0, up: 0, down: 0, left: 0, right: 0, home: 0 } };
const st = toFeederState(tickPad);
ok(st.lx === -0.3127 && st.ly === -0.1 && st.btn.join() === 'Y' && st.lt === 0.1, 'a Tick pad (17 named buttons) converts as documented');

// ---- 2. line format over the pipe
{
  const { pad, got } = fakePad({ hz: 100 });
  pad.start();
  await pad.whenReady(5000);
  await sleep(50);
  const before = got.length;
  pad.setPad({ axes: [0.5, -1, 0, 0], buttons: { y: 1, rt: 0.75 } });
  await sleep(80);
  const line = got.slice(before).at(-1);
  let parsed = null; try { parsed = JSON.parse(line); } catch { /* bad */ }
  ok(parsed && parsed.lx === 0.5 && parsed.ly === 1 && parsed.rt === 0.75 && parsed.btn.join() === 'Y', 'one JSON line per update, as documented', line);
  ok(!line.includes('\n') && Object.keys(parsed).join() === 'lx,ly,rx,ry,lt,rt,btn', 'line keys: lx ly rx ry lt rt btn');
  await pad.close();
}

// ---- 3. rate limit: 300 updates in ~1.5 s at 20 Hz -> about 30 lines, the newest always wins
{
  const { pad, got } = fakePad({ hz: 20 });
  pad.start(); await pad.whenReady(5000); await sleep(30);
  const n0 = got.length;
  const t0 = Date.now(); let last = null; let k = 0;
  while (Date.now() - t0 < 1500) { last = { axes: [Math.sin(k / 7), 0, 0, 0], buttons: { rt: (k % 100) / 100 } }; pad.setPad(last); k += 1; await sleep(5); }
  await sleep(120);
  const sent = got.length - n0;
  ok(k > 200 && sent >= 20 && sent <= 34, `rate limit: ${k} updates -> ${sent} lines at 20 Hz`);
  ok(got.at(-1) === JSON.stringify(toFeederState(last)), 'the last line sent is the newest state (older waiting ones dropped)');
  // no repeats: the same state for 2.5 s -> only the keep-alive copies (one a second)
  const n1 = got.length;
  for (let i = 0; i < 50; i += 1) { pad.setPad(last); await sleep(50); }
  const repeats = got.length - n1;
  ok(repeats >= 1 && repeats <= 3, `same state for 2.5 s -> ${repeats} keep-alive line(s), not 50`);
  // ---- 4. neutral on close
  await pad.close();
  await sleep(50);
  ok(got.at(-1) === NEUTRAL_LINE, 'close(): the last line is neutral', got.at(-1));
}
{
  const { pad, other } = fakePad({ hz: 60 });
  pad.start(); await pad.whenReady(5000);
  pad.setPad({ axes: [1, 0, 0, 0], buttons: { rb: 1 } });
  await sleep(50);
  await pad.close();
  ok(other.includes('eof') && pad.status.state === 'off', 'close(): the feeder sees stdin end (EOF) and exits', other.join(','));
}

// ---- 5. restart on crash, newest state sent again to the new feeder
{
  const marker = path.join(os.tmpdir(), `halcyra-fake-${process.pid}-${Date.now()}`);
  const statuses = [];
  const { pad, got } = fakePad({ hz: 100, onStatus: (s) => statuses.push(s.state) }, { FAKE_CRASH_AFTER: '3', FAKE_MARKER: marker });
  pad.start(); await pad.whenReady(5000);
  for (let i = 0; i < 6; i += 1) { pad.setPad({ axes: [i / 10, 0, 0, 0], buttons: {} }); await sleep(30); }
  const want = { axes: [0.9, 0, 0, 0], buttons: { x: 1 } };
  pad.setPad(want);
  const t0 = Date.now();
  while (Date.now() - t0 < 5000 && !(pad.restarts >= 1 && pad.ready && got.at(-1) === JSON.stringify(toFeederState(want)))) await sleep(50);
  ok(pad.restarts >= 1 && statuses.includes('restarting'), `feeder crashed -> restarted (${pad.restarts}), states ${[...new Set(statuses)].join(' > ')}`);
  ok(pad.ready && got.at(-1) === JSON.stringify(toFeederState(want)), 'after the restart the newest state is sent again', got.at(-1));
  ok(/exited 1/.test(pad.lastError || ''), 'the crash is reported', pad.lastError);
  await pad.close();
  fs.rmSync(marker, { force: true });
}
// a feeder that never starts: backoff grows, nothing throws
{
  const pad = new NativePad({ command: path.join(os.tmpdir(), 'no-such-feeder-here'), args: [] });
  pad.start();
  await sleep(2000);
  ok(pad.restarts >= 2 && !pad.ready && pad.backoff >= 2000, `missing feeder program: retries with backoff (${pad.restarts} tries, next wait ${pad.backoff} ms)`);
  let threw = false; try { pad.setPad({ axes: [1, 0, 0, 0], buttons: {} }); } catch { threw = true; }
  ok(!threw, 'setPad while the feeder is down: no throw, the state waits');
  await pad.close();
}

// ---- 6. the REAL feeder.py in --dry mode (python3)
{
  const py = process.platform === 'win32' ? 'python' : 'python3';
  const states = []; const other = [];
  const pad = new NativePad({ command: py, args: ['-u', FEEDER_PY, '--dry'], hz: 100, onOutput: (l) => { if (l.startsWith('state ')) states.push(JSON.parse(l.slice(6))); else other.push(l); } });
  pad.start();
  let up = true; try { await pad.whenReady(8000); } catch { up = false; }
  ok(up, 'feeder.py --dry prints "ready"');
  if (up) {
    pad.setPad({ axes: [0.5, -0.25, 0, 0], buttons: { y: 1, rt: 0.5 } });
    await sleep(60);
    const s = states.at(-1);
    ok(s && s.lx === 0.5 && s.ly === 0.25 && s.rt === 0.5 && s.btn.join() === 'Y', 'feeder.py applies the line (sticks, triggers, buttons)', JSON.stringify(s));
    // garbage straight down the pipe: none of it may kill it
    for (const bad of ['not json', '{"lx":"abc","btn":"Y"}', '[1,2,3]', '{"lx":1e999,"ly":null,"btn":[null,7,"NOPE","a"]}', '\u0000\u0001']) pad.proc.stdin.write(`${bad}\n`);
    await sleep(150);
    pad.lastSent = null; pad.setPad({ axes: [-1, 0, 0, 0], buttons: { a: 1 } });
    await sleep(80);
    const s2 = states.at(-1);
    ok(pad.ready && pad.restarts === 0 && s2.lx === -1 && s2.btn.join() === 'A', 'bad lines are skipped, the feeder lives on and keeps applying', JSON.stringify(s2));
    const odd = states.find((x) => x.lx === 1 && x.btn.join() === 'A');
    ok(Boolean(odd), 'a line with odd values is clamped / filtered, not rejected (lx 1e999 -> 1, only "A" kept)');
    await pad.close();
    const last = states.at(-1);
    ok(other.includes('neutral') && last.lx === 0 && last.rt === 0 && last.btn.length === 0, 'feeder.py: EOF -> pad reset to neutral');
  }
}

finish(R, 'native-pad');
