// The invites ahead follow People → Board (functions/api/_board-invite.js maybeFollowBoard): a new member goes on every
// one, someone who left comes off, and nothing else on an invite is ever touched.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createD1 } from './lib/d1-shim.mjs';
import { saveMeeting, getMeeting, patchMeeting, listMeetings, ensureSchema } from '../functions/api/_board.js';
import { writeState } from '../functions/api/_board-roles.js';
import { maybeFollowBoard, followOf, followRoll, sendInvite } from '../functions/api/_board-invite.js';
import { clearTokenCache } from '../functions/api/_google-calendar.js';
import { cleanMeeting } from '../public/admin/board-shared.js';

const { privateKey: PEM } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const KEY = JSON.stringify({ type: 'service_account', client_email: 'site@example.iam.gserviceaccount.com', private_key: PEM, token_uri: 'https://oauth2.googleapis.com/token' });
const HOLLY = 'holly@soardcharity.com';
const PETER = 'peter@soardcharity.com';
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

let env;
let events; // eventId → the event as Google has it
let calls; // what reached Google: { method, url, body }
let refuse; // Google answers every event with an error
let told; // alert emails to the staff
const realFetch = globalThis.fetch;
const fetchImpl = async (input, init = {}) => {
  const url = String(input.url || input);
  if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'g-test', expires_in: 3600 });
  const body = init.body ? JSON.parse(init.body) : null;
  const method = init.method || 'GET';
  calls.push({ method, url, body });
  if (refuse) return Response.json({ error: { message: 'Backend Error' } }, { status: 503 });
  const id = decodeURIComponent(new URL(url).pathname.split('/').pop());
  if (!events[id]) return Response.json({ error: { message: 'Not Found' } }, { status: 404 });
  if (method === 'PATCH') Object.assign(events[id], body);
  return Response.json(events[id]);
};
const writes = () => calls.filter((c) => c.method !== 'GET');
const run = (minutes = 0) => maybeFollowBoard(env, { fetchImpl, now: Date.now() + minutes * 60 * 1000 });

async function person(slug, email, { name = slug, status = 'active', group = 'board' } = {}) {
  await env.DB.prepare('INSERT OR REPLACE INTO team (slug, name, "group", data) VALUES (?, ?, ?, ?)').bind(slug, name, group, JSON.stringify({ name, group, status, title: 'Board Member', organization: 'Acme' })).run();
  if (email) await env.DB.prepare('INSERT OR REPLACE INTO reveal_board_emails (slug, email) VALUES (?, ?)').bind(slug, email).run();
  else await env.DB.prepare('DELETE FROM reveal_board_emails WHERE slug = ?').bind(slug).run();
}
const leaves = (slug) => person(slug, null, { status: 'alumni' });

/** A meeting ahead whose invite is out to these guests (who: what Board knows it put on) */
async function invited(days, emails, { who, attendance = [], ...more } = {}) {
  const eventId = `ev${days}`;
  events[eventId] = { id: eventId, status: 'confirmed', summary: 'SOARD Board Meeting', description: 'Notes as Google keeps them', location: 'Example Hall', attendees: emails.map((email) => ({ email, responseStatus: 'accepted' })) };
  const m = await saveMeeting(env.DB, cleanMeeting({ date: day(days), start: '08:00', end: '10:00', attendance, sections: [{ title: 'Call to order', items: [{ title: 'Roll call' }] }], ...more }), { by: 'test' });
  // The invite is the server's: a save never writes it
  return patchMeeting(env.DB, m.id, (cur) => ({ ...cur, invite: { eventId, organizer: HOLLY, sentAt: '2026-11-05T00:00:00Z', emails, guests: emails.length, replies: {}, ...(who ? { who } : {}) } }), { by: 'test' });
}

afterEach(() => { globalThis.fetch = realFetch; });

