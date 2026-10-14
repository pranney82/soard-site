/**
 * /live/* — one link that always works
 * =====================================
 * /live/ is the address on the reusable family QR code and the Instagram bio,
 * so it must look like the right page the moment it loads:
 *
 *   - While a reveal is scheduled, live or on replay, the static /live/ page
 *     is rewritten for that kid on the way out: headline, story, photo, page
 *     title and the share preview (texts and Slack fetch it fresh each time;
 *     Facebook caches previews, so Facebook posts use the kid's own link).
 *     The hero gets data-follow so the page script knows what it was given.
 *   - A kid link that doesn't exist (kid not published yet, a typo, an old
 *     slug) redirects to /live/, which shows whatever reveal is current
 *     instead of a "page not found".
 *
 * Everything else under /live/ passes straight through. Any error serves the
 * static page untouched.
 */

import { readState } from '../api/_broadcast.js';
import { cfRaw, cfSrcset, cfLqip } from '../../src/utils/cf-image.ts';

const ACTIVE = new Set(['scheduled', 'armed', 'live', 'ending', 'replay']);
const SITE = 'https://sunshineonaranneyday.com';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** The kid the current reveal is for, or null. */
async function currentKid(env) {
  if (!env.DB) return null;
  const state = await readState(env.DB);
  if (!ACTIVE.has(state.phase) || !state.kidSlug) return null;
  let data = {};
  let found = false;
  try {
    const row = await env.DB.prepare('SELECT data FROM kids WHERE slug = ?').bind(state.kidSlug).first();
    if (row?.data) { data = JSON.parse(row.data); found = true; }
  } catch { /* fall back to what the broadcast knows */ }
  const name = data.name || state.kidName;
  if (!name) return null;
  return {
    slug: state.kidSlug,
    name,
    summary: data.heroSummary || data.shortDescription || null,
    image: state.image || data.heroImage || null,
    published: found && data.publishStatus !== 'draft',
  };
}

function rewrite(res, kid) {
  const title = `${kid.name}'s Reveal, Live | Sunshine on a Ranney Day`;
  const description = `Watch ${kid.name}'s room reveal live from Sunshine on a Ranney Day. Get a reminder and see the moment ${kid.name} sees the new room for the first time.`;
  const content = (value) => ({ element(e) { e.setAttribute('content', value); } });
  let rw = new HTMLRewriter()
    .on('title', { element(e) { e.setInnerContent(title); } })
    .on('meta[name="description"]', content(description))
    .on('meta[property="og:title"]', content(title))
    .on('meta[name="twitter:title"]', content(title))
    .on('meta[property="og:description"]', content(description))
    .on('meta[name="twitter:description"]', content(description))
    .on('meta[property="og:image:alt"]', content(`${kid.name}'s room reveal, live`))
    .on('meta[name="twitter:image:alt"]', content(`${kid.name}'s room reveal, live`))
    .on('#live-hero', { element(e) { e.setAttribute('data-follow', kid.slug); } })
    .on('#live-hero h1', { element(e) { e.setInnerContent(`${esc(kid.name)}'s <em>room reveal</em>`, { html: true }); } });
  if (kid.summary) rw = rw.on('#live-hero [data-live="lead"]', { element(e) { e.setInnerContent(kid.summary); } });
  if (kid.published) {
    // Share card built for every published kid at deploy time
    const og = `${SITE}/og/kids/${kid.slug}.png`;
    rw = rw.on('meta[property="og:image"]', content(og)).on('meta[name="twitter:image"]', content(og));
  }
  if (kid.image) {
    const src = cfRaw(kid.image, 'w=640,h=800,fit=cover,gravity=face,q=82');
    const srcset = cfSrcset(kid.image, [400, 640, 800, 1024], { fit: 'cover', gravity: 'face', aspectRatio: 1.25 });
    const lqip = cfLqip(kid.image);
    rw = rw
      .on('#live-hero img[data-live="photo"]', { element(e) { e.setAttribute('src', src); if (srcset) e.setAttribute('srcset', srcset); else e.removeAttribute('srcset'); e.setAttribute('alt', kid.name); } })
      .on('#live-hero [data-live="frame"]', { element(e) { if (lqip) e.setAttribute('style', `background-image:url(${lqip})`); } });
  }
  const out = rw.transform(res);
  const headers = new Headers(out.headers);
  // Personalised for the current reveal, so never cache it anywhere
  headers.set('Cache-Control', 'no-store');
  headers.delete('ETag');
  headers.delete('Last-Modified');
  headers.delete('Content-Length');
  return new Response(out.body, { status: out.status, headers });
}

export async function onRequest(context) {
  const { request, env, next } = context;
  if (request.method !== 'GET' && request.method !== 'HEAD') return next();
  const url = new URL(request.url);
  const isIndex = url.pathname === '/live/';

  let res;
  if (isIndex) {
    // Always fetch the full page: a 304 for the generic page would skip the rewrite
    const fresh = new Request(request);
    fresh.headers.delete('If-None-Match');
    fresh.headers.delete('If-Modified-Since');
    res = await next(fresh);
  } else {
    res = await next();
  }

  if (res.status === 404 && /^\/live\/[^/]+\/?$/.test(url.pathname)) {
    return Response.redirect(`${url.origin}/live/${url.search}`, 302);
  }
  if (!isIndex || res.status !== 200 || !(res.headers.get('content-type') || '').includes('text/html')) return res;

  try {
    const kid = await currentKid(env);
    return kid ? rewrite(res, kid) : res;
  } catch {
    return res;
  }
}
