/**
 * board/docs.js — a meeting's file as pages
 * ==========================================
 * The presenting screen, the board page's follow-along view and "Print it
 * all" show a file the same way: as fixed pages, so "page 3" on the chair's
 * screen is page 3 on every board member's phone.
 *
 *   PDFs        pdf.js (../vendor-pdf.js), page by page
 *   Pictures    one page in the picture's own shape
 *   Excel       each sheet the way the report reads: its number formats,
 *               bold totals and their rules, merged titles, indents
 *   Word        the document flowed onto letter pages: headings, numbered
 *               lists, tables, pictures, page breaks
 *   PowerPoint  a page a slide: its text and pictures where the slide has them
 *   Anything else, or a file that doesn't open: a page that says so, with Download
 *
 * Pages are laid out in a fixed box (US Letter at 96 px to the inch) in the
 * site's own font, so where a page breaks never depends on the screen. A
 * file's content only ever goes in as text, never as HTML: the files come
 * from email and Drive. The readers (readSheets, readWord, readSlides) touch
 * no DOM, so they run in node too (tests/board-docs.test.mjs).
 *
 *   const doc = await openDoc(file)          cached by file, the last 8
 *   doc.count, doc.size(i)                   pages, and page i's box at 1x
 *   await doc.draw(i, { width })             an element exactly that wide
 *   await layoutOf(f, doc, i)                where its words are, and for a tall page where to cut it in two
 *   await partsOf(f)                         [1 | 2] a page: the halves the screen shows it in
 */

import { unzip, fileTitle } from '../board-shared.js';

export const PAGE = { w: 816, h: 1056 };
const LAND = { w: 1056, h: 816 };
const fileUrl = (f) => `/api/board-file?id=${encodeURIComponent(f.id)}`;

/** What a file is, for showing it: pdf | image | sheet | word | slides | other */
export function docKind(f) {
  const t = String(f?.type || '').toLowerCase();
  const n = String(f?.name || '').toLowerCase();
  if (t === 'application/pdf' || n.endsWith('.pdf')) return 'pdf';
  if (/\.(xlsx|xlsm)$/.test(n) || t.includes('spreadsheetml')) return 'sheet';
  if (/\.docx$/.test(n) || t.includes('wordprocessingml')) return 'word';
  if (/\.pptx$/.test(n) || t.includes('presentationml')) return 'slides';
  if (/\.(docx?|xlsx?|pptx?)$/.test(n)) return 'other';
  if (t.startsWith('image/') || /\.(jpe?g|png|gif|webp|avif|heic|heif|bmp|svg)$/.test(n)) return 'image';
  return 'other';
}
/** "Word 97–2003 file", for a file that can't be shown */
function formatName(f) {
  const ext = (String(f?.name || '').toLowerCase().match(/\.([a-z0-9]{2,5})$/) || [])[1] || '';
  return { doc: 'Word 97–2003 file', xls: 'Excel 97–2003 file', ppt: 'PowerPoint 97–2003 file', heic: 'iPhone photo (HEIC)', heif: 'iPhone photo (HEIF)', pdf: 'PDF', docx: 'Word file', xlsx: 'Excel file', pptx: 'PowerPoint file' }[ext] || (ext ? `${ext.toUpperCase()} file` : 'File');
}

// ─── XML, read as text ──────────────────────────────────────────────

const dec = new TextDecoder();
const textOf = (b) => (b ? dec.decode(b) : '');
const ENT = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' };
const unxml = (s) => String(s ?? '').replace(/&(#x[0-9a-f]+|#\d+|lt|gt|quot|apos|amp);/gi, (m, e) => {
  if (e[0] !== '#') return ENT[e.toLowerCase()];
  const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
  return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : '';
});
/** An attribute of an element's start tag, decoded (null when it isn't there) */
const ATTRS = {};
const attr = (el, name) => {
  if (!el) return null;
  const start = el.slice(0, el.indexOf('>') + 1);
  const m = start.match(ATTRS[name] ||= new RegExp(`\\s${name}=(?:"([^"]*)"|'([^']*)')`));
  return m ? unxml(m[1] ?? m[2]) : null;
};
const TAG = /<(\/?)([\w:.-]+)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
/** The element's children whose tag is one of `names`, as strings, in order */
function kids(xml, names) {
  const out = [];
  let depth = 0;
  let start = -1;
  let name = '';
  for (const m of String(xml || '').matchAll(TAG)) {
    const [whole, close, tag, , self] = m;
    if (close) {
      depth -= 1;
      if (depth === 0 && start >= 0 && tag === name) { out.push(xml.slice(start, m.index + whole.length)); start = -1; }
      continue;
    }
    if (self) { if (depth === 0 && names.includes(tag)) out.push(whole); continue; }
    if (depth === 0 && names.includes(tag)) { start = m.index; name = tag; }
    depth += 1;
  }
  return out;
}
/** What's between an element's start and end tags */
const inner = (el) => {
  if (!el) return '';
  const a = el.indexOf('>');
  return el[a - 1] === '/' ? '' : el.slice(a + 1, el.lastIndexOf('</'));
};
/** The first `tag` element anywhere inside, whole (nested ones of the same name included) */
function find(xml, tag, from = 0) {
  xml = String(xml || '');
  const open = new RegExp(`<${tag}(?=[\\s/>])`, 'g');
  open.lastIndex = from;
  const m = open.exec(xml);
  if (!m) return null;
  const any = new RegExp(`<(/?)${tag}(?=[\\s/>])((?:[^>"']|"[^"]*"|'[^']*')*?)(/?)>`, 'g');
  any.lastIndex = m.index;
  let depth = 0;
  for (let t; (t = any.exec(xml));) {
    if (t[1]) { depth -= 1; if (depth === 0) return xml.slice(m.index, t.index + t[0].length); }
    else if (t[3]) { if (depth === 0) return t[0]; }
    else depth += 1;
  }
  return xml.slice(m.index);
}
/** Every outermost `tag` element anywhere inside */
function all(xml, tag) {
  const out = [];
  xml = String(xml || '');
  for (let at = 0, el; (el = find(xml, tag, at));) {
    const i = xml.indexOf(el, at);
    out.push(el);
    at = i + el.length;
  }
  return out;
}
/** A flag element that's on: <b/>, <b val="1"/>, never <b val="0"/> */
const on = (el) => !!el && !/\s(?:\w+:)?val="(0|false|off|none)"/.test(el.slice(0, el.indexOf('>') + 1));
/** A path a relationship points at, from the folder its .rels sits beside */
function resolve(base, target) {
  if (!target) return '';
  if (target.startsWith('/')) return target.slice(1);
  const parts = `${base}/${target}`.split('/');
  const out = [];
  for (const p of parts) { if (p === '..') out.pop(); else if (p && p !== '.') out.push(p); }
  return out.join('/');
}
/** { rId: { target, type, external } } from a .rels file */
function rels(xml) {
  const out = {};
  for (const r of all(xml, 'Relationship')) out[attr(r, 'Id')] = { target: attr(r, 'Target') || '', type: attr(r, 'Type') || '', external: attr(r, 'TargetMode') === 'External' };
  return out;
}
const MIME = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp', svg: 'image/svg+xml', tif: 'image/tiff', tiff: 'image/tiff' };
const mimeOf = (path) => MIME[(String(path).toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1]] || '';
/** The pictures a part points at: { rId: { bytes, type } } (EMF and WMF, which browsers can't draw, are left out) */
async function media(bytes, relsPath, base) {
  const r = rels(textOf((await unzip(bytes, [relsPath]))[relsPath]));
  const want = Object.entries(r).filter(([, x]) => !x.external && /\/image$/.test(x.type) && mimeOf(x.target)).map(([id, x]) => [id, resolve(base, x.target)]);
  const files = want.length ? await unzip(bytes, want.map(([, p]) => p)) : {};
  return Object.fromEntries(want.filter(([, p]) => files[p]).map(([id, p]) => [id, { bytes: files[p], type: mimeOf(p) }]));
}

// ─── Excel's number formats ─────────────────────────────────────────

