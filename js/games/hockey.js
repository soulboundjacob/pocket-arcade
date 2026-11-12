/* Puck Duel: real-time two-player air hockey with power-ups.
 *
 * Canonical table (360x640, matches table_rink art): the HOST's goal is at the bottom (y 626),
 * the guest's at the top. Host = the player whose name sorts first. Each phone draws its OWN goal
 * at the bottom (guest renders rotated 180 degrees) and maps touches back.
 *
 * Networking: the half that holds the puck owns it (simulates it, exact collisions with its own
 * mallet). Crossing the centre line sends `hand` (repeated until the new owner's snapshot arrives).
 * One combined `st` message at 15 Hz carries my mallet, the puck while I own it, and effect flags.
 * Goals / items / power-up uses are sent repeatedly until acked. A sliding-window limiter keeps
 * everything under 20 sends per second.
 *
 * Solo (api.opp null): one phone simulates everything and the guest mallet is a computer player.
 * api.auto: my mallet is driven by the same AI (test bots). */
(function () {
  'use strict';

  const W = 360, H = 640;
  // ---- table
  const X0 = 14, X1 = 346, Y0 = 14, Y1 = 626, MID = 320, CORNER = 40, GX0 = 120, GX1 = 240;
  const MR = 26, PR = 16;
  const POSTS = [[GX0, Y0], [GX1, Y0], [GX0, Y1], [GX1, Y1]];
  // ---- tunables (check on a phone)
  const FRICTION = 0.997, WALL_E = 0.9, MALLET_E = 0.92;
  const MAX_PUCK = 1100, MAX_BOOST = 1400;
  const SUBSTEPS = 4;
  const MALLET_MAX_V = 1700, MALLET_GAIN = 30, FINGER_LIFT = 40, SLOW_FACTOR = 0.45;
  const WIN_GOALS = 7, GOAL_PAUSE = 1.2;
  const RUSH_MULT = 1.7, RUSH_SECS = 6, SLOW_SECS = 5, MIRROR_SECS = 5, JUNK_SECS = 6;
  const BOMB_SPEED = 1000;
  const PICKUP_R = 26, MAX_ITEMS = 2;
  const WALL_W = 100, WALL_H = 14;
  const HAND_MARGIN = 2;           // hysteresis around the centre line
  const ST_HZ = 15, HAND_RESEND = 0.1, EVENT_RESEND = 0.15;
  const SEND_CAP = 20, ST_CAP = 15;
  const INTERP_DELAY = 0.1, EXTRAP_MAX = 0.15;
  const SILENCE = 2;
  const BOT = { maxV: 950, delay: 0.14, err: 12 };
  const AUTO = { maxV: 1350, delay: 0.08, err: 6 };
  const FONT = 'ui-rounded, system-ui, sans-serif';
  const TEAM = { blue: '#4aa3ff', pink: '#ff6fb5' };
  const KINDS = [['rush', 3], ['slow', 2], ['mirror', 2], ['junk', 2], ['bomb', 1]];
  const NAMES = { rush: 'Rush ready', slow: 'Slowed!', mirror: 'Mirrored!', junk: 'Wall up', bomb: 'Bomb!' };
  const BTNS = [{ x: 14, y: 572, w: 50, h: 50 }, { x: 68, y: 572, w: 50, h: 50 }];

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  const r0 = v => Math.round(v);
  const r1 = v => Math.round(v * 10) / 10;

  function txt(g, s, x, y, size, color, align, weight) {
    g.font = (weight || 800) + ' ' + size + 'px ' + FONT;
    g.textAlign = align || 'center'; g.textBaseline = 'middle';
    g.fillStyle = color; g.fillText(s, x, y);
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

  // ---------- physics helpers (canonical coordinates)
  function bounce(p, nx, ny) {
    const vn = p.vx * nx + p.vy * ny;
    if (vn >= 0) return 0;
    p.vx -= (1 + WALL_E) * vn * nx; p.vy -= (1 + WALL_E) * vn * ny;
    return -vn;
  }
  function rectCollide(p, r) {
    const cx = clamp(p.x, r.x0, r.x1), cy = clamp(p.y, r.y0, r.y1);
    const dx = p.x - cx, dy = p.y - cy, d2 = dx * dx + dy * dy;
    if (d2 >= PR * PR) return 0;
    let nx, ny;
    if (d2 > 1e-9) {
      const d = Math.sqrt(d2); nx = dx / d; ny = dy / d;
      p.x = cx + nx * PR; p.y = cy + ny * PR;
    } else {
      const l = p.x - r.x0, rt = r.x1 - p.x, t = p.y - r.y0, b = r.y1 - p.y;
      const m = Math.min(l, rt, t, b);
      if (m === t) { nx = 0; ny = -1; p.y = r.y0 - PR; }
      else if (m === b) { nx = 0; ny = 1; p.y = r.y1 + PR; }
      else if (m === l) { nx = -1; ny = 0; p.x = r.x0 - PR; }
      else { nx = 1; ny = 0; p.x = r.x1 + PR; }
    }
    return bounce(p, nx, ny);
  }
  // Table walls, rounded corners, goal posts. Returns the impact speed (0 = no hit).
  function worldCollide(p) {
    let hit = 0;
    const inSlot = p.x >= GX0 && p.x <= GX1;
    if (p.x < X0 + PR) { p.x = X0 + PR; hit = Math.max(hit, bounce(p, 1, 0)); }
    else if (p.x > X1 - PR) { p.x = X1 - PR; hit = Math.max(hit, bounce(p, -1, 0)); }
    if (!inSlot) {
      if (p.y < Y0 + PR) { p.y = Y0 + PR; hit = Math.max(hit, bounce(p, 0, 1)); }
      else if (p.y > Y1 - PR) { p.y = Y1 - PR; hit = Math.max(hit, bounce(p, 0, -1)); }
    } else if (p.y < Y0 || p.y > Y1) { // inside a goal pocket
      if (p.x < GX0 + PR) { p.x = GX0 + PR; hit = Math.max(hit, bounce(p, 1, 0)); }
      else if (p.x > GX1 - PR) { p.x = GX1 - PR; hit = Math.max(hit, bounce(p, -1, 0)); }
    }
    for (let i = 0; i < 4; i++) {
      const dx = p.x - POSTS[i][0], dy = p.y - POSTS[i][1], d2 = dx * dx + dy * dy;
      if (d2 < PR * PR && d2 > 1e-9) {
        const d = Math.sqrt(d2), nx = dx / d, ny = dy / d;
        p.x = POSTS[i][0] + nx * PR; p.y = POSTS[i][1] + ny * PR;
        hit = Math.max(hit, bounce(p, nx, ny));
      }
    }
    const ar = CORNER - PR;
    const corners = [[X0 + CORNER, Y0 + CORNER, -1, -1], [X1 - CORNER, Y0 + CORNER, 1, -1],
      [X0 + CORNER, Y1 - CORNER, -1, 1], [X1 - CORNER, Y1 - CORNER, 1, 1]];
    for (let i = 0; i < 4; i++) {
      const c = corners[i];
      if ((p.x - c[0]) * c[2] > 0 && (p.y - c[1]) * c[3] > 0) {
        const dx = p.x - c[0], dy = p.y - c[1], d = Math.hypot(dx, dy);
        if (d > ar) {
          p.x = c[0] + dx * ar / d; p.y = c[1] + dy * ar / d;
          hit = Math.max(hit, bounce(p, -dx / d, -dy / d));
        }
      }
    }
    return hit;
  }
  function puckInBounds(x, y) {
    if (x < X0 + PR || x > X1 - PR || y < Y0 + PR || y > Y1 - PR) return false;
    const ar = CORNER - PR;
    const cs = [[X0 + CORNER, Y0 + CORNER, -1, -1], [X1 - CORNER, Y0 + CORNER, 1, -1],
      [X0 + CORNER, Y1 - CORNER, -1, 1], [X1 - CORNER, Y1 - CORNER, 1, 1]];
    for (const c of cs) {
      if ((x - c[0]) * c[2] > 0 && (y - c[1]) * c[3] > 0 && Math.hypot(x - c[0], y - c[1]) > ar) return false;
    }
    return true;
  }
  function clampMallet(m, role) {
    const yMin = role === 'h' ? MID + MR : Y0 + MR, yMax = role === 'h' ? Y1 - MR : MID - MR;
    m.x = clamp(m.x, X0 + MR, X1 - MR); m.y = clamp(m.y, yMin, yMax);
    const ar = CORNER - MR;
    const cs = role === 'h' ? [[X0 + CORNER, Y1 - CORNER, -1, 1], [X1 - CORNER, Y1 - CORNER, 1, 1]]
      : [[X0 + CORNER, Y0 + CORNER, -1, -1], [X1 - CORNER, Y0 + CORNER, 1, -1]];
    for (const c of cs) {
      if ((m.x - c[0]) * c[2] > 0 && (m.y - c[1]) * c[3] > 0) {
        const dx = m.x - c[0], dy = m.y - c[1], d = Math.hypot(dx, dy);
        if (d > ar) { m.x = c[0] + dx * ar / d; m.y = c[1] + dy * ar / d; }
      }
    }
  }

  // ---------- snapshot buffers (receive-time stamped)
  function bufPush(buf, s) {
    const n = buf.length;
    if (n && s.t <= buf[n - 1].t) s.t = buf[n - 1].t + 1e-4;
    buf.push(s);
    while (buf.length > 24) buf.shift();
  }
  function bufSample(buf, t, hermite) {
    const n = buf.length;
    if (!n) return null;
    if (n === 1 || t <= buf[0].t) return { x: buf[0].x, y: buf[0].y, vx: buf[0].vx || 0, vy: buf[0].vy || 0 };
    const last = buf[n - 1];
    if (t >= last.t) {
      const d = Math.min(t - last.t, EXTRAP_MAX);
      return { x: last.x + (last.vx || 0) * d, y: last.y + (last.vy || 0) * d, vx: last.vx || 0, vy: last.vy || 0 };
    }
    let i = n - 2;
    while (i > 0 && buf[i].t > t) i--;
    const a = buf[i], b = buf[i + 1], dt = b.t - a.t, h = (t - a.t) / dt;
    if (hermite && dt < 0.25) {
      const h2 = h * h, h3 = h2 * h;
      const h00 = 2 * h3 - 3 * h2 + 1, h10 = h3 - 2 * h2 + h, h01 = -2 * h3 + 3 * h2, h11 = h3 - h2;
      return {
        x: h00 * a.x + h10 * dt * a.vx + h01 * b.x + h11 * dt * b.vx,
        y: h00 * a.y + h10 * dt * a.vy + h01 * b.y + h11 * dt * b.vy,
        vx: a.vx + (b.vx - a.vx) * h, vy: a.vy + (b.vy - a.vy) * h,
      };
    }
    return { x: a.x + (b.x - a.x) * h, y: a.y + (b.y - a.y) * h, vx: a.vx || 0, vy: a.vy || 0 };
  }

  Arcade.register({
    id: 'hockey', name: 'Puck Duel', blurb: 'Air hockey with power-ups. First to 7.', peerSync: true,
    init(api) {
      const solo = !api.opp;
      const auto = !!api.auto;
      const oppName = solo ? 'Bot' : api.opp.name;
      const iHost = solo || String(api.me.name).toLowerCase() <= String(api.opp.name).toLowerCase();
      const me = iHost ? 'h' : 'g', op = iHost ? 'g' : 'h';
      const myCol = api.me.color === 'pink' ? 'pink' : 'blue';
      const opCol = solo ? (myCol === 'blue' ? 'pink' : 'blue') : (api.opp.color === 'pink' ? 'pink' : 'blue');
      const colOf = { [me]: myCol, [op]: opCol };
      const nameOf = { [me]: api.me.name, [op]: oppName };
      const view = api.view;
      const sx = x => (iHost ? x : W - x), sy = y => (iHost ? y : H - y);

      // ---------- seeded item schedule (identical on both phones)
      const sched = [];
      {
        let t = 5 + api.rng() * 3;
        while (t < 1800) {
          const x = 70 + api.rng() * 220, y = MID + (api.rng() * 2 - 1) * 40;
          let v = api.rng() * 10, kind = KINDS[0][0];
          for (const k of KINDS) { v -= k[1]; if (v < 0) { kind = k[0]; break; } }
          sched.push({ t, x, y, kind });
          t += 7 + api.rng() * 4;
        }
      }
      const firstServe = api.rng() < 0.5 ? 'h' : 'g';

      // ---------- state
      let T = 0;
      const puck = { x: 180, y: firstServe === 'h' ? 420 : 220, vx: 0, vy: 0, boost: false };
      let owner = firstServe, N = 0, lastHit = null;
      let pend = null;                      // pending handoff I sent
      let showPuck = true, pauseUntil = 0, pendingServe = false, serveRole = firstServe;
      const goals = { h: 0, g: 0 };
      let applied = 0;
      const goalLog = [];
      let overAt = Infinity, overCalled = false, finalWinner = null;
      const mal = {
        h: { x: 180, y: 560, px: 180, py: 560, vx: 0, vy: 0, tx: 180, ty: 560 },
        g: { x: 180, y: 80, px: 180, py: 80, vx: 0, vy: 0, tx: 180, ty: 80 },
      };
      const fx = { h: { slow: 0, mirror: 0, rush: 0 }, g: { slow: 0, mirror: 0, rush: 0 } };
      let imposedSlow = 0, imposedMirror = 0;
      const walls = { h: 0, g: 0 };
      const inv = { h: [], g: [] };
      const taken = {};                      // item id -> role
      const itemLog = {};                    // id -> role (for tests)
      const useLog = {};                     // uid -> kind
      const seenUse = new Set();
      const rbuf = [], mbuf = [];
      let lastQ = -1, q = 0, lastRecv = 0, lastSt = -1, nextPing = 1, lat = 0.06;
      const outbox = [];
      const sendTimes = [];
      let useSeq = 0;
      let touching = false, ignorePtr = false;
      let waiting = false;
      // visuals
      const vis = { x: 0, y: 0 };
      let viewMode = '', viewPx = puck.x, viewPy = puck.y, vpx = puck.x, vpy = puck.y;
      const parts = [], banners = [], trail = [];
      let shake = 0, flash = 0, flashCol = '#fff', goalFlashSlot = null, trailT = 0, invSince = 0;
      const rest = { h: { x: 180, y: 560 }, g: { x: 180, y: 80 } };

      // ---------- banners / particles
      function banner(s, col, dur, big) {
        banners.push({ s, col: col || '#fff', t: 0, dur: dur || 1.4, big: !!big });
        while (banners.length > 3) banners.shift();
      }
      function spark(x, y, n, col, speed) {
        for (let i = 0; i < n && parts.length < 160; i++) {
          const a = Math.random() * 6.283, v = (0.3 + Math.random()) * speed;
          parts.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, t: 0, life: 0.25 + Math.random() * 0.3, col, s: 1.5 + Math.random() * 2 });
        }
      }

      // ---------- sending (sliding-window limiter: events <= 20/s, state <= 15/s)
      function emit(type, data, low) {
        while (sendTimes.length && sendTimes[0] <= T - 1) sendTimes.shift();
        if (sendTimes.length >= (low ? ST_CAP : SEND_CAP)) return false;
        api.send(type, data);
        sendTimes.push(T);
        return true;
      }
      function reliable(type, data, key, max, pre) {
        const o = { type, data, key, next: T + EVENT_RESEND, tries: 0, max: max || 40, pre, sent: false };
        outbox.push(o);
        if (emit(type, data, false)) { o.sent = true; o.tries = 1; }
        else o.next = T;
      }
      function ackKey(k) {
        for (let i = outbox.length - 1; i >= 0; i--) if (outbox[i].key === k) outbox.splice(i, 1);
      }

      // ---------- goals / serve / finish
      function applyGoal(g, scorer, local) {
        if (g !== applied + 1) return false;
        applied = g; goals[scorer]++;
        goalLog.push(scorer);
        const conceder = scorer === 'h' ? 'g' : 'h';
        pend = null; N = g * 1000; owner = conceder; serveRole = conceder; pendingServe = true;
        pauseUntil = T + GOAL_PAUSE; lastHit = null;
        puck.vx = puck.vy = 0; puck.boost = false; showPuck = false; trail.length = 0;
        // drop in-flight bombs and handoff-related stuff from the old rally
        for (let i = outbox.length - 1; i >= 0; i--) if (outbox[i].type === 'use' && outbox[i].data.k === 'bomb') outbox.splice(i, 1);
        const mine = scorer === me;
        goalFlashSlot = scorer === 'h' ? 'top' : 'bottom'; // the conceded goal (canonical)
        flash = 0.5; flashCol = TEAM[colOf[scorer]]; shake = 0.45;
        const gy = scorer === 'h' ? Y0 : Y1;
        spark(180, gy, 40, TEAM[colOf[scorer]], 420);
        api.score(goals[me]);
        if (goals[scorer] >= WIN_GOALS) {
          pauseUntil = Infinity; pendingServe = false;
          finalWinner = scorer;
          overAt = solo ? T + 1.5 : local ? T + 3 : T + 1.5;
          banner(scorer === me ? 'You win!' : nameOf[scorer] + ' wins', TEAM[colOf[scorer]], 99, true);
        } else {
          banner(mine ? 'Goal!' : 'Goal!', TEAM[colOf[scorer]], GOAL_PAUSE, true);
        }
        if (!solo && local) reliable('goal', { g, scorer }, 'g' + g, 60);
        return true;
      }
      function serve() {
        pendingServe = false;
        puck.x = 180; puck.y = serveRole === 'h' ? 420 : 220; puck.vx = puck.vy = 0; puck.boost = false;
        owner = serveRole; pend = null; lastHit = null; showPuck = true;
        rbuf.length = 0; bufPush(rbuf, { t: T, x: puck.x, y: puck.y, vx: 0, vy: 0 });
        vis.x = vis.y = 0; viewMode = ''; trail.length = 0;
      }

      // ---------- items
      function curItem() {
        let lo = 0, hi = sched.length - 1, i = -1;
        while (lo <= hi) { const m = (lo + hi) >> 1; if (sched[m].t <= T) { i = m; lo = m + 1; } else hi = m - 1; }
        if (i < 0 || taken[i] !== undefined) return null;
        return { id: i, it: sched[i], life: (i + 1 < sched.length ? sched[i + 1].t : sched[i].t + 10) - T };
      }
      function award(role, kind) {
        if (inv[role].length < MAX_ITEMS) {
          inv[role].push(kind);
          if (role === me) { invSince = T; banner('Got ' + kind.charAt(0).toUpperCase() + kind.slice(1) + '!', '#ffe27a', 1.0); }
        } else if (role === me) banner('Hands full', '#ffb0b0', 1.0);
      }
      function takeItem(id, by, local) {
        if (taken[id] !== undefined) return false;
        taken[id] = by; itemLog[id] = by;
        const it = sched[id];
        award(by, it.kind);
        spark(it.x, it.y, 14, '#ffe27a', 220);
        if (!solo && local) reliable('item', { id, by }, 'i' + id, 60);
        return true;
      }

      // ---------- effects
      function applyBomb(by) {
        const ty = by === 'h' ? Y0 : Y1;
        let dx = 180 - puck.x, dy = ty - puck.y;
        const d = Math.hypot(dx, dy) || 1;
        puck.vx = dx / d * BOMB_SPEED; puck.vy = dy / d * BOMB_SPEED; puck.boost = false;
        lastHit = by;
        spark(puck.x, puck.y, 26, '#ffb347', 380); shake = Math.max(shake, 0.3);
        banner('Bomb!', '#ffb347', 1.2);
      }
      function sendUse(kind) {
        const u = (iHost ? 'h' : 'g') + (++useSeq);
        useLog[u] = kind;
        const data = { k: kind, u };
        if (kind === 'bomb') {
          reliable('use', data, 'u' + u, 12, o => {
            if (owner === me && canSim() && !pend) { applyBomb(me); return true; }
            return false;
          });
        } else reliable('use', data, 'u' + u, 40);
      }
      function useItem(role, idx) {
        const kind = inv[role][idx];
        if (!kind || overCalled || finalWinner) return;
        if (T < pauseUntil) return;
        const other = role === 'h' ? 'g' : 'h';
        const local = solo || role === me;      // I am the one using it on this phone
        inv[role].splice(idx, 1);
        const col = TEAM[colOf[role]];
        if (kind === 'rush') {
          fx[role].rush = T + RUSH_SECS;
          banner('Rush ready', col, 1.2);
          if (!solo) sendUse('rush');
        } else if (kind === 'slow' || kind === 'mirror') {
          const dur = kind === 'slow' ? SLOW_SECS : MIRROR_SECS;
          if (solo) { fx[other][kind] = T + dur; }
          else { if (kind === 'slow') imposedSlow = T + dur; else imposedMirror = T + dur; sendUse(kind); }
          banner(NAMES[kind], col, 1.2);
        } else if (kind === 'junk') {
          walls[role] = T + JUNK_SECS; banner('Wall up', col, 1.2);
          if (!solo) sendUse('junk');
        } else if (kind === 'bomb') {
          if (solo) { if (canSim()) applyBomb(role); }
          else if (owner === me && canSim() && !pend) { applyBomb(me); if (local) sendUse('bomb-info'); }
          else sendUse('bomb');
        }
      }

      // ---------- puck simulation (owner only)
      function canSim() { return !waiting && T >= pauseUntil && !pendingServe && showPuck; }
      function activeWalls() {
        const out = [];
        if (walls.h > T) out.push({ x0: 180 - WALL_W / 2, x1: 180 + WALL_W / 2, y0: 600 - WALL_H / 2, y1: 600 + WALL_H / 2 });
        if (walls.g > T) out.push({ x0: 180 - WALL_W / 2, x1: 180 + WALL_W / 2, y0: 40 - WALL_H / 2, y1: 40 + WALL_H / 2 });
        return out;
      }
      function simRoles() { return solo ? ['h', 'g'] : [me]; }
      function collideMallet(role, frac) {
        const m = mal[role];
        const mx = m.px + (m.x - m.px) * frac, my = m.py + (m.y - m.py) * frac;
        const dx = puck.x - mx, dy = puck.y - my, rr = MR + PR;
        const d2 = dx * dx + dy * dy;
        if (d2 >= rr * rr) return false;
        let d = Math.sqrt(d2), nx, ny;
        if (d < 1e-6) { nx = 0; ny = role === 'h' ? -1 : 1; d = 0; } else { nx = dx / d; ny = dy / d; }
        puck.x = mx + nx * rr; puck.y = my + ny * rr;
        const rvx = puck.vx - m.vx, rvy = puck.vy - m.vy;
        const vn = rvx * nx + rvy * ny;
        if (vn < 0) {
          puck.vx -= (1 + MALLET_E) * vn * nx; puck.vy -= (1 + MALLET_E) * vn * ny;
          lastHit = role;
          if (fx[role].rush > T) {
            fx[role].rush = 0;
            let sp = Math.hypot(puck.vx, puck.vy);
            if (sp < 300) { const a = Math.atan2(puck.vy, puck.vx); puck.vx = Math.cos(a) * 300; puck.vy = Math.sin(a) * 300; sp = 300; }
            puck.vx *= RUSH_MULT; puck.vy *= RUSH_MULT; puck.boost = true;
            spark(puck.x, puck.y, 18, '#ffd23f', 420); shake = Math.max(shake, 0.2);
          }
          const imp = -vn;
          if (imp > 80) spark(puck.x - nx * PR, puck.y - ny * PR, Math.min(14, 3 + (imp / 90) | 0), '#fff6c9', 200 + imp * 0.2);
        }
        return true;
      }
      function unsquish(role) {
        const m = mal[role], rr = MR + PR;
        const dx = puck.x - m.x, dy = puck.y - m.y;
        if (dx * dx + dy * dy >= (rr - 0.5) * (rr - 0.5)) return;
        const base = Math.atan2(dy, dx);
        for (let k = 1; k <= 12; k++) {
          for (const s of [1, -1]) {
            const a = base + s * k * 0.26;
            const x = m.x + Math.cos(a) * rr, y = m.y + Math.sin(a) * rr;
            if (puckInBounds(x, y)) { puck.x = x; puck.y = y; return; }
          }
        }
      }
      function stepPuck(dt, interp) {
        const sub = dt / SUBSTEPS, roles = simRoles(), ws = activeWalls();
        for (let i = 1; i <= SUBSTEPS; i++) {
          puck.x += puck.vx * sub; puck.y += puck.vy * sub;
          const frac = interp ? i / SUBSTEPS : 1;
          let hitW = 0;
          for (const r of roles) collideMallet(r, frac);
          hitW = worldCollide(puck);
          for (const w of ws) hitW = Math.max(hitW, rectCollide(puck, w));
          for (const r of roles) { if (collideMallet(r, frac)) { hitW = Math.max(hitW, worldCollide(puck)); unsquish(r); } }
          if (hitW > 120) spark(puck.x, puck.y, 2 + (hitW / 250) | 0, '#cfe8ff', 160);
          // goals
          if (puck.y < Y0 - PR && puck.x >= GX0 && puck.x <= GX1) { applyGoal(applied + 1, 'h', true); return; }
          if (puck.y > Y1 + PR && puck.x >= GX0 && puck.x <= GX1) { applyGoal(applied + 1, 'g', true); return; }
          // items
          const ci = curItem();
          if (ci && lastHit && Math.hypot(puck.x - ci.it.x, puck.y - ci.it.y) < PICKUP_R) takeItem(ci.id, lastHit, true);
          // handoff
          if (!solo) {
            if ((owner === 'h' && me === 'h' && puck.y < MID - HAND_MARGIN) || (owner === 'g' && me === 'g' && puck.y > MID + HAND_MARGIN)) {
              startHandoff(); return;
            }
          }
        }
        puck.vx *= FRICTION; puck.vy *= FRICTION;
        const sp = Math.hypot(puck.vx, puck.vy), cap = puck.boost ? MAX_BOOST : MAX_PUCK;
        if (sp > cap) { puck.vx *= cap / sp; puck.vy *= cap / sp; }
        if (puck.boost && sp <= MAX_PUCK) puck.boost = false;
      }
      function startHandoff() {
        const n = N + 1;
        N = n;
        pend = { n, x: puck.x, y: puck.y, vx: puck.vx, vy: puck.vy, l: lastHit, next: T };
        owner = op;
        rbuf.length = 0; bufPush(rbuf, { t: T, x: puck.x, y: puck.y, vx: puck.vx, vy: puck.vy });
        sendHand();
      }
      function lcode(l) { return l === 'h' ? 'h' : l === 'g' ? 'g' : 0; }
      function sendHand() {
        const m = mal[me];
        const d = { x: r1(pend.x), y: r1(pend.y), vx: r0(pend.vx), vy: r0(pend.vy), n: pend.n, l: lcode(pend.l), m: [r0(m.x), r0(m.y)] };
        if (emit('hand', d, false)) { pend.next = T + (pend.sent ? HAND_RESEND : 0.035); pend.sent = (pend.sent || 0) + 1; if (pend.sent > 1) pend.sent = true; lastSt = T; }
      }
      function stepPend(dt) { // keep extrapolating the puck I handed off
        const p = pend;
        p.x += p.vx * dt; p.y += p.vy * dt;
        worldCollide(p);
        for (const w of activeWalls()) rectCollide(p, w);
        p.vx *= Math.pow(FRICTION, dt * 120); p.vy *= Math.pow(FRICTION, dt * 120);
      }
      function advancePuck(sec) {
        const n = Math.round(sec * 120);
        for (let i = 0; i < n; i++) {
          if (owner !== me || !canSim()) break;
          stepPuck(1 / 120, false);
        }
      }

      // ---------- mallets
      function stepMallet(role, m, maxV, gain, dt) {
        m.px = m.x; m.py = m.y;
        const dx = m.tx - m.x, dy = m.ty - m.y;
        const f = 1 - Math.exp(-gain * dt);
        let mx = dx * f, my = dy * f;
        const lim = maxV * dt, len = Math.hypot(mx, my);
        if (len > lim) { mx *= lim / len; my *= lim / len; }
        m.x += mx; m.y += my;
        clampMallet(m, role);
        m.vx = m.vx * 0.4 + (m.x - m.px) / dt * 0.6;
        m.vy = m.vy * 0.4 + (m.y - m.py) / dt * 0.6;
      }
      function slowMul(role) { return fx[role].slow > T ? SLOW_FACTOR : 1; }

      // ---------- computer player (bot in solo, my mallet under api.auto)
      function makeAI(role, cfg) {
        const hist = [];
        const sgn = role === 'h' ? 1 : -1;               // direction of my own goal
        const defY = role === 'h' ? 540 : 100, oppGoalY = role === 'h' ? Y0 : Y1;
        let nextThink = 0, tx = 180, ty = defY, aimX = 180, nextItem = 0;
        return {
          maxV: cfg.maxV,
          step(m, p) {
            hist.push({ t: T, x: p.x, y: p.y, vx: p.vx, vy: p.vy });
            while (hist.length > 2 && hist[1].t <= T - cfg.delay) hist.shift();
            if (T >= nextThink) {
              nextThink = T + 0.04 + Math.random() * 0.03;
              const h = hist[0], err = () => (Math.random() * 2 - 1) * cfg.err;
              const speed = Math.hypot(h.vx, h.vy);
              const inHome = (h.y - MID) * sgn > 0, toward = h.vy * sgn > 0;
              if (inHome && (speed < 420 || !toward)) {
                if (Math.random() < 0.08) aimX = 130 + Math.random() * 100;
                let dx = aimX - h.x, dy = oppGoalY - h.y;
                const dl = Math.hypot(dx, dy) || 1; dx /= dl; dy /= dl;
                const rx = m.x - h.x, ry = m.y - h.y;
                const dot = rx * dx + ry * dy;
                const pvx = rx - dx * dot, pvy = ry - dy * dot, pl = Math.hypot(pvx, pvy);
                if (dot < -8 && pl < 24) { tx = h.x + dx * 46; ty = h.y + dy * 46; }
                else {
                  const bx = h.x - dx * 54, by = h.y - dy * 54;
                  if (dot > -10 && pl < 40) { // mallet is in front of the puck: swing around
                    const ux = pl > 4 ? pvx / pl : 1, uy = pl > 4 ? pvy / pl : 0;
                    tx = bx + ux * 50; ty = by + uy * 50;
                  } else { tx = bx; ty = by; }
                }
                tx += err() * 0.3; ty += err() * 0.3;
              } else {
                let px = h.x;
                if (toward && Math.abs(h.vy) > 60) {
                  const t = (defY - h.y) / h.vy;
                  px = h.x + h.vx * t;
                  px = ((px - 30) % 600 + 600) % 600;      // fold off the side walls
                  if (px > 300) px = 600 - px;
                  px += 30;
                } else px = 180 + (h.x - 180) * 0.5;
                tx = clamp(px, 100, 260) + err();
                ty = defY - sgn * (toward ? 0 : 30);
              }
            }
            // items: use one now and then
            if (T >= nextItem && inv[role].length && (role === me ? T - invSince > 1.5 : true)) {
              nextItem = T + 0.4;
              if (Math.random() < 0.18 && T >= pauseUntil) useItem(role, 0);
            }
            return [tx, ty];
          },
        };
      }
      const bot = solo ? makeAI('g', BOT) : null;
      const myAI = auto ? makeAI(me, AUTO) : null;

      // ---------- input
      function mapFinger(x, y) {
        let cx = sx(x), cy = sy(y - FINGER_LIFT);
        if (fx[me].mirror > T) cx = W - cx;
        return [cx, cy];
      }
      function hitBtn(x, y) {
        for (let i = 0; i < BTNS.length; i++) {
          const b = BTNS[i];
          if (x >= b.x - 4 && x <= b.x + b.w + 4 && y >= b.y - 4 && y <= b.y + b.h + 4) return i;
        }
        return -1;
      }

      // ---------- networking: receive
      function onSample(d) {
        lastRecv = T;
        if (d.m) {
          const prev = mbuf.length ? mbuf[mbuf.length - 1] : null;
          const s = { t: T, x: d.m[0], y: d.m[1], vx: 0, vy: 0 };
          if (prev && T - prev.t > 0.01) { s.vx = (s.x - prev.x) / (T - prev.t); s.vy = (s.y - prev.y) / (T - prev.t); }
          bufPush(mbuf, s);
        }
      }
      function receiveMsg(type, d) {
        if (solo || !d) return;
        if (type === 'st') {
          if (d.q <= lastQ) return;
          lastQ = d.q; onSample(d);
          if (d.k && owner === op && T >= pauseUntil && !pendingServe) {
            const n = d.k[4];
            if (n >= N && (!pend || n >= pend.n)) {
              N = Math.max(N, n);
              if (pend) pend = null;
              bufPush(rbuf, { t: T, x: d.k[0], y: d.k[1], vx: d.k[2], vy: d.k[3] });
              lastHit = d.k[5] || null;
            }
          }
          if (d.e) {
            if (d.e.s > 0 && fx[me].slow < T + d.e.s - 0.05) { if (fx[me].slow < T) banner('Slowed!', TEAM[colOf[op]], 1.2); fx[me].slow = T + d.e.s; }
            if (d.e.m > 0 && fx[me].mirror < T + d.e.m - 0.05) { if (fx[me].mirror < T) banner('Mirrored!', TEAM[colOf[op]], 1.2); fx[me].mirror = T + d.e.m; }
          }
        } else if (type === 'hand') {
          onSample(d);
          if (d.n > N && T >= pauseUntil && !pendingServe) {
            N = d.n; pend = null; owner = me;
            puck.x = d.x; puck.y = d.y; puck.vx = d.vx; puck.vy = d.vy; puck.boost = false;
            lastHit = d.l || null;
            advancePuck(lat);
            lastSt = -1;
          }
        } else if (type === 'goal') {
          lastRecv = T;
          if (d.g === applied + 1) applyGoal(d.g, d.scorer, false);
          if (d.g <= applied) emit('ack', { g: d.g }, false);
        } else if (type === 'ack') {
          lastRecv = T;
          if (d.g !== undefined) { ackKey('g' + d.g); if (finalWinner && d.g === applied) overAt = Math.min(overAt, T + 0.3); }
          if (d.i !== undefined) ackKey('i' + d.i);
          if (d.u !== undefined) ackKey('u' + d.u);
        } else if (type === 'item') {
          lastRecv = T;
          takeItem(d.id, d.by, false);
          emit('ack', { i: d.id }, false);
        } else if (type === 'use') {
          lastRecv = T;
          const k = d.k, u = d.u;
          if (seenUse.has(u)) { emit('ack', { u }, false); return; }
          const col = TEAM[colOf[op]];
          if (k === 'bomb') {
            if (owner === me && canSim() && !pend) {
              seenUse.add(u); useLog[u] = k; applyBomb(op); emit('ack', { u }, false);
              const bi = inv[op].indexOf('bomb'); if (bi >= 0) inv[op].splice(bi, 1);
            }
            else if (T < pauseUntil || finalWinner) {
              seenUse.add(u); useLog[u] = k; emit('ack', { u }, false);
              const bi = inv[op].indexOf('bomb'); if (bi >= 0) inv[op].splice(bi, 1);
            }
            return;
          }
          seenUse.add(u); useLog[u] = k;
          const i = inv[op].indexOf(k === 'bomb-info' ? 'bomb' : k);
          if (i >= 0) inv[op].splice(i, 1);
          if (k === 'rush') banner('Rush ready', col, 1.2);
          else if (k === 'slow') { fx[me].slow = T + SLOW_SECS; banner('Slowed!', col, 1.2); }
          else if (k === 'mirror') { fx[me].mirror = T + MIRROR_SECS; banner('Mirrored!', col, 1.2); }
          else if (k === 'junk') { walls[op] = T + JUNK_SECS; banner('Wall up', col, 1.2); }
          else if (k === 'bomb-info') banner('Bomb!', '#ffb347', 1.2);
          emit('ack', { u }, false);
        } else if (type === 'ping') {
          lastRecv = T;
          emit('pong', { t: d.t }, false);
        } else if (type === 'pong') {
          lastRecv = T;
          const rtt = T - d.t;
          if (rtt >= 0 && rtt < 3) lat = clamp(lat * 0.5 + (rtt / 2) * 0.5, 0, 0.15);
        }
      }

      // ---------- networking: periodic send
      function netTick() {
        if (solo || overCalled) return;
        for (let i = outbox.length - 1; i >= 0; i--) {
          const o = outbox[i];
          if (T < o.next) continue;
          if (o.pre && o.pre(o)) { outbox.splice(i, 1); continue; }
          if (o.tries >= o.max) { outbox.splice(i, 1); continue; }
          if (emit(o.type, o.data, false)) { o.tries++; o.next = T + EVENT_RESEND; }
        }
        if (pend && T >= pend.next) sendHand();
        const period = (T < pauseUntil ? 2 : 1) / ST_HZ;
        if (T - lastSt >= period - 1e-6) {
          const m = mal[me];
          const d = { q: q + 1, m: [r0(m.x), r0(m.y)] };
          if (owner === me && canSim()) d.k = [r1(puck.x), r1(puck.y), r0(puck.vx), r0(puck.vy), N, lcode(lastHit)];
          const s = imposedSlow > T ? r1(imposedSlow - T) : 0, mi = imposedMirror > T ? r1(imposedMirror - T) : 0;
          if (s || mi) d.e = { s, m: mi };
          if (emit('st', d, true)) { q++; lastSt = T; }
        }
        if (T >= nextPing) { if (emit('ping', { t: T }, false)) nextPing = T + 2; }
      }

      // ---------- main update
      function computeView(dt) {
        let bx, by, mode;
        if (!showPuck) { viewMode = ''; return; }
        if (solo || owner === me) { bx = puck.x; by = puck.y; mode = 'sim'; }
        else if (pend) { bx = pend.x; by = pend.y; mode = 'pend'; }
        else {
          const s = bufSample(rbuf, T - INTERP_DELAY, true);
          if (s) { bx = s.x; by = s.y; } else { bx = puck.x; by = puck.y; }
          mode = 'buf';
        }
        if (viewMode && mode !== viewMode) { vis.x = vpx - bx; vis.y = vpy - by; }
        viewMode = mode;
        const k = Math.exp(-dt * 9);
        vis.x *= k; vis.y *= k;
        vpx = bx + vis.x; vpy = by + vis.y;
        // the engine view of the puck for the AI
      }
      function visiblePuck() {
        if (solo || owner === me) return puck;
        return { x: vpx, y: vpy, vx: 0, vy: 0 };
      }

      function update(dt) {
        T += dt;
        waiting = !solo && T - lastRecv > SILENCE && !overCalled;
        // mallet input
        const m = mal[me];
        if (myAI) {
          const p = visiblePuck();
          const pv = (solo || owner === me) ? p : { x: p.x, y: p.y, vx: (p.x - (myAI.lx === undefined ? p.x : myAI.lx)) / dt, vy: (p.y - (myAI.ly === undefined ? p.y : myAI.ly)) / dt };
          myAI.lx = p.x; myAI.ly = p.y;
          const tg = myAI.step(m, pv);
          m.tx = fx[me].mirror > T ? W - tg[0] : tg[0]; m.ty = tg[1];
        }
        const mm = slowMul(me);
        stepMallet(me, m, (myAI ? myAI.maxV : MALLET_MAX_V) * mm, MALLET_GAIN * (mm < 1 ? 0.6 : 1), dt);
        if (solo) {
          const b = mal.g, tg = bot.step(b, puck);
          b.tx = fx.g.mirror > T ? W - tg[0] : tg[0]; b.ty = tg[1];
          const bm = slowMul('g');
          stepMallet('g', b, bot.maxV * bm, MALLET_GAIN * 0.6 * (bm < 1 ? 0.6 : 1), dt);
        }
        // puck
        if (pendingServe && T >= pauseUntil) serve();
        if (solo) { if (canSim()) stepPuck(dt, true); }
        else if (owner === me) { if (canSim()) stepPuck(dt, true); }
        else if (pend && canSimPend()) stepPend(dt);
        computeView(dt);
        // trail
        trailT += dt;
        if (trailT >= 1 / 60) {
          trailT = 0;
          const sp = Math.hypot(puck.vx, puck.vy);
          if (showPuck && ((owner === me || solo) ? sp : 0) > 350 || (owner !== me && !solo && viewMode)) {
            trail.push({ x: vpx, y: vpy, t: 0, hot: puck.boost });
          }
          while (trail.length > 9) trail.shift();
        }
        if (waiting === false || solo) { /* nothing */ }
        netTick();
        // timers and visuals
        if (T >= overAt && !overCalled) { overCalled = true; api.over(); }
        for (let i = banners.length - 1; i >= 0; i--) { banners[i].t += dt; if (banners[i].t > banners[i].dur) banners.splice(i, 1); }
        for (let i = parts.length - 1; i >= 0; i--) {
          const p = parts[i]; p.t += dt; p.x += p.vx * dt; p.y += p.vy * dt; p.vx *= 0.93; p.vy *= 0.93;
          if (p.t > p.life) parts.splice(i, 1);
        }
        for (const tr of trail) tr.t += dt;
        shake = Math.max(0, shake - dt); flash = Math.max(0, flash - dt * 1.6);
      }
      function canSimPend() { return !waiting && T >= pauseUntil; }

      // ---------- render
      function haloItem(g, ci) {
        const [x, y] = [sx(ci.it.x), sy(ci.it.y)];
        const pulse = 1 + Math.sin(T * 6) * 0.12, fade = ci.life < 1.5 ? 0.4 + 0.6 * Math.abs(Math.sin(T * 10)) : 1;
        g.save(); g.globalAlpha = fade;
        const gr = g.createRadialGradient(x, y, 4, x, y, 30 * pulse);
        gr.addColorStop(0, 'rgba(255,240,150,0.9)'); gr.addColorStop(1, 'rgba(255,240,150,0)');
        g.fillStyle = gr; g.beginPath(); g.arc(x, y, 30 * pulse, 0, 6.283); g.fill();
        g.strokeStyle = 'rgba(255,255,255,0.8)'; g.lineWidth = 2; g.beginPath(); g.arc(x, y, 22 * pulse, 0, 6.283); g.stroke();
        g.restore();
        api.draw(g, 'icon_' + ci.it.kind, x, y, { w: 38, h: 38, alpha: fade });
      }
      function drawMallet(g, role) {
        let x, y;
        if (solo || role === me) { x = mal[role].x; y = mal[role].y; }
        else { const s = bufSample(mbuf, T - INTERP_DELAY, false); if (!s) { x = rest[role].x; y = rest[role].y; } else { x = s.x; y = s.y; } }
        const px = sx(x), py = sy(y);
        g.fillStyle = 'rgba(0,0,0,0.25)'; g.beginPath(); g.ellipse(px + 2, py + 5, 24, 20, 0, 0, 6.283); g.fill();
        if (fx[role].rush > T) {
          g.strokeStyle = 'rgba(255,210,63,' + (0.5 + 0.4 * Math.sin(T * 12)) + ')'; g.lineWidth = 4;
          g.beginPath(); g.arc(px, py, 31, 0, 6.283); g.stroke();
        }
        if (fx[role].slow > T) { g.strokeStyle = 'rgba(120,200,255,0.9)'; g.lineWidth = 3; g.setLineDash([5, 4]); g.beginPath(); g.arc(px, py, 33, 0, 6.283); g.stroke(); g.setLineDash([]); }
        if (fx[role].mirror > T) { g.strokeStyle = 'rgba(220,120,255,0.9)'; g.lineWidth = 3; g.beginPath(); g.arc(px, py, 36, 0, 6.283); g.stroke(); }
        api.draw(g, 'mallet_' + colOf[role], px, py, { w: 56, h: 56 });
      }
      function render(g) {
        g.save();
        if (shake > 0) { const a = shake * 14; g.translate((Math.random() - 0.5) * a, (Math.random() - 0.5) * a); }
        g.fillStyle = '#0d1424';
        g.fillRect(view.x0 - 20, view.y0 - 20, view.x1 - view.x0 + 40, view.y1 - view.y0 + 40);
        api.draw(g, 'table_rink', 180, 320, { rot: iHost ? 0 : Math.PI });
        // goal flash glow on the conceded slot
        if (goalFlashSlot && flash > 0) {
          const gy = goalFlashSlot === 'top' ? Y0 : Y1;
          g.fillStyle = flashCol; g.globalAlpha = Math.min(0.7, flash);
          g.fillRect(GX0, sy(gy) - 14, GX1 - GX0, 28);
          g.globalAlpha = 1;
        }
        // scores at the right edge
        g.globalAlpha = 0.4;
        txt(g, String(goals[me]), 338, 470, 64, TEAM[myCol], 'right', 900);
        txt(g, String(goals[op]), 338, 170, 64, TEAM[opCol], 'right', 900);
        g.globalAlpha = 1;
        // wall blocks
        for (const role of ['h', 'g']) {
          if (walls[role] > T) {
            const left = walls[role] - T, a = left < 1 ? 0.4 + 0.6 * Math.abs(Math.sin(T * 14)) : 1;
            const cx = sx(180), cy = sy(role === 'h' ? 600 : 40);
            g.globalAlpha = a;
            g.fillStyle = '#c4553a'; rrect(g, cx - WALL_W / 2, cy - WALL_H / 2, WALL_W, WALL_H, 3); g.fill();
            g.strokeStyle = '#6b2a1c'; g.lineWidth = 1.5;
            for (let i = 1; i < 5; i++) { g.beginPath(); g.moveTo(cx - WALL_W / 2 + i * 20, cy - WALL_H / 2); g.lineTo(cx - WALL_W / 2 + i * 20, cy + WALL_H / 2); g.stroke(); }
            rrect(g, cx - WALL_W / 2, cy - WALL_H / 2, WALL_W, WALL_H, 3); g.stroke();
            g.globalAlpha = 1;
          }
        }
        const ci = curItem(); if (ci) haloItem(g, ci);
        // trail
        for (const tr of trail) {
          const a = Math.max(0, 1 - tr.t * 6) * 0.45;
          if (a <= 0) continue;
          g.fillStyle = tr.hot ? 'rgba(255,170,40,' + a + ')' : 'rgba(255,255,255,' + a + ')';
          g.beginPath(); g.arc(sx(tr.x), sy(tr.y), tr.hot ? 13 : 10, 0, 6.283); g.fill();
        }
        if (showPuck) {
          g.fillStyle = 'rgba(0,0,0,0.25)'; g.beginPath(); g.ellipse(sx(vpx) + 1, sy(vpy) + 3, 15, 13, 0, 0, 6.283); g.fill();
          api.draw(g, 'puck', sx(vpx), sy(vpy), { w: 36, h: 36 });
        }
        drawMallet(g, op); drawMallet(g, me);
        for (const p of parts) {
          g.globalAlpha = Math.max(0, 1 - p.t / p.life); g.fillStyle = p.col;
          g.beginPath(); g.arc(sx(p.x), sy(p.y), p.s, 0, 6.283); g.fill();
        }
        g.globalAlpha = 1;
        if (flash > 0) { g.globalAlpha = Math.min(0.35, flash * 0.5); g.fillStyle = flashCol; g.fillRect(view.x0, view.y0, view.x1 - view.x0, view.y1 - view.y0); g.globalAlpha = 1; }
        g.restore();
        // item buttons (bottom-left)
        for (let i = 0; i < BTNS.length; i++) {
          const b = BTNS[i], k = inv[me][i];
          g.fillStyle = k ? 'rgba(20,30,50,0.82)' : 'rgba(20,30,50,0.4)';
          rrect(g, b.x, b.y, b.w, b.h, 10); g.fill();
          g.strokeStyle = k ? '#ffe27a' : 'rgba(255,255,255,0.25)'; g.lineWidth = 2; g.stroke();
          if (k) api.draw(g, 'icon_' + k, b.x + b.w / 2, b.y + b.h / 2, { w: 40, h: 40 });
        }
        // effect chips
        let cy = 540;
        for (const [k, lab] of [['slow', 'Slowed'], ['mirror', 'Mirrored']]) {
          if (fx[me][k] > T) { txt(g, lab + ' ' + (fx[me][k] - T).toFixed(1), 340, cy, 13, '#fff', 'right', 800); cy -= 16; }
        }
        // banners
        let by = 345;
        for (const b of banners) {
          const a = Math.min(1, b.t * 8, (b.dur - b.t) * 4);
          g.globalAlpha = Math.max(0, a);
          if (b.big) { txt(g, b.s, 180, 300, 46, b.col, 'center', 900); by = 345; }
          else { txt(g, b.s, 180, by, 22, b.col, 'center', 800); by += 26; }
          g.globalAlpha = 1;
        }
        if (waiting) {
          g.fillStyle = 'rgba(8,12,24,0.55)'; g.fillRect(0, 280, 360, 80);
          txt(g, 'Waiting for ' + oppName + '…', 180, 320, 24, '#fff', 'center', 800);
        }
      }

      // ---------- pointer
      function down(x, y) {
        const b = hitBtn(x, y);
        touching = false; ignorePtr = false;
        if (b >= 0) { ignorePtr = true; useItem(me, b); return; }
        if (y < MID) { ignorePtr = true; return; }
        touching = true;
        const t = mapFinger(x, y); mal[me].tx = t[0]; mal[me].ty = t[1];
      }
      function move(x, y) {
        if (!touching || ignorePtr) return;
        const t = mapFinger(x, y); mal[me].tx = t[0]; mal[me].ty = t[1];
      }
      function up() { touching = false; ignorePtr = false; }
      // second finger (engine): use an item without lifting the steering thumb
      function tap(x, y) { const b = hitBtn(x, y); if (b >= 0) useItem(me, b); }

      return {
        update, render, down, move, up, tap,
        ghost() { return { s: goals[me], o: goals[op], n: applied }; },
        receive(type, data) { receiveMsg(type, data); },
        dbg() {
          return { me, owner, own: solo || owner === me, pend: !!pend, N, applied, goals: { h: goals.h, g: goals.g }, puck: { x: puck.x, y: puck.y, vx: puck.vx, vy: puck.vy },
            mal: mal[me], inv, itemLog, useLog, paused: T < pauseUntil || pendingServe, showPuck, waiting, T, finalWinner, overCalled, lat, goalLog, view: { x: vpx, y: vpy } };
        },
      };
    },
  });
})();
