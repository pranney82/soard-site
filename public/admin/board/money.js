/**
 * The money as the board page shows it (./portal.js Home and Financials, a meeting's Financial item, and the
 * screen, ./screen.js): the cash, live from the banks once one holds SOARD's money (numbers.cash), else the bank
 * accounts on the newest Statement of Financial Position in a meeting's packet; and the year against its budget,
 * from the newest "budget & actual" sheet. Both read in the browser from QuickBooks' Excel copies. Once QuickBooks
 * itself is connected (Settings → QuickBooks, numbers.books), the year's revenue and expenses so far are
 * its own, read hourly, against the same sheet's budget.
 */

import { h, htm, useState, useEffect } from '../vendor.js';
import { money, shortDate, todayEastern, unzip } from '../board-shared.js';

const html = htm.bind(h);

const fileUrl = (f) => `/api/board-file?id=${encodeURIComponent(f.id)}`;
const isExcel = (f) => /sheet|excel|csv/i.test(String(f?.type || '')) || /\.(xlsx?|csv)$/i.test(String(f?.name || ''));
const monthOf = (ym) => new Date(`${ym}-15T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });

// ─── Cash: live from the banks, else QuickBooks, else the newest balance sheet ───
// Once a bank is connected (Chase through Plaid in Settings, Mercury once it holds the money), the cash is theirs
// (numbers.cash). With QuickBooks connected (Settings → QuickBooks), it's the bank accounts on the books, read hourly
// (numbers.books.cash). Else it's the bank-account total on the newest Statement of Financial Position in a meeting's
// packet (QuickBooks' Excel copy), read in the browser
export const compact = (n) => {
  const a = Math.abs(n);
  // (no minus on what rounds to nothing: "$0", never "−$0")
  const s = n <= -0.5 ? '−' : '';
  return a >= 1e9 ? `${s}$${(a / 1e9).toFixed(a >= 1e10 ? 1 : 2).replace(/\.?0+$/, '')}B` : a >= 1e6 ? `${s}$${(a / 1e6).toFixed(a >= 1e7 ? 1 : 2).replace(/\.?0+$/, '')}M` : a >= 1e4 ? `${s}$${Math.round(a / 1e3)}K` : `${s}${money(a)}`;
};
/**
 * An amount as a figure (the money's tiles): whole dollars with a true minus, "−$48,210"; from $10M up the short
 * form, "$1.4B", so a figure always fits its tile
 */
export const amount = (n) => (typeof n !== 'number' || !Number.isFinite(n) ? '' : Math.abs(n) >= 1e7 ? compact(n) : `${n <= -0.5 ? '−' : ''}${money(Math.abs(n))}`);
function balanceSheet(data, upTo = '') {
  return data.meetings.filter((m) => !upTo || m.date <= upTo).flatMap((m) => m.files.filter((f) => f.kind === 'financials' && isExcel(f) && /financial position|balance sheet/i.test(f.name)).map((f) => ({ f, m })))
    .sort((a, b) => b.m.date.localeCompare(a.m.date) || String(b.f.at || '').localeCompare(String(a.f.at || '')))[0] || null;
}
/** An .xlsx's first sheet as rows of cells, each at its column (A = 0): strings and numbers */
async function sheetGrid(bytes) {
  const z = await unzip(bytes, ['xl/sharedStrings.xml', 'xl/worksheets/sheet1.xml']);
  const dec = new TextDecoder();
  const unxml = (t) => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  const strings = [...dec.decode(z['xl/sharedStrings.xml'] || new Uint8Array()).matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => unxml([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join('')));
  const sheet = dec.decode(z['xl/worksheets/sheet1.xml'] || new Uint8Array());
  const colOf = (letters) => [...letters].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  return [...sheet.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].map((r) => {
    const row = [];
    for (const c of r[1].matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const raw = (c[3] || '').match(/<v>([\s\S]*?)<\/v>/)?.[1] ?? (c[3] || '').match(/<t[^>]*>([\s\S]*?)<\/t>/)?.[1] ?? '';
      const v = /t="s"/.test(c[2]) ? strings[Number(raw)] ?? '' : /t="(inlineStr|str)"/.test(c[2]) ? unxml(raw) : raw === '' ? '' : Number(raw);
      if (v !== '') row[colOf(c[1])] = typeof v === 'string' ? v.trim() : v;
    }
    return row;
  });
}
/** The same, each row's cells side by side (no gaps) */
const sheetRows = async (bytes) => (await sheetGrid(bytes)).map((r) => r.filter((x) => x !== undefined));
const fetchBytes = async (f) => { const r = await fetch(fileUrl(f)); if (!r.ok) throw new Error(`HTTP ${r.status}`); return new Uint8Array(await r.arrayBuffer()); };
/** "1001 SR4_Long Reserve (8861)" → "Long Reserve": no ledger number, no account's last digits */
const accountName = (s) => String(s).replace(/^\d+\s+/, '').replace(/^SR\d+_/i, '').replace(/\s*\(\d{3,}\)\s*$/, '').replace(/_/g, ' ').trim();
const cashOnce = new Map();
function readCash(data, upTo = '') {
  const src = balanceSheet(data, upTo);
  if (!src) return Promise.resolve(null);
  if (!cashOnce.has(src.f.id)) cashOnce.set(src.f.id, (async () => {
    const rows = await sheetRows(await fetchBytes(src.f));
    const asOf = rows.flat().filter((x) => typeof x === 'string').map((x) => x.match(/^As of (.+?)(?: \(PY\))?$/)?.[1]).filter(Boolean);
    const head = rows.findIndex((r2) => /^bank accounts$/i.test(String(r2[0])));
    const totalAt = rows.findIndex((r2) => /^total (for )?(bank accounts|cash( and cash equivalents)?)$/i.test(String(r2[0])));
    if (totalAt < 0 || typeof rows[totalAt][1] !== 'number') return null;
    const accounts = head >= 0 ? rows.slice(head + 1, totalAt).filter((r2) => typeof r2[1] === 'number').map((r2) => ({ name: accountName(r2[0]), balance: r2[1], prior: typeof r2[2] === 'number' ? r2[2] : null })) : [];
    return { total: rows[totalAt][1], prior: typeof rows[totalAt][2] === 'number' ? rows[totalAt][2] : null, asOf: asOf[0] || '', priorAsOf: asOf.find((x, i) => i > 0 && x !== asOf[0]) || '', accounts, meeting: src.m, file: src.f };
  })().catch(() => null));
  return cashOnce.get(src.f.id);
}
function useCash(data, upTo = '') {
  const [cash, setCash] = useState(undefined);
  useEffect(() => { let on = true; readCash(data, upTo).then((c) => { if (on) setCash(c); }); return () => { on = false; }; }, [upTo]);
  return cash;
}
export const andText = (l) => (l.length > 1 ? `${l.slice(0, -1).join(', ')} and ${l.at(-1)}` : l[0] || '');
/**
 * A bank's account as the board reads it: "Chase SR2_Makeover" → "Chase Makeover" (SOARD's SR1–SR5 numbering, as the
 * balance sheet drops it), and with two banks each says its own ("Mercury Opex" beside "Chase Opex"). Two that would
 * read the same keep the bank's own names
 */
function bankNames(list, banks) {
  const named = list.map((a) => {
    const bank = a.bank || 'Mercury';
    const n = String(a.name || '').replace(/\bSR\d+_/gi, '').replace(/_/g, ' ').replace(/\s+/g, ' ').trim() || String(a.name || '');
    return { ...a, name: banks.length > 1 && !n.toLowerCase().startsWith(bank.toLowerCase()) ? `${bank} ${n}` : n };
  });
  return named.map((a, i) => (named.filter((b) => b.name === a.name).length > 1 ? { ...a, name: list[i].name } : a));
}
/** The banks' own numbers (numbers.cash) in the balance sheet's shape, with the month a year back from the history */
export function liveCash(data) {
  const c = data.numbers.cash;
  if (!(c?.total > 0)) return null;
  // As of the oldest read among them: Plaid's refresh of Chase can be hours older than Mercury's live answer
  const at = String(c.banksAt && c.banksAt < c.at ? c.banksAt : c.at || '');
  const day = at ? todayEastern(Date.parse(at)) : '';
  const ym = day.slice(0, 7);
  const then = ym ? (data.cashHistory || []).find((r) => r.month === `${Number(ym.slice(0, 4)) - 1}${ym.slice(4)}`) : null;
  const banks = [...new Set((c.accounts || []).map((a) => a.bank || 'Mercury'))];
  return {
    live: true, total: c.total, asOf: day ? shortDate(day) : '', today: day === todayEastern(), at, prior: then ? then.total : null, priorAsOf: then ? monthOf(then.month) : '',
    accounts: bankNames(c.accounts || [], banks), owed: bankNames((c.owed || []).filter((o) => o.balance > 0), banks), banks, stale: c.stale || [],
  };
}
/**
 * QuickBooks' bank accounts as last read (numbers.books.cash, or a past meeting's locked books), in the banks' shape,
 * with the month a year back and the months of cash it holds
 */
export function booksCash(data, b) {
  const c = b?.cash;
  if (!c || typeof c.total !== 'number') return null;
  const at = String(c.at || b.at || '');
  const day = at ? todayEastern(Date.parse(at)) : '';
  const ym = day.slice(0, 7);
  const then = ym ? (data.cashHistory || []).find((r) => r.month === `${Number(ym.slice(0, 4)) - 1}${ym.slice(4)}`) : null;
  return {
    live: true, total: c.total, asOf: day ? shortDate(day) : '', today: day === todayEastern(), at, prior: then ? then.total : null, priorAsOf: then ? monthOf(then.month) : '',
    accounts: c.accounts || [], owed: (c.owed || []).filter((o) => o.balance > 0), banks: ['QuickBooks'], stale: b.stale ? ['QuickBooks'] : [],
    months: typeof b.monthsOfCash === 'number' ? b.monthsOfCash : null, perMonth: b.perMonth || null,
  };
}
/** 16.8 → "17", 8.46 → "8.5": months of cash, to a tenth under ten; what rounds to none (or less) "Under a month" */
export const monthsText = (m) => { const r = m >= 10 ? Math.round(m) : Math.round(m * 10) / 10; return r > 0 ? String(r) : 'Under a month'; };
/** The same in a sentence: "Under a month", "1 month", "8.5 months" (the board page's "… of spending") */
export const monthsPhrase = (m) => { const t = monthsText(m); return t === 'Under a month' ? t : `${t} ${t === '1' ? 'month' : 'months'}`; };
/** "From QuickBooks, as of 3:05 PM" (today) or "…, as of Oct 28": where the cash comes from when it's the books' */
export const fromBooks = (cash) => (cash?.banks?.length === 1 && cash.banks[0] === 'QuickBooks'
  ? `From QuickBooks, as of ${cash.today ? new Date(cash.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }) : shortAsOf(cash.asOf)}` : '');
/**
 * Home's cash figure: a bank's live balances once one holds SOARD's money, else QuickBooks', else the newest balance
 * sheet's. `upTo` (a past meeting's date) keeps to the balance sheet that meeting had, never today's
 */
export function useCashNow(data, upTo = '', n = null) {
  const sheet = useCash(data, upTo);
  const now = !upTo || upTo >= todayEastern();
  return cashToShow(now ? liveCash(data) : null, sheet, booksCash(data, now ? data.numbers?.books : n?.books));
}
/**
 * A bank's live balances speak for SOARD only once they hold its money: a bank besides Mercury (Chase through
 * Plaid), or Mercury holding at least half what the newest balance sheet has in the bank. QuickBooks is the books,
 * so its bank accounts come next, before the balance sheet and before Mercury on its own (a test deposit, the first
 * transfer). Else the balance sheet's figure stands. `sheet` is undefined while it's read
 */
function cashToShow(live, sheet, books = null) {
  if (live && live.banks.some((b) => b !== 'Mercury')) {
    // The cards: each bank's own, and QuickBooks' for a card no connected bank reads (Ramp; Chase's until it's shared)
    const read = [...new Set(live.owed.map((o) => String(o.bank || '').toLowerCase()).filter(Boolean))];
    const owed = [...live.owed, ...(books?.owed || []).filter((o) => !read.some((b) => String(o.name).toLowerCase().includes(b)))];
    // The banks' cash, and how many months of QuickBooks' spending it holds (the books' 12 months out, whichever bank)
    return { ...live, owed, ...(books?.perMonth > 0 ? { months: Math.round((live.total / books.perMonth) * 10) / 10, perMonth: books.perMonth } : {}) };
  }
  if (books) return books;
  if (sheet === undefined) return undefined;
  if (!live) return sheet;
  return !sheet || live.total >= sheet.total * 0.5 ? live : sheet;
}
/** "Nov 2, 2026" → "Nov 2", the month and day never apart on two lines */
export const shortAsOf = (s) => String(s || '').replace(/, \d{4}$/, '').replace(/^([A-Za-z]{3,9}\.?) (\d)/, '$1\u00a0$2');

// The year against its budget: the newest "budget & actual" sheet in a meeting's packet (SOARD's own layout: a
// heading row naming the Budgeted and Actual columns, then "Revenue Total", "Total Expenses", "Program Total"…)
const budgetOnce = new Map();
/** The budget sheet the year is read from: the newest in a meeting's packet (up to `upTo`) */
const budgetSheetOf = (data, upTo = '') => data.meetings.filter((m) => !upTo || m.date <= upTo).flatMap((m) => m.files.filter((f) => isExcel(f) && /budget/i.test(f.name)).map((f) => ({ f, m })))
  .sort((a, b) => b.m.date.localeCompare(a.m.date) || String(b.f.at || '').localeCompare(String(a.f.at || '')))[0] || null;
/** Whether there's a budget to come while it's read (its figures' places are kept, so nothing moves when they arrive) */
export const budgetDue = (data, upTo = '') => !!budgetSheetOf(data, upTo);
function readBudget(data, upTo = '') {
  const src = budgetSheetOf(data, upTo);
  if (!src) return Promise.resolve(null);
  if (!budgetOnce.has(src.f.id)) budgetOnce.set(src.f.id, (async () => {
    const grid = await sheetGrid(await fetchBytes(src.f));
    // The heading row names Budget and Actual in two different cells (the title above says both in one)
    const colOf = (r, re) => r.findIndex((c) => re.test(String(c ?? '')));
    const head = grid.findIndex((r) => { const b = colOf(r, /budget/i); const a = colOf(r, /actual/i); return b >= 0 && a >= 0 && a !== b; });
    if (head < 0) return null;
    const bCol = colOf(grid[head], /budget/i);
    const aCol = colOf(grid[head], /actual/i);
    // A row's label is its first words (SOARD's sheet starts in column B), its numbers sit under the headings
    const label = (r) => String(r.find((c) => typeof c === 'string') ?? '');
    const line = (re) => {
      const r = grid.find((x) => re.test(label(x)));
      return r && typeof r[bCol] === 'number' && typeof r[aCol] === 'number' ? { budget: r[bCol], actual: r[aCol] } : null;
    };
    const out = {
      year: (String(grid[head][bCol]).match(/\b20\d{2}\b/) || [])[0] || '',
      // The budget's own name for its year when it says one ("FY2027", "2026-27"), else its calendar year
      label: (String(grid[head][bCol]).match(/\bFY\s?'?\d{2,4}\b|\b20\d{2}\s*[-–/]\s*(?:20)?\d{2}\b/i) || [])[0]?.replace(/\s+/g, '') || '',
      asOf: String(grid[head][aCol]).replace(/^actual\s*(as of\s*)?/i, '').trim(),
      revenue: line(/^(revenue total|total revenue|total income)\b/i),
      expenses: line(/^(total expenses|expense total|expenses total)\b/i),
      programs: line(/^program(s)? total\b/i),
      meeting: src.m, file: src.f,
    };
    return out.revenue || out.expenses ? out : null;
  })().catch(() => null));
  return budgetOnce.get(src.f.id);
}

// The year so far from QuickBooks itself (numbers.books, read hourly once it's connected), for today and meetings
// ahead; a past meeting keeps to the books locked into it (n, its snapshot), else its own packet
const booksFor = (data, upTo = '', n = null) => (!upTo || upTo >= todayEastern() ? data.numbers?.books || null : n?.books || null);
/**
 * Whether a budget sheet is for QuickBooks' current year: its "Actual as of" day falls in that fiscal year (SOARD's
 * starts in August, so a calendar year in the heading can't say). A sheet without a readable day goes by its year
 */
function sameYear(sheet, books) {
  if (!sheet) return false;
  // "September 30, 2026" reads as that day's midnight where the page is open: its own year, month and day
  const d = new Date(Date.parse(String(sheet.asOf || '')));
  if (Number.isFinite(d.getTime()) && books.from && books.through) {
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    return day >= books.from && day <= books.through;
  }
  return (sheet.year || String(sheet.meeting?.date || '').slice(0, 4)) === books.year;
}
const less = (a, b) => (typeof a === 'number' && typeof b === 'number' ? Math.round((a - b) * 100) / 100 : null);
/**
 * The year's expenses the way SOARD's budget counts them: QuickBooks' less what never left the bank (the in-kind gifts
 * it takes in and uses at the same value, and depreciation: numbers.books.nonCash). A read from before it kept that
 * (or a meeting's numbers locked then) gives QuickBooks' own
 */
export const spentOf = (books) => (typeof books?.nonCash === 'number' ? less(books.expenses, books.nonCash) : books?.expenses);
/**
 * QuickBooks' revenue and expenses so far in place of the sheet's actuals. The budget beside them stays the
 * sheet's, and only for the same fiscal year: a new year's figures are never measured against last year's budget
 */
/** The year's in-kind gifts among its revenue (QuickBooks' categories, ./mixOf) */
const inKindOf = (sources) => (sources || []).filter((x) => x.key === 'inkind').reduce((t, x) => t + x.amount, 0);
export function withBooks(sheet, books) {
  if (!books || typeof books.revenue !== 'number') return sheet;
  const same = sameYear(sheet, books);
  // Beside each: last year's same days, and its whole year (how far along last year was by now)
  const ly = books.lastYear;
  const line = (actual, x, last, lastFull) => ({ actual, budget: same && x ? x.budget : null, last: typeof last === 'number' ? last : null, lastFull: typeof lastFull === 'number' ? lastFull : null });
  // Expenses as SOARD's budget counts them, without in kind (last year's the same way, once the daily read has it)
  const lyCash = typeof books.nonCash !== 'number' ? [ly?.expenses, ly?.full?.expenses]
    : typeof ly?.nonCash === 'number' && typeof ly?.full?.nonCash === 'number' ? [less(ly.expenses, ly.nonCash), less(ly.full.expenses, ly.full.nonCash)] : [null, null];
  return {
    year: same && sheet.label ? sheet.label : books.year, asOf: shortDate(books.through), live: true, at: books.at,
    // Against QuickBooks' own budget (in kind on both sides) revenue leaves the in kind out too, so the two figures are
    // cash in and cash out (the sheet's budget counts in-kind gifts as revenue). Last year's pace stays its whole revenue's
    revenue: sheet?.qbo ? { ...line(books.revenue - inKindOf(books.sources), sheet.revenue, ly?.revenue, ly?.full?.revenue), inKind: inKindOf(books.sources) } : line(books.revenue, sheet?.revenue, ly?.revenue, ly?.full?.revenue),
    expenses: { ...line(spentOf(books), sheet?.expenses, ...lyCash), inKind: books.nonCash > 0 ? books.nonCash : 0 }, programs: null,
    meeting: sheet?.meeting || null, file: sheet?.file || null, qbo: sheet?.qbo || '',
  };
}
export function useBudget(data, upTo = '', n = null) {
  const books = booksFor(data, upTo, n);
  const own = booksBudget(books);
  const [b, setB] = useState(undefined);
  useEffect(() => { if (own) return undefined; let on = true; readBudget(data, upTo).then((x) => { if (on) setB(x); }); return () => { on = false; }; }, [upTo, !!own]);
  if (own) return withBooks(own, books);
  // While the sheet is read, its budget is still to come: the figures wait for it rather than showing twice
  return b === undefined ? b : withBooks(b, books);
}
/**
 * QuickBooks' own budget for the books' year (functions/api/_quickbooks.js budgetOf: the board's budget since Nov 2
 * 2026), as a budget sheet reads (./withBooks): the year's revenue, and its spending without the in kind, the way SOARD's
 * budget counts expenses. Null without one for that year (then the packet's sheet, as before)
 */
export function booksBudget(books) {
  if (!books?.year) return null;
  // This year's in brief (the daily read's budgetNow), else the statements' own when it's this year's
  const now = books.budgetNow?.year === books.year ? books.budgetNow : null;
  const st = !now && books.budget?.from === `${books.year}-01-01` ? { name: books.budget.name, ...books.budget.totals } : null;
  const t = now || st;
  if (!(t?.revenue > 0)) return null;
  return { year: books.year, label: '', asOf: '', revenue: { budget: Math.max(0, t.revenue - (t.nonCashIncome || 0)) }, expenses: { budget: Math.max(0, t.spending - (t.nonCash || 0)) }, programs: null, meeting: null, file: null, qbo: t.name };
}
export const pctOf = (x) => (x?.budget ? Math.round((x.actual / x.budget) * 100) : null);
/** "31% by now last year": how much of last year's whole year had come in (or gone out) by this day, beside this year's share of its budget */
export const paceText = (x) => (x?.budget && x.last != null && x.lastFull > 0 ? `${Math.round((x.last / x.lastFull) * 100)}% by now last year` : '');
/** "▲ 12% on last year by now": this year's so far against last year's same days, when there's no budget to measure by */
export const growthText = (x, as = 'pct') => {
  if (!(x?.last > 0)) return '';
  const c = changeIn(x.actual, x.last, as, { short: true });
  return c === 'Even' ? 'Even with last year by now' : `${c} on last year by now`;
};

/**
 * A meeting's money as figures, for its Financial item and the screen: the cash, the year's revenue and expenses
 * against the budget, and (once Mercury holds SOARD's money, so its record is the books') the year's net and the
 * lowest the forecast goes. `cash` and `budget` are undefined while they're read. A bank account below zero says so,
 * "Overdrawn", in a plain tile (`quiet`: never the celebratory first one). → [{ k, label, value, sub, tone, quiet }]
 */
/** "August 3, 2026" → ", as of Aug 3" ('' when there's no date) */
const asOfWords = (s) => { const t = Date.parse(String(s || '')); return Number.isFinite(t) ? `, as of ${new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).replace(' ', '\u00a0')}` : s ? `, ${s}` : ''; };
export function moneyTiles({ cash, budget, n, due = false, as = '' }) {
  const out = [];
  if (cash !== null) {
    // (overdrawn by what rounds to nothing is $0 in the bank; a total that isn't a figure says so, never a blank tile)
    const over = !!cash && cash.total <= -0.5;
    out.push({
      k: 'bank', label: over ? 'Overdrawn' : 'Cash in the bank', value: !cash ? '…' : Number.isFinite(cash.total) ? amount(Math.abs(cash.total)) : '–', quiet: over,
      sub: !cash ? 'From the balance sheet' : fromBooks(cash) || (cash.live
        ? [(cash.accounts || []).length > 1 ? cash.accounts.map((a) => `${a.name} ${compact(a.balance)}`).join(' · ') : '', cash.asOf ? `as of ${shortAsOf(cash.asOf)}` : ''].filter(Boolean).join(', ')
        : `${cash.asOf ? `As of ${shortAsOf(cash.asOf)}` : 'From the balance sheet'}${cash.prior != null ? ` · ${as ? changeIn(cash.total, cash.prior, as, { short: true }) : `${cash.total >= cash.prior ? '▲' : '▼'} ${compact(Math.abs(cash.total - cash.prior))}`} on a year` : ''}`),
      tone: cash && cash.prior != null ? (cash.total >= cash.prior ? 'up' : 'down') : '',
    });
  }
  // How long the cash would last at the last 12 months' cash spending (QuickBooks')
  if (cash?.months != null) out.push({ k: 'months', label: 'Months of cash', value: monthsText(cash.months), sub: cash.perMonth ? `At ${compact(cash.perMonth)} a month, the last 12 months’ cash out` : 'At the last 12 months’ cash out' });
  const yr = budget?.year || '';
  // While a budget sheet is read: its two figures' places, so the tiles never move when they arrive
  // (QuickBooks' figures at once when it's connected, as Home has them; the budget's share follows)
  const books = typeof n?.books?.revenue === 'number' ? n.books : null;
  if (budget === undefined && (due || books)) for (const [k, word, v] of [['rev', 'revenue', books?.revenue], ['exp', 'expenses', books ? spentOf(books) : null]]) out.push({ k, label: `${(books?.year || todayEastern().slice(0, 4))} ${word}`, value: typeof v === 'number' ? amount(v) : '…', pct: 0, sub: '\u00a0' });
  for (const [k, x, word] of [['rev', budget?.revenue, 'revenue'], ['exp', budget?.expenses, 'expenses']]) {
    if (x) out.push({ k, label: `${yr} ${word}`.trim(), value: amount(x.actual), pct: pctOf(x), sub: [x.budget ? [`${pctOf(x)}% of the ${compact(x.budget)} budget${asOfWords(budget.asOf)}`, paceText(x)].filter(Boolean).join(' · ') : growthText(x, as || 'pct') || `The year so far${asOfWords(budget.asOf)}`, x.inKind ? `not counting ${compact(x.inKind)} in kind` : ''].filter(Boolean).join(' · ') });
  }
  const f = n?.finance;
  // Mercury's own record (the year so far, the forecast) only once its banks are the cash shown
  if (cash?.live && cash.banks?.includes('Mercury') && !n?.mercury?.empty && f?.ytd) {
    const spent = (p) => (p.makeovers || 0) + (p.store || 0) + (p.operating || 0);
    if (!budget?.revenue) out.push({ k: 'ytd', label: `${f.ytd.year} so far`, value: `${f.ytd.net >= 0.5 ? '+' : ''}${amount(f.ytd.net)}`, sub: `${compact(f.ytd.income)} in · ${compact(spent(f.ytd))} out, through ${new Date(`${f.ytd.through}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' })}`, tone: f.ytd.net >= 0 ? 'up' : 'down' });
    if (f.cash?.lowest) out.push({ k: 'low', label: 'Lowest ahead', value: amount(f.cash.lowest.dollars), sub: `${f.cash.lowest.week ? `Week of ${shortDate(f.cash.lowest.week).replace(/, \d{4}$/, '')}` : 'In the forecast'} · ${compact(f.cash.in13Weeks)} in 13 weeks`, tone: f.cash.belowFloor ? 'down' : '' });
  }
  return out;
}

