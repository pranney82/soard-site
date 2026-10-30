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
import { openDoc } from './docs.js';
import {
  meetingName, longDate, shortDate, timeRange, liveLines, noteBlocks, agendaItems, presentersOf, itemFiles, deckOf, stopIndex, fileTitle, isDate, clock, todayEastern, MORE,
  sectionPlan, sectionClock, clockText,
} from '../board-shared.js';
import { Kanban, kanbanLine, sized } from './kanban.js';
import { useCashNow, useBudget, moneyTiles } from './money.js';

const html = htm.bind(h);
const API = '/api/board-portal';
const CHANNEL = 'soard-board-screen';
const LOGO = '/cdn-cgi/imagedelivery/ROYFuPmfN2vPS6mt5sCkZQ/brand-logo-admin/w=256';

const initialsOf = (name) => { const w = String(name || '').split(/\s+/).filter(Boolean); return ((w[0]?.[0] || '') + (w.length > 1 ? w.at(-1)[0] : '')).toUpperCase() || '?'; };
const hueOf = (s) => [42, 28, 96, 152, 200, 18][[...String(s)].reduce((a, c) => a + c.charCodeAt(0), 0) % 6];
function Face({ p, size }) {
  const [broken, setBroken] = useState(false);
  return p?.photo && !broken
    ? html`<img class="bs-face" src=${p.photo} alt="" width=${size} height=${size} style=${`--s:${size}px`} onError=${() => setBroken(true)} />`
    : html`<span class="bs-face bs-face--initials" style=${`--s:${size}px;--hue:${hueOf(p?.name)}`} aria-hidden="true">${initialsOf(p?.name)}</span>`;
}
/** The whole screen for the screen, or back */
const fullScreen = () => { if (document.fullscreenElement) document.exitFullscreen?.(); else document.documentElement.requestFullscreen?.().catch(() => {}); };
const nowClock = () => new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });

/** The meeting as it's held, every 1.5 seconds (4 while the chair's computer is moving this screen itself) */
function useLiveView(id, fast) {
  const [v, setV] = useState(null);
  const [fail, setFail] = useState('');
  useEffect(() => {
    let stop = false;
    let t = 0;
    const tick = async () => {
      clearTimeout(t);
      try {
        const r = await fetch(`${API}?live=${encodeURIComponent(id)}`, { cache: 'no-store' });
        const j = await r.json();
        if (stop) return;
        if (j?.ok && Array.isArray(j.sections)) { setV(j); setFail(''); } else if (r.status === 404 || r.status === 403) setFail(j?.error || 'That meeting isn’t on the board page');
      } catch { /* the next look tries again */ }
      if (!stop) t = setTimeout(tick, fast.current ? 4000 : 1500);
    };
    tick();
    return () => { stop = true; clearTimeout(t); };
  }, [id]);
  return [v, fail];
}

// ─── Where the words are on a page ──────────────────────────────────
// A letter page fitted to a widescreen TV is mostly white, its numbers small. The screen shows the part of the page
// with something on it instead, as big as it goes: the white margins trimmed, and a lone line far from the rest (a
// report's "Accrual Basis…" footer, a page number) left out. Print still prints the whole page.

