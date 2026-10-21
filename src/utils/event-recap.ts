/**
 * What a recap page tells search engines and link previews: its title,
 * description, share image, Event JSON-LD and breadcrumbs. Used by every page
 * that renders EventRecap.astro (gala, golf, the year pages, /events/<slug>/).
 */
import { cfRaw } from './cf-image';
import {
  seriesOf, yearOf, displayName, recapPhotos, recapSponsors, sponsorCount, eventPath, yearPath,
} from '../../public/admin/events-shared.js';

const SITE = 'https://sunshineonaranneyday.com';

/** The gala's theme for its year: the event's own, else the one this page was written for */
export function galaThemeName(ev: any): string {
  if (ev?.theme) return String(ev.theme).trim();
  return yearOf(ev) === '2026' ? 'Havana Nights' : '';
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

  const cover = photos[0]?.id || ev.image || null;
  const ogImage = cover ? cfRaw(cover, 'w=1200,h=630,fit=cover,gravity=face,q=82') : undefined;

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

  return { title, description, ogImage, jsonLd, breadcrumbs };
}
