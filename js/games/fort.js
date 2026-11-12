/* Fort Blast: two-player artillery. Build a fort from falling blocks, then both players fire at the
 * same time each round while a small moon bends the shots. Knock out the other crown.
 *
 * Determinism: the volley simulation (fixed 1/120 s steps, no trig, no Math.random) runs identically on
 * both phones from the same state and the same two aims. The host (the name that sorts first, left side)
 * also publishes the resulting state after every volley and the other phone adopts it, so any drift heals.
 * api.rng is used ONLY at init, to seed three private streams (pieces, moon, spare), because the number of
 * pieces each phone places differs.
 *
 * Score = 1 per enemy block destroyed + 15 per crown hit point dealt + 100 for a crown knock-out. When a
 * crown falls, the player left standing is lifted to at least (other score + 1) so the app's score
 * comparison always agrees with the outcome. */
(function () {
  'use strict';

  const W = 360, H = 640;
  const COLS = 8, ROWS = 11, CELL = 13, TOP = 417, GROUND = 560;
  const ZX = [8, 248];                       // left and right zone x0
  const CROWN_C0 = 3, CROWN_R0 = 9;          // crown: cols 3-4, rows 9-10
  const DT = 1 / 120;
  const GRAV = 420, MOON_K = 2.2e6, MOON_MIN2 = 45 * 45, MOON_R = 30;
  const MAX_DRAG = 150, POWER = 4.2, MIN_DRAG = 12;
  const BLAST = [18, 32, 12], CROWN_DMG = [1, 2, 1];
  const ROUNDS = 12, BUILD_SECS = 40, AIM_SECS = 15, ROW_SECS = 0.5, LOCK_DELAY = 0.4;
  const ZOOM = 30 / CELL, ZOOM_OUT = 0.8, MOON_GLIDE = 0.6;
  const SYNC_TIMEOUT = 6;
  const COL_PX = 26, SOFT_START = 24, SOFT_ROW = 22, TAP_MOVE = 12, TAP_TIME = 0.35, FLICK_DIST = 50, FLICK_TIME = 0.3;
  const FONT = 'ui-rounded, system-ui, sans-serif';

  const PIECES = [
    { col: 'yellow', c: [[0, 0], [1, 0], [2, 0]] },
    { col: 'teal', c: [[0, 0], [0, 1], [1, 1]] },
    { col: 'blue', c: [[0, 0], [1, 0], [0, 1], [1, 1]] },
    { col: 'orange', c: [[0, 0], [1, 0], [2, 0], [1, 1]] },
    { col: 'pink', c: [[1, 0], [2, 0], [0, 1], [1, 1]] },
    { col: 'green', c: [[0, 0], [1, 0], [1, 1], [2, 1]] },
    { col: 'purple', c: [[0, 0], [0, 1], [0, 2], [1, 2]] },
    { col: 'red', c: [[1, 0], [1, 1], [1, 2], [0, 2]] },
    { col: 'yellow', c: [[0, 0], [1, 0], [2, 0], [3, 0]] },
    { col: 'blue', c: [[0, 0], [1, 0], [0, 1], [1, 1], [0, 2]] },
  ];
  const LETTER = { red: 'r', orange: 'o', yellow: 'y', green: 'g', teal: 't', blue: 'b', purple: 'u', pink: 'k' };
  const SPRITE = {}, DEBRIS = { r: '#e5484d', o: '#f5902b', y: '#f5cf3b', g: '#4fbf5b', t: '#2fbfb3', b: '#4a8cf0', u: '#8b5cf0', k: '#f06ab0' };
  for (const k of Object.keys(LETTER)) SPRITE[LETTER[k]] = 'block_' + k;

  const BTN = {
    ball: { x: 8, y: 576, w: 56, h: 52, k: 0 },
    bomb: { x: 68, y: 576, w: 56, h: 52, k: 1 },
    drill: { x: 128, y: 576, w: 56, h: 52, k: 2 },
    fire: { x: 192, y: 576, w: 160, h: 52 },
  };

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
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
  function outlined(g, s, x, y, size, color) {
    g.font = '800 ' + size + 'px ' + FONT; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineJoin = 'round'; g.lineWidth = Math.max(4, size / 5); g.strokeStyle = 'rgba(20,10,50,0.9)';
    g.strokeText(s, x, y); g.fillStyle = color || '#fff'; g.fillText(s, x, y);
  }
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const isCrownCell = (c, r) => c >= CROWN_C0 && c <= CROWN_C0 + 1 && r >= CROWN_R0 && r <= CROWN_R0 + 1;
  const validCh = ch => ch === '.' || (ch >= 'a' && ch <= 'z' && DEBRIS[ch] !== undefined);

  function rotCells(cells) {
    let h = 0;
    for (const c of cells) if (c.y + 1 > h) h = c.y + 1;
    return cells.map(c => ({ x: h - 1 - c.y, y: c.x }));
  }
  function dims(cells) {
    let w = 0, h = 0;
    for (const c of cells) { if (c.x + 1 > w) w = c.x + 1; if (c.y + 1 > h) h = c.y + 1; }
    return [w, h];
  }
  function makeDealer(rnd) {
    let bag = [];
    return function () {
      if (!bag.length) {
        bag = PIECES.map((_, i) => i);
        for (let i = bag.length - 1; i > 0; i--) {
          const j = Math.floor(rnd() * (i + 1));
          const t = bag[i]; bag[i] = bag[j]; bag[j] = t;
        }
      }
      const d = PIECES[bag.pop()];
      return { col: d.col, cells: d.c.map(c => ({ x: c[0], y: c[1] })) };
    };
  }

  Arcade.register({
    id: 'fort', name: 'Fort Blast', blurb: 'Build a fort, then blast theirs.', peerSync: true,
    init(api) {
      const versus = !!api.opp;
      const view = api.view;
      const auto = !!api.auto;
      const nameMe = String(api.me.name), nameOpp = versus ? String(api.opp.name) : 'Bot';
      let mySide = 0;
      if (versus) {
        if (nameMe === nameOpp) mySide = api.me.color === 'blue' ? 0 : 1;
        else mySide = nameMe < nameOpp ? 0 : 1;
      }
      const oppSide = 1 - mySide;
      const isHost = !versus || mySide === 0;
      const color = [null, null];
      color[mySide] = api.me.color === 'pink' ? 'pink' : 'blue';
      color[oppSide] = versus ? (api.opp.color === 'pink' ? 'pink' : 'blue') : (color[mySide] === 'blue' ? 'pink' : 'blue');
      if (color[0] === color[1]) color[oppSide] = color[mySide] === 'blue' ? 'pink' : 'blue';
      const names = [null, null]; names[mySide] = nameMe; names[oppSide] = nameOpp;

      // private streams
      const seed = () => (api.rng() * 4294967296) >>> 0;
      const pieceRnd = mulberry32(seed()), moonRnd = mulberry32(seed()), spareRnd = mulberry32(seed());
      const moonPos = [];
      for (let i = 0; i < ROUNDS + 1; i++) moonPos.push({ x: 180 + (moonRnd() * 2 - 1) * 30, y: 240 + (moonRnd() * 2 - 1) * 60 });

      // ---------- shared state
      const st = {
        forts: [new Array(COLS * ROWS).fill('.'), new Array(COLS * ROWS).fill('.')],
        hp: [3, 3], ammo: [[1, 2], [1, 2]], score: [0, 0],
      };
      let round = 0;
      let ph = 'build', phT = 0, clock = 0;
      let lastScore = -1, overCalled = false;

      const solid = (side, c, r) => {
        if (c < 0 || c >= COLS || r < 0 || r >= ROWS) return false;
        if (isCrownCell(c, r) && st.hp[side] > 0) return true;
        return st.forts[side][r * COLS + c] !== '.';
      };
      const fortStr = side => st.forts[side].join('');

      // ---------- fx state (cosmetic only)
      const parts = [], rings = [], banners = [], falls = [], trails = [];
      let shake = 0, camZ = 1;
      let moonFrom = moonPos[0], moonT = MOON_GLIDE;
      const cvis = [GROUND, GROUND], fvis = [GROUND, GROUND], recoil = [0, 0], crownHit = [0, 0];
      const defaultAim = side => (side === 0 ? { dx: -51, dy: 61 } : { dx: 51, dy: 61 });
      const barrel = [null, null];
      for (let s = 0; s < 2; s++) { const d = defaultAim(s); barrel[s] = { ux: -d.dx / 80, uy: -d.dy / 80 }; }
      let celebrate = null;

      function banner(s, big) { banners.push({ s, t: 0, big: !!big }); if (banners.length > 3) banners.shift(); }
      function burst(x, y, n, cols, sp, life, grav) {
        if (parts.length > 400) return;
        for (let i = 0; i < n; i++) {
          const a = Math.random() * 6.283, v = sp * (0.3 + Math.random() * 0.7);
          parts.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - sp * 0.25, g: grav == null ? 300 : grav, t: 0, life: life * (0.6 + Math.random() * 0.6), r: 1.5 + Math.random() * 2.2, c: cols[(Math.random() * cols.length) | 0] });
        }
      }
      function cellCenter(side, c, r) { return [ZX[side] + c * CELL + CELL / 2, TOP + r * CELL + CELL / 2]; }

      // ---------- fort geometry
      function topRow(side, c) {
        for (let r = 0; r < ROWS; r++) if (solid(side, c, r)) return r;
        return ROWS;
      }
      function topSurface(side, c) { return TOP + topRow(side, c) * CELL; }
      function innerCol(side) { return side === 0 ? COLS - 1 : 0; }
      function outerCol(side) { return side === 0 ? 0 : COLS - 1; }
      function pivot(side) {
        const c = innerCol(side);
        return { x: ZX[side] + c * CELL + CELL / 2, y: topSurface(side, c) - 18 };
      }
      function settleSide(side, record) {
        const f = st.forts[side];
        for (let c = 0; c < COLS; c++) {
          const floor = (c === CROWN_C0 || c === CROWN_C0 + 1) ? CROWN_R0 : ROWS;
          let w = floor - 1;
          for (let r = floor - 1; r >= 0; r--) {
            const ch = f[r * COLS + c];
            if (ch === '.') continue;
            if (r !== w) {
              f[w * COLS + c] = ch; f[r * COLS + c] = '.';
              if (record) falls.push({ side, c, r0: r, r1: w, ch, t: 0 });
            }
            w--;
          }
        }
      }

      // ---------- build
      const dealMine = makeDealer(pieceRnd);
      const queue = [dealMine(), dealMine(), dealMine()];
      let piece = null, buildT = 0, gravAcc = 0, lockT = 0, resets = 0, placed = 0, touch = null;
      const autoN = 13 + Math.floor(spareRnd() * 4);
      let peerLoaded = !versus;
      let hostX = null, lastAim = null, prevAim = null;

      function hitP(cells, px, py) {
        for (const c of cells) {
          const x = px + c.x, y = py + c.y;
          if (x < 0 || x >= COLS || y >= ROWS) return true;
          if (y >= 0 && solid(mySide, x, y)) return true;
        }
        return false;
      }
      // placement heuristic shared by the bot, auto mode
      function choosePlacement(side, cells, rnd) {
        let best = null, cur = cells;
        for (let rot = 0; rot < 4; rot++) {
          const [w] = dims(cur);
          for (let x = 0; x + w <= COLS; x++) {
            let bad = false;
            for (const c of cur) if (solid(side, x + c.x, c.y)) { bad = true; break; }
            if (bad) continue;
            let y = 0;
            for (;;) {
              let blocked = false;
              for (const c of cur) {
                const xx = x + c.x, yy = y + 1 + c.y;
                if (yy >= ROWS || solid(side, xx, yy)) { blocked = true; break; }
              }
              if (blocked) break;
              y++;
            }
            const occ = new Set();
            for (const c of cur) occ.add((y + c.y) * COLS + x + c.x);
            let over = 0;
            for (const c of cur) {
              let yy = y + c.y + 1;
              while (yy < ROWS && !solid(side, x + c.x, yy) && !occ.has(yy * COLS + x + c.x)) { over++; yy++; }
            }
            const h = [];
            for (let c = 0; c < COLS; c++) {
              let t = topRow(side, c);
              for (const k of cur) if (x + k.x === c && y + k.y < t) t = y + k.y;
              h.push(ROWS - t);
            }
            let bump = 0, mx = 0;
            for (let c = 0; c < COLS; c++) { if (c) bump += Math.abs(h[c] - h[c - 1]); if (h[c] > mx) mx = h[c]; }
            const sc = bump + 0.7 * mx + 1.5 * over + rnd() * 0.8;
            if (!best || sc < best.sc) best = { sc, cells: cur, x, y };
          }
          cur = rotCells(cur);
        }
        return best;
      }
      function botBuild(side) {
        const deal = makeDealer(mulberry32(seed()));
        const rnd = mulberry32(seed());
        for (let i = 0; i < 14; i++) {
          const p = deal();
          const b = choosePlacement(side, p.cells, rnd);
          if (!b) break;
          const ch = LETTER[p.col];
          for (const c of b.cells) st.forts[side][(b.y + c.y) * COLS + b.x + c.x] = ch;
          settleSide(side, false);
        }
      }
      if (!versus) botBuild(oppSide);

      function spawnPiece() {
        const q = queue.shift();
        queue.push(dealMine());
        const [w] = dims(q.cells);
        piece = { cells: q.cells, col: q.col, x: Math.floor((COLS - w) / 2), y: 0 };
        gravAcc = 0; lockT = 0; resets = 0;
        if (hitP(piece.cells, piece.x, piece.y)) { piece = null; return false; }
        return true;
      }
      function grounded() { return hitP(piece.cells, piece.x, piece.y + 1); }
      function dropDist() { let d = 0; while (!hitP(piece.cells, piece.x, piece.y + d + 1)) d++; return d; }
      function resetLock() { if (lockT > 0 && resets < 12) { lockT = 0; resets++; } }
      function tryMove(dx, dy) {
        if (!piece || hitP(piece.cells, piece.x + dx, piece.y + dy)) return false;
        piece.x += dx; piece.y += dy; resetLock();
        return true;
      }
      const KICKS = [[0, 0], [-1, 0], [1, 0], [0, -1], [-2, 0], [2, 0], [-1, -1], [1, -1]];
      function rotate() {
        if (!piece) return false;
        const [w, h] = dims(piece.cells);
        const rc = rotCells(piece.cells);
        const bx = piece.x + Math.floor((w - h) / 2), by = piece.y + Math.floor((h - w) / 2);
        for (const k of KICKS) {
          if (!hitP(rc, bx + k[0], by + k[1])) {
            piece.cells = rc; piece.x = bx + k[0]; piece.y = by + k[1]; resetLock();
            return true;
          }
        }
        return false;
      }
      function lockPiece() {
        if (!piece) return;
        const ch = LETTER[piece.col];
        for (const c of piece.cells) {
          const x = piece.x + c.x, y = piece.y + c.y;
          if (y >= 0) st.forts[mySide][y * COLS + x] = ch;
          const [cx, cy] = cellCenter(mySide, x, y);
          burst(cx, cy + 4, 1, ['#fff', '#ffe9a8'], 70, 0.3, 120);
        }
        piece = null; placed++;
        shake = Math.max(shake, 0.08);
        settleSide(mySide, true);
        if (!spawnPiece()) finishBuild();
      }
      function hardDrop() {
        if (!piece) return;
        piece.y += dropDist();
        lockPiece();
      }
      function finishBuild() {
        if (ph !== 'build') return;
        piece = null; touch = null;
        ph = 'wait'; phT = 0;
      }
      spawnPiece();

      // ---------- trajectory (shared by the real volley and by bot/auto planning)
      function mkShot(side, a, type) {
        let dx = a.dx, dy = a.dy;
        let len = Math.sqrt(dx * dx + dy * dy);
        if (!(len >= MIN_DRAG)) { const d = defaultAim(side); dx = d.dx; dy = d.dy; len = Math.sqrt(dx * dx + dy * dy); }
        if (len > MAX_DRAG) { dx = dx * MAX_DRAG / len; dy = dy * MAX_DRAG / len; len = MAX_DRAG; }
        const vx = -dx * POWER, vy = -dy * POWER, spd = len * POWER;
        const ux = vx / spd, uy = vy / spd;
        const p = pivot(side);
        return { side, type, x: p.x + ux * 28, y: p.y + uy * 28, vx, vy, t: 0, alive: true, pierce: 0, ux, uy, n: 0 };
      }
      // advances one step; returns null or a hit {k, side, c, r}
      function advance(sh, mp) {
        const dx = mp.x - sh.x, dy = mp.y - sh.y;
        const d2 = dx * dx + dy * dy;
        const d = Math.sqrt(d2);
        if (d > 1e-6) {
          const f = MOON_K / (d2 < MOON_MIN2 ? MOON_MIN2 : d2);
          sh.vx += dx / d * f * DT; sh.vy += dy / d * f * DT;
        }
        sh.vy += GRAV * DT;
        sh.x += sh.vx * DT; sh.y += sh.vy * DT; sh.t += DT;
        const ex = mp.x - sh.x, ey = mp.y - sh.y;
        if (ex * ex + ey * ey < MOON_R * MOON_R) return { k: 'moon' };
        if (sh.x < -60 || sh.x > 420 || sh.t > 12) return { k: 'off' };
        if (sh.y >= GROUND) return { k: 'ground' };
        if (sh.y >= TOP) {
          for (let s = 0; s < 2; s++) {
            const lx = sh.x - ZX[s];
            if (lx < 0 || lx >= COLS * CELL) continue;
            const c = Math.floor(lx / CELL), r = Math.floor((sh.y - TOP) / CELL);
            if (isCrownCell(c, r) && st.hp[s] > 0) return { k: 'crown', side: s };
            if (st.forts[s][r * COLS + c] !== '.') return { k: 'block', side: s, c, r };
          }
        }
        return null;
      }
      function trace(side, a, type) {
        const sh = mkShot(side, a, type), mp = moonPos[Math.max(0, round - 1)];
        for (let i = 0; i < 1500; i++) {
          const h = advance(sh, mp);
          if (h) return { x: sh.x, y: sh.y, h };
        }
        return { x: sh.x, y: sh.y, h: null };
      }
      function crownCenter(side) { return { x: ZX[side] + (CROWN_C0 + 1) * CELL, y: TOP + (CROWN_R0 + 1) * CELL }; }
      function chooseAim(side, rnd, noise) {
        const en = 1 - side, tgt = crownCenter(en);
        const sgn = side === 0 ? 1 : -1;
        function rate(a) {
          const r = trace(side, a, 0);
          let d = Math.hypot(r.x - tgt.x, r.y - tgt.y);
          const h = r.h;
          if (h) {
            if (h.k === 'crown' && h.side === en) d = 0;
            else if (h.k === 'moon') d += 150;
            else if (h.k === 'off') d += 300;
            else if ((h.k === 'block' || h.k === 'crown') && h.side === side) d += 200;
            else if (h.k === 'ground' && Math.abs(r.x - ZX[side] - 52) < 60) d += 200;
          } else d += 300;
          return d;
        }
        let best = null;
        const tryAim = a => { const d = rate(a); if (!best || d < best.d) best = { a, d }; };
        for (let i = 0; i < 40; i++) {
          const ang = (18 + rnd() * 62) * Math.PI / 180, len = 30 + rnd() * 120;
          tryAim({ dx: Math.round(-sgn * Math.cos(ang) * len), dy: Math.round(Math.sin(ang) * len) });
        }
        const b0 = best.a;
        for (let i = 0; i < 14; i++) tryAim({ dx: b0.dx + Math.round((rnd() * 2 - 1) * 7), dy: b0.dy + Math.round((rnd() * 2 - 1) * 7) });
        const a = { dx: best.a.dx + Math.round((rnd() * 2 - 1) * noise), dy: best.a.dy + Math.round((rnd() * 2 - 1) * noise) };
        let type = 0;
        const am = st.ammo[side];
        if (am[0] > 0 && best.d < 28 && rnd() < 0.6) type = 1;
        else if (am[1] > 0 && rnd() < 0.3) type = 2;
        return { a, type };
      }

      // ---------- aiming state
      let aim = defaultAim(mySide), atype = 0, locked = false, aimT = AIM_SECS, aimDrag = null, btnDown = null;
      let botAim = null, botLockAt = 0, botT = 0;
      let vol = null, syncT = 0, endT = 0, endInfo = null;
      const botRnd = mulberry32(seed());
      const autoRnd = mulberry32(seed());

      function lockAim() {
        if (locked) return;
        locked = true; aimDrag = null; btnDown = null;
        lastAim = { dx: aim.dx, dy: aim.dy, t: atype };
      }
      function startRound(r) {
        round = r; ph = 'aim'; phT = 0; aimT = AIM_SECS; locked = false;
        prevAim = r > 1 ? lastAim : null;
        if (r >= 2) { moonFrom = moonPos[r - 2]; moonT = 0; } else { moonFrom = moonPos[0]; moonT = MOON_GLIDE; }
        if (atype > 0 && st.ammo[mySide][atype - 1] <= 0) atype = 0;
        const d = defaultAim(mySide);
        if (!(Math.hypot(aim.dx, aim.dy) >= MIN_DRAG)) aim = d;
        if (!versus) {
          const p = chooseAim(oppSide, botRnd, 9);
          botAim = { dx: p.a.dx, dy: p.a.dy, t: p.type };
          botLockAt = 1.5 + botRnd() * 4.5; botT = 0;
        }
        if (auto) {
          const p = chooseAim(mySide, autoRnd, 3);
          aim = { dx: p.a.dx, dy: p.a.dy }; atype = p.type;
          lockAim();
        }
        banner(r === ROUNDS ? 'Final round' : 'Round ' + r);
      }
      function peerAimFor(r) {
        if (!versus) return botT >= botLockAt ? botAim : null;
        const g = api.peer();
        if (!g || typeof g !== 'object') return null;
        const ok = v => Array.isArray(v) && Number.isFinite(v[0]) && Number.isFinite(v[1]);
        if (g.r === r && g.l === 1 && ok(g.a)) return { dx: Math.round(g.a[0]), dy: Math.round(g.a[1]), t: g.t | 0 };
        if (g.r === r + 1 && ok(g.q)) return { dx: Math.round(g.q[0]), dy: Math.round(g.q[1]), t: g.q[2] | 0 };
        return null;
      }

      // ---------- volley
      function destroyCell(side, c, r, shooter) {
        const i = r * COLS + c;
        const ch = st.forts[side][i];
        if (ch === '.') return false;
        st.forts[side][i] = '.';
        if (side !== shooter) st.score[shooter]++;
        const [cx, cy] = cellCenter(side, c, r);
        burst(cx, cy, 3, [DEBRIS[ch] || '#ccc', '#fff'], 130, 0.7, 380);
        return true;
      }
      function blast(x, y, R, dmg, shooter) {
        const R2 = R * R;
        for (let side = 0; side < 2; side++) {
          for (let r = 0; r < ROWS; r++) {
            for (let c = 0; c < COLS; c++) {
              if (st.forts[side][r * COLS + c] === '.') continue;
              const [cx, cy] = cellCenter(side, c, r);
              const ddx = cx - x, ddy = cy - y;
              if (ddx * ddx + ddy * ddy <= R2) destroyCell(side, c, r, shooter);
            }
          }
          if (st.hp[side] > 0) {
            const x0 = ZX[side] + CROWN_C0 * CELL, y0 = TOP + CROWN_R0 * CELL;
            const nx = clamp(x, x0, x0 + 2 * CELL), ny = clamp(y, y0, y0 + 2 * CELL);
            const ddx = nx - x, ddy = ny - y;
            if (ddx * ddx + ddy * ddy <= R2) {
              const ap = Math.min(dmg, st.hp[side]);
              st.hp[side] -= ap;
              crownHit[side] = 0.5;
              if (side !== shooter) {
                st.score[shooter] += 15 * ap;
                if (st.hp[side] === 0) st.score[shooter] += 100;
              }
              const cc = crownCenter(side);
              burst(cc.x, cc.y, st.hp[side] === 0 ? 40 : 12, ['#ffd84a', '#fff', '#ff9a3c'], st.hp[side] === 0 ? 260 : 150, 0.9);
              if (st.hp[side] === 0) shake = Math.max(shake, 0.6);
            }
          }
        }
        rings.push({ x, y, R, t: 0 });
        burst(x, y, R >= 30 ? 26 : R >= 18 ? 16 : 9, ['#fff', '#ffd27a', '#ff8a3d', '#ff5a3d'], 120 + R * 4, 0.6);
        shake = Math.max(shake, R >= 30 ? 0.35 : R >= 18 ? 0.2 : 0.12);
      }
      function resolveHit(sh, h) {
        if (h.k === 'off') { sh.alive = false; return; }
        if (h.k === 'moon') { sh.alive = false; burst(sh.x, sh.y, 10, ['#fff', '#cfd8ff'], 90, 0.5, 0); rings.push({ x: sh.x, y: sh.y, R: 12, t: 0 }); return; }
        if (h.k === 'block' && sh.type === 2) {
          destroyCell(h.side, h.c, h.r, sh.side);
          sh.pierce++;
          shake = Math.max(shake, 0.08);
          if (sh.pierce >= 4) { sh.alive = false; blast(sh.x, sh.y, BLAST[2], CROWN_DMG[2], sh.side); }
          return;
        }
        sh.alive = false;
        blast(sh.x, sh.y, BLAST[sh.type], CROWN_DMG[sh.type], sh.side);
      }
      function startVolley(pa) {
        const aims = [null, null];
        aims[mySide] = lastAim; aims[oppSide] = pa;
        vol = { t: 0, shots: [] };
        for (let s = 0; s < 2; s++) {
          const a = aims[s];
          let type = a.t | 0;
          if (type < 0 || type > 2) type = 0;
          if (type > 0 && st.ammo[s][type - 1] <= 0) type = 0;
          if (type > 0) st.ammo[s][type - 1]--;
          const sh = mkShot(s, a, type);
          vol.shots.push(sh);
          barrel[s] = { ux: sh.ux, uy: sh.uy };
          recoil[s] = 1;
          burst(sh.x, sh.y, 10, ['#fff', '#ffe27a', '#ff9a3c'], 160, 0.3, 0);
          rings.push({ x: sh.x, y: sh.y, R: 9, t: 0 });
        }
        shake = Math.max(shake, 0.22);
        moonT = MOON_GLIDE; moonFrom = moonPos[round - 1];
        ph = 'fire'; phT = 0;
      }
      function stepVolley() {
        vol.t += DT;
        const mp = moonPos[round - 1];
        let live = 0;
        for (const sh of vol.shots) {
          if (!sh.alive) continue;
          const h = advance(sh, mp);
          if (h) resolveHit(sh, h);
          else if ((++sh.n & 3) === 0) trails.push({ x: sh.x, y: sh.y, t: 0, k: sh.type });
          if (sh.alive) live++;
        }
        if (!live) return true;
        if (vol.t > 12) { for (const sh of vol.shots) sh.alive = false; return true; }
        return false;
      }
      function publishX() {
        hostX = {
          r: round, F: fortStr(0) + fortStr(1), h: [st.hp[0], st.hp[1]],
          m: [st.ammo[0][0], st.ammo[0][1], st.ammo[1][0], st.ammo[1][1]], s: [st.score[0], st.score[1]],
        };
      }
      function applyX(x) {
        if (!x || typeof x.F !== 'string' || x.F.length !== COLS * ROWS * 2 || !Array.isArray(x.h) || !Array.isArray(x.m) || !Array.isArray(x.s)) return false;
        for (let i = 0; i < x.F.length; i++) if (!validCh(x.F[i])) return false;
        for (let s = 0; s < 2; s++) for (let i = 0; i < COLS * ROWS; i++) st.forts[s][i] = x.F[s * COLS * ROWS + i];
        st.hp = [x.h[0] | 0, x.h[1] | 0];
        st.ammo = [[x.m[0] | 0, x.m[1] | 0], [x.m[2] | 0, x.m[3] | 0]];
        st.score = [x.s[0] | 0, x.s[1] | 0];
        return true;
      }
      function proceed() {
        if (st.hp[0] <= 0 || st.hp[1] <= 0 || round >= ROUNDS) beginEnd();
        else startRound(round + 1);
      }
      function beginEnd() {
        ph = 'end'; endT = 0;
        const dead = [st.hp[0] <= 0, st.hp[1] <= 0];
        const ko = dead[0] || dead[1];
        let winner = -1;
        if (ko && dead[0] !== dead[1]) {
          winner = dead[0] ? 1 : 0;
          if (st.score[winner] <= st.score[1 - winner]) st.score[winner] = st.score[1 - winner] + 1;
        } else if (st.score[0] !== st.score[1]) winner = st.score[0] > st.score[1] ? 0 : 1;
        endInfo = { winner, ko };
        banner(ko ? 'Crown down!' : 'Out of rounds', true);
        banner(winner < 0 ? 'Draw' : winner === mySide ? 'You win!' : names[winner] + ' wins', true);
        celebrate = { side: winner < 0 ? mySide : winner, t: 0 };
        shake = Math.max(shake, 0.4);
      }

      // ---------- update
      const ease = t => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
      function syncScore() {
        if (st.score[mySide] !== lastScore) { lastScore = st.score[mySide]; api.score(lastScore); }
      }
      function update(dt) {
        clock += dt; phT += dt;
        if (shake > 0) shake = Math.max(0, shake - dt);
        for (let s = 0; s < 2; s++) {
          if (recoil[s] > 0) recoil[s] = Math.max(0, recoil[s] - dt * 5);
          if (crownHit[s] > 0) crownHit[s] = Math.max(0, crownHit[s] - dt);
          const c = innerCol(s);
          const k = Math.min(1, dt * 12);
          cvis[s] += (topSurface(s, c) - cvis[s]) * k;
          fvis[s] += (topSurface(s, outerCol(s)) - fvis[s]) * k;
        }
        for (let i = banners.length - 1; i >= 0; i--) { banners[i].t += dt; if (banners[i].t > (banners[i].big ? 1.8 : 1.2)) banners.splice(i, 1); }
        for (let i = rings.length - 1; i >= 0; i--) { rings[i].t += dt; if (rings[i].t > 0.35) rings.splice(i, 1); }
        for (let i = trails.length - 1; i >= 0; i--) { trails[i].t += dt; if (trails[i].t > 0.4) trails.splice(i, 1); }
        for (let i = parts.length - 1; i >= 0; i--) {
          const p = parts[i];
          p.t += dt; p.vy += p.g * dt; p.x += p.vx * dt; p.y += p.vy * dt;
          if (p.t > p.life) parts.splice(i, 1);
        }
        for (let i = falls.length - 1; i >= 0; i--) {
          const f = falls[i]; f.t += dt;
          if (f.r0 * CELL + 450 * f.t * f.t >= f.r1 * CELL) {
            falls.splice(i, 1);
            const [cx, cy] = cellCenter(f.side, f.c, f.r1);
            burst(cx, cy + 5, 1, ['#e8d8b8'], 40, 0.3, 60);
          }
        }
        if (moonT < MOON_GLIDE) moonT = Math.min(MOON_GLIDE, moonT + dt);
        if (celebrate) {
          celebrate.t += dt;
          if (celebrate.t < 2.2 && Math.floor(celebrate.t * 8) !== Math.floor((celebrate.t - dt) * 8)) {
            const cc = crownCenter(celebrate.side);
            burst(cc.x + (Math.random() - 0.5) * 30, cc.y - 20, 8, ['#ffd84a', '#ff6fa8', '#6fd0ff', '#fff', '#8cf06a'], 220, 1.1, 260);
          }
        }

        if (ph === 'build') updateBuild(dt);
        else if (ph === 'wait') updateWait();
        else if (ph === 'aim') updateAim(dt);
        else if (ph === 'fire') {
          if (stepVolley()) { vol = null; settleSide(0, true); settleSide(1, true); ph = 'settle'; phT = 0; }
        } else if (ph === 'settle') {
          if ((phT >= 0.4 && !falls.length) || phT > 3) {
            falls.length = 0;
            if (isHost) { if (versus) publishX(); proceed(); }
            else { ph = 'sync'; phT = 0; }
          }
        } else if (ph === 'sync') {
          const g = api.peer();
          if (g && g.x && g.x.r === round && applyX(g.x)) { proceed(); }
          else if (phT > SYNC_TIMEOUT) proceed();
        } else if (ph === 'end') {
          endT += dt;
          if (endT >= 2.4 && !overCalled) { overCalled = true; ph = 'over'; api.over(); }
        }
        syncScore();
      }
      function updateBuild(dt) {
        buildT += dt;
        camZ = 1;
        if (buildT >= BUILD_SECS) { finishBuild(); return; }
        if (!piece) { finishBuild(); return; }
        if (auto) {
          if (placed >= autoN) { finishBuild(); return; }
          const b = choosePlacement(mySide, piece.cells, spareRnd);
          if (b) { piece.cells = b.cells; piece.x = b.x; piece.y = 0; hardDrop(); }
          else finishBuild();
          return;
        }
        if (grounded()) {
          lockT += dt;
          if (lockT >= LOCK_DELAY) lockPiece();
        } else {
          lockT = 0; gravAcc += dt;
          while (gravAcc >= ROW_SECS && piece) {
            gravAcc -= ROW_SECS;
            if (!hitP(piece.cells, piece.x, piece.y + 1)) piece.y++; else break;
          }
        }
      }
      function updateWait() {
        camZ = 1 - ease(phT / ZOOM_OUT);
        if (versus && !peerLoaded) {
          const g = api.peer();
          if (g && g.p >= 1 && typeof g.f === 'string' && g.f.length === COLS * ROWS) {
            let ok = true;
            for (let i = 0; i < g.f.length; i++) if (!validCh(g.f[i])) { ok = false; break; }
            if (ok) { for (let i = 0; i < g.f.length; i++) st.forts[oppSide][i] = g.f[i]; peerLoaded = true; }
          }
        }
        if (peerLoaded && phT >= ZOOM_OUT) { camZ = 0; startRound(1); }
      }
      function updateAim(dt) {
        camZ = 0;
        botT += dt;
        if (!locked) {
          aimT -= dt;
          if (aimT <= 0) { aimT = 0; lockAim(); }
        }
        if (locked && moonT >= MOON_GLIDE) {
          const pa = peerAimFor(round);
          if (pa) startVolley(pa);
        }
        // my barrel follows my aim
        if (ph === 'aim') {
          let dx = aim.dx, dy = aim.dy;
          let len = Math.sqrt(dx * dx + dy * dy);
          if (!(len >= MIN_DRAG)) { const d = defaultAim(mySide); dx = d.dx; dy = d.dy; len = Math.sqrt(dx * dx + dy * dy); }
          barrel[mySide] = { ux: -dx / len, uy: -dy / len };
        }
      }

      // ---------- input
      function hitBtn(x, y) {
        for (const k of ['ball', 'bomb', 'drill', 'fire']) {
          const b = BTN[k];
          if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return k;
        }
        return null;
      }
      function pressBtn(k) {
        if (k === 'fire') { lockAim(); return; }
        const t = BTN[k].k;
        if (t === 0 || st.ammo[mySide][t - 1] > 0) atype = t;
      }
      function down(x, y) {
        if (ph === 'build') {
          if (!piece) return;
          touch = { sx: x, sy: y, t: clock, col: piece.x, mx: 0, my: 0, soft: 0, softOn: false };
        } else if (ph === 'aim' && !locked) {
          const b = hitBtn(x, y);
          if (b) { btnDown = b; aimDrag = null; return; }
          btnDown = null;
          aimDrag = { sx: x, sy: y };
        }
      }
      function move(x, y) {
        if (ph === 'build') {
          if (!touch || !piece) return;
          const dx = x - touch.sx, dy = y - touch.sy;
          touch.mx = Math.max(touch.mx, Math.abs(dx)); touch.my = Math.max(touch.my, Math.abs(dy));
          const target = touch.col + Math.round(dx / COL_PX);
          while (piece.x !== target) { if (!tryMove(piece.x < target ? 1 : -1, 0)) break; }
          if (!touch.softOn && dy > SOFT_START && dy > 1.2 * Math.abs(dx)) touch.softOn = true;
          if (touch.softOn) {
            const want = 1 + Math.floor((dy - SOFT_START) / SOFT_ROW);
            while (touch.soft < want) { if (!tryMove(0, 1)) break; touch.soft++; }
          }
        } else if (ph === 'aim' && aimDrag && !locked) {
          let dx = x - aimDrag.sx, dy = y - aimDrag.sy;
          const len = Math.sqrt(dx * dx + dy * dy);
          if (len < 8) return;
          if (len > MAX_DRAG) { dx = dx * MAX_DRAG / len; dy = dy * MAX_DRAG / len; }
          aim = { dx: Math.round(dx), dy: Math.round(dy) };
        }
      }
      function up(x, y) {
        if (ph === 'build') {
          if (!touch) return;
          const t = touch; touch = null;
          if (!piece) return;
          const dx = x - t.sx, dy = y - t.sy, dt = clock - t.t;
          const mx = Math.max(t.mx, Math.abs(dx)), my = Math.max(t.my, Math.abs(dy));
          if (mx < TAP_MOVE && my < TAP_MOVE && dt < TAP_TIME && piece.x === t.col) rotate();
          else if (dy > FLICK_DIST && dt < FLICK_TIME && dy > 2 * Math.abs(dx)) hardDrop();
        } else if (ph === 'aim') {
          if (btnDown) { const b = btnDown; btnDown = null; if (hitBtn(x, y) === b) pressBtn(b); }
          aimDrag = null;
        }
      }

      // ---------- render
      function camState() {
        const s = 1 + (ZOOM - 1) * camZ;
        const zc = ZX[mySide] + 52;
        let cx = 180 + (zc - 180) * camZ, cy = 320 + (488.5 - 320) * camZ;
        // While zoomed in, keep the view inside the background painting (no seams at its edges).
        const clamp = (v, lo, hi) => (lo > hi ? (lo + hi) / 2 : Math.max(lo, Math.min(hi, v)));
        cx = clamp(cx, (180 - view.x0) / s, W - (view.x1 - 180) / s);
        if (camZ > 0) cy = clamp(cy, (320 - view.y0) / s, H - (view.y1 - 320) / s);
        return { s, cx, cy };
      }
      function drawCell(g, ch, cx, cy, a) {
        api.draw(g, SPRITE[ch] || 'block_junk', cx, cy, { w: CELL + 0.6, h: CELL + 0.6, alpha: a });
      }
      function drawCannon(g, side) {
        const c = innerCol(side);
        const x = ZX[side] + c * CELL + CELL / 2;
        const by = cvis[side];
        api.draw(g, 'cannon_base', x, by, {});
        const d = barrel[side];
        const a = Math.atan2(d.uy, d.ux);
        const rc = recoil[side] * 4;
        const px = x - d.ux * rc, py = by - 18 - d.uy * rc;
        if (d.ux >= 0) api.draw(g, 'cannon_barrel', px, py, { rot: a });
        else api.draw(g, 'cannon_barrel', px, py, { rot: a - Math.PI, flipX: true });
      }
      function render(g) {
        const cam = camState();
        g.save();
        g.translate(180, 320); g.scale(cam.s, cam.s); g.translate(-cam.cx, -cam.cy);
        if (shake > 0) g.translate((Math.random() - 0.5) * shake * 12, (Math.random() - 0.5) * shake * 12);
        const wx0 = (view.x0 - 180) / cam.s + cam.cx - 30, wx1 = (view.x1 - 180) / cam.s + cam.cx + 30;
        const wy0 = (view.y0 - 320) / cam.s + cam.cy - 30, wy1 = (view.y1 - 320) / cam.s + cam.cy + 30;
        g.fillStyle = '#8ed3f5'; g.fillRect(wx0, wy0, wx1 - wx0, GROUND - wy0);
        g.fillStyle = '#6a4a30'; g.fillRect(wx0, GROUND, wx1 - wx0, wy1 - GROUND);
        api.draw(g, 'bg_fort', 0, 0, { w: W, h: H, ax: 0, ay: 0 });

        // build zone guide
        if (ph === 'build' || ph === 'wait') {
          const zx = ZX[mySide];
          g.fillStyle = 'rgba(255,255,255,0.12)'; g.fillRect(zx, TOP, COLS * CELL, ROWS * CELL);
          g.strokeStyle = 'rgba(255,255,255,0.22)'; g.lineWidth = 0.4;
          g.beginPath();
          for (let c = 0; c <= COLS; c++) { g.moveTo(zx + c * CELL, TOP); g.lineTo(zx + c * CELL, GROUND); }
          for (let r = 0; r <= ROWS; r++) { g.moveTo(zx, TOP + r * CELL); g.lineTo(zx + COLS * CELL, TOP + r * CELL); }
          g.stroke();
          g.strokeStyle = 'rgba(255,255,255,0.7)'; g.lineWidth = 0.8; g.strokeRect(zx, TOP, COLS * CELL, ROWS * CELL);
        }

        // moon
        const mp = moonPos[Math.max(0, round - 1)];
        const mt = ease(moonT / MOON_GLIDE);
        const mx = moonFrom.x + (mp.x - moonFrom.x) * mt, my = moonFrom.y + (mp.y - moonFrom.y) * mt;
        api.draw(g, 'moon', mx, my, { w: MOON_R * 2, h: MOON_R * 2 });

        // flags + cannons
        for (let s = 0; s < 2; s++) {
          const oc = outerCol(s);
          api.draw(g, 'flag_' + color[s], ZX[s] + oc * CELL + CELL / 2, fvis[s], {});
        }
        for (let s = 0; s < 2; s++) drawCannon(g, s);

        // fort blocks (skip cells still falling)
        const fs = new Set();
        for (const f of falls) fs.add(f.side * 1000 + f.r1 * COLS + f.c);
        for (let s = 0; s < 2; s++) {
          const f = st.forts[s];
          for (let r = 0; r < ROWS; r++) {
            for (let c = 0; c < COLS; c++) {
              const ch = f[r * COLS + c];
              if (ch === '.' || fs.has(s * 1000 + r * COLS + c)) continue;
              const [cx, cy] = cellCenter(s, c, r);
              drawCell(g, ch, cx, cy);
            }
          }
          if (st.hp[s] > 0) {
            const wob = crownHit[s] > 0 ? Math.sin(crownHit[s] * 60) * 1.5 : 0;
            api.draw(g, 'crown', ZX[s] + (CROWN_C0 + 1) * CELL + wob, GROUND, { ax: 0.5, ay: 1 });
          }
        }
        for (const f of falls) {
          const y = Math.min(f.r1 * CELL, f.r0 * CELL + 450 * f.t * f.t);
          drawCell(g, f.ch, ZX[f.side] + f.c * CELL + CELL / 2, TOP + y + CELL / 2);
        }

        // falling piece + landing preview (build)
        if (ph === 'build' && piece) {
          const d = dropDist();
          if (d > 0) for (const c of piece.cells) { const [cx, cy] = cellCenter(mySide, piece.x + c.x, piece.y + d + c.y); api.draw(g, 'block_' + piece.col, cx, cy, { w: CELL, h: CELL, alpha: 0.25 }); }
          const frac = grounded() ? 0 : clamp(gravAcc / ROW_SECS, 0, 1);
          for (const c of piece.cells) {
            const [cx, cy] = cellCenter(mySide, piece.x + c.x, piece.y + c.y);
            api.draw(g, 'block_' + piece.col, cx, cy + frac * CELL, { w: CELL + 0.6, h: CELL + 0.6 });
          }
        }

        // crown pips (battlefield only)
        if (camZ < 0.5 && round > 0) {
          for (let s = 0; s < 2; s++) {
            for (let i = 0; i < 3; i++) {
              const px = ZX[s] + 52 + (i - 1) * 13, py = TOP - 12;
              g.beginPath(); g.arc(px, py, 4.2, 0, 6.283);
              g.fillStyle = i < st.hp[s] ? '#ff4b5c' : 'rgba(20,10,50,0.45)'; g.fill();
              g.lineWidth = 1.4; g.strokeStyle = '#fff'; g.stroke();
            }
          }
        }

        // aim dots (my cannon, first 0.35 s, gravity only)
        if (ph === 'aim' && !locked) {
          let dx = aim.dx, dy = aim.dy;
          const len = Math.sqrt(dx * dx + dy * dy);
          if (len >= MIN_DRAG) {
            const sh = mkShot(mySide, aim, 0);
            for (let i = 1; i <= 7; i++) {
              const t = i * 0.05;
              const x = sh.x + sh.vx * t, y = sh.y + sh.vy * t + 0.5 * GRAV * t * t;
              g.beginPath(); g.arc(x, y, 2.6 - i * 0.18, 0, 6.283);
              g.fillStyle = 'rgba(255,255,255,' + (0.95 - i * 0.08).toFixed(2) + ')'; g.fill();
            }
          }
        }

        // shots + trails
        for (const t of trails) {
          g.globalAlpha = Math.max(0, 0.7 * (1 - t.t / 0.4));
          g.fillStyle = '#fff';
          g.beginPath(); g.arc(t.x, t.y, 1.8, 0, 6.283); g.fill();
        }
        g.globalAlpha = 1;
        if (vol) {
          for (const sh of vol.shots) {
            if (!sh.alive) continue;
            if (sh.type === 0) api.draw(g, 'shot_ball', sh.x, sh.y, {});
            else if (sh.type === 1) api.draw(g, 'icon_bomb', sh.x, sh.y, { w: 18, h: 18 });
            else api.draw(g, 'shot_drill', sh.x, sh.y, { rot: Math.atan2(sh.vy, sh.vx) });
          }
        }

        // blasts + particles
        for (const r of rings) {
          const p = r.t / 0.35;
          g.globalAlpha = 1 - p;
          g.fillStyle = 'rgba(255,220,140,0.55)';
          g.beginPath(); g.arc(r.x, r.y, r.R * (0.5 + 0.9 * p), 0, 6.283); g.fill();
          g.lineWidth = 2; g.strokeStyle = '#fff';
          g.beginPath(); g.arc(r.x, r.y, r.R * (0.7 + 1.1 * p), 0, 6.283); g.stroke();
        }
        g.globalAlpha = 1;
        for (const p of parts) {
          g.globalAlpha = Math.max(0, 1 - p.t / p.life);
          g.fillStyle = p.c;
          g.fillRect(p.x - p.r / 2, p.y - p.r / 2, p.r, p.r);
        }
        g.globalAlpha = 1;
        g.restore();

        renderHud(g);
      }

      function renderHud(g) {
        // timer + round (just below the app's score area)
        let big = '', small = '', status = '';
        if (ph === 'build') {
          const left = Math.max(0, Math.ceil(BUILD_SECS - buildT));
          big = String(left); small = 'Build your fort';
        } else if (ph === 'wait') {
          small = 'Fort built';
          if (versus && !peerLoaded && phT >= ZOOM_OUT) status = 'Waiting for ' + nameOpp + '…';
        } else if (round > 0) {
          small = 'Round ' + round + '/' + ROUNDS;
          if (ph === 'aim') {
            big = String(Math.ceil(aimT));
            if (locked) status = versus ? (peerAimFor(round) ? '' : 'Waiting for ' + nameOpp + '…') : (botT >= botLockAt ? '' : nameOpp + ' is aiming');
            else {
              const ready = versus ? (() => { const g2 = api.peer(); return !!(g2 && g2.r === round && g2.l === 1); })() : botT >= botLockAt;
              status = nameOpp + (ready ? ' is ready' : ' is aiming');
            }
          } else if (ph === 'sync') status = 'Syncing…';
        }
        if (small) {
          // dark pill so the label reads over the painted clouds
          g.font = '800 13px ' + FONT;
          const tw = g.measureText(small).width;
          g.fillStyle = 'rgba(20,10,50,0.55)';
          rrect(g, 6, 101, tw + 14, 22, 11); g.fill();
          text(g, small, 13, 112, 13, '#fff', 'left', 800);
        }
        if (big) {
          const urgent = (ph === 'aim' && !locked && aimT <= 5) || (ph === 'build' && BUILD_SECS - buildT <= 5);
          g.font = '800 38px ' + FONT; g.textAlign = 'center'; g.textBaseline = 'middle';
          g.lineJoin = 'round'; g.lineWidth = 7; g.strokeStyle = 'rgba(20,10,50,0.85)';
          g.strokeText(big, 180, 128);
          g.fillStyle = urgent ? '#ff7a7a' : '#fff'; g.fillText(big, 180, 128);
        }
        if (status) text(g, status, 180, 160, 14, '#fff', 'center', 800);

        if (ph === 'build') {
          // next piece
          const q = queue[0];
          if (q) {
            g.fillStyle = 'rgba(15,12,35,0.55)'; rrect(g, 298, 108, 54, 44, 8); g.fill();
            const [w, h] = dims(q.cells);
            const s = 11, ox = 325 - w * s / 2, oy = 130 - h * s / 2;
            for (const c of q.cells) api.draw(g, 'block_' + q.col, ox + c.x * s + s / 2, oy + c.y * s + s / 2, { w: s, h: s });
          }
          if (placed < 3) text(g, 'Drag to move · Tap to turn · Flick down to drop', 180, 530, 12, 'rgba(255,255,255,0.9)', 'center', 700);
        }

        if (ph === 'aim' || ph === 'fire' || ph === 'settle' || ph === 'sync') {
          const canAct = ph === 'aim' && !locked;
          for (const k of ['ball', 'bomb', 'drill']) {
            const b = BTN[k], n = k === 'ball' ? 1 : st.ammo[mySide][b.k - 1];
            const sel = atype === b.k, off = n <= 0;
            g.fillStyle = sel ? 'rgba(255,226,122,0.95)' : 'rgba(25,20,55,0.78)';
            rrect(g, b.x, b.y, b.w, b.h, 12); g.fill();
            g.lineWidth = 2; g.strokeStyle = sel ? '#fff' : 'rgba(255,255,255,0.35)';
            rrect(g, b.x, b.y, b.w, b.h, 12); g.stroke();
            g.globalAlpha = off ? 0.35 : (canAct ? 1 : 0.6);
            if (k === 'ball') api.draw(g, 'shot_ball', b.x + b.w / 2, b.y + 20, { w: 18, h: 18 });
            else if (k === 'bomb') api.draw(g, 'icon_bomb', b.x + b.w / 2, b.y + 20, { w: 28, h: 28 });
            else api.draw(g, 'shot_drill', b.x + b.w / 2, b.y + 20, { w: 30, h: 16 });
            g.globalAlpha = 1;
            const lab = (k === 'ball' ? 'Ball ∞' : k === 'bomb' ? 'Bomb ' + n : 'Drill ' + n);
            text(g, lab, b.x + b.w / 2, b.y + 42, 12, sel ? '#2b2453' : '#fff', 'center', 800);
          }
          const f = BTN.fire;
          const pulse = canAct ? 0.5 + 0.5 * Math.sin(clock * 6) : 0;
          g.fillStyle = canAct ? 'rgb(' + (230 + 20 * pulse | 0) + ',70,70)' : 'rgba(25,20,55,0.78)';
          rrect(g, f.x, f.y, f.w, f.h, 14); g.fill();
          g.lineWidth = 2.5; g.strokeStyle = '#fff'; rrect(g, f.x, f.y, f.w, f.h, 14); g.stroke();
          text(g, canAct ? 'FIRE' : (ph === 'aim' ? 'Locked' : ''), f.x + f.w / 2, f.y + f.h / 2, 26, '#fff', 'center', 800);
          if (ph === 'aim' && !locked && round === 1 && aimT > AIM_SECS - 4) text(g, 'Drag back to aim, then Fire', 180, 556 - 8, 12, 'rgba(255,255,255,0.95)', 'center', 800);
          // sling line
          if (aimDrag && canAct) {
            g.strokeStyle = 'rgba(255,255,255,0.5)'; g.lineWidth = 3; g.setLineDash([6, 6]);
            g.beginPath(); g.moveTo(aimDrag.sx, aimDrag.sy); g.lineTo(aimDrag.sx + aim.dx, aimDrag.sy + aim.dy); g.stroke();
            g.setLineDash([]);
            g.beginPath(); g.arc(aimDrag.sx, aimDrag.sy, 7, 0, 6.283); g.fillStyle = 'rgba(255,255,255,0.7)'; g.fill();
            const pw = Math.min(1, Math.hypot(aim.dx, aim.dy) / MAX_DRAG);
            g.fillStyle = 'rgba(15,12,35,0.6)'; rrect(g, 120, 566 - 14, 120, 8, 4); g.fill();
            g.fillStyle = '#ffd84a'; rrect(g, 120, 566 - 14, 120 * pw, 8, 4); g.fill();
          }
        }

        // banners
        for (let i = 0; i < banners.length; i++) {
          const b = banners[i], life = b.big ? 1.8 : 1.2, p = b.t / life;
          const e = 1 - Math.pow(1 - Math.min(1, p * 2.5), 3);
          const sc = 0.6 + 0.5 * e + 0.1 * p;
          const al = p < 0.6 ? 1 : Math.max(0, 1 - (p - 0.6) / 0.4);
          g.save();
          g.translate(180, 330 - (banners.length - 1 - i) * 44); g.scale(sc, sc); g.globalAlpha = al;
          outlined(g, b.s, 0, 0, 34);
          g.restore();
        }
      }

      // ---------- ghost
      function ghost() {
        const pc = ph === 'build' ? 0 : ph === 'wait' ? 1 : (ph === 'end' || ph === 'over') ? 3 : 2;
        if (!versus) return { p: pc, r: round };
        const o = { p: pc, r: round, a: [aim.dx, aim.dy], t: atype, l: locked ? 1 : 0, m: [st.ammo[mySide][0], st.ammo[mySide][1]] };
        if (prevAim) o.q = [prevAim.dx, prevAim.dy, prevAim.t];
        if (pc >= 1) {
          const g = api.peer();
          if (!(g && g.p >= 2)) o.f = fortStr(mySide);
        }
        if (hostX) o.x = hostX;
        return o;
      }

      api.score(0);
      banner('Build your fort!');
      syncScore();

      return {
        update, render, down, up, move, ghost,
        _dbg() { return { st, round, ph, mySide, overCalled, locked, placed, peerLoaded, fort: [fortStr(0), fortStr(1)], hp: st.hp.slice(), score: st.score.slice(), ammo: st.ammo.map(a => a.slice()) }; },
      };
    },
  });
})();
