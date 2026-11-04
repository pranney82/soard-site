/**
 * makeover-costs-shared.js — what finished makeovers cost, and what the money
 * over the operating balance can start. Shared by the server
 * (functions/api/_makeover-costs.js, which reads JobTread) and the board page
 * (./board/costs.js, which draws it).
 *
 * A makeover's cost is what SOARD paid for it: the approved vendor bills on
 * its JobTread job (JobTread's actualCost), whole cash. Donated work and
 * materials aren't in it (QuickBooks books those as in kind). A makeover is
 * finished once its job says Closed Done or Warranty, or was closed before
 * jobs had a status. Never JobTread's projected cost, which counts a budget
 * line and the bills coded elsewhere both (one 2026 makeover: $47K projected,
 * $26K paid).
 *
 * The rooms are the kid page's (Accessible Bathroom, Dream Bedroom, Therapy
 * Room…), else the job's description; a community project is its own type.
 */

/** The rows of the chart, in order: what was built */
export const TYPES = [
  { id: 'bathroom', label: 'Accessible bathroom', short: 'Bathroom' },
  { id: 'bedroom', label: 'Dream bedroom', short: 'Bedroom' },
  { id: 'therapy', label: 'Therapy room', short: 'Therapy room' },
  { id: 'bath-bed', label: 'Bathroom and bedroom', short: 'Bath + bedroom' },
  { id: 'mixed', label: 'Other mixes of rooms', short: 'Other mixes' },
  { id: 'community', label: 'Community project', short: 'Community' },
];
export const typeById = (id) => TYPES.find((t) => t.id === id) || TYPES[4];

/** The operating balance SOARD keeps; what's over it can go to makeovers (Peter, Nov 4 2026: "its arbitrary") */
export const OPERATING_BALANCE = 500000;
/**
 * The recommended pipeline: how many makeovers SOARD can build, not what the money allows today (funding follows as
 * the reserve builds). The pace: this year's reveals, done and still set for a day this year. The next season's
 * room: staff's plan for it (Applicants → Scores, "Makeovers in <year>") or else that pace, less what already carries
 * into it: open jobs with no reveal set for the rest of this year, and families approved and waiting.
 * → { year, done, scheduled, pace, lastDay (the last reveal set this year), next, planned (staff's, or null), capacity,
 *     carry: [{ name, why }], room } or null with no reveal to go by
 */
export function pipelineOf({ reveals = [], underway = [], waiting = [], plan = null, today }) {
  const year = Number(String(today).slice(0, 4));
  if (!year) return null;
  const thisYear = reveals.filter((r) => Number(r.on.slice(0, 4)) === year);
  const done = thisYear.filter((r) => r.done).length;
  const ahead = thisYear.filter((r) => !r.done && r.on >= today);
  const pace = done + ahead.length;
  const next = Math.max(year + 1, Number(plan?.season) || 0);
  const planned = Number(plan?.capacity?.[next]) > 0 ? Number(plan.capacity[next]) : null;
  if (!pace && !planned) return null;
  const capacity = planned || pace;
  // Already in line for next season: open jobs and families waiting that are next season's makeovers (a 2026
  // makeover finishing late is still 2026's: Peter, Nov 4 2026, "we are finishing the 4 this year"); one with no season,
  // an open job not set to reveal by the end of this year, or a family waiting
  const nextSeason = (x) => { const y = Number(x.buildYear) || Number(x.season) || 0; return y > 0 ? y >= next : null; };
  const carry = [
    ...underway.filter((u) => nextSeason(u) ?? !(u.revealOn && u.revealOn >= today && Number(u.revealOn.slice(0, 4)) === year)).map((u) => ({ name: u.name, why: u.status })),
    ...waiting.filter((w) => nextSeason(w) ?? true).map((w) => ({ name: w.name, why: 'Approved, waiting' })),
  ];
  return { year, done, scheduled: ahead.length, pace, lastDay: ahead.map((r) => r.on).sort().at(-1) || null, next, planned, capacity, carry, room: Math.max(0, capacity - carry.length) };
}