/** The cash and the budget at once, outside a component (Print it all): { cash, budget }, each null when there's none */
export async function moneyFor(data, upTo = '', n = null) {
  // QuickBooks' own budget when the books have one for their year (as Home and the screen), else the packet's sheet
  const books = booksFor(data, upTo, n);
  const own = booksBudget(books);
  const [sheet, budget] = await Promise.all([readCash(data, upTo), own ? null : readBudget(data, upTo)]);
  const now = !upTo || upTo >= todayEastern();
  return { cash: cashToShow(now ? liveCash(data) : null, sheet, booksCash(data, now ? data.numbers?.books : n?.books)) || null, budget: withBooks(own || budget, books) };
}
/** How a budget's months read: "10", "9.5" */
export const budgetMonthsText = (m) => String(Math.round(m * 10) / 10);
/** How QuickBooks keeps a budget, said after its months: by the month says nothing more */
export const stepText = (step) => (step === 3 ? ', each quarter’s figure spread over its months' : step === 12 ? ', each month an even share of the year (QuickBooks keeps one figure for it)' : '');

// ─── Where the revenue came from: QuickBooks' income accounts by category (functions/api/_quickbooks.js sourcesOf) ───
// Home, a meeting's money item and Financials (./portal.js), the screen (./screen.js) and Print it all (./print.js).
// Each category keeps its color wherever it shows (the dark screen has the same hues stepped for it), checked together
// for lightness, strength and color-blind separation; two are light on white, so every part also carries its name and
// amount. An account outside them takes a color left free; whatever is left over is Everything else, in gray
const MIX_TONE = { donations: 1, store: 2, gala: 3, inkind: 4, grants: 5 };
/**
 * The year's revenue as parts, in their colors' order: the categories of 2% or more (five at most), then Everything
 * else; each with the same days last year when the daily read has them. Null before QuickBooks' categories are in (a
 * read kept by an older deploy, or a past meeting's locked numbers)
 */
