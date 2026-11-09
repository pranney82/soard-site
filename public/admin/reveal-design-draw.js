/**
 * reveal-design-draw.js — getting a drawing sheet ready to show the public
 * ===========================================================================
 * Used by ./reveal-design-import.js when a drawing comes in from JobTread
 * for a kid's reveal. A sheet carries the family's street address (in the
 * title block, sometimes in a note), so before it leaves the computer:
 *   1. every word of the address the PDF's own text layer has is painted
 *      over in white (findAddress: the street, its number and name, the
 *      city, the zip and the family's name; a word, a line, or letters set
 *      one at a time or spaced out, "M A R I E T T A");
 *   2. the title block is cut off when there really is one: a dark rule
 *      across the sheet in its bottom fifth (or down its right third) with
 *      writing beyond it. A rule within 5% of the edge is the sheet's own
 *      border, never a title block;
 *   3. the plain white margin around what's left is trimmed.
 * Only words can be found this way. A drawing whose address wasn't found by
 * its words (a picture, a scanned PDF, a job with no address on file) is
 * left for staff to look over, cover or tick (the import won't add it
 * until they have).
 *
 * Also: which sheet a page is (sheetTitle, kindFromSheet), by its title
 * first: JobTread's sheet name, the sheet's largest words, or a line headed
 * by a sheet number ("A1.0 EXISTING FLOOR PLAN"). Cover sheets, sheet
 * indexes, notes, elevations and trade plans (electrical, plumbing…) are
 * never the reveal's.
 * Pure functions over pixel arrays and pdf.js text items, tested in node
 * (tests/reveal-design-admin.test.mjs).
 */

/** Words and lines compared as plain lowercase words: "426 Mountain View Ln," → "426 mountain view ln" */
export const plainWords = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

/**
 * The address word this bit of text gives away, or null. words: addressWords()
 * from ./reveal-design.js. A word or phrase whole in the text; a long word the
 * text is one whole word of ("MOUNTAIN" of "mountain view"); or, with the
 * spaces taken out, a word of five letters or more ("M A R I E T T A",
 * "4 2 6 M O U N T A I N V I E W"), a number only as itself.
 */
export function addressHit(text, words) {
  const t = plainWords(text);
  if (!t) return null;
  const padded = ` ${t} `;
  const flat = t.replace(/ /g, '');
  for (const raw of words || []) {
    const w = plainWords(raw);
    if (!w) continue;
    if (padded.includes(` ${w} `)) return raw;
    if (t.length >= 5 && ` ${w} `.includes(padded)) return raw;
    const fw = w.replace(/ /g, '');
    if (fw.length >= 5 && flat.length > fw.length - 1) {
      let i = flat.indexOf(fw);
      while (i >= 0) {
        if (!/\d/.test(fw) || (!/\d/.test(flat[i - 1] || '') && !/\d/.test(flat[i + fw.length] || ''))) return raw;
        i = flat.indexOf(fw, i + 1);
      }
    }
  }
  return null;
}
export const isAddressText = (text, words) => !!addressHit(text, words);

const mul = (m1, m2) => [
  m1[0] * m2[0] + m1[2] * m2[1], m1[1] * m2[0] + m1[3] * m2[1],
  m1[0] * m2[2] + m1[2] * m2[3], m1[1] * m2[2] + m1[3] * m2[3],
  m1[0] * m2[4] + m1[2] * m2[5] + m1[4], m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
];

/**
 * A text item on the canvas: where its baseline starts, which way it runs and
 * which way is up (pdf.js items: { str, transform, width, height }; vt: the
 * viewport's transform; scale: the viewport's scale).
 */
export function placeItem(item, vt, scale) {
  const t = mul(vt, item.transform);
  const runLen = Math.hypot(t[0], t[1]) || 1;
  const along = [t[0] / runLen, t[1] / runLen];
  const size = Math.hypot(t[2], t[3]) || Math.abs(item.height || 0) * scale || 1;
  const up = [t[2] / size, t[3] / size];
  const width = Math.abs(item.width || 0) * scale || size * 0.5 * String(item.str || '').length;
  return { x: t[4], y: t[5], along, up, size, width, str: String(item.str || '') };
}

