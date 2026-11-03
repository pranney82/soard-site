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
import { openDoc, layoutOf, areaOf, partsOf, showOf, docKind, pageWordOf } from './docs.js';
import {
  meetingName, longDate, shortDate, timeRange, liveLines, noteBlocks, agendaItems, presentersOf, deckOf, spreadsOf, pagesText, stopIndex, isDate, clock, todayEastern, MORE,
  sectionPlan, sectionClock, clockText, liveOfStop, facesOf, itemDocs, docsOf, docTitle, formatOf, plural, initialsOf, namesText, LIVE_TITLES,
  hasReport, isNothingNew, NOTHING_NEW, slidesOfItem, slideHeadsOfItem, shownLook,
} from '../board-shared.js';
import { useCover, usePages } from '../board-present.js';
import { Report } from '../board-report.js';
import { BooksSlide, booksTitle } from './books.js';
import { mdWords, mdPoints, mdFigures, mdNumber, mdPlain } from '../board-md.js';
import { Pipeline, sized, nameFit } from './kanban.js';
import { useCashNow, useBudget, moneyTiles, mixOf, RevenueMix, budgetDue, readChangeAs, keepChangeAs, Both } from './money.js';

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
/** A face, `size` its width at 1280x720 (portal.css --bs-u about 10.6px): it grows with the screen, as the type does */
function Face({ p, size }) {
  const [broken, setBroken] = useState(false);
  const s = `--s:calc(var(--bs-u, 10.6px) * ${Math.round((size / 10.6) * 100) / 100})`;
  return p?.photo && !broken
    ? html`<img class="bs-face" src=${roomPhoto(p.photo)} alt="" width=${size} height=${size} style=${s} onError=${() => setBroken(true)} />`
    : html`<span class="bs-face bs-face--initials" style=${`${s};--hue:${hueOf(p?.name)}`} data-i=${initialsOf(p?.name)} aria-hidden="true"></span>`;
}
const BACK = html`<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><path d="M16 10H4M9 15l-5-5 5-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>`;
const FULL = html`<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><path d="M3.5 7.5v-4h4M12.5 3.5h4v4M16.5 12.5v4h-4M7.5 16.5h-4v-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>`;
/** The whole screen for the screen, or back */
const fullScreen = () => { if (document.fullscreenElement) document.exitFullscreen?.(); else document.documentElement.requestFullscreen?.().catch(() => {}); };
const nowClock = () => new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });
const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || '';
/** Who presents, in words that stay short: "Alex Morgan", "Alex & Sam", "Alex & 2 more" */
const whoWords = (ws) => (ws.length === 1 ? ws[0].name : ws.length === 2 ? namesText(ws.map((p) => firstName(p.name))) : `${firstName(ws[0].name)} & ${ws.length - 1} more`);
/** Shorter still, for a top bar with little room: "Alex", "Christopher & 1 more" (never longer than whoWords) */
const whoShort = (ws) => {
  const s = ws.length === 1 ? firstName(ws[0].name) : `${firstName(ws[0].name)} & ${ws.length - 1} more`;
  return s.length < whoWords(ws).length ? s : whoWords(ws);
};
/**
 * Who has the floor, along the top, in the longest of its wordings that fits beside the clock: with "has the floor",
 * the names alone, first names, then one face (data-fit, portal.css). Stepped as it's drawn (its ref, every render) and
 * as the window changes, so a name is never cut or broken mid-word (a phone with the clock running had room for three
 * letters); every name is in its title
 */
const floorWatch = typeof ResizeObserver === 'function' ? new ResizeObserver((es) => es.forEach((e) => fitFloor(e.target.querySelector(':scope > .bs-floor')))) : null;
function fitFloor(el) {
  if (!el?.isConnected) return;
  floorWatch?.observe(el.parentElement);
  const t = el.lastElementChild;
  for (let n = 0; n <= 3; n += 1) {
    el.dataset.fit = String(n);
    if (t.scrollWidth <= t.clientWidth + 1 && el.scrollWidth <= el.clientWidth + 1) return;
  }
}
document.fonts?.ready.then(() => document.querySelectorAll('.bs-top > .bs-floor').forEach(fitFloor));
/** A part's name: its title, else its one item's, else "Part 3" (never "Agenda") */
const partName = (s, si) => s?.title || (s?.items?.length === 1 ? s.items[0].title || LIVE_TITLES[s.items[0].live] || '' : '') || `Part ${si + 1}`;

/**
 * Fitted to the stage. A slide: set smaller in steps (its --fit, down to `min`) until it all fits above the rail (a
 * phone scrolls it instead). A title (`lines` given): stepped down (--tfit, to `min`) until it's at most that many
 * lines, and past that it's cut at a word with … (its whole words its name and its hover); drawn whole either way
 * (data-whole), since a clamp's edge would cut its last line's g, y and p (Peter: "the g and y are cut off!"). On a
 * phone, whose stage scrolls, a long title is read to its end, never cut short
 */
function useFit(deps, { min = 0.6, lines = 0 } = {}) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    const stage = el?.closest('.bs-stage');
    if (!el || !stage) return undefined;
    const prop = lines ? '--tfit' : '--fit';
    // A title's words as given, its one text (cut short below only when even at its smallest it runs past its lines)
    const words = lines && el.firstChild?.nodeType === 3 ? el.firstChild : null;
    const full = words?.data ?? '';
    const over = () => {
      // (half a line past is the letters' own tails, a g's or a y's: a line more is a whole line)
      if (lines) { const lh = parseFloat(getComputedStyle(el).lineHeight); return el.scrollHeight > lh * (lines + 0.5); }
      const cs = getComputedStyle(stage);
      // Whole pixels both sides, so a slide a pixel taller than the stage (564 in 563) is over, not let through as rounding
      return Math.max(el.offsetHeight, el.scrollHeight) > Math.floor(stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom));
    };
    const fit = () => {
      if (words && words.data !== full) { words.data = full; el.removeAttribute('aria-label'); el.removeAttribute('title'); }
      el.style.setProperty(prop, '1');
      const scrolls = getComputedStyle(stage).overflowY === 'auto';
      if (!lines && scrolls) return;
      let f = 1;
      while (f > min && over()) { f = Math.max(min, Math.round((f - 0.05) * 100) / 100); el.style.setProperty(prop, String(f)); }
      if (!lines) return;
      // Still past its lines at its smallest (a TV's): as many of its words as fit, then …, so no line hides under
      // the clamp and the last one's tails are whole
      if (words && !scrolls && over()) {
        const parts = full.split(/(?<=\s)/);
        const upTo = (k) => { words.data = `${parts.slice(0, k).join('').trimEnd()}…`; };
        let lo = 0;
        let hi = parts.length - 1;
        while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); upTo(mid); if (over()) hi = mid - 1; else lo = mid; }
        upTo(lo);
        el.setAttribute('aria-label', full);
        el.setAttribute('title', full);
      }
      el.toggleAttribute('data-whole', !over() || scrolls);
    };
    fit();
    // Again when the stage changes (the window, full screen) and once the fonts are in; never on its own size (no loop)
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => fit()) : null;
    ro?.observe(stage);
    document.fonts?.ready.then(fit);
    return () => ro?.disconnect();
  }, deps);
  return ref;
}
/**
 * A makeover family's name and a reveal's (kanban.js, the dates' line), each clamped to its lines like a title: drawn
 * whole (data-whole) when it fits them, so the clamp's edge never cuts a y's tail ("Maya", "1 family")
 */
const wholeIfFits = () => document.querySelectorAll('.bs-stage .bs-pipe__name, .bs-stage .bs-when__name').forEach((el) => {
  el.removeAttribute('data-whole');
  // (a line more than it shows is a whole line over; the letters' own tails are a few pixels)
  if (el.scrollHeight < el.clientHeight + parseFloat(getComputedStyle(el).lineHeight) / 2) el.setAttribute('data-whole', '');
});
/** A slide's title at its role's size (portal.css .bs-fit, --bs-fs), never more than three lines */
function Title({ text, cls = '' }) {
  const ref = useFit([text], { lines: 3 });
  return html`<h1 class=${`bs-display bs-fit ${cls}`} ref=${ref} dir="auto">${text}</h1>`;
}

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

/**
 * Sheets of a file side by side as an open book (`sheets`: one or two [page, part]s, deckOf), each a page whole, or of a
 * very tall page one of its parts (docs.js showOf), as big as `box` ({ w, h }) holds two of them: a file's last page
 * on its own comes up the size of the rest, so nothing moves or resizes from one spread to the next. A file of one
 * page, or a wide page (a slide, a landscape sheet, a screenshot), is a spread of its own as big as it fits. `stack`
 * (a phone, its stage scrolling) puts them one under the other, each as wide as the screen
 * → { el, count, shows: how each sheet's page shows }
 */
async function drawSpread(f, sheets, box, { stack = false } = {}) {
  const doc = await openDoc(f);
  // A file the screen can't draw (an old .doc, an iPhone photo): said so, not its download card
  if (doc.kind === 'other') throw new Error('not drawable');
  const list = sheets.map(([p, k]) => [Math.max(0, Math.min(p, doc.count - 1)), k || 0]).filter(([p, k], j, l) => l.findIndex(([q, m]) => q === p && m === k) === j);
  const lays = await Promise.all(list.map(([i]) => layoutOf(f, doc, i)));
  const shows = lays.map(showOf);
  // Room for two across, the spine between them a hairline; one only for a file of one page or a wide page
  const across = !stack && (list.length === 2 || ((doc.count > 1 || shows[0] < 0) && shows[0] !== 2)) ? 2 : 1;
  const el = document.createElement('div');
  el.className = `bs-book ${list.length === 2 ? 'is-open' : ''} ${stack ? 'is-stacked' : ''}`;
  const sheetOf = (w, h) => { const sh = document.createElement('div'); sh.className = 'bs-sheet'; sh.style.width = `${w}px`; sh.style.height = `${h}px`; return sh; };
  el.append(...await Promise.all(list.map(async ([i, k], j) => {
    const size = doc.size(i);
    const tall = size.h / size.w;
    // A very tall page's part: cut at its blank band, every part of the page at one zoom (the words one size)
    if (shows[j] < 0) {
      const parts = Array.from({ length: -shows[j] }, (_, q) => areaOf(lays[j], q)).filter(Boolean);
      const a = areaOf(lays[j], k);
      if (a && parts.length) {
        const pw = Math.max(...parts.map((x) => x.w));
        const ph = Math.max(...parts.map((x) => x.h));
        const W = Math.floor(stack ? box.w / pw : Math.min(box.w / across / pw, box.h / (ph * tall)));
        const H = Math.round(W * tall);
        const drawn = await doc.draw(i, { width: W });
        drawn.style.marginLeft = `${-Math.round(a.x * W)}px`;
        drawn.style.marginTop = `${-Math.round(a.y * H)}px`;
        // (the sheet the size of the page's biggest part, this part ending at its own cut: never the next one's first line)
        const crop = document.createElement('div');
        crop.className = 'bs-sheet__part';
        crop.style.height = `${Math.round(a.h * H)}px`;
        crop.append(drawn);
        const sh = sheetOf(Math.round(pw * W), Math.round(ph * H));
        sh.append(crop);
        return sh;
      }
    }
    const w = Math.floor(stack ? box.w : Math.min(box.w / across, box.h / tall));
    const sh = sheetOf(w, Math.round(w * tall));
    sh.append(await doc.draw(i, { width: w }));
    return sh;
  })));
  // The spread after this one worked out now, so it turns at once
  const last = list.at(-1)[0];
  for (const q of [last + 1, last + 2]) if (q < doc.count) layoutOf(f, doc, q).catch(() => {});
  return { el, count: doc.count, shows };
}

