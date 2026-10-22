/**
 * /api/advisory-applications-admin — Admin → People → Applications
 * =====================================================================
 * Behind Cloudflare Access (not in the middleware's public list).
 *
 * GET                      → { applications, statuses, settings } (the Jotform ones come in first, once)
 * GET ?count=1             → { new } for the tab's badge
 * GET ?id=<application>    → { application } with the answers by step and the notes
 * POST { status: { id, status } }      → where it stands (new, talking, joined, not-now)
 * POST { note: { id, text } }          → a staff note
 * POST { person: { id, slug } }        → they're on People → Advisory now (Joined)
 * POST { settings: { staffEmails } }   → who gets the email when someone applies
 * POST { remove: { id } }              → delete the application from the site
 *
 * See ./_advisory-applications.js.
 */

import {
  ensureAdvisorySchema, listAdvisoryApplications, getAdvisoryApplication, countNew, setAdvisoryStatus, addAdvisoryNote,
  linkAdvisor, deleteAdvisoryApplication, getAdvisorySettings, saveAdvisorySettings, importJotformApplications, isApplicationId, STATUSES,
} from './_advisory-applications.js';
import { logAudit } from './_audit.js';

const ok = (body = {}) => Response.json({ success: true, ...body }, { headers: { 'Cache-Control': 'no-store' } });
const fail = (error, status = 400, extra = {}) => Response.json({ success: false, error, ...extra }, { status });

export async function onRequestGet(context) {
  const { env, request } = context;
  if (!env.DB) return fail('DB not bound', 500);
  await ensureAdvisorySchema(env.DB);
  const url = new URL(request.url);
  if (url.searchParams.get('count')) return ok({ new: await countNew(env.DB) });
  const id = url.searchParams.get('id');
  if (id) {
    if (!isApplicationId(id)) return fail('Bad id');
    const application = await getAdvisoryApplication(env.DB, id);
    return application ? ok({ application }) : fail('That application isn’t here any more', 404);
  }
  const imported = await importJotformApplications(env.DB).catch(() => 0);
  const [applications, settings] = await Promise.all([listAdvisoryApplications(env.DB), getAdvisorySettings(env.DB)]);
  return ok({ applications, statuses: STATUSES, settings, imported });
}

export async function onRequestPost(context) {
  const { env, request } = context;
  if (!env.DB) return fail('DB not bound', 500);
  const by = context.data?.userEmail || null;
  let body;
  try { body = await request.json(); } catch { return fail('Bad request'); }
  const idOf = (x) => (isApplicationId(x?.id) ? x.id : null);
  try {
    if (body.status) {
      const id = idOf(body.status);
      if (!id) return fail('Bad id');
      return ok({ application: await setAdvisoryStatus(env.DB, id, body.status.status, { by }) });
    }
    if (body.note) {
      const id = idOf(body.note);
      if (!id) return fail('Bad id');
      return ok({ application: await addAdvisoryNote(env.DB, id, body.note.text, { by }) });
    }
    if (body.person) {
      const id = idOf(body.person);
      if (!id) return fail('Bad id');
      return ok({ application: await linkAdvisor(env.DB, id, body.person.slug, { by }) });
    }
    if (body.settings) {
      const r = await saveAdvisorySettings(env.DB, body.settings, { by });
      if (r.problems) return fail('Check the emails', 422, { problems: r.problems });
      await logAudit(env.DB, { userEmail: by, action: 'updated', entityType: 'advisory-settings', entitySlug: 'staffEmails', entityName: 'Advisory Board applications: who hears about them', changes: null, path: null, gitStatus: 'runtime' }).catch(() => {});
      return ok({ settings: r.settings });
    }
    if (body.remove) {
      const id = idOf(body.remove);
      if (!id) return fail('Bad id');
      const app = await getAdvisoryApplication(env.DB, id);
      if (!app) return fail('That application isn’t here any more', 404);
      await deleteAdvisoryApplication(env.DB, id);
      await logAudit(env.DB, { userEmail: by, action: 'deleted', entityType: 'advisory-application', entitySlug: id, entityName: `Advisory Board application: ${app.name}`, changes: null, path: null, gitStatus: 'runtime' }).catch(() => {});
      return ok({ removed: id });
    }
    return fail('Nothing to do');
  } catch (e) {
    return fail(e.message || 'Something went wrong', e.status || 500);
  }
}
