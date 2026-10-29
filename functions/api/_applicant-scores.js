/**
 * Makeover scores: each evaluator's scorecard for a family, and the family's score
 * ===========================================================================
 * Admin → Applications → Applicants scores families with SOARD's rubric
 * (../../public/admin/scoring-shared.js: 10 criteria, 1 to 5 each, the
 * priority tiers). This replaces the "SOARD Makeover Scoring System"
 * spreadsheet, where each evaluator had their own tab and an Averaged Scores
 * tab worked out each family's score.
 *
 *  - applicant_scores (D1): one scorecard per family and evaluator (their
 *    Access email). It's saved as they go; a card counts toward the family's
 *    score once all 10 criteria have one. People change only their own card.
 *    Each card keeps the rubric version it was scored on (the season's).
 *  - applicant_score_settings (D1): how many makeovers SOARD can do in a
 *    season (the spreadsheet's "Annual Makeover Capacity"), per season.
 *
 * A family is ranked once everyone scoring its season has finished a card
 * for it (summary.ranked). Who's scoring a season is whoever has finished a
 * card for one of its families; until the rest have, the family shows as
 * "2 of 3" and waits, so no family's place rests on one person's leanings
 * (Peter, Oct 29 2026: in 2026 one evaluator's totals averaged five points
 * under the other two's). TEST families don't count toward who's scoring.
 *
 * From the 2027 rubric, Family readiness is scored after the home visit:
 * once the family has photos taken in CompanyCam (./_companycam-sync.js), or
 * a decision (Approved or Denied).
 *
 * Scores live on the site only: JobTread has nowhere to keep ten scores per
 * evaluator, and the spreadsheet these came from wasn't in JobTread either.
 * A family's account in JobTread is the key (account_id), so a score follows
 * the family wherever the Applicants mirror shows them.
 *
 * The 2026 scorecards came over from the spreadsheet once, by name
 * (importScores, source 'sheet'); the names were matched to that season's
 * families and never written to this repository.
 */

import { SHEET_RUBRIC, criteriaOf, keysOf, rubricOfSeason, cleanScores, combine, isComplete, scoredCount, totalOf, tierOf } from '../../public/admin/scoring-shared.js';
import { normalizeName } from './_reveals.js';
import { isTestFamily } from './_applicant-approved.js';

