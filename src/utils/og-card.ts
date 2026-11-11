/**
 * Share cards: the picture a link to the site shows in Messages, Facebook,
 * WhatsApp, Slack, LinkedIn, X and the rest.
 *
 * A page's card is its hero, as a card: the same eyebrow, headline (its
 * italic word on the yellow marker), lead and photo, in the page's colors,
 * with SOARD's official logo. One design for every page, two layouts:
 *   - split: words left, the photo right in its frame (the pale yellow block
 *     behind it, an optional small photo over its corner), like the site's
 *     editorial split hero;
 *   - text:  centered words, like the text-only page hero (FAQ, Our Story…).
 * Flat colors only, nothing written on a photo.
 *
 * Words are measured with the fonts themselves, so a headline is sized to fit
 * and broken into even lines, and nothing is cut mid-word. A lead too long
 * for its lines ends on a whole word and "…".
 *
 * The card is drawn by Satori (layout → SVG) and Sharp (SVG → JPEG). JPEG,
 * not PNG: a photo in a full-color PNG is 600 KB+, past what WhatsApp will
 * show, and a palette PNG bands faces. Text stays sharp at 4:4:4.
 *
 * Pages ask for a card through BaseLayout's `og` prop; src/integrations/og-cards.mjs
 * draws every card the build asked for (see there).
 */
import satori from 'satori';
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import opentype from '@shuding/opentype.js';
import { CF_HASH, cfId, withFocus } from './cf-image';
import { sentences } from './sentences';

export const OG_W = 1200;
export const OG_H = 630;

// imagedelivery.net works at build time regardless of host (the /cdn-cgi/ proxy doesn't)
const CF_DIRECT = `https://imagedelivery.net/${CF_HASH}`;
const LOGO_ID = 'brand-logo-light-bg-display';

// ── Looks: a page's colors (the site's, or an event's from RECAP_LOOKS) ──
export interface Look {
  paper: string;     // background
  ink: string;       // headline
  muted: string;     // lead
  eyebrow: string;   // eyebrow and its dash
  highlight: string; // the marker behind the italic word
  accent: string;    // the block behind the photo
}
export const SITE_LOOK: Look = {
  paper: '#FEFCF5', ink: '#373A36', muted: '#5A5B61', eyebrow: '#5A5B61',
  highlight: 'rgba(255, 218, 36, 0.3)', accent: 'rgba(255, 218, 36, 0.35)',
};

export interface CardPhoto {
  /** Cloudflare Images id (or a full imagedelivery URL) */
  id: string;
  /** A crop of the whole photo first (e.g. a person's portrait "trim=…"), before it's fitted */
  pre?: string;
  /** The photo's alt text, for the card's own alt text */
  alt?: string;
  /** Shown whole, never cropped, at its own shape (a book's cover): its width over its height */
  whole?: boolean;
  aspect?: number;
}

export interface CardSpec {
  layout: 'split' | 'text';
  /** The small capitals over the headline */
  eyebrow?: string;
  /** The headline as the page writes it: text, with <em> for its italic word (other tags are dropped) */
  title: string;
  /** The line under the headline (tags are dropped); the card shows as many whole sentences as fit */
  lead?: string;
  /** Instead of a lead: separate facts ("10,000 children impacted yearly"), as many whole ones as fit, joined by " · " */
  leadParts?: string[];
  /** text layout: the lead in italic serif, like the text-only page hero */
  leadItalic?: boolean;
  /** text layout: the headline's weight, as its page hero has it (400 there, else 700) */
  titleWeight?: 400 | 700;
  photo?: CardPhoto | null;
  /** The small photo over the main one's lower corner, when the page's hero has one */
  inset?: CardPhoto | null;
  look?: Look;
}

// ── Fonts ─────────────────────────────────────────
// Latin, plus extended Latin (Ł, Đ, ő…) as static weights of the site's own
// latin-ext variable fonts; a letter the first doesn't have comes from the second
const FONT_FILES = {
  serif700: 'libre-baskerville-latin-700-normal.woff',
  serif400: 'libre-baskerville-latin-400-normal.woff',
  serifItalic: 'libre-baskerville-latin-400-italic.woff',
  sans400: 'outfit-latin-400-normal.woff',
  sans700: 'outfit-latin-700-normal.woff',
  serif700x: 'libre-baskerville-latin-ext-700-normal.woff',
  serif400x: 'libre-baskerville-latin-ext-400-normal.woff',
  sans400x: 'outfit-latin-ext-400-normal.woff',
  sans700x: 'outfit-latin-ext-700-normal.woff',
} as const;
type FontKey = keyof typeof FONT_FILES;
// Each family with its extended-Latin fallback (Satori falls back along the list, letter by letter)
const SERIF = 'Serif, Serif Ext';
const SERIF_ITALIC = 'Serif Italic, Serif Ext';
const SANS = 'Sans, Sans Ext';
const EXT: Partial<Record<FontKey, FontKey>> = { serif700: 'serif700x', serif400: 'serif400x', serifItalic: 'serif400x', sans400: 'sans400x', sans700: 'sans700x' };
const has = (face: FontKey, ch: string) => fonts().faces[face].charToGlyphIndex(ch) > 0;
/**
 * The text as the fonts can draw it, never a box: a letter neither font has
 * loses only the accent they lack ("ứ" → "ư" → "u"); a sign with no letter in
 * it (an emoji, an arrow) is left out
 */
