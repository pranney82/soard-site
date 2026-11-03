/**
 * board-words.js — a paper's words out of its PDF or Word file, for writing it in Board
 * ===========================================================================
 * A paper every board member signs (the Board Member Expectations) is written
 * in Board → Documents (./board-admin.js) with the report editor
 * (./board-report.js), kept as Markdown. One that came as a PDF or a Word file
 * starts from the file's own words, read the way a person reads the page:
 *   - pdf.js gives each run of text with where it sits, how big and whether
 *     it's bold (pdfLines); runs on one line are joined by the space between
 *     them (a bold word inside a sentence stays inside it), and a page set in
 *     two columns is read one column, then the other (linesOfItems)
 *   - bigger, bold or all-capital short lines, and a short line standing on
 *     its own, are headings (one in capitals in title case: "Gala and Golf
 *     Classic"); a label with its answer ("Term: 3 years") or a date line
 *     ("Effective January 1, 2026") isn't; bullets and numbers are lists,
 *     nested by how far in they sit; a. / b. / i. / ii. are points that keep
 *     their letters (the board page shows the letter, not a bullet:
 *     ./board-report.js); a bold word inside a sentence stays bold
 *   - a line carries its paragraph on when it's close under it (a word broken
 *     over the line is one word again), over a page break too while the
 *     sentence isn't finished; a point's next line sits in line with its words
 *   - a table (cells set apart in columns, row under row) is its rows, each a
 *     point with its cells side by side, its header row in bold
 *   - what only paper needs is left out: page numbers (3, Page 3 of 9, - 3 -,
 *     3 | P a g e), a header or footer at
 *     the top or bottom of every page, the letterhead (SOARD's name, address,
 *     phone, website) at the top or bottom of a page or atop the first, never
 *     SOARD's name inside a title, the blanks to sign and date (the board signs on the
 *     board page), and a first heading that only repeats the paper's title
 * The admin reads it over in the editor before it's saved.
 */

