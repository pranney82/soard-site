/**
 * GET /api/kid-homes
 * =============================================
 * Where each kid's home is on the map: the location of their JobTread job,
 * matched exactly as Reveals and the status sync match them (./reveals-admin.js
 * buildAdminView: name + year, the job a profile is linked to, the open job
 * first). Admin → Kids → Upload photos and videos uses it to tell whose photos
 * these are: a phone photo carries where it was taken, and a photo taken at a
 * family's home is that kid's (public/admin/kid-guess.js).
 *
 * Returns { success, homes: [{ slug, lat, lng }] }: map points only, never an
 * address. Staff only (Cloudflare Access, the middleware's default), never
 * cached by a browser or the edge, and never written to a kid's record (the
 * repo is public).
 */

import { fetchAllJobs, buildAdminView } from './reveals-admin.js';
import { loadAllKids, loadAllProjects } from './_kid-status.js';

const MEMO_MS = 10 * 60 * 1000;
let memo = null; // { at, homes } per isolate: a home doesn't move

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Each kid with a job whose location has a map point: [{ slug, lat, lng }] */
export function kidHomes(jobs, kids, projects = []) {
  const { jobs: kidJobs } = buildAdminView(jobs, kids, Date.now(), projects);
  const byId = new Map(jobs.map((j) => [j.id, j]));
  const homes = [];
  for (const [slug, jobId] of Object.entries(kidJobs)) {
    const loc = byId.get(jobId)?.location;
    const lat = num(loc?.latitude);
    const lng = num(loc?.longitude);
    if (lat === null || lng === null || (lat === 0 && lng === 0)) continue;
    homes.push({ slug, lat, lng });
  }
  return homes;
}

export async function onRequestGet(context) {
  const { env } = context;
  const headers = { 'Cache-Control': 'private, no-store' };
  if (!env.JOBTREAD_GRANT_KEY) return Response.json({ success: false, error: 'JOBTREAD_GRANT_KEY is not set', homes: [] }, { status: 500, headers });
  try {
    const now = Date.now();
    if (!memo || now - memo.at > MEMO_MS) {
      const [jobs, kids, projects] = await Promise.all([
        fetchAllJobs(env.JOBTREAD_GRANT_KEY, fetch, { location: { latitude: {}, longitude: {} } }),
        loadAllKids(env.DB),
        loadAllProjects(env.DB),
      ]);
      memo = { at: now, homes: kidHomes(jobs, kids, projects) };
    }
    return Response.json({ success: true, homes: memo.homes }, { headers });
  } catch (err) {
    // 500, not 502: Cloudflare replaces 502 bodies with its own error page
    return Response.json({ success: false, error: err.message, homes: [] }, { status: 500, headers });
  }
}
