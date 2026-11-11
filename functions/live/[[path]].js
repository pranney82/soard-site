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

import { readState, readConfig, publicState, visibleState, publicReminders } from '../api/_broadcast.js';
import { watchParty } from './_watch-party.js';
import { revealSlides, designWindow } from '../../public/admin/reveal-design.js';
import { revealOf } from '../api/reveal-design.js';
import { cachedReveals } from '../api/_reveals.js';
import { cfRaw, cfSrcset, cfLqip } from '../../src/utils/cf-image.ts';
import { barFor, addBar, PAGE_REUSE } from '../_apply-bar.js';
import { cardFor } from '../_og-cards.js';
import { edgeSchedule, scheduleAttr } from '../_kid-reveal.js';
import { onBands } from '../_upcoming-band.js';
import { heroRowsHtml, rowsSignature, afterLine } from '../../src/utils/upcoming-rows.ts';
import { plannedText, betweenText, ctasThatApply, ctaPicks, remindParts, remindWords } from '../../src/utils/live-hero-text.ts';
import { inviteData, inviteLinks } from '../../src/utils/reveals-client.ts';
import { messagesOpen, listShown } from '../api/_live-messages.js';
import { emailConfigured } from '../api/_broadcast-notify.js';

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
function designFor(slug, data, state, schedule = null) {
  if (!slug || !data || data.publishStatus === 'draft') return null;
  const kid = { ...data, slug: data.slug || slug };
  // JobTread's schedule too, when it's at hand, exactly as /api/reveal-design decides
  const { open, after } = designWindow({ kid, reveal: schedule ? revealOf(schedule, slug) : null, broadcast: state });
  return open && revealSlides(kid, { after }).length ? { slug, name: String(data.name || '').trim() } : null;
}

/** The starting-soon track (docs/live-runbook.md: live/starting-soon.mp3 in the files bucket) is there: asked of R2 at
 * most every 5 minutes. Without the bucket bound, taken as there (the screen copes with a missing one) */
