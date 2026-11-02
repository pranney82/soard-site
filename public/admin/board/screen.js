/**
 * The board page → a meeting on the screen (#/meetings/<id>/screen)
 * ===========================================================================
 * What the room's TV, or the window shared on Google Meet, shows while the
 * board meets: the cover (the meeting and its agenda), each item's card (who
 * presents it, with faces, its background for the board, its live numbers,
 * the documents coming), each page of each document, a vote as the board
 * casts it, and the close. Only what the board can see on their page: never
 * a private note or a staff-only file.
 *
 * The chair moves it from Board → the meeting → During (../board-present.js).
 * On the chair's computer each move arrives at once over a BroadcastChannel,
 * and keys pressed here (← →, ↑ ↓, the space bar, a clicker's Page Up and
 * Page Down) go back to the chair. Anywhere else (the TV's own laptop, a
 * board member following on their own screen) it follows the meeting's live
 * state, asked for every second and a half. F (or the button that shows when
 * the mouse moves) fills the screen.
 *
 * Documents are drawn page by page by ./docs.js, the same pages Print it all
 * prints, so "page 3" is the same page everywhere.
 */

import { h, htm, useState, useEffect, useRef, useMemo } from '../vendor.js';
import { openDoc, layoutOf, areaOf, areasOf, headingsArea, partsOf, docKind } from './docs.js';
import {
  meetingName, longDate, shortDate, timeRange, liveLines, noteBlocks, agendaItems, presentersOf, deckOf, stopIndex, isDate, clock, todayEastern, MORE,
  sectionPlan, sectionClock, clockText, liveOfStop, facesOf, itemDocs, docsOf, docTitle, formatOf, plural, initialsOf, namesText, LIVE_TITLES,
} from '../board-shared.js';
import { useCover, usePages } from '../board-present.js';
import { Report } from '../board-report.js';
import { BooksSlide, BOOKS_TITLES } from './books.js';
import { mdWords, mdPoints, mdFigures } from '../board-md.js';
import { Pipeline, sized } from './kanban.js';
import { useCashNow, useBudget, moneyTiles, mixOf, RevenueMix, budgetDue, readChangeAs, keepChangeAs } from './money.js';

const html = htm.bind(h);
const API = '/api/board-portal';
const CHANNEL = 'soard-board-screen';
// The chair's own copy of the screen, small in Board's During (?mirror): it follows the chair but isn't a screen
// window (it never says hello, takes no keys and has no full-screen button)
const MIRROR = new URLSearchParams(location.search).has('mirror');
// Board's preview beside the agenda editor (?preview): it follows the item being worked on, never the chair
const PREVIEW = new URLSearchParams(location.search).has('preview');
// The report page's preview (?preview&report): one item, drawn from the page's own copy of the meeting; never asks the
// server for the live view
const SOLO = PREVIEW && new URLSearchParams(location.search).has('report');
// Presenting, from Board or the meeting's page (?present): this window moves itself (→ ← and the space bar, a clicker's
// Page Down and Page Up, Home, End), from the cover or the slide it's opened on (&at=), whatever the meeting's saved
// state. On the meeting's day each part's timer runs from when the part comes up. B (or .) blanks the screen
const PRESENT = new URLSearchParams(location.search).has('present');
const AT = new URLSearchParams(location.search).get('at') || '';
// Moved here, never by a chair: the presenting window, and Board's preview beside the agenda (where the editor sends it)
const OWN = PRESENT || PREVIEW;
const LOGO = '/cdn-cgi/imagedelivery/ROYFuPmfN2vPS6mt5sCkZQ/brand-logo-admin/w=256';

const hueOf = (s) => [42, 28, 96, 152, 200, 18][[...String(s)].reduce((a, c) => a + c.charCodeAt(0), 0) % 6];
function Face({ p, size }) {
  const [broken, setBroken] = useState(false);
  return p?.photo && !broken
    ? html`<img class="bs-face" src=${p.photo} alt="" width=${size} height=${size} style=${`--s:${size}px`} onError=${() => setBroken(true)} />`
    : html`<span class="bs-face bs-face--initials" style=${`--s:${size}px;--hue:${hueOf(p?.name)}`} aria-hidden="true">${initialsOf(p?.name)}</span>`;
}
const BACK = html`<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><path d="M16 10H4M9 15l-5-5 5-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>`;
const FULL = html`<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><path d="M3.5 7.5v-4h4M12.5 3.5h4v4M16.5 12.5v4h-4M7.5 16.5h-4v-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>`;
/** The whole screen for the screen, or back */
const fullScreen = () => { if (document.fullscreenElement) document.exitFullscreen?.(); else document.documentElement.requestFullscreen?.().catch(() => {}); };
const nowClock = () => new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });

/** The meeting as it's held, every 1.5 seconds (4 while the chair's computer is moving this screen itself) */
function useLiveView(id, fast, off = false) {
  const [v, setV] = useState(null);
  const [fail, setFail] = useState('');
  // Three looks in a row that got no answer (the server's trouble, no connection): it says so, and keeps trying
  const [trouble, setTrouble] = useState(false);
  useEffect(() => {
    if (off) return undefined;
    let stop = false;
    let t = 0;
    let missed = 0;
    let over = false;
    let gone = false;
    const tick = async () => {
      clearTimeout(t);
      let ok = false;
      try {
        const r = await fetch(`${API}?live=${encodeURIComponent(id)}`, { cache: 'no-store' });
        const j = await r.json().catch(() => null);
        if (stop) return;
        // Any refusal (no such meeting, not shared, a link mistyped) says so, never "Opening…" for good
        gone = false;
        if (j?.ok && Array.isArray(j.sections)) { setV(j); setFail(''); ok = true; over = !!j.live?.endedAt || (!j.live?.startedAt && isDate(j.date) && j.date < todayEastern()); } else if (r.status < 500 && (r.status >= 400 || j?.ok === false)) { setFail(r.status === 403 && j?.error ? j.error : 'That meeting isn’t on the board page'); ok = true; gone = true; }
      } catch { /* the next look tries again */ }
      if (stop) return;
      missed = ok ? 0 : missed + 1;
      setTrouble(missed >= 3);
      // A meeting that's over changes no more: a look every half minute (in case the chair opens it again)
      // (no answer: tried again at once twice, then less often)
      t = setTimeout(tick, over || gone ? 30000 : missed ? (missed < 3 ? 1500 : Math.min(10000, 1500 * 2 ** (missed - 2))) : fast.current ? 4000 : 1500);
    };
    tick();
    const back = () => { if (document.visibilityState === 'visible' && navigator.onLine !== false) tick(); };
    addEventListener('online', back);
    return () => { stop = true; clearTimeout(t); removeEventListener('online', back); };
  }, [id]);
  return [v, fail, trouble];
}

// A close-up's margin, a share of the page's width as a page's own margin is
const MARGIN = 0.035;
/**
 * Page `page` of a file on a sheet as big as `box` ({ w, h }) allows → { el, count, halves }. When the whole page
 * would leave its words small, the sheet shows them close up: the part of the page with something on it, or of a
 * tall page its top or its bottom (`part`, ./docs.js layoutOf). Every stop of a file shares one sheet, as wide as
 * its widest lines and as tall as its tallest part with the same margin all round, at one zoom, so Next never moves
 * or resizes it: the words change, starting on the same line. A file that reads well whole shows as its pages.
 * `ahead` also works out the next page, so it's there at once.
 */
async function drawFitted(f, page, box, { ahead = false, part = 0 } = {}) {
  const doc = await openDoc(f);
  // A file the screen can't draw (an old .doc, an iPhone photo): said so, not its download card
  if (doc.kind === 'other') throw new Error('not drawable');
  const i = Math.max(0, Math.min(page, doc.count - 1));
  const size = doc.size(i);
  const tall = size.h / size.w;
  const fit = Math.floor(Math.min(box.w, box.h / tall));
  // Where its words are (worked out once a page, small, the same everywhere)
  const lay = await layoutOf(f, doc, i);
  const area = areaOf(lay, part);
  const el = document.createElement('div');
  el.className = 'bs-sheet';
  let close = false;
  if (area) {
    // A table's second part carries its column headings over its first line
    const head = headingsArea(lay, part);
    const mine = { ...area, n: lay.n, extra: head ? head.h + head.gap : 0 };
    // The file's parts (every page's, or a long file's same 40 or so: never this one added, so the sheet doesn't
    // change with the page)
    const theirs = await areasOf(f, doc, i);
    const all = theirs.length ? theirs : [mine];
    // The sheet: as wide and as tall as the file's parts cut in two need, and its pages shown whole that are little
    // taller; a page bigger than that (a photo filling it, a scan) comes up smaller on the same sheet instead of making
    // every other page small
    const split = all.filter((a) => a.n === 2);
    const tallest = Math.max(0, ...split.map((a) => a.h + (a.extra || 0)));
    const typical = split.length ? all.filter((a) => a.n === 2 || a.h <= tallest * 1.25) : all;
    const x0 = Math.min(...typical.map((a) => a.x));
    const x1 = Math.max(...typical.map((a) => a.x + a.w));
    const hi = Math.max(...typical.map((a) => a.h + (a.extra || 0)));
    const W = Math.floor(Math.min(fit * 3, box.w / (x1 - x0 + 2 * MARGIN), box.h / (hi * tall + 2 * MARGIN)));
    // Close up when it's bigger, and always for a file shown in parts (on a phone each part would else be the whole
    // page again)
    if (W > fit * 1.12 || split.length) {
      close = true;
      const H = Math.round(W * tall);
      const m = Math.floor(W * MARGIN);
      // This part at the sheet's zoom; one bigger than the sheet smaller, across its middle
      const fits = mine.x >= x0 - 1e-6 && mine.x + mine.w <= x1 + 1e-6 && mine.h + mine.extra <= hi + 1e-6;
      const k = fits ? 1 : Math.min(1, hi / (mine.h + mine.extra), (x1 - x0) / mine.w);
      const Wk = Math.floor(W * k);
      const Hk = Math.round(Wk * tall);
      const left = fits ? x0 : mine.x;
      const across = fits ? x1 - x0 : mine.w;
      const inset = fits ? 0 : Math.max(0, Math.floor(((x1 - x0) * W - across * Wk) / 2));
      const cropOf = async (y, h) => {
        const drawn = await doc.draw(i, { width: Wk });
        drawn.style.marginLeft = `${-Math.round(left * Wk)}px`;
        drawn.style.marginTop = `${-Math.round(y * Hk)}px`;
        const crop = document.createElement('div');
        crop.className = 'bs-crop';
        crop.style.width = `${Math.round(across * Wk)}px`;
        crop.style.height = `${Math.round(h * Hk)}px`;
        if (inset) crop.style.marginLeft = `${inset}px`;
        crop.append(drawn);
        return crop;
      };
      el.style.width = `${Math.round((x1 - x0) * W) + 2 * m}px`;
      el.style.height = `${Math.round(hi * H) + 2 * m}px`;
      el.style.padding = `${m}px`;
      const crop = await cropOf(area.y, area.h);
      if (head) {
        const heads = await cropOf(head.y, head.h);
        heads.classList.add('bs-crop--head');
        crop.style.marginTop = `${Math.round(head.gap * Hk)}px`;
        el.append(heads);
      }
      el.append(crop);
    }
  }
  if (!close) {
    el.style.width = `${fit}px`;
    el.style.height = `${Math.round(fit * tall)}px`;
    el.append(await doc.draw(i, { width: fit }));
  }
  if (ahead && i + 1 < doc.count) layoutOf(f, doc, i + 1).catch(() => {});
  return { el, count: doc.count, halves: lay.n };
}

