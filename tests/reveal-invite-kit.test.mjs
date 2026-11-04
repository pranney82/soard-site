/**
 * The reveal invite email: drafted in Kit by itself when JobTread confirms a
 * reveal, filled in from the kid's page and JobTread, addressed to Kit's
 * "Reveal Emails" group, and Linzi asked to review it. Kit and Resend are faked.
 * Run: node --test tests/reveal-invite-kit.test.mjs
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { revealInviteEmail, revealWhen, calendarLinks } from '../functions/api/_reveal-invite-email.js';
import { syncKitInvite, readKitRow, KIT_INVITE_DEFAULTS } from '../functions/api/_reveal-invite-kit.js';

const KID = {
  name: 'Rowan', slug: 'rowan-test', publishStatus: 'published', roomTypes: ['Accessible Bathroom'],
  heroImage: 'https://imagedelivery.net/ROYFuPmfN2vPS6mt5sCkZQ/kids/rowan-test/hero.jpg/public',
  heroSummary: "Rowan loves trains and can't wait for a bathroom that fits his chair.",
  photos: [{ url: 'https://imagedelivery.net/ROYFuPmfN2vPS6mt5sCkZQ/kids/rowan-test/hero.jpg/public' }, { url: 'https://imagedelivery.net/ROYFuPmfN2vPS6mt5sCkZQ/kids/rowan-test/a.jpg/public' }, { url: 'https://imagedelivery.net/ROYFuPmfN2vPS6mt5sCkZQ/kids/rowan-test/b.jpg/public' }, { url: 'https://imagedelivery.net/ROYFuPmfN2vPS6mt5sCkZQ/kids/rowan-test/c.jpg/public' }],
  partnerLogos: [{ url: 'https://imagedelivery.net/ROYFuPmfN2vPS6mt5sCkZQ/partners/msi/public', name: 'MSI' }, { url: 'https://imagedelivery.net/ROYFuPmfN2vPS6mt5sCkZQ/partners/msi/public', name: 'MSI' }, { url: 'https://imagedelivery.net/ROYFuPmfN2vPS6mt5sCkZQ/partners/cambria/public', name: 'Cambria' }],
};
const WHO = { name: 'Rowan', slug: 'rowan-test' };
const plan = (over = {}) => ({ action: 'upsert', confirmed: true, date: '2027-03-12', facts: { date: '2027-03-12', start: '16:00', end: '17:00', confirmed: true, address: '100 Example Way, Atlanta, GA 30301', details: 'Park on the street.', ...over } });

// ─── Fake Kit and Resend ─────────────────────────────────────────────
let kit; // { groups, broadcasts: Map, calls: [] }
let emails;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  const method = (init.method || 'GET').toUpperCase();
  const body = init.body ? JSON.parse(init.body) : null;
  if (url.startsWith('https://api.kit.com/v4/')) {
    const path = url.slice('https://api.kit.com/v4'.length);
    kit.calls.push(`${method} ${path.split('?')[0]}`);
    if (path.startsWith('/tags')) return Response.json({ tags: kit.groups.tags });
    if (path.startsWith('/segments')) return Response.json({ segments: kit.groups.segments });
    if (path === '/broadcasts' && method === 'POST') {
      const id = 9000 + kit.broadcasts.size + 1;
      kit.broadcasts.set(String(id), { id, status: 'draft', send_at: body.send_at, published_at: null, ...body });
      return Response.json({ broadcast: { id } }, { status: 201 });
    }
    const m = path.match(/^\/broadcasts\/(\d+)$/);
    if (m) {
      const b = kit.broadcasts.get(m[1]);
      if (!b) return Response.json({ errors: ['Not Found'] }, { status: 404 });
      if (method === 'GET') return Response.json({ broadcast: b });
      if (method === 'PUT') { Object.assign(b, body); return Response.json({ broadcast: b }); }
    }
    return Response.json({ errors: ['unexpected'] }, { status: 500 });
  }
  if (url.startsWith('https://api.resend.com/emails/batch')) {
    for (const e of body) emails.push(e);
    return Response.json({ data: body.map((_, i) => ({ id: `re_${emails.length}_${i}` })) });
  }
  if (/slack/.test(url)) throw new Error(`Slack was called (${url}): the reviewer hears by email only`);
  throw new Error(`unexpected fetch ${url}`);
};
after(() => { globalThis.fetch = realFetch; });

let env;
beforeEach(async () => {
  kit = { groups: { tags: [{ id: 23099769, name: 'Reveal Emails', subscriber_count: 325 }, { id: 1, name: 'Newsletter', subscriber_count: 168 }], segments: [{ id: 587253, name: 'Reveal Emails' }] }, broadcasts: new Map(), calls: [] };
  emails = [];
  const DB = await createD1({ schemaFiles: ['scripts/schema.sql'] });
  await DB.prepare('INSERT INTO kids (slug, name, year, status, data) VALUES (?, ?, ?, ?, ?)').bind(KID.slug, KID.name, 2027, 'in-progress', JSON.stringify(KID)).run();
  env = { DB, KIT_API_KEY: 'kit_test', RESEND_API_KEY: 're_test', SLACK_WEBHOOK_URL: 'https://hooks.slack.example/never', SLACK_BOT_TOKEN: 'xoxb-never' };
});

const sync = (p = plan(), extra = {}) => syncKitInvite(env, { jobId: '22PTestJob001', plan: p, who: WHO, room: 'Bathroom', config: { enabled: true }, alertTo: ['peter@soardcharity.com'], ...extra });

test('the email: filled in from the kid page and JobTread, the Remi & Nico design, nothing Kit adds itself', () => {
  const e = revealInviteEmail({ kid: KID, date: '2027-03-12', time: '16:00', address: '100 Example Way, Atlanta, GA 30301', notes: 'Park on the street.\nBring a smile.' });
  assert.equal(e.subject, 'You’re Invited to Rowan’s Reveal Day!');
  assert.equal(e.preview, 'Come celebrate Rowan as we reveal their brand-new accessible bathroom!');
  assert.match(e.html, /Friday, March 12, 2027 · 4:00 PM/);
  assert.match(e.html, /100 Example Way, Atlanta, GA 30301/, 'the family’s address, like the invite sent for Remi & Nico');
  assert.match(e.html, /Park on the street\.[\s\S]*Bring a smile\./, 'JobTread’s notes, one line each');
  const cal = calendarLinks('rowan-test');
  for (const link of [cal.google, cal.apple, cal.outlook]) assert.ok(e.html.includes(link.replace(/&/g, '&amp;')), link);
  assert.match(e.html, /\/live\/rowan-test\//, 'the live link');
  assert.match(e.html, /kids\/rowan-test\/hero\.jpg\/w=1200,h=760,fit=cover/, 'the kid’s photo, cropped wide');
  assert.equal((e.html.match(/partners\/msi\//g) || []).length, 1, 'a partner listed twice shows once');
  assert.ok(!/—/.test(e.html + e.text + e.subject), 'no em dashes');
  assert.ok(!/gradient/i.test(e.html), 'flat colors only');
  assert.ok(!/unsubscribe/i.test(e.html), 'Kit adds the unsubscribe link and address itself');
  assert.equal(revealWhen('2027-03-12', '09:30'), 'Friday, March 12, 2027 · 9:30 AM');
});

test('words from JobTread can’t break out of the email', () => {
  const e = revealInviteEmail({ kid: KID, date: '2027-03-12', time: '16:00', address: '<script>alert(1)</script>', notes: '<img src=x onerror=alert(1)>' });
  assert.ok(!e.html.includes('<script>alert'), 'address escaped');
  assert.ok(!e.html.includes('<img src=x'), 'notes escaped');
});

test('confirmed in JobTread: one draft in Kit, to the Reveal Emails segment, private, and Linzi is asked to review it', async () => {
  const r = await sync();
  assert.equal(r.kit, 'drafted');
  assert.equal(kit.broadcasts.size, 1);
  const b = [...kit.broadcasts.values()][0];
  assert.equal(b.subject, 'You’re Invited to Rowan’s Reveal Day!');
  assert.equal(b.send_at, null, 'a draft: nothing is scheduled');
  assert.equal(b.public, false, 'never on the public newsletter page (it has an address)');
  assert.deepEqual(b.subscriber_filter, [{ all: [{ type: 'segment', ids: [587253] }], any: null, none: null }]);
  assert.match(b.content, /100 Example Way/);

  assert.equal(emails.length, 1);
  assert.deepEqual(emails[0].to, [KIT_INVITE_DEFAULTS.reviewer]);
  assert.equal(emails[0].to[0], 'linzi@soardcharity.com');
  assert.equal(emails[0].subject, 'Review Rowan’s reveal invite in Kit');
  assert.match(emails[0].html, new RegExp(`app\\.kit\\.com/campaigns/${b.id}`), 'a link straight to the draft');
  assert.match(emails[0].html, /Reveal Emails/);

  // Every later look at the job: nothing new
  kit.calls = [];
  assert.equal((await sync()).kit, 'unchanged');
  assert.deepEqual(kit.calls, [], 'no Kit calls when nothing changed');
  assert.equal(emails.length, 1);
});

test('the reveal moves while it’s a draft: the same draft is rewritten and Linzi hears', async () => {
  await sync();
  const r = await sync(plan({ date: '2027-03-13', start: '10:00' }));
  assert.equal(r.kit, 'updated');
  assert.equal(kit.broadcasts.size, 1, 'never a second draft');
  assert.match([...kit.broadcasts.values()][0].content, /Saturday, March 13, 2027 · 10:00 AM/);
  assert.equal(emails.length, 2);
  assert.equal(emails[1].subject, 'Rowan’s reveal invite draft changed');
});

test('the reveal moves after the email went out: Kit is left alone and Linzi is told to send an update', async () => {
  await sync();
  [...kit.broadcasts.values()][0].status = 'completed';
  const r = await sync(plan({ start: '17:00' }));
  assert.equal(r.kit, 'after-send');
  assert.ok(!kit.calls.includes('PUT /broadcasts/9001'), 'a sent email is never rewritten');
  assert.equal(emails.at(-1).subject, 'Rowan’s reveal changed after the invite went out');
  assert.equal((await sync(plan({ start: '17:00' }))).kit, 'unchanged', 'told once');
});

test('a draft deleted in Kit stays deleted', async () => {
  await sync();
  kit.broadcasts.clear();
  assert.equal((await sync(plan({ start: '17:00' }))).reason, 'the draft was deleted in Kit');
  assert.equal((await sync(plan({ start: '18:00' }))).reason, 'the draft was deleted in Kit');
  assert.equal(kit.broadcasts.size, 0);
});

test('no "Reveal Emails" group in Kit: no draft (Kit would send it to everyone), and staff hear once', async () => {
  kit.groups = { tags: [{ id: 1, name: 'Newsletter', subscriber_count: 168 }], segments: [] };
  const r = await sync();
  assert.equal(r.kit, 'error');
  assert.equal(kit.broadcasts.size, 0);
  assert.equal(emails.length, 1);
  assert.deepEqual(emails[0].to, ['peter@soardcharity.com']);
  assert.match(emails[0].subject, /wasn’t drafted/);
  await sync();
  assert.equal(emails.length, 1, 'the same problem isn’t emailed again');
  // The group is made in Kit: the next look drafts it
  kit.groups.tags.push({ id: 23099769, name: 'Reveal Emails', subscriber_count: 325 });
  assert.equal((await sync()).kit, 'drafted');
  assert.deepEqual([...kit.broadcasts.values()][0].subscriber_filter, [{ all: [{ type: 'tag', ids: [23099769] }], any: null, none: null }], 'a tag when there’s no segment');
});

test('quiet until it should act: tentative, no time, rehearsal, no kid page, switched off, Kit not connected', async () => {
  assert.equal((await sync(plan({ start: null }))).kit, 'skip');
  assert.equal((await sync({ ...plan(), confirmed: false })).kit, 'skip');
  assert.equal((await sync(plan(), { sandbox: true })).reason, 'a rehearsal leaves Kit alone');
  assert.equal((await sync(plan(), { who: { name: 'Rowan', slug: null } })).kit, 'skip');
  assert.equal((await sync(plan(), { config: { enabled: true, kitInvite: { enabled: false } } })).kit, 'off');
  const unpublished = { ...KID, publishStatus: 'draft' };
  await env.DB.prepare('UPDATE kids SET data = ? WHERE slug = ?').bind(JSON.stringify(unpublished), KID.slug).run();
  assert.equal((await sync()).reason, 'the kid page isn’t published');
  env.KIT_API_KEY = '';
  assert.equal((await sync()).reason, 'Kit is not connected');
  assert.equal(kit.broadcasts.size, 0);
  assert.equal(emails.length, 0);
  assert.equal(await readKitRow(env.DB, '22PTestJob001'), null);
});

test('another reviewer can be named', async () => {
  await sync(plan(), { config: { enabled: true, kitInvite: { reviewer: 'clareece@soardcharity.com' } } });
  assert.deepEqual(emails[0].to, ['clareece@soardcharity.com']);
});

test('drafted early from the admin: the date JobTread has now, the time to be confirmed, and it fills in once confirmed', async () => {
  const tentative = { action: 'upsert', confirmed: false, date: '2027-03-12', facts: { date: '2027-03-12', start: null, end: null, confirmed: false, address: '100 Example Way, Atlanta, GA 30301', details: '' } };
  // On its own a tentative reveal never drafts
  assert.equal((await sync(tentative)).kit, 'skip');
  const r = await sync(tentative, { early: true });
  assert.equal(r.kit, 'drafted');
  const b = [...kit.broadcasts.values()][0];
  assert.match(b.content, /Friday, March 12, 2027 · Time to be confirmed/);
  assert.equal(emails.length, 1);
  assert.deepEqual(emails[0].to, ['linzi@soardcharity.com']);
  assert.match(emails[0].html, /ahead of JobTread’s confirmation/);
  // Later looks while it's still tentative: nothing new
  assert.equal((await sync(tentative)).kit, 'unchanged');
  // The tentative date moves: the early draft follows it
  const moved = { ...tentative, date: '2027-03-13', facts: { ...tentative.facts, date: '2027-03-13' } };
  assert.equal((await sync(moved)).kit, 'updated');
  // JobTread confirms with a time: the same draft gets the time, and Linzi hears
  const r2 = await sync(plan({ date: '2027-03-13', details: '' }));
  assert.equal(r2.kit, 'updated');
  assert.equal(kit.broadcasts.size, 1);
  assert.match([...kit.broadcasts.values()][0].content, /Saturday, March 13, 2027 · 4:00 PM/);
  assert.equal(emails.at(-1).subject, 'Rowan’s reveal invite draft changed');
});

test('Linzi hears by email only: never a Slack post, even with Slack connected', async () => {
  const slackCalls = [];
  const inner = globalThis.fetch;
  globalThis.fetch = async (input, init) => { const url = typeof input === 'string' ? input : input.url; if (/slack/.test(url)) slackCalls.push(url); return inner(input, init); };
  try {
    await sync();
    await sync(plan({ start: '17:00' }));
    kit.groups = { tags: [], segments: [] };
    await env.DB.prepare('DELETE FROM reveal_invite_kit').run();
    await sync();
  } finally { globalThis.fetch = inner; }
  assert.deepEqual(slackCalls, []);
  assert.ok(emails.length >= 3, 'emails instead');
});
