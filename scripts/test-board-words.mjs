/**
 * test-board-words.mjs — a paper's words out of real PDFs, in a real browser
 * ============================================================================
 * Board → Documents writes a paper in Board starting from its PDF's own words
 * (public/admin/board-words.js: pdf.js in the browser, then wordsFromLines).
 * This makes PDFs laid out the ways boards' papers are (pdf-lib), reads each
 * the way the admin does, and checks the Markdown that comes out:
 *   - a Word-style paper: the letterhead with its address and a footer on both
 *     pages, a title over two lines in capitals, numbered sections in bold with
 *     points under them that wrap, the line to agree, the blanks to sign
 *   - headings in bold at the body's size, a paragraph right after a list
 *   - a bold word inside a sentence ("SOARD’s", "the Bylaws.")
 *   - the same point on two pages (kept both times), the opening sentence that
 *     shares words with the title (kept), a long sentence in capitals (kept as
 *     a sentence), a. / b. and i. / ii. under a numbered point, a page in two
 *     columns, and a sentence carried over a page break
 *   - headings in capitals with numbers ("1. GALA AND GOLF CLASSIC": title case,
 *     the number kept), a label with its answer in bold ("Term: 3 years", kept
 *     bold, not a heading), "Name: …" and "Effective …" lines (not headings),
 *     paragraphs set in on their first line, a one-page paper's small footer
 *   - a set of bylaws: the title block with SOARD's name in it (kept, one
 *     heading), ARTICLE VII and SOARD'S CFO in capitals (kept so), i. and ii.
 *     under c. (nested), a paragraph over a page break whose page ended on a
 *     full line with a full stop (one paragraph); a letterhead typed into the
 *     top of the first page (left out)
 *   - page numbers at the body's size, the ways Word writes them ("- 1 -",
 *     "1 | P a g e", "Gift Policy | Revised 3/2025   1"), between two halves
 *     of a sentence (left out, the sentence whole); a table (its rows, header
 *     in bold); a signature block ("Kim Park, Secretary": words, not a
 *     heading); "CARRYING IT OUT" in title case ("Carrying It Out")
 *   - a form: points under "expected to:" with no bullets (points), a line to
 *     fill in (kept), the labels under the lines to sign (left out); a line
 *     wrapped before "(3)" or "5." (the same sentence); an opening sentence
 *     naming the website (kept); "two-" / "thirds" (two-thirds); a footnote in
 *     small type (kept); a table cell over two lines (one cell); lines each
 *     starting with a bold label (each its own); a bold lead-in run straight
 *     into its sentence ("Vacancies. A vacancy"); "BYLAWS / OF / SUNSHINE…"
 *     at different sizes (one heading)
 * Made-up words only (the repo is public). Exits non-zero on any failure.
 *
 *   node scripts/test-board-words.mjs
 */
