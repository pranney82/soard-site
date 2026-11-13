/**
 * The SOARD connection for Claude (/mcp): only SOARD staff signed in through
 * the connection's own Access application get in; both eras of the protocol
 * are answered on one stateless endpoint; and the tools do what the admin does
 * (Write an email, Edit words, a test copy, Draft in Kit), drafts only, logged
 * in History "via Claude". Access, Kit and Resend are faked.
 * Run: node --test tests/mcp.test.mjs
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { onRequest, MODERN, LEGACY } from '../functions/mcp.js';
import { TOOLS, callTool } from '../functions/api/_mcp-tools.js';
import { existsSync, readFileSync } from 'node:fs';
import { contentSchemaSource, OUT as SCHEMA_OUT } from '../scripts/mcp-content-schema.mjs';
import { writeConfig } from '../functions/api/_reveal-invites.js';

const TEAM = 'soard';
const ISS = `https://${TEAM}.cloudflareaccess.com`;
const MCP_AUD = 'fd28d75ff1832c06ce1a20ad2cdbecdd5c731fd00e2c260ee719a02968259d3f';
const ADMIN_AUD = 'admin-aud';
const b64u = (bytes) => Buffer.from(bytes).toString('base64url');
const pair = await crypto.subtle.generateKey({ name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['sign', 'verify']);
const jwk = { ...(await crypto.subtle.exportKey('jwk', pair.publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
async function token(email, aud = MCP_AUD) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64u(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' }));
  const p = b64u(JSON.stringify({ iss: ISS, aud: [aud], email, iat: now, nbf: now, exp: now + 900 }));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', pair.privateKey, new TextEncoder().encode(`${h}.${p}`));
  return `${h}.${p}.${b64u(new Uint8Array(sig))}`;
}

const IMG = 'https://imagedelivery.net/ROYFuPmfN2vPS6mt5sCkZQ';
const KID = {
  name: 'Rowan', slug: 'rowan-test', publishStatus: 'published', status: 'in-progress', year: 2027, age: 9, roomTypes: ['Accessible Bathroom'],
  heroImage: `${IMG}/kids/rowan-test/hero.jpg/public`, heroSummary: 'Rowan loves trains.', bio: '<p>Rowan is nine and loves trains.</p>', diagnosis: 'Cerebral palsy', quote: 'Trains are the best.',
  photos: ['a', 'b', 'c'].map((n) => ({ url: `${IMG}/kids/rowan-test/${n}.jpg/public`, alt: `Rowan ${n}` })),
  partnerLogos: [{ url: `${IMG}/partners/msi/public`, name: 'MSI' }],
};

let kit; let emails; let zeffy = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  const method = (init.method || 'GET').toUpperCase();
  const body = init.body ? JSON.parse(init.body) : null;
  if (url === `${ISS}/cdn-cgi/access/certs`) return Response.json({ keys: [jwk] });
  if (url.startsWith('https://api.kit.com/v4/')) {
    const path = url.slice('https://api.kit.com/v4'.length);
    kit.calls.push(`${method} ${path.split('?')[0]}`);
    if (path.startsWith('/tags')) return Response.json({ tags: [{ id: 555, name: 'Application Waitlist only (no newsletter)' }] });
    if (path.startsWith('/broadcasts?')) return Response.json({ broadcasts: [] });
    if (path === '/broadcasts' && method === 'POST') {
      const id = String(kit.next++);
      kit.broadcasts.set(id, { id: Number(id), status: 'draft', ...body });
      return Response.json({ broadcast: { id: Number(id) } }, { status: 201 });
    }
    const one = path.match(/^\/broadcasts\/(\d+)$/);
    if (one && method === 'GET') {
      const b = kit.broadcasts.get(one[1]);
      return b ? Response.json({ broadcast: b }) : Response.json({ errors: ['Not found'] }, { status: 404 });
    }
    return Response.json({ errors: ['unexpected'] }, { status: 500 });
  }
  if (url.startsWith('https://imagedelivery.net/')) return new Response('img', { headers: { 'Content-Type': 'image/jpeg' } });
  if (url.startsWith('https://api.zeffy.com/api/v1/payments')) return Response.json({ data: zeffy, has_more: false });
  if (url.startsWith('https://api.resend.com/emails/batch')) {
    for (const e of body) emails.push(e);
    return Response.json({ data: body.map((_, i) => ({ id: `re_${emails.length}_${i}` })) });
  }
  throw new Error(`unexpected fetch ${url}`);
};
after(() => { globalThis.fetch = realFetch; });

let env;
beforeEach(async () => {
  kit = { broadcasts: new Map(), calls: [], next: 9701 };
  emails = [];
  const DB = await createD1({ schemaFiles: ['scripts/schema.sql'] });
  await DB.prepare('INSERT INTO kids (slug, name, year, status, data) VALUES (?, ?, ?, ?, ?)').bind(KID.slug, KID.name, 2027, 'in-progress', JSON.stringify(KID)).run();
  await writeConfig(DB, { enabled: true, kitInvite: { reviewer: 'linzi@soardcharity.com, peter@soardcharity.com' } });
  env = { DB, CF_ACCESS_TEAM_DOMAIN: TEAM, CF_ACCESS_AUD: ADMIN_AUD, KIT_API_KEY: 'kit_test', RESEND_API_KEY: 're_test' };
});

const LINZI = 'linzi@soardcharity.com';
let nextId = 1;
async function post(body, { as = LINZI, aud = MCP_AUD, raw = false, headers: more = {} } = {}) {
  const headers = { 'Content-Type': 'application/json', ...more };
  if (as) headers['Cf-Access-Jwt-Assertion'] = await token(as, aud);
  const res = await onRequest({ request: new Request('https://sunshineonaranneyday.com/mcp', { method: 'POST', headers, body: JSON.stringify(body) }), env });
  if (raw) return res;
  return { status: res.status, body: res.status === 202 ? null : await res.json() };
}
const rpc = (method, params = {}, extra = {}) => post({ jsonrpc: '2.0', id: nextId++, method, params }, extra);
const V26 = '2026-07-28';
/** A 2026-07-28 request, with the headers its transport requires (its version, method and name) */
const modern = (method, params = {}, { version = V26, headers = null } = {}) => {
  const name = params.name ?? params.uri;
  return rpc(method, { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': version, 'io.modelcontextprotocol/clientInfo': { name: 'claude-ai', version: '1' } } }, {
    headers: headers ?? { 'MCP-Protocol-Version': version, 'Mcp-Method': method, ...(name !== undefined ? { 'Mcp-Name': String(name) } : {}) },
  });
};
const call = async (name, args = {}) => {
  const r = await rpc('tools/call', { name, arguments: args });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.result;
};
const data = (result) => result.structuredContent ?? result.content[0].text;