/** The operating balance a meeting's numbers carry (Board settings), else the usual */
export const operatingOf = (n) => (Number(n?.operating?.balance) > 0 ? Number(n.operating.balance) : OPERATING_BALANCE);
/**
 * The cash in the bank in a set of numbers, as the board page picks it: a bank's live balances once one besides
 * Mercury holds the money, else QuickBooks', else Mercury's. (The board page's own figure can also come from a
 * meeting's balance sheet: ./board/money.js useCashNow.) null with none
 */
export function cashOf(n) {
  const live = n?.cash;
  if (live && typeof live.total === 'number' && live.total > 0 && (live.accounts || []).some((x) => x.bank && x.bank !== 'Mercury')) return live.total;
  if (typeof n?.books?.cash?.total === 'number') return n.books.cash.total;
  return typeof live?.total === 'number' && live.total > 0 ? live.total : null;
}
/** What counts as "lately": the makeovers of this many seasons, this one included */
export const RECENT_SEASONS = 2;
/** Fewer finished makeovers of a type than this, and its typical cost leans on every year, then on every type */
export const ENOUGH = 3;

const ROOM = { bathroom: /bath/i, bedroom: /bed\s*room|bedroom/i, therapy: /therapy|sensory/i, access: /ramp|lift|elevator/i };