export const MUSIC_KEY = 'live/starting-soon.mp3';
let musicSeen = { at: 0, there: true };
export async function musicThere(env, now = Date.now()) {
  if (!env.FILES) return true;
  if (now - musicSeen.at < 5 * 60_000) return musicSeen.there;
  let there = musicSeen.there;
  try { there = !!(await env.FILES.head(MUSIC_KEY)); } catch { /* keep what was known */ }
  musicSeen = { at: now, there };
  return there;
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
    if (kid.card) {
      // The kid's own live page's share card (built for every published kid)
      const og = `${SITE}${kid.card}`;
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
/**
 * The schedule the page was drawn from, left on the hero (data-schedule) for the page script to start from: it
 * draws the status line, the buttons and the rows from the same list the server used, so none of them change when
 * it starts. And the Coming up band drawn from it (./_upcoming-band.js), less the reveal the page is showing
 * (current), as LivePage marks it.
 */
export function addSchedule(res, schedule, { zone, current = '' }) {
  if (res.status !== 200 || !(res.headers.get('content-type') || '').includes('text/html')) return res;
  const out = onBands(new HTMLRewriter(), schedule, zone, { current })
    .on('#live-hero', setAttrs({ 'data-schedule': scheduleAttr(schedule) }))
    .transform(res);
  const headers = new Headers(out.headers);
  if (!/no-store/i.test(headers.get('Cache-Control') || '')) headers.set('Cache-Control', PAGE_REUSE);
  headers.delete('ETag');
  headers.delete('Last-Modified');
  headers.delete('Content-Length');
  return new Response(out.body, { status: out.status, headers });
}

/** The reveal a live page is showing, which its Coming up band leaves out: as drawPage in LivePage.astro decides it */
export function showingKid(pub, pageKid = '') {
  const phase = pub?.phase;
  const view = phase === 'live' || phase === 'ending' ? 'live' : phase === 'replay' ? 'replay' : phase === 'scheduled' || phase === 'armed' ? 'upcoming' : 'idle';
  if (view === 'idle') return '';
  if (pageKid) return pub.kidSlug === pageKid ? pageKid : '';
  return pub.kidSlug || '';
}

/**
 * The reminder block (#remind) as the page script draws it on arrival, by the same rules (remindParts, remindWords in
 * src/utils/live-hero-text.ts): there from the first paint, so nothing below the hero moves when the script starts,
 * and a link to /live/#remind lands on the form as the page opens. facts: remindParts' (the browser's own alerts
 * taken as possible, as for the hero's buttons); inviteFor: this page's child in the schedule, for the calendar link.
 */
export function remindFirstPaint(facts) {
  const parts = remindParts(facts);
  const words = remindWords(parts, { shown: parts.name, scope: 'all', hours: facts.reminders?.hours, view: facts.view, now: facts.now });
  const invite = facts.inviteFor ? { ...inviteData(facts.inviteFor), href: inviteLinks(facts.inviteFor).copy } : { href: '/api/reminders?ics=1' };
  return { parts, words, invite };
}

export function addRemind(res, { parts, words, invite }) {
  if (res.status !== 200 || !(res.headers.get('content-type') || '').includes('text/html')) return res;
  const text = (t) => ({ element(e) { e.setInnerContent(t); } });
  const shown = (on) => setAttrs({ hidden: on ? null : '' });
  const calendar = setAttrs({ 'data-invite': null, 'data-invite-name': null, 'data-invite-when': null, 'data-invite-set': null, ...invite });
  let rw = new HTMLRewriter()
    .on('[data-live="remind-block"]', shown(parts.block))
    .on('[data-live="remind-label"]', text(parts.label))
    .on('[data-live="remind-heading"]', text(words.heading))
    .on('[data-live="remind-lead"]', setAttrs({ hidden: parts.on ? null : '', 'data-scope': words.scope }))
    .on('[data-live="remind-lead"] [data-lead="all"]', { element(e) { e.setInnerContent(words.leadAll); e.setAttribute('aria-hidden', 'false'); } })
    .on('[data-live="remind-lead"] [data-lead="one"]', { element(e) { e.setInnerContent(words.leadOne); e.setAttribute('aria-hidden', 'true'); } })
    .on('[data-live="remind-scope"]', shown(words.scopeShown))
    .on('[data-live="form-email"]', shown(parts.email))
    .on('[data-live="remind-email-label"]', text(words.emailLabel))
    .on('[data-live="push-btn"]', shown(parts.push))
    .on('[data-live="calendar-link"]', { element(e) { calendar.element(e); if (!parts.calendar) e.setAttribute('hidden', ''); else e.removeAttribute('hidden'); } })
    .on('#live-hero [data-live="cta-calendar"]', calendar)
    // This form already signs up for every reveal: the Coming up band leaves its email card out
    .on('.live-next [data-upnext]', setAttrs({ 'data-remind-here': words.remindHere ? '' : null }));
  if (words.scopeOne) rw = rw.on('[data-live="scope-one"]', text(words.scopeOne));
  const out = rw.transform(res);
  const headers = new Headers(out.headers);
  if (!/no-store/i.test(headers.get('Cache-Control') || '')) headers.set('Cache-Control', PAGE_REUSE);
  headers.delete('ETag');
  headers.delete('Last-Modified');
  headers.delete('Content-Length');
  return new Response(out.body, { status: out.status, headers });
}

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

// ── Before a reveal: the hero as the page script will draw it ──────────

const PANEL_OPEN = '<!--msgs-panel-->';
const PANEL_CLOSE = '<!--/msgs-panel-->';
const escHtml = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/**
 * What the page script will show, when the server can show it first: { view: 'upcoming' | 'idle', eyebrow, status }
 * or null (the watch party has its own first paint, and a live reveal without a video is left to the script).
 * Mirrors drawPage in src/components/live/LivePage.astro: a child's page follows the broadcast only when it's theirs.
 */
export function firstView({ state, pub, pageKid = '', party = null, rows = null, tz, now = Date.now() }) {
  if (party || !state) return null;
  const ours = !pageKid || pub?.kidSlug === pageKid;
  const phase = ours ? state.phase : 'idle';
  if (phase === 'scheduled' || phase === 'armed') return { view: 'upcoming', ...plannedText(state.scheduledAt || null, tz, now) };
  if (phase === 'live' || phase === 'ending' || phase === 'replay') return null;
  return { view: 'idle', eyebrow: null, status: rows ? betweenText(rows, pageKid, tz) : '' };
}

/** The messages box (between its markers) moved out of the hero into its section below → the page, or null when it can't be */
export function messagesInSection(html) {
  const a = html.indexOf(PANEL_OPEN);
  const b = html.indexOf(PANEL_CLOSE);
  if (a < 0 || b < a) return null;
  const panel = html.slice(a, b + PANEL_CLOSE.length);
  const rest = html.slice(0, a) + html.slice(b + PANEL_CLOSE.length);
  const slot = rest.match(/<div[^>]*\bdata-slot="section"[^>]*>/);
  if (!slot) return null;
  const at = slot.index + slot[0].length;
  return rest.slice(0, at) + panel + rest.slice(at);
}

/** Past reveals moved up to where they're seen between reveals (before the story and reminders) → the page, or null */
export function pastFirst(html) {
  const a = html.indexOf('<!--live-past-->');
  const b = html.indexOf('<!--/live-past-->');
  if (a < 0 || b < a) return null;
  const block = html.slice(a, b + '<!--/live-past-->'.length);
  const rest = html.slice(0, a) + html.slice(b + '<!--/live-past-->'.length);
  const at = rest.indexOf('<!--live-body-->');
  return at < 0 ? null : rest.slice(0, at) + block + rest.slice(at);
}

/** One message as the page script draws it (live-messages.ts add, as a fresh load does: no entrance) */
export const messageHtml = (m) => `<li class="msg" data-id="${escHtml(m.id)}" style="animation:none"><span class="msg__name">${escHtml(m.name)}</span><p class="msg__body">${escHtml(m.body)}</p></li>`;

/**
 * The hero (and, before a reveal with messages open, the messages box in its section with the notes so far)
 * written into the page, so nothing on screen changes when the script takes over.
 * first: firstView's; messages: { kidName, list } or null
 */
export async function addFirstView(res, first, messages = null, ctaFacts = null) {
  if (res.status !== 200 || !(res.headers.get('content-type') || '').includes('text/html')) return res;
  // What moves within the page (the messages box, past reveals) needs its text; the rest is streamed
  let base = res;
  let moved = false;
  let pastOnPage = true;
  if (messages || first.view === 'idle') {
    let html = await res.text();
    pastOnPage = html.includes('id="past-reveals"');
    if (messages) { const next = messagesInSection(html); moved = next !== null; html = next ?? html; }
    if (first.view === 'idle') html = pastFirst(html) ?? html;
    base = new Response(html, { status: res.status, headers: res.headers });
  }
  const text = (t) => ({ element(e) { e.setInnerContent(t); } });
  let rw = new HTMLRewriter()
    .on('.live-page', setAttrs({ 'data-view': first.view }))
    .on('#live-hero', setAttrs({ 'data-phase': first.view }));
  if (first.eyebrow) rw = rw.on('#live-hero [data-live="eyebrow"]', text(first.eyebrow));
  // The hero's two buttons, by the page script's own rule (the message box's button is its own business)
  if (ctaFacts) {
    const applies = ctasThatApply({ ...ctaFacts, pastOnPage });
    const picks = ctaPicks(first.view, (k) => !!applies[k]);
    for (const key of Object.keys(applies)) {
      const at = picks.indexOf(key);
      rw = rw.on(`#live-hero [data-live="${key}"]`, setAttrs({ hidden: applies[key] ? null : '', 'data-capped': at < 0 ? '' : null, style: at < 0 ? null : `order:${at}` }));
    }
    rw = rw.on('#live-hero [data-live="cta-messages"]', setAttrs({ 'data-capped': picks.includes('cta-messages') ? null : '' }));
  }
  if (first.status) rw = rw.on('#live-hero [data-live="status"]', text(first.status));
  if (moved) {
    const name = String(messages.kidName || '').trim();
    rw = rw
      .on('[data-live-msgs]', setAttrs({ hidden: null }))
      .on('[data-msgs="panel"]', setAttrs({ 'data-place': 'section', 'data-open': '1' }))
      .on('[data-msgs="list"]', { element(e) { e.setInnerContent(messages.list.map(messageHtml).join(''), { html: true }); } })
      .on('[data-msgs="heading"]', text(name ? `Messages for ${name}'s family` : 'Messages for the family'))
      .on('#msg-body', setAttrs({ placeholder: name ? `${name}, we are so happy for you!` : 'We are so happy for you!' }));
    if (messages.list.length) rw = rw.on('[data-msgs="empty"]', setAttrs({ hidden: '' }));
  }
  const out = rw.transform(base);
  const headers = new Headers(out.headers);
  // "in 8 days", "in 3 hours": reused for half a minute at most, never a 304
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

  // The starting-soon screen (a child's, or /live/slate/ that follows whichever is scheduled), before it goes out:
  // marked as showing the design when the design is out, so its frame is drawn where the design puts it rather than
  // moving there once the screen has asked; and left without its music when the track isn't in the files bucket, so
  // it never asks for a file that isn't there (SlateScreen.astro)
  const slateMatch = url.pathname.match(/^\/live\/(?:([^/]+)\/)?slate\/$/);
  if (slateMatch && env.DB) {
    try {
      const slug = slateMatch[1] || '';
      const forKid = !!slug && url.searchParams.get('design') !== 'preview';
      const [state, schedule, row, music] = await Promise.all([
        forKid ? readState(env.DB) : null,
        forKid ? cachedReveals(env).catch(() => null) : null,
        forKid ? kidData(env, slug) : null,
        musicThere(env),
      ]);
      const design = forKid && state ? designFor(slug, row.data, visibleState(state), schedule) : null;
      const res = await next(design || !music ? fresh(request) : request);
      if ((!design && music) || res.status !== 200 || !(res.headers.get('content-type') || '').includes('text/html')) return res;
      const out = new HTMLRewriter().on('body', setAttrs({ ...(design ? { 'data-design': '' } : {}), ...(music ? {} : { 'data-music': null }) })).transform(res);
      const headers = new Headers(out.headers);
      headers.set('Cache-Control', PAGE_REUSE);
      headers.delete('ETag');
      headers.delete('Last-Modified');
      headers.delete('Content-Length');
      return new Response(out.body, { status: out.status, headers });
    } catch {
      return next();
    }
  }

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
    if (kid?.published) kid.card = await cardFor(context, `/live/${kid.slug}/`);
    const party = broadcast ? watchParty(broadcast.pub, { pageKid, kidPublished: pageKid ? true : !!kid?.published }) : null;
    if (party) party.generic = !broadcast.pub.kidSlug;
    let bar = null;
    const liveNow = !!broadcast?.pub?.live || party?.mode === 'starting' || party?.mode === 'live';
    if (isIndex && !liveNow) {
      try { bar = await barFor(context, url.pathname); } catch { bar = null; }
    }
    // The schedule as it is now (the edge copy of /api/reveals; null: not known in time, and the page goes out as built)
    let schedule = null;
    try { schedule = await edgeSchedule(context); } catch { schedule = null; }
    // Between reveals the hero lists what's coming up, drawn from it
    let rows = null;
    // The reveal this page shows while it's still ahead (a child's page, or /live/ following one): the line naming the
    // two after it goes out written, as the page script would write it (afterLine), so nothing moves after load
    const lineKid = party ? '' : pageKid || (kid ? kid.slug : '');
    if ((isIndex || lineKid) && !party && schedule) rows = drawable(schedule.upcoming);
    const line = rows && lineKid ? afterLine(rows, lineKid, kid?.name || '', visitorZone(request)) : '';
    // The hero as the page script will draw it before a reveal or between reveals, and the messages box with it
    const first = broadcast ? firstView({ state: broadcast.state, pub: broadcast.pub, pageKid, party, rows, tz: visitorZone(request) }) : null;
    let messages = null;
    if (first?.view === 'upcoming' && messagesOpen(broadcast.state, broadcast.config)) {
      try { messages = { kidName: broadcast.pub?.kidName || kid?.name || '', list: (await listShown(env, { broadcastId: broadcast.state.broadcastId })).messages || [] }; } catch { messages = null; }
    }
    const res = await next(kid || party || bar || schedule || first ? fresh(request) : request);
    if (res.status === 404 && pageKid) return Response.redirect(`${url.origin}/live/${url.search}`, 302);
    if (res.status !== 200 || !(res.headers.get('content-type') || '').includes('text/html') || !(kid || party || bar || schedule || first)) return res;
    let design = null;
    if (party) {
      const slug = pageKid || broadcast.state.kidSlug || '';
      const data = kid && kid.slug === slug ? kid.data : slug ? (await kidData(env, slug)).data : null;
      design = designFor(slug, data, broadcast.state);
    }
    // The messages box moves first (it needs the page's text); the rest are streamed rewrites
    const reminders = broadcast?.config?.reminders || {};
    const ctaFacts = first ? {
      display: first.view, view: first.view, scheduledAt: broadcast.state.scheduledAt || null,
      // As the page has it: emails, or this browser's alerts (taken as possible here; the browser knows for sure)
      remindUsable: !!reminders.enabled && (emailConfigured(env) || (!!reminders.push && !!broadcast.config?.vapid?.publicKey)),
      pageKid, inSchedule: !!(rows || []).some((r) => r.slug === (pageKid || (first.view !== 'idle' ? broadcast.state.kidSlug : ''))),
      hasPlayer: false,
    } : null;
    let page = first ? await addFirstView(res, first, messages, ctaFacts) : res;
    page = kid || party ? rewrite(page, { kid, party, messages: broadcast.config?.messages?.enabled !== false, design }) : page;
    if (rows && isIndex) page = addHeroRows(page, { list: rows, zone: visitorZone(request), between: !!broadcast && !kid && !ACTIVE.has(broadcast.state?.phase) });
    if (line) page = addAfterLine(page, line);
    if (schedule) page = addSchedule(page, schedule, { zone: visitorZone(request), current: showingKid(broadcast?.pub, pageKid) });
    // The reminder block, before a reveal or between reveals, once the schedule says whose day it is
    if (first && schedule) {
      const pub = broadcast.pub || {};
      const inviteKid = pageKid || (first.view !== 'idle' ? pub.kidSlug || '' : '');
      page = addRemind(page, remindFirstPaint({
        reminders: publicReminders(broadcast.config || {}, env), canPush: true, view: first.view, pageKid,
        scheduledAt: pub.scheduledAt || null, kidName: pub.kidName || '', kidSlug: pub.kidSlug || '',
        inviteFor: inviteKid ? schedule.upcoming.find((r) => r.slug === inviteKid) : undefined,
      }));
    }
    return addBar(page, bar);
  } catch {
    return next();
  }
}
