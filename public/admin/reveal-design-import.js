/**
 * reveal-design-import.js — Admin → Kids: a kid's design for their reveal
 * ===========================================================================
 * Loaded the first time someone opens one of these from the kid editor
 * (public/admin/index.html):
 *
 * RevealImport ("Bring in from JobTread"): the drawings, design boards and
 * before photos on the kid's JobTread job (/api/reveal-design-admin), ready
 * to add to the profile. Every page of each plan set is drawn here with the
 * admin's pdf.js, and sorted by its title (./reveal-design-draw.js
 * kindFromSheet): the as-built and proposed floor plans and any design boards
 * are picked to start, from the newest final set, with six before photos
 * spread across the visit, but only the first time: once the profile has
 * anything from JobTread, staff pick.
 *
 * The family's address (a hard rule): a picked drawing goes up exactly as it
 * shows here. Wherever the PDF's own words have the address they're painted
 * out, and a real title block is cut off. A drawing whose address wasn't
 * found by its words (a picture, a scanned PDF, a job with no address on
 * file) can't be added until staff cover it with the Cover tool or tick
 * "I checked: no address on it". Each plan carries what was done
 * (plan.addressCheck 'wiped' | 'covered' | 'checked', ./reveal-design.js).
 * Nothing is saved here: Add hands the files to the editor, which uploads
 * them into its sections, and the editor's Save keeps them.
 *
 * CoverDialog: the Cover tool on a drawing already on the profile (the
 * editor uploads the covered copy). Drag boxes over anything that gives the
 * address away; they go up white. Undo, keyboard (Add a box, then arrow keys
 * to move it, Shift and arrows to size it, Delete to remove it) and touch.
 *
 * RevealPreview ("Preview the reveal screen"): the real starting-soon screen
 * (/live/<slug>/slate/?design=preview) in a frame, showing the editor's
 * unsaved design (window.__soardRevealDesign, set by the editor), with steps
 * to jump to each part (?slide=N; slide 0 is the kid's own photo).
 */
import { h, htm, useState, useEffect, useRef, useMemo, useCallback } from './vendor.js';
import { PLAN_KINDS, kindFromText, suggestBefores, addressWords, BEFORE_SHOWN } from './reveal-design.js';
import { findAddress, sheetTitle, kindFromSheet, keepBox, captionOf, coverRects } from './reveal-design-draw.js';
import { ask } from './ask.js';

const html = htm.bind(h);
const MAX_EDGE = 2400; // the long side of a drawing as it goes up
const THUMB_W = 360;
const KIND = Object.fromEntries(PLAN_KINDS.map((k) => [k.id, k]));
const SHORT = { 'as-built': 'As-built', proposed: 'Proposed', board: 'Board' };
const KIND_RANK = { 'as-built': 0, proposed: 1, board: 2 };

// ── Styles (admin tokens; injected once) ──
const CSS = `
.rdi .kd-dialog__body, .rdc .kd-dialog__body { display: flex; flex-direction: column; gap: 1.25rem; }
.rdi .notice { margin: 0; }
.rdi-sec { display: flex; flex-direction: column; gap: 0.75rem; }
.rdi-sec__head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.35rem 0.75rem; }
.rdi-sec__head h3 { margin: 0; font-size: var(--fs-md, 1.05rem); }
.rdi-sec__head p { margin: 0; font-size: var(--fs-xs); color: var(--color-text-muted); }
.rdi-file { display: flex; flex-wrap: wrap; align-items: center; gap: 0.35rem 0.6rem; margin: 0; font-size: var(--fs-xs); color: var(--color-text-secondary); }
.rdi-file strong { color: var(--color-text); font-size: var(--fs-sm); overflow-wrap: anywhere; }
.rdi-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 0.75rem; list-style: none; margin: 0; padding: 0; }
.rdi-grid--photos { grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); }
.rdi-tile { position: relative; display: flex; flex-direction: column; border: 1px solid var(--color-border); border-radius: 12px; background: var(--color-bg-card); min-width: 0; }
.rdi-tile.is-on { border-color: var(--color-text); box-shadow: 0 0 0 1px var(--color-text); }
.rdi-tile.is-on.is-needs { border-color: var(--tone-warn-line-strong); box-shadow: 0 0 0 1px var(--tone-warn-line-strong); }
.rdi-tile.is-there { opacity: 0.6; }
.rdi-pick { position: relative; display: block; width: 100%; padding: 0; border: 0; border-radius: 11px 11px 0 0; background: #fff; cursor: pointer; overflow: hidden; aspect-ratio: 4 / 3; }
.rdi-grid--photos .rdi-pick { aspect-ratio: 1; border-radius: 11px; }
.rdi-pick:disabled { cursor: default; }
.rdi-pick:focus-visible { outline: none; box-shadow: var(--focus-ring-strong); }
.rdi-pick img { display: block; width: 100%; height: 100%; object-fit: contain; }
.rdi-grid--photos .rdi-pick img { object-fit: cover; }
.rdi-ph { display: grid; place-items: center; width: 100%; height: 100%; padding: 0.5rem; font-size: var(--fs-2xs); color: var(--color-text-muted); background: var(--seg-bg); text-align: center; overflow-wrap: anywhere; }
.rdi-check { position: absolute; top: 8px; right: 8px; display: grid; place-items: center; width: 24px; height: 24px; border-radius: 999px; border: 2px solid #fff; background: rgba(20,21,24,0.35); color: #fff; box-shadow: 0 1px 3px rgba(0,0,0,0.25); }
.rdi-check svg { width: 14px; height: 14px; opacity: 0; }
.is-on .rdi-check { background: var(--color-text); }
.is-on .rdi-check svg { opacity: 1; }
.rdi-n { position: absolute; right: 8px; bottom: 8px; padding: 0.05rem 0.4rem; border-radius: 999px; background: rgba(20,21,24,0.62); color: #fff; font-size: var(--fs-2xs); font-weight: 700; }
.rdi-busy { position: absolute; inset: 0; display: grid; place-items: center; background: rgba(255,255,255,0.7); }
.rdi-body { display: flex; flex-direction: column; gap: 0.45rem; padding: 0.6rem; }
.rdi-sheet { margin: 0; font-size: var(--fs-xs); font-weight: 600; color: var(--color-text); overflow-wrap: anywhere; }
.rdi-sheet span { font-weight: 400; color: var(--color-text-muted); }
.rdi-body .seg, .rdc-bar .seg { align-self: stretch; }
.rdi-body .seg > [role="radio"] { flex: 1 1 0; justify-content: center; padding-inline: 0.4rem; font-size: var(--fs-xs); }
.rdi-meta { display: flex; flex-wrap: wrap; align-items: center; gap: 0.35rem 0.5rem; font-size: var(--fs-2xs); color: var(--color-text-muted); }
.rdi-meta a { color: inherit; }
.rdi-addr { display: flex; flex-direction: column; gap: 0.4rem; padding: 0.5rem 0.55rem; border-radius: 10px; background: var(--color-bg-secondary); }
.is-needs .rdi-addr { background: var(--tone-warn-surface); border: 1px solid var(--tone-warn-line); }
.rdi-addr p { margin: 0; font-size: var(--fs-2xs); line-height: 1.45; color: var(--color-text-secondary); }
.rdi-addr .btn { align-self: flex-start; }
.rdi-tick { display: flex; align-items: flex-start; gap: 0.45rem; font-size: var(--fs-xs); color: var(--color-text); cursor: pointer; }
.rdi-tick input { margin-top: 2px; width: 16px; height: 16px; flex-shrink: 0; }
.rdi-empty { margin: 0; padding: 1rem; border: 1px dashed var(--color-border-strong); border-radius: 12px; font-size: var(--fs-sm); color: var(--color-text-secondary); }
.rdi-skel { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 0.75rem; }
.rdi-skel span { aspect-ratio: 4 / 3; border-radius: 12px; background: var(--seg-bg); }
.rdi-foot { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; width: 100%; }
.rdi-foot__status { flex: 1 1 220px; font-size: var(--fs-xs); color: var(--color-text-muted); }
.rdi-foot__status.is-warn { color: var(--tone-warn-fg); font-weight: 600; }
.rdi-foot .btn-primary { margin-left: auto; }
/* The Cover tool */
.rdc-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; }
.rdc-bar p { margin: 0; flex: 1 1 240px; font-size: var(--fs-xs); color: var(--color-text-muted); }
.rdc-stage { position: relative; max-height: min(62vh, 640px); overflow: auto; border-radius: 12px; background: var(--seg-bg); padding: 0.5rem; }
.rdc-sheet { position: relative; margin: 0 auto; background: #fff; box-shadow: var(--shadow-sm); }
.rdc-sheet img { display: block; width: 100%; height: auto; user-select: none; -webkit-user-drag: none; pointer-events: none; }
.rdc-layer { position: absolute; inset: 0; cursor: crosshair; touch-action: pinch-zoom; }
.rdc-box { position: absolute; background: #fff; outline: 2px dashed var(--tone-warn-fg); outline-offset: -1px; cursor: move; touch-action: none; }
.rdc-box:focus-visible, .rdc-box.is-on { outline: 2px solid var(--color-text); box-shadow: 0 0 0 4px rgba(255,255,255,0.9), 0 0 0 6px var(--color-text); }
.rdc-box--drawing { outline-style: solid; opacity: 0.85; pointer-events: none; }
.rdc-foot { display: flex; flex-wrap: wrap; gap: 0.5rem; width: 100%; justify-content: flex-end; }
.rdp .kd-dialog__body { display: flex; flex-direction: column; gap: 0.75rem; }
.rdp-bar { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem 0.75rem; }
.rdp-steps { display: flex; flex-wrap: wrap; gap: 0.35rem; }
.rdp .notice { margin: 0; }
.rdp-stage { display: grid; place-items: center; min-height: 0; background: var(--seg-bg); border-radius: 12px; padding: 0.75rem; }
.rdp-frame { position: relative; width: 100%; max-width: 100%; border-radius: 8px; overflow: hidden; background: #fff; box-shadow: var(--shadow-sm); }
.rdp-frame iframe { position: absolute; inset: 0; width: 100%; height: 100%; border: 0; }
.rdp-frame--landscape { aspect-ratio: 16 / 9; width: min(100%, calc((100vh - 380px) * 16 / 9)); min-width: 280px; }
.rdp-frame--portrait { aspect-ratio: 9 / 16; width: auto; height: min(calc(100vh - 380px), 720px); min-height: 280px; }
.rlp-when { color: var(--color-text-muted, #5A5B61); font-size: var(--fs-sm, 0.9rem); }
.rlp-stage { overflow: hidden; }
.rlp-device { position: relative; overflow: hidden; border-radius: 14px; background: #fff; box-shadow: var(--shadow-sm); }
.rlp-device iframe { position: absolute; top: 0; left: 0; border: 0; transform-origin: 0 0; }
.rlp-wait { margin: 2rem 0; color: var(--color-text-muted, #5A5B61); }
@media (max-width: 640px) {
  .rdi-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.5rem; }
  /* A picked drawing takes the whole row: a bigger look at what goes up, and room for what it is */
  .rdi-grid:not(.rdi-grid--photos) > .rdi-tile.is-on { grid-column: 1 / -1; }
  .rdi-grid--photos { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  .rdi-body { padding: 0.5rem; }
  .rdi-foot .btn, .rdc-foot .btn { flex: 1 1 auto; }
  .rdi-foot .btn-primary { margin-left: 0; }
  .rdp-frame--landscape { width: 100%; min-width: 0; }
  .rdp-frame--portrait { height: min(60vh, 560px); }
  .rdc-stage { max-height: 58vh; }
}
`;
function useStyles() {
  useEffect(() => {
    if (document.getElementById('rdi-style')) return;
    const el = document.createElement('style');
    el.id = 'rdi-style';
    el.textContent = CSS;
    document.head.append(el);
  }, []);
}

