/**
 * The email that brings a board member to the board page: from the admin who
 * sends it, what's waiting for them there, and the first sign-in in the live
 * Access page's own words. Made-up people only (the repo is public).
 * Run: node --test tests/
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { welcomeEmail, sendWelcome, saveMeeting, patchMeeting, saveDoc } from '../functions/api/_board.js';
import { readState } from '../functions/api/_board-roles.js';
import { welcomeHad } from '../public/admin/board-shared.js';
import { newMeeting, todayEastern, longDate } from '../public/admin/board-shared.js';

const PEOPLE = [
  ['jane-doe', { name: 'Jane Doe', group: 'team', title: 'Co-Founder/President' }],
  ['pat-lee', { name: 'Pat Lee', group: 'team', title: 'Program Director' }],
  ['alex-rivera', { name: 'Alex Rivera', group: 'board', title: 'Board Chair' }],
  ['sam-ortiz', { name: 'Sam Ortiz', group: 'board', title: 'Board Treasurer' }],
];

let env;
let sent = [];
const realFetch = globalThis.fetch;

beforeEach(async () => {
  env = { DB: await createD1(), RESEND_API_KEY: 're_test' };
  await env.DB.exec('CREATE TABLE team (slug TEXT PRIMARY KEY, name TEXT, "group" TEXT, order_num INTEGER, data TEXT NOT NULL, updated_at TEXT)');
  await env.DB.exec('CREATE TABLE reveal_board_emails (slug TEXT PRIMARY KEY, email TEXT NOT NULL, updated_at TEXT)');
  await env.DB.exec('CREATE TABLE site_config (key TEXT PRIMARY KEY, data TEXT, updated_at TEXT)');
  for (const [slug, d] of PEOPLE) await env.DB.prepare('INSERT INTO team (slug, name, "group", data) VALUES (?, ?, ?, ?)').bind(slug, d.name, d.group, JSON.stringify(d)).run();
  for (const [slug, email] of [['alex-rivera', 'alex.board@example.com'], ['sam-ortiz', 'sam.board@example.org']]) {
    await env.DB.prepare('INSERT INTO reveal_board_emails (slug, email) VALUES (?, ?)').bind(slug, email).run();
  }
  sent = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    if (!url.startsWith('https://api.resend.com/')) throw new Error(`unexpected fetch ${url}`);
    const b = JSON.parse(init.body);
    sent.push(...(Array.isArray(b) ? b : [b]));
    return Response.json(Array.isArray(b) ? { data: b.map((_, i) => ({ id: `em_${i}` })) } : { id: 'em_0' });
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

const inDays = (n) => new Date(Date.parse(`${todayEastern()}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

test('the sign-in steps say what the live Access page says, and what to do when no code comes', () => {
  const mail = welcomeEmail({ name: 'Alex Rivera', email: 'alex.board@example.com', helpers: ['Jane', 'Pat'] });
  for (const body of [mail.html, mail.text]) {
    for (const words of ['Log in to SOARD Admin', 'Send login code', 'Sign in', 'Request new code', 'noreply@notify.cloudflare.com', '10 minutes', 'alex.board@example.com', 'spam']) {
      assert.ok(body.includes(words), `says “${words}”`);
    }
    assert.match(body, /Another address gets no code/, 'Access sends nothing to an address it doesn’t know, though its page says it did');
    assert.match(body, /Reply to this email and Jane or Pat will help/);
    assert.match(body, /1-800-FIGUREITOUT/, 'the sign-in page’s joke, on purpose');
    assert.doesNotMatch(body, /Send code\b/, 'the button is Send login code');
    assert.doesNotMatch(body, /—/, 'no em dashes in SOARD copy');
  }
  assert.match(mail.subject, /^Your SOARD board page is ready$/, 'no one named, no one invited them');
  assert.match(mail.html, /white-space:nowrap;">1-800-FIGUREITOUT/, 'the number never breaks at its hyphen');
  assert.match(mail.html, /Alex, your board page is ready/);
});

test('from the admin who sends it: their name, photo and title; the next meeting and the papers each member still has to sign', async () => {
  const m = newMeeting({ date: inDays(10), defaults: { start: '18:00', end: '19:30', location: 'Example Hall', address: '1 Example St, Roswell, GA' } });
  await saveMeeting(env.DB, { ...m, shared: true }, { by: 'jane@soardcharity.com' });
  // Further ahead, and a past one: neither is "next"
  await saveMeeting(env.DB, { ...newMeeting({ date: inDays(100) }), shared: true }, { by: 'jane@soardcharity.com' });
  await saveMeeting(env.DB, { ...newMeeting({ date: inDays(-30) }), shared: true }, { by: 'jane@soardcharity.com' });
  const coi = await saveDoc(env.DB, { title: 'Conflict of Interest Policy', kind: 'policy', sign: true });
  const noFile = await saveDoc(env.DB, { title: 'Whistleblower Policy', kind: 'policy', sign: true });
  await saveDoc(env.DB, { title: 'Bylaws', kind: 'governance' });
  await env.DB.prepare('INSERT INTO board_files (id, owner_type, owner_id, r2_key, name, type, size, kind, staff_only, at, by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind('f_coi', 'doc', coi.id, 'board/doc/x', 'coi.pdf', 'application/pdf', 10, 'other', 0, new Date().toISOString(), '').run();
  // Sam already signed this year's
  await env.DB.prepare('INSERT INTO board_signatures (doc_id, slug, year, name, at) VALUES (?, ?, ?, ?, ?)').bind(coi.id, 'sam-ortiz', Number(todayEastern().slice(0, 4)), 'Sam Ortiz', new Date().toISOString()).run();

  const r = await sendWelcome(env, { by: 'jane@soardcharity.com', replyTo: ['jane@soardcharity.com', 'pat@soardcharity.com'] });
  assert.equal(r.sent, 2);
  assert.equal(sent.length, 2, 'each member gets their own');
  const alex = sent.find((e) => e.to.includes('alex.board@example.com'));
  const sam = sent.find((e) => e.to.includes('sam.board@example.org'));
  assert.match(alex.from, /^"Jane Doe via SOARD Board" </);
  assert.equal(alex.subject, 'Jane Doe invited you to SOARD’s board page');
  assert.match(alex.html, /<strong>Jane Doe<\/strong> invited you/);
  assert.match(alex.html, /Co-Founder\/President/);
  assert.match(alex.html, /alex\.board@example\.com/, 'their own address in the steps');
  assert.doesNotMatch(alex.html, /sam\.board@example\.org/, 'never another member’s');
  assert.match(alex.text, new RegExp(`Next meeting: .*\\n.*6:00 to 7:30 PM\\nExample Hall, 1 Example St, Roswell, GA\\nIts agenda is on the board page\\.`));
  assert.match(alex.text, /To sign for \d{4}:\n- Conflict of Interest Policy\n/);
  assert.doesNotMatch(alex.text, new RegExp(noFile.title), 'a paper with no file isn’t asked for');
  assert.match(alex.text, /Read it on the board page, and sign by typing your name or adding the copy you signed on paper\./, 'one paper is “it”');
  assert.doesNotMatch(sam.text, /To sign for/, 'Sam signed it already');
  assert.match(alex.text, /Reply to this email and Jane or Pat will help/);
});

test('a preview goes to the admin, greets them by name, and shows every paper to sign; with nothing ahead it leaves the meeting out', async () => {
  const doc = await saveDoc(env.DB, { title: 'Conflict of Interest Policy', kind: 'policy', sign: true });
  await env.DB.prepare('INSERT INTO board_files (id, owner_type, owner_id, r2_key, name, type, size, kind, staff_only, at, by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind('f_coi', 'doc', doc.id, 'board/doc/x', 'coi.pdf', 'application/pdf', 10, 'other', 0, new Date().toISOString(), '').run();
  const r = await sendWelcome(env, { to: ['pat@soardcharity.com'], by: 'pat@soardcharity.com', replyTo: ['jane@soardcharity.com'] });
  assert.equal(r.sent, 1);
  assert.deepEqual(sent[0].to, ['pat@soardcharity.com']);
  assert.match(sent[0].subject, /^\[Preview\] Pat Lee invited you/);
  assert.match(sent[0].html, /Pat, your board page is ready/);
  assert.match(sent[0].text, /- Conflict of Interest Policy/);
  assert.doesNotMatch(sent[0].text, /Next meeting/);
  assert.match(sent[0].text, /Jane will help/);
});

test('the From name is quoted and keeps a phone’s apostrophe; a title or initial is never the greeting', () => {
  const mail = welcomeEmail({ name: 'Dr. Lee Park', email: 'lee@example.com', inviter: { name: 'Jane Q. O’Neil, Jr.', title: '' } });
  assert.match(mail.from, /^"Jane Q\. O'Neil, Jr\. via SOARD Board" <[^>]+>$/);
  assert.match(mail.html, /Lee, your board page is ready/);
  assert.match(welcomeEmail({ name: 'J. Michael Ortiz' }).html, /Michael, your board page is ready/);
  assert.match(welcomeEmail({ name: 'Dr.' }).html, />Your board page is ready</);
  assert.match(welcomeEmail({ email: 'a.very.long.address.for.a.board.member@some-company-example.com' }).html, /<strong style="word-break:break-all;">a\.very/, 'a long address wraps on a phone');
});

test('the next meeting is never one taken off the calendar', async () => {
  const gone = newMeeting({ date: inDays(3), defaults: { start: '18:00', end: '19:30' } });
  // (as older code left a meeting whose calendar event was deleted)
  const saved = await saveMeeting(env.DB, { ...gone, shared: true }, { by: 'jane@soardcharity.com' });
  await patchMeeting(env.DB, saved.id, (cur) => ({ ...cur, calendar: { uid: 'e1@google.com', eventId: 'e1', gone: true } }));
  const real = newMeeting({ date: inDays(20), defaults: { start: '18:00', end: '19:30' } });
  await saveMeeting(env.DB, { ...real, shared: true }, { by: 'jane@soardcharity.com' });
  await sendWelcome(env, { to: ['jane@soardcharity.com'] });
  assert.match(sent[0].text, new RegExp(`Next meeting: [^\\n]+\\n${longDate(inDays(20))}`));
});

test('a sender not on People is the one the invites come from; with no one to name, it comes from the board and still reads whole', async () => {
  await sendWelcome(env, { by: 'someone@example.com' });
  assert.match(sent[0].from, /^"Jane Doe via SOARD Board" </, 'the founder titled President, as the invites');
  sent = [];
  await env.DB.prepare("DELETE FROM team WHERE \"group\" = 'team'").run();
  await env.DB.prepare("DELETE FROM board_state WHERE key = 'welcome'").run(); // a board that hasn't had it (a second send skips who has)
  await sendWelcome(env, { by: 'someone@example.com' });
  assert.equal(sent.length, 2);
  assert.match(sent[0].from, /^SOARD Board </);
  assert.equal(sent[0].subject, 'Your SOARD board page is ready');
  assert.doesNotMatch(sent[0].html, /invited you/);
  assert.match(sent[0].text, /Reply to this email and we’ll help/);
});

test('one member sent it on their own: their time is kept, and the board isn’t marked told; all of it is one batch, so a failure sends nobody a copy', async () => {
  await sendWelcome(env, { slugs: ['sam-ortiz'], by: 'jane@soardcharity.com' });
  let st = await readState(env.DB, 'welcome');
  assert.ok(st.members['sam-ortiz'] && !st.members['alex-rivera']);
  assert.equal(st.sentAt, undefined, 'the board-wide “told” waits for the whole board');
  await sendWelcome(env, { by: 'jane@soardcharity.com' });
  st = await readState(env.DB, 'welcome');
  assert.ok(st.sentAt && st.members['alex-rivera'] && st.members['sam-ortiz']);
  // Resend down: nobody got it, nothing is marked
  await env.DB.prepare("DELETE FROM board_state WHERE key = 'welcome'").run();
  sent = [];
  globalThis.fetch = async () => new Response('down', { status: 500 });
  const before = JSON.stringify(await readState(env.DB, 'welcome'));
  const r = await sendWelcome(env, { by: 'jane@soardcharity.com' });
  assert.equal(r.sent, 0);
  assert.equal(r.failed, 2);
  assert.equal(JSON.stringify(await readState(env.DB, 'welcome')), before);
});

test('nobody gets a second copy by accident: the board’s send skips who has it, a pick or “again” skips who had it in the last ten minutes, and a new address is due again', async () => {
  const to = () => sent.map((m) => m.to).flat().sort();
  await sendWelcome(env, { by: 'jane@soardcharity.com' });
  assert.deepEqual(to(), ['alex.board@example.com', 'sam.board@example.org']);
  sent = [];
  // A second click, a slow page, two admins: the board's send again goes to nobody
  const twice = await sendWelcome(env, { by: 'jane@soardcharity.com' });
  assert.equal(twice.sent, 0);
  assert.equal(twice.already, 2);
  assert.equal(sent.length, 0);
  // Someone picked, or everyone again, minutes later: still nobody
  assert.equal((await sendWelcome(env, { slugs: ['sam-ortiz'], by: 'jane@soardcharity.com' })).sent, 0);
  assert.equal((await sendWelcome(env, { again: true, by: 'jane@soardcharity.com' })).sent, 0);
  assert.equal(sent.length, 0);
  // Ten minutes on: the pick goes, and so does everyone again
  const st = await readState(env.DB, 'welcome');
  const old = new Date(Date.now() - 11 * 60 * 1000).toISOString();
  await env.DB.prepare("UPDATE board_state SET data = ? WHERE key = 'welcome'").bind(JSON.stringify({ ...st, members: { 'alex-rivera': old, 'sam-ortiz': old } })).run();
  assert.equal((await sendWelcome(env, { slugs: ['sam-ortiz'], by: 'jane@soardcharity.com' })).sent, 1);
  assert.deepEqual(to(), ['sam.board@example.org']);
  sent = [];
  assert.equal((await sendWelcome(env, { again: true, by: 'jane@soardcharity.com' })).sent, 1, 'everyone again: Alex, not Sam (just now)');
  assert.deepEqual(to(), ['alex.board@example.com']);
  sent = [];
  // Alex's address corrected on People → Board: due again, and the board's send reaches only them
  await env.DB.prepare("UPDATE reveal_board_emails SET email = ? WHERE slug = 'alex-rivera'").bind('alex.new@example.com').run();
  assert.equal((await sendWelcome(env, { by: 'jane@soardcharity.com' })).sent, 1);
  assert.deepEqual(to(), ['alex.new@example.com']);
  assert.equal((await readState(env.DB, 'welcome')).addresses['alex-rivera'], 'alex.new@example.com');
});

test('one send at a time: two at once (another tab, the table during the panel’s) send once, and the second is turned away', async () => {
  const [a, b] = await Promise.allSettled([sendWelcome(env, { by: 'jane@soardcharity.com' }), sendWelcome(env, { by: 'jane@soardcharity.com' })]);
  const done = [a, b].filter((x) => x.status === 'fulfilled');
  const away = [a, b].filter((x) => x.status === 'rejected');
  assert.equal(done.length, 1);
  assert.equal(away.length, 1);
  assert.equal(away[0].reason.status, 409);
  assert.match(away[0].reason.message, /Another sign-in email was going out at the same moment/);
  assert.equal(sent.length, 2, 'each member once');
  // The claim is let go: the next send runs (and finds everyone has it)
  assert.equal((await sendWelcome(env, { by: 'jane@soardcharity.com' })).already, 2);
});

test('Resend not answering may still have sent it: counted as sent, so the next send doesn’t give anyone a second copy', async () => {
  globalThis.fetch = async () => { throw new Error('The operation was aborted due to timeout'); };
  const r = await sendWelcome(env, { by: 'jane@soardcharity.com' });
  assert.equal(r.unsure, true);
  assert.ok((await readState(env.DB, 'welcome')).members['alex-rivera']);
  // Resend answering with an error is a sure failure: nothing marked (another board, fresh)
  await env.DB.prepare("DELETE FROM board_state WHERE key = 'welcome'").run();
  globalThis.fetch = async () => new Response(JSON.stringify({ message: 'The from address domain is not verified' }), { status: 422 });
  const sure = await sendWelcome(env, { by: 'jane@soardcharity.com' });
  assert.equal(sure.unsure, undefined);
  assert.equal(sure.errors[0], 'Resend 422: The from address domain is not verified');
  assert.deepEqual(await readState(env.DB, 'welcome'), {});
});

test('who has had it, one rule: their own send at the address it went to, else (before each was kept) the whole board’s', () => {
  const alex = { slug: 'alex-rivera', email: 'alex@example.com' };
  assert.equal(welcomeHad({ members: { 'alex-rivera': 't1' }, addresses: { 'alex-rivera': 'alex@example.com' } }, alex), 't1');
  assert.equal(welcomeHad({ members: { 'alex-rivera': 't1' }, addresses: { 'alex-rivera': 'old@example.com' } }, alex), null, 'a corrected address is due again');
  assert.equal(welcomeHad({ members: { 'alex-rivera': 't1' } }, alex), 't1', 'kept before addresses were');
  assert.equal(welcomeHad({ sentAt: 't0', sent: 4 }, alex), null, 'only their own send counts');
  assert.equal(welcomeHad({ sentAt: 't0', members: { 'sam-ortiz': 't2' } }, alex), null, 'once each is kept, only their own counts');
  assert.equal(welcomeHad(null, alex), null);
  assert.equal(welcomeHad({ members: { 'alex-old': 't3' }, addresses: { 'alex-old': 'alex@example.com' } }, alex), 't3', 'a renamed web address: the same email had it');
});

test('a catch-up never doubles: the board’s send (or a pick that’s due) skips who has it, however old the page or the record', async () => {
  await sendWelcome(env, { slugs: ['sam-ortiz'], by: 'jane@soardcharity.com' });
  // Long after (the ten minutes long gone), a stale page asks for everyone who hasn't had it, and a row's first send asks for Sam
  const st = await readState(env.DB, 'welcome');
  const old = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  await env.DB.prepare("UPDATE board_state SET data = ? WHERE key = 'welcome'").bind(JSON.stringify({ ...st, members: { 'sam-ortiz': old } })).run();
  sent = [];
  assert.equal((await sendWelcome(env, { by: 'jane@soardcharity.com' })).sent, 1, 'only Alex');
  assert.deepEqual(sent.map((m) => m.to).flat(), ['alex.board@example.com']);
  sent = [];
  assert.equal((await sendWelcome(env, { slugs: ['sam-ortiz'], due: true, by: 'jane@soardcharity.com' })).already, 1, 'a due pick of someone who has it: nobody');
  assert.equal(sent.length, 0);
});

test('an address the mailer can’t use is never counted as told, and is named; a pick of someone no longer on the board says so', async () => {
  await env.DB.prepare("UPDATE reveal_board_emails SET email = ? WHERE slug = 'sam-ortiz'").bind('sam.board@gmail.c').run();
  const r = await sendWelcome(env, { by: 'jane@soardcharity.com' });
  assert.equal(r.sent, 1);
  assert.deepEqual(r.unusable, ['Sam Ortiz']);
  const st = await readState(env.DB, 'welcome');
  assert.ok(st.members['alex-rivera'] && !st.members['sam-ortiz'], 'Sam isn’t counted as told');
  await assert.rejects(sendWelcome(env, { slugs: ['sam-ortiz'], by: 'jane@soardcharity.com' }), /The email on People → Board for Sam Ortiz isn’t a whole address/);
  await assert.rejects(sendWelcome(env, { slugs: ['someone-who-left'], by: 'jane@soardcharity.com' }), /They aren’t on People → Board with an email now/);
});

test('a gateway’s 502, 503 or 504 in front of Resend may still have sent it: counted as sent (Resend’s own error status is a sure no)', async () => {
  globalThis.fetch = async () => new Response('Gateway Timeout', { status: 504 });
  const r = await sendWelcome(env, { by: 'jane@soardcharity.com' });
  assert.equal(r.unsure, true);
  assert.ok((await readState(env.DB, 'welcome')).members['alex-rivera']);
});

test('a pick that reaches everyone left counts the board as told; until then it doesn’t', async () => {
  await sendWelcome(env, { slugs: ['alex-rivera'], due: true, by: 'jane@soardcharity.com' });
  assert.equal((await readState(env.DB, 'welcome')).sentAt, undefined);
  await sendWelcome(env, { slugs: ['sam-ortiz'], due: true, by: 'jane@soardcharity.com' });
  assert.ok((await readState(env.DB, 'welcome')).sentAt, 'everyone with an address has it now');
});

test('recorded before it goes: a send cut off midway counts as sent; a sure no from Resend puts the record back', async () => {
  let seen = null;
  globalThis.fetch = async (input, init = {}) => {
    seen = await readState(env.DB, 'welcome'); // what's recorded while Resend has it
    const b = JSON.parse(init.body);
    sent.push(...b);
    return Response.json({ data: b.map((_, i) => ({ id: `em_${i}` })) });
  };
  await sendWelcome(env, { by: 'jane@soardcharity.com' });
  assert.ok(seen?.members?.['alex-rivera'] && seen.members['sam-ortiz'], 'already counted while it goes');
});
