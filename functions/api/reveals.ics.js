/**
 * GET /api/reveals.ics — the reveal calendar people subscribe to
 * ===========================================================================
 * One address adds every live room reveal to someone's own calendar (the
 * "Coming up" list on /live/ and the events page link it for Apple, Google
 * and Outlook). Each confirmed reveal appears with its day, time and the
 * link to watch live; it moves when JobTread moves it, and stays for a few
 * months after it happens. Tentative reveals stay out: a calendar entry
 * needs a day, and a tentative reveal's day is never public (./_reveals.js).
 *
 *   GET /api/reveals.ics                 the whole calendar (subscribe to it)
 *   GET /api/reveals.ics?reveal=<slug>   one confirmed reveal, as a file to open
 *
 * Read from the reveals copy in D1 (kept fresh by /api/reveals); when that is
 * stale it asks JobTread, a few times an hour at most however many
 * calendars poll. Responses are cached at the edge for a few minutes.
 * Public, never an address: the location is the live page.
 */

import { getReveals, cachedReveals, todayEastern } from './_reveals.js';
import { limit } from './_rate-limit.js';
import { ical, fold, compactUtc } from './_ics.js';

export const SITE = 'https://sunshineonaranneyday.com';
export const FEED_PATH = '/api/reveals.ics';
export const CALENDAR_NAME = 'Sunshine on a Ranney Day reveals';
const PRODID = '-//Sunshine on a Ranney Day//Live Reveals//EN';
const MINUTES = 60;
const ALERT_MINUTES = 15;
const FRESH_MS = 15 * 60 * 1000;
const EDGE_TTL = 600;
const SLUG = /^[a-z0-9-]{1,80}$/;

const possessive = (name) => (/s$/i.test(name) ? `${name}’` : `${name}’s`);
const ymd = (date) => String(date).replace(/-/g, '');
const nextDay = (date) => {
  const [y, m, d] = String(date).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10).replace(/-/g, '');
};

/** One reveal as a VEVENT's lines. The UID is the kid's, so a moved reveal updates in place. */
export function revealEvent(r, { past = false, stamp = compactUtc(new Date()) } = {}) {
  const live = `${SITE}/live/${r.slug}/`;
  const story = `${SITE}/kids/${r.slug}/`;
  const whose = possessive(r.name);
  const timed = !!(r.time && r.startsAt && !Number.isNaN(Date.parse(r.startsAt)));
  const lines = ['BEGIN:VEVENT', `UID:live-reveal-${r.slug}@sunshineonaranneyday.com`, `DTSTAMP:${stamp}`];
  if (timed) {
    const start = Date.parse(r.startsAt);
    lines.push(`DTSTART:${compactUtc(start)}`, `DTEND:${compactUtc(start + MINUTES * 60e3)}`);
  } else {
    lines.push(`DTSTART;VALUE=DATE:${ymd(r.date)}`, `DTEND;VALUE=DATE:${nextDay(r.date)}`);
  }
  let summary, details, link;
  if (past) {
    summary = `${whose} Room Reveal`;
    details = `${r.name} saw the finished room for the first time. Watch the reveal and read the story:\n${story}`;
    link = story;
  } else {
    summary = timed ? `${whose} Room Reveal (watch live)` : `${whose} Room Reveal (time coming soon)`;
    details = [
      timed ? null : 'The start time is coming soon. This entry updates on its own when it is set.\n',
      `Watch live: ${live}`,
      '',
      `The moment ${r.name} sees the finished room for the first time. Open the link a few minutes early to catch the start.`,
      '',
      `Read ${whose} story: ${story}`,
    ].filter((l) => l !== null).join('\n');
    link = live;
  }
  lines.push(
    `SUMMARY:${ical(summary)}`,
    `DESCRIPTION:${ical(details)}`,
    `LOCATION:${ical(link)}`,
    `URL:${ical(link)}`,
    'STATUS:CONFIRMED',
    'TRANSP:TRANSPARENT',
  );
  if (timed && !past) {
    lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `TRIGGER:-PT${ALERT_MINUTES}M`, `DESCRIPTION:${ical(`${whose} room reveal goes live in ${ALERT_MINUTES} minutes`)}`, 'END:VALARM');
  }
  lines.push('END:VEVENT');
  return lines;
}

