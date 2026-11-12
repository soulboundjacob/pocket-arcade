/* Critter Clash: two-player artillery skirmish. Each team has three round critters on a big carved island
 * (a 1280x600 map seen through a 640x360 landscape screen with a camera). Every round BOTH players move one
 * critter and aim at the same time, then all shots fly together and blasts carve the ground away.
 * Last team standing wins.
 *
 * Determinism: the volley (fixed 1/120 s steps; only + - * / sqrt, no trig, no Math.random) runs identically
 * on both phones from the same terrain mask, critter state and the two locked setups. A setup includes the
 * active critter's final position, so walking and hopping are never simulated on the other phone.
 * Terrain (hills, a plateau, caves, arches, floating islands, a water channel), wind, spawn spots and props
 * come from private streams seeded from api.rng at init (same call order on both phones; the terrain build
 * uses no trig either). The host (the name that sorts first, left team) puts the round's resulting state in
 * its ghost after every volley and the other phone adopts it (including the round's craters) before the next
 * round. The camera, props animation and particles are presentation only and never touch the sim.
 *
 * Score = damage dealt to the enemy + 100 per enemy critter knocked out + 200 for the win. Fall and drowning
 * damage is credited to whoever last blasted the critter. The winner is lifted to at least (other + 1). */
(function () {
  'use strict';

  const SW = 640, SH = 360, DT = 1 / 120;   // screen (the engine's logical size) and sim step
  const MW = 1280, MH = 600;                // map size in world units
  const WATER = 560;
  const X0 = 40, X1 = 1240;                 // land extent (void outside)
  const GRAV = 420, MAX_DRAG = 120, MIN_DRAG = 10;
  // launch speed = VMAX * (P0 + (1 - P0) * drag/MAX_DRAG): full drag at 45 degrees reaches ~900 units, half drag ~300
  const VMAX = 615, P0 = 0.15;
  const WIND_ACC = 60;
  const FUSE = 3.0, BOUNCE = 0.6;
  const ROUNDS = 15, AIM_SECS = 15, SYNC_TIMEOUT = 6;
  const HP0 = 100, FALL_FREE = 48;          // a fall of 1.5 critter heights is free; 2 heights costs 8 hp
  const WALK_SPD = 50, STAMINA = 90, HOP_COST = 22, HOP_VX = 70, HOP_VY = -170;
  const SLIDE_SLOPE = 1.5, SLIDE_SPD = 40, SLIDE_MAX = 16;
  const BODY = 14;                         // critter hit circle radius; center is 14 above the feet
  const RH = 8;                            // blast reach beyond the crater radius
  const TS = 1.5;                          // terrain canvas scale
  const SPR = 32;                          // critter sprite size
  // weapons: 0 rocket, 1 grenade, 2 cluster (splits into 5 = bomblets)
  const WPN = [
    { R: 30, D: 45, K: 330 },
    { R: 34, D: 50, K: 370 },
    { R: 30, D: 45, K: 330 },
    { R: 16, D: 22, K: 170 },
  ];
  const RPACK = { 30: 0, 34: 1, 16: 2 }, RUNPACK = [30, 34, 16, 30];
  const FAN = [[-80, -120], [-40, -145], [0, -155], [40, -145], [80, -120]];
  const FONT = 'ui-rounded, system-ui, sans-serif';
  const hasDom = typeof document !== 'undefined' && !!document.createElement;
  const PROP_H = { palm: 84, bush: 26, rock: 28, mushroom: 40, crate: 26 };
  const PROP_COL = {
    palm: ['#3f9a3a', '#6ccf55', '#8a5a2b'], bush: ['#3f9a3a', '#6ccf55', '#2f7a30'], rock: ['#9a9a9a', '#6e6e72', '#c4c4c8'],
    mushroom: ['#e9575d', '#fff', '#ffd27a'], crate: ['#b98445', '#8a5e2a', '#e7c07a'],
  };

  const BTN = {
    left: { x: 10, y: 302, w: 56, h: 46 },
    right: { x: 70, y: 302, w: 56, h: 46 },
    jump: { x: 130, y: 302, w: 60, h: 46 },
    w0: { x: 380, y: 304, w: 48, h: 44, t: 0 },
    w1: { x: 432, y: 304, w: 48, h: 44, t: 1 },
    w2: { x: 484, y: 304, w: 48, h: 44, t: 2 },
    fire: { x: 538, y: 298, w: 92, h: 52 },
    map: { x: 528, y: 88, w: 104, h: 24 },
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
  const defAim = team => (team === 0 ? { dx: -50, dy: 50 } : { dx: 50, dy: 50 });
  const sstep = t => t * t * (3 - 2 * t);

  Arcade.register({
    id: 'critters', name: 'Critter Clash', blurb: 'Three critters each. Aim together, blast the island.', peerSync: true,
    world: { w: 640, h: 360 }, landscape: true,
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
      const BOT_NOISE = 3;

      // private streams (same call order on both phones)
      const seed = () => (api.rng() * 4294967296) >>> 0;
      const terrRnd = mulberry32(seed()), windRnd = mulberry32(seed()), spawnRnd = mulberry32(seed());
      const botRnd = mulberry32(seed()), autoRnd = mulberry32(seed()), propRnd = mulberry32(seed());

      // ---------- terrain: a 2D mask built from a mirrored (with jitter) height profile + carved/added shapes
      const jit = a => (terrRnd() * 2 - 1) * a;
      const rr = (a, b) => a + terrRnd() * (b - a);
      const NCP = 24, CSP = (X1 - X0) / NCP;
      const CPH = new Array(NCP + 1).fill(400);
      {
        const L = new Array(13).fill(400);
        L[0] = 556; L[1] = 524 + jit(8); L[2] = 478 + jit(10); L[3] = 432 + jit(12);
        const ps = terrRnd() < 0.5 ? 5 : 6;           // the plateau starts at this control point
        L[4] = rr(365, 420);
        if (ps === 6) L[5] = rr(330, 400);
        L[ps] = rr(232, 275); L[ps + 1] = L[ps] + jit(10); L[ps + 2] = L[ps] + rr(-8, 14);
        L[ps + 3] = rr(340, 400); L[ps + 4] = rr(415, 460);
        for (let k = ps + 5; k <= 12; k++) L[k] = clamp(L[k - 1] + jit(35), 395, 455);
        L[12] = rr(385, 425);
        for (let k = 0; k <= 12; k++) CPH[k] = L[k];
        for (let k = 1; k <= 12; k++) CPH[NCP - k] = clamp(L[k] + jit(10), 200, 558);
        CPH[NCP] = clamp(L[0] + jit(4), 520, 558);
      }
      const NB1 = Math.floor(MW / 30) + 2, NB2 = Math.floor(MW / 90) + 2, BP1 = [], BP2 = [];
      for (let i = 0; i < NB1; i++) BP1.push(jit(2.5));
      for (let i = 0; i < NB2; i++) BP2.push(jit(5));
      function terrH(x) {
        const k = Math.min(NCP - 1, Math.max(0, Math.floor((x - X0) / CSP)));
        const t = clamp((x - X0 - CSP * k) / CSP, 0, 1);
        const b1 = Math.min(NB1 - 2, Math.max(0, Math.floor(x / 30))), t1 = clamp((x - 30 * b1) / 30, 0, 1);
        const b2 = Math.min(NB2 - 2, Math.max(0, Math.floor(x / 90))), t2 = clamp((x - 90 * b2) / 90, 0, 1);
        return CPH[k] + (CPH[k + 1] - CPH[k]) * sstep(t)
          + BP1[b1] + (BP1[b1 + 1] - BP1[b1]) * sstep(t1) + BP2[b2] + (BP2[b2 + 1] - BP2[b2]) * sstep(t2);
      }
      const mask = new Uint8Array(MW * MH);
      for (let x = 0; x < MW; x++) {
        const top = (x < X0 || x >= X1) ? MH : Math.ceil(terrH(x + 0.5));
        for (let y = Math.max(0, top); y < MH; y++) mask[y * MW + x] = 1;
      }
      // the narrow water channel splitting the land
      const chx = MW / 2 + jit(10), chw = 34 + terrRnd() * 8;
      {
        const wob = []; for (let i = 0; i < MH / 25 + 2; i++) wob.push(jit(3));
        for (let y = 0; y < MH; y++) {
          const wi = Math.floor(y / 25), wt = (y - 25 * wi) / 25, off = wob[wi] + (wob[wi + 1] - wob[wi]) * wt;
          for (let x = Math.floor(chx - chw + off); x <= Math.ceil(chx + chw + off); x++) if (x >= 0 && x < MW) mask[y * MW + x] = 0;
        }
      }
      // floating islands (flat-ish top, lumpy underside)
      const islands = [];
      function addIsland(cx, cy, rx, th) {
        const n = []; for (let i = 0; i < 8; i++) n.push(terrRnd());
        for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
          const t = (x - cx) / rx; if (t <= -1 || t >= 1 || x < 0 || x >= MW) continue;
          const r = Math.sqrt(1 - t * t);
          const u = (t + 1) * 3.5, ui = Math.floor(u), uf = u - ui;
          const nz = n[ui] + (n[Math.min(7, ui + 1)] - n[ui]) * sstep(uf);
          const top = Math.ceil(cy - 7 * r), bot = Math.floor(cy + r * (th * 0.55 + th * 0.55 * nz));
          for (let y = Math.max(0, top); y <= Math.min(MH - 1, bot); y++) mask[y * MW + x] = 1;
        }
        islands.push([cx, cy, rx]);
      }
      {
        const lowTop = (a, b) => { let m = 9999; for (let x = a; x <= b; x += 10) m = Math.min(m, terrH(x)); return m; };
        if (terrRnd() < 0.5) {
          const rx = 58 + terrRnd() * 16;
          addIsland(Math.round(chx + jit(12)), Math.round(215 + terrRnd() * 45), Math.round(rx), 40);
        } else {
          const lx = 525 + terrRnd() * 55, rx = 48 + terrRnd() * 14;
          const rxx = MW - lx + jit(14);
          const cyl = clamp(Math.min(270, lowTop(lx - rx, lx + rx) - 80 - terrRnd() * 20), 70, 290);
          const cyr = clamp(Math.min(270, lowTop(rxx - rx, rxx + rx) - 80 - terrRnd() * 20), 70, 290);
          addIsland(Math.round(lx), Math.round(cyl), Math.round(rx), 40);
          addIsland(Math.round(rxx), Math.round(cyr), Math.round(rx + jit(5)), 40);
        }
      }
      const preMask = hasDom ? mask.slice() : null;
      // caves, arches and overhangs
      const feats = [];
      const featXs = [];
      function carveEll(cx, cy, rx, ry) {
        for (let y = Math.max(0, Math.floor(cy - ry)); y <= Math.min(MH - 1, Math.ceil(cy + ry)); y++) {
          const dy = (y + 0.5 - cy) / ry;
          for (let x = Math.max(0, Math.floor(cx - rx)); x <= Math.min(MW - 1, Math.ceil(cx + rx)); x++) {
            const dx = (x + 0.5 - cx) / rx;
            if (dx * dx + dy * dy <= 1) mask[y * MW + x] = 0;
          }
        }
      }
      function addFeat(k, e) {
        for (const q of e) carveEll(q[0], q[1], q[2], q[3]);
        feats.push({ k, e });
        for (const q of e) featXs.push(q[0]);
      }
      const farFromFeats = x => featXs.every(f => Math.abs(f - x) > 80);
      function caveAt(xs) {
        const dir = terrH(xs + 70) < terrH(xs - 70) ? 1 : -1;
        if (Math.abs(terrH(xs + 70) - terrH(xs - 70)) < 30) return null;
        const ry = 19, rx = 27, step = 24, n = 5, pts = [];
        let cy = terrH(xs) + 8;
        for (let k = 0; k < n; k++) {
          const cx = xs + dir * k * step;
          if (k > 0) cy = Math.max(cy, terrH(cx) + ry + 15);
          if (cx < X0 + 50 || cx > X1 - 50 || Math.abs(cx - chx) < chw + 80 || cy + ry > WATER - 40) return null;
          pts.push([cx, cy, rx, ry]);
        }
        return pts;
      }
      function tryCave(xc, side) {   // side 0 = left half, 1 = right half
        for (let a = 0; a < 80; a++) {
          const xo = a < 12 ? xc + (a ? jit(40) : 0) : 100 + terrRnd() * 460;
          const xs = side === 0 ? xo : MW - xo + (a < 12 ? jit(10) : 0);
          if (xs < 100 || xs > MW - 100 || !farFromFeats(xs)) continue;
          const p = caveAt(xs);
          if (p) { addFeat('cave', p); return true; }
        }
        return false;
      }
      function archAt(xp) {
        const ry = 17, rx = 26;
        const Y = terrH(xp) + ry + 15;
        if (Y + ry > WATER - 30) return null;
        let L1 = -1, L2 = -1;
        for (let L = 30; L <= 150; L += 6) { if (L1 < 0 && terrH(xp - L) >= Y) L1 = L; if (L2 < 0 && terrH(xp + L) >= Y) L2 = L; }
        if (L1 < 0 || L2 < 0 || L1 + L2 < 70 || L1 + L2 > 240) return null;
        const pts = [];
        for (let x = xp - L1; x <= xp + L2; x += 22) pts.push([x, Y, rx, ry]);
        if (Math.abs(xp - chx) < 150) return null;
        return pts;
      }
      function tryArch(side) {
        const a0 = side === 0 ? 130 : MW - 560, a1 = side === 0 ? 560 : MW - 130;
        const ok = [];
        for (let xp = a0; xp <= a1; xp += 6) if (farFromFeats(xp)) { const p = archAt(xp); if (p) ok.push(p); }
        if (!ok.length) return false;
        addFeat('arch', ok[Math.floor(terrRnd() * ok.length)]);
        return true;
      }
      function tryOver(side) {
        // steepest face in this half
        let bx = -1, bs = 1.1;
        const a0 = side === 0 ? 200 : MW - 580, a1 = side === 0 ? 580 : MW - 200;
        for (let x = a0; x <= a1; x += 4) {
          const s = Math.abs(terrH(x + 4) - terrH(x - 4)) / 8;
          if (s > bs && farFromFeats(x) && Math.abs(x - chx) > chw + 120) { bs = s; bx = x; }
        }
        if (bx < 0) return false;
        const up = terrH(bx + 4) < terrH(bx - 4) ? 1 : -1;   // the wall rises toward +x (1) or -x (-1)
        const yw = terrH(bx);
        addFeat('over', [[bx + up * 8, yw + 16, 34, 20], [bx + up * 34, yw + 14, 28, 18]]);
        return true;
      }
      {
        const cavesLeft = 100 + terrRnd() * 400;
        tryArch(0); tryArch(1);
        tryCave(cavesLeft, 0); tryCave(cavesLeft, 1);
        if (terrRnd() < 0.4) { if (!tryCave(120 + terrRnd() * 480, terrRnd() < 0.5 ? 0 : 1)) tryCave(300, 0); }
        { const sd = terrRnd() < 0.5 ? 0 : 1; if (!tryOver(sd)) tryOver(1 - sd); }
      }
      const baseMask = mask.slice();
      const featCount = k => feats.filter(f => f.k === k).length;

      function solid(x, y) {
        const xi = Math.floor(x), yi = Math.floor(y);
        if (xi < 0 || xi >= MW || yi < 0) return false;
        if (yi >= MH) return true;
        return mask[yi * MW + xi] === 1;
      }
      function carveMask(cx, cy, R) {
        const R2 = R * R;
        for (let y = Math.max(0, cy - R); y <= Math.min(MH - 1, cy + R); y++) {
          const dy = y + 0.5 - cy;
          for (let x = Math.max(0, cx - R); x <= Math.min(MW - 1, cx + R); x++) {
            const dx = x + 0.5 - cx;
            if (dx * dx + dy * dy <= R2) mask[y * MW + x] = 0;
          }
        }
      }
      function scanDown(x, y0, y1) {
        if (x < 0 || x >= MW) return -1;
        for (let y = Math.max(0, y0); y <= Math.min(MH - 1, y1); y++) if (mask[y * MW + x]) return y;
        return -1;
      }
      const nearFeat = (x, y, pad) => {
        for (const f of feats) for (const e of f.e) {
          const dx = (x - e[0]) / (e[2] + pad), dy = (y - e[1]) / (e[3] + pad);
          if (dx * dx + dy * dy < 1) return true;
        }
        return false;
      };

      // ---------- spawn spots: flat, with headroom, on the main land, away from features and each other
      const placed = [];
      function validSpot(x, relax) {
        x = Math.round(x);
        if (x < X0 + 25 || x > X1 - 25 || Math.abs(x - chx) < chw + 45) return null;
        const th = Math.floor(terrH(x));
        const ys = scanDown(x, th - 30, th + 40);
        if (ys < 0 || ys > WATER - 10) return null;
        for (let dy = 1; dy <= 34; dy++) for (const ox of [-6, 0, 6]) if ((ox === 0 || dy > 9) && mask[(ys - dy) * MW + x + ox]) return null;
        const yl = scanDown(x - 8, ys - 30, ys + 30), yr = scanDown(x + 8, ys - 30, ys + 30);
        if (yl < 0 || yr < 0 || Math.abs(yr - yl) / 16 > (relax ? 1.0 : 0.7)) return null;
        if (nearFeat(x, ys - 14, 30)) return null;
        for (const p of placed) { const dx = p.x - x, dy = p.y - ys; if (dx * dx + dy * dy < 3600) return null; }
        return { x, y: ys };
      }
      function findSpot(target, lo, hi) {
        for (const relax of [false, true]) {
          for (let off = 0; off <= 160; off += 5) for (const sg of off ? [-1, 1] : [1]) {
            const x = target + sg * off;
            if (x < lo || x > hi) continue;
            const s = validSpot(x, relax); if (s) return s;
          }
        }
        for (let x = lo; x <= hi; x += 3) { const s = validSpot(x, true); if (s) return s; }
        const x = Math.round(clamp(target, X0 + 30, X1 - 30));
        return { x, y: Math.max(0, scanDown(x, Math.floor(terrH(x)) - 30, MH - 1)) };
      }
      const st = { cr: [[], []], ammo: [1, 1], score: [0, 0] };
      const spawn = [[], []];
      {
        const bins = [[110, 270], [300, 470], [480, 590]];
        for (let i = 0; i < 3; i++) {
          const tgt = bins[i][0] + spawnRnd() * (bins[i][1] - bins[i][0]);
          const sl = findSpot(tgt, bins[i][0] - 30, bins[i][1] + 30); placed.push(sl);
          const jr = (spawnRnd() * 2 - 1) * 14;
          const sr = findSpot(MW - tgt + jr, MW - bins[i][1] - 30, MW - bins[i][0] + 30); placed.push(sr);
          spawn[0].push(sl); spawn[1].push(sr);
        }
      }
      for (let t = 0; t < 2; t++) {
        for (let i = 0; i < 3; i++) {
          const x = spawn[t][i].x, y = spawn[t][i].y;
          st.cr[t].push({ team: t, i, x, y, hp: HP0, vx: 0, vy: 0, air: false, fy: y, slid: 0, lastBy: -1, face: t === 0 ? 1 : -1, vh: HP0, flash: 0, bob: 0, sq: 0, lean: 0 });
        }
      }
      const windArr = [];
      for (let i = 0; i < ROUNDS + 1; i++) windArr.push(Math.round((windRnd() * 2 - 1) * 10) / 10);

      // ---------- props (decor that reacts): st 0 standing, 1 tumbling, 2 gone
      const props = [];
      {
        const want = 10 + Math.floor(propRnd() * 7);
        const spots = placed.slice();
        const okProp = (x, y, h) => {
          for (const p of spots) { const dx = p.x - x; if (Math.abs(dx) < 40 && Math.abs(p.y - y) < 60) return false; }
          for (const p of props) if (Math.abs(p.x - x) < 45 && Math.abs(p.y - y) < 40) return false;
          if (nearFeat(x, y - 10, 12)) return false;
          return true;
        };
        for (let tries = 0; tries < 500 && props.length < want; tries++) {
          const x = Math.round(X0 + 30 + propRnd() * (X1 - X0 - 60));
          const q = propRnd();
          const kind = q < 0.28 ? 'palm' : q < 0.56 ? 'bush' : q < 0.76 ? 'rock' : q < 0.9 ? 'mushroom' : 'crate';
          if (Math.abs(x - chx) < chw + 25) continue;
          const th = Math.floor(terrH(x)), ys = scanDown(x, th - 30, th + 40);
          if (ys < 0 || ys > WATER - 8) continue;
          let free = true;
          for (let dy = 1; dy <= (kind === 'palm' ? 50 : 20) && free; dy++) if (mask[(ys - dy) * MW + x]) free = false;
          if (!free) continue;
          const yl = scanDown(x - 10, ys - 30, ys + 30), yr = scanDown(x + 10, ys - 30, ys + 30);
          if (yl < 0 || yr < 0 || Math.abs(yr - yl) / 20 > 0.8) continue;
          if (!okProp(x, ys, PROP_H[kind])) continue;
          props.push({ k: kind, x, y: ys, h: PROP_H[kind], st: 0, vx: 0, vy: 0, rot: 0, vr: 0, t: 0 });
        }
        for (const is of islands) {
          if (propRnd() < 0.7) {
            const x = Math.round(is[0] + (propRnd() * 2 - 1) * is[2] * 0.4);
            const ys = scanDown(x, Math.floor(is[1]) - 40, Math.floor(is[1]) + 30);
            if (ys >= 0) props.push({ k: propRnd() < 0.5 ? 'crate' : 'bush', x, y: ys, h: 26, st: 0, vx: 0, vy: 0, rot: 0, vr: 0, t: 0 });
          }
        }
      }
      const propSupported = p => solid(p.x, p.y + 1.5) || solid(p.x - 5, p.y + 1.5) || solid(p.x + 5, p.y + 1.5);

      const roundLog = [];
      let round = 0, wind = 0;
      let ph = 'aim', phT = 0, clock = 0;
      let lastScore = -1, overCalled = false;

      // ---------- fx (cosmetic only)
      const parts = [], rings = [], pops = [], banners = [], trails = [], blasts = [];
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

      // props reacting to a blast (cosmetic; their state is re-derived from the mask after a host adoption)
      function propsReact(cx, cy, R) {
        for (const p of props) {
          if (p.st !== 0) continue;
          const dx = p.x - cx, dy = (p.y - p.h / 2) - cy;
          if (dx * dx + dy * dy < (R + 8) * (R + 8)) {
            p.st = 2; burst(p.x, p.y - p.h / 2, 12, PROP_COL[p.k], 150, 0.7, 380);
          } else if (!propSupported(p)) {
            p.st = 1; p.vx = (Math.random() * 2 - 1) * 30; p.vy = -30; p.vr = (Math.random() * 2 - 1) * 4; p.rot = 0; p.t = 0;
          }
        }
      }
      function syncProps() { for (const p of props) if (p.st !== 2 && !propSupported(p)) p.st = 2; }

      // ---------- terrain canvas
      let terrCv = null, tg = null, maskCv = null, backCv = null, texBuilt = false;
      function alphaCanvas(m) {
        const cv = document.createElement('canvas'); cv.width = MW; cv.height = MH;
        const cg = cv.getContext('2d'), img = cg.createImageData(MW, MH), d = img.data;
        for (let i = 0; i < m.length; i++) if (m[i]) d[(i << 2) + 3] = 255;
        cg.putImageData(img, 0, 0);
        return cv;
      }
      function buildBack() {
        backCv = document.createElement('canvas'); backCv.width = MW; backCv.height = MH;
        const b = backCv.getContext('2d');
        b.fillStyle = '#3a2412';
        for (const f of feats) for (const e of f.e) { b.beginPath(); b.ellipse(e[0], e[1], e[2] + 1, e[3] + 1, 0, 0, 6.2832); b.fill(); }
        b.globalCompositeOperation = 'destination-in';
        const pc = alphaCanvas(preMask);
        b.drawImage(pc, 0, 0);
      }
      function buildTerrain() {
        if (!hasDom) return;
        if (!terrCv) {
          terrCv = document.createElement('canvas'); terrCv.width = Math.round(MW * TS); terrCv.height = Math.round(MH * TS); tg = terrCv.getContext('2d');
          maskCv = alphaCanvas(baseMask);
          buildBack();
        }
        const g = tg;
        g.setTransform(TS, 0, 0, TS, 0, 0); g.globalCompositeOperation = 'source-over'; g.globalAlpha = 1;
        g.clearRect(0, 0, MW, MH);
        if (api.has('tex_soil')) {
          for (let ty = 0; ty < MH; ty += 64) for (let tx = 0; tx < MW; tx += 64) api.draw(g, 'tex_soil', tx, ty, { w: 64, h: 64, ax: 0, ay: 0 });
        } else { g.fillStyle = '#7a5230'; g.fillRect(0, 0, MW, MH); }
        const gr = g.createLinearGradient(0, 180, 0, MH);
        gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(1, 'rgba(30,12,0,0.42)');
        g.fillStyle = gr; g.fillRect(0, 180, MW, MH - 180);
        if (api.has('tex_grass')) {
          for (let xs = 0; xs < MW; xs += 4) {
            // every surface with open sky-ish room above it (>= 50 units of air) gets grass
            let air = 50, y = 0;
            while (y < MH) {
              if (baseMask[y * MW + xs + 2]) {
                if (air >= 50) {
                  g.save(); g.beginPath(); g.rect(xs, y - 6, 4, 22); g.clip();
                  api.draw(g, 'tex_grass', Math.floor(xs / 64) * 64, y - 4, { w: 64, h: 12, ax: 0, ay: 0 });
                  g.restore();
                }
                air = 0;
                while (y < MH && baseMask[y * MW + xs + 2]) y++;
              } else { air++; y++; }
            }
          }
        }
        // keep only the solid part of the map
        g.globalCompositeOperation = 'destination-in';
        g.imageSmoothingEnabled = true;
        g.drawImage(maskCv, 0, 0, MW, MH);
        // dark rims around the cave walls
        g.globalCompositeOperation = 'source-atop';
        g.lineWidth = 3; g.strokeStyle = 'rgba(40,18,4,0.45)';
        for (const f of feats) for (const e of f.e) { g.beginPath(); g.ellipse(e[0], e[1], e[2] + 0.5, e[3] + 0.5, 0, 0, 6.2832); g.stroke(); }
        g.globalCompositeOperation = 'source-over';
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
        const cx = clamp(Math.round(x), 0, MW - 1), cy = clamp(Math.round(y), 0, 1023);
        carveMask(cx, cy, R);
        if (!roundLog[round]) roundLog[round] = [];
        roundLog[round].push([cx, cy, R]);
        cutCanvas(cx, cy, R);
        burst(cx, cy, R >= 30 ? 14 : 8, ['#6b4a2b', '#8a6238', '#4f8a3a', '#a07a48'], 150 + R * 3, 0.8, 420);
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
        for (let yy = y0 - 8; yy <= y0 + 10; yy++) if (solid(x, yy) && !solid(x, yy - 1)) return yy;
        return null;
      }
      function surfAt(x, yc) {
        const y0 = Math.floor(yc);
        for (let yy = y0 - 14; yy <= y0 + 14; yy++) if (solid(x, yy)) return yy;
        return y0 + 15;
      }
      // moves a standing thing along the ground by dx (no fall); false when blocked
      function walkMove(c, dx, cl, dn) {
        const nx = c.x + dx;
        if (nx < X0 + 2 || nx > X1 - 2) return false;
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
        pop(c.x, c.y - 54, '-' + lost, '#ffb4b4');
        if (c.hp <= 0) {
          c.hp = 0;
          pop(c.x, c.y - 74, 'KO!', '#ffe27a');
          burst(c.x, c.y - BODY, 22, ['#fff', '#ffd84a', color[c.team] === 'pink' ? '#ff7ab8' : '#6aa8ff'], 200, 0.8, 300);
          shake = Math.max(shake, 0.3);
        }
      }
      function drown(c) {
        if (c.hp <= 0) return;
        pop(c.x, WATER - 24, 'Splash!', '#bfe6ff');
        burst(c.x, WATER, 14, ['#fff', '#9fd8ff', '#5fb0f0'], 140, 0.7, 380);
        hurt(c, c.hp, c.lastBy);
      }

      // ---------- critter physics
      function land(c, noDmg) {
        c.air = false; c.vx = 0; c.vy = 0; c.sq = 0.24;
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
          if (nx < 3) { nx = 3; c.vx = Math.abs(c.vx) * 0.3; } else if (nx > MW - 3) { nx = MW - 3; c.vx = -Math.abs(c.vx) * 0.3; }
          if (c.vx !== 0 && solid(nx + (c.vx > 0 ? 7 : -7), c.y - 8)) { c.vx = -c.vx * 0.3; nx = c.x; }
          if (c.vy < 0 && solid(nx, ny - 26)) { c.vy = 0; ny = c.y; }
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
        if (solid(c.x, c.y - 1)) { let u = 0; while (u < 14 && solid(c.x, c.y - 1)) { c.y--; u++; } }
        if (!solid(c.x, c.y + 0.5)) {
          let k = 1;
          while (k <= 4 && !solid(c.x, c.y + k + 0.5)) k++;
          if (k <= 4) c.y += k;
          else { c.air = true; c.fy = c.y; c.vy = 0; c.vx = 0; return 3; }
        }
        if (!noDmg && c.slid < SLIDE_MAX) {
          const hl = surfAt(c.x - 5, c.y), hr = surfAt(c.x + 5, c.y);
          const sl = (hr - hl) / 10;
          if (sl > SLIDE_SLOPE || sl < -SLIDE_SLOPE) {
            const dx = (sl > 0 ? 1 : -1) * SLIDE_SPD * DT;
            if (walkMove(c, dx, 2, 4)) { c.slid += SLIDE_SPD * DT; return 2; }
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
        const sp = VMAX * (P0 + (1 - P0) * len / MAX_DRAG);
        return { team, type, x: from.x + ux * 19, y: from.y - BODY + uy * 19, vx: ux * sp, vy: uy * sp, t: 0, alive: true, rest: false, n: 0, grace: 0, spin: 0 };
      }
      function surfNormal(x, y) {
        let nx = 0, ny = 0;
        for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) if (!solid(x + dx, y + dy)) { nx += dx; ny += dy; }
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
          if (x < -20 || x > MW + 20 || sh.t > 16) { sh.x = x; sh.y = y; return { k: 'off' }; }
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
        const Rh = R + RH;
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
        blasts.push({ x, y, t: 0 });
        propsReact(x, y, R);
        burst(x, y, R >= 30 ? 26 : 12, ['#fff', '#ffd27a', '#ff8a3d', '#ff5a3d', '#555'], 110 + R * 4, 0.6);
        shake = Math.max(shake, R >= 34 ? 0.4 : R >= 30 ? 0.32 : 0.14);
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
          if (sp < 36) { sh.vx = 0; sh.vy = 0; sh.rest = true; }
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
          rings.push({ x: sh.x, y: sh.y, R: 13, t: 0 });
          shake = Math.max(shake, 0.12);
          return;
        }
        explode(hx, hy, sh.type, sh.team);
      }
      function startVolley(sa) {
        // sa: setups by team
        vol = { t: 0, shots: [], quiet: 0, idx: [0, 0] };
        for (let t = 0; t < 2; t++) {
          const s = sa[t];
          let i = s.i;
          if (!(i >= 0 && i < 3) || st.cr[t][i].hp <= 0) i = nextAlive(t, -1);
          const c = st.cr[t][i];
          c.x = clamp(s.x, X0, X1); c.y = s.y; c.face = s.f;
          s.i = i; vol.idx[t] = i;
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
          c.vx = 0; c.vy = 0; c.slid = 0; c.lastBy = -1;
          if (c.hp <= 0) { c.x = Math.round(clamp(c.x, 0, MW - 1)); c.y = Math.round(clamp(c.y, 0, 1023)); continue; }
          c.x = Math.round(clamp(c.x, 0, MW - 1));
          const gr = groundRow(c.x, c.y);
          c.y = Math.round(clamp(gr !== null ? gr : c.y, 0, 1023));
          c.air = !solid(c.x, c.y + 0.5);
          c.fy = c.y;
        }
      }

      // ---------- host state exchange (packed small: positions x*1024+y, craters (x*1024+y)*4+radius index)
      let hostX = null;
      const packLog = r => { const o = []; if (roundLog[r]) for (const c of roundLog[r]) o.push((c[0] * 1024 + c[1]) * 4 + (RPACK[c[2]] != null ? RPACK[c[2]] : 3)); return o; };
      function publishX() {
        const c = [];
        for (let t = 0; t < 2; t++) for (let i = 0; i < 3; i++) { const k = st.cr[t][i]; c.push(k.x * 1024 + k.y); }
        for (let t = 0; t < 2; t++) for (let i = 0; i < 3; i++) c.push(st.cr[t][i].hp);
        hostX = { r: round, c, m: [st.ammo[0], st.ammo[1]], s: [st.score[0], st.score[1]], k: packLog(round) };
      }
      function applyX(x) {
        if (!x || !Array.isArray(x.c) || x.c.length !== 12 || !Array.isArray(x.m) || !Array.isArray(x.s) || !Array.isArray(x.k)) return false;
        for (const v of x.c) if (!fin(v)) return false;
        for (const v of x.k) if (!fin(v)) return false;
        for (let t = 0; t < 2; t++) for (let i = 0; i < 3; i++) {
          const c = st.cr[t][i], b = t * 3 + i, p = x.c[b] | 0;
          c.x = p >> 10; c.y = p & 1023; c.hp = Math.max(0, x.c[6 + b] | 0);
          c.vx = 0; c.vy = 0; c.slid = 0; c.air = c.hp > 0 && !solid(c.x, c.y + 0.5); c.fy = c.y;
        }
        st.ammo = [x.m[0] | 0, x.m[1] | 0];
        st.score = [x.s[0] | 0, x.s[1] | 0];
        if (JSON.stringify(packLog(round)) !== JSON.stringify(x.k)) {
          const l = [];
          for (const v of x.k) { const p = v | 0; l.push([(p >> 12) & 2047, (p >> 2) & 1023, RUNPACK[p & 3]]); }
          roundLog[round] = l;
          rebuildMask(); buildTerrain(); syncProps();
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
          if (d < R + RH) tot += Math.min(c.hp, Math.max(1, Math.round(D * (1 - d / (R + RH)))));
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
          const dir = rnd() < 0.5 ? -1 : 1, dist = 10 + rnd() * 60;
          for (let d = 0; d < dist; d += 0.5) if (!walkMove(tmp, dir * 0.5, 2, 2)) break;
          face = dir;
        }
        tmp.x = r1(tmp.x);
        const gr = groundRow(tmp.x, tmp.y); if (gr !== null) tmp.y = gr;
        const foes = st.cr[1 - team].filter(k => k.hp > 0);
        let best = null;
        const consider = (dx, dy, type) => {
          const e = evalShot(team, tmp, { dx, dy }, type);
          if (!best || e > best.e) best = { dx, dy, type, e };
        };
        const canCluster = st.ammo[team] > 0 && round >= 3;
        for (let k = 0; k < 90; k++) {
          let ang, len, sd = -sgn;
          if (foes.length && rnd() < 0.75) {
            // aim analytically at a random foe (flat-ground range), the sim picks the winner
            const f = foes[(rnd() * foes.length) | 0];
            sd = f.x > tmp.x ? 1 : -1;
            ang = (22 + rnd() * 55) * Math.PI / 180;
            const D = Math.abs(f.x - tmp.x) * (0.9 + rnd() * 0.2);
            const v = Math.sqrt(D * GRAV / Math.max(0.2, Math.sin(2 * ang)));
            len = clamp(MAX_DRAG * (v / VMAX - P0) / (1 - P0), 22, MAX_DRAG);
            sd = -sd;
          } else {
            ang = (18 + rnd() * 62) * Math.PI / 180; len = 22 + rnd() * 98;
          }
          const dx = Math.round(sd * Math.cos(ang) * len), dy = Math.round(Math.sin(ang) * len);
          consider(dx, dy, rnd() < 0.7 ? 0 : 1);
          if (canCluster && k % 5 === 0) consider(dx, dy, 2);
        }
        for (const spread of [6, 2]) {
          const b0 = best;
          for (let k = 0; k < 24; k++) consider(b0.dx + Math.round((rnd() * 2 - 1) * spread), b0.dy + Math.round((rnd() * 2 - 1) * spread), b0.type);
        }
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
      let held = null, btnDown = null, aimDrag = null, selTap = null, walkPh = 0, mySq = 0;
      let lastSetup = null, prevSetup = null;
      let botSetup = null, botLockAt = 0, botT = 0, botLast = -1, botFrom = null;
      let oppVis = null;
      let overview = false;
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
        if (hop.y > WATER - 10) { mv.x = hop.sx; mv.y = hop.sy; hop = null; return; }
        if (r === 1) { mv.x = hop.x; mv.y = hop.y; hop = null; mySq = 0.24; } else { mv.x = hop.x; mv.y = hop.y; }
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
        overview = false;
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

      // ---------- camera (presentation only)
      const cam = { cx: MW / 2, cy: 300, s: 0.5, init: false };
      const camMin = () => Math.min(1, Math.max(0.5, (view.x1 - view.x0) / MW));
      function clampCam() {
        cam.s = clamp(cam.s, camMin(), 1);
        const s = cam.s;
        const a = (SW / 2 - view.x0) / s, b = (view.x1 - SW / 2) / s;
        cam.cx = (MW - b < a) ? (MW + a - b) / 2 : clamp(cam.cx, a, MW - b);
        const ya = (SH / 2 - view.y0) / s, yb = (view.y1 - SH / 2) / s;
        const lo = -140 + ya, hi = MH + 80 - yb;
        cam.cy = hi < lo ? (lo + hi) / 2 : clamp(cam.cy, lo, hi);
      }
      function camGoal() {
        if (ph === 'aim') {
          if (overview) return { cx: MW / 2, cy: 290, s: camMin(), k: 4 };
          const dir = mySide === 0 ? 1 : -1;
          return { cx: mv.x + dir * 110, cy: mv.y - 45, s: 1, k: 5 };
        }
        if (ph === 'fire' && vol) {
          let x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9, any = false;
          const add = (x, y) => { any = true; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; };
          if (vol.t < 0.7) for (let t = 0; t < 2; t++) { const c = st.cr[t][vol.idx[t]]; add(c.x, c.y - 14); }
          for (const sh of vol.shots) add(sh.x, sh.y);
          for (const b of blasts) add(b.x, b.y);
          for (let t = 0; t < 2; t++) for (let i = 0; i < 3; i++) { const c = st.cr[t][i]; if (c.hp > 0 && c.air) add(c.x, c.y - 14); }
          if (!any) return null;
          const w = x1 - x0 + 220, h = y1 - y0 + 180;
          return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, s: clamp(Math.min(SW / w, SH / h), camMin(), 1), k: 6 };
        }
        if (ph === 'end' && celebrate) {
          const c = st.cr[celebrate.side].find(k => k.hp > 0);
          if (c) return { cx: c.x, cy: c.y - 40, s: 1, k: 2.5 };
        }
        return null;
      }
      function updateCam(dt) {
        const goal = camGoal();
        if (!cam.init) {
          cam.init = true;
          if (goal) { cam.cx = goal.cx; cam.cy = goal.cy; cam.s = goal.s; }
        } else if (goal) {
          const kk = 1 - Math.exp(-goal.k * dt), ks = 1 - Math.exp(-3 * dt);
          cam.cx += (goal.cx - cam.cx) * kk; cam.cy += (goal.cy - cam.cy) * kk; cam.s += (goal.s - cam.s) * ks;
        }
        clampCam();
      }
      const toWorldX = x => cam.cx + (x - SW / 2) / cam.s, toWorldY = y => cam.cy + (y - SH / 2) / cam.s;
      const toScrX = x => SW / 2 + (x - cam.cx) * cam.s, toScrY = y => SH / 2 + (y - cam.cy) * cam.s;

      // ---------- update
      function syncScore() {
        if (st.score[mySide] !== lastScore) { lastScore = st.score[mySide]; api.score(lastScore); }
      }
      function update(dt) {
        clock += dt; phT += dt;
        if (shake > 0) shake = Math.max(0, shake - dt);
        for (let i = banners.length - 1; i >= 0; i--) { banners[i].t += dt; if (banners[i].t > (banners[i].big ? 1.8 : 1.2)) banners.splice(i, 1); }
        for (let i = rings.length - 1; i >= 0; i--) { rings[i].t += dt; if (rings[i].t > 0.35) rings.splice(i, 1); }
        for (let i = blasts.length - 1; i >= 0; i--) { blasts[i].t += dt; if (blasts[i].t > 1.3) blasts.splice(i, 1); }
        for (let i = trails.length - 1; i >= 0; i--) { trails[i].t += dt; if (trails[i].t > 0.4) trails.splice(i, 1); }
        for (let i = pops.length - 1; i >= 0; i--) { pops[i].t += dt; pops[i].y -= 18 * dt; if (pops[i].t > 1.1) pops.splice(i, 1); }
        for (let i = parts.length - 1; i >= 0; i--) {
          const p = parts[i];
          p.t += dt; p.vy += p.g * dt; p.x += p.vx * dt; p.y += p.vy * dt;
          if (p.t > p.life) parts.splice(i, 1);
        }
        for (const p of props) {
          if (p.st !== 1) continue;
          p.t += dt; p.vy += 500 * dt; p.x += p.vx * dt; p.y += p.vy * dt; p.rot += p.vr * dt;
          if (p.t > 0.25 && (solid(p.x, p.y) || p.y > WATER) || p.t > 1.1) {
            p.st = 2; burst(p.x, p.y - 6, 7, ['#d9d2c4', '#fff', '#b8a98c'], 70, 0.5, 80);
          }
        }
        if (mySq > 0) mySq = Math.max(0, mySq - dt);
        for (let t = 0; t < 2; t++) for (let i = 0; i < 3; i++) {
          const c = st.cr[t][i];
          if (c.flash > 0) c.flash = Math.max(0, c.flash - dt);
          if (c.bob > 0) c.bob = Math.max(0, c.bob - dt * 4);
          if (c.sq > 0) c.sq = Math.max(0, c.sq - dt);
          c.vh += (c.hp - c.vh) * Math.min(1, dt * 6);
        }
        if (celebrate) {
          celebrate.t += dt;
          if (celebrate.t < 2.2 && Math.floor(celebrate.t * 8) !== Math.floor((celebrate.t - dt) * 8)) {
            const al = st.cr[celebrate.side].find(c => c.hp > 0);
            if (al) burst(al.x + (Math.random() - 0.5) * 40, al.y - 30, 8, ['#ffd84a', '#ff6fa8', '#6fd0ff', '#fff', '#8cf06a'], 220, 1.1, 260);
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
        updateCam(dt);
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
          const ox = oppVis.x; oppVis.x += (tx - oppVis.x) * k; oppVis.y += (ty - oppVis.y) * k; oppVis.f = tf;
          oppVis.walk = Math.abs(oppVis.x - ox) > 0.15 ? (oppVis.walk || 0) + dt * 14 : 0;
          oppVis.dir = oppVis.x > ox ? 1 : -1;
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
            if (walkMove(tmp, dir * a, Math.ceil(1.5 * a), Math.ceil(2.5 * a))) { mv.x = tmp.x; mv.y = tmp.y; stam -= a; walkPh += dt * 14; }
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

      // ---------- input (pointer arrives in screen units; aiming drags stay in screen units so power
      // feels the same at any zoom, critter taps go through the camera)
      function hitBtn(x, y) {
        for (const k of BTN_KEYS) {
          const b = BTN[k];
          if (x >= b.x - 3 && x <= b.x + b.w + 3 && y >= b.y - 3 && y <= b.y + b.h + 6) return k;
        }
        return null;
      }
      const hitMap = (x, y) => x >= BTN.map.x - 4 && x <= BTN.map.x + BTN.map.w + 4 && y >= BTN.map.y - 4 && y <= BTN.map.y + BTN.map.h + 4;
      function pressBtn(k) {
        if (k === 'fire') { lockAim(); return; }
        if (k === 'jump') {
          if (hop || stam < HOP_COST) return;
          const f = face >= 0 ? 1 : -1;
          hop = { x: mv.x, y: mv.y, vx: f * HOP_VX, vy: HOP_VY, air: true, fy: mv.y, hp: 100, slid: 0, lastBy: -1, sx: mv.x, sy: mv.y };
          stam -= HOP_COST;
          return;
        }
        if (k[0] === 'w') {
          const t = BTN[k].t;
          if (t !== 2 || st.ammo[mySide] > 0) atype = t;
        }
      }
      function down(x, y) {
        if (ph !== 'aim') return;
        if (hitMap(x, y)) { btnDown = 'map'; aimDrag = null; selTap = null; held = null; return; }
        if (locked) return;
        const b = hitBtn(x, y);
        if (b) {
          btnDown = b; aimDrag = null; selTap = null;
          if (b === 'left' || b === 'right') held = b;
          return;
        }
        btnDown = null; held = null;
        aimDrag = { sx: x, sy: y };
        selTap = null;
        const wx = toWorldX(x), wy = toWorldY(y), rx = Math.max(22, 20 / cam.s), ry = Math.max(24, 22 / cam.s);
        for (let i = 0; i < 3; i++) {
          const c = st.cr[mySide][i];
          if (i !== myIdx && c.hp > 0 && Math.abs(wx - c.x) < rx && Math.abs(wy - (c.y - 16)) < ry) { selTap = i; break; }
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
        if (btnDown === 'map') { btnDown = null; if (hitMap(x, y)) overview = !overview; return; }
        if (locked) { btnDown = null; aimDrag = null; return; }
        if (btnDown) {
          const b = btnDown; btnDown = null;
          if (b !== 'left' && b !== 'right' && hitBtn(x, y) === b) pressBtn(b);
        } else if (selTap !== null) { selectCritter(selTap); }
        selTap = null; aimDrag = null;
      }

      // ---------- render
      function paintBackdrop(g) {
        const x0 = view.x0 - 30, x1 = view.x1 + 30, y0 = view.y0 - 30, y1 = view.y1 + 30;
        g.fillStyle = '#8ed3f5'; g.fillRect(x0, y0, x1 - x0, 250 - y0);
        g.fillStyle = '#2f7fbf'; g.fillRect(x0, 250, x1 - x0, y1 - 250);
        // slight parallax: the picture slides a little against the camera
        const vw = view.x1 - view.x0, vh = view.y1 - view.y0;
        let bw = Math.max(vw, SW) * 1.12, bh = bw * SH / SW;
        if (bh < vh * 1.08) { bh = vh * 1.08; bw = bh * SW / SH; }
        const sx = (bw - vw) / 2, sy = (bh - vh) / 2;
        const px = clamp(-(cam.cx - MW / 2) * 0.05, -sx, sx), py = clamp(-(cam.cy - 300) * 0.04, -sy, sy);
        api.draw(g, 'bg_island_wide', (view.x0 + view.x1) / 2 + px, (view.y0 + view.y1) / 2 + py, { w: bw, h: bh, ax: 0.5, ay: 0.5 });
      }
      function critterPos(c) {
        let x = c.x, y = c.y, f = c.face, mine = false, walking = false, dir = 0, wp = 0, sq = c.sq;
        if (ph === 'aim') {
          if (c.team === mySide && c.i === myIdx) {
            x = mv.x; y = mv.y; f = face; mine = true; sq = mySq;
            if (hop) sq = 0;
            if (held && !locked && stam > 0 && !hop) { walking = true; dir = held === 'left' ? -1 : 1; wp = walkPh; }
          } else if (c.team === oppSide && oppVis && oppVis.i === c.i) {
            x = oppVis.x; y = oppVis.y; f = oppVis.f;
            if (oppVis.walk) { walking = true; dir = oppVis.dir; wp = oppVis.walk; }
          }
        }
        return { x, y, f, mine, walking, dir, wp, sq };
      }
      function weaponIcon(g, t, x, y, s) {
        if (t === 0) api.draw(g, 'shot_rocket', x, y, { w: 22 * s, h: 11 * s });
        else if (t === 1) api.draw(g, 'shot_grenade', x, y, { w: 16 * s, h: 16 * s });
        else api.draw(g, 'shot_cluster', x, y, { w: 17 * s, h: 17 * s });
      }
      function drawCritter(g, c) {
        const p = critterPos(c);
        let y = p.y;
        const act = p.mine && ph === 'aim' && !locked;
        if (act) {
          // glow ring at the feet + soft halo
          const pulse = 0.5 + 0.5 * Math.sin(clock * 5);
          const gl = g.createRadialGradient(p.x, y - 14, 4, p.x, y - 14, 30);
          gl.addColorStop(0, 'rgba(255,226,122,0.38)'); gl.addColorStop(1, 'rgba(255,226,122,0)');
          g.fillStyle = gl; g.beginPath(); g.arc(p.x, y - 14, 30, 0, 6.283); g.fill();
          g.lineWidth = 2; g.strokeStyle = 'rgba(255,236,150,' + (0.55 + 0.3 * pulse).toFixed(2) + ')';
          g.beginPath(); g.ellipse(p.x, y + 1, 19 + pulse * 2, 6 + pulse, 0, 0, 6.283); g.stroke();
        }
        // pose: idle breathing, squash on landing, stretch in the air, lean while walking
        let sx = 1, sy = 1, rot = 0;
        if (c.air || (p.mine && hop)) { sy = 1.08; sx = 0.94; }
        else {
          const b = Math.sin(clock * 3.2 + c.i * 1.7 + c.team * 0.9);
          sy += 0.035 * b; sx -= 0.015 * b;
        }
        if (p.sq > 0) { const k = Math.min(1, p.sq / 0.24) * 0.28; sx += k; sy -= k; }
        if (p.walking) { y -= Math.abs(Math.sin(p.wp)) * 2.5; rot = (0.12 + 0.06 * Math.sin(p.wp)) * (p.f >= 0 ? 1 : -1); }
        if (c.bob > 0) { y -= Math.sin(c.bob * 3.14) * 4; rot -= 0.1 * Math.sin(c.bob * 3.14) * (p.f >= 0 ? 1 : -1); }
        g.globalAlpha = c.flash > 0 && Math.floor(c.flash * 20) % 2 === 0 ? 0.45 : 1;
        api.draw(g, 'critter_' + color[c.team], p.x, y, { w: SPR * sx, h: SPR * sy, rot, flipX: p.f < 0 });
        g.globalAlpha = 1;
        // hp bar + number (a little bigger when zoomed out so it stays readable)
        const ls = clamp(0.8 / cam.s, 1, 1.5);
        g.save(); g.translate(p.x, y); g.scale(ls, ls); g.translate(-p.x, -y);
        const bw = 36, bx = p.x - bw / 2, by = y - 44;
        g.fillStyle = 'rgba(15,12,35,0.72)'; rrect(g, bx - 1.5, by - 1.5, bw + 3, 8, 4); g.fill();
        g.fillStyle = color[c.team] === 'pink' ? '#ff7ab8' : '#5aa2ff';
        const wv = Math.max(0, Math.min(bw, bw * c.vh / HP0));
        if (wv > 0) { rrect(g, bx, by, wv, 5, 2.5); g.fill(); }
        outlined(g, String(Math.max(0, Math.round(c.vh))), p.x, by - 9, 12, '#fff');
        if (act) {
          const ay = by - 22 + Math.abs(Math.sin(clock * 5)) * -5;
          g.fillStyle = '#ffe27a'; g.strokeStyle = 'rgba(20,10,50,0.9)'; g.lineWidth = 2; g.lineJoin = 'round';
          g.beginPath(); g.moveTo(p.x - 7, ay - 8); g.lineTo(p.x + 7, ay - 8); g.lineTo(p.x, ay + 3); g.closePath(); g.stroke(); g.fill();
          // selected weapon + power next to the critter
          const sd = face >= 0 ? 1 : -1;          // side the shot flies toward
          const wx = p.x - sd * 30, wy = y - 26;
          g.fillStyle = 'rgba(25,20,55,0.8)'; g.beginPath(); g.arc(wx, wy, 13, 0, 6.283); g.fill();
          g.lineWidth = 1.5; g.strokeStyle = 'rgba(255,255,255,0.55)'; g.stroke();
          weaponIcon(g, atype, wx, wy, 0.85);
          if (Math.sqrt(aim.dx * aim.dx + aim.dy * aim.dy) >= MIN_DRAG) {
            const pw = Math.round(100 * Math.min(1, Math.sqrt(aim.dx * aim.dx + aim.dy * aim.dy) / MAX_DRAG));
            outlined(g, pw + '%', p.x + sd * 32, y - 26, 14, '#ffd84a');
          }
        }
        g.restore();
      }
      function drawProps(g, vx0, vx1) {
        for (const p of props) {
          if (p.st === 2 || p.x < vx0 - 60 || p.x > vx1 + 60) continue;
          if (p.st === 1) api.draw(g, 'prop_' + p.k, p.x, p.y, { rot: p.rot, alpha: clamp(1 - Math.max(0, p.t - 0.5) / 0.6, 0, 1) });
          else api.draw(g, 'prop_' + p.k, p.x, p.y, { rot: 0.025 * Math.sin(clock * 1.4 + p.x * 0.07) * (p.k === 'palm' || p.k === 'bush' ? 1 : 0) });
        }
      }
      function world(g, vx0, vy0, vx1, vy1) {
        // cave backs, then terrain (only the visible part of the offscreen canvases)
        const sx0 = clamp(vx0, 0, MW), sx1 = clamp(vx1, 0, MW), sy0 = clamp(vy0, 0, MH), sy1 = clamp(vy1, 0, MH);
        if (sx1 > sx0 && sy1 > sy0) {
          if (backCv) g.drawImage(backCv, sx0, sy0, sx1 - sx0, sy1 - sy0, sx0, sy0, sx1 - sx0, sy1 - sy0);
          if (terrCv) g.drawImage(terrCv, sx0 * TS, sy0 * TS, (sx1 - sx0) * TS, (sy1 - sy0) * TS, sx0, sy0, sx1 - sx0, sy1 - sy0);
        }
        drawProps(g, vx0, vx1);

        // critters (alive); the active one last so its markers sit on top
        for (let t = 0; t < 2; t++) for (let i = 0; i < 3; i++) { const c = st.cr[t][i]; if (c.hp > 0 && !(t === mySide && i === myIdx)) drawCritter(g, c); }
        { const c = st.cr[mySide][myIdx]; if (c && c.hp > 0) drawCritter(g, c); }

        // water band
        const wy = WATER - 4, wx0 = vx0 - 20, wx1 = vx1 + 20;
        const wg = g.createLinearGradient(0, wy, 0, wy + 40);
        wg.addColorStop(0, 'rgba(90,190,245,0.55)'); wg.addColorStop(1, 'rgba(25,90,170,0.9)');
        g.fillStyle = wg; g.fillRect(wx0, wy, wx1 - wx0, Math.max(60, vy1 - wy + 30));
        g.lineWidth = 1.6;
        for (let k = 0; k < 3; k++) {
          g.strokeStyle = 'rgba(255,255,255,' + (0.5 - k * 0.12).toFixed(2) + ')';
          g.beginPath();
          const x00 = Math.floor(wx0 / 10) * 10;
          for (let x = x00; x <= wx1; x += 10) {
            const y = wy + 2 + k * 7 + Math.sin(x * 0.05 + clock * (1.6 + k * 0.4) + k) * 2;
            if (x === x00) g.moveTo(x, y); else g.lineTo(x, y);
          }
          g.stroke();
        }

        // aim dots (first 0.4 s of the path)
        if (ph === 'aim' && !locked && Math.sqrt(aim.dx * aim.dx + aim.dy * aim.dy) >= MIN_DRAG) {
          const sh = mkShot(mySide, mv, aim, atype);
          const wa = atype === 1 ? 0 : wind * WIND_ACC;
          const dk = Math.max(1, 1 / cam.s);
          for (let i = 1; i <= 8; i++) {
            const t = i * 0.05;
            const x = sh.x + sh.vx * t + 0.5 * wa * t * t, y = sh.y + sh.vy * t + 0.5 * GRAV * t * t;
            g.beginPath(); g.arc(x, y, (3.6 - i * 0.28) * dk, 0, 6.283);
            g.fillStyle = 'rgba(255,255,255,' + (0.95 - i * 0.09).toFixed(2) + ')'; g.fill();
          }
        }

        // trails + shots
        for (const t of trails) {
          g.globalAlpha = Math.max(0, 0.6 * (1 - t.t / 0.4));
          g.fillStyle = '#fff'; g.beginPath(); g.arc(t.x, t.y, 2, 0, 6.283); g.fill();
        }
        g.globalAlpha = 1;
        if (vol) {
          for (const sh of vol.shots) {
            if (!sh.alive) continue;
            if (sh.type === 0) api.draw(g, 'shot_rocket', sh.x, sh.y, { rot: Math.atan2(sh.vy, sh.vx) });
            else if (sh.type === 1) {
              api.draw(g, 'shot_grenade', sh.x, sh.y, { rot: sh.spin * 9 });
              outlined(g, String(Math.max(0, Math.ceil(FUSE - sh.t))), sh.x, sh.y - 14, 12, '#fff');
            } else if (sh.type === 2) api.draw(g, 'shot_cluster', sh.x, sh.y, { rot: sh.spin * 7 });
            else api.draw(g, 'shot_ball', sh.x, sh.y, { w: 8, h: 8 });
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
          if (p.x < vx0 - 10 || p.x > vx1 + 10) continue;
          g.globalAlpha = Math.max(0, 1 - p.t / p.life);
          g.fillStyle = p.c; g.fillRect(p.x - p.r / 2, p.y - p.r / 2, p.r, p.r);
        }
        g.globalAlpha = 1;
        // floating damage numbers: pop in, drift up, fade
        const pk = clamp(0.8 / cam.s, 1, 1.5);
        for (const p of pops) {
          g.globalAlpha = Math.max(0, 1 - Math.max(0, p.t - 0.7) / 0.4);
          const sc = (p.t < 0.12 ? 0.6 + p.t / 0.12 * 0.6 : 1.2 - Math.min(0.2, (p.t - 0.12) * 0.4)) * pk;
          const big = p.s === 'KO!';
          g.save(); g.translate(p.x, p.y); g.scale(sc, sc);
          outlined(g, p.s, 0, 0, big ? 22 : 17, p.col);
          g.restore();
        }
        g.globalAlpha = 1;
      }
      function render(g) {
        if (hasDom && (!terrCv || (!texBuilt && api.has('tex_soil') && api.has('tex_grass')))) {
          texBuilt = api.has('tex_soil') && api.has('tex_grass');
          buildTerrain();
        }
        const s = cam.s;
        const vx0 = cam.cx + (view.x0 - SW / 2) / s, vx1 = cam.cx + (view.x1 - SW / 2) / s;
        const vy0 = cam.cy + (view.y0 - SH / 2) / s, vy1 = cam.cy + (view.y1 - SH / 2) / s;
        g.save();
        if (shake > 0) g.translate((Math.random() - 0.5) * shake * 12, (Math.random() - 0.5) * shake * 12);
        paintBackdrop(g);
        g.save();
        g.translate(SW / 2, SH / 2); g.scale(s, s); g.translate(-cam.cx, -cam.cy);
        world(g, vx0, vy0, vx1, vy1);
        g.restore();
        g.restore();
        renderHud(g);
      }

      // small edge arrow pointing at a critter that is off-screen
      function edgeArrow(g, wx, wy, team) {
        const sx = toScrX(wx), sy = toScrY(wy - 14);
        const L = view.x0 + 14, R = view.x1 - 14, T = view.y0 + 14, B = view.y1 - 14;
        if (sx >= L && sx <= R && sy >= T && sy <= B) return;
        const ex = clamp(sx, view.x0 + 26, view.x1 - 26), ey = clamp(sy, 122, 276);
        const a = Math.atan2(sy - ey, sx - ex);
        const col = color[team] === 'pink' ? '#ff7ab8' : '#5aa2ff';
        g.save(); g.translate(ex, ey);
        g.fillStyle = 'rgba(20,10,50,0.78)'; g.beginPath(); g.arc(0, 0, 15, 0, 6.283); g.fill();
        g.lineWidth = 2.5; g.strokeStyle = col; g.stroke();
        api.draw(g, 'critter_' + color[team], 0, 8, { w: 20, h: 20 });
        g.rotate(a);
        g.fillStyle = '#ffe27a'; g.strokeStyle = 'rgba(20,10,50,0.9)'; g.lineWidth = 1.5; g.lineJoin = 'round';
        g.beginPath(); g.moveTo(25, 0); g.lineTo(17, -6); g.lineTo(17, 6); g.closePath(); g.stroke(); g.fill();
        g.restore();
      }

      function renderHud(g) {
        let big = '', small = '', status = '';
        small = 'Round ' + Math.max(1, round) + '/' + ROUNDS;
        if (ph === 'aim') {
          big = String(Math.ceil(aimT));
          if (locked) status = peerSetupFor(round) ? '' : 'Waiting for ' + nameOpp + '…';
          else status = nameOpp + ' is ' + (peerReady(round) ? 'ready' : 'aiming');
        } else if (ph === 'sync') status = 'Syncing…';
        // round pill, top-left under the quit button
        g.font = '800 13px ' + FONT;
        const tw = g.measureText(small).width;
        g.fillStyle = 'rgba(20,10,50,0.6)'; rrect(g, 8, 58, tw + 16, 24, 12); g.fill();
        text(g, small, 16, 70, 13, '#fff', 'left', 800);
        // wind pill, top-right under the opponent chip
        g.fillStyle = 'rgba(20,10,50,0.6)'; rrect(g, 528, 58, 104, 24, 12); g.fill();
        text(g, 'Wind', 538, 70, 13, '#fff', 'left', 800);
        {
          const cx = 590, cy = 70, len = 4 + Math.abs(wind) * 20, d = wind < 0 ? -1 : 1;
          g.strokeStyle = '#fff'; g.fillStyle = '#fff'; g.lineWidth = 2.5; g.lineCap = 'round';
          if (Math.abs(wind) < 0.05) { g.beginPath(); g.arc(cx, cy, 2.5, 0, 6.283); g.fill(); }
          else {
            g.beginPath(); g.moveTo(cx - d * len / 2, cy); g.lineTo(cx + d * len / 2, cy); g.stroke();
            g.beginPath(); g.moveTo(cx + d * len / 2 + d * 5, cy); g.lineTo(cx + d * len / 2 - d * 1, cy - 5); g.lineTo(cx + d * len / 2 - d * 1, cy + 5); g.closePath(); g.fill();
          }
          text(g, String(Math.round(Math.abs(wind) * 10)), 624, 70, 13, '#ffe27a', 'right', 800);
        }
        // map toggle under the wind pill
        if (ph === 'aim') {
          const b = BTN.map, on = overview;
          g.fillStyle = on ? 'rgba(255,226,122,0.95)' : 'rgba(20,10,50,0.6)'; rrect(g, b.x, b.y, b.w, b.h, 12); g.fill();
          if (on) { g.lineWidth = 1.5; g.strokeStyle = '#fff'; rrect(g, b.x, b.y, b.w, b.h, 12); g.stroke(); }
          text(g, on ? 'Zoom in' : 'Map', b.x + b.w / 2, b.y + b.h / 2, 13, on ? '#2b2453' : '#fff', 'center', 800);
        }
        // timer + status, top center under the score
        if (big) {
          const urgent = ph === 'aim' && !locked && aimT <= 5;
          g.font = '800 34px ' + FONT; g.textAlign = 'center'; g.textBaseline = 'middle';
          g.lineJoin = 'round'; g.lineWidth = 7; g.strokeStyle = 'rgba(20,10,50,0.85)';
          g.strokeText(big, 320, 72); g.fillStyle = urgent ? '#ff7a7a' : '#fff'; g.fillText(big, 320, 72);
        }
        if (status) outlined(g, status, 320, 99, 14, '#fff');

        if (ph === 'aim') {
          const mc = st.cr[mySide][myIdx];
          if (mc && mc.hp > 0) edgeArrow(g, mv.x, mv.y, mySide);
          if (oppVis) edgeArrow(g, oppVis.x, oppVis.y, oppSide);
        }

        if (ph === 'aim' || ph === 'fire' || ph === 'settle' || ph === 'sync') {
          const canAct = ph === 'aim' && !locked;
          // stamina above the left cluster
          if (canAct) {
            g.fillStyle = 'rgba(15,12,35,0.6)'; rrect(g, 10, 291, 180, 6, 3); g.fill();
            g.fillStyle = '#8cf06a'; if (stam > 0) { rrect(g, 10, 291, 180 * clamp(stam / STAMINA, 0, 1), 6, 3); g.fill(); }
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
            g.beginPath(); g.moveTo(cx + d * 11, cy); g.lineTo(cx - d * 8, cy - 13); g.lineTo(cx - d * 8, cy + 13); g.closePath(); g.fill();
            g.globalAlpha = 1;
          }
          {
            const b = BTN.jump; btn('jump', false, hop || stam < HOP_COST);
            const cx = b.x + b.w / 2, cy = b.y + 15;
            g.fillStyle = '#fff'; g.beginPath(); g.moveTo(cx, cy - 9); g.lineTo(cx + 10, cy + 5); g.lineTo(cx - 10, cy + 5); g.closePath(); g.fill();
            text(g, 'Jump', cx, b.y + 35, 13, '#fff', 'center', 800);
            g.globalAlpha = 1;
          }
          for (let t = 0; t < 3; t++) {
            const k = 'w' + t, b = BTN[k];
            const n = t === 2 ? st.ammo[mySide] : -1, sel = atype === t, off = t === 2 && n <= 0;
            btn(k, sel, off);
            const cx = b.x + b.w / 2;
            weaponIcon(g, t, cx, b.y + 17, 1);
            g.globalAlpha = 1;
            text(g, t === 2 ? 'x' + Math.max(0, n) : '∞', cx, b.y + 35, 13, sel ? '#2b2453' : '#ffe27a', 'center', 800);
          }
          {
            const f = BTN.fire;
            const pulse = canAct ? 0.5 + 0.5 * Math.sin(clock * 6) : 0;
            g.fillStyle = canAct ? 'rgb(' + (230 + 20 * pulse | 0) + ',70,70)' : 'rgba(25,20,55,0.78)';
            rrect(g, f.x, f.y, f.w, f.h, 14); g.fill();
            g.lineWidth = 2.5; g.strokeStyle = '#fff'; rrect(g, f.x, f.y, f.w, f.h, 14); g.stroke();
            text(g, canAct ? 'FIRE' : (ph === 'aim' ? 'Locked' : ''), f.x + f.w / 2, f.y + f.h / 2, canAct ? 28 : 16, '#fff', 'center', 800);
          }
          if (canAct && round === 1 && aimT > AIM_SECS - 6) outlined(g, 'Drag back to aim, then Fire', 320, 330, 14, '#fff');
          if (aimDrag && canAct && Math.sqrt(aim.dx * aim.dx + aim.dy * aim.dy) >= 8) {
            g.strokeStyle = 'rgba(255,255,255,0.5)'; g.lineWidth = 3; g.setLineDash([6, 6]);
            g.beginPath(); g.moveTo(aimDrag.sx, aimDrag.sy); g.lineTo(aimDrag.sx + aim.dx, aimDrag.sy + aim.dy); g.stroke();
            g.setLineDash([]);
            g.beginPath(); g.arc(aimDrag.sx, aimDrag.sy, 8, 0, 6.283); g.fillStyle = 'rgba(255,255,255,0.7)'; g.fill();
          }
        }
        for (let i = 0; i < banners.length; i++) {
          const b = banners[i], life = b.big ? 1.8 : 1.2, p = b.t / life;
          const e = 1 - Math.pow(1 - Math.min(1, p * 2.5), 3);
          const sc = 0.6 + 0.5 * e + 0.1 * p;
          const al = p < 0.6 ? 1 : Math.max(0, 1 - (p - 0.6) / 0.4);
          g.save();
          g.translate(320, 150 - (banners.length - 1 - i) * 42); g.scale(sc, sc); g.globalAlpha = al;
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
      updateCam(DT);
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
            feat: { caves: featCount('cave'), arches: featCount('arch'), overhangs: featCount('over'), islands: islands.length, props: props.length },
            spawn: spawn.map(a => a.map(s => [s.x, s.y])), cam: { cx: cam.cx, cy: cam.cy, s: cam.s },
            _st: st, _simTools: { evalShot, chooseSetup, mkShot, stepShot, solid },
          };
        },
      };
    },
  });
})();
