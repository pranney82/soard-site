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
 * area's admins (who see it as the board does and can't answer for anyone).
 *
 *   #/             Home: the next meeting, your to-dos, the makeovers, what's coming up
 *   #/meetings     Meetings          #/meetings/<id>   one meeting
 *   #/financials   Financials        #/people          People
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
} from '../board-shared.js';

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
  mail: html`<rect x="3.5" y="5.5" width="17" height="13" rx="2" /><path d="m4 7 8 6 8-6" />`,
  copy: html`<rect x="8.5" y="8.5" width="11" height="11" rx="2" /><path d="M15.5 8.5V6A1.5 1.5 0 0 0 14 4.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5" />`,
  calendar: html`<rect x="3.5" y="5" width="17" height="15.5" rx="2" /><path d="M3.5 10h17M8 3v4M16 3v4M12 13v5M9.5 15.5h5" />`,
  print: html`<path d="M7 9V3.5h10V9M7 17.5H5A1.5 1.5 0 0 1 3.5 16v-5A1.5 1.5 0 0 1 5 9.5h14a1.5 1.5 0 0 1 1.5 1.5v5a1.5 1.5 0 0 1-1.5 1.5h-2" /><rect x="7" y="14" width="10" height="6.5" rx="1" />`,
  close: html`<path d="M6 6l12 12M18 6 6 18" />`,
  logout: html`<path d="M14 4.5h4A1.5 1.5 0 0 1 19.5 6v12a1.5 1.5 0 0 1-1.5 1.5h-4M10 16l-4-4 4-4M6 12h9" />`,
  external: html`<path d="M14 4.5h5.5V10M19.5 4.5 11 13M17 14v4.5a1 1 0 0 1-1 1H5.5a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1H10" />`,
  gavel: html`<path d="m13.5 4.5 6 6M11 7l6 6M12.25 5.75l-4.5 4.5M17.75 11.25l-4.5 4.5M10 12l-6.5 6.5M3.5 20.5h9" />`,
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
  const [page = '', id = null] = location.hash.replace(/^#\/?/, '').split('/').map((x) => decodeURIComponent(x));
  return { page: PAGES.includes(page) ? page : '', id: id || null };
};

