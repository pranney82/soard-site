/**
 * The two newsletter emails that aren't about one kid, in the same design as
 * the reveal invite, Project Kickoff and Project Reveal (the dark cover, the
 * story in pictures, one yellow band that asks, the team's sign-off):
 *
 *   Event Recap      "What a Night!": the morning-after thank-you for the gala,
 *                    the golf tournament or any event with photos. Filled in
 *                    from the event's recap page (public/admin/events-shared.js
 *                    picks its photos and sponsors, as the page does). The gala's
 *                    and golf's look like their recap page instead (recapLook):
 *                    its colors, the cover on its paper, the ask in its dark card.
 *   Monthly Impact   "Your Monthly Dose of Sunshine": a month at SOARD from
 *                    what the site already knows (the reveals, what's being
 *                    built, what's coming, the event photos, the press).
 *
 * Neither says where a family lives, so both go to the newsletter list. Both
 * say only what's true from the data: no "[write here]" that could be sent by
 * mistake. Staff add their own words in Kit if they want.
 *
 * Pure: no fetches, so tests and the admin preview render exactly what Kit gets.
 */

import {
  SITE_URL, HERO_TRANSFORM, PHOTO_TRANSFORM, LOGO_TRANSFORM, SIDE, BRAND, SOARD_LOOK, escapeHtml, href, cfImg, label, tidy, kidName, listJoin,
  emailFrame, emailHeader, emailFooter, signOff, partnerCards, button, textLink, cover, keyWord, lede, photoImg, photoPair, noWidow,
  chosenWords, plainWords, askHeadlineHtml, askHeadlineFit,
  headlineFit, fitName, roomNames, galleryPicks, kidPhotos, makeoverWord,
} from './_reveal-invite-email.js';
import { askBand, gap, streamCheckUrl } from './_project-email.js';
import {
  seriesOf, eventPath, yearPath, yearOf, recapPhotos, recapSponsors, splitSponsors, momentName,
  cleanHighlights, displayName, recapLead, nameKey, RECAP_LOOKS, recapThemeName,
} from '../../public/admin/events-shared.js';

const { Y, D, DD, CR, TM, SANS, SERIF } = BRAND;

const WIDE_TRANSFORM = 'w=1200,h=720,fit=cover,gravity=auto,q=82';

/**
 * This file's emails' design. Change it whenever they change how they look or
 * read: drafts waiting in Kit that nobody has touched are then rebuilt on the
 * next hourly look (./_newsletter-drafts.js), not hours later.
 */
export const NEWSLETTER_DESIGN = '2026-11-10a';

/**
 * A CSS color ("#0d2f3f", "#fff", "rgba(232, 152, 112, 0.42)") as the solid one it shows on `under`:
 * email can't be trusted with see-through colors, so a page's marker and rules go in as they look on its paper.
 */
export function onto(css, under) {
  const rgb = (hex) => {
    const h = String(hex).replace('#', '');
    const full = h.length === 3 ? [...h].map((c) => c + c).join('') : h;
    return [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
  };
  const m = String(css).match(/^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/);
  const [r, g, b, a] = m ? [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]] : [...rgb(css), 1];
  const base = rgb(under);
  return `#${[r, g, b].map((v, i) => Math.round(v * a + base[i] * (1 - a)).toString(16).padStart(2, '0')).join('')}`;
}

/**
 * A recap email's look: its series' recap page's (RECAP_LOOKS, the list the page reads), else SOARD's.
 * The page's see-through colors go in as they show on its paper; words on the dark are white at the
 * page's own strength there (.rc-close__card p, 72%), with the footer's small print and dots fainter.
 * What the list leaves to the site (null) is SOARD's.
 */
export function recapLook(ev) {
  const p = RECAP_LOOKS[seriesOf(ev)?.key];
  if (!p) return SOARD_LOOK;
  const white = (strength) => onto(`rgba(255, 255, 255, ${strength})`, p.dark);
  return Object.freeze({
    page: true,
    outside: p.tile, paper: p.paper, ink: p.ink, muted: p.muted, line: onto(p.line, p.paper),
    eyebrow: p.eyebrow, eyebrowBar: p.eyebrow, highlight: onto(p.highlight, p.paper),
    dark: p.dark, onDark: white(0.72), faintOnDark: white(0.5), ruleOnDark: white(0.27),
    accentOnDark: p.bandAccent || SOARD_LOOK.accentOnDark, labelOnDark: p.bandAccent || SOARD_LOOK.accentOnDark,
  });
}

/**
 * Each series' mark from its own event page, as a picture since email can't draw
 * one (Cloudflare Images): golf's wave where the green meets the page (golf.astro
 * .ev-hero__wave), the gala's palms rising from the band's corners (gala.astro
 * .gv-hero__palms). It sits under the header, so its top is drawn in the look's
 * dark and its bottom in the dark or the paper; top and bottom say which colors
 * the picture was drawn in. Should the look's colors change, the mark is left out
 * (never a seam) until it's drawn again in the new ones.
 */