function drawable(text: string, face: FontKey): string {
  const ext = EXT[face];
  const ok = (ch: string) => ch === ' ' || ch === '\u00A0' || has(face, ch) || (!!ext && has(ext, ch));
  text = spaces(text);
  return [...text].map((ch) => {
    if (ok(ch)) return ch;
    const parts = [...ch.normalize('NFD')];
    while (parts.length > 1) {
      parts.pop();
      const fewer = parts.join('').normalize('NFC');
      if ([...fewer].every(ok)) return fewer;
    }
    return '';
  }).join('').replace(/ {2,}/g, ' ');
}
export const drawableText = (text: string, face: FontKey) => drawable(text, face);
/** The headline's pieces, each drawable in its own face (italic words in the italic) */
const drawableTitle = (pieces: Piece[], face: FontKey): Piece[] =>
  pieces.map((p) => (p.text === BREAK ? p : { ...p, text: drawable(p.text, p.em ? 'serifItalic' : face) })).filter((p) => p.text);
const FONT_DIR = path.resolve('./src/fonts');

let fontData: Record<FontKey, ArrayBuffer> | null = null;
let fontFaces: Record<FontKey, any> | null = null;
function fonts() {
  if (fontData && fontFaces) return { data: fontData, faces: fontFaces };
  const data = {} as Record<FontKey, ArrayBuffer>;
  const faces = {} as Record<FontKey, any>;
  for (const [k, file] of Object.entries(FONT_FILES) as [FontKey, string][]) {
    const buf = fs.readFileSync(path.join(FONT_DIR, file));
    data[k] = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    faces[k] = opentype.parse(data[k]);
  }
  fontData = data;
  fontFaces = faces;
  return { data, faces };
}

/**
 * What the drawing depends on besides a card's own words and photos: this
 * file, the sentence rules, the fonts and the drawing libraries' versions.
 * Part of every card's key.
 */
let rendererHash: string | null = null;
export function rendererVersion(): string {
  if (rendererHash) return rendererHash;
  const h = crypto.createHash('sha256');
  for (const file of ['./src/utils/og-card.ts', './src/utils/sentences.ts']) h.update(fs.readFileSync(path.resolve(file)));
  // The drawing libraries: a new Satori, Sharp (libvips) or opentype can draw the same card differently
  for (const pkg of ['satori', 'sharp', '@shuding/opentype.js']) {
    try { h.update(JSON.parse(fs.readFileSync(path.resolve('./node_modules', pkg, 'package.json'), 'utf8')).version); } catch { h.update(`${pkg}?`); }
  }
  h.update(sharp.versions?.vips || '');
  for (const file of Object.values(FONT_FILES)) h.update(fs.readFileSync(path.join(FONT_DIR, file)));
  rendererHash = h.digest('hex').slice(0, 12);
  return rendererHash;
}

/**
 * A card's key: everything its pixels depend on (its words and colors, the
 * exact photo crops it will ask Cloudflare for, focal points included, the
 * official logo's bytes and the drawing code). Two cards with one key are the
 * same picture. The address a page links to is the picture's own fingerprint
 * (src/integrations/og-cards.mjs), so apps fetch a card again whenever it changes.
 */
// A photo replaced under the same Cloudflare id isn't seen (uploads get new ids, so it doesn't happen)
export async function cardKey(spec: CardSpec): Promise<string> {
  const s = normalize(spec);
  const plan = photoPlan(s);
  return crypto.createHash('sha256')
    .update(rendererVersion())
    .update((await logo())?.digest || 'logo-not-loaded')
    .update(JSON.stringify({ ...s, photo: null, inset: null, crops: [plan.main?.url || null, plan.inset?.url || null] }))
    .digest('hex').slice(0, 10);
}

function normalize(spec: CardSpec): CardSpec {
  // Words are words: a page passing anything else (an array, an object) stops the build here, not on the card
  for (const k of ['title', 'eyebrow', 'lead'] as const) {
    if (spec[k] != null && typeof spec[k] !== 'string') throw new Error(`Share card: "${k}" must be text, got ${Array.isArray(spec[k]) ? 'a list' : typeof spec[k]} (${JSON.stringify(spec[k]).slice(0, 80)})`);
  }
  const photo = (p?: CardPhoto | null) => (p && p.id ? {
    id: cfId(p.id), ...(p.pre ? { pre: p.pre } : {}),
    ...(p.whole ? { whole: true, aspect: Math.round((p.aspect || 0.75) * 1000) / 1000 } : {}),
  } : null);
  return {
    layout: spec.layout === 'split' && photo(spec.photo) ? 'split' : 'text',
    eyebrow: clean(spec.eyebrow || ''),
    title: (spec.title || '').trim(),
    lead: clean(spec.lead || ''),
    leadParts: (spec.leadParts || []).map(clean).filter(Boolean),
    leadItalic: !!spec.leadItalic,
    titleWeight: spec.titleWeight === 400 ? 400 : 700,
    photo: photo(spec.photo),
    inset: photo(spec.inset),
    look: spec.look || SITE_LOOK,
  };
}

