/**
 * What makeovers cost, on the board page: Home (`home`), the Qualification
 * Committee's agenda item (`agenda`, live: 'costs') and the meeting on the
 * screen (CostsSlide). Travis Couick asked for it (Nov 4 2026): what
 * finished makeovers cost, the cash to fund more, the families waiting and
 * what each will likely cost, and who the money in hand starts.
 *
 *   - For makeovers now: the cash in the bank (the same figure as Home's)
 *     less the operating balance SOARD keeps (Board settings, $500,000 to
 *     begin; a Board admin changes it here)
 *   - A makeover lately: the typical (median) cost of the last two seasons'
 *   - Waiting on the money: each family approved and waiting, best score
 *     first, its rooms' typical cost less what a sponsor pledged, until the
 *     money runs out (../makeover-costs-shared.js planOf)
 *   - Each finished makeover as a dot on its row (what was built), by what
 *     SOARD paid (the bills in JobTread), the row's typical cost marked;
 *     hover, focus or tap a dot for the family; every one in a table too
 *
 * A past meeting shows the numbers it locked (n), its cash as of its day.
 */

import { h, htm, useState, useMemo, useRef, useEffect } from '../vendor.js';
import { money, plural, initialsOf, todayEastern } from '../board-shared.js';
import { rowsOf, recentSeasons, typicalLately, planOf, operatingOf, typeById, statsOf, TYPES } from '../makeover-costs-shared.js';
import { useCashNow, compact } from './money.js';
import { sized } from './kanban.js';

const html = htm.bind(h);
const API = '/api/board-portal';
/** A count, amount or time kept with its word on a narrow screen ("$125,000 under", "in 2026"), as the board page does */
export const nbw = (s) => String(s ?? '').replace(/(\d[KMB%]?) (?=\p{L})/gu, '$1\u00a0').replace(/(\p{L}) (?=\d{4}\b)/gu, '$1\u00a0');
const round = (n) => Math.round(Number(n) || 0);
const dollars = (n) => money(round(n));
const and = (l) => (l.length > 1 ? `${l.slice(0, -1).join(', ')} and ${l.at(-1)}` : l[0] || '');
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const seasonsText = (s) => (s?.length ? and([...s].sort().map(String)) : '');
const hueOf = (s) => [42, 28, 96, 152, 200, 18][[...String(s)].reduce((a, c) => a + c.charCodeAt(0), 0) % 6];
const roomsText = (m) => (m.kind === 'community' ? 'Community project' : m.rooms?.length ? m.rooms.join(' + ') : typeById(m.type).label);
// Each type in a sentence, one and many: "3 therapy rooms"
const WORDS = {
  bathroom: ['accessible bathroom', 'accessible bathrooms'], bedroom: ['dream bedroom', 'dream bedrooms'], therapy: ['therapy room', 'therapy rooms'],
  'bath-bed': ['bathroom and bedroom', 'bathroom and bedroom makeovers'], mixed: ['makeover with another mix of rooms', 'makeovers with other mixes of rooms'], community: ['community project', 'community projects'],
};
/** "the median of 3 therapy rooms in 2025 and 2026" */
function basisText(e) {
  if (!e) return '';
  const [one, many] = WORDS[e.type] || ['finished makeover', 'finished makeovers'];
  const what = e.basis.startsWith('type') ? plural(e.count, one, many) : plural(e.count, 'finished makeover');
  return `the median of ${what}${e.seasons ? ` in ${seasonsText(e.seasons)}` : ''}`;
}

/** The scale under the dots: rounded up to the next $10,000, a line every $10K or $20K */
export function scaleOf(max) {
  const top = Math.max(10000, Math.ceil((max || 0) / 10000) * 10000);
  const step = top > 40000 ? 20000 : 10000;
  const ticks = [];
  for (let v = 0; v <= top; v += step) ticks.push(v);
  if (ticks.at(-1) !== top) ticks.push(top);
  return { top: ticks.at(-1), ticks };
}
/** Dots that would sit on each other share the row in lanes above and below (each one still at its cost) */
export function lanesOf(list, top, gap = 2.6) {
  const order = [0, -1, 1, -2, 2];
  const last = new Map();
  return list.map((m) => {
    const x = (m.cost / top) * 100;
    const lane = order.find((l) => !last.has(l) || x - last.get(l) >= gap) ?? order[(list.indexOf(m)) % order.length];
    last.set(lane, x);
    return { m, x, lane };
  });
}

