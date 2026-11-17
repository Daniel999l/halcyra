/*
 * A stand-in console home screen for test/probe-mock.mjs: a row of tiles in a
 * canvas, one highlighted. The highlight moves right/left and nothing else
 * moves, like a PlayStation home screen.
 *   window.MENU_INPUT = 'pad'   reads only navigator.getGamepads() (D-pad 14/15, left stick X)
 *   window.MENU_INPUT = 'keys'  reads only ArrowLeft / ArrowRight keydown
 * Ground truth for the test: window.__menu = { index, moves }.
 */
(() => {
  const MODE = window.MENU_INPUT || 'pad';
  const N = 6;
  const cv = document.getElementById('screen');
  const g = cv.getContext('2d');
  const S = { index: 0, moves: 0 };
  window.__menu = S;
  const COLORS = ['#3b6fd8', '#d8533b', '#3bb07a', '#c89b2a', '#8a4fd0', '#2aa6c8'];

  function draw() {
    const w = cv.width = innerWidth; const h = cv.height = innerHeight;
    g.fillStyle = '#0d1220'; g.fillRect(0, 0, w, h);
    const tw = w / (N + 1); const th = tw * 0.62; const gap = tw / (N + 1);
    for (let i = 0; i < N; i += 1) {
      const x = gap + i * (tw + gap); const y = h * 0.42;
      const big = i === S.index;
      const k = big ? 1.25 : 1;
      const ww = tw * k; const hh = th * k;
      g.fillStyle = COLORS[i]; g.globalAlpha = big ? 1 : 0.55;
      g.fillRect(x - (ww - tw) / 2, y - (hh - th) / 2, ww, hh);
      g.globalAlpha = 1;
      if (big) { g.strokeStyle = '#fff'; g.lineWidth = 6; g.strokeRect(x - (ww - tw) / 2, y - (hh - th) / 2, ww, hh); }
    }
    g.fillStyle = '#e8ecf5'; g.font = `${Math.round(h * 0.05)}px sans-serif`;
    g.fillText(`Tile ${S.index + 1}`, gap, h * 0.25);
  }
  const move = (d) => { const n = Math.max(0, Math.min(N - 1, S.index + d)); if (n !== S.index) { S.index = n; S.moves += 1; draw(); } };
  addEventListener('resize', draw);
  draw();

  if (MODE === 'keys') {
    addEventListener('keydown', (e) => {
      if (e.repeat) return;
      if (e.key === 'ArrowRight') move(1);
      if (e.key === 'ArrowLeft') move(-1);
    });
    return;
  }
  let prev = { r: false, l: false, sx: 0 };
  const poll = () => {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    const p = [...(pads || [])].find((x) => x && x.connected);
    if (p) {
      const r = !!(p.buttons[15] && p.buttons[15].pressed); const l = !!(p.buttons[14] && p.buttons[14].pressed);
      const ax = p.axes[0] || 0; const sx = ax > 0.6 ? 1 : ax < -0.6 ? -1 : 0;
      if (r && !prev.r) move(1);
      if (l && !prev.l) move(-1);
      if (sx !== 0 && sx !== prev.sx) move(sx);
      prev = { r, l, sx };
    }
    requestAnimationFrame(poll);
  };
  requestAnimationFrame(poll);
})();
