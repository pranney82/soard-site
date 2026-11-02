/**
 * Board → a meeting → Minutes template
 * ===========================================================================
 * The meeting's own agenda as the page the minutes are taken on: who's on the
 * roll, each part and item in order with who presents it, room under each
 * item, the motions and the action items. Two ways:
 *   Print       a paper form for writing by hand: boxes to tick for the roll,
 *               ruled lines under each item, a motion line on the minutes
 *               item, tables for the motions and the action items, the
 *               secretary's signature
 *   Word file   the same, to type into. It's laid out the way Board reads
 *               minutes back (parseAgendaText): the attendee table with an
 *               "x" before each name there, numbered parts in capitals, the
 *               items numbered under them with who presents in brackets, and
 *               an empty bullet under each item. Dropped in after the meeting,
 *               each item's notes land on that item, nothing to match by hand.
 *               Nothing in it is sample wording: an example motion left in
 *               would be read as a motion the board voted on.
 * Built from text alone (DOM nodes for the print, escaped XML for Word), so
 * nothing typed into an agenda can turn into markup.
 */

import { meetingName, longDate, timeRange, agendaItems, sectionPlan, clock, quorumFor, nextMeeting, isDate, isFilled, LIVE_TITLES } from './board-shared.js';

/**
 * What the template holds, for both ways of having it: the meeting, the roll (board, then staff), the quorum, each
 * part with its planned time and its items, and the next meeting. `meetings`: Board's meetings (for the next one);
 * `quorum`: Settings' number, when the bylaws set one.
 */
export function minutesOutline(m, { meetings = [], quorum = 0 } = {}) {
  const labels = new Map(agendaItems(m).map((x) => [x.id, x.label]));
  const plan = sectionPlan(m);
  const roll = [...m.attendance.filter((p) => p.kind === 'board'), ...m.attendance.filter((p) => p.kind === 'staff')].map((p) => ({ name: p.name, kind: p.kind }));
  const next = nextMeeting((meetings || []).filter((x) => x.id !== m.id && !x.practice && !x.notBoard && isDate(x.date) && x.date > (m.date || '')), m.date || undefined);
  return {
    name: meetingName(m),
    date: isDate(m.date) ? longDate(m.date) : '',
    time: timeRange(m.start, m.end),
    place: [m.location, m.address].filter(Boolean).join(', '),
    roll,
    board: roll.filter((p) => p.kind === 'board').length,
    quorum: quorumFor(m, quorum),
    parts: m.sections.filter((s) => s.title || s.items.some(isFilled)).map((s) => {
      const t = plan.get(s.id);
      return {
        title: s.title || 'Agenda',
        time: t ? [t.start ? clock(t.start) : '', t.minutes ? `${t.minutes} min` : ''].filter(Boolean).join(' · ') : '',
        items: s.items.filter(isFilled).map((it) => ({
          label: labels.get(it.id) || '',
          title: it.title || LIVE_TITLES[it.live] || 'Item',
          presenter: it.presenter || '',
          minutes: it.live === 'minutes',
        })),
      };
    }),
    next: next ? { name: meetingName(next), when: [longDate(next.date), next.start ? clock(next.start) : ''].filter(Boolean).join(', ') } : null,
  };
}

/** "Q4 2026 Board Meeting minutes (2026-11-05).docx": "minutes" and the date in the name, so Board's email and Drive readers file it on this meeting */
export const minutesFileName = (m) => `${meetingName(m).replace(/[\\/:*?"<>|]+/g, ' ').trim()} minutes${isDate(m.date) ? ` (${m.date})` : ''}.docx`;

