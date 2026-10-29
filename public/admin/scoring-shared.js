/**
 * The makeover scoring rubric, shared by the admin (./applicants.js) and the
 * server (functions/api/_applicant-scores.js)
 * ===========================================================================
 * SOARD scores each makeover application on 10 criteria, 1 to 5 each, 50
 * points in all. Every evaluator scores on their own; the family's score is
 * the average of their totals, to one decimal (Peter, Oct 29 2026: the
 * spreadsheet rounded each criterion's average first, which moved 5 of the 12
 * families in 2026 by a point or more and one of them down a tier).
 *
 * Two versions of the rubric:
 *  1. The 2026 "SOARD Makeover Scoring System" spreadsheet's (System
 *     Background and Scoring Definitions tabs), word for word. The 2026 season
 *     was scored with it.
 *  2. From the 2027 season: Family readiness waits for the home visit, so
 *     everyone scores it from the same visit (it was where evaluators disagreed
 *     most in 2026), and Financial need takes the place of Mission & story
 *     (whether the family can pay is a fairness question; the spreadsheet had
 *     folded it into storytelling, and SOARD doesn't choose on story).
 * A scorecard keeps the version it started with; a season is scored on one.
 *
 * A scorecard counts once all 10 criteria have a score. One that's partway
 * done is saved, and waits.
 */

export const RUBRIC_VERSION = 2;
export const SHEET_RUBRIC = 1;
export const MIN = 1;
export const MAX = 5;
export const TOTAL_MAX = 50;

/**
 * The spreadsheet's 10 criteria, in its order: a label (and a one-word one for narrow
 * columns), what each asks (System Background),
 * what each score means (Scoring Definitions, 1 first) and, for two, a note on how to read it
 */
