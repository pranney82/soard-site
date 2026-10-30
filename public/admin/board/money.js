/**
 * The money as the board page shows it (./portal.js Home and Financials, a meeting's Financial item, and the
 * screen, ./screen.js): the cash, live from the banks once one holds SOARD's money (numbers.cash), else the bank
 * accounts on the newest Statement of Financial Position in a meeting's packet; and the year against its budget,
 * from the newest "budget & actual" sheet. Both read in the browser from QuickBooks' Excel copies. Once QuickBooks
 * itself is connected (Settings → QuickBooks, numbers.books), the year's revenue and expenses so far are
 * its own, read hourly, against the same sheet's budget.
 */

import { useState, useEffect } from '../vendor.js';
import { money, shortDate, todayEastern, unzip } from '../board-shared.js';

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
  const s = n < 0 ? '−' : '';
  return a >= 1e6 ? `${s}$${(a / 1e6).toFixed(a >= 1e7 ? 1 : 2).replace(/\.?0+$/, '')}M` : a >= 1e4 ? `${s}$${Math.round(a / 1e3)}K` : `${s}${money(a)}`;
};
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
/** The banks' own numbers (numbers.cash) in the balance sheet's shape, with the month a year back from the history */
export function liveCash(data) {
  const c = data.numbers.cash;
  if (!(c?.total > 0)) return null;
  // As of the oldest read among them: Plaid's refresh of Chase can be hours older than Mercury's live answer
  const at = String(c.banksAt && c.banksAt < c.at ? c.banksAt : c.at || '');
  const day = at ? todayEastern(Date.parse(at)) : '';
  const ym = day.slice(0, 7);
  const then = ym ? (data.cashHistory || []).find((r) => r.month === `${Number(ym.slice(0, 4)) - 1}${ym.slice(4)}`) : null;
  return {
    live: true, total: c.total, asOf: day ? shortDate(day) : '', today: day === todayEastern(), at, prior: then ? then.total : null, priorAsOf: then ? monthOf(then.month) : '',
    accounts: c.accounts || [], owed: (c.owed || []).filter((o) => o.balance > 0), banks: [...new Set((c.accounts || []).map((a) => a.bank || 'Mercury'))], stale: c.stale || [],
  };
}
/** QuickBooks' bank accounts as last read (numbers.books.cash), in the banks' shape, with the month a year back */
export function booksCash(data) {
  const b = data.numbers?.books;
  const c = b?.cash;
  if (!c || typeof c.total !== 'number') return null;
  const at = String(c.at || b.at || '');
  const day = at ? todayEastern(Date.parse(at)) : '';
  const ym = day.slice(0, 7);
  const then = ym ? (data.cashHistory || []).find((r) => r.month === `${Number(ym.slice(0, 4)) - 1}${ym.slice(4)}`) : null;
  return {
    live: true, total: c.total, asOf: day ? shortDate(day) : '', today: day === todayEastern(), at, prior: then ? then.total : null, priorAsOf: then ? monthOf(then.month) : '',
    accounts: c.accounts || [], owed: (c.owed || []).filter((o) => o.balance > 0), banks: ['QuickBooks'], stale: b.stale ? ['QuickBooks'] : [],
  };
}
/** "From QuickBooks, as of 3:05 PM" (today) or "…, as of Oct 28": where the cash comes from when it's the books' */
export const fromBooks = (cash) => (cash?.banks?.length === 1 && cash.banks[0] === 'QuickBooks'
  ? `From QuickBooks, as of ${cash.today ? new Date(cash.at).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' }) : shortAsOf(cash.asOf)}` : '');
/**
 * Home's cash figure: a bank's live balances once one holds SOARD's money, else QuickBooks', else the newest balance
 * sheet's. `upTo` (a past meeting's date) keeps to the balance sheet that meeting had, never today's
 */
export function useCashNow(data, upTo = '') {
  const sheet = useCash(data, upTo);
  const now = !upTo || upTo >= todayEastern();
  return cashToShow(now ? liveCash(data) : null, sheet, now ? booksCash(data) : null);
}
/**
 * A bank's live balances speak for SOARD only once they hold its money: a bank besides Mercury (Chase through
 * Plaid), or Mercury holding at least half what the newest balance sheet has in the bank. QuickBooks is the books,
 * so its bank accounts come next, before the balance sheet and before Mercury on its own (a test deposit, the first
 * transfer). Else the balance sheet's figure stands. `sheet` is undefined while it's read
 */
function cashToShow(live, sheet, books = null) {
  if (live && live.banks.some((b) => b !== 'Mercury')) return live;
  if (books) return books;
  if (sheet === undefined) return undefined;
  if (!live) return sheet;
  return !sheet || live.total >= sheet.total * 0.5 ? live : sheet;
}
export const shortAsOf = (s) => String(s || '').replace(/, \d{4}$/, '');