const RECAP_MARKS = Object.freeze({
  golf: Object.freeze({ id: 'emails/recap-golf-wave', h: 40, top: '#1a472a', bottom: '#f7f8f2' }),
  gala: Object.freeze({ id: 'emails/recap-gala-palms', h: 75, top: '#0d2f3f', bottom: '#0d2f3f' }),
});
const markUrl = (mark) => cfImg(mark.id, 'w=1200,q=90');
/** The mark a recap shows: its series', drawn in its look's colors, and loading */
export function recapMark(ev, look = recapLook(ev), broken = new Set()) {
  const mark = RECAP_MARKS[seriesOf(ev)?.key];
  if (!mark || broken.has(markUrl(mark))) return null;
  return mark.top === look.dark && [look.dark, look.paper].includes(mark.bottom) ? mark : null;
}
const markRow = (mark) => `<tr><td bgcolor="${mark.bottom}" style="background:${mark.bottom};padding:0;line-height:0;font-size:0;">
    <img src="${escapeHtml(markUrl(mark))}" width="600" height="${mark.h}" alt="" style="display:block;width:100%;max-width:100%;height:auto;border:0;" />
  </td></tr>`;

const COUNT_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const countWord = (n) => COUNT_WORDS[n] || String(n);
const cap = (s) => String(s).charAt(0).toUpperCase() + String(s).slice(1);
const plural = (n, one, many = `${one}s`) => `${countWord(n)} ${n === 1 ? one : many}`;
/** The event photos an email loads: a picture whose check failed is passed over */
const photoUrl = (id, transform) => cfImg(id, transform);
/** Spread across a set: neighbors are often the same moment */
const spread = (list, n) => (list.length <= n ? list : Array.from({ length: n }, (_, i) => list[Math.floor((i * list.length) / n)]));

/** A section on the paper: its label, then what's under it */
function section(title, inner, top = 44, look = SOARD_LOOK) {
  return `<tr><td bgcolor="${look.paper}" style="background:${look.paper};padding:${top}px 0 0;${SIDE}" class="pd">
    ${label(title, look.eyebrowBar, look.eyebrow, { rule: look.page })}
    <div style="height:18px;line-height:18px;font-size:0;">&nbsp;</div>
    ${inner}
  </td></tr>`;
}

