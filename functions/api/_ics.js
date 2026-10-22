/**
 * iCalendar text helpers (RFC 5545), shared by ./calendar.ics.js (one-event
 * invites) and ./reveals.ics.js (the reveal calendar people subscribe to).
 */

/** Escape per RFC 5545 §3.3.11 — for SUMMARY/LOCATION/DESCRIPTION. */
export function ical(text) {
  return String(text || '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\n|\r/g, '\\n');
}

const utf8Length = (ch) => {
  const c = ch.codePointAt(0);
  return c < 0x80 ? 1 : c < 0x800 ? 2 : c < 0x10000 ? 3 : 4;
};

/**
 * Fold a content line to ≤75 octets per RFC 5545 §3.1, never splitting a
 * character ("Josué", "’" and emoji are several bytes in UTF-8).
 */
export function fold(line) {
  const out = [];
  let cur = '';
  let bytes = 0;
  for (const ch of String(line)) {
    const n = utf8Length(ch);
    // The first line may hold 75 octets; each continuation starts with a space, so 74 more
    if (bytes + n > (out.length ? 74 : 75)) { out.push(cur); cur = ''; bytes = 0; }
    cur += ch;
    bytes += n;
  }
  out.push(cur);
  return out.map((l, i) => (i ? ` ${l}` : l)).join('\r\n');
}

/** Date → compact UTC ("20261117T210000Z") */
export const compactUtc = (d) => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