export function mixOf(books) {
  const src = books?.sources || [];
  const total = books?.revenue;
  if (!src.length || !src.every((x) => x.key) || !(total > 0)) return null;
  const big = src.filter((x) => x.amount >= total * 0.02);
  const free = [1, 2, 3, 4, 5].filter((t) => !big.some((x) => MIX_TONE[x.key] === t));
  const named = big.map((x) => ({ ...x, tone: MIX_TONE[x.key] || free.shift() })).filter((x) => x.tone).sort((a, b) => a.tone - b.tone);
  const lys = books.lastYear?.sources?.every((x) => x.key) ? books.lastYear.sources : null;
  const lyOf = (key) => (lys ? lys.find((x) => x.key === key)?.amount || 0 : null);
  const parts = named.map((x) => ({ ...x, last: lyOf(x.key) }));
  const rest = Math.max(0, total - named.reduce((t, x) => t + x.amount, 0));
  if (rest >= total * 0.005) {
    const left = src.filter((x) => !named.some((n) => n.key === x.key));
    const lastRest = lys ? Math.max(0, books.lastYear.revenue - named.reduce((t, x) => t + lyOf(x.key), 0)) : null;
    parts.push({ key: 'rest', name: 'Everything else', amount: rest, tone: 0, accounts: left.map((x) => x.name), last: lastRest });
  }
  let at = 0;
  return { total, year: books.year, lastYear: books.lastYear?.year || '', parts: parts.map((x) => { const w = (x.amount / total) * 100; const mid = at + w / 2; at += w; return { ...x, w, mid }; }) };
}
export const shareOf = (a, total) => { const p = (a / total) * 100; return p > 0 && p < 1 ? 'under 1%' : `${Math.round(p)}%`; };
export const changeOf = (a, p) => (p > 0 ? `${a >= p ? '▲' : '▼'} ${Math.abs(Math.round(((a - p) / p) * 100))}%` : '');

