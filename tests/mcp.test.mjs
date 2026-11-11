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
import { TOOLS } from '../functions/api/_mcp-tools.js';
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
  name: 'Rowan', slug: 'rowan-test', publishStatus: 'published', status: 'in-progress', year: 2027, age: '9', roomTypes: ['Accessible Bathroom'],
  heroImage: `${IMG}/kids/rowan-test/hero.jpg/public`, heroSummary: 'Rowan loves trains.', bio: '<p>Rowan is nine and loves trains.</p>',
  photos: ['a', 'b', 'c'].map((n) => ({ url: `${IMG}/kids/rowan-test/${n}.jpg/public`, alt: `Rowan ${n}` })),
  partnerLogos: [{ url: `${IMG}/partners/msi/public`, name: 'MSI' }],
};

let kit; let emails;
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
async function post(body, { as = LINZI, aud = MCP_AUD, raw = false } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (as) headers['Cf-Access-Jwt-Assertion'] = await token(as, aud);
  const res = await onRequest({ request: new Request('https://sunshineonaranneyday.com/mcp', { method: 'POST', headers, body: JSON.stringify(body) }), env });
  if (raw) return res;
  return { status: res.status, body: res.status === 202 ? null : await res.json() };
}
const rpc = (method, params = {}, extra = {}) => post({ jsonrpc: '2.0', id: nextId++, method, params }, extra);
const modern = (method, params = {}) => rpc(method, { ...params, _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientInfo': { name: 'claude-ai', version: '1' } } });
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
  assert.deepEqual(init.body.result.capabilities, { tools: { listChanged: false } });
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
  assert.deepEqual(d.body.result.capabilities, { tools: {} });
  const list = await modern('tools/list');
  assert.equal(list.body.result.resultType, 'complete');
  assert.equal(list.body.result.cacheScope, 'private');
  assert.ok(list.body.result.ttlMs > 0);
  const bad = await rpc('tools/list', { _meta: { 'io.modelcontextprotocol/protocolVersion': '2031-01-01' } });
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
  assert.deepEqual(writes, ['save_written_email', 'set_email_words', 'send_me_a_test', 'draft_in_kit']);
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