/** "Accessible Bathroom,Wheelchair Ramp" or ['Dream Bedroom'] → ['Accessible Bathroom', 'Wheelchair Ramp'] */
export function roomList(v) {
  const list = Array.isArray(v) ? v : String(v || '').split(/[,+;]/);
  return list.map((r) => String(r || '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 6);
}

/** What was built, as one of TYPES: a ramp or a lift goes with the room it serves */
export function typeOf(rooms, { community = false } = {}) {
  if (community) return 'community';
  const has = (k) => rooms.some((r) => ROOM[k].test(r));
  const core = ['bathroom', 'bedroom', 'therapy'].filter(has);
  if (core.length === 1) return core[0];
  if (core.length === 2 && has('bathroom') && has('bedroom')) return 'bath-bed';
  return 'mixed';
}

/** The middle value (the typical one), or null with none */
export function median(xs) {
  const s = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
/**
 * The four numbers a board member asks for (Peter, Nov 4 2026: "average, median and high low"): → { count, average,
 * median, low, high, lowOf, highOf } (the makeovers at each end), or null with none
 */
export function statsOf(makeovers) {
  const list = makeovers.filter((m) => typeof m.cost === 'number' && Number.isFinite(m.cost));
  if (!list.length) return null;
  const by = [...list].sort((a, b) => a.cost - b.cost);
  return {
    count: list.length, average: list.reduce((s, m) => s + m.cost, 0) / list.length, median: median(list.map((m) => m.cost)),
    low: by[0].cost, high: by.at(-1).cost, lowOf: by[0], highOf: by.at(-1),
  };
}
/** The middle half of the costs: { low, high } (the 25th and 75th percentiles), or null under 4 */
export function middleHalf(xs) {
  const s = xs.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (s.length < 4) return null;
  const q = (p) => { const i = (s.length - 1) * p; const lo = Math.floor(i); return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo); };
  return { low: q(0.25), high: q(0.75) };
}

/** The newest season with a finished makeover, and the seasons that count as lately */
export function recentSeasons(makeovers) {
  const last = Math.max(0, ...makeovers.map((m) => Number(m.season) || 0));
  return last ? Array.from({ length: RECENT_SEASONS }, (_, i) => last - i) : [];
}

/**
 * The chart's rows: each type with its makeovers (costliest last), how many, the typical (median) cost and the
 * middle half. Types with none are left out. `seasons`: only those seasons ([] or null: every one)
 */
export function rowsOf(makeovers, seasons = null) {
  const keep = seasons?.length ? makeovers.filter((m) => seasons.includes(Number(m.season))) : makeovers;
  return TYPES.map((t) => {
    const list = keep.filter((m) => m.type === t.id).sort((a, b) => a.cost - b.cost);
    return { ...t, list, count: list.length, typical: median(list.map((m) => m.cost)), spread: middleHalf(list.map((m) => m.cost)) };
  }).filter((r) => r.count);
}

/**
 * What one more makeover of a type is likely to cost: the typical of that type lately, else of that type in every
 * year, else of every type lately, else of all. → { cost, count, basis: 'type-recent' | 'type' | 'all-recent' | 'all', type }
 */
export function estimateFor(type, makeovers) {
  const recent = recentSeasons(makeovers);
  const lately = makeovers.filter((m) => recent.includes(Number(m.season)));
  const tries = [
    ['type-recent', lately.filter((m) => m.type === type)],
    ['type', makeovers.filter((m) => m.type === type)],
    ['all-recent', lately],
    ['all', makeovers],
  ];
  for (const [basis, list] of tries) {
    if (list.length >= ENOUGH || (basis === 'all' && list.length)) return { cost: median(list.map((m) => m.cost)), count: list.length, basis, type, seasons: basis.endsWith('recent') ? recent : null };
  }
  return null;
}

/** The typical makeover lately, any type: { cost, count, seasons } or null */
export function typicalLately(makeovers) {
  const recent = recentSeasons(makeovers);
  const lately = makeovers.filter((m) => recent.includes(Number(m.season)));
  const list = lately.length >= ENOUGH ? lately : makeovers;
  const cost = median(list.map((m) => m.cost));
  return cost == null ? null : { cost, count: list.length, seasons: list === lately ? recent : null };
}

/**
 * What's still to come on an open job: its JobTread budget less what's been paid; with no budget yet, the median of
 * completed makeovers with the same rooms (estimateFor) less what's been paid. Never below nothing (a job over its
 * budget has nothing more expected of it here). → { left, basis: 'budget' | 'median', estimate } or null (no way to tell)
 */
export function stillToCome(job, makeovers) {
  const paid = Math.max(0, Number(job.paid) || 0);
  if (Number(job.budget) > 0) return { left: Math.max(0, job.budget - paid), basis: 'budget', estimate: null };
  const e = estimateFor(job.type, makeovers);
  return e ? { left: Math.max(0, e.cost - paid), basis: 'median', estimate: e } : null;
}

/**
 * The money for more makeovers, and who it starts. `cash`: the board's cash in the bank (the figure on Home);
 * `operating`: the balance kept for running SOARD; `underway`: the open jobs being built, each { paid, budget, type },
 * whose still to come is spoken for first (stillToCome); `waiting`: families approved and waiting on the money, in
 * order (best score first), each { type, pledged? }. Each family's cost is its rooms' median, less what a sponsor pledged.
 * → { over (cash less the operating balance), committed (still to come on the open jobs), paid (on them so far),
 *     free (over less committed), short, typical, more (how many median makeovers what's left after the waiting
 *     families starts), jobs: [{ ...job, left, basis, estimate }], families: [{ ...family, estimate, net, total
 *     (running), covered }], covered (how many), left (money after them), need (what the first family not covered
 *     still needs: its cost and what the money is short) }
 */
export function planOf({ cash, operating = OPERATING_BALANCE, makeovers = [], waiting = [], underway = [] }) {
  if (typeof cash !== 'number' || !Number.isFinite(cash)) return null;
  const over = cash - operating;
  const jobs = underway.map((j) => ({ ...j, ...(stillToCome(j, makeovers) || { left: null, basis: null, estimate: null }) }));
  const committed = jobs.reduce((s, j) => s + (j.left || 0), 0);
  const paidSoFar = jobs.reduce((s, j) => s + (Number(j.paid) || 0), 0);
  const free = over - committed;
  const typical = typicalLately(makeovers);
  let total = 0;
  let covered = 0;
  let need = null;
  const families = waiting.map((f) => {
    const estimate = estimateFor(f.type, makeovers);
    const pledged = Math.max(0, Number(f.pledged) || 0);
    const net = estimate ? Math.max(0, estimate.cost - pledged) : null;
    total += net || 0;
    const ok = net != null && free >= total && need == null;
    if (ok) covered += 1;
    // (what it takes to start them: their cost, and whatever the money is short of what's spoken for)
    else if (need == null && net != null) need = total - free;
    return { ...f, estimate, pledged, net, total, covered: ok };
  });
  const spent = families.filter((f) => f.covered).reduce((s, f) => s + (f.net || 0), 0);
  const left = free - spent;
  return {
    over, committed, paid: paidSoFar, jobs, unknown: jobs.filter((j) => j.left == null).length,
    free, short: free < 0 ? -free : 0, operating, cash, typical,
    families, covered, left: Math.max(0, left), need,
    more: typical?.cost > 0 && need == null && left > 0 ? Math.floor(left / typical.cost) : 0,
  };
}
