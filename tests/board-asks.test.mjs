/**
 * Report asks (functions/api/_board-asks.js): the schedule, reading a reply (quotes, signatures, auto-replies, files),
 * the email as Gmail takes it, and whole runs against a fake Gmail: asks out from the founder the invites don't come
 * from with the organizer copied, a reply put on the agenda and thanked, the reminder, past due with the chair copied,
 * the chair's review, and the treasurer's line notes. Made-up people only (the repo is public).
 * Run: node --test tests/board-asks.test.mjs
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createD1 } from './lib/d1-shim.mjs';
import { saveMeeting, getMeeting } from '../functions/api/_board.js';
import { clearTokenCache } from '../functions/api/_google-calendar.js';
import {
  easternAt, dueFor, remindAt, chairAt, dueWords, htmlToMd, cutTextQuote, isAutoReply, replyFiles, mimeOf, senderOf, cutSignature, judgeByRules,
  runAsks, maybeRunAsks, saveLineNote, portalExtras, sendersFor, askEmail, chairEmail, postReport, GMAIL_SEND_SCOPE,
  chairApprove, chairNote, askPresenter, judgeChair, asTest, replyWords,
} from '../functions/api/_board-asks.js';

const PEOPLE = [
  ['jane-doe', { name: 'Jane Doe', group: 'team', title: 'Co-Founder/President', role: 'founder' }],
  ['max-doe', { name: 'Max Doe', group: 'team', title: 'Co-Founder/Vice President', role: 'founder' }],
  ['alex-rivera', { name: 'Alex Rivera', group: 'board', title: 'Board Chair' }],
  ['sam-ortiz', { name: 'Sam Ortiz', group: 'board', title: 'Board Treasurer' }],
  ['kim-park', { name: 'Kim Park', group: 'board', title: 'Board Member' }],
];
const EMAILS = [['alex-rivera', 'alex.board@example.com'], ['sam-ortiz', 'sam.board@example.org'], ['kim-park', 'kim.board@example.net']];
const { privateKey: PEM } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
const KEY = JSON.stringify({ type: 'service_account', client_email: 'site@example.iam.gserviceaccount.com', private_key: PEM, token_uri: 'https://oauth2.googleapis.com/token' });

class FakeR2 {
  constructor() { this.map = new Map(); }
  async put(key, bytes, opts) { this.map.set(key, { bytes: new Uint8Array(bytes), type: opts?.httpMetadata?.contentType }); }
  async get(key) { const o = this.map.get(key); return o ? { body: o.bytes, size: o.bytes.length, httpMetadata: { contentType: o.type } } : null; }
  async delete(key) { this.map.delete(key); }
}

// ── A Gmail of one mailbox (the asker's), as the API answers ────────
const b64url = (s) => Buffer.from(s).toString('base64url');
const unb64 = (s) => Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
function parseRaw(raw) {
  const text = unb64(raw);
  const [head, ...rest] = text.split('\r\n\r\n');
  // Folded lines unfolded, encoded words decoded (as a mail program shows them)
  const decoded = (v) => v.replace(/\?=\s+=\?/g, '?==?').replace(/=\?UTF-8\?B\?([^?]*)\?=/g, (_, b) => Buffer.from(b, 'base64').toString('utf8')).trim();
  const headers = head.replace(/\r\n[ \t]+/g, ' ').split('\r\n').map((l) => { const i = l.indexOf(':'); return { name: l.slice(0, i), value: decoded(l.slice(i + 1).trim()) }; });
  const bodyText = rest.join('\r\n\r\n');
  const part = (type) => { const m = new RegExp(`Content-Type: ${type}; charset=UTF-8\\r\\nContent-Transfer-Encoding: base64\\r\\n\\r\\n([\\s\\S]*?)\\r\\n--`).exec(bodyText); return m ? Buffer.from(m[1].replace(/\r\n/g, ''), 'base64').toString('utf8') : ''; };
  return { headers, text: part('text/plain'), html: part('text/html') };
}
function fakeGmail() {
  const g = { messages: new Map(), sent: [], tokens: [], n: 0, scopes: new Set(['https://www.googleapis.com/auth/gmail.readonly', GMAIL_SEND_SCOPE]) };
  g.add = (msg) => { g.messages.set(msg.id, msg); return msg; };
  /** A message arriving in a conversation (a reply), as Gmail keeps it */
  g.reply = (threadId, { from, subject = 'Re: x', html = '', text = '', headers = [], files = [], inReplyTo = '' }) => {
    const id = `in${++g.n}`;
    const parts = [];
    if (text) parts.push({ partId: '0.0', mimeType: 'text/plain', headers: [{ name: 'Content-Type', value: 'text/plain; charset=UTF-8' }], body: { data: b64url(text), size: text.length } });
    if (html) parts.push({ partId: '0.1', mimeType: 'text/html', headers: [{ name: 'Content-Type', value: 'text/html; charset=UTF-8' }], body: { data: b64url(html), size: html.length } });
    const fileParts = files.map((f, i) => ({ partId: String(i + 1), mimeType: f.type, filename: f.name, headers: [{ name: 'Content-Disposition', value: `${f.inline ? 'inline' : 'attachment'}; filename="${f.name}"` }, ...(f.inline ? [{ name: 'Content-ID', value: `<img${i}>` }] : [])], body: { attachmentId: `att${id}_${i}`, size: f.bytes.length } }));
    g.attachments = { ...(g.attachments || {}), ...Object.fromEntries(files.map((f, i) => [`att${id}_${i}`, Buffer.from(f.bytes).toString('base64url')])) };
    return g.add({
      id, threadId, labelIds: ['INBOX'], internalDate: String(g.now()),
      payload: { mimeType: 'multipart/mixed', headers: [{ name: 'From', value: from }, { name: 'Subject', value: subject }, { name: 'Message-ID', value: `<${id}@mail.example>` }, ...(inReplyTo ? [{ name: 'In-Reply-To', value: inReplyTo }] : []), ...headers], parts: [{ partId: '0', mimeType: 'multipart/alternative', headers: [], parts }, ...fileParts] },
    });
  };
  g.fetch = async (input, init = {}) => {
    const url = new URL(String(input));
    if (url.href === 'https://oauth2.googleapis.com/token') {
      const claims = JSON.parse(Buffer.from(new URLSearchParams(init.body).get('assertion').split('.')[1], 'base64url').toString());
      g.tokens.push(claims);
      if (!g.scopes.has(claims.scope)) return Response.json({ error: 'unauthorized_client' }, { status: 401 });
      return Response.json({ access_token: `tok ${claims.sub} ${claims.scope}`, expires_in: 3600 });
    }
    const path = url.pathname.replace('/gmail/v1/users/me', '');
    if (path === '/messages/send' && init.method === 'POST') {
      const { raw, threadId } = JSON.parse(init.body);
      const m = parseRaw(raw);
      // A send Gmail refuses (an address it won't take) or never answers well (a 500)
      const refused = g.refuse?.(m);
      if (refused) return Response.json({ error: { message: `refused (${refused})` } }, { status: refused });
      const id = `out${++g.n}`;
      const msg = g.add({ id, threadId: threadId || `t${id}`, labelIds: ['SENT'], internalDate: String(g.now()), payload: { headers: [...m.headers, { name: 'Message-ID', value: `<${id}@mail.gmail.com>` }] }, text: m.text, html: m.html });
      g.sent.push(msg);
      return Response.json({ id, threadId: msg.threadId });
    }
    let m = /^\/messages\/([^/]+)$/.exec(path);
    if (m && g.messages.has(m[1])) return Response.json(g.messages.get(m[1]));
    m = /^\/threads\/([^/]+)$/.exec(path);
    if (m) return Response.json({ id: m[1], messages: [...g.messages.values()].filter((x) => x.threadId === m[1]) });
    m = /^\/messages\/([^/]+)\/attachments\/([^/]+)$/.exec(path);
    if (m) return Response.json({ data: g.attachments[m[2]] });
    if (path === '/messages') {
      const from = /from:(\S+)/.exec(url.searchParams.get('q') || '')?.[1];
      const list = [...g.messages.values()].filter((x) => !(x.labelIds || []).includes('SENT') && (x.payload.headers.find((h) => h.name === 'From')?.value || '').includes(from));
      return Response.json({ messages: list.map((x) => ({ id: x.id, threadId: x.threadId })) });
    }
    throw new Error(`unexpected fetch ${url.href}`);
  };
  return g;
}
const hdr = (msg, name) => msg.payload.headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || '';

