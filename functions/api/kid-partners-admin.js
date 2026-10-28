/**
 * /api/kid-partners-admin — Admin → Partners → Waiting for a logo
 * =====================================================================
 * Behind Cloudflare Access (not in the middleware's public list).
 *
 * GET                                       → { waiting, dismissed, added, settings, lastSweepAt, lastRun, lastError }
 * POST { dismiss: { record, company } }     → "No logo needed": it stops waiting
 * POST { undismiss: { record, company } }   → waiting again (no second email)
 * POST { link: { company, partner } }       → "Same as": the company is that partner, now and for every job
 *                                              after; what's waiting for it gets the partner's logo straight away
 * POST { unlink: { company } }              → not that partner after all (logos already on pages stay)
 * POST { settings: { emails } }             → who's emailed when a logo is missing
 *
 * See ./_kid-partners.js.
 */

import { adminView, setAside, saveSettings, setLink, recheckWaiting } from './_kid-partners.js';
import { logAudit } from './_audit.js';

const ok = (body = {}) => Response.json({ success: true, ...body }, { headers: { 'Cache-Control': 'no-store' } });
const fail = (error, status = 400) => Response.json({ success: false, error }, { status });
const RECORD_RE = /^(community\/)?[a-z0-9][a-z0-9-]{0,120}$/;
const COMPANY_RE = /^[a-z0-9]{1,200}$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,120}$/;

export async function onRequestGet({ env }) {
  if (!env.DB) return fail('DB not bound', 500);
  return ok(await adminView(env.DB));
}

export async function onRequestPost(context) {
  const { env, request } = context;
  if (!env.DB) return fail('DB not bound', 500);
  const by = context.data?.userEmail || null;
  let body;
  try { body = await request.json(); } catch { return fail('Bad request'); }

  const one = body?.dismiss || body?.undismiss;
  if (one) {
    if (!RECORD_RE.test(one.record || '') || !COMPANY_RE.test(one.company || '')) return fail('Bad row');
    const dismiss = !!body.dismiss;
    const state = await setAside(env.DB, { record: one.record, company: one.company, dismiss }, by);
    if (!state) return fail('That one isn’t waiting any more', 404);
    if (state === (dismiss ? 'dismissed' : 'waiting')) {
      await logAudit(env.DB, { userEmail: by, action: 'updated', entityType: 'partner-logos', entitySlug: one.record, entityName: dismiss ? 'No logo needed' : 'Waiting for a logo again', changes: { company: one.company } });
    }
    return ok({ state, view: await adminView(env.DB) });
  }

  const link = body?.link || body?.unlink;
  if (link) {
    if (!COMPANY_RE.test(link.company || '') || (body.link && !SLUG_RE.test(link.partner || ''))) return fail('Bad link');
    try {
      await setLink(env.DB, { company: link.company, partner: body.link ? link.partner : null });
    } catch (e) {
      return fail(e.message, 404);
    }
    await logAudit(env.DB, { userEmail: by, action: 'updated', entityType: 'partner-logos', entitySlug: link.company, entityName: body.link ? 'Same as a partner' : 'Not that partner', changes: body.link ? { partner: link.partner } : null });
    // The logo goes on now, so the list shows it done
    const added = body.link ? await recheckWaiting(env) : [];
    return ok({ added, view: await adminView(env.DB) });
  }

  if (body?.settings) {
    try {
      const settings = await saveSettings(env.DB, { emails: Array.isArray(body.settings.emails) ? body.settings.emails : [] }, by);
      await logAudit(env.DB, { userEmail: by, action: 'updated', entityType: 'partner-logos', entitySlug: 'settings', entityName: 'Who hears about missing logos', changes: { emails: settings.emails } });
      return ok({ settings });
    } catch (e) {
      return fail(e.message);
    }
  }
  return fail('Nothing to do');
}