// ─── A change said as a percent or in dollars: the presenter's pick on the screen, the reader's on the board page ───
// One choice on this device ('pct' or 'usd'), so the screen, the board page's statements and Print it all say the same
const AS_KEY = 'bd-change-as';
export const readChangeAs = () => { try { return localStorage.getItem(AS_KEY) === 'usd' ? 'usd' : 'pct'; } catch { return 'pct'; } };
export const keepChangeAs = (as) => {
  try { localStorage.setItem(AS_KEY, as === 'usd' ? 'usd' : 'pct'); } catch { /* private browsing */ }
  // (other windows hear it as a storage event; this one's other controls, this)
  dispatchEvent(new Event(AS_KEY));
};
/** The pick as state, kept in step with every other % | $ on this page and in other windows: [as, setAs] */
export function useChangeAs() {
  const [as, setAs] = useState(readChangeAs);
  useEffect(() => {
    const on = (e) => { if (!e.key || e.key === AS_KEY) setAs(readChangeAs()); };
    addEventListener('storage', on);
    addEventListener(AS_KEY, on);
    return () => { removeEventListener('storage', on); removeEventListener(AS_KEY, on); };
  }, []);
  return [as, keepChangeAs];
}
/**
 * Against last year: "▲ 25%" or "▲ $25,486" ("▲ $25K" when `short`), 'Even', or '' with nothing to set it beside. A
 * percent needs last year above zero; without it the change is said in dollars
 */
