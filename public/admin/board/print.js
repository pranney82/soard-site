/**
 * The board page → Print it all
 * ===========================================================================
 * One print of a meeting, for anyone who wants it on paper: the agenda first
 * (each part with its time, who presents each item, its background, its
 * live facts as the page draws them: the makeovers by stage, the money as
 * figures, the dates; the documents that go with it), then each document, page by page, in the agenda's order, each
 * starting on a new sheet with what it is at the top. The browser's print
 * window then prints it, or saves it as one PDF.
 *
 * The pages are the ones the screen shows (./docs.js), so the printed
 * "page 3" is the screen's page 3. Built with the DOM's own text (never a
 * file's HTML), and taken away again once the print window closes.
 */

import { openDoc } from './docs.js';
import {
  meetingName, longDate, timeRange, liveLines, noteBlocks, agendaItems, presentersOf, itemFiles, looseFiles, fileTitle, isDate, clock, sectionPlan, MORE,
} from '../board-shared.js';
import { moneyFor, moneyTiles } from './money.js';

const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined && text !== null) e.textContent = String(text); return e; };

function points(text) {
  const blocks = noteBlocks(text);
  if (!blocks.length) return null;
  const wrap = el('div', 'bpp-notes');
  const list = (nodes) => { const ul = el('ul'); for (const n of nodes) { const li = el('li', '', n.text); if (n.children.length) li.append(list(n.children)); ul.append(li); } return ul; };
  let run = [];
  for (const b of blocks) {
    if (b.para) { if (run.length) { wrap.append(list(run)); run = []; } wrap.append(el('p', '', b.text)); } else run.push(b);
  }
  if (run.length) wrap.append(list(run));
  return wrap;
}

const STAGE_FLOW = ['Awaiting Funding', 'Design', 'Finalization', 'Approval', 'Mobilization', 'Build'];
const dayWords = (d) => (isDate(d) ? new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }) : '');

/** The makeovers on paper: a column per stage, each family by name with their reveal */
function makeoversBox(n) {
  const p = n?.projects;
  if (!p) return null;
  const all = [...(p.waiting || []), ...(p.building || [])];
  const stages = [...STAGE_FLOW.filter((st) => st !== 'Finalization' || all.some((b) => b.status === st)), ...new Set(all.map((b) => b.status).filter((st) => !STAGE_FLOW.includes(st)))];
  const box = el('div', 'bpp-board');
  box.style.setProperty('--cols', String(stages.length));
  for (const st of stages) {
    const list = all.filter((b) => b.status === st);
    const col = el('div', 'bpp-board__col');
    col.append(el('p', 'bpp-board__head', `${st === 'Awaiting Funding' ? 'Awaiting funding' : st} · ${list.length}`));
    const named = list.filter((b) => b.name);
    for (const b of named) {
      const r = b.slug ? (n.reveals || []).find((x) => x.slug === b.slug) : null;
      const card = el('p', 'bpp-board__kid');
      card.append(el('b', '', b.name), el('span', '', b.kind === 'community' ? 'Community project' : r?.confirmed && r.date ? `Reveal ${dayWords(r.date)}` : r?.window?.label ? `Reveal ${r.window.label}` : ''));
      col.append(card);
    }
    const more = list.length - named.length;
    if (more) col.append(el('p', 'bpp-board__more', `${named.length ? '+' : ''}${more} ${more === 1 ? 'family' : 'families'} not named yet`));
    if (!list.length) col.append(el('p', 'bpp-board__more', 'None now'));
    box.append(col);
  }
  return box;
}

/** The money as figures (./money.js moneyTiles) */
function moneyBox(n, money) {
  const tiles = moneyTiles({ cash: money?.cash ?? null, budget: money?.budget ?? null, n });
  if (!tiles.length) return null;
  const box = el('div', 'bpp-figs');
  for (const t of tiles) {
    const f = el('div', 'bpp-fig');
    f.append(el('span', 'bpp-fig__label', t.label), el('span', 'bpp-fig__value', t.value));
    if (t.sub) f.append(el('span', 'bpp-fig__sub', t.sub));
    box.append(f);
  }
  return box;
}

