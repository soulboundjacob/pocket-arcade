# Pocket Arcade

A phone web game for Jacob and Laura. Featured: Block Duel, a falling-block versus game with power-ups (last one standing wins), Critter Clash, three critters a side on a big destructible island (landscape, camera, Map view) where both players move and aim at the same time, and Puck Duel, real-time air hockey with power-ups (the half holding the puck owns its physics; see the header of `js/games/hockey.js`). Extras: four one-tap high-score games. Every game plays solo or head-to-head on the same seeded course at the same time. Built 2026-11-12. Personal project.

- Live: GitHub Pages from `main` (`https://soulboundjacob.github.io/pocket-arcade/`). Deploy with `tools/deploy.sh "what changed"`: it stamps `version.json` and the `?v=` script URLs (busts phone caches; open pages show an update banner in the lobby), commits and pushes.
- Dev: preview server `pocket-arcade` in `~/Documents/work/.claude/launch.json` (port 4480). `?as=Laura` sets the player for one tab. Always test with `?room=test` (and `ROOM=test` for the bot) so test players never show up in the real room.
- Solo test page: `dev/harness.html?game=plane&style=clay&ghost=1` (ghost=1 replays your own run 0.6 s late).

## Layout
- `index.html` app shell markup and styles. `js/shell.js` players, lobby, invites, matches, results. `js/net.js` live sync.
- `js/engine.js` game contract (header comment), sprites, seeded RNG, fixed 120 Hz runner. World is 360x640 logical units.
- `js/games/*.js` one file per game: `critters` (same-time artillery: deterministic volley sim, host authority via ghosts; `fort` is the earlier Fort Blast take, kept but off the menu), `blocks` (versus: `def.versus`, attacks travel as `api.send` → `gx` broadcast → `receive`), `plane`, `flip`, `stack`, `keepup`.
- `assets/manifest.json` sprite keys and logical sizes. `assets/<style>/` holds the renders for each look (clay, gloss, toon). The live look is `ARCADE_STYLE` in `index.html` (falls back to clay).

## Live sync
Supabase Realtime broadcast + presence on the epa608-study project. No tables, nothing stored server-side. Room name and anon key are in `js/config.js`. Both phones keep bests and the day's win tally in localStorage and merge by max when they meet.

## Art
Real Blender renders only (see the game-art rule in memory): scripts in `tools/art/`, Blender 5.2.3 headless. Never draw game objects in canvas code or emoji.

## Tests
- `node tools/smoke.mjs <game> 120 5` headless random play per game.
- `ROOM=test node tools/bot-game.mjs` opponent that plays the REAL game code with `api.auto` (Critter Clash, Fort Blast) over the network.
- `ROOM=test node tools/bot.mjs` fake Laura that accepts invites and plays a fake run (`node tools/bot.mjs Laura invite flip` also invites you). Needs `npm i` in `tools/`.