export function changeIn(a, p, as = 'pct', { short = false } = {}) {
  if (!(typeof a === 'number' && typeof p === 'number')) return '';
  if (as !== 'usd' && p > 0) { const c = Math.round(((a - p) / p) * 100); return c === 0 ? 'Even' : `${c > 0 ? '▲' : '▼'} ${Math.abs(c)}%`; }
  if (Math.round(a) === Math.round(p)) return 'Even';
  return `${a > p ? '▲' : '▼'} ${(short ? compact : money)(Math.abs(a - p))}`;
}
/** Over (under) a budget: "+$217,340" or "+12%" (of the budget; dollars when it's zero), 'Even', or '–' with nothing */
export function overIn(a, b, as = 'usd', { short = false } = {}) {
  if (!(typeof a === 'number' && typeof b === 'number')) return '–';
  if (Math.round(a) === Math.round(b)) return 'Even';
  if (as === 'pct' && b > 0) { const c = Math.round(((a - b) / b) * 100); return c === 0 ? 'Even' : `${c > 0 ? '+' : '−'}${Math.abs(c)}%`; }
  return `${a > b ? '+' : '−'}${(short ? compact : money)(Math.abs(a - b))}`;
}
/**
 * A change both ways, `as` showing its pick and the other kept in its place unseen (portal.css .by-both, drawn from
 * data-alt, so it's never in the page's words): the place is the size of the longer, so choosing % or $ moves nothing
 * on the slide or the page (Peter: "the numbers move position!"). Given two whole lines ("As of Nov 2 · ▲ 12% on a
 * year"), only where they differ is doubled, the arrow with its figure, so the words around it stay as they are and the
 * line breaks in the same place either way. Said the same both ways ("▼ $285K", a profit's), its arrow still stays
 * with its figure
 */
