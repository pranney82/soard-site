/**
 * Close-outs and the budget builder
 * ===========================================================================
 * When a makeover's job closes in JobTread, its final numbers are kept for
 * good (job_closeouts): budget and actual by cost code, what was built (from
 * the family's profile: bedrooms, bathrooms, ramps…), cost per room, and the
 * codes that ran over. The Finance channel hears it once, and the job's
 * "Close-out report" field in JobTread gets the numbers and the link.
 *
 * Every close-out teaches the next budget. The builder takes the close-outs
 * whose spending was really coded (Ramp-era bills sit on one 01 line and
 * would teach nothing until they're recoded), works out what each cost code
 * costs per room, and suggests a budget for a job from what it will build.
 * Lines go into JobTread only when a person presses "Add to JobTread", and
 * only for codes the job's budget doesn't have yet: a line someone wrote is
 * never changed.
 *
 * The first look reads every job closed since HISTORY_FROM, quietly (no
 * Slack), a few per heartbeat, so the builder starts with real history.
 */

import { pave, SOARD_ORG_ID, FIELD_JOB_STATUS, isRehearsalJob } from './_reveals.js';
import { slackPost, SITE_ORIGIN } from './_broadcast-notify.js';
import { slackCard } from './_slack-cards.js';
import { computeLedger, jobCostSources, costCodes, UNCODED } from './_job-ledger.js';
import { readState, writeState } from './_mercury.js';
import { writeCloseoutField } from './_job-costs-sync.js';
import { loadAllKids } from './_kid-status.js';
import { buildsOf, roomTotal, buildSummary, BUILDS } from '../../public/admin/kids-shared.js';
import { RAMP_CODE_ID } from './_jobtread-bills.js';

