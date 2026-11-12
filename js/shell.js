/* Pocket Arcade app: who's playing, lobby, invites, head-to-head matches and results. */
(function () {
  'use strict';

  const STYLE = window.ARCADE_STYLE || 'clay';
  const PLAYERS = { Jacob: 'blue', Laura: 'pink' };
  const GAMES = ['blocks', 'fort', 'plane', 'flip', 'stack', 'keepup'];
  const FEATURED = ['blocks', 'fort'];
  const TINT = { blocks: '#3a3170', fort: '#bfe3ff', plane: '#e4efff', flip: '#ffe6d1', stack: '#fff0c2', keepup: '#d6f2ff' };

  const $ = s => document.querySelector(s);
  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const store = {
    get(k, d) { try { const v = localStorage.getItem('pa.' + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('pa.' + k, JSON.stringify(v)); } catch (e) { /* private mode */ } },
  };
  const rid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  const rseed = () => (Math.random() * 4294967296) >>> 0;
  const day = () => { const d = new Date(); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); };
  const gameName = id => (Arcade.games[id] ? Arcade.games[id].name : id);

  // ---------- Safari vs. home-screen app. In a Safari tab the address bar floats over the
  // bottom of the page, so keep gameplay clear of it; from the home screen there's no bar.
  const standalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const RESERVE = !standalone && isIOS ? 76 : 0;
  document.documentElement.style.setProperty('--reserve', RESERVE + 'px');

  // ---------- who am I (?as=Laura overrides for this tab only, for testing)
  const qs = new URLSearchParams(location.search);
  let me = null;
  if (PLAYERS[qs.get('as')]) { me = qs.get('as'); sessionStorage.setItem('pa.as', me); }
  else me = sessionStorage.getItem('pa.as') || store.get('me', null);
  if (!PLAYERS[me]) me = null;
  const other = () => (me === 'Jacob' ? 'Laura' : 'Jacob');
  const colorOf = n => PLAYERS[n];

  // ---------- records, kept on both phones and merged by max
  let bests = store.get('bests', {});  // game -> {Jacob: n, Laura: n}
  let tally = store.get('tally', {});  // day -> {Jacob: wins, Laura: wins}
  function mergeRecords(b, t) {
    let changed = false;
    const into = (dst, src) => {
      for (const [k, v] of Object.entries(src || {})) {
        const d = dst[k] = dst[k] || {};
        for (const [n, s] of Object.entries(v || {})) {
          if (PLAYERS[n] && Number.isFinite(s) && s > (d[n] || 0)) { d[n] = s; changed = true; }
        }
      }
    };
    into(bests, b);
    into(tally, t);
    if (changed) { store.set('bests', bests); store.set('tally', tally); }
    return changed;
  }

  // ---------- screens and overlays
  let screen = null;
  function show(name) {
    screen = name;
    for (const s of document.querySelectorAll('.screen')) s.classList.toggle('on', s.id === name);
    document.body.dataset.screen = name;
  }
  function overlay(id, on) { $('#' + id).classList.toggle('on', on); }
  let toastTimer = 0;
  function toast(text) {
    const t = $('#toast');
    t.textContent = text;
    t.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('on'), 2600);
  }
  function bump(sel) {
    const e = $(sel);
    e.classList.remove('bump');
    void e.offsetWidth;
    e.classList.add('bump');
  }

  let lock = null;
  async function wake(on) {
    try {
      if (on && !lock && navigator.wakeLock) {
        lock = await navigator.wakeLock.request('screen');
        lock.addEventListener('release', () => { lock = null; });
      } else if (!on && lock) {
        const l = lock; lock = null; await l.release();
      }
    } catch (e) { /* not supported */ }
  }

  // ---------- who's playing
  function renderWho() {
    for (const b of document.querySelectorAll('.who-btn')) {
      const img = b.querySelector('img');
      img.src = 'assets/' + STYLE + '/plane_' + colorOf(b.dataset.name) + '.png';
      img.onerror = () => { img.style.visibility = 'hidden'; };
      b.onclick = () => {
        me = b.dataset.name;
        store.set('me', me);
        sessionStorage.removeItem('pa.as');
        location.replace(location.pathname);
      };
    }
  }

  // ---------- lobby
  let peers = {};
  function renderTally(box) {
    const t = tally[day()] || {};
    box.textContent = '';
    box.append(el('span', 'tl', 'Today'),
      el('span', 'tn blue', 'Jacob ' + (t.Jacob || 0)),
      el('span', 'tn pink', 'Laura ' + (t.Laura || 0)));
  }
  function renderLobby() {
    $('#me-name').textContent = me;
    $('#me-chip').className = 'me-chip ' + colorOf(me);
    const p = peers[other()];
    const peer = $('#peer');
    peer.className = 'peer ' + (!p ? 'away' : p.status === 'playing' ? 'busy' : 'here');
    peer.querySelector('.txt').textContent = !p ? other() + ' is away'
      : p.status === 'playing' && p.game ? other() + ' is playing ' + gameName(p.game)
      : other() + ' is here';
    renderTally($('#tally'));
    $('#a2hs').hidden = !(isIOS && !standalone) || store.get('a2hsHidden', false);
    const grid = $('#games');
    grid.textContent = '';
    for (const id of GAMES) {
      const def = Arcade.games[id];
      if (!def) continue;
      const card = el('button', 'card' + (FEATURED.includes(id) ? ' featured' : ''));
      card.style.setProperty('--tint', TINT[id]);
      const art = el('div', 'art');
      const img = new Image();
      img.alt = '';
      img.src = 'assets/' + STYLE + '/thumb_' + id + '.png';
      img.onerror = () => img.remove();
      art.appendChild(img);
      card.append(art, el('div', 'name', def.name), el('div', 'blurb', def.blurb));
      const b = bests[id] || {};
      const row = el('div', 'bests');
      const lead = (b.Jacob || 0) === (b.Laura || 0) ? null : (b.Jacob || 0) > (b.Laura || 0) ? 'Jacob' : 'Laura';
      for (const n of ['Jacob', 'Laura']) {
        const chip = el('span', 'best ' + colorOf(n) + (lead === n ? ' lead' : ''));
        chip.append(el('span', 'who', n), el('b', null, String(b[n] || 0)));
        row.appendChild(chip);
      }
      card.appendChild(el('div', 'best-label', 'Best'));
      card.appendChild(row);
      card.onclick = () => openSheet(id);
      grid.appendChild(card);
      if (id === FEATURED[FEATURED.length - 1]) grid.appendChild(el('div', 'more', 'More games'));
    }
  }
  function toLobby() {
    if (runner) { runner.stop(); runner = null; }
    match = null;
    wake(false);
    show('lobby');
    renderLobby();
    Net.setState({ status: 'lobby', game: null });
  }

  // ---------- pick a game
  let sheetGame = null;
  function openSheet(id) {
    sheetGame = id;
    $('#sheet-title').textContent = gameName(id);
    $('#sheet-blurb').textContent = Arcade.games[id].blurb;
    const here = !!peers[other()];
    const duo = $('#btn-duo');
    duo.textContent = 'Play with ' + other();
    duo.disabled = !here;
    $('#duo-note').textContent = here ? '' : other() + " isn't here right now.";
    overlay('sheet', true);
  }
  $('#btn-duo').onclick = () => sheetGame && invite(sheetGame);
  $('#btn-solo').onclick = () => {
    overlay('sheet', false);
    startMatch({ id: rid(), game: sheetGame, seed: rseed(), mode: 'solo' });
  };
  $('#btn-sheet-close').onclick = () => overlay('sheet', false);
  $('#sheet').onclick = e => { if (e.target.id === 'sheet') overlay('sheet', false); };

  // ---------- invites
  let pending = null;   // my invite, waiting for an answer
  let incoming = null;  // their invite, on screen
  function clearPending() {
    if (pending) clearTimeout(pending.timer);
    pending = null;
    overlay('waiting', false);
  }
  function invite(game) {
    overlay('sheet', false);
    if (!peers[other()]) { toast(other() + " isn't here right now."); return; }
    const inv = { id: rid(), game, seed: rseed() };
    Net.send('invite', inv);
    pending = Object.assign({}, inv);
    $('#wait-text').textContent = 'Waiting for ' + other() + '…';
    $('#wait-sub').textContent = gameName(game);
    overlay('waiting', true);
    pending.timer = setTimeout(() => {
      if (pending && pending.id === inv.id) {
        Net.send('cancel', { id: inv.id });
        clearPending();
        toast(other() + " didn't answer.");
      }
    }, 30000);
  }
  $('#btn-wait-cancel').onclick = () => {
    if (pending) Net.send('cancel', { id: pending.id });
    clearPending();
  };
  function accept(inv) {
    if (incoming) clearTimeout(incoming.timer);
    incoming = null;
    overlay('invite', false);
    overlay('sheet', false);
    Net.send('answer', { id: inv.id, ok: true });
    startMatch({ id: inv.id, game: inv.game, seed: inv.seed, mode: 'duo' });
  }
  $('#btn-accept').onclick = () => { if (incoming) accept(incoming); };
  $('#btn-decline').onclick = () => {
    if (incoming) {
      Net.send('answer', { id: incoming.id, ok: false, why: 'no' });
      clearTimeout(incoming.timer);
      incoming = null;
    }
    overlay('invite', false);
  };
  Net.on('invite', inv => {
    if (!Arcade.games[inv.game]) return;
    if (match && !match.resolved) { Net.send('answer', { id: inv.id, ok: false, why: 'busy' }); return; }
    if (pending) {
      // We both asked at the same moment. Both phones keep the invite with the lower id.
      if (inv.id < pending.id) { clearPending(); accept(inv); }
      return;
    }
    if (incoming) clearTimeout(incoming.timer);
    incoming = { id: inv.id, game: inv.game, seed: inv.seed };
    const rematch = screen === 'results' && lastGame === inv.game;
    $('#invite-text').textContent = rematch ? other() + ' wants a rematch.' : other() + ' wants to play ' + gameName(inv.game) + '.';
    overlay('invite', true);
    incoming.timer = setTimeout(() => {
      if (incoming && incoming.id === inv.id) { incoming = null; overlay('invite', false); }
    }, 30000);
  });
  Net.on('answer', a => {
    if (!pending || a.id !== pending.id) return;
    const p = pending;
    clearPending();
    if (a.ok) startMatch({ id: p.id, game: p.game, seed: p.seed, mode: 'duo' });
    else toast(a.why === 'busy' ? other() + ' is in a game.' : other() + " can't play right now.");
  });
  Net.on('cancel', c => {
    if (incoming && c.id === incoming.id) {
      clearTimeout(incoming.timer);
      incoming = null;
      overlay('invite', false);
    }
    if (match && match.id === c.id) oppGone();
  });

  // ---------- matches
  const canvas = $('#game');
  let match = null, runner = null, lastGame = null, cdTimer = 0;
  let spritesReady = Arcade.loadSprites('assets/', STYLE).catch(() => {});

  function countdown(n, done) {
    const c = $('#countdown');
    clearTimeout(cdTimer);
    const step = k => {
      c.textContent = k > 0 ? String(k) : 'Go';
      c.classList.remove('pop');
      void c.offsetWidth;
      c.classList.add('pop');
      if (k > 0) cdTimer = setTimeout(() => step(k - 1), 700);
      else done();
    };
    step(n);
  }

  async function startMatch(m) {
    if (runner) { runner.stop(); runner = null; }
    match = Object.assign({
      my: 0, myDone: false, opp: 0, oppDone: m.mode === 'solo', oppLeft: false,
      oppGhost: null, oppSeen: Date.now(), started: false, resolved: false,
    }, m);
    lastGame = m.game;
    const id = m.id, duo = m.mode === 'duo';
    show('play');
    Net.setState({ status: 'playing', game: m.game });
    $('#my-score').textContent = '0';
    $('#out').classList.remove('on');
    $('#quit').classList.remove('armed');
    $('#countdown').textContent = '';
    updateHud();
    wake(true);
    await Promise.race([spritesReady, new Promise(r => setTimeout(r, 2500))]);
    if (!match || match.id !== id) return;
    runner = Arcade.run({
      canvas, game: m.game, seed: m.seed, reserveBottom: RESERVE,
      me: { name: me, color: colorOf(me) },
      opp: duo ? { name: other(), color: colorOf(other()) } : null,
      onScore: n => {
        if (!match || match.id !== id) return;
        match.my = n;
        $('#my-score').textContent = n;
        bump('#my-score');
        updateHud();
      },
      onGhost: gh => {
        if (duo && match && match.id === id) Net.send('tick', { id, s: match.my, g: gh });
      },
      onSend: (k, d) => {
        if (duo && match && match.id === id) Net.send('gx', { id, k, d });
      },
      onOver: n => runOver(id, n),
      getGhost: () => (duo && match && match.id === id ? match.oppGhost : null),
    });
    countdown(duo ? 3 : 2, () => {
      if (!match || match.id !== id || !runner || match.myDone) return;
      runner.go();
      match.started = true;
      match.oppSeen = Date.now();
    });
  }

  function runOver(id, n) {
    if (!match || match.id !== id || match.myDone) return;
    match.my = n;
    match.myDone = true;
    // own: my run ended by itself (topped out, crashed, quit). In a versus game the
    // survivor's run is ended for them when the other player goes out, so own is false.
    match.myOwn = !match.forcedEnd;
    match.myAt = runner ? runner.time : 0;
    if (match.mode === 'duo') {
      // Say "done" a few times: a broadcast can get lost while a phone reconnects.
      const msg = { id, s: n, at: match.myAt, own: match.myOwn };
      Net.send('done', msg);
      let sends = 0;
      const timer = setInterval(() => {
        if (++sends > 8 || !match || match.id !== id) { clearInterval(timer); return; }
        Net.send('done', msg);
      }, 1200);
    }
    updateHud();
    if (!match.oppDone) $('#out').classList.add('on');
    maybeFinish();
  }

  function maybeFinish() {
    if (!match || match.resolved || !match.myDone || !match.oppDone) return;
    match.resolved = true;
    const id = match.id;
    setTimeout(() => { if (match && match.id === id) results(); }, 1100);
  }

  function updateHud() {
    if (!match) return;
    const duo = match.mode === 'duo';
    const chip = $('#opp');
    if (duo) {
      chip.className = 'opp ' + colorOf(other()) + (match.oppDone ? ' done' : '');
      $('#opp-name').textContent = other();
      $('#opp-score').textContent = match.oppLeft ? '–' : match.opp;
      $('#opp-tag').textContent = match.oppLeft ? 'left' : match.oppDone ? 'out' : '';
    } else {
      chip.className = 'opp solo';
      $('#opp-name').textContent = 'Best';
      $('#opp-score').textContent = (bests[match.game] || {})[me] || 0;
      $('#opp-tag').textContent = '';
    }
    const target = $('#target');
    if (duo && match.oppDone && !match.oppLeft && !match.myDone && !isVersus()) {
      target.textContent = match.my > match.opp ? 'In the lead' : 'Beat ' + match.opp;
      target.classList.add('on');
    } else {
      target.classList.remove('on');
    }
    if (duo && match.myDone && !match.oppDone) {
      $('#out-me').textContent = "You're out at " + match.my + '.';
      $('#out-opp').textContent = other() + ' is still going: ' + match.opp;
    }
  }

  Net.on('tick', tk => {
    if (!match || tk.id !== match.id || match.oppDone) return;
    match.opp = tk.s | 0;
    match.oppGhost = tk.g || null;
    match.oppSeen = Date.now();
    updateHud();
  });
  Net.on('done', d => {
    if (!match || d.id !== match.id) return;
    match.opp = d.s | 0;
    match.oppAt = d.at;
    match.oppOwn = d.own !== false;
    if (!match.oppDone) {
      match.oppDone = true;
      $('#out').classList.remove('on');
      updateHud();
      // Last one standing: the other player is out, so my run ends here and I win.
      if (isVersus() && !match.myDone) {
        match.forcedEnd = true;
        if (runner && runner.state === 'play') runner.end();
        else runOver(match.id, match.my);
      }
      maybeFinish();
    }
  });
  Net.on('gx', m => {
    if (match && runner && m.id === match.id) runner.receive(m.k, m.d || {});
  });
  function isVersus() {
    return !!(match && match.mode === 'duo' && Arcade.games[match.game] && Arcade.games[match.game].versus);
  }
  // Versus winner, worked out the same way on both phones.
  function versusOutcome(m) {
    if (m.oppLeft) return 'left';
    const meOwn = m.myOwn !== false, oppOwn = m.oppOwn !== false;
    if (meOwn && !oppOwn) return 'lose';
    if (!meOwn && oppOwn) return 'win';
    // Both went out on their own at nearly the same moment: earlier one loses.
    if (Number.isFinite(m.myAt) && Number.isFinite(m.oppAt) && Math.abs(m.myAt - m.oppAt) > 0.25) {
      return m.myAt < m.oppAt ? 'lose' : 'win';
    }
    return m.my > m.opp ? 'win' : m.my < m.opp ? 'lose' : 'tie';
  }
  // The other player left mid-match (canceled, or their phone went quiet).
  function oppGone() {
    if (!match || match.oppDone) return;
    match.oppDone = true;
    match.oppLeft = true;
    $('#out').classList.remove('on');
    updateHud();
    if (isVersus() && !match.myDone) {
      match.forcedEnd = true;
      if (runner && runner.state === 'play') runner.end();
      else runOver(match.id, match.my);
    }
    maybeFinish();
  }
  // If the other phone goes quiet mid-run (locked, lost signal), stop waiting for it.
  setInterval(() => {
    if (match && match.mode === 'duo' && match.started && !match.oppDone && Date.now() - match.oppSeen > 7000) oppGone();
  }, 1000);

  function fillCol(box, name, score, isNew) {
    box.className = 'res-col ' + colorOf(name);
    box.querySelector('.n').textContent = name === me ? 'You' : name;
    box.querySelector('.s').textContent = score;
    box.querySelector('.badge').hidden = !isNew;
  }

  function results() {
    wake(false);
    const m = match, duo = m.mode === 'duo';
    const b = bests[m.game] = bests[m.game] || {};
    const newMe = m.my > 0 && m.my > (b[me] || 0);
    if (newMe) b[me] = m.my;
    const newOpp = duo && !m.oppLeft && m.opp > 0 && m.opp > (b[other()] || 0);
    if (newOpp) b[other()] = m.opp;
    let title, outcome = 'solo';
    if (duo) {
      const t = tally[day()] = tally[day()] || {};
      outcome = isVersus() ? versusOutcome(m)
        : m.oppLeft ? 'left' : m.my > m.opp ? 'win' : m.my < m.opp ? 'lose' : 'tie';
      if (outcome === 'left') title = other() + ' left the game';
      else if (outcome === 'win') { title = 'You win!'; t[me] = (t[me] || 0) + 1; }
      else if (outcome === 'lose') { title = other() + ' wins'; t[other()] = (t[other()] || 0) + 1; }
      else title = 'Tie';
    } else {
      title = newMe ? 'New best!' : 'Game over';
    }
    store.set('bests', bests);
    store.set('tally', tally);
    Net.send('hello', { bests, tally, ask: false });

    $('#res-game').textContent = gameName(m.game);
    $('#res-title').textContent = title;
    $('#results').dataset.outcome = outcome;
    // Versus rounds go to the last one standing, so say why when the scores look odd.
    let why = '';
    if (duo && isVersus()) {
      if (m.quit) why = 'You quit the round.';
      else if (outcome === 'win') why = other() + "'s blocks reached the top first.";
      else if (outcome === 'lose') why = 'Your blocks reached the top first.';
      else if (outcome === 'tie') why = 'You both reached the top at the same time.';
    }
    $('#res-why').textContent = why;
    fillCol($('#res-me'), me, m.my, newMe);
    $('#res-opp').hidden = !duo;
    if (duo) fillCol($('#res-opp'), other(), m.oppLeft ? '–' : m.opp, newOpp);
    $('#res-best').textContent = duo ? '' : 'Your best: ' + (b[me] || 0);
    renderTally($('#res-tally'));
    $('#res-tally').hidden = !duo;
    $('#btn-again').textContent = duo ? 'Rematch' : 'Play again';
    $('#out').classList.remove('on');
    if (runner) { runner.stop(); runner = null; }
    show('results');
    Net.setState({ status: 'lobby', game: null });
  }

  $('#btn-again').onclick = () => {
    if (!match) return toLobby();
    if (match.mode === 'solo') startMatch({ id: rid(), game: match.game, seed: rseed(), mode: 'solo' });
    else invite(match.game);
  };
  $('#btn-lobby').onclick = () => toLobby();

  // Quit takes two taps so a stray tap can't end a run.
  $('#quit').onclick = () => {
    const q = $('#quit');
    if (!q.classList.contains('armed')) {
      q.classList.add('armed');
      setTimeout(() => q.classList.remove('armed'), 2000);
      return;
    }
    q.classList.remove('armed');
    if (!match || match.mode === 'solo' || match.myDone) return toLobby();
    match.quit = true;
    if (runner && runner.state === 'play') runner.end();
    else runOver(match.id, 0);
  };

  // Leaving the app mid-run ends the run (both players see the same course, so no pausing).
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      if (match && !match.myDone) {
        if (runner && runner.state === 'play') runner.end();
        else if (match.mode === 'solo') toLobby();
        else runOver(match.id, 0);
      }
    } else if (screen === 'play') {
      wake(true);
    }
  });

  // ---------- presence and record sync
  Net.on('peers', p => {
    const was = !!peers[other()];
    peers = p;
    const now = !!peers[other()];
    if (now && !was && screen === 'lobby') toast(other() + ' is here.');
    if (!now && pending) { clearPending(); toast(other() + ' left.'); }
    if (screen === 'lobby') renderLobby();
    if ($('#sheet').classList.contains('on') && sheetGame) openSheet(sheetGame);
  });
  Net.on('online', on => {
    $('#conn').classList.toggle('on', !on);
    if (on) Net.send('hello', { bests, tally, ask: true });
  });
  Net.on('hello', h => {
    const changed = mergeRecords(h.bests, h.tally);
    if (h.ask) Net.send('hello', { bests, tally, ask: false });
    if (changed && screen === 'lobby') renderLobby();
  });

  $('#a2hs-close').onclick = () => { store.set('a2hsHidden', true); $('#a2hs').hidden = true; };

  // ---------- updates: tools/deploy.sh stamps version.json; offer a reload in the lobby
  let newVersion = null;
  async function checkVersion() {
    if (newVersion || !window.ARCADE_VERSION) return;
    try {
      const r = await fetch('version.json?t=' + Date.now(), { cache: 'no-store' });
      const v = (await r.json()).v;
      if (v && v !== window.ARCADE_VERSION) {
        newVersion = v;
        $('#update').hidden = false;
      }
    } catch (e) { /* offline */ }
  }
  $('#update').onclick = () => {
    if (match && !match.resolved) return;
    location.replace(location.pathname + '?v=' + newVersion);
  };
  setInterval(checkVersion, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) checkVersion(); });
  setTimeout(checkVersion, 5000);

  $('#me-chip').onclick = () => {
    const chip = $('#me-chip');
    if (!chip.classList.contains('armed')) {
      chip.classList.add('armed');
      $('#me-name').textContent = 'Switch player?';
      setTimeout(() => { chip.classList.remove('armed'); $('#me-name').textContent = me; }, 2500);
      return;
    }
    store.set('me', null);
    sessionStorage.removeItem('pa.as');
    location.replace(location.pathname);
  };

  // ---------- boot
  document.body.classList.add('me-' + (me ? colorOf(me) : 'none'));
  if (!me) {
    renderWho();
    show('who');
  } else {
    show('lobby');
    renderLobby();
    Net.start(me, { status: 'lobby', game: null, color: colorOf(me) });
  }
  // Long-press on iOS can pop the text magnifier; stop it on the game surface.
  canvas.addEventListener('touchstart', e => e.preventDefault(), { passive: false });
  window.PA = { get match() { return match; }, get peers() { return peers; }, get me() { return me; } };
})();
