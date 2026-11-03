/**
 * A paper's words out of its PDF (public/admin/board-words.js): headings, points, numbered lists, wrapped lines made
 * one paragraph again, and what only paper needs (page numbers, a header on every page, the letterhead, the blanks
 * to sign and date) left out. Made-up words only (the repo is public).
 * Run: node --test tests/board-words.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { wordsFromLines, docxLines, linesOfItems } from '../public/admin/board-words.js';
import { docxText } from '../public/admin/board-shared.js';

/** A real ZIP (a .docx is one) of { name: text } */
function zip(files) {
  const enc = new TextEncoder();
  const locals = []; const central = []; let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameB = enc.encode(name); const raw = enc.encode(text); const data = deflateRawSync(raw);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(data.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(nameB.length, 26);
    locals.push(lh, nameB, data);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(data.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(nameB.length, 28); ch.writeUInt32LE(offset, 42);
    central.push(ch, nameB);
    offset += 30 + nameB.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, cd, end]));
}

/** Lines down a page: [text, size, x?] → { text, x, y, size, page } */
function page(rows, { page: p = 1, top = 740 } = {}) {
  let y = top;
  return rows.map(([text, size = 11, x = 72, gap = 0]) => {
    y -= gap || size * 1.4;
    return { text, x, y, size, page: p };
  });
}

test('a paper the way it reads: headings, points, wrapped paragraphs; the title, letterhead, page numbers and blanks to sign left out', () => {
  const lines = [
    ...page([
      ['SUNSHINE ON A RANNEY DAY', 10],
      ['Board Member Expectations', 18, 72, 30],
      ['Each member of the board agrees to the following for the year. We ask every', 11, 72, 30],
      ['member to read them and sign each January.', 11],
      ['ATTENDANCE', 13, 72, 28],
      ['• Attend at least three of four board meetings', 11],
      ['• Serve on one committee and come to its', 11],
      ['meetings', 11, 86],
      ['Giving and asking', 13, 72, 28],
      ['1. Make a personal gift each year', 11],
      ['2. Open one door for a sponsor or a partner', 11],
      ['3', 9, 300, 40],
    ]),
    ...page([
      ['SUNSHINE ON A RANNEY DAY', 10],
      ['The board also volunteers at two reveals a year, when its schedule allows, and talks', 11, 72, 30],
      ['about SOARD’s work in the commu-', 11],
      ['nity.', 11],
      ['Signature: ______________________   Date: __________', 11, 72, 40],
      ['Printed name', 11],
      ['4', 9, 300, 40],
    ], { page: 2 }),
  ];
  assert.equal(wordsFromLines(lines, { title: 'Board Member Expectations' }), [
    'Each member of the board agrees to the following for the year. We ask every member to read them and sign each January.',
    '### Attendance',
    '- Attend at least three of four board meetings\n- Serve on one committee and come to its meetings',
    '### Giving and asking',
    '1. Make a personal gift each year\n2. Open one door for a sponsor or a partner',
    'The board also volunteers at two reveals a year, when its schedule allows, and talks about SOARD’s work in the community.',
  ].join('\n\n'));
});

test('a title that isn’t the document’s stays; bullets fonts write other ways; a lettered point keeps its letter; a heading over two lines is one', () => {
  const md = wordsFromLines(page([
    ['Our promise to the families', 16],
    ['What we each do for them', 16],
    [' Keep their stories private', 11, 72, 24],
    ['o Answer within a day', 11],
    ['a) Ask before sharing a photo', 11],
    ['# not a heading, a hashtag line', 11, 72, 30],
  ]), { title: 'Board Member Expectations' });
  assert.equal(md, [
    '### Our promise to the families What we each do for them',
    '- Keep their stories private\n- Answer within a day\n- a) Ask before sharing a photo',
    '\\# not a heading, a hashtag line',
  ].join('\n\n'));
});

test('a Word file’s paragraphs, one each; nothing to read is nothing', () => {
  assert.equal(wordsFromLines(docxLines('Expectations\nCome to the meetings.\nGive what you can.'), { title: 'Expectations' }),
    'Come to the meetings.\n\nGive what you can.');
  assert.equal(wordsFromLines([]), '');
  assert.equal(wordsFromLines(page([['Signature ________', 11], ['Date', 11]])), '');
});

