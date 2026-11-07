/**
 * What makeovers cost, on the board page: Financials (`home`, moved from Home
 * Nov 6 2026 to make room for the applications), the Qualification
 * Committee's agenda item (`agenda`, live: 'costs') and the meeting on the
 * screen (CostsSlide). Travis Couick asked for it (Nov 4 2026): what
 * completed makeovers cost, the cash to fund more, the families waiting and
 * what each will likely cost, and who the money in hand starts.
 *
 * The answer first, then what it rests on:
 *   - For makeovers now: the cash in the bank (the same figure as Home's and Financials')
 *     less the operating balance SOARD keeps (Board settings, $500,000 to
 *     begin; a Board admin changes it here), and in one sentence who and
 *     how many makeovers it starts (../makeover-costs-shared.js planOf)
 *   - Waiting on the money: each family approved and waiting, best score
 *     first, its rooms' median cost less what a sponsor pledged; beside it
 *     the median makeover of the last two seasons, with its average, low and high
 *   - Each completed makeover as a dot on its room's row, at what SOARD paid
 *     (the bills in JobTread), the row's median marked and its numbers at
 *     its end (how many, median, average, low to high); hover, focus or tap
 *     a dot for the family; every one in a table too
 * Peter's word is "completed"; and "median", never "typical" ("what is a typical makeover?").
 *
 * A past meeting shows the numbers it locked (n), its cash as of its day.
 */

import { h, htm, useState, useMemo, useRef, useEffect } from '../vendor.js';
import { money, plural, initialsOf, todayEastern } from '../board-shared.js';
import { rowsOf, recentSeasons, typicalLately, planOf, pipelineOf, operatingOf, typeById, statsOf, TYPES } from '../makeover-costs-shared.js';
import { useCashNow, compact } from './money.js';
import { sized } from './kanban.js';

const html = htm.bind(h);
const API = '/api/board-portal';
/** A count, amount or time kept with its word on a narrow screen ("$125,000 under", "in 2026"), as the board page does */
export const nbw = (s) => String(s ?? '').replace(/(\d[KMB%]?) (?=\p{L})/gu, '$1 ').replace(/(\p{L}) (?=\d{4}\b)/gu, '$1 ');
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
  'bath-bed': ['bathroom and bedroom', 'bathroom and bedroom makeovers'], mixed: ['makeover', 'makeovers with other mixes of rooms'], community: ['community project', 'community projects'],
};
/** "the median of 3 therapy rooms in 2025 and 2026" */
function basisText(e) {
  if (!e) return '';
  const [, many] = WORDS[e.type] || ['', 'completed makeovers'];
  const what = e.basis.startsWith('type') ? plural(e.count, WORDS[e.type]?.[0] || 'makeover', many) : plural(e.count, 'completed makeover');
  return `the median of ${what}${e.seasons ? ` in ${seasonsText(e.seasons)}` : ''}`;
}
/** "Ava’s therapy room, about $18,000" */
const famWords = (f) => `${f.name}’s ${f.kind === 'community' ? 'project' : WORDS[f.type]?.[0] || 'makeover'}${f.net != null ? `, about ${dollars(f.net)}` : ''}`;

/**
 * The answer, in a sentence: who and how many makeovers what's over the operating balance starts.
 * (plan: ../makeover-costs-shared.js planOf; typical: the median makeover lately)
 */
