/**
 * Admin → Site Config → Anniversary book: turning the PDF into the flip book.
 * ===========================================================================
 * All of it runs here in the browser, on the file itself:
 *   1. pdf.js opens it and each page is measured. A page twice as wide as
 *      the book's own pages is a two-page spread (InDesign "export as
 *      spreads"): it's cut down the middle into its two pages.
 *   2. Every page is drawn the same size (its longer side PAGE_LONG pixels,
 *      enough to zoom in and read the small print) and saved as a JPEG.
 *   3. Its words come out twice: as paragraphs (screen readers, search
 *      engines, the reader's search box) and one by one with their places
 *      on the page (the yellow marks on a found word). Its links come out
 *      too, and the PDF's bookmarks become the chapters.
 * ./book-editor.js uploads what comes out and saves the book;
 * tests/book.test.mjs checks the parts here that need no browser.
 */

export const PAGE_LONG = 4000;      // pixels on a page's longer side: small print stays sharp zoomed in on a phone
export const JPEG_QUALITY = 0.86;
/** The progress grid's copy of a page, in pixels across */
const THUMB_W = 240;
const MAX_UPLOAD = 9.5 * 1024 * 1024; // Cloudflare Images takes up to 10 MB a picture
const MAX_CANVAS = 16e6;              // Safari's largest canvas, in pixels

// ─── What the pages are ────────────────────────────────────────────

/**
 * The book's pages from the PDF's page sizes ([{ w, h }] in points). The
 * book's page is the narrowest one that's the usual height; a PDF page at
 * least 1.8 times that wide is a spread, and becomes a left and a right
 * page. Returns { pageW, pageH, pages: [{ pdf (0-based), half: null |
 * 'left' | 'right' }], spreads (how many were cut) }.
 */
export function planPages(sizes) {
  const list = (sizes || []).map((s) => ({ w: Number(s?.w) || 0, h: Number(s?.h) || 0 })).filter((s) => s.w > 0 && s.h > 0);
  if (!list.length) return { pageW: 0, pageH: 0, pages: [], spreads: 0 };
  const heights = list.map((s) => s.h).sort((a, b) => a - b);
  const usualH = heights[Math.floor(heights.length / 2)];
  const sameH = list.filter((s) => Math.abs(s.h - usualH) <= usualH * 0.05);
  const pageW = Math.min(...(sameH.length ? sameH : list).map((s) => s.w));
  const pageH = usualH;
  const pages = [];
  let spreads = 0;
  list.forEach((s, i) => {
    const spread = s.w >= pageW * 1.8 && Math.abs(s.h - pageH) <= pageH * 0.05;
    if (spread) { pages.push({ pdf: i, half: 'left' }, { pdf: i, half: 'right' }); spreads++; }
    else pages.push({ pdf: i, half: null });
  });
  return { pageW, pageH, pages, spreads };
}

/** Each page's pixel size: the book's shape, its longer side `long` */
export function pixelSize(pageW, pageH, long = PAGE_LONG) {
  const k = long / Math.max(pageW, pageH);
  return { w: Math.round(pageW * k), h: Math.round(pageH * k) };
}

/** The part of a PDF page (viewport pixels) that is this book page: all of it, or a half */
export function pageBox(item, vw, vh) {
  if (item.half === 'left') return { x: 0, y: 0, w: vw / 2, h: vh };
  if (item.half === 'right') return { x: vw / 2, y: 0, w: vw / 2, h: vh };
  return { x: 0, y: 0, w: vw, h: vh };
}

/** "p001", "p042": the picture's name in Cloudflare Images */
export const pageName = (i) => `p${String(i + 1).padStart(3, '0')}`;

// ─── Words ─────────────────────────────────────────────────────────

/**
 * Text runs (each { str, x, y, w, h } in page fractions, y the top) into
 * paragraphs: runs on a line (their middles within half a line of each
 * other) join left to right, with a space where they don't touch; a gap of
 * about a line or more, or a change of type size, starts a new paragraph.
 * Letter-spaced type (a run per letter, evenly apart) joins into words.
 * aspect: the page's width over its height (x and h are fractions of
 * different lengths). Returns the paragraphs split by a blank line.
 */
