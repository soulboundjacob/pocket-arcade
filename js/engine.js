/* Pocket Arcade engine: game registry, sprites, seeded RNG and a fixed-step runner.
 *
 * Game module contract (js/games/<id>.js):
 *   Arcade.register({
 *     id: 'plane', name: 'Paper Plane', blurb: 'Tap to fly between the pencils.',
 *     init(api) { return { update(dt), render(g, ghost), down(x, y), up(x, y), ghost() } }
 *   });
 *
 * api (passed to init):
 *   W, H        360 x 640 logical world. Gameplay stays inside it.
 *   view        {x0,y0,x1,y1}: the visible logical rect. On tall phones it extends above 0
 *               and below H. Paint your background across all of it.
 *   rng()       seeded PRNG, identical sequence on both phones. Use it for ALL layout
 *               randomness so both players get the same course. Math.random is fine for
 *               cosmetic effects only.
 *   me, opp     {name, color} where color is 'blue' or 'pink'. opp is null in solo play.
 *   score(n)    report the current score (integer).
 *   over()      report that the run ended. Call once. update()/render() keep being called
 *               afterwards so death animations can play; input stops.
 *   draw(g, key, x, y, o)  draw a sprite from assets/manifest.json anchored at x,y.
 *               o: {w, h, rot (radians), alpha, frame, flipX, flipY, ax, ay}.
 *   has(key)    sprite loaded?
 *   t()         seconds of play so far (sim time).
 *
 * Instance:
 *   update(dt)  fixed steps of 1/120 s.
 *   render(g, ghost)  g is a 2D context already scaled to logical units. ghost is the
 *               opponent's latest ghost() object, or null.
 *   down/up(x, y)  pointer in logical units (one pointer at a time).
 *   move(x, y)  optional: pointer moved while down.
 *   ghost()     small JSON object (< 100 bytes; versus games up to ~300) describing my
 *               state for the other phone.
 *   receive(type, data)  optional, versus games: a message the other phone's copy sent
 *               with api.send(type, data).
 *
 * def.versus = true marks a last-one-standing game: in a head-to-head match the first
 * player whose run ends loses, and the other player's run ends right then.
 */
