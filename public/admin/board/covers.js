/**
 * What a paper looks like before it's opened, on the board's page and the advisors': its first page drawn in the
 * browser, or a drawn cover with the word that says what it is. A file brings its own address (f.url); the board's
 * come from /api/board-file.
 */
import { h, htm, useState, useEffect, useRef } from '../vendor.js';
import { formatOf } from '../board-shared.js';

const html = htm.bind(h);
const urlOf = (f) => f.url || `/api/board-file?id=${encodeURIComponent(f.id)}`;

// ─── First pages ────────────────────────────────────────────────────
// A PDF's first page, drawn in the browser by pdf.js (the file viewer's own, ../vendor-pdf.js) when its cover or
// icon scrolls into view, two at a time, and kept on this device so it's there at once next time. No pictures are
// stored anywhere else; Word and Excel files keep their drawn covers.
let pdfLib = null;
let pdfWorker = null;
const loadPdfLib = () => (pdfLib ||= import('../vendor-pdf.js').catch((e) => { pdfLib = null; throw e; }));
const pageKey = (f, w) => `bp-page:${f.id}:${f.size || 0}:${w}`;
export const pageKept = (f, w) => { try { return localStorage.getItem(pageKey(f, w)) || ''; } catch { return ''; } };
const drawing = { now: 0, queue: [] };
function drawSoon(job) {
  return new Promise((resolve, reject) => {
    drawing.queue.push({ job, resolve, reject });
    const pump = () => {
      while (drawing.now < 2 && drawing.queue.length) {
        const next = drawing.queue.shift();
        drawing.now += 1;
        next.job().then(next.resolve, next.reject).finally(() => { drawing.now -= 1; pump(); });
      }
    };
    pump();
  });
}
async function firstPage(f, width) {
  const { pdfjsLib } = await loadPdfLib();
  pdfWorker ||= new pdfjsLib.PDFWorker();
  const base = new URL('../pdf/', import.meta.url).href;
  const task = pdfjsLib.getDocument({ url: urlOf(f), worker: pdfWorker, disableAutoFetch: true, standardFontDataUrl: `${base}standard_fonts/`, wasmUrl: `${base}wasm/`, useWasm: false, enableXfa: false, isEvalSupported: false });
  try {
    const doc = await task.promise;
    const page = await doc.getPage(1);
    const one = page.getViewport({ scale: 1 });
    const v = page.getViewport({ scale: (width * Math.min(2, window.devicePixelRatio || 1)) / one.width });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(v.width);
    canvas.height = Math.round(v.height);
    const g = canvas.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: g, viewport: v }).promise;
    return canvas.toDataURL('image/jpeg', 0.8);
  } finally {
    task.destroy();
  }
}
/** A photo's first page is the photo itself, drawn small (a screenshot, a picture of a page); one the browser can't
 * read (HEIC in Chrome) throws, so it keeps its badge */
async function firstPhoto(f, width) {
  const res = await fetch(urlOf(f), { credentials: 'same-origin' });
  if (!res.ok) throw new Error(`photo ${res.status}`);
  const bmp = await createImageBitmap(await res.blob());
  try {
    const w = Math.min(bmp.width, Math.round(width * Math.min(2, window.devicePixelRatio || 1)));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = Math.max(1, Math.round((bmp.height * w) / bmp.width));
    const g = canvas.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, canvas.width, canvas.height);
    g.drawImage(bmp, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.82);
  } finally {
    bmp.close?.();
  }
}
/** [ref, src]: the first page of a PDF, or a photo, (up to 8 MB) once its element has been on screen */
export function useFirstPage(f, width) {
  const ref = useRef(null);
  const fmt = formatOf(f);
  const can = !!f?.id && (fmt === 'PDF' || fmt === 'Photo') && (f.size || 0) <= 8 * 1048576;
  const [src, setSrc] = useState(() => (can ? pageKept(f, width) : ''));
  useEffect(() => {
    if (!can || src || !ref.current || !('IntersectionObserver' in window)) return undefined;
    let live = true;
    const io = new IntersectionObserver((seen) => {
      if (!seen.some((e) => e.isIntersecting)) return;
      io.disconnect();
      drawSoon(() => (fmt === 'Photo' ? firstPhoto : firstPage)(f, width)).then((data) => {
        if (!live) return;
        try { localStorage.setItem(pageKey(f, width), data); } catch { /* full: drawn again next time */ }
        setSrc(data);
      }).catch(() => {});
    }, { rootMargin: '240px' });
    io.observe(ref.current);
    return () => { live = false; io.disconnect(); };
  }, [f?.id]);
  return [ref, src];
}
export function FileBadge({ f }) {
  const [ref, src] = useFirstPage(f, 48);
  const fmt = formatOf(f);
  return html`<span class=${`bp-badge ${src ? 'has-page' : ''}`} data-format=${fmt} ref=${ref} aria-hidden="true">${src ? html`<img src=${src} alt="" />` : ({ PDF: 'PDF', Excel: 'XLS', Word: 'DOC', Slides: 'PPT', Photo: 'IMG' }[fmt] || 'FILE')}</span>`;
}

/** What a cover says it is, in a word or two */
export function coverWord(title) {
  const t = String(title);
  for (const [re, w] of [[/bylaw/i, 'Bylaws'], [/articles of incorporation|certificate of incorporation/i, 'Articles of Incorporation'], [/amend/i, 'Amendment'], [/manual/i, 'Board Manual'], [/conflict/i, 'Conflict of Interest'], [/whistle/i, 'Whistleblower'], [/501|determination/i, 'IRS Letter'], [/\bein\b/i, 'EIN'], [/w-?9/i, 'W-9'], [/permit/i, 'Charitable Permit'], [/d&o|directors.*officers/i, 'D&O Insurance'], [/insurance/i, 'Insurance'], [/strateg/i, 'Strategic Plan'], [/budget/i, 'Budget'], [/audit/i, 'Audit']]) if (re.test(t)) return w;
  return t.length > 28 ? `${t.slice(0, 26).trim()}…` : t;
}
const yearOf = (x) => x.year || (String(x.title).match(/\b(19|20)\d{2}\b/) || [])[0] || '';
/** A cover's longest word fits across it: past nine letters, set smaller ("Expectations", "Whistleblower") */
const coverFit = (w) => { const n = Math.max(...String(w).split(/\s+/).map((x) => x.length)); return n > 9 ? `font-size:${Math.max(0.62, 9 / n).toFixed(3)}em` : null; };
export function Cover({ x, shelf }) {
  // A paper written in Board is read as its words: its cover is its own, not its PDF's
  const [ref, page] = useFirstPage(x.body ? null : x.file, 200);
  const src = x.body ? '' : page;
  return html`<span class=${`bp-cover bp-cover--${shelf} ${src ? 'has-page' : ''}`} ref=${ref} aria-hidden="true">
    ${src ? html`<img class="bp-cover__page" src=${src} alt="" />` : null}
    <span class="bp-cover__org">Sunshine on a Ranney Day</span>
    <span class="bp-cover__word" style=${coverFit(coverWord(x.title))}>${coverWord(x.title)}</span>
    <span class="bp-cover__rule"></span>
    ${yearOf(x) ? html`<span class="bp-cover__year">${yearOf(x)}</span>` : null}
    ${x.file && !x.body ? html`<span class="bp-cover__fmt">${{ PDF: 'PDF', Excel: 'XLS', Word: 'DOC' }[formatOf(x.file)] || ''}</span>` : null}
  </span>`;
}