export function paragraphs(runs, aspect = 1) {
  const rs = (runs || []).filter((r) => r && String(r.str || '').trim());
  if (!rs.length) return '';
  const lines = [];
  for (const r of [...rs].sort((a, b) => a.y - b.y || a.x - b.x)) {
    const mid = r.y + r.h / 2;
    const line = lines.find((l) => Math.abs(l.mid - mid) <= Math.max(l.h, r.h) * 0.5 && Math.abs(l.h - r.h) <= Math.max(l.h, r.h) * 0.6);
    if (line) { line.runs.push(r); line.top = Math.min(line.top, r.y); line.h = Math.max(line.h, r.h); }
    else lines.push({ mid, top: r.y, h: r.h, runs: [r] });
  }
  lines.sort((a, b) => a.top - b.top);
  const paras = [];
  let cur = [];
  let prev = null;
  for (const l of lines) {
    l.runs.sort((a, b) => a.x - b.x);
    // Gaps between runs, in the line's own height
    const gaps = l.runs.slice(1).map((r, i) => ((r.x - (l.runs[i].x + l.runs[i].w)) * aspect) / l.h);
    const letters = l.runs.length >= 4 && l.runs.filter((r) => String(r.str).trim().length <= 2).length >= l.runs.length * 0.7;
    const sorted = [...gaps].sort((a, b) => a - b);
    const space = letters ? Math.max(0.3, (sorted[Math.floor(sorted.length / 2)] || 0) * 1.7) : 0.15;
    let text = '';
    l.runs.forEach((r, i) => {
      const s = String(r.str);
      if (i > 0 && gaps[i - 1] > space && !/\s$/.test(text) && !/^\s/.test(s)) text += ' ';
      text += letters ? s.trim() : s;
    });
    text = unspace(text).replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (prev) {
      const gap = l.top - (prev.top + prev.h);
      const newPara = gap > Math.max(prev.h, l.h) * 0.9 || Math.abs(prev.h - l.h) > Math.max(prev.h, l.h) * 0.35;
      if (newPara) { paras.push(cur.join(' ')); cur = []; }
    }
    // A hyphen at a line's end joins the word
    if (cur.length && /[a-z]-$/i.test(cur[cur.length - 1]) && /^[a-z]/.test(text)) cur[cur.length - 1] = cur[cur.length - 1].slice(0, -1) + text;
    else cur.push(text);
    prev = l;
  }
  if (cur.length) paras.push(cur.join(' '));
  return paras.map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n\n');
}

/** Letter-spaced type that pdf.js read as "2 0 1 2" back into "2012" (three or more lone letters or digits) */
export const unspace = (s) => String(s).replace(/(?<![\p{L}\p{N}])(?:[\p{L}\p{N}] ){2,}[\p{L}\p{N}](?![\p{L}\p{N}])/gu, (m) => m.replace(/ /g, ''));

/**
 * Every word of the text runs with its own box, for the reader's search
 * marks: [word, x, y, w, h] in page fractions. measure(text, font) gives a
 * width in any unit (the browser's canvas, here in the admin); a word sits at
 * its share of its run's measured width, so wide and narrow letters land
 * where the page has them. Punctuation around a word stays out of its box.
 */
