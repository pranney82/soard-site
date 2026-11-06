/**
 * The Advisory Board's meetings (functions/api/_advisory-meetings.js)
 * Run: node --test tests/advisory-meetings.test.mjs
 *
 * Their own table, so nothing that reads the board's meetings can reach one; added only here; an agenda from the
 * template; advisors see a meeting only once it's shared; the invite goes when a person presses Send invite, guests
 * hidden, Google Meet, and follows the meeting and the group after that. Mary runs it all as a board-member sign-in.
 */

import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createD1 } from './lib/d1-shim.mjs';
import { createR2 } from './lib/r2-shim.mjs';
import {
  TEMPLATE, DEFAULT_TIME, EVENT_PREFIX, advisoryName, createAdvisoryMeeting, saveAdvisoryMeeting, getAdvisoryMeeting, deleteAdvisoryMeeting, advisorView, meetingsFor,
  adminMeetings, isSharedAdvisoryMeeting, guestsOf, sendAdvisoryInvite, maybeSyncAdvisoryMeetings, meetingAction,
} from '../functions/api/_advisory-meetings.js';
import { whoIs, saveSettings } from '../functions/api/_advisory.js';
import { ensureSchema, listMeetings, getMeeting, fileFor, putFile } from '../functions/api/_board.js';
import { advisoryFileFor } from '../functions/api/advisory-file.js';
import { eventIdFor, clearTokenCache } from '../functions/api/_google-calendar.js';

const { privateKey: SA_PEM } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const SERVICE_ACCOUNT = JSON.stringify({ type: 'service_account', client_email: 'site@example.iam.gserviceaccount.com', client_id: '1', private_key: SA_PEM, token_uri: 'https://oauth2.googleapis.com/token', project_id: 'p' });

const NOW = Date.parse('2026-11-05T16:00:00Z');
const FUTURE = '2027-02-11';
const MIN = 60_000;
const PEOPLE = [
  ['jane-doe', { name: 'Jane Doe', group: 'team', title: 'Co-Founder/President', role: 'founder' }],
  ['mary-lead', { name: 'Mary Lead', group: 'board', committees: ['Advisory Board'] }],
  ['tom-committee', { name: 'Tom Committee', group: 'board', committees: ['Advisory Board'] }],
  ['bo-kim', { name: 'Bo Kim', group: 'board' }],
  ['ada-advisor', { name: 'Ada Advisor', group: 'advisory' }],
  ['cal-advisor', { name: 'Cal Advisor', group: 'advisory' }],
  ['dee-advisor', { name: 'Dee Advisor', group: 'advisory' }],
  ['no-email', { name: 'No Email', group: 'advisory' }],
  ['draft-person', { name: 'Draft Person', group: 'advisory', publishStatus: 'draft' }],
];
const EMAILS = { 'mary-lead': 'mary@example.com', 'tom-committee': 'tom@example.com', 'bo-kim': 'bo@example.com', 'ada-advisor': 'ada@example.com', 'cal-advisor': 'Cal@Example.org', 'dee-advisor': 'dee@example.com', 'draft-person': 'draft@example.com' };

let env, g;
const realFetch = globalThis.fetch;

/** A fake Google Calendar: events by id, every call kept */
function fakeGoogle() {
  const events = {};
  const calls = [];
  const world = { events, calls, refuseDelete: false };
  const answer = async (url, init = {}) => {
    const method = init.method || 'GET';
    if (String(url).startsWith('https://oauth2.googleapis.com/token')) return Response.json({ access_token: 't', expires_in: 3600 });
    const u = new URL(url);
    const body = init.body ? JSON.parse(init.body) : null;
    calls.push({ method, path: decodeURIComponent(u.pathname), sendUpdates: u.searchParams.get('sendUpdates'), body });
    const id = decodeURIComponent(u.pathname.split('/events/')[1] || '');
    if (method === 'POST') {
      const ev = { ...body, hangoutLink: 'https://meet.google.com/abc-defg-hij', status: 'confirmed' };
      events[ev.id] = ev;
      return Response.json(ev);
    }
    if (!events[id]) return Response.json({ error: { message: 'Not Found' } }, { status: 404 });
    if (method === 'GET') return Response.json(events[id]);
    if (method === 'PATCH') { events[id] = { ...events[id], ...body }; return Response.json(events[id]); }
    if (method === 'DELETE') {
      if (world.refuseDelete) return Response.json({ error: { message: 'Forbidden' } }, { status: 403 });
      delete events[id];
      return new Response(null, { status: 204 });
    }
    return Response.json({}, { status: 400 });
  };
  return { ...world, world, fetchImpl: answer };
}
const writes = () => g.calls.filter((c) => c.method !== 'GET');

