/**
 * The anniversary book: the reader's arithmetic (src/components/book/book-layout.js),
 * reading the PDF (public/admin/book-process.js, the parts with no browser in
 * them) and keeping its files (functions/api/book-admin.js, on an R2 in memory).
 * scripts/test-book.mjs drives the admin and the reader in a real browser.
 * Run: node --test tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  spreadsOf, spreadOfPage, pagesOf, pageLabel, sheetFor, chooseTwoUp, fitBook, spreadOffset, clampCorner, cornerArc,
  foldOf, turnProgress, curlRadius, turnPath, bezier, pageSrc, widthFor, searchPages, hitBoxes, pageFromSearch, fold,
} from '../src/components/book/book-layout.js';
import { planPages, pixelSize, pageBox, pageName, paragraphs, unspace, wordsOf, cleanLink, chaptersFrom, bookPageOf } from '../public/admin/book-process.js';
import { onRequestPost as bookAdmin, pdfName, pdfKey, looksLikePdf } from '../functions/api/book-admin.js';
import { isSiteDocKey } from '../functions/api/_collections.js';
import { createR2 } from './lib/r2-shim.mjs';

// ─── Spreads ───────────────────────────────────────────────────────

test('two up: the cover alone on the right, pairs, the back cover alone on the left when the count is even', () => {
  assert.deepEqual(spreadsOf(1, true), [{ left: null, right: 0 }]);
  assert.deepEqual(spreadsOf(2, true), [{ left: null, right: 0 }, { left: 1, right: null }]);
  assert.deepEqual(spreadsOf(5, true), [{ left: null, right: 0 }, { left: 1, right: 2 }, { left: 3, right: 4 }]);
  const s24 = spreadsOf(24, true);
  assert.equal(s24.length, 13);
  assert.deepEqual(s24[12], { left: 23, right: null });
  assert.deepEqual(spreadsOf(3, false), [{ left: null, right: 0 }, { left: null, right: 1 }, { left: null, right: 2 }]);
  assert.deepEqual(spreadsOf(0, true), []);
  // Every page is in exactly one spread
  for (const n of [1, 2, 7, 24, 25]) for (const two of [true, false]) {
    const seen = spreadsOf(n, two).flatMap(pagesOf).sort((a, b) => a - b);
    assert.deepEqual(seen, Array.from({ length: n }, (_, i) => i), `${n} ${two}`);
  }
});

test('the spread a page is in, and what people read', () => {
  for (const n of [5, 24, 25]) {
    const sp = spreadsOf(n, true);
    for (let p = 0; p < n; p++) assert.ok(pagesOf(sp[spreadOfPage(p, true, n)]).includes(p), `page ${p} of ${n}`);
  }
  assert.equal(spreadOfPage(99, true, 24), 12);
  assert.equal(spreadOfPage(-3, false, 24), 0);
  assert.equal(pageLabel({ left: 3, right: 4 }, 24), 'Pages 4–5 of 24');
  assert.equal(pageLabel({ left: null, right: 0 }, 24), 'Page 1 of 24');
});

test('the sheet that turns, forward, back (the left page, mirrored), and a jump of many pages', () => {
  const sp = spreadsOf(24, true);
  assert.deepEqual(sheetFor(sp, 0, 1, true), { forward: true, mirror: false, front: 0, back: 1, under: 2, beside: null });
  // Back, two up: the left page (5) lifts and turns over to the right; its back is 4, page 3 is uncovered, 6 stays
  assert.deepEqual(sheetFor(sp, 3, 2, true), { forward: false, mirror: true, front: 5, back: 4, under: 3, beside: 6 });
  // A jump is one sheet: what's showing now on its front, where it lands on its back
  assert.deepEqual(sheetFor(sp, 1, 7, true), { forward: true, mirror: false, front: 2, back: 13, under: 14, beside: 1 });
  assert.deepEqual(sheetFor(sp, 7, 1, true), { forward: false, mirror: true, front: 13, back: 2, under: 1, beside: 14 });
  // The back cover alone: nothing under the last sheet; back from it, nothing beside it
  assert.equal(sheetFor(sp, 11, 12, true).under, null);
  assert.equal(sheetFor(sp, 12, 11, true).beside, null);
  // One page at a time: the back is paper (see-through); back plays the earlier page's forward turn in reverse
  assert.deepEqual(sheetFor(spreadsOf(24, false), 4, 5, false), { forward: true, mirror: false, front: 4, back: null, under: 5, beside: null });
  assert.deepEqual(sheetFor(spreadsOf(24, false), 5, 4, false), { forward: false, mirror: false, front: 4, back: null, under: 5, beside: null });
  assert.equal(sheetFor(sp, 2, 2, true), null);
});

// ─── Fitting ───────────────────────────────────────────────────────

test('a spread when it keeps the pages big enough, one page on a phone', () => {
  assert.equal(chooseTwoUp(1260, 700, 8.5 / 11), true);
  assert.equal(chooseTwoUp(366, 600, 8.5 / 11), false);
  assert.equal(chooseTwoUp(700, 900, 8.5 / 11), false); // iPad portrait-ish: one big page
  assert.equal(chooseTwoUp(1100, 640, 11 / 8.5), true); // a landscape book still opens flat on a laptop
  assert.equal(chooseTwoUp(0, 0, 1), false);
  const f = fitBook({ spaceW: 1440, spaceH: 700, aspect: 0.75, twoUp: true, padX: 90, padY: 30 });
  assert.equal(f.H, Math.floor(f.W / 0.75));
  assert.ok(f.H <= 640 && 2 * f.W <= 1260);
  assert.equal(f.spineX, 720);
  assert.equal(spreadOffset({ left: null, right: 0 }, 400, true), -200);
  assert.equal(spreadOffset({ left: 23, right: null }, 400, true), 200);
  assert.equal(spreadOffset({ left: 3, right: 4 }, 400, true), 0);
  assert.equal(spreadOffset({ left: null, right: 3 }, 400, false), 0);
});

// ─── The fold ──────────────────────────────────────────────────────

test('cornerArc: the corner lands where it was put, on the curl and past it', () => {
  for (const R of [0, 5, 30, 80]) {
    for (const D of [0.5, 3, 20, 60, 150, 400, 900]) {
      const e = cornerArc(D, R);
      const shown = R === 0 ? 2 * e : e <= Math.PI * R ? e - R * Math.sin(e / R) : 2 * e - Math.PI * R;
      assert.ok(Math.abs(shown - D) < 1e-3, `R=${R} D=${D}: ${shown}`);
    }
  }
  assert.equal(cornerArc(0, 10), 0);
});

test('foldOf: the corner shows under the pointer, and the paper never folds across the spine', () => {
  const W = 480, H = 620;
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 2000; i++) {
    const from = { x: W, y: rand() < 0.5 ? 0 : H };
    const at = clampCorner({ W, H, from, at: { x: -W * 1.6 + rand() * W * 3.2, y: -H * 0.6 + rand() * H * 2.2 } });
    const p = turnProgress(W, at);
    const f = foldOf({ W, H, from, at, R: curlRadius(W, p, rand() < 0.2) });
    if (f.still) continue;
    // Where the corner shows: from, moved back along n by e − (its offset round the curl)
    const e = (from.x - f.ax) * f.nx + (from.y - f.ay) * f.ny;
    const off = f.R === 0 ? -e : e <= Math.PI * f.R ? f.R * Math.sin(e / f.R) : -(e - Math.PI * f.R);
    const shown = { x: from.x - (e - off) * f.nx, y: from.y - (e - off) * f.ny };
    assert.ok(Math.hypot(shown.x - at.x, shown.y - at.y) < 0.05, `corner at ${JSON.stringify(at)} shows at ${JSON.stringify(shown)}`);
    for (const s of [{ x: 0, y: 0 }, { x: 0, y: H }]) {
      assert.ok((s.x - f.ax) * f.nx + (s.y - f.ay) * f.ny <= 0.5, `spine end ${s.y} past the fold for ${JSON.stringify(at)} R=${f.R}`);
    }
  }
});

test('the corner stays within the page’s reach of the spine', () => {
  const W = 400, H = 500;
  const c = clampCorner({ W, H, from: { x: W, y: H }, at: { x: 2000, y: 3000 } });
  assert.ok(Math.hypot(c.x, c.y - H) <= W + 1e-6);
  assert.ok(Math.hypot(c.x, c.y) <= Math.hypot(W, H) + 1e-6);
  const inside = clampCorner({ W, H, from: { x: W, y: H }, at: { x: 100, y: 450 } });
  assert.deepEqual(inside, { x: 100, y: 450 });
});

test('the paper bends most mid-turn and lies flat at both ends; a turn played for you rises and comes back down', () => {
  assert.equal(curlRadius(400, 0), 0);
  assert.ok(curlRadius(400, 1) < 1e-6);
  assert.ok(curlRadius(400, 0.5) > curlRadius(400, 0.1));
  assert.ok(curlRadius(400, 0.5, true) > curlRadius(400, 0.5));
  assert.equal(turnProgress(400, { x: 400 }), 0);
  assert.equal(turnProgress(400, { x: -400 }), 1);
  assert.deepEqual(turnPath(400, 600, 0, 600), { x: 400, y: 600 });
  const mid = turnPath(400, 600, 0.5, 600);
  assert.ok(Math.abs(mid.x) < 1e-9 && mid.y < 600);
  assert.ok(Math.abs(turnPath(400, 600, 1, 600).x + 400) < 1e-9);
});

test('bezier easing: ends pinned, never runs backward', () => {
  const ease = bezier(0.3, 0.1, 0.2, 1);
  assert.equal(ease(0), 0);
  assert.equal(ease(1), 1);
  let last = 0;
  for (let x = 0.01; x < 1; x += 0.01) { const y = ease(x); assert.ok(y >= last - 1e-9); last = y; }
  assert.ok(Math.abs(bezier(0, 0, 1, 1)(0.37) - 0.37) < 1e-3);
});

// ─── Pictures and addresses ────────────────────────────────────────

test('page pictures: a few widths, never wider than the upload, the site’s own image address', () => {
  assert.equal(widthFor(900), 1000);
  assert.equal(widthFor(9000), 3600);
  const page = { id: 'book/abc123/p001', w: 2165, h: 2800 };
  assert.equal(pageSrc(page, 700), 'https://sunshineonaranneyday.com/cdn-cgi/imagedelivery/ROYFuPmfN2vPS6mt5sCkZQ/book/abc123/p001/w=800,q=85');
  assert.match(pageSrc(page, 2900), /\/w=2165,q=85$/);
  assert.equal(pageSrc({ id: 'x', src: 'http://localhost/p.jpg?w={w}', w: 1000 }, 300), 'http://localhost/p.jpg?w=360');
  assert.equal(pageFromSearch('?page=12', 24), 11);
  assert.equal(pageFromSearch('?x=1&page=1', 24), 0);
  assert.equal(pageFromSearch('?page=99', 24), null);
  assert.equal(pageFromSearch('?page=0', 24), null);
  assert.equal(pageFromSearch('', 24), null);
});

// ─── Search ────────────────────────────────────────────────────────

test('search: accents and case don’t matter, words match from their start, the whole phrase first, snippets around the hit', () => {
  const texts = ['The cover', 'Mathew’s dream bedroom, 2012.', 'A room for Zoë and her dream', 'Dream big: dream bedroom number two', 'His father, Anderson'];
  assert.equal(fold('Zoë'), 'zoe');
  const r = searchPages(texts, 'dream bedroom');
  assert.deepEqual(r.map((x) => x.page), [3, 1]);
  assert.equal(r[1].match, 'dream bedroom');
  assert.deepEqual(searchPages(texts, 'zoe').map((x) => x.page), [2]);
  assert.deepEqual(searchPages(texts, 'anders').map((x) => x.page), [4]);
  // "the" starts no word in Mathew or father
  assert.deepEqual(searchPages(texts, 'the').map((x) => x.page), [0]);
  assert.deepEqual(searchPages(texts, 'x'), []);
  const long = `${'word '.repeat(50)}needle ${'more '.repeat(50)}`;
  const s = searchPages([long], 'needle')[0];
  assert.ok(s.before.startsWith('…') && s.after.endsWith('…') && s.match === 'needle');
  // Marks: whole words (the admin measures each one), and from a word's start in older whole-run files
  assert.deepEqual(hitBoxes([['Charlie', 0.3, 0.2, 0.1, 0.02], ['Mathew', 0.5, 0.2, 0.1, 0.02]], 'char'), [{ x: 0.3, y: 0.2, w: (0.1 * 4) / 7, h: 0.02 }]);
  assert.equal(hitBoxes([['Mathew', 0.5, 0.2, 0.1, 0.02]], 'the').length, 0);
  const run = hitBoxes([['Hello Charlie', 0.1, 0.2, 0.5, 0.02]], 'charlie');
  assert.equal(run.length, 1);
  assert.ok(Math.abs(run[0].x - (0.1 + (0.5 * 6) / 13)) < 1e-9 && Math.abs(run[0].w - (0.5 * 7) / 13) < 1e-9);
});

// ─── Reading the PDF ───────────────────────────────────────────────

test('planPages: single pages as they are, double-width spreads cut in two', () => {
  const letter = { w: 612, h: 792 };
  const spread = { w: 1224, h: 792 };
  const plain = planPages([letter, letter, letter]);
  assert.equal(plain.spreads, 0);
  assert.deepEqual(plain.pages.map((p) => p.half), [null, null, null]);
  const mixed = planPages([letter, letter, spread, letter, spread, letter]);
  assert.equal(mixed.spreads, 2);
  assert.equal(mixed.pageW, 612);
  assert.deepEqual(mixed.pages.map((p) => `${p.pdf}${p.half ? p.half[0] : ''}`), ['0', '1', '2l', '2r', '3', '4l', '4r', '5']);
  // A landscape book isn't a book of spreads
  assert.equal(planPages([{ w: 792, h: 612 }, { w: 792, h: 612 }]).spreads, 0);
  assert.equal(bookPageOf(mixed, 3), 4);
  assert.deepEqual(pixelSize(612, 792, 2800), { w: 2164, h: 2800 });
  assert.deepEqual(pageBox({ half: 'right' }, 2000, 800), { x: 1000, y: 0, w: 1000, h: 800 });
  assert.equal(pageName(0), 'p001');
  assert.equal(pageName(41), 'p042');
});

test('paragraphs: runs into lines, lines into paragraphs, hyphens and letter spacing undone', () => {
  const run = (str, x, y, w, h = 0.02) => ({ str, x, y, w, h });
  const text = paragraphs([
    run('2 0 1 2 · 2 0 2 7', 0.1, 0.05, 0.3),
    run('A title', 0.1, 0.1, 0.4, 0.05),
    run('The first line of a para-', 0.1, 0.2, 0.6),
    run('graph goes on here', 0.1, 0.225, 0.5),
    run('and ends.', 0.62, 0.225, 0.1),
    run('A new paragraph', 0.1, 0.3, 0.4),
  ]);
  assert.equal(text, '2012 · 2027\n\nA title\n\nThe first line of a paragraph goes on here and ends.\n\nA new paragraph');
  assert.equal(unspace('O U R  S T O R Y'), 'OUR  STORY');
  assert.equal(unspace('I am a kid in room 2 of 3'), 'I am a kid in room 2 of 3');
  assert.equal(paragraphs([]), '');
  // Each word gets its own box, by its share of the run's measured width, punctuation left out
  const wide = (t) => [...t].reduce((n, ch) => n + (/[mw]/i.test(ch) ? 2 : 1), 0);
  // (22 units wide, so each unit is 0.02 of the page)
  assert.deepEqual(wordsOf([run('“We came,” said Mo.', 0.1, 0.5, 0.44), run('  ', 0, 0, 0)], wide), [
    ['We', 0.12, 0.5, 0.06, 0.02], ['came', 0.2, 0.5, 0.1, 0.02], ['said', 0.36, 0.5, 0.08, 0.02], ['Mo', 0.46, 0.5, 0.06, 0.02],
  ]);
  assert.deepEqual(wordsOf([run('Eleven-year-old', 0, 0, 0.15)]).map((w) => w[0]), ['Eleven-year-old']);
});

test('links: web and email addresses and pages of the book, nothing that runs script', () => {
  assert.deepEqual(cleanLink({ x: 0.1, y: 0.2, w: 0.3, h: 0.04, url: 'https://sunshineonaranneyday.com/donate/' }), { x: 0.1, y: 0.2, w: 0.3, h: 0.04, url: 'https://sunshineonaranneyday.com/donate/' });
  assert.deepEqual(cleanLink({ x: 0.1, y: 0.2, w: 0.3, h: 0.04, page: 6 }), { x: 0.1, y: 0.2, w: 0.3, h: 0.04, page: 6 });
  assert.ok(cleanLink({ x: 0, y: 0, w: 0.1, h: 0.1, url: 'mailto:info@example.org' }));
  for (const url of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'ftp://x.org/a', '']) assert.equal(cleanLink({ x: 0, y: 0, w: 0.1, h: 0.1, url }), null, url);
  assert.equal(cleanLink({ x: 0, y: 0, w: 0, h: 0.1, url: 'https://x.org' }), null);
});

test('chapters from the bookmarks: the book’s own title bookmark is unwrapped and the cover isn’t a chapter', () => {
  const plan = planPages([{ w: 612, h: 792 }, { w: 612, h: 792 }, { w: 1224, h: 792 }, { w: 612, h: 792 }]);
  const wrapped = [{ title: 'The Book', page: 0, items: [{ title: 'One', page: 1 }, { title: ' Two  ', page: 3 }] }];
  assert.deepEqual(chaptersFrom(wrapped, plan), [{ title: 'One', page: 1 }, { title: 'Two', page: 4 }]);
  const flat = [{ title: 'Cover', page: 0 }, { title: 'One', page: 1 }, { title: 'One', page: 1 }, { title: 'Lost', page: null }];
  assert.deepEqual(chaptersFrom(flat, plan), [{ title: 'One', page: 1 }]);
  assert.deepEqual(chaptersFrom([], plan), []);
});

// ─── Keeping the files (R2) ────────────────────────────────────────

const call = async (FILES, body, query = '', DB = undefined) => {
  const raw = body instanceof Uint8Array;
  const request = new Request(`https://admin.test/api/book-admin${query}`, { method: 'POST', body: raw ? body : JSON.stringify(body), headers: { 'content-type': raw ? 'application/octet-stream' : 'application/json' } });
  const res = await bookAdmin({ env: { FILES, DB }, request });
  return { status: res.status, ...(await res.json()) };
};

test('book-admin: a big PDF goes up in parts and comes out whole', async () => {
  const FILES = createR2();
  const size = 5 * 1024 * 1024 + 1234;
  const pdf = new Uint8Array(size).map((_, i) => i % 251);
  pdf.set(new TextEncoder().encode('%PDF-1.7\n'), 0);
  const start = await call(FILES, { action: 'pdf-start', version: 'mf3k2a9x', name: 'SOARD 15 Years (final).pdf', bytes: size });
  assert.equal(start.success, true);
  assert.equal(start.key, 'books/mf3k2a9x/SOARD-15-Years-final.pdf');
  const q = (n) => `?action=pdf-part&key=${encodeURIComponent(start.key)}&uploadId=${start.uploadId}&part=${n}`;
  const a = await call(FILES, pdf.slice(0, 5 * 1024 * 1024), q(1));
  const b = await call(FILES, pdf.slice(5 * 1024 * 1024), q(2));
  assert.ok(a.success && b.success);
  const done = await call(FILES, { action: 'pdf-finish', key: start.key, uploadId: start.uploadId, parts: [{ part: 2, etag: b.etag }, { part: 1, etag: a.etag }] });
  assert.deepEqual([done.success, done.url, done.bytes], [true, '/files/books/mf3k2a9x/SOARD-15-Years-final.pdf', size]);
  const stored = FILES.objects.get(start.key);
  assert.deepEqual(stored.bytes, pdf);
  assert.equal(stored.httpMetadata.contentType, 'application/pdf');
});

test('book-admin: refuses what isn’t a PDF, keys outside books/, and odd versions', async () => {
  const FILES = createR2();
  const start = await call(FILES, { action: 'pdf-start', version: 'abcdef12', name: 'x.pdf', bytes: 10 });
  const html = new TextEncoder().encode('<html><script>alert(1)</script>');
  const r = await call(FILES, html, `?action=pdf-part&key=${encodeURIComponent(start.key)}&uploadId=${start.uploadId}&part=1`);
  assert.equal(r.status, 415);
  for (const key of ['financials/x.pdf', 'books/abcdef12/../../x.pdf', 'books/abcdef12/x.html', 'books/AB/x.pdf']) {
    const res = await call(FILES, new Uint8Array([1]), `?action=pdf-part&key=${encodeURIComponent(key)}&uploadId=u1&part=1`);
    assert.equal(res.status, 400, key);
  }
  assert.equal((await call(FILES, { action: 'pdf-start', version: '../x', name: 'a.pdf', bytes: 5 })).status, 400);
  assert.equal((await call(FILES, { action: 'put-json', version: 'abcdef12', name: 'index', data: {} })).status, 400);
  assert.equal((await call(FILES, { action: 'nope' })).status, 400);
  assert.equal(pdfName('../../etc/passwd'), 'etc-passwd.pdf');
  assert.equal(pdfName(''), 'book.pdf');
  assert.equal(pdfKey('books/abcdef12/.pdf'), null);
  assert.ok(looksLikePdf(new TextEncoder().encode('junk%PDF-1.4')));
  assert.equal(looksLikePdf(new TextEncoder().encode('%PDX')), false);
});

test('book-admin: old uploads are listed for clearing, never the ones kept, and go whole', async () => {
  const FILES = createR2();
  const DB = await createD1({ schemaFiles: [new URL('../scripts/schema.sql', import.meta.url).pathname] });
  const versions = ['aaaaaa01', 'bbbbbb02', 'cccccc03', 'dddddd04', 'eeeeee05', 'ffffff06'];
  for (const v of versions) {
    await call(FILES, { action: 'put-json', version: v, name: 'manifest', data: { images: [`book/${v}/p001`, `book/${v}/p002`, 'kids/amari/hero'] } });
    await call(FILES, { action: 'put-json', version: v, name: 'text', data: { pages: [] } });
    await FILES.put(`books/${v}/book.pdf`, '%PDF-');
  }
  // All of them two days old but the last, made an hour ago (another tab's, not saved yet)
  for (const [k, o] of FILES.objects) if (!k.startsWith('books/ffffff06/')) o.uploaded = new Date(Date.now() - 2 * 864e5);
  for (const o of [...FILES.objects].filter(([k]) => k.startsWith('books/ffffff06/')).map(([, o]) => o)) o.uploaded = new Date(Date.now() - 36e5);
  await FILES.put('financials/2024-990.pdf', '%PDF-');
  // Without the database nothing is offered: it can't tell what History still needs
  assert.deepEqual((await call(FILES, { action: 'old-versions', keep: [] })).versions, []);
  // The saved book is dddddd04; History can put back eeeeee05
  await DB.prepare("INSERT INTO site_config (key, data, updated_at) VALUES ('book', ?, '2026-10-31')").bind(JSON.stringify({ version: 'dddddd04' })).run();
  await DB.prepare(`CREATE TABLE IF NOT EXISTS content_versions (id INTEGER PRIMARY KEY AUTOINCREMENT, collection TEXT NOT NULL, slug TEXT NOT NULL, data TEXT NOT NULL, action TEXT, user_email TEXT, created_at TEXT)`).run();
  await DB.prepare("INSERT INTO content_versions (collection, slug, data, action, created_at) VALUES ('site', 'book', ?, 'save', '2026-10-30')").bind(JSON.stringify({ version: 'eeeeee05' })).run();
  const old = await call(FILES, { action: 'old-versions', keep: ['bbbbbb02', 'cccccc03', 'not a version'] }, '', DB);
  // Only the book's own pictures are offered for deleting
  assert.deepEqual(old.versions, [{ version: 'aaaaaa01', images: ['book/aaaaaa01/p001', 'book/aaaaaa01/p002'] }]);
  const gone = await call(FILES, { action: 'drop-version', version: 'aaaaaa01' });
  assert.equal(gone.deleted, 3);
  assert.deepEqual([...FILES.objects.keys()].filter((k) => k.startsWith('books/aaaaaa01/')), []);
  assert.ok(FILES.objects.has('financials/2024-990.pdf') && FILES.objects.has('books/bbbbbb02/book.pdf'));
});

test('the book is a site doc (saved from Site Config, written by the build)', () => {
  assert.equal(isSiteDocKey('book'), true);
});

// ─── Readers, counted (functions/api/_book-stats.js) ───────────────
import { statsRows, recordStats, readStats, linkKey, fromKey, dayOf, addDays } from '../functions/api/_book-stats.js';
import { onRequestPost as bookStatsBeacon } from '../functions/api/book-stats.js';
import { createD1 } from './lib/d1-shim.mjs';

test('book stats: a beacon is checked and capped; anything else adds nothing', () => {
  assert.equal(statsRows(null), null);
  assert.equal(statsRows({ v: '../x', visit: 1 }), null);
  const rows = statsRows({
    v: 'mvwrux2zstnp', visit: 1, reader: 1, device: 'phone', from: 'https://www.facebook.com/x?y=1',
    views: { 0: 1, 3: 2, '-1': 4, abc: 1, 99999: 1 }, ms: { 3: 9e9 }, time: 1234,
    reach: [2, 5], share: { facebook: 1, evil: 3 }, links: { 'https://sunshineonaranneyday.com/donate/?utm=1': 1, 'javascript:alert(1)': 1 }, download: 999,
  });
  const has = (m, k, n) => rows.some(([a, b, c]) => a === m && b === k && c === n);
  assert.ok(has('visit', '', 1) && has('reader', '', 1) && has('device', 'phone', 1) && has('from', 'facebook.com', 1));
  assert.ok(has('view', '0', 1) && has('view', '3', 2) && !rows.some(([m, k]) => m === 'view' && !['0', '3'].includes(k)));
  assert.ok(has('ms', '3', 600000), 'ten minutes a page at most');
  assert.ok(has('time', '', 1234) && has('download', '', 50));
  assert.ok(has('reach', '2', -1) && has('reach', '5', 1));
  assert.ok(has('share', 'facebook', 1) && !rows.some(([m, k]) => m === 'share' && k === 'evil'));
  assert.ok(has('link', 'sunshineonaranneyday.com/donate', 1) && rows.filter(([m]) => m === 'link').length === 1);
  assert.equal(statsRows({ v: 'abcd1234', reach: [5, 2] }).length, 0, 'reach only goes forward');
  assert.equal(linkKey('mailto:Info@Example.org'), 'mailto:info@example.org');
  assert.equal(fromKey('https://sunshineonaranneyday.com/kids/'), null);
});

test('book stats: counted, summed and read back; how far people read is exact', async () => {
  const DB = await createD1();
  const v = 'abcd1234';
  // Three visitors: one stops on the cover, one reads to page 6, one to the end (page 11)
  await recordStats(DB, v, statsRows({ v, visit: 1, device: 'computer', views: { 0: 1 }, reach: [-1, 0], time: 4000 }), '2026-11-01');
  await recordStats(DB, v, statsRows({ v, visit: 1, device: 'phone', reader: 1, views: { 0: 1, 1: 1, 2: 1 }, reach: [-1, 2], ms: { 1: 5000, 2: 5000 }, time: 9000 }), '2026-11-01');
  await recordStats(DB, v, statsRows({ v, views: { 5: 1, 6: 1 }, reach: [2, 6], time: 3000 }), '2026-11-01');
  await recordStats(DB, v, statsRows({ v, visit: 1, device: 'phone', reader: 1, end: 1, reach: [-1, 11], download: 1, share: { copy: 1 } }), '2026-11-02');
  // Another upload's pages stay apart
  await recordStats(DB, 'zzzz9999', statsRows({ v: 'zzzz9999', visit: 1, views: { 0: 1 }, reach: [-1, 0] }), '2026-11-02');
  const s = await readStats(DB, { days: 0, version: v });
  assert.deepEqual([s.totals.visits, s.totals.readers, s.totals.end, s.totals.download, s.totals.share, s.totals.time], [4, 2, 1, 1, 1, 16000]);
  assert.deepEqual(s.pages.reach, { 0: 1, 2: 0, 6: 1, 11: 1 });
  assert.deepEqual(s.pages.ms, { 1: 5000, 2: 5000 });
  assert.deepEqual(s.days, [{ day: '2026-11-01', visits: 2, readers: 1 }, { day: '2026-11-02', visits: 2, readers: 1 }]);
  assert.deepEqual(s.devices, { computer: 1, phone: 2 });
  // A window of days leaves the older ones out
  const recent = await readStats(DB, { days: 1, version: v, today: new Date('2026-11-02T12:00:00Z') });
  assert.equal(recent.totals.visits, 2);
  // Days are Atlanta's: at 11 at night on Nov 1 it's still Nov 1 there (UTC says Nov 2)
  const late = await readStats(DB, { days: 1, version: v, today: new Date('2026-11-02T03:00:00Z') });
  assert.deepEqual([late.since, late.today, late.totals.visits], ['2026-11-01', '2026-11-01', 2]);
});

test('book stats days: a reader at nine at night counts that evening in Atlanta', () => {
  assert.equal(dayOf(new Date('2026-11-01T01:30:00Z')), '2026-10-31');   // 9:30 pm EDT
  assert.equal(dayOf(new Date('2026-12-01T04:59:00Z')), '2026-11-30');   // 11:59 pm EST
  assert.equal(dayOf(new Date('2026-12-01T05:00:00Z')), '2026-12-01');
  assert.equal(addDays('2026-11-01', -29), '2026-10-03');
  assert.equal(addDays('2026-03-07', 2), '2026-03-09');                  // across the spring clock change
});

test('book stats beacon: always 204, junk and oversize bodies change nothing', async () => {
  const DB = await createD1();
  const send = async (body) => (await bookStatsBeacon({ env: { DB }, request: new Request('https://x/api/book-stats', { method: 'POST', body }) })).status;
  assert.equal(await send('not json'), 204);
  assert.equal(await send(JSON.stringify({ v: 'abcd1234', visit: 1, pad: 'x'.repeat(9000) })), 204);
  assert.equal(await send(JSON.stringify({ v: 'abcd1234', visit: 1 })), 204);
  assert.equal((await readStats(DB, { days: 0 })).totals.visits, 1);
});