export function Both({ as, pct, usd }) {
  const a = String(pct ?? '');
  const b = String(usd ?? '');
  if (a === b) {
    const m = /[▲▼] \S+/.exec(a);
    return m ? html`${a.slice(0, m.index)}<span class="by-both"><span>${m[0]}</span></span>${a.slice(m.index + m[0].length)}` : a;
  }
  let p = 0;
  while (p < a.length && p < b.length && a[p] === b[p]) p += 1;
  p = a.lastIndexOf(' ', p - 1) + 1;
  if (/[▲▼] $/.test(a.slice(0, p))) p -= 2;
  let s = 0;
  while (s < a.length - p && s < b.length - p && a[a.length - 1 - s] === b[b.length - 1 - s]) s += 1;
  // (the same end from a word's start: "…K on a year" of $450K and $45K is the whole figure's)
  let q = a.length - s;
  if (q < a.length && a[q] !== ' ') { const sp = a.indexOf(' ', q); q = sp === -1 ? a.length : sp; }
  s = a.length - q;
  const [on, off] = as === 'usd' ? [b.slice(p, b.length - s), a.slice(p, q)] : [a.slice(p, q), b.slice(p, b.length - s)];
  return html`${a.slice(0, p)}<span class="by-both" data-alt=${off}><span>${on}</span></span>${a.slice(q)}`;
}

