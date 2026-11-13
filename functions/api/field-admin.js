/**
 * /api/field-admin (Cloudflare Access, staff) — the person's own JobTread connection, and the backup photo page
 * (/admin/photos/) for a phone whose Claude app won't open the camera from inside a chat (./_field.js).
 *
 * GET ?connect=1[&back=/admin/…]  → JobTread's sign-in; it comes back through /api/jobtread-callback
 * GET                             → { connection: { linked, name, since, broken } }
 * GET ?job=<id>[&date=YYYY-MM-DD] → { connection, job: { id, name }, date, log, jobUrl } for the photo page
 * POST { action } (JSON):
 *   slots { files: [{ name, type, size }] }             → { slots }: a place in JobTread's storage for each
 *   done { jobId, date, logId?, files: [{ uploadId, name }] } → the photos on the person's log for that day
 *   unlink                                               the site forgets their JobTread key
 *
 * Everything is done with the person's own key, so JobTread shows their name. Not connected (or JobTread no
 * longer takes the key): 409 { connect } with the address to connect. A key never leaves the server.
 */

import { isStaffEmail } from './_board-roles.js';
import { asPerson, startLink, linkStatus, unlink, ownLog, photoSlots, photosDone, jobUrl, CONNECT_URL } from './_field.js';
import { logAudit } from './_audit.js';

const fail = (error, status = 400, extra = {}) => Response.json({ ok: false, error, ...extra }, { status, headers: { 'Cache-Control': 'no-store' } });
const ok = (data) => Response.json({ ok: true, ...data }, { headers: { 'Cache-Control': 'no-store' } });
const fromError = (err) => (err?.code === 'LINK' ? fail(err.message, 409, { connect: CONNECT_URL }) : fail(String(err?.message || 'That didn’t work'), 502));

const me = (context) => String(context.data?.userEmail || '').toLowerCase();

export async function onRequestGet(context) {
  const { env, request } = context;
  const email = me(context);
  if (!isStaffEmail(email)) return fail('This is for SOARD staff', 403);
  const q = new URL(request.url).searchParams;
  try {
    if (q.get('connect')) {
      const url = await startLink(env, email, { back: q.get('back') || '' });
      return new Response(null, { status: 302, headers: { Location: url, 'Cache-Control': 'no-store' } });
    }
    const connection = await linkStatus(env, email);
    const jobId = q.get('job');
    if (!jobId) return ok({ connection });
    if (!/^[A-Za-z0-9]{10,16}$/.test(jobId)) return fail('That isn’t a job’s id');
    if (!connection.linked) return fail('Connect your JobTread first', 409, { connect: CONNECT_URL, connection });
    const p = await asPerson(env, email);
    const r = await ownLog(p, jobId, q.get('date') || undefined);
    if (r.job.closed) return fail(`${r.job.name} is closed in JobTread`, 409);
    return ok({ connection, job: { id: r.job.id, name: r.job.name }, date: r.date, log: r.log, who: p.name, jobUrl: jobUrl(r.job.id) });
  } catch (err) {
    return fromError(err);
  }
}

export async function onRequestPost(context) {
  const { env, request } = context;
  const email = me(context);
  if (!isStaffEmail(email)) return fail('This is for SOARD staff', 403);
  let body;
  try { body = await request.json(); } catch { return fail('Expected JSON'); }
  try {
    switch (body?.action) {
      case 'slots': {
        const p = await asPerson(env, email);
        return ok({ slots: await photoSlots(p, body.files) });
      }
      case 'done': {
        const p = await asPerson(env, email);
        return ok(await photosDone(env, p, { jobId: String(body.jobId || ''), date: body.date, logId: body.logId || null, files: body.files }));
      }
      case 'unlink': {
        const s = await linkStatus(env, email);
        await unlink(env, email);
        if (s.name) await logAudit(env.DB, { userEmail: email, action: 'deleted', entityType: 'jobtread-access', entitySlug: 'jobtread-link', entityName: `JobTread connection for ${s.name} removed`, gitStatus: 'ok' }).catch(() => {});
        return ok({ connection: await linkStatus(env, email) });
      }
      default:
        return fail('Unknown action');
    }
  } catch (err) {
    return fromError(err);
  }
}
