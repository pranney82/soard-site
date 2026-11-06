/**
 * /api/sponsors-admin — monetary sponsors in Admin → Kids and Partners
 * =====================================================================
 * Behind Cloudflare Access (not in the middleware's public list).
 *
 * GET ?kid=<slug>&job=<jobId>                 → { sponsors, jobtread, pledges } (job optional; nothing written).
 *                                               pledges: { [partner]: { pledged, received, updatedAt, by } }
 * GET ?partners=<slug>,<slug>                 → { contacts: { [slug]: people } }
 * POST { contacts: { partner, people } }      → saves a sponsor's people (private, D1 only), then gives
 *                                               them Sponsor access on their kids' open jobs
 * POST { sync: { kid, job, previous } }       → after a kid save: JobTread's Monetary Sponsor field and
 *                                               the contacts' Sponsor access follow the website
 * POST { pledge: { kid, partner, pledged, received } } → what that sponsor pledged toward the kid's makeover and
 *                                               what's come in (D1 only, ./_sponsor-pledges.js); both empty clears it
 *
 * See ./_sponsors.js.
 */
import { kidSponsorView, readContacts, saveContacts, syncKidSponsor, grantForPartner } from './_sponsors.js';
import { logAudit } from './_audit.js';
import { pledgesFor, savePledge } from './_sponsor-pledges.js';

const ok = (body = {}) => Response.json({ success: true, ...body }, { headers: { 'Cache-Control': 'no-store' } });
const fail = (error, status = 400) => Response.json({ success: false, error }, { status });
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,120}$/;
const JOB_RE = /^[A-Za-z0-9]{6,40}$/;

export async function onRequestGet({ env, request }) {
  if (!env.DB) return fail('DB not bound', 500);
  const url = new URL(request.url);
  const kid = url.searchParams.get('kid');
  const job = url.searchParams.get('job') || null;
  if (kid) {
    if (!SLUG_RE.test(kid) || (job && !JOB_RE.test(job))) return fail('Bad kid or job');
    try {
      const [view, pledges] = await Promise.all([kidSponsorView(env, kid, job), pledgesFor(env.DB, [kid]).catch(() => ({}))]);
      return ok({ ...view, pledges: pledges[kid] || {} });
    } catch (e) {
      // Never 502: Cloudflare swaps a 502 body for its own error page
      return fail(e.message, /No kid/.test(e.message) ? 404 : 500);
    }
  }
  const slugs = (url.searchParams.get('partners') || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!slugs.length || slugs.length > 200 || !slugs.every((s) => SLUG_RE.test(s))) return fail('Bad partners');
  return ok({ contacts: await readContacts(env.DB, slugs) });
}

export async function onRequestPost(context) {
  const { env, request } = context;
  if (!env.DB) return fail('DB not bound', 500);
  const by = context.data?.userEmail || null;
  let body;
  try { body = await request.json(); } catch { return fail('Bad request'); }

  if (body?.contacts) {
    const { partner, people } = body.contacts;
    if (!SLUG_RE.test(partner || '')) return fail('Bad partner');
    const exists = await env.DB.prepare('SELECT slug FROM partners WHERE slug = ?').bind(partner).first();
    if (!exists) return fail('That partner isn’t in the directory', 404);
    let saved;
    try { saved = await saveContacts(env.DB, partner, people, { by }); } catch (e) { return fail(e.message); }
    // Names only in the log: emails and phones stay in partner_contacts
    await logAudit(env.DB, { userEmail: by, action: 'updated', entityType: 'partner-contacts', entitySlug: partner, entityName: 'Sponsor contacts', changes: { people: saved.map((p) => p.name || 'unnamed') } });
    const access = await grantForPartner(env, partner).catch((e) => ({ granted: [], problems: [e.message] }));
    return ok({ contacts: saved, ...access });
  }

  if (body?.pledge) {
    const { kid, partner, pledged, received } = body.pledge;
    if (!SLUG_RE.test(kid || '') || !SLUG_RE.test(partner || '')) return fail('Bad pledge');
    // The Advisory Board's is what it has actually raised, kept by the site (./_advisory-sponsor.js)
    if (partner === 'soard-advisory-board') return fail('The Advisory Board’s amount follows what the group has raised in Zeffy', 409);
    const row = await env.DB.prepare('SELECT data FROM kids WHERE slug = ?').bind(kid).first();
    if (!row) return fail('No kid with that page', 404);
    let sponsors = [];
    try { sponsors = JSON.parse(row.data || '{}').sponsors || []; } catch { /* none */ }
    // Only a sponsor the kid's saved page names (a pledge for one still being picked waits for the save)
    if (!sponsors.includes(partner)) return fail('Save the kid with this sponsor first', 409);
    let saved;
    try { saved = await savePledge(env.DB, { kid, partner, pledged, received }, { by }); } catch (e) { return fail(e.message, e.status || 500); }
    await logAudit(env.DB, { userEmail: by, action: 'updated', entityType: 'sponsor-pledge', entitySlug: kid, entityName: `Pledge from ${partner}`, changes: { pledged: saved?.pledged ?? null, received: saved?.received ?? null } });
    return ok({ pledge: saved });
  }

  if (body?.sync) {
    const { kid, job, previous = [] } = body.sync;
    if (!SLUG_RE.test(kid || '') || !JOB_RE.test(job || '') || !Array.isArray(previous) || !previous.every((s) => SLUG_RE.test(s))) return fail('Bad sync');
    try {
      return ok(await syncKidSponsor(env, { slug: kid, jobId: job, previous }, { by }));
    } catch (e) {
      return fail(e.message, /No kid/.test(e.message) ? 404 : 500);
    }
  }
  return fail('Nothing to do');
}
