/**
 * GET /api/live-ws — WebSocket to the real-time hub
 * ==================================================
 * Same-origin upgrade endpoint the LIVE pill, the live page and the admin
 * connect to. Proxied over the LIVE_HUB Durable Object binding, so visitors
 * never talk to the workers.dev host and the CSP stays 'self'. Returns 503
 * when the binding is missing (local dev, or before the first deploy with
 * the binding), and clients fall back to polling /api/broadcast.
 *
 * Messages (server → client), all JSON:
 *   { type: 'state', state, reason, ts }   full public state
 *   { type: 'event', event, ts }           informational
 * Client → server: 'ping' (answered 'pong' without waking the object), 'state'.
 */

export async function onRequestGet(context) {
  const { env, request } = context;
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return Response.json({ ok: false, error: 'Expected a WebSocket upgrade', hub: !!env.LIVE_HUB }, { status: 426 });
  }
  if (!env.LIVE_HUB) {
    return Response.json({ ok: false, error: 'real-time hub not bound' }, { status: 503 });
  }
  try {
    const url = new URL(request.url);
    const role = url.searchParams.get('role') === 'admin' ? 'admin' : 'site';
    const stub = env.LIVE_HUB.get(env.LIVE_HUB.idFromName('main'));
    return await stub.fetch(new Request(`https://hub/ws?role=${role}`, request));
  } catch (err) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
}