/**
 * A page (or part of one) on the screen, kept up until the next is drawn (no flash between): on the same sheet only
 * the words move, a little the way the meeting went; `onPages` hears the counts
 */
function DocPage({ f, page, part = 0, box, onPages }) {
  const ref = useRef(null);
  const was = useRef(null);
  const learned = useRef(false);
  const [state, setState] = useState('opening');
  useEffect(() => {
    if (!f || !box.w || !box.h) return undefined;
    let gone = false;
    drawFitted(f, page, box, { ahead: true, part }).then(({ el, count, halves }) => {
      if (gone || !ref.current) return;
      onPages?.(f.id, count, page, halves);
      const old = ref.current.firstElementChild;
      const from = was.current;
      was.current = { page, part };
      ref.current.replaceChildren(el);
      const same = old && old.style.width === el.style.width && old.style.height === el.style.height;
      if (same && from && el.firstElementChild?.animate && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
        const on = page > from.page || (page === from.page && part > from.part);
        for (const c of el.children) c.animate([{ opacity: 0, transform: `translateY(${on ? 14 : -14}px)` }, { opacity: 1, transform: 'none' }], { duration: 260, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' });
      }
      setState('');
      // Every page's parts, once a file (they were worked out for its sheet): a screen on its own then counts the
      // stops as the chair does, a blank page left out of "Next" before it's reached
      if (!learned.current) { learned.current = true; partsOf(f).then((ns) => { if (ref.current) ns.forEach((n, j) => onPages?.(f.id, count, j, n)); }).catch(() => {}); }
    }).catch(() => { if (!gone) setState('failed'); });
    return () => { gone = true; };
  }, [f?.id, page, part, box.w, box.h]);
  return html`<div class="bs-page">
    <div class="bs-page__sheet" ref=${ref}></div>
    ${state === 'opening' ? html`<p class="bs-quiet bs-page__wait">Opening ${docTitle(f?.name)}…</p>` : state === 'failed' ? html`<p class="bs-quiet">${docTitle(f?.name)} didn’t open here. It’s on the board page.</p>` : null}
  </div>`;
}

/**
 * The space a page can fill, kept up to date as the window changes size. A callback ref, so it starts measuring
 * when the stage first appears (after "Opening the screen…"), not only on the first render.
 */
function useBox() {
  const [el, setEl] = useState(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useEffect(() => {
    if (!el) return undefined;
    // Inside its padding (a phone's gutters): a page fitted to the width otherwise runs off the right edge
    const measure = () => setBox((b) => {
      const cs = getComputedStyle(el);
      const w = Math.floor(el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight));
      const h = Math.floor(el.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom));
      return b.w === w && b.h === h ? b : { w, h };
    });
    measure();
    if (!('ResizeObserver' in window)) return undefined;
    let t = 0;
    const ro = new ResizeObserver(() => { clearTimeout(t); t = setTimeout(measure, 120); });
    ro.observe(el);
    return () => { ro.disconnect(); clearTimeout(t); };
  }, [el]);
  return [setEl, box];
}

/** Largest and smallest a point's words go on a card, against the report's own size */
const POINT_FIT_MAX = 1.2;
const POINT_FIT_MIN = 0.85;
/**
 * A short report that is only its points (board-md.js mdPoints): each point a card of its own, two or three across,
 * the words as large as the slide holds them, each figure in yellow, the cards coming up one after another. Where the
 * cards can't fit at a size the room still reads (a short window, a motion and notes under them), it's drawn whole
 * instead (ReportFit), and tried as cards again once there's more room.
 */
function ReportPoints({ text }) {
  const p = mdPoints(text);
  const ref = useRef(null);
  // The stage's size when the cards didn't fit in it, else null
  const [whole, setWhole] = useState(null);
  useEffect(() => setWhole(null), [text]);
  useEffect(() => {
    const el = ref.current;
    if (!el || whole) return undefined;
    // A phone scrolls the slide: the words keep their size there
    const phone = () => window.matchMedia('(max-width: 900px)').matches;
    // By the cards' layout, not where they're drawn: they come up from 14px lower, which would read as too tall
    const over = () => {
      const list = el.querySelector('.bs-pts__list');
      return !!list && (list.offsetTop + list.offsetHeight > el.clientHeight + 1 || [...el.querySelectorAll('.bs-pt__t')].some((t) => t.scrollWidth > t.clientWidth + 1));
    };
    const fit = () => {
      let s = phone() ? 1 : POINT_FIT_MAX;
      el.style.setProperty('--fit', String(s));
      while (!phone() && s > POINT_FIT_MIN && over()) { s = Math.round((s - 0.05) * 100) / 100; el.style.setProperty('--fit', String(s)); }
      if (!phone() && over()) {
        const st = el.closest('.bs-stage');
        setWhole({ w: st?.clientWidth || 0, h: st?.clientHeight || 0 });
        return;
      }
      // The report page's preview says it fits, as ReportFit says for a report drawn whole
      if (PREVIEW) {
        const words = mdWords(text);
        window.parent?.postMessage({ type: 'board-preview-fit', cut: false, shown: words, total: words }, location.origin);
      }
    };
    fit();
    // Again when its box changes (the window, the rail) and once the fonts are in; never on its own size (no loop)
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => fit()) : null;
    ro?.observe(el.parentElement);
    document.fonts?.ready.then(fit);
    return () => ro?.disconnect();
  }, [text, whole]);
  // Drawn whole: as cards again once the stage is bigger than it was
  useEffect(() => {
    if (!whole) return undefined;
    const st = document.querySelector('.bs-stage');
    if (!st || typeof ResizeObserver !== 'function') return undefined;
    const ro = new ResizeObserver(() => { if (st.clientWidth > whole.w + 8 || st.clientHeight > whole.h + 8) setWhole(null); });
    ro.observe(st);
    return () => ro.disconnect();
  }, [whole]);
  if (!p) return null;
  if (whole) return html`<${ReportFit} text=${text} cols=${mdWords(text) > 110 ? 2 : 1} />`;
  const n = p.points.length;
  const runs = (t) => mdFigures(t).map((r, k) => {
    if (r.br) return html`<br key=${k} />`;
    // A link breaks anywhere it must; a short hyphenated word (W-9, 20-second) stays on one line
    let out = r.fig || r.href ? r.text : r.text.split(/([\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)+)/u).map((w, j) => (j % 2 && w.length <= 20 ? html`<span class="bs-pt__w">${w}</span>` : w));
    if (r.fig) out = html`<b class="bs-pt__fig">${out}</b>`;
    if (r.i) out = html`<em>${out}</em>`;
    if (r.b) out = html`<strong>${out}</strong>`;
    if (r.href) out = html`<span class="bs-pt__a">${out}</span>`;
    return out;
  });
  return html`<div class=${`bs-pts is-${n}`} ref=${ref}>
    ${p.lead ? html`<p class="bs-pts__lead" dir="auto">${runs(p.lead)}</p>` : null}
    <ol class="bs-pts__list" start=${p.start}>${p.points.map((t, k) => html`<li class="bs-pt" key=${k} style=${`--i:${k}`}>
      <span class=${`bs-pt__n ${p.numbered ? '' : 'is-mark'}`} aria-hidden="true">${p.numbered ? p.start + k : ''}</span>
      <p class="bs-pt__t" dir="auto">${runs(t)}</p>
    </li>`)}</ol>
  </div>`;
}

/**
 * A report on the screen: as large as the room reads it best, smaller only as far as it must be to fit its box (in two
 * columns when it's long); what still doesn't fit at the smallest size is on the board page, and it says so
 */
function ReportFit({ text, cols = 1 }) {
  const ref = useRef(null);
  const [cut, setCut] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const over = () => el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1;
    const fit = () => {
      const blocks = [...(el.querySelector('.rp')?.children || [])];
      blocks.forEach((b) => { b.hidden = false; });
      let s = 1;
      el.style.setProperty('--fit', '1');
      // Smaller only to where a room still reads it (80%)
      while (s > 0.8 && over()) { s = Math.round((s - 0.05) * 100) / 100; el.style.setProperty('--fit', String(s)); }
      // Then whole blocks off the end, never a line cut in half; the note says where the rest is. How many fit, found
      // in a few layouts (halving), never one per block: a long report doesn't hold up typing beside it
      let hid = 0;
      if (blocks.length > 1 && over()) {
        const show = (k) => blocks.forEach((b, i) => { b.hidden = i >= k; });
        let lo = 1;
        let hi = blocks.length - 1;
        let best = 1;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          show(mid);
          if (over()) hi = mid - 1; else { best = mid; lo = mid + 1; }
        }
        show(best);
        hid = blocks.length - best;
      }
      setCut(hid > 0 || over());
      // The report page's preview says whether it fits, and about how much the room sees
      if (PREVIEW) {
        const count = (list) => list.reduce((n, b) => n + (b.textContent.trim().split(/\s+/).filter(Boolean).length), 0);
        window.parent?.postMessage({ type: 'board-preview-fit', cut: hid > 0 || over(), shown: count(blocks.filter((b) => !b.hidden)), total: count(blocks) }, location.origin);
      }
    };
    fit();
    // Again when its box changes (the window, the rail) and once the fonts are in; never on its own size (no loop)
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => fit()) : null;
    ro?.observe(el.parentElement);
    document.fonts?.ready.then(fit);
    return () => ro?.disconnect();
  }, [text, cols]);
  return html`<div class=${`bs-report ${cols > 1 ? 'is-cols' : ''}`}>
    <div class="bs-report__body" ref=${ref}><${Report} text=${text} level=${3} /></div>
    ${cut ? html`<p class="bs-report__more">The whole report is on the board page</p>` : null}
  </div>`;
}

/** A report on its own slide (a 'report' stop): as large as it fits, in two columns when it's long */
const ReportBody = ({ report }) => html`<${ReportFit} text=${report} cols=${mdWords(report) > 110 ? 2 : 1} />`;

function Points({ text }) {
  const blocks = noteBlocks(text);
  if (!blocks.length) return null;
  const list = (nodes) => html`<ul>${nodes.map((n) => html`<li>${n.text}${n.children.length ? list(n.children) : null}</li>`)}</ul>`;
  const out = [];
  let run = [];
  for (const b of blocks) {
    if (b.para) { if (run.length) { out.push(list(run)); run = []; } out.push(html`<p>${b.text}</p>`); } else run.push(b);
  }
  if (run.length) out.push(list(run));
  return html`<div class="bs-points">${out}</div>`;
}