// ── Words ─────────────────────────────────────────
const ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00A0', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“',
  mdash: '—', ndash: '–', hellip: '…', middot: '·', rarr: '→', larr: '←', darr: '↓', eacute: 'é', ntilde: 'ñ', copy: '©',
};
function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isInteger(code) && code > 0 && code <= 0x10FFFF ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}
/** Plain text from a bit of page HTML */
export function clean(html: string): string {
  return decode(String(html || '').replace(/<br\s*\/?>/gi, ' ').replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
}

interface Piece { text: string; em: boolean }
/** The headline as pieces of plain and italic text (<em>/<i> italic; <br> a line break, BREAK; other tags dropped) */
export function parseTitle(html: string): Piece[] {
  const out: Piece[] = [];
  let em = 0;
  const re = /<\s*(\/?)\s*(em|i|br)\b[^>]*>|<[^>]*>|([^<]+)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    if (m[3] != null) out.push({ text: decode(m[3]), em: em > 0 });
    else if (m[2]) {
      const tag = m[2].toLowerCase();
      if (tag === 'br') out.push({ text: BREAK, em: false });
      else em = Math.max(0, em + (m[1] ? -1 : 1));
    }
  }
  // Join neighbours of the same kind; one space between words; no space at a line's ends
  const merged: Piece[] = [];
  for (const p of out) {
    // Spaces collapse; a no-break one (&nbsp;, the narrow one before "PM") stays one and keeps its words together
    const text = p.text === BREAK ? BREAK : spaces(p.text);
    if (!text) continue;
    const last = merged[merged.length - 1];
    if (last && last.em === p.em && last.text !== BREAK && text !== BREAK) last.text += text;
    else merged.push({ text, em: p.em });
  }
  merged.forEach((p, i) => {
    if (p.text === BREAK) return;
    if (i === 0 || merged[i - 1].text === BREAK) p.text = p.text.replace(/^ +/, '');
    if (i === merged.length - 1 || merged[i + 1].text === BREAK) p.text = p.text.replace(/ +$/, '');
  });
  while (merged[0]?.text === BREAK) merged.shift();
  while (merged[merged.length - 1]?.text === BREAK) merged.pop();
  return merged.filter((p) => p.text);
}
/** Every kind of space as the cards draw it: no-break ones as "\u00A0", the rest as " ", invisible ones gone */
function spaces(t: string): string {
  return t.replace(/[\u200B-\u200D\u2060\uFEFF]/g, '').replace(/[\u00A0\u2007\u202F]/g, '\u00A0').replace(/[^\S\u00A0]+/g, ' ');
}

/** A line break the page wrote (<br>) */
export const BREAK = '\n';

/** The headline's lines as the page breaks them (its <br>s), each still free to wrap */
function segmentsOf(pieces: Piece[]): Piece[][] {
  const segs: Piece[][] = [[]];
  for (const p of pieces) { if (p.text === BREAK) segs.push([]); else segs[segs.length - 1].push(p); }
  return segs.filter((s) => s.length);
}

/** A word: its pieces (a word can be part italic, "dreams," = "dreams" + ",") */
type Word = Piece[];
function wordsOf(pieces: Piece[]): Word[] {
  const words: Word[] = [[]];
  for (const p of pieces) {
    const parts = p.text.split(' ');
    parts.forEach((part, i) => {
      if (i > 0) words.push([]);
      if (part) words[words.length - 1].push({ text: part, em: p.em });
    });
  }
  return words.filter((w) => w.length);
}

interface TextStyle { face: FontKey; emFace?: FontKey; size: number; tracking: number; emPad?: number }
function measure(text: string, face: FontKey, size: number, tracking: number): number {
  const ext = EXT[face];
  // Runs of letters by the font that draws them (Latin, else extended Latin)
  let width = 0, run = '', runFace = face;
  const flush = () => { if (run) width += fonts().faces[runFace].getAdvanceWidth(run, size, { kerning: true }); run = ''; };
  for (const ch of text) {
    const f = ext && !has(face, ch) && has(ext, ch) ? ext : face;
    if (f !== runFace) { flush(); runFace = f; }
    run += ch;
  }
  flush();
  return width + tracking * size * [...text].length;
}
function wordWidth(w: Word, st: TextStyle): number {
  let width = 0;
  for (const p of w) {
    width += measure(p.text, p.em && st.emFace ? st.emFace : st.face, st.size, st.tracking);
    if (p.em && st.emPad) width += 2 * st.emPad * st.size;
  }
  return width;
}
const spaceWidth = (st: TextStyle) => measure(' ', st.face, st.size, st.tracking);

/** Greedy lines at a width */
const JOINER = /^(a|an|the|of|to|in|on|for|or|and|with|at|by|from|&|is|as)$/i;
const textOf = (w: Word) => w.map((p) => p.text).join('');
/** A word wider than the line, in pieces that fit, each but the last ending in a hyphen */
function splitWide(w: Word, st: TextStyle, width: number): Word[] {
  if (wordWidth(w, st) <= width) return [w];
  const out: Word[] = [];
  let cur: Word = [];
  for (const p of w) {
    for (const ch of p.text) {
      const next = [...cur.slice(0, -1), ...(cur.length && cur[cur.length - 1].em === p.em ? [{ ...cur[cur.length - 1], text: cur[cur.length - 1].text + ch }] : [...cur.slice(-1), { text: ch, em: p.em }])];
      if (cur.length && wordWidth([...next, { text: '-', em: p.em }], st) > width) { out.push([...cur, { text: '-', em: p.em }]); cur = [{ text: ch, em: p.em }]; }
      else cur = next;
    }
  }
  if (cur.length) out.push(cur);
  return out;
}
function breakLines(words: Word[], st: TextStyle, width: number): Word[][] {
  const sp = spaceWidth(st);
  const lines: Word[][] = [];
  let line: Word[] = [];
  let used = 0;
  for (const w of words.flatMap((x) => splitWide(x, st, width))) {
    const ww = wordWidth(w, st);
    if (line.length && used + sp + ww > width) {
      // A line doesn't end on "a", "of", "the"…: it starts the next one, when that still fits
      const last = line[line.length - 1];
      if (line.length > 1 && JOINER.test(textOf(last)) && wordWidth(last, st) + sp + ww <= width) {
        line.pop();
        lines.push(line);
        line = [last, w];
        used = wordWidth(last, st) + sp + ww;
      } else { lines.push(line); line = [w]; used = ww; }
    } else { used += (line.length ? sp : 0) + ww; line.push(w); }
  }
  if (line.length) lines.push(line);
  return lines;
}
const widest = (words: Word[]) => (st: TextStyle) => Math.max(...words.map((w) => wordWidth(w, st)));
const lineWidth = (line: Word[], st: TextStyle) => line.reduce((s, w, i) => s + wordWidth(w, st) + (i ? spaceWidth(st) : 0), 0);

