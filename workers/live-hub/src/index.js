/**
 * soard-live-hub — real-time hub for the live broadcast system
 * ==============================================================
 * One Durable Object ("main") does three jobs:
 *
 *  1. Fan-out. Site visitors and the admin open a WebSocket (proxied through
 *     the Pages Function /api/live-ws). Every state change is pushed to all of
 *     them within milliseconds, so the LIVE pill and the live page react the
 *     moment the phone connects, without polling.
 *
 *  2. Heartbeat. An alarm fires every few seconds (fast while a broadcast is
 *     armed or live, slow when idle) and calls the site's
 *     POST /api/broadcast-hooks. There is no shared secret: each call carries a
 *     one-time nonce, and the site verifies it by asking this object over the
 *     private binding (POST /verify), which only the Pages project can reach.
 *     The Pages Function owns
 *     the state machine, D1 and every side effect (Stream, Facebook, email,
 *     SMS, push, alerts); it returns the public state, and the hub broadcasts
 *     it if anything changed. This is also the backstop if a Cloudflare
 *     Notification webhook is lost: the tick polls Stream's lifecycle endpoint.
 *
 *  3. Snapshot. The last public state is stored, so a new socket gets the
 *     current state instantly on connect.
 *
 *  4. Watch party. Live pages send {"t":"watch"} so they count as viewers
 *     (every page on the site holds a socket for the LIVE pill, so plain
 *     connections are not viewers). Viewers get the viewer count, each
 *     other's reactions ({"t":"react","k":"heart"}, batched every 400 ms and
 *     rate limited per socket) and messages for the family, which the Pages
 *     Function screens and then hands over with POST /relay.
 *
 * The Pages project binds this class as LIVE_HUB (wrangler.toml,
 * durable_objects.bindings with script_name = "soard-live-hub") and pushes
 * state changes with POST /publish over the binding. Nothing but /ws and
 * /health is reachable from the public internet.
 *
 * Env: PAGES_ORIGIN (plain text, e.g. https://sunshineonaranneyday.com)
 */

import { DurableObject } from 'cloudflare:workers';

const FAST_MS = 8 * 1000;    // armed / live / ending
const NEAR_MS = 20 * 1000;   // within 30 min of a scheduled start
const IDLE_MS = 60 * 1000;   // nothing scheduled soon
const NEAR_WINDOW_MS = 30 * 60 * 1000;
const MAX_CLIENTS = 5000;
const NONCE_TTL_MS = 90 * 1000;
const REACTIONS = new Set(['heart', 'sun', 'clap', 'wow']);
const REACT_FLUSH_MS = 400;
const REACT_WINDOW_MS = 3000;
const REACT_MAX_PER_WINDOW = 15;
const VIEWERS_DEBOUNCE_MS = 2000;
const RELAY_TYPES = new Set(['msg', 'msg-hide']);

function pickInterval(state) {
  const phase = state?.phase || 'idle';
  if (phase === 'armed' || phase === 'live' || phase === 'ending') return FAST_MS;
  if (phase === 'scheduled' && state?.scheduledAt) {
    const dt = Date.parse(state.scheduledAt) - Date.now();
    if (dt > -NEAR_WINDOW_MS && dt < NEAR_WINDOW_MS) return NEAR_MS;
  }
  return IDLE_MS;
}

function same(a, b) {
  try { return JSON.stringify(a) === JSON.stringify(b); } catch { return false; }
}

