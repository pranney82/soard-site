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
import { compact, storeOf, storeChange, budgetMonthsText, spentOf } from './money.js';
import { lineKeysOf, notesByKey, NoteLine } from './review.js';

const html = htm.bind(h);
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const MONTH = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const dayMonth = (d) => (d ? new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' }) : '');

/** A budget's over (under), in dollars: "+$217K", "−$12K", "Even" */
const overWords = (a, b) => (typeof a === 'number' && typeof b === 'number' ? (Math.round(a) === Math.round(b) ? 'Even' : `${a > b ? '+' : '−'}${compact(Math.abs(a - b))}`) : '–');
/** "▲ 25%" against last year ('Even', or '' with nothing to set it beside) */
export const changeWords = (a, p) => {
  if (!(typeof a === 'number' && typeof p === 'number' && p > 0)) return '';
  const c = Math.round(((a - p) / p) * 100);
  return c === 0 ? 'Even' : `${c > 0 ? '▲' : '▼'} ${Math.abs(c)}%`;
};

/**
 * Month by month, each added to the months before it: this year through the month it's in, last year all twelve.
 * Expenses leave out what never left the bank (in kind, depreciation) once the read has it by month, as the board's
 * figures do (`cash`); an older read has it in.
 * → { year, lastYear, upTo, cash, revenue: { now, then }, spent: { now, then } } (arrays of 12, this year null after
 * upTo), or null without the months (an older read, a locked meeting's numbers from before they were kept)
 */
export function yearSeries(books) {
  const mo = books?.monthly;
  if (!mo?.months?.length) return null;
  const at = (m) => Number(String(m || '').slice(5, 7)) - 1;
  const upTo = Math.max(...mo.months.map((x) => at(x.month)).filter((i) => i >= 0 && i < 12));
  const cash = [...mo.months, ...(mo.last || [])].every((x) => typeof x.nonCash === 'number');
  const run = (list, value, last) => {
    const by = Array(12).fill(0);
    for (const x of list || []) { const i = at(x.month); if (i >= 0 && i < 12) by[i] += value(x); }
    let t = 0;
    return by.map((v, i) => { t += v; return i <= last ? Math.round(t) : null; });
  };
  const rev = (x) => Number(x.revenue) || 0;
  const out = (x) => (Number(x.spent) || 0) - (cash ? Number(x.nonCash) || 0 : 0);
  const has = (mo.last || []).length > 0;
  return {
    year: mo.year || books.year || '', lastYear: mo.lastYear || books.lastYear?.year || '', upTo, cash,
    revenue: { now: run(mo.months, rev, upTo), then: has ? run(mo.last, rev, 11) : null },
    spent: { now: run(mo.months, out, upTo), then: has ? run(mo.last, out, 11) : null },
  };
}

/** A round end for the axis: 1, 2, 2.5 or 5 times a power of ten, at or past `v` (over 0) */
function niceMax(v) {
  const p = 10 ** Math.floor(Math.log10(v));
  return [1, 2, 2.5, 5, 10].map((k) => k * p).find((x) => x >= v * 1.04) || 10 * p;
}
/** The axis: round ends past the highest and the lowest, $0 always on it; one mark, $0, for a year of nothing */
function axisOf(values) {
  const hi = Math.max(0, ...values);
  const lo = Math.min(0, ...values);
  const top = hi > 0 ? niceMax(hi) : 0;
  const bottom = lo < 0 ? -niceMax(-lo) : 0;
  if (top === bottom) return { top: 1, bottom: 0, ticks: [0] };
  return { top, bottom, ticks: bottom < 0 ? (top > 0 ? [bottom, 0, top] : [bottom, bottom / 2, 0]) : [0, top / 2, top] };
}
/** Dollars with a real minus: "−$250,000" */
const sm = (v) => (typeof v !== 'number' ? '–' : v < 0 ? `−${money(-v)}` : money(v));

const W = 640;
const BASE_H = 250;
const PAD = { l: 52, r: 92, t: 14, b: 30 };
/**
 * One measure, this year against last, added up month by month. This year's last point is the year so far: last year
 * beside it is its same days (`sameDays`, through `through`), as the figures above say, and its line goes on to the
 * month's end
 */
function YearLines({ id, title, now, then, year, lastYear, upTo, sameDays = null, through = '', tall = false }) {
  const [at, setAt] = useState(-1);
  // Taller on the screen, where there's the room (the same width, so the words stay their size)
  const H = tall ? 340 : BASE_H;
  const ax = axisOf([...now.filter((v) => v !== null), ...(then || [])]);
  const pw = W - PAD.l - PAD.r;
  const ph = H - PAD.t - PAD.b;
  const x = (i) => PAD.l + (i / 11) * pw;
  const y = (v) => PAD.t + ((ax.top - v) / (ax.top - ax.bottom)) * ph;
  const path = (list) => list.map((v, i) => (v === null ? '' : `${i && list[i - 1] !== null ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`)).join(' ');
  // The end labels, apart when the lines end close together
  const nowEnd = now[upTo];
  const thenEnd = then ? then[11] : null;
  let yNow = y(nowEnd);
  let yThen = thenEnd !== null ? y(thenEnd) : null;
  if (yThen !== null && Math.abs(yNow - yThen) < 30) { const mid = (yNow + yThen) / 2; const up = yNow <= yThen; yNow = mid + (up ? -15 : 15); yThen = mid + (up ? 15 : -15); }
  // Last year by this year's own day (the figures' "by now"), when the read has it
  const same = then && typeof sameDays === 'number' && through ? sameDays : null;
  const said = `${title}: ${year} so far ${sm(nowEnd)}${then ? `, ${lastYear} ${same !== null ? `by ${dayMonth(through)} ${sm(same)}` : `by the end of ${MONTH[upTo]} ${sm(then[upTo])}`}, ${lastYear} in all ${sm(thenEnd)}` : ''}`;
  // The month being read: this year's against last year's by the same point. The year so far's own month sets it
  // beside last year's same days, then says last year's whole month too (the point on its line)
  const cur = at === upTo && same !== null;
  const read = at >= 0 ? {
    month: at === upTo && through ? `${MONTH[at]} (through ${dayMonth(through)})` : MONTH[at],
    a: now[at], b: then ? (cur ? same : then[at]) : null, whole: cur ? then[at] : null,
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
  // The note beside the month read, on whichever side has the room, never past the chart's edges (a phone's July)
  const place = (el) => {
    if (!el || at < 0) return;
    const box = el.parentElement.clientWidth;
    const w = el.offsetWidth;
    const px = (x(at) / W) * box;
    const right = px + 14;
    const left = px - 14 - w;
    el.style.left = `${Math.max(0, Math.min(box - w, right + w <= box || box - px > px ? right : left))}px`;
  };
  return html`<div class="by-chart" onPointerMove=${pick} onPointerLeave=${() => setAt(-1)}>
    <svg viewBox=${`0 0 ${W} ${H}`} role="img" aria-labelledby=${`${id}-t`} tabindex="0" onKeyDown=${keys} onFocus=${() => setAt(upTo)} onBlur=${() => setAt(-1)}>
      <title id=${`${id}-t`}>${said}</title>
      ${ax.ticks.map((v) => html`<g key=${v}><line class=${`by-grid ${v === 0 && ax.bottom < 0 ? 'is-zero' : ''}`} x1=${PAD.l} x2=${W - PAD.r} y1=${y(v)} y2=${y(v)} /><text class="by-axis" x=${PAD.l - 8} y=${y(v) + 4} text-anchor="end">${v ? compact(v) : '$0'}</text></g>`)}
      ${MON.map((mo, i) => html`<text class=${`by-axis ${i === upTo ? 'is-now' : ''}`} key=${mo} x=${x(i)} y=${H - 8} text-anchor="middle">${mo.slice(0, 1)}<tspan class="by-axis__rest">${mo.slice(1)}</tspan></text>`)}
      ${read ? html`<line class="by-guide" x1=${x(at)} x2=${x(at)} y1=${PAD.t} y2=${H - PAD.b} />` : null}
      ${then ? html`<path class="by-line by-line--then" d=${path(then)} />` : null}
      <path class="by-line by-line--now" d=${path(now)} />
      ${then ? html`<circle class="by-dot by-dot--then" cx=${x(11)} cy=${y(thenEnd)} r="4" />` : null}
      <circle class="by-dot by-dot--now" cx=${x(upTo)} cy=${y(nowEnd)} r="4.5" />
      ${read && then ? html`<circle class="by-dot by-dot--then" cx=${x(at)} cy=${y(then[at])} r="4" />` : null}
      ${read && read.a !== null ? html`<circle class="by-dot by-dot--now" cx=${x(at)} cy=${y(read.a)} r="4.5" />` : null}
      <text class="by-end" x=${x(upTo) + 9} y=${yNow + 4}><tspan class="by-end__y">${year}</tspan> ${compact(nowEnd)}</text>
      ${then ? html`<text class="by-end by-end--then" x=${x(11) + 9} y=${yThen + 4}><tspan class="by-end__y">${lastYear}</tspan> ${compact(thenEnd)}</text>` : null}
    </svg>
    ${read ? html`<div class="by-tip" ref=${place} aria-hidden="true">
      <strong>${read.month}</strong>
      ${read.a !== null ? html`<span><i class="by-key by-key--now"></i>${year} ${sm(read.a)}</span>` : html`<span class="by-tip__soft">${year}: not yet</span>`}
      ${read.b !== null ? html`<span><i class="by-key by-key--then"></i>${lastYear}${cur ? ` by ${dayMonth(through)}` : ''} ${sm(read.b)}${read.a !== null ? html` <b>${changeWords(read.a, read.b)}</b>` : null}</span>` : null}
      ${read.whole !== null ? html`<span class="by-tip__soft">${lastYear}, all of ${MONTH[at]}: ${sm(read.whole)}</span>` : null}
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
  // Last year by this year's own day, as the figures have it (its expenses without in kind once the months leave it out)
  const sameRev = typeof ly?.revenue === 'number' ? ly.revenue : null;
  const sameExp = typeof ly?.expenses !== 'number' ? null : !s.cash ? ly.expenses : typeof ly.nonCash === 'number' ? ly.expenses - ly.nonCash : null;
  const lastAt = (series, same, i) => (i === s.upTo && typeof same === 'number' && through ? same : series?.[i] ?? null);
  const monthEnd = (i) => `${MONTH[i]} ${new Date(Date.UTC(Number(s.lastYear) || 2001, i + 1, 0)).getUTCDate()}`;
  const lastCell = (series, same, i) => {
    const v = lastAt(series, same, i);
    const whole = series?.[i] ?? null;
    return html`<td class="num">${sm(v)}${v !== whole && whole !== null ? html`<small class="by-table__whole">${sm(whole)} by ${monthEnd(i)}</small>` : null}</td>`;
  };
  return html`<section class="by" aria-label=${`${s.year} against ${s.lastYear}, month by month`}>
    <p class="by-legend" aria-hidden="true"><span><i class="by-key by-key--now"></i>${s.year} so far</span>${s.revenue.then ? html`<span><i class="by-key by-key--then"></i>${s.lastYear}</span>` : null}<span class="by-legend__how">Added up month by month, from QuickBooks</span></p>
    <div class="by-charts">
      <figure class="by-fig">
        <figcaption class="by-cap">Revenue</figcaption>
        <${YearLines} id=${`${idp}-rev`} title="Revenue" now=${s.revenue.now} then=${s.revenue.then} year=${s.year} lastYear=${s.lastYear} upTo=${s.upTo} sameDays=${sameRev} through=${through} tall=${tall} />
      </figure>
      <figure class="by-fig">
        <figcaption class="by-cap">Expenses<small>${s.cash ? 'in kind and depreciation left out' : 'in kind included, as the books have them'}</small></figcaption>
        <${YearLines} id=${`${idp}-exp`} title="Expenses" now=${s.spent.now} then=${s.spent.then} year=${s.year} lastYear=${s.lastYear} upTo=${s.upTo} sameDays=${sameExp} through=${through} tall=${tall} />
      </figure>
    </div>
    <details class="by-table">
      <summary>The numbers, month by month</summary>
      <div class="by-table__scroll"><table>
        <thead><tr><th scope="col">By the end of</th><th scope="col" class="num">Revenue ${s.year}</th>${s.revenue.then ? html`<th scope="col" class="num">${s.lastYear}</th>` : null}<th scope="col" class="num">Expenses ${s.year}</th>${s.spent.then ? html`<th scope="col" class="num">${s.lastYear}</th>` : null}</tr></thead>
        <tbody>${MON.map((mo, i) => html`<tr key=${mo} class=${i === s.upTo ? 'is-now' : ''}><th scope="row">${MONTH[i]}${i === s.upTo && through ? html`<small> through ${dayMonth(through)}</small>` : null}</th>
          <td class="num">${s.revenue.now[i] === null ? '–' : sm(s.revenue.now[i])}</td>${s.revenue.then ? lastCell(s.revenue.then, sameRev, i) : null}
          <td class="num">${s.spent.now[i] === null ? '–' : sm(s.spent.now[i])}</td>${s.spent.then ? lastCell(s.spent.then, sameExp, i) : null}</tr>`)}</tbody>
      </table></div>
    </details>
  </section>`;
}

/** A statement's main lines (each heading, its total, the sums) or every line, beside the same day a year before */
export function StatementLines({ rows, asOf, priorAsOf, all = false, cls = '', heads = null, which = '', notes = null }) {
  if (!rows?.length) return null;
  const prior = rows.some((r) => r.p != null);
  // The presenter's notes (./review.js, which: 'act' | 'pos'), each under its line; a line with one is a main line too
  const said = notesByKey(notes);
  const keys = which && said.size ? lineKeysOf(rows, which) : [];
  const noteOf = (r) => (keys.length ? said.get(keys[rows.indexOf(r)]) : null);
  const shown = all ? rows : rows.filter((r) => r.k === 'sum' || (r.k === 'head' && r.d === 0) || (r.k === 'total' && r.d <= 1) || noteOf(r));
  const cols = prior ? 4 : 2;
  const signed = (v) => (typeof v === 'number' ? (v < 0 ? `(${money(-v)})` : money(v)) : '');
  return html`<table class=${`by-stmt ${cls}`}>
    <thead><tr><th scope="col"><span class="sr-only">Line</span></th><th scope="col" class="num">${heads ? heads[0] : shortDate(asOf)}</th>${prior ? html`<th scope="col" class="num">${heads ? heads[1] : shortDate(priorAsOf)}</th><th scope="col" class="num">${heads ? heads[2] : 'Change'}</th>` : null}</tr></thead>
    <tbody>${shown.map((r, i) => (r.k === 'head'
      ? html`<tr class="by-stmt__h" key=${i}><th scope="colgroup" colspan=${cols}>${r.label}</th></tr>`
      : [html`<tr class=${`by-stmt__${r.k}`} key=${i} style=${`--d:${r.d}`}><th scope="row">${r.label}</th><td class="num">${signed(r.a)}</td>${prior ? html`<td class="num by-stmt__prior">${signed(r.p)}</td><td class="num by-stmt__chg">${heads ? overWords(r.a, r.p) : changeWords(r.a, r.p) || (typeof r.a === 'number' && typeof r.p === 'number' ? (r.a >= r.p ? '+' : '−') + compact(Math.abs(r.a - r.p)) : '–')}</td>` : null}</tr>`,
        noteOf(r) ? html`<tr class="by-stmt__note" key=${`${i}-n`} style=${`--d:${r.d}`}><td colspan=${cols}><${NoteLine} note=${noteOf(r)} /></td></tr>` : null]))}</tbody>
  </table>`;
}

/** What a 'books' stop is called (the chair's run of show, the screen's foot) */
export const BOOKS_TITLES = { year: 'The year against last year', store: 'The store', act: 'Statement of activities', budget: 'Budget against actual', pos: 'Statement of financial position' };

/** One of QuickBooks' slides after the money, at the size of a room (the screen is dark: its colors are its own) */
export function BooksSlide({ books, kind, notes = null }) {
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
    // Without the months (a read from before them): the year so far against last year's same days, as the figures
    // have them (the expenses without in kind)
    const ser = yearSeries(books);
    return html`<div class="by-slide">
      <p class="bs-eyebrow">From QuickBooks${books.through ? `, January 1 to ${dayMonth(books.through)}` : ''}</p>
      <h1 class="bs-display by-slide__title">${books.year} against ${books.lastYear?.year || 'last year'}</h1>
      ${ser ? html`<${YearCompare} books=${books} idp="bys" tall />` : html`<${StatementLines} all rows=${[
        { k: 'line', d: 0, label: 'Revenue', a: books.revenue, p: books.lastYear?.revenue },
        { k: 'line', d: 0, label: 'Expenses', a: spentOf(books), p: books.lastYear ? spentOf(books.lastYear) : null },
      ]} asOf=${books.through} priorAsOf=${books.lastYear?.through} cls="is-big" />`}
    </div>`;
  }
  if (kind === 'budget') {
    // QuickBooks' budget (the board's) against the actuals, to the statements' day: the main lines, over (under) beside each
    const b = books?.budget;
    return html`<div class="by-slide">
      <p class="bs-eyebrow">QuickBooks’ budget, ${b?.name}, through ${dayMonth(b?.asOf)}${b ? `: ${budgetMonthsText(b.months)} of ${b.of} months` : ''}</p>
      <h1 class="bs-display by-slide__title">Budget against actual, January 1 to ${dayMonth(b?.asOf)}</h1>
      <${StatementLines} rows=${(b?.rows || []).map((r) => ({ ...r, p: r.b }))} heads=${['Actual', 'Budget', 'Over (under)']} cls="is-big" which="bud" notes=${notes} />
    </div>`;
  }
  const act = kind === 'act';
  const rows = act ? s?.activity : s?.position;
  return html`<div class="by-slide">
    <p class="bs-eyebrow">From QuickBooks, as of ${dayMonth(s?.asOf)}, beside the same day a year before</p>
    <h1 class="bs-display by-slide__title">${act ? `Statement of activities, January 1 to ${dayMonth(s?.asOf)}` : 'Statement of financial position'}</h1>
    <${StatementLines} rows=${rows} asOf=${s?.asOf} priorAsOf=${s?.priorAsOf} cls="is-big" which=${act ? 'act' : 'pos'} notes=${notes} />
  </div>`;
}
