/**
 * /mcp — the SOARD connection for Claude (Model Context Protocol, Streamable HTTP)
 * =====================================================================
 * Staff add https://sunshineonaranneyday.com/mcp to their own Claude as a custom
 * connector. Its tools are ./api/_mcp-tools.js: look up kids and events, write
 * an email in SOARD's layout, change the words of the site's own emails, send
 * yourself a test, put a draft in Kit. Drafts only, ever.
 *
 * Sign-in is Cloudflare Access's managed OAuth, on the Access application for
 * this one path ("SOARD connection for Claude", id 6a7540be-bf33-4ef2-9392-0343733b0bca):
 * Claude registers itself (only https://claude.ai/api/mcp/auth_callback may),
 * the person signs in with their SOARD Google account under the admin's
 * "Admin Team" rule, and Access hands Claude a 15-minute token it renews for up
 * to two weeks while that rule still lets them in. Access sends each request
 * here with its signed Cf-Access-Jwt-Assertion; this checks it for this
 * application, then holds the person to the admin's own rule: a soardcharity.com
 * Google account that's still active (./api/_staff-access.js).
 *
 * Both eras of the protocol, on one stateless endpoint: a 2026-07-28 client
 * sends its version in each request's _meta (server/discover, results carry
 * resultType); an earlier client opens with initialize. No sessions are kept.
 */

import { verifyJwt } from './api/_middleware.js';
import { isStaffEmail } from './api/_board-roles.js';
import { staffStanding, refusedText } from './api/_staff-access.js';
import { limit } from './api/_rate-limit.js';
import { TOOLS, callTool, serverInstructions } from './api/_mcp-tools.js';

/** The Access application's audience (not a secret: it's in every token Access signs for it) */
const MCP_AUD = 'fd28d75ff1832c06ce1a20ad2cdbecdd5c731fd00e2c260ee719a02968259d3f';
export const MODERN = Object.freeze(['2026-07-28']);
export const LEGACY = Object.freeze(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);
const SUPPORTED = [...MODERN, ...LEGACY];
const SERVER_INFO = Object.freeze({ name: 'soard', title: 'SOARD (Sunshine on a Ranney Day)', version: '1.0.0' });
const VERSION_META = 'io.modelcontextprotocol/protocolVersion';
// Plenty for a person and their Claude; a runaway loop stops here
const CALLS_PER_MINUTE = 120;

const json = (body, status = 200, extra = {}) => new Response(body === null ? null : JSON.stringify(body), {
  status, headers: { ...(body === null ? {} : { 'Content-Type': 'application/json' }), 'Cache-Control': 'no-store', ...extra },
});
const rpcError = (id, code, message, data) => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data ? { data } : {}) } });

/** Who's asking: the signed-in person, held to the admin's own staff rule. → { email } or { refuse: Response } */
export async function whoIs(request, env) {
  const jwt = request.headers.get('Cf-Access-Jwt-Assertion') || '';
  if (!jwt || !env.CF_ACCESS_TEAM_DOMAIN) return { refuse: json({ error: 'Sign in through Cloudflare Access to use this connection.' }, 401) };
  let payload;
  try {
    payload = await verifyJwt(jwt, env.CF_ACCESS_TEAM_DOMAIN, env.CF_ACCESS_MCP_AUD || MCP_AUD);
  } catch (err) {
    console.warn('[mcp] Access token refused:', err.message);
    return { refuse: json({ error: 'This sign-in isn’t valid for the SOARD connection. Reconnect it in Claude.' }, 401) };
  }
  const email = String(payload.email || '').trim().toLowerCase();
  if (!isStaffEmail(email)) return { refuse: json({ error: 'The SOARD connection is for SOARD staff only.' }, 403) };
  const standing = await staffStanding(env, email);
  if (!standing.staff) return { refuse: json({ error: refusedText(standing) }, 403) };
  return { email };
}

/** One JSON-RPC message → its response, or null for a notification */
export async function answer(msg, env, email, now = Date.now()) {
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return rpcError(msg?.id, -32600, 'Invalid request');
  const isNote = msg.id === undefined || msg.id === null;
  const params = msg.params && typeof msg.params === 'object' ? msg.params : {};
  const asked = params._meta?.[VERSION_META];
  const modern = typeof asked === 'string';
  if (modern && !MODERN.includes(asked)) {
    return isNote ? null : rpcError(msg.id, -32022, 'Unsupported protocol version', { supported: SUPPORTED, requested: asked });
  }
  // A modern result says it's complete and who answered
  const ok = (result) => ({ jsonrpc: '2.0', id: msg.id, result: modern ? { resultType: 'complete', ...result, _meta: { ...(result._meta || {}), 'io.modelcontextprotocol/serverInfo': SERVER_INFO } } : result });
  if (isNote) return null; // notifications/initialized and the like: nothing to say back

  switch (msg.method) {
    case 'initialize': {
      const want = String(params.protocolVersion || '');
      return ok({
        protocolVersion: LEGACY.includes(want) ? want : LEGACY[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: serverInstructions(now),
      });
    }
    case 'server/discover':
      return ok({ supportedVersions: SUPPORTED, capabilities: { tools: {} }, instructions: serverInstructions(now), ttlMs: 3600000, cacheScope: 'private' });
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({ tools: TOOLS, ...(modern ? { ttlMs: 3600000, cacheScope: 'private' } : {}) });
    case 'tools/call': {
      const name = String(params.name || '');
      if (!TOOLS.some((t) => t.name === name)) return rpcError(msg.id, -32602, `Unknown tool: ${name}`);
      const r = await callTool(env, name, params.arguments, email);
      return ok(r);
    }
    default:
      return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

export async function onRequest(context) {
  const { request, env } = context;
  // One POST per request or notification; there's no stream to open and no session to end
  if (request.method !== 'POST') return json({ error: 'Use POST' }, 405, { Allow: 'POST' });
  const who = await whoIs(request, env);
  if (who.refuse) return who.refuse;
  const gate = await limit(env.DB, `mcp:${who.email}`, CALLS_PER_MINUTE, 60);
  if (!gate.ok) return json(rpcError(null, -32000, 'Too many requests. Wait a minute and try again.'), 429, { 'Retry-After': String(gate.retryAfter) });
  let body;
  try { body = await request.json(); } catch { return json(rpcError(null, -32700, 'Parse error'), 400); }
  const batch = Array.isArray(body);
  const msgs = batch ? body : [body];
  if (!msgs.length || msgs.length > 20) return json(rpcError(null, -32600, 'Invalid request'), 400);
  const out = [];
  for (const m of msgs) {
    const r = await answer(m, env, who.email);
    if (r) out.push(r);
  }
  // Only notifications: accepted, nothing to say
  if (!out.length) return json(null, 202);
  return json(batch ? out : out[0]);
}