/**
 * The dots: a row for each kind of makeover, each finished one a dot at what it cost, the row's typical cost a line
 * through it and its middle half a wash. One stop for the keyboard (← → along, ↑ ↓ between rows, Enter opens the
 * kid's page); hover, focus or a tap says the family, the season, the rooms and the cost
 */
export function CostChart({ makeovers, seasons = null, big = false, label = 'What each finished makeover cost' }) {
  // (the seasons by value: the card hands a new list each time it draws)
  const which = seasons ? seasons.join(',') : 'all';
  const rows = useMemo(() => rowsOf(makeovers, seasons), [makeovers, which]);
  const { top, ticks } = useMemo(() => scaleOf(Math.max(0, ...rows.flatMap((r) => r.list.map((m) => m.cost)))), [rows]);
  const placed = useMemo(() => rows.map((r) => ({ ...r, dots: lanesOf(r.list, top, big ? 1.8 : 2.6) })), [rows, top, big]);
  const flat = useMemo(() => placed.flatMap((r, ri) => r.dots.map((d, di) => ({ ...d, ri, di }))), [placed]);
  const [tip, setTip] = useState(-1);
  const [stop, setStop] = useState(0);
  const ref = useRef(null);
  useEffect(() => { setTip(-1); setStop(0); }, [makeovers, which]);
  if (!rows.length) return html`<p class="bc-none">No finished makeover has its bills in JobTread for these seasons.</p>`;
  const at = (i) => Math.max(0, Math.min(flat.length - 1, i));
  const focusDot = (i) => { setStop(i); ref.current?.querySelectorAll('.bc-dot')[i]?.focus(); };
  const onKey = (e) => {
    const cur = flat[stop] || flat[0];
    const near = (ri) => {
      const row = flat.filter((d) => d.ri === ri);
      if (!row.length) return stop;
      const best = row.reduce((a, b) => (Math.abs(b.x - cur.x) < Math.abs(a.x - cur.x) ? b : a));
      return flat.indexOf(best);
    };
    const next = { ArrowRight: at(stop + 1), ArrowLeft: at(stop - 1), ArrowDown: near(Math.min(placed.length - 1, cur.ri + 1)), ArrowUp: near(Math.max(0, cur.ri - 1)), Home: 0, End: flat.length - 1 }[e.key];
    if (next === undefined) return;
    e.preventDefault();
    focusDot(next);
  };
  const t = tip >= 0 ? flat[tip] : null;
  const says = (d) => `${d.m.name}, ${d.m.season}: ${dollars(d.m.cost)}, ${roomsText(d.m)}${d.m.url ? '. Enter opens their page' : ''}`;
  return html`<div class=${`bc-chart ${big ? 'bc-chart--big' : ''}`} role="group" aria-label=${`${label}. Arrow keys move between them`} ref=${ref} onKeyDown=${onKey} onMouseLeave=${() => setTip(-1)}>
    ${placed.map((r, ri) => html`<div class="bc-row" key=${r.id}>
      <div class="bc-row__label"><strong>${big ? r.short : r.label}</strong><span>${nbw(r.count === 1 ? '1 makeover' : `${r.count} · median ${compact(r.typical)}`)}</span></div>
      <div class="bc-row__track" style=${`--n:${Math.max(1, ...r.dots.map((d) => Math.abs(d.lane) * 2 + 1))}`}>
        ${ticks.map((v) => html`<i class="bc-grid" key=${v} style=${`left:${(v / top) * 100}%`} aria-hidden="true"></i>`)}
        ${r.spread ? html`<i class="bc-band" style=${`left:${(r.spread.low / top) * 100}%;width:${((r.spread.high - r.spread.low) / top) * 100}%`} aria-hidden="true"></i>` : null}
        ${r.count > 1 ? html`<i class="bc-typical" style=${`left:${(r.typical / top) * 100}%`} aria-hidden="true"></i>` : null}
        ${r.dots.map((d, di) => {
          const i = flat.findIndex((f) => f.ri === ri && f.di === di);
          return html`<button type="button" class=${`bc-dot ${i === tip ? 'is-tip' : ''}`} key=${d.m.key} style=${`left:${d.x}%;--lane:${d.lane}`}
            tabindex=${i === stop ? 0 : -1} aria-label=${says(d)}
            onMouseEnter=${() => setTip(i)} onFocus=${() => { setTip(i); setStop(i); }} onBlur=${() => setTip(-1)}
            onClick=${() => setTip(i)} onKeyDown=${(e) => { if (e.key === 'Enter' && d.m.url) { e.preventDefault(); open(d.m.url, '_blank', 'noopener'); } }}><i></i></button>`;
        })}
        ${t && t.ri === ri ? html`<div class="bc-tip" style=${`--x:${t.x / 100};--lane:${t.lane}`} aria-hidden="true"><strong>${dollars(t.m.cost)}</strong><span>${t.m.name} · ${t.m.season}</span><span>${roomsText(t.m)}</span></div>` : null}
      </div>
    </div>`)}
    <div class="bc-axis" aria-hidden="true"><span></span><div>${ticks.map((v) => html`<b key=${v} style=${`left:${(v / top) * 100}%`}>${v ? compact(v) : '$0'}</b>`)}</div></div>
  </div>`;
}