/** The box to paint over a placed item, a little bigger than the letters: four corners */
export function boxOf(p, pad = 0.3) {
  const [ax, ay] = p.along;
  const [ux, uy] = p.up;
  const back = p.size * pad;
  const below = p.size * (0.25 + pad);
  const above = p.size * (1 + pad);
  const run = p.width + p.size * pad;
  const at = (a, u) => [p.x + ax * a + ux * u, p.y + ay * a + uy * u];
  return [at(-back, -below), at(run, -below), at(run, above), at(-back, above)];
}

const placedOf = (items, vt, scale) => (items || [])
  .filter((it) => it && typeof it.str === 'string' && it.str.trim() && Array.isArray(it.transform))
  .map((it) => placeItem(it, vt, scale));

/**
 * The page's text as lines: items running the same way on the same baseline
 * (within a third of a letter), each starting near where the last ended (a
 * gap of more than three letters starts a new line: two notes side by side
 * aren't one). Each line: its items, its words, its biggest letter size.
 */
export function linesOf(placed) {
  const groups = new Map();
  for (const p of placed) {
    const key = `${Math.round(p.along[0] * 20)},${Math.round(p.along[1] * 20)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(p);
  }
  const out = [];
  for (const list of groups.values()) {
    const [ax, ay] = list[0].along;
    const across = (p) => p.x * -ay + p.y * ax;
    const run = (p) => p.x * ax + p.y * ay;
    const sorted = [...list].sort((a, b) => across(a) - across(b) || run(a) - run(b));
    const rows = [];
    for (const p of sorted) {
      const row = rows.find((l) => Math.abs(across(l[0]) - across(p)) < Math.max(l[0].size, p.size) / 3);
      if (row) row.push(p); else rows.push([p]);
    }
    for (const row of rows) {
      row.sort((a, b) => run(a) - run(b));
      let part = [row[0]];
      const close = () => { if (part.length) out.push({ items: part, text: part.map((x) => x.str).join(' ').replace(/\s+/g, ' ').trim(), size: Math.max(...part.map((x) => x.size)) }); };
      for (let i = 1; i < row.length; i++) {
        const prev = row[i - 1];
        if (run(row[i]) - (run(prev) + prev.width) > prev.size * 3) { close(); part = []; }
        part.push(row[i]);
      }
      close();
    }
  }
  return out;
}

/**
 * What to paint over, and which address words were found: each item that
 * gives the address away, and every item of a line that does.
 * → { boxes: [[x, y] × 4], hits: Set of the words found }
 */
export function findAddress(items, vt, scale, words) {
  const placed = placedOf(items, vt, scale);
  const hit = new Set();
  const hits = new Set();
  for (const p of placed) { const w = addressHit(p.str, words); if (w) { hit.add(p); hits.add(w); } }
  for (const line of linesOf(placed)) {
    if (line.items.length < 2) continue;
    const w = addressHit(line.text, words);
    if (w) { line.items.forEach((x) => hit.add(x)); hits.add(w); }
  }
  return { boxes: [...hit].map((p) => boxOf(p)), hits };
}
/** The boxes alone (as findAddress) */
export const wipeBoxes = (items, vt, scale, words) => findAddress(items, vt, scale, words).boxes;

// ── Which sheet a page is ────────────────────────────────────────────

const SHEET_NO = /^\s*[A-Z]{1,2}-?\d{1,3}(?:\.\d{1,2})?[A-Z]?(?=\s|$|[-–:])/;

/**
 * A page's title, as a designer sets it: its largest words (lines whose
 * letters are within a tenth of the biggest on the sheet), and lines headed by
 * a sheet number ("A1.0 EXISTING FLOOR PLAN"). A page with three or more
 * lines headed by sheet numbers is a sheet index (a cover). Address words
 * don't count as a title.
 * → { big: [text], numbered: [text], index: boolean }
 */
export function sheetTitle(items, vt, scale, words = []) {
  const lines = linesOf(placedOf(items, vt, scale)).filter((l) => !addressHit(l.text, words) && /[a-z]{2}/i.test(l.text));
  if (!lines.length) return { big: [], numbered: [], index: false };
  const max = Math.max(...lines.map((l) => l.size));
  const byPlace = (a, b) => (b.items[0].y < a.items[0].y ? 1 : -1);
  const big = lines.filter((l) => l.size >= max * 0.9).sort(byPlace).map((l) => l.text);
  const numberedLines = lines.filter((l) => SHEET_NO.test(l.text) && /[a-z]{3}/i.test(l.text.replace(SHEET_NO, '')));
  return { big, numbered: numberedLines.sort(byPlace).map((l) => l.text), index: numberedLines.length >= 3 };
}

// Sheets that are never the reveal's: covers and indexes, notes, elevations and sections, trade plans, schedules, details
const NOT_FOR_REVEAL = /\b(cover|title\s+sheet|index|general|notes?|specifications?|specs|elevations?|sections?|details?|electrical|plumbing|mechanical|hvac|lighting|reflected|ceiling|schedules?|site\s+plan|roof|framing|structural|foundation|door|window|finish\s+schedule)\b/i;
const NAMED_KIND = /\b(existing\s+floor\s+plan|existing\s+plan|as[\s-]?built(?:\s+(?:floor\s+)?plan)?|demolition\s+plan|proposed\s+floor\s+plan|proposed\s+plan|new\s+floor\s+plan|(?:design|mood|inspiration|finish(?:es)?|material|concept|presentation)\s+boards?|renderings?)\b/i;

/**
 * Which kind a page is, by its title first: JobTread's sheet name, then the
 * sheet's largest words, then lines headed by a sheet number; a title that
 * names a sheet the reveal never shows (a cover, notes, elevations,
 * electrical…) settles it as none. Only when no title says either way do the
 * page's other words count, and then only an exact name for a kind
 * ("existing floor plan", "design board"). kindFromText: ./reveal-design.js's.
 * → { kind: 'as-built'|'proposed'|'board'|null, title: the words that said so }
 */
export function kindFromSheet({ sheet = '', title = { big: [], numbered: [], index: false }, body = '' } = {}, kindFromText) {
  const decide = (t) => {
    const s = String(t || '').trim();
    if (!s) return undefined;
    const named = s.match(NAMED_KIND);
    if (named) return { kind: kindFromText(named[0]), title: s };
    if (NOT_FOR_REVEAL.test(s)) return { kind: null, title: s };
    // A title says what it is ("EXISTING CONDITIONS PLAN", "PROPOSED LAYOUT"); a stray "existing" in a sentence doesn't
    if (!/\b(plan|layout|board|renderings?|as[\s-]?built)\b/i.test(s)) return undefined;
    const k = kindFromText(s);
    return k ? { kind: k, title: s } : undefined;
  };
  const first = decide(sheet);
  if (first) return first;
  if (title.index) return { kind: null, title: title.big[0] || '' };
  for (const t of [...(title.big || []), ...(title.numbered || [])]) {
    const d = decide(t);
    if (d) return d;
  }
  const named = String(body || '').match(NAMED_KIND);
  return named ? { kind: kindFromText(named[0]), title: named[0] } : { kind: null, title: sheet || title.big?.[0] || '' };
}

// ── The title block and the margin ───────────────────────────────────

const lum = (d, i) => 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
const EDGE = 0.05; // within this of the edge, a rule is the sheet's border

/**
 * Where the title block starts, if the sheet has one: { bottom } is the row of
 * its top rule (a dark line across nine tenths of the width in the bottom
 * fifth), { right } the column of its left rule (a dark line down nine tenths
 * of the height in the right third), each with writing beyond it. A rule
 * within 5% of the edge is the sheet's border. data: RGBA pixels, w × h.
 */
export function findTitleBlock(data, w, h) {
  const darkIn = (x0, x1, y0, y1) => {
    let n = 0;
    for (let y = Math.max(0, y0); y < Math.min(h, y1); y++) for (let x = Math.max(0, x0); x < Math.min(w, x1); x++) if (lum(data, (y * w + x) * 4) < 110) n++;
    return n;
  };
  const enough = (area) => Math.max(12, area * 0.0004);
  const [bx0, bx1] = [Math.ceil(w * EDGE), Math.floor(w * (1 - EDGE))];
  const [by0, by1] = [Math.ceil(h * EDGE), Math.floor(h * (1 - EDGE))];
  const rowDark = (y) => { let n = 0; for (let x = 0; x < w; x++) if (lum(data, (y * w + x) * 4) < 110) n++; return n; };
  let bottom = null;
  for (let y = Math.floor(h * 0.8); y < by1 && bottom == null; y++) {
    if (rowDark(y) <= w * 0.9) continue;
    // Writing below it, past the rule's own thickness (and not the border)
    let end = y;
    while (end + 1 < h && rowDark(end + 1) > w * 0.9) end++;
    const from = end + 3;
    const area = (bx1 - bx0) * Math.max(0, by1 - from);
    if (area > 0 && darkIn(bx0, bx1, from, by1) > enough(area)) bottom = y;
    else break;
  }
  const tall = bottom ?? h;
  const colDark = (x) => { let n = 0; for (let y = 0; y < tall; y++) if (lum(data, (y * w + x) * 4) < 110) n++; return n; };
  let right = null;
  for (let x = Math.floor(w * 0.67); x < bx1 && right == null; x++) {
    if (colDark(x) <= tall * 0.9) continue;
    let end = x;
    while (end + 1 < w && colDark(end + 1) > tall * 0.9) end++;
    const from = end + 3;
    const yEnd = Math.min(by1, tall - 4);
    const area = Math.max(0, bx1 - from) * Math.max(0, yEnd - by0);
    if (area > 0 && darkIn(from, bx1, by0, yEnd) > enough(area)) right = x;
    else break;
  }
  return { bottom, right };
}

/** What's on the sheet within a box: the smallest box holding every pixel that isn't near-white, with a little room around it */
export function contentBox(data, w, h, box = { x: 0, y: 0, w, h }, padFrac = 0.02) {
  let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
  for (let y = box.y; y < box.y + box.h; y++) {
    for (let x = box.x; x < box.x + box.w; x++) {
      if (lum(data, (y * w + x) * 4) < 235) {
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0) return { ...box };
  const pad = Math.round(Math.max(x1 - x0, y1 - y0) * padFrac);
  const nx = Math.max(box.x, x0 - pad);
  const ny = Math.max(box.y, y0 - pad);
  return { x: nx, y: ny, w: Math.min(box.x + box.w, x1 + pad + 1) - nx, h: Math.min(box.y + box.h, y1 + pad + 1) - ny };
}

/** The part of a sheet to keep: above and left of a real title block, trimmed to what's drawn. titleBlock: one was cut off */
export function keepBox(data, w, h) {
  const { bottom, right } = findTitleBlock(data, w, h);
  const box = { x: 0, y: 0, w: right != null ? Math.max(1, right - 2) : w, h: bottom != null ? Math.max(1, bottom - 2) : h };
  return { ...contentBox(data, w, h, box), titleBlock: bottom != null || right != null };
}

/** "PROPOSED FLOOR PLAN" → "Proposed floor plan"; "A1.2 - Existing Plan" and "A1.0 EXISTING FLOOR PLAN" lose their sheet numbers */
export function captionOf(sheet) {
  let s = String(sheet || '').replace(/\.(pdf|png|jpe?g|heic)$/i, '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim();
  s = s.replace(/^[A-Z]{0,3}\s?-?\d+(\.\d+)*[A-Z]?\s*[-–:]\s*/i, '').replace(/^[A-Z]{1,2}-?\d{1,3}(?:\.\d{1,2})?[A-Z]?\s+(?=[A-Za-z])/, '');
  if (!s) return '';
  if (s === s.toUpperCase()) s = s.toLowerCase();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// ── Covering by hand ─────────────────────────────────────────────────

/**
 * Boxes drawn by hand, as fractions of the picture ({ x, y, w, h } from 0 to
 * 1), kept inside it and at least a few pixels big; in pixels for a w × h
 * picture.
 */
export function coverRects(boxes, w, h) {
  return (boxes || []).map((b) => {
    const x0 = Math.max(0, Math.min(1, b.x)), y0 = Math.max(0, Math.min(1, b.y));
    const x1 = Math.max(0, Math.min(1, b.x + b.w)), y1 = Math.max(0, Math.min(1, b.y + b.h));
    return { x: Math.floor(Math.min(x0, x1) * w), y: Math.floor(Math.min(y0, y1) * h), w: Math.ceil(Math.abs(x1 - x0) * w), h: Math.ceil(Math.abs(y1 - y0) * h) };
  }).filter((r) => r.w >= 2 && r.h >= 2);
}