export const HISTORY_FROM = '2025-01-01';
const NEW_CLOSE_DAYS = 14;          // a job closed within this many days is news; older ones are history
const PER_RUN = 4;                  // jobs read per heartbeat (each is a few JobTread calls)
const CODED_SHARE_MIN = 0.8;        // a close-out teaches the builder when 80% of its spend is on real codes
const CODE_SEEN_MIN = 0.3;          // a code is suggested when 30% of comparable jobs used it
const STATE_KEY = 'closeouts';
const ADMIN = `${SITE_ORIGIN}/admin/#job-costs`;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS job_closeouts (
    job_id TEXT PRIMARY KEY, name TEXT, number TEXT, closed_on TEXT, budget INTEGER, actual INTEGER,
    rooms INTEGER, builds TEXT, kid_slug TEXT, rows TEXT, coded_share REAL, posted_at TEXT, updated_at TEXT)`,
  'CREATE INDEX IF NOT EXISTS job_closeouts_closed ON job_closeouts (closed_on)',
];
const _ready = new WeakSet();
async function ensure(DB) {
  if (_ready.has(DB)) return;
  await DB.batch(SCHEMA.map((s) => DB.prepare(s)));
  _ready.add(DB);
}

const usd = (c) => (Math.round(Number(c || 0) / 100)).toLocaleString('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const pct = (a, b) => (b > 0 ? Math.round(((a - b) / b) * 100) : null);

// ─── Pure parts (tested) ────────────────────────────────────────────

/**
 * A close-out from a final ledger and what the profile says was built.
 * → { budget, actual, rows: [{ codeId, budget, actual }], rooms, builds, codedShare, over: [{ codeId, by }] }
 */
export function closeoutOf(ledger, kid = null) {
  const rows = (ledger?.rows || []).map((r) => ({ codeId: r.codeId, budget: r.budget, actual: r.billed + r.pending }))
    .filter((r) => r.budget || r.actual);
  const actual = rows.reduce((n, r) => n + r.actual, 0);
  const budget = rows.reduce((n, r) => n + r.budget, 0);
  // Spend on a real trade code: not uncoded, not the Ramp-era 01 catch-all
  const coded = rows.filter((r) => r.codeId !== UNCODED && r.codeId !== RAMP_CODE_ID).reduce((n, r) => n + r.actual, 0);
  const builds = kid ? buildsOf(kid) : null;
  const rooms = builds ? roomTotal(builds) : 0;
  const over = rows.filter((r) => r.budget > 0 && r.actual > r.budget).map((r) => ({ codeId: r.codeId, by: r.actual - r.budget }))
    .sort((a, b) => b.by - a.by);
  return { budget, actual, rows, rooms, builds, codedShare: actual > 0 ? coded / actual : 0, over };
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return 0;
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
};
const quantile = (xs, q) => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return 0;
  const i = (s.length - 1) * q;
  const lo = Math.floor(i);
  return Math.round(s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (i - lo));
};

/** The close-outs worth learning from: closed, really coded, and with rooms known */
export const teaches = (c) => c.actual > 0 && c.codedShare >= CODED_SHARE_MIN && c.rooms > 0;

/**
 * What each cost code costs, across close-outs that teach.
 * → { jobs, codes: [{ codeId, seen, perRoom, low, high, perJob, overBy (median % over its own line, null if never budgeted) }] }
 */
export function codeHistory(closeouts) {
  const usable = closeouts.filter(teaches);
  const by = new Map();
  for (const c of usable) {
    for (const r of c.rows) {
      if (r.codeId === UNCODED || r.codeId === RAMP_CODE_ID || r.actual <= 0) continue;
      if (!by.has(r.codeId)) by.set(r.codeId, { perRoom: [], perJob: [], over: [] });
      const b = by.get(r.codeId);
      b.perRoom.push(r.actual / c.rooms);
      b.perJob.push(r.actual);
      if (r.budget > 0) b.over.push(((r.actual - r.budget) / r.budget) * 100);
    }
  }
  const codes = [...by.entries()].map(([codeId, b]) => ({
    codeId,
    seen: b.perJob.length,
    share: usable.length ? b.perJob.length / usable.length : 0,
    perRoom: median(b.perRoom),
    low: quantile(b.perRoom, 0.25),
    high: quantile(b.perRoom, 0.75),
    perJob: median(b.perJob),
    overBy: b.over.length ? Math.round(median(b.over)) : null,
  })).sort((a, b) => b.perJob - a.perJob);
  return { jobs: usable.length, codes };
}

/**
 * A suggested budget for a job that will build `rooms` rooms, next to its
 * current JobTread budget. Rounded to $50. → { rooms, lines: [{ codeId, suggested, low, high, current, seen, add }], total, current }
 * `current`: the job's budget lines as jobCostSources reads them ([{ costCodeId, cents }]).
 * `add` is true when the job has no line on that code yet (only those go into JobTread).
 */
export function suggestBudget(history, { rooms, current = [] }) {
  const have = new Map();
  for (const l of current) have.set(l.costCodeId || UNCODED, (have.get(l.costCodeId || UNCODED) || 0) + l.cents);
  const round = (c) => Math.round(c / 5000) * 5000;
  const lines = history.codes
    .filter((c) => c.share >= CODE_SEEN_MIN)
    .map((c) => ({
      codeId: c.codeId,
      suggested: round(c.perRoom * rooms),
      low: round(c.low * rooms),
      high: round(c.high * rooms),
      seen: c.seen,
      overBy: c.overBy,
      current: have.get(c.codeId) || 0,
      add: !have.has(c.codeId),
    }))
    .filter((l) => l.suggested > 0);
  // Codes the job budgets that history doesn't suggest still show, so the comparison is whole
  for (const [codeId, cents] of have) {
    if (!lines.some((l) => l.codeId === codeId)) lines.push({ codeId, suggested: 0, low: 0, high: 0, seen: 0, overBy: null, current: cents, add: false });
  }
  return {
    rooms,
    lines,
    total: lines.reduce((n, l) => n + l.suggested, 0),
    current: lines.reduce((n, l) => n + l.current, 0),
  };
}

/** The Slack card for a job that just closed */
export function closeoutCard(job, c, codeName = (id) => id) {
  const diff = pct(c.actual, c.budget);
  const facts = [
    ['Spent', usd(c.actual)],
    ['Budget', c.budget ? usd(c.budget) : 'No budget'],
    ...(diff !== null ? [[diff > 0 ? 'Over' : 'Under', `${Math.abs(diff)}%`]] : []),
    ...(c.rooms ? [['Per room', usd(c.actual / c.rooms)]] : []),
  ];
  const overs = c.over.slice(0, 3).map((o) => `${codeName(o.codeId)} ${usd(o.by)} over`);
  return slackCard({
    icon: '🏁',
    title: `${job.name} closed: ${usd(c.actual)}${c.budget ? ` of ${usd(c.budget)}` : ''}`,
    lead: [
      c.builds ? `Built ${buildSummary(c.builds)}.` : null,
      overs.length ? `Ran over on ${overs.join(', ')}.` : c.budget ? 'Every cost code came in at or under its line.' : null,
      c.codedShare < CODED_SHARE_MIN ? 'Much of this job’s spending is still on one Ramp-era line, so the budget builder won’t learn from it until those bills are recoded.' : null,
    ].filter(Boolean).join(' '),
    facts,
    buttons: [{ label: 'Open the close-out', url: `${ADMIN}/closeouts/${encodeURIComponent(job.id)}` }],
  });
}

// ─── JobTread and D1 ────────────────────────────────────────────────

/** Jobs closed on or after `since` → [{ id, name, number, closedOn, status }] */
export async function closedJobs(env, since, { fetchImpl = fetch } = {}) {
  const out = [];
  let page = null;
  for (let i = 0; i < 40; i++) {
    const data = await pave(env.JOBTREAD_GRANT_KEY, {
      organization: {
        $: { id: SOARD_ORG_ID },
        jobs: {
          $: { size: 25, where: ['closedOn', '>=', since], sortBy: [{ field: 'closedOn', order: 'desc' }], ...(page ? { page } : {}) },
          nextPage: {},
          nodes: {
            id: {}, name: {}, number: {}, closedOn: {},
            customFieldValues: { $: { size: 5, where: [['customField', 'id'], '=', FIELD_JOB_STATUS] }, nodes: { value: {} } },
          },
        },
      },
    }, fetchImpl);
    const conn = data?.organization?.jobs;
    for (const j of conn?.nodes || []) {
      if (isRehearsalJob(j)) continue;
      out.push({ id: j.id, name: j.name, number: j.number || null, closedOn: j.closedOn, status: j.customFieldValues?.nodes?.[0]?.value || null });
    }
    page = conn?.nextPage;
    if (!page) break;
  }
  return out;
}

const parseRow = (r) => {
  const j = (s, d) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
  return {
    jobId: r.job_id, name: r.name, number: r.number, closedOn: r.closed_on, budget: r.budget, actual: r.actual,
    rooms: r.rooms, builds: j(r.builds, null), kidSlug: r.kid_slug, rows: j(r.rows, []), codedShare: r.coded_share,
    over: [], postedAt: r.posted_at, updatedAt: r.updated_at,
  };
};

export async function readCloseouts(DB) {
  await ensure(DB);
  const rows = (await DB.prepare('SELECT * FROM job_closeouts ORDER BY closed_on DESC').all()).results || [];
  return rows.map(parseRow).map((c) => ({
    ...c,
    over: c.rows.filter((r) => r.budget > 0 && r.actual > r.budget).map((r) => ({ codeId: r.codeId, by: r.actual - r.budget })).sort((a, b) => b.by - a.by),
  }));
}

/** The family's profile for a job (linked by jobtreadJobId) */
async function kidFor(DB, jobId) {
  const kids = await loadAllKids(DB).catch(() => []);
  return kids.find((k) => k.data?.jobtreadJobId === jobId) || null;
}

/** Work out one job's close-out and keep it. `announce` posts it and writes the JobTread field. */
export async function closeOut(env, job, { now = Date.now(), announce = false, fetchImpl = fetch } = {}) {
  await ensure(env.DB);
  const [{ budget, docs }, pendingRows, kid] = await Promise.all([
    jobCostSources(env, job.id, { fetchImpl }),
    env.DB.prepare("SELECT cents, code_id FROM spend_charges WHERE job_id = ? AND bill_id IS NULL AND status IN ('pending', 'sent')").bind(job.id).all().catch(() => ({ results: [] })),
    kidFor(env.DB, job.id),
  ]);
  const ledger = computeLedger({ budget, docs, pending: (pendingRows.results || []).map((c) => ({ cents: c.cents, costCodeId: c.code_id })) });
  const c = closeoutOf(ledger, kid?.data || null);
  const before = await env.DB.prepare('SELECT posted_at FROM job_closeouts WHERE job_id = ?').bind(job.id).first();
  const iso = new Date(now).toISOString();
  let postedAt = before?.posted_at || null;
  if (announce && !postedAt) {
    const codes = await costCodes(env).catch(() => []);
    const codeName = (id) => codes.find((x) => x.id === id)?.name || (id === UNCODED ? 'Uncoded' : 'A cost code');
    const r = await slackPost(env, closeoutCard(job, c, codeName), { kind: 'news', area: 'finance' }).catch(() => null);
    // Posted, or no Finance channel to post to: either way it's said once
    if (r?.ok || r?.skipped) postedAt = iso;
    const diff = pct(c.actual, c.budget);
    await writeCloseoutField(env, job.id, `${usd(c.actual)}${c.budget ? ` of ${usd(c.budget)} (${diff > 0 ? `${diff}% over` : `${Math.abs(diff)}% under`})` : ''}${c.rooms ? ` · ${usd(c.actual / c.rooms)} a room` : ''} · ${ADMIN}/closeouts/${job.id}`, { fetchImpl });
  }
  await env.DB.prepare(`INSERT OR REPLACE INTO job_closeouts (job_id, name, number, closed_on, budget, actual, rooms, builds, kid_slug, rows, coded_share, posted_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(job.id, job.name, job.number || null, job.closedOn || null, c.budget, c.actual, c.rooms, c.builds ? JSON.stringify(c.builds) : null,
      kid?.slug || null, JSON.stringify(c.rows), c.codedShare, postedAt, iso).run();
  return c;
}