/** A break worth avoiding: a line ending on "a", "&", "of"…, one splitting an italic phrase ("room / reveal"), a lone short last word */
function awkward(lines: Word[][]): number {
  let n = 0;
  for (let i = 0; i < lines.length - 1; i++) {
    const end = lines[i][lines[i].length - 1], next = lines[i + 1][0];
    if (JOINER.test(textOf(end))) n++;
    // A name's suffix stays with the name ("Anthony Jr.", "John III")
    if (/^(jr|sr)\.?,?$|^(ii|iii|iv)[,.]?$/i.test(textOf(next))) n++;
    if (end[end.length - 1]?.em && next[0]?.em) n++;
  }
  // A last line of one short word under a full one ("Bedroom for Your / Child"): half as bad
  const last = lines[lines.length - 1], before = lines[lines.length - 2];
  if (before && last.length === 1 && before.length >= 3 && [...textOf(last[0])].length <= 7) n += 0.5;
  return n;
}
/**
 * Even lines, in as few as the text needs: every way of breaking it into that
 * many lines is tried, and the one with no awkward break whose longest line is
 * shortest wins (CSS's text-wrap: balance, plus the awkward-break rules).
 * Greedy filling can't find "Jack's / room reveal"; this can.
 */
function balance(words: Word[], st: TextStyle, width: number): Word[][] {
  const full = breakLines(words, st, width);
  const target = full.length;
  if (target <= 1) return full;
  const ws = words.flatMap((w) => splitWide(w, st, width));
  const n = ws.length;
  const sp = spaceWidth(st);
  const ww = ws.map((w) => wordWidth(w, st));
  // Too many words to try every way (a long lead): greedy at the full width
  let ways = 1;
  for (let i = 0; i < target - 1; i++) ways = (ways * (n - 1 - i)) / (i + 1);
  if (ways > 20000) return full;
  let best: Word[][] = full, bestScore = Infinity;
  const widthOf = (a: number, b: number) => { let w = 0; for (let i = a; i < b; i++) w += ww[i] + (i > a ? sp : 0); return w; };
  const tryFrom = (start: number, left: number, cuts: number[]) => {
    if (left === 1) {
      if (widthOf(start, n) > width) return;
      const bounds = [...cuts, start, n];
      const lines = bounds.slice(0, -1).map((a, i) => ws.slice(a, bounds[i + 1]));
      const widths = lines.map((_, i) => widthOf(bounds[i], bounds[i + 1]));
      const longest = Math.max(...widths);
      const score = awkward(lines) * 1e6 + longest + widths.reduce((s, w) => s + ((longest - w) / 100) ** 2, 0);
      if (score < bestScore) { bestScore = score; best = lines; }
      return;
    }
    for (let end = start + 1; end <= n - (left - 1); end++) {
      if (widthOf(start, end) > width) break;
      tryFrom(end, left - 1, [...cuts, start]);
    }
  };
  tryFrom(0, target, []);
  return best;
}

// Satori and opentype round a little differently: leave a sliver of room
const SAFETY = 0.97;

/**
 * The headline's size and lines: as big as it can be, in as few even lines as
 * look right (each line count has its own sizes: one line only when big), with
 * no awkward break unless avoiding it would cost real size. Cut ("…") only if
 * four lines at the smallest size can't hold it.
 */
type Tier = { lines: number; sizes: number[] };
function fitTitle(pieces: Piece[], base: Omit<TextStyle, 'size'>, width: number, tiers: Tier[]) {
  const segments = segmentsOf(pieces).map(wordsOf);
  const all = segments.flat();
  // Every size each tier allows, weighed: bigger is better; an awkward break costs
  // as much as 20px of size, each extra line 2px
  let best: { st: TextStyle; lines: Word[][] } | null = null, bestScore = -Infinity;
  for (const tier of tiers) {
    if (segments.length > tier.lines) continue;
    for (const size of tier.sizes) {
      const st = { ...base, size };
      if (widest(all)(st) > width * SAFETY) continue;
      const lines = segments.flatMap((seg) => balance(seg, st, width * SAFETY));
      if (lines.length > tier.lines) continue;
      const score = size - 20 * awkward(lines) - 2 * (lines.length - 1);
      if (score > bestScore) { best = { st, lines }; bestScore = score; }
    }
  }
  if (best) return best;
  // The page's own breaks can't be kept (more of them than lines): weigh it as one block at every size
  if (segments.length > 1) return fitTitle(pieces.map((p) => (p.text === BREAK ? { text: ' ', em: false } : p)), base, width, tiers);
  // Even four lines at the smallest size can't hold it: wrap it as one
  const last = tiers[tiers.length - 1];
  for (const size of last.sizes) {
    const st = { ...base, size };
    if (widest(all)(st) > width * SAFETY) continue;
    const lines = balance(all, st, width * SAFETY);
    if (lines.length <= last.lines) return { st, lines };
  }
  const st = { ...base, size: last.sizes[last.sizes.length - 1] };
  return { st, lines: clampLines(breakLines(all, st, width * SAFETY), st, width * SAFETY, last.lines) };
}
const range = (from: number, to: number, step = 4) => Array.from({ length: Math.floor((from - to) / step) + 1 }, (_, i) => from - i * step);
const SPLIT_TIERS: Tier[] = [
  { lines: 1, sizes: range(100, 76) },
  { lines: 2, sizes: range(88, 64) },
  { lines: 3, sizes: range(76, 48) },
  { lines: 4, sizes: range(52, 40) },
];
const TEXT_TIERS: Tier[] = [
  { lines: 1, sizes: range(96, 80) },
  { lines: 2, sizes: range(84, 52) },
  { lines: 3, sizes: range(56, 44) },
];

/**
 * The lead's lines: as many whole sentences (or facts) as fit in maxLines;
 * only a first sentence too long for them is cut, at a word, with "…"
 */