export function answerText(plan, typical) {
  if (!plan) return '';
  const fam = plan.families;
  const median = typical?.cost > 0 ? typical.cost : null;
  const covered = fam.filter((f) => f.covered);
  const first = fam.find((f) => !f.covered);
  const jobs = plan.jobs?.length || 0;
  if (plan.free < 0) {
    // (never the shortfall added to a family's cost: what's underway is short, the family costs what it costs. Peter,
    // Nov 4 2026, of a family's $18K therapy room shown as needing $77K: "why the hell…")
    const then = fam.length ? ` ${cap(famWords(fam[0]))}, comes next${fam.length > 1 ? `, then ${plural(fam.length - 1, 'more family', 'more families')}` : ''}.` : '';
    if (plan.over < 0) return `Cash in the bank is ${dollars(-plan.over)} under the ${dollars(plan.operating)} kept to run SOARD, so nothing is free for new makeovers.${then}`;
    return `Finishing the ${plural(jobs, 'makeover')} underway takes about ${dollars(plan.committed)} more, ${dollars(plan.short)} more than the ${dollars(plan.over)} over the ${dollars(plan.operating)} kept to run SOARD, so nothing is free for new makeovers yet.${then}`;
  }
  if (!fam.length) {
    const n = median ? Math.floor(plan.free / median) : 0;
    return `${median ? `Enough for about ${plural(n, 'makeover')} at the median cost, ${dollars(median)}. ` : ''}No family approved is waiting on the money.`;
  }
  if (first && plan.need == null) return `What ${first.name}’s makeover will cost isn’t known yet: no completed makeover with its bills in JobTread to go by.`;
  const together = dollars(covered.reduce((s, f) => s + f.net, 0));
  const coveredText = covered.length === 1 ? famWords(covered[0])
    : covered.length === 2 ? `${covered[0].name} and ${covered[1].name}, about ${together} together`
    : `${covered.length === fam.length ? `all ${covered.length}` : `the first ${covered.length}`} families waiting, about ${together} together`;
  if (first) {
    return covered.length
      ? `Enough for ${coveredText}. ${first.name} needs ${dollars(plan.need)} more.`
      : `Not enough yet for ${famWords(first)}: it needs ${dollars(plan.need)} more.`;
  }
  return plan.more > 0 && median
    ? `Enough for ${coveredText}, then about ${plural(plan.more, 'more makeover')} at the median cost, ${dollars(median)}.`
    : `Enough for ${coveredText}, with ${dollars(plan.left)} left.`;
}

const dayName = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });
/** Who's already in line for next season, by name: "Ava, Ben and 2 community projects" */
function carryText(carry, jobs = [], families = []) {
  const kinds = new Map([...jobs, ...families].map((x) => [x.name, x.kind]));
  const kids = carry.filter((c) => kinds.get(c.name) !== 'community').map((c) => c.name);
  const orgs = carry.filter((c) => kinds.get(c.name) === 'community').map((c) => c.name);
  return and([...kids, ...(orgs.length > 1 ? [plural(orgs.length, 'community project')] : orgs)]);
}
/**
 * The recommended pipeline, in a sentence: how many SOARD builds a year, who's already in line, and the room left
 * (Peter, Nov 4 2026: "recommended pipeline is related to how many we can actually produce since we will get all
 * projects funded as we build our cash reserves")
 */
export function pipelineText(pipe, plan) {
  if (!pipe) return '';
  const pace = pipe.planned
    ? `Applicants plans ${pipe.planned} makeovers for ${pipe.next}.`
    : `SOARD builds about ${pipe.pace} makeovers a year: ${pipe.done} revealed in ${pipe.year} so far${pipe.scheduled ? ` and ${pipe.scheduled} more set by ${dayName(pipe.lastDay)}` : ''}.`;
  // This season's makeovers still underway or waiting are this season's, not next's
  const ours = (plan?.jobs?.length || 0) + (plan?.families?.length || 0) - pipe.carry.length;
  const inLine = pipe.carry.length
    ? ` ${carryText(pipe.carry, plan?.jobs, plan?.families)} ${pipe.carry.length === 1 ? 'is' : 'are'} already in line for ${pipe.next}, so`
    : ours > 0 ? ` The ${plural(ours, 'makeover')} underway or waiting ${ours === 1 ? 'is' : 'are'} ${pipe.year}’s, so` : ' So';
  return `${pace}${inLine} there’s room for about ${plural(pipe.room, 'new family', 'new families')}. Funding follows as the reserve builds.`;
}

