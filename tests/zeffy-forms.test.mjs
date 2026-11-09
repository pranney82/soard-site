/**
 * The Zeffy form dropdowns: SOARD's Zeffy forms read for admin (functions/api/_zeffy-forms.js, /api/zeffy-forms),
 * and which form a link goes to and how the dropdown groups them (public/admin/zeffy-forms.js).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { kindOf, formOf, zeffyForms } from '../functions/api/_zeffy-forms.js';
import { onRequestGet as staffGet } from '../functions/api/zeffy-forms.js';
import { routesFor, BOARD_ROUTES, ADVISORY_ROUTES } from '../functions/api/_board-roles.js';
import { zeffyKey, sameForm, formGroups, KINDS } from '../public/admin/zeffy-forms.js';

const camp = (over = {}) => ({
  id: 'c1', object: 'campaign', created: 1760000000, deleted_at: null, type: 'donation_form', category: 'donation', status: 'active',
  title: 'Help Build a Brighter Home', url: 'https://www.zeffy.com/en-US/donation-form/help-build-a-brighter-home', is_archived: false, ...over,
});

/** Zeffy's /campaigns, a page at a time, as its API answers */
function fakeZeffy(pages, seen = []) {
  return async (url, init) => {
    const u = new URL(url);
    seen.push({ path: u.pathname, params: Object.fromEntries(u.searchParams), auth: init?.headers?.Authorization });
    const i = u.searchParams.get('starting_after') ? Number(u.searchParams.get('starting_after').slice(1)) : 0;
    const last = i === pages.length - 1;
    return Response.json({ object: 'list', data: pages[i], has_more: !last, next_cursor: last ? null : `p${i + 1}` });
  };
}

test('each kind of Zeffy campaign lands in its group', () => {
  assert.equal(kindOf(camp()), 'donation');
  assert.equal(kindOf(camp({ category: 'fundraiser' })), 'donation');
  assert.equal(kindOf(camp({ type: 'ticketing', category: 'event' })), 'tickets');
  assert.equal(kindOf(camp({ type: 'ticketing', category: 'custom' })), 'tickets');
  assert.equal(kindOf(camp({ category: 'peer_to_peer' })), 'peer');
  assert.equal(kindOf(camp({ category: 'peer-to-peer' })), 'peer');
  assert.equal(kindOf(camp({ type: 'ticketing', category: 'auction' })), 'auction');
  assert.equal(kindOf(camp({ type: 'ticketing', category: 'sweepstakes' })), 'raffle');
  assert.equal(kindOf(camp({ category: 'membership' })), 'membership');
  for (const k of ['donation', 'tickets', 'peer', 'auction', 'raffle', 'membership', 'shop']) assert.ok(KINDS[k], k);
});

test('a deleted form, or one with no page, isn’t offered; a closed, archived or draft one is marked not open', () => {
  assert.deepEqual(formOf(camp({ title: '  Help  Build ' })), { id: 'c1', title: 'Help Build', url: camp().url, kind: 'donation', open: true, created: 1760000000 });
  assert.equal(formOf(camp({ deleted_at: 1761000000 })), null);
  assert.equal(formOf(camp({ url: null })), null);
  assert.equal(formOf(camp({ url: 'javascript:alert(1)' })), null);
  assert.equal(formOf(camp({ id: '' })), null);
  assert.equal(formOf(camp({ is_archived: true })).open, false);
  for (const status of ['closed', 'draft', 'inactive', 'ended']) assert.equal(formOf(camp({ status })).open, false, status);
  assert.equal(formOf(camp({ title: '' })).title, 'Untitled form');
});

test('every page of Zeffy’s forms is read, newest first, with the site’s key', async () => {
  const seen = [];
  const forms = await zeffyForms({ ZEFFY_API_KEY: ' key_1 ' }, fakeZeffy([
    [camp({ id: 'old', created: 100 }), camp({ id: 'gone', deleted_at: 5 })],
    [camp({ id: 'new', created: 300, type: 'ticketing', category: 'event', url: 'https://www.zeffy.com/en-US/ticketing/gala' })],
    [camp({ id: 'mid', created: 200 })],
  ], seen));
  assert.deepEqual(forms.map((f) => f.id), ['new', 'mid', 'old']);
  assert.equal(seen.length, 3);
  assert.equal(seen[0].path, '/api/v1/campaigns');
  assert.equal(seen[0].params.limit, '100');
  assert.equal(seen[0].auth, 'Bearer key_1');
  assert.equal(seen[1].params.starting_after, 'p1');
});

test('Zeffy unconnected or refusing says so in plain words, never as the person’s sign-in running out', async () => {
  await assert.rejects(zeffyForms({}), (e) => e.status === 503 && /ZEFFY_API_KEY is missing/.test(e.message));
  const answer = (status) => async () => Response.json({ error: { message: 'Invalid API key sk_live_secret' } }, { status });
  const quiet = console.error;
  console.error = () => {};
  try {
    await assert.rejects(zeffyForms({ ZEFFY_API_KEY: 'k' }, answer(401)), (e) => e.status === 503 && !/sk_live/.test(e.message) && /Zeffy didn’t answer/.test(e.message));
    await assert.rejects(zeffyForms({ ZEFFY_API_KEY: 'k' }, answer(429)), (e) => e.status === 503 && /busy/.test(e.message));
  } finally {
    console.error = quiet;
  }
  const res = await staffGet({ env: {} });
  assert.equal(res.status, 503);
  const j = await res.json();
  assert.equal(j.success, false);
  assert.match(j.error, /ZEFFY_API_KEY/);
});

