/**
 * /apply/ — the Apply page, following the live open/closed switch
 * =====================================================================
 * The page is static (src/pages/apply.astro) and carries both states: the
 * Apply buttons and "now open" banner (data-when-open), and the closed
 * message with the "tell me when applications open" form (data-when-closed).
 * This shows the one Admin → Applications → Settings says right now, with
 * the season year, the closed message and the form link from the same
 * settings, so switching applications on or off needs no Publish. If anything
 * here fails the page is served as built.
 */

import { applicationSettings, cleanYear } from '../api/_applications.js';

export async function onRequest(context) {
  const { request, env, next } = context;
  const url = new URL(request.url);
  if ((request.method !== 'GET' && request.method !== 'HEAD') || !/^\/apply\/?$/.test(url.pathname)) return next();
  try {
    if (!env.DB) return next();
    const app = await applicationSettings(env.DB);
    const open = app.open === true;
    const year = cleanYear(app.year);
    const closedMessage = String(app.closedMessage || '').trim() || `The ${year} application period is currently closed.`;
    const outside = /^https:\/\//.test(String(app.formUrl || '').trim()) ? String(app.formUrl).trim() : '';
    const formUrl = outside || '/apply/form/';

    // Always the full page (never a 304): a cached copy would skip the switch
    const fresh = new Request(request);
    fresh.headers.delete('If-None-Match');
    fresh.headers.delete('If-Modified-Since');
    const res = await next(fresh);
    if (res.status !== 200 || !(res.headers.get('content-type') || '').includes('text/html')) return res;

    const show = (el, yes) => (yes ? el.removeAttribute('hidden') : el.setAttribute('hidden', ''));
    const out = new HTMLRewriter()
      .on('[data-when-open]', { element(el) { show(el, open); } })
      .on('[data-when-closed]', { element(el) { show(el, !open); } })
      .on('[data-open-class]', {
        element(el) {
          const cls = el.getAttribute('data-open-class');
          const list = (el.getAttribute('class') || '').split(/\s+/).filter(c => c && c !== cls);
          if (open) list.push(cls);
          el.setAttribute('class', list.join(' '));
        },
      })
      .on('[data-app-text="openHeadline"]', { element(el) { el.setInnerContent(`The ${year} application is now open!`); } })
      .on('[data-app-text="closedHeadline"]', { element(el) { el.setInnerContent(closedMessage); } })
      .on('[data-app-href]', {
        element(el) {
          el.setAttribute('href', formUrl);
          if (outside) { el.setAttribute('target', '_blank'); el.setAttribute('rel', 'noopener noreferrer'); }
          else { el.removeAttribute('target'); el.removeAttribute('rel'); }
        },
      })
      .transform(res);
    const headers = new Headers(out.headers);
    // The switch changes without a deploy: browsers and the edge recheck every visit
    headers.set('Cache-Control', 'no-cache');
    headers.delete('ETag');
    headers.delete('Last-Modified');
    headers.delete('Content-Length');
    return new Response(out.body, { status: out.status, headers });
  } catch {
    return next();
  }
}