/** Blocks of ink down the page ({ y0, y1, x0, x1 } in 0..1) → the part worth showing, or null for the whole page */
function mainPart(blocks) {
  if (!blocks.length) return null;
  blocks.sort((a, b) => a.y0 - b.y0);
  const merged = [];
  for (const b of blocks) {
    const last = merged.at(-1);
    if (last && b.y0 - last.y1 < 0.05) { last.y1 = Math.max(last.y1, b.y1); last.x0 = Math.min(last.x0, b.x0); last.x1 = Math.max(last.x1, b.x1); } else merged.push({ ...b });
  }
  // A small block set well apart from everything else is a footer or a page number
  const keep = merged.filter((b, i) => {
    if (merged.length < 2 || b.y1 - b.y0 > 0.04) return true;
    const gap = Math.min(i > 0 ? b.y0 - merged[i - 1].y1 : 1, i < merged.length - 1 ? merged[i + 1].y0 - b.y1 : 1);
    return gap < 0.15;
  });
  const u = keep.reduce((a, b) => ({ y0: Math.min(a.y0, b.y0), y1: Math.max(a.y1, b.y1), x0: Math.min(a.x0, b.x0), x1: Math.max(a.x1, b.x1) }));
  const pad = 0.025;
  const part = { x: Math.max(0, u.x0 - pad), y: Math.max(0, u.y0 - pad) };
  part.w = Math.min(1, u.x1 + pad) - part.x;
  part.h = Math.min(1, u.y1 + pad) - part.y;
  return part.w > 0.05 && part.h > 0.03 ? part : null;
}
/** The ink on a drawn page: a PDF's or picture's canvas read pixel by pixel; a laid-out page by where its words and pictures sit */
function inkOf(frame) {
  const canvas = frame.querySelector('canvas');
  if (canvas?.width) {
    const w = 200;
    const h = Math.max(1, Math.round((canvas.height * w) / canvas.width));
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(canvas, 0, 0, w, h);
    const d = g.getImageData(0, 0, w, h).data;
    const rows = [];
    for (let y = 0; y < h; y++) {
      let x0 = -1; let x1 = -1;
      for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; if (d[i] < 230 || d[i + 1] < 230 || d[i + 2] < 230) { if (x0 < 0) x0 = x; x1 = x; } }
      if (x0 >= 0) rows.push({ y0: y / h, y1: (y + 1) / h, x0: x0 / w, x1: (x1 + 1) / w });
    }
    return rows;
  }
  const box = frame.getBoundingClientRect();
  if (!box.width || !box.height) return null;
  const out = [];
  const add = (r) => { if (r.width > 0 && r.height > 0) out.push({ y0: (r.top - box.top) / box.height, y1: (r.bottom - box.top) / box.height, x0: (r.left - box.left) / box.width, x1: (r.right - box.left) / box.width }); };
  const walk = document.createTreeWalker(frame, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  for (let n = walk.nextNode(); n; n = walk.nextNode()) { if (n.textContent.trim()) { range.selectNodeContents(n); for (const r of range.getClientRects()) add(r); } }
  for (const img of frame.querySelectorAll('img')) add(img.getBoundingClientRect());
  return out;
}
// Laid-out pages are measured off screen, so nothing jumps while the screen works out its zoom
let measuring = null;
function measureBox() {
  if (!measuring) { measuring = document.createElement('div'); measuring.setAttribute('aria-hidden', 'true'); measuring.style.cssText = 'position:fixed;left:-20000px;top:0;visibility:hidden;pointer-events:none'; document.body.append(measuring); }
  return measuring;
}

/**
 * Page `page` of a file drawn as big as `box` ({ w, h }) allows, showing the part of it with something on it
 * → { el, count }. `ahead` also draws the next page, so it's there at once.
 */
async function drawFitted(f, page, box, { ahead = false } = {}) {
  const doc = await openDoc(f);
  const i = Math.max(0, Math.min(page, doc.count - 1));
  const size = doc.size(i);
  const fit = Math.floor(Math.min(box.w, (box.h * size.w) / size.h));
  // First the whole page, small, to see where its words are
  const probe = await doc.draw(i, { width: fit, dpr: 1 });
  const tray = measureBox();
  tray.replaceChildren(probe);
  const part = mainPart(inkOf(probe) || []);
  tray.replaceChildren();
  const H0 = Math.round((size.h * fit) / size.w);
  const zoom = part ? Math.min(3, box.w / (part.w * fit), box.h / (part.h * H0)) : 1;
  let el;
  if (part && zoom > 1.12) {
    const W = Math.floor(fit * zoom);
    const H = Math.round((size.h * W) / size.w);
    const page2 = await doc.draw(i, { width: W });
    el = document.createElement('div');
    el.className = 'bs-crop';
    el.style.width = `${Math.round(part.w * W)}px`;
    el.style.height = `${Math.round(part.h * H)}px`;
    page2.style.marginLeft = `${-Math.round(part.x * W)}px`;
    page2.style.marginTop = `${-Math.round(part.y * H)}px`;
    el.append(page2);
  } else {
    el = await doc.draw(i, { width: fit });
  }
  if (ahead && i + 1 < doc.count) doc.draw(i + 1, { width: fit, dpr: 1 }).catch(() => {});
  return { el, count: doc.count };
}

