/**
 * board-words.js — a paper's words out of its PDF, for writing it in Board
 * ===========================================================================
 * A paper every board member signs (the Board Member Expectations) is written
 * in Board → Documents (./board-admin.js) with the report editor
 * (./board-report.js), kept as Markdown. One that came as a PDF starts from
 * the PDF's own words: pdf.js reads each line with where it sits and how big
 * it is (pdfLines), and wordsFromLines makes them Markdown the way the page
 * reads: bigger or all-capital short lines are headings, bullets and numbers
 * are lists, wrapped lines are one paragraph again, and what only paper needs
 * (page numbers, a header or footer on every page, the blanks to sign and
 * date) is left out: the board signs on the board page. The admin reads it
 * over in the editor before it's saved.
 */

// A bullet as fonts write one (Symbol's and Wingdings' private-use ones too)
const BULLET = /^(?:[•●▪◦■□➢➤►▶✓✔·\-–*]|||||o(?=\s))\s*/;
const NUMBERED = /^(\d{1,2})[.)]\s+/;
const LETTERED = /^[a-z][.)]\s+/;
// The blanks paper needs to be signed: "Signature: ________", "Date ____", "Printed name"
const BLANK = /_{4,}|\.{8,}/;
const SIGN_LABEL = /^(board member )?(signature|signed|date|printed name|print name|name|member name)\s*:?\s*$/i;
const PAGE_NO = /^(page\s+)?\d{1,3}(\s+of\s+\d{1,3})?$/i;
// The letterhead: SOARD's name alone (the board page says whose paper it is)
const LETTERHEAD = /^(sunshine on a ranney day|soard)(,?\s*inc\.?)?$/i;
// Kept in capitals when a heading in capitals is put in sentence case
const ACRONYMS = new Set(['SOARD', 'BOD', 'CEO', 'ED', 'IRS', 'GA', 'USA', 'II', 'III', 'IV']);
const sentence = (t) => t.split(' ').map((w, i) => (ACRONYMS.has(w.replace(/[^A-Z]/g, '')) ? w : i ? w.toLowerCase() : w.charAt(0) + w.slice(1).toLowerCase())).join(' ');
const words = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const median = (list) => { const s = [...list].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };

/**
 * Lines of a paper (`{ text, x, y, size, page }`, y growing up the page as PDFs measure it) → Markdown. `title`:
 * the document's own title, so a first heading that only repeats it is left out (the page shows the title)
 */
