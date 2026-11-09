/**
 * The two emails about a kid's makeover: Project Kickoff ("Meet Axel", when the
 * work is about to start) and Project Reveal ("Axel's dream room is complete",
 * when the page has its photos and video). Filled in from the kid's page.
 * Neither says where the family lives, and neither shows the design plans:
 * these go to a mass list, and a plan is a floor plan of the family's home.
 *
 * They share the invite's look: a dark cover with the kid's name large, then
 * the story in pictures, and here one yellow band that asks.
 *
 * Pure: no fetches, so tests and the admin preview render exactly what Kit gets.
 */

import {
  SITE_URL, HERO_TRANSFORM, PHOTO_TRANSFORM, SIDE, BRAND, escapeHtml, href, curly, cfImg, galleryPicks, kidPhotos, stripHtml, label,
  emailFrame, emailHeader, emailFooter, signOff, partnerCards, button, textLink, cover, lede, bodyPhotos, photoImg, photoPair, photoNotes,
  listJoin, headlineFit, nameRuns, nameHtml, roomNames, roomCounts, noWidow, fitName, notARoom, tidy,
} from './_reveal-invite-email.js';

const { Y, D, DD, CR, BD, TM, SANS, SERIF } = BRAND;

const STORY_MAX = 320;
const roomsOf = (kid) => roomNames(kid);
const yearOf = (kid) => kid.year || new Date().getFullYear();

/** Two kids' ages as a person writes them: [10, 11] or "10,11" → "10 & 11" */
const agesOf = (age) => (Array.isArray(age) ? age : String(age).split(/\s*(?:,|&|\band\b)\s*/)).map((a) => String(a).trim()).filter(Boolean);

/** The kid page's YouTube test (youTubeId in src/utils/reveals.ts): a link that isn't YouTube gets no Reveal section */
const YOUTUBE = /(?:youtu\.be\/|youtube(?:-nocookie)?\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/))([a-zA-Z0-9_-]{11})/;
/** A video the page will play: a Stream upload, or a link that parses as YouTube */
const hasVideo = (kid) => /^[a-f0-9]{32}$/i.test(String(kid.streamVideoId || '').trim()) || YOUTUBE.test(String(kid.videoUrl || ''));

/** How many photos a kid's page shows in its gallery */
const PAGE_PHOTOS = 30;

/** The give button names the kid when that fits one line on the smallest phone ("Give to Max’s Room →"), else it's "Give Now →": the headline above it already names them */
const GIVE_MAX = 20;

const WIDE_TRANSFORM = 'w=1200,h=720,fit=cover,gravity=auto,q=82';
const PAIR_TRANSFORM = 'w=600,h=640,fit=cover,gravity=auto,q=80';