/** The family's face: their page's photo, else their initials */
function Face({ f, size = 40 }) {
  return f.photo
    ? html`<img class="bc-face" src=${sized(f.photo, `w=${size * 2},h=${size * 2},fit=cover,gravity=face`)} alt="" width=${size} height=${size} loading="lazy" />`
    : html`<span class="bc-face bc-face--initials" style=${`--hue:${hueOf(f.name)};--s:${size}px`} aria-hidden="true">${initialsOf(f.name)}</span>`;
}

/** A Board admin's: the operating balance, changed where it shows */
function BalanceEdit({ value, onSaved }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(String(value));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const input = useRef(null);
  useEffect(() => { if (open) input.current?.focus(); }, [open]);
  if (!open) return html`<button type="button" class="bc-link" onClick=${() => { setText(String(value)); setErr(''); setOpen(true); }}>Change the ${dollars(value)}</button>`;
  const save = async (e) => {
    e.preventDefault();
    setBusy(true);
    let j = {};
    try { j = await (await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'operating-balance', amount: text }) })).json(); } catch { j = { ok: false, error: 'No connection. Try again.' }; }
    setBusy(false);
    if (!j.ok) { setErr(j.error || 'Not saved'); return; }
    onSaved(j.operatingBalance);
    setOpen(false);
  };
  return html`<form class="bc-balance" onSubmit=${save}>
    <label><span>Kept to run SOARD</span><input ref=${input} class="bc-balance__input" type="text" inputmode="numeric" value=${text} onInput=${(e) => setText(e.target.value)} aria-describedby="bc-balance-why" /></label>
    <button type="submit" class="bp-btn bp-btn--primary bp-btn--sm" disabled=${busy}>${busy ? 'Saving…' : 'Save'}</button>
    <button type="button" class="bp-btn bp-btn--quiet bp-btn--sm" onClick=${() => setOpen(false)}>Cancel</button>
    <p id="bc-balance-why" class="bc-balance__why">What’s over it is what makeovers can use. Each meeting keeps the amount it had.</p>
    ${err ? html`<p class="bc-balance__err" role="alert">${err}</p>` : null}
  </form>`;
}

/** The model: the money, the plan for the families waiting, and the seasons that count as lately */
export function useCosts(data, n, m = null) {
  const upTo = m && m.date < (data.today || todayEastern()) ? m.date : '';
  const cash = useCashNow(data, upTo, n);
  const c = n?.costs || null;
  const operating = operatingOf(n);
  const makeovers = c?.makeovers || [];
  const plan = useMemo(() => (c ? planOf({ cash: cash?.total, operating, makeovers, waiting: c.waiting || [] }) : null), [c, cash?.total, operating]);
  const typical = typicalLately(makeovers);
  const stats = statsOf(typical?.seasons ? makeovers.filter((x) => typical.seasons.includes(Number(x.season))) : makeovers);
  return { c, cash, operating, makeovers, plan, recent: recentSeasons(makeovers), typical, stats };
}

