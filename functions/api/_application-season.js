/**
 * A season at a glance, for Admin → Applications → Insights
 * ===========================================================================
 * Each kind's applications beside the same kind last season, so the page can
 * open on the real answer: how many are in, and how that compares.
 *
 * This season counts what the limit counts: the form's applications, not tests,
 * not deleted, with Community Project on the account deciding the kind
 * (./_application-constants.js). A community project staff added in JobTread
 * counts as one too, and is listed by name: it has no application to measure.
 *
 * Last season comes from the applicants mirror (./_applicants.js), the one place
 * every season is, dated by when each account was made in JobTread. Its kind is
 * read the way the site reads any account (./_applicant-comms.js accountKindFor).
 */

import { accountKindFor } from './_applicant-comms.js';
import { COMMUNITY_PROJECT_LIKE } from './_application-constants.js';
import { kindOf } from './_application-form.js';

const DAY_MS = 86400000;
const parseJson = (s, d) => { try { return s == null ? d : JSON.parse(s) ?? d; } catch { return d; } };
const isTestName = (name) => /^\s*test\b/i.test(String(name || ''));

/** Every account of those seasons, with the application behind it (none on a fresh database) */
async function accountsOf(DB, years) {
  try {
    const { results } = await DB.prepare(`SELECT a.account_id, a.name, a.status, a.year, a.types, a.fields, a.created_at, a.archived_at,
        p.id AS app_id, p.kind AS form_kind, p.is_test, p.deleted_at
      FROM applicants a LEFT JOIN applications p ON p.jt_account_id = a.account_id
      WHERE a.year IN (${years.map(() => '?').join(', ')})`).bind(...years).all();
    return results || [];
  } catch {
    return [];
  }
}

/** Accounts marked Community Project, whichever season they're on now */
async function markedAccounts(DB) {
  try {
    return new Set(((await DB.prepare('SELECT account_id FROM applicants WHERE types LIKE ?').bind(COMMUNITY_PROJECT_LIKE).all()).results || []).map((r) => r.account_id));
  } catch {
    return new Set(); // no mirror yet
  }
}

const sorted = (list) => list.filter(Boolean).sort();

/** → { lastYear, family: Side, organization: Side }, Side = { total, partway, recent, points, last: { total, points }, added } */
export async function seasonSummary(DB, year, now = Date.now()) {
  const y = String(year);
  const lastYear = String(Number(y) - 1);
  const [accounts, marked] = await Promise.all([accountsOf(DB, [y, lastYear]), markedAccounts(DB)]);
  const { results: rows } = await DB.prepare('SELECT jt_account_id, kind, submitted_at FROM applications WHERE year = ? AND COALESCE(is_test, 0) = 0 AND deleted_at IS NULL').bind(y).all();
  const side = { family: [], organization: [] };
  for (const r of rows || []) side[marked.has(r.jt_account_id) ? 'organization' : kindOf(r.kind)].push(r.submitted_at);
  // Added by hand: marked Community Project, no application behind it, still on the board
  const added = accounts
    .filter((a) => a.year === y && !a.app_id && !a.archived_at && marked.has(a.account_id) && !isTestName(a.name))
    .map((a) => ({ id: a.account_id, name: a.name, status: a.status || '', at: a.created_at }));
  side.organization.push(...added.map((a) => a.at));
  // Last season, by the same kinds
  const before = { family: [], organization: [] };
  for (const a of accounts) {
    if (a.year !== lastYear || isTestName(a.name) || a.is_test || a.deleted_at) continue;
    const f = parseJson(a.fields, {});
    before[accountKindFor({ types: parseJson(a.types, []), formKind: a.form_kind, birthday: f.birthday, diagnosis: f.diagnosis, name: a.name })].push(a.created_at);
  }
  // Partway through right now, each kind's (the limit's own idea of it: ./_application-cap.js countFilling)
  const partway = { family: 0, organization: 0 };
  const quiet = new Date(now - 14 * DAY_MS).toISOString();
  const { results: going } = await DB.prepare(`SELECT COALESCE(kind, 'family') AS kind, COUNT(*) AS n FROM application_drafts
    WHERE year = ? AND submitted_id IS NULL AND cleared_at IS NULL AND stop_key IS NULL AND updated_at >= ? AND COALESCE(ip_hash, '') != 'admin'
    GROUP BY COALESCE(kind, 'family')`).bind(y, quiet).all();
  for (const r of going || []) partway[kindOf(r.kind)] += Number(r.n) || 0;
  const recent = new Date(now - 7 * DAY_MS).toISOString();
  const build = (points, past, going) => ({
    total: points.length,
    partway: going,
    recent: points.filter((t) => t >= recent).length,
    points: sorted(points),
    last: { total: past.length, points: sorted(past) },
  });
  return {
    lastYear: before.family.length || before.organization.length ? lastYear : null,
    family: build(side.family, before.family, partway.family),
    organization: { ...build(side.organization, before.organization, partway.organization), added },
  };
}