function fitLead(text: string, parts: string[] | undefined, st: TextStyle, width: number, maxLines: number, even = false): { st: TextStyle; lines: Word[][] } {
  const pieces = parts && parts.length ? parts : sentences(text);
  if (!pieces.length) return { st, lines: [] };
  const join = parts && parts.length ? '\u00A0· ' : ' ';
  const lay = (t: string, at: TextStyle) => (even ? balance : breakLines)(wordsOf([{ text: t, em: false }]), at, width);
  for (let n = pieces.length; n >= 1; n--) {
    // Whole sentences at the lead's size; the first one alone may go a size or two smaller rather than be cut
    for (const size of n === 1 ? [st.size, st.size - 2, st.size - 3] : [st.size]) {
      const at = { ...st, size };
      const lines = lay(pieces.slice(0, n).join(join), at);
      if (lines.length <= maxLines) return { st: at, lines };
    }
  }
  return { st, lines: clampLines(breakLines(wordsOf([{ text: pieces[0], em: false }]), st, width), st, width, maxLines) };
}

/** At most n lines; a cut ends on whole words and "…" */
function clampLines(lines: Word[][], st: TextStyle, width: number, n: number): Word[][] {
  if (lines.length <= n) return lines;
  const kept = lines.slice(0, n).map((l) => l.slice());
  const last = kept[n - 1];
  const ell: Word = [{ text: '…', em: false }];
  const fits = () => lineWidth([...last.slice(0, -1), [...last[last.length - 1], ...ell]], st) <= width;
  while (last.length > 1 && !fits()) last.pop();
  // Never end on a dash, or a word that leads into the next ("and…", "over…", "from…")
  const weak = (w: Word) => /^[—–-]+$/.test(textOf(w)) || /^(a|an|and|the|of|to|in|on|for|or|with|at|by|from|&|is|as|over|into|than|about|that|which|who|when|while|like|just|so|but|our|their|his|her|its|your|my|this|these|those)$/i.test(textOf(w));
  while (last.length > 1 && weak(last[last.length - 1])) last.pop();
  last[last.length - 1] = [...last[last.length - 1].map((p) => ({ ...p, text: p.text.replace(/[\s,;:.!?—–-]+$/, '') })), ...ell];
  return kept;
}

// ── Images ────────────────────────────────────────
async function fetchImage(url: string, tries = 3): Promise<Buffer | null> {
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (res.ok) return Buffer.from(await res.arrayBuffer());
      if (res.status === 404) return null;
    } catch { /* try again */ }
    await new Promise((r) => setTimeout(r, 400 * (i + 1)));
  }
  return null;
}
const dataUri = (buf: Buffer, type: string) => `data:${type};base64,${buf.toString('base64')}`;

/** The address of a photo cut to exactly w×h, on its focal point (else the face, else Cloudflare's best guess) */
function photoUrl(p: CardPhoto, w: number, h: number): string | null {
  const id = cfId(p.id);
  if (!id) return null;
  const crop = withFocus(id, `w=${w},h=${h},fit=cover,gravity=face,q=92`);
  return `${CF_DIRECT}/${id}/${p.pre ? `${p.pre},` : ''}${crop},format=jpeg`;
}
type Planned = { url: string; w: number; h: number; left: number; top: number };
/** Where a split card's photos go and the crops it asks for */
function photoPlan(s: CardSpec): { main: Planned | null; inset: Planned | null } {
  if (s.layout !== 'split' || !s.photo) return { main: null, inset: null };
  const P = { ...SPLIT.photo };
  if (s.photo.whole) {
    // A book's cover is shown whole at its own shape
    const aspect = s.photo.aspect || 0.75;
    P.w = Math.round(Math.min(460, P.h * aspect));
    P.h = Math.round(P.w / aspect);
    P.top = Math.round((OG_H - P.h) / 2);
  }
  const left = OG_W - P.right - P.w;
  const main = photoUrl(s.photo, P.w, P.h);
  const insetW = Math.round(P.w * 0.4), insetH = Math.round(insetW * 6 / 5);
  const inset = s.inset && !s.photo.whole ? photoUrl(s.inset, insetW, insetH) : null;
  return {
    main: main ? { url: main, w: P.w, h: P.h, left, top: P.top } : null,
    inset: inset ? { url: inset, w: insetW, h: insetH, left: left - 30, top: P.top + P.h + 22 - insetH } : null,
  };
}
/** A planned photo, as the image Satori draws */
async function photoAt(plan: Planned): Promise<string | null> {
  const { w, h } = plan;
  const buf = await fetchImage(plan.url);
  if (!buf) return null;
  // Exactly the size it's drawn at, so it isn't resampled again (Cloudflare won't enlarge a small original)
  const { width, height } = await sharp(buf).metadata();
  const exact = width === w && height === h ? buf : await sharp(buf).resize(w, h, { fit: 'cover' }).jpeg({ quality: 92 }).toBuffer();
  return dataUri(exact, 'image/jpeg');
}

let logoLoad: Promise<{ src: string; w: number; h: number; digest: string } | null> | null = null;
let logoFailedAt = 0;
/**
 * The official logo, trimmed of its empty space (never anything else); null
 * if Cloudflare didn't give it. A failure is remembered for 10 minutes, so a
 * build during an outage doesn't wait on it again for every page.
 */
function logo() {
  if (!logoLoad && Date.now() - logoFailedAt < 600_000) return Promise.resolve(null);
  logoLoad ||= (async () => {
    const buf = await fetchImage(`${CF_DIRECT}/${LOGO_ID}/w=600,q=95`);
    if (!buf) { logoLoad = null; logoFailedAt = Date.now(); return null; }
    const { data, info } = await sharp(buf).trim().png().toBuffer({ resolveWithObject: true });
    return { src: dataUri(data, 'image/png'), w: info.width, h: info.height, digest: crypto.createHash('sha256').update(buf).digest('hex') };
  })();
  return logoLoad;
}

