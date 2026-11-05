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
import { syncKitInvite, holdKitInvite, kitInviteStatus, noteFor, draftIsSafe, readKitRow, KIT_INVITE_DEFAULTS } from '../functions/api/_reveal-invite-kit.js';

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
    if (kit.groupsDown && /^\/(tags|segments)/.test(path)) return new Response('down', { status: 503 });
    if (path.startsWith('/tags')) return Response.json({ tags: kit.groups.tags });
    if (path.startsWith('/segments')) return Response.json({ segments: kit.groups.segments });
    if (path.startsWith('/broadcasts?')) {
      if (kit.listDown) return new Response('down', { status: 503 });
      return Response.json({ broadcasts: [...kit.broadcasts.values()].filter((b) => b.status === 'draft').map(({ content, ...b }) => b) });
    }
    if (path === '/broadcasts' && method === 'POST') {
      const id = 9000 + kit.broadcasts.size + 1;
      kit.broadcasts.set(String(id), { id, status: 'draft', send_at: body.send_at, published_at: null, ...body, ...(kit.ignoreFilter ? { subscriber_filter: [{ all: [{ type: 'all_subscribers' }] }] } : {}) });
      if (kit.loseAnswer) { kit.loseAnswer = false; return new Response('gateway', { status: 502 }); }
      return Response.json({ broadcast: { id } }, { status: 201 });
    }
    const m = path.match(/^\/broadcasts\/(\d+)$/);
    if (m) {
      const b = kit.broadcasts.get(m[1]);
      if (!b) return Response.json({ errors: ['Not Found'] }, { status: 404 });
      if (method === 'GET') {
        if (kit.readDown) return new Response('down', { status: 503 });
        return Response.json({ broadcast: b });
      }
      if (method === 'PUT') {
        if (kit.putRefused) return Response.json({ errors: ['Refused'] }, { status: 422 });
        if (kit.loseAnswer) {
          kit.loseAnswer = false;
          Object.assign(b, body);
          return new Response('gateway', { status: 502 });
        }
        // As Kit's docs say: "If nothing is provided, will default to all of your subscribers"
        Object.assign(b, body);
        if (!body.subscriber_filter || kit.ignoreFilter) b.subscriber_filter = [{ all: [{ type: 'all_subscribers' }] }];
        return Response.json({ broadcast: b });
      }
    }
    return Response.json({ errors: ['unexpected'] }, { status: 500 });
  }
  if (url.startsWith('https://imagedelivery.net/')) {
    // Logos load, except the ones a test breaks on purpose
    if (/broken/.test(url) || (kit.noTeamPicture && /soard-team-plushie/.test(url))) return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
    return new Response('img', { headers: { 'Content-Type': 'image/jpeg' } });
  }
  if (url.startsWith('https://api.resend.com/emails/batch')) {
    if (kit.resendDown) return new Response('down', { status: 500 });
    if (kit.alarmsDown && body.some((e) => /^\[SOARD\]/.test(e.subject))) return new Response('down', { status: 500 });
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
  assert.match(e.html, />Friday, March 12<\/div>\s*<div[^>]*>4:00 PM</, 'the day and the time each keep a line, so a phone never breaks a date');
  assert.match(e.text, /Friday, March 12, 2027 · 4:00 PM/);
  assert.match(e.html, /100 Example Way, Atlanta, GA\u00A030301/, 'the family’s address, like the invite sent for Remi & Nico');
  assert.match(e.html, /Park on the street\.[\s\S]*Bring a smile\./, 'JobTread’s notes, one line each');
  const cal = calendarLinks('rowan-test');
  for (const link of [cal.google, cal.apple, cal.outlook]) assert.ok(e.html.includes(link.replace(/&/g, '&amp;')), link);
  assert.match(e.html, /\/live\/rowan-test\//, 'the live link');
  assert.match(e.html, /kids\/rowan-test\/hero\.jpg\/w=1200,h=880,fit=cover/, 'the kid’s photo, on the cover');
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

  // Every later look at the job reads Kit's copy, and nothing more
  kit.calls = [];
  assert.equal((await sync()).kit, 'unchanged');
  assert.deepEqual(kit.calls, [`GET /broadcasts/${b.id}`]);
  assert.equal(emails.length, 1);
});

test('the reveal moves while it’s a draft: the same draft is rewritten and Linzi hears', async () => {
  await sync();
  const r = await sync(plan({ date: '2027-03-13', start: '10:00' }));
  assert.equal(r.kit, 'updated');
  assert.equal(kit.broadcasts.size, 1, 'never a second draft');
  assert.match([...kit.broadcasts.values()][0].content, /Saturday, March 13<[\s\S]*10:00 AM/);
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
  assert.deepEqual(emails.flatMap((e) => e.to).sort(), ['linzi@soardcharity.com', 'peter@soardcharity.com']);
  assert.match(emails[0].subject, /wasn’t drafted/);
  await sync();
  assert.equal(emails.length, 2, 'the same problem isn’t emailed again');
  // The group is made in Kit: the next look drafts it
  kit.groups.tags.push({ id: 23099769, name: 'Reveal Emails', subscriber_count: 325 });
  assert.equal((await sync()).kit, 'drafted');
  assert.deepEqual([...kit.broadcasts.values()][0].subscriber_filter, [{ all: [{ type: 'tag', ids: [23099769] }], any: null, none: null }], 'a tag when there’s no segment');
});

test('quiet until it should act: tentative, no time, rehearsal, a community project, switched off, Kit not connected', async () => {
  assert.equal((await sync(plan({ start: null }))).kit, 'skip');
  assert.equal((await sync({ ...plan(), confirmed: false })).kit, 'skip');
  assert.equal((await sync(plan(), { sandbox: true })).reason, 'a rehearsal leaves Kit alone');
  assert.equal((await sync(plan(), { who: { name: 'The Boys Club', slug: null, url: '/community/boys-club/' } })).kit, 'skip');
  assert.equal((await sync(plan(), { config: { enabled: true, kitInvite: { enabled: false } } })).kit, 'off');
  env.KIT_API_KEY = '';
  assert.equal((await sync()).reason, 'Kit is not connected');
  assert.equal(kit.broadcasts.size, 0);
  assert.equal(emails.length, 0);
  assert.equal(await readKitRow(env.DB, '22PTestJob001'), null);
});

test('confirmed with no kid page to fill it from: staff and Linzi hear once, and it drafts as soon as the page is there', async () => {
  const noPage = { who: { name: 'Rowan', slug: null, url: null } };
  assert.equal((await sync(plan(), noPage)).kit, 'error');
  assert.equal(kit.broadcasts.size, 0);
  assert.deepEqual(emails.flatMap((e) => e.to).sort(), ['linzi@soardcharity.com', 'peter@soardcharity.com']);
  assert.match(emails[0].subject, /Rowan’s reveal invite email wasn’t drafted/);
  assert.match(emails[0].html, /Publish the kid’s page/);
  await sync(plan(), noPage);
  assert.equal(emails.length, 2, 'told once each');
  assert.equal((await sync()).kit, 'drafted');
});