let env;
let gmail;
let clock;
// Tuesday Nov 3 2026, 9:00 AM Eastern (standard time): the meeting is Thursday Nov 5
const NOV3_9AM = Date.parse('2026-11-03T14:00:00Z');

async function meeting(extra = {}) {
  return saveMeeting(env.DB, {
    id: 'm_nov5', date: '2026-11-05', start: '08:00', end: '10:00', shared: false, agendaFrom: { kind: 'typed', name: '', at: '2026-11-02T16:00:00Z' },
    sections: [
      { id: 's_open', title: 'Call to order', items: [{ id: 'i_roll', title: 'Roll Call', presenter: 'Alex' }] },
      { id: 's_rep', title: 'Committee reports', items: [
        { id: 'i_gov', title: 'Governance', presenter: 'Kim' },
        { id: 'i_fin', title: 'Financial', presenter: 'Sam', live: 'cash' },
        { id: 'i_ed', title: 'Executive update', presenter: 'Max' },
      ] },
    ],
    ...extra,
  }, { by: 'jane@soardcharity.com' });
}

beforeEach(async () => {
  clearTokenCache();
  env = { DB: await createD1(), FILES: new FakeR2(), GOOGLE_CALENDAR_KEY: KEY };
  await env.DB.exec('CREATE TABLE team (slug TEXT PRIMARY KEY, name TEXT, "group" TEXT, order_num INTEGER, data TEXT NOT NULL, updated_at TEXT)');
  await env.DB.exec('CREATE TABLE reveal_board_emails (slug TEXT PRIMARY KEY, email TEXT NOT NULL, updated_at TEXT)');
  await env.DB.exec('CREATE TABLE site_config (key TEXT PRIMARY KEY, data TEXT, updated_at TEXT)');
  for (const [slug, d] of PEOPLE) await env.DB.prepare('INSERT INTO team (slug, name, "group", data) VALUES (?, ?, ?, ?)').bind(slug, d.name, d.group, JSON.stringify(d)).run();
  for (const [slug, email] of EMAILS) await env.DB.prepare('INSERT INTO reveal_board_emails (slug, email) VALUES (?, ?)').bind(slug, email).run();
  // Board → Settings: the emails on (test mode has its own tests below)
  await env.DB.exec(`CREATE TABLE IF NOT EXISTS board_state (key TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT)`);
  await env.DB.prepare('INSERT INTO board_state (key, data) VALUES (?, ?)').bind('settings', JSON.stringify({ asks: 'on' })).run();
  gmail = fakeGmail();
  clock = NOV3_9AM;
  gmail.now = () => clock;
});

const run = () => runAsks(env, { fetchImpl: gmail.fetch, now: clock });

// ─── The schedule ───────────────────────────────────────────────────

test('Eastern clock times through daylight saving', () => {
  assert.equal(new Date(easternAt('2026-11-04', '12:00')).toISOString(), '2026-11-04T17:00:00.000Z'); // EST
  assert.equal(new Date(easternAt('2026-10-29', '17:00')).toISOString(), '2026-10-29T21:00:00.000Z'); // EDT
  assert.equal(dueWords(easternAt('2026-11-04', '12:00')), 'Wednesday, November 4 at noon');
  assert.equal(dueWords(easternAt('2026-10-29', '17:00'), { short: true }), 'Thu, Oct 29 at 5 PM');
});

test('due a week before at 5 PM; a meeting nearer than that, noon a day later, never after noon the day before', () => {
  // Two weeks ahead: the week before at 5 PM, a reminder two days before that, the chair the morning after
  const asked = easternAt('2026-11-20', '09:00');
  const due = dueFor('2026-12-04', asked);
  assert.equal(new Date(due).toISOString(), new Date(easternAt('2026-11-27', '17:00')).toISOString());
  assert.equal(remindAt(asked, due), easternAt('2026-11-25', '09:00'));
  assert.equal(chairAt('2026-12-04', [due]), easternAt('2026-11-28', '09:00'));
  // Nov 5 asked Tuesday morning: due Wednesday noon, the reminder Wednesday at 8, the chair just after noon
  const d5 = dueFor('2026-11-05', NOV3_9AM);
  assert.equal(d5, easternAt('2026-11-04', '12:00'));
  assert.equal(remindAt(NOV3_9AM, d5), easternAt('2026-11-04', '08:00'));
  assert.equal(chairAt('2026-11-05', [d5]), d5 + 5 * 60 * 1000);
  // An item added late (nine days ahead) still gets the week-before deadline, at least a day off
  assert.equal(dueFor('2026-12-04', easternAt('2026-11-25', '10:00')), easternAt('2026-11-27', '17:00'));
  // Asked the day before: never after noon that day
  assert.equal(dueFor('2026-11-05', easternAt('2026-11-04', '07:00')), easternAt('2026-11-04', '12:00'));
});

// ─── Reading a reply ────────────────────────────────────────────────

test('a Gmail reply: its own words as Markdown, the quote and the signature block left out', () => {
  const html = '<div dir="ltr"><div>Board,</div><div><br></div><div>Revenue is <b>ahead</b> of last year:</div><ul><li>Store sales <i>down</i> 49%</li><li>Grants on <a href="https://example.com/plan">plan</a></li></ul><div>Thanks,</div><div>Sam</div></div><br><div class="gmail_quote"><div dir="ltr" class="gmail_attr">On Tue, Nov 3, 2026 at 9:00 AM Max Doe &lt;max@soardcharity.com&gt; wrote:<br></div><blockquote class="gmail_quote">Hi Sam, please send…</blockquote></div>';
  const md = htmlToMd(html);
  assert.match(md, /^Board,\n\nRevenue is \*\*ahead\*\* of last year:\n\n- Store sales \*down\* 49%\n- Grants on \[plan\]\(https:\/\/example\.com\/plan\)/);
  assert.doesNotMatch(md, /please send|wrote:/);
  assert.equal(cutSignature(md, 'Thanks,'), md.slice(0, md.indexOf('\n\nThanks,')).trim());
});