/**
 * The heartbeat part (hourly is plenty): jobs closed since the last look get
 * a close-out, posted when the close is recent; history fills in quietly a
 * few jobs at a time. A close-out is redone for 30 days after closing, since
 * late bills still land. Never throws.
 */
export async function maybeRunCloseouts(env, { now = Date.now(), fetchImpl = fetch } = {}) {
  try {
    if (!env.DB || !env.JOBTREAD_GRANT_KEY) return null;
    await ensure(env.DB);
    const st = await readState(env.DB, STATE_KEY);
    if (now - Date.parse(st.lastAt || 0) < 60 * 60 * 1000) return null;
    await writeState(env.DB, STATE_KEY, { lastAt: new Date(now).toISOString() });
    const jobs = await closedJobs(env, HISTORY_FROM, { fetchImpl });
    const have = new Map(((await env.DB.prepare('SELECT job_id, updated_at, closed_on FROM job_closeouts').all()).results || []).map((r) => [r.job_id, r]));
    const recent = (j) => now - Date.parse(j.closedOn) < NEW_CLOSE_DAYS * 86400e3;
    // New closes first, then the ones still settling, then history
    const todo = [
      ...jobs.filter((j) => !have.has(j.id) && recent(j)),
      ...jobs.filter((j) => have.has(j.id) && now - Date.parse(j.closedOn) < 30 * 86400e3 && now - Date.parse(have.get(j.id).updated_at) > 24 * 3600e3),
      ...jobs.filter((j) => !have.has(j.id) && !recent(j)),
    ].slice(0, PER_RUN);
    let done = 0;
    for (const j of todo) {
      try { await closeOut(env, j, { now, announce: recent(j), fetchImpl }); done++; } catch { /* next hour */ }
    }
    const left = jobs.filter((j) => !have.has(j.id)).length - done;
    await writeState(env.DB, STATE_KEY, { closed: jobs.length, done, historyLeft: Math.max(0, left), error: null });
    return { closed: jobs.length, done };
  } catch (e) {
    await writeState(env.DB, STATE_KEY, { error: String(e.message).slice(0, 300) }).catch(() => {});
    return null;
  }
}

