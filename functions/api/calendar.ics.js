/**
 * GET /api/calendar.ics
 *
 * Generates an iCalendar (.ics) file for a single event. Used by the
 * `revealInvite` email block's "Apple" calendar link — recipients click,
 * the file downloads, and Apple Calendar / Outlook desktop / Gmail / etc.
 * open it natively.
 *
 * Query params:
 *   title    - event summary
 *   start    - either compact UTC ("20260615T190000Z") for a timed event,
 *              or YYYYMMDD for an all-day event (when allday=1)
 *   end      - same format as start; for all-day, this is the EXCLUSIVE end
 *              (the day after the last day of the event)
 *   allday   - "1" if start/end are date-only
 *   location - optional
 *   details  - optional
 *   uid      - optional; auto-generated if absent
 *   url      - optional event URL
 *
 * Public endpoint; safe to call without auth.
 */

const PRODID = '-//Sunshine on a Ranney Day//Reveal Invite//EN';

/** Escape per RFC 5545 §3.3.11 — for SUMMARY/LOCATION/DESCRIPTION. */
function ical(text) {
  return String(text || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\n|\r/g, '\\n');
}

/** Fold a single content line to ≤75 octets per RFC 5545 §3.1. */
function fold(line) {
  if (line.length <= 75) return line;
  const out = [];
  let i = 0;
  while (i < line.length) {
    const chunk = line.slice(i, i + (i === 0 ? 75 : 74));
    out.push(i === 0 ? chunk : ' ' + chunk);
    i += chunk.length;
  }
  return out.join('\r\n');
}

function isCompactDateTime(s) { return /^\d{8}T\d{6}Z$/.test(s); }
function isCompactDate(s) { return /^\d{8}$/.test(s); }

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const q = url.searchParams;

  const title = q.get('title') || 'Event';
  const start = q.get('start') || '';
  const end = q.get('end') || '';
  const allDay = q.get('allday') === '1';
  const location = q.get('location') || '';
  const details = q.get('details') || '';
  const eventUrl = q.get('url') || '';
  const uid = q.get('uid') || `evt-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@sunshineonaranneyday.com`;

  // Validate format matches the allDay flag
  const validStart = allDay ? isCompactDate(start) : isCompactDateTime(start);
  const validEnd = allDay ? isCompactDate(end) : isCompactDateTime(end);
  if (!validStart || !validEnd) {
    return new Response('Invalid start/end. Use 20260615T190000Z for timed events or 20260615 with allday=1 for all-day.', { status: 400 });
  }

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
  if (eventUrl) lines.push(`URL:${eventUrl}`);
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
