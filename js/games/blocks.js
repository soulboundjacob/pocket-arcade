/* Block Duel: head-to-head falling-block puzzle with power-ups.
 * Both phones deal the same seeded piece + power-cell sequence (api.rng is used ONLY for dealing).
 * Clear rows to score and send junk; power cells in cleared rows fill a 2-slot power queue.
 * In versus the first player to top out loses (def.versus). */
(function () {
  'use strict';

  const COLS = 9, ROWS = 16, CELL = 30;
  const BX = 14, BY = 112, BW = COLS * CELL, BH = ROWS * CELL;
  const BTN = { x: 294, y: 300, w: 58, h: 72 };
  const MINI = { x: 296, y: 312, c: 6 };
  // Power-up slots, side by side under the board: tap the one you want to use.
  const MAX_POWERS = 3;
  const SLOT = { y: BY + BH + 6, h: 38, w: 84, gap: 9 };
  const slotX = i => BX + i * (SLOT.w + SLOT.gap);
  const FONT = 'ui-rounded, system-ui, sans-serif';

  const LOCK_DELAY = 0.5, MAX_RESETS = 12;
  const COL_PX = 26;                 // finger travel per column
  const SOFT_START = 24, SOFT_ROW = 22;
  const TAP_MOVE = 12, TAP_TIME = 0.35;
  const FLICK_DIST = 50, FLICK_TIME = 0.3;
  const POWER_CHANCE = 0.2;
  const RUSH_SECS = 8, SLOW_SECS = 10;
  const JUNK_CAP = 12, JUNK_PUSH_MAX = 6;
  const LINE_SCORE = [0, 100, 300, 600, 1000, 1500];
  const ATTACK = [0, 0, 1, 2, 3, 4];
  const KICKS = [[0, 0], [-1, 0], [1, 0], [0, -1], [-2, 0], [2, 0], [-1, -1], [1, -1]];

  const PIECES = [
    { n: 'I3', col: 'yellow', c: [[0, 0], [1, 0], [2, 0]] },
    { n: 'V3', col: 'teal', c: [[0, 0], [0, 1], [1, 1]] },
    { n: 'O4', col: 'blue', c: [[0, 0], [1, 0], [0, 1], [1, 1]] },
    { n: 'T4', col: 'orange', c: [[0, 0], [1, 0], [2, 0], [1, 1]] },
    { n: 'S4', col: 'pink', c: [[1, 0], [2, 0], [0, 1], [1, 1]] },
    { n: 'Z4', col: 'green', c: [[0, 0], [1, 0], [1, 1], [2, 1]] },
    { n: 'L4', col: 'purple', c: [[0, 0], [0, 1], [0, 2], [1, 2]] },
    { n: 'J4', col: 'red', c: [[1, 0], [1, 1], [1, 2], [0, 2]] },
    { n: 'I4', col: 'yellow', c: [[0, 0], [1, 0], [2, 0], [3, 0]] },
    { n: 'P5', col: 'blue', c: [[0, 0], [1, 0], [0, 1], [1, 1], [0, 2]] },
  ];
  // one letter per color for the ghost string and the grid
  const LETTER = { red: 'r', orange: 'o', yellow: 'y', green: 'g', teal: 't', blue: 'b', purple: 'u', pink: 'k', junk: 'j' };
  const SPRITE = {};
  for (const k of Object.keys(LETTER)) SPRITE[LETTER[k]] = 'block_' + k;
  const POWER_NAME = { bomb: 'Bomb', slow: 'Slow', junk: 'Junk', rush: 'Rush', mirror: 'Mirror' };
  const W_SOLO = [['bomb', 2], ['slow', 2]];
  const W_VS = [['bomb', 2], ['slow', 2], ['junk', 3], ['rush', 2], ['mirror', 1]];

  function rrect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.lineTo(x + w - r, y); g.quadraticCurveTo(x + w, y, x + w, y + r);
    g.lineTo(x + w, y + h - r); g.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    g.lineTo(x + r, y + h); g.quadraticCurveTo(x, y + h, x, y + h - r);
    g.lineTo(x, y + r); g.quadraticCurveTo(x, y, x + r, y);
    g.closePath();
  }
  function text(g, s, x, y, size, color, align, weight) {
    g.font = (weight || 700) + ' ' + size + 'px ' + FONT;
    g.textAlign = align || 'center'; g.textBaseline = 'middle';
    g.fillStyle = color; g.fillText(s, x, y);
  }

  Arcade.register({
    id: 'blocks', name: 'Block Duel', blurb: 'Drop blocks, clear rows, use power-ups.', versus: true,
    init(api) {
      const versus = !!api.opp;
      const view = api.view;

      let grid = [];
      for (let r = 0; r < ROWS; r++) grid.push(new Array(COLS).fill(null));
      let piece = null;            // {cells:[{x,y,p}], x, y, col}
      let bag = [];
      const queue = [];            // dealt, not yet spawned
      let spawned = 0;
      let score = 0, lines = 0, combo = 0;
      let dead = false, deadT = 0, overSent = false;
      let clock = 0, gravAcc = 0, lockT = 0, resets = 0;
      let rushT = 0, slowT = 0;
      let pending = 0;
      const powers = [];           // stored power-ups, oldest first (max MAX_POWERS)
      let touch = null, btnDown = -1;   // btnDown: index of the slot being pressed
      const parts = [], banners = [], flashes = [], trails = [];
      let shake = 0;
      const dots = [];
      for (let i = 0; i < 40; i++) dots.push({ x: Math.random(), y: Math.random(), r: 0.6 + Math.random() * 1.2 });

      // ---------- dealing (only place api.rng is used)
      function pickPower() {
        const tbl = versus ? W_VS : W_SOLO;
        let tot = 0; for (const e of tbl) tot += e[1];
        let v = api.rng() * tot;
        for (const e of tbl) { v -= e[1]; if (v < 0) return e[0]; }
        return tbl[0][0];
      }
      function deal() {
        if (!bag.length) {
          bag = PIECES.map((_, i) => i);
          for (let i = bag.length - 1; i > 0; i--) {
            const j = Math.floor(api.rng() * (i + 1));
            const t = bag[i]; bag[i] = bag[j]; bag[j] = t;
          }
        }
        const def = PIECES[bag.pop()];
        const cells = def.c.map(c => ({ x: c[0], y: c[1], p: null }));
        if (api.rng() < POWER_CHANCE) {
          const idx = Math.floor(api.rng() * cells.length);
          cells[idx].p = pickPower();
        }
        return { n: def.n, col: def.col, cells };
      }
      while (queue.length < 3) queue.push(deal());

      // ---------- helpers
      function addScore(n) { score += n; api.score(score); }
      function level() { return 1 + Math.floor(lines / 8); }
      function spr() {
        let s = Math.max(0.07, 0.8 * Math.pow(0.86, level() - 1));
        // Rush roughly triples the speed but never below 0.06 s a row, so it stays
        // survivable at high levels.
        if (rushT > 0) s = Math.max(0.06, s * 0.35);
        if (slowT > 0) s *= 2.5;
        return s;
      }
      function banner(s) { banners.push({ s, t: 0 }); if (banners.length > 3) banners.shift(); }
      function burst(x, y, n, cols, sp, life, grav) {
        for (let i = 0; i < n; i++) {
          const a = Math.random() * 6.283, v = sp * (0.3 + Math.random() * 0.7);
          parts.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - sp * 0.2, g: grav == null ? 300 : grav, t: 0, life: life * (0.6 + Math.random() * 0.6), r: 1.5 + Math.random() * 2.5, c: cols[(Math.random() * cols.length) | 0] });
        }
      }

      function hit(cells, px, py) {
        for (const c of cells) {
          const x = px + c.x, y = py + c.y;
          if (x < 0 || x >= COLS || y >= ROWS) return true;
          if (y >= 0 && grid[y][x]) return true;
        }
        return false;
      }
      function grounded() { return hit(piece.cells, piece.x, piece.y + 1); }
      function dropDist() { let d = 0; while (!hit(piece.cells, piece.x, piece.y + d + 1)) d++; return d; }

      function resetLock() {
        if (lockT > 0 && resets < MAX_RESETS) { lockT = 0; resets++; }
      }
      function tryMove(dx, dy) {
        if (!piece || hit(piece.cells, piece.x + dx, piece.y + dy)) return false;
        piece.x += dx; piece.y += dy;
        resetLock();
        return true;
      }
      function rotate() {
        if (!piece) return false;
        let w = 0, h = 0;
        for (const c of piece.cells) { if (c.x + 1 > w) w = c.x + 1; if (c.y + 1 > h) h = c.y + 1; }
        const rc = piece.cells.map(c => ({ x: h - 1 - c.y, y: c.x, p: c.p }));
        const bx = piece.x + Math.floor((w - h) / 2), by = piece.y + Math.floor((h - w) / 2);
        for (const k of KICKS) {
          if (!hit(rc, bx + k[0], by + k[1])) {
            piece.cells = rc; piece.x = bx + k[0]; piece.y = by + k[1];
            resetLock();
            burst(BX + (piece.x + 1) * CELL, BY + (piece.y + 1) * CELL, 3, ['#fff'], 60, 0.25, 0);
            return true;
          }
        }
        return false;
      }

      function spawn() {
        const q = queue.shift();
        queue.push(deal());
        let minX = 9, maxX = 0;
        for (const c of q.cells) { if (c.x < minX) minX = c.x; if (c.x > maxX) maxX = c.x; }
        piece = { cells: q.cells, col: q.col, x: Math.floor((COLS - (maxX - minX + 1)) / 2), y: 0 };
        spawned++;
        gravAcc = 0; lockT = 0; resets = 0;
        if (hit(piece.cells, piece.x, piece.y)) die();
      }

      function die() {
        if (dead) return;
        dead = true; deadT = 0; touch = null; btnDown = -1;
        shake = 0.4;
        burst(BX + BW / 2, BY + BH / 2, 24, ['#fff', '#ff8a8a', '#ffd27a'], 260, 0.8);
        if (!overSent) { overSent = true; api.over(); }
      }

      function pushJunk(n) {
        const hole = Math.floor(Math.random() * COLS);
        for (let i = 0; i < n; i++) {
          if (grid[0].some(Boolean)) { die(); return; }
          grid.shift();
          const row = [];
          for (let c = 0; c < COLS; c++) row.push(c === hole ? null : { k: 'j', p: null });
          grid.push(row);
        }
      }

      function lockPiece() {
        if (!piece || dead) return;
        const col = LETTER[piece.col];
        let above = false;
        for (const c of piece.cells) {
          const x = piece.x + c.x, y = piece.y + c.y;
          if (y < 0) { above = true; continue; }
          grid[y][x] = { k: col, p: c.p };
        }
        const px = BX + (piece.x + 1.5) * CELL, py = BY + (piece.y + 1.5) * CELL;
        piece = null;
        if (above) { die(); return; }
        burst(px, py, 4, ['#fff'], 90, 0.3, 200);

        // clear full rows
        const full = [];
        for (let r = 0; r < ROWS; r++) if (grid[r].every(Boolean)) full.push(r);
        const n = full.length;
        if (n) {
          const lv = level();
          combo++;
          for (const r of full) {
            for (const cell of grid[r]) {
              if (cell && cell.p) {
                if (powers.length < MAX_POWERS) { powers.push(cell.p); banner(POWER_NAME[cell.p] + ' ready'); }
                else addScore(200);
              }
            }
            flashes.push({ r, t: 0 });
            for (let i = 0; i < 12; i++) burst(BX + Math.random() * BW, BY + r * CELL + 15, 1, ['#fff', '#ffe9a8', '#bfe9ff'], 200, 0.7);
          }
          grid = grid.filter((_, r) => !full.includes(r));
          while (grid.length < ROWS) grid.unshift(new Array(COLS).fill(null));
          addScore(LINE_SCORE[Math.min(n, 5)] * lv + 50 * (combo - 1) * lv);
          lines += n;
          if (level() > lv) banner('Level ' + level());
          if (n >= 2) banner(['', '', 'Double!', 'Triple!', 'Quad!', 'Mega!'][Math.min(n, 5)]);
          if (combo >= 2) banner('Combo x' + combo);
          shake = Math.max(shake, 0.1 + n * 0.04);

          if (versus) {
            let atk = ATTACK[Math.min(n, 5)] + (combo >= 2 ? 1 : 0);
            const cancel = Math.min(atk, pending);
            pending -= cancel; atk -= cancel;
            if (atk > 0) api.send('junk', { n: atk });
          }
        } else {
          combo = 0;
          if (pending > 0) {
            const k = Math.min(JUNK_PUSH_MAX, pending);
            pending -= k;
            pushJunk(k);
            shake = Math.max(shake, 0.2);
            if (dead) return;
          }
        }
        spawn();
      }

      function hardDrop() {
        if (!piece) return;
        const d = dropDist();
        for (const c of piece.cells) {
          trails.push({ x: BX + (piece.x + c.x) * CELL, y0: BY + (piece.y + c.y) * CELL, y1: BY + (piece.y + c.y + d) * CELL + CELL, t: 0 });
        }
        piece.y += d;
        if (d) addScore(2 * d);
        shake = Math.max(shake, 0.12);
        for (const c of piece.cells) burst(BX + (piece.x + c.x + 0.5) * CELL, BY + (piece.y + c.y + 1) * CELL, 1, ['#fff', '#d8ccff'], 120, 0.35, 100);
        lockPiece();
      }

      function usePower(i) {
        if (dead || i < 0 || i >= powers.length) return;
        const p = powers.splice(i, 1)[0];
        if (p === 'bomb') {
          grid.splice(ROWS - 3, 3);
          for (let i = 0; i < 3; i++) grid.unshift(new Array(COLS).fill(null));
          burst(BX + BW / 2, BY + BH - 45, 40, ['#fff', '#ffb347', '#ff6a3d', '#ffe27a'], 330, 0.8);
          shake = 0.4; banner('Bomb!');
        } else if (p === 'slow') { slowT = SLOW_SECS; banner('Slow 10s'); }
        else if (p === 'junk') { api.send('junk', { n: 2 }); banner('Junk sent'); }
        else if (p === 'rush') { api.send('rush', {}); banner('Rush sent'); }
        else if (p === 'mirror') { api.send('mirror', {}); banner('Mirror sent'); }
      }

      // ---------- input
      function slotAt(x, y) {
        if (y < SLOT.y - 6 || y > SLOT.y + SLOT.h + 10) return -1;
        for (let i = 0; i < powers.length; i++) if (x >= slotX(i) - 4 && x <= slotX(i) + SLOT.w + 4) return i;
        return -1;
      }

      function down(x, y) {
        if (dead) return;
        const si = slotAt(x, y);
        if (si >= 0) { btnDown = si; touch = null; return; }
        btnDown = -1;
        if (!piece) return;
        touch = { sx: x, sy: y, t: clock, col: piece.x, mx: 0, my: 0, soft: 0, softOn: false };
      }
      function move(x, y) {
        if (dead || !touch || !piece) return;
        const dx = x - touch.sx, dy = y - touch.sy;
        touch.mx = Math.max(touch.mx, Math.abs(dx)); touch.my = Math.max(touch.my, Math.abs(dy));
        const target = touch.col + Math.round(dx / COL_PX);
        while (piece.x !== target) {
          if (!tryMove(piece.x < target ? 1 : -1, 0)) break;
        }
        if (!touch.softOn && dy > SOFT_START && dy > 1.2 * Math.abs(dx)) touch.softOn = true;
        if (touch.softOn) {
          const want = 1 + Math.floor((dy - SOFT_START) / SOFT_ROW);
          while (touch.soft < want) {
            if (!tryMove(0, 1)) break;
            touch.soft++; addScore(1);
          }
        }
      }
      function up(x, y) {
        if (btnDown >= 0) { const i = btnDown; btnDown = -1; if (slotAt(x, y) === i) usePower(i); return; }
        if (!touch) return;
        const t = touch; touch = null;
        if (dead || !piece) return;
        const dx = x - t.sx, dy = y - t.sy, dt = clock - t.t;
        const mx = Math.max(t.mx, Math.abs(dx)), my = Math.max(t.my, Math.abs(dy));
        if (mx < TAP_MOVE && my < TAP_MOVE && dt < TAP_TIME && piece.x === t.col) rotate();
        else if (dy > FLICK_DIST && dt < FLICK_TIME && dy > 2 * Math.abs(dx)) hardDrop();
      }

      // ---------- remote
      function receive(type, data) {
        if (dead) return;
        if (type === 'junk') {
          const n = Math.max(0, Math.min(JUNK_CAP, (data && data.n) | 0));
          if (n) { pending = Math.min(JUNK_CAP, pending + n); banner('+' + n + ' junk'); }
        } else if (type === 'rush') {
          rushT = RUSH_SECS; banner('Rush!');
        } else if (type === 'mirror') {
          for (const row of grid) row.reverse();
          if (piece) {
            let k = 0;
            while (hit(piece.cells, piece.x, piece.y) && k++ < 5) piece.y--;
            if (hit(piece.cells, piece.x, piece.y)) die();
          }
          banner('Mirror!');
        }
      }

      // ---------- update
      function update(dt) {
        clock += dt;
        if (rushT > 0) rushT = Math.max(0, rushT - dt);
        if (slowT > 0) slowT = Math.max(0, slowT - dt);
        if (shake > 0) shake = Math.max(0, shake - dt);
        for (let i = banners.length - 1; i >= 0; i--) { banners[i].t += dt; if (banners[i].t > 1.2) banners.splice(i, 1); }
        for (let i = flashes.length - 1; i >= 0; i--) { flashes[i].t += dt; if (flashes[i].t > 0.25) flashes.splice(i, 1); }
        for (let i = trails.length - 1; i >= 0; i--) { trails[i].t += dt; if (trails[i].t > 0.18) trails.splice(i, 1); }
        for (let i = parts.length - 1; i >= 0; i--) {
          const p = parts[i];
          p.t += dt; p.vy += p.g * dt; p.x += p.vx * dt; p.y += p.vy * dt;
          if (p.t > p.life) parts.splice(i, 1);
        }
        if (dead) { deadT += dt; return; }
        if (!piece) return;

        if (grounded()) {
          lockT += dt;
          if (lockT >= LOCK_DELAY) lockPiece();
        } else {
          lockT = 0;
          gravAcc += dt;
          const s = spr();
          while (gravAcc >= s && piece) {
            gravAcc -= s;
            if (!hit(piece.cells, piece.x, piece.y + 1)) piece.y++;
            else break;
          }
        }
      }

      // ---------- render
      function cellXY(c, r) { return [BX + c * CELL + CELL / 2, BY + r * CELL + CELL / 2]; }

      function drawBlock(g, key, cx, cy, size, power, alpha) {
        api.draw(g, key, cx, cy, { w: size, h: size, alpha });
        if (power) {
          const s = size * 0.73 * (1 + 0.08 * Math.sin(clock * 5 + cx * 0.1));
          api.draw(g, 'icon_' + power, cx, cy, { w: s, h: s, alpha });
        }
      }

      function render(g, ghost) {
        // background
        const bgr = g.createLinearGradient(0, view.y0, 0, view.y1);
        bgr.addColorStop(0, '#2b2453'); bgr.addColorStop(1, '#463a7a');
        g.fillStyle = bgr;
        g.fillRect(view.x0, view.y0, view.x1 - view.x0, view.y1 - view.y0);
        g.fillStyle = 'rgba(255,255,255,0.07)';
        for (const d of dots) {
          g.beginPath();
          g.arc(view.x0 + d.x * (view.x1 - view.x0), view.y0 + d.y * (view.y1 - view.y0), d.r, 0, 6.283);
          g.fill();
        }

        g.save();
        if (shake > 0) g.translate((Math.random() - 0.5) * shake * 14, (Math.random() - 0.5) * shake * 14);

        // board panel + grid
        g.fillStyle = 'rgba(15,12,35,0.75)';
        rrect(g, BX - 4, BY - 4, BW + 8, BH + 8, 10); g.fill();
        g.strokeStyle = 'rgba(255,255,255,0.05)'; g.lineWidth = 1;
        g.beginPath();
        for (let c = 1; c < COLS; c++) { g.moveTo(BX + c * CELL, BY); g.lineTo(BX + c * CELL, BY + BH); }
        for (let r = 1; r < ROWS; r++) { g.moveTo(BX, BY + r * CELL); g.lineTo(BX + BW, BY + r * CELL); }
        g.stroke();
        g.strokeStyle = 'rgba(255,255,255,0.35)'; g.lineWidth = 2;
        rrect(g, BX - 4, BY - 4, BW + 8, BH + 8, 10); g.stroke();

        // locked blocks
        const grayRows = dead ? Math.floor(deadT / 0.05) : 0;
        for (let r = 0; r < ROWS; r++) {
          const grayRow = dead && (ROWS - 1 - r) < grayRows;
          for (let c = 0; c < COLS; c++) {
            const cell = grid[r][c];
            if (!cell) continue;
            const [cx, cy] = cellXY(c, r);
            if (grayRow) drawBlock(g, 'block_junk', cx, cy, CELL, null);
            else drawBlock(g, SPRITE[cell.k], cx, cy, CELL, cell.p);
          }
        }

        // landing preview + piece
        if (piece && !dead) {
          const d = dropDist();
          if (d > 0) {
            for (const c of piece.cells) {
              if (piece.y + d + c.y < 0) continue;
              const [cx, cy] = cellXY(piece.x + c.x, piece.y + d + c.y);
              api.draw(g, 'block_' + piece.col, cx, cy, { w: CELL, h: CELL, alpha: 0.22 });
            }
          }
        }
        for (const t of trails) {
          const a = 0.35 * (1 - t.t / 0.18);
          const tg = g.createLinearGradient(0, t.y0, 0, t.y1);
          tg.addColorStop(0, 'rgba(255,255,255,0)'); tg.addColorStop(1, 'rgba(255,255,255,' + a.toFixed(3) + ')');
          g.fillStyle = tg; g.fillRect(t.x + 4, t.y0, CELL - 8, t.y1 - t.y0);
        }
        if (piece && !dead) {
          for (const c of piece.cells) {
            if (piece.y + c.y < 0) continue;
            const [cx, cy] = cellXY(piece.x + c.x, piece.y + c.y);
            drawBlock(g, 'block_' + piece.col, cx, cy, CELL, c.p);
          }
        }

        // line-clear flashes
        for (const f of flashes) {
          const a = 0.85 * (1 - f.t / 0.25);
          g.fillStyle = 'rgba(255,255,255,' + a.toFixed(3) + ')';
          g.fillRect(BX, BY + f.r * CELL + 2, BW, CELL - 4);
        }

        // particles
        for (const p of parts) {
          g.globalAlpha = Math.max(0, 1 - p.t / p.life);
          g.fillStyle = p.c;
          g.fillRect(p.x - p.r / 2, p.y - p.r / 2, p.r, p.r);
        }
        g.globalAlpha = 1;

        // incoming-junk meter
        g.fillStyle = 'rgba(15,12,35,0.6)';
        rrect(g, 4, BY, 6, BH, 3); g.fill();
        if (pending > 0) {
          const pulse = 0.75 + 0.25 * Math.sin(clock * 8);
          g.fillStyle = 'rgba(255,70,70,' + pulse.toFixed(2) + ')';
          for (let i = 0; i < pending; i++) g.fillRect(4, BY + BH - (i + 1) * CELL + 2, 6, CELL - 3);
        }

        // timed effects
        let ex = BX + BW;
        if (slowT > 0) { text(g, 'Slow ' + Math.ceil(slowT) + 's', ex, 104, 13, '#7fe3ff', 'right', 800); ex -= 70; }
        if (rushT > 0) text(g, 'Rush ' + Math.ceil(rushT) + 's', ex, 104, 13, '#ff8a7a', 'right', 800);

        // hint for the first pieces
        if (spawned <= 3 && !dead && !powers.length) {
          text(g, 'Drag to move · Tap to turn · Flick down to drop', BX + BW / 2, BY + BH + 20, 13, 'rgba(255,255,255,0.7)', 'center', 600);
        }

        // banners (newest lowest)
        for (let i = 0; i < banners.length; i++) {
          const b = banners[i], p = b.t / 1.2;
          const ease = 1 - Math.pow(1 - Math.min(1, p * 2), 3);
          const sc = 0.6 + 0.5 * ease + 0.1 * p;
          const al = p < 0.55 ? 1 : Math.max(0, 1 - (p - 0.55) / 0.45);
          const by = BY + 200 - (banners.length - 1 - i) * 44;
          g.save();
          g.translate(BX + BW / 2, by); g.scale(sc, sc); g.globalAlpha = al;
          g.font = '800 34px ' + FONT; g.textAlign = 'center'; g.textBaseline = 'middle';
          g.lineJoin = 'round'; g.lineWidth = 7; g.strokeStyle = 'rgba(20,10,50,0.9)';
          g.strokeText(b.s, 0, 0);
          g.fillStyle = '#fff'; g.fillText(b.s, 0, 0);
          g.restore();
        }
        g.restore();

        // ----- right column (not shaken)
        text(g, 'Next', BTN.x + BTN.w / 2, 118, 12, 'rgba(255,255,255,0.75)', 'center', 800);
        for (let i = 0; i < 2; i++) {
          const by0 = 128 + i * 54;
          g.fillStyle = 'rgba(15,12,35,0.6)'; rrect(g, BTN.x, by0, BTN.w, 50, 8); g.fill();
          const q = queue[i];
          if (!q) continue;
          let w = 0, h = 0;
          for (const c of q.cells) { if (c.x + 1 > w) w = c.x + 1; if (c.y + 1 > h) h = c.y + 1; }
          const ox = BTN.x + BTN.w / 2 - w * 6.5, oy = by0 + 25 - h * 6.5;
          for (const c of q.cells) drawBlock(g, 'block_' + q.col, ox + c.x * 13 + 6.5, oy + c.y * 13 + 6.5, 13, c.p);
        }
        text(g, 'Lv ' + level(), BTN.x + BTN.w / 2, 246, 12, 'rgba(255,255,255,0.8)', 'center', 800);
        text(g, lines + ' lines', BTN.x + BTN.w / 2, 262, 11, 'rgba(255,255,255,0.6)', 'center', 600);

        // power-up slots, side by side under the board (tap one to use it)
        if (!(spawned <= 3 && !powers.length) || dead) {
          const glow = 0.5 + 0.5 * Math.sin(clock * 6);
          for (let i = 0; i < MAX_POWERS; i++) {
            const x0 = slotX(i), p = powers[i], pressed = btnDown === i;
            g.fillStyle = p ? (pressed ? 'rgba(90,64,170,0.95)' : 'rgba(60,40,120,0.85)') : 'rgba(15,12,35,0.45)';
            rrect(g, x0, SLOT.y, SLOT.w, SLOT.h, 10); g.fill();
            if (p) {
              g.strokeStyle = 'rgba(255,226,122,' + (0.55 + 0.4 * glow).toFixed(2) + ')'; g.lineWidth = 2;
              rrect(g, x0, SLOT.y, SLOT.w, SLOT.h, 10); g.stroke();
              api.draw(g, 'icon_' + p, x0 + 21, SLOT.y + SLOT.h / 2, { w: 32, h: 32 });
              text(g, POWER_NAME[p], x0 + 40, SLOT.y + SLOT.h / 2 + 4, 12, '#fff', 'left', 800);
            } else {
              g.strokeStyle = 'rgba(255,255,255,0.14)'; g.lineWidth = 1.5;
              rrect(g, x0, SLOT.y, SLOT.w, SLOT.h, 10); g.stroke();
            }
          }
        }

        // opponent mini board
        if (versus) {
          const mw = MINI.c * COLS, mh = MINI.c * ROWS;
          text(g, (api.opp && api.opp.name) || 'Rival', MINI.x + mw / 2, MINI.y - 8, 11, 'rgba(255,255,255,0.85)', 'center', 800);
          g.fillStyle = 'rgba(15,12,35,0.75)'; g.fillRect(MINI.x, MINI.y, mw, mh);
          g.strokeStyle = 'rgba(255,255,255,0.3)'; g.lineWidth = 1; g.strokeRect(MINI.x - 0.5, MINI.y - 0.5, mw + 1, mh + 1);
          if (ghost && typeof ghost.b === 'string' && ghost.b.length === COLS * ROWS) {
            for (let i = 0; i < ghost.b.length; i++) {
              const ch = ghost.b[i];
              if (ch === '.') continue;
              const key = SPRITE[ch];
              if (!key) continue;
              api.draw(g, key, MINI.x + (i % COLS) * MINI.c + MINI.c / 2, MINI.y + Math.floor(i / COLS) * MINI.c + MINI.c / 2, { w: MINI.c, h: MINI.c });
            }
            text(g, String(ghost.s | 0), MINI.x + mw / 2, MINI.y + mh + 12, 12, '#fff', 'center', 800);
          } else {
            text(g, 'Waiting…', MINI.x + mw / 2, MINI.y + mh / 2, 10, 'rgba(255,255,255,0.6)', 'center', 700);
          }
        }
      }

      // ---------- ghost (kept cheap: one 144-char string)
      function ghostOut() {
        const a = new Array(COLS * ROWS);
        for (let r = 0; r < ROWS; r++) {
          const row = grid[r];
          for (let c = 0; c < COLS; c++) a[r * COLS + c] = row[c] ? row[c].k : '.';
        }
        if (piece && !dead) {
          const ch = LETTER[piece.col];
          for (const c of piece.cells) {
            const y = piece.y + c.y, x = piece.x + c.x;
            if (y >= 0 && y < ROWS && x >= 0 && x < COLS) a[y * COLS + x] = ch;
          }
        }
        return { b: a.join(''), s: score };
      }

      api.score(0);
      spawn();

      return {
        update, render, down, up, move, receive,
        ghost: ghostOut,
        // test hook: read-only view of internals
        _dbg() { return { grid, piece, queue, powers, pending, score, lines, dead, rushT, slowT, combo, hit, setGrid(g2) { grid = g2; }, setPending(n) { pending = n; }, setPiece(p) { piece = p; }, spawn }; },
      };
    },
  });
})();
