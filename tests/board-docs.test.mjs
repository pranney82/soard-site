/**
 * A meeting's file as pages (public/admin/board/docs.js): Excel's number
 * formats, a workbook's sheets the way the report reads, a Word document's
 * blocks, a PowerPoint deck's slides in order. The readers touch no DOM, so
 * they're tested here on small files built in memory. Made-up content only
 * (the repo is public).
 * Run: node --test tests/board-docs.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { formatValue, readSheets, readWord, readSlides, wordImages, slideImages, docKind, splitOf, halfOf } from '../public/admin/board/docs.js';

/** A real ZIP of { name: text | bytes } */
function zip(files) {
  const enc = new TextEncoder();
  const locals = []; const central = []; let offset = 0;
  for (const [name, body] of Object.entries(files)) {
    const nameB = enc.encode(name); const raw = typeof body === 'string' ? enc.encode(body) : body; const data = deflateRawSync(raw);
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

// ── A workbook the way QuickBooks writes a statement (made-up numbers)
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
function workbook() {
  const strings = ['Example Org', 'Statement of Financial Position', 'secret', 'Bank Accounts', '   Checking', 'hidden col', 'Savings', 'Total for Bank Accounts', 'Growth', 'As of', 'Notes sheet'];
  const sst = `<sst xmlns="x">${strings.map((s) => `<si><t xml:space="preserve">${s}</t></si>`).join('')}<si><r><rPr><b/></rPr><t>Rich </t></r><r><t xml:space="preserve">text</t></r><rPh sb="0" eb="1"><t>ignored</t></rPh></si></sst>`;
  const s = (ref, i, style = 0) => `<c r="${ref}" t="s" s="${style}"><v>${i}</v></c>`;
  const n = (ref, v, style = 0) => `<c r="${ref}" s="${style}"><v>${v}</v></c>`;
  const statement = `<worksheet><sheetFormatPr defaultRowHeight="15"/>
    <cols><col min="1" max="1" width="40" customWidth="1"/><col min="2" max="2" width="5" hidden="1"/><col min="3" max="3" width="15" customWidth="1"/></cols>
    <sheetData>
      <row r="1">${s('A1', 0, 3)}</row>
      <row r="2">${s('A2', 1, 3)}</row>
      <row r="3" hidden="1">${s('A3', 2)}</row>
      <row r="4">${s('A4', 3)}</row>
      <row r="5">${s('A5', 4)}${s('B5', 5)}${n('C5', 1234.5, 1)}</row>
      <row r="6">${s('A6', 6, 4)}${n('C6', -250, 7)}</row>
      <row r="7" ht="24" customHeight="1">${s('A7', 7, 8)}${n('C7', 984.5, 2)}</row>
      <row r="8">${s('A8', 8)}${n('C8', 0.1234, 5)}</row>
      <row r="9">${s('A9', 9)}${n('C9', 46327, 6)}</row>
      <row r="10">${s('A10', 11)}</row>
    </sheetData>
    <mergeCells count="2"><mergeCell ref="A1:C1"/><mergeCell ref="A2:C2"/></mergeCells></worksheet>`;
  const styles = `<styleSheet>
    <numFmts count="1"><numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0.00_);\\(&quot;$&quot;#,##0.00\\)"/></numFmts>
    <fonts count="3"><font><sz val="11"/></font><font><b/><sz val="11"/></font><font><i/></font></fonts>
    <borders count="3"><border><left/><right/><top/><bottom/></border><border><top style="thin"/></border><border><top style="thin"><color auto="1"/></top><bottom style="double"/></border></borders>
    <cellStyleXfs count="1"><xf numFmtId="0" fontId="1" borderId="2"/></cellStyleXfs>
    <cellXfs count="9">
      <xf numFmtId="0" fontId="0" borderId="0"/>
      <xf numFmtId="4" fontId="0" borderId="0" applyNumberFormat="1"/>
      <xf numFmtId="164" fontId="1" borderId="2"/>
      <xf numFmtId="0" fontId="1" borderId="0" applyAlignment="1"><alignment horizontal="center"/></xf>
      <xf numFmtId="0" fontId="0" borderId="0"><alignment indent="2"/></xf>
      <xf numFmtId="10" fontId="2" borderId="0"/>
      <xf numFmtId="14" fontId="0" borderId="0"/>
      <xf numFmtId="164" fontId="0" borderId="0"/>
      <xf numFmtId="0" fontId="1" borderId="0"/>
    </cellXfs></styleSheet>`;
  return zip({
    '[Content_Types].xml': '<Types/>',
    'xl/workbook.xml': `<workbook xmlns:r="${REL}"><sheets><sheet name="Statement" sheetId="1" r:id="rId2"/><sheet name="Notes" sheetId="2" r:id="rId1"/><sheet name="Hidden" sheetId="3" state="hidden" r:id="rId3"/></sheets><definedNames><definedName name="_xlnm.Print_Titles" localSheetId="0">Statement!$4:$4</definedName></definedNames></workbook>`,
    'xl/_rels/workbook.xml.rels': `<Relationships><Relationship Id="rId1" Type="${REL}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${REL}/worksheet" Target="/xl/worksheets/sheet2.xml"/><Relationship Id="rId3" Type="${REL}/worksheet" Target="worksheets/sheet3.xml"/><Relationship Id="rId9" Type="${REL}/styles" Target="styles.xml"/></Relationships>`,
    'xl/sharedStrings.xml': sst,
    'xl/styles.xml': styles,
    'xl/worksheets/sheet1.xml': `<worksheet><sheetData><row r="2"><c r="B2" t="s"><v>10</v></c></row></sheetData></worksheet>`,
    'xl/worksheets/sheet2.xml': statement,
    'xl/worksheets/sheet3.xml': `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Inline</t></is></c></row></sheetData></worksheet>`,
  });
}

test('number formats read the way Excel shows them', () => {
  assert.equal(formatValue(1234.5, '#,##0.00'), '1,234.50');
  assert.equal(formatValue(1234567.891, '#,##0'), '1,234,568');
  assert.equal(formatValue(-1234.5, '"$"#,##0.00_);\\("$"#,##0.00\\)'), '($1,234.50)');
  assert.equal(formatValue(1234.5, '"$"#,##0.00_);\\("$"#,##0.00\\)'), '$1,234.50 ');
  // Accounting (built-in 44): the $ in front, negatives in parentheses, a dash for zero
  const acct = '_("$"* #,##0.00_);_("$"* \\(#,##0.00\\);_("$"* "-"??_);_(@_)';
  assert.equal(formatValue(-42, acct).trim(), '$(42.00)');
  assert.equal(formatValue(0, acct).trim(), '$-');
  assert.equal(formatValue(0.1234, '0.00%'), '12.34%');
  assert.equal(formatValue(0.5, '0%'), '50%');
  assert.equal(formatValue(-3, '0'), '-3');
  assert.equal(formatValue(-3, '#,##0;[Red]-#,##0'), '-3');
  assert.equal(formatValue(2500000, '#,##0,,"M"'), '3M');
  assert.equal(formatValue(1.5, '0.0#'), '1.5');
  assert.equal(formatValue(1.555, '0.0#'), '1.56');
  assert.equal(formatValue(12.3, 'General'), '12.3');
  assert.equal(formatValue(1234, '[$$-409]#,##0'), '$1,234');
  assert.equal(formatValue(12345.678, '0.00E+00'), '1.23E+04');
  // Dates: the 1900 system (with its February 29, 1900 that never was) and the 1904 one
  assert.equal(formatValue(46327, 'm/d/yyyy'), '11/1/2026');
  assert.equal(formatValue(46327, 'mmmm d, yyyy'), 'November 1, 2026');
  assert.equal(formatValue(46327, 'dddd'), 'Sunday');
  assert.equal(formatValue(61, 'yyyy-mm-dd'), '1900-03-01');
  assert.equal(formatValue(1, 'yyyy-mm-dd'), '1900-01-01');
  assert.equal(formatValue(0, 'yyyy-mm-dd', { d1904: true }), '1904-01-01');
  assert.equal(formatValue(46327.75, 'h:mm AM/PM'), '6:00 PM');
  assert.equal(formatValue(0.0625, 'h:mm'), '1:30');
  assert.equal(formatValue(1.5, '[h]:mm'), '36:00');
  assert.equal(formatValue('Note', '0;-0;0;"Text: "@'), 'Text: Note');
});

test('a workbook: sheets in its own order, hidden rows and columns out, formats, totals, merges, indents', async () => {
  const sheets = await readSheets(workbook());
  assert.deepEqual(sheets.map((s) => [s.name, s.hidden]), [['Statement', false], ['Notes', false], ['Hidden', true]]);
  const st = sheets[0];
  // Column B is hidden: A and C are shown, at Excel's widths
  assert.deepEqual(st.cols, [285, 110]);
  const texts = st.rows.map((r) => r.cells.map((c) => c.text));
  assert.equal(st.rows.length, 9, 'the hidden row is left out');
  assert.ok(!texts.flat().includes('secret'));
  assert.ok(!texts.flat().includes('hidden col'));
  const title = st.rows[0].cells[0];
  assert.equal(title.text, 'Example Org');
  assert.equal(title.colSpan, 2, 'merged across the two shown columns');
  assert.equal(title.align, 'center');
  assert.equal(title.bold, true);
  const checking = st.rows[3].cells;
  assert.deepEqual(checking.map((c) => [c.c, c.text]), [[0, 'Checking'], [1, '1,234.50']]);
  assert.equal(checking[0].indent, 1, 'leading spaces are an indent');
  assert.equal(checking[1].align, 'right');
  const savings = st.rows[4].cells;
  assert.equal(savings[0].indent, 2);
  assert.equal(savings[1].text, '($250.00)');
  const total = st.rows[5];
  assert.equal(total.height, 32);
  assert.equal(total.cells[0].bold, true);
  assert.equal(total.cells[1].text, '$984.50 ');
  assert.equal(total.cells[1].borderTop, 'thin');
  assert.equal(total.cells[1].borderBottom, 'double');
  assert.equal(st.rows[6].cells[1].text, '12.34%');
  assert.equal(st.rows[6].cells[1].italic, true);
  assert.equal(st.rows[7].cells[1].text, '11/1/2026');
  assert.equal(st.rows[8].cells[0].text, 'Rich text', 'rich text runs join; phonetic runs stay out');
  // The empty row 1 and column A of Notes are trimmed away
  assert.deepEqual(sheets[1].rows.map((r) => r.cells.map((c) => [c.c, c.text])), [[[0, 'Notes sheet']]]);
  assert.equal(sheets[1].cols.length, 1);
  assert.equal(sheets[2].rows[0].cells[0].text, 'Inline');
  // Excel's print titles (row 4 here, the third row shown) repeat on each page a sheet runs onto
  assert.deepEqual(st.repeat, [2]);
});

// ── A Word document: a title, headings (one by a localized style id), Word's own numbering, a table, a page break
function document() {
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const p = (text, { style = '', num = null, extra = '' } = {}) => `<w:p><w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}${num ? `<w:numPr><w:ilvl w:val="${num[1]}"/><w:numId w:val="${num[0]}"/></w:numPr>` : ''}</w:pPr><w:r><w:t xml:space="preserve">${text}</w:t></w:r>${extra}</w:p>`;
  const body = [
    p('Example Board Minutes', { style: 'Title' }),
    p('Call to order', { style: 'Heading1' }),
    p('Roll call', { num: [1, 0] }),
    p('Quorum present', { num: [1, 1] }),
    p('Guests', { num: [1, 1] }),
    p('Reports', { num: [1, 0] }),
    p('Treasurer', { num: [1, 1] }),
    `<w:p><w:r><w:t xml:space="preserve">Plain then </w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>bold</w:t></w:r><w:r><w:rPr><w:b w:val="0"/><w:i/></w:rPr><w:t xml:space="preserve"> and italic</w:t></w:r><w:del><w:r><w:delText>gone</w:delText></w:r></w:del></w:p>`,
    `<w:tbl><w:tblGrid><w:gridCol w:w="3000"/><w:gridCol w:w="1500"/></w:tblGrid>
      <w:tr><w:trPr><w:tblHeader/></w:trPr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr>${p('Both columns')}</w:tc></w:tr>
      <w:tr><w:tc>${p('Left')}</w:tc><w:tc>${p('Right')}</w:tc></w:tr></w:tbl>`,
    `<w:p><w:r><w:t>Before the break</w:t><w:br w:type="page"/><w:t>After the break</w:t></w:r></w:p>`,
    p('Ausblick', { style: 'berschrift2' }),
    `<w:p><w:pPr><w:pageBreakBefore/></w:pPr><w:r><w:t>New page</w:t></w:r></w:p>`,
  ].join('');
  const lvl = (i, fmt, text) => `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${text}"/></w:lvl>`;
  return zip({
    '[Content_Types].xml': '<Types/>',
    'word/document.xml': `<w:document ${W}><w:body>${body}<w:sectPr/></w:body></w:document>`,
    'word/numbering.xml': `<w:numbering ${W}><w:abstractNum w:abstractNumId="7">${lvl(0, 'decimal', '%1.')}${lvl(1, 'lowerLetter', '%2)')}</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="7"/></w:num></w:numbering>`,
    'word/styles.xml': `<w:styles ${W}><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="berschrift2"><w:name w:val="heading 2"/></w:style></w:styles>`,
    'word/_rels/document.xml.rels': `<Relationships><Relationship Id="rId5" Type="${REL}/image" Target="media/image1.png"/><Relationship Id="rId6" Type="${REL}/image" Target="media/old.emf"/></Relationships>`,
    'word/media/image1.png': new Uint8Array([137, 80, 78, 71]),
    'word/media/old.emf': new Uint8Array([1, 2, 3]),
  });
}

test('a Word document: title, headings, Word’s numbering, bold runs, a table, page breaks', async () => {
  const blocks = await readWord(document());
  const text = (b) => b.runs.map((r) => r.text).join('');
  assert.equal(blocks[0].style, 'title');
  assert.equal(text(blocks[0]), 'Example Board Minutes');
  assert.equal(blocks[1].style, 'h1');
  assert.deepEqual(blocks.slice(2, 7).map((b) => [b.list.marker, b.list.level, text(b)]), [['1.', 0, 'Roll call'], ['a)', 1, 'Quorum present'], ['b)', 1, 'Guests'], ['2.', 0, 'Reports'], ['a)', 1, 'Treasurer']]);
  assert.deepEqual(blocks[7].runs, [{ text: 'Plain then ', bold: false, italic: false, underline: false }, { text: 'bold', bold: true, italic: false, underline: false }, { text: ' and italic', bold: false, italic: true, underline: false }]);
  const t = blocks[8];
  assert.equal(t.type, 'table');
  assert.deepEqual(t.grid, [200, 100]);
  assert.equal(t.rows[0][0].colSpan, 2);
  assert.equal(t.head, 1, 'the row marked to repeat as a header');
  assert.equal(text(t.rows[0][0].blocks[0]), 'Both columns');
  assert.deepEqual(t.rows[1].map((c) => text(c.blocks[0])), ['Left', 'Right']);
  assert.equal(text(blocks[9]), 'Before the break');
  assert.equal(blocks[10].type, 'break');
  assert.equal(text(blocks[11]), 'After the break');
  assert.equal(blocks[12].style, 'h2', 'a localized style id is a heading by its name');
  assert.equal(blocks[13].pageBreakBefore, true);
  const pics = await wordImages(document());
  assert.deepEqual(Object.keys(pics), ['rId5'], 'EMF pictures, which browsers can’t draw, are left out');
  assert.equal(pics.rId5.type, 'image/png');
});

// ── A deck whose slide files are numbered out of the order the deck shows them
function deck() {
  const ns = 'xmlns:a="a" xmlns:p="p" xmlns:r="r"';
  const sp = (ph, xfrm, paras) => `<p:sp><p:nvSpPr><p:cNvPr id="2" name="s"/><p:cNvSpPr/><p:nvPr>${ph ? `<p:ph type="${ph}"/>` : ''}</p:nvPr></p:nvSpPr><p:spPr>${xfrm}</p:spPr><p:txBody><a:bodyPr/>${paras}</p:txBody></p:sp>`;
  const para = (text, lvl = 0, extra = '') => `<a:p><a:pPr lvl="${lvl}">${extra}</a:pPr><a:r><a:rPr lang="en-US" sz="2400" b="${lvl ? 0 : 1}"/><a:t>${text}</a:t></a:r></a:p>`;
  const xfrm = '<a:xfrm><a:off x="952500" y="952500"/><a:ext cx="9525000" cy="1905000"/></a:xfrm>';
  const slideA = `<p:sld ${ns}><p:cSld><p:spTree>${sp('title', xfrm, para('First slide'))}${sp('body', '', para('Point A') + para('Sub point', 1) + para('No dot', 0, '<a:buNone/>'))}<p:pic><p:blipFill><a:blip r:embed="rId2"/></p:blipFill><p:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="952500" cy="952500"/></a:xfrm></p:spPr></p:pic></p:spTree></p:cSld></p:sld>`;
  const slideB = `<p:sld ${ns}><p:cSld><p:spTree>${sp('title', '', para('Second slide'))}</p:spTree></p:cSld></p:sld>`;
  return zip({
    'ppt/presentation.xml': `<p:presentation ${ns}><p:sldIdLst><p:sldId id="256" r:id="rId3"/><p:sldId id="257" r:id="rId2"/></p:sldIdLst><p:sldSz cx="12192000" cy="6858000"/></p:presentation>`,
    'ppt/_rels/presentation.xml.rels': `<Relationships><Relationship Id="rId2" Type="${REL}/slide" Target="slides/slide1.xml"/><Relationship Id="rId3" Type="${REL}/slide" Target="slides/slide2.xml"/></Relationships>`,
    'ppt/slides/slide1.xml': slideB,
    'ppt/slides/slide2.xml': slideA,
    'ppt/slides/_rels/slide2.xml.rels': `<Relationships><Relationship Id="rId2" Type="${REL}/image" Target="../media/image1.png"/></Relationships>`,
    'ppt/media/image1.png': new Uint8Array([137, 80, 78, 71]),
  });
}

test('a deck: the slides in the deck’s order, titles, bullets by level, pictures', async () => {
  const d = await readSlides(deck());
  assert.equal(d.w, 1280);
  assert.equal(d.h, 720);
  const textOf = (s) => s.paragraphs.map((p) => p.runs.map((r) => r.text).join(''));
  assert.deepEqual(d.slides.map((s) => textOf(s.shapes.find((x) => x.title))), [['First slide'], ['Second slide']]);
  const [first] = d.slides;
  const title = first.shapes.find((x) => x.title);
  assert.deepEqual([title.x, title.y, title.w, title.h], [100, 100, 1000, 200]);
  const body = first.shapes.find((x) => x.kind === 'text' && !x.title);
  assert.equal(body.x, undefined, 'placed by the layout: no box of its own');
  assert.equal(title.ph, 'title');
  assert.deepEqual(body.paragraphs.map((p) => [p.level, p.bullet, p.runs[0].text]), [[0, '•', 'Point A'], [1, '•', 'Sub point'], [0, '', 'No dot']]);
  assert.equal(body.paragraphs[0].runs[0].size, 24);
  const pic = first.shapes.find((x) => x.kind === 'picture');
  assert.equal(first.images[pic.rId], 'ppt/media/image1.png');
  const imgs = await slideImages(deck(), 0);
  assert.equal(imgs[pic.rId].type, 'image/png');
});

test('what each file is', () => {
  assert.equal(docKind({ name: 'Report.pdf' }), 'pdf');
  assert.equal(docKind({ name: 'Statement.xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'sheet');
  assert.equal(docKind({ name: 'Minutes.docx' }), 'word');
  assert.equal(docKind({ name: 'Deck.pptx' }), 'slides');
  assert.equal(docKind({ name: 'Q1 sales.png', type: 'image/png' }), 'image');
  assert.equal(docKind({ name: 'Old minutes.doc', type: 'application/msword' }), 'other');
  assert.equal(docKind({ name: 'Old.xls' }), 'other');
});

test('a tall page is shown in two halves, cut at the blank line nearest its middle, never through a line; a short or wide page whole', () => {
  const size = { w: 816, h: 1056 };
  // A statement: 40 lines top to bottom, a little space between each
  const rows = Array.from({ length: 40 }, (_, i) => ({ y0: 0.08 + i * 0.021, y1: 0.092 + i * 0.021, x0: 0.1, x1: 0.9 }));
  const lay = splitOf(rows, size);
  assert.equal(lay.n, 2);
  assert.ok(Math.abs(lay.cut - (lay.part.y + lay.part.h / 2)) < 0.03, 'near the middle');
  assert.ok(!rows.some((r) => r.y0 < lay.cut && r.y1 > lay.cut), 'never through a line');
  const top = halfOf(lay, 0);
  const bottom = halfOf(lay, 1);
  assert.equal(top.y, lay.part.y);
  assert.ok(Math.abs(top.y + top.h - bottom.y) < 1e-9 && Math.abs(bottom.y + bottom.h - (lay.part.y + lay.part.h)) < 1e-9, 'the halves meet at the cut and cover it all');
  // A few lines (a short memo, a cover page): wider than tall, so whole; a landscape slide whole
  assert.equal(splitOf(rows.slice(0, 6), size).n, 1);
  assert.equal(splitOf([{ y0: 0.1, y1: 0.9, x0: 0.05, x1: 0.95 }], { w: 1056, h: 816 }).n, 1);
  assert.deepEqual(splitOf([], size), { part: null, cut: 0, n: 1 });
  assert.equal(halfOf({ part: null, n: 1 }, 1), null);
  assert.deepEqual(halfOf(splitOf(rows.slice(0, 6), size), 1), splitOf(rows.slice(0, 6), size).part, 'a page shown whole is its content either way');
});