beforeEach(async () => {
  clearTokenCache();
  events = {};
  calls = [];
  refuse = false;
  told = [];
  globalThis.fetch = async (input, init = {}) => {
    if (String(input.url || input).startsWith('https://api.resend.com/')) { const b = JSON.parse(init.body); for (const e of [].concat(b)) told.push(e.subject); return Response.json(Array.isArray(b) ? { data: b.map((_, i) => ({ id: `e${i}` })) } : { id: 'e' }); }
    throw new Error(`unexpected fetch ${input}`);
  };
  env = { DB: await createD1(), GOOGLE_CALENDAR_KEY: KEY, RESEND_API_KEY: 're_test', ALERT_EMAILS: 'alerts@example.com' };
  await env.DB.exec('CREATE TABLE team (slug TEXT PRIMARY KEY, name TEXT, "group" TEXT, order_num INTEGER, data TEXT NOT NULL, updated_at TEXT)');
  await env.DB.exec('CREATE TABLE reveal_board_emails (slug TEXT PRIMARY KEY, email TEXT NOT NULL, updated_at TEXT)');
  await env.DB.exec('CREATE TABLE site_config (key TEXT PRIMARY KEY, data TEXT, updated_at TEXT)');
  await ensureSchema(env.DB);
  await person('alex', 'alex@example.com');
  await person('sam', 'sam@example.org');
  await person('kim', 'kim@example.net');
});

test('who an invite needs: only who Board put on ever comes off, and someone taken off by hand isn’t put back', () => {
  const board = [{ slug: 'alex', email: 'alex@example.com' }, { slug: 'new', email: 'new@example.com' }];
  const invite = { organizer: HOLLY, emails: ['alex@example.com', 'gone@example.com', 'speaker@example.com'], who: { alex: 'alex@example.com', gone: 'gone@example.com' } };
  assert.deepEqual(followOf(invite, board), { add: ['new@example.com'], drop: ['gone@example.com'] });
  assert.deepEqual(followOf({ ...invite, emails: ['speaker@example.com', 'new@example.com'] }, board), { add: [], drop: [] }, 'Alex was taken off in Google: left off');
  assert.deepEqual(followOf({ organizer: HOLLY, emails: ['old@example.com'], who: { alex: 'old@example.com' } }, board.slice(0, 1)), { add: ['alex@example.com'], drop: ['old@example.com'] }, 'a new address replaces the old one');
  assert.deepEqual(followOf({ organizer: 'alex@example.com', emails: [] }, board.slice(0, 1)).add, [], 'never the organizer');
});

test('the first look writes down who’s on an invite and asks Google nothing', async () => {
  const m = await invited(30, ['alex@example.com', 'sam@example.org', 'kim@example.net', PETER]);
  assert.ok((await run()).added === 0);
  assert.deepEqual(calls, []);
  assert.deepEqual((await getMeeting(env.DB, m.id)).invite.who, { alex: 'alex@example.com', sam: 'sam@example.org', kim: 'kim@example.net' });
  assert.deepEqual(await run(6), { added: 0, removed: 0, held: 0, failed: 0 });
  assert.deepEqual(calls, [], 'nothing to do, nothing asked');
});

test('a new board member goes on every invite ahead, and the guest list is all that changes', async () => {
  const emails = ['alex@example.com', 'sam@example.org', 'kim@example.net', PETER];
  const who = { alex: emails[0], sam: emails[1], kim: emails[2] };
  const a = await invited(30, emails, { who });
  const b = await invited(120, emails, { who });
  await person('ryan', 'Ryan.Williams@Example.com', { name: 'Ryan Williams' });
  const did = await run();
  assert.deepEqual([did.added, did.removed], [2, 0]);
  const patches = writes();
  assert.equal(patches.length, 2);
  for (const c of patches) {
    assert.ok(c.url.endsWith('?sendUpdates=all'), 'Google tells them');
    assert.deepEqual(Object.keys(c.body), ['attendees'], 'nothing but the guest list: no name, notes, time or place, which would email the whole board');
    assert.deepEqual(c.body.attendees.map((x) => x.email), [...emails, 'ryan.williams@example.com']);
    assert.ok(c.body.attendees.slice(0, 4).every((x) => x.responseStatus === 'accepted'), 'everyone’s answer stays');
  }
  const next = await getMeeting(env.DB, a.id);
  assert.equal(next.invite.who.ryan, 'ryan.williams@example.com');
  assert.equal(next.invite.replies.ryan, 'invited');
  assert.equal(next.invite.guests, 5);
  assert.ok((await getMeeting(env.DB, b.id)).invite.emails.includes('ryan.williams@example.com'));
  calls = [];
  await run(6);
  assert.deepEqual(writes(), [], 'once');
});

