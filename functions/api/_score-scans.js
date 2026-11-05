/**
 * Scanned scoresheets: PDFs and photos of makeover scorecards, read into scorecards
 * ===========================================================================
 * Admin → Applications → Applicants → Scores takes a PDF or photos of
 * scoresheets: a scoring sheet's tab printed to PDF (one scorer, a row per
 * family), scanned paper, a phone picture of handwritten notes, or SOARD's own
 * printed scoresheet (public/admin/score-scans.js prints it, with a code for
 * the family). The browser turns each page into a picture, with its typed text
 * when it has some, and sends the pages one at a time to ./score-scans-admin.js.
 * Each page is read here, and what's sure is saved as that scorer's card.
 *
 * Sure means all of:
 *  - two vision models from different makers (READERS) read the page on their
 *    own and agree on every score;
 *  - every score is a whole number from 1 to 5; a total written on the sheet is
 *    what they add up to; the criteria printed on it are the family's rubric's
 *    (2026's Mission & story never stands in for 2027's Financial need);
 *  - the family is exactly one of the season's, by its printed code or its
 *    name exactly (the JobTread job's name and nickname count; a near miss
 *    like Mia for Mya only suggests);
 *  - the scorer is exactly one of SOARD's Google accounts by the name on the
 *    sheet (or whoever the uploader said), and someone who has scored before or
 *    is the uploader, so a misread name can't put a new person on a season's
 *    panel and hold up every family's ranking;
 *  - the scorer has no card for the family yet. One that says the same is
 *    left as it is; one that says something else (typed on the site, brought
 *    over from the spreadsheet, another scan) is never replaced without a person.
 * The models only report what's written; every check is plain code here, so a
 * misread can't argue its way into a score. Anything short of sure waits
 * under "Check these" with the page beside it.
 *
 * From 2027, Family readiness is scored after the home visit: read before the
 * visit has happened, it's held (dropped) and goes onto the card once it has
 * (applyHeld, whenever the admin loads the season).
 *
 * D1: score_scans (one upload: season, file, who, undone or not) and
 * score_scan_items (one scoresheet from one page: what each reader saw, what
 * was saved or why it waits, and the card it replaced, for undo). A page with
 * no scoresheet (a cover, the rubric, an averages page) is one 'empty' item.
 * Page pictures are in VENDOR_FILES (soard-vendor-docs, the bucket with no
 * public address) at scoresheets/<season>/<scan>/<page>.jpg, never FILES,
 * which files.sunshineonaranneyday.com serves to anyone with the address:
 * they show children's names and needs. Only the admin's endpoint hands them out.
 */

import { RUBRICS, criteriaOf, keysOf, rubricOfSeason, cleanScore, totalOf } from '../../public/admin/scoring-shared.js';
import { ensureScoreSchema, cleanEvaluator, saveScannedCard, restoreScannedCard, applyHeldScores, familySummary, homeVisited } from './_applicant-scores.js';
import { normalizeName } from './_reveals.js';
import { staffDirectory } from './_staff-access.js';
import { isTestFamily } from './_applicant-approved.js';

/**
 * Two vision models from different makers, so one's habits can't fool both,
 * each with its thinking turned down: a scoresheet needs reading, not reasoning,
 * and thinking spends the time and tokens the answer needs
 */
export const READERS = {
  '@cf/moonshotai/kimi-k2.6': { chat_template_kwargs: { thinking: false } },
  '@cf/qwen/qwen3.8-27b': { reasoning_effort: 'low' },
};
const AI_TIMEOUT_MS = 60000;
export const MAX_PAGES = 150;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const CLAIM_IDX = -1; // the row that says a page is being read (its sheets are 0, 1, 2…)
const SAVING_MS = 2 * 60 * 1000; // a sheet locked for saving frees itself after this, if that save was cut off
const CLAIM_MS = 5 * 60 * 1000; // a page being read is someone else's this long (longer than three tries of both readers)
const TEXT_MAX = 8000;

/** Private storage for page pictures: never FILES (public) */
const privateFiles = (env) => env?.VENDOR_FILES || null;

const iso = (t = Date.now()) => new Date(t).toISOString();
const parse = (s, d = null) => { try { return s == null ? d : JSON.parse(s); } catch { return d; } };
const cut = (s, n) => String(s ?? '').trim().slice(0, n);
const cleanYear = (y) => (/^20\d\d$/.test(String(y || '')) ? String(y) : null);
const err = (message, status = 400, extra = {}) => Object.assign(new Error(message), { status, ...extra });

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS score_scans (
    id TEXT PRIMARY KEY, year TEXT NOT NULL, file_name TEXT, file_hash TEXT, pages INTEGER NOT NULL DEFAULT 0,
    for_account TEXT, for_scorer TEXT, uploaded_by TEXT, created_at TEXT NOT NULL, undone_at TEXT, undone_by TEXT)`,
  'CREATE INDEX IF NOT EXISTS idx_score_scans_year ON score_scans(year, created_at)',
  `CREATE TABLE IF NOT EXISTS score_scan_items (
    scan_id TEXT NOT NULL, page INTEGER NOT NULL, idx INTEGER NOT NULL, status TEXT NOT NULL,
    account_id TEXT, evaluator TEXT, evaluator_name TEXT, family_text TEXT, scorer_text TEXT, code TEXT,
    scores TEXT, notes TEXT, reads TEXT, problems TEXT, replaced TEXT, dropped TEXT, held_at TEXT, image_key TEXT,
    created_at TEXT NOT NULL, saved_at TEXT, saved_by TEXT, seq INTEGER,
    PRIMARY KEY (scan_id, page, idx))`,
  'CREATE INDEX IF NOT EXISTS idx_score_scan_items_status ON score_scan_items(status)',
];
const _ready = new WeakSet();
export async function ensureScanSchema(DB) {
  if (_ready.has(DB)) return;
  await ensureScoreSchema(DB);
  await DB.batch(SCHEMA.map((sql) => DB.prepare(sql)));
  _ready.add(DB);
}

// ─── Every criterion any rubric has, for reading ──────────────────────

/** The criteria of every rubric version, each once, in rubric order (a sheet may be on either) */
export const ALL_CRITERIA = (() => {
  const seen = new Map();
  for (const v of Object.keys(RUBRICS).map(Number).sort()) for (const c of criteriaOf(v)) if (!seen.has(c.key)) seen.set(c.key, c);
  return [...seen.values()];
})();
const ALL_KEYS = ALL_CRITERIA.map((c) => c.key);

/** How a criterion that only one rubric has is printed: 2026's Mission & story, 2027's Financial need */
const PRINTED = { mission: /mission|story|storytell/i, financial: /financ|afford|\bpay\b|cost|income|money/i };

// ─── What a reader is asked ───────────────────────────────────────────

export const READ_PROMPT = `You read makeover scoresheets for SOARD, a nonprofit that renovates rooms for children with disabilities.
A scoresheet is one scorer's scores for one family: a whole number from 1 to 5 for each criterion below.
A page may hold one scoresheet (a form for one family), several (a table with a row per family, or notes for several families), or none.

The criteria (key: its name, and a short name it may be written as):
${ALL_CRITERIA.map((c) => `- ${c.key}: ${c.label} (${c.short})`).join('\n')}

