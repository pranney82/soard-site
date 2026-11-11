/**
 * Gifts and money through the SOARD connection, read only.
 *
 * Gifts are Zeffy's own record, read when asked (the site keeps no copy of it). Checks are the Checks tab's cards
 * (./_check-gifts.js): sending one to Zeffy stays with a person in the admin. SOARD's numbers are the board page's
 * (./_board.js liveNumbers): the bank balance and the year's books show only to the Board area's admins, as on
 * the board page; the staff admin itself never shows balances.
 */

import { listPayments, givenName, recurringLabel, screenPayment } from '../_zeffy.js';
import { checksView } from '../_check-gifts.js';
import { liveNumbers } from '../_board.js';
import { isBoardAdmin } from '../_board-roles.js';
import { rowsOf, recentSeasons, statsOf } from '../../../public/admin/makeover-costs-shared.js';
import { done, refuse, adminUrl, dollars, words, isoDay, READ } from './core.js';

const DAY_S = 86400;
const easternDay = (s) => new Date(s * 1000).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
/** The second a day (YYYY-MM-DD) starts in Atlanta, daylight saving or not */
function easternStart(day) {
  const noonUtc = Date.parse(`${day}T12:00:00Z`);
  if (!Number.isFinite(noonUtc)) return NaN;
  const there = new Date(new Date(noonUtc).toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const offsetMs = noonUtc - Date.UTC(there.getFullYear(), there.getMonth(), there.getDate(), there.getHours(), there.getMinutes());
  return Math.floor((Date.parse(`${day}T00:00:00Z`) + offsetMs) / 1000);
}
const clean = (s) => String(s ?? '').trim();
/** Asked to give anonymously, as the board's own count reads it (./_board-gifts.js) */
const anonymous = (p) => (p?.buyer_questions || []).some((q) => /anonym/i.test(String(q?.question || '')) && (q.answer === true || /^(yes|true|oui|s[ií])$/i.test(clean(q.answer))));

const giver = (b) => {
  const name = givenName(b);
  const company = b?.is_corporate ? String(b?.company_name || '').trim() : '';
  return company && name && company.toLowerCase() !== name.toLowerCase() ? `${company} (${name})` : company || name || null;
};

async function recentGifts(env, { days = 7, from, to, query = '', min = 0 }) {
  if (!env.ZEFFY_API_KEY) return refuse('Zeffy isn’t connected to the site, so gifts can’t be read.');
  const now = Math.floor(Date.now() / 1000);
  const end = to ? easternStart(to) + DAY_S - 1 : now;
  const start = from ? easternStart(from) : end - days * DAY_S;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end) return refuse('Those dates don’t make a range. Use YYYY-MM-DD, from before to.');
  if (end - start > 400 * DAY_S) return refuse('Ask for at most 400 days at once.');
  const q = String(query || '').trim().toLowerCase();
  const all = await listPayments(env, { from: start, to: end, pages: 20 });
  const gifts = all.filter((p) => !screenPayment(p) && Number(p.amount) >= min * 100)
    .map((p) => ({
      from: giver(p.buyer), email: p.buyer?.email || null, dollars: dollars(p.amount), day: easternDay(Number(p.created)),
      campaign: p.description ? words(p.description, 120) : null, ...(recurringLabel(p) ? { every: recurringLabel(p) } : {}),
      ...(p.buyer?.is_corporate ? { company: true } : {}),
      ...(anonymous(p) ? { anonymous: 'Asked to give anonymously: thank them, but never name them anywhere public' } : {}),
    }))
    .filter((g) => !q || `${g.from || ''} ${g.email || ''} ${g.campaign || ''}`.toLowerCase().includes(q))
    .sort((a, b) => b.day.localeCompare(a.day) || (b.dollars || 0) - (a.dollars || 0));
  const total = Math.round(gifts.reduce((s, g) => s + (g.dollars || 0), 0) * 100) / 100;
  const byCampaign = {};
  for (const g of gifts) byCampaign[g.campaign || '(none)'] = Math.round(((byCampaign[g.campaign || '(none)'] || 0) + (g.dollars || 0)) * 100) / 100;
  return done({
    from: easternDay(start), to: easternDay(end), gifts: gifts.length, total, byCampaign,
    list: gifts.slice(0, 300), ...(gifts.length > 300 ? { more: gifts.length - 300 } : {}),
    note: 'Straight from Zeffy: successful payments, less refunds, imports and the site’s own tests. Donors’ emails are for thanking them, never for a list.',
  });
}