test('someone who leaves comes off, a guest added by hand stays, and a new address replaces the old one', async () => {
  await person('lee', 'lee@example.com');
  const emails = ['alex@example.com', 'sam@example.org', 'kim@example.net', 'lee@example.com', 'speaker@example.com', PETER];
  const who = { alex: emails[0], sam: emails[1], kim: emails[2], lee: emails[3] };
  const m = await invited(30, emails, { who });
  await patchMeeting(env.DB, m.id, (cur) => ({ ...cur, invite: { ...cur.invite, replies: { lee: 'accepted', alex: 'accepted' } } }), { by: 'test' });
  await leaves('lee');
  await person('sam', 'sam.new@example.org');
  const did = await run();
  assert.deepEqual([did.added, did.removed], [1, 2]);
  assert.deepEqual(writes()[0].body.attendees.map((x) => x.email), ['alex@example.com', 'kim@example.net', 'speaker@example.com', PETER, 'sam.new@example.org']);
  const next = await getMeeting(env.DB, m.id);
  assert.deepEqual(next.invite.who, { alex: 'alex@example.com', sam: 'sam.new@example.org', kim: 'kim@example.net' });
  assert.equal(next.invite.replies.lee, undefined);
  assert.equal(next.invite.replies.alex, 'accepted', 'everyone else’s answer stays');
});

test('a bad read never empties an invite: an empty list, or over half of its board at once, changes nothing and says so', async () => {
  const emails = ['alex@example.com', 'sam@example.org', 'kim@example.net'];
  const who = { alex: emails[0], sam: emails[1], kim: emails[2] };
  const m = await invited(30, emails, { who });
  await leaves('alex');
  await leaves('sam');
  const held = await run();
  assert.equal(held.held, 1);
  assert.deepEqual(writes(), []);
  assert.deepEqual((await getMeeting(env.DB, m.id)).invite.who, who);
  await leaves('kim');
  assert.equal(await run(6), null, 'nobody on the board reads as a bad read');
  assert.deepEqual(writes(), []);
});

test('an invite deleted in Google isn’t brought back, past and started meetings are left alone, and a failure doesn’t stop the rest', async () => {
  const emails = ['alex@example.com', 'sam@example.org', 'kim@example.net'];
  const who = { alex: emails[0], sam: emails[1], kim: emails[2] };
  const deleted = await invited(30, emails, { who });
  events[deleted.invite.eventId].status = 'cancelled';
  const gone = await invited(40, emails, { who });
  delete events[gone.invite.eventId];
  await invited(-10, emails, { who });
  await invited(1, emails, { who, live: { startedAt: new Date().toISOString() } });
  const fine = await invited(50, emails, { who });
  await person('ryan', 'ryan@example.com');
  const did = await run();
  assert.equal(did.added, 1);
  assert.deepEqual(writes().map((c) => decodeURIComponent(new URL(c.url).pathname.split('/').pop())), [fine.invite.eventId]);
  assert.equal(events[deleted.invite.eventId].status, 'cancelled');
});

test('every five minutes at most, and it runs without a calendar for the attendance lists', async () => {
  const m = await saveMeeting(env.DB, cleanMeeting({ date: day(30), attendance: [{ slug: 'alex', name: 'Alex', kind: 'board' }] }), { by: 'test' });
  await run();
  await person('ryan', 'ryan@example.com', { name: 'Ryan Williams' });
  assert.equal(await run(1), null);
  assert.equal((await getMeeting(env.DB, m.id)).attendance.some((a) => a.slug === 'ryan'), false);
  await run(6);
  assert.equal((await getMeeting(env.DB, m.id)).attendance.some((a) => a.slug === 'ryan'), true);
});