/** Ruled rows: { small, main, link } each. small: the date or the outlet, over the main line. */
function ruledRows(rows, look = SOARD_LOOK) {
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="table-layout:fixed;">
      ${rows.map((r, i) => `<tr><td style="padding:14px 0 15px;${i ? `border-top:1px solid ${look.line};` : ''}">
        ${r.small ? `<div style="font-family:${SANS};font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:${look.muted};">${escapeHtml(r.small)}</div>
        <div style="height:5px;line-height:5px;font-size:0;">&nbsp;</div>` : ''}
        <div style="font-family:${SERIF};font-size:17px;font-weight:700;line-height:1.4;color:${look.ink};word-break:normal;overflow-wrap:break-word;">${r.mainHtml || noWidow(escapeHtml(r.main))}</div>
        ${r.sub ? `<div style="margin-top:3px;font-family:${SANS};font-size:14px;line-height:1.5;color:${look.muted};">${noWidow(escapeHtml(r.sub))}</div>` : ''}
        ${r.link ? `<div style="margin-top:8px;">${textLink(r.link.text, r.link.url, look.ink)}</div>` : ''}
      </td></tr>`).join('')}
    </table>`;
}

/** Big numbers on the dark: [{ value, label }], two to a row */
function numbersBand({ kicker, numbers, top = 44 }) {
  const rows = [];
  for (let i = 0; i < numbers.length; i += 2) rows.push(numbers.slice(i, i + 2));
  const cell = (n, k, row) => `<td width="${row.length === 1 ? 100 : 50}%" valign="top" style="padding:${k ? '0 0 0 12px' : '0 12px 0 0'};">
        <div style="font-family:${SANS};font-size:40px;font-weight:700;line-height:1.05;letter-spacing:-0.02em;color:${Y};white-space:nowrap;">${escapeHtml(n.value)}</div>
        <div style="margin-top:8px;font-family:${SANS};font-size:13px;font-weight:600;line-height:1.4;color:#C9CACC;word-break:normal;overflow-wrap:break-word;">${noWidow(escapeHtml(n.label))}</div>
      </td>`;
  return `<tr><td style="background:${CR};padding:${top}px 0 0;">
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background:${DD};"><tr>
      <td style="padding:38px 0 36px;${SIDE}" class="pd">
        ${label(kicker, Y, '#C9CACC')}
        ${rows.map((row, i) => `<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="table-layout:fixed;margin-top:${i ? 26 : 22}px;"><tr>${row.map((n, k) => cell(n, k, row)).join('')}</tr></table>`).join('')}
      </td>
    </tr></table>
  </td></tr>`;
}

// ── Event Recap ───────────────────────────────────────────────────────────

/** Where an event's recap lives for good: a gala's year page, never /events/gala/ (next year's tickets, one day) */
export function recapUrl(ev, events = [], site = SITE_URL) {
  return `${site}${yearPath(ev, events) || eventPath(ev, events)}`;
}

/** An event's name as a reader says it: the series' name, or the title without the year staff often type into it ("2027 Kids Fest") */
export const eventName = (ev) => tidy(displayName(ev)).replace(/^\d{4}\s+|\s+\d{4}$/g, '').trim();
/** The name with its year, once: "Evening of Sunshine 2026" */
export const eventTitle = (ev) => [eventName(ev), yearOf(ev)].filter(Boolean).join(' ');

/**
 * Everything an event's recap email shows, worked out as the recap page does:
 * its own photos, else its series' Gallery photos from its day until the next
 * event's (so a year's page keeps its own, whatever year is newest), and its
 * own sponsors, else the series' list while it's the newest.
 */
export function recapParts(ev, events = [], pageDoc = null) {
  const all = events.some((e) => e.slug === ev.slug) ? events.map((e) => (e.slug === ev.slug ? ev : e)) : [...events, ev];
  return { all, photos: recapPhotos(ev, all, pageDoc), sponsors: recapSponsors(ev, all, pageDoc), highlights: cleanHighlights(ev.highlights) };
}

/** The photos the email shows, once any that won't load are passed over: the lead, then five spread across the rest */
export function recapPicks(ev, events = [], pageDoc = null, broken = new Set()) {
  const parts = recapParts(ev, events, pageDoc);
  const photos = parts.photos.filter((p) => !broken.has(photoUrl(p.id, PHOTO_TRANSFORM)) && !broken.has(photoUrl(p.id, HERO_TRANSFORM)));
  return { ...parts, photos, lead: photos[0] || null, body: spread(photos.slice(1), 5) };
}

/**
 * The images a recap email would load, for the drafter's check: exactly the
 * photos it would show given what's already known broken (the drafter asks
 * again with each answer, so a broken photo's stand-in is checked too), and the
 * sponsor logos. One size per photo: a picture that won't load fails at all of them.
 */
export function recapImageUrls(ev, events = [], pageDoc = null, broken = new Set()) {
  const { lead, body, sponsors } = recapPicks(ev, events, pageDoc, broken);
  const mark = recapMark(ev, recapLook(ev), broken);
  return [...new Set([
    ...(mark ? [markUrl(mark)] : []),
    ...[lead, ...body].filter(Boolean).map((p) => photoUrl(p.id, PHOTO_TRANSFORM)),
    ...sponsors.flatMap((t) => t.names).filter((n) => n.logo).map((n) => cfImg(n.logo, LOGO_TRANSFORM)),
  ])];
}

/** A highlight's number sized to its column, so "$1,250,000" never runs into the next; long ones get a row each */
function highlightsBlock(highlights, look = SOARD_LOOK) {
  const longest = Math.max(...highlights.map((h) => h.value.length));
  const stack = longest > 10;
  const size = longest <= 4 ? 30 : longest <= 7 ? 28 : longest <= 10 ? 22 : 24;
  const rows = stack ? highlights.map((h) => [h]) : Array.from({ length: Math.ceil(highlights.length / 2) }, (_, r) => highlights.slice(r * 2, r * 2 + 2));
  const cell = (h, k, row) => `<td width="${row.length === 1 && stack ? 100 : 50}%" valign="top" style="padding:16px ${k || stack ? 0 : 12}px 16px ${k ? 12 : 0}px;border-top:1px solid ${look.line};border-bottom:1px solid ${look.line};">
        <div style="font-family:${SANS};font-size:${size}px;font-weight:700;line-height:1.15;color:${look.ink};${stack ? 'word-break:normal;overflow-wrap:break-word;' : 'white-space:nowrap;'}">${escapeHtml(tidy(h.value))}</div>
        <div style="margin-top:6px;font-family:${SANS};font-size:13px;font-weight:600;line-height:1.4;color:${look.muted};word-break:normal;overflow-wrap:break-word;">${noWidow(escapeHtml(tidy(h.label)))}</div>
      </td>`;
  return `<tr><td bgcolor="${look.paper}" style="background:${look.paper};padding:32px 0 0;${SIDE}" class="pd">
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="table-layout:fixed;">
      ${rows.map((row) => `<tr>${row.map((h, k) => cell(h, k, row)).join('')}${row.length === 1 && !stack ? '<td width="50%" style="font-size:0;">&nbsp;</td>' : ''}</tr>`).join('')}
    </table>
  </td></tr>`;
}

/**
 * "What a Night!": the photos from the event, its numbers, the sponsors who
 * made it possible and a way to keep the sunshine going.
 * @returns {{ subject: string, preview: string, html: string, text: string }}
 */
export function eventRecapEmail({ event = {}, events = [], pageDoc = null, site = SITE_URL, brokenLogos = new Set(), teamPicture = true, words = {} } = {}) {
  const ev = event;
  // Only photos that load, first one on top, as staff ordered them
  const { all, photos, lead, body, sponsors, highlights } = recapPicks(ev, events, pageDoc, brokenLogos);
  const series = seriesOf(ev);
  // Its recap page's look, the gala's theme for the year under the headline ("Havana Nights"), and its series' mark
  const look = recapLook(ev);
  const theme = series?.key === 'gala' ? tidy(recapThemeName(ev)) : '';
  const mark = recapMark(ev, look, brokenLogos);
  const name = eventName(ev) || 'our event';
  const year = yearOf(ev);
  const titled = eventTitle(ev) || name;
  const when = series?.key === 'gala' ? 'Night' : 'Day';
  const url = recapUrl(ev, all, site);
  const altOf = (p) => tidy(p?.alt || '');
  const { levels, moments } = splitSponsors(sponsors);
  const logos = levels.flatMap((t) => t.names).map((n) => (n.logo ? { name: n.name, url: cfImg(n.logo, 'public') } : { name: n.name, nameOnly: true }));
  const thanks = partnerCards({ partnerLogos: logos }, brokenLogos, { noun: 'sponsor', look });
  // The named moments of the night, one row per sponsor ("Cigar Rolling · Bidding Paddle" over Crosby Design Group)
  const byName = new Map();
  for (const t of moments) for (const n of t.names.filter((x) => x.name)) {
    const k = tidy(n.name);
    byName.set(k, [...(byName.get(k) || []), tidy(momentName(t.tier))]);
  }
  const named = [...byName].map(([name, list]) => ({ name, moment: [...new Set(list)].join(' · ') }));
  const sponsorCount = logos.length + named.length;

  const siteOpening = tidy(recapLead(ev, { photos: photos.length, sponsors: sponsorCount }));
  const siteAskWords = 'Families are on our waitlist right now. Your gift brings us closer to saying yes to the next child.';
  // The site's own words, and staff's in place of any of them (Edit words)
  const siteWords = {
    subject: `What a ${when}! See the Photos from ${series ? 'our ' : ''}${name}`,
    preview: sponsorCount ? `The photos from ${titled}, and a thank-you to the sponsors who made it possible.` : `The photos from ${titled}.`,
    opening: siteOpening, askHeadline: 'Help us build the next *dream*.', askWords: siteAskWords,
    closing: `Thank you for an unforgettable ${when.toLowerCase()}.`,
  };
  const w = chosenWords(words, siteWords);
  const { subject, preview } = w;
  const opening = w.opening ? plainWords(w.opening) : siteOpening;
  const fit = headlineFit(['What', 'a', `${when}!`], 54, { phones: [[40, 'dm'], [30, 'dms']] });

  const html = emailFrame(preview, `
  ${emailHeader(site, { look })}${mark ? `
  ${markRow(mark)}` : ''}
  ${cover({
    // "· 2026" never alone on a line
    kicker: [name, year].filter(Boolean).join('\u00A0· ').replace(/ ([^ ]+)$/, '\u00A0$1'),
    headline: `What a ${keyWord(when, look)}!`,
    sub: theme,
    size: fit.size,
    phone: fit.phone,
    lead: lead ? lead.id : '',
    alt: altOf(lead) || titled,
    url,
    // Centered on SOARD's dark cover, under the photo on the left as the page has it
    action: photos.length > 1 ? button(`See All ${photos.length} Photos`, url, { center: !look.page }) : '',
    look,
  })}
  ${w.opening ? lede(w.opening, '', look, { rich: true }) : lede(opening, '', look)}
  ${highlights.length ? highlightsBlock(highlights, look) : ''}
  ${body.length ? `<tr><td bgcolor="${look.paper}" style="background:${look.paper};padding:32px 0 0;${SIDE}" class="pd">
    ${body.length === 1 ? photoImg({ url: body[0].id, alt: altOf(body[0]) }, name, WIDE_TRANSFORM, 504) : ''}
    ${body.length >= 2 ? photoPair(body.slice(0, 2).map((p) => ({ url: p.id, alt: altOf(p) })), name, 0) : ''}
    ${body.length >= 3 ? photoImg({ url: body[2].id, alt: altOf(body[2]) }, name, WIDE_TRANSFORM, 504).replace('style="', 'style="margin-top:8px;') : ''}
    ${body.length >= 5 ? photoPair(body.slice(3, 5).map((p) => ({ url: p.id, alt: altOf(p) })), name) : ''}
    <div style="padding-top:16px;">
      ${photos.length > body.length + 1 ? textLink(`See all ${photos.length} photos →`, url, look.ink) : ''}
      ${ev.photographer ? `<p style="margin:${photos.length > body.length + 1 ? 10 : 0}px 0 0;font-family:${SANS};font-size:13px;color:${look.muted};">Photos by ${escapeHtml(tidy(ev.photographer))}</p>` : ''}
    </div>
  </td></tr>` : ''}
  ${thanks || ''}
  ${named.length ? section(logos.length ? 'And thank you to' : 'Thank you to', ruledRows(named.map((n) => ({ small: n.moment, main: n.name })), look), thanks ? 36 : 44, look) : ''}
  ${gap(40, look)}
  ${askBand({
    kicker: 'Keep the sunshine going',
    headline: w.askHeadline ? askHeadlineHtml(w.askHeadline) : 'Help us build the next&nbsp;<em style="font-style:italic;">dream</em>.',
    fit: w.askHeadline ? askHeadlineFit(w.askHeadline) : headlineFit(['Help', 'us', 'build', 'the', 'next dream.'], 30, { phones: [[26, 'h2b']] }),
    words: w.askWords || siteAskWords,
    action: 'Give Now →',
    url: `${site}/donate/`,
    look,
  })}
  ${signOff(w.closing, teamPicture, look)}
  ${emailFooter(site, { look })}`, look);

  const text = [
    `What a ${when.toLowerCase()}!`,
    '',
    opening,
    '',
    highlights.length ? highlights.map((h) => `${tidy(h.value)} ${tidy(h.label)}`).join(' · ') : null,
    photos.length ? `See the photos: ${url}` : null,
    ev.photographer ? `Photos by ${tidy(ev.photographer)}` : null,
    // Each sponsor once, though a level sponsor may also have named a moment of the night
    sponsorCount ? `Thank you to our sponsors: ${listJoin([...new Map([...logos.map((l) => tidy(l.name)), ...named.map((n) => n.name)].filter(Boolean).map((n) => [nameKey(n), n])).values()])}.` : null,
    '',
    `${w.askHeadline ? plainWords(w.askHeadline) : 'Help us build the next dream.'} ${w.askWords || siteAskWords}`,
    `Give: ${site}/donate/`,
    '',
    w.closing,
    'The SOARD Team, Sunshine on a Ranney Day',
  ].filter((l) => l !== null && l !== undefined).join('\n').replace(/\n{3,}/g, '\n\n').trim();

  return { subject, preview, html, text, siteWords };
}

// ── Monthly Impact ────────────────────────────────────────────────────────

/** "2026-10" → "October" (and the year when asked) */
export function monthName(month, { year = false } = {}) {
  const [y, m] = String(month).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 15)).toLocaleDateString('en-US', { month: 'long', ...(year ? { year: 'numeric' } : {}), timeZone: 'UTC' });
}
const shortDay = (date) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const longDay = (date) => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', timeZone: 'UTC' });
const clock = (time) => {
  const m = String(time || '').match(/^(\d{1,2}):(\d{2})/);
  if (!m || (m[1] === '00' && m[2] === '00')) return '';
  const h = Number(m[1]);
  return `${((h + 11) % 12) + 1}:${m[2]} ${h < 12 ? 'AM' : 'PM'}`;
};
const YOUTUBE = /(?:youtu\.be\/|youtube(?:-nocookie)?\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/))([a-zA-Z0-9_-]{11})/;
const playsVideo = (kid, broken) => {
  const stream = streamCheckUrl(kid);
  return (!!stream && !broken.has(stream)) || YOUTUBE.test(String(kid.videoUrl || ''));
};
/** A kid's first photo that will load, at the given size */
function kidLead(kid, broken, transform = HERO_TRANSFORM, not = '') {
  return [kid.heroImage, ...galleryPicks(kid).map((ph) => ph.url)].filter(Boolean).find((src) => src !== not && !broken.has(cfImg(src, transform)) && !broken.has(cfImg(src, HERO_TRANSFORM))) || '';
}
/** "The new accessible bathroom is finished, and the family has seen it": the Project Reveal's own line */
const finishedLine = (kid) => {
  const rooms = roomNames(kid);
  // Two kinds of room are two rooms, whatever the count says (some older pages say 1)
  const several = rooms.length > 1 || Number(kid.roomCount) > 1;
  const built = rooms.length ? listJoin(rooms).toLowerCase() : several ? 'dream rooms' : 'dream room';
  return `The new ${built} ${several ? 'are' : 'is'} finished, and the family has seen ${several ? 'them' : 'it'} for the first time.`;
};
const whatTitle = (kid) => {
  const rooms = roomNames(kid);
  const space = makeoverWord(rooms);
  return space ? space.title : rooms.length ? listJoin(rooms) : 'Dream Room';
};

/** Every image a monthly email could load, for the drafter's check */
export function monthlyImageUrls({ revealed = [], building = [], recaps = [] } = {}) {
  // Only what the email shows: each reveal's cover and card photos (and one reveal's pair), else the first room being built for the cover
  const leads = (kid) => [kid.heroImage, ...galleryPicks(kid).map((p) => p.url)].filter(Boolean).slice(0, 3);
  const kidUrls = [
    ...revealed.flatMap((r) => leads(r.kid).flatMap((u) => [cfImg(u, HERO_TRANSFORM), cfImg(u, WIDE_TRANSFORM)])),
    ...(revealed.length === 1 ? galleryPicks(revealed[0].kid).map((p) => cfImg(p.url, PHOTO_TRANSFORM)) : []),
    ...(!revealed.length && building[0] ? leads(building[0]).map((u) => cfImg(u, HERO_TRANSFORM)) : []),
  ];
  const streams = revealed.map((r) => streamCheckUrl(r.kid)).filter(Boolean);
  const events = recaps.flatMap((r) => (r.photo ? [cfImg(r.photo.id, WIDE_TRANSFORM)] : []));
  return [...new Set([...kidUrls, ...streams, ...events])];
}

/**
 * Is there anything for this month's email to say? A month with no reveal, no
 * project underway, nothing coming up, no event and no press has none.
 */
export const monthlyHasNews = ({ revealed = [], building = [], upcoming = [], events = [], recaps = [], press = [] } = {}) =>
  revealed.length + building.length + upcoming.length + events.length + recaps.length + press.length > 0;

/**
 * "Your Monthly Dose of Sunshine": the month's reveals, the rooms being built,
 * what's coming up, the event photos and the press, from the site's own data.
 *
 * @param {object} p
 * @param {string} p.month     'YYYY-MM', the month it covers
 * @param {string} p.today     'YYYY-MM-DD' (Atlanta): what's "coming up" is from this day on
 * @param {{kid: object, date: string}[]} p.revealed  the month's reveals, oldest first
 * @param {object[]} p.building  kids being built now, in the home page's order
 * @param {object[]} p.upcoming  reveals ahead: { name, slug, confirmed, date, time } or { name, slug, confirmed: false, window: { label, through } }
 * @param {object[]} p.events    events ahead: { title, date, url, tickets }
 * @param {object[]} p.recaps    events that ended in the month with photos: { name, year, url, photo, when }
 * @param {object[]} p.press     stories in the month: { outlet, title, url, date }
 * @param {{kids: number, rooms: number}} p.totals  since 2012
 */
export function monthlyImpactEmail({ month, today = '', revealed = [], building = [], upcoming = [], events = [], recaps = [], press = [], totals = null, site = SITE_URL, brokenLogos = new Set(), teamPicture = true, words = {} } = {}) {
  const mon = monthName(month);
  const monYear = monthName(month, { year: true });
  const kids = revealed.map((r) => ({ ...r, name: kidName(r.kid, 'our kid'), url: r.kid.slug ? `${site}/kids/${r.kid.slug}/` : `${site}/kids/` }));
  const ahead = upcoming.filter((u) => (u.confirmed === false ? String(u.window?.through || '') >= today : String(u.date || '') >= today));
  const eventsAhead = events.filter((e) => String(e.date || '') >= today);
  const one = kids.length === 1 ? kids[0] : null;

  // The headline: the month's reveal by name, how many when there were several, else the month itself
  const headText = one ? `${one.name}’s Big Reveal` : kids.length ? `${cap(countWord(kids.length))} Big Reveals` : `${mon} at SOARD`;
  const fit = one
    ? fitName({ name: one.name, after: '’s', runs: ['Big Reveal.'], max: 44, min: 28 })
    : headlineFit(kids.length ? [cap(countWord(kids.length)), 'Big', 'Reveals.'] : [mon, 'at', 'SOARD.'], 44);
  const headline = one ? `${fit.html} Big&nbsp;<em style="font-style:italic;color:${Y};">Reveal</em>.`
    : kids.length ? `${escapeHtml(cap(countWord(kids.length)))} Big&nbsp;<em style="font-style:italic;color:${Y};">Reveals</em>.`
      : `${escapeHtml(mon)} at&nbsp;<em style="font-style:italic;color:${Y};">SOARD</em>.`;

  // The cover: the month's first reveal, else the first room being built
  const coverKid = kids[0]?.kid || building[0] || null;
  const lead = coverKid ? kidLead(coverKid, brokenLogos) : '';
  const coverUrl = kids[0] ? kids[0].url : coverKid?.slug ? `${site}/kids/${coverKid.slug}/` : `${site}/kids/`;
  const oneVideo = one && playsVideo(one.kid, brokenLogos);
  // Never "Room" for a ramp: what the page has, by name
  const onePics = one ? kidPhotos(one.kid).length : 0;
  const coverAction = one ? button(oneVideo ? '▶\uFE0E  Watch the Reveal' : onePics > 1 ? 'See the Photos' : 'Read the Story', oneVideo ? `${one.url}#chapter-reveal` : onePics > 1 ? `${one.url}#chapter-gallery` : one.url, { center: true }) : '';

  // The opening: what the month held, in words that are always true
  const parts = [
    kids.length && plural(kids.length, 'reveal'),
    building.length && `${plural(building.length, 'makeover')} underway`,
    // "our Evening of Sunshine", as the recap's own subject says it
    recaps.length && `the photos from ${listJoin(recaps.map((r) => (r.series ? `our ${r.name}` : r.name)))}`,
    press.length && `${plural(press.length, 'story', 'stories')} in the news`,
  ].filter(Boolean);
  const siteOpening = parts.length
    ? `Here’s your monthly dose of sunshine from ${mon}: ${listJoin(parts)}.`
    : `Here’s your monthly dose of sunshine, and what’s coming up next.`;
  // "Plus what's coming up" only when there's a Coming up to see
  const anyAhead = ahead.length + eventsAhead.length > 0;
  const siteAskWords = 'Families are on our waitlist right now. Every dollar goes directly to materials, labor, and design. Zero platform fees.';
  // The site's own words, and staff's in place of any of them (Edit words)
  const siteWords = {
    subject: `Your Monthly Dose of Sunshine: ${headText}`,
    preview: parts.length ? `${cap(listJoin(parts))}.${anyAhead ? ' Plus what’s coming up.' : ''}` : anyAhead ? 'What’s coming up at SOARD.' : `${monYear} at SOARD.`,
    opening: siteOpening, askHeadline: 'Help us build the next *dream*.', askWords: siteAskWords, closing: 'Thank you for being part of the sunshine.',
  };
  const w = chosenWords(words, siteWords);
  const { subject, preview } = w;
  const opening = w.opening ? plainWords(w.opening) : siteOpening;

  // The month's reveals: one gets the photos under the cover; several get a card each
  const revealBlock = () => {
    if (!kids.length) return '';
    const cards = kids.map((k, i) => {
      const photo = kidLead(k.kid, brokenLogos, WIDE_TRANSFORM, i === 0 ? lead : '');
      const video = playsVideo(k.kid, brokenLogos);
      const what = whatTitle(k.kid);
      const pics = kidPhotos(k.kid).length;
      return `${i ? `<div style="height:28px;line-height:28px;font-size:0;">&nbsp;</div>` : ''}
        ${photo && (!one) ? `<a href="${href(k.url)}" target="_blank" style="display:block;text-decoration:none;">${photoImg({ url: photo, alt: k.kid.heroImageAlt || k.name }, k.name, WIDE_TRANSFORM, 504)}</a>
        <div style="height:16px;line-height:16px;font-size:0;">&nbsp;</div>` : ''}
        <div style="font-family:${SERIF};font-size:21px;font-weight:700;line-height:1.3;color:${D};">${noWidow(escapeHtml(`${k.name}’s ${what}`))}</div>
        <p style="margin:6px 0 0;font-family:${SANS};font-size:15px;line-height:1.6;color:${D};">${noWidow(escapeHtml(`Revealed ${longDay(k.date)}. ${finishedLine(k.kid)}`))}</p>
        <p style="margin:12px 0 0;font-family:${SANS};font-size:15px;line-height:1.5;">${textLink(video ? 'Watch the reveal →' : pics > 1 ? `See all ${Math.min(pics, 30)} photos →` : `Read ${k.name.length <= 16 ? `${k.name}’s` : 'the'} story →`, video ? `${k.url}#chapter-reveal` : pics > 1 ? `${k.url}#chapter-gallery` : k.url)}</p>`;
    }).join('');
    // One reveal: two more of its photos under the words
    const more = one ? galleryPicks(one.kid).filter((ph) => ph.url !== lead && !brokenLogos.has(cfImg(ph.url, PHOTO_TRANSFORM))) : [];
    const pair = more.length >= 2 ? [more[Math.floor(more.length / 3)], more[Math.floor((2 * more.length) / 3)]].filter((p, i, a) => a.indexOf(p) === i) : [];
    return section(`Revealed in ${mon}`, `${cards}${pair.length === 2 ? `<div style="height:20px;line-height:20px;font-size:0;">&nbsp;</div>${photoPair(pair, one.name, 0)}${one.kid.photographer ? `<p style="margin:12px 0 0;font-family:${SANS};font-size:13px;color:${TM};">Photos by ${escapeHtml(tidy(one.kid.photographer))}</p>` : ''}` : ''}`, 40);
  };

  const buildingRows = building.slice(0, 6).map((kid) => {
    const name = kidName(kid, 'A kid');
    const rooms = roomNames(kid);
    return { main: name, sub: rooms.length ? listJoin(rooms) : '', link: kid.slug ? { text: `Meet ${name.length <= 16 ? name : 'them'} →`, url: `${site}/kids/${kid.slug}/` } : null };
  });

  const comingRows = [
    ...ahead.map((u) => {
      const name = tidy(u.name || 'A kid');
      const dated = u.confirmed !== false && u.date;
      return {
        sort: dated ? u.date : String(u.window?.through || ''),
        small: dated ? [shortDay(u.date), clock(u.time)].filter(Boolean).join(' · ') : cap(String(u.window?.label || 'soon')),
        main: `${name}’s reveal`,
        link: u.slug ? (dated ? { text: 'Watch it live →', url: `${site}/live/${u.slug}/` } : { text: `Read ${name.length <= 16 ? `${name}’s` : 'the'} story →`, url: `${site}/kids/${u.slug}/` }) : null,
      };
    }),
    ...eventsAhead.map((e) => ({ sort: e.date, small: shortDay(e.date), main: tidy(e.title), link: e.url ? { text: e.tickets ? 'Get tickets →' : 'See the details →', url: e.tickets || e.url } : null })),
  ].sort((a, b) => a.sort.localeCompare(b.sort)).slice(0, 6);

  const recapBlock = recaps.length ? section(recaps.length > 1 ? 'From the events' : 'From the event', recaps.map((r, i) => `${i ? `<div style="height:24px;line-height:24px;font-size:0;">&nbsp;</div>` : ''}
    ${r.photo ? `<a href="${href(r.url)}" target="_blank" style="display:block;text-decoration:none;">${photoImg({ url: r.photo.id, alt: r.photo.alt || r.name }, r.name, WIDE_TRANSFORM, 504)}</a>
    <div style="height:16px;line-height:16px;font-size:0;">&nbsp;</div>` : ''}
    <div style="font-family:${SERIF};font-size:21px;font-weight:700;line-height:1.3;color:${D};">${noWidow(escapeHtml([r.name, r.year].filter(Boolean).join(' ')))}</div>
    <p style="margin:6px 0 0;font-family:${SANS};font-size:15px;line-height:1.6;color:${D};">${noWidow(escapeHtml(`What a ${r.when === 'night' ? 'night' : 'day'}! The photographer’s photos are up.`))}</p>
    <p style="margin:12px 0 0;font-family:${SANS};font-size:15px;line-height:1.5;">${textLink(r.count > 1 ? `See all ${r.count} photos →` : 'See the photos →', r.url)}</p>`).join('')) : '';

  const pressRows = press.slice(0, 5).map((p) => ({ small: tidy(p.outlet || 'In the news'), main: tidy(p.title), link: p.url ? { text: 'Read it →', url: p.url } : null }));

  const html = emailFrame(preview, `
  ${emailHeader(site)}
  ${cover({ kicker: `Monthly Dose of Sunshine\u00A0· ${monYear.replace(' ', '\u00A0')}`, headline, size: fit.size, phone: fit.phone, lead, alt: coverKid ? kidName(coverKid, '') : '', url: coverUrl, action: coverAction })}
  ${w.opening ? lede(w.opening, '', SOARD_LOOK, { rich: true }) : lede(opening)}
  ${revealBlock()}
  ${totals && (totals.kids || totals.rooms) ? numbersBand({ kicker: 'Since 2012', numbers: [
    totals.kids && { value: Number(totals.kids).toLocaleString('en-US'), label: 'kids served' },
    totals.rooms && { value: Number(totals.rooms).toLocaleString('en-US'), label: 'rooms built' },
  ].filter(Boolean) }) : ''}
  ${buildingRows.length ? section('Being built now', ruledRows(buildingRows)) : ''}
  ${comingRows.length ? section('Coming up', ruledRows(comingRows)) : ''}
  ${recapBlock}
  ${pressRows.length ? section('In the news', ruledRows(pressRows)) : ''}
  ${gap(40)}
  ${askBand({
    kicker: 'How you can help',
    headline: w.askHeadline ? askHeadlineHtml(w.askHeadline) : 'Help us build the next&nbsp;<em style="font-style:italic;">dream</em>.',
    fit: w.askHeadline ? askHeadlineFit(w.askHeadline) : headlineFit(['Help', 'us', 'build', 'the', 'next dream.'], 30, { phones: [[26, 'h2b']] }),
    words: w.askWords || siteAskWords,
    action: 'Give Now →',
    url: `${site}/donate/`,
  })}
  ${signOff(w.closing, teamPicture)}
  ${emailFooter(site)}`);

  const text = [
    `Your Monthly Dose of Sunshine: ${monYear}`,
    '',
    opening,
    '',
    ...kids.map((k) => `${k.name}’s ${whatTitle(k.kid)}, revealed ${longDay(k.date)}: ${k.url}`),
    kids.length ? '' : null,
    totals && (totals.kids || totals.rooms) ? `Since 2012: ${[totals.kids && `${Number(totals.kids).toLocaleString('en-US')} kids served`, totals.rooms && `${Number(totals.rooms).toLocaleString('en-US')} rooms built`].filter(Boolean).join(', ')}.` : null,
    buildingRows.length ? `Being built now: ${listJoin(buildingRows.map((r) => r.main))}.` : null,
    ...comingRows.map((r) => `Coming up, ${r.small}: ${r.main}${r.link ? ` (${r.link.url})` : ''}`),
    ...recaps.map((r) => `The photos from ${[r.name, r.year].filter(Boolean).join(' ')}: ${r.url}`),
    ...pressRows.map((r) => `${r.small}: ${r.main}${r.link ? ` (${r.link.url})` : ''}`),
    '',
    `${w.askHeadline ? plainWords(w.askHeadline) : 'Help us build the next dream.'} ${w.askWords || siteAskWords}`,
    `Give: ${site}/donate/`,
    '',
    w.closing,
    'The SOARD Team, Sunshine on a Ranney Day',
  ].filter((l) => l !== null && l !== false && l !== undefined).join('\n').replace(/\n{3,}/g, '\n\n').trim();

  return { subject, preview, html, text, siteWords };
}
