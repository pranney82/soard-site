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
 *   - During the watch party (starting soon, live, replay), /live/ and the
 *     current kid's own page are laid out for the video before they leave
 *     the server (_watch-party.js), so nothing on screen shifts when the
 *     page script takes over. That is when most viewers arrive at once.
 *   - A kid link that doesn't exist (kid not published yet, a typo, an old
 *     slug) redirects to /live/, which shows whatever reveal is current
 *     instead of a "page not found".
 *
 * Everything else under /live/ passes straight through. Any error serves the
 * static page untouched.
 */

import { readState, readConfig, publicState, visibleState } from '../api/_broadcast.js';
import { watchParty } from './_watch-party.js';
import { cfRaw, cfSrcset, cfLqip } from '../../src/utils/cf-image.ts';

const ACTIVE = new Set(['scheduled', 'armed', 'live', 'ending', 'replay']);
const SITE = 'https://sunshineonaranneyday.com';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** The kid the current reveal is for, or null. */
async function currentKid(env, state) {
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

const setAttrs = (attrs) => ({
  element(e) { for (const [k, v] of Object.entries(attrs)) { if (v === null) e.removeAttribute(k); else e.setAttribute(k, v); } },
});

function rewrite(res, { kid, party, messages }) {
  let rw = new HTMLRewriter();
  if (kid) {
    const title = `${kid.name}'s Reveal, Live | Sunshine on a Ranney Day`;
    const description = `Watch ${kid.name}'s room reveal live from Sunshine on a Ranney Day. Get a reminder and see the moment ${kid.name} sees the new room for the first time.`;
    const content = (value) => setAttrs({ content: value });
    rw = rw
      .on('title', { element(e) { e.setInnerContent(title); } })
      .on('meta[name="description"]', content(description))
      .on('meta[property="og:title"]', content(title))
      .on('meta[name="twitter:title"]', content(title))
      .on('meta[property="og:description"]', content(description))
      .on('meta[name="twitter:description"]', content(description))
      .on('meta[property="og:image:alt"]', content(`${kid.name}'s room reveal, live`))
      .on('meta[name="twitter:image:alt"]', content(`${kid.name}'s room reveal, live`))
      .on('#live-hero', setAttrs({ 'data-follow': kid.slug }))
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
  }
  if (party) {
    const shape = { 'data-party': '', 'data-orientation': party.orientation };
    rw = rw
      .on('.live-page', setAttrs({ 'data-view': party.mode }))
      .on('#live-hero', setAttrs({ 'data-phase': party.mode, ...shape }))
      .on('#live-hero [data-stage]', setAttrs({ 'data-mode': party.mode, ...shape }))
      .on('#live-hero [data-s="bar"]', setAttrs({ hidden: null }))
      .on('#live-hero [data-live="eyebrow"]', { element(e) { e.setInnerContent(party.eyebrow); } });
    if (messages) rw = rw.on('#live-hero [data-slot="hero"]', setAttrs({ hidden: null }));
    if (!kid && party.mode === 'live' && party.generic) rw = rw.on('#live-hero h1', { element(e) { e.setInnerContent("Today's <em>room reveal</em>", { html: true }); } });
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

/** The full page, never a 304: a cached copy would skip the rewrite */
function fresh(request) {
  const r = new Request(request);
  r.headers.delete('If-None-Match');
  r.headers.delete('If-Modified-Since');
  return r;
}

export async function onRequest(context) {
  const { request, env, next } = context;
  if (request.method !== 'GET' && request.method !== 'HEAD') return next();
  const url = new URL(request.url);
  const isIndex = url.pathname === '/live/';
  const slugMatch = url.pathname.match(/^\/live\/([^/]+)\/$/);
  const pageKid = slugMatch && slugMatch[1] !== 'slate' ? slugMatch[1] : '';

  // Only the live pages themselves are ever rewritten (not slates, images or share cards)
  if (!isIndex && !pageKid) {
    const res = await next();
    if (res.status === 404 && /^\/live\/[^/]+\/?$/.test(url.pathname)) return Response.redirect(`${url.origin}/live/${url.search}`, 302);
    return res;
  }

  let broadcast = null;
  try {
    if (env.DB) {
      const [state, config] = await Promise.all([readState(env.DB), readConfig(env.DB)]);
      // A rehearsal (JobTread TEST job) is invisible here: the page reads as nothing scheduled
      broadcast = { state: visibleState(state), config, pub: publicState(state, config) };
    }
  } catch { broadcast = null; }

  try {
    const kid = isIndex && broadcast ? await currentKid(env, broadcast.state) : null;
    const party = broadcast ? watchParty(broadcast.pub, { pageKid, kidPublished: pageKid ? true : !!kid?.published }) : null;
    if (party) party.generic = !broadcast.pub.kidSlug;
    const res = await next(kid || party ? fresh(request) : request);
    if (res.status === 404 && pageKid) return Response.redirect(`${url.origin}/live/${url.search}`, 302);
    if (res.status !== 200 || !(res.headers.get('content-type') || '').includes('text/html') || !(kid || party)) return res;
    return rewrite(res, { kid, party, messages: broadcast.config?.messages?.enabled !== false });
  } catch {
    return next();
  }
}