const icon = {
  check: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>`,
  shield: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>`,
  alert: html`<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>`,
};
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const possessive = (name) => (/s$/i.test(name || '') ? `${name}’` : `${name}’s`);
const fileDay = (iso) => { try { return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); } catch { return ''; } };
const tagWords = (tags) => (tags || []).map((t) => String(t).replace(/^[._:]/, '').replace(/([a-z])([A-Z])/g, '$1 $2')).join(', ');
const slugOf = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'drawing';
/** One sentence, ending in one full stop, whatever the message came with */
const sentence = (msg) => { const m = String(msg || '').trim().replace(/[\s.]+$/, ''); return m ? `${m}.` : ''; };
/** A failure Try again can't fix (the file isn't something a browser can draw) */
class CantRead extends Error {}

/** Arrow keys move the choice in a group of role="radio" buttons (one tab stop for the group) */
export function radioKeys(e, ids, current, pick) {
  const k = e.key;
  if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(k)) return;
  e.preventDefault();
  const i = Math.max(0, ids.indexOf(current));
  const next = k === 'Home' ? 0 : k === 'End' ? ids.length - 1 : (i + (k === 'ArrowLeft' || k === 'ArrowUp' ? -1 : 1) + ids.length) % ids.length;
  pick(ids[next]);
  const group = e.currentTarget.closest('[role="radiogroup"]');
  requestAnimationFrame(() => group?.querySelectorAll('[role="radio"]')[next]?.focus());
}

// ── Files from JobTread's CDN: straight from it, or through the admin when the browser can't reach it ──
const viaSite = (url) => `/api/applicants-admin?cdn=${encodeURIComponent(url)}`;
async function fetchJt(url, signal) {
  let r = await fetch(url, { credentials: 'omit', signal }).catch((e) => (signal?.aborted ? Promise.reject(e) : null));
  if (!r?.ok) r = await fetch(viaSite(url), { signal });
  if (!r.ok) throw new Error(`JobTread answered ${r.status}`);
  return r.blob();
}

// ── iPhone photos (HEIC): the admin's converter (./vendor-heic.js), loaded only then ──
const looksHeic = (type, name) => /^image\/hei[cf]$/i.test(type || '') || /\.hei[cf]$/i.test(name || '');
async function readable(blob, name = '') {
  let heic = looksHeic(blob.type, name);
  if (!heic && !/^image\/(png|jpe?g|webp|gif)$/i.test(blob.type || '') && !/pdf/i.test(blob.type || '')) {
    try { heic = await (await import('./vendor-heic.js')).isHeic(blob); } catch { heic = false; }
  }
  if (!heic) return blob;
  try {
    const { heicTo } = await import('./vendor-heic.js');
    return await heicTo({ blob, type: 'image/jpeg', quality: 0.92 });
  } catch {
    throw new CantRead('This iPhone photo couldn’t be converted in this browser');
  }
}
async function bitmapOf(blob, name) {
  try { return await createImageBitmap(await readable(blob, name)); } catch (e) {
    if (e instanceof CantRead) throw e;
    throw new CantRead('It isn’t a picture this browser can draw');
  }
}

// ── pdf.js (the file viewer's copy) ──
let pdfModule = null;
let pdfWorker = null;
const loadPdf = () => (pdfModule ||= import('./vendor-pdf.js').catch((e) => { pdfModule = null; throw e; }));
async function openPdf(blob) {
  const { pdfjsLib } = await loadPdf();
  pdfWorker ||= new pdfjsLib.PDFWorker();
  const base = new URL('./pdf/', import.meta.url).href;
  try {
    return await pdfjsLib.getDocument({
      data: new Uint8Array(await blob.arrayBuffer()), worker: pdfWorker,
      standardFontDataUrl: `${base}standard_fonts/`, wasmUrl: `${base}wasm/`, useWasm: false, enableXfa: false,
    }).promise;
  } catch (e) {
    throw new CantRead(/password/i.test(e?.name || e?.message || '') ? 'It’s locked with a password' : 'It isn’t a PDF this browser can open');
  }
}

const canvasOf = (w, h) => { const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w)); c.height = Math.max(1, Math.round(h)); return c; };
const toBlob = (c, type = 'image/png', q) => new Promise((done, fail) => c.toBlob((b) => (b ? done(b) : fail(new Error('The drawing couldn’t be made'))), type, q));
function paintOver(ctx, boxes) {
  ctx.save();
  ctx.fillStyle = '#fff';
  for (const b of boxes) { ctx.beginPath(); ctx.moveTo(b[0][0], b[0][1]); for (let i = 1; i < 4; i++) ctx.lineTo(b[i][0], b[i][1]); ctx.closePath(); ctx.fill(); }
  ctx.restore();
}

/**
 * Draws one page at a width (or long edge), with the address painted out wherever its words are.
 * → { canvas, wiped (boxes painted), hits (address words found), textLayer, title, body }
 */
async function drawPage(page, { width, longEdge, words }) {
  const base = page.getViewport({ scale: 1 });
  const scale = longEdge ? longEdge / Math.max(base.width, base.height) : width / base.width;
  const viewport = page.getViewport({ scale });
  const canvas = canvasOf(viewport.width, viewport.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: !!longEdge });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvas, canvasContext: ctx, viewport, background: '#ffffff' }).promise;
  const content = await page.getTextContent().catch(() => ({ items: [] }));
  const { boxes, hits } = findAddress(content.items, viewport.transform, scale, words);
  paintOver(ctx, boxes);
  const textLayer = content.items.some((i) => String(i.str || '').trim());
  const title = sheetTitle(content.items, viewport.transform, scale, words);
  const body = content.items.map((i) => i.str || '').join(' ').replace(/\s+/g, ' ').trim();
  return { canvas, wiped: boxes.length, hits, textLayer, title, body };
}

