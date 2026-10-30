/**
 * Board mail: SOARD's past board meetings brought in from the calendars and
 * Peter and Holly's email, each document sorted (Workers AI, rules when it
 * can't) and filed on its meeting, what the board was sent shared with the
 * board, and version 1's mis-filed files taken off once. Made-up people and
 * subjects only (the repo is public).
 * Run: node --test tests/board-mail.test.mjs
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { createD1 } from './lib/d1-shim.mjs';
import { readBoardMail, maybeReadBoardMail, mailLog, mailStatus, classifyFile, attendanceIn, leftOut, ruleKind, MAIL_BY } from '../functions/api/_board-mail.js';
import { syncBoardCalendar } from '../functions/api/_board-calendar.js';
import { listMeetings, getMeeting, saveMeeting, putFile, createMeeting } from '../functions/api/_board.js';
import { clearTokenCache } from '../functions/api/_google-calendar.js';
import { cleanMeeting } from '../public/admin/board-shared.js';

const FOUNDER = 'jane@soardcharity.com';
const BOARD = { 'alex-rivera': 'alex.board@example.com', 'sam-ortiz': 'sam.board@example.org', 'kim-park': 'kim.board@example.net' };
const PEOPLE = [
  ['jane-doe', { name: 'Jane Doe', group: 'team', title: 'Co-Founder/President' }],
  ['alex-rivera', { name: 'Alex Rivera', group: 'board', title: 'Board Chair', organization: 'Rivera Builders' }],
  ['sam-ortiz', { name: 'Sam Ortiz', group: 'board', title: 'Board Treasurer' }],
  ['kim-park', { name: 'Kim Park', group: 'board', title: 'Board Member' }],
  ['lee-former', { name: 'Lee Former', group: 'board', title: 'Board Member', status: 'alumni' }],
];
const { privateKey: SA_PEM } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });

class FakeR2 {
  constructor() { this.map = new Map(); }
  async put(key, bytes, opts) { this.map.set(key, { bytes: new Uint8Array(bytes), type: opts?.httpMetadata?.contentType }); }
  async get(key) { const o = this.map.get(key); return o ? { body: o.bytes, size: o.bytes.length, httpMetadata: { contentType: o.type } } : null; }
  async delete(key) { this.map.delete(key); }
}

const realFetch = globalThis.fetch;
let env;
let g; // the fake Google: { inboxes, calendars, texts, answers, calls }

const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const pdf = (t) => new TextEncoder().encode(`%PDF-1.4 ${t}`);
const toBoard = Object.values(BOARD).join(', ');

/** A message: { id, subject, from, to, date, files: [{ name, text?, size? }], listId?, snippet? } */
const msg = (id, subject, date, files, extra = {}) => ({ id, msgid: `<${id}@mail.example>`, subject, from: 'Alex Rivera <alex.board@example.com>', to: toBoard, date, files, ...extra });