const SHEET_CRITERIA = [
  {
    key: 'mobility', short: 'Mobility', label: 'Mobility & independence', ask: 'The child’s mobility and independence needs',
    levels: [
      'Fully ambulatory; uses space independently',
      'Child is ambulatory but requires frequent assistance or close supervision to safely use the space.',
      'Uses assistive device or needs occasional help',
      'Child has very limited mobility and requires significant assistance for most movement and transfers but is not fully dependent.',
      'Non-ambulatory or fully dependent for transfers/toileting',
    ],
  },
  {
    key: 'safety', short: 'Safety', label: 'Safety risk', ask: 'Safety risks in the current space',
    levels: [
      'Minor inconvenience; no clear safety hazards',
      'Minor safety concerns exist, but risks are intermittent and generally manageable with supervision.',
      'Ongoing safety concerns (falls, tight access, difficult transfers)',
      'Serious safety risks exist that frequently impact daily use, though they are not immediately life-threatening.',
      'Immediate/severe hazards; high fall risk or unsafe lifting required',
    ],
  },
  {
    key: 'medical', short: 'Medical', label: 'Medical necessity', ask: 'Medical necessity of the renovation',
    levels: [
      'Primarily convenience/comfort; not medically required',
      'Improvements would support comfort or ease of care but are not medically required.',
      'Supports daily care but not medically urgent',
      'Renovation strongly supports medical care or hygiene and is close to being medically essential.',
      'Essential for hygiene, transfers, equipment use, or health outcomes',
    ],
  },
  {
    key: 'caregiver', short: 'Caregiver', label: 'Caregiver burden', ask: 'Reduction in caregiver burden',
    levels: [
      'Would not meaningfully change caregiving effort',
      'Would reduce some inconvenience or minor physical strain for caregivers.',
      'Moderate workflow improvement; reduces some strain',
      'Would significantly reduce physical strain or time burden but would not eliminate major lifting or transfers.',
      'Major reduction in lifting/transfers/time burden',
    ],
  },
  {
    key: 'longevity', short: 'Longevity', label: 'Longevity of impact', ask: 'Longevity of benefit for the child',
    levels: [
      'Short-term benefit (<2 years)',
      'Expected to benefit the child for approximately 2–3 years.',
      'Medium-term benefit (3–5 years)',
      'Expected to benefit the child for 5+ years but may require future modifications.',
      'Long-term/lifelong benefit (5+ years)',
    ],
  },
  {
    key: 'severity', short: 'Severity', label: 'Severity of diagnosis', ask: 'Severity and complexity of diagnosis and needs',
    levels: [
      'Mild needs; low support required',
      'Diagnosis requires occasional or situational support, with generally stable daily needs.',
      'Multiple needs or moderate daily support',
      'Diagnosis involves high daily care needs or progressive challenges but is not the most medically complex.',
      'High medical complexity; intensive daily care required',
    ],
  },
  {
    key: 'feasibility', short: 'Feasibility', label: 'Project feasibility', ask: 'Feasibility of the project',
    levels: [
      'Major barriers; likely outside scope/very hard',
      'Significant challenges exist that may impact timeline, cost, or scope.',
      'Moderate challenges but manageable',
      'Minor challenges exist but are unlikely to significantly impact cost or timeline.',
      'Straightforward and clearly within SOARD scope',
    ],
  },
  {
    key: 'structural', short: 'Structure', label: 'Structural / technical risk', ask: 'Structural and technical risk', note: 'Higher means fewer problems: a 5 is standard build conditions.',
    levels: [
      'Significant structural/electrical/plumbing concerns',
      'Noticeable concerns exist that may require additional assessment or specialty work.',
      'Some concerns but solvable with typical construction',
      'Small technical issues are present but easily addressed within a standard renovation.',
      'No major red flags; standard build conditions',
    ],
  },
  {
    key: 'readiness', short: 'Readiness', label: 'Family readiness', ask: 'Family readiness and partnership potential',
    levels: [
      'Poor responsiveness; unclear ownership/HOA barriers',
      'Family is willing but has communication, logistical, or readiness challenges.',
      'Generally cooperative with some obstacles',
      'Family is engaged and cooperative, with only minor barriers or delays anticipated.',
      'Highly responsive; organized; realistic expectations; ready to proceed',
    ],
  },
  {
    key: 'mission', short: 'Mission', label: 'Mission & story', ask: 'Alignment with SOARD’s mission and storytelling impact', note: 'Include the family’s ability to afford the makeover in this one.',
    levels: [
      'Limited mission fit or unclear transformation',
      'Project aligns with SOARD’s mission, but transformation or storytelling impact is limited.',
      'Strong mission fit and meaningful improvement',
      'Project strongly aligns with SOARD’s mission and presents a compelling transformation, though not among the most powerful stories.',
      'Clear, powerful transformation aligned with core mission',
    ],
  },
];
const sheet = Object.fromEntries(SHEET_CRITERIA.map((c) => [c.key, c]));

/** From 2027: readiness after the home visit (`after: 'visit'`), Financial need in place of Mission & story */
const CRITERIA_2 = [
  ...SHEET_CRITERIA.filter((c) => c.key !== 'readiness' && c.key !== 'mission'),
  { ...sheet.readiness, after: 'visit', note: 'Scored after the home visit, so everyone scores it from the same visit.' },
  {
    key: 'financial', short: 'Finances', label: 'Financial need', ask: 'Whether the family could pay for the renovation without SOARD',
    levels: [
      'Family could pay, or insurance or another program would',
      'Family could cover most of the cost, though it would be a stretch.',
      'Family could cover part of the cost, with real hardship',
      'Family could cover only a small part of the cost, and only with serious hardship.',
      'No realistic way to pay for it without SOARD',
    ],
  },
];

export const RUBRICS = { 1: SHEET_CRITERIA, 2: CRITERIA_2 };
export const criteriaOf = (version) => RUBRICS[version] || RUBRICS[RUBRIC_VERSION];
export const keysOf = (version) => criteriaOf(version).map((c) => c.key);
/** The rubric new scorecards use */
export const CRITERIA = criteriaOf(RUBRIC_VERSION);
export const CRITERION_KEYS = keysOf(RUBRIC_VERSION);
/** The 2026 season (and any before it) was scored with the spreadsheet; later ones with the current rubric */
export const rubricOfSeason = (year) => (Number(year) && Number(year) <= 2026 ? SHEET_RUBRIC : RUBRIC_VERSION);