// The year against its budget: the newest "budget & actual" sheet in a meeting's packet (SOARD's own layout: a
// heading row naming the Budgeted and Actual columns, then "Revenue Total", "Total Expenses", "Program Total"…)
const budgetOnce = new Map();
function readBudget(data, upTo = '') {
  const src = data.meetings.filter((m) => !upTo || m.date <= upTo).flatMap((m) => m.files.filter((f) => isExcel(f) && /budget/i.test(f.name)).map((f) => ({ f, m })))
    .sort((a, b) => b.m.date.localeCompare(a.m.date) || String(b.f.at || '').localeCompare(String(a.f.at || '')))[0];
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
// ahead; a past meeting keeps to its own packet, the way its cash does
const booksFor = (data, upTo = '') => (!upTo || upTo >= todayEastern() ? data.numbers?.books || null : null);
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
/**
 * QuickBooks' revenue and expenses so far in place of the sheet's actuals. The budget beside them stays the
 * sheet's, and only for the same fiscal year: a new year's figures are never measured against last year's budget
 */
export function withBooks(sheet, books) {
  if (!books || typeof books.revenue !== 'number') return sheet;
  const same = sameYear(sheet, books);
  const line = (actual, x) => ({ actual, budget: same && x ? x.budget : null });
  return {
    year: same && sheet.label ? sheet.label : books.year, asOf: shortDate(books.through), live: true, at: books.at,
    revenue: line(books.revenue, sheet?.revenue), expenses: line(books.expenses, sheet?.expenses), programs: null,
    meeting: sheet?.meeting || null, file: sheet?.file || null,
  };
}
export function useBudget(data, upTo = '') {
  const [b, setB] = useState(undefined);
  useEffect(() => { let on = true; readBudget(data, upTo).then((x) => { if (on) setB(x); }); return () => { on = false; }; }, [upTo]);
  // While the sheet is read, its budget is still to come: the figures wait for it rather than showing twice
  return b === undefined ? b : withBooks(b, booksFor(data, upTo));
}
export const pctOf = (x) => (x?.budget ? Math.round((x.actual / x.budget) * 100) : null);

/**
 * A meeting's money as figures, for its Financial item and the screen: the cash, the year's revenue and expenses
 * against the budget, and (once Mercury holds SOARD's money, so its record is the books') the year's net and the
 * lowest the forecast goes. `cash` and `budget` are undefined while they're read. → [{ k, label, value, sub, tone }]
 */
/** "August 3, 2026" → ", as of Aug 3" ('' when there's no date) */
const asOfWords = (s) => { const t = Date.parse(String(s || '')); return Number.isFinite(t) ? `, as of ${new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : s ? `, ${s}` : ''; };
export function moneyTiles({ cash, budget, n }) {
  const out = [];
  if (cash !== null) {
    out.push({
      k: 'bank', label: 'Cash in the bank', value: cash ? money(cash.total) : '…',
      sub: !cash ? 'From the balance sheet' : fromBooks(cash) || (cash.live
        ? [(cash.accounts || []).length > 1 ? cash.accounts.map((a) => `${a.name} ${compact(a.balance)}`).join(' · ') : '', cash.asOf ? `as of ${shortAsOf(cash.asOf)}` : ''].filter(Boolean).join(', ')
        : `${cash.asOf ? `As of ${shortAsOf(cash.asOf)}` : 'From the balance sheet'}${cash.prior != null ? ` · ${cash.total >= cash.prior ? '▲' : '▼'} ${compact(Math.abs(cash.total - cash.prior))} on a year` : ''}`),
      tone: cash && cash.prior != null ? (cash.total >= cash.prior ? 'up' : 'down') : '',
    });
  }
  const yr = budget?.year || '';
  for (const [k, x, word] of [['rev', budget?.revenue, 'revenue'], ['exp', budget?.expenses, 'expenses']]) {
    if (x) out.push({ k, label: `${yr} ${word}`.trim(), value: money(x.actual), pct: pctOf(x), sub: x.budget ? `${pctOf(x)}% of the ${compact(x.budget)} budget${asOfWords(budget.asOf)}` : `The year so far${asOfWords(budget.asOf)}` });
  }
  const f = n?.finance;
  // Mercury's own record (the year so far, the forecast) only once its banks are the cash shown
  if (cash?.live && !n?.mercury?.empty && f?.ytd) {
    const spent = (p) => (p.makeovers || 0) + (p.store || 0) + (p.operating || 0);
    if (!budget?.revenue) out.push({ k: 'ytd', label: `${f.ytd.year} so far`, value: `${f.ytd.net < 0 ? '−' : '+'}${money(Math.abs(f.ytd.net))}`, sub: `${compact(f.ytd.income)} in · ${compact(spent(f.ytd))} out, through ${new Date(`${f.ytd.through}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' })}`, tone: f.ytd.net >= 0 ? 'up' : 'down' });
    if (f.cash?.lowest) out.push({ k: 'low', label: 'Lowest ahead', value: money(f.cash.lowest.dollars), sub: `${f.cash.lowest.week ? `Week of ${shortDate(f.cash.lowest.week).replace(/, \d{4}$/, '')}` : 'In the forecast'} · ${compact(f.cash.in13Weeks)} in 13 weeks`, tone: f.cash.belowFloor ? 'down' : '' });
  }
  return out;
}

/** The cash and the budget at once, outside a component (Print it all): { cash, budget }, each null when there's none */
export async function moneyFor(data, upTo = '') {
  const [sheet, budget] = await Promise.all([readCash(data, upTo), readBudget(data, upTo)]);
  const now = !upTo || upTo >= todayEastern();
  return { cash: cashToShow(now ? liveCash(data) : null, sheet, now ? booksCash(data) : null) || null, budget: withBooks(budget, booksFor(data, upTo)) };
}