/**
 * A spread on the screen, kept up until the next is drawn (no flash between), turning the way the meeting went (in
 * from the right going on, from the left going back); `onPages` hears the counts
 */
function DocPage({ f, sheets, box, onPages }) {
  const ref = useRef(null);
  const was = useRef(null);
  const learned = useRef(false);
  const [state, setState] = useState('opening');
  const at = sheets.join();
  useEffect(() => {
    if (!f || !box.w || !box.h) return undefined;
    let gone = false;
    drawSpread(f, sheets, box, { stack: matchMedia('(max-width: 900px)').matches }).then(({ el, count, shows }) => {
      if (gone || !ref.current) return;
      sheets.forEach(([p], k) => onPages?.(f.id, count, p, shows[k]));
      const old = ref.current.firstElementChild;
      const from = was.current;
      // (where the spread is in the file: its first sheet, a page and a part)
      const here = sheets[0][0] * 10 + (sheets[0][1] || 0);
      was.current = here;
      ref.current.replaceChildren(el);
      if (old && from !== null && from !== here && el.animate && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
        el.animate([{ opacity: 0, transform: `translateX(${here > from ? 28 : -28}px)` }, { opacity: 1, transform: 'none' }], { duration: 300, easing: 'cubic-bezier(0.2, 0.7, 0.2, 1)' });
      }
      setState('');
      // How every page shows, once a file: a screen on its own then pairs the pages as the chair does, a blank page
      // left out of "Next" before it's reached
      if (!learned.current) { learned.current = true; partsOf(f).then((ns) => { if (ref.current) ns.forEach((n, j) => onPages?.(f.id, count, j, n)); }).catch(() => {}); }
    }).catch(() => { if (!gone) setState('failed'); });
    return () => { gone = true; };
  }, [f?.id, at, box.w, box.h]);
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
/** A point's runs (board-md.js mdFigures), each figure in yellow: a link breaks anywhere it must; a short hyphenated
 *  word (W-9, 20-second) stays on one line */
const figRuns = (rs) => rs.map((r, k) => {
  if (r.br) return html`<br key=${k} />`;
  let out = r.fig || r.href ? r.text : r.text.split(/([\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)+)/u).map((w, j) => (j % 2 && w.length <= 20 ? html`<span class="bs-pt__w">${w}</span>` : w));
  if (r.fig) out = html`<b class="bs-pt__fig">${out}</b>`;
  if (r.i) out = html`<em>${out}</em>`;
  if (r.b) out = html`<strong>${out}</strong>`;
  // A link opens in a tab of its own, so the presenter can show the page itself (the board page, the live page) and
  // come back to the slide; it lets go of the focus, so a clicker's Enter doesn't open it again
  if (r.href) out = html`<a class="bs-pt__a" href=${r.href} target="_blank" rel="noopener noreferrer" onClick=${(e) => e.currentTarget.blur()}>${out}</a>`;
  return out;
});
/**
 * A short report that is only its points (board-md.js mdPoints): each point a card of its own, two or three across,
 * the words as large as the slide holds them, each figure in yellow, the cards coming up one after another. Where the
 * cards can't fit at a size the room still reads (a short window, a motion and notes under them), it's drawn whole
 * instead (ReportFit), and tried as cards again once there's more room.
 */
function ReportPoints({ text, all = false, more = false }) {
  const p = mdPoints(text, { all });
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
      const last = el.querySelector('.bs-pts__more') || list;
      return !!list && (last.offsetTop + last.offsetHeight > el.clientHeight + 1 || [...el.querySelectorAll('.bs-pt__t')].some((t) => t.scrollWidth > t.clientWidth + 1));
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
  if (whole) return html`<${ReportFit} text=${text} cols=${mdWords(text) > 110 ? 2 : 1} more=${more} />`;
  const n = p.points.length;
  const runs = (t) => figRuns(mdFigures(t));
  return html`<div class=${`bs-pts is-${n}`} ref=${ref}>
    ${p.lead ? html`<p class="bs-pts__lead" dir="auto">${runs(p.lead)}</p>` : null}
    <ol class="bs-pts__list" start=${p.start}>${p.points.map((t, k) => html`<li class="bs-pt" key=${k} style=${`--i:${k}`}>
      <span class=${`bs-pt__n ${p.numbered ? '' : 'is-mark'}`} aria-hidden="true">${p.numbered ? p.start + k : ''}</span>
      <p class="bs-pt__t" dir="auto">${runs(t)}</p>
    </li>`)}</ol>
    ${more ? html`<p class="bs-report__more bs-pts__more">Continued on the next slide</p>` : null}
  </div>`;
}

/**
 * A report on the screen, as large as a room reads it best. A short one (under about 40 words) large and centred, like
 * a quote. A longer one at the report's size, in two balanced columns when one would run past the bottom (and the box
 * is wide enough for two), smaller only as far as it must be (to 82%, about 20px on a 720p screen). What still doesn't
 * fit runs on into columns past the box's edge, out of sight: it ends on a whole line, a list item whole, never on a
 * heading, and only then a line says the whole report is on the board page. The columns are measured (`cols`, from
 * before, is no longer a choice)
 */
function ReportFit({ text, more = false, part = false, cont = '' }) {
  const ref = useRef(null);
  const [cut, setCut] = useState(false);
  const short = !part && mdWords(text) < 40;
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const box = el.parentElement;
    const over = () => el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1;
    const fit = () => {
      const size = (k) => el.style.setProperty('--fit', String(k));
      let k = 1;
      size(k);
      box.classList.remove('is-cols', 'is-full');
      // Two columns once one runs past the bottom, when each would still hold a room's line (about 22 words wide)
      if (!short && over() && el.clientWidth >= 30 * parseFloat(getComputedStyle(el).fontSize)) box.classList.add('is-cols');
      while (k > (short ? 0.6 : 0.82) && over()) { k = Math.round((k - 0.04) * 100) / 100; size(k); }
      // Cut: the columns filled in turn, so they hold as much as they can
      const cutNow = over();
      if (cutNow) box.classList.add('is-full');
      setCut(cutNow);
      // The report page's preview says whether it fits, and about how much the room sees (the blocks in sight)
      if (PREVIEW) {
        const edge = el.getBoundingClientRect();
        const units = [...el.querySelectorAll('.rp > :not(ul):not(ol), .rp > ul > li, .rp > ol > li')];
        const words = (u) => u.textContent.trim().split(/\s+/).filter(Boolean).length;
        const seen = (u) => { const r = u.getBoundingClientRect(); return r.left < edge.right - 1 && r.top < edge.bottom - 1; };
        window.parent?.postMessage({ type: 'board-preview-fit', cut: cutNow, shown: units.filter(seen).reduce((n, u) => n + words(u), 0), total: units.reduce((n, u) => n + words(u), 0) }, location.origin);
      }
    };
    fit();
    // Again when its box changes (the window, the rail, the line under it coming or going) and once the fonts are in;
    // fitting never changes the box itself (no loop)
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => fit()) : null;
    ro?.observe(el);
    document.fonts?.ready.then(fit);
    return () => ro?.disconnect();
  }, [text]);
  return html`<div class=${`bs-report ${short ? 'is-short' : ''}`}>
    <div class="bs-report__body" ref=${ref}>${cont ? html`<p class="bs-report__cont" dir="auto">${mdPlain(cont)}<span>, continued</span></p>` : null}<${Report} text=${text} level=${3} /></div>
    ${cut ? html`<p class="bs-report__more">The whole report is on the board page</p>` : more ? html`<p class="bs-report__more">Continued on the next slide</p>` : null}
  </div>`;
}

/**
 * A report whose presenter chose big numbers (board-shared.js shownLook): each point's figure large, its words under
 * it (board-md.js mdNumber), on a card of its own, two or three across, coming up one after another. Where they can't
 * fit at a size the room reads, its points as cards instead (ReportPoints)
 */
function ReportNumbers({ text, more = false }) {
  const p = mdPoints(text, { all: true });
  const ref = useRef(null);
  const [whole, setWhole] = useState(false);
  useEffect(() => setWhole(false), [text]);
  useEffect(() => {
    const el = ref.current;
    if (!el || whole) return undefined;
    const phone = () => window.matchMedia('(max-width: 900px)').matches;
    const over = () => {
      const list = el.querySelector('.bs-stats__list');
      const last = el.querySelector('.bs-pts__more') || list;
      return !!list && (last.offsetTop + last.offsetHeight > el.clientHeight + 1 || [...el.querySelectorAll('.bs-stat__fig, .bs-stat__t')].some((t) => t.scrollWidth > t.clientWidth + 1));
    };
    const fit = () => {
      let s = phone() ? 1 : POINT_FIT_MAX;
      el.style.setProperty('--fit', String(s));
      while (!phone() && s > POINT_FIT_MIN && over()) { s = Math.round((s - 0.05) * 100) / 100; el.style.setProperty('--fit', String(s)); }
      if (!phone() && over()) { setWhole(true); return; }
      if (PREVIEW) { const words = mdWords(text); window.parent?.postMessage({ type: 'board-preview-fit', cut: false, shown: words, total: words }, location.origin); }
    };
    fit();
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => fit()) : null;
    ro?.observe(el.parentElement);
    document.fonts?.ready.then(fit);
    return () => ro?.disconnect();
  }, [text, whole]);
  if (!p) return null;
  if (whole) return html`<${ReportPoints} text=${text} all more=${more} />`;
  return html`<div class=${`bs-stats is-${p.points.length}`} ref=${ref}>
    ${p.lead ? html`<p class="bs-pts__lead" dir="auto">${figRuns(mdFigures(p.lead))}</p>` : null}
    <ul class="bs-stats__list">${p.points.map((t, k) => { const x = mdNumber(t); return html`<li class="bs-stat" key=${k} style=${`--i:${k}`}>
      ${x ? html`<span class="bs-stat__fig">${x.fig}</span>` : null}
      <p class="bs-stat__t" dir="auto">${figRuns(x ? x.runs : mdFigures(t))}</p>
    </li>`; })}</ul>
    ${more ? html`<p class="bs-report__more bs-pts__more">Continued on the next slide</p>` : null}
  </div>`;
}