/** A sheet as it goes up: a real title block cut off and the white margin trimmed. → { blob, w, h, trimmed } */
async function finish(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const box = keepBox(data, canvas.width, canvas.height);
  const out = canvasOf(box.w, box.h);
  out.getContext('2d').drawImage(canvas, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);
  return { blob: await toBlob(out), w: out.width, h: out.height, trimmed: box.titleBlock };
}

/** A picture (a board, a rendering or a scanned sheet) on white, no bigger than MAX_EDGE */
async function drawPicture(blob, name) {
  const bmp = await bitmapOf(blob, name);
  const k = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
  const c = canvasOf(bmp.width * k, bmp.height * k);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  return c;
}

/** A picture with boxes painted white over it: exactly what goes up. → { blob, w, h } */
export async function paintCovered(blob, boxes) {
  const bmp = await bitmapOf(blob);
  const c = canvasOf(bmp.width, bmp.height);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(bmp, 0, 0);
  bmp.close?.();
  ctx.fillStyle = '#fff';
  for (const r of coverRects(boxes, c.width, c.height)) ctx.fillRect(r.x, r.y, r.w, r.h);
  return { blob: await toBlob(c), w: c.width, h: c.height };
}

// ═══════════════════════════════════════════
// The Cover tool
// ═══════════════════════════════════════════
const NEW_BOX = { x: 0.4, y: 0.45, w: 0.2, h: 0.07 };
const clamp01 = (v) => Math.max(0, Math.min(1, v));
const fitBox = (b) => { const w = Math.max(0.01, Math.min(1, b.w)); const h = Math.max(0.01, Math.min(1, b.h)); return { w, h, x: Math.max(0, Math.min(1 - w, b.x)), y: Math.max(0, Math.min(1 - h, b.y)) }; };

/** The drawing, big, with boxes drawn over it: drag on it to draw one, drag a box to move it */
function CoverCanvas({ src, boxes, onBoxes, zoom, label, disabled }) {
  const sheet = useRef(null);
  const [sel, setSel] = useState(-1);
  const [drawing, setDrawing] = useState(null); // { x0, y0, x1, y1 } while a box is drawn
  const move = useRef(null);
  const at = (e) => { const r = sheet.current.getBoundingClientRect(); return { x: clamp01((e.clientX - r.left) / r.width), y: clamp01((e.clientY - r.top) / r.height) }; };
  const down = (e) => {
    if (disabled || e.button > 0) return;
    const p = at(e);
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setDrawing({ x0: p.x, y0: p.y, x1: p.x, y1: p.y });
    setSel(-1);
  };
  const drag = (e) => { if (!drawing) return; const p = at(e); setDrawing((d) => (d ? { ...d, x1: p.x, y1: p.y } : d)); };
  const up = () => {
    if (!drawing) return;
    const b = { x: Math.min(drawing.x0, drawing.x1), y: Math.min(drawing.y0, drawing.y1), w: Math.abs(drawing.x1 - drawing.x0), h: Math.abs(drawing.y1 - drawing.y0) };
    setDrawing(null);
    if (b.w > 0.006 && b.h > 0.004) { onBoxes([...boxes, b]); setSel(boxes.length); }
  };
  const boxDown = (e, i) => {
    if (disabled) return;
    e.stopPropagation();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    const p = at(e);
    move.current = { i, dx: p.x - boxes[i].x, dy: p.y - boxes[i].y, start: boxes };
    setSel(i);
  };
  const boxMove = (e) => {
    const m = move.current;
    if (!m) return;
    const p = at(e);
    onBoxes(m.start.map((b, j) => (j === m.i ? fitBox({ ...b, x: p.x - m.dx, y: p.y - m.dy }) : b)), { from: m.start });
  };
  const boxUp = () => { move.current = null; };
  const key = (e, i) => {
    const step = e.altKey ? 0.002 : 0.01;
    const dir = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
    if (dir) {
      e.preventDefault();
      const b = boxes[i];
      const nb = e.shiftKey ? fitBox({ ...b, w: b.w + dir[0] * step, h: b.h + dir[1] * step }) : fitBox({ ...b, x: b.x + dir[0] * step, y: b.y + dir[1] * step });
      onBoxes(boxes.map((x, j) => (j === i ? nb : x)));
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      onBoxes(boxes.filter((_, j) => j !== i));
      setSel(-1);
      requestAnimationFrame(() => sheet.current?.closest('.rdc')?.querySelector('[data-add-box]')?.focus());
    }
  };
  const pct = (v) => `${(v * 100).toFixed(3)}%`;
  const live = drawing ? { x: Math.min(drawing.x0, drawing.x1), y: Math.min(drawing.y0, drawing.y1), w: Math.abs(drawing.x1 - drawing.x0), h: Math.abs(drawing.y1 - drawing.y0) } : null;
  return html`<div class="rdc-stage">
    <div class="rdc-sheet" ref=${sheet} style=${`width:${zoom === 'big' ? '220%' : '100%'}`}>
      <img src=${src} alt=${label} draggable=${false} />
      <div class="rdc-layer" onPointerDown=${down} onPointerMove=${drag} onPointerUp=${up} onPointerCancel=${() => setDrawing(null)} aria-hidden="true"></div>
      ${boxes.map((b, i) => html`<div key=${i} class=${`rdc-box${sel === i ? ' is-on' : ''}`} tabindex="0" role="button"
        aria-label=${`Covered area ${i + 1} of ${boxes.length}. Arrow keys move it, Shift and arrow keys size it, Delete removes it.`}
        style=${`left:${pct(b.x)};top:${pct(b.y)};width:${pct(b.w)};height:${pct(b.h)}`}
        onPointerDown=${(e) => boxDown(e, i)} onPointerMove=${boxMove} onPointerUp=${boxUp} onPointerCancel=${boxUp}
        onFocus=${() => setSel(i)} onKeyDown=${(e) => key(e, i)}></div>`)}
      ${live ? html`<div class="rdc-box rdc-box--drawing" style=${`left:${pct(live.x)};top:${pct(live.y)};width:${pct(live.w)};height:${pct(live.h)}`}></div>` : null}
    </div>
  </div>`;
}

/** The tool's bar and canvas, with its own undo. boxes/onBoxes: the caller's; returns the bar + canvas */
function CoverTool({ src, label, boxes, onBoxes, disabled }) {
  const [zoom, setZoom] = useState('fit');
  const history = useRef([]);
  // One undo step per change; a box dragged about is one change, back to where it was
  const change = (next, { from = null } = {}) => {
    const before = from || boxes;
    if (history.current.at(-1) !== before) history.current.push(before);
    onBoxes(next);
  };
  const undo = () => { const prev = history.current.pop(); if (prev) onBoxes(prev); };
  const addBox = (e) => {
    const next = [...boxes, { ...NEW_BOX, x: NEW_BOX.x + (boxes.length % 5) * 0.02, y: NEW_BOX.y + (boxes.length % 5) * 0.02 }];
    change(next);
    const tool = e.currentTarget.closest('.rdc');
    requestAnimationFrame(() => { const all = tool?.querySelectorAll('.rdc-box:not(.rdc-box--drawing)'); all?.[all.length - 1]?.focus(); });
  };
  const zooms = ['fit', 'big'];
  return html`
    <div class="rdc-bar">
      <p>Drag over the family’s address (and their name) wherever it shows. Covered areas go up white.</p>
      <div class="seg" role="radiogroup" aria-label="Size">
        ${zooms.map((z) => html`<button type="button" role="radio" aria-checked=${zoom === z} tabindex=${zoom === z ? 0 : -1}
          onKeyDown=${(e) => radioKeys(e, zooms, zoom, setZoom)} onClick=${() => setZoom(z)}>${z === 'fit' ? 'Fit' : 'Zoom in'}</button>`)}
      </div>
      <button type="button" class="btn btn-ghost btn-sm" data-add-box onClick=${addBox} disabled=${disabled}>Add a box</button>
      <button type="button" class="btn btn-ghost btn-sm" onClick=${undo} disabled=${disabled || !history.current.length}>Undo</button>
      <button type="button" class="btn btn-ghost btn-sm" onClick=${() => change([])} disabled=${disabled || !boxes.length}>Clear</button>
    </div>
    <${CoverCanvas} src=${src} boxes=${boxes} onBoxes=${change} zoom=${zoom} label=${label} disabled=${disabled} />
    <p class="sr-only" aria-live="polite">${boxes.length ? `${plural(boxes.length, 'area')} covered` : 'Nothing covered yet'}</p>`;
}

