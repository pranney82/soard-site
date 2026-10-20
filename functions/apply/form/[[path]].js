/**
 * /apply/form/ — embed the live application form in the page
 * =====================================================================
 * The page is static (src/pages/apply/form.astro); the form itself is data
 * that staff change in Admin → Applications → Form, live without a Publish.
 * This puts the live form, the open/closed switch and the season year into
 * the page as JSON, so the browser draws the right questions on first paint
 * without asking the API. If anything here fails the page is served as built
 * and the script asks /api/apply?config instead.
 */

import { applicationSettings, cleanYear } from '../../api/_applications.js';
import { formFor } from '../../api/_application-forms.js';
import { publicForm } from '../../api/apply.js';

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);
  if ((request.method !== 'GET' && request.method !== 'HEAD') || !/^\/apply\/form\/?$/.test(url.pathname)) return next();
  try {
    if (!env.DB) return next();
    const settings = await applicationSettings(env.DB);
    const year = cleanYear(settings.year);
    const form = await formFor(env.DB, { year });
    const config = { open: settings.open === true, year, form: publicForm(form), turnstileSiteKey: env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY ? env.TURNSTILE_SITE_KEY : null };
    // Always the full page (never a 304): a cached copy would skip the embed
    const fresh = new Request(request);
    fresh.headers.delete('If-None-Match');
    fresh.headers.delete('If-Modified-Since');
    const res = await next(fresh);
    if (res.status !== 200 || !(res.headers.get('content-type') || '').includes('text/html')) return res;
    // JSON in a <script> can't contain "</script>": escape every "<"
    const json = JSON.stringify(config).replace(/</g, '\\u003c');
    const out = new HTMLRewriter()
      .on('[data-application]', {
        element(el) {
          el.setAttribute('data-year', year);
          el.prepend(`<script type="application/json" id="af-config">${json}</script>`, { html: true });
          if (config.open) el.removeAttribute('hidden');
          else el.setAttribute('hidden', '');
        },
      })
      .on('[data-closed]', {
        element(el) {
          if (config.open) el.setAttribute('hidden', '');
          else el.removeAttribute('hidden');
        },
      })
      .transform(res);
    const headers = new Headers(out.headers);
    // The form and its switch change without a deploy: browsers and the edge recheck every visit
    headers.set('Cache-Control', 'no-cache');
    headers.delete('ETag');
    headers.delete('Last-Modified');
    headers.delete('Content-Length');
    return new Response(out.body, { status: out.status, headers });
  } catch {
    return next();
  }
}
