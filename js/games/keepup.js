/* Beach Ball: tap the falling ball to bop it back up. Don't let it touch the sand.
 * At 12 bops a second ball drops in. Tuned 2026-11-12 after "too easy/slow". */
(function () {
  'use strict';
  const R = 44;          // ball radius (sprite is 96 with a little padding)
  const SAND = 588;      // top edge of the sand
  const APEX = 300;      // a bop sends the ball about this high above where it was hit
  const REACH = 72;      // a tap this close to a ball's center counts
  const G0 = 1050, G_PER_BOP = 20, G_MAX = 1900;
  const SECOND_BALL_AT = 12, THIRD_BALL_AT = 30;
  const WIND_FROM = 5, WIND_EVERY = 3;
  const windMax = t => Math.min(320, 110 + t * 4);   // gusts get stronger the longer you last

  Arcade.register({
    id: 'keepup',
    name: 'Beach Ball',
    blurb: 'Tap the ball. Keep it off the sand.',
    init(api) {
      const W = api.W;
      const newBall = (x, y, vy) => ({ x, y, vx: 0, vy, rot: 0, spin: 0.6, squash: 0 });
      const balls = [newBall(120 + api.rng() * 120, 320, -560)];
      let grav = G0, score = 0, dead = false, t = 0;
      // Wind runs on a fixed, seeded schedule so both phones get the same gusts at the same time.
      // (Nothing skill-dependent may draw from api.rng, or the two phones' gusts would drift apart.)
      let wind = 0, windTarget = 0, nextGust = WIND_FROM;
      const rings = [], dust = [], streaks = [];
      let hint = 1, newBallBanner = 0;

      function ceiling() { return Math.max(api.view.y0, -80) + R; }

      function bop(x, y) {
        // the closest ball in reach that is falling or near the top of its arc
        let best = null, bestD = REACH * REACH;
        for (const b of balls) {
          const dx = b.x - x, dy = b.y - y, d = dx * dx + dy * dy;
          if (d <= bestD && b.vy > -150) { best = b; bestD = d; }
        }
        if (!best) { rings.push({ x, y, t: 0, hit: false }); return; }
        const dx = best.x - x;
        const room = Math.max(110, Math.min(APEX, best.y - ceiling() - 20));
        best.vy = -Math.sqrt(2 * grav * room);
        best.vx = Math.max(-320, Math.min(320, dx * 7));
        best.spin = best.vx / R;
        best.squash = 1;
        score++;
        api.score(score);
        grav = Math.min(G_MAX, G0 + score * G_PER_BOP);
        rings.push({ x, y, t: 0, hit: true });
        hint = Math.min(hint, 0.999);
        if ((score === SECOND_BALL_AT && balls.length === 1) || (score === THIRD_BALL_AT && balls.length === 2)) {
          // drop the next ball where the others aren't
          const avg = balls.reduce((a, b) => a + b.x, 0) / balls.length;
          // served in mid-air with a little lift, so it's catchable even at high gravity
          balls.push(newBall(avg < W / 2 ? W - 90 : 90, 250, -320));
          newBallBanner = 1.6;
        }
      }

      function die(b) {
        dead = true;
        b.y = SAND - R;
        b.vy = -Math.abs(b.vy) * 0.38;
        b.vx *= 0.5;
        for (let i = 0; i < 18; i++) {
          dust.push({ x: b.x + (Math.random() - 0.5) * 50, y: SAND, vx: (Math.random() - 0.5) * 220, vy: -60 - Math.random() * 180, t: 0 });
        }
        api.over();
      }

      return {
        update(dt) {
          t += dt;
          if (t >= nextGust) {
            windTarget = (api.rng() * 2 - 1) * windMax(t);
            nextGust += WIND_EVERY;
          }
          wind += (windTarget - wind) * Math.min(1, dt * 1.8);
          if (hint < 1) hint = Math.max(0, hint - dt * 2);
          newBallBanner = Math.max(0, newBallBanner - dt);

          for (const b of balls) {
            if (!dead) {
              b.vy += grav * dt;
              b.vx += wind * dt;
              b.vx *= 1 - 0.15 * dt;
              b.x += b.vx * dt;
              b.y += b.vy * dt;
              if (b.x < R) { b.x = R; b.vx = Math.abs(b.vx) * 0.8; b.spin *= -0.6; }
              if (b.x > W - R) { b.x = W - R; b.vx = -Math.abs(b.vx) * 0.8; b.spin *= -0.6; }
              const top = ceiling();
              if (b.y < top) { b.y = top; b.vy = Math.abs(b.vy) * 0.4; }
              if (b.y + R >= SAND) die(b);
            } else {
              // settle into the sand
              b.vy += 1600 * dt;
              b.x += b.vx * dt;
              b.y += b.vy * dt;
              const floor = SAND + 8 - R;
              if (b.y > floor) {
                b.y = floor;
                b.vy = Math.abs(b.vy) > 60 ? -Math.abs(b.vy) * 0.35 : 0;
                b.vx *= 0.7;
                b.spin *= 0.7;
              }
              b.x = Math.max(R, Math.min(W - R, b.x));
            }
            b.rot += b.spin * dt;
            b.spin *= 1 - 0.25 * dt;
            b.squash = Math.max(0, b.squash - dt * 7);
          }

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

          // shadows on the sand
          for (const b of balls) {
            const k = 1 - Math.min(1, Math.max(0, SAND - (b.y + R)) / 520);
            g.fillStyle = 'rgba(140, 95, 40,' + (0.1 + 0.2 * k).toFixed(3) + ')';
            g.beginPath();
            g.ellipse(b.x, SAND + 10, R * (0.45 + 0.55 * k), 6 + 4 * k, 0, 0, Math.PI * 2);
            g.fill();
          }

          // the other player's balls
          if (ghost && api.opp && ghost.y != null) {
            const ghostBalls = [[ghost.x, ghost.y]];
            if (ghost.x2 != null) ghostBalls.push([ghost.x2, ghost.y2]);
            for (const [gx, gy] of ghostBalls) api.draw(g, 'ball', gx, gy, { alpha: ghost.a ? 0.38 : 0.2 });
            g.font = '700 13px ui-rounded, system-ui, sans-serif';
            g.textAlign = 'center';
            g.fillStyle = 'rgba(43,37,34,0.45)';
            g.fillText(api.opp.name, ghost.x, ghost.y - R - 8);
          }

          // my balls, squashed on a bop
          for (const b of balls) {
            g.save();
            g.translate(b.x, b.y);
            g.scale(1 + 0.12 * b.squash, 1 - 0.12 * b.squash);
            api.draw(g, 'ball', 0, 0, { rot: b.rot });
            g.restore();
          }

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

          // hints: first tap, the second ball, the wind
          g.textAlign = 'center';
          if (hint > 0 && !dead) {
            g.globalAlpha = hint;
            g.font = '800 22px ui-rounded, system-ui, sans-serif';
            g.fillStyle = '#2b2522';
            g.fillText('Tap the ball', 180, 140);
            g.globalAlpha = 1;
          }
          if (newBallBanner > 0) {
            g.globalAlpha = Math.min(1, newBallBanner);
            g.font = '800 26px ui-rounded, system-ui, sans-serif';
            g.lineWidth = 5;
            g.strokeStyle = '#2b2522';
            const msg = balls.length === 3 ? 'Three balls!' : 'Two balls!';
            g.strokeText(msg, 180, 160);
            g.fillStyle = '#fff';
            g.fillText(msg, 180, 160);
            g.globalAlpha = 1;
          }
          if (Math.abs(wind) > 35) {
            const arrows = Math.abs(wind) > 160 ? 3 : Math.abs(wind) > 90 ? 2 : 1;
            const a = (wind > 0 ? '→' : '←').repeat(arrows);
            g.font = '700 16px ui-rounded, system-ui, sans-serif';
            g.fillStyle = 'rgba(120, 82, 30, 0.75)';
            g.fillText(wind > 0 ? 'Wind ' + a : a + ' Wind', 180, SAND + 34);
          }
        },

        down(x, y) { if (!dead) bop(x, y); },
        up() {},
        ghost() {
          const o = { x: Math.round(balls[0].x), y: Math.round(balls[0].y), a: dead ? 0 : 1 };
          if (balls[1]) { o.x2 = Math.round(balls[1].x); o.y2 = Math.round(balls[1].y); }
          return o;
        },
        _debug: () => ({ balls, grav, score, dead }),
      };
    },
  });
})();