// ─── The Word file ──────────────────────────────────────────────────

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
const run = (text, { b = false, color = '', sz = 0 } = {}) => (text ? `<w:r>${b || color || sz ? `<w:rPr>${b ? '<w:b/>' : ''}${color ? `<w:color w:val="${color}"/>` : ''}${sz ? `<w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/>` : ''}</w:rPr>` : ''}<w:t xml:space="preserve">${esc(text)}</w:t></w:r>` : '');
// A paragraph: a style, and a place in the agenda's list (level 0 a part, 1 an item, 2 a note under it)
const para = (runs, { style = '', level = -1 } = {}) => `<w:p>${style || level >= 0 ? `<w:pPr>${style ? `<w:pStyle w:val="${style}"/>` : ''}${level >= 0 ? `<w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="1"/></w:numPr>` : ''}</w:pPr>` : ''}${runs}</w:p>`;
const MUTED = '6B6B6B';
const cell = (content, width, { head = false } = {}) => `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/>${head ? '<w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/>' : ''}<w:vAlign w:val="center"/></w:tcPr>${content}</w:tc>`;
const cellPara = (text, { b = false, center = false } = {}) => `<w:p><w:pPr><w:pStyle w:val="Cell"/>${center ? '<w:jc w:val="center"/>' : ''}</w:pPr>${run(text, { b })}</w:p>`;

/**
 * The roll as Word's table: "x" typed in the first column for each person there, "video" or "excused" in the last.
 * Read back one row to a line ("x Pat Sample video"), the way SOARD's attendee tables always read.
 */