// ─── Who gets in ───

test('only SOARD staff, signed in through the connection’s own Access application, get in', async () => {
  assert.equal((await rpc('tools/list', {}, { as: null })).status, 401, 'no Access token');
  assert.equal((await rpc('tools/list', {}, { aud: ADMIN_AUD })).status, 401, 'a token for the admin, not this connection');
  assert.equal((await rpc('tools/list', {}, { as: 'someone@gmail.com' })).status, 403, 'not a SOARD account');
  assert.equal((await rpc('tools/list', {})).status, 200);
  const get = await onRequest({ request: new Request('https://sunshineonaranneyday.com/mcp'), env });
  assert.equal(get.status, 405);
  assert.equal(get.headers.get('Allow'), 'POST');
});

// ─── The protocol, both eras ───

test('an earlier client: initialize (its version, else the newest earlier one), notifications accepted, ping, the tools', async () => {
  const init = await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'claude-ai', version: '1' } });
  assert.equal(init.body.result.protocolVersion, '2025-06-18');
  assert.deepEqual(init.body.result.capabilities, { tools: { listChanged: false }, prompts: { listChanged: false }, resources: { subscribe: false, listChanged: false }, completions: {} });
  assert.equal(init.body.result.serverInfo.name, 'soard');
  assert.match(init.body.result.instructions, /Sunshine on a Ranney Day/);
  assert.match(init.body.result.instructions, /monthly:\d{4}-\d{2}/);
  assert.ok(!('resultType' in init.body.result), 'no 2026 fields for an earlier client');
  assert.equal((await rpc('initialize', { protocolVersion: '2099-01-01' })).body.result.protocolVersion, LEGACY[0]);
  const note = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
  assert.equal(note.status, 202);
  assert.deepEqual((await rpc('ping')).body.result, {});
  const list = await rpc('tools/list');
  assert.deepEqual(list.body.result.tools.map((t) => t.name), TOOLS.map((t) => t.name));
  assert.equal((await rpc('nope/never')).body.error.code, -32601);
  assert.equal((await rpc('tools/call', { name: 'delete_everything' })).body.error.code, -32602);
});

test('a 2026 client: no handshake, server/discover, every result complete and signed, the list cacheable; an unknown version is refused with ours', async () => {
  const d = await modern('server/discover');
  assert.deepEqual(d.body.result.supportedVersions, [...MODERN, ...LEGACY]);
  assert.equal(d.body.result.resultType, 'complete');
  assert.equal(d.body.result._meta['io.modelcontextprotocol/serverInfo'].name, 'soard');
  assert.deepEqual(d.body.result.capabilities, { tools: {}, prompts: {}, resources: {}, completions: {} });
  const list = await modern('tools/list');
  assert.equal(list.body.result.resultType, 'complete');
  assert.equal(list.body.result.cacheScope, 'private');
  assert.ok(list.body.result.ttlMs > 0);
  const bad = await modern('tools/list', {}, { version: '2031-01-01' });
  assert.equal(bad.status, 400, 'an unsupported version is a 400');
  assert.equal(bad.body.error.code, -32022);
  assert.deepEqual(bad.body.error.data, { supported: [...MODERN, ...LEGACY], requested: '2031-01-01' });
});

test('every tool says what it does, takes an object, and says whether it changes anything; none can send to a list or delete', () => {
  for (const t of TOOLS) {
    assert.ok(t.description.length > 40, t.name);
    assert.equal(t.inputSchema.type, 'object', t.name);
    assert.equal(typeof t.annotations.readOnlyHint, 'boolean', t.name);
    assert.equal(t.annotations.destructiveHint, false, t.name);
    assert.ok(!/delete|remove|schedule|send_to|publish/.test(t.name), t.name);
  }
  const writes = TOOLS.filter((t) => !t.annotations.readOnlyHint).map((t) => t.name);
  // Field work (daily logs, photos, the schedule) writes to JobTread as the person (tests/field.test.mjs)
  assert.deepEqual(writes, ['save_written_email', 'set_email_words', 'send_me_a_test', 'draft_in_kit', 'edit_page', 'create_page', 'daily_log', 'photo_slots', 'photos_done', 'change_task', 'task_changes', 'add_task']);
});

// ─── The tools ───