const iso = (t = Date.now()) => new Date(t).toISOString();
const parse = (s, d = null) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };
const NOTES_MAX = 4000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS applicant_scores (
    account_id TEXT NOT NULL, evaluator TEXT NOT NULL, evaluator_name TEXT,
    scores TEXT NOT NULL, notes TEXT, rubric INTEGER NOT NULL DEFAULT 1, source TEXT NOT NULL DEFAULT 'site',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, completed_at TEXT,
    PRIMARY KEY (account_id, evaluator))`,
  'CREATE INDEX IF NOT EXISTS idx_applicant_scores_evaluator ON applicant_scores(evaluator)',
  'CREATE TABLE IF NOT EXISTS applicant_score_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT NOT NULL, updated_by TEXT)',
];
const _ready = new WeakSet();
export async function ensureScoreSchema(DB) {
  if (_ready.has(DB)) return;
  await DB.batch(SCHEMA.map((sql) => DB.prepare(sql)));
  _ready.add(DB);
}

export const cleanEvaluator = (email) => {
  const e = String(email || '').trim().toLowerCase();
  return EMAIL.test(e) ? e : null;
};

function cardFromRow(r) {
  const rubric = Number(r.rubric) || SHEET_RUBRIC;
  const scores = cleanScores(parse(r.scores, {}), rubric);
  return {
    evaluator: r.evaluator, name: r.evaluator_name || null, scores, notes: r.notes || '',
    done: scoredCount(scores, rubric), complete: isComplete(scores, rubric), total: totalOf(scores, rubric),
    rubric, source: r.source, createdAt: r.created_at, updatedAt: r.updated_at, completedAt: r.completed_at || null,
  };
}

/** The family's season, status and name from the Applicants mirror (null if it isn't there) */
const familyOf = (DB, accountId) => DB.prepare('SELECT name, status, year FROM applicants WHERE account_id = ?').bind(accountId).first().catch(() => null);

/** Has the family had their home visit? A decision, or photos taken for them in CompanyCam */
export async function homeVisited(DB, accountId, fam) {
  const f = fam === undefined ? await familyOf(DB, accountId) : fam;
  if (f?.status === 'Approved' || f?.status === 'Denied') return true;
  const photo = await DB.prepare("SELECT 1 AS x FROM companycam_files WHERE account_id = ? AND origin = 'companycam' AND kind = 'photo' LIMIT 1").bind(accountId).first().catch(() => null);
  return !!photo;
}

/**
 * Who's scoring each season: Map(year → Set of evaluators with a finished
 * card for one of its families), from rows of applicant_scores joined to the
 * family (a_year, a_name, a_archived). Archived and TEST families don't count.
 */
function panelsOf(rows) {
  const out = new Map();
  for (const r of rows) {
    if (r.a_archived || isTestFamily(r.a_name) || !cardFromRow(r).complete) continue;
    const y = r.a_year || '';
    if (!out.has(y)) out.set(y, new Set());
    out.get(y).add(r.evaluator);
  }
  return out;
}
const JOINED = 'SELECT s.*, a.year AS a_year, a.name AS a_name, a.archived_at AS a_archived FROM applicant_scores s LEFT JOIN applicants a ON a.account_id = s.account_id';
async function joinedRows(DB, where = '', binds = []) {
  try {
    return (await DB.prepare(`${JOINED} ${where} ORDER BY s.created_at`).bind(...binds).all()).results || [];
  } catch {
    // No Applicants mirror yet: every card, and no seasons
    return (await DB.prepare(`SELECT * FROM applicant_scores ${where.replace(/\ba\.year\b/g, 'NULL').replace(/\bs\./g, '')} ORDER BY created_at`).bind(...binds).all()).results || [];
  }
}

/** Who's scoring the family's season (their own scorers for a TEST family) */
async function panelFor(DB, accountId, cards, fam) {
  const f = fam === undefined ? await familyOf(DB, accountId) : fam;
  if (!f || isTestFamily(f.name)) return new Set(cards.filter((c) => c.complete).map((c) => c.evaluator));
  const rows = await joinedRows(DB, 'WHERE a.year IS ?', [f.year ?? null]);
  return panelsOf(rows).get(f.year || '') || new Set();
}

/** Every scorecard for one family, finished ones first, then by when they were started */
export async function scorecardsFor(DB, accountId) {
  await ensureScoreSchema(DB);
  const { results } = await DB.prepare('SELECT * FROM applicant_scores WHERE account_id = ? ORDER BY created_at').bind(accountId).all();
  return (results || []).map(cardFromRow).sort((a, b) => Number(b.complete) - Number(a.complete));
}

/** The rubric a family is scored on: the one its cards already use, else its season's */
const rubricFor = (cards, fam) => cards[0]?.rubric || rubricOfSeason(fam?.year);

/** One family's scorecards and their score, for the drawer, with the rubric to score on and whether the home visit has happened */
export async function familyScores(DB, accountId) {
  const cards = await scorecardsFor(DB, accountId);
  const fam = await familyOf(DB, accountId);
  return { cards, summary: summaryOf(cards, await panelFor(DB, accountId, cards, fam)), rubric: rubricFor(cards, fam), visited: await homeVisited(DB, accountId, fam) };
}

/**
 * What the board, the list and the Scores view show for a family: the score
 * and tier (null until a card is finished), the per-criterion averages, who has
 * a finished card and who has one partway done, and against who's scoring the
 * season (panel): how many that is (of), who hasn't finished (waiting) and
 * whether the family is ranked yet
 */
export function summaryOf(cards, panel = null) {
  const c = combine(cards);
  const by = cards.filter((x) => x.complete).map((x) => x.evaluator);
  const waiting = [...(panel || [])].filter((e) => !by.includes(e));
  return {
    ...(c || { total: null, tier: null, count: 0 }),
    by,
    started: cards.filter((x) => !x.complete && x.done > 0).map((x) => x.evaluator),
    of: by.length + waiting.length,
    waiting,
    ranked: by.length > 0 && !waiting.length,
  };
}

/** Map(account → summary) for every family with a scorecard */
export async function scoreSummaries(DB) {
  await ensureScoreSchema(DB);
  const rows = await joinedRows(DB);
  const panels = panelsOf(rows);
  const by = new Map();
  for (const r of rows) {
    if (!by.has(r.account_id)) by.set(r.account_id, { cards: [], year: r.a_year || '', test: isTestFamily(r.a_name) });
    by.get(r.account_id).cards.push(cardFromRow(r));
  }
  return new Map([...by].map(([id, f]) => [id, summaryOf(f.cards, f.test ? null : panels.get(f.year) || null)]));
}

/**
 * Save the evaluator's own scorecard: the scores picked so far (a criterion set
 * to null is cleared) and their notes. → { card, summary, finished } where
 * finished is true when this save completed the card.
 */
export async function saveScorecard(DB, accountId, { evaluator, name = null, scores = {}, notes, now = Date.now() } = {}) {
  await ensureScoreSchema(DB);
  const who = cleanEvaluator(evaluator);
  if (!who) throw Object.assign(new Error('Sign in with your SOARD account to score.'), { status: 403 });
  const before = await DB.prepare('SELECT * FROM applicant_scores WHERE account_id = ? AND evaluator = ?').bind(accountId, who).first();
  const fam = await familyOf(DB, accountId);
  const rubric = Number(before?.rubric) || rubricFor(await scorecardsFor(DB, accountId), fam);
  const had = before ? cleanScores(parse(before.scores, {}), rubric) : {};
  const next = { ...had };
  for (const k of keysOf(rubric)) {
    if (!(k in (scores || {}))) continue;
    if (scores[k] == null) delete next[k];
    else {
      const v = cleanScores({ [k]: scores[k] }, rubric)[k];
      if (v == null) throw Object.assign(new Error('Each score is a whole number from 1 to 5.'), { status: 422 });
      next[k] = v;
    }
  }
  const later = criteriaOf(rubric).filter((c) => c.after === 'visit' && scores?.[c.key] != null && next[c.key] !== had[c.key]);
  if (later.length && !(await homeVisited(DB, accountId, fam))) {
    throw Object.assign(new Error(`${later[0].label} is scored after the home visit.`), { status: 409 });
  }
  const text = notes === undefined ? before?.notes ?? null : String(notes || '').slice(0, NOTES_MAX) || null;
  const finished = isComplete(next, rubric) && !isComplete(had, rubric);
  const completedAt = isComplete(next, rubric) ? before?.completed_at || iso(now) : null;
  await DB.prepare(`INSERT INTO applicant_scores (account_id, evaluator, evaluator_name, scores, notes, rubric, source, created_at, updated_at, completed_at)
    VALUES (?, ?, ?, ?, ?, ?, 'site', ?, ?, ?)
    ON CONFLICT(account_id, evaluator) DO UPDATE SET evaluator_name = COALESCE(excluded.evaluator_name, evaluator_name), scores = excluded.scores,
      notes = excluded.notes, rubric = excluded.rubric, updated_at = excluded.updated_at, completed_at = excluded.completed_at`)
    .bind(accountId, who, name, JSON.stringify(next), text, rubric, iso(now), iso(now), completedAt).run();
  const cards = await scorecardsFor(DB, accountId);
  return { card: cards.find((c) => c.evaluator === who), summary: summaryOf(cards, await panelFor(DB, accountId, cards, fam)), finished };
}

/** The evaluator's own scorecard, gone (starting over) */
export async function clearScorecard(DB, accountId, { evaluator } = {}) {
  await ensureScoreSchema(DB);
  const who = cleanEvaluator(evaluator);
  if (!who) throw Object.assign(new Error('Sign in with your SOARD account to score.'), { status: 403 });
  await DB.prepare('DELETE FROM applicant_scores WHERE account_id = ? AND evaluator = ?').bind(accountId, who).run();
  const cards = await scorecardsFor(DB, accountId);
  return { summary: summaryOf(cards, await panelFor(DB, accountId, cards)) };
}

// ─── How many makeovers a season can take ─────────────────────────────

const cleanYear = (y) => (/^20\d\d$/.test(String(y || '')) ? String(y) : null);

/** { "2026": { count, updatedAt, updatedBy }, … } */
export async function capacities(DB) {
  await ensureScoreSchema(DB);
  const { results } = await DB.prepare("SELECT key, value, updated_at, updated_by FROM applicant_score_settings WHERE key LIKE 'capacity:%'").all();
  const out = {};
  for (const r of results || []) {
    const n = Number(r.value);
    if (Number.isInteger(n) && n > 0) out[r.key.slice(9)] = { count: n, updatedAt: r.updated_at, updatedBy: r.updated_by };
  }
  return out;
}

export async function setCapacity(DB, year, count, { user = null, now = Date.now() } = {}) {
  await ensureScoreSchema(DB);
  const y = cleanYear(year);
  if (!y) throw Object.assign(new Error('Which season?'), { status: 400 });
  if (count == null || count === '') {
    await DB.prepare('DELETE FROM applicant_score_settings WHERE key = ?').bind(`capacity:${y}`).run();
    return { year: y, count: null };
  }
  const n = Number(count);
  if (!Number.isInteger(n) || n < 1 || n > 500) throw Object.assign(new Error('Capacity is a whole number of makeovers, 1 or more.'), { status: 422 });
  await DB.prepare('INSERT INTO applicant_score_settings (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by')
    .bind(`capacity:${y}`, String(n), iso(now), user).run();
  return { year: y, count: n };
}

// ─── Bringing scorecards over from a spreadsheet ──────────────────────

/** "5 – Critical", "5", 5 → 5 (the spreadsheet's dropdowns put the number first) */
const sheetScore = (v) => {
  const m = String(v ?? '').trim().match(/^([1-5])(?:\b|$)/);
  return m ? Number(m[1]) : null;
};

/**
 * One evaluator's tab of the spreadsheet, onto that season's families, on the
 * spreadsheet's rubric.
 * rows: [{ child, scores: { key: 1-5 or "5 – Critical" }, notes?, id? }].
 * A child is matched by name to the season's applicants (accents, case,
 * punctuation and word order don't matter; "&" and "and" are the same), or by
 * `id` (their JobTread account) where the names differ. A family the
 * evaluator already scored on the site keeps the site's card.
 * dryRun: what would happen, nothing written.
 * → { matched: [{ child, id, name, total }], unmatched: [child], kept: [child], written }
 */
export async function importScores(DB, { year, evaluator, name = null, rows = [], dryRun = false, now = Date.now() } = {}) {
  await ensureScoreSchema(DB);
  const who = cleanEvaluator(evaluator);
  const y = cleanYear(year);
  if (!who) throw Object.assign(new Error('Whose scores are these? (their email)'), { status: 400 });
  if (!y) throw Object.assign(new Error('Which season?'), { status: 400 });
  if (!Array.isArray(rows) || !rows.length || rows.length > 200) throw Object.assign(new Error('No rows to bring in.'), { status: 400 });
  const key = (s) => normalizeName(String(s || '').replace(/&/g, ' and ')).split(' ').filter(Boolean).sort().join(' ');
  const { results } = await DB.prepare('SELECT account_id, name FROM applicants WHERE year = ? AND archived_at IS NULL').bind(y).all();
  const families = new Map();
  const byId = new Map();
  for (const r of results || []) {
    const k = key(r.name);
    families.set(k, families.has(k) ? null : r); // two families with one name: ask, don't guess
    byId.set(r.account_id, r);
  }
  const out = { matched: [], unmatched: [], kept: [], written: 0 };
  for (const row of rows) {
    const scores = {};
    for (const k of keysOf(SHEET_RUBRIC)) { const n = sheetScore(row?.scores?.[k]); if (n != null) scores[k] = n; }
    const fam = row?.id ? byId.get(String(row.id)) : families.get(key(row?.child));
    if (!fam) { out.unmatched.push(String(row?.child || '')); continue; }
    const there = await DB.prepare('SELECT source FROM applicant_scores WHERE account_id = ? AND evaluator = ?').bind(fam.account_id, who).first();
    if (there && there.source !== 'sheet') { out.kept.push(String(row.child)); continue; }
    const total = totalOf(scores, SHEET_RUBRIC);
    out.matched.push({ child: String(row.child), id: fam.account_id, name: fam.name, total, tier: tierOf(total)?.id || null });
    if (dryRun) continue;
    await DB.prepare(`INSERT INTO applicant_scores (account_id, evaluator, evaluator_name, scores, notes, rubric, source, created_at, updated_at, completed_at)
      VALUES (?, ?, ?, ?, ?, ?, 'sheet', ?, ?, ?)
      ON CONFLICT(account_id, evaluator) DO UPDATE SET evaluator_name = excluded.evaluator_name, scores = excluded.scores, notes = excluded.notes,
        rubric = excluded.rubric, source = 'sheet', updated_at = excluded.updated_at, completed_at = excluded.completed_at`)
      .bind(fam.account_id, who, name, JSON.stringify(scores), String(row.notes || '').slice(0, NOTES_MAX) || null, SHEET_RUBRIC, iso(now), iso(now), isComplete(scores, SHEET_RUBRIC) ? iso(now) : null).run();
    out.written++;
  }
  return out;
}
