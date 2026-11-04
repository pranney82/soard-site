/**
 * The families who applied, for the board page: to read, never to change
 * ===========================================================================
 * Peter, Nov 4 2026: "names and scores are in the applications admin, board
 * can have access to it, maybe we should build a way for them to see this
 * information in a read only type thing". Applicants (staff) stays where
 * families are decided, messaged and scored; the board page reads the same
 * mirror (D1 applicants, ./_applicants.js) and the same scorecards
 * (./_applicant-scores.js), so the two never disagree.
 *
 *   list    every family and organization not archived and not a test run:
 *           name, season, status, what they asked for, county, when they
 *           applied, its kid page once public, and the score (ranked once
 *           everyone scoring the season has finished their card)
 *   one     the same, with the facts the score rests on (diagnosis, age,
 *           mobility, speech, language, who referred them, qualified, a
 *           denial's reason) and each scorer's card, criterion by criterion
 *
 * Never on the board page: how to reach the family (emails, phones, street
 * address), their messages with SOARD, their files, or a scorer's notes.
 */

import { listApplicants, getApplicantRow } from './_applicants.js';
import { scoreSummaries, familyScores } from './_applicant-scores.js';

const isTest = (a) => !!a.isTest || /^\s*test\b/i.test(String(a.name || ''));
// Cloudflare Images only: imagedelivery.net, or through the site (the way People's photos are kept: a crop's trim=a;b;c;d)
const photoOf = (url) => (/^(https:\/\/imagedelivery\.net\/|(https:\/\/sunshineonaranneyday\.com)?\/cdn-cgi\/imagedelivery\/)[\w/=,.;-]+$/.test(String(url || '')) ? String(url) : null);

/** Whole years from a birthday ("2017-03-04") to today, or null */
export function ageFrom(birthday, now = Date.now()) {
  const m = String(birthday || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const d = new Date(now);
  let age = d.getUTCFullYear() - Number(m[1]);
  if (d.getUTCMonth() + 1 < Number(m[2]) || (d.getUTCMonth() + 1 === Number(m[2]) && d.getUTCDate() < Number(m[3]))) age -= 1;
  return age >= 0 && age < 120 ? age : null;
}

const scoreOf = (s) => (s && (s.count || s.started?.length) ? {
  total: s.total ?? null, tier: s.tier || null, ranked: !!s.ranked, count: s.count || 0, of: s.of || 0,
  criteria: s.criteria || null, talk: s.talk || [], rubric: s.rubric || null,
} : null);

/** One family as the board's list has it */
function row(a, s) {
  // Its page, and a photo, once the page is public (a draft's child stays a name)
  const kid = a.kid && a.kid.slug && !a.kid.draft ? a.kid : null;
  return {
    id: a.id, name: String(a.name || '').trim(), kind: a.kind === 'organization' ? 'organization' : 'family',
    status: a.status || 'Applied', season: a.year || '', types: Array.isArray(a.types) ? a.types : [],
    county: a.county || '', city: a.city || '', area: a.area || '',
    applied: a.submittedAt || a.createdAt || null, stageAt: a.stageAt || null,
    ...(kid ? { page: kid.kind === 'community' ? `/community/${kid.slug}/` : `/kids/${kid.slug}/` } : {}),
    ...(kid && photoOf(a.photo) ? { photo: photoOf(a.photo) } : {}),
    score: scoreOf(s),
  };
}

/** Every family the board can read about, newest first → { families, at } */
export async function familiesList(env) {
  const [list, scores] = await Promise.all([listApplicants(env.DB), scoreSummaries(env.DB).catch(() => new Map())]);
  return { families: list.filter((a) => !isTest(a)).map((a) => row(a, scores.get(a.id))), at: new Date().toISOString() };
}

/** One family, read-only, with what their score rests on → { family } (404 for none, an archived one or a test) */
export async function familyOne(env, id, { now = Date.now() } = {}) {
  const a = await getApplicantRow(env.DB, id);
  if (!a || a.archivedAt || isTest(a)) throw Object.assign(new Error('That family isn’t on the board page'), { status: 404 });
  const sc = await familyScores(env.DB, id).catch(() => null);
  const f = a.fields || {};
  return {
    family: {
      ...row(a, sc?.summary ? { ...sc.summary, rubric: sc.rubric } : null),
      facts: {
        diagnosis: String(f.diagnosis || '').slice(0, 2000), age: ageFrom(f.birthday, now), gender: f.gender || '', language: f.language || '',
        verbal: f.verbal || '', mobile: f.mobile || '', qualified: f.qualified || '', referredBy: String(f.referredBy || '').slice(0, 200),
        ...(a.status === 'Denied' && f.denialReason ? { denialReason: String(f.denialReason).slice(0, 2000) } : {}),
      },
      rubric: sc?.rubric || null,
      // Each scorer's card: their name and scores, never their notes
      cards: (sc?.cards || []).map((c) => ({ name: c.name || nameFromEmail(c.evaluator), scores: c.scores, total: c.total, complete: !!c.complete, done: c.done, rubric: c.rubric, at: c.completedAt || c.updatedAt || null })),
      visited: !!sc?.visited,
    },
  };
}

/** "sam.lee@soardcharity.com" → "Sam Lee" (a card saved before names were kept) */
export function nameFromEmail(email) {
  const local = String(email || '').split('@')[0];
  return local.split(/[._-]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ') || 'A scorer';
}