/** A page of a document on the screen, kept up until the next one is drawn (no flash between pages); `onPages` hears the page count */
function DocPage({ f, page, box, onPages }) {
  const ref = useRef(null);
  const [state, setState] = useState('opening');
  useEffect(() => {
    if (!f || !box.w || !box.h) return undefined;
    let gone = false;
    drawFitted(f, page, box, { ahead: true }).then(({ el, count }) => {
      if (gone || !ref.current) return;
      onPages?.(f.id, count);
      ref.current.replaceChildren(el);
      setState('');
    }).catch(() => { if (!gone) setState('failed'); });
    return () => { gone = true; };
  }, [f?.id, page, box.w, box.h]);
  return html`<div class="bs-page">
    <div class="bs-page__sheet" ref=${ref}></div>
    ${state === 'opening' ? html`<p class="bs-quiet">Opening ${fileTitle(f?.name)}…</p>` : state === 'failed' ? html`<p class="bs-quiet">${fileTitle(f?.name)} didn’t open here. It’s on the board page.</p>` : null}
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
    const measure = () => setBox((b) => { const w = Math.floor(el.clientWidth); const h = Math.floor(el.clientHeight); return b.w === w && b.h === h ? b : { w, h }; });
    measure();
    if (!('ResizeObserver' in window)) return undefined;
    let t = 0;
    const ro = new ResizeObserver(() => { clearTimeout(t); t = setTimeout(measure, 120); });
    ro.observe(el);
    return () => { ro.disconnect(); clearTimeout(t); };
  }, [el]);
  return [setEl, box];
}

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
/** The money as figures: the cash, the year against its budget (./money.js moneyTiles), the first on yellow */
function CashSlide({ n, data, date }) {
  const upTo = date && date < todayEastern() ? date : '';
  const tiles = moneyTiles({ cash: useCashNow(data, upTo, n), budget: useBudget(data, upTo, n), n });
  if (!tiles.length) return null;
  return html`<ul class="bs-figs" style=${`--n:${tiles.length}`}>${tiles.map((t) => html`<li key=${t.k}><span class="bs-figs__label">${t.label}</span><span class="bs-figs__value">${t.value}</span>${t.pct != null ? html`<span class="bs-figs__bar" role="img" aria-label=${`${t.pct}% of the budget`}><i style=${`--p:${Math.min(100, t.pct)}%`}></i></span>` : null}${t.sub ? html`<span class="bs-figs__sub">${t.sub}</span>` : null}</li>`)}</ul>`;
}
/** Reveals ahead: each kid's photo and the day */
function RevealsSlide({ n }) {
  const list = [...(n?.reveals || [])].sort((a, b) => String(a.confirmed && a.date ? a.date : windowStart(a.window) || '9').localeCompare(String(b.confirmed && b.date ? b.date : windowStart(b.window) || '9'))).slice(0, 6);
  if (!list.length) return html`<p class="bs-quiet">No reveals on the calendar yet.</p>`;
  const photoOf = (r) => [...(n.projects?.building || []), ...(n.projects?.waiting || [])].find((b) => b.slug && b.slug === r.slug)?.photo || '';
  return html`<ul class="bs-reveals" style=${`--n:${Math.min(3, list.length)}`}>${list.map((r) => {
    const photo = photoOf(r);
    return html`<li key=${r.slug || r.name}>
      <span class="bs-reveals__photo">${photo ? html`<img src=${sized(photo, 'w=720,h=480,fit=cover,gravity=face')} alt="" />` : html`<${Face} p=${{ name: r.name }} size=${96} />`}</span>
      <span class="bs-reveals__text"><strong>${r.name}</strong><span>${r.confirmed && r.date ? `${dayWords(r.date)}${r.time ? `, ${clock(r.time)}` : ''}` : `${r.window?.label || 'Date to come'}, not set yet`}</span></span>
      <${Tile} d=${r.confirmed && r.date ? r.date : windowStart(r.window)} word=${r.confirmed && r.date ? '' : r.window?.part || ''} />
    </li>`;
  })}</ul>`;
}
function DatesSlide({ rows }) {
  if (!rows.length) return html`<p class="bs-quiet">Nothing on the calendar yet.</p>`;
  return html`<ul class="bs-dates">${rows.map((r) => html`<li key=${r.key}><${Tile} d=${r.date} /><span><strong>${r.title}</strong><span>${r.sub}</span></span></li>`)}</ul>`;
}
/** An item's live facts on the screen, or null when it has none */
function liveSlide(kind, n, id, data, date) {
  if (!n || !kind || kind === 'minutes') return null;
  if (kind === 'projects') return n.projects ? html`<${Kanban} projects=${n.projects} reveals=${n.reveals || []} variant="screen" />` : null;
  if (kind === 'cash') return html`<${CashSlide} n=${n} data=${data} date=${date} />`;
  if (kind === 'reveals') return html`<${RevealsSlide} n=${n} />`;
  if (kind === 'events') return html`<${DatesSlide} rows=${(n.events || []).slice(0, 5).map((e) => ({ key: e.title + e.date, date: e.date, title: e.title, sub: [dayWords(e.date), e.time, e.location].filter(Boolean).join('  ·  ') }))} />`;
  if (kind === 'meetings') return html`<${DatesSlide} rows=${(n.meetings || []).filter((x) => x.id !== id).slice(0, 4).map((x) => ({ key: x.id || x.date, date: x.date, title: x.name, sub: [dayWords(x.date), x.start ? clock(x.start) : ''].filter(Boolean).join('  ·  ') }))} />`;
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
    : next.kind === 'doc' && next.fileId === stop?.fileId ? html`<span>Next: page ${next.page + 1}</span>`
    : next.kind === 'doc' ? html`<span>Next: ${fileTitle(files.find((f) => f.id === next.fileId)?.name || 'the document')}</span>`
    : next.n >= 0 ? html`<span>Next <b>${items[next.n].label}</b> ${items[next.n].title}</span>` : html`<span>Next: ${MORE.title.toLowerCase()}</span>`;
  return html`<footer class="bs-rail" aria-label="Where the meeting is">
    <ol class="bs-rail__parts">${sections.map(({ s, si, items: its }) => {
      const on = cardAt >= 0 ? si === cardAt : its.some((it) => items.indexOf(it) === n);
      // A part with no items (new business, open forum) is passed once anything after it has come up
      const fill = cardAt === si ? 0.04 : its.length ? (its.filter((it) => items.indexOf(it) < n).length + (on ? 0.5 : 0)) / its.length : ended || cardAt > si || items.some((it) => it.si > si && items.indexOf(it) <= n) ? 1 : 0;
      return html`<li key=${s.id} class=${on ? 'is-on' : fill >= 1 ? 'is-done' : ''} style=${`--w:${Math.max(1, its.length)};--fill:${Math.min(1, fill)}`}>
        <span class="bs-rail__bar" aria-hidden="true"><i></i></span>
        <span class="bs-rail__label"><b>${String(si + 1).padStart(2, '0')}</b>${s.title || 'Agenda'}${on && timer ? html`<i class=${`bs-rail__time ${timer.over ? 'is-over' : ''}`}>${clockText(timer.left)}${timer.over ? ' over' : ' left'}</i>` : null}</span>
      </li>`;
    })}</ol>
    <p class="bs-rail__next">${nextWords}</p>
  </footer>`;
}

/** The screen: the stop the chair is on, in the window it's given */
export function Screen({ id, data, d }) {
  const fast = useRef(false);
  const [v, fail] = useLiveView(id, fast);
  const [told, setTold] = useState(null); // { live, rehearsal, at } from the chair's computer
  const [pages, setPages] = useState({});
  const [awake, setAwake] = useState(true);
  const [, setTick] = useState(0);
  const ch = useRef(null);
  const [stageRef, box] = useBox();

  // The chair's computer, when it's this one
  useEffect(() => {
    if (!('BroadcastChannel' in window)) return undefined;
    const c = new BroadcastChannel(CHANNEL);
    ch.current = c;
    c.onmessage = (e) => {
      const msg = e.data || {};
      if (msg.id !== id) return;
      if (msg.type === 'ping') c.postMessage({ type: 'hello', id });
      if (msg.type === 'show') { fast.current = true; setTold({ live: msg.live || {}, rehearsal: !!msg.rehearsal, at: Date.now() }); }
    };
    c.postMessage({ type: 'hello', id });
    const bye = () => c.postMessage({ type: 'bye', id });
    addEventListener('pagehide', bye);
    return () => { bye(); removeEventListener('pagehide', bye); c.close(); ch.current = null; };
  }, [id]);

  // Keys here go back to the chair; F fills the screen
  useEffect(() => {
    const keys = (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === 'f' || e.key === 'F') { e.preventDefault(); fullScreen(); return; }
      const dir = ['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'j'].includes(e.key) ? (e.key === ' ' && e.shiftKey ? -1 : 1) : ['ArrowLeft', 'ArrowUp', 'PageUp', 'k'].includes(e.key) ? -1 : 0;
      if (dir) { e.preventDefault(); ch.current?.postMessage({ type: 'key', id, dir }); }
    };
    addEventListener('keydown', keys);
    return () => removeEventListener('keydown', keys);
  }, [id]);

  // The mouse and the full-screen button rest after 2.5 seconds without a move; the clock ticks
  useEffect(() => {
    let t = setTimeout(() => setAwake(false), 2500);
    const move = () => { setAwake(true); clearTimeout(t); t = setTimeout(() => setAwake(false), 2500); };
    addEventListener('pointermove', move);
    const clockTick = setInterval(() => setTick(Date.now()), 1000);
    return () => { clearTimeout(t); clearInterval(clockTick); removeEventListener('pointermove', move); };
  }, []);

  useEffect(() => { document.title = v ? `${v.title} · On the screen` : 'SOARD Board · On the screen'; }, [v?.title]);

  const m = data.meetings.find((x) => x.id === id) || null;
  const meeting = useMemo(() => (v ? { ...(m || {}), id, title: m?.title || '', date: v.date, start: m?.start || v.start || '', end: m?.end || v.end || '', sections: v.sections, files: v.files || [] } : null), [v, m]);
  const plan = useMemo(() => (meeting ? sectionPlan(meeting) : new Map()), [meeting]);
  const deck = useMemo(() => (meeting ? deckOf(meeting, { pages, meetings: v.prior || [] }) : []), [meeting, pages]);
  const notePages = (fileId, count) => setPages((p) => {
    if (p[fileId] === count) return p;
    ch.current?.postMessage({ type: 'pages', id, pages: { [fileId]: count } });
    return { ...p, [fileId]: count };
  });

  if (fail && !v) return html`<div class="bs bs--center"><div class="bs-cover__lead"><img src=${LOGO} alt="" width="96" height="96" /><h1 class="bs-h1">${fail}</h1><p class="bs-quiet">Share the meeting in Board, and this screen opens it.</p></div></div>`;
  if (!v || !meeting) return html`<div class="bs bs--center"><img src=${LOGO} alt="" width="96" height="96" /><p class="bs-quiet">Opening the screen…</p></div>`;

  // The chair's own word is the newest while they're moving this screen (the saved state catches up a moment later)
  const fresh = told && (told.rehearsal || Date.now() - told.at < 60_000);
  const live = fresh ? told.live : v.live;
  const started = !!v.live.startedAt || (fresh && !!told.live.startedAt);
  const ended = live.screen === 'end' || (!fresh && !!v.live.endedAt);
  const at = ended ? deck.length - 1 : stopIndex(deck, live);
  const stop = deck[at] || deck[0];
  const items = agendaItems(meeting);
  const item = stop.kind === 'item' || stop.kind === 'doc' ? (stop.n >= 0 ? meeting.sections[items[stop.n].si].items[items[stop.n].ii] : { ...MORE, notes: '', docs: [] }) : null;
  const cardSi = stop.kind === 'section' ? meeting.sections.findIndex((x) => x.id === stop.sectionId) : -1;
  const label = stop.n >= 0 ? items[stop.n].label : cardSi >= 0 ? String(cardSi + 1).padStart(2, '0') : '';
  const section = stop.n >= 0 ? items[stop.n].section : '';
  const people = d?.people || [];
  const who = item ? presentersOf(item, people) : [];
  // Who has the floor: the one the chair gave it to, else whoever presents the item
  const given = live.floor ? people.find((p) => p.slug === live.floor) || null : null;
  const floor = given ? [given] : who;
  const secId = stop.sectionId || (stop.n >= 0 ? meeting.sections[items[stop.n].si]?.id : '');
  const timer = started && !ended && secId ? sectionClock(plan, secId, live.sectionAt) : null;
  const files = item ? (stop.n >= 0 ? itemFiles(meeting, item, v.prior || []) : meeting.files.filter((f) => deck.some((s) => s.fileId === f.id && s.n === -1))) : [];
  const file = stop.fileId ? [...meeting.files, ...(v.prior || []).flatMap((x) => x.files)].find((f) => f.id === stop.fileId) : null;
  const numbers = v.snapshot || data.numbers;
  const vote = v.vote && started && !ended && !(fresh && told.rehearsal) ? v.vote : null;
  const place = [m?.location, m?.address].filter(Boolean).join(', ');

  const top = html`<header class="bs-top">
    <span class="bs-brand"><img src=${LOGO} alt="" width="40" height="40" /><span><strong>${meetingName(meeting)}</strong><small>${[isDate(meeting.date) ? longDate(meeting.date) : '', started && !ended ? 'Live' : ''].filter(Boolean).join(' · ')}</small></span></span>
    ${(stop.kind === 'item' || stop.kind === 'doc') && floor.length ? html`<span class=${`bs-floor ${given ? 'is-given' : ''}`}>${floor.map((p) => html`<${Face} p=${p} size=${34} key=${p.slug || p.name} />`)}<span><strong>${floor.map((p) => p.name).join(' & ')}</strong> has the floor</span></span>` : null}
    <span class="bs-top__right">${timer ? html`<span class=${`bs-timer ${timer.over ? 'is-over' : ''}`} role="timer">${timer.over ? `Time’s up · ${clockText(timer.left)} over` : `${clockText(timer.left)} left`}</span>` : null}${told?.rehearsal ? html`<span class="bs-chip">Rehearsal</span>` : null}${v.practice ? html`<span class="bs-chip">Practice</span>` : null}${label ? html`<span class="bs-num">${label}</span>` : null}<span class="bs-clock">${nowClock()}</span></span>
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
    const decided = (v.motions || []).filter((x) => x.text);
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
    const sec = meeting.sections[cardSi];
    const t = plan.get(sec?.id);
    stage = html`<div class="bs-chapter">
      <span class="bs-chapter__n" aria-hidden="true">${String(cardSi + 1).padStart(2, '0')}</span>
      <div class="bs-chapter__body">
        <p class="bs-eyebrow">${t ? [t.start ? `${clock(t.start)} to ${clock(t.end)}` : '', `${t.minutes} minutes`].filter(Boolean).join(' · ') : 'Agenda'}</p>
        <h1 class="bs-display bs-chapter__title">${sec?.title || 'Agenda'}</h1>
        ${sec?.items.length ? html`<ol class="bs-chapter__items">${sec.items.map((it) => { const ws = presentersOf(it, people); const lab = items.find((x) => x.id === it.id)?.label; return html`<li key=${it.id}><span class="bs-chapter__label">${lab}</span><span class="bs-chapter__t">${it.title}</span>${ws.length ? html`<span class="bs-chapter__who">${ws.map((p) => html`<${Face} p=${p} size=${36} key=${p.slug || p.name} />`)}<span>${ws.map((p) => p.name).join(' & ')}</span></span>` : null}</li>`; })}</ol>`
          : html`<p class="bs-chapter__open">Open to the floor</p>`}
      </div>
    </div>`;
  } else if (stop.kind === 'item') {
    const facts = liveSlide(item.live, numbers, id, data, meeting.date);
    const head = html`<p class="bs-eyebrow">${[section && section !== item.title ? section : '', !section && stop.n < 0 ? 'Also for this meeting' : ''].filter(Boolean).join('') || 'Agenda'}</p>
      <h1 class="bs-display bs-item__title">${item.title}</h1>
      ${item.confidential ? html`<p class="bs-chip bs-chip--warn">Board only · please don’t share</p>` : null}`;
    const whoList = who.length ? html`<ul class="bs-who">${who.map((p) => html`<li key=${p.slug || p.name}><${Face} p=${p} size=${facts ? 52 : 72} /><span><strong>${p.name}</strong>${p.title ? html`<small>${p.title}</small>` : null}</span></li>`)}</ul>` : null;
    const coming = files.length ? html`<div class="bs-coming"><p class="bs-eyebrow">${files.length === 1 ? 'Its document, next' : 'Its documents, next'}</p><ol>${files.map((f) => html`<li key=${f.id}>${fileTitle(f.name)}${pages[f.id] > 1 ? html`<span> · ${pages[f.id]} pages</span>` : null}</li>`)}</ol></div>` : null;
    if (facts && item.live === 'projects') {
      stage = html`<div class="bs-item bs-item--board">
        <div class="bs-item__bar"><div>${head}</div><div class="bs-item__aside">${whoList}<p class="bs-quiet">${kanbanLine(numbers.projects)}</p></div></div>
        <div class="bs-item__facts">${facts}</div>
      </div>`;
    } else if (facts) {
      stage = html`<div class="bs-item bs-item--facts">
        <div class="bs-item__bar"><div>${head}</div><div class="bs-item__aside">${whoList}</div></div>
        <div class="bs-item__facts">${facts}</div>
        ${item.notes || coming ? html`<div class="bs-item__body">${item.notes ? html`<${Points} text=${item.notes} />` : null}${coming}</div>` : null}
      </div>`;
    } else {
      const side = item.notes || coming;
      stage = html`<div class=${`bs-item ${side ? 'bs-item--split' : 'bs-item--title'}`}>
        <div class="bs-item__lead">${head}${whoList}</div>
        ${side ? html`<div class="bs-item__side">${item.notes ? html`<${Points} text=${item.notes} />` : null}${coming}</div>` : null}
      </div>`;
    }
  } else {
    stage = html`<${DocPage} f=${file} page=${stop.page} box=${box} onPages=${notePages} key=${file?.id} />`;
  }
  const docWords = stop.kind === 'doc' ? `${fileTitle(file?.name)} · Page ${stop.page + 1}${pages[stop.fileId] ? ` of ${pages[stop.fileId]}` : ''}` : '';

  return html`<div class=${`bs bs--${stop.kind} ${awake ? 'is-awake' : ''} ${vote ? 'has-vote' : ''}`}>
    ${top}
    <main class="bs-stage" ref=${stageRef}><div class="bs-stage__in" key=${stop.kind === 'doc' ? `doc:${stop.fileId}` : stop.key}>${stage}</div></main>
    ${vote ? html`<aside class="bs-vote" aria-live="polite">
      <p class="bs-eyebrow">The board is voting</p>
      <h2 class="bs-vote__what">${vote.text || 'A motion'}</h2>
      ${vote.by || vote.second ? html`<p class="bs-quiet">${[vote.by && `Moved by ${vote.by}`, vote.second && `seconded by ${vote.second}`].filter(Boolean).join(', ')}</p>` : null}
      <ul class="bs-vote__counts">${[['for', 'For'], ['against', 'Against'], ['abstain', 'Abstain']].map(([k, l]) => html`<li class=${`is-${k}`} key=${k}><span class="bs-vote__n">${vote.counts[k]}</span><span>${l}</span><i style=${`--p:${vote.counts.of ? Math.min(100, (vote.counts[k] / vote.counts.of) * 100) : 0}%`}></i></li>`)}</ul>
      <p class="bs-quiet">${vote.counts.voted} of ${vote.counts.of} here ${vote.counts.voted === 1 ? 'has' : 'have'} voted, on the board page</p>
    </aside>` : null}
    ${stop.kind === 'doc' ? html`<div class="bs-foot">
      <span class="bs-foot__what">${label ? html`<b>${label}</b>` : null}${item?.title}<span class="bs-foot__sep">·</span>${docWords}</span>
      ${who.length ? html`<span class="bs-foot__who">${who.map((p) => html`<${Face} p=${p} size=${28} key=${p.slug || p.name} />`)}<span>${who.map((p) => p.name).join(' & ')}</span></span>` : null}
    </div>` : null}
    ${stop.kind === 'cover' || stop.kind === 'end' || stop.kind === 'since' ? null : html`<${Rail} meeting=${meeting} items=${items} at=${at} deck=${deck} ended=${ended} prior=${v.prior || []} timer=${timer} />`}
    <button type="button" class="bs-full" onClick=${fullScreen} aria-label="Full screen (F)">${document.fullscreenElement ? 'Exit full screen' : 'Full screen'}<kbd>F</kbd></button>
    ${!started && !told ? html`<p class="bs-wait">The screen follows the meeting once the chair starts it.</p>` : null}
  </div>`;
}

