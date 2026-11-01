/**
 * The flip book on the page: lays the pages out, turns them (drag a corner
 * or an edge, flick, click a page, the arrows, the keyboard, a trackpad
 * swipe), zooms (pinch, ⌘/Ctrl-scroll, + and −), finds words, and keeps the
 * address on the page being read. ./curl.js draws the turning sheet;
 * ./book-layout.js does the arithmetic; FlipBook.astro is the markup.
 *
 * Pages lying flat are <img>s (sharp, and what a screen reader and a
 * zoomed-in reader see). While a page turns, the pages it uncovers sit in
 * those <img>s and the canvas draws the sheet itself over them; a turn
 * lands only once the pages it lands on are decoded, so nothing flashes.
 * Without WebGL, or with reduced motion asked for, pages change in place
 * and a drag is read as a swipe.
 *
 * A turning sheet has its own coordinates: x from the spine toward its free
 * edge, y down from the page's top. A right-hand page turning left counts x
 * to the right; a left-hand page turning right (mirror) counts it to the
 * left, so both curl from their own corner the same way. "Out" sheets
 * finish at x = −W; one page at a time, turning back plays the forward turn
 * of the earlier page in reverse.
 *
 * mountFlipbook(root, book, { preview, startPage }) → { destroy, go, page }
 *   root: the .fb element; book: { title, pages: [{ id, w, h, links? }],
 *   chapters: [{ title, page }], pdf: { url, name, bytes }, textUrl }.
 *   preview (the admin's): the address bar is left alone and there's no
 *   Share. startPage: open there (0-based) instead of the cover or ?page=.
 */
import {
  spreadsOf, spreadOfPage, pagesOf, pageLabel, sheetFor, chooseTwoUp, fitBook, spreadOffset,
  clampCorner, foldOf, turnProgress, curlRadius, turnPath, bezier, pageSrc, searchPages, hitBoxes, pageFromSearch,
} from './book-layout.js';
import { createCurl } from './curl.js';

