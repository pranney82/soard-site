/**
 * The Coming up band's timeline rows (src/components/live/UpcomingReveals.astro), as HTML: written into the
 * page at build time from the reveals copy, and again in the browser when /api/reveals has something newer,
 * by this one function so both match. Drawn at build, the band has its height from the first paint: nothing
 * below it jumps when the list arrives, and Back or a reload lands where the visitor left.
 *
 * Each row: the "when" (day and time once confirmed; a third of the month while tentative, never a day),
 * a dot on the line, and the child's card (photo or initial, name and rooms, Watch live or "Exact day to
 * come", and their own invite button, RevealInvite.astro).
 */
import { cfRaw } from './cf-image';
import { windowTitle, revealTime, revealDateText, inviteData, possessive, otherYear, shownZone, type UpcomingReveal, type Signup } from './reveals-client';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
const attrs = (o: Record<string, string>) => Object.entries(o).map(([k, v]) => `${k}="${esc(v)}"`).join(' ');

const CAL_ADD = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/><path d="M12 14v4"/><path d="M10 16h4"/></svg>';
const ARROW = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12h14"/><path d="m12 5 7 7-7 7"/></svg>';
const CF_PATH = /\/cdn-cgi\/imagedelivery\/[^/]+\/(.+)\/[^/]+$|imagedelivery\.net\/[^/]+\/(.+)\/[^/]+$/;

/** A square crop of the kid's photo at the size it's shown */
function photo(src: string | null, px: number): string | null {
  const m = src ? CF_PATH.exec(src) : null;
  const id = m?.[1] || m?.[2];
  return id ? cfRaw(id, `w=${px},h=${px},fit=cover,gravity=face,q=80`) : null;
}

/** "Bathroom and bedroom" */
function roomsText(rooms: string[]): string {
  const r = rooms.map((x) => x.toLowerCase());
  const list = r.length > 1 ? `${r.slice(0, -1).join(', ')} and ${r.at(-1)}` : r[0] || '';
  return list ? list.charAt(0).toUpperCase() + list.slice(1) : '';
}


function whenHtml(r: UpcomingReveal, tz: string): string {
  if (r.confirmed) {
    // In the visitor's own zone, as the live banner and the hero show it ("1:00 PM PST" in Los Angeles)
    return `<div class="upn-when"><p class="upn-when__top">${esc(revealDateText(r, { weekday: 'long' }, tz))}</p>`
      // Another year's date carries its year ("Jan 8, 2027"), as a tentative month does, so the timeline reads in order
      + `<p class="upn-when__main">${esc(revealDateText(r, { month: 'short', day: 'numeric', ...(otherYear(r) ? { year: 'numeric' } : {}) }, tz))}</p>`
      + `<p class="upn-when__sub">${esc(revealTime(r, tz) || 'Time to come')}</p></div>`;
  }
  // "Early" over "December"; another year's month carries its year on a line of its own, so it never runs into the dot
  const [part, ...rest] = windowTitle(r.window).split(' ');
  const year = /^\d{4}$/.test(rest.at(-1) || '') ? rest.pop() : '';
  const bar = ['early', 'mid', 'late'].map((p) => `<span${p === r.window.part ? ' class="is-on"' : ''}></span>`).join('');
  return `<div class="upn-when"><p class="upn-when__top">${esc(part)}</p><p class="upn-when__main">${esc(rest.join(' '))}</p>`
    + (year ? `<p class="upn-when__sub">${esc(year)}</p>` : '')
    + `<span class="upn-month" aria-hidden="true">${bar}</span></div>`;
}

function cardHtml(r: UpcomingReveal, i: number, tz: string): string {
  const src = photo(r.image, 192);
  // No photo (or it fails to load, see UpcomingReveals' error listener): the kid's initial in its place
  const initial = esc(r.name.trim().charAt(0).toUpperCase());
  const media = src
    ? `<div class="upn-card__photo" data-initial="${initial}"><img src="${esc(src)}" srcset="${esc(src)} 1x, ${esc(photo(r.image, 288))} 1.5x, ${esc(photo(r.image, 384))} 2x" alt="" width="96" height="96" loading="${i < 3 ? 'eager' : 'lazy'}" decoding="async" /></div>`
    : `<div class="upn-card__photo upn-card__photo--blank" aria-hidden="true">${initial}</div>`;
  const label = r.confirmed
    ? `${r.name}: reveal ${revealDateText(r, { weekday: 'long', month: 'long', day: 'numeric' }, tz)}${revealTime(r, tz) ? ` at ${revealTime(r, tz)}` : ''}. Read the story.`
    : `${r.name}: reveal planned for ${r.window.label}. Read the story.`;
  const rooms = roomsText(r.rooms || []);
  const invite = `<button class="upn-add" type="button" ${attrs(inviteData(r))} aria-label="${esc(`Add to calendar: ${possessive(r.name)} reveal`)}">${CAL_ADD}<span>Add to calendar</span></button>`;
  const foot = r.confirmed
    ? `<a class="upn-act" href="${esc(r.liveUrl)}" aria-label="${esc(`Watch live: ${possessive(r.name)} reveal`)}">Watch live ${ARROW}</a>${invite}`
    : `<span class="upn-pill">Exact day to come</span>${invite}`;
  return `<article class="upn-card">${media}<div class="upn-card__body">`
    + `<h3 class="upn-card__name"><a href="${esc(r.kidUrl)}" aria-label="${esc(label)}">${esc(r.name)}</a></h3>`
    + (rooms ? `<p class="upn-card__rooms">${esc(rooms)}</p>` : '')
    + `<div class="upn-card__foot">${foot}</div></div></article>`;
}

/**
 * limit: rows after the first `limit` are marked data-more, for a band that opens on the next few (/reveals/).
 * tz: the zone times are shown in, the visitor's own by default; the server passes the visitor's zone as Cloudflare
 * knows it (functions/_upcoming-band.js), so its rows are the ones the page script would draw.
 */
export function bandRowsHtml(list: UpcomingReveal[], { limit = 0, tz = shownZone() }: { limit?: number; tz?: string } = {}): string {
  return list.map((r, i) => `<li class="upn-row${i === 0 ? ' is-next' : ''}"${limit && i >= limit ? ' data-more' : ''} data-slug="${esc(r.slug)}" data-state="${r.confirmed ? 'confirmed' : 'tentative'}" style="--i:${limit && i >= limit ? i - limit : i}">`
    + `${whenHtml(r, tz)}<span class="upn-node" aria-hidden="true"></span>${cardHtml(r, i, tz)}</li>`).join('');
}

/**
 * Whether a band shows: anything scheduled, or, with nothing scheduled, a band that stays as the way to hear about
 * the next one (data-keep-empty, the events page) while email sign-up is open or not yet known not to be (its card
 * says what the band offers). signup: as read from /api/reveals, null when it didn't say, undefined when not read.
 * The page script and the server (functions/_upcoming-band.js) both decide by this.
 */
export const bandShows = (shownCount: number, keepEmpty: boolean, signup: Signup | null | undefined): boolean =>
  shownCount > 0 || (keepEmpty && signup !== null && signup?.email !== false);
