/**
 * /api/zeffy-forms — the forms in SOARD's Zeffy, for the admin's Zeffy form dropdowns
 * ===========================================================================
 * Behind Cloudflare Access like every admin route (staff only: board and advisory sign-ins
 * aren't let through by _middleware.js). Read fresh from Zeffy each time (./_zeffy-forms.js).
 *
 * GET → { success, forms: [{ id, title, url, kind, open, created }] }
 */

import { zeffyForms } from './_zeffy-forms.js';

export async function onRequestGet({ env }) {
  try {
    return Response.json({ success: true, forms: await zeffyForms(env) }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) {
    // 503, never 502: Cloudflare replaces 502 bodies with its own error page
    if (e.status) return Response.json({ success: false, error: e.message }, { status: e.status });
    console.error('[zeffy-forms]', e?.message || e);
    return Response.json({ success: false, error: 'The site didn’t answer. Try again in a minute.' }, { status: 500 });
  }
}