const fullDate = (d) => (isDate(d) ? new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '');
const shortDay = (d) => (isDate(d) ? new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '');
const signed = (n) => (typeof n === 'number' ? `${n < 0 ? '−' : ''}${n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).replace('-', '')}` : '–');
/** The statements from QuickBooks on paper, every line (numbers.books.statements), beside the same day a year before */
function statementsBox(s) {
  if (!s?.position?.length && !s?.activity?.length) return null;
  const box = el('div', 'bpp-stmts');
  box.append(el('p', 'bpp-stmts__when', `From QuickBooks, as of ${fullDate(s.asOf)}, beside ${fullDate(s.priorAsOf)}.`));
  const short = shortDay(s.asOf).replace(/, \d{4}$/, '');
  for (const [title, rows] of [['Statement of financial position', s.position], [`Statement of activities, January 1 to ${short}`, s.activity]]) {
    if (!rows?.length) continue;
    const prior = rows.some((r) => r.p != null);
    const t = el('table', 'bpp-stmt');
    t.append(el('caption', '', title));
    const head = el('tr');
    head.append(el('th', ''), el('th', 'num', shortDay(s.asOf)));
    if (prior) head.append(el('th', 'num', shortDay(s.priorAsOf)));
    const thead = el('thead'); thead.append(head);
    const tbody = el('tbody');
    for (const r of rows) {
      const tr = el('tr', `bpp-stmt__${r.k}`);
      const th = el('th', '', r.label);
      th.style.paddingLeft = `${r.d * 0.8}em`;
      tr.append(th);
      if (r.k === 'head') th.colSpan = prior ? 3 : 2;
      else { tr.append(el('td', 'num', signed(r.a))); if (prior) tr.append(el('td', 'num', signed(r.p))); }
      tbody.append(tr);
    }
    t.append(thead, tbody);
    box.append(t);
  }
  return box;
}

/** Rows of dates: reveals, events, board meetings */
function datesBox(rows) {
  if (!rows.length) return null;
  const ul = el('ul', 'bpp-dates');
  for (const r of rows) { const li = el('li'); li.append(el('b', '', r.when), el('span', '', r.what)); ul.append(li); }
  return ul;
}

/** An item's live facts on paper, drawn for what they are */
function liveBox(kind, n, m, money) {
  if (!n || !kind || kind === 'minutes') return null;
  if (kind === 'projects') return makeoversBox(n);
  if (kind === 'cash') {
    // The figures, then the statements the packet holds (QuickBooks', as of the books' close)
    const figs = moneyBox(n, money);
    const st = statementsBox(n?.books?.statements);
    if (!st) return figs;
    const box = el('div', 'bpp-money');
    if (figs) box.append(figs);
    box.append(st);
    return box;
  }
  if (kind === 'reveals') return datesBox((n.reveals || []).slice(0, 8).map((r) => ({ when: r.confirmed && r.date ? `${dayWords(r.date)}${r.time ? `, ${clock(r.time)}` : ''}` : r.window?.label || 'To come', what: r.name })));
  if (kind === 'events') return datesBox((n.events || []).slice(0, 6).map((e) => ({ when: dayWords(e.date), what: [e.title, e.location].filter(Boolean).join(' · ') })));
  if (kind === 'meetings') return datesBox((n.meetings || []).filter((x) => x.id !== m.id).slice(0, 4).map((x) => ({ when: `${dayWords(x.date)}${x.start ? `, ${clock(x.start)}` : ''}`, what: x.name })));
  const lines = liveLines(kind, n, { meetingId: m.id });
  if (!lines.length) return null;
  const box = el('ul', 'bpp-live');
  for (const l of lines) box.append(el('li', '', l));
  return box;
}

/** The agenda as the first pages: the meeting, then each part with its time, and each item */
function agendaPages(m, { people, numbers, meetings, money }) {
  const sheet = el('section', 'bpp-agenda');
  const head = el('header', 'bpp-head');
  head.append(el('p', 'bpp-eyebrow', 'Sunshine on a Ranney Day · Board of Directors'), el('h1', 'bpp-title', meetingName(m)));
  const when = [isDate(m.date) ? longDate(m.date) : '', timeRange(m.start, m.end)].filter(Boolean).join(' · ');
  if (when) head.append(el('p', 'bpp-when', when));
  const place = [m.location, m.address].filter(Boolean).join(', ');
  if (place) head.append(el('p', 'bpp-muted', place));
  sheet.append(head);
  const items = agendaItems(m);
  const plan = sectionPlan(m);
  const ol = el('ol', 'bpp-secs');
  m.sections.filter((s) => s.title || s.items.length).forEach((s, si) => {
    const li = el('li', 'bpp-sec');
    const h = el('h2', 'bpp-sec__title');
    const t = plan.get(s.id);
    h.append(el('span', 'bpp-sec__n', String(si + 1).padStart(2, '0')), el('span', 'bpp-sec__name', s.title || 'Agenda'));
    if (t) h.append(el('span', 'bpp-sec__time', [t.start ? clock(t.start) : '', `${t.minutes} min`].filter(Boolean).join(' · ')));
    li.append(h);
    for (const it of s.items) {
      const row = el('div', 'bpp-item');
      const tt = el('h3', 'bpp-item__title');
      const n = items.find((x) => x.id === it.id);
      tt.append(el('span', 'bpp-num', n?.label || ''), el('span', 'bpp-item__name', it.title || 'Item'));
      const who = presentersOf(it, people).map((p) => p.name);
      if (who.length) tt.append(el('span', 'bpp-who', who.join(' & ')));
      row.append(tt);
      if (it.confidential) row.append(el('p', 'bpp-flag', 'Board only · please don’t share'));
      const notes = points(it.notes);
      if (notes) row.append(notes);
      const facts = liveBox(it.live, numbers, m, money);
      if (facts) row.append(facts);
      const files = itemFiles(m, it, meetings);
      if (files.length) row.append(el('p', 'bpp-docs', `With it: ${files.map((f) => fileTitle(f.name)).join(', ')}`));
      li.append(row);
    }
    ol.append(li);
  });
  sheet.append(ol);
  return sheet;
}

