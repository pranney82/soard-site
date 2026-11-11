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
 * resultType, its headers must match its body); an earlier client opens with
 * initialize. No sessions are kept. Besides the tools: prompts (Claude's +
 * menu), resources (guides, SOARD's facts, a kid's or an event's page, and the
 * email preview the chat draws) and completions for their names.
 */

import { verifyJwt } from './api/_middleware.js';
import { isStaffEmail } from './api/_board-roles.js';
import { staffStanding, refusedText } from './api/_staff-access.js';
import { limit } from './api/_rate-limit.js';
import { TOOLS, callTool, serverInstructions } from './api/_mcp-tools.js';
import { PROMPTS, RESOURCES, TEMPLATES, readResource, complete } from './api/_mcp/guide.js';

/** The Access application's audience (not a secret: it's in every token Access signs for it) */
const MCP_AUD = 'fd28d75ff1832c06ce1a20ad2cdbecdd5c731fd00e2c260ee719a02968259d3f';
export const MODERN = Object.freeze(['2026-07-28']);
export const LEGACY = Object.freeze(['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05']);
const SUPPORTED = [...MODERN, ...LEGACY];
const SERVER_INFO = Object.freeze({ name: 'soard', title: 'SOARD (Sunshine on a Ranney Day)', version: '2.0.0' });
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

/** Cached by the client for an hour, never by anyone between (2026-07-28 CacheableResult) */
const CACHE = Object.freeze({ ttlMs: 3600000, cacheScope: 'private' });
const CAPS_LEGACY = Object.freeze({ tools: { listChanged: false }, prompts: { listChanged: false }, resources: { subscribe: false, listChanged: false }, completions: {} });
const CAPS_MODERN = Object.freeze({ tools: {}, prompts: {}, resources: {}, completions: {} });
const promptDef = ({ get, ...p }) => p;
const resourceDef = ({ read, ...r }) => r;

/** A 2026-07-28 request's HTTP status for its error (the transport's rules); everything else is 200 */
export const STATUS_FOR = Object.freeze({ [-32022]: 400, [-32020]: 400, [-32601]: 404 });