test('Outlook and Apple Mail replies, and plain text from phones', () => {
  const outlook = '<html><body><p class="MsoNormal">Nothing new from Governance this quarter.<o:p></o:p></p><p class="MsoNormal">&nbsp;</p><div id="appendonsend"></div><hr><div id="divRplyFwdMsg"><b>From:</b> Max Doe</div></body></html>';
  assert.equal(htmlToMd(outlook), 'Nothing new from Governance this quarter.');
  const apple = '<div>Report attached.</div><div><br><blockquote type="cite"><div>On Nov 3, 2026, at 9:00 AM, Max Doe wrote:</div>Hi</blockquote></div>';
  assert.equal(htmlToMd(apple), 'Report attached.');
  assert.equal(cutTextQuote('All good on our side.\n\nSent from my iPhone\n\n> On Nov 3, 2026, at 9:00 AM, Max Doe <max@soardcharity.com> wrote:\n> Hi'), 'All good on our side.');
  assert.equal(cutTextQuote('Two points:\n- one\n- two\n\nOn Tue, Nov 3, 2026 at 9:00 AM Max Doe <\nmax@soardcharity.com> wrote:\n\n> Hi'), 'Two points:\n- one\n- two');
  assert.equal(cutTextQuote('See below.\n\n________________________________\nFrom: Max Doe\nSent: Tuesday'), 'See below.');
  assert.equal(cutTextQuote('Short one.\n-- \nSam Ortiz, CPA\n555-0100'), 'Short one.');
});

test('automatic replies are known by their headers or subject', () => {
  assert.equal(isAutoReply([{ name: 'Auto-Submitted', value: 'auto-replied' }]), true);
  assert.equal(isAutoReply([{ name: 'Auto-Submitted', value: 'no' }, { name: 'Subject', value: 'Re: your report' }]), false);
  assert.equal(isAutoReply([{ name: 'Subject', value: 'Automatic reply: Q4 2026 Board Meeting: your Financial report' }]), true);
  assert.equal(isAutoReply([{ name: 'Subject', value: 'Out of Office' }]), true);
  assert.equal(isAutoReply([{ name: 'Precedence', value: 'bulk' }]), true);
});

