/**
 * Every board file's words, for finding them on the board page
 * ============================================================
 * The board page's search (../../public/admin/board/find.js) finds a meeting's minutes, packet, statements and
 * agenda, and SOARD's papers, by what they say, the way a person reads them. Each file is read once, as it's
 * written:
 *   - a PDF by Workers AI's converter, page by page; a scan (pictures of its pages, no words) by those pictures,
 *     through Workers AI's vision model, its first pages: cut out as they are when they're photos (JPEG), else
 *     drawn by pdf.js in Cloudflare's Browser Rendering (a black-and-white fax-style scan), as W-9s are
 *     (./_coi-backfill.js drawPages)
 *   - Word, Excel and PowerPoint here, by the readers the board page draws them with (../../public/admin/board/docs.js)
 *   - a picture (a chart or a table pasted in as a PNG) by the vision model
 * The words go in board_files.words, a form feed between pages (the page a match is on opens at it), and
 * words_v says which reader read them: a newer reader reads them all again. A file that has no words (a photo,
 * an old .doc) keeps '' and isn't tried again by the same reader. One that couldn't be read just then (Workers AI
 * busy or down) is tried again after the others, three times at most (words_v -1, -2, -3). A member's own signed
 * copy is never read.
 *
 * SOARD's public tax returns and audits (Site → Financials, in the site's own bucket) are read the same way,
 * once each, into board_filing_words, after the board's own files.
 *
 * Read a few at a time, newest first (SOARD's papers before meetings), without anyone asking: each heartbeat
 * (./_board.js maybeRunBoard) and each visit to the board page (./board-portal.js) or Board (./board-admin.js).
 * Never throws.
 */
import { boardFiles, ensureSchema } from './_board.js';
import { pageText, scannedPages } from './_vendor-read.js';
import { drawPages, closeBrowser } from './_coi-backfill.js';
import { docxText } from '../../public/admin/board-shared.js';
import { readSheets, readSlides } from '../../public/admin/board/docs.js';

/** This reader: 1 was the papers-only PDF reader (a scan came back empty); 2 reads every kind, scans by their pictures */
export const READER = 2;
const VISION_MODEL = '@cf/meta/llama-4-scout-17b-16e-instruct';
// What's kept of one file (a 990 runs to 40 pages); what the board page gets of it to find in
export const KEEP = 120000;
export const SERVE = 60000;
const MAX_BYTES = 30 * 1024 * 1024;
const SCAN_PAGES = 8;
const DRAW_PAGES = 6;
const AI_TIMEOUT_MS = 40000;

const withTimeout = (p, ms) => {
  let timer;
  return Promise.race([p, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); })]).finally(() => clearTimeout(timer));
};
const toBase64 = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
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