test('kids: found by name, and one in full with its photos and its emails’ keys', async () => {
  const found = data(await call('find_kids', { query: 'row' }));
  assert.equal(found.kids.length, 1);
  assert.equal(found.kids[0].slug, 'rowan-test');
  assert.deepEqual(found.kids[0].rooms, ['Accessible Bathroom']);
  const kid = data(await call('get_kid', { slug: 'rowan-test' }));
  assert.equal(kid.name, 'Rowan');
  assert.equal(kid.story, 'Rowan is nine and loves trains.');
  assert.ok(kid.photos.some((p) => p.id === 'kids/rowan-test/a.jpg' && p.alt === 'Rowan a'), 'photo ids a written email can use');
  assert.deepEqual(kid.partners, ['MSI']);
  // No JobTread here: the Kickoff and Project Reveal, not the invites
  assert.deepEqual(kid.emails.map((e) => e.key), ['kickoff:rowan-test', 'reveal:rowan-test']);
  const missing = await call('get_kid', { slug: 'nobody-here' });
  assert.equal(missing.isError, true);
  assert.match(missing.content[0].text, /find_kids/);
});

test('write an email, see what it needs, send it to me only, then draft it in Kit, all in History via Claude', async () => {
  const saved = data(await call('save_written_email', {
    subject: 'A Brighter Day Starts With You',
    preview: 'A safe shower changes everything.',
    blocks: [
      { type: 'cover', kicker: 'Giving Tuesday', headline: 'A Brighter Day Starts With *You*.', photo: { id: 'kids/rowan-test/a.jpg', alt: 'Rowan' }, buttonText: 'Give Today', url: 'https://sunshineonaranneyday.com/donate/' },
      { type: 'text', text: 'This year **14 families** got the room they needed.' },
      { type: 'give' },
    ],
  }));
  assert.match(saved.id, /^em_/);
  assert.deepEqual(saved.missing, []);
  assert.match(saved.admin, new RegExp(`/admin/#messages/write/${saved.id}$`));
  const got = data(await call('get_written_email', { id: saved.id }));
  assert.equal(got.blocks.length, 3);
  assert.equal(got.stands, 'not drafted');
  assert.equal(data(await call('list_written_emails')).emails[0].id, saved.id);
  // A test copy: to Linzi, and nobody else
  const sent = data(await call('send_me_a_test', { id: saved.id }));
  assert.equal(sent.to, LINZI);
  assert.equal(emails.length, 1);
  assert.deepEqual(emails[0].to, [LINZI]);
  assert.match(emails[0].subject, /^\[Preview\] A Brighter Day Starts With You$/);
  // A draft in Kit: a draft only, to the newsletter list
  const drafted = data(await call('draft_in_kit', { id: saved.id }));
  assert.equal(drafted.result, 'drafted');
  assert.match(drafted.kit, /^https:\/\/app\.kit\.com\/campaigns\/97\d\d$/);
  const b = [...kit.broadcasts.values()][0];
  assert.equal(b.send_at, null);
  assert.equal(b.public, false);
  const history = (await env.DB.prepare('SELECT user_email, entity_name FROM audit_log ORDER BY id').all()).results;
  assert.ok(history.length >= 3);
  assert.ok(history.every((h) => h.user_email === LINZI && /\(via Claude\)$/.test(h.entity_name)), JSON.stringify(history));
  // A bad block type is turned back with the right ones named
  const bad = await call('save_written_email', { subject: 'x', blocks: [{ type: 'script' }] });
  assert.equal(bad.isError, true);
  assert.match(bad.content[0].text, /cover, heading, text/);
});

test('the site’s own emails: its words and the site’s, saved words, a test copy with them', async () => {
  const words = data(await call('get_email_words', { key: 'kickoff:rowan-test' }));
  assert.deepEqual(words.parts.map((p) => p.part), ['subject', 'preview', 'opening', 'askHeadline', 'askWords', 'closing']);
  assert.equal(words.sitesWords.subject, 'Meet Rowan, Our Next Dream Room Project');
  assert.deepEqual(words.theirWords, {});
  const set = data(await call('set_email_words', { key: 'kickoff:rowan-test', words: { subject: 'Rowan’s room starts Monday', closing: 'With love, the SOARD crew.' } }));
  assert.equal(set.result, 'saved', 'nothing in Kit yet: kept for when it’s drafted');
  assert.equal(set.asItWillGo.subject, 'Rowan’s room starts Monday');
  assert.deepEqual(data(await call('get_email_words', { key: 'kickoff:rowan-test' })).theirWords, { subject: 'Rowan’s room starts Monday', closing: 'With love, the SOARD crew.' });
  const sent = data(await call('send_me_a_test', { key: 'kickoff:rowan-test' }));
  assert.equal(sent.sent, true);
  assert.equal(emails.at(-1).subject, '[Preview] Rowan’s room starts Monday');
  assert.deepEqual(emails.at(-1).to, [LINZI]);
  assert.equal((await call('set_email_words', { key: 'press:x', words: {} })).isError, true);
});

// ─── The 2026 transport’s own rules ───

