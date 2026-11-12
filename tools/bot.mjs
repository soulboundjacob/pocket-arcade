// Fake opponent for testing live play.
//   node tools/bot.mjs                 joins as Laura, accepts every invite, plays a fake run
//   node tools/bot.mjs Laura invite flip   also sends an invite for that game after joining
// ROOM=test joins the test room the app uses with ?room=test.
// The fake run's score climbs at random and it "dies" after 8-18 s (or BOT_LIFE ms).
import { createClient } from '@supabase/supabase-js';
import fs from 'node:fs';

const cfg = fs.readFileSync(new URL('../js/config.js', import.meta.url), 'utf8');
const pick = k => cfg.match(new RegExp(k + ': "([^"]+)"'))[1];
const [name = 'Laura', mode, game = 'plane'] = process.argv.slice(2);
const color = name === 'Jacob' ? 'blue' : 'pink';

const sb = createClient(pick('supabaseUrl'), pick('supabaseKey'), { auth: { persistSession: false } });
const ch = sb.channel(pick('room') + (process.env.ROOM ? '-' + process.env.ROOM : ''), { config: { broadcast: { self: false }, presence: { key: name } } });
const send = (t, p) => ch.send({ type: 'broadcast', event: 'msg', payload: { t, from: name, ...p } });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

ch.on('presence', { event: 'sync' }, () => log('here:', Object.keys(ch.presenceState()).join(', ')));
ch.on('broadcast', { event: 'msg' }, ({ payload: m }) => {
  if (m.from === name) return;
  if (m.t !== 'tick') log('<-', m.t, JSON.stringify(m).slice(0, 140));
  if (m.t === 'invite') setTimeout(() => { send('answer', { id: m.id, ok: true }); log('-> answer ok'); play(m); }, 900);
  if (m.t === 'answer' && m.ok && pendingInvite && m.id === pendingInvite.id) play(pendingInvite);
  if (m.t === 'hello' && m.ask) send('hello', { bests: {}, tally: {}, ask: false });
  if (m.t === 'done') log('opponent done with', m.s);
});

let pendingInvite = null;
ch.subscribe(async status => {
  log('status', status);
  if (status !== 'SUBSCRIBED') return;
  await ch.track({ name, status: 'lobby', game: null, color, at: Date.now() });
  send('hello', { bests: {}, tally: {}, ask: true });
  if (mode === 'invite') {
    setTimeout(() => {
      pendingInvite = { id: Date.now().toString(36) + 'zz', game, seed: 12345 };
      send('invite', pendingInvite);
      log('-> invite', game);
    }, 2500);
  }
});

function fakeGhost(g, t, alive, score) {
  if (g === 'plane') return { y: Math.round(320 + Math.sin(t * 2) * 110), r: Math.round(Math.cos(t * 2) * 40) / 100, a: alive ? 1 : 0 };
  if (g === 'flip') return { s: score, l: alive ? 3 : 0 };
  if (g === 'stack') return { n: score };
  if (g === 'keepup') return { x: Math.round(180 + Math.sin(t) * 110), y: Math.round(330 + Math.sin(t * 3) * 160), a: alive ? 1 : 0 };
  return {};
}

function play(inv) {
  ch.track({ name, status: 'playing', game: inv.game, color, at: Date.now() });
  const life = +(process.env.BOT_LIFE || 8000 + Math.random() * 10000);
  const start = Date.now() + (3 * 700); // the app's 3-2-1 countdown
  let score = 0;
  log('playing', inv.game, 'for', Math.round(life / 1000), 's');
  const iv = setInterval(() => {
    const t = (Date.now() - start) / 1000;
    if (t < 0) return;
    const alive = Date.now() - start < life;
    if (alive && Math.random() < 0.1) score++;
    send('tick', { id: inv.id, s: score, g: fakeGhost(inv.game, t, alive, score) });
    if (!alive) {
      clearInterval(iv);
      for (let i = 0; i < 3; i++) setTimeout(() => send('done', { id: inv.id, s: score }), i * 1000);
      ch.track({ name, status: 'lobby', game: null, color, at: Date.now() });
      log('bot done with', score);
    }
  }, 125);
}
