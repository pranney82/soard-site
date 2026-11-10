/**
 * Write an email (Emails & invites): staff write the middle, the site wraps it
 * in the same layout as every email it drafts, sends a [Preview] copy, and
 * drafts it in Kit (never sends). Kit, Resend and Cloudflare Images are faked.
 * Run: node --test tests/custom-emails.test.mjs
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { customEmail, cleanEmail, emailProblems, videoOf, imageId, customImageUrls } from '../functions/api/_custom-email.js';
import { saveCustomEmail, readCustomEmail, listCustomEmails, removeCustomEmail, draftCustomEmail, sendCustomPreview, customEmailStatus } from '../functions/api/_custom-emails.js';
import { onRequestPost } from '../functions/api/custom-emails-admin.js';
import { writeConfig } from '../functions/api/_reveal-invites.js';

const IMG = 'https://imagedelivery.net/ROYFuPmfN2vPS6mt5sCkZQ';
const LINZI = 'linzi@soardcharity.com';
const PETER = 'peter@soardcharity.com';
const EMAIL = {
  subject: 'A Brighter Day Starts With You',
  preview: 'Sometimes, a brighter day starts with something as simple as a safe shower.',
  blocks: [
    { type: 'cover', kicker: 'Giving Tuesday', headline: 'A Brighter Day Starts With *You*.', photo: { id: 'emails/written/x/top.jpg', alt: 'Isla in her room' }, buttonText: 'Give Today', url: 'https://sunshineonaranneyday.com/donate/' },
    { type: 'text', text: 'Sometimes, a brighter day starts with a safe shower.\n\nThis year **14 families** got the room they needed. Read [Isla’s story](https://sunshineonaranneyday.com/kids/isla/) — one of our favorites.' },
    { type: 'photo', id: 'emails/written/x/canva.png', wide: true },
    { type: 'video', url: 'https://youtu.be/abcdefghijk', caption: 'Watch the reveal' },
    { type: 'give' },
  ],
};

let kit; let emails;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  const method = (init.method || 'GET').toUpperCase();
  const body = init.body ? JSON.parse(init.body) : null;
  if (url.startsWith('https://api.kit.com/v4/')) {
    const path = url.slice('https://api.kit.com/v4'.length);
    kit.calls.push(`${method} ${path.split('?')[0]}`);
    if (path.startsWith('/tags')) return Response.json({ tags: [{ id: 555, name: 'Application Waitlist only (no newsletter)' }] });
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
    if (one && method === 'PUT') {
      const b = kit.broadcasts.get(one[1]);
      kit.puts.push({ id: one[1], ...body });
      kit.broadcasts.set(one[1], { ...b, ...body, subscriber_filter: body.subscriber_filter || [{ all: [{ type: 'all_subscribers' }], any: null, none: null }] });
      return Response.json({ broadcast: kit.broadcasts.get(one[1]) });
    }
    return Response.json({ errors: ['unexpected'] }, { status: 500 });
  }
  if (url.startsWith('https://imagedelivery.net/') || url.startsWith('https://i.ytimg.com/')) {
    if (/broken|hq720/.test(url)) return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
    return new Response('img', { headers: { 'Content-Type': 'image/jpeg' } });
  }
  if (url.startsWith('https://api.resend.com/emails/batch')) {
    for (const e of body) emails.push(e);
    return Response.json({ data: body.map((_, i) => ({ id: `re_${emails.length}_${i}` })) });
  }
  throw new Error(`unexpected fetch ${url}`);
};
after(() => { globalThis.fetch = realFetch; });

let env;
beforeEach(async () => {
  kit = { broadcasts: new Map(), calls: [], puts: [], next: 9501 };
  emails = [];
  const DB = await createD1({ schemaFiles: ['scripts/schema.sql'] });
  env = { DB, KIT_API_KEY: 'kit_test', RESEND_API_KEY: 're_test' };
  await writeConfig(DB, { enabled: true });
});
const only = () => [...kit.broadcasts.values()][0];

// ── The email ──────────────────────────────────────────────────────────────

test('the middle is theirs; the header, sign-off and footer are every SOARD email’s', () => {
  const m = customEmail(EMAIL);
  assert.equal(m.subject, 'A Brighter Day Starts With You');
  assert.match(m.html, /brand-logo-dark-bg-tagline-display/, 'the logo header');
  assert.match(m.html, /emails\/soard-team-plushie/, 'the team sign-off');
  assert.match(m.html, /The SOARD Team/);
  assert.match(m.html, /EIN 45-4773997/, 'the footer');
  assert.match(m.html, /A Brighter Day Starts With <em[^>]*>You<\/em>\./, '*stars* make the accent');
  assert.match(m.html, /<strong[^>]*>14 families<\/strong>/);
  assert.match(m.html, /href="https:\/\/sunshineonaranneyday\.com\/kids\/isla\/"[^>]*>Isla’s story<\/a>/);
  assert.match(m.html, /emails\/written\/x\/canva\.png\/w=1200,fit=scale-down/, 'a picture comes through whole, never cropped');
  assert.match(m.html, /i\.ytimg\.com\/vi\/abcdefghijk\/hq720\.jpg/);
  assert.match(m.html, /Help us build the next/, 'the give band with SOARD’s usual words');
  assert.ok(!/—/.test(m.html + m.text + m.subject), 'a typed em dash never reaches the email');
  assert.ok(!/unsubscribe/i.test(m.html), 'Kit adds that itself');
  assert.ok(!/gradient/i.test(m.html));
});

test('only real links, and nothing typed becomes code', () => {
  const m = customEmail({ subject: '<b>Hi</b>', blocks: [
    { type: 'text', text: '<script>alert(1)</script> [click](javascript:alert(1)) and "quotes"' },
    { type: 'button', text: 'Go', url: 'javascript:alert(1)' },
    { type: 'photo', id: '../../etc/passwd' },
  ] });
  assert.ok(!/<script>|href="javascript:/i.test(m.html), 'typed code stays words, and a javascript: link is never a link');
  assert.match(m.html, /&lt;script&gt;/);
  assert.equal(cleanEmail({ blocks: [{ type: 'button', text: 'Go', url: 'javascript:alert(1)' }] }).blocks[0].url, '');
  assert.equal(imageId('../../etc/passwd'), '');
  assert.equal(imageId(`${IMG}/kids/isla/hero.jpg/public`), 'kids/isla/hero.jpg');
  assert.equal(cleanEmail({ blocks: [{ type: 'nope' }, { type: 'text', text: 'x' }] }).blocks.length, 1);
});

test('what’s missing before it can go to Kit, in words', () => {
  assert.deepEqual(emailProblems({}), ['a subject', 'something in the middle: words or a picture']);
  assert.deepEqual(emailProblems({ subject: 'Hi', blocks: [{ type: 'text', text: 'x' }, { type: 'button', text: 'Go' }] }), ['a link for each button']);
  assert.deepEqual(emailProblems({ subject: 'Hi', blocks: [{ type: 'video', url: 'https://vimeo.com/1' }] }).slice(-1), ['a YouTube or Cloudflare Stream link for the video']);
  assert.deepEqual(emailProblems(EMAIL), []);
  assert.deepEqual(emailProblems({ subject: 'Hi', blocks: [{ type: 'cover', headline: 'Hi', buttonText: 'Give' }] }), ['a link for each button'], 'the big top’s button too');
  assert.equal(videoOf('https://customer-x.cloudflarestream.com/0123456789abcdef0123456789abcdef/watch').kind, 'stream');
});

// ── Saving, drafting, previews ────────────────────────────────────────────

test('saved, listed and put away; a bad id is refused', async () => {
  const e = await saveCustomEmail(env.DB, { email: EMAIL, by: LINZI });
  assert.match(e.id, /^em_[a-z0-9]{16}$/);
  await saveCustomEmail(env.DB, { id: e.id, email: { ...EMAIL, subject: 'New subject' }, by: PETER });
  const back = await readCustomEmail(env.DB, e.id);
  assert.equal(back.subject, 'New subject');
  assert.equal(back.updatedBy, PETER);
  assert.equal((await listCustomEmails(env.DB)).length, 1);
  assert.ok(await removeCustomEmail(env.DB, e.id));
  assert.equal((await listCustomEmails(env.DB)).length, 0);
  assert.equal(await readCustomEmail(env.DB, '../x'), null);
});

test('Draft in Kit: a draft only, to the newsletter list; the other reviewer hears, whoever drafted it doesn’t', async () => {
  const e = await saveCustomEmail(env.DB, { email: EMAIL, by: LINZI });
  const r = await draftCustomEmail(env, { id: e.id, by: LINZI });
  assert.equal(r.result, 'drafted');
  const b = only();
  assert.equal(b.send_at, null);
  assert.equal(b.public, false);
  assert.deepEqual(b.subscriber_filter, [{ all: null, any: null, none: [{ type: 'tag', ids: [555] }] }]);
  assert.match(b.description, new RegExp(`· email:${e.id} ·`));
  assert.ok(!/hq720/.test(b.content), 'a video with no widescreen picture uses its standard one');
  assert.deepEqual(emails.map((x) => x.to[0]), [PETER]);
  assert.match(emails[0].subject, /Review “A Brighter Day Starts With You” in Kit/);
  assert.match(emails[0].text, /Linzi drafted/);
  assert.equal((await customEmailStatus(env, await readCustomEmail(env.DB, e.id))).state, 'draft');
});

test('drafting again updates the waiting draft, but never one changed in Kit or already sent', async () => {
  const e = await saveCustomEmail(env.DB, { email: EMAIL, by: LINZI });
  await draftCustomEmail(env, { id: e.id, by: LINZI });
  const id = String(only().id);
  assert.equal((await draftCustomEmail(env, { id: e.id, by: LINZI })).result, 'unchanged');
  await saveCustomEmail(env.DB, { id: e.id, email: { ...EMAIL, subject: 'A Brighter Day, Together' }, by: LINZI });
  const u = await draftCustomEmail(env, { id: e.id, by: LINZI });
  assert.equal(u.result, 'updated');
  assert.equal(kit.broadcasts.get(id).subject, 'A Brighter Day, Together');
  assert.deepEqual(kit.puts[0].subscriber_filter, [{ all: null, any: null, none: [{ type: 'tag', ids: [555] }] }], 'never reset to everyone');
  assert.equal(kit.broadcasts.size, 1);
  // Changed in Kit by a person: left alone
  kit.broadcasts.get(id).subject = 'Linzi’s own subject';
  await saveCustomEmail(env.DB, { id: e.id, email: { ...EMAIL, subject: 'Third try' }, by: LINZI });
  const ed = await draftCustomEmail(env, { id: e.id, by: LINZI });
  assert.equal(ed.result, 'edited');
  assert.equal(kit.broadcasts.get(id).subject, 'Linzi’s own subject');
  // Sent: left alone
  Object.assign(kit.broadcasts.get(id), { status: 'completed', published_at: '2026-11-11T15:00:00Z' });
  assert.equal((await draftCustomEmail(env, { id: e.id, by: LINZI })).result, 'sent');
  // Deleted in Kit: drafted again
  kit.broadcasts.clear();
  assert.equal((await draftCustomEmail(env, { id: e.id, by: LINZI })).result, 'drafted');
});

test('not ready, or drafts paused: nothing goes to Kit', async () => {
  const e = await saveCustomEmail(env.DB, { email: { subject: '' }, by: LINZI });
  const r = await draftCustomEmail(env, { id: e.id, by: LINZI });
  assert.equal(r.result, 'missing');
  assert.match(r.error, /Add a subject/);
  await writeConfig(env.DB, { enabled: false });
  const f = await saveCustomEmail(env.DB, { email: EMAIL, by: LINZI });
  assert.equal((await draftCustomEmail(env, { id: f.id, by: LINZI })).result, 'off');
  assert.equal(kit.broadcasts.size, 0);
});

test('Send it to me: the email as it will go, marked [Preview], to the person asking only', async () => {
  const e = await saveCustomEmail(env.DB, { email: EMAIL, by: LINZI });
  const r = await sendCustomPreview(env, { id: e.id, to: LINZI });
  assert.ok(r.ok);
  assert.deepEqual(emails.map((x) => x.to[0]), [LINZI]);
  assert.equal(emails[0].subject, '[Preview] A Brighter Day Starts With You');
  assert.match(emails[0].html, /emails\/soard-team-plushie/);
  assert.equal(kit.broadcasts.size, 0, 'nothing in Kit');
});

test('the admin endpoint: a preview, a save, and a bad id refused', async () => {
  const post = (body, who = LINZI) => onRequestPost({ env, request: new Request('https://x/api/custom-emails-admin', { method: 'POST', body: JSON.stringify(body) }), data: { userEmail: who } }).then((r) => r.json());
  const p = await post({ preview: EMAIL });
  assert.ok(p.ok);
  assert.match(p.html, /A Brighter Day Starts With/);
  const s = await post({ save: EMAIL });
  assert.ok(s.ok);
  assert.match(s.email.id, /^em_/);
  assert.equal((await post({ draft: '../x' })).ok, false);
  assert.equal((await post({ save: EMAIL }, '')).ok, false, 'nobody signed in');
  assert.deepEqual(customImageUrls(EMAIL).filter((u) => /ytimg/.test(u)).length, 2);
});