// ── Drawing ───────────────────────────────────────
type Node = { type: string; props: Record<string, any> };
const div = (style: Record<string, any>, children?: any): Node => ({ type: 'div', props: { style: { display: 'flex', ...style }, children } });

const TITLE_LEADING = 1.06;
const TITLE_TRACKING = -0.03;
const EM_PAD = 0.05;
// Libre Baskerville's line box: ascender 0.97, descender 0.27 (the marker covers its lower part)
const ASC = 0.97, DESC = 0.27;

/** A headline line as runs of plain and italic text; the space between two italic words is italic (one marker under "room reveal") */
function lineRuns(line: Word[]): Piece[] {
  const runs: Piece[] = [];
  line.forEach((w, i) => {
    const between = i > 0 && !!line[i - 1][line[i - 1].length - 1]?.em && !!w[0]?.em;
    const pieces = i ? [{ text: ' ', em: between }, ...w] : w;
    for (const p of pieces) {
      const last = runs[runs.length - 1];
      if (last && last.em === p.em) last.text += p.text; else runs.push({ ...p });
    }
  });
  return runs;
}

/** One headline line: plain runs and italic runs with the marker behind them */
function titleLine(line: Word[], st: TextStyle, look: Look, weight: 400 | 700, markerFrom: number): Node {
  const runs = lineRuns(line);
  const lineH = st.size * TITLE_LEADING;
  const content = st.size * (ASC + DESC);
  const top = (lineH - content) / 2;
  return div({ alignItems: 'flex-end', height: lineH }, runs.map((r) => {
    if (!r.em) return div({ whiteSpace: 'pre' }, r.text);
    // The page's marker: the lower part of the italic word's box, flat, a little past each side
    const pad = EM_PAD * st.size;
    return div({ position: 'relative', whiteSpace: 'pre', paddingLeft: pad, paddingRight: pad }, [
      div({ position: 'absolute', left: 0, right: 0, top: top + content * markerFrom, height: content * (1 - markerFrom), backgroundColor: look.highlight }),
      // The site's headlines are bold and the italic face is regular, so the browser thickens it: do the same
      div({ fontFamily: SERIF_ITALIC, fontStyle: 'italic', fontWeight: 400, ...(weight === 700 ? { WebkitTextStroke: `${(st.size * 0.026).toFixed(2)}px ${look.ink}` } : {}) }, r.text),
    ]);
  }));
}

/**
 * An eyebrow too long for one line, on two: broken after a comma or at a "·"
 * when one fits ("ACCESSIBLE BATHROOM, DREAM BEDROOM, / THERAPY ROOM · 2026"),
 * else wherever is most even; cut with "…" only if two lines can't hold it
 */
function eyebrowLines(words: Word[], st: TextStyle, room: number): Word[][] {
  let best: Word[][] | null = null, bestScore = Infinity;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i), b = words.slice(i);
    const wa = lineWidth(a, st), wb = lineWidth(b, st);
    if (wa > room || wb > room) continue;
    const clean = /[,·]$/.test(textOf(a[a.length - 1])) || textOf(b[0]) === '·';
    const score = (clean ? 0 : 1e6) + Math.max(wa, wb);
    if (score < bestScore) { bestScore = score; best = [a, b[0] && textOf(b[0]) === '·' ? b.slice(1) : b]; }
  }
  return best || clampLines(breakLines(words, st, room), st, room, 2);
}

/**
 * The eyebrow: the page's words in small capitals on one line, a little
 * smaller if they're long; longer still, on two even lines (never cut short
 * unless two lines can't hold them)
 */
function eyebrowNode(text: string, look: Look, width: number, centered = false): Node | null {
  if (!text) return null;
  const caps = drawable(text.toUpperCase(), 'sans700').trim();
  if (!caps) return null;
  const room = (width - (centered ? 0 : 36 + 16)) * SAFETY;
  const words = wordsOf([{ text: caps, em: false }]);
  const at = (size: number): TextStyle => ({ face: 'sans700', size, tracking: 0.14 });
  let size = 19;
  while (size > 16 && lineWidth(words, at(size)) > room) size -= 1;
  const lines = lineWidth(words, at(size)) <= room ? [words] : eyebrowLines(words, at(size), room);
  const lineH = Math.round(size * 1.35);
  return div({ alignItems: 'flex-start', gap: 16, ...(centered ? { justifyContent: 'center' } : {}) }, [
    ...(centered ? [] : [div({ width: 36, height: 3, marginTop: Math.round(lineH / 2 - 1.5), backgroundColor: look.eyebrow })]),
    div({ flexDirection: 'column', alignItems: centered ? 'center' : 'flex-start' }, lines.map((l) =>
      div({ fontFamily: SANS, fontWeight: 700, fontSize: size, lineHeight: `${lineH}px`, letterSpacing: size * 0.14, color: look.eyebrow, whiteSpace: 'pre' }, l.map((w) => w.map((p) => p.text).join('')).join(' ')))),
  ]);
}

function leadNode(lines: Word[][], st: TextStyle, color: string, italic: boolean, leading: number, centered = false): Node {
  return div({ flexDirection: 'column', alignItems: centered ? 'center' : 'flex-start' }, lines.map((l) =>
    div({ fontFamily: italic ? SERIF_ITALIC : SANS, fontStyle: italic ? 'italic' : 'normal', fontWeight: 400, fontSize: st.size, lineHeight: `${Math.round(st.size * leading)}px`, color, whiteSpace: 'pre' },
      l.map((w) => w.map((p) => p.text).join('')).join(' '))));
}

