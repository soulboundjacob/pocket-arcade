/* Pancake Flip: hold to charge the power needle, release to flick, land the pancake flat.
 * Spin and flight time are functions of power; per-toss seeded spin multiplier shifts the zones
 * (the meter always shows the zones for the current toss). */
(function () {
  'use strict';

  const PAN_X = 190, PAN_Y = 560;     // skillet anchor (cooking-surface centre)
  const REST_Y = 548;                 // pancake centre while sitting in the pan
  const G = 1900;                     // gravity for the toss arc (peak ~72 at T=.55, ~314 at T=1.15)
  // Tuned 2026-11-12 after "too easy/slow": faster needle, narrower zones, quicker tosses.
  const SWEEP0 = 0.95, SWEEP_MIN = 0.5, SWEEP_FACTOR = 0.95;   // needle sweep seconds 0->1
  // Landing windows narrow with every good toss (gradual difficulty): ±34° → ±24°, perfect ±12° → ±8°.
  const okDeg = wins => Math.max(24, 34 - wins * 0.5);
  const perfectDeg = wins => Math.max(8, 12 - wins * 0.2);
  const LIVES = 3;
  // meter geometry (p=0 at the bottom, p=1 at the top)
  const MX = 316, MW = 20, MTOP = 190, MBOT = 530;
  const FONT = '800 28px ui-rounded, system-ui, sans-serif';
  const SMALL = '800 13px ui-rounded, system-ui, sans-serif';

  // total rotation in degrees for power p and spin multiplier m: convex in p so high counts are narrow
  const rot = (p, m) => 180 * (0.15 + 5.2 * Math.pow(p, 1.35)) * m;
  const flight = p => 0.55 + 0.6 * p;                    // seconds airborne
  // inverse of rot(): the power that gives `deg` degrees (clamped to 0..1)
  function powerFor(deg, m) {
    const x = (deg / (180 * m) - 0.15) / 5.2;
    return x <= 0 ? 0 : Math.min(1, Math.pow(x, 1 / 1.35));
  }
  // zones for flips 1..5 at multiplier m: {k, lo, hi, plo, phi}; skipped when unreachable
  function zonesFor(m, wins) {
    const OK_DEG = okDeg(wins), PERFECT_DEG = perfectDeg(wins);
    const z = [];
    for (let k = 1; k <= 5; k++) {
      const lo = powerFor(180 * k - OK_DEG, m), hi = powerFor(180 * k + OK_DEG, m);
      if (lo >= 1 || hi <= lo) continue;
      z.push({ k, lo, hi, plo: powerFor(180 * k - PERFECT_DEG, m), phi: powerFor(180 * k + PERFECT_DEG, m) });
    }
    return z;
  }
  const meterY = p => MBOT - p * (MBOT - MTOP);

  Arcade.register({
    id: 'flip', name: 'Pancake Flip', blurb: 'Hold, let go, land it flat.',
    init(api) {
      const view = api.view;
      let state = 'ready';          // ready | fly | settle | splat | dead
      let holding = false, p = 0, dir = 1;
      let wins = 0, lives = LIVES, score = 0;
      let mul = 1, zones = [];
      let fT = 0, fTotal = 1, fRot = 0, fP = 0, lastP = -1;
      let px = PAN_X, py = REST_Y, pAng = 0, pVx = 0, pVy = 0, pSpin = 0;   // pancake
      let sx = 1, sy = 1;           // pancake squash
      let timer = 0;                // settle / splat countdown
      let panKick = 0;              // pan flick animation 0..1
      let lostPop = [];             // lives popping
      const parts = [], pops = [];
      let shake = 0, simT = 0;

      function prepare() {          // seeded per-toss spin variation: 0.88..1.12 (zones move every toss)
        mul = 0.88 + api.rng() * 0.24;
        zones = zonesFor(mul, wins);
      }
      prepare();

      const sweep = () => Math.max(SWEEP_MIN, SWEEP0 * Math.pow(SWEEP_FACTOR, wins));
      const frameOf = deg => ((Math.round(deg / 10) % 36) + 36) % 36;

      function crumbs(x, y, n, cols, sp) {
        for (let i = 0; i < n; i++) {
          const a = -Math.PI * Math.random(), v = sp * (0.3 + Math.random() * 0.7);
          parts.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, t: 0, life: 0.5 + Math.random() * 0.4, r: 1.5 + Math.random() * 2.2, c: cols[(Math.random() * cols.length) | 0] });
        }
      }
      const pop = (s, x, y, c, big) => pops.push({ s, x, y, c, t: 0, big });

      function land() {
        const k = Math.round(fRot / 180), err = Math.abs(fRot - 180 * k);
        px = PAN_X; py = REST_Y;
        if (err <= okDeg(wins)) {
          const perfect = err <= perfectDeg(wins);
          let pts = k * k * (perfect ? 2 : 1);
          if (k === 0) pts = 0;
          wins++;
          if (pts > 0) { score += pts; api.score(score); }
          pAng = 0; sx = 1.3; sy = 0.7; shake = 0.12 + 0.03 * k;
          state = 'settle'; timer = 0.25; panKick = 1;
          crumbs(px, py + 6, 8 + 3 * k, ['#f4c26b', '#e39a3b', '#fff0c8'], 140 + 30 * k);
          if (pts > 0) {
            pop('+' + pts, px, py - 70, perfect ? '#ffb300' : '#c4651a', true);
            pop(perfect ? 'Perfect!' : 'x' + k, px, py - 105, perfect ? '#ff7a00' : '#8a4b1a', false);
          } else pop('Too low!', px, py - 70, '#8a4b1a', false);
          if (perfect) crumbs(px, py - 20, 14, ['#ffd23a', '#fff'], 220);
        } else {
          // landed on its edge: bounces off the rim and tumbles out of the pan
          lives--; lostPop.push({ i: lives, t: 0 });
          const side = Math.random() < 0.5 ? -1 : 1;
          pAng = fRot; pVx = side * (120 + Math.random() * 60); pVy = -260; pSpin = side * 420;
          state = 'splat'; timer = 0.7; shake = 0.3; panKick = 1;
          crumbs(px, py + 6, 16, ['#f4c26b', '#e39a3b', '#c97b2a'], 220);
          pop('Splat!', px, py - 80, '#c0392b', true);
          if (lives <= 0) { state = 'dead'; api.over(); }
        }
      }

      function update(dt) {
        simT += dt;
        for (let i = parts.length - 1; i >= 0; i--) {
          const q = parts[i]; q.t += dt;
          if (q.t > q.life) { parts.splice(i, 1); continue; }
          q.vy += 600 * dt; q.x += q.vx * dt; q.y += q.vy * dt;
        }
        for (let i = pops.length - 1; i >= 0; i--) { const q = pops[i]; q.t += dt; q.y -= 30 * dt; if (q.t > 1.0) pops.splice(i, 1); }
        for (let i = lostPop.length - 1; i >= 0; i--) { lostPop[i].t += dt; if (lostPop[i].t > 0.6) lostPop.splice(i, 1); }
        shake = Math.max(0, shake - dt);
        panKick = Math.max(0, panKick - dt * 5);
        sx += (1 - sx) * Math.min(1, dt * 12); sy += (1 - sy) * Math.min(1, dt * 12);

        if (state === 'ready') {
          if (holding) {                 // ping-pong needle
            p += dir * dt / sweep();
            if (p >= 1) { p = 1; dir = -1; } else if (p <= 0) { p = 0; dir = 1; }
          }
        } else if (state === 'fly') {
          fT += dt;
          const t = Math.min(fT, fTotal);
          py = REST_Y - (G / 2) * t * (fTotal - t);
          pAng = fRot * (t / fTotal);
          if (fT >= fTotal) land();
        } else if (state === 'settle') {
          timer -= dt;
          if (timer <= 0) { state = 'ready'; prepare(); }
        } else if (state === 'splat' || state === 'dead') {
          pVy += 1500 * dt; px += pVx * dt; py += pVy * dt; pAng += pSpin * dt;
          if (state === 'splat') {
            timer -= dt;
            if (timer <= 0) { state = 'ready'; px = PAN_X; py = REST_Y; pAng = 0; sx = 1.3; sy = 0.7; prepare(); }
          }
        }
      }

      function down() {
        if (state !== 'ready') return;
        holding = true; p = 0; dir = 1;
      }
      function up() {
        if (!holding) return;
        holding = false;
        if (state !== 'ready') return;
        fP = lastP = p; fRot = rot(p, mul); fTotal = flight(p); fT = 0;
        state = 'fly'; panKick = 1; sx = 0.8; sy = 1.25;
        crumbs(PAN_X, PAN_Y - 10, 5, ['#fff0c8', '#f4c26b'], 120);
      }

      // ---------- drawing
      function bg(g) {
        const x0 = view.x0, y0 = view.y0, w = view.x1 - x0, h = view.y1 - y0;
        const gr = g.createLinearGradient(0, y0, 0, view.y1);
        gr.addColorStop(0, '#fff6e2'); gr.addColorStop(1, '#ffd9bd');
        g.fillStyle = gr; g.fillRect(x0, y0, w, h);
        g.strokeStyle = 'rgba(190,120,80,0.10)'; g.lineWidth = 1.5;   // faint tile lines
        g.beginPath();
        for (let x = Math.floor(x0 / 60) * 60; x <= view.x1; x += 60) { g.moveTo(x, y0); g.lineTo(x, view.y1); }
        for (let y = Math.floor(y0 / 60) * 60; y <= view.y1; y += 60) { g.moveTo(x0, y); g.lineTo(view.x1, y); }
        g.stroke();
        g.fillStyle = 'rgba(160,90,50,0.16)'; g.fillRect(x0, 575, w, Math.max(0, view.y1 - 575));   // counter edge
      }

      function drawMeter(g, z, needle, alpha, ghostTick) {
        g.save(); g.globalAlpha = alpha;
        g.fillStyle = 'rgba(90,50,30,0.22)';
        g.beginPath(); g.roundRect ? g.roundRect(MX - 3, MTOP - 6, MW + 6, MBOT - MTOP + 12, 8) : g.rect(MX - 3, MTOP - 6, MW + 6, MBOT - MTOP + 12);
        g.fill();
        g.font = SMALL; g.textAlign = 'center';
        for (const q of z) {
          const yt = meterY(q.hi), yb = meterY(q.lo);
          g.fillStyle = 'hsl(' + (38 - q.k * 4) + ',85%,' + (68 - q.k * 3) + '%)';
          g.fillRect(MX, yt, MW, yb - yt);
          g.fillStyle = '#fff5b8'; g.fillRect(MX, meterY(q.phi), MW, meterY(q.plo) - meterY(q.phi));
          g.strokeStyle = 'rgba(120,60,20,0.7)'; g.lineWidth = 1; g.strokeRect(MX + 0.5, yt, MW - 1, yb - yt);
          g.fillStyle = '#7a3d12'; g.fillText(String(q.k), MX - 11, (yt + yb) / 2 + 4.5);
        }
        if (needle != null) {
          const ny = meterY(needle);
          g.fillStyle = '#d6322b'; g.fillRect(MX - 5, ny - 1.5, MW + 10, 3);
          g.beginPath(); g.moveTo(MX + MW + 5, ny); g.lineTo(MX + MW + 14, ny - 6); g.lineTo(MX + MW + 14, ny + 6); g.fill();
        }
        if (ghostTick != null) {   // where the last toss was released
          const ny = meterY(ghostTick);
          g.fillStyle = 'rgba(60,30,10,0.6)'; g.beginPath(); g.arc(MX + MW / 2, ny, 3, 0, 6.283); g.fill();
        }
        g.restore();
      }

      function render(g, ghost) {
        g.save();
        if (shake > 0) g.translate((Math.random() - 0.5) * shake * 16, (Math.random() - 0.5) * shake * 16);
        bg(g);
        // skillet with a flick: tilts and hops on release
        const k = panKick;
        api.draw(g, 'skillet', PAN_X, PAN_Y - 10 * k * k, { rot: -0.14 * k });
        // pancake
        const visible = state !== 'dead' || py < view.y1 + 150;
        if (visible) {
          const frame = state === 'settle' || (state === 'ready') ? 0 : frameOf(pAng);
          api.draw(g, 'pancake_flip', px, py, { frame, w: 130 * sx, h: 130 * sy });
        }
        for (const q of parts) {
          g.globalAlpha = Math.max(0, 1 - q.t / q.life); g.fillStyle = q.c;
          g.beginPath(); g.arc(q.x, q.y, q.r, 0, 6.283); g.fill();
        }
        g.globalAlpha = 1;
        drawMeter(g, zones, state === 'ready' ? (holding ? p : null) : null, state === 'ready' ? 1 : 0.55, state === 'ready' ? null : lastP >= 0 ? lastP : null);
        // my lives, small, centered under the app's score (the top corners hold the quit button and the opponent's score)
        for (let i = 0; i < LIVES; i++) {
          let a = i < lives ? 1 : 0.18, w = 44, h = 12.6;
          for (const l of lostPop) if (l.i === i) { const f = l.t / 0.6; a = 1 - f * 0.82; w *= 1 + f * 0.5; h *= 1 + f * 0.5; }
          api.draw(g, 'pancake', 128 + i * 52, 104, { w, h, alpha: a });
        }
        // opponent lives, faint, under the meter
        if (ghost && ghost.l != null) {
          for (let i = 0; i < LIVES; i++) api.draw(g, 'pancake', MX - 6 + i * 22, 556, { w: 20, h: 5.7, alpha: i < ghost.l ? 0.4 : 0.1 });
        }
        g.textAlign = 'center';
        for (const q of pops) {
          g.globalAlpha = Math.min(1, (1 - q.t) * 2); g.fillStyle = q.c;
          g.font = q.big ? FONT : '800 22px ui-rounded, system-ui, sans-serif';
          const sc = q.t < 0.12 ? 0.6 + q.t / 0.12 * 0.6 : 1.2 - Math.min(0.2, (q.t - 0.12));
          g.save(); g.translate(q.x, q.y); g.scale(sc, sc); g.fillText(q.s, 0, 0); g.restore();
        }
        g.globalAlpha = 1;
        if (state === 'ready' && !holding && wins === 0 && lives === LIVES && score === 0) {
          g.font = '800 20px ui-rounded, system-ui, sans-serif'; g.fillStyle = 'rgba(120,60,20,0.7)';
          g.fillText('Hold, release on a number', 170, 300);
        }
        g.restore();
      }

      return {
        update, render, down, up,
        ghost() { return { s: score, l: Math.max(0, lives) }; },
        _debug: () => ({ p, zones, mul, sweep: sweep(), state, score, lives }),
      };
    },
  });
})();
