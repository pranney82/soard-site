/**
 * What finished makeovers cost, from JobTread, for the board page
 * ===========================================================================
 * Travis Couick (the board's Qualification Committee, Nov 4 2026) asked for
 * what makeovers cost and what the money in hand can start. Peter: "i just
 * want the actual costs of completed makeovers and their room/job type".
 *
 *   makeovers   each finished makeover: its kid (or community project), its
 *               season, its rooms and type (../../public/admin/makeover-costs-shared.js),
 *               and what SOARD paid: the approved vendor bills on its job
 *               (JobTread's actualCost). Two jobs for one kid add up.
 *   noBills     finished makeovers with no bills in JobTread (donated whole,
 *               or paid before JobTread): named, never counted as $0
 *   waiting     families approved and waiting on the money (Awaiting
 *               Funding), best score first, each with its rooms, type, and
 *               its sponsors' pledges (./_sponsor-pledges.js)
 *   reveals     each makeover's Reveal task (its date, and whether it's done), for
 *               how many SOARD builds a year: the recommended pipeline is what it
 *               can produce, funding following as the reserve builds (Peter, Nov
 *               4 2026: "recommended pipeline is related to how many we can actually
 *               produce"); with `plan` (staff's "Makeovers in <year>" in Applicants)
 *   underway    every open job being built (Design to Build), kids' and
 *               community projects': what's been paid (its bills) and its
 *               JobTread budget, for what's still to come (Peter, Nov 4 2026:
 *               "we should take into account the open jobs and what has been
 *               spent and what is anticipated of being spent still";
 *               ../../public/admin/makeover-costs-shared.js planOf)
 *
 * Finished = Status Closed Done or Warranty, or closed in JobTread before jobs
 * had a Status. Never "the job is closed": nine finished makeovers were still
 * open in JobTread on Nov 4 2026. A job counts only once it's matched to a kid
 * page or a community project (the office sandbox, the store's job and the
 * warranty job aren't makeovers): by its id, then by name and season (as the
 * reveal dates match), then, for jobs named before that ("Job 8", "Ava-
 * Bedroom"), by the customer's name in JobTread and the years the job ran,
 * only when exactly one page fits. A finished job with no page still counts
 * when it says what it was: rooms in its description (a 2023 bathroom and
 * bedroom with no page, under the child's first name), or a school or clinic as its customer
 * (a community project).
 *
 * One JobTread read (every job, about one page) every 15 minutes, by the board's
 * heartbeat (./_board.js maybeRunBoard), kept in board_state 'costs'; a board
 * page reads that copy and never waits on JobTread for it (only with no copy,
 * or one six hours old: the heartbeat stopped). The scores and pledges are read
 * fresh from D1.
 */

import { JT_URL, SOARD_ORG_ID, FIELD_JOB_STATUS, BUILDING_STATUSES, isRehearsalJob, matchProject, normalizeName, yearsOf, isProject } from './_reveals.js';
import { readState, writeState } from './_board-roles.js';
import { roomList, typeOf } from '../../public/admin/makeover-costs-shared.js';
import { scoreSummaries } from './_applicant-scores.js';
import { pledgesFor } from './_sponsor-pledges.js';
import { REVEAL_TASK_TYPE } from './_kid-status.js';

/** What comes off a family's cost. The Advisory Board's is money it has already raised, so it's in the bank's cash already */
export const countedPledges = (list) => list.filter((p) => p.slug !== 'soard-advisory-board');

const MAX_PAGES = 10;
const FRESH_MS = 15 * 60 * 1000;
/** A page reads the heartbeat's copy up to this old before it reads JobTread itself */
export const PAGE_MAX_AGE_MS = 6 * 60 * 60 * 1000;
export const FINISHED = new Set(['Closed Done', 'Warranty']);
export const AWAITING = 'Awaiting Funding';
// Words a job's name carries that aren't anyone's name ("Ava- Bedroom", "Ben-Bedroom/Bathroom")
const NOT_NAMES = new Set(['bedroom', 'bathroom', 'bath', 'therapy', 'room', 'rooms', 'dream', 'accessible', 'in', 'home', 'and', 'the', 'of', 'makeover', 'job', 'jr', 'sr', 'ii', 'iii']);