async function person(slug, d) {
  await env.DB.prepare('INSERT OR REPLACE INTO team (slug, name, "group", data) VALUES (?, ?, ?, ?)').bind(slug, d.name, d.group, JSON.stringify(d)).run();
}
const ctx = (data) => ({ env, data, request: new Request('https://example.com/api/advisory-admin') });
const ADMIN = 'jane@soardcharity.com';
const lead = () => whoIs(ctx({ boardMember: { slug: 'mary-lead', name: 'Mary Lead', committees: ['Advisory Board'], email: 'mary@example.com' }, userEmail: 'mary@example.com' }));
const act = async (action, body = {}) => {
  const res = await meetingAction(ctx({}), { action, body, by: 'mary@example.com', w: await lead() });
  return { status: res.status, ...(await res.json()) };
};
const shareNew = async (date = FUTURE) => {
  const { meeting } = await createAdvisoryMeeting(env, { date, by: 'x' }, { now: NOW });
  await act('share-meeting', { id: meeting.id, shared: true });
  return getAdvisoryMeeting(env.DB, meeting.id);
};

beforeEach(async () => {
  const DB = await createD1();
  env = { DB, FILES: createR2(), GOOGLE_CALENDAR_KEY: SERVICE_ACCOUNT };
  clearTokenCache();
  g = fakeGoogle();
  await DB.exec('CREATE TABLE team (slug TEXT PRIMARY KEY, name TEXT, "group" TEXT, order_num INTEGER, data TEXT NOT NULL, updated_at TEXT)');
  await DB.exec('CREATE TABLE reveal_board_emails (slug TEXT PRIMARY KEY, email TEXT NOT NULL, updated_at TEXT)');
  await ensureSchema(DB);
  for (const [slug, d] of PEOPLE) await person(slug, d);
  for (const [slug, e] of Object.entries(EMAILS)) await DB.prepare('INSERT INTO reveal_board_emails (slug, email) VALUES (?, ?)').bind(slug, e).run();
  await saveSettings(DB, { lead: 'mary-lead' });
  globalThis.fetch = async () => { throw new Error('no outside calls in these tests'); };
  // Invites wait for the emails switch: on here, off in the test that says so
  await saveSettings(DB, { emails: true });
});
afterEach(() => { globalThis.fetch = realFetch; });

test('a new meeting starts on the template, on a weekday evening, named for its quarter', async () => {
  const { meeting: m, existing } = await createAdvisoryMeeting(env, { date: FUTURE }, { now: NOW });
  assert.equal(existing, false);
  assert.deepEqual(m.sections.map((s) => s.title), TEMPLATE.map((s) => s.title));
  assert.equal(m.start, DEFAULT_TIME.start);
  assert.equal(m.end, DEFAULT_TIME.end);
  assert.equal(advisoryName(m), 'Q1 2027 Advisory Board Meeting');
  assert.equal(m.shared, false, 'not on the page until someone shares it');
});

test('a new meeting copies the last one’s time and place, and a day already taken opens that meeting', async () => {
  const { meeting: a } = await createAdvisoryMeeting(env, { date: FUTURE }, { now: NOW });
  await saveAdvisoryMeeting(env.DB, { ...a, start: '17:00', end: '18:15', location: 'The Office', address: '1 Main St' }, { now: NOW + 1 });
  const { meeting: b } = await createAdvisoryMeeting(env, { date: '2027-05-13' }, { now: NOW });
  assert.equal(b.start, '17:00');
  assert.equal(b.location, 'The Office');
  assert.equal(b.address, '1 Main St');
  const again = await createAdvisoryMeeting(env, { date: FUTURE }, { now: NOW });
  assert.equal(again.existing, true);
  assert.equal(again.meeting.id, a.id);
});

test('nothing that reads the board’s meetings can reach one, and the board keeps its own table', async () => {
  const m = await shareNew();
  assert.deepEqual((await listMeetings(env.DB)).map((x) => x.id), []);
  assert.deepEqual((await listMeetings(env.DB, { practice: true })).map((x) => x.id), []);
  assert.equal(await getMeeting(env.DB, m.id), null);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM board_meetings').first()).n, 0);
});

test('the board page’s data never holds one', async () => {
  const m = await shareNew();
  const { portalData } = await import('../functions/api/_board.js');
  globalThis.fetch = async () => Response.json({}, { status: 500 });
  const data = await portalData(env, { admin: true, adminEmail: ADMIN, now: NOW });
  assert.ok(!JSON.stringify(data).includes(m.id));
});

test('a save keeps what’s the server’s and drops what the board has and advisors don’t', async () => {
  const { meeting: m } = await createAdvisoryMeeting(env, { date: FUTURE }, { now: NOW });
  const it = m.sections[0].items[0];
  const saved = await saveAdvisoryMeeting(env.DB, {
    ...m, shared: true, recapShared: true, invite: { eventId: 'forged', organizer: 'x@example.com' },
    sections: [{ ...m.sections[0], items: [{ ...it, title: 'Hello', motion: 'Move to approve', live: 'cash', also: ['costs'] }] }],
  }, { now: NOW + 1 });
  assert.equal(saved.shared, false);
  assert.equal(saved.recapShared, false);
  assert.equal(saved.invite, null);
  assert.equal(saved.sections[0].items[0].title, 'Hello');
  assert.equal(saved.sections[0].items[0].motion, '');
  assert.equal(saved.sections[0].items[0].live, '');
  assert.deepEqual(saved.sections[0].items[0].also, []);
  assert.deepEqual(saved.attendance, []);
});