/**
 * The Cover tool on a drawing already on the profile: src (its full size), label, Dialog, onDone({ blob, w, h, boxes }), onClose.
 * The editor uploads the covered copy in its place.
 */
export function CoverDialog({ src, label = 'Drawing', Dialog, onDone, onClose }) {
  useStyles();
  const [blob, setBlob] = useState(null);
  const [url, setUrl] = useState('');
  const [err, setErr] = useState(null);
  const [boxes, setBoxes] = useState([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let on = true;
    let made = '';
    (async () => {
      try {
        const r = await fetch(src, { credentials: 'omit' });
        if (!r.ok) throw new Error(`The picture answered ${r.status}`);
        const b = await readable(await r.blob());
        if (!on) return;
        made = URL.createObjectURL(b);
        setBlob(b); setUrl(made);
      } catch (e) { if (on) setErr(sentence(e.message)); }
    })();
    return () => { on = false; if (made) URL.revokeObjectURL(made); };
  }, [src]);
  const close = async () => {
    if (boxes.length && !(await ask({ title: 'Close without covering it?', text: 'The boxes drawn here are dropped.', yes: 'Close', no: 'Keep covering', careful: true }))) return;
    onClose();
  };
  const use = async () => {
    setBusy(true);
    try { onDone({ ...(await paintCovered(blob, boxes)), boxes: boxes.length }); onClose(); } catch (e) { setBusy(false); setErr(sentence(e.message)); }
  };
  const footer = html`<div class="rdc-foot">
    <button type="button" class="btn btn-ghost" onClick=${close}>Cancel</button>
    <button type="button" class="btn btn-primary" disabled=${!blob || !boxes.length || busy} onClick=${use}>${busy ? html`<span class="spinner" /> Covering…` : `Cover ${boxes.length ? plural(boxes.length, 'area') : 'it'}`}</button>
  </div>`;
  return html`<${Dialog} title=${`Cover the address: ${label}`} sub="A covered copy goes up in its place when you save the profile." onClose=${close} size="lg" className="rdc" footer=${footer}>
    ${err ? html`<p class="notice notice--warn">${icon.alert}<span class="notice__body">Couldn’t open the drawing. ${err}</span></p>`
      : url ? html`<${CoverTool} src=${url} label=${label} boxes=${boxes} onBoxes=${setBoxes} disabled=${busy} />`
      : html`<div class="rdi-skel" aria-hidden="true"><span /></div>`}
  <//>`;
}

// ═══════════════════════════════════════════
// Bring in from JobTread
// ═══════════════════════════════════════════
/** What was done about the address on a prepared drawing: 'covered', 'wiped', 'checked', or null (still to look at) */
const addressDone = (r) => (r?.boxes?.length ? 'covered' : r?.street ? 'wiped' : r?.checked ? 'checked' : null);

/**
 * kid { slug, name, year }, jobId (the kid's JobTread job, if the editor knows it),
 * revealed (the room has been revealed), plans / pairs: the editor's lists,
 * Dialog: the admin's KdDialogBox, onAdd({ drawings, befores }), onClose().
 *   drawings: [{ file, type, label, source, w, h, addressCheck }]
 *   befores:  [{ file, alt, source }]
 */