async function checksWaiting(env, { all = false }) {
  const v = await checksView(env);
  const list = (v.list || []).filter((c) => all || c.needsYou);
  return done({
    waitingOnSomeone: v.waiting || 0,
    checks: list.slice(0, 60).map((c) => ({
      payer: c.payer || null, dollars: dollars(c.cents), deposited: c.depositDay || isoDay(c.depositedAt), checkDate: c.checkDate || null,
      memo: c.memo ? words(c.memo, 160) : null, number: c.checkNumber || null, needsSomeone: !!c.needsYou, stands: c.why || c.state || null,
      ...(c.formTitle ? { zeffyForm: c.formTitle } : {}),
    })),
    said: 'Each check deposited in Mercury gets a card on the Checks tab. Sending one to Zeffy, matching it, or saying it isn’t a gift is done there by a person.',
    admin: adminUrl('#job-costs'),
  });
}

/** What completed makeovers cost, as the board page's Costs shows it (../../../public/admin/makeover-costs-shared.js) */
function costsOf(c) {
  if (!c?.makeovers?.length) return null;
  const seasons = recentSeasons(c.makeovers);
  const byRoom = (list) => list.map((r) => ({ room: r.label, completed: r.count, median: r.typical, ...(r.spread ? { middleHalf: [Math.round(r.spread.low), Math.round(r.spread.high)] } : {}) }));
  const stats = (s) => (s ? { completed: s.count, median: s.median, average: Math.round(s.average), low: s.low, high: s.high } : null);
  return {
    dollarsPaid: 'What SOARD paid: the approved bills in JobTread. Donated work and materials aren’t in it.',
    lastTwoSeasons: { seasons, ...stats(statsOf(c.makeovers.filter((m) => seasons.includes(Number(m.season))))), byRoom: byRoom(rowsOf(c.makeovers, seasons)) },
    everyYear: { ...stats(statsOf(c.makeovers)), byRoom: byRoom(rowsOf(c.makeovers)) },
    underway: (c.underway || []).length, familiesWaitingOnTheMoney: (c.waiting || []).length, asOf: c.at || null,
  };
}

async function numbers(env, _args, me) {
  const [n, board] = await Promise.all([liveNumbers(env), isBoardAdmin(env.DB, me).catch(() => false)]);
  const { open, ...projects } = n.projects || {};
  return done({
    asOf: n.at, impact: n.impact ?? null, makeoverCosts: costsOf(n.costs), projects: n.projects ? projects : null,
    reveals: n.reveals ?? [], recentReveals: (n.pastReveals || []).slice(0, 10), events: n.events ?? [], recentEvents: n.recentEvents ?? [],
    boardMeetings: n.meetings ?? [],
    ...(board ? { cash: n.cash, books: n.books, finance: n.finance, operatingBalance: n.operating } : { money: 'The bank balance and the year’s books show only to the Board area’s admins, as on the board page.' }),
    note: 'The board page’s own numbers. Makeover costs: say the median, as the board page does.',
  });
}

export const TOOLS = [
  { name: 'recent_gifts', title: 'Recent gifts', annotations: { title: 'Recent gifts', ...READ, openWorldHint: true },
    description: 'Gifts from Zeffy, newest first: who gave, how much, the day, the campaign, and whether it repeats; with the total and the total by campaign. The last 7 days unless you give days or from/to (YYYY-MM-DD, Eastern). Filter by part of a name, email or campaign, or a smallest amount in dollars.',
    inputSchema: { type: 'object', properties: {
      days: { type: 'integer', minimum: 1, maximum: 400 }, from: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' }, to: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
      query: { type: 'string', maxLength: 200 }, min: { type: 'number', minimum: 0 },
    }, additionalProperties: false },
    run: recentGifts },
  { name: 'checks_waiting', title: 'Checks waiting', annotations: { title: 'Checks waiting', ...READ },
    description: 'Checks deposited in Mercury that are waiting on a person in Admin → Checks (to send to Zeffy, match, or set aside), with the payer, amount, memo and why. all: true lists the recent ones too.',
    inputSchema: { type: 'object', properties: { all: { type: 'boolean' } }, additionalProperties: false },
    run: checksWaiting },
  { name: 'soard_numbers', title: 'SOARD’s numbers', annotations: { title: 'SOARD’s numbers', ...READ },
    description: 'The board page’s numbers right now: kids served and the impact so far, what finished makeovers cost (say the median), makeovers under way, reveals and events coming up and just past, and board meetings. Board admins also get the bank balance and the year’s books.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    run: numbers },
];