const PAPER = [1, 0.996, 0.984];
// A page lifts at once, sweeps across, and settles; a released page eases home
const EASE_TURN = bezier(0.3, 0.1, 0.2, 1);
const EASE_OUT = bezier(0.18, 0.72, 0.3, 1);
const EASE_MOVE = bezier(0.4, 0, 0.2, 1);
const MAX_ZOOM = 4;
// How long a landing page may keep the sheet waiting for its picture to decode
const HOLD_MS = 450;
const SITE_HOSTS = new Set(['sunshineonaranneyday.com', 'www.sunshineonaranneyday.com']);

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const now = () => performance.now();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
/** "84 MB", like src/utils/book.ts bookSize */
const sizeText = (b) => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e7 ? `${Math.round(b / 1e6)} MB` : b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`);
const typing = (el) => !!el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
/** A link in the book to this site: followed in the same tab, like any link on the site */
const onSite = (url) => { try { const u = new URL(url, location.href); return u.origin === location.origin || SITE_HOSTS.has(u.hostname); } catch { return false; } };

export function mountFlipbook(root, book, options = {}) {
  const pages = Array.isArray(book?.pages) ? book.pages.filter((p) => p && (p.id || p.src)) : [];
  const n = pages.length;
  if (!n) return { destroy() {}, go() {} };
  const preview = !!options.preview;

  const $ = (sel) => root.querySelector(sel);
  const stage = $('.fb-stage');
  const bookEl = $('.fb-book');
  const overEl = $('.fb-over');
  const canvas = $('.fb-curl');
  const slotL = $('.fb-page--left');
  const slotR = $('.fb-page--right');
  const gutter = $('.fb-gutter');
  const linksEl = $('.fb-links');
  const marksEl = $('.fb-marks');
  const prevBtn = $('.fb-arrow--prev');
  const nextBtn = $('.fb-arrow--next');
  const barPrev = $('[data-fb="prev"]');
  const barNext = $('[data-fb="next"]');
  const labelEl = $('[data-fb="label"]');
  const liveEl = $('.fb-live');
  const range = $('.fb-range');
  const rangeFill = $('.fb-range-fill');
  const ticksEl = $('.fb-ticks');
  const bubble = $('.fb-bubble');
  const panel = $('.fb-panel');
  const toastEl = $('.fb-toast');

  // The pages' shape: the admin renders every page the same size
  const aspect = (pages[0].w && pages[0].h) ? pages[0].w / pages[0].h : 0.75;
  const texts = pages.map((p, i) => p.text ?? [...(root.querySelector(`[data-fb-text="${i}"]`)?.children || [])].map((el) => el.textContent).join('\n\n'));
  const chapters = (Array.isArray(book.chapters) ? book.chapters : [])
    .filter((c) => c && c.title && Number.isInteger(c.page) && c.page >= 0 && c.page < n)
    .sort((a, b) => a.page - b.page);

  // The words and links that follow the book (the admin's Preview reuses one empty reader for any book)
  const panelName = $('[data-fb="panel-name"]');
  if (panelName) panelName.textContent = chapters.length ? 'Contents' : 'Pages';
  panel?.setAttribute('aria-label', chapters.length ? 'Contents' : 'All pages');
  const pdfSize = book.pdf?.bytes ? sizeText(book.pdf.bytes) : '';
  for (const a of root.querySelectorAll('[data-fb="download"], [data-print="book"]')) {
    a.hidden = !book.pdf?.url;
    if (!book.pdf?.url) continue;
    a.href = book.pdf.url;
    if (a.dataset.print) continue;
    a.setAttribute('download', book.pdf.name || 'book.pdf');
    if (a.classList.contains('fb-btn')) {
      a.setAttribute('aria-label', `Download the PDF${pdfSize ? ` (${pdfSize})` : ''}`);
      a.dataset.tip = `Download PDF${pdfSize ? ` · ${pdfSize}` : ''}`;
    } else {
      const s = a.querySelector('.fb-foot-size');
      if (s) s.textContent = pdfSize;
    }
  }
  // An admin preview has no address worth sharing
  if (preview) for (const el of root.querySelectorAll('[data-fb="share"], [data-more="share"], [data-fb="share-foot"]')) el.setAttribute('hidden', '');

  const reduceQuery = matchMedia('(prefers-reduced-motion: reduce)');
  let reduced = reduceQuery.matches;
  const curl = createCurl(canvas);
  if (!curl) root.classList.add('is-flat');
  /** The sheet is drawn turning (WebGL there and working, and motion not turned down) */
  const curling = () => !!curl && !curl.lost && !reduced;

  // ─── State ───────────────────────────────────────────────────────
  let sw = 0, sh = 0, dpr = 1;
  let twoUp = false;
  let spreads = [];
  let L = { W: 1, H: 1, spineX: 0, top: 0 };
  let spread = 0;
  let offset = 0;                 // the spine's shift, so a lone cover sits centred
  let turn = null;                // the sheet that's moving, if one is
  let queued = null;              // where to go once it lands
  let changing = null;            // without the curl: the spread on its way in
  let zoom = { z: 1, tx: 0, ty: 0 };
  let raf = 0;
  let destroyed = false;
  let hint = false;               // the first-visit corner lift
  let inView = false;             // enough of the book on screen for the arrow keys to be its
  const showing = { left: undefined, right: undefined };

  // ─── Pictures ────────────────────────────────────────────────────
  const imgCache = new Map();     // src → <img>
  const decoded = new WeakSet();  // pictures ready to show without a blank frame
  const pxWide = () => L.W * Math.min(2, dpr);

  /** A page's picture at a width, made once and kept: the same element goes in the page and up to the GPU */
  function imgFor(page, px = pxWide()) {
    if (page == null || !pages[page]) return null;
    const src = pageSrc(pages[page], px);
    let im = imgCache.get(src);
    if (im) {
      // Most recently used last
      imgCache.delete(src);
      imgCache.set(src, im);
      return im;
    }
    im = new Image();
    im.crossOrigin = 'anonymous';
    im.decoding = 'sync';
    im.draggable = false;
    im.alt = '';
    im.dataset.page = String(page);
    im.src = src;
    const el = im;
    el.addEventListener('load', () => { if (!destroyed) { el.classList.add('is-in'); kick(); } }, { once: true });
    // Decoded ahead, so it shows the moment it goes into the page
    (el.decode ? el.decode() : Promise.resolve()).then(() => decoded.add(el), () => decoded.add(el));
    imgCache.set(src, el);
    trimCache();
    return el;
  }
  function trimCache() {
    const keep = 28;
    if (imgCache.size <= keep) return;
    for (const [src, im] of imgCache) {
      if (imgCache.size <= keep) break;
      if (!im.isConnected) imgCache.delete(src);
    }
  }
  const loaded = (im) => !!(im && im.complete && im.naturalWidth);
  /** Every picture of a spread is decoded (or has failed: waiting won't help) */
  const spreadReady = (s) => pagesOf(spreads[s]).every((p) => { const im = imgFor(p); return decoded.has(im) || (im.complete && !im.naturalWidth); });
  const whenReady = (s) => Promise.all(pagesOf(spreads[s]).map((p) => { const im = imgFor(p); return im.decode ? im.decode().catch(() => {}) : null; }));

  /** Put a page in a slot (null hides the slot) */
  function setSlot(slot, page, px) {
    const side = slot === slotL ? 'left' : 'right';
    const im = page == null ? null : imgFor(page, px);
    if (showing[side] === im && (page == null) === slot.hidden) return;
    showing[side] = im;
    slot.hidden = page == null;
    if (page == null) { slot.replaceChildren(); return; }
    slot.dataset.page = String(page);
    if (loaded(im)) im.classList.add('is-in');
    if (slot.firstElementChild !== im || slot.childElementCount !== 1) slot.replaceChildren(im);
    im.alt = `Page ${page + 1}`;
  }

  /** Get the pictures around a spread coming, and the next turns' faces onto the GPU when it's quiet */
  function preload() {
    const around = [spread + 1, spread - 1, spread + 2, spread - 2];
    for (const s of around) for (const p of pagesOf(spreads[s])) imgFor(p);
    if (!curling()) return;
    const faces = [spreads[spread]?.right, spreads[spread + 1]?.left, spreads[spread]?.left, spreads[spread - 1]?.right];
    idle(() => { for (const p of faces) { const im = p == null ? null : imgFor(p); if (loaded(im) && !turn) curl.upload(im); } });
  }
  const idle = (fn) => (window.requestIdleCallback ? requestIdleCallback(fn, { timeout: 600 }) : setTimeout(fn, 120));

  // ─── Layout ──────────────────────────────────────────────────────
  function measure() {
    const r = stage.getBoundingClientRect();
    sw = r.width; sh = r.height;
    dpr = window.devicePixelRatio || 1;
    const phone = sw < 700;
    const padX = phone ? 12 : sw < 1040 ? 64 : 92;
    const padY = phone || sh < 420 ? 12 : root.classList.contains('is-full') ? 20 : 30;
    const wasTwo = twoUp;
    const firstPage = pagesOf(spreads[spread])[0] ?? 0;
    twoUp = chooseTwoUp(sw - 2 * padX, sh - 2 * padY, aspect);
    spreads = spreadsOf(n, twoUp);
    if (wasTwo !== twoUp || spread >= spreads.length) spread = spreadOfPage(firstPage, twoUp, n);
    L = fitBook({ spaceW: sw, spaceH: sh, aspect, twoUp, padX, padY });
    root.classList.toggle('is-two', twoUp);
    if (curl) curl.resize(sw, sh, dpr);
    offset = spreadOffset(spreads[spread], L.W, twoUp);
    if (range) range.max = String(Math.max(0, spreads.length - 1));
    drawTicks();
  }

  /** Where the pages sit, this frame */
  function place() {
    const x = L.spineX + offset;
    for (const [slot, left] of [[slotR, x], [slotL, x - L.W]]) {
      slot.style.width = `${L.W}px`;
      slot.style.height = `${L.H}px`;
      slot.style.transform = `translate3d(${left}px,${L.top}px,0)`;
    }
    if (gutter) {
      gutter.style.height = `${L.H}px`;
      gutter.style.transform = `translate3d(${x}px,${L.top}px,0)`;
    }
  }

  /** The stacked page edges each side: thicker the more pages are there */
  function edges() {
    const s = spreads[spread];
    const lines = (count) => (count <= 0 ? 0 : clamp(Math.round((7 * count) / n), 1, 7));
    const stack = (count, dir) => {
      const k = lines(count);
      const out = [];
      for (let i = 1; i <= k; i++) out.push(`${dir * i}px ${(i * 0.5).toFixed(1)}px 0 ${i % 2 ? '#E7E1D3' : '#FBF8F0'}`);
      return out;
    };
    const drop = '0 26px 48px -20px rgba(0,0,0,0.65), 0 3px 10px rgba(0,0,0,0.28)';
    const left = s?.left != null ? s.left : 0;
    const right = s?.right != null ? n - 1 - s.right : 0;
    slotL.style.boxShadow = [...stack(left, -1), drop].join(',');
    slotR.style.boxShadow = [...stack(right, 1), drop].join(',');
  }

  // ─── Drawing ─────────────────────────────────────────────────────
  function kick() { if (!raf && !destroyed) raf = requestAnimationFrame(frame); }

  function frame(t) {
    raf = 0;
    let more = false;
    // A sheet just picked up: the pages it uncovers go into the <img>s in the
    // same frame the canvas first draws it over them, so nothing flashes
    if (turn?.swap) {
      turn.swap = false;
      const s = turn.sheet;
      if (s.mirror) { setSlot(slotL, s.under); setSlot(slotR, s.beside); }
      else { setSlot(slotL, twoUp ? s.beside : null); setSlot(slotR, s.under); }
      root.classList.add('is-turning');
      clearOverlays();
      if (gutter) gutter.hidden = true;
    }
    if (turn) more = stepTurn(t) || more;
    place();
    drawSheet(t);
    if (more) kick();
  }

  // A turning sheet's own coordinates, from the spine's (mirrored for a left-hand page)
  const local = (T, p) => (T.sheet.mirror ? { x: -p.x, y: p.y } : p);
  // Out: the sheet finishes at −W. Its resting x, unturned
  const isOut = (T) => T.sheet.forward || T.sheet.mirror;
  const homeX = (T) => (isOut(T) ? L.W : -L.W);

  function drawSheet(t) {
    if (!curl) return;
    if (!turn || zoom.z > 1) { curl.clear(); return; }
    const { W, H } = L;
    const s = turn.sheet;
    const from = { x: W, y: turn.cy };
    const at = clampCorner({ W, H, from, at: turn.at });
    const p = turnProgress(W, at);
    const fold = foldOf({ W, H, from, at, R: curlRadius(W, p, turn.stiff) });
    const frontIm = s.front == null ? null : imgFor(s.front);
    const backIm = s.back == null ? null : imgFor(s.back);
    // A picture that arrives mid-turn fades in rather than popping
    const on = (im, key) => {
      if (!loaded(im)) return 0;
      if (!turn[key]) turn[key] = t;
      const k = clamp((t - turn[key]) / 180, 0, 1);
      if (k < 1) kick();
      return turn[`${key}Early`] ? 1 : k;
    };
    curl.draw({
      origin: { x: L.spineX + offset, y: L.top },
      W, H, fold,
      mirror: s.mirror,
      front: frontIm, back: backIm,
      frontOn: on(frontIm, 'frontAt'),
      backOn: on(backIm, 'backAt'),
      seeThrough: !twoUp || s.back == null,
      paper: PAPER,
      shade: Math.min(1, Math.sin(Math.PI * p) * 2.4),
      alpha: twoUp ? 1 : 1 - smooth(0.6, 0.97, p),
      // The pages under it, in its own coordinates: the uncovered one ahead, the one beside behind the spine
      floor: [twoUp && s.beside != null ? -W : 0, s.under != null ? W : 0],
      reach: Math.max(48, H * 0.22),
    });
  }

  // ─── Turning ─────────────────────────────────────────────────────
  /**
   * Start a sheet moving from spread `from` toward `to`. The pages it uncovers
   * go into the <img>s in the next frame, the same one the canvas first draws it in.
   */
  function begin(kind, from, to, cy, at) {
    const sheet = sheetFor(spreads, from, to, twoUp);
    if (!sheet) return null;
    const ends = [0, n - 1];
    const stiff = twoUp && [sheet.front, sheet.back].some((p) => ends.includes(p));
    turn = {
      kind, from, to, sheet, cy, stiff,
      at: null,
      offFrom: offset, offTo: spreadOffset(spreads[to], L.W, twoUp),
      frontAt: 0, backAt: 0,
    };
    turn.at = at || { x: homeX(turn), y: cy };
    // A face already on screen is there at full strength from the first frame
    const frontIm = sheet.front == null ? null : imgFor(sheet.front);
    const backIm = sheet.back == null ? null : imgFor(sheet.back);
    turn.frontAtEarly = loaded(frontIm) && isOut(turn);
    turn.backAtEarly = false;
    if (curl) { if (loaded(frontIm)) curl.upload(frontIm); if (loaded(backIm)) curl.upload(backIm); }
    // Both ends' pictures decoding now, so landing (or falling back) shows them at once
    whenReady(to);
    turn.swap = true;
    kick();
    return turn;
  }

  /** Where the book is heading: a click while a page turns counts from where it'll land */
  function heading() {
    if (queued != null) return queued;
    if (changing != null) return changing;
    if (turn && (turn.kind === 'auto' || turn.kind === 'settle')) return turn.kind === 'settle' && !turn.complete ? turn.from : turn.to;
    return spread;
  }

  /** Carry a moving sheet on to rest, from wherever it is now */
  function finish(T, complete, speed = 0) {
    if (complete && T.kind !== 'settle') turnSound();
    const endX = complete === isOut(T) ? -L.W : L.W;
    const left = Math.abs(endX - T.at.x) / (2 * L.W);
    T.kind = 'settle';
    T.complete = complete;
    T.start = { ...T.at };
    T.end = { x: endX, y: T.cy };
    T.offStart = offset;
    T.t0 = now();
    T.dur = clamp(160 + 560 * left - Math.min(160, speed * 90), 140, 640);
    kick();
  }

  function stepTurn(t) {
    const T = turn;
    const { W, H } = L;
    if (T.kind === 'auto' || T.kind === 'settle') {
      const k = clamp((t - T.t0) / T.dur, 0, 1);
      if (T.kind === 'auto') {
        const e = EASE_TURN(k);
        T.at = turnPath(W, H, isOut(T) ? e : 1 - e, T.cy, T.lift);
        offset = lerp(T.offFrom, T.offTo, EASE_MOVE(k));
      } else {
        const e = EASE_OUT(k);
        T.at = { x: lerp(T.start.x, T.end.x, e), y: lerp(T.start.y, T.end.y, e) };
        offset = lerp(T.offStart, T.complete ? T.offTo : T.offFrom, EASE_MOVE(k));
      }
      if (k < 1) return true;
      // Landed: the sheet lies flat over its page until that page's picture can show without a blank frame
      const target = T.kind === 'auto' || T.complete ? T.to : T.from;
      if (!spreadReady(target)) {
        if (!T.holdSince) T.holdSince = t;
        if (t - T.holdSince < HOLD_MS) return true;
      }
      land(T.kind === 'auto' || T.complete);
      return false;
    }
    if (T.kind === 'peel') {
      // A quarter of the way there each frame: quick to follow, soft to stop
      T.at = { x: lerp(T.at.x, T.target.x, 0.24), y: lerp(T.at.y, T.target.y, 0.24) };
      if (T.leaving && Math.hypot(T.at.x - homeX(T), T.at.y - T.cy) < 0.6) { land(false); return false; }
      return Math.hypot(T.at.x - T.target.x, T.at.y - T.target.y) > 0.3;
    }
    return false; // a drag moves when the pointer does
  }

  /** The sheet has come to rest: at `to` if it turned, back at `from` if not */
  function land(turned) {
    const T = turn;
    turn = null;
    root.classList.remove('is-turning');
    const target = turned ? T.to : T.from;
    offset = spreadOffset(spreads[target], L.W, twoUp);
    settleAt(target);
    if (curl) curl.clear();
    if (queued != null && queued !== spread) {
      const next = queued;
      queued = null;
      go(next, { fast: true });
    } else queued = null;
  }

  /** Show a spread as the resting state, and everything that follows it */
  let shownOnce = false;
  function settleAt(s) {
    const changed = s !== spread;
    spread = clamp(s, 0, spreads.length - 1);
    if (changed || !shownOnce) { seen(shownOnce); shownOnce = true; }
    const sp = spreads[spread];
    setSlot(slotL, sp.left);
    setSlot(slotR, sp.right);
    if (gutter) gutter.hidden = !(twoUp && sp.left != null && sp.right != null);
    edges();
    place();
    updateUi(changed);
    drawOverlays();
    preload();
  }

  /** Turn to a spread: one sheet, whatever the distance */
  function go(to, { fast = false } = {}) {
    to = clamp(Math.round(to), 0, spreads.length - 1);
    if (zoom.z > 1) zoomTo(1, sw / 2, sh / 2, true);
    if (turn) {
      if (turn.kind === 'drag') return;
      if (turn.kind === 'peel') {
        // The corner's already up: carry it on over when that's the way it's going
        const fwd = to > spread;
        if (to !== spread && fwd === turn.sheet.forward && Math.abs(to - spread) === 1) { finish(turn, true); return; }
        land(false);
      } else {
        // Another click while one turns: hurry this one, then carry on from where it lands
        if (to === heading()) return;
        queued = to;
        const t = now();
        const done = clamp((t - turn.t0) / turn.dur, 0, 1);
        if (done < 0.75) { turn.dur = Math.max(140, turn.dur * 0.5); turn.t0 = t - done * turn.dur; }
        return;
      }
    }
    if (!curling()) { change(to); return; }
    if (to === spread) return;
    const far = Math.abs(to - spread) > 1;
    const phone = sw < 700;
    const T = begin('auto', spread, to, L.H);
    if (!T) return;
    turnSound();
    T.t0 = now();
    T.dur = (far ? 900 : phone ? 620 : 760) * (fast ? 0.6 : 1) * (T.stiff ? 1.1 : 1);
    T.lift = T.stiff ? 0.06 : 0.16;
    kick();
  }

  /**
   * Without the curl: the new pages go in once they're decoded (never a
   * blank frame), with a quick fade unless motion is turned down. Presses
   * while one is on its way count from it; the last one wins.
   */
  async function change(to) {
    if (to === (changing ?? spread)) return;
    changing = to;
    if (!spreadReady(to)) await Promise.race([whenReady(to), wait(HOLD_MS)]);
    if (destroyed || changing !== to) return;
    changing = null;
    turnSound();
    bookEl.classList.remove('is-fading');
    if (!reduced) { void bookEl.offsetWidth; bookEl.classList.add('is-fading'); }
    offset = spreadOffset(spreads[to], L.W, twoUp);
    settleAt(to);
  }

  const next = () => go(heading() + 1);
  const prev = () => go(heading() - 1);

  // ─── Pointer: drag, flick, click, peek, pan, pinch ───────────────
  let down = null;      // the press, until it's a drag, a swipe or a click
  let samples = [];     // recent pointer positions, for a flick's speed
  const touches = new Map();
  let pinch = null;
  let pan = null;
  let rect = null;

  const stageRect = () => (rect = stage.getBoundingClientRect());
  /** Pointer → spine coordinates (x from the spine, rightward; y from the page's top) */
  function toSheet(e) {
    const r = rect || stageRect();
    return { x: e.clientX - r.left - (L.spineX + offset), y: e.clientY - r.top - L.top };
  }
  const toStage = (e) => { const r = rect || stageRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

  /** Which page a point is on: 'left', 'right' or null */
  function sideAt(p) {
    if (p.y < 0 || p.y > L.H) return null;
    const sp = spreads[spread];
    if (p.x >= 0 && p.x <= L.W && sp.right != null) return 'right';
    if (twoUp && p.x < 0 && p.x >= -L.W && sp.left != null) return 'left';
    return null;
  }
  const canForward = () => spread < spreads.length - 1;
  const canBack = () => spread > 0;

  function onDown(e) {
    if (e.button > 0 || destroyed) return;
    active();
    if (e.target.closest('button, a, .fb-arrow, .fb-resume')) return;
    stopPlay();
    stageRect();
    // Focus that came with a click shows no ring (a key pressed next would otherwise draw one)
    stage.dataset.pointer = '1';
    if (e.pointerType === 'touch') touches.set(e.pointerId, toStage(e));
    if (touches.size === 2) { startPinch(); down = null; return; }
    if (zoom.z > 1) {
      pan = { x: e.clientX, y: e.clientY, tx: zoom.tx, ty: zoom.ty, id: e.pointerId, moved: 0, vx: 0, vy: 0, t: now() };
      stage.setPointerCapture?.(e.pointerId);
      root.classList.add('is-panning');
      return;
    }
    const p = toSheet(e);
    down = { id: e.pointerId, x: e.clientX, y: e.clientY, p, side: sideAt(p), type: e.pointerType, t: now() };
    samples = [{ x: e.clientX, t: now() }];
  }

  function onMove(e) {
    if (destroyed) return;
    if (touches.has(e.pointerId)) touches.set(e.pointerId, toStage(e));
    if (pinch) { movePinch(); return; }
    if (pan && e.pointerId === pan.id) { movePan(e); return; }
    if (down && e.pointerId === down.id) {
      samples.push({ x: e.clientX, t: now() });
      if (samples.length > 8) samples.shift();
      const dx = e.clientX - down.x, dy = e.clientY - down.y;
      if (down.swipe != null) { down.swipe = dx; return; }
      if (!down.dragging) {
        const far = Math.hypot(dx, dy) > (down.type === 'mouse' ? 4 : 9);
        if (!far) return;
        // Touch: a mostly-up-or-down move scrolls the page instead
        if (down.type !== 'mouse' && Math.abs(dy) > Math.abs(dx)) { down = null; return; }
        const how = startDrag(dx);
        if (how === 'swipe') { down.swipe = dx; return; }
        if (!how) { down = null; return; }
      }
      // The sheet can go (the window resized, a pinch began): so does the drag
      if (turn?.kind !== 'drag') { down = null; return; }
      const p = local(turn, toSheet(e));
      turn.at = clampCorner({ W: L.W, H: L.H, from: { x: L.W, y: turn.cy }, at: { x: p.x + turn.grab.x, y: p.y + turn.grab.y } });
      kick();
      e.preventDefault();
      return;
    }
    if (e.pointerType === 'mouse' && !down && !pan) { active(); stageRect(); hover(e); }
  }

  /** A press that moved: pick the sheet up (true), read it as a swipe ('swipe'), or neither */
  function startDrag(dx) {
    if (turn && turn.kind !== 'peel') return false;
    const d = down;
    // Without the curl there's no sheet to hold
    if (!curling()) return 'swipe';
    let fwd;
    if (twoUp) {
      // A finger pulling a page the way it can't turn means the other way: a swipe
      if (d.type !== 'mouse' && (d.side == null || (d.side === 'right' && dx > 0) || (d.side === 'left' && dx < 0))) return 'swipe';
      if (d.side === 'right' && canForward()) fwd = true;
      else if (d.side === 'left' && canBack()) fwd = false;
      else return false;
    } else {
      if (d.side !== 'right') return d.type !== 'mouse' ? 'swipe' : false;
      fwd = dx < 0;
      if (fwd ? !canForward() : !canBack()) return false;
    }
    // A corner already lifted by the mouse is the one picked up, from where it is
    if (turn?.kind === 'peel') {
      if (turn.sheet.forward === fwd) {
        turn.kind = 'drag';
        turn.leaving = false;
        const lp = local(turn, d.p);
        turn.grab = { x: turn.at.x - lp.x, y: turn.at.y - lp.y };
        d.dragging = true;
        stage.setPointerCapture?.(d.id);
        return true;
      }
      land(false);
    }
    const cy = d.p.y < L.H / 2 ? 0 : L.H;
    const T = begin('drag', spread, spread + (fwd ? 1 : -1), cy);
    if (!T) return false;
    const lp = local(T, d.p);
    T.grab = { x: T.at.x - lp.x, y: T.at.y - lp.y };
    d.dragging = true;
    stage.setPointerCapture?.(d.id);
    return true;
  }

  function onUp(e) {
    if (touches.has(e.pointerId)) touches.delete(e.pointerId);
    if (pinch) { if (touches.size < 2) endPinch(); return; }
    if (pan && e.pointerId === pan.id) { endPan(e); return; }
    if (!down || e.pointerId !== down.id) return;
    const d = down;
    down = null;
    if (d.dragging) { if (turn?.kind === 'drag') release(e.type === 'pointercancel'); return; }
    if (e.type === 'pointercancel') return;
    if (d.swipe != null) { if (Math.abs(d.swipe) > 40) { if (d.swipe < 0) next(); else prev(); } return; }
    // A click or a tap
    if (now() - d.t > 600) return;
    const link = linkAt(d.p);
    if (link) { followLink(link); return; }
    if (twoUp) {
      if (d.side === 'right') next();
      else if (d.side === 'left') prev();
    } else if (d.side === 'right') {
      if (d.p.x < L.W * 0.33) prev(); else next();
    }
  }

  /** Let go mid-turn: finish it if it's past halfway or flicked that way, else it falls back */
  function release(cancelled) {
    const T = turn;
    const recent = samples.filter((s) => now() - s.t < 90);
    const a = recent[0], b = recent[recent.length - 1];
    const vScreen = a && b && b.t > a.t ? (b.x - a.x) / (b.t - a.t) : 0; // px per ms; negative is leftward
    const vx = T.sheet.mirror ? -vScreen : vScreen; // in the sheet's own direction
    const p = turnProgress(L.W, T.at);
    // Two up, past the spine; one page at a time, past the page's middle is far enough for a thumb
    const half = twoUp ? 0.5 : 0.28;
    let complete = isOut(T) ? (vx < -0.35 || (vx < 0.35 && p > half)) : (vx > 0.35 || (vx > -0.35 && p < 1 - half));
    if (cancelled) complete = isOut(T) ? p > half : p < 1 - half;
    finish(T, complete, Math.abs(vx));
  }

  // The corner lifts toward a mouse that comes near it
  function hover(e) {
    if (zoom.z > 1 || !curling()) return;
    if (turn && turn.kind !== 'peel') return;
    const p = toSheet(e);
    const zone = clamp(L.W * 0.2, 44, 110);
    const corners = [];
    if (canForward()) corners.push({ x: L.W, y: 0, fwd: true }, { x: L.W, y: L.H, fwd: true });
    if (canBack() && twoUp) corners.push({ x: -L.W, y: 0, fwd: false }, { x: -L.W, y: L.H, fwd: false });
    let best = null;
    for (const c of corners) {
      const dist = Math.hypot(p.x - c.x, p.y - c.y);
      if (dist < zone && (!best || dist < best.dist)) best = { ...c, dist };
    }
    stage.classList.toggle('is-corner', !!best);
    const drop = () => { if (turn?.kind === 'peel' && !turn.leaving) { turn.leaving = true; turn.target = { x: homeX(turn), y: turn.cy }; kick(); } };
    if (!best) { drop(); return; }
    // Moved to another corner: let this one drop first
    if (turn?.kind === 'peel' && (turn.sheet.forward !== best.fwd || turn.cy !== best.y)) { drop(); return; }
    if (!turn && !begin('peel', spread, spread + (best.fwd ? 1 : -1), best.y)) return;
    // Lift about half way to the pointer, never more than a little of the page
    const k = 1 - best.dist / zone;
    const lift = clamp(L.W * 0.11 * (0.45 + k), 10, 72);
    const lp = local(turn, p);
    const dx = lp.x - L.W, dy = lp.y - best.y;
    const len = Math.hypot(dx, dy) || 1;
    turn.leaving = false;
    turn.target = { x: L.W + (dx / len) * lift, y: best.y + (dy / len) * lift };
    kick();
  }
  function onLeave(e) {
    if (e.pointerType !== 'mouse') return;
    stage.classList.remove('is-corner');
    if (turn?.kind === 'peel' && !turn.leaving) { turn.leaving = true; turn.target = { x: homeX(turn), y: turn.cy }; kick(); }
  }

  // ─── Zoom ────────────────────────────────────────────────────────
  /** Keep the point (cx, cy) on the stage where it is while the scale changes */
  function zoomTo(z, cx, cy, animate = false) {
    z = clamp(z, 1, MAX_ZOOM);
    // Zooming in to look closer stops Play (its next turn would zoom back out)
    if (z > 1.001) stopPlay();
    const k = z / zoom.z;
    zoom = { z, tx: cx - (cx - zoom.tx) * k, ty: cy - (cy - zoom.ty) * k };
    if (z <= 1.001) zoom = { z: 1, tx: 0, ty: 0 };
    clampPan();
    applyZoom(animate);
  }
  function clampPan() {
    const sp = spreads[spread];
    const x0 = L.spineX + offset - (sp?.left != null ? L.W : 0);
    const x1 = L.spineX + offset + (sp?.right != null ? L.W : 0);
    const y0 = L.top, y1 = L.top + L.H;
    const { z } = zoom;
    const fitAxis = (a0, a1, size, t) => {
      const span = (a1 - a0) * z;
      if (span <= size) return (size - span) / 2 - a0 * z;
      const m = 24;
      return clamp(t, size - a1 * z - m, -a0 * z + m);
    };
    zoom.tx = fitAxis(x0, x1, sw, zoom.tx);
    zoom.ty = fitAxis(y0, y1, sh, zoom.ty);
    if (z === 1) zoom.tx = zoom.ty = 0;
  }
  let sharpTimer = 0;
  function applyZoom(animate) {
    const tr = zoom.z === 1 ? '' : `translate3d(${zoom.tx}px,${zoom.ty}px,0) scale(${zoom.z})`;
    for (const el of [bookEl, overEl]) {
      if (!el) continue;
      el.classList.toggle('is-animating', !!animate && !reduced);
      el.style.transform = tr;
    }
    const zoomed = zoom.z > 1;
    root.classList.toggle('is-zoomed', zoomed);
    if (zoomed && turn) land(false);
    if (zoomed && curl) curl.clear();
    updateZoomUi();
    // Sharper pictures once the scale holds still
    clearTimeout(sharpTimer);
    sharpTimer = setTimeout(sharpen, 160);
  }
  function sharpen() {
    const sp = spreads[spread];
    if (!sp) return;
    const px = zoom.z > 1 ? L.W * Math.min(2, dpr) * zoom.z : pxWide();
    for (const [slot, page] of [[slotL, sp.left], [slotR, sp.right]]) {
      if (page == null) continue;
      const im = imgFor(page, px);
      const swap = () => { if (!destroyed && spreads[spread] === sp && !turn) setSlot(slot, page, px); };
      if (decoded.has(im)) swap(); else (im.decode ? im.decode() : Promise.resolve()).then(swap, () => {});
    }
  }
  function startPinch() {
    const [a, b] = [...touches.values()];
    if (turn?.kind === 'drag') release(true);
    pinch = { d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, z0: zoom.z, mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, tx: zoom.tx, ty: zoom.ty };
    pan = null;
  }
  function movePinch() {
    const [a, b] = [...touches.values()];
    if (!a || !b) return;
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const z = clamp((pinch.z0 * d) / pinch.d0, 1, MAX_ZOOM);
    // Scale about the first midpoint, then follow the fingers
    const k = z / pinch.z0;
    zoom = { z, tx: pinch.mid.x - (pinch.mid.x - pinch.tx) * k + (mid.x - pinch.mid.x), ty: pinch.mid.y - (pinch.mid.y - pinch.ty) * k + (mid.y - pinch.mid.y) };
    clampPan();
    applyZoom(false);
  }
  function endPinch() {
    pinch = null;
    if (zoom.z < 1.08) zoomTo(1, sw / 2, sh / 2, true);
  }
  function movePan(e) {
    const t = now();
    const dx = e.clientX - pan.x, dy = e.clientY - pan.y;
    const dt = Math.max(1, t - pan.t);
    pan.vx = lerp(pan.vx, (dx - (pan.lx || 0)) / dt, 0.5);
    pan.vy = lerp(pan.vy, (dy - (pan.ly || 0)) / dt, 0.5);
    pan.lx = dx; pan.ly = dy; pan.t = t;
    pan.moved = Math.max(pan.moved, Math.hypot(dx, dy));
    zoom.tx = pan.tx + dx;
    zoom.ty = pan.ty + dy;
    clampPan();
    applyZoom(false);
  }
  let glide = 0;
  function endPan() {
    const p = pan;
    pan = null;
    root.classList.remove('is-panning');
    if (p.moved < 4) return;
    // A little glide after a fling
    let vx = p.vx * 16, vy = p.vy * 16;
    cancelAnimationFrame(glide);
    const step = () => {
      if (Math.abs(vx) < 0.3 && Math.abs(vy) < 0.3) return;
      zoom.tx += vx; zoom.ty += vy; vx *= 0.9; vy *= 0.9;
      clampPan(); applyZoom(false);
      glide = requestAnimationFrame(step);
    };
    if (!reduced) glide = requestAnimationFrame(step);
  }

  function onWheel(e) {
    if (destroyed) return;
    active();
    stageRect();
    // ⌘/Ctrl + scroll, and a trackpad pinch (which arrives as Ctrl + scroll)
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const p = toStage(e);
      zoomTo(zoom.z * Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0025)), p.x, p.y, false);
      return;
    }
    if (zoom.z > 1) {
      e.preventDefault();
      zoom.tx -= e.deltaX; zoom.ty -= e.deltaY;
      clampPan(); applyZoom(false);
      return;
    }
    // A sideways two-finger swipe turns a page (and doesn't send the browser back)
    if (Math.abs(e.deltaX) > Math.abs(e.deltaY) * 1.2) {
      e.preventDefault();
      swipe.sum += e.deltaX;
      clearTimeout(swipe.timer);
      swipe.timer = setTimeout(() => { swipe.sum = 0; swipe.locked = false; }, 180);
      if (!swipe.locked && Math.abs(swipe.sum) > 60) {
        swipe.locked = true;
        if (swipe.sum > 0) next(); else prev();
      }
    }
  }
  const swipe = { sum: 0, timer: 0, locked: false };

  // ─── Links in the book, and found words ──────────────────────────
  function visibleRects() {
    const sp = spreads[spread];
    const x = L.spineX + offset;
    const out = [];
    if (sp?.left != null) out.push({ page: sp.left, x: x - L.W, y: L.top });
    if (sp?.right != null) out.push({ page: sp.right, x, y: L.top });
    return out;
  }
  function linkAt(p) {
    // p is in spine coordinates of the current spread
    for (const r of visibleRects()) {
      const links = pages[r.page].links;
      if (!Array.isArray(links)) continue;
      const lx = p.x + (L.spineX + offset) - r.x, ly = p.y + L.top - r.y;
      for (const l of links) {
        if (lx >= l.x * L.W && lx <= (l.x + l.w) * L.W && ly >= l.y * L.H && ly <= (l.y + l.h) * L.H) return l;
      }
    }
    return null;
  }
  function followLink(l) {
    if (Number.isInteger(l.page)) { go(spreadOfPage(l.page, twoUp, n)); return; }
    if (!/^(https?:|mailto:)/i.test(l.url || '')) return;
    count('links', l.url);
    flush();
    if (onSite(l.url)) location.assign(new URL(l.url, location.href).pathname + new URL(l.url, location.href).search);
    else window.open(l.url, '_blank', 'noopener');
  }
  function clearOverlays() {
    linksEl?.replaceChildren();
    marksEl?.replaceChildren();
  }
  function drawOverlays() {
    clearOverlays();
    if (turn) return;
    for (const r of visibleRects()) {
      for (const l of pages[r.page].links || []) {
        const a = document.createElement('a');
        a.className = 'fb-link';
        a.style.cssText = `left:${r.x + l.x * L.W}px;top:${r.y + l.y * L.H}px;width:${l.w * L.W}px;height:${l.h * L.H}px`;
        if (Number.isInteger(l.page)) {
          a.href = `?page=${l.page + 1}`;
          a.setAttribute('aria-label', `Go to page ${l.page + 1}`);
          a.addEventListener('click', (e) => {
            e.preventDefault();
            // The link goes when the pages change: keep the place in the book, not the page's top
            if (e.detail) stage.dataset.pointer = '1'; else delete stage.dataset.pointer;
            stage.focus({ preventScroll: true });
            followLink(l);
          });
        } else if (/^(https?:|mailto:)/i.test(l.url || '')) {
          const site = onSite(l.url);
          a.href = site ? new URL(l.url, location.href).pathname + new URL(l.url, location.href).search : l.url;
          if (!site) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
          const where = l.url.replace(/^mailto:/i, 'Email ').replace(/^https?:\/\//i, '').replace(/\/$/, '');
          a.setAttribute('aria-label', site ? where : `${where} (opens in a new tab)`);
          a.addEventListener('click', () => { count('links', l.url); flush(); });
        } else continue;
        linksEl?.append(a);
      }
      if (found.query && found.items) {
        for (const b of hitBoxes(found.items[r.page], found.query)) {
          const m = document.createElement('span');
          m.className = 'fb-mark';
          m.style.cssText = `left:${r.x + b.x * L.W - 2}px;top:${r.y + b.y * L.H - 1}px;width:${b.w * L.W + 4}px;height:${b.h * L.H + 2}px`;
          marksEl?.append(m);
        }
      }
    }
  }

  // ─── Search ──────────────────────────────────────────────────────
  const found = { query: '', items: null, loading: null };
  /** The words' places on each page (loaded the first time someone searches) */
  function loadPositions() {
    if (found.items || found.loading || !book.textUrl) return found.loading;
    found.loading = fetch(book.textUrl, { credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { found.items = Array.isArray(j?.pages) ? j.pages : []; drawOverlays(); })
      .catch(() => { found.items = []; });
    return found.loading;
  }

  // ─── The bar, the scrubber, the panel ────────────────────────────
  function firstPage() { return pagesOf(spreads[spread])[0] ?? 0; }
  function chapterAt(page) {
    let c = null;
    for (const ch of chapters) if (ch.page <= page) c = ch;
    return c;
  }
  /** The chapters' marks on the page bar, where its handle sits for each chapter's first spread */
  function drawTicks() {
    if (!ticksEl) return;
    const last = Math.max(1, spreads.length - 1);
    ticksEl.replaceChildren(...chapters.map((ch) => {
      const t = document.createElement('span');
      t.className = 'fb-tick';
      t.style.left = `${(spreadOfPage(ch.page, twoUp, n) / last) * 100}%`;
      return t;
    }));
  }
  function updateUi(changed) {
    const sp = spreads[spread];
    const ps = pagesOf(sp).map((p) => p + 1);
    const short = ps.length > 1 ? `${ps[0]}–${ps[1]}` : `${ps[0]}`;
    if (labelEl) {
      labelEl.querySelector('[data-fb="pages"]').textContent = short;
      labelEl.querySelector('[data-fb="of"]').textContent = String(n);
      labelEl.setAttribute('aria-label', `${pageLabel(sp, n)}. Go to a page`);
    }
    const atStart = spread <= 0, atEnd = spread >= spreads.length - 1;
    for (const b of [prevBtn, barPrev]) if (b) b.disabled = atStart;
    for (const b of [nextBtn, barNext]) if (b) b.disabled = atEnd;
    if (range) {
      range.value = String(spread);
      range.setAttribute('aria-valuetext', pageLabel(sp, n));
      const k = spreads.length > 1 ? spread / (spreads.length - 1) : 0;
      if (rangeFill) rangeFill.style.transform = `scaleX(${k})`;
    }
    root.classList.toggle('is-closed', twoUp && (sp.left == null || sp.right == null));
    if (changed) {
      if (liveEl) liveEl.textContent = pageLabel(sp, n);
      writeAddress();
      if (hint) hint = false;
      // Turning the pages answers the offer, but the cover opened from the page around the book doesn't
      if (resumeEl && !resumeEl.hidden && !resuming && spread !== keepOfferAt) dropResume();
      if (spread !== keepOfferAt) keepOfferAt = -1;
    }
    if (panel?.open) { if (panelTab === 'text' && !searchBox.value.trim()) buildPanel(); markPanel(); }
  }
  let addressTimer = 0;
  function writeAddress(delay = 250) {
    if (preview) return;
    clearTimeout(addressTimer);
    addressTimer = setTimeout(() => {
      const u = new URL(location.href);
      const p = firstPage();
      if (p > 0) u.searchParams.set('page', String(p + 1)); else u.searchParams.delete('page');
      // The skip link's jump isn't a place to come back to
      if (u.hash === '#fb-text') u.hash = '';
      // Keep the router's own state: it remembers scroll positions in it
      try { history.replaceState(history.state, '', u); } catch { /* too many changes in a row: the next one catches up */ }
      // Where this reader got to, for "Pick up where you left off" next time
      try { localStorage.setItem(lastKey, JSON.stringify({ v: book.version || '', page: p, t: Date.now() })); } catch { /* private browsing */ }
    }, delay);
  }

  function updateZoomUi() {
    const out = $('[data-fb="zoom-out"]');
    const inn = $('[data-fb="zoom-in"]');
    if (out) out.disabled = zoom.z <= 1;
    if (inn) inn.disabled = zoom.z >= MAX_ZOOM - 0.01;
  }

  // Scrubber: drag to see where you'd land, let go to turn there
  const bubbleThumbs = new Map();
  function bubbleAt(s, x) {
    if (!bubble) return;
    const sp = spreads[clamp(s, 0, spreads.length - 1)];
    const ps = pagesOf(sp);
    const thumbs = bubble.querySelector('.fb-bubble-pages');
    thumbs.replaceChildren(...ps.map((p) => {
      let im = bubbleThumbs.get(p);
      if (!im) {
        im = new Image();
        im.alt = '';
        im.decoding = 'async';
        im.src = pageSrc(pages[p], 160 * Math.min(2, dpr));
        im.style.aspectRatio = String(aspect);
        bubbleThumbs.set(p, im);
      }
      return im;
    }));
    const ch = chapterAt(ps[0]);
    bubble.querySelector('.fb-bubble-label').textContent = ps.length > 1 ? `Pages ${ps[0] + 1}–${ps[1] + 1}` : `Page ${ps[0] + 1}`;
    const chEl = bubble.querySelector('.fb-bubble-chapter');
    chEl.textContent = ch ? ch.title : '';
    chEl.hidden = !ch;
    const track = range.getBoundingClientRect();
    const wrap = bubble.offsetParent?.getBoundingClientRect() || track;
    const half = bubble.offsetWidth / 2 || 80;
    const left = clamp(x - wrap.left, half + 4, wrap.width - half - 4);
    bubble.style.transform = `translateX(${left - half}px)`;
    bubble.hidden = false;
  }
  const valueAtX = (x) => {
    const r = range.getBoundingClientRect();
    return Math.round(clamp((x - r.left) / r.width, 0, 1) * (spreads.length - 1));
  };
  let scrubbing = false;
  function onRangeInput() {
    scrubbing = true;
    const v = Number(range.value);
    const r = range.getBoundingClientRect();
    bubbleAt(v, r.left + (r.width * v) / Math.max(1, spreads.length - 1));
    if (rangeFill) rangeFill.style.transform = `scaleX(${spreads.length > 1 ? v / (spreads.length - 1) : 0})`;
  }
  function onRangeChange() {
    scrubbing = false;
    if (bubble) bubble.hidden = true;
    go(Number(range.value));
  }
  function onRangeHover(e) {
    if (e.pointerType !== 'mouse' || scrubbing) return;
    bubbleAt(valueAtX(e.clientX), e.clientX);
  }
  const onRangeOut = () => { if (!scrubbing && bubble) bubble.hidden = true; };

  // The panel: chapters, every page, and search
  const tabs = panel ? [...panel.querySelectorAll('[role="tab"]')] : [];
  const panelBody = panel?.querySelector('.fb-panel-body');
  const searchBox = panel?.querySelector('.fb-search');
  let panelTab = chapters.length ? 'chapters' : 'pages';
  function openPanel(tab) {
    if (!panel) return;
    stopPlay();
    if (tab) panelTab = tab;
    buildPanel();
    // A phone's keyboard shouldn't cover the list: there, the tab takes focus, not the search box
    const coarse = matchMedia('(pointer: coarse)').matches;
    for (const el of [searchBox, ...tabs]) el?.removeAttribute('autofocus');
    (coarse ? tabs.find((t) => t.dataset.tab === panelTab && !t.hidden) || panel.querySelector('[data-fb="panel-close"]') : searchBox)?.setAttribute('autofocus', '');
    if (!panel.open) panel.showModal();
    panel.classList.remove('is-out');
    markPanel();
    requestAnimationFrame(() => panelBody?.querySelector('.is-current')?.scrollIntoView({ block: 'center' }));
  }
  function closePanel() {
    if (!panel?.open) return;
    if (reduced) { panel.close(); return; }
    panel.classList.add('is-out');
    setTimeout(() => { panel.close(); panel.classList.remove('is-out'); }, 180);
  }
  let built = false;
  function buildPanel() {
    const q = searchBox.value.trim();
    for (const t of tabs) {
      t.hidden = (t.dataset.tab === 'chapters' && !chapters.length) || (t.dataset.tab === 'text' && !texts.some((x) => String(x || '').trim()));
      const on = t.dataset.tab === panelTab;
      t.setAttribute('aria-selected', on && !q ? 'true' : 'false');
      t.tabIndex = on ? 0 : -1;
    }
    if (q.length === 1) {
      const p = document.createElement('p');
      p.className = 'fb-results-head';
      p.setAttribute('role', 'status');
      p.textContent = 'Type one more letter to search';
      panelBody.replaceChildren(p);
      built = false;
      return;
    }
    if (q.length >= 2) { panelBody.replaceChildren(results(q)); built = false; return; }
    const shape = `${panelTab}|${twoUp}|${panelTab === 'text' ? spread : ''}`;
    if (built && panelBody.dataset.shape === shape) return;
    panelBody.dataset.shape = shape;
    panelBody.setAttribute('aria-labelledby', `${root.id || 'fb'}-tab-${panelTab}`);
    built = true;
    panelBody.replaceChildren(panelTab === 'text' ? readView() : panelTab === 'chapters' && chapters.length ? chapterList() : pageGrid());
  }
  /** The words of the pages showing, to read as text (large, selectable, for anyone who'd rather) */
  function readView() {
    const wrap = document.createElement('div');
    wrap.className = 'fb-read';
    for (const p of pagesOf(spreads[spread])) {
      const h = document.createElement('h3');
      h.textContent = `Page ${p + 1}`;
      wrap.append(h);
      const paras = String(texts[p] || '').split(/\n{2,}/).map((x) => x.trim()).filter(Boolean);
      if (!paras.length) {
        const none = document.createElement('p');
        none.className = 'fb-read-none';
        none.textContent = 'No words on this page.';
        wrap.append(none);
      }
      for (const t of paras) { const para = document.createElement('p'); para.textContent = t; wrap.append(para); }
    }
    return wrap;
  }
  function pickTab(tab, focus = false) {
    panelTab = tab;
    searchBox.value = '';
    found.query = '';
    built = false;
    buildPanel();
    markPanel();
    drawOverlays();
    if (focus) tabs.find((t) => t.dataset.tab === tab)?.focus();
  }
  const thumb = (p, w = 180) => {
    const im = new Image();
    im.loading = 'lazy';
    im.decoding = 'async';
    im.alt = '';
    im.src = pageSrc(pages[p], w * Math.min(2, dpr));
    im.style.aspectRatio = String(aspect);
    return im;
  };
  function chapterList() {
    const ol = document.createElement('ol');
    ol.className = 'fb-chapters';
    for (const ch of chapters) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'fb-chapter';
      b.dataset.page = String(ch.page);
      const t = document.createElement('span');
      t.className = 'fb-chapter-title';
      t.textContent = ch.title;
      const pg = document.createElement('span');
      pg.className = 'fb-chapter-page';
      pg.textContent = `Page ${ch.page + 1}`;
      const txt = document.createElement('span');
      txt.className = 'fb-chapter-text';
      txt.append(t, pg);
      b.append(thumb(ch.page, 96), txt);
      b.addEventListener('click', () => jumpToPage(ch.page));
      li.append(b);
      ol.append(li);
    }
    return ol;
  }
  function pageGrid() {
    const grid = document.createElement('div');
    grid.className = 'fb-grid';
    spreads.forEach((sp, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `fb-cell${sp.left == null || sp.right == null ? ' is-single' : ''}`;
      b.dataset.spread = String(i);
      const ps = pagesOf(sp);
      b.setAttribute('aria-label', ps.length > 1 ? `Pages ${ps[0] + 1} and ${ps[1] + 1}` : `Page ${ps[0] + 1}`);
      const pics = document.createElement('span');
      pics.className = 'fb-cell-pages';
      pics.append(...ps.map((p) => thumb(p)));
      const lab = document.createElement('span');
      lab.className = 'fb-cell-label';
      lab.textContent = ps.map((p) => p + 1).join('–');
      b.append(pics, lab);
      b.addEventListener('click', () => { closePanel(); go(i); });
      grid.append(b);
    });
    return grid;
  }
  function results(q) {
    const list = searchPages(texts, q);
    const wrap = document.createElement('div');
    const head = document.createElement('p');
    head.className = 'fb-results-head';
    head.textContent = list.length ? `${list.length === 60 ? '60+' : list.length} page${list.length === 1 ? '' : 's'} with “${q}”` : `No pages with “${q}”`;
    head.setAttribute('role', 'status');
    wrap.append(head);
    const ol = document.createElement('ol');
    ol.className = 'fb-results';
    for (const r of list) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'fb-result';
      const txt = document.createElement('span');
      txt.className = 'fb-result-text';
      const pg = document.createElement('span');
      pg.className = 'fb-result-page';
      const ch = chapterAt(r.page);
      pg.textContent = `Page ${r.page + 1}${ch ? ` · ${ch.title}` : ''}`;
      const snip = document.createElement('span');
      snip.className = 'fb-result-snippet';
      const mark = document.createElement('mark');
      mark.textContent = r.match;
      snip.append(r.before, mark, r.after);
      txt.append(pg, snip);
      b.append(thumb(r.page, 72), txt);
      b.addEventListener('click', () => { count('search'); found.query = q; loadPositions(); jumpToPage(r.page); });
      li.append(b);
      ol.append(li);
    }
    wrap.append(ol);
    return wrap;
  }
  function markPanel() {
    if (!panel) return;
    const fp = firstPage();
    for (const el of panel.querySelectorAll('.fb-cell')) el.classList.toggle('is-current', Number(el.dataset.spread) === spread);
    const cur = chapterAt(fp);
    for (const el of panel.querySelectorAll('.fb-chapter')) el.classList.toggle('is-current', !!cur && Number(el.dataset.page) === cur.page);
  }
  function jumpToPage(p) {
    closePanel();
    const s = spreadOfPage(p, twoUp, n);
    if (s === spread) { drawOverlays(); return; }
    // After the panel's gone, so the turn is seen
    setTimeout(() => go(s), reduced ? 0 : 140);
  }

  // ─── Share, print, play, sound, go to a page, pick up where you left off ─
  /** This page's own address: the book, opened where it's open now */
  function pageUrl() {
    const u = new URL(location.href);
    u.search = '';
    u.hash = '';
    const p = firstPage();
    if (p > 0) u.searchParams.set('page', String(p + 1));
    return u.toString();
  }
  const nativeShare = () => !!navigator.share && matchMedia('(pointer: coarse)').matches;
  async function shareTo(ch) {
    const url = pageUrl();
    const title = book.title || document.title;
    const enc = encodeURIComponent;
    if (ch === 'native') {
      // Counted when it's shared: not when the sheet is closed, and as a copied link when it falls back to one
      try { await navigator.share({ title, url }); count('share', ch); } catch (e) { if (e?.name !== 'AbortError') shareTo('copy'); }
      return;
    }
    count('share', ch);
    if (ch === 'copy') {
      try { await navigator.clipboard.writeText(url); toast('Link to this page copied'); } catch { toast(url); }
    } else if (ch === 'email') {
      location.href = `mailto:?subject=${enc(title)}&body=${enc(`${title}\n${url}`)}`;
    } else {
      const href = {
        facebook: `https://www.facebook.com/sharer/sharer.php?u=${enc(url)}`,
        x: `https://twitter.com/intent/tweet?url=${enc(url)}&text=${enc(title)}`,
        linkedin: `https://www.linkedin.com/sharing/share-offsite/?url=${enc(url)}`,
      }[ch];
      if (href) window.open(href, '_blank', 'noopener,noreferrer,width=640,height=600');
    }
  }

  // Menus that open from the bar: one at a time, arrow keys inside, Escape or a click away closes
  let menuOpen = null;
  /** A menu's items as they stand at this width (More holds only what the bar leaves out) */
  const menuItems = (menu) => [...menu.querySelectorAll('[role^="menuitem"]')].filter((el) => !el.hidden && el.getClientRects().length);
  function openMenu(btn) {
    const menu = btn.nextElementSibling;
    if (!menu) return;
    if (menuOpen && menuOpen !== menu) closeMenu();
    if (!menu.hidden) { closeMenu(); return; }
    stopPlay();
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    menuOpen = menu;
    menuItems(menu)[0]?.focus();
  }
  function closeMenu(refocus = false) {
    if (!menuOpen) return;
    const btn = menuOpen.previousElementSibling;
    menuOpen.hidden = true;
    btn?.setAttribute('aria-expanded', 'false');
    menuOpen = null;
    if (refocus) btn?.focus();
  }
  function onMenuKey(e) {
    if (!menuOpen) return;
    const items = menuItems(menuOpen);
    const i = items.indexOf(document.activeElement);
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(true); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); items[(i + 1) % items.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); items[(i - 1 + items.length) % items.length]?.focus(); }
    else if (e.key === 'Home' || e.key === 'PageUp') { e.preventDefault(); items[0]?.focus(); }
    else if (e.key === 'End' || e.key === 'PageDown') { e.preventDefault(); items[items.length - 1]?.focus(); }
    else if (e.key === 'Tab') closeMenu();
  }

  /** Print the pages showing (the whole book prints from the PDF) */
  async function printPages() {
    count('print');
    const box = document.createElement('div');
    box.className = 'fb-print';
    for (const p of pagesOf(spreads[spread])) {
      const im = new Image();
      im.alt = `Page ${p + 1}`;
      im.src = pageSrc(pages[p], 2000);
      box.append(im);
    }
    document.body.append(box);
    await Promise.all([...box.querySelectorAll('img')].map((im) => (im.decode ? im.decode().catch(() => {}) : null)));
    const done = () => { box.remove(); document.documentElement.classList.remove('fb-printing'); window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    document.documentElement.classList.add('fb-printing');
    window.print();
    setTimeout(done, 60000);
  }

  // Play: the pages turn by themselves and the book starts again at the end (a screen at an event)
  const PLAY_MS = 4500;
  let playing = false;
  let playTimer = 0;
  const playBtn = $('[data-fb="play"]');
  function setPlay(on) {
    if (on === playing || (on && spreads.length < 2)) return;
    playing = on;
    clearTimeout(playTimer);
    root.classList.toggle('is-playing', on);
    playBtn?.setAttribute('aria-pressed', String(on));
    if (playBtn) { playBtn.dataset.tip = on ? 'Pause' : 'Play'; playBtn.setAttribute('aria-label', on ? 'Pause' : 'Play: turn the pages by themselves'); }
    if (on) { count('play'); dwellStop(); playStep(true); } else dwellStart();
  }
  function playStep(first = false) {
    clearTimeout(playTimer);
    playTimer = setTimeout(() => {
      if (!playing || destroyed) return;
      if (!panel?.open && !turn && zoom.z <= 1) { byPlay = true; go(heading() >= spreads.length - 1 ? 0 : heading() + 1); }
      playStep();
    }, first ? 900 : PLAY_MS);
  }
  const stopPlay = () => { if (playing) setPlay(false); };

  // A page's turn, heard: a soft paper sweep made here (no sound file), only once someone turns it on
  let soundOn = false;
  try { soundOn = localStorage.getItem('fb-sound') === '1'; } catch { soundOn = false; }
  const soundBtn = $('[data-fb="sound"]');
  function showSound() {
    root.classList.toggle('is-sound', soundOn);
    soundBtn?.setAttribute('aria-pressed', String(soundOn));
    if (soundBtn) soundBtn.dataset.tip = soundOn ? 'Sound off' : 'Sound on';
    $('[data-more="sound"]')?.setAttribute('aria-checked', String(soundOn));
  }
  showSound();
  let audio = null;
  let paperNoise = null;
  function turnSound() {
    if (!soundOn) return;
    try {
      audio ||= new (window.AudioContext || window.webkitAudioContext)();
      if (audio.state === 'suspended') audio.resume();
      const t0 = audio.currentTime, dur = 0.42;
      if (!paperNoise) {
        paperNoise = audio.createBuffer(1, Math.floor(audio.sampleRate * dur), audio.sampleRate);
        const d = paperNoise.getChannelData(0);
        for (let i = 0; i < d.length; i++) {
          const x = i / d.length;
          // A rise and a long fall, with the grain of paper in it
          d[i] = (Math.random() * 2 - 1) * Math.pow(Math.sin(Math.PI * Math.min(1, x * 1.6)), 1.5) * (1 - x) * (0.7 + 0.3 * Math.random());
        }
      }
      const src = audio.createBufferSource();
      src.buffer = paperNoise;
      const band = audio.createBiquadFilter();
      band.type = 'bandpass';
      band.Q.value = 0.7;
      band.frequency.setValueAtTime(3200, t0);
      band.frequency.exponentialRampToValueAtTime(700, t0 + dur);
      const low = audio.createBiquadFilter();
      low.type = 'highpass';
      low.frequency.value = 300;
      const gain = audio.createGain();
      gain.gain.value = 0.22;
      src.connect(band).connect(low).connect(gain).connect(audio.destination);
      src.start(t0);
    } catch { /* no sound is fine */ }
  }

  // The page number is also a box to type one into
  const gotoForm = $('[data-fb="goto"]');
  const gotoInput = gotoForm?.querySelector('input');
  function openGoto() {
    if (!gotoForm) return;
    stopPlay();
    // The box takes the label's place exactly: the arrows either side don't move
    gotoForm.style.width = `${labelEl.offsetWidth}px`;
    labelEl.hidden = true;
    gotoForm.hidden = false;
    gotoInput.value = String(firstPage() + 1);
    gotoInput.focus();
    gotoInput.select();
  }
  function closeGoto(refocus = false) {
    if (!gotoForm || gotoForm.hidden) return;
    gotoForm.hidden = true;
    labelEl.hidden = false;
    if (refocus) labelEl.focus();
  }
  function submitGoto(e) {
    e.preventDefault();
    const v = /^\s*\d+\s*$/.test(gotoInput.value) ? parseInt(gotoInput.value, 10) : NaN;
    if (!(v >= 1 && v <= n)) { toast(`Type a page number from 1 to ${n}`); gotoInput.select(); return; }
    closeGoto(true);
    go(spreadOfPage(v - 1, twoUp, n));
  }

  // Pick up where you left off (this browser remembers the page, nothing else)
  const lastKey = `fb-last:${location.pathname}`;
  const resumeEl = $('.fb-resume');
  let resuming = false;
  function offerResume() {
    if (!resumeEl || preview) return;
    let last = null;
    try { last = JSON.parse(localStorage.getItem(lastKey) || 'null'); } catch { last = null; }
    if (!last || last.v !== (book.version || '') || !(last.page >= 2 && last.page < n) || Date.now() - last.t > 120 * 864e5) return;
    const go_ = resumeEl.querySelector('[data-fb="resume"]');
    go_.textContent = `Page ${last.page + 1}`;
    go_.setAttribute('aria-label', `Go to page ${last.page + 1}`);
    resumeEl.hidden = false;
    resumeEl.dataset.page = String(last.page);
    tellResume(last.page);
  }
  let resumeTimer = 0;
  let keepOfferAt = -1;   // the spread the page's "Open the book" turns to: landing there leaves the offer up
  /** The offer, for the page around the book (its "Open the book" becomes "Pick up at page N"): data-resume and an event */
  function tellResume(page) {
    if (page == null) delete root.dataset.resume; else root.dataset.resume = String(page);
    root.dispatchEvent(new CustomEvent('flipbook:resume', { bubbles: true, detail: { page } }));
  }
  function dropResume() {
    clearTimeout(resumeTimer);
    if (!resumeEl || resumeEl.hidden) return;
    resumeEl.hidden = true;
    tellResume(null);
  }
  // Fourteen seconds once the book is on screen (not from the page loading, with the book far below the hero)
  function resumeSeen() {
    if (resumeEl && !resumeEl.hidden && !resumeTimer) resumeTimer = setTimeout(dropResume, 14000);
  }

  // ─── Reading, counted: what was read and for how long, never who (/api/book-stats) ─
  const statsOn = !preview && /^[a-z0-9]{4,20}$/.test(String(book.version || '')) && !!navigator.sendBeacon;
  const sess = (k, v) => { try { if (v === undefined) return sessionStorage.getItem(`${k}:${book.version}`); sessionStorage.setItem(`${k}:${book.version}`, v); } catch { /* storage off: counted again on reload */ } return null; };
  const blankTally = () => ({ views: {}, ms: {}, time: 0, share: {}, links: {}, download: 0, print: 0, search: 0, play: 0, full: 0, reach: null, end: false, reader: false });
  let tally = blankTally();
  let tallied = statsOn;           // something to send (the visit itself, at first)
  let reach = statsOn ? Number(sess('fb-reach') ?? -1) : -1;
  let lastActive = now();
  let dwell = { pages: [], since: 0 };
  const IDLE_MS = 180000;
  function active() { lastActive = now(); }
  function count(field, key) {
    if (!statsOn) return;
    if (key == null) tally[field]++;
    else tally[field][key] = (tally[field][key] || 0) + 1;
    tallied = true;
  }
  const watching = () => !document.hidden && (inView || root.classList.contains('is-full'));
  function dwellStop() {
    if (!dwell.since) return;
    const end = Math.min(now(), lastActive + IDLE_MS);
    const ms = Math.round(Math.min(300000, Math.max(0, end - dwell.since)));
    if (ms > 0) { for (const p of dwell.pages) tally.ms[p] = (tally.ms[p] || 0) + ms; tally.time += ms; tallied = true; }
    dwell.since = 0;
  }
  function dwellStart() {
    dwellStop();
    // Play turning the pages by itself (a screen at an event) isn't someone reading
    if (statsOn && watching() && !playing) dwell = { pages: pagesOf(spreads[spread]), since: now() };
  }
  let byPlay = false;       // the turn landing now is Play's, not the reader's
  let seenLater = false;    // the first pages, counted once the book is on screen (not at the top of the page)
  /**
   * Pages on screen: views, and how far this visit got. "How far people read" and "read to the end" count only
   * visits that began at the cover: a shared link to page 24 isn't someone who read pages 1 to 23.
   */
  function seen(turned) {
    if (!statsOn) return;
    const auto = byPlay;
    byPlay = false;
    if (!turned && !inView && !root.classList.contains('is-full')) { seenLater = true; return; }
    seenLater = false;
    if (auto) { dwellStart(); return; }
    const ps = pagesOf(spreads[spread]);
    for (const p of ps) tally.views[p] = (tally.views[p] || 0) + 1;
    tallied = true;
    if (sess('fb-from') == null) sess('fb-from', String(spread));
    const fromCover = sess('fb-from') === '0';
    const far = Math.max(...ps);
    if (fromCover && far > reach) { tally.reach = [tally.reach ? tally.reach[0] : reach, far]; reach = far; sess('fb-reach', String(far)); }
    if (turned && !sess('fb-reader')) { tally.reader = true; sess('fb-reader', '1'); }
    if (fromCover && turned && spread >= spreads.length - 1 && !sess('fb-end')) { tally.end = true; sess('fb-end', '1'); }
    dwellStart();
  }
  const deviceKind = () => (matchMedia('(pointer: coarse)').matches ? (Math.min(screen.width, screen.height) < 600 ? 'phone' : 'tablet') : 'computer');
  function flush() {
    if (!statsOn) return;
    dwellStop();
    if (tallied) {
      const body = { v: book.version };
      if (!sess('fb-visit')) { body.visit = 1; body.device = deviceKind(); if (document.referrer) body.from = document.referrer; sess('fb-visit', '1'); }
      for (const k of ['views', 'ms', 'share', 'links']) if (Object.keys(tally[k]).length) body[k] = tally[k];
      for (const k of ['time', 'download', 'print', 'search', 'play', 'full']) if (tally[k]) body[k] = tally[k];
      if (tally.reach) body.reach = tally.reach;
      if (tally.end) body.end = 1;
      if (tally.reader) body.reader = 1;
      if (Object.keys(body).length > 1) {
        try { navigator.sendBeacon('/api/book-stats', new Blob([JSON.stringify(body)], { type: 'application/json' })); } catch { /* counting never gets in the way */ }
      }
      tally = blankTally();
      tallied = false;
    }
    if (!destroyed) dwellStart();
  }
  let toastTimer = 0;
  function toast(msg) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.hidden = false;
    toastEl.classList.remove('is-out');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toastEl.classList.add('is-out'); setTimeout(() => { toastEl.hidden = true; }, 200); }, 2200);
  }

  // Full screen: the real thing where the browser has it, the whole window where it doesn't (iPhone)
  let nativeFull = false;
  let fullFrom = null;   // where the book sat in the window, to put it back there after
  async function enterFull() {
    if (root.classList.contains('is-full')) return;
    count('full');
    fullFrom = root.getBoundingClientRect().top;
    root.classList.add('is-full');
    document.documentElement.classList.add('fb-locked');
    nativeFull = false;
    if (root.requestFullscreen && document.fullscreenEnabled) {
      try { await root.requestFullscreen({ navigationUI: 'hide' }); nativeFull = true; } catch { /* the window will do */ }
    }
    afterResize();
    fullLabel();
    stage.focus({ preventScroll: true });
  }
  function fullLabel() {
    const b = $('[data-fb="full"]');
    if (!b) return;
    const full = root.classList.contains('is-full');
    b.setAttribute('aria-label', full ? 'Exit full screen' : 'Full screen');
    b.dataset.tip = full ? 'Exit full screen' : 'Full screen';
    const item = $('[data-more="full"] span');
    if (item) item.textContent = full ? 'Exit full screen' : 'Full screen';
  }
  function exitFull() {
    if (!root.classList.contains('is-full')) return;
    root.classList.remove('is-full');
    document.documentElement.classList.remove('fb-locked');
    nativeFull = false;
    // Back in the page, the browser's scroll anchoring would keep what's under the book in place and push the
    // book up by its own height: the book goes back where it was in the window instead (once the browser's
    // own full screen has let go, or the book still measures at the top of the screen)
    const back = () => {
      if (fullFrom != null && !root.classList.contains('is-full')) window.scrollBy({ top: root.getBoundingClientRect().top - fullFrom, behavior: 'instant' });
      fullFrom = null;
      afterResize();
    };
    if (document.fullscreenElement === root && document.exitFullscreen) document.exitFullscreen().catch(() => {}).then(back);
    else back();
    fullLabel();
  }
  function onFullChange() {
    if (nativeFull && document.fullscreenElement !== root) { nativeFull = false; exitFull(); }
  }

  // ─── Keys ────────────────────────────────────────────────────────
  function onKey(e) {
    if (destroyed || e.defaultPrevented || e.altKey) return;
    active();
    if (menuOpen) { onMenuKey(e); return; }
    if (panel?.open) return;
    if (typing(document.activeElement)) return;
    // Only the book's own keys, and only when nothing else on the page wants them
    if (document.querySelector('dialog[open]')) return;
    const full = root.classList.contains('is-full');
    const mine = full || root.contains(document.activeElement);
    const k = e.key;
    if ((k === 'ArrowRight' || k === 'ArrowLeft') && !e.metaKey && !e.ctrlKey) {
      // Arrows are the book's while it's in view (or has focus): scrolled away, they're the page's
      if (!(mine || inView) || document.activeElement === range) return;
      e.preventDefault();
      stopPlay();
      if (k === 'ArrowRight') next(); else prev();
    }
    else if (!mine) return;
    else if (k === 'Home') { e.preventDefault(); stopPlay(); go(0); }
    else if (k === 'End') { e.preventDefault(); stopPlay(); go(spreads.length - 1); }
    else if ((k === 'PageDown' || (k === ' ' && full)) && !e.metaKey) { e.preventDefault(); stopPlay(); next(); }
    else if (k === 'PageUp') { e.preventDefault(); stopPlay(); prev(); }
    else if (k === '+' || k === '=') { e.preventDefault(); zoomTo(zoom.z * 1.5, sw / 2, sh / 2, true); }
    else if (k === '-' || k === '_') { e.preventDefault(); zoomTo(zoom.z / 1.5, sw / 2, sh / 2, true); }
    else if (k === '0') { e.preventDefault(); zoomTo(1, sw / 2, sh / 2, true); }
    else if (k === 'Escape') {
      if (zoom.z > 1) { e.preventDefault(); zoomTo(1, sw / 2, sh / 2, true); }
      else if (full && !nativeFull) { e.preventDefault(); exitFull(); }
    }
  }
  // The panel's tabs move with the arrow keys, like tabs everywhere
  function onTabKey(e) {
    const shown = tabs.filter((t) => !t.hidden);
    const i = shown.indexOf(e.currentTarget);
    let j = -1;
    if (e.key === 'ArrowRight') j = (i + 1) % shown.length;
    else if (e.key === 'ArrowLeft') j = (i - 1 + shown.length) % shown.length;
    else if (e.key === 'Home') j = 0;
    else if (e.key === 'End') j = shown.length - 1;
    if (j < 0) return;
    e.preventDefault();
    pickTab(shown[j].dataset.tab, true);
  }

  // ─── Wiring ──────────────────────────────────────────────────────
  const offs = [];
  const on = (el, type, fn, opts) => { if (!el) return; el.addEventListener(type, fn, opts); offs.push(() => el.removeEventListener(type, fn, opts)); };
  on(stage, 'pointerdown', onDown);
  on(stage, 'pointermove', onMove);
  on(stage, 'pointerup', onUp);
  on(stage, 'pointercancel', onUp);
  on(stage, 'pointerleave', onLeave);
  on(stage, 'wheel', onWheel, { passive: false });
  on(stage, 'dblclick', (e) => { if (zoom.z > 1) { const p = toStage(e); zoomTo(1, p.x, p.y, true); } });
  on(stage, 'dragstart', (e) => e.preventDefault());
  // Closed on a phone (a chapter tapped, a search's Enter on the phone's keyboard): the book has the focus, without a
  // ring around Contents the person never moved to
  if (panel) on(panel, 'close', () => {
    if (matchMedia('(pointer: coarse)').matches) { stage.dataset.pointer = '1'; stage.focus({ preventScroll: true }); }
  });
  on(stage, 'blur', () => { delete stage.dataset.pointer; });
  // The page's "Open the book": turn the cover if it's still closed
  on(root, 'flipbook:open', (e) => {
    const page = e.detail?.page;
    if (Number.isInteger(page) && page > 0 && page < n) { resumeAt(page); return; }
    if (heading() === 0 && canForward()) { keepOfferAt = 1; go(1); }
  });
  on(document, 'keydown', onKey);
  on(document, 'fullscreenchange', onFullChange);
  const byHand = (fn) => () => { stopPlay(); fn(); };
  on(prevBtn, 'click', byHand(prev));
  on(nextBtn, 'click', byHand(next));
  on(barPrev, 'click', byHand(prev));
  on(barNext, 'click', byHand(next));
  on(labelEl, 'click', openGoto);
  on(gotoForm, 'submit', submitGoto);
  on(gotoInput, 'keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); closeGoto(true); } });
  on(gotoInput, 'blur', () => setTimeout(() => closeGoto(false), 0));
  on(playBtn, 'click', () => setPlay(!playing));
  const toggleSound = () => {
    soundOn = !soundOn;
    try { localStorage.setItem('fb-sound', soundOn ? '1' : '0'); } catch { /* remembered for this visit only */ }
    showSound();
    if (soundOn) turnSound();
  };
  on(soundBtn, 'click', toggleSound);
  for (const btn of root.querySelectorAll('[aria-haspopup="menu"]')) {
    on(btn, 'click', () => {
      if (btn.dataset.fb === 'share' && nativeShare()) { shareTo('native'); return; }
      openMenu(btn);
    });
  }
  for (const item of root.querySelectorAll('[data-share]')) on(item, 'click', () => { closeMenu(true); shareTo(item.dataset.share); });
  for (const el of root.querySelectorAll('[data-print="pages"]')) on(el, 'click', () => { closeMenu(true); printPages(); });
  // More: the same actions as the bar's buttons it stands in for
  const fromMore = (what, fn) => on($(`[data-more="${what}"]`), 'click', () => { closeMenu(true); fn(); });
  fromMore('share', () => shareTo(nativeShare() ? 'native' : 'copy'));
  fromMore('play', () => setPlay(true));
  fromMore('sound', toggleSound);
  fromMore('full', () => (root.classList.contains('is-full') ? exitFull() : enterFull()));
  on($('.fb-more a[download]'), 'click', () => closeMenu());
  on($('[data-print="book"]'), 'click', () => { closeMenu(); count('print'); flush(); });
  on($('[data-fb="share-foot"]'), 'click', () => shareTo(nativeShare() ? 'native' : 'copy'));
  on(document, 'pointerdown', (e) => { if (menuOpen && !menuOpen.parentElement.contains(e.target)) closeMenu(); });
  function resumeAt(page) {
    resuming = true;
    dropResume();
    go(spreadOfPage(page, twoUp, n));
    resuming = false;
  }
  on($('[data-fb="resume"]'), 'click', (e) => {
    resumeAt(Number(resumeEl.dataset.page));
    // The button's gone: the keys go to the book (no ring for a click)
    if (e.detail) stage.dataset.pointer = '1'; else delete stage.dataset.pointer;
    stage.focus({ preventScroll: true });
  });
  on($('[data-fb="resume-no"]'), 'click', () => { dropResume(); stage.focus({ preventScroll: true }); });
  // The PDF, downloaded from here or from the page around the book
  on(document, 'click', (e) => {
    const a = e.target.closest?.('a[download]');
    if (a && book.pdf?.url && a.getAttribute('href') === book.pdf.url) { count('download'); flush(); }
  });
  on(document, 'visibilitychange', () => { if (document.hidden) flush(); else dwellStart(); });
  on(window, 'pagehide', flush);
  const flushTimer = setInterval(flush, 30000);
  offs.push(() => clearInterval(flushTimer));
  on(range, 'input', (e) => { stopPlay(); onRangeInput(e); });
  on(range, 'change', onRangeChange);
  on(range, 'pointermove', onRangeHover);
  on(range, 'pointerleave', onRangeOut);
  on(range, 'blur', onRangeOut);
  on($('[data-fb="panel"]'), 'click', () => openPanel());
  on($('[data-fb="full"]'), 'click', () => (root.classList.contains('is-full') ? exitFull() : enterFull()));
  on($('[data-fb="close"]'), 'click', exitFull);
  on($('[data-fb="zoom-in"]'), 'click', () => zoomTo(zoom.z * 1.6, sw / 2, sh / 2, true));
  on($('[data-fb="zoom-out"]'), 'click', () => zoomTo(zoom.z / 1.6, sw / 2, sh / 2, true));
  if (panel) {
    on(panel.querySelector('[data-fb="panel-close"]'), 'click', closePanel);
    on(panel, 'cancel', (e) => { e.preventDefault(); closePanel(); });
    on(panel, 'click', (e) => { if (e.target === panel) closePanel(); });
    for (const t of tabs) { on(t, 'click', () => pickTab(t.dataset.tab)); on(t, 'keydown', onTabKey); }
    let searchTimer = 0;
    on(searchBox, 'input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        const q = searchBox.value.trim();
        if (q.length < 2 && found.query) { found.query = ''; drawOverlays(); }
        if (q.length >= 2) loadPositions();
        buildPanel();
        markPanel();
      }, 120);
    });
    on(searchBox, 'keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); panel.querySelector('.fb-result')?.click(); } });
  }
  const onReduce = () => { reduced = reduceQuery.matches; };
  reduceQuery.addEventListener?.('change', onReduce);
  offs.push(() => reduceQuery.removeEventListener?.('change', onReduce));
  if (curl) curl.onRestore = () => kick();

  // Sizes follow the space
  let resizeRaf = 0;
  function afterResize() {
    cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => {
      if (destroyed) return;
      const r = stage.getBoundingClientRect();
      // Hidden (display: none somewhere above): nothing to fit yet
      if (r.width < 40 || r.height < 40) return;
      if (Math.abs(r.width - sw) < 0.5 && Math.abs(r.height - sh) < 0.5 && (window.devicePixelRatio || 1) === dpr) return;
      // A turn in flight lands where it was going, and whatever a finger or the mouse was doing ends: the new size starts from rest
      if (turn) { const T = turn; turn = null; root.classList.remove('is-turning'); settleAt(T.kind === 'auto' || (T.kind === 'settle' && T.complete) ? T.to : T.from); }
      queued = null;
      down = null;
      pan = null;
      pinch = null;
      touches.clear();
      root.classList.remove('is-panning');
      measure();
      zoom = { z: 1, tx: 0, ty: 0 };
      applyZoom(false);
      built = false;
      settleAt(spread);
      if (curl) curl.clear();
    });
  }
  const ro = new ResizeObserver(() => afterResize());
  ro.observe(stage);
  offs.push(() => ro.disconnect());

  // A phone turned on its side (or a window made wider or narrower) while someone reads: the book stays on
  // screen with its controls, instead of wherever the old scroll position now falls. Only a change of width
  // counts: a phone's address bar coming and going changes the height alone, mid-scroll.
  let lastWidth = window.innerWidth;
  on(window, 'resize', () => {
    if (window.innerWidth === lastWidth) return;
    lastWidth = window.innerWidth;
    closeMenu();
    if (!inView || root.classList.contains('is-full') || preview) return;
    clearTimeout(keepTimer);
    keepTimer = setTimeout(() => requestAnimationFrame(keepInView), 80);
  });
  let keepTimer = 0;
  offs.push(() => clearTimeout(keepTimer));
  function keepInView() {
    if (destroyed || root.classList.contains('is-full')) return;
    const header = document.querySelector('.site-header');
    const pos = header ? getComputedStyle(header).position : '';
    const top = (pos === 'sticky' || pos === 'fixed') ? Math.max(0, header.getBoundingClientRect().bottom) : 0;
    const s = stage.getBoundingClientRect();
    const end = (root.querySelector('.fb-controls') || stage).getBoundingClientRect().bottom;
    // The book's top just under the header; when it and its controls are taller than the room, the controls at the bottom
    let by = s.top - (top + 8);
    if (end - by > window.innerHeight) by = end - window.innerHeight + 4;
    if (Math.abs(by) > 1) window.scrollBy({ top: by, behavior: 'instant' });
  }

  // In view: the arrow keys are the book's. The first time, its corner lifts once: it turns
  let hinted = false;
  const io = new IntersectionObserver((entries) => {
    const en = entries[entries.length - 1];
    const was = inView;
    inView = en.intersectionRatio >= 0.35;
    if (inView !== was) { if (inView) dwellStart(); else dwellStop(); }
    if (inView) { resumeSeen(); if (seenLater) seen(false); }
    if (hinted || en.intersectionRatio < 0.6) return;
    hinted = true;
    if (!curling() || spread !== 0 || turn || !canForward()) return;
    hint = true;
    setTimeout(() => {
      if (!hint || turn || destroyed || zoom.z > 1) return;
      const T = begin('peel', spread, spread + 1, L.H);
      if (!T) return;
      T.target = { x: L.W - Math.min(70, L.W * 0.16), y: L.H - Math.min(46, L.H * 0.08) };
      kick();
      setTimeout(() => { if (turn === T && T.kind === 'peel') { T.leaving = true; T.target = { x: L.W, y: L.H }; kick(); } }, 650);
    }, 700);
  }, { threshold: [0, 0.35, 0.6] });
  io.observe(stage);
  offs.push(() => io.disconnect());

  // ─── Start ───────────────────────────────────────────────────────
  measure();
  const asked = /[?&]page=/.test(location.search);
  const startPage = Number.isInteger(options.startPage) ? clamp(options.startPage, 0, n - 1) : preview ? null : pageFromSearch(location.search, n);
  if (startPage != null) {
    spread = spreadOfPage(startPage, twoUp, n);
    offset = spreadOffset(spreads[spread], L.W, twoUp);
  } else if (asked && !preview) writeAddress(0); // ?page=999: the address says where the book really opened
  if (startPage == null && !asked) offerResume();
  if (startPage != null && asked && !preview && performance.getEntriesByType?.('navigation')?.[0]?.type !== 'reload'
    && performance.getEntriesByType?.('navigation')?.[0]?.type !== 'back_forward') {
    root.scrollIntoView({ block: 'start', behavior: 'instant' });
  }
  // The cover the server drew stays until its own picture is ready
  const ssr = spread === 0 ? slotR.querySelector('img') : null;
  if (ssr && !spreadReady(spread)) {
    showing.right = ssr;
    place();
    edges();
    updateUi(false);
    preload();
    whenReady(spread).then(() => { if (!destroyed && !turn && spread === 0) settleAt(0); });
  } else settleAt(spread);
  root.classList.add('is-ready');

  function destroy() {
    flush();
    setPlay(false);
    clearTimeout(resumeTimer);
    destroyed = true;
    cancelAnimationFrame(raf);
    cancelAnimationFrame(resizeRaf);
    cancelAnimationFrame(glide);
    clearTimeout(addressTimer);
    clearTimeout(sharpTimer);
    clearTimeout(toastTimer);
    for (const off of offs) off();
    if (root.classList.contains('is-full')) exitFull();
    if (panel?.open) panel.close();
    curl?.destroy();
  }

  return { destroy, go: (s) => go(s), get spread() { return spread; }, get page() { return firstPage(); }, get twoUp() { return twoUp; } };
}
