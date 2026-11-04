/**
 * Every board file's words, for finding them on the board page
 * ============================================================
 * The board page's search (../../public/admin/board/find.js) finds a meeting's minutes, packet, statements and
 * agenda, and SOARD's papers, by what they say, the way a person reads them. Each file is read once, as it's
 * written:
 *   - a PDF by Workers AI's converter, page by page; a scan (pictures of its pages, no words) by those pictures,
 *     through Workers AI's vision model, every page (up to 40): cut out as they are when they're photos (JPEG),
 *     else its first pages drawn by pdf.js in Cloudflare's Browser Rendering (a black-and-white fax-style scan), as
 *     W-9s are (./_coi-backfill.js drawPages)
 *   - Word, Excel and PowerPoint here, by the readers the board page draws them with (../../public/admin/board/docs.js)
 *   - a picture (a chart or a table pasted in as a PNG) by the vision model
 * The words go in board_files.words, a form feed between pages (the page a match is on opens at it), and
 * words_v says which reader read them: a newer reader reads them all again. A file that has no words (a photo,
 * an old .doc) keeps '' and isn't tried again by the same reader. A member's own signed copy is never read.
 *
 * Cloudflare gives this work about 30 seconds (it runs after the heartbeat or a visit has answered), and the vision
 * model takes up to 20 seconds over a page dense with words. So nothing is started that can't end in time, and a
 * scan is read a few pages a run: the pages read so far are kept (words, with words_next the page to go on from),
 * its next run goes on from there, and a scan under way comes before anything else. A try counts as it starts
 * (words_v -1, -2, -3), so one Cloudflare cuts short counts too: a file that couldn't be read is tried again after
 * the others, at the start of a run of its own, three times at most; a scan's page that couldn't be read twice is
 * left out and the rest read. Whoever is reading a file holds it (words_try) for a minute, so two runs at once
 * (the heartbeat and a visit) never read the same one.
 *
 * SOARD's public tax returns and audits (Site → Financials, in the site's own bucket) are read the same way,
 * once each, into board_filing_words, after the board's own files.
 *
 * Read a few at a time, newest first (SOARD's papers before meetings), without anyone asking: each heartbeat
 * (./_board.js maybeRunBoard, as it starts) and each visit to the board page (./board-portal.js) or Board
 * (./board-admin.js). Never throws.
 */
import { boardFiles, ensureSchema } from './_board.js';
import { addColumns } from './_board-sign.js';
import { pageText, scannedPages } from './_vendor-read.js';
import { closeBrowser } from './_coi-backfill.js';
import { SITE_ORIGIN } from './_broadcast-notify.js';
import { docxText } from '../../public/admin/board-shared.js';
import { readSheets, readSlides } from '../../public/admin/board/docs.js';

/**
 * This reader: 1 was the papers-only PDF reader (a scan came back empty); 2 read every kind, a scan's first pages by
 * Llama 4 Scout (51 s over a dense page, so a long scan never finished); 3 read a scan's every page, a few a run,
 * but kept one Cloudflare's browser couldn't draw just then as having no words; 4 tried that again, but Mistral saw
 * no words on the W-9's pictures; 5 had Llama 4 Scout look at a page Mistral sees nothing on, but read a 990 whose
 * pages were partly photos by those two pages only, and a screenshot of a table never in the time; 6 draws every page
 * of a scan that isn't all photos, and reads a page dense with words in strips at once
 */
export const READER = 6;
// Of Workers AI's vision models, the quickest to copy out a page word for word (18 s over a dense page, as
// GLM 5.3 Flash; Qwen 3.8 23 s; Llama 4 Scout 51 s; Gemma 4 thinks and says nothing)
const VISION_MODEL = '@cf/mistralai/mistral-small-3.1-24b-instruct';
// A second look at a page Mistral sees no words on
const SECOND_MODEL = '@cf/meta/llama-4-scout-17b-16e-instruct';
// What's kept of one file (a 990 runs to 40 pages); what the board page gets of it to find in
export const KEEP = 120000;
export const SERVE = 60000;
const MAX_BYTES = 30 * 1024 * 1024;
// A scan's pages read (all of a 990's), a group at a time; drawn as pdf.js draws them on the trade-partner page
const SCAN_PAGES = 40;
const GROUP = 4;
const PDF_BASE = '/trade-partners/pdf/';
const PAGE_SIDE = 2000;
// A picture this big (a screenshot of a table) is read in two strips at once, as every scan's page is: the vision
// model takes about a second a line, and a dense page has more lines than a run has seconds. One that still
// couldn't be read is read in three, then four
const BIG_PICTURE = 300 * 1024;
const AI_TIMEOUT_MS = 40000;
// A run's time (Cloudflare's 30 s, less a margin); what a page needs left to be started (a dense one takes ~20 s)
export const WINDOW_MS = 27000;
const PAGE_MIN_MS = 9000;
// A file that couldn't be read counts as a try only when it had this long (else it simply wasn't given the time)
const FAIR_MS = 20000;
// How long a run holds the file it's reading
const HOLD_MS = 60000;