/** A report's slide (one of reportSlides'), drawn as its presenter chose (board-shared.js shownLook): its points as
 *  cards, its numbers large, else its words as they fit. `more`: it goes on, on the next slide; `part`: one of several,
 *  never set large as a short one would be */
const ReportBody = ({ report, look = 'words', more = false, part = false, cont = '' }) => (look === 'cards' ? html`<${ReportPoints} text=${report} all more=${more} />`
  : look === 'numbers' ? html`<${ReportNumbers} text=${report} more=${more} />`
  : html`<${ReportFit} text=${report} more=${more} part=${part} cont=${cont} />`);
/** How an item's report is drawn: as cards, its numbers, or its words (cards and numbers fill a slide the same way) */
const lookOfItem = (it) => shownLook(it.report, it.reportLook);
const asPoints = (look) => look === 'cards' || look === 'numbers';

/**
 * The presenter's notes beside an item, at a size a room reads: smaller only as far as it must be to fit the slide (to
 * 80%), then as few of its last points off as it takes, and a line says the rest are on the board page. A phone shows
 * them all (its stage scrolls)
 */
function Points({ text }) {
  const ref = useRef(null);
  const blocks = noteBlocks(text);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const fit = () => {
      const more = el.querySelector('.bs-points__more');
      // Where it can end: after a paragraph, or after one of a list's points (its own points go with it)
      const units = [...el.children].filter((c) => c !== more).flatMap((c) => (c.tagName === 'UL' ? [...c.children] : [c]));
      const show = (k) => {
        units.forEach((u, i) => { u.hidden = i >= k; });
        el.querySelectorAll(':scope > ul').forEach((ul) => { ul.hidden = [...ul.children].every((li) => li.hidden); });
        more.hidden = k >= units.length;
        more.textContent = `${units.length - k} more on the board page`;
      };
      show(units.length);
      let k = 1;
      el.style.setProperty('--fit', '1');
      const stage = el.closest('.bs-stage');
      if (!stage || getComputedStyle(stage).overflowY === 'auto') return;
      const slide = el.closest('.bs-item') || el.parentElement;
      const over = () => slide.scrollHeight > slide.clientHeight + 1 || el.scrollHeight > el.clientHeight + 1;
      while (k > 0.8 && over()) { k = Math.round((k - 0.05) * 100) / 100; el.style.setProperty('--fit', String(k)); }
      let n = units.length;
      while (n > 1 && over()) show(--n);
    };
    fit();
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => fit()) : null;
    ro?.observe(el.closest('.bs-item') || el);
    document.fonts?.ready.then(fit);
    return () => ro?.disconnect();
  }, [text]);
  if (!blocks.length) return null;
  const list = (nodes) => html`<ul dir="auto">${nodes.map((n) => html`<li dir="auto">${n.text}${n.children.length ? list(n.children) : null}</li>`)}</ul>`;
  const out = [];
  let run = [];
  for (const b of blocks) {
    if (b.para) { if (run.length) { out.push(list(run)); run = []; } out.push(html`<p dir="auto">${b.text}</p>`); } else run.push(b);
  }
  if (run.length) out.push(list(run));
  return html`<div class="bs-points" ref=${ref}>${out}<p class="bs-points__more" hidden></p></div>`;
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
/** A slide with nothing to show yet, said at the size of the room in the middle of it: never a lone small grey line */
function Empty({ title, line = '', mark = null }) {
  return html`<div class="bs-empty" role="status">
    ${mark ? html`<span class="bs-empty__mark" aria-hidden="true">${mark}</span>` : null}
    <p class="bs-empty__title">${title}</p>
    ${line ? html`<p class="bs-empty__line">${line}</p>` : null}
  </div>`;
}
const CALENDAR = html`<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="5" width="17" height="15" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.6" /><path d="M3.5 9.5h17M8 3v4M16 3v4" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" /></svg>`;
/**
 * The money as figures: the cash, the year against its budget (./money.js moneyTiles), the first on yellow; under
 * them, where the year's revenue came from (the meeting's own numbers for one already held)
 */
function CashSlide({ n, data, date, as = 'pct' }) {
  const upTo = date && date < todayEastern() ? date : '';
  const cash = useCashNow(data, upTo, n);
  const budget = useBudget(data, upTo, n);
  const tiles = moneyTiles({ cash, budget, n, due: budgetDue(data, upTo), as });
  // The same lines the other way, each said both ways in its place (money.js Both), so % | $ moves nothing
  const other = new Map(moneyTiles({ cash, budget, n, due: budgetDue(data, upTo), as: as === 'usd' ? 'pct' : 'usd' }).map((t) => [t.k, t.sub]));
  const books = upTo ? n?.books : data.numbers.books;
  // Closer together (their room around the figures, never the words) while the slide runs past the bottom; past that,
  // the row of documents coming under them goes (they're the next slides, the rail says so)
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const fit = () => {
      // (a late call, the fonts in after the figures gave way to "No figures yet": nothing to fit)
      if (!el.isConnected) return;
      const stage = el.closest('.bs-stage');
      const slide = el.closest('.bs-item') || el.parentElement;
      const coming = slide.querySelector('.bs-coming');
      const row = coming && coming.parentElement.children.length === 1 ? coming.parentElement : coming;
      if (row) row.hidden = false;
      // Past the slide's bottom, or past its own row (squeezed by the rows under it, it would run over them)
      const cell = el.parentElement;
      const over = () => slide.scrollHeight > slide.clientHeight + 1 || cell.scrollHeight > cell.clientHeight + 1;
      const tighten = () => {
        let k = 1;
        el.style.setProperty('--kfit', '1');
        while (k > 0.5 && over()) { k = Math.round((k - 0.1) * 100) / 100; el.style.setProperty('--kfit', String(k)); }
      };
      el.style.setProperty('--kfit', '1');
      if (!stage || getComputedStyle(stage).overflowY === 'auto') return;
      tighten();
      if (row && over()) { row.hidden = true; tighten(); }
    };
    fit();
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => fit()) : null;
    ro?.observe(el.closest('.bs-item') || el);
    document.fonts?.ready.then(fit);
    return () => ro?.disconnect();
  }, [JSON.stringify(tiles.map((t) => [t.value, t.sub])), !!mixOf(books)]);
  if (!tiles.length) return html`<${Empty} mark="$" title="No figures yet" line="The money shows here once QuickBooks or a bank is connected." />`;
  const mix = mixOf(books) ? html`<div class="bs-mix"><p class="bs-figs__label">Where ${books.year}’s revenue came from</p><${RevenueMix} books=${books} /></div>` : null;
  // (an account below zero is a plain tile, never the yellow one)
  return html`<div class="bs-money" ref=${ref}><ul class="bs-figs" style=${`--n:${tiles.length}`}>${tiles.map((t) => html`<li key=${t.k} class=${t.quiet ? 'is-quiet' : null}><span class="bs-figs__label">${t.label}</span><span class=${`bs-figs__value ${/[a-z]{2,}/i.test(t.value) ? 'is-words' : ''}`}>${t.value}</span>${t.pct != null ? html`<span class="bs-figs__bar" role="img" aria-label=${`${t.pct}% of the budget`}><i style=${`--p:${Math.min(100, t.pct)}%`}></i></span>` : null}${t.sub ? html`<span class="bs-figs__sub"><${Both} as=${as} pct=${as === 'usd' ? other.get(t.k) : t.sub} usd=${as === 'usd' ? t.sub : other.get(t.k)} /></span>` : null}</li>`)}</ul>${mix}</div>`;
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
  // As many as fit across the screen at a readable size (about 8.5 of the screen's units a stop, 135px at 1080p), the
  // rest counted after them
  const vw = typeof innerWidth === 'number' ? innerWidth : 1600;
  const unit = Math.min((typeof innerHeight === 'number' ? innerHeight : 900) * 0.0148, vw * 0.0083);
  const room = Math.max(4, Math.floor((vw * 0.8) / (unit * 8.5)));
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
  // One column a photo across every stop (each stop spans its own), so every photo is the same width
  const tmpl = [...stops.map((g) => Array(across(g)).fill('minmax(0, 1fr)').join(' ')), ...(more ? ['minmax(0, 1fr)'] : [])].join(' ');
  return html`<div class="bs-when" data-rows=${rows} data-busy=${units > 4 ? (units > 6 ? 'more' : 'yes') : null} style=${`--tmpl:${tmpl};--rows:${rows};--units:${units}`}>
    <ol class="bs-when__line">${stops.map((g) => html`<li class=${g.set ? 'is-set' : ''} style=${`--across:${across(g)}`} key=${g.key}>${head(g)}</li>`)}${more ? html`<li class="is-more"><strong>+${more} more</strong><span>after these</span></li>` : null}</ol>
    <div class="bs-when__kids">${stops.map((g) => html`<div class=${`bs-when__stop ${g.set ? 'is-set' : ''}`} style=${`--across:${across(g)}`} key=${g.key}><p class="bs-when__stophead">${head(g)}</p><ul>${g.list.map((r) => {
      const photo = photoOf(r);
      // A time of its own (two families the same day at different times) on the photo's corner
      const time = g.set && r.time && !sameTime(g) ? html`<span class="bs-when__time">${clock(r.time)}</span>` : null;
      return html`<li key=${r.slug || r.name}>
        <span class="bs-when__photo">${photo ? html`<img src=${sized(photo, `${rows === 1 ? 'w=640,h=760' : 'w=640,h=520'},fit=cover,gravity=face`)} alt="" decoding="async" />` : html`<span class="bs-when__initials" aria-hidden="true">${initialsOf(r.name)}</span>`}${time}</span>
        <span class="bs-when__name" style=${nameFit(r.name)}>${r.name}</span>
      </li>`;
    })}</ul></div>`)}${more ? html`<p class="bs-when__more">+${more} more after these</p>` : null}</div>
  </div>`;
}
const DATE_STATES = { done: 'Held', today: 'Today', next: 'Next' };
/**
 * Dates down the slide (the events ahead, the year's board meetings), each on one line: as many as the screen holds
 * at the size a room reads them (about five on a 720p screen), then a second column beside them when the screen is
 * wide enough for two, then "+3 more". An ultrawide screen sets them in two columns sooner, so a line never runs its
 * whole width. A phone shows every one (its stage scrolls)
 */
