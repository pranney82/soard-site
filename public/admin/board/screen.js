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
import { openDoc, layoutOf, halfOf } from './docs.js';
import {
  meetingName, longDate, shortDate, timeRange, liveLines, noteBlocks, agendaItems, presentersOf, itemFiles, deckOf, stopIndex, fileTitle, isDate, clock, todayEastern, MORE,
  sectionPlan, sectionClock, clockText, facesOf,
} from '../board-shared.js';
import { Kanban, kanbanLine, sized } from './kanban.js';
import { useCashNow, useBudget, moneyTiles } from './money.js';

const html = htm.bind(h);
const API = '/api/board-portal';
const CHANNEL = 'soard-board-screen';
// The chair's own copy of the screen, small in Board's During (?mirror): it follows the chair but isn't a screen
// window (it never says hello, takes no keys and has no full-screen button)
const MIRROR = new URLSearchParams(location.search).has('mirror');
const LOGO = '/cdn-cgi/imagedelivery/ROYFuPmfN2vPS6mt5sCkZQ/brand-logo-admin/w=256';

const initialsOf = (name) => { const w = String(name || '').split(/\s+/).filter(Boolean); return ((w[0]?.[0] || '') + (w.length > 1 ? w.at(-1)[0] : '')).toUpperCase() || '?'; };
const hueOf = (s) => [42, 28, 96, 152, 200, 18][[...String(s)].reduce((a, c) => a + c.charCodeAt(0), 0) % 6];
function Face({ p, size }) {
  const [broken, setBroken] = useState(false);
  return p?.photo && !broken
    ? html`<img class="bs-face" src=${p.photo} alt="" width=${size} height=${size} style=${`--s:${size}px`} onError=${() => setBroken(true)} />`
    : html`<span class="bs-face bs-face--initials" style=${`--s:${size}px;--hue:${hueOf(p?.name)}`} aria-hidden="true">${initialsOf(p?.name)}</span>`;
}
const FULL = html`<svg viewBox="0 0 20 20" width="18" height="18" aria-hidden="true"><path d="M3.5 7.5v-4h4M12.5 3.5h4v4M16.5 12.5v4h-4M7.5 16.5h-4v-4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg>`;
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

/**
 * Page `page` of a file drawn as big as `box` ({ w, h }) allows, showing the part of it with something on it: all
 * of it, or of a tall page the half `part` (./docs.js layoutOf) → { el, count, halves }. `ahead` also draws the next
 * page, so it's there at once.
 */
async function drawFitted(f, page, box, { ahead = false, part = 0 } = {}) {
  const doc = await openDoc(f);
  const i = Math.max(0, Math.min(page, doc.count - 1));
  const size = doc.size(i);
  const fit = Math.floor(Math.min(box.w, (box.h * size.w) / size.h));
  // Where its words are (worked out once a page, small, the same everywhere)
  const lay = await layoutOf(f, doc, i);
  const area = halfOf(lay, part);
  const H0 = Math.round((size.h * fit) / size.w);
  const zoom = area ? Math.min(3, box.w / (area.w * fit), box.h / (area.h * H0)) : 1;
  let el;
  if (area && zoom > 1.12) {
    const W = Math.floor(fit * zoom);
    const H = Math.round((size.h * W) / size.w);
    const page2 = await doc.draw(i, { width: W });
    el = document.createElement('div');
    el.className = 'bs-crop';
    el.style.width = `${Math.round(area.w * W)}px`;
    el.style.height = `${Math.round(area.h * H)}px`;
    page2.style.marginLeft = `${-Math.round(area.x * W)}px`;
    page2.style.marginTop = `${-Math.round(area.y * H)}px`;
    el.append(page2);
  } else {
    el = await doc.draw(i, { width: fit });
  }
  if (ahead && i + 1 < doc.count) layoutOf(f, doc, i + 1).catch(() => {});
  return { el, count: doc.count, halves: lay.n };
}