/** The short version of the story: the page's own summary, else the story's opening sentences */
function storyOf(kid) {
  if (kid.heroSummary) return tidy(kid.heroSummary).trim();
  const first = tidy(stripHtml(kid.bio).split(/\n\n+/).find((s) => s.trim().length > 20) || '').replace(/\s+([.,!?])/g, '$1');
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
const bareQuote = (q) => tidy(String(q || '').trim().replace(/^["“”']+|["“”']+$/g, ''));
/** A quote typed with who said it ("…for," said Elvia.) already has its marks: it's shown as typed */
const saidQuote = (q) => /["“”]/.test(String(q || '').trim().replace(/^["“”']+|["“”']+$/g, ''));

/** The first photo that will load, for the top of the email */
function leadOf(kid, broken) {
  return [kid.heroImage, ...galleryPicks(kid).map((ph) => ph.url)].filter(Boolean).find((src) => !broken.has(cfImg(src, HERO_TRANSFORM))) || '';
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

/**
 * Facts in a ruled row, in the sans font: Georgia's old-style numerals turn "11" into two small strokes.
 * Side by side while they'd fit a phone; a long diagnosis beside several ages goes on a row of its own,
 * so no word is ever squeezed in two.
 */
function factsRow(facts) {
  const longest = (t) => Math.max(...String(t).split(/\s+/).map((w) => w.length));
  const stack = facts.length > 1 && facts[0].main.length + longest(facts[facts.length - 1].main) > 22;
  const cell = (f, i, last) => `<td valign="top" style="padding:16px ${last || stack ? 0 : 28}px 16px 0;border-top:1px solid ${BD};${stack && !last ? '' : `border-bottom:1px solid ${BD};`}${last || stack ? '' : 'width:1%;white-space:nowrap;'}">
        <div style="font-family:${SANS};font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:${TM};">${escapeHtml(f.label)}</div>
        <div style="margin-top:6px;font-family:${SANS};font-size:16px;font-weight:600;line-height:1.35;color:${D};word-break:normal;overflow-wrap:break-word;">${escapeHtml(f.main)}</div>
      </td>`;
  const rows = stack ? facts.map((f, i) => `<tr>${cell(f, i, i === facts.length - 1)}</tr>`).join('')
    : `<tr>${facts.map((f, i) => cell(f, i, i === facts.length - 1)).join('')}</tr>`;
  return `<tr><td bgcolor="${CR}" style="background:${CR};padding:32px 0 0;${SIDE}" class="pd">
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">${rows}</table>
  </td></tr>`;
}

/** The photos: one wide over two when there are three, two when there are two, the one when that's all */
function photoBlock(photos, name) {
  if (photos.length === 1) return photoImg(photos[0], name, WIDE_TRANSFORM, 504);
  if (photos.length === 2) return photoPair(photos, name, 0);
  return photos.length ? `${photoImg(photos[0], name, WIDE_TRANSFORM, 504)}${photoPair(photos.slice(1), name)}` : '';
}

/** Before and after, each with its word underneath: nothing is drawn over the pictures */
function transformation(pair, name) {
  const side = (src, word, alt) => `<img src="${escapeHtml(cfImg(src, PAIR_TRANSFORM))}" width="247" alt="${escapeHtml(alt)}" class="fl" style="width:100%;height:auto;display:block;border-radius:14px;" />
        <div style="padding-top:10px;font-family:${SANS};font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:${TM};">${word}</div>`;
  return `<tr><td bgcolor="${CR}" style="background:${CR};padding:44px 0 0;${SIDE}" class="pd">
    ${label('The transformation')}
    <div style="height:20px;line-height:20px;font-size:0;">&nbsp;</div>
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%"><tr>
      <td width="49%" valign="top">${side(pair.before, 'Before', pair.beforeAlt || `${name}’s room before`)}</td>
      <td width="2%" style="font-size:0;">&nbsp;</td>
      <td width="49%" valign="top">${side(pair.after, 'After', pair.afterAlt || `${name}’s room after`)}</td>
    </tr></table>
  </td></tr>`;
}

/** The rooms, each with how many of it in a yellow circle ("2 Dream Bedrooms"), so the number reads as a count */
function roomList(counts) {
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
      ${counts.map(({ name: room, count }, i) => {
    const rule = i ? `border-top:1px solid ${BD};` : '';
    return `<tr>
        <td width="46" valign="middle" style="width:46px;padding:14px 0;${rule}">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr><td align="center" valign="middle" width="30" height="30" bgcolor="${Y}" style="width:30px;height:30px;background:${Y};border-radius:50%;font-family:${SANS};font-size:14px;font-weight:700;line-height:30px;color:${D};text-align:center;">${count}</td></tr></table>
        </td>
        <td valign="middle" style="padding:14px 0;${rule}font-family:${SERIF};font-size:18px;font-weight:700;line-height:1.3;color:${D};">${escapeHtml(room)}</td>
      </tr>`;
  }).join('')}
    </table>`;
}

/** The one yellow band: what we're asking, and the button. fit: the headline's size, from headlineFit. */
function askBand({ kicker, headline, words, action, url, fit = { size: 30, phone: 'h2b' } }) {
  return `<tr><td bgcolor="${Y}" style="background:${Y};padding:44px 0 48px;${SIDE}" class="pd">
    ${label(kicker, D)}
    <h2 class="${fit.phone}" style="margin:18px 0 12px;font-family:${SERIF};font-size:${fit.size}px;font-weight:700;line-height:1.22;color:${D};">${headline}</h2>
    <p style="margin:0 0 26px;font-family:${SANS};font-size:16px;line-height:1.6;color:${D};">${noWidow(escapeHtml(words))}</p>
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

  const space = notARoom(rooms);
  const subject = `Meet ${name}, Our Next ${space ? 'Project' : 'Dream Room Project'}`;
  // Its own line in the inbox, not the subject again
  const preview = rooms.length ? `${name}’s story, what we’re building, and how you can help.` : `${name}’s story and how you can help.`;
  const ages = kid.age ? agesOf(kid.age) : [];
  const agesText = ages.length > 2 ? `${ages.slice(0, -1).join(', ')} & ${ages[ages.length - 1]}` : ages.join(' & ');
  const facts = [
    ages.length && { label: ages.length > 1 ? 'Ages' : 'Age', main: agesText },
    kid.diagnosis && { label: 'Diagnosis', main: tidy(kid.diagnosis) },
  ].filter(Boolean);

  const photos = bodyPhotos(kid, lead, brokenLogos, 2);
  const fit = fitName({ name, after: '.', runs: ['Meet'], max: 54, min: 36, wrap: (h) => `<em style="font-style:italic;color:${Y};">${h}</em>` });
  const giveLabel = `Give to ${name}’s Room →`;
  const action = own && !space && giveLabel.length <= GIVE_MAX ? giveLabel : 'Give Now →';
  // The plan's heading is the kid's room: "Dylan’s dream room", "Tyrece & Maddie’s dream rooms", "Ava’s wheelchair ramp"
  const several = rooms.length > 1 || Number(kid.roomCount) > 1;
  const planWhat = space ? space.lower : several ? 'dream rooms' : 'dream room';
  const planWords = planWhat.split(' ');
  const planRuns = planWords.length > 1 ? [...planWords.slice(0, -2), planWords.slice(-2).join(' ')] : planWords;
  // One line when "Dylan’s dream room" fits at 22px or more, so the name never sits alone above it
  const planWhole = fitName({ name, after: `’s ${planWhat}`, afterHtml: `’s ${escapeHtml(planWhat).replace(/ /g, '&nbsp;')}`, max: 26, min: 22, phones: [[26, 'h2b']] });
  const planFit = planWhole.whole && planWhole.size >= 22 ? planWhole : fitName({ name, after: '’s', runs: planRuns, max: 26, min: 22, phones: [[26, 'h2b']] });
  const planHtml = planFit === planWhole ? planWhole.html : `${planFit.html} ${noWidow(escapeHtml(planWhat))}`;
  // The ask names the kid while it can at 26px or larger ("Help us build Remi / & Nico’s dream."); a long single name can't, so it's "this dream"
  const askPhones = [[26, 'h2b']];
  // Without the kid's own fundraiser the gift goes to the next family too: "Help us build more dreams."
  // ("dreams like Josué’s." can't stay one phrase on a phone, and the name would sit alone)
  const askName = fitName({ name, after: '’s dream.', afterHtml: '’s&nbsp;<em style="font-style:italic;">dream</em>.', runs: ['Help', 'us', 'build'], max: 30, min: 26, phones: askPhones });
  const named = own && askName.size >= 26;
  const askHeadline = own
    ? (named ? `Help us build ${askName.html}` : 'Help us build this&nbsp;<em style="font-style:italic;">dream</em>.')
    : (named ? `Help us build <em style="font-style:italic;">dreams</em> like ${askName.html}` : 'Help us build more&nbsp;<em style="font-style:italic;">dreams</em>.');
  const askFit = named ? askName : headlineFit(['Help', 'us', 'build', own ? 'this dream.' : 'more dreams.'], 30, { phones: askPhones });
  const askWords = own ? (named ? `Help us build ${name}’s dream.` : 'Help us build this dream.') : (named ? `Help us build dreams like ${name}’s.` : 'Help us build more dreams.');

  const html = emailFrame(preview, `
  ${emailHeader(site)}
  ${cover({ kicker: `Our next project · ${yearOf(kid)}`, headline: `Meet ${fit.html}`, size: fit.size, phone: fit.phone, lead, alt: name, url: kidUrl })}
  ${story ? lede(story, `<p style="margin:16px 0 0;">${textLink(`Read ${name}’s story →`, kidUrl)}</p>`) : ''}
  ${facts.length ? factsRow(facts) : ''}
  ${photos.length >= 2 ? `<tr><td bgcolor="${CR}" style="background:${CR};padding:32px 0 0;${SIDE}" class="pd">${photoPair(photos, name, 0)}${photoNotes(kid)}</td></tr>` : ''}
  ${rooms.length ? `<tr><td bgcolor="${CR}" style="background:${CR};padding:44px 0 0;${SIDE}" class="pd">
    ${label('The plan')}
    <h2 class="${planFit.phone}" style="margin:16px 0 10px;font-family:${SERIF};font-size:${planFit.size}px;font-weight:700;line-height:1.25;color:${D};">${planHtml}</h2>
    ${roomList(roomCounts(kid))}
  </td></tr>` : ''}
  ${gap(40)}
  ${askBand({
    kicker: 'How you can help',
    headline: askHeadline,
    fit: askFit,
    words: own ? `Every dollar goes directly to materials, labor, and design for ${name}’s new space. Zero platform fees.` : `Every dollar goes directly to materials, labor, and design for kids like ${name}. Zero platform fees.`,
    action,
    url: giveUrl,
  })}
  ${signOff('Thank you for being part of this.', teamPicture)}
  ${emailFooter(site)}`);

  const text = [
    `Meet ${name}`,
    '',
    story,
    '',
    rooms.length ? `What we’re building: ${listJoin(rooms)}` : null,
    '',
    `${askWords} ${own ? `Every dollar goes directly to materials, labor, and design for ${name}’s new space.` : `Every dollar goes directly to materials, labor, and design for kids like ${name}.`} Zero platform fees.`,
    `Give: ${giveUrl}`,
    `${name}’s story: ${kidUrl}`,
    '',
    'Thank you for being part of this.',
    'The SOARD Team, Sunshine on a Ranney Day',
  ].filter((l) => l !== false && l !== null && l !== undefined).join('\n').replace(/\n{3,}/g, '\n\n').trim();

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
  // A ramp or a lift is named as itself, never a "Dream Room"
  const space = notARoom(rooms);
  // Rooms and a ramp together are neither "Dream Rooms" nor a ramp: the kid's makeover
  const mixed = !space && rooms.some((r) => notARoom([r]));
  const what = space ? space.title : mixed ? 'Makeover' : `Dream ${several ? 'Rooms' : 'Room'}`;
  const are = several && !mixed;
  const finished = `${name}’s ${what} ${are ? 'Are' : 'Is'} Complete`;
  // The page's summary was often written while the room was still to come
  // ("SOARD is building..."), so this opening is one that's always true.
  // Two rooms of one kind (a bedroom each) read as "bedrooms".
  const built = rooms.length ? listJoin(rooms).toLowerCase() : several ? 'dream rooms' : 'dream room';
  const story = `The wait is over. ${name}’s new ${built} ${several ? 'are' : 'is'} finished, and the family has seen ${several ? 'them' : 'it'} for the first time.`;
  // No video on the page: no button promising one (the page only has a Reveal section when there is)
  const video = hasVideo(kid);
  const lead = leadOf(kid, brokenLogos);
  const said = bareQuote(kid.quote);
  const onPage = curly(`${stripHtml(kid.bio)} ${kid.heroSummary || ''}`);
  const quote = said && !onPage.includes(said.slice(0, 40)) ? said : '';

  const subject = finished;
  // The preview names only what the email shows
  const partners = partnerCards(kid, brokenLogos);
  const shown = [(lead || galleryPicks(kid).some((ph) => !brokenLogos.has(cfImg(ph.url, PHOTO_TRANSFORM)))) && 'the photos', video && 'the video', partners && 'the partners who made it possible'].filter(Boolean);
  const preview = shown.length ? `See ${name}’s transformation: ${listJoin(shown)}.` : `See ${name}’s transformation.`;

  const pair = pairOf(kid, brokenLogos);
  // With a before and after, one wide photo says enough; galleries also hold close-ups of floors and tile
  const photos = bodyPhotos(kid, lead, brokenLogos, 3, true).slice(0, pair ? 1 : 3);
  // The kid page shows its first 30 photos (src/pages/kids/[slug].astro), so the email never promises more
  const allPhotos = Math.min(kidPhotos(kid).length, PAGE_PHOTOS);
  const whatWords = what.split(' ');
  const fit = fitName({ name, after: '’s', runs: [...whatWords.slice(0, -2), whatWords.slice(-2).join(' '), `${are ? 'Are' : 'Is'} Complete.`], max: 40, min: 28 });
  // The page has a Gallery section once it has two photos
  const coverUrl = video ? `${kidUrl}#chapter-reveal` : allPhotos > 1 ? `${kidUrl}#chapter-gallery` : kidUrl;
  const watch = video ? null : allPhotos > 1 ? 'See the Photos' : 'Read the Story';

  const html = emailFrame(preview, `
  ${emailHeader(site)}
  ${cover({
    kicker: `Project complete · ${yearOf(kid)}`,
    headline: `${fit.html} ${noWidow(escapeHtml(what))}<br>${are ? 'Are' : 'Is'}&nbsp;<em style="font-style:italic;color:${Y};">Complete</em>.`,
    size: fit.size,
    phone: fit.phone,
    lead,
    alt: `${name} in the finished ${space ? space.lower : several ? 'rooms' : 'room'}`,
    url: coverUrl,
    action: watch ? button(watch, coverUrl, { center: true }) : button('▶\uFE0E  Watch the Reveal', `${kidUrl}#chapter-reveal`, { center: true }),
  })}
  ${lede(story)}
  ${pair ? transformation(pair, name) : ''}
  ${photos.length ? `<tr><td bgcolor="${CR}" style="background:${CR};padding:${pair ? 28 : 36}px 0 0;${SIDE}" class="pd">
    ${photoBlock(photos, name)}
    ${photoNotes(kid, allPhotos > photos.length + 1 ? textLink(`See all ${allPhotos} photos →`, `${kidUrl}#chapter-gallery`) : '')}
  </td></tr>` : ''}
  ${quote ? `<tr><td bgcolor="${CR}" style="background:${CR};padding:40px 0 0;${SIDE}" class="pd">
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%"><tr>
      <td width="4" bgcolor="${Y}" style="width:4px;background:${Y};border-radius:2px;font-size:0;">&nbsp;</td>
      <td style="padding:4px 0 4px 22px;font-family:${SERIF};font-size:20px;font-style:italic;line-height:1.55;color:${D};">${saidQuote(kid.quote) ? noWidow(escapeHtml(tidy(String(kid.quote).trim()))) : `“${noWidow(escapeHtml(quote))}”`}</td>
    </tr></table>
  </td></tr>` : ''}
  ${partners || gap(40)}
  ${askBand({
    kicker: 'What’s next',
    headline: 'Another family is&nbsp;<em style="font-style:italic;">waiting</em>.',
    words: 'Families are on our waitlist right now. Your gift brings us closer to saying yes to the next child.',
    action: 'Give Now →',
    url: `${site}/donate/`,
  })}
  ${signOff('Thank you for making this possible.', teamPicture)}
  ${emailFooter(site)}`);

  const text = [
    finished,
    '',
    story,
    '',
    video ? `Watch the reveal: ${kidUrl}#chapter-reveal` : null,
    allPhotos > 1 ? `See the photos: ${kidUrl}#chapter-gallery` : `${name}’s story: ${kidUrl}`,
    '',
    rooms.length ? `What we built: ${listJoin(rooms)}` : null,
    '',
    'Another family is waiting. Families are on our waitlist right now. Your gift brings us closer to saying yes to the next child.',
    `Give: ${site}/donate/`,
    '',
    'Thank you for making this possible.',
    'The SOARD Team, Sunshine on a Ranney Day',
  ].filter((l) => l !== false && l !== null && l !== undefined).join('\n').replace(/\n{3,}/g, '\n\n').trim();

  return { subject, preview, html, text };
}
