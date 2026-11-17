/*
 * A stand-in for a cloud console tab.
 *
 * A top-down city driving game on one full-window canvas, chase camera (the car
 * always points up the screen, the world turns around it, the way a third
 * person driving camera works). Light ground, mid-grey roads, dark buildings,
 * dark traffic, dark trees: an OFF animal has something to see.
 *
 * The ONLY input is navigator.getGamepads(), polled every animation frame,
 * standard mapping:
 *   axes[0] steer, buttons[7] gas, buttons[6] brake then reverse,
 *   buttons[3] (Y / Triangle) leave or enter the car, buttons[5] (RB) handbrake,
 *   on foot: axes[0] turn, axes[1] walk.
 * With ?keys=1 the keyboard works too (W A S D, F, Space), for testing the
 * keyboard fallback only.
 *
 * Ground truth for tests, read only: window.__game (a fresh copy per read).
 * dist / distFoot: distance she made under her own power (after walls, not
 * counting shoves by traffic); moved: raw path length including shoves.
 */
(() => {
  const cv = document.getElementById('screen');
  const g = cv.getContext('2d', { alpha: false });
  const KEYS = new URLSearchParams(location.search).get('keys') === '1';

  // ---------- world ----------
  const B = 360;          // block pitch
  const RW = 112;         // road width
  const SW = 22;          // sidewalk
  const LOT0 = RW / 2 + SW;
  const LOT = B - 2 * LOT0;

  function hash(i, j, k) {
    let h = (Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(k, 1442695041)) | 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }
  const DARK = ['#2c2a30', '#3a3540', '#262b33', '#40362e', '#33302b', '#2e3a36', '#4a4348', '#1f2328'];
  const CARS = ['#1d1f24', '#2a3550', '#4a2324', '#2f3b2c', '#3a3a3e', '#e8e6df', '#22262b', '#5a4a2e'];

  const blockCache = new Map();
  /** what stands on block (i, j): rects {x,y,w,h,c,kind,solid}, trees {x,y,r} */
  function block(i, j) {
    const key = i + ',' + j;
    let b = blockCache.get(key);
    if (b) return b;
    const x0 = i * B + LOT0; const y0 = j * B + LOT0;
    const r = hash(i, j, 1);
    const rects = []; const trees = [];
    let kind = 'city';
    if (r < 0.14) kind = 'park';
    else if (r < 0.24) kind = 'lot';
    if (kind === 'city') {
      // split the lot into 1..4 buildings
      const sx = hash(i, j, 2) < 0.5 ? 1 : 2; const sy = hash(i, j, 3) < 0.5 ? 1 : 2;
      const gw = LOT / sx; const gh = LOT / sy;
      for (let a = 0; a < sx; a += 1) {
        for (let c = 0; c < sy; c += 1) {
          const pad = 6 + hash(i * 7 + a, j * 5 + c, 4) * 14;
          rects.push({
            x: x0 + a * gw + pad, y: y0 + c * gh + pad, w: gw - 2 * pad, h: gh - 2 * pad,
            c: DARK[Math.floor(hash(i + a, j + c, 5) * DARK.length)], kind: 'bldg', solid: true,
            tall: 8 + hash(i, j * 3 + a + c, 6) * 22, roof: hash(i + c, j + a, 7),
          });
        }
      }
    } else if (kind === 'lot') {
      for (let k = 0; k < 10; k += 1) {
        if (hash(i, j, 20 + k) < 0.35) continue;
        const col = k % 5; const row = Math.floor(k / 5);
        rects.push({ x: x0 + 18 + col * 38, y: y0 + 30 + row * 100, w: 24, h: 46,
          c: CARS[Math.floor(hash(i, j, 40 + k) * CARS.length)], kind: 'car', solid: true });
      }
    } else {
      for (let k = 0; k < 9; k += 1) {
        trees.push({ x: x0 + 20 + hash(i, j, 60 + k) * (LOT - 40), y: y0 + 20 + hash(i, j, 80 + k) * (LOT - 40), r: 10 + hash(i, j, 90 + k) * 14 });
      }
      rects.push({ x: x0 + LOT / 2 - 14, y: y0 + LOT / 2 - 14, w: 28, h: 28, c: '#3b3631', kind: 'kiosk', solid: true });
    }
    // street trees on the sidewalk corners
    if (hash(i, j, 99) < 0.6) trees.push({ x: i * B + RW / 2 + SW / 2, y: j * B + RW / 2 + SW / 2 + 40, r: 9 });
    b = { i, j, kind, rects, trees };
    blockCache.set(key, b);
    if (blockCache.size > 4000) blockCache.clear();
    return b;
  }

  // traffic: each lane is a train of cars with a hashed phase and speed
  const P = 520;
  function laneCars(axis, k, lane, t, lo, hi) {
    // axis 'v': road x = k*B, cars move along y. lane 0 goes +, lane 1 goes -
    const dir = lane === 0 ? 1 : -1;
    const v = 70 + hash(k, lane, 300) * 90;
    const ph = hash(k, lane, 301) * P;
    const off = (lane === 0 ? 1 : -1) * RW / 4;
    const out = [];
    const base = ph + dir * v * t;
    const n0 = Math.floor((lo - base) / P) - 1; const n1 = Math.ceil((hi - base) / P) + 1;
    for (let n = n0; n <= n1; n += 1) {
      if (hash(k * 31 + lane, n, 302) < 0.3) continue;       // gaps
      const s = base + n * P;
      const c = CARS[Math.floor(hash(k, n * 3 + lane, 303) * CARS.length)];
      if (axis === 'v') out.push({ x: k * B + off, y: s, h: dir > 0 ? Math.PI / 2 : -Math.PI / 2, c });
      else out.push({ x: s, y: k * B - off, h: dir > 0 ? 0 : Math.PI, c });
    }
    return out;
  }

  // ---------- the player ----------
  const S = {
    t: 0, frames: 0,
    x: 0 + RW / 4, y: B / 2, heading: -Math.PI / 2, speed: 0,
    dist: 0, distFoot: 0, collisions: 0, npcHits: 0, touching: false,
    inCar: true, carX: 0, carY: 0, carH: 0,
    toggles: 0, handbrakeFrames: 0, gasFrames: 0, brakeFrames: 0, steerSum: 0, steerAbsSum: 0,
    padReads: 0, padFrames: 0, padSeen: false, pad: null, prevY: false,
    keys: {},
  };
  const CAR_R = 15;
  const FOOT_R = 6;

  if (KEYS) {
    addEventListener('keydown', (e) => { S.keys[e.code] = true; });
    addEventListener('keyup', (e) => { S.keys[e.code] = false; });
  }

  function readPad() {
    let pad = null;
    const list = navigator.getGamepads ? navigator.getGamepads() : [];
    S.padReads += 1;
    for (const p of list || []) {
      if (p && p.connected && p.mapping === 'standard') { pad = p; break; }
    }
    const inp = { lx: 0, ly: 0, gas: 0, brake: 0, y: false, rb: false };
    if (pad) {
      S.padSeen = true; S.padFrames += 1;
      inp.lx = pad.axes[0] || 0; inp.ly = pad.axes[1] || 0;
      inp.gas = pad.buttons[7] ? pad.buttons[7].value : 0;
      inp.brake = pad.buttons[6] ? pad.buttons[6].value : 0;
      inp.y = !!(pad.buttons[3] && pad.buttons[3].pressed);
      inp.rb = !!(pad.buttons[5] && pad.buttons[5].pressed);
      S.pad = { id: pad.id, ts: pad.timestamp, axes: Array.from(pad.axes), buttons: Array.from(pad.buttons, (b) => b.value) };
    }
    if (KEYS) {
      const k = S.keys;
      if (k.KeyA) inp.lx = -1; if (k.KeyD) inp.lx = 1;
      if (k.KeyW) { inp.gas = 1; inp.ly = -1; }
      if (k.KeyS) { inp.brake = 1; inp.ly = 1; }
      if (k.KeyF) inp.y = true;
      if (k.Space) inp.rb = true;
    }
    return inp;
  }

  function solidsNear(x, y, rad) {
    const out = [];
    const i0 = Math.floor((x - rad) / B); const i1 = Math.floor((x + rad) / B);
    const j0 = Math.floor((y - rad) / B); const j1 = Math.floor((y + rad) / B);
    for (let i = i0; i <= i1; i += 1) for (let j = j0; j <= j1; j += 1) {
      const b = block(i, j);
      for (const r of b.rects) if (r.solid) out.push(r);
      for (const tr of b.trees) out.push({ x: tr.x - tr.r * 0.5, y: tr.y - tr.r * 0.5, w: tr.r, h: tr.r });
    }
    return out;
  }

  /** push a circle out of rects; -> true if it touched one */
  function collide(o, rad) {
    let hit = false;
    for (const r of solidsNear(o.x, o.y, rad + 60)) {
      const cx = Math.max(r.x, Math.min(o.x, r.x + r.w));
      const cy = Math.max(r.y, Math.min(o.y, r.y + r.h));
      const dx = o.x - cx; const dy = o.y - cy;
      const d2 = dx * dx + dy * dy;
      if (d2 < rad * rad) {
        hit = true;
        const d = Math.sqrt(d2) || 1e-3;
        const push = rad - d;
        if (d2 === 0) { o.y += rad; } else { o.x += (dx / d) * push; o.y += (dy / d) * push; }
      }
    }
    return hit;
  }

  function npcNear(x, y, t) {
    const out = [];
    const ki = Math.round(x / B); const kj = Math.round(y / B);
    for (const k of [ki - 1, ki, ki + 1]) for (const lane of [0, 1]) for (const c of laneCars('v', k, lane, t, y - 200, y + 200)) out.push(c);
    for (const k of [kj - 1, kj, kj + 1]) for (const lane of [0, 1]) for (const c of laneCars('h', k, lane, t, x - 200, x + 200)) out.push(c);
    return out;
  }

  function update(dt) {
    S.t += dt;
    const inp = readPad();
    const yEdge = inp.y && !S.prevY; S.prevY = inp.y;
    if (yEdge) {
      if (S.inCar) {
        S.inCar = false; S.toggles += 1;
        S.carX = S.x; S.carY = S.y; S.carH = S.heading; S.speed = 0;
        S.x += Math.cos(S.heading + Math.PI / 2) * 26; S.y += Math.sin(S.heading + Math.PI / 2) * 26;
      } else if (Math.hypot(S.x - S.carX, S.y - S.carY) < 80) {
        S.inCar = true; S.toggles += 1;
        S.x = S.carX; S.y = S.carY; S.heading = S.carH; S.speed = 0;
      }
    }
    S.steerSum += inp.lx; S.steerAbsSum += Math.abs(inp.lx);
    if (inp.gas > 0.05) S.gasFrames += 1;
    if (inp.brake > 0.05) S.brakeFrames += 1;

    const px = S.x; const py = S.y;
    if (S.inCar) {
      let v = S.speed;
      v += 420 * inp.gas * dt;
      if (inp.brake > 0) {
        if (v > 8) v -= 700 * inp.brake * dt;
        else v = Math.max(-140, v - 220 * inp.brake * dt);
      }
      v -= v * 0.45 * dt;                         // drag
      if (inp.gas === 0 && inp.brake === 0) v -= Math.sign(v) * Math.min(Math.abs(v), 40 * dt);
      if (inp.rb) { v *= Math.max(0, 1 - 1.6 * dt); S.handbrakeFrames += 1; }
      v = Math.max(-140, Math.min(620, v));
      const grip = Math.min(1, Math.abs(v) / 140);
      S.heading += inp.lx * (inp.rb ? 3.6 : 2.3) * grip * Math.sign(v || 1) * dt;
      S.speed = v;
      S.x += Math.cos(S.heading) * v * dt; S.y += Math.sin(S.heading) * v * dt;
      const o = { x: S.x, y: S.y };
      let hit = collide(o, CAR_R);
      // her own distance: where she got to under her own power, walls included
      // (grinding into a wall counts as nothing), traffic shoves not included
      S.dist += Math.hypot(o.x - px, o.y - py);
      for (const c of npcNear(S.x, S.y, S.t)) {
        const dx = o.x - c.x; const dy = o.y - c.y; const d = Math.hypot(dx, dy);
        if (d < CAR_R + 14) { hit = true; const k = (CAR_R + 14 - d) / (d || 1); o.x += dx * k; o.y += dy * k; S.npcTouch = true; }
      }
      if (hit) {
        S.x = o.x; S.y = o.y;
        if (!S.touching) { S.collisions += 1; S.speed = -S.speed * 0.3; }
      }
      S.touching = hit;
      S.moved = (S.moved || 0) + Math.hypot(S.x - px, S.y - py);
    } else {
      S.heading += inp.lx * 2.6 * dt;
      const w = -inp.ly * 110;
      S.x += Math.cos(S.heading) * w * dt; S.y += Math.sin(S.heading) * w * dt;
      const o = { x: S.x, y: S.y };
      const hit = collide(o, FOOT_R);
      S.x = o.x; S.y = o.y;
      if (hit && !S.touching) S.collisions += 1;
      S.touching = hit;
      S.distFoot += Math.hypot(S.x - px, S.y - py);
      S.moved = (S.moved || 0) + Math.hypot(S.x - px, S.y - py);
      S.speed = w;
    }
  }

  // ---------- drawing ----------
  function drawCar(x, y, h, c, w = 24, l = 46, mine = false) {
    g.save(); g.translate(x, y); g.rotate(h);
    g.fillStyle = 'rgba(0,0,0,0.22)'; g.fillRect(-l / 2 + 4, -w / 2 + 5, l, w);
    g.fillStyle = c; g.fillRect(-l / 2, -w / 2, l, w);
    g.fillStyle = mine ? '#ffd7c9' : 'rgba(150,175,200,0.75)';
    g.fillRect(l * 0.08, -w / 2 + 3, l * 0.2, w - 6);                     // windscreen
    g.fillStyle = 'rgba(20,20,24,0.55)'; g.fillRect(-l * 0.32, -w / 2 + 3, l * 0.16, w - 6); // rear window
    if (mine) { g.fillStyle = '#fff6b0'; g.fillRect(l / 2 - 3, -w / 2 + 2, 3, 5); g.fillRect(l / 2 - 3, w / 2 - 7, 3, 5); }
    g.restore();
  }

  function render() {
    const W = cv.width; const H = cv.height;
    const sc = Math.min(W / 1280, H / 720);
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#e6e1d4'; g.fillRect(0, 0, W, H);
    const camX = S.x; const camY = S.y;
    g.setTransform(sc, 0, 0, sc, 0, 0);
    g.translate(640, 470); g.rotate(-S.heading - Math.PI / 2); g.translate(-camX, -camY);
    const R = 1000;
    const i0 = Math.floor((camX - R) / B); const i1 = Math.floor((camX + R) / B);
    const j0 = Math.floor((camY - R) / B); const j1 = Math.floor((camY + R) / B);

    // roads
    g.fillStyle = '#a9a7a2';
    for (let i = i0; i <= i1 + 1; i += 1) g.fillRect(i * B - RW / 2, j0 * B, RW, (j1 - j0 + 2) * B);
    for (let j = j0; j <= j1 + 1; j += 1) g.fillRect(i0 * B, j * B - RW / 2, (i1 - i0 + 2) * B, RW);
    // lane markings
    g.fillStyle = '#f4f1e8';
    for (let i = i0; i <= i1 + 1; i += 1) for (let y = j0 * B; y < (j1 + 2) * B; y += 40) if (((y % B) + B) % B > RW / 2 + 6 && ((y % B) + B) % B < B - RW / 2 - 26) g.fillRect(i * B - 2, y, 4, 20);
    for (let j = j0; j <= j1 + 1; j += 1) for (let x = i0 * B; x < (i1 + 2) * B; x += 40) if (((x % B) + B) % B > RW / 2 + 6 && ((x % B) + B) % B < B - RW / 2 - 26) g.fillRect(x, j * B - 2, 20, 4);
    // blocks
    for (let i = i0; i <= i1; i += 1) for (let j = j0; j <= j1; j += 1) {
      const b = block(i, j);
      const bx = i * B + RW / 2; const by = j * B + RW / 2; const bw = B - RW;
      g.fillStyle = '#d6d0c2'; g.fillRect(bx, by, bw, bw);                       // sidewalk
      g.fillStyle = b.kind === 'park' ? '#bcd3a4' : b.kind === 'lot' ? '#c4c1ba' : '#e1dccf';
      g.fillRect(bx + SW, by + SW, bw - 2 * SW, bw - 2 * SW);
      // crosswalks at this block's top-left intersection
      g.fillStyle = '#efece3';
      for (let s = 0; s < 6; s += 1) {
        g.fillRect(i * B - RW / 2 + 8 + s * 17, j * B + RW / 2 - 16, 9, 12);
        g.fillRect(i * B + RW / 2 - 16, j * B - RW / 2 + 8 + s * 17, 12, 9);
      }
      if (b.kind === 'lot') {
        g.strokeStyle = '#f4f1e8'; g.lineWidth = 2;
        for (let k = 0; k <= 5; k += 1) { g.beginPath(); g.moveTo(bx + SW + 12 + k * 38, by + SW + 22); g.lineTo(bx + SW + 12 + k * 38, by + SW + 84); g.stroke(); }
      }
      for (const r of b.rects) {
        if (r.kind === 'bldg') {
          g.fillStyle = 'rgba(30,25,20,0.28)'; g.fillRect(r.x + r.tall * 0.7, r.y + r.tall, r.w, r.h);   // shadow
          g.fillStyle = r.c; g.fillRect(r.x, r.y, r.w, r.h);
          g.fillStyle = 'rgba(255,255,255,0.07)'; g.fillRect(r.x + 6, r.y + 6, r.w - 12, r.h - 12);
          g.fillStyle = 'rgba(0,0,0,0.35)';
          const n = 1 + Math.floor(r.roof * 3);
          for (let k = 0; k < n; k += 1) g.fillRect(r.x + 14 + k * 22, r.y + 14 + (k % 2) * 18, 14, 10);
        } else if (r.kind === 'car') {
          drawCar(r.x + r.w / 2, r.y + r.h / 2, Math.PI / 2, r.c);
        } else {
          g.fillStyle = r.c; g.fillRect(r.x, r.y, r.w, r.h);
        }
      }
      for (const tr of b.trees) {
        g.fillStyle = 'rgba(30,40,20,0.25)'; g.beginPath(); g.arc(tr.x + 5, tr.y + 7, tr.r, 0, Math.PI * 2); g.fill();
        g.fillStyle = '#2f4a2a'; g.beginPath(); g.arc(tr.x, tr.y, tr.r, 0, Math.PI * 2); g.fill();
        g.fillStyle = '#3d5d35'; g.beginPath(); g.arc(tr.x - tr.r * 0.3, tr.y - tr.r * 0.3, tr.r * 0.55, 0, Math.PI * 2); g.fill();
      }
    }
    // traffic
    for (let k = i0; k <= i1 + 1; k += 1) for (const lane of [0, 1]) for (const c of laneCars('v', k, lane, S.t, j0 * B, (j1 + 2) * B)) drawCar(c.x, c.y, c.h, c.c);
    for (let k = j0; k <= j1 + 1; k += 1) for (const lane of [0, 1]) for (const c of laneCars('h', k, lane, S.t, i0 * B, (i1 + 2) * B)) drawCar(c.x, c.y, c.h, c.c);
    // the player
    if (S.inCar) drawCar(S.x, S.y, S.heading, '#d8452f', 26, 50, true);
    else {
      drawCar(S.carX, S.carY, S.carH, '#d8452f', 26, 50, true);
      g.fillStyle = '#1b1b1f'; g.beginPath(); g.arc(S.x, S.y, 7, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#d8452f'; g.beginPath(); g.arc(S.x + Math.cos(S.heading) * 4, S.y + Math.sin(S.heading) * 4, 3, 0, Math.PI * 2); g.fill();
    }

    // game HUD (part of the console picture)
    g.setTransform(sc, 0, 0, sc, 0, 0);
    g.fillStyle = 'rgba(16,16,20,0.72)'; g.fillRect(1280 - 196, 20, 176, 64);
    g.fillStyle = '#f2efe6'; g.font = '600 30px system-ui, sans-serif'; g.textAlign = 'right';
    g.fillText(String(Math.round(Math.abs(S.speed) * 0.25)), 1280 - 76, 62);
    g.font = '500 13px system-ui, sans-serif'; g.fillText('km/h', 1280 - 34, 62);
    g.textAlign = 'left'; g.font = '500 12px system-ui, sans-serif'; g.fillStyle = 'rgba(242,239,230,0.7)';
    g.fillText((S.dist / 1000).toFixed(2) + ' km', 1280 - 184, 78);
  }

  function resize() {
    const dpr = 1;
    cv.width = Math.round(innerWidth * dpr); cv.height = Math.round(innerHeight * dpr);
  }
  addEventListener('resize', resize); resize();

  let last = performance.now();
  function frame(now) {
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000)); last = now;
    update(dt);
    render();
    S.frames += 1;
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  addEventListener('gamepadconnected', (e) => { S.connectedEvents = (S.connectedEvents || 0) + 1; S.connectedId = e.gamepad && e.gamepad.id; });

  Object.defineProperty(window, '__game', {
    configurable: false,
    get() {
      return JSON.parse(JSON.stringify({
        t: S.t, frames: S.frames, x: S.x, y: S.y, heading: S.heading, speed: S.speed,
        dist: S.dist, distFoot: S.distFoot, moved: S.moved || 0, collisions: S.collisions, inCar: S.inCar, toggles: S.toggles,
        handbrakeFrames: S.handbrakeFrames, gasFrames: S.gasFrames, brakeFrames: S.brakeFrames,
        steerSum: S.steerSum, steerAbsSum: S.steerAbsSum,
        padReads: S.padReads, padFrames: S.padFrames, padSeen: S.padSeen, pad: S.pad,
        connectedEvents: S.connectedEvents || 0, connectedId: S.connectedId || null, keysEnabled: KEYS,
      }));
    },
  });
})();
