/**
 * What a recap page tells search engines and link previews: its title,
 * description, share image, Event JSON-LD and breadcrumbs. Used by every page
 * that renders EventRecap.astro (gala, golf, the year pages, /events/<slug>/).
 */
import { cfRaw } from './cf-image';
import {
  seriesOf, yearOf, displayName, recapPhotos, recapSponsors, sponsorCount, eventPath, yearPath, recapThemeName,
  recapLead, RECAP_LOOKS,
} from '../../public/admin/events-shared.js';
import { SITE_LOOK, type CardSpec, type Look } from './og-card';

const SITE = 'https://sunshineonaranneyday.com';

/** The gala's theme for its year: the event's own, else the one this page was written for */
export function galaThemeName(ev: any): string {
  // One rule for the page and the recap email (public/admin/events-shared.js)
  return recapThemeName(ev);
}

/** The recap headline: the name, its last word on the marker (EventRecap.astro's hero) */
export function recapTitleParts(name: string): { lead: string; last: string } {
  const m = name.match(/^(.*\s)(\S+)$/);
  return m ? { lead: m[1], last: m[2] } : { lead: '', last: name };
}

const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A series' share-card colors: its pages' own (RECAP_LOOKS, the list the recap page and emails read), else the site's */
export function eventLook(key?: string | null): Look {
  const l = key ? (RECAP_LOOKS as Record<string, any>)[key] : null;
  if (!l) return SITE_LOOK;
  // The block behind the photo is the page's accent at the same strength (EventRecap's .rh-accent)
  const hex = String(l.accent || '#FFDA24').replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return { paper: l.paper, ink: l.ink, muted: l.muted, eyebrow: l.eyebrow, highlight: l.highlight, accent: `rgba(${r}, ${g}, ${b}, 0.35)` };
}

export function recapMeta(ev: any, events: any[], pageDoc: any, path: string) {
  const series = seriesOf(ev);
  const name = displayName(ev);
  const year = yearOf(ev);
  const photos = recapPhotos(ev, events, pageDoc);
  const sponsors = recapSponsors(ev, events, pageDoc);
  const n = sponsorCount(sponsors);
  const where = ev.location ? ` at ${String(ev.location).trim()}` : '';

  const title = photos.length ? `${name} ${year}: Photos and Sponsors` : `${name} ${year}: Thank You`;
  const description = [
    photos.length ? `${photos.length} photos from the ${year} ${name}${where}.` : `The ${year} ${name}${where}.`,
    n ? `Thank you to the ${n} sponsors who made it possible.` : 'Thank you to everyone who came.',
  ].join(' ');

  // The share card is the recap's hero: eyebrow, headline, lead, the cover and the second photo
  const cover = photos[0]?.id || ev.image || null;
  const parts = recapTitleParts(name);
  const og: CardSpec = {
    layout: 'split',
    eyebrow: `${year} · Thank you`,
    title: `${escHtml(parts.lead)}<em>${escHtml(parts.last)}</em>`,
    lead: recapLead(ev, { photos: photos.length, sponsors: sponsors.length }),
    photo: cover ? { id: cover, alt: photos[0]?.alt || `${name} ${year}` } : null,
    inset: photos[1]?.id ? { id: photos[1].id } : null,
    look: eventLook(series?.key),
  };

  const permanent = yearPath(ev, events) || eventPath(ev, events);
  const jsonLd = {
    '@type': 'Event',
    '@id': `${SITE}${permanent}#event`,
    name: `${name} ${year}`,
    description,
    startDate: ev.date,
    ...(ev.endDate && { endDate: ev.endDate }),
    eventAttendanceMode: 'https://schema.org/OfflineEventAttendanceMode',
    eventStatus: 'https://schema.org/EventScheduled',
    location: {
      '@type': 'Place',
      name: ev.location || name,
      ...(ev.address && { address: { '@type': 'PostalAddress', streetAddress: ev.address } }),
    },
    organizer: { '@id': `${SITE}/#organization` },
    ...(photos.length ? { image: photos.slice(0, 6).map((p: any) => cfRaw(p.id, 'w=1600,fit=scale-down,q=85')) } : ev.image ? { image: cfRaw(ev.image, 'w=1200,q=85') } : {}),
  };

  const breadcrumbs = series
    ? (path === series.path
      ? [{ name: 'Events', url: '/events/' }, { name, url: series.path }]
      : [{ name: 'Events', url: '/events/' }, { name, url: series.path }, { name: year, url: path }])
    : [{ name: 'Events', url: '/events/' }, { name: String(ev.title || name).trim(), url: path }];

  return { title, description, og, jsonLd, breadcrumbs };
}
