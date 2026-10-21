/**
 * soard-live-hub (workers/live-hub/src/index.js): the limits and what leaves it
 *   no public routes but /health; 50 places kept for the admin; 40 site sockets
 *   per address; a token bucket per socket; state frames give a fixed reason;
 *   only Stream's three event names go out; the stored tick keeps kinds of work only
 * The Durable Object runs here against a fake ctx (sockets, storage, alarm).
 * Run: node --test tests/broadcast-hub.test.mjs
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { register } from 'node:module';

// 'cloudflare:workers' only exists in the Workers runtime: give the hub a stand-in base class
register(`data:text/javascript,${encodeURIComponent(`
export async function resolve(specifier, context, next) {
  if (specifier === 'cloudflare:workers') {
    return { shortCircuit: true, url: 'data:text/javascript,' + encodeURIComponent('export class DurableObject { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }') };
  }
  return next(specifier, context);
}`)}`);

// Node's Response refuses status 101; the runtime's carries the socket
const RealResponse = globalThis.Response;
globalThis.Response = class extends RealResponse {
  constructor(body, init = {}) {
    super(body, init?.status === 101 ? { ...init, status: 200 } : init);
    if (init?.status === 101) { this.upgraded = true; this.webSocket = init.webSocket; }
  }
};

class FakeSocket {
  constructor() { this.sent = []; this.closed = null; this.att = null; }
  send(s) { if (this.closed) throw new Error('closed'); this.sent.push(s); }
  close(code, reason) { this.closed = { code, reason }; }
  serializeAttachment(a) { this.att = a; }
  deserializeAttachment() { return this.att; }
  frames() { return this.sent.map((s) => JSON.parse(s)); }
}
globalThis.WebSocketPair = class { constructor() { this[0] = new FakeSocket(); this[1] = new FakeSocket(); } };
globalThis.WebSocketRequestResponsePair = class { constructor(req, res) { this.req = req; this.res = res; } };

function fakeCtx() {
  const sockets = [];
  const store = new Map();
  let alarm = null;
  return {
    sockets, store,
    setWebSocketAutoResponse() {},
    acceptWebSocket(ws, tags = []) { sockets.push({ ws, tags }); },
    getWebSockets(tag) { return sockets.filter((s) => !s.ws.closed && (!tag || s.tags.includes(tag))).map((s) => s.ws); },
    storage: {
      async get(k) { return store.get(k); },
      async put(k, v) { store.set(k, v); },
      async getAlarm() { return alarm; },
      async setAlarm(t) { alarm = t; },
    },
  };
}

const realFetch = globalThis.fetch;
let mod, LiveHub;
const newHub = (env = { PAGES_ORIGIN: 'https://sunshineonaranneyday.com' }) => { const ctx = fakeCtx(); return { ctx, hub: new LiveHub(ctx, env) }; };
const connect = (hub, { role = 'site', ip = null } = {}) => hub.fetch(new Request(`https://hub/ws?role=${role}`, { headers: { Upgrade: 'websocket', ...(ip ? { 'x-soard-client-ip': ip } : {}) } }));
/** Pretend `n` sockets are already open */
const fill = (ctx, n, tags = ['site']) => { for (let i = 0; i < n; i++) ctx.sockets.push({ ws: new FakeSocket(), tags }); };

before(async () => {
  mod = await import('../workers/live-hub/src/index.js');
  LiveHub = mod.LiveHub;
});
after(() => { globalThis.Response = RealResponse; globalThis.fetch = realFetch; });

test('the Worker itself answers /health only: no public /ws, no public /status', async () => {
  const health = await mod.default.fetch(new Request('https://soard-live-hub.example.workers.dev/health'));
  assert.deepEqual(await health.json(), { ok: true, service: 'soard-live-hub' });
  for (const path of ['/status', '/ws', '/ws?role=admin', '/publish', '/tick']) {
    const res = await mod.default.fetch(new Request(`https://soard-live-hub.example.workers.dev${path}`, { headers: { Upgrade: 'websocket' } }));
    assert.equal(res.status, 404, path);
  }
});

