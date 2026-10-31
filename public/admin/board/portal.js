/**
 * The board page (/admin/board/)
 * ==============================
 * The one place a SOARD board member goes for the board: the next meeting
 * (when, where, the video link, whether you're coming), every meeting's
 * agenda, notes, minutes, votes and files, where each makeover stands, the
 * money, who's who, and the documents to read and sign each year. Search
 * (⌘K, or /) finds any meeting, agenda point, decision, file or person.
 *
 * Signed in with the same emailed code as staff; the server answers only
 * board members (People → Board, by their private email) and the Board
 * area's admins (who read it all and have nothing to answer or sign).
 *
 *   #/             Home: the next meeting, your to-dos, the major gifts, the makeovers
 *   #/meetings     Meetings          #/meetings/<id>   one meeting (each item with its documents)
 *   #/meetings/<id>/screen   the meeting on the room's TV or shared on Google Meet (./screen.js)
 *   #/financials   Financials (#/financials/gifts opens at the major gifts)   #/people   People
 *   #/documents    Documents, and every meeting's files
 *   (#/reveals, the old reveals page, is Home now)
 * On a phone the five pages are a bar along the bottom, in thumb's reach.
 *
 * Motion: pages change with the browser's view transitions (the yellow
 * marker slides to the new page, a meeting's date grows into its page and
 * back into its row); the first visit rises in. None of it runs for someone
 * whose device asks for less motion. No counting numbers, no shimmer.
 * Server: /api/board-portal (and /api/board-file for files).
 */

import { h, htm, render, useState, useEffect, useRef, useMemo } from '../vendor.js';
import { viewerLink, openViewer, sizeText } from '../file-viewer.js';
import {
  RSVP, DOC_KINDS, FILE_KINDS, meetingName, longDate, shortDate, timeRange, clock, money, plural, noteBlocks, liveLines, attendanceCounts, isDate, todayEastern, monthName, answerOf, fileTitle,
  isLive, agendaItems, tallyText, unzip, quorumFor, itemFiles, presentersOf, sectionPlan, sectionClock, clockText, formatOf, docTitle,
} from '../board-shared.js';
import { Screen, ScreenPeek } from './screen.js';
import { Kanban, sized } from './kanban.js';
import { useCashNow, useBudget, liveCash, compact, shortAsOf, pctOf, andText, moneyTiles, fromBooks, monthsText, paceText, growthText, mixOf, RevenueMix, spentOf } from './money.js';

const html = htm.bind(h);
const API = '/api/board-portal';
const LOGO = '/cdn-cgi/imagedelivery/ROYFuPmfN2vPS6mt5sCkZQ/brand-logo-admin/w=128';

// ─── Icons (24px line drawings, in the text's color) ────────────────
const ICONS = {
  home: html`<path d="M3.5 10.5 12 3.5l8.5 7V20a1 1 0 0 1-1 1H15v-6H9v6H4.5a1 1 0 0 1-1-1z" />`,
  meetings: html`<rect x="3.5" y="5" width="17" height="15.5" rx="2" /><path d="M3.5 10h17M8 3v4M16 3v4" />`,
  financials: html`<path d="M4 20.5h16M7 17v-5M12 17V7M17 17v-8" />`,
  people: html`<circle cx="9" cy="8.5" r="3.25" /><path d="M3 20a6 6 0 0 1 12 0" /><circle cx="17" cy="9.5" r="2.5" /><path d="M16.5 14.6A4.8 4.8 0 0 1 21 19.5" />`,
  documents: html`<path d="M14 3.5H6.5a1 1 0 0 0-1 1v15a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V8z" /><path d="M14 3.5V8h4.5M9 12.5h6M9 16.5h6" />`,
  clock: html`<circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" />`,
  pin: html`<path d="M12 21s-6.5-5.8-6.5-10.5a6.5 6.5 0 0 1 13 0C18.5 15.2 12 21 12 21z" /><circle cx="12" cy="10.5" r="2.25" />`,
  video: html`<rect x="3" y="6.5" width="12.5" height="11" rx="2" /><path d="m15.5 10.5 5.5-3v9l-5.5-3" />`,
  check: html`<path d="m5 12.5 4.5 4.5L19 7.5" />`,
  search: html`<circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2" />`,
  arrow: html`<path d="M5 12h14M13 6l6 6-6 6" />`,
  back: html`<path d="M19 12H5M11 18l-6-6 6-6" />`,
  chevron: html`<path d="m6 9 6 6 6-6" />`,
  mail: html`<rect x="3.5" y="5.5" width="17" height="13" rx="2" /><path d="m4 7 8 6 8-6" />`,
  copy: html`<rect x="8.5" y="8.5" width="11" height="11" rx="2" /><path d="M15.5 8.5V6A1.5 1.5 0 0 0 14 4.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5" />`,
  calendar: html`<rect x="3.5" y="5" width="17" height="15.5" rx="2" /><path d="M3.5 10h17M8 3v4M16 3v4M12 13v5M9.5 15.5h5" />`,
  print: html`<path d="M7 9V3.5h10V9M7 17.5H5A1.5 1.5 0 0 1 3.5 16v-5A1.5 1.5 0 0 1 5 9.5h14a1.5 1.5 0 0 1 1.5 1.5v5a1.5 1.5 0 0 1-1.5 1.5h-2" /><rect x="7" y="14" width="10" height="6.5" rx="1" />`,
  close: html`<path d="M6 6l12 12M18 6 6 18" />`,
  logout: html`<path d="M14 4.5h4A1.5 1.5 0 0 1 19.5 6v12a1.5 1.5 0 0 1-1.5 1.5h-4M10 16l-4-4 4-4M6 12h9" />`,
  external: html`<path d="M14 4.5h5.5V10M19.5 4.5 11 13M17 14v4.5a1 1 0 0 1-1 1H5.5a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1H10" />`,
  gavel: html`<path d="m13.5 4.5 6 6M11 7l6 6M12.25 5.75l-4.5 4.5M17.75 11.25l-4.5 4.5M10 12l-6.5 6.5M3.5 20.5h9" />`,
  present: html`<rect x="3" y="4.5" width="18" height="12" rx="1.5" /><path d="M12 16.5v3.5M8 20.5h8M10 8.5v4.5l4-2.25z" />`,
  list: html`<path d="M9 6.5h11M9 12h11M9 17.5h11" /><circle cx="4.75" cy="6.5" r="1" /><circle cx="4.75" cy="12" r="1" /><circle cx="4.75" cy="17.5" r="1" />`,
};
const Icon = ({ name, size = 20, cls = '' }) => html`<svg class=${`bp-icon ${cls}`} width=${size} height=${size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`;

const NAV = [['', 'Home', 'home'], ['meetings', 'Meetings', 'meetings'], ['financials', 'Financials', 'financials'], ['people', 'People', 'people'], ['documents', 'Documents', 'documents']];
const PAGES = NAV.map(([p]) => p);