/** The three figures across the top (on the screen, the families waiting a line each in the third) */
function Figures({ cash, operating, plan, typical, waiting, admin, onBalance, screen = false, stats = null }) {
  const free = plan ? plan.free : null;
  const first = plan?.families.find((f) => !f.covered);
  const fams = screen ? (plan?.families || []) : [];
  const shown = fams.length > 3 ? fams.slice(0, 2) : fams;
  return html`<ul class="bc-figs">
    <li class="bc-fig">
      <span class="bc-fig__label">For makeovers now</span>
      <span class="bc-fig__value">${free == null ? '–' : dollars(Math.max(0, free))}</span>
      <span class="bc-fig__sub">${nbw(free == null ? 'The cash in the bank isn’t in yet'
        : free >= 0 ? `Cash in the bank, ${dollars(cash.total)}, less ${dollars(operating)} kept to run SOARD`
        : `Cash in the bank, ${dollars(cash.total)}, is ${dollars(-free)} under the ${dollars(operating)} kept to run SOARD`)}</span>
      ${admin && onBalance ? html`<${BalanceEdit} value=${operating} onSaved=${onBalance} />` : null}
    </li>
    <li class="bc-fig">
      <span class="bc-fig__label">${nbw(typical?.seasons ? `Median makeover, ${seasonsText(typical.seasons)}` : 'Median makeover')}</span>
      <span class="bc-fig__value">${typical ? dollars(typical.cost) : '–'}</span>
      <span class="bc-fig__sub">${nbw(stats ? `Average ${dollars(stats.average)} · low ${dollars(stats.low)} · high ${dollars(stats.high)}, of ${plural(stats.count, 'completed makeover')}` : 'No completed makeover has its bills in JobTread yet')}</span>
    </li>
    <li class="bc-fig">
      <span class="bc-fig__label">Waiting on the money</span>
      <span class="bc-fig__value">${nbw(waiting.length ? plural(waiting.length, 'family', 'families') : 'None')}</span>
      <span class="bc-fig__sub">${nbw(!waiting.length ? 'No family approved is waiting'
        : !plan ? ''
        : !first ? (waiting.length === 1 ? 'Covered by what’s over the operating balance' : 'All covered by what’s over the operating balance')
        // (no finished makeover to go by: what one costs isn't known, so nor is what it needs)
        : plan.need == null ? `${plan.covered ? `${plan.covered} covered; ` : ''}what ${first.name}’s makeover costs isn’t known yet`
        : plan.covered ? `${plan.covered} covered; ${dollars(plan.need)} more starts ${first.name}`
        : `${dollars(plan.need)} more starts ${first.name}`)}</span>
      ${shown.length ? html`<ul class="bc-figfams">${shown.map((f) => html`<li key=${f.key}><span><b>${f.name}</b> ${f.net == null ? 'cost not known yet' : nbw(`about ${dollars(f.net)}`)}</span><span class=${`bc-chip ${f.covered ? 'is-ok' : ''}`}>${f.covered ? 'Covered' : f === first && plan.need != null ? nbw(`Needs ${dollars(plan.need)}`) : f === first ? 'Not known' : 'After that'}</span></li>`)}${fams.length > shown.length ? html`<li key="more"><span>and ${fams.length - shown.length} more</span></li>` : null}</ul>` : null}
    </li>
  </ul>`;
}

