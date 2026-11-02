/**
 * books.js — the money as QuickBooks keeps it, beside last year
 * ===========================================================================
 * The money item on the board page (./portal.js), on the screen (./screen.js) and on paper (./print.js), drawn
 * from QuickBooks' own numbers (functions/api/_quickbooks.js) instead of statements attached as files:
 *
 *   YearCompare     the year so far against last year, month by month: revenue and expenses each a small chart
 *                   (this year solid, last year dashed, one axis each), a crosshair to read any month (pointer or
 *                   ← →), and the same numbers as a table
 *   StatementLines  a statement's main lines (activities, or financial position) beside the same day a year before
 *   BooksSlide      one of those as a slide, at the size of a room (deckOf's 'books' stops)
 *
 * Colors (checked with the dataviz validator, light on the page's cream and white, dark on the screen): this year
 * gold #8A6A00 / #B08F00, last year blue #2B6CB0 / #5994DA, last year dashed too, and every line named at its end.
 */

import { h, htm, useState } from '../vendor.js';
import { money, shortDate } from '../board-shared.js';
import { compact, storeOf, storeChange } from './money.js';

const html = htm.bind(h);
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const dayMonth = (d) => (d ? new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' }) : '');

/** "▲ 25%" against last year ('Even', or '' with nothing to set it beside) */
export const changeWords = (a, p) => {
  if (!(typeof a === 'number' && typeof p === 'number' && p > 0)) return '';
  const c = Math.round(((a - p) / p) * 100);
  return c === 0 ? 'Even' : `${c > 0 ? '▲' : '▼'} ${Math.abs(c)}%`;
};

/**
 * Month by month, each added to the months before it: this year through the month it's in, last year all twelve.
 * → { year, lastYear, upTo, revenue: { now, then }, spent: { now, then } } (arrays of 12, this year null after upTo),
 * or null without the months (an older read, a locked meeting's numbers from before they were kept)
 */
export function yearSeries(books) {
  const mo = books?.monthly;
  if (!mo?.months?.length) return null;
  const at = (m) => Number(String(m || '').slice(5, 7)) - 1;
  const upTo = Math.max(...mo.months.map((x) => at(x.month)).filter((i) => i >= 0 && i < 12));
  const run = (list, key, last) => {
    const by = Array(12).fill(0);
    for (const x of list || []) { const i = at(x.month); if (i >= 0 && i < 12) by[i] += Number(x[key]) || 0; }
    let t = 0;
    return by.map((v, i) => { t += v; return i <= last ? Math.round(t) : null; });
  };
  const has = (mo.last || []).length > 0;
  return {
    year: mo.year || books.year || '', lastYear: mo.lastYear || books.lastYear?.year || '', upTo,
    revenue: { now: run(mo.months, 'revenue', upTo), then: has ? run(mo.last, 'revenue', 11) : null },
    spent: { now: run(mo.months, 'spent', upTo), then: has ? run(mo.last, 'spent', 11) : null },
  };
}

/** A round top for the axis: 1, 2, 2.5 or 5 times a power of ten, at or over the highest */
function niceMax(v) {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((k) => k * p).find((x) => x >= v * 1.04) || 10 * p;
}

const W = 640;
const BASE_H = 250;
const PAD = { l: 52, r: 92, t: 14, b: 30 };
/**
 * One measure, this year against last, added up month by month. `today`: this year's last point is the year so far,
 * and last year's at that point is its same days (`sameDays`), as the figures above say
 */
function YearLines({ id, title, now, then, year, lastYear, upTo, sameDays = null, through = '', tall = false }) {
  const [at, setAt] = useState(-1);
  // Taller on the screen, where there's the room (the same width, so the words stay their size)
  const H = tall ? 340 : BASE_H;
  const all = [...now.filter((v) => v !== null), ...(then || [])];
  const max = niceMax(Math.max(...all, 0));
  const pw = W - PAD.l - PAD.r;
  const ph = H - PAD.t - PAD.b;
  const x = (i) => PAD.l + (i / 11) * pw;
  const y = (v) => PAD.t + (1 - v / max) * ph;
  const path = (list) => list.map((v, i) => (v === null ? '' : `${i && list[i - 1] !== null ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`)).join(' ');
  const ticks = [0, max / 2, max];
  // The end labels, apart when the lines end close together
  const nowEnd = now[upTo];
  const thenEnd = then ? then[11] : null;
  let yNow = y(nowEnd);
  let yThen = thenEnd !== null ? y(thenEnd) : null;
  if (yThen !== null && Math.abs(yNow - yThen) < 30) { const mid = (yNow + yThen) / 2; const up = yNow <= yThen; yNow = mid + (up ? -15 : 15); yThen = mid + (up ? 15 : -15); }
  const said = `${title}: ${year} so far ${money(nowEnd)}${then ? `, ${lastYear} by the same month ${money(then[upTo])}, ${lastYear} in all ${money(thenEnd)}` : ''}`;
  // The month being read: its two values (the year so far's own month against last year's same days)
  const read = at >= 0 ? {
    month: at === upTo && through ? `${MONTH[at]} (through ${dayMonth(through)})` : MONTH[at],
    a: now[at], b: then ? (at === upTo && typeof sameDays === 'number' ? sameDays : then[at]) : null,
  } : null;
  const pick = (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    setAt(Math.max(0, Math.min(11, Math.round(((px - PAD.l) / pw) * 11))));
  };
  const keys = (e) => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[e.key];
    if (e.key === 'Escape') { setAt(-1); return; }
    if (!step) return;
    e.preventDefault();
    setAt((i) => Math.max(0, Math.min(11, (i < 0 ? upTo : i) + step)));
  };
  return html`<div class="by-chart" onPointerMove=${pick} onPointerLeave=${() => setAt(-1)}>
    <svg viewBox=${`0 0 ${W} ${H}`} role="img" aria-labelledby=${`${id}-t`} tabindex="0" onKeyDown=${keys} onFocus=${() => setAt(upTo)} onBlur=${() => setAt(-1)}>
      <title id=${`${id}-t`}>${said}</title>
      ${ticks.map((v) => html`<g key=${v}><line class="by-grid" x1=${PAD.l} x2=${W - PAD.r} y1=${y(v)} y2=${y(v)} /><text class="by-axis" x=${PAD.l - 8} y=${y(v) + 4} text-anchor="end">${v ? compact(v) : '$0'}</text></g>`)}
      ${MON.map((mo, i) => html`<text class=${`by-axis ${i === upTo ? 'is-now' : ''}`} key=${mo} x=${x(i)} y=${H - 8} text-anchor="middle">${mo.slice(0, 1)}<tspan class="by-axis__rest">${mo.slice(1)}</tspan></text>`)}
      ${read ? html`<line class="by-guide" x1=${x(at)} x2=${x(at)} y1=${PAD.t} y2=${H - PAD.b} />` : null}
      ${then ? html`<path class="by-line by-line--then" d=${path(then)} />` : null}
      <path class="by-line by-line--now" d=${path(now)} />
      ${then ? html`<circle class="by-dot by-dot--then" cx=${x(11)} cy=${y(thenEnd)} r="4" />` : null}
      <circle class="by-dot by-dot--now" cx=${x(upTo)} cy=${y(nowEnd)} r="4.5" />
      ${read && read.b !== null ? html`<circle class="by-dot by-dot--then" cx=${x(at)} cy=${y(at === upTo && typeof sameDays === 'number' ? sameDays : then[at])} r="4" />` : null}
      ${read && read.a !== null ? html`<circle class="by-dot by-dot--now" cx=${x(at)} cy=${y(read.a)} r="4.5" />` : null}
      <text class="by-end" x=${x(upTo) + 9} y=${yNow + 4}><tspan class="by-end__y">${year}</tspan> ${compact(nowEnd)}</text>
      ${then ? html`<text class="by-end by-end--then" x=${x(11) + 9} y=${yThen + 4}><tspan class="by-end__y">${lastYear}</tspan> ${compact(thenEnd)}</text>` : null}
    </svg>
    ${read ? html`<div class=${`by-tip ${at > 5 ? 'is-left' : ''}`} style=${`--x:${(x(at) / W) * 100}%`} aria-hidden="true">
      <strong>${read.month}</strong>
      ${read.a !== null ? html`<span><i class="by-key by-key--now"></i>${year} ${money(read.a)}</span>` : html`<span class="by-tip__soft">${year}: not yet</span>`}
      ${read.b !== null ? html`<span><i class="by-key by-key--then"></i>${lastYear} ${money(read.b)}${read.a !== null ? html` <b>${changeWords(read.a, read.b)}</b>` : null}</span>` : null}
    </div>` : null}
  </div>`;
}

