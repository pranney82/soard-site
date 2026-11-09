/**
 * /api/job-home — a makeover job's home, from JobTread (Admin → Kids, the Home card)
 * ===========================================================================
 * Behind Cloudflare Access (not in the middleware's public list), staff only.
 *
 * GET ?job=<jobId> → { job, home, fields }: the job's location (street, town,
 * a link to it in JobTread) with its custom field values by field id, and
 * SOARD's location fields (id, name, type, order). Read live each time, so
 * the card says what JobTread says now. Nothing is written. See ./_home.js.
 */
import { jobHome } from './_home.js';

const ok = (body = {}) => Response.json({ success: true, ...body }, { headers: { 'Cache-Control': 'no-store' } });
const fail = (error, status = 400) => Response.json({ success: false, error }, { status, headers: { 'Cache-Control': 'no-store' } });

export async function onRequestGet({ env, request }) {
  const job = new URL(request.url).searchParams.get('job') || '';
  try {
    return ok(await jobHome(env, job));
  } catch (e) {
    // Never 502: Cloudflare swaps a 502 body for its own error page
    const status = [400, 404, 503].includes(e.status) ? e.status : 500;
    return fail(e.message || 'Couldn’t read JobTread', status);
  }
}
