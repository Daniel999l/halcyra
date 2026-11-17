/**
 * Her, driving the mock console in real Chrome.
 *
 *   node test/pilot-browser.mjs [--steps 300] [--ms 160] [--eye small|png] [--seed 783]
 *
 * Checks:
 *   - the virtual pad works injected before load (addInitScript) and after load
 *     (evaluate): the page sees a connected standard pad via getGamepads()
 *   - the overlay is hidden while she looks
 *   - the page really reads the values she sets (the game's own last read
 *     equals the Tick's pad)
 *   - the car really moves under her control: distance and steering
 *   - control: the same loop with the brain replaced by zeros; the car must not move
 *   - the keyboard fallback moves the car on a page that accepts keys
 * Prints steps per second and ms per step split into capture / brain / pad.
 * Nothing here steers her. If she drives in circles, that is what it prints.
 */
import { chromium } from 'playwright-core';
import { serveMock } from './mock-console/serve.mjs';
import { loadFly, flyNames, GamePilot } from '../src/gamepilot.js';
import { GAMEPAD_INIT, setPad, releasePad } from '../src/gamepad.js';
import { Eye, OVERLAY_JS, GRID_W, GRID_H } from '../src/eye.js';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > -1 ? process.argv[i + 1] : d; };
const STEPS = Number(arg('steps', 300));
const MS = Number(arg('ms', 70));
const EYE = arg('eye', 'frame');
const SEED = Number(arg('seed', 783));

let fails = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) fails += 1; };
const near = (a, b) => Math.abs(a - b) < 1e-6;

await loadFly();
const names = flyNames();
const pick = (type) => names.map((n, i) => (n && n.type === type && n.cls === 'sensory' ? i : -1)).filter((i) => i >= 0);
const tasteCells = { sweet: pick('claw_tpGRN'), bitter: pick('LB3') };   // hand-picked, wiring test only

const srv = await serveMock();
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome',
  headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
const newPage = () => browser.newPage({ viewport: { width: 1280, height: 720 } });

// ---------- 1. pad injected after load ----------
{
  const p = await newPage();
  await p.goto(srv.url);
  await p.waitForTimeout(300);
  const before = await p.evaluate(() => window.__game.padSeen);
  await p.evaluate(GAMEPAD_INIT);
  await setPad(p, { axes: [0, 0, 0, 0], buttons: { rt: 1 } });
  await p.waitForTimeout(700);
  const g = await p.evaluate(() => window.__game);
  ok(!before && g.padSeen && g.connectedEvents >= 1 && g.pad.mapping !== null,
    `pad injected after load: page had no pad, then sees "${g.pad && g.pad.id}" (gamepadconnected fired ${g.connectedEvents}x), drove ${g.dist.toFixed(0)} px on rt=1`);
  await p.close();
}

// ---------- 2. overlay hidden while she looks ----------
{
  const p = await newPage();
  await p.setContent('<html><body style="margin:0;background:#fff"></body></html>');
  await p.evaluate(OVERLAY_JS);
  await p.evaluate(`window.__fly.show(); window.__fly.draw(${JSON.stringify({ active: 1, L: 0.2, R: 0.2, pad: { axes: [0.5, 0, 0, 0], buttons: { rt: 1, lt: 0, y: 1, rb: 0 } } })})`);
  const eye = await new Eye({ mode: 'png' }).open(p);
  const seenShown = await eye.look(p);
  await p.evaluate('window.__fly.hide()');
  const seenHidden = await eye.look(p);
  const minOf = (g) => g.reduce((m, v) => Math.min(m, v), 1);
  ok(minOf(seenShown) < 0.5 && minOf(seenHidden) > 0.99,
    `screenshot eye: overlay is visible to a camera when shown (darkest cell ${minOf(seenShown).toFixed(2)}) and invisible to her when hidden (darkest cell ${minOf(seenHidden).toFixed(2)})`);
  // the frame eye reads the game element only: the overlay stays on screen and is still not in her picture
  await p.setContent('<html><body style="margin:0;background:#fff"><canvas id="c" width="1280" height="720" style="display:block;width:100vw;height:100vh"></canvas></body></html>');
  await p.evaluate(() => { const g = document.getElementById('c').getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, 1280, 720); });
  await p.evaluate(OVERLAY_JS);
  await p.evaluate(`window.__fly.show(); window.__fly.draw(${JSON.stringify({ active: 1, L: 0.2, R: 0.2, pad: { axes: [0.5, 0, 0, 0], buttons: { rt: 1, lt: 0, y: 1, rb: 0 } } })})`);
  const fe = await new Eye({ mode: 'frame' }).open(p);
  const seenFrame = await fe.look(p);
  const shot = await new Eye({ mode: 'png' }).open(p).then((e) => e.look(p));
  ok(fe.lastPath === 'frame' && minOf(seenFrame) > 0.99 && minOf(shot) < 0.5,
    `frame eye: the overlay is on screen (a screenshot's darkest cell ${minOf(shot).toFixed(2)}) and not in her picture (darkest cell ${minOf(seenFrame).toFixed(2)}), without hiding it`);
  await p.close();
}

