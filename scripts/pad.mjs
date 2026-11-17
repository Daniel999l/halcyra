/**
 * Press the native virtual pad by hand (setup on the Windows PC: menus,
 * story mode, getting into a car). Run it while the service is NOT running,
 * or the two pads will both show up in the game.
 *
 *   node scripts/pad.mjs press A                 tap a button (150 ms)
 *   node scripts/pad.mjs press START 400         hold a button 400 ms
 *   node scripts/pad.mjs hold RT 0.6 2000        a trigger at 0.6 for 2 s
 *   node scripts/pad.mjs hold LX -1 1000         a stick axis (LX LY RX RY, Y up = +1) for 1 s
 *   node scripts/pad.mjs seq A 500 DOWN 300 A    taps with waits (ms) between them
 *   node scripts/pad.mjs neutral                 everything let go
 *
 * Buttons: A B X Y LB RB START BACK LS RS UP DOWN LEFT RIGHT GUIDE.
 * Triggers: LT RT (0..1). Sticks: LX LY RX RY (-1..1, XInput: LY +1 = up).
 * Settings: PYTHON or PAD_FEEDER, as for the service (docs/NATIVE.md).
 */
import { NativePad, XINPUT_NAMES, defaultFeeder } from '../src/native/pad.js';
import { splitCmd } from '../src/native/console.js';
import { cfg } from '../src/config.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const STD = Object.fromEntries(Object.entries(XINPUT_NAMES).map(([k, v]) => [v, k])); // 'A' -> 'a'
const AXES = { LX: 0, LY: 1, RX: 2, RY: 3 };

function usage(msg) {
  if (msg) console.error(msg);
  console.error('usage: node scripts/pad.mjs press <BUTTON> [ms] | hold <LT|RT|LX|LY|RX|RY|BUTTON> <value> <ms> | seq <BUTTON> <ms> ... | neutral');
  process.exit(2);
}

/** a state in the standard mapping the pad takes (stick Y flipped back: the pad flips it again) */
function state({ button = null, trigger = null, axis = null, value = 0 } = {}) {
  const axes = [0, 0, 0, 0];
  const buttons = {};
  if (button) buttons[STD[button]] = 1;
  if (trigger) buttons[trigger.toLowerCase()] = Math.max(0, Math.min(1, value));
  if (axis) axes[AXES[axis]] = (axis === 'LY' || axis === 'RY' ? -1 : 1) * Math.max(-1, Math.min(1, value));
  return { axes, buttons };
}

const [cmd, ...rest] = process.argv.slice(2);
if (!cmd) usage();
const feeder = cfg.native.feeder ? splitCmd(cfg.native.feeder) : defaultFeeder({ python: cfg.native.python });
const pad = new NativePad({ ...feeder, hz: 120 });
pad.start();
try {
  await pad.whenReady(20000);
  // a fresh virtual pad: give the game a moment to see it plugged in
  await sleep(600);
  const up = (s) => s.toUpperCase();
  if (cmd === 'neutral') {
    pad.neutral();
    console.log('pad: neutral');
  } else if (cmd === 'press') {
    const b = up(rest[0] || ''); const ms = Number(rest[1] || 150);
    if (!STD[b]) usage(`unknown button "${rest[0]}"`);
    pad.setPad(state({ button: b })); await sleep(ms); pad.neutral();
    console.log(`pad: pressed ${b} for ${ms} ms`);
  } else if (cmd === 'hold') {
    const what = up(rest[0] || ''); const v = Number(rest[1]); const ms = Number(rest[2] || 1000);
    if (!Number.isFinite(v)) usage('hold needs a value');
    if (what === 'LT' || what === 'RT') pad.setPad(state({ trigger: what, value: v }));
    else if (what in AXES) pad.setPad(state({ axis: what, value: v }));
    else if (STD[what]) pad.setPad(state({ button: what }));
    else usage(`unknown control "${rest[0]}"`);
    // keep it held: the pad repeats the state once a second by itself
    await sleep(ms); pad.neutral();
    console.log(`pad: held ${what} at ${v} for ${ms} ms`);
  } else if (cmd === 'seq') {
    for (const t of rest) {
      if (/^\d+$/.test(t)) { await sleep(Number(t)); continue; }
      const b = up(t); if (!STD[b]) usage(`unknown button "${t}"`);
      pad.setPad(state({ button: b })); await sleep(150); pad.neutral(); await sleep(50);
      console.log(`pad: ${b}`);
    }
  } else usage(`unknown command "${cmd}"`);
  await sleep(100);
} catch (e) {
  console.error(`pad: ${e.message}`);
  process.exitCode = 1;
}
await pad.close();
