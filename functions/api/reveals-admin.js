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
 *     unmatched,                 upcoming reveal dates on jobs no kid page matches
 *     updatedAt }
 *
 * Rules: a reveal date before today (Eastern) is dropped; midnight Eastern
 * means no time yet; kids are matched to jobs exactly like the public feed
 * (name + year, ambiguous = no match), see ./_reveals.js.
 */

import {
  JT_URL, SOARD_ORG_ID, FIELD_REVEAL_DATE, FIELD_REVEAL_CONFIRMED,
  matchKid, easternParts, todayEastern,
} from './_reveals.js';
import { FIELD_STATUS, loadAllKids } from './_kid-status.js';

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

/** Upcoming reveals (confirmed and tentative) plus a kid → job map */
export function buildAdminView(jobs, kids, now = Date.now()) {
  const today = todayEastern(now);
  const links = {};
  const statuses = {};
  const reveals = [];
  let unmatched = 0;
  for (const job of jobs) {
    const kid = matchKid(job.name, kids);
    // A kid can only match a job from their own year; prefer the open one if there are two
    const values = {};
    for (const v of job.customFieldValues?.nodes || []) values[v.customField?.id] = v.value;
    if (kid && (!links[kid.slug] || !job.closedOn)) { links[kid.slug] = job.id; statuses[kid.slug] = values[FIELD_STATUS] || null; }
    if (job.closedOn) continue;

    const startsAt = values[FIELD_REVEAL_DATE];
    const parts = startsAt ? easternParts(startsAt) : null;
    if (!parts || parts.date < today) continue;
    if (!kid) { unmatched++; continue; }
    reveals.push({
      slug: kid.slug,
      name: kid.name,
      startsAt: new Date(startsAt).toISOString(),
      date: parts.date,
      time: parts.time,
      confirmed: String(values[FIELD_REVEAL_CONFIRMED] || '').trim().toLowerCase().startsWith('yes'),
      jobId: job.id,
    });
  }
  reveals.sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  const seen = new Set();
  return { reveals: reveals.filter((r) => (seen.has(r.slug) ? false : seen.add(r.slug))), jobs: links, statuses, unmatched };
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
      const [jobs, kids] = await Promise.all([fetchAllJobs(env.JOBTREAD_GRANT_KEY), loadAllKids(env.DB)]);
      memo = { at: now, value: { ...buildAdminView(jobs, kids, now), updatedAt: new Date(now).toISOString() } };
    }
    return Response.json({ success: true, ...memo.value }, { headers });
  } catch (err) {
    // 500, not 502: Cloudflare replaces 502 bodies with its own error page
    return Response.json({ success: false, error: err.message, reveals: [], jobs: {} }, { status: 500, headers });
  }
}