test('confirmed with the kid page unpublished: staff and Linzi hear once, and publishing it drafts it', async () => {
  await env.DB.prepare('UPDATE kids SET data = ? WHERE slug = ?').bind(JSON.stringify({ ...KID, publishStatus: 'draft' }), KID.slug).run();
  assert.equal((await sync()).kit, 'error');
  assert.equal(kit.broadcasts.size, 0);
  assert.match(emails[0].html, /isn’t published/);
  await sync();
  assert.equal(emails.length, 2, 'told once each');
  await env.DB.prepare('UPDATE kids SET data = ? WHERE slug = ?').bind(JSON.stringify(KID), KID.slug).run();
  assert.equal((await sync()).kit, 'drafted');
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
  assert.match(b.content, /Friday, March 12<[\s\S]*Time to be confirmed/);
  assert.equal(emails.length, 1);
  assert.deepEqual(emails[0].to, ['linzi@soardcharity.com']);
  assert.match(emails[0].html, /ahead of JobTread’s confirmation/);
  assert.match(emails[0].html, /hold it until JobTread confirms/, 'the time and calendar buttons fill in then');
  // Later looks while it's still tentative: nothing new
  assert.equal((await sync(tentative)).kit, 'unchanged');
  // The tentative date moves: the early draft follows it
  const moved = { ...tentative, date: '2027-03-13', facts: { ...tentative.facts, date: '2027-03-13' } };
  assert.equal((await sync(moved)).kit, 'updated');
  // JobTread confirms with a time: the same draft gets the time, and Linzi hears
  const r2 = await sync(plan({ date: '2027-03-13', details: '' }));
  assert.equal(r2.kit, 'updated');
  assert.equal(kit.broadcasts.size, 1);
  assert.match([...kit.broadcasts.values()][0].content, /Saturday, March 13<[\s\S]*4:00 PM/);
  assert.equal(emails.at(-1).subject, 'Review Rowan’s reveal invite in Kit');
  assert.match(emails.at(-1).html, /Rowan’s reveal is confirmed/);
  assert.match(emails.at(-1).html, /now has the time and the calendar buttons/);
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

test('a partner logo that doesn’t load shows the partner’s name instead; a broken screenshot upload is left out', async () => {
  const kid = { ...KID, partnerLogos: [
    ...KID.partnerLogos,
    { url: 'https://imagedelivery.net/ROYFuPmfN2vPS6mt5sCkZQ/kids/rowan-test/partner-broken-Stilwell-Logo.jpg/public', name: 'Stilwell Casting' },
    { url: 'https://imagedelivery.net/ROYFuPmfN2vPS6mt5sCkZQ/kids/rowan-test/partner-broken-shot.png/public', name: 'Screenshot 2026-08-31 at 15.46.42' },
  ] };
  await env.DB.prepare('UPDATE kids SET data = ? WHERE slug = ?').bind(JSON.stringify(kid), KID.slug).run();
  assert.equal((await sync()).kit, 'drafted');
  const html = [...kit.broadcasts.values()][0].content;
  assert.ok(!html.includes('partner-broken-Stilwell-Logo.jpg'), 'no broken picture');
  assert.match(html, />Stilwell Casting</, 'the name in its card instead');
  assert.ok(!/Screenshot 2026/.test(html), 'a file name isn’t a partner name');
  assert.match(html, /partners\/msi\//, 'logos that load still show');
});

test('rewrite: a draft gets the email’s new design quietly; nobody is emailed when the reveal didn’t change', async () => {
  await sync();
  assert.equal(emails.length, 1);
  assert.equal((await sync()).kit, 'unchanged');
  const r = await sync(plan(), { rewrite: true });
  assert.equal(r.kit, 'redesigned');
  assert.ok(kit.calls.some((c) => c.startsWith('PUT /broadcasts/')), 'the draft was rewritten');
  assert.equal(emails.length, 1, 'Linzi isn’t told about a design change');
});

test('an update says the audience again: Kit would otherwise reset the draft to every subscriber', async () => {
  await sync();
  await sync(plan({ start: '17:00' }));
  const b = [...kit.broadcasts.values()][0];
  assert.deepEqual(b.subscriber_filter, [{ all: [{ type: 'segment', ids: [587253] }], any: null, none: null }]);
  assert.equal(b.public, false);
  assert.equal(b.send_at, null);
});

test('Kit’s copy is read back: a draft that isn’t going only to the group is flagged to staff and Linzi before anyone sends it', async () => {
  await sync();
  kit.ignoreFilter = true; // Kit drops the audience
  const r = await sync(plan({ start: '17:00' }));
  assert.equal(r.kit, 'check');
  const warned = emails.filter((e) => /Check who/.test(e.subject));
  assert.deepEqual(warned.flatMap((e) => e.to).sort(), ['linzi@soardcharity.com', 'peter@soardcharity.com']);
  assert.match(warned[0].html, /Newsletter site/);
  assert.equal((await readKitRow(env.DB, '22PTestJob001')).state, 'check audience');
  const n = emails.length;
  assert.equal((await sync(plan({ start: '17:00' }))).kit, 'check', 'it stays flagged until it’s right');
  assert.equal(emails.length, n, 'told once');
});

test('a brand-new draft is read back too', async () => {
  kit.ignoreFilter = true;
  assert.equal((await sync()).kit, 'check');
  assert.ok(emails.some((e) => /Check who Rowan’s reveal invite goes to/.test(e.subject)));
});

test('Linzi’s email failing to send is tried again on the next look, once', async () => {
  kit.resendDown = true;
  assert.equal((await sync()).kit, 'drafted');
  assert.equal(emails.length, 0);
  assert.equal((await readKitRow(env.DB, '22PTestJob001')).notified, null);
  kit.resendDown = false;
  await sync();
  assert.equal(emails.length, 1);
  assert.equal(emails[0].subject, 'Review Rowan’s reveal invite in Kit');
  assert.match((await readKitRow(env.DB, '22PTestJob001')).notified, /^\d{4}-/);
  await sync();
  assert.equal(emails.length, 1, 'once it went, it isn’t sent again');
  assert.equal(kit.broadcasts.size, 1, 'and never a second draft');
});

test('real JobTread words: the team’s own arrival note isn’t said twice, and an address has no ", USA"', () => {
  const e = revealInviteEmail({ kid: KID, date: '2027-03-12', time: '16:00', address: '426 Example Ln, Woodstock, GA 30188, USA', notes: 'Please arrive at least 15 mins early! Parking will be tight.' });
  assert.ok(!e.html.includes('Please arrive 15 minutes early'));
  assert.match(e.html, /Please arrive at least 15 mins early/);
  assert.match(e.html, /426 Example Ln, Woodstock, GA\u00A030188</);
  assert.ok(!/, USA/.test(e.html + e.text));
});

test('a change Linzi didn’t hear about is tried again with the right note, not "ready to review"', async () => {
  await sync();
  kit.resendDown = true;
  const moved = plan({ start: '17:00' });
  assert.equal((await sync(moved)).kit, 'updated');
  kit.resendDown = false;
  assert.equal(emails.length, 1);
  await sync(moved);
  assert.equal(emails.at(-1).subject, 'Rowan’s reveal invite draft changed');
  assert.equal(emails.length, 2);
  await sync(moved);
  assert.equal(emails.length, 2, 'once');
});

test('the same goes for a note about a sent email', async () => {
  await sync();
  [...kit.broadcasts.values()][0].status = 'completed';
  kit.resendDown = true;
  const moved = plan({ start: '17:00' });
  await sync(moved);
  kit.resendDown = false;
  await sync(moved);
  assert.equal(emails.at(-1).subject, 'Rowan’s reveal changed after the invite went out');
  await sync(moved);
  assert.equal(emails.length, 2, 'once');
});

test('Linzi’s edits in Kit are never overwritten: JobTread’s change comes to her as a note, once', async () => {
  await sync();
  const b = [...kit.broadcasts.values()][0];
  b.content += '<p>Linzi’s own line</p>';
  const moved = plan({ start: '17:00' });
  kit.calls = [];
  assert.equal((await sync(moved)).kit, 'edited');
  assert.ok(b.content.includes('Linzi’s own line'), 'her edit stands');
  assert.ok(!kit.calls.some((c) => c.startsWith('PUT')), 'nothing was written to Kit');
  assert.equal(emails.at(-1).subject, 'Rowan’s reveal changed: please update your draft');
  assert.match(emails.at(-1).html, /5:00 PM/, 'what JobTread says now');
  const n = emails.length;
  assert.equal((await sync(moved)).kit, 'unchanged');
  assert.equal(emails.length, n, 'told once');
  // A later change: she hears that too, and her edit still stands
  assert.equal((await sync(plan({ start: '18:00' }))).kit, 'edited');
  assert.equal(emails.length, n + 1);
  assert.ok(b.content.includes('Linzi’s own line'));
});

test('a redesign leaves an edited draft alone, quietly', async () => {
  await sync();
  [...kit.broadcasts.values()][0].content += '<p>Linzi’s own line</p>';
  kit.calls = [];
  assert.equal((await sync(plan(), { rewrite: true })).kit, 'edited');
  assert.ok(!kit.calls.some((c) => c.startsWith('PUT')));
  assert.equal(emails.length, 1);
});

test('a redesign of an email that already went out: no rewrite, and no false "changed" note', async () => {
  await sync();
  [...kit.broadcasts.values()][0].status = 'completed';
  kit.calls = [];
  assert.equal((await sync(plan(), { rewrite: true })).kit, 'unchanged');
  assert.ok(!kit.calls.some((c) => c.startsWith('PUT')));
  assert.equal(emails.length, 1);
  assert.equal((await readKitRow(env.DB, '22PTestJob001')).state, 'sent');
});

test('a draft scheduled in Kit is left alone, and Linzi is told to unschedule it', async () => {
  await sync();
  Object.assign([...kit.broadcasts.values()][0], { status: 'scheduled', send_at: '2027-03-01T15:00:00Z' });
  kit.calls = [];
  assert.equal((await sync(plan({ start: '17:00' }))).kit, 'scheduled');
  assert.ok(!kit.calls.some((c) => c.startsWith('PUT')));
  assert.equal(emails.at(-1).subject, 'Rowan’s reveal changed, and its invite is scheduled');
  assert.match(emails.at(-1).html, /unschedule it in Kit/);
});

test('a broadcast Kit gives no status for: its dates decide, so a sent email is never rewritten', async () => {
  await sync();
  const b = [...kit.broadcasts.values()][0];
  delete b.status;
  assert.equal((await sync(plan({ start: '17:00' }))).kit, 'updated', 'no status and no dates: still a draft');
  b.published_at = '2027-01-01T00:00:00Z';
  kit.calls = [];
  assert.equal((await sync(plan({ start: '18:00' }))).kit, 'after-send');
  assert.ok(!kit.calls.some((c) => c.startsWith('PUT')));
});

test('Kit is down when a reveal is confirmed: staff hear once, and the next look drafts it', async () => {
  kit.groupsDown = true;
  assert.equal((await sync()).kit, 'error');
  assert.deepEqual(emails.flatMap((e) => e.to).sort(), ['linzi@soardcharity.com', 'peter@soardcharity.com']);
  assert.match(emails[0].subject, /wasn’t drafted/);
  await sync();
  assert.equal(emails.length, 2, 'told once');
  kit.groupsDown = false;
  assert.equal((await sync()).kit, 'drafted');
});

test('Kit refuses a change: staff hear once, and the next look tries again', async () => {
  await sync();
  kit.putRefused = true;
  const moved = plan({ start: '17:00' });
  assert.equal((await sync(moved)).kit, 'error');
  const warned = emails.filter((e) => /needs a look/.test(e.subject));
  assert.deepEqual(warned.flatMap((e) => e.to).sort(), ['linzi@soardcharity.com', 'peter@soardcharity.com'], 'Linzi too: she could send the old date');
  assert.match(warned[0].html, /still has the old details/);
  await sync(moved);
  assert.equal(emails.filter((e) => /needs a look/.test(e.subject)).length, 2, 'told once');
  kit.putRefused = false;
  assert.equal((await sync(moved)).kit, 'updated');
  assert.equal((await readKitRow(env.DB, '22PTestJob001')).error, null);
});

test('a draft deleted in Kit can be made again by hand', async () => {
  await sync();
  kit.broadcasts.clear();
  const moved = plan({ start: '17:00' });
  assert.equal((await sync(moved)).reason, 'the draft was deleted in Kit');
  assert.equal((await sync(moved, { early: true })).kit, 'drafted');
  assert.equal(kit.broadcasts.size, 1);
  assert.equal((await readKitRow(env.DB, '22PTestJob001')).state, 'draft');
});

test('a flagged draft put right in Kit clears on the next look', async () => {
  kit.ignoreFilter = true;
  assert.equal((await sync()).kit, 'check');
  kit.ignoreFilter = false;
  [...kit.broadcasts.values()][0].subscriber_filter = [{ all: [{ type: 'segment', ids: [587253] }], any: null, none: null }];
  assert.equal((await sync()).kit, 'unchanged');
  const row = await readKitRow(env.DB, '22PTestJob001');
  assert.equal(row.state, 'draft');
  assert.equal(row.error, null);
});

test('a group with no usable id isn’t an audience: no draft to everyone', async () => {
  kit.groups = { tags: [{ id: null, name: 'Reveal Emails' }], segments: [{ name: 'Reveal Emails' }] };
  assert.equal((await sync()).kit, 'error');
  assert.equal(kit.broadcasts.size, 0);
});

test('two kids read right, and one does too', () => {
  const two = revealInviteEmail({ kid: { ...KID, name: 'Remi & Nico' }, date: '2027-03-12', time: '16:00', address: '100 Example Way' });
  assert.match(two.html, /before Remi &amp; Nico arrive\./);
  const one = revealInviteEmail({ kid: KID, date: '2027-03-12', time: '16:00', address: '100 Example Way' });
  assert.match(one.html, /before Rowan arrives\./);
});

test('the signature has the team, and a picture that won’t load is left out, never shown broken', async () => {
  const e = revealInviteEmail({ kid: KID, date: '2027-03-12', time: '16:00', address: '100 Example Way' });
  assert.match(e.html, /emails\/soard-team-plushie\/w=1008/);
  assert.match(e.html, /alt="The SOARD team"/);
  assert.ok(e.html.indexOf('soard-team-plushie') < e.html.indexOf('The SOARD Team'), 'above the name');
  assert.match(e.text, /The SOARD Team/);
  assert.ok(!/Holly|Peter/.test(e.html + e.text), 'it’s from the team, not two people');
  kit.noTeamPicture = true;
  assert.equal((await sync()).kit, 'drafted');
  assert.ok(!/soard-team-plushie/.test([...kit.broadcasts.values()][0].content));
});

test('JobTread says the reveal may be off: Linzi hears once to hold the draft, and again when it’s back on', async () => {
  await sync();
  const hold = () => holdKitInvite(env, { jobId: '22PTestJob001', reason: 'status is Denied', name: 'Rowan', config: { enabled: true } });
  assert.equal((await hold()).kit, 'held');
  assert.equal(emails.at(-1).subject, 'Hold Rowan’s reveal invite');
  assert.deepEqual(emails.at(-1).to, ['linzi@soardcharity.com']);
  assert.match(emails.at(-1).html, /status is Denied/);
  const n = emails.length;
  assert.equal((await hold()).kit, 'unchanged');
  assert.equal(emails.length, n, 'told once');
  assert.equal((await sync()).kit, 'unchanged');
  assert.equal(emails.at(-1).subject, 'Rowan’s reveal invite is back on');
  assert.equal((await readKitRow(env.DB, '22PTestJob001')).error, null);
});

test('the reveal may be off after Linzi sent it: the note says so, never "don’t send it"', async () => {
  await sync();
  [...kit.broadcasts.values()][0].status = 'completed';
  await holdKitInvite(env, { jobId: '22PTestJob001', reason: 'job closed', name: 'Rowan', config: { enabled: true } });
  assert.equal(emails.at(-1).subject, 'Rowan’s reveal may be off, after the invite went out');
  assert.match(emails.at(-1).html, /short update/);
  assert.ok(!/don’t send/.test(emails.at(-1).html));
});

test('the reveal may be off while it’s scheduled: she’s told to unschedule it', async () => {
  await sync();
  Object.assign([...kit.broadcasts.values()][0], { status: 'scheduled', send_at: '2027-03-01T15:00:00Z' });
  await holdKitInvite(env, { jobId: '22PTestJob001', reason: 'job closed', name: 'Rowan', config: { enabled: true } });
  assert.equal(emails.at(-1).subject, 'Unschedule Rowan’s reveal invite');
});

test('nothing waiting in Kit: nothing to hold, and a hold note that didn’t go is tried again', async () => {
  const hold = () => holdKitInvite(env, { jobId: '22PTestJob001', reason: 'job closed', name: 'Rowan', config: { enabled: true } });
  assert.equal((await hold()).kit, 'skip');
  assert.equal(emails.length, 0);
  await sync();
  kit.resendDown = true;
  await hold();
  kit.resendDown = false;
  await hold();
  assert.equal(emails.at(-1).subject, 'Hold Rowan’s reveal invite');
  kit.broadcasts.clear();
  assert.equal((await hold()).reason, 'the draft was deleted in Kit');
});

// ─── A second reviewer's sequences (Nov 4 2026): every look starts from Kit's copy ─────────
const hold = (reason = 'job closed') => holdKitInvite(env, { jobId: '22PTestJob001', reason, name: 'Rowan', config: { enabled: true }, alertTo: ['peter@soardcharity.com'] });
const only = () => [...kit.broadcasts.values()][0];
const everyone = [{ all: [{ type: 'all_subscribers' }] }];

test('scheduled, moved, then called off: Linzi still hears, in the right words', async () => {
  await sync();
  Object.assign(only(), { status: 'scheduled', send_at: '2027-03-01T15:00:00Z' });
  await sync(plan({ start: '17:00' }));
  await hold();
  assert.equal(emails.at(-1).subject, 'Unschedule Rowan’s reveal invite');
});

test('sent, moved, then called off: Linzi still hears, in the right words', async () => {
  await sync();
  Object.assign(only(), { status: 'completed' });
  await sync(plan({ start: '17:00' }));
  await hold();
  assert.equal(emails.at(-1).subject, 'Rowan’s reveal may be off, after the invite went out');
});

test('the audience alarm that didn’t go is tried again, and she’s never told it’s ready until it’s aimed right', async () => {
  kit.ignoreFilter = true;
  kit.alarmsDown = true;
  assert.equal((await sync()).kit, 'check');
  assert.equal(emails.length, 0, 'no "ready to review" for a draft aimed at everyone');
  kit.alarmsDown = false;
  assert.equal((await sync()).kit, 'check');
  assert.deepEqual(emails.flatMap((e) => e.to).sort(), ['linzi@soardcharity.com', 'peter@soardcharity.com']);
  assert.ok(emails.every((e) => /Check who/.test(e.subject)));
  await sync();
  assert.equal(emails.length, 2, 'told once');
  only().subscriber_filter = [{ all: [{ type: 'segment', ids: [587253] }], any: null, none: null }];
  await sync();
  assert.equal(emails.at(-1).subject, 'Review Rowan’s reveal invite in Kit', 'now it’s true');
});

test('the "no group" alarm that didn’t go is tried again', async () => {
  kit.groups = { tags: [], segments: [] };
  kit.alarmsDown = true;
  await sync();
  assert.equal(emails.length, 0);
  kit.alarmsDown = false;
  await sync();
  assert.ok(emails.length > 0);
});

test('Kit’s audience changing on its own is noticed on the next look, with nothing else changed', async () => {
  await sync();
  only().subscriber_filter = everyone;
  assert.equal((await sync()).kit, 'check');
  assert.ok(emails.some((e) => /Check who/.test(e.subject)));
});

test('put on the newsletter site by hand is noticed too', async () => {
  await sync();
  only().public = true;
  assert.equal((await sync()).kit, 'check');
});

test('a scheduled email aimed at everyone sets off the alarm, and its note doesn’t claim the group', async () => {
  await sync();
  Object.assign(only(), { status: 'scheduled', send_at: '2027-03-01T15:00:00Z', subscriber_filter: everyone });
  assert.equal((await sync(plan({ start: '17:00' }))).kit, 'check');
  assert.ok(emails.some((e) => /Check who/.test(e.subject)));
  const note = emails.find((e) => /is scheduled/.test(e.subject));
  assert.ok(note && !/Goes to/.test(note.html));
});

test('a second group alongside the right one isn’t safe', () => {
  const b = (ids) => ({ public: false, subscriber_filter: [{ all: null, any: [{ type: 'segment', ids }], none: null }] });
  assert.equal(draftIsSafe(b([587253]), { type: 'segment', id: 587253 }), true);
  assert.equal(draftIsSafe(b([587253, 1]), { type: 'segment', id: 587253 }), false);
});

test('a worker dying before the read-back: the next look reads it and tells her', async () => {
  await sync();
  await env.DB.prepare('UPDATE reveal_invite_kit SET told = NULL, notified = NULL, content_hash = NULL').run();
  only().subscriber_filter = everyone;
  assert.equal((await sync()).kit, 'check');
  only().subscriber_filter = [{ all: [{ type: 'segment', ids: [587253] }], any: null, none: null }];
  await sync();
  assert.equal(emails.at(-1).subject, 'Review Rowan’s reveal invite in Kit');
});

test('an early draft stays on hold in every note until JobTread confirms', async () => {
  const tentative = (date = '2027-03-12') => ({ action: 'upsert', confirmed: false, date, facts: { date, start: null, end: null, confirmed: false, address: '100 Example Way, Atlanta, GA 30301', details: '' } });
  await sync(tentative(), { early: true });
  await sync(tentative('2027-03-13'));
  assert.equal(emails.at(-1).subject, 'Rowan’s reveal invite draft changed');
  assert.match(emails.at(-1).html, /keep holding it/);
  assert.ok(!/before you send it/.test(emails.at(-1).html));
  await hold();
  await sync(tentative('2027-03-13'));
  assert.equal(emails.at(-1).subject, 'Rowan’s reveal invite is back on');
  assert.match(emails.at(-1).html, /keep holding it/);
});

test('confirmed, then un-confirmed: she’s told to hold it', async () => {
  await sync();
  await sync({ ...plan({ start: null, confirmed: false }), confirmed: false });
  assert.match(only().content, /Time to be confirmed/);
  assert.match(emails.at(-1).html, /keep holding it/);
});

test('held, moved, back on: the draft is rewritten first, and "ready" is only said if it was', async () => {
  await sync();
  await hold();
  kit.putRefused = true;
  const moved = plan({ date: '2027-04-02', start: '10:00' });
  await sync(moved);
  assert.ok(!emails.some((e) => /back on/.test(e.subject)), 'never "ready" over a draft with the old date');
  assert.ok(emails.some((e) => /needs a look/.test(e.subject)));
  kit.putRefused = false;
  await sync(moved);
  assert.equal(emails.at(-1).subject, 'Rowan’s reveal invite is back on');
  assert.match(only().content, /April 2</);
});

test('a renamed group: the site still knows which it is, and a sent invite’s change still reaches her', async () => {
  await sync();
  Object.assign(only(), { status: 'completed' });
  kit.groups = { tags: [], segments: [{ id: 587253, name: 'Reveal Guests' }] };
  assert.equal((await sync(plan({ start: '17:00' }))).kit, 'after-send');
  assert.equal(emails.at(-1).subject, 'Rowan’s reveal changed after the invite went out');
});

test('a draft whose group was renamed still follows JobTread, to the same group', async () => {
  await sync();
  kit.groups = { tags: [], segments: [{ id: 587253, name: 'Reveal Guests' }] };
  assert.equal((await sync(plan({ start: '17:00' }))).kit, 'updated');
  assert.deepEqual(only().subscriber_filter, [{ all: [{ type: 'segment', ids: [587253] }], any: null, none: null }]);
});

test('a subject, preview or exclusion edited in Kit is kept too', async () => {
  await readKitRow(env.DB, 'makes-the-table');
  for (const edit of [(b) => { b.subject = 'Linzi’s subject'; }, (b) => { b.preview_text = 'Linzi’s preview'; }, (b) => { b.subscriber_filter = [{ all: [{ type: 'segment', ids: [587253] }], any: null, none: [{ type: 'tag', ids: [5] }] }]; }]) {
    kit.broadcasts.clear();
    await env.DB.prepare('DELETE FROM reveal_invite_kit').run();
    await sync();
    const b = only();
    edit(b);
    const before = JSON.stringify(b);
    assert.equal((await sync(plan({ start: '17:00' }))).kit, 'edited');
    assert.equal(JSON.stringify(b), before);
  }
});

test('Kit not answering stops the look: her edits can’t be overwritten by a read that failed', async () => {
  await sync();
  only().content += '<p>Linzi’s own line</p>';
  kit.readDown = true;
  const n = kit.calls.length;
  assert.equal((await sync(plan({ start: '17:00' }))).kit, 'error');
  assert.ok(!kit.calls.slice(n).some((c) => c.startsWith('PUT')));
  kit.calls = [];
  await sync(plan(), { rewrite: true });
  assert.ok(!kit.calls.some((c) => c.startsWith('PUT')), 'a redesign stops too');
  assert.ok(only().content.includes('Linzi’s own line'));
});

test('Kit not answering with nothing to do is quiet', async () => {
  await sync();
  kit.readDown = true;
  const n = emails.length;
  assert.equal((await sync()).kit, 'unchanged');
  assert.equal(emails.length, n);
});

test('fixing the audience by hand doesn’t count as an edit, and doesn’t bless one', async () => {
  await sync();
  only().subscriber_filter = everyone;
  await sync();
  only().subscriber_filter = [{ all: [{ type: 'segment', ids: [587253] }], any: null, none: null }];
  await sync();
  assert.equal((await sync(plan({ start: '17:00' }))).kit, 'updated', 'audience fixed, content untouched: still follows JobTread');
  only().content += '<p>Linzi’s own line</p>';
  only().subscriber_filter = everyone;
  await sync(plan({ start: '17:00' }));
  only().subscriber_filter = [{ all: [{ type: 'segment', ids: [587253] }], any: null, none: null }];
  await sync(plan({ start: '17:00' }));
  assert.equal((await sync(plan({ start: '18:00' }))).kit, 'edited', 'her edit made while it was flagged is still hers');
});

test('a change Kit took but never answered isn’t a false alarm or a false "you edited"', async () => {
  await sync();
  kit.loseAnswer = true;
  const moved = plan({ start: '17:00' });
  assert.equal((await sync(moved)).kit, 'updated');
  assert.ok(!emails.some((e) => /needs a look|still has the old/.test(e.subject + e.html)));
  assert.equal(emails.at(-1).subject, 'Rowan’s reveal invite draft changed');
  assert.equal((await sync(plan({ start: '18:00' }))).kit, 'updated', 'and it still follows JobTread');
});

test('a worker dying right after a change landed: the next look finishes the job, not "you edited"', async () => {
  await sync();
  const row = await readKitRow(env.DB, '22PTestJob001');
  await sync(plan({ start: '17:00' }));
  await env.DB.prepare('UPDATE reveal_invite_kit SET hash = ?, content_hash = ?, told = ? WHERE job_id = ?').bind(row.hash, row.content_hash, row.told, row.job_id).run();
  const n = emails.length;
  assert.equal((await sync(plan({ start: '17:00' }))).kit, 'unchanged');
  assert.equal(emails.length, n + 1);
  assert.equal(emails.at(-1).subject, 'Rowan’s reveal invite draft changed');
});

test('a draft Kit took but never answered isn’t made twice', async () => {
  kit.loseAnswer = true;
  assert.equal((await sync()).kit, 'error');
  assert.equal(kit.broadcasts.size, 1);
  assert.equal((await sync()).kit, 'drafted');
  assert.equal(kit.broadcasts.size, 1, 'the same draft, found by its description');
  assert.equal(emails.at(-1).subject, 'Review Rowan’s reveal invite in Kit');
});

test('with no answer on what’s in Kit, nothing new is made', async () => {
  kit.listDown = true;
  assert.equal((await sync()).kit, 'error');
  assert.equal(kit.broadcasts.size, 0);
});

test('a failed last write can’t lose the draft', async () => {
  const realPrepare = env.DB.prepare.bind(env.DB);
  let writes = 0;
  env.DB.prepare = (sql) => {
    const st = realPrepare(sql);
    if (!/INSERT OR REPLACE INTO reveal_invite_kit/.test(sql)) return st;
    const bind = st.bind.bind(st);
    st.bind = (...a) => {
      const bound = bind(...a);
      const run = bound.run.bind(bound);
      bound.run = async () => { writes += 1; if (writes === 2) throw new Error('D1_ERROR: Network connection lost.'); return run(); };
      return bound;
    };
    return st;
  };
  await sync();
  env.DB.prepare = realPrepare;
  assert.ok((await readKitRow(env.DB, '22PTestJob001')).broadcast_id);
  await sync();
  assert.equal(kit.broadcasts.size, 1);
});

test('Kit’s segments not listing never moves a draft to the tag of the same name', async () => {
  const inner = globalThis.fetch;
  globalThis.fetch = async (input, init) => (String(input?.url || input).includes('/segments') ? new Response('down', { status: 503 }) : inner(input, init));
  try { assert.equal((await sync()).kit, 'error'); } finally { globalThis.fetch = inner; }
  assert.equal(kit.broadcasts.size, 0);
});

test('story text from a bio shows its apostrophes', () => {
  const e = revealInviteEmail({ kid: { ...KID, heroSummary: '', bio: '<p>Rowan&#39;s favorite room</p>' }, date: '2027-03-12', time: '16:00', address: '100 Example Way' });
  assert.ok(!e.html.includes('&amp;#39;'));
  assert.ok(!e.text.includes('&#39;'));
});

test('a pending "update your draft" survives a hold and back on', async () => {
  await sync();
  only().content += '<p>Linzi’s own line</p>';
  kit.resendDown = true;
  const moved = plan({ start: '17:00' });
  await sync(moved);
  await hold();
  kit.resendDown = false;
  await sync(moved);
  assert.equal(emails.at(-1).subject, 'Rowan’s reveal changed: please update your draft', 'not "ready"');
});

test('the tracker’s view: read from Kit each time, written nowhere', async () => {
  assert.deepEqual(await kitInviteStatus(env, ['22PTestJob001']), {});
  await sync();
  const row = await readKitRow(env.DB, '22PTestJob001');
  const status = async () => (await kitInviteStatus(env, ['22PTestJob001']))['22PTestJob001'];
  assert.equal((await status()).state, 'draft');
  assert.equal((await status()).id, row.broadcast_id);
  assert.equal((await status()).edited, false);
  only().content += '<p>edit</p>';
  assert.equal((await status()).edited, true);
  Object.assign(only(), { status: 'scheduled', send_at: '2027-03-01T15:00:00Z' });
  assert.deepEqual([(await status()).state, (await status()).at], ['scheduled', '2027-03-01T15:00:00Z']);
  Object.assign(only(), { status: 'completed', send_at: '2027-03-01T15:00:00Z' });
  assert.equal((await status()).state, 'sent');
  Object.assign(only(), { status: 'draft', send_at: null, subscriber_filter: everyone });
  assert.equal((await status()).state, 'check');
  kit.readDown = true;
  assert.equal((await status()).state, 'draft', 'Kit not answering: the site’s last word');
  kit.readDown = false;
  kit.broadcasts.clear();
  assert.equal((await status()).state, 'deleted');
  assert.equal((await readKitRow(env.DB, '22PTestJob001')).state, 'draft', 'read only');
});

test('the tracker shows a hold and a problem', async () => {
  await sync();
  await hold('status is Denied');
  assert.equal((await kitInviteStatus(env, ['22PTestJob001']))['22PTestJob001'].held, 'status is Denied');
  await env.DB.prepare('DELETE FROM reveal_invite_kit').run();
  kit.broadcasts.clear();
  kit.groups = { tags: [], segments: [] };
  await sync();
  const s = (await kitInviteStatus(env, ['22PTestJob001']))['22PTestJob001'];
  assert.equal(s.state, 'waiting');
  assert.match(s.error, /no group/);
});

test('drafts made before the site kept track carry on without a repeat note', async () => {
  await sync();
  await env.DB.prepare('UPDATE reveal_invite_kit SET told = NULL, content_hash = NULL, audience_ref = NULL').run();
  const n = emails.length;
  assert.equal((await sync()).kit, 'unchanged');
  assert.equal(emails.length, n);
  const row = await readKitRow(env.DB, '22PTestJob001');
  assert.equal(row.audience_ref, 'segment:587253');
  assert.equal(row.content_hash, 'unknown', 'nobody can say it wasn’t edited');
  const before = only().content;
  assert.equal((await sync(plan({ start: '17:00' }))).kit, 'edited', 'so a JobTread change goes to her, not over it');
  assert.equal(only().content, before);
  assert.equal((await sync(plan({ start: '17:00' }), { rewrite: true })).kit, 'updated', 'a rewrite asked for by hand still works');
  assert.match(only().content, /5:00 PM/);
  assert.equal((await sync(plan({ start: '18:00' }))).kit, 'updated', 'and it follows JobTread from then on');
});

// ─── A third reviewer's sequences (Nov 4 2026) ─────────────────────────────────────────────
const scheduled = () => Object.assign(only(), { status: 'scheduled', send_at: '2027-03-01T15:00:00Z' });
const sent = () => Object.assign(only(), { status: 'completed', send_at: '2027-03-01T15:00:00Z' });
const edit = (line = 'her line') => { only().content += `<p>${line}</p>`; };
const says = (e, re) => assert.match(`${e.subject} ${e.text}`, re);

test('she follows the note, fixes it by hand and sends it: no false "send an update"', async () => {
  await sync();
  edit();
  const moved = plan({ start: '17:00' });
  await sync(moved);
  assert.equal(emails.at(-1).subject, 'Rowan’s reveal changed: please update your draft');
  edit('now says 5');
  sent();
  const n = emails.length;
  await sync(moved);
  await sync(moved);
  assert.equal(emails.length, n, 'she already knows what JobTread says');
});

test('the likely path: early draft, she adds to it, it’s confirmed, she adds the time, she sends', async () => {
  const tentative = { action: 'upsert', confirmed: false, date: '2027-03-12', facts: { date: '2027-03-12', start: null, end: null, confirmed: false, address: '100 Example Way, Atlanta, GA 30301', details: '' } };
  await sync(tentative, { early: true });
  edit();
  await sync();
  assert.equal(emails.at(-1).subject, 'Rowan’s reveal changed: please update your draft');
  edit('at 4');
  sent();
  const n = emails.length;
  await sync();
  assert.equal(emails.length, n);
});

test('following the "edited" note into scheduling, unscheduling and scheduling again stays quiet', async () => {
  await sync();
  edit();
  const moved = plan({ start: '17:00' });
  await sync(moved);
  const n = emails.length;
  scheduled();
  await sync(moved);
  Object.assign(only(), { status: 'draft', send_at: null });
  await sync(moved);
  scheduled();
  await sync(moved);
  assert.equal(emails.length, n);
});

test('fixed after the "scheduled" note, then sent: quiet', async () => {
  await sync();
  scheduled();
  const moved = plan({ start: '17:00' });
  await sync(moved);
  const n = emails.length;
  sent();
  await sync(moved);
  assert.equal(emails.length, n);
});

test('a hand-edited draft is never called matching: JobTread going back still reaches her', async () => {
  await sync();
  edit();
  await sync(plan({ date: '2027-04-02' }));
  edit('she changed it to April');
  await sync();
  const note = emails.at(-1);
  assert.equal(note.subject, 'Rowan’s reveal changed: please update your draft', 'not "now says what JobTread says"');
  says(note, /March 12, 2027/);
  assert.equal((await readKitRow(env.DB, '22PTestJob001')).told.split(':')[0], 'edited');
});

test('she hasn’t touched it and JobTread goes back: the draft does too, and she hears', async () => {
  await sync();
  await sync(plan({ start: '17:00' }));
  assert.equal((await sync()).kit, 'updated');
  assert.match(only().content, /4:00 PM/);
});

test('scheduled, JobTread moves, then back: the note asks her to check, and never says "unschedule" of something sent', async () => {
  await sync();
  scheduled();
  await sync(plan({ start: '17:00' }));
  await sync();
  says(emails.at(-1), /Check it says what’s below/);
  says(emails.at(-1), /4:00 PM/);
  await env.DB.prepare('DELETE FROM reveal_invite_kit').run();
  kit.broadcasts.clear();
  await sync();
  scheduled();
  await sync(plan({ start: '17:00' }));
  sent();
  await sync();
  assert.equal(emails.at(-1).subject, 'Rowan’s reveal changed after the invite went out');
});

test('the kid’s page hiding, or the kids failing to load, isn’t JobTread changing the reveal', async () => {
  for (const state of [sent, scheduled, () => edit(), () => {}]) {
    await readKitRow(env.DB, 'makes-the-table');
    await env.DB.prepare('DELETE FROM reveal_invite_kit').run();
    kit.broadcasts.clear();
    await sync();
    state();
    await sync();
    const n = emails.length;
    await sync(plan(), { who: { name: 'Rowan', slug: null, url: null } });
    await sync();
    assert.equal(emails.length, n);
  }
});

test('Kit going quiet with nothing waiting on it emails nobody, in any state', async () => {
  for (const state of [sent, scheduled, () => {}]) {
    await readKitRow(env.DB, 'makes-the-table');
    await env.DB.prepare('DELETE FROM reveal_invite_kit').run();
    kit.broadcasts.clear();
    await sync();
    state();
    const moved = plan({ start: '17:00' });
    await sync(moved);
    const n = emails.length;
    for (let i = 0; i < 3; i++) {
      kit.readDown = true;
      await sync(moved);
      await sync(moved);
      kit.readDown = false;
      await sync(moved);
    }
    assert.equal(emails.length, n);
  }
});

test('held and told, Kit going quiet emails nobody', async () => {
  await sync();
  await hold();
  const n = emails.length;
  kit.readDown = true;
  await hold();
  await hold();
  assert.equal(emails.length, n);
});

test('Kit quiet for one look isn’t an alarm; still quiet on the next, with a change waiting, is', async () => {
  await sync();
  kit.readDown = true;
  const moved = plan({ start: '17:00' });
  const n = emails.length;
  await sync(moved);
  assert.equal(emails.length, n);
  await sync(moved);
  assert.ok(emails.length > n);
  says(emails.at(-1), /may still have the old details/);
});

test('re-aimed, and the page can’t fill a rewrite: the audience alarm still goes', async () => {
  await sync();
  only().subscriber_filter = everyone;
  await env.DB.prepare('UPDATE kids SET data = ? WHERE slug = ?').bind(JSON.stringify({ ...KID, publishStatus: 'draft' }), KID.slug).run();
  assert.equal((await sync(plan({ start: '17:00' }))).kit, 'check');
  assert.ok(emails.some((e) => /Check who/.test(e.subject)));
  assert.equal((await readKitRow(env.DB, '22PTestJob001')).state, 'check audience');
});

test('re-aimed, and Kit refuses the rewrite: the audience alarm still goes, once', async () => {
  await sync();
  only().subscriber_filter = everyone;
  kit.putRefused = true;
  assert.equal((await sync(plan({ start: '17:00' }))).kit, 'check');
  const n = emails.filter((e) => /Check who/.test(e.subject)).length;
  assert.ok(n > 0);
  await sync(plan({ start: '17:00' }));
  assert.equal(emails.filter((e) => /Check who/.test(e.subject)).length, n);
});

test('re-aimed and sent before a look saw it: staff hear, and the tracker doesn’t call it done', async () => {
  await sync();
  sent();
  only().subscriber_filter = everyone;
  assert.equal((await sync()).kit, 'check');
  const alarm = emails.find((e) => /Check who/.test(e.subject));
  assert.match(alarm.text, /went out to more than Reveal Emails/);
  assert.match(alarm.text, /check in Kit who received it/);
  const s = (await kitInviteStatus(env, ['22PTestJob001']))['22PTestJob001'];
  assert.equal(s.state, 'sent');
  assert.match(s.error, /went out to more than/);
});

test('back on reaches her whatever’s become of the draft', async () => {
  for (const [state, re] of [[sent, /already went out/], [scheduled, /still scheduled in Kit/], [() => edit(), /was edited/]]) {
    await readKitRow(env.DB, 'makes-the-table');
    await env.DB.prepare('DELETE FROM reveal_invite_kit').run();
    kit.broadcasts.clear();
    await sync();
    await hold();
    state();
    await sync(plan({ start: '17:00' }));
    assert.equal(emails.at(-1).subject, 'Rowan’s reveal invite is back on');
    says(emails.at(-1), re);
    says(emails.at(-1), /5:00 PM/);
  }
});

test('the tracker’s hold is where things stand, not what she heard', async () => {
  await sync();
  kit.resendDown = true;
  await hold('job closed');
  assert.equal((await kitInviteStatus(env, ['22PTestJob001']))['22PTestJob001'].held, 'job closed', 'the hold email failed, the hold is still real');
  kit.resendDown = false;
  await hold('job closed');
  kit.resendDown = true;
  await sync();
  assert.equal((await kitInviteStatus(env, ['22PTestJob001']))['22PTestJob001'].held, null, 'back on, whether or not that email went');
});

test('a change the site wrote but lost track of, then JobTread going back: it’s the site’s own write, not an edit', async () => {
  await sync();
  const moved = plan({ start: '17:00' });
  const row = await readKitRow(env.DB, '22PTestJob001');
  await sync(moved);
  await env.DB.prepare('UPDATE reveal_invite_kit SET hash = ?, content_hash = ?, told = ? WHERE job_id = ?').bind(row.hash, row.content_hash, row.told, row.job_id).run();
  assert.equal((await sync()).kit, 'updated');
  assert.match(only().content, /4:00 PM/);
});

test('a lost answer with the read-back down too doesn’t claim to know', async () => {
  await sync();
  kit.loseAnswer = true;
  const inner = globalThis.fetch;
  let reads = 0;
  globalThis.fetch = async (input, init = {}) => {
    if (/broadcasts\/\d+$/.test(String(input?.url || input)) && (init.method || 'GET') === 'GET' && ++reads > 2) return new Response('down', { status: 503 });
    return inner(input, init);
  };
  try { assert.equal((await sync(plan({ start: '17:00' }))).kit, 'error'); } finally { globalThis.fetch = inner; }
  assert.ok(emails.some((e) => /may still have the old details/.test(e.text)));
  assert.ok(!emails.some((e) => /it still has the old details/.test(e.text)));
});

test('confirmed with no time: her note says that, not "ahead of the confirmation"', async () => {
  await sync({ ...plan({ start: null }), confirmed: true }, { early: true });
  assert.match(emails[0].text, /the Reveal task has no time yet/);
  assert.ok(!/ahead of JobTread/.test(emails[0].text));
  await sync({ ...plan({ start: null, details: 'New note' }), confirmed: true });
  assert.match(emails.at(-1).text, /The time isn’t in JobTread yet/);
});

test('a send cancelled in Kit is as good as deleted', async () => {
  await sync();
  only().status = 'aborted';
  assert.equal((await kitInviteStatus(env, ['22PTestJob001']))['22PTestJob001'].state, 'deleted');
  assert.equal((await sync(plan({ start: '17:00' }))).reason, 'the draft was deleted in Kit');
  assert.equal((await sync(plan({ start: '17:00' }), { early: true })).kit, 'drafted');
});

test('the tracker shows an error or an edit on a draft', async () => {
  await sync();
  kit.putRefused = true;
  await sync(plan({ start: '17:00' }));
  assert.match((await kitInviteStatus(env, ['22PTestJob001']))['22PTestJob001'].error, /old details/);
});

test('every note, every step: repeats are quiet, and the classes do what they say', () => {
  const classes = ['ready', 'early', 'edited', 'queued', 'sent'];
  for (const c of classes) assert.equal(noteFor(`${c}:H`, `${c}:H`, 'H'), null, c);
  assert.equal(noteFor('held:draft:x', 'held:draft:x', 'H'), null);
  for (const now of ['sent', 'queued', 'edited']) for (const was of classes) assert.equal(noteFor(`${now}:H`, `${was}:H`, 'H'), null, `${was} → ${now} at the same facts: she knows`);
  assert.equal(noteFor('sent:B', 'ready:A', 'B', true), 'after-send');
  assert.equal(noteFor('queued:B', 'ready:A', 'B', true), 'scheduled');
  assert.equal(noteFor('edited:B', 'ready:A', 'B', true), 'edited');
  assert.equal(noteFor('ready:B', 'ready:A', 'B'), 'updated');
  assert.equal(noteFor('ready:B', 'early:A', 'B'), 'confirmed');
  assert.equal(noteFor('ready:A', null, 'A'), 'created');
  assert.equal(noteFor('early:A', null, 'A'), 'early');
  for (const now of ['ready', 'early', 'edited', 'queued', 'sent']) assert.equal(noteFor(`${now}:A`, 'held:draft:x', 'A'), 'back-on', now);
  assert.equal(noteFor('sent:A', null, 'A', false), null, 'never told, nothing changed');
});

// ─── Design checks, from reading the whole email (Nov 4 2026) ─────────────────────────────
test('the label over the headline gives the day, not the headline’s own words', () => {
  const e = revealInviteEmail({ kid: KID, date: '2027-03-12', time: '16:00', address: '100 Example Way' });
  assert.match(e.html, /Reveal Day · Fri, Mar 12/);
  assert.ok(!/>You’re invited</i.test(e.html));
  assert.match(e.html, />You’re Invited to<\/span>Rowan’s <em[^>]*>Reveal&nbsp;Day<\/em>\./);
});

test('Save it to your calendar is the main action, and See the story sits with the story', () => {
  const { html } = revealInviteEmail({ kid: KID, date: '2027-03-12', time: '16:00', address: '100 Example Way' });
  assert.match(html, /<td align="center" bgcolor="#FFDA24"[^>]*><a [^>]*calendar\.ics/);
  assert.ok(html.indexOf('See Rowan’s Story') < html.indexOf('Our partners'));
  assert.ok(html.indexOf('Our partners') > 0, 'the label doesn’t repeat the headline under it');
  assert.ok(!/<a [^>]*kids\/rowan-test\/"[^>]*background:#FFDA24/.test(html), 'one main action');
});

test('logos are trimmed of their blank margins, so they fill their cards', () => {
  const { html } = revealInviteEmail({ kid: KID, date: '2027-03-12', time: '16:00', address: '100 Example Way' });
  assert.match(html, /partners\/msi\/trim=border,w=400/);
});

test('a kid’s photo that won’t load gives way to the next, the hero too', async () => {
  const kid = { ...KID, heroImage: 'https://imagedelivery.net/ROYFuPmfN2vPS6mt5sCkZQ/kids/rowan-test/broken-hero.jpg/public', photos: [
    { url: 'https://imagedelivery.net/ROYFuPmfN2vPS6mt5sCkZQ/kids/rowan-test/a.jpg/public' },
    { url: 'https://imagedelivery.net/ROYFuPmfN2vPS6mt5sCkZQ/kids/rowan-test/broken-b.jpg/public' },
    { url: 'https://imagedelivery.net/ROYFuPmfN2vPS6mt5sCkZQ/kids/rowan-test/c.jpg/public' },
    { url: 'https://imagedelivery.net/ROYFuPmfN2vPS6mt5sCkZQ/kids/rowan-test/d.jpg/public' },
  ] };
  await env.DB.prepare('UPDATE kids SET data = ? WHERE slug = ?').bind(JSON.stringify(kid), KID.slug).run();
  await sync();
  const html = only().content;
  assert.ok(!/broken-/.test(html), 'no broken picture');
  assert.match(html, /kids\/rowan-test\/a\.jpg\/w=1200,h=880/, 'the next photo leads');
  assert.match(html, /kids\/rowan-test\/c\.jpg\/w=500/);
  assert.match(html, /kids\/rowan-test\/d\.jpg\/w=500/);
});
