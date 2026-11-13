/**
 * /api/jobtread-callback (public, GET only) — where JobTread sends a person back after "Connect JobTread"
 * (/api/field-admin?connect=1, ./_field.js). Public because it's JobTread's redirect: the one-time state the
 * site made for the signed-in person (used once, within 15 minutes) is the proof the sign-in started here, and
 * the key is kept only for someone on SOARD's team in JobTread. Always back to the photo page (or the admin page
 * the connect started from), saying how it went (?jobtread=connected|declined|expired|team|site|failed).
 */

import { finishLink } from './_field.js';
import { logAudit } from './_audit.js';
import { SITE_ORIGIN } from './_broadcast-notify.js';

const back = (result, to = '') => {
  const page = to && to.startsWith('/admin/') ? to : '/admin/photos/';
  const url = new URL(page, SITE_ORIGIN);
  url.searchParams.set('jobtread', result);
  return new Response(null, { status: 302, headers: { Location: url.toString(), 'Cache-Control': 'no-store' } });
};

export async function onRequestGet({ env, request }) {
  const q = new URL(request.url).searchParams;
  if (q.get('error')) return back(q.get('error') === 'access_denied' ? 'declined' : 'failed');
  try {
    const { email, name, back: to } = await finishLink(env, { code: q.get('code'), state: q.get('state') });
    await logAudit(env.DB, { userEmail: email, action: 'created', entityType: 'jobtread-access', entitySlug: 'jobtread-link', entityName: `JobTread connected for ${name || email}: logs, photos and schedule changes through Claude show their name`, gitStatus: 'ok' }).catch(() => {});
    return back('connected', to);
  } catch (err) {
    console.error('[jobtread] connect', err.code || '', err.message);
    return back({ STATE: 'expired', NOT_STAFF: 'team', SITE_LOGIN: 'site' }[err.code] || 'failed');
  }
}