function DatesSlide({ rows, note = '', empty = 'Nothing on the calendar yet' }) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const fit = () => {
      const lis = [...el.children].filter((li) => !li.classList.contains('bs-dates__more'));
      const more = el.querySelector('.bs-dates__more');
      const show = (k) => { lis.forEach((li, i) => { li.hidden = i >= k; }); more.hidden = k >= lis.length; more.textContent = `+${lis.length - k} more`; };
      const cols = (per) => { el.classList.toggle('is-two', per > 0); if (per > 0) el.style.setProperty('--per', String(per)); else el.style.removeProperty('--per'); };
      cols(0);
      show(lis.length);
      const stage = el.closest('.bs-stage');
      if (!stage || getComputedStyle(stage).overflowY === 'auto') return;
      const slide = el.closest('.bs-item') || el.parentElement;
      const over = () => slide.scrollHeight > slide.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1;
      const em = el.clientWidth / (parseFloat(getComputedStyle(el).fontSize) || 16);
      const n = lis.length;
      // How many one column holds
      let one = n;
      while (one > 1 && over()) show(--one);
      if (one >= n && !(em > 64 && n >= 4)) return;
      if (em < 40) return; // (too narrow for two: one column, and "+N more")
      // Two columns: as many to each as one held, fewer while they still run past the bottom
      for (let per = Math.max(1, one === n ? Math.ceil(n / 2) : one + 1); per >= 1; per--) {
        const k = n <= per * 2 ? n : per * 2 - 1;
        cols(n <= per * 2 ? Math.ceil(n / 2) : per);
        show(k);
        if (!over()) return;
      }
    };
    fit();
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => fit()) : null;
    ro?.observe(el.closest('.bs-item') || el);
    document.fonts?.ready.then(fit);
    return () => ro?.disconnect();
  }, [JSON.stringify(rows.map((r) => [r.key, r.title, r.sub, r.state]))]);
  if (!rows.length) return html`<${Empty} mark=${CALENDAR} title=${empty} />`;
  return html`${note ? html`<p class="bs-dates__note">${note}</p>` : null}<ul class="bs-dates" ref=${ref}>${rows.map((r) => html`<li class=${r.state ? `is-${r.state}` : ''} key=${r.key}><${Tile} d=${r.date} /><span class="bs-dates__text"><strong dir="auto">${r.title}</strong>${r.sub ? html`<span dir="auto">${r.sub}</span>` : null}</span>${r.state ? html`<b class="bs-dates__state">${r.state === 'done' ? CHECK : null}${DATE_STATES[r.state]}</b>` : null}</li>`)}<li class="bs-dates__more" hidden></li></ul>`;
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
  // Greyed as not here only once someone has checked in: presenting on the day, before anyone has, everyone is as they are
  const checking = started && here.length > 0;
  return html`<ul class="bs-faces" style=${`--cols:${Math.ceil(shown.length / rows)};--rows:${rows}`}>${shown.map((p) => {
    const state = !started ? '' : p.how === 'remote' ? 'is-remote' : p.how ? 'is-here' : checking ? 'is-away' : '';
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
  const labels = sec.items.map((it) => items.find((x) => x.id === it.id)?.label || '');
  // A long part, PART_ROWS rows at most: the item now, the two before it and the ones after, a row each saying how many
  // more are before and after (a 19-item part would run off the screen)
  const n = sec.items.length;
  let from = 0;
  let to = n;
  if (n > PART_ROWS) {
    // (one left out is shown instead: its row, not a line saying "1 earlier" or "and 1 more")
    from = Math.max(0, at - 2);
    if (from === 1) from = 0;
    to = from + PART_ROWS - (from ? 2 : 1);
    if (to >= n - 1) { to = n; from = n - (PART_ROWS - 1); }
  }
  return html`<ol class=${`bs-part ${labels.some((l) => l.length > 3) ? 'is-wide' : ''}`}>
    ${from ? html`<li class="bs-part__more" key="before">${from} earlier</li>` : null}
    ${sec.items.slice(from, to).map((it, k) => {
      const i = from + k;
      const ws = presentersOf(it, people);
      return html`<li key=${it.id} class=${i < at ? 'is-done' : i === at ? 'is-now' : ''}>
        <span class="bs-part__label">${i < at ? CHECK : labels[i]}</span>
        <span class="bs-part__t">${it.title || LIVE_TITLES[it.live] || ''}</span>
        ${ws.length ? html`<span class="bs-part__who">${ws.length > 3 ? whoWords(ws) : namesText(ws.map((p) => firstName(p.name)))}</span>` : null}
      </li>`;
    })}
    ${to < n ? html`<li class="bs-part__more" key="after">and ${n - to} more</li>` : null}
  </ol>`;
}
const PART_ROWS = 9;

/** When a part's time is: "6:40 PM to 6:55 PM · 15 minutes" */
const partWhen = (t) => (t ? [t.start ? `${clock(t.start)} to ${clock(t.end)}` : '', `${t.minutes} minutes`].filter(Boolean).join(' · ') : '');

/** A part's card: its number, its time, its title and its items. When one person (or the same pair) presents every item,
 *  they're said once under the title, not on each row; on a row, at most three faces and "Alex & 2 more". Past seven
 *  items, two columns with only the faces. A part too long for the screen is set smaller, the big number and the title
 *  first, until it all fits above the rail (useFit); a phone scrolls it instead */
const CHAPTER_ROWS = 24;
const keyOf = (ws) => ws.map((p) => p.slug || p.name).join('|');
/** Who presents every item in a part, when that's one person (or the same pair): else null */
function partWho(sec, people) {
  const whos = (sec?.items || []).map((it) => presentersOf(it, people));
  return whos.length > 1 && whos[0].length && whos.every((ws) => keyOf(ws) === keyOf(whos[0])) ? whos[0] : null;
}
function Chapter({ n, sec, t, items, people }) {
  const rows = sec?.items || [];
  const whos = rows.map((it) => presentersOf(it, people));
  const one = partWho(sec, people);
  const labels = rows.map((it) => items.find((x) => x.id === it.id)?.label || '');
  const cols = rows.length > 7;
  // Two columns of twelve at the most, the rest said ("and 6 more"): past that a part's items no longer read
  const shown = rows.length > CHAPTER_ROWS ? rows.slice(0, CHAPTER_ROWS - 1) : rows;
  const left = rows.length - shown.length;
  const ref = useFit([JSON.stringify([sec?.title, rows.map((it) => it.title), whos.map(keyOf)])], { min: 0.7 });
  return html`<div class=${`bs-chapter ${labels.some((l) => l.length > 3) ? 'is-wide' : ''}`} ref=${ref}>
    <span class="bs-chapter__n" aria-hidden="true">${String(n).padStart(2, '0')}</span>
    <div class="bs-chapter__body">
      ${t ? html`<p class="bs-eyebrow">${partWhen(t)}</p>` : null}
      <${Title} text=${partName(sec, n - 1)} cls="bs-chapter__title" />
      ${rows.length ? html`<ol class=${`bs-chapter__items ${cols ? 'is-cols' : ''}`} style=${cols ? `--rows:${Math.ceil((shown.length + (left ? 1 : 0)) / 2)}` : null}>${shown.map((it, i) => html`<li key=${it.id}><span class="bs-chapter__label">${labels[i]}</span><span class="bs-chapter__t" dir="auto">${it.title || LIVE_TITLES[it.live] || ''}</span>${!one && whos[i].length ? html`<span class="bs-chapter__who">${whos[i].slice(0, 3).map((p) => html`<${Face} p=${p} size=${36} key=${p.slug || p.name} />`)}${cols ? null : html`<span>${whoWords(whos[i])}</span>`}</span>` : null}</li>`)}${left ? html`<li class="bs-chapter__more" key="more">and ${left} more</li>` : null}</ol>`
        : html`<p class="bs-chapter__open">Open to the floor</p>`}
    </div>
  </div>`;
}

/** An item with nothing beside it: a card like a part's (.bs-chapter), set smaller only as far as it must to fit with
 *  its motion under it (useFit) */
function TitleCard({ big, over, title, confidential, calm, motion, fits }) {
  const ref = useFit([fits], { min: 0.5 });
  return html`<div class=${`bs-item bs-chapter bs-item--title ${big ? '' : 'is-plain'} ${big.length > 2 ? 'is-label' : ''}`} ref=${ref}>
    ${big ? html`<span class="bs-chapter__n" aria-hidden="true">${big}</span>` : null}
    <div class="bs-item__lead">
      ${over ? html`<p class="bs-eyebrow">${over}</p>` : null}
      <${Title} text=${title} cls="bs-item__title" />
      ${confidential ? html`<p class="bs-chip bs-chip--warn">Board only · please don’t share</p>` : null}
      ${calm}
    </div>
    ${motion}
  </div>`;
}

/**
 * The cover: the meeting (its name three lines at most), when and where, who presents; beside it the agenda's parts,
 * larger when there are four or fewer, in two columns from nine (past twelve without their times), and past sixteen
 * fifteen and how many more. Set smaller only as far as it must to fit (useFit)
 */
function Cover({ meeting, m, plan, people, place }) {
  const parts = meeting.sections.map((s, si) => ({ s, si })).filter(({ s }) => s.title || s.items.length);
  const presenting = [...new Map(meeting.sections.flatMap((s) => s.items.flatMap((it) => presentersOf(it, people))).map((p) => [p.slug || p.name, p])).values()];
  const cols = parts.length > 8;
  const shown = parts.length > 16 ? parts.slice(0, 15) : parts;
  const rest = parts.length - shown.length;
  const ref = useFit([JSON.stringify([meetingName(meeting), parts.map(({ s }) => s.title), presenting.length, place])], { min: 0.8 });
  return html`<div class=${`bs-cover ${cols ? 'is-cols' : ''}`} ref=${ref}>
    <div class="bs-cover__lead">
      <img class="bs-cover__logo" src=${LOGO} alt="" width="120" height="120" />
      <p class="bs-eyebrow">Sunshine on a Ranney Day · Board of Directors</p>
      <${Title} text=${meetingName(meeting)} />
      <p class="bs-cover__when">${[isDate(meeting.date) ? longDate(meeting.date) : '', m ? timeRange(m.start, m.end) : ''].filter(Boolean).join(' · ')}</p>
      ${place ? html`<p class="bs-quiet">${place}</p>` : null}
      ${presenting.length ? html`<p class="bs-cover__faces">${presenting.slice(0, 9).map((p) => html`<${Face} p=${p} size=${44} key=${p.slug || p.name} />`)}<span>${presenting.length} presenting</span></p>` : null}
    </div>
    ${parts.length ? html`<ol class=${`bs-outline ${cols ? 'is-cols' : parts.length <= 4 ? 'is-short' : ''}`} style=${cols ? `--rows:${Math.ceil((shown.length + (rest ? 1 : 0)) / 2)}` : null}>${shown.map(({ s, si }) => {
      const t = plan.get(s.id);
      const when = parts.length > 12 ? '' : [t?.start ? clock(t.start) : '', t ? `${t.minutes} min` : ''].filter(Boolean).join(' · ');
      return html`<li key=${s.id}><span class="bs-outline__n">${String(si + 1).padStart(2, '0')}</span><span><span class="bs-outline__t" dir="auto">${partName(s, si)}</span>${when ? html`<small>${when}</small>` : null}</span></li>`;
    })}${rest ? html`<li class="bs-outline__more" key="more">and ${rest} more parts</li>` : null}</ol>` : null}
  </div>`;
}

/**
 * What the board votes on for an item: its presenter's motion (item.motion), else, for the vote on the last minutes,
 * the usual words. Never another motion of the meeting's that happens to mention the minutes
 */
function motionOf(item, v) {
  const t = String(item?.motion || '').trim();
  if (t || item?.live !== 'minutes') return t;
  // The meeting's own motion approving minutes (its words and how it went), never one that only mentions them
  const said = (v.motions || []).find((x) => MINUTES_MOTION.test(String(x.text || '')));
  if (said) return String(said.text).trim();
  const prev = (v.prior || []).find((x) => x.id === item.about) || null;
  return `Approve the minutes of the ${prev ? `${prev.name}, ${shortDate(prev.date)},` : 'last meeting'} as written`;
}
/** A motion approving minutes: "Approve the minutes of…", "Move to adopt the Q3 board meeting minutes as written" */
const MINUTES_MOTION = /^\s*(?:(?:i\s+)?move[ds]?\s+(?:that\s+we\s+|to\s+)?|motion\s+to\s+)?(?:approve|adopt|accept)\s+(?:the\s+)?(?:[\w’'.,-]+\s+){0,6}?minutes\b/i;
/** The same motion as the meeting recorded it (the same words), for how its vote went: null when there's none */
const sameWords = (s) => String(s || '').trim().replace(/\s+/g, ' ').replace(/[.\s]+$/, '').toLowerCase();
const recordedAs = (text, v) => (sameWords(text) ? (v.motions || []).find((x) => sameWords(x.text) === sameWords(text)) || null : null);

/**
 * A motion across the slide (an item's, or the vote on the last minutes), as large as it fits and never cut: a motion
 * is 400 characters at most, so it gets smaller only as far as it must (to about 24px on a 720p screen, half its size
 * on its own slide), never shortened. `mo`: the motion as the meeting recorded it, for how the vote went. `big`: on a
 * slide of its own ("The decision")
 */
function ItemMotion({ text, mo = null, big = false }) {
  const t = String(text || '').trim();
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const slide = el.closest('.bs-item') || el.parentElement;
    const stage = el.closest('.bs-stage');
    // Past its own box, or the slide past its own or taller than the stage holds (a card as tall as its words)
    const room = () => { const cs = getComputedStyle(stage); return stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom); };
    const over = () => el.scrollHeight > el.clientHeight + 1 || slide.scrollHeight > slide.clientHeight + 1 || slide.offsetHeight > room() + 1;
    const fit = () => {
      let k = 1;
      el.style.setProperty('--mfit', '1');
      // (a phone's stage scrolls: it's never smaller there)
      if (stage && getComputedStyle(stage).overflowY !== 'auto') while (k > (big ? 0.5 : 0.72) && over()) { k = Math.round((k - 0.04) * 100) / 100; el.style.setProperty('--mfit', String(k)); }
      if (PREVIEW) window.parent?.postMessage({ type: 'board-preview-motion', cut: !!stage && over() }, location.origin);
    };
    fit();
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => fit()) : null;
    ro?.observe(slide);
    document.fonts?.ready.then(fit);
    return () => ro?.disconnect();
  }, [t, big]);
  if (!t) return null;
  const said = { passed: 'Passed', failed: 'Did not pass', tabled: 'Tabled' }[mo?.result] || 'Recorded';
  return html`<div class=${`bs-motion bs-motion--item ${big ? 'is-big' : ''}`} ref=${ref}>
    <p class="bs-eyebrow">The board votes on</p>
    <p class="bs-motion__text" dir="auto">${t}</p>
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
    const ahead = (n.events || []).slice(0, 24);
    const held = ahead.length ? [] : (n.recentEvents || []).slice(0, 8);
    return html`<${DatesSlide} empty="No events on the calendar yet" note=${!ahead.length && held.length ? 'Nothing on the calendar yet. Lately:' : ''} rows=${[...ahead, ...held].map((e) => ({ key: e.title + e.date, date: e.date, title: e.title, sub: [held.includes(e) ? '' : dayWords(e.date), e.time, e.location].filter(Boolean).join('  ·  '), state: held.includes(e) ? 'done' : '' }))} />`;
  }
  if (kind === 'meetings') {
    // The year's meetings: the ones held checked off, this one and the next marked (or only what's ahead, from before)
    const day = date || todayEastern();
    const list = (n.thisYear?.length ? n.thisYear : (n.meetings || []).filter((x) => x.id !== id)).slice(0, 24);
    const next = list.find((x) => x.date > day && x.id !== id);
    return html`<${DatesSlide} empty="No board meetings on the calendar yet" rows=${list.map((x) => ({ key: x.id || x.date, date: x.date, title: x.name, sub: [x.date > day ? dayWords(x.date) : '', x.start ? clock(x.start) : ''].filter(Boolean).join('  ·  '), state: x.id === id || x.date === day ? 'today' : x.date < day ? 'done' : x === next ? 'next' : '' }))} />`;
  }
  const lines = liveLines(kind, n, { meetingId: id });
  return lines.length ? html`<div class="bs-numbers"><ul>${lines.map((l) => html`<li>${l}</li>`)}</ul></div>` : null;
}