// ─── Live facts at the size of a room ───────────────────────────────
const dayWords = (d) => (isDate(d) ? new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' }) : '');
const monDay = (d) => { const t = new Date(`${d}T12:00:00Z`); return { mon: t.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' }), day: t.getUTCDate() }; };
const windowStart = (w) => (/^\d{4}-\d{2}$/.test(String(w?.month || '')) ? `${w.month}-${{ early: '01', mid: '11', late: '21' }[w.part] || '01'}` : '');
function Tile({ d, word = '' }) {
  if (!isDate(d)) return html`<span class="bs-tile is-soft" aria-hidden="true"><span>·</span><strong>${word || '?'}</strong></span>`;
  const p = monDay(d);
  return html`<span class=${`bs-tile ${word ? 'is-soft' : ''}`} aria-hidden="true"><span>${p.mon}</span><strong>${word || p.day}</strong></span>`;
}
/**
 * The money as figures: the cash, the year against its budget (./money.js moneyTiles), the first on yellow; under
 * them, where the year's revenue came from (the meeting's own numbers for one already held)
 */
function CashSlide({ n, data, date, as = 'pct' }) {
  const upTo = date && date < todayEastern() ? date : '';
  const tiles = moneyTiles({ cash: useCashNow(data, upTo, n), budget: useBudget(data, upTo, n), n, due: budgetDue(data, upTo), as });
  const books = upTo ? n?.books : data.numbers.books;
  if (!tiles.length) return null;
  const mix = mixOf(books) ? html`<div class="bs-mix"><p class="bs-figs__label">Where ${books.year}’s revenue came from</p><${RevenueMix} books=${books} /></div>` : null;
  return html`<div class="bs-money"><ul class="bs-figs" style=${`--n:${tiles.length}`}>${tiles.map((t) => html`<li key=${t.k}><span class="bs-figs__label">${t.label}</span><span class="bs-figs__value">${t.value}</span>${t.pct != null ? html`<span class="bs-figs__bar" role="img" aria-label=${`${t.pct}% of the budget`}><i style=${`--p:${Math.min(100, t.pct)}%`}></i></span>` : null}${t.sub ? html`<span class="bs-figs__sub">${t.sub}</span>` : null}</li>`)}</ul>${mix}</div>`;
}
/** Reveals ahead: each kid's photo and the day */
/**
 * The reveals coming up, along a line in the order they come: each set day (its date and time) and each part of a
 * month not set yet over the families due then, photo first. Fits the screen however many there are (the first ten)
 */
function RevealsSlide({ n }) {
  const set = (r) => !!(r.confirmed && r.date);
  const all = [...(n?.reveals || [])].map((r) => ({ ...r, at: set(r) ? r.date : windowStart(r.window) || '9999' })).sort((a, b) => a.at.localeCompare(b.at));
  if (!all.length) return html`<p class="bs-quiet bs-pipe__none">No reveals on the calendar yet.</p>`;
  // As many as fit across the screen at a readable size (about 135px a stop), the rest counted after them
  const room = Math.max(4, Math.floor(((typeof innerWidth === 'number' ? innerWidth : 1600) * 0.8) / 135));
  let list = all.slice(0, 10);
  const stopsOf = (l) => new Set(l.map((r) => (set(r) ? `d:${r.date}` : `w:${r.window?.month || ''}:${r.window?.part || ''}`))).size;
  while (list.length > 1 && stopsOf(list) > room - (list.length < all.length ? 1 : 0)) list = list.slice(0, -1);
  const more = all.length - list.length;
  const photoOf = (r) => r.photo || [...(n.projects?.building || []), ...(n.projects?.waiting || [])].find((b) => b.slug && b.slug === r.slug)?.photo || '';
  // A set day is its own stop on the line; the families not set yet share their part of the month
  const stops = [];
  for (const r of list) {
    const key = set(r) ? `d:${r.date}` : `w:${r.window?.month || ''}:${r.window?.part || ''}:${r.window?.label || ''}`;
    let g = stops.find((x) => x.key === key);
    if (!g) stops.push(g = { key, set: set(r), first: r, list: [] });
    g.list.push(r);
  }
  // Two rows only when they save real room (days with several families); one family a stop stays one row
  const wide1 = list.length;
  const wide2 = stops.reduce((t, g) => t + Math.ceil(g.list.length / 2), 0);
  const rows = wide1 > 7 && wide2 <= wide1 * 0.75 ? 2 : 1;
  const across = (g) => Math.max(1, Math.ceil(g.list.length / rows));
  const units = stops.reduce((t, g) => t + across(g), 0) + (more ? 1 : 0);
  // One way of saying the months along the whole line: in full when there's room, short when it's busy
  const full = stops.length <= 3 && !more && stops.every((g) => across(g) >= 2);
  const month = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  const weekday = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { weekday: full ? 'long' : 'short', timeZone: 'UTC' });
  const sameTime = (g) => g.list.every((x) => x.time === g.first.time);
  const head = (g) => {
    const r = g.first;
    if (g.set) return html`<strong>${month(r.date)}</strong><span>${[weekday(r.date), sameTime(g) && r.time ? clock(r.time) : ''].filter(Boolean).join(', ')}</span>`;
    const w = r.window || {};
    if (!w.label) return html`<strong>Date to come</strong>`;
    const short = /^\d{4}-\d{2}$/.test(String(w.month || '')) && w.part ? `${w.part} ${new Date(`${w.month}-15T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' })}` : w.label;
    const words = full ? w.label : short;
    return html`<strong>${words.charAt(0).toUpperCase()}${words.slice(1)}</strong><span>Date to be set</span>`;
  };
  const tmpl = [...stops.map((g) => `minmax(0, ${across(g)}fr)`), ...(more ? ['minmax(0, 1fr)'] : [])].join(' ');
  return html`<div class="bs-when" data-rows=${rows} data-busy=${units > 4 ? (units > 6 ? 'more' : 'yes') : null} style=${`--tmpl:${tmpl};--rows:${rows};--units:${units}`}>
    <ol class="bs-when__line">${stops.map((g) => html`<li class=${g.set ? 'is-set' : ''} key=${g.key}>${head(g)}</li>`)}${more ? html`<li class="is-more"><strong>+${more} more</strong><span>after these</span></li>` : null}</ol>
    <div class="bs-when__kids">${stops.map((g) => html`<div class=${`bs-when__stop ${g.set ? 'is-set' : ''}`} key=${g.key}><p class="bs-when__stophead">${head(g)}</p><ul style=${`--across:${across(g)}`}>${g.list.map((r) => {
      const photo = photoOf(r);
      // A time of its own (two families the same day at different times) on the photo's corner
      const time = g.set && r.time && !sameTime(g) ? html`<span class="bs-when__time">${clock(r.time)}</span>` : null;
      return html`<li key=${r.slug || r.name}>
        <span class="bs-when__photo">${photo ? html`<img src=${sized(photo, `${rows === 1 ? 'w=640,h=760' : 'w=640,h=520'},fit=cover,gravity=face`)} alt="" decoding="async" />` : html`<span class="bs-when__initials" aria-hidden="true">${initialsOf(r.name)}</span>`}${time}</span>
        <span class="bs-when__name">${r.name}</span>
      </li>`;
    })}</ul></div>`)}</div>
  </div>`;
}
const DATE_STATES = { done: 'Held', today: 'Today', next: 'Next' };
function DatesSlide({ rows, note = '' }) {
  if (!rows.length) return html`<p class="bs-quiet">Nothing on the calendar yet.</p>`;
  return html`${note ? html`<p class="bs-quiet bs-dates__note">${note}</p>` : null}<ul class="bs-dates">${rows.map((r) => html`<li class=${r.state ? `is-${r.state}` : ''} key=${r.key}><${Tile} d=${r.date} /><span class="bs-dates__text"><strong>${r.title}</strong>${r.sub ? html`<span>${r.sub}</span>` : null}</span>${r.state ? html`<b class="bs-dates__state">${r.state === 'done' ? CHECK : null}${DATE_STATES[r.state]}</b>` : null}</li>`)}</ul>`;
}
/** Under a board member's name: their officer's seat, else their company (People keeps "Company, Role") */
const roleOf = (p) => (p.title && !/^board member$/i.test(p.title) ? p.title : String(p.organization || '').split(/,\s*/)[0] || p.title || '');
/** A face at the size of a room: the People photo asked for big enough to stay sharp on a TV */
const roomPhoto = (url) => String(url || '').replace(/\bw=\d+,h=\d+/, 'w=480,h=480');

/**
 * The board's faces (facesOf): for the roll call everyone on the meeting's list, each lighting up as they check in
 * on the board page, the ones not here yet dimmed; for a go-around (introductions, each one's news) the ones here.
 * Before the meeting starts (a rehearsal, a preview) everyone as they are. New this year: a mark on the photo, so
 * the line under the name keeps its width for the company.
 */
function FacesGrid({ kind, v, people, started, year }) {
  const bySlug = new Map(people.map((p) => [p.slug, p]));
  const listed = (v.roll || []).map((r) => ({ ...(bySlug.get(r.slug) || {}), slug: r.slug, name: r.name || bySlug.get(r.slug)?.name || '', how: r.how }));
  const all = listed.length ? listed : people.filter((p) => p.group === 'board').map((p) => ({ ...p, how: '' }));
  const here = all.filter((p) => p.how);
  const shown = kind === 'room' && started && here.length ? here : all;
  if (!shown.length) return html`<p class="bs-quiet">No board members on the meeting’s list.</p>`;
  const rows = shown.length <= 5 ? 1 : shown.length <= 14 ? 2 : shown.length <= 24 ? 3 : 4;
  return html`<ul class="bs-faces" style=${`--cols:${Math.ceil(shown.length / rows)};--rows:${rows}`}>${shown.map((p) => {
    const state = !started ? '' : p.how === 'remote' ? 'is-remote' : p.how ? 'is-here' : 'is-away';
    const sub = started && p.how ? (p.how === 'remote' ? 'On video' : 'In the room') : roleOf(p);
    return html`<li class=${`bs-faces__one ${state}`} key=${p.slug || p.name}>
      <span class="bs-faces__pic">
        ${p.photo ? html`<img src=${roomPhoto(p.photo)} alt="" />` : html`<span class="bs-faces__initials" style=${`--hue:${hueOf(p.name)}`}>${initialsOf(p.name)}</span>`}
        ${state === 'is-here' || state === 'is-remote' ? html`<span class="bs-faces__mark" aria-hidden="true">${CHECK}</span>` : null}
        ${typeof p.since === 'number' && p.since >= year ? html`<b class="bs-faces__new">New</b>` : null}
      </span>
      <strong class="bs-faces__name">${p.name}</strong>
      <span class="bs-faces__sub">${sub}</span>
    </li>`;
  })}</ul>`;
}
const CHECK = html`<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4.5 10.5l3.6 3.6 7.4-8.2" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" /></svg>`;
/** The roll call's count, beside its title: here of the list, and the quorum (met, or how many more) */
function RollCount({ v, started }) {
  const roll = v.roll || [];
  const n = roll.filter((p) => p.how).length;
  const q = v.here?.quorum || 0;
  // Presented (it moves itself): the faces and the count; the minutes say who was there
  if (!started || OWN) return html`<div class="bs-roll"><span class="bs-roll__n">${roll.length}<small> on the board</small></span>${OWN ? null : html`<span class="bs-quiet">Each one checks in with a tap on the board page</span>`}</div>`;
  return html`<div class="bs-roll">
    <span class="bs-roll__n">${n}<small> of ${roll.length} here</small></span>
    ${q ? html`<span class=${`bs-roll__q ${v.here.met ? 'is-met' : ''}`}>${v.here.met ? `Quorum met · ${q} needed` : `Quorum is ${q} · ${q - Math.min(q, v.here.board)} more needed`}</span>` : null}
  </div>`;
}
/** A part with more than one item, beside an item that has nothing else to show: where it sits in the part */
function PartList({ sec, items, current, people }) {
  const at = sec.items.findIndex((x) => x.id === current.id);
  return html`<ol class="bs-part">${sec.items.map((it, i) => {
    const ws = presentersOf(it, people);
    return html`<li key=${it.id} class=${i < at ? 'is-done' : i === at ? 'is-now' : ''}>
      <span class="bs-part__label">${i < at ? CHECK : items.find((x) => x.id === it.id)?.label}</span>
      <span class="bs-part__t">${it.title}</span>
      ${ws.length ? html`<span class="bs-part__who">${ws.map((p) => p.name.split(' ')[0]).join(' & ')}</span>` : null}
    </li>`;
  })}</ol>`;
}

/** A part's card: its number, its time, its title and its items. When one person (or the same pair) presents every item,
 *  they're said once under the title, not on each row. A part too long for the screen is set smaller, the big number
 *  and the title first, until it all fits above the rail; a phone scrolls it instead */
function Chapter({ n, sec, t, items, people }) {
  const ref = useRef(null);
  const rows = sec?.items || [];
  const whos = rows.map((it) => presentersOf(it, people));
  const keyOf = (ws) => ws.map((p) => p.slug || p.name).join('|');
  const one = rows.length > 1 && whos[0].length && whos.every((ws) => keyOf(ws) === keyOf(whos[0])) ? whos[0] : null;
  const labels = rows.map((it) => items.find((x) => x.id === it.id)?.label || '');
  useEffect(() => {
    const el = ref.current;
    const stage = el?.closest('.bs-stage');
    if (!el || !stage) return undefined;
    const fit = () => {
      el.style.setProperty('--fit', '1');
      const cs = getComputedStyle(stage);
      if (cs.overflowY === 'auto') return;
      const room = stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
      let f = 1;
      while (f > 0.6 && el.offsetHeight > room) { f = Math.round((f - 0.05) * 100) / 100; el.style.setProperty('--fit', String(f)); }
    };
    fit();
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => fit()) : null;
    ro?.observe(stage);
    document.fonts?.ready.then(fit);
    return () => ro?.disconnect();
  }, [JSON.stringify([sec?.title, rows.map((it) => it.title), whos.map(keyOf)])]);
  return html`<div class=${`bs-chapter ${labels.some((l) => l.length > 3) ? 'is-wide' : ''}`} ref=${ref}>
    <span class="bs-chapter__n" aria-hidden="true">${String(n).padStart(2, '0')}</span>
    <div class="bs-chapter__body">
      <p class="bs-eyebrow">${t ? [t.start ? `${clock(t.start)} to ${clock(t.end)}` : '', `${t.minutes} minutes`].filter(Boolean).join(' · ') : 'Agenda'}</p>
      <h1 class="bs-display bs-chapter__title">${sec?.title || 'Agenda'}</h1>
      ${one ? html`<p class="bs-chapter__by">${one.map((p) => html`<${Face} p=${p} size=${44} key=${p.slug || p.name} />`)}<span>${namesText(one.map((p) => p.name))}</span></p>` : null}
      ${rows.length ? html`<ol class="bs-chapter__items">${rows.map((it, i) => html`<li key=${it.id}><span class="bs-chapter__label">${labels[i]}</span><span class="bs-chapter__t">${it.title}</span>${!one && whos[i].length ? html`<span class="bs-chapter__who">${whos[i].map((p) => html`<${Face} p=${p} size=${36} key=${p.slug || p.name} />`)}<span>${whos[i].map((p) => p.name).join(' & ')}</span></span>` : null}</li>`)}</ol>`
        : html`<p class="bs-chapter__open">Open to the floor</p>`}
    </div>
  </div>`;
}

/** What an item's presenter asks the board to vote on (item.motion), the way the minutes' motion shows */
function ItemMotion({ text }) {
  const t = String(text || '').trim();
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!PREVIEW || !el) return undefined;
    const tell = () => window.parent?.postMessage({ type: 'board-preview-motion', cut: el.scrollHeight > el.clientHeight + 1 }, location.origin);
    tell();
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(tell) : null;
    ro?.observe(el);
    document.fonts?.ready.then(tell);
    return () => ro?.disconnect();
  }, [t]);
  if (!t) return null;
  // Four lines at most on the slide, a long one in smaller type: it never pushes the report off the screen
  return html`<div class=${`bs-motion bs-motion--item ${t.length > 90 ? 'is-long' : ''}`}><p class="bs-eyebrow">The board votes on</p><p class="bs-motion__text" ref=${ref}>${t}</p></div>`;
}