/**
 * The year so far against last year, month by month: revenue and expenses side by side (two charts, one axis each),
 * a key above them, the numbers as a table under. Null without the months
 */
export function YearCompare({ books, idp = 'by', tall = false }) {
  const s = yearSeries(books);
  if (!s) return null;
  const ly = books.lastYear;
  const through = books.through || '';
  const rows = MON.map((mo, i) => ({ mo, ra: s.revenue.now[i], rb: s.revenue.then?.[i] ?? null, sa: s.spent.now[i], sb: s.spent.then?.[i] ?? null }));
  return html`<section class="by" aria-label=${`${s.year} against ${s.lastYear}, month by month`}>
    <p class="by-legend" aria-hidden="true"><span><i class="by-key by-key--now"></i>${s.year} so far</span>${s.revenue.then ? html`<span><i class="by-key by-key--then"></i>${s.lastYear}</span>` : null}<span class="by-legend__how">Added up month by month, from QuickBooks</span></p>
    <div class="by-charts">
      <figure class="by-fig">
        <figcaption class="by-cap">Revenue</figcaption>
        <${YearLines} id=${`${idp}-rev`} title="Revenue" now=${s.revenue.now} then=${s.revenue.then} year=${s.year} lastYear=${s.lastYear} upTo=${s.upTo} sameDays=${ly?.revenue} through=${through} tall=${tall} />
      </figure>
      <figure class="by-fig">
        <figcaption class="by-cap">Expenses<small>in kind included, as the books have them</small></figcaption>
        <${YearLines} id=${`${idp}-exp`} title="Expenses" now=${s.spent.now} then=${s.spent.then} year=${s.year} lastYear=${s.lastYear} upTo=${s.upTo} sameDays=${ly?.expenses} through=${through} tall=${tall} />
      </figure>
    </div>
    <details class="by-table">
      <summary>The numbers, month by month</summary>
      <div class="by-table__scroll"><table>
        <thead><tr><th scope="col">By the end of</th><th scope="col" class="num">Revenue ${s.year}</th>${s.revenue.then ? html`<th scope="col" class="num">${s.lastYear}</th>` : null}<th scope="col" class="num">Expenses ${s.year}</th>${s.spent.then ? html`<th scope="col" class="num">${s.lastYear}</th>` : null}</tr></thead>
        <tbody>${rows.map((r, i) => html`<tr key=${r.mo} class=${i === s.upTo ? 'is-now' : ''}><th scope="row">${MONTH[i]}${i === s.upTo && through ? html`<small> through ${dayMonth(through)}</small>` : null}</th>
          <td class="num">${r.ra === null ? '–' : money(r.ra)}</td>${s.revenue.then ? html`<td class="num">${money(r.rb)}</td>` : null}
          <td class="num">${r.sa === null ? '–' : money(r.sa)}</td>${s.spent.then ? html`<td class="num">${money(r.sb)}</td>` : null}</tr>`)}</tbody>
      </table></div>
    </details>
  </section>`;
}