// A closed book's page edges along its fore-edge (flat colors)
const BOOK_EDGES = [1, 2, 3, 4, 5, 6].map((i) => `${i}px ${i}px 0 ${i % 2 ? '#E7E1D3' : '#FBF8F0'}`).join(', ');

// Split-layout geometry (the site hero's, scaled to the card)
const SPLIT = {
  padL: 72,
  photo: { w: 416, h: 520, right: 80, top: 46 },
  radius: 22,
  textW: 560,
};

async function splitCard(s: CardSpec, look: Look): Promise<{ tree: Node; whole: boolean } | null> {
  const whole = !!s.photo?.whole;
  const plan = photoPlan(s);
  if (!plan.main) return null;
  const P = plan.main;
  const [main, inset, mark] = await Promise.all([
    photoAt(plan.main),
    plan.inset ? photoAt(plan.inset) : Promise.resolve(null),
    logo(),
  ]);
  if (!main) return null;
  // Drawn without its small photo or the logo, it's still a card, but not the whole one: the next build draws it again
  const complete = (!plan.inset || !!inset) && !!mark;

  const titleBase = { face: (s.titleWeight === 400 ? 'serif400' : 'serif700') as FontKey, emFace: 'serifItalic' as FontKey, tracking: TITLE_TRACKING, emPad: EM_PAD };
  const { st, lines } = fitTitle(drawableTitle(parseTitle(s.title), titleBase.face), titleBase, SPLIT.textW, SPLIT_TIERS);
  // Four headline lines leave room for two of lead
  const { st: leadSt, lines: leadLines } = fitLead(drawable(s.lead || '', 'sans400'), s.leadParts?.map((t) => drawable(t, 'sans400')), { face: 'sans400', size: 25, tracking: 0 }, SPLIT.textW * SAFETY, lines.length >= 4 ? 2 : 3, true);
  const logoH = 74;
  const logoW = mark ? Math.round(logoH * mark.w / mark.h) : 0;

  const text = div({ position: 'absolute', left: SPLIT.padL, top: 112, bottom: 30, width: SPLIT.textW, flexDirection: 'column', justifyContent: 'center' }, [
    eyebrowNode(s.eyebrow || '', look, SPLIT.textW),
    div({ flexDirection: 'column', marginTop: s.eyebrow ? 22 : 0, fontFamily: SERIF, fontWeight: s.titleWeight === 400 ? 400 : 700, fontSize: st.size, letterSpacing: st.size * TITLE_TRACKING, color: look.ink }, lines.map((l) => titleLine(l, st, look, s.titleWeight === 400 ? 400 : 700, 0.52))),
    ...(leadLines.length ? [div({ marginTop: 22 }, leadNode(leadLines, leadSt, look.muted, false, 1.42))] : []),
  ].filter(Boolean));

  const tree = div({ width: OG_W, height: OG_H, position: 'relative', backgroundColor: look.paper }, [
    // The logo, top left, as on every page
    ...(mark ? [{ type: 'img', props: { src: mark.src, width: logoW, height: logoH, style: { position: 'absolute', left: SPLIT.padL - 4, top: 34 } } }] : []),
    text,
    // The pale block behind the photo's lower corner
    div({ position: 'absolute', left: P.left + P.w * 0.35 + 16, top: P.top + P.h * 0.5 + 16, width: P.w * 0.65, height: P.h * 0.5, borderRadius: 24, backgroundColor: look.accent }),
    { type: 'img', props: { src: main, width: P.w, height: P.h, style: { position: 'absolute', left: P.left, top: P.top, borderRadius: whole ? '3px 8px 8px 3px' : SPLIT.radius, boxShadow: whole ? `${BOOK_EDGES}, 0 28px 60px rgba(0,0,0,0.2)` : '0 30px 70px rgba(0,0,0,0.13), 0 8px 22px rgba(0,0,0,0.06)' } } },
    ...(inset && plan.inset ? [{ type: 'img', props: { src: inset, width: plan.inset.w, height: plan.inset.h, style: { position: 'absolute', left: plan.inset.left, top: plan.inset.top, borderRadius: SPLIT.radius, border: `4px solid ${look.paper}`, boxShadow: '0 4px 6px rgba(0,0,0,0.06), 0 12px 32px rgba(0,0,0,0.12)' } } }] : []),
  ]);
  return { tree, whole: complete };
}

async function textCard(s: CardSpec, look: Look): Promise<{ tree: Node; whole: boolean }> {
  const mark = await logo();
  const width = 960;
  const weight = s.titleWeight === 400 ? 400 : 700;
  const { st, lines } = fitTitle(drawableTitle(parseTitle(s.title), weight === 400 ? 'serif400' : 'serif700'), { face: weight === 400 ? 'serif400' : 'serif700', emFace: 'serifItalic', tracking: -0.025, emPad: EM_PAD }, width, TEXT_TIERS);
  const italic = !!s.leadItalic;
  const leadFace: FontKey = italic ? 'serifItalic' : 'sans400';
  const { st: leadSt, lines: leadLines } = fitLead(drawable(s.lead || '', leadFace), s.leadParts?.map((t) => drawable(t, leadFace)), { face: leadFace, size: 27, tracking: 0 }, 820 * SAFETY, lines.length >= 3 ? 2 : 3, true);
  const logoH = 92;
  const logoW = mark ? Math.round(logoH * mark.w / mark.h) : 0;
  const tree = div({ width: OG_W, height: OG_H, flexDirection: 'column', alignItems: 'center', justifyContent: 'center', backgroundColor: look.paper }, [
    ...(mark ? [{ type: 'img', props: { src: mark.src, width: logoW, height: logoH, style: { marginBottom: 34 } } }] : []),
    eyebrowNode(s.eyebrow || '', look, 900, true),
    div({ flexDirection: 'column', alignItems: 'center', marginTop: s.eyebrow ? 20 : 0, fontFamily: SERIF, fontWeight: weight, fontSize: st.size, letterSpacing: st.size * -0.025, color: look.ink }, lines.map((l) => titleLine(l, st, look, weight, 0.55))),
    ...(leadLines.length ? [div({ marginTop: 18 }, leadNode(leadLines, leadSt, look.muted, italic, 1.5, true))] : []),
    // The page hero's rule: a hairline with the yellow mark in its middle
    div({ position: 'relative', width: 560, height: 2, backgroundColor: '#E5E4E0', marginTop: 34, justifyContent: 'center' }, [
      div({ position: 'absolute', top: -1, width: 56, height: 4, borderRadius: 1, backgroundColor: '#FFDA24' }),
    ]),
  ].filter(Boolean));
  return { tree, whole: !!mark };
}