export function wordsFromLines(lines, { title = '' } = {}) {
  const pages = new Set(lines.map((l) => l.page)).size;
  const clean = lines.map((l) => ({ ...l, text: String(l.text || '').replace(/\s+/g, ' ').trim() })).filter((l) => l.text);
  // A header or footer: the same words on most pages
  const seen = new Map();
  for (const l of clean) { const k = words(l.text); seen.set(k, (seen.get(k) || new Set()).add(l.page)); }
  const repeated = (l) => pages > 1 && (seen.get(words(l.text))?.size || 0) >= Math.max(2, Math.ceil(pages / 2));
  const kept = clean.filter((l) => !PAGE_NO.test(l.text) && !LETTERHEAD.test(l.text) && !repeated(l) && !SIGN_LABEL.test(l.text.replace(BLANK, '').trim()) && !(BLANK.test(l.text) && l.text.replace(/[_.\s]/g, '').length < 40));
  const body = median(kept.map((l) => l.size || 0)) || 0;
  const caps = (t) => t.length <= 70 && /[A-Z]{3}/.test(t) && t === t.toUpperCase();
  const isHeading = (l) => !BULLET.test(l.text) && !NUMBERED.test(l.text) && l.text.length <= 90 && !/[.,;]$/.test(l.text)
    && ((body && l.size >= body * 1.15) || caps(l.text));
  const blocks = [];
  let prev = null;
  for (const l of kept) {
    const gap = prev && prev.page === l.page ? prev.y - l.y : Infinity;
    const close = gap <= Math.max(prev?.size || 0, l.size || 0, body) * 1.75;
    const last = blocks.at(-1);
    if (isHeading(l)) {
      // A heading that wrapped onto a second line stays one heading
      if (last?.t === 'h' && close && prev && Math.abs((prev.size || 0) - (l.size || 0)) < 0.5) last.text += ` ${l.text}`;
      else blocks.push({ t: 'h', text: l.text, size: l.size });
    } else if (BULLET.test(l.text) || LETTERED.test(l.text)) {
      blocks.push({ t: 'li', text: l.text.replace(BULLET, '').replace(LETTERED, ''), x: l.x });
    } else if (NUMBERED.test(l.text)) {
      blocks.push({ t: 'ol', n: Number(l.text.match(NUMBERED)[1]), text: l.text.replace(NUMBERED, ''), x: l.x });
    } else if (last && (last.t === 'p' || last.t === 'li' || last.t === 'ol') && (close || (prev && prev.page !== l.page && !/[.!?:]$/.test(last.text) && /^[a-z]/.test(l.text)))
      && !(last.t === 'p' && /[.!?:]$/.test(last.text) && l.x > (last.x ?? l.x) + 12)) {
      // The paragraph (or the point) carried on: a word broken over the line is one word again
      last.text = /[a-z]-$/.test(last.text) && /^[a-z]/.test(l.text) ? `${last.text.slice(0, -1)}${l.text}` : `${last.text} ${l.text}`;
    } else {
      blocks.push({ t: 'p', text: l.text, x: l.x });
    }
    prev = l;
  }
  // The first line only repeating the document's title (a heading, or a Word file's short first line) is the page's
  // title already
  const t = words(title).split(' ').filter((w) => w.length > 3);
  const titleLike = (b) => b && (b.t === 'h' || (b.t === 'p' && b.text.length <= 90 && !/[.!?]$/.test(b.text)));
  if (titleLike(blocks[0]) && t.length && t.filter((w) => words(blocks[0].text).includes(w)).length >= Math.ceil(t.length * 0.6)) blocks.shift();
  const esc = (s) => s.replace(/^([#>])/, '\\$1');
  let out = '';
  blocks.forEach((b, i) => {
    const next = blocks[i + 1];
    const line = b.t === 'h' ? `### ${b.text === b.text.toUpperCase() ? sentence(b.text) : b.text}` : b.t === 'li' ? `- ${esc(b.text)}` : b.t === 'ol' ? `${b.n}. ${esc(b.text)}` : esc(b.text);
    // A list's points one under another; everything else a blank line apart
    const sameList = next && ((b.t === 'li' && next.t === 'li') || (b.t === 'ol' && next.t === 'ol'));
    out += line + (next ? (sameList ? '\n' : '\n\n') : '');
  });
  return out.trim();
}

/** A PDF's lines as its pages show them: each line's words in order, where it sits and its biggest letters */
export async function pdfLines(bytes) {
  const { pdfjsLib } = await import('./vendor-pdf.js');
  const doc = await pdfjsLib.getDocument({ data: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes) }).promise;
  const out = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const content = await (await doc.getPage(p)).getTextContent();
    const rows = [];
    for (const it of content.items) {
      if (!it.str?.trim()) continue;
      const y = it.transform[5];
      const size = Math.abs(it.transform[3]) || it.height || 0;
      let row = rows.find((r) => Math.abs(r.y - y) <= Math.max(2, size * 0.3));
      if (!row) { row = { y, parts: [], size: 0 }; rows.push(row); }
      row.parts.push({ x: it.transform[4], s: it.str });
      row.size = Math.max(row.size, size);
    }
    rows.sort((a, b) => b.y - a.y);
    for (const r of rows) {
      const parts = r.parts.sort((a, b) => a.x - b.x);
      out.push({ text: parts.map((x) => x.s).join(' ').replace(/\s+/g, ' ').trim(), x: parts[0].x, y: r.y, size: Math.round(r.size * 10) / 10, page: p });
    }
  }
  return out;
}

/** A Word file's paragraphs as lines (no sizes to go on: each paragraph its own) */
export function docxLines(text) {
  return String(text || '').split(/\n+/).map((t, i) => ({ text: t, x: 0, y: -i * 100, size: 0, page: 1 }));
}
