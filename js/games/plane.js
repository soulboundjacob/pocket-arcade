/* Paper Plane: tap to flap, thread the pencil gaps. Seeded gap layout, fixed-step physics. */
(function () {
  'use strict';

  const PX = 100;            // plane x (fixed)
  const TAP_VY = -500;       // flap impulse
  const GRAV = 1750, MAX_FALL = 760;
  const R = 13;              // collision circle radius (sprite is ~30 tall, so this is forgiving)
  const SPACING = 195;       // distance between pairs
  const FIRST_AT = 1.6;      // seconds until the first pair reaches the plane
  // Tuned 2026-11-12 after "too easy/slow": faster start, steeper ramp, tighter gaps.
  const SPEED0 = 185, SPEED_PER = 3, SPEED_MAX = 270;
  const GAP0 = 170, GAP_SHRINK = 2.5, GAP_MIN = 128;
  const CY_MIN = 150, CY_MAX = 490, CY_STEP = 175;
  const BOB_FROM = 10;       // from this pair on, some pencil pairs slide up and down   // gap centre range / max change between pairs
  const BODY_HW = 22;        // pencil body half width (sprite is 56 wide; 44 is forgiving)
  const TIP_LEN = 40, TIP_HW = 7;   // pencil tip: narrow rect, so grazing the point is safe
  const FONT = '800 28px ui-rounded, system-ui, sans-serif';

  // closest-point circle vs axis-aligned rect
  function hitRect(cx, cy, x0, y0, x1, y1) {
    const px = cx < x0 ? x0 : cx > x1 ? x1 : cx;
    const py = cy < y0 ? y0 : cy > y1 ? y1 : cy;
    const dx = cx - px, dy = cy - py;
    return dx * dx + dy * dy < R * R;
  }

  Arcade.register({
    id: 'plane', name: 'Paper Plane', blurb: 'Tap to fly between the pencils.',
    init(api) {
      const sprite = api.me.color === 'pink' ? 'plane_pink' : 'plane_blue';
      const oppSprite = api.opp && api.opp.color === 'pink' ? 'plane_pink' : 'plane_blue';
      const view = api.view;

      let started = false, dead = false, deadT = 0;
      let y = 320, vy = 0, rot = -0.2, spin = 0;
      let sx = 1, sy = 1;               // squash/stretch
      let score = 0, passed = 0;
      let simT = 0;
      let bgScroll = 0;
      let lastCy = 320, made = 0;
      const pairs = [];                 // {x, cy, h, scored}
      const parts = [];
      const pops = [];
      let shake = 0, flash = 0;
      let trailT = 0;

      function speed() { return Math.min(SPEED_MAX, SPEED0 + SPEED_PER * passed); }

      function makePair(x) {
        const lo = Math.max(CY_MIN, lastCy - CY_STEP), hi = Math.min(CY_MAX, lastCy + CY_STEP);
        const cy = lo + api.rng() * (hi - lo);
        const h = Math.max(GAP_MIN, GAP0 - GAP_SHRINK * made);
        const r1 = api.rng(), r2 = api.rng();   // always drawn, so the sequence stays in step
        const amp = made >= BOB_FROM && r1 < 0.5 ? 16 + r1 * 36 : 0;
        lastCy = cy; made++;
        pairs.push({ x, cy, cyNow: cy, h, amp, ph: r2 * 6.283, w: 1.2 + r2 * 0.9, scored: false });
      }

      function burst(x, yy, n, cols, sp, life) {
        for (let i = 0; i < n; i++) {
          const a = Math.random() * 6.283, v = sp * (0.3 + Math.random() * 0.7);
          parts.push({ x, y: yy, vx: Math.cos(a) * v, vy: Math.sin(a) * v, t: 0, life: life * (0.6 + Math.random() * 0.6), r: 1.5 + Math.random() * 2.5, c: cols[(Math.random() * cols.length) | 0] });
        }
      }

      function die() {
        if (dead) return;
        dead = true; deadT = 0;
        vy = -260; spin = (Math.random() < 0.5 ? -1 : 1) * 7;
        shake = 0.35; flash = 0.25;
        burst(PX, y, 22, ['#fff', '#f3ead2', '#c9d8ee', '#ff9eb5'], 260, 0.7);
        api.over();
      }

      function collides() {
        for (const p of pairs) {
          if (p.x > PX + 60 || p.x < PX - 60) continue;
          const gt = p.cyNow - p.h / 2, gb = p.cyNow + p.h / 2;
          // bottom pencil: tip at gb pointing up, body going down
          if (hitRect(PX, y, p.x - TIP_HW, gb, p.x + TIP_HW, gb + TIP_LEN)) return true;
          if (hitRect(PX, y, p.x - BODY_HW, gb + TIP_LEN, p.x + BODY_HW, gb + 600)) return true;
          // top pencil: tip at gt pointing down, body going up
          if (hitRect(PX, y, p.x - TIP_HW, gt - TIP_LEN, p.x + TIP_HW, gt)) return true;
          if (hitRect(PX, y, p.x - BODY_HW, gt - 600, p.x + BODY_HW, gt - TIP_LEN)) return true;
        }
        return false;
      }

      function update(dt) {
        simT += dt;
        // particles / popups always run
        for (let i = parts.length - 1; i >= 0; i--) {
          const p = parts[i]; p.t += dt;
          if (p.t > p.life) { parts.splice(i, 1); continue; }
          p.vy += 500 * dt; p.x += p.vx * dt; p.y += p.vy * dt;
        }
        for (let i = pops.length - 1; i >= 0; i--) {
          const p = pops[i]; p.t += dt; p.y -= 40 * dt;
          if (p.t > 0.8) pops.splice(i, 1);
        }
        shake = Math.max(0, shake - dt); flash = Math.max(0, flash - dt);
        // squash recovers
        sx += (1 - sx) * Math.min(1, dt * 14); sy += (1 - sy) * Math.min(1, dt * 14);

        if (dead) {
          deadT += dt;
          vy = Math.min(MAX_FALL, vy + GRAV * dt); y += vy * dt; rot += spin * dt;
          return;
        }
        // The course scrolls from "Go" on both phones so the two runs stay in step
        // (the other player's ghost lines up with your pencils). Only the plane
        // waits for its first tap, hovering until then.
        const sp = speed();
        bgScroll += sp * dt * 0.3;
        for (const p of pairs) {
          p.x -= sp * dt;
          p.cyNow = p.amp ? Math.max(CY_MIN - 40, Math.min(CY_MAX + 40, p.cy + p.amp * Math.sin(p.ph + simT * p.w))) : p.cy;
        }
        while (pairs.length && pairs[0].x < -80) pairs.shift();
        while (made === 0 || pairs[pairs.length - 1].x + SPACING < view.x1 + 100) {
          makePair(made === 0 ? PX + SPEED0 * FIRST_AT : pairs[pairs.length - 1].x + SPACING);
        }

        if (!started) {
          y = 320 + Math.sin(simT * 3) * 8; rot = Math.sin(simT * 3 + 1) * 0.08;
        } else {
          vy = Math.min(MAX_FALL, vy + GRAV * dt);
          y += vy * dt;
          if (y < R) { y = R; if (vy < 0) vy = 0; }       // ceiling clamps, no death
          // tilt follows velocity, smoothed: -25 deg climbing .. +70 deg diving
          const target = (-25 + (vy + 460) / 1160 * 95) * Math.PI / 180;
          rot += (target - rot) * Math.min(1, dt * 10);
        }

        trailT += dt;
        if (trailT > 0.05) { trailT = 0; parts.push({ x: PX - 22, y: y + 2, vx: -sp * 0.6, vy: 0, t: 0, life: 0.35, r: 1.6, c: 'rgba(120,150,200,0.5)' }); }

        for (const p of pairs) {
          if (!p.scored && p.x < PX) {
            p.scored = true; passed++; score++; api.score(score);
            pops.push({ x: PX + 26, y: y - 28, t: 0, s: '+1' });
          }
        }
        if (collides() || y + R > 640) { y = Math.min(y, 640 - R + 2); die(); }
      }

      function down() {
        if (dead) return;
        if (!started) started = true;
        vy = TAP_VY;
        sx = 0.82; sy = 1.2;
        burst(PX - 16, y + 6, 5, ['#fff', '#dfe8f7'], 90, 0.35);
      }

      function bg(g) {
        const x0 = view.x0, x1 = view.x1, y0 = view.y0, y1 = view.y1;
        g.fillStyle = '#fbf6e9'; g.fillRect(x0, y0, x1 - x0, y1 - y0);
        g.strokeStyle = 'rgba(110,150,210,0.28)'; g.lineWidth = 1.2;
        g.beginPath();
        const first = Math.floor(y0 / 32) * 32;
        for (let yy = first; yy <= y1; yy += 32) { g.moveTo(x0, yy + 0.5); g.lineTo(x1, yy + 0.5); }
        g.stroke();
        // margin lines scroll slowly for parallax; one page every 420 units
        g.strokeStyle = 'rgba(235,110,140,0.35)'; g.lineWidth = 1.6;
        g.beginPath();
        const pg = 420;
        for (let mx = -((bgScroll) % pg) - pg + 60; mx < x1 + pg; mx += pg) { g.moveTo(mx, y0); g.lineTo(mx, y1); g.moveTo(mx + 5, y0); g.lineTo(mx + 5, y1); }
        g.stroke();
        // floor hint
        g.fillStyle = 'rgba(235,110,140,0.10)'; g.fillRect(x0, 640, x1 - x0, Math.max(0, y1 - 640));
      }

      function drawPlane(g, key, yy, rr, alpha, w, h) {
        api.draw(g, key, PX, yy, { rot: rr, alpha, w: 60 * (w || 1), h: 40 * (h || 1) });
      }

      function render(g, ghost) {
        g.save();
        if (shake > 0) g.translate((Math.random() - 0.5) * shake * 18, (Math.random() - 0.5) * shake * 18);
        bg(g);
        for (const p of pairs) {
          const gt = p.cyNow - p.h / 2, gb = p.cyNow + p.h / 2;
          api.draw(g, 'pencil', p.x, gb, {});
          api.draw(g, 'pencil', p.x, gt, { flipY: true });
        }
        if (ghost && ghost.y != null) {
          drawPlane(g, oppSprite, ghost.y, (ghost.r || 0) * Math.PI / 180, ghost.a ? 0.4 : 0.2);
        }
        for (const p of parts) {
          g.globalAlpha = Math.max(0, 1 - p.t / p.life);
          g.fillStyle = p.c; g.beginPath(); g.arc(p.x, p.y, p.r, 0, 6.283); g.fill();
        }
        g.globalAlpha = 1;
        drawPlane(g, sprite, y, rot, 1, sx, sy);
        g.font = FONT; g.textAlign = 'center'; g.fillStyle = '#31507f';
        for (const p of pops) { g.globalAlpha = 1 - p.t / 0.8; g.fillText(p.s, p.x, p.y); }
        g.globalAlpha = 1;
        if (!started && !dead) {
          g.fillStyle = 'rgba(49,80,127,0.75)'; g.fillText('Tap to fly', 180, 250);
        }
        g.restore();
        if (flash > 0) { g.fillStyle = 'rgba(255,255,255,' + (flash * 2.4) + ')'; g.fillRect(view.x0, view.y0, view.x1 - view.x0, view.y1 - view.y0); }
      }

      return {
        update, render, down,
        ghost() { return { y: Math.round(y), r: Math.round(rot * 57.3), a: dead ? 0 : 1 }; },
        // test hook for tools (not used by the engine)
        _debug: () => ({ y, vy, pairs, passed, dead, started }),
      };
    },
  });
})();
