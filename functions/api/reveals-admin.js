/**
 * GET /api/reveals-admin (Cloudflare Access) — reveal dates and JobTread links for staff
 * ===========================================================================
 * The public /api/reveals only ever returns confirmed reveals. Staff also need
 * the tentative ones: a reveal date stays tentative until the job's
 * "Reveal Date Confirmed" field is Yes. This route isn't in _middleware's
 * public list, so Access guards it, and it is never cached at the edge.
 *
 * → { success, reveals: [{ slug, name, startsAt, date, time, confirmed, jobId }],
 *     jobs: { [slug]: jobId },   every kid matched to a JobTread job, open or closed
 *     statuses: { [slug]: status },  that job's JobTread Status (the site's kid status follows it, ./_kid-status.js)
 *     projectJobs, projectStatuses,  the same for community projects (an organization's job)
 *     projectReveals: [{ slug, name, startsAt, date, time, confirmed, jobId }],  their reveal dates
 *     unmatched,                 upcoming reveal dates on jobs no kid page or project matches
 *     updatedAt }
 *
 * Rules: a reveal date before today (Eastern) is dropped; midnight Eastern
 * means no time yet; kids and community projects are matched to jobs exactly
 * like the public feed and the status sync (name + year, or the job a
 * project is linked to; ambiguous = no match), see ./_reveals.js.
 */

import {
  JT_URL, SOARD_ORG_ID, FIELD_REVEAL_DATE, FIELD_REVEAL_CONFIRMED,
  matchProject, isProject, easternParts, todayEastern,
} from './_reveals.js';
import { FIELD_STATUS, loadAllKids, loadAllProjects } from './_kid-status.js';

const MAX_PAGES = 8;
const MEMO_MS = 60 * 1000;
let memo = null; // { at, value } per isolate, so a busy dashboard doesn't hammer JobTread

/** Every SOARD job, open and closed, with its custom field values */
export async function fetchAllJobs(grantKey, fetchImpl = fetch) {
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
              nodes: { id: {}, name: {}, closedOn: {}, customFieldValues: { $: { size: 50 }, nodes: { value: {}, customField: { id: {} } } } },
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

/** Upcoming reveals (confirmed and tentative) plus a kid → job map, and the same for community projects */
export function buildAdminView(jobs, kids, now = Date.now(), projects = []) {
  const today = todayEastern(now);
  const records = [...kids, ...projects];
  const kidSide = { jobs: {}, statuses: {}, reveals: [] };
  const projectSide = { jobs: {}, statuses: {}, reveals: [] };
  let unmatched = 0;
  for (const job of jobs) {
    const hit = matchProject(job.name, records, job.id);
    const side = isProject(hit) ? projectSide : kidSide;
    // A kid can only match a job from their own year; prefer the open one if there are two
    const values = {};
    for (const v of job.customFieldValues?.nodes || []) values[v.customField?.id] = v.value;
    if (hit && (!side.jobs[hit.slug] || !job.closedOn)) { side.jobs[hit.slug] = job.id; side.statuses[hit.slug] = values[FIELD_STATUS] || null; }
    if (job.closedOn) continue;

    const startsAt = values[FIELD_REVEAL_DATE];
    const parts = startsAt ? easternParts(startsAt) : null;
    if (!parts || parts.date < today) continue;
    if (!hit) { unmatched++; continue; }
    side.reveals.push({
      slug: hit.slug,
      name: hit.name,
      startsAt: new Date(startsAt).toISOString(),
      date: parts.date,
      time: parts.time,
      confirmed: String(values[FIELD_REVEAL_CONFIRMED] || '').trim().toLowerCase().startsWith('yes'),
      jobId: job.id,
    });
  }
  const soonest = (list) => {
    const seen = new Set();
    return list.sort((a, b) => a.startsAt.localeCompare(b.startsAt)).filter((r) => (seen.has(r.slug) ? false : seen.add(r.slug)));
  };
  return {
    reveals: soonest(kidSide.reveals), jobs: kidSide.jobs, statuses: kidSide.statuses,
    projectReveals: soonest(projectSide.reveals), projectJobs: projectSide.jobs, projectStatuses: projectSide.statuses,
    unmatched,
  };
}

export async function onRequestGet(context) {
  const { env } = context;
  const headers = { 'Cache-Control': 'private, no-store' };
  if (!env.JOBTREAD_GRANT_KEY) {
    return Response.json({ success: false, error: 'JOBTREAD_GRANT_KEY is not set', reveals: [], jobs: {} }, { status: 500, headers });
  }
  try {
    const now = Date.now();
    if (!memo || now - memo.at > MEMO_MS) {
      // Hidden profiles too: a kid JobTread keeps off the site still links to its job here
      const [jobs, kids, projects] = await Promise.all([fetchAllJobs(env.JOBTREAD_GRANT_KEY), loadAllKids(env.DB), loadAllProjects(env.DB)]);
      memo = { at: now, value: { ...buildAdminView(jobs, kids, now, projects), updatedAt: new Date(now).toISOString() } };
    }
    return Response.json({ success: true, ...memo.value }, { headers });
  } catch (err) {
    // 500, not 502: Cloudflare replaces 502 bodies with its own error page
    return Response.json({ success: false, error: err.message, reveals: [], jobs: {} }, { status: 500, headers });
  }
}