test('a 2026 request’s headers must match its body; an unknown method is a 404; a batch is refused; a page on another site is turned away', async () => {
  const none = await modern('tools/list', {}, { headers: {} });
  assert.equal(none.status, 400);
  assert.equal(none.body.error.code, -32020, 'no MCP-Protocol-Version header');
  const wrongMethod = await modern('tools/list', {}, { headers: { 'MCP-Protocol-Version': V26, 'Mcp-Method': 'prompts/list' } });
  assert.equal(wrongMethod.body.error.code, -32020);
  const noName = await modern('tools/call', { name: 'find_kids', arguments: {} }, { headers: { 'MCP-Protocol-Version': V26, 'Mcp-Method': 'tools/call' } });
  assert.equal(noName.body.error.code, -32020, 'tools/call needs Mcp-Name');
  const wrongName = await modern('tools/call', { name: 'find_kids', arguments: {} }, { headers: { 'MCP-Protocol-Version': V26, 'Mcp-Method': 'tools/call', 'Mcp-Name': 'get_kid' } });
  assert.equal(wrongName.body.error.code, -32020);
  const b64 = await modern('tools/call', { name: 'find_kids', arguments: {} }, { headers: { 'MCP-Protocol-Version': V26, 'Mcp-Method': 'tools/call', 'Mcp-Name': `=?base64?${Buffer.from('find_kids').toString('base64')}?=` } });
  assert.equal(b64.status, 200, 'a base64 Mcp-Name is read');
  assert.equal(b64.body.result.resultType, 'complete');
  const lost = await modern('nope/never');
  assert.equal(lost.status, 404);
  assert.equal(lost.body.error.code, -32601);
  // An earlier client sends no such headers, and gets 200s as before
  assert.equal((await rpc('nope/never')).status, 200);
  const batch = await post([{ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': V26 } } }]);
  assert.equal(batch.status, 400);
  const legacyBatch = await post([{ jsonrpc: '2.0', id: 1, method: 'ping' }, { jsonrpc: '2.0', id: 2, method: 'tools/list' }]);
  assert.equal(legacyBatch.body.length, 2, 'an earlier client may still batch');
  assert.equal((await rpc('ping', {}, { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await rpc('ping', {}, { headers: { Origin: 'https://claude.ai' } })).status, 200);
  assert.equal((await rpc('ping', {}, { headers: { Origin: 'https://0123456789abcdef0123456789abcdef.claudemcpcontent.com' } })).status, 200);
});

// ─── Prompts, resources, completions, the preview ───

test('prompts: the + menu’s starting points, each only telling Claude what to do with the tools', async () => {
  const list = await rpc('prompts/list');
  const names = list.body.result.prompts.map((p) => p.name);
  assert.deepEqual(names, ['event_recap', 'monthly_impact', 'new_email', 'reveal_prep', 'thank_donors', 'this_week', 'update_page']);
  for (const p of list.body.result.prompts) { assert.ok(p.title && p.description, p.name); assert.ok(Array.isArray(p.arguments), p.name); }
  const got = await rpc('prompts/get', { name: 'event_recap', arguments: { event: 'gala' } });
  const said = got.body.result.messages[0].content.text;
  assert.match(said, /“gala”/);
  assert.match(said, /get_event/);
  assert.match(said, /Change nothing until I say so/);
  assert.equal((await rpc('prompts/get', { name: 'event_recap', arguments: {} })).body.error.code, -32602, 'its event is needed');
  assert.equal((await rpc('prompts/get', { name: 'nope' })).body.error.code, -32602);
  assert.match((await rpc('prompts/get', { name: 'monthly_impact' })).body.result.messages[0].content.text, /monthly:\d{4}-\d{2}/);
  const m = await modern('prompts/list');
  assert.equal(m.body.result.cacheScope, 'private');
});

test('resources: the guides, SOARD’s facts, a kid’s page, and the email preview with what its frame may load', async () => {
  const list = (await rpc('resources/list')).body.result.resources.map((r) => r.uri);
  assert.deepEqual(list, ['soard://guide/voice', 'soard://guide/emails', 'soard://facts'], 'the preview is read by its hosts, never attached');
  const voice = (await rpc('resources/read', { uri: 'soard://guide/voice' })).body.result.contents[0];
  assert.equal(voice.mimeType, 'text/markdown');
  assert.match(voice.text, /No em dashes/);
  assert.ok(!/—/.test(voice.text), 'the voice guide follows itself');
  assert.match((await rpc('resources/read', { uri: 'soard://guide/emails' })).body.result.contents[0].text, /cover/);
  assert.match((await rpc('resources/read', { uri: 'soard://facts' })).body.result.contents[0].text, /^# /);
  const kid = (await rpc('resources/read', { uri: 'soard://kids/rowan-test' })).body.result.contents[0];
  assert.match(kid.text, /Rowan/);
  assert.match(kid.text, /loves trains/);
  assert.equal((await rpc('resources/read', { uri: 'soard://kids/nobody' })).body.error.code, -32002);
  assert.equal((await modern('resources/read', { uri: 'soard://kids/nobody' })).body.error.code, -32602, '2026: not found is invalid params');
  const templates = (await rpc('resources/templates/list')).body.result.resourceTemplates.map((t) => t.uriTemplate);
  assert.deepEqual(templates, ['soard://kids/{slug}', 'soard://events/{slug}']);
  const app = (await rpc('resources/read', { uri: 'ui://soard/email-preview' })).body.result.contents[0];
  assert.equal(app.mimeType, 'text/html;profile=mcp-app');
  const sdk = /import \{ App \} from "([^"]+)"/.exec(app.text)?.[1];
  assert.equal(sdk, 'https://sunshineonaranneyday.com/mcp-app/ext-apps-1.7.5.js');
  assert.ok(existsSync('public/mcp-app/ext-apps-1.7.5.js'), 'the SDK is served from the site itself');
  assert.ok(app._meta.ui.csp.resourceDomains.includes('https://sunshineonaranneyday.com'));
  assert.ok(app._meta.ui.csp.resourceDomains.includes('https://imagedelivery.net'), 'the emails’ pictures load');
  const done = await rpc('completion/complete', { ref: { type: 'ref/prompt', name: 'reveal_prep' }, argument: { name: 'kid', value: 'row' } });
  assert.deepEqual(done.body.result.completion.values, ['rowan-test']);
  const months = await rpc('completion/complete', { ref: { type: 'ref/prompt', name: 'monthly_impact' }, argument: { name: 'month', value: '' } });
  assert.equal(months.body.result.completion.values.length, 6);
});

test('the email is drawn in the chat: show_email and the saves point at the preview; only the preview asks for the HTML', async () => {
  const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t]));
  for (const n of ['show_email', 'save_written_email', 'set_email_words']) assert.equal(byName[n]._meta?.ui?.resourceUri, 'ui://soard/email-preview', n);
  assert.deepEqual(byName.email_html._meta.ui.visibility, ['app']);
  assert.equal(byName.find_kids._meta, undefined);
  const saved = data(await call('save_written_email', { subject: 'Rowan’s room', blocks: [{ type: 'text', text: 'Hello.' }] }));
  const shown = await call('show_email', { id: saved.id });
  assert.equal(data(shown).subject, 'Rowan’s room');
  assert.ok(!JSON.stringify(shown).includes('<html'), 'Claude never carries the HTML');
  const html = await call('email_html', { id: saved.id });
  assert.match(html.structuredContent.html, /Hello\./);
  assert.ok((await call('show_email', {})).isError);
});

// ─── Every input checked against its tool’s own schema ───

test('a wrong input comes back as the tool’s error, saying what to fix, and nothing runs', async () => {
  const bad = await call('find_kids', { status: 'bogus' });
  assert.ok(bad.isError);
  assert.match(bad.content[0].text, /Status should be one of: in-progress, completed/);
  assert.match((await call('find_kids', { colour: 'red' })).content[0].text, /Colour isn’t one of this tool’s inputs/);
  assert.match((await call('get_kid', {})).content[0].text, /Slug is needed/);
  assert.match((await call('recent_gifts', { days: 9999 })).content[0].text, /Days should be at most 400/);
  assert.match((await call('edit_page', { kind: 'kids', slug: 'rowan-test', version: 'x', changes: { bio: { x: 1 } } })).content[0].text, /Changes\.bio should be a string or a number or a boolean/);
});

// ─── Pages ───

const aud = async () => (await env.DB.prepare('SELECT user_email, action, entity_type, entity_slug, entity_name FROM audit_log ORDER BY id').all()).results;

test('pages: find, read and change a kid’s words as the admin saves them; never a newer edit, a script, a name or a photo', async () => {
  const found = data(await call('find_pages', { kind: 'kids', query: 'rowan' }));
  assert.equal(found.pages[0].slug, 'rowan-test');
  assert.match(found.pages[0].admin, /#kids\/rowan-test$/);
  const page = data(await call('get_page', { kind: 'kids', slug: 'rowan-test' }));
  assert.match(page.fields.bio, /loves trains/);
  assert.ok(page.setInTheAdmin.includes('name') && page.setInTheAdmin.includes('publishStatus') && page.setInTheAdmin.includes('heroImage'));
  assert.ok(!('name' in page.fields) && !('heroImage' in page.fields));
  assert.match(page.version, /^[0-9a-f]{40}$/);
  const edit = (changes, version = page.version) => call('edit_page', { kind: 'kids', slug: 'rowan-test', version, changes });
  assert.match((await edit({ bio: '<p>Hi</p><script>alert(1)</script>' })).content[0].text, /<script> can’t go on a page/);
  assert.match((await edit({ bio: '<p onclick="x()">Hi</p>' })).content[0].text, /takes no attributes/);
  assert.match((await edit({ bio: '<a href="javascript:alert(1)">x</a>' })).content[0].text, /<a href="https:/);
  assert.match((await edit({ name: 'Ro' })).content[0].text, /set in the admin/);
  assert.match((await edit({ heroImage: 'https://example.com/x.jpg' })).content[0].text, /set in the admin/);
  assert.match((await edit({ fundraisingUrl: 'https://example.com/give' })).content[0].text, /set in the admin/, 'a give link is Site Config → Zeffy’s');
  assert.match((await edit({ bio: '<p>Give at <a href="https://www.zeffy.com/donation-form/x">Zeffy</a></p>' })).content[0].text, /Site Config → Zeffy/);
  assert.match((await edit({ bio: 'x' }, 'f'.repeat(40))).content[0].text, /Someone changed this page/);
  const r = await edit({ bio: '<p>Rowan is nine, loves trains, and has a <a href="https://sunshineonaranneyday.com/">new room</a>.</p>' });
  assert.ok(!r.isError, r.content[0].text);
  assert.equal(data(r).saved, true);
  assert.match(data(r).said, /Publish/);
  const row = JSON.parse((await env.DB.prepare('SELECT data FROM kids WHERE slug = ?').bind('rowan-test').first()).data);
  assert.match(row.bio, /new room/);
  assert.equal(row.name, 'Rowan', 'the rest of the record is as it was');
  assert.deepEqual(row.photos, KID.photos);
  const last = (await aud()).at(-1);
  assert.equal(last.user_email, LINZI);
  assert.equal(last.entity_type, 'kids');
  assert.equal(last.entity_name, 'Rowan (via Claude)');
  assert.match((await edit({ bio: 'again' })).content[0].text, /Someone changed this page/, 'the old version no longer saves');
  const again = await call('get_page', { kind: 'kids', slug: 'rowan-test' });
  assert.equal(data(again).version, data(r).version);
  const waiting = data(await call('changes_not_live'));
  assert.ok(waiting.waiting.some((w) => w.slug === 'rowan-test'), JSON.stringify(waiting));
  const changes = data(await call('recent_changes', { query: 'Rowan' }));
  assert.ok(changes.changes.some((c) => c.name === 'Rowan (via Claude)'));
});

// ─── Gifts, and what stays with others ───

test('gifts come straight from Zeffy, less tests and refunds; a gift asked to be anonymous says so', async () => {
  const now = Math.floor(Date.now() / 1000);
  assert.match((await call('recent_gifts', {})).content[0].text, /Zeffy isn’t connected/);
  env.ZEFFY_API_KEY = 'zeffy_test';
  zeffy = [
    { id: 'pay_aaaaaa1', status: 'succeeded', amount: 5000, currency: 'usd', created: now - 3600, description: 'Gala 2026', buyer: { first_name: 'Jane', last_name: 'Doe', email: 'jane@example.com' } },
    { id: 'pay_aaaaaa2', status: 'succeeded', amount: 25000, currency: 'usd', created: now - 7200, description: 'Monthly', buyer: { first_name: 'Sam', last_name: 'Lee', email: 'sam@example.com' }, buyer_questions: [{ question: 'Give anonymously?', answer: 'Yes' }], recurring: { is_recurring: true, interval: 'month' } },
    { id: 'pay_aaaaaa3', status: 'succeeded', amount: 1000, currency: 'usd', created: now - 60, refund_status: 'full', buyer: { first_name: 'Re', last_name: 'Fund' } },
  ];
  const g = data(await call('recent_gifts', { days: 3 }));
  assert.equal(g.gifts, 2);
  assert.equal(g.total, 300);
  assert.deepEqual(g.list.map((x) => x.from), ['Sam Lee', 'Jane Doe'], 'newest day first, then the biggest');
  const sam = g.list.find((x) => x.from === 'Sam Lee');
  assert.match(sam.anonymous, /never name them/);
  assert.equal(sam.every, 'monthly');
  assert.equal(data(await call('recent_gifts', { query: 'gala' })).gifts, 1);
  assert.equal(data(await call('recent_gifts', { min: 100 })).gifts, 1);
  zeffy = [];
});

test('Drive search stays the founders’; every other new tool answers on a site with nothing in it yet', async () => {
  assert.ok((await call('search_drive', { query: 'w-9' })).isError);
  for (const [name, args] of [['kid_room', {}], ['shipments', {}], ['whose_box', { trackingNumbers: ['1Z999AA10123456784'] }], ['checks_waiting', {}],
    ['find_partners', {}], ['find_families', {}], ['vendor_papers', {}], ['find_pages', {}]]) {
    const r = await call(name, args);
    assert.ok(r.content?.[0]?.text, name);
    assert.ok(!/didn’t work \(/.test(r.content[0].text), `${name}: ${r.content[0].text}`);
  }
  assert.match((await call('whose_box', {})).content[0].text, /what’s on the label/);
});

test('every call is logged (who, which tool, how long, whether it worked), never what it said', async () => {
  await call('find_kids', {});
  await call('find_kids', { status: 'bogus' });
  await callTool(env, 'get_kid', { slug: 'nobody' }, LINZI);
  const rows = (await env.DB.prepare('SELECT email, tool, ok, problem FROM mcp_calls ORDER BY id').all()).results;
  assert.deepEqual(rows.map((r) => [r.tool, r.ok]), [['find_kids', 1], ['get_kid', 0]], 'a refused input never ran, so it isn’t a call');
  assert.equal(rows[0].email, LINZI);
  assert.match(rows[1].problem, /no kid page/);
});

// ─── The shared pages, lists, the build’s rules, new pages ───

const FAQ = { categories: [{ id: 'general', label: 'General', showOnDonatePage: false }], items: [
  { id: 'who', question: 'Who do you help?', answer: 'Kids with special needs.', category: 'general', order: 1 },
  { id: 'cost', question: 'Does it cost anything?', answer: 'No.', category: 'general', order: 2 },
  { id: 'old', question: 'An old question', answer: 'Out of date.', category: 'general', order: 3 },
] };
const site = async (key, doc) => env.DB.prepare('INSERT OR REPLACE INTO site_config (key, data, updated_at) VALUES (?, ?, ?)').bind(key, JSON.stringify(doc), '2026-11-01T00:00:00Z').run();
const doc = async (key) => JSON.parse((await env.DB.prepare('SELECT data FROM site_config WHERE key = ?').bind(key).first()).data);

test('the FAQ: an answer changed by its path, a new question shaped like the others, an old one taken out, in one save', async () => {
  await site('faq', FAQ);
  await site('broadcast-config', { streamKey: 'secret' });
  const found = data(await call('find_pages', { kind: 'site' }));
  assert.deepEqual(found.pages.map((p) => p.slug), ['faq'], 'only the shared pages, never the site’s runtime records');
  const page = data(await call('get_page', { kind: 'site', slug: 'faq' }));
  assert.equal(page.fields['items[1].answer'], 'No.');
  assert.ok(!('items[0].id' in page.fields), 'ids stay the site’s');
  assert.deepEqual(page.lists.items.of.sort(), ['answer', 'category', 'id', 'order', 'question']);
  assert.match(data(await call('get_page', { kind: 'site', slug: 'broadcast-config' })) ?? '', /./, 'not a shared page');
  const r = await call('edit_page', { kind: 'site', slug: 'faq', version: page.version,
    changes: { 'items[1].answer': 'No. Every makeover is free to the family.' },
    add: [{ to: 'items', item: { question: 'How do I apply?', answer: 'From the Apply page.', category: 'general' } }],
    remove: ['items[2]'] });
  assert.ok(!r.isError, r.content[0].text);
  assert.deepEqual(data(r).changed, ['items[1].answer']);
  assert.deepEqual(data(r).removed, ['items[2]']);
  const after = await doc('faq');
  assert.deepEqual(after.items.map((i) => i.id), ['who', 'cost', 'how-do-i-apply'], 'the new one got an id like its siblings; the old one is gone');
  assert.equal(after.items[2].order, 4);
  assert.equal(after.items[1].answer, 'No. Every makeover is free to the family.');
  assert.deepEqual(after.categories, FAQ.categories, 'the rest is as it was');
  const v = data(await call('get_page', { kind: 'site', slug: 'faq' })).version;
  assert.match((await call('edit_page', { kind: 'site', slug: 'faq', version: v, add: [{ to: 'items', item: { question: 'x', colour: 'red' } }] })).content[0].text, /not colour/);
  assert.match((await call('edit_page', { kind: 'site', slug: 'faq', version: v, changes: { 'items[0].order': 'first' } })).content[0].text, /takes a number/);
  assert.match((await call('edit_page', { kind: 'site', slug: 'faq', version: v, changes: { 'items[0].id': 'x' } })).content[0].text, /set in the admin/);
  assert.match((await call('edit_page', { kind: 'site', slug: 'faq', version: v, remove: ['items[9]'] })).content[0].text, /isn’t an item/);
  const last = (await aud()).at(-1);
  assert.equal(last.entity_type, 'faq');
  assert.match(last.entity_name || '', /via Claude/);
});

test('words on a picture change where the picture can’t; the build’s own rules stop a change it would refuse', async () => {
  const page = data(await call('get_page', { kind: 'kids', slug: 'rowan-test' }));
  assert.equal(page.fields['photos[1].alt'], 'Rowan b');
  assert.ok(!('photos[1].url' in page.fields));
  const r = await call('edit_page', { kind: 'kids', slug: 'rowan-test', version: page.version, changes: { 'photos[1].alt': 'Rowan with his train set' } });
  assert.ok(!r.isError, r.content[0].text);
  const kid = JSON.parse((await env.DB.prepare('SELECT data FROM kids WHERE slug = ?').bind('rowan-test').first()).data);
  assert.equal(kid.photos[1].alt, 'Rowan with his train set');
  assert.equal(kid.photos[1].url, KID.photos[1].url);
  // A Press story whose category isn't one the build knows would stop the next Publish: never saved
  const story = { slug: 'ajc-story', outlet: 'AJC', category: 'print', title: 'A room for Rowan', date: '2026-10-01', url: 'https://www.ajc.com/x', excerpt: 'A story.' };
  await env.DB.prepare('INSERT INTO press (slug, data) VALUES (?, ?)').bind(story.slug, JSON.stringify(story)).run();
  const p = data(await call('get_page', { kind: 'press', slug: 'ajc-story' }));
  assert.deepEqual(p.choices.category, ['national-tv', 'local-tv', 'print', 'magazine', 'entertainment']);
  const bad = await call('edit_page', { kind: 'press', slug: 'ajc-story', version: p.version, changes: { category: 'blog' } });
  assert.match(bad.content[0].text, /build would refuse this.*category/);
  assert.equal(JSON.parse((await env.DB.prepare('SELECT data FROM press WHERE slug = ?').bind('ajc-story').first()).data).category, 'print');
});

test('new pages: checked against the build, hidden where the build has the switch; never a kid’s page or a person', async () => {
  const story = { outlet: 'WSB-TV', category: 'local-tv', title: 'SOARD on WSB', date: '2026-11-01', url: 'https://www.wsbtv.com/x', excerpt: 'A reveal on the news.' };
  const made = await call('create_page', { kind: 'press', fields: story });
  assert.ok(!made.isError, made.content[0].text);
  assert.equal(data(made).slug, 'soard-on-wsb');
  const row = JSON.parse((await env.DB.prepare('SELECT data FROM press WHERE slug = ?').bind('soard-on-wsb').first()).data);
  assert.equal(row.outlet, 'WSB-TV');
  assert.equal(row.slug, 'soard-on-wsb');
  assert.match((await call('create_page', { kind: 'press', fields: story })).content[0].text, /already/);
  assert.match((await call('create_page', { kind: 'press', fields: { title: 'No outlet' } })).content[0].text, /build would refuse this page.*outlet/);
  assert.match((await call('create_page', { kind: 'press', fields: { ...story, title: 'Logo', outletLogo: 'x' } })).content[0].text, /set in the admin/);
  const project = await call('create_page', { kind: 'community', fields: { name: 'Hope House', impact: '12', impactLabel: 'kids a year', year: '2027', description: 'A sensory room.' } });
  assert.ok(!project.isError, project.content[0].text);
  assert.match(data(project).said, /hidden/);
  assert.equal(JSON.parse((await env.DB.prepare('SELECT data FROM community WHERE slug = ?').bind('hope-house').first()).data).publishStatus, 'draft');
  assert.match((await call('create_page', { kind: 'kids', fields: { name: 'Ava' } })).content[0].text, /Approved/);
  assert.ok((await call('create_page', { kind: 'people', fields: { name: 'X' } })).isError, 'a person is added in People');
  assert.ok((await call('create_page', { kind: 'site', fields: { name: 'x' } })).isError);
  assert.ok((await aud()).some((a) => a.entity_name === 'SOARD on WSB (via Claude)' && a.action === 'created'));
});

test('automations: Site → Automations’ own verdicts on the live facts, the ones needing a look by default', async () => {
  const r = await call('automations', {});
  assert.ok(!r.isError, r.content[0].text);
  const a = data(r);
  assert.ok(Object.values(a.counts).reduce((s, n) => s + n, 0) > 20, 'every entry on the map');
  assert.ok(a.automations.every((x) => x.status !== 'Working'));
  assert.ok(a.automations.some((x) => x.why), 'with why');
  const zeffy = data(await call('automations', { query: 'zeffy' }));
  assert.ok(zeffy.automations.length >= 1);
  assert.ok(zeffy.automations.every((x) => /zeffy/i.test(`${x.name} ${x.area} ${x.uses.join(' ')}`)));
});

test('the build’s rules the connection checks against are src/content/config.ts as it is now (run scripts/mcp-content-schema.mjs after changing it)', async () => {
  assert.equal(readFileSync(SCHEMA_OUT, 'utf8'), await contentSchemaSource());
});

test('the shared pages as they really are: Our Story’s paragraphs and timeline, golf’s tiers and sponsors, the home page; never their photos or picks', async () => {
  await site('our-story', {
    stats: { totalKids: 300, totalRooms: 400, years: 15, communityKids: 2000 }, images: { hero: 'cf-hero', founder: 'cf-founder' },
    founders: { label: 'Our founders', heading: 'Where it began', paragraphs: ['One.', 'Two.'] },
    milestones: [{ year: '2010', title: 'The first room', desc: 'It began.', image: 'cf-a' }, { year: '2015', title: 'Five years', desc: 'More.', image: 'cf-b' }],
  });
  await site('golf', {
    testimonial: { quote: 'Great day.', name: 'Sam', title: 'Golfer' }, faqs: [{ question: 'When?', answer: 'May.' }],
    sponsors: [{ tier: 'Presenting', size: 'lg', names: [{ name: 'Acme' }] }], galleryPhotos: [{ id: 'cf-g1', alt: 'A swing' }],
    tiers: { main: [{ name: 'Foursome', price: '$1,000', detail: 'Four players', perk: 'Lunch', badge: '', badgeStyle: '', highlight: '', status: 'available' }], addons: [] },
  });
  await site('settings', { name: 'SOARD', phone: '404-555-0100', email: 'hello@example.org', homeHero: { eyebrow: 'Hi', lead: 'We build rooms.' }, featuredKidSlug: 'rowan-test', kidShowcase: [{ slug: 'rowan-test', cfId: 'cf-x' }], donatePhotos: { hero: 'cf-d' } });
  const story = data(await call('get_page', { kind: 'site', slug: 'our-story' }));
  assert.equal(story.fields['founders.paragraphs[1]'], 'Two.');
  assert.equal(story.fields['stats.totalKids'], 300);
  assert.ok(!('images.hero' in story.fields) && !('milestones[0].image' in story.fields), 'photos stay the admin’s');
  assert.equal(story.lists['founders.paragraphs'].of, 'words');
  const r = await call('edit_page', { kind: 'site', slug: 'our-story', version: story.version,
    changes: { 'founders.paragraphs[0]': 'It began with one room.', 'stats.totalKids': 312 },
    add: [{ to: 'founders.paragraphs', item: 'Three.' }, { to: 'milestones', item: { year: '2026', title: 'Fifteen years', desc: 'And counting.' } }] });
  assert.ok(!r.isError, r.content[0].text);
  const s = await doc('our-story');
  assert.deepEqual(s.founders.paragraphs, ['It began with one room.', 'Two.', 'Three.']);
  assert.equal(s.stats.totalKids, 312);
  assert.deepEqual(s.milestones[2], { year: '2026', title: 'Fifteen years', desc: 'And counting.' }, 'a new year on the timeline; its photo is added in the admin');
  assert.match((await call('edit_page', { kind: 'site', slug: 'our-story', version: (await call('get_page', { kind: 'site', slug: 'our-story' })).structuredContent.version, add: [{ to: 'milestones', item: { year: '2027', image: 'cf-z' } }] })).content[0].text, /set in the admin/);
  const golf = data(await call('get_page', { kind: 'site', slug: 'golf' }));
  assert.equal(golf.fields['tiers.main[0].status'], 'available', 'a tier’s status is words on the golf page');
  assert.equal(golf.fields['sponsors[0].names[0].name'], 'Acme', 'a golf sponsor is words, not a room credit');
  assert.equal(golf.fields['galleryPhotos[0].alt'], 'A swing');
  assert.ok(!('galleryPhotos[0].id' in golf.fields));
  const g = await call('edit_page', { kind: 'site', slug: 'golf', version: golf.version, changes: { 'tiers.main[0].perk': 'Lunch and a cart', 'tiers.main[0].status': 'sold out' }, add: [{ to: 'sponsors[0].names', item: { name: 'Beta Co' } }] });
  assert.ok(!g.isError, g.content[0].text);
  assert.deepEqual((await doc('golf')).sponsors[0].names, [{ name: 'Acme' }, { name: 'Beta Co' }]);
  const home = data(await call('get_page', { kind: 'site', slug: 'settings' }));
  assert.equal(home.fields['homeHero.lead'], 'We build rooms.');
  assert.equal(home.fields.phone, '404-555-0100', 'the site’s phone is words in Site Config');
  assert.ok(!('featuredKidSlug' in home.fields) && !('kidShowcase[0].slug' in home.fields) && !('donatePhotos.hero' in home.fields), 'which kid is featured and its photos are picked in the admin');
  // A kid’s sponsors are room credits: never words here
  const kid = data(await call('get_page', { kind: 'kids', slug: 'rowan-test' }));
  assert.match((await call('edit_page', { kind: 'kids', slug: 'rowan-test', version: kid.version, changes: { 'partnerLogos[0].name': 'X' } })).content[0].text, /set in the admin/);
});