test('the last 50 places are kept for the admin', async () => {
  const { ctx, hub } = newHub();
  fill(ctx, 5000 - 50);
  assert.equal((await connect(hub)).status, 503, 'a viewer is turned away');
  const admin = await connect(hub, { role: 'admin' });
  assert.equal(admin.upgraded, true, 'the control room still gets in');
  fill(ctx, 49, ['admin']);
  assert.equal((await connect(hub, { role: 'admin' })).status, 503, 'until every place is taken');
});

test('40 site sockets per address; admin sockets and other addresses are not counted against it', async () => {
  const { ctx, hub } = newHub();
  for (let i = 0; i < 40; i++) assert.equal((await connect(hub, { ip: '203.0.113.9' })).upgraded, true);
  assert.equal((await connect(hub, { ip: '203.0.113.9' })).status, 429);
  assert.equal((await connect(hub, { ip: '203.0.113.10' })).upgraded, true);
  assert.equal((await connect(hub, { ip: '203.0.113.9', role: 'admin' })).upgraded, true);
  assert.equal((await connect(hub)).upgraded, true, 'no address (an older site deploy): not capped');
  // A closed socket frees its place
  ctx.getWebSockets('ip:203.0.113.9')[0].close(1000, 'bye');
  assert.equal((await connect(hub, { ip: '203.0.113.9' })).upgraded, true);
});

test('a socket that floods is closed; a person tapping fast is not', async () => {
  const { hub } = newHub();
  const realNow = Date.now;
  let t = realNow();
  Date.now = () => t;
  try {
    const server = new FakeSocket(); // the server end, as the runtime hands it to webSocketMessage
    for (let i = 0; i < 60; i++) await hub.webSocketMessage(server, 'state');
    assert.equal(server.closed, null, 'a burst of 60 is fine');
    await hub.webSocketMessage(server, 'state');
    assert.deepEqual(server.closed, { code: 1008, reason: 'too many messages' });

    const person = new FakeSocket();
    person.serializeAttachment({ w: 1 });
    for (let i = 0; i < 300; i++) { t += 125; await hub.webSocketMessage(person, '{"t":"react","k":"heart"}'); } // 8 taps a second for ~40 s
    assert.equal(person.closed, null);
  } finally {
    Date.now = realNow;
  }
});

test('state frames give a fixed reason; only Stream event names go out, as { type }', async () => {
  const { ctx, hub } = newHub();
  await connect(hub);
  const ws = ctx.getWebSockets()[0];
  const publish = (body) => hub.fetch(new Request('https://hub/publish', { method: 'POST', body: JSON.stringify(body) }));
  await publish({ state: { phase: 'armed', n: 1 }, reason: 'admin:cancel' });
  await publish({ state: { phase: 'armed', n: 2 }, reason: 'email:day:3/3,kid:remi:facebook-live' });
  await publish({ state: { phase: 'live', n: 3 }, reason: 'webhook', event: { type: 'live_input.connected', blob: 'x'.repeat(5000) } });
  await publish({ state: { phase: 'live', n: 3 }, reason: 'webhook', event: { type: 'Your account is suspended' } });
  const frames = ws.frames();
  assert.deepEqual(frames.filter((f) => f.type === 'state').map((f) => f.reason), ['connect', 'admin', 'tick', 'webhook']);
  const events = frames.filter((f) => f.type === 'event');
  assert.deepEqual(events.map((f) => f.event), [{ type: 'live_input.connected' }]);
});

test("the stored tick keeps kinds of work only, never kid slugs or send counts", async () => {
  const { ctx, hub } = newHub();
  globalThis.fetch = async (url, init) => {
    assert.equal(url, 'https://sunshineonaranneyday.com/api/broadcast-hooks');
    assert.match(init.headers['x-hub-nonce'], /^[0-9a-f-]{36}$/);
    return RealResponse.json({ ok: true, state: { phase: 'live' }, reason: 'email:day:1/1', work: ['email:day:1/1', 'kid:remi:facebook-live', 'email:hour:2/2'] });
  };
  const r = await hub.tick('alarm');
  assert.equal(r.ok, true);
  assert.deepEqual(ctx.store.get('lastTick').work, ['email', 'kid']);
  const status = await (await hub.fetch(new Request('https://hub/status'))).json();
  assert.ok('watchers' in status, 'the binding-only status still has what Automations checks');
});