/**
 * On a board member's own page while the meeting is live: the page the screen is showing, small, and a way to
 * follow the screen full size. Nothing while no document is up.
 */
export function ScreenPeek({ v, onOpen }) {
  const f = v.live.fileId ? (v.files || []).concat((v.prior || []).flatMap((x) => x.files)).find((x) => x.id === v.live.fileId) : null;
  const ref = useRef(null);
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!f || !ref.current) return undefined;
    let gone = false;
    const w = Math.min(560, ref.current.parentElement?.clientWidth || 320);
    drawFitted(f, v.live.page, { w, h: Math.round(w * 0.62) }).then(({ el, count }) => {
      if (gone || !ref.current) return;
      setN(count);
      ref.current.replaceChildren(el);
    }).catch(() => {});
    return () => { gone = true; };
  }, [f?.id, v.live.page]);
  if (!f) return null;
  return html`<figure class="bp-peek">
    <div class="bp-peek__page" ref=${ref}></div>
    <figcaption><span><strong>On the screen:</strong> ${fileTitle(f.name)}, page ${v.live.page + 1}${n ? ` of ${n}` : ''}</span>
      <a class="bp-btn bp-btn--sm" href=${`#/meetings/${v.id}/screen`} onClick=${onOpen}>Follow the screen</a></figcaption>
  </figure>`;
}