export class LiveHub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    // Sockets answer "ping" without waking the object (hibernation-friendly)
    try { this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong')); } catch {}
    // Watch-party bookkeeping. In memory only: pending timers keep the object
    // awake while there is anything to flush, and losing it costs nothing.
    this.pendingReactions = {};
    this.reactTimer = null;
    this.viewersTimer = null;
    this.lastViewers = -1;
    this.reactRate = new WeakMap();
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === '/ws') {
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
        return new Response('Expected WebSocket', { status: 426 });
      }
      if (this.ctx.getWebSockets().length >= MAX_CLIENTS) {
        return new Response('Too many clients', { status: 503 });
      }
      const pair = new WebSocketPair();
      const [client, server] = Object.values(pair);
      const role = url.searchParams.get('role') === 'admin' ? 'admin' : 'site';
      this.ctx.acceptWebSocket(server, [role]);
      const state = (await this.ctx.storage.get('state')) || null;
      server.send(JSON.stringify({ type: 'state', state, reason: 'connect', ts: Date.now() }));
      await this.ensureAlarm(state);
      return new Response(null, { status: 101, webSocket: client });
    }

    if (path === '/publish' && request.method === 'POST') {
      // Called by Pages Functions over the binding (not reachable publicly)
      let body;
      try { body = await request.json(); } catch { return Response.json({ ok: false, error: 'bad json' }, { status: 400 }); }
      const changed = await this.setSnapshot(body.state ?? null, body.reason || 'publish');
      if (body.event) this.broadcast({ type: 'event', event: body.event, ts: Date.now() });
      return Response.json({ ok: true, changed, clients: this.ctx.getWebSockets().length });
    }

    if (path === '/relay' && request.method === 'POST') {
      // Binding-only. Screened messages for the family, from the Pages Function.
      let body;
      try { body = await request.json(); } catch { return Response.json({ ok: false, error: 'bad json' }, { status: 400 }); }
      if (!RELAY_TYPES.has(body?.type)) return Response.json({ ok: false, error: 'unknown type' }, { status: 400 });
      const msg = body.type === 'msg'
        ? { type: 'msg', message: body.message }
        : { type: 'msg-hide', id: body.id };
      const sent = this.broadcastWatchers({ ...msg, ts: Date.now() });
      return Response.json({ ok: true, sent });
    }

    if (path === '/verify' && request.method === 'POST') {
      // Binding-only. The site calls this to confirm a tick really came from us.
      let body;
      try { body = await request.json(); } catch { return Response.json({ ok: false }, { status: 400 }); }
      const ok = await this.consumeNonce(body.nonce);
      return Response.json({ ok });
    }

    if (path === '/tick' && request.method === 'POST') {
      const r = await this.tick('manual');
      return Response.json(r);
    }

    if (path === '/status') {
      const [state, lastTick, alarm] = await Promise.all([
        this.ctx.storage.get('state'), this.ctx.storage.get('lastTick'), this.ctx.storage.getAlarm(),
      ]);
      const reactions = (await this.ctx.storage.get('reactions')) || null;
      return Response.json({
        ok: true,
        clients: this.ctx.getWebSockets().length,
        adminClients: this.ctx.getWebSockets('admin').length,
        watchers: this.watchers().length,
        reactions: reactions && reactions.broadcastId === (state?.id || null) ? reactions : null,
        phase: state?.phase || 'idle',
        lastTick: lastTick || null,
        nextAlarm: alarm ? new Date(alarm).toISOString() : null,
        interval: pickInterval(state),
      });
    }

    return new Response('Not found', { status: 404 });
  }

  async setSnapshot(state, reason) {
    const prev = await this.ctx.storage.get('state');
    const changed = !same(prev, state);
    if (changed) {
      await this.ctx.storage.put('state', state);
      this.broadcast({ type: 'state', state, reason, ts: Date.now() });
    }
    await this.ensureAlarm(state);
    return changed;
  }

  broadcast(msg) {
    const s = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      try { ws.send(s); } catch { /* closing socket */ }
    }
  }

  async webSocketMessage(ws, message) {
    if (typeof message !== 'string') return;
    if (message === 'state') {
      const state = (await this.ctx.storage.get('state')) || null;
      ws.send(JSON.stringify({ type: 'state', state, reason: 'refresh', ts: Date.now() }));
      return;
    }
    if (message.length > 200 || message[0] !== '{') return;
    let m;
    try { m = JSON.parse(message); } catch { return; }
    if (m.t === 'watch') {
      const att = ws.deserializeAttachment() || {};
      if (!att.w) ws.serializeAttachment({ ...att, w: 1 });
      try { ws.send(JSON.stringify({ type: 'viewers', n: this.watchers().length, ts: Date.now() })); } catch {}
      this.scheduleViewers();
    } else if (m.t === 'react' && REACTIONS.has(m.k)) {
      if (!(ws.deserializeAttachment() || {}).w) return;
      const now = Date.now();
      const r = this.reactRate.get(ws);
      if (!r || now - r.start > REACT_WINDOW_MS) this.reactRate.set(ws, { start: now, n: 1 });
      else if (r.n >= REACT_MAX_PER_WINDOW) return;
      else r.n++;
      this.pendingReactions[m.k] = (this.pendingReactions[m.k] || 0) + 1;
      if (!this.reactTimer) this.reactTimer = setTimeout(() => this.flushReactions(), REACT_FLUSH_MS);
    }
  }

  async webSocketClose(ws, code, reason) {
    const watching = !!(ws.deserializeAttachment() || {}).w;
    try { ws.close(code, reason); } catch {}
    if (watching) this.scheduleViewers();
  }

  /** Sockets on a live page (they sent {"t":"watch"}). */
  watchers() {
    return this.ctx.getWebSockets('site').filter((ws) => {
      try { return !!(ws.deserializeAttachment() || {}).w; } catch { return false; }
    });
  }

  /** Send to viewers and the admin; the rest of the site only needs state. */
  broadcastWatchers(msg) {
    const s = JSON.stringify(msg);
    let sent = 0;
    for (const ws of [...this.watchers(), ...this.ctx.getWebSockets('admin')]) {
      try { ws.send(s); sent++; } catch { /* closing socket */ }
    }
    return sent;
  }

  scheduleViewers() {
    if (this.viewersTimer) return;
    this.viewersTimer = setTimeout(() => {
      this.viewersTimer = null;
      const n = this.watchers().length;
      if (n === this.lastViewers) return;
      this.lastViewers = n;
      this.broadcastWatchers({ type: 'viewers', n, ts: Date.now() });
    }, VIEWERS_DEBOUNCE_MS);
  }

  async flushReactions() {
    this.reactTimer = null;
    const c = this.pendingReactions;
    this.pendingReactions = {};
    if (!Object.keys(c).length) return;
    this.broadcastWatchers({ type: 'react', c, ts: Date.now() });
    // Running totals per reveal, for the admin
    const state = (await this.ctx.storage.get('state')) || null;
    const broadcastId = state?.id || null;
    const prev = (await this.ctx.storage.get('reactions')) || null;
    const totals = prev && prev.broadcastId === broadcastId ? { ...prev.totals } : {};
    for (const [k, n] of Object.entries(c)) totals[k] = (totals[k] || 0) + n;
    await this.ctx.storage.put('reactions', { broadcastId, totals, updatedAt: new Date().toISOString() });
  }

  async webSocketError(ws) {
    try { ws.close(1011, 'error'); } catch {}
  }

  async alarm() {
    await this.tick('alarm');
    await this.ensureAlarm();
  }

  async issueNonce() {
    const now = Date.now();
    const nonces = (await this.ctx.storage.get('nonces')) || {};
    for (const [k, ts] of Object.entries(nonces)) if (now - ts > NONCE_TTL_MS) delete nonces[k];
    const nonce = crypto.randomUUID();
    nonces[nonce] = now;
    await this.ctx.storage.put('nonces', nonces);
    return nonce;
  }

  async consumeNonce(nonce) {
    if (typeof nonce !== 'string' || nonce.length < 16) return false;
    const nonces = (await this.ctx.storage.get('nonces')) || {};
    const ts = nonces[nonce];
    if (!ts) return false;
    delete nonces[nonce];
    await this.ctx.storage.put('nonces', nonces);
    return Date.now() - ts <= NONCE_TTL_MS;
  }

  /** Ask the site to run due work and return the current public state. */
  async tick(source) {
    const origin = this.env.PAGES_ORIGIN;
    const started = Date.now();
    const result = { ok: false, source, at: new Date(started).toISOString() };
    if (!origin) {
      result.error = 'hub not configured (PAGES_ORIGIN)';
      await this.ctx.storage.put('lastTick', result);
      return result;
    }
    try {
      const nonce = await this.issueNonce();
      const res = await fetch(`${origin}/api/broadcast-hooks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-hub-nonce': nonce },
        body: JSON.stringify({ type: 'tick', source, clients: this.ctx.getWebSockets().length }),
        signal: AbortSignal.timeout(15000),
      });
      result.status = res.status;
      if (res.ok) {
        const data = await res.json();
        result.ok = true;
        result.work = data.work || null;
        if (data.state !== undefined) result.changed = await this.setSnapshot(data.state, data.reason || 'tick');
      } else {
        result.error = `hooks returned ${res.status}`;
      }
    } catch (e) {
      result.error = e.message || String(e);
    }
    result.ms = Date.now() - started;
    await this.ctx.storage.put('lastTick', result);
    return result;
  }

  async ensureAlarm(state) {
    const st = state === undefined ? await this.ctx.storage.get('state') : state;
    const interval = pickInterval(st);
    const next = Date.now() + interval;
    const current = await this.ctx.storage.getAlarm();
    // Pull the alarm in if the cadence got faster; never push it out
    if (current == null || current > next) await this.ctx.storage.setAlarm(next);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/health') return Response.json({ ok: true, service: 'soard-live-hub' });
    const stub = env.LIVE_HUB.get(env.LIVE_HUB.idFromName('main'));
    if (url.pathname === '/ws') return stub.fetch(request);
    // /status is intentionally public read-only (no secrets), useful for the admin health card
    if (url.pathname === '/status') return stub.fetch(request);
    return new Response('Not found', { status: 404 });
  },
};
