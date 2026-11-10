/**
 * /api/newsletter-drafts-admin — Event Recap and Monthly Impact drafts in Kit
 * =====================================================================
 * Behind Cloudflare Access (not in the middleware's public list).
 *
 * GET  ?event=<slug>   → { ok, key, ...status }  the event's recap email (its "After the event" panel)
 * GET  ?monthly=1      → { ok, key, month, ...status }  the month just ended (Emails & invites)
 * POST { key }         → that email drafted in Kit now ('recap:<slug>' or 'monthly:YYYY-MM')
 *
 * Drafts only, like every Kit email the site makes: staff review and send them
 * from Kit. See ./_newsletter-drafts.js.
 */

import { draftNewsletterNow, newsletterStatus, recapKey, monthlyKey, monthBefore } from './_newsletter-drafts.js';
import { dayIn } from '../../public/admin/events-shared.js';
import { logAudit } from './_audit.js';

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,120}$/;
const KEY_RE = /^(recap:[a-z0-9][a-z0-9-]{0,120}|monthly:\d{4}-(0[1-9]|1[0-2]))$/;
const NO_STORE = { 'Cache-Control': 'no-store' };
const fail = (error, status = 400) => Response.json({ ok: false, error }, { status, headers: NO_STORE });
const kitUrl = (id) => `https://app.kit.com/campaigns/${encodeURIComponent(id)}`;

export async function onRequestGet({ env, request }) {
  if (!env.DB) return fail('DB not bound', 500);
  const q = new URL(request.url).searchParams;
  let key;
  if (q.get('event') != null) {
    if (!SLUG_RE.test(q.get('event'))) return fail('Not an event');
    key = recapKey(q.get('event'));
  } else if (q.get('monthly') != null) {
    key = monthlyKey(monthBefore(dayIn()));
  } else {
    return fail('Which email?');
  }
  try {
    const st = await newsletterStatus(env, key);
    return Response.json({ ok: true, key, ...(key.startsWith('monthly:') ? { month: key.slice(8) } : {}), ...st, ...(st.id ? { url: kitUrl(st.id) } : {}) }, { headers: NO_STORE });
  } catch (err) {
    return fail(err.message, 500);
  }
}

export async function onRequestPost(context) {
  const { env, request } = context;
  if (!env.DB) return fail('DB not bound', 500);
  const me = context.data?.userEmail || '';
  if (!me.includes('@')) return fail('Could not tell who you are from Access', 403);
  let body;
  try { body = await request.json(); } catch { return fail('Bad request'); }
  const key = String(body?.key || '');
  if (!KEY_RE.test(key)) return fail('Not a newsletter email');
  try {
    const r = await draftNewsletterNow(env, { key, by: me });
    const made = r.newsletter === 'drafted';
    if (made && r.id) {
      await logAudit(env.DB, { userEmail: me, action: 'created', entityType: 'newsletter', entitySlug: String(r.id), entityName: `Kit ${key.startsWith('recap:') ? 'Event Recap' : 'Monthly Impact'} draft: ${key.split(':')[1]}`, gitStatus: 'ok' }).catch(() => {});
    }
    return Response.json({ ...r, made, ok: ['drafted', 'unchanged'].includes(r.newsletter), ...(r.id ? { url: kitUrl(r.id) } : {}) }, { headers: NO_STORE });
  } catch (err) {
    return fail(err.message, 500);
  }
}
