/**
 * Who a sign-in is, for the admin and the board page
 * ===========================================================================
 * Cloudflare Access lets in two kinds of people with the same emailed code:
 *   staff          a soardcharity.com address. Every admin API answers them
 *                  (functions/api/_middleware.js), except the Board area.
 *   board members  an active board member on People → Board whose private
 *                  email (reveal_board_emails) is the address they signed in
 *                  with. Only the board page's routes (BOARD_ROUTES) answer
 *                  them; everything else is refused before it runs.
 * The Board area (meetings, documents, settings) is for its admins only:
 * Settings → Who can open it, until saved the founders on People → Team
 * (first@soardcharity.com, the way staff sign in).
 */

import { normalizePerson } from '../../public/admin/team-shared.js';

export const STAFF_DOMAIN = 'soardcharity.com';
/** The board page, and the routes a board member's sign-in may call */
export const BOARD_PAGE = '/admin/board/';
export const BOARD_ROUTES = Object.freeze(['/api/board-portal', '/api/board-file']);

export const normEmail = (e) => String(e || '').trim().toLowerCase();
const isEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e || '');
/** A SOARD staff sign-in (a soardcharity.com address) */
export const isStaffEmail = (email) => normEmail(email).endsWith(`@${STAFF_DOMAIN}`) && isEmail(normEmail(email));

/** People records, normalized: [{ slug, ...person }] */
export async function peopleRows(DB) {
  let rows = [];
  try { rows = (await DB.prepare('SELECT slug, data FROM team').all()).results || []; } catch { return []; }
  const out = [];
  for (const r of rows) {
    try { out.push({ slug: r.slug, ...normalizePerson(JSON.parse(r.data || '{}')) }); } catch { /* a broken record is skipped */ }
  }
  return out;
}

/** Private emails by People slug (reveal_board_emails; never in site content) */
export async function privateEmails(DB) {
  try {
    const rows = (await DB.prepare('SELECT slug, email FROM reveal_board_emails').all()).results || [];
    return Object.fromEntries(rows.map((r) => [r.slug, normEmail(r.email)]));
  } catch { return {}; }
}

/** The active board, each with their private email when there is one: [{ slug, name, title, seat, organization, email }] */
export async function activeBoard(DB) {
  const [people, emails] = await Promise.all([peopleRows(DB), privateEmails(DB)]);
  return people.filter((p) => p.group === 'board' && p.status === 'active')
    .map((p) => ({ ...p, email: emails[p.slug] || null }));
}

/** The active board member who signs in with this email, or null */
export async function boardMemberFor(DB, email) {
  const e = normEmail(email);
  if (!isEmail(e) || !DB) return null;
  let slugs = [];
  try { slugs = ((await DB.prepare('SELECT slug FROM reveal_board_emails WHERE lower(email) = ?').bind(e).all()).results || []).map((r) => r.slug); } catch { return null; }
  if (!slugs.length) return null;
  const people = await peopleRows(DB);
  const p = people.find((x) => slugs.includes(x.slug) && x.group === 'board' && x.status === 'active');
  return p ? { slug: p.slug, name: p.name, title: p.title || '', seat: p.seat || '', email: e } : null;
}

/** first@soardcharity.com for each founder on People → Team (how staff sign in) */
export function founderEmails(people) {
  return people.filter((p) => p.group !== 'board' && p.group !== 'advisory' && p.role === 'founder' && p.status === 'active')
    .map((p) => String(p.name || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().match(/[a-z]+/)?.[0])
    .filter(Boolean).map((first) => `${first}@${STAFF_DOMAIN}`);
}

// The board's runtime rows (settings, the sign-in list's sync, caches): their
// own table, never site_config (the content API and the build read that)
const STATE_SCHEMA = 'CREATE TABLE IF NOT EXISTS board_state (key TEXT PRIMARY KEY, data TEXT NOT NULL, updated_at TEXT)';
const _stateReady = new WeakSet();
export async function readState(DB, key) {
  if (!DB) return {};
  if (!_stateReady.has(DB)) { await DB.prepare(STATE_SCHEMA).run(); _stateReady.add(DB); }
  const row = await DB.prepare('SELECT data FROM board_state WHERE key = ?').bind(key).first();
  try { return row ? JSON.parse(row.data) || {} : {}; } catch { return {}; }
}
export async function writeState(DB, key, value) {
  if (!_stateReady.has(DB)) { await DB.prepare(STATE_SCHEMA).run(); _stateReady.add(DB); }
  await DB.prepare('INSERT OR REPLACE INTO board_state (key, data, updated_at) VALUES (?, ?, ?)')
    .bind(key, JSON.stringify(value), new Date().toISOString()).run();
  return value;
}
export const readSettings = (DB) => readState(DB, 'settings');

/** Settings → Who can open the Board area (emails); the founders until it's saved */
export async function boardAdmins(DB, settings = null) {
  const saved = (settings || await readSettings(DB))?.admins;
  if (Array.isArray(saved) && saved.some((e) => isStaffEmail(e))) return [...new Set(saved.map(normEmail).filter(isStaffEmail))];
  return founderEmails(await peopleRows(DB));
}

/** One of the Board area's admins (always a staff sign-in) */
export async function isBoardAdmin(DB, email, settings = null) {
  if (!isStaffEmail(email) || !DB) return false;
  return (await boardAdmins(DB, settings)).includes(normEmail(email));
}