// Applicants' Makeover type, in the kid pages' words
const APPLIED_ROOM = { Bedroom: 'Dream Bedroom', Bathroom: 'Accessible Bathroom', 'Therapy Room': 'Therapy Room', Ramp: 'Wheelchair Ramp' };
const yearOf = (d) => { const y = Number(String(d || '').slice(0, 4)); return y > 2000 && y < 2100 ? y : null; };
const parse = (s, d = {}) => { try { return s == null ? d : JSON.parse(s) ?? d; } catch { return d; } };
const photoOf = (url) => (/^(https:\/\/imagedelivery\.net\/|\/cdn-cgi\/imagedelivery\/)[\w/=,.-]+$/.test(String(url || '')) ? String(url) : null);
const cents = (n) => Math.round(Number(n || 0) * 100) / 100;

/** Every SOARD job, open and closed, with what a cost needs (follows pagination) */
export async function fetchCostJobs(grantKey, fetchImpl = fetch) {
  const jobs = [];
  let page = null;
  for (let i = 0; i < MAX_PAGES; i++) {
    const res = await fetchImpl(JT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query: {
          $: { grantKey },
          organization: {
            $: { id: SOARD_ORG_ID },
            jobs: {
              $: { size: 100, ...(page ? { page } : {}) },
              nextPage: {},
              nodes: {
                id: {}, name: {}, description: {}, createdAt: {}, closedOn: {}, actualCost: {},
                // The job's budget: its own cost lines (those on no document), summed
                budgetCost: { _: 'costItems', $: { where: [['document', 'id'], null] }, sum: { $: 'cost' } },
                // Its Reveal task: when it's set for, and whether it's done (one a job)
                revealTask: { _: 'tasks', $: { where: [['taskType', 'id'], REVEAL_TASK_TYPE], size: 1 }, nodes: { endDate: {}, completed: {} } },
                location: { account: { name: {} } },
                customFieldValues: { $: { size: 1, where: [['customField', 'id'], '=', FIELD_JOB_STATUS] }, nodes: { value: {} } },
              },
            },
          },
        },
      }),
    });
    if (!res.ok) throw new Error(`JobTread returned ${res.status}`);
    const body = await res.json();
    const conn = body?.organization?.jobs;
    if (!conn) throw new Error('JobTread response had no jobs');
    jobs.push(...(conn.nodes || []));
    page = conn.nextPage || null;
    if (!page) break;
  }
  return jobs;
}

/**
 * Every kid page and community project, with their rooms, season, sponsors and photo. A draft too: a family just
 * approved has a hidden page (./_applicant-approved.js), and the board may see their name; a photo and a link only
 * once the page is public
 */
export async function loadCostRecords(DB) {
  const read = async (sql) => { try { return (await DB.prepare(sql).all()).results || []; } catch { return []; } };
  const [kids, community] = await Promise.all([read('SELECT slug, name, year, data FROM kids'), read('SELECT slug, name, data FROM community')]);
  const out = [];
  for (const r of kids) {
    const d = parse(r.data);
    const published = d.publishStatus !== 'draft';
    out.push({
      slug: r.slug, name: String(d.name || r.name || '').trim(), year: r.year ?? d.year ?? null, jobtreadJobId: d.jobtreadJobId || null,
      rooms: roomList(d.roomTypes), roomCount: Number(d.roomCount) || null, sponsors: Array.isArray(d.sponsors) ? d.sponsors.filter((s) => typeof s === 'string') : [],
      photo: published ? photoOf(d.heroImage || d.photos?.[0]?.url) : null, url: published ? `/kids/${r.slug}/` : null,
    });
  }
  for (const r of community) {
    const d = parse(r.data);
    const published = d.publishStatus !== 'draft';
    out.push({
      kind: 'community', slug: r.slug, name: String(d.name || r.name || '').trim(), year: d.year ?? null, status: d.status || 'completed', jobtreadJobId: d.jobtreadJobId || null,
      rooms: [], sponsors: [], photo: published ? photoOf(d.heroImage || d.photos?.[0]?.url) : null, url: published && d.story ? `/community/${r.slug}/` : null,
    });
  }
  return out;
}

