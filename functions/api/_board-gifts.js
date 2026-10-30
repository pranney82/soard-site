/**
 * Major gifts on the board page, from Zeffy
 * ===========================================================================
 * Every successful Zeffy payment of $1,000 or more this year, newest first:
 * the line Slack's "Major gift" alert draws (./_zeffy.js MAJOR_GIFT_CENTS), so
 * a major gift means one thing everywhere. A row is the amount (less anything
 * refunded), who gave (a company and the person who gave for it), the
 * campaign, the day, and whether it's monthly or in kind. Never an email,
 * address or phone.
 *
 * Zeffy stays the record. The board's copy (board_state 'gifts') is the year
 * read again whole every 15 minutes on the board heartbeat and replaced, so a
 * refund or a deleted payment drops out by itself; a read that fails keeps the
 * last one. A giver who ticked a form's "anonymous" question is "Anonymous".
 * A campaign named for a child reads "Makeovers": a gift is never tied to a
 * kid (the reveal belongs to the family).
 */

import { listPayments, screenPayment, recurringLabel, MAJOR_GIFT_CENTS } from './_zeffy.js';
import { readState, writeState } from './_board-roles.js';
import { todayEastern } from './_reveals.js';

const READ_EVERY_MS = 15 * 60 * 1000;
const STALE_MS = 24 * 60 * 60 * 1000;
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
  if (screenPayment(p) || p?.metadata?.soardSelfTest === true) return null;
  const refunded = (p.refunds || []).filter((r) => r?.status === 'succeeded').reduce((t, r) => t + (Number(r.amount) || 0), 0);
  const cents = Number(p.amount) - refunded;
  if (!(cents >= MAJOR_GIFT_CENTS)) return null;
  const hidden = anonymous(p);
  const b = p.buyer || {};
  const company = hidden || !b.is_corporate ? '' : clean(b.company_name);
  const person = hidden ? '' : clean(`${clean(b.first_name)} ${clean(b.last_name)}`);
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
  };
}

/** The year's major gifts from Zeffy, newest first */
export async function readGifts(env, { fetchImpl = fetch, now = Date.now() } = {}) {
  const year = Number(todayEastern(now).slice(0, 4));
  const [payments, kids] = await Promise.all([
    listPayments(env, { from: yearStartS(year), to: Math.floor(now / 1000), pages: MAX_PAGES }, fetchImpl),
    kidNames(env.DB),
  ]);
  const byId = new Map();
  for (const p of payments) { const g = giftOf(p, kids); if (g) byId.set(g.id, g); }
  return { year, list: [...byId.values()].sort((a, b) => b.at - a.at) };
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
  const list = s.year === year ? s.list : [];
  return { year, at: s.at, stale: now - Date.parse(s.at) > STALE_MS, count: list.length, total: list.reduce((t, g) => t + g.cents, 0), list };
}

/** Automations: when the board's gifts were last read and any trouble (never a gift) */
export async function giftsStatus(DB) {
  const s = await readState(DB, KEY);
  return s.triedAt ? { at: s.at || null, triedAt: s.triedAt, error: s.error || null } : null;
}