/**
 * The revenue as one bar, a part per category, and a key giving each its amount and share; over a part, its exact
 * amount and the same days last year. `table` (Financials): every category beside last year, with its accounts
 */
export function RevenueMix({ books, table = false }) {
  const mix = mixOf(books);
  const [on, setOn] = useState(-1);
  if (!mix) return null;
  const { parts, total } = mix;
  const tip = parts[on];
  const said = `${mix.year} revenue by category: ${parts.map((x) => `${x.name} ${money(x.amount)} (${shareOf(x.amount, total)})`).join(', ')}`;
  return html`<div class="bp-mix" onMouseLeave=${() => setOn(-1)}>
    <div class="bp-mix__bar" role="img" aria-label=${said}>
      ${parts.map((x, i) => html`<span class=${`bp-mix__seg bp-tone--${x.tone} ${on >= 0 && i !== on ? 'is-dim' : ''}`} style=${`--p:${x.w}%`} key=${x.key} onMouseEnter=${() => setOn(i)}></span>`)}
      ${tip ? html`<div class="bp-mix__tip" style=${`--x:${tip.mid}%`} aria-hidden="true"><strong>${tip.name}</strong>${money(tip.amount)} · ${shareOf(tip.amount, total)}${tip.last != null ? html`<span>${mix.lastYear}, same days: ${money(tip.last)}${changeOf(tip.amount, tip.last) ? ` · ${changeOf(tip.amount, tip.last)}` : ''}</span>` : null}</div>` : null}
    </div>
    ${table ? html`<table class="bp-table bp-mixtable bp-cmp">
      <thead><tr><th scope="col">Category</th><th scope="col" class="num">${mix.year} so far</th>${parts.some((x) => x.last != null) ? html`<th scope="col" class="num">${mix.lastYear}, same days</th><th scope="col" class="num">Change</th>` : null}</tr></thead>
      <tbody>${parts.map((x) => html`<tr key=${x.key} id=${`mix-${x.key}`}>
        <th scope="row"><span class="bp-mixtable__name"><i class=${`bp-tone--${x.tone}`} aria-hidden="true"></i>${x.name}</span>${x.accounts?.length && !(x.accounts.length === 1 && x.accounts[0] === x.name) ? html`<small>${x.accounts.join(', ')}</small>` : null}</th>
        <td class="num">${money(x.amount)}<small>${shareOf(x.amount, total)}</small></td>
        ${x.last != null ? html`<td class="num bp-cmp__ly" data-label=${`${mix.lastYear}, same days`}>${money(x.last)}</td><td class="num bp-cmp__chg">${changeOf(x.amount, x.last) || '–'}</td>` : null}
      </tr>`)}</tbody>
    </table>`
    : html`<ul class="bp-mix__key">${parts.map((x, i) => html`<li key=${x.key} class=${i === on ? 'is-on' : ''} onMouseEnter=${() => setOn(i)}><i class=${`bp-tone--${x.tone}`} aria-hidden="true"></i>${x.name}<strong>${compact(x.amount)}</strong><span>${shareOf(x.amount, total)}</span></li>`)}</ul>`}
  </div>`;
}