/** The priority tiers, highest first: a score of `min` or more is in that tier */
export const TIERS = [
  { id: 'high', label: 'High Priority', min: 40, range: '40–50 points', hint: 'Projects with critical safety or medical need and strong feasibility' },
  { id: 'strong', label: 'Strong Candidate', min: 30, range: '30–39 points', hint: 'High-impact projects considered as capacity and funding allow' },
  { id: 'lower', label: 'Lower Priority', min: 20, range: '20–29 points', hint: 'Projects that may be deferred or reconsidered later' },
  { id: 'stop', label: 'Do Not Proceed', min: 0, range: 'Below 20 points', hint: 'Projects outside current scope or capacity' },
];
export const tierOf = (total) => (total == null || !Number.isFinite(Number(total)) ? null : TIERS.find((t) => Number(total) >= t.min) || TIERS[TIERS.length - 1]);
export const tierById = (id) => TIERS.find((t) => t.id === id) || null;

/** Two evaluators this far apart on one criterion is worth a conversation */
export const TALK_GAP = 3;

/** A whole number from 1 to 5, or null */
export function cleanScore(v) {
  const n = Number(v);
  return Number.isInteger(n) && n >= MIN && n <= MAX ? n : null;
}

/** Only the rubric's criteria, each 1 to 5 (anything else is dropped) */
export function cleanScores(input, version = RUBRIC_VERSION) {
  const out = {};
  for (const k of keysOf(version)) {
    const n = cleanScore(input?.[k]);
    if (n != null) out[k] = n;
  }
  return out;
}

export const scoredCount = (scores, version = RUBRIC_VERSION) => keysOf(version).filter((k) => cleanScore(scores?.[k]) != null).length;
export const isComplete = (scores, version = RUBRIC_VERSION) => scoredCount(scores, version) === keysOf(version).length;

/** One evaluator's total, once every criterion has a score (else null) */
export function totalOf(scores, version = RUBRIC_VERSION) {
  if (!isComplete(scores, version)) return null;
  return keysOf(version).reduce((n, k) => n + cleanScore(scores[k]), 0);
}

/** To one decimal, halves up */
const tenth = (x) => Math.round(x * 10 + 1e-9) / 10;
const mean = (vals) => vals.reduce((n, v) => n + v, 0) / vals.length;
/** 47 → "47", 46.6667 → "46.7", nothing → "–" */
export const fmtScore = (n) => (n == null || !Number.isFinite(Number(n)) ? '–' : Number.isInteger(Number(n)) ? String(Number(n)) : Number(n).toFixed(1));

/**
 * The family's score from its scorecards ([{ scores, rubric }]): the average of
 * the finished cards' totals, to one decimal. → null when none is finished, else
 * { total, tier, count, rubric, criteria: { key: average, to one decimal },
 *   range: { key: [low, high] }, totals: [each evaluator's total], talk: [keys where evaluators are TALK_GAP or more apart] }
 */
export function combine(cards) {
  const done = (cards || []).filter((c) => isComplete(c?.scores, c?.rubric ?? RUBRIC_VERSION));
  if (!done.length) return null;
  const rubric = done[0].rubric ?? RUBRIC_VERSION;
  const criteria = {};
  const range = {};
  const talk = [];
  for (const k of keysOf(rubric)) {
    const vals = done.map((c) => cleanScore(c.scores[k])).filter((v) => v != null);
    if (!vals.length) continue;
    criteria[k] = tenth(mean(vals));
    range[k] = [Math.min(...vals), Math.max(...vals)];
    if (range[k][1] - range[k][0] >= TALK_GAP) talk.push(k);
  }
  const totals = done.map((c) => totalOf(c.scores, c.rubric ?? RUBRIC_VERSION));
  const total = tenth(mean(totals));
  return { total, tier: tierOf(total).id, count: done.length, rubric, criteria, range, totals, talk };
}
