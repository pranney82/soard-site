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
  showsOf, booksDraw, isStatement,
} from '../board-shared.js';
import { moneyFor, moneyTiles, mixOf, shareOf, changeOf, storeOf, storeChange, budgetMonthsText, stepText, readChangeAs, changeIn, overIn } from './money.js';
import { reportDom, motionDom } from '../board-report.js';
import { h, render } from '../vendor.js';
import { YearCompare } from './books.js';
import { lineKeysOf, notesByKey, noteText } from './review.js';

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

/** Where the year's revenue came from on paper (./money.js mixOf): the bar, then each category beside last year's same days */
function revenueBox(books) {
  const mix = mixOf(books);
  if (!mix) return null;
  const box = el('div', 'bpp-mix');
  box.append(el('p', 'bpp-mix__h', `Where ${mix.year}’s revenue came from`));
  const bar = el('div', 'bpp-mix__bar');
  for (const x of mix.parts) { const seg = el('span', `bp-tone--${x.tone}`); seg.style.setProperty('--p', `${x.w}%`); bar.append(seg); }
  box.append(bar);
  const last = mix.parts.some((x) => x.last != null);
  const t = el('table', 'bpp-stmt');
  const head = el('tr');
  head.append(el('th', ''), el('th', 'num', `${mix.year} so far`), el('th', 'num', 'Share'));
  if (last) head.append(el('th', 'num', `${mix.lastYear}, same days`), el('th', 'num', 'Change'));
  const thead = el('thead'); thead.append(head);
  const tbody = el('tbody');
  for (const x of mix.parts) {
    const tr = el('tr');
    const name = el('th', '');
    name.append(el('i', `bpp-mix__key bp-tone--${x.tone}`), document.createTextNode(x.name));
    tr.append(name, el('td', 'num', signed(x.amount)), el('td', 'num', shareOf(x.amount, mix.total)));
    if (last) tr.append(el('td', 'num', x.last == null ? '–' : signed(x.last)), el('td', 'num', changeOf(x.amount, x.last) || '–'));
    tbody.append(tr);
  }
  t.append(thead, tbody);
  box.append(t);
  return box;
}

const fullDate = (d) => (isDate(d) ? new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '');
const shortDay = (d) => (isDate(d) ? new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : '');
const signed = (n) => (typeof n === 'number' ? `${n < 0 ? '−' : ''}${n.toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).replace('-', '')}` : '–');
/**
 * The statements from QuickBooks on paper, every line (numbers.books.statements), beside the same day a year before,
 * and QuickBooks' budget against them; the presenter's notes (./review.js) each under its line
 */
function statementsBox(s, budget = null, notes = null) {
  const said = notesByKey(notes);
  if (!s?.position?.length && !s?.activity?.length) return null;
  const box = el('div', 'bpp-stmts');
  box.append(el('p', 'bpp-stmts__when', `From QuickBooks, as of ${fullDate(s.asOf)}, beside ${fullDate(s.priorAsOf)}.`));
  const short = shortDay(s.asOf).replace(/, \d{4}$/, '');
  // QuickBooks' budget (the board's) against the activities, to the same day: the actual, the budget, over (under)
  const bud = budget?.rows?.length && budget.asOf === s.asOf ? budget : null;
  // Changes as this device last picked them (% or $: the board page's statements, the meeting's screen)
  const as = readChangeAs();
  for (const [title, rows, heads, which] of [
    ['Statement of financial position', s.position, null, 'pos'],
    [`Statement of activities, January 1 to ${short}`, s.activity, null, 'act'],
    ...(bud ? [[`Budget against actual, January 1 to ${short} (QuickBooks’ ${bud.name}, ${budgetMonthsText(bud.months)} of ${bud.of} months${stepText(bud.step)})`, bud.rows.map((r) => ({ ...r, p: r.b })), ['Actual', 'Budget', 'Over (under)'], 'bud']] : []),
  ]) {
    if (!rows?.length) continue;
    const keys = said.size ? lineKeysOf(rows, which) : [];
    const prior = rows.some((r) => r.p != null);
    const t = el('table', 'bpp-stmt');
    t.append(el('caption', '', title));
    const head = el('tr');
    head.append(el('th', ''), el('th', 'num', heads ? heads[0] : shortDay(s.asOf)));
    if (prior) head.append(el('th', 'num', heads ? heads[1] : shortDay(s.priorAsOf)), el('th', 'num', heads ? heads[2] : 'Change'));
    const thead = el('thead'); thead.append(head);
    const tbody = el('tbody');
    rows.forEach((r, i) => {
      const tr = el('tr', `bpp-stmt__${r.k}`);
      const th = el('th', '', r.label);
      th.style.paddingLeft = `${r.d * 0.8}em`;
      tr.append(th);
      if (r.k === 'head') th.colSpan = prior ? 4 : 2;
      else { tr.append(el('td', 'num', signed(r.a))); if (prior) tr.append(el('td', 'num', signed(r.p)), el('td', 'num', heads ? overIn(r.a, r.p, as) : changeIn(r.a, r.p, as) || '–')); }
      tbody.append(tr);
      const note = keys.length && r.k !== 'head' ? said.get(keys[i]) : null;
      if (note) {
        const nr = el('tr', 'bpp-stmt__note');
        const td = el('td', '', noteText(note));
        td.colSpan = prior ? 4 : 2;
        td.style.paddingLeft = `${r.d * 0.8}em`;
        nr.append(td);
        tbody.append(nr);
      }
    });
    t.append(thead, tbody);
    box.append(t);
  }
  return box;
}

/** The year against last year, month by month, as the board page draws it (books.js YearCompare, its table left off) */
function yearBox(books) {
  const box = el('div', 'bpp-year');
  render(h(YearCompare, { books, idp: 'pyc' }), box);
  return box.firstChild ? box : null;
}

