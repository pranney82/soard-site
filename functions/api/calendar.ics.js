/**
 * GET /api/calendar.ics
 *
 * Generates an iCalendar (.ics) file for a single event. Used by the
 * `revealInvite` email block's "Apple" calendar link — recipients click,
 * the file downloads, and Apple Calendar / Outlook desktop / Gmail / etc.
 * open it natively.
 *
 * Every invite comes from what the site knows, never from whoever wrote the
 * link (see ./_calendar-links.js, which also makes the email's links):
 *   ?event=<slug>       an event from D1 (not a cancelled one), as it is now
 *   ?reveal=<kid slug>  the kid's reveal as it is now: a confirmed one from the
 *                       reveal cache (./_reveals.js), else the live broadcast's
 *                       plan, which also knows rehearsals from a "TEST …" job
 *                       (marked TEST). The day and time, never an address.
 *   signed fields       title, start, end, allday, location, details, url, uid
 *                       and sig = HMAC-SHA256 with CALENDAR_LINK_SECRET: the
 *                       email's own words, exactly as staff wrote them
 *   old unsigned links  (emails sent before this) served as the reveal or
 *                       event they name (slug in the uid or url) as it is now,
 *                       wherever its date moved; with no slug, one on the same
 *                       day whose name is in the title. Nothing from the link
 *                       itself is used, so it can't put words on our domain.
 * Anything else is a plain 404 page.
 *
 *   start  compact UTC ("20260615T190000Z") for a timed event, or YYYYMMDD
 *          for an all-day event (allday=1)
 *   end    same format; for all-day, the EXCLUSIVE end (the day after)
 *
 * Public endpoint; safe to call without auth.
 */

import { verifyCalendarParams, SITE_URL } from './_calendar-links.js';
import { easternParts, easternToUtcIso, normalizeName, getReveals, todayEastern } from './_reveals.js';
import { limit } from './_rate-limit.js';
import { ical, fold } from './_ics.js';

const PRODID = '-//Sunshine on a Ranney Day//Reveal Invite//EN';
const REVEAL_MINUTES = 120;              // the reveal email's own default length
const REVEAL_CACHE_FRESH_MS = 15 * 60 * 1000;

function isCompactDateTime(s) { return /^\d{8}T\d{6}Z$/.test(s); }
function isCompactDate(s) { return /^\d{8}$/.test(s); }