// ---------- 3. her, driving ----------
async function drive(label, pilot, steps, { taste = false } = {}) {
  const page = await newPage();
  await pilot.attach(page);                       // addInitScript + overlay, before the console loads
  await page.goto(srv.url);
  await page.waitForTimeout(400);
  await pilot.attach(page);                       // overlay into the loaded page (idempotent)
  const g0 = await page.evaluate(() => window.__game);
  const perf = { capture: 0, brain: 0, pad: 0, total: 0 };
  const lx = []; const rt = []; const lt = [];
  let matched = 0; let checked = 0; let commits = 0; let escapes = 0;
  let prevPad = null; let tastes = 0;
  const t0 = performance.now();
  for (let i = 0; i < steps; i += 1) {
    // a hand-made buy every 25 steps, only to show taste rides along in the Tick
    const ts = taste && i % 25 === 10 ? { sweet: 0.6, bitter: 0, applied: [{ sig: `test${i}`, side: 'buy', sol: 0.5, wallet: 'test', level: 0.6 }] } : null;
    if (ts) tastes += 1;
    const tick = await pilot.step(page, { ms: MS, taste: ts });
    for (const k of ['capture', 'brain', 'pad', 'total']) perf[k] += pilot.lastPerf[k];
    lx.push(tick.pad.axes[0]); rt.push(tick.pad.buttons.rt); lt.push(tick.pad.buttons.lt);
    if (tick.commit) commits += 1;
    if (tick.escape) escapes += 1;
    // what did the game itself last read? it reads every frame, so by now it
    // has read either this tick's pad or (rarely) still the previous one
    const g = await page.evaluate(() => window.__game.pad);
    if (g) {
      checked += 1;
      const same = (pad) => pad && near(g.axes[0], pad.axes[0]) && near(g.axes[1], pad.axes[1])
        && near(g.buttons[7], pad.buttons.rt) && near(g.buttons[6], pad.buttons.lt)
        && near(g.buttons[3], pad.buttons.y) && near(g.buttons[5], pad.buttons.rb);
      if (same(tick.pad) || same(prevPad)) matched += 1;
    }
    prevPad = tick.pad;
    if (i % 50 === 0 || i === steps - 1) {
      const s = await page.evaluate(() => window.__game);
      console.log(`  ${label} step ${String(i).padStart(3)}  steer ${tick.pad.axes[0].toFixed(3).padStart(6)} gas ${tick.pad.buttons.rt.toFixed(2)} brake ${tick.pad.buttons.lt.toFixed(2)}`
        + `  DN L ${tick.dn.L.toFixed(3)} R ${tick.dn.R.toFixed(3)}  ${String(tick.active).padStart(5)} active   car ${s.inCar ? 'in' : 'out'} speed ${s.speed.toFixed(0).padStart(4)} dist ${s.dist.toFixed(0).padStart(5)} hits ${s.collisions}`);
    }
  }
  const wall = (performance.now() - t0) / 1000;
  await releasePad(page);
  const g1 = await page.evaluate(() => window.__game);
  await pilot.detach();
  await page.close();
  const n = steps;
  const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;
  const sd = (a) => { const m = mean(a); return Math.sqrt(mean(a.map((v) => (v - m) ** 2))); };
  return {
    wall, steps: n, perf: Object.fromEntries(Object.entries(perf).map(([k, v]) => [k, v / n])),
    matched, checked, commits, escapes, tastes,
    lx: { mean: mean(lx), sd: sd(lx), min: Math.min(...lx), max: Math.max(...lx) },
    rt: { mean: mean(rt), sd: sd(rt) }, lt: { mean: mean(lt), sd: sd(lt) },
    game: {
      dist: g1.dist - g0.dist, distFoot: g1.distFoot - g0.distFoot, moved: g1.moved - g0.moved, collisions: g1.collisions - g0.collisions,
      net: Math.hypot(g1.x - g0.x, g1.y - g0.y), turned: g1.heading - g0.heading,
      toggles: g1.toggles, handbrakeFrames: g1.handbrakeFrames, frames: g1.frames - g0.frames,
      padFrames: g1.padFrames, padSeen: g1.padSeen, steerAbsMean: g1.steerAbsSum / Math.max(1, g1.frames),
      inCar: g1.inCar, gameSeconds: g1.t - g0.t,
    },
  };
}