/** The whole calendar: confirmed reveals ahead, then the ones kept from the last few months */
export function buildCalendar({ reveals = [], past = [] }, { now = Date.now(), only = null } = {}) {
  const stamp = compactUtc(now);
  const today = todayEastern(now);
  const head = ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:${PRODID}`, 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH'];
  if (!only) {
    const about = 'Live room reveals from Sunshine on a Ranney Day. Each reveal appears here once its day is set, with the link to watch it live.';
    head.push(
      `NAME:${ical(CALENDAR_NAME)}`, `X-WR-CALNAME:${ical(CALENDAR_NAME)}`,
      `DESCRIPTION:${ical(about)}`, `X-WR-CALDESC:${ical(about)}`,
      'X-WR-TIMEZONE:America/New_York',
      // Apple and Outlook re-read the calendar this often (Google keeps its own schedule)
      'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H',
      `URL:${SITE}/live/`, `SOURCE;VALUE=URI:${SITE}${FEED_PATH}`,
      'COLOR:gold',
    );
  }
  const events = [];
  const seen = new Set();
  for (const r of reveals) {
    if (!SLUG.test(String(r?.slug || '')) || !r.name || !r.date || seen.has(r.slug)) continue;
    if (only && r.slug !== only) continue;
    seen.add(r.slug);
    events.push(...revealEvent(r, { past: r.date < today, stamp }));
  }
  if (!only) {
    for (const r of past) {
      if (!SLUG.test(String(r?.slug || '')) || !r.name || !r.date || seen.has(r.slug)) continue;
      seen.add(r.slug);
      events.push(...revealEvent(r, { past: true, stamp }));
    }
  }
  return [...head, ...events, 'END:VCALENDAR'].map(fold).join('\r\n') + '\r\n';
}

/** The reveals copy, refreshed from JobTread when it's stale (rate-limited) */
async function load(env) {
  const cached = await cachedReveals(env).catch(() => null);
  const age = Date.now() - Date.parse(cached?.updatedAt || 0);
  if (cached?.source === 'cache' && age < FRESH_MS) return cached;
  if (!env.JOBTREAD_GRANT_KEY || !env.DB) return cached || { reveals: [], past: [] };
  if (!(await limit(env.DB, 'reveals-ics:refresh', 6, 3600).catch(() => ({ ok: false }))).ok) return cached || { reveals: [], past: [] };
  return getReveals(env);
}

function notFound() {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>No date yet | Sunshine on a Ranney Day</title>
<style>body{margin:0;font-family:Outfit,Helvetica,Arial,sans-serif;background:#FEFCF5;color:#2D2E33;display:grid;place-items:center;min-height:100vh;padding:24px;box-sizing:border-box}main{max-width:460px;text-align:center}h1{font-family:'Libre Baskerville',Georgia,serif;font-size:1.75rem}p{line-height:1.6}a.btn{display:inline-block;margin-top:16px;background:#FFDA24;color:#2D2E33;font-weight:700;text-decoration:none;padding:12px 22px;border-radius:10px}</style></head>
<body><main><h1>This reveal has no date yet</h1><p>It goes on the calendar as soon as its day and time are set. Every upcoming reveal is on the live page.</p><a class="btn" href="${SITE}/live/#up-next">See what's coming up</a></main></body></html>`;
  return new Response(html, { status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=60', 'X-Robots-Tag': 'noindex' } });
}

export async function onRequestGet(context) {
  const { env, request } = context;
  const url = new URL(request.url);
  const only = url.searchParams.get('reveal');
  if (only !== null && !SLUG.test(only)) return notFound();

  // Only the one parameter that matters keys the cache, so stray query strings can't reach JobTread
  const cache = typeof caches !== 'undefined' ? caches.default : null;
  const cacheKey = new Request(`${url.origin}${FEED_PATH}${only ? `?reveal=${only}` : ''}`, { method: 'GET' });
  if (cache) {
    const hit = await cache.match(cacheKey).catch(() => null);
    if (hit) return hit;
  }

  let data;
  try {
    data = await load(env);
  } catch (err) {
    console.error('[reveals.ics]', err);
    data = { reveals: [], past: [] };
  }
  if (only && !(data.reveals || []).some((r) => r.slug === only)) return notFound();

  const body = buildCalendar(data, { only });
  const res = new Response(body, {
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': only ? `attachment; filename="${only}-reveal.ics"` : 'inline; filename="soard-reveals.ics"',
      'Cache-Control': `public, max-age=300, s-maxage=${EDGE_TTL}`,
      'Access-Control-Allow-Origin': '*',
    },
  });
  if (cache) context.waitUntil(cache.put(cacheKey, res.clone()).catch(() => {}));
  return res;
}
