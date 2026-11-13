/**
 * A donor's timeline (functions/api/_donor-timeline.js): what each outside source turns into, who is never searched,
 * and that only the donor's own conversations, calls and emails open. Names, addresses and numbers are made up.
 * Run: node --test tests/donor-timeline.test.mjs
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createD1 } from './lib/d1-shim.mjs';
import * as D from '../functions/api/_donors.js';
import * as T from '../functions/api/_donor-timeline.js';
import { clearTokenCache } from '../functions/api/_google-calendar.js';
import { ensureEmailLog } from '../functions/api/_email-log.js';
import { ensureHistory } from '../functions/api/_content-history.js';
import { onRequestGet } from '../functions/api/donors-admin.js';

const DAY = 864e5;
const NOW = Date.now();
const S = (ms) => Math.floor(ms / 1000);
const { privateKey: SA_PEM } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const SERVICE_ACCOUNT = JSON.stringify({ type: 'service_account', client_email: 'site@example.iam.gserviceaccount.com', client_id: '1', private_key: SA_PEM });
const ACCOUNTS = [
  { email: 'robin@soardcharity.com', aliases: ['info@soardcharity.com'], name: 'Robin Sample', active: true },
  { email: 'pat@soardcharity.com', aliases: [], name: 'Pat Lee', active: true },
];
const team = T.teamOf(ACCOUNTS);
const H = (name, value) => ({ name, value });
const msg = (id, thread, at, headers, { labels = ['INBOX'], snippet = 'Hello there' } = {}) => ({ id, threadId: thread, internalDate: String(at), snippet, labelIds: labels, payload: { headers } });

// ─── The pieces ─────────────────────────────────────────────────────

test('phone numbers and website domains as Quo and Gmail need them', () => {
  assert.equal(T.e164('(404) 555-0123'), '+14045550123');
  assert.equal(T.e164('1-404-555-0123'), '+14045550123');
  assert.equal(T.e164('+44 20 7946 0958'), '+442079460958');
  assert.equal(T.e164('555-0123'), null, 'seven digits is no number to search');
  assert.equal(T.e164('770-555-0199 x123'), '+17705550199', 'an extension is dialled after');
  assert.equal(T.e164('(770) 555-0199 ext. 4'), '+17705550199');
  assert.equal(T.siteDomain('https://www.acme-builders.com/about'), 'acme-builders.com');
  assert.equal(T.siteDomain('acme.org'), 'acme.org');
  assert.equal(T.siteDomain('not a site'), '');
  assert.deepEqual(T.addressesIn('"Doe, Jane" <Jane@Example.com>, pat@soardcharity.com'), ['jane@example.com', 'pat@soardcharity.com']);
  assert.equal(T.nameIn('"Jane Doe" <jane@example.com>'), 'Jane Doe');
  assert.equal(T.nameIn('jane@example.com'), 'jane@example.com');
  assert.deepEqual(T.addressesIn('"jane@example.com via Forms" <noreply@forms.example>'), ['noreply@forms.example'], 'never an address in the display name');
  assert.deepEqual(T.addressesIn('jane@example.com via Forms <noreply@forms.example>, "Lee, Pat" <pat@x.org>, bare@y.org'), ['noreply@forms.example', 'pat@x.org', 'bare@y.org']);
  assert.deepEqual(T.addressesIn('"Jane <jane@x.com>" <noreply@forms.example>'), ['noreply@forms.example'], 'brackets inside a quoted name are the name');
  assert.deepEqual(T.addressesIn('Jane <jane@x.com>; Pat <pat@y.com>'), ['jane@x.com', 'pat@y.com'], 'a list split by semicolons');
  assert.deepEqual(T.addressesIn('"Jane \\"JD\\" Doe" <jd@x.com>, pat@soardcharity.com'), ['jd@x.com', 'pat@soardcharity.com'], 'escaped quotes in a name');
});

test('the team is never searched: their addresses and aliases, SOARD’s domains, and a donor with a teammate’s name', () => {
  const s = T.searchable({ emails: ['jane@acme.com', 'INFO@soardcharity.com', 'robin@soardcharity.com', 'x@soardcharity.com'], domains: ['gmail.com', 'acme.com', 'soardcharity.com'] }, team);
  assert.deepEqual(s.emails, ['jane@acme.com']);
  assert.deepEqual(s.skipped.map((x) => x.address), ['info@soardcharity.com', 'robin@soardcharity.com', 'x@soardcharity.com']);
  assert.deepEqual(s.domains, ['acme.com'], 'a freemail domain is never a domain to search, nor SOARD’s own');
  assert.equal(T.searchable({ name: 'Robin Sample', emails: ['robin.home@example.com'] }, team).team, true, 'a staff member who gives from home');
  assert.equal(T.searchable({ name: 'Robin', emails: ['h@example.com'] }, team).team, false, 'a first name alone isn’t a teammate');
});

test('an organization: a teammate among its givers is never searched; its website’s domain only when its people write from it', () => {
  const org = { name: 'Acme Builders', emails: ['lee@acme.com', 'robin.home@example.net', 'pat.lee@gmail.com'], domains: ['acme.com'], contacts: ['ct_lee', 'ct_robin'],
    people: [{ name: 'Lee Sample', emails: ['lee@acme.com'], contacts: ['ct_lee'] }, { name: 'Robin Sample', emails: ['robin.home@example.net'], contacts: ['ct_robin'] }] };
  const s = T.searchable(org, team);
  assert.deepEqual(s.emails, ['lee@acme.com', 'pat.lee@gmail.com']);
  assert.deepEqual(s.contacts, ['ct_lee'], 'nor her phone');
  assert.ok(s.skipped.some((x) => x.address === 'robin.home@example.net'));
  assert.deepEqual(s.domains, ['acme.com'], 'Lee writes from acme.com');
  assert.deepEqual(T.searchable({ ...org, domains: ['facebook.com'] }, team).domains, [], 'a social page is never a domain');
  assert.deepEqual(T.searchable({ ...org, emails: ['pat.lee@gmail.com'], domains: ['homedepot.com'] }, team).domains, [], 'no one of theirs writes from it');
  const isTheirs = T.matcher({ emails: ['lee@acme.com'], domains: ['acme.com'], dropped: ['robin@acme.com'] }, team);
  assert.equal(isTheirs('sam@acme.com'), true);
  assert.equal(isTheirs('noreply@orders.acme.com'), false, 'its subdomains are its systems');
  assert.equal(isTheirs('robin@acme.com'), false, 'a teammate who gives for it from work is never theirs, even at its domain');
  assert.equal(T.matcher({ emails: [], domains: ['acme.com'] }, T.teamOf([{ email: 'kim@acme.com', name: 'Kim Staff', aliases: [], active: true }]))('kim@acme.com'), false, 'a staff account at the domain');
  const look = { mailbox: 'robin@soardcharity.com', isTheirs, team, exact: new Set(['lee@acme.com']) };
  assert.equal(T.mailLine(msg('c1', 't7', 1, [H('From', 'Acme <no-reply@acme.com>'), H('To', 'robin@soardcharity.com'), H('Subject', 'Your order')]), look), null, 'a no-reply at their domain is a system');
  assert.equal(T.mailLine(msg('c2', 't8', 1, [H('From', 'Sam <sam@acme.com>'), H('To', 'robin@soardcharity.com'), H('Subject', 'Hello')]), look)?.dir, 'in', 'a person at their domain is theirs');
  assert.equal(T.mailLine(msg('c3', 't9', 1, [H('From', 'Acme Billing <billing@acme.com>'), H('To', 'robin@soardcharity.com'), H('Subject', 'Sponsorship invoice')]), look)?.dir, 'in', 'billing@ writing about the sponsorship is a conversation');
});

test('Gmail’s search words find any message from, to or copied to the donor', () => {
  assert.equal(T.mailQuery({ emails: ['jane@example.com'], domains: ['acme.com'] }), '{from:jane@example.com to:jane@example.com cc:jane@example.com bcc:jane@example.com from:acme.com to:acme.com cc:acme.com} -in:chats -from:noreply -from:no-reply -from:donotreply -from:mailer-daemon', 'and never a no-reply sender’s mail');
  assert.equal(T.mailQuery({ emails: [], domains: [] }), '');
});

test('Gmail’s batch answer is read part by part; a part that failed is a gap, not a failure', () => {
  const b = 'batch_xyz';
  const text = [`--${b}`, 'Content-Type: application/http', 'Content-ID: <response-i1>', '', 'HTTP/1.1 200 OK', 'Content-Type: application/json', '', '{"id":"t2","messages":[]}', `--${b}`,
    'Content-Type: application/http', 'Content-ID: <response-i0>', '', 'HTTP/1.1 429 Too Many Requests', '', '{"error":{}}', `--${b}--`].join('\r\n');
  assert.deepEqual(T.parseBatch(text, b, 2), [null, { id: 't2', messages: [] }]);
});

test('an email becomes a line: who wrote to whom; the donor’s newsletters, mass mailings, auto-replies and drafts don’t', () => {
  const isTheirs = T.matcher({ emails: ['jane@example.com'], domains: [] });
  const look = { mailbox: 'robin@soardcharity.com', isTheirs, team };
  const inn = T.mailLine(msg('a1', 't1', 1000, [H('From', 'Jane Doe <jane@example.com>'), H('To', 'robin@soardcharity.com'), H('Subject', 'Our gift'), H('Message-ID', '<A@x>')]), look);
  assert.equal(inn.dir, 'in');
  assert.deepEqual(inn.staff, ['robin@soardcharity.com']);
  assert.equal(inn.id, 'mail:<a@x>');
  const out = T.mailLine(msg('a2', 't1', 2000, [H('From', 'Pat Lee <pat@soardcharity.com>'), H('To', 'jane@example.com'), H('Subject', 'Re: Our gift')]), look);
  assert.equal(out.dir, 'out');
  assert.deepEqual(out.staff, ['pat@soardcharity.com']);
  const alias = T.mailLine(msg('a3', 't1', 2000, [H('From', 'info@soardcharity.com'), H('To', 'jane@example.com')]), look);
  assert.deepEqual(alias.staff, ['robin@soardcharity.com'], 'an alias is the account it belongs to');
  const cc = T.mailLine(msg('a4', 't2', 3000, [H('From', 'Designer <d@studio.example>'), H('To', 'jane@example.com'), H('Cc', 'robin@soardcharity.com')]), look);
  assert.equal(cc.dir, 'cc');
  assert.equal(T.mailLine(msg('a5', 't3', 1, [H('From', 'jane@example.com'), H('To', 'robin@soardcharity.com'), H('List-Unsubscribe', '<mailto:x>')]), look), null, 'their newsletter');
  assert.equal(T.mailLine(msg('a6', 't3', 1, [H('From', 'jane@example.com'), H('To', Array.from({ length: 11 }, (_, i) => `p${i}@example.org`).join(', '))]), look), null, 'their mass mailing');
  assert.equal(T.mailLine(msg('a7', 't3', 1, [H('From', 'jane@example.com'), H('To', 'robin@soardcharity.com'), H('Auto-Submitted', 'auto-replied')]), look), null, 'an out-of-office');
  assert.equal(T.mailLine(msg('a8', 't3', 1, [H('From', 'robin@soardcharity.com'), H('To', 'jane@example.com')], { labels: ['DRAFT'] }), look), null, 'a draft never went');
  assert.equal(T.mailLine(msg('a9', 't3', 1, [H('From', 'robin@soardcharity.com'), H('To', 'someone@else.example')]), look), null, 'not about the donor');
  const bcc = T.mailLine(msg('b1', 't4', 1, [H('From', 'robin@soardcharity.com'), H('To', 'robin@soardcharity.com'), H('Bcc', 'jane@example.com'), H('Subject', 'Thank you all')]), look);
  assert.equal(bcc?.dir, 'out', 'blind-copied to them: theirs');
  assert.equal(T.mailLine(msg('b2', 't5', 1, [H('From', '"jane@example.com via Forms" <noreply@forms.example>'), H('To', 'robin@soardcharity.com')]), look), null, 'a form that names them isn’t from them');
  assert.equal(T.mailLine(msg('b3', 't6', 1, [H('From', 'Vendor <news@vendor.example>'), H('To', 'jane@example.com'), H('Cc', 'robin@soardcharity.com'), H('List-Unsubscribe', '<mailto:u>')]), look), null, 'someone else’s list mail to both');
});

test('the same email in two mailboxes is one line, opened from the sender’s copy', () => {
  const a = { id: 'mail:<m@x>', dir: 'out', staff: ['pat@soardcharity.com'], mailbox: 'robin@soardcharity.com', copies: { 'robin@soardcharity.com': 'th' }, thread: 'th', gmailId: 'gh' };
  const b = { ...a, mailbox: 'pat@soardcharity.com', copies: { 'pat@soardcharity.com': 'tp' }, thread: 'tp', gmailId: 'gp' };
  const [one, ...rest] = T.oneEach([a, b]);
  assert.equal(rest.length, 0);
  assert.equal(one.mailbox, 'pat@soardcharity.com');
  assert.equal(one.thread, 'tp');
  assert.deepEqual(one.mailboxes.sort(), ['pat@soardcharity.com', 'robin@soardcharity.com']);
  assert.deepEqual(one.copies, { 'robin@soardcharity.com': 'th', 'pat@soardcharity.com': 'tp' }, 'each mailbox’s own conversation, for its own Open in Gmail');
});

test('a calendar event the donor is a guest on is a meeting; a big invite says so; a cancelled one isn’t', () => {
  const isTheirs = T.matcher({ emails: ['jane@example.com'], domains: [] });
  const ev = { id: 'e1', iCalUID: 'u1', status: 'confirmed', summary: 'Coffee', start: { dateTime: '2026-10-01T14:00:00Z' }, organizer: { email: 'pat@soardcharity.com' },
    attendees: [{ email: 'pat@soardcharity.com' }, { email: 'Jane@example.com', responseStatus: 'accepted' }] };
  const m = T.meetingLine(ev, { mailbox: 'pat@soardcharity.com', isTheirs, team });
  assert.equal(m.title, 'Coffee');
  assert.equal(m.answer, 'yes');
  assert.deepEqual(m.staff, ['pat@soardcharity.com']);
  assert.equal(m.big, false);
  const big = T.meetingLine({ ...ev, attendees: [...ev.attendees, ...Array.from({ length: 20 }, (_, i) => ({ email: `g${i}@example.org` }))] }, { mailbox: 'pat@soardcharity.com', isTheirs, team });
  assert.equal(big.big, true);
  assert.equal(T.meetingLine({ ...ev, status: 'cancelled' }, { mailbox: 'x', isTheirs, team }), null);
  assert.equal(T.meetingLine({ ...ev, attendees: [{ email: 'pat@soardcharity.com' }] }, { mailbox: 'x', isTheirs, team }), null, 'only their name in the notes is no meeting');
});

test('a Kit broadcast went to them when it went to everyone, or to a tag they had then; a segment isn’t guessed', () => {
  const tags = new Map([[7, { name: 'Donors', at: 1000 }]]);
  assert.equal(T.sentTo({ at: 500, filter: [] }, { tags }), true, 'no filter: the whole list');
  assert.equal(T.sentTo({ at: 500, filter: [{ all: [{ type: 'all_subscribers' }] }] }, { tags }), true);
  assert.equal(T.sentTo({ at: 2000, filter: [{ any: [{ type: 'tag', ids: [7] }] }] }, { tags }), true);
  assert.equal(T.sentTo({ at: 500, filter: [{ any: [{ type: 'tag', ids: [7] }] }] }, { tags }), false, 'sent before they had the tag');
  assert.equal(T.sentTo({ at: 2000, filter: [{ none: [{ type: 'tag', ids: [7] }] }] }, { tags }), false);
  assert.equal(T.sentTo({ at: 2000, filter: [{ all: [{ type: 'segment', ids: [3] }] }] }, { tags }), false);
  // As Kit sends them: every part there, the unused ones null (the site's own leave-out filter is one)
  assert.equal(T.sentTo({ at: 500, filter: [{ all: [{ type: 'all_subscribers' }], any: null, none: null }] }, { tags }), true, 'null parts say nothing');
  assert.equal(T.sentTo({ at: 500, filter: [{ all: null, any: null, none: [{ type: 'tag', ids: [99] }] }] }, { tags }), true, 'the leave-out filter: everyone without the tag');
  assert.equal(T.sentTo({ at: 2000, filter: [{ all: null, any: null, none: [{ type: 'tag', ids: [7] }] }] }, { tags }), false, 'left out by a tag they had');
  assert.equal(T.sentTo({ at: 500, filter: [{ all: [], any: [], none: [] }] }, { tags }), true);
  const kids = new Map([['ava-sample', 'Ava']]);
  assert.equal(T.tagWords('Reveal sign-ups', kids), 'Signed up to watch every reveal');
  assert.equal(T.tagWords('Reveal sign-ups: ava-sample', kids), 'Signed up to watch Ava’s reveal');
  assert.equal(T.tagWords('Gala 2026', kids), 'Tagged “Gala 2026” in Kit');
});

test('the team’s changes: a note is on the timeline as itself; a thank-you is a gift line', () => {
  assert.equal(T.teamLine({ id: 1, user_email: 'pat@soardcharity.com', entity_name: 'Note added', changes: '{"key":"c:1","note":"n1"}', created_at: '2026-10-01 12:00:00' }), null);
  assert.equal(T.teamLine({ id: 4, user_email: 'pat@soardcharity.com', entity_name: 'Note deleted', changes: '{"key":"c:1","note":"n1"}', created_at: '2026-10-01 12:00:00' })?.title, 'Note deleted', 'a deleted note leaves who and when');
  const t = T.teamLine({ id: 2, user_email: 'pat@soardcharity.com', entity_name: 'Thanked: $5,000 from Jane Doe', changes: '{"gift":"g1","state":"thanked"}', created_at: '2026-10-01 12:00:00' });
  assert.equal(t.kind, 'thanks');
  assert.equal(t.at, Date.parse('2026-10-01T12:00:00Z'));
  const z = T.teamLine({ id: 3, user_email: 'Zeffy merge', entity_name: 'What was known…', changes: null, created_at: '2026-10-01 12:00:00' });
  assert.equal(z.by, null);
  assert.equal(z.byName, 'Zeffy merge');
});

test('a partner page’s versions in words: the copy from before history began isn’t a change; levels, logos and a take-off are', () => {
  const v = (id, data, by, at, action = 'save') => ({ id, data: JSON.stringify(data), user_email: by, created_at: at, action });
  const lines = T.partnerLines([
    v(1, { name: 'Acme', level: 'friend', logo: 'a.png' }, null, '2025-01-01T00:00:00Z'),
    v(2, { name: 'Acme', level: 'champion', logo: 'b.png' }, 'pat@soardcharity.com', '2025-01-01T00:00:01Z'),
    v(3, { name: 'Acme', level: 'champion', logo: 'b.png', order: 4 }, 'pat@soardcharity.com', '2025-02-01T00:00:00Z'),
    { id: 4, data: '{}', user_email: 'pat@soardcharity.com', created_at: '2025-03-01T00:00:00Z', action: 'delete' },
  ], 'acme');
  assert.deepEqual(lines.map((l) => l.title), ['Partner page: Friend → Champion partner; a new logo', 'Taken off the website'], 'a move in the list is no change');
});

test('a call and a day’s texts in words', () => {
  const users = new Map([['US1', { name: 'Pat Lee', email: 'pat@soardcharity.com' }]]);
  const numbers = new Map([['PN1', { name: 'Main line', number: '+14045550100' }]]);
  const c = T.callLine({ id: 'AC123456', direction: 'outgoing', status: 'completed', answeredAt: '2026-10-01T14:00:05Z', initiatedBy: 'US1', phoneNumberId: 'PN1', createdAt: '2026-10-01T14:00:00Z', duration: 240,
    participants: [{ phoneNumber: '+14045550100' }, { phoneNumber: '+14045550123' }], summary: { summary: ['Talked about the gala'], nextSteps: ['Send the deck'] } }, { users, numbers, phones: ['+14045550123'] });
  assert.equal(c.by, 'Pat Lee');
  assert.equal(c.missed, false);
  assert.equal(c.line, 'Main line');
  assert.deepEqual(c.summary, ['Talked about the gala']);
  const missed = T.callLine({ id: 'AC999999', direction: 'incoming', status: 'missed', createdAt: '2026-10-02T14:00:00Z', duration: 0, participants: [] }, { users, numbers, phones: [] });
  assert.equal(missed.missed, true);
  const texts = T.textLines([
    { id: 'm1', conversationId: 'CN1', direction: 'incoming', text: 'Thank you!', createdAt: '2026-10-01T15:00:00Z' },
    { id: 'm2', conversationId: 'CN1', direction: 'outgoing', userId: 'US1', text: 'Our pleasure', createdAt: '2026-10-01T15:05:00Z' },
    { id: 'm2', conversationId: 'CN1', direction: 'outgoing', userId: 'US1', text: 'Our pleasure', createdAt: '2026-10-01T15:05:00Z' },
    { id: 'm3', conversationId: 'CN1', direction: 'incoming', text: 'See you', createdAt: '2026-10-03T15:00:00Z' },
  ], { users });
  assert.equal(texts.length, 2, 'one line a day');
  const day1 = texts.find((t) => t.count === 2);
  assert.deepEqual(day1.by, ['Pat Lee']);
  assert.equal(day1.detail, 'Our pleasure', 'the same text read twice (from and to) is one');
});

// ─── A whole timeline, against made-up Google, Kit, Quo and Zeffy ───

let env;
let seen;
let zeffyPhone = '(404) 555-0123';
let kitState = 'active';
// A mailbox's second page of conversations (its first page answers with a pageToken for it)
let pagedOnce = {};
const realFetch = globalThis.fetch;
const JANE_THREADS = {
  'robin@soardcharity.com': { t1aaaaaa: [msg('g1aaaaaa', 't1aaaaaa', NOW - 3 * DAY, [H('From', 'Jane Doe <jane@example.com>'), H('To', 'robin@soardcharity.com'), H('Subject', 'Our gift'), H('Message-ID', '<one@x>')]),
    msg('g1fwdddd', 't1aaaaaa', NOW - 3 * DAY + 60e3, [H('From', 'Robin Sample <robin@soardcharity.com>'), H('To', 'pat@soardcharity.com'), H('Subject', 'Fwd: Our gift'), H('Message-ID', '<fwd@x>')])] },
  'pat@soardcharity.com': {
    t2bbbbbb: [msg('g2bbbbbb', 't2bbbbbb', NOW - 2 * DAY, [H('From', 'Pat Lee <pat@soardcharity.com>'), H('To', 'jane@example.com'), H('Cc', 'robin@soardcharity.com'), H('Subject', 'Thank you'), H('Message-ID', '<two@x>')])],
    t3cccccc: [msg('g3cccccc', 't3cccccc', NOW - DAY, [H('From', 'Pat Lee <pat@soardcharity.com>'), H('To', 'someone@else.example'), H('Subject', 'Not hers')])],
  },
};
// Robin's copy of Pat's email (she was copied)
JANE_THREADS['robin@soardcharity.com'].t2hhhhhh = [msg('g2hhhhhh', 't2hhhhhh', NOW - 2 * DAY, [H('From', 'Pat Lee <pat@soardcharity.com>'), H('To', 'jane@example.com'), H('Cc', 'robin@soardcharity.com'), H('Subject', 'Thank you'), H('Message-ID', '<two@x>')])];

function fakeWorld({ gmailDown = null, quo = true } = {}) {
  seen = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    seen.push(url);
    const who = String(init.headers?.Authorization || '').replace('Bearer tok:', '');
    if (url === 'https://oauth2.googleapis.com/token') {
      const claims = JSON.parse(Buffer.from(new URLSearchParams(init.body).get('assertion').split('.')[1], 'base64url').toString());
      return Response.json({ access_token: `tok:${claims.sub}`, expires_in: 3600 });
    }
    if (url.startsWith('https://gmail.googleapis.com/gmail/v1/users/me/threads?')) {
      if (gmailDown === who) return Response.json({ error: { message: 'Backend Error' } }, { status: 500 });
      const q = new URL(url).searchParams.get('q');
      assert.match(q, /from:jane@example\.com/);
      if (new URL(url).searchParams.get('pageToken') === 'PAGE2') return Response.json({ threads: Object.keys(pagedOnce[who] || {}).map((id) => ({ id })) });
      return Response.json({ threads: Object.keys(JANE_THREADS[who] || {}).map((id) => ({ id })), ...(pagedOnce[who] ? { nextPageToken: 'PAGE2' } : {}) });
    }
    if (url === 'https://gmail.googleapis.com/batch/gmail/v1') {
      const boundary = 'resp_b';
      const ids = [...String(init.body).matchAll(/GET \/gmail\/v1\/users\/me\/threads\/(\w+)\?/g)].map((m) => m[1]);
      const body = `${ids.map((id, i) => `--${boundary}\r\nContent-Type: application/http\r\nContent-ID: <response-i${i}>\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n${JSON.stringify({ id, messages: JANE_THREADS[who]?.[id] || pagedOnce[who]?.[id] })}\r\n`).join('')}--${boundary}--`;
      return new Response(body, { headers: { 'Content-Type': `multipart/mixed; boundary=${boundary}` } });
    }
    const thread = /^https:\/\/gmail\.googleapis\.com\/gmail\/v1\/users\/me\/threads\/(\w+)\?format=full$/.exec(url);
    if (thread) {
      const list = JANE_THREADS[who]?.[thread[1]];
      if (!list) return Response.json({ error: { message: 'Not Found' } }, { status: 404 });
      return Response.json({ id: thread[1], messages: list.map((m) => ({ ...m, payload: { ...m.payload, mimeType: 'text/plain', body: { data: Buffer.from('Thanks so much').toString('base64url') } } })) });
    }
    if (url.startsWith('https://www.googleapis.com/calendar/v3/calendars/primary/events?')) {
      if (who !== 'pat@soardcharity.com') return Response.json({ items: [] });
      // Google's oldest-first pages: the newest are on the last one
      if (!new URL(url).searchParams.get('pageToken')) return Response.json({ items: [{ id: 'e0', iCalUID: 'u0', status: 'confirmed', summary: 'Long ago', start: { dateTime: new Date(NOW - 900 * DAY).toISOString() }, attendees: [{ email: 'jane@example.com' }] }], nextPageToken: 'P2' });
      return Response.json({ items: [
        { id: 'e1', iCalUID: 'u1', status: 'confirmed', summary: 'Coffee with Jane', start: { dateTime: new Date(NOW - 10 * DAY).toISOString() }, organizer: { email: 'pat@soardcharity.com' }, attendees: [{ email: 'pat@soardcharity.com' }, { email: 'jane@example.com', responseStatus: 'accepted' }] },
        { id: 'e2', iCalUID: 'u2', status: 'confirmed', summary: 'Site visit', start: { dateTime: new Date(NOW + 5 * DAY).toISOString() }, organizer: { email: 'pat@soardcharity.com' }, attendees: [{ email: 'jane@example.com' }] },
      ] });
    }
    if (url.startsWith('https://api.kit.com/v4/')) {
      const u = new URL(url);
      if (u.pathname === '/v4/subscribers' && u.searchParams.get('status') === 'all') return Response.json({ subscribers: [{ id: 55, email_address: 'jane@example.com', state: kitState, created_at: new Date(NOW - 200 * DAY).toISOString() }] });
      if (u.pathname === '/v4/subscribers') return Response.json({ subscribers: [] });
      if (u.pathname === '/v4/subscribers/55/tags') return Response.json({ tags: [{ id: 7, name: 'Donors', tagged_at: new Date(NOW - 100 * DAY).toISOString() }] });
      if (u.pathname === '/v4/subscribers/55/stats') return Response.json({ subscriber: { id: 55, stats: { sent: 4, opened: 3, clicked: 1, last_opened: new Date(NOW - 5 * DAY).toISOString() } } });
      if (u.pathname === '/v4/broadcasts') return Response.json({ broadcasts: [
        { id: 1, subject: 'October news', status: 'completed', send_at: new Date(NOW - 20 * DAY).toISOString(), subscriber_filter: [{ all: [{ type: 'all_subscribers' }] }] },
        { id: 2, subject: 'Before she joined', status: 'completed', send_at: new Date(NOW - 300 * DAY).toISOString(), subscriber_filter: [] },
        { id: 3, subject: 'Donors only', status: 'completed', send_at: new Date(NOW - 21 * DAY).toISOString(), subscriber_filter: [{ any: [{ type: 'tag', ids: [7] }] }] },
        { id: 4, subject: 'Draft', status: 'draft', send_at: null },
      ], pagination: { has_next_page: false } });
    }
    if (url.startsWith('https://api.zeffy.com/api/v1/contacts/')) return Response.json({ id: 'ct_jane', phone_number: zeffyPhone });
    if (url.startsWith('https://api.quo.com/')) {
      assert.equal(init.headers['Quo-Api-Version'], '2026-03-30');
      const u = new URL(url);
      if (u.pathname === '/users') return Response.json({ data: [{ id: 'US1', email: 'pat@soardcharity.com', firstName: 'Pat', lastName: 'Lee' }], nextCursor: null });
      if (u.pathname === '/phone-numbers') return Response.json({ data: [{ id: 'PN1', name: 'Main line', number: '+14045550100' }], nextCursor: null });
      if (u.pathname === '/calls') {
        if (u.searchParams.get('participant[in]') !== '+14045550123') return Response.json({ data: [], nextCursor: null });
        return Response.json({ data: [{ id: 'AC9999999', direction: 'incoming', status: 'completed', createdAt: new Date(NOW - 4 * DAY).toISOString(), duration: 60, participants: [{ phoneNumber: '+19995550000' }, { phoneNumber: '+14045550100' }], summary: { summary: ['Someone else’s call'] } }, { id: 'AC1234567', direction: 'outgoing', status: 'completed', answeredAt: new Date(NOW - 4 * DAY).toISOString(), initiatedBy: 'US1', phoneNumberId: 'PN1', createdAt: new Date(NOW - 4 * DAY).toISOString(), duration: 180,
          participants: [{ phoneNumber: '+14045550100' }, { phoneNumber: '+14045550123' }] }], nextCursor: null });
      }
      if (u.pathname === '/calls/AC1234567') return Response.json({ data: { id: 'AC1234567', participants: [{ phoneNumber: '+14045550100' }, { phoneNumber: '+14045550123' }] } });
      if (u.pathname === '/calls/AC0404040') return Response.json({ message: 'Not found' }, { status: 404 });
      if (u.pathname === '/calls/AC7654321') return Response.json({ data: { id: 'AC7654321', participants: [{ phoneNumber: '+14045550100' }, { phoneNumber: '+17705550199' }] } });
      if (u.pathname === '/calls/AC1234567/transcripts') return Response.json({ data: [{ status: 'completed', dialogue: [{ content: 'Hi Jane', actorId: 'US1', identifier: '+14045550100', start: 0, end: 1 }, { content: 'Hi!', actorId: null, identifier: '+14045550123', start: 1, end: 2 }] }], nextCursor: null });
      // A text of someone else's in the answer too: the site keeps only theirs, whatever Quo sends
      if (u.pathname === '/messages') return Response.json({ data: u.searchParams.get('from') ? [{ id: 'MS1', conversationId: 'CN1', direction: 'incoming', from: '+14045550123', to: ['+14045550100'], text: 'Thank you!', createdAt: new Date(NOW - 6 * DAY).toISOString() },
        { id: 'MS9', conversationId: 'CN9', direction: 'incoming', from: '+19995550000', to: ['+14045550100'], text: 'Someone else', createdAt: new Date(NOW - 6 * DAY).toISOString() }] : [], nextCursor: null });
    }
    if (url.startsWith('https://api.resend.com/emails/')) return Response.json({ id: 'x', html: '<p>Save the date</p>' });
    throw new Error(`unexpected fetch ${url}`);
  };
  if (!quo) delete env.QUO_API_KEY;
}

beforeEach(async () => {
  env = { DB: await createD1({ schemaSql: [
    'CREATE TABLE kids (slug TEXT PRIMARY KEY, name TEXT, data TEXT)',
    'CREATE TABLE community (slug TEXT PRIMARY KEY, name TEXT, data TEXT)',
    'CREATE TABLE partners (slug TEXT PRIMARY KEY, data TEXT)',
    'CREATE TABLE staff_state (key TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT)',
    'CREATE TABLE audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, user_email TEXT, action TEXT, entity_type TEXT, entity_slug TEXT, entity_name TEXT, changes TEXT, path TEXT, git_status TEXT, created_at TEXT)',
  ] }), GOOGLE_CALENDAR_KEY: SERVICE_ACCOUNT, KIT_API_KEY: 'kit', ZEFFY_API_KEY: 'zeffy', QUO_API_KEY: 'quo', RESEND_API_KEY: 're' };
  clearTokenCache();
  await env.DB.prepare("INSERT INTO staff_state (key, data) VALUES ('directory', ?)").bind(JSON.stringify({ ok: true, accounts: ACCOUNTS })).run();
  await env.DB.prepare('INSERT INTO partners VALUES (?, ?)').bind('acme', JSON.stringify({ name: 'Acme Builders', level: 'champion', category: ['funding'], website: 'https://www.acme-builders.com' })).run();
  await env.DB.prepare('INSERT INTO kids VALUES (?, ?, ?)').bind('ava-sample', 'Ava', JSON.stringify({ name: 'Ava', year: 2025, designers: ['acme'], sponsors: [] })).run();
  await ensureEmailLog(env.DB);
  await ensureHistory(env.DB);
  await env.DB.prepare('INSERT INTO email_log (id, type, to_addr, subject, sent_at, status, opened_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind('re_1234567890', 'reveal-reminder', 'Jane@Example.com', 'Save the date: Ava’s reveal', new Date(NOW - 8 * DAY).toISOString(), 'delivered', new Date(NOW - 7 * DAY).toISOString()).run();
  await env.DB.prepare('INSERT INTO email_log (id, type, to_addr, subject, sent_at, status) VALUES (?, ?, ?, ?, ?, ?)').bind('re_staffalert1', 'live-alert', 'jane@example.com', '[SOARD Live] Stream is down', new Date(NOW - 8 * DAY).toISOString(), 'delivered').run();
  await env.DB.prepare('INSERT INTO email_log (id, type, to_addr, subject, sent_at, status) VALUES (?, ?, ?, ?, ?, ?)').bind('re_otherperson', 'reveal-reminder', 'sam@example.org', 'Save the date', new Date(NOW - 8 * DAY).toISOString(), 'delivered').run();
  const p = { id: 'pay_1', object: 'payment', created: S(NOW - 30 * DAY), amount: 50000, status: 'succeeded', type: 'online', refund_status: 'none', refunds: [], description: 'Gala', contact: 'ct_jane', payment_method: { type: 'card' },
    buyer: { email: 'jane@example.com', first_name: 'Jane', last_name: 'Doe', is_corporate: false, company_name: null }, campaign_category: 'donation', items: [{ type: 'donation', amount: 50000 }], buyer_questions: [], recurring: null, metadata: {} };
  await D.noteDonorPayment(env, p, { now: NOW, thanks: false });
  await D.noteDonorPayment(env, { ...p, id: 'pay_2', contact: 'ct_acme', buyer: { ...p.buyer, email: 'ap@acme-builders.com', first_name: 'Lee', last_name: 'Sample', is_corporate: true, company_name: 'Acme Builders' } }, { now: NOW, thanks: false });
  await env.DB.prepare("INSERT INTO audit_log (user_email, action, entity_type, entity_slug, entity_name, changes, created_at) VALUES ('pat@soardcharity.com', 'updated', 'donor-crm', 'c:ct_jane', 'Looked after by Pat Lee', '{\"key\":\"c:ct_jane\",\"owner\":\"pat@soardcharity.com\"}', '2026-10-01 12:00:00')").run();
  await env.DB.prepare("INSERT INTO audit_log (user_email, action, entity_type, entity_slug, entity_name, changes, created_at) VALUES ('pat@soardcharity.com', 'updated', 'donor-crm', 'c:ct_jane', 'Note added', '{\"key\":\"c:ct_jane\",\"note\":\"n1\"}', '2026-10-01 12:00:00')").run();
});
afterEach(() => { globalThis.fetch = realFetch; });

const kinds = (items) => items.map((x) => x.kind).sort();

test('a person’s timeline: email with the team (once each), meetings, calls and texts, newsletters, website emails and the team’s changes', async () => {
  fakeWorld();
  const v = await T.timelineView(env, 'ct_jane', { now: NOW });
  assert.equal(v.subject.name, 'Jane Doe');
  assert.deepEqual(v.subject.searched.emails, ['jane@example.com']);
  assert.deepEqual(v.subject.searched.phones, ['+14045550123']);
  const by = (k) => v.items.filter((x) => x.kind === k);
  assert.deepEqual(by('email').map((x) => x.title).sort(), ['Our gift', 'Thank you'], 'Pat’s email in two mailboxes is one line; the email that isn’t hers isn’t there');
  assert.equal(by('email').find((x) => x.title === 'Thank you').mailbox, 'pat@soardcharity.com', 'opened from the sender’s copy');
  assert.deepEqual(by('meeting').map((x) => x.title).sort(), ['Coffee with Jane', 'Long ago', 'Site visit'], 'every page of the calendar');
  assert.equal(by('call').length, 1, 'another person’s call in Quo’s answer isn’t theirs');
  assert.ok(!v.items.some((x) => /Someone else/.test(`${x.detail || ''} ${(x.summary || []).join(' ')}`)), 'nor another person’s text');
  assert.equal(by('call')[0].by, 'Pat Lee');
  assert.equal(by('text').length, 1);
  assert.deepEqual(by('site').map((x) => x.title), ['Save the date: Ava’s reveal'], 'a staff alert to her address isn’t one of hers; another person’s email isn’t');
  assert.equal(by('site')[0].opened, true);
  const kit = by('kit');
  assert.ok(kit.some((x) => x.title === 'Joined the newsletter in Kit'));
  assert.ok(kit.some((x) => x.title === 'Added to Donors in Kit (a Zeffy gift)'));
  const sends = kit.filter((x) => x.sends).flatMap((x) => x.sends.map((s) => s.subject)).sort();
  assert.deepEqual(sends, ['Donors only', 'October news'], 'not one sent before she joined, nor a draft');
  assert.deepEqual(v.kit && [v.kit.sent, v.kit.opened], [4, 3]);
  assert.deepEqual(by('team').map((x) => x.title), ['Looked after by Pat Lee'], 'a note’s own line is the note');
  assert.ok(v.sources.every((s) => s.state === 'ok'), JSON.stringify(v.sources));
  assert.equal(v.items.filter((x) => x.kind === 'gift').length, 0, 'gifts come with the page, not here');
});

test('after a change on the page, the site’s own lines are read again without asking Google, Quo or Kit', async () => {
  fakeWorld();
  const v = await T.timelineView(env, 'ct_jane', { now: NOW, local: true });
  assert.deepEqual([...new Set(v.items.map((x) => x.kind))].sort(), ['site', 'team']);
  assert.deepEqual(v.sources.map((s) => s.key), ['site', 'team']);
  assert.deepEqual(seen, [], seen.join('\n'));
});

test('a partner with no gifts in Zeffy: its own people from Partners are searched, by email, domain and phone', async () => {
  fakeWorld();
  await env.DB.prepare('INSERT INTO partners VALUES (?, ?)').bind('tilecraft', JSON.stringify({ name: 'Tilecraft', level: 'friend', category: ['build'], website: 'https://tilecraft.example' })).run();
  await env.DB.exec('CREATE TABLE IF NOT EXISTS partner_contacts (partner TEXT PRIMARY KEY, people TEXT NOT NULL, source TEXT, updated_at TEXT, by TEXT)');
  await env.DB.prepare('INSERT INTO partner_contacts (partner, people) VALUES (?, ?)').bind('tilecraft', JSON.stringify([{ name: 'Rob Tile', email: 'rob@tilecraft.example', phone: '770-555-0199', title: 'Owner' }, { name: 'Robin Sample', email: 'robin.tc@tilecraft.example', phone: '404-555-0111' }])).run();
  const s = await T.subjectOf(env, 'p:tilecraft', { now: NOW });
  assert.ok(s.emails.includes('rob@tilecraft.example'));
  const v = await T.timelineView(env, 'p:tilecraft', { now: NOW });
  assert.deepEqual(v.subject.searched.emails, ['rob@tilecraft.example'], 'a teammate listed as one of its people isn’t searched');
  assert.deepEqual(v.subject.searched.domains, ['tilecraft.example'], 'its people write from its website’s domain');
  assert.deepEqual(v.subject.searched.phones, ['+17705550199']);
});

test('Kit that can’t reach them is said once, as it is now; Quo’s missing call is said as such', async () => {
  fakeWorld();
  kitState = 'bounced';
  const v = await T.timelineView(env, 'ct_jane', { now: NOW });
  assert.ok(!v.items.some((x) => /bounced/.test(x.title || '')), 'no line with no day');
  assert.deepEqual(v.kit.cant, [{ email: 'jane@example.com', state: 'bounced' }]);
  kitState = 'active';
  await assert.rejects(T.callTranscript(env, 'ct_jane', { call: 'AC0404040', now: NOW }), (e) => e.status === 404 && /doesn’t have that call/.test(e.message));
});

test('a mailbox whose first page is all list mail reads on to find their conversations', async () => {
  fakeWorld();
  JANE_THREADS['alex@soardcharity.com'] = { tLIST001: [msg('l1aaaaaa', 'tLIST001', NOW - DAY, [H('From', 'jane@example.com'), H('To', 'alex@soardcharity.com'), H('List-Id', 'News <news.example>'), H('Subject', 'Her newsletter')])] };
  pagedOnce = { 'alex@soardcharity.com': { tREAL001: [msg('r1aaaaaa', 'tREAL001', NOW - 9 * DAY, [H('From', 'jane@example.com'), H('To', 'alex@soardcharity.com'), H('Subject', 'Lunch?')])] } };
  ACCOUNTS.push({ email: 'alex@soardcharity.com', aliases: [], name: 'Alex Rivera', active: true });
  await env.DB.prepare("UPDATE staff_state SET data = ? WHERE key = 'directory'").bind(JSON.stringify({ ok: true, accounts: ACCOUNTS })).run();
  try {
    const v = await T.timelineView(env, 'ct_jane', { now: NOW });
    assert.ok(v.items.some((x) => x.title === 'Lunch?'), 'the second page’s conversation');
    assert.ok(!v.items.some((x) => x.title === 'Her newsletter'));
  } finally { ACCOUNTS.pop(); delete JANE_THREADS['alex@soardcharity.com']; pagedOnce = {}; }
});

test('one mailbox that can’t be read is said, and the rest are still there; Quo not set up says so', async () => {
  fakeWorld({ gmailDown: 'robin@soardcharity.com', quo: false });
  const v = await T.timelineView(env, 'ct_jane', { now: NOW });
  const mail = v.sources.find((s) => s.key === 'mail');
  assert.equal(mail.state, 'ok');
  assert.deepEqual(mail.errors.map((e) => e.mailbox), ['robin@soardcharity.com']);
  assert.deepEqual(v.items.filter((x) => x.kind === 'email').map((x) => x.title), ['Thank you']);
  assert.equal(v.sources.find((s) => s.key === 'quo').state, 'off');
  assert.ok(!seen.some((u) => u.startsWith('https://api.quo.com')), 'Quo isn’t asked without a key');
});

test('a teammate who gives: their email, meetings and calls are never read', async () => {
  fakeWorld();
  await D.noteDonorPayment(env, { id: 'pay_9', object: 'payment', created: S(NOW - DAY), amount: 2500, status: 'succeeded', type: 'online', refund_status: 'none', refunds: [], description: 'Gala', contact: 'ct_robin',
    payment_method: { type: 'card' }, buyer: { email: 'robin.home@example.net', first_name: 'Robin', last_name: 'Sample' }, campaign_category: 'donation', items: [{ type: 'donation', amount: 2500 }], buyer_questions: [], recurring: null, metadata: {} }, { now: NOW, thanks: false });
  const v = await T.timelineView(env, 'ct_robin', { now: NOW });
  assert.equal(v.sources.find((s) => s.key === 'mail').state, 'skipped');
  assert.equal(v.sources.find((s) => s.key === 'quo').state, 'skipped');
  assert.ok(!seen.some((u) => u.includes('gmail') || u.includes('calendar') || u.includes('quo.com') || u.includes('zeffy.com')), seen.join('\n'));
});

test('an organization’s timeline searches its givers and its website’s domain, and shows its partner page and makeovers', async () => {
  fakeWorld();
  await env.DB.prepare("INSERT INTO content_versions (collection, slug, data, action, user_email, created_at) VALUES ('partners', 'acme', ?, 'save', 'pat@soardcharity.com', '2025-05-01T00:00:00Z')").bind(JSON.stringify({ name: 'Acme Builders', level: 'builder' })).run();
  await env.DB.prepare("INSERT INTO content_versions (collection, slug, data, action, user_email, created_at) VALUES ('partners', 'acme', ?, 'save', 'pat@soardcharity.com', '2025-06-01T00:00:00Z')").bind(JSON.stringify({ name: 'Acme Builders', level: 'champion' })).run();
  const s = await T.subjectOf(env, 'p:acme', { now: NOW });
  assert.equal(s.kind, 'org');
  assert.deepEqual(s.domains, ['acme-builders.com']);
  assert.ok(s.emails.includes('ap@acme-builders.com'));
  const v = await T.timelineView(env, 'p:acme', { now: NOW });
  const partner = v.items.filter((x) => x.kind === 'partner').map((x) => x.title);
  assert.deepEqual(partner.sort(), ['On the website as a Builder partner', 'Partner page: Builder → Champion partner']);
  const mk = v.items.find((x) => x.kind === 'makeover');
  assert.equal(mk.title, 'Designed Ava’s makeover');
  assert.equal(mk.year, 2025, 'credited before the page kept versions: its year only');
  assert.equal(mk.at, Date.UTC(2025, 0, 1, 12));
  // Credited in a saved version: on that day
  await env.DB.prepare("INSERT INTO content_versions (collection, slug, data, action, user_email, created_at) VALUES ('kids', 'ava-sample', ?, 'save', null, '2025-03-01T00:00:00Z')").bind(JSON.stringify({ name: 'Ava', designers: [] })).run();
  await env.DB.prepare("INSERT INTO content_versions (collection, slug, data, action, user_email, created_at) VALUES ('kids', 'ava-sample', ?, 'save', 'pat@soardcharity.com', '2025-04-02T00:00:00Z')").bind(JSON.stringify({ name: 'Ava', designers: ['acme'] })).run();
  const again = (await T.timelineView(env, 'p:acme', { now: NOW, local: true })).items.find((x) => x.kind === 'makeover');
  assert.equal(again.at, Date.parse('2025-04-02T00:00:00Z'));
  assert.equal(again.year, null);
  // Credited already in the copy kept from before history began: before history, its year only
  await env.DB.prepare("DELETE FROM content_versions WHERE collection = 'kids'").run();
  await env.DB.prepare("INSERT INTO content_versions (collection, slug, data, action, user_email, created_at) VALUES ('kids', 'ava-sample', ?, 'save', null, '2026-11-01T00:00:00Z')").bind(JSON.stringify({ name: 'Ava', designers: ['acme'] })).run();
  await env.DB.prepare("INSERT INTO content_versions (collection, slug, data, action, user_email, created_at) VALUES ('kids', 'ava-sample', ?, 'save', 'pat@soardcharity.com', '2026-11-01T00:00:01Z')").bind(JSON.stringify({ name: 'Ava', designers: ['acme'], bio: 'x' })).run();
  const old = (await T.timelineView(env, 'p:acme', { now: NOW, local: true })).items.find((x) => x.kind === 'makeover');
  assert.equal(old.year, 2025);
});

test('only a conversation the donor is on opens, and opening one is logged', async () => {
  fakeWorld();
  const t = await T.mailThread(env, 'ct_jane', { mailbox: 'robin@soardcharity.com', thread: 't1aaaaaa', me: 'pat@soardcharity.com', now: NOW });
  assert.equal(t.messages.length, 1, 'Robin’s forward to Pat in the same conversation isn’t shown');
  assert.equal(t.hidden, 1);
  assert.equal(t.messages[0].theirs, true);
  assert.equal(t.messages[0].text, 'Thanks so much');
  const log = (await env.DB.prepare("SELECT user_email, entity_slug, entity_name FROM audit_log WHERE entity_type = 'mailbox'").all()).results;
  assert.deepEqual(log.map((r) => [r.user_email, r.entity_slug]), [['pat@soardcharity.com', 'robin@soardcharity.com']]);
  await assert.rejects(T.mailThread(env, 'ct_jane', { mailbox: 'pat@soardcharity.com', thread: 't3cccccc', me: 'pat@soardcharity.com', now: NOW }), (e) => e.status === 403, 'not hers: refused');
  await assert.rejects(T.mailThread(env, 'ct_jane', { mailbox: 'someone@gmail.com', thread: 't1aaaaaa', me: 'pat@soardcharity.com', now: NOW }), (e) => e.status === 404, 'not a SOARD mailbox');
});

test('only a call with the donor’s number shows its words; only an email sent to them opens', async () => {
  fakeWorld();
  const t = await T.callTranscript(env, 'ct_jane', { call: 'AC1234567', now: NOW });
  assert.deepEqual(t.dialogue.map((d) => [d.who, d.text, d.theirs]), [['Pat Lee', 'Hi Jane', false], ['Jane Doe', 'Hi!', true]]);
  await assert.rejects(T.callTranscript(env, 'ct_jane', { call: 'AC7654321', now: NOW }), (e) => e.status === 403);
  assert.ok((await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE entity_slug = 'quo'").first()).n >= 1, 'reading a call’s words is logged');
  // SOARD's own line typed on their record opens nothing
  zeffyPhone = '(404) 555-0100';
  await assert.rejects(T.callTranscript(env, 'ct_jane', { call: 'AC1234567', now: NOW }), (e) => e.status === 403);
  zeffyPhone = '(404) 555-0123';
  const e = await T.sentEmail(env, 'ct_jane', { id: 're_1234567890', now: NOW });
  assert.equal(e.html, '<p>Save the date</p>');
  await assert.rejects(T.sentEmail(env, 'ct_jane', { id: 're_otherperson', now: NOW }), (x) => x.status === 404);
});

test('the route: everyone on the team gets the timeline; a refusal comes back in words with its status', async () => {
  fakeWorld();
  const get = async (q) => { const r = await onRequestGet({ request: new Request(`https://sunshineonaranneyday.com/api/donors-admin?${q}`), env, data: { userEmail: 'pat@soardcharity.com' } }); return { status: r.status, body: await r.json() }; };
  const ok = await get('timeline=ct_jane');
  assert.equal(ok.status, 200);
  assert.equal(ok.body.me, 'pat@soardcharity.com');
  assert.ok(ok.body.items.length > 5);
  const no = await get('timeline=ct_jane&mailbox=pat@soardcharity.com&thread=t3cccccc');
  assert.equal(no.status, 403);
  assert.match(no.body.error, /isn’t on that conversation/);
  const gone = await get('timeline=ct_nobody');
  assert.equal(gone.status, 404);
});