const BUILTIN = {
  0: 'General', 1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00', 5: '"$"#,##0_);("$"#,##0)', 6: '"$"#,##0_);[Red]("$"#,##0)',
  7: '"$"#,##0.00_);("$"#,##0.00)', 8: '"$"#,##0.00_);[Red]("$"#,##0.00)', 9: '0%', 10: '0.00%', 11: '0.00E+00', 12: '# ?/?', 13: '# ??/??',
  14: 'm/d/yyyy', 15: 'd-mmm-yy', 16: 'd-mmm', 17: 'mmm-yy', 18: 'h:mm AM/PM', 19: 'h:mm:ss AM/PM', 20: 'h:mm', 21: 'h:mm:ss', 22: 'm/d/yyyy h:mm',
  37: '#,##0_);(#,##0)', 38: '#,##0_);[Red](#,##0)', 39: '#,##0.00_);(#,##0.00)', 40: '#,##0.00_);[Red](#,##0.00)',
  41: '_(* #,##0_);_(* \\(#,##0\\);_(* "-"_);_(@_)', 42: '_("$"* #,##0_);_("$"* \\(#,##0\\);_("$"* "-"_);_(@_)',
  43: '_(* #,##0.00_);_(* \\(#,##0.00\\);_(* "-"??_);_(@_)', 44: '_("$"* #,##0.00_);_("$"* \\(#,##0.00\\);_("$"* "-"??_);_(@_)',
  45: 'mm:ss', 46: '[h]:mm:ss', 47: 'mm:ss.0', 48: '##0.0E+0', 49: '@',
};
// Padding the width of a character (Excel's "_)"): a space that never collapses
const PAD = ' ';
/** A format's sections, split on the ; that aren't quoted or escaped */
function sectionsOf(code) {
  const out = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch === '"') quoted = !quoted;
    if (!quoted && ch === '\\') { cur += ch + (code[i + 1] ?? ''); i += 1; continue; }
    if (!quoted && ch === ';') { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  // Colors and conditions go; a currency tag ([$$-409]) leaves its symbol; elapsed time ([h]) stays
  return out.map((s) => s.replace(/\[([^\]]*)\]/g, (m, inside) => (inside.startsWith('$') ? (inside.slice(1).split('-')[0] ? `"${inside.slice(1).split('-')[0]}"` : '') : /^(h+|m+|s+)$/i.test(inside) ? m : '')));
}
/** The section without its quoted words, escapes, padding and fills: what's left decides what kind it is */
const bare = (s) => s.replace(/"[^"]*"/g, '').replace(/\\./g, '').replace(/[_*]./g, '');
const isDateSection = (s) => !/general/i.test(s) && /[ymdhs]/i.test(bare(s).replace(/E[+-]/gi, ''));
/** A number the way Excel's General shows it */
function general(v) {
  if (Number.isInteger(v) && Math.abs(v) < 1e11) return String(v);
  const a = Math.abs(v);
  if (a >= 1e11 || (a > 0 && a < 1e-9)) {
    const [m, e] = v.toExponential(5).split('e');
    return `${String(Number(m))}E${e[0] === '-' ? '-' : '+'}${String(Math.abs(Number(e))).padStart(2, '0')}`;
  }
  return String(Number(v.toPrecision(10)));
}
/** Rounded the way Excel rounds (on the decimal digits, so 1.555 is 1.56, not binary's 1.55) */
const roundTo = (x, d) => { const [m, e] = x.toExponential(14).split('e'); return Number(`${Math.round(Number(`${m}e${Number(e) + d}`))}e${-d}`); };
/** A run of digit placeholders (#,##0.00) filled in with a number that's already positive */
function digits(run, v, percent) {
  let x = v * 100 ** percent;
  const sci = /E[+-]/i.exec(run);
  if (sci) {
    const decs = (run.slice(0, sci.index).split('.')[1] || '').replace(/[^0#?]/g, '').length;
    const [m, e] = x.toExponential(decs).split('e');
    return `${m}E${e[0] === '-' ? '-' : '+'}${String(Math.abs(Number(e))).padStart(sci ? run.length - sci.index - 2 : 2, '0')}`;
  }
  const trail = run.match(/,+$/);
  if (trail) { x /= 1000 ** trail[0].length; run = run.slice(0, -trail[0].length); }
  const [ip, dp = ''] = run.split('.');
  const most = dp.replace(/[^0#?]/g, '').length;
  const least = dp.replace(/[^0?]/g, '').length;
  let [a, b = ''] = roundTo(x, most).toFixed(most).split('.');
  while (b.length > least && b.endsWith('0')) b = b.slice(0, -1);
  const minInt = ip.replace(/[^0]/g, '').length;
  if (a === '0' && minInt === 0) a = '';
  a = a.padStart(minInt, '0');
  if (ip.includes(',')) a = a.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return b ? `${a}.${b}` : a;
}
/** A number section filled in: its words and symbols as written, the number where its digits go */
function numberText(sec, v, textValue = null) {
  const percent = (bare(sec).match(/%/g) || []).length;
  let out = '';
  let done = false;
  for (let i = 0; i < sec.length;) {
    const ch = sec[i];
    if (ch === '"') { const j = sec.indexOf('"', i + 1); out += sec.slice(i + 1, j < 0 ? undefined : j); i = j < 0 ? sec.length : j + 1; continue; }
    if (ch === '\\') { out += sec[i + 1] ?? ''; i += 2; continue; }
    if (ch === '_') { out += PAD; i += 2; continue; }
    if (ch === '*') { i += 2; continue; }
    if (ch === '@') { out += textValue ?? ''; i += 1; continue; }
    if (/^general/i.test(sec.slice(i))) { out += textValue ?? general(v); i += 7; continue; }
    if (!done && textValue === null && (/[0#?]/.test(ch) || (ch === '.' && /[0#?]/.test(sec[i + 1] || '')))) {
      const m = sec.slice(i).match(/^[0#?,.]+(?:E[+-][0#]+)?/i);
      out += digits(m[0], v, percent);
      done = true;
      i += m[0].length;
      continue;
    }
    if (/[0#?]/.test(ch)) { out += ch === '?' ? ' ' : ''; i += 1; continue; }
    out += ch;
    i += 1;
  }
  return out;
}
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/** An Excel serial date as a UTC Date (the 1900 system counts a February 29, 1900 that never was) */
function serialDate(serial, d1904 = false) {
  const day = 86400000;
  const ms = d1904 ? Date.UTC(1904, 0, 1) + serial * day : serial < 60 ? Date.UTC(1899, 11, 31) + serial * day : Date.UTC(1899, 11, 30) + serial * day;
  return new Date(Math.round(ms / 1000) * 1000);
}
function dateText(v, sec, d1904) {
  const d = serialDate(v, d1904);
  const twelve = /AM\/PM|A\/P/i.test(sec);
  const toks = [];
  for (let i = 0; i < sec.length;) {
    const ch = sec[i];
    const rest = sec.slice(i);
    if (ch === '"') { const j = sec.indexOf('"', i + 1); toks.push({ lit: sec.slice(i + 1, j < 0 ? undefined : j) }); i = j < 0 ? sec.length : j + 1; continue; }
    if (ch === '\\') { toks.push({ lit: sec[i + 1] ?? '' }); i += 2; continue; }
    if (ch === '_') { toks.push({ lit: PAD }); i += 2; continue; }
    if (ch === '*') { i += 2; continue; }
    const ap = rest.match(/^(AM\/PM|A\/P)/i);
    if (ap) { toks.push({ ap: ap[0] }); i += ap[0].length; continue; }
    const el = rest.match(/^\[(h+|m+|s+)\]/i);
    if (el) { toks.push({ el: el[1][0].toLowerCase(), n: el[1].length }); i += el[0].length; continue; }
    const k = rest.match(/^(y+|m+|d+|h+|s+)(\.0+)?/i);
    if (k) { toks.push({ k: k[1].toLowerCase(), frac: k[2] || '' }); i += k[0].length; continue; }
    toks.push({ lit: ch });
    i += 1;
  }
  // "m" next to an hour or a second is minutes
  const keys = toks.map((t, i) => [t, i]).filter(([t]) => t.k || t.el);
  for (let j = 0; j < keys.length; j++) {
    const [t] = keys[j];
    if (t.k?.[0] !== 'm' || t.k.length > 2) continue;
    const prev = keys[j - 1]?.[0];
    const next = keys[j + 1]?.[0];
    if ((prev && (prev.k?.[0] === 'h' || prev.el === 'h')) || (next && (next.k?.[0] === 's' || next.el === 's'))) t.minute = true;
  }
  const pad = (n, w = 2) => String(n).padStart(w, '0');
  const Y = d.getUTCFullYear(); const M = d.getUTCMonth(); const D = d.getUTCDate();
  const H = d.getUTCHours(); const mi = d.getUTCMinutes(); const s = d.getUTCSeconds();
  return toks.map((t) => {
    if (t.lit !== undefined) return t.lit;
    if (t.ap) return t.ap.length > 3 ? (H < 12 ? 'AM' : 'PM') : (H < 12 ? 'A' : 'P');
    if (t.el) { const total = v * 24 * (t.el === 'h' ? 1 : t.el === 'm' ? 60 : 3600); return pad(Math.floor(Math.abs(total) + 1e-9), t.n); }
    const n = t.k.length;
    switch (t.k[0]) {
      case 'y': return n <= 2 ? pad(Y % 100) : String(Y);
      case 'm': return t.minute ? (n === 1 ? String(mi) : pad(mi)) : n === 1 ? String(M + 1) : n === 2 ? pad(M + 1) : n === 3 ? MONTHS[M].slice(0, 3) : n === 4 ? MONTHS[M] : MONTHS[M][0];
      case 'd': return n === 1 ? String(D) : n === 2 ? pad(D) : n === 3 ? DAYS[d.getUTCDay()].slice(0, 3) : DAYS[d.getUTCDay()];
      case 'h': { const h = twelve ? (H % 12 || 12) : H; return n === 1 ? String(h) : pad(h); }
      case 's': return (n === 1 ? String(s) : pad(s)) + (t.frac ? `.${'0'.repeat(t.frac.length - 1)}` : '');
      default: return '';
    }
  }).join('');
}
/** A cell's value shown with its number format (a number), or as written (text with a text section) */
export function formatValue(v, code = 'General', { d1904 = false } = {}) {
  code = String(code || 'General');
  const secs = sectionsOf(code);
  if (typeof v === 'string') return secs.length >= 4 ? numberText(secs[3], 0, v) : /^@$/.test(secs[0]) ? v : v;
  if (typeof v !== 'number' || !Number.isFinite(v)) return String(v ?? '');
  if (/^general$/i.test(code.trim())) return general(v);
  let sec = secs[0];
  let x = v;
  let minus = false;
  if (v < 0 && secs.length > 1 && secs[1] !== '') { sec = secs[1]; x = -v; }
  else if (v === 0 && secs.length > 2 && secs[2] !== '') sec = secs[2];
  else if (v < 0) { x = -v; minus = true; }
  if (isDateSection(sec)) return dateText(v, sec, d1904);
  const out = numberText(sec, x);
  return minus && /[1-9]/.test(out) ? `-${out}` : out;
}

// ─── Excel ──────────────────────────────────────────────────────────

/** Spreadsheet XML without its namespace prefixes (some writers put x: on every tag) */
const plain = (xml) => String(xml || '').replace(/<(\/?)[a-z]\w*:(?!\w+=)/gi, '<$1');
const COL = (letters) => [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
const refOf = (ref) => { const m = /^\$?([A-Z]+)\$?(\d+)$/.exec(String(ref || '').toUpperCase()); return m ? { c: COL(m[1]), r: Number(m[2]) - 1 } : null; };
const ruleOf = (el) => { const s = el && attr(el, 'style'); return !s || s === 'none' ? '' : s === 'double' ? 'double' : /medium|thick/.test(s) ? 'thick' : 'thin'; };
function readStyles(xml) {
  xml = plain(xml);
  const numFmts = {};
  for (const el of all(xml, 'numFmt')) numFmts[attr(el, 'numFmtId')] = attr(el, 'formatCode') || '';
  const fonts = kids(inner(find(xml, 'fonts')), ['font']).map((f) => ({ bold: on(find(f, 'b')), italic: on(find(f, 'i')) }));
  const borders = kids(inner(find(xml, 'borders')), ['border']).map((b) => ({ top: ruleOf(find(b, 'top')), bottom: ruleOf(find(b, 'bottom')) }));
  const xfs = kids(inner(find(xml, 'cellXfs')), ['xf']).map((x) => {
    const al = find(x, 'alignment');
    return { fmt: Number(attr(x, 'numFmtId') || 0), font: Number(attr(x, 'fontId') || 0), border: Number(attr(x, 'borderId') || 0), h: (al && attr(al, 'horizontal')) || '', indent: Number((al && attr(al, 'indent')) || 0), wrap: !!al && /^(1|true)$/.test(attr(al, 'wrapText') || '') };
  });
  return { numFmts, fonts, borders, xfs };
}
const alignOf = (h, kind) => (/^(center|centerContinuous)$/.test(h) ? 'center' : h === 'right' ? 'right' : /^(left|justify|distributed|fill)$/.test(h) ? 'left' : kind === 'n' ? 'right' : kind === 'b' || kind === 'e' ? 'center' : 'left');
const widthPx = (chars) => Math.round(chars * 7 + 5);

/**
 * An Excel workbook's sheets, in the workbook's order, each as it reads: [{ name, hidden, cols: [px], rows: [{ height?,
 * cells: [{ c, text, align, bold, italic, indent, colSpan, rowSpan, borderTop, borderBottom, wrap }] }] }]. Hidden rows and
 * columns are left out and `c` counts only the columns shown; empty rows and columns around the content are trimmed.
 */
export async function readSheets(bytes) {
  const z = await unzip(bytes, ['xl/workbook.xml', 'xl/_rels/workbook.xml.rels', 'xl/sharedStrings.xml', 'xl/styles.xml']);
  const wb = plain(textOf(z['xl/workbook.xml']));
  const wbRels = rels(textOf(z['xl/_rels/workbook.xml.rels']));
  const d1904 = /date1904="(1|true)"/.test(wb);
  let list = all(wb, 'sheet').map((s) => ({ name: attr(s, 'name') || 'Sheet', hidden: /hidden/i.test(attr(s, 'state') || ''), rel: wbRels[attr(s, 'r:id') ?? attr(s, 'id')] }))
    .filter((s) => s.rel && /\/worksheet$/.test(s.rel.type)).map((s) => ({ ...s, path: resolve('xl', s.rel.target) }));
  if (!list.length) list = [{ name: 'Sheet1', hidden: false, path: 'xl/worksheets/sheet1.xml' }];
  const sheetFiles = await unzip(bytes, list.map((s) => s.path));
  const ss = plain(textOf(z['xl/sharedStrings.xml'])).replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  const strings = kids(inner(find(ss, 'sst')), ['si']).map((si) => all(si, 't').map((t) => unxml(inner(t))).join(''));
  const st = readStyles(textOf(z['xl/styles.xml']));
  // Rows Excel repeats at the top of each printed page (Page Setup → Print titles), by the sheet's place in the workbook
  const titles = {};
  for (const d of all(wb, 'definedName')) {
    if (attr(d, 'name') !== '_xlnm.Print_Titles' || attr(d, 'localSheetId') == null) continue;
    const m = unxml(inner(d)).match(/\$(\d+):\$(\d+)/);
    if (m) titles[Number(attr(d, 'localSheetId'))] = [Number(m[1]) - 1, Number(m[2]) - 1];
  }
  return list.map((s, i) => ({ ...s, titles: titles[i] || null })).filter((s) => sheetFiles[s.path])
    .map((s) => ({ name: s.name, hidden: s.hidden, ...readSheet(plain(textOf(sheetFiles[s.path])), strings, st, d1904, s.titles) }));
}

function readSheet(xml, strings, st, d1904, titles = null) {
  const fmt = st.numFmts;
  const defW = Number(attr(find(xml, 'sheetFormatPr'), 'defaultColWidth')) || (Number(attr(find(xml, 'sheetFormatPr'), 'baseColWidth')) || 8) + 0.43;
  const colInfo = [];
  for (const c of all(inner(find(xml, 'cols')), 'col')) {
    const lo = Number(attr(c, 'min')) - 1;
    const hi = Math.min(Number(attr(c, 'max')) - 1, lo + 1000);
    for (let i = lo; i <= hi; i++) colInfo[i] = { width: Number(attr(c, 'width')) || defW, hidden: /^(1|true)$/.test(attr(c, 'hidden') || '') };
  }
  // Every cell that shows something: its text, or a rule (a total's line can sit on an empty cell)
  const grid = new Map();
  const rowInfo = new Map();
  let seq = -1;
  for (const row of kids(inner(find(xml, 'sheetData')), ['row'])) {
    const r = attr(row, 'r') ? Number(attr(row, 'r')) - 1 : seq + 1;
    seq = r;
    const custom = /^(1|true)$/.test(attr(row, 'customHeight') || '');
    rowInfo.set(r, { hidden: /^(1|true)$/.test(attr(row, 'hidden') || ''), height: custom && attr(row, 'ht') ? Math.round(Number(attr(row, 'ht')) * 96 / 72) : undefined });
    let cseq = -1;
    for (const cell of kids(inner(row), ['c'])) {
      const ref = refOf(attr(cell, 'r'));
      const c = ref ? ref.c : cseq + 1;
      cseq = c;
      const t = attr(cell, 't') || 'n';
      const xf = st.xfs[Number(attr(cell, 's') || 0)] || { fmt: 0, font: 0, border: 0, h: '', indent: 0 };
      const raw = find(cell, 'v');
      const v = raw ? unxml(inner(raw)) : '';
      let value = '';
      let kind = 's';
      if (t === 's') value = strings[Number(v)] ?? '';
      else if (t === 'inlineStr') value = all(find(cell, 'is'), 't').map((x) => unxml(inner(x))).join('');
      else if (t === 'str') value = v;
      else if (t === 'b') { value = v === '1' ? 'TRUE' : v === '' ? '' : 'FALSE'; kind = 'b'; }
      else if (t === 'e') { value = v; kind = 'e'; }
      else if (t === 'd') value = v.replace(/T00:00:00(\.0+)?Z?$/, '');
      else if (v !== '' && Number.isFinite(Number(v))) { value = Number(v); kind = 'n'; }
      const font = st.fonts[xf.font] || {};
      const border = st.borders[xf.border] || {};
      let text = kind === 'n' ? formatValue(value, fmt[xf.fmt] ?? BUILTIN[xf.fmt] ?? 'General', { d1904 }) : typeof value === 'string' && (fmt[xf.fmt] || BUILTIN[xf.fmt] || '').split(';').length >= 4 ? formatValue(value, fmt[xf.fmt] ?? BUILTIN[xf.fmt]) : String(value);
      // Account rows indented with spaces (QuickBooks) are indented, not padded
      let indent = xf.indent || 0;
      if (kind === 's') {
        const lead = text.match(/^[  ]+/)?.[0].length || 0;
        if (lead) { indent += Math.round(lead / 3) || 1; text = text.slice(lead); }
        text = text.replace(/\s+$/, '');
      }
      if (!text && !border.top && !border.bottom) continue;
      if (!grid.has(r)) grid.set(r, new Map());
      grid.get(r).set(c, { text, align: alignOf(xf.h, kind), bold: !!font.bold, italic: !!font.italic, indent, borderTop: border.top || '', borderBottom: border.bottom || '', wrap: !!xf.wrap, filled: !!text });
    }
  }
  const merges = all(inner(find(xml, 'mergeCells')), 'mergeCell').map((m) => {
    const [a, b] = String(attr(m, 'ref') || '').split(':').map(refOf);
    return a && b ? { r1: a.r, c1: a.c, r2: b.r, c2: b.c } : null;
  }).filter(Boolean);
  const hiddenRow = (r) => !!rowInfo.get(r)?.hidden;
  const hiddenCol = (c) => !!colInfo[c]?.hidden;
  // The part of the sheet with something in it (merged titles count to their right edge)
  let r0 = Infinity; let r1 = -1; let c0 = Infinity; let c1 = -1;
  for (const [r, cells] of grid) {
    if (hiddenRow(r)) continue;
    for (const [c, cell] of cells) {
      if (hiddenCol(c) || (!cell.filled && !cell.borderTop && !cell.borderBottom)) continue;
      const m = merges.find((x) => x.r1 === r && x.c1 === c);
      r0 = Math.min(r0, r); r1 = Math.max(r1, m ? m.r2 : r);
      c0 = Math.min(c0, c); c1 = Math.max(c1, m ? m.c2 : c);
    }
  }
  if (r1 < 0) return { cols: [], rows: [], repeat: [] };
  // Only what's filled sets the edges; a rule alone past the last word or number doesn't widen the sheet
  let fr = -1; let fc = -1;
  for (const [r, cells] of grid) for (const [c, cell] of cells) if (cell.filled && !hiddenRow(r) && !hiddenCol(c)) { const m = merges.find((x) => x.r1 === r && x.c1 === c); fr = Math.max(fr, m ? m.r2 : r); fc = Math.max(fc, m ? m.c2 : c); }
  if (fr >= 0) { r1 = Math.min(r1, fr); c1 = Math.min(c1, fc); }
  const shownCols = [];
  for (let c = c0; c <= c1; c++) if (!hiddenCol(c)) shownCols.push(c);
  const colAt = new Map(shownCols.map((c, i) => [c, i]));
  const shownRows = [];
  for (let r = r0; r <= r1; r++) if (!hiddenRow(r)) shownRows.push(r);
  const covered = new Set();
  for (const m of merges) for (let r = m.r1; r <= m.r2; r++) for (let c = m.c1; c <= m.c2; c++) if (r !== m.r1 || c !== m.c1) covered.add(`${r}:${c}`);
  const rows = shownRows.map((r) => {
    const cells = [];
    for (const [c, cell] of [...(grid.get(r) || new Map())].sort((a, b) => a[0] - b[0])) {
      if (!colAt.has(c) || covered.has(`${r}:${c}`)) continue;
      const m = merges.find((x) => x.r1 === r && x.c1 === c);
      const colSpan = m ? shownCols.filter((x) => x >= m.c1 && x <= m.c2).length || 1 : 1;
      const rowSpan = m ? shownRows.filter((x) => x >= m.r1 && x <= m.r2).length || 1 : 1;
      const { filled, ...rest } = cell;
      cells.push({ c: colAt.get(c), ...rest, colSpan, rowSpan });
    }
    const h = rowInfo.get(r)?.height;
    return h ? { height: h, cells } : { cells };
  });
  // The heading row a page that runs on repeats: Excel's print titles, else the row of column names just above the first number
  let repeat = titles ? shownRows.map((r, i) => (r >= titles[0] && r <= titles[1] ? i : -1)).filter((i) => i >= 0) : [];
  if (!titles) {
    const numeric = (t) => /^[\s$€£(+-]*[\d,.]+%?\)?\s*$/.test(t);
    const first = rows.findIndex((row) => row.cells.some((c) => c.align === 'right' && /\d/.test(c.text)));
    for (let i = first - 1; i >= Math.max(0, first - 3); i--) {
      const filled = rows[i].cells.filter((c) => c.text);
      if (filled.length >= 2 && filled.every((c) => !numeric(c.text) && c.colSpan < shownCols.length)) { repeat = [i]; break; }
    }
  }
  return { cols: shownCols.map((c) => widthPx(colInfo[c]?.width || defW)), rows, repeat };
}

// ─── Word ───────────────────────────────────────────────────────────

const roman = (n) => [['m', 1000], ['cm', 900], ['d', 500], ['cd', 400], ['c', 100], ['xc', 90], ['l', 50], ['xl', 40], ['x', 10], ['ix', 9], ['v', 5], ['iv', 4], ['i', 1]]
  .reduce((acc, [r, v]) => { while (n >= v) { acc += r; n -= v; } return acc; }, '');
const letter = (n) => { let s = ''; for (; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(97 + ((n - 1) % 26)) + s; return s; };
const BULLETS = ['•', '◦', '▪'];
function numberAs(n, fmt) {
  if (/lowerLetter/.test(fmt)) return letter(n);
  if (/upperLetter/.test(fmt)) return letter(n).toUpperCase();
  if (/lowerRoman/.test(fmt)) return roman(n);
  if (/upperRoman/.test(fmt)) return roman(n).toUpperCase();
  if (fmt === 'decimalZero') return String(n).padStart(2, '0');
  return String(n);
}
/** Word's list numbering: (numId, ilvl) → the marker it prints ("1.", "a)", "ii.", "•"), counting as it goes */
function numberer(xml) {
  const abstract = {};
  for (const a of all(xml, 'w:abstractNum')) {
    const lv = {};
    for (const l of all(a, 'w:lvl')) {
      lv[attr(l, 'w:ilvl')] = { fmt: attr(find(l, 'w:numFmt'), 'w:val') || 'decimal', start: Number(attr(find(l, 'w:start'), 'w:val') || 1), text: attr(find(l, 'w:lvlText'), 'w:val') ?? null };
    }
    abstract[attr(a, 'w:abstractNumId')] = lv;
  }
  const nums = {};
  for (const n of all(xml, 'w:num')) {
    const starts = {};
    for (const o of all(n, 'w:lvlOverride')) { const s = find(o, 'w:startOverride'); if (s) starts[attr(o, 'w:ilvl')] = Number(attr(s, 'w:val')); }
    nums[attr(n, 'w:numId')] = { lv: abstract[attr(find(n, 'w:abstractNumId'), 'w:val')] || {}, starts };
  }
  const counters = {};
  return (numId, ilvl) => {
    const num = nums[numId] || { lv: {}, starts: {} };
    const lvOf = (i) => ({ fmt: 'decimal', start: 1, text: null, ...num.lv[i], ...(num.starts[i] !== undefined ? { start: num.starts[i] } : {}) });
    const lv = lvOf(ilvl);
    const c = (counters[numId] ||= []);
    c[ilvl] = (c[ilvl] ?? lv.start - 1) + 1;
    c.length = ilvl + 1;
    if (lv.fmt === 'none') return '';
    if (lv.fmt === 'bullet') {
      const ch = lv.text ?? '';
      // Symbol and Wingdings bullets live in a private font: the usual dot for the level instead
      return !ch || /[-]/.test(ch) || /^[oq§Øü]$/.test(ch) ? BULLETS[ilvl % 3] : ch;
    }
    const text = lv.text ?? `%${ilvl + 1}.`;
    return text.replace(/%(\d)/g, (m, k) => { const i = Number(k) - 1; return numberAs(c[i] ?? lvOf(i).start, lvOf(i).fmt); });
  };
}
/** Paragraph styles by id → title | h1 | h2 | h3 | '' (by Word's own names, so a localized "Überschrift1" is still a heading) */
function styleKinds(xml) {
  const by = {};
  for (const s of all(xml, 'w:style')) {
    by[attr(s, 'w:styleId')] = { name: attr(find(s, 'w:name'), 'w:val') || '', based: attr(find(s, 'w:basedOn'), 'w:val') || '', outline: attr(find(s, 'w:outlineLvl'), 'w:val') };
  }
  return (id) => {
    for (let at = id, n = 0; at && n < 6; at = by[at]?.based, n++) {
      const name = by[at]?.name || at;
      if (/^title$/i.test(name)) return 'title';
      const h = name.match(/^heading\s*([1-9])$/i);
      if (h) return `h${Math.min(3, Number(h[1]))}`;
      if (by[at]?.outline != null && Number(by[at].outline) < 9) return `h${Math.min(3, Number(by[at].outline) + 1)}`;
    }
    return '';
  };
}
const RUN_HOLDERS = ['w:r', 'w:hyperlink', 'w:ins', 'w:smartTag', 'w:fldSimple', 'w:sdt', 'w:sdtContent', 'w:customXml', 'w:moveTo', 'w:bdo', 'w:dir'];
/** A paragraph's content in order: { text, bold, italic, underline } | { image } | { pageBreak } */
function runsOf(xml, out = []) {
  for (const el of kids(xml, RUN_HOLDERS)) {
    if (el.match(/^<([\w:]+)/)[1] !== 'w:r') { runsOf(inner(el), out); continue; }
    const body = inner(el);
    const rPr = kids(body, ['w:rPr'])[0] || '';
    if (on(find(rPr, 'w:vanish'))) continue;
    const look = { bold: on(find(rPr, 'w:b')), italic: on(find(rPr, 'w:i')), underline: !!find(rPr, 'w:u') && attr(find(rPr, 'w:u'), 'w:val') !== 'none' };
    for (const part of kids(body, ['w:t', 'w:tab', 'w:br', 'w:cr', 'w:noBreakHyphen', 'w:softHyphen', 'w:sym', 'w:drawing', 'w:pict'])) {
      const tag = part.match(/^<([\w:]+)/)[1];
      if (tag === 'w:t') out.push({ text: unxml(inner(part)), ...look });
      else if (tag === 'w:tab') out.push({ text: '\t', ...look });
      else if (tag === 'w:br') out.push(attr(part, 'w:type') === 'page' ? { pageBreak: true } : { text: '\n', ...look });
      else if (tag === 'w:cr') out.push({ text: '\n', ...look });
      else if (tag === 'w:noBreakHyphen') out.push({ text: '‑', ...look });
      else if (tag === 'w:sym') { const code = parseInt(attr(part, 'w:char') || '', 16); if (code && !(code >= 0xf000 && code <= 0xf0ff)) out.push({ text: String.fromCodePoint(code), ...look }); }
      else if (tag === 'w:drawing') {
        const blip = find(part, 'a:blip');
        const ext = find(part, 'wp:extent');
        const id = blip && (attr(blip, 'r:embed') || attr(blip, 'r:link'));
        if (id) out.push({ image: { id, w: Math.round(Number(attr(ext, 'cx') || 0) / 9525), h: Math.round(Number(attr(ext, 'cy') || 0) / 9525) } });
      } else if (tag === 'w:pict') {
        const img = find(part, 'v:imagedata');
        const shape = find(part, 'v:shape') || '';
        const style = attr(shape, 'style') || '';
        const pt = (k) => { const m = style.match(new RegExp(`${k}:\\s*([\\d.]+)(pt|px|in)`)); return m ? Math.round(Number(m[1]) * (m[2] === 'pt' ? 96 / 72 : m[2] === 'in' ? 96 : 1)) : 0; };
        const id = img && attr(img, 'r:id');
        if (id) out.push({ image: { id, w: pt('width'), h: pt('height') } });
      }
    }
  }
  return out;
}
/** Runs side by side with the same look become one */
function joinRuns(list) {
  const out = [];
  for (const r of list) {
    const last = out.at(-1);
    if (last && last.bold === r.bold && last.italic === r.italic && last.underline === r.underline) last.text += r.text;
    else out.push({ ...r });
  }
  return out;
}
function paragraph(el, out, ctx) {
  const body = inner(el);
  const pPr = kids(body, ['w:pPr'])[0] || '';
  const styleId = attr(find(pPr, 'w:pStyle'), 'w:val');
  const outline = attr(find(pPr, 'w:outlineLvl'), 'w:val');
  const style = (styleId && ctx.kind(styleId)) || (outline != null && Number(outline) < 3 ? `h${Number(outline) + 1}` : '');
  const jc = attr(find(pPr, 'w:jc'), 'w:val') || '';
  const align = jc === 'center' ? 'center' : /^(right|end)$/.test(jc) ? 'right' : /^(both|distribute)$/.test(jc) ? 'justify' : 'left';
  const numPr = find(pPr, 'w:numPr');
  const numId = numPr && attr(find(numPr, 'w:numId'), 'w:val');
  const ilvl = Number((numPr && attr(find(numPr, 'w:ilvl'), 'w:val')) || 0);
  const parts = runsOf(body.replace(pPr, ''));
  let list = numId && numId !== '0' ? { marker: ctx.marker(numId, ilvl), level: ilvl } : null;
  let runs = [];
  let first = true;
  const flush = (force = false) => {
    if (!runs.length && !force) return;
    out.push({ type: 'p', style, align, list, runs: joinRuns(runs), pageBreakBefore: first && on(find(pPr, 'w:pageBreakBefore')) });
    // What follows a picture or a page break in the same paragraph is the same item, not a new number
    if (list) list = { marker: '', level: list.level };
    runs = [];
    first = false;
  };
  for (const p of parts) {
    if (p.image) { flush(); out.push({ type: 'image', ...p.image, align }); first = false; }
    else if (p.pageBreak) { flush(); out.push({ type: 'break' }); first = false; }
    else runs.push(p);
  }
  if (runs.length || first) flush(true);
}
function table(el, ctx) {
  const grid = all(find(el, 'w:tblGrid'), 'w:gridCol').map((g) => Math.round(Number(attr(g, 'w:w') || 0) / 15));
  const rows = [];
  let head = 0;
  for (const tr of kids(inner(el), ['w:tr', 'w:sdt', 'w:customXml']).flatMap((x) => (x.startsWith('<w:tr') ? [x] : kids(inner(find(x, 'w:sdtContent') || x), ['w:tr'])))) {
    const cells = [];
    // Rows Word repeats at the top of each page the table runs onto (Repeat as header row)
    if (rows.length === head && on(find(kids(inner(tr), ['w:trPr'])[0] || '', 'w:tblHeader'))) head += 1;
    for (const tc of kids(inner(tr), ['w:tc', 'w:sdt', 'w:customXml']).flatMap((x) => (x.startsWith('<w:tc') ? [x] : kids(inner(find(x, 'w:sdtContent') || x), ['w:tc'])))) {
      const tcPr = kids(inner(tc), ['w:tcPr'])[0] || '';
      const vm = find(tcPr, 'w:vMerge');
      const colSpan = Number(attr(find(tcPr, 'w:gridSpan'), 'w:val') || 1);
      if (vm && attr(vm, 'w:val') !== 'restart') { cells.push({ colSpan, blocks: [], merged: true }); continue; }
      const blocks = [];
      walk(inner(tc).replace(tcPr, ''), blocks, ctx);
      cells.push({ colSpan, blocks });
    }
    rows.push(cells);
  }
  return { type: 'table', grid, rows, head };
}
function walk(xml, out, ctx) {
  for (const el of kids(xml, ['w:p', 'w:tbl', 'w:sdt', 'w:customXml'])) {
    const tag = el.match(/^<([\w:]+)/)[1];
    if (tag === 'w:tbl') out.push(table(el, ctx));
    else if (tag === 'w:sdt') walk(inner(find(el, 'w:sdtContent')), out, ctx);
    else if (tag === 'w:customXml') walk(inner(el), out, ctx);
    else paragraph(el, out, ctx);
  }
  return out;
}
/**
 * A Word document as blocks, in order: { type: 'p', style: title|h1|h2|h3|'', align, list: { marker, level } | null,
 * runs: [{ text, bold, italic, underline }], pageBreakBefore } | { type: 'table', grid: [px], rows: [[{ colSpan, blocks }]] } |
 * { type: 'image', id (its relationship), w, h (px), align } | { type: 'break' } (a page break)
 */
export async function readWord(bytes) {
  const z = await unzip(bytes, ['word/document.xml', 'word/numbering.xml', 'word/styles.xml']);
  // A drawing's old-style copy for older Word (mc:Fallback) would show every picture twice
  const doc = textOf(z['word/document.xml']).replace(/<mc:Fallback>[\s\S]*?<\/mc:Fallback>/g, '');
  if (!doc) throw new Error('no document in that Word file');
  const body = inner(find(doc, 'w:body'));
  return walk(body, [], { marker: numberer(textOf(z['word/numbering.xml'])), kind: styleKinds(textOf(z['word/styles.xml'])) });
}
/** A Word document's pictures by relationship: { rId: { bytes, type } } */
export const wordImages = (bytes) => media(bytes, 'word/_rels/document.xml.rels', 'word');

// ─── PowerPoint ─────────────────────────────────────────────────────

const EMU = 9525;
function shapeBox(xml) {
  const x = find(xml, 'a:xfrm') || find(xml, 'p:xfrm');
  const off = x && find(x, 'a:off');
  const ext = x && find(x, 'a:ext');
  if (!off || !ext) return null;
  return { x: Math.round(Number(attr(off, 'x') || 0) / EMU), y: Math.round(Number(attr(off, 'y') || 0) / EMU), w: Math.round(Number(attr(ext, 'cx') || 0) / EMU), h: Math.round(Number(attr(ext, 'cy') || 0) / EMU) };
}
function textBody(xml, { bulleted }) {
  return all(xml, 'a:p').map((p) => {
    const pPr = find(p, 'a:pPr') || '';
    const level = Number(attr(pPr, 'lvl') || 0);
    const algn = attr(pPr, 'algn') || '';
    const runs = [];
    for (const r of kids(inner(p), ['a:r', 'a:fld', 'a:br'])) {
      if (r.startsWith('<a:br')) { runs.push({ text: '\n', bold: false, italic: false }); continue; }
      const rPr = find(r, 'a:rPr') || '';
      const size = Number(attr(rPr, 'sz') || 0) / 100 || undefined;
      runs.push({ text: unxml(inner(find(r, 'a:t'))), bold: attr(rPr, 'b') === '1', italic: attr(rPr, 'i') === '1', ...(size ? { size } : {}) });
    }
    const ch = find(pPr, 'a:buChar');
    const bullet = find(pPr, 'a:buNone') ? '' : ch ? (/[-]/.test(attr(ch, 'char') || '') ? '•' : attr(ch, 'char') || '•') : find(pPr, 'a:buAutoNum') ? '#' : bulleted ? '•' : '';
    return { level, bullet, runs, align: algn === 'ctr' ? 'center' : algn === 'r' ? 'right' : algn === 'l' ? 'left' : '' };
  });
}
function slideShapes(tree, out) {
  for (const el of kids(tree, ['p:sp', 'p:pic', 'p:graphicFrame', 'p:grpSp'])) {
    const tag = el.match(/^<([\w:]+)/)[1];
    if (tag === 'p:grpSp') {
      // A group's shapes are placed in its own frame, scaled to where the group sits
      const gx = find(find(el, 'p:grpSpPr'), 'a:xfrm');
      const box = gx && shapeBox(gx);
      const ch = gx && { x: Number(attr(find(gx, 'a:chOff'), 'x') || 0) / EMU, y: Number(attr(find(gx, 'a:chOff'), 'y') || 0) / EMU, w: Number(attr(find(gx, 'a:chExt'), 'cx') || 0) / EMU, h: Number(attr(find(gx, 'a:chExt'), 'cy') || 0) / EMU };
      const place = box && ch?.w && ch?.h ? (b) => ({ x: Math.round(box.x + (b.x - ch.x) * (box.w / ch.w)), y: Math.round(box.y + (b.y - ch.y) * (box.h / ch.h)), w: Math.round(b.w * (box.w / ch.w)), h: Math.round(b.h * (box.h / ch.h)) }) : (b) => b;
      const inside = [];
      slideShapes(inner(el), inside);
      for (const s of inside) out.push(s.x === undefined ? s : { ...s, ...place(s) });
      continue;
    }
    const ph = find(el, 'p:ph');
    const phType = ph ? attr(ph, 'type') || 'body' : '';
    const title = /^(title|ctrTitle)$/.test(phType);
    const box = shapeBox(tag === 'p:graphicFrame' ? el : find(el, 'p:spPr') || el) || null;
    if (tag === 'p:pic') {
      const id = attr(find(el, 'a:blip'), 'r:embed');
      if (id && box) out.push({ ...box, kind: 'picture', rId: id });
      continue;
    }
    let paragraphs = [];
    if (tag === 'p:graphicFrame') {
      // A table, its rows as lines of text
      paragraphs = all(el, 'a:tr').map((tr) => ({ level: 0, bullet: '', runs: [{ text: all(tr, 'a:tc').map((tc) => all(tc, 'a:t').map((t) => unxml(inner(t))).join(' ')).filter(Boolean).join('   '), bold: false, italic: false }] }));
    } else {
      const tx = find(el, 'p:txBody');
      if (!tx) continue;
      paragraphs = textBody(tx, { bulleted: !!ph && !title && /^(body|obj)$/.test(phType) });
    }
    if (!paragraphs.some((p) => p.runs.some((r) => r.text.trim()))) continue;
    const anchor = attr(find(el, 'a:bodyPr'), 'anchor') || (title ? 'ctr' : 't');
    out.push({ ...(box || {}), kind: 'text', paragraphs, title, anchor, ph: phType });
  }
  return out;
}
/**
 * A PowerPoint deck: { w, h (px), slides: [{ shapes: [{ x, y, w, h, kind: text | picture, paragraphs?: [{ level, bullet, runs:
 * [{ text, bold, italic, size (pt) }] }], rId?, title }], images: { rId: path in the file } }] }, in the deck's order. A shape
 * that takes its place from the slide's layout has none here; it's drawn in the title band or under it.
 */
export async function readSlides(bytes) {
  const z = await unzip(bytes, ['ppt/presentation.xml', 'ppt/_rels/presentation.xml.rels']);
  const pres = textOf(z['ppt/presentation.xml']);
  const pr = rels(textOf(z['ppt/_rels/presentation.xml.rels']));
  const sz = find(pres, 'p:sldSz');
  const w = Math.round(Number(attr(sz, 'cx') || 9144000) / EMU);
  const h = Math.round(Number(attr(sz, 'cy') || 6858000) / EMU);
  const paths = all(find(pres, 'p:sldIdLst'), 'p:sldId').map((s) => pr[attr(s, 'r:id')]).filter(Boolean).map((r) => resolve('ppt', r.target));
  const files = paths.length ? await unzip(bytes, paths.flatMap((p) => [p, p.replace(/([^/]+)$/, '_rels/$1.rels')])) : {};
  const slides = paths.filter((p) => files[p]).map((p) => {
    const xml = textOf(files[p]);
    const sr = rels(textOf(files[p.replace(/([^/]+)$/, '_rels/$1.rels')]));
    const base = p.replace(/\/[^/]+$/, '');
    const images = Object.fromEntries(Object.entries(sr).filter(([, x]) => !x.external && /\/image$/.test(x.type) && mimeOf(x.target)).map(([id, x]) => [id, resolve(base, x.target)]));
    const shapes = slideShapes(inner(find(xml, 'p:spTree')), []).filter((s) => s.kind !== 'picture' || images[s.rId]);
    return { shapes, images };
  });
  return { w, h, slides };
}
/** A slide's pictures (a slide from readSlides, or its number): { rId: { bytes, type } } */
export async function slideImages(bytes, slide) {
  const s = typeof slide === 'number' ? (await readSlides(bytes)).slides[slide] : slide;
  const want = Object.entries(s?.images || {});
  const files = want.length ? await unzip(bytes, want.map(([, p]) => p)) : {};
  return Object.fromEntries(want.filter(([, p]) => files[p]).map(([id, p]) => [id, { bytes: files[p], type: mimeOf(p) }]));
}

// ─── Drawing: the look ──────────────────────────────────────────────

const INK = '#1A1B1F';
const RULE = '#D6D4CC';
// The site's own font (the board page and the admin both serve it), so a page breaks in the same place on every device
const FONT = "'BDoc Sans', 'Outfit', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
// Every rule is scoped twice over (.bdoc-x.bdoc-x), and the elements inside a page are reset first, so neither page's own
// table, paragraph or box-sizing rules (the admin's and the board page's differ) can move a page break
const S = '.bdoc-x.bdoc-x';
const CSS = `
@font-face { font-family: 'BDoc Sans'; src: url('/fonts/outfit-latin-variable.woff2') format('woff2'); font-weight: 100 900; font-display: block; }
.bdoc-frame.bdoc-x { position: relative; overflow: hidden; background: #fff; flex: none; box-sizing: content-box; margin: 0; padding: 0; border: 0; }
.bdoc-measure.bdoc-x { position: fixed; left: -10000px; top: 0; visibility: hidden; pointer-events: none; contain: layout style; }
${S} :is(div, p, span, a, table, colgroup, col, tbody, tr, td, img, canvas) { box-sizing: content-box; margin: 0; padding: 0; border: 0; background: none; font: inherit; color: inherit; letter-spacing: inherit; word-spacing: normal; text-transform: none; text-decoration: none; text-align: inherit; white-space: inherit; vertical-align: baseline; max-width: none; min-width: 0; float: none; box-shadow: none; transform: none; }
${S} > .bdoc-page { position: absolute; left: 0; top: 0; transform-origin: 0 0; }
${S} > canvas, ${S} > img { display: block; width: 100%; height: 100%; }
${S} .bdoc-page { box-sizing: border-box; background: #fff; color: ${INK}; overflow: hidden; font-family: ${FONT}; font-size: 14.5px; font-weight: 400; font-style: normal; line-height: 1.42; letter-spacing: normal; text-transform: none; text-align: left; white-space: normal; }
${S} .bdoc-flow { font-family: ${FONT}; font-size: 14.5px; font-weight: 400; font-style: normal; line-height: 1.42; color: ${INK}; letter-spacing: normal; text-align: left; white-space: normal; font-kerning: normal; font-variant-ligatures: common-ligatures; -webkit-font-smoothing: antialiased; text-rendering: geometricPrecision; overflow-wrap: break-word; }
${S} .bdoc-page--word { padding: 72px; }
${S} .bdoc-p { display: block; padding: 0 0 7px; white-space: pre-wrap; tab-size: 6; position: relative; }
${S} .bdoc-p.is-cont { padding-top: 0; }
${S} .bdoc-title { font-size: 26px; line-height: 1.2; font-weight: 700; letter-spacing: -0.01em; padding: 0 0 12px; }
${S} .bdoc-h1 { font-size: 19px; line-height: 1.3; font-weight: 700; padding: 10px 0 6px; }
${S} .bdoc-h2 { font-size: 16.5px; line-height: 1.32; font-weight: 700; padding: 8px 0 5px; }
${S} .bdoc-h3 { font-size: 15px; line-height: 1.35; font-weight: 700; padding: 6px 0 4px; }
${S} .bdoc-mark { position: absolute; left: 0; top: 0; width: 26px; text-align: left; white-space: nowrap; }
${S} .bdoc-b { font-weight: 700; } ${S} .bdoc-i { font-style: italic; } ${S} .bdoc-u { text-decoration: underline; text-underline-offset: 2px; }
${S} .bdoc-img { display: block; padding: 2px 0 9px; } ${S} .bdoc-img img { display: block; }
${S} .bdoc-tablewrap { display: block; padding: 2px 0 10px; }
${S} .bdoc-table { display: table; border-collapse: collapse; table-layout: fixed; font-size: 13.5px; line-height: 1.35; }
${S} .bdoc-table td { border: 1px solid ${RULE}; padding: 5px 7px; vertical-align: top; overflow: hidden; }
${S} .bdoc-table .bdoc-p { padding-bottom: 3px; }
${S} .bdoc-table .bdoc-p:last-child { padding-bottom: 0; }
${S} .bdoc-page--sheet { padding: 48px; }
${S} .bdoc-scale { display: block; transform-origin: 0 0; }
${S} .bdoc-caption { display: block; margin: 0 0 10px; font-size: 11px; line-height: 1.4; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: #5A5B61; }
${S} .bdoc-sheet { display: table; border-collapse: collapse; table-layout: fixed; font-size: 12.5px; line-height: 1.3; font-variant-numeric: tabular-nums lining-nums; }
${S} .bdoc-sheet td { padding: 2px 6px; height: 19px; white-space: nowrap; vertical-align: bottom; overflow: visible; }
${S} .bdoc-sheet td.is-clip, ${S} .bdoc-sheet td.is-right { overflow: hidden; text-overflow: clip; }
${S} .bdoc-sheet td.is-wrap { white-space: pre-wrap; overflow: hidden; }
${S} .bdoc-page--slide { position: relative; }
${S} .bdoc-shape { position: absolute; display: flex; flex-direction: column; overflow: hidden; box-sizing: border-box; padding: 0.4em 0.6em; }
${S} .bdoc-shape.is-ctr { justify-content: center; } ${S} .bdoc-shape.is-b { justify-content: flex-end; }
${S} .bdoc-shape .bdoc-p { padding: 0 0 0.3em; line-height: 1.18; }
${S} .bdoc-pic { position: absolute; display: block; object-fit: fill; }
${S} .bdoc-page--card { display: grid; place-content: center; text-align: center; padding: 96px; }
${S} .bdoc-card__icon { display: block; width: 64px; height: 80px; margin: 0 auto 22px; border: 2px solid ${INK}; border-radius: 6px; position: relative; }
${S} .bdoc-card__icon::after { content: ''; position: absolute; left: 14px; right: 14px; top: 22px; height: 2px; background: ${INK}; box-shadow: 0 10px 0 ${INK}, 0 20px 0 ${INK}, 0 30px 0 ${RULE}; }
${S} .bdoc-card__title { display: block; margin: 0; font-size: 26px; line-height: 1.25; font-weight: 700; letter-spacing: -0.01em; overflow-wrap: anywhere; }
${S} .bdoc-card__fmt { display: block; margin: 8px 0 0; font-size: 15px; color: #5A5B61; }
${S} .bdoc-card__say { display: block; margin: 22px 0 0; font-size: 17px; }
${S} .bdoc-card__dl { display: inline-block; margin: 26px auto 0; padding: 12px 22px; border-radius: 10px; background: ${INK}; color: #fff; font-size: 15px; font-weight: 600; text-decoration: none; }
`;
function injectStyles() {
  if (typeof document === 'undefined' || document.getElementById('bdoc-styles')) return;
  const el = document.createElement('style');
  el.id = 'bdoc-styles';
  el.textContent = CSS;
  document.head.appendChild(el);
}
let fontsOnce = null;
/** The page font, loaded before anything is measured (so the first page breaks where every later one does) */
const fontsReady = () => (fontsOnce ||= (async () => {
  injectStyles();
  try { await Promise.all(['400 15px "BDoc Sans"', '700 15px "BDoc Sans"', 'italic 400 15px "BDoc Sans"'].map((f) => document.fonts.load(f))); } catch { /* the fallback font, then */ }
})());
function el(tag, cls = '', text = null) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}
/** A page box (its own w × h) shown `width` wide */
function frame(page, box, width) {
  const w = Math.round(width);
  const f = el('div', 'bdoc-frame bdoc-x');
  f.style.width = `${w}px`;
  f.style.height = `${Math.round((box.h * width) / box.w)}px`;
  page.style.width = `${box.w}px`;
  page.style.height = `${box.h}px`;
  page.style.transform = `scale(${width / box.w})`;
  f.append(page);
  return f;
}
/** An offscreen box the page's content width, to measure in (the same scope and flow a page has); `.done()` takes it away */
function measurer(width) {
  const host = el('div', 'bdoc-measure bdoc-x');
  const flow = el('div', 'bdoc-flow');
  flow.style.width = `${width}px`;
  host.append(flow);
  document.body.append(host);
  flow.done = () => host.remove();
  return flow;
}
const heightOf = (node) => node.getBoundingClientRect().height;

// ─── Drawing: Word ──────────────────────────────────────────────────

function runsNode(p, runs) {
  for (const r of runs) {
    if (!r.text) continue;
    const cls = [r.bold && 'bdoc-b', r.italic && 'bdoc-i', r.underline && 'bdoc-u'].filter(Boolean).join(' ');
    p.append(cls ? el('span', cls, r.text) : document.createTextNode(r.text));
  }
}
const charsOf = (runs) => runs.reduce((n, r) => n + r.text.length, 0);
function sliceRuns(runs, from, to = Infinity) {
  const out = [];
  let at = 0;
  for (const r of runs) {
    const a = Math.max(from, at);
    const b = Math.min(to, at + r.text.length);
    if (b > a) out.push({ ...r, text: r.text.slice(a - at, b - at) });
    at += r.text.length;
  }
  return out;
}
function paraNode(b) {
  const p = el('p', `bdoc-p${b.style ? ` bdoc-${b.style}` : ''}${b.cont ? ' is-cont' : ''}`);
  if (b.align && b.align !== 'left') p.style.textAlign = b.align;
  if (b.list) {
    const pad = 26 + b.list.level * 24;
    p.style.paddingLeft = `${pad}px`;
    if (b.list.marker) { const m = el('span', 'bdoc-mark', b.list.marker); m.style.left = `${pad - 26}px`; p.append(m); }
  }
  runsNode(p, b.runs);
  // An empty paragraph still takes its line, the way Word leaves one
  if (!charsOf(b.runs)) p.append(document.createTextNode('​'));
  return p;
}
function wordTable(b, urls, width) {
  const wrap = el('div', 'bdoc-tablewrap');
  const t = el('table', 'bdoc-table');
  const cols = b.grid.length ? b.grid : new Array(Math.max(1, ...b.rows.map((r) => r.reduce((n, c) => n + c.colSpan, 0)))).fill(100);
  const total = cols.reduce((a, c) => a + (c || 1), 0) || 1;
  const k = Math.min(1, width / total);
  const cg = el('colgroup');
  for (const c of cols) { const col = el('col'); col.style.width = `${Math.floor((c || 1) * k)}px`; cg.append(col); }
  t.style.width = `${Math.floor(cols.reduce((a, c) => a + Math.floor((c || 1) * k), 0))}px`;
  t.append(cg);
  const tb = el('tbody');
  for (const row of b.rows) {
    const tr = el('tr');
    for (const c of row) {
      const td = el('td');
      if (c.colSpan > 1) td.colSpan = c.colSpan;
      if (c.merged) td.style.borderTopColor = 'transparent';
      for (const x of c.blocks) td.append(blockNode(x, urls, width));
      tr.append(td);
    }
    tb.append(tr);
  }
  t.append(tb);
  wrap.append(t);
  return wrap;
}
function blockNode(b, urls, width) {
  if (b.type === 'p') return paraNode(b);
  if (b.type === 'table') return wordTable(b, urls, width);
  if (b.type === 'image') {
    const box = el('div', 'bdoc-img');
    if (b.align === 'center') box.style.textAlign = 'center';
    if (!urls[b.id]) return box;
    const img = el('img');
    const k = b.w ? Math.min(1, width / b.w, (PAGE.h - 160) / (b.h || 1)) : 1;
    img.src = urls[b.id];
    img.alt = '';
    if (b.w && b.h) { img.width = Math.round(b.w * k); img.height = Math.round(b.h * k); }
    if (b.align === 'center') img.style.margin = '0 auto';
    box.append(img);
    return box;
  }
  return el('div');
}
/** The longest start of a paragraph that fits in `room` px (at a word's end), as [that, the rest]; null when not a line fits */
function splitPara(b, room, host) {
  const len = charsOf(b.runs);
  const fits = (n) => { const node = paraNode({ ...b, runs: sliceRuns(b.runs, 0, n) }); host.append(node); const h = heightOf(node); node.remove(); return h <= room + 0.5; };
  let lo = 0;
  let hi = len;
  while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (fits(mid)) lo = mid; else hi = mid - 1; }
  if (lo <= 0) return null;
  const whole = b.runs.map((r) => r.text).join('');
  const space = whole.lastIndexOf(' ', lo);
  const at = space > lo * 0.5 && lo < len ? space + 1 : lo;
  return [{ ...b, runs: sliceRuns(b.runs, 0, at) }, { ...b, style: b.style, runs: sliceRuns(b.runs, at), list: b.list ? { marker: '', level: b.list.level } : null, cont: true, pageBreakBefore: false }];
}
/** Word blocks flowed onto letter pages: [[node]] */
function flowWord(blocks, urls) {
  const CW = PAGE.w - 144;
  const CH = PAGE.h - 144;
  const host = measurer(CW);
  const pages = [];
  let cur = [];
  let used = 0;
  const turn = () => { pages.push(cur); cur = []; used = 0; };
  const place = (node, h) => { cur.push(node); used += h; };
  const queue = [...blocks];
  try {
    while (queue.length) {
      const b = queue.shift();
      if (b.type === 'break') { if (cur.length) turn(); continue; }
      if (b.pageBreakBefore && cur.length) turn();
      const node = blockNode(b, urls, CW);
      host.append(node);
      const h = heightOf(node);
      node.remove();
      const room = CH - used;
      // A heading at the foot of a page goes over with what it heads
      if (h <= room + 0.5 && b.type === 'p' && /^(title|h\d)$/.test(b.style) && queue[0] && queue[0].type !== 'break') {
        const next = blockNode(queue[0], urls, CW);
        host.append(next);
        const nh = Math.min(heightOf(next), 44);
        next.remove();
        if (h + nh > room + 0.5 && cur.length) { turn(); place(node, h); continue; }
      }
      if (h <= room + 0.5) { place(node, h); continue; }
      if (b.type === 'table') {
        // Row by row, as many as fit, the rest on the next page
        const rows = b.rows;
        const head = Math.min(b.head || 0, rows.length - 1);
        let start = 0;
        while (start < rows.length) {
          const left = CH - used;
          // A part after the first starts with the table's header rows again
          const lead = start > 0 && start >= head ? rows.slice(0, head) : [];
          let n = rows.length - start;
          let part = null;
          let ph = 0;
          for (; n > 0; n--) {
            part = blockNode({ ...b, rows: [...lead, ...rows.slice(start, start + n)] }, urls, CW);
            host.append(part);
            ph = heightOf(part);
            part.remove();
            if (ph <= left + 0.5) break;
            // Too tall: try about as many rows as fit by height, then step down
            const per = ph / n;
            n = Math.min(n, Math.max(1, Math.floor(left / per) + 1));
          }
          if (n === 0) {
            if (cur.length) { turn(); continue; }
            n = 1;
            part = blockNode({ ...b, rows: [...lead, ...rows.slice(start, start + 1)] }, urls, CW);
            host.append(part); ph = heightOf(part); part.remove();
          }
          place(part, ph);
          start += n;
          if (start < rows.length) turn();
        }
        continue;
      }
      // A long paragraph runs on to the next page (with two lines at least on this one), a short one moves over whole
      if (b.type === 'p' && charsOf(b.runs) > 40 && (room >= 40 || !cur.length)) {
        const parts = splitPara(b, room, host);
        if (parts) { const first = paraNode(parts[0]); host.append(first); const fh = heightOf(first); first.remove(); place(first, fh); turn(); queue.unshift(parts[1]); continue; }
      }
      if (b.type === 'p' && h > CH && cur.length) { turn(); queue.unshift(b); continue; }
      if (cur.length) turn();
      place(node, h);
    }
  } finally {
    host.done();
  }
  if (cur.length || !pages.length) pages.push(cur);
  return pages.map((nodes) => {
    const page = el('div', 'bdoc-page bdoc-page--word');
    const flow = el('div', 'bdoc-flow');
    flow.append(...nodes);
    page.append(flow);
    return { box: PAGE, node: page };
  });
}

// ─── Drawing: Excel ─────────────────────────────────────────────────

const BORDER = { thin: `1px solid ${INK}`, thick: `2px solid ${INK}`, double: `3px double ${INK}` };
/** Some of a sheet's rows (their indexes, in order) as a table, its columns at the sheet's own widths */
function sheetTable(s, list) {
  const t = el('table', 'bdoc-sheet');
  const cg = el('colgroup');
  for (const w of s.cols) { const col = el('col'); col.style.width = `${w}px`; cg.append(col); }
  t.style.width = `${s.cols.reduce((a, b) => a + b, 0)}px`;
  t.append(cg);
  const tb = el('tbody');
  const taken = new Set();
  for (let at = 0; at < list.length; at++) {
    const row = s.rows[list[at]];
    const tr = el('tr');
    if (row.height) tr.style.height = `${row.height}px`;
    const byCol = new Map(row.cells.map((c) => [c.c, c]));
    for (let c = 0; c < s.cols.length;) {
      if (taken.has(`${at}:${c}`)) { c += 1; continue; }
      const cell = byCol.get(c);
      const td = el('td');
      if (cell) {
        const span = Math.min(cell.colSpan || 1, s.cols.length - c);
        const down = Math.min(cell.rowSpan || 1, list.length - at);
        if (span > 1) td.colSpan = span;
        if (down > 1) td.rowSpan = down;
        for (let i = 0; i < down; i++) for (let j = 0; j < span; j++) if (i || j) taken.add(`${at + i}:${c + j}`);
        td.textContent = cell.text;
        const pad = 6 + (cell.indent || 0) * 12;
        if (cell.align !== 'left') td.style.textAlign = cell.align;
        if (cell.align === 'right') { td.style.paddingRight = `${pad}px`; td.classList.add('is-right'); } else if (cell.indent) td.style.paddingLeft = `${pad}px`;
        if (cell.bold) td.style.fontWeight = '700';
        if (cell.italic) td.style.fontStyle = 'italic';
        if (cell.borderTop) td.style.borderTop = BORDER[cell.borderTop];
        if (cell.borderBottom) td.style.borderBottom = BORDER[cell.borderBottom];
        if (cell.wrap) td.classList.add('is-wrap');
        // Words run on into empty cells beside them, the way Excel shows them; never over a filled one
        else if (cell.align === 'left' && byCol.get(c + span)?.text) td.classList.add('is-clip');
        c += span;
      } else c += 1;
      tr.append(td);
    }
    tb.append(tr);
  }
  t.append(tb);
  return t;
}
/** Sheets onto pages: portrait when the sheet fits across, else landscape, else landscape scaled down (to 60%) */
function flowSheets(sheets) {
  const pages = [];
  for (const s of sheets) {
    const natural = s.cols.reduce((a, b) => a + b, 0);
    const box = natural <= PAGE.w - 96 ? PAGE : LAND;
    const cw = box.w - 96;
    const ch = box.h - 96;
    // Too wide: scaled down to fit (to 60%); narrow (a statement's two columns): up to fill the width (to 140%)
    const k = natural > cw ? Math.max(0.6, cw / natural) : Math.min(1.4, cw / natural);
    // The sheet's name says something only beside others ("Sheet1" never does)
    const caption = sheets.length > 1 && !/^sheet\s*\d*$/i.test(s.name.trim()) ? s.name : '';
    const host = measurer(natural);
    let capH = 0;
    let hs = [];
    try {
      if (caption) { const cap = el('p', 'bdoc-caption', caption); host.append(cap); capH = heightOf(cap) + 10; cap.remove(); }
      const t = sheetTable(s, s.rows.map((_, i) => i));
      host.append(t);
      hs = [...t.rows].map((tr) => tr.getBoundingClientRect().height);
    } finally {
      host.done();
    }
    // Where each row's merged cells reach: a page never breaks inside one
    const reach = s.rows.map((row, r) => r + Math.max(1, ...row.cells.map((c) => c.rowSpan || 1)) - 1);
    let start = 0;
    let first = true;
    const head = (s.repeat || []).filter((i) => i < s.rows.length);
    while (start < s.rows.length) {
      const room = (ch - (first && caption ? capH * k : 0)) / k;
      // A page that runs on starts with the heading row again
      const lead = !first && head.length && start > Math.max(...head) ? head : [];
      let used = lead.reduce((a, i) => a + (hs[i] || 19), 0);
      let end = start;
      let far = start - 1;
      while (end < s.rows.length) {
        const h = hs[end] || 19;
        if (end > start && used + h > room + 0.5 && far < end) break;
        used += h;
        far = Math.max(far, reach[end]);
        end += 1;
      }
      const page = el('div', 'bdoc-page bdoc-page--sheet');
      const scale = el('div', 'bdoc-scale bdoc-flow');
      scale.style.width = `${natural}px`;
      if (k !== 1) scale.style.transform = `scale(${k})`;
      if (first && caption) scale.append(el('p', 'bdoc-caption', caption));
      scale.append(sheetTable(s, [...lead, ...Array.from({ length: end - start }, (_, i) => start + i)]));
      page.append(scale);
      pages.push({ box, node: page });
      start = end;
      first = false;
    }
  }
  return pages;
}

// ─── Drawing: PowerPoint ────────────────────────────────────────────

const BODY_PT = [24, 20, 18, 16, 16];
function flowSlides(deck, urls) {
  const box = { w: LAND.w, h: Math.round((LAND.w * deck.h) / (deck.w || 1)) };
  const k = box.w / (deck.w || 1);
  return deck.slides.map((s, si) => {
    const page = el('div', 'bdoc-page bdoc-page--slide bdoc-flow');
    let below = 0.22;
    for (const sh of s.shapes) {
      // A shape placed by the slide's layout: the title band, or the space under it
      const centered = sh.ph === 'ctrTitle' || sh.ph === 'subTitle';
      const at = sh.x !== undefined ? sh
        : sh.ph === 'ctrTitle' ? { x: deck.w * 0.08, y: deck.h * 0.3, w: deck.w * 0.84, h: deck.h * 0.22 }
        : sh.ph === 'subTitle' ? { x: deck.w * 0.12, y: deck.h * 0.55, w: deck.w * 0.76, h: deck.h * 0.15 }
        : sh.title ? { x: deck.w * 0.06, y: deck.h * 0.05, w: deck.w * 0.88, h: deck.h * 0.15 } : { x: deck.w * 0.06, y: deck.h * below, w: deck.w * 0.88, h: deck.h * (0.95 - below) };
      if (sh.x === undefined && !sh.title && !centered) below = Math.min(0.9, below + 0.35);
      if (sh.kind === 'picture') {
        if (!urls[si]?.[sh.rId]) continue;
        const img = el('img', 'bdoc-pic');
        img.src = urls[si][sh.rId];
        img.alt = '';
        Object.assign(img.style, { left: `${at.x * k}px`, top: `${at.y * k}px`, width: `${at.w * k}px`, height: `${at.h * k}px` });
        page.append(img);
        continue;
      }
      const d = el('div', `bdoc-shape${sh.anchor === 'ctr' ? ' is-ctr' : sh.anchor === 'b' ? ' is-b' : ''}`);
      Object.assign(d.style, { left: `${at.x * k}px`, top: `${at.y * k}px`, width: `${at.w * k}px`, height: `${at.h * k}px` });
      for (const p of sh.paragraphs) {
        const pt = p.runs.find((r) => r.size)?.size || (sh.title ? 36 : sh.paragraphs.length > 1 || p.bullet ? BODY_PT[Math.min(4, p.level)] : 18);
        const node = paraNode({ type: 'p', style: '', align: p.align || (centered ? 'center' : 'left'), list: p.bullet ? { marker: p.bullet === '#' ? `${sh.paragraphs.filter((x) => x.bullet === '#').indexOf(p) + 1}.` : p.bullet, level: p.level } : null, runs: p.runs.map((r) => ({ ...r, bold: r.bold || sh.title })) });
        node.style.fontSize = `${(pt * 96 / 72) * k}px`;
        if (p.bullet) { node.style.paddingLeft = `${1.1 + p.level * 1.2}em`; const m = node.querySelector('.bdoc-mark'); if (m) { m.style.left = `${p.level * 1.2}em`; m.style.width = '1.1em'; } }
        d.append(node);
      }
      page.append(d);
    }
    return { box, node: page };
  });
}

// ─── A file that can't be shown ─────────────────────────────────────

function cardPage(f, url, say) {
  const page = el('div', 'bdoc-page bdoc-page--card');
  page.append(el('div', 'bdoc-card__icon'), el('p', 'bdoc-card__title', fileTitle(f?.name || 'File')), el('p', 'bdoc-card__fmt', formatName(f)), el('p', 'bdoc-card__say', say));
  if (url) {
    const a = el('a', 'bdoc-card__dl', 'Download');
    a.href = url;
    a.setAttribute('download', f?.name || '');
    a.rel = 'noopener';
    page.append(a);
  }
  return { box: PAGE, node: page };
}

// ─── Opening a file ─────────────────────────────────────────────────

let pdfLib = null;
let pdfWorker = null;
const loadPdfLib = () => (pdfLib ||= import('../vendor-pdf.js').catch((e) => { pdfLib = null; throw e; }));
// Three pages drawn at a time at most (a print of a whole packet asks for many at once)
const drawing = { now: 0, queue: [] };
function inTurn(job) {
  return new Promise((resolve, reject) => {
    drawing.queue.push({ job, resolve, reject });
    const pump = () => {
      while (drawing.now < 3 && drawing.queue.length) {
        const next = drawing.queue.shift();
        drawing.now += 1;
        next.job().then(next.resolve, next.reject).finally(() => { drawing.now -= 1; pump(); });
      }
    };
    pump();
  });
}
async function pdfOpen(url) {
  const { pdfjsLib } = await loadPdfLib();
  pdfWorker ||= new pdfjsLib.PDFWorker();
  const base = new URL('../pdf/', import.meta.url).href;
  return pdfjsLib.getDocument({ url, worker: pdfWorker, standardFontDataUrl: `${base}standard_fonts/`, wasmUrl: `${base}wasm/`, useWasm: false, enableXfa: false, isEvalSupported: false }).promise;
}
async function bytesOf(url) {
  const r = await fetch(url, { credentials: 'same-origin' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return new Uint8Array(await r.arrayBuffer());
}
/** A picture's own size, once it has loaded */
function pictureSize(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
    img.onerror = () => reject(new Error('The picture didn’t load'));
    img.src = url;
  });
}
/** The pages of an Excel, Word or PowerPoint file: { pages: [{ box, node }], urls (to let go of) } */
async function htmlPages(kind, f, url) {
  const bytes = await bytesOf(url);
  await fontsReady();
  const urls = [];
  const blob = (m) => { const u = URL.createObjectURL(new Blob([m.bytes], { type: m.type })); urls.push(u); return u; };
  let pages;
  if (kind === 'sheet') {
    const sheets = (await readSheets(bytes)).filter((s) => !s.hidden && s.rows.some((r) => r.cells.some((c) => c.text)));
    pages = sheets.length ? flowSheets(sheets) : [cardPage(f, url, 'This spreadsheet is empty.')];
  } else if (kind === 'word') {
    const [blocks, pics] = await Promise.all([readWord(bytes), wordImages(bytes)]);
    pages = flowWord(blocks, Object.fromEntries(Object.entries(pics).map(([id, m]) => [id, blob(m)])));
  } else {
    const deck = await readSlides(bytes);
    const pics = await Promise.all(deck.slides.map((s) => slideImages(bytes, s)));
    pages = deck.slides.length ? flowSlides(deck, pics.map((p) => Object.fromEntries(Object.entries(p).map(([id, m]) => [id, blob(m)])))) : [cardPage(f, url, 'This deck has no slides.')];
  }
  return { pages, urls };
}

/** A file as pages: its kind, how many, each one's box, and each one drawn */
async function load(f, url) {
  const kind = docKind(f);
  const broken = (say = 'This file didn’t open.') => {
    const page = cardPage(f, url, say);
    return { kind: 'other', count: 1, size: () => ({ ...page.box }), draw: async (i, { width = PAGE.w } = {}) => frame(page.node.cloneNode(true), page.box, width), close() {} };
  };
  if (typeof document !== 'undefined') injectStyles();
  try {
    if (kind === 'pdf') {
      let pdf = await pdfOpen(url);
      const sizes = await Promise.all(Array.from({ length: pdf.numPages }, async (_, i) => {
        const v = (await pdf.getPage(i + 1)).getViewport({ scale: 96 / 72 });
        return { w: v.width, h: v.height };
      }));
      const doc = {
        kind, count: sizes.length,
        size: (i) => ({ ...sizes[Math.max(0, Math.min(sizes.length - 1, i))] }),
        async draw(i, { width = PAGE.w, dpr = (typeof devicePixelRatio === 'number' ? devicePixelRatio : 1) } = {}) {
          i = Math.max(0, Math.min(sizes.length - 1, i));
          pdf ||= await pdfOpen(url);
          const s = sizes[i];
          const w = Math.round(width);
          const h = Math.round((s.h * width) / s.w);
          const f2 = el('div', 'bdoc-frame bdoc-x');
          f2.style.width = `${w}px`;
          f2.style.height = `${h}px`;
          const canvas = el('canvas');
          canvas.width = Math.max(1, Math.round(w * dpr));
          canvas.height = Math.max(1, Math.round(h * dpr));
          await inTurn(async () => {
            const page = await pdf.getPage(i + 1);
            const one = page.getViewport({ scale: 1 });
            const vp = page.getViewport({ scale: canvas.width / one.width });
            const g = canvas.getContext('2d');
            g.fillStyle = '#fff';
            g.fillRect(0, 0, canvas.width, canvas.height);
            await page.render({ canvasContext: g, viewport: vp }).promise;
            page.cleanup();
          });
          f2.append(canvas);
          return f2;
        },
        close() { const p = pdf; pdf = null; p?.destroy().catch(() => {}); },
      };
      return doc;
    }
    if (kind === 'image') {
      const nat = await pictureSize(url);
      const k = Math.min(PAGE.w / nat.w, PAGE.h / nat.h);
      const box = { w: Math.round(nat.w * k), h: Math.round(nat.h * k) };
      return {
        kind, count: 1, size: () => ({ ...box }),
        async draw(i, { width = box.w } = {}) {
          const f2 = el('div', 'bdoc-frame bdoc-x');
          f2.style.width = `${Math.round(width)}px`;
          f2.style.height = `${Math.round((box.h * width) / box.w)}px`;
          const img = el('img');
          img.src = url;
          img.alt = '';
          img.decoding = 'async';
          f2.append(img);
          return f2;
        },
        close() {},
      };
    }
    if (kind === 'other') return broken('This file can’t be shown here.');
    let made = await htmlPages(kind, f, url);
    const boxes = made.pages.map((p) => p.box);
    return {
      kind, count: boxes.length,
      size: (i) => ({ ...boxes[Math.max(0, Math.min(boxes.length - 1, i))] }),
      async draw(i, { width = PAGE.w } = {}) {
        i = Math.max(0, Math.min(boxes.length - 1, i));
        // Let go of after closing (the cache moved on): laid out again, the same way
        made ||= await htmlPages(kind, f, url);
        const p = made.pages[i] || made.pages.at(-1);
        return frame(p.node.cloneNode(true), p.box, width);
      },
      close() { if (made) for (const u of made.urls) URL.revokeObjectURL(u); made = null; },
    };
  } catch {
    return broken();
  }
}

const cache = new Map();
const KEEP = 8;
/** A file as pages, opened once and kept (the last 8 files). `url` is where its bytes are (the board's file address by default) */
export function openDoc(f, { url = fileUrl(f) } = {}) {
  const key = `${f?.id || ''}|${url}`;
  if (cache.has(key)) {
    const p = cache.get(key);
    cache.delete(key);
    cache.set(key, p);
    return p;
  }
  const p = load(f, url);
  cache.set(key, p);
  while (cache.size > KEEP) {
    const [oldKey, old] = cache.entries().next().value;
    cache.delete(oldKey);
    old.then((d) => d.close()).catch(() => {});
  }
  return p;
}

// ─── Where the words are on a page ──────────────────────────────────
// A letter page fitted to a widescreen TV is mostly white, its numbers small. The screen shows the part of the page
// with something on it instead, as big as it goes: the white margins trimmed, and a lone line far from the rest (a
// report's "Accrual Basis…" footer, a page number) left out. Print still prints the whole page.

/** Blocks of ink down the page ({ y0, y1, x0, x1 } in 0..1) → the part worth showing, or null for the whole page */
export function mainPart(blocks) {
  if (!blocks.length) return null;
  blocks.sort((a, b) => a.y0 - b.y0);
  const merged = [];
  for (const b of blocks) {
    const last = merged.at(-1);
    if (last && b.y0 - last.y1 < 0.05) { last.y1 = Math.max(last.y1, b.y1); last.x0 = Math.min(last.x0, b.x0); last.x1 = Math.max(last.x1, b.x1); } else merged.push({ ...b });
  }
  // A small block set well apart from everything else is a footer or a page number
  const keep = merged.filter((b, i) => {
    if (merged.length < 2 || b.y1 - b.y0 > 0.04) return true;
    const gap = Math.min(i > 0 ? b.y0 - merged[i - 1].y1 : 1, i < merged.length - 1 ? merged[i + 1].y0 - b.y1 : 1);
    return gap < 0.15;
  });
  const u = keep.reduce((a, b) => ({ y0: Math.min(a.y0, b.y0), y1: Math.max(a.y1, b.y1), x0: Math.min(a.x0, b.x0), x1: Math.max(a.x1, b.x1) }));
  const pad = 0.025;
  const part = { x: Math.max(0, u.x0 - pad), y: Math.max(0, u.y0 - pad) };
  part.w = Math.min(1, u.x1 + pad) - part.x;
  part.h = Math.min(1, u.y1 + pad) - part.y;
  return part.w > 0.05 && part.h > 0.03 ? part : null;
}
/** The ink on a drawn page: a PDF's or picture's canvas read pixel by pixel; a laid-out page by where its words and pictures sit */
export function inkOf(frame) {
  const canvas = frame.querySelector('canvas');
  if (canvas?.width) {
    const w = 200;
    const h = Math.max(1, Math.round((canvas.height * w) / canvas.width));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(canvas, 0, 0, w, h);
    const d = g.getImageData(0, 0, w, h).data;
    const rows = [];
    for (let y = 0; y < h; y++) {
      let x0 = -1; let x1 = -1;
      for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; if (d[i] < 230 || d[i + 1] < 230 || d[i + 2] < 230) { if (x0 < 0) x0 = x; x1 = x; } }
      if (x0 >= 0) rows.push({ y0: y / h, y1: (y + 1) / h, x0: x0 / w, x1: (x1 + 1) / w });
    }
    return rows;
  }
  const box = frame.getBoundingClientRect();
  if (!box.width || !box.height) return null;
  const out = [];
  const add = (r) => { if (r.width > 0 && r.height > 0) out.push({ y0: (r.top - box.top) / box.height, y1: (r.bottom - box.top) / box.height, x0: (r.left - box.left) / box.width, x1: (r.right - box.left) / box.width }); };
  const walk = document.createTreeWalker(frame, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let n = walk.nextNode(); n; n = walk.nextNode()) { if (n.textContent.trim()) { range.selectNodeContents(n); for (const r of range.getClientRects()) add(r); } }
  for (const img of frame.querySelectorAll('img')) add(img.getBoundingClientRect());
  return out;
}
// Laid-out pages are measured off screen, so nothing jumps while the screen works out its zoom
let measuring = null;
function measureBox() {
  if (!measuring) { measuring = document.createElement('div'); measuring.setAttribute('aria-hidden', 'true'); measuring.style.cssText = 'position:fixed;left:-20000px;top:0;visibility:hidden;pointer-events:none'; document.body.append(measuring); }
  return measuring;
}

/**
 * A page's content and, for a tall one (a statement, a report: taller than it is wide), where to cut it in two so
 * each half shows twice as big on a wide screen: at the blank line nearest the middle, never through a line.
 * Pure: `blocks` of ink in 0..1 down and across the page, `size` its { w, h } → { part, cut, n } (n: 1 | 2)
 */
export function splitOf(blocks, size) {
  const part = mainPart(blocks.map((b) => ({ ...b })));
  if (!part || (part.w * size.w) / (part.h * size.h) >= 1.1) return { part, cut: 0, n: 1 };
  const rows = blocks.filter((b) => b.y1 > part.y && b.y0 < part.y + part.h).sort((a, b) => a.y0 - b.y0);
  const mid = part.y + part.h / 2;
  let best = null;
  let end = -1;
  for (const b of rows) {
    if (end >= 0 && b.y0 - end > 0.002) { const y = (end + b.y0) / 2; if (best === null || Math.abs(y - mid) < Math.abs(best - mid)) best = y; }
    end = Math.max(end, b.y1);
  }
  return { part, cut: best !== null && Math.abs(best - mid) < part.h * 0.2 ? best : mid, n: 2 };
}
/** The area of a page to show for its half `k` (0 the top, 1 the bottom; all of it when it has one) */
export function halfOf(lay, k = 0) {
  if (!lay?.part || lay.n < 2) return lay?.part || null;
  const { part, cut } = lay;
  return k ? { ...part, y: cut, h: part.y + part.h - cut } : { ...part, h: cut - part.y };
}
const layouts = new Map();
/** Page i's content and halves (splitOf), from the page drawn small: once a file and page, and the same everywhere */
export function layoutOf(f, doc, i) {
  const key = `${f?.id || ''}|${i}`;
  if (!layouts.has(key)) {
    layouts.set(key, (async () => {
      const probe = await doc.draw(i, { width: 320, dpr: 1 });
      const tray = measureBox();
      tray.replaceChildren(probe);
      const blocks = inkOf(probe) || [];
      tray.replaceChildren();
      return splitOf(blocks, doc.size(i));
    })().catch(() => ({ part: null, cut: 0, n: 1 })));
  }
  return layouts.get(key);
}
/** How many halves each page of a file has ([1, 2, 2, …]), worked out a page at a time */
export async function partsOf(f) {
  const doc = await openDoc(f);
  const out = [];
  for (let i = 0; i < doc.count; i++) out.push((await layoutOf(f, doc, i)).n);
  return out;
}
