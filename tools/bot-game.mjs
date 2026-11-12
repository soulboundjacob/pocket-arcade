// Test opponent that plays the REAL game code over the network, with api.auto on.
//   ROOM=test node tools/bot-game.mjs [Laura]
// Accepts every invite, runs the game headless at 120 Hz and talks the app's protocol:
// presence, invite/answer, tick (score + ghost), gx (game messages) and done.
import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';
import vm from 'node:vm';

const root = new URL('..', import.meta.url);
const cfg = fs.readFileSync(new URL('js/config.js', root), 'utf8');
const pick = k => cfg.match(new RegExp(k + ': "([^"]+)"'))[1];
const name = process.argv[2] || 'Laura';
const other = name === 'Jacob' ? 'Laura' : 'Jacob';
const COLOR = { Jacob: 'blue', Laura: 'pink' };
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// Load every game file the way the browser does.
const defs = {};
globalThis.window = globalThis;
globalThis.Arcade = { register: d => { defs[d.id] = d; } };
const gamesDir = new URL('js/games/', root);
for (const f of fs.readdirSync(gamesDir)) if (f.endsWith('.js')) vm.runInThisContext(fs.readFileSync(new URL(f, gamesDir), 'utf8'));

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const noop = () => {};
const g2d = new Proxy({}, {
  get(t, k) {
    if (k in t) return t[k];
    if (k === 'measureText') return () => ({ width: 10 });
    if (/^create(Linear|Radial)Gradient$|^createPattern$/.test(k)) return () => ({ addColorStop: noop });
    return noop;
  },
  set(t, k, v) { t[k] = v; return true; },
});

const sb = createClient(pick('supabaseUrl'), pick('supabaseKey'), { auth: { persistSession: false } });
const ch = sb.channel(pick('room') + (process.env.ROOM ? '-' + process.env.ROOM : ''), { config: { broadcast: { self: false }, presence: { key: name } } });
const send = (t, p) => ch.send({ type: 'broadcast', event: 'msg', payload: { t, from: name, ...p } });

let game = null; // the match being played

ch.on('presence', { event: 'sync' }, () => log('here:', Object.keys(ch.presenceState()).join(', ')));
ch.on('broadcast', { event: 'msg' }, ({ payload: m }) => {
  if (m.from === name) return;
  if (m.t === 'invite') {
    if (game) { send('answer', { id: m.id, ok: false, why: 'busy' }); return; }
    if (!defs[m.game]) { log('no such game', m.game); return; }
    send('answer', { id: m.id, ok: true });
    play(m);
  } else if (m.t === 'hello' && m.ask) {
    send('hello', { bests: {}, tally: {}, ask: false });
  } else if (game && m.id === game.id) {
    if (m.t === 'tick') game.peer = m.g || null;
    else if (m.t === 'gx') game.inst.receive && game.inst.receive(m.k, m.d || {});
    else if (m.t === 'done') {
      log('opponent done with', m.s);
      if (defs[game.def].versus && !game.over) game.finish(false);
    }
  }
});
ch.subscribe(async status => {
  log('status', status);
  if (status === 'SUBSCRIBED') {
    await ch.track({ name, status: 'lobby', game: null, color: COLOR[name], at: Date.now() });
    send('hello', { bests: {}, tally: {}, ask: true });
  }
});

function play(inv) {
  const def = defs[inv.game];
  const g = game = { id: inv.id, def: inv.game, peer: null, over: false, score: 0, t: 0 };
  ch.track({ name, status: 'playing', game: inv.game, color: COLOR[name], at: Date.now() });
  const api = {
    W: 360, H: 640, view: { x0: 0, y0: -80, x1: 360, y1: 720 },
    rng: mulberry32(inv.seed >>> 0),
    me: { name, color: COLOR[name] }, opp: { name: other, color: COLOR[other] },
    score(n) { g.score = n | 0; },
    over() { if (!g.over) g.finish(true); },
    draw: noop, has: () => true, t: () => g.t,
    send(k, d) { if (!g.over) send('gx', { id: g.id, k, d }); },
    peer: () => g.peer,
    auto: true,
  };
  g.inst = def.init(api);
  log('playing', inv.game);
  g.finish = own => {
    g.over = true;
    const done = { id: g.id, s: g.score, at: g.t, own };
    for (let i = 0; i < 4; i++) setTimeout(() => send('done', done), i * 1000);
    log('done with', g.score, own ? '' : '(ended by the other player)');
    setTimeout(() => {
      clearInterval(g.loop);
      if (game === g) game = null;
      ch.track({ name, status: 'lobby', game: null, color: COLOR[name], at: Date.now() });
    }, 2500);
  };
  const STEP = 1 / 120;
  let last = 0, acc = 0, tickAcc = 0, renderAcc = 0;
  setTimeout(() => { // the app's 3-2-1 countdown
    last = performance.now();
    g.loop = setInterval(() => {
      const now = performance.now();
      const dt = Math.min(0.1, (now - last) / 1000);
      last = now;
      acc += dt; tickAcc += dt; renderAcc += dt;
      while (acc >= STEP) { g.inst.update(STEP); g.t += STEP; acc -= STEP; }
      if (renderAcc >= 0.1) { renderAcc = 0; g.inst.render(g2d, g.peer); }
      if (tickAcc >= 0.125 && !g.over) {
        tickAcc = 0;
        send('tick', { id: g.id, s: g.score, g: g.inst.ghost ? g.inst.ghost() : null });
      }
    }, 8);
  }, 2100);
}