/** A statement's main lines (each heading, its total, the sums) or every line, beside the same day a year before */
export function StatementLines({ rows, asOf, priorAsOf, all = false, cls = '' }) {
  if (!rows?.length) return null;
  const prior = rows.some((r) => r.p != null);
  const shown = all ? rows : rows.filter((r) => r.k === 'sum' || (r.k === 'head' && r.d === 0) || (r.k === 'total' && r.d <= 1));
  const cols = prior ? 4 : 2;
  const signed = (v) => (typeof v === 'number' ? (v < 0 ? `(${money(-v)})` : money(v)) : '');
  return html`<table class=${`by-stmt ${cls}`}>
    <thead><tr><th scope="col"><span class="sr-only">Line</span></th><th scope="col" class="num">${shortDate(asOf)}</th>${prior ? html`<th scope="col" class="num">${shortDate(priorAsOf)}</th><th scope="col" class="num">Change</th>` : null}</tr></thead>
    <tbody>${shown.map((r, i) => (r.k === 'head'
      ? html`<tr class="by-stmt__h" key=${i}><th scope="colgroup" colspan=${cols}>${r.label}</th></tr>`
      : html`<tr class=${`by-stmt__${r.k}`} key=${i} style=${`--d:${r.d}`}><th scope="row">${r.label}</th><td class="num">${signed(r.a)}</td>${prior ? html`<td class="num by-stmt__prior">${signed(r.p)}</td><td class="num by-stmt__chg">${changeWords(r.a, r.p) || (typeof r.a === 'number' && typeof r.p === 'number' ? (r.a >= r.p ? '+' : '−') + compact(Math.abs(r.a - r.p)) : '–')}</td>` : null}</tr>`))}</tbody>
  </table>`;
}

