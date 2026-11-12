/* Critter Clash: two-player artillery skirmish. Each team has three round critters on a hilly island.
 * Every round BOTH players move one critter and aim at the same time, then all shots fly together and
 * blasts carve the ground away. Last team standing wins.
 *
 * Determinism: the volley (fixed 1/120 s steps; only + - * / sqrt, no trig, no Math.random) runs identically
 * on both phones from the same terrain mask, critter state and the two locked setups. A setup includes the
 * active critter's final position, so walking and hopping are never simulated on the other phone.
 * Terrain, wind and the spawn spots come from private streams seeded from api.rng at init (same call order on
 * both phones). The host (the name that sorts first, left team) puts the round's resulting state in its ghost
 * after every volley and the other phone adopts it (including the round's craters) before the next round.
 *
 * Score = damage dealt to the enemy + 100 per enemy critter knocked out + 200 for the win. Fall and drowning
 * damage is credited to whoever last blasted the critter. The winner is lifted to at least (other + 1). */
(function () {
  'use strict';

  const W = 360, H = 640, DT = 1 / 120;
  const WATER = 600;
  const GRAV = 400, POWER = 3.4, MAX_DRAG = 140, MIN_DRAG = 12, DEF_DRAG = 90;
  const WIND_ACC = 60;
  const FUSE = 3.0, BOUNCE = 0.6;
  const ROUNDS = 15, AIM_SECS = 15, SYNC_TIMEOUT = 6;
  const HP0 = 100, FALL_FREE = 60;
  const WALK_SPD = 40, STAMINA = 70, HOP_COST = 20;
  const SLIDE_SLOPE = 1.5, SLIDE_SPD = 30, SLIDE_MAX = 12;
  const BODY = 9;                          // critter hit circle radius; center is 9 above the feet
  const TS = 2;                            // terrain canvas scale
  // weapons: 0 rocket, 1 grenade, 2 cluster (splits into 3 = bomblets)
  const WPN = [
    { R: 26, D: 45, K: 300 },
    { R: 30, D: 50, K: 340 },
    { R: 26, D: 45, K: 300 },
    { R: 14, D: 22, K: 150 },
  ];
  const FAN = [[-70, -105], [-35, -125], [0, -135], [35, -125], [70, -105]];
  const FONT = 'ui-rounded, system-ui, sans-serif';
  const hasDom = typeof document !== 'undefined' && !!document.createElement;

  const BTN = {
    left: { x: 4, y: 578, w: 40, h: 50 },
    right: { x: 46, y: 578, w: 40, h: 50 },
    jump: { x: 88, y: 578, w: 46, h: 50 },
    w0: { x: 138, y: 578, w: 42, h: 50, t: 0 },
    w1: { x: 182, y: 578, w: 42, h: 50, t: 1 },
    w2: { x: 226, y: 578, w: 42, h: 50, t: 2 },
    fire: { x: 272, y: 578, w: 84, h: 50 },
  };
  const BTN_KEYS = ['left', 'right', 'jump', 'w0', 'w1', 'w2', 'fire'];

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
  const r1 = v => Math.round(v * 10) / 10;
  const fin = v => typeof v === 'number' && isFinite(v);
  const defAim = team => (team === 0 ? { dx: -64, dy: 64 } : { dx: 64, dy: 64 });

  Arcade.register({
    id: 'critters', name: 'Critter Clash', blurb: 'Three critters each. Aim together, blast the island.', peerSync: true,
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
      const BOT_NOISE = 10;

      // private streams (same call order on both phones)
      const seed = () => (api.rng() * 4294967296) >>> 0;
      const terrRnd = mulberry32(seed()), windRnd = mulberry32(seed()), spawnRnd = mulberry32(seed());
      const botRnd = mulberry32(seed()), autoRnd = mulberry32(seed());

      // ---------- terrain: control heights, mirrored left to right (fair) with small differences
      const CPX = [12, 68, 124, 180, 236, 292, 348];
      const CPH = [605, 0, 0, 0, 0, 0, 605];
      {
        let a = 440, b = 390, c = 450;
        for (let tr = 0; tr < 40; tr++) {
          const a2 = 380 + terrRnd() * 110, b2 = 370 + terrRnd() * 120, c2 = 350 + terrRnd() * 140;
          if (Math.abs(a2 - b2) <= 100 && Math.abs(b2 - c2) <= 100 && Math.max(a2, b2, c2) - Math.min(a2, b2, c2) >= 55) { a = a2; b = b2; c = c2; break; }
        }
        const jit = () => (terrRnd() * 2 - 1) * 14;
        CPH[1] = a; CPH[2] = b; CPH[3] = c;
        CPH[5] = clamp(a + jit(), 340, 510); CPH[4] = clamp(b + jit(), 340, 510);
      }
      const BP = [];
      for (let i = 0; i < 27; i++) BP.push((terrRnd() * 2 - 1) * 4.5);
      const sstep = t => t * t * (3 - 2 * t);
      function terrH(x) {
        const k = Math.min(5, Math.max(0, Math.floor((x - 12) / 56)));
        const t = (x - 12 - 56 * k) / 56;
        const bi = Math.min(25, Math.max(0, Math.floor(x / 14))), bt = (x - 14 * bi) / 14;
        return CPH[k] + (CPH[k + 1] - CPH[k]) * sstep(t) + BP[bi] + (BP[bi + 1] - BP[bi]) * sstep(bt);
      }
      const mask = new Uint8Array(W * H);
      for (let x = 0; x < W; x++) {
        const top = (x < 12 || x >= 348) ? H : Math.ceil(terrH(x + 0.5));
        for (let y = Math.max(0, top); y < H; y++) mask[y * W + x] = 1;
      }
      const baseMask = mask.slice();
      function solid(x, y) {
        const xi = Math.floor(x), yi = Math.floor(y);
        if (xi < 0 || xi >= W || yi < 0) return false;
        if (yi >= H) return true;
        return mask[yi * W + xi] === 1;
      }
      function carveMask(cx, cy, R) {
        const R2 = R * R;
        for (let y = Math.max(0, cy - R); y <= Math.min(H - 1, cy + R); y++) {
          const dy = y + 0.5 - cy;
          for (let x = Math.max(0, cx - R); x <= Math.min(W - 1, cx + R); x++) {
            const dx = x + 0.5 - cx;
            if (dx * dx + dy * dy <= R2) mask[y * W + x] = 0;
          }
        }
      }

      // ---------- shared state
      const st = { cr: [[], []], ammo: [1, 1], score: [0, 0] };
      const spawn = [[], []];
      {
        const baseL = [70, 116, 158];
        for (let i = 0; i < 3; i++) {
          const bx = baseL[i] + (spawnRnd() * 2 - 1) * 6;
          for (let side = 0; side < 2; side++) {
            const x0 = side === 0 ? bx : 360 - bx;
            let best = x0;
            for (const off of [0, -5, 5, -10, 10, -15, 15, -20, 20, -25, 25]) {
              const xx = x0 + off;
              if (Math.abs(terrH(xx + 4) - terrH(xx - 4)) / 8 <= 0.8) { best = xx; break; }
            }
            spawn[side].push(Math.round(best));
          }
        }
      }
      for (let t = 0; t < 2; t++) {
        for (let i = 0; i < 3; i++) {
          const x = spawn[t][i];
          let y = 0; while (y < H - 1 && !solid(x, y)) y++;
          st.cr[t].push({ team: t, i, x, y, hp: HP0, vx: 0, vy: 0, air: false, fy: y, slid: 0, lastBy: -1, face: t === 0 ? 1 : -1, vh: HP0, flash: 0, bob: 0 });
        }
      }
      const windArr = [];
      for (let i = 0; i < ROUNDS + 1; i++) windArr.push(Math.round((windRnd() * 2 - 1) * 10) / 10);
      const roundLog = [];
      let round = 0, wind = 0;
      let ph = 'aim', phT = 0, clock = 0;
      let lastScore = -1, overCalled = false;

      // ---------- fx (cosmetic only)
      const parts = [], rings = [], pops = [], banners = [], trails = [];
      let shake = 0, celebrate = null;
      function banner(s, big) { banners.push({ s, t: 0, big: !!big }); if (banners.length > 3) banners.shift(); }
      function burst(x, y, n, cols, sp, life, grav, up) {
        if (parts.length > 380) return;
        for (let i = 0; i < n; i++) {
          const a = Math.random() * 6.283, v = sp * (0.3 + Math.random() * 0.7);
          parts.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - (up == null ? sp * 0.25 : up), g: grav == null ? 300 : grav, t: 0, life: life * (0.6 + Math.random() * 0.6), r: 1.5 + Math.random() * 2.4, c: cols[(Math.random() * cols.length) | 0] });
        }
      }
      function pop(x, y, s, col) { pops.push({ x, y, s, t: 0, col: col || '#fff' }); if (pops.length > 14) pops.shift(); }

      // ---------- terrain canvas
      let terrCv = null, tg = null, texBuilt = false;
      function buildTerrain() {
        if (!hasDom) return;
        if (!terrCv) { terrCv = document.createElement('canvas'); terrCv.width = W * TS; terrCv.height = H * TS; tg = terrCv.getContext('2d'); }
        const g = tg;
        g.setTransform(TS, 0, 0, TS, 0, 0); g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1;
        g.clearRect(0, 0, W, H);
        g.save();
        g.beginPath(); g.moveTo(12, H);
        for (let x = 12; x < 348; x += 2) g.lineTo(x, terrH(x + 1));
        g.lineTo(348, H); g.closePath(); g.clip();
        if (api.has('tex_soil')) {
          for (let ty = 300; ty < H; ty += 64) for (let tx = 0; tx < W; tx += 64) api.draw(g, 'tex_soil', tx, ty, { w: 64, h: 64, ax: 0, ay: 0 });
        } else { g.fillStyle = '#7a5230'; g.fillRect(0, 300, W, H - 300); }
        const gr = g.createLinearGradient(0, 330, 0, 600);
        gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(30,12,0,0.38)');
        g.fillStyle = gr; g.fillRect(0, 300, W, H - 300);
        if (api.has('tex_grass')) {
          for (let xs = 12; xs < 348; xs += 4) {
            const y = terrH(xs + 2);
            g.save(); g.beginPath(); g.rect(xs, 0, 4, H); g.clip();
            api.draw(g, 'tex_grass', Math.floor(xs / 64) * 64, y - 4, { w: 64, h: 12, ax: 0, ay: 0 });
            g.restore();
          }
        }
        g.restore();
        for (let r = 1; r < roundLog.length; r++) if (roundLog[r]) for (const c of roundLog[r]) cutCanvas(c[0], c[1], c[2]);
      }
      function cutCanvas(cx, cy, R) {
        if (!tg) return;
        const g = tg;
        g.globalCompositeOperation = 'destination-out';
        g.beginPath(); g.arc(cx, cy, R, 0, 6.2832); g.fillStyle = '#000'; g.fill();
        g.globalCompositeOperation = 'source-atop';
        g.beginPath(); g.arc(cx, cy, R + 1.5, 0, 6.2832); g.lineWidth = 4; g.strokeStyle = 'rgba(40,18,4,0.42)'; g.stroke();
        g.globalCompositeOperation = 'source-over';
      }
      function carve(x, y, R) {
        const cx = Math.round(x), cy = Math.round(y);
        carveMask(cx, cy, R);
        if (!roundLog[round]) roundLog[round] = [];
        roundLog[round].push([cx, cy, R]);
        cutCanvas(cx, cy, R);
        burst(cx, cy, R >= 26 ? 14 : 8, ['#6b4a2b', '#8a6238', '#4f8a3a', '#a07a48'], 150 + R * 3, 0.8, 420);
      }
      function rebuildMask() {
        mask.set(baseMask);
        for (let r = 1; r < roundLog.length; r++) if (roundLog[r]) for (const c of roundLog[r]) carveMask(c[0], c[1], c[2]);
      }

      // ---------- queries
      function critterAt(x, y) {
        for (let t = 0; t < 2; t++) for (let i = 0; i < 3; i++) {
          const c = st.cr[t][i];
          if (c.hp <= 0) continue;
          const dx = x - c.x, dy = y - (c.y - BODY);
          if (dx * dx + dy * dy < BODY * BODY) return c;
        }
        return null;
      }
      function nextAlive(team, from) {
        for (let k = 1; k <= 3; k++) { const i = (from + k + 3) % 3; if (st.cr[team][i].hp > 0) return i; }
        return -1;
      }
      const aliveCount = t => st.cr[t].filter(c => c.hp > 0).length;
      const totalHp = t => st.cr[t].reduce((s, c) => s + c.hp, 0);
      function groundRow(x, y) {
        const y0 = Math.floor(y);
        for (let yy = y0 - 6; yy <= y0 + 8; yy++) if (solid(x, yy) && !solid(x, yy - 1)) return yy;
        return null;
      }
      function surfAt(x, yc) {
        const y0 = Math.floor(yc);
        for (let yy = y0 - 10; yy <= y0 + 10; yy++) if (solid(x, yy)) return yy;
        return y0 + 11;
      }
      // moves a standing thing along the ground by dx (no fall); false when blocked
      function walkMove(c, dx, cl, dn) {
        const nx = c.x + dx;
        if (nx < 14 || nx > 346) return false;
        const y0 = Math.floor(c.y), top = y0 - cl;
        if (solid(nx, top)) return false;
        for (let yy = top; yy <= y0 + dn; yy++) if (solid(nx, yy)) { c.x = nx; c.y = yy; return true; }
        return false;
      }

      // ---------- damage
      function hurt(c, dmg, by) {
        const lost = Math.min(dmg, c.hp);
        if (lost <= 0) return;
        c.hp -= lost; c.flash = 0.35;
        if (by >= 0 && by !== c.team) {
          st.score[by] += lost;
          if (c.hp <= 0) st.score[by] += 100;
        }
        pop(c.x, c.y - 26, '-' + lost, '#ffd0d0');
        if (c.hp <= 0) {
          c.hp = 0;
          pop(c.x, c.y - 40, 'KO!', '#ffe27a');
          burst(c.x, c.y - 9, 22, ['#fff', '#ffd84a', color[c.team] === 'pink' ? '#ff7ab8' : '#6aa8ff'], 200, 0.8, 300);
          shake = Math.max(shake, 0.3);
        }
      }
      function drown(c) {
        if (c.hp <= 0) return;
        pop(c.x, WATER - 16, 'Splash!', '#bfe6ff');
        burst(c.x, WATER, 14, ['#fff', '#9fd8ff', '#5fb0f0'], 140, 0.7, 380);
        hurt(c, c.hp, c.lastBy);
      }

      // ---------- critter physics
      function land(c, noDmg) {
        c.air = false; c.vx = 0; c.vy = 0;
        const drop = c.y - c.fy;
        if (!noDmg && drop > FALL_FREE) {
          const dmg = Math.floor((drop - FALL_FREE) / 2);
          if (dmg > 0) { hurt(c, dmg, c.lastBy); shake = Math.max(shake, 0.15); burst(c.x, c.y, 6, ['#a07a48', '#fff'], 90, 0.4, 300); }
        }
        return 1;
      }
      // returns 0 resting, 1 landed this tick, 2 still moving (sliding), 3 airborne
      function stepCritter(c, noDmg) {
        if (c.y > WATER) { if (!noDmg) drown(c); return 0; }
        if (c.air) {
          c.vy += GRAV * DT;
          let nx = c.x + c.vx * DT, ny = c.y + c.vy * DT;
          if (nx < 3) { nx = 3; c.vx = Math.abs(c.vx) * 0.3; } else if (nx > 357) { nx = 357; c.vx = -Math.abs(c.vx) * 0.3; }
          if (c.vx !== 0 && solid(nx + (c.vx > 0 ? 4 : -4), c.y - 5)) { c.vx = -c.vx * 0.3; nx = c.x; }
          if (c.vy < 0 && solid(nx, ny - 11)) { c.vy = 0; ny = c.y; }
          if (c.vy > 0) {
            const d = ny - c.y, n = Math.max(1, Math.ceil(d));
            for (let k = 1; k <= n; k++) {
              const yy = c.y + d * k / n;
              if (solid(nx, yy)) {
                let r = Math.floor(yy), g = 0;
                while (g < 40 && solid(nx, r - 1)) { r--; g++; }
                c.x = nx; c.y = r;
                return land(c, noDmg);
              }
            }
          }
          c.x = nx; c.y = ny;
          return 3;
        }
        if (solid(c.x, c.y - 1)) { let u = 0; while (u < 10 && solid(c.x, c.y - 1)) { c.y--; u++; } }
        if (!solid(c.x, c.y + 0.5)) {
          let k = 1;
          while (k <= 3 && !solid(c.x, c.y + k + 0.5)) k++;
          if (k <= 3) c.y += k;
          else { c.air = true; c.fy = c.y; c.vy = 0; c.vx = 0; return 3; }
        }
        if (!noDmg && c.slid < SLIDE_MAX) {
          const hl = surfAt(c.x - 3, c.y), hr = surfAt(c.x + 3, c.y);
          const sl = (hr - hl) / 6;
          if (sl > SLIDE_SLOPE || sl < -SLIDE_SLOPE) {
            const dx = (sl > 0 ? 1 : -1) * SLIDE_SPD * DT;
            if (walkMove(c, dx, 2, 3)) { c.slid += SLIDE_SPD * DT; return 2; }
            c.slid = SLIDE_MAX;
          }
        }
        return 0;
      }

      // ---------- shots
      function mkShot(team, from, a, type) {
        let dx = a.dx, dy = a.dy;
        let len = Math.sqrt(dx * dx + dy * dy);
        if (!(len >= MIN_DRAG)) { const d = defAim(team); dx = d.dx; dy = d.dy; len = Math.sqrt(dx * dx + dy * dy); }
        if (len > MAX_DRAG) { dx = dx * MAX_DRAG / len; dy = dy * MAX_DRAG / len; len = MAX_DRAG; }
        const ux = -dx / len, uy = -dy / len;
        return { team, type, x: from.x + ux * 12, y: from.y - 8 + uy * 12, vx: -dx * POWER, vy: -dy * POWER, t: 0, alive: true, rest: false, n: 0, grace: 0, spin: 0 };
      }
      function surfNormal(x, y) {
        let nx = 0, ny = 0;
        for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) if (!solid(x + dx, y + dy)) { nx += dx; ny += dy; }
        const l = Math.sqrt(nx * nx + ny * ny);
        return l < 0.01 ? { x: 0, y: -1 } : { x: nx / l, y: ny / l };
      }
      // advances one tick; returns null or an event {k, x, y, c?, hx?, hy?}
      function stepShot(sh, wnd) {
        if (sh.rest) {
          if (!solid(sh.x, sh.y + 1.5)) sh.rest = false;
          else { sh.t += DT; return sh.t >= FUSE ? { k: 'fuse' } : null; }
        }
        if (sh.type !== 1) sh.vx += wnd * WIND_ACC * DT;
        sh.vy += GRAV * DT;
        const dx = sh.vx * DT, dy = sh.vy * DT;
        const n = Math.max(1, Math.ceil(Math.sqrt(dx * dx + dy * dy)));
        let lx = sh.x, ly = sh.y;
        const px = sh.x, py = sh.y;
        sh.t += DT;
        for (let k = 1; k <= n; k++) {
          const x = px + dx * k / n, y = py + dy * k / n;
          if (x < -20 || x > 380 || sh.t > 16) { sh.x = x; sh.y = y; return { k: 'off' }; }
          if (y >= WATER) { sh.x = x; sh.y = WATER; return { k: 'water' }; }
          if (solid(x, y)) { sh.x = lx; sh.y = ly; return { k: 'ground', hx: x, hy: y }; }
          if (sh.type !== 1 && sh.t >= sh.grace) {
            const c = critterAt(x, y);
            if (c) { sh.x = x; sh.y = y; return { k: 'crit', c }; }
          }
          lx = x; ly = y;
        }
        sh.x = lx; sh.y = ly;
        if (sh.type === 1 && sh.t >= FUSE) return { k: 'fuse' };
        return null;
      }

      // ---------- volley
      let vol = null;
      function explode(x, y, w, team) {
        const { R, D, K } = WPN[w];
        carve(x, y, R);
        const Rh = R + 6;
        for (let t = 0; t < 2; t++) for (let i = 0; i < 3; i++) {
          const c = st.cr[t][i];
          if (c.hp <= 0) continue;
          const ex = c.x - x, ey = (c.y - BODY) - y;
          const d = Math.sqrt(ex * ex + ey * ey);
          if (d >= Rh) continue;
          const f = 1 - d / Rh;
          const dmg = Math.max(1, Math.round(D * f));
          c.lastBy = team;
          // impulse away from the blast, with an upward bias, scaled by distance
          let ux = d > 0.001 ? ex / d : 0, uy = d > 0.001 ? ey / d : -1;
          uy -= 0.35;
          const ul = Math.sqrt(ux * ux + uy * uy);
          ux /= ul; uy /= ul;
          if (!c.air) { c.air = true; c.fy = c.y; }
          c.vx += ux * K * f; c.vy += uy * K * f;
          hurt(c, dmg, team);
        }
        rings.push({ x, y, R, t: 0 });
        burst(x, y, R >= 26 ? 26 : 12, ['#fff', '#ffd27a', '#ff8a3d', '#ff5a3d', '#555'], 110 + R * 4, 0.6);
        shake = Math.max(shake, R >= 30 ? 0.4 : R >= 26 ? 0.32 : 0.14);
      }
      function resolve(sh, ev) {
        const k = ev.k;
        if (k === 'off') { sh.alive = false; return; }
        if (k === 'water') {
          sh.alive = false;
          burst(sh.x, WATER, 8, ['#fff', '#9fd8ff'], 120, 0.5, 380);
          return;
        }
        if (sh.type === 1) {
          if (k === 'fuse') { sh.alive = false; explode(sh.x, sh.y, 1, sh.team); return; }
          // bounce
          const n = surfNormal(ev.hx, ev.hy);
          const dot = sh.vx * n.x + sh.vy * n.y;
          let vx = sh.vx - 2 * dot * n.x, vy = sh.vy - 2 * dot * n.y;
          vx *= BOUNCE; vy *= BOUNCE;
          const sp = Math.sqrt(vx * vx + vy * vy);
          if (vx * n.x + vy * n.y <= 0) { vx = n.x * sp * 0.5; vy = n.y * sp * 0.5; }
          sh.vx = vx; sh.vy = vy;
          if (sp < 30) { sh.vx = 0; sh.vy = 0; sh.rest = true; }
          burst(sh.x, sh.y, 3, ['#a07a48', '#fff'], 60, 0.3, 300);
          return;
        }
        const hx = k === 'ground' ? ev.hx : sh.x, hy = k === 'ground' ? ev.hy : sh.y;
        sh.alive = false;
        if (sh.type === 2) {
          for (let i = 0; i < 5; i++) {
            vol.shots.push({ team: sh.team, type: 3, x: sh.x, y: sh.y - 3, vx: FAN[i][0] + sh.vx * 0.25, vy: FAN[i][1], t: 0, alive: true, rest: false, n: 0, grace: 0.15, spin: 0 });
          }
          burst(sh.x, sh.y, 10, ['#fff', '#ffd27a'], 120, 0.4, 100);
          rings.push({ x: sh.x, y: sh.y, R: 10, t: 0 });
          shake = Math.max(shake, 0.12);
          return;
        }
        explode(hx, hy, sh.type, sh.team);
      }
      function startVolley(sa) {
        // sa: setups by team
        vol = { t: 0, shots: [], quiet: 0 };
        for (let t = 0; t < 2; t++) {
          const s = sa[t];
          let i = s.i;
          if (!(i >= 0 && i < 3) || st.cr[t][i].hp <= 0) i = nextAlive(t, -1);
          const c = st.cr[t][i];
          c.x = clamp(s.x, 12, 348); c.y = s.y; c.face = s.f;
          s.i = i;
        }
        for (let t = 0; t < 2; t++) for (let i = 0; i < 3; i++) {
          const c = st.cr[t][i];
          if (c.hp <= 0) continue;
          c.vx = 0; c.vy = 0; c.slid = 0; c.lastBy = -1; c.fy = c.y;
          c.air = !solid(c.x, c.y + 0.5);
        }
        for (let t = 0; t < 2; t++) {
          const s = sa[t], c = st.cr[t][s.i];
          let type = s.t | 0;
          if (type < 0 || type > 2) type = 0;
          if (type === 2) { if (st.ammo[t] > 0) st.ammo[t]--; else type = 0; }
          const sh = mkShot(t, c, { dx: s.dx, dy: s.dy }, type);
          vol.shots.push(sh);
          burst(sh.x, sh.y, 8, ['#fff', '#ffe27a', '#ff9a3c'], 120, 0.3, 0);
          c.bob = 1;
        }
        shake = Math.max(shake, 0.18);
        ph = 'fire'; phT = 0;
      }
      function stepVolley() {
        vol.t += DT;
        const n0 = vol.shots.length;
        for (let k = 0; k < n0; k++) {
          const sh = vol.shots[k];
          if (!sh.alive) continue;
          const ev = stepShot(sh, wind);
          if (ev) resolve(sh, ev);
          else { sh.spin += DT; if ((++sh.n & 3) === 0) trails.push({ x: sh.x, y: sh.y, t: 0 }); }
        }
        if (vol.shots.some(s => !s.alive)) vol.shots = vol.shots.filter(s => s.alive);
        if (vol.t > 16) vol.shots.length = 0;
        let moving = false;
        for (let t = 0; t < 2; t++) for (let i = 0; i < 3; i++) {
          const c = st.cr[t][i];
          if (c.hp <= 0) continue;
          const r = stepCritter(c, false);
          if (r !== 0) moving = true;
        }
        if (vol.t > 22) {
          for (let t = 0; t < 2; t++) for (let i = 0; i < 3; i++) {
            const c = st.cr[t][i];
            let g = 0;
            while (c.hp > 0 && c.air && g++ < 4000) stepCritter(c, false);
            c.slid = SLIDE_MAX;
          }
          return true;
        }
        if (!vol.shots.length && !moving) vol.quiet += DT; else vol.quiet = 0;
        return vol.quiet >= 0.35;
      }
      function finalize() {
        for (let t = 0; t < 2; t++) for (let i = 0; i < 3; i++) {
          const c = st.cr[t][i];
          if (c.hp <= 0) continue;
          c.x = Math.round(c.x); c.vx = 0; c.vy = 0; c.slid = 0; c.lastBy = -1;
          const gr = groundRow(c.x, c.y);
          c.y = gr !== null ? gr : Math.round(c.y);
          c.air = !solid(c.x, c.y + 0.5);
          c.fy = c.y;
        }
      }

      // ---------- host state exchange
      let hostX = null;
      const flatLog = r => { const o = []; if (roundLog[r]) for (const c of roundLog[r]) o.push(c[0], c[1], c[2]); return o; };
      function publishX() {
        const c = [];
        for (let t = 0; t < 2; t++) for (let i = 0; i < 3; i++) { const k = st.cr[t][i]; c.push(k.x, k.y, k.hp); }
        hostX = { r: round, c, m: [st.ammo[0], st.ammo[1]], s: [st.score[0], st.score[1]], k: flatLog(round) };
      }
      function applyX(x) {
        if (!x || !Array.isArray(x.c) || x.c.length !== 18 || !Array.isArray(x.m) || !Array.isArray(x.s) || !Array.isArray(x.k) || x.k.length % 3) return false;
        for (const v of x.c) if (!fin(v)) return false;
        for (const v of x.k) if (!fin(v)) return false;
        for (let t = 0; t < 2; t++) for (let i = 0; i < 3; i++) {
          const c = st.cr[t][i], b = (t * 3 + i) * 3;
          c.x = x.c[b]; c.y = x.c[b + 1]; c.hp = Math.max(0, x.c[b + 2] | 0);
          c.vx = 0; c.vy = 0; c.slid = 0; c.air = c.hp > 0 && !solid(c.x, c.y + 0.5); c.fy = c.y;
        }
        st.ammo = [x.m[0] | 0, x.m[1] | 0];
        st.score = [x.s[0] | 0, x.s[1] | 0];
        if (JSON.stringify(flatLog(round)) !== JSON.stringify(x.k)) {
          const l = [];
          for (let i = 0; i < x.k.length; i += 3) l.push([x.k[i] | 0, x.k[i + 1] | 0, x.k[i + 2] | 0]);
          roundLog[round] = l;
          rebuildMask(); buildTerrain();
        }
        return true;
      }
      function proceed() {
        if (aliveCount(0) === 0 || aliveCount(1) === 0 || round >= ROUNDS) beginEnd();
        else startRound(round + 1);
      }
      let endT = 0;
      function beginEnd() {
        ph = 'end'; endT = 0;
        const al = [aliveCount(0), aliveCount(1)];
        let winner = -1, ko = false;
        if (al[0] === 0 || al[1] === 0) { ko = true; if (al[0] !== al[1]) winner = al[0] === 0 ? 1 : 0; }
        else {
          const hp = [totalHp(0), totalHp(1)];
          if (hp[0] !== hp[1]) winner = hp[0] > hp[1] ? 0 : 1;
          else if (al[0] !== al[1]) winner = al[0] > al[1] ? 0 : 1;
        }
        if (winner >= 0) {
          st.score[winner] += 200;
          if (st.score[winner] <= st.score[1 - winner]) st.score[winner] = st.score[1 - winner] + 1;
        } else { const m = Math.max(st.score[0], st.score[1]); st.score = [m, m]; }
        banner(ko ? 'Clash won!' : 'Out of rounds', true);
        banner(winner < 0 ? 'Draw' : winner === mySide ? 'You win!' : names[winner] + ' wins', true);
        celebrate = { side: winner < 0 ? mySide : winner, t: 0 };
        shake = Math.max(shake, 0.4);
      }

      // ---------- planning (bot, auto): simulate candidate shots
      function dmgAt(x, y, w, t) {
        const { R, D } = WPN[w];
        let tot = 0;
        for (let i = 0; i < 3; i++) {
          const c = st.cr[t][i];
          if (c.hp <= 0) continue;
          const ex = c.x - x, ey = c.y - BODY - y, d = Math.sqrt(ex * ex + ey * ey);
          if (d < R + 6) tot += Math.min(c.hp, Math.max(1, Math.round(D * (1 - d / (R + 6)))));
        }
        return tot;
      }
      function evalShot(team, from, a, type) {
        const sh = mkShot(team, from, a, type);
        let ev = null;
        for (let k = 0; k < 2600 && !ev; k++) ev = stepShot(sh, wind);
        if (!ev || ev.k === 'off' || ev.k === 'water') return -8;
        const w = type === 2 ? 2 : type;
        let x = ev.k === 'ground' ? ev.hx : sh.x, y = ev.k === 'ground' ? ev.hy : sh.y;
        if (type === 1) { x = sh.x; y = sh.y; }
        const wd = type === 2 ? 3 : w;
        let e = dmgAt(x, y, wd, 1 - team) - 1.3 * dmgAt(x, y, wd, team);
        if (type === 2) e = e * 1.8;
        return e;
      }
      function chooseSetup(team, i, rnd, noise, walkP) {
        const c = st.cr[team][i];
        const tmp = { x: c.x, y: c.y };
        const sgn = team === 0 ? 1 : -1;
        let face = sgn;
        if (rnd() < walkP) {
          const dir = rnd() < 0.5 ? -1 : 1, dist = 8 + rnd() * 40;
          for (let d = 0; d < dist; d += 0.5) if (!walkMove(tmp, dir * 0.5, 2, 2)) break;
          face = dir;
        }
        tmp.x = r1(tmp.x);
        const gr = groundRow(tmp.x, tmp.y); if (gr !== null) tmp.y = gr;
        let best = null;
        const consider = (dx, dy, type) => {
          const e = evalShot(team, tmp, { dx, dy }, type);
          if (!best || e > best.e) best = { dx, dy, type, e };
        };
        const canCluster = st.ammo[team] > 0 && round >= 3;
        for (let k = 0; k < 70; k++) {
          const ang = (18 + rnd() * 62) * Math.PI / 180, len = 40 + rnd() * 100;
          const dx = Math.round(-sgn * Math.cos(ang) * len), dy = Math.round(Math.sin(ang) * len);
          consider(dx, dy, rnd() < 0.7 ? 0 : 1);
          if (canCluster && k % 5 === 0) consider(dx, dy, 2);
        }
        const b0 = best;
        for (let k = 0; k < 24; k++) consider(b0.dx + Math.round((rnd() * 2 - 1) * 6), b0.dy + Math.round((rnd() * 2 - 1) * 6), b0.type);
        let type = best.type;
        if (type === 2 && best.e < 60) type = 0;
        return {
          i, x: tmp.x, y: tmp.y,
          dx: best.dx + Math.round((rnd() * 2 - 1) * noise), dy: best.dy + Math.round((rnd() * 2 - 1) * noise),
          t: type, f: face,
        };
      }

      // ---------- aiming state
      let aim = defAim(mySide), atype = 0, locked = false, aimT = AIM_SECS;
      let myIdx = -1, myLast = -1, mv = { x: 0, y: 0 }, face = mySide === 0 ? 1 : -1, stam = STAMINA, hop = null;
      let held = null, btnDown = null, aimDrag = null, selTap = null, walkPh = 0;
      let lastSetup = null, prevSetup = null;
      let botSetup = null, botLockAt = 0, botT = 0, botLast = -1, botFrom = null;
      let oppVis = null;
      let syncT = 0;
      const setupArr = s => [s.dx, s.dy, s.t, s.i, s.x, s.y, s.f];
      function parseSetup(a, team) {
        if (!Array.isArray(a) || a.length < 7) return null;
        for (let k = 0; k < 7; k++) if (!fin(a[k])) return null;
        return { dx: Math.round(clamp(a[0], -300, 300)), dy: Math.round(clamp(a[1], -300, 300)), t: a[2] | 0, i: a[3] | 0, x: a[4], y: a[5], f: a[6] < 0 ? -1 : 1 };
      }
      function selectCritter(i) {
        const c = st.cr[mySide][i];
        if (!c || c.hp <= 0) return;
        myIdx = i; mv = { x: c.x, y: c.y }; stam = STAMINA; hop = null;
      }
      function finishHop() {
        if (!hop) return;
        let g = 0;
        while (hop && g++ < 3000) hopStep();
      }
      function hopStep() {
        const r = stepCritter(hop, true);
        if (hop.y > WATER - 8) { mv.x = hop.sx; mv.y = hop.sy; hop = null; return; }
        if (r === 1) { mv.x = hop.x; mv.y = hop.y; hop = null; } else { mv.x = hop.x; mv.y = hop.y; }
      }
      function lockAim() {
        if (locked) return;
        finishHop();
        const gr = groundRow(r1(mv.x), mv.y);
        mv.x = r1(mv.x); if (gr !== null) mv.y = gr;
        const hx = Math.sqrt(aim.dx * aim.dx + aim.dy * aim.dy) >= MIN_DRAG ? aim.dx : defAim(mySide).dx;
        lastSetup = { dx: aim.dx, dy: aim.dy, t: atype, i: myIdx, x: mv.x, y: mv.y, f: hx < 0 ? 1 : -1 };
        locked = true; aimDrag = null; btnDown = null; held = null; selTap = null;
      }
      function startRound(r) {
        round = r; ph = 'aim'; phT = 0; aimT = AIM_SECS; locked = false; vol = null;
        wind = windArr[r - 1];
        roundLog[r] = [];
        prevSetup = r > 1 ? lastSetup : null;
        myIdx = nextAlive(mySide, myLast); myLast = myIdx;
        selectCritter(myIdx);
        if (atype === 2 && st.ammo[mySide] <= 0) atype = 0;
        if (!(Math.sqrt(aim.dx * aim.dx + aim.dy * aim.dy) >= MIN_DRAG)) aim = defAim(mySide);
        face = aim.dx < 0 ? 1 : -1;
        oppVis = null; held = null; btnDown = null; aimDrag = null; selTap = null;
        if (!versus) {
          const i = nextAlive(oppSide, botLast); botLast = i;
          const c = st.cr[oppSide][i];
          botSetup = chooseSetup(oppSide, i, botRnd, BOT_NOISE, 0.5);
          botFrom = { x: c.x, y: c.y };
          botLockAt = 2 + botRnd() * 5; botT = 0;
        }
        if (auto) {
          const s = chooseSetup(mySide, myIdx, autoRnd, 3, 0.4);
          aim = { dx: s.dx, dy: s.dy }; atype = s.t; mv = { x: s.x, y: s.y }; face = s.f;
          lockAim();
        }
        banner(r === ROUNDS ? 'Final round' : 'Round ' + r);
      }
      function peerSetupFor(r) {
        if (!versus) return botT >= botLockAt ? botSetup : null;
        const g = api.peer();
        if (!g || typeof g !== 'object') return null;
        if (g.r === r && g.l === 1) { const s = parseSetup(g.a); if (s) return s; }
        if (g.r === r + 1) { const s = parseSetup(g.q); if (s) return s; }
        return null;
      }
      function peerReady(r) {
        if (!versus) return botT >= botLockAt;
        const g = api.peer();
        return !!(g && ((g.r === r && g.l === 1) || g.r > r));
      }

      // ---------- update
      function syncScore() {
        if (st.score[mySide] !== lastScore) { lastScore = st.score[mySide]; api.score(lastScore); }
      }
      function update(dt) {
        clock += dt; phT += dt;
        if (shake > 0) shake = Math.max(0, shake - dt);
        for (let i = banners.length - 1; i >= 0; i--) { banners[i].t += dt; if (banners[i].t > (banners[i].big ? 1.8 : 1.2)) banners.splice(i, 1); }
        for (let i = rings.length - 1; i >= 0; i--) { rings[i].t += dt; if (rings[i].t > 0.35) rings.splice(i, 1); }
        for (let i = trails.length - 1; i >= 0; i--) { trails[i].t += dt; if (trails[i].t > 0.4) trails.splice(i, 1); }
        for (let i = pops.length - 1; i >= 0; i--) { pops[i].t += dt; pops[i].y -= 18 * dt; if (pops[i].t > 1.1) pops.splice(i, 1); }
        for (let i = parts.length - 1; i >= 0; i--) {
          const p = parts[i];
          p.t += dt; p.vy += p.g * dt; p.x += p.vx * dt; p.y += p.vy * dt;
          if (p.t > p.life) parts.splice(i, 1);
        }
        for (let t = 0; t < 2; t++) for (let i = 0; i < 3; i++) {
          const c = st.cr[t][i];
          if (c.flash > 0) c.flash = Math.max(0, c.flash - dt);
          if (c.bob > 0) c.bob = Math.max(0, c.bob - dt * 4);
          c.vh += (c.hp - c.vh) * Math.min(1, dt * 6);
        }
        if (celebrate) {
          celebrate.t += dt;
          if (celebrate.t < 2.2 && Math.floor(celebrate.t * 8) !== Math.floor((celebrate.t - dt) * 8)) {
            const al = st.cr[celebrate.side].find(c => c.hp > 0);
            if (al) burst(al.x + (Math.random() - 0.5) * 30, al.y - 20, 8, ['#ffd84a', '#ff6fa8', '#6fd0ff', '#fff', '#8cf06a'], 220, 1.1, 260);
          }
        }

        if (ph === 'aim') updateAim(dt);
        else if (ph === 'fire') {
          if (stepVolley()) { vol = null; finalize(); ph = 'settle'; phT = 0; }
        } else if (ph === 'settle') {
          if (phT >= 0.5) {
            if (isHost) { if (versus) publishX(); proceed(); }
            else { ph = 'sync'; phT = 0; }
          }
        } else if (ph === 'sync') {
          const g = api.peer();
          if (g && g.X && g.X.r === round && applyX(g.X)) proceed();
          else if (phT > SYNC_TIMEOUT) proceed();
        } else if (ph === 'end') {
          endT += dt;
          if (endT >= 2.4 && !overCalled) { overCalled = true; ph = 'over'; api.over(); }
        }
        syncScore();
      }
      function updateOppVis(dt) {
        let tx = null, ty = null, ti = -1, tf = 1;
        if (!versus) {
          if (botSetup && botFrom) {
            const p = clamp(botT / Math.max(0.5, botLockAt * 0.8), 0, 1);
            tx = botFrom.x + (botSetup.x - botFrom.x) * p; ty = botFrom.y + (botSetup.y - botFrom.y) * p; ti = botSetup.i; tf = botSetup.f;
          }
        } else {
          const g = api.peer();
          if (g && g.r === round && Array.isArray(g.a) && g.a.length >= 7 && fin(g.a[4]) && fin(g.a[5]) && fin(g.a[3])) { tx = g.a[4]; ty = g.a[5]; ti = g.a[3] | 0; tf = g.a[6] < 0 ? -1 : 1; }
        }
        if (ti < 0 || ti > 2) return;
        if (!oppVis || oppVis.i !== ti) oppVis = { i: ti, x: tx, y: ty, f: tf };
        else {
          const k = Math.min(1, dt * 10);
          oppVis.x += (tx - oppVis.x) * k; oppVis.y += (ty - oppVis.y) * k; oppVis.f = tf;
        }
      }
      function updateAim(dt) {
        botT += dt;
        if (!locked) {
          aimT -= dt;
          if (aimT <= 0) { aimT = 0; lockAim(); }
        }
        updateOppVis(dt);
        if (!locked) {
          if (hop) hopStep();
          else if (held && stam > 0) {
            const dir = held === 'left' ? -1 : 1;
            const mvx = Math.min(stam, WALK_SPD * dt);
            const a = mvx, tmp = { x: mv.x, y: mv.y };
            if (walkMove(tmp, dir * a, Math.ceil(3 * a), Math.ceil(4 * a))) { mv.x = tmp.x; mv.y = tmp.y; stam -= a; walkPh += dt * 14; }
            face = dir;
          }
        }
        if (locked) {
          const pa = peerSetupFor(round);
          if (pa) {
            const sa = [null, null];
            sa[mySide] = lastSetup; sa[oppSide] = pa;
            for (let t = 0; t < 2; t++) { sa[t] = Object.assign({}, sa[t]); }
            startVolley(sa);
          }
        }
      }

      // ---------- input
      function hitBtn(x, y) {
        for (const k of BTN_KEYS) {
          const b = BTN[k];
          if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return k;
        }
        return null;
      }
      function pressBtn(k) {
        if (k === 'fire') { lockAim(); return; }
        if (k === 'jump') {
          if (hop || stam < HOP_COST) return;
          const f = face >= 0 ? 1 : -1;
          hop = { x: mv.x, y: mv.y, vx: f * 55, vy: -150, air: true, fy: mv.y, hp: 100, slid: 0, lastBy: -1, sx: mv.x, sy: mv.y };
          stam -= HOP_COST;
          return;
        }
        if (k[0] === 'w') {
          const t = BTN[k].t;
          if (t !== 2 || st.ammo[mySide] > 0) atype = t;
        }
      }
      function down(x, y) {
        if (ph !== 'aim' || locked) return;
        const b = hitBtn(x, y);
        if (b) {
          btnDown = b; aimDrag = null; selTap = null;
          if (b === 'left' || b === 'right') held = b;
          return;
        }
        btnDown = null; held = null;
        aimDrag = { sx: x, sy: y };
        selTap = null;
        for (let i = 0; i < 3; i++) {
          const c = st.cr[mySide][i];
          if (i !== myIdx && c.hp > 0 && Math.abs(x - c.x) < 16 && Math.abs(y - (c.y - 10)) < 18) { selTap = i; break; }
        }
      }
      function move(x, y) {
        if (ph !== 'aim' || locked || !aimDrag) return;
        let dx = x - aimDrag.sx, dy = y - aimDrag.sy;
        const len = Math.sqrt(dx * dx + dy * dy);
        if (len > 8) selTap = null;
        if (len < 8) return;
        if (len > MAX_DRAG) { dx = dx * MAX_DRAG / len; dy = dy * MAX_DRAG / len; }
        aim = { dx: Math.round(dx), dy: Math.round(dy) };
        face = aim.dx < 0 ? 1 : -1;
      }
      function up(x, y) {
        if (ph !== 'aim') return;
        held = null;
        if (locked) { btnDown = null; aimDrag = null; return; }
        if (btnDown) {
          const b = btnDown; btnDown = null;
          if (b !== 'left' && b !== 'right' && hitBtn(x, y) === b) pressBtn(b);
        } else if (selTap !== null) { selectCritter(selTap); }
        selTap = null; aimDrag = null;
      }

      // ---------- render
      function critterPos(c) {
        let x = c.x, y = c.y, f = c.face, mine = false;
        if (ph === 'aim') {
          if (c.team === mySide && c.i === myIdx) { x = mv.x; y = mv.y; f = face; mine = true; }
          else if (c.team === oppSide && oppVis && oppVis.i === c.i) { x = oppVis.x; y = oppVis.y; f = oppVis.f; }
        }
        return { x, y, f, mine };
      }
      function drawCritter(g, c) {
        const p = critterPos(c);
        let y = p.y;
        if (ph === 'aim' && !c.air) y -= Math.abs(Math.sin(clock * 2.4 + c.i * 2 + c.team)) * 0.8;
        if (p.mine && held && !locked) y -= Math.abs(Math.sin(walkPh)) * 2;
        if (c.bob > 0) y -= Math.sin(c.bob * 3.14) * 3;
        g.globalAlpha = c.flash > 0 && Math.floor(c.flash * 20) % 2 === 0 ? 0.45 : 1;
        api.draw(g, 'critter_' + color[c.team], p.x, y, { flipX: p.f < 0 });
        g.globalAlpha = 1;
        // hp bar + number
        const bw = 22, bx = p.x - bw / 2, by = y - 33;
        g.fillStyle = 'rgba(15,12,35,0.7)'; rrect(g, bx - 1, by - 1, bw + 2, 6, 3); g.fill();
        g.fillStyle = color[c.team] === 'pink' ? '#ff7ab8' : '#5aa2ff';
        const wv = Math.max(0, Math.min(bw, bw * c.vh / HP0));
        if (wv > 0) { rrect(g, bx, by, wv, 4, 2); g.fill(); }
        text(g, String(Math.max(0, Math.round(c.vh))), p.x, by - 6, 9, '#fff', 'center', 800);
        if (p.mine && !locked && ph === 'aim') {
          const ay = by - 16 + Math.sin(clock * 6) * 1.5;
          g.fillStyle = '#ffe27a'; g.beginPath(); g.moveTo(p.x - 4, ay - 4); g.lineTo(p.x + 4, ay - 4); g.lineTo(p.x, ay + 2); g.closePath(); g.fill();
        }
      }
      function render(g) {
        if (hasDom && (!terrCv || (!texBuilt && api.has('tex_soil') && api.has('tex_grass')))) {
          texBuilt = api.has('tex_soil') && api.has('tex_grass');
          buildTerrain();
        }
        g.save();
        if (shake > 0) g.translate((Math.random() - 0.5) * shake * 12, (Math.random() - 0.5) * shake * 12);
        g.fillStyle = '#8ed3f5'; g.fillRect(view.x0 - 30, view.y0 - 30, view.x1 - view.x0 + 60, 520 - view.y0 + 30);
        g.fillStyle = '#2f7fbf'; g.fillRect(view.x0 - 30, 520, view.x1 - view.x0 + 60, view.y1 - 520 + 30);
        api.draw(g, 'bg_island', 0, 0, { w: W, h: H, ax: 0, ay: 0 });
        if (terrCv) g.drawImage(terrCv, 0, 0, W, H);

        // critters (alive)
        for (let t = 0; t < 2; t++) for (let i = 0; i < 3; i++) { const c = st.cr[t][i]; if (c.hp > 0) drawCritter(g, c); }

        // water band
        const wy = WATER - 6;
        const wg = g.createLinearGradient(0, wy, 0, wy + 60);
        wg.addColorStop(0, 'rgba(90,190,245,0.55)'); wg.addColorStop(1, 'rgba(25,90,170,0.9)');
        g.fillStyle = wg; g.fillRect(view.x0 - 30, wy, view.x1 - view.x0 + 60, view.y1 - wy + 30);
        g.lineWidth = 1.6;
        for (let k = 0; k < 3; k++) {
          g.strokeStyle = 'rgba(255,255,255,' + (0.5 - k * 0.12).toFixed(2) + ')';
          g.beginPath();
          for (let x = -10; x <= W + 10; x += 6) {
            const y = wy + 2 + k * 7 + Math.sin(x * 0.07 + clock * (1.6 + k * 0.4) + k) * 2;
            if (x === -10) g.moveTo(x, y); else g.lineTo(x, y);
          }
          g.stroke();
        }

        // aim dots (first 0.3 s of the path)
        if (ph === 'aim' && !locked && Math.sqrt(aim.dx * aim.dx + aim.dy * aim.dy) >= MIN_DRAG) {
          const sh = mkShot(mySide, mv, aim, atype);
          const wa = atype === 1 ? 0 : wind * WIND_ACC;
          for (let i = 1; i <= 6; i++) {
            const t = i * 0.05;
            const x = sh.x + sh.vx * t + 0.5 * wa * t * t, y = sh.y + sh.vy * t + 0.5 * GRAV * t * t;
            g.beginPath(); g.arc(x, y, 2.8 - i * 0.2, 0, 6.283);
            g.fillStyle = 'rgba(255,255,255,' + (0.95 - i * 0.1).toFixed(2) + ')'; g.fill();
          }
        }

        // trails + shots
        for (const t of trails) {
          g.globalAlpha = Math.max(0, 0.6 * (1 - t.t / 0.4));
          g.fillStyle = '#fff'; g.beginPath(); g.arc(t.x, t.y, 1.7, 0, 6.283); g.fill();
        }
        g.globalAlpha = 1;
        if (vol) {
          for (const sh of vol.shots) {
            if (!sh.alive) continue;
            if (sh.type === 0) api.draw(g, 'shot_rocket', sh.x, sh.y, { rot: Math.atan2(sh.vy, sh.vx) });
            else if (sh.type === 1) {
              api.draw(g, 'shot_grenade', sh.x, sh.y, { rot: sh.spin * 9 });
              text(g, String(Math.max(0, Math.ceil(FUSE - sh.t))), sh.x, sh.y - 11, 11, '#fff', 'center', 800);
            } else if (sh.type === 2) api.draw(g, 'shot_cluster', sh.x, sh.y, { rot: sh.spin * 7 });
            else api.draw(g, 'shot_ball', sh.x, sh.y, { w: 7, h: 7 });
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
          g.fillStyle = p.c; g.fillRect(p.x - p.r / 2, p.y - p.r / 2, p.r, p.r);
        }
        g.globalAlpha = 1;
        for (const p of pops) {
          g.globalAlpha = Math.max(0, 1 - Math.max(0, p.t - 0.6) / 0.5);
          outlined(g, p.s, p.x, p.y, p.s === 'KO!' ? 18 : 13, p.col);
        }
        g.globalAlpha = 1;
        g.restore();
        renderHud(g);
      }

      function renderHud(g) {
        let big = '', small = '', status = '';
        small = 'Round ' + Math.max(1, round) + '/' + ROUNDS;
        if (ph === 'aim') {
          big = String(Math.ceil(aimT));
          if (locked) status = peerSetupFor(round) ? '' : 'Waiting for ' + nameOpp + '…';
          else status = nameOpp + ' is ' + (peerReady(round) ? 'ready' : 'aiming');
        } else if (ph === 'sync') status = 'Syncing…';
        g.font = '800 13px ' + FONT;
        const tw = g.measureText(small).width;
        g.fillStyle = 'rgba(20,10,50,0.55)'; rrect(g, 6, 101, tw + 14, 22, 11); g.fill();
        text(g, small, 13, 112, 13, '#fff', 'left', 800);
        // wind pill
        g.fillStyle = 'rgba(20,10,50,0.55)'; rrect(g, 262, 101, 92, 22, 11); g.fill();
        text(g, 'Wind', 270, 112, 12, '#fff', 'left', 800);
        {
          const cx = 326, cy = 112, len = 4 + Math.abs(wind) * 18, d = wind < 0 ? -1 : 1;
          g.strokeStyle = '#fff'; g.fillStyle = '#fff'; g.lineWidth = 2.5; g.lineCap = 'round';
          if (Math.abs(wind) < 0.05) { g.beginPath(); g.arc(cx, cy, 2.5, 0, 6.283); g.fill(); }
          else {
            g.beginPath(); g.moveTo(cx - d * len / 2, cy); g.lineTo(cx + d * len / 2, cy); g.stroke();
            g.beginPath(); g.moveTo(cx + d * len / 2 + d * 5, cy); g.lineTo(cx + d * len / 2 - d * 1, cy - 5); g.lineTo(cx + d * len / 2 - d * 1, cy + 5); g.closePath(); g.fill();
          }
          text(g, String(Math.round(Math.abs(wind) * 10)), 346, 112, 12, '#ffe27a', 'right', 800);
        }
        if (big) {
          const urgent = ph === 'aim' && !locked && aimT <= 5;
          g.font = '800 38px ' + FONT; g.textAlign = 'center'; g.textBaseline = 'middle';
          g.lineJoin = 'round'; g.lineWidth = 7; g.strokeStyle = 'rgba(20,10,50,0.85)';
          g.strokeText(big, 180, 140); g.fillStyle = urgent ? '#ff7a7a' : '#fff'; g.fillText(big, 180, 140);
        }
        if (status) text(g, status, 180, 170, 14, '#fff', 'center', 800);

        if (ph === 'aim' || ph === 'fire' || ph === 'settle' || ph === 'sync') {
          const canAct = ph === 'aim' && !locked;
          // stamina
          if (canAct) {
            g.fillStyle = 'rgba(15,12,35,0.6)'; rrect(g, 4, 568, 130, 6, 3); g.fill();
            g.fillStyle = '#8cf06a'; if (stam > 0) { rrect(g, 4, 568, 130 * clamp(stam / STAMINA, 0, 1), 6, 3); g.fill(); }
          }
          const btn = (k, sel, off) => {
            const b = BTN[k];
            g.fillStyle = sel ? 'rgba(255,226,122,0.95)' : 'rgba(25,20,55,0.78)';
            rrect(g, b.x, b.y, b.w, b.h, 11); g.fill();
            g.lineWidth = 2; g.strokeStyle = sel ? '#fff' : 'rgba(255,255,255,0.35)';
            rrect(g, b.x, b.y, b.w, b.h, 11); g.stroke();
            g.globalAlpha = off ? 0.35 : (canAct ? 1 : 0.55);
          };
          for (const k of ['left', 'right']) {
            const b = BTN[k]; btn(k, held === k, false);
            const cx = b.x + b.w / 2, cy = b.y + b.h / 2, d = k === 'left' ? -1 : 1;
            g.fillStyle = held === k ? '#2b2453' : '#fff';
            g.beginPath(); g.moveTo(cx + d * 9, cy); g.lineTo(cx - d * 7, cy - 11); g.lineTo(cx - d * 7, cy + 11); g.closePath(); g.fill();
            g.globalAlpha = 1;
          }
          {
            const b = BTN.jump; btn('jump', false, hop || stam < HOP_COST);
            const cx = b.x + b.w / 2, cy = b.y + 18;
            g.fillStyle = '#fff'; g.beginPath(); g.moveTo(cx, cy - 9); g.lineTo(cx + 10, cy + 5); g.lineTo(cx - 10, cy + 5); g.closePath(); g.fill();
            text(g, 'Jump', cx, b.y + 38, 11, '#fff', 'center', 800);
            g.globalAlpha = 1;
          }
          const wn = ['Rocket', 'Grenade', 'Cluster'];
          for (let t = 0; t < 3; t++) {
            const k = 'w' + t, b = BTN[k];
            const n = t === 2 ? st.ammo[mySide] : -1, sel = atype === t, off = t === 2 && n <= 0;
            btn(k, sel, off);
            const cx = b.x + b.w / 2;
            if (t === 0) api.draw(g, 'shot_rocket', cx, b.y + 15, { w: 22, h: 11 });
            else if (t === 1) api.draw(g, 'shot_grenade', cx, b.y + 15, { w: 15, h: 15 });
            else api.draw(g, 'shot_cluster', cx, b.y + 15, { w: 16, h: 16 });
            g.globalAlpha = 1;
            text(g, wn[t], cx, b.y + 31, 9, sel ? '#2b2453' : '#fff', 'center', 800);
            text(g, t === 2 ? 'x' + Math.max(0, n) : '∞', cx, b.y + 43, 10, sel ? '#2b2453' : '#ffe27a', 'center', 800);
          }
          {
            const f = BTN.fire;
            const pulse = canAct ? 0.5 + 0.5 * Math.sin(clock * 6) : 0;
            g.fillStyle = canAct ? 'rgb(' + (230 + 20 * pulse | 0) + ',70,70)' : 'rgba(25,20,55,0.78)';
            rrect(g, f.x, f.y, f.w, f.h, 14); g.fill();
            g.lineWidth = 2.5; g.strokeStyle = '#fff'; rrect(g, f.x, f.y, f.w, f.h, 14); g.stroke();
            text(g, canAct ? 'FIRE' : (ph === 'aim' ? 'Locked' : ''), f.x + f.w / 2, f.y + f.h / 2, canAct ? 26 : 16, '#fff', 'center', 800);
          }
          if (canAct && round === 1 && aimT > AIM_SECS - 5) text(g, 'Drag back to aim, then Fire', 180, 556, 12, 'rgba(255,255,255,0.95)', 'center', 800);
          if (aimDrag && canAct && Math.sqrt(aim.dx * aim.dx + aim.dy * aim.dy) >= 8) {
            g.strokeStyle = 'rgba(255,255,255,0.5)'; g.lineWidth = 3; g.setLineDash([6, 6]);
            g.beginPath(); g.moveTo(aimDrag.sx, aimDrag.sy); g.lineTo(aimDrag.sx + aim.dx, aimDrag.sy + aim.dy); g.stroke();
            g.setLineDash([]);
            g.beginPath(); g.arc(aimDrag.sx, aimDrag.sy, 7, 0, 6.283); g.fillStyle = 'rgba(255,255,255,0.7)'; g.fill();
            const pw = Math.min(1, Math.sqrt(aim.dx * aim.dx + aim.dy * aim.dy) / MAX_DRAG);
            g.fillStyle = 'rgba(15,12,35,0.6)'; rrect(g, 120, 548, 120, 8, 4); g.fill();
            g.fillStyle = '#ffd84a'; rrect(g, 120, 548, 120 * pw, 8, 4); g.fill();
          }
        }
        for (let i = 0; i < banners.length; i++) {
          const b = banners[i], life = b.big ? 1.8 : 1.2, p = b.t / life;
          const e = 1 - Math.pow(1 - Math.min(1, p * 2.5), 3);
          const sc = 0.6 + 0.5 * e + 0.1 * p;
          const al = p < 0.6 ? 1 : Math.max(0, 1 - (p - 0.6) / 0.4);
          g.save();
          g.translate(180, 250 - (banners.length - 1 - i) * 44); g.scale(sc, sc); g.globalAlpha = al;
          outlined(g, b.s, 0, 0, 34);
          g.restore();
        }
      }

      // ---------- ghost (kept well under ~350 bytes)
      function ghost() {
        if (round < 1) return { r: 0 };
        const o = { r: round, l: locked ? 1 : 0, a: [aim.dx, aim.dy, atype, myIdx, r1(mv.x), r1(mv.y), face] };
        if (isHost && prevSetup) o.q = setupArr(prevSetup);
        if (hostX) o.X = hostX;
        return o;
      }

      api.score(0);
      startRound(1);
      syncScore();

      return {
        update, render, down, up, move, ghost,
        _dbg() {
          let hsh = 0;
          for (let i = 0; i < mask.length; i++) if (mask[i]) hsh = (Math.imul(hsh, 31) + i) | 0;
          return {
            round, ph, mySide, overCalled, locked, wind, hash: hsh,
            cr: st.cr.map(a => a.map(c => [c.x, c.y, c.hp])), score: st.score.slice(), ammo: st.ammo.slice(),
            craters: roundLog.map(l => (l || []).map(c => c.join(',')).join(';')).join('|'),
            ghostLen: JSON.stringify(ghost()).length, myIdx, stam, atype, aim, mv, hop: !!hop,
            _st: st, _simTools: { evalShot, chooseSetup, mkShot, stepShot, solid },
          };
        },
      };
    },
  });
})();
