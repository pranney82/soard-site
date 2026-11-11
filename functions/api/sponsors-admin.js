/**
 * /api/sponsors-admin — monetary sponsors in Admin → Kids and Partners
 * =====================================================================
 * Behind Cloudflare Access (not in the middleware's public list).
 *
 * GET ?kid=<slug>                             → { pledges } (nothing written).
 *                                               pledges: { [partner]: { pledged, received, updatedAt, by } }
 * GET ?partners=<slug>,<slug>                 → { contacts: { [slug]: people } }
 * POST { contacts: { partner, people } }      → saves a sponsor's people (private, D1 only); each new one goes on
 *                                               the open job of each room it sponsors, once (./_room-credits.js)
 * POST { pledge: { kid, partner, pledged, received } } → what that sponsor pledged toward the kid's makeover and
 *                                               what's come in (D1 only, ./_sponsor-pledges.js); both empty clears it
 *
 * Who the sponsor is: /api/room-credits-admin. See ./_sponsors.js.
 */
import { readContacts, saveContacts } from './_sponsors.js';
import { grantForSponsor } from './_room-credits.js';
import { logAudit } from './_audit.js';
import { pledgesFor, savePledge } from './_sponsor-pledges.js';

const ok = (body = {}) => Response.json({ success: true, ...body }, { headers: { 'Cache-Control': 'no-store' } });
const fail = (error, status = 400) => Response.json({ success: false, error }, { status });
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,120}$/;

export async function onRequestGet({ env, request }) {
  if (!env.DB) return fail('DB not bound', 500);
  const url = new URL(request.url);
  const kid = url.searchParams.get('kid');
  if (kid) {
    if (!SLUG_RE.test(kid)) return fail('Bad kid');
    try {
      const pledges = await pledgesFor(env.DB, [kid]);
      return ok({ pledges: pledges[kid] || {} });
    } catch (e) {
      // Never 502: Cloudflare swaps a 502 body for its own error page
      return fail(e.message, 500);
    }
  }
  const slugs = (url.searchParams.get('partners') || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!slugs.length || slugs.length > 200 || !slugs.every((s) => SLUG_RE.test(s))) return fail('Bad partners');
  try {
    return ok({ contacts: await readContacts(env.DB, slugs) });
  } catch (e) {
    return fail(e.message, 500);
  }
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
    // Who was there before, so only the ones just added go on the jobs it sponsors (one a person took off stays off)
    let had;
    try { had = new Set(((await readContacts(env.DB, [partner]))[partner] || []).map((c) => String(c.email || '').toLowerCase()).filter(Boolean)); } catch (e) { return fail(e.message, 500); }
    try { saved = await saveContacts(env.DB, partner, people, { by }); } catch (e) { return fail(e.message); }
    const added = saved.map((c) => String(c.email || '').toLowerCase()).filter((e) => e && !had.has(e));
    // Names only in the log: emails and phones stay in partner_contacts
    await logAudit(env.DB, { userEmail: by, action: 'updated', entityType: 'partner-contacts', entitySlug: partner, entityName: 'Sponsor contacts', changes: { people: saved.map((p) => p.name || 'unnamed') } });
    const access = await grantForSponsor(env, partner, { emails: added }).catch((e) => ({ granted: [], problems: [e.message] }));
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

  return fail('Nothing to do');
}