/** The motion to approve the last meeting's minutes: the meeting's own (the chair's words) else the usual one */
function MinutesMotion({ item, v }) {
  const prev = (v.prior || []).find((x) => x.id === item.about) || null;
  const mo = (v.motions || []).find((x) => /\bminutes\b/i.test(x.text)) || null;
  const text = mo?.text || `Approve the minutes of the ${prev ? `${prev.name}, ${shortDate(prev.date)},` : 'last meeting'} as written`;
  const said = { passed: 'Passed', failed: 'Did not pass', tabled: 'Tabled' }[mo?.result] || 'Recorded';
  return html`<div class="bs-motion">
    <p class="bs-eyebrow">The motion</p>
    <p class="bs-motion__text">${text}</p>
    ${mo?.tally ? html`<p class=${`bs-motion__result is-${mo.result}`}>${said} ${mo.tally.for}–${mo.tally.against}${mo.tally.abstain ? `, ${mo.tally.abstain} abstaining` : ''}</p>`
      : mo?.by ? html`<p class="bs-quiet">Moved by ${mo.by}${mo.second ? `, seconded by ${mo.second}` : ''}</p>` : null}
  </div>`;
}

/** An item's live facts on the screen, or null when it has none */
function liveSlide(kind, n, id, data, date, as = 'pct') {
  if (!n || !kind || kind === 'minutes') return null;
  // (JobTread not answering: the pipeline says so, never a slide with nothing on it)
  if (kind === 'projects') return html`<${Pipeline} projects=${n.projects} reveals=${n.reveals || []} />`;
  if (kind === 'cash') return html`<${CashSlide} n=${n} data=${data} date=${date} as=${as} />`;
  if (kind === 'reveals') return html`<${RevealsSlide} n=${n} />`;
  if (kind === 'events') {
    // Nothing ahead: the ones held lately, so the slide still says what's happened
    const ahead = (n.events || []).slice(0, 5);
    const held = ahead.length ? [] : (n.recentEvents || []).slice(0, 4);
    return html`<${DatesSlide} note=${!ahead.length && held.length ? 'Nothing on the calendar yet. Lately:' : ''} rows=${[...ahead, ...held].map((e) => ({ key: e.title + e.date, date: e.date, title: e.title, sub: [held.includes(e) ? '' : dayWords(e.date), e.time, e.location].filter(Boolean).join('  ·  '), state: held.includes(e) ? 'done' : '' }))} />`;
  }
  if (kind === 'meetings') {
    // The year's meetings: the ones held checked off, this one and the next marked (or only what's ahead, from before)
    const day = date || todayEastern();
    const list = (n.thisYear?.length ? n.thisYear : (n.meetings || []).filter((x) => x.id !== id)).slice(0, 6);
    const next = list.find((x) => x.date > day && x.id !== id);
    return html`<${DatesSlide} rows=${list.map((x) => ({ key: x.id || x.date, date: x.date, title: x.name, sub: [x.date > day ? dayWords(x.date) : '', x.start ? clock(x.start) : ''].filter(Boolean).join('  ·  '), state: x.id === id || x.date === day ? 'today' : x.date < day ? 'done' : x === next ? 'next' : '' }))} />`;
  }
  const lines = liveLines(kind, n, { meetingId: id });
  return lines.length ? html`<div class="bs-numbers"><ul>${lines.map((l) => html`<li>${l}</li>`)}</ul></div>` : null;
}

/**
 * "Since we last met": the kids revealed since the last meeting (their photos and days), the events held, and the
 * action items still open. A quiet line when it's been a quiet stretch
 */
function SinceSlide({ v, n, meeting }) {
  const prev = (v.prior || []).find((x) => x.date) || null;
  const from = prev?.date || '';
  const inRange = (d) => isDate(d) && (!from || d > from) && d <= meeting.date;
  const reveals = (n?.pastReveals || []).filter((r) => inRange(r.date)).sort((a, b) => a.date.localeCompare(b.date));
  const events = (n?.recentEvents || []).filter((e) => inRange(e.date)).slice(0, 4);
  const open = (v.actions || []).filter((a) => !a.done).slice(0, 4);
  const shown = reveals.slice(0, reveals.length > 4 ? 6 : 4);
  return html`<div class="bs-since">
    <div class="bs-since__head">
      <p class="bs-eyebrow">${prev ? `Since the ${prev.name}, ${shortDate(prev.date)}` : 'Since we last met'}</p>
      <h1 class="bs-display">Since we last met</h1>
    </div>
    ${shown.length ? html`<div class="bs-since__reveals" style=${`--n:${Math.min(shown.length, 6)}`}>
      <p class="bs-since__count"><strong>${reveals.length}</strong> ${reveals.length === 1 ? 'reveal' : 'reveals'}</p>
      <ul>${shown.map((r) => html`<li key=${r.slug || r.name}>
        <span class="bs-since__photo">${r.photo ? html`<img src=${sized(r.photo, 'w=600,h=600,fit=cover,gravity=face')} alt="" />` : html`<${Face} p=${{ name: r.name }} size=${120} />`}</span>
        <strong>${r.name}</strong><span>${shortDate(r.date).replace(/, \d{4}$/, '')}</span>
      </li>`)}</ul>
    </div>` : null}
    ${events.length || open.length ? html`<div class="bs-since__side">
      ${events.length ? html`<div><p class="bs-eyebrow">Events held</p><ul class="bs-since__list">${events.map((e) => html`<li key=${e.title + e.date}><b>${shortDate(e.date).replace(/, \d{4}$/, '')}</b>${e.title}</li>`)}</ul></div>` : null}
      ${open.length ? html`<div><p class="bs-eyebrow">Action items still open</p><ul class="bs-since__list">${open.map((a) => html`<li key=${a.id}><b>${a.ownerName || 'Open'}</b>${a.text}</li>`)}</ul></div>` : null}
    </div>` : null}
    ${!shown.length && !events.length && !open.length ? html`<p class="bs-quiet">${prev ? `The ${prev.name}’s minutes are up for approval next.` : 'The agenda is next.'}</p>` : null}
  </div>`;
}

/**
 * Along the bottom, where the meeting is: each part of the agenda as a length of rail (as long as it has items),
 * the ones done filled, the one on now filling item by item, and what comes next
 */
