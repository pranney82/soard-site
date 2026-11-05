/**
 * The two emails about a kid's makeover: Project Kickoff ("Meet Axel", when the
 * work is about to start) and Project Reveal ("Axel's dream room is complete",
 * when the page has its photos and video). Filled in from the kid's page.
 * Neither says where the family lives, and neither shows the design plans:
 * these go to a mass list, and a plan is a floor plan of the family's home.
 *
 * They share the invite's colors, header, partners and sign-off, and have a
 * look of their own: a dark cover with the kid's name large, then the story in
 * pictures, and one yellow band that asks.
 *
 * Pure: no fetches, so tests and the admin preview render exactly what Kit gets.
 */

import {
  SITE_URL, PHOTO_TRANSFORM, HERO_TRANSFORM, BRAND, escapeHtml, href, curly, cfImg, galleryPicks, kidPhotos, stripHtml, label,
  emailFrame, emailHeader, emailFooter, signOff, partnerCards,
} from './_reveal-invite-email.js';

const { Y, D, DD, CR, BD, TM, SANS, SERIF } = BRAND;

const STORY_MAX = 320;
const roomsOf = (kid) => (Array.isArray(kid.roomTypes) ? kid.roomTypes.filter(Boolean) : []);
const yearOf = (kid) => kid.year || new Date().getFullYear();

// A picture that won't load fails at every size, so the invite's image checks answer for these crops too
const COVER_TRANSFORM = 'w=1200,h=880,fit=cover,gravity=face,q=85';
const WIDE_TRANSFORM = 'w=1200,h=720,fit=cover,gravity=auto,q=82';
const PAIR_TRANSFORM = 'w=600,h=640,fit=cover,gravity=auto,q=80';

const PHONE = `
    .dm{font-size:40px!important}
    .dms{font-size:30px!important}
    .h2b{font-size:26px!important}
    .ld{font-size:18px!important}`;

/** The short version of the story: the page's own summary, else the story's opening sentences */
function storyOf(kid) {
  if (kid.heroSummary) return curly(kid.heroSummary);
  const first = curly(stripHtml(kid.bio).split(/\n\n+/).find((s) => s.trim().length > 20) || '').replace(/\s+([.,!?])/g, '$1');
  if (first.length <= STORY_MAX) return first;
  const sentences = first.match(/[^.!?]+[.!?]+(\s|$)/g) || [first];
  let out = '';
  for (const s of sentences) {
    if (out && out.length + s.length > STORY_MAX) break;
    out += s;
  }
  return out.trim();
}