const withTimeout = (p, ms) => {
  let timer;
  return Promise.race([p, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); })]).finally(() => clearTimeout(timer));
};
const toBase64 = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const fromBase64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
/** Lines kept, spaces in them tidied; pages apart by a form feed */
export const tidy = (pages) => pages.map((p) => String(p || '').split('\n').map((l) => l.replace(/[ \t ]+/g, ' ').trim()).filter(Boolean).join('\n')).join('\f').replace(/^\f+|\f+$/g, '');

/** toMarkdown's text of a PDF as its pages ("### Page 2" between them), its own framing left out (pageText) */
export function pdfPages(s) {
  const t = String(s || '');
  const parts = t.split(/^[#\s]*Page \d+\s*$/m);
  // (before "Page 1": the file's name and its Metadata block, never the PDF's words)
  const pages = parts.length > 1 ? parts.slice(1) : [pageText(t)];
  return pages.map((p) => p.replace(/\|/g, ' ').replace(/^#+\s*/gm, '').replace(/\*\*/g, '').replace(/^[-\s|:]+$/gm, ''));
}

/** Everything with words in a reader's result, in order: each `text`, a line apart where a paragraph, row or cell ends */
function textsOf(node, out = []) {
  // (a table's row of cells as words: a slide's, a Word table's)
  if (Array.isArray(node) && node.length && node.every((x) => typeof x === 'string')) { out.push(node.join(' '), '\n'); return out; }
  if (Array.isArray(node)) { for (const x of node) textsOf(x, out); return out; }
  if (!node || typeof node !== 'object') return out;
  if (typeof node.text === 'string' && node.text.trim()) out.push(node.text);
  for (const [k, v] of Object.entries(node)) if (k !== 'text' && v && typeof v === 'object') textsOf(v, out);
  if (node.runs || node.cells || node.paragraphs) out.push('\n');
  return out;
}
const linesOf = (node) => textsOf(node).join(' ').replace(/ ?\n ?/g, '\n');

/**
 * A picture's words, as the vision model reads them ('' when it has none; null when it couldn't be read just then,
 * or in the time given)
 */
export async function pictureWords(env, image, { timeout = AI_TIMEOUT_MS } = {}) {
  if (!env.AI?.run) return '';
  const url = `data:${image.type};base64,${toBase64(image.bytes)}`;
  const ask = async (model, ms) => {
    const out = await withTimeout(env.AI.run(model, {
      messages: [
        { role: 'system', content: 'You copy out the words on a page exactly as they are written, line by line, in reading order: headings, paragraphs, lists, each table row on its own line with its cells apart, numbers and dates as written, names spelled as they are. Copy only what is written; never describe the page, sum it up or add anything. A page with no words: answer with nothing.' },
        { role: 'user', content: [
          { type: 'text', text: 'Copy out the words on this page.' },
          { type: 'image_url', image_url: { url } },
        ] },
      ],
      max_tokens: 2500, temperature: 0,
    }), ms);
    const r = out?.response ?? out?.choices?.[0]?.message?.content ?? '';
    // (Workers AI hands back a reply that reads as JSON already parsed)
    const text = typeof r === 'string' ? r : r && typeof r === 'object' ? JSON.stringify(r) : '';
    // (a model that answers about the page instead of with it: nothing kept)
    return /^(i('m| am) (sorry|unable)|there (is|are) no (words|text)|the (image|page) (shows|contains|is))/i.test(text.trim()) ? '' : text.replace(/```[a-z]*\n?|```/g, '').trim();
  };
  const ends = Date.now() + Math.min(AI_TIMEOUT_MS, timeout);
  try {
    const seen = await ask(VISION_MODEL, ends - Date.now());
    if (seen) return seen;
    // Nothing on it, Mistral says: Llama 4 Scout looks too (it read the 2026 W-9's pictures, where Mistral saw no
    // words), and a page that's really blank is blank to both. Without the time for that look, it's read again later
    if (ends - Date.now() < 3000) return null;
    return await ask(SECOND_MODEL, ends - Date.now());
  } catch (err) {
    console.error('[board-words] picture', err.message);
    return null;
  }
}

// ─── Cloudflare's browser: a scan's pages drawn, a dense page cut in strips ──────────

/** The run's browser (ctx.launch: a local Puppeteer, for scripts and tests), opened once and let go at the end (closeBrowser) */
async function browserOf(env, ctx) {
  if (ctx.browser) return ctx.browser;
  if (!env.BROWSER && !ctx.launch) return null;
  const { default: puppeteer } = ctx.launch ? { default: null } : await import('@cloudflare/puppeteer');
  ctx.browser = ctx.launch ? await ctx.launch() : await puppeteer.launch(env.BROWSER, { keep_alive: 60000 });
  return ctx.browser;
}

/**
 * Pages `from` to `from + n - 1` (from 0) of a PDF as JPEGs, drawn by pdf.js on the site's own address as
 * ./_coi-backfill.js drawPages draws a W-9 → { pics, total } (total: its pages); null without a browser;
 * { failed } when the browser couldn't be had or draw it just then
 */
export async function drawRange(env, ctx, bytes, from, n) {
  let page = null;
  try {
    const browser = await browserOf(env, ctx);
    if (!browser) return null;
    page = await browser.newPage();
    // Only pdf.js runs here, on the site's own address
    await page.setBypassCSP(true).catch(() => {});
    await page.goto(`${SITE_ORIGIN}${PDF_BASE}pdf.js`, { waitUntil: 'domcontentloaded', timeout: 15000 });
    const got = await page.evaluate(async (data, base, first, count, side) => {
      const lib = await import(`${location.origin}${base}pdf.js`);
      lib.GlobalWorkerOptions.workerSrc = `${location.origin}${base}pdf.worker.js`;
      const task = lib.getDocument({ data: Uint8Array.from(atob(data), (c) => c.charCodeAt(0)), standardFontDataUrl: `${base}standard_fonts/`, wasmUrl: `${base}wasm/`, useWasm: false, enableXfa: false });
      const pics = [];
      try {
        const doc = await task.promise;
        for (let i = first + 1; i <= Math.min(first + count, doc.numPages); i++) {
          const p = await doc.getPage(i);
          const one = p.getViewport({ scale: 1 });
          const viewport = p.getViewport({ scale: side / Math.max(one.width, one.height) });
          const canvas = document.createElement('canvas');
          canvas.width = Math.round(viewport.width);
          canvas.height = Math.round(viewport.height);
          await p.render({ canvas, viewport, background: 'white', annotationMode: lib.AnnotationMode.ENABLE_STORAGE }).promise;
          pics.push(canvas.toDataURL('image/jpeg', 0.85).split(',')[1]);
        }
        return { pics, total: doc.numPages };
      } finally {
        task.destroy();
      }
    }, toBase64(bytes), PDF_BASE, from, n, PAGE_SIDE);
    return { pics: (got?.pics || []).map((p) => ({ bytes: fromBase64(p), type: 'image/jpeg' })), total: got?.total || 0 };
  } catch (err) {
    console.error('[board-words] drawing', err.message);
    return { pics: [], total: 0, failed: true };
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

/**
 * A picture as `n` strips, top to bottom, each running a little into the next (a line one cuts is whole in the
 * other) → [{ bytes, type }]; null when there's no browser or it couldn't cut it
 */
export async function stripsOf(env, ctx, image, n) {
  let page = null;
  try {
    const browser = await browserOf(env, ctx);
    if (!browser) return null;
    page = await browser.newPage();
    const strips = await page.evaluate(async (url, count, over) => {
      const img = new Image();
      img.src = url;
      await img.decode();
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      const scale = Math.min(1, 2000 / w);
      const out = [];
      for (let i = 0; i < count; i++) {
        const y0 = Math.max(0, Math.round((i * h) / count - h * over));
        const y1 = Math.min(h, Math.round(((i + 1) * h) / count + h * over));
        const c = document.createElement('canvas');
        c.width = Math.round(w * scale);
        c.height = Math.round((y1 - y0) * scale);
        const g = c.getContext('2d');
        g.fillStyle = '#fff';
        g.fillRect(0, 0, c.width, c.height);
        g.drawImage(img, 0, y0, w, y1 - y0, 0, 0, c.width, c.height);
        out.push(c.toDataURL('image/jpeg', 0.88).split(',')[1]);
      }
      return out;
    }, `data:${image.type};base64,${toBase64(image.bytes)}`, n, 0.05);
    return strips.map((p) => ({ bytes: fromBase64(p), type: 'image/jpeg' }));
  } catch (err) {
    console.error('[board-words] cutting', err.message);
    return null;
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

/** Strips' words as one page: a line both have where they meet kept once */
export function joinStrips(parts) {
  let all = [];
  for (const part of parts) {
    const lines = String(part || '').split('\n');
    const tail = new Set(all.slice(-8).map((l) => l.trim()).filter(Boolean));
    let k = 0;
    while (k < Math.min(8, lines.length) && (!lines[k].trim() || tail.has(lines[k].trim()))) k++;
    all = all.concat(lines.slice(k));
  }
  return all.join('\n').trim();
}

/** A PDF's pages, by its page objects (0 when they're packed where they can't be counted) */
function pageCount(bytes) {
  let n = 0;
  const find = /\/Type\s*\/Page\b/g;
  for (let i = 0; i < bytes.length; i += 0x100000) {
    // (a megabyte at a time, a little over so a word on the edge is seen once)
    const s = String.fromCharCode.apply(null, bytes.subarray(i, Math.min(bytes.length, i + 0x100000 + 16)));
    const cut = i + 0x100000 >= bytes.length ? s.length : 0x100000;
    for (let m; (m = find.exec(s));) if (m.index < cut) n++;
    find.lastIndex = 0;
  }
  return n;
}

/**
 * One page or picture read, in `split` strips at once when it's dense (`cut` stands in for the browser in
 * tests) → its words, '' when it has none, null when it couldn't be read in the time
 */
async function readPicture(env, ctx, image, { split = 1, left, cut = null }) {
  if (split > 1) {
    const strips = await (cut ? cut(image, split) : stripsOf(env, ctx, image, split));
    if (strips?.length) {
      const seen = await Promise.all(strips.map((s) => pictureWords(env, s, { timeout: left() })));
      return seen.some((x) => x === null) ? null : joinStrips(seen);
    }
    // (no browser to cut it with: read whole)
  }
  return pictureWords(env, image, { timeout: left() });
}

/**
 * One file's words → { words, how }: how 'text' (read as written), 'pictures' (a scan or a picture, by the vision
 * model), 'none' (nothing to read: a photo, an old .doc), 'error' (it couldn't be read just then: try again later),
 * 'later' (not started: too little of the run left), 'part' (a scan read up to page `next`, its pages so far in
 * `words`, `read` true when this run read any of them).
 * A scan's pages are its photos when every page is one, else drawn in Cloudflare's browser a group at a time
 * (`draw(bytes, { from, max })` stands in for it in tests: { pics, total }, or every page). A scan under way:
 * `from` the page to go on from (0: known to be a scan, none read yet), `prior` its pages so far, `skip` to leave out
 * the page at `from` (it couldn't be read twice); `tries` how many times it couldn't be read (its next page, or a
 * picture, is cut in more strips); `deadline` (by `now`) when this run's time ends; `onPart(words, next)` keeps
 * each group of pages as it's read (words null: known as a scan, nothing read yet).
 */
export async function wordsOf(env, { name = '', type = '', bytes }, { ctx = {}, draw = null, cut = null, from = null, prior = '', skip = false, tries = 0, deadline = Infinity, now = Date.now, onPart = null } = {}) {
  const n = String(name).toLowerCase();
  const kind = /\.pdf$/.test(n) || type === 'application/pdf' ? 'pdf'
    : /\.docx$/.test(n) ? 'word' : /\.(xlsx|xlsm)$/.test(n) ? 'excel' : /\.pptx$/.test(n) ? 'slides'
      : /^image\/(png|jpeg|webp)$/.test(type) || /\.(png|jpe?g|webp)$/.test(n) ? 'picture' : /\.(txt|csv|md)$/.test(n) ? 'plain' : '';
  const left = () => deadline - now();
  try {
    if (kind === 'pdf') {
      let words = '';
      // (a scan under way isn't converted again)
      if (from === null && env.AI?.toMarkdown) {
        const r = await withTimeout(env.AI.toMarkdown({ name: name || 'document.pdf', blob: new Blob([bytes], { type: 'application/pdf' }) }, { conversionOptions: { output: { format: 'text' } } }), Math.max(1000, Math.min(AI_TIMEOUT_MS, left())));
        const one = Array.isArray(r) ? r[0] : r;
        if (one?.format === 'error') return { words: '', how: 'error' };
        words = tidy(pdfPages(one?.data));
        if (words.replace(/\s+/g, '').length >= 40) return { words, how: 'text' };
      }
      // A scan: its pages' pictures, a group at a time. Its photos only when every page is one (a 990 with two
      // pages as photos and the rest otherwise is drawn, every page)
      const photos = scannedPages(bytes, { max: SCAN_PAGES });
      const counted = photos.length ? pageCount(bytes) : 0;
      const asPhotos = photos.length > 0 && (!counted || photos.length >= counted);
      const groupAt = async (at) => {
        if (asPhotos) return { at, pics: photos.slice(at, at + GROUP), total: photos.length };
        const max = Math.min(GROUP, SCAN_PAGES - at);
        const d = draw ? await draw(bytes, { from: at, max }) : await drawRange(env, ctx, bytes, at, max);
        if (!d) return null;
        return Array.isArray(d) ? { at, pics: d.slice(at, at + max), total: d.length } : { at, ...d };
      };
      const start = from || 0;
      let group = await groupAt(start);
      // (Cloudflare's browser couldn't be had or draw it just then, as when the site's other work has it: tried
      // again later, never kept as having no words)
      if (group?.failed) return { words: '', how: 'error' };
      const total = Math.min(group?.total || 0, SCAN_PAGES);
      if (!total) return { words, how: words ? 'text' : 'none' };
      const pages = String(prior || '').split('\f').slice(0, start);
      while (pages.length < start) pages.push('');
      let at = start;
      let read = false;
      // (a page that couldn't be read twice is left out)
      if (skip && at < total) { pages.push(''); at++; read = true; }
      const kept = () => pages.map((p) => tidy([p])).join('\f');
      // (known now to be a scan: a run cut short goes on from its pictures, never converted again)
      if (from === null && onPart) await onPart(null, 0, false);
      while (at < total && left() >= PAGE_MIN_MS) {
        if (group.at !== at) {
          group = await groupAt(at);
          if (!group || group.failed || !group.pics.length) { if (!read) return { words: kept(), how: 'error', next: at }; break; }
        }
        const had = left();
        // (every page in two strips at once; the one that couldn't be read last time in three)
        const seen = await Promise.all(group.pics.slice(0, total - at).map((p, i) => readPicture(env, ctx, p, { split: i === 0 && tries > 0 && !skip ? 3 : 2, left, cut })));
        // The pages read, up to the first that couldn't be (it's first next time)
        const ok = seen.findIndex((x) => x === null);
        const got = ok < 0 ? seen : seen.slice(0, ok);
        pages.push(...got);
        at += got.length;
        if (got.length) read = true;
        if (ok >= 0) {
          // (a page that couldn't be read in a run's whole time is a try; one started late simply goes first next run)
          if (!read) return had >= FAIR_MS ? { words: kept(), how: 'error', next: at } : { words: kept(), how: 'part', next: at, read: false };
          break;
        }
        if (at < total && onPart) await onPart(kept(), at, true);
      }
      if (at < total) return { words: kept(), how: 'part', next: at, read };
      const all = tidy(pages);
      return all ? { words: all, how: 'pictures' } : { words: words || '', how: words ? 'text' : 'none' };
    }
    if (kind === 'word') return { words: tidy([await docxText(bytes)]), how: 'text' };
    if (kind === 'excel') return { words: tidy((await readSheets(bytes)).filter((s) => !s.hidden).map((s) => `${s.name}\n${linesOf(s.rows)}`)), how: 'text' };
    if (kind === 'slides') return { words: tidy((await readSlides(bytes)).slides.map((s) => linesOf(s.shapes))), how: 'text' };
    if (kind === 'plain') return { words: tidy([new TextDecoder().decode(bytes)]), how: 'text' };
    if (kind === 'picture') {
      // (not started without the time a page takes)
      if (left() < PAGE_MIN_MS) return { words: '', how: 'later' };
      const split = tries > 0 ? Math.min(4, 2 + tries) : bytes.length > BIG_PICTURE ? 2 : 1;
      const seen = await readPicture(env, ctx, { bytes, type: type || (/\.png$/.test(n) ? 'image/png' : 'image/jpeg') }, { split, left, cut });
      if (seen === null) return { words: '', how: 'error' };
      const words = tidy([seen]);
      return { words, how: words ? 'pictures' : 'none' };
    }
  } catch (err) {
    console.error('[board-words] reading', name, err.message);
    return { words: '', how: 'error' };
  }
  return { words: '', how: 'none' };
}

const FILINGS = 'CREATE TABLE IF NOT EXISTS board_filing_words (key TEXT PRIMARY KEY, words TEXT, words_v INTEGER, at TEXT, words_next INTEGER, words_try INTEGER, words_at TEXT, words_fail INTEGER)';
const filingsReady = new WeakSet();
async function ensureFilings(DB) {
  if (filingsReady.has(DB)) return;
  await DB.prepare(FILINGS).run();
  await addColumns(DB, 'board_filing_words', { words_next: 'INTEGER', words_try: 'INTEGER', words_at: 'TEXT', words_fail: 'INTEGER' });
  filingsReady.add(DB);
}
/** A filing's url on the board page ("/files/financials/2025%20990.pdf") → its key in the site's bucket */
const filingKey = (url) => { const m = String(url || '').match(/^\/files\/(financials\/.+)$/); try { return m ? decodeURIComponent(m[1]) : ''; } catch { return ''; } };
/** The filings this reader hasn't read: a scan under way first, one that couldn't be read last; none held by another run since `heldBefore` */
async function filingsToRead(DB, heldBefore = 0) {
  let doc = null;
  try { doc = JSON.parse((await DB.prepare("SELECT data FROM site_config WHERE key = 'financials'").first())?.data || 'null'); } catch { doc = null; }
  const keys = [...new Set((doc?.documents || []).map((d) => filingKey(String(d.url || '').replace(/^https:\/\/files\.sunshineonaranneyday\.com\/financials\//, '/files/financials/'))).filter(Boolean))];
  if (!keys.length) return [];
  await ensureFilings(DB);
  const had = new Map(((await DB.prepare('SELECT key, words, words_v, words_next, words_try, words_fail FROM board_filing_words').all()).results || []).map((r) => [r.key, r]));
  return keys.map((key) => ({ key, words: null, words_v: 0, words_next: null, words_try: null, ...had.get(key) }))
    .filter((f) => (f.words_v || 0) < READER && ((f.words_v || 0) > -3 || (f.words_fail || 0) < READER) && !(f.words_try >= heldBefore && heldBefore))
    .sort((a, b) => (a.words_next == null) - (b.words_next == null) || ((a.words_v || 0) < 0) - ((b.words_v || 0) < 0));
}

/**
 * One file read, as much of it as this run's time allows (`item.key` its id in `table`): held while it's read, its
 * try counted as it starts, a scan's pages kept as they're read → false when another run holds it
 */
async function readOne(env, item, { table, keyCol, bucket, deadline, now, ctx, draw, cut }) {
  const DB = env.DB;
  // (one an older reader gave up on is tried afresh: three times by this one)
  const v0 = (item.words_v || 0) <= -3 ? 0 : item.words_v || 0;
  const scanning = item.words_next !== null && item.words_next !== undefined;
  // (a scan's page that couldn't be read twice is left out, and the count starts again)
  const skip = scanning && v0 <= -2;
  const tryV = skip ? -1 : Math.min(0, v0) - 1;
  const t = now();
  const claimed = await DB.prepare(`UPDATE ${table} SET words_v = ?, words_try = ? WHERE ${keyCol} = ? AND (words_try IS NULL OR words_try < ?)`).bind(tryV, t, item.key, t - HOLD_MS).run();
  if (!claimed?.meta?.changes) return false;
  // (cut short without the time a page takes: not a try)
  const fair = deadline - t >= FAIR_MS;
  const set = (cols, ...args) => DB.prepare(`UPDATE ${table} SET ${cols} WHERE ${keyCol} = ?`).bind(...args, item.key).run();
  const at = () => new Date(now()).toISOString();
  const onPart = (words, next, read) => (words === null ? set('words_next = ?, words_try = ?', next, now())
    : set(`words = ?, words_next = ?, words_try = ?${read ? ', words_v = 0, words_at = ?' : ''}`, String(words).slice(0, KEEP), next, now(), ...(read ? [at()] : [])));
  let read = { words: '', how: 'none' };
  if ((item.size || 0) <= MAX_BYTES) {
    const obj = await bucket.get(item.r2_key);
    const bytes = obj && (obj.size || 0) <= MAX_BYTES ? new Uint8Array(await new Response(obj.body).arrayBuffer()) : null;
    if (bytes) read = await wordsOf(env, { name: item.name, type: item.type, bytes }, { ctx, draw, cut, from: scanning ? item.words_next : null, prior: item.words || '', skip, tries: skip ? 0 : -v0, deadline, now, onPart });
  }
  if (read.how === 'error') await set('words_try = NULL, words_v = ?, words_fail = ?', fair ? tryV : v0, READER);
  else if (read.how === 'later') await set('words_try = NULL, words_v = ?', v0);
  else if (read.how === 'part') await set(`words = ?, words_next = ?, words_try = NULL, words_v = ?${read.read ? ', words_at = ?' : ''}`, String(read.words || '').slice(0, KEEP), read.next, read.read ? 0 : v0, ...(read.read ? [at()] : []));
  else await set('words = ?, words_v = ?, words_next = NULL, words_try = NULL, words_at = ?', String(read.words || '').slice(0, KEEP), READER, at());
  return true;
}

/**
 * Files not read yet by this reader, a few at a time: a scan under way first, then a file nobody can find by its
 * words yet before one read again by a newer reader, SOARD's papers before the newest meetings' files; the public
 * tax returns and audits after them, or one each run while the board's files are only being read again. Stops
 * taking more after `budgetMs`, and starts nothing that can't end within `windowMs` (Cloudflare's time for it)
 * → how many were read (a scan read in part counts)
 */
export async function readBoardWords(env, { limit = 6, budgetMs = 12000, now = Date.now, draw = null, cut = null, windowMs = WINDOW_MS } = {}) {
  const ctx = {};
  try {
    if (!env?.DB) return 0;
    await ensureSchema(env.DB);
    const bucket = boardFiles(env);
    // (without Workers AI's converter a PDF can't be read: it waits, never kept as having no words)
    if (!bucket || !env.AI?.toMarkdown) return 0;
    const start = now();
    const deadline = start + windowMs;
    const rows = (await env.DB.prepare(`SELECT id AS key, r2_key, name, type, size, words, words_v, words_next FROM board_files
      WHERE COALESCE(words_v, 0) < ? AND (COALESCE(words_v, 0) > -3 OR COALESCE(words_fail, 0) < ?) AND owner_type IN ('meeting', 'doc') AND (words_try IS NULL OR words_try < ?)
      ORDER BY (words_next IS NULL), (COALESCE(words_v, 0) < 0), (words IS NOT NULL AND words != ''), (owner_type = 'doc') DESC, at DESC LIMIT ?`).bind(READER, READER, start - HOLD_MS, limit).all()).results || [];
    let done = 0;
    // (a file is started only with the time a page takes left, after the first only within budgetMs, and one that
    // couldn't be read before only first, so it has a run's whole time)
    const more = (v) => deadline - now() >= PAGE_MIN_MS && !(done && (now() - start > budgetMs || (v || 0) < 0));
    const filings = async (n) => {
      if (!env.FILES || n < 1) return;
      for (const f of (await filingsToRead(env.DB, now() - HOLD_MS)).slice(0, n)) {
        if (!more(f.words_v)) break;
        await env.DB.prepare('INSERT OR IGNORE INTO board_filing_words (key, words_v, at) VALUES (?, 0, ?)').bind(f.key, new Date(now()).toISOString()).run();
        if (await readOne(env, { ...f, r2_key: f.key, name: f.key.split('/').pop(), type: 'application/pdf', size: 0 }, { table: 'board_filing_words', keyCol: 'key', bucket: env.FILES, deadline, now, ctx, draw, cut })) done++;
      }
    };
    // (the board's files only being read again, by a newer reader: a filing first, so they aren't kept waiting)
    const again = !rows.length || (rows[0].words && rows[0].words_next == null);
    if (again) await filings(1);
    for (const r of rows) {
      if (!more(r.words_v)) break;
      if (await readOne(env, r, { table: 'board_files', keyCol: 'id', bucket, deadline, now, ctx, draw, cut })) done++;
    }
    // Then the public filings, once every board file's read
    if (rows.length < limit) await filings(limit - rows.length);
    return done;
  } catch (err) {
    console.error('[board-words]', err.message);
    return 0;
  } finally {
    await closeBrowser(ctx);
  }
}

/** How far the reading is: { files, read, withWords, failed, toRead, lastAt } (Site → Automations, and the tests) */
export async function wordsStatus(DB) {
  await ensureSchema(DB);
  const r = await DB.prepare(`SELECT COUNT(*) AS files, SUM(CASE WHEN COALESCE(words_v, 0) >= ? THEN 1 ELSE 0 END) AS read, SUM(CASE WHEN words IS NOT NULL AND words != '' THEN 1 ELSE 0 END) AS with_words,
    SUM(CASE WHEN COALESCE(words_v, 0) <= -3 AND COALESCE(words_fail, 0) >= ? THEN 1 ELSE 0 END) AS failed, MAX(words_at) AS last_at FROM board_files WHERE owner_type IN ('meeting', 'doc')`).bind(READER, READER).first();
  const files = r?.files || 0;
  // (and the public filings still to read)
  const filings = await filingsToRead(DB).catch(() => []);
  return { files, read: r?.read || 0, withWords: r?.with_words || 0, failed: r?.failed || 0, toRead: files - (r?.read || 0) - (r?.failed || 0) + filings.filter((f) => (f.words_v || 0) >= 0).length, lastAt: r?.last_at || null };
}

/** Words of the public filings given (their urls on the board page) → { [url]: words } */
export async function filingWordsFor(DB, urls) {
  const keyed = urls.map((u) => [u, filingKey(u)]).filter(([, k]) => k);
  if (!keyed.length) return {};
  await ensureFilings(DB);
  const rows = new Map(((await DB.prepare("SELECT key, words FROM board_filing_words WHERE words IS NOT NULL AND words != ''").all()).results || []).map((r) => [r.key, r.words]));
  const out = {};
  for (const [u, k] of keyed) if (rows.has(k)) out[u] = rows.get(k).slice(0, SERVE);
  return out;
}

/** How many board files are still to be read (the page asks for the words again sooner while there are some) */
export async function stillToRead(DB) {
  const r = await DB.prepare("SELECT COUNT(*) AS n FROM board_files WHERE COALESCE(words_v, 0) < ? AND (COALESCE(words_v, 0) > -3 OR COALESCE(words_fail, 0) < ?) AND owner_type IN ('meeting', 'doc')").bind(READER, READER).first();
  return r?.n || 0;
}

/** Words of the files given (ids the viewer can see) → { [id]: words }, each cut to what the page finds in */
export async function wordsFor(DB, ids) {
  const out = {};
  const list = [...new Set(ids.filter(Boolean))];
  for (let i = 0; i < list.length; i += 90) {
    const part = list.slice(i, i + 90);
    const rows = (await DB.prepare(`SELECT id, words FROM board_files WHERE id IN (${part.map(() => '?').join(',')}) AND words IS NOT NULL AND words != ''`).bind(...part).all()).results || [];
    for (const r of rows) out[r.id] = r.words.length > SERVE ? r.words.slice(0, SERVE) : r.words;
  }
  return out;
}