// A customer that's an organization, not a family: its makeover is a community project
const ORG = /\b(school|academy|clinic|center|centre|church|health|hospital|foundation|ministr\w*|camp|library|daycare|preschool|nonprofit)\b/i;
/** A finished job no page matches, as a record of its own when it says what it was (else null) */
export function recordFromJob(job) {
  const account = String(job.location?.account?.name || '').trim();
  const label = String(job.name || '').replace(/\(\d{4}\)\s*$/, '').trim();
  const named = Number((String(job.name || '').match(/\((\d{4})\)\s*$/) || [])[1]) || null;
  const year = named || yearOf(job.closedOn) || yearOf(job.createdAt);
  if (ORG.test(account) || ORG.test(label)) return { kind: 'community', slug: `job-${job.id}`, name: account || label, year, rooms: [], sponsors: [], fromJob: true };
  const rooms = roomList(job.description);
  if (!rooms.some((r) => /bath|bed|therapy/i.test(r))) return null;
  const first = label.split(/[\s-]+/)[0];
  return first ? { slug: `job-${job.id}`, name: first, year, rooms, sponsors: [], fromJob: true } : null;
}

const statusOf = (job) => String(job.customFieldValues?.nodes?.[0]?.value || '').trim();
/** Done: Closed Done or Warranty, or closed before jobs had a Status */
export const isFinished = (job) => FINISHED.has(statusOf(job)) || (!!job.closedOn && !statusOf(job));

const nameWords = (s) => normalizeName(s).split(' ').filter((t) => t && t !== 'and');

/**
 * A job named before names carried the season ("Job 8", "Ava- Bedroom", "Ben Example (2024)" for a 2025 page):
 * the customer's name in JobTread and the job's own words, against pages filed in the years the job ran (a year
 * either side). The whole name of one page first (an organization only this way); then a kid's name word, when
 * exactly one page has it. Two that fit is no match: a cost on the wrong child's makeover is worse than none
 */
export function looseMatch(job, records) {
  const words = new Set([
    ...normalizeName(String(job.name || '').replace(/\(\d{4}\)\s*$/, '')).split(' '),
    ...normalizeName(job.location?.account?.name).split(' '),
  ].filter((t) => t && !NOT_NAMES.has(t) && !/^\d+$/.test(t)));
  if (!words.size) return null;
  const named = Number((String(job.name || '').match(/\((\d{4})\)\s*$/) || [])[1]) || null;
  const from = Math.min(...[yearOf(job.createdAt), named].filter(Boolean)) - 1;
  const to = Math.max(...[yearOf(job.closedOn), yearOf(job.createdAt), named].filter(Boolean)) + 1;
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  const fits = records.filter((r) => !(r.jobtreadJobId && r.jobtreadJobId !== job.id) && yearsOf(r).some((y) => y >= from && y <= to) && nameWords(r.name).length);
  for (const test of [
    (r) => nameWords(r.name).every((t) => words.has(t)),
    (r) => !isProject(r) && nameWords(r.name).some((t) => t.length >= 3 && words.has(t)),
  ]) {
    const hits = fits.filter(test);
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) return null;
  }
  return null;
}

/** The page a job belongs to: linked by id, by name and season, then loosely (above) */
export const pageForJob = (job, records) => matchProject(job.name, records, job.id) || looseMatch(job, records);