test('the staff route is staff only: board and advisory sign-ins can’t reach it', () => {
  const route = '/api/zeffy-forms';
  assert.ok(!BOARD_ROUTES.includes(route) && !ADVISORY_ROUTES.includes(route));
  assert.ok(!routesFor({ member: { slug: 'm', committees: ['Advisory Board'] } }).includes(route));
  assert.ok(!routesFor({ advisor: { slug: 'a' } }).includes(route));
});

test('a link finds its form whatever its language, www, tracking, embed or trailing slash', () => {
  const url = 'https://www.zeffy.com/en-US/donation-form/help-build-axels-accessible-bathroom';
  for (const same of [
    'https://zeffy.com/en-US/donation-form/help-build-axels-accessible-bathroom',
    'http://www.zeffy.com/fr-CA/donation-form/help-build-axels-accessible-bathroom/',
    'https://www.zeffy.com/en-US/donation-form/Help-Build-Axels-Accessible-Bathroom?utm_source=fb#top',
    'https://www.zeffy.com/embed/donation-form/help-build-axels-accessible-bathroom',
    '  HTTPS://www.zeffy.com/en/donation-form/help-build-axels-accessible-bathroom ',
  ]) assert.ok(sameForm(same, url), same);
  // Typed without https:// it would open a page of our own site: no form's link, so the dropdown asks and a pick fixes it
  for (const broken of ['zeffy.com/en-US/donation-form/help-build-axels-accessible-bathroom', 'www.zeffy.com/en-US/donation-form/help-build-axels-accessible-bathroom']) {
    assert.ok(!sameForm(broken, url), broken);
  }
  assert.ok(!sameForm('https://www.zeffy.com/en-US/donation-form/help-build-a-brighter-home', url));
  assert.ok(!sameForm('https://notzeffy.com/en-US/donation-form/help-build-axels-accessible-bathroom', url));
  assert.ok(!sameForm('https://www.zeffy.com/', 'https://www.zeffy.com/en-US'));
  assert.ok(!sameForm('', ''));
  assert.equal(zeffyKey('https://docs.google.com/forms/d/x'), '');
});

test('the dropdown: the field’s kinds first, newest first, closed forms only when already chosen, twin titles told apart', () => {
  const f = (id, kind, created, over = {}) => ({ id, title: id, url: `https://www.zeffy.com/en-US/x/${id}`, kind, open: true, created, ...over });
  const forms = [
    f('home', 'donation', 100), f('axel', 'donation', 300), f('gala', 'tickets', 200),
    f('old-gala', 'tickets', 50, { open: false }), f('p2p', 'peer', 10),
    f('golf-a', 'tickets', 1736900000, { title: 'Golf' }), f('golf-b', 'tickets', 1765800000, { title: 'Golf' }),
  ];
  const { chosen, groups } = formGroups(forms, { value: '', prefer: ['tickets'] });
  assert.equal(chosen, null);
  assert.deepEqual(groups.map((g) => g.kind), ['tickets', 'donation', 'peer']);
  assert.deepEqual(groups[0].forms.map((x) => x.id), ['golf-b', 'golf-a', 'gala']);
  assert.deepEqual(groups[0].forms.map((x) => x.label), ['Golf · Dec 15, 2025', 'Golf · Jan 14, 2025', 'gala']);
  assert.deepEqual(groups[1].forms.map((x) => x.id), ['axel', 'home']);
  // A closed form shows only as the link already chosen, and says it's closed
  const was = formGroups(forms, { value: 'https://zeffy.com/en-CA/x/old-gala/' });
  assert.equal(was.chosen.id, 'old-gala');
  assert.equal(was.groups.find((g) => g.kind === 'tickets').forms.find((x) => x.id === 'old-gala').label, 'old-gala (closed)');
  assert.deepEqual(formGroups(forms).groups.map((g) => g.kind), ['donation', 'tickets', 'peer']);
  assert.deepEqual(formGroups(null).groups, []);
});

test('twins made the same day get the time, then a number; every label differs', () => {
  const at = 1762617600; // Nov 8 2025, 11:00 AM Eastern
  const f = (id, created) => ({ id, title: 'Gala', url: `https://www.zeffy.com/en-US/ticketing/${id}`, kind: 'tickets', open: true, created });
  const labels = formGroups([f('a', at), f('b', at + 3600), f('c', at + 60 * 86400), f('d', at + 3600), f('e', 0)]).groups[0].forms.map((x) => x.label);
  assert.equal(new Set(labels).size, 5, labels.join(' | '));
  assert.ok(labels.includes('Gala · Jan 7, 2026'), labels.join(' | '));
  assert.ok(labels.includes('Gala · Nov 8, 2025, 11:00 AM'), labels.join(' | '));
  assert.ok(labels.filter((l) => l.startsWith('Gala · Nov 8, 2025, 12:00 PM (')).length === 2, labels.join(' | '));
});

test('a field that keeps the form’s ID shows nothing chosen until the ID matches, so a pick can fill it in', () => {
  const forms = [{ id: 'p2p', title: 'Advisory Board 2026', url: 'https://www.zeffy.com/en-US/peer-to-peer/advisory-board-2026', kind: 'peer', open: true, created: 1 }];
  const url = 'https://www.zeffy.com/en-US/peer-to-peer/advisory-board-2026';
  assert.equal(formGroups(forms, { value: url, id: '' }).chosen, null);
  assert.equal(formGroups(forms, { value: url, id: 'other' }).chosen, null);
  assert.equal(formGroups(forms, { value: url, id: 'p2p' }).chosen.id, 'p2p');
  assert.equal(formGroups(forms, { value: url }).chosen.id, 'p2p');
});
