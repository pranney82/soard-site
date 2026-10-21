/**
 * The list is Kit's: newsletter signups, Kit drafts (and the editor's live
 * preview), and the editor's one-off sends (test copy, send to specific
 * people) through the site's one-off sender. Nothing list-related may touch
 * Resend.
 * Run: node --test tests/
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { onRequestPost as newsletterPost } from '../functions/api/newsletter.js';
import { onRequestPost as kitBroadcastPost } from '../functions/api/kit-broadcast.js';
import { onRequestPost as sendTestPost } from '../functions/api/send-test-email.js';
import { onRequestPost as sendDirectPost } from '../functions/api/send-direct.js';
import { kitMergeTags, fillMergeTags } from '../functions/api/_email-templates.js';

const realFetch = globalThis.fetch;
let calls;
let kit;     // { subscribeStatus, broadcastStatus }
let resend;  // { status }

beforeEach(() => {
  calls = [];
  kit = { subscribeStatus: 201, broadcastStatus: 201 };
  resend = { status: 200 };
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url;
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ url, method: init.method || 'GET', body, headers: init.headers });
    const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
    if (url === 'https://api.kit.com/v4/subscribers') return json({ subscriber: { id: 1 } }, kit.subscribeStatus);
    if (url.startsWith('https://api.kit.com/v4/tags')) return json({ tags: [{ id: 7, name: 'Newsletter' }], tag: { id: 7 } });
    if (url === 'https://api.kit.com/v4/broadcasts') return json(kit.broadcastStatus < 300 ? { broadcast: { id: 42 } } : { errors: ['nope'] }, kit.broadcastStatus);
    if (url === 'https://api.resend.com/emails/batch') return json(resend.status < 300 ? { data: body.map((_, i) => ({ id: `em${i}` })) } : { message: 'down' }, resend.status);
    throw new Error(`no fake for ${url}`);
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

const ctx = (path, body, env = {}, { form = false } = {}) => ({
  env,
  data: {},
  request: new Request(`https://sunshineonaranneyday.com${path}`, form
    ? { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: 'https://sunshineonaranneyday.com/about/' }, body: new URLSearchParams(body) }
    : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
});
const KIT = { KIT_API_KEY: 'kit-key' };
const RESEND = { RESEND_API_KEY: 're_test' };
const noResend = () => assert.equal(calls.filter(c => c.url.includes('resend.com')).length, 0, 'never touches Resend');

const BLOCKS = { blocks: [{ type: 'paragraph', text: 'Hi {{{FIRST_NAME|there}}}, this went to {{{EMAIL}}}.' }] };

// ─── Newsletter signup ───────────────────────────────────────────────

test('a signup lands in Kit only, tagged by its source', async () => {
  const res = await newsletterPost(ctx('/api/newsletter', { email: ' Fan@Example.com ', source: 'newsletter' }, { ...KIT, ...RESEND }));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true });
  const sub = calls.find(c => c.url === 'https://api.kit.com/v4/subscribers');
  assert.deepEqual(sub.body, { email_address: 'fan@example.com', state: 'active' });
  assert.ok(calls.some(c => c.url.includes('/v4/tags')), 'tagged');
  noResend();
});

test('Kit rejecting a signup is a 503 (never 502), and so is a missing Kit key', async () => {
  kit.subscribeStatus = 422;
  const rejected = await newsletterPost(ctx('/api/newsletter', { email: 'fan@example.com' }, KIT));
  assert.equal(rejected.status, 503);
  assert.equal((await rejected.json()).ok, false);

  const unset = await newsletterPost(ctx('/api/newsletter', { email: 'fan@example.com' }, RESEND));
  assert.equal(unset.status, 503);
  assert.match((await unset.json()).error, /not configured/);
  noResend();
});

test('form posts redirect back to the page; the honeypot answers OK without calling anyone', async () => {
  const ok = await newsletterPost(ctx('/api/newsletter', { email: 'fan@example.com' }, KIT, { form: true }));
  assert.equal(ok.status, 302);
  assert.equal(ok.headers.get('Location'), 'https://sunshineonaranneyday.com/about/?subscribed=1#newsletter-form');

  const unset = await newsletterPost(ctx('/api/newsletter', { email: 'fan@example.com' }, {}, { form: true }));
  assert.match(unset.headers.get('Location'), /newsletter_error=not_configured/);

  calls = [];
  const bot = await newsletterPost(ctx('/api/newsletter', { email: 'bot@example.com', website: 'spam' }, KIT, { form: true }));
  assert.match(bot.headers.get('Location'), /subscribed=1/);
  assert.equal(calls.length, 0);
});

// ─── Kit drafts and the editor preview ───────────────────────────────

test('the editor preview renders without Kit and calls nobody', async () => {
  const res = await kitBroadcastPost(ctx('/api/kit-broadcast', { preview: true, data: BLOCKS, opts: { subject: 'Hello' } }, {}));
  assert.equal(res.status, 200);
  const d = await res.json();
  assert.equal(d.ok, true);
  assert.match(d.previewHtml, /Unsubscribe/);
  assert.equal(calls.length, 0);
});

test('a Kit draft carries Kit merge tags, never the editor or Resend ones', async () => {
  const res = await kitBroadcastPost(ctx('/api/kit-broadcast', { data: BLOCKS, opts: { subject: 'Hi {{{FIRST_NAME|friend}}}', preheader: 'For {{{EMAIL}}}' } }, KIT));
  assert.equal(res.status, 200);
  assert.equal((await res.json()).broadcastId, 42);
  const draft = calls.find(c => c.url === 'https://api.kit.com/v4/broadcasts').body;
  assert.equal(draft.send_at, null, 'a draft, staff send it from Kit');
  assert.match(draft.content, /href="\{\{ unsubscribe_url \}\}"/);
  assert.ok(draft.content.includes('Hi {{ subscriber.first_name | default: "there" }}'));
  assert.ok(draft.content.includes('{{ subscriber.email_address }}'));
  assert.equal(draft.subject, 'Hi {{ subscriber.first_name | default: "friend" }}');
  assert.equal(draft.preview_text, 'For {{ subscriber.email_address }}');
  assert.doesNotMatch(JSON.stringify(draft), /\{\{\{|RESEND/);
  noResend();
});

test('a Kit outage is a 500 so the admin sees the message (Cloudflare hides 502 bodies)', async () => {
  kit.broadcastStatus = 503;
  const res = await kitBroadcastPost(ctx('/api/kit-broadcast', { data: BLOCKS, opts: { subject: 'Hello' } }, KIT));
  assert.equal(res.status, 500);
  assert.match((await res.json()).error, /Kit/);
  const unset = await kitBroadcastPost(ctx('/api/kit-broadcast', { data: BLOCKS, opts: { subject: 'Hello' } }, {}));
  assert.equal(unset.status, 503);
});

// ─── One-off sends from the editor ───────────────────────────────────

test('a test copy goes to one address with merge tags filled in and no unsubscribe link', async () => {
  const res = await sendTestPost(ctx('/api/send-test-email', { testEmail: 'peter@example.com', data: BLOCKS, opts: { subject: 'Hello {{{FIRST_NAME|there}}}' } }, RESEND));
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { ok: true, to: 'peter@example.com' });
  const batch = calls.find(c => c.url === 'https://api.resend.com/emails/batch').body;
  assert.equal(batch.length, 1);
  assert.deepEqual(batch[0].to, ['peter@example.com']);
  assert.equal(batch[0].subject, '[TEST] Hello there');
  assert.ok(batch[0].html.includes('Hi there, this went to peter@example.com.'));
  assert.match(batch[0].html, /href="#"[^>]*>Unsubscribe/);
  assert.doesNotMatch(batch[0].html, /\{\{/);
});

test('"Send it to me": no address sends the test copy to the person signed in', async () => {
  const me = { ...ctx('/api/send-test-email', { data: BLOCKS, opts: { subject: 'Hello' } }, RESEND), data: { userEmail: 'linzi@soardcharity.com' } };
  assert.deepEqual(await (await sendTestPost(me)).json(), { ok: true, to: 'linzi@soardcharity.com' });
  assert.deepEqual(calls.find(c => c.url === 'https://api.resend.com/emails/batch').body[0].to, ['linzi@soardcharity.com']);
  // A typed address wins; a bad one is refused in plain words
  const other = { ...ctx('/api/send-test-email', { testEmail: 'peter@example.com', data: BLOCKS }, RESEND), data: { userEmail: 'linzi@soardcharity.com' } };
  assert.equal((await (await sendTestPost(other)).json()).to, 'peter@example.com');
  const bad = await sendTestPost({ ...ctx('/api/send-test-email', { testEmail: 'nope', data: BLOCKS }, RESEND), data: { userEmail: 'linzi@soardcharity.com' } });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error, 'That isn’t an email address.');
});

test('send to specific people: one copy each, deduped, each with their own address', async () => {
  const res = await sendDirectPost(ctx('/api/send-direct', { recipients: ['A@x.com', 'b@x.com', 'a@x.com'], data: BLOCKS, opts: { subject: 'Invite' } }, RESEND));
  assert.deepEqual(await res.json(), { ok: true, count: 2 });
  const batch = calls.find(c => c.url === 'https://api.resend.com/emails/batch').body;
  assert.deepEqual(batch.map(m => m.to[0]), ['a@x.com', 'b@x.com']);
  assert.ok(batch[0].html.includes('this went to a@x.com.'));
  assert.ok(batch[1].html.includes('this went to b@x.com.'));

  const tooMany = await sendDirectPost(ctx('/api/send-direct', { recipients: Array.from({ length: 101 }, (_, i) => `p${i}@x.com`), data: BLOCKS }, RESEND));
  assert.equal(tooMany.status, 400);
});

test('editor sends report a failed send and a missing key plainly', async () => {
  resend.status = 500;
  const failed = await sendDirectPost(ctx('/api/send-direct', { recipients: ['a@x.com'], data: BLOCKS }, RESEND));
  assert.equal(failed.status, 500);
  assert.equal((await failed.json()).ok, false);
  const testFailed = await sendTestPost(ctx('/api/send-test-email', { testEmail: 'a@x.com', data: BLOCKS }, RESEND));
  assert.equal(testFailed.status, 500);

  const unset = await sendTestPost(ctx('/api/send-test-email', { testEmail: 'a@x.com', data: BLOCKS }, {}));
  assert.equal(unset.status, 503);
});

test('merge tag translation covers every editor tag, old last-name tags included', () => {
  const s = '{{{FIRST_NAME|there}}} {{{FIRST_NAME}}} {{{LAST_NAME}}} {{{EMAIL}}} {{{UNSUBSCRIBE_URL}}}';
  assert.equal(kitMergeTags(s), '{{ subscriber.first_name | default: "there" }} {{ subscriber.first_name | default: "" }}  {{ subscriber.email_address }} {{ unsubscribe_url }}');
  assert.equal(fillMergeTags(s, { email: 'a@x.com' }), 'there   a@x.com #');
});