// ─── Words and dates ────────────────────────────────────────────────
const noon = (d) => Date.parse(`${d}T12:00:00Z`);
const dayOf = (d) => (isDate(d) ? new Date(noon(d)).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' }) : '');
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

/** A Cloudflare photo at the size it's shown ("w=640,h=800,fit=cover"), through the site so it's same-origin */
function sized(url, transform) {
  const s = String(url || '');
  const m = s.match(/^(?:https:\/\/imagedelivery\.net|(?:https?:\/\/[^/]+)?\/cdn-cgi\/imagedelivery)\/([^/]+)\/(.+)$/);
  if (!m) return s;
  let id = m[2];
  const cut = id.lastIndexOf('/');
  if (cut > 0 && /=|^(public|thumbnail|avatar|hero|card)$/.test(id.slice(cut + 1))) id = id.slice(0, cut);
  return `/cdn-cgi/imagedelivery/${m[1]}/${id}/${transform}`;
}

// ─── Files ──────────────────────────────────────────────────────────
const fileUrl = (f) => `/api/board-file?id=${encodeURIComponent(f.id)}`;
const asViewer = (files) => files.map((f) => ({ name: f.name, type: f.type, size: f.size, at: f.at, url: f.url || fileUrl(f) }));
function formatOf(f) {
  const n = String(f?.name || '').toLowerCase();
  const t = String(f?.type || '').toLowerCase();
  if (t === 'application/pdf' || n.endsWith('.pdf')) return 'PDF';
  if (/sheet|excel|csv/.test(t) || /\.(xlsx?|csv)$/.test(n)) return 'Excel';
  if (/word/.test(t) || /\.docx?$/.test(n)) return 'Word';
  if (/presentation|powerpoint/.test(t) || /\.pptx?$/.test(n)) return 'Slides';
  if (t.startsWith('image/')) return 'Photo';
  return 'File';
}
const RANK = { PDF: 0, Word: 1, Slides: 2, Excel: 3, Photo: 4, File: 5 };
/** A file's title for reading: no extension, no "Sunshine on a Ranney Day" in front, no " (1) (1)" downloads added */
const titleOf = (name) => fileTitle(name).replace(/^(Sunshine on a Ranney Day|SOARD)\s+/i, '').replace(/(\s*\(\d+\))+$/, '').replace(/^./, (c) => c.toUpperCase());
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
const FileBadge = ({ f }) => { const fmt = formatOf(f); return html`<span class="bp-badge" data-format=${fmt} aria-hidden="true">${{ PDF: 'PDF', Excel: 'XLS', Word: 'DOC', Slides: 'PPT', Photo: 'IMG' }[fmt] || 'FILE'}</span>`; };

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
  const tile = el.querySelector('.bp-date[data-mid]') || el.closest('.bp-ticket, .bp-card')?.querySelector('.bp-date[data-mid]');
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
  const details = `The agenda and packet: ${location.origin}/admin/board/#/meetings/${m.id}${videoOf(m) ? `\nVideo: ${videoOf(m)}` : ''}`;
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
  const page = route.page === 'meetings' && route.id ? html`<${MeetingPage} id=${route.id} ctx=${ctx} key=${route.id} />`
    : route.page === 'meetings' ? html`<${MeetingsPage} ctx=${ctx} />`
    : route.page === 'financials' ? html`<${FinancialsPage} ctx=${ctx} />`
    : route.page === 'people' ? html`<${PeoplePage} ctx=${ctx} />`
    : route.page === 'documents' ? html`<${DocumentsPage} ctx=${ctx} />`
    : html`<${HomePage} ctx=${ctx} />`;
  return html`
    <a class="bp-skip" href="#main" onClick=${(e) => { e.preventDefault(); document.getElementById('main')?.focus(); }}>Skip to the page</a>
    ${data.me.admin ? html`<p class="bp-banner"><span>You’re seeing the board page the way board members do. Their answers, ticks and signatures are theirs to give.</span> <a href="/admin/#board">Back to the Board area</a></p>` : null}
    <header class="bp-top">
      <div class="bp-bar">
        <a class="bp-brand" href="#/" aria-label="SOARD Board, Home"><img src=${LOGO} alt="" width="44" height="44" /><span class="bp-brand__words"><strong>Sunshine on a Ranney Day</strong><small>Board of Directors</small></span></a>
        <${Nav} page=${route.page} />
        <div class="bp-tools">
          <button type="button" class="bp-find" onClick=${() => setFinding(true)} aria-label="Search the board page" aria-keyshortcuts="Meta+K Control+K /">
            <${Icon} name="search" size=${18} /><span class="bp-find__label">Search</span><kbd class="bp-kbd">${/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘K' : 'Ctrl K'}</kbd>
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
function Account({ data, d }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') { setOpen(false); ref.current?.querySelector('button')?.focus(); } };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  const name = data.me.name || 'Viewing as the board';
  return html`<div class="bp-me" ref=${ref}>
    <button type="button" class="bp-me__btn" aria-expanded=${open} aria-haspopup="true" aria-label=${`Your account: ${name}`} onClick=${() => setOpen(!open)}>
      ${d.me ? html`<${Avatar} p=${d.me} size=${36} />` : html`<span class="bp-avatar bp-avatar--initials" style="--s:36px;--hue:42" aria-hidden="true">${data.me.name ? initialsOf(data.me.name) : 'B'}</span>`}
      <span class="bp-me__name">${data.me.name ? firstName(data.me.name) : 'Board view'}</span>
    </button>
    <div class=${`bp-menu ${open ? 'is-open' : ''}`} role="menu" hidden=${!open}>
      <div class="bp-menu__who"><strong>${name}</strong>${data.me.email ? html`<span>${data.me.email}</span>` : data.me.title ? html`<span>${data.me.title}</span>` : null}</div>
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
    : html`<span class=${`bp-avatar bp-avatar--initials ${ring ? 'bp-avatar--ring' : ''}`} style=${`${style};--hue:${hueOf(name)}`} aria-hidden="true">${initialsOf(name)}</span>`;
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

// ─── Home ───────────────────────────────────────────────────────────
function summary(data, d) {
  const m = d.featured;
  const bits = [];
  const phase = m?.date === data.today ? phaseOf(m) : null;
  if (m) bits.push(phase === 'now' ? 'The board is meeting now.' : m.date === data.today ? `The board meets today${m.start ? ` at ${clock(m.start)}` : ''}.` : `The next board meeting is ${dayOf(m.date)}${m.start ? ` at ${clock(m.start)}` : ''}.`);
  const b = (data.numbers.projects?.building || []).length;
  const r = data.numbers.reveals.length;
  const builds = `${countWord(b)} ${b === 1 ? 'makeover is' : 'makeovers are'} underway`;
  const reveals = `${r === 1 ? 'one reveal is' : `${countWord(r).toLowerCase()} reveals are`} coming up`;
  if (b && r) bits.push(`${builds}, and ${reveals}.`);
  else if (b) bits.push(`${builds}.`);
  else if (r) bits.push(`${reveals[0].toUpperCase()}${reveals.slice(1)}.`);
  return bits.join(' ') || 'Everything for SOARD’s board in one place: meetings, money, people and documents.';
}

function HomePage({ ctx }) {
  const { data, d } = ctx;
  const mine = data.actions.filter((a) => a.mine);
  const toSign = data.docs.filter((x) => x.sign && x.file && !x.signedByMe);
  const today = new Date(noon(data.today)).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
  return html`
    <section class="bp-hero">
      <div class="bp-hero__text">
        <p class="bp-eyebrow bp-rise" style=${rise(0)}>${today}</p>
        <h1 class="bp-display bp-rise" style=${rise(1)}>${data.me.name ? html`${greeting()}, <span class="bp-nowrap">${firstName(data.me.name)}.</span>` : 'The board page'}</h1>
        <p class="bp-hero__lede bp-rise" style=${rise(2)}>${summary(data, d)}</p>
        <div class="bp-rise" style=${rise(3)}>${d.featured ? html`<${NextMeeting} m=${d.featured} ctx=${ctx} />` : html`<${NoMeeting} ctx=${ctx} />`}</div>
      </div>
      <${HeroPhotos} n=${data.numbers} today=${data.today} />
    </section>
    ${mine.length || toSign.length ? html`<section class="bp-band bp-rise" style=${rise(4)} aria-labelledby="todo-h">
      <${SecHead} id="todo-h" title="For you" count=${mine.length + toSign.length} sub="Ticked off here, they’re off everyone’s list." />
      <ul class="bp-todos">
        ${mine.map((a) => html`<${MyAction} a=${a} ctx=${ctx} key=${a.id} />`)}
        ${toSign.map((x) => html`<li class="bp-todo-card" key=${x.id}><a class="bp-todo bp-todo--link" href="#/documents" onClick=${() => { focusNext = `doc-${x.id}`; }}>
          <span class="bp-todo__icon"><${Icon} name="documents" size=${20} /></span>
          <span class="bp-todo__text"><span class="bp-todo__title">Read and sign: ${x.title}</span><span class="bp-todo__meta">Every board member signs it once a year</span></span>
          <${Icon} name="arrow" size=${18} cls="bp-go" />
        </a></li>`)}
      </ul>
    </section>` : null}
    <div class="bp-rise" style=${rise(5)}><${Makeovers} n=${data.numbers} /></div>
    <div class="bp-split">
      <div class="bp-stack bp-rise" style=${rise(6)}><${ComingUp} data=${data} d=${d} /></div>
      <div class="bp-stack bp-rise" style=${rise(7)}>
        ${d.last ? html`<${LastMeeting} m=${d.last} ctx=${ctx} />` : null}
        <${Glance} n=${data.numbers} />
        <${Recent} n=${data.numbers} />
      </div>
    </div>`;
}

/** Families being built for right now, in their own photos (a different one leads each day) */
function HeroPhotos({ n, today }) {
  // Kids only: community projects never lead Home (Peter, Oct 28 2026)
  const withPhoto = (n.projects?.building || []).filter((b) => b.photo && b.name && b.kind !== 'community');
  const stats = n.impact;
  if (!withPhoto.length) {
    return html`<aside class="bp-hero__panel bp-rise" style=${rise(2)} aria-label="SOARD at a glance">
      <p class="bp-hero__big">${stats.kids.toLocaleString()}</p><p>children served since 2012</p>
      <p class="bp-hero__big">${stats.rooms.toLocaleString()}</p><p>rooms built</p>
    </aside>`;
  }
  const order = ['Build', 'Mobilization', 'Approval', 'Finalization', 'Design'];
  const ranked = [...withPhoto].sort((a, b) => order.indexOf(a.status) - order.indexOf(b.status));
  const at = Math.floor(noon(today) / 86400000) % ranked.length;
  const lead = ranked[at];
  const second = ranked.length > 1 ? ranked[(at + 1) % ranked.length] : null;
  const href = (b) => (b.kind === 'community' ? b.url : b.url || `/kids/${b.slug}/`);
  return html`<figure class="bp-hero__photos bp-rise" style=${rise(2)}>
    <span class="bp-hero__accent" aria-hidden="true"></span>
    <a class="bp-hero__main" href=${href(lead)} target="_blank" rel="noopener">
      <img src=${sized(lead.photo, 'w=720,h=900,fit=cover,gravity=auto')} alt=${`${lead.name}, whose makeover is in ${lead.status.toLowerCase()}`} width="360" height="450" decoding="async" fetchpriority="high" />
    </a>
    ${second ? html`<a class="bp-hero__small" href=${href(second)} target="_blank" rel="noopener" aria-label=${second.name}>
      <img src=${sized(second.photo, 'w=320,h=320,fit=cover,gravity=auto')} alt="" width="150" height="150" decoding="async" />
    </a>` : null}
    <div class="bp-hero__badge"><strong>${stats.kids.toLocaleString()}</strong><span>children served since 2012</span></div>
    <figcaption class="bp-hero__cap"><span class="bp-dot" aria-hidden="true"></span>${lead.name} · ${lead.status === 'Build' ? 'being built now' : `in ${lead.status.toLowerCase()}`}</figcaption>
  </figure>`;
}

function NoMeeting({ ctx }) {
  return html`<section class="bp-ticket bp-ticket--empty bp-next" aria-labelledby="next-h">
    <div class="bp-ticket__body">
      <p class="bp-eyebrow">Next board meeting</p>
      <h2 class="bp-when" id="next-h">Not on the calendar yet</h2>
      <p class="bp-muted">The invite comes to ${ctx.data.me.email ? html`<strong>${ctx.data.me.email}</strong>` : 'your email'} once the day is set, and it shows here.</p>
    </div>
  </section>`;
}

function NextMeeting({ m, ctx, compact = false }) {
  const { data } = ctx;
  const today = m.date === data.today;
  const [, setNow] = useState(0);
  useEffect(() => { if (!today) return undefined; const t = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(t); }, [today]);
  const phase = today ? phaseOf(m) : null;
  const video = videoOf(m);
  const fileCount = fileRows(m.files || []).reduce((s, g) => s + g.rows.length, 0);
  const status = today ? (phase === 'now' ? 'Happening now' : phase === 'after' ? 'Earlier today' : m.start ? `Today at ${clock(m.start)}` : 'Today') : inWords(m.date, data.today);
  return html`<section class=${`bp-ticket bp-next ${today ? 'is-today' : ''} ${compact ? 'bp-ticket--compact' : ''}`} aria-labelledby=${`next-h-${m.id}`}>
    <div class="bp-ticket__date"><${DateTile} d=${m.date} mid=${m.id} big /></div>
    <div class="bp-ticket__body">
      <p class="bp-eyebrow">${today ? 'Today’s board meeting' : 'Next board meeting'}<span class=${`bp-soon ${phase === 'now' ? 'is-live' : ''}`}>${phase === 'now' ? html`<span class="bp-live-dot" aria-hidden="true"></span>` : null}${status}</span></p>
      <h2 class="bp-when" id=${`next-h-${m.id}`}>${compact ? meetingName(m) : dayOf(m.date)}</h2>
      <ul class="bp-facts">
        ${compact ? html`<li><${Icon} name="meetings" /><span>${dayOf(m.date)}</span></li>` : null}
        <li><${Icon} name="clock" /><span>${m.start ? timeRange(m.start, m.end) : 'Time to come'}</span></li>
        <li><${Icon} name="pin" /><span>${m.location || m.address
          ? html`${m.location}${m.location && m.address ? html`<br />` : null}${m.address ? html`<a href=${mapsHref(m.address)} target="_blank" rel="noopener">${m.address}</a>` : null}`
          : 'Place to come. Your invite updates when it’s set.'}</span></li>
        ${video && !(today && phase !== 'after') ? html`<li><${Icon} name="video" /><span><a href=${video} target="_blank" rel="noopener">${joinLabel(video)}</a>${today ? '' : ' if you can’t be there in person'}</span></li>` : null}
      </ul>
      <div class="bp-btns">
        ${today && video && phase !== 'after' ? html`<a class="bp-btn bp-btn--primary" href=${video} target="_blank" rel="noopener"><${Icon} name="video" />${joinLabel(video)}</a>` : null}
        ${m.pending ? html`<p class="bp-pending"><${Icon} name="documents" size=${18} />The agenda and packet post here before the meeting.</p>`
          : html`<a class=${`bp-btn ${today && video && phase !== 'after' ? '' : 'bp-btn--primary'}`} href=${`#/meetings/${m.id}`} onClick=${claimMorph}>See the agenda${fileCount ? ` and ${plural(fileCount, 'file')}` : ''}<${Icon} name="arrow" size=${18} cls="bp-go" /></a>`}
      </div>
      <${OnCalendar} m=${m} data=${data} />
      <${Rsvp} m=${m} ctx=${ctx} />
    </div>
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

function Rsvp({ m, ctx }) {
  const { data, setData, say } = ctx;
  const [busy, setBusy] = useState('');
  const [thanks, setThanks] = useState(false);
  if (m.date < data.today) return null;
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
      ${RSVP.map((r) => html`<button type="button" class="bp-choice" aria-pressed=${m.myRsvp === r.id} disabled=${!!busy || !data.me.slug} onClick=${() => answer(r.id)} key=${r.id}>
        ${m.myRsvp === r.id ? html`<${Icon} name="check" size=${16} cls="bp-choice__check" />` : null}${busy === r.id ? 'Saving…' : r.label}</button>`)}
    </div>
    <p class="bp-rsvp__said">${!data.me.slug ? 'Board members answer here.'
      : chosen ? (thanks ? `Thanks. ${team} can see your answer.` : `You said “${chosen.ask}.” You can change it any time.`)
      : onInvite ? `You answered the calendar invite: ${onInvite}. Tap one to tell ${team} here too.`
      : `Tap one. ${team} see your answer.`}</p>
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
    <span class="bp-todo__text"><span class="bp-todo__title">${a.text}</span><span class="bp-todo__meta">${[a.due ? `Due ${shortDate(a.due)}` : '', `From the ${a.meetingName}`].filter(Boolean).join(' · ')}</span></span>
  </label></li>`;
}

/** Where every makeover stands: JobTread's stages, left to right */
const PIPE = ['Design', 'Finalization', 'Approval', 'Mobilization', 'Build'];
const projectHref = (b) => (b.kind === 'community' ? b.url || '' : b.url || (b.slug ? `/kids/${b.slug}/` : ''));
function Makeovers({ n }) {
  const building = n.projects?.building || [];
  const stages = [...PIPE.filter((st) => st !== 'Finalization' || building.some((b) => b.status === st)), ...new Set(building.map((b) => b.status).filter((st) => !PIPE.includes(st)))];
  const revealOf = (b) => (b.slug ? n.reveals.find((r) => r.slug === b.slug) : null);
  const when = (r) => (!r ? '' : r.confirmed && r.date ? `Reveal ${shortDate(r.date).replace(/, \d{4}$/, '')}` : r.window?.label ? `Reveal ${r.window.label}` : 'Reveal date to come');
  return html`<section class="bp-card bp-pipe" aria-labelledby="pipe-h">
    <${SecHead} id="pipe-h" title="Makeovers in progress" count=${building.length || null} sub=${n.projects ? 'Where each one stands, from JobTread' : 'The list from JobTread isn’t available right now.'} />
    ${n.projects ? html`<ol class="bp-pipe__stages" style=${`--n:${stages.length}`}>
      ${stages.map((st) => {
        const list = building.filter((b) => b.status === st);
        const named = list.filter((b) => b.name);
        const kids = list.filter((b) => !b.name && b.kind !== 'community').length;
        const orgs = list.filter((b) => !b.name && b.kind === 'community').length;
        return html`<li class=${`bp-stage ${list.length ? 'is-on' : ''}`} key=${st}>
          <div class="bp-stage__head"><span class="bp-stage__dot" aria-hidden="true"></span><span class="bp-stage__name">${st}</span>${list.length ? html`<span class="bp-stage__n">${list.length}</span>` : null}</div>
          <ul class="bp-stage__list">
            ${named.map((b) => { const href = projectHref(b); const r = revealOf(b); const inner = html`<${Avatar} p=${{ name: b.name, photo: b.photo ? sized(b.photo, 'w=96,h=96,fit=cover,gravity=auto') : '' }} size=${40} /><span class="bp-kid__text"><span class="bp-kid__name">${b.name}</span><span class="bp-kid__meta">${when(r) || (b.kind === 'community' ? 'Community project' : '')}</span></span>`;
              return html`<li key=${b.slug || b.name}>${href ? html`<a class="bp-kid" href=${href} target="_blank" rel="noopener">${inner}</a>` : html`<span class="bp-kid">${inner}</span>`}</li>`; })}
            ${kids ? html`<li><span class="bp-kid bp-kid--quiet"><span class="bp-avatar bp-avatar--blank" style="--s:40px" aria-hidden="true"></span><span class="bp-kid__text"><span class="bp-kid__name">${named.length ? `${kids} more ${kids === 1 ? 'family' : 'families'}` : plural(kids, 'family', 'families')}</span><span class="bp-kid__meta">Named once their page is up</span></span></span></li>` : null}
            ${orgs ? html`<li><span class="bp-kid bp-kid--quiet"><span class="bp-avatar bp-avatar--blank" style="--s:40px" aria-hidden="true"></span><span class="bp-kid__text"><span class="bp-kid__name">${plural(orgs, 'community project')}</span><span class="bp-kid__meta">Named once it’s published</span></span></span></li>` : null}
            ${list.length ? null : html`<li class="bp-stage__none">None right now</li>`}
          </ul>
        </li>`;
      })}
    </ol>` : null}
  </section>`;
}

/** Reveals, events and board meetings from today on, by month */
function ComingUp({ data, d }) {
  const n = data.numbers;
  const [all, setAll] = useState(false);
  const rows = [
    ...n.reveals.map((r) => ({ key: `r-${r.slug}`, sort: r.confirmed && r.date ? r.date : (windowStart(r.window) || r.date || '9999'), date: r.confirmed ? r.date : '', window: r.confirmed ? null : r.window, kind: 'Reveal', title: `${r.name}’s reveal`, href: r.kidUrl, ext: true, photo: r.photo, when: r.confirmed ? [dayOf(r.date), r.time ? clock(r.time) : ''].filter(Boolean).join(' · ') : 'Day not set yet' })),
    ...n.events.map((e) => ({ key: `e-${e.slug}`, sort: e.date, date: e.date, kind: 'Event', title: e.title, href: e.url, ext: true, when: [dayOf(e.date), e.time, e.location].filter(Boolean).join(' · ') })),
    ...data.meetings.filter((m) => m.date >= data.today && m.id !== d.featured?.id).map((m) => ({ key: `m-${m.id}`, sort: m.date, date: m.date, kind: 'Board', title: meetingName(m), href: `#/meetings/${m.id}`, mid: m.id, when: [dayOf(m.date), m.start ? clock(m.start) : ''].filter(Boolean).join(' · ') })),
  ].sort((a, b) => String(a.sort).localeCompare(String(b.sort)));
  const shown = all ? rows : rows.slice(0, 7);
  const months = [...new Set(shown.map((r) => String(r.sort).slice(0, 7)))];
  const year = data.today.slice(0, 4);
  return html`<section class="bp-card" aria-labelledby="coming-h" id="coming-up">
    <${SecHead} id="coming-h" title="Coming up" sub="Reveals, events and meetings ahead" />
    ${rows.length ? months.map((ym) => html`<div class="bp-month" key=${ym}>
      <h3 class="bp-month__label">${/^\d{4}-\d{2}$/.test(ym) ? (ym.startsWith(year) ? monthName(ym) : monthOf(ym)) : 'Later'}</h3>
      <ul class="bp-rows">${shown.filter((r) => String(r.sort).slice(0, 7) === ym).map((r) => html`<li key=${r.key}>
        <a class="bp-row" href=${r.href} target=${r.ext ? '_blank' : null} rel=${r.ext ? 'noopener' : null} onClick=${r.mid ? claimMorph : null}>
          ${r.date ? html`<${DateTile} d=${r.date} mid=${r.mid || null} />` : html`<${WindowTile} w=${r.window} />`}
          <span class="bp-row__main"><span class="bp-row__title">${r.title}</span><span class="bp-row__meta">${r.when}</span></span>
          ${r.photo ? html`<${Avatar} p=${{ name: r.title, photo: sized(r.photo, 'w=80,h=80,fit=cover,gravity=auto') }} size=${36} />` : html`<span class=${`bp-tag bp-tag--${r.kind.toLowerCase()}`}>${r.kind}</span>`}
        </a>
      </li>`)}</ul>
    </div>`) : html`<p class="bp-muted">Nothing on the calendar yet.</p>`}
    ${rows.length > 7 ? html`<button type="button" class="bp-more-btn" onClick=${() => setAll(!all)} aria-expanded=${all}>${all ? 'Show fewer' : `Show all ${rows.length}`}</button>` : null}
    ${n.reveals.length ? html`<p class="bp-note">${data.me.email ? html`Each reveal comes to <strong>${data.me.email}</strong> as a calendar invite with the address, and moves there if the day changes.` : 'Each board member gets a calendar invite with the address for every reveal.'}</p>` : null}
  </section>`;
}

function LastMeeting({ m, ctx }) {
  const { d } = ctx;
  const c = attendanceCounts(m);
  const here = m.attendance.filter((p) => p.status === 'present' || p.status === 'remote').map((p) => d.bySlug.get(p.slug) || p);
  const decided = m.motions.length;
  return html`<a class="bp-card bp-card--link bp-last" href=${`#/meetings/${m.id}`} onClick=${claimMorph}>
    <p class="bp-eyebrow">Last meeting</p>
    <div class="bp-last__row">
      <${DateTile} d=${m.date} mid=${m.id} />
      <div class="bp-last__text"><h2 class="bp-last__title">${meetingName(m)}</h2><p class="bp-muted">${longDate(m.date)}</p></div>
    </div>
    <div class="bp-last__foot">
      ${here.length ? html`<${Faces} people=${here} max=${5} size=${30} />` : null}
      <span class="bp-last__facts">${[c.boardHere ? `${c.boardHere} of ${c.board} board members there` : '', decided ? plural(decided, 'decision') : ''].filter(Boolean).join(' · ')}</span>
    </div>
    <div class="bp-last__end"><${MinutesChip} m=${m} /><span class="bp-card__go">${m.minutes === 'approved' ? 'Read the minutes' : 'See the meeting'}<${Icon} name="arrow" size=${18} cls="bp-go" /></span></div>
  </a>`;
}

/** SOARD's own numbers, set flat: no counting up */
function Glance({ n }) {
  const stats = [
    [n.impact.kids.toLocaleString(), 'children served since 2012'],
    [n.impact.rooms.toLocaleString(), 'rooms built'],
    n.impact.communityProjects ? [n.impact.communityProjects.toLocaleString(), 'community projects'] : null,
    n.impact.reached ? [n.impact.reached.toLocaleString(), 'children impacted through community projects'] : null,
    n.cash ? [money(n.cash.total), `in Mercury${n.cash.at ? `, ${shortDate(n.cash.at.slice(0, 10))}` : ''}`] : null,
  ].filter(Boolean);
  return html`<section class="bp-card bp-glance" aria-labelledby="glance-h">
    <h2 class="bp-h2" id="glance-h">SOARD at a glance</h2>
    <dl class="bp-glance__grid">${stats.map(([v, label]) => html`<div key=${label}><dd>${v}</dd><dt>${label}</dt></div>`)}</dl>
  </section>`;
}

function Recent({ n }) {
  const rows = [
    ...n.pastReveals.map((r) => ({ key: `r-${r.slug}`, date: r.date, title: `${r.name}’s reveal`, href: r.kidUrl, photo: r.photo })),
    ...(n.recentEvents || []).map((e) => ({ key: `e-${e.slug}`, date: e.date, title: e.title, href: e.url })),
  ].sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 4);
  if (!rows.length) return null;
  return html`<section class="bp-card" aria-labelledby="recent-h">
    <h2 class="bp-h2" id="recent-h">Recently</h2>
    <ul class="bp-rows">${rows.map((r) => html`<li key=${r.key}><a class="bp-row" href=${r.href} target="_blank" rel="noopener">
      <${DateTile} d=${r.date} />
      <span class="bp-row__main"><span class="bp-row__title">${r.title}</span><span class="bp-row__meta">${dayOf(r.date)}</span></span>
      ${r.photo ? html`<${Avatar} p=${{ name: r.title, photo: sized(r.photo, 'w=80,h=80,fit=cover,gravity=auto') }} size=${36} />` : html`<${Icon} name="external" size=${18} cls="bp-go" />`}
    </a></li>`)}</ul>
  </section>`;
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

function MeetingRow({ m, data, terms = [] }) {
  const c = attendanceCounts(m);
  const ahead = m.date >= data.today;
  const hit = terms.length ? meetingTexts(m).find((x, i) => i > 0 && hits(x.text, terms)) : null;
  return html`<li key=${m.id}><a class="bp-mrow" href=${`#/meetings/${m.id}`} onClick=${claimMorph}>
    <${DateTile} d=${m.date} mid=${m.id} />
    <span class="bp-mrow__main">
      <span class="bp-mrow__title">${meetingName(m)}</span>
      <span class="bp-mrow__meta">${[dayOf(m.date), m.start ? clock(m.start) : '', m.location].filter(Boolean).join(' · ')}</span>
      ${hit ? html`<span class="bp-hit"><span class="bp-hit__where">${hit.where}</span> <${Snippet} text=${hit.text} terms=${terms} /></span>` : null}
    </span>
    <span class="bp-mrow__chips">
      ${ahead ? html`<span class="bp-chip bp-chip--info">${inWords(m.date, data.today)}</span>` : html`<${MinutesChip} m=${m} />`}
      ${!ahead && c.boardHere ? html`<span class="bp-chip bp-chip--plain">${c.boardHere} of ${c.board} there</span>` : null}
      ${m.files.length ? html`<span class="bp-chip bp-chip--plain">${plural(fileRows(m.files).reduce((s, g) => s + g.rows.length, 0), 'file')}</span>` : null}
    </span>
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
    ${d.featured && !terms.length ? html`<div class="bp-rise" style=${rise(1)}><${NextMeeting} m=${d.featured} ctx=${ctx} compact /></div>` : null}
    ${upcoming.length && !terms.length ? html`<section class="bp-card bp-gap bp-rise" style=${rise(2)} aria-labelledby="up-h"><h2 class="bp-h2" id="up-h">Also ahead</h2><ol class="bp-mlist">${upcoming.map((m) => html`<${MeetingRow} m=${m} data=${data} key=${m.id} />`)}</ol></section>` : null}
    <section class="bp-archive bp-rise" style=${rise(3)} aria-labelledby="past-h">
      <h2 class="sr-only" id="past-h">Past meetings</h2>
      ${terms.length ? html`<p class="bp-found" role="status">${past.length ? `${plural(past.length, 'meeting')} mention “${q.trim()}”` : `No meeting mentions “${q.trim()}”.`}</p>` : null}
      ${years.map((y) => html`<div class="bp-year" key=${y}>
        <h3 class="bp-year__label">${y}</h3>
        <ol class="bp-mlist">${past.filter((m) => m.date.startsWith(y)).map((m) => html`<${MeetingRow} m=${m} data=${data} terms=${terms} key=${m.id} />`)}</ol>
      </div>`)}
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

/** "On this page": the agenda's sections, the one you're reading marked */
function Outline({ sections }) {
  const [at, setAt] = useState(sections[0]?.id || '');
  useEffect(() => {
    const els = sections.map((s) => document.getElementById(`s-${s.id}`)).filter(Boolean);
    if (!els.length || !('IntersectionObserver' in window)) return undefined;
    const seen = new Map();
    const io = new IntersectionObserver((entries) => {
      for (const e of entries) seen.set(e.target.id, e.isIntersecting);
      const first = els.find((el) => seen.get(el.id));
      if (first) setAt(first.id.slice(2));
    }, { rootMargin: '-90px 0px -55% 0px' });
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [sections.map((s) => s.id).join()]);
  const go = (e, id) => {
    e.preventDefault();
    document.getElementById(`s-${id}`)?.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' });
  };
  return html`<nav class="bp-card bp-outline" aria-label="The agenda">
    <p class="bp-outline__label">On this page</p>
    <ol>${sections.map((s, i) => html`<li key=${s.id}><a href=${`#s-${s.id}`} aria-current=${at === s.id ? 'true' : null} onClick=${(e) => go(e, s.id)}><span>${i + 1}</span>${s.title || 'Agenda'}</a></li>`)}</ol>
  </nav>`;
}

function MeetingPage({ id, ctx }) {
  const { data, d } = ctx;
  const m = data.meetings.find((x) => x.id === id) || (d.featured?.pending && d.featured.id === id ? d.featured : null);
  useFocusTarget();
  if (!m) {
    return html`<a class="bp-back" href="#/meetings"><${Icon} name="back" size=${18} />All meetings</a>
      <div class="bp-card bp-empty"><h1 class="bp-h2">That meeting isn’t on the board page</h1><p class="bp-muted">It may not be shared yet.</p></div>`;
  }
  const upcoming = m.date >= data.today;
  // A past meeting shows only the numbers locked into its packet; one ahead shows today's until then
  const numbers = m.snapshot || (upcoming ? data.numbers : null);
  const c = attendanceCounts(m);
  const person = (p) => d.bySlug.get(p.slug) || p;
  const here = m.attendance.filter((p) => p.status === 'present' || p.status === 'remote');
  const away = m.attendance.filter((p) => p.status === 'absent' || p.status === 'excused');
  const files = m.files.filter((f) => f.kind !== 'signed');
  const signed = m.files.find((f) => f.kind === 'signed');
  const minutesFile = m.files.find((f) => f.kind === 'minutes');
  const video = upcoming ? videoOf(m) : '';
  const isNext = upcoming && m.id === d.featured?.id;
  const sections = m.sections.filter((s) => s.title || s.items.length);
  const hasAgenda = sections.some((s) => s.items.length);
  const i = d.byDate.findIndex((x) => x.id === m.id);
  const before = i > 0 ? d.byDate[i - 1] : null;
  const after = i >= 0 && i < d.byDate.length - 1 ? d.byDate[i + 1] : null;
  const quorum = data.quorum ? c.boardHere >= data.quorum : null;
  const motionChip = (r) => html`<span class=${`bp-chip ${r === 'passed' ? 'bp-chip--ok' : r === 'failed' ? 'bp-chip--warn' : ''}`}>${r === 'passed' ? html`<${Icon} name="check" size=${14} />` : null}${{ passed: 'Passed', failed: 'Did not pass', tabled: 'Tabled' }[r] || 'Recorded'}</span>`;
  return html`
    <a class="bp-back bp-noprint" href="#/meetings"><${Icon} name="back" size=${18} />All meetings</a>
    <header class="bp-mhead">
      <${DateTile} d=${m.date} big head />
      <div class="bp-mhead__text">
        <p class="bp-eyebrow">${upcoming ? (m.pending ? 'Agenda coming' : 'Agenda') : m.minutes === 'approved' ? 'Minutes' : 'Draft minutes'}${upcoming ? html`<span class="bp-soon">${inWords(m.date, data.today)}</span>` : null}</p>
        <h1 class="bp-h1">${meetingName(m)}</h1>
        <p class="bp-mhead__meta">${[longDate(m.date), timeRange(m.start, m.end), m.location].filter(Boolean).join(' · ')}</p>
        ${upcoming ? null : html`<p class="bp-status">${m.minutes === 'approved'
          ? html`<${MinutesChip} m=${m} />${m.approvedOn ? html`<span>by the board, ${shortDate(m.approvedOn)}</span>` : null}${signed ? html`<a class="bp-link" ...${viewerLink(asViewer([signed]), 0)}>The signed copy</a>` : null}`
          : html`<span class="bp-chip">Draft minutes</span><span>The board votes on them at the next meeting.</span>`}</p>`}
      </div>
      <div class="bp-mhead__actions bp-noprint">
        ${video ? html`<a class=${`bp-btn ${m.date === data.today ? 'bp-btn--primary' : ''}`} href=${video} target="_blank" rel="noopener"><${Icon} name="video" />${joinLabel(video)}</a>` : null}
        <button type="button" class="bp-btn bp-btn--quiet" onClick=${() => window.print()}><${Icon} name="print" size=${18} />Print or save as PDF</button>
      </div>
    </header>
    <div class=${`bp-meeting ${upcoming ? '' : 'is-past'}`}>
      <aside class="bp-meeting__top bp-stack">
        ${isNext ? html`<div class="bp-card bp-noprint">
          <ul class="bp-facts bp-facts--tight">
            ${m.address ? html`<li><${Icon} name="pin" /><span>${m.location ? html`${m.location}<br />` : null}<a href=${mapsHref(m.address)} target="_blank" rel="noopener">${m.address}</a></span></li>` : null}
          </ul>
          <${OnCalendar} m=${m} data=${data} />
          <${Rsvp} m=${m} ctx=${ctx} />
        </div>` : null}
        ${files.length ? html`<section class="bp-card" aria-labelledby="files-h"><h2 class="bp-h2" id="files-h">${upcoming ? 'The packet' : 'Files'}<span class="bp-count">${fileRows(files).reduce((s, g) => s + g.rows.length, 0)}</span></h2>
          <${FileList} files=${files} order=${upcoming ? AHEAD_ORDER : PAST_ORDER} />
        </section>` : null}
        ${!upcoming && c.boardHere ? html`<section class="bp-card bp-who" aria-labelledby="who-h"><h2 class="bp-h2" id="who-h">Who was there</h2>
          <p class="bp-who__count"><strong>${c.boardHere} of ${c.board}</strong> board members${quorum === true ? html` <span class="bp-chip bp-chip--ok"><${Icon} name="check" size=${14} />A quorum</span>` : ''}</p>
          <ul class="bp-who__list">${here.map((p) => html`<li key=${p.slug || p.name}><${Avatar} p=${person(p)} size=${32} /><span>${p.name}${p.status === 'remote' ? html` <small>by video</small>` : null}</span></li>`)}</ul>
          ${away.length ? html`<p class="bp-muted bp-who__away">Not there: ${away.map((p) => `${p.name}${p.status === 'excused' ? ' (excused)' : ''}`).join(', ')}</p>` : null}
        </section>` : null}
        ${sections.length > 2 && hasAgenda ? html`<${Outline} sections=${sections} />` : null}
      </aside>
      <div class="bp-meeting__main bp-stack">
        ${hasAgenda ? html`<article class="bp-card bp-agenda">
          ${sections.map((s, si) => html`<section class="bp-sec" id=${`s-${s.id}`} key=${s.id}>
            <h2 class="bp-sec__title"><span class="bp-sec__n" aria-hidden="true">${String(si + 1).padStart(2, '0')}</span><span>${s.title || 'Agenda'}</span></h2>
            ${s.items.map((it) => {
              const lines = it.live && it.live !== 'minutes' && numbers ? liveLines(it.live, numbers, { meetingId: m.id }) : [];
              return html`<div class="bp-item" id=${`i-${it.id}`} key=${it.id}>
                <h3 class="bp-item__title"><span>${it.title}</span>${it.presenter ? html`<span class="bp-item__who">${it.presenter}</span>` : null}${it.confidential ? html`<span class="bp-chip bp-chip--warn">Board only · please don’t share</span>` : null}</h3>
                <${Notes} text=${it.notes} />
                ${lines.length ? html`<div class="bp-live">
                  <div class="bp-live__label">${m.snapshot ? `Numbers from ${shortDate(m.snapshot.at.slice(0, 10))}` : 'Numbers as of today'}</div>
                  <ul>${lines.map((l) => html`<li>${l}</li>`)}</ul>
                </div>` : null}
              </div>`;
            })}
          </section>`)}
        </article>` : html`<div class="bp-card bp-empty">
          <span class="bp-empty__icon"><${Icon} name="list" size=${26} /></span>
          <h2 class="bp-h2">${upcoming ? 'The agenda isn’t posted yet' : minutesFile ? 'The minutes are in the file' : 'No agenda was kept here'}</h2>
          <p class="bp-muted">${upcoming ? 'It shows here before the meeting, with the packet.' : minutesFile ? 'Open them to read what the board discussed and decided.' : 'The files from the meeting are beside this.'}</p>
          ${!upcoming && minutesFile ? html`<p class="bp-btns"><a class="bp-btn bp-btn--primary" ...${viewerLink(asViewer([minutesFile]), 0)}><${Icon} name="documents" size=${18} />Read the minutes</a></p>` : null}
        </div>`}
        ${m.motions.length ? html`<section class="bp-card" aria-labelledby="mo-h"><h2 class="bp-h2" id="mo-h">Decisions<span class="bp-count">${m.motions.length}</span></h2>
          <ul class="bp-motions">${m.motions.map((x, k) => html`<li key=${k} class="bp-motion">
            <span class="bp-motion__icon" aria-hidden="true"><${Icon} name="gavel" size=${18} /></span>
            <div class="bp-motion__text"><p class="bp-motion__what">${x.text}</p><p class="bp-muted">${[x.by && `Moved by ${x.by}`, x.second && `seconded by ${x.second}`].filter(Boolean).join(', ')}</p></div>
            ${motionChip(x.result)}
          </li>`)}</ul></section>` : null}
        ${m.actions.length ? html`<section class="bp-card" aria-labelledby="ai-h"><h2 class="bp-h2" id="ai-h">Action items</h2>
          <ul class="bp-actions">${m.actions.map((a) => html`<li key=${a.id} class=${a.done ? 'is-done' : ''}>
            <span class="bp-actions__box" aria-hidden="true">${a.done ? html`<${Icon} name="check" size=${14} />` : null}</span>
            <div><p class="bp-actions__what">${a.text}</p><p class="bp-muted">${[a.ownerName, a.due ? `due ${shortDate(a.due)}` : '', a.done ? 'done' : ''].filter(Boolean).join(' · ')}</p></div>
          </li>`)}</ul></section>` : null}
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

function FinancialsPage({ ctx }) {
  const { data } = ctx;
  const [allYears, setAllYears] = useState(false);
  // SOARD's money is at Chase until it moves to Mercury: Mercury's own record speaks for SOARD only once it holds the money
  const funded = !!data.numbers.mercury && !data.numbers.mercury.empty;
  const f = funded ? data.numbers.finance : null;
  const cash = data.numbers.cash;
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
  return html`
    <header class="bp-pagehead bp-rise" style=${rise(0)}>
      <div><h1 class="bp-h1">Financials</h1><p class="bp-lede">The statements from each meeting, the year in numbers, and every tax return and audit.</p></div>
    </header>
    ${latest ? html`<section class="bp-card bp-latest bp-rise" style=${rise(1)} aria-labelledby="st-h">
      <${SecHead} id="st-h" title="The latest statements" sub=${html`From the <a class="bp-link" href=${`#/meetings/${latest.id}`} onClick=${claimMorph}>${meetingName(latest)}</a>, ${longDate(latest.date)}`} />
      <${FileList} files=${latest.files.filter((x) => x.kind === 'financials')} labels=${false} />
    </section>` : html`<section class="bp-card bp-rise" style=${rise(1)}><h2 class="bp-h2">Financial statements</h2><p class="bp-muted">The income statement and balance sheet from each meeting show here.</p></section>`}
    <div class="bp-split bp-split--even">
      <div class="bp-stack bp-rise" style=${rise(2)}>
        ${s ? html`<section class="bp-card" aria-labelledby="yr-h">
          <${SecHead} id="yr-h" title=${`${s.year} at a glance`} sub=${`From the ${s.year} tax return`} />
          <${Bars} s=${s} />
        </section>` : null}
        ${f?.ytd ? html`<section class="bp-card" aria-labelledby="io-h">
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
        </section>` : null}
        ${cash || f?.cash ? html`<section class="bp-card" aria-labelledby="cash-h">
          <h2 class="bp-h2" id="cash-h">Cash</h2>
          ${cash ? html`<p class="bp-big">${money(cash.total)} <span class="bp-muted">in Mercury</span></p><p class="bp-muted">${cash.accounts.length > 1 ? `${cash.accounts.map((a) => `${a.name} ${money(a.balance)}`).join(' · ')} · ` : ''}${shortDate(cash.at.slice(0, 10))}</p>` : null}
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
        </section>` : null}
      </div>
      <div class="bp-stack bp-rise" style=${rise(3)}>
        ${years.length ? html`<section class="bp-card" aria-labelledby="tx-h">
          <${SecHead} id="tx-h" title="Tax returns and audits" sub="The public copies, as on the website’s Financials page" />
          <table class="bp-table bp-ftable">
            <thead><tr><th scope="col">Year</th><th scope="col">Form 990</th><th scope="col">Audit</th></tr></thead>
            <tbody>${shownYears.map((y) => html`<tr key=${y}><th scope="row">${y}</th><td>${cell(y, '990')}</td><td>${cell(y, 'audit')}</td></tr>`)}</tbody>
          </table>
          ${years.length > 6 ? html`<button type="button" class="bp-more-btn" aria-expanded=${allYears} onClick=${() => setAllYears(!allYears)}>${allYears ? 'Show fewer years' : `Show all ${years.length} years`}</button>` : null}
          ${others.length ? html`<p class="bp-note">Also: ${others.map((x, k) => html`${k ? ', ' : ''}<a class="bp-link" ...${viewerLink(fv, data.filings.indexOf(x))}>${x.title}</a>`)}</p>` : null}
        </section>` : null}
        ${budgets.length ? html`<section class="bp-card" aria-labelledby="bu-h"><h2 class="bp-h2" id="bu-h">Budgets and audits</h2>
          <${FileList} files=${budgets.map((x) => ({ ...x.file, name: x.title }))} labels=${false} /></section>` : null}
        ${earlier.length ? html`<section class="bp-card" aria-labelledby="ea-h">
          <${SecHead} id="ea-h" title="Earlier statements" sub="From each meeting’s packet" />
          <ul class="bp-rows">${earlier.map((m) => html`<li key=${m.id}><a class="bp-row" href=${`#/meetings/${m.id}`} onClick=${claimMorph}>
            <${DateTile} d=${m.date} mid=${m.id} />
            <span class="bp-row__main"><span class="bp-row__title">${meetingName(m)}</span><span class="bp-row__meta">${fileRows(m.files.filter((x) => x.kind === 'financials')).flatMap((g) => g.rows.map((r) => r.title)).join(' · ')}</span></span>
            <${Icon} name="arrow" size=${18} cls="bp-go" />
          </a></li>`)}</ul>
        </section>` : null}
      </div>
    </div>`;
}

// ─── People ─────────────────────────────────────────────────────────
const OFFICERS = ['chair', 'vice-chair', 'treasurer', 'secretary'];
function Person({ p, size = 64, email = false, ctx }) {
  const copy = async () => {
    try { await navigator.clipboard.writeText(p.email); ctx.say(`Copied ${p.email}`); } catch { ctx.say('Couldn’t copy. Press and hold the address instead.', 'warn'); }
  };
  const role = p.title && !/^board member$/i.test(p.title) ? p.title : '';
  return html`<li class="bp-person" id=${`p-${p.slug}`}>
    <${Avatar} p=${p} size=${size} />
    <div class="bp-person__text">
      <p class="bp-person__name">${p.name}</p>
      ${role ? html`<p class="bp-person__role">${role}</p>` : null}
      ${p.organization ? html`<p class="bp-person__org">${p.organization}</p>` : null}
      ${p.committees?.length ? html`<p class="bp-person__org">${p.committees.join(', ')}</p>` : null}
      ${email && p.email ? html`<p class="bp-person__acts">
        <a class="bp-mini" href=${`mailto:${p.email}`} title=${p.email}><${Icon} name="mail" size=${16} />Email</a>
        <button type="button" class="bp-mini" onClick=${copy} aria-label=${`Copy ${p.name}’s email address`}><${Icon} name="copy" size=${16} />Copy</button>
      </p>` : null}
    </div>
  </li>`;
}
function PeoplePage({ ctx }) {
  const { people } = ctx.data;
  useFocusTarget();
  const officers = people.board.filter((p) => OFFICERS.includes(p.seat)).sort((a, b) => OFFICERS.indexOf(a.seat) - OFFICERS.indexOf(b.seat));
  const members = people.board.filter((p) => !officers.includes(p));
  const committees = [...new Set(people.board.flatMap((p) => p.committees || []))].sort();
  return html`
    <header class="bp-pagehead bp-rise" style=${rise(0)}><div><h1 class="bp-h1">People</h1><p class="bp-lede">The board, the team and the Advisory Board. Tap Email to write to a board member.</p></div></header>
    <section class="bp-gap bp-rise" style=${rise(1)} aria-labelledby="bd-h">
      <${SecHead} id="bd-h" title="Board of Directors" count=${people.board.length} />
      ${officers.length ? html`<ul class="bp-people bp-people--officers">${officers.map((p) => html`<${Person} p=${p} size=${88} email ctx=${ctx} key=${p.slug} />`)}</ul>` : null}
      <ul class="bp-people">${members.map((p) => html`<${Person} p=${p} email ctx=${ctx} key=${p.slug} />`)}</ul>
    </section>
    ${committees.length ? html`<section class="bp-card bp-gap bp-rise" style=${rise(2)} aria-labelledby="cm-h"><h2 class="bp-h2" id="cm-h">Committees</h2><ul class="bp-rows">${committees.map((c) => html`<li key=${c}><div class="bp-row bp-row--static"><span class="bp-row__main"><span class="bp-row__title">${c}</span><span class="bp-row__meta">${people.board.filter((p) => (p.committees || []).includes(c)).map((p) => p.name).join(', ')}</span></span></div></li>`)}</ul></section>` : null}
    <section class="bp-gap bp-rise" style=${rise(3)} aria-labelledby="tm-h">
      <${SecHead} id="tm-h" title="The team" count=${people.staff.length} />
      <ul class="bp-people">${people.staff.map((p) => html`<${Person} p=${p} ctx=${ctx} key=${p.slug} />`)}</ul>
    </section>
    ${people.advisory.length ? html`<section class="bp-rise" style=${rise(4)} aria-labelledby="ad-h">
      <${SecHead} id="ad-h" title="Advisory Board" count=${people.advisory.length} />
      <ul class="bp-people">${people.advisory.map((p) => html`<${Person} p=${p} ctx=${ctx} key=${p.slug} />`)}</ul>
    </section>` : null}`;
}

// ─── Documents ──────────────────────────────────────────────────────
function SignForm({ d: doc, ctx }) {
  const { data, setData, say } = ctx;
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  if (doc.signedByMe) return html`<p class="bp-signed"><span class="bp-chip bp-chip--ok"><${Icon} name="check" size=${14} />Signed</span> by ${doc.signedByMe.name}, ${shortDate(doc.signedByMe.at.slice(0, 10))}</p>`;
  if (!data.me.slug) return html`<p class="bp-note">Each board member signs it here once a year.</p>`;
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
function Library({ data }) {
  const [kind, setKind] = useState('all');
  const [q, setQ] = useState('');
  const terms = termsOf(q);
  const meetings = [...data.meetings].filter((m) => m.files.length).sort((a, b) => b.date.localeCompare(a.date));
  const kinds = FILE_KINDS.filter((k) => meetings.some((m) => m.files.some((f) => f.kind === k.id)));
  const pick = (m) => m.files.filter((f) => (kind === 'all' || f.kind === kind) && (!terms.length || hits(`${titleOf(f.name)} ${meetingName(m)} ${kindLabel(f.kind)}`, terms)));
  const shown = meetings.map((m) => ({ m, files: pick(m) })).filter((x) => x.files.length);
  if (!meetings.length) return null;
  return html`<section class="bp-card bp-library" aria-labelledby="lib-h">
    <${SecHead} id="lib-h" title="Every meeting’s files" sub="Minutes, packets and statements, newest first">
      <label class="bp-filter bp-filter--sm"><${Icon} name="search" size=${16} /><span class="sr-only">Find a file</span><input type="search" placeholder="Find a file" value=${q} onInput=${(e) => setQ(e.target.value)} /></label>
    </${SecHead}>
    <div class="bp-chips bp-chips--filter" role="group" aria-label="Show">
      ${[{ id: 'all', label: 'All' }, ...kinds].map((k) => html`<button type="button" class="bp-pill" aria-pressed=${kind === k.id} onClick=${() => setKind(k.id)} key=${k.id}>${k.label}</button>`)}
    </div>
    ${shown.length ? shown.map(({ m, files }) => html`<div class="bp-libmeet" key=${m.id}>
      <a class="bp-libmeet__head" href=${`#/meetings/${m.id}`} onClick=${claimMorph}><${DateTile} d=${m.date} mid=${m.id} /><span><span class="bp-row__title">${meetingName(m)}</span><span class="bp-row__meta">${longDate(m.date)}</span></span></a>
      <${FileList} files=${files} labels=${false} kinds=${kind === 'all'} />
    </div>`) : html`<p class="bp-muted">No file matches.</p>`}
  </section>`;
}

function DocumentsPage({ ctx }) {
  const { data } = ctx;
  const { docs } = data;
  const year = todayEastern().slice(0, 4);
  useFocusTarget();
  const toSign = docs.filter((x) => x.sign && x.file);
  const done = toSign.filter((x) => x.signedByMe).length;
  return html`
    <header class="bp-pagehead bp-rise" style=${rise(0)}><div><h1 class="bp-h1">Documents</h1><p class="bp-lede">The bylaws, policies and plans, and every file from every meeting. A few documents ask each board member to read and sign them once a year.</p></div></header>
    ${toSign.length && data.me.slug ? html`<div class="bp-progress bp-rise" style=${rise(1)}>
      <div class="bp-progress__text"><strong>${done === toSign.length ? `All signed for ${year}. Thank you.` : `${done} of ${toSign.length} signed for ${year}`}</strong></div>
      <div class="bp-progress__track" role="progressbar" aria-valuemin="0" aria-valuemax=${toSign.length} aria-valuenow=${done} aria-label="Signed this year"><span style=${`--p:${(done / toSign.length) * 100}%`}></span></div>
    </div>` : null}
    ${docs.length ? DOC_KINDS.filter((k) => docs.some((x) => x.kind === k.id)).map((k, ki) => {
      const list = docs.filter((x) => x.kind === k.id);
      const withFile = list.filter((x) => x.file);
      const vf = asViewer(withFile.map((x) => ({ ...x.file, name: x.title })));
      return html`<section class="bp-card bp-gap bp-rise" style=${rise(2 + ki)} aria-labelledby=${`dk-${k.id}`} key=${k.id}><h2 class="bp-h2" id=${`dk-${k.id}`}>${k.label}</h2><ul class="bp-docs">${list.map((x) => html`<li key=${x.id} class="bp-doc" id=${`doc-${x.id}`}>
        <div class="bp-doc__head">
          ${x.file ? html`<${FileBadge} f=${x.file} />` : html`<span class="bp-badge" data-format="File" aria-hidden="true">…</span>`}
          <div class="bp-doc__text">
            <p class="bp-doc__title">${x.title}</p>
            <p class="bp-doc__meta">${[x.note, x.file ? sizeText(x.file.size) : 'The file is on its way', x.sign ? 'Sign once a year' : ''].filter(Boolean).join(' · ')}</p>
          </div>
          ${x.file ? html`<a class="bp-btn bp-btn--sm" ...${viewerLink(vf, withFile.indexOf(x))}>${x.sign ? 'Read it' : 'Open it'}</a>` : null}
        </div>
        ${x.sign && x.file ? html`<${SignForm} d=${x} ctx=${ctx} />` : null}
      </li>`)}</ul></section>`;
    }) : html`<div class="bp-card bp-empty bp-empty--row bp-gap bp-rise" style=${rise(1)}>
      <span class="bp-empty__icon"><${Icon} name="documents" size=${24} /></span>
      <div><h2 class="bp-h2">Bylaws and policies show here</h2>
      <p class="bp-muted">${data.contact ? `Once ${firstName(data.contact.name)} adds them, they’re here to read.` : 'They’re here to read once they’re added.'} Anything to read and sign shows on Home too.</p></div>
    </div>`}
    <div class="bp-rise" style=${rise(6)}><${Library} data=${data} /></div>`;
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
      for (const it of s.items) out.push({ group: 'In agendas and minutes', title: it.title || s.title, sub, body: said(it.notes) || it.title, hay: norm([s.title, it.title, it.presenter, it.notes].join(' ')), href: `#/meetings/${m.id}`, focus: `i-${it.id}`, icon: 'list' });
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
        <button type="button" class="bp-finder__x" onClick=${close} aria-label="Close search"><span class="bp-kbd">esc</span></button>
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
            <span class="bp-finder__text"><span class="bp-finder__title">${x.title}</span><span class="bp-finder__sub">${x.body && x.group === 'In agendas and minutes' ? html`<${Snippet} text=${x.body} terms=${terms} />` : x.sub}</span>${x.body && x.group === 'In agendas and minutes' ? html`<span class="bp-finder__sub">${x.sub}</span>` : null}</span>
            ${x.ext ? html`<${Icon} name="external" size=${16} cls="bp-go" />` : html`<${Icon} name="arrow" size=${16} cls="bp-go" />`}
          </div>`)}
        </div>`)}</div>`}
      </div>
      <p class="bp-finder__foot" aria-hidden="true"><span><span class="bp-kbd">↑</span><span class="bp-kbd">↓</span> to move</span><span><span class="bp-kbd">enter</span> to open</span><span><span class="bp-kbd">esc</span> to close</span></p>
    </div>
  </dialog>`;
}

render(html`<${App} />`, document.getElementById('board-app'));
