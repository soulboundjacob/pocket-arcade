/* Live sync over Supabase Realtime: presence (who's here) and broadcast messages.
 * No database tables: every message is a broadcast on one channel, and all state
 * lives on the two phones. */
(function () {
  'use strict';
  const cfg = window.ARCADE_CONFIG;
  const handlers = {};
  let client = null, channel = null, me = null, myState = {};
  let joined = false, lastJoinedAt = 0, connectAt = 0;

  // ?room=test keeps dev and test sessions out of the real room.
  function room() {
    const extra = new URLSearchParams(location.search).get('room');
    return extra ? cfg.room + '-' + extra.replace(/[^a-z0-9]/gi, '') : cfg.room;
  }

  function emit(type, payload) {
    (handlers[type] || []).forEach(fn => { try { fn(payload); } catch (e) { console.error(e); } });
  }

  function track() {
    if (joined && channel) channel.track(Object.assign({}, myState, { name: me, at: Date.now() })).catch(() => {});
  }

  function peersFromPresence() {
    const st = channel ? channel.presenceState() : {};
    const peers = {};
    for (const [key, metas] of Object.entries(st)) {
      if (key === me || !metas.length) continue;
      peers[key] = metas[metas.length - 1];
    }
    return peers;
  }

  function connect() {
    if (channel) { try { client.removeChannel(channel); } catch (e) { /* ignore */ } }
    joined = false;
    connectAt = Date.now();
    const ch = client.channel(room(), {
      config: { broadcast: { self: false, ack: false }, presence: { key: me } },
    });
    channel = ch;
    ch.on('presence', { event: 'sync' }, () => { if (ch === channel) emit('peers', peersFromPresence()); });
    ch.on('broadcast', { event: 'msg' }, ({ payload }) => {
      if (ch !== channel || !payload || payload.from === me) return;
      emit(payload.t, payload);
    });
    ch.subscribe(status => {
      if (ch !== channel) return;
      if (status === 'SUBSCRIBED') {
        joined = true;
        lastJoinedAt = Date.now();
        track();
        emit('online', true);
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        joined = false;
        emit('online', false);
      }
    });
  }

  // Phones drop sockets when the screen locks. Rejoin when we come back or stall.
  function watchdog() {
    if (!client) return;
    if (!joined && Date.now() - connectAt > 8000) connect();
  }

  window.Net = {
    start(name, state) {
      me = name;
      myState = state || {};
      client = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey, {
        auth: { persistSession: false, autoRefreshToken: false },
        realtime: { params: { eventsPerSecond: 40 } },
      });
      connect();
      setInterval(watchdog, 2000);
      document.addEventListener('visibilitychange', () => {
        if (!document.hidden && client && !joined) connect();
      });
    },
    on(type, fn) { (handlers[type] = handlers[type] || []).push(fn); },
    send(t, payload) {
      if (!channel) return;
      channel.send({ type: 'broadcast', event: 'msg', payload: Object.assign({ t, from: me }, payload) }).catch(() => {});
    },
    setState(state) { myState = Object.assign({}, myState, state); track(); },
    get online() { return joined; },
    get peers() { return channel ? peersFromPresence() : {}; },
  };
})();