/** The year in a job's name ("Ava Example (2026)"), or null */
const namedYearOf = (job) => Number((String(job.name || '').match(/\((\d{4})\)\s*$/) || [])[1]) || null;
const seasonOf = (r, job) => {
  const ys = yearsOf(r);
  return ys.length ? ys[ys.length - 1] : yearOf(job.closedOn) || yearOf(job.createdAt);
};
const roomsFor = (r, job) => (r.rooms?.length ? r.rooms : roomList(job.description));

/** From the jobs and the pages: { makeovers, noBills, waiting (jobs, before scores and pledges), underway, reveals, skipped } */
export function costsFrom(jobs, records) {
  const done = new Map();
  const waiting = [];
  const underway = [];
  const reveals = [];
  let skipped = 0;
  for (const job of jobs) {
    if (isRehearsalJob(job)) continue;
    const status = statusOf(job);
    const finished = isFinished(job);
    const awaiting = !job.closedOn && status === AWAITING;
    // Its reveal, for the pace: done (the task, or the makeover finished), or set for a day
    const task = job.revealTask?.nodes?.[0] || null;
    const revealOn = /^\d{4}-\d{2}-\d{2}$/.test(String(task?.endDate || '')) ? task.endDate : null;
    if (revealOn && (finished || (!job.closedOn && BUILDING_STATUSES.has(status)))) reveals.push({ on: revealOn, done: finished || Number(task.completed) === 1 });
    // Being built: what's been paid, and its budget for what's still to come
    if (!job.closedOn && BUILDING_STATUSES.has(status)) {
      const r = pageForJob(job, records);
      const rooms = r ? roomsFor(r, job) : roomList(job.description);
      const community = r ? isProject(r) : ORG.test(String(job.location?.account?.name || ''));
      const budget = Number(job.budgetCost?.sum);
      // (never a job's own name: JobTread's are internal, "Not Published Yet"; a page's name, an organization's, or
      // Applicants' in nameUnderway)
      underway.push({
        revealOn,
        // Its season: the page's year (staff's word for it, even when the job's name says otherwise), else the year in
        // the job's name, else when the job was made. A makeover counts against its own season even when it finishes late
        season: r ? seasonOf(r, job) : namedYearOf(job) || yearOf(job.createdAt),
        key: `u:${job.id}`, name: r?.name || (community ? String(job.location?.account?.name || '').trim() : ''), jobId: r ? null : job.id, kind: community ? 'community' : 'kid', status,
        rooms, type: typeOf(rooms, { community }), paid: cents(job.actualCost), budget: budget > 0 ? cents(budget) : null,
        ...(r?.photo ? { photo: r.photo } : {}), ...(r?.url ? { url: r.url } : {}),
      });
      continue;
    }
    if (!finished && !awaiting) continue;
    const r = pageForJob(job, records);
    // A family approved with no page yet still waits: named from Applicants (orderWaiting)
    if (!r && awaiting) {
      const rooms = roomList(job.description);
      waiting.push({ key: `j:${job.id}`, name: '', slug: null, kind: 'kid', season: namedYearOf(job) || yearOf(job.createdAt), rooms, type: typeOf(rooms), jobId: job.id, sponsors: [], since: job.createdAt || null });
      continue;
    }
    const own = !r && finished ? recordFromJob(job) : null;
    if (!r && !own) { if (finished && Number(job.actualCost) > 0) skipped += 1; continue; }
    if (own) {
      const rooms = own.rooms;
      const cost = cents(job.actualCost);
      done.set(`j:${job.id}`, { key: `j:${job.id}`, name: own.name, slug: null, kind: isProject(own) ? 'community' : 'kid', season: own.year, rooms, roomCount: null, type: typeOf(rooms, { community: isProject(own) }), cost, jobs: 1, closed: job.closedOn || null });
      continue;
    }
    const rooms = roomsFor(r, job);
    const base = {
      key: `${isProject(r) ? 'c' : 'k'}:${r.slug}`, name: r.name, slug: r.slug, kind: isProject(r) ? 'community' : 'kid',
      season: seasonOf(r, job), rooms, roomCount: r.roomCount || null, type: typeOf(rooms, { community: isProject(r) }),
      ...(r.photo ? { photo: r.photo } : {}), ...(r.url ? { url: r.url } : {}),
    };
    if (awaiting) {
      waiting.push({ ...base, jobId: job.id, sponsors: r.sponsors || [], since: job.createdAt || null });
      continue;
    }
    const prev = done.get(base.key);
    const cost = cents(job.actualCost);
    const closed = job.closedOn || null;
    if (prev) { prev.cost = cents(prev.cost + cost); prev.jobs += 1; prev.closed = [prev.closed, closed].filter(Boolean).sort().at(-1) || null; }
    else done.set(base.key, { ...base, cost, jobs: 1, closed });
  }
  const all = [...done.values()];
  const byName = (a, b) => (Number(b.season) || 0) - (Number(a.season) || 0) || a.name.localeCompare(b.name);
  return {
    makeovers: all.filter((m) => m.cost > 0).sort(byName),
    noBills: all.filter((m) => !(m.cost > 0)).map(({ key, name, season, type, kind }) => ({ key, name, season, type, kind })).sort(byName),
    waiting,
    reveals: reveals.sort((a, b) => a.on.localeCompare(b.on)),
    // Furthest along first (Build, then Mobilization … Design)
    underway: underway.sort((a, b) => STAGE.indexOf(b.status) - STAGE.indexOf(a.status) || a.name.localeCompare(b.name)),
    skipped,
  };
}
const STAGE = ['Design', 'Finalization', 'Approval', 'Mobilization', 'Build'];

