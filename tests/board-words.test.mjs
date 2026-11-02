/**
 * A paper's words out of its PDF (public/admin/board-words.js): headings, points, numbered lists, wrapped lines made
 * one paragraph again, and what only paper needs (page numbers, a header on every page, the letterhead, the blanks
 * to sign and date) left out. Made-up words only (the repo is public).
 * Run: node --test tests/board-words.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { wordsFromLines, docxLines } from '../public/admin/board-words.js';

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

test('a title that isn’t the document’s stays; bullets fonts write other ways; a heading over two lines is one', () => {
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
    '- Keep their stories private\n- Answer within a day\n- Ask before sharing a photo',
    '\\# not a heading, a hashtag line',
  ].join('\n\n'));
});

test('a Word file’s paragraphs, one each; nothing to read is nothing', () => {
  assert.equal(wordsFromLines(docxLines('Expectations\nCome to the meetings.\nGive what you can.'), { title: 'Expectations' }),
    'Come to the meetings.\n\nGive what you can.');
  assert.equal(wordsFromLines([]), '');
  assert.equal(wordsFromLines(page([['Signature ________', 11], ['Date', 11]])), '');
});
