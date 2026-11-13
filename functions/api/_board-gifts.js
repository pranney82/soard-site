/**
 * Major gifts on the board page, from Zeffy
 * ===========================================================================
 * Every gift of $1,000 or more this year from Zeffy, newest first: the line
 * Slack's "Major gift" alert draws (./_zeffy.js MAJOR_GIFT_CENTS), so a major
 * gift means one thing everywhere, gifts imported into Zeffy included (a gala's). A gift Zeffy took in several charges (it
 * takes $5,000 at most in one) is one gift (giftsOf). A row is the amount (less anything
 * refunded), who gave (a company and the person who gave for it), the
 * campaign, the day, and whether it's monthly or in kind. Never an email,
 * address or phone.
 *
 * Zeffy stays the record. The board's copy (board_state 'gifts') is the year
 * read again whole every 15 minutes on the board heartbeat and replaced, so a
 * refund or a deleted payment drops out by itself; a read that fails keeps the
 * last one. A giver who ticked a form's "anonymous" question is "Anonymous", and so is one staff marked Keep
 * anonymous in Donors & Partners (on the person, or the organization the gift counts for: ./_donor-crm.js).
 * A campaign named for a child reads "Makeovers": a gift is never tied to a
 * kid (the reveal belongs to the family).
 */

import { listPayments, screenPayment, recurringLabel, givenName, MAJOR_GIFT_CENTS } from './_zeffy.js';
import { readState, writeState } from './_board-roles.js';
import { todayEastern } from './_reveals.js';

const READ_EVERY_MS = 15 * 60 * 1000;
const STALE_MS = 24 * 60 * 60 * 1000;
// One gift split into charges for Zeffy's limit comes in minutes apart (the widest SOARD has had: 21 minutes)
const SPLIT_GAP_S = 60 * 60;
// 100 payments a page: SOARD's busiest years stay well under this
const MAX_PAGES = 40;
const KEY = 'gifts';
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Midnight on January 1 in Eastern time (EST, UTC−5), as a Unix time */
export const yearStartS = (year) => Date.UTC(year, 0, 1, 5) / 1000;

/** A form question asking to give anonymously, answered yes */
const anonymous = (p) => (p?.buyer_questions || []).some((q) => /anonym/i.test(String(q?.question || '')) && (q.answer === true || /^(yes|true|oui|s[ií])$/i.test(clean(q.answer))));

/** First names of every kid with a page (drafts too: kids being built), to keep them out of campaign names */
export async function kidNames(DB) {
  const { results } = await DB.prepare('SELECT name, data FROM kids').all().catch(() => ({ results: [] }));
  const names = new Set();
  for (const row of results || []) {
    let data = {};
    try { data = JSON.parse(row.data || '{}'); } catch { /* the column will do */ }
    for (const part of clean(data.name || row.name).split(/\s*(?:,|&|\band\b|\+)\s*/i)) {
      const first = part.split(' ')[0];
      if (first.length >= 2) names.add(first);
    }
  }
  return [...names];
}

/** The campaign as the board sees it: one named for a child is "Makeovers" */
export function campaignOf(title, kids = []) {
  const t = clean(title);
  if (!t) return '';
  return kids.some((n) => new RegExp(`(^|[^\\p{L}])${escapeRe(n)}($|[^\\p{L}])`, 'iu').test(t)) ? 'Makeovers' : t;
}

/** One Zeffy payment as a board row, or null when it isn't a major gift (the Slack alert's screen, then $1,000 after refunds) */
export function giftOf(p, kids = []) {
  const g = rowOf(p, kids);
  return g && g.cents >= MAJOR_GIFT_CENTS ? g : null;
}

