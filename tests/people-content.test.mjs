/**
 * People content tools: saved versions (the shared functions/api/_content-history.js, collection 'team'),
 * profile requests and the public bio form API (_profile-requests.js,
 * profile-request.js, profile-requests-admin.js), the batch photo change
 * (people-batch.js), the bio tidy prompt (people-ai.js), and how save,
 * rename and the audit log follow them.
 * Run: node --test tests/
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { recordVersion as record, listVersions as list, getVersion as get, changedFields } from '../functions/api/_content-history.js';
import { onRequestGet as historyGet } from '../functions/api/content-history.js';
import { createRequest, findRequest, liveRequests, resolveRequest, hashToken, normalizeLinkedIn, cleanText } from '../functions/api/_profile-requests.js';
import * as publicApi from '../functions/api/profile-request.js';
import * as adminApi from '../functions/api/profile-requests-admin.js';
import { batch } from '../functions/api/people-batch.js';
import { bioPrompt, tidyBio, bioProblems, revisePrompt, STYLE_RULES, onRequestPost as aiPost } from '../functions/api/people-ai.js';
import { onRequestPost as savePost } from '../functions/api/save-content.js';
import { rename } from '../functions/api/rename-content.js';
import { onRequestGet as auditGet } from '../functions/api/audit-log.js';

async function db(people = []) {
  const DB = await createD1({ schemaFiles: ['scripts/schema.sql'] });
  for (const p of people) {
    await DB.prepare('INSERT INTO team (slug, name, "group", order_num, data) VALUES (?, ?, ?, ?, ?)').bind(p.slug, p.name, p.group, p.order ?? 0, JSON.stringify(p)).run();
  }
  return DB;
}
const ctx = (DB, request, extra = {}) => ({ env: { DB, ...extra }, data: { userEmail: 'peter@example.com' }, waitUntil() {}, request });
const rowOf = async (DB, slug) => JSON.parse((await DB.prepare('SELECT data FROM team WHERE slug = ?').bind(slug).first()).data);
// People's versions live under collection 'team'
const recordVersion = (DB, o) => record(DB, { collection: 'team', ...o });
const listVersions = (DB, slug) => list(DB, 'team', slug);
const getVersion = (DB, slug, id) => get(DB, 'team', slug, id);

// ── Saved versions ──

test('every save keeps a version; the first save also keeps what was there before', async () => {
  const DB = await db();
  await recordVersion(DB, { slug: 'mary', previous: { name: 'Mary', title: 'Member' }, data: { name: 'Mary', title: 'Treasurer' }, userEmail: 'a@x.com', now: '2026-10-20T10:00:00.000Z' });
  await recordVersion(DB, { slug: 'mary', previous: { name: 'Mary', title: 'Treasurer' }, data: { name: 'Mary', title: 'Treasurer', bio: 'Hi.', order: 3 }, userEmail: 'b@x.com', now: '2026-10-21T10:00:00.000Z' });
  const v = await listVersions(DB, 'mary');
  assert.equal(v.length, 3, 'the original, then two saves');
  assert.deepEqual(v.map((x) => x.by), ['b@x.com', 'a@x.com', null]);
  assert.deepEqual(v[0].changed, ['bio'], '"order" moves aren\'t counted as edits');
  assert.deepEqual(v[1].changed, ['title']);
  assert.equal(v[2].changed, null, 'the first version has nothing before it');
  assert.equal((await getVersion(DB, 'mary', v[2].id)).title, 'Member');
  assert.deepEqual(changedFields({ a: 1 }, { a: 1, b: 2 }), ['b']);
});

test('only the newest 50 versions per person are kept', async () => {
  const DB = await db();
  for (let i = 0; i < 55; i++) await recordVersion(DB, { slug: 'x', data: { i }, userEmail: 'a', now: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString() });
  const v = await listVersions(DB, 'x');
  assert.equal(v.length, 50);
  assert.equal((await getVersion(DB, 'x', v[0].id)).i, 54);
});

test('save-content records a version for People, and the audit log filters by person', async () => {
  const DB = await db([{ slug: 'scott', name: 'Scott', group: 'board', title: 'Board Chair' }]);
  const res = await savePost(ctx(DB, new Request('https://x/api/save-content', { method: 'POST', body: JSON.stringify({ path: 'src/content/team/scott.json', content: JSON.stringify({ slug: 'scott', name: 'Scott', group: 'board', title: 'Board Chair', bio: 'Leads.' }), message: 'Update' }) })));
  assert.equal(res.status, 200);
  const v = await listVersions(DB, 'scott');
  assert.equal(v.length, 2);
  assert.equal(v[0].by, 'peter@example.com');
  const audit = await (await auditGet(ctx(DB, new Request('https://x/api/audit-log?type=team&slug=scott&limit=1')))).json();
  assert.equal(audit.entries?.length, 1);
  assert.equal(audit.entries[0].entity_slug, 'scott');
});

test('the History endpoint lists a person\'s versions and returns one', async () => {
  const DB = await db();
  await recordVersion(DB, { slug: 'mary', previous: { name: 'Mary', bio: 'Old.' }, data: { name: 'Mary', bio: 'New.' }, userEmail: 'a@x.com' });
  const call = (q) => historyGet(ctx(DB, new Request(`https://x/api/content-history?${q}`)));
  const l = await (await call('collection=team&slug=mary')).json();
  assert.equal(l.versions.length, 2);
  assert.deepEqual(l.versions[0].changed, ['bio']);
  assert.equal((await (await call(`collection=team&slug=mary&id=${l.versions[1].id}`)).json()).data.bio, 'Old.');
  assert.equal((await call('collection=team&slug=mary&id=99999')).status, 404);
  assert.equal((await call('collection=team&slug=../x')).status, 400);
});

test('a web address change carries the history and profile requests along', async () => {
  const DB = await db([{ slug: 'old-name', name: 'A B', group: 'team', title: 'x' }]);
  await recordVersion(DB, { slug: 'old-name', data: { name: 'A B' }, userEmail: 'a' });
  await createRequest(DB, { slug: 'old-name' });
  const r = await rename({ DB }, { collection: 'team', from: 'old-name', to: 'new-name' }, 'p', async () => new Response('{}'));
  assert.equal(r.status, 200);
  assert.equal((await listVersions(DB, 'new-name')).length, 1);
  assert.equal((await liveRequests(DB))[0].slug, 'new-name');
});

// ── Profile requests ──

test('a request link: hashed at rest, one live link per person, 30 days', async () => {
  const DB = await db();
  const now = new Date('2026-10-20T12:00:00Z');
  const a = await createRequest(DB, { slug: 'mary', userEmail: 'p', now });
  assert.match(a.token, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(a.expiresAt, '2026-11-19T12:00:00.000Z');
  const stored = await DB.prepare('SELECT token_hash FROM profile_requests').first();
  assert.equal(stored.token_hash, await hashToken(a.token), 'only the hash is stored');
  assert.notEqual(stored.token_hash, a.token);
  assert.equal((await findRequest(DB, a.token, now)).problem, null);
  const b = await createRequest(DB, { slug: 'mary', now });
  assert.equal((await findRequest(DB, a.token, now)).problem, 'closed', 'a new link replaces the old one');
  assert.equal((await findRequest(DB, b.token, new Date('2026-12-01'))).problem, 'expired');
  assert.equal((await findRequest(DB, 'not-a-token!', now)).problem, 'unknown');
  assert.equal((await findRequest(DB, 'x'.repeat(32), now)).problem, 'unknown');
});

test('the public form: reads their details, sends a suggestion, never touches the record', async () => {
  const DB = await db([{ slug: 'mary-atchley', name: 'Mary Atchley', group: 'board', title: 'Board Member', bio: 'Old bio.', photo: 'https://imagedelivery.net/HASH/team/mary-atchley/1/public' }]);
  const { token } = await createRequest(DB, { slug: 'mary-atchley' });
  const g = await publicApi.onRequestGet(ctx(DB, new Request(`https://x/api/profile-request?token=${token}`)));
  const gd = await g.json();
  assert.equal(g.status, 200);
  assert.equal(gd.person.first, 'Mary');
  assert.equal(gd.person.bio, 'Old bio.');
  assert.match(gd.person.photo, /team\/mary-atchley\/1\/w=320/);
  assert.equal(gd.person.email, undefined, 'nothing private goes out');

  const form = new FormData();
  form.set('token', token);
  form.set('bio', 'Mary <b>designs</b> rooms.\r\n\r\n\r\nSecond.');
  form.set('quote', 'Because families matter.');
  form.set('linkedin', 'linkedin.com/in/mary-atchley/');
  const p = await publicApi.onRequestPost(ctx(DB, new Request('https://x/api/profile-request', { method: 'POST', body: form })));
  assert.equal(p.status, 200);
  const live = await liveRequests(DB);
  assert.equal(live[0].status, 'pending');
  assert.deepEqual(live[0].submission, { bio: 'Mary designs rooms.\n\nSecond.', quote: 'Because families matter.', linkedin: 'https://www.linkedin.com/in/mary-atchley', photo: '' });
  assert.equal((await rowOf(DB, 'mary-atchley')).bio, 'Old bio.', 'the record waits for the admin');

  const again = await publicApi.onRequestGet(ctx(DB, new Request(`https://x/api/profile-request?token=${token}`)));
  assert.equal((await again.json()).person.sent, true, 'they can send changes until it\'s used');
  await resolveRequest(DB, live[0].id, 'used');
  assert.equal((await publicApi.onRequestGet(ctx(DB, new Request(`https://x/api/profile-request?token=${token}`)))).status, 410, 'a used link stops working');
});

test('the public form refuses bad links, empty sends, non-LinkedIn links and non-images; bots get a quiet ok', async () => {
  const DB = await db([{ slug: 'a', name: 'A', group: 'team', title: 'x' }]);
  const { token } = await createRequest(DB, { slug: 'a' });
  const send = async (fields) => { const f = new FormData(); for (const [k, v] of Object.entries(fields)) f.set(k, v); return publicApi.onRequestPost(ctx(DB, new Request('https://x/api/profile-request', { method: 'POST', body: f }))); };
  assert.equal((await send({ token: 'wrong'.repeat(5), bio: 'x' })).status, 404);
  assert.equal((await send({ token })).status, 400);
  assert.equal((await send({ token, linkedin: 'twitter.com/a' })).status, 400);
  assert.equal((await send({ token, photo: new File(['x'], 'a.pdf', { type: 'application/pdf' }) })).status, 400);
  const bot = await send({ token, bio: 'spam', website: 'http://spam' });
  assert.equal(bot.status, 200);
  assert.equal((await liveRequests(DB))[0].status, 'open', 'the bot\'s send was dropped');
});

test('a photo goes to Cloudflare Images under their folder', async () => {
  const DB = await db([{ slug: 'a-b', name: 'A B', group: 'team', title: 'x' }]);
  const { token } = await createRequest(DB, { slug: 'a-b' });
  const real = globalThis.fetch;
  let uploadedId = null;
  globalThis.fetch = async (url, init) => { uploadedId = init.body.get('id'); return Response.json({ success: true, result: { id: uploadedId, variants: [`https://imagedelivery.net/H/${uploadedId}/public`] } }); };
  try {
    const f = new FormData();
    f.set('token', token);
    f.set('photo', new File([new Uint8Array(10)], 'me.jpg', { type: 'image/jpeg' }));
    const r = await publicApi.onRequestPost(ctx(DB, new Request('https://x/api/profile-request', { method: 'POST', body: f }), { CF_ACCOUNT_ID: 'acct', CF_IMAGES_TOKEN: 'tok' }));
    assert.equal(r.status, 200);
    assert.match(uploadedId, /^team\/a-b\/submitted-\d+$/);
    assert.match((await liveRequests(DB))[0].submission.photo, /team\/a-b\/submitted-\d+\/public$/);
  } finally { globalThis.fetch = real; }
});

test('sending again: the form shows what was sent, an earlier photo stays unless replaced, a replaced one is deleted', async () => {
  const DB = await db([{ slug: 'a-b', name: 'A B', group: 'team', title: 'x', bio: 'Record bio.' }]);
  const { token } = await createRequest(DB, { slug: 'a-b' });
  const real = globalThis.fetch;
  const deleted = [];
  let n = 0;
  globalThis.fetch = async (url, init) => {
    if (init.method === 'DELETE') { deleted.push(String(url).split('/images/v1/')[1]); return Response.json({ success: true }); }
    const id = `team/a-b/submitted-${++n}`;
    return Response.json({ success: true, result: { id, variants: [`https://imagedelivery.net/H/${id}/public`] } });
  };
  const waits = [];
  const send = (fields) => { const f = new FormData(); f.set('token', token); for (const [k, v] of Object.entries(fields)) f.set(k, v); return publicApi.onRequestPost({ ...ctx(DB, new Request('https://x', { method: 'POST', body: f }), { CF_ACCOUNT_ID: 'acct', CF_IMAGES_TOKEN: 'tok' }), waitUntil: (p) => waits.push(p) }); };
  const photo = () => new File([new Uint8Array(10)], 'me.jpg', { type: 'image/jpeg' });
  try {
    await send({ photo: photo() });
    await send({ bio: 'Sent bio.' });
    let sub = (await liveRequests(DB))[0].submission;
    assert.equal(sub.bio, 'Sent bio.');
    assert.match(sub.photo, /submitted-1\/public$/, 'the photo from the first send stays');
    const g = await (await publicApi.onRequestGet(ctx(DB, new Request(`https://x/api/profile-request?token=${token}`)))).json();
    assert.equal(g.person.bio, 'Sent bio.', 'the form picks up from what they sent');
    assert.equal(g.person.sentPhoto, true);
    assert.match(g.person.photo, /submitted-1\/w=320/);
    await send({ photo: photo() });
    await Promise.all(waits);
    sub = (await liveRequests(DB))[0].submission;
    assert.match(sub.photo, /submitted-2\/public$/);
    assert.deepEqual(deleted, ['team/a-b/submitted-1'], 'the replaced photo is deleted');
  } finally { globalThis.fetch = real; }
});

test('the admin makes links (shown once, token in the fragment) and lists live requests', async () => {
  const DB = await db([{ slug: 'scott', name: 'Scott', group: 'board', title: 'x' }]);
  const post = (body) => adminApi.onRequestPost(ctx(DB, new Request('https://x', { method: 'POST', body: JSON.stringify(body) })));
  const made = await (await post({ action: 'create', slug: 'scott' })).json();
  assert.match(made.url, /^https:\/\/sunshineonaranneyday\.com\/profile-update\/#t=[A-Za-z0-9_-]{32}$/);
  assert.equal((await post({ action: 'create', slug: 'nobody' })).status, 404);
  const list = await (await adminApi.onRequestGet(ctx(DB, new Request('https://x')))).json();
  assert.equal(list.requests.length, 1);
  assert.equal(list.requests[0].status, 'open');
  assert.equal(list.requests[0].token, undefined, 'the token never comes back');
  assert.equal((await post({ action: 'resolve', id: list.requests[0].id, status: 'dismissed' })).status, 200);
  assert.equal((await (await adminApi.onRequestGet(ctx(DB, new Request('https://x')))).json()).requests.length, 0);
});

test('LinkedIn and text cleanup', () => {
  assert.equal(normalizeLinkedIn('www.linkedin.com/in/x?trk=1'), 'https://www.linkedin.com/in/x');
  assert.equal(normalizeLinkedIn('https://evil.com/in/x'), null);
  assert.equal(cleanText('  <script>x</script>Hi\n\n\n\nthere  ', 100), 'xHi\n\nthere');
  assert.equal(cleanText('abcdef', 3), 'abc');
});

// ── Batch photo change ──

test('background removal for many people in one request; only photo fields', async () => {
  const DB = await db([
    { slug: 'a', name: 'A', group: 'board', title: 'x', photo: 'p' },
    { slug: 'b', name: 'B', group: 'board', title: 'x', photo: 'p', photoCutout: true },
  ]);
  const r = await batch({ DB }, { updates: [{ slug: 'a', set: { photoCutout: true } }, { slug: 'b', set: { photoCutout: true } }] }, 'p@x.com');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.changed, ['a'], 'b already had it');
  assert.equal((await rowOf(DB, 'a')).photoCutout, true);
  assert.equal((await listVersions(DB, 'a')).length, 2);
  const off = await batch({ DB }, { updates: [{ slug: 'a', set: { photoCutout: false } }] });
  assert.equal(off.status, 200);
  assert.equal('photoCutout' in (await rowOf(DB, 'a')), false, 'off removes the field');
  assert.equal((await batch({ DB }, { updates: [{ slug: 'a', set: { title: 'Hacked' } }] })).status, 400);
  assert.equal((await batch({ DB }, { updates: [{ slug: 'zz', set: { photoCutout: true } }] })).status, 409);
});

test('framing from the Photos review: a crop as fractions with the photo\'s size; null goes back to the face', async () => {
  const DB = await db([{ slug: 'a', name: 'A', group: 'team', title: 'x', photo: 'p' }]);
  const r = await batch({ DB }, { updates: [{ slug: 'a', set: { photoCrop: { x: 0.1, y: 0.05, size: 0.6 }, photoSize: [1200, 1600] } }] });
  assert.equal(r.status, 200);
  assert.deepEqual((await rowOf(DB, 'a')).photoCrop, { x: 0.1, y: 0.05, size: 0.6 });
  assert.deepEqual((await rowOf(DB, 'a')).photoSize, [1200, 1600]);
  assert.match(r.body.shas.a, /^[0-9a-f]+$/, 'the new sha comes back, so an open editor can follow');
  for (const bad of [{ x: 2, y: 0, size: 0.5 }, { x: 0, y: 0, size: 0 }, { x: 0, y: 0, size: 0.5, evil: 1 }, 'center'])
    assert.equal((await batch({ DB }, { updates: [{ slug: 'a', set: { photoCrop: bad } }] })).status, 400, JSON.stringify(bad));
  assert.equal((await batch({ DB }, { updates: [{ slug: 'a', set: { photoSize: [0, 10] } }] })).status, 400);
  await batch({ DB }, { updates: [{ slug: 'a', set: { photoCrop: null } }] });
  assert.equal('photoCrop' in (await rowOf(DB, 'a')), false);
});

// ── Bio tidy ──

test('the bio prompt: house style, no invented facts, no guessed pronouns', () => {
  const p = bioPrompt({ bio: 'I run a flooring company.', name: 'Scott Wierson', title: 'Board Chair', organization: 'Real Floors', group: 'board' });
  assert.match(p, /third person/);
  assert.match(p, /never use he, she/);
  assert.match(p, /first name at most twice/);
  assert.match(p, /use none of its facts/);
  assert.match(p, /Never invent/);
  assert.match(p, /Board of Directors/);
  assert.match(p, /I run a flooring company\./);
  assert.ok(STYLE_RULES.some((r) => /em dashes/.test(r)));
  assert.equal(tidyBio('Rewritten bio: "Scott leads a team — and more."\n\n\nSecond  para.'), 'Scott leads a team, and more.\n\nSecond para.');
  assert.equal(tidyBio('She said "yes" twice.'), 'She said "yes" twice.', 'balanced quotes stay');
});

test('the style check: a first name repeated to dodge pronouns, guessed pronouns, stock phrases', () => {
  const name = 'Scott Wierson';
  const repetitive = 'Scott is the CEO of Real Floors Commercial. Scott has been on the board for a long time. Scott\'s company donates flooring.';
  assert.match(bioProblems(repetitive, { name, original: 'scott runs real floors' })[0], /first name "Scott" 3 times/);
  assert.deepEqual(bioProblems('Scott Wierson leads Real Floors Commercial, which donates flooring to SOARD builds.', { name, original: 'x' }), []);
  assert.match(bioProblems('Scott leads the company. He chairs the board.', { name, original: 'i run a company' }).join(), /pronouns/);
  assert.deepEqual(bioProblems('Scott leads the company. He chairs the board.', { name, original: 'he runs a company' }), [], 'pronouns the original uses are fine');
  assert.match(bioProblems('Scott is truly passionate about kids!', { name, original: 'x' }).join(' '), /stock phrases: passionate about, truly.*exclamation/);
  const r = revisePrompt({ bio: 'orig', name }, 'DRAFT TEXT', ['Fix A']);
  assert.match(r, /DRAFT TEXT/);
  assert.match(r, /- Fix A/);
});

test('a draft that breaks the style gets one corrected pass; the better of the two is kept', async () => {
  const call = (replies) => {
    const asked = [];
    return { asked, run: () => aiPost({ env: { AI: { run: async (model, { messages }) => { asked.push(messages[0].content); return { response: replies[asked.length - 1] }; } } },
      request: new Request('https://x', { method: 'POST', body: JSON.stringify({ name: 'Scott Wierson', bio: 'scott runs real floors commercial and has been on the board a long time. his company donates flooring' }) }) }) };
  };
  const repetitive = 'Scott is the CEO of Real Floors Commercial. Scott has served on the board for years. Scott donates flooring.';
  const good = 'Scott Wierson leads Real Floors Commercial and has served on the board for years. The company donates flooring to SOARD builds.';
  let c = call([repetitive, good]);
  let d = await (await c.run()).json();
  assert.equal(c.asked.length, 2, 'one corrected pass');
  assert.match(c.asked[1], /first name "Scott" 3 times/, 'the second pass says what to fix');
  assert.equal(d.suggestion, good);
  c = call([repetitive, 'Scott! Scott! Scott! Scott is truly here.']);
  d = await (await c.run()).json();
  assert.equal(d.suggestion, repetitive, 'a worse second pass is dropped');
  c = call([good]);
  d = await (await c.run()).json();
  assert.equal(c.asked.length, 1, 'a draft that passes goes straight back');
});

test('the tidy endpoint needs a few sentences and the AI binding; it returns a suggestion only', async () => {
  const call = (body, env = {}) => aiPost({ env, request: new Request('https://x', { method: 'POST', body: JSON.stringify(body) }) });
  assert.equal((await call({ bio: 'Too short' })).status, 400);
  assert.equal((await call({ bio: 'Scott runs a flooring company in Atlanta and leads the board.' })).status, 503);
  const r = await call({ bio: 'I run a flooring company in Atlanta and I chair the board.', name: 'Scott Wierson' },
    { AI: { run: async () => ({ response: 'Scott runs a flooring company in Atlanta — and chairs the board.' }) } });
  const d = await r.json();
  assert.equal(d.suggestion, 'Scott runs a flooring company in Atlanta, and chairs the board.');
  assert.equal(d.words, 11);
});