Report only what is written or marked on the page. Never guess, never fill in, never add anything up.
- labels: every criterion name as it is printed or written on the page, word for word, once each.
- A number that is circled, checked, ticked, filled in, highlighted or written beside a criterion is its score. Put it under the key of the criterion it is beside; a criterion the page doesn't have is 0.
- Give 0 for a criterion that is missing, unclear, crossed out with nothing clearly in its place, marked between two numbers, or marked twice.
- family: the child's or family's name exactly as written ("" if the sheet doesn't say).
- scorer: who scored this sheet as written: a name, initials or a signature ("" if it doesn't say). A page heading such as "Evaluator: Pat Lee" is the scorer of every sheet on the page.
- code: a printed code such as "S27-4F7KQ" ("" if there's none).
- total: a total written on the sheet (0 if there's none). Don't work it out yourself.
- notes: anything else the scorer wrote about the family, word for word ("" if nothing).
- No sheets for a cover page, instructions, the rubric itself, a blank form, or a page of averages or totals from several scorers.
- Skip header rows, average rows and example rows.
Answer with JSON only.`;

const SCORE_PROPS = Object.fromEntries(ALL_KEYS.map((k) => [k, { type: 'integer' }]));
export const READ_SCHEMA = {
  type: 'object',
  properties: {
    labels: { type: 'array', items: { type: 'string' } },
    sheets: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          family: { type: 'string' },
          scorer: { type: 'string' },
          code: { type: 'string' },
          total: { type: 'integer' },
          notes: { type: 'string' },
          // Workers AI's JSON mode drops what isn't required: everything is
          scores: { type: 'object', properties: SCORE_PROPS, required: ALL_KEYS },
        },
        required: ['family', 'scorer', 'code', 'total', 'notes', 'scores'],
      },
    },
  },
  required: ['labels', 'sheets'],
};

function withTimeout(p, ms) {
  let timer;
  return Promise.race([p, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), ms); })]).finally(() => clearTimeout(timer));
}

/** The model's answer as an object, whichever shape it came back in */
function answerOf(out) {
  const r = out?.response ?? out?.choices?.[0]?.message?.content ?? out;
  if (r && typeof r === 'object' && !Array.isArray(r)) return r;
  const m = String(r || '').match(/\{[\s\S]*\}/);
  try { return m ? JSON.parse(m[0]) : null; } catch { return null; }
}

/** One model's reading of a page → { sheets, labels } (cleaned), or null when it didn't answer */
export async function readWith(env, model, { image, text = '' }) {
  const content = [
    { type: 'text', text: text ? `Read the scoresheets on this page. Its typed text, exactly as the PDF has it (it may be partial):\n${cut(text, TEXT_MAX)}` : 'Read the scoresheets on this page.' },
    { type: 'image_url', image_url: { url: image } },
  ];
  const messages = [{ role: 'system', content: READ_PROMPT }, { role: 'user', content }];
  const extra = READERS[model] || {};
  // JSON mode first; then plain; then without the thinking setting, in case the model won't take it
  for (const [json, opts] of [[true, extra], [false, extra], [false, {}]]) {
    try {
      const out = await withTimeout(env.AI.run(model, {
        messages, max_tokens: 4000, temperature: 0, ...opts,
        ...(json ? { response_format: { type: 'json_schema', json_schema: READ_SCHEMA } } : {}),
      }), AI_TIMEOUT_MS);
      const a = answerOf(out);
      if (a && Array.isArray(a.sheets)) return { sheets: cleanSheets(a.sheets), labels: cleanLabels(a.labels) };
    } catch (e) {
      console.error('[score-scans]', model, e.message);
      if (/429|rate|capacity/i.test(e.message)) await new Promise((r) => setTimeout(r, 4000));
    }
  }
  return null;
}

const cleanLabels = (labels) => (Array.isArray(labels) ? labels : []).map((l) => cut(l, 80)).filter(Boolean).slice(0, 40);

/** A reader's sheets, trusted for nothing: names trimmed, scores 1 to 5 or null, a total or null */
export function cleanSheets(sheets) {
  return (Array.isArray(sheets) ? sheets : []).slice(0, 60).map((s) => {
    const scores = {};
    for (const k of ALL_KEYS) scores[k] = cleanScore(s?.scores?.[k]);
    const total = Number(s?.total);
    return {
      family: cut(s?.family, 120), scorer: cut(s?.scorer, 120), code: cut(s?.code, 24).toUpperCase(), notes: cut(s?.notes, 2000),
      total: Number.isInteger(total) && total > 0 && total <= 100 ? total : null, scores,
    };
  }).filter((s) => s.family || s.code || Object.values(s.scores).some((v) => v != null));
}

/** A reader's answer as { sheets, labels } (a bare list of sheets, from a test, too), cleaned whoever it came from; or null */
const asRead = (r) => (r == null ? null : Array.isArray(r) ? { sheets: cleanSheets(r), labels: [] } : { sheets: cleanSheets(r.sheets), labels: cleanLabels(r.labels) });

// ─── Two readings into one ────────────────────────────────────────────

const STOP = new Set(['and', 'the', 'family']);
const words = (s) => normalizeName(String(s || '').replace(/&/g, ' and ')).split(' ').filter((w) => w && !STOP.has(w));
/** How alike two written family names are, 0 to 1.25 */
function nameLikeness(a, b) {
  const x = words(a); const y = words(b);
  if (!x.length || !y.length) return 0;
  const shared = x.filter((w) => y.includes(w)).length;
  return shared / Math.max(x.length, y.length) + (x[0] === y[0] ? 0.25 : 0);
}

/**
 * Pair up the readers' sheets (by code, else by name, else by place on the
 * page) and say, for each, what they agree on.
 * reads: { [reader]: [sheet] | null } (null: that reader didn't answer).
 * → [{ family, scorer, code, total, notes, scores: { key: agreed value or null }, seen: { [reader]: sheet|null },
 *      disagree: [{ key, values: { reader: v } }], unread: [keys nobody could read], alone: bool }]
 */
export function mergeReads(reads) {
  const names = Object.keys(reads).filter((r) => reads[r]);
  if (!names.length) return [];
  // Every reader counts, answered or not: a sheet one of them never saw isn't agreed on
  const expected = Object.keys(reads).length;
  const [lead, ...rest] = [...names].sort((a, b) => reads[b].length - reads[a].length);
  const used = new Map(rest.map((r) => [r, new Set()]));
  const pick = (r, s, i) => {
    const list = reads[r];
    const free = list.map((t, j) => [t, j]).filter(([, j]) => !used.get(r).has(j));
    let best = null;
    if (s.code) best = free.find(([t]) => t.code && t.code === s.code) || null;
    if (!best) {
      const scored = free.map(([t, j]) => [t, j, nameLikeness(s.family, t.family)]).filter(([, , n]) => n >= 0.5).sort((a, b) => b[2] - a[2]);
      best = scored[0] || null;
    }
    if (!best && list.length === reads[lead].length && !s.family && !list[i]?.family) best = free.find(([, j]) => j === i) || null;
    if (!best) return null;
    used.get(r).add(best[1]);
    return best[0];
  };
  const out = reads[lead].map((s, i) => {
    const seen = { [lead]: s };
    for (const r of rest) seen[r] = pick(r, s, i);
    return combineSeen(seen, expected);
  });
  // A sheet only a later reader saw
  for (const r of rest) reads[r].forEach((t, j) => { if (!used.get(r).has(j)) out.push(combineSeen({ [r]: t }, expected)); });
  return out;
}

function combineSeen(seen, readers) {
  const all = Object.entries(seen).filter(([, s]) => s);
  const scores = {}; const disagree = []; const unread = [];
  for (const k of ALL_KEYS) {
    const values = Object.fromEntries(all.map(([r, s]) => [r, s.scores?.[k] ?? null]));
    const got = Object.values(values);
    if (got.every((v) => v == null)) { scores[k] = null; unread.push(k); continue; }
    const same = got.every((v) => v != null && v === got[0]);
    scores[k] = same ? got[0] : null;
    if (!same) disagree.push({ key: k, values });
  }
  const totals = all.map(([, s]) => s.total).filter((t) => t != null);
  const pickText = (f) => all.map(([, s]) => s[f]).find(Boolean) || '';
  // Who it's about and who scored it must be read alike too ("Owen Lee" isn't "Owen Lindgren")
  const alike = (f, norm) => all.every(([, s]) => norm(s[f]) === norm(all[0][1][f]));
  return {
    family: pickText('family'), scorer: pickText('scorer'), code: pickText('code'),
    familyDiffers: !alike('family', (x) => words(x).sort().join(' ')) || !alike('code', (x) => String(x || '').toUpperCase()),
    scorerDiffers: !alike('scorer', (x) => words(x).join(' ')),
    notes: all.every(([, s]) => s.notes) ? all[0][1].notes : '',
    total: totals.length && totals.every((t) => t === totals[0]) ? totals[0] : null,
    totalsDiffer: totals.length > 1 && !totals.every((t) => t === totals[0]),
    scores, seen, disagree, unread, alone: all.length < readers,
  };
}

// ─── Who the sheet is about, and who scored it ────────────────────────

/** The code printed on SOARD's scoresheet for a family: S + the season's last two digits + 5 characters from its account */
export function familyCode(year, accountId) {
  let h = 2166136261;
  for (const ch of `${year}:${accountId}`) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  const abc = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ'; // no 0/O, 1/I
  let s = '';
  for (let i = 0; i < 5; i++) { s += abc[h % 32]; h = Math.imul(h ^ (h >>> 13), 2654435761) >>> 0; }
  return `S${String(year).slice(2)}-${s}`;
}

const NICK = /(?:^|\s)["“”'‘’]([^"“”'‘’]+)["“”'‘’](?=\s|$)/;
const NICK_ALL = new RegExp(NICK.source, 'g');

/** The names a family may be written under: the account's, and the job's (without "(2027)", with a "nickname" as a first name) */
export function familyNames(f) {
  const out = [f.name];
  const job = String(f.jobName || '').replace(/\(\d{4}\)\s*$/, '').trim();
  if (job) {
    // A nickname is a word in quotes on its own ('Samuel "Sam" Reed'); De'Shawn and O'Neil aren't
    out.push(job.replace(NICK_ALL, ' ').replace(/\s+/g, ' ').trim());
    const nick = job.match(NICK);
    if (nick) out.push(`${nick[1]} ${job.split(/\s+/).at(-1)}`);
    out.push(job);
  }
  return [...new Set(out.filter(Boolean))];
}

/** One letter apart (Rowan / Rowen) */
function nearlySame(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1 || Math.min(a.length, b.length) < 3) return false;
  let i = 0; let j = 0; let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/**
 * How well a written name fits one of a family's names: 3 exactly (in any
 * order, or first and last), 2 a first name alone; under 2 only suggests (a
 * letter off, an initial, a first name that's somewhere in the name)
 */
function familyFit(written, name) {
  const w = words(written); const n = words(name);
  if (!w.length || !n.length) return 0;
  if ([...w].sort().join(' ') === [...n].sort().join(' ')) return 3;
  // "The Owen family", "Owen family": a surname
  if (w.length === 1 && /\bfamily\b/i.test(written)) return n.length > 1 && n.at(-1) === w[0] ? 2 : 0;
  const first = w[0]; const last = w.length > 1 ? w.at(-1) : null;
  const sharesLast = last && n.includes(last);
  if (last && sharesLast && n.includes(first)) return 3;
  if (!last && n[0] === first) return 2;
  if (last && sharesLast && nearlySame(first, n[0])) return 1.8;
  if (last && sharesLast && first[0] === n[0][0]) return 1.5;
  if (!last && n.includes(first)) return 1.4;
  if (!last && nearlySame(first, n[0])) return 1.2;
  return 0;
}

/**
 * The family a sheet is about, among the season's: by its printed code, else
 * a name that fits exactly (2 or more) when no other family fits as well.
 * → { family | null, candidates: [{ id, name, fit }] best first }
 */
export function matchFamily({ family, code }, families, year) {
  const scored = families.map((f) => ({ f, fit: Math.max(0, ...familyNames(f).map((n) => familyFit(family, n))) }))
    .filter((x) => x.fit > 0).sort((a, b) => b.fit - a.fit);
  if (code) {
    const hits = families.filter((f) => familyCode(year, f.id) === code);
    if (hits.length === 1) {
      const hit = hits[0];
      // A name written beside the code has to be that family's too: the two disagreeing is a person's call
      const named = words(family).length ? scored.find((x) => x.f.id === hit.id)?.fit || 0 : 3;
      const candidates = [{ id: hit.id, name: hit.name, fit: 3 }, ...scored.filter((x) => x.f.id !== hit.id).slice(0, 5).map((x) => ({ id: x.f.id, name: x.f.name, fit: x.fit }))];
      return { family: named >= 2 ? hit : null, candidates };
    }
  }
  const [top, next] = scored;
  // One word ("Owen") that's someone's first name and someone else's surname: a person's call
  const sure = top && top.fit >= 2 && !(next && (next.fit >= 2 || (top.fit < 3 && next.fit > 0)));
  return { family: sure ? top.f : null, candidates: scored.slice(0, 6).map((x) => ({ id: x.f.id, name: x.f.name, fit: x.fit })) };
}

/**
 * The scorer a sheet names, among SOARD's people ([{ email, name }]): a full
 * name, a first name, a first name and last initial ("Christian N."), an
 * initial and last name ("C. Cunningham"), or the email's own name ("linzi").
 * Only when exactly one person fits. → person | null
 */
export function matchScorer(written, people) {
  const w = words(written);
  if (!w.length) return null;
  const fits = people.filter((p) => {
    const n = words(p.name); const local = String(p.email || '').split('@')[0].toLowerCase();
    if (!n.length) return w.length === 1 && w[0] === local;
    const [first] = n; const last = n.length > 1 ? n.at(-1) : '';
    if (w.length === 1) return w[0] === first || w[0] === local;
    const [a] = w; const z = w.at(-1);
    if (a === first && (z === last || (last && last.startsWith(z)))) return true;
    if (a.length === 1 && a === first[0] && z === last) return true;
    return false;
  });
  if (fits.length !== 1) return null;
  // One name that starts someone else's too ("Chris" and Christian): a person's call
  if (w.length === 1 && people.some((p) => p !== fits[0] && (words(p.name)[0] || '').startsWith(w[0]))) return null;
  return fits[0];
}

/**
 * SOARD's people who can score: the active Google accounts by their main
 * address (a suspended one never matches a sheet), with the aliases they may
 * sign in with. scored: they've finished a card for a real family before (not a
 * TEST family, not an archived one). Until the Google list has been read once,
 * whoever has scored before stands in for it.
 * → { people: [{ email, name, aliases, scored }], main(email) → main address }
 */
export async function scorers(DB) {
  const out = new Map();
  const alias = new Map();
  // A failed read of the Google list fails the step (never a guess that lets a suspended account through)
  const dir = await staffDirectory(DB);
  for (const a of dir) {
    if (!a.email) continue;
    const aliases = (a.aliases || []).map((x) => String(x).toLowerCase());
    for (const x of [a.email, ...aliases]) alias.set(x, a.email);
    if (a.active) out.set(a.email, { email: a.email, name: a.name || '', aliases, scored: false });
  }
  await ensureScoreSchema(DB);
  let rows = [];
  try {
    rows = (await DB.prepare(`SELECT s.evaluator, s.evaluator_name, s.completed_at, a.name AS a_name, a.archived_at AS a_archived
      FROM applicant_scores s LEFT JOIN applicants a ON a.account_id = s.account_id`).all()).results || [];
  } catch {
    rows = (await DB.prepare('SELECT evaluator, evaluator_name, completed_at FROM applicant_scores').all().catch(() => ({ results: [] }))).results || [];
  }
  for (const r of rows) {
    const main = alias.get(r.evaluator) || r.evaluator;
    const real = !!r.completed_at && !r.a_archived && !isTestFamily(r.a_name);
    if (!out.has(main)) {
      if (dir.length) continue; // not an active account: never matched to a sheet
      out.set(main, { email: main, name: r.evaluator_name || '', aliases: [], scored: false });
    }
    const p = out.get(main);
    if (real) p.scored = true;
    if (!p.name && r.evaluator_name) p.name = r.evaluator_name;
  }
  return { people: [...out.values()], main: (email) => alias.get(String(email || '').toLowerCase()) || cleanEvaluator(email) };
}

/** The address a person's card for a family is under: an alias they signed in with, if that's where it is */
async function cardAddress(DB, accountId, person) {
  const addrs = [person.email, ...(person.aliases || [])];
  const row = await DB.prepare(`SELECT evaluator FROM applicant_scores WHERE account_id = ? AND evaluator IN (${addrs.map(() => '?').join(',')}) ORDER BY evaluator = ? DESC LIMIT 1`)
    .bind(accountId, ...addrs, person.email).first();
  return row?.evaluator || person.email;
}

/** The season's families (not community projects, not archived): [{ id, name, jobName, status }] */
export async function seasonFamilies(DB, year) {
  let rows = [];
  try {
    rows = (await DB.prepare(`SELECT a.account_id, a.name, a.job_name, a.status FROM applicants a
      WHERE a.year = ? AND a.archived_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM applications p WHERE p.jt_account_id = a.account_id AND p.kind = 'organization')`).bind(year).all()).results || [];
  } catch {
    rows = (await DB.prepare('SELECT account_id, name, job_name, status FROM applicants WHERE year = ? AND archived_at IS NULL').bind(year).all().catch(() => ({ results: [] }))).results || [];
  }
  return rows.map((r) => ({ id: r.account_id, name: r.name, jobName: r.job_name || '', status: r.status || '' }));
}

// ─── An upload ────────────────────────────────────────────────────────

const newId = () => [...crypto.getRandomValues(new Uint8Array(12))].map((b) => 'abcdefghijkmnpqrstuvwxyz23456789'[b % 32]).join('');

/**
 * Start an upload: { year, name, hash (SHA-256 of the file), pages, account? (from a family's Score tab),
 * scorer? (an email: "these are all theirs"), again?, resume? (the id of an upload that stopped partway) }.
 * The same file already added that season (and not undone) comes back as duplicate,
 * with how far it got, unless again is set. → { scan } | { duplicate }
 */
export async function startScan(DB, { year, name, hash, pages, account = null, scorer = null, again = false, resume = null }, { user, now = Date.now() } = {}) {
  await ensureScanSchema(DB);
  if (resume) {
    const s = await DB.prepare('SELECT * FROM score_scans WHERE id = ? AND undone_at IS NULL').bind(String(resume)).first();
    if (!s) throw err('That upload isn’t there any more.', 404);
    const { results } = await DB.prepare(`SELECT DISTINCT page FROM score_scan_items i WHERE scan_id = ? AND idx >= 0 AND status != 'failed'
      AND NOT EXISTS (SELECT 1 FROM score_scan_items c WHERE c.scan_id = i.scan_id AND c.page = i.page AND c.idx = ${CLAIM_IDX})`).bind(s.id).all();
    return { scan: { id: s.id, year: s.year, pages: s.pages, done: (results || []).map((r) => r.page) } };
  }
  const y = cleanYear(year);
  if (!y) throw err('Which season are these for?');
  const n = Number(pages);
  if (!Number.isInteger(n) || n < 1) throw err('That file has no pages.');
  if (n > MAX_PAGES) throw err(`That file has ${n} pages; split it into files of ${MAX_PAGES} or fewer.`, 413);
  const forScorer = scorer ? (await scorers(DB)).people.find((p) => p.email === cleanEvaluator(scorer) || p.aliases?.includes(cleanEvaluator(scorer))) : null;
  if (scorer && !forScorer) throw err('Pick one of SOARD’s people as the scorer.');
  const h = /^[a-f0-9]{64}$/.test(String(hash || '')) ? String(hash) : null;
  if (h && !again) {
    const dup = await DB.prepare('SELECT * FROM score_scans WHERE year = ? AND file_hash = ? AND undone_at IS NULL ORDER BY created_at DESC LIMIT 1').bind(y, h).first();
    if (dup) {
      const read = (await DB.prepare(`SELECT COUNT(DISTINCT page) AS n FROM score_scan_items i WHERE scan_id = ? AND idx >= 0 AND status != 'failed'
        AND NOT EXISTS (SELECT 1 FROM score_scan_items c WHERE c.scan_id = i.scan_id AND c.page = i.page AND c.idx = ${CLAIM_IDX})`).bind(dup.id).first())?.n || 0;
      // Being read now: a page claimed, or pages still coming in within the last two minutes
      const busy = await DB.prepare('SELECT 1 AS x FROM score_scan_items WHERE scan_id = ? AND ((idx = ? AND created_at > ?) OR created_at > ?) LIMIT 1')
        .bind(dup.id, CLAIM_IDX, iso(now - CLAIM_MS), iso(now - 2 * 60 * 1000)).first();
      return { duplicate: { id: dup.id, name: dup.file_name, by: dup.uploaded_by, at: dup.created_at, pages: dup.pages, read, reading: !!busy && read < dup.pages } };
    }
  }
  const id = newId();
  await DB.prepare(`INSERT INTO score_scans (id, year, file_name, file_hash, pages, for_account, for_scorer, uploaded_by, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, y, cut(name, 200) || 'Scoresheets', h, n, cut(account, 40) || null, forScorer?.email || null, cleanEvaluator(user), iso(now)).run();
  return { scan: { id, year: y, pages: n, done: [] } };
}

const imageBytes = (dataUrl) => {
  const m = String(dataUrl || '').match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/=]+)$/);
  if (!m) return null;
  let bin;
  try { bin = atob(m[2]); } catch { return null; }
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { bytes, type: `image/${m[1]}` };
};
export const pageKey = (year, scan, page) => `scoresheets/${year}/${scan}/${page}.jpg`;
async function keptPicture(bucket, key) {
  const obj = await bucket.get(key);
  if (!obj) return null;
  return { bytes: new Uint8Array(await obj.arrayBuffer()), type: obj.httpMetadata?.contentType || 'image/jpeg' };
}
function dataUrlOf({ bytes, type }) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${type};base64,${btoa(bin)}`;
}

/** The criteria a family can't be scored on yet: from 2027, readiness until the home visit */
async function laterKeys(DB, family, rubric) {
  const after = criteriaOf(rubric).filter((c) => c.after === 'visit').map((c) => c.key);
  if (!after.length || !family) return [];
  return (await homeVisited(DB, family.id)) ? [] : after;
}

/** What a sheet still needs before it's sure (keys the admin puts in plain words) */
function problemsOf(m, { family, person, known, rubric, labels, later = [] }) {
  const keys = keysOf(rubric);
  const p = [];
  if (!family || m.familyDiffers) p.push('family');
  if (!person || m.scorerDiffers) p.push('scorer');
  else if (!known) p.push('new-scorer');
  if (m.disagree.some((d) => keys.includes(d.key))) p.push('disagree');
  // Nothing either reader could read (a score they read differently is a disagreement, not this;
  // one scored after the home visit can be blank until then)
  if (keys.some((k) => m.scores[k] == null && !later.includes(k) && !m.disagree.some((d) => d.key === k))) p.push('unread');
  // On the other rubric: a criterion this one doesn't have, by its score or its printed name
  const other = ALL_KEYS.filter((k) => !keys.includes(k));
  if (other.some((k) => m.scores[k] != null || (PRINTED[k] && labels.some((l) => PRINTED[k].test(l))))) p.push('rubric');
  // A criterion only one rubric has must be printed on the sheet to count (models may file it by its place)
  if (keys.some((k) => PRINTED[k] && m.scores[k] != null && labels.length && !labels.some((l) => PRINTED[k].test(l)))) p.push('rubric');
  const sum = totalOf(Object.fromEntries(keys.map((k) => [k, m.scores[k]])), rubric);
  const partial = keys.reduce((n, k) => n + (m.scores[k] || 0), 0);
  if (m.total != null && (sum != null ? m.total !== sum : keys.every((k) => m.scores[k] != null || later.includes(k)) && m.total !== partial)) p.push('total');
  if (m.totalsDiffer) p.push('total');
  if (m.alone) p.push('alone');
  return [...new Set(p)];
}

/**
 * Read one page and save what's sure.
 * input: { scan, page (1-based), image (data: URL), text? }
 * readers: { [name]: (input) → { sheets, labels } | [sheet] | null } (tests pass fakes; default READERS through env.AI).
 * → { items: [item for the browser], summaries: { account: summary } }
 */
export async function readPage(env, input, { user, readers = null, now = Date.now() } = {}) {
  const DB = env.DB;
  await ensureScanSchema(DB);
  const bucket = privateFiles(env);
  if (!bucket) throw err('The private file storage (VENDOR_FILES) isn’t connected, so scoresheets can’t be kept.', 500);
  const scan = await DB.prepare('SELECT * FROM score_scans WHERE id = ?').bind(String(input?.scan || '')).first();
  if (!scan) throw err('That upload isn’t there any more.', 404);
  if (scan.undone_at) throw err('That upload was undone.', 409);
  const page = Number(input?.page);
  if (!Number.isInteger(page) || page < 1 || page > scan.pages) throw err('Which page?');
  const { results: had } = await DB.prepare('SELECT * FROM score_scan_items WHERE scan_id = ? AND page = ? ORDER BY idx').bind(scan.id, page).all();
  // Read again (a page neither reader could read, say after a timeout): the picture kept from the first time
  const img = input?.again && !input?.image ? await keptPicture(bucket, pageKey(scan.year, scan.id, page)) : imageBytes(input?.image);
  if (!img) throw err(input?.again ? 'That page’s picture isn’t kept any more; add the file again.' : 'That page didn’t come as a picture.');
  if (!input?.image) input = { ...input, image: dataUrlOf(img), text: input?.text || parse((had || []).find((r) => r.status === 'failed')?.reads, {})?.text || '' };
  if (img.bytes.length > MAX_IMAGE_BYTES) throw err('That page’s picture is too big.', 413);
  const claimed = (had || []).find((r) => r.idx === CLAIM_IDX);
  const sheets = (had || []).filter((r) => r.idx !== CLAIM_IDX);
  // A page read whole before (the network retried) gets its first answer; only one nobody could read is read again
  if (!claimed && sheets.some((r) => r.status !== 'failed')) return { items: sheets.map((r) => itemFromRow(r, scan)), summaries: {} };
  // One reading of a page at a time (the same file added twice at once): the second is told it's taken
  if (claimed && now - Date.parse(claimed.created_at) < CLAIM_MS) return { items: [], summaries: {}, busy: true };
  // A reading that stopped partway (the Worker was cut off): what it saved goes back, and the page is read afresh
  if (claimed || sheets.length) await rollbackPage(DB, scan, page);
  const claim = await DB.prepare("INSERT OR IGNORE INTO score_scan_items (scan_id, page, idx, status, created_at) VALUES (?, ?, ?, 'reading', ?)").bind(scan.id, page, CLAIM_IDX, iso(now)).run();
  if (!claim.meta?.changes) return { items: [], summaries: {}, busy: true };
  try {
    const out = await readClaimed(env, DB, scan, page, img, input, { user, readers, now, bucket });
    // Every sheet written: only now is the page read
    await DB.prepare('DELETE FROM score_scan_items WHERE scan_id = ? AND page = ? AND idx = ?').bind(scan.id, page, CLAIM_IDX).run();
    return out;
  } catch (e) {
    // All or nothing: a page that failed partway leaves no cards and no sheets, and is read whole next time
    await rollbackPage(DB, scan, page).catch((x) => console.error('[score-scans] rollback', x.message));
    throw e;
  }
}

/** A page's sheets taken back: the cards they saved go back to what was there, and the page is unread */
async function rollbackPage(DB, scan, page) {
  const { results } = await DB.prepare("SELECT * FROM score_scan_items WHERE scan_id = ? AND page = ? AND status = 'saved' ORDER BY seq DESC").bind(scan.id, page).all();
  for (const r of results || []) await releaseCard(DB, r);
  await DB.prepare('DELETE FROM score_scan_items WHERE scan_id = ? AND page = ?').bind(scan.id, page).run();
}

async function readClaimed(env, DB, scan, page, img, input, { user, readers, now, bucket }) {
  const text = cut(input?.text, TEXT_MAX);
  const key = pageKey(scan.year, scan.id, page);
  await bucket.put(key, img.bytes, { httpMetadata: { contentType: img.type } });

  // Read it: each reader on its own, at once
  const use = readers || Object.fromEntries(Object.keys(READERS).map((m) => [m, (x) => readWith(env, m, x)]));
  const names = Object.keys(use);
  const got = await Promise.all(names.map((r) => Promise.resolve().then(() => use[r]({ image: input.image, text })).catch(() => null)));
  const answers = Object.fromEntries(names.map((r, i) => [r, asRead(got[i])]));
  const reads = Object.fromEntries(names.map((r) => [r, answers[r]?.sheets || (answers[r] ? [] : null)]));
  const labels = [...new Set(names.flatMap((r) => answers[r]?.labels || []))];

  const answered = names.filter((r) => answers[r]);
  const merged = answered.length ? mergeReads(reads) : [];
  if (!merged.length) {
    const status = answered.length === names.length ? 'empty' : 'failed';
    await writeItem(DB, scan, page, 0, { status, problems: status === 'failed' ? ['failed'] : [], image_key: key, reads: { labels, text: status === 'failed' ? text : '' } }, now);
    return { items: [await itemOut(DB, scan, page, 0)], summaries: {} };
  }

  const families = await seasonFamilies(DB, scan.year);
  const { people, main } = await scorers(DB);
  const uploader = main(scan.uploaded_by);
  const summaries = {};
  for (const [idx, m] of merged.entries()) {
    // Who: the sheet's own words first; what the uploader said fills a gap, and a clash waits.
    // Readers that name different families or scorers: nothing is filled in, and each reading is a candidate.
    const fm = matchFamily(m, families, scan.year);
    if (m.familyDiffers) {
      const each = Object.values(m.seen).filter(Boolean).map((x) => matchFamily(x, families, scan.year));
      fm.family = null;
      fm.candidates = [...new Map(each.flatMap((e) => e.candidates).map((c) => [c.id, c])).values()].sort((a, b) => b.fit - a.fit).slice(0, 6);
    }
    let family = fm.family;
    if (scan.for_account) {
      const forced = families.find((f) => f.id === scan.for_account) || null;
      family = !m.family && !m.code ? forced : family && family.id !== scan.for_account ? null : family || (fm.candidates[0]?.id === scan.for_account ? forced : null);
    }
    const scorerText = m.scorer;
    let person = m.scorerDiffers ? null : matchScorer(scorerText, people);
    if (scan.for_scorer && !m.scorerDiffers) {
      // "These are all Linzi's": a sheet signed by someone else (or by a name nobody has) waits
      const forced = people.find((p) => p.email === main(scan.for_scorer)) || { email: main(scan.for_scorer), name: '', scored: false };
      person = !scorerText ? forced : matchScorer(scorerText, [forced]) ? forced : null;
    }
    const known = !!person && (person.scored || person.email === uploader || person.email === main(scan.for_scorer));
    const rubric = Number(family ? (await DB.prepare('SELECT rubric FROM applicant_scores WHERE account_id = ? LIMIT 1').bind(family.id).first())?.rubric : 0) || rubricOfSeason(scan.year);
    const later = await laterKeys(DB, family, rubric);
    const problems = problemsOf(m, { family, person, known, rubric, labels, later });
    const scores = Object.fromEntries(keysOf(rubric).filter((k) => m.scores[k] != null).map((k) => [k, m.scores[k]]));
    const base = {
      account_id: family?.id || null, evaluator: person?.email || null, evaluator_name: person?.name || null,
      family_text: m.family, scorer_text: scorerText, code: m.code, scores, notes: m.notes, image_key: key,
      reads: { seen: m.seen, disagree: m.disagree, unread: m.unread, total: m.total, candidates: fm.candidates, rubric, labels },
    };
    if (problems.length) {
      await writeItem(DB, scan, page, idx, { ...base, status: 'check', problems }, now);
      continue;
    }
    // Undone while this page was being read: nothing from it is saved
    if ((await DB.prepare('SELECT undone_at FROM score_scans WHERE id = ?').bind(scan.id).first())?.undone_at) {
      await writeItem(DB, scan, page, idx, { ...base, status: 'skipped', problems: ['undone'] }, now);
      continue;
    }
    try {
      const evaluator = await cardAddress(DB, family.id, person);
      base.evaluator = evaluator;
      // The card and the record of the sheet it came from, saved together
      const saved = await saveScannedCard(DB, family.id, {
        evaluator, name: person.name || null, scores, notes: m.notes, ref: `${scan.id}:${page}:${idx}`, now,
        alsoRun: ({ replaced, dropped, same }) => [itemStatement(DB, scan, page, idx, {
          ...base, status: same ? 'same' : 'saved', problems: [], replaced, dropped, saved_by: cleanEvaluator(user), saved_at: iso(now),
        }, now)],
      });
      summaries[family.id] = saved.summary;
    } catch (e) {
      if (e.status !== 409) throw e;
      await writeItem(DB, scan, page, idx, { ...base, status: 'check', problems: [e.code || 'has-card'], reads: { ...base.reads, theirs: e.card || null } }, now);
    }
  }
  const items = [];
  for (let i = 0; i < merged.length; i++) items.push(await itemOut(DB, scan, page, i));
  return { items, summaries };
}

/** Sheets locked for saving by a save that was cut off: back to what they were */
async function healSaving(DB, now = Date.now()) {
  await DB.prepare("UPDATE score_scan_items SET status = substr(saved_by, 2), saved_by = NULL, saved_at = NULL WHERE status = 'saving' AND saved_at < ? AND saved_by LIKE '~%'")
    .bind(iso(now - SAVING_MS)).run();
}

/** Is this page still being read (or was its reading cut off)? Its sheets wait until it's whole */
const pageClaimed = async (DB, scanId, page) => !!(await DB.prepare('SELECT 1 AS x FROM score_scan_items WHERE scan_id = ? AND page = ? AND idx = ?').bind(scanId, page, CLAIM_IDX).first());

/** The order cards were saved in, for undo (the newest goes back first) */
const NEXT_SEQ = '(SELECT COALESCE(MAX(seq), 0) + 1 FROM score_scan_items)';

/**
 * What a card should go back to: the card it replaced, unless that came from
 * an upload that has since been undone, in which case what that one replaced
 * (and so on), so an undone upload's scores never come back
 */
async function priorOf(DB, replaced) {
  let r = replaced;
  for (let hops = 0; r && r.source === 'scan' && r.source_ref && hops < 20; hops++) {
    const [sid, pg, ix] = String(r.source_ref).split(':');
    const s = await DB.prepare('SELECT undone_at FROM score_scans WHERE id = ?').bind(sid).first();
    if (!s?.undone_at) break;
    const it = await DB.prepare('SELECT replaced FROM score_scan_items WHERE scan_id = ? AND page = ? AND idx = ?').bind(sid, Number(pg), Number(ix)).first();
    r = parse(it?.replaced, null);
  }
  return r;
}

const writeItem = (DB, scan, page, idx, it, now) => itemStatement(DB, scan, page, idx, it, now).run();
function itemStatement(DB, scan, page, idx, it, now) {
  const dropped = it.dropped && Object.keys(it.dropped).length ? JSON.stringify(it.dropped) : null;
  return DB.prepare(`INSERT OR REPLACE INTO score_scan_items (scan_id, page, idx, status, account_id, evaluator, evaluator_name, family_text, scorer_text, code,
      scores, notes, reads, problems, replaced, dropped, image_key, created_at, saved_at, saved_by, seq)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${it.status === 'saved' ? NEXT_SEQ : 'NULL'})`)
    .bind(scan.id, page, idx, it.status, it.account_id ?? null, it.evaluator ?? null, it.evaluator_name ?? null, it.family_text ?? null, it.scorer_text ?? null, it.code ?? null,
      JSON.stringify(it.scores || {}), it.notes || null, JSON.stringify(it.reads || {}), JSON.stringify(it.problems || []), it.replaced ? JSON.stringify(it.replaced) : null,
      dropped, it.image_key ?? null, iso(now), it.saved_at ?? null, it.saved_by ?? null);
}

const itemFromRow = (r, scan) => {
  const reads = parse(r.reads, {});
  return {
    scan: r.scan_id, page: r.page, idx: r.idx, status: r.status, year: scan?.year || null, file: scan?.file_name || null, uploadedBy: scan?.uploaded_by || null,
    account: r.account_id, evaluator: r.evaluator, evaluatorName: r.evaluator_name, familyText: r.family_text || '', scorerText: r.scorer_text || '',
    code: r.code || '', scores: parse(r.scores, {}), notes: r.notes || '', problems: parse(r.problems, []), held: parse(r.dropped, {}) || {}, heldAt: r.held_at || null,
    disagree: reads.disagree || [], unread: reads.unread || [], total: reads.total ?? null, candidates: reads.candidates || [], labels: reads.labels || [],
    rubric: reads.rubric || rubricOfSeason(scan?.year), theirs: reads.theirs || null,
    seen: Object.fromEntries(Object.entries(reads.seen || {}).map(([k, s]) => [k, s ? { family: s.family, scorer: s.scorer, scores: s.scores, total: s.total } : null])),
    savedAt: r.saved_at, savedBy: r.saved_by, scanAt: scan?.created_at || null,
  };
};
async function itemOut(DB, scan, page, idx) {
  const r = await DB.prepare('SELECT * FROM score_scan_items WHERE scan_id = ? AND page = ? AND idx = ?').bind(scan.id, page, idx).first();
  return r ? itemFromRow(r, scan) : null;
}

const itemKey = (input) => [String(input?.scan || ''), Number(input?.page), Number(input?.idx)];
async function itemAndScan(DB, input) {
  await healSaving(DB);
  const r = await DB.prepare('SELECT * FROM score_scan_items WHERE scan_id = ? AND page = ? AND idx = ?').bind(...itemKey(input)).first();
  if (!r) throw err('That sheet isn’t there any more.', 404);
  const scan = await DB.prepare('SELECT * FROM score_scans WHERE id = ?').bind(r.scan_id).first();
  if (!scan || scan.undone_at) throw err('That upload was undone.', 409);
  return { r, scan };
}

/**
 * A person's answer for a sheet that waited (or a correction to one that saved):
 * { scan, page, idx, account, evaluator, scores, override? }. The scores must be
 * the family's whole rubric. → { item, summary }
 */
export async function confirmItem(env, input, { user, now = Date.now() } = {}) {
  const DB = env.DB;
  await ensureScanSchema(DB);
  const { r, scan } = await itemAndScan(DB, input);
  const families = await seasonFamilies(DB, scan.year);
  const family = families.find((f) => f.id === input?.account);
  if (!family) throw err(`Pick one of the ${scan.year} families.`);
  const { people, main } = await scorers(DB);
  const who = main(input?.evaluator);
  if (!who) throw err('Pick who scored it.');
  const person = people.find((p) => p.email === who) || { email: who, name: '' };
  const rubric = Number((await DB.prepare('SELECT rubric FROM applicant_scores WHERE account_id = ? LIMIT 1').bind(family.id).first())?.rubric) || rubricOfSeason(scan.year);
  const later = await laterKeys(DB, family, rubric);
  const scores = {};
  for (const k of keysOf(rubric)) {
    const v = cleanScore(input?.scores?.[k]);
    if (v == null && later.includes(k)) continue; // scored after the home visit: blank until then
    if (v == null) throw err(`Give ${criteriaOf(rubric).find((c) => c.key === k).label} a score from 1 to 5.`, 422);
    scores[k] = v;
  }
  // Two people checking the same sheet at once: the sheet is taken first, so the second is told, never written over the first
  // 5. a page cut off partway is read again whole before its sheets can be checked (a check can't be undone by that)
  if (await pageClaimed(DB, r.scan_id, r.page)) throw err('That page is still being read. Its sheets show here once it’s done.', 409);
  const taken = await DB.prepare("UPDATE score_scan_items SET status = 'saving', saved_at = ?, saved_by = ? WHERE scan_id = ? AND page = ? AND idx = ? AND status IN ('check', 'failed')")
    .bind(iso(now), `~${r.status}`, r.scan_id, r.page, r.idx).run();
  if (!taken.meta?.changes) {
    const now2 = await DB.prepare('SELECT status, saved_by FROM score_scan_items WHERE scan_id = ? AND page = ? AND idx = ?').bind(r.scan_id, r.page, r.idx).first();
    const by = now2?.saved_by ? ` by ${now2.saved_by.split('@')[0]}` : '';
    throw err(now2?.status === 'skipped' ? `That sheet was left out${by}. Put it back first to check it.`
      : now2?.status === 'empty' ? 'That page has no scoresheet on it.'
        : now2?.status === 'saving' ? 'Someone is saving that sheet right now.'
          : `That sheet was saved already${by}. Take it off first to change it.`, 409);
  }
  try {
    const evaluator = await cardAddress(DB, family.id, { ...person, email: who });
    // The card and the sheet's record, saved together
    const saved = await saveScannedCard(DB, family.id, {
      evaluator, name: person.name || null, scores, notes: r.notes, ref: `${r.scan_id}:${r.page}:${r.idx}`, override: !!input?.override, now,
      alsoRun: ({ replaced, dropped, same }) => [DB.prepare(`UPDATE score_scan_items SET status = ?, account_id = ?, evaluator = ?, evaluator_name = ?, scores = ?, replaced = ?, dropped = ?,
          problems = '[]', saved_at = ?, saved_by = ?, seq = ${same ? 'seq' : NEXT_SEQ} WHERE scan_id = ? AND page = ? AND idx = ?`)
        .bind(same ? 'same' : 'saved', family.id, evaluator, person.name || null, JSON.stringify(scores), replaced ? JSON.stringify(replaced) : null,
          Object.keys(dropped || {}).length ? JSON.stringify(dropped) : null, iso(now), cleanEvaluator(user), r.scan_id, r.page, r.idx)],
    });
    return { item: await itemOut(DB, scan, r.page, r.idx), summary: saved.summary };
  } catch (e) {
    await DB.prepare("UPDATE score_scan_items SET status = ?, saved_at = NULL, saved_by = NULL WHERE scan_id = ? AND page = ? AND idx = ? AND status = 'saving'").bind(r.status, r.scan_id, r.page, r.idx).run().catch(() => {});
    throw e;
  }
}

/** A sheet that was left out, back under Check these */
export async function unskipItem(env, input) {
  await ensureScanSchema(env.DB);
  const { r } = await itemAndScan(env.DB, input);
  const done = await env.DB.prepare("UPDATE score_scan_items SET status = 'check', saved_at = NULL, saved_by = NULL WHERE scan_id = ? AND page = ? AND idx = ? AND status = 'skipped'")
    .bind(r.scan_id, r.page, r.idx).run();
  if (!done.meta?.changes) throw err('That sheet isn’t left out.', 409);
  return { ok: true };
}

/** Leave a sheet out (it isn't a scoresheet, it's a copy, or SOARD isn't scoring that family) */
export async function skipItem(env, input, { user, now = Date.now() } = {}) {
  await ensureScanSchema(env.DB);
  const r = await env.DB.prepare("UPDATE score_scan_items SET status = 'skipped', saved_at = ?, saved_by = ? WHERE scan_id = ? AND page = ? AND idx = ? AND status IN ('check', 'failed')")
    .bind(iso(now), cleanEvaluator(user), ...itemKey(input)).run();
  if (!r.meta?.changes) throw err('That sheet isn’t waiting any more.', 409);
  return { ok: true };
}

/**
 * A saved sheet's card, let go (undo, take off): back to what was there before,
 * unless another live upload has a sheet that said the very same, in which
 * case the card stays, as that sheet's (so undoing one copy of a file never
 * wipes scores the other still vouches for)
 */
async function releaseCard(DB, r, { undoing = false, alsoRun = null } = {}) {
  const ref = `${r.scan_id}:${r.page}:${r.idx}`;
  const prior = await priorOf(DB, parse(r.replaced, null));
  const { results: heirs } = await DB.prepare(`SELECT i.* FROM score_scan_items i JOIN score_scans s ON s.id = i.scan_id
    WHERE i.account_id = ? AND i.evaluator = ? AND i.status = 'same' AND s.undone_at IS NULL ORDER BY i.saved_at DESC`).bind(r.account_id, r.evaluator).all();
  // Undoing the whole upload: a copy in it vouches for nothing
  const card = await DB.prepare('SELECT scores, source_ref FROM applicant_scores WHERE account_id = ? AND evaluator = ?').bind(r.account_id, r.evaluator).first();
  const now = parse(card?.scores, {});
  const heir = card?.source_ref === ref && (heirs || []).find((h) => {
    const held = parse(h.dropped, {}) || {};
    const said = Object.fromEntries(Object.entries(parse(h.scores, {})).filter(([k]) => !(k in held) || k in now));
    return `${h.scan_id}:${h.page}:${h.idx}` !== ref && !(undoing && h.scan_id === r.scan_id) && Object.keys(said).length && Object.entries(said).every(([k, v]) => now[k] === v);
  });
  if (heir) {
    const heirRef = `${heir.scan_id}:${heir.page}:${heir.idx}`;
    // The card moves to the copy, and the copy becomes the sheet that saved it: both or neither
    await DB.batch([
      DB.prepare('UPDATE applicant_scores SET source_ref = ? WHERE account_id = ? AND evaluator = ? AND source_ref = ?').bind(heirRef, r.account_id, r.evaluator, ref),
      DB.prepare(`UPDATE score_scan_items SET status = 'saved', replaced = ?, seq = ${NEXT_SEQ} WHERE scan_id = ? AND page = ? AND idx = ?`)
        .bind(prior ? JSON.stringify(prior) : null, heir.scan_id, heir.page, heir.idx),
      ...(alsoRun?.() || []),
    ]);
    return { restored: true, kept: true, summary: await familySummary(DB, r.account_id) };
  }
  return restoreScannedCard(DB, r.account_id, { evaluator: r.evaluator, ref, replaced: prior, alsoRun });
}

/**
 * Take one saved sheet back off (matched to the wrong family, say): the card
 * goes back to what was there before, and the sheet waits again.
 * → { item, summary, restored }
 */
export async function unsaveItem(env, input, { now = Date.now() } = {}) {
  const DB = env.DB;
  await ensureScanSchema(DB);
  const { r, scan } = await itemAndScan(DB, input);
  if (r.status !== 'saved') throw err('That sheet isn’t saved.', 409);
  const back = () => [DB.prepare(`UPDATE score_scan_items SET status = 'check', problems = '["taken-off"]', replaced = NULL, saved_at = ?, saved_by = NULL WHERE scan_id = ? AND page = ? AND idx = ?`)
    .bind(iso(now), r.scan_id, r.page, r.idx)];
  // The card goes back and the sheet waits again, together
  const out = await releaseCard(DB, r, { alsoRun: back });
  if (out.already || out.missing) await DB.batch(back()); // the card was put back already, or is gone: only the sheet is left to set right
  else if (!out.restored) throw err('That card has changed since the scan saved it (on the site, or by another upload), so it stays as it is.', 409);
  return { item: await itemOut(DB, scan, r.page, r.idx), summary: out.summary, restored: out.restored, kept: !!out.kept };
}

/**
 * Undo an upload: every card it saved goes back to what was there before
 * (none, or the card it replaced), unless the card has changed since.
 * → { restored, changed (cards left as they are), summaries }
 */
export async function undoScan(env, id, { user, now = Date.now() } = {}) {
  const DB = env.DB;
  await ensureScanSchema(DB);
  const scan = await DB.prepare('SELECT * FROM score_scans WHERE id = ?').bind(String(id || '')).first();
  if (!scan) throw err('That upload isn’t there any more.', 404);
  if (scan.undone_at) return { restored: 0, changed: 0, summaries: {} };
  // Last saved first, so a card it replaced twice goes back to what was there before it
  const { results } = await DB.prepare("SELECT * FROM score_scan_items WHERE scan_id = ? AND status = 'saved' ORDER BY seq DESC").bind(scan.id).all();
  let restored = 0; let changed = 0;
  const summaries = {};
  for (const r of results || []) {
    const out = await releaseCard(DB, r, { undoing: true });
    if (out.restored) restored++; else if (!out.missing) changed++;
    summaries[r.account_id] = out.summary;
  }
  await DB.prepare('UPDATE score_scans SET undone_at = ?, undone_by = ? WHERE id = ?').bind(iso(now), cleanEvaluator(user), scan.id).run();
  // Its page pictures (children's names and needs) aren't kept for an upload that's gone
  const keys = Array.from({ length: scan.pages }, (_, i) => pageKey(scan.year, scan.id, i + 1));
  for (let i = 0; i < keys.length; i += 500) {
    try { await privateFiles(env)?.delete?.(keys.slice(i, i + 500)); } catch (e) { console.error('[score-scans] delete pictures', e.message); }
  }
  return { restored, changed, summaries };
}

/** Scores held back until the home visit, onto their cards for families that have had it → how many cards took them */
export async function applyHeld(DB, { now = Date.now() } = {}) {
  await ensureScanSchema(DB);
  const { results } = await DB.prepare(`SELECT i.*, a.archived_at AS a_archived, a.account_id AS a_id FROM score_scan_items i JOIN score_scans s ON s.id = i.scan_id
    LEFT JOIN applicants a ON a.account_id = i.account_id
    WHERE i.dropped IS NOT NULL AND i.held_at IS NULL AND i.status IN ('saved', 'same') AND s.undone_at IS NULL ORDER BY i.created_at`).all();
  let n = 0;
  for (const r of results || []) {
    // Not on the board (archived, or between syncs): it keeps waiting, since the family may come back
    if (!r.a_id || r.a_archived || !(await homeVisited(DB, r.account_id))) continue;
    // The visit has happened: onto the card (unless they've scored it since), and done with either way
    if (await applyHeldScores(DB, r.account_id, { evaluator: r.evaluator, ref: `${r.scan_id}:${r.page}:${r.idx}`, held: parse(r.dropped, {}), now })) n++;
    await DB.prepare('UPDATE score_scan_items SET held_at = ? WHERE scan_id = ? AND page = ? AND idx = ?').bind(iso(now), r.scan_id, r.page, r.idx).run();
  }
  return n;
}

/**
 * A season's uploads and the sheets waiting on a person, with whom they could be.
 * → { scans: [{ id, name, pages, read, by, at, undoneAt, counts }], waiting: [item], saved: [item],
 *     scorers: [{ email, name, scored }], families: [{ id, name, code }] }
 */
export async function seasonScans(DB, year, { me = null } = {}) {
  await ensureScanSchema(DB);
  const y = cleanYear(year);
  if (!y) throw err('Which season?');
  await applyHeld(DB).catch(() => 0);
  await healSaving(DB);
  const { results: scans } = await DB.prepare('SELECT * FROM score_scans WHERE year = ? ORDER BY created_at DESC').bind(y).all();
  const byId = new Map((scans || []).map((s) => [s.id, s]));
  const ids = [...byId.keys()];
  const items = ids.length ? (await DB.prepare(`SELECT i.* FROM score_scan_items i JOIN score_scans s ON s.id = i.scan_id WHERE s.year = ? ORDER BY i.scan_id, i.page, i.idx`).bind(y).all()).results || [] : [];
  // A page still being read (or cut off partway) isn't read yet: its sheets show once it's whole
  const claimedPages = new Set(items.filter((r) => r.idx === CLAIM_IDX).map((r) => `${r.scan_id}:${r.page}`));
  const counts = new Map();
  for (const r of items) {
    if (r.idx === CLAIM_IDX || r.status === 'reading' || r.status === 'saving' || claimedPages.has(`${r.scan_id}:${r.page}`)) continue;
    const c = counts.get(r.scan_id) || { saved: 0, same: 0, check: 0, skipped: 0, empty: 0, failed: 0, pages: new Set() };
    c[r.status] = (c[r.status] || 0) + 1;
    c.pages.add(r.page);
    counts.set(r.scan_id, c);
  }
  const live = (r) => !byId.get(r.scan_id)?.undone_at && !claimedPages.has(`${r.scan_id}:${r.page}`);
  const { people, main } = await scorers(DB);
  // The families the person looking has scored themselves (any of their addresses): another scorer's sheet for one they haven't stays covered
  const meMain = main(me);
  const rubrics = new Map(((await DB.prepare('SELECT account_id, MIN(rubric) AS rubric FROM applicant_scores GROUP BY account_id').all()).results || []).map((r) => [r.account_id, Number(r.rubric)]));
  const mine = new Set(meMain ? ((await DB.prepare('SELECT account_id, evaluator, scores FROM applicant_scores').all()).results || [])
    .filter((c) => main(c.evaluator) === meMain && Object.keys(parse(c.scores, {})).length).map((c) => c.account_id) : []);
  return {
    scans: (scans || []).map((s) => {
      const c = counts.get(s.id) || { saved: 0, same: 0, check: 0, skipped: 0, empty: 0, failed: 0, pages: new Set() };
      return {
        id: s.id, name: s.file_name, pages: s.pages, read: c.pages.size, by: s.uploaded_by, at: s.created_at, undoneAt: s.undone_at, undoneBy: s.undone_by,
        forAccount: s.for_account, counts: { saved: c.saved, same: c.same, check: c.check + c.failed, skipped: c.skipped, empty: c.empty },
      };
    }),
    waiting: items.filter((r) => (r.status === 'check' || r.status === 'failed') && live(r)).map((r) => itemFromRow(r, byId.get(r.scan_id))),
    saved: items.filter((r) => (r.status === 'saved' || r.status === 'same') && live(r)).map((r) => itemFromRow(r, byId.get(r.scan_id))),
    left: items.filter((r) => r.status === 'skipped' && live(r)).map((r) => itemFromRow(r, byId.get(r.scan_id))),
    scorers: people,
    me: meMain || null,
    families: await Promise.all((await seasonFamilies(DB, y)).map(async (f) => ({
      id: f.id, name: f.name, status: f.status, code: familyCode(y, f.id), visited: await homeVisited(DB, f.id), mine: mine.has(f.id),
      // The rubric the family is scored on: its cards' (a family scored in 2026 keeps 2026's), else the season's
      rubric: rubrics.get(f.id) || rubricOfSeason(y),
    }))),
  };
}

/** A page's picture, for the admin only → { body, type } | null */
export async function pageImage(env, scanId, page) {
  await ensureScanSchema(env.DB);
  const scan = await env.DB.prepare('SELECT year, undone_at FROM score_scans WHERE id = ?').bind(String(scanId || '')).first();
  if (!scan || scan.undone_at) return null;
  const obj = await privateFiles(env)?.get(pageKey(scan.year, String(scanId), Number(page)));
  return obj ? { body: obj.body, type: obj.httpMetadata?.contentType || 'image/jpeg' } : null;
}

export { familySummary };
