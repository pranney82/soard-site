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
import { drawPages, closeBrowser } from './_coi-backfill.js';
import { docxText } from '../../public/admin/board-shared.js';
import { readSheets, readSlides } from '../../public/admin/board/docs.js';

/**
 * This reader: 1 was the papers-only PDF reader (a scan came back empty); 2 read every kind, a scan's first pages by
 * Llama 4 Scout (51 s over a dense page, so a long scan never finished); 3 reads a scan's every page, a few a run
 */
export const READER = 3;
// Of Workers AI's vision models, the quickest to copy out a page word for word (18 s over a dense page, as
// GLM 5.3 Flash; Qwen 3.8 23 s; Llama 4 Scout 51 s; Gemma 4 thinks and says nothing)
const VISION_MODEL = '@cf/mistralai/mistral-small-3.1-24b-instruct';
// What's kept of one file (a 990 runs to 40 pages); what the board page gets of it to find in
export const KEEP = 120000;
export const SERVE = 60000;
const MAX_BYTES = 30 * 1024 * 1024;
// A scan's pages cut out as photos (all of a 990's); drawn ones are drawn again each run, so only the first few
const SCAN_PAGES = 40;
const DRAW_PAGES = 6;
// Pages the vision model reads at once
const GROUP = 4;
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
    }), Math.min(AI_TIMEOUT_MS, timeout));
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
 * model), 'none' (nothing to read: a photo, an old .doc), 'error' (it couldn't be read just then: try again later),
 * 'part' (a scan read up to page `next`, its pages so far in `words`, `read` true when this run read any of them)
 */
/**
 * `draw(bytes)`: a scan's pages as pictures when they aren't photos to cut out (by default Browser Rendering's,
 * `ctx` holding its browser for the run: ./_coi-backfill.js drawPages).
 * A scan under way: `from` the page to go on from (0: known to be a scan, none read yet), `prior` its pages so far,
 * `skip` to leave out the page at `from` (it couldn't be read twice); `deadline` (by `now`) when this run's time
 * ends, and `onPart(words, next)` keeps each group of pages as it's read.
 */
export async function wordsOf(env, { name = '', type = '', bytes }, { ctx = {}, draw = null, from = null, prior = '', skip = false, deadline = Infinity, now = Date.now, onPart = null } = {}) {
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
      // A scan: its pages' pictures, a group at a time (drawn, when they aren't photos inside it)
      let shots = scannedPages(bytes, { max: SCAN_PAGES });
      if (!shots.length) shots = await (draw ? draw(bytes) : drawPages(env, ctx, bytes, { max: DRAW_PAGES }));
      if (!shots.length) return { words, how: words ? 'text' : 'none' };
      const start = from || 0;
      const pages = String(prior || '').split('\f').slice(0, start);
      while (pages.length < start) pages.push('');
      let at = start;
      let read = false;
      // (a page that couldn't be read twice is left out)
      if (skip && at < shots.length) { pages.push(''); at++; read = true; }
      const kept = () => pages.map((p) => tidy([p])).join('\f');
      // (known now to be a scan: a run cut short goes on from its pictures, never converted again)
      if (from === null && onPart) await onPart('', 0, false);
      while (at < shots.length && left() >= PAGE_MIN_MS) {
        const had = left();
        const seen = await Promise.all(shots.slice(at, at + GROUP).map((p) => pictureWords(env, p, { timeout: had })));
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
        if (at < shots.length && onPart) await onPart(kept(), at, true);
      }
      if (at < shots.length) return { words: kept(), how: 'part', next: at, read };
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
      const seen = await pictureWords(env, { bytes, type: type || (/\.png$/.test(n) ? 'image/png' : 'image/jpeg') }, { timeout: left() });
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

const FILINGS = 'CREATE TABLE IF NOT EXISTS board_filing_words (key TEXT PRIMARY KEY, words TEXT, words_v INTEGER, at TEXT, words_next INTEGER, words_try INTEGER, words_at TEXT)';
const filingsReady = new WeakSet();
async function ensureFilings(DB) {
  if (filingsReady.has(DB)) return;
  await DB.prepare(FILINGS).run();
  await addColumns(DB, 'board_filing_words', { words_next: 'INTEGER', words_try: 'INTEGER', words_at: 'TEXT' });
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
  const had = new Map(((await DB.prepare('SELECT key, words, words_v, words_next, words_try FROM board_filing_words').all()).results || []).map((r) => [r.key, r]));
  return keys.map((key) => ({ key, words: null, words_v: 0, words_next: null, words_try: null, ...had.get(key) }))
    .filter((f) => (f.words_v || 0) < READER && (f.words_v || 0) > -3 && !(f.words_try >= heldBefore && heldBefore))
    .sort((a, b) => (a.words_next == null) - (b.words_next == null) || ((a.words_v || 0) < 0) - ((b.words_v || 0) < 0));
}

/**
 * One file read, as much of it as this run's time allows (`item.key` its id in `table`): held while it's read, its
 * try counted as it starts, a scan's pages kept as they're read → false when another run holds it
 */
async function readOne(env, item, { table, keyCol, bucket, deadline, now, ctx, draw }) {
  const DB = env.DB;
  const v0 = item.words_v || 0;
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
  const onPart = (words, next, read) => set(`words = ?, words_next = ?, words_try = ?${read ? ', words_v = 0, words_at = ?' : ''}`, String(words).slice(0, KEEP), next, now(), ...(read ? [at()] : []));
  let read = { words: '', how: 'none' };
  if ((item.size || 0) <= MAX_BYTES) {
    const obj = await bucket.get(item.r2_key);
    const bytes = obj && (obj.size || 0) <= MAX_BYTES ? new Uint8Array(await new Response(obj.body).arrayBuffer()) : null;
    if (bytes) read = await wordsOf(env, { name: item.name, type: item.type, bytes }, { ctx, draw, from: scanning ? item.words_next : null, prior: item.words || '', skip, deadline, now, onPart });
  }
  if (read.how === 'error') await set(`words_try = NULL, words_v = ?`, fair ? tryV : v0);
  else if (read.how === 'later') await set('words_try = NULL, words_v = ?', v0);
  else if (read.how === 'part') await set(`words = ?, words_next = ?, words_try = NULL, words_v = ?${read.read ? ', words_at = ?' : ''}`, String(read.words || '').slice(0, KEEP), read.next, read.read ? 0 : v0, ...(read.read ? [at()] : []));
  else await set('words = ?, words_v = ?, words_next = NULL, words_try = NULL, words_at = ?', String(read.words || '').slice(0, KEEP), READER, at());
  return true;
}

/**
 * Files not read yet by this reader, a few at a time: a scan under way first, then SOARD's papers, then the newest
 * meetings' files, then the public tax returns and audits. Stops taking more after `budgetMs`, and starts nothing
 * that can't end within `windowMs` (Cloudflare's time for it) → how many were read (a scan read in part counts)
 */
export async function readBoardWords(env, { limit = 6, budgetMs = 12000, now = Date.now, draw = null, windowMs = WINDOW_MS } = {}) {
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
      WHERE COALESCE(words_v, 0) < ? AND COALESCE(words_v, 0) > -3 AND owner_type IN ('meeting', 'doc') AND (words_try IS NULL OR words_try < ?)
      ORDER BY (words_next IS NULL), (COALESCE(words_v, 0) < 0), (owner_type = 'doc') DESC, at DESC LIMIT ?`).bind(READER, start - HOLD_MS, limit).all()).results || [];
    let done = 0;
    // (a file is started only with the time a page takes left, after the first only within budgetMs, and one that
    // couldn't be read before only first, so it has a run's whole time)
    const more = (v) => deadline - now() >= PAGE_MIN_MS && !(done && (now() - start > budgetMs || (v || 0) < 0));
    for (const r of rows) {
      if (!more(r.words_v)) break;
      if (await readOne(env, r, { table: 'board_files', keyCol: 'id', bucket, deadline, now, ctx, draw })) done++;
    }
    // Then the public filings, once every board file's read
    if (rows.length < limit && env.FILES) {
      for (const f of (await filingsToRead(env.DB, now() - HOLD_MS)).slice(0, limit - rows.length)) {
        if (!more(f.words_v)) break;
        await env.DB.prepare('INSERT OR IGNORE INTO board_filing_words (key, words_v, at) VALUES (?, 0, ?)').bind(f.key, new Date(now()).toISOString()).run();
        if (await readOne(env, { ...f, r2_key: f.key, name: f.key.split('/').pop(), type: 'application/pdf', size: 0 }, { table: 'board_filing_words', keyCol: 'key', bucket: env.FILES, deadline, now, ctx, draw })) done++;
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

/** How far the reading is: { files, read, withWords, failed, toRead, lastAt } (Site → Automations, and the tests) */
export async function wordsStatus(DB) {
  await ensureSchema(DB);
  const r = await DB.prepare(`SELECT COUNT(*) AS files, SUM(CASE WHEN COALESCE(words_v, 0) >= ? THEN 1 ELSE 0 END) AS read, SUM(CASE WHEN words IS NOT NULL AND words != '' THEN 1 ELSE 0 END) AS with_words,
    SUM(CASE WHEN COALESCE(words_v, 0) <= -3 THEN 1 ELSE 0 END) AS failed, MAX(words_at) AS last_at FROM board_files WHERE owner_type IN ('meeting', 'doc')`).bind(READER).first();
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