/** The answer for the meeting's screen: the same, in a line the room reads at a glance */
export function screenText(plan, typical) {
  if (!plan) return '';
  const first = plan.families.find((f) => !f.covered);
  if (plan.free < 0) {
    const why = plan.over < 0 ? `Under the ${dollars(plan.operating)} kept to run SOARD.` : 'Finishing what’s underway takes it all.';
    return `${why}${first ? ` ${cap(famWords(first))}, comes next.` : ''}`;
  }
  return answerText(plan, typical);
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
/**
 * Dots that would touch share the row in lanes just above and below (each one still at its cost). `gap`: how close,
 * as a share of the row's width, two dots can sit on one line (a dot's width and its ring, measured on the page)
 */
export function lanesOf(list, top, gap = 1.6) {
  const order = [0, -1, 1, -2, 2];
  const last = new Map();
  return list.map((m, i) => {
    const x = (m.cost / top) * 100;
    const lane = order.find((l) => !last.has(l) || x - last.get(l) >= gap) ?? order[i % order.length];
    last.set(lane, x);
    return { m, x, lane };
  });
}

/**
 * The dots: a row for each kind of makeover, each completed one a dot at what it cost, the row's median a line
 * through it and its middle half a wash, its numbers at the end (how many, median, average, low to high). One stop
 * for the keyboard (← → along, ↑ ↓ between rows, Enter opens the kid's page); hover, focus or a tap says the
 * family, the season, the rooms and the cost
 */
export function CostChart({ makeovers, seasons = null, big = false, label = 'What each completed makeover cost' }) {
  // (the seasons by value: the card hands a new list each time it draws)
  const which = seasons ? seasons.join(',') : 'all';
  const rows = useMemo(() => rowsOf(makeovers, seasons), [makeovers, which]);
  const { top, ticks } = useMemo(() => scaleOf(Math.max(0, ...rows.flatMap((r) => r.list.map((m) => m.cost)))), [rows]);
  // How wide a row is, so only dots that would really touch move off the line
  const ref = useRef(null);
  const [width, setWidth] = useState(800);
  useEffect(() => {
    const track = ref.current?.querySelector('.bc-row__track');
    if (!track || typeof ResizeObserver !== 'function') return undefined;
    const ro = new ResizeObserver(([e]) => { const w = Math.round(e.contentRect.width); if (w > 0) setWidth(w); });
    ro.observe(track);
    return () => ro.disconnect();
  }, [rows.length]);
  const touch = big ? 1.9 : 1.15; // a dot and its ring, in rem-ish units of the page
  const placed = useMemo(() => rows.map((r) => ({ ...r, dots: lanesOf(r.list, top, ((touch * 16) / width) * 100) })), [rows, top, width, touch]);
  const flat = useMemo(() => placed.flatMap((r, ri) => r.dots.map((d, di) => ({ ...d, ri, di }))), [placed]);
  const [tip, setTip] = useState(-1);
  const [stop, setStop] = useState(0);
  useEffect(() => { setTip(-1); setStop(0); }, [makeovers, which]);
  if (!rows.length) return html`<p class="bc-none">No completed makeover has its bills in JobTread for these seasons.</p>`;
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
    ${placed.map((r, ri) => {
      const s = statsOf(r.list);
      return html`<div class="bc-row" key=${r.id}>
      <div class="bc-row__label"><strong>${big ? r.short : r.label}</strong><span>${nbw(plural(r.count, 'makeover'))}</span></div>
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
      ${big ? html`<div class="bc-row__nums"><b>${compact(s.median)}</b><span>${s.count === 1 ? 'paid' : 'median'}</span></div>`
        : s.count === 1 ? html`<dl class="bc-row__nums"><div class="is-median"><dt>Paid</dt><dd>${dollars(s.median)}</dd></div></dl>`
        : html`<dl class="bc-row__nums">
          <div class="is-median"><dt>Median</dt><dd>${dollars(s.median)}</dd></div>
          <div><dt>Average</dt><dd>${dollars(s.average)}</dd></div>
          <div><dt>Range</dt><dd>${nbw(`${dollars(s.low)} to ${dollars(s.high)}`)}</dd></div>
        </dl>`}
    </div>`;
    })}
    <div class="bc-axis" aria-hidden="true"><span></span><div>${ticks.map((v) => html`<b key=${v} style=${`left:${(v / top) * 100}%`}>${v ? compact(v) : '$0'}</b>`)}</div><span></span></div>
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

/**
 * The model: the money, the plan for the families waiting, and the seasons that count as lately. The money's date
 * rule, as the cash's: a meeting today or ahead shows today's (a packet locked before the day, or before this card,
 * never hides it); a past meeting, what it locked
 */
export function useCosts(data, n, m = null) {
  const upTo = m && m.date < (data.today || todayEastern()) ? m.date : '';
  const cash = useCashNow(data, upTo, n);
  const src = upTo ? n : data.numbers || n;
  const c = src?.costs || null;
  const operating = operatingOf(src);
  const makeovers = c?.makeovers || [];
  const plan = useMemo(() => (c ? planOf({ cash: cash?.total, operating, makeovers, waiting: c.waiting || [], underway: c.underway || [] }) : null), [c, cash?.total, operating]);
  const typical = typicalLately(makeovers);
  const stats = statsOf(typical?.seasons ? makeovers.filter((x) => typical.seasons.includes(Number(x.season))) : makeovers);
  // How many SOARD can build next season, as of the meeting's day (today's for one today or ahead)
  const pipe = c ? pipelineOf({ reveals: c.reveals || [], underway: plan?.jobs || c.underway || [], waiting: plan?.families || c.waiting || [], plan: c.plan, today: upTo || data.today || todayEastern() }) : null;
  return { c, cash, operating, makeovers, plan, pipe, recent: recentSeasons(makeovers), typical, stats };
}

/** The recommended pipeline, first: how many new families next season has room for, and why */
function Pipeline({ pipe, plan }) {
  if (!pipe) return null;
  return html`<div class="bc-answer bc-answer--pipe">
    <div class="bc-answer__money">
      <span class="bc-fig__label">${nbw(`Recommended pipeline, ${pipe.next}`)}</span>
      <span class="bc-answer__value">${nbw(`About ${plural(pipe.room, 'new family', 'new families')}`)}</span>
      <span class="bc-fig__sub">${nbw(`${pipe.capacity} makeovers${pipe.planned ? ` planned for ${pipe.next}` : ' a year'}${pipe.carry.length ? `, less the ${pipe.carry.length} already in line` : ''}`)}</span>
    </div>
    <p class="bc-answer__says">${nbw(pipelineText(pipe, plan))}</p>
  </div>`;
}

/** The money: what's over the operating balance and what's underway, large, and what it means in a sentence */
function Answer({ cash, operating, plan, typical, admin, onBalance }) {
  const free = plan ? plan.free : null;
  return html`<div class=${`bc-answer bc-answer--money ${free != null && free < 0 ? 'is-short' : ''}`}>
    <div class="bc-answer__money">
      <span class="bc-fig__label">For makeovers now</span>
      <span class="bc-answer__value">${free == null ? '–' : free < 0 ? html`${dollars(0)}<small>${nbw(`${dollars(-free)} short`)}</small>` : dollars(free)}</span>
      <span class="bc-fig__sub">${nbw(free == null ? 'The cash in the bank isn’t in yet' : `${dollars(cash.total)} in the bank, less ${dollars(operating)} kept to run SOARD${plan.committed > 0 ? ` and ${dollars(plan.committed)} still to come on the ${plural(plan.jobs.length, 'makeover')} underway` : ''}`)}</span>
      ${admin && onBalance ? html`<${BalanceEdit} value=${operating} onSaved=${onBalance} />` : null}
    </div>
    ${plan ? html`<p class="bc-answer__says">${nbw(answerText(plan, typical))}</p>` : null}
    ${plan && screenText(plan, typical) !== answerText(plan, typical) ? html`<p class="bc-answer__says bc-answer__says--short">${nbw(screenText(plan, typical))}</p>` : null}
  </div>`;
}

/** The median makeover lately, with its average, low and high */
function Median({ typical, stats }) {
  return html`<div class="bc-median">
    <span class="bc-fig__label">${nbw(typical?.seasons ? `Median makeover, ${seasonsText(typical.seasons)}` : 'Median makeover')}</span>
    <span class="bc-fig__value">${typical ? dollars(typical.cost) : '–'}</span>
    ${stats ? html`<dl class="bc-mini">
      <div><dt>Average</dt><dd>${dollars(stats.average)}</dd></div>
      <div><dt>Low</dt><dd>${dollars(stats.low)}</dd></div>
      <div><dt>High</dt><dd>${dollars(stats.high)}</dd></div>
    </dl>` : null}
    <span class="bc-fig__sub">${nbw(stats ? `Of ${plural(stats.count, 'completed makeover')}, what SOARD paid. Donated work isn’t in it.` : 'No completed makeover has its bills in JobTread yet.')}</span>
  </div>`;
}

/** Who the money starts, best score first: each family's likely cost, less a pledge, covered or what it still needs */
function Waiting({ plan, big = false, links = true }) {
  if (!plan) return null;
  const fam = plan.families;
  if (!fam.length) return html`<div class="bc-wait"><h3 class="bc-h3">Waiting on the money</h3><p class="bc-lead">No family approved is waiting.</p></div>`;
  const firstShort = fam.findIndex((x) => !x.covered);
  return html`<div class="bc-wait">
    <h3 class="bc-h3">Waiting on the money${fam.length > 1 ? ', best score first' : ''}</h3>
    <ol class="bc-fams">${fam.map((f, i) => {
      const name = links && f.account ? html`<a class="bc-fam__name" href=${`#/families/${encodeURIComponent(f.account)}`}>${f.name}</a>` : html`<span class="bc-fam__name">${f.name}</span>`;
      return html`<li class=${`bc-fam ${f.covered ? 'is-covered' : 'is-short'}`} key=${f.key}>
        <${Face} f=${f} size=${big ? 64 : 44} />
        <div class="bc-fam__who">
          ${name}
          <span>${nbw([roomsText(f), f.score?.ranked ? `Score\u00a0${f.score.total}` : f.score ? `${f.score.count} of ${f.score.of} scored` : ''].filter(Boolean).join(' · '))}</span>
        </div>
        <div class="bc-fam__cost">
          <strong>${f.estimate ? nbw(`About ${dollars(f.net)}`) : 'Not known yet'}</strong>
          <span>${nbw(f.estimate ? (f.pledged ? `${dollars(f.estimate.cost)}, less ${dollars(f.pledged)} pledged by ${and(f.sponsors.filter((s) => s.pledged && s.slug !== 'soard-advisory-board').map((s) => s.name))}; ${basisText(f.estimate)}` : cap(basisText(f.estimate))) : 'No completed makeover with its bills in JobTread to go by yet')}</span>
        </div>
        <span class=${`bc-chip ${f.covered ? 'is-ok' : ''}`}>${f.covered ? 'Covered' : plan.free < 0 ? 'After what’s underway' : i === firstShort ? (plan.need == null ? 'Not known yet' : nbw(`Needs ${dollars(plan.need)} more`)) : 'After that'}</span>
      </li>`;
    })}</ol>
  </div>`;
}

/** The makeovers underway: each one's stage, what's been paid and what's still to come (its budget, or its rooms' median) */
function Underway({ plan }) {
  if (!plan?.jobs?.length) return null;
  const total = plan.paid + plan.committed;
  const guessed = plan.jobs.filter((j) => j.basis === 'median').reduce((s, j) => s + (j.left || 0), 0);
  return html`<div class="bc-under">
    <div class="bc-under__head">
      <h3 class="bc-h3">${nbw(`Underway: ${plural(plan.jobs.length, 'makeover')}`)}</h3>
      <p class="bc-under__sum">${nbw(`${dollars(plan.paid)} paid so far · about ${dollars(plan.committed)} still to come${guessed ? `, ${dollars(guessed)} of it estimated (no budget yet)` : ''}${total ? ` · about ${dollars(total)} in all` : ''}`)}</p>
    </div>
    <div class="bc-under__wrap"><table class="bp-table bc-under__table">
      <thead><tr><th scope="col">Makeover</th><th scope="col">Stage</th><th scope="col" class="num">Paid so far</th><th scope="col" class="num">Still to come</th><th scope="col">From</th></tr></thead>
      <tbody>${plan.jobs.map((j) => html`<tr key=${j.key}>
        <th scope="row"><span class="bc-under__who"><${Face} f=${j} size=${32} /><span><b>${j.url ? html`<a class="bp-link" href=${j.url} target="_blank" rel="noopener">${j.name}</a>` : j.name}</b><small>${roomsText(j)}</small></span></span></th>
        <td data-label="Stage">${j.status}</td>
        <td class="num" data-label="Paid so far">${dollars(j.paid)}</td>
        <td class="num" data-label="Still to come"><b>${j.left == null ? '–' : dollars(j.left)}</b></td>
        <td class="bc-under__from">${j.basis === 'budget' ? 'Its JobTread budget' : j.basis === 'median' ? nbw(cap(`${basisText(j.estimate)}, no budget yet`)) : 'Not known yet'}</td>
      </tr>`)}</tbody>
    </table></div>
  </div>`;
}

/** Every completed makeover in a table: the chart's dots, readable without hovering */
function Table({ makeovers }) {
  const [by, setBy] = useState('season');
  const list = useMemo(() => [...makeovers].sort(by === 'cost' ? (a, b) => b.cost - a.cost : (a, b) => b.season - a.season || b.cost - a.cost), [makeovers, by]);
  const sortBtn = (k, label) => html`<button type="button" class="bc-sort" aria-pressed=${by === k} onClick=${() => setBy(k)}>${label}</button>`;
  return html`<details class="bp-more bc-table">
    <summary>${nbw(`Every completed makeover (${makeovers.length})`)}</summary>
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
  const { c, cash, operating, makeovers, plan, pipe, recent, typical, stats } = useCosts(data, n, m);
  const [range, setRange] = useState('recent');
  if (!c) return variant === 'home' ? null : html`<p class="bp-muted">What makeovers cost isn’t available from JobTread right now.</p>`;
  const seasons = range === 'recent' ? recent : null;
  const first = Math.min(...makeovers.map((x) => Number(x.season) || 9999));
  const shown = seasons ? makeovers.filter((x) => seasons.includes(Number(x.season))) : makeovers;
  const noBills = (c.noBills || []).filter((x) => !seasons || seasons.includes(Number(x.season)));
  const shownStats = statsOf(shown);
  const body = html`
    <${Pipeline} pipe=${pipe} plan=${plan} />
    <${Answer} cash=${cash} operating=${operating} plan=${plan} typical=${typical} admin=${admin} onBalance=${onBalance} />
    <${Underway} plan=${plan} />
    <div class="bc-split">
      <${Waiting} plan=${plan} />
      <${Median} typical=${typical} stats=${stats} />
    </div>
    <div class="bc-what">
      <div class="bc-what__head">
        <h3 class="bc-h3">Each completed makeover, by room</h3>
        <div class="bc-seg" role="group" aria-label="Which seasons">
          <button type="button" aria-pressed=${range === 'recent'} onClick=${() => setRange('recent')}>${nbw(seasonsText(recent))}</button>
          <button type="button" aria-pressed=${range === 'all'} onClick=${() => setRange('all')}>${nbw(`Every year${Number.isFinite(first) && first < 9999 ? ` since ${first}` : ''}`)}</button>
        </div>
      </div>
      ${shownStats ? html`<p class="bc-stats">${nbw(`${plural(shownStats.count, 'completed makeover')}: median ${dollars(shownStats.median)}, average ${dollars(shownStats.average)}, low ${dollars(shownStats.low)} (${shownStats.lowOf.name}, ${shownStats.lowOf.season}), high ${dollars(shownStats.high)} (${shownStats.highOf.name}, ${shownStats.highOf.season})`)}</p>` : null}
      <${CostChart} makeovers=${makeovers} seasons=${seasons} />
      <p class="bc-note">${nbw(`Each dot is one makeover, at what SOARD paid: its bills in JobTread, without donated work. The line marks each room’s median; the shading, its middle half.${noBills.length ? ` Not counted: ${and(noBills.map((x) => x.name))} (${seasonsText([...new Set(noBills.map((x) => x.season))])}), with no bills in JobTread.` : ''}`)}</p>
      <${Table} makeovers=${shown} />
    </div>
    ${variant === 'home' ? html`<p class="bc-families"><a class="bp-cardhead__go" href="#/families">Every family’s application and score <span aria-hidden="true">→</span></a></p>` : null}`;
  if (variant !== 'home') {
    const past = m && m.date < (data.today || todayEastern());
    return html`<div class="bc bc--agenda">${body}<p class="bp-aglive__when">${past ? `Locked for this meeting${n?.at ? ` on ${new Date(n.at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' })}` : ''}` : 'As of today'}</p></div>`;
  }
  return html`<section class="bp-card bc" aria-labelledby="costs-h" id="costs">
    <div class="bp-cardhead"><h2 class="bp-h2" id="costs-h">What makeovers cost</h2><span class="bp-muted">From JobTread and the bank</span></div>
    ${body}
  </section>`;
}

/** The meeting on the screen: the money and its sentence, the median, and the dots, at the size of a room */
export function CostsSlide({ n, data, date }) {
  const m = date ? { date } : null;
  const { c, cash, operating, makeovers, plan, pipe, recent, typical } = useCosts(data, n, m);
  if (!c) return null;
  const free = plan ? plan.free : null;
  return html`<div class="bc bc--screen">
    <div class="bc-figs">
      ${pipe ? html`<div class="bc-fig">
        <span class="bc-fig__label">${nbw(`Recommended pipeline, ${pipe.next}`)}</span>
        <span class="bc-fig__value">${nbw(`About ${plural(pipe.room, 'new family', 'new families')}`)}</span>
        <span class="bc-fig__sub">${nbw(`${pipe.capacity} makeovers${pipe.planned ? ` planned for ${pipe.next}` : ' a year'}${pipe.carry.length ? `, less ${pipe.carry.length} already in line: ${carryText(pipe.carry, plan?.jobs, plan?.families)}` : `; this year’s finish in ${pipe.year}`}`)}</span>
      </div>` : null}
      <div class="bc-fig">
        <span class="bc-fig__label">For makeovers now</span>
        <span class="bc-fig__value">${free == null ? '–' : free < 0 ? nbw(`${dollars(-free)} short`) : dollars(free)}</span>
        <span class="bc-fig__sub">${nbw(free == null ? '' : `${dollars(cash.total)} in the bank, less ${dollars(operating)} kept${plan.committed > 0 ? ` and ${dollars(plan.committed)} still to come underway` : ''}`)}</span>
        ${plan ? html`<p class="bc-fig__says">${nbw(screenText(plan, typical))}</p>` : null}
      </div>
    </div>
    <div class="bc-what"><h3 class="bc-h3">${nbw(`Completed makeovers by room, ${seasonsText(recent)}`)}</h3><${CostChart} makeovers=${makeovers} seasons=${recent} big=${true} /></div>
  </div>`;
}

export { TYPES };