/**
 * Draws a card: a 1200×630 JPEG. `photo` is false when something it needs
 * didn't load (its photo, its small photo or the logo) and it was drawn
 * without it: still a card, stamped so the next build draws it again.
 */
export async function drawCard(spec: CardSpec): Promise<{ jpg: Buffer; photo: boolean }> {
  const s = normalize(spec);
  const look = s.look || SITE_LOOK;
  const split = s.layout === 'split' ? await splitCard(s, look) : null;
  const { tree, whole } = split || await textCard(s, look);
  const { data } = fonts();
  const svg = await satori(tree as any, {
    width: OG_W,
    height: OG_H,
    fonts: [
      { name: 'Serif', data: data.serif700, weight: 700, style: 'normal' },
      { name: 'Serif', data: data.serif400, weight: 400, style: 'normal' },
      { name: 'Serif Italic', data: data.serifItalic, weight: 400, style: 'italic' },
      { name: 'Sans', data: data.sans400, weight: 400, style: 'normal' },
      { name: 'Sans', data: data.sans700, weight: 700, style: 'normal' },
      // Extended Latin (Ł, Đ, ő…), for the letters the fonts above don't have
      { name: 'Serif Ext', data: data.serif700x, weight: 700, style: 'normal' },
      { name: 'Serif Ext', data: data.serif400x, weight: 400, style: 'normal' },
      { name: 'Serif Ext', data: data.serif400x, weight: 400, style: 'italic' },
      { name: 'Sans Ext', data: data.sans400x, weight: 400, style: 'normal' },
      { name: 'Sans Ext', data: data.sans700x, weight: 700, style: 'normal' },
    ],
  });
  const photo = whole && (s.layout !== 'split' || !!split);
  const jpg = await sharp(Buffer.from(svg))
    .flatten({ background: look.paper })
    // Its key inside it, so a build can tell a card it already has (src/integrations/og-cards.mjs)
    .withExif({ IFD0: { ImageDescription: stampFor(await cardKey(spec), photo) } })
    .jpeg({ quality: 86, chromaSubsampling: '4:4:4' })
    .toBuffer();
  return { jpg, photo };
}

export const renderCard = async (spec: CardSpec) => (await drawCard(spec)).jpg;

/** The stamp a card carries: its key, and whether everything made it in (a card drawn without something is drawn again) */
const stampFor = (key: string, photo: boolean) => `soard-share-card k=${key}${photo ? '' : ' no-photo'}`;
/** Whether a card's bytes are the card with this key, whole (photo and all) */
export async function hasStamp(jpg: Buffer, key: string): Promise<boolean> {
  try {
    const { exif } = await sharp(jpg).metadata();
    return !!exif && exif.includes(Buffer.from(stampFor(key, true))) && !exif.includes(Buffer.from(`${stampFor(key, true)} no-photo`));
  } catch { return false; }
}

/** A card's address version: its bytes' own fingerprint */
export const fingerprint = (jpg: Buffer) => crypto.createHash('sha256').update(jpg).digest('hex').slice(0, 10);

/** The card's alt text: what it says, and what its photo shows */
export function cardAlt(spec: CardSpec): string {
  const sentence = (t: string) => (t ? (/[.!?…]["”’]?$/.test(t) ? t : `${t}.`) : '');
  const head = [clean(spec.eyebrow || ''), clean(spec.title)].filter(Boolean).join(': ');
  const alt = clean(spec.photo?.alt || '');
  const photo = alt ? (/^(photo|picture|image)\b/i.test(alt) ? alt : `Photo: ${alt}`) : '';
  return [sentence(head), sentence(photo), 'Sunshine on a Ranney Day'].filter(Boolean).join(' ');
}

/** The layout decisions, as text, for the tests (tests/og-cards.test.mjs) */
const asText = (lines: Word[][]) => lines.map((l) => l.map(textOf).join(' '));
export const layoutForTests = {
  title(html: string, layout: 'split' | 'text' = 'split') {
    const base = { face: 'serif700' as FontKey, emFace: 'serifItalic' as FontKey, tracking: TITLE_TRACKING, emPad: EM_PAD };
    const { st, lines } = fitTitle(drawableTitle(parseTitle(html), 'serif700'), base, layout === 'split' ? SPLIT.textW : 960, layout === 'split' ? SPLIT_TIERS : TEXT_TIERS);
    return { size: st.size, lines: asText(lines), runs: lines.map(lineRuns) };
  },
  lead(text: string, parts?: string[]) {
    return asText(fitLead(text, parts, { face: 'sans400', size: 25, tracking: 0 }, SPLIT.textW * SAFETY, 3).lines);
  },
  eyebrow(text: string) {
    const st: TextStyle = { face: 'sans700', size: 16, tracking: 0.14 };
    return asText(eyebrowLines(wordsOf([{ text: text.toUpperCase(), em: false }]), st, (SPLIT.textW - 52) * SAFETY));
  },
};
