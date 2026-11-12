/* Beach Ball: tap the falling ball to bop it back up. Don't let it touch the sand. */
(function () {
  'use strict';
  const R = 44;          // ball radius (sprite is 96 with a little padding)
  const SAND = 588;      // top edge of the sand
  const APEX = 330;      // a bop sends the ball about this high above where it was hit
  const REACH = 84;      // a tap this close to the ball's center counts
  const G0 = 820, G_PER_BOP = 14, G_MAX = 1500;

  Arcade.register({
    id: 'keepup',
    name: 'Beach Ball',
    blurb: 'Tap the ball. Keep it off the sand.',
    init(api) {
      const W = api.W;
      const ball = { x: 120 + api.rng() * 120, y: 320, vx: 0, vy: -560, rot: 0, spin: 0.6, squash: 0 };
      let grav = G0, score = 0, dead = false, t = 0;
      // Wind is on a fixed, seeded schedule so both phones get the same gusts at the same time.
      let wind = 0, windTarget = 0, nextGust = 8;
      const rings = [], dust = [], streaks = [];
      let hint = 1;

      function ceiling() { return Math.max(api.view.y0, -80) + R; }

      function bop(x, y) {
        const dx = ball.x - x, dy = ball.y - y;
        if (dx * dx + dy * dy > REACH * REACH) { rings.push({ x, y, t: 0, hit: false }); return; }
        // Only a ball that's falling (or at the top of its arc) can be bopped, so spam-tapping does nothing.
        if (ball.vy < -150) { rings.push({ x, y, t: 0, hit: false }); return; }
        const room = Math.max(120, Math.min(APEX, ball.y - ceiling() - 20));
        ball.vy = -Math.sqrt(2 * grav * room);
        ball.vx = Math.max(-300, Math.min(300, dx * 6.5));
        ball.spin = ball.vx / R;
        ball.squash = 1;
        score++;
        api.score(score);
        grav = Math.min(G_MAX, G0 + score * G_PER_BOP);
        rings.push({ x, y, t: 0, hit: true });
        hint = Math.min(hint, 0.999);
      }

      return {
        update(dt) {
          t += dt;
          if (t >= nextGust) {
            windTarget = (api.rng() * 2 - 1) * 210;
            nextGust += 4;
          }
          wind += (windTarget - wind) * Math.min(1, dt * 1.5);
          if (hint < 1) hint = Math.max(0, hint - dt * 2);

          if (!dead) {
            ball.vy += grav * dt;
            ball.vx += wind * dt;
            ball.vx *= 1 - 0.15 * dt;
            ball.x += ball.vx * dt;
            ball.y += ball.vy * dt;
            if (ball.x < R) { ball.x = R; ball.vx = Math.abs(ball.vx) * 0.8; ball.spin *= -0.6; }
            if (ball.x > W - R) { ball.x = W - R; ball.vx = -Math.abs(ball.vx) * 0.8; ball.spin *= -0.6; }
            const top = ceiling();
            if (ball.y < top) { ball.y = top; ball.vy = Math.abs(ball.vy) * 0.4; }
            if (ball.y + R >= SAND) {
              dead = true;
              ball.y = SAND - R;
              ball.vy = -Math.abs(ball.vy) * 0.38;
              ball.vx *= 0.5;
              for (let i = 0; i < 18; i++) {
                dust.push({ x: ball.x + (Math.random() - 0.5) * 50, y: SAND, vx: (Math.random() - 0.5) * 220, vy: -60 - Math.random() * 180, t: 0 });
              }
              api.over();
            }
          } else {
            // settle into the sand
            ball.vy += 1600 * dt;
            ball.x += ball.vx * dt;
            ball.y += ball.vy * dt;
            const floor = SAND + 8 - R;
            if (ball.y > floor) {
              ball.y = floor;
              ball.vy = Math.abs(ball.vy) > 60 ? -Math.abs(ball.vy) * 0.35 : 0;
              ball.vx *= 0.7;
              ball.spin *= 0.7;
            }
            ball.x = Math.max(R, Math.min(W - R, ball.x));
          }
          ball.rot += ball.spin * dt;
          ball.spin *= 1 - 0.25 * dt;
          ball.squash = Math.max(0, ball.squash - dt * 7);

          for (const r of rings) r.t += dt;
          while (rings.length && rings[0].t > 0.35) rings.shift();
          for (const d of dust) { d.t += dt; d.vy += 700 * dt; d.x += d.vx * dt; d.y += d.vy * dt; }
          while (dust.length && dust[0].t > 0.9) dust.shift();

          // wind streaks (cosmetic)
          if (Math.abs(wind) > 40 && Math.random() < Math.abs(wind) / 2400) {
            const dir = Math.sign(wind);
            streaks.push({ x: dir > 0 ? api.view.x0 - 40 : api.view.x1 + 40, y: 60 + Math.random() * 440, len: 30 + Math.random() * 50, t: 0 });
          }
          for (const s of streaks) { s.t += dt; s.x += wind * 2.2 * dt; }
          while (streaks.length && streaks[0].t > 3) streaks.shift();
        },

        render(g, ghost) {
          const v = api.view;
          // sky, sea, sand
          const sky = g.createLinearGradient(0, v.y0, 0, SAND - 40);
          sky.addColorStop(0, '#7fcbf7');
          sky.addColorStop(1, '#e3f6ff');
          g.fillStyle = sky;
          g.fillRect(v.x0, v.y0, v.x1 - v.x0, SAND - v.y0);
          const sea = g.createLinearGradient(0, SAND - 44, 0, SAND);
          sea.addColorStop(0, '#4fb8e3');
          sea.addColorStop(1, '#7fd3ef');
          g.fillStyle = sea;
          g.fillRect(v.x0, SAND - 44, v.x1 - v.x0, 44);
          g.fillStyle = 'rgba(255,255,255,0.55)';
          g.fillRect(v.x0, SAND - 6, v.x1 - v.x0, 3);
          const sand = g.createLinearGradient(0, SAND, 0, v.y1);
          sand.addColorStop(0, '#f7e1b0');
          sand.addColorStop(1, '#e8c587');
          g.fillStyle = sand;
          g.fillRect(v.x0, SAND, v.x1 - v.x0, v.y1 - SAND);

          // wind streaks
          g.strokeStyle = 'rgba(255,255,255,0.7)';
          g.lineWidth = 2;
          g.lineCap = 'round';
          for (const s of streaks) {
            g.globalAlpha = Math.max(0, 1 - s.t / 3) * 0.8;
            g.beginPath();
            g.moveTo(s.x, s.y);
            g.lineTo(s.x - Math.sign(wind || 1) * s.len, s.y);
            g.stroke();
          }
          g.globalAlpha = 1;

          // shadow on the sand
          const k = 1 - Math.min(1, Math.max(0, SAND - (ball.y + R)) / 520);
          g.fillStyle = 'rgba(140, 95, 40,' + (0.1 + 0.2 * k).toFixed(3) + ')';
          g.beginPath();
          g.ellipse(ball.x, SAND + 10, R * (0.45 + 0.55 * k), 6 + 4 * k, 0, 0, Math.PI * 2);
          g.fill();

          // the other player's ball
          if (ghost && api.opp && ghost.y != null) {
            api.draw(g, 'ball', ghost.x, ghost.y, { alpha: ghost.a ? 0.38 : 0.2 });
            g.font = '700 13px ui-rounded, system-ui, sans-serif';
            g.textAlign = 'center';
            g.fillStyle = 'rgba(43,37,34,0.45)';
            g.fillText(api.opp.name, ghost.x, ghost.y - R - 8);
          }

          // my ball, squashed on a bop
          g.save();
          g.translate(ball.x, ball.y);
          g.scale(1 + 0.12 * ball.squash, 1 - 0.12 * ball.squash);
          api.draw(g, 'ball', 0, 0, { rot: ball.rot });
          g.restore();

          // tap rings
          for (const r of rings) {
            const p = r.t / 0.35;
            g.strokeStyle = r.hit ? 'rgba(255,255,255,' + (1 - p) + ')' : 'rgba(43,37,34,' + 0.25 * (1 - p) + ')';
            g.lineWidth = r.hit ? 4 : 2;
            g.beginPath();
            g.arc(r.x, r.y, 12 + 40 * p, 0, Math.PI * 2);
            g.stroke();
          }
          // sand puffs
          for (const d of dust) {
            g.fillStyle = 'rgba(214,176,112,' + Math.max(0, 1 - d.t / 0.9) + ')';
            g.beginPath();
            g.arc(d.x, d.y, 3.5, 0, Math.PI * 2);
            g.fill();
          }

          // first-run hint and the wind readout
          g.textAlign = 'center';
          if (hint > 0 && !dead) {
            g.globalAlpha = hint;
            g.font = '800 22px ui-rounded, system-ui, sans-serif';
            g.fillStyle = '#2b2522';
            g.fillText('Tap the ball', 180, 140);
            g.globalAlpha = 1;
          }
          if (Math.abs(wind) > 35) {
            const arrows = Math.abs(wind) > 140 ? 3 : Math.abs(wind) > 80 ? 2 : 1;
            const a = (wind > 0 ? '→' : '←').repeat(arrows);
            g.font = '700 16px ui-rounded, system-ui, sans-serif';
            g.fillStyle = 'rgba(120, 82, 30, 0.75)';
            g.fillText(wind > 0 ? 'Wind ' + a : a + ' Wind', 180, SAND + 34);
          }
        },

        down(x, y) { if (!dead) bop(x, y); },
        up() {},
        ghost() { return { x: Math.round(ball.x), y: Math.round(ball.y), a: dead ? 0 : 1 }; },
      };
    },
  });
})();