function Rail({ meeting, items, at, deck, ended, prior = [], timer = null }) {
  const stop = deck[at];
  // Where the meeting is, as the index of the item on now (a part's card counts as its first item, not yet begun)
  const cardAt = stop?.kind === 'section' ? meeting.sections.findIndex((x) => x.id === stop.sectionId) : -1;
  const n = ended ? items.length : stop?.n >= 0 ? stop.n : stop?.kind === 'cover' || stop?.kind === 'since' ? -1 : cardAt >= 0 ? (items.findIndex((it) => it.si >= cardAt) + 1 || items.length + 1) - 1 : items.length;
  const sections = meeting.sections.map((s, si) => ({ s, si, items: items.filter((it) => it.si === si) })).filter((x) => x.s.title || x.items.length);
  // What the next press shows: the next page, the next document, the next item, or the close
  const next = deck[at + 1];
  const files = meeting.files.concat(prior.flatMap((x) => x.files || []));
  const nextWords = !next || ended ? null
    : next.kind === 'end' ? html`<span>Next: the close</span>`
    : next.kind === 'section' ? html`<span>Next <b>${String(meeting.sections.findIndex((x) => x.id === next.sectionId) + 1).padStart(2, '0')}</b> ${meeting.sections.find((x) => x.id === next.sectionId)?.title || ''}</span>`
    : next.kind === 'books' ? html`<span>Next: ${BOOKS_TITLES[next.fileId.slice(6)]}</span>`
    : next.kind === 'live' ? html`<span>Next: ${LIVE_TITLES[next.fileId.slice(5)]}</span>`
    : next.kind === 'report' ? html`<span>Next: Report</span>`
    : next.kind === 'doc' && next.fileId === stop?.fileId && next.page === stop.page ? html`<span>Next: the rest of the page</span>`
    : next.kind === 'doc' && next.fileId === stop?.fileId ? html`<span>Next: ${docKind(files.find((f) => f.id === next.fileId) || {}) === 'slides' ? 'slide' : 'page'} ${next.page + 1}</span>`
    : next.kind === 'doc' ? html`<span>Next: ${docTitle(files.find((f) => f.id === next.fileId)?.name || 'the document')}</span>`
    : next.n >= 0 ? html`<span>Next <b>${items[next.n].label}</b> ${items[next.n].title}</span>` : html`<span>Next: ${MORE.title.toLowerCase()}</span>`;
  return html`<footer class="bs-rail" aria-label="Where the meeting is">
    <ol class="bs-rail__parts">${sections.map(({ s, si, items: its }) => {
      const on = cardAt >= 0 ? si === cardAt : its.some((it) => items.indexOf(it) === n);
      // A part with no items (new business, open forum) is passed once anything after it has come up
      const fill = cardAt === si ? 0.04 : its.length ? (its.filter((it) => items.indexOf(it) < n).length + (on ? 0.5 : 0)) / its.length : ended || cardAt > si || items.some((it) => it.si > si && items.indexOf(it) <= n) ? 1 : 0;
      return html`<li key=${s.id} class=${on ? 'is-on' : fill >= 1 ? 'is-done' : ''} style=${`--w:${Math.max(1, its.length)};--fill:${Math.min(1, fill)}`}>
        <span class="bs-rail__bar" aria-hidden="true"><i></i></span>
        <span class="bs-rail__label" title=${s.title || 'Agenda'}><b>${String(si + 1).padStart(2, '0')}</b>${s.title || 'Agenda'}${on && timer ? html`<i class=${`bs-rail__time ${timer.over ? 'is-over' : ''}`}>${clockText(timer.left)}${timer.over ? ' over' : ' left'}</i>` : null}</span>
      </li>`;
    })}</ol>
    <p class="bs-rail__next">${nextWords}</p>
  </footer>`;
}

/** Where a presenting window was, kept for the session so a reload comes back to the same slide */
const keptAt = (id) => { try { return sessionStorage.getItem(`bs-at:${id}`) || ''; } catch { return ''; } };
const PREV = html`<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><path d="M12.5 4.5L7 10l5.5 5.5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" /></svg>`;
const NEXT = html`<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><path d="M7.5 4.5L13 10l-5.5 5.5" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" /></svg>`;