beforeEach(async () => {
  env = { DB: await createD1(), FILES: new FakeR2(), GOOGLE_CALENDAR_KEY: JSON.stringify({ type: 'service_account', client_email: 'reader@example.iam.gserviceaccount.com', client_id: '1234567890', private_key: SA_PEM }) };
  await env.DB.exec('CREATE TABLE team (slug TEXT PRIMARY KEY, name TEXT, "group" TEXT, order_num INTEGER, data TEXT NOT NULL, updated_at TEXT)');
  await env.DB.exec('CREATE TABLE reveal_board_emails (slug TEXT PRIMARY KEY, email TEXT NOT NULL, updated_at TEXT)');
  await env.DB.exec('CREATE TABLE site_config (key TEXT PRIMARY KEY, data TEXT, updated_at TEXT)');
  for (const [slug, d] of PEOPLE) await env.DB.prepare('INSERT INTO team (slug, name, "group", data) VALUES (?, ?, ?, ?)').bind(slug, d.name, d.group, JSON.stringify(d)).run();
  for (const [slug, email] of Object.entries(BOARD)) await env.DB.prepare('INSERT INTO reveal_board_emails (slug, email) VALUES (?, ?)').bind(slug, email).run();
  g = { inboxes: { [FOUNDER]: [] }, calendars: { [FOUNDER]: [] }, texts: {}, answers: {}, calls: { writes: 0, gets: 0, model: [], pages: 0 }, pageSize: 500, modelDown: false };
  const tokens = {};
  globalThis.fetch = async (input, init = {}) => {
    const url = String(input);
    const method = init.method || 'GET';
    if (url === 'https://oauth2.googleapis.com/token') {
      const claims = JSON.parse(Buffer.from(new URLSearchParams(String(init.body)).get('assertion').split('.')[1], 'base64url').toString());
      const token = `tok-${Object.keys(tokens).length}`;
      tokens[token] = claims.sub;
      return Response.json({ access_token: token, expires_in: 3600 });
    }
    if (method !== 'GET') { g.calls.writes += 1; throw new Error(`unexpected ${method} ${url}`); }
    const who = tokens[String(init.headers?.Authorization || '').replace('Bearer ', '')];
    const u = new URL(url);
    const cal = u.pathname.match(/^\/calendar\/v3\/calendars\/([^/]+)\/events$/);
    if (cal) return Response.json({ items: g.calendars[decodeURIComponent(cal[1])] || [] });
    const box = g.inboxes[who] || [];
    if (u.pathname === '/gmail/v1/users/me/messages') {
      g.calls.pages += 1;
      // Newest first, as Gmail answers; `pageSize` pages them
      const all = [...box].sort((a, b) => b.date.localeCompare(a.date));
      const from = Number(u.searchParams.get('pageToken') || 0);
      const page = all.slice(from, from + g.pageSize);
      return Response.json({ messages: page.map((m) => ({ id: m.id })), ...(from + g.pageSize < all.length ? { nextPageToken: String(from + g.pageSize) } : {}) });
    }
    const att = u.pathname.match(/\/messages\/([^/]+)\/attachments\/(\d+)$/);
    if (att) {
      const f = box.find((x) => x.id === att[1]).files[Number(att[2])];
      return Response.json({ data: Buffer.from(f.bytes || pdf(f.name)).toString('base64url') });
    }
    const get = u.pathname.match(/\/messages\/([^/]+)$/);
    if (get) {
      g.calls.gets += 1;
      const m = box.find((x) => x.id === get[1]);
      const headers = [['Subject', m.subject], ['From', m.from], ['To', m.to || ''], ['Cc', m.cc || ''], ['Message-ID', m.msgid], ...(m.listId ? [['List-Id', m.listId]] : [])].map(([name, value]) => ({ name, value }));
      return Response.json({ id: m.id, internalDate: String(Date.parse(m.date)), snippet: m.snippet || '', payload: { headers,
        parts: m.files.map((f, i) => ({ filename: f.name, mimeType: f.type || 'application/pdf', body: { attachmentId: String(i), size: f.size || (f.bytes || pdf(f.name)).length } })) } });
    }
    throw new Error(`unexpected Google call ${url}`);
  };
  // Workers AI: the PDF converter reads `texts`; the model answers from `answers` by file name (not_board when it doesn't know)
  env.AI = {
    toMarkdown: async (doc) => ({ name: doc.name, format: 'text', data: g.texts[doc.name] || '' }),
    run: async (model, { messages, response_format }) => {
      const name = messages[1].content.match(/File name: (.+)/)[1];
      g.calls.model.push({ name, json: !!response_format, model, user: messages[1].content });
      if (g.modelDown) throw new Error('model unavailable');
      const a = g.answers[name] || { kind: 'not_board', meetingDate: '', reason: 'not for a meeting' };
      return { response: response_format ? a : JSON.stringify(a) };
    },
  };
  clearTokenCache();
});
afterEach(() => { globalThis.fetch = realFetch; });