(function (root) {
  'use strict';
  const W = 360, H = 640, STEP = 1 / 120;
  const games = {};
  const order = [];

  function register(def) {
    if (!games[def.id]) order.push(def.id);
    games[def.id] = def;
  }

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

  // ---------- sprites
  const sprites = {};
  function loadImg(src) {
    return new Promise((ok, fail) => {
      const img = new Image();
      img.onload = () => ok(img);
      img.onerror = fail;
      img.src = src;
    });
  }
  async function loadSprites(base, style) {
    const res = await fetch(base + 'manifest.json', { cache: 'no-cache' });
    const manifest = await res.json();
    const jobs = [];
    for (const [key, s] of Object.entries(manifest.sprites)) {
      const n = s.frames || 1;
      const entry = { w: s.w, h: s.h, ax: s.ax ?? 0.5, ay: s.ay ?? 0.5, imgs: new Array(n), ready: false, url: null };
      sprites[key] = entry;
      for (let i = 0; i < n; i++) {
        const file = n > 1 ? s.file.replace('##', String(i).padStart(2, '0')) : s.file;
        const url = base + style + '/' + file;
        if (i === 0) entry.url = url;
        jobs.push(loadImg(url).then(img => { entry.imgs[i] = img; }, () => {}));
      }
    }
    await Promise.all(jobs);
    for (const e of Object.values(sprites)) e.ready = e.imgs.every(Boolean);
    return sprites;
  }
  function has(key) {
    const s = sprites[key];
    return !!(s && s.ready);
  }
  function draw(g, key, x, y, o) {
    o = o || {};
    const s = sprites[key];
    const w = o.w ?? (s ? s.w : 40), h = o.h ?? (s ? s.h : 40);
    const ax = o.ax ?? (s ? s.ax : 0.5), ay = o.ay ?? (s ? s.ay : 0.5);
    g.save();
    g.translate(x, y);
    if (o.rot) g.rotate(o.rot);
    if (o.flipX || o.flipY) g.scale(o.flipX ? -1 : 1, o.flipY ? -1 : 1);
    if (o.alpha != null) g.globalAlpha *= o.alpha;
    const n = s ? s.imgs.length : 1;
    const img = s && s.imgs[((o.frame | 0) % n + n) % n];
    if (img) {
      g.drawImage(img, -ax * w, -ay * h, w, h);
    } else { // dev placeholder until the art lands
      g.strokeStyle = '#d0d'; g.setLineDash([4, 4]); g.lineWidth = 1.5;
      g.strokeRect(-ax * w, -ay * h, w, h);
      g.setLineDash([]);
      g.fillStyle = '#d0d'; g.font = '10px sans-serif';
      g.fillText(key, -ax * w + 3, -ay * h + 12);
    }
    g.restore();
  }

  // ---------- runner
  function run(opts) {
    // opts: {canvas, game, seed, me, opp, onScore(n), onOver(score), onGhost(obj), getGhost()}
    const def = games[opts.game];
    if (!def) throw new Error('unknown game ' + opts.game);
    const canvas = opts.canvas;
    const g = canvas.getContext('2d');
    let dpr = 1, s = 1, ox = 0, oy = 0;
    const view = { x0: 0, y0: 0, x1: W, y1: H };
    function fit() {
      dpr = Math.min(window.devicePixelRatio || 1, 3);
      const cw = canvas.clientWidth || window.innerWidth, ch = canvas.clientHeight || window.innerHeight;
      // reserveBottom: CSS px kept free of gameplay (Safari's floating address bar sits there).
      const usable = Math.max(200, ch - (opts.reserveBottom || 0));
      canvas.width = Math.round(cw * dpr);
      canvas.height = Math.round(ch * dpr);
      s = Math.min(cw / W, usable / H);
      ox = (cw - W * s) / 2;
      oy = (usable - H * s) / 2;
      view.x0 = -ox / s; view.y0 = -oy / s; view.x1 = W + ox / s; view.y1 = H + oy / s;
    }
    fit();

    let state = 'ready'; // ready -> play -> over -> stopped
    let score = 0, simT = 0, acc = 0, last = 0, raf = 0, ghostT = 0, overT = 0;
    const api = {
      W, H, view,
      rng: mulberry32(opts.seed >>> 0),
      me: opts.me, opp: opts.opp || null,
      score(n) {
        n = n | 0;
        if (n !== score && state === 'play') { score = n; opts.onScore && opts.onScore(n); }
      },
      over() {
        if (state !== 'play') return;
        state = 'over';
        sendGhost();
        opts.onOver && opts.onOver(score);
      },
      draw, has,
      t: () => simT,
      // Versus games: send a message to the other phone's copy of this game (arrives in
      // its receive(type, data)). Only while playing.
      send(type, data) { if (state === 'play' && opts.onSend) opts.onSend(type, data); },
    };
    const inst = def.init(api);
    function sendGhost() {
      if (inst.ghost && opts.onGhost) {
        try { opts.onGhost(inst.ghost()); } catch (e) { /* ignore */ }
      }
    }

    function frame(ts) {
      raf = requestAnimationFrame(frame);
      const dt = last ? Math.min((ts - last) / 1000, 0.1) : 0;
      last = ts;
      if (state === 'play' || state === 'over') {
        acc += dt;
        while (acc >= STEP) { inst.update(STEP); simT += STEP; acc -= STEP; }
        if (state === 'play') {
          ghostT += dt;
          if (ghostT >= 0.125) { ghostT = 0; sendGhost(); }
        } else {
          overT += dt;
        }
      }
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.clearRect(0, 0, canvas.width, canvas.height);
      g.setTransform(dpr * s, 0, 0, dpr * s, dpr * ox, dpr * oy);
      inst.render(g, opts.getGhost ? opts.getGhost() : null);
    }
    raf = requestAnimationFrame(frame);

    const toLogical = e => {
      const r = canvas.getBoundingClientRect();
      return [(e.clientX - r.left - ox) / s, (e.clientY - r.top - oy) / s];
    };
    let pointer = null;
    function down(e) {
      e.preventDefault();
      if (state !== 'play' || pointer !== null) return;
      pointer = e.pointerId;
      const [x, y] = toLogical(e);
      inst.down && inst.down(x, y);
    }
    function up(e) {
      if (e.pointerId !== pointer) return;
      pointer = null;
      if (state !== 'play') return;
      const [x, y] = toLogical(e);
      inst.up && inst.up(x, y);
    }
    function move(e) {
      if (e.pointerId !== pointer || state !== 'play') return;
      const [x, y] = toLogical(e);
      inst.move && inst.move(x, y);
    }
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', up);
    window.addEventListener('resize', fit);

    return {
      go() { if (state === 'ready') { state = 'play'; last = 0; acc = 0; } },
      end() { // forced end, e.g. the app went to the background
        if (state === 'play') { state = 'over'; sendGhost(); opts.onOver && opts.onOver(score); }
      },
      receive(type, data) { if (state === 'play' && inst.receive) inst.receive(type, data); },
      stop() {
        state = 'stopped';
        cancelAnimationFrame(raf);
        canvas.removeEventListener('pointerdown', down);
        canvas.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        window.removeEventListener('pointercancel', up);
        window.removeEventListener('resize', fit);
      },
      get state() { return state; },
      get score() { return score; },
      get time() { return simT; },
      get overFor() { return overT; },
    };
  }

  root.Arcade = { W, H, register, games, order, run, loadSprites, sprites, has, draw, mulberry32 };
})(window);
