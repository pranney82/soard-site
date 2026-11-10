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
  listJoin, headlineFit, nameRuns, nameHtml, roomNames, roomCounts, noWidow, fitName, makeoverWord, shortStory, tidy, kidName, shownPartners, leadPhoto,
} from './_reveal-invite-email.js';

const { Y, D, DD, CR, BD, TM, SANS, SERIF } = BRAND;

const STORY_MAX = 320;
const roomsOf = (kid) => roomNames(kid);
const yearOf = (kid) => kid.year || new Date().getFullYear();

/** Two kids' ages as a person writes them: [10, 11] or "10,11" → "10 & 11" */
const agesOf = (age) => (Array.isArray(age) ? age : String(age).split(/\s*(?:,|&|\band\b)\s*/)).map((a) => String(a).trim()).filter(Boolean);

/** The kid page's YouTube test (youTubeId in src/utils/reveals.ts): a link that isn't YouTube gets no Reveal section */
const YOUTUBE = /(?:youtu\.be\/|youtube(?:-nocookie)?\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/))([a-zA-Z0-9_-]{11})/;
/** Where the kid page checks a Stream upload plays (runStreamCheck in src/utils/reveals.ts): a 4xx means it won't */
const STREAM_HOST = 'customer-cuav5h47lgfe96ql.cloudflarestream.com';
export const streamCheckUrl = (kid) => {
  const id = String(kid?.streamVideoId || '').trim().toLowerCase();
  return /^[a-f0-9]{32}$/.test(id) ? `https://${STREAM_HOST}/${id}/manifest/video.m3u8` : null;
};
/** A video the page will play: a Stream upload the drafter's check didn't find gone, or a link that parses as YouTube */
const hasVideo = (kid, broken = new Set()) => {
  const stream = streamCheckUrl(kid);
  return (!!stream && !broken.has(stream)) || YOUTUBE.test(String(kid.videoUrl || ''));
};

/** How many photos a kid's page shows in its gallery */
const PAGE_PHOTOS = 30;

/** The give button names the kid when that fits one line on the smallest phone ("Give to Max’s Room →"), else it's "Give Now →": the headline above it already names them */
const GIVE_MAX = 20;

/** A name at the end of a sentence: "Marcus Jr." already has its period */
const ending = (name) => (/\.$/.test(name) ? name : `${name}.`);

const WIDE_TRANSFORM = 'w=1200,h=720,fit=cover,gravity=auto,q=82';
const PAIR_TRANSFORM = 'w=600,h=640,fit=cover,gravity=auto,q=80';

/** The short version of the story, the same as the invite's */
const storyOf = (kid) => shortStory(kid, STORY_MAX);