test('saved by someone else meanwhile: refused with theirs; two meetings can’t share a day', async () => {
  const { meeting: m } = await createAdvisoryMeeting(env, { date: FUTURE, by: 'holly' }, { now: NOW });
  await assert.rejects(saveAdvisoryMeeting(env.DB, { ...m, title: 'Mine' }, { base: 'an older time', by: 'mary' }), (e) => e.status === 409 && e.current.id === m.id);
  await createAdvisoryMeeting(env, { date: '2027-05-13' }, { now: NOW });
  await assert.rejects(saveAdvisoryMeeting(env.DB, { ...m, date: '2027-05-13' }, {}), (e) => e.status === 409 && /already on that day/.test(e.message));
});

test('advisors see a meeting only once it’s shared, and never a staff note, a staff file, or who else is coming', async () => {
  const { meeting: m } = await createAdvisoryMeeting(env, { date: FUTURE }, { now: NOW });
  assert.deepEqual(await meetingsFor(env, { answers: true, slug: 'ada-advisor' }), []);
  assert.equal(await isSharedAdvisoryMeeting(env.DB, m.id), false);
  const sections = m.sections.map((s, i) => ({ ...s, items: s.items.map((it) => ({ ...it, staffNote: i ? '' : 'For Mary only' })) }));
  await saveAdvisoryMeeting(env.DB, { ...m, sections }, { now: NOW + 1 });
  await act('share-meeting', { id: m.id, shared: true });
  await env.DB.prepare('INSERT INTO board_files (id, owner_type, owner_id, r2_key, name, type, size, kind, staff_only, at, by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind('f_staff', 'advisory-meeting', m.id, 'board/x', 'Staff.pdf', 'application/pdf', 1, 'other', 1, 'now', 'x').run();
  await sendAdvisoryInvite(env, m.id, { fetchImpl: g.fetchImpl, now: NOW });
  const [v] = await meetingsFor(env, { answers: true, slug: 'ada-advisor' });
  const text = JSON.stringify(v);
  assert.equal(v.title, 'Q1 2027 Advisory Board Meeting');
  assert.equal(v.meet, 'https://meet.google.com/abc-defg-hij');
  assert.equal(v.myAnswer, 'invited');
  assert.ok(!text.includes('For Mary only'));
  assert.ok(!text.includes('Staff.pdf'));
  for (const e of ['ada@example.com', 'mary@example.com', 'cal@example.org', 'cal-advisor']) assert.ok(!text.includes(e), e);
});

test('a recap reaches the page only when shared, with its own files apart from the agenda’s', async () => {
  const m = await shareNew();
  await saveAdvisoryMeeting(env.DB, { ...m, recap: 'We met four new partners.' }, { now: NOW + 1 });
  const fresh = () => getAdvisoryMeeting(env.DB, m.id);
  await env.DB.prepare('INSERT INTO board_files (id, owner_type, owner_id, r2_key, name, type, size, kind, staff_only, at, by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind('f_recap', 'advisory-meeting', m.id, 'board/y', 'Photos.pdf', 'application/pdf', 1, 'minutes', 0, 'now', 'x').run();
  let v = advisorView(await fresh());
  assert.equal(v.recap, null);
  assert.ok(!JSON.stringify(v).includes('Photos.pdf'), 'its files wait with it');
  await act('share-recap', { id: m.id, shared: true });
  v = advisorView(await fresh());
  assert.equal(v.recap.text, 'We met four new partners.');
  assert.deepEqual(v.recap.files.map((f) => f.name), ['Photos.pdf']);
  assert.deepEqual(v.files, []);
});

test('an emptied recap comes off the page by itself, and an empty one can’t go on', async () => {
  const m = await shareNew();
  const none = await act('share-recap', { id: m.id, shared: true });
  assert.equal(none.status, 400);
  assert.match(none.error, /Write the recap/);
  await saveAdvisoryMeeting(env.DB, { ...m, recap: 'A good night.' }, { now: NOW + 1 });
  assert.equal((await act('share-recap', { id: m.id, shared: true })).meeting.recapShared, true);
  assert.equal(advisorView(await getAdvisoryMeeting(env.DB, m.id)).recap.text, 'A good night.');

  // Emptied: off the page, and it stays off once there are words again until someone shares it
  const had = await getAdvisoryMeeting(env.DB, m.id);
  const emptied = await saveAdvisoryMeeting(env.DB, { ...had, recap: '   ' }, { now: NOW + 2 });
  assert.equal(emptied.recapShared, false);
  assert.equal(advisorView(emptied).recap, null);
  const again = await saveAdvisoryMeeting(env.DB, { ...emptied, recap: 'Back again.' }, { now: NOW + 3 });
  assert.equal(again.recapShared, false);
  assert.equal(advisorView(again).recap, null);

  // A recap that's only a file: the file deleted takes it off too
  const form = new FormData();
  form.set('meetingId', m.id);
  form.set('kind', 'minutes');
  form.set('file', new File([new TextEncoder().encode('%PDF-1.4 photos')], 'Photos.pdf', { type: 'application/pdf' }));
  await saveAdvisoryMeeting(env.DB, { ...again, recap: '' }, { now: NOW + 4 });
  const up = await (await meetingAction(ctx({}), { action: 'upload', form, by: 'mary', w: await lead() })).json();
  assert.equal((await act('share-recap', { id: m.id, shared: true })).meeting.recapShared, true);
  const gone = await act('delete-meeting-file', { fileId: up.file.id });
  assert.equal(gone.meeting.recapShared, false);
  assert.equal(advisorView(gone.meeting).recap, null);
});

test('Google down: plain words, never what Google said; the emails switch has its own plain answer', async () => {
  const { meeting: m } = await createAdvisoryMeeting(env, { date: FUTURE }, { now: NOW });
  await saveSettings(env.DB, { emails: false });
  const off = await act('send-invite', { id: m.id });
  assert.equal(off.status, 409);
  assert.match(off.error, /Turn on emails/);
  await saveSettings(env.DB, { emails: true });
  globalThis.fetch = async (url) => (String(url).includes('oauth2') ? new Response('{"error":"backendError"}', { status: 503 }) : new Response('{}', { status: 503 }));
  const down = await act('send-invite', { id: m.id });
  assert.equal(down.status, 503);
  assert.equal(down.error, 'Google isn’t answering right now, so the invite didn’t go out. Try again in a few minutes.');
  globalThis.fetch = async () => { throw new Error('fetch failed'); };
  assert.match((await act('send-invite', { id: m.id })).error, /^Google isn’t answering/);
  // The site's own answers stay as they are
  const noKey = await meetingAction({ env: { ...env, GOOGLE_CALENDAR_KEY: '' } }, { action: 'send-invite', body: { id: m.id }, by: 'x', w: await lead() });
  assert.equal((await noKey.json()).error, 'Google Calendar isn’t connected yet. Peter or Holly can connect it.');
});

test('Update with nothing changed sends nothing; words go quietly; only a new day, time or place emails everyone', async () => {
  globalThis.fetch = g.fetchImpl;
  const { meeting: m } = await createAdvisoryMeeting(env, { date: FUTURE }, { now: NOW });
  assert.equal((await act('send-invite', { id: m.id })).ok, true);
  const before = writes().length;

  const same = await act('send-invite', { id: m.id });
  assert.equal(same.ok, true);
  assert.equal(same.unchanged, true);
  assert.equal(writes().length, before, 'nothing went to Google');

  const cur = await getAdvisoryMeeting(env.DB, m.id);
  await saveAdvisoryMeeting(env.DB, { ...cur, inviteNote: 'Use the side door' }, {});
  const words = await act('send-invite', { id: m.id });
  assert.equal(words.quiet, true);
  assert.equal(writes().at(-1).sendUpdates, 'none');

  const next = await getAdvisoryMeeting(env.DB, m.id);
  await saveAdvisoryMeeting(env.DB, { ...next, start: '19:00' }, {});
  const moved = await act('send-invite', { id: m.id });
  assert.equal(moved.quiet, false);
  assert.equal(writes().at(-1).sendUpdates, 'all');
  assert.equal((await act('send-invite', { id: m.id })).unchanged, true);

  // Someone new to add is a change, even with nothing else different
  await person('eve-new', { name: 'Eve New', group: 'advisory' });
  await env.DB.prepare('INSERT INTO reveal_board_emails (slug, email) VALUES (?, ?)').bind('eve-new', 'eve@example.com').run();
  assert.equal((await act('send-invite', { id: m.id })).unchanged, undefined);
  assert.ok(writes().at(-1).body.attendees.some((a) => a.email === 'eve@example.com'));
});

test('a meeting has to end after it starts, on a day that’s really a day', async () => {
  const { meeting: m } = await createAdvisoryMeeting(env, { date: FUTURE }, { now: NOW });
  for (const end of ['17:00', m.start]) await assert.rejects(saveAdvisoryMeeting(env.DB, { ...m, end }, {}), (e) => e.status === 400 && e.message === 'A meeting has to end after it starts. Check the times.');
  const said = await act('save-meeting', { meeting: { ...m, end: '17:00' } });
  assert.equal(said.status, 400);
  assert.match(said.error, /has to end after it starts/);
  assert.equal((await getAdvisoryMeeting(env.DB, m.id)).end, m.end, 'nothing changed');
  await assert.rejects(saveAdvisoryMeeting(env.DB, { ...m, date: '0202-02-11' }, {}), (e) => e.status === 400 && /date/.test(e.message));
  assert.equal((await act('new-meeting', { date: '0020-02-11' })).status, 400);
  // No start or no end has nothing to compare
  assert.equal((await saveAdvisoryMeeting(env.DB, { ...m, end: '' }, {})).end, '');
});

test('something that wasn’t written for a person never reaches them', async () => {
  const realPrepare = env.DB.prepare.bind(env.DB);
  const { meeting: m } = await createAdvisoryMeeting(env, { date: FUTURE }, { now: NOW });
  const w = await lead();
  env.DB.prepare = (sql) => { if (/^(INSERT OR REPLACE INTO advisory_meetings)/.test(sql)) throw new Error('D1_ERROR: answered 503 SQLITE_BUSY'); return realPrepare(sql); };
  const res = await meetingAction(ctx({}), { action: 'save-meeting', body: { meeting: m }, by: 'x', w });
  env.DB.prepare = realPrepare;
  assert.equal(res.status, 500);
  assert.equal((await res.json()).error, 'That didn’t go through. Try again in a moment.');
});

test('the screen gets the advisors, and from the board only the person running it or someone leading an item', async () => {
  await person('mary-lead', { ...PEOPLE[1][1], title: 'Board Member' });
  await person('tre-asurer', { name: 'Tre Asurer', group: 'board', seat: 'treasurer', title: 'Treasurer' });
  await person('ann-presents', { name: 'Ann Presents', group: 'board' });
  const { meeting: m } = await createAdvisoryMeeting(env, { date: FUTURE }, { now: NOW });
  let view = await act('meeting-view', { id: m.id });
  let slugs = view.people.map((p) => p.slug).sort();
  assert.deepEqual(slugs, ['ada-advisor', 'cal-advisor', 'dee-advisor', 'mary-lead', 'no-email']);
  assert.ok(!JSON.stringify(view).includes('Treasurer'));
  assert.ok(view.people.filter((p) => p.group === 'advisory').length >= 4, 'the Welcome slide’s faces');
  await saveAdvisoryMeeting(env.DB, { ...m, sections: m.sections.map((s, i) => (i ? s : { ...s, items: s.items.map((it) => ({ ...it, who: ['ann-presents'] })) })) }, {});
  view = await act('meeting-view', { id: m.id });
  assert.ok(view.people.some((p) => p.slug === 'ann-presents'));
  assert.ok(!view.people.some((p) => p.slug === 'tre-asurer'));
});

test('a save from a page that started before an upload never takes the file back off its item', async () => {
  const { meeting: m } = await createAdvisoryMeeting(env, { date: FUTURE }, { now: NOW });
  const item = m.sections[0].items[0];
  const form = new FormData();
  form.set('meetingId', m.id);
  form.set('itemId', item.id);
  form.set('file', new File([new TextEncoder().encode('%PDF-1.4 a file')], 'Update.pdf', { type: 'application/pdf' }));
  const up = await (await meetingAction(ctx({}), { action: 'upload', form, by: 'mary', w: await lead() })).json();
  const typed = { ...m, sections: m.sections.map((s, i) => (i ? s : { ...s, items: [{ ...item, title: 'Typed while it went up', docs: [] }, { id: 'i_newone', title: 'New item', docs: ['f_forged'] }] })) };
  const saved = await saveAdvisoryMeeting(env.DB, typed, {});
  assert.equal(saved.sections[0].items[0].title, 'Typed while it went up');
  assert.deepEqual(saved.sections[0].items[0].docs, [up.file.id]);
  assert.deepEqual(saved.sections[0].items[1].docs, [], 'a file is put on an item only by the file actions');
});

test('nothing sends whoever runs it to a screen they can’t open', async () => {
  const { readFileSync } = await import('node:fs');
  for (const f of ['functions/api/_advisory-meetings.js', 'public/admin/advisory-meeting.js', 'public/admin/advisory/meetings.js', 'public/admin/advisory/screen/page.js']) {
    const said = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8').split('\n').filter((l) => !/^\s*(\*|\/\/|\/\*)/.test(l)).join('\n');
    assert.ok(!/Board →|Settings →|GOOGLE_CALENDAR_KEY\)'|in Settings/.test(said), f);
  }
});

test('the invite: from the board’s organizer, Google Meet, guests hidden, advisors, the lead and the admins', async () => {
  const { meeting: m } = await createAdvisoryMeeting(env, { date: FUTURE }, { now: NOW });
  assert.equal(writes().length, 0, 'making a meeting sends nothing');
  const out = await sendAdvisoryInvite(env, m.id, { fetchImpl: g.fetchImpl, now: NOW });
  const post = writes()[0];
  assert.equal(post.method, 'POST');
  assert.equal(post.sendUpdates, 'all');
  assert.ok(post.path.includes('/calendars/jane@soardcharity.com/events'));
  assert.match(post.body.id, /^[a-v0-9]{5,1024}$/, 'an id Google takes');
  assert.equal(post.body.id, eventIdFor(EVENT_PREFIX, m.id));
  assert.equal(post.body.guestsCanSeeOtherGuests, false);
  assert.equal(post.body.summary, 'SOARD Q1 2027 Advisory Board Meeting');
  assert.equal(post.body.conferenceData.createRequest.conferenceSolutionKey.type, 'hangoutsMeet');
  assert.ok(post.body.description.includes(`/advisory/${m.id}`));
  const guests = post.body.attendees.map((a) => a.email).sort();
  assert.deepEqual(guests, ['ada@example.com', 'cal@example.org', 'dee@example.com', 'mary@example.com']);
  assert.equal(out.invite.meet, 'https://meet.google.com/abc-defg-hij');
  assert.deepEqual(Object.keys(out.invite.who).sort(), ['ada-advisor', 'cal-advisor', 'dee-advisor', 'mary-lead']);
  assert.equal(out.invite.replies['ada-advisor'], 'invited');
});

test('no draft advisor, no one without an email; the organizer isn’t a guest of their own invite', async () => {
  const { emails } = await guestsOf(env.DB);
  assert.ok(!emails.includes('draft@example.com'));
  assert.ok(emails.includes('jane@soardcharity.com'), 'an admin who isn’t sending it would be on it');
  const { meeting: m } = await createAdvisoryMeeting(env, { date: FUTURE }, { now: NOW });
  const out = await sendAdvisoryInvite(env, m.id, { fetchImpl: g.fetchImpl, now: NOW });
  assert.ok(!out.invite.emails.includes('jane@soardcharity.com'));
});

test('with no calendar key it says so; a meeting gone says so', async () => {
  const { meeting: m } = await createAdvisoryMeeting(env, { date: FUTURE }, { now: NOW });
  await assert.rejects(sendAdvisoryInvite({ ...env, GOOGLE_CALENDAR_KEY: '' }, m.id), (e) => e.status === 503);
  await assert.rejects(sendAdvisoryInvite(env, 'm_nothere', { fetchImpl: g.fetchImpl, now: NOW }), (e) => e.status === 404);
});

test('a new time goes to Google once it has stood two minutes; words alone go quietly', async () => {
  const { meeting: m } = await createAdvisoryMeeting(env, { date: FUTURE }, { now: NOW });
  const sent = await sendAdvisoryInvite(env, m.id, { fetchImpl: g.fetchImpl, now: NOW });
  const before = writes().length;
  await saveAdvisoryMeeting(env.DB, { ...sent, start: '19:00' }, { now: Date.now() });
  await maybeSyncAdvisoryMeetings(env, { fetchImpl: g.fetchImpl, now: Date.now() });
  assert.equal(writes().length, before, 'still settling');
  await env.DB.prepare("DELETE FROM board_state WHERE key = 'advisory-meetings'").run();
  await maybeSyncAdvisoryMeetings(env, { fetchImpl: g.fetchImpl, now: Date.now() + 3 * MIN });
  const patch = writes().at(-1);
  assert.equal(patch.method, 'PATCH');
  assert.equal(patch.sendUpdates, 'all');
  assert.ok(patch.body.start.dateTime.includes('T19:00'));

  const cur = await getAdvisoryMeeting(env.DB, m.id);
  await saveAdvisoryMeeting(env.DB, { ...cur, inviteNote: 'Park behind the building' }, { now: Date.now() });
  await env.DB.prepare("DELETE FROM board_state WHERE key = 'advisory-meetings'").run();
  await maybeSyncAdvisoryMeetings(env, { fetchImpl: g.fetchImpl, now: Date.now() + 3 * MIN });
  assert.equal(writes().at(-1).sendUpdates, 'none');
  assert.ok(writes().at(-1).body.description.includes('Park behind'));
});

test('someone joins or leaves: only the guest list changes, and they’re the only ones who hear', async () => {
  const { meeting: m } = await createAdvisoryMeeting(env, { date: FUTURE }, { now: NOW });
  await sendAdvisoryInvite(env, m.id, { fetchImpl: g.fetchImpl, now: NOW });
  await person('eve-new', { name: 'Eve New', group: 'advisory' });
  await env.DB.prepare('INSERT INTO reveal_board_emails (slug, email) VALUES (?, ?)').bind('eve-new', 'eve@example.com').run();
  await person('dee-advisor', { name: 'Dee Advisor', group: 'advisory', status: 'alumni' });
  await maybeSyncAdvisoryMeetings(env, { fetchImpl: g.fetchImpl, now: NOW + 3 * MIN });
  const p = writes().at(-1);
  assert.deepEqual(Object.keys(p.body), ['attendees']);
  assert.equal(p.sendUpdates, 'all');
  const on = p.body.attendees.map((a) => a.email);
  assert.ok(on.includes('eve@example.com'));
  assert.ok(!on.includes('dee@example.com'));
  const after = await getAdvisoryMeeting(env.DB, m.id);
  assert.equal(after.invite.replies['eve-new'], 'invited');
  assert.equal(after.invite.replies['dee-advisor'], undefined);
});

test('more than half gone at once is held, never carried out', async () => {
  const { meeting: m } = await createAdvisoryMeeting(env, { date: FUTURE }, { now: NOW });
  await sendAdvisoryInvite(env, m.id, { fetchImpl: g.fetchImpl, now: NOW });
  const before = writes().length;
  for (const s of ['ada-advisor', 'cal-advisor', 'dee-advisor']) await person(s, { name: s, group: 'advisory', status: 'alumni' });
  const did = await maybeSyncAdvisoryMeetings(env, { fetchImpl: g.fetchImpl, now: NOW + 3 * MIN });
  assert.equal(did.held, 1);
  assert.equal(writes().length, before);
});

test('the hourly read: answers come in, a deleted invite is marked, a change in Google is put back once', async () => {
  const { meeting: m } = await createAdvisoryMeeting(env, { date: FUTURE }, { now: NOW });
  const sent = await sendAdvisoryInvite(env, m.id, { fetchImpl: g.fetchImpl, now: NOW });
  const ev = g.events[sent.invite.eventId];
  ev.attendees = ev.attendees.map((a) => (a.email === 'ada@example.com' ? { ...a, responseStatus: 'accepted' } : a));
  await maybeSyncAdvisoryMeetings(env, { fetchImpl: g.fetchImpl, now: NOW });
  assert.equal((await getAdvisoryMeeting(env.DB, m.id)).invite.replies['ada-advisor'], 'accepted');

  // Moved in Google Calendar
  ev.start = { dateTime: `${FUTURE}T09:00:00`, timeZone: 'America/New_York' };
  await maybeSyncAdvisoryMeetings(env, { fetchImpl: g.fetchImpl, now: NOW + 61 * MIN });
  assert.ok(g.events[sent.invite.eventId].start.dateTime.includes('T18:30'), 'put back');
  const was = (await getAdvisoryMeeting(env.DB, m.id)).invite;
  assert.ok(was.putBackAt);

  // Deleted there
  delete g.events[sent.invite.eventId];
  await maybeSyncAdvisoryMeetings(env, { fetchImpl: g.fetchImpl, now: NOW + 125 * MIN });
  const gone = await getAdvisoryMeeting(env.DB, m.id);
  assert.equal(gone.invite, null);
  assert.ok(gone.inviteGone);
});

test('the heartbeat never throws, and past meetings are left alone', async () => {
  const { meeting: m } = await createAdvisoryMeeting(env, { date: FUTURE }, { now: NOW });
  await sendAdvisoryInvite(env, m.id, { fetchImpl: g.fetchImpl, now: NOW });
  const before = g.calls.length;
  assert.equal(await maybeSyncAdvisoryMeetings({ DB: env.DB }, { now: NOW }), null);
  await env.DB.prepare("DELETE FROM board_state WHERE key = 'advisory-meetings'").run();
  const did = await maybeSyncAdvisoryMeetings(env, { fetchImpl: g.fetchImpl, now: Date.parse('2027-03-01T16:00:00Z') });
  assert.equal(did.replies, 0);
  assert.equal(g.calls.length, before);
  await env.DB.prepare("DELETE FROM board_state WHERE key = 'advisory-meetings'").run();
  const bad = await maybeSyncAdvisoryMeetings(env, { fetchImpl: async () => { throw new Error('down'); }, now: NOW });
  assert.equal(bad.failed, 1);
});

test('a deleted meeting’s invite comes off first; Google refusing stops the delete', async () => {
  const { meeting: m } = await createAdvisoryMeeting(env, { date: '2099-01-14' }, { now: NOW });
  await sendAdvisoryInvite(env, m.id, { fetchImpl: g.fetchImpl, now: NOW });
  g.world.refuseDelete = true;
  await assert.rejects(deleteAdvisoryMeeting(env, m.id, { fetchImpl: g.fetchImpl, now: NOW }));
  assert.ok(await getAdvisoryMeeting(env.DB, m.id));
  g.world.refuseDelete = false;
  await deleteAdvisoryMeeting(env, m.id, { fetchImpl: g.fetchImpl, now: NOW });
  assert.equal(await getAdvisoryMeeting(env.DB, m.id), null);
  assert.equal(writes().at(-1).method, 'DELETE');
  assert.equal(writes().at(-1).sendUpdates, 'all');
});

test('Mary, a board member, runs all of it through the same actions', async () => {
  const w = await lead();
  assert.equal(w.kind, 'lead');
  assert.equal(w.runs, true);
  const made = await act('new-meeting', { date: FUTURE });
  assert.equal(made.ok, true);
  const again = await act('new-meeting', { date: FUTURE });
  assert.equal(again.existing, true);
  await new Promise((r) => setTimeout(r, 3)); // (two saves in one millisecond share a time, so the next wouldn't look stale)
  const saved = await act('save-meeting', { meeting: { ...made.meeting, title: 'Winter meeting' }, base: made.meeting.updatedAt });
  assert.equal(saved.meeting.title, 'Winter meeting');
  const stale = await act('save-meeting', { meeting: { ...made.meeting, title: 'Older' }, base: made.meeting.updatedAt });
  assert.equal(stale.status, 409);
  assert.equal(stale.current.title, 'Winter meeting');
  const shared = await act('share-meeting', { id: made.meeting.id, shared: true });
  assert.equal(shared.meeting.shared, true);
  const view = await act('meeting-view', { id: made.meeting.id });
  assert.equal(view.meetings[0].title, 'Winter meeting');
  assert.deepEqual(view.numbers, {});
  assert.equal((await act('nothing-like-this')).status, 400);
  assert.equal((await act('delete-meeting', { id: made.meeting.id })).ok, true);
});

test('anyone who doesn’t run it is refused, the committee and advisors included', async () => {
  for (const data of [
    { boardMember: { slug: 'tom-committee', name: 'Tom', committees: ['Advisory Board'], email: 'tom@example.com' }, userEmail: 'tom@example.com' },
    { advisor: { slug: 'ada-advisor', name: 'Ada', email: 'ada@example.com' }, userEmail: 'ada@example.com' },
  ]) {
    const w = await whoIs(ctx(data));
    assert.equal(w.runs, false);
    const res = await meetingAction(ctx(data), { action: 'new-meeting', body: { date: FUTURE }, by: 'x', w });
    assert.equal(res.status, 403);
  }
  assert.equal((await meetingAction(ctx({}), { action: 'new-meeting', body: { date: FUTURE }, by: 'x', w: null })).status, 403);
});

test('a board member with nothing to do with the group isn’t anyone here', async () => {
  assert.equal(await whoIs(ctx({ boardMember: { slug: 'bo-kim', name: 'Bo', committees: [], email: 'bo@example.com' }, userEmail: 'bo@example.com' })), null);
});

test('files: private, under board/, on an item; the board’s file route never opens one, and advisors only once shared', async () => {
  const { meeting: m } = await createAdvisoryMeeting(env, { date: FUTURE }, { now: NOW });
  const item = m.sections[0].items[0];
  const form = new FormData();
  form.set('meetingId', m.id);
  form.set('itemId', item.id);
  form.set('file', new File([new TextEncoder().encode('%PDF-1.4 a small file')], 'Update.pdf', { type: 'application/pdf' }));
  const res = await meetingAction(ctx({}), { action: 'upload', form, by: 'mary', w: await lead() });
  const up = await res.json();
  assert.equal(up.ok, true, up.error);
  const row = await env.DB.prepare('SELECT * FROM board_files WHERE id = ?').bind(up.file.id).first();
  assert.equal(row.owner_type, 'advisory-meeting');
  assert.ok(row.r2_key.startsWith('board/advisory-meeting/'));
  assert.deepEqual(up.meeting.sections[0].items[0].docs, [up.file.id]);

  const member = { slug: 'bo-kim', name: 'Bo', email: 'bo@example.com' };
  assert.equal(await fileFor(env.DB, up.file.id, { member }), null, 'a board member can’t open it through the board’s route');
  const ada = { kind: 'advisor', slug: 'ada-advisor', runs: false, answers: true };
  assert.equal(await advisoryFileFor(env.DB, up.file.id, ada), null, 'not until it’s shared');
  assert.ok(await advisoryFileFor(env.DB, up.file.id, await lead()), 'whoever runs it can');
  await act('share-meeting', { id: m.id, shared: true });
  assert.ok(await advisoryFileFor(env.DB, up.file.id, ada));

  // A board file through the advisors' route: the same nothing as a file that doesn't exist
  await env.DB.prepare("INSERT INTO board_meetings (id, date, data, updated_at) VALUES ('m_board', '2027-01-14', '{}', 'x')").run();
  const boardForm = new File([new TextEncoder().encode('%PDF-1.4 board')], 'Board.pdf', { type: 'application/pdf' });
  const put = await putFile(env, { ownerType: 'meeting', ownerId: 'm_board', file: boardForm, by: 'x' });
  assert.equal(await advisoryFileFor(env.DB, put.id, ada), null);
  assert.equal(await advisoryFileFor(env.DB, put.id, await lead()), null);

  // …and the file actions touch only the advisors' files
  assert.equal((await act('delete-meeting-file', { fileId: put.id })).status, 404);
  assert.ok(await env.DB.prepare('SELECT id FROM board_files WHERE id = ?').bind(put.id).first());
  const del = await act('delete-meeting-file', { fileId: up.file.id });
  assert.deepEqual(del.meeting.sections[0].items[0].docs, []);
});

test('admin list: the name, and each answer by name; the advisors’ page never gets this', async () => {
  const { meeting: m } = await createAdvisoryMeeting(env, { date: FUTURE }, { now: NOW });
  await sendAdvisoryInvite(env, m.id, { fetchImpl: g.fetchImpl, now: NOW });
  const [a] = await adminMeetings(env);
  assert.equal(a.name, 'Q1 2027 Advisory Board Meeting');
  assert.ok(a.replies.some((r) => r.name === 'Ada Advisor' && r.answer === 'invited'));
  assert.equal(a.canInvite, true);
});

test('with the emails switch off, Send invite is refused and nothing goes out on its own', async () => {
  const made = await act('new-meeting', { date: FUTURE });
  await saveSettings(env.DB, { emails: false });
  const r = await act('send-invite', { id: made.meeting.id });
  assert.equal(r.status, 409);
  assert.match(r.error, /Turn on emails/);
  assert.equal(g.events ? Object.keys(g.events).length : 0, 0, 'nothing reached Google');
});