/** One JSON-RPC message → its response, or null for a notification */
export async function answer(msg, env, email, now = Date.now(), { waitUntil } = {}) {
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
  const cached = (result) => ok(modern ? { ...result, ...CACHE } : result);
  if (isNote) return null; // notifications/initialized and the like: nothing to say back

  switch (msg.method) {
    case 'initialize': {
      const want = String(params.protocolVersion || '');
      return ok({
        protocolVersion: LEGACY.includes(want) ? want : LEGACY[0],
        capabilities: CAPS_LEGACY,
        serverInfo: SERVER_INFO,
        instructions: serverInstructions(now),
      });
    }
    case 'server/discover':
      return ok({ supportedVersions: SUPPORTED, capabilities: CAPS_MODERN, serverInfo: SERVER_INFO, instructions: serverInstructions(now), ...CACHE });
    case 'ping':
      return ok({});
    case 'tools/list':
      return cached({ tools: TOOLS });
    case 'tools/call': {
      const name = String(params.name || '');
      if (!TOOLS.some((t) => t.name === name)) return rpcError(msg.id, -32602, `Unknown tool: ${name}`);
      return ok(await callTool(env, name, params.arguments, email, { waitUntil }));
    }
    case 'prompts/list':
      return cached({ prompts: PROMPTS.map(promptDef) });
    case 'prompts/get': {
      const p = PROMPTS.find((x) => x.name === params.name);
      if (!p) return rpcError(msg.id, -32602, `Unknown prompt: ${String(params.name || '')}`);
      const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
      const missing = p.arguments.find((a) => a.required && !String(args[a.name] ?? '').trim());
      if (missing) return rpcError(msg.id, -32602, `Missing required argument: ${missing.name}`);
      const clean = Object.fromEntries(Object.entries(args).map(([k, v]) => [k, String(v ?? '').slice(0, 500)]));
      return ok({ description: p.description, ...p.get(clean) });
    }
    case 'resources/list':
      // The email preview is read by its tools' hosts, never attached by a person: it isn't listed under Claude's + menu
      return cached({ resources: RESOURCES.map(resourceDef) });
    case 'resources/templates/list':
      return cached({ resourceTemplates: TEMPLATES });
    case 'resources/read': {
      const uri = String(params.uri || '');
      const contents = await readResource(env, uri).catch((err) => { console.error('[mcp] resource', uri, err.message); return undefined; });
      if (contents === undefined) return rpcError(msg.id, -32603, 'That couldn’t be read right now. Try again in a minute.');
      if (!contents) return rpcError(msg.id, modern ? -32602 : -32002, 'Resource not found', { uri });
      return cached({ contents });
    }
    case 'completion/complete': {
      const values = await complete(env, params).catch(() => []);
      return ok({ completion: { values: values.slice(0, 100), total: values.length, hasMore: values.length > 100 } });
    }
    default:
      return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

// ── The transport's own checks ────────────────────────────────────────────

/** Who may call from a browser page: Claude's own apps and frames, and the site. A request with no Origin is a server's */
const ORIGINS = [/^https:\/\/([a-z0-9-]+\.)*claude\.(ai|com)$/, /^https:\/\/([a-z0-9-]+\.)*anthropic\.com$/, /^https:\/\/[a-f0-9]{32}\.claudemcpcontent\.com$/, /^https:\/\/sunshineonaranneyday\.com$/];
export const originAllowed = (origin) => !origin || ORIGINS.some((re) => re.test(origin));

/** A header value as the 2026-07-28 transport sends it: plain, or =?base64?…?= for anything that isn't plain ASCII */
function headerValue(v) {
  const m = /^=\?base64\?([A-Za-z0-9+/=]*)\?=$/.exec(v || '');
  if (!m) return v;
  try { return new TextDecoder().decode(Uint8Array.from(atob(m[1]), (c) => c.charCodeAt(0))); } catch { return null; }
}

/** A 2026-07-28 request's headers must say what its body says (its version, method and name) → an error, or null */
export function headerProblem(request, msg) {
  const asked = msg?.params?._meta?.[VERSION_META];
  if (typeof asked !== 'string' || msg.id === undefined || msg.id === null) return null;
  const h = (n) => request.headers.get(n);
  if (!h('MCP-Protocol-Version')) return 'MCP-Protocol-Version header is missing';
  if (h('MCP-Protocol-Version') !== asked) return `MCP-Protocol-Version header value '${h('MCP-Protocol-Version')}' does not match body value '${asked}'`;
  if (!h('Mcp-Method')) return 'Mcp-Method header is missing';
  if (h('Mcp-Method') !== msg.method) return `Mcp-Method header value '${h('Mcp-Method')}' does not match body value '${msg.method}'`;
  const named = { 'tools/call': 'name', 'prompts/get': 'name', 'resources/read': 'uri' }[msg.method];
  if (named) {
    const raw = h('Mcp-Name');
    if (!raw) return 'Mcp-Name header is missing';
    const name = headerValue(raw);
    if (name === null) return 'Mcp-Name header is not valid base64';
    if (name !== String(msg.params?.[named] ?? '')) return `Mcp-Name header value does not match body value '${String(msg.params?.[named] ?? '')}'`;
  }
  return null;
}

export async function onRequest(context) {
  const { request, env } = context;
  // One POST per request or notification; there's no stream to open and no session to end
  if (request.method !== 'POST') return json({ error: 'Use POST' }, 405, { Allow: 'POST' });
  const origin = request.headers.get('Origin');
  if (!originAllowed(origin)) {
    console.warn('[mcp] refused Origin', origin);
    return json(rpcError(null, -32000, 'Requests from this page aren’t accepted.'), 403);
  }
  const who = await whoIs(request, env);
  if (who.refuse) return who.refuse;
  const gate = await limit(env.DB, `mcp:${who.email}`, CALLS_PER_MINUTE, 60);
  if (!gate.ok) return json(rpcError(null, -32000, 'Too many requests. Wait a minute and try again.'), 429, { 'Retry-After': String(gate.retryAfter) });
  let body;
  try { body = await request.json(); } catch { return json(rpcError(null, -32700, 'Parse error'), 400); }
  const batch = Array.isArray(body);
  const msgs = batch ? body : [body];
  if (!msgs.length || msgs.length > 20) return json(rpcError(null, -32600, 'Invalid request'), 400);
  // Batches are an earlier era's; a 2026 request comes alone, and its headers must match it
  if (batch && msgs.some((m) => typeof m?.params?._meta?.[VERSION_META] === 'string')) return json(rpcError(null, -32600, 'Invalid request: send one message per request'), 400);
  if (!batch) {
    const bad = headerProblem(request, body);
    if (bad) return json(rpcError(body.id, -32020, `Header mismatch: ${bad}`), 400);
  }
  const waitUntil = context.waitUntil ? (p) => context.waitUntil(p) : undefined;
  const out = [];
  for (const m of msgs) {
    const r = await answer(m, env, who.email, Date.now(), { waitUntil });
    if (r) out.push(r);
  }
  // Only notifications: accepted, nothing to say
  if (!out.length) return json(null, 202);
  if (batch) return json(out);
  const modern = typeof body?.params?._meta?.[VERSION_META] === 'string';
  return json(out[0], (modern && STATUS_FOR[out[0].error?.code]) || 200);
}
