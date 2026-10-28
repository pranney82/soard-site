/**
 * The kid's photo as their JobTread job's cover photo
 * ===========================================================================
 * Peter, Oct 20 2026: "i want the kids phoots as the JT job cover photo
 * instead of the google map thing". DataX used to put a Google Street View
 * picture of the house on every new job; he turned that off the same day.
 *
 *   - A job made when a family is approved (./_applicant-approved.js) starts
 *     with the child's photo from their application (the "Child Name.jpg"
 *     file the form attached to the account).
 *   - Once the kid's profile has photos (Admin → Kids; the family photos are
 *     usually taken after the job exists), the best one is the cover: the
 *     Main photo, else the gallery's first. It goes up as soon as the profile
 *     is saved (./save-content.js), follows every change of Main photo or its
 *     focal point, and the hourly sync catches anything missed. The first run
 *     does this for every job already linked to a profile.
 *
 *   - An organization's job shows its Community project's Main photo the same
 *     way (job_covers.slug is "community/<slug>" for those).
 *
 * A cover is only set when the photo behind it changes (job_covers remembers
 * which one each job has), so a cover someone picks by hand in JobTread stays
 * until the profile's Main photo changes. Rides the kid status sync
 * (./_kid-status.js): JobTread's workflows for one job, the hourly sweep for
 * all of them, a few jobs per run.
 */

import { pave, SOARD_ORG_ID, cfImageId } from './_reveals.js';
import { focusGravity } from '../../public/admin/kids-shared.js';

const SITE = 'https://sunshineonaranneyday.com';
const CF_HASH = 'ROYFuPmfN2vPS6mt5sCkZQ';
const PER_RUN = 8;
const iso = (t = Date.now()) => new Date(t).toISOString();

/**
 * The profile's Main photo as a cover, or null: { source, url }. `source`
 * names the photo and its focal point, so moving the focal point counts as a
 * change; `url` is a 3:2 crop the size JobTread shows, centered the way the
 * site centers it, always a JPEG (a fetcher that accepts AVIF would get AVIF).
 */
export function coverOf(kid) {
  const best = bestPhotoOf(kid);
  if (!best) return null;
  return {
    source: `photo:${best.id}@${best.gravity}`,
    url: photoUrl(best, 'w=1500,h=1000,fit=cover', 'q=85,format=jpeg'),
  };
}

/**
 * The profile's best photo, or null: { id, gravity }. The Main photo staff
 * picked (top of the page, the Meet the Kids card), else the gallery's first,
 * centered on its focal point. Also the kid's avatar in Admin → Applicants.
 */
export function bestPhotoOf(kid) {
  const hero = kid?.heroImage || kid?.photos?.find((p) => p?.url)?.url;
  const id = hero ? cfImageId(hero) : null;
  if (!id) return null;
  const photo = (kid.photos || []).find((p) => p?.url && cfImageId(p.url) === id);
  return { id, gravity: focusGravity(photo) };
}

/** A best photo as a Cloudflare Images URL: `fit` the crop, `extra` quality and format */
export const photoUrl = ({ id, gravity }, fit, extra) => `${SITE}/cdn-cgi/imagedelivery/${CF_HASH}/${id.split('/').map(encodeURIComponent).join('/')}/${fit},gravity=${gravity},${extra}`;

async function ensureTable(DB) {
  await DB.prepare(`CREATE TABLE IF NOT EXISTS job_covers (
    job_id TEXT PRIMARY KEY, source TEXT, slug TEXT, set_at TEXT, error TEXT, updated_at TEXT NOT NULL)`).run();
}

/** Remember the photo a job's cover now shows */
export async function rememberCover(DB, jobId, { source, slug = null, error = null }, now = Date.now()) {
  await ensureTable(DB);
  await DB.prepare(`INSERT INTO job_covers (job_id, source, slug, set_at, error, updated_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(job_id) DO UPDATE SET source = COALESCE(excluded.source, job_covers.source), slug = COALESCE(excluded.slug, job_covers.slug),
      set_at = COALESCE(excluded.set_at, job_covers.set_at), error = excluded.error, updated_at = excluded.updated_at`)
    .bind(jobId, error ? null : source, slug, error ? null : iso(now), error, iso(now)).run();
}