/**
 * "Since we last met": the kids revealed since the last meeting (their photos and days), the events held, and the
 * action items still open. A quiet line when it's been a quiet stretch. Up to three photos in a row, four to six in
 * two rows, past six five and how many more; each list four at most (three when both are there), then how many more;
 * all of it set smaller only as far as it must to fit (useFit)
 */
function SinceSlide({ v, n, meeting }) {
  const prev = (v.prior || []).find((x) => x.date) || null;
  const from = prev?.date || '';
  const inRange = (d) => isDate(d) && (!from || d > from) && d <= meeting.date;
  const reveals = (n?.pastReveals || []).filter((r) => inRange(r.date)).sort((a, b) => a.date.localeCompare(b.date));
  const events = (n?.recentEvents || []).filter((e) => inRange(e.date));
  const open = (v.actions || []).filter((a) => !a.done);
  const shown = reveals.length > 6 ? reveals.slice(0, 5) : reveals;
  const more = reveals.length - shown.length;
  const tiles = shown.length + (more ? 1 : 0);
  const rows = tiles > 3 ? 2 : 1;
  const cap = events.length && open.length ? 3 : 4;
  // A list longer than that gives its last row to "and N more", so the column is never taller for having more
  const list = (all) => all.slice(0, all.length > cap ? cap - 1 : cap);
  const ref = useFit([JSON.stringify([reveals.map((r) => r.name), events.map((e) => e.title), open.map((a) => a.text)])], { min: 0.84 });
  const day = (d) => shortDate(d).replace(/, \d{4}$/, '');
  const left = (all, shownN, word) => (all.length > shownN ? html`<p class="bs-since__left">and ${all.length - shownN} more ${word}</p>` : null);
  const ev = list(events);
  const acts = list(open);
  return html`<div class="bs-since" ref=${ref}>
    <div class="bs-since__head">
      <p class="bs-eyebrow">${prev ? `Since the ${prev.name}, ${shortDate(prev.date)}` : 'Since we last met'}</p>
      <h1 class="bs-display">Since we last met</h1>
    </div>
    ${shown.length ? html`<div class="bs-since__reveals" style=${`--rows:${rows};--cols:${Math.ceil(tiles / rows)}`}>
      <p class="bs-since__count"><strong>${reveals.length}</strong> ${reveals.length === 1 ? 'reveal' : 'reveals'}</p>
      <ul>${shown.map((r) => html`<li key=${r.slug || r.name}>
        <span class="bs-since__photo">${r.photo ? html`<img src=${sized(r.photo, rows > 1 ? 'w=640,h=800,fit=cover,gravity=face' : 'w=960,h=1200,fit=cover,gravity=face')} alt="" />` : html`<${Face} p=${{ name: r.name }} size=${120} />`}</span>
        <strong dir="auto">${r.name}</strong><span>${day(r.date)}</span>
      </li>`)}${more ? html`<li class="bs-since__more" key="more"><span class="bs-since__photo"><b>+${more}</b></span><strong>${more} more</strong><span>through ${day(reveals.at(-1).date)}</span></li>` : null}</ul>
    </div>` : null}
    ${events.length || open.length ? html`<div class=${`bs-since__side ${events.length && open.length ? 'is-both' : ''}`}>
      ${events.length ? html`<div><p class="bs-eyebrow">Events held</p><ul class="bs-since__list">${ev.map((e) => html`<li key=${e.title + e.date}><b>${day(e.date)}</b><span dir="auto">${e.title}</span></li>`)}</ul>${left(events, ev.length, 'held')}</div>` : null}
      ${open.length ? html`<div><p class="bs-eyebrow">Action items still open</p><ul class="bs-since__list">${acts.map((a) => html`<li key=${a.id}><b>${a.ownerName || 'Open'}</b><span dir="auto">${a.text}</span></li>`)}</ul>${left(open, acts.length, 'open')}</div>` : null}
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
    : next.kind === 'section' ? html`<span>Next <b>${String(meeting.sections.findIndex((x) => x.id === next.sectionId) + 1).padStart(2, '0')}</b> ${partName(meeting.sections.find((x) => x.id === next.sectionId), meeting.sections.findIndex((x) => x.id === next.sectionId))}</span>`
    : next.kind === 'books' ? html`<span>Next: ${booksTitle(next)}</span>`
    : next.kind === 'live' ? html`<span>Next: ${LIVE_TITLES[next.fileId.slice(5)]}</span>`
    : next.kind === 'report' ? html`<span>Next: ${next.page ? 'the report, continued' : 'Report'}</span>`
    : next.kind === 'decision' ? html`<span>Next: The decision</span>`
    : next.kind === 'doc' && next.fileId === stop?.fileId && next.part && (stop.pages || [stop.page]).includes(next.page) ? html`<span>Next: the rest of the page</span>`
    : next.kind === 'doc' && next.fileId === stop?.fileId ? html`<span>Next: ${pagesText(next.pages || [next.page], pageWordOf(files.find((f) => f.id === next.fileId)))}</span>`
    : next.kind === 'doc' ? html`<span>Next: ${docTitle(files.find((f) => f.id === next.fileId)?.name || 'the document')}</span>`
    : next.n >= 0 ? html`<span>Next <b>${items[next.n].label}</b> ${items[next.n].title}</span>` : html`<span>Next: ${MORE.title.toLowerCase()}</span>`;
  // Past ten parts, only the one on now is named (portal.css .is-many); it's always as wide as its name and its time
  return html`<footer class="bs-rail" aria-label="Where the meeting is">
    <ol class=${`bs-rail__parts ${sections.length > 10 ? 'is-many' : ''}`} style=${`--n:${sections.length}`}>${sections.map(({ s, si, items: its }) => {
      const on = cardAt >= 0 ? si === cardAt : its.some((it) => items.indexOf(it) === n);
      // A part with no items (new business, open forum) is passed once anything after it has come up
      const fill = cardAt === si ? 0.04 : its.length ? (its.filter((it) => items.indexOf(it) < n).length + (on ? 0.5 : 0)) / its.length : ended || cardAt > si || items.some((it) => it.si > si && items.indexOf(it) <= n) ? 1 : 0;
      const name = partName(s, si);
      const time = on && timer ? `${clockText(timer.left)}${timer.over ? ' over' : ' left'}` : '';
      return html`<li key=${s.id} class=${on ? 'is-on' : fill >= 1 ? 'is-done' : ''} style=${`--w:${Math.max(1, its.length)};--fill:${Math.min(1, fill)}${on ? `;--min:${name.length + (time ? time.length + 3 : 0)}` : ''}`}>
        <span class="bs-rail__bar" aria-hidden="true"><i></i></span>
        <span class="bs-rail__row"><span class="bs-rail__label" title=${name}><b>${String(si + 1).padStart(2, '0')}</b><span class="bs-rail__name">${name}</span></span>${time ? html`<i class=${`bs-rail__time ${timer.over ? 'is-over' : ''}`}>${time}</i>` : null}</span>
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
  const [shows, setShows] = useState({}); // { fileId: [how each page shows] } (docs.js showOf): the chair's, and the pages drawn here
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
  // The makeovers' family names and the reveals' whole when they fit their lines (after every render, as the window
  // changes and once the fonts are in)
  useEffect(wholeIfFits);
  useEffect(() => {
    addEventListener('resize', wholeIfFits);
    document.fonts?.ready.then(wholeIfFits);
    return () => removeEventListener('resize', wholeIfFits);
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
  // A step from or to a document still being counted (a fresh device's first seconds) waits for its pages and parts,
  // counted then and there: they go in between, so a quick Next never jumps past them. Six seconds at most (a file
  // that won't open is never counted); steps pressed meanwhile are taken one by one after
  const countedRef = useRef(() => true);
  const countRef = useRef(() => {});
  const held = useRef({ dir: 0, timer: 0 });
  const waits = (dir) => {
    const ids = [deckRef.current[atRef.current], deckRef.current[atRef.current + dir]].filter((s) => s?.kind === 'doc' && !countedRef.current(s.fileId)).map((s) => s.fileId);
    ids.forEach((fileId) => countRef.current(fileId));
    return ids.length > 0;
  };
  const step = (dir) => {
    const h = held.current;
    if (!h.dir && !waits(dir)) { go(atRef.current + dir); return; }
    h.dir += dir;
    if (!h.timer) h.timer = setTimeout(() => { h.timer = -1; setTick(Date.now()); }, 6000);
  };
  useEffect(() => {
    const h = held.current;
    if (!h.dir) return;
    const d = Math.sign(h.dir);
    if (h.timer > 0 && waits(d)) return;
    h.dir -= d;
    if (!h.dir) { clearTimeout(h.timer); h.timer = 0; }
    go(atRef.current + d);
  });

  // Board's preview: to the item being worked on, a slide picked beside it, or a step either way
  useEffect(() => {
    if (!PREVIEW) return undefined;
    const to = (e) => setHere({ key: '', itemId: e.detail });
    const msg = (e) => {
      if (e.origin !== location.origin || e.source !== window.parent) return;
      const x = e.data || {};
      if (x.type === 'board-preview-stop') { const s = deckRef.current.find((y) => y.key === x.key); if (s) setHere({ key: s.key, itemId: s.itemId || '' }); }
      if (x.type === 'board-preview-step') step(x.dir < 0 ? -1 : 1);
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
      if (msg.type === 'parts' && msg.parts) setShows((x) => ({ ...x, ...msg.parts }));
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
      // Shift with an arrow: the next item, or back to the start of this one (then the one before), past a document's pages
      if (PRESENT && e.shiftKey && (e.key === 'ArrowRight' || e.key === 'ArrowLeft')) {
        e.preventDefault();
        const deck = deckRef.current;
        const at = atRef.current;
        const of = (i) => deck[i]?.itemId || deck[i]?.key || '';
        const startOf = (i) => { let j = i; while (j > 0 && deck[j - 1].itemId && of(j - 1) === of(i)) j -= 1; return j; };
        if (e.key === 'ArrowRight') { let j = at + 1; while (j < deck.length - 1 && deck[at].itemId && of(j) === of(at)) j += 1; go(j); } else { const s0 = startOf(at); go(s0 < at ? s0 : startOf(Math.max(0, at - 1))); }
        return;
      }
      const dir = ['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter', 'j'].includes(e.key) ? (e.key === ' ' && e.shiftKey ? -1 : 1) : ['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace', 'k'].includes(e.key) ? -1 : 0;
      if (!dir || (!PRESENT && e.key === 'Enter') || (!PRESENT && e.key === 'Backspace')) return;
      if (e.repeat && PRESENT && e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return; // a held clicker button: one step
      e.preventDefault();
      if (PRESENT) step(dir); else ch.current?.postMessage({ type: 'key', id, dir });
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
  const deck = useMemo(() => (meeting ? deckOf(meeting, { pages, parts: shows, meetings: v.prior || [], books }) : []), [meeting, pages, shows, books]);
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
  useEffect(() => { if (Object.keys(knownParts).some((k) => String(shows[k]) !== String(knownParts[k]))) setShows((x) => ({ ...x, ...knownParts })); }, [knownParts]);
  // The document a slide asked for: its pages and parts at once, before the rest are counted
  const askedFile = docFiles.find((x) => x.id === ((here.key || '').split(':')[1] || '')) || null;
  useEffect(() => {
    const f = askedFile;
    if (!f) return undefined;
    let live = true;
    openDoc(f).then((doc) => { if (live) setPages((p) => (p[f.id] === doc.count ? p : { ...p, [f.id]: doc.count })); return partsOf(f); }).then((ns) => { if (live && ns && ns.length) setShows((x) => (String(x[f.id]) === String(ns) ? x : { ...x, [f.id]: ns })); }).catch(() => {});
    return () => { live = false; };
  }, [askedFile?.id]);
  const notePages = (fileId, count, page, n) => {
    setPages((p) => {
      if (p[fileId] === count) return p;
      ch.current?.postMessage({ type: 'pages', id, pages: { [fileId]: count } });
      return { ...p, [fileId]: count };
    });
    setShows((x) => (x[fileId]?.[page] === n ? x : { ...x, [fileId]: Object.assign([...(x[fileId] || [])], { [page]: n }) }));
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
  // Counted: its pages, and each page's parts (a step waiting on one counts it then and there, ahead of the rest)
  countedRef.current = (fileId) => pages[fileId] > 0 && Array.from({ length: pages[fileId] }, (_, i) => shows[fileId]?.[i]).every((n) => n !== undefined && n !== null);
  const counting = useRef(new Set());
  countRef.current = (fileId) => {
    const f = docFiles.find((x) => x.id === fileId);
    if (!f || counting.current.has(fileId)) return;
    counting.current.add(fileId);
    openDoc(f).then((doc) => { setPages((p) => (p[f.id] === doc.count ? p : { ...p, [f.id]: doc.count })); return partsOf(f); })
      .then((ns) => { if (ns?.length) setShows((x) => (String(x[f.id]) === String(ns) ? x : { ...x, [f.id]: ns })); })
      .catch(() => {});
  };
  // "5 of 54" once every document is counted (it would climb from 35 as they are), or after 8 seconds whatever is left
  const [late, setLate] = useState(false);
  useEffect(() => { const t = setTimeout(() => setLate(true), 8000); return () => clearTimeout(t); }, []);
  const total = late || docFiles.every((f) => countedRef.current(f.id)) ? ` of ${deck.length}` : '';
  // Board's preview is told the deck and where it is, for its list of slides and its "4 of 31"
  useEffect(() => {
    if (!PREVIEW || !deck.length) return;
    window.parent?.postMessage({ type: 'board-preview-deck', id, at: ownAt, pages, stops: deck.map(({ key, kind, itemId, fileId, page, pages: spread, part, of, n, sectionId }) => ({ key, kind, itemId, fileId, page, ...(spread ? { pages: spread } : {}), part: part || 0, of: of || 0, n, sectionId })) }, location.origin);
  }, [deck, ownAt, pages]);
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
  const onItem = ['item', 'doc', 'live', 'books', 'report', 'decision'].includes(stop.kind);
  const item = onItem ? (stop.n >= 0 ? meeting.sections[items[stop.n].si].items[items[stop.n].ii] : { ...MORE, notes: '', docs: [] }) : null;
  // A slide with the money's changes on it: QuickBooks' own, or the money item's card or list (% | $ shows there)
  const moneyHere = stop.kind === 'books' || (stop.kind === 'live' && stop.fileId === 'live:cash') || (stop.kind === 'item' && item?.live === 'cash');
  const cardSi = stop.kind === 'section' ? meeting.sections.findIndex((x) => x.id === stop.sectionId) : -1;
  const label = stop.n >= 0 ? items[stop.n].label : cardSi >= 0 ? String(cardSi + 1).padStart(2, '0') : '';
  const section = stop.n >= 0 ? items[stop.n].section : '';
  const people = d?.people || [];
  const who = item ? presentersOf(item, people) : [];
  // Who has the floor: the one the chair gave it to, else whoever presents the item (on a part's card, whoever presents
  // all of it). Said in one place, along the top, on every slide of the agenda (Peter: never a face that moves from
  // slide to slide), so no slide draws its presenters again
  const given = live.floor ? people.find((p) => p.slug === live.floor) || null : null;
  const floor = given ? [given] : item ? who : stop.kind === 'section' ? partWho(meeting.sections[cardSi], people) || [] : [];
  const secId = stop.sectionId || (stop.n >= 0 ? meeting.sections[items[stop.n].si]?.id : '');
  if (OWN && started && secId && !partsAt.current.has(secId)) partsAt.current.set(secId, new Date().toISOString());
  const timer = started && !ended && secId ? sectionClock(plan, secId, OWN ? partsAt.current.get(secId) : live.sectionAt) : null;
  // The item's documents the deck comes to next (never one it leaves out: staff only, a statement QuickBooks draws)
  const docs = item ? (stop.n >= 0 ? itemDocs(meeting, item, v.prior || []).filter((d) => deck.some((s) => s.fileId === d.file.id)) : docsOf(meeting.files.filter((f) => deck.some((s) => s.fileId === f.id && s.n === -1)))) : [];
  const file = stop.fileId ? [...meeting.files, ...(v.prior || []).flatMap((x) => x.files)].find((f) => f.id === stop.fileId) : null;
  const numbers = v.snapshot || data.numbers;
  const vote = v.vote && started && !ended && !(fresh && told.rehearsal) ? v.vote : null;
  const place = [m?.location, m?.address].filter(Boolean).join(', ');
  // The item's motion: on its slide, unless it has one of its own after the rest ("The decision", deckOf)
  const decides = !!item && deck.some((s) => s.kind === 'decision' && s.itemId === item.id);
  const motionText = item ? motionOf(item, v) : '';
  const motionHere = motionText && !decides ? html`<${ItemMotion} text=${motionText} mo=${recordedAs(motionText, v)} />` : null;

  const top = html`<header class="bs-top">
    <span class="bs-brand">${MIRROR ? null : html`<a class="bs-back" href=${`#/meetings/${encodeURIComponent(id)}`} onClick=${(e) => { if (onBack) { e.preventDefault(); onBack(`#/meetings/${encodeURIComponent(id)}`); } }} aria-label="Back to the meeting" title="Back to the meeting">${BACK}</a>`}<img src=${LOGO} alt="" width="40" height="40" /><span><strong title=${meetingName(meeting)}>${meetingName(meeting)}</strong><small>${[isDate(meeting.date) ? longDate(meeting.date) : '', !OWN && started && !ended && (v.practice || meeting.date === todayEastern()) ? 'Live' : ''].filter(Boolean).join(' · ')}</small></span></span>
    ${(onItem || stop.kind === 'section') && floor.length ? html`<span class=${`bs-floor ${given ? 'is-given' : ''}`} ref=${(el) => fitFloor(el)}>${floor.map((p) => html`<${Face} p=${p} size=${34} key=${p.slug || p.name} />`)}<span title=${namesText(floor.map((p) => p.name))}><strong class="bs-floor__long">${whoWords(floor)}</strong><strong class="bs-floor__short">${whoShort(floor)}</strong><span class="bs-floor__has"> ${floor.length > 1 ? 'have' : 'has'} the floor</span></span></span>` : null}
    <span class="bs-top__right">${timer ? html`<span class=${`bs-timer ${timer.over ? 'is-over' : ''}`} role="timer">${timer.over ? html`<span><span class="bs-timer__up">Time’s up · </span>${clockText(timer.left)} over</span>` : `${clockText(timer.left)} left`}</span>` : null}${told?.rehearsal ? html`<span class="bs-chip">Rehearsal</span>` : null}${v.practice ? html`<span class="bs-chip">Practice</span>` : null}${PRESENT && unshared ? html`<span class="bs-chip" title="Board members can’t see this meeting yet. Share it in Board when it’s ready.">Not on the board page yet</span>` : null}${label ? html`<span class="bs-num">${label}</span>` : null}<span class="bs-clock">${nowClock()}</span>${MIRROR ? null : html`<button type="button" class="bs-full" onClick=${fullScreen} aria-label=${document.fullscreenElement ? 'Exit full screen (F)' : 'Full screen (F)'} title=${document.fullscreenElement ? 'Exit full screen (F)' : 'Full screen (F)'}>${FULL}</button>`}</span>
  </header>`;
  // Presenting: back, the slide count and next, and on a money slide the % | $; in the line under the stage, there while
  // the mouse moves (portal.css .bs-ctl), so nothing along the top moves when a slide brings the % | $
  const ctl = PRESENT ? html`<span class="bs-ctl">${moneyHere ? html`<span class="bs-chg" role="group" aria-label="Changes against last year and the budget (C)">${[['pct', '%', 'As percentages'], ['usd', '$', 'In dollars']].map(([k, l, t]) => html`<button type="button" class="bs-chg__b" key=${k} aria-pressed=${chg === k} title=${`${t} (C)`} onClick=${() => setChg(k)}><span aria-hidden="true">${l}</span><span class="sr-only">${t}</span></button>`)}</span>` : null}<span class="bs-steps" role="group" aria-label="Move the slides"><button type="button" class="bs-step" disabled=${at <= 0} onClick=${() => step(-1)} aria-label="Back a slide (←)" title="Back a slide (←)">${PREV}</button><span class="bs-step__n">${at + 1}${total}</span><button type="button" class="bs-step" disabled=${at >= deck.length - 1} onClick=${() => step(1)} aria-label="Next slide (→)" title="Next slide (→)">${NEXT}</button></span></span>` : null;
  // Above an item's title: its part, by name (or "Part 3"), never "Agenda" (nor the item's own name again); after the
  // agenda, that
  const where = stop.n < 0 ? 'After the agenda' : section && section !== item?.title ? section : `Part ${items[stop.n].si + 1}`;
  // Its name, or (left blank: the editor shows the live list's) what it shows
  const itemTitle = item ? item.title || LIVE_TITLES[item.live] || MORE.title : '';

  let stage;
  if (stop.kind === 'cover') {
    stage = html`<${Cover} meeting=${meeting} m=${m} plan=${plan} people=${people} place=${place} />`;
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
      ${decided.length ? html`<div class="bs-end__recap"><p class="bs-eyebrow">What the board decided today</p><ol class="bs-decided">${decided.slice(0, 5).map((x) => html`<li key=${x.id}><span dir="auto">${x.text}</span><b class=${`is-${x.result}`}>${x.tally ? `${{ passed: 'Passed', failed: 'Did not pass', tabled: 'Tabled' }[x.result] || 'Recorded'} ${x.tally.for}–${x.tally.against}` : { passed: 'Passed', failed: 'Did not pass', tabled: 'Tabled' }[x.result] || 'Recorded'}</b></li>`)}</ol>${decided.length > 5 ? html`<p class="bs-decided__more">and ${decided.length - 5} more decided today</p>` : null}</div>` : null}
    </div>`;
  } else if (stop.kind === 'since') {
    stage = html`<${SinceSlide} v=${v} n=${data.numbers} meeting=${meeting} />`;
  } else if (stop.kind === 'section') {
    stage = html`<${Chapter} n=${cardSi + 1} sec=${meeting.sections[cardSi]} t=${plan.get(meeting.sections[cardSi]?.id)} items=${items} people=${people} />`;
  } else if (stop.kind === 'books') {
    // QuickBooks' own: the year against last year, or a statement beside a year before
    stage = html`<${BooksSlide} books=${books} kind=${stop.fileId.slice(6)} page=${stop.page} notes=${data.lineNotes?.[id]?.[item?.id]} as=${chg} />`;
  } else if (stop.kind === 'live') {
    // One of the item's other live lists, as the item's own would show
    const k = stop.fileId.slice(5);
    const facts = liveSlide(k, numbers, id, data, meeting.date, chg);
    stage = html`<div class=${`bs-item ${k === 'projects' || k === 'reveals' ? 'bs-item--board' : 'bs-item--facts'}`}>
      <div class="bs-item__bar"><div><p class="bs-eyebrow">${item.title || where}</p><${Title} text=${LIVE_TITLES[k]} cls="bs-item__title" /></div></div>
      <div class="bs-item__facts">${facts || html`<${Empty} title="Nothing to show here yet" />`}</div>
    </div>`;
  } else if (stop.kind === 'report') {
    // The report on an item that shows live facts (./board-shared.js deckOf): the part, the item and who presents it
    // along the top, the report filling the rest (its motion is the decision's slide, after all the item shows)
    const slides = slidesOfItem(item);
    const shownPage = Math.min(stop.page || 0, slides.length - 1);
    const chunk = slides[shownPage] || item.report;
    // (partway into one of its headings' parts: that heading, "continued", over it)
    const cont = slideHeadsOfItem(item)[shownPage] || '';
    const look = lookOfItem(item);
    stage = html`<div class=${`bs-item bs-item--report ${asPoints(look) ? 'bs-item--points' : ''}`}>
      <div class="bs-item__bar"><div><p class="bs-eyebrow">${where}${slides.length > 1 ? html`<span class="bs-eyebrow__of">Report, ${(stop.page || 0) + 1} of ${slides.length}</span>` : null}</p><${Title} text=${itemTitle} cls="bs-item__title" /></div></div>
      <${ReportBody} report=${chunk} look=${look} more=${shownPage < slides.length - 1} part=${slides.length > 1} cont=${cont} />
      ${motionHere}
    </div>`;
  } else if (stop.kind === 'decision') {
    // The item's motion on a slide of its own, after all the item showed (./board-shared.js deckOf): the part, the
    // item and who presents it along the top, the motion as large as it fits under them, how the vote went once closed
    stage = html`<div class="bs-item bs-item--decision">
      <div class="bs-item__bar"><div><p class="bs-eyebrow">${where}</p><${Title} text=${itemTitle} cls="bs-item__title" /></div></div>
      <${ItemMotion} text=${motionText} mo=${recordedAs(motionText, v)} big />
    </div>`;
  } else if (stop.kind === 'item') {
    const faces = stop.n >= 0 ? facesOf(item) : '';
    const facts = faces ? null : liveSlide(item.live, numbers, id, data, meeting.date, chg);
    // Where it sits in its part, when the part has more than it ("1 of 5")
    const mates = stop.n >= 0 ? items.filter((x) => x.si === items[stop.n].si) : [];
    const of = mates.length > 1 ? `${mates.findIndex((x) => x.ii === items[stop.n].ii) + 1} of ${mates.length}` : '';
    const title = itemTitle;
    const head = html`<p class="bs-eyebrow">${where}${of ? html`<span class="bs-eyebrow__of">${of}</span>` : null}</p>
      <${Title} text=${title} cls="bs-item__title" />
      ${item.confidential ? html`<p class="bs-chip bs-chip--warn">Board only · please don’t share</p>` : null}`;
    // A report with something in it ("nothing new this time" is said calmly on the item's card instead); beside it
    // nothing else, its notes and its documents on the board page (the documents next in the deck). The documents
    // coming show only on a slide with no report and no notes on it (the slide holds one thing; under live facts, a row)
    const report = hasReport(item) ? item.report : '';
    const reportHere = report && !deck.some((s) => s.kind === 'report' && s.itemId === item.id && !s.page) ? report : '';
    // (its first slide, when it goes on to more: reportSlides)
    const firstSlides = reportHere ? slidesOfItem(item) : [];
    const calm = isNothingNew(item.report);
    const notes = reportHere ? '' : item.notes;
    const notesRow = notes ? html`<div class="bs-item__body"><${Points} text=${notes} /></div>` : null;
    // Under the money's tiles there's room for a row: each document small, its title beside it
    const coming = docs.length && !reportHere && !notes ? html`<div class="bs-coming"><p class="bs-eyebrow">${docs.length === 1 ? 'Its document' : 'Its documents'}${deck[at + 1]?.kind === 'report' ? ', after the report' : ', next'}</p><${Shelf} docs=${docs} pages=${pages} row=${!!facts && !faces} max=${item.notes && (item.live === 'minutes' || item.report) ? 2 : item.notes || item.live === 'minutes' ? 3 : 6} /></div>` : null;
    if (faces) {
      stage = html`<div class="bs-item bs-item--board bs-item--faces">
        <div class="bs-item__bar"><div>${head}</div>${faces === 'roll' ? html`<div class="bs-item__aside"><${RollCount} v=${v} started=${started} /></div>` : null}</div>
        <div class="bs-item__facts"><${FacesGrid} kind=${faces} v=${v} people=${people} started=${started} year=${Number(String(meeting.date).slice(0, 4))} /></div>
        ${notesRow}${motionHere}
      </div>`;
    // A report with a slide of its own next (deckOf's 'report' stop) isn't this slide's: the reveals keep the whole screen
    } else if (facts && (item.live === 'projects' || (item.live === 'reveals' && (!item.report || deck[at + 1]?.kind === 'report') && !coming))) {
      // The makeovers and the reveals: the item's name and who presents it along the top, the rest of the screen theirs
      stage = html`<div class="bs-item bs-item--board">
        <div class="bs-item__bar"><div>${head}</div></div>
        <div class="bs-item__facts">${facts}</div>
        ${notesRow}
      </div>`;
    } else if (facts) {
      // (its report is a slide of its own next, its motion the decision's after all it shows: deckOf)
      stage = html`<div class="bs-item bs-item--facts">
        <div class="bs-item__bar"><div>${head}</div></div>
        <div class="bs-item__facts">${facts}</div>
        ${notes || coming ? html`<div class="bs-item__body">${notes ? html`<${Points} text=${notes} />` : null}${coming}</div>` : null}
        ${calm ? html`<p class="bs-calm" dir="auto">${NOTHING_NEW}</p>` : null}
        ${motionHere}
      </div>`;
    } else if (reportHere) {
      // A report: the item and who presents it along the top, the report filling the rest (a motion beside a report is
      // the decision's slide, after the report); a short one is its points as cards (ReportBody)
      const first = firstSlides[0] || item.report;
      const look = lookOfItem(item);
      stage = html`<div class=${`bs-item bs-item--report ${asPoints(look) ? 'bs-item--points' : ''}`}>
        <div class="bs-item__bar"><div>${head}</div></div>
        <${ReportBody} report=${first} look=${look} more=${firstSlides.length > 1} part=${firstSlides.length > 1} />
        ${motionHere}
      </div>`;
    } else {
      // The item's card: its notes and documents beside it; "nothing new this time" said calmly under who presents it;
      // the motion across under them (approving the last minutes: the usual words, how it went once the vote closed)
      const side = notes || coming;
      // Nothing more to show: where it sits in its part, when the part has more than it
      const sec = stop.n >= 0 ? meeting.sections[items[stop.n].si] : null;
      const part = !side && !motionHere && sec?.items.length > 1 ? html`<${PartList} sec=${sec} items=${items} current=${item} people=${people} />` : null;
      const calmLine = calm ? html`<p class="bs-calm" dir="auto">${NOTHING_NEW}</p>` : null;
      // Nothing beside it: a card like a part's, its number large (the part's, alone in it; else the item's own), the
      // part's name and time over its title, who presents it under (TitleCard)
      const big = stop.n < 0 ? '' : sec?.items.length > 1 ? items[stop.n].label : String(items[stop.n].si + 1).padStart(2, '0');
      const over = [section && section !== title ? section : stop.n < 0 ? 'After the agenda' : '', partWhen(sec ? plan.get(sec.id) : null)].filter(Boolean).join(' · ');
      stage = side || part ? html`<div class="bs-item bs-item--split">
        <div class="bs-item__lead">${head}${calmLine}</div>
        ${side ? html`<div class="bs-item__side">${notes ? html`<${Points} text=${notes} />` : null}${coming}</div>` : html`<div class="bs-item__side">${part}</div>`}
        ${motionHere}
      </div>` : html`<${TitleCard} big=${big} over=${over} title=${title} confidential=${!!item.confidential} calm=${calmLine} motion=${motionHere} fits=${[title, over, motionText, calm].join('|')} />`;
    }
  } else {
    stage = html`<${DocPage} f=${file} sheets=${stop.sheets || [[stop.page, stop.part || 0]]} box=${box} onPages=${notePages} key=${file?.id} />`;
  }
  // The pages that are stops (a blank one isn't), counted to the last of them: a blank page at the end isn't "of 2"
  const shownPages = stop.kind === 'doc' ? Array.from({ length: pages[stop.fileId] || 0 }, (_, i) => i).filter((i) => shows[stop.fileId]?.[i] !== 0) : [];
  const ofPages = shownPages.length ? shownPages.at(-1) + 1 : pages[stop.fileId] || 0;
  // Its name (not again when the item has the same one), and its pages or slide on ("Pages 1–2 of 3")
  const named = docTitle(file?.name);
  const pageWord = pageWordOf(file);
  const docName = named.toLowerCase() === String(item?.title || '').trim().toLowerCase() ? '' : named;
  const onPages = stop.pages || [stop.page];
  const pageWords = [ofPages > 1 ? `${pageWord.charAt(0).toUpperCase()}${pagesText(onPages, pageWord).slice(1)} of ${ofPages}` : '', stop.part ? 'continued' : ''].filter(Boolean).join(', ');
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
      <span class="bs-foot__what">${label ? html`<b>${label}</b>` : null}<span class="bs-foot__item">${itemTitle}</span>${docWords ? html`<span class="bs-foot__sep">·</span>${docWords}` : null}</span>
      ${shownPages.length > 1 && shownPages.length <= 12 ? html`<span class="bs-foot__pages" aria-hidden="true">${shownPages.map((i) => html`<i class=${onPages.includes(i) ? 'is-on' : ''} key=${i}></i>`)}</span>` : null}`
      : stop.kind === 'books' || stop.kind === 'live' || stop.kind === 'report' || stop.kind === 'decision' ? html`<span class="bs-foot__what">${label ? html`<b>${label}</b>` : null}${itemTitle}<span class="bs-foot__sep">·</span>${stop.kind === 'books' ? booksTitle(stop) : stop.kind === 'report' ? (stop.of > 1 ? `Report, ${(stop.page || 0) + 1} of ${stop.of}` : 'Report') : stop.kind === 'decision' ? 'The decision' : LIVE_TITLES[stop.fileId.slice(5)]}</span>`
      : PRESENT ? html`<span class="bs-foot__what bs-foot__keys"><kbd>←</kbd> <kbd>→</kbd> or a clicker to move<span class="bs-foot__sep">·</span><kbd>⇧</kbd><kbd>→</kbd> the next item<span class="bs-foot__sep">·</span><kbd>B</kbd> blanks the screen<span class="bs-foot__sep">·</span><kbd>C</kbd> the money’s changes in % or $<span class="bs-foot__sep">·</span><kbd>F</kbd> full screen</span>`
      : !started && !told && !MIRROR && !OWN ? html`<span class="bs-foot__what">The screen follows the meeting once the chair starts it.</span>` : null}
      ${ctl}
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
  // On the screen's one measure, worked out again as the window changes (a 4K TV's covers twice a 1080p one's, a
  // window moved to the TV and filled grows them): a row's small beside their titles, one document bigger, and the
  // fewer there are, the wider each one's title
  const unit = Math.min(innerHeight * 0.0148, innerWidth * 0.0083);
  const w = Math.round(row ? Math.max(34, unit * 4) : Math.max(84, unit * (docs.length === 1 ? 12 : 10)));
  const wide = row ? '' : `;--each:${[2.4, 1.75, 1.35][Math.min(docs.length, 3) - 1]}`;
  const shown = docs.slice(0, docs.length > max ? max - 1 : max);
  return html`<ul class=${`bs-shelf ${row ? 'bs-shelf--row' : ''}`} style=${`--cover:${w}px${wide}`}>${shown.map((d) => html`<${ShelfDoc} d=${d} width=${w} pages=${pages[d.file.id]} key=${d.key} />`)}${docs.length > shown.length ? html`<li class="bs-shelf__more">and ${docs.length - shown.length} more</li>` : null}</ul>`;
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
    <span class="bs-shelf__m">${[formatOf(d.file), n && !['image', 'other'].includes(docKind(d.file)) ? plural(n, pageWordOf(d.file)) : ''].filter(Boolean).join(' · ')}</span></span>
  </li>`;
}

/**
 * On a board member's own page while the meeting is live: the page the screen is showing, small, and a way to
 * follow the screen full size. Nothing while no document is up.
 */
export function ScreenPeek({ v, onOpen }) {
  const f = v.live.fileId ? (v.files || []).concat((v.prior || []).flatMap((x) => x.files)).find((x) => x.id === v.live.fileId) : null;
  const ref = useRef(null);
  const [n, setN] = useState({ count: 0, on: [] });
  useEffect(() => {
    if (!f || !ref.current) return undefined;
    let gone = false;
    const w = Math.min(560, ref.current.parentElement?.clientWidth || 320);
    // The spread the screen has up: its pages paired the way the screen pairs them
    partsOf(f).then((ns) => {
      const all = spreadsOf(ns.length, (p) => ns[p] ?? 1);
      const sp = all.find((x) => x.some(([p, k]) => p === v.live.page && k === (v.live.part || 0))) || all.find((x) => x.some(([p]) => p === v.live.page)) || [[v.live.page, 0]];
      return drawSpread(f, sp, { w, h: Math.round(w * 0.62) }).then(({ el }) => {
        if (gone || !ref.current) return;
        // (counted to its last page with anything on it, as the screen counts: a blank last page isn't "of 4")
        setN({ count: all.at(-1).at(-1)[0] + 1, on: [...new Set(sp.map(([p]) => p))] });
        ref.current.replaceChildren(el);
      });
    }).catch(() => {});
    return () => { gone = true; };
  }, [f?.id, v.live.page, v.live.part]);
  if (!f) return null;
  return html`<figure class="bp-peek">
    <div class="bp-peek__page" ref=${ref}></div>
    <figcaption><span><strong>On the screen:</strong> ${[docTitle(f.name), n.count > 1 && n.on.length ? `${pagesText(n.on, pageWordOf(f))} of ${n.count}` : ''].filter(Boolean).join(', ')}</span>
      <a class="bp-btn bp-btn--sm" href=${`#/meetings/${v.id}/screen`} onClick=${onOpen}>Follow the screen</a></figcaption>
  </figure>`;
}