function rollTable(roll) {
  const widths = [1100, 4300, 3960];
  const border = (side) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>`;
  const head = `<w:tr><w:trPr><w:tblHeader/></w:trPr>${cell(cellPara('Here (x)', { b: true, center: true }), widths[0], { head: true })}${cell(cellPara('Name', { b: true }), widths[1], { head: true })}${cell(cellPara('On video, or excused', { b: true }), widths[2], { head: true })}</w:tr>`;
  const rows = roll.map((p) => `<w:tr><w:trPr><w:cantSplit/></w:trPr>${cell(cellPara('', { center: true }), widths[0])}${cell(cellPara(p.name), widths[1])}${cell(cellPara(''), widths[2])}</w:tr>`).join('');
  return `<w:tbl><w:tblPr><w:tblW w:w="${widths.reduce((a, b) => a + b, 0)}" w:type="dxa"/><w:tblBorders>${['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(border).join('')}</w:tblBorders><w:tblLayout w:type="fixed"/><w:tblCellMar><w:top w:w="60" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:bottom w:w="60" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>${head}${rows}</w:tbl>`;
}

function documentXml(o) {
  const body = [];
  body.push(para(run(`${o.name} minutes`), { style: 'Title' }));
  body.push(para(run('Sunshine on a Ranney Day · Board of Directors', { color: MUTED }), { style: 'Sub' }));
  // "Date …" and "Location …" lines: the reader passes over them (the meeting already knows both)
  if (o.date) body.push(para(`${run('Date  ', { b: true })}${run([o.date, o.time].filter(Boolean).join(', '))}`, { style: 'Fact' }));
  if (o.place) body.push(para(`${run('Location  ', { b: true })}${run(o.place)}`, { style: 'Fact' }));
  body.push(para(run('Minutes taken by: ', { b: true }), { style: 'Fact' }));
  body.push(para(run('Who was there'), { style: 'Head' }));
  body.push(rollTable(o.roll));
  body.push(para(run('Guests: ', { b: true }), { style: 'Gap' }));
  if (o.board) body.push(para(run(`Quorum: ${o.quorum} of ${o.board} board members, here or on video.`, { color: MUTED }), { style: 'Fact' }));
  // The agenda: each part in capitals (how the reader knows a part from an item), each item under it, a bullet to type on
  for (const part of o.parts) {
    body.push(para(run(part.title.toUpperCase()), { style: 'Part', level: 0 }));
    if (!part.items.length) { body.push(para('', { style: 'Item', level: 1 })); continue; }
    for (const it of part.items) {
      body.push(para(`${run(it.title)}${it.presenter ? run(` (${it.presenter})`, { color: MUTED }) : ''}`, { style: 'Item', level: 1 }));
      body.push(para('', { style: 'Note', level: 2 }));
    }
  }
  // Read for the motions and the action items, never made into agenda parts
  body.push(para(run('MOTIONS'), { style: 'Part', level: 0 }));
  body.push(para('', { style: 'Item', level: 1 }));
  body.push(para(run('ACTION ITEMS'), { style: 'Part', level: 0 }));
  body.push(para('', { style: 'Item', level: 1 }));
  body.push(para(run('Adjourned at: ', { b: true }), { style: 'Close' }));
  if (o.next) body.push(para(`${run('Next meeting: ', { b: true })}${run(`${o.next.name}, ${o.next.when}`)}`, { style: 'Fact' }));
  const sect = '<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1080" w:right="1080" w:bottom="1080" w:left="1080" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>';
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<w:document ${W}><w:body>${body.join('')}${sect}</w:body></w:document>`;
}

const FONT = '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/>';
const style = (id, name, { rpr = '', ppr = '' } = {}) => `<w:style w:type="paragraph" w:customStyle="1" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr>${ppr}</w:pPr><w:rPr>${rpr}</w:rPr></w:style>`;
const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles ${W}><w:docDefaults><w:rPrDefault><w:rPr>${FONT}<w:sz w:val="22"/><w:szCs w:val="22"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="80" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:qFormat/><w:pPr><w:spacing w:after="40"/></w:pPr><w:rPr><w:b/><w:sz w:val="40"/><w:szCs w:val="40"/></w:rPr></w:style>
${style('Sub', 'Template subtitle', { ppr: '<w:spacing w:after="240"/>', rpr: '<w:sz w:val="20"/><w:szCs w:val="20"/>' })}
${style('Fact', 'Template fact', { ppr: '<w:spacing w:after="60"/>' })}
${style('Gap', 'Template fact after a table', { ppr: '<w:spacing w:before="160" w:after="60"/>' })}
${style('Head', 'Template heading', { ppr: '<w:keepNext/><w:spacing w:before="240" w:after="100"/>', rpr: '<w:b/><w:sz w:val="24"/><w:szCs w:val="24"/>' })}
${style('Cell', 'Template cell', { ppr: '<w:spacing w:after="0"/>' })}
${style('Part', 'Agenda part', { ppr: '<w:keepNext/><w:spacing w:before="320" w:after="100"/>', rpr: '<w:b/><w:sz w:val="24"/><w:szCs w:val="24"/>' })}
${style('Item', 'Agenda item', { ppr: '<w:keepNext/><w:spacing w:before="140" w:after="40"/>', rpr: '<w:b/>' })}
${style('Note', 'Minutes note', { ppr: '<w:spacing w:after="40"/>' })}
${style('Close', 'Template close', { ppr: '<w:spacing w:before="360" w:after="60"/>' })}
</w:styles>`;

// The agenda's list: 1. a part, 1. an item under it (starting again in each part), • a note, ◦ a note under a note
const lvl = (i, fmt, text, left, hanging, { font = '' } = {}) => `<w:lvl w:ilvl="${i}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${left}" w:hanging="${hanging}"/></w:pPr>${font ? `<w:rPr><w:rFonts w:ascii="${font}" w:hAnsi="${font}"/></w:rPr>` : ''}</w:lvl>`;
const NUMBERING = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering ${W}><w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="multilevel"/>${lvl(0, 'decimal', '%1.', 432, 432)}${lvl(1, 'decimal', '%2.', 864, 432)}${lvl(2, 'bullet', '•', 1224, 288, { font: 'Calibri' })}${lvl(3, 'bullet', '◦', 1584, 288, { font: 'Calibri' })}${lvl(4, 'bullet', '▪', 1944, 288, { font: 'Calibri' })}</w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`;

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`;
const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`;
const DOC_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/></Relationships>`;
const core = (title) => `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(title)}</dc:title><dc:creator>SOARD Board</dc:creator></cp:coreProperties>`;

// A zip with its files stored as they are (Word reads stored entries; nothing here is big enough to need squeezing):
// [[name, text]] → bytes
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (bytes) => { let c = 0xffffffff; for (const b of bytes) c = CRC[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
export function zip(files) {
  const enc = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of files) {
    const data = enc.encode(text);
    const nameBytes = enc.encode(name);
    const crc = crc32(data);
    const local = new DataView(new ArrayBuffer(30));
    // signature, version 2.0, no flags, stored, a 1980 date, crc, sizes, name length
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(8, 0, true); local.setUint16(12, 0x21, true);
    local.setUint32(14, crc, true); local.setUint32(18, data.length, true); local.setUint32(22, data.length, true); local.setUint16(26, nameBytes.length, true);
    parts.push(new Uint8Array(local.buffer), nameBytes, data);
    const dir = new DataView(new ArrayBuffer(46));
    dir.setUint32(0, 0x02014b50, true); dir.setUint16(4, 20, true); dir.setUint16(6, 20, true); dir.setUint16(14, 0x21, true);
    dir.setUint32(16, crc, true); dir.setUint32(20, data.length, true); dir.setUint32(24, data.length, true); dir.setUint16(28, nameBytes.length, true); dir.setUint32(42, offset, true);
    central.push(new Uint8Array(dir.buffer), nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const size = central.reduce((n, b) => n + b.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true); end.setUint32(12, size, true); end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, b) => n + b.length, 0));
  let at = 0;
  for (const b of all) { out.set(b, at); at += b.length; }
  return out;
}

/** The template as a Word file (.docx bytes) */
export function minutesDocx(m, opts = {}) {
  const o = minutesOutline(m, opts);
  return zip([
    ['[Content_Types].xml', CONTENT_TYPES],
    ['_rels/.rels', RELS],
    ['word/document.xml', documentXml(o)],
    ['word/_rels/document.xml.rels', DOC_RELS],
    ['word/styles.xml', STYLES],
    ['word/numbering.xml', NUMBERING],
    ['docProps/core.xml', core(`${o.name} minutes`)],
  ]);
}

/** Saves the Word file to the computer */
export function downloadMinutesDocx(m, opts = {}) {
  const blob = new Blob([minutesDocx(m, opts)], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = minutesFileName(m);
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 30000);
}

// ─── On paper ───────────────────────────────────────────────────────

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined && text !== null && text !== '') e.textContent = String(text); return e; };
const lines = (n) => { const box = el('div', 'mt-lines'); for (let i = 0; i < n; i++) box.append(el('span')); return box; };
const blank = (label, cls = '') => { const p = el('p', `mt-blank ${cls}`); p.append(el('span', 'mt-blank__label', label), el('span', 'mt-blank__line')); return p; };
const box = () => el('span', 'mt-box');
const choices = (words) => { const p = el('span', 'mt-choices'); for (const w of words) { const c = el('span', 'mt-choice'); c.append(box(), document.createTextNode(w)); p.append(c); } return p; };

const PRINT_CSS = `
.mt-print { display: none; }
@media print {
  @page { size: letter; margin: 0.55in 0.6in; }
  html.mt-printing body > :not(.mt-print) { display: none !important; }
  html.mt-printing body { background: #fff !important; padding: 0 !important; margin: 0 !important; }
  .mt-print { display: block; color: #111; font: 10.5pt/1.4 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .mt-print * { box-sizing: border-box; }
  .mt-head { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 0 1.5rem; align-items: end; padding-bottom: 0.6rem; border-bottom: 2px solid #111; }
  .mt-eyebrow { margin: 0 0 0.15rem; font-size: 8pt; letter-spacing: 0.08em; text-transform: uppercase; color: #555; }
  .mt-title { margin: 0; font-size: 19pt; line-height: 1.15; font-weight: 750; }
  .mt-when { margin: 0.25rem 0 0; color: #333; }
  .mt-tag { margin: 0; padding: 0.2rem 0.6rem; border: 1.5px solid #111; border-radius: 4px; font-size: 9pt; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; }
  .mt-row { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0 1.25rem; margin: 0.75rem 0 0.25rem; }
  .mt-blank { display: flex; align-items: flex-end; gap: 0.4rem; margin: 0; min-height: 1.6rem; }
  .mt-blank__label { flex: none; font-weight: 650; }
  .mt-blank__line { flex: 1; min-width: 2rem; border-bottom: 1px solid #888; height: 1rem; }
  .mt-h2 { display: flex; align-items: baseline; gap: 0.6rem; margin: 1.1rem 0 0.4rem; padding-bottom: 0.25rem; border-bottom: 1px solid #111; font-size: 12pt; font-weight: 750; break-after: avoid; }
  .mt-h2__n { font-variant-numeric: tabular-nums; color: #555; font-weight: 650; }
  .mt-h2__time { margin-left: auto; font-size: 9pt; font-weight: 500; color: #555; }
  .mt-roll { width: 100%; border-collapse: collapse; font-size: 10pt; }
  .mt-roll th, .mt-roll td { padding: 0.28rem 0.4rem; border-bottom: 1px solid #ccc; text-align: left; }
  .mt-roll th { font-size: 8pt; text-transform: uppercase; letter-spacing: 0.06em; color: #555; font-weight: 650; border-bottom-color: #111; }
  .mt-roll .c { width: 4.2rem; text-align: center; }
  .mt-roll tr.is-staff td { color: #444; }
  .mt-roll tr.is-first-staff td { border-top: 1.5px solid #888; }
  .mt-box { display: inline-block; width: 0.8rem; height: 0.8rem; border: 1.3px solid #333; border-radius: 2px; vertical-align: -0.12rem; }
  .mt-quorum { margin: 0.35rem 0 0; font-size: 9pt; color: #444; }
  .mt-item { margin: 0.55rem 0 0; break-inside: avoid; }
  .mt-item__t { display: flex; gap: 0.5rem; align-items: baseline; margin: 0; font-weight: 650; }
  .mt-item__n { flex: none; min-width: 1.9rem; font-variant-numeric: tabular-nums; color: #555; font-weight: 600; }
  .mt-item__who { margin-left: auto; padding-left: 0.75rem; font-weight: 500; color: #444; font-size: 9.5pt; white-space: nowrap; }
  .mt-lines { margin-left: 2.4rem; }
  .mt-lines span { display: block; height: 0.31in; border-bottom: 1px solid #bbb; }
  .mt-motion { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 0.3rem 0.9rem; margin: 0.35rem 0 0 2.4rem; padding: 0.45rem 0.6rem; border: 1px solid #999; border-radius: 4px; }
  .mt-motion .mt-blank { flex: 1 1 9rem; min-height: 1.3rem; }
  .mt-motion__what { flex: 1 1 100%; margin: 0; font-weight: 650; }
  .mt-choices { display: inline-flex; gap: 0.75rem; }
  .mt-choice { display: inline-flex; align-items: center; gap: 0.3rem; }
  .mt-log { width: 100%; border-collapse: collapse; font-size: 9.5pt; }
  .mt-log th { padding: 0.25rem 0.4rem; text-align: left; font-size: 8pt; text-transform: uppercase; letter-spacing: 0.06em; color: #555; font-weight: 650; border-bottom: 1px solid #111; }
  .mt-log td { height: 0.42in; padding: 0 0.4rem; border-bottom: 1px solid #bbb; vertical-align: bottom; }
  .mt-log td.mt-log__res { white-space: nowrap; font-size: 9pt; }
  .mt-part-break { break-inside: avoid; }
  .mt-close { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.5rem 1.5rem; margin-top: 1.2rem; break-inside: avoid; }
  .mt-close p { margin: 0; }
  .mt-next { grid-column: 1 / -1; color: #333; }
}`;

/** The template on paper: the browser's print window, then gone again */
export async function printMinutesTemplate(m, opts = {}) {
  const o = minutesOutline(m, opts);
  const root = el('div', 'mt-print');
  root.setAttribute('aria-hidden', 'true');
  const css = el('style');
  css.textContent = PRINT_CSS;
  root.append(css);

  const head = el('header', 'mt-head');
  const left = el('div');
  left.append(el('p', 'mt-eyebrow', 'Sunshine on a Ranney Day · Board of Directors'), el('h1', 'mt-title', o.name));
  const when = [o.date, o.time].filter(Boolean).join(' · ');
  if (when || o.place) left.append(el('p', 'mt-when', [when, o.place].filter(Boolean).join(' · ')));
  head.append(left, el('p', 'mt-tag', 'Minutes'));
  root.append(head);
  const row = el('div', 'mt-row');
  row.append(blank('Called to order'), blank('By'), blank('Minutes by'));
  root.append(row);

  // The roll: a box to tick for each person
  root.append(el('h2', 'mt-h2', 'Who was there'));
  const roll = el('table', 'mt-roll');
  const hr = el('tr');
  hr.append(el('th', '', 'Name'), ...['Here', 'Video', 'Absent', 'Excused'].map((t) => el('th', 'c', t)));
  const thead = el('thead'); thead.append(hr);
  const tbody = el('tbody');
  o.roll.forEach((p, i) => {
    const tr = el('tr', p.kind === 'staff' ? `is-staff${o.roll[i - 1]?.kind === 'board' ? ' is-first-staff' : ''}` : '');
    const name = el('td', '', p.name);
    if (p.kind === 'staff') name.append(document.createTextNode(' (staff)'));
    tr.append(name);
    for (let k = 0; k < 4; k++) { const td = el('td', 'c'); td.append(box()); tr.append(td); }
    tbody.append(tr);
  });
  roll.append(thead, tbody);
  root.append(roll);
  root.append(blank('Guests', 'mt-guests'));
  if (o.board) root.append(el('p', 'mt-quorum', `Quorum: ${o.quorum} of ${o.board} board members, here or on video.`));

  // The agenda, each item with room to write
  o.parts.forEach((part, pi) => {
    const sec = el('section');
    const h = el('h2', 'mt-h2');
    h.append(el('span', 'mt-h2__n', String(pi + 1).padStart(2, '0')), document.createTextNode(part.title));
    if (part.time) h.append(el('span', 'mt-h2__time', part.time));
    sec.append(h);
    if (!part.items.length) sec.append(lines(5));
    for (const it of part.items) {
      const item = el('div', 'mt-item');
      const t = el('p', 'mt-item__t');
      t.append(el('span', 'mt-item__n', it.label), el('span', '', it.title));
      if (it.presenter) t.append(el('span', 'mt-item__who', it.presenter));
      item.append(t);
      if (it.minutes) {
        // The vote every meeting takes
        const mo = el('div', 'mt-motion');
        mo.append(el('p', 'mt-motion__what', 'Motion to approve these minutes'), blank('Moved by'), blank('Seconded by'), choices(['Passed', 'Failed', 'Tabled']));
        item.append(mo, lines(1));
      } else item.append(lines(3));
      sec.append(item);
    }
    root.append(sec);
  });

  // The motions and the action items, as the meeting goes
  const log = (title, cols, rows, last) => {
    const sec = el('section', 'mt-part-break');
    sec.append(el('h2', 'mt-h2', title));
    const t = el('table', 'mt-log');
    const tr = el('tr');
    for (const [label, width] of cols) { const th = el('th', '', label); if (width) th.style.width = width; tr.append(th); }
    const th = el('thead'); th.append(tr);
    const tb = el('tbody');
    for (let i = 0; i < rows; i++) {
      const r = el('tr');
      for (let k = 0; k < cols.length; k++) {
        const td = el('td', k === cols.length - 1 && last ? 'mt-log__res' : '');
        if (k === cols.length - 1 && last) td.append(last());
        r.append(td);
      }
      tb.append(r);
    }
    t.append(th, tb);
    sec.append(t);
    root.append(sec);
  };
  log('Motions', [['Motion', ''], ['Moved by', '18%'], ['Seconded by', '18%'], ['Result', '13.5rem']], 5, () => choices(['Passed', 'Failed', 'Tabled']));
  log('Action items', [['What', ''], ['Who', '24%'], ['By when', '16%']], 6);

  const close = el('div', 'mt-close');
  close.append(blank('Adjourned at'), blank('Secretary’s signature'));
  if (o.next) close.append(el('p', 'mt-next', `Next meeting: ${o.next.name}, ${o.next.when}.`));
  root.append(close);

  document.body.append(root);
  document.documentElement.classList.add('mt-printing');
  await new Promise((resolve) => {
    const finish = () => { removeEventListener('afterprint', finish); resolve(); };
    addEventListener('afterprint', finish);
    requestAnimationFrame(() => setTimeout(() => window.print(), 50));
  });
  document.documentElement.classList.remove('mt-printing');
  root.remove();
}