/**
 * The waiting families, in the order they'd be funded: the Qualification Committee's score (ranked ones, best
 * first), then the ones not scored yet, longest waiting first. Each with its sponsors' pledges and its score.
 * Scores come through Applicants (the family's JobTread account is linked to the job)
 */
export async function orderWaiting(DB, waiting) {
  if (!waiting.length) return [];
  const [scores, links, pledges] = await Promise.all([
    scoreSummaries(DB).catch(() => new Map()),
    (async () => {
      try {
        const ids = waiting.map((w) => w.jobId);
        const rows = (await DB.prepare(`SELECT account_id, job_id, name, types FROM applicants WHERE job_id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all()).results || [];
        return new Map(rows.map((r) => [r.job_id, { account: r.account_id, name: r.name, types: parse(r.types, []) }]));
      } catch { return new Map(); }
    })(),
    pledgesFor(DB, waiting.filter((w) => w.kind === 'kid').map((w) => w.slug)).catch(() => ({})),
  ]);
  const names = await partnerNames(DB, [...new Set(waiting.flatMap((w) => w.sponsors || []))]);
  const out = waiting.map(({ jobId, sponsors, ...w }) => {
    const link = links.get(jobId) || null;
    const account = link?.account || null;
    const s = account ? scores.get(account) : null;
    // No rooms on the page (or no page): what the family asked for on their application
    if (!w.rooms?.length && link?.types?.length) {
      w.rooms = roomList(link.types.map((t) => APPLIED_ROOM[t] || t));
      w.type = typeOf(w.rooms);
    }
    if (!w.name) w.name = String(link?.name || '').trim() || 'A family';
    const mine = pledges[w.slug] || {};
    const list = (sponsors || []).map((slug) => ({ slug, name: names[slug] || slug, pledged: mine[slug]?.pledged || 0, received: mine[slug]?.received || 0 }));
    return {
      ...w, account,
      score: s && s.count ? { total: s.total, tier: s.tier, ranked: !!s.ranked, count: s.count, of: s.of } : null,
      sponsors: list,
      pledged: countedPledges(list).reduce((n, p) => n + (p.pledged || 0), 0),
      received: countedPledges(list).reduce((n, p) => n + (p.received || 0), 0),
    };
  });
  const ranked = (w) => (w.score?.ranked ? 0 : 1);
  return out.sort((a, b) => ranked(a) - ranked(b) || (b.score?.ranked ? b.score.total : 0) - (a.score?.ranked ? a.score.total : 0) || String(a.since || '').localeCompare(String(b.since || '')) || a.name.localeCompare(b.name));
}

/** The season applications are for, and how many makeovers staff plan for each (Applicants → Scores): { season, capacity: { [year]: n } } */
export async function seasonPlan(DB) {
  const [{ applicationSettings, cleanYear }, { capacities }] = await Promise.all([import('./_applications.js'), import('./_applicant-scores.js')]);
  const [settings, caps] = await Promise.all([applicationSettings(DB).catch(() => ({})), capacities(DB).catch(() => ({}))]);
  return { season: settings?.year ? cleanYear(settings.year) : null, capacity: Object.fromEntries(Object.entries(caps || {}).map(([y, c]) => [y, Number(c?.count) || 0]).filter(([, n]) => n > 0)) };
}

/** Open jobs with no page: the family's name from Applicants (the account linked to the job), else "A family"; never the job's id */
export async function nameUnderway(DB, underway) {
  const ids = underway.filter((u) => !u.name && u.jobId).map((u) => u.jobId);
  let names = new Map();
  if (ids.length) {
    try {
      const rows = (await DB.prepare(`SELECT job_id, name FROM applicants WHERE job_id IN (${ids.map(() => '?').join(',')})`).bind(...ids).all()).results || [];
      names = new Map(rows.map((r) => [r.job_id, String(r.name || '').trim()]));
    } catch { /* no Applicants mirror (tests) */ }
  }
  return underway.map(({ jobId, ...u }) => ({ ...u, name: u.name || names.get(jobId) || 'A family' }));
}

async function partnerNames(DB, slugs) {
  if (!slugs.length) return {};
  try {
    const rows = (await DB.prepare(`SELECT slug, data FROM partners WHERE slug IN (${slugs.map(() => '?').join(',')})`).bind(...slugs).all()).results || [];
    return Object.fromEntries(rows.map((r) => [r.slug, String(parse(r.data).name || r.slug)]));
  } catch { return {}; }
}

/**
 * The board's copy: { at, makeovers, noBills, waiting, skipped }. JobTread once the copy is `maxAge` old (15 minutes:
 * the heartbeat; a page passes PAGE_MAX_AGE_MS), the last good copy when it doesn't answer; the waiting families'
 * scores and pledges as they are now. null with neither
 */
export async function makeoverCostsNow(env, { fetchImpl = fetch, now = Date.now(), fresh = false, maxAge = FRESH_MS } = {}) {
  const cached = await readState(env.DB, 'costs');
  let value = cached.value || null;
  // (a copy from before the open jobs were read is read again at once)
  const stale = !cached.at || now - Date.parse(cached.at) >= maxAge || !Array.isArray(cached.value?.underway) || !Array.isArray(cached.value?.reveals)
    // (a copy saved before each job carried its season)
    || cached.value.underway.some((u) => !('season' in u));
  if ((fresh || stale) && env.JOBTREAD_GRANT_KEY) {
    try {
      const [jobs, records] = await Promise.all([fetchCostJobs(env.JOBTREAD_GRANT_KEY, fetchImpl), loadCostRecords(env.DB)]);
      value = { at: new Date(now).toISOString(), ...costsFrom(jobs, records) };
      await writeState(env.DB, 'costs', { at: value.at, value });
    } catch (err) {
      console.error('[board] costs', err.message);
    }
  }
  if (!value) return null;
  const [waiting, underway, plan] = await Promise.all([orderWaiting(env.DB, value.waiting || []), nameUnderway(env.DB, value.underway || []), seasonPlan(env.DB)]);
  return { ...value, waiting, underway, plan };
}
