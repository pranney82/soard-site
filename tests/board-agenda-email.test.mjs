// The agenda email, as a board member reads it: what it says has to be true of this meeting, the agenda itself is in
// it, what they owe comes first, and nothing board-only is named
import test from 'node:test';
import assert from 'node:assert/strict';
import { packetEmail, agendaParts, reportsFor, packetDocs, sendPacket, saveMeeting, saveDoc, putFile } from '../functions/api/_board.js';
import { chairEmail } from '../functions/api/_board-asks.js';
import { createD1 } from './lib/d1-shim.mjs';
import { minutesToRead, namesAlike } from '../public/admin/board-shared.js';

const meeting = (more = {}) => ({
  id: 'm_jan14', date: '2027-01-14', start: '08:00', end: '10:00', location: '', address: '', video: 'https://meet.google.com/abc-defg-hij', inviteNote: '', files: [],
  sections: [
    { id: 's_a', title: 'Call to order', minutes: 15, items: [{ id: 'i_1', title: 'Roll call' }, { id: 'i_2', title: '' }] },
    { id: 's_b', title: 'Approve meeting minutes', minutes: 10, items: [{ id: 'i_3', title: 'Minutes of the Q4 2026 Board Meeting', live: 'minutes' }] },
    { id: 's_c', title: 'Committee reports', minutes: 60, items: [
      { id: 'i_4', title: 'Financial', who: ['sam-ortiz'], motion: 'Move to approve the 2027 budget as presented.' },
      { id: 'i_5', title: 'Legal update', presenter: 'Dana Secret', confidential: true, motion: 'Move to settle with the insurer.' },
      { id: 'i_6', title: '', live: 'cash' },
    ] },
    { id: 's_d', title: 'New business', minutes: 15, items: [] },
    { id: 's_e', title: '', items: [] },
  ],
  ...more,
});
const PEOPLE = [{ slug: 'sam-ortiz', name: 'Sam Ortiz' }];
const words = (html) => html.replace(/<style>[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/&#\d+;/g, '').replace(/\s+/g, ' ');
const NOTHING = { ask: false };

test('a meeting with no documents never says it has some: not in the subject, the heading, the button, or the text', () => {
  const mail = packetEmail(meeting(), { ...NOTHING });
  assert.equal(mail.subject, 'Agenda: Q1 2027 Board Meeting, Jan 14');
  assert.ok(mail.subject.length <= 40, 'the words a phone shows hold what it is and when');
  assert.doesNotMatch(words(mail.html), /document/i);
  assert.doesNotMatch(mail.text, /document/i);
  assert.match(mail.html, />Q1 2027 Board Meeting agenda<\/h1>/);
  assert.match(mail.html, /Open the agenda</);
});

test('documents are counted once and named under the agenda, a board-only one counted and never named', () => {
  const one = packetEmail(meeting(), { ...NOTHING, name: 'Alex Rivera', files: ['Balance sheet.pdf'] });
  assert.match(one.html, /Alex, please read the agenda and the document before the meeting\. They’re on the board page, and you can print it all from there\./);
  assert.ok(one.html.indexOf('Balance sheet') > one.html.indexOf('On the agenda'));
  const both = packetEmail(meeting(), { ...NOTHING, files: ['Balance sheet.pdf'], private: 2 });
  assert.match(both.html, /Please read the agenda and the 3 documents/);
  assert.match(both.html, /2 board-only documents/);
  assert.match(both.text, /Documents: Balance sheet, 2 board-only documents/);
  assert.doesNotMatch(both.subject, /document/i, 'the subject stays short');
});

test('the agenda is in the email: when each part starts, its items and who presents', () => {
  const mail = packetEmail(meeting(), { ...NOTHING, people: PEOPLE });
  const said = words(mail.html);
  assert.match(said, /On the agenda/);
  assert.match(said, /8:00 AM Call to order Roll call/);
  assert.match(said, /8:25 AM Committee reports Financial · Sam Ortiz/);
  assert.match(said, /Minutes of the Q4 2026 Board Meeting/);
  assert.match(said, /The money/, 'an item with no title reads as what it shows');
  assert.match(said, /New business/, 'a part with nothing in it yet still shows');
  assert.match(mail.text, /8:25 AM {2}Committee reports\n- Financial \(Sam Ortiz\)\n/);
  assert.equal(agendaParts(meeting(), PEOPLE).length, 4, 'a blank part and a blank row are left out');
});

test('a board-only item is counted, and nothing about it reaches the email', () => {
  const mail = packetEmail(meeting(), { ...NOTHING, people: PEOPLE });
  for (const out of [mail.html, mail.text]) {
    assert.doesNotMatch(out, /Legal update|Dana Secret|settle with the insurer/);
    assert.match(out, /1 board-only item/);
  }
});

test('a meeting with no time still reads, its parts without one', () => {
  const m = meeting({ start: '', end: '' });
  assert.deepEqual(agendaParts(m).map((p) => p.at), ['', '', '', '']);
  assert.match(packetEmail(m, { ...NOTHING }).text, /^Call to order\n- Roll call$/m);
});

test('what they owe comes first, soonest first, each once; someone who owes nothing gets no such part', () => {
  const owes = packetEmail(meeting(), {
    name: 'Sam Ortiz', from: 'Jordan Ellis', minutes: { id: 'm_q4', date: '2026-11-05' }, toSign: ['Board Member Expectations'],
    reports: [{ title: 'Financial', url: 'https://x/board/m/report/i', written: false }],
  });
  const at = (s) => owes.html.indexOf(s);
  const order = ['Open the agenda', 'Before the meeting', 'Will you be there?', 'You present', 'Read before the vote', 'Still to sign for', 'On the agenda'];
  assert.deepEqual(order.map(at).slice().sort((a, b) => a - b), order.map(at));
  assert.ok(order.every((s) => at(s) > 0));
  assert.ok(owes.text.indexOf('BEFORE THE MEETING') < owes.text.indexOf('ON THE AGENDA'));
  assert.match(owes.html, /4 things for you before the meeting/, 'the line an inbox shows beside the subject says so');
  const free = packetEmail(meeting(), { ...NOTHING });
  assert.doesNotMatch(free.html + free.text, /before the meeting<\/p>|BEFORE THE MEETING/);
  assert.match(free.html, /Read the agenda before the meeting\./);
});

test('one paper to sign reads as one, several as several', () => {
  const one = packetEmail(meeting(), { ...NOTHING, toSign: ['Board Member Expectations'] });
  assert.match(one.html, /signs this once a year\. Read it on the board page/);
  assert.doesNotMatch(one.html, /signs these/);
  const two = packetEmail(meeting(), { ...NOTHING, toSign: ['Board Member Expectations', 'Conflict of Interest Policy'] });
  assert.match(two.html, /signs these once a year\. Read them on the board page/);
});

test('reports: one, several, and some in already each read right, and a long title can’t push a phone’s email wide', () => {
  const r = (title, written = false) => ({ title, url: `https://x/${encodeURIComponent(title)}`, written });
  const long = 'Project updates and upcoming reveals';
  const one = packetEmail(meeting(), { ...NOTHING, reports: [r(long)] });
  assert.match(one.html, />Write your report</);
  const two = packetEmail(meeting(), { ...NOTHING, reports: [r(long), r('Financial')] });
  assert.match(two.html, /Write your reports on the board page\. The board reads them there before the meeting, and they’re on the screen/);
  assert.match(two.html, new RegExp(`>Write your report on ${long}<`));
  assert.doesNotMatch(two.html, new RegExp(`nowrap[^>]*>Write your report on ${long}`), 'a link, which wraps');
  assert.match(two.html, /You present <strong>Project updates and upcoming reveals<\/strong> and <strong>Financial<\/strong>/, 'only the names bold, so they read as two');
  const mixed = packetEmail(meeting(), { ...NOTHING, reports: [r(long, true), r('Financial')] });
  assert.match(mixed.html, /Write your report on the board page/);
  assert.match(mixed.html, new RegExp(`>Your report on ${long}<`));
  assert.match(packetEmail(meeting(), { ...NOTHING, reports: [r(long, true), r('Financial', true)] }).html, /Your reports are in\. You can change them on the board page/);
});

test('a preview says what a real email leaves out: no place, and the meeting’s year on what’s to sign', () => {
  const preview = packetEmail(meeting(), { test: true, toSign: ['Board Member Expectations'] });
  assert.equal(preview.subject, '[Preview] Agenda: Q1 2027 Board Meeting, Jan 14');
  assert.match(preview.html, /No place on this meeting yet/);
  assert.match(preview.html, /Still to sign for 2027/);
  const real = packetEmail(meeting(), {});
  assert.doesNotMatch(real.html + real.text, /No place on this meeting/);
  const placed = packetEmail(meeting({ location: 'Example Design Group' }), { test: true });
  assert.doesNotMatch(placed.html, /No place on this meeting/);
  assert.match(placed.html, /Example Design Group/);
});

test('what people typed is escaped, there are no long dashes, and a full agenda stays under Gmail’s clipping size', () => {
  const m = meeting();
  m.sections[0].items[0].title = '<img src=x onerror=alert(1)> Roll & call';
  m.sections[2].items[0].presenter = 'Sam <b>approve</b>';
  m.sections[2].items[0].who = [];
  const mail = packetEmail(m, { people: PEOPLE, from: 'Jordan', minutes: { id: 'm_q4', date: '2026-11-05' }, toSign: ['Board Member Expectations'] });
  assert.doesNotMatch(mail.html, /<img src=x|<b>approve/);
  assert.match(mail.html, /&lt;img src=x onerror=alert\(1\)&gt; Roll &amp; call/);
  assert.doesNotMatch(words(mail.html) + mail.text, /—/);
  const full = meeting({ sections: Array.from({ length: 12 }, (_, s) => ({ id: `s_${s}`, title: `Part ${s + 1} of the meeting`, items: Array.from({ length: 12 }, (_u, i) => ({ id: `i_${s}_${i}`, title: `An agenda item with a good long title, number ${i}`, presenter: 'Kim Park & Jordan Ellis', motion: i % 3 ? '' : 'Move to approve this as it was presented to the board.' })) })) });
  const big = packetEmail(full, { files: Array.from({ length: 30 }, (_, i) => `Document number ${i}.pdf`) });
  assert.ok(new TextEncoder().encode(big.html).length < 100_000, `${new TextEncoder().encode(big.html).length} bytes`);
});

test('each agenda item sits on its own line with air around it, so a wrapped line can’t read as the next one', () => {
  const mail = packetEmail(meeting(), { ...NOTHING, people: PEOPLE });
  assert.match(mail.html, /<strong>Call to order<\/strong><p style="margin:4px 0 0;"><span[^>]*>Roll call<\/span><\/p>/);
});

test('someone who presents a board-only item is told so without its name, and only the link says which', () => {
  const m = meeting();
  const reports = reportsFor(m, 'dana-secret', [{ slug: 'dana-secret', name: 'Dana Secret' }]);
  assert.equal(reports.length, 1);
  assert.equal(reports[0].title, '', 'its name never leaves the agenda');
  const mail = packetEmail(m, { ...NOTHING, reports });
  for (const out of [mail.html, mail.text, mail.subject]) assert.doesNotMatch(out, /Legal update|settle with the insurer/);
  assert.match(mail.html, /You present <strong>a board-only item<\/strong>/);
  assert.match(mail.html, /report\/i_5/);
  const both = packetEmail(m, { ...NOTHING, reports: [...reports, { title: 'Financial', url: 'https://x/f', written: true }, { ...reports[0], url: 'https://x/2' }] });
  assert.match(both.html, /You present <strong>Financial<\/strong> and <strong>2 board-only items<\/strong>/);
  assert.match(both.text, /You present “Financial” and 2 board-only items\./);
});

test('a report already in isn’t counted as something they owe', () => {
  const mail = packetEmail(meeting(), { ...NOTHING, reports: [{ title: 'Financial', url: 'https://x/f', written: true }] });
  assert.match(mail.html, /Read the agenda before the meeting\./);
  assert.doesNotMatch(mail.html, /thing for you/);
  assert.match(mail.html, /Your report is in\. You can change it on the board page until the meeting\./);
});

test('an item with no title of its own reads the same in the report ask as on the agenda', () => {
  const m = meeting();
  m.sections[2].items[2].who = ['sam-ortiz'];
  const reports = reportsFor(m, 'sam-ortiz', PEOPLE);
  assert.deepEqual(reports.map((r) => r.title), ['Financial', 'The money']);
  const mail = packetEmail(m, { ...NOTHING, reports });
  assert.match(mail.html, /You present <strong>Financial<\/strong> and <strong>The money<\/strong>/);
  const blank = meeting({ sections: [{ id: 's_x', title: '', items: [{ id: 'i_x', title: '', presenter: 'Sam Ortiz' }] }] });
  assert.deepEqual(agendaParts(blank).map((p) => p.open), [[{ title: '', by: 'Sam Ortiz' }]]);
  assert.doesNotMatch(packetEmail(blank, { ...NOTHING }).text, /Item|^- \s/m);
  assert.equal(reportsFor(blank, 'sam-ortiz', PEOPLE)[0].title, 'an agenda item');
});

test('a document kept as a PDF and a Word file is one document, as on the board page', () => {
  const f = (id, name) => ({ id, name, kind: 'other', staffOnly: false, at: `2026-11-0${id.length}` });
  const docs = packetDocs({ sections: [], files: [f('a', 'Q4 balance sheet.pdf'), f('bb', 'Q4 balance sheet.xlsx'), f('c', 'Gala plan.pdf')] });
  assert.equal(docs.names.length, 2);
  assert.equal(docs.hidden, 0);
  // Two files that only share a name, on different items, are two; the same file on two items is one; a report's photo is none
  const part = (items) => [{ id: 's_x', title: 'Reports', items }];
  const apart = packetDocs({ sections: part([{ id: 'i_a', title: 'A', docs: ['a'] }, { id: 'i_b', title: 'B', docs: ['bb', 'c'] }]), files: [f('a', 'Report.pdf'), f('bb', 'Report (1).pdf'), { ...f('c', 'IMG_4021.jpg'), kind: 'side' }] });
  assert.equal(apart.names.length, 2);
  assert.equal(packetDocs({ sections: part([{ id: 'i_a', title: 'A', docs: ['a'] }, { id: 'i_b', title: 'B', docs: ['a'] }]), files: [f('a', 'Report.pdf')] }).names.length, 1);
  // The same document in two formats on two items is one; two files that happen to share a name are two, board-only or not
  assert.equal(packetDocs({ sections: part([{ id: 'i_a', title: 'A', docs: ['a'] }, { id: 'i_b', title: 'B', docs: ['bb'] }]), files: [f('a', 'Q4 balance sheet.pdf'), f('bb', 'Q4 balance sheet.xlsx')] }).names.length, 1);
  assert.equal(packetDocs({ sections: part([{ id: 'i_a', title: 'A', confidential: true, docs: ['a'] }, { id: 'i_b', title: 'B', confidential: true, docs: ['bb'] }]), files: [f('a', 'Report.pdf'), f('bb', 'Report (1).pdf')] }).hidden, 2);
  // One document's copies on one item, one of them on another item too, is still one
  assert.equal(packetDocs({ sections: part([{ id: 'i_a', title: 'A', docs: ['a', 'bb'] }, { id: 'i_b', title: 'B', docs: ['a'] }]), files: [f('a', 'Balance sheet.pdf'), f('bb', 'Balance sheet.xlsx')] }).names.length, 1);
  // A copy left loose is still the one on the item
  assert.equal(packetDocs({ sections: part([{ id: 'i_a', title: 'A', docs: ['a'] }]), files: [f('a', 'Q4 balance sheet.pdf'), f('bb', 'Q4 balance sheet.xlsx')] }).names.length, 1);
});

test('a guest’s name stays as it was typed, and a picked member’s comes from People', () => {
  const m = meeting({ sections: [{ id: 's_x', title: 'Reports', items: [{ id: 'i_a', title: 'Audit', presenter: 'Dana Smith, CPA' }, { id: 'i_b', title: 'Tax', presenter: 'A&M Partners' }, { id: 'i_c', title: 'Money', who: ['sam-ortiz'], presenter: 'Old name' }] }] });
  assert.deepEqual(agendaParts(m, PEOPLE)[0].open.map((it) => it.by), ['Dana Smith, CPA', 'A&M Partners', 'Sam Ortiz']);
});

test('what people typed reads right: a title that says agenda, and minutes of a meeting called The anything', () => {
  const typed = packetEmail(meeting({ title: 'Q1 Board Meeting - Agenda' }), { ...NOTHING, minutes: { id: 'm_x', title: 'The January Board Meeting' } });
  assert.match(typed.html, />Q1 Board Meeting - Agenda<\/h1>/);
  assert.equal(typed.subject, 'Q1 Board Meeting - Agenda, Jan 14');
  assert.equal(packetEmail(meeting({ title: 'Agenda for the Q1 Meeting' }), { ...NOTHING, test: true }).subject, '[Preview] Agenda for the Q1 Meeting, Jan 14');
  assert.match(packetEmail(meeting({ title: 'Agenda' }), { ...NOTHING }).html, />Agenda<\/h1>/);
  assert.match(typed.html, /The minutes of the January Board Meeting/);
});

test('with no date, no sections, or a Meet link only on the invite, it still reads', () => {
  const none = packetEmail(meeting({ date: '', start: '', end: '', video: '' }), { ...NOTHING });
  assert.equal(none.subject, 'Agenda: Board meeting');
  assert.doesNotMatch(none.text, /^When:/m);
  assert.doesNotMatch(none.html, /\. \.|meeting\. <|\.\./);
  const docsOnly = packetEmail(meeting({ sections: [] }), { ...NOTHING, files: ['Gala plan.pdf'] });
  assert.doesNotMatch(docsOnly.html, /On the agenda/);
  assert.match(docsOnly.html, /Documents<\/h2>/);
  const bare = packetEmail(meeting({ sections: [] }), { ...NOTHING });
  assert.doesNotMatch(bare.html, /On the agenda|Documents<\/h2>/);
  const meet = packetEmail(meeting({ video: '', invite: { meet: 'https://meet.google.com/abc-defg-hij' } }), { ...NOTHING });
  assert.match(meet.html, /meet\.google\.com\/abc-defg-hij/);
  assert.match(meet.text, /Video \(Google Meet\): https:\/\/meet\.google\.com\/abc-defg-hij/);
});

test('a board-only document stays unnamed even with another copy of it left somewhere else', () => {
  const f = (id, name) => ({ id, name, kind: 'other', staffOnly: false, at: '2026-11-01' });
  const m = { sections: [{ id: 's_x', title: 'Legal', items: [{ id: 'i_a', title: 'Settlement', confidential: true, docs: ['a'] }, { id: 'i_b', title: 'Open', docs: ['a', 'c'] }] }], files: [f('a', 'Smith settlement memo.pdf'), f('b', 'Smith settlement memo.docx'), f('c', 'Gala plan.pdf')] };
  assert.deepEqual(packetDocs(m), { names: ['Gala plan.pdf'], hidden: 1 });
  // Its twin stays out even when the board-only item's own copy could never be sent
  for (const shut of [{ staffOnly: true }, { kind: 'side' }]) {
    const twin = { sections: [{ id: 's_x', title: 'Legal', items: [{ id: 'i_a', title: 'Settlement', confidential: true, docs: ['a'] }] }], files: [{ ...f('a', 'Smith settlement memo.pdf'), ...shut }, f('b', 'Smith settlement memo.docx')] };
    assert.deepEqual(packetDocs(twin), { names: [], hidden: 0 });
  }
  // One file on two board-only items is counted once
  const both = { sections: [{ id: 's_x', title: 'Legal', items: [{ id: 'i_a', title: 'A', confidential: true, docs: ['a'] }, { id: 'i_b', title: 'B', confidential: true, docs: ['a'] }] }], files: [f('a', 'Memo.pdf')] };
  assert.deepEqual(packetDocs(both), { names: [], hidden: 1 });
});

test('a part named only by its board-only item keeps that name out too, and a blank row isn’t called board-only', () => {
  const secret = meeting({ sections: [{ id: 's_x', title: 'Smith settlement', items: [{ id: 'i_a', title: '', confidential: true }] }] });
  const mail = packetEmail(secret, { ...NOTHING });
  assert.doesNotMatch(mail.html + mail.text, /Smith settlement/);
  assert.match(mail.html, /1 board-only item/);
  const part = (items) => meeting({ sections: [{ id: 's_y', title: 'Legal', items }] });
  assert.equal(agendaParts(part([{ id: 'i_a', title: 'Settlement', confidential: true }, { id: 'i_b', title: 'Insurance renewal' }]))[0].title, 'Legal', 'beside an open item, one with its own name leaves the part’s alone');
  assert.equal(agendaParts(part([{ id: 'i_a', title: 'Settlement', confidential: true }]))[0].title, '', 'a part of only board-only items says nothing of them');
  assert.equal(agendaParts(part([{ id: 'i_a', title: 'legal ', confidential: true }, { id: 'i_b', title: 'Insurance renewal' }]))[0].title, '', 'nor does a part named what its board-only item is');
  assert.equal(agendaParts(meeting({ sections: [{ id: 's_y', title: 'Smith settlement discussion', items: [{ id: 'i_a', title: 'Smith settlement', confidential: true }, { id: 'i_b', title: 'Insurance renewal' }] }] }))[0].title, '', 'or nearly so');
  assert.equal(agendaParts(meeting({ sections: [{ id: 's_y', title: 'Current business', items: [{ id: 'i_a', title: 'Rent', confidential: true }, { id: 'i_b', title: 'Insurance renewal' }] }] }))[0].title, 'Current business', 'whole words only');
  // …and their presenter isn't told it by way of an open item with no name beside them
  const beside = meeting({ sections: [{ id: 's_z', title: 'Smith settlement', items: [{ id: 'i_a', title: '', confidential: true }, { id: 'i_b', title: '', who: ['sam-ortiz'] }] }] });
  assert.equal(reportsFor(beside, 'sam-ortiz', PEOPLE)[0].title, 'an agenda item');
  const notes = agendaParts(meeting({ sections: [{ id: 's_z', title: '', items: [{ id: 'i_n', notes: 'x' }] }] }));
  assert.deepEqual(notes, [], 'a row with only a note says nothing');
});

test('two board-only reports can be told apart', () => {
  const r = (url, written) => ({ title: '', url, written, private: true });
  const mail = packetEmail(meeting(), { ...NOTHING, reports: [r('https://x/1', false), r('https://x/2', true)] });
  assert.match(mail.html, />Write your report on board-only item 1</);
  assert.match(mail.html, />Your report on board-only item 2</);
  assert.match(mail.text, /Write your report on board-only item 1: https:\/\/x\/1\nYour report on board-only item 2: https:\/\/x\/2/, 'the text says which is still owed too');
  const same = packetEmail(meeting(), { ...NOTHING, reports: [{ title: 'New business', url: 'https://x/1', written: false }, { title: 'New business', url: 'https://x/2', written: false }] });
  assert.match(same.html, /You present <strong>New business<\/strong><\/p>/, 'said once');
  assert.match(same.html, />Write your report on New business \(1\)</);
  assert.match(same.html, />Write your report on New business \(2\)</);
});

test('an item with no name doesn’t repeat its part, and one that is only a motion leaves no row', () => {
  const m = meeting({ sections: [{ id: 's_x', title: 'New business', minutes: 10, items: [{ id: 'i_a', title: '', presenter: 'Jordan Ellis' }, { id: 'i_b', title: '', motion: 'Move to adjourn.' }] }] });
  const mail = packetEmail(m, { ...NOTHING });
  assert.equal((words(mail.html).match(/New business/g) || []).length, 1);
  assert.match(words(mail.html), /New business Jordan Ellis/);
  assert.equal(agendaParts(m)[0].open.length, 1);
  assert.doesNotMatch(mail.html, /<p style="margin:4px 0 0;"><br>|<br><br>/);
  assert.match(mail.text, /^- \(Jordan Ellis\)$/m);
});

test('a meeting with no times stacks its parts, with no empty column beside them', () => {
  const mail = packetEmail(meeting({ start: '', end: '' }), { ...NOTHING, files: ['Gala plan.pdf'] });
  const list = mail.html.slice(mail.html.indexOf('On the agenda'));
  assert.doesNotMatch(list, /width:1%/);
  assert.match(words(mail.html), /Documents Gala plan/);
  const docsOnly = packetEmail(meeting({ sections: [] }), { ...NOTHING, files: ['Gala plan.pdf'] });
  assert.doesNotMatch(docsOnly.html.slice(docsOnly.html.indexOf('Documents</h2>')), /width:1%/);
});

test('a staff-only file beside the minutes does not stop the email sending the board to read them', () => {
  const m = meeting();
  m.sections[1].items[0].about = 'm_oct';
  const oct = { id: 'm_oct', date: '2026-10-08', shared: true, minutes: 'draft', sections: [], files: [{ id: 'f1', name: 'Minutes.pdf', kind: 'minutes' }, { id: 'f2', name: 'Staff notes.pdf', kind: 'minutes', staffOnly: true }] };
  assert.equal(minutesToRead(m, [oct, m])?.id, 'm_oct');
  assert.equal(minutesToRead(m, [{ ...oct, files: [oct.files[1]] }, m]), null, 'only a staff-only file: nothing there to read');
});

test('a name is alike in any order, by whole words, and the plain headings of an agenda stay apart', () => {
  for (const [a, b] of [['Smith settlement memo', 'Copy of Smith settlement memo'], ['Smith settlement memo', 'Smith settlement memo (Final v2)'], ['Smith settlement', 'Settlement with Smith'], ['Smith lawsuit settlement', 'Legal: Smith lawsuit'], ['Settlements', 'Settlement'], ['Reveals', 'Upcoming reveals'], ['Mirrowens (signed)', 'Copy of Mirrowens'], ['Memo final', 'Memo v2'], ['990', 'Copy of 990'], ['990', '990 final'], ['990', '2025 990 final'], ['990', 'Form 990'], ['Final', 'Copy of Final'], ['Draft', 'Draft v2'], ['Copy', 'Final copy'], ['Pe\u00f1a settlement', 'Pen\u0303a settlement'], ['Pena settlement', 'Pe\u00f1a settlement']]) assert.ok(namesAlike(a, b), `${a} / ${b}`);
  for (const [a, b] of [['Rent', 'Current business'], ['New hire', 'New business'], ['Legal report', 'Committee reports'], ['Executive session', 'Executive summary'], ['', 'New business'], ['', ''], ['Budget 2026', 'Budget 2027']]) assert.ok(!namesAlike(a, b), `${a} / ${b}`);
  for (const name of ['990', 'Final', 'The']) assert.ok(namesAlike(name, name), `${name} is itself`);
});

test('a board-only name stays out however it is reworded, in a document and in a part', () => {
  const shut = (loose, title = 'Hearing') => packetDocs({ sections: [{ id: 's', title: 'Legal', items: [{ id: 'i', title, confidential: true, docs: ['f1'] }] }], files: [{ id: 'f1', name: 'Smith settlement memo.pdf' }, { id: 'f2', name: loose }, { id: 'f3', name: 'Balance sheet.pdf' }] });
  for (const name of ['Copy of Smith settlement memo.pdf', 'Smith settlement memo (Copy).pdf', 'Smith settlement memo v2.pdf', 'Smith settlement memo final.docx']) assert.deepEqual(shut(name), { names: ['Balance sheet.pdf'], hidden: 1 }, name);
  assert.deepEqual(shut('Hearing notes.pdf'), { names: ['Balance sheet.pdf'], hidden: 1 }, 'a file named for the item itself');
  const part = (title, item) => agendaParts({ start: '08:00', end: '10:00', sections: [{ id: 's', title, items: [item, { id: 'o', title: 'Insurance renewal' }] }] })[0].title;
  assert.equal(part('Settlement with Smith', { id: 'c', title: 'Smith settlement', confidential: true }), '');
  assert.equal(part('Legal: Smith lawsuit', { id: 'c', title: 'Smith lawsuit settlement', confidential: true }), '');
  assert.equal(part('Settlements', { id: 'c', title: 'Settlement', confidential: true }), '');
  assert.equal(part('Upcoming reveals', { id: 'c', live: 'reveals', confidential: true }), '', 'a live list goes by the name it shows under');
  assert.equal(part('New business', { id: 'c', title: 'New hire', confidential: true }), 'New business', 'one common word says nothing');
  const elsewhere = { start: '08:00', end: '10:00', files: [{ id: 'f1', name: 'Smith claim.pdf' }], sections: [{ id: 'a', title: 'Claim with Smith', items: [] }, { id: 'b', title: 'Closing', items: [{ id: 'c', title: '', live: 'cash', confidential: true, docs: ['f1'] }, { id: 'o', title: 'Insurance renewal' }] }] };
  assert.deepEqual(agendaParts(elsewhere).map((p) => p.title), ['Closing'], 'a part says nothing of a board-only item in another part, or of its document');
});

test('a motion or a vote never goes out by email: not its words, its figures, or a mark, and a board-only minutes item stays counted', () => {
  const m = meeting();
  m.sections[2].items[0].motion = 'Move to spend $48,500 from the reserve on the Carter makeover.';
  const mail = packetEmail(m, { ...NOTHING, name: 'Alex Rivera', people: PEOPLE });
  for (const said of [mail.subject, words(mail.html), mail.text]) {
    assert.doesNotMatch(said, /48,500|reserve|Carter|Move to/);
    assert.doesNotMatch(said, /\bvote\b/i, 'with no minutes to read, the word isn’t in it at all');
  }
  assert.match(words(mail.html), /Financial · Sam Ortiz/);
  const shut = meeting();
  shut.sections[1].items[0].confidential = true;
  assert.doesNotMatch(words(packetEmail(shut, { ...NOTHING }).html), /Minutes of the Q4/, 'a board-only minutes item stays only counted');
});

test('the signing row says when a paper is due, and why someone who signed is asked again', () => {
  const papers = [{ title: 'Conflict of interest', id: 'd1', written: true, due: '2099-03-01', changed: true }];
  const mail = packetEmail(meeting(), { ...NOTHING, toSign: papers });
  assert.match(words(mail.html), /Conflict of interest \(by March 1\)/);
  assert.match(words(mail.html), /This changed since you signed\. Read it on the board page/);
  assert.match(mail.text, /Conflict of interest \(by March 1\)\. This changed since you signed\./);
  const late = packetEmail(meeting(), { ...NOTHING, toSign: [{ title: 'Bylaws', due: '2020-03-01' }, { title: 'Ethics', changed: true }] });
  assert.match(words(late.html), /Bylaws \(was due March 1\)/);
  assert.match(words(late.html), /Every board member signs these once a year\. Read them on the board page/, 'only when every paper changed does it say so');
});

// The real send, on an in-memory database with Resend answered here
async function sending(fn) {
  const env = { DB: await createD1(), FILES: { put: async () => {}, get: async () => null, delete: async () => {} }, RESEND_API_KEY: 'test-key' };
  await env.DB.exec('CREATE TABLE team (slug TEXT PRIMARY KEY, name TEXT, "group" TEXT, order_num INTEGER, data TEXT NOT NULL, updated_at TEXT)');
  await env.DB.exec('CREATE TABLE reveal_board_emails (slug TEXT PRIMARY KEY, email TEXT NOT NULL, updated_at TEXT)');
  await env.DB.exec('CREATE TABLE site_config (key TEXT PRIMARY KEY, data TEXT, updated_at TEXT)');
  await env.DB.prepare('INSERT INTO team (slug, name, "group", data) VALUES (?, ?, ?, ?)').bind('sam-ortiz', 'Sam Ortiz', 'board', JSON.stringify({ name: 'Sam Ortiz', group: 'board', title: 'Board Member' })).run();
  await env.DB.prepare('INSERT INTO reveal_board_emails (slug, email) VALUES (?, ?)').bind('sam-ortiz', 'sam.board@example.org').run();
  const sent = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    sent.push(...[body].flat());
    return new Response(JSON.stringify(Array.isArray(body) ? { data: body.map((_, i) => ({ id: `r${i}` })) } : { id: 'r0' }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  try { return await fn(env, sent); } finally { globalThis.fetch = real; }
}

test('an empty agenda is never emailed to the board, while the preview still shows how it would look', () => sending(async (env, sent) => {
  await saveMeeting(env.DB, { ...meeting({ id: 'm_empty', date: '2020-01-14', shared: true }), sections: [] }, { by: 'test' });
  await assert.rejects(sendPacket(env, 'm_empty', { by: 'test' }), (e) => e.status === 409 && /agenda is empty/.test(e.message));
  assert.equal(sent.length, 0);
  await sendPacket(env, 'm_empty', { by: 'test', to: ['me@example.org'] });
  assert.equal(sent.length, 1);
}));

test('a paper only staff can open is not asked for: the agenda email goes by the same rule as the board page', () => sending(async (env, sent) => {
  await saveMeeting(env.DB, meeting({ id: 'm_real', date: '2020-01-14', shared: true }), { by: 'test' });
  await saveDoc(env.DB, { title: 'Open bylaws', shared: true, sign: true, body: 'The words.' }, { by: 'test' });
  const shut = await saveDoc(env.DB, { title: 'Staff copy only', shared: true, sign: true }, { by: 'test' });
  await putFile(env, { ownerType: 'doc', ownerId: shut.id, file: new File(['%PDF-1.4\n%made up\n'], 'staff.pdf', { type: 'application/pdf' }), staffOnly: true, by: 'test' });
  await sendPacket(env, 'm_real', { by: 'test', to: ['me@example.org'] });
  assert.match(sent[0].html, /Open bylaws/);
  assert.doesNotMatch(sent[0].html + sent[0].text, /Staff copy only/);
}));

test('a board-only file stays unnamed when it is also on an open item, or under a name with no words in it', () => {
  const doc = (name, more = {}) => ({ id: name, name, ...more });
  const two = (files, open) => packetDocs({ files, sections: [{ id: 's', title: 'Finance', items: [{ id: 'c', title: 'Tax', confidential: true, docs: [files[0].id] }, { id: 'o', title: 'Budget', docs: open }] }] });
  assert.deepEqual(two([doc('990.pdf')], ['990.pdf']), { names: [], hidden: 1 });
  assert.deepEqual(two([doc('990.pdf'), doc('990.docx')], []), { names: [], hidden: 1 }, 'another format of it, not on any item');
  assert.deepEqual(two([doc('Final.pdf'), doc('Final.docx')], ['Final.docx']), { names: [], hidden: 1 });
});

test('an item with no name goes by its part, so that name stays out everywhere, the chair’s review included', () => {
  const m = { id: 'm', date: '2027-01-14', start: '08:00', end: '10:00', files: [{ id: 'f', name: 'Smith settlement memo.pdf' }, { id: 'g', name: 'Balance sheet.pdf' }], sections: [
    { id: 'a', title: 'Smith settlement', items: [{ id: 'c', title: '', presenter: 'Dana Secret', confidential: true }, { id: 'o', title: 'Insurance renewal' }] },
    { id: 'b', title: 'Smith settlement next steps', items: [{ id: 'p', title: 'Staffing' }] },
    { id: 'e', title: 'Closing', items: [{ id: 'q', title: 'Adjourn' }] },
  ] };
  assert.deepEqual(packetDocs(m).names, ['Balance sheet.pdf']);
  assert.deepEqual(agendaParts(m).map((p) => p.title), ['', '', 'Closing']);
  const review = chairEmail({ m, chair: { name: 'Alex Rivera' }, from: { name: 'Max Doe' }, asks: [], people: [], cc: [] });
  assert.doesNotMatch(review.text + review.html, /Smith/);
  assert.match(review.text, /A board-only part \(on the board page\)/);
  assert.match(review.text, /Closing/);
});

test('the inbox line counts what the email lists, not its rows', () => {
  const papers = ['One', 'Two', 'Three'].map((title) => ({ title }));
  assert.match(packetEmail(meeting(), { ...NOTHING, toSign: papers }).html, /3 things for you before the meeting/);
  const both = packetEmail(meeting(), { ...NOTHING, toSign: papers, reports: [{ title: 'Financial', url: 'u', written: false }, { title: 'Bylaws', url: 'v', written: false }] });
  assert.match(both.html, /5 things for you before the meeting/);
  assert.match(packetEmail(meeting(), { ...NOTHING, toSign: [papers[0]] }).html, /1 thing for you before the meeting/);
});

test('a preview shows the year and the deadlines the real email will, in the meeting’s year', () => sending(async (env, sent) => {
  await saveMeeting(env.DB, meeting({ id: 'm_far', date: '2099-01-14', shared: true }), { by: 'test' });
  await saveDoc(env.DB, { title: 'Open bylaws', shared: true, sign: true, body: 'The words.', due: '03-01' }, { by: 'test' });
  await sendPacket(env, 'm_far', { by: 'test', to: ['me@example.org'] });
  assert.match(sent[0].text, /Still to sign for 2099: Open bylaws \(by March 1\)/);
}));

test('an agenda that can be approved can always be sent, even one that is only a motion', () => sending(async (env, sent) => {
  await saveMeeting(env.DB, { ...meeting({ id: 'm_one', date: '2020-01-14', shared: true }), sections: [{ id: 's_x', title: '', items: [{ id: 'i_x', title: '', motion: 'Move to adjourn.' }] }] }, { by: 'test' });
  await sendPacket(env, 'm_one', { by: 'test' });
  assert.equal(sent.length, 1);
  assert.doesNotMatch(sent[0].html + sent[0].text, /adjourn/);
}));