import puppeteer from 'puppeteer';
import http from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const ROOT = new URL('..', import.meta.url).pathname;
const failures = [];
const ok = (cond, msg) => { if (!cond) failures.push(msg); console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`); };

/** A PDF from pages of runs: each run { t, x, y, size = 11, b = false } (Times or Helvetica) */
async function pdf(pages, { serif = false } = {}) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(serif ? StandardFonts.TimesRoman : StandardFonts.Helvetica);
  const bold = await doc.embedFont(serif ? StandardFonts.TimesRomanBold : StandardFonts.HelveticaBold);
  for (const runs of pages) {
    const page = doc.addPage([612, 792]);
    for (const r of runs) page.drawText(r.t, { x: r.x, y: r.y, size: r.size || 11, font: r.b ? bold : font });
  }
  return { bytes: Buffer.from(await doc.save()), width: (t, size = 11, b = false) => (b ? bold : font).widthOfTextAtSize(t, size) };
}
/** Lines down a page from y, `gap` apart: [[text, opts]] → runs */
function flow(lines, { x = 72, y = 720, gap = 15 } = {}) {
  const runs = [];
  for (const [t, o = {}] of lines) {
    y -= o.before || 0;
    if (t) runs.push({ t, x: o.x ?? x, y, size: o.size, b: o.b });
    y -= o.gap ?? gap;
  }
  return runs;
}

// ── The papers ──
const papers = {};
{
  // The way a Word file exported to PDF often is (the QA round's seeded paper)
  const head = (n) => [{ t: 'Sunshine on a Ranney Day, Inc.  ·  123 Example Street, Example GA 30000  ·  www.example.org', x: 72, y: 760, size: 8 }, { t: `Page ${n} of 2`, x: 280, y: 40, size: 9 }];
  const p1 = flow([
    ['BOARD OF DIRECTORS', { size: 14, b: true, x: 220 }], ['MEMBER EXPECTATIONS', { size: 14, b: true, x: 215, gap: 30 }],
    ['As a member of the Board of Directors of Sunshine on a Ranney Day (SOARD), I understand that my'],
    ['role carries the following responsibilities. I agree to fulfill them to the best of my ability.', { gap: 26 }],
    ['1.  Mission and leadership', { b: true, gap: 17 }],
    ['•   Know and support the mission, programs and policies of SOARD.', { x: 90 }],
    ['•   Act as an ambassador in the community and speak well of the organization, its staff and its', { x: 90 }],
    ['families.', { x: 102 }],
    ['•   Keep confidential matters of the board confidential.', { x: 90, gap: 26 }],
    ['2.  Meetings', { b: true, gap: 17 }],
    ['•   Attend at least 75% of board meetings each year, and the annual planning retreat.', { x: 90 }],
    ['•   Serve actively on at least one committee.', { x: 90 }],
  ], { y: 745 });
  const p2 = flow([
    ['3.  Giving', { b: true, gap: 17 }],
    ['•   Make a personal gift each year that is meaningful to me (a "give or get" of $5,000).', { x: 90 }],
    ['I have read and understand these expectations and agree to meet them during my term.', { before: 14, gap: 40 }],
    ['Board Member Name (print): _______________________________', { gap: 30 }],
    ['Signature: ___________________________________   Date: ______________'],
  ], { y: 730 });
  papers.word = { title: 'Board Member Expectations', ...(await pdf([[...head(1), ...p1], [...head(2), ...p2]], { serif: true })) };
}
{
  // Headings in bold at the body's size; a paragraph straight after a list
  papers.ethics = { title: 'Code of Ethics', ...(await pdf([flow([
    ['Code of Ethics', { size: 18, b: true, gap: 28 }],
    ['Purpose', { b: true }],
    ['This code sets out how directors act on behalf of the organization and its families, in'],
    ['meetings and out of them.', { gap: 22 }],
    ['Responsibilities', { b: true }],
    ['Each director will:'],
    ['•  Act in good faith.', { x: 86 }],
    ['•  Avoid conflicts of interest.', { x: 86 }],
    ['Directors who cannot meet these responsibilities are asked to step down from the board, with'],
    ['thanks for their service.'],
  ])])) };
}
{
  // A bold word inside a sentence: the runs touch, so no space comes between them
  const { width } = await pdf([[]]);
  const runs = [];
  let x = 72;
  for (const [t, b] of [['The board protects ', false], ['SOARD', true], ['’s name and follows ', false], ['the Bylaws', true], ['.', false]]) { runs.push({ t, x, y: 700, b }); x += width(t, 11, b); }
  papers.runs = { title: 'Board Duties', ...(await pdf([runs])) };
}
{
  // The same point on two pages; the opening sentence shares words with the title
  const page = (n) => [...flow([
    ...(n === 1 ? [['Board Member Expectations', { size: 18, b: true, gap: 28 }], ['Board members are expected to:']] : [['Committees', { size: 14, b: true, gap: 22 }], ['Committee members are expected to:']]),
    ['•  Attend every board meeting.', { x: 86 }],
    [n === 1 ? '•  Give each year.' : '•  Report to the board.', { x: 86 }],
  ]), { t: String(n), x: 300, y: 40, size: 9 }];
  papers.repeat = { title: 'Board Member Expectations', ...(await pdf([page(1), page(2)])) };
}
{
  // Lettered and roman points under numbered ones; a long sentence in capitals
  papers.lists = { title: 'Board Member Expectations', ...(await pdf([flow([
    ['1. Giving'],
    ['a. Make a personal gift each year.', { x: 92 }],
    ['b. Take part in the Gala.', { x: 92 }],
    ['2. Meetings'],
    ['i. Attend three of four meetings.', { x: 92 }],
    ['ii. Read the materials first.', { x: 92 }],
    ['iii. Vote on the budget.', { x: 92, gap: 26 }],
    ['BY SIGNING BELOW THE DIRECTOR AGREES THAT THESE EXPECTATIONS ARE NOT A CONTRACT OF ANY KIND.', { size: 9 }],
  ])])) };
}
{
  // A page in two columns
  const left = ['The left column starts the paper and', 'goes on for a few lines, telling the', 'board what is asked of it this year.'];
  const right = ['The right column carries on after it,', 'saying more about the meetings and', 'the committees each member joins.'];
  const runs = [{ t: 'Two Columns', x: 240, y: 730, size: 16, b: true }];
  left.forEach((t, i) => runs.push({ t, x: 72, y: 690 - i * 15 }));
  right.forEach((t, i) => runs.push({ t, x: 330, y: 690 - i * 15 }));
  // More lines, so the columns are most of the page
  for (let i = 3; i < 8; i++) { runs.push({ t: `Left line number ${i} of the first column.`, x: 72, y: 690 - i * 15 }); runs.push({ t: `Right line number ${i} of the second column.`, x: 330, y: 690 - i * 15 }); }
  papers.columns = { title: 'Two Columns', ...(await pdf([runs])) };
}
{
  // A sentence carried over a page break onto a capitalized word
  papers.pagebreak = { title: 'Board Member Expectations', ...(await pdf([
    flow([['Every member agrees to keep what the board discusses in closed session between the'], ['members of the board, and to share it only when the board decides to tell'], ['the families first, as', { gap: 0 }]], { y: 110 }),
    flow([['SOARD then shares it with everyone.'], ['A second paragraph starts here.', { before: 10 }]], { y: 720 }),
  ])) };
}

{
  // Numbered headings in capitals; a bold label with its answer; a name and a date line; first-line indents; a footer
  const { width } = await pdf([[]]);
  const runs = flow([
    ['1. GALA AND GOLF CLASSIC', { b: true }],
    ['Name: Alex Rivera'],
    ['Effective January 1, 2026', { gap: 22 }],
    ['    Every member supports the Gala and the Golf Classic, and asks two friends to come along with', { x: 72 }],
    ['them to each one, the way the board has done since the first one began across the region.'],
    ['    Members who cannot come to one ask another member to take their place for that evening.'],
  ]);
  runs.push({ t: 'Term:', x: 72, y: 560, b: true }, { t: ' 3 years, renewable once.', x: 72 + width('Term:', 11, true), y: 560 });
  runs.push({ t: 'Confidential: for the board of directors', x: 230, y: 40, size: 8 });
  papers.labels = { title: 'Board Member Expectations', ...(await pdf([runs])) };
}

{
  // Bylaws: a title block, articles in capitals, nested lettered points, a paragraph over a page break
  const { width } = await pdf([[]], { serif: true });
  const full = 'Every director serves a term of three years and may serve two terms in a row, after which a year';
  const p1 = flow([
    ['AMENDED AND RESTATED BYLAWS', { size: 14, b: true, x: 190 }], ['OF', { size: 14, b: true, x: 296 }], ['SUNSHINE ON A RANNEY DAY, INC.', { size: 14, b: true, x: 185, gap: 22 }],
    ['A Georgia Nonprofit Corporation', { x: 230, gap: 30 }],
    ['ARTICLE VII', { b: true, x: 270 }], ['SOARD\u2019S OFFICERS: CFO AND COO', { b: true, x: 200, gap: 22 }],
    ['The officers are chosen each year at the annual meeting:', { gap: 18 }],
    ['a. a President;', { x: 90 }], ['b. a Treasurer;', { x: 90 }], ['c. a Secretary, who', { x: 90 }],
    ['i. keeps the minutes; and', { x: 108 }], ['ii. keeps the board\u2019s papers.', { x: 108, gap: 26 }],
  ], { y: 720 });
  const tail = flow([[full], ['away from the board is asked of them before they serve again on the board of directors.']], { y: 100 });
  const p2 = flow([['Officers may serve as directors at the same time.'], ['A new paragraph starts here, set apart.', { before: 12 }]], { y: 720 });
  papers.bylaws = { title: 'Amended Bylaws', ...(await pdf([[...p1, ...tail], p2], { serif: true })), fullWidth: width(full) };
}
{
  // A letterhead typed into the page (not Word's header): SOARD's name, then a line of where to reach it
  papers.typedhead = { title: 'Board Member Expectations', ...(await pdf([flow([
    ['Sunshine on a Ranney Day', { size: 16, b: true }],
    ['1000 Example Parkway, Suite 200, Example, GA 30076 | (770) 555-0100 | www.example.org', { size: 9, gap: 30 }],
    ['Board Member Expectations', { size: 18, b: true, gap: 28 }],
    ['Every member of the board reads and signs these each year.'],
  ], { y: 700 })])) };
}

for (const [k, foot] of [['dash', (n) => `- ${n} -`], ['pipe', (n) => `${n} | P a g e`], ['rev', (n) => `Gift Acceptance Policy | Revised 3/2025      ${n}`], ['endash', (n) => `\u2013 ${n} \u2013`], ['pageword', (n) => `${n}|Page`]]) {
  // A sentence over the page break, a footer at the body's size between its halves
  papers[`foot-${k}`] = { title: 'Gift Acceptance Policy', ...(await pdf([
    [...flow([['SOARD accepts gifts of cash, stock and goods and services that further its mission, and it']], { y: 100 }), { t: foot(1), x: 290, y: 40 }],
    [...flow([['protects donors by never selling or sharing their names.'], ['A second paragraph.', { before: 12 }]], { y: 720 }), { t: foot(2), x: 290, y: 40 }],
  ])) };
}
{
  // A table under a heading; a signature block; a heading in capitals with an ordinary IT in it
  const runs = flow([['Section 3. Committees at a glance', { b: true, gap: 22 }]]);
  const rows = [['Committee', 'Chair', 'Meets'], ['Finance and Audit', 'Sam Ortiz', 'Monthly'], ['Events', 'Alex Rivera', 'Every other month'], ['Governance', 'Kim Park', 'Quarterly']];
  rows.forEach((r, i) => r.forEach((t, c) => runs.push({ t, x: [72, 260, 420][c], y: 676 - i * 16, b: i === 0 })));
  runs.push(...flow([
    ['Each committee reports to the board at every meeting.'],
    ['CARRYING IT OUT', { b: true, before: 10, gap: 18 }], ['The chair of each committee sees that its work is done on time.'],
    ['Approved by the Board of Directors', { before: 20 }], ['Kim Park, Secretary'],
  ], { y: 600 }));
  papers.table = { title: 'Committees', ...(await pdf([runs])) };
}

{
  // A form
  const { width } = await pdf([[]]);
  const runs = flow([
    ['Please read this paper each year. The full policies are at sunshineonaranneyday.org/board'],
    ['and the board page. Ask the Chair about anything here.', { gap: 22 }],
    ['Board members are expected to:'],
    ['Attend three of four meetings'], ['Serve on one committee'], ['Give or get $5,000 each year'], ['Attend two room reveals', { gap: 22 }],
    ['Every director keeps a reserve of at least three'],
  ]);
  // (the line above runs to the right edge, as a wrapped line does)
  runs.at(-1).t = 'Every director keeps a reserve for the organization that is enough to last at least three';
  runs.push(...flow([
    ['(3) months of operating expenses, as the board sets it each year, and a vote of two-'],
    ['thirds of the board changes it.*', { gap: 22 }],
    ['My giving commitment for 2027: $______________', { gap: 26 }],
    ['__________________________          __________'], ['Board Member Signature                        Date', { gap: 22 }],
    ['Name (please print)'],
  ], { y: 586 }));
  runs.push({ t: '* Gifts of stock count at their value on the day they arrive.', x: 72, y: 50, size: 8 });
  papers.form = { title: 'Board Member Expectations', ...(await pdf([runs])) };
  // Labels in bold, each a line; a bold lead-in straight into its sentence; a wrapped table cell; a title at three sizes
  const r2 = [{ t: 'BYLAWS', x: 270, y: 740, size: 16, b: true }, { t: 'OF', x: 296, y: 718, size: 11, b: true }, { t: 'SUNSHINE ON A RANNEY DAY, INC.', x: 200, y: 698, size: 14, b: true }];
  let y = 660;
  for (const [label, rest] of [['Attendance:', ' three of four meetings a year.'], ['Giving:', ' a gift that is meaningful to you.'], ['Committees:', ' at least one, of your choosing.']]) {
    r2.push({ t: label, x: 72, y, b: true }, { t: rest, x: 72 + width(label, 11, true), y }); y -= 15;
  }
  y -= 10;
  r2.push({ t: 'Section 2.5 Vacancies.', x: 72, y, b: true }, { t: 'A vacancy is filled by the board for the rest of the term.', x: 72 + width('Section 2.5 Vacancies.', 11, true) + 0.5, y });
  y -= 30;
  [['Committee', 'Duties', 'Meets'], ['Finance', 'Reviews the budget and', 'Monthly']].forEach((row, i) => row.forEach((t, c) => r2.push({ t, x: [72, 220, 430][c], y: y - i * 15, b: i === 0 })));
  r2.push({ t: 'the annual audit', x: 220, y: y - 30 });
  [['Events', 'Plans the Gala', 'Quarterly']].forEach((row) => row.forEach((t, c) => r2.push({ t, x: [72, 220, 430][c], y: y - 45 })));
  papers.labels2 = { title: 'Amended Bylaws', ...(await pdf([r2])) };
}

// ── Read them in the browser ──
const server = http.createServer((req, res) => {
  const f = join(ROOT, 'public', decodeURIComponent(req.url.split('?')[0]));
  if (!existsSync(f)) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': extname(f) === '.js' ? 'text/javascript' : 'text/html' });
  res.end(readFileSync(f));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const browser = await puppeteer.launch({ headless: 'shell', args: ['--no-sandbox', '--disable-gpu', '--disable-gpu-vsync'] });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
await page.goto(`http://127.0.0.1:${server.address().port}/admin/board-words.js`);
const md = {};
for (const [k, p] of Object.entries(papers)) {
  md[k] = await page.evaluate(async (b64, title) => {
    const { pdfLines, wordsFromLines } = await import('/admin/board-words.js');
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    return wordsFromLines(await pdfLines(bytes), { title });
  }, p.bytes.toString('base64'), p.title);
  if (process.env.SHOW) console.log(`\n── ${k}\n${md[k]}\n`);
}
await browser.close();
server.close();

console.log('A Word-style paper');
ok(!/Example Street|www\.example|Sunshine on a Ranney Day, Inc|Page \d of 2/.test(md.word), 'the letterhead, its address and the page footers are left out');
ok(!/^(### )?board of directors( member expectations)?$|^member expectations$/im.test(md.word) && /^As a member/.test(md.word), 'the title in capitals over two lines is the page’s title already, left out');
ok(/^As a member of the Board of Directors of Sunshine on a Ranney Day \(SOARD\), I understand that my role carries the following responsibilities\. I agree to fulfill them to the best of my ability\.$/m.test(md.word), 'the opening paragraph is one paragraph again');
ok(/### 1\\?\. Mission and leadership\n\n- Know and support the mission, programs and policies of SOARD\.\n- Act as an ambassador in the community and speak well of the organization, its staff and its families\.\n- Keep confidential matters of the board confidential\./.test(md.word), 'a numbered section in bold is a heading, its points under it, a wrapped point one point');
ok(/### 2\\?\. Meetings/.test(md.word) && /### 3\\?\. Giving\n\n- Make a personal gift each year that is meaningful to me \(a "give or get" of \$5,000\)\./.test(md.word), 'the sections on the second page too, the amount as written');
ok(/^I have read and understand these expectations and agree to meet them during my term\.$/m.test(md.word), 'the line to agree stays');
ok(!/Signature|Date:|Name \(print\)|_{3}/.test(md.word), 'the blanks to sign are left out');

console.log('Headings at the body’s size');
ok(/### Purpose\n\nThis code sets out how directors act on behalf of the organization and its families, in meetings and out of them\./.test(md.ethics), 'a bold heading in the body’s letters is a heading, not glued to its paragraph');
ok(/### Responsibilities\n\nEach director will:\n\n- Act in good faith\.\n- Avoid conflicts of interest\.\n\nDirectors who cannot meet/.test(md.ethics), 'the paragraph after the list is its own paragraph, not the last point’s');
ok(!/^### Code of Ethics/m.test(md.ethics), 'the title left out');

console.log('A bold word in a sentence');
ok(/The board protects \*\*SOARD\*\*’s name and follows \*\*the Bylaws\*\*\./.test(md.runs), `no spaces around the bold words, which stay bold (${JSON.stringify(md.runs)})`);

console.log('Repeats, the opening, lists, capitals');
ok((md.repeat.match(/Attend every board meeting\./g) || []).length === 2, 'a point on both pages is kept both times (it isn’t a header)');
ok(/^Board members are expected to:$/m.test(md.repeat), 'the opening sentence that shares the title’s words stays');
ok(!/^\d$/m.test(md.repeat), 'the page numbers are left out');
ok(/1\. Giving\n {3}- a\. Make a personal gift each year\.\n {3}- b\. Take part in the Gala\.\n2\. Meetings\n {3}- i\. Attend three of four meetings\.\n {3}- ii\. Read the materials first\.\n {3}- iii\. Vote on the budget\./.test(md.lists), `a. / b. and i. / ii. / iii. are points keeping their letters, under their point (${JSON.stringify(md.lists)})`);
ok(/^BY SIGNING BELOW THE DIRECTOR AGREES THAT THESE EXPECTATIONS ARE NOT A CONTRACT OF ANY KIND\.$/m.test(md.lists), 'a long sentence in capitals stays a sentence, as written');

console.log('Two columns, a page break');
ok(/The left column starts the paper and goes on for a few lines, telling the board what is asked of it this year\./.test(md.columns) && md.columns.indexOf('The left column') < md.columns.indexOf('The right column'), `the left column is read before the right, its lines one paragraph (${JSON.stringify(md.columns.slice(0, 200))})`);
ok(/The right column carries on after it, saying more about the meetings and the committees each member joins\./.test(md.columns), 'the right column’s lines are one paragraph too');
ok(/to tell the families first, as SOARD then shares it with everyone\.\n\nA second paragraph starts here\./.test(md.pagebreak), `a sentence carried over the page break stays one sentence (${JSON.stringify(md.pagebreak)})`);

console.log('Capitals, labels, dates, indents, a footer');
ok(/^### 1\\?\. Gala and Golf Classic$/m.test(md.labels), `a numbered heading in capitals in title case, its number kept (${JSON.stringify(md.labels.slice(0, 80))})`);
ok(/^Name: Alex Rivera$/m.test(md.labels) && /^Effective January 1, 2026$/m.test(md.labels) && !/### (Name|Effective)/.test(md.labels), 'a name line and a date line are words, not headings');
ok(/the way the board has done since the first one began across the region\.\n\nMembers who cannot come/.test(md.labels), 'a paragraph set in on its first line is a new paragraph, though the line above ran to the edge');
ok(/^\*\*Term:\*\* 3 years, renewable once\.$/m.test(md.labels), `a bold label keeps its bold, its answer beside it (${JSON.stringify((md.labels.match(/.*Term.*/) || [''])[0])})`);
ok(!/Confidential/.test(md.labels), 'a one-page paper’s footer in small type is left out');

console.log('Bylaws, a typed letterhead');
ok(/^### Amended and Restated Bylaws of Sunshine on a Ranney Day, Inc\.$/m.test(md.bylaws) && !/^### Of$/m.test(md.bylaws), `the title block is one heading, SOARD’s name in it (${JSON.stringify(md.bylaws.slice(0, 120))})`);
ok(/^### Article VII SOARD’s Officers: CFO and COO$/m.test(md.bylaws) || (/^### Article VII$/m.test(md.bylaws) && /^### SOARD’s Officers: CFO and COO$/m.test(md.bylaws)), `ARTICLE VII and SOARD’S CFO AND COO keep their capitals where they’re names (${JSON.stringify((md.bylaws.match(/### Article.*|### SOARD.*/g) || []).join(' | '))})`);
ok(/- a\. a President;\n- b\. a Treasurer;\n- c\. a Secretary, who\n {2}- i\. keeps the minutes; and\n {2}- ii\. keeps the board’s papers\./.test(md.bylaws), `i. and ii. sit under c. (${JSON.stringify((md.bylaws.match(/- a\.[\s\S]*?papers\./) || [''])[0])})`);
ok(/after which a year away from the board is asked of them before they serve again on the board of directors\. Officers may serve as directors at the same time\.\n\nA new paragraph starts here/.test(md.bylaws), 'a paragraph over a page break, its page ending on a full line with a full stop, stays one paragraph');
ok(!/Example Parkway|555-0100|www\.example/.test(md.typedhead) && /^Every member of the board reads and signs these each year\.$/m.test(md.typedhead), `a letterhead typed into the first page is left out (${JSON.stringify(md.typedhead)})`);

console.log('Footers, a table, a signature block');
for (const k of ['dash', 'pipe', 'rev', 'endash', 'pageword']) ok(/goods and services that further its mission, and it protects donors by never selling or sharing their names\.\n\nA second paragraph\./.test(md[`foot-${k}`]) && !/P a g e|Revised 3\/2025|^\D?\s?[12]\b/m.test(md[`foot-${k}`]), `a footer like “${k}” is left out and the sentence over the page break stays whole (${JSON.stringify(md[`foot-${k}`])})`);
ok(/^### Section 3\. Committees at a glance$/m.test(md.table) && /\*\*Committee · Chair · Meets\*\*\n\n- Finance and Audit · Sam Ortiz · Monthly\n- Events · Alex Rivera · Every other month\n- Governance · Kim Park · Quarterly/.test(md.table), `a table: its header in bold, a row a point, cells side by side, the heading above it its own (${JSON.stringify(md.table.slice(0, 260))})`);
ok(/^### Carrying It Out$/m.test(md.table), 'IT in a heading in capitals is the word “It”');
ok(/^Approved by the Board of Directors$/m.test(md.table) && /^Kim Park, Secretary$/m.test(md.table) && !/### Kim Park/.test(md.table), 'a signature block’s lines stay words, each its own');

console.log('A form, labels in bold, a wrapped cell, a title at three sizes');
ok(/^Board members are expected to:\n\n- Attend three of four meetings\n- Serve on one committee\n- Give or get \$5,000 each year\n- Attend two room reveals$/m.test(md.form), `points under “expected to:” with no bullets are points (${JSON.stringify((md.form.match(/Board members[\s\S]{0,160}/) || [''])[0])})`);
ok(/^Please read this paper each year\. The full policies are at sunshineonaranneyday\.org\/board and the board page\./m.test(md.form), 'an opening sentence that names the website stays');
ok(/enough to last at least three \(3\) months of operating expenses/.test(md.form), 'a line wrapped before “(3)” is the same sentence, not a numbered point');
ok(/a vote of two-thirds of the board changes it/.test(md.form), '“two-” / “thirds” keeps its hyphen');
ok(/My giving commitment for 2027: \$\\_/.test(md.form), 'a line to fill in keeps its words');
ok(!/Board Member Signature|please print/i.test(md.form), 'the labels under the lines to sign are left out');
ok(/^\\\* Gifts of stock count at their value on the day they arrive\.$/m.test(md.form), `a footnote in small type stays (${JSON.stringify((md.form.match(/.*Gifts of stock.*/) || [''])[0])})`);
ok(/^### Bylaws of Sunshine on a Ranney Day, Inc\.$/m.test(md.labels2), `a title over three lines at three sizes is one heading (${JSON.stringify(md.labels2.slice(0, 80))})`);
ok(/^\*\*Attendance:\*\* three of four meetings a year\.\n\n\*\*Giving:\*\* a gift that is meaningful to you\.\n\n\*\*Committees:\*\* at least one, of your choosing\.$/m.test(md.labels2), 'lines each starting with a bold label are each their own');
ok(/Vacancies\.\*\* A vacancy is filled/.test(md.labels2) || /Vacancies\. A vacancy is filled/.test(md.labels2), `a bold lead-in and its sentence keep their space (${JSON.stringify((md.labels2.match(/.*Vacanc.*/) || [''])[0])})`);
ok(/- Finance · Reviews the budget and the annual audit · Monthly\n- Events · Plans the Gala · Quarterly/.test(md.labels2), `a table cell over two lines is one cell, the rows after it rows (${JSON.stringify((md.labels2.match(/\*\*Committee[\s\S]*/) || [''])[0])})`);

ok(!errors.length, `no errors in the page${errors.length ? `: ${errors.join(' | ')}` : ''}`);
if (failures.length) { console.log(`\n${failures.length} failed`); process.exit(1); }
console.log('\nAll passed');