test("a reply's files: documents and real pictures, never a signature's logo or a calendar card", () => {
  const part = (filename, mimeType, size, inline = false) => ({ partId: filename, filename, mimeType, headers: [{ name: 'Content-Disposition', value: inline ? 'inline' : 'attachment' }, ...(inline ? [{ name: 'Content-ID', value: '<x>' }] : [])], body: { attachmentId: 'a', size } });
  const files = replyFiles({ parts: [part('Q4.pdf', 'application/pdf', 90000), part('logo.png', 'image/png', 6000, true), part('photo.jpg', 'image/jpeg', 400000), part('invite.ics', 'text/calendar', 900), part('tiny.png', 'image/png', 3000), part('budget.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 20000)] });
  assert.deepEqual(files.map((f) => f.name), ['Q4.pdf', 'photo.jpg', 'budget.xlsx']);
});

test('the rules, when the model can’t answer', () => {
  assert.equal(judgeByRules('Thanks!'), 'other');
  assert.equal(judgeByRules('I’ll send it Friday.'), 'other');
  assert.equal(judgeByRules('No changes this quarter.'), 'report');
  assert.equal(judgeByRules('- one\n- two'), 'report');
  assert.equal(judgeByRules('See attached.', [{ name: 'a.pdf' }]), 'report');
  assert.equal(senderOf('"Sam Ortiz" <Sam.Board@Example.org>').email, 'sam.board@example.org');
});

test('the email as Gmail takes it: names encoded, both parts, a reply naming what it answers', () => {
  const raw = mimeOf({ from: { name: 'Max Doe', email: 'max@soardcharity.com' }, to: [{ name: 'José Ortiz', email: 'j@example.org' }], cc: [{ name: 'Jane Doe', email: 'jane@soardcharity.com' }], subject: 'Hi', text: 'Thanks — Max', html: '<p>Thanks</p>', inReplyTo: '<a@x>', references: '<z@x>' });
  const m = parseRaw(raw);
  const h = (n) => m.headers.find((x) => x.name === n)?.value;
  assert.equal(h('From'), 'Max Doe <max@soardcharity.com>');
  assert.equal(h('To'), 'José Ortiz <j@example.org>');
  const long = mimeOf({ from: { email: 'a@x' }, to: [{ email: 'b@x' }], subject: '[Test → Sam Ortiz, Alex Rivera & Jane Doe copied] Re: Q4 2026 Board Meeting: your Financial report, due Wed, Nov 4 at noon', text: 't', html: 'h' });
  const longRaw = Buffer.from(long, 'base64url').toString();
  assert.ok(longRaw.match(/=\?UTF-8\?B\?[^?]*\?=/g).every((w) => w.length <= 75));
  assert.equal(parseRaw(long).headers.find((x) => x.name === 'Subject').value, '[Test → Sam Ortiz, Alex Rivera & Jane Doe copied] Re: Q4 2026 Board Meeting: your Financial report, due Wed, Nov 4 at noon');
  assert.equal(h('Cc'), 'Jane Doe <jane@soardcharity.com>');
  assert.equal(h('References'), '<z@x> <a@x>');
  assert.equal(m.text, 'Thanks — Max');
});

// ─── Whole runs ─────────────────────────────────────────────────────

test('from the founder the invites don’t come from, the organizer copied', async () => {
  const s = await sendersFor(env.DB);
  assert.deepEqual([s.from.email, s.from.name, s.cc.map((c) => c.email)], ['max@soardcharity.com', 'Max Doe', ['jane@soardcharity.com']]);
});

test('asks go to each board member presenting, never staff, once, due Wednesday noon; the money’s points to the review', async () => {
  await meeting();
  const did = await run();
  assert.equal(did.asked, 2);
  const to = gmail.sent.map((m) => hdr(m, 'To'));
  assert.deepEqual(to.sort(), ['Kim Park <kim.board@example.net>', 'Sam Ortiz <sam.board@example.org>']);
  for (const m of gmail.sent) {
    assert.equal(hdr(m, 'From'), 'Max Doe <max@soardcharity.com>');
    assert.equal(hdr(m, 'Cc'), 'Jane Doe <jane@soardcharity.com>');
  }
  const fin = gmail.sent.find((m) => hdr(m, 'To').startsWith('Sam'));
  assert.equal(hdr(fin, 'Subject'), 'Q4 2026 Board Meeting: your Financial report, due Wed, Nov 4 at noon');
  assert.match(fin.text, /Please send your Financial report by Wednesday, November 4 at noon\./);
  assert.match(fin.text, /note any line for the board:\nhttps:\/\/sunshineonaranneyday\.com\/admin\/board\/#\/meetings\/m_nov5\/report\/i_fin/);
  assert.doesNotMatch(fin.text + fin.html, /—/);
  // The roll call is no report; the chair isn't asked for it. A second run sends nothing again
  assert.equal((await run()).asked, 0);
  assert.equal(gmail.sent.length, 2);
});

test('nothing while the agenda is a draft, outside 8 to 7 Eastern, or further out than two weeks', async () => {
  await meeting({ agendaFrom: { kind: 'last-meeting', name: 'x', at: '2026-11-01T00:00:00Z' } });
  assert.equal((await run()).asked, 0);
  await meeting();
  clock = Date.parse('2026-11-03T03:00:00Z'); // 10 PM Monday Eastern
  assert.equal((await run()).asked, 0);
  await meeting({ date: '2026-11-30' });
  clock = NOV3_9AM;
  assert.equal((await run()).asked, 0);
});

test('a reply becomes the report word for word, its PDF goes with the item, and they’re thanked alone', async () => {
  await meeting();
  await run();
  const ask = gmail.sent.find((m) => hdr(m, 'To').startsWith('Sam'));
  env.AI = { run: async () => ({ response: { kind: 'report', signature: 'Thanks,' } }) };
  clock += 60 * 60 * 1000;
  gmail.reply(ask.threadId, {
    from: 'Sam Ortiz <sam.board@example.org>', subject: `Re: ${hdr(ask, 'Subject')}`, inReplyTo: hdr(ask, 'Message-ID'),
    html: '<div>Cash is <b>steady</b>.</div><ul><li>Store down 49%</li></ul><div>Thanks,</div><div>Sam</div><div class="gmail_quote">On Tue … wrote:</div>',
    files: [{ name: 'Q4 notes.pdf', type: 'application/pdf', bytes: Buffer.from('%PDF-1.4\n% made up\n') }, { name: 'logo.png', type: 'image/png', bytes: Buffer.alloc(4000), inline: true }],
  });
  const did = await run();
  assert.deepEqual([did.replies, did.reports], [1, 1]);
  const m = await getMeeting(env.DB, 'm_nov5');
  const it = m.sections[1].items.find((x) => x.id === 'i_fin');
  assert.equal(it.report, 'Cash is **steady**.\n\n- Store down 49%');
  assert.equal(it.reportBy, 'Sam Ortiz');
  assert.equal(m.files.filter((f) => it.docs.includes(f.id)).map((f) => f.name).join(), 'Q4 notes.pdf');
  const thanks = gmail.sent.at(-1);
  assert.equal(hdr(thanks, 'To'), 'Sam Ortiz <sam.board@example.org>');
  assert.equal(hdr(thanks, 'Cc'), '');
  assert.equal(thanks.threadId, ask.threadId);
  assert.match(thanks.text, /^Thanks, Sam\. Your Financial report is on the agenda/);
  // Read once: the next run takes nothing more
  assert.equal((await run()).reports, 0);
  // A second reply goes under the first, never over it
  gmail.reply(ask.threadId, { from: 'Sam Ortiz <sam.board@example.org>', text: 'One more: the audit starts in January.' });
  await run();
  const again = (await getMeeting(env.DB, 'm_nov5')).sections[1].items.find((x) => x.id === 'i_fin');
  assert.match(again.report, /^Cash is \*\*steady\*\*\.\n\n- Store down 49%\n\n### Added Tue, Nov 3\n\nOne more: the audit starts in January\.$/);
});

test('an out-of-office, a "Friday" promise and a stranger stay in the inbox; nothing goes on the agenda', async () => {
  await meeting();
  await run();
  const ask = gmail.sent.find((m) => hdr(m, 'To').startsWith('Kim'));
  env.AI = { run: async () => ({ response: { kind: 'other', signature: '' } }) };
  gmail.reply(ask.threadId, { from: 'Kim Park <kim.board@example.net>', subject: 'Automatic reply: away', text: 'I am out of the office.', headers: [{ name: 'Auto-Submitted', value: 'auto-replied' }] });
  gmail.reply(ask.threadId, { from: 'Kim Park <kim.board@example.net>', text: 'I’ll send it Friday.' });
  gmail.reply(ask.threadId, { from: 'Someone Else <else@example.com>', text: 'Here is a long report from someone who isn’t presenting this item at all, with many words in it to look like a report.' });
  const before = gmail.sent.length;
  const did = await run();
  assert.equal(did.reports, 0);
  assert.equal(gmail.sent.length, before);
  assert.equal((await getMeeting(env.DB, 'm_nov5')).sections[1].items.find((x) => x.id === 'i_gov').report, '');
  const kinds = (await env.DB.prepare('SELECT outcome FROM board_ask_mail ORDER BY outcome').all()).results.map((r) => r.outcome);
  assert.deepEqual(kinds, ['auto', 'other', 'stranger']);
});

test('a reply with a subject of its own still counts: it names the ask in In-Reply-To', async () => {
  await meeting();
  await run();
  const ask = gmail.sent.find((m) => hdr(m, 'To').startsWith('Kim'));
  gmail.reply('t_other', { from: 'Kim Park <kim.board@example.net>', subject: 'Governance update', inReplyTo: hdr(ask, 'Message-ID'), text: 'No changes to the bylaws this quarter. The nominating committee meets November 12.' });
  assert.equal((await run()).reports, 1);
  assert.match((await getMeeting(env.DB, 'm_nov5')).sections[1].items.find((x) => x.id === 'i_gov').report, /^No changes to the bylaws/);
});

test('the reminder that morning, past due at noon with the chair copied, then the chair’s review of the whole agenda', async () => {
  await meeting();
  await run();
  // Kim's report comes in on the board page; Sam's doesn't
  await postReport(env.DB, { meetingId: 'm_nov5', itemId: 'i_gov', words: 'All good.', name: 'Kim Park' });
  clock = easternAt('2026-11-04', '08:00');
  let did = await run();
  assert.equal(did.reminded, 1);
  const reminder = gmail.sent.at(-1);
  assert.equal(hdr(reminder, 'To'), 'Sam Ortiz <sam.board@example.org>');
  assert.match(hdr(reminder, 'Subject'), /^Re: Q4 2026 Board Meeting: your Financial report/);
  assert.match(reminder.text, /is due today at noon\./);
  clock = easternAt('2026-11-04', '12:01');
  did = await run();
  assert.equal(did.late, 1);
  const late = gmail.sent.find((m) => /hasn’t come in/.test(m.text));
  assert.equal(hdr(late, 'Cc'), 'Alex Rivera <alex.board@example.com>, Jane Doe <jane@soardcharity.com>');
  assert.match(late.text, /was due today at noon and hasn’t come in\. .* I’ve copied Alex/);
  assert.equal(did.chair, 0); // not until five minutes after the last due
  clock = easternAt('2026-11-04', '12:06');
  did = await run();
  assert.equal(did.chair, 1);
  const review = gmail.sent.at(-1);
  assert.equal(hdr(review, 'To'), 'Alex Rivera <alex.board@example.com>');
  assert.equal(hdr(review, 'Subject'), 'Agenda for your review: Q4 2026 Board Meeting, Thu, Nov 5');
  assert.match(review.text, /Reports: 1 of 2 in\. Late: Sam Ortiz \(Financial\)\./);
  assert.match(review.text, /8:00  Call to order \(\d+ min\)\n {4}Roll Call · Alex Rivera/);
  assert.match(review.text, /Governance · Kim Park · report in/);
  assert.match(review.text, /Financial · Sam Ortiz · report late \(was due Wed, Nov 4 at noon\)/);
  // Once each
  did = await run();
  assert.deepEqual([did.reminded, did.late, did.chair], [0, 0, 0]);
});

test('without gmail.send nothing is claimed, and the run says why', async () => {
  await meeting();
  gmail.scopes.delete(GMAIL_SEND_SCOPE);
  await maybeRunAsks(env, { fetchImpl: gmail.fetch, now: clock, force: true });
  assert.equal(gmail.sent.length, 0);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM board_asks').first()).n, 0);
  const state = await env.DB.prepare("SELECT data FROM board_state WHERE key = 'asks'").first();
  assert.match(JSON.parse(state.data).error, /unauthorized_client/);
});

// ─── The board page ─────────────────────────────────────────────────

test('the presenter sees a meeting ahead before it’s shared (their items only), notes their lines, and no one else can', async () => {
  await meeting();
  await run();
  const sam = { slug: 'sam-ortiz', name: 'Sam Ortiz', email: 'sam.board@example.org' };
  const kim = { slug: 'kim-park', name: 'Kim Park', email: 'kim.board@example.net' };
  const { listMeetings } = await import('../functions/api/_board.js');
  const meetings = await listMeetings(env.DB);
  const x = await portalExtras(env, { member: sam, meetings, today: '2026-11-03' });
  assert.deepEqual(x.presenting.map((m) => m.sections.flatMap((s) => s.items.map((it) => it.title))), [['Financial']]);
  assert.deepEqual(x.myAsks.map((a) => [a.itemId, a.status, a.due]), [['i_fin', 'asked', new Date(easternAt('2026-11-04', '12:00')).toISOString()]]);
  const saved = await saveLineNote(env, { meetingId: 'm_nov5', itemId: 'i_fin', key: 'act|Income/Store Income', line: 'Store Income', text: 'Partly Sunny closed in March.' }, { member: sam });
  assert.deepEqual(saved.notes.map((n) => [n.key, n.text, n.by]), [['act|Income/Store Income', 'Partly Sunny closed in March.', 'Sam Ortiz']]);
  await assert.rejects(saveLineNote(env, { meetingId: 'm_nov5', itemId: 'i_fin', key: 'act|Income/Store Income', text: 'mine now' }, { member: kim }), /Only the person presenting/);
  await assert.rejects(saveLineNote(env, { meetingId: 'm_nov5', itemId: 'i_fin', key: 'nope', text: 'x' }, { member: sam }), /Which line/);
  // Kim sees no notes on a meeting she can't see; the board sees them once it's shared
  assert.deepEqual((await portalExtras(env, { member: kim, meetings, today: '2026-11-03' })).lineNotes, {});
  const cleared = await saveLineNote(env, { meetingId: 'm_nov5', itemId: 'i_fin', key: 'act|Income/Store Income', text: '' }, { member: sam });
  assert.deepEqual(cleared.notes, []);
});

test('the ask and the chair’s review read right without the books or a shared meeting', async () => {
  const m = await meeting();
  const it = m.sections[1].items[1];
  const mail = askEmail({ m, it, person: { name: 'Sam Ortiz' }, due: easternAt('2026-11-04', '12:00'), from: { name: 'Max Doe' }, books: { statements: { asOf: '2026-10-31' } } });
  assert.match(mail.text, /beside last year’s, as of October 31, with a place/);
  assert.match(mail.text, /\n\nThanks,\nMax$/);
  const review = chairEmail({ m, chair: { name: 'Alex Rivera' }, from: { name: 'Max Doe' }, asks: [], people: [] });
  assert.doesNotMatch(review.text, /Reports:|board page/);
});

// ─── The chair ──────────────────────────────────────────────────────

const ALEX = { slug: 'alex-rivera', name: 'Alex Rivera', email: 'alex.board@example.com', seat: 'chair' };
const SAM = { slug: 'sam-ortiz', name: 'Sam Ortiz', email: 'sam.board@example.org', seat: 'treasurer' };
const opts = () => ({ fetchImpl: gmail.fetch, now: clock });

test('the chair’s review email links the review page and says where a reply goes', async () => {
  await meeting();
  await run();
  clock = easternAt('2026-11-04', '12:06');
  await run();
  const review = gmail.sent.find((m) => hdr(m, 'Subject').startsWith('Agenda for your review'));
  assert.match(review.text, /send a report back to its presenter with a question\. Their answer goes on the agenda under the report\.\nhttps:\/\/sunshineonaranneyday\.com\/admin\/board\/#\/meetings\/m_nov5\/review/);
  assert.match(review.text, /For anything else, or if it all looks good, just reply\. It comes to me and Jane\./);
});

test('the chair approves on the page: kept, and said in the review’s conversation; no one else can', async () => {
  await meeting();
  await run();
  clock = easternAt('2026-11-04', '12:06');
  await run();
  const thread = gmail.sent.at(-1).threadId;
  await assert.rejects(chairApprove(env, { meetingId: 'm_nov5' }, { member: SAM }, opts()), /Only the board chair/);
  const r = await chairApprove(env, { meetingId: 'm_nov5' }, { member: ALEX }, opts());
  assert.equal(r.approvedBy, 'Alex Rivera');
  const note = gmail.sent.at(-1);
  assert.equal(note.threadId, thread);
  assert.equal(hdr(note, 'To'), 'Alex Rivera <alex.board@example.com>');
  assert.equal(hdr(note, 'Cc'), 'Jane Doe <jane@soardcharity.com>');
  assert.match(note.text, /^Thanks, Alex\. The agenda for the Q4 2026 Board Meeting on Thursday, November 5 is approved\./);
  const { listMeetings } = await import('../functions/api/_board.js');
  const x = await portalExtras(env, { member: ALEX, meetings: await listMeetings(env.DB), today: '2026-11-04' });
  assert.equal(x.review.approvedBy, 'Alex Rivera');
  assert.equal(x.review.meeting.sections.flatMap((s) => s.items).length, 4);
  assert.equal((await portalExtras(env, { member: SAM, meetings: await listMeetings(env.DB), today: '2026-11-04' })).review, null);
});

test('approved before the review went: the founder copied hears it, and no review email follows', async () => {
  await meeting();
  await chairApprove(env, { meetingId: 'm_nov5' }, { member: ALEX }, opts());
  const told = gmail.sent.at(-1);
  assert.equal(hdr(told, 'To'), 'Jane Doe <jane@soardcharity.com>');
  assert.equal(hdr(told, 'Subject'), 'Alex Rivera approved the agenda: Q4 2026 Board Meeting, Thu, Nov 5');
  clock = easternAt('2026-11-04', '12:06');
  await run();
  assert.equal(gmail.sent.filter((m) => hdr(m, 'Subject').startsWith('Agenda for your review')).length, 0);
});

test('a "looks good" reply approves; a change request waits for the founders', async () => {
  assert.equal(await judgeChair({}, 'Looks good!'), 'approve');
  assert.equal(await judgeChair({}, 'Looks good, but move the store before the financials and add the audit.'), 'changes');
  await meeting();
  await run();
  clock = easternAt('2026-11-04', '12:06');
  await run();
  const review = gmail.sent.at(-1);
  gmail.reply(review.threadId, { from: 'Alex Rivera <alex.board@example.com>', text: 'Looks good!\n\nOn Wed, Nov 4 … wrote:\n> Hi' });
  clock += 10 * 60 * 1000;
  await run();
  const row = await env.DB.prepare("SELECT status FROM board_asks WHERE kind = 'chair'").first();
  assert.equal(row.status, 'approved');
});

test('the chair’s own notes: theirs and the admins’ only', async () => {
  await meeting();
  const r = await chairNote(env, { meetingId: 'm_nov5', itemId: 'i_fin', text: 'Ask Sam about the store.' }, { member: ALEX });
  assert.deepEqual(Object.keys(r.notes), ['i_fin']);
  await assert.rejects(chairNote(env, { meetingId: 'm_nov5', itemId: 'i_fin', text: 'x' }, { member: SAM }), /Only the board chair/);
  const { listMeetings } = await import('../functions/api/_board.js');
  const meetings = await listMeetings(env.DB);
  assert.equal((await portalExtras(env, { admin: true, meetings, today: '2026-11-03' })).review.notes.i_fin.text, 'Ask Sam about the store.');
  assert.equal((await chairNote(env, { meetingId: 'm_nov5', itemId: 'i_fin', text: '' }, { member: ALEX })).notes.i_fin, undefined);
});

test('a report sent back with a question: to its presenter in their conversation, the answer under the report', async () => {
  await meeting();
  await run();
  const ask = gmail.sent.find((m) => hdr(m, 'To').startsWith('Sam'));
  await postReport(env.DB, { meetingId: 'm_nov5', itemId: 'i_fin', words: 'Cash is steady.', name: 'Sam Ortiz' });
  await assert.rejects(askPresenter(env, { meetingId: 'm_nov5', itemId: 'i_fin', question: 'Why?' }, { member: SAM }, opts()), /Only the board chair/);
  await assert.rejects(askPresenter(env, { meetingId: 'm_nov5', itemId: 'i_ed', question: 'Why?' }, { member: ALEX }, opts()), /no one to send it to/);
  const r = await askPresenter(env, { meetingId: 'm_nov5', itemId: 'i_fin', question: 'How much of the store drop is the closed shop?' }, { member: ALEX }, opts());
  assert.equal(r.questions[0].to, 'Sam Ortiz');
  const q = gmail.sent.at(-1);
  assert.equal(q.threadId, ask.threadId);
  assert.equal(hdr(q, 'To'), 'Sam Ortiz <sam.board@example.org>');
  assert.equal(hdr(q, 'Cc'), 'Alex Rivera <alex.board@example.com>, Jane Doe <jane@soardcharity.com>');
  assert.match(q.text, /^Hi Sam,\n\nAlex has a question about your Financial report for Thursday’s meeting:\n\n“How much of the store drop is the closed shop\?”/);
  env.AI = { run: async () => ({ response: { kind: 'report', signature: '' } }) };
  clock += 30 * 60 * 1000;
  gmail.reply(ask.threadId, { from: 'Sam Ortiz <sam.board@example.org>', text: 'About $300K of it.' });
  const did = await run();
  assert.equal(did.reports, 1);
  const it = (await getMeeting(env.DB, 'm_nov5')).sections[1].items.find((x) => x.id === 'i_fin');
  assert.equal(it.report, 'Cash is steady.\n\n### Answer to Alex Rivera’s question\n\n> How much of the store drop is the closed shop?\n\nAbout $300K of it.');
  const thanks = gmail.sent.at(-1);
  assert.equal(hdr(thanks, 'Cc'), 'Alex Rivera <alex.board@example.com>');
  assert.match(thanks.text, /^Thanks, Sam\. Your answer is on the agenda under your Financial report/);
  const { listMeetings } = await import('../functions/api/_board.js');
  assert.ok((await portalExtras(env, { member: ALEX, meetings: await listMeetings(env.DB), today: '2026-11-03' })).review.questions[0].answeredAt);
});

// ─── Test mode, until Board → Settings says On ──────────────────────

const setMode = (mode) => env.DB.prepare("UPDATE board_state SET data = ? WHERE key = 'settings'").bind(JSON.stringify({ asks: mode })).run();

test('test mode: every email once, to the asker alone, its subject saying who it would go to; nothing asked for real', async () => {
  await setMode('test');
  await meeting({ live: { startedAt: '2026-10-30T01:04:42Z', endedAt: '2026-10-30T01:41:02Z' } }); // a practice run left on it
  const did = await run();
  assert.equal(did.tests, 8);
  assert.ok(gmail.sent.every((m) => hdr(m, 'To') === 'Max Doe <max@soardcharity.com>' && !hdr(m, 'Cc')));
  const subjects = gmail.sent.map((m) => hdr(m, 'Subject'));
  assert.deepEqual(subjects, [
    '[Test → Sam Ortiz, Jane Doe copied] Q4 2026 Board Meeting: your Financial report, due Wed, Nov 4 at noon',
    '[Test → Kim Park, Jane Doe copied] Q4 2026 Board Meeting: your Governance report, due Wed, Nov 4 at noon',
    '[Test → Sam Ortiz, Jane Doe copied] Re: Q4 2026 Board Meeting: your Financial report, due Wed, Nov 4 at noon',
    '[Test → Sam Ortiz, Alex Rivera & Jane Doe copied] Re: Q4 2026 Board Meeting: your Financial report, due Wed, Nov 4 at noon',
    '[Test → Sam Ortiz] Re: Q4 2026 Board Meeting: your Financial report, due Wed, Nov 4 at noon',
    '[Test → Alex Rivera, Jane Doe copied] Agenda for your review: Q4 2026 Board Meeting, Thu, Nov 5',
    '[Test → Sam Ortiz, Alex Rivera & Jane Doe copied] Re: Q4 2026 Board Meeting: your Financial report, due Wed, Nov 4 at noon',
    '[Test → Alex Rivera, Jane Doe copied] Re: Agenda for your review: Q4 2026 Board Meeting, Thu, Nov 5',
  ]);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM board_asks').first()).n, 0);
  // Once for the meeting
  assert.equal((await run()).tests, undefined);
  assert.equal(gmail.sent.length, 8);
  // Switched on: the real asks go, to the board
  await setMode('on');
  await meeting();
  assert.equal((await run()).asked, 2);
  assert.equal(hdr(gmail.sent.at(-1), 'Cc'), 'Jane Doe <jane@soardcharity.com>');
});

test('off: nothing at all, and the chair’s question says so', async () => {
  await setMode('off');
  await meeting();
  await run();
  assert.equal(gmail.sent.length, 0);
  await assert.rejects(askPresenter(env, { meetingId: 'm_nov5', itemId: 'i_fin', question: 'Why?' }, { member: ALEX }, opts()), /off in Board → Settings/);
});

test('the chair sees the review page once the emails are on; the admins always', async () => {
  await setMode('test');
  await meeting();
  const { listMeetings } = await import('../functions/api/_board.js');
  const meetings = await listMeetings(env.DB);
  assert.equal((await portalExtras(env, { member: ALEX, meetings, today: '2026-11-03' })).review, null);
  assert.ok((await portalExtras(env, { admin: true, meetings, today: '2026-11-03' })).review);
  assert.equal(asTest({ to: [{ name: 'A' }], cc: [], subject: 'S' }, { email: 'me@x' }).subject, '[Test → A] S');
});

test('a question on a report no ask went out for: its own conversation, never counted as a report asked for', async () => {
  await meeting();
  await postReport(env.DB, { meetingId: 'm_nov5', itemId: 'i_fin', words: 'Written on the board page.', name: 'Sam Ortiz' });
  await askPresenter(env, { meetingId: 'm_nov5', itemId: 'i_fin', question: 'And the CD?' }, { member: ALEX }, opts());
  const q = gmail.sent.at(-1);
  assert.equal(hdr(q, 'Subject'), 'Q4 2026 Board Meeting: a question about your Financial report');
  const { listMeetings } = await import('../functions/api/_board.js');
  const x = await portalExtras(env, { member: SAM, meetings: await listMeetings(env.DB), today: '2026-11-03' });
  assert.deepEqual(x.myAsks, []);
  const r = await portalExtras(env, { admin: true, meetings: await listMeetings(env.DB), today: '2026-11-03' });
  assert.deepEqual(r.review.reports, []);
  env.AI = { run: async () => ({ response: { kind: 'report', signature: '' } }) };
  clock += 20 * 60 * 1000;
  gmail.reply(q.threadId, { from: 'Sam Ortiz <sam.board@example.org>', text: 'The CD renews in March.' });
  assert.equal((await run()).reports, 1);
  assert.match((await getMeeting(env.DB, 'm_nov5')).sections[1].items.find((x) => x.id === 'i_fin').report, /### Answer to Alex Rivera’s question\n\n> And the CD\?\n\nThe CD renews in March\.$/);
  assert.equal((await env.DB.prepare("SELECT status FROM board_asks WHERE item_id = 'i_fin'").first()).status, 'question');
});

// ─── What the review found, each proved and now fixed ───────────────

const rows = () => env.DB.prepare('SELECT kind, item_id, slug, status, due, error FROM board_asks ORDER BY kind, item_id').all().then((r) => r.results);

test('a question before any ask (or on an item never asked for) never stops a run, and the ask still goes with its due', async () => {
  await meeting();
  clock = Date.parse('2026-11-03T02:00:00Z'); // 9 PM Monday: no emails out yet
  await askPresenter(env, { meetingId: 'm_nov5', itemId: 'i_gov', question: 'Is the bylaw change ready?' }, { member: ALEX }, opts());
  clock = NOV3_9AM;
  const did = await run();
  assert.equal(did.asked, 2);
  assert.equal(did.errors, undefined);
  assert.ok((await rows()).some((r) => r.kind === 'report' && r.item_id === 'i_gov' && r.status === 'asked' && r.due));
  clock = easternAt('2026-11-04', '08:00');
  assert.equal((await run()).reminded, 2);
});

test('test mode: trying Approve and a question leaves nothing behind; once On, the asks and the chair’s review all go', async () => {
  await setMode('test');
  await meeting();
  const admin = { admin: true, adminEmail: 'max@soardcharity.com' };
  const ok = await chairApprove(env, { meetingId: 'm_nov5' }, admin, opts());
  assert.equal(ok.test, true);
  await askPresenter(env, { meetingId: 'm_nov5', itemId: 'i_fin', question: 'Trying the button' }, admin, opts());
  assert.ok(gmail.sent.every((m) => hdr(m, 'To') === 'Max Doe <max@soardcharity.com>'));
  assert.deepEqual(await rows(), []);
  assert.equal((await env.DB.prepare('SELECT COUNT(*) AS n FROM board_ask_questions').first()).n, 0);
  await setMode('on');
  assert.equal((await run()).asked, 2);
  clock = easternAt('2026-11-04', '12:06');
  assert.equal((await run()).chair, 1);
});

test('one address Gmail refuses: the others are still asked, it’s kept as failed and never retried; an unclear failure isn’t resent', async () => {
  await meeting();
  const to = (m) => m.headers.find((h) => h.name === 'To')?.value || '';
  gmail.refuse = (m) => (/kim\.board/.test(to(m)) ? 400 : /sam\.board/.test(to(m)) ? 500 : 0);
  const did = await run();
  assert.equal(did.asked, 0);
  const r = (await rows()).filter((x) => x.kind === 'report');
  assert.deepEqual(r.map((x) => [x.slug, x.status]).sort(), [['kim-park', 'failed'], ['sam-ortiz', 'unknown']]);
  assert.match(r.find((x) => x.slug === 'kim-park').error, /refused \(400\)/);
  gmail.refuse = null;
  // Only the chair's review went (no ask out to wait for); the next run sends neither ask again
  const after = gmail.sent.length;
  clock += 10 * 60 * 1000;
  await run();
  assert.equal(gmail.sent.length, after, 'neither is sent again by itself');
  // The chair's review still goes, and it never counts an ask that didn't go out as due
  const review = gmail.sent.find((m) => /Agenda for your review/.test(hdr(m, 'Subject')));
  assert.ok(review);
  assert.doesNotMatch(review.text, /Reports:|report due/);
});

test('the meeting moves: each presenter hears the new due, and the old one never says "was due"', async () => {
  await meeting();
  await run();
  await meeting({ date: '2026-11-12' });
  clock = NOV3_9AM + 60 * 60 * 1000;
  await run();
  const moved = gmail.sent.filter((m) => /is now Thursday, November 12/.test(m.text));
  assert.equal(moved.length, 2);
  assert.match(moved[0].text, /is due Thursday, November 5 at 5 PM\./);
  clock = easternAt('2026-11-04', '12:01');
  assert.equal((await run()).late, 0);
  clock = easternAt('2026-11-05', '17:01');
  assert.equal((await run()).late, 2);
});

test('a presenter dropped for a moment is asked again when they’re back, and their reply goes on', async () => {
  await meeting();
  await run();
  const kimAsk = gmail.sent.find((m) => hdr(m, 'To').startsWith('Kim'));
  await meeting({ sections: [{ id: 's_rep', title: 'Committee reports', items: [{ id: 'i_gov', title: 'Governance', presenter: 'K' }, { id: 'i_fin', title: 'Financial', presenter: 'Sam', live: 'cash' }] }] });
  await run();
  assert.equal((await rows()).find((x) => x.slug === 'kim-park').status, 'dropped');
  await meeting();
  await run();
  assert.equal((await rows()).find((x) => x.slug === 'kim-park').status, 'asked');
  env.AI = { run: async () => ({ response: { kind: 'report', signature: '' } }) };
  gmail.reply(kimAsk.threadId, { from: 'Kim Park <kim.board@example.net>', text: 'No changes to the bylaws this quarter.' });
  clock += 10 * 60 * 1000;
  assert.equal((await run()).reports, 1);
});

test('a practice run that ended before the meeting’s day doesn’t make it held: On still asks for it', async () => {
  await meeting({ live: { startedAt: '2026-10-30T01:04:42Z', endedAt: '2026-10-30T01:41:02Z' } });
  assert.equal((await run()).asked, 2);
});

test('a board-only item’s title never goes in an email', async () => {
  await meeting({ sections: [{ id: 's_rep', title: 'Committee reports', items: [{ id: 'i_sec', title: 'Executive session: staff pay', presenter: 'Kim', confidential: true }, { id: 'i_fin', title: 'Financial', presenter: 'Sam', live: 'cash' }] }] });
  await run();
  const kim = gmail.sent.find((m) => hdr(m, 'To').startsWith('Kim'));
  assert.equal(hdr(kim, 'Subject'), 'Q4 2026 Board Meeting: your report on the board-only item you present, due Wed, Nov 4 at noon');
  assert.doesNotMatch(kim.text + kim.html, /Executive session|staff pay/);
  clock = easternAt('2026-11-04', '12:06');
  await run();
  const review = gmail.sent.find((m) => /Agenda for your review/.test(hdr(m, 'Subject')));
  assert.match(review.text, /A board-only item \(on the board page\) · Kim Park/);
  assert.ok(gmail.sent.every((m) => !/Executive session|staff pay/.test(m.text + m.html + hdr(m, 'Subject'))));
});

test('a reply that’s only a file Board can’t keep isn’t marked in or thanked; one PDF sent twice in a run goes on once', async () => {
  await meeting();
  await run();
  const ask = gmail.sent.find((m) => hdr(m, 'To').startsWith('Sam'));
  env.AI = { run: async () => ({ response: { kind: 'report', signature: '' } }) };
  gmail.reply(ask.threadId, { from: 'Sam Ortiz <sam.board@example.org>', text: '', files: [{ name: 'numbers.csv', type: 'text/csv', bytes: Buffer.from('a,b\n1,2\n') }] });
  const before = gmail.sent.length;
  clock += 10 * 60 * 1000;
  await run();
  assert.equal(gmail.sent.length, before, 'no thanks');
  assert.equal((await rows()).find((x) => x.slug === 'sam-ortiz').status, 'asked');
  const pdf = { name: 'Q4.pdf', type: 'application/pdf', bytes: Buffer.from('%PDF-1.4\n% made up\n') };
  gmail.reply(ask.threadId, { from: 'Sam Ortiz <sam.board@example.org>', text: 'Here are the numbers.', files: [pdf] });
  gmail.reply(ask.threadId, { from: 'Sam Ortiz <sam.board@example.org>', text: 'Again, with the PDF.', files: [pdf] });
  clock += 10 * 60 * 1000;
  await run();
  const m = await getMeeting(env.DB, 'm_nov5');
  assert.equal(m.files.filter((f) => f.name === 'Q4.pdf').length, 1);
});

test('a corrected copy that starts the same goes on under the first, never dropped', async () => {
  await meeting();
  await run();
  const ask = gmail.sent.find((m) => hdr(m, 'To').startsWith('Sam'));
  env.AI = { run: async () => ({ response: { kind: 'report', signature: '' } }) };
  const long = `Revenue is ahead of plan. ${'Detail. '.repeat(60)}`;
  gmail.reply(ask.threadId, { from: 'Sam Ortiz <sam.board@example.org>', text: `${long}Cash is $560K.` });
  clock += 10 * 60 * 1000;
  await run();
  gmail.reply(ask.threadId, { from: 'Sam Ortiz <sam.board@example.org>', text: `${long}Cash is $570K (corrected).` });
  clock += 10 * 60 * 1000;
  await run();
  assert.match((await getMeeting(env.DB, 'm_nov5')).sections[1].items.find((x) => x.id === 'i_fin').report, /\$570K \(corrected\)/);
});

test('two heartbeats at the same moment: one run, not two (no email twice)', async () => {
  await setMode('test');
  await meeting();
  await Promise.all([maybeRunAsks(env, { fetchImpl: gmail.fetch, now: clock }), maybeRunAsks(env, { fetchImpl: gmail.fetch, now: clock })]);
  assert.equal(gmail.sent.length, 8);
});

test('replies as mail programs really send them: Outlook bullets, a quote they made, Samsung’s quote, and text that only looks like a quote', () => {
  const outlook = '<p class=MsoListParagraph><![if !supportLists]><span>·<span>&nbsp;&nbsp; </span></span><![endif]>Revenue up 12%<o:p></o:p></p>';
  assert.doesNotMatch(htmlToMd(outlook), /supportLists|endif/);
  const ownQuote = '<div>As the bylaws say:</div><blockquote class="gmail_quote" style="margin:0 0 0 .8ex">The treasurer reports quarterly.</blockquote><div>So this is my report.</div><div class="gmail_quote"><div class="gmail_attr">On Tue, Nov 3, 2026 at 9:00 AM Max Doe wrote:</div><blockquote class="gmail_quote">Hi</blockquote></div>';
  assert.match(htmlToMd(ownQuote), /The treasurer reports quarterly\.[\s\S]*So this is my report\./);
  assert.doesNotMatch(htmlToMd(ownQuote), /^Hi$/m);
  const samsung = { mimeType: 'multipart/alternative', parts: [{ partId: '0', mimeType: 'text/html', headers: [{ name: 'Content-Type', value: 'text/html; charset=UTF-8' }], body: { data: Buffer.from('<div>Store is steady.</div><div><br></div><div>-------- Original message --------</div><div>From: Max Doe &lt;max@soardcharity.com&gt;</div><div>Date: 11/3/26 9:00 AM</div><div>Hi Sam, please send</div>').toString('base64url') } }] };
  assert.equal(replyWords(samsung), 'Store is steady.');
  assert.equal(cutTextQuote('Renewals:\n>50% renewed\nThe rest in December.'), 'Renewals:\n>50% renewed\nThe rest in December.');
  assert.equal(cutTextQuote('Plan:\n--\nthen the gala.\nSent via the portal, as agreed.\nMore.'), 'Plan:\n--\nthen the gala.\nSent via the portal, as agreed.\nMore.');
  assert.equal(cutTextQuote('On the budget, we’re fine.\nSam wrote: the plan holds.'), 'On the budget, we’re fine.\nSam wrote: the plan holds.');
  assert.equal(htmlToMd('<ul><li><p>one</p></li><li><p>two</p></li></ul>'), '- one\n- two');
});
