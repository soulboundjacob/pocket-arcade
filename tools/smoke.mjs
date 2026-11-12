// Headless smoke test for one mini-game: node tools/smoke.mjs <id> [seconds] [runs]
// Runs the game with random taps against a fake canvas, checks for exceptions,
// non-finite ghost values and that score()/over() behave.
import fs from 'node:fs';
import vm from 'node:vm';

const id = process.argv[2];
const seconds = +(process.argv[3] || 120);
const runs = +(process.argv[4] || 5);
if (!id) { console.error('usage: node tools/smoke.mjs <id> [seconds] [runs]'); process.exit(2); }

const defs = {};
globalThis.window = globalThis;
globalThis.Arcade = { register: d => { defs[d.id] = d; } };
vm.runInThisContext(fs.readFileSync(new URL(`../js/games/${id}.js`, import.meta.url), 'utf8'));
const def = defs[id];
if (!def) { console.error('game did not register as', id); process.exit(1); }

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
const gradient = { addColorStop: noop };
const g = new Proxy({}, {
  get(t, k) {
    if (k in t) return t[k];
    if (k === 'measureText') return () => ({ width: 10 });
    if (k === 'createLinearGradient' || k === 'createRadialGradient' || k === 'createPattern') return () => gradient;
    if (k === 'getTransform') return () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
    return noop;
  },
  set(t, k, v) { t[k] = v; return true; },
});

let failed = false;
for (let run = 0; run < runs; run++) {
  const seed = 1000 + run * 7919;
  let score = 0, overAt = null, scoreCalls = 0;
  const sent = [];
  const api = {
    W: 360, H: 640, view: { x0: 0, y0: -70, x1: 360, y1: 710 },
    rng: mulberry32(seed),
    me: { name: 'Jacob', color: 'blue' }, opp: { name: 'Laura', color: 'pink' },
    score(n) { if (!Number.isInteger(n)) throw new Error('score not integer: ' + n); score = n; scoreCalls++; },
    over() { if (overAt !== null) throw new Error('over() called twice'); overAt = t; },
    draw: noop, has: () => true, t: () => t,
    send(type, data) { sent.push(type); if (JSON.stringify(data || {}).length > 200) throw new Error('send payload too big'); },
  };
  let t = 0;
  const STEP = 1 / 120;
  const inst = def.init(api);
  const rnd = mulberry32(seed + 1);
  let nextTap = 0.5, holdUntil = -1;
  try {
    for (let i = 0; i < seconds * 120; i++) {
      if (overAt === null) {
        if (holdUntil < 0 && t >= nextTap) {
          inst.down && inst.down(60 + rnd() * 240, 200 + rnd() * 300);
          holdUntil = t + 0.05 + rnd() * 0.7;
        } else if (holdUntil >= 0 && t < holdUntil && inst.move && i % 6 === 0) {
          inst.move(60 + rnd() * 240, 200 + rnd() * 380);
        } else if (holdUntil >= 0 && t >= holdUntil) {
          inst.up && inst.up(180, 400);
          holdUntil = -1;
          nextTap = t + 0.15 + rnd() * 0.6;
        }
      }
      // versus games: throw the other player's attacks at it now and then
      if (def.versus && inst.receive && overAt === null && i % 600 === 300) {
        const kinds = ['junk', 'rush', 'mirror'];
        const k = kinds[(rnd() * kinds.length) | 0];
        inst.receive(k, k === 'junk' ? { n: 1 + ((rnd() * 3) | 0) } : {});
      }
      inst.update(STEP);
      t += STEP;
      if (i % 2 === 0) inst.render(g, { ...(inst.ghost ? inst.ghost() : {}) });
      if (inst.ghost && i % 15 === 0) {
        const gh = inst.ghost();
        const json = JSON.stringify(gh);
        if (json.length > (def.versus ? 400 : 120)) throw new Error('ghost too big: ' + json.length + ' bytes');
        for (const [k, v] of Object.entries(gh || {})) {
          if (typeof v === 'number' && !Number.isFinite(v)) throw new Error('ghost.' + k + ' is ' + v);
        }
      }
      if (overAt !== null && t - overAt > 3) break;
    }
    console.log(`run ${run}: score ${score}, ${overAt === null ? 'still alive' : 'over at ' + overAt.toFixed(1) + 's'}, score() calls ${scoreCalls}${sent.length ? ', sent ' + sent.length + ' (' + [...new Set(sent)].join(',') + ')' : ''}`);
  } catch (e) {
    failed = true;
    console.log(`run ${run}: EXCEPTION at t=${t.toFixed(2)}s: ${e.stack.split('\n').slice(0, 3).join(' | ')}`);
  }
}
process.exit(failed ? 1 : 0);
