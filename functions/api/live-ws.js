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
 *
 * Only pages on this site may connect (the Origin header: this request's own
 * origin, the live site, or localhost while developing locally). ?role=admin
 * counts only with a valid Cloudflare Access login; otherwise the socket is
 * an ordinary site socket. The hub caps sockets per address, so the caller's
 * address goes along in X-Soard-Client-Ip (IPv6 folded to its /64), set here
 * and never taken from the caller.
 */

import { isAuthenticated } from './_middleware.js';
import { clientIp } from './_secure.js';

const SITE_ORIGIN = 'https://sunshineonaranneyday.com';
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
export const CLIENT_IP_HEADER = 'x-soard-client-ip';

/** A page on this site: the request's own origin, the live site, or localhost talking to localhost */
export function originAllowed(request) {
  const origin = request.headers.get('Origin');
  if (!origin) return false;
  let from, self;
  try { from = new URL(origin); self = new URL(request.url); } catch { return false; }
  if (from.origin === self.origin || from.origin === SITE_ORIGIN) return true;
  return LOCAL_HOSTS.has(self.hostname) && LOCAL_HOSTS.has(from.hostname);
}

export async function onRequestGet(context) {
  const { env, request } = context;
  if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
    return Response.json({ ok: false, error: 'Expected a WebSocket upgrade', hub: !!env.LIVE_HUB }, { status: 426 });
  }
  if (!env.LIVE_HUB) {
    return Response.json({ ok: false, error: 'real-time hub not bound' }, { status: 503 });
  }
  if (!originAllowed(request)) {
    return Response.json({ ok: false, error: 'origin not allowed' }, { status: 403 });
  }
  try {
    const url = new URL(request.url);
    const role = url.searchParams.get('role') === 'admin' && await isAuthenticated(request, env) ? 'admin' : 'site';
    const headers = new Headers(request.headers);
    headers.delete(CLIENT_IP_HEADER);
    const ip = clientIp(request);
    if (ip !== 'unknown') headers.set(CLIENT_IP_HEADER, ip);
    const stub = env.LIVE_HUB.get(env.LIVE_HUB.idFromName('main'));
    return await stub.fetch(new Request(`https://hub/ws?role=${role}`, { method: 'GET', headers }));
  } catch (err) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
}