const ev = (id, summary, date, extra = {}) => ({ id, iCalUID: `${id}@google.com`, summary, status: 'confirmed', start: { dateTime: `${date}T13:00:00Z` }, end: { dateTime: `${date}T15:00:00Z` }, ...extra });
const AGENDA = (date) => `MEETING Example Board – Agenda DATE ${date}\nLOCATION Example Hall TIME 8:00a - 10:00a\n1. CALL TO ORDER\n1. Roll Call\n2. COMMITTEE REPORTS\n1. Financial (Sam)\n3. NEW BUSINESS\n1. Spring gala`;
const MINUTES = (when) => `Example Board of Directors – Meeting Minutes\n${when}\nPresent: Alex Rivera, Sam Ortiz, Jane Doe\nAbsent – Kim Park\nThe meeting was called to order at 8:02 a.m. and a motion to approve the agenda was seconded.\nThe meeting adjourned at 9:45 a.m.`;
const by = (meetings, date) => meetings.find((m) => m.date === date);

test('past meetings come from the calendars as records, with their agendas, minutes and financials from email', async () => {
  const q1 = day(-260); const q2 = day(-170); const q3 = day(-80);
  g.calendars[FOUNDER] = [ev('p1', 'Example Q1 Board Meeting', q1), ev('p2', 'Example Q2 Board Meeting', q2), ev('p3', 'Example Q3 Board Meeting', q3, { location: 'Example Hall, 1 Example St, Roswell, GA' }), ev('adv', 'Advisory Board meeting', q3)];
  const cal = await syncBoardCalendar(env);
  assert.deepEqual([cal.past, cal.found, cal.added], [3, 0, 3]);
  // The Q3 packet: its agenda and financials (the board's), the last meeting's minutes, and things that aren't board material
  g.texts['Q3 Agenda.pdf'] = AGENDA(`${q3.slice(5, 7)}/${q3.slice(8)}/${q3.slice(0, 4)}`);
  g.texts['Minutes.pdf'] = MINUTES(new Date(`${q2}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }));
  g.texts['Q3 Financials.pdf'] = 'Statement of activities for the board';
  g.answers = {
    'Q3 Agenda.pdf': { kind: 'agenda', meetingDate: '', reason: 'the meeting agenda' },
    'Minutes.pdf': { kind: 'minutes', meetingDate: '', reason: 'minutes' },
    'Q3 Financials.pdf': { kind: 'financials', meetingDate: '', reason: 'board financials' },
    'Example Policy Renewal.pdf': { kind: 'not_board', meetingDate: '', reason: 'an insurance policy' },
  };
  g.inboxes[FOUNDER] = [msg('m1', 'Example Q3 board meeting docs', `${day(-82)}T15:00:00Z`, [
    { name: 'Q3 Agenda.pdf' }, { name: 'Minutes.pdf' }, { name: 'Q3 Financials.pdf' }, { name: 'Example Policy Renewal.pdf' }, { name: 'Pat Example Resume.pdf' },
  ], { snippet: 'Attached are the documents for Thursday' })];
  const r = await readBoardMail(env);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
  assert.equal(g.calls.writes, 0, 'never sends, deletes or labels');
  assert.ok(!g.calls.model.some((c) => /Resume/.test(c.name)), 'a resume never reaches the model');
  assert.match(g.calls.model[0].user, /Sent to 3 people/);
  const all = await listMeetings(env.DB);
  const third = by(all, q3);
  assert.deepEqual(third.sections.map((s) => s.title), ['Call to order', 'Committee reports', 'New business'], 'the agenda, from the packet');
  assert.deepEqual([third.agendaFrom.kind, third.agendaFrom.name, third.location], ['email', 'Q3 Agenda.pdf', 'Example Hall']);
  assert.deepEqual(third.files.map((f) => [f.name, f.kind, f.staffOnly]).sort(), [['Q3 Agenda.pdf', 'agenda', false], ['Q3 Financials.pdf', 'financials', false]], 'what the board was sent, for the board');
  assert.equal(third.shared, true, 'a past meeting nobody here worked on goes on the board page');
  // The minutes in the Q3 packet are the Q2 meeting's (their own date says so): its attendance, approved at Q3
  const second = by(all, q2);
  assert.deepEqual(second.files.map((f) => [f.name, f.kind]), [['Minutes.pdf', 'minutes']]);
  assert.deepEqual(second.attendance.map((p) => `${p.slug}:${p.status}`), ['alex-rivera:present', 'sam-ortiz:present', 'jane-doe:present', 'kim-park:absent']);
  assert.deepEqual([second.minutes, second.approvedOn, second.shared], ['approved', q3, true]);
  assert.deepEqual(by(all, q1).files, [], 'nothing for the first meeting');
  const log = await mailLog(env.DB);
  assert.equal(log[0].outcome, 'filed');
  assert.match(log[0].result, /filed on Q3 \d{4} Board Meeting .*: the agenda \(its agenda filled in\), the financials/);
  assert.match(log[0].result, /left out Example Policy Renewal\.pdf \(an insurance policy\), Pat Example Resume\.pdf \(a resume\)/);
  const s = await mailStatus(env.DB);
  assert.deepEqual([s.version, s.backlog, s.totals.emails, s.totals.files, s.totals.skipped, s.totals.meetings, s.totals.made], [2, 0, 1, 3, 2, 2, 0]);
});

test('dated material with no meeting near it brings the meeting in; undated minutes go to the meeting before them, an undated agenda to the one after', async () => {
  g.texts['Agenda 2.13.25.pdf'] = AGENDA('02/13/2025');
  g.texts['notes.pdf'] = MINUTES('');
  g.texts['agenda.docx.pdf'] = 'no date anywhere';
  g.answers = {
    'Agenda 2.13.25.pdf': { kind: 'agenda', meetingDate: '', reason: 'agenda' },
    'notes.pdf': { kind: 'minutes', meetingDate: '', reason: 'minutes' },
    'Packet slides.pdf': { kind: 'packet', meetingDate: '', reason: 'a board presentation' },
  };
  g.inboxes[FOUNDER] = [msg('a1', 'Example board agenda', '2025-02-10T14:00:00Z', [{ name: 'Agenda 2.13.25.pdf' }])];
  await readBoardMail(env);
  let all = await listMeetings(env.DB);
  assert.deepEqual(all.map((m) => [m.date, m.updatedBy, m.sections.length > 0]), [['2025-02-13', MAIL_BY, true]], 'brought in on the date the agenda gives');
  assert.equal((await mailStatus(env.DB)).totals.made, 1);
  // Undated minutes three weeks later: the meeting before them; an undated packet: waits for a meeting after it
  g.inboxes[FOUNDER].push(msg('a2', 'Example board notes', '2025-03-06T14:00:00Z', [{ name: 'notes.pdf' }]));
  g.inboxes[FOUNDER].push(msg('a3', 'For the next board meeting', '2025-04-20T14:00:00Z', [{ name: 'Packet slides.pdf' }]));
  await readBoardMail(env);
  all = await listMeetings(env.DB);
  assert.deepEqual(by(all, '2025-02-13').files.map((f) => f.kind).sort(), ['agenda', 'minutes']);
  assert.equal(all.length, 1, 'an undated packet never makes a meeting');
  assert.equal((await mailLog(env.DB, 12, { outcome: 'waiting' }))[0].subject, 'For the next board meeting');
  // The calendar adds the meeting after it: the packet comes back and lands
  g.calendars[FOUNDER] = [ev('c2', 'Example Q2 Board Meeting', '2025-04-24')];
  await syncBoardCalendar(env);
  await readBoardMail(env);
  assert.deepEqual(by(await listMeetings(env.DB), '2025-04-24').files.map((f) => [f.name, f.kind]), [['Packet slides.pdf', 'packet']]);
  assert.equal((await mailLog(env.DB, 12, { outcome: 'waiting' })).length, 0);
});

test('a date a day off finds its meeting (within ten days), and never makes a second one', async () => {
  g.calendars[FOUNDER] = [ev('c1', 'SOARD Board Meeting', '2025-07-24')];
  await syncBoardCalendar(env);
  g.texts['Minutes 2025.07.23.pdf'] = MINUTES('July 23, 2025');
  g.answers['Minutes 2025.07.23.pdf'] = { kind: 'minutes', meetingDate: '2025-07-23', reason: 'minutes' };
  g.inboxes[FOUNDER] = [msg('b1', 'Example board minutes', '2025-07-28T14:00:00Z', [{ name: 'Minutes 2025.07.23.pdf' }])];
  await readBoardMail(env);
  const all = await listMeetings(env.DB);
  assert.equal(all.length, 1);
  assert.deepEqual(all[0].files.map((f) => f.name), ['Minutes 2025.07.23.pdf']);
});

test('who sees it: an email to a few people is for Peter and Holly only; to the board or its group, for the board', async () => {
  const past = day(-30);
  g.calendars[FOUNDER] = [ev('c1', 'SOARD Board Meeting', past)];
  await syncBoardCalendar(env);
  g.answers = { 'Financials draft.pdf': { kind: 'financials', meetingDate: past, reason: 'board financials' }, 'Agenda final.pdf': { kind: 'agenda', meetingDate: past, reason: 'agenda' } };
  g.inboxes[FOUNDER] = [msg('w1', 'Financials for the board meeting', `${day(-32)}T12:00:00Z`, [{ name: 'Financials draft.pdf' }], { to: 'jane@soardcharity.com, sam.board@example.org' })];
  await readBoardMail(env);
  let m = by(await listMeetings(env.DB), past);
  assert.deepEqual([m.files[0].staffOnly, m.shared], [true, false]);
  // The group's copy (Google Groups marks it with List-Id)
  g.inboxes[FOUNDER].push(msg('w2', 'Agenda for the board meeting', `${day(-31)}T12:00:00Z`, [{ name: 'Agenda final.pdf' }], { to: 'board-group@example.org', listId: '<board-group.example.org>' }));
  await readBoardMail(env);
  m = by(await listMeetings(env.DB), past);
  assert.deepEqual(m.files.map((f) => [f.name, f.staffOnly]), [['Financials draft.pdf', true], ['Agenda final.pdf', false]]);
  assert.equal(m.shared, true);
  // A newsletter's List-Id isn't the board's: what it brings stays with Peter and Holly; SOARD's own group's is the board's
  g.answers['Newsletter minutes.pdf'] = { kind: 'minutes', meetingDate: past, reason: 'minutes' };
  g.answers['Group minutes.pdf'] = { kind: 'minutes', meetingDate: past, reason: 'minutes' };
  g.inboxes[FOUNDER].push(msg('w4', 'Board meeting minutes', `${day(-28)}T12:00:00Z`, [{ name: 'Newsletter minutes.pdf' }], { to: 'jane@soardcharity.com', listId: 'Weekly news <news.example.org>' }));
  g.inboxes[FOUNDER].push(msg('w5', 'Board meeting minutes', `${day(-27)}T12:00:00Z`, [{ name: 'Group minutes.pdf' }], { to: 'jane@soardcharity.com', listId: '<soard-board.googlegroups.com>' }));
  await readBoardMail(env);
  m = by(await listMeetings(env.DB), past);
  assert.deepEqual(m.files.filter((f) => /minutes/i.test(f.name)).map((f) => [f.name, f.staffOnly]).sort(), [['Group minutes.pdf', false], ['Newsletter minutes.pdf', true]]);
  // A meeting a person has worked on (or one ahead) is theirs to share
  const ahead = day(20);
  g.calendars[FOUNDER].push(ev('c2', 'SOARD Board Meeting', ahead));
  await syncBoardCalendar(env);
  g.answers['Ahead agenda.pdf'] = { kind: 'agenda', meetingDate: ahead, reason: 'agenda' };
  g.inboxes[FOUNDER].push(msg('w3', 'Agenda', `${day(-1)}T12:00:00Z`, [{ name: 'Ahead agenda.pdf' }]));
  await readBoardMail(env);
  const next = by(await listMeetings(env.DB), ahead);
  assert.deepEqual([next.files.length, next.files[0].staffOnly, next.shared], [1, false, false]);
});

test('a typed agenda and marked attendance are never overwritten; the file is still kept', async () => {
  const past = day(-40);
  const m = await saveMeeting(env.DB, cleanMeeting({ date: past, sections: [{ title: 'Typed', items: [{ title: 'Ours' }] }], attendance: [{ slug: 'alex-rivera', name: 'Alex Rivera', kind: 'board', status: 'remote' }] }), { by: FOUNDER });
  g.texts['Agenda.pdf'] = AGENDA(`${past.slice(5, 7)}/${past.slice(8)}/${past.slice(0, 4)}`);
  g.texts['Minutes.pdf'] = MINUTES('');
  g.answers = { 'Agenda.pdf': { kind: 'agenda', meetingDate: past, reason: 'agenda' }, 'Minutes.pdf': { kind: 'minutes', meetingDate: past, reason: 'minutes' } };
  g.inboxes[FOUNDER] = [msg('t1', 'Board agenda and minutes', `${day(-35)}T12:00:00Z`, [{ name: 'Agenda.pdf' }, { name: 'Minutes.pdf' }])];
  await readBoardMail(env);
  const after = await getMeeting(env.DB, m.id);
  assert.deepEqual(after.sections.map((s) => s.title), ['Typed']);
  assert.deepEqual(after.attendance.map((p) => `${p.slug}:${p.status}`), ['alex-rivera:remote']);
  assert.equal(after.files.length, 2);
  assert.equal(after.shared, false, 'a meeting a person worked on is theirs to share');
});

test('without Workers AI (or when it fails), the rules decide, and stay careful', async () => {
  assert.deepEqual(['Board Agenda Q3.docx', 'Q3 minutes.pdf', 'Board financials Q3.pdf', 'Profit and Loss.pdf', 'Example insurance policy.pdf', 'Gala deck.pptx'].map((name) => ruleKind({ name, subject: 'Example email' }).kind),
    ['agenda', 'minutes', 'financials', 'not_board', 'not_board', 'not_board']);
  assert.equal(ruleKind({ name: 'scan.pdf', text: MINUTES('') }).kind, 'minutes', 'minutes by their words');
  assert.equal(ruleKind({ name: 'scan.pdf', text: AGENDA('') }).kind, 'agenda');
  assert.deepEqual([leftOut({ name: 'Pat Example CV.pdf', size: 10 }), leftOut({ name: 'big.pdf', size: 16 * 1024 * 1024 }), leftOut({ name: 'r.pdf', size: 1 }, { sender: 'Example <quickbooks@notification.intuit.com>' }), leftOut({ name: 'a.pdf', size: 1 })],
    ['a resume', 'over 15 MB', 'an automatic QuickBooks report', '']);
  // The model fails both ways: the rules answer
  g.modelDown = true;
  const c = await classifyFile(env, { name: 'Example Board Agenda.pdf', subject: 'Agenda' });
  assert.deepEqual([c.kind, c.by], ['agenda', 'rules']);
  assert.deepEqual(g.calls.model.map((x) => x.json), [true, false], 'JSON first, then plain words');
  // A plain-words answer with JSON in it is read
  g.modelDown = false;
  g.answers['x.pdf'] = { kind: 'minutes', meetingDate: '2025-07-24', reason: 'minutes' };
  const plainOnly = env.AI.run;
  env.AI.run = async (model, opts) => (opts.response_format ? { response: 'not json' } : plainOnly(model, opts));
  assert.deepEqual(await classifyFile(env, { name: 'x.pdf' }), { kind: 'minutes', date: '2025-07-24', reason: 'minutes', by: 'ai' });
  // An answer outside the kinds is no answer
  env.AI.run = async () => ({ response: { kind: 'something', meetingDate: 'soon', reason: '' } });
  assert.equal((await classifyFile(env, { name: 'Gala deck.pptx' })).by, 'rules');
});

test('who was there, from minutes written every which way', () => {
  const people = [{ slug: 'alex-rivera', name: 'Alex Rivera', kind: 'board' }, { slug: 'sam-ortiz', name: 'Sam Ortiz', kind: 'board' }, { slug: 'kim-park', name: 'Kim Park', kind: 'board' }, { slug: 'jane-doe', name: 'Jane Doe', kind: 'staff' }];
  const at = (t) => attendanceIn(t, people).map((p) => `${p.slug}:${p.status}`);
  assert.deepEqual(at(MINUTES('Feb 12, 2026')), ['alex-rivera:present', 'sam-ortiz:present', 'jane-doe:present', 'kim-park:absent']);
  assert.deepEqual(at('Board members in attendance were:\nAlex Rivera\nKim Park (by video)\n\nFinancial report\nJane Doe reported on the year.'), ['alex-rivera:present', 'kim-park:remote'], 'the list ends where the business starts');
  assert.deepEqual(at('Attendees: Alex Rivera and Kim Park (via Zoom); Excused: Sam Ortiz'), ['alex-rivera:present', 'kim-park:remote', 'sam-ortiz:excused']);
  assert.deepEqual(at('Alex Rivera called the meeting to order.'), [], 'names in the business are not attendance');
});

test('a backlog is read newest first, a little each look and every minute, until it’s done; then hourly', async () => {
  g.pageSize = 2;
  g.calendars[FOUNDER] = [ev('c1', 'SOARD Board Meeting', '2025-05-01')];
  await syncBoardCalendar(env);
  for (let i = 0; i < 5; i++) {
    g.answers[`Agenda ${i}.pdf`] = { kind: 'agenda', meetingDate: '2025-05-01', reason: 'agenda' };
    g.inboxes[FOUNDER].push(msg(`k${i}`, `Board agenda draft ${i}`, `2025-04-2${i}T12:00:00Z`, [{ name: `Agenda ${i}.pdf` }]));
  }
  const first = await readBoardMail(env, { budgetMs: -1 });
  assert.deepEqual([first.read, first.backlog], [1, 4], 'at least one each look');
  assert.ok(g.calls.pages >= 3, 'every page of the search');
  assert.match((await mailLog(env.DB))[0].subject, /draft 4$/, 'newest first');
  assert.equal(await maybeReadBoardMail(env, { now: Date.now() + 30 * 1000 }), null, 'not within the minute');
  const next = await maybeReadBoardMail(env, { now: Date.now() + 61 * 1000 });
  assert.deepEqual([next.read, next.backlog], [4, 0]);
  assert.equal(await maybeReadBoardMail(env, { now: Date.now() + 5 * 60 * 1000 }), null, 'caught up: hourly');
  assert.ok(await maybeReadBoardMail(env, { now: Date.now() + 63 * 60 * 1000 }), 'an hour after the last look');
});

test('an email a look was cut off in the middle of is sorted by the rules next time, so it always finishes', async () => {
  const past = day(-15);
  g.calendars[FOUNDER] = [ev('c1', 'SOARD Board Meeting', past)];
  await syncBoardCalendar(env);
  g.inboxes[FOUNDER] = [msg('slow', 'Board agenda', `${day(-17)}T12:00:00Z`, [{ name: `Board Agenda ${past}.pdf` }])];
  await readBoardMail(env, { budgetMs: -1 }); // reads the state, makes the table
  await env.DB.prepare('DELETE FROM board_mail').run();
  // What a look the Worker's time ran out in leaves behind
  await env.DB.prepare("INSERT INTO board_mail (id, admin, result, outcome, at) VALUES (?, ?, 'being read', 'started', ?)").bind(`${FOUNDER}:slow`, FOUNDER, new Date().toISOString()).run();
  g.calls.model = [];
  await readBoardMail(env);
  assert.equal(g.calls.model.length, 0, 'no model this time');
  assert.deepEqual(by(await listMeetings(env.DB), past).files.map((f) => f.kind), ['agenda']);
  assert.equal((await mailLog(env.DB))[0].outcome, 'filed');
});

test('version 1’s mis-filed copies come off once, and everything is read again; a file a person uploaded stays', async () => {
  const m = await createMeeting(env, { date: day(10), by: 'the calendar' });
  for (const [name, who] of [['Weekly P&L.pdf', MAIL_BY], ['Example Resume.pdf', MAIL_BY], ['Our agenda.pdf', FOUNDER]]) {
    await putFile(env, { ownerType: 'meeting', ownerId: m.id, file: new File([pdf(name)], name, { type: 'application/pdf' }), kind: 'other', by: who });
  }
  await env.DB.exec(`CREATE TABLE IF NOT EXISTS board_mail (id TEXT PRIMARY KEY, msgid TEXT, admin TEXT, subject TEXT, sender TEXT, sent_at TEXT, meeting_id TEXT, result TEXT, files INTEGER DEFAULT 0, at TEXT)`);
  await env.DB.prepare('INSERT INTO board_mail (id, msgid, admin, subject, result, at) VALUES (?, ?, ?, ?, ?, ?)').bind(`${FOUNDER}:old1`, '<old1>', FOUNDER, 'Weekly report', 'kept the files', new Date().toISOString()).run();
  await env.DB.exec("CREATE TABLE IF NOT EXISTS board_state (key TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT)");
  await env.DB.prepare("INSERT OR REPLACE INTO board_state (key, data) VALUES ('mail', ?)").bind(JSON.stringify({ ok: true, checkedAt: new Date().toISOString(), waiting: 0 })).run();
  assert.ok(await maybeReadBoardMail(env), 'an upgrade reads at once');
  assert.deepEqual((await getMeeting(env.DB, m.id)).files.map((f) => f.name), ['Our agenda.pdf']);
  assert.equal(env.FILES.map.size, 1, 'the copies are gone from storage too');
  assert.equal((await mailStatus(env.DB)).tidied, 2);
  assert.equal((await env.DB.prepare('SELECT count(*) AS n FROM board_mail').first()).n, 0, 'every email is read again under the new rules');
  // Once only
  await putFile(env, { ownerType: 'meeting', ownerId: m.id, file: new File([pdf('new')], 'New agenda.pdf', { type: 'application/pdf' }), kind: 'agenda', by: MAIL_BY });
  await readBoardMail(env);
  assert.equal((await getMeeting(env.DB, m.id)).files.length, 2);
});

test('the same email in both inboxes is read once, and Gmail errors are reported without losing the email', async () => {
  const past = day(-20);
  g.calendars[FOUNDER] = [ev('c1', 'SOARD Board Meeting', past)];
  await syncBoardCalendar(env);
  await env.DB.prepare("INSERT OR REPLACE INTO board_state (key, data) VALUES ('settings', ?)").bind(JSON.stringify({ admins: [FOUNDER, 'pat@soardcharity.com'] })).run();
  g.answers['Agenda.pdf'] = { kind: 'agenda', meetingDate: past, reason: 'agenda' };
  const one = msg('s1', 'Board agenda', `${day(-22)}T12:00:00Z`, [{ name: 'Agenda.pdf' }]);
  g.inboxes[FOUNDER] = [one];
  g.inboxes['pat@soardcharity.com'] = [{ ...one, id: 's9' }];
  await readBoardMail(env);
  assert.equal(by(await listMeetings(env.DB), past).files.length, 1);
  assert.equal((await mailLog(env.DB)).length, 1, 'the second copy isn’t listed');
  // Gmail failing on a message: reported, and the email is tried again next look
  const working = globalThis.fetch;
  g.inboxes[FOUNDER].push(msg('s2', 'Board minutes', `${day(-18)}T12:00:00Z`, [{ name: 'Minutes.pdf' }]));
  globalThis.fetch = async (input, init) => (/messages\/s2$/.test(new URL(String(input)).pathname) ? Response.json({ error: { message: 'Backend Error' } }, { status: 503 }) : working(input, init));
  const bad = await readBoardMail(env);
  assert.equal(bad.ok, false);
  assert.match(bad.errors[0], /^jane’s email: Gmail answered 503/);
  assert.equal(bad.backlog, 1);
  globalThis.fetch = working;
  g.answers['Minutes.pdf'] = { kind: 'minutes', meetingDate: past, reason: 'minutes' };
  const good = await readBoardMail(env);
  assert.deepEqual([good.ok, good.backlog], [true, 0]);
});