export function RevealImport({ kid, jobId = '', revealed = false, plans = [], pairs = [], Dialog, onAdd, onClose }) {
  useStyles();
  const name = kid?.name || 'This kid';
  const [load, setLoad] = useState({ state: 'loading' }); // loading | ready | failed
  const [files, setFiles] = useState({}); // fileId → { state: loading|ready|failed, pages, of, error, retry }
  const [picks, setPicks] = useState({}); // drawing key → { on, kind, label }
  const [ready, setReady] = useState({}); // drawing key → { state: working|ready|failed, url, blob, base, w, h, wiped, street, textLayer, trimmed, boxes, checked, error }
  const [befores, setBefores] = useState(new Set()); // file ids
  const [adding, setAdding] = useState(null); // { done, total } while getting files ready to add
  const [covering, setCovering] = useState(null); // { key, boxes } while the Cover tool is open
  const touched = useRef(false);
  const alive = useRef(true);
  const abort = useRef(new AbortController());
  const docs = useRef(new Map()); // fileId → { doc } | { picture: canvas }
  const urls = useRef([]);
  const queue = useRef(Promise.resolve());
  const chosen = useRef({ 'as-built': false, proposed: false, board: null });

  const had = useMemo(() => new Set([...(plans || []).map((p) => p.source), ...(pairs || []).map((p) => p.source)].filter(Boolean)), [plans, pairs]);
  const fromJt = (x) => String(x?.source || '').startsWith('jt:');
  // Picked to start only the first time: once the profile has drawings (or before photos) from JobTread, staff pick
  const startDrawings = useRef(!(plans || []).some(fromJt));
  const data = load.state === 'ready' ? load.data : null;
  const words = useMemo(() => (data ? addressWords(data.address) : []), [data]);
  const streetWords = useMemo(() => new Set(data?.address?.street ? addressWords({ street: data.address.street }) : []), [data]);
  const hasStreet = streetWords.size > 0;

  useEffect(() => () => {
    alive.current = false;
    abort.current.abort();
    for (const u of urls.current) URL.revokeObjectURL(u);
    for (const d of docs.current.values()) d.doc?.destroy?.();
  }, []);
  const keepUrl = (blob) => { const u = URL.createObjectURL(blob); urls.current.push(u); return u; };

  // ── What JobTread has ──
  const fetchList = useCallback(async () => {
    setLoad({ state: 'loading' });
    try {
      const q = new URLSearchParams({ kid: kid.slug, ...(jobId ? { job: jobId } : {}) });
      const r = await fetch(`/api/reveal-design-admin?${q}`, { cache: 'no-store', signal: abort.current.signal });
      const d = await r.json().catch(() => ({ success: false, error: `The server answered ${r.status}` }));
      if (!alive.current) return;
      if (!d.success) throw new Error(d.error || 'JobTread couldn’t be read');
      setLoad({ state: 'ready', data: d });
      // Six before photos to start, spread across the visit: only before the reveal, and only the first time
      if (!revealed && !(pairs || []).some(fromJt)) setBefores(new Set(suggestBefores(d.befores, BEFORE_SHOWN).map((f) => f.id)));
    } catch (e) {
      if (alive.current && !abort.current.signal.aborted) setLoad({ state: 'failed', error: e.message });
    }
  }, [kid.slug, jobId]);
  useEffect(() => { fetchList(); }, [fetchList]);

  // ── One file: every page drawn small, the address painted out, each sorted by its title ──
  const openFile = useCallback(async (f) => {
    setFiles((m) => ({ ...m, [f.id]: { state: 'loading', pages: null } }));
    try {
      const blob = await fetchJt(f.url, abort.current.signal).catch((e) => { throw Object.assign(new Error(e.message), { retry: true }); });
      const pdf = /pdf/i.test(f.type) || /\.pdf$/i.test(f.name);
      const sheetsOf = data.sheets.filter((s) => s.fileId === f.id);
      const zeroBased = sheetsOf.some((s) => s.page === 0);
      const pages = [];
      if (pdf) {
        const doc = await openPdf(blob);
        docs.current.set(f.id, { doc });
        for (let n = 1; n <= doc.numPages; n++) {
          if (!alive.current) return;
          const page = await doc.getPage(n);
          const drawn = await drawPage(page, { width: THUMB_W, words });
          const sheet = sheetsOf.find((s) => s.page === (zeroBased ? n - 1 : n))?.name || '';
          const { kind, title } = kindFromSheet({ sheet, title: drawn.title, body: drawn.body }, kindFromText);
          pages.push({ n, sheet, title, guess: kind, thumb: keepUrl(await toBlob(drawn.canvas, 'image/jpeg', 0.85)) });
          page.cleanup?.();
          setFiles((m) => ({ ...m, [f.id]: { state: 'loading', pages: [...pages], of: doc.numPages } }));
        }
      } else {
        const canvas = await drawPicture(blob, f.name);
        docs.current.set(f.id, { picture: canvas });
        const small = canvasOf(THUMB_W, (canvas.height / canvas.width) * THUMB_W);
        small.getContext('2d').drawImage(canvas, 0, 0, small.width, small.height);
        const label = f.name.replace(/\.\w+$/, '');
        const guess = kindFromSheet({ sheet: label }, kindFromText).kind || (/png|hei[cf]$/i.test(f.type) || /\.(png|heic|heif)$/i.test(f.name) ? 'board' : null);
        pages.push({ n: null, sheet: label, title: label, guess, thumb: keepUrl(await toBlob(small, 'image/jpeg', 0.85)) });
      }
      setFiles((m) => ({ ...m, [f.id]: { state: 'ready', pages } }));
      // Picked to start (the first time only): one as-built and one proposed plan, and the boards, each from the first set that has them
      if (!startDrawings.current || touched.current) return;
      const start = {};
      const c = chosen.current;
      for (const p of pages) {
        const key = p.n == null ? `jt:${f.id}` : `jt:${f.id}#${p.n}`;
        if (had.has(key) || !p.guess) continue;
        const take = p.guess === 'board' ? (c.board == null || c.board === f.id) : !c[p.guess];
        if (!take) continue;
        if (p.guess === 'board') c.board = f.id; else c[p.guess] = true;
        start[key] = { on: true, kind: p.guess, label: captionOf(p.sheet || p.title) || KIND[p.guess].long };
      }
      if (Object.keys(start).length) setPicks((m) => ({ ...start, ...m }));
    } catch (e) {
      if (!abort.current.signal.aborted) setFiles((m) => ({ ...m, [f.id]: { state: 'failed', pages: null, error: sentence(e.message), retry: !(e instanceof CantRead) } }));
    }
  }, [data, words, had]);
  // Every drawing file, one at a time (big PDFs are heavy)
  useEffect(() => {
    if (!data) return;
    let stop = false;
    (async () => { for (const f of data.drawings) { if (stop || !alive.current) return; await openFile(f); } })();
    return () => { stop = true; };
  }, [data]);

  // ── A picked drawing, drawn as it will go up (big, wiped, a real title block cut, trimmed) ──
  const prepare = useCallback((key) => {
    setReady((m) => ({ ...m, [key]: { state: 'working' } }));
    queue.current = queue.current.then(async () => {
      if (!alive.current) return;
      try {
        const [, fileId, n] = key.match(/^jt:([^#]+)(?:#(\d+))?$/) || [];
        const src = docs.current.get(fileId);
        if (!src) throw new Error('That file didn’t open');
        let canvas, wiped = 0, hits = new Set(), textLayer = false;
        if (src.doc) ({ canvas, wiped, hits, textLayer } = await drawPage(await src.doc.getPage(Number(n)), { longEdge: MAX_EDGE, words }));
        else { canvas = canvasOf(src.picture.width, src.picture.height); canvas.getContext('2d').drawImage(src.picture, 0, 0); }
        const out = await finish(canvas);
        if (!alive.current) return;
        // Wiped means the street itself was found by its words and painted out
        const street = [...hits].some((w) => streetWords.has(w));
        const url = keepUrl(out.blob);
        setReady((m) => (m[key]?.state === 'working' ? { ...m, [key]: { state: 'ready', ...out, base: out.blob, baseUrl: url, url, wiped, street, textLayer, boxes: [], checked: false } } : m));
      } catch (e) {
        if (alive.current) setReady((m) => ({ ...m, [key]: { state: 'failed', error: sentence(e.message) } }));
      }
    });
  }, [words, streetWords]);
  useEffect(() => {
    for (const [key, p] of Object.entries(picks)) {
      const fileId = key.slice(3).split('#')[0];
      if (p.on && !ready[key] && files[fileId]?.state === 'ready') prepare(key);
    }
  }, [picks, files]);

  const toggle = (key, guess, label) => {
    touched.current = true;
    setPicks((m) => {
      const cur = m[key];
      if (cur) return { ...m, [key]: { ...cur, on: !cur.on } };
      // Not told by its title: a page of a plan set is most likely a plan, a picture a board or rendering
      const kind = guess || (key.includes('#') ? 'proposed' : 'board');
      return { ...m, [key]: { on: true, kind, label: captionOf(label) || KIND[kind].long } };
    });
  };
  const setPick = (key, patch) => { touched.current = true; setPicks((m) => ({ ...m, [key]: { ...m[key], ...patch } })); };
  const setCheck = (key, checked) => { touched.current = true; setReady((m) => ({ ...m, [key]: { ...m[key], checked } })); };
  const flipBefore = (id) => { touched.current = true; setBefores((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; }); };

  // In the order the reveal screen plays them: as-built, proposed, boards; each by its file, then page
  const placeOf = (key) => { const [, id, n] = key.match(/^jt:([^#]+)(?:#(\d+))?$/) || []; return [Math.max(0, (data?.drawings || []).findIndex((f) => f.id === id)), Number(n) || 0]; };
  const pickedDrawings = Object.entries(picks).filter(([k, p]) => p.on && !had.has(k))
    .sort(([a, pa], [b, pb]) => (KIND_RANK[pa.kind] - KIND_RANK[pb.kind]) || (placeOf(a)[0] - placeOf(b)[0]) || (placeOf(a)[1] - placeOf(b)[1]));
  const waiting = pickedDrawings.filter(([k]) => ready[k]?.state !== 'ready');
  const failedDrawings = pickedDrawings.filter(([k]) => ready[k]?.state === 'failed');
  const needLook = pickedDrawings.filter(([k]) => ready[k]?.state === 'ready' && !addressDone(ready[k]));
  const pickedBefores = data ? data.befores.filter((f) => befores.has(f.id) && !had.has(`jt:${f.id}`)) : [];
  const total = pickedDrawings.length + pickedBefores.length;

  const close = async () => {
    if (covering) { setCovering(null); return; }
    if (adding || (touched.current && total > 0)) {
      const yes = await ask({
        title: 'Close without adding them?',
        text: `Nothing from JobTread is on ${possessive(name)} profile yet. Closing drops what’s picked here.`,
        yes: 'Close', no: 'Keep picking', careful: true,
      });
      if (!yes) return;
    }
    abort.current.abort();
    onClose();
  };

  const add = async () => {
    if (!total || waiting.length || needLook.length || adding) return;
    setAdding({ done: 0, total: pickedBefores.length });
    try {
      const drawings = pickedDrawings.map(([key, p]) => {
        const r = ready[key];
        const label = String(p.label || '').trim() || KIND[p.kind].long;
        // Looked after (wiped, covered or checked): nothing left for the site to crop off
        return { file: new File([r.blob], `${slugOf(label)}-notitle.png`, { type: 'image/png' }), type: p.kind, label, source: key, w: r.w, h: r.h, addressCheck: addressDone(r) };
      });
      const photos = [];
      for (const f of pickedBefores) {
        const got = await fetchJt(f.big || f.url, abort.current.signal);
        const blob = await readable(got, f.big ? '' : f.name);
        const type = /^image\//.test(blob.type || '') ? blob.type : 'image/jpeg';
        const ext = type === 'image/png' ? 'png' : type === 'image/webp' ? 'webp' : 'jpg';
        photos.push({ file: new File([blob], `${slugOf(f.name.replace(/\.\w+$/, ''))}.${ext}`, { type }), alt: `${possessive(name)} room before the makeover`, source: `jt:${f.id}` });
        if (!alive.current) return;
        setAdding((a) => ({ ...a, done: photos.length }));
      }
      onAdd({ drawings, befores: photos });
      onClose();
    } catch (e) {
      if (!alive.current || abort.current.signal.aborted) return;
      setAdding(null);
      ask({ title: 'Couldn’t get the before photos from JobTread', text: `${sentence(e.message)} Nothing was added.`, yes: 'OK', dismiss: true });
    }
  };

  // ── The Cover tool, inside this dialog ──
  if (covering) {
    const r = ready[covering.key];
    const p = picks[covering.key];
    const label = p?.label || 'Drawing';
    const use = async () => {
      const key = covering.key;
      const boxes = covering.boxes;
      setCovering(null);
      touched.current = true;
      if (!boxes.length) { setReady((m) => ({ ...m, [key]: { ...m[key], boxes: [], blob: m[key].base, url: m[key].baseUrl } })); return; }
      setReady((m) => ({ ...m, [key]: { ...m[key], covering: true } }));
      try {
        const out = await paintCovered(r.base, boxes);
        const url = keepUrl(out.blob);
        setReady((m) => ({ ...m, [key]: { ...m[key], covering: false, boxes, blob: out.blob, url, w: out.w, h: out.h } }));
      } catch (e) {
        setReady((m) => ({ ...m, [key]: { ...m[key], covering: false } }));
        ask({ title: 'Couldn’t cover it', text: sentence(e.message), yes: 'OK', dismiss: true });
      }
    };
    const footer = html`<div class="rdc-foot">
      <button type="button" class="btn btn-ghost" onClick=${() => setCovering(null)}>Back</button>
      <button type="button" class="btn btn-primary" onClick=${use}>${covering.boxes.length ? `Cover ${plural(covering.boxes.length, 'area')}` : r?.boxes?.length ? 'Uncover it' : 'Done'}</button>
    </div>`;
    return html`<${Dialog} title=${`Cover the address: ${label}`} sub="What you see here is what goes up, with the covered areas white." onClose=${() => setCovering(null)} size="lg" className="rdc" footer=${footer}>
      <${CoverTool} src=${r.baseUrl} label=${label} boxes=${covering.boxes} onBoxes=${(b) => setCovering((c) => ({ ...c, boxes: b }))} />
    <//>`;
  }

  // ── Drawing ──
  const kindIds = PLAN_KINDS.map((k) => k.id);
  const kindSeg = (key, p) => {
    const pickKind = (id) => setPick(key, { kind: id, ...(p.label === KIND[p.kind]?.long ? { label: KIND[id].long } : {}) });
    return html`<div class="seg" role="radiogroup" aria-label="What this drawing is">
      ${PLAN_KINDS.map((k) => html`<button type="button" role="radio" aria-checked=${p.kind === k.id} tabindex=${p.kind === k.id ? 0 : -1} title=${k.long} disabled=${!!adding}
        onKeyDown=${(e) => radioKeys(e, kindIds, p.kind, pickKind)} onClick=${() => pickKind(k.id)}>${SHORT[k.id]}</button>`)}
    </div>`;
  };

  const addressBox = (key, r) => {
    const done = addressDone(r);
    if (!r || r.state !== 'ready') return null;
    const tick = html`<label class="rdi-tick"><input type="checkbox" checked=${!!r.checked} disabled=${!!adding || !!r.boxes?.length}
      onChange=${(e) => setCheck(key, e.target.checked)} /><span>I checked: no address on it</span></label>`;
    const cover = html`<button type="button" class="btn btn-ghost btn-sm" disabled=${!!adding || r.covering} onClick=${() => setCovering({ key, boxes: r.boxes || [] })}>
      ${r.covering ? html`<span class="spinner" /> Covering…` : r.boxes?.length ? 'Change what’s covered' : done ? 'Look it over' : 'Cover the address'}</button>`;
    const why = !hasStreet ? 'JobTread has no address for this job, so it can’t be found by its words.'
      : !r.textLayer ? 'This drawing has no words to search (a picture or a scan), so the address can’t be found by its words.'
      : 'The street wasn’t found among its words. It may be drawn as lines, or spelled another way.';
    return html`<div class="rdi-addr">
      ${done === 'wiped' ? html`<span class="rdi-meta"><span class="kd-chip kd-chip--ok">${icon.check} Address wiped (${r.wiped})</span>${r.trimmed ? html`<span>Title block cut off</span>` : null}</span>`
        : done === 'covered' ? html`<span class="rdi-meta"><span class="kd-chip kd-chip--ok">${icon.check} Covered by hand (${r.boxes.length})</span></span>`
        : done === 'checked' ? html`<span class="rdi-meta"><span class="kd-chip kd-chip--quiet">Checked: no address on it</span></span>`
        : html`<span class="rdi-meta"><span class="kd-chip kd-chip--warn">${icon.alert} Check for the address</span></span><p>${why} Cover it, or tick that there’s none.</p>`}
      ${cover}
      ${done === 'wiped' || done === 'covered' ? null : tick}
    </div>`;
  };

  const drawingTile = (f, page) => {
    const key = page.n == null ? `jt:${f.id}` : `jt:${f.id}#${page.n}`;
    const there = had.has(key);
    const p = picks[key];
    const on = !!p?.on && !there;
    const r = ready[key];
    const shown = on && r?.state === 'ready' ? r.url : page.thumb;
    const where = page.n == null ? '' : `Page ${page.n}`;
    const titled = captionOf(page.sheet || page.title);
    const nameIt = titled || where || f.name;
    const needs = on && r?.state === 'ready' && !addressDone(r);
    return html`<li key=${key} class=${`rdi-tile${on ? ' is-on' : ''}${there ? ' is-there' : ''}${needs ? ' is-needs' : ''}`}>
      <button type="button" class="rdi-pick" disabled=${there || !!adding} aria-pressed=${on}
        aria-label=${`${on ? 'Picked: ' : 'Pick '}${nameIt}${where && titled ? `, ${where}` : ''}${there ? ', already on the profile' : ''}`} onClick=${() => toggle(key, page.guess, page.sheet || page.title)}>
        <img src=${shown} alt="" />
        ${there ? null : html`<span class="rdi-check" aria-hidden="true">${icon.check}</span>`}
        ${page.n != null ? html`<span class="rdi-n" aria-hidden="true">${page.n}</span>` : null}
        ${on && (r?.state === 'working' || r?.covering) ? html`<span class="rdi-busy"><span class="spinner" /></span>` : null}
      </button>
      <div class="rdi-body">
        <p class="rdi-sheet">${nameIt}${where && titled ? html` <span>${where}</span>` : null}</p>
        ${there ? html`<span class="rdi-meta"><span class="kd-chip kd-chip--ok">${icon.check} On the profile</span></span>` : null}
        ${on ? html`
          ${kindSeg(key, p)}
          <input class="form-input" value=${p.label} aria-label=${`Caption for ${nameIt}`} placeholder=${KIND[p.kind].long} disabled=${!!adding}
            onInput=${(e) => setPick(key, { label: e.target.value })} />
          ${r?.state === 'working' ? html`<span class="rdi-meta">Getting it ready…</span>`
            : r?.state === 'failed' ? html`<span class="rdi-meta"><span class="kd-chip kd-chip--warn">Couldn’t draw it. ${r.error}</span></span>`
            : addressBox(key, r)}
          ${r?.state === 'ready' ? html`<span class="rdi-meta"><a href=${r.url} target="_blank" rel="noopener">Open full size</a></span>` : null}` : null}
      </div>
    </li>`;
  };

  const drawingsSec = () => {
    if (!data.drawings.length) return html`<p class="rdi-empty">No plan sets or design boards on the job yet. JobTread files tagged .FinalPlans, .WorkingPlans, Design Documents or .BuildSpecDocs show here.</p>`;
    return data.drawings.map((f) => {
      const st = files[f.id];
      return html`<div class="rdi-sec" key=${f.id}>
        <p class="rdi-file"><strong>${f.name}</strong><span>${tagWords(f.tags)}${f.createdAt ? ` · ${fileDay(f.createdAt)}` : ''}</span>
          ${st?.state === 'loading' ? html`<span>${st.of ? `Drawing page ${(st.pages || []).length + 1} of ${st.of}…` : 'Opening…'}</span>` : null}</p>
        ${st?.state === 'failed' ? html`<p class="rdi-empty">Couldn’t open it. ${st.error}${st.retry ? html` <button type="button" class="link" onClick=${() => openFile(f)}>Try again</button>` : null}</p>` : null}
        ${st?.pages?.length ? html`<ul class="rdi-grid">${st.pages.map((pg) => drawingTile(f, pg))}</ul>`
          : st?.state !== 'failed' ? html`<div class="rdi-skel" aria-hidden="true"><span /><span /><span /></div>` : null}
      </div>`;
    });
  };

  const beforesSec = () => {
    if (!data.befores.length) return html`<p class="rdi-empty">No before photos on the job yet. Photos tagged .BeforePics (CompanyCam’s home visit photos) show here.</p>`;
    return html`<ul class="rdi-grid rdi-grid--photos">
      ${data.befores.map((f) => {
        const there = had.has(`jt:${f.id}`);
        const on = befores.has(f.id) && !there;
        // A browser can't show an iPhone photo itself: JobTread's JPEG of it, or its name until it's added
        const pic = f.thumb || (looksHeic(f.type, f.name) ? null : f.url);
        return html`<li key=${f.id} class=${`rdi-tile${on ? ' is-on' : ''}${there ? ' is-there' : ''}`}>
          <button type="button" class="rdi-pick" disabled=${there || !!adding} aria-pressed=${on} aria-label=${`${on ? 'Picked: ' : 'Pick '}${f.name}${there ? ', already on the profile' : ''}`} onClick=${() => flipBefore(f.id)}>
            ${pic ? html`<img src=${pic} alt="" loading="lazy" />` : html`<span class="rdi-ph">${f.name}<br />iPhone photo</span>`}
            ${there ? html`<span class="rdi-n">On the profile</span>` : html`<span class="rdi-check" aria-hidden="true">${icon.check}</span>`}
          </button>
        </li>`;
      })}
    </ul>`;
  };

  const body = () => {
    if (load.state === 'loading') return html`<div class="rdi-skel" aria-hidden="true"><span /><span /><span /><span /></div><p class="sr-only" role="status">Looking at ${possessive(name)} JobTread job…</p>`;
    if (load.state === 'failed') return html`<div class="empty empty--inline"><p class="empty__title">Couldn’t read JobTread</p><p class="empty__text">${sentence(load.error)}</p><div class="empty__actions"><button type="button" class="btn btn-secondary btn-sm" onClick=${fetchList}>Try again</button></div></div>`;
    if (!data.job) {
      const year = kid?.year || new Date().getFullYear();
      return html`<div class="empty empty--inline"><p class="empty__title">No JobTread job for ${name}</p><p class="empty__text">The site finds a kid’s job by their name and the profile’s year, like “${name} Lastname (${year})”. Meanwhile, use Add plans and Add before photos on this page.</p></div>`;
    }
    return html`
      ${hasStreet ? html`<p class="notice notice--info">${icon.shield}<span class="notice__body">From <strong>${data.job.name}</strong> in JobTread. We paint out the family’s address wherever its words can be read and cut off the title block. Look over each drawing before adding it: what you see on a picked drawing is exactly what goes up.</span></p>`
        : html`<p class="notice notice--warn">${icon.alert}<span class="notice__body">From <strong>${data.job.name}</strong> in JobTread. JobTread has no address for this job, so the family’s address can’t be found by its words. Look over each drawing you pick, and cover the address or tick that there’s none.</span></p>`}
      <section class="rdi-sec" aria-labelledby="rdi-drawings">
        <div class="rdi-sec__head"><h3 id="rdi-drawings">Drawings and design boards</h3><p>${pickedDrawings.length ? `${pickedDrawings.length} picked. ` : ''}${revealed ? 'They go in the Design chapter, as-built and proposed plans first.' : 'The as-built plan, the proposed plan and the boards play on the reveal screen in that order.'}</p></div>
        ${drawingsSec()}
      </section>
      <section class="rdi-sec" aria-labelledby="rdi-befores">
        <div class="rdi-sec__head"><h3 id="rdi-befores">Before photos</h3><p>${pickedBefores.length} picked. ${revealed ? 'Each needs its after photo for the Transformation chapter.' : `The first ${BEFORE_SHOWN} on the profile play on the reveal screen; each waits there for its after photo.`}</p></div>
        ${beforesSec()}
      </section>`;
  };

  const status = adding ? (adding.total ? `Getting before photos from JobTread, ${adding.done} of ${adding.total}…` : 'Adding…')
    : failedDrawings.length ? `${plural(failedDrawings.length, 'drawing')} couldn’t be drawn. Unpick ${failedDrawings.length === 1 ? 'it' : 'them'} to go on.`
    : waiting.length ? `Getting ${plural(waiting.length, 'drawing')} ready…`
    : needLook.length ? `Look over ${plural(needLook.length, 'drawing')} for the family’s address: cover it, or tick that there’s none.`
    : total ? '' : data?.job ? 'Pick what to add.' : '';
  const what = [pickedDrawings.length ? plural(pickedDrawings.length, 'drawing') : '', pickedBefores.length ? plural(pickedBefores.length, 'before photo') : ''].filter(Boolean).join(' and ');
  const footer = data?.job ? html`<div class="rdi-foot">
    <span class=${`rdi-foot__status${needLook.length && !adding && !waiting.length ? ' is-warn' : ''}`} role="status" aria-live="polite">${status}</span>
    <button type="button" class="btn btn-ghost" onClick=${close}>Cancel</button>
    <button type="button" class="btn btn-primary" disabled=${!total || waiting.length > 0 || needLook.length > 0 || !!adding} onClick=${add}>
      ${adding ? html`<span class="spinner" /> Adding…` : total ? `Add ${what}` : 'Add to the profile'}</button>
  </div>` : html`<button type="button" class="btn btn-secondary" onClick=${close}>Close</button>`;

  return html`<${Dialog} title=${`Bring in ${possessive(name)} design from JobTread`}
    sub=${revealed ? 'Drawings and design boards for the Design chapter, and before photos for the Transformation chapter.' : 'Drawings, design boards and before photos for the reveal screen and, after the reveal, the kid page.'}
    onClose=${close} size="lg" className="rdi" footer=${footer}>${body()}<//>`;
}

// ═══════════════════════════════════════════
// Preview the reveal screen
// ═══════════════════════════════════════════
const STEPS = [['before', 'The room today'], ['as-built', 'Floor plan today'], ['proposed', 'New floor plan'], ['board', 'Design boards']];
/**
 * slug, name, published (a hidden kid has no page of its own yet), kinds (the
 * design's slides in order, as the editor has them), waiting (drawings still
 * waiting for an address check), uploading (pictures still going up), Dialog, onClose
 */
export function RevealPreview({ slug, name, published = true, kinds = [], waiting = 0, uploading = 0, Dialog, onClose }) {
  useStyles();
  // The stream's picture, as Facebook and YouTube viewers see it (Preview the live page shows it inside our page)
  const [o, setO] = useState('portrait');
  const [slide, setSlide] = useState(null); // null: plays through; N: holds slide N (0 is the kid's photo)
  const [fallback, setFallback] = useState(!published);
  const base = fallback || !slug ? '/live/slate/' : `/live/${encodeURIComponent(slug)}/slate/`;
  const src = `${base}?design=preview&o=${o}${slide != null ? `&slide=${slide}` : ''}`;
  const onLoad = (e) => {
    // A profile with no page built yet gets the screen that follows whoever is next, showing this design
    try { if (!fallback && !e.currentTarget.contentDocument?.getElementById('canvas')) setFallback(true); } catch { /* not ours to read */ }
  };
  const steps = STEPS.map(([k, label]) => [k, label, kinds.indexOf(k)]).filter(([, , i]) => i >= 0);
  const shapes = ['landscape', 'portrait'];
  const who = possessive(name || 'this kid');
  return html`<${Dialog} title="Preview the stream" sub=${`What people watching on Facebook and YouTube see for the hour before ${who} reveal, with the design as it is here, saved or not. The cards with codes to scan are for people watching on a TV or laptop; the live page leaves them out (it has real Share and Give buttons).`}
    onClose=${onClose} size="lg" className="rdp" footer=${html`<button type="button" class="btn btn-secondary" onClick=${onClose}>Done</button>`}>
    ${!kinds.length ? html`<p class="notice notice--info">${icon.shield}<span class="notice__body">No design to show yet. Add plans or before photos, or bring them in from JobTread; until then the screen shows ${who} photo.</span></p>` : null}
    ${waiting ? html`<p class="notice notice--warn">${icon.alert}<span class="notice__body">${plural(waiting, 'drawing is', 'drawings are')} waiting for an address check, so ${waiting === 1 ? 'it doesn’t' : 'they don’t'} play yet.</span></p>` : null}
    ${uploading ? html`<p class="notice">${icon.alert}<span class="notice__body">${plural(uploading, 'picture')} still going up: ${uploading === 1 ? 'it shows' : 'they show'} here once ${uploading === 1 ? 'it’s' : 'they’re'} up.</span></p>` : null}
    <div class="rdp-bar">
      <div class="seg" role="radiogroup" aria-label="Screen shape">
        ${shapes.map((s) => html`<button type="button" role="radio" aria-checked=${o === s} tabindex=${o === s ? 0 : -1}
          onKeyDown=${(e) => radioKeys(e, shapes, o, setO)} onClick=${() => setO(s)}>${s === 'landscape' ? 'Landscape' : 'Portrait (phones)'}</button>`)}
      </div>
      ${steps.length ? html`<div class="rdp-steps" role="group" aria-label="Go to">
        <button type="button" class=${`btn btn-ghost btn-sm${slide == null ? ' is-on' : ''}`} aria-pressed=${slide == null} onClick=${() => setSlide(null)}>Play it all</button>
        ${steps.map(([k, label, i]) => html`<button key=${k} type="button" class=${`btn btn-ghost btn-sm${slide === i + 1 ? ' is-on' : ''}`} aria-pressed=${slide === i + 1} onClick=${() => setSlide(i + 1)}>${label}</button>`)}
      </div>` : null}
    </div>
    <div class="rdp-stage">
      <div class=${`rdp-frame rdp-frame--${o}`}>
        <iframe key=${src} src=${src} title=${`The reveal screen, ${o}`} onLoad=${onLoad} />
      </div>
    </div>
  <//>`;
}

// ═══════════════════════════════════════════
// Preview the live page
// ═══════════════════════════════════════════
// The kid's real live page (/live/<slug>/) in a frame, at the moment staff pick: the hour before (the reveal screen in
// the video box, Share and Give, the design under it), live (a past reveal's video standing in for the camera, the
// messages beside it, the design under it) or the replay. BaseLayout hands the framed page to window.__soardPreview
// before any of its own scripts run; this answers every request the page makes about the reveal from here, so nothing
// reaches the real site: no sign-ups, no messages, no counts.
const MOMENTS = [['starting', 'Starting soon'], ['live', 'Live'], ['replay', 'Replay']];
const DEVICES = [['phone', 'Phone', 390, 844], ['laptop', 'Laptop', 1280, 800]];
const STREAM_HOST_CODE = 'cuav5h47lgfe96ql';
const SAMPLE_NOTES = [
  ['A friend', 'Messages people leave for the family show here once they’re checked.'],
  ['Another friend', 'We can’t wait to see it!'],
];

/** The newest live reveal on video, to stand in for the camera: the first live replay on /reveals/ */
let standIn = null;
function standInVideo() {
  standIn ||= fetch('/reveals/', { cache: 'no-store' }).then((r) => r.text()).then((t) => {
    const doc = new DOMParser().parseFromString(t, 'text/html');
    const links = [...doc.querySelectorAll('#live-replays [data-rv-open], [data-rv-open]')];
    for (const a of links) {
      const m = String(a.getAttribute('data-embed') || '').match(/customer-([a-z0-9]+)\.cloudflarestream\.com\/([a-f0-9]{32})/i);
      if (m) return { uid: m[2], customerCode: m[1], aspect: Number(a.getAttribute('data-aspect')) || 0.5625 };
    }
    return null;
  }).catch(() => null);
  return standIn;
}

function harness({ slug, name, photo, video }) {
  return (doc, win) => {
    const moment = new URLSearchParams(win.location.search).get('moment') || 'starting';
    const now = Date.now();
    const iso = (ms) => new Date(now + ms).toISOString();
    const portrait = !video || video.aspect < 1;
    const player = video ? { kind: moment === 'replay' ? 'replay' : 'live', uid: video.uid, customerCode: video.customerCode || STREAM_HOST_CODE } : null;
    const base = {
      id: `preview-${slug}`, kidSlug: slug, kidName: name, title: `${name}’s room reveal`, message: null,
      image: photo || null, url: `${win.location.origin}/live/${slug}/`, liveUrl: `${win.location.origin}/live/${slug}/`,
      facebookUrl: 'https://www.facebook.com/SunshineOnaRanneyDay', youtubeUrl: null, instagramUrl: null,
      orientation: portrait ? 'portrait' : 'landscape', source: 'stream', updatedAt: iso(0),
      live: false, upcoming: false, replay: false, liveAt: null, endedAt: null, replayUntil: null, player: null,
    };
    const state = moment === 'live'
      ? { ...base, phase: 'live', live: true, scheduledAt: iso(-180e3), liveAt: iso(-120e3), player }
      : moment === 'replay'
        ? { ...base, phase: 'replay', replay: true, scheduledAt: iso(-3 * 3600e3), liveAt: iso(-3 * 3600e3), endedAt: iso(-2 * 3600e3), replayUntil: iso(48 * 3600e3), player }
        : { ...base, phase: 'armed', upcoming: true, scheduledAt: iso(12 * 60e3) };
    const notes = SAMPLE_NOTES.map(([n, b], i) => ({ id: `preview-${i}`, name: n, body: b, at: iso(-(3 - i) * 60e3) }));
    const json = (body, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } }));
    const realFetch = win.fetch.bind(win);
    win.fetch = (input, init = {}) => {
      const url = new URL(typeof input === 'string' ? input : input.url, win.location.href);
      const method = String(init.method || (typeof input !== 'string' && input.method) || 'GET').toUpperCase();
      const path = url.pathname;
      if (path === '/api/broadcast') return json({ state, reminders: { enabled: true, email: true, sms: false, push: false, pushKey: null, hours: [24, 1] }, messages: { enabled: true }, timezone: 'America/New_York', hub: false });
      if (path === '/api/reveal-design') {
        let d = null;
        try { d = window.__soardRevealDesign?.(); } catch { /* the editor closed */ }
        return json({ open: true, after: moment !== 'starting', name, slides: d?.slides || [] });
      }
      if (path === '/api/live-messages') {
        if (method !== 'GET') return json({ ok: true, status: 'shown', message: { id: `preview-${now}`, name: 'You', body: 'A message here is only in this preview.', at: iso(0) } });
        return json({ ok: true, open: true, enabled: true, broadcastId: state.id, messages: notes });
      }
      if (path === '/api/live-replay') return json({ ok: true, uid: moment === 'replay' ? video?.uid || null : null, revealAt: null, captions: false });
      if (path === '/api/reminders' && method !== 'GET') return json({ ok: true, pending: true, channel: 'email' });
      if (path === '/api/broadcast-event' || path === '/api/live-watch' || path === '/api/live-click') return json({ ok: true });
      return realFetch(input, init);
    };
    // No live hub and no counts from a preview
    win.WebSocket = class { constructor() { this.readyState = 3; setTimeout(() => { this.onclose?.({}); }, 0); } close() {} send() {} addEventListener() {} removeEventListener() {} };
    try { win.navigator.sendBeacon = () => true; } catch { /* read-only: the fetch stand-ins catch the rest */ }
  };
}

/** slug, name, photo (the kid's main photo), published, Dialog, onClose */
export function LivePreview({ slug, name, photo = '', published = true, Dialog, onClose }) {
  useStyles();
  const [moment, setMoment] = useState('starting');
  const [device, setDevice] = useState('phone');
  const [video, setVideo] = useState(undefined);
  const stage = useRef(null);
  const [scale, setScale] = useState(0.6);
  useEffect(() => { let on = true; standInVideo().then((v) => { if (on) setVideo(v); }); return () => { on = false; }; }, []);
  // The page's own hook asks the admin for this as it loads; the editor's other previews put theirs back after
  useEffect(() => {
    if (video === undefined) return undefined;
    const before = window.__soardPreview;
    window.__soardPreview = harness({ slug, name: name || 'This kid', photo, video });
    return () => { window.__soardPreview = before; };
  }, [video, slug, name, photo]);
  const [, , w, h] = DEVICES.find(([k]) => k === device);
  // Fit the device's screen in the stage, at its real size scaled down
  useEffect(() => {
    const fit = () => { const el = stage.current; if (!el) return; const r = el.getBoundingClientRect(); setScale(Math.min(1, (r.width - 24) / w, (Math.max(320, window.innerHeight - 300)) / h)); };
    fit();
    addEventListener('resize', fit);
    return () => removeEventListener('resize', fit);
  }, [w, h]);
  const who = possessive(name || 'this kid');
  const src = `/live/${encodeURIComponent(slug)}/?admin-preview=live&moment=${moment}`;
  const momentKeys = MOMENTS.map(([k]) => k);
  const deviceKeys = DEVICES.map(([k]) => k);
  return html`<${Dialog} title="Preview the live page" sub=${`${who} live page as people will see it, with the design as it is here, saved or not. Nothing you do in it reaches the real page: no sign-ups, no messages.${moment !== 'starting' ? ' A past reveal stands in for the camera.' : ''}`}
    onClose=${onClose} size="lg" className="rdp rlp" footer=${html`<button type="button" class="btn btn-secondary" onClick=${onClose}>Done</button>`}>
    ${!published ? html`<p class="notice notice--warn">${icon.alert}<span class="notice__body">This profile is hidden, so it has no live page yet. Show it on the site to preview it.</span></p>` : null}
    <div class="rdp-bar">
      <div class="seg" role="radiogroup" aria-label="Moment">
        ${MOMENTS.map(([k, label]) => html`<button type="button" role="radio" aria-checked=${moment === k} tabindex=${moment === k ? 0 : -1}
          onKeyDown=${(e) => radioKeys(e, momentKeys, moment, setMoment)} onClick=${() => setMoment(k)}>${label}</button>`)}
      </div>
      <div class="seg" role="radiogroup" aria-label="Screen">
        ${DEVICES.map(([k, label]) => html`<button type="button" role="radio" aria-checked=${device === k} tabindex=${device === k ? 0 : -1}
          onKeyDown=${(e) => radioKeys(e, deviceKeys, device, setDevice)} onClick=${() => setDevice(k)}>${label}</button>`)}
      </div>
      <span class="rlp-when">${moment === 'starting' ? 'The hour before: the reveal screen plays in the video box' : moment === 'live' ? 'From the start time: the camera, live' : 'After: the replay'}</span>
    </div>
    <div class="rdp-stage rlp-stage" ref=${stage}>
      ${published && video !== undefined ? html`<div class="rlp-device" style=${`width:${Math.round(w * scale)}px;height:${Math.round(h * scale)}px`}>
        <iframe key=${src + device} src=${src} title=${`${who} live page, ${moment}`} style=${`width:${w}px;height:${h}px;transform:scale(${scale})`} />
      </div>` : published ? html`<p class="rlp-wait">Getting the page ready…</p>` : null}
    </div>
  <//>`;
}