/** Rows of dates: reveals, events, board meetings */
function datesBox(rows) {
  if (!rows.length) return null;
  const ul = el('ul', 'bpp-dates');
  for (const r of rows) { const li = el('li'); li.append(el('b', '', r.when), el('span', '', r.what)); ul.append(li); }
  return ul;
}

/** The store on paper (./money.js storeOf): its sales, its cost of goods and the profit before staff and rent, beside last year's same days */
function storeBox(books) {
  const st = storeOf(books);
  if (!st) return null;
  const box = el('div', 'bpp-store');
  box.append(el('p', 'bpp-mix__h', `The store, ${st.year} so far`));
  const t = el('table', 'bpp-stmt');
  const head = el('tr');
  head.append(el('th', ''), el('th', 'num', `${st.year} so far`));
  if (st.lastYear) head.append(el('th', 'num', `${st.lastYear}, same days`), el('th', 'num', 'Change'));
  const thead = el('thead'); thead.append(head);
  const tbody = el('tbody');
  for (const x of st.lines) {
    const tr = el('tr', x.k === 'profit' ? 'bpp-stmt__sum' : '');
    tr.append(el('th', '', x.name), el('td', 'num', signed(x.amount)));
    if (st.lastYear) tr.append(el('td', 'num', x.last == null ? '–' : signed(x.last)), el('td', 'num', storeChange(x, readChangeAs()) || '–'));
    tbody.append(tr);
  }
  // Its profit as a share of its sales, beside last year's
  if (st.margin != null) {
    const pct = (m) => (m == null ? '–' : `${Math.round(m * 100)}%`);
    const tr = el('tr', '');
    tr.append(el('th', '', 'Profit as a share of sales'), el('td', 'num', pct(st.margin)));
    if (st.lastYear) tr.append(el('td', 'num', pct(st.lastMargin)), el('td', 'num', st.lastMargin == null ? '–' : `${st.margin >= st.lastMargin ? '▲' : '▼'} ${Math.abs(Math.round((st.margin - st.lastMargin) * 100))} pts`));
    tbody.append(tr);
  }
  t.append(thead, tbody);
  box.append(t);
  return box;
}

/** An item's live facts on paper, drawn for what they are */
function liveBox(kind, n, m, money, notes = null, books = n?.books) {
  if (!n || !kind || kind === 'minutes') return null;
  if (kind === 'projects') return makeoversBox(n);
  if (kind === 'cash') {
    // The figures, the year against last year, where the revenue came from, the store, then the statements the packet
    // holds (QuickBooks', as of the books' close)
    const parts = [moneyBox(n, money), yearBox(books), revenueBox(books), storeBox(books), statementsBox(books?.statements, books?.budget, notes)].filter(Boolean);
    if (parts.length < 2) return parts[0] || null;
    const box = el('div', 'bpp-money');
    box.append(...parts);
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
function agendaPages(m, { people, numbers, meetings, money, lineNotes = {}, books = numbers?.books }) {
  let booked = false;
  // The statements QuickBooks draws on the money item aren't printed again as files
  const drawsSt = booksDraw(books).some((b) => b === 'act' || b === 'pos');
  const docFiles = (it) => itemFiles(m, it, meetings).filter((f) => !(drawsSt && showsOf(it).includes('cash') && isStatement(f)));
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
    // A part with a report may run on to the next sheet (kept whole, it would leave this one blank)
    const li = el('li', `bpp-sec ${s.items.some((it) => it.report) ? 'has-report' : ''}`);
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
      // The presenter's report, as it reads on the board page (a long one may run on to the next sheet)
      const report = reportDom(it.report);
      if (report) {
        row.classList.add('has-report');
        const box = el('div', 'bpp-report');
        box.append(el('p', 'bpp-report__by', ['Report', it.reportBy ? `by ${it.reportBy}` : ''].filter(Boolean).join(' ')), report);
        row.append(box);
      }
      // What it asks the board to vote on
      const motion = motionDom(it.motion);
      if (motion) row.append(motion);
      // QuickBooks' year and statements under the first item showing the money; another shows its figures (as the screen)
      const bk = booked ? null : books;
      if (showsOf(it).includes('cash')) booked = true;
      for (const k of showsOf(it)) { const facts = liveBox(k, numbers, m, money, k === 'cash' ? lineNotes[it.id] : null, bk); if (facts) row.append(facts); }
      const files = docFiles(it);
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
  // The books the way the money's figures go (./portal.js CashBlock): today's for a meeting today or ahead, the locked
  // ones for a past meeting
  const books = data && m.date >= data.today ? data.numbers?.books || numbers?.books : numbers?.books;
  const drawsSt = booksDraw(books).some((b) => b === 'act' || b === 'pos');
  const docFiles = (it) => itemFiles(m, it, meetings).filter((f) => !(drawsSt && showsOf(it).includes('cash') && isStatement(f)));
  const groups = [
    ...m.sections.flatMap((s) => s.items).map((it) => ({ it, label: items.find((x) => x.id === it.id)?.label || '', files: docFiles(it) })),
    { it: MORE, label: '', files: looseFiles(m) },
  ].filter((g) => g.files.length);
  const urls = [];
  const root = el('div', 'bpp');
  root.setAttribute('aria-hidden', 'true');
  // The money the Financial item shows: the balance sheet and budget as of this meeting (a past one keeps its own)
  const money = data && m.sections.some((sec) => sec.items.some((it) => showsOf(it).includes('cash'))) ? await moneyFor(data, m.date < data.today ? m.date : '', numbers).catch(() => null) : null;
  root.append(agendaPages(m, { people, numbers, meetings, money, lineNotes: data?.lineNotes?.[m.id] || {}, books }));
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