const pilot = new GamePilot({ seed: SEED, tasteCells, eye: EYE, thread: 'worker' });
console.log(`her: seed ${SEED}, eye "${EYE}", ${MS} ms of brain time per step, ${STEPS} steps`);
const R = await drive('her ', pilot, STEPS, { taste: true });
const r1 = (v) => v.toFixed(1);
console.log(`\nher run: ${R.steps} steps in ${r1(R.wall)} s = ${(R.steps / R.wall).toFixed(2)} steps/s`);
console.log(`  per step: capture ${r1(R.perf.capture)} ms, brain ${r1(R.perf.brain)} ms, pad+overlay ${r1(R.perf.pad)} ms, total ${r1(R.perf.total)} ms (+ test bookkeeping)`);
console.log(`  brain time ${(R.steps * MS / 1000).toFixed(1)} s in ${r1(R.wall)} s wall: she lives at ${((R.steps * MS / 1000) / R.wall).toFixed(2)}x real time`);
console.log(`  game ran ${R.game.frames} frames in ${r1(R.game.gameSeconds)} s (${(R.game.frames / R.wall).toFixed(0)} fps while she drove)`);
console.log(`  steer: mean ${R.lx.mean.toFixed(4)} sd ${R.lx.sd.toFixed(4)} range ${R.lx.min.toFixed(3)}..${R.lx.max.toFixed(3)}; gas mean ${R.rt.mean.toFixed(3)} sd ${R.rt.sd.toFixed(3)}; brake mean ${R.lt.mean.toFixed(3)} sd ${R.lt.sd.toFixed(3)}`);
console.log(`  commits (Y) ${R.commits}, escapes (RB) ${R.escapes}, enter/exit toggles in game ${R.game.toggles}, handbrake frames ${R.game.handbrakeFrames}, hand-made taste samples ${R.tastes}`);
console.log(`  car: odometer ${R.game.dist.toFixed(0)} px (on foot ${R.game.distFoot.toFixed(0)} px), path incl. shoves ${R.game.moved.toFixed(0)} px, net displacement ${R.game.net.toFixed(0)} px, heading change ${R.game.turned.toFixed(2)} rad, ${R.game.collisions} collisions, ends ${R.game.inCar ? 'in' : 'out of'} the car`);

ok(R.game.padSeen && R.game.padFrames > 0, `the console page sees the pad (${R.game.padFrames} frames read it)`);
ok(R.matched / R.checked >= 0.95, `the page read exactly the values she set on ${R.matched}/${R.checked} steps`);
ok(R.game.dist + R.game.distFoot > 300, `she moved the player ${(R.game.dist + R.game.distFoot).toFixed(0)} px`);
ok(R.lx.sd > 0.002 && Math.abs(R.game.turned) + R.game.steerAbsMean > 0.01, `steering varies (sd ${R.lx.sd.toFixed(4)}) and turned the car (${R.game.turned.toFixed(2)} rad)`);

// ---------- 4. control: brain replaced by zeros ----------
const control = new GamePilot({ seed: SEED, tasteCells, eye: EYE });
const N = control.brain.N;
const zeros = {
  p: { ...control.brain.p }, N, a: new Float32Array(N), input: new Float32Array(N),
  clearInput() {}, drive() {}, step() {}, mean() { return 0; }, activeCount() { return 0; }, top() { return []; },
};
control.brain = zeros; control.body.brain = zeros;
const C = await drive('zero', control, 40);
ok(C.game.dist + C.game.distFoot < 1 && C.rt.mean === 0 && C.lx.sd === 0, `control (brain = zeros): pad neutral, odometer ${(C.game.dist + C.game.distFoot).toFixed(1)} px in ${C.steps} steps (shoved by traffic ${C.game.moved.toFixed(1)} px)`);

// ---------- 5. keyboard fallback ----------
{
  const p = await newPage();
  await p.goto(`${srv.url}?keys=1`);
  await p.waitForTimeout(300);
  await p.click('canvas');
  await setPad(p, { axes: [0.8, 0, 0, 0], buttons: { rt: 0.9 } }, { mode: 'keyboard' });
  await p.waitForTimeout(800);
  await releasePad(p);
  const g = await p.evaluate(() => window.__game);
  ok(g.dist > 50 && g.steerAbsSum > 0, `keyboard fallback drives a page that takes keys (${g.dist.toFixed(0)} px, steer frames ${g.steerAbsSum.toFixed(0)})`);
  await p.close();
}

await browser.close();
await srv.close();
console.log(`\nsummary ${JSON.stringify({ stepsPerSec: +(R.steps / R.wall).toFixed(2), msPerStep: Object.fromEntries(Object.entries(R.perf).map(([k, v]) => [k, +v.toFixed(1)])), dist: Math.round(R.game.dist), distFoot: Math.round(R.game.distFoot), turned: +R.game.turned.toFixed(2), collisions: R.game.collisions, steerSd: +R.lx.sd.toFixed(4), gasMean: +R.rt.mean.toFixed(3), controlDist: +C.game.dist.toFixed(1) })}`);
console.log(fails ? `\n${fails} FAILED` : '\nALL PASS');
process.exit(fails ? 1 : 0);
