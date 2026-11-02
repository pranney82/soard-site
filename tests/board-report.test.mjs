/**
 * Committee reports: the Markdown they're kept in (public/admin/board-md.js), read and written the same way by the
 * editor, the board page, the screen, Print it all and the server
 *
 *   node --test tests/board-report.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mdBlocks, mdInline, mdToDoc, docToMd, mdPlain, mdWords, safeHref } from '../public/admin/board-md.js';

const p = (...content) => ({ type: 'paragraph', content });
const t = (text, ...marks) => ({ type: 'text', text, ...(marks.length ? { marks: marks.map((m) => (typeof m === 'string' ? { type: m } : m)) } : {}) });
const link = (href) => ({ type: 'link', attrs: { href } });
const ul = (...items) => ({ type: 'bulletList', content: items.map((c) => ({ type: 'listItem', content: c })) });
const ol = (start, ...items) => ({ type: 'orderedList', attrs: { start }, content: items.map((c) => ({ type: 'listItem', content: c })) });
const doc = (...content) => ({ type: 'doc', content });
// The document as the editor would load it again (link attributes the editor adds aside)
const plainDoc = (d) => JSON.parse(JSON.stringify(d, (k, v) => (k === 'attrs' && v && 'href' in v ? { href: v.href } : v)));
const roundTrip = (d) => { const md = docToMd(d); assert.deepEqual(plainDoc(mdToDoc(md)), plainDoc(d), `round trip through:\n${md}`); return md; };

test('old notes read as they always did: points, points under points, a line of text', () => {
  const blocks = mdBlocks('- Insurance renewal is on track\n  - Broker sends the quote Friday\n- Audit in March\nThanks to the committee');
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].t, 'ul');
  assert.deepEqual(blocks[0].items.map((it) => it[0].text), ['Insurance renewal is on track', 'Audit in March']);
  assert.equal(blocks[0].items[0][1].t, 'ul');
  assert.equal(blocks[0].items[0][1].items[0][0].text, 'Broker sends the quote Friday');
  assert.deepEqual(blocks[1], { t: 'p', text: 'Thanks to the committee' });
  // A bullet typed as • and a tab for the indent
  assert.equal(mdBlocks('• One\n\t• Two')[0].items[0][1].items[0][0].text, 'Two');
});

test('a report: headings, paragraphs, numbered lists, a callout', () => {
  const md = '### Highlights\n\nWe met **twice**, with *two* new members.\n\n1. Approve the budget\n2. Name a chair\n\n> The board needs to decide by May.';
  const b = mdBlocks(md);
  assert.deepEqual(b.map((x) => x.t), ['h', 'p', 'ol', 'quote']);
  assert.equal(b[2].start, 1);
  assert.equal(b[3].blocks[0].text, 'The board needs to decide by May.');
  assert.deepEqual(mdInline(b[1].text), [{ text: 'We met ' }, { text: 'twice', b: true }, { text: ', with ' }, { text: 'two', i: true }, { text: ' new members.' }]);
  // A numbered list can start anywhere; # and ## read as headings too
  assert.equal(mdBlocks('3. Third\n4. Fourth')[0].start, 3);
  assert.deepEqual(mdBlocks('# Big\n## Middle').map((x) => x.t), ['h', 'h']);
  assert.equal(mdPlain(md), 'Highlights\nWe met twice, with two new members.\n1. Approve the budget\n2. Name a chair\nThe board needs to decide by May.');
  assert.equal(mdWords(md), 21);
});

test('links: only ones the board can follow; a bare address is a link', () => {
  assert.deepEqual(mdInline('See [the plan](https://soard.org/plan).'), [{ text: 'See ' }, { text: 'the plan', href: 'https://soard.org/plan' }, { text: '.' }]);
  assert.deepEqual(mdInline('[click](javascript:alert(1))'), [{ text: 'click' }], 'a script is words, never a link');
  assert.deepEqual(mdInline('Go to https://soard.org/give, then'), [{ text: 'Go to ' }, { text: 'https://soard.org/give', href: 'https://soard.org/give' }, { text: ', then' }]);
  assert.deepEqual(mdInline('(www.soard.org)'), [{ text: '(' }, { text: 'www.soard.org', href: 'https://www.soard.org' }, { text: ')' }]);
  assert.equal(safeHref('data:text/html,hi'), '');
  assert.equal(safeHref('mailto:holly@example.org'), 'mailto:holly@example.org');
});

test('words that look like Markdown stay words: 2 * 3, snake_case, a price list', () => {
  assert.deepEqual(mdInline('2 * 3 * 4'), [{ text: '2 * 3 * 4' }]);
  assert.deepEqual(mdInline('file_name_here'), [{ text: 'file_name_here' }]);
  assert.deepEqual(mdInline('***both***'), [{ text: 'both', b: true, i: true }]);
  assert.deepEqual(mdInline('line one\nline two'), [{ text: 'line one' }, { br: true }, { text: 'line two' }]);
});

test('the editor’s document → Markdown → the same document', () => {
  roundTrip(doc({ type: 'heading', attrs: { level: 3 }, content: [t('Highlights')] }, p(t('We met '), t('twice', 'bold'), t(' this quarter.'))));
  roundTrip(doc(ul([p(t('One'))], [p(t('Two')), ul([p(t('Two and a half'))])]), p(t('After the list'))));
  roundTrip(doc(ol(3, [p(t('Third'))], [p(t('Fourth')), ul([p(t('Under it'))])])));
  roundTrip(doc({ type: 'blockquote', content: [p(t('Decide by May.'))] }));
  roundTrip(doc(p(t('Read '), t('the budget', link('https://soard.org/b'), 'bold'), t(' first.'))));
  roundTrip(doc(p(t('A line'), { type: 'hardBreak' }, t('and the next'))));
  roundTrip(doc(ul([p(t('A point'), { type: 'hardBreak' }, t('carried on'))])));
  roundTrip(doc(ul([p(t('A point')), p(t('Its second paragraph'))])));
  // What reads as Markdown when typed as words: kept as words
  const md = roundTrip(doc(p(t('# not a heading')), p(t('- not a point')), p(t('2026. A year')), p(t('5 * 3 = 15 and a_b and [brackets]')), p(t('> not a callout'))));
  assert.match(md, /^\\# not a heading/);
  // Overlapping marks, spaces at a mark's edge
  roundTrip(doc(p(t('bold '), t('both', 'bold', 'italic'), t(' '), t('italic', 'italic'))));
  roundTrip(doc(p(t('bold ', 'bold'), t('and', 'bold', 'italic'), t(' more', 'bold'))));
  assert.equal(docToMd(doc(p(t('very ', 'bold'), t('much')))), '**very** much', 'a space at the edge goes outside the mark');
  // A bare address stays bare
  assert.equal(docToMd(doc(p(t('https://soard.org', link('https://soard.org'))))), 'https://soard.org');
  // Empty paragraphs are space, not text
  assert.equal(docToMd(doc(p(), p(t('Hi')), p())), 'Hi');
  assert.deepEqual(mdToDoc(''), doc({ type: 'paragraph' }));
});

test('an editor document never loses words, whatever it holds (a random walk)', () => {
  const words = ['budget', 'a_b', '*star*', '[x]', '#1', '- dash', '2.', 'Q4', 'https://soard.org', '>', '\\', 'café', '  spaced  '];
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const marksOf = () => [['bold'], ['italic'], ['bold', 'italic'], [], [], [link('https://x.org/a')]][rnd(6)];
  const para = () => p(...Array.from({ length: 1 + rnd(4) }, (_, k) => t(`${k ? ' ' : ''}${words[rnd(words.length)]}`, ...marksOf())));
  for (let k = 0; k < 3000; k++) {
    const d = doc(para(), ul([para()], [para(), ul([para()])]), ol(1 + rnd(5), [para()]));
    // Every character kept, in order (spaces at a block's edges aside)
    const text = (x) => JSON.stringify(x).match(/"text":"((?:[^"\\]|\\.)*)"/g).map((s) => JSON.parse(`{${s}}`).text).join('').replace(/\s+/g, '');
    assert.equal(text(mdToDoc(docToMd(d))), text(d), docToMd(d));
  }
});

// ─── Writing one: who may, conflicts, who and when ──────────────────

import { createD1 } from './lib/d1-shim.mjs';
import { saveMeeting, saveReport, getMeeting, liveView, portalData } from '../functions/api/_board.js';
import { cleanMeeting, forBoard, isFilled } from '../public/admin/board-shared.js';

const PEOPLE = [
  ['jane-doe', { name: 'Jane Doe', group: 'team', title: 'Co-Founder/President' }],
  ['alex-rivera', { name: 'Alex Rivera', group: 'board', title: 'Board Chair' }],
  ['sam-ortiz', { name: 'Sam Ortiz', group: 'board', title: 'Board Treasurer' }],
  ['kim-park', { name: 'Kim Park', group: 'board', title: 'Board Member' }],
];
const ALEX = { slug: 'alex-rivera', name: 'Alex Rivera', email: 'alex.board@example.com' };
const SAM = { slug: 'sam-ortiz', name: 'Sam Ortiz', email: 'sam.board@example.org' };
const KIM = { slug: 'kim-park', name: 'Kim Park', email: 'kim@example.org' };
async function world({ shared = true, minutes = 'draft', date = '2099-11-05' } = {}) {
  const env = { DB: await createD1() };
  await env.DB.exec('CREATE TABLE team (slug TEXT PRIMARY KEY, name TEXT, "group" TEXT, order_num INTEGER, data TEXT NOT NULL, updated_at TEXT)');
  await env.DB.exec('CREATE TABLE reveal_board_emails (slug TEXT PRIMARY KEY, email TEXT NOT NULL, updated_at TEXT)');
  await env.DB.exec('CREATE TABLE site_config (key TEXT PRIMARY KEY, data TEXT, updated_at TEXT)');
  for (const [slug, d] of PEOPLE) await env.DB.prepare('INSERT INTO team (slug, name, "group", data) VALUES (?, ?, ?, ?)').bind(slug, d.name, d.group, JSON.stringify(d)).run();
  const m = await saveMeeting(env.DB, {
    id: 'm_rep1', date, start: '08:00', end: '10:00', shared, minutes,
    sections: [{ id: 's_com1', title: 'Committee reports', items: [
      { id: 'i_gov1', title: 'Governance', presenter: 'Alex' }, // named, not picked: "Alex" is Alex Rivera
      { id: 'i_fin1', title: 'Financial', who: ['sam-ortiz'], presenter: 'Sam Ortiz' },
      { id: 'i_eve1', title: 'Events', who: ['kim-park', 'jane-doe'], presenter: 'Kim Park & Jane Doe' },
    ] }],
  }, { by: 'jane@soardcharity.com' });
  return { env, m };
}
const itemIn = (m, id) => m.sections.flatMap((s) => s.items).find((it) => it.id === id);

test('a report is kept with its item, counts as something on the agenda, and the board sees it', () => {
  const m = cleanMeeting({ shared: true, sections: [{ title: 'x', items: [{ id: 'i_a1', report: '### Hi\n\n- one', reportBy: 'Alex Rivera', reportAt: '2099-11-01T14:00:00.000Z' }, { id: 'i_b1', reportAt: 'yesterday' }] }] });
  const [a, b] = m.sections[0].items;
  assert.deepEqual([a.report, a.reportBy, a.reportAt], ['### Hi\n\n- one', 'Alex Rivera', '2099-11-01T14:00:00.000Z']);
  assert.equal(b.reportAt, '', 'only a real time');
  assert.equal(isFilled({ report: 'x' }), true);
  assert.equal(forBoard(m).sections[0].items[0].report, '### Hi\n\n- one');
});

test('who presents an item writes its report on the board page; nobody else on the board can', async () => {
  const { env } = await world();
  const r = await saveReport(env, 'm_rep1', 'i_gov1', '### Highlights\n\n- New bylaws drafted', { member: ALEX, base: '' });
  assert.equal(r.report, '### Highlights\n\n- New bylaws drafted');
  assert.equal(r.reportBy, 'Alex Rivera');
  assert.match(r.reportAt, /^\d{4}-\d{2}-\d{2}T/);
  const m = await getMeeting(env.DB, 'm_rep1');
  assert.equal(itemIn(m, 'i_gov1').report, r.report);
  assert.equal(m.updatedBy, 'Alex Rivera', 'the meeting says who changed it, by name, so an editor open in Board merges it in and says who');
  // A co-presenter on Events, yes; Sam on Governance, no
  assert.equal((await saveReport(env, 'm_rep1', 'i_eve1', 'Gala sold out', { member: KIM, base: '' })).reportBy, 'Kim Park');
  await assert.rejects(saveReport(env, 'm_rep1', 'i_gov1', 'Not mine', { member: SAM, base: r.reportAt }), (e) => e.status === 403);
  await assert.rejects(saveReport(env, 'm_rep1', 'i_nope1', 'x', { member: ALEX }), (e) => e.status === 404);
  await assert.rejects(saveReport(env, 'm_rep1', 'i_gov1', 42, { member: ALEX }), (e) => e.status === 400);
  // An admin writes on any item, by name
  const a = await saveReport(env, 'm_rep1', 'i_fin1', 'Cash is up', { admin: true, adminEmail: 'jane@soardcharity.com', base: '' });
  assert.equal(a.reportBy, 'Jane Doe');
});

test('a report saved by someone else meanwhile is never written over: 409 with theirs', async () => {
  const { env } = await world();
  const first = await saveReport(env, 'm_rep1', 'i_eve1', 'Kim’s draft', { member: KIM, base: '' });
  // Jane opened it before Kim saved (base ''), then saves: refused, with Kim's words
  await assert.rejects(saveReport(env, 'm_rep1', 'i_eve1', 'Jane’s words', { admin: true, adminEmail: 'jane@soardcharity.com', base: '' }),
    (e) => e.status === 409 && e.current.report === 'Kim’s draft' && e.current.reportAt === first.reportAt);
  // From Kim's version, it goes through
  const next = await saveReport(env, 'm_rep1', 'i_eve1', 'Kim’s draft, and Jane’s line', { admin: true, adminEmail: 'jane@soardcharity.com', base: first.reportAt });
  assert.equal(next.report, 'Kim’s draft, and Jane’s line');
  // The same words twice: nothing to write, no conflict
  assert.equal((await saveReport(env, 'm_rep1', 'i_eve1', 'Kim’s draft, and Jane’s line', { member: KIM, base: '' })).reportAt, next.reportAt);
  // Emptied: nobody wrote it
  const gone = await saveReport(env, 'm_rep1', 'i_eve1', '', { member: KIM, base: next.reportAt });
  assert.deepEqual([gone.report, gone.reportBy, gone.reportAt], ['', '', '']);
});

test('a past meeting never shared, or its minutes approved: a member can’t write; an admin still can', async () => {
  const hidden = await world({ shared: false, date: '2020-11-05' });
  await assert.rejects(saveReport(hidden.env, 'm_rep1', 'i_gov1', 'Early', { member: ALEX }), (e) => e.status === 404);
  assert.equal((await saveReport(hidden.env, 'm_rep1', 'i_gov1', 'Early', { admin: true, adminEmail: 'jane@soardcharity.com' })).report, 'Early');
  // A meeting ahead not shared yet: who presents writes the report their email asked for (_board-asks.js); no one else
  const ahead = await world({ shared: false });
  assert.equal((await saveReport(ahead.env, 'm_rep1', 'i_gov1', 'Early', { member: ALEX })).report, 'Early');
  await assert.rejects(saveReport(ahead.env, 'm_rep1', 'i_gov1', 'Mine', { member: SAM }), (e) => e.status === 403);
  const done = await world({ minutes: 'approved' });
  await assert.rejects(saveReport(done.env, 'm_rep1', 'i_gov1', 'Late', { member: ALEX }), (e) => e.status === 409);
});

test('Board’s editor: a report it changes is stamped with the admin, one it didn’t keeps its writer', async () => {
  const { env } = await world();
  const alex = await saveReport(env, 'm_rep1', 'i_gov1', 'Alex wrote this', { member: ALEX, base: '' });
  const m = await getMeeting(env.DB, 'm_rep1');
  // The editor sends the whole meeting: Financial's report typed in Board, Governance's as Alex left it
  const edited = { ...m, sections: m.sections.map((s) => ({ ...s, items: s.items.map((it) => (it.id === 'i_fin1' ? { ...it, report: 'Typed in Board', reportBy: 'Someone Else', reportAt: '2000-01-01T00:00:00.000Z' } : it)) })) };
  const saved = await saveMeeting(env.DB, edited, { by: 'jane@soardcharity.com', base: m.updatedAt });
  assert.deepEqual([itemIn(saved, 'i_fin1').report, itemIn(saved, 'i_fin1').reportBy], ['Typed in Board', 'Jane Doe']);
  assert.notEqual(itemIn(saved, 'i_fin1').reportAt, '2000-01-01T00:00:00.000Z', 'the server says when, never the editor');
  assert.deepEqual([itemIn(saved, 'i_gov1').reportBy, itemIn(saved, 'i_gov1').reportAt], ['Alex Rivera', alex.reportAt]);
  // A stale editor (opened before Alex wrote) is refused, as any save is: it merges and saves again
  await assert.rejects(saveMeeting(env.DB, m, { by: 'jane@soardcharity.com', base: 'an-old-version' }), (e) => e.status === 409);
});

test('the report reaches the board page and the meeting as it’s held', async () => {
  const { env } = await world();
  await saveReport(env, 'm_rep1', 'i_fin1', '- Cash is **up**', { member: SAM, base: '' });
  const page = await portalData(env, { member: { ...SAM, group: 'board' } });
  assert.equal(itemIn(page.meetings.find((x) => x.id === 'm_rep1'), 'i_fin1').report, '- Cash is **up**');
  const v = await liveView(env, 'm_rep1', { member: SAM });
  assert.deepEqual([itemIn(v, 'i_fin1').report, itemIn(v, 'i_fin1').reportBy], ['- Cash is **up**', 'Sam Ortiz']);
});

test('the board email asks each presenter for their report, with the page to write it on', async () => {
  const { packetEmail, reportsFor } = await import('../functions/api/_board.js');
  const { env } = await world();
  await saveReport(env, 'm_rep1', 'i_fin1', 'Cash is up', { member: SAM, base: '' });
  const m = await getMeeting(env.DB, 'm_rep1');
  const people = PEOPLE.map(([slug, d]) => ({ slug, name: d.name }));
  const alex = reportsFor(m, 'alex-rivera', people);
  assert.deepEqual(alex.map((r) => [r.title, r.written]), [['Governance', false]]);
  assert.match(alex[0].url, /\/admin\/board\/#\/meetings\/m_rep1\/report\/i_gov1$/);
  assert.deepEqual(reportsFor(m, 'sam-ortiz', people).map((r) => r.written), [true]);
  assert.deepEqual(reportsFor(m, '', people), []);
  const mail = packetEmail(m, { name: 'Alex Rivera', reports: alex });
  assert.match(mail.html, /You present <strong>Governance<\/strong>/);
  assert.match(mail.text, /You present “Governance”\./);
  assert.match(mail.html, /Write your report/);
  assert.match(mail.text, /report\/i_gov1/);
  const done = packetEmail(m, { name: 'Sam Ortiz', reports: reportsFor(m, 'sam-ortiz', people) });
  assert.match(done.html, /Your report is in/);
  assert.doesNotMatch(packetEmail(m, { name: 'Kim Park' }).html, /You present/, 'nothing for someone who presents nothing');
});

test('a presenter puts a document with their item on the board page, and can take theirs off again', async () => {
  const { attachToItem, detachFromItem } = await import('../functions/api/_board.js');
  const { env } = await world();
  const store = new Map();
  env.FILES = { put: async (k, b) => { store.set(k, b); }, get: async (k) => (store.has(k) ? { body: store.get(k) } : null), delete: async (k) => { store.delete(k); } };
  const pdf = (name) => new File([new TextEncoder().encode('%PDF-1.4\n%fake\n')], name, { type: 'application/pdf' });
  const a = await attachToItem(env, 'm_rep1', 'i_fin1', pdf('Q3 balance sheet.pdf'), { member: SAM });
  assert.equal(a.file.kind, 'financials', 'filed by its name, as Board files one');
  assert.deepEqual(a.docs, [a.file.id]);
  assert.equal(store.size, 1);
  let m = await getMeeting(env.DB, 'm_rep1');
  assert.deepEqual(itemIn(m, 'i_fin1').docs, [a.file.id]);
  assert.equal(m.files.find((f) => f.id === a.file.id)?.staffOnly, false, 'the board sees it');
  await assert.rejects(attachToItem(env, 'm_rep1', 'i_fin1', pdf('mine.pdf'), { member: ALEX }), (e) => e.status === 403);
  await assert.rejects(attachToItem(env, 'm_rep1', 'i_fin1', new File(['hello'], 'notes.txt', { type: 'text/plain' }), { member: SAM }), (e) => e.status === 415);
  assert.equal(store.size, 1, 'nothing stored for a refused one');
  // Kim and Jane present Events: Kim takes off her own, never Jane's
  const jane = await attachToItem(env, 'm_rep1', 'i_eve1', pdf('Gala budget.pdf'), { admin: true, adminEmail: 'jane@soardcharity.com' });
  const kim = await attachToItem(env, 'm_rep1', 'i_eve1', pdf('Sponsors.pdf'), { member: KIM });
  await assert.rejects(detachFromItem(env, 'm_rep1', 'i_eve1', jane.file.id, { member: KIM }), (e) => e.status === 403);
  assert.deepEqual((await detachFromItem(env, 'm_rep1', 'i_eve1', kim.file.id, { member: KIM })).docs, [jane.file.id]);
  m = await getMeeting(env.DB, 'm_rep1');
  assert.equal(m.files.some((f) => f.id === kim.file.id), false, 'hers is gone for good');
  // An admin takes any off; the file stays with the meeting, as in Board
  await detachFromItem(env, 'm_rep1', 'i_eve1', jane.file.id, { admin: true, adminEmail: 'jane@soardcharity.com' });
  m = await getMeeting(env.DB, 'm_rep1');
  assert.deepEqual([itemIn(m, 'i_eve1').docs, m.files.some((f) => f.id === jane.file.id)], [[], true]);
});

test('an agenda drafted from the last meeting stops being a draft once a report is written in it (a new draft would lose it)', async () => {
  const { agendaIsDraft } = await import('../public/admin/board-shared.js');
  const drafted = { agendaFrom: { kind: 'last-meeting', name: 'Q3', v: 2 }, sections: [{ title: 'Committee reports', items: [{ id: 'i_gov1', title: 'Governance', presenter: 'Alex' }] }] };
  assert.equal(agendaIsDraft(drafted), true);
  assert.equal(agendaIsDraft({ ...drafted, sections: [{ ...drafted.sections[0], items: [{ ...drafted.sections[0].items[0], report: 'Bylaws drafted' }] }] }), false);
  assert.equal(agendaIsDraft({ sections: [] }), true, 'an empty one still is');
});

test('italic right beside bold, either way round, and inside a word, read back as written', () => {
  const md1 = roundTrip(doc(p(t('Note', 'italic'), t('Approve', 'bold'), t(' the budget'))));
  assert.equal(md1, '_Note_**Approve** the budget');
  roundTrip(doc(p(t('B', 'bold'), t('I', 'italic'))));
  roundTrip(doc(p(t('un'), t('believ', 'italic'), t('able'))));
  roundTrip(doc(p(t('a', 'italic'), t('b', 'bold', 'italic'), t('c', 'italic'))));
  roundTrip(doc(p(t('x', 'italic'), t('y', 'bold'), t('z', 'italic'))));
});

test('marks right against each other, no spaces, never lose or gain a mark (a random walk)', () => {
  let seed = 11;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const pick = () => [['bold'], ['italic'], ['bold', 'italic'], [], [link('https://x.org/a')], [link('https://x.org/a'), 'italic']][rnd(6)];
  const word = () => ['ab', 'Q4', 'x_y', '2026', 'café', 'it’s'][rnd(6)];
  for (let k = 0; k < 2000; k++) {
    const nodes = [];
    for (let j = 0; j < 2 + rnd(5); j++) nodes.push(t(word(), ...pick()));
    // Neighbours with the same marks are one node to the editor too
    const merged = nodes.reduce((acc, n) => { const last = acc.at(-1); if (last && JSON.stringify(last.marks || []) === JSON.stringify(n.marks || [])) last.text += n.text; else acc.push({ ...n }); return acc; }, []);
    roundTrip(doc(p(...merged)));
  }
});
