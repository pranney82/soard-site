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
 *     When the room's design is out (public/admin/reveal-design.js), the
 *     hero is marked data-design and the design strip beside the video
 *     already has its place and its name: the pictures fill it, nothing moves.
 *   - A kid link that doesn't exist (kid not published yet, a typo, an old
 *     slug) redirects to /live/, which shows whatever reveal is current
 *     instead of a "page not found".
 *   - While the family application is open, /live/ carries the application
 *     bar (../_apply-bar.js), except while a reveal is starting or live, when
 *     the video is the only thing. Someone arriving from the Instagram bio is
 *     exactly who should hear the application is open.
 *
 *   - Between reveals, /live/'s hero lists what's coming up. The build wrote
 *     those rows from the schedule it had, in Eastern time; they go out
 *     redrawn from the schedule as it is now (the same edge copy the kid
 *     pages read, ../_kid-reveal.js) and in the visitor's own time zone
 *     (Cloudflare's request.cf.timezone), so the page script finds nothing
 *     to change and nothing moves after load.
 *
 * Everything else under /live/ passes straight through. Any error serves the
 * static page untouched.
 */

import { readState, readConfig, publicState, visibleState } from '../api/_broadcast.js';
import { watchParty } from './_watch-party.js';
import { revealSlides, designWindow } from '../../public/admin/reveal-design.js';
import { cfRaw, cfSrcset, cfLqip } from '../../src/utils/cf-image.ts';
import { barFor, addBar, PAGE_REUSE } from '../_apply-bar.js';
import { upcomingReveals } from '../_kid-reveal.js';
import { heroRowsHtml, rowsSignature, afterLine } from '../../src/utils/upcoming-rows.ts';

const ACTIVE = new Set(['scheduled', 'armed', 'live', 'ending', 'replay']);
const SITE = 'https://sunshineonaranneyday.com';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** A kid's saved profile ({} when unknown or unreadable) */
async function kidData(env, slug) {
  try {
    const row = await env.DB.prepare('SELECT data FROM kids WHERE slug = ?').bind(slug).first();
    if (row?.data) return { data: JSON.parse(row.data), found: true };
  } catch { /* unreadable reads as unknown */ }
  return { data: {}, found: false };
}

/** The kid the current reveal is for, or null. */
async function currentKid(env, state) {
  if (!ACTIVE.has(state.phase) || !state.kidSlug) return null;
  const { data, found } = await kidData(env, state.kidSlug);
  const name = data.name || state.kidName;
  if (!name) return null;
  return {
    slug: state.kidSlug,
    name,
    summary: data.heroSummary || data.shortDescription || null,
    image: state.image || data.heroImage || null,
    published: found && data.publishStatus !== 'draft',
    data,
  };
}

/**
 * The design strip's place during the watch party: { slug, name } when the
 * room's design is out for the kid being watched and has a picture, else null.
 * The same rules as /api/reveal-design, which fills it.
 */
function designFor(slug, data, state) {
  if (!slug || !data || data.publishStatus === 'draft') return null;
  const kid = { ...data, slug: data.slug || slug };
  const { open, after } = designWindow({ kid, broadcast: state });
  return open && revealSlides(kid, { after }).length ? { slug, name: String(data.name || '').trim() } : null;
}

const setAttrs = (attrs) => ({
  element(e) { for (const [k, v] of Object.entries(attrs)) { if (v === null) e.removeAttribute(k); else e.setAttribute(k, v); } },
});

function rewrite(res, { kid, party, messages, design }) {
  let rw = new HTMLRewriter();
  if (kid) {
    const title = `${kid.name}'s Reveal, Live | Sunshine on a Ranney Day`;
    const description = `Watch ${kid.name}'s room reveal from Sunshine on a Ranney Day, the moment the new room is seen for the first time.`;
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
      // A reveal is on: the frame is the stage, not the "Coming up" list
      .on('.live-page', setAttrs({ 'data-next': null }))
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
      .on('.live-page', setAttrs({ 'data-view': party.mode, 'data-next': null }))
      .on('#live-hero', setAttrs({ 'data-phase': party.mode, ...shape }))
      .on('#live-hero [data-stage]', setAttrs({ 'data-mode': party.mode, ...shape }))
      .on('#live-hero [data-s="bar"]', setAttrs({ hidden: null }))
      .on('#live-hero [data-live="eyebrow"]', { element(e) { e.setInnerContent(party.eyebrow); } });
    if (messages) rw = rw.on('#live-hero [data-slot="hero"]', setAttrs({ hidden: null }));
    if (!kid && party.mode === 'live' && party.generic) rw = rw.on('#live-hero h1', { element(e) { e.setInnerContent("Today's <em>room reveal</em>", { html: true }); } });
    if (design) {
      rw = rw.on('#live-hero', setAttrs({ 'data-design': design.slug }));
      if (design.name) {
        const whose = /s$/i.test(design.name) ? `${design.name}'` : `${design.name}'s`;
        rw = rw.on('#live-hero [data-hds="name"]', { element(e) { e.setInnerContent(`${whose} design`); } });
      }
    }
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

const EASTERN = 'America/New_York';
/** The visitor's time zone as Cloudflare places them, when it's one this runtime knows; Eastern otherwise */
export function visitorZone(request) {
  const tz = request?.cf?.timezone;
  if (typeof tz !== 'string' || !tz) return EASTERN;
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return tz; } catch { return EASTERN; }
}

/** The hero's "After Dylan: Max on Friday, November 20…" line, written (it follows the schedule, so the page is reused briefly) */
export function addAfterLine(res, text) {
  if (res.status !== 200 || !(res.headers.get('content-type') || '').includes('text/html')) return res;
  const out = new HTMLRewriter()
    .on('#live-hero [data-live="next-text"]', { element(e) { e.setInnerContent(text); } })
    .on('#live-hero [data-live="next-line"]', setAttrs({ hidden: null }))
    .transform(res);
  const headers = new Headers(out.headers);
  if (!/no-store/i.test(headers.get('Cache-Control') || '')) headers.set('Cache-Control', PAGE_REUSE);
  headers.delete('ETag');
  headers.delete('Last-Modified');
  headers.delete('Content-Length');
  return new Response(out.body, { status: out.status, headers });
}

const SLUG = /^[a-z0-9-]+$/;
/** The reveals a row can be drawn for: a known child, with a day (confirmed) or a third of a month (tentative) */
export const drawable = (list) => (list || []).filter((r) => r && SLUG.test(String(r.slug || '')) && (r.confirmed ? r.date : r.window?.label));

/**
 * /live/'s hero rows from the schedule as it is now, in the visitor's zone. `between`: nothing is on (no reveal
 * scheduled, live or on replay), so the hero shows the list when there is one (.live-page data-next), as the page
 * script would decide.
 */
export function addHeroRows(res, { list, zone, between }) {
  if (res.status !== 200 || !(res.headers.get('content-type') || '').includes('text/html')) return res;
  let rw = new HTMLRewriter()
    .on('#live-hero [data-hero-next]', setAttrs({ 'data-sig': rowsSignature(list, zone), 'data-count': String(list.length) }))
    .on('#live-hero [data-hnx-list]', { element(e) { e.setInnerContent(heroRowsHtml(list, zone), { html: true }); } });
  if (between) rw = rw.on('.live-page', setAttrs({ 'data-next': list.length ? '' : null }));
  const out = rw.transform(res);
  const headers = new Headers(out.headers);
  // The rows follow JobTread and the visitor's zone, not the build: never a 304, reused for half a minute at most
  if (!/no-store/i.test(headers.get('Cache-Control') || '')) headers.set('Cache-Control', PAGE_REUSE);
  headers.delete('ETag');
  headers.delete('Last-Modified');
  headers.delete('Content-Length');
  return new Response(out.body, { status: out.status, statusText: out.statusText, headers });
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
    let bar = null;
    const liveNow = !!broadcast?.pub?.live || party?.mode === 'starting' || party?.mode === 'live';
    if (isIndex && !liveNow) {
      try { bar = await barFor(context, url.pathname); } catch { bar = null; }
    }
    // Between reveals the hero lists what's coming up: drawn from the schedule as it is now (null: not known in time,
    // and the page goes out as built)
    let rows = null;
    // The reveal this page shows while it's still ahead (a child's page, or /live/ following one): the line naming the
    // two after it goes out written, as the page script would write it (afterLine), so nothing moves after load
    const lineKid = party ? '' : pageKid || (kid ? kid.slug : '');
    if ((isIndex || lineKid) && !party) {
      try { rows = await upcomingReveals(context); } catch { rows = null; }
      rows = rows ? drawable(rows) : null;
    }
    const line = rows && lineKid ? afterLine(rows, lineKid, kid?.name || '', visitorZone(request)) : '';
    const res = await next(kid || party || bar || rows ? fresh(request) : request);
    if (res.status === 404 && pageKid) return Response.redirect(`${url.origin}/live/${url.search}`, 302);
    if (res.status !== 200 || !(res.headers.get('content-type') || '').includes('text/html') || !(kid || party || bar || rows)) return res;
    let design = null;
    if (party) {
      const slug = pageKid || broadcast.state.kidSlug || '';
      const data = kid && kid.slug === slug ? kid.data : slug ? (await kidData(env, slug)).data : null;
      design = designFor(slug, data, broadcast.state);
    }
    let page = kid || party ? rewrite(res, { kid, party, messages: broadcast.config?.messages?.enabled !== false, design }) : res;
    if (rows && isIndex) page = addHeroRows(page, { list: rows, zone: visitorZone(request), between: !!broadcast && !kid && !ACTIVE.has(broadcast.state?.phase) });
    if (line) page = addAfterLine(page, line);
    return addBar(page, bar);
  } catch {
    return next();
  }
}
