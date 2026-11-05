/**
 * Email all: who gets it, what goes, and that one press is one email.
 * Real module on an in-memory D1, Google faked. Made-up people only (the repo is public).
 *
 *   node --test tests/board-email-all.test.mjs
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createD1 } from './lib/d1-shim.mjs';
import { emailAll, noteEmail } from '../functions/api/_board-email-all.js';
import { clearTokenCache } from '../functions/api/_google-calendar.js';
import { writeState } from '../functions/api/_board-roles.js';
import { mailLink } from '../public/admin/board-activity.js';

const { privateKey: PEM } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const KEY = JSON.stringify({ type: 'service_account', client_email: 'site@example.iam.gserviceaccount.com', client_id: '1', project_id: 'soard-site', private_key: PEM, token_uri: 'https://oauth2.googleapis.com/token' });
const ME = 'jane@soardcharity.com';
const PEOPLE = [
  ['jane-doe', { name: 'Jane Doe', group: 'team' }],
  ['hal-hart', { name: 'Hal Hart', group: 'team' }],
  ['alex-rivera', { name: 'Alex Rivera', group: 'board' }],
  ['bo-kim', { name: 'Bo Kim', group: 'board' }],
  ['cy-noemail', { name: 'Cy Noemail', group: 'board' }],
  ['ex-member', { name: 'Ex Member', group: 'board', status: 'alumni' }],
  ['ada-advisor', { name: 'Ada Advisor', group: 'advisory' }],
];
const EMAILS = { 'alex-rivera': 'alex@example.com', 'bo-kim': 'Bo.Kim@Example.org', 'ex-member': 'ex@example.com', 'ada-advisor': 'ada@example.com' };
let env; let sent; let answer; let tokenAnswer; let tokens; let sentBox; let readAnswer;

const fetchImpl = async (url, init = {}) => {
  url = String(url);
  if (url === 'https://oauth2.googleapis.com/token') {
    tokens.push(JSON.parse(Buffer.from(new URLSearchParams(init.body).get('assertion').split('.')[1], 'base64url').toString()));
    return tokenAnswer();
  }
  if (url.endsWith('/messages/send')) {
    const raw = Buffer.from(JSON.parse(init.body).raw, 'base64url').toString('utf8');
    const r = await answer(init, raw);
    if (r.ok) { sent.push(raw); sentBox.push(raw); }
    return r;
  }
  // The writer's Sent folder
  if (/\/messages\?q=/.test(url)) return readAnswer() || Response.json({ messages: sentBox.map((_, i) => ({ id: `s${i}` })) });
  const one = url.match(/\/messages\/s(\d+)\?format=metadata/);
  if (one) return Response.json({ payload: { headers: [{ name: 'X-SOARD-Board', value: sentBox[Number(one[1])].match(/^X-SOARD-Board: (.*?)\r?$/m)?.[1] || '' }] } });
  throw new Error(`unexpected ${url}`);
};
const go = (o = {}) => emailAll(env, { me: ME, subject: 'Thanks', message: 'See you soon.', fetchImpl, ...o });
const toLine = (raw) => raw.match(/^To: (.*)$/m)?.[1] || '';

beforeEach(async () => {
  env = { DB: await createD1(), GOOGLE_CALENDAR_KEY: KEY };
  await env.DB.exec('CREATE TABLE team (slug TEXT PRIMARY KEY, name TEXT, "group" TEXT, order_num INTEGER, data TEXT NOT NULL, updated_at TEXT)');
  await env.DB.exec('CREATE TABLE reveal_board_emails (slug TEXT PRIMARY KEY, email TEXT NOT NULL, updated_at TEXT)');
  for (const [slug, d] of PEOPLE) await env.DB.prepare('INSERT INTO team (slug, name, "group", data) VALUES (?, ?, ?, ?)').bind(slug, d.name, d.group, JSON.stringify(d)).run();
  for (const [slug, email] of Object.entries(EMAILS)) await env.DB.prepare('INSERT INTO reveal_board_emails (slug, email) VALUES (?, ?)').bind(slug, email).run();
  await writeState(env.DB, 'settings', { admins: [ME, 'hal@soardcharity.com'] });
  sent = [];
  tokens = [];
  sentBox = [];
  readAnswer = () => null;
  answer = () => Response.json({ id: 'm1', threadId: 't1' });
  tokenAnswer = () => Response.json({ access_token: 'g-test', expires_in: 3600 });
  clearTokenCache();
});

test('the words become an email a person wrote: one subject line, paragraphs, links, nothing unescaped', () => {
  const n = noteEmail({ subject: ' A\r\nBcc: x@example.com ', message: 'One <b>\r\nTwo & three\n\nMore at https://example.com/a?b=1&c=2. Thanks' });
  assert.equal(n.subject, 'A Bcc: x@example.com', 'a line break can’t add a header');
  assert.match(n.html, /One &lt;b&gt;<br>Two &amp; three/);
  assert.match(n.html, /<a href="https:\/\/example\.com\/a\?b=1&amp;c=2"/, 'a link, without the sentence’s dot');
  assert.equal((n.html.match(/<p /g) || []).length, 2);
  assert.equal(n.text.split('\n\n').length, 2);
});

test('links keep their whole address and leave the sentence’s marks outside', () => {
  const html = (m) => noteEmail({ subject: 's', message: m }).html;
  assert.match(html('Join <https://zoom.us/j/123> today'), /&lt;<a href="https:\/\/zoom\.us\/j\/123"[^>]*>https:\/\/zoom\.us\/j\/123<\/a>&gt; today/);
  assert.match(html('See https://en.wikipedia.org/wiki/Foo_(bar) now'), /href="https:\/\/en\.wikipedia\.org\/wiki\/Foo_\(bar\)"/);
  assert.match(html('(see https://example.com/a).'), /href="https:\/\/example\.com\/a"[^>]*>https:\/\/example\.com\/a<\/a>\)\./);
  assert.match(html('At www.example.com/a. OK'), /href="https:\/\/www\.example\.com\/a"[^>]*>www\.example\.com\/a<\/a>\. OK/);
  assert.match(html('HTTPS://EXAMPLE.COM/A'), /href="HTTPS:\/\/EXAMPLE\.COM\/A"/);
  assert.match(html('Go to http://example.com/x?a=1&b=2, thanks'), /href="http:\/\/example\.com\/x\?a=1&amp;b=2"[^>]*>[^<]*<\/a>, thanks/);
  assert.ok(!/javascript:/.test(html('javascript:alert(1)').replace(/javascript:alert\(1\)/, '')));
  assert.ok(!html('<script>alert(1)</script>').includes('<script>'));
  assert.ok(!html('https://example.com/"onmouseover="x').includes('"onmouseover'), 'a quote can’t leave the link');
});

test('a mail link carries the words while they fit, and always the addresses', () => {
  const to = ['a@example.com', 'b@example.com'];
  assert.equal(mailLink(to), 'mailto:a@example.com,b@example.com');
  assert.equal(mailLink(to, { subject: 'Hi & bye' }), 'mailto:a@example.com,b@example.com?subject=Hi%20%26%20bye');
  assert.equal(mailLink(to, { message: 'Yes' }), 'mailto:a@example.com,b@example.com?body=Yes');
  assert.equal(mailLink(to, { subject: 'Hi', message: 'x'.repeat(5000) }), 'mailto:a@example.com,b@example.com?subject=Hi', 'too long for a link: the subject and addresses');
  assert.equal(mailLink(to, { subject: 'é'.repeat(900), message: 'Hi' }), 'mailto:a@example.com,b@example.com?body=Hi', 'a subject too long for a link stays out of it');
});

test('it needs a subject, a message and a Google key, and sends nothing without them', async () => {
  await assert.rejects(go({ subject: '  ' }), /subject first/);
  await assert.rejects(go({ message: '\n ' }), /message first/);
  await assert.rejects(go({ subject: 'x'.repeat(201) }), /under 200/);
  await assert.rejects(go({ message: 'x'.repeat(20001) }), /too long/);
  await assert.rejects(emailAll({ ...env, GOOGLE_CALENDAR_KEY: '' }, { me: ME, subject: 'a', message: 'b', fetchImpl }), /no Google key/);
  assert.equal(sent.length, 0);
});

test('it goes from the writer’s own Gmail to the board and the other admin, each by their own address', async () => {
  const r = await go();
  assert.deepEqual(r, { sent: 3 });
  assert.equal(tokens[0].sub, ME, 'Google is asked to act as the writer');
  assert.match(tokens[0].scope, /gmail\.send/);
  const to = [...toLine(sent[0]).matchAll(/<([^>]+)>|([^\s,<]+@[^\s,>]+)/g)].map((m) => m[1] || m[2]);
  assert.match(sent[0], /^From: Jane Doe <jane@soardcharity\.com>/m);
  assert.deepEqual(to.sort(), ['alex@example.com', 'bo.kim@example.org', 'hal@soardcharity.com'], 'never the writer, a former member, an advisor or the group');
  assert.match(sent[0], /^X-SOARD-Board: email-all/m);
  assert.ok(!/^(Cc|Bcc):/m.test(sent[0]), 'nobody copied');
});

test('a sign-in in capitals is the same writer', async () => {
  await go({ me: 'Jane@SoardCharity.com' });
  assert.ok(!toLine(sent[0]).includes(ME));
  assert.equal(tokens[0].sub, ME);
});

test('Send it to me reaches only the writer, marked, and leaves no record', async () => {
  const r = await go({ test: true });
  assert.deepEqual(r, { sent: 1, test: true });
  assert.equal(toLine(sent[0]), `Jane Doe <${ME}>`);
  assert.match(sent[0], /^Subject: \[Test → the whole board\] Thanks|^Subject: =\?UTF-8/m);
  assert.equal((await env.DB.prepare("SELECT COUNT(*) AS n FROM board_state WHERE key LIKE 'email-all%'").first()).n, 0);
});

test('the same words go once, however they arrive: a second tab, a retry, the other admin', async () => {
  await go();
  const again = await go();
  assert.equal(again.already, true);
  assert.equal(again.sent, 3);
  assert.ok(again.at, 'says when it went');
  assert.equal((await go({ message: '  See you soon.\r\n' })).already, true, 'space around the words doesn’t make it new');
  assert.equal((await go({ subject: 'Thanks  ' })).already, true);
  assert.equal((await go({ me: 'hal@soardcharity.com' })).already, true, 'the other admin too');
  assert.equal(sent.length, 1);
});

const minutes = (n) => Date.now() + n * 60 * 1000;
// Pressed once to hear that an earlier note went, and again to send
const twice = async (o) => { await go(o).catch(() => {}); return go(o); };

test('a changed word is a new message', async () => {
  await go();
  await twice({ message: 'See you tomorrow.' });
  await twice({ subject: 'Thanks again' });
  assert.equal(sent.length, 3);
});

test('a second note the same day stops once to say the first went, then goes: the page needn’t have heard', async () => {
  await go();
  await assert.rejects(go({ message: 'See you soon!', now: minutes(1) }), (e) => e.status === 409 && /“Thanks”, reached the board on \w+ at \d+:\d\d [AP]M\. Press Send again only if this one should go too/.test(e.message));
  assert.equal(sent.length, 1, 'the typo fix didn’t go');
  assert.deepEqual(await go({ message: 'See you soon!', now: minutes(1) }), { sent: 3 }, 'the writer’s second press sends it');
  assert.equal(sent.length, 2);
});

test('the stop holds ten minutes on and twenty-three hours on, and lets go after a day', async () => {
  await go();
  await assert.rejects(go({ message: 'Typo fixed', now: minutes(11) }), /“Thanks”, reached the board/);
  await writeState(env.DB, 'x', {});
  const row = await env.DB.prepare("SELECT key, data FROM board_state WHERE key LIKE 'email-all:%'").first();
  await env.DB.prepare('UPDATE board_state SET data = ? WHERE key = ?').bind(JSON.stringify({ ...JSON.parse(row.data), warned: false }), row.key).run();
  await assert.rejects(go({ message: 'Typo fixed', now: minutes(23 * 60) }), /“Thanks”, reached the board/);
  await env.DB.prepare('UPDATE board_state SET data = ? WHERE key = ?').bind(JSON.stringify({ ...JSON.parse(row.data), warned: false }), row.key).run();
  assert.deepEqual(await go({ message: 'Typo fixed', now: minutes(25 * 60) }), { sent: 3 });
});

test('the other admin’s note a minute ago doesn’t stop a different note', async () => {
  await go();
  assert.deepEqual(await go({ me: 'hal@soardcharity.com', message: 'Something else', now: minutes(1) }), { sent: 3 });
});

test('a different note during an unclear hold says this one hasn’t gone, and names the other', async () => {
  answer = () => { throw new DOMException('timed out', 'TimeoutError'); };
  await assert.rejects(go(), /may have gone/);
  answer = () => Response.json({ id: 'm7' });
  await assert.rejects(go({ subject: 'B' }), /“Thanks”, may still be going out, so this one hasn’t been sent/);
  assert.equal(sent.length, 0);
});

test('another message between two tries changes nothing: A, B, A sends A once', async () => {
  await go({ subject: 'A' });
  await twice({ subject: 'B' });
  assert.equal((await go({ subject: 'A' })).already, true);
  assert.equal(sent.length, 2);
});

test('one refused message doesn’t free another: X, Y refused, X sends X once', async () => {
  await go({ subject: 'X' });
  answer = () => Response.json({ error: { message: 'No' } }, { status: 429 });
  await go({ subject: 'Y' }).catch(() => {});
  await assert.rejects(go({ subject: 'Y' }), /Nothing went out/);
  answer = () => Response.json({ id: 'm9' });
  assert.equal((await go({ subject: 'X' })).already, true);
  assert.equal(sent.length, 1);
});

test('a day later the same words can go again, and old records are cleared', async () => {
  const now = Date.now();
  await go({ now });
  assert.equal((await go({ now: now + 23 * 60 * 60 * 1000 })).already, true);
  assert.deepEqual(await go({ now: now + 25 * 60 * 60 * 1000 }), { sent: 3 });
  assert.equal(sent.length, 2);
  await go({ subject: 'Later', now: now + 80 * 60 * 60 * 1000 });
  const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM board_state WHERE key LIKE 'email-all:%'").first();
  assert.equal(left.n, 1, 'only the newest record is left');
});

test('two posts of one message at once send one email', async () => {
  let release;
  const held = new Promise((r) => { release = r; });
  answer = async () => { await held; return Response.json({ id: 'm1' }); };
  const first = go();
  await new Promise((r) => setTimeout(r, 50));
  await assert.rejects(go(), /may still be going out/);
  release();
  await first;
  assert.equal(sent.length, 1);
});

test('Gmail refusing it says why, sends nothing, and can be tried again at once', async () => {
  answer = () => Response.json({ error: { message: 'Daily sending limit exceeded' } }, { status: 429 });
  await assert.rejects(go(), (e) => e.status === 503 && /Daily sending limit exceeded/.test(e.message) && /Nothing went out/.test(e.message));
  answer = () => Response.json({ id: 'm2' });
  assert.deepEqual(await go(), { sent: 3 });
  assert.equal(sent.length, 1);
});

const later = () => Date.now() + 3 * 60 * 1000;
// Gmail takes it, then never says so, or answers with its own trouble
const delivered = (reply) => (init, raw) => { sentBox.push(raw); sent.push(raw); return reply(); };

for (const [name, reply] of [
  ['no answer', () => { throw new DOMException('timed out', 'TimeoutError'); }],
  ['a 502', () => Response.json({ error: { message: 'Bad gateway' } }, { status: 502 })],
  ['a 408', () => Response.json({ error: { message: 'Timeout' } }, { status: 408 })],
]) {
  test(`Gmail delivers it but answers with ${name}: held, then Sent says it went, and nothing goes twice`, async () => {
    answer = delivered(reply);
    await assert.rejects(go(), (e) => /may have gone/.test(e.message) && !/Nothing went out/.test(e.message));
    answer = () => Response.json({ id: 'm3' });
    await assert.rejects(go(), /may still be going out/);
    await assert.rejects(go({ message: ' See you soon. ' }), /may still be going out/, 'a space added and taken off doesn’t get round it');
    const r = await go({ now: later() });
    assert.equal(r.already, true);
    assert.equal(sent.length, 1);
    assert.equal((await go({ now: later() })).already, true, 'and stays known');
    assert.equal(sent.length, 1);
  });
}

test('no answer, and it never reached Sent: the next try after the hold sends it', async () => {
  answer = () => { throw new DOMException('timed out', 'TimeoutError'); };
  await assert.rejects(go(), /may have gone/);
  answer = () => Response.json({ id: 'm3' });
  assert.deepEqual(await go({ now: later() }), { sent: 3 });
  assert.equal(sent.length, 1);
});

test('no answer, and Sent can’t be read: nothing goes, and it says what to do', async () => {
  answer = delivered(() => { throw new DOMException('timed out', 'TimeoutError'); });
  await assert.rejects(go(), /may have gone/);
  readAnswer = () => Response.json({ error: { message: 'Nope' } }, { status: 403 });
  answer = () => Response.json({ id: 'm3' });
  await assert.rejects(go({ now: later() }), (e) => e.status === 409 && /can’t check/.test(e.message) && /change a word/.test(e.message));
  assert.equal(sent.length, 1);
  assert.equal((await go({ message: 'See you very soon.', now: later() })).sent, 3, 'changing a word sends it');
});

test('another writer’s message in Sent isn’t mistaken for this one', async () => {
  await go({ subject: 'Other', now: minutes(-25 * 60) });
  answer = () => { throw new DOMException('timed out', 'TimeoutError'); };
  await assert.rejects(go(), /may have gone/);
  answer = () => Response.json({ id: 'm3' });
  assert.deepEqual(await go({ now: later() }), { sent: 3 });
  assert.equal(sent.length, 2);
});

test('Sent is read in the first writer’s account, whoever tries again', async () => {
  answer = delivered(() => { throw new DOMException('timed out', 'TimeoutError'); });
  await assert.rejects(go(), /may have gone/);
  tokens.length = 0;
  assert.equal((await go({ me: 'hal@soardcharity.com', now: later() })).already, true);
  assert.equal(tokens.find((t) => /gmail\.readonly/.test(t.scope))?.sub, ME);
});

test('the record failing after Gmail took it still says it went, and Sent stops a second copy', async () => {
  const real = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql) => { if (/^UPDATE board_state SET data = \?, updated_at = \? WHERE key = \?$/.test(sql)) throw new Error('D1_ERROR: nope'); return real(sql); };
  assert.deepEqual(await go(), { sent: 3 });
  env.DB.prepare = real;
  assert.equal((await go({ now: later() })).already, true);
  assert.equal(sent.length, 1);
});

test('the other admin during a send is told who’s sending, not to look in their own Sent', async () => {
  let release;
  const held = new Promise((r) => { release = r; });
  answer = async () => { await held; return Response.json({ id: 'm1' }); };
  const first = go();
  await new Promise((r) => setTimeout(r, 50));
  await assert.rejects(go({ me: 'hal@soardcharity.com' }), /jane@soardcharity\.com is sending these same words now/);
  release();
  await first;
});

test('a subject or message of characters that show nothing is empty', async () => {
  await assert.rejects(go({ subject: '​‍ ' }), /subject first/);
  await assert.rejects(go({ message: '﻿⁠' }), /message first/);
  assert.equal(sent.length, 0);
});

test('a subject that looks like encoded words stays as typed', async () => {
  await go({ subject: '=?UTF-8?B?SGVsbG8=?= hi' });
  const b64 = sent[0].match(/^Subject: =\?UTF-8\?B\?([^?]+)/m)?.[1];
  assert.equal(Buffer.from(b64, 'base64').toString(), '=?UTF-8?B?SGVsbG8=?= hi');
});

const lostAnswer = () => { throw new DOMException('timed out', 'TimeoutError'); };
const fine = () => Response.json({ id: 'm5' });

test('a word changed after an unclear send waits for the first to settle: too soon, then Sent says it went, then it’s the writer’s call', async () => {
  answer = delivered(lostAnswer);
  await assert.rejects(go(), /may have gone/);
  answer = fine;
  await assert.rejects(go({ message: 'See you soon!' }), /may still be going out, so this one hasn’t been sent/);
  assert.equal(sent.length, 1);
  await assert.rejects(go({ message: 'See you soon!', now: later() }), /“Thanks”, reached the board on \w+ at [\d:]+ [AP]M\. Press Send again only if this one should go too/);
  assert.equal(sent.length, 1);
  assert.deepEqual(await go({ message: 'See you soon!', now: later() }), { sent: 3 }, 'pressed again, it goes');
  assert.equal(sent.length, 2);
  assert.equal((await go({ now: later() })).already, true, 'the first is known to have gone');
});

test('a word changed after an unclear send that never went: the changed one goes straight on, and the old one is forgotten', async () => {
  answer = lostAnswer;
  await assert.rejects(go(), /may have gone/);
  answer = fine;
  assert.deepEqual(await go({ message: 'See you soon!', now: later() }), { sent: 3 });
  assert.equal(sent.length, 1);
  assert.deepEqual(await twice({ now: minutes(15) }), { sent: 3 }, 'the first words can still go');
});

test('a word changed after an unclear send, with Sent unreadable: said once, then the writer has looked and it goes', async () => {
  answer = delivered(lostAnswer);
  await assert.rejects(go(), /may have gone/);
  readAnswer = () => Response.json({ error: { message: 'Nope' } }, { status: 403 });
  answer = fine;
  await assert.rejects(go({ message: 'See you soon!', now: later() }), /can’t check whether your last note went.*press Send again/);
  assert.equal(sent.length, 1);
  assert.deepEqual(await go({ message: 'See you soon!', now: later() }), { sent: 3 });
});

test('the other admin’s unclear note doesn’t stop a different note', async () => {
  answer = lostAnswer;
  await assert.rejects(go(), /may have gone/);
  answer = fine;
  assert.deepEqual(await go({ me: 'hal@soardcharity.com', message: 'Something else' }), { sent: 3 });
});

test('the same words after someone else’s unclear send name whose Sent folder to look in', async () => {
  answer = lostAnswer;
  await assert.rejects(go(), /may have gone/);
  readAnswer = () => Response.json({ error: { message: 'Nope' } }, { status: 403 });
  await assert.rejects(go({ me: 'hal@soardcharity.com', now: later() }), /Ask jane@soardcharity\.com to look in their Sent folder/);
});

test('Send it to me with no clear answer talks about the test, and holds nothing back', async () => {
  answer = lostAnswer;
  await assert.rejects(go({ test: true }), /the test may have reached you.*Nothing went to the board/);
  answer = fine;
  assert.deepEqual(await go(), { sent: 3 });
});

test('Google refusing the writer says so in words and frees the message', async () => {
  tokenAnswer = () => Response.json({ error: 'unauthorized_client', error_description: 'not allowed' }, { status: 401 });
  await assert.rejects(go(), (e) => e.status === 503 && /won’t let the site send from jane@soardcharity\.com/.test(e.message));
  tokenAnswer = () => Response.json({ access_token: 'g-test', expires_in: 3600 });
  clearTokenCache();
  assert.deepEqual(await go(), { sent: 3 });
});

test('with nobody else to write to, it says so', async () => {
  await env.DB.exec('DELETE FROM reveal_board_emails');
  await writeState(env.DB, 'settings', { admins: [ME] });
  await assert.rejects(go(), (e) => e.status === 409 && /Nobody else/.test(e.message));
  assert.equal(sent.length, 0);
});

test('a name or subject in other alphabets survives', async () => {
  await go({ subject: 'Gracias, José: año nuevo', message: 'Niños ❤' });
  assert.match(sent[0], /^Subject: =\?UTF-8\?B\?/m);
});