/**
 * Print a meeting with every document. `onStep({ done, of, what })` hears how far it has got; `signal` (an
 * AbortSignal) stops it. Resolves once the print window has closed.
 */
export async function printAll(m, { people = [], numbers = null, meetings = [], data = null, onStep = () => {}, signal } = {}) {
  const items = agendaItems(m);
  const groups = [
    ...m.sections.flatMap((s) => s.items).map((it) => ({ it, label: items.find((x) => x.id === it.id)?.label || '', files: itemFiles(m, it, meetings) })),
    { it: MORE, label: '', files: looseFiles(m) },
  ].filter((g) => g.files.length);
  const urls = [];
  const root = el('div', 'bpp');
  root.setAttribute('aria-hidden', 'true');
  // The money the Financial item shows: the balance sheet and budget as of this meeting (a past one keeps its own)
  const money = data && m.sections.some((sec) => sec.items.some((it) => it.live === 'cash')) ? await moneyFor(data, m.date < data.today ? m.date : '', numbers).catch(() => null) : null;
  root.append(agendaPages(m, { people, numbers, meetings, money }));
  // How many pages, so the progress can say "12 of 40"
  const docs = [];
  for (const g of groups) for (const f of g.files) {
    if (signal?.aborted) return;
    onStep({ done: 0, of: 0, what: fileTitle(f.name) });
    const doc = await openDoc(f).catch(() => null);
    if (doc) docs.push({ g, f, doc });
  }
  const of = docs.reduce((n, x) => n + x.doc.count, 0);
  let done = 0;
  for (const { g, f, doc } of docs) {
    for (let i = 0; i < doc.count; i++) {
      if (signal?.aborted) return;
      onStep({ done, of, what: fileTitle(f.name) });
      const size = doc.size(i);
      const wide = size.w > size.h;
      const page = el('section', `bpp-page ${wide ? 'is-wide' : ''}`);
      if (i === 0) {
        const cap = el('p', 'bpp-cap');
        cap.append(el('b', '', g.label ? `${g.label} ${g.it.title}` : g.it.title), document.createTextNode(` · ${fileTitle(f.name)}${doc.count > 1 ? ` · ${doc.count} pages` : ''}`));
        page.append(cap);
      }
      // Drawn at the printed sheet's width, sharp enough for paper
      const drawn = await doc.draw(i, { width: wide ? 960 : 720, dpr: 2 }).catch(() => null);
      if (drawn) page.append(await asPicture(drawn, urls));
      root.append(page);
      done += 1;
    }
  }
  onStep({ done: of, of, what: '' });
  if (signal?.aborted) return;
  document.body.append(root);
  document.documentElement.classList.add('bp-printing-all');
  await new Promise((resolve) => {
    const finish = () => { removeEventListener('afterprint', finish); resolve(); };
    addEventListener('afterprint', finish);
    // Images drawn from canvases are ready at once; a moment for the layout first
    requestAnimationFrame(() => setTimeout(() => window.print(), 50));
  });
  document.documentElement.classList.remove('bp-printing-all');
  root.remove();
  urls.forEach((u) => URL.revokeObjectURL(u));
}

/** A drawn page with a canvas in it, as a JPEG picture instead (forty pages of canvases would fill a phone's memory) */
async function asPicture(node, urls) {
  const canvas = node instanceof HTMLCanvasElement ? node : node.querySelector?.(':scope > canvas');
  if (!canvas) return node;
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.9));
  if (!blob) return node;
  const url = URL.createObjectURL(blob);
  urls.push(url);
  const img = el('img', 'bpp-img');
  img.src = url;
  img.alt = '';
  img.style.width = canvas.style.width || `${canvas.clientWidth || 720}px`;
  canvas.width = 0;
  canvas.height = 0;
  if (node === canvas) return img;
  canvas.replaceWith(img);
  return node;
}