test('the attendance list follows: a new member on it, one who left off it, staff and anyone marked kept, in order', async () => {
  const board = [{ slug: 'alex', name: 'Alex' }, { slug: 'ryan', name: 'Ryan', organization: 'Acme' }];
  const list = [{ slug: 'alex', name: 'Alex', kind: 'board' }, { slug: 'gone', name: 'Gone', kind: 'board' }, { slug: 'peter', name: 'Peter', kind: 'staff' }];
  assert.deepEqual(followRoll(list, board).map((a) => a.slug), ['alex', 'ryan', 'peter']);
  assert.equal(followRoll(list, board)[1].org, 'Acme');
  assert.equal(followRoll(list, board)[1].kind, 'board');
  assert.equal(followRoll([list[0], list[2], { slug: 'ryan', name: 'Ryan', kind: 'board' }], board), null, 'nothing to change');
  assert.deepEqual(followRoll([{ ...list[1], status: 'present' }, list[0]], board.slice(0, 1)), null, 'someone already marked stays');
  // A board member with no email is still on the board, so still on the list
  await person('noemail', null, { name: 'No Email' });
  const m = await saveMeeting(env.DB, cleanMeeting({ date: day(30), attendance: [] }), { by: 'test' });
  await run();
  assert.ok((await getMeeting(env.DB, m.id)).attendance.some((a) => a.slug === 'noemail'));
});

test('sending the invite records who Board put on it', async () => {
  const m = await saveMeeting(env.DB, cleanMeeting({ date: day(30), start: '08:00', end: '10:00', sections: [] }), { by: 'test' });
  await writeState(env.DB, 'settings', { admins: [HOLLY, PETER], invitesFrom: HOLLY });
  const google = async (input, init = {}) => {
    const url = String(input.url || input);
    if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'g', expires_in: 3600 });
    if ((init.method || 'GET') === 'GET') return Response.json({ error: { message: 'nope' } }, { status: 404 });
    const b = JSON.parse(init.body);
    return Response.json({ ...b, id: b.id, hangoutLink: 'https://meet.google.com/abc-defg-hij' });
  };
  const sent = await sendInvite(env, m.id, { fetchImpl: google });
  assert.deepEqual(sent.invite.who, { alex: 'alex@example.com', sam: 'sam@example.org', kim: 'kim@example.net' });
  assert.ok(sent.invite.emails.includes(PETER), 'Peter’s on it, as an admin');
  assert.equal(sent.invite.who.peter, undefined, 'and never taken off by the board list');
  assert.equal((await listMeetings(env.DB)).length, 1);
});

test('a person hears when invites can’t follow: at once for a bad list, a day on for Google, once each, and it clears', async () => {
  const emails = ['alex@example.com', 'sam@example.org', 'kim@example.net'];
  const who = { alex: emails[0], sam: emails[1], kim: emails[2] };
  await invited(30, emails, { who });
  // Over half would come off: said at once, and only once however long it stays that way
  await leaves('alex');
  await leaves('sam');
  await run();
  assert.equal(told.length, 1);
  assert.match(told[0], /didn’t follow the board list/);
  await run(6);
  await run(12);
  assert.equal(told.length, 1, 'once');
  // Fixed: quiet again, and a new problem can be said
  await person('alex', 'alex@example.com');
  await person('sam', 'sam@example.org');
  await run(18);
  assert.equal(told.length, 1);
  // Google refusing: nothing for a day, in case it passes
  await person('ryan', 'ryan@example.com');
  refuse = true;
  await run(24);
  await run(60);
  assert.equal(told.length, 1, 'not yet');
  await run(24 + 24 * 60 + 1);
  assert.equal(told.length, 2);
  assert.match(told[1], /can’t follow the board list/);
  await run(24 + 24 * 60 + 7);
  assert.equal(told.length, 2, 'once');
  // Nobody on the board at all reads as a bad read, and says so
  refuse = false;
  await leaves('alex'); await leaves('sam'); await leaves('kim'); await leaves('ryan');
  await run(24 + 24 * 60 + 13);
  await run(24 + 24 * 60 + 19);
  assert.equal(told.length, 3);
  assert.match(told[2], /reads empty/);
});