/** The screen: the stop the chair is on, or (presenting, Board's preview) the one it has moved itself to */
export function Screen({ id, data, d, onBack = null }) {
  const fast = useRef(false);
  const [v0, fail, trouble] = useLiveView(id, fast, SOLO);
  // Presenting and Board's preview never show the meeting as it was held (an ended practice) or a vote: nothing
  // started, nothing ended; they go only where they're moved
  // The report page's preview of a meeting ahead its presenter writes on, not shared yet (no live view for them): the
  // meeting as the page has it
  const pv = PREVIEW && (SOLO || fail) && !v0 ? data.meetings.find((x) => x.id === id) || data.previews?.find((x) => x.id === id) || data.presenting?.find((x) => x.id === id) || null : null;
  // (made once an answer, not every render: what's built from it, the meeting and its deck, holds still between answers)
  const v = useMemo(() => {
    const vb = v0 || (pv ? { ok: true, title: pv.title || '', date: pv.date, start: pv.start || '', end: pv.end || '', sections: pv.sections, files: pv.files || [], snapshot: pv.snapshot || null, prior: [], live: {} } : null);
    return OWN && vb ? { ...vb, vote: null, live: { ...vb.live, startedAt: '', endedAt: '', itemId: '', fileId: '', page: 0, part: 0, screen: '', sectionId: '', sectionAt: '', vote: null, floor: '' } } : vb;
  }, [v0, pv]);
  const [told, setTold] = useState(null); // { live, rehearsal, at } from the chair's computer
  // Moving itself: the stop it's on (its key), and its item (that item's card, if the key is gone from a changed deck)
  const [here, setHere] = useState(() => ({ key: PRESENT ? AT || keptAt(id) : '', itemId: '' }));
  const [blank, setBlank] = useState(false);
  const [pages, setPages] = useState({});
  const [halves, setHalves] = useState({}); // { fileId: [halves of each page] }: the chair's, and the pages drawn here
  const [awake, setAwake] = useState(true);
  // The money's changes as percentages or in dollars (C, or the % | $ beside the slide count): kept on this device, and
  // the same on the board page and on paper (./money.js readChangeAs), so a pick in one window reaches the others
  const [chg, setChgNow] = useState(readChangeAs);
  const setChg = (as) => { keepChangeAs(as); setChgNow(as); };
  useEffect(() => {
    const on = (e) => { if (e.key === 'bd-change-as') setChgNow(readChangeAs()); };
    addEventListener('storage', on);
    return () => removeEventListener('storage', on);
  }, []);
  const [, setTick] = useState(0);
  const ch = useRef(null);
  const deckRef = useRef([]);
  const atRef = useRef(0);
  // Presenting on the day: when each part first came up, for its timer (going back to a part keeps its clock)
  const partsAt = useRef(new Map());
  const [stageRef, box] = useBox();
  const go = (i) => {
    const deck = deckRef.current;
    if (!deck.length) return;
    const s = deck[Math.max(0, Math.min(deck.length - 1, i))];
    setBlank(false);
    setHere({ key: s.key, itemId: s.itemId || '' });
  };

  // Board's preview: to the item being worked on, a slide picked beside it, or a step either way
  useEffect(() => {
    if (!PREVIEW) return undefined;
    const to = (e) => setHere({ key: '', itemId: e.detail });
    const msg = (e) => {
      if (e.origin !== location.origin || e.source !== window.parent) return;
      const x = e.data || {};
      if (x.type === 'board-preview-stop') { const s = deckRef.current.find((y) => y.key === x.key); if (s) setHere({ key: s.key, itemId: s.itemId || '' }); }
      if (x.type === 'board-preview-step') go(atRef.current + (x.dir < 0 ? -1 : 1));
      // The report page's preview: the stop its words are on (an item that shows live facts has its report after them)
      if (x.type === 'board-preview-at' && x.itemId) setHere({ key: String(x.key || ''), itemId: String(x.itemId) });
    };
    addEventListener('bp-preview-focus', to);
    addEventListener('message', msg);
    return () => { removeEventListener('bp-preview-focus', to); removeEventListener('message', msg); };
  }, []);

  // The chair's computer, when it's this one (never while it moves itself)
  useEffect(() => {
    if (OWN || !('BroadcastChannel' in window)) return undefined;
    const c = new BroadcastChannel(CHANNEL);
    ch.current = c;
    c.onmessage = (e) => {
      const msg = e.data || {};
      if (msg.id !== id) return;
      if (msg.type === 'ping' && !MIRROR) c.postMessage({ type: 'hello', id });
      if (msg.type === 'show') { fast.current = true; setTold({ live: msg.live || {}, rehearsal: !!msg.rehearsal, at: Date.now() }); }
      if (msg.type === 'parts' && msg.parts) setHalves((x) => ({ ...x, ...msg.parts }));
    };
    // A mirror only asks where the chair is
    if (MIRROR) { c.postMessage({ type: 'want', id }); return () => { c.close(); ch.current = null; }; }
    c.postMessage({ type: 'hello', id });
    const bye = () => c.postMessage({ type: 'bye', id });
    addEventListener('pagehide', bye);
    return () => { bye(); removeEventListener('pagehide', bye); c.close(); ch.current = null; };
  }, [id]);

  // Keys: presenting, they move this screen; otherwise they go back to the chair. F fills the screen
  useEffect(() => {
    if (MIRROR || PREVIEW) return undefined;
    const keys = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'f' || e.key === 'F') { e.preventDefault(); fullScreen(); return; }
      if (PRESENT && (e.key === 'b' || e.key === 'B' || e.key === '.')) { e.preventDefault(); setBlank((x) => !x); return; }
      if (PRESENT && ['c', 'C', '%', '$'].includes(e.key)) {
        e.preventDefault();
        setChgNow((x) => { const as = e.key === '%' ? 'pct' : e.key === '$' ? 'usd' : x === 'usd' ? 'pct' : 'usd'; keepChangeAs(as); return as; });
        return;
      }
      if (PRESENT && (e.key === 'Home' || e.key === 'End')) { e.preventDefault(); go(e.key === 'Home' ? 0 : deckRef.current.length - 1); return; }
      const dir = ['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter', 'j'].includes(e.key) ? (e.key === ' ' && e.shiftKey ? -1 : 1) : ['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace', 'k'].includes(e.key) ? -1 : 0;
      if (!dir || (!PRESENT && e.key === 'Enter') || (!PRESENT && e.key === 'Backspace')) return;
      if (e.repeat && PRESENT && e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return; // a held clicker button: one step
      e.preventDefault();
      if (PRESENT) go(atRef.current + dir); else ch.current?.postMessage({ type: 'key', id, dir });
    };
    addEventListener('keydown', keys);
    return () => removeEventListener('keydown', keys);
  }, [id]);

  // The mouse and the full-screen button rest after 2.5 seconds without a move; the clock ticks
  useEffect(() => {
    if (MIRROR) { setAwake(false); const clockTick = setInterval(() => setTick(Date.now()), 1000); return () => clearInterval(clockTick); }
    let t = setTimeout(() => setAwake(false), 2500);
    const move = () => { setAwake(true); clearTimeout(t); t = setTimeout(() => setAwake(false), 2500); };
    addEventListener('pointermove', move);
    const clockTick = setInterval(() => setTick(Date.now()), 1000);
    return () => { clearTimeout(t); clearInterval(clockTick); removeEventListener('pointermove', move); };
  }, []);

  useEffect(() => { if (!MIRROR) document.title = v ? `${v.title} · ${PRESENT ? 'Presenting' : 'On the screen'}` : 'SOARD Board · On the screen'; }, [v?.title]);

  // (A meeting not shared yet, previewed or presented by an admin, isn't in the board page's list: its name comes with the view)
  const m = data.meetings.find((x) => x.id === id) || (OWN ? data.previews?.find((x) => x.id === id) : null) || (PREVIEW ? data.presenting?.find((x) => x.id === id) : null) || null;
  const unshared = OWN && !data.meetings.some((x) => x.id === id);
  const meeting = useMemo(() => (v ? { ...(m || {}), id, title: m?.title || v.title || '', date: v.date, start: m?.start || v.start || '', end: m?.end || v.end || '', sections: PREVIEW && m ? m.sections : v.sections, files: PREVIEW && m ? m.files : v.files || [] } : null), [v, m]);
  const plan = useMemo(() => (meeting ? sectionPlan(meeting) : new Map()), [meeting]);
  // QuickBooks' slides after the money, the way the money's figures go (CashSlide, the board page): today's for a
  // meeting today or ahead, the locked ones for a past meeting
  const books = (v?.date && v.date < todayEastern() ? v.snapshot : data.numbers)?.books || null;
  const deck = useMemo(() => (meeting ? deckOf(meeting, { pages, parts: halves, meetings: v.prior || [], books }) : []), [meeting, pages, halves, books]);
  // Every document's pages and parts from the start (kept on this device, else worked out a file at a time), so the
  // deck is whole before its documents are shown: a reload or Play from here lands on its slide, and the count holds
  const docFiles = useMemo(() => {
    if (!meeting) return [];
    const ids = new Set(deckOf(meeting, { meetings: v.prior || [], books }).filter((s) => s.kind === 'doc').map((s) => s.fileId));
    const all = [...meeting.files, ...(v.prior || []).flatMap((x) => x.files || [])];
    // The one a slide asked for (Play from here, a reload) counted first
    const asked = (here.key || '').split(':')[1] || '';
    return all.filter((f, i) => ids.has(f.id) && all.findIndex((g) => g.id === f.id) === i).sort((p, q) => (q.id === asked) - (p.id === asked));
  }, [meeting, books]);
  const [knownPages, , knownParts] = usePages(docFiles, !MIRROR);
  useEffect(() => { if (Object.keys(knownPages).some((k) => !pages[k])) setPages((p) => ({ ...knownPages, ...p })); }, [knownPages]);
  useEffect(() => { if (Object.keys(knownParts).some((k) => String(halves[k]) !== String(knownParts[k]))) setHalves((x) => ({ ...x, ...knownParts })); }, [knownParts]);
  // The document a slide asked for: its pages and parts at once, before the rest are counted
  const askedFile = docFiles.find((x) => x.id === ((here.key || '').split(':')[1] || '')) || null;
  useEffect(() => {
    const f = askedFile;
    if (!f) return undefined;
    let live = true;
    openDoc(f).then((doc) => { if (live) setPages((p) => (p[f.id] === doc.count ? p : { ...p, [f.id]: doc.count })); return partsOf(f); }).then((ns) => { if (live && ns && ns.length) setHalves((x) => (String(x[f.id]) === String(ns) ? x : { ...x, [f.id]: ns })); }).catch(() => {});
    return () => { live = false; };
  }, [askedFile?.id]);
  const notePages = (fileId, count, page, n) => {
    setPages((p) => {
      if (p[fileId] === count) return p;
      ch.current?.postMessage({ type: 'pages', id, pages: { [fileId]: count } });
      return { ...p, [fileId]: count };
    });
    setHalves((x) => (x[fileId]?.[page] === n ? x : { ...x, [fileId]: Object.assign([...(x[fileId] || [])], { [page]: n }) }));
  };
  // Moving itself: the stop with its key; else (a page still being counted) its item's card; else the cover
  const ownAt = useMemo(() => {
    if (!OWN || !deck.length) return 0;
    const k = here.key ? deck.findIndex((s) => s.key === here.key) : -1;
    if (k >= 0) return k;
    const item = here.itemId || (here.key && !/^(section|cover|since|end)/.test(here.key) ? here.key.split(':')[0] : '');
    const i = item ? deck.findIndex((s) => s.itemId === item) : -1;
    return i >= 0 ? i : 0;
  }, [deck, here]);
  deckRef.current = deck;
  if (OWN) atRef.current = ownAt;
  // Board's preview is told the deck and where it is, for its list of slides and its "4 of 31"
  useEffect(() => {
    if (!PREVIEW || !deck.length) return;
    window.parent?.postMessage({ type: 'board-preview-deck', id, at: ownAt, pages, halves, stops: deck.map(({ key, kind, itemId, fileId, page, part, n, sectionId }) => ({ key, kind, itemId, fileId, page, part: part || 0, n, sectionId })) }, location.origin);
  }, [deck, ownAt, pages, halves]);
  // Presenting: the slide kept for a reload
  // (never while the slide asked for is still being counted: a reload then would lose it)
  useEffect(() => { if (PRESENT && deck[ownAt] && (!here.key || deck[ownAt].key === here.key)) { try { sessionStorage.setItem(`bs-at:${id}`, deck[ownAt].key); } catch { /* private browsing */ } } }, [ownAt, deck]);

  // The next meeting, on the calendar with no agenda yet: there's nothing to show until there is
  const waitingAgenda = data.nextPending?.id === id;
  if (fail && !v) return html`<div class="bs bs--center"><div class="bs-cover__lead"><img src=${LOGO} alt="" width="96" height="96" /><h1 class="bs-h1">${waitingAgenda ? 'The agenda isn’t posted yet' : fail}</h1><p class="bs-quiet">${waitingAgenda ? 'The screen opens once it is.' : data.me.admin ? 'Share the meeting in Board, and this screen opens it.' : 'It may not be shared yet.'}</p>${MIRROR ? null : html`<p><a class="bs-back bs-back--text" href=${waitingAgenda ? '#/' : '#/meetings'}>${waitingAgenda ? 'Home' : 'All meetings'}</a></p>`}</div></div>`;
  // Opening: the dark screen at once, its words only if it takes a moment (no flash of them on every open); no answer
  // for a while says so, with the way back
  if (!v || !meeting) return html`<div class="bs bs--center bs--opening" role="status"><img src=${LOGO} alt="" width="96" height="96" /><p class="bs-quiet">${trouble ? 'The board page isn’t answering. Still trying…' : 'Opening the screen…'}</p>${trouble && !MIRROR ? html`<p><a class="bs-back bs-back--text" href=${`#/meetings/${encodeURIComponent(id)}`} onClick=${(e) => { if (onBack) { e.preventDefault(); onBack(`#/meetings/${encodeURIComponent(id)}`); } }}>Back to the meeting</a></p>` : null}</div>`;

  // The chair's own word is the newest while they're moving this screen (the saved state catches up a moment later)
  const fresh = !OWN && told && (told.rehearsal || Date.now() - told.at < 60_000);
  const live = OWN ? { ...liveOfStop(deck[ownAt]), sectionAt: '', floor: '' } : fresh ? told.live : v.live;
  // Presenting on the meeting's day counts as the meeting held: each part's timer runs
  const started = OWN ? PRESENT && meeting.date === todayEastern() : !!v.live.startedAt || (fresh && !!told.live.startedAt);
  const ended = OWN ? deck[ownAt]?.kind === 'end' : live.screen === 'end' || (!fresh && !!v.live.endedAt);
  const at = OWN ? ownAt : ended ? deck.length - 1 : stopIndex(deck, live);
  const stop = deck[at] || deck[0];
  // Each item's number as the agenda has it (a meeting ahead its presenter writes on carries it: this copy is only their items)
  const items = agendaItems(meeting).map((x) => { const it = meeting.sections[x.si]?.items[x.ii]; return typeof it?.n === 'string' && it.n ? { ...x, label: it.n } : x; });
  const onItem = ['item', 'doc', 'live', 'books', 'report'].includes(stop.kind);
  const item = onItem ? (stop.n >= 0 ? meeting.sections[items[stop.n].si].items[items[stop.n].ii] : { ...MORE, notes: '', docs: [] }) : null;
  // A slide with the money's changes on it: QuickBooks' own, or the money item's card or list (% | $ shows there)
  const moneyHere = stop.kind === 'books' || (stop.kind === 'live' && stop.fileId === 'live:cash') || (stop.kind === 'item' && item?.live === 'cash');
  const cardSi = stop.kind === 'section' ? meeting.sections.findIndex((x) => x.id === stop.sectionId) : -1;
  const label = stop.n >= 0 ? items[stop.n].label : cardSi >= 0 ? String(cardSi + 1).padStart(2, '0') : '';
  const section = stop.n >= 0 ? items[stop.n].section : '';
  const people = d?.people || [];
  const who = item ? presentersOf(item, people) : [];
  // Who has the floor: the one the chair gave it to, else whoever presents the item
  const given = live.floor ? people.find((p) => p.slug === live.floor) || null : null;
  const floor = given ? [given] : who;
  const secId = stop.sectionId || (stop.n >= 0 ? meeting.sections[items[stop.n].si]?.id : '');
  if (OWN && started && secId && !partsAt.current.has(secId)) partsAt.current.set(secId, new Date().toISOString());
  const timer = started && !ended && secId ? sectionClock(plan, secId, OWN ? partsAt.current.get(secId) : live.sectionAt) : null;
  // The item's documents the deck comes to next (never one it leaves out: staff only, a statement QuickBooks draws)
  const docs = item ? (stop.n >= 0 ? itemDocs(meeting, item, v.prior || []).filter((d) => deck.some((s) => s.fileId === d.file.id)) : docsOf(meeting.files.filter((f) => deck.some((s) => s.fileId === f.id && s.n === -1)))) : [];
  const file = stop.fileId ? [...meeting.files, ...(v.prior || []).flatMap((x) => x.files)].find((f) => f.id === stop.fileId) : null;
  // The half of a tall page on: the chair's word for this page (this deck may not have split it yet), else the stop's
  const half = stop.kind === 'doc' && stop.fileId === live.fileId && stop.page === (live.page || 0) ? (live.part ? 1 : 0) : stop.part || 0;
  const numbers = v.snapshot || data.numbers;
  const vote = v.vote && started && !ended && !(fresh && told.rehearsal) ? v.vote : null;
  const place = [m?.location, m?.address].filter(Boolean).join(', ');

  const top = html`<header class="bs-top">
    <span class="bs-brand">${MIRROR ? null : html`<a class="bs-back" href=${`#/meetings/${encodeURIComponent(id)}`} onClick=${(e) => { if (onBack) { e.preventDefault(); onBack(`#/meetings/${encodeURIComponent(id)}`); } }} aria-label="Back to the meeting" title="Back to the meeting">${BACK}</a>`}<img src=${LOGO} alt="" width="40" height="40" /><span><strong title=${meetingName(meeting)}>${meetingName(meeting)}</strong><small>${[isDate(meeting.date) ? longDate(meeting.date) : '', !OWN && started && !ended && (v.practice || meeting.date === todayEastern()) ? 'Live' : ''].filter(Boolean).join(' · ')}</small></span></span>
    ${onItem && floor.length ? html`<span class=${`bs-floor ${given ? 'is-given' : ''}`}>${floor.map((p) => html`<${Face} p=${p} size=${34} key=${p.slug || p.name} />`)}<span><strong>${namesText(floor.map((p) => p.name))}</strong><span class="bs-floor__has"> ${floor.length > 1 ? 'have' : 'has'} the floor</span></span></span>` : null}
    <span class="bs-top__right">${timer ? html`<span class=${`bs-timer ${timer.over ? 'is-over' : ''}`} role="timer">${timer.over ? `Time’s up · ${clockText(timer.left)} over` : `${clockText(timer.left)} left`}</span>` : null}${told?.rehearsal ? html`<span class="bs-chip">Rehearsal</span>` : null}${v.practice ? html`<span class="bs-chip">Practice</span>` : null}${PRESENT && unshared ? html`<span class="bs-chip" title="Board members can’t see this meeting yet. Share it in Board when it’s ready.">Not on the board page yet</span>` : null}${label ? html`<span class="bs-num">${label}</span>` : null}<span class="bs-clock">${nowClock()}</span>${PRESENT && moneyHere ? html`<span class="bs-chg" role="group" aria-label="Changes against last year and the budget (C)">${[['pct', '%', 'As percentages'], ['usd', '$', 'In dollars']].map(([k, l, t]) => html`<button type="button" class="bs-chg__b" key=${k} aria-pressed=${chg === k} title=${`${t} (C)`} onClick=${() => setChg(k)}><span aria-hidden="true">${l}</span><span class="sr-only">${t}</span></button>`)}</span>` : null}${PRESENT ? html`<span class="bs-steps" role="group" aria-label="Move the slides"><button type="button" class="bs-step" disabled=${at <= 0} onClick=${() => go(at - 1)} aria-label="Back a slide (←)" title="Back a slide (←)">${PREV}</button><span class="bs-step__n">${at + 1} of ${deck.length}</span><button type="button" class="bs-step" disabled=${at >= deck.length - 1} onClick=${() => go(at + 1)} aria-label="Next slide (→)" title="Next slide (→)">${NEXT}</button></span>` : null}${MIRROR ? null : html`<button type="button" class="bs-full" onClick=${fullScreen} aria-label=${document.fullscreenElement ? 'Exit full screen (F)' : 'Full screen (F)'} title=${document.fullscreenElement ? 'Exit full screen (F)' : 'Full screen (F)'}>${FULL}</button>`}</span>
  </header>`;

  let stage;
  if (stop.kind === 'cover') {
    const sections = meeting.sections.filter((s) => s.title || s.items.length);
    const presenting = [...new Map(meeting.sections.flatMap((s) => s.items.flatMap((it) => presentersOf(it, people))).map((p) => [p.slug || p.name, p])).values()];
    stage = html`<div class="bs-cover">
      <div class="bs-cover__lead">
        <img class="bs-cover__logo" src=${LOGO} alt="" width="120" height="120" />
        <p class="bs-eyebrow">Sunshine on a Ranney Day · Board of Directors</p>
        <h1 class="bs-display">${meetingName(meeting)}</h1>
        <p class="bs-cover__when">${[isDate(meeting.date) ? longDate(meeting.date) : '', m ? timeRange(m.start, m.end) : ''].filter(Boolean).join(' · ')}</p>
        ${place ? html`<p class="bs-quiet">${place}</p>` : null}
        ${presenting.length ? html`<p class="bs-cover__faces">${presenting.slice(0, 9).map((p) => html`<${Face} p=${p} size=${44} key=${p.slug || p.name} />`)}<span>${presenting.length} presenting</span></p>` : null}
      </div>
      ${sections.length ? html`<ol class="bs-outline">${sections.map((s, i) => { const t = plan.get(s.id); return html`<li key=${s.id}><span class="bs-outline__n">${String(i + 1).padStart(2, '0')}</span><span>${s.title || 'Agenda'}<small>${[t?.start ? clock(t.start) : '', t ? `${t.minutes} min` : ''].filter(Boolean).join(' · ')}</small></span></li>`; })}</ol>` : null}
    </div>`;
  } else if (stop.kind === 'end') {
    const next = data.meetings.filter((x) => isDate(x.date) && x.date > meeting.date).sort((a, b) => a.date.localeCompare(b.date))[0];
    // Only what the board voted on (a motion is "passed" until a vote says otherwise, so one never voted isn't a decision)
    const decided = (v.motions || []).filter((x) => x.text && x.tally);
    stage = html`<div class=${`bs-end ${decided.length ? 'has-recap' : ''}`}>
      <div class="bs-end__lead">
        <img class="bs-cover__logo" src=${LOGO} alt="" width="120" height="120" />
        <h1 class="bs-display">Thank you</h1>
        ${v.live.endedAt ? html`<p class="bs-cover__when">The meeting ended at ${new Date(v.live.endedAt).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' })}</p>` : null}
        ${next ? html`<p class="bs-end__next"><${Tile} d=${next.date} /><span><small>Next board meeting</small><strong>${longDate(next.date)}</strong>${next.start ? html`<span>${timeRange(next.start, next.end)}</span>` : null}</span></p>` : null}
      </div>
      ${decided.length ? html`<div class="bs-end__recap"><p class="bs-eyebrow">What the board decided today</p><ol class="bs-decided">${decided.slice(0, 6).map((x) => html`<li key=${x.id}><span>${x.text}</span><b class=${`is-${x.result}`}>${x.tally ? `${{ passed: 'Passed', failed: 'Did not pass', tabled: 'Tabled' }[x.result] || 'Recorded'} ${x.tally.for}–${x.tally.against}` : { passed: 'Passed', failed: 'Did not pass', tabled: 'Tabled' }[x.result] || 'Recorded'}</b></li>`)}</ol></div>` : null}
    </div>`;
  } else if (stop.kind === 'since') {
    stage = html`<${SinceSlide} v=${v} n=${data.numbers} meeting=${meeting} />`;
  } else if (stop.kind === 'section') {
    stage = html`<${Chapter} n=${cardSi + 1} sec=${meeting.sections[cardSi]} t=${plan.get(meeting.sections[cardSi]?.id)} items=${items} people=${people} />`;
  } else if (stop.kind === 'books') {
    // QuickBooks' own: the year against last year, or a statement beside a year before
    stage = html`<${BooksSlide} books=${books} kind=${stop.fileId.slice(6)} notes=${data.lineNotes?.[id]?.[item?.id]} as=${chg} />`;
  } else if (stop.kind === 'live') {
    // One of the item's other live lists, as the item's own would show
    const k = stop.fileId.slice(5);
    const facts = liveSlide(k, numbers, id, data, meeting.date, chg);
    stage = html`<div class=${`bs-item ${k === 'projects' || k === 'reveals' ? 'bs-item--board' : 'bs-item--facts'}`}>
      <div class="bs-item__bar"><div><p class="bs-eyebrow">${item.title || section || 'Agenda'}</p><h1 class="bs-display bs-item__title">${LIVE_TITLES[k]}</h1></div></div>
      <div class="bs-item__facts">${facts || html`<p class="bs-quiet">Nothing to show here yet</p>`}</div>
    </div>`;
  } else if (stop.kind === 'report') {
    // The report on an item that shows live facts (./board-shared.js deckOf): the part, the item and who presents it
    // along the top, the report filling the rest, the motion under it
    stage = html`<div class="bs-item bs-item--report">
      <div class="bs-item__bar"><div><p class="bs-eyebrow">${section && section !== item.title ? section : 'Agenda'}</p><h1 class="bs-display bs-item__title">${item.title}</h1></div>
        ${who.length ? html`<div class="bs-item__aside"><ul class="bs-who">${who.map((p) => html`<li key=${p.slug || p.name}><${Face} p=${p} size=${52} /><span><strong>${p.name}</strong>${roleOf(p) ? html`<small>${roleOf(p)}</small>` : null}</span></li>`)}</ul></div>` : null}</div>
      <${ReportBody} report=${item.report} />
      ${item.motion ? html`<div class="bs-item__body"><${ItemMotion} text=${item.motion} /></div>` : null}
    </div>`;
  } else if (stop.kind === 'item') {
    const faces = stop.n >= 0 ? facesOf(item) : '';
    const facts = faces ? null : liveSlide(item.live, numbers, id, data, meeting.date, chg);
    // Where it sits in its part, when the part has more than it ("1 of 5")
    const mates = stop.n >= 0 ? items.filter((x) => x.si === items[stop.n].si) : [];
    const of = mates.length > 1 ? `${mates.findIndex((x) => x.ii === items[stop.n].ii) + 1} of ${mates.length}` : '';
    const head = html`<p class="bs-eyebrow">${[section && section !== item.title ? section : '', !section && stop.n < 0 ? 'After the agenda' : ''].filter(Boolean).join('') || 'Agenda'}${of ? html`<span class="bs-eyebrow__of">${of}</span>` : null}</p>
      <h1 class="bs-display bs-item__title">${item.title || LIVE_TITLES[item.live] || 'Agenda'}</h1>
      ${item.confidential ? html`<p class="bs-chip bs-chip--warn">Board only · please don’t share</p>` : null}`;
    const whoList = who.length ? html`<ul class="bs-who">${who.map((p) => html`<li key=${p.slug || p.name}><${Face} p=${p} size=${facts || faces || item.report ? 52 : 72} /><span><strong>${p.name}</strong>${roleOf(p) ? html`<small>${roleOf(p)}</small>` : null}</span></li>`)}</ul>` : null;
    // Under the money's tiles there's room for a row: each document small, its title beside it
    const coming = docs.length ? html`<div class="bs-coming"><p class="bs-eyebrow">${docs.length === 1 ? 'Its document' : 'Its documents'}${deck[at + 1]?.kind === 'report' ? ', after the report' : ', next'}</p><${Shelf} docs=${docs} pages=${pages} row=${!!facts && !faces} max=${item.notes && (item.live === 'minutes' || item.report) ? 2 : item.notes || item.live === 'minutes' ? 3 : 6} /></div>` : null;
    if (faces) {
      stage = html`<div class="bs-item bs-item--board bs-item--faces">
        <div class="bs-item__bar"><div>${head}</div><div class="bs-item__aside">${faces === 'roll' ? html`<${RollCount} v=${v} started=${started} />` : whoList}</div></div>
        <div class="bs-item__facts"><${FacesGrid} kind=${faces} v=${v} people=${people} started=${started} year=${Number(String(meeting.date).slice(0, 4))} /></div>
      </div>`;
    } else if (facts && (item.live === 'projects' || (item.live === 'reveals' && !item.report && !item.notes && !coming))) {
      // The makeovers and the reveals: the item's name and who presents it along the top, the rest of the screen theirs
      stage = html`<div class="bs-item bs-item--board">
        <div class="bs-item__bar"><div>${head}</div>${whoList ? html`<div class="bs-item__aside">${whoList}</div>` : null}</div>
        <div class="bs-item__facts">${facts}</div>
      </div>`;
    } else if (facts) {
      stage = html`<div class=${`bs-item bs-item--facts ${item.report ? 'has-report' : ''}`}>
        <div class="bs-item__bar"><div>${head}</div><div class="bs-item__aside">${whoList}</div></div>
        <div class="bs-item__facts">${facts}</div>
        ${item.notes || item.report || item.motion || coming ? html`<div class="bs-item__body">${item.notes ? html`<${Points} text=${item.notes} />` : null}${item.report && deck[at + 1]?.kind !== 'report' ? html`<${ReportFit} text=${item.report} />` : null}${deck[at + 1]?.kind === 'report' ? null : html`<${ItemMotion} text=${item.motion} />`}${coming}</div>` : null}
      </div>`;
    } else if (item.report) {
      // A report: the item and who presents it along the top, the report filling the rest
      const motion = item.live === 'minutes' ? html`<${MinutesMotion} item=${item} v=${v} />` : null;
      const points = !!mdPoints(item.report);
      stage = html`<div class=${`bs-item bs-item--report ${points ? 'bs-item--points' : ''}`}>
        <div class="bs-item__bar"><div>${head}</div><div class="bs-item__aside">${whoList}</div></div>
        ${points ? html`<${ReportPoints} text=${item.report} />` : html`<${ReportFit} text=${item.report} cols=${mdWords(item.report) > 110 ? 2 : 1} />`}
        ${item.notes || motion || item.motion || coming ? html`<div class="bs-item__body"><${ItemMotion} text=${item.motion} />${motion}${item.notes ? html`<${Points} text=${item.notes} />` : null}${coming}</div>` : null}
      </div>`;
    } else {
      // Approving the last minutes: the motion the board votes on, and how it went once the board page's vote closed
      const motion = item.live === 'minutes' ? html`<${MinutesMotion} item=${item} v=${v} />` : null;
      const side = item.notes || coming || motion || item.motion;
      // Nothing more to show: where it sits in its part, when the part has more than it
      const sec = stop.n >= 0 ? meeting.sections[items[stop.n].si] : null;
      const part = !side && sec?.items.length > 1 ? html`<${PartList} sec=${sec} items=${items} current=${item} people=${people} />` : null;
      stage = html`<div class=${`bs-item ${side || part ? 'bs-item--split' : 'bs-item--title'}`}>
        <div class="bs-item__lead">${head}${whoList}</div>
        ${side ? html`<div class="bs-item__side"><${ItemMotion} text=${item.motion} />${motion}${item.notes ? html`<${Points} text=${item.notes} />` : null}${coming}</div>` : part ? html`<div class="bs-item__side">${part}</div>` : null}
      </div>`;
    }
  } else {
    stage = html`<${DocPage} f=${file} page=${stop.page} part=${half} box=${box} onPages=${notePages} key=${file?.id} />`;
  }
  // The pages that are stops (a blank one isn't), counted to the last of them: a blank page at the end isn't "of 2"
  const shownPages = stop.kind === 'doc' ? Array.from({ length: pages[stop.fileId] || 0 }, (_, i) => i).filter((i) => halves[stop.fileId]?.[i] !== 0) : [];
  const ofPages = shownPages.length ? shownPages.at(-1) + 1 : pages[stop.fileId] || 0;
  // Its name (not again when the item has the same one), its page or slide, and whether it's a page's second part
  const named = docTitle(file?.name);
  const pageWord = docKind(file || {}) === 'slides' ? 'Slide' : 'Page';
  const docName = named.toLowerCase() === String(item?.title || '').trim().toLowerCase() ? '' : named;
  const pageWords = [ofPages > 1 ? `${pageWord} ${stop.page + 1} of ${ofPages}` : '', half ? 'continued' : ''].filter(Boolean).join(', ');
  const docWords = stop.kind === 'doc' && (docName || pageWords) ? html`${docName ? html`<span class="bs-foot__name">${docName}</span>` : null}${docName && pageWords ? html`<span class="bs-foot__sep bs-foot__sep--name">·</span>` : null}${pageWords}` : null;

  // The line under the stage and the rail are there on every stop, so the stage keeps its size from one to the next
  return html`<div class=${`bs bs--${stop.kind} ${awake ? 'is-awake' : ''} ${vote ? 'has-vote' : ''} ${MIRROR ? 'is-mirror' : ''}`}>
    ${top}
    <main class="bs-stage" ref=${stageRef} tabindex="0" aria-label="The meeting on the screen"><div class="bs-stage__in" key=${stop.kind === 'doc' ? `doc:${stop.fileId}` : stop.key}>${stage}</div></main>
    ${vote ? html`<aside class="bs-vote" aria-live="polite">
      <p class="bs-eyebrow">The board is voting</p>
      <h2 class="bs-vote__what">${vote.text || 'A motion'}</h2>
      ${vote.by || vote.second ? html`<p class="bs-quiet">${[vote.by && `Moved by ${vote.by}`, vote.second && `seconded by ${vote.second}`].filter(Boolean).join(', ')}</p>` : null}
      <ul class="bs-vote__counts">${[['for', 'For'], ['against', 'Against'], ['abstain', 'Abstain']].map(([k, l]) => html`<li class=${`is-${k}`} key=${k}><span class="bs-vote__n">${vote.counts[k]}</span><span>${l}</span><i style=${`--p:${vote.counts.of ? Math.min(100, (vote.counts[k] / vote.counts.of) * 100) : 0}%`}></i></li>`)}</ul>
      <p class="bs-quiet">${vote.counts.voted} of ${vote.counts.of} here ${vote.counts.voted === 1 ? 'has' : 'have'} voted, on the board page</p>
    </aside>` : null}
    <div class="bs-foot">${stop.kind === 'doc' ? html`
      <span class="bs-foot__what">${label ? html`<b>${label}</b>` : null}<span class="bs-foot__item">${item?.title}</span>${docWords ? html`<span class="bs-foot__sep">·</span>${docWords}` : null}</span>
      ${shownPages.length > 1 && shownPages.length <= 12 ? html`<span class="bs-foot__pages" aria-hidden="true">${shownPages.map((i) => html`<i class=${i === stop.page ? 'is-on' : ''} key=${i}></i>`)}</span>` : null}`
      : stop.kind === 'books' || stop.kind === 'live' || stop.kind === 'report' ? html`<span class="bs-foot__what">${label ? html`<b>${label}</b>` : null}${item?.title}<span class="bs-foot__sep">·</span>${stop.kind === 'books' ? BOOKS_TITLES[stop.fileId.slice(6)] : stop.kind === 'report' ? 'Report' : LIVE_TITLES[stop.fileId.slice(5)]}</span>`
      : PRESENT ? html`<span class="bs-foot__what bs-foot__keys"><kbd>←</kbd> <kbd>→</kbd> or a clicker to move<span class="bs-foot__sep">·</span><kbd>B</kbd> blanks the screen<span class="bs-foot__sep">·</span><kbd>C</kbd> the money’s changes in % or $<span class="bs-foot__sep">·</span><kbd>F</kbd> full screen</span>`
      : !started && !told && !MIRROR && !OWN ? html`<span class="bs-foot__what">The screen follows the meeting once the chair starts it.</span>` : null}
    </div>
    <${Rail} meeting=${meeting} items=${items} at=${at} deck=${deck} ended=${ended} prior=${v.prior || []} timer=${timer} />
    ${blank ? html`<button type="button" class="bs-blank" onClick=${() => setBlank(false)} aria-label="The screen is blank. Press B or click to bring it back."></button>` : null}
  </div>`;
}

/**
 * An item's documents, coming up after its card: each one's first page, title, and what it is, in a row (the first
 * six, and how many more)
 */
function Shelf({ docs, pages, row: asRow = false, max = 6 }) {
  // More than three come up as the row (each small, its title beside it): as covers they'd need rows past the screen
  const row = asRow || docs.length > 3;
  // Sized to the screen once: a TV's covers are bigger than a laptop's (a row's small, beside their titles)
  const [w] = useState(() => (row ? Math.round(Math.max(34, Math.min(64, innerHeight * 0.06))) : Math.round(Math.max(84, Math.min(170, innerHeight * 0.15)))));
  const shown = docs.slice(0, docs.length > max ? max - 1 : max);
  return html`<ul class=${`bs-shelf ${row ? 'bs-shelf--row' : ''}`} style=${`--cover:${w}px`}>${shown.map((d) => html`<${ShelfDoc} d=${d} width=${w} pages=${pages[d.file.id]} key=${d.key} />`)}${docs.length > shown.length ? html`<li class="bs-shelf__more">and ${docs.length - shown.length} more</li>` : null}</ul>`;
}
/** One of them: its first page, and its pages counted as it opens (the screen hasn't drawn it yet) */
function ShelfDoc({ d, width, pages }) {
  const [count, setCount] = useState(0);
  const [size, setSize] = useState(null);
  // Its pages counted as the screen shows them (a blank one isn't)
  useEffect(() => { let live = true; openDoc(d.file).then(async (doc) => { if (!live) return; setCount(doc.count); setSize(doc.size(0)); const ns = await partsOf(d.file); if (live && ns.some(Boolean)) setCount(ns.filter(Boolean).length); }).catch(() => {}); return () => { live = false; }; }, [d.file.id]);
  // Its first page as it is, inside a letter page's slot: a slide or a photo sits in the middle, a tall page fits
  const ref = useCover(size ? d.file : null, size ? Math.round(Math.min(width, (width * 1.294 * size.w) / size.h)) : width);
  const n = count || pages;
  return html`<li>
    <span class="bs-shelf__cover" ref=${ref} aria-hidden="true"></span>
    <span class="bs-shelf__text"><span class="bs-shelf__t">${d.title}</span>
    <span class="bs-shelf__m">${[formatOf(d.file), n && !['image', 'other'].includes(docKind(d.file)) ? plural(n, docKind(d.file) === 'slides' ? 'slide' : 'page') : ''].filter(Boolean).join(' · ')}</span></span>
  </li>`;
}

/**
 * On a board member's own page while the meeting is live: the page the screen is showing, small, and a way to
 * follow the screen full size. Nothing while no document is up.
 */
export function ScreenPeek({ v, onOpen }) {
  const f = v.live.fileId ? (v.files || []).concat((v.prior || []).flatMap((x) => x.files)).find((x) => x.id === v.live.fileId) : null;
  const ref = useRef(null);
  const [n, setN] = useState({ count: 0, halves: 1 });
  useEffect(() => {
    if (!f || !ref.current) return undefined;
    let gone = false;
    const w = Math.min(560, ref.current.parentElement?.clientWidth || 320);
    drawFitted(f, v.live.page, { w, h: Math.round(w * 0.62) }, { part: v.live.part || 0 }).then(({ el, count, halves }) => {
      if (gone || !ref.current) return;
      setN({ count, halves });
      ref.current.replaceChildren(el);
    }).catch(() => {});
    return () => { gone = true; };
  }, [f?.id, v.live.page, v.live.part]);
  if (!f) return null;
  return html`<figure class="bp-peek">
    <div class="bp-peek__page" ref=${ref}></div>
    <figcaption><span><strong>On the screen:</strong> ${[docTitle(f.name), n.count > 1 ? `${docKind(f) === 'slides' ? 'slide' : 'page'} ${v.live.page + 1} of ${n.count}` : '', n.halves === 2 && v.live.part ? 'continued' : ''].filter(Boolean).join(', ')}</span>
      <a class="bp-btn bp-btn--sm" href=${`#/meetings/${v.id}/screen`} onClick=${onOpen}>Follow the screen</a></figcaption>
  </figure>`;
}