/** A page (or half of one) on the screen, kept up until the next is drawn (no flash between); `onPages` hears the counts */
function DocPage({ f, page, part = 0, box, onPages }) {
  const ref = useRef(null);
  const [state, setState] = useState('opening');
  useEffect(() => {
    if (!f || !box.w || !box.h) return undefined;
    let gone = false;
    drawFitted(f, page, box, { ahead: true, part }).then(({ el, count, halves }) => {
      if (gone || !ref.current) return;
      onPages?.(f.id, count, page, halves);
      ref.current.replaceChildren(el);
      setState('');
    }).catch(() => { if (!gone) setState('failed'); });
    return () => { gone = true; };
  }, [f?.id, page, part, box.w, box.h]);
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
/** A face at the size of a room: the People photo asked for big enough to stay sharp on a TV */
const roomPhoto = (url) => String(url || '').replace(/\bw=\d+,h=\d+/, 'w=480,h=480');

/**
 * The board's faces (facesOf): for the roll call everyone on the meeting's list, each lighting up as they check in
 * on the board page, the ones not here yet dimmed; for a go-around (introductions, each one's news) the ones here.
 * Before the meeting starts (a rehearsal, a preview) everyone as they are. New this year: a mark under the name.
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
    // An officer's seat, else their company (People keeps "Company, Role")
    const sub = started && p.how ? (p.how === 'remote' ? 'On video' : 'In the room') : p.title && !/^board member$/i.test(p.title) ? p.title : String(p.organization || '').split(/,\s*/)[0] || p.title || '';
    return html`<li class=${`bs-faces__one ${state}`} key=${p.slug || p.name}>
      <span class="bs-faces__pic">
        ${p.photo ? html`<img src=${roomPhoto(p.photo)} alt="" />` : html`<span class="bs-faces__initials" style=${`--hue:${hueOf(p.name)}`}>${initialsOf(p.name)}</span>`}
        ${state === 'is-here' || state === 'is-remote' ? html`<span class="bs-faces__mark" aria-hidden="true">${CHECK}</span>` : null}
      </span>
      <strong class="bs-faces__name">${p.name}</strong>
      <span class="bs-faces__sub"><span>${sub}</span>${typeof p.since === 'number' && p.since >= year ? html`<b>New</b>` : null}</span>
    </li>`;
  })}</ul>`;
}
const CHECK = html`<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M4.5 10.5l3.6 3.6 7.4-8.2" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" /></svg>`;
/** The roll call's count, beside its title: here of the list, and the quorum (met, or how many more) */
function RollCount({ v, started }) {
  const roll = v.roll || [];
  const n = roll.filter((p) => p.how).length;
  const q = v.here?.quorum || 0;
  if (!started) return html`<div class="bs-roll"><span class="bs-roll__n">${roll.length}<small> on the board</small></span><span class="bs-quiet">Each one checks in with a tap on the board page</span></div>`;
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
    : next.kind === 'doc' && next.fileId === stop?.fileId && next.page === stop.page ? html`<span>Next: the bottom half</span>`
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
  const [halves, setHalves] = useState({}); // { fileId: [halves of each page] }: the chair's, and the pages drawn here
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

  // Keys here go back to the chair; F fills the screen
  useEffect(() => {
    if (MIRROR) return undefined;
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
    if (MIRROR) { setAwake(false); const clockTick = setInterval(() => setTick(Date.now()), 1000); return () => clearInterval(clockTick); }
    let t = setTimeout(() => setAwake(false), 2500);
    const move = () => { setAwake(true); clearTimeout(t); t = setTimeout(() => setAwake(false), 2500); };
    addEventListener('pointermove', move);
    const clockTick = setInterval(() => setTick(Date.now()), 1000);
    return () => { clearTimeout(t); clearInterval(clockTick); removeEventListener('pointermove', move); };
  }, []);

  useEffect(() => { if (!MIRROR) document.title = v ? `${v.title} · On the screen` : 'SOARD Board · On the screen'; }, [v?.title]);

  // (A meeting not shared yet, previewed by an admin, isn't in the board page's list: its name comes with the view)
  const m = data.meetings.find((x) => x.id === id) || null;
  const meeting = useMemo(() => (v ? { ...(m || {}), id, title: m?.title || v.title || '', date: v.date, start: m?.start || v.start || '', end: m?.end || v.end || '', sections: v.sections, files: v.files || [] } : null), [v, m]);
  const plan = useMemo(() => (meeting ? sectionPlan(meeting) : new Map()), [meeting]);
  const deck = useMemo(() => (meeting ? deckOf(meeting, { pages, parts: halves, meetings: v.prior || [] }) : []), [meeting, pages, halves]);
  const notePages = (fileId, count, page, n) => {
    setPages((p) => {
      if (p[fileId] === count) return p;
      ch.current?.postMessage({ type: 'pages', id, pages: { [fileId]: count } });
      return { ...p, [fileId]: count };
    });
    setHalves((x) => (x[fileId]?.[page] === n ? x : { ...x, [fileId]: Object.assign([...(x[fileId] || [])], { [page]: n }) }));
  };

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
  // The half of a tall page on: the chair's word for this page (this deck may not have split it yet), else the stop's
  const half = stop.kind === 'doc' && stop.fileId === live.fileId && stop.page === (live.page || 0) ? (live.part ? 1 : 0) : stop.part || 0;
  const numbers = v.snapshot || data.numbers;
  const vote = v.vote && started && !ended && !(fresh && told.rehearsal) ? v.vote : null;
  const place = [m?.location, m?.address].filter(Boolean).join(', ');

  const top = html`<header class="bs-top">
    <span class="bs-brand"><img src=${LOGO} alt="" width="40" height="40" /><span><strong>${meetingName(meeting)}</strong><small>${[isDate(meeting.date) ? longDate(meeting.date) : '', started && !ended ? 'Live' : ''].filter(Boolean).join(' · ')}</small></span></span>
    ${(stop.kind === 'item' || stop.kind === 'doc') && floor.length ? html`<span class=${`bs-floor ${given ? 'is-given' : ''}`}>${floor.map((p) => html`<${Face} p=${p} size=${34} key=${p.slug || p.name} />`)}<span><strong>${floor.map((p) => p.name).join(' & ')}</strong> has the floor</span></span>` : null}
    <span class="bs-top__right">${timer ? html`<span class=${`bs-timer ${timer.over ? 'is-over' : ''}`} role="timer">${timer.over ? `Time’s up · ${clockText(timer.left)} over` : `${clockText(timer.left)} left`}</span>` : null}${told?.rehearsal ? html`<span class="bs-chip">Rehearsal</span>` : null}${v.practice ? html`<span class="bs-chip">Practice</span>` : null}${label ? html`<span class="bs-num">${label}</span>` : null}<span class="bs-clock">${nowClock()}</span>${MIRROR ? null : html`<button type="button" class="bs-full" onClick=${fullScreen} aria-label=${document.fullscreenElement ? 'Exit full screen (F)' : 'Full screen (F)'} title=${document.fullscreenElement ? 'Exit full screen (F)' : 'Full screen (F)'}>${FULL}</button>`}</span>
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
    const faces = stop.n >= 0 ? facesOf(item) : '';
    const facts = faces ? null : liveSlide(item.live, numbers, id, data, meeting.date);
    const head = html`<p class="bs-eyebrow">${[section && section !== item.title ? section : '', !section && stop.n < 0 ? 'Also for this meeting' : ''].filter(Boolean).join('') || 'Agenda'}</p>
      <h1 class="bs-display bs-item__title">${item.title}</h1>
      ${item.confidential ? html`<p class="bs-chip bs-chip--warn">Board only · please don’t share</p>` : null}`;
    const whoList = who.length ? html`<ul class="bs-who">${who.map((p) => html`<li key=${p.slug || p.name}><${Face} p=${p} size=${facts || faces ? 52 : 72} /><span><strong>${p.name}</strong>${p.title ? html`<small>${p.title}</small>` : null}</span></li>`)}</ul>` : null;
    const coming = files.length ? html`<div class="bs-coming"><p class="bs-eyebrow">${files.length === 1 ? 'Its document, next' : 'Its documents, next'}</p><ol>${files.map((f) => html`<li key=${f.id}>${fileTitle(f.name)}${pages[f.id] > 1 ? html`<span> · ${pages[f.id]} pages</span>` : null}</li>`)}</ol></div>` : null;
    if (faces) {
      stage = html`<div class="bs-item bs-item--board bs-item--faces">
        <div class="bs-item__bar"><div>${head}</div><div class="bs-item__aside">${faces === 'roll' ? html`<${RollCount} v=${v} started=${started} />` : whoList}</div></div>
        <div class="bs-item__facts"><${FacesGrid} kind=${faces} v=${v} people=${people} started=${started} year=${Number(String(meeting.date).slice(0, 4))} /></div>
      </div>`;
    } else if (facts && item.live === 'projects') {
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
      // Approving the last minutes: the motion the board votes on, and how it went once the board page's vote closed
      const motion = item.live === 'minutes' ? html`<${MinutesMotion} item=${item} v=${v} />` : null;
      const side = item.notes || coming || motion;
      // Nothing more to show: where it sits in its part, when the part has more than it
      const sec = stop.n >= 0 ? meeting.sections[items[stop.n].si] : null;
      const part = !side && sec?.items.length > 1 ? html`<${PartList} sec=${sec} items=${items} current=${item} people=${people} />` : null;
      stage = html`<div class=${`bs-item ${side || part ? 'bs-item--split' : 'bs-item--title'}`}>
        <div class="bs-item__lead">${head}${whoList}</div>
        ${side ? html`<div class="bs-item__side">${motion}${item.notes ? html`<${Points} text=${item.notes} />` : null}${coming}</div>` : part ? html`<div class="bs-item__side">${part}</div>` : null}
      </div>`;
    }
  } else {
    stage = html`<${DocPage} f=${file} page=${stop.page} part=${half} box=${box} onPages=${notePages} key=${file?.id} />`;
  }
  const docWords = stop.kind === 'doc' ? `${fileTitle(file?.name)} · Page ${stop.page + 1}${pages[stop.fileId] ? ` of ${pages[stop.fileId]}` : ''}${halves[stop.fileId]?.[stop.page] === 2 ? `, ${half ? 'bottom' : 'top'} half` : ''}` : '';

  // The line under the stage and the rail are there on every stop, so the stage keeps its size from one to the next
  return html`<div class=${`bs bs--${stop.kind} ${awake ? 'is-awake' : ''} ${vote ? 'has-vote' : ''} ${MIRROR ? 'is-mirror' : ''}`}>
    ${top}
    <main class="bs-stage" ref=${stageRef}><div class="bs-stage__in" key=${stop.kind === 'doc' ? `doc:${stop.fileId}` : stop.key}>${stage}</div></main>
    ${vote ? html`<aside class="bs-vote" aria-live="polite">
      <p class="bs-eyebrow">The board is voting</p>
      <h2 class="bs-vote__what">${vote.text || 'A motion'}</h2>
      ${vote.by || vote.second ? html`<p class="bs-quiet">${[vote.by && `Moved by ${vote.by}`, vote.second && `seconded by ${vote.second}`].filter(Boolean).join(', ')}</p>` : null}
      <ul class="bs-vote__counts">${[['for', 'For'], ['against', 'Against'], ['abstain', 'Abstain']].map(([k, l]) => html`<li class=${`is-${k}`} key=${k}><span class="bs-vote__n">${vote.counts[k]}</span><span>${l}</span><i style=${`--p:${vote.counts.of ? Math.min(100, (vote.counts[k] / vote.counts.of) * 100) : 0}%`}></i></li>`)}</ul>
      <p class="bs-quiet">${vote.counts.voted} of ${vote.counts.of} here ${vote.counts.voted === 1 ? 'has' : 'have'} voted, on the board page</p>
    </aside>` : null}
    <div class="bs-foot">${stop.kind === 'doc' ? html`
      <span class="bs-foot__what">${label ? html`<b>${label}</b>` : null}${item?.title}<span class="bs-foot__sep">·</span>${docWords}</span>
      ${pages[stop.fileId] > 1 && pages[stop.fileId] <= 12 ? html`<span class="bs-foot__pages" aria-hidden="true">${Array.from({ length: pages[stop.fileId] }, (_, i) => html`<i class=${i === stop.page ? 'is-on' : ''} key=${i}></i>`)}</span>` : null}`
      : !started && !told && !MIRROR ? html`<span class="bs-foot__what">The screen follows the meeting once the chair starts it.</span>` : null}
    </div>
    <${Rail} meeting=${meeting} items=${items} at=${at} deck=${deck} ended=${ended} prior=${v.prior || []} timer=${timer} />
  </div>`;
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
    <figcaption><span><strong>On the screen:</strong> ${fileTitle(f.name)}, page ${v.live.page + 1}${n.count ? ` of ${n.count}` : ''}${n.halves === 2 ? `, ${v.live.part ? 'bottom' : 'top'} half` : ''}</span>
      <a class="bp-btn bp-btn--sm" href=${`#/meetings/${v.id}/screen`} onClick=${onOpen}>Follow the screen</a></figcaption>
  </figure>`;
}