const SLUG = /^[a-z0-9-]{1,80}$/;
const compactUtc = (d) => d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const ymd = (date) => String(date).replace(/-/g, '');
/** YYYYMMDD → the next day, YYYYMMDD (all-day ends are exclusive) */
function nextDay(compact) {
  const d = new Date(Date.UTC(+compact.slice(0, 4), +compact.slice(4, 6) - 1, +compact.slice(6, 8) + 1));
  return compactUtc(d).slice(0, 8);
}
/** A link's start → its Eastern day, 'YYYY-MM-DD' */
function easternDay(start) {
  if (isCompactDate(start)) return `${start.slice(0, 4)}-${start.slice(4, 6)}-${start.slice(6, 8)}`;
  if (!isCompactDateTime(start)) return null;
  const iso = `${start.slice(0, 4)}-${start.slice(4, 6)}-${start.slice(6, 8)}T${start.slice(9, 11)}:${start.slice(11, 13)}:${start.slice(13, 15)}Z`;
  return easternParts(iso)?.date || null;
}
const words = (s) => new Set(normalizeName(s).split(' ').filter(Boolean));
/** Every word of `name` is in `title` ("Ava" in "Ava's Reveal Day — …") */
const titleNames = (title, name) => {
  const t = words(String(title).replace(/['’]s\b/gi, ''));
  const n = [...words(name)].filter((x) => x !== 'and');
  return n.length > 0 && n.every((x) => t.has(x));
};
const isDay = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));

// ─── What the site knows ────────────────────────────────────────────

/** "6:00 to 11:00 p.m." / "7:00 AM" / "18:30" → { start: 'HH:MM', end: 'HH:MM' | null }, or null */
export function parseEventTime(text) {
  const re = /(\d{1,2})(?::(\d{2}))?\s*(a\.?\s?m\.?|p\.?\s?m\.?)?/gi;
  const found = [];
  let m;
  while ((m = re.exec(String(text || ''))) && found.length < 2) {
    const h = Number(m[1]);
    const min = Number(m[2] || 0);
    if (h > 23 || min > 59 || (!m[2] && !m[3])) continue; // a bare number isn't a time
    found.push({ h, min, mer: m[3] ? (m[3][0].toLowerCase() === 'p' ? 'pm' : 'am') : null });
  }
  if (!found.length) return null;
  const [a, b] = found;
  if (!a.mer && b?.mer && b.h <= 12) a.mer = (a.h % 12) <= (b.h % 12) ? b.mer : (b.mer === 'pm' ? 'am' : 'pm');
  const to24 = ({ h, min, mer }) => {
    const hh = mer === 'pm' ? (h % 12) + 12 : mer === 'am' ? h % 12 : h;
    return `${String(hh).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
  };
  return { start: to24(a), end: b ? to24(b) : null };
}

/** An event from D1 as an invite, or null (unknown, cancelled, or no date) */
async function eventInvite(env, slug) {
  if (!SLUG.test(String(slug || '')) || !env.DB) return null;
  const row = await env.DB.prepare('SELECT slug, title, date, data FROM events WHERE slug = ?').bind(slug).first();
  if (!row) return null;
  let d = {};
  try { d = JSON.parse(row.data || '{}'); } catch { /* columns only */ }
  if (d.status === 'cancelled' || d.publishStatus === 'draft') return null;
  const date = d.date || row.date;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return null;
  const title = d.title || row.title || 'Sunshine on a Ranney Day event';
  const pageUrl = `${SITE_URL}/events/${row.slug}/`;
  const t = parseEventTime(d.time);
  let start, end, allDay = false;
  if (t) {
    const startIso = easternToUtcIso(date, t.start);
    let endIso = t.end ? easternToUtcIso(d.endDate || date, t.end) : null;
    if (!endIso || Date.parse(endIso) <= Date.parse(startIso)) endIso = new Date(Date.parse(startIso) + 2 * 3600e3).toISOString();
    start = compactUtc(new Date(startIso));
    end = compactUtc(new Date(endIso));
  } else {
    allDay = true;
    start = ymd(date);
    end = nextDay(ymd(/^\d{4}-\d{2}-\d{2}$/.test(String(d.endDate || '')) ? d.endDate : date));
  }
  return {
    uid: `event-${row.slug}@sunshineonaranneyday.com`,
    title, start, end, allDay,
    location: [d.location, d.address].filter(Boolean).join(', '),
    details: `${d.shortDescription || String(d.description || '').split('\n')[0] || ''}`.trim().slice(0, 1200),
    url: pageUrl,
    // For matching old links
    day: date, lastDay: d.endDate || date,
  };
}

/** Confirmed upcoming reveals: the cache, refreshed from JobTread when it's stale and can't answer */
async function knownReveals(env, wanted) {
  if (!env.DB) return [];
  const row = await env.DB.prepare("SELECT data FROM site_config WHERE key = 'reveals'").first().catch(() => null);
  let cache = null;
  try { cache = row ? JSON.parse(row.data) : null; } catch { /* refreshed below */ }
  const reveals = Array.isArray(cache?.reveals) ? cache.reveals : [];
  const fresh = Date.now() - Date.parse(cache?.updatedAt || 0) < REVEAL_CACHE_FRESH_MS;
  if (reveals.some(wanted) || fresh || !env.JOBTREAD_GRANT_KEY) return reveals;
  // A few refreshes an hour at most, however many links are opened
  if (!(await limit(env.DB, 'calendar-ics:reveal-refresh', 4, 3600)).ok) return reveals;
  return (await getReveals(env).catch(() => null))?.reveals || reveals;
}

/**
 * The live broadcast's plan (site_config "broadcast-schedule", kept by
 * ./_broadcast-schedule.js): the next reveal, the last one it planned, and
 * confirmed ones it couldn't plan. Rehearsals from a "TEST …" job are only
 * here (marked test). Drafts and jobs with no kid page are left out.
 */
async function plannedReveals(env) {
  const row = await env.DB.prepare("SELECT data FROM site_config WHERE key = 'broadcast-schedule'").first().catch(() => null);
  let rec = null;
  try { rec = row ? JSON.parse(row.data) : null; } catch { return []; }
  const today = todayEastern();
  return [rec?.next, rec?.last?.reveal, ...(Array.isArray(rec?.waiting) ? rec.waiting : [])]
    .filter((r) => r && SLUG.test(String(r.slug || '')) && r.name && isDay(r.date) && r.date >= today && r.problem !== 'draft' && r.problem !== 'no-kid');
}

/** Every reveal the site knows now: confirmed ones first, then the broadcast's plan */
async function allReveals(env, wanted) {
  if (!env.DB) return [];
  const confirmed = (await knownReveals(env, wanted)).filter((r) => SLUG.test(String(r.slug || '')) && isDay(r.date));
  return confirmed.some(wanted) ? confirmed : [...confirmed, ...(await plannedReveals(env))];
}

/** The kid's reveal as the site has it now (a real one before a rehearsal), or null */
async function currentReveal(env, slug) {
  if (!SLUG.test(String(slug || ''))) return null;
  const mine = (r) => r.slug === slug;
  const all = (await allReveals(env, mine)).filter(mine);
  return all.find((r) => !r.test) || all[0] || null;
}

function revealEvent(r) {
  const day = r.date;
  let start, end, allDay = false;
  if (r.time) {
    const s = new Date(r.startsAt || easternToUtcIso(day, r.time));
    start = compactUtc(s);
    end = compactUtc(new Date(s.getTime() + REVEAL_MINUTES * 60e3));
  } else {
    allDay = true;
    start = ymd(day);
    end = nextDay(start);
  }
  const kidUrl = `${SITE_URL}/kids/${r.slug}/`;
  return {
    uid: `reveal-${r.slug}-${ymd(day)}@sunshineonaranneyday.com`,
    title: `${r.test ? 'TEST · ' : ''}${r.name}'s Reveal Day`,
    start, end, allDay,
    location: '',
    details: r.test
      ? `A rehearsal from a TEST job in JobTread, not a real reveal.\n\n${kidUrl}`
      : `Be there for ${r.name}'s first look at the finished room, with Sunshine on a Ranney Day.\n\n${kidUrl}`,
    url: kidUrl,
  };
}

async function revealInvite(env, slug) {
  const r = await currentReveal(env, slug);
  return r ? revealEvent(r) : null;
}

/** Signed by the site: the fields as given */
function signedInvite(env, q) {
  if (!verifyCalendarParams(q, env.CALENDAR_LINK_SECRET)) return null;
  const allDay = q.get('allday') === '1';
  const start = q.get('start') || '';
  const end = q.get('end') || '';
  const ok = allDay ? isCompactDate(start) && isCompactDate(end) : isCompactDateTime(start) && isCompactDateTime(end);
  if (!ok) return null;
  return {
    uid: (q.get('uid') || '').replace(/[^A-Za-z0-9@._-]/g, '') || `evt-${start}@sunshineonaranneyday.com`,
    title: q.get('title') || 'Event', start, end, allDay,
    location: q.get('location') || '', details: q.get('details') || '', url: q.get('url') || '',
  };
}

/**
 * A link from before invites were built server-side (still in families' and
 * guests' inboxes), or one whose signature no longer checks out. It is served
 * as what it names, as the site has it now: the kid's reveal by the slug in
 * its uid or url (on its new date if it moved), or the event by its page.
 * With no slug, a reveal or event on the link's own day whose name is in the
 * title. Nothing from the link is shown: the invite is the site's own.
 */
async function legacyInvite(env, q) {
  const start = q.get('start') || '';
  const day = easternDay(start);
  if (!day) return null;
  const title = q.get('title') || '';
  const uid = q.get('uid') || '';
  const link = q.get('url') || '';
  const kidSlug = (/^reveal-([a-z0-9-]+)-\d{8}@sunshineonaranneyday\.com$/.exec(uid) || /^https:\/\/sunshineonaranneyday\.com\/kids\/([a-z0-9-]+)\/?$/.exec(link) || [])[1] || null;
  if (kidSlug) return revealInvite(env, kidSlug);
  const eventSlug = (/^https:\/\/sunshineonaranneyday\.com\/events\/([a-z0-9-]+)\/?$/.exec(link) || /^event-([a-z0-9-]+)@sunshineonaranneyday\.com$/.exec(uid) || [])[1] || null;
  if (eventSlug) return eventInvite(env, eventSlug);
  if (!title) return null;

  // Only the title to go on: it has to be that day, too
  const named = (r) => r.date === day && titleNames(title, r.name);
  const reveal = (await allReveals(env, named)).find(named);
  if (reveal) return revealEvent(reveal);
  if (!env.DB) return null;
  const { results } = await env.DB.prepare('SELECT slug, title FROM events WHERE date IS NOT NULL AND date <= ? ORDER BY date DESC LIMIT 25').bind(day).all();
  for (const row of results || []) {
    if (!titleNames(title, row.title)) continue;
    const ev = await eventInvite(env, row.slug);
    if (ev && ev.day <= day && day <= ev.lastDay) return ev;
  }
  return null;
}

function notFound() {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Calendar invite not found | Sunshine on a Ranney Day</title>
<style>body{margin:0;font-family:Outfit,Helvetica,Arial,sans-serif;background:#FEFCF5;color:#2D2E33;display:grid;place-items:center;min-height:100vh;padding:24px;box-sizing:border-box}main{max-width:460px;text-align:center}h1{font-family:'Libre Baskerville',Georgia,serif;font-size:1.75rem}p{line-height:1.6}a.btn{display:inline-block;margin-top:16px;background:#FFDA24;color:#2D2E33;font-weight:700;text-decoration:none;padding:12px 22px;border-radius:10px}</style></head>
<body><main><h1>We couldn't find that event</h1><p>It may have moved or already happened. Upcoming events and reveals are on our website.</p><a class="btn" href="${SITE_URL}/events/">See upcoming events</a></main></body></html>`;
  return new Response(html, { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' } });
}

export async function onRequestGet(context) {
  const { env } = context;
  const q = new URL(context.request.url).searchParams;
  let ev = null;
  try {
    if (q.has('event')) ev = await eventInvite(env, q.get('event'));
    else if (q.has('reveal')) ev = await revealInvite(env, q.get('reveal'));
    else if (q.has('start')) {
      // Signed by the site: as written. A signature that can't be checked (the
      // secret changed or was removed) falls back to matching, like an old link.
      ev = (q.has('sig') && signedInvite(env, q)) || await legacyInvite(env, q);
    }
  } catch (err) {
    console.error('[calendar.ics]', err);
    ev = null;
  }
  if (!ev) return notFound();
  return icsResponse(ev);
}

function icsResponse({ uid, title, start, end, allDay, location, details, url: eventUrl }) {
  const dtstamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${PRODID}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${dtstamp}`,
    allDay ? `DTSTART;VALUE=DATE:${start}` : `DTSTART:${start}`,
    allDay ? `DTEND;VALUE=DATE:${end}` : `DTEND:${end}`,
    `SUMMARY:${ical(title)}`,
  ];
  if (location) lines.push(`LOCATION:${ical(location)}`);
  if (details) lines.push(`DESCRIPTION:${ical(details)}`);
  if (eventUrl) lines.push(`URL:${ical(eventUrl)}`);
  lines.push('END:VEVENT', 'END:VCALENDAR');

  const body = lines.map(fold).join('\r\n') + '\r\n';

  // Filename derived from title — sanitized, lowercased
  const filename = (String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'event') + '.ics';

  return new Response(body, {
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8; method=PUBLISH',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'public, max-age=300',
    },
  });
}