/** Who the money starts, best score first: each family's likely cost, less a pledge, and where the money runs out */
function Waiting({ plan, typical, operating, big = false, links = true }) {
  if (!plan) return null;
  const fam = plan.families;
  const after = plan.need == null
    ? plan.more > 0 ? nbw(`That leaves ${dollars(plan.left)}: room for about ${plural(plan.more, 'more makeover')} at the median ${dollars(typical.cost)}.`) : plan.left > 0 && fam.some((f) => f.estimate) ? nbw(`That leaves ${dollars(plan.left)}.`) : ''
    : '';
  if (!fam.length) {
    return html`<p class="bc-lead">${nbw(plan.free > 0 && typical?.cost > 0
      ? `No family approved is waiting on the money. What’s over ${dollars(operating)} would start about ${plural(Math.floor(plan.free / typical.cost), 'makeover')} at the median ${dollars(typical.cost)}.`
      : 'No family approved is waiting on the money.')}</p>`;
  }
  return html`<div class="bc-wait">
    <h3 class="bc-h3">Waiting on the money${fam.length > 1 ? ', best score first' : ''}</h3>
    <ol class="bc-fams">${fam.map((f, i) => {
      const name = links && f.account ? html`<a class="bc-fam__name" href=${`#/families/${encodeURIComponent(f.account)}`}>${f.name}</a>` : html`<span class="bc-fam__name">${f.name}</span>`;
      return html`<li class=${`bc-fam ${f.covered ? 'is-covered' : 'is-short'}`} key=${f.key}>
        <${Face} f=${f} size=${big ? 64 : 44} />
        <div class="bc-fam__who">
          ${name}
          <span>${nbw([roomsText(f), f.score?.ranked ? `Score ${f.score.total}` : f.score ? `${f.score.count} of ${f.score.of} scored` : ''].filter(Boolean).join(' · '))}</span>
        </div>
        <div class="bc-fam__cost">
          <strong>${f.estimate ? nbw(`About ${dollars(f.net)}`) : 'Not known yet'}</strong>
          <span>${nbw(f.estimate ? (f.pledged ? `${dollars(f.estimate.cost)}, less ${dollars(f.pledged)} pledged by ${and(f.sponsors.filter((s) => s.pledged).map((s) => s.name))}; ${basisText(f.estimate)}` : cap(basisText(f.estimate))) : 'No finished makeover with its bills in JobTread to go by yet')}</span>
        </div>
        <span class=${`bc-chip ${f.covered ? 'is-ok' : ''}`}>${f.covered ? 'Covered' : i === fam.findIndex((x) => !x.covered) ? (plan.need == null ? 'Not known yet' : nbw(`Needs ${dollars(plan.need)} more`)) : 'After that'}</span>
      </li>`;
    })}</ol>
    ${after ? html`<p class="bc-lead">${after}</p>` : null}
  </div>`;
}

/** By room (Peter, Nov 4 2026: "by room?"): each kind of makeover's count, average, median, low and high, for the seasons shown */
function ByRoom({ makeovers }) {
  const rows = TYPES.map((t) => ({ t, s: statsOf(makeovers.filter((m) => m.type === t.id)) })).filter((r) => r.s);
  if (!rows.length) return null;
  return html`<div class="bc-byroom">
    <table class="bp-table">
      <caption class="sr-only">What makeovers cost by room</caption>
      <thead><tr><th scope="col">By room</th><th scope="col" class="num">Makeovers</th><th scope="col" class="num">Average</th><th scope="col" class="num">Median</th><th scope="col" class="num">Low</th><th scope="col" class="num">High</th></tr></thead>
      <tbody>${rows.map(({ t, s }) => html`<tr key=${t.id}>
        <th scope="row">${t.label}</th><td class="num" data-label="Makeovers">${s.count}</td><td class="num" data-label="Average">${dollars(s.average)}</td><td class="num" data-label="Median"><b>${dollars(s.median)}</b></td>
        <td class="num" data-label="Low" title=${`${s.lowOf.name}, ${s.lowOf.season}`}>${dollars(s.low)}</td><td class="num" data-label="High" title=${`${s.highOf.name}, ${s.highOf.season}`}>${dollars(s.high)}</td>
      </tr>`)}</tbody>
    </table>
  </div>`;
}

/** Every finished makeover in a table: the chart's dots, readable without hovering */
function Table({ makeovers }) {
  const [by, setBy] = useState('season');
  const list = useMemo(() => [...makeovers].sort(by === 'cost' ? (a, b) => b.cost - a.cost : (a, b) => b.season - a.season || b.cost - a.cost), [makeovers, by]);
  const sortBtn = (k, label) => html`<button type="button" class="bc-sort" aria-pressed=${by === k} onClick=${() => setBy(k)}>${label}</button>`;
  return html`<details class="bp-more bc-table">
    <summary>${nbw(`Every finished makeover (${makeovers.length})`)}</summary>
    <p class="bc-sorts">Sort by ${sortBtn('season', 'season')} ${sortBtn('cost', 'cost')}</p>
    <table class="bp-table">
      <thead><tr><th scope="col">Makeover</th><th scope="col">Season</th><th scope="col">What was built</th><th scope="col" class="num">Paid</th></tr></thead>
      <tbody>${list.map((m) => html`<tr key=${m.key}>
        <th scope="row">${m.url ? html`<a class="bp-link" href=${m.url} target="_blank" rel="noopener">${m.name}</a>` : m.name}</th>
        <td>${m.season}</td><td>${roomsText(m)}</td><td class="num">${dollars(m.cost)}</td>
      </tr>`)}</tbody>
    </table>
  </details>`;
}