test('a Word file: its Title and Heading styles, a short line all in bold, its points as Word numbers them (a. under 1.)', async () => {
  const p = (text, { style = '', bold = false, num = null } = {}) => `<w:p><w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}${num ? `<w:numPr><w:ilvl w:val="${num[1]}"/><w:numId w:val="${num[0]}"/></w:numPr>` : ''}</w:pPr><w:r>${bold ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
  const body = [
    p('Board Member Expectations', { style: 'Title' }),
    p('Attendance', { style: 'Heading1' }),
    p('Attend three of four meetings.'),
    p('Giving', { bold: true }),
    p('Make a personal gift.', { num: [1, 0] }),
    p('Something meaningful to you.', { num: [1, 1] }),
    p('Something on time.', { num: [1, 1] }),
    p('Open a door for a sponsor.', { num: [1, 0] }),
    p('Speak well of SOARD.', { num: [2, 0] }),
  ].join('');
  const lvls = ['decimal', 'lowerLetter'].map((f, i) => `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="${f}"/></w:lvl>`).join('');
  const docx = zip({
    'word/document.xml': `<w:document><w:body>${body}</w:body></w:document>`,
    'word/numbering.xml': `<w:numbering><w:abstractNum w:abstractNumId="0">${lvls}</w:abstractNum><w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>`,
  });
  // The plain text the minutes reader uses is as it was
  assert.match(await docxText(docx), /^Board Member Expectations\nAttendance\n/);
  assert.equal(wordsFromLines(docxLines(await docxText(docx, { paragraphs: true })), { title: 'Board Member Expectations' }), [
    '### Attendance',
    'Attend three of four meetings.',
    '### Giving',
    '1. Make a personal gift.\n   - a. Something meaningful to you.\n   - b. Something on time.\n2. Open a door for a sponsor.',
    '- Speak well of SOARD.',
  ].join('\n\n'));
});

test('runs on one line: a bold word inside a sentence keeps its place; a page in two columns reads left, then right', () => {
  const run = (s, x0, y, { size = 11, bold = false, w = s.length * 5.5 } = {}) => ({ s, x0, x1: x0 + w, y, size, bold });
  const [line] = linesOfItems([run('The board protects ', 72, 700), run('SOARD', 72 + 19 * 5.5, 700, { bold: true }), run('’s name.', 72 + 24 * 5.5, 700)]);
  assert.equal(line.text, 'The board protects SOARD’s name.');
  assert.equal(line.bold, false);
  const cols = [];
  for (let i = 0; i < 6; i++) { cols.push(run(`Left column line number ${i} goes here`, 72, 700 - i * 14, { w: 200 })); cols.push(run(`Right column line number ${i} goes here`, 330, 700 - i * 14, { w: 200 })); }
  const lines = linesOfItems(cols).map((l) => l.text);
  assert.deepEqual(lines, [...Array(6).keys()].map((i) => `Left column line number ${i} goes here`).concat([...Array(6).keys()].map((i) => `Right column line number ${i} goes here`)));
  // A table's short cells side by side stay rows
  const table = [];
  for (let i = 0; i < 6; i++) { table.push(run(`Name ${i}`, 72, 700 - i * 14)); table.push(run(`Role ${i}`, 330, 700 - i * 14)); }
  assert.equal(linesOfItems(table)[0].text, 'Name 0 Role 0');
});

test('a Word paragraph bold some of the way keeps its bold word', async () => {
  const run = (t, b) => `<w:r>${b ? '<w:rPr><w:b/></w:rPr>' : ''}<w:t xml:space="preserve">${t}</w:t></w:r>`;
  const docx = zip({ 'word/document.xml': `<w:document><w:body><w:p>${run('Each member gives ')}${run('personally', true)}${run(' each year.')}</w:p></w:body></w:document>` });
  assert.equal(wordsFromLines(docxLines(await docxText(docx, { paragraphs: true }))), 'Each member gives **personally** each year.');
});

test('a Word file’s points styled as a list (List Bullet, List Number: the numbering in the style) are points', async () => {
  const p = (t, style) => `<w:p><w:pPr><w:pStyle w:val="${style}"/></w:pPr><w:r><w:t>${t}</w:t></w:r></w:p>`;
  const docx = zip({ 'word/document.xml': `<w:document><w:body><w:p><w:r><w:t>Board members are expected to:</w:t></w:r></w:p>${p('Attend three of four meetings', 'ListBullet')}${p('Serve on one committee', 'ListBullet')}${p('Read the packet', 'ListNumber')}${p('Vote', 'ListNumber')}</w:body></w:document>` });
  assert.equal(wordsFromLines(docxLines(await docxText(docx, { paragraphs: true }))), 'Board members are expected to:\n\n- Attend three of four meetings\n- Serve on one committee\n\n1. Read the packet\n2. Vote');
});

test('a hyphen at a line’s end: kept in a word that has one (in-person, twenty-five), gone where a word was broken (commu-nity, mem-ber when “member” is written elsewhere)', () => {
  const md = wordsFromLines(page([
    ['Every member meets in-', 11], ['person twice a year and gives twenty-', 11], ['five hours to the commu-', 11], ['nity, as each mem-', 11], ['ber has since the start.', 11],
  ]));
  assert.equal(md, 'Every member meets in-person twice a year and gives twenty-five hours to the community, as each member has since the start.');
});

test('a date in a file’s name reads as a date', async () => {
  const { fileTitle } = await import('../public/admin/board-shared.js');
  assert.equal(fileTitle('Board Expectations Updated 01_01_26.pdf'), 'Board Expectations Updated 01/01/26');
  assert.equal(fileTitle('2024_990_return.pdf'), '2024 990 return');
});

test('a Google Docs paper: ○ points under bold numbered sections, i./ii. under them, a letterhead with a street number and letter, the title again atop page 2, a line to fill in on paper', () => {
  // As pdfLines reads one (made-up words in its layout): [text, x, x1, y, size, bold, page]
  const L = (rows) => rows.map(([text, x, x1, y, size = 11, bold = false, p = 1]) => ({ text, x, x1, tx: x, y, size, bold, h: 792, page: p, cellX: [x] }));
  const roman = ['i.', 'ii.', 'iii.', 'iv.', 'v.'];
  const romanX = [157, 154.5, 152, 152.3, 154.8];
  let y = 560;
  const step = () => (y -= 17.25);
  const lines = L([
    ['Sunshine on a Ranney Day', 72, 241, 695, 14, true],
    ['123B Example Street', 72, 160, 682.6, 10],
    ['Example, GA 30000', 72, 156, 670.6, 10],
    ['(555) 010-0100', 72, 139, 658.6, 10],
    ['Board Expectations', 72, 276, 617, 24],
    ['1. Duties', 90, 150, 576.7, 11, true],
    ...['Read the budget each quarter', 'Know the families the program serves', 'Bring one new friend to an event'].map((t) => [`○ ${t}`, 126, 400, step()]),
    ['2. Committees', 90, 168, step() - 10, 11, true],
    ['○ Roles', 126, 170, step()],
    ...['Board Chair', 'Vice Chair', 'Secretary'].map((t, k) => [`${roman[k]} ${t}`, romanX[k], 237, step()]),
    ['○ Groups', 126, 201, step()],
    ...['Finance', 'Events'].map((t, k) => [`${roman[k]} ${t}`, romanX[k], 230, step()]),
    ['1', 536, 540, 28],
    ['Board Expectations', 72, 165, 756.2, 11, false, 2],
    ['○ Qualities', 126, 234, 706, 11, false, 2],
    ...['Kind to everyone', 'Shows up on time'].map((t, k) => [`${roman[k]} ${t}`, romanX[k], 311, 689 - k * 17.25, 11, false, 2]),
    ['3. Service', 90, 217, 634, 11, true, 2],
    ['○ Each member is expected to attend at least 75% of board meetings. (4 total', 126, 538, 614.4, 11, false, 2],
    ['meetings, 1 per quarter)', 144, 256, 600.9, 11, false, 2],
    ['○ Annual minimum $1,000.00 Donation/Sponsorship', 126, 387, 583.6, 11, false, 2],
    ['Board Member Contact Information (Name, Phone, Email, Home Address)', 72, 536, 540, 14, true, 2],
    ['I have read and agreed to the terms of this commitment document.', 72, 392, 480, 11, false, 2],
    ['_______________________________________', 72, 313, 453, 11, false, 2],
    ['Print Name', 72, 125, 426, 11, false, 2],
    ['_______________________________________ _______________', 72, 480, 399, 11, false, 2],
    ['Signature Date', 72, 411, 382, 11, false, 2],
    ['2', 533, 540, 28, 11, false, 2],
  ]);
  lines.at(-2).cells = ['Signature', 'Date'];
  const md = wordsFromLines(lines, { title: 'Board Member Expectations' });
  assert.ok(!/Example Street|Example, GA|555|Sunshine on a Ranney Day/.test(md), `the letterhead is left out, its street number with a letter too (${md.slice(0, 80)})`);
  assert.match(md, /^### 1\\?\. Duties\n\n- Read the budget each quarter\n- Know the families the program serves\n- Bring one new friend to an event\n\n### 2\\?\. Committees\n\n- Roles\n {2}- i\. Board Chair\n {2}- ii\. Vice Chair\n {2}- iii\. Secretary\n- Groups\n {2}- i\. Finance\n {2}- ii\. Events\n- Qualities\n {2}- i\. Kind to everyone\n {2}- ii\. Shows up on time\n\n### 3\\?\. Service\n\n- Each member is expected to attend at least 75% of board meetings\. \(4 total meetings, 1 per quarter\)\n- Annual minimum \$1,000\.00 Donation\/Sponsorship\n\nI have read and agreed to the terms of this commitment document\.$/, md);
});