/** A job's suggested budget: rooms from its profile (or `rooms` given), its current JobTread budget alongside */
export async function budgetFor(env, jobId, { rooms = null, fetchImpl = fetch } = {}) {
  const [closeouts, { budget }, kid] = await Promise.all([readCloseouts(env.DB), jobCostSources(env, jobId, { fetchImpl }), kidFor(env.DB, jobId)]);
  const builds = kid ? buildsOf(kid.data) : null;
  const n = Number(rooms) > 0 ? Math.min(Math.round(Number(rooms)), 20) : builds ? roomTotal(builds) : 0;
  const history = codeHistory(closeouts);
  return {
    jobId, kidSlug: kid?.slug || null, builds, roomsFromProfile: builds ? roomTotal(builds) : 0,
    history: { jobs: history.jobs, all: closeouts.length },
    ...suggestBudget(history, { rooms: n || 1, current: budget }),
  };
}

/**
 * Put suggested lines on the job's budget in JobTread: only codes it has
 * none of yet, one line per code named after the code. → { added: [{ codeId, id }], skipped }
 */
export async function addBudgetLines(env, jobId, lines, { fetchImpl = fetch } = {}) {
  const { budget } = await jobCostSources(env, jobId, { fetchImpl });
  const have = new Set(budget.map((b) => b.costCodeId).filter(Boolean));
  const codes = await costCodes(env).catch(() => []);
  const added = [];
  let skipped = 0;
  for (const l of lines || []) {
    const cents = Math.round(Number(l.cents) || 0);
    if (!l.codeId || l.codeId === UNCODED || have.has(l.codeId) || cents <= 0 || !codes.some((c) => c.id === l.codeId)) { skipped++; continue; }
    const name = codes.find((c) => c.id === l.codeId)?.name || 'Budget';
    const made = await pave(env.JOBTREAD_GRANT_KEY, {
      createCostItem: {
        $: { jobId, name, costCodeId: l.codeId, quantity: 1, unitCost: cents / 100, unitPrice: cents / 100, description: 'From the budget builder (past close-outs)' },
        createdCostItem: { id: {} },
      },
    }, fetchImpl);
    const id = made?.createCostItem?.createdCostItem?.id;
    if (!id) throw new Error(`JobTread didn’t add the ${name} line`);
    added.push({ codeId: l.codeId, id });
    have.add(l.codeId);
  }
  return { added, skipped };
}

export { BUILDS };