/** A picture's words, as the vision model reads them ('' when it has none; null when it couldn't be read just then) */
export async function pictureWords(env, image) {
  if (!env.AI?.run) return '';
  try {
    const out = await withTimeout(env.AI.run(VISION_MODEL, {
      messages: [
        { role: 'system', content: 'You copy out the words on a page exactly as they are written, line by line, in reading order: headings, paragraphs, lists, each table row on its own line with its cells apart, numbers and dates as written, names spelled as they are. Copy only what is written; never describe the page, sum it up or add anything. A page with no words: answer with nothing.' },
        { role: 'user', content: [
          { type: 'text', text: 'Copy out the words on this page.' },
          { type: 'image_url', image_url: { url: `data:${image.type};base64,${toBase64(image.bytes)}` } },
        ] },
      ],
      max_tokens: 2500, temperature: 0,
    }), AI_TIMEOUT_MS);
    const r = out?.response ?? out?.choices?.[0]?.message?.content ?? '';
    const text = typeof r === 'string' ? r : '';
    // (a model that answers about the page instead of with it: nothing kept)
    return /^(i('m| am) (sorry|unable)|there (is|are) no (words|text)|the (image|page) (shows|contains|is))/i.test(text.trim()) ? '' : text.replace(/```[a-z]*\n?|```/g, '').trim();
  } catch (err) {
    console.error('[board-words] picture', err.message);
    return null;
  }
}

/**
 * One file's words → { words, how }: how 'text' (read as written), 'pictures' (a scan or a picture, by the vision
 * model), 'none' (nothing to read: a photo, an old .doc), 'error' (it couldn't be read just then: try again later)
 */
/**
 * `draw(bytes)`: a scan's pages as pictures when they aren't photos to cut out (by default Browser Rendering's,
 * `ctx` holding its browser for the run: ./_coi-backfill.js drawPages)
 */
export async function wordsOf(env, { name = '', type = '', bytes }, { ctx = {}, draw = null } = {}) {
  const n = String(name).toLowerCase();
  const kind = /\.pdf$/.test(n) || type === 'application/pdf' ? 'pdf'
    : /\.docx$/.test(n) ? 'word' : /\.(xlsx|xlsm)$/.test(n) ? 'excel' : /\.pptx$/.test(n) ? 'slides'
      : /^image\/(png|jpeg|webp)$/.test(type) || /\.(png|jpe?g|webp)$/.test(n) ? 'picture' : /\.(txt|csv|md)$/.test(n) ? 'plain' : '';
  try {
    if (kind === 'pdf') {
      let pages = [];
      if (env.AI?.toMarkdown) {
        const r = await withTimeout(env.AI.toMarkdown({ name: name || 'document.pdf', blob: new Blob([bytes], { type: 'application/pdf' }) }, { conversionOptions: { output: { format: 'text' } } }), AI_TIMEOUT_MS);
        const one = Array.isArray(r) ? r[0] : r;
        if (one?.format === 'error') return { words: '', how: 'error' };
        pages = pdfPages(one?.data);
      }
      const words = tidy(pages);
      if (words.replace(/\s+/g, '').length >= 40) return { words, how: 'text' };
      // A scan: its pages' pictures, read four at a time (drawn, when they aren't photos inside it)
      let shots = scannedPages(bytes, { max: SCAN_PAGES });
      if (!shots.length) shots = await (draw ? draw(bytes) : drawPages(env, ctx, bytes, { max: DRAW_PAGES }));
      const read = [];
      for (let i = 0; i < shots.length; i += 4) read.push(...(await Promise.all(shots.slice(i, i + 4).map((p) => pictureWords(env, p)))));
      if (read.some((x) => x === null)) return { words: '', how: 'error' };
      const seen = tidy(read);
      return seen ? { words: seen, how: 'pictures' } : { words: words || '', how: words ? 'text' : 'none' };
    }
    if (kind === 'word') return { words: tidy([await docxText(bytes)]), how: 'text' };
    if (kind === 'excel') return { words: tidy((await readSheets(bytes)).filter((s) => !s.hidden).map((s) => `${s.name}\n${linesOf(s.rows)}`)), how: 'text' };
    if (kind === 'slides') return { words: tidy((await readSlides(bytes)).slides.map((s) => linesOf(s.shapes))), how: 'text' };
    if (kind === 'plain') return { words: tidy([new TextDecoder().decode(bytes)]), how: 'text' };
    if (kind === 'picture') {
      const seen = await pictureWords(env, { bytes, type: type || (/\.png$/.test(n) ? 'image/png' : 'image/jpeg') });
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

const FILINGS = 'CREATE TABLE IF NOT EXISTS board_filing_words (key TEXT PRIMARY KEY, words TEXT, words_v INTEGER, at TEXT)';
const filingsReady = new WeakSet();
async function ensureFilings(DB) {
  if (filingsReady.has(DB)) return;
  await DB.prepare(FILINGS).run();
  filingsReady.add(DB);
}
/** A filing's url on the board page ("/files/financials/2025%20990.pdf") → its key in the site's bucket */
const filingKey = (url) => { const m = String(url || '').match(/^\/files\/(financials\/.+)$/); try { return m ? decodeURIComponent(m[1]) : ''; } catch { return ''; } };
async function filingsToRead(DB) {
  let doc = null;
  try { doc = JSON.parse((await DB.prepare("SELECT data FROM site_config WHERE key = 'financials'").first())?.data || 'null'); } catch { doc = null; }
  const keys = (doc?.documents || []).map((d) => filingKey(String(d.url || '').replace(/^https:\/\/files\.sunshineonaranneyday\.com\/financials\//, '/files/financials/'))).filter(Boolean);
  if (!keys.length) return [];
  await ensureFilings(DB);
  const done = new Map(((await DB.prepare('SELECT key, words_v FROM board_filing_words').all()).results || []).map((r) => [r.key, r.words_v]));
  return keys.filter((k) => { const v = done.get(k) ?? 0; return v < READER && v > -3; }).sort((a, b) => ((done.get(a) ?? 0) < 0) - ((done.get(b) ?? 0) < 0)).map((k) => ({ key: k, v: done.get(k) ?? 0 }));
}

/**
 * Files not read yet by this reader, a few at a time: SOARD's papers first, then the newest meetings' files, then
 * the public tax returns and audits. Stops taking more after `budgetMs` (a scan's pictures take seconds each).
 * → how many were read
 */
export async function readBoardWords(env, { limit = 6, budgetMs = 20000, now = Date.now, draw = null } = {}) {
  const ctx = {};
  try {
    if (!env?.DB) return 0;
    await ensureSchema(env.DB);
    const bucket = boardFiles(env);
    // (without Workers AI's converter a PDF can't be read: it waits, never kept as having no words)
    if (!bucket || !env.AI?.toMarkdown) return 0;
    const rows = (await env.DB.prepare(`SELECT id, r2_key, name, type, size, words_v FROM board_files WHERE COALESCE(words_v, 0) < ? AND COALESCE(words_v, 0) > -3 AND owner_type IN ('meeting', 'doc')
      ORDER BY (COALESCE(words_v, 0) < 0), (owner_type = 'doc') DESC, at DESC LIMIT ?`).bind(READER, limit).all()).results || [];
    const start = now();
    let done = 0;
    for (const r of rows) {
      if (done && now() - start > budgetMs) break;
      let read = { words: '', how: 'none' };
      if ((r.size || 0) <= MAX_BYTES) {
        const obj = await bucket.get(r.r2_key);
        const bytes = obj ? new Uint8Array(await new Response(obj.body).arrayBuffer()) : null;
        if (bytes) read = await wordsOf(env, { name: r.name, type: r.type, bytes }, { ctx, draw });
      }
      // (couldn't be read just then: once more later, after the others)
      if (read.how === 'error') await env.DB.prepare('UPDATE board_files SET words_v = ? WHERE id = ?').bind(Math.min(0, r.words_v || 0) - 1, r.id).run();
      else await env.DB.prepare('UPDATE board_files SET words = ?, words_v = ? WHERE id = ?').bind(String(read.words || '').slice(0, KEEP), READER, r.id).run();
      done++;
    }
    // Then the public filings, once every board file's read
    if (rows.length < limit && env.FILES) {
      for (const f of (await filingsToRead(env.DB)).slice(0, limit - rows.length)) {
        if (done && now() - start > budgetMs) break;
        const obj = await env.FILES.get(f.key);
        const bytes = obj && (obj.size || 0) <= MAX_BYTES ? new Uint8Array(await new Response(obj.body).arrayBuffer()) : null;
        const read = bytes ? await wordsOf(env, { name: f.key.split('/').pop(), type: 'application/pdf', bytes }, { ctx, draw }) : { words: '', how: 'none' };
        const v = read.how === 'error' ? Math.min(0, f.v) - 1 : READER;
        await env.DB.prepare('INSERT OR REPLACE INTO board_filing_words (key, words, words_v, at) VALUES (?, ?, ?, ?)').bind(f.key, read.how === 'error' ? null : String(read.words || '').slice(0, KEEP), v, new Date(now()).toISOString()).run();
        done++;
      }
    }
    return done;
  } catch (err) {
    console.error('[board-words]', err.message);
    return 0;
  } finally {
    await closeBrowser(ctx);
  }
}

/** How far the reading is: { files, read, withWords, failed, toRead } (Site → Automations, and the tests) */
export async function wordsStatus(DB) {
  await ensureSchema(DB);
  const r = await DB.prepare(`SELECT COUNT(*) AS files, SUM(CASE WHEN COALESCE(words_v, 0) >= ? THEN 1 ELSE 0 END) AS read, SUM(CASE WHEN words IS NOT NULL AND words != '' THEN 1 ELSE 0 END) AS with_words,
    SUM(CASE WHEN COALESCE(words_v, 0) <= -3 THEN 1 ELSE 0 END) AS failed FROM board_files WHERE owner_type IN ('meeting', 'doc')`).bind(READER).first();
  const files = r?.files || 0;
  // (and the public filings still to read)
  const filings = await filingsToRead(DB).catch(() => []);
  return { files, read: r?.read || 0, withWords: r?.with_words || 0, failed: r?.failed || 0, toRead: files - (r?.read || 0) - (r?.failed || 0) + filings.filter((f) => f.v >= 0).length };
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
  const r = await DB.prepare("SELECT COUNT(*) AS n FROM board_files WHERE COALESCE(words_v, 0) < ? AND COALESCE(words_v, 0) > -3 AND owner_type IN ('meeting', 'doc')").bind(READER).first();
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