/** One Zeffy payment as a board row whatever its size, or null when it doesn't count (the Slack alert's screen, nothing kept after refunds) */
function rowOf(p, kids = []) {
  // As Slack screens a payment, except a gift imported into Zeffy counts here (a gala's, brought in from its auction
  // platform, is this year's giving; Slack leaves imports out because they aren't new arrivals). Peter, Nov 12 2026
  // (screened as if taken in Zeffy: an import refunded in full, failed or of nothing still never shows)
  if (screenPayment(p?.type === 'imported' ? { ...p, type: 'online' } : p) || p?.metadata?.soardSelfTest === true) return null;
  const refunded = (p.refunds || []).filter((r) => r?.status === 'succeeded').reduce((t, r) => t + (Number(r.amount) || 0), 0);
  const cents = Number(p.amount) - refunded;
  if (!(cents > 0)) return null;
  const hidden = anonymous(p);
  const b = p.buyer || {};
  const company = hidden || !b.is_corporate ? '' : clean(b.company_name);
  const person = hidden ? '' : givenName(b);
  return {
    id: String(p.id),
    at: Number(p.created) || 0,
    cents,
    // A foundation that typed its own name as the giver's is the company once
    name: company && person.toLowerCase() === company.toLowerCase() ? '' : person,
    company,
    anonymous: hidden,
    campaign: campaignOf(p.description, kids),
    every: recurringLabel(p) || '',
    inKind: p.payment_method?.type === 'in_kind',
    // Kept for Keep anonymous (never shown: giftsNow leaves it out)
    contact: p.contact ? String(p.contact) : '',
    method: p.payment_method?.type || '',
  };
}

/**
 * The major gifts in a run of Zeffy payments, newest first. Zeffy takes $5,000 at most in one charge, so a $10,000
 * gift comes in as $4,000 + $4,000 + $2,000 a few minutes apart: a giver's one-time payments to one campaign, each
 * within an hour of the one before, are one gift, and the $1,000 line is drawn on what they add up to. The giver is
 * known by their name (as the board shows it, any case), else their company, else their email (never kept); a monthly
 * gift, or a payment with none of them, stands alone. The gift keeps its first payment's id and its last one's time
 * (when it was all in), and `parts` says how many it took
 */
export function giftsOf(payments, kids = []) {
  const rows = [];
  // Who really gave each charge, the form's anonymous ones too: kept with the gift's charges only, never shown
  const real = new Map();
  for (const p of payments || []) {
    const g = rowOf(p, kids);
    if (!g) continue;
    const b = p.buyer || {};
    real.set(g.id, { name: givenName(b), company: b.is_corporate || p.payment_method?.type === 'daf' ? clean(b.company_name) : '' });
    const who = (clean(`${clean(b.first_name)} ${clean(b.last_name)}`) || clean(b.company_name) || clean(b.email)).toLowerCase();
    rows.push({ ...g, key: who && !g.every ? [who, g.campaign, g.inKind].join('\n') : `id\n${g.id}` });
  }
  // Each charge's id, contact and company are kept with the gift (never shown: giftsNow leaves them out), so Keep
  // anonymous is checked on every charge of a gift Zeffy took in several
  const byId = new Map(rows.map((r) => [r.id, r]));
  return joinCharges(rows, { ids: true }).filter((g) => g.cents >= MAJOR_GIFT_CENTS)
    .map((g) => ({ ...g, charges: (g.ids || [g.id]).map((id) => { const r = byId.get(id) || {}; const who = real.get(id) || {}; return { id, contact: r.contact || '', company: who.company || r.company || '', name: who.name || r.name || '', method: r.method || '' }; }) }));
}

/**
 * Charges into gifts, the one rule the board and the donor list share (./_donors.js): rows with the same `key` (one
 * giver, one campaign, one kind; a monthly gift or an unknown giver keys by its own id) each within an hour of the one
 * before are one gift. A gift keeps its first charge's fields and id, its last one's time (when it was all in), the
 * sum of their cents, a name or company only if none of its charges was anonymous, and `parts` when it took several
 * (with `ids`, each charge's id: the donor list links them). Every gift whatever its size, newest first; `key` is left off
 */
export function joinCharges(rows, { ids = false } = {}) {
  // A payment read twice (Zeffy's pages can overlap) counts once
  const byId = new Map();
  for (const r of rows || []) byId.set(String(r.id), r);
  const givers = new Map();
  for (const r of byId.values()) givers.set(r.key, [...(givers.get(r.key) || []), r]);
  const list = [];
  const add = (parts) => {
    const hidden = parts.some((x) => x.anonymous);
    const { key, ...first } = parts[0];
    const gift = {
      ...first,
      at: parts.at(-1).at,
      cents: parts.reduce((t, x) => t + x.cents, 0),
      name: hidden ? '' : parts.find((x) => x.name)?.name || '',
      company: hidden ? '' : parts.find((x) => x.company)?.company || '',
      anonymous: hidden,
    };
    if (parts.length > 1) { gift.parts = parts.length; if (ids) gift.ids = parts.map((x) => x.id); }
    list.push(gift);
  };
  for (const run0 of givers.values()) {
    run0.sort((a, b) => a.at - b.at || String(a.id).localeCompare(String(b.id)));
    let run = [];
    for (const g of run0) {
      if (run.length && g.at - run.at(-1).at > SPLIT_GAP_S) { add(run); run = []; }
      run.push(g);
    }
    add(run);
  }
  return list.sort((a, b) => b.at - a.at);
}