export function wordsOf(runs, measure = (t) => t.length) {
  const round = (v) => Math.round(v * 10000) / 10000;
  const out = [];
  for (const r of runs || []) {
    const str = String(r?.str || '');
    if (!str.trim()) continue;
    const k = r.w / (measure(str, r.font) || 1);
    for (const m of str.matchAll(/\S+/g)) {
      const core = /[\p{L}\p{N}](?:[\p{L}\p{N}'’-]*[\p{L}\p{N}])?/u.exec(m[0]);
      if (!core) continue;
      const x = r.x + measure(str.slice(0, m.index + core.index), r.font) * k;
      out.push([core[0], round(x), round(r.y), round(measure(core[0], r.font) * k), round(r.h)]);
    }
  }
  return out;
}

/** Text widths the way the browser draws the font (the PDF's own font isn't at hand: its family is) */
let measurer = null;
function measureText(text, font) {
  if (!measurer) measurer = document.createElement('canvas').getContext('2d');
  measurer.font = `100px ${font || 'sans-serif'}`;
  return measurer.measureText(text).width;
}

/** A link the reader can follow: a web or email address, or another page of the book */
export function cleanLink(l) {
  if (!l) return null;
  const box = ['x', 'y', 'w', 'h'].map((k) => Math.round(Number(l[k]) * 10000) / 10000);
  if (box.some((v) => !Number.isFinite(v)) || box[2] <= 0 || box[3] <= 0) return null;
  const [x, y, w, h] = box;
  if (Number.isInteger(l.page)) return { x, y, w, h, page: l.page };
  const url = String(l.url || '').trim();
  if (/^https?:\/\/[^\s]+$/i.test(url) || /^mailto:[^\s@]+@[^\s@]+$/i.test(url)) return { x, y, w, h, url };
  return null;
}

/** The book page a PDF page lands on (a spread's left half) */
export function bookPageOf(plan, pdfIndex) {
  const i = plan.pages.findIndex((p) => p.pdf === pdfIndex);
  return i >= 0 ? i : null;
}

/**
 * Chapters from the PDF's bookmarks: the top level, or, when that's one
 * bookmark with others under it (the book's own title), the ones under it.
 * outline: [{ title, page (0-based PDF page or null), items }]
 */
export function chaptersFrom(outline, plan) {
  let top = Array.isArray(outline) ? outline : [];
  if (top.length === 1 && Array.isArray(top[0].items) && top[0].items.length > 1) top = top[0].items;
  const out = [];
  for (const o of top) {
    const title = String(o?.title || '').replace(/\s+/g, ' ').trim();
    const page = Number.isInteger(o?.page) ? bookPageOf(plan, o.page) : null;
    if (title && page != null && !out.some((c) => c.page === page && c.title === title)) out.push({ title: title.slice(0, 120), page });
  }
  // A bookmark on the cover is the book's own title, not a chapter
  const rest = out.filter((c) => c.page > 0);
  return (rest.length ? rest : out).sort((a, b) => a.page - b.page);
}

// ─── With pdf.js (the browser) ─────────────────────────────────────

// PDF space → the drawn page's pixels: 2×3 matrices [a, b, c, d, e, f]
const multiply = (m, n) => [m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1], m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3], m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5]];
const apply = (m, x, y) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];

let lib = null;
async function pdfjs() {
  if (!lib) lib = (await import('./vendor-pdf.js')).pdfjsLib;
  return lib;
}

/** Open the file */
export async function openPdf(file) {
  const pdfjsLib = await pdfjs();
  const base = new URL('./pdf/', import.meta.url).href;
  const data = new Uint8Array(await file.arrayBuffer());
  const task = pdfjsLib.getDocument({ data, standardFontDataUrl: `${base}standard_fonts/`, wasmUrl: `${base}wasm/`, useWasm: false, enableXfa: false, isOffscreenCanvasSupported: false, isImageDecoderSupported: false });
  return task.promise;
}

/** Every page's size in points, turned the way it's shown */
export async function pageSizes(pdf) {
  const out = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const p = await pdf.getPage(i);
    const v = p.getViewport({ scale: 1 });
    out.push({ w: v.width, h: v.height });
    p.cleanup();
  }
  return out;
}

/** Where an internal link or bookmark goes: a 0-based PDF page, or null */
async function destPage(pdf, dest) {
  try {
    const d = typeof dest === 'string' ? await pdf.getDestination(dest) : dest;
    if (!Array.isArray(d) || !d[0]) return null;
    if (typeof d[0] === 'object') return await pdf.getPageIndex(d[0]);
    return Number.isInteger(d[0]) ? d[0] : null;
  } catch { return null; }
}

/** The PDF's bookmarks, with their pages */
export async function readOutline(pdf) {
  let outline = null;
  try { outline = await pdf.getOutline(); } catch { outline = null; }
  const walk = async (items, depth) => Promise.all((items || []).map(async (o) => ({
    title: o.title,
    page: o.dest ? await destPage(pdf, o.dest) : null,
    items: depth < 1 ? await walk(o.items, depth + 1) : [],
  })));
  return outline ? walk(outline, 0) : [];
}

/**
 * One PDF page drawn, read and cut into its book pages. Returns, for each
 * book page in `items` (all from this PDF page): { blob, text, runs, links }.
 * size: the book page's pixel size; plan: for links to other pages.
 */