/** A quote as the page has it, without the quote marks it was typed with */
const bareQuote = (q) => curly(String(q || '').trim().replace(/^["“”']+|["“”']+$/g, ''));

/** The first photo that will load, for the top of the email */
function leadOf(kid, broken) {
  return [kid.heroImage, ...galleryPicks(kid).map((ph) => ph.url)].filter(Boolean).find((src) => !broken.has(cfImg(src, HERO_TRANSFORM))) || '';
}

/**
 * The photos left for the body of the email, spread across the gallery since
 * neighbors are often the same moment. A kid's gallery opens with the family, which
 * suits the kickoff; a finished gallery opens on the cover's moment, so `middle`
 * takes the middle of each stretch instead of its start.
 */
function bodyPhotos(kid, lead, broken, count, middle = false) {
  const usable = galleryPicks(kid).filter((ph) => ph.url !== lead && !broken.has(cfImg(ph.url, PHOTO_TRANSFORM)));
  if (usable.length <= count) return usable;
  return Array.from({ length: count }, (_, i) => usable[Math.floor(((i + (middle ? 0.5 : 0)) * usable.length) / count)]);
}

/** The first before and after that both load. Half a pair says nothing, so it's both or neither. */
function pairOf(kid, broken) {
  return (kid.beforeAfterPhotos || []).find((p) => p?.before && p?.after
    && !broken.has(cfImg(p.before, PAIR_TRANSFORM)) && !broken.has(cfImg(p.after, PAIR_TRANSFORM))) || null;
}

/** The before and after pictures the Project Reveal could load, for the image check */
export const beforeAfterUrls = (kid) => (kid?.beforeAfterPhotos || []).filter((p) => p?.before && p?.after)
  .flatMap((p) => [cfImg(p.before, PAIR_TRANSFORM), cfImg(p.after, PAIR_TRANSFORM)]);

const gap = (px) => `<tr><td bgcolor="${CR}" style="background:${CR};height:${px}px;line-height:${px}px;font-size:0;">&nbsp;</td></tr>`;

/** A button that keeps its shape in Outlook, which ignores padding on links */
function button(text, url, { fill = Y, ink = D, center = false } = {}) {
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0"${center ? ' align="center" style="margin:0 auto;"' : ''}><tr>
      <td align="center" bgcolor="${fill}" style="background:${fill};border-radius:100px;mso-padding-alt:17px 38px;"><a href="${href(url)}" target="_blank" style="display:inline-block;padding:17px 38px;font-family:${SANS};font-size:16px;font-weight:700;line-height:1.2;color:${ink};text-decoration:none;border-radius:100px;">${escapeHtml(text)}</a></td>
    </tr></table>`;
}

/** A plain link with its arrow, for the second thing a reader might do */
function textLink(text, url, color = D) {
  return `<a href="${href(url)}" target="_blank" style="font-family:${SANS};font-size:15px;font-weight:700;color:${color};text-decoration:underline;text-underline-offset:4px;">${escapeHtml(text)}</a>`;
}

/** The dark cover: the kicker, the name large, the lead photo, and a button when there's one thing to do first */
function cover({ kicker, headline, size, phone, lead, alt, url, action = '' }) {
  return `<tr><td bgcolor="${DD}" align="center" style="background:${DD};padding:14px 48px 44px;text-align:center;" class="pd">
    <p style="margin:0 0 14px;font-family:${SANS};font-size:12px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:${Y};">${escapeHtml(kicker)}</p>
    <h1 class="${phone}" style="margin:0 0 30px;font-family:${SERIF};font-size:${size}px;font-weight:700;line-height:1.14;letter-spacing:-0.01em;color:#FFFFFF;">${headline}</h1>
    ${lead ? `<a href="${href(url)}" target="_blank" style="display:block;text-decoration:none;"><img src="${escapeHtml(cfImg(lead, COVER_TRANSFORM))}" width="504" alt="${escapeHtml(alt)}" class="fl" style="width:100%;height:auto;display:block;border-radius:20px;" /></a>` : ''}
    ${action ? `<div style="height:28px;line-height:28px;font-size:0;">&nbsp;</div>${action}` : ''}
  </td></tr>`;
}

/** The first words after the cover, a size up from the rest */
function lede(text, after = '') {
  return `<tr><td bgcolor="${CR}" style="background:${CR};padding:40px 48px 0;" class="pd">
    <p class="ld" style="margin:0;font-family:${SERIF};font-size:19px;line-height:1.65;color:${D};">${escapeHtml(text)}</p>
    ${after}
  </td></tr>`;
}

/** Facts in a ruled row, in the sans font: Georgia's old-style numerals turn "11" into two small strokes */
function factsRow(facts) {
  return `<tr><td bgcolor="${CR}" style="background:${CR};padding:32px 48px 0;" class="pd">
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%"><tr>
      ${facts.map((f, i) => `<td valign="top" style="padding:16px ${i === facts.length - 1 ? 0 : 28}px 16px 0;border-top:1px solid ${BD};border-bottom:1px solid ${BD};${i === facts.length - 1 ? '' : 'width:1%;white-space:nowrap;'}">
        <div style="font-family:${SANS};font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:${TM};">${escapeHtml(f.label)}</div>
        <div style="margin-top:6px;font-family:${SANS};font-size:16px;font-weight:600;line-height:1.35;color:${D};">${escapeHtml(f.main)}</div>
      </td>`).join('')}
    </tr></table>
  </td></tr>`;
}

const photoImg = (ph, name, transform, width) => `<img src="${escapeHtml(cfImg(ph.url, transform))}" width="${width}" alt="${escapeHtml(ph.alt || name)}" class="fl" style="width:100%;height:auto;display:block;border-radius:14px;" />`;

/** Two photos, side by side at every screen size */
function photoPair(photos, name, top = 8) {
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin-top:${top}px;"><tr>
      <td width="49%" valign="top">${photoImg(photos[0], name, PHOTO_TRANSFORM, 247)}</td>
      <td width="2%" style="font-size:0;">&nbsp;</td>
      <td width="49%" valign="top">${photoImg(photos[1], name, PHOTO_TRANSFORM, 247)}</td>
    </tr></table>`;
}

/** The photos: one wide over two when there are three, two when there are two, the one when that's all */
function photoBlock(photos, name) {
  if (photos.length === 1) return photoImg(photos[0], name, WIDE_TRANSFORM, 504);
  if (photos.length === 2) return photoPair(photos, name, 0);
  return photos.length ? `${photoImg(photos[0], name, WIDE_TRANSFORM, 504)}${photoPair(photos.slice(1), name)}` : '';
}

/** The small line that thanks whoever took the pictures, and the way to the rest of them */
function photoNotes(kid, link = '') {
  const credit = kid.photographer ? `<p style="margin:${link ? 10 : 0}px 0 0;font-family:${SANS};font-size:13px;color:${TM};">Photos by ${escapeHtml(curly(kid.photographer))}</p>` : '';
  return link || credit ? `<div style="padding-top:16px;">${link}${credit}</div>` : '';
}

/** Before and after, each with its word underneath: nothing is drawn over the pictures */
function transformation(pair, name) {
  const side = (src, word, alt) => `<img src="${escapeHtml(cfImg(src, PAIR_TRANSFORM))}" width="247" alt="${escapeHtml(alt)}" class="fl" style="width:100%;height:auto;display:block;border-radius:14px;" />
        <div style="padding-top:10px;font-family:${SANS};font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:${TM};">${word}</div>`;
  return `<tr><td bgcolor="${CR}" style="background:${CR};padding:44px 48px 0;" class="pd">
    ${label('The transformation')}
    <div style="height:20px;line-height:20px;font-size:0;">&nbsp;</div>
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%"><tr>
      <td width="49%" valign="top">${side(pair.before, 'Before', pair.beforeAlt || `${name}’s room before`)}</td>
      <td width="2%" style="font-size:0;">&nbsp;</td>
      <td width="49%" valign="top">${side(pair.after, 'After', pair.afterAlt || `${name}’s room after`)}</td>
    </tr></table>
  </td></tr>`;
}

/** The rooms, each with its number in a yellow circle */
function roomList(rooms) {
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
      ${rooms.map((room, i) => {
    const rule = i ? `border-top:1px solid ${BD};` : '';
    return `<tr>
        <td width="46" valign="middle" style="width:46px;padding:14px 0;${rule}">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr><td align="center" valign="middle" width="30" height="30" bgcolor="${Y}" style="width:30px;height:30px;background:${Y};border-radius:50%;font-family:${SANS};font-size:14px;font-weight:700;line-height:30px;color:${D};text-align:center;">${i + 1}</td></tr></table>
        </td>
        <td valign="middle" style="padding:14px 0;${rule}font-family:${SERIF};font-size:18px;font-weight:700;line-height:1.3;color:${D};">${escapeHtml(room)}</td>
      </tr>`;
  }).join('')}
    </table>`;
}

/** The one yellow band: what we're asking, and the button */
function askBand({ kicker, headline, words, action, url }) {
  return `<tr><td bgcolor="${Y}" style="background:${Y};padding:44px 48px 48px;" class="pd">
    ${label(kicker, D)}
    <h2 class="h2b" style="margin:18px 0 12px;font-family:${SERIF};font-size:30px;font-weight:700;line-height:1.22;color:${D};">${headline}</h2>
    <p style="margin:0 0 26px;font-family:${SANS};font-size:16px;line-height:1.6;color:${D};">${escapeHtml(words)}</p>
    ${button(action, url, { fill: DD, ink: '#FFFFFF' })}
  </td></tr>`;
}

/**
 * "Meet Axel": the story, the rooms, and how to help, as the work is about to
 * start. The giving button goes to the kid's own fundraiser when there is one.
 */
export function projectKickoffEmail({ kid = {}, site = SITE_URL, brokenLogos = new Set(), teamPicture = true } = {}) {
  const name = curly(kid.name || 'our next kid');
  const slug = kid.slug || '';
  const kidUrl = slug ? `${site}/kids/${slug}/` : `${site}/kids/`;
  // Only a kid's own fundraiser can promise the gift goes to their room
  const own = !!kid.fundraisingUrl;
  const giveUrl = kid.fundraisingUrl || `${site}/donate/`;
  const rooms = roomsOf(kid);
  const story = storyOf(kid);
  const lead = leadOf(kid, brokenLogos);

  const subject = `Meet ${name}, Our Next Dream Room Project`;
  const preview = `Meet ${name}, our next dream room project. Here’s the story, and how you can help.`;
  const facts = [
    kid.age && { label: 'Age', main: String(kid.age) },
    kid.diagnosis && { label: 'Diagnosis', main: curly(kid.diagnosis) },
  ].filter(Boolean);

  const photos = bodyPhotos(kid, lead, brokenLogos, 2);

  const html = emailFrame(preview, `
  ${emailHeader(site)}
  ${cover({ kicker: `Our next project · ${yearOf(kid)}`, headline: `Meet <em style="font-style:italic;color:${Y};">${escapeHtml(name)}</em>.`, size: name.length > 14 ? 42 : 54, phone: name.length > 14 ? 'dms' : 'dm', lead, alt: name, url: kidUrl })}
  ${story ? lede(story, `<p style="margin:16px 0 0;">${textLink(`Read ${name}’s story →`, kidUrl)}</p>`) : ''}
  ${facts.length ? factsRow(facts) : ''}
  ${photos.length >= 2 ? `<tr><td bgcolor="${CR}" style="background:${CR};padding:32px 48px 0;" class="pd">${photoPair(photos, name, 0)}${photoNotes(kid)}</td></tr>` : ''}
  ${rooms.length ? `<tr><td bgcolor="${CR}" style="background:${CR};padding:44px 48px 0;" class="pd">
    ${label('The plan')}
    <h2 class="h2b" style="margin:16px 0 10px;font-family:${SERIF};font-size:26px;font-weight:700;line-height:1.25;color:${D};">What we’re building for&nbsp;${escapeHtml(name)}</h2>
    ${roomList(rooms)}
  </td></tr>` : ''}
  ${gap(40)}
  ${askBand({
    kicker: 'How you can help',
    headline: own ? `Help us build ${escapeHtml(name)}’s&nbsp;<em style="font-style:italic;">dream</em>.` : `Help us build <em style="font-style:italic;">dreams</em> like ${escapeHtml(name)}’s.`,
    words: own ? `Every dollar goes directly to materials, labor, and design for ${name}’s new space. Zero platform fees.` : 'Every dollar goes directly to materials, labor, and design for kids like these. Zero platform fees.',
    action: own ? `Give to ${name}’s Room →` : 'Give Now →',
    url: giveUrl,
  })}
  ${signOff('Thank you for being part of this.', teamPicture)}
  ${emailFooter(site)}`, PHONE);

  const text = [
    `Meet ${name}`,
    '',
    story,
    '',
    rooms.length ? `What we’re building: ${rooms.join(' + ')}` : null,
    '',
    own ? `Help us build ${name}’s dream. Every dollar goes directly to materials, labor, and design for ${name}’s new space. Zero platform fees.`
      : `Help us build dreams like ${name}’s. Every dollar goes directly to materials, labor, and design for kids like these. Zero platform fees.`,
    `Give: ${giveUrl}`,
    `${name}’s story: ${kidUrl}`,
    '',
    'Thank you for being part of this.',
    'The SOARD Team, Sunshine on a Ranney Day',
  ].filter((l) => l !== false && l !== null && l !== undefined).join('\n');

  return { subject, preview, html, text };
}

/**
 * "Axel's dream room is complete": the photos, the video and the partners who
 * made it possible, then what comes next for the families still waiting.
 */
export function projectRevealEmail({ kid = {}, site = SITE_URL, brokenLogos = new Set(), teamPicture = true } = {}) {
  const name = curly(kid.name || 'our kid');
  const slug = kid.slug || '';
  const kidUrl = slug ? `${site}/kids/${slug}/` : `${site}/kids/`;
  const rooms = roomsOf(kid);
  const several = (Number(kid.roomCount) || rooms.length || 1) > 1;
  const finished = `${name}’s Dream ${several ? 'Rooms Are' : 'Room Is'} Complete`;
  // The page's summary was often written while the room was still to come
  // ("SOARD is building..."), so this opening is one that's always true
  const built = rooms.length ? rooms.join(' and ').toLowerCase() : 'dream room';
  const story = `The wait is over. ${name}’s new ${built} ${several ? 'are' : 'is'} finished, and the family has seen ${several ? 'them' : 'it'} for the first time.`;
  const lead = leadOf(kid, brokenLogos);
  const said = bareQuote(kid.quote);
  const onPage = curly(`${stripHtml(kid.bio)} ${kid.heroSummary || ''}`);
  const quote = said && !onPage.includes(said.slice(0, 40)) ? said : '';

  const subject = finished;
  const preview = `See ${name}’s transformation: the photos, the video, and the partners who made it possible.`;

  const pair = pairOf(kid, brokenLogos);
  // With a before and after, one wide photo says enough; galleries also hold close-ups of floors and tile
  const photos = bodyPhotos(kid, lead, brokenLogos, 3, true).slice(0, pair ? 1 : 3);
  const allPhotos = kidPhotos(kid).length;
  const firstLine = `${name}’s Dream ${several ? 'Rooms' : 'Room'}`;
  const size = firstLine.length <= 20 ? 42 : firstLine.length <= 25 ? 36 : 30;

  const html = emailFrame(preview, `
  ${emailHeader(site)}
  ${cover({
    kicker: `Project complete · ${yearOf(kid)}`,
    headline: `${escapeHtml(name)}’s Dream&nbsp;${several ? 'Rooms' : 'Room'}<br>${several ? 'Are' : 'Is'}&nbsp;<em style="font-style:italic;color:${Y};">Complete</em>.`,
    size,
    phone: 'dms',
    lead,
    alt: `${name} in the finished ${several ? 'rooms' : 'room'}`,
    url: `${kidUrl}#chapter-reveal`,
    action: button('▶\uFE0E  Watch the Reveal', `${kidUrl}#chapter-reveal`, { center: true }),
  })}
  ${lede(story)}
  ${pair ? transformation(pair, name) : ''}
  ${photos.length ? `<tr><td bgcolor="${CR}" style="background:${CR};padding:${pair ? 28 : 36}px 48px 0;" class="pd">
    ${photoBlock(photos, name)}
    ${photoNotes(kid, allPhotos > photos.length + 1 ? textLink(`See all ${allPhotos} photos →`, `${kidUrl}#chapter-gallery`) : '')}
  </td></tr>` : ''}
  ${quote ? `<tr><td bgcolor="${CR}" style="background:${CR};padding:40px 48px 0;" class="pd">
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%"><tr>
      <td width="4" bgcolor="${Y}" style="width:4px;background:${Y};border-radius:2px;font-size:0;">&nbsp;</td>
      <td style="padding:4px 0 4px 22px;font-family:${SERIF};font-size:20px;font-style:italic;line-height:1.55;color:${D};">“${escapeHtml(quote)}”</td>
    </tr></table>
  </td></tr>` : ''}
  ${partnerCards(kid, brokenLogos) || gap(40)}
  ${askBand({
    kicker: 'What’s next',
    headline: 'Another family is&nbsp;<em style="font-style:italic;">waiting</em>.',
    words: 'Families are on our waitlist right now. Your gift brings us closer to saying yes to the next child.',
    action: 'Give Now →',
    url: `${site}/donate/`,
  })}
  ${signOff('Thank you for making this possible.', teamPicture)}
  ${emailFooter(site)}`, PHONE);

  const text = [
    finished,
    '',
    story,
    '',
    `Watch the reveal: ${kidUrl}#chapter-reveal`,
    `See the photos: ${kidUrl}#chapter-gallery`,
    '',
    rooms.length ? `What we built: ${rooms.join(' + ')}` : null,
    '',
    'Another family is waiting. Families are on our waitlist right now. Your gift brings us closer to saying yes to the next child.',
    `Give: ${site}/donate/`,
    '',
    'Thank you for making this possible.',
    'The SOARD Team, Sunshine on a Ranney Day',
  ].filter((l) => l !== false && l !== null && l !== undefined).join('\n');

  return { subject, preview, html, text };
}