/** The child's photo from the site's application for this account: its JobTread file id, or null */
export async function applicationPhotoFile(DB, accountId) {
  try {
    const row = await DB.prepare('SELECT jt_state FROM applications WHERE jt_account_id = ?').bind(accountId).first();
    return JSON.parse(row?.jt_state || '{}')?.files?.photoChild?.id || null;
  } catch {
    return null; // no applications table, or a family who didn't apply on the site
  }
}

/** Point the job's cover at an existing JobTread file */
export async function coverFromFile(env, jobId, fileId, fetchImpl = fetch) {
  // update* returns the query root: select nothing
  await pave(env.JOBTREAD_GRANT_KEY, { updateJob: { $: { id: jobId, coverPhoto: { fileId } } } }, fetchImpl);
}

/** JobTread fetches the photo from the site, then the job's cover shows it */
async function coverFromUrl(env, jobId, url, fetchImpl) {
  const up = await pave(env.JOBTREAD_GRANT_KEY, { createUploadRequest: { $: { url, organizationId: SOARD_ORG_ID }, createdUploadRequest: { id: {} } } }, fetchImpl);
  const uploadRequestId = up?.createUploadRequest?.createdUploadRequest?.id;
  if (!uploadRequestId) throw new Error('JobTread didn’t take the photo');
  await pave(env.JOBTREAD_GRANT_KEY, { updateJob: { $: { id: jobId, coverPhoto: { uploadRequestId } } } }, fetchImpl);
}

/**
 * Covers for linked jobs whose profile's Main photo isn't on the job yet.
 * `links`: Map of kid slug → job ({ id }); `kids`: [{ slug, data }].
 * Returns [{ slug, jobId }] set this run. Never throws.
 */
export async function syncJobCovers(env, links, kids, { fetchImpl = fetch, now = Date.now(), limit = PER_RUN } = {}) {
  const out = [];
  try {
    const { DB } = env;
    if (!DB || !env.JOBTREAD_GRANT_KEY || !links?.size) return out;
    await ensureTable(DB);
    const { results } = await DB.prepare('SELECT job_id, source FROM job_covers').all();
    const have = new Map((results || []).map((r) => [r.job_id, r.source]));
    for (const [slug, job] of links) {
      if (out.length >= limit) break;
      const cover = coverOf(kids.find((k) => k.slug === slug)?.data);
      if (!cover || have.get(job.id) === cover.source) continue;
      try {
        await coverFromUrl(env, job.id, cover.url, fetchImpl);
        await rememberCover(DB, job.id, { source: cover.source, slug }, now);
        out.push({ slug, jobId: job.id });
      } catch (e) {
        // Kept for the next run; one photo JobTread can't fetch doesn't stop the rest
        await rememberCover(DB, job.id, { slug, error: String(e.message || e).slice(0, 200) }, now);
      }
    }
  } catch (e) {
    console.error('[job-covers]', e.message);
  }
  return out;
}

/** For Site → Automations: how many jobs show a kid's photo, and the last one set */
export async function coverFacts(DB) {
  await ensureTable(DB);
  const [n, last, failing] = await Promise.all([
    DB.prepare('SELECT count(*) AS n FROM job_covers WHERE source IS NOT NULL').first('n'),
    DB.prepare('SELECT slug, set_at FROM job_covers WHERE set_at IS NOT NULL ORDER BY set_at DESC LIMIT 1').first(),
    DB.prepare('SELECT count(*) AS n FROM job_covers WHERE error IS NOT NULL').first('n'),
  ]);
  return { covers: n || 0, last: last ? { slug: last.slug, at: last.set_at } : null, failing: failing || 0 };
}