/** The year's major gifts from Zeffy, newest first */
export async function readGifts(env, { fetchImpl = fetch, now = Date.now() } = {}) {
  const year = Number(todayEastern(now).slice(0, 4));
  const [payments, kids] = await Promise.all([
    listPayments(env, { from: yearStartS(year), to: Math.floor(now / 1000), pages: MAX_PAGES }, fetchImpl),
    kidNames(env.DB),
  ]);
  return { year, list: giftsOf(payments, kids) };
}

/** On the board heartbeat: every 15 minutes while Zeffy's key is set. Never throws */
export async function maybeReadGifts(env, { fetchImpl = fetch, now = Date.now() } = {}) {
  if (!env.DB || !String(env.ZEFFY_API_KEY || '').trim()) return null;
  try {
    const s = await readState(env.DB, KEY);
    if (s.triedAt && now - Date.parse(s.triedAt) < READ_EVERY_MS) return null;
    const triedAt = new Date(now).toISOString();
    try {
      const { year, list } = await readGifts(env, { fetchImpl, now });
      return await writeState(env.DB, KEY, { year, list, at: triedAt, triedAt, error: null });
    } catch (err) {
      console.error('[board] gifts', err.message);
      return await writeState(env.DB, KEY, { ...s, triedAt, error: err.status === 401 ? 'Zeffy refused ZEFFY_API_KEY' : err.message });
    }
  } catch (err) {
    console.error('[board] gifts', err.message);
    return null;
  }
}

/**
 * For the board page: { year, at, stale, count, total, list } as last read, or null before the first read. In January
 * a list from last year is an empty new year, never last year's gifts
 */
export async function giftsNow(DB, { now = Date.now() } = {}) {
  if (!DB) return null;
  const s = await readState(DB, KEY);
  if (!s.at || !Array.isArray(s.list)) return null;
  const year = Number(todayEastern(now).slice(0, 4));
  // Keep anonymous, as staff have it now (a gift read before they said so too). Unreadable: every name stays hidden
  // rather than one shown that shouldn't be
  const raw = s.year === year ? s.list : [];
  let hidden = null;
  let loose = null;
  try {
    const crm = await import('./_donor-crm.js');
    loose = crm.looseKey;
    hidden = await crm.boardHidden(DB, raw, { now });
  } catch (e) { console.error('[board] keep anonymous', e.message); hidden = null; }
  // An anonymous gift's campaign is "A gift" when it names the giver or any organization kept anonymous (a
  // sponsorship titled with the company's name), compared with legal endings, case and punctuation set aside. Unable
  // to tell (Keep anonymous couldn't be read): every anonymous gift's campaign is "A gift"
  const names = (hidden?.names || []);
  const says = (campaign, g) => {
    if (!hidden || !loose) return true;
    const c = ` ${loose.words(campaign).join(' ')} `;
    return [g.name, g.company, ...(g.charges || []).flatMap((x) => [x.name, x.company]), ...names].some((n) => {
      const w = n ? loose.words(n) : [];
      return w.length && w.join('').length >= 3 && c.includes(` ${w.join(' ')} `);
    });
  };
  const list = raw.map(({ contact, method, charges, ids, ...g }) => {
    const hide = g.anonymous || !hidden || hidden.has(g.id);
    if (!hide) return g;
    return { ...g, name: '', company: '', anonymous: true, campaign: says(g.campaign, { ...g, charges }) ? 'A gift' : g.campaign };
  });
  return { year, at: s.at, stale: now - Date.parse(s.at) > STALE_MS, count: list.length, total: list.reduce((t, g) => t + g.cents, 0), list };
}

/** Automations: when the board's gifts were last read and any trouble (never a gift) */
export async function giftsStatus(DB) {
  const s = await readState(DB, KEY);
  return s.triedAt ? { at: s.at || null, triedAt: s.triedAt, error: s.error || null } : null;
}
