/**
 * The "Coming up" rows in the live page's hero, as HTML: written into the
 * page at build time (from the reveals copy) and again in the browser when
 * /api/reveals has something newer, by this one function so both match.
 * Each row: photo, name, when (a third of the month while tentative, the
 * day and time once confirmed), and the child's own invite button
 * (src/components/live/RevealInvite.astro).
 *
 * `tz`: the zone the times are shown in. The browser's own by default; the
 * edge passes the visitor's (Cloudflare knows it), so /live/ is drawn in it
 * before it leaves the server and nothing changes once the page script runs.
 * With no script, a row's Add is the child's calendar feed itself.
 */
import { cfRaw } from './cf-image';
import { windowTitle, windowShort, revealDateText, revealTime, inviteData, possessive, shownZone, otherYear, type UpcomingReveal } from './reveals-client';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
const attrs = (o: Record<string, string>) => Object.entries(o).map(([k, v]) => `${k}="${esc(v)}"`).join(' ');

const CF_PATH = /\/cdn-cgi\/imagedelivery\/[^/]+\/(.+)\/[^/]+$|imagedelivery\.net\/[^/]+\/(.+)\/[^/]+$/;
/** A square crop of the kid's photo */
function photo(src: string | null, px: number): string | null {
  const m = src ? CF_PATH.exec(src) : null;
  const id = m?.[1] || m?.[2];
  return id ? cfRaw(id, `w=${px},h=${px},fit=cover,gravity=face,q=80`) : null;
}

const ADD_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8 2v4"/><path d="M16 2v4"/><rect width="18" height="18" x="3" y="4" rx="2"/><path d="M3 10h18"/><path d="M12 14v4"/><path d="M10 16h4"/></svg>';

/** Changes whenever what the rows say would change: who, their photo and rooms, when, and the zone times are shown in */
export const rowsSignature = (list: UpcomingReveal[], tz = shownZone()) => `${tz}|${new Date().getFullYear()}|${list.map((r) => [r.slug, r.name, r.image || '', (r.rooms || []).join('+'),
  r.confirmed ? `${r.date} ${r.time || ''}` : r.window.label].join(':')).join('|')}`;

/** A child's own calendar feed, for a page with no script (the Add button opens a sheet that needs one) */
export const kidFeed = (slug: string) => `webcal://sunshineonaranneyday.com/api/reveals.ics?kid=${encodeURIComponent(slug)}`;

function whenHtml(r: UpcomingReveal, tz: string): string {
  if (r.confirmed) {
    const time = revealTime(r, tz);
    return `<p class="hnx-when hnx-when--set"><span class="hnx-when__dot" aria-hidden="true"></span><span>${esc(revealDateText(r, { weekday: 'short', month: 'short', day: 'numeric', ...(otherYear(r) ? { year: 'numeric' } : {}) }, tz))}</span>${time ? `<span class="hnx-when__time">${esc(time)}</span>` : ''}</p>`;
  }
  const bar = ['early', 'mid', 'late'].map((p) => `<i${p === r.window.part ? ' class="is-on"' : ''}></i>`).join('');
  // "Early November", or "Early Nov" where the row is narrow
  return `<p class="hnx-when"><span class="hnx-month" aria-hidden="true">${bar}</span><span class="hnx-when__long">${esc(windowTitle(r.window))}</span><span class="hnx-when__short">${esc(windowShort(r.window))}</span></p>`;
}

export function heroRowsHtml(list: UpcomingReveal[], tz = shownZone()): string {
  return list.map((r, i) => {
    const src = photo(r.image, 112);
    const img = src
      ? `<img src="${esc(src)}" srcset="${esc(src)} 2x, ${esc(photo(r.image, 168))} 3x" alt="" width="56" height="56" loading="${i < 4 ? 'eager' : 'lazy'}" decoding="async" />`
      : `<span class="hnx-photo__initial">${esc(r.name.trim().charAt(0).toUpperCase())}</span>`;
    const label = r.confirmed ? `Add ${possessive(r.name)} reveal to your calendar` : `Add ${possessive(r.name)} reveal to your calendar (planned for ${r.window.label})`;
    return `<li class="hnx-row" data-slug="${esc(r.slug)}" data-state="${r.confirmed ? 'confirmed' : 'tentative'}" style="--i:${i}">`
      + `<a class="hnx-photo" href="${esc(r.kidUrl)}" tabindex="-1" aria-hidden="true">${img}</a>`
      + `<div class="hnx-text"><p class="hnx-name"><a href="${esc(r.kidUrl)}">${esc(r.name)}</a></p>${whenHtml(r, tz)}</div>`
      + `<button class="hnx-add" type="button" ${attrs(inviteData(r))} aria-label="${esc(label)}">${ADD_ICON}<span>Add</span></button>`
      + `<a class="hnx-add hnx-add--feed" href="${esc(kidFeed(r.slug))}" aria-label="${esc(label)}">${ADD_ICON}<span>Add</span></a>`
      + '</li>';
  }).join('');
}