/** A quote as the page has it, without the quote marks it was typed with */
/** A quote without the marks around the whole of it (only a pair that opens and closes it: "He said "wow"" keeps its own) */
const bareQuote = (q) => {
  const t = String(q || '').trim();
  return tidy(/^["“'‘][\s\S]*["”'’]$/.test(t) && t.length > 2 ? t.slice(1, -1).trim() : t);
};
/**
 * A quote as HTML, curly and matched whatever shape it was typed in:
 *   "It’s perfect." — Mom        → “It’s perfect.” with "– Mom" on its own line under it
 *   "…for" - Jade, his mother     → the same, a typed hyphen read as the dash
 *   "…door," Vicki said.         → “…door,” Vicki said.
 *   She said, "This is home now." → She said, “This is home now.”
 *   'We love it,' said Mom.      → “We love it,” said Mom.
 *   We cried happy tears.        → “We cried happy tears.”
 * A quote inside a whole quote takes single marks. Nothing ends on one word alone.
 */
function quoteHtml(q) {
  const raw = String(q || '').trim();
  const part = (t) => escapeHtml(tidy(t));
  // Who said it, signed with a dash: a line of its own in the sans, so "– Jade, / Dewone’s mother" never splits off the quote's last line
  const byline = (who) => `<span style="display:block;margin-top:10px;font-family:${SANS};font-size:14px;font-style:normal;font-weight:600;line-height:1.45;color:${TM};">–&nbsp;${noWidow(part(who.trim())).replace(/ and /g, ' and&nbsp;')}</span>`;
  const dash = /^\s*[-–—]+\s*/;
  const plain = (t) => !/["“”]/.test(t);
  // Who said it sits before the quote ("She said, ") or after it ("— Mom", "Vicki said."), and is short;
  // marks in the middle of longer words are a quote inside the quote
  const dbl = raw.match(/^([\s\S]*?)["“]([^"“”]+)["”]([\s\S]*)$/);
  const lead = dbl ? dbl[1].trim() : '', tail = dbl ? dbl[3].trim() : '';
  if (dbl && !lead && dash.test(tail) && plain(tail) && tail.replace(dash, '').length <= 90) return `“${noWidow(part(dbl[2].trim()))}”${byline(tail.replace(dash, ''))}`;
  // (a lead or tail with marks of its own means the marks matched inside the quote: "He said "wow" and cried.")
  const said = dbl && plain(lead) && plain(tail) && ((!lead && tail && tail.length <= 40) || (!tail.replace(/[.!?]/g, '') && lead && lead.length <= 40 && /[,:]$/.test(lead)));
  if (said) return `${part(dbl[1])}“${tail ? part(dbl[2]) : noWidow(part(dbl[2]))}”${noWidow(part(dbl[3]))}`;
  const sgl = raw.match(/^['‘](.+?)([,.!?])['’]\s+([\s\S]+)$/);
  if (sgl) return `“${part(sgl[1] + sgl[2])}” ${noWidow(part(sgl[3]))}`;
  // No marks, signed at the end: "We love it. - Mom", "… - Monique and Darnell, Jaylen’s parents" (a name, never a sentence)
  const signed = !dbl && raw.match(/^([\s\S]+?)\s+[-–—]+\s*([A-Z][^-–—"“”]{0,89})$/);
  const signer = signed ? signed[2].trim() : '';
  if (signed && signer.split(/\s+/).length <= 12 && (!/[.!?]$/.test(signer) || signer.split(/\s+/).length <= 2)) return `“${noWidow(escapeHtml(bareQuote(signed[1]).replace(/“/g, '‘').replace(/”/g, '’')))}”${byline(signed[2])}`;
  const inner = bareQuote(raw).replace(/“/g, '‘').replace(/”/g, '’');
  return `“${noWidow(escapeHtml(inner))}”`;
}

/** The first photo that will load, for the top of the email */
function leadOf(kid, broken) {
  return leadPhoto(kid, broken);
}

/** The first before and after that both load. Half a pair says nothing, so it's both or neither. */
function pairOf(kid, broken) {
  return (kid.beforeAfterPhotos || []).find((p) => p?.before && p?.after
    && !broken.has(cfImg(p.before, PAIR_TRANSFORM)) && !broken.has(cfImg(p.after, PAIR_TRANSFORM))) || null;
}

/** The before and after pictures the Project Reveal could load, for the image check */
/** Everything beyond the usual images a Project Reveal draft checks first: its before and after, and its Stream video */
export const revealChecks = (kid) => [...beforeAfterUrls(kid), streamCheckUrl(kid)].filter(Boolean);

export const beforeAfterUrls = (kid) => (kid?.beforeAfterPhotos || []).filter((p) => p?.before && p?.after)
  .flatMap((p) => [cfImg(p.before, PAIR_TRANSFORM), cfImg(p.after, PAIR_TRANSFORM)]);

const gap = (px) => `<tr><td bgcolor="${CR}" style="background:${CR};height:${px}px;line-height:${px}px;font-size:0;">&nbsp;</td></tr>`;

/**
 * Facts in a ruled row, in the sans font: Georgia's old-style numerals turn "11" into two small strokes.
 * Side by side while they'd fit a phone; a long diagnosis beside several ages goes on a row of its own,
 * so no word is ever squeezed in two.
 */
function factsRow(facts) {
  // "Autism &" or "Bowel and" never ends a line: "&" and "and" go with the word after them, "Non-Verbal" never
  // splits at its hyphen, and the last two words stay together ("Multiple / Sulfatase Deficiency", never
  // "Multiple Sulfatase / Deficiency") while they fit a phone's full width
  // A hyphen inside a word doesn't break ("Non‑Verbal", "Rubinstein‑Taybi": a no-break hyphen)
  const glue = (t) => String(t).replace(/(\w)-(?=\w)/g, '$1\u2011').replace(/ (&|and) /g, ' $1\u00A0')
    .replace(/ ([^ ]+) ([^ ]+)$/, (m, x, y) => (!/\u00A0/.test(x + y) && `${x} ${y}`.length <= 20 ? ` ${x}\u00A0${y}` : m));
  const longest = (t) => Math.max(...glue(t).split(' ').map((w) => w.length));
  // Side by side only while the value's longest unbreakable run fits beside the first fact on a phone
  const stack = facts.length > 1 && facts[0].main.length + longest(facts[facts.length - 1].main) > 18;
  const cell = (f, i, last) => `<td valign="top" style="padding:16px ${last || stack ? 0 : 28}px 16px 0;border-top:1px solid ${BD};${stack && !last ? '' : `border-bottom:1px solid ${BD};`}${last || stack ? '' : 'width:1%;white-space:nowrap;'}">
        <div style="font-family:${SANS};font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:${TM};">${escapeHtml(f.label)}</div>
        <div style="margin-top:6px;font-family:${SANS};font-size:16px;font-weight:600;line-height:1.35;color:${D};word-break:normal;overflow-wrap:break-word;">${escapeHtml(glue(f.main)).replace(/\u00A0/g, '&nbsp;')}</div>
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

/**
 * A room's words with the last two kept together while they fit a phone line ("Three / Dream Bedrooms"); a pair
 * too long for that whose first word is hyphenated breaks after the hyphen ("Wheelchair- / Accessible Bathroom")
 */
const roomWords = (words) => escapeHtml(words).replace(/ ([^ ]+) ([^ ]+)$/, (m, x, y) => {
  if (`${x} ${y}`.length <= 20) return ` ${x}&nbsp;${y}`;
  const after = x.split('-').pop();
  return x.includes('-') && `${after} ${y}`.length <= 20 ? ` ${x}&nbsp;${y}` : m;
}).replace(/^([^ ]+-)([^ -]+) ([^ ]+)$/, (m, head, x, y) => (`${x} ${y}`.length <= 20 ? `${head}${x}&nbsp;${y}` : m));

const COUNT_WORDS = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten'];

/**
 * The rooms, each by a small yellow mark. How many is said in words ("Two Dream Bedrooms"): a number in a
 * circle read as the list's own numbering ("1 Accessible Bathroom, 2 Dream Bedrooms").
 */
function roomList(counts) {
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
      ${counts.map(({ name: room, count }, i) => {
    const rule = i ? `border-top:1px solid ${BD};` : '';
    const words = count > 1 ? `${COUNT_WORDS[count] || count} ${room}` : room;
    return `<tr>
        <td width="24" valign="top" style="width:24px;padding:21px 0 14px;${rule}"><div style="width:10px;height:10px;background:${Y};border-radius:3px;font-size:0;line-height:0;">&nbsp;</div></td>
        <td valign="top" style="padding:14px 0;${rule}font-family:${SERIF};font-size:18px;font-weight:700;line-height:1.3;color:${D};">${roomWords(words)}</td>
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
  const name = kidName(kid, 'our next kid');
  const slug = kid.slug || '';
  const kidUrl = slug ? `${site}/kids/${slug}/` : `${site}/kids/`;
  // Only a kid's own fundraiser can promise the gift goes to their room
  const own = !!kid.fundraisingUrl;
  const giveUrl = kid.fundraisingUrl || `${site}/donate/`;
  const rooms = roomsOf(kid);
  const story = storyOf(kid);
  const lead = leadOf(kid, brokenLogos);

  const space = makeoverWord(rooms);
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
  // Two kids' names stay whole ("Meet / Remi & Nico.") while they fit at 30px, as the invite's do
  const fit = fitName({ name, after: '.', runs: ['Meet'], max: 54, min: 30, wrap: (h) => `<em style="font-style:italic;color:${Y};">${h}</em>` });
  const giveLabel = `Give to ${name}’s Room →`;
  const action = own && !space && giveLabel.length <= GIVE_MAX ? giveLabel : 'Give Now →';
  // The ask names the kid while it can at 26px or larger ("Help us build Remi / & Nico’s dream."); a long single name can't, so it's "this dream"
  const askPhones = [[26, 'h2b']];
  // Without the kid's own fundraiser the gift goes to the next family too: "Help us build more dreams."
  // ("dreams like Josué’s." can't stay one phrase on a phone, and the name would sit alone)
  const askName = fitName({ name, after: '’s dream.', afterHtml: '’s&nbsp;<em style="font-style:italic;">dream</em>.', runs: ['Help', 'us', 'build'], max: 30, min: 26, phones: askPhones });
  // Only a name that stays whole: "Help us build / Remi / & Nico’s dream." leaves "Remi" alone
  const named = own && askName.whole && askName.size >= 26;
  const askHeadline = own
    ? (named ? `Help us build ${askName.html}` : 'Help us build this&nbsp;<em style="font-style:italic;">dream</em>.')
    : (named ? `Help us build <em style="font-style:italic;">dreams</em> like ${askName.html}` : 'Help us build more&nbsp;<em style="font-style:italic;">dreams</em>.');
  const askFit = named ? askName : headlineFit(['Help', 'us', 'build', own ? 'this dream.' : 'more dreams.'], 30, { phones: askPhones });
  const askWords = own ? (named ? `Help us build ${name}’s dream.` : 'Help us build this dream.') : (named ? `Help us build dreams like ${name}’s.` : 'Help us build more dreams.');

  const html = emailFrame(preview, `
  ${emailHeader(site, { mark: true })}
  ${cover({ kicker: `Our next project · ${yearOf(kid)}`, headline: `Meet ${fit.html}`, size: fit.size, phone: fit.phone, lead, alt: name, url: kidUrl })}
  ${story ? lede(story, `<p style="margin:16px 0 0;">${textLink(`Read ${name}’s story →`, kidUrl)}</p>`) : `<tr><td bgcolor="${CR}" style="background:${CR};padding:36px 0 0;${SIDE}" class="pd">${textLink(`Read ${name}’s story →`, kidUrl)}</td></tr>`}
  ${facts.length ? factsRow(facts) : ''}
  ${photos.length >= 2 ? `<tr><td bgcolor="${CR}" style="background:${CR};padding:32px 0 0;${SIDE}" class="pd">${photoPair(photos, name, 0)}${photoNotes(kid)}</td></tr>` : ''}
  ${rooms.length ? `<tr><td bgcolor="${CR}" style="background:${CR};padding:44px 0 0;${SIDE}" class="pd">
    ${label('What we’re building')}
    <div style="height:6px;line-height:6px;font-size:0;">&nbsp;</div>
    ${roomList(roomCounts(kid))}
  </td></tr>` : ''}
  ${gap(rooms.length ? 26 : 40)}
  ${askBand({
    kicker: 'How you can help',
    headline: askHeadline,
    fit: askFit,
    words: own ? `Every dollar goes directly to materials, labor, and design for ${name}’s new space. Zero platform fees.` : `Every dollar goes directly to materials, labor, and design for kids like ${ending(name)} Zero platform fees.`,
    action,
    url: giveUrl,
  })}
  ${signOff('Thank you for being part of this.', teamPicture)}
  ${emailFooter(site, { mark: true })}`);

  const text = [
    `Meet ${name}`,
    '',
    story,
    '',
    rooms.length ? `What we’re building: ${listJoin(rooms)}` : null,
    '',
    `${askWords} ${own ? `Every dollar goes directly to materials, labor, and design for ${name}’s new space.` : `Every dollar goes directly to materials, labor, and design for kids like ${ending(name)}`} Zero platform fees.`,
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
  const name = kidName(kid, 'our kid');
  const slug = kid.slug || '';
  const kidUrl = slug ? `${site}/kids/${slug}/` : `${site}/kids/`;
  const rooms = roomsOf(kid);
  const several = (Number(kid.roomCount) || rooms.length || 1) > 1;
  // A ramp or a lift is named as itself, never a "Dream Room"
  // A ramp or a lift by name; rooms and a ramp together are the kid's "Makeover"
  const space = makeoverWord(rooms);
  const mixed = !!space?.mixed;
  const what = space ? space.title : `Dream ${several ? 'Rooms' : 'Room'}`;
  // In the headline a ramp or lift goes by its last word ("Ava’s Ramp", "Ramp and Lift"), so it stays one phrase on a phone
  const shortWhat = space && !mixed ? listJoin(rooms.map((r) => r.split(/\s+/).pop())) : what;
  const are = several && !mixed;
  const finished = `${name}’s ${what} ${are ? 'Are' : 'Is'} Complete`;
  // The page's summary was often written while the room was still to come
  // ("SOARD is building..."), so this opening is one that's always true.
  // Two rooms of one kind (a bedroom each) read as "bedrooms".
  const built = rooms.length ? listJoin(rooms).toLowerCase() : several ? 'dream rooms' : 'dream room';
  const story = `The wait is over. ${name}’s new ${built} ${several ? 'are' : 'is'} finished, and the family has seen ${several ? 'them' : 'it'} for the first time.`;
  // No video on the page: no button promising one (the page only has a Reveal section when there is)
  const video = hasVideo(kid, brokenLogos);
  const lead = leadOf(kid, brokenLogos);
  const said = bareQuote(kid.quote);
  const onPage = curly(`${stripHtml(kid.bio)} ${kid.heroSummary || ''}`);
  const quote = said && !onPage.includes(said.slice(0, 40)) ? said : '';

  const subject = finished;
  // The preview names only what the email shows
  const partners = partnerCards(kid, brokenLogos);
  const partnerWords = shownPartners(kid, brokenLogos).length === 1 ? 'the partner who made it possible' : 'the partners who made it possible';
  const loads = [lead, ...galleryPicks(kid).filter((ph) => !brokenLogos.has(cfImg(ph.url, PHOTO_TRANSFORM))).map((ph) => ph.url)].filter(Boolean);
  const pictures = new Set(loads).size;
  const shown = [pictures && (pictures > 1 ? 'the photos' : 'the photo'), video && 'the video'].filter(Boolean);
  const preview = shown.length
    ? `See ${name}’s transformation: ${listJoin([...shown, partners && partnerWords].filter(Boolean))}.`
    : `See ${name}’s transformation${partners ? ` and ${partnerWords}` : ''}.`;

  const pair = pairOf(kid, brokenLogos);
  // With a before and after, one wide photo says enough; galleries also hold close-ups of floors and tile
  const photos = bodyPhotos(kid, lead, brokenLogos, 3, true).slice(0, pair ? 1 : 3);
  // The kid page shows its first 30 photos (src/pages/kids/[slug].astro), so the email never promises more;
  // when none of the gallery loads, there are none to promise
  const galleryLoads = galleryPicks(kid).some((ph) => !brokenLogos.has(cfImg(ph.url, PHOTO_TRANSFORM)));
  const allPhotos = galleryLoads ? Math.min(kidPhotos(kid).length, PAGE_PHOTOS) : 0;
  const isComplete = `${are ? 'Are' : 'Is'} Complete.`;
  // One word ("Ramp", "Makeover") stays on the name's line, never alone on its own: "Marcus Jr.’s Ramp / Is Complete."
  // A short phrase stays whole ("Noah’s / Ramp and Lift / Are Complete."); a long one breaks only at "and"
  const solo = !/\s/.test(shortWhat);
  const whatPieces = solo ? [] : shortWhat.length <= 16 ? [shortWhat] : shortWhat.split(/ and /);
  const fit = solo
    ? fitName({ name, after: `’s ${shortWhat}`, afterHtml: `’s&nbsp;${escapeHtml(shortWhat)}`, runs: [isComplete], max: 40, min: 28 })
    : fitName({ name, after: '’s', runs: [...whatPieces, isComplete], max: 40, min: 28 });
  const whatHtml = whatPieces.map((w) => escapeHtml(w).replace(/ /g, '&nbsp;')).join(' and ');
  // The page has a Gallery section once it has two photos
  const coverUrl = video ? `${kidUrl}#chapter-reveal` : allPhotos > 1 ? `${kidUrl}#chapter-gallery` : kidUrl;
  const watch = video ? null : allPhotos > 1 ? 'See the Photos' : 'Read the Story';

  const html = emailFrame(preview, `
  ${emailHeader(site, { mark: true })}
  ${cover({
    kicker: `Project complete · ${yearOf(kid)}`,
    headline: `${fit.html}${whatHtml ? ` ${whatHtml}` : ''}<br>${are ? 'Are' : 'Is'}&nbsp;<em style="font-style:italic;color:${Y};">Complete</em>.`,
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
      <td style="padding:4px 0 4px 22px;font-family:${SERIF};font-size:20px;font-style:italic;line-height:1.55;color:${D};">${quoteHtml(kid.quote)}</td>
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
  ${emailFooter(site, { mark: true })}`);

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