/**
 * The card: on Home (`home`) and in a meeting's agenda (`agenda`, its numbers locked on its day). `admin` (a Board
 * admin, not looking as the board) may change the operating balance; `onBalance(amount)` puts the new one in place
 */
export function CostsCard({ data, n, m = null, variant = 'home', admin = false, onBalance = null }) {
  const { c, cash, operating, makeovers, plan, recent, typical, stats } = useCosts(data, n, m);
  const [range, setRange] = useState('recent');
  if (!c) return variant === 'home' ? null : html`<p class="bp-muted">What makeovers cost isn’t available from JobTread right now.</p>`;
  const seasons = range === 'recent' ? recent : null;
  const first = Math.min(...makeovers.map((x) => Number(x.season) || 9999));
  const noBills = (c.noBills || []).filter((x) => !seasons || seasons.includes(Number(x.season)));
  const shownStats = statsOf(seasons ? makeovers.filter((x) => seasons.includes(Number(x.season))) : makeovers);
  const body = html`
    <${Figures} cash=${cash} operating=${operating} plan=${plan} typical=${typical} stats=${stats} waiting=${plan?.families || c.waiting || []} admin=${admin} onBalance=${onBalance} />
    <${Waiting} plan=${plan} typical=${typical} operating=${operating} />
    <div class="bc-what">
      <div class="bc-what__head">
        <h3 class="bc-h3">Each finished makeover, by what was built</h3>
        <div class="bc-seg" role="group" aria-label="Which seasons">
          <button type="button" aria-pressed=${range === 'recent'} onClick=${() => setRange('recent')}>${nbw(seasonsText(recent))}</button>
          <button type="button" aria-pressed=${range === 'all'} onClick=${() => setRange('all')}>${nbw(`Every year${Number.isFinite(first) && first < 9999 ? ` since ${first}` : ''}`)}</button>
        </div>
      </div>
      ${shownStats ? html`<p class="bc-stats">${nbw(`${plural(shownStats.count, 'completed makeover')}: average ${dollars(shownStats.average)}, median ${dollars(shownStats.median)}, low ${dollars(shownStats.low)} (${shownStats.lowOf.name}, ${shownStats.lowOf.season}), high ${dollars(shownStats.high)} (${shownStats.highOf.name}, ${shownStats.highOf.season})`)}</p>` : null}
      <${CostChart} makeovers=${makeovers} seasons=${seasons} />
      <p class="bc-note">${nbw(`Each dot is one makeover, at what SOARD paid: its bills in JobTread. Donated work and materials aren’t in it. The line is the median; the shaded part, the middle half.${noBills.length ? ` Not counted: ${and(noBills.map((x) => x.name))} (${seasonsText([...new Set(noBills.map((x) => x.season))])}), with no bills in JobTread.` : ''}`)}</p>
      <${ByRoom} makeovers=${seasons ? makeovers.filter((x) => seasons.includes(Number(x.season))) : makeovers} />
      <${Table} makeovers=${seasons ? makeovers.filter((x) => seasons.includes(Number(x.season))) : makeovers} />
    </div>
    ${variant === 'home' ? html`<p class="bc-families"><a class="bp-cardhead__go" href="#/families">Every family’s application and score <span aria-hidden="true">→</span></a></p>` : null}`;
  if (variant !== 'home') return html`<div class="bc bc--agenda">${body}</div>`;
  return html`<section class="bp-card bc" aria-labelledby="costs-h" id="costs">
    <div class="bp-cardhead"><h2 class="bp-h2" id="costs-h">What makeovers cost</h2><span class="bp-muted">From JobTread and the bank</span></div>
    ${body}
  </section>`;
}

/** The meeting on the screen: the three figures, who the money starts, and the dots, at the size of a room */
export function CostsSlide({ n, data, date }) {
  const m = date ? { date } : null;
  const { c, cash, operating, makeovers, plan, recent, typical, stats } = useCosts(data, n, m);
  if (!c) return null;
  return html`<div class="bc bc--screen">
    <${Figures} cash=${cash} operating=${operating} plan=${plan} typical=${typical} stats=${stats} waiting=${plan?.families || c.waiting || []} screen=${true} />
    <div class="bc-what"><h3 class="bc-h3">${nbw(`Finished makeovers, ${seasonsText(recent)}`)}</h3><${CostChart} makeovers=${makeovers} seasons=${recent} big=${true} /></div>
  </div>`;
}

export { TYPES };
