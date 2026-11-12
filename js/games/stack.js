/* Pancake Stack: tap to drop the sliding pancake. Overhang breaks off; no overlap ends the run. */
(function () {
  'use strict';

  const FULL_W = 140, MIN_X = 40, MAX_X = 320;   // pancake width, slide range (by centre)
  const LAYER_H = 22;            // vertical step per layer, so pancakes overlap like a real stack
  const PANCAKE_H = 40;
  const BASE_Y = 525;            // world y of the first pancake's centre (sits on the plate)
  const PLATE = { x: 180, y: 555 };
  const HOVER = 205;             // slider sits this far above the stack top
  const SPEED0 = 110, SPEED_PER = 4, SPEED_MAX = 300;    // reaches the cap at layer 48
  const FALL_G = 7000, FALL_MAX = 1500;                   // ~0.23 s drop from the hover height
  const SNAP = 4;                // offset under this = Perfect (snaps)
  const REGROW = 10, REGROW_EVERY = 3;
  const MIN_OVERLAP = 4;         // less than this counts as a miss
  const CAM_TOP = 360;           // the top of the stack is held near this screen y
  const FONT = '800 28px ui-rounded, system-ui, sans-serif';
  const SMALL = '800 12px ui-rounded, system-ui, sans-serif';

  Arcade.register({
    id: 'stack', name: 'Pancake Stack', blurb: 'Tap to drop. Stack them high.',
    init(api) {
      const view = api.view;
      // layers[0] is the base on the plate; each {x, w, sq} (sq = landing squash, decays)
      const layers = [{ x: 180, w: FULL_W, sq: 0 }];
      let n = 0;                                   // pancakes stacked (score)
      let cam = 0;
      let state = 'slide';                         // slide | drop | lost
      let mx = 0, mdir = 1, mw = FULL_W, my = 0, mvy = 0, mAng = 0, mSpin = 0, spawnT = 0;
      let streak = 0;
      let butterOff = 0, butterV = 0;
      const pieces = [], parts = [], pops = [], rings = [];
      let shake = 0, flash = 0;

      const topWorldY = () => BASE_Y - LAYER_H * n;
      const speed = () => Math.min(SPEED_MAX, SPEED0 + SPEED_PER * n);

      function spawn() {
        mdir = api.rng() < 0.5 ? -1 : 1;           // seeded start side and offset
        mx = MIN_X + api.rng() * (MAX_X - MIN_X);
        mw = layers[layers.length - 1].w;
        my = topWorldY() - HOVER; mvy = 0; mAng = 0; spawnT = 0;
        state = 'slide';
      }
      spawn();

      function crumbs(x, y, c, nn, sp) {
        for (let i = 0; i < nn; i++) {
          const a = -Math.PI * Math.random(), v = sp * (0.3 + Math.random() * 0.7);
          parts.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, t: 0, life: 0.4 + Math.random() * 0.4, r: 1.5 + Math.random() * 2, c: c[(Math.random() * c.length) | 0] });
        }
      }
      const pop = (s, x, y, col, big) => pops.push({ s, x, y, col, big, t: 0 });

      function land() {
        const top = layers[layers.length - 1];
        const l = Math.max(mx - mw / 2, top.x - top.w / 2), r = Math.min(mx + mw / 2, top.x + top.w / 2);
        const overlap = r - l;
        if (overlap < MIN_OVERLAP) { miss(); return; }
        const off = Math.abs(mx - top.x);
        let nx, nw;
        if (off < SNAP) {                           // perfect: snap and keep the width
          nx = top.x; nw = mw; streak++;
          pop('Perfect!', nx, my - 40, '#ff9d00', true);
          rings.push({ x: nx, y: my, t: 0 });
          crumbs(nx, my, ['#ffd23a', '#fff'], 14, 200);
          if (streak % REGROW_EVERY === 0 && nw < FULL_W) { nw = Math.min(FULL_W, nw + REGROW); pop('Wider!', nx, my - 72, '#4aa54a', false); }
        } else {
          streak = 0;
          nx = (l + r) / 2; nw = overlap;
          const pw = mw - overlap;                  // the overhang breaks off as its own piece
          if (pw > 2) {
            const side = mx > top.x ? 1 : -1;
            const pxc = side > 0 ? (r + mx + mw / 2) / 2 : (mx - mw / 2 + l) / 2;
            pieces.push({ x: pxc, y: my, w: pw, vx: side * (50 + Math.random() * 40), vy: -60, ang: 0, spin: side * (2 + Math.random() * 3) });
          }
        }
        layers.push({ x: nx, w: nw, sq: 1 });
        n++; api.score(n);
        butterOff = -16; butterV = 0;
        crumbs(nx, my + 6, ['#f4c26b', '#e39a3b', '#fff0c8'], 6, 120);
        shake = Math.max(shake, 0.08);
        spawn();
      }

      function miss() {                              // no overlap: it keeps falling, run over
        state = 'lost';
        mSpin = (mx > layers[layers.length - 1].x ? 1 : -1) * 4;
        mvy = Math.max(mvy, 600);
        shake = 0.35; flash = 0.2;
        pop('Miss!', mx, my - 30, '#c0392b', true);
        api.over();
      }

      function update(dt) {
        for (let i = parts.length - 1; i >= 0; i--) {
          const q = parts[i]; q.t += dt;
          if (q.t > q.life) { parts.splice(i, 1); continue; }
          q.vy += 600 * dt; q.x += q.vx * dt; q.y += q.vy * dt;
        }
        for (let i = pops.length - 1; i >= 0; i--) { const q = pops[i]; q.t += dt; q.y -= 28 * dt; if (q.t > 0.9) pops.splice(i, 1); }
        for (let i = rings.length - 1; i >= 0; i--) { rings[i].t += dt; if (rings[i].t > 0.4) rings.splice(i, 1); }
        for (let i = pieces.length - 1; i >= 0; i--) {   // overhang pieces tumble off-screen
          const q = pieces[i]; q.vy += 1300 * dt; q.x += q.vx * dt; q.y += q.vy * dt; q.ang += q.spin * dt;
          if (q.y > topWorldY() + 900 + view.y1) pieces.splice(i, 1);
        }
        for (const L of layers) L.sq = Math.max(0, L.sq - dt * 5);
        shake = Math.max(0, shake - dt); flash = Math.max(0, flash - dt);
        // butter hops when a layer lands
        butterV += 2600 * dt; butterOff += butterV * dt;
        if (butterOff > 0) { butterOff = 0; butterV = butterV > 120 ? -butterV * 0.3 : 0; }
        // camera eases so the stack top stays near CAM_TOP
        const target = Math.max(0, CAM_TOP - topWorldY());
        cam += (target - cam) * Math.min(1, dt * 4);

        if (state === 'slide') {
          spawnT += dt;
          mx += mdir * speed() * dt;
          if (mx > MAX_X) { mx = 2 * MAX_X - mx; mdir = -1; } else if (mx < MIN_X) { mx = 2 * MIN_X - mx; mdir = 1; }
          my = topWorldY() - HOVER;
        } else if (state === 'drop') {
          mvy = Math.min(FALL_MAX, mvy + FALL_G * dt);
          my += mvy * dt;
          const landY = topWorldY() - LAYER_H;
          if (my >= landY) {
            const top = layers[layers.length - 1];
            if (Math.min(mx + mw / 2, top.x + top.w / 2) - Math.max(mx - mw / 2, top.x - top.w / 2) < MIN_OVERLAP) miss();
            else { my = landY; land(); }
          }
        } else if (state === 'lost') {
          mvy += 1500 * dt; my += mvy * dt; mAng += mSpin * dt;
        }
      }

      function down() { if (state === 'slide') { state = 'drop'; mvy = 0; } }

      // ---------- drawing
      function bg(g) {
        const x0 = view.x0, y0 = view.y0, w = view.x1 - x0, h = view.y1 - y0;
        const gr = g.createLinearGradient(0, y0, 0, view.y1);
        gr.addColorStop(0, '#cfe6f7'); gr.addColorStop(1, '#fff4dc');
        g.fillStyle = gr; g.fillRect(x0, y0, w, h);
        g.strokeStyle = 'rgba(120,160,200,0.14)'; g.lineWidth = 1.5;        // faint stripes drift with the camera
        g.beginPath();
        const off = cam % 80;
        for (let y = y0 - 80 + off; y < view.y1; y += 80) { g.moveTo(x0, y); g.lineTo(view.x1, y); }
        g.stroke();
        const ty = 578 + cam;                                                // table top, scrolls away as the stack grows
        if (ty < view.y1) { g.fillStyle = '#e8c9a0'; g.fillRect(x0, ty, w, view.y1 - ty); g.fillStyle = 'rgba(120,70,30,0.12)'; g.fillRect(x0, ty, w, 4); }
      }

      function render(g, ghost) {
        g.save();
        if (shake > 0) g.translate((Math.random() - 0.5) * shake * 14, (Math.random() - 0.5) * shake * 14);
        bg(g);
        // opponent's height marker
        if (ghost && ghost.n != null && api.opp) {
          const gy = BASE_Y - LAYER_H * ghost.n - PANCAKE_H / 2 + cam;
          if (gy > view.y0 + 10 && gy < view.y1 - 10) {
            g.save(); g.globalAlpha = 0.4; g.strokeStyle = api.opp.color === 'pink' ? '#d6336c' : '#1c6fd1'; g.lineWidth = 2; g.setLineDash([8, 6]);
            g.beginPath(); g.moveTo(30, gy); g.lineTo(330, gy); g.stroke(); g.setLineDash([]);
            g.fillStyle = g.strokeStyle; g.font = SMALL; g.textAlign = 'right'; g.fillText(api.opp.name, 346, gy - 5);
            g.restore();
          }
        }
        api.draw(g, 'plate', PLATE.x, PLATE.y + cam, {});
        for (let i = 0; i < layers.length; i++) {
          const L = layers[i], y = BASE_Y - LAYER_H * i + cam;
          api.draw(g, 'pancake', L.x, y, { w: L.w * (1 + 0.1 * L.sq), h: PANCAKE_H * (1 - 0.3 * L.sq) });
        }
        const top = layers[layers.length - 1];
        api.draw(g, 'butter', top.x, BASE_Y - LAYER_H * n + cam - PANCAKE_H / 2 + 6 + butterOff, {});
        for (const q of pieces) api.draw(g, 'pancake', q.x, q.y + cam, { w: q.w, h: PANCAKE_H, rot: q.ang });
        // the sliding / dropping pancake
        const grow = state === 'slide' ? Math.min(1, spawnT / 0.12) : 1;
        api.draw(g, 'pancake', mx, my + cam, { w: mw * (0.7 + 0.3 * grow), h: PANCAKE_H * (0.7 + 0.3 * grow), rot: mAng });
        for (const q of rings) {
          g.globalAlpha = 1 - q.t / 0.4; g.strokeStyle = '#ffb300'; g.lineWidth = 3;
          g.beginPath(); g.ellipse(q.x, q.y + cam, 40 + q.t * 160, 12 + q.t * 40, 0, 0, 6.283); g.stroke();
        }
        for (const q of parts) {
          g.globalAlpha = Math.max(0, 1 - q.t / q.life); g.fillStyle = q.c;
          g.beginPath(); g.arc(q.x, q.y + cam, q.r, 0, 6.283); g.fill();
        }
        g.globalAlpha = 1; g.textAlign = 'center';
        for (const q of pops) {
          g.globalAlpha = Math.min(1, (0.9 - q.t) * 2.2); g.fillStyle = q.col;
          g.font = q.big ? FONT : '800 20px ui-rounded, system-ui, sans-serif';
          const sc = q.t < 0.1 ? 0.6 + q.t * 6 : 1.2 - Math.min(0.2, q.t - 0.1);
          g.save(); g.translate(Math.max(60, Math.min(300, q.x)), q.y + cam); g.scale(sc, sc); g.fillText(q.s, 0, 0); g.restore();
        }
        g.globalAlpha = 1;
        if (n === 0 && state === 'slide') { g.font = '800 20px ui-rounded, system-ui, sans-serif'; g.fillStyle = 'rgba(70,90,120,0.7)'; g.fillText('Tap to drop', 180, 120); }
        g.restore();
        if (flash > 0) { g.fillStyle = 'rgba(255,255,255,' + (flash * 2.5) + ')'; g.fillRect(view.x0, view.y0, view.x1 - view.x0, view.y1 - view.y0); }
      }

      return {
        update, render, down,
        ghost() { return { n }; },
        _debug: () => ({ mx, mdir, mw, top: layers[layers.length - 1], n, state, speed: speed() }),
      };
    },
  });
})();