/** What a 'books' stop is called (the chair's run of show, the screen's foot) */
export const BOOKS_TITLES = { year: 'The year against last year', store: 'The store', act: 'Statement of activities', pos: 'Statement of financial position' };

/** One of QuickBooks' slides after the money, at the size of a room (the screen is dark: its colors are its own) */
export function BooksSlide({ books, kind }) {
  const s = books?.statements;
  if (kind === 'store') {
    // Its sales on yellow, its cost of goods, the profit before the staff and rent the books keep with SOARD's
    const st = storeOf(books);
    return html`<div class="by-slide by-slide--store">
      <p class="bs-eyebrow">From QuickBooks${books.through ? `, January 1 to ${dayMonth(books.through)}` : ''}</p>
      <h1 class="bs-display by-slide__title">The store, ${st?.lastYear ? `${books.year} against ${st.lastYear}` : `${books.year} so far`}</h1>
      ${st ? html`<ul class="bs-figs" style="--n:3">${st.lines.map((x) => html`<li key=${x.k}>
        <span class="bs-figs__label">${x.name}</span><span class="bs-figs__value">${compact(x.amount)}</span><span class="bs-figs__sub">${storeChange(x) ? `${storeChange(x)} on ${st.lastYear} by now` : `${books.year} so far`}</span>
      </li>`)}</ul>` : null}
    </div>`;
  }
  if (kind === 'year') {
    const ser = yearSeries(books);
    return html`<div class="by-slide">
      <p class="bs-eyebrow">From QuickBooks${books.through ? `, January 1 to ${dayMonth(books.through)}` : ''}</p>
      <h1 class="bs-display by-slide__title">${books.year} against ${books.lastYear?.year || 'last year'}</h1>
      ${ser ? html`<${YearCompare} books=${books} idp="bys" tall />` : html`<${StatementLines} rows=${[
        { k: 'line', d: 0, label: 'Revenue', a: books.revenue, p: books.lastYear?.revenue },
        { k: 'line', d: 0, label: 'Expenses', a: books.expenses, p: books.lastYear?.expenses },
        { k: 'sum', d: 0, label: 'Net', a: books.net, p: books.lastYear?.net },
      ]} asOf=${books.through} priorAsOf=${books.lastYear?.through} cls="is-big" />`}
    </div>`;
  }
  const act = kind === 'act';
  const rows = act ? s?.activity : s?.position;
  return html`<div class="by-slide">
    <p class="bs-eyebrow">From QuickBooks, as of ${dayMonth(s?.asOf)}, beside the same day a year before</p>
    <h1 class="bs-display by-slide__title">${act ? `Statement of activities, January 1 to ${dayMonth(s?.asOf)}` : 'Statement of financial position'}</h1>
    <${StatementLines} rows=${rows} asOf=${s?.asOf} priorAsOf=${s?.priorAsOf} cls="is-big" />
  </div>`;
}