// ─── The store: QuickBooks' accounts named for it (functions/api/_quickbooks.js storeOf) ───
// Home, a meeting's money item and Financials (./portal.js), the screen (./screen.js) and Print it all (./print.js).
// Its staff, rent and utilities are in SOARD's shared accounts, so its profit is said to be before them wherever it shows
/**
 * The store's year so far beside last year's same days → { year, lastYear, lines: [{ k, name, amount, last, accounts }] }
 * (its sales, its cost of goods, the profit between), or null before the store has a figure in QuickBooks (or from a
 * read an older deploy kept, or a past meeting's numbers locked before)
 */
export function storeOf(books) {
  const s = books?.store;
  if (!s || !(s.sales || s.cost)) return null;
  const ly = typeof books.lastYear?.store?.sales === 'number' ? books.lastYear.store : null;
  return { year: books.year, lastYear: ly ? books.lastYear.year : '', lines: [
    { k: 'sales', name: 'Sales', amount: s.sales, last: ly ? ly.sales : null, accounts: s.salesAccounts || [] },
    { k: 'cost', name: 'Cost of goods', amount: s.cost, last: ly ? ly.cost : null, accounts: s.costAccounts || [] },
    { k: 'profit', name: 'Profit before staff and rent', amount: s.profit, last: ly ? ly.profit : null, accounts: [] },
  ], margin: s.sales > 0 ? s.profit / s.sales : null, lastMargin: ly?.sales > 0 ? ly.profit / ly.sales : null };
}
/** A store line against last year's same days: a share for its sales and cost, dollars for the profit (which can cross zero) */
export const storeChange = (x, as = '') => (x.last == null ? '' : x.amount === x.last ? 'Even' : as === 'usd' ? changeIn(x.amount, x.last, as, { short: true }) : x.k === 'profit' ? `${x.amount > x.last ? '▲' : '▼'} ${compact(Math.abs(x.amount - x.last))}` : changeOf(x.amount, x.last));

/** The store's three figures in a row (Home, a meeting's money item), each with how it stands against last year by now */
export function StoreFigures({ books }) {
  const st = storeOf(books);
  if (!st) return null;
  return html`<ul class="bp-store">${st.lines.map((x) => html`<li key=${x.k} class=${`bp-store__${x.k}`}>
    <span class="bp-store__name">${x.name}</span><strong class="bp-store__value">${compact(x.amount)}</strong>${storeChange(x) ? html`<span class="bp-store__ly">${storeChange(x)} on ${st.lastYear} by now</span>` : null}${x.k === 'profit' && st.margin != null ? html`<span class="bp-store__ly">${marginText(st)}</span>` : null}
  </li>`)}</ul>`;
}
/** "41% of sales (58% in 2025)": the store's profit as a share of its sales, beside last year's */
export function marginText(st) {
  const pct = (m) => `${Math.round(m * 100)}%`;
  return `${pct(st.margin)} of sales${st.lastMargin != null ? ` (${pct(st.lastMargin)} in ${st.lastYear})` : ''}`;
}

/** Financials: the store's lines beside last year's same days, each with the QuickBooks accounts in it */
export function StoreTable({ books }) {
  const st = storeOf(books);
  if (!st) return null;
  const signed = (n) => `${n < 0 ? '−' : ''}${money(Math.abs(n))}`;
  return html`<table class="bp-table bp-cmp bp-storetable">
    <thead><tr><th scope="col"><span class="sr-only">What</span></th><th scope="col" class="num">${st.year} so far</th>${st.lastYear ? html`<th scope="col" class="num">${st.lastYear}, same days</th><th scope="col" class="num">Change</th>` : null}</tr></thead>
    <tbody>${[...st.lines, ...(st.margin != null ? [{ k: 'margin', name: 'Profit as a share of sales', margin: true }] : [])].map((x) => x.margin ? html`<tr key="margin" class="bp-storetable__margin">
      <th scope="row">${x.name}</th><td class="num">${Math.round(st.margin * 100)}%</td>
      ${st.lastYear ? html`<td class="num bp-cmp__ly" data-label=${`${st.lastYear}, same days`}>${st.lastMargin == null ? '–' : `${Math.round(st.lastMargin * 100)}%`}</td><td class="num bp-cmp__chg">${st.lastMargin == null ? '–' : `${st.margin >= st.lastMargin ? '▲' : '▼'} ${Math.abs(Math.round((st.margin - st.lastMargin) * 100))} pts`}</td>` : null}
    </tr>` : html`<tr key=${x.k} class=${x.k === 'profit' ? 'bp-row--net' : ''}>
      <th scope="row">${x.name}${x.accounts.length ? html`<small>${x.accounts.join(', ')}</small>` : null}</th>
      <td class="num">${signed(x.amount)}</td>
      ${st.lastYear ? html`<td class="num bp-cmp__ly" data-label=${`${st.lastYear}, same days`}>${x.last == null ? '–' : signed(x.last)}</td><td class="num bp-cmp__chg">${storeChange(x) || '–'}</td>` : null}
    </tr>`)}</tbody>
  </table>`;
}