// A bullet as fonts write one (Symbol's and Wingdings' private-use ones too)
const BULLET = /^(?:[•●▪◦■□➢➤►▶✓✔·\-–*]|\uF0B7|\uF0A7|\uF0D8|\uF076|o(?=\s))\s*/;
const NUMBERED = /^\(?(\d{1,2})[.)]\s+/;
// a. / (b) / i. / IV) — Markdown numbers lists only with numbers, so these stay as written, a line each
const LABELED = /^\(?(?:[a-zA-Z]|[ivxIVX]{2,4})[.)]\s+/;
const MARKER = new RegExp(`${BULLET.source}|${NUMBERED.source}|${LABELED.source}`);
// The blanks paper needs to be signed: "Signature: ________", "Date ____", "Printed name"
const BLANK = /_{4,}|\.{8,}/;
const SIGN_LABEL = /^(board member )?(signature|signed|date|printed name|print name|name|member name|board member name( \(print\))?)\s*:?\s*$/i;
// The labels under a signature block's lines ("Board Member Signature   Date", "Name (please print)", "Board Chair   Date")
const SIGN_WORDS = /^(?:(?:board|member|chair|chairman|chairperson|president|secretary|treasurer|director|officer|witness|signature|signed|date|name|printed|print|please|title|of|and|\(|\)|:|\/|,)\s*)+$/i;
const signLabels = (t) => SIGN_WORDS.test(t.replace(/[()]/g, ' ( ').replace(/\s+/g, ' ').trim()) && /\b(signature|date|print)/i.test(t);
// A page number however a footer writes it: "3", "Page 3 of 9", "- 3 -", "3 | P a g e", "Page | 3", "3/9"
const PAGE_NO = /^[\s\-–—|]*(?:p\s?a\s?g\s?e\s*[|:]?\s*)?\d{1,3}(?:\s*(?:of|\/)\s*\d{1,3})?[\s\-–—|]*(?:p\s?a\s?g\s?e)?[\s\-–—|]*$/i;
const PAGE_REF = /\bp\s?a\s?g\s?e\s*[|:]?\s*\d{1,3}(\s+of\s+\d{1,3})?\b|\b\d{1,3}\s*\|\s*p\s?a\s?g\s?e\b/i;
// A name and the office it signs for ("Kim Park, Secretary"): a signature line, words, never a heading
const NAME_TITLE = /^[A-Z][\w.'’-]+(?:\s+[A-Z][\w.'’-]+){0,3},\s*(?:board\s+)?(?:secretary|chair|chairman|chairwoman|chairperson|president|vice[\s-]?president|treasurer|director|member|founder|ceo|cfo|coo|executive director)\b/i;
// The letterhead: SOARD's name alone (the board page says whose paper it is), or a line of where to reach it
const LETTERHEAD = /^(sunshine on a ranney day|soard)(,?\s*inc\.?)?$/i;
const CONTACT = /\b\d{2,6}\s+(?:[NSEW]\.?\s+)?[A-Za-z0-9][\w'.-]*(?:\s+[\w'.-]+){0,4}\s+(?:street|st|road|rd|avenue|ave|boulevard|blvd|drive|dr|lane|ln|way|parkway|pkwy|court|ct|circle|cir|highway|hwy|place|pl|trail|trl|suite|ste)\b|\(\d{3}\)\s*\d{3}[-.\s]\d{4}|\b\d{3}[-.]\d{3}[-.]\d{4}\b|\bwww\.|https?:\/\/|[\w.+-]+@[\w-]+\.[a-z]{2,}|\b[\w-]+\.(?:org|com|net)\b|\bp\.?\s?o\.?\s+box\b/i;
const STATE_ZIP = /\b[A-Z]{2},?\s+\d{5}(?:-\d{4})?\b/;
const DATED = /^(effective|adopted|approved|revised|updated|amended|ratified|as of)\b.*\b(19|20)\d{2}\b/i;
// Kept in capitals when a heading in capitals is put in title case
// (never one that's also a word: IT, US, ED, PR, AL read as words in a heading, "CARRYING IT OUT")
const ACRONYMS = new Set(['SOARD', 'BOD', 'CEO', 'CFO', 'COO', 'CTO', 'HR', 'IRS', 'GA', 'USA', 'COI', 'DEI', 'LLC', 'D&O', 'EIN', 'CPA', 'FAQ', 'ADA', 'NC', 'SC', 'FL', 'TN']);
// Names spelled their own way
const BRANDS = { LINKEDIN: 'LinkedIn', FACEBOOK: 'Facebook', INSTAGRAM: 'Instagram', YOUTUBE: 'YouTube', JOBTREAD: 'JobTread', GOFUNDME: 'GoFundMe', ZEFFY: 'Zeffy' };
const ROMAN = /^(?=[IVXLC])M*(C[MD]|D?C{0,3})(X[CL]|L?X{0,3})(I[XV]|V?I{0,3})$/;
const SMALL = new Set(['a', 'an', 'and', 'as', 'at', 'but', 'by', 'for', 'from', 'in', 'into', 'nor', 'of', 'on', 'or', 'per', 'the', 'to', 'via', 'vs', 'with']);
/** A heading in capitals as a heading is written: "1. GALA AND GOLF CLASSIC" → "1. Gala and Golf Classic" (the first word, after any number, capitalized) */
const titleCase = (t) => {
  let first = true;
  return t.split(' ').map((w) => {
    if (!/[A-Za-z]/.test(w)) return w;
    // (SOARD'S is SOARD's: the possessive aside)
    const own = w.match(/^(.*?)(['’]S)?([^A-Za-z]*)$/);
    const bare = own[1].replace(/[^A-Za-z&]/g, '');
    if (BRANDS[bare]) { first = false; return w.replace(bare, BRANDS[bare]); }
    if ((ACRONYMS.has(bare) || (ROMAN.test(bare) && bare.length > 1)) && own[1] === own[1].toUpperCase()) { first = false; return own[1] + (own[2] ? own[2].toLowerCase() : '') + own[3]; }
    const out = ACRONYMS.has(bare.toUpperCase()) && bare === bare.toUpperCase() ? w
      : !first && SMALL.has(w.toLowerCase()) ? w.toLowerCase()
      : w.toLowerCase().replace(/[a-z]/, (c) => c.toUpperCase());
    first = false;
    return out;
  }).join(' ');
};
// Bold inside a line, kept for the Markdown: a run's start and end (never in the words themselves: private-use)
const B0 = '\uE000';
const B1 = '\uE001';
const plain = (t) => t.replace(/[\uE000\uE001]/g, '');
const words = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const median = (list) => { const s = [...list].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : 0; };
// A sentence that ended (a closing quote or bracket after its stop too)
const ENDED = /[.!?:;]["”’)\]]?$/;
// The end of a word broken over a line ("commu-nity", "high-est", "organi-zation"): what follows the hyphen is a suffix
const SUFFIX = /^(?:tions?|sions?|(?:i?z|c)?ations?|ments?|ness|ings?|ity|ities|nity|ed|ers?|est|ly|ally|ous|ive|able|ible|ances?|ences?|tures?|ship|ful|less|i[sz]es?|ism|ists?|ary|ory)$/;
// The paper's own words, to tell a broken word ("member" written elsewhere) from one with a hyphen ("in-person")
let VOCAB = new Set();
/**
 * A line carried onto the next. A hyphen at its end: a word broken there is one word again (the rest a suffix, or the
 * whole word written elsewhere in the paper); a word with its own hyphen keeps it ("in-person", "twenty-five", "two-thirds"),
 * as Word breaks lines at hyphens and seldom hyphenates
 */
const joinLines = (a, b) => {
  if (!(/[a-z]-$/.test(a) && /^[a-z]/.test(b))) return `${a} ${b}`;
  const left = (a.match(/([a-z]+)-$/i) || [])[1] || '';
  const right = (b.match(/^[a-z]+/) || [''])[0];
  const broken = VOCAB.has(`${left}${right}`.toLowerCase()) || (SUFFIX.test(right) && !VOCAB.has(`${left}-${right}`.toLowerCase()) && left.length > 2);
  return broken ? `${a.slice(0, -1)}${b}` : `${a}${b}`;
};

/**
 * Lines of a paper → Markdown. Each line: `{ text, x, y, size, page }` (y growing up the page as PDFs measure it),
 * and as known: `x1` (where it ends), `tx` (where a point's words start after its bullet), `h` (the page's
 * height), `bold`, `level` (a Word heading's), `own` (a Word paragraph: whole, never carried on by the next).
 * `title`: the document's own title, so a first heading that only repeats it is left out (the page shows the title)
 */
export function wordsFromLines(lines, { title = '' } = {}) {
  const pages = new Set(lines.map((l) => l.page)).size;
  // `text`: the line's words, read for what it is; `marked`: the same with its bold runs, written out
  const clean = lines.map((l) => {
    const marked = String(l.marked || l.text || '').replace(/\s+/g, ' ').trim();
    return { ...l, marked, text: plain(marked) };
  }).filter((l) => l.text);
  // Where on its page a line sits: the top or bottom margin (a header, footer or letterhead's place)
  const firstOfPage = new Map();
  const lastOfPage = new Map();
  clean.forEach((l, i) => { if (!firstOfPage.has(l.page)) firstOfPage.set(l.page, i); lastOfPage.set(l.page, i); });
  // (a one-inch margin on Letter starts the body 91% of the way up; without the page's size, its first and last lines,
  // and a Word file's first three paragraphs only)
  const margin = (l, i) => (l.h ? l.y >= l.h * 0.915 || l.y <= l.h * 0.085
    : l.own ? l.page === clean[0]?.page && i - firstOfPage.get(l.page) < 3
    : i - firstOfPage.get(l.page) < 3 || lastOfPage.get(l.page) - i < 2);
  // A header or footer: the same words on most pages, in the margin
  const seen = new Map();
  const sameBut = (t) => words(t).replace(/\b\d+\b/g, '#');
  for (const l of clean) { const k = sameBut(l.text); seen.set(k, (seen.get(k) || new Set()).add(l.page)); }
  const repeated = (l) => pages > 1 && (seen.get(sameBut(l.text))?.size || 0) >= Math.max(2, Math.ceil(pages / 2));
  // A line of where to reach SOARD (an address, phone, website), not a sentence that happens to name one
  const contact = (t) => t.length <= 160 && (CONTACT.test(t) || STATE_ZIP.test(t)) && !/[a-z]{2}[.?!]\s+[A-Z]/.test(t) && t.split(' ').length <= 16;
  const footnote = (t) => /^[*†‡]|^\d{1,2}\s+[A-Z]/.test(t);
  // The body's letters, before anything's left out (small type in a margin is a header or footer, on one page too)
  const allBody = median(clean.flatMap((l) => Array(Math.min(20, Math.ceil(l.text.length / 10))).fill(l.size || 0))) || 0;
  // Atop the first page (a letterhead typed into the page, not Word's header): its first four lines
  const atop = (l, i) => l.page === clean[0]?.page && i - firstOfPage.get(l.page) < 4;
  // (SOARD's name alone: a letterhead in a margin or as the paper's first line; lower, it's in a title, "BYLAWS OF …")
  const paperOnly = (l, i) => PAGE_NO.test(l.text)
    || (LETTERHEAD.test(l.text) && (margin(l, i) || i === 0))
    || ((margin(l, i) || atop(l, i)) && contact(l.text))
    || (margin(l, i) && (repeated(l) || PAGE_REF.test(l.text) || (l.h && allBody && l.size && l.size < allBody * 0.92 && !footnote(l.text))))
    || SIGN_LABEL.test(l.text.replace(BLANK, '').replace(/[_.\s]+$/, '').trim()) || signLabels(l.text)
    // (blanks to sign beside their labels go; a line to fill in, "My giving commitment: $_____", keeps its words)
    || (BLANK.test(l.text) && (() => { const t = l.text.replace(/_{2,}|\.{4,}/g, ' ').replace(/\s+/g, ' ').trim(); return !t || signLabels(t) || SIGN_WORDS.test(t.replace(/[()]/g, ' ( ').replace(/\s+/g, ' ')); })());
  // The words the paper uses, whole (a broken word's whole form written elsewhere joins it again)
  VOCAB = new Set(clean.flatMap((l) => l.text.toLowerCase().match(/[a-z]+(?:-[a-z]+)*/g) || []).filter((w) => !/-$/.test(w)));
  const kept = clean.map((l, i) => (margin(l, i) && footnote(l.text) && l.h && allBody && l.size < allBody * 0.92 ? { ...l, foot: true } : l)).filter((l, i) => !paperOnly(l, i));
  // The body's letters (the size most of the words are), the space between its lines, and how wide a full line runs
  const sizes = kept.flatMap((l) => Array(Math.min(20, Math.ceil(l.text.length / 10))).fill(l.size || 0));
  const body = median(sizes) || 0;
  const gaps = [];
  kept.forEach((l, i) => {
    const p = kept[i - 1];
    if (p && !l.own && p.page === l.page && p.y > l.y && Math.abs((p.size || 0) - body) <= body * 0.1 && Math.abs((l.size || 0) - body) <= body * 0.1) gaps.push(p.y - l.y);
  });
  const lineGap = median(gaps);
  const paraGap = lineGap ? Math.max(lineGap * 1.35, lineGap + 2) : Math.max(body, 10) * 1.75;
  const edges = new Map();
  // (the whole paper's: a page with two lines on it has margins like every other)
  const edgeKey = (l) => `${l.col || 0}`;
  for (const l of kept) if (l.x1 != null) { const e = edges.get(edgeKey(l)) || { left: Infinity, right: 0 }; e.left = Math.min(e.left, l.x); e.right = Math.max(e.right, l.x1); edges.set(edgeKey(l), e); }
  // A line that runs to the right edge (of its column): its sentence may go on below; one that stops short ended its paragraph
  const full = (l) => { const e = edges.get(edgeKey(l)); return !!e && l.x1 != null && l.x1 >= e.right - (e.right - e.left) * 0.12; };
  const short = (l) => { const e = edges.get(edgeKey(l)); return !e || l.x1 == null || l.x1 - l.x <= (e.right - e.left) * 0.66; };

  const caps = (t) => (/[A-Z]{3}/.test(t) || /^(OF|AND|THE|FOR|TO|IN|ON|AT|BY)$/.test(t)) && t === t.toUpperCase() && t.length <= 60 && t.split(' ').length <= 8;
  const sized = (l) => body && l.size >= body * 1.15;
  // A short line standing on its own, the next one starting fresh under it: a heading in the body's own letters
  const standsAlone = (l, i) => {
    const t = l.text;
    const next = kept[i + 1];
    const prev = kept[i - 1];
    if (prev && /:$/.test(prev.text) && !l.bold && !sized(l)) return false;
    if (t.length > 50 || t.split(' ').length > 6 || !/^[A-Z]/.test(t) || /:$/.test(t) || /[.?!]\s/.test(t) || !next || !short(l) || /\b(19|20)\d{2}\b/.test(t)) return false;
    if ((!/^[A-Z0-9“"•]/.test(next.text) && !MARKER.test(next.text)) || NAME_TITLE.test(next.text) || /^(approved|adopted|ratified|accepted)\s+by\b/i.test(t)) return false;
    return !prev || l.own || prev.page !== l.page || prev.y - l.y > paraGap || ENDED.test(prev.text) || headingLike(prev, i - 1);
  };
  // Each line asked once (a short line asks about the one before it)
  const asked = new Map();
  const headingLike = (l, i) => {
    if (!asked.has(i)) { asked.set(i, false); asked.set(i, headingOf(l, i)); }
    return asked.get(i);
  };
  const headingOf = (l, i) => {
    const t = l.text;
    // (a company's "Inc." at the end isn't a sentence's full stop)
    if (BULLET.test(t) || /[.,;!?]$/.test(t.replace(/\b(inc|co|corp|ltd|llc)\.$/i, '$1')) || t.length > 90) return false;
    // A label with its answer ("Name: Alex Rivera", "Term: 3 years"), or when it took effect: words, not a heading
    if ((/^[^:]{1,30}:\s+\S/.test(t) && !caps(t)) || DATED.test(t) || NAME_TITLE.test(t) || l.cells) return false;
    if (l.level) return true;
    if (NUMBERED.test(t) || LABELED.test(t)) return !!(sized(l) || (l.bold && t.length <= 70 && short(l)));
    if (sized(l) || caps(t)) return true;
    if (l.bold && t.length <= 70 && !full(l)) return true;
    return standsAlone(l, i);
  };

  const blocks = [];
  const tail = (s) => s.replace(/:$/, '');
  for (let i = 0; i < kept.length; i++) {
    const l = kept[i];
    const prev = kept[i - 1];
    const last = blocks.at(-1);
    const samePage = prev && prev.page === l.page;
    const close = !!samePage && !l.own && prev.y - l.y <= paraGap;
    if (headingLike(l, i)) {
      // A heading that wrapped onto a second line stays one heading
      const sameLook = prev && Math.abs((prev.size || 0) - (l.size || 0)) < 0.5 && !!prev.bold === !!l.bold && (prev.level || 0) === (l.level || 0);
      // (close for its own letters: a big heading's lines sit further apart than the body's)
      const near = !!samePage && !l.own && prev.y - l.y <= Math.max(paraGap, (l.size || 0) * 1.6);
      const joiner = /^(OF|AND|THE|FOR)$/.test(l.text) || /^(OF|AND|THE|FOR)$/.test(prev?.text || '');
      if (last?.t === 'h' && last.at === i - 1 && (sameLook || (joiner && caps(l.text))) && (near || joiner || (l.own && caps(l.text) && caps(prev.text)))) { last.text = `${tail(last.text)} ${tail(l.text)}`; last.at = i; }
      // A first line in capitals too long to be a heading alone, its heading's second line under it: one heading
      else if (last?.t === 'p' && last.at === i - 1 && caps(l.text) && plain(last.text) === plain(last.text).toUpperCase() && plain(last.text).length <= 120 && near) { Object.assign(last, { t: 'h', text: `${tail(plain(last.text))} ${tail(l.text)}`, at: i }); }
      else blocks.push({ t: 'h', text: tail(l.text), at: i });
      continue;
    }
    // A table's row (cells set apart): a table's next row, or its first
    if (last?.t === 'table' && last.at === i - 1 && last.cols && l.cellX && close) {
      // Under the table's columns: a new row (every column), or a cell's words carried onto a second line (some)
      const at = l.cellX.map((x) => last.cols.findIndex((c) => Math.abs(c - x) <= 8));
      if (at.every((k) => k >= 0)) {
        if (at.length === last.cols.length && l.cells.length === last.cols.length && at[0] === 0) last.rows.push(l.cells);
        else { const row = last.rows.at(-1); at.forEach((k, j) => { row[k] = joinLines(row[k], (l.cells || [l.text])[j]); }); }
        last.at = i;
        continue;
      }
    }
    if (l.cells?.length >= 2) {
      const aligned = last?.t === 'table' && last.at === i - 1 && last.rows[0].length === l.cells.length;
      if (aligned) { last.rows.push(l.cells); last.at = i; } else blocks.push({ t: 'table', rows: [l.cells], bold: !!l.bold, cols: l.cellX || null, at: i });
      continue;
    }
    if (l.foot) { blocks.push({ t: 'p', text: l.marked, x: l.x, at: i }); continue; }
    // A line that carries a sentence on, though it starts like a point ("(3) months", "5. Directors" after "Section")
    const midSentence = last && last.t === 'p' && prev && prev.page === l.page && close && full(prev) && !ENDED.test(prev.text) && l.x <= prev.x + 4;
    // Lines under a list's lead-in, short and set like each other: its points
    const leadIn = last && last.t === 'p' && /:$/.test(plain(last.text)) && last.at === i - 1;
    const pointRun = last && last.t === 'li' && last.kind === 'ul' && last.implicit && last.at === i - 1 && Math.abs(l.x - last.x) <= 4;
    if (!midSentence && (leadIn || pointRun) && l.x1 != null && short(l) && !MARKER.test(l.text) && !l.bold && !sized(l) && l.text.split(' ').length <= 14) {
      blocks.push({ t: 'li', kind: 'ul', implicit: true, text: l.marked, x: l.x, tx: l.x, at: i });
      continue;
    }
    // A line that starts with a label in bold ("Attendance: …"): a paragraph of its own
    if (!midSentence && /^\uE000[^\uE001]{1,40}:\s*\uE001/.test(l.marked) && last && last.t === 'p') { blocks.push({ t: 'p', text: l.marked, x: l.x, at: i }); continue; }
    const m = !midSentence && l.text.match(BULLET);
    const n = !midSentence && !m && l.text.match(NUMBERED);
    const lab = !midSentence && !m && !n && l.text.match(LABELED);
    // The words after a bullet or number, with their bold (the prefix itself never carries it)
    const after = (k) => (l.marked.startsWith(l.text.slice(0, k)) ? l.marked.slice(k) : l.text.slice(k));
    if (m) blocks.push({ t: 'li', kind: 'ul', text: after(m[0].length), x: l.x, tx: l.tx ?? l.x, at: i });
    else if (n) blocks.push({ t: 'li', kind: 'ol', n: Number(n[1]), text: after(n[0].length), x: l.x, tx: l.tx ?? l.x, at: i });
    else if (lab) blocks.push({ t: 'li', kind: 'lab', label: lab[0].trim(), text: after(lab[0].length), x: l.x, tx: l.tx ?? l.x, at: i });
    else if (last && last.t !== 'h' && carriesOn(last, prev, l, close)) {
      // The paragraph (or the point) carried on: a word broken over the line is one word again
      last.text = joinLines(last.text, l.marked);
    } else {
      blocks.push({ t: 'p', text: l.marked, x: l.x, at: i });
    }
  }
  function carriesOn(last, prev, l, close) {
    if (!prev || l.own || last.at == null || last.t === 'table' || NAME_TITLE.test(l.text) || NAME_TITLE.test(prev.text)) return false;
    // A point's next line sits in line with its words (past its bullet, when where they start isn't known)
    const under = last.t === 'li' && (last.tx > last.x + 2 ? l.x >= last.tx - 3 : l.x > last.x + 2);
    // Over a page break while the sentence isn't finished (a point: only what sits under it)
    if (prev.page !== l.page) return (last.t === 'p' && (!ENDED.test(plain(last.text)) || (full(prev) && l.x <= prev.x + 4))) || (last.t === 'li' && under && !ENDED.test(plain(last.text)));
    if (!close) return false;
    // (a line that stopped well short of the edge ended there: a name line, a date, a short last line)
    if (last.t === 'p') return !(prev.x1 != null && short(prev)) && !(ENDED.test(prev.text) && (!full(prev) || l.x > prev.x + 12));
    // …or the point's line ran to the edge mid-sentence
    return under || (full(prev) && !ENDED.test(prev.text));
  }

  // The first heading only repeating the document's title (or a Word file's short first line) is the page's title
  // already. Not a sentence: "Board members are expected to:" stays
  const tw = words(title).split(' ').filter((w) => w.length > 3);
  const titleLike = (b) => b && (b.t === 'h' || (b.t === 'p' && plain(b.text).length <= 90 && !ENDED.test(plain(b.text))));
  // (the title's words most of the heading's: "Section 3. Committees at a glance" isn't the title "Committees")
  const sig = (b) => words(plain(b.text)).split(' ').filter((w) => w.length > 3);
  const drop = tw.length ? blocks.slice(0, 2).findIndex((b) => titleLike(b) && !(/\b(19|20)\d{2}\b/.test(plain(b.text)) && !/\b(19|20)\d{2}\b/.test(title)) && words(plain(b.text)).split(' ').length <= tw.length + 5
    && tw.filter((w) => sig(b).includes(w)).length >= Math.ceil(tw.length * 0.6) && sig(b).filter((w) => tw.includes(w)).length >= sig(b).length * 0.5) : -1;
  if (drop >= 0) blocks.splice(drop, 1);

  for (const b of blocks) if (b.t === 'table' && b.rows.length < 2) Object.assign(b, { t: 'p', text: b.rows[0].join(' '), x: 0 });
  // Points under points: one further in than the point before sits under it
  const top = [];
  let stack = [];
  for (const b of blocks) {
    if (b.t !== 'li') { top.push(b); stack = []; continue; }

    b.kids = [];
    while (stack.length && stack.at(-1).x >= b.x - 6) stack.pop();
    if (stack.length) stack.at(-1).kids.push(b); else top.push(b);
    stack.push(b);
  }
  return render(top).trim();
}

// Words that would read as Markdown stay words: "# 1", "2026. A year", "* note", "$5,000 *"; then the bold runs as
// Markdown's ("**Term:** 3 years"), their spaces outside the stars
const esc = (s) => s.replace(/([\\`*_[\]])/g, '\\$1').replace(/^([#>+-])/, '\\$1').replace(/^(\d{1,9})([.)])(?=\s|$)/, '$1\\$2')
  .replace(/\uE000(\s*)([^\uE000\uE001]*?)(\s*)\uE001/g, (_, a, w, b) => (w ? `${a}**${w}**${b}` : `${a}${b}`)).replace(/[\uE000\uE001]/g, '');

function render(list, pad = '') {
  let out = '';
  list.forEach((b, i) => {
    const next = list[i + 1];
    let line;
    if (b.t === 'h') { const t = plain(b.text); line = `${pad}### ${esc(t === t.toUpperCase() ? titleCase(t) : t)}`; }
    else if (b.t === 'table') {
      // The first row is its header when it's bold, or names its columns (no figures, a few words a cell)
      const head = b.bold || (b.rows.length >= 3 && b.rows[0].every((c) => !/\d/.test(c) && c.split(' ').length <= 4));
      const row = (cells) => cells.map((c) => esc(plain(c))).join(' · ');
      line = (head ? `${pad}**${row(b.rows[0])}**\n\n` : '') + (head ? b.rows.slice(1) : b.rows).map((r) => `${pad}- ${row(r)}`).join('\n');
    }
    else if (b.t === 'p') line = pad + esc(b.text);
    else {
      const head = b.kind === 'ol' ? `${b.n}. ` : '- ';
      line = pad + head + (b.kind === 'lab' ? `${b.label} ${esc(b.text)}` : esc(b.text));
      // What's under a point sits in line with its words
      if (b.kids.length) line += `\n${render(b.kids, pad + ' '.repeat(head.length))}`;
    }
    // A list's points one under another (a., b. points among bullets too); everything else a blank line apart
    const together = next && b.t === 'li' && next.t === 'li' && (b.kind === 'ol') === (next.kind === 'ol');
    out += line + (next ? (together ? '\n' : '\n\n') : '');
  });
  return out;
}

/**
 * One page's runs of text (`{ s, x0, x1, y, size, bold }`) → its lines, in reading order. Runs on one line are
 * joined by the space the page leaves between them; a page in two columns gives the left column's lines, then the
 * right's (a line across both, like a title, where it sits)
 */
export function linesOfItems(items, { width = 612, height = 792 } = {}) {
  const rowsOf = (list) => {
    const rows = [];
    for (const it of [...list].sort((a, b) => b.y - a.y || a.x0 - b.x0)) {
      let row = rows.find((r) => Math.abs(r.y - it.y) <= Math.max(2, Math.max(r.size, it.size) * 0.3));
      if (!row) { row = { y: it.y, size: 0, parts: [] }; rows.push(row); }
      row.parts.push(it);
      row.size = Math.max(row.size, it.size);
    }
    for (const r of rows) r.parts.sort((a, b) => a.x0 - b.x0);
    return rows.sort((a, b) => b.y - a.y);
  };
  const all = rowsOf(items);
  // Two columns: most lines have the same wide gap near the middle, with sentences (not a table's short cells) each side
  const gutters = [];
  for (const r of all) {
    for (let i = 1; i < r.parts.length; i++) {
      const a = r.parts[i - 1]; const b = r.parts[i];
      if (b.x0 - a.x1 >= Math.max(b.size, 8) * 2.5 && a.s.length >= 15 && b.s.length >= 15) gutters.push((a.x1 + b.x0) / 2);
    }
  }
  let rows = all;
  const mid = median(gutters);
  if (gutters.length >= 4 && mid > width * 0.3 && mid < width * 0.7 && gutters.filter((g) => Math.abs(g - mid) <= width * 0.05).length >= Math.max(4, all.length * 0.3)) {
    const left = []; const right = []; const across = [];
    for (const it of items) (it.x1 <= mid + 2 ? left : it.x0 >= mid - 2 ? right : across).push(it);
    const L = rowsOf(left); const R = rowsOf(right); const A = rowsOf(across);
    const colTop = Math.max(L[0]?.y ?? -Infinity, R[0]?.y ?? -Infinity);
    for (const r of L) r.col = 1;
    for (const r of R) r.col = 2;
    rows = [...A.filter((r) => r.y > colTop), ...L, ...R, ...A.filter((r) => r.y <= colTop)];
  }
  return rows.map((r) => {
    let text = '';
    let prev = null;
    let chars = 0;
    let boldChars = 0;
    for (const p of r.parts) {
      const gap = prev ? p.x0 - prev.x1 : 0;
      const known = prev && prev.x1 > prev.x0;
      if (prev && !/\s$/.test(text) && !/^\s/.test(p.s) && (!known || gap > Math.max(p.size, prev.size) * 0.12 || (/[.:;!?]$/.test(prev.s) && /^[A-Z(“"]/.test(p.s) && gap > -Math.max(p.size, prev.size) * 0.25))) text += ' ';
      text += p.s;
      const n = p.s.replace(/\s/g, '').length;
      chars += n;
      if (p.bold) boldChars += n;
      prev = p;
    }
    text = text.replace(/\s+/g, ' ').trim();
    // Bold some of the way: those runs marked, for the Markdown's **bold**
    const allBold = chars > 0 && boldChars / chars >= 0.8;
    let marked = '';
    if (!allBold && boldChars) {
      let q = null;
      for (const p of r.parts) {
        const gap = q ? p.x0 - q.x1 : 0;
        const known = q && q.x1 > q.x0;
        const sp = q && !/\s$/.test(marked.replace(/[\uE000\uE001]+$/, '')) && !/^\s/.test(p.s) && (!known || gap > Math.max(p.size, q.size) * 0.12 || (/[.:;!?]$/.test(q.s) && /^[A-Z(“"]/.test(p.s) && gap > -Math.max(p.size, q.size) * 0.25)) ? ' ' : '';
        marked += sp + (p.bold && p.s.trim() ? `${B0}${p.s}${B1}` : p.s);
        q = p;
      }
      marked = marked.replace(/\s+/g, ' ').trim().replace(/\uE001(\s*)\uE000/g, '$1');
    }
    // A table's row: its runs set two letters' width or more apart, two to six cells, each short
    const cells = [];
    for (const p of r.parts) {
      const c = cells.at(-1);
      if (c && p.x0 - c.x1 < Math.max(p.size, 8) * 2) { c.s += (/\s$/.test(c.s) || /^\s/.test(p.s) || p.x0 - c.x1 < p.size * 0.12 ? '' : ' ') + p.s; c.x1 = p.x1; } else cells.push({ s: p.s, x0: p.x0, x1: p.x1 });
    }
    const tableRow = cells.length >= 2 && cells.length <= 6 && cells.every((c) => c.s.trim() && c.s.trim().length <= 40) && !MARKER.test(text) && !BLANK.test(text);
    const first = r.parts[0];
    // Where a point's words start: the run after a bullet on its own, or past the bullet inside the run
    let tx = first.x0;
    const mk = first.s.trim().match(MARKER);
    if (mk && first.s.trim().length === mk[0].trim().length && r.parts[1]) tx = r.parts[1].x0;
    else if (mk && first.s.length && first.x1 > first.x0) tx = first.x0 + ((first.x1 - first.x0) / first.s.length) * (first.s.indexOf(first.s.trim()) + mk[0].length);
    return { text, ...(marked ? { marked } : {}), ...(tableRow ? { cells: cells.map((c) => c.s.replace(/\s+/g, ' ').trim()) } : {}), cellX: cells.map((c) => c.x0), x: first.x0, x1: Math.max(...r.parts.map((p) => p.x1)), tx, y: r.y, size: Math.round(r.size * 10) / 10, bold: allBold, h: height, col: r.col || 0 };
  });
}

/** A PDF's lines as its pages show them: each line's words in order, where it sits, its biggest letters, whether bold */
export async function pdfLines(bytes) {
  const { pdfjsLib } = await import('./vendor-pdf.js');
  const doc = await pdfjsLib.getDocument({ data: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes) }).promise;
  const out = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    // Which fonts are bold: pdf.js knows once it has loaded them for drawing
    const bold = {};
    try {
      await page.getOperatorList();
      for (const id of Object.keys(content.styles || {})) {
        try { const f = page.commonObjs.get(id); bold[id] = !!(f && (f.bold || f.black || /bold|black|heavy|semibold|demi/i.test(f.name || ''))); } catch { /* not loaded: not bold */ }
      }
    } catch { /* the words alone */ }
    const [x0, y0, x1, y1] = page.view;
    const items = content.items.filter((it) => it.str?.trim()).map((it) => {
      const size = Math.abs(it.transform[3]) || it.height || 0;
      // (a run set in with spaces starts where its words do: "   governing board" under a point's words)
      const lead = it.str.length - it.str.trimStart().length;
      const at = it.transform[4] - x0 + (lead && it.width ? (it.width / it.str.length) * lead : 0);
      return { s: it.str.trimStart(), x0: at, x1: it.transform[4] - x0 + (it.width || 0), y: it.transform[5] - y0, size, bold: !!bold[it.fontName] };
    });
    for (const l of linesOfItems(items, { width: x1 - x0, height: y1 - y0 })) out.push({ ...l, page: p });
  }
  return out;
}

/**
 * A Word file's paragraphs as lines: docxText(bytes, { paragraphs: true }) → [{ text, level, bold, ilvl, marker }]
 * (each whole: no sizes or places to go on, so a Word heading is a heading by its style, a point sits by its level).
 * Plain text (one paragraph a line, three spaces a level) works too
 */
export function docxLines(paras) {
  const list = Array.isArray(paras) ? paras : String(paras || '').split(/\n+/).map((t) => {
    const ilvl = Math.floor((t.match(/^ */)[0].length) / 3);
    return { text: t.trim(), ilvl, marker: '' };
  });
  return list.map((p, i) => {
    const lead = p.marker ? `${p.marker === '-' ? '•' : p.marker} ` : '';
    const x = (p.ilvl || 0) * 36;
    return { text: lead + p.text, ...(p.marked ? { marked: lead + p.marked } : {}), ...(p.cells?.length >= 2 ? { cells: p.cells } : {}), x, tx: x + 18, y: -i * 100, size: p.level ? 16 : 11, bold: !!p.bold, level: p.level || 0, own: true, page: 1 };
  });
}