async function call(body) {
  let r;
  try {
    r = await fetch(API, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' });
  } catch {
    return { ok: false, error: 'No connection. Check your internet and try again.' };
  }
  let j = {};
  try { j = await r.json(); } catch { j = { ok: false, error: /cloudflareaccess/i.test(r.url || '') ? 'Your sign-in expired. Reload the page to sign in again.' : `Something went wrong (${r.status})` }; }
  if (!r.ok && j.ok !== false) j.ok = false;
  j.status = r.status;
  return j;
}
const readRoute = () => {
  const [page = '', id = null, sub = ''] = location.hash.replace(/^#\/?/, '').split('/').map((x) => decodeURIComponent(x));
  return { page: PAGES.includes(page) ? page : '', id: id || null, sub: page === 'meetings' && id && sub === 'screen' ? 'screen' : '' };
};

// ─── Words and dates ────────────────────────────────────────────────
const noon = (d) => Date.parse(`${d}T12:00:00Z`);
const dayOf = (d) => (isDate(d) ? new Date(noon(d)).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' }) : '');
const weekdayOf = (d) => (isDate(d) ? new Date(noon(d)).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }) : '');
const partsOf = (d) => { const t = new Date(noon(d)); return { mon: t.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' }), day: t.getUTCDate(), wk: t.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }), year: t.getUTCFullYear() }; };
const monthOf = (ym) => new Date(`${ym}-15T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const firstName = (n) => String(n || '').split(/\s+/)[0];
const together = (names) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0] || '');
const greeting = () => { const hr = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: 'America/New_York' }).format(new Date())); return hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening'; };
const kindLabel = (k) => FILE_KINDS.find((x) => x.id === k)?.label || 'Other';
const mapsHref = (s) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(s)}`;
const joinLabel = (url) => (/meet\.google\.com/.test(url) ? 'Join with Google Meet' : /teams\.(microsoft|live)/.test(url) ? 'Join with Microsoft Teams' : /zoom\.us/.test(url) ? 'Join with Zoom' : 'Join by video');
const videoOf = (m) => m.video || m.invite?.meet || '';
/** Who the board's answers go to: "Holly and Peter" */
const theTeam = (data) => together((data.admins || []).map(firstName)) || 'SOARD';
const WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve'];
const countWord = (n) => WORDS[n] || String(n);
const daysBetween = (a, b) => Math.round((noon(b) - noon(a)) / 86400000);
/** "Tomorrow", "In 8 days", "In 3 weeks" */
function inWords(date, today) {
  const n = daysBetween(today, date);
  if (n <= 0) return 'Today';
  if (n === 1) return 'Tomorrow';
  if (n < 14) return `In ${n} days`;
  if (n < 60) return `In ${Math.round(n / 7)} weeks`;
  return `In ${Math.round(n / 30.4)} months`;
}
const minutesOf = (t) => (/^\d{2}:\d{2}$/.test(String(t || '')) ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3)) : null);
/** On the meeting's day: 'before' it starts, 'now' (from ten minutes before), or 'after' */
function phaseOf(m) {
  const s = minutesOf(m.start);
  if (s == null) return null;
  const e = minutesOf(m.end) ?? s + 120;
  const p = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: 'numeric', hourCycle: 'h23', timeZone: 'America/New_York' }).formatToParts(new Date());
  const now = Number(p.find((x) => x.type === 'hour')?.value || 0) * 60 + Number(p.find((x) => x.type === 'minute')?.value || 0);
  return now < s - 10 ? 'before' : now <= e ? 'now' : 'after';
}
const initialsOf = (name) => { const w = String(name || '').split(/\s+/).filter(Boolean); return ((w[0]?.[0] || '') + (w.length > 1 ? w.at(-1)[0] : '')).toUpperCase() || '?'; };
const hueOf = (s) => [42, 28, 96, 152, 200, 18][[...String(s)].reduce((a, c) => a + c.charCodeAt(0), 0) % 6];
const norm = (s) => String(s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[’‘]/g, "'");
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// ─── Files ──────────────────────────────────────────────────────────
const fileUrl = (f) => `/api/board-file?id=${encodeURIComponent(f.id)}`;
// The viewer tells a PDF, picture or video by its type once the name it shows is a title without its extension
const EXT_TYPES = { pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic', mp4: 'video/mp4', mov: 'video/quicktime' };
/**
 * Files for the viewer: each by its clean title (saved under its own name), its first page in the strip once this
 * device has drawn it (pageKept)
 */
const asViewer = (files) => files.map((f) => ({
  name: f.name ? docTitle(f.name) : 'File', filename: f.name, type: f.type || EXT_TYPES[String(f.name || '').toLowerCase().split('.').pop()] || '', size: f.size, at: f.at, url: f.url || fileUrl(f),
  thumb: (f.id && (pageKept(f, 200) || pageKept(f, 48))) || undefined,
}));
const RANK = { PDF: 0, Word: 1, Slides: 2, Excel: 3, Photo: 4, File: 5 };
/** A file's title for reading (../board-shared.js docTitle) */
const titleOf = docTitle;
const PAST_ORDER = ['minutes', 'signed', 'agenda', 'packet', 'financials', 'other'];
const AHEAD_ORDER = ['agenda', 'packet', 'financials', 'minutes', 'signed', 'other'];
/**
 * Files as rows by kind. The same title in several formats (a PDF and its Excel copy) or saved twice is
 * one row, the PDF (else the newest) first: [{ kind, label, rows: [{ title, file, more: [{ file, label }] }] }]
 */
function fileRows(files, order = PAST_ORDER) {
  const groups = [];
  for (const f of files) {
    const kind = order.includes(f.kind) ? f.kind : 'other';
    let g = groups.find((x) => x.kind === kind);
    if (!g) groups.push(g = { kind, label: kindLabel(kind), rows: [] });
    const title = titleOf(f.name);
    let row = g.rows.find((r) => r.key === norm(title));
    if (!row) g.rows.push(row = { key: norm(title), title, all: [] });
    row.all.push(f);
  }
  for (const g of groups) {
    for (const r of g.rows) {
      r.all.sort((a, b) => RANK[formatOf(a)] - RANK[formatOf(b)] || String(b.at || '').localeCompare(String(a.at || '')));
      r.file = r.all[0];
      r.more = r.all.slice(1).map((f) => ({ file: f, label: formatOf(f) === formatOf(r.file) ? 'Another copy' : formatOf(f) }));
    }
  }
  return groups.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
}
// ─── First pages ────────────────────────────────────────────────────
// A PDF's first page, drawn in the browser by pdf.js (the file viewer's own, ../vendor-pdf.js) when its cover or
// icon scrolls into view, two at a time, and kept on this device so it's there at once next time. No pictures are
// stored anywhere else; Word and Excel files keep their drawn covers.
let pdfLib = null;
let pdfWorker = null;
const loadPdfLib = () => (pdfLib ||= import('../vendor-pdf.js').catch((e) => { pdfLib = null; throw e; }));
const pageKey = (f, w) => `bp-page:${f.id}:${f.size || 0}:${w}`;
const pageKept = (f, w) => { try { return localStorage.getItem(pageKey(f, w)) || ''; } catch { return ''; } };
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
  const task = pdfjsLib.getDocument({ url: fileUrl(f), worker: pdfWorker, disableAutoFetch: true, standardFontDataUrl: `${base}standard_fonts/`, wasmUrl: `${base}wasm/`, useWasm: false, enableXfa: false, isEvalSupported: false });
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
/** [ref, src]: the first page of a PDF (up to 8 MB) once its element has been on screen */
function useFirstPage(f, width) {
  const ref = useRef(null);
  const can = !!f?.id && formatOf(f) === 'PDF' && (f.size || 0) <= 8 * 1048576;
  const [src, setSrc] = useState(() => (can ? pageKept(f, width) : ''));
  useEffect(() => {
    if (!can || src || !ref.current || !('IntersectionObserver' in window)) return undefined;
    let live = true;
    const io = new IntersectionObserver((seen) => {
      if (!seen.some((e) => e.isIntersecting)) return;
      io.disconnect();
      drawSoon(() => firstPage(f, width)).then((data) => {
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
function FileBadge({ f }) {
  const [ref, src] = useFirstPage(f, 48);
  const fmt = formatOf(f);
  return html`<span class=${`bp-badge ${src ? 'has-page' : ''}`} data-format=${fmt} ref=${ref} aria-hidden="true">${src ? html`<img src=${src} alt="" />` : ({ PDF: 'PDF', Excel: 'XLS', Word: 'DOC', Slides: 'PPT', Photo: 'IMG' }[fmt] || 'FILE')}</span>`;
}

/** A set of files, by kind, each opening in the viewer (the PDFs step through with ← →) */
function FileList({ files, order, labels = true, kinds = false }) {
  const sorted = fileRows(files, order);
  // Without headings the kinds run together as one list
  const groups = labels || sorted.length < 2 ? sorted : [{ kind: 'all', label: '', rows: sorted.flatMap((g) => g.rows) }];
  const primary = groups.flatMap((g) => g.rows.map((r) => r.file));
  const vf = asViewer(primary);
  return html`<div class="bp-files">${groups.map((g) => html`<div class="bp-files__group" key=${g.kind}>
    ${labels && groups.length > 1 ? html`<h3 class="bp-files__label">${g.label}</h3>` : null}
    <ul class="bp-files__list">${g.rows.map((r) => html`<li class="bp-file" key=${r.key}>
      <a class="bp-file__main" ...${viewerLink(vf, primary.indexOf(r.file))}>
        <${FileBadge} f=${r.file} />
        <span class="bp-file__text"><span class="bp-file__title">${r.title}</span><span class="bp-file__meta">${[kinds ? kindLabel(r.file.kind) : '', formatOf(r.file), sizeText(r.file.size)].filter(Boolean).join(' · ')}</span></span>
      </a>
      ${r.more.length ? html`<span class="bp-file__more">${r.more.map((x) => html`<a ...${viewerLink(asViewer([x.file]), 0)}>${x.label}</a>`)}</span>` : null}
    </li>`)}</ul>
  </div>`)}</div>`;
}

// ─── Motion ─────────────────────────────────────────────────────────
// A page change runs inside a view transition: the old page fades, the new one rises (or slides, going into
// a meeting and back out), the nav's marker slides, and a meeting's date tile grows into its page
const tick = () => new Promise((r) => setTimeout(r, 0));
function transition(update, { kind = 'tab', morphTo = null } = {}) {
  if (!document.startViewTransition || reduceMotion() || document.visibilityState !== 'visible') { update(); return; }
  const root = document.documentElement;
  root.dataset.vt = kind;
  const t = document.startViewTransition(async () => {
    update();
    await tick();
    for (const el of document.querySelectorAll('[data-mid]')) el.style.viewTransitionName = '';
    const to = morphTo && document.querySelector(`.bp-date[data-mid="${CSS.escape(morphTo)}"]`);
    if (to && to.getBoundingClientRect().bottom > 0 && to.getBoundingClientRect().top < innerHeight) to.style.viewTransitionName = 'bp-morph';
  });
  // A transition that hasn't finished in 1.5s (a browser that stopped drawing frames) is skipped, never left holding the page.
  // Skipped ones (that, or a quicker next tap) reject `ready`; the page has already changed, so that's no error
  const guard = setTimeout(() => t.skipTransition(), 1500);
  t.ready.catch(() => {});
  t.finished.finally(() => { clearTimeout(guard); delete root.dataset.vt; for (const el of document.querySelectorAll('[data-mid]')) el.style.viewTransitionName = ''; });
}
/** Before opening a meeting: its date tile is the one that grows into the page */
function claimMorph(e) {
  if (!document.startViewTransition || reduceMotion()) return;
  for (const el of document.querySelectorAll('[data-mid]')) el.style.viewTransitionName = '';
  const el = e.currentTarget;
  const tile = el.querySelector('.bp-date[data-mid]') || el.closest('.bp-card')?.querySelector('.bp-date[data-mid]');
  if (tile) tile.style.viewTransitionName = 'bp-morph';
}
// What to bring into view once a page opens (a search hit inside a meeting, a person)
let focusNext = null;
function useFocusTarget() {
  useEffect(() => {
    if (!focusNext) return;
    const id = focusNext;
    focusNext = null;
    requestAnimationFrame(() => {
      const el = document.getElementById(id);
      if (!el) return;
      el.scrollIntoView({ block: 'center', behavior: reduceMotion() ? 'auto' : 'smooth' });
      el.classList.remove('is-found');
      void el.offsetWidth;
      el.classList.add('is-found');
    });
  });
}

// ─── Google Calendar link (the .ics comes from the server) ──────────
/** An Atlanta wall-clock time as UTC "20261119T130000Z" */
function utcStamp(date, time) {
  const guess = new Date(`${date}T${time}:00Z`);
  const off = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'shortOffset' }).formatToParts(guess).find((p) => p.type === 'timeZoneName')?.value || 'GMT-5';
  const [, sign, hh, mm] = off.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/) || [null, '-', '5', '0'];
  const minutes = (Number(hh) * 60 + Number(mm || 0)) * (sign === '-' ? -1 : 1);
  return new Date(guess.getTime() - minutes * 60000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}
function googleHref(m) {
  const start = m.start || '08:00';
  const end = m.end || `${String(Math.min(23, Number(start.slice(0, 2)) + 2)).padStart(2, '0')}${start.slice(2)}`;
  const details = `The agenda and documents: ${location.origin}/admin/board/#/meetings/${m.id}${videoOf(m) ? `\nVideo: ${videoOf(m)}` : ''}`;
  return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(`SOARD ${meetingName(m)}`)}&dates=${utcStamp(m.date, start)}/${utcStamp(m.date, end)}&details=${encodeURIComponent(details)}&location=${encodeURIComponent([m.location, m.address].filter(Boolean).join(', '))}`;
}

// ─── What every page draws from ─────────────────────────────────────
function derive(data) {
  const people = [...data.people.board.map((p) => ({ ...p, group: 'board' })), ...data.people.staff.map((p) => ({ ...p, group: 'staff' })), ...data.people.advisory.map((p) => ({ ...p, group: 'advisory' }))];
  const bySlug = new Map(people.map((p) => [p.slug, p]));
  const byDate = [...data.meetings].filter((m) => isDate(m.date)).sort((a, b) => a.date.localeCompare(b.date));
  const next = data.meetings.find((m) => m.id === data.next) || null;
  // A meeting already on the board's calendars whose agenda isn't posted yet: its when and where only
  const pending = data.nextPending && isDate(data.nextPending.date) && data.nextPending.date >= data.today ? { ...data.nextPending, pending: true, files: [], sections: [], attendance: [], motions: [], actions: [] } : null;
  const featured = pending && (!next || pending.date < next.date) ? pending : next;
  const past = byDate.filter((m) => m.date < data.today).reverse();
  return { people, bySlug, byDate, featured, past, last: past[0] || null, me: bySlug.get(data.me.slug) || null };
}

// ─── The page ───────────────────────────────────────────────────────
function App() {
  const [data, setData] = useState(null);
  const [fail, setFail] = useState(null);
  const [route, setRoute] = useState(readRoute);
  const [note, setNote] = useState(null);
  const [finding, setFinding] = useState(false);
  const load = async () => {
    const j = await call();
    if (j.ok) { setData(j); setFail(null); } else setFail(j);
  };
  useEffect(() => {
    load();
    // Back to a tab left open: what changed meanwhile (an RSVP count, a new file), quietly
    let at = Date.now();
    const back = () => { if (document.visibilityState === 'visible' && Date.now() - at > 5 * 60 * 1000) { at = Date.now(); call().then((j) => { if (j.ok) setData(j); }); } };
    document.addEventListener('visibilitychange', back);
    return () => document.removeEventListener('visibilitychange', back);
  }, []);
  useEffect(() => {
    // The old Reveals page is part of Home now
    const legacy = () => { if (/^#\/?reveals/.test(location.hash)) history.replaceState(null, '', '#/'); };
    legacy();
    let was = readRoute();
    const scrolls = {};
    const on = () => {
      legacy();
      const now = readRoute();
      scrolls[`${was.page}/${was.id || ''}`] = scrollY;
      const kind = now.page === was.page && now.id && !was.id ? 'deeper' : now.page === was.page && !now.id && was.id ? 'back' : 'tab';
      const morphTo = kind === 'back' ? was.id : null;
      was = now;
      const y = kind === 'back' ? scrolls[`${now.page}/`] || 0 : 0;
      transition(() => { setRoute(now); scrollTo(0, y); }, { kind, morphTo });
    };
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  useEffect(() => {
    const keys = (e) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target?.tagName || '') || e.target?.isContentEditable;
      if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey)) { e.preventDefault(); setFinding(true); }
    };
    const scrolled = () => document.documentElement.classList.toggle('is-scrolled', scrollY > 4);
    scrolled();
    addEventListener('keydown', keys);
    addEventListener('scroll', scrolled, { passive: true });
    return () => { removeEventListener('keydown', keys); removeEventListener('scroll', scrolled); };
  }, []);
  useEffect(() => { if (note) { const t = setTimeout(() => setNote(null), 4500); return () => clearTimeout(t); } return undefined; }, [note]);
  useEffect(() => {
    if (route.sub === 'screen') return;
    const m = route.page === 'meetings' && route.id && data && [...data.meetings, data.nextPending].find((x) => x?.id === route.id);
    document.title = m ? `${meetingName(m)} · SOARD Board` : `${NAV.find(([p]) => p === route.page)?.[1] || 'Home'} · SOARD Board`;
  }, [route, data]);
  // The first visit rises in; later pages arrive by transition
  useEffect(() => {
    if (!data) return undefined;
    const root = document.documentElement;
    if (reduceMotion()) return undefined;
    root.classList.add('is-entering');
    const t = setTimeout(() => root.classList.remove('is-entering'), 1400);
    return () => clearTimeout(t);
  }, [!!data]);
  const d = useMemo(() => (data ? derive(data) : null), [data]);

  if (fail) {
    const staff = fail.status === 403 && /team or board list|board page is for/i.test(fail.error || '');
    return html`<div class="bp-fail" role="alert">
      <img src=${LOGO} alt="" width="64" height="64" />
      <h1>${fail.status === 403 ? 'This page is for SOARD’s board' : 'The board page didn’t open'}</h1>
      <p>${fail.status === 403
        ? 'It opens for the email address SOARD has on file for each board member. If that should be you, reply to any board email and we’ll check the address we have.'
        : fail.error}</p>
      <p class="bp-btns bp-btns--center">${staff ? html`<a class="bp-btn bp-btn--primary" href="/admin/">Go to the admin</a>` : null}<button type="button" class="bp-btn" onClick=${load}>Try again</button><a class="bp-btn bp-btn--quiet" href="/cdn-cgi/access/logout">Sign out</a></p>
    </div>`;
  }
  if (!data) return html`<div class="bp-boot"><img src=${LOGO} alt="" width="56" height="56" /><p>Opening the board page…</p></div>`;
  const say = (text, tone = '') => setNote({ text, tone, at: Date.now() });
  const ctx = { data, d, setData, load, say, find: () => setFinding(true) };
  // The meeting on the screen fills the window: no header, tabs or footer
  if (route.sub === 'screen') return html`<${Screen} id=${route.id} data=${data} d=${d} key=${route.id} />`;
  const page = route.page === 'meetings' && route.id ? html`<${MeetingPage} id=${route.id} ctx=${ctx} key=${route.id} />`
    : route.page === 'meetings' ? html`<${MeetingsPage} ctx=${ctx} />`
    : route.page === 'financials' ? html`<${FinancialsPage} ctx=${ctx} />`
    : route.page === 'people' ? html`<${PeoplePage} ctx=${ctx} />`
    : route.page === 'documents' ? html`<${DocumentsPage} ctx=${ctx} />`
    : html`<${HomePage} ctx=${ctx} />`;
  return html`
    <a class="bp-skip" href="#main" onClick=${(e) => { e.preventDefault(); document.getElementById('main')?.focus(); }}>Skip to the page</a>
    <header class="bp-top">
      <div class="bp-bar">
        <a class="bp-brand" href="#/"><img src=${LOGO} alt="SOARD board home" width="44" height="44" /><span class="bp-brand__words"><strong>Sunshine on a Ranney Day</strong> <small>Board of Directors</small></span></a>
        <${Nav} page=${route.page} />
        <div class="bp-tools">
          <button type="button" class="bp-find" onClick=${() => setFinding(true)} aria-keyshortcuts="Meta+K Control+K /">
            <${Icon} name="search" size=${18} /><span class="bp-find__label">Search</span><kbd class="bp-kbd" aria-hidden="true">${/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl K'}</kbd>
          </button>
          <${Account} data=${data} d=${d} />
        </div>
      </div>
    </header>
    <main class="bp-main" id="main" tabindex="-1">${page}</main>
    <footer class="bp-foot">
      <div class="bp-foot__in">
        ${data.contact ? html`<p>Questions about a meeting or this page? <a href=${`mailto:${data.contact.email}`}>Email ${firstName(data.contact.name)}</a></p>` : html`<p>Sunshine on a Ranney Day · Board of Directors</p>`}
        <p class="bp-muted">${data.me.email ? `Signed in as ${data.me.email} · ` : ''}<a href="/cdn-cgi/access/logout">Sign out</a></p>
      </div>
    </footer>
    <div class=${`bp-toast ${note ? 'is-on' : ''} ${note?.tone ? `bp-toast--${note.tone}` : ''}`} role="status" aria-live="polite">${note ? html`<${Icon} name="check" size=${18} /><span>${note.text}</span>` : null}</div>
    ${finding ? html`<${Finder} ctx=${ctx} onClose=${() => setFinding(false)} />` : null}`;
}

/**
 * The five pages. The yellow marker is one element that slides behind the labels to the open page (a CSS move).
 * It's never part of the page's view transition: as its own layer there it was drawn over the labels while it moved.
 */
function Nav({ page }) {
  const ref = useRef(null);
  const [ink, setInk] = useState(null);
  useEffect(() => {
    const place = () => {
      const a = ref.current?.querySelector('a[aria-current="page"]');
      if (a) setInk((was) => ({ x: a.offsetLeft, y: a.offsetTop, w: a.offsetWidth, h: a.offsetHeight, moving: !!was }));
    };
    place();
    document.fonts?.ready.then(place);
    addEventListener('resize', place);
    return () => removeEventListener('resize', place);
  }, [page]);
  return html`<nav class="bp-nav" aria-label="Board" ref=${ref}>
    ${ink ? html`<span class=${`bp-nav__ink ${ink.moving ? 'is-moving' : ''}`} style=${`--x:${ink.x}px;--y:${ink.y}px;--w:${ink.w}px;--h:${ink.h}px`} aria-hidden="true"></span>` : null}
    ${NAV.map(([p, label, icon]) => html`<a href=${`#/${p}`} aria-current=${page === p ? 'page' : null} key=${p}>
      <${Icon} name=${icon} size=${20} /><span class="bp-nav__label">${label}</span>
    </a>`)}
  </nav>`;
}

/** Who's signed in, and the way out */
// The founders have no seat on People → Board: their name comes from the sign-in, asked once
let whoOnce = null;
function useAdminWho(data) {
  const [who, setWho] = useState(null);
  useEffect(() => {
    if (!data.me.admin) return undefined;
    let on = true;
    whoOnce ||= fetch('/cdn-cgi/access/get-identity').then((r) => (r.ok ? r.json() : null)).then((j) => {
      const email = String(j?.email || '');
      const first = (String(j?.name || '').trim().split(/\s+/)[0] || email.split('@')[0].split(/[._-]/)[0] || '');
      return email ? { email, name: first ? first[0].toUpperCase() + first.slice(1) : email } : null;
    }).catch(() => null);
    whoOnce.then((w) => { if (on) setWho(w); });
    return () => { on = false; };
  }, []);
  return who;
}

function Account({ data, d }) {
  const [open, setOpen] = useState(false);
  const who = useAdminWho(data);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') { setOpen(false); ref.current?.querySelector('button')?.focus(); } };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  const name = data.me.name || who?.name || 'Admin';
  const email = data.me.email || who?.email || '';
  return html`<div class="bp-me" ref=${ref}>
    <button type="button" class="bp-me__btn" aria-expanded=${open} aria-haspopup="true" aria-label=${`${firstName(name)}, your account`} onClick=${() => setOpen(!open)}>
      ${d.me ? html`<${Avatar} p=${d.me} size=${36} />` : html`<span class="bp-avatar bp-avatar--initials" style="--s:36px;--hue:42" data-i=${initialsOf(name)} aria-hidden="true"></span>`}
      <span class="bp-me__name">${firstName(name)}</span>
    </button>
    <div class=${`bp-menu ${open ? 'is-open' : ''}`} role="menu" hidden=${!open}>
      <div class="bp-menu__who"><strong>${name}</strong>${email ? html`<span>${email}</span>` : data.me.title ? html`<span>${data.me.title}</span>` : null}</div>
      ${data.me.admin ? html`<a role="menuitem" href="/admin/#board"><${Icon} name="back" size=${18} />Back to the Board area</a>` : null}
      <a role="menuitem" href="/cdn-cgi/access/logout"><${Icon} name="logout" size=${18} />Sign out</a>
    </div>
  </div>`;
}

// ─── Shared pieces ──────────────────────────────────────────────────
function Avatar({ p, size = 40, ring = false }) {
  const [broken, setBroken] = useState('');
  const name = p?.name || '';
  const style = `--s:${size}px`;
  return p?.photo && broken !== p.photo
    ? html`<img class=${`bp-avatar ${ring ? 'bp-avatar--ring' : ''}`} src=${p.photo} alt="" loading="lazy" decoding="async" width=${size} height=${size} style=${style} onError=${() => setBroken(p.photo)} />`
    : html`<span class=${`bp-avatar bp-avatar--initials ${ring ? 'bp-avatar--ring' : ''}`} style=${`${style};--hue:${hueOf(name)}`} data-i=${initialsOf(name)} aria-hidden="true"></span>`;
}
function Faces({ people, max = 6, size = 32 }) {
  const shown = people.slice(0, max);
  const more = people.length - shown.length;
  return html`<span class="bp-faces" style=${`--s:${size}px`}>${shown.map((p) => html`<${Avatar} p=${p} size=${size} ring key=${p.slug || p.name} />`)}${more > 0 ? html`<span class="bp-faces__more">+${more}</span>` : null}</span>`;
}
function DateTile({ d, mid = null, big = false, head = false }) {
  if (!isDate(d)) return null;
  const p = partsOf(d);
  return html`<span class=${`bp-date ${big ? 'bp-date--big' : ''}`} data-mid=${mid} style=${head ? 'view-transition-name: bp-morph' : null} aria-hidden="true">
    <span class="bp-date__mon">${p.mon}</span><strong class="bp-date__day">${p.day}</strong>${big ? html`<span class="bp-date__wk">${p.wk}</span>` : null}
  </span>`;
}
/** Where a reveal's window starts ({ part: 'mid', month: '2026-11' } → "2026-11-11"), for putting it in order */
const windowStart = (w) => (/^\d{4}-\d{2}$/.test(String(w?.month || '')) ? `${w.month}-${{ early: '01', mid: '11', late: '21' }[w.part] || '01'}` : '');
/** A reveal whose day isn't set: "mid" November */
function WindowTile({ w }) {
  const start = windowStart(w);
  return html`<span class="bp-date bp-date--soft" aria-hidden="true"><span class="bp-date__mon">${start ? partsOf(start).mon : ''}</span><strong class="bp-date__day bp-date__day--word">${w?.part || '·'}</strong></span>`;
}
const MinutesChip = ({ m }) => (m.minutes === 'approved' ? html`<span class="bp-chip bp-chip--ok"><${Icon} name="check" size=${14} />Minutes approved</span>` : html`<span class="bp-chip">Draft minutes</span>`);
function SecHead({ title, sub = '', count = null, id, children }) {
  return html`<div class="bp-sechead">
    <div><h2 class="bp-h2" id=${id}>${title}${count != null ? html`<span class="bp-count">${count}</span>` : null}</h2>${sub ? html`<p class="bp-sub">${sub}</p>` : null}</div>
    ${children || null}
  </div>`;
}
const rise = (i) => `--i:${i}`;


// The cash and the year against its budget: ./money.js


// ─── Home ───────────────────────────────────────────────────────────
/**
 * Home is a board brief, each fact once: SOARD at a glance (the four figures, where the revenue came from, Impact: one panel), the next
 * meeting beside the last one, the major gifts, then the makeovers. Every figure is a door to the page with the rest of it
 */

/** A figure against its budget as a bar: filled to this year's share, the tick at last year's by now (the words say both) */
function Meter({ x }) {
  // Its place kept while the budget is read, so nothing moves when it fills
  if (x.waiting) return html`<span class="bp-fig__meter" aria-hidden="true"></span>`;
  const p = pctOf(x);
  if (p == null) return null;
  const pace = x.last != null && x.lastFull > 0 ? Math.round((x.last / x.lastFull) * 100) : null;
  return html`<span class=${`bp-fig__meter ${p > 100 ? 'is-over' : ''}`} style=${`--p:${Math.min(100, p)}%${pace != null ? `;--pace:${Math.min(100, pace)}%` : ''}`} aria-hidden="true"><i></i>${pace != null ? html`<b></b>` : null}</span>`;
}

/** Four numbers a board member wants first: the money against its budget, and the makeovers */
function Figures({ data }) {
  const cash = useCashNow(data);
  const budget = useBudget(data);
  const n = data.numbers;
  const building = n.projects?.building || [];
  const inBuild = building.filter((b) => b.status === 'Build').length;
  const next = [...n.reveals].sort((a, b) => String(a.confirmed && a.date ? a.date : windowStart(a.window) || '9').localeCompare(String(b.confirmed && b.date ? b.date : windowStart(b.window) || '9')))[0];
  const nextWhen = next ? (next.confirmed && next.date ? shortDate(next.date).replace(/, \d{4}$/, '') : next.window?.label || '') : '';
  // While the budget sheet is read, QuickBooks' year so far shows at once, its bar waiting for the budget: the
  // figures never change from three to four once the sheet arrives
  const books = budget === undefined && typeof n.books?.revenue === 'number' ? n.books : null;
  const waiting = (actual) => ({ actual, budget: null, waiting: true });
  const rev = budget?.revenue || (books ? waiting(books.revenue) : null);
  // Expenses as the budget counts them, without in kind (./money.js spentOf), and saying what's left out
  const exp = budget?.expenses || (books && typeof books.expenses === 'number' ? { ...waiting(spentOf(books)), inKind: books.nonCash > 0 ? books.nonCash : 0 } : null);
  const yr = budget?.year || books?.year || '';
  // Against the budget once there is one for the year (QuickBooks' figures can come before the year's sheet: then
  // against last year's same days), and last year's pace by now on a line of its own
  const against = (x) => (x.waiting ? 'The year so far' : x.budget ? `${pctOf(x)}% of the ${compact(x.budget)} budget` : growthText(x) || `Through ${shortAsOf(budget.asOf)}`);
  // (a line kept for it while the budget is read)
  const pace = (x) => (x.waiting ? '\u00a0' : x.budget && x.last != null && x.lastFull > 0 ? `Last year by now: ${Math.round((x.last / x.lastFull) * 100)}%` : '');
  const tiles = [
    { key: 'cash', label: 'Cash in the bank', value: cash ? compact(cash.total) : cash === null ? '–' : '…', href: '#/financials',
      sub: cash ? (cash.months != null ? `${monthsText(cash.months)} months of spending` : cash.asOf ? `As of ${shortAsOf(cash.asOf)}` : '') : 'From the balance sheet',
      note: cash && cash.prior != null ? `${cash.total >= cash.prior ? '▲' : '▼'} ${compact(Math.abs(cash.total - cash.prior))} from a year ago` : '', tone: cash && cash.prior != null ? (cash.total >= cash.prior ? 'up' : 'down') : '' },
    rev ? { key: 'rev', label: `${yr} revenue`.trim(), value: compact(rev.actual), meter: rev, sub: against(rev), note: pace(rev), href: '#/financials' }
      : { key: 'reveals', label: 'Reveals ahead', value: String(n.reveals.length), sub: next ? `Next ${nextWhen || 'date to come'}` : 'None scheduled', href: '#makeovers' },
    exp ? { key: 'exp', label: `${yr} expenses`.trim(), value: compact(exp.actual), meter: exp, sub: against(exp), note: pace(exp), aside: exp.inKind ? `Not counting ${compact(exp.inKind)} in kind` : '', href: '#/financials' } : null,
    { key: 'build', label: 'Makeovers', value: String(building.length), sub: building.length ? `${inBuild} in build` : 'None right now', note: rev && nextWhen ? `Next reveal ${nextWhen}` : '', href: '#makeovers' },
  ].filter(Boolean);
  const go = (e, t) => {
    if (!t.href.startsWith('#') || t.href.startsWith('#/')) return;
    e.preventDefault();
    document.getElementById(t.href.slice(1))?.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' });
  };
  return html`<ul class=${`bp-figs ${tiles.length % 2 ? 'is-odd' : ''}`} style=${`--n:${tiles.length}`}>${tiles.map((t) => html`<li key=${t.key}>
    <a class="bp-fig" href=${t.href} onClick=${(e) => go(e, t)}>
      <span class="bp-fig__label">${t.label}</span>
      <span class="bp-fig__value">${t.value}</span>
      ${t.meter ? html`<${Meter} x=${t.meter} />` : null}
      <span class="bp-fig__sub">${t.sub}</span>
      ${t.note ? html`<span class=${`bp-fig__note ${t.tone ? `is-${t.tone}` : ''}`}>${t.note}</span>` : null}
      ${t.aside ? html`<span class="bp-fig__note">${t.aside}</span>` : null}
    </a>
  </li>`)}</ul>`;
}

/** The next meeting's agenda on Home: its headings, in order */
function AgendaPeek({ m }) {
  const sections = (m.sections || []).filter((x) => x.title);
  if (!sections.length) return null;
  return html`<ol class=${`bp-agpeek ${sections.length > 4 ? 'is-long' : ''}`}>${sections.map((x) => html`<li key=${x.id}>${x.title}</li>`)}</ol>`;
}

/** Since the last meeting: what it decided, and who was there */
function SinceLast({ ctx }) {
  const { data, d } = ctx;
  const m = d.last;
  if (!m) return null;
  const c = attendanceCounts(m);
  const decided = m.motions.filter((x) => x.text);
  return html`<section class="bp-card bp-since" aria-labelledby="since-h">
    <div class="bp-cardhead">
      <h2 class="bp-h2" id="since-h">Last meeting</h2>
      <a class="bp-cardhead__go" href=${`#/meetings/${m.id}`} onClick=${claimMorph}>${m.minutes === 'approved' ? 'The minutes' : 'The meeting'}<${Icon} name="arrow" size=${16} cls="bp-go" /></a>
    </div>
    <div class="bp-since__what"><${DateTile} d=${m.date} mid=${m.id} /><p><strong>${meetingName(m)}</strong><span>${c.boardHere ? `${c.boardHere} of ${c.board} board members${c.boardHere >= quorumFor(m, data.quorum) ? ', a quorum' : ', short of a quorum'}` : dayOf(m.date)}</span></p><${MinutesChip} m=${m} /></div>
    ${decided.length ? html`<h3 class="bp-mini-h">Decided</h3><ul class="bp-facts-list">${decided.map((x) => html`<li key=${x.id || x.text}><span>${x.text}</span><strong>${tallyText(x) || ({ passed: 'Passed', failed: 'Did not pass', tabled: 'Tabled' }[x.result] || '')}</strong></li>`)}</ul>` : null}
  </section>`;
}

/** What a year's bar says to a screen reader, as its readout does on hover or focus: "2019: 17 kids, 25 rooms, 16 makeovers" */
const yearSays = (y, thisYear, word) => `${y.year}${y.year === thisYear ? ' so far' : ''}: ${word('kids', y.kids)}, ${word('rooms', y.rooms)}, ${y.makeovers} ${y.makeovers === 1 ? 'makeover' : 'makeovers'}`;
/**
 * The readout over a year's bar, just above its top (`h`, the bar's height in %). It stays within the chart at
 * either end: the further right the bar, the further left the readout leans
 */
function YearTip({ y, at, h, thisYear, word }) {
  return html`<span class="bp-ytip" style=${`--x:${at * 100}%;--th:${h}`} aria-hidden="true"><strong>${y.year}${y.year === thisYear ? ' so far' : ''}</strong>${word('kids', y.kids)} · ${word('rooms', y.rooms)} · ${y.makeovers} ${y.makeovers === 1 ? 'makeover' : 'makeovers'}</span>`;
}
/**
 * Home's small chart: a bar a year, each saying its numbers on hover or focus (← → between them), the readout over
 * the chart's top so it never covers a neighbor; a tap opens that year
 */
function YearBars({ years, thisYear, word, height, onPick, label, hint, cls }) {
  const [tip, setTip] = useState(-1);
  const ref = useRef(null);
  const rest = tip >= 0 ? tip : years.length - 1;
  const onKey = (e) => {
    const next = { ArrowRight: rest + 1, ArrowLeft: rest - 1, Home: 0, End: years.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    ref.current?.querySelectorAll('button')[Math.max(0, Math.min(years.length - 1, next))]?.focus();
  };
  return html`<div class=${cls} role="group" aria-label=${label} ref=${ref} onKeyDown=${onKey} onMouseLeave=${() => setTip(-1)}>
    ${years.map((y, i) => html`<button type="button" key=${y.year} class=${`${y.year === thisYear ? 'is-now' : ''} ${i === tip ? 'is-tip' : ''}`} style=${`--h:${height(y)}%;--i:${i}`}
      tabindex=${i === rest ? 0 : -1} aria-label=${`${yearSays(y, thisYear, word)}. ${hint}`}
      onMouseEnter=${() => setTip(i)} onFocus=${() => setTip(i)} onBlur=${() => setTip(-1)} onClick=${() => onPick(i)}><i></i></button>`)}
    ${tip >= 0 ? html`<${YearTip} y=${years[tip]} at=${(tip + 0.5) / years.length} h=${100} thisYear=${thisYear} word=${word} />` : null}
  </div>`;
}

/**
 * Impact, as the admin's Dashboard has it, under the figures in the same panel: the kids served since the first
 * year, each year as a small bar, this year against last; "Explore by year" opens the full chart (kids served, or
 * rooms built) and any year's makeovers, each kid's photo opening their page. Counted exactly as the website
 * counts (published profiles; a sibling profile's every child; a missing room count as one room)
 */
function Impact({ n }) {
  const years = n.impact?.byYear || [];
  const [open, setOpen] = useState(false);
  const [what, setWhat] = useState('kids');
  const [sel, setSel] = useState(Math.max(0, years.length - 1));
  if (!years.length) return null;
  const thisYear = Number(String(n.at || new Date().toISOString()).slice(0, 4));
  const now = years.find((y) => y.year === thisYear);
  const last = years.find((y) => y.year === thisYear - 1);
  const word = (k, x) => `${x.toLocaleString()} ${k === 'kids' ? (x === 1 ? 'kid' : 'kids') : (x === 1 ? 'room' : 'rooms')}`;
  const sparkTop = Math.max(1, ...years.map((y) => y.kids));
  const toggle = () => setOpen((v) => !v);
  // A year's bar opens Explore by year on that year
  const pick = (i) => { setSel(i); setOpen(true); };
  return html`<section class=${`bp-impact ${open ? 'is-open' : ''}`} aria-labelledby="impact-h" id="impact">
    <div class="bp-impact__band">
      <div class="bp-impact__hero">
        <h2 class="bp-fig__label" id="impact-h">Impact since ${years[0].year}</h2>
        <p class="bp-impact__num">${n.impact.kids.toLocaleString()}<span>kids served</span></p>
        <button type="button" class="bp-impact__more" aria-expanded=${open} aria-controls="impact-years" onClick=${toggle}>${open ? 'Hide years' : 'Explore by year'}<${Icon} name="arrow" size=${16} cls="bp-go" /></button>
      </div>
      <div class="bp-spark">
        <${YearBars} years=${years} thisYear=${thisYear} word=${word} cls="bp-spark__bars" label=${`Kids served each year since ${years[0].year}`}
          height=${(y) => Math.max(4, (y.kids / sparkTop) * 100)} onPick=${pick} hint="Explore by year" />
        <span class="bp-spark__x" aria-hidden="true"><span>${years[0].year}</span><span>${years.at(-1).year}</span></span>
      </div>
      <dl class="bp-impact__stats">
        ${now ? html`<div><dt>${thisYear} so far</dt><dd>${word('kids', now.kids)} · ${word('rooms', now.rooms)}${last?.kids ? html`<span class=${now.kids >= last.kids ? 'is-up' : 'is-down'}>${now.kids >= last.kids ? '▲' : '▼'} ${Math.abs(Math.round(((now.kids - last.kids) / last.kids) * 100))}% ${now.kids >= last.kids ? 'more' : 'fewer'} kids than all of ${thisYear - 1}</span>` : null}</dd></div>` : null}
        <div><dt>Rooms built</dt><dd>${n.impact.rooms.toLocaleString()}</dd></div>
        <div><dt>Makeovers</dt><dd>${years.reduce((t, y) => t + y.makeovers, 0).toLocaleString()}</dd></div>
        ${n.impact.communityProjects ? html`<div><dt>Community projects</dt><dd>${n.impact.communityProjects.toLocaleString()}${n.impact.reached ? html`<span>${n.impact.reached.toLocaleString()} children reached</span>` : null}</dd></div>` : null}
      </dl>
    </div>
    ${open ? html`<${ImpactYears} years=${years} what=${what} setWhat=${setWhat} sel=${sel} setSel=${setSel} thisYear=${thisYear} word=${word} />` : null}
  </section>`;
}

/** Explore by year: a bar a year (pick one with a tap, or ← → once one has focus), and that year's makeovers */
function ImpactYears({ years, what, setWhat, sel, setSel, thisYear, word }) {
  const top = Math.max(1, ...years.map((y) => y[what]));
  const best = years.reduce((a, b) => (b[what] > a[what] ? b : a), years[0]);
  const y = years[sel] || years.at(-1);
  const onKey = (e) => {
    const next = { ArrowRight: sel + 1, ArrowLeft: sel - 1, Home: 0, End: years.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    const i = Math.max(0, Math.min(years.length - 1, next));
    setSel(i);
    requestAnimationFrame(() => document.getElementById(`bpy-${years[i].year}`)?.focus());
  };
  const kids = [...(y.profiles || [])].sort((a, b) => a.name.localeCompare(b.name));
  // The bar under the pointer or the focus says its year's numbers
  const [tip, setTip] = useState(-1);
  return html`<div class="bp-impact__open" id="impact-years">
    <div class="bp-impact__tools">
      <p class="bp-muted">${what === 'kids' ? 'Kids served' : 'Rooms built'} each year. Pick a year to see its makeovers.</p>
      <div class="bp-impact__seg" role="group" aria-label="Show each year’s">
        ${[['kids', 'Kids served'], ['rooms', 'Rooms built']].map(([id, label]) => html`<button type="button" aria-pressed=${what === id} onClick=${() => setWhat(id)} key=${id}>${label}</button>`)}
      </div>
    </div>
    <div class="bp-impact__explore">
      <div class="bp-years" role="group" aria-label=${`${what === 'kids' ? 'Kids served' : 'Rooms built'} each year since ${years[0].year}`} onKeyDown=${onKey}>
        <ol class="bp-years__bars" onMouseLeave=${() => setTip(-1)}>${years.map((x, i) => html`<li key=${x.year} class=${`${x.year === thisYear ? 'is-now' : ''} ${i === sel ? 'is-sel' : ''} ${i === tip ? 'is-tip' : ''}`} style=${`--h:${(x[what] / top) * 100}%;--i:${i}`}>
          <button type="button" id=${`bpy-${x.year}`} class="bp-years__hit" aria-pressed=${i === sel} tabindex=${i === sel ? 0 : -1} onClick=${() => setSel(i)}
            onMouseEnter=${() => setTip(i)} onFocus=${() => setTip(i)} onBlur=${() => setTip(-1)}
            aria-label=${yearSays(x, thisYear, word)}>
            <span class="bp-years__bar" aria-hidden="true"></span>
            ${x.year === thisYear || x === best || i === sel ? html`<span class="bp-years__val" aria-hidden="true">${x[what]}</span>` : null}
            <span class="bp-years__x" aria-hidden="true">${i === 0 || x.year === thisYear || i === sel || x.year % 2 === 0 ? `’${String(x.year).slice(2)}` : ''}</span>
          </button>
        </li>`)}</ol>
        ${tip >= 0 ? html`<${YearTip} y=${years[tip]} at=${(tip + 0.5) / years.length} h=${(years[tip][what] / top) * 100} thisYear=${thisYear} word=${word} />` : null}
      </div>
      <div class="bp-yearpanel" aria-live="polite" tabindex="0" aria-label=${`${y.year}’s makeovers`}>
        <p class="bp-yearpanel__head"><strong>${y.year}</strong><span>${word('kids', y.kids)} · ${word('rooms', y.rooms)} · ${y.makeovers} ${y.makeovers === 1 ? 'makeover' : 'makeovers'}${y.year === thisYear ? ' so far' : ''}</span></p>
        ${kids.length ? html`<ul class="bp-yearpanel__kids">${kids.map((k) => html`<li key=${k.slug || k.name}>
          <a href=${k.slug ? `/kids/${k.slug}/` : null} target="_blank" rel="noopener" class="bp-yk">
            ${k.photo ? html`<img src=${sized(k.photo, 'w=96,h=96,fit=cover,gravity=face')} alt="" loading="lazy" width="40" height="40" />` : html`<span class="bp-avatar bp-avatar--initials" style=${`--s:40px;--hue:${hueOf(k.name)}`} data-i=${initialsOf(k.name)} aria-hidden="true"></span>`}
            <span><strong>${k.name}</strong>${k[what] > 1 ? html`<small>${word(what, k[what])}</small>` : null}</span>
          </a>
        </li>`)}</ul>` : html`<p class="bp-muted">No makeovers this year.</p>`}
      </div>
    </div>
  </div>`;
}

/** Home's makeovers: the kanban (./kanban.js), from JobTread. The count is the figure above; each column has its own */
// ─── Major gifts, from Zeffy (functions/api/_board-gifts.js) ───
const giftDay = (s) => new Date(s * 1000).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' });
const giftWho = (g) => g.company || g.name || (g.anonymous ? 'Anonymous' : 'No name given');
// The person who gave for a company, the campaign, monthly (unless the campaign says so), in kind
const giftAbout = (g) => [g.company && g.name ? g.name : '', g.campaign, g.every && !String(g.campaign || '').toLowerCase().includes(g.every) ? g.every : '', g.inKind ? 'in kind' : ''].filter(Boolean).join(' · ');
const giftIsNew = (g, since) => !!since && g.at * 1000 > Date.parse(since);
/** "$212,000 from 14 gifts of $1,000 or more in 2026", and the day Zeffy was last read when that's over a day ago */
const giftsSay = (g) => `${money(g.total / 100)} from ${plural(g.count, 'gift')} of $1,000 or more in ${g.year}${g.stale ? `, as of ${giftDay(Date.parse(g.at) / 1000)}` : ''}`;

function GiftRow({ g, since }) {
  const about = giftAbout(g);
  const fresh = giftIsNew(g, since);
  return html`<li class=${`bp-gift ${fresh ? 'is-new' : ''}`}>
    <span class="bp-gift__amt">${money(g.cents / 100)}</span>
    <span class="bp-gift__who"><strong>${giftWho(g)}</strong>${about ? html`<span>${about}</span>` : null}</span>
    <span class="bp-gift__when">${fresh ? html`<span class="bp-gift__new">New</span>` : null}${giftDay(g.at)}</span>
  </li>`;
}

/**
 * Home's major gifts: the year's newest six of $1,000 or more, newest first (down the first column, then the second),
 * those since your last visit marked new. Financials has every one
 */
function Gifts({ g, since }) {
  const list = g.list.slice(0, 6);
  return html`<section class="bp-card bp-gifts" aria-labelledby="gifts-h">
    <div class="bp-cardhead">
      <h2 class="bp-h2" id="gifts-h">Major gifts</h2>
      ${g.count > list.length ? html`<a class="bp-cardhead__go" href="#/financials/gifts">All ${g.count} this year<${Icon} name="arrow" size=${16} cls="bp-go" /></a>` : null}
    </div>
    ${g.count ? html`<p class="bp-gifts__sum">${giftsSay(g)}</p>
      <ul class="bp-gifts__list" style=${`--rows:${Math.ceil(list.length / 2)}`}>${list.map((x) => html`<${GiftRow} g=${x} since=${since} key=${x.id} />`)}</ul>`
    : html`<p class="bp-gifts__sum">No gifts of $1,000 or more yet in ${g.year}.</p>`}
  </section>`;
}

/** Financials: every major gift this year, newest first, under the year's total */
function GiftsYear({ g, since }) {
  const [all, setAll] = useState(false);
  // Home's "All 14 this year" opens Financials here
  useEffect(() => {
    if (!/^#\/financials\/gifts\b/.test(location.hash)) return;
    requestAnimationFrame(() => document.getElementById('gifts')?.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' }));
  }, []);
  const shown = all ? g.list : g.list.slice(0, 12);
  return html`<section class="bp-card bp-gifts bp-gifts--year" aria-labelledby="gifts-y-h" id="gifts">
    <${SecHead} id="gifts-y-h" title="Major gifts" sub=${`From Zeffy, every gift of $1,000 or more${g.stale ? `, as of ${giftDay(Date.parse(g.at) / 1000)}` : ''}`} />
    ${g.count ? html`<p class="bp-gifts__total"><strong>${money(g.total / 100)}</strong> from ${plural(g.count, 'gift')} in ${g.year}</p>
      <ul class="bp-gifts__list">${shown.map((x) => html`<${GiftRow} g=${x} since=${since} key=${x.id} />`)}</ul>
      ${g.count > 12 ? html`<button type="button" class="bp-more-btn" aria-expanded=${all} onClick=${() => setAll(!all)}>${all ? 'Show the newest 12' : `Show all ${g.count}`}</button>` : null}`
    : html`<p class="bp-muted">No gifts of $1,000 or more yet in ${g.year}.</p>`}
  </section>`;
}

function Builds({ n }) {
  return html`<section class="bp-card bp-kanban" aria-labelledby="builds-h" id="makeovers">
    <div class="bp-cardhead"><h2 class="bp-h2" id="builds-h">Makeovers</h2><span class="bp-muted">From JobTread</span></div>
    <${Kanban} projects=${n.projects} reveals=${n.reveals} variant="home" />
  </section>`;
}

function HomePage({ ctx }) {
  const { data, d } = ctx;
  const mine = data.actions.filter((a) => a.mine);
  const toSign = data.docs.filter((x) => x.sign && x.file && !x.signedByMe);
  const today = new Date(noon(data.today)).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
  const who = useAdminWho(data);
  const name = data.me.name || who?.name || '';
  const m = d.featured;
  const todos = mine.length || toSign.length ? html`<section class="bp-card bp-forme" aria-labelledby="todo-h">
      <div class="bp-cardhead"><h2 class="bp-h2" id="todo-h">For you<span class="bp-count">${mine.length + toSign.length}</span></h2></div>
      <ul class="bp-todos">
        ${mine.map((a) => html`<${MyAction} a=${a} ctx=${ctx} key=${a.id} />`)}
        ${toSign.map((x) => html`<li class="bp-todo-card" key=${x.id}><a class="bp-todo bp-todo--link" href="#/documents" onClick=${() => { focusNext = `doc-${x.id}`; }}>
          <span class="bp-todo__icon"><${Icon} name="documents" size=${20} /></span>
          <span class="bp-todo__text"><span class="bp-todo__title">Read and sign: ${x.title}</span></span>
          <${Icon} name="arrow" size=${18} cls="bp-go" />
        </a></li>`)}
      </ul>
    </section>` : null;
  return html`<div class="bp-home">
    <header class="bp-brief bp-rise" style=${rise(0)}>
      <h1 class="bp-brief__h">${name ? `${greeting()}, ${firstName(name)}.` : 'The board page'}</h1>
      <p class="bp-brief__date">${today}</p>
    </header>
    <section class="bp-sum bp-rise" style=${rise(1)} aria-label="SOARD at a glance">
      <${Figures} data=${data} />
      ${mixOf(data.numbers.books) ? html`<section class="bp-sum__mix" aria-labelledby="mix-h"><h2 class="bp-fig__label" id="mix-h">Where ${data.numbers.books.year}’s revenue came from</h2><${RevenueMix} books=${data.numbers.books} /></section>` : null}
      <${Impact} n=${data.numbers} />
    </section>
    <div class="bp-meets">
      <div class="bp-meets__col bp-rise" style=${rise(2)}>${m ? html`<${NextUp} m=${m} ctx=${ctx} />` : html`<${NoMeeting} ctx=${ctx} />`}</div>
      <div class="bp-meets__col bp-rise" style=${rise(3)}>${todos}<${SinceLast} ctx=${ctx} /></div>
    </div>
    ${data.gifts ? html`<div class="bp-rise" style=${rise(4)}><${Gifts} g=${data.gifts} since=${data.me.lastSeen} /></div>` : null}
    <div class="bp-rise" style=${rise(5)}><${Builds} n=${data.numbers} /></div>
  </div>`;
}

function NoMeeting({ ctx }) {
  return html`<section class="bp-card bp-next bp-nextup" aria-labelledby="next-h">
    <div class="bp-cardhead"><h2 class="bp-h2" id="next-h">Next meeting</h2></div>
    <div class="bp-nextup__when">
      <span class="bp-date bp-date--big bp-date--none" aria-hidden="true"><${Icon} name="calendar" size=${26} /></span>
      <p><strong class="bp-nextup__day">Not on the calendar yet</strong><span class="bp-oneline">The invite comes to ${ctx.data.me.email ? html`<strong>${ctx.data.me.email}</strong>` : 'your email'} once the day is set, and it shows here.</span></p>
    </div>
  </section>`;
}

/** The next meeting, on Home and on Meetings: when and where in one line, whether you're coming, and the agenda's headings */
function NextUp({ m, ctx }) {
  const { data } = ctx;
  const today = m.date === data.today;
  const [, setNow] = useState(0);
  useEffect(() => { if (!today) return undefined; const t = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(t); }, [today]);
  // On the day: whether the chair has started, and where the board is on the agenda
  const [lv] = useLive(m.id, today && !m.pending, 20000);
  const running = !!lv?.live.startedAt && !lv.live.endedAt;
  const nowAt = running ? agendaItems(lv).find((it) => it.id === lv.live.itemId) : null;
  const phase = running ? 'now' : lv?.live.endedAt ? 'after' : today ? phaseOf(m) : null;
  const video = videoOf(m);
  const joinNow = today && video && phase !== 'after';
  const fileCount = fileRows(m.files || []).reduce((s, g) => s + g.rows.length, 0);
  const status = today ? (phase === 'now' ? 'Happening now' : phase === 'after' ? 'Earlier today' : m.start ? `Today at ${clock(m.start)}` : 'Today') : inWords(m.date, data.today);
  const facts = [
    m.start ? timeRange(m.start, m.end) : 'Time to come',
    m.location || m.address ? (m.address ? html`<a href=${mapsHref(m.address)} target="_blank" rel="noopener">${m.location || m.address}</a>` : m.location) : 'Place to come',
    video && !joinNow ? html`<a href=${video} target="_blank" rel="noopener">${joinLabel(video).replace(/^Join with /, '')}</a>` : null,
  ].filter(Boolean);
  return html`<section class=${`bp-card bp-next bp-nextup ${today ? 'is-today' : ''}`} aria-labelledby=${`next-h-${m.id}`}>
    <div class="bp-cardhead">
      <h2 class="bp-h2" id=${`next-h-${m.id}`}>${today ? 'Today’s meeting' : 'Next meeting'}<span class=${`bp-soon ${phase === 'now' ? 'is-live' : ''}`}>${phase === 'now' ? html`<span class="bp-live-dot" aria-hidden="true"></span>` : null}${status}</span></h2>
      ${m.pending ? null : html`<a class="bp-cardhead__go" href=${`#/meetings/${m.id}`} onClick=${claimMorph}>${running ? html`<span class="bp-live-dot" aria-hidden="true"></span>Follow the meeting` : `See the agenda${fileCount ? ` and ${plural(fileCount, 'file')}` : ''}`}<${Icon} name="arrow" size=${16} cls="bp-go" /></a>`}
    </div>
    <div class="bp-nextup__when">
      <${DateTile} d=${m.date} mid=${m.id} big />
      <p><strong class="bp-nextup__day">${dayOf(m.date)}</strong><span class="bp-oneline">${facts.map((x, i) => html`${i ? html`<span class="bp-oneline__dot" aria-hidden="true">·</span>` : null}${x}`)}</span>${nowAt ? html`<span class="bp-nextup__now"><span class="bp-live-dot" aria-hidden="true"></span>Now: ${nowAt.label} ${nowAt.title}</span>` : null}</p>
    </div>
    ${joinNow ? html`<div class="bp-btns"><a class="bp-btn bp-btn--primary" href=${video} target="_blank" rel="noopener"><${Icon} name="video" />${joinLabel(video)}</a></div>` : null}
    ${m.pending ? html`<p class="bp-pending"><${Icon} name="documents" size=${18} />The agenda and packet post here before the meeting.</p>` : null}
    <${Rsvp} m=${m} ctx=${ctx} quiet />
    ${!m.pending && (m.sections || []).some((x) => x.title) ? html`<div class="bp-nextup__agenda"><h3 class="bp-mini-h">Agenda</h3><${AgendaPeek} m=${m} /></div>` : null}
  </section>`;
}

/** Whether the meeting is already on their calendar (they got the invite), else a way to add it */
function OnCalendar({ m, data }) {
  if (m.onCalendar) return html`<p class="bp-oncal"><${Icon} name="check" size=${18} /><span>${data.me.email ? `It’s on your calendar: the invite went to ${data.me.email}.` : 'It’s on your calendar.'}</span></p>`;
  if (!isDate(m.date) || m.date < data.today) return null;
  return html`<p class="bp-oncal bp-oncal--add">
    <a class="bp-btn bp-btn--quiet bp-btn--sm" href=${`${API}?ics=${encodeURIComponent(m.id)}`} download="soard-board-meeting.ics"><${Icon} name="calendar" size=${18} />Add it to my calendar</a>
    <a class="bp-link" href=${googleHref(m)} target="_blank" rel="noopener">or to Google Calendar</a>
  </p>`;
}

function Rsvp({ m, ctx, quiet = false }) {
  const { data, setData, say } = ctx;
  const [busy, setBusy] = useState('');
  const [thanks, setThanks] = useState(false);
  if (m.date < data.today || !data.me.slug) return null;
  const team = theTeam(data);
  const chosen = RSVP.find((r) => r.id === m.myRsvp);
  const onInvite = !chosen && m.myInvite && m.myInvite !== 'invited' ? answerOf('', m.myInvite) : '';
  const at = RSVP.findIndex((r) => r.id === (busy || m.myRsvp));
  const answer = async (id) => {
    if (!data.me.slug || id === m.myRsvp) return;
    setBusy(id);
    const j = await call({ action: 'rsvp', meetingId: m.id, answer: id });
    setBusy('');
    if (!j.ok) { say(j.error, 'warn'); return; }
    const set = (x) => (x?.id === m.id ? { ...x, myRsvp: id } : x);
    setData((dd) => ({ ...dd, meetings: dd.meetings.map(set), nextPending: set(dd.nextPending) }));
    setThanks(true);
    say(`Thanks. ${team} can see your answer.`);
  };
  const qid = `rsvp-${m.id}`;
  return html`<div class="bp-rsvp" role="group" aria-labelledby=${qid}>
    <p class="bp-rsvp__q" id=${qid}>Will you be there?</p>
    <div class="bp-seg" style=${`--at:${Math.max(0, at)}`} data-on=${at >= 0 ? 'yes' : null}>
      <span class="bp-seg__thumb" aria-hidden="true"></span>
      ${RSVP.map((r) => html`<button type="button" class="bp-choice" aria-pressed=${m.myRsvp === r.id} disabled=${!!busy} onClick=${() => answer(r.id)} key=${r.id}>
        ${m.myRsvp === r.id ? html`<${Icon} name="check" size=${16} cls="bp-choice__check" />` : null}${busy === r.id ? 'Saving…' : r.label}</button>`)}
    </div>
    ${quiet ? (chosen || onInvite ? html`<p class="bp-rsvp__said">${chosen ? `You said “${chosen.label}.”` : `Calendar invite: ${onInvite}.`}</p>` : null) : html`<p class="bp-rsvp__said">${chosen ? (thanks ? `Thanks. ${team} can see your answer.` : `You said “${chosen.ask}.” You can change it any time.`)
      : onInvite ? `You answered the calendar invite: ${onInvite}. Tap one to tell ${team} here too.`
      : `Tap one. ${team} see your answer.`}</p>`}
  </div>`;
}

function MyAction({ a, ctx }) {
  const { setData, say } = ctx;
  const [done, setDone] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const tickIt = async (v) => {
    setDone(v);
    const j = await call({ action: 'action-done', actionId: a.id, done: v });
    if (!j.ok) { setDone(!v); say(j.error, 'warn'); return; }
    say(v ? `Done: ${a.text.slice(0, 60)}` : 'Marked not done');
    if (v) {
      setTimeout(() => setLeaving(true), 900);
      setTimeout(() => setData((dd) => ({ ...dd, actions: dd.actions.filter((x) => x.id !== a.id) })), 1300);
    }
  };
  return html`<li class=${`bp-todo-card ${leaving ? 'is-leaving' : ''}`}><label class=${`bp-todo ${done ? 'is-done' : ''}`}>
    <input type="checkbox" class="bp-check" checked=${done} onChange=${(e) => tickIt(e.target.checked)} />
    <span class="bp-todo__text"><span class="bp-todo__title">${a.text}</span>${a.due ? html`<span class="bp-todo__meta">Due ${shortDate(a.due).replace(/, \d{4}$/, '')}</span>` : null}</span>
  </label></li>`;
}


// ─── Meetings ───────────────────────────────────────────────────────
/** Everything a meeting says, for finding it: [{ where, text }] */
function meetingTexts(m) {
  return [
    { where: '', text: [meetingName(m), longDate(m.date), m.location].join(' ') },
    ...m.sections.flatMap((s) => [{ where: s.title, text: s.title }, ...s.items.map((it) => ({ where: it.title || s.title, text: [it.title, it.presenter, it.notes].join(' '), id: `i-${it.id}` }))]),
    ...m.motions.map((x) => ({ where: 'Decision', text: x.text })),
    ...m.actions.map((a) => ({ where: 'Action item', text: [a.text, a.ownerName].join(' ') })),
    ...m.files.map((f) => ({ where: 'File', text: titleOf(f.name) })),
  ];
}
const termsOf = (q) => norm(q).split(/\s+/).filter(Boolean);
const hits = (text, terms) => { const t = norm(text); return terms.every((w) => t.includes(w)); };
/** "…designate funds into a [money market] fund…" around the first term */
function Snippet({ text, terms }) {
  const flat = String(text || '').replace(/\s+/g, ' ').trim();
  const low = norm(flat);
  const at = Math.max(0, low.indexOf(terms[0]));
  const from = Math.max(0, at - 50);
  const piece = `${from ? '…' : ''}${flat.slice(from, at + 90)}${at + 90 < flat.length ? '…' : ''}`;
  const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'ig');
  return piece.split(re).map((part, i) => (i % 2 ? html`<mark>${part}</mark>` : part));
}

/**
 * A meeting in the list: its date on the tile and the weekday, time and place beside it; who was there and its files
 * as quiet words. Only what's out of the ordinary is a chip: one ahead, or minutes still in draft
 */
function MeetingRow({ m, data, terms = [] }) {
  const c = attendanceCounts(m);
  const ahead = m.date >= data.today;
  const hit = terms.length ? meetingTexts(m).find((x, i) => i > 0 && hits(x.text, terms)) : null;
  const files = fileRows(m.files).reduce((n, g) => n + g.rows.length, 0);
  const side = [!ahead && c.boardHere ? `${c.boardHere} of ${c.board} there` : '', files ? plural(files, 'file') : ''].filter(Boolean).join(' · ');
  return html`<li key=${m.id}><a class="bp-mrow" href=${`#/meetings/${m.id}`} onClick=${claimMorph}>
    <${DateTile} d=${m.date} mid=${m.id} />
    <span class="bp-mrow__main">
      <span class="bp-mrow__title">${meetingName(m)}${ahead ? html`<span class="bp-chip bp-chip--info">${inWords(m.date, data.today)}</span>` : m.minutes !== 'approved' ? html`<span class="bp-chip">Draft minutes</span>` : null}</span>
      <span class="bp-mrow__meta">${[weekdayOf(m.date), m.start ? clock(m.start) : '', m.location].filter(Boolean).join(' · ')}</span>
      ${hit ? html`<span class="bp-hit"><span class="bp-hit__where">${hit.where}</span> <${Snippet} text=${hit.text} terms=${terms} /></span>` : null}
    </span>
    ${side ? html`<span class="bp-mrow__side">${side}</span>` : null}
    <${Icon} name="arrow" size=${18} cls="bp-go" />
  </a></li>`;
}

function MeetingsPage({ ctx }) {
  const { data, d } = ctx;
  const [q, setQ] = useState('');
  const terms = termsOf(q);
  const upcoming = d.byDate.filter((m) => m.date >= data.today && m.id !== d.featured?.id);
  const past = d.past.filter((m) => !terms.length || meetingTexts(m).some((x) => hits(x.text, terms)));
  const years = [...new Set(past.map((m) => m.date.slice(0, 4)))];
  return html`
    <header class="bp-pagehead bp-rise" style=${rise(0)}>
      <div>
        <h1 class="bp-h1">Meetings</h1>
        <p class="bp-lede">Every agenda, with the notes, votes, minutes and files from the meeting.</p>
      </div>
      <label class="bp-filter">
        <${Icon} name="search" size=${18} />
        <span class="sr-only">Find in meetings</span>
        <input type="search" placeholder="Find in agendas, minutes and files" value=${q} onInput=${(e) => setQ(e.target.value)} />
      </label>
    </header>
    ${d.featured && !terms.length ? html`<div class="bp-rise bp-gap" style=${rise(1)}><${NextUp} m=${d.featured} ctx=${ctx} /></div>` : null}
    ${upcoming.length && !terms.length ? html`<section class="bp-card bp-gap bp-rise" style=${rise(2)} aria-labelledby="up-h"><h2 class="bp-h2" id="up-h">Also ahead</h2><ol class="bp-mlist">${upcoming.map((m) => html`<${MeetingRow} m=${m} data=${data} key=${m.id} />`)}</ol></section>` : null}
    <section class="bp-archive bp-rise" style=${rise(3)} aria-labelledby="past-h">
      <h2 class="sr-only" id="past-h">Past meetings</h2>
      ${terms.length ? html`<p class="bp-found" role="status">${past.length ? `${plural(past.length, 'meeting')} mention “${q.trim()}”` : `No meeting mentions “${q.trim()}”.`}</p>` : null}
      ${(terms.length ? years : years.slice(0, 2)).map((y) => html`<div class="bp-year" key=${y}>
        <h3 class="bp-year__label">${y}</h3>
        <ol class="bp-mlist">${past.filter((m) => m.date.startsWith(y)).map((m) => html`<${MeetingRow} m=${m} data=${data} terms=${terms} key=${m.id} />`)}</ol>
      </div>`)}
      ${!terms.length && years.length > 2 ? html`<div class="bp-year">
        <h3 class="bp-year__label bp-year__label--small">Earlier</h3>
        <div class="bp-yearfolds">${years.slice(2).map((y) => {
          const list = past.filter((m) => m.date.startsWith(y));
          return html`<details class="bp-yearfold" key=${y}>
            <summary><span class="bp-yearfold__y">${y}</span><span class="bp-yearfold__n">${plural(list.length, 'meeting')}</span>${list.some((m) => m.minutes !== 'approved') ? html`<span class="bp-chip">${plural(list.filter((m) => m.minutes !== 'approved').length, 'draft')}</span>` : null}<${Icon} name="chevron" size=${18} cls="bp-yearfold__chev" /></summary>
            <ol class="bp-mlist">${list.map((m) => html`<${MeetingRow} m=${m} data=${data} key=${m.id} />`)}</ol>
          </details>`;
        })}</div>
      </div>` : null}
      ${!d.past.length ? html`<div class="bp-card"><p class="bp-muted">Past meetings show here once they’re added.</p></div>` : null}
    </section>`;
}

function Notes({ text }) {
  const blocks = noteBlocks(text);
  if (!blocks.length) return null;
  const list = (nodes) => html`<ul class="bp-notes">${nodes.map((n) => html`<li>${n.text}${n.children.length ? list(n.children) : null}</li>`)}</ul>`;
  const out = [];
  let run = [];
  for (const b of blocks) {
    if (b.para) { if (run.length) { out.push(list(run)); run = []; } out.push(html`<p class="bp-para">${b.text}</p>`); } else run.push(b);
  }
  if (run.length) out.push(list(run));
  return out;
}

const NotFound = () => html`<a class="bp-back" href="#/meetings"><${Icon} name="back" size=${18} />All meetings</a>
  <div class="bp-card bp-empty"><h1 class="bp-h2">That meeting isn’t on the board page</h1><p class="bp-muted">It may not be shared yet.</p></div>`;

/** A meeting: live on its day (and the founders' practice meeting), its record otherwise */
function MeetingPage({ id, ctx }) {
  const { data, d } = ctx;
  const m = data.meetings.find((x) => x.id === id) || (d.featured?.pending && d.featured.id === id ? d.featured : null);
  const practice = !m && data.practice?.id === id;
  useFocusTarget();
  if (practice || (m && !m.pending && (isLive(m) || m.date === data.today))) return html`<${LiveMeeting} id=${id} m=${m} ctx=${ctx} />`;
  if (!m) return html`<${NotFound} />`;
  return html`<${MeetingDetail} m=${m} ctx=${ctx} />`;
}

// ─── A meeting as it happens ────────────────────────────────────────
// The page asks /api/board-portal?live=<id> every 3 seconds (15 in a tab nobody's looking at): where the chair
// is on the agenda, who's here, a vote that's open, the decisions and action items so far
async function getLive(id) {
  try {
    const r = await fetch(`${API}?live=${encodeURIComponent(id)}`, { cache: 'no-store' });
    return { ...(await r.json()), status: r.status };
  } catch {
    return null;
  }
}
function useLive(id, on, every = 3000) {
  const [v, setV] = useState(null);
  const [gone, setGone] = useState(false);
  useEffect(() => {
    if (!on) return undefined;
    let stop = false;
    let t = 0;
    const tick = async () => {
      clearTimeout(t);
      const j = await getLive(id);
      if (stop) return;
      // Only an answer that is a live meeting (an older server, or a page in between, says something else)
      if (j?.ok && j.live && Array.isArray(j.sections)) setV(j);
      else if (j?.status === 404 || j?.status === 403) setGone(true);
      t = setTimeout(tick, document.visibilityState === 'visible' ? every : 15000);
    };
    tick();
    const back = () => { if (document.visibilityState === 'visible') tick(); };
    document.addEventListener('visibilitychange', back);
    return () => { stop = true; clearTimeout(t); document.removeEventListener('visibilitychange', back); };
  }, [id, on]);
  return [v, setV, gone];
}
const clockAt = (iso) => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });
/** "47 min", "1 h 45 min" */
function lasted(from, to) {
  const mins = Math.max(0, Math.round(((to ? Date.parse(to) : Date.now()) - Date.parse(from)) / 60000));
  if (mins < 1) return to ? 'under a minute' : 'just now';
  return mins < 60 ? `${mins} min` : `${Math.floor(mins / 60)} h${mins % 60 ? ` ${mins % 60} min` : ''}`;
}

function LiveMeeting({ id, m, ctx }) {
  const [v, setV, gone] = useLive(id, true);
  const [, setTick] = useState(0);
  useEffect(() => { const t = setInterval(() => setTick(Date.now()), 30000); return () => clearInterval(t); }, []);
  if (v?.live.startedAt) return html`<${LiveRoom} v=${v} setV=${setV} m=${m} ctx=${ctx} />`;
  // On the day, before the chair starts: the meeting as usual, and it turns live by itself
  if (m) return html`<${MeetingDetail} m=${m} ctx=${ctx} waiting=${!!v} />`;
  if (gone) return html`<${NotFound} />`;
  if (!v) return html`<div class="bp-boot bp-boot--inline"><p>Opening the meeting…</p></div>`;
  return html`<${LiveRoom} v=${v} setV=${setV} m=${null} ctx=${ctx} />`;
}

/** Who has the floor (the one the chair gave it to, else the item's presenters) and the part's time left */
function FloorLine({ v, nowItem, si, ctx }) {
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, []);
  const people = ctx.d.people;
  const given = v.live.floor ? ctx.d.bySlug.get(v.live.floor) || null : null;
  const floor = given ? [given] : nowItem ? presentersOf(nowItem, people).map((p) => ctx.d.bySlug.get(p.slug) || p) : [];
  const sec = v.sections[si];
  const timer = sec && !v.live.endedAt ? sectionClock(sectionPlan(v), sec.id, v.live.sectionAt) : null;
  if (!floor.length && !timer) return null;
  return html`<div class="bp-floor">
    ${floor.length ? html`<span class="bp-floor__who"><${Faces} people=${floor} max=${3} size=${30} /><span><strong>${floor.map((p) => p.name).join(' & ')}</strong> has the floor</span></span>` : null}
    ${timer ? html`<span class=${`bp-floor__time ${timer.over ? 'is-over' : ''}`} role="timer">${timer.over ? `Time’s up · ${clockText(timer.left)} over` : `${clockText(timer.left)} left in ${sec.title || 'this part'}`}</span>` : null}
  </div>`;
}

const VOTES = [['for', 'For'], ['against', 'Against'], ['abstain', 'Abstain']];
function LiveRoom({ v, setV, m, ctx }) {
  const { say } = ctx;
  const [busy, setBusy] = useState('');
  const items = agendaItems(v);
  // A part's card on the screen: that part is on now, none of its items begun yet
  const cardSi = v.live.screen === 'section' ? v.sections.findIndex((x) => x.id === v.live.sectionId) : -1;
  const cardAt = cardSi >= 0 ? items.findIndex((it) => it.si >= cardSi) : -1;
  const at = cardSi >= 0 ? (cardAt >= 0 ? cardAt : items.length) - 0.5 : items.findIndex((it) => it.id === v.live.itemId);
  const now = Number.isInteger(at) && at >= 0 ? items[at] : null;
  const nowItem = now ? v.sections[now.si]?.items[now.ii] : null;
  const started = !!v.live.startedAt;
  const ended = !!v.live.endedAt;
  const video = m ? videoOf(m) : '';
  const done = ended ? items.length : Math.max(0, Math.ceil(at));
  const plan = sectionPlan(v);
  const act = async (body, thanks) => {
    setBusy(body.vote || body.how || 'x');
    const j = await call({ ...body, meetingId: v.id });
    setBusy('');
    if (!j.ok) { say(j.error, 'warn'); return; }
    if (j.live && Array.isArray(j.sections)) setV(j);
    if (thanks) say(thanks);
  };
  const state = (it) => {
    const i = items.findIndex((x) => x.id === it.id);
    return ended || (at >= 0 && i < at) ? 'done' : i === at ? 'now' : 'next';
  };
  const cardSec = cardSi >= 0 ? v.sections[cardSi] : null;
  // What the board has decided so far: a motion it voted on, or the one it's voting on (a typed motion is "passed"
  // until a vote says otherwise, so one not voted on yet isn't a decision)
  const decided = v.motions.filter((x) => x.text && (x.tally || v.vote?.motionId === x.id));
  // Scrolled past the heading: a slim bar along the top keeps who's here, the quorum and how far along
  const [head, setHead] = useState(null);
  const [past, setPast] = useState(false);
  useEffect(() => {
    if (!head || !('IntersectionObserver' in window)) return undefined;
    // Under the site's bar where it stays put (a phone's scrolls away: the very top there)
    const bar = document.querySelector('.bp-top');
    const top = bar && getComputedStyle(bar).position === 'sticky' ? Math.round(bar.getBoundingClientRect().height) : 0;
    document.documentElement.style.setProperty('--livebar-top', `${top}px`);
    const io = new IntersectionObserver(([e]) => setPast(!e.isIntersecting && e.boundingClientRect.top < top + 1), { rootMargin: `-${top}px 0px 0px 0px` });
    io.observe(head);
    return () => io.disconnect();
  }, [head]);
  const hereLine = html`<strong>${v.here.board} of ${v.here.of}</strong> board members here${v.here.remote ? `, ${v.here.remote} on video` : ''}`;
  const quorumChip = v.here.met === true ? html`<span class="bp-livechip is-met"><${Icon} name="check" size=${14} />Quorum</span>` : v.here.met === false ? html`<span class="bp-livechip">${v.here.quorum - v.here.board} more for a quorum</span>` : null;
  return html`
    <a class="bp-back bp-noprint" href=${m ? '#/meetings' : '#/'}><${Icon} name="back" size=${18} />${m ? 'All meetings' : 'Home'}</a>
    ${started && !ended ? html`<div class=${`bp-livebar bp-noprint ${past ? 'is-on' : ''}`} aria-hidden=${past ? 'false' : 'true'}>
      <div class="bp-livebar__in">
        <span class="bp-livechip is-live"><span class="bp-live-dot" aria-hidden="true"></span>Live</span>
        <strong class="bp-livebar__title">${v.title}</strong>
        <span class="bp-livebar__here"><strong>${v.here.board} of ${v.here.of}</strong> here${v.here.remote ? `, ${v.here.remote} on video` : ''}</span>${quorumChip}
      </div>
      ${items.length ? html`<div class="bp-livebar__bar" aria-hidden="true"><span style=${`--p:${(done / items.length) * 100}%`}></span></div>` : null}
    </div>` : null}
    <section class=${`bp-livehead ${ended ? 'is-ended' : ''}`} aria-labelledby="live-h" ref=${setHead}>
      <div class="bp-livehead__top">
        <span class=${`bp-livechip ${ended ? 'is-ended' : started ? 'is-live' : ''}`}>${started && !ended ? html`<span class="bp-live-dot" aria-hidden="true"></span>` : null}${ended ? 'Ended' : started ? 'Live' : 'Not started'}</span>
        ${v.practice ? html`<span class="bp-livechip is-practice">Practice</span>` : null}
        <span class="bp-livehead__when" role="timer">${!started ? 'Waiting for the chair to start' : ended ? `${clockAt(v.live.startedAt)} to ${clockAt(v.live.endedAt)} · ${lasted(v.live.startedAt, v.live.endedAt)}` : `Started ${clockAt(v.live.startedAt)} · ${lasted(v.live.startedAt)}`}</span>
      </div>
      <h1 class="bp-livehead__title" id="live-h">${v.title}</h1>
      <div class="bp-livehead__row">
        <p class="bp-livehead__here" aria-live="polite">${hereLine}
          ${quorumChip}</p>
        ${video && !ended ? html`<a class="bp-btn bp-btn--primary bp-btn--sm" href=${video} target="_blank" rel="noopener"><${Icon} name="video" size=${18} />${joinLabel(video)}</a>` : null}
      </div>
      ${items.length && started ? html`<div class="bp-livehead__bar" role="progressbar" aria-label="Through the agenda" aria-valuemin="0" aria-valuemax=${items.length} aria-valuenow=${done}><span style=${`--p:${(done / items.length) * 100}%`}></span></div>` : null}
    </section>
    <div class="bp-room">
      <div class="bp-room__main bp-stack">
        ${v.vote && !ended ? html`<${VoteCard} v=${v} busy=${busy} act=${act} />` : null}
        ${v.me.canAct && !v.me.how && !ended ? html`<section class="bp-checkin" aria-labelledby="ci-h">
          <div><h2 class="bp-h2" id="ci-h">Are you here?</h2><p class="bp-muted">One tap counts you toward the quorum${v.vote ? ', and lets you vote' : ''}.</p></div>
          <div class="bp-checkin__choices">
            <button type="button" class="bp-btn bp-btn--primary" disabled=${!!busy} onClick=${() => act({ action: 'checkin', how: 'present' }, 'You’re checked in.')}>${busy === 'present' ? 'Saving…' : 'I’m in the room'}</button>
            <button type="button" class="bp-btn" disabled=${!!busy} onClick=${() => act({ action: 'checkin', how: 'remote' }, 'You’re checked in on video.')}><${Icon} name="video" size=${18} />${busy === 'remote' ? 'Saving…' : 'I’m on video'}</button>
          </div>
        </section>` : null}
        ${ended ? html`<section class="bp-now bp-now--ended" aria-labelledby="now-h">
          <p class="bp-eyebrow">The meeting is over</p>
          <h2 class="bp-now__title" id="now-h">${[decided.length ? plural(decided.length, 'decision') : '', v.actions.length ? plural(v.actions.length, 'action item') : ''].filter(Boolean).join(' and ') || 'Thank you for being here'}</h2>
          <p class="bp-muted">The minutes come here once they’re written, and the board approves them at the next meeting.</p>
        </section>`
        : cardSec ? html`<section class="bp-now bp-now--part" aria-labelledby="now-h" aria-live="polite" key=${cardSec.id}>
          <p class="bp-eyebrow">Now<span class="bp-soon">Part ${String(cardSi + 1).padStart(2, '0')}${plan.get(cardSec.id) ? ` · ${plan.get(cardSec.id).minutes} min` : ''}</span></p>
          <h2 class="bp-now__title" id="now-h">${cardSec.title || 'Agenda'}</h2>
          <${FloorLine} v=${v} nowItem=${null} si=${cardSi} ctx=${ctx} />
          ${cardSec.items.length ? html`<ol class="bp-now__items">${cardSec.items.map((it) => html`<li key=${it.id}><span>${items.find((x) => x.id === it.id)?.label}</span>${it.title}${presentersOf(it, ctx.d.people).length ? html`<small>${presentersOf(it, ctx.d.people).map((p) => p.name).join(' & ')}</small>` : null}</li>`)}</ol>` : html`<p class="bp-muted">Open to the floor.</p>`}
        </section>`
        : v.live.screen === 'since' && started ? html`<section class="bp-now bp-now--quiet" aria-labelledby="now-h"><p class="bp-eyebrow">On the screen</p><h2 class="bp-now__title" id="now-h">Since we last met</h2><p class="bp-muted">The reveals and events since the last meeting, and the action items still open.</p></section>`
        : nowItem ? html`<section class="bp-now" aria-labelledby="now-h" aria-live="polite" key=${now.id}>
          <p class="bp-eyebrow">Now discussing<span class="bp-soon">${now.label} · ${at + 1} of ${items.length}</span></p>
          <h2 class="bp-now__title" id="now-h">${nowItem.title || now.section}</h2>
          <p class="bp-now__meta">${now.section !== nowItem.title ? now.section : ''}${nowItem.confidential ? html` <span class="bp-chip bp-chip--warn">Board only · please don’t share</span>` : null}</p>
          <${FloorLine} v=${v} nowItem=${nowItem} si=${now.si} ctx=${ctx} />
          <${Notes} text=${nowItem.notes} />
          <${ScreenPeek} v=${v} />
          ${itemFiles(v, nowItem, v.prior || []).length ? html`<div class="bp-now__docs"><${FileList} files=${itemFiles(v, nowItem, v.prior || [])} labels=${false} /></div>` : null}
          ${v.live.fileId ? null : html`<p class="bp-now__screen"><a class="bp-link" href=${`#/meetings/${v.id}/screen`}>Follow the screen</a></p>`}
        </section>`
        : started ? html`<section class="bp-now bp-now--quiet" aria-labelledby="now-h"><p class="bp-eyebrow">The meeting has started</p><h2 class="bp-now__title" id="now-h">${items[0] ? `First: ${items[0].title}` : 'The chair is opening the meeting'}</h2></section>`
        : html`<section class="bp-now bp-now--quiet" aria-labelledby="now-h"><p class="bp-eyebrow">Not started yet</p><h2 class="bp-now__title" id="now-h">This page follows the meeting once the chair starts it</h2><p class="bp-muted">Check in now and you’ll be counted from the start.</p></section>`}
        <section class="bp-card" aria-labelledby="ag-h">
          <h2 class="bp-h2" id="ag-h">The agenda${items.length ? html`<span class="bp-count">${done} of ${items.length} done</span>` : null}</h2>
          <ol class="bp-liveag">${v.sections.map((s, si) => html`<li class="bp-liveag__sec" key=${s.id}>
            <p class=${`bp-liveag__head ${si === cardSi ? 'is-now' : ''}`}><span>${String(si + 1).padStart(2, '0')}</span>${s.title || 'Agenda'}${plan.get(s.id) ? html`<small>${[plan.get(s.id).start ? clock(plan.get(s.id).start) : '', `${plan.get(s.id).minutes} min`].filter(Boolean).join(' · ')}</small>` : null}</p>
            <ol>${s.items.map((it, ii) => { const st = state(it); return html`<li class=${`bp-liveag__item is-${st}`} key=${it.id} aria-current=${st === 'now' ? 'step' : null}>
              <span class="bp-liveag__mark" aria-hidden="true">${st === 'done' ? html`<${Icon} name="check" size=${14} />` : st === 'now' ? html`<span class="bp-live-dot"></span>` : `${si + 1}.${ii + 1}`}</span>
              <span class="bp-liveag__title">${it.title}${it.presenter ? html` <span class="bp-liveag__who">${it.presenter}</span>` : null}</span>
              ${st === 'now' ? html`<span class="sr-only">now</span>` : null}
            </li>`; })}</ol>
          </li>`)}</ol>
        </section>
      </div>
      <aside class="bp-room__side bp-stack">
        ${v.me.canAct && v.me.how ? html`<div class="bp-here"><${Icon} name="check" size=${18} /><span>You’re here, ${v.me.how === 'remote' ? 'on video' : 'in the room'}.</span>${!ended ? html`<button type="button" class="bp-mini" disabled=${!!busy} onClick=${() => act({ action: 'checkin', how: v.me.how === 'remote' ? 'present' : 'remote' }, v.me.how === 'remote' ? 'Now in the room.' : 'Now on video.')}>${v.me.how === 'remote' ? 'I’m in the room now' : 'I’m on video now'}</button>` : null}</div>` : null}
        <section class="bp-card" aria-labelledby="dec-h">
          <h2 class="bp-h2" id="dec-h">Decisions${decided.length ? html`<span class="bp-count">${decided.length}</span>` : null}</h2>
          ${decided.length ? html`<ul class="bp-motions">${decided.map((x) => { const open = v.vote?.motionId === x.id && !ended; return html`<li class=${`bp-motion ${open ? 'is-open' : ''}`} key=${x.id}>
            <span class="bp-motion__icon" aria-hidden="true"><${Icon} name="gavel" size=${18} /></span>
            <div class="bp-motion__text"><p class="bp-motion__what">${x.text}</p><p class="bp-muted">${open ? 'Voting now' : tallyText(x) || ({ passed: 'Passed', failed: 'Did not pass', tabled: 'Tabled' }[x.result] || '')}</p></div>
          </li>`; })}</ul>` : html`<p class="bp-muted">Motions show here as the board makes them.</p>`}
        </section>
        ${v.actions.length ? html`<section class="bp-card" aria-labelledby="la-h"><h2 class="bp-h2" id="la-h">Action items</h2>
          <ul class="bp-actions">${v.actions.map((a) => html`<li key=${a.id} class=${a.done ? 'is-done' : ''}>
            <span class="bp-actions__box" aria-hidden="true">${a.done ? html`<${Icon} name="check" size=${14} />` : null}</span>
            <div><p class="bp-actions__what">${a.text}</p><p class="bp-muted">${[a.ownerName, a.due ? `due ${shortDate(a.due)}` : ''].filter(Boolean).join(' · ')}</p></div>
          </li>`)}</ul></section>` : null}
        ${m?.files?.length ? html`<section class="bp-card" aria-labelledby="lf-h"><h2 class="bp-h2" id="lf-h">All the documents</h2><${FileList} files=${m.files.filter((f) => f.kind !== 'signed')} order=${AHEAD_ORDER} /></section>` : null}
      </aside>
    </div>`;
}

/** A vote the chair opened: your three choices, and the board's count filling in */
function VoteCard({ v, busy, act }) {
  const x = v.vote;
  const c = x.counts;
  const of = Math.max(1, c.of, c.voted);
  const said = VOTES.find(([id]) => id === x.mine)?.[1];
  return html`<section class="bp-vote" aria-labelledby="vote-h">
    <p class="bp-eyebrow">The board is voting</p>
    <h2 class="bp-vote__what" id="vote-h">${x.text || 'A motion'}</h2>
    ${x.by || x.second ? html`<p class="bp-muted">${[x.by && `Moved by ${x.by}`, x.second && `seconded by ${x.second}`].filter(Boolean).join(', ')}</p>` : null}
    ${v.me.canAct ? html`<div class="bp-vote__choices" role="group" aria-label="Your vote">${VOTES.map(([id, label]) => html`<button type="button" class=${`bp-vote__choice is-${id}`} aria-pressed=${x.mine === id} disabled=${!!busy || !v.me.how} onClick=${() => act({ action: 'vote', motionId: x.motionId, vote: id }, `You voted ${label.toLowerCase()}.`)} key=${id}>
      ${x.mine === id ? html`<${Icon} name="check" size=${18} cls="bp-choice__check" />` : null}${busy === id ? 'Saving…' : label}</button>`)}</div>` : null}
    <div class="bp-vote__tally" aria-live="polite">
      <div class="bp-vote__bar" role="img" aria-label=${`For ${c.for}, against ${c.against}, abstain ${c.abstain}`}>${VOTES.map(([id]) => html`<span class=${`is-${id}`} style=${`--p:${(c[id] / of) * 100}%`} key=${id}></span>`)}</div>
      <p class="bp-vote__counts">${VOTES.map(([id, label]) => html`<span key=${id}><i class=${`is-${id}`} aria-hidden="true"></i>${label} <strong>${c[id]}</strong></span>`)}<span class="bp-vote__of">${c.voted} of ${c.of} here ${c.voted === 1 ? 'has' : 'have'} voted</span></p>
    </div>
    ${v.me.canAct ? html`<p class="bp-note">${!v.me.how ? 'Check in first (below), then vote.' : said ? `You voted ${said.toLowerCase()}. You can change it until the chair closes the vote.` : 'Tap one. The chair closes the vote once everyone has voted.'}</p>` : null}
  </section>`;
}

/**
 * Print it all: the agenda and every document, in the agenda's order, as one print (or one PDF). It takes a moment
 * to draw every page, so it says how far it has got, and can be stopped.
 */
function PrintAll({ m, ctx }) {
  const { data, d, say } = ctx;
  const [step, setStep] = useState(null);
  const stop = useRef(null);
  const run = async () => {
    stop.current = new AbortController();
    setStep({ done: 0, of: 0, what: '' });
    try {
      const { printAll } = await import('./print.js');
      await printAll(m, { people: d.people, numbers: m.snapshot || (m.date >= data.today ? data.numbers : null), meetings: data.meetings, data, onStep: setStep, signal: stop.current.signal });
    } catch {
      say('The print didn’t come together. Try again, or open each document on its own.', 'warn');
    }
    setStep(null);
  };
  return html`<button type="button" class="bp-btn bp-btn--quiet" onClick=${run} disabled=${!!step}><${Icon} name="print" size=${18} />Print it all</button>
    ${step ? html`<div class="bp-printing" role="status" aria-live="polite">
      <span class="bp-live-dot" aria-hidden="true"></span>
      <span><strong>Getting it ready to print</strong><small>${step.of ? `${step.done} of ${step.of} pages` : 'Opening the documents'}${step.what ? ` · ${step.what}` : ''}</small></span>
      <button type="button" class="bp-mini" onClick=${() => stop.current?.abort()}>Stop</button>
    </div>` : null}`;
}

// ─── A meeting's agenda ─────────────────────────────────────────────
// The agenda as a run of show: the meeting's facts and your answer up top, its parts down the page as chapters
// (a big number, the name, what's in it), each item with who presents it, the background, the documents as their
// first pages, and the live facts drawn properly: the makeovers as the kanban, the money as figures, the reveals,
// events and meetings by their dates. A rail beside it follows where you are. After the meeting the same page is
// the minutes: what was said under each item, the decisions, the action items and who was there.

const RESULT_WORDS = { passed: 'Passed', failed: 'Did not pass', tabled: 'Tabled' };
const motionChip = (r) => html`<span class=${`bp-chip ${r === 'passed' ? 'bp-chip--ok' : r === 'failed' ? 'bp-chip--warn' : ''}`}>${r === 'passed' ? html`<${Icon} name="check" size=${14} />` : null}${RESULT_WORDS[r] || 'Recorded'}</span>`;

/** A presenter's seat when it says something: "Treasurer", "Co-Founder/CEO" (never "Board Member") */
const seatOf = (p) => { const t = String(p?.title || '').replace(/^Board\s+/i, '').trim(); return /^member$/i.test(t) ? '' : t; };
/** Who presents an item: their faces, names and seats */
function Presenters({ people }) {
  if (!people.length) return null;
  return html`<ul class="bp-pres" aria-label="Presenting">${people.map((p) => html`<li key=${p.slug || p.name}>
    <${Avatar} p=${p} size=${30} />
    <span><strong>${p.name}</strong>${seatOf(p) ? html`<small>${seatOf(p)}</small>` : null}</span>
  </li>`)}</ul>`;
}

/** An item's documents as their first pages, each opening in the viewer */
function DocTile({ f, link }) {
  const [ref, src] = useFirstPage(f, 200);
  const fmt = formatOf(f);
  return html`<a class="bp-doctile" ...${link}>
    <span class=${`bp-doctile__page ${src ? 'has-page' : ''}`} data-format=${fmt} ref=${ref} aria-hidden="true">${src ? html`<img src=${src} alt="" />` : html`<span>${{ PDF: 'PDF', Excel: 'XLS', Word: 'DOC', Slides: 'PPT', Photo: 'IMG' }[fmt] || 'FILE'}</span>`}</span>
    <span class="bp-doctile__text"><span class="bp-doctile__title">${titleOf(f.name)}</span><span class="bp-doctile__meta">${[fmt, sizeText(f.size)].filter(Boolean).join(' · ')}</span></span>
  </a>`;
}
function DocTiles({ files }) {
  const rows = fileRows(files, AHEAD_ORDER).flatMap((g) => g.rows);
  if (!rows.length) return null;
  const primary = rows.map((r) => r.file);
  const vf = asViewer(primary);
  return html`<ul class="bp-doctiles">${rows.map((r, i) => html`<li key=${r.key}><${DocTile} f=${r.file} link=${viewerLink(vf, i)} />
    ${r.more.length ? html`<span class="bp-doctile__more">${r.more.map((x) => html`<a ...${viewerLink(asViewer([x.file]), 0)}>${x.label}</a>`)}</span>` : null}</li>`)}</ul>`;
}

/**
 * The money, as figures (./money.js moneyTiles): the cash, months of cash, the year against its budget; then the
 * statements from QuickBooks. A past meeting keeps to what was locked into it (its books), else its own packet
 */
function CashBlock({ n, data, m }) {
  const upTo = m.date < data.today ? m.date : '';
  const tiles = moneyTiles({ cash: useCashNow(data, upTo, n), budget: useBudget(data, upTo, n), n });
  // The statements the way the figures go: today's for a meeting today or ahead, the locked ones for a past meeting
  const st = (upTo ? n?.books : data.numbers.books)?.statements;
  if (!tiles.length && !st) return null;
  const books = upTo ? n?.books : data.numbers.books;
  return html`${tiles.length ? html`<ul class="bp-agfigs">${tiles.map((t) => html`<li class="bp-agfig" key=${t.k}>
    <span class="bp-fig__label">${t.label}</span><span class="bp-agfig__value">${t.value}</span>${t.sub ? html`<span class=${`bp-fig__sub ${t.tone ? `is-${t.tone}` : ''}`}>${t.sub}</span>` : null}
  </li>`)}</ul>` : null}${mixOf(books) ? html`<div class="bp-agmix"><p class="bp-fig__label">Where ${books.year}’s revenue came from</p><${RevenueMix} books=${books} /></div>` : null}${st ? html`<details class="bp-more bp-stmts-fold"><summary>The statements, as of ${fullDate(st.asOf)}</summary><${Statements} s=${st} books=${upTo ? n?.books : data.numbers.books} idp=${`m${m.id}`} /></details>` : null}`;
}

/** The reveals ahead, by date, each with the kid's photo when their page has one */
function RevealsBlock({ n }) {
  const list = [...(n.reveals || [])].sort((a, b) => String(a.confirmed && a.date ? a.date : windowStart(a.window) || '9').localeCompare(String(b.confirmed && b.date ? b.date : windowStart(b.window) || '9'))).slice(0, 8);
  if (!list.length) return html`<p class="bp-muted">No reveals on the calendar yet.</p>`;
  const photoOf = (r) => [...(n.projects?.building || []), ...(n.projects?.waiting || [])].find((b) => b.slug && b.slug === r.slug)?.photo || '';
  return html`<ul class="bp-agrev">${list.map((r) => {
    const photo = photoOf(r);
    return html`<li key=${r.slug || r.name}>
      <span class="bp-agrev__photo">${photo ? html`<img src=${sized(photo, 'w=240,h=240,fit=cover,gravity=face')} alt="" loading="lazy" width="64" height="64" />` : html`<span class="bp-avatar bp-avatar--initials" style=${`--s:64px;--hue:${hueOf(r.name)}`} data-i=${initialsOf(r.name)} aria-hidden="true"></span>`}</span>
      <span class="bp-agrev__text"><strong>${r.name}</strong><span>${r.confirmed && r.date ? `${dayOf(r.date)}${r.time ? `, ${clock(r.time)}` : ''}` : `${r.window?.label || 'Date to come'}, not set yet`}</span></span>
      ${r.confirmed && r.date ? html`<${DateTile} d=${r.date} />` : html`<${WindowTile} w=${r.window} />`}
    </li>`;
  })}</ul>`;
}

/** Events or board meetings ahead, by date */
function DatesBlock({ rows }) {
  if (!rows.length) return html`<p class="bp-muted">Nothing on the calendar yet.</p>`;
  return html`<ul class="bp-agdates">${rows.map((r) => html`<li key=${r.key}><${DateTile} d=${r.date} /><span><strong>${r.title}</strong><span>${r.sub}</span></span></li>`)}</ul>`;
}

/** An item's live facts, drawn for what they are ([] of lines only when the shape isn't known) */
function LiveBlock({ kind, n, m, data }) {
  if (!n || !kind || kind === 'minutes') return null;
  const stamp = kind === 'cash' ? null : html`<p class="bp-aglive__when">${m.snapshot ? `As of ${shortDate(m.snapshot.at.slice(0, 10))}, locked for this meeting` : 'As of today'}</p>`;
  let body = null;
  if (kind === 'projects') body = html`<${Kanban} projects=${n.projects} reveals=${n.reveals} variant="agenda" />`;
  else if (kind === 'cash') body = html`<${CashBlock} n=${n} data=${data} m=${m} />`;
  else if (kind === 'reveals') body = html`<${RevealsBlock} n=${n} />`;
  else if (kind === 'events') body = html`<${DatesBlock} rows=${(n.events || []).slice(0, 6).map((e) => ({ key: e.title + e.date, date: e.date, title: e.title, sub: [dayOf(e.date), e.time, e.location].filter(Boolean).join(' · ') }))} />`;
  else if (kind === 'meetings') body = html`<${DatesBlock} rows=${(n.meetings || []).filter((x) => x.id !== m.id).slice(0, 4).map((x) => ({ key: x.id || x.date, date: x.date, title: x.name, sub: [dayOf(x.date), x.start ? clock(x.start) : ''].filter(Boolean).join(' · ') }))} />`;
  if (!body) {
    const lines = liveLines(kind, n, { meetingId: m.id });
    if (!lines.length) return null;
    body = html`<ul class="bp-notes">${lines.map((l) => html`<li>${l}</li>`)}</ul>`;
  }
  return html`<div class=${`bp-aglive bp-aglive--${kind}`}>${body}${stamp}</div>`;
}

/** The rail beside the agenda: its parts, the one you're reading marked, its items under it */
function AgendaRail({ sections, labels, extra, plan = null }) {
  const [at, setAt] = useState(sections[0]?.id || '');
  useEffect(() => {
    const els = [...sections.map((s) => `s-${s.id}`), ...extra.map((x) => x.id)].map((id) => document.getElementById(id)).filter(Boolean);
    if (!els.length || !('IntersectionObserver' in window)) return undefined;
    const seen = new Map();
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) seen.set(e.target.id, e.isIntersecting);
      const first = els.find((el) => seen.get(el.id));
      if (first) setAt(first.id.replace(/^s-/, ''));
    }, { rootMargin: '-110px 0px -55% 0px' });
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [sections.map((s) => s.id).join()]);
  const go = (e, id) => {
    e.preventDefault();
    document.getElementById(id)?.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' });
  };
  return html`<nav class="bp-agrail bp-noprint" aria-label="The agenda">
    <p class="bp-agrail__label">The agenda</p>
    <ol>${sections.map((s, i) => html`<li key=${s.id} class=${at === s.id ? 'is-at' : ''}>
      <a href=${`#s-${s.id}`} aria-current=${at === s.id ? 'true' : null} onClick=${(e) => go(e, `s-${s.id}`)}><span class="bp-agrail__n">${String(i + 1).padStart(2, '0')}</span><span class="bp-agrail__t">${s.title || 'Agenda'}</span>${plan?.get(s.id)?.start ? html`<span class="bp-agrail__time">${clock(plan.get(s.id).start).replace(/ (AM|PM)$/, '')}</span>` : null}</a>
      ${at === s.id && s.items.length > 1 ? html`<ol class="bp-agrail__items">${s.items.map((it) => html`<li key=${it.id}><a href=${`#i-${it.id}`} onClick=${(e) => go(e, `i-${it.id}`)}><span>${labels.get(it.id)}</span>${it.title}</a></li>`)}</ol>` : null}
    </li>`)}
    ${extra.map((x) => html`<li key=${x.id} class=${at === x.id ? 'is-at' : ''}><a href=${`#${x.id}`} aria-current=${at === x.id ? 'true' : null} onClick=${(e) => go(e, x.id)}><span class="bp-agrail__n"><${Icon} name=${x.icon} size=${15} /></span><span class="bp-agrail__t">${x.title}</span></a></li>`)}</ol>
  </nav>`;
}

function MeetingDetail({ m, ctx, waiting = false }) {
  const { data, d } = ctx;
  const upcoming = m.date >= data.today;
  // A past meeting shows only the numbers locked into its packet; one ahead shows today's until then
  const numbers = m.snapshot || (upcoming ? data.numbers : null);
  const c = attendanceCounts(m);
  const person = (p) => d.bySlug.get(p.slug) || p;
  const here = m.attendance.filter((p) => p.status === 'present' || p.status === 'remote');
  const away = m.attendance.filter((p) => p.status === 'absent' || p.status === 'excused');
  // A file that goes with an agenda item is under that item; the rest come after the agenda
  const placed = new Set(m.sections.flatMap((s) => s.items.flatMap((it) => it.docs || [])));
  const docsOf = (it) => itemFiles(m, it, data.meetings);
  const loose = m.files.filter((f) => f.kind !== 'signed' && !placed.has(f.id) && !(upcoming && f.kind === 'minutes'));
  const signed = m.files.find((f) => f.kind === 'signed');
  const printable = m.files.some((f) => f.kind !== 'signed') || m.sections.some((s) => s.items.length);
  const minutesFile = m.files.find((f) => f.kind === 'minutes');
  const video = upcoming ? videoOf(m) : '';
  const isNext = upcoming && m.id === d.featured?.id;
  const sections = m.sections.filter((s) => s.title || s.items.length);
  const hasAgenda = sections.some((s) => s.items.length);
  const labels = new Map(agendaItems(m).map((x) => [x.id, x.label]));
  // Ahead of the meeting, each part's time in the run of show ("8:25 · 60 min")
  const plan = upcoming ? sectionPlan(m) : null;
  const timeOf = (s) => { const t = plan?.get(s.id); return t ? [t.start ? clock(t.start) : '', `${t.minutes} min`].filter(Boolean).join(' · ') : ''; };
  const i = d.byDate.findIndex((x) => x.id === m.id);
  const before = i > 0 ? d.byDate[i - 1] : null;
  const after = i >= 0 && i < d.byDate.length - 1 ? d.byDate[i + 1] : null;
  const need = quorumFor(m, data.quorum);
  const quorum = need && c.boardHere ? c.boardHere >= need : null;
  const decided = m.motions.filter((x) => x.text);
  const presenting = [...new Map(m.sections.flatMap((s) => s.items.flatMap((it) => presentersOf(it, d.people))).map((p) => [p.slug || p.name, person(p)])).values()];
  const place = [m.location, m.address].filter(Boolean);
  const extra = [
    !upcoming && decided.length ? { id: 'decisions', title: 'Decisions', icon: 'gavel' } : null,
    m.actions.length ? { id: 'actions', title: 'Action items', icon: 'check' } : null,
    loose.length ? { id: 'more-files', title: placed.size ? 'Also for this meeting' : upcoming ? 'The documents' : 'Files', icon: 'documents' } : null,
  ].filter(Boolean);
  const status = upcoming
    ? (m.date === data.today ? 'Today' : inWords(m.date, data.today))
    : m.minutes === 'approved' ? `Minutes approved${m.approvedOn ? ` ${shortDate(m.approvedOn).replace(/, \d{4}$/, '')}` : ''}` : 'Draft minutes';
  return html`
    <a class="bp-back bp-noprint" href="#/meetings"><${Icon} name="back" size=${18} />All meetings</a>
    ${waiting ? html`<p class="bp-waiting" role="status"><span class="bp-live-dot" aria-hidden="true"></span>Today’s meeting. This page follows it live once the chair starts: where the board is on the agenda, who’s here, and votes.</p>` : null}
    <header class=${`bp-aghero ${upcoming ? '' : 'is-past'}`}>
      <div class="bp-aghero__main">
        <p class="bp-eyebrow">${upcoming ? (m.pending ? 'Agenda coming' : 'Board meeting agenda') : 'Board meeting minutes'}<span class=${`bp-soon ${m.minutes === 'approved' && !upcoming ? 'is-ok' : ''}`}>${status}</span></p>
        <h1 class="bp-aghero__title">${meetingName(m)}</h1>
        <ul class="bp-aghero__facts">
          <li><${DateTile} d=${m.date} big head /><span><strong>${dayOf(m.date)}</strong><span>${[m.start ? timeRange(m.start, m.end) : '', String(m.date).slice(0, 4)].filter(Boolean).join(' · ')}</span></span></li>
          ${place.length ? html`<li><span class="bp-aghero__ico"><${Icon} name="pin" /></span><span><strong>${m.location || m.address}</strong>${m.address ? html`<a href=${mapsHref(m.address)} target="_blank" rel="noopener">${m.location ? m.address : 'Directions'}</a>` : null}</span></li>` : null}
          ${video && m.date !== data.today ? html`<li><span class="bp-aghero__ico"><${Icon} name="video" /></span><span><strong>${joinLabel(video).replace(/^Join (with|by) /, '').replace(/^video$/, 'Video call')}</strong><a href=${video} target="_blank" rel="noopener">Join from anywhere</a></span></li>` : null}
        </ul>
        <div class="bp-aghero__actions bp-noprint">
          ${video && m.date === data.today ? html`<a class="bp-btn bp-btn--primary" href=${video} target="_blank" rel="noopener"><${Icon} name="video" />${joinLabel(video)}</a>` : null}
          ${data.me.admin && upcoming && hasAgenda ? html`<a class="bp-btn bp-btn--primary" href=${`/admin/#board/meeting/${encodeURIComponent(m.id)}/during`} target="_blank" rel="noopener" title="Run it from Board: the screen, item by item"><${Icon} name="present" />Present</a>` : null}
          ${printable ? html`<${PrintAll} m=${m} ctx=${ctx} />` : null}
          ${upcoming && !m.pending ? html`<${OnCalendar} m=${m} data=${data} />` : null}
        </div>
      </div>
      <aside class="bp-aghero__side">
        ${upcoming && data.me.slug ? html`<div class="bp-aghero__card"><${Rsvp} m=${m} ctx=${ctx} /></div>` : null}
        ${!upcoming && c.boardHere ? html`<div class="bp-aghero__card bp-who" id="who">
          <p class="bp-aghero__big"><strong>${c.boardHere}</strong> of ${c.board} board members</p>
          <p class="bp-who__q">${quorum === true ? html`<span class="bp-chip bp-chip--ok"><${Icon} name="check" size=${14} />A quorum</span>` : quorum === false ? html`<span class="bp-chip bp-chip--warn">Short of a quorum (${need})</span>` : null}${c.remote ? html`<span class="bp-muted">${c.remote} by video</span>` : null}</p>
          <${Faces} people=${here.map(person)} max=${9} size=${34} />
          ${away.length ? html`<p class="bp-muted bp-who__away">Not there: ${away.map((p) => `${p.name}${p.status === 'excused' ? ' (excused)' : ''}`).join(', ')}</p>` : null}
        </div>` : null}
        ${!upcoming && (signed || minutesFile) ? html`<p class="bp-aghero__links bp-noprint">${minutesFile ? html`<a class="bp-link" ...${viewerLink(asViewer([minutesFile]), 0)}>The minutes as written</a>` : null}${signed ? html`<a class="bp-link" ...${viewerLink(asViewer([signed]), 0)}>The signed copy</a>` : null}</p>` : null}
      </aside>
    </header>
    ${hasAgenda && presenting.length ? html`<p class="bp-glance"><${Faces} people=${presenting} max=${7} size=${28} /><span>${presenting.length} presenting</span></p>` : null}
    <div class=${`bp-ag ${hasAgenda ? '' : 'is-empty'}`}>
      ${hasAgenda && (sections.length > 2 || extra.length) ? html`<${AgendaRail} sections=${sections} labels=${labels} extra=${extra} plan=${plan} />` : null}
      <div class="bp-ag__body">
        ${hasAgenda ? sections.map((s, si) => html`<section class=${`bp-agsec ${s.items.length ? '' : 'is-open'}`} id=${`s-${s.id}`} key=${s.id} aria-labelledby=${`sh-${s.id}`}>
          <header class="bp-agsec__head">
            <span class="bp-agsec__n" aria-hidden="true">${String(si + 1).padStart(2, '0')}</span>
            <h2 class="bp-agsec__title" id=${`sh-${s.id}`}>${s.title || 'Agenda'}</h2>
            ${plan ? html`<span class="bp-agsec__meta bp-agsec__time">${!s.items.length ? 'Open to the floor · ' : ''}${timeOf(s)}</span>`
              : s.items.length > 1 ? html`<span class="bp-agsec__meta">${s.items.length} items</span>` : null}
          </header>
          ${s.items.length ? html`<ol class="bp-agitems">${s.items.map((it) => {
            const who = presentersOf(it, d.people).map(person);
            const files = docsOf(it);
            const aboutPrev = it.live === 'minutes' && it.about ? data.meetings.find((x) => x.id === it.about) : null;
            const simple = !who.length && !files.length && !it.notes && !aboutPrev && !it.confidential && !(it.live && it.live !== 'minutes');
            return html`<li class=${`bp-item bp-agitem ${it.live && it.live !== 'minutes' ? `has-live is-${it.live}` : ''} ${simple ? 'is-simple' : ''}`} id=${`i-${it.id}`} key=${it.id}>
              <span class="bp-agitem__n" aria-hidden="true">${labels.get(it.id)}</span>
              <div class="bp-agitem__body">
                <div class="bp-agitem__head">
                  <h3 class="bp-item__title bp-agitem__title">${it.title || s.title}</h3>
                  ${it.confidential ? html`<span class="bp-chip bp-chip--warn">Board only · please don’t share</span>` : null}
                  ${aboutPrev ? (aboutPrev.minutes === 'approved' ? html`<span class="bp-chip bp-chip--ok"><${Icon} name="check" size=${14} />Approved</span>` : upcoming ? html`<span class="bp-chip">For a vote</span>` : null) : null}
                  <${Presenters} people=${who} />
                </div>
                ${aboutPrev ? html`<p class="bp-agitem__about"><a class="bp-link" href=${`#/meetings/${aboutPrev.id}`}>The ${meetingName(aboutPrev)}, ${shortDate(aboutPrev.date)}</a></p>` : null}
                <div class="bp-agitem__notes"><${Notes} text=${it.notes} /></div>
                <${LiveBlock} kind=${it.live} n=${numbers} m=${m} data=${data} />
                ${files.length ? html`<div class="bp-item__docs"><${DocTiles} files=${files} /></div>` : null}
              </div>
            </li>`;
          })}</ol>` : null}
        </section>`) : html`<div class="bp-card bp-empty">
          <span class="bp-empty__icon"><${Icon} name="list" size=${26} /></span>
          <h2 class="bp-h2">${upcoming ? 'The agenda isn’t posted yet' : minutesFile ? 'The minutes are in the file' : 'No agenda was kept here'}</h2>
          <p class="bp-muted">${upcoming ? 'It shows here before the meeting, with the packet.' : minutesFile ? 'Open them to read what the board discussed and decided.' : 'The files from the meeting are below.'}</p>
          ${!upcoming && minutesFile ? html`<p class="bp-btns"><a class="bp-btn bp-btn--primary" ...${viewerLink(asViewer([minutesFile]), 0)}><${Icon} name="documents" size=${18} />Read the minutes</a></p>` : null}
        </div>`}
        ${!upcoming && decided.length ? html`<section class="bp-agsec bp-agsec--after" id="decisions" aria-labelledby="dec-h">
          <header class="bp-agsec__head"><span class="bp-agsec__n bp-agsec__n--icon" aria-hidden="true"><${Icon} name="gavel" size=${26} /></span><h2 class="bp-agsec__title" id="dec-h">Decisions</h2><span class="bp-agsec__meta">${decided.length}</span></header>
          <ul class="bp-motions bp-motions--ag">${decided.map((x, k) => html`<li key=${x.id || k} class="bp-motion">
            <div class="bp-motion__text"><p class="bp-motion__what">${x.text}</p><p class="bp-muted">${[x.by && `Moved by ${x.by}`, x.second && `seconded by ${x.second}`, x.tally ? tallyText(x) : ''].filter(Boolean).join(', ')}</p></div>
            ${motionChip(x.result)}
          </li>`)}</ul>
        </section>` : null}
        ${m.actions.length ? html`<section class="bp-agsec bp-agsec--after" id="actions" aria-labelledby="act-h">
          <header class="bp-agsec__head"><span class="bp-agsec__n bp-agsec__n--icon" aria-hidden="true"><${Icon} name="check" size=${26} /></span><h2 class="bp-agsec__title" id="act-h">Action items</h2><span class="bp-agsec__meta">${m.actions.filter((a) => !a.done).length} open</span></header>
          <ul class="bp-actions bp-actions--ag">${m.actions.map((a) => html`<li key=${a.id} class=${a.done ? 'is-done' : ''}>
            <span class="bp-actions__box" aria-hidden="true">${a.done ? html`<${Icon} name="check" size=${14} />` : null}</span>
            <div><p class="bp-actions__what">${a.text}</p><p class="bp-muted">${[a.ownerName, a.due ? `due ${shortDate(a.due)}` : '', a.done ? 'done' : ''].filter(Boolean).join(' · ')}</p></div>
            ${a.owner && d.bySlug.get(a.owner) ? html`<${Avatar} p=${d.bySlug.get(a.owner)} size=${30} />` : null}
          </li>`)}</ul>
        </section>` : null}
        ${loose.length ? html`<section class="bp-agsec bp-agsec--after" id="more-files" aria-labelledby="files-h">
          <header class="bp-agsec__head"><span class="bp-agsec__n bp-agsec__n--icon" aria-hidden="true"><${Icon} name="documents" size=${26} /></span><h2 class="bp-agsec__title" id="files-h">${placed.size ? 'Also for this meeting' : upcoming ? 'The documents' : 'Files'}</h2></header>
          <div class="bp-agsec__files">${hasAgenda ? html`<${DocTiles} files=${loose} />` : html`<${FileList} files=${loose} order=${upcoming ? AHEAD_ORDER : PAST_ORDER} />`}</div>
        </section>` : null}
      </div>
    </div>
    ${before || after ? html`<nav class="bp-pager bp-noprint" aria-label="Other meetings">
      ${before ? html`<a class="bp-pager__a" href=${`#/meetings/${before.id}`}><span class="bp-pager__dir"><${Icon} name="back" size=${16} />Earlier</span><span class="bp-pager__name">${meetingName(before)}</span><span class="bp-muted">${shortDate(before.date)}</span></a>` : html`<span></span>`}
      ${after ? html`<a class="bp-pager__a bp-pager__a--next" href=${`#/meetings/${after.id}`}><span class="bp-pager__dir">Later<${Icon} name="arrow" size=${16} /></span><span class="bp-pager__name">${meetingName(after)}</span><span class="bp-muted">${shortDate(after.date)}</span></a>` : null}
    </nav>` : null}`;
}

// ─── Financials ─────────────────────────────────────────────────────
function Bars({ s }) {
  const other = s.totalRevenue - (s.contributions || 0) - (s.storeRevenue || 0);
  const income = [
    ['Contributions', s.contributions, 'a'],
    ['The store', s.storeRevenue, 'b'],
    other > 0 ? ['Everything else', other, 'c'] : null,
  ].filter((x) => x && typeof x[1] === 'number' && x[1] > 0);
  const spend = typeof s.programExpenses === 'number'
    ? [['Programs', s.programExpenses, 'a'], ['Management', s.managementExpenses, 'b'], ['Fundraising', s.fundraisingExpenses, 'c']].filter((x) => typeof x[1] === 'number' && x[1] > 0)
    : [];
  const top = Math.max(s.totalRevenue || 0, s.totalExpenses || 0) || 1;
  const bar = (label, total, parts) => html`<div class="bp-meter">
    <div class="bp-meter__head"><span>${label}</span><strong>${money(total)}</strong></div>
    <div class="bp-meter__track" style=${`--w:${(total / top) * 100}%`} role="img" aria-label=${`${label}: ${parts.map(([k, v]) => `${k} ${money(v)}`).join(', ')}`}>
      ${parts.map(([k, v, tone]) => html`<span class=${`bp-meter__seg bp-meter__seg--${tone}`} style=${`--p:${(v / total) * 100}%`} key=${k}></span>`)}
    </div>
    <ul class="bp-legend">${parts.map(([k, v, tone]) => html`<li key=${k}><i class=${`bp-meter__seg--${tone}`} aria-hidden="true"></i>${k}<strong>${money(v)}</strong><span>${Math.round((v / total) * 100)}%</span></li>`)}</ul>
  </div>`;
  const left = (s.totalRevenue || 0) - (s.totalExpenses || 0);
  return html`<div class="bp-meters">
    ${s.totalRevenue && income.length ? bar('Money in', s.totalRevenue, income) : null}
    ${s.totalExpenses && spend.length ? bar('Money out', s.totalExpenses, spend) : null}
    <dl class="bp-meters__foot">
      ${s.totalRevenue && s.totalExpenses ? html`<div><dt>${left >= 0 ? 'Left over' : 'Spent beyond income'}</dt><dd>${left >= 0 ? '+' : '−'}${money(Math.abs(left))}</dd></div>` : null}
      ${typeof s.netAssets === 'number' ? html`<div><dt>Net assets at year end</dt><dd>${money(s.netAssets)}</dd></div>` : null}
      ${s.programPct ? html`<div><dt>To programs</dt><dd>${s.programPct}%</dd></div>` : null}
    </dl>
  </div>`;
}

// ─── From QuickBooks: the statements, the year so far, cash over time ───

const signedMoney = (n) => (typeof n === 'number' ? `${n < 0 ? '−' : ''}${money(Math.abs(n))}` : '–');
const changeMoney = (a, p) => (typeof a === 'number' && typeof p === 'number' ? (a === p ? '–' : `${a > p ? '+' : '−'}${money(Math.abs(a - p))}`) : '');
const dayMonth = (d) => shortDate(d).replace(/, \d{4}$/, '');
/** "September 30, 2026" */
const fullDate = (d) => (isDate(d) ? new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '');

/**
 * A statement from QuickBooks (./_quickbooks.js statementRows): each line with the same day a year before and the
 * change. Folded to the main lines and totals until "Every account" opens it
 */
function Statement({ id, title, rows, asOf, priorAsOf }) {
  const [all, setAll] = useState(false);
  if (!rows?.length) return null;
  const prior = rows.some((r) => r.p != null);
  // The main lines: the top headings, each group's total and the subtotals and net; every account a tap away
  const folded = rows.filter((r) => r.k === 'sum' || (r.k === 'head' && r.d === 0) || (r.k === 'total' && r.d <= 1));
  const shown = all ? rows : folded;
  const cols = prior ? 4 : 2;
  return html`<div class="bp-stmt">
    <div class="bp-stmt__head">
      <h3 class="bp-stmt__title" id=${id}>${title}</h3>
      ${folded.length < rows.length ? html`<button type="button" class="bp-more-btn bp-noprint" aria-expanded=${all} onClick=${() => setAll(!all)}>${all ? 'Main lines only' : 'Every account'}</button>` : null}
    </div>
    <div class="bp-stmt__scroll">
      <table class="bp-table bp-stmt__table" aria-labelledby=${id}>
        <thead><tr><th scope="col"><span class="sr-only">Line</span></th><th scope="col" class="num">${shortDate(asOf)}</th>${prior ? html`<th scope="col" class="num">${shortDate(priorAsOf)}</th><th scope="col" class="num bp-stmt__chg">Change</th>` : null}</tr></thead>
        <tbody>${shown.map((r, i) => (r.k === 'head'
          ? html`<tr class="bp-stmt__h" key=${i}><th scope="colgroup" colspan=${cols} style=${`--d:${r.d}`}>${r.label}</th></tr>`
          : html`<tr class=${`bp-stmt__${r.k}`} key=${i} style=${`--d:${r.d}`}><th scope="row" style=${`--d:${r.d}`}>${r.label}</th><td class="num">${signedMoney(r.a)}</td>${prior ? html`<td class="num bp-stmt__prior" data-label=${shortDate(priorAsOf)}>${signedMoney(r.p)}</td><td class="num bp-stmt__chg">${changeMoney(r.a, r.p)}</td>` : null}</tr>`))}</tbody>
      </table>
    </div>
  </div>`;
}

/**
 * The statements as of the books' close, as a meeting's packet holds them (`s`: numbers.books.statements): one at a
 * time, the activities (the year's money in and out) first, the financial position a tap away
 */
function Statements({ s, books, idp = 'st' }) {
  const [which, setWhich] = useState('act');
  if (!s?.position?.length && !s?.activity?.length) return null;
  const both = s.position?.length && s.activity?.length;
  const show = both ? which : s.activity?.length ? 'act' : 'pos';
  return html`<div class="bp-stmts">
    <div class="bp-stmts__top">
      <p class="bp-stmts__when">From QuickBooks, as of ${fullDate(s.asOf)}${s.closed ? ', the day the books are closed through' : ', the end of the last full month'}, beside the same day a year before.${books?.qboYearStarts ? ` QuickBooks’ settings start its year in ${books.qboYearStarts}, so its Net Income line counts from ${books.qboYearStarts} 1.` : ''}</p>
      ${both ? html`<div class="bp-impact__seg bp-noprint" role="group" aria-label="Which statement">${[['act', 'Activities'], ['pos', 'Financial position']].map(([id, label]) => html`<button type="button" aria-pressed=${show === id} onClick=${() => setWhich(id)} key=${id}>${label}</button>`)}</div>` : null}
    </div>
    ${show === 'pos'
      ? html`<${Statement} id=${`${idp}-pos`} title="Statement of financial position" rows=${s.position} asOf=${s.asOf} priorAsOf=${s.priorAsOf} key="pos" />`
      : html`<${Statement} id=${`${idp}-act`} title=${`Statement of activities, January 1 to ${dayMonth(s.asOf)}`} rows=${s.activity} asOf=${s.asOf} priorAsOf=${s.priorAsOf} key="act" />`}
  </div>`;
}

/** Parts of a whole as one bar: the first three by name in fixed colors, the rest as "Everything else" in gray */
function PartsBar({ label, parts, total }) {
  const named = parts.slice(0, 3);
  const rest = Math.max(0, total - named.reduce((t, p) => t + p.amount, 0));
  const list = [...named.map((p, i) => ({ ...p, tone: ['a', 'b', 'd'][i] })), ...(rest >= total * 0.005 ? [{ name: 'Everything else', amount: rest, tone: 'c' }] : [])];
  if (!(total > 0) || !list.length) return null;
  return html`<div class="bp-meter">
    <div class="bp-meter__head"><span>${label}</span><strong>${money(total)}</strong></div>
    <div class="bp-meter__track" role="img" aria-label=${`${label}: ${list.map((p) => `${p.name} ${money(p.amount)}`).join(', ')}`}>
      ${list.map((p) => html`<span class=${`bp-meter__seg bp-meter__seg--${p.tone}`} style=${`--p:${(p.amount / total) * 100}%`} key=${p.name}></span>`)}
    </div>
    <ul class="bp-legend">${list.map((p) => html`<li key=${p.name}><i class=${`bp-meter__seg--${p.tone}`} aria-hidden="true"></i>${p.name}<strong>${money(p.amount)}</strong><span>${Math.round((p.amount / total) * 100)}%</span></li>`)}</ul>
  </div>`;
}

/** The year so far from QuickBooks beside last year's same days; where the money came from; where it went, by purpose */
function BooksYear({ b }) {
  const ly = b.lastYear;
  // Expenses as the budget counts them, then the in kind that never left the bank, so the net is still QuickBooks'
  const nc = b.nonCash > 0;
  const lyNc = typeof ly?.nonCash === 'number';
  const rows = [
    ['Revenue', b.revenue, ly?.revenue, 'total'],
    ...(nc ? [['Expenses', spentOf(b), lyNc ? ly.expenses - ly.nonCash : null, 'total'], ['In kind (not cash)', b.nonCash, lyNc ? ly.nonCash : null, 'part']] : [['Expenses', b.expenses, ly?.expenses, 'total']]),
    ['Net', b.net, ly?.net, 'net'],
  ];
  const lySpent = nc ? (lyNc && typeof ly?.full?.nonCash === 'number' ? [ly.expenses - ly.nonCash, ly.full.expenses - ly.full.nonCash] : null) : ly ? [ly.expenses, ly.full?.expenses] : null;
  const pct = (a, p) => (typeof p === 'number' && p > 0 ? `${a >= p ? '▲' : '▼'} ${Math.abs(Math.round(((a - p) / p) * 100))}%` : '');
  return html`<section class="bp-card" aria-labelledby="by-h">
    <${SecHead} id="by-h" title="The year so far" sub=${`From QuickBooks, January 1 to ${dayMonth(b.through)}`} />
    <table class="bp-table bp-cmp">
      <thead><tr><th scope="col"><span class="sr-only">What</span></th><th scope="col" class="num">${b.year} so far</th>${ly ? html`<th scope="col" class="num">${ly.year}, same days</th><th scope="col" class="num">Change</th>` : null}</tr></thead>
      <tbody>${rows.map(([label, a, p, kind]) => html`<tr class=${`bp-row--${kind}`} key=${label}><th scope="row">${label}</th><td class="num">${signedMoney(a)}</td>${ly ? html`<td class="num bp-cmp__ly" data-label=${`${ly.year}, same days`}>${signedMoney(p)}</td><td class="num bp-cmp__chg">${kind === 'net' ? changeMoney(a, p) : pct(a, p)}</td>` : null}</tr>`)}</tbody>
    </table>
    ${ly?.full?.revenue > 0 ? html`<p class="bp-note">By this day last year, ${Math.round((ly.revenue / ly.full.revenue) * 100)}% of ${ly.year}’s revenue (${compact(ly.full.revenue)}) had come in${lySpent?.[1] > 0 ? `, and ${Math.round((lySpent[0] / lySpent[1]) * 100)}% of its spending had gone out` : ''}.</p>` : null}
    <div class="bp-meters">
      ${mixOf(b) ? html`<div class="bp-meter"><div class="bp-meter__head"><span>Where the money came from</span></div><${RevenueMix} books=${b} table=${true} /></div>` : null}
      ${b.functions ? html`<${PartsBar} label="Where it went, by purpose" parts=${b.functions.list} total=${b.functions.total} />` : null}
    </div>
  </section>`;
}

/** Cash at each month's end for 13 months (QuickBooks' month-ends, newest first in `rows`): a bar a month from zero, this month in gold */
function CashChart({ rows }) {
  // The bar under the pointer says its month, its balance and the change on the month before
  const [tip, setTip] = useState(-1);
  const list = [...rows].reverse().slice(-13);
  if (list.length < 2) return null;
  const top = Math.max(...list.map((r) => r.total), 1);
  const last = list.at(-1);
  const low = list.reduce((a, b) => (b.total < a.total ? b : a));
  const mon = (ym) => new Date(`${ym}-15T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' });
  const nameOf = (r) => (r === last ? `${dayMonth(r.at || `${r.month}-28`)}, so far` : new Date(`${r.month}-15T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' }));
  const t = list[tip];
  const was = tip > 0 ? list[tip - 1] : null;
  return html`<div class="bp-years bp-cashchart" onMouseLeave=${() => setTip(-1)}>
    <ol class="bp-years__bars" aria-label=${`Cash at each month’s end, ${monthOf(list[0].month)} to ${monthOf(last.month)}`}>
      ${list.map((r, i) => {
        const say = `${r === last ? `${dayMonth(r.at || `${r.month}-28`)} (so far this month)` : monthOf(r.month)}: ${money(r.total)}`;
        return html`<li key=${r.month} class=${`${r === last ? 'is-now' : ''} ${i === tip ? 'is-tip' : ''}`} style=${`--h:${(r.total / top) * 100}%;--i:${i}`} onMouseEnter=${() => setTip(i)}>
          <span class="bp-years__hit" role="img" aria-label=${say}>
            ${r === last || r === low ? html`<span class="bp-years__val">${compact(r.total)}</span>` : null}
            <span class="bp-years__bar"></span>
            <span class="bp-years__x">${mon(r.month)}</span>
          </span>
        </li>`;
      })}
    </ol>
    ${t ? html`<span class="bp-ytip" style=${`--x:${((tip + 0.5) / list.length) * 100}%;--th:${(t.total / top) * 100}`} aria-hidden="true"><strong>${nameOf(t)}</strong>${money(t.total)}${was ? ` · ${t.total >= was.total ? '▲' : '▼'} ${compact(Math.abs(t.total - was.total))} on the month` : ''}</span>` : null}
  </div>`;
}

/** The cash in the bank (live from the banks, else the newest balance sheet): the total, a year earlier, each account, and the cards */
function CashCard({ data }) {
  const cash = useCashNow(data);
  if (!cash) return null;
  const change = cash.prior != null ? cash.total - cash.prior : null;
  const top = Math.max(...cash.accounts.map((a) => a.balance), 1);
  // Each account holding at least 1% of the cash on its own line; the smaller ones together on one
  const held = cash.accounts.filter((a) => a.balance);
  const small = held.length > 4 ? held.filter((a) => a.balance < cash.total * 0.01) : [];
  const shown = held.filter((a) => !small.includes(a));
  const vf = cash.live ? null : asViewer([cash.file]);
  return html`<section class="bp-card bp-cash bp-rise" style=${rise(1)} aria-labelledby="cash-h">
    <div class="bp-cash__head">
      <div>
        <h2 class="bp-h2" id="cash-h">Cash in the bank</h2>
        <p class="bp-cash__total">${money(cash.total)}</p>
        <p class="bp-muted">${cash.asOf ? `As of ${cash.asOf}` : ''}${change != null ? html` · <span class=${change >= 0 ? 'bp-up' : 'bp-down'}>${change >= 0 ? 'up' : 'down'} ${money(Math.abs(change))}</span> from ${cash.priorAsOf || 'a year earlier'}` : ''}</p>
        ${cash.months != null ? html`<p class="bp-cash__months"><strong>${monthsText(cash.months)} months</strong> of spending${cash.perMonth ? `, at the ${money(cash.perMonth)} a month that left the bank in the last 12 months (moves between SOARD’s own accounts aside)` : ''}</p>` : null}
      </div>
      ${cash.live
        ? html`<p class="bp-cash__src">${fromBooks(cash) || `Straight from ${andText(cash.banks)}, read ${cash.today ? `today at ${clockAt(cash.at)}` : cash.asOf}`}${cash.stale.length ? html`<br />${andText(cash.stale)} hasn’t answered since then` : null}</p>`
        : html`<p class="bp-cash__src">From the <a class="bp-link" ...${viewerLink(vf, 0)}>statement of financial position</a> in the <a class="bp-link" href=${`#/meetings/${cash.meeting.id}`} onClick=${claimMorph}>${meetingName(cash.meeting)}</a> packet</p>`}
    </div>
    ${shown.length > 1 ? html`<ul class="bp-accounts">${shown.map((a) => html`<li key=${a.name}>
      <span class="bp-accounts__name">${a.name}</span>
      <span class="bp-accounts__bar" aria-hidden="true"><span style=${`--p:${(a.balance / top) * 100}%`}></span></span>
      <span class="bp-accounts__n">${money(a.balance)}</span>
    </li>`)}${small.length ? html`<li class="bp-accounts__rest">
      <span class="bp-accounts__name">${andText(small.map((a) => a.name))}</span>
      <span class="bp-accounts__n">${money(small.reduce((t, a) => t + a.balance, 0))}</span>
    </li>` : null}</ul>` : null}
    ${cash.owed?.length ? html`<ul class="bp-accounts bp-accounts--owed" aria-label="Owed on the cards">${cash.owed.map((o) => html`<li key=${o.name}>
      <span class="bp-accounts__name">${o.name}</span>
      <span class="bp-accounts__note">${o.limit ? `Owed, of a ${money(o.limit)} limit` : 'Owed'}</span>
      <span class="bp-accounts__n">${money(o.balance)}</span>
    </li>`)}</ul>` : null}
  </section>`;
}

function FinancialsPage({ ctx }) {
  const { data } = ctx;
  const [allYears, setAllYears] = useState(false);
  const [allEarlier, setAllEarlier] = useState(false);
  // QuickBooks is the books once it's connected. Until then, Mercury's own record speaks for SOARD only once it holds the money
  const books = data.numbers.books;
  const funded = !!data.numbers.mercury && !data.numbers.mercury.empty;
  const f = funded && !books ? data.numbers.finance : null;
  const history = data.cashHistory;
  const s = data.snapshot;
  const withStatements = [...data.meetings].filter((m) => m.files.some((x) => x.kind === 'financials')).sort((a, b) => b.date.localeCompare(a.date));
  const latest = withStatements[0] || null;
  const earlier = withStatements.slice(1);
  const budgets = data.docs.filter((x) => x.kind === 'financial' && x.file);
  const spent = (p) => (p.makeovers || 0) + (p.store || 0) + (p.operating || 0);
  const signed = (n) => (typeof n === 'number' ? `${n < 0 ? '−' : ''}${money(Math.abs(n))}` : '');
  const monthShort = (ym) => new Date(`${ym}-15T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  const ytdRows = [
    ['Money in', (p) => money(p.income), 'total'],
    ['Money out', (p) => money(spent(p)), 'total'],
    ['Makeovers', (p) => money(p.makeovers), 'part'],
    ['The Sunny & Ranney store', (p) => money(p.store), 'part'],
    ['Running SOARD', (p) => money(p.operating), 'part'],
    ['Net', (p) => signed(p.net), 'net'],
  ];
  // Tax returns and audits, a year to a row
  const fv = data.filings.map((x) => ({ name: `${x.title}.pdf`, type: 'application/pdf', url: x.url }));
  const typeOf = (x) => (/990/.test(`${x.type} ${x.title}`) ? '990' : /audit/i.test(`${x.type} ${x.title}`) ? 'audit' : 'other');
  const years = [...new Set(data.filings.filter((x) => typeOf(x) !== 'other').map((x) => String(x.year)))].sort().reverse();
  const shownYears = allYears ? years : years.slice(0, 6);
  const others = data.filings.filter((x) => typeOf(x) === 'other');
  const cell = (y, t) => { const x = data.filings.find((z) => String(z.year) === y && typeOf(z) === t); return x ? html`<a class="bp-doclink" ...${viewerLink(fv, data.filings.indexOf(x))}><${Icon} name="documents" size=${16} />Open</a>` : html`<span class="bp-muted" aria-label="None">–</span>`; };
  // The year first (QuickBooks' year so far, or Mercury's), beside the cash over time and the year's major gifts; then
  // the statements; then the tax returns, audits, budgets and every meeting's statements. A side with nothing in it
  // gives the other the page's width
  const pair = (left, right, i) => {
    const l = left.filter(Boolean);
    const r = right.filter(Boolean);
    if (!l.length && !r.length) return null;
    if (!l.length || !r.length) return html`<div class="bp-stack bp-gap bp-rise" style=${rise(i)}>${[...l, ...r]}</div>`;
    return html`<div class="bp-split bp-split--even bp-gap"><div class="bp-stack bp-rise" style=${rise(i)}>${l}</div><div class="bp-stack bp-rise" style=${rise(i + 1)}>${r}</div></div>`;
  };
  return html`
    <header class="bp-pagehead bp-rise" style=${rise(0)}>
      <div><h1 class="bp-h1">Financials</h1><p class="bp-lede">The cash, the year in numbers, its major gifts, the statements from each meeting, and every tax return and audit.</p></div>
    </header>
    <${CashCard} data=${data} />
    ${pair([books ? html`<${BooksYear} b=${books} />` : null, f?.ytd ? html`<section class="bp-card" aria-labelledby="io-h">
          <${SecHead} id="io-h" title="Money in and out" sub=${`Through ${monthName(f.ytd.through)} ${Number(String(f.ytd.through).slice(8, 10)) || ''}`} />
          <table class="bp-table">
            <thead><tr><th scope="col"><span class="sr-only">What</span></th><th scope="col" class="num">${f.ytd.year} so far</th>${f.lastYtd ? html`<th scope="col" class="num">${f.lastYtd.year}, same days</th>` : null}</tr></thead>
            <tbody>${ytdRows.map(([label, val, kind]) => html`<tr class=${`bp-row--${kind}`} key=${label}><th scope="row">${label}</th><td class="num">${val(f.ytd)}</td>${f.lastYtd ? html`<td class="num">${val(f.lastYtd)}</td>` : null}</tr>`)}</tbody>
          </table>
          <p class="bp-note">Live from Mercury’s record. The official books are in Mercury Books.${f.perMakeover ? ` ${plural(f.perMakeover.count, 'makeover')} finished this year, ${money(f.perMakeover.average)} each on average.` : ''}</p>
          ${f.months?.length ? html`<details class="bp-more"><summary>Month by month</summary>
            <table class="bp-table">
              <thead><tr><th scope="col">Month</th><th scope="col" class="num">In</th><th scope="col" class="num">Out</th><th scope="col" class="num">Net</th></tr></thead>
              <tbody>${[...f.months].reverse().map((r) => html`<tr key=${r.month}><th scope="row">${monthShort(r.month)}</th><td class="num">${money(r.income)}</td><td class="num">${money(spent(r))}</td><td class="num">${signed(r.net)}</td></tr>`)}</tbody>
            </table>
          </details>` : null}
        </section>` : null], [f?.cash || history.length > 1 ? html`<section class="bp-card" aria-labelledby="cashtime-h">
          <h2 class="bp-h2" id="cashtime-h">Cash over time</h2>
          ${history.length > 1 ? html`<${CashChart} rows=${history} />` : null}
          ${f?.cash ? html`<div class="bp-live">
            <div class="bp-live__label">The next 13 weeks</div>
            <ul>
              <li>The lowest point: ${money(f.cash.lowest.dollars)}${f.cash.lowest.week ? `, the week of ${shortDate(f.cash.lowest.week)}` : ''}${f.cash.cautiousLowest && f.cash.cautiousLowest.dollars !== f.cash.lowest.dollars ? ` (a cautious guess: ${money(f.cash.cautiousLowest.dollars)})` : ''}</li>
              <li>In 13 weeks: ${money(f.cash.in13Weeks)}</li>
              ${f.cash.floor ? html`<li>The least we keep in the bank: ${money(f.cash.floor)}${f.cash.belowFloor ? html` <span class="bp-chip bp-chip--warn">The forecast dips under it</span>` : null}</li>` : null}
            </ul>
          </div>` : null}
          ${history.length > 1 ? html`<details class="bp-more"><summary>Month-end balances</summary><table class="bp-table"><thead><tr><th scope="col">Month</th><th scope="col" class="num">Balance</th><th scope="col" class="num">Change</th></tr></thead><tbody>
            ${history.map((r, k) => { const prev = history[k + 1]; const dd = prev ? r.total - prev.total : null; return html`<tr key=${r.month}><th scope="row">${monthOf(r.month)}</th><td class="num">${money(r.total)}</td><td class="num">${dd == null ? '' : `${dd >= 0 ? '+' : '−'}${money(Math.abs(dd))}`}</td></tr>`; })}
          </tbody></table></details>` : null}
        </section>` : null, data.gifts ? html`<${GiftsYear} g=${data.gifts} since=${data.me.lastSeen} />` : null], 1)}
    ${books?.statements ? html`<section class="bp-card bp-latest bp-rise" style=${rise(3)} aria-labelledby="st-h">
      <${SecHead} id="st-h" title="The statements" sub="The ones each meeting’s packet holds, locked on its day" />
      <${Statements} s=${books.statements} books=${books} />
      ${latest ? html`<details class="bp-more"><summary>From the ${meetingName(latest)} packet, ${longDate(latest.date)}</summary><${FileList} files=${latest.files.filter((x) => x.kind === 'financials')} labels=${false} /></details>` : null}
    </section>`
    : latest ? html`<section class="bp-card bp-latest bp-rise" style=${rise(3)} aria-labelledby="st-h">
      <${SecHead} id="st-h" title="The latest statements" sub=${html`From the <a class="bp-link" href=${`#/meetings/${latest.id}`} onClick=${claimMorph}>${meetingName(latest)}</a>, ${longDate(latest.date)}`} />
      <${FileList} files=${latest.files.filter((x) => x.kind === 'financials')} labels=${false} />
    </section>` : html`<section class="bp-card bp-rise" style=${rise(3)}><h2 class="bp-h2">Financial statements</h2><p class="bp-muted">The income statement and balance sheet from each meeting show here.</p></section>`}
    ${pair([s ? html`<section class="bp-card" aria-labelledby="yr-h">
          <${SecHead} id="yr-h" title=${`${s.year} at a glance`} sub=${`From the ${s.year} tax return`} />
          <${Bars} s=${s} />
        </section>` : null, budgets.length ? html`<section class="bp-card" aria-labelledby="bu-h"><h2 class="bp-h2" id="bu-h">Budgets and audits</h2>
          <${FileList} files=${budgets.map((x) => ({ ...x.file, name: x.title }))} labels=${false} /></section>` : null], [years.length ? html`<section class="bp-card" aria-labelledby="tx-h">
          <${SecHead} id="tx-h" title="Tax returns and audits" sub="The public copies, as on the website’s Financials page" />
          <table class="bp-table bp-ftable">
            <thead><tr><th scope="col">Year</th><th scope="col">Form 990</th><th scope="col">Audit</th></tr></thead>
            <tbody>${shownYears.map((y) => html`<tr key=${y}><th scope="row">${y}</th><td>${cell(y, '990')}</td><td>${cell(y, 'audit')}</td></tr>`)}</tbody>
          </table>
          ${years.length > 6 ? html`<button type="button" class="bp-more-btn" aria-expanded=${allYears} onClick=${() => setAllYears(!allYears)}>${allYears ? 'Show fewer years' : `Show all ${years.length} years`}</button>` : null}
          ${others.length ? html`<p class="bp-note">Also: ${others.map((x, k) => html`${k ? ', ' : ''}<a class="bp-link" ...${viewerLink(fv, data.filings.indexOf(x))}>${x.title}</a>`)}</p>` : null}
        </section>` : null, earlier.length ? html`<section class="bp-card" aria-labelledby="ea-h">
          <${SecHead} id="ea-h" title="Earlier statements" sub="From each meeting’s packet" />
          <ul class="bp-rows">${(allEarlier ? earlier : earlier.slice(0, 6)).map((m) => html`<li key=${m.id}><a class="bp-row" href=${`#/meetings/${m.id}`} onClick=${claimMorph}>
            <${DateTile} d=${m.date} mid=${m.id} />
            <span class="bp-row__main"><span class="bp-row__title">${meetingName(m)}</span><span class="bp-row__meta">${fileRows(m.files.filter((x) => x.kind === 'financials')).flatMap((g) => g.rows.map((r) => r.title)).join(' · ')}</span></span>
            <${Icon} name="arrow" size=${18} cls="bp-go" />
          </a></li>`)}</ul>
          ${earlier.length > 6 ? html`<button type="button" class="bp-more-btn" aria-expanded=${allEarlier} onClick=${() => setAllEarlier(!allEarlier)}>${allEarlier ? 'Show the newest 6' : `Show all ${earlier.length}`}</button>` : null}
        </section>` : null], 4)}`;
}

// ─── People ─────────────────────────────────────────────────────────
const OFFICERS = ['chair', 'vice-chair', 'treasurer', 'secretary'];
/** A person on People, a row: their face, name, role (an officer's in gold), company and committees; a board member's email a tap away */
function Person({ p, email = false, ctx }) {
  const copy = async () => {
    try { await navigator.clipboard.writeText(p.email); ctx.say(`Copied ${p.email}`); } catch { ctx.say('Couldn’t copy. Press and hold the address instead.', 'warn'); }
  };
  const role = p.title && !/^board member$/i.test(p.title) ? p.title : '';
  const more = [p.organization, p.committees?.length ? p.committees.join(', ') : ''].filter(Boolean);
  return html`<li class="bp-person" id=${`p-${p.slug}`}>
    <${Avatar} p=${p} size=${44} />
    <div class="bp-person__text">
      <p class="bp-person__name">${p.name}</p>
      ${role || more.length ? html`<p class="bp-person__org">${role ? html`<span class="bp-person__role">${role}</span>` : null}${role && more.length ? ' · ' : ''}${more.join(' · ')}</p>` : null}
    </div>
    ${email && p.email ? html`<p class="bp-person__acts">
      <a class="bp-iconbtn" href=${`mailto:${p.email}`} aria-label=${`Email ${p.name}`} title=${p.email}><${Icon} name="mail" size=${17} /></a>
      <button type="button" class="bp-iconbtn" onClick=${copy} aria-label=${`Copy ${p.name}’s email address`} title="Copy the address"><${Icon} name="copy" size=${17} /></button>
    </p>` : null}
  </li>`;
}
/** People: the board (its officers first), its committees, the team and the Advisory Board, each a directory */
function PeoplePage({ ctx }) {
  const { people } = ctx.data;
  useFocusTarget();
  const officers = people.board.filter((p) => OFFICERS.includes(p.seat)).sort((a, b) => OFFICERS.indexOf(a.seat) - OFFICERS.indexOf(b.seat));
  const members = people.board.filter((p) => !officers.includes(p));
  const committees = [...new Set(people.board.flatMap((p) => p.committees || []))].sort();
  return html`
    <header class="bp-pagehead bp-rise" style=${rise(0)}><div><h1 class="bp-h1">People</h1><p class="bp-lede">The board, the team and the Advisory Board. Write to a board member from their row.</p></div></header>
    <section class="bp-card bp-gap bp-rise" style=${rise(1)} aria-labelledby="bd-h">
      <${SecHead} id="bd-h" title="Board of Directors" count=${people.board.length} />
      <ul class="bp-dir">${[...officers, ...members].map((p) => html`<${Person} p=${p} email ctx=${ctx} key=${p.slug} />`)}</ul>
    </section>
    ${committees.length ? html`<section class="bp-card bp-gap bp-rise" style=${rise(2)} aria-labelledby="cm-h"><h2 class="bp-h2" id="cm-h">Committees</h2><ul class="bp-rows">${committees.map((c) => html`<li key=${c}><div class="bp-row bp-row--static"><span class="bp-row__main"><span class="bp-row__title">${c}</span><span class="bp-row__meta">${people.board.filter((p) => (p.committees || []).includes(c)).map((p) => p.name).join(', ')}</span></span></div></li>`)}</ul></section>` : null}
    <section class="bp-card bp-gap bp-rise" style=${rise(3)} aria-labelledby="tm-h">
      <${SecHead} id="tm-h" title="The team" count=${people.staff.length} />
      <ul class="bp-dir">${people.staff.map((p) => html`<${Person} p=${p} ctx=${ctx} key=${p.slug} />`)}</ul>
    </section>
    ${people.advisory.length ? html`<section class="bp-card bp-rise" style=${rise(4)} aria-labelledby="ad-h">
      <${SecHead} id="ad-h" title="Advisory Board" count=${people.advisory.length} />
      <ul class="bp-dir">${people.advisory.map((p) => html`<${Person} p=${p} ctx=${ctx} key=${p.slug} />`)}</ul>
    </section>` : null}`;
}

// ─── Documents ──────────────────────────────────────────────────────
function SignForm({ d: doc, ctx }) {
  const { data, setData, say } = ctx;
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  if (doc.signedByMe) return html`<p class="bp-signed"><span class="bp-chip bp-chip--ok"><${Icon} name="check" size=${14} />Signed</span> by ${doc.signedByMe.name}, ${shortDate(doc.signedByMe.at.slice(0, 10))}</p>`;
  if (!data.me.slug) return null;
  const id = `sign-${doc.id}`;
  const sign = async (e) => {
    e.preventDefault();
    if (name.trim().length < 3) { setProblem('Type your full name, the way you sign it.'); document.getElementById(id)?.focus(); return; }
    setProblem('');
    setBusy(true);
    const j = await call({ action: 'sign', docId: doc.id, name: name.trim() });
    setBusy(false);
    if (!j.ok) { setProblem(j.error); return; }
    setData((x) => ({ ...x, docs: x.docs.map((y) => (y.id === doc.id ? { ...y, signedByMe: { name: j.name, at: new Date().toISOString() }, signedCount: y.signedCount + 1 } : y)) }));
    say(`Signed: ${doc.title}. Thank you.`);
  };
  return html`<form class="bp-sign" onSubmit=${sign} noValidate>
    <label class="bp-sign__label" for=${id}>Type your full name to sign it for ${todayEastern().slice(0, 4)}</label>
    <div class="bp-sign__row">
      <input id=${id} value=${name} autocomplete="name" aria-invalid=${problem ? 'true' : null} aria-describedby=${problem ? `${id}-p` : null} onInput=${(e) => { setName(e.target.value); if (problem) setProblem(''); }} />
      <button class="bp-btn bp-btn--primary" type="submit" disabled=${busy}>${busy ? 'Signing…' : 'I’ve read it and agree'}</button>
    </div>
    ${name.trim().length >= 3 ? html`<p class="bp-sign__preview" aria-hidden="true">${name.trim()}</p>` : null}
    ${problem ? html`<p class="bp-sign__problem" id=${`${id}-p`}>${problem}</p>` : null}
  </form>`;
}

/** Every file from every meeting, by kind, newest meeting first */
function Library({ data, q = '' }) {
  const [kind, setKind] = useState('all');
  const terms = termsOf(q);
  const meetings = [...data.meetings].filter((m) => m.files.length).sort((a, b) => b.date.localeCompare(a.date));
  const kinds = FILE_KINDS.filter((k) => meetings.some((m) => m.files.some((f) => f.kind === k.id)));
  const pick = (m) => m.files.filter((f) => (kind === 'all' || f.kind === kind) && (!terms.length || hits(`${titleOf(f.name)} ${meetingName(m)} ${kindLabel(f.kind)}`, terms)));
  const shown = meetings.map((m) => ({ m, files: pick(m) })).filter((x) => x.files.length);
  // The newest four meetings' files; the earlier ones a tap away, and every one when searching
  const [all, setAll] = useState(false);
  const cut = !terms.length && !all && shown.length > 5;
  const list = cut ? shown.slice(0, 4) : shown;
  if (!meetings.length) return null;
  return html`<section class="bp-card bp-library" aria-labelledby="lib-h">
    <${SecHead} id="lib-h" title="Every meeting’s files" sub="Minutes, packets and statements, newest first" />
    <div class="bp-chips bp-chips--filter" role="group" aria-label="Show">
      ${[{ id: 'all', label: 'All' }, ...kinds].map((k) => html`<button type="button" class="bp-pill" aria-pressed=${kind === k.id} onClick=${() => setKind(k.id)} key=${k.id}>${k.label}</button>`)}
    </div>
    ${list.length ? list.map(({ m, files }) => html`<div class="bp-libmeet" key=${m.id}>
      <a class="bp-libmeet__head" href=${`#/meetings/${m.id}`} onClick=${claimMorph}><${DateTile} d=${m.date} mid=${m.id} /><span><span class="bp-row__title">${meetingName(m)}</span><span class="bp-row__meta">${longDate(m.date)}</span></span></a>
      <${FileList} files=${files} labels=${false} kinds=${kind === 'all'} />
    </div>`) : html`<p class="bp-muted">No file matches.</p>`}
    ${cut ? html`<button type="button" class="bp-more-btn" onClick=${() => setAll(true)}>Show ${plural(shown.length - 4, 'earlier meeting')}</button>` : null}
  </section>`;
}

/**
 * SOARD's papers on shelves, as covers: governing documents, tax-exempt status, registrations and insurance
 * (by what each one is), then plans and anything else. Covers are drawn in CSS: no pictures, no gradients.
 */
const SHELVES = [
  { id: 'governing', label: 'Governing documents', sub: 'How SOARD is set up and run', test: /bylaw|article|incorporat|amend|manual|polic|conflict|whistle|charter|code of/i },
  { id: 'status', label: 'Tax-exempt status', sub: 'For donors, grants and vendors who ask', test: /501|determination|\bein\b|w-?9|exempt|\birs\b/i },
  { id: 'standing', label: 'Registrations and insurance', sub: 'Renewed each year', test: /permit|registration|insurance|d&o|licen|good standing|annual report/i },
];
const shelfOf = (x) => SHELVES.find((sh) => sh.test.test(x.title))?.id || (x.kind === 'plan' ? 'plan' : x.kind === 'financial' ? 'money' : x.kind === 'policy' ? 'governing' : 'other');
const MORE_SHELVES = [{ id: 'plan', label: 'Plans and reports', sub: '' }, { id: 'money', label: 'Budgets and audits', sub: '' }, { id: 'other', label: 'More', sub: '' }];
/** What a cover says it is, in a word or two */
function coverWord(title) {
  const t = String(title);
  for (const [re, w] of [[/bylaw/i, 'Bylaws'], [/articles of incorporation|certificate of incorporation/i, 'Articles of Incorporation'], [/amend/i, 'Amendment'], [/manual/i, 'Board Manual'], [/conflict/i, 'Conflict of Interest'], [/whistle/i, 'Whistleblower'], [/501|determination/i, 'IRS Letter'], [/\bein\b/i, 'EIN'], [/w-?9/i, 'W-9'], [/permit/i, 'Charitable Permit'], [/d&o|directors.*officers/i, 'D&O Insurance'], [/insurance/i, 'Insurance'], [/strateg/i, 'Strategic Plan'], [/budget/i, 'Budget'], [/audit/i, 'Audit']]) if (re.test(t)) return w;
  return t.length > 28 ? `${t.slice(0, 26).trim()}…` : t;
}
const yearOf = (x) => x.year || (String(x.title).match(/\b(19|20)\d{2}\b/) || [])[0] || '';
function Cover({ x, shelf }) {
  const [ref, src] = useFirstPage(x.file, 200);
  return html`<span class=${`bp-cover bp-cover--${shelf} ${src ? 'has-page' : ''}`} ref=${ref} aria-hidden="true">
    ${src ? html`<img class="bp-cover__page" src=${src} alt="" />` : null}
    <span class="bp-cover__org">Sunshine on a Ranney Day</span>
    <span class="bp-cover__word">${coverWord(x.title)}</span>
    <span class="bp-cover__rule"></span>
    ${yearOf(x) ? html`<span class="bp-cover__year">${yearOf(x)}</span>` : null}
    ${x.file ? html`<span class="bp-cover__fmt">${{ PDF: 'PDF', Excel: 'XLS', Word: 'DOC' }[formatOf(x.file)] || ''}</span>` : null}
  </span>`;
}

function DocumentsPage({ ctx }) {
  const { data } = ctx;
  const { docs } = data;
  const [q, setQ] = useState('');
  const terms = termsOf(q);
  const year = todayEastern().slice(0, 4);
  useFocusTarget();
  const toSign = docs.filter((x) => x.sign && x.file);
  const done = toSign.filter((x) => x.signedByMe).length;
  const found = (x) => !terms.length || hits(`${x.title} ${x.note} ${coverWord(x.title)}`, terms);
  const onShelves = docs.filter((x) => !(x.sign && x.file) && found(x));
  const shelves = [...SHELVES, ...MORE_SHELVES].map((sh) => ({ ...sh, list: onShelves.filter((x) => shelfOf(x) === sh.id) })).filter((sh) => sh.list.length);
  const withFile = docs.filter((x) => x.file);
  const vf = asViewer(withFile.map((x) => ({ ...x.file, name: x.title })));
  const open = (x) => (x.file ? viewerLink(vf, withFile.indexOf(x)) : { href: null });
  return html`
    <header class="bp-pagehead bp-rise" style=${rise(0)}>
      <div><h1 class="bp-h1">Documents</h1><p class="bp-lede">SOARD’s governing documents, its tax-exempt status, registrations and insurance, and every file from every meeting.</p></div>
      <label class="bp-filter">
        <${Icon} name="search" size=${18} /><span class="sr-only">Find a document</span>
        <input type="search" placeholder="Find a document or a file" value=${q} onInput=${(e) => setQ(e.target.value)} />
      </label>
    </header>
    ${toSign.length && data.me.slug && toSign.some(found) ? html`<section class="bp-card bp-gap bp-tosign bp-rise" style=${rise(1)} aria-labelledby="sign-h">
      <div class="bp-tosign__head">
        <${SecHead} id="sign-h" title="To read and sign" sub=${`Each board member signs these once a year. ${done === toSign.length ? `You’ve signed them all for ${year}. Thank you.` : `You’ve signed ${done} of ${toSign.length} for ${year}.`}`} />
        ${toSign.length > 1 ? html`<div class="bp-progress__track" role="progressbar" aria-valuemin="0" aria-valuemax=${toSign.length} aria-valuenow=${done} aria-label=${`Signed for ${year}`}><span style=${`--p:${(done / toSign.length) * 100}%`}></span></div>` : null}
      </div>
      <ul class="bp-signlist">${toSign.filter(found).map((x) => html`<li key=${x.id} class="bp-doc" id=${`doc-${x.id}`}>
        <a class="bp-signlist__cover" ...${open(x)} aria-label=${`Read ${x.title}`}><${Cover} x=${x} shelf=${shelfOf(x)} /></a>
        <div class="bp-signlist__body">
          <p class="bp-doc__title">${x.title}</p>
          <p class="bp-doc__meta">${[x.note, `${x.signedCount} of ${data.people.board.length} board members have signed for ${year}`].filter(Boolean).join(' · ')}</p>
          <p class="bp-btns bp-btns--tight"><a class="bp-btn bp-btn--sm" ...${open(x)}>Read it</a></p>
          <${SignForm} d=${x} ctx=${ctx} />
        </div>
      </li>`)}</ul>
    </section>` : null}
    ${shelves.length ? shelves.map((sh, i) => html`<section class="bp-shelfsec bp-rise" style=${rise(2 + i)} aria-labelledby=${`sh-${sh.id}`} key=${sh.id}>
      <${SecHead} id=${`sh-${sh.id}`} title=${sh.label} count=${sh.list.length} sub=${sh.sub} />
      <ul class="bp-shelf">${sh.list.map((x) => html`<li key=${x.id} id=${`doc-${x.id}`} class="bp-doc">
        <a class="bp-docc" ...${open(x)}>
          <${Cover} x=${x} shelf=${sh.id} />
          <span class="bp-docc__title">${x.title}</span>
          <span class="bp-docc__meta">${[x.note, x.file ? sizeText(x.file.size) : 'On its way'].filter(Boolean).join(' · ')}</span>
        </a>
      </li>`)}</ul>
    </section>`)
    : docs.length && terms.length ? null
    : html`<div class="bp-card bp-empty bp-empty--row bp-gap bp-rise" style=${rise(1)}>
      <span class="bp-empty__icon"><${Icon} name="documents" size=${24} /></span>
      <div><h2 class="bp-h2">Bylaws and policies show here</h2>
      <p class="bp-muted">${data.contact ? `Once ${firstName(data.contact.name)} adds them, they’re here to read.` : 'They’re here to read once they’re added.'} Anything to read and sign shows on Home too.</p></div>
    </div>`}
    <div class="bp-rise" style=${rise(6)}><${Library} data=${data} q=${q} /></div>`;
}

// ─── Search ─────────────────────────────────────────────────────────
const GROUPS = ['Meetings', 'Decisions', 'In agendas and minutes', 'Files', 'People', 'Documents', 'Coming up'];
function searchIndex(data, d) {
  const out = [];
  for (const m of [...data.meetings].sort((a, b) => b.date.localeCompare(a.date))) {
    const sub = `${meetingName(m)} · ${shortDate(m.date)}`;
    out.push({ group: 'Meetings', title: meetingName(m), sub: [longDate(m.date), m.location].filter(Boolean).join(' · '), hay: norm([meetingName(m), longDate(m.date), m.date, m.location].join(' ')), href: `#/meetings/${m.id}`, icon: 'meetings' });
    for (const s of m.sections) {
      // Notes read as one line in a result: "Recommending … · $300k revenue from golf"
      const said = (t) => String(t || '').split('\n').map((l) => l.replace(/^\s*[-•*]\s+/, '').trim()).filter(Boolean).join(' · ');
      // The part it's under says where it is ("2027 budget · Q4 2026 Board Meeting · Nov 5, 2026"), so a point found by its part's name says why
      for (const it of s.items) out.push({ group: 'In agendas and minutes', title: it.title || s.title, sub: s.title && it.title && norm(s.title) !== norm(it.title) && !/^agenda$/i.test(s.title.trim()) ? `${s.title} · ${sub}` : sub, body: said(it.notes) || it.title, hay: norm([s.title, it.title, it.presenter, it.notes].join(' ')), href: `#/meetings/${m.id}`, focus: `i-${it.id}`, icon: 'list' });
    }
    for (const x of m.motions) out.push({ group: 'Decisions', title: x.text, sub, hay: norm(x.text), href: `#/meetings/${m.id}`, icon: 'gavel' });
    const vf = asViewer(m.files);
    m.files.forEach((f, i) => out.push({ group: 'Files', title: titleOf(f.name), sub: `${kindLabel(f.kind)} · ${sub}`, hay: norm(`${titleOf(f.name)} ${kindLabel(f.kind)} ${meetingName(m)}`), file: [vf, i], icon: 'documents' }));
  }
  for (const p of d.people) out.push({ group: 'People', title: p.name, sub: [p.group === 'board' ? p.title || 'Board member' : p.group === 'advisory' ? 'Advisory Board' : p.title, p.organization].filter(Boolean).join(' · '), hay: norm([p.name, p.title, p.organization, ...(p.committees || [])].join(' ')), href: '#/people', focus: `p-${p.slug}`, person: p });
  const withFile = data.docs.filter((x) => x.file);
  const dv = asViewer(withFile.map((x) => ({ ...x.file, name: x.title })));
  for (const x of data.docs) out.push({ group: 'Documents', title: x.title, sub: DOC_KINDS.find((k) => k.id === x.kind)?.label || '', hay: norm([x.title, x.note].join(' ')), ...(x.file ? { file: [dv, withFile.indexOf(x)] } : { href: '#/documents' }), icon: 'documents' });
  const fv = data.filings.map((x) => ({ name: `${x.title}.pdf`, type: 'application/pdf', url: x.url }));
  data.filings.forEach((x, i) => out.push({ group: 'Files', title: x.title, sub: 'Tax return or audit', hay: norm(`${x.title} ${x.year} tax return form 990 audit`), file: [fv, i], icon: 'financials' }));
  for (const r of data.numbers.reveals) out.push({ group: 'Coming up', title: `${r.name}’s reveal`, sub: r.confirmed && r.date ? dayOf(r.date) : r.window?.label || 'Day not set yet', hay: norm(`${r.name} reveal`), href: r.kidUrl, ext: true, icon: 'home' });
  for (const e of data.numbers.events) out.push({ group: 'Coming up', title: e.title, sub: dayOf(e.date), hay: norm(`${e.title} event ${e.location}`), href: e.url, ext: true, icon: 'meetings' });
  return out;
}

function Finder({ ctx, onClose }) {
  const { data, d } = ctx;
  const [q, setQ] = useState('');
  const [at, setAt] = useState(0);
  const ref = useRef(null);
  const listRef = useRef(null);
  const index = useMemo(() => searchIndex(data, d), [data]);
  const terms = termsOf(q);
  const results = useMemo(() => {
    if (!terms.length) return [];
    const found = index.filter((x) => terms.every((w) => x.hay.includes(w)));
    const score = (x) => (norm(x.title).startsWith(terms[0]) ? 0 : terms.every((w) => norm(x.title).includes(w)) ? 1 : 2);
    return GROUPS.flatMap((g) => found.filter((x) => x.group === g).sort((a, b) => score(a) - score(b)).slice(0, g === 'In agendas and minutes' ? 6 : 5));
  }, [q, index]);
  useEffect(() => {
    const dlg = ref.current;
    if (!dlg) return undefined;
    if (!dlg.open) dlg.showModal();
    document.documentElement.classList.add('is-finding');
    return () => document.documentElement.classList.remove('is-finding');
  }, []);
  useEffect(() => { setAt(0); }, [q]);
  useEffect(() => { listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' }); }, [at]);
  const close = () => {
    const dlg = ref.current;
    if (!dlg || dlg.dataset.closing) return;
    if (reduceMotion()) { dlg.close(); return; }
    dlg.dataset.closing = '1';
    setTimeout(() => dlg.close(), 140);
  };
  const choose = (x) => {
    if (!x) return;
    close();
    if (x.file) { setTimeout(() => openViewer(x.file[0], x.file[1]), 160); return; }
    if (x.ext) { window.open(x.href, '_blank', 'noopener'); return; }
    focusNext = x.focus || null;
    if (location.hash === x.href) { window.dispatchEvent(new HashChangeEvent('hashchange')); return; }
    location.hash = x.href;
  };
  const keys = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setAt((i) => Math.min(results.length - 1, i + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setAt((i) => Math.max(0, i - 1)); }
    else if (e.key === 'Enter' && results[at]) { e.preventDefault(); choose(results[at]); }
    // A search field's own Escape only empties it; here Escape closes, the way every search box like this does
    else if (e.key === 'Escape') { e.preventDefault(); close(); }
  };
  const grouped = GROUPS.map((g) => ({ g, list: results.map((x, i) => ({ x, i })).filter(({ x }) => x.group === g) })).filter((x) => x.list.length);
  return html`<dialog class="bp-finder" ref=${ref} aria-label="Search the board page" onClose=${onClose} onCancel=${(e) => { e.preventDefault(); close(); }} onClick=${(e) => { if (e.target === ref.current) close(); }}>
    <div class="bp-finder__box">
      <div class="bp-finder__field">
        <${Icon} name="search" size=${20} />
        <input type="search" placeholder="Search meetings, minutes, files and people" value=${q} autofocus aria-label="Search" aria-controls=${results.length ? 'bp-finder-list' : null} aria-activedescendant=${results[at] ? `bp-r-${at}` : null} role="combobox" aria-autocomplete="list" aria-expanded=${!!results.length} onInput=${(e) => setQ(e.target.value)} onKeyDown=${keys} />
        <button type="button" class="bp-finder__x" onClick=${close} aria-label="Close search"><span class="bp-kbd bp-finder__esc">esc</span><span class="bp-finder__cancel">Cancel</span></button>
      </div>
      <div class="bp-finder__list" ref=${listRef}>
        ${!terms.length ? html`<div class="bp-finder__hint">
          <p>Try a name, a month, or a word from the minutes.</p>
          <p class="bp-finder__tries">${['budget', 'golf', 'minutes', data.people.board[0]?.name.split(' ')[0]].filter(Boolean).map((t) => html`<button type="button" class="bp-pill" onClick=${() => { setQ(t); ref.current?.querySelector('input')?.focus(); }} key=${t}>${t}</button>`)}</p>
        </div>` : !results.length ? html`<p class="bp-finder__none" role="status">Nothing found for “${q.trim()}”.</p>`
        : html`<div role="listbox" id="bp-finder-list" aria-label="Results">${grouped.map(({ g, list }) => html`<div role="group" aria-labelledby=${`bp-g-${GROUPS.indexOf(g)}`} key=${g}>
          <p class="bp-finder__group" id=${`bp-g-${GROUPS.indexOf(g)}`}>${g}</p>
          ${list.map(({ x, i }) => html`<div class="bp-finder__item" id=${`bp-r-${i}`} role="option" aria-selected=${i === at} onPointerMove=${() => at !== i && setAt(i)} onClick=${() => choose(x)} key=${i}>
            ${x.person ? html`<${Avatar} p=${x.person} size=${32} />` : html`<span class="bp-finder__icon"><${Icon} name=${x.icon || 'documents'} size=${18} /></span>`}
            <span class="bp-finder__text"><span class="bp-finder__title">${x.title}</span>${(() => {
              // A point's words where they matched; none when the match is its own name (it would only say it twice)
              const said = x.body && x.group === 'In agendas and minutes' && norm(x.body).trim() !== norm(x.title).trim();
              return html`${said ? html`<span class="bp-finder__sub"><${Snippet} text=${x.body} terms=${terms} /></span>` : null}<span class="bp-finder__sub">${x.sub}</span>`;
            })()}</span>
            ${x.ext ? html`<${Icon} name="external" size=${16} cls="bp-go" />` : html`<${Icon} name="arrow" size=${16} cls="bp-go" />`}
          </div>`)}
        </div>`)}</div>`}
      </div>
      <p class="bp-finder__foot" aria-hidden="true"><span><span class="bp-kbd">↑</span><span class="bp-kbd">↓</span> to move</span><span><span class="bp-kbd">enter</span> to open</span><span><span class="bp-kbd">esc</span> to close</span></p>
    </div>
  </dialog>`;
}

render(html`<${App} />`, document.getElementById('board-app'));