export async function processPdfPage(pdf, pdfIndex, items, size, plan) {
  const pdfjsLib = await pdfjs();
  const page = await pdf.getPage(pdfIndex + 1);
  const base = page.getViewport({ scale: 1 });
  const across = items.some((it) => it.half) ? 2 : 1;
  // The scale that makes each book page `size`; a page of another shape fits inside it
  let scale = Math.min((size.w * across) / base.width, size.h / base.height);
  if (base.width * base.height * scale * scale > MAX_CANVAS) scale = Math.sqrt(MAX_CANVAS / (base.width * base.height));
  const vp = page.getViewport({ scale });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(vp.width);
  canvas.height = Math.ceil(vp.height);
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, canvas, viewport: vp, background: '#ffffff', annotationMode: pdfjsLib.AnnotationMode.ENABLE }).promise;

  // Words, with their places
  let raw = [];
  try {
    const tc = await page.getTextContent();
    raw = tc.items.filter((it) => typeof it.str === 'string' && it.str.trim()).map((it) => {
      const m = multiply(vp.transform, it.transform);
      const fontH = Math.hypot(m[2], m[3]) || 1;
      const w = (it.width || 0) * scale;
      const font = tc.styles?.[it.fontName]?.fontFamily || 'sans-serif';
      return { str: it.str, font, x: m[4], y: m[5] - fontH * 0.86, w: w || fontH * it.str.length * 0.5, h: fontH * 1.08 };
    });
  } catch { raw = []; }

  // Links
  let annots = [];
  try { annots = await page.getAnnotations({ intent: 'display' }); } catch { annots = []; }
  const linkRaw = [];
  for (const a of annots) {
    if (a.subtype !== 'Link' || !Array.isArray(a.rect)) continue;
    const [x1, y1] = apply(vp.transform, a.rect[0], a.rect[1]);
    const [x2, y2] = apply(vp.transform, a.rect[2], a.rect[3]);
    const box = { x: Math.min(x1, x2), y: Math.min(y1, y2), w: Math.abs(x2 - x1), h: Math.abs(y2 - y1) };
    if (a.url) linkRaw.push({ ...box, url: a.url });
    else if (a.dest) {
      const to = await destPage(pdf, a.dest);
      const bp = to == null ? null : bookPageOf(plan, to);
      if (bp != null) linkRaw.push({ ...box, page: bp });
    }
  }

  const out = [];
  for (const it of items) {
    const box = pageBox(it, canvas.width, canvas.height);
    const c = document.createElement('canvas');
    c.width = size.w;
    c.height = size.h;
    const cx = c.getContext('2d', { alpha: false, willReadFrequently: true });
    cx.fillStyle = '#fff';
    cx.fillRect(0, 0, size.w, size.h);
    // Fit the part into the page, centred (the same shape, unless this PDF page is another size)
    const k = Math.min(size.w / box.w, size.h / box.h);
    const dw = box.w * k, dh = box.h * k;
    const ox = (size.w - dw) / 2, oy = (size.h - dh) / 2;
    cx.imageSmoothingQuality = 'high';
    cx.drawImage(canvas, box.x, box.y, box.w, box.h, ox, oy, dw, dh);
    const toPage = (r) => ({ x: (ox + (r.x - box.x) * k) / size.w, y: (oy + (r.y - box.y) * k) / size.h, w: (r.w * k) / size.w, h: (r.h * k) / size.h });
    const inBox = (r) => { const mid = r.x + r.w / 2; return mid >= box.x && mid < box.x + box.w; };
    const runs = raw.filter(inBox).map((r) => ({ str: r.str, font: r.font, ...toPage(r) }));
    const links = linkRaw.filter(inBox).map((l) => cleanLink({ ...toPage(l), url: l.url, page: l.page })).filter(Boolean);
    let blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', JPEG_QUALITY));
    if (blob && blob.size > MAX_UPLOAD) blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.72));
    if (!blob) throw new Error(`Page ${pdfIndex + 1} couldn’t be drawn`);
    // A small copy for the progress grid: 136 full pages shown there held a gigabyte of decoded pictures
    const t = document.createElement('canvas');
    t.width = THUMB_W;
    t.height = Math.round((THUMB_W * size.h) / size.w);
    const tx = t.getContext('2d', { alpha: false, willReadFrequently: true });
    tx.imageSmoothingQuality = 'high';
    tx.drawImage(c, 0, 0, t.width, t.height);
    const thumb = await new Promise((res) => t.toBlob(res, 'image/jpeg', 0.8));
    t.width = t.height = 0;
    out.push({ blob, thumb, text: paragraphs(runs, size.w / size.h), runs: wordsOf(runs, measureText), links });
    c.width = c.height = 0;
  }
  canvas.width = canvas.height = 0;
  page.cleanup();
  return out;
}
