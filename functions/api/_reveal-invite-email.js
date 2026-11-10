/**
 * The reveal invite email, filled in from what the site already knows: the
 * kid's page (name, photo, story, rooms, photos, partner logos) and JobTread
 * (the confirmed day and time, the family's address, the "Reveal Invite
 * Details" notes). The same design as the invite sent for Remi & Nico on
 * Sep 21, 2026 and the "SOARD Reveal Invite" template in Kit.
 *
 * It goes into Kit as a draft on Kit's classic "Text only" template, which
 * adds Kit's own footer (unsubscribe link and mailing address), so this body
 * carries no unsubscribe link of its own.
 *
 * Pure: no fetches, so tests and the admin preview render exactly what Kit gets.
 */

export const SITE_URL = 'https://sunshineonaranneyday.com';

/**
 * The emails' design. Change it whenever these builders change what an email looks like or says:
 * every draft still waiting in Kit that nobody has edited is then rebuilt on the next look, by itself.
 * tests/email-design.test.mjs fails if the emails change and this doesn't.
 */
export const EMAIL_DESIGN = '2026-11-09d';
const CF = 'https://imagedelivery.net/ROYFuPmfN2vPS6mt5sCkZQ';

const Y = '#FFDA24';
const D = '#373A36';
const DD = '#1E1F25';
const CR = '#FEFCF5';
const WG = '#F5F4F0';
const TM = '#5A5B61';
const TL = '#6D6E74';
const BD = '#E5E4E0';
const SERIF = "'Libre Baskerville',Georgia,'Times New Roman',serif";
const SANS = "'Outfit',-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
export const LOGO = `${CF}/brand-logo-dark-bg-tagline-display/w=400,q=85`;
/** The same logo with the empty margins its 600px file carries trimmed to an even 6px, so the space around it is what the email sets */
export const LOGO_MARK = `${CF}/brand-logo-dark-bg-tagline-display/trim=92;94;123;96,w=400,q=85`;
/** Side padding in step with the width, so a phone that drops the style block still fits; Outlook takes the alt */
export const SIDE = 'padding-left:8%;padding-right:8%;mso-padding-left-alt:48px;mso-padding-right-alt:48px;';
/** The team as plushies, in the signature (Cloudflare Images) */
export const TEAM_PICTURE = `${CF}/emails/soard-team-plushie/w=1008,q=85`;

// trim: many logo files are mostly white space, and would sit tiny in their cards
// 2:1, not wider: a square logo (Real Floors, Sherwin-Williams) fills more of its card, and a wide one is no smaller
export const LOGO_TRANSFORM = 'trim=border,w=360,h=180,fit=pad,background=white,q=88';
export const HERO_TRANSFORM = 'w=1200,h=760,fit=cover,gravity=face,q=85';
// A picture that won't load fails at every size, so the checks at HERO_TRANSFORM answer for this crop too
export const COVER_TRANSFORM = 'w=1200,h=880,fit=cover,gravity=face,q=85';
export const PHOTO_TRANSFORM = 'w=500,h=500,fit=cover,gravity=face,q=75';
/**
 * A partner's name as a reader should see it. A logo's "name" is often the uploaded file's:
 * "OkelleysLOGO" reads as "Okelleys", and a generated one ("ChatGPT Image May 5, 2026, 04_42_19 PM",
 * "Screenshot 2026-08-31 at 15.46.42", "IMG_123.png") is no name at all, so ''.
 */
export function partnerLabel(name) {
  const s = String(name || '').trim().replace(/\.(png|jpe?g|gif|webp|svg|pdf)$/i, '').replace(/_+/g, ' ').trim();
  if (!s) return '';
  if (/^(screen ?shot|chatgpt image|dall.?e)\b|^(image|img|dsc|pxl|photo|untitled)[\s-]*[\d(]|^(untitled|logo|file|download|image)$/i.test(s)) return '';
  if (/\b\d{1,2}[ .:]\d{2}[ .:]\d{2}\b|\b\d{4}-\d{2}-\d{2}\b|^\d+$/.test(s)) return '';
  // A camera or design tool's name: a long number ("27576835 1529…"), an ID ("F38FA186-88E1-…"), a print color space ("MAW Georgia CMYK C 76633")
  if (/\d{5,}|\b[0-9a-f]{8}-[0-9a-f]{4}\b|\b(cmyk|rgb|pms)\b/i.test(s)) return '';
  return s.replace(/[\s-]*logo$/i, '').trim();
}
/** A partner name a person would write, not an uploaded file's */
export const realPartnerName = (name) => !!partnerLabel(name);

/** "Dream Bedroom" → "Dream Bedrooms" */
export const pluralRoom = (room) => (/s$/i.test(room) ? room : `${room}s`);

/**
 * The kid's rooms as a reader should see them, each in the plural when the page counts more than
 * one of it (Tyrece & Maddie: "Accessible Bathroom", "Dream Bedrooms"). A single type with a
 * room count over one is plural too (Remi & Nico: two dream bedrooms). No types: the fallback.
 */
export function roomNames(kid = {}, fallback = '') {
  return roomCounts(kid, fallback).map((r) => r.name);
}

/** Each room with how many of it the page counts: [{ name: "Dream Bedrooms", count: 2 }, { name: "Accessible Bathroom", count: 1 }] */
export function roomCounts(kid = {}, fallback = '') {
  const types = Array.isArray(kid.roomTypes) ? kid.roomTypes.filter(Boolean) : [];
  if (!types.length) return [String(fallback || '').trim()].filter(Boolean).map((name) => ({ name, count: 1 }));
  const total = Number(kid.roomCount) || 0;
  return types.map((t) => {
    const own = /bath/i.test(t) ? Number(kid.bathroomCount) : /bed/i.test(t) ? Number(kid.bedroomCount) : /therapy/i.test(t) ? Number(kid.therapyRoomCount) : 0;
    const count = own > 1 ? own : types.length === 1 && total > 1 ? total : 1;
    return { name: count > 1 ? pluralRoom(t) : t, count };
  });
}

/** "a", "a and b", "a, b, and c" */
export const listJoin = (items) => {
  const a = (items || []).filter(Boolean);
  return a.length <= 2 ? a.join(' and ') : `${a.slice(0, -1).join(', ')}, and ${a[a.length - 1]}`;
};

/** How wide a run of the bold serif is, in ems (measured on Georgia Bold, rounded up) */
const serifEm = (s) => [...String(s)].reduce((w, c) => w + (/[MW]/.test(c) ? 1 : /[mw]/.test(c) ? 0.9 : /[A-Z&]/.test(c) ? 0.75 : /[a-z0-9]/.test(c) ? 0.6 : /\s/.test(c) ? 0.27 : 0.3), 0);

/**
 * A cover headline can't break inside a word, and Gmail drops the phone rules, so the one inline
 * size has to fit a small phone: the longest run that can't break (a name, or words joined by
 * &nbsp;) fits in 225px: Gmail's phone app leaves about 236px inside the cover on a 360 screen, and the
 * estimate runs a little light on capitals and m's. The phone rule may only shrink it.
 * @param {string[]} runs  the headline's unbreakable pieces, as they read ("Christopher’s", "Reveal Day.")
 * @returns {{ size: number, phone: string }}
 */
export function headlineFit(runs, max, { phones = [[40, 'dm'], [30, 'dms']] } = {}) {
  const widest = Math.max(1, ...runs.map(serifEm));
  const size = Math.max(16, Math.min(max, Math.floor(225 / widest)));
  return { size, phone: (phones.find(([px]) => size > px) || [0, ''])[1] };
}

/** Escaped text whose last two words stay together, so a paragraph never ends on one word alone ("…platform / fees."), and "&" stays with the name after it */
export const noWidow = (escaped) => String(escaped).replace(/\s+$/, '').replace(/ &amp; /g, ' &amp;&nbsp;')
  // A hyphenated last word ("cul-de-sac.") never breaks at its own hyphen either
  .replace(/ ([^\s<>]{1,14})$/, (m, w) => (/-/.test(w) ? `&nbsp;<span style="white-space:nowrap;">${w}</span>` : `&nbsp;${w}`));

/** A name for a headline: a hyphenated name ("Anastasia-Rose") never splits at its hyphen */
export const nameHtml = (name) => escapeHtml(name).replace(/(\S*-\S*)/g, '<span style="white-space:nowrap;">$1</span>');

/**
 * A kid's name in a headline, sized with the rest of it. The name stays whole ("Remi & Nico’s") while
 * that still fits a phone line at `min` or larger; a longer one ("Amanda, Caleb & Isaac") may break
 * between names, but never right after "&" or inside a hyphenated name, and what follows it ("’s", ".")
 * always stays on its last word.
 * @param {object} p
 * @param {string} p.after      plain text after the name, for sizing ("’s", ".")
 * @param {string} [p.afterHtml] the same as HTML, when it differs
 * @param {string[]} [p.runs]   the headline's other unbreakable runs
 * @param {(h: string) => string} [p.wrap]  styles each piece of the name (an <em>)
 * @returns {{ size: number, phone: string, html: string, whole: boolean }}
 */
export function fitName({ name, after = '', afterHtml, runs = [], max, min = max, phones, wrap = (h) => h }) {
  // "Marcus Jr." + "." reads "Marcus Jr.", never "Jr.."
  const dot = /\.$/.test(String(name).trim()) && /^\./.test(after);
  const afterText = dot ? after.slice(1) : after;
  let tail = afterHtml === undefined ? escapeHtml(afterText) : afterHtml;
  if (dot && afterHtml !== undefined) tail = tail.replace(/^\./, '');
  const opts = phones ? { phones } : undefined;
  const nowrap = (h) => `<span style="white-space:nowrap;">${h}</span>`;
  const whole = headlineFit([...runs, `${name}${afterText}`], max, opts);
  // Pieces that may sit on their own line: "&" goes with the name after it, "Jr." with the one before
  const pieces = [];
  for (const w of String(name).trim().split(/\s+/)) {
    const last = pieces[pieces.length - 1];
    if (last !== undefined && (/^(&|and)$/i.test(last) || /^(jr|sr)\.?$|^(ii|iii|iv)$/i.test(w))) pieces[pieces.length - 1] += ` ${w}`;
    else pieces.push(w);
  }
  if (whole.size >= min || pieces.length < 2 && !/-/.test(name)) return { ...whole, whole: true, html: nowrap(`${wrap(escapeHtml(name))}${tail}`) };
  // A hyphenated name only breaks after its hyphen ("Christopher- / Alexander’s") when keeping it whole
  // would set the headline under 28px, close to the 24px lines around it
  const sizeOf = (ps) => headlineFit([...runs, ...ps.map((p, i) => (i === ps.length - 1 ? `${p.text}${afterText}` : p.text))], max, opts);
  let parts = pieces.map((text) => ({ text, join: ' ' }));
  if (sizeOf(parts).size < Math.min(min, 28)) {
    parts = pieces.flatMap((text) => text.split(/(?<=-)/).map((t, i, a) => ({ text: t, join: i ? '&#8203;' : ' ' })));
  }
  const fit = sizeOf(parts);
  return { ...fit, whole: parts.length === 1, html: parts.map((p, i) => `${i ? p.join : ''}${nowrap(`${wrap(escapeHtml(p.text).replace(/ /g, '&nbsp;'))}${i === parts.length - 1 ? tail : ''}`)}`).join('') };
}

/**
 * When the makeover isn't a room (a wheelchair ramp, a chair lift), what to call it: the thing itself.
 * null for rooms, which keep "room" and "rooms".
 */
/**
 * The word for a makeover that isn't simply rooms: a ramp or a lift by name, a mix of rooms and a ramp
 * as the kid's "makeover". null for rooms. label: the ticket's heading over it.
 */
export function makeoverWord(names) {
  const list = (names || []).filter(Boolean);
  const all = notARoom(list);
  if (all) return { ...all, label: 'Project' };
  return list.some((n) => notARoom([n])) ? { title: 'Makeover', lower: 'makeover', label: 'Project', mixed: true } : null;
}

/**
 * The short version of a kid's story: the page's own summary, else the bio's first paragraph cut at a
 * sentence by 320 characters, tidied.
 */
export function shortStory(kid = {}, max = 320) {
  if (kid.heroSummary) return tidy(kid.heroSummary).trim();
  const first = tidy(stripHtml(kid.bio).split(/\n\n+/).find((s) => s.trim().length > 20) || '').replace(/\s+([.,!?])/g, '$1').trim();
  if (first.length <= max) return first;
  // "Jr.", "Dr.", "St." and the like don't end a sentence; a closing quote or bracket goes with the one it ends
  const ABBR = /\b(Jr|Sr|Dr|Mr|Mrs|Ms|Mt|St|Ave|Rd|vs|etc|e\.g|i\.e)\./g;
  const held = first.replace(ABBR, '$1\u0000');
  const sentences = (held.match(/[^.!?]+[.!?]+["”’)\]]*(\s+|$)/g) || [held]).map((x) => x.replace(/\u0000/g, '.'));
  let out = '';
  for (const sentence of sentences) {
    if (out && out.length + sentence.length > max) break;
    out += sentence;
  }
  return out.trim();
}

export function notARoom(names) {
  const list = (names || []).filter(Boolean);
  return list.length && list.every((n) => /\b(ramps?|lifts?|elevators?|porch(es)?|decks?|walkways?|driveways?|entrances?|entry|entries)\b/i.test(n) && !/\broom\b/i.test(n))
    ? { title: listJoin(list), lower: listJoin(list).toLowerCase() } : null;
}

/** A name's words, the last with what follows it: ("Remi & Nico", "’s") → ["Remi", "&", "Nico’s"] */
export const nameRuns = (name, after = '') => {
  const w = String(name || '').split(/\s+/).filter(Boolean);
  if (w.length) w[w.length - 1] += after;
  return w;
};

/** The photos the email could use, in the order it would try them */
export const kidPhotos = (kid) => (kid?.photos || []).filter((ph) => ph && ph.url);

/** The photos an email chooses from: spread across the gallery, and few enough to check them all */
export const galleryPicks = (kid) => {
  const all = kidPhotos(kid);
  return all.length <= 9 ? all : Array.from({ length: 9 }, (_, i) => all[Math.floor((i * all.length) / 9)]);
};

/** The cover picture: the first of the three candidates kidPhotoUrls checks at cover size that loads, never an unchecked one */
export const leadPhoto = (kid, broken = new Set()) => [kid?.heroImage, ...galleryPicks(kid).map((ph) => ph.url)].filter(Boolean).slice(0, 3)
  .find((src) => !broken.has(cfImg(src, HERO_TRANSFORM)) && !broken.has(cfImg(src, PHOTO_TRANSFORM))) || '';

/** Every kid photo URL the email could load, in its email sizes */
export const kidPhotoUrls = (kid) => {
  const picks = galleryPicks(kid).map((ph) => ph.url);
  const leads = [kid?.heroImage, ...picks].filter(Boolean).slice(0, 3).map((u) => cfImg(u, HERO_TRANSFORM));
  return [...new Set([...leads, ...picks.map((u) => cfImg(u, PHOTO_TRANSFORM))])];
};

/** Every partner logo URL the email would load, in its email size */
export const partnerLogoUrls = (kid) => (kid?.partnerLogos || []).filter((l) => l && l.url).map((l) => cfImg(l.url, LOGO_TRANSFORM));

export function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Only http(s) links reach an href; anything else becomes "#" */
function safeHref(url) {
  const raw = String(url == null ? '' : url).trim();
  if (!raw || /[\u0000-\u001F\u007F]/.test(raw)) return '#';
  return /^https?:\/\//i.test(raw) ? raw : '#';
}
export const href = (url) => escapeHtml(safeHref(url));

/** The email's colors and fonts */
export const BRAND = Object.freeze({ Y, D, DD, CR, WG, BD, TL, TM, SANS, SERIF });

/** A Cloudflare Images URL (any variant) → the same image with these transforms */
export function cfImg(src, transforms) {
  const s = String(src || '');
  const m = s.match(/ROYFuPmfN2vPS6mt5sCkZQ\/(.+?)\/(?:public|[a-z]+=[^/]*)$/) || s.match(/ROYFuPmfN2vPS6mt5sCkZQ\/(.+)$/);
  const id = m ? m[1] : s;
  return /^https?:\/\//.test(id) ? id : `${CF}/${id}/${transforms}`;
}

export function stripHtml(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&rsquo;/g, '’').replace(/&lsquo;/g, '‘')
    .replace(/&ldquo;/g, '“').replace(/&rdquo;/g, '”')
    .replace(/&mdash;/g, '—').replace(/&ndash;/g, '–')
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d{1,6});/g, (_, n) => { try { return String.fromCodePoint(Number(n)); } catch { return ''; } })
    .trim();
}

/** "Remi & Nico" and "Remi and Nico" take "arrive", not "arrives" */
/** The kid's name from the page, without the stray spaces an editor keeps ("Max " would read "Max ’s") */
export const kidName = (kid, fallback) => curly(String(kid?.name || '').replace(/\s+/g, ' ').trim()) || fallback;

export const twoKids = (name) => /\s(&|and)\s/.test(String(name || ''));

/** Typographic apostrophes, so names and copy read like the rest of the email */
/** Text a family or staff typed, made to read like the rest of the email: curly quotes, and a spaced en dash where they typed an em dash (a comma there would make two sentences one) */
export const tidy = (s) => curly(s).replace(/\s*(\u2014|--+)\s*/g, ' \u2013 ').replace(/ +- +/g, ' \u2013 ');

export const curly = (s) => String(s || '')
  .replace(/(^|[\s(\[{“‘])"/g, '$1“').replace(/"/g, '”')
  .replace(/(\w)'(\w)/g, '$1’$2')
  .replace(/(^|[\s(\[{“])'/g, '$1‘').replace(/'/g, '’');

/** "2026-11-17" + "16:00" → "Tuesday, November 17, 2026 · 4:00 PM" */
/** JobTread's address, as a person would write it: no ", USA" */
/**
 * An address that breaks only after its commas: each part keeps together ("Peachtree Corners"), and the
 * city stays with its state and ZIP while that fits a phone line, so "GA 30092" is never alone.
 * A part too long for a line (a long street name) keeps its spaces.
 */
export function addressLines(address) {
  const parts = String(address || '').split(/,\s*/).filter(Boolean);
  const glue = (t, max) => (t.length <= max ? t.replace(/ /g, '\u00A0') : t);
  const n = parts.length;
  // "Roswell, GA 30076" as one unit when short, else the city and "GA 30076" each kept whole
  if (n >= 2 && /^[A-Z]{2}\s+\d{5}(-\d{4})?$/.test(parts[n - 1])) {
    const cityState = `${parts[n - 2]}, ${parts[n - 1]}`;
    const tail = cityState.length <= 28 ? glue(cityState, 28) : `${glue(parts[n - 2], 22)}, ${glue(parts[n - 1], 22)}`;
    return [...parts.slice(0, -2).map((p) => glue(p, 22)), tail].join(', ');
  }
  return parts.map((p) => glue(p, 22)).join(', ');
}

export const cleanAddress = (address) => String(address || '').trim().replace(/,?\s*(USA|United States)\.?$/i, '');

/** What a draft made before JobTread confirms says for the time */
export const TIME_LATER = 'Time to be confirmed';

export function revealWhen(date, time) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return '';
  const day = new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  const m = String(time || '').match(/^(\d{1,2}):(\d{2})/);
  // Drafted before JobTread confirms: the day is known, the time isn't yet
  if (!m) return `${day} \u00b7 ${TIME_LATER}`;
  const h = Number(m[1]);
  return `${day} · ${((h + 11) % 12) + 1}:${m[2]} ${h < 12 ? 'AM' : 'PM'}`;
}

/** "Wednesday, November 18": the year would only wrap a date on a phone, and nobody's unsure which year */
function longDay(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return '';
  return new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
}

/** "Wed, Nov 18", for the label over the headline */
function shortDay(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return '';
  return new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** A small caps label with the brand's bar in front of it */
export function label(text, bar = Y, color = D) {
  // The bar is its own small block at the first line's height, so a label that wraps ("TYRECE & MADDIE’S / STORY") keeps a bar, not a slab
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr>
    <td valign="top" width="28" style="width:28px;padding-top:4px;"><div style="width:28px;height:10px;background:${bar};border-radius:2px;font-size:0;line-height:0;">&nbsp;</div></td>
    <td valign="top" style="padding-left:12px;font-family:${SANS};font-size:12px;font-weight:700;line-height:18px;letter-spacing:0.14em;text-transform:uppercase;color:${color};">${(String(text).trim().split(/\s+/).length > 2 || String(text).length > 20 ? noWidow(escapeHtml(text)) : escapeHtml(text)).replace(/ &amp; /g, ' &amp;&nbsp;')}</td>
  </tr></table>`;
}

export function pill(text, url, main = false) {
  return `<a href="${href(url)}" target="_blank" style="display:inline-block;padding:${main ? '13px 24px' : '11px 20px'};background:${main ? Y : '#FFFFFF'};border:1.5px solid ${main ? Y : BD};border-radius:100px;font-family:${SANS};font-size:13px;font-weight:600;color:${D};text-decoration:none;margin:0 3px 8px;">${escapeHtml(text)}</a>`;
}

/** The site's own calendar links for this kid's reveal: they follow JobTread if the date moves. watch: for someone watching from home, not a guest. */
export function calendarLinks(slug, site = SITE_URL, { watch = false } = {}) {
  const base = `${site}/api/calendar.ics?reveal=${encodeURIComponent(slug)}${watch ? '&watch=1' : ''}`;
  return { google: `${base}&app=google`, apple: base, outlook: `${base}&app=outlook` };
}

/**
 * Kit sends every email inside its own template, whose style block says `table td { vertical-align:top }`.
 * A style rule beats a valign attribute and the browser's own middle, so in Kit's preview, Apple Mail and
 * any client that keeps that block, partner logos sat at the top of their cards and the room numbers at
 * the top of their circles. Each cell says where it sits inline, where no stylesheet can move it.
 */
export function pinCells(html) {
  return String(html).replace(/<td\b([^>]*)>/gi, (tag, attrs) => {
    if (/vertical-align\s*:/i.test(attrs)) return tag;
    const align = ((attrs.match(/\svalign\s*=\s*"?(top|middle|bottom|baseline)/i) || [])[1] || 'middle').toLowerCase();
    return /\sstyle\s*=\s*"/i.test(attrs)
      ? `<td${attrs.replace(/\sstyle\s*=\s*"/i, (s) => `${s}vertical-align:${align};`)}>`
      : `<td${attrs} style="vertical-align:${align};">`;
  });
}

/** The email around its rows: the width, the phone rules and the hidden preview line. Fluid, so a phone that drops the style block still fits it; Outlook's ghost table holds the width there. */
export function emailFrame(preview, rows) {
  return pinCells(`<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${escapeHtml(preview)}${'&#847;&zwnj;&nbsp;'.repeat(90)}</div>
<style>
  a[x-apple-data-detectors]{color:inherit!important;text-decoration:none!important;font-size:inherit!important;font-family:inherit!important;font-weight:inherit!important;line-height:inherit!important}
  @media screen and (max-width:600px){
    .ec{width:100%!important}
    .fl{max-width:100%!important;height:auto!important}
    .pd{padding-left:24px!important;padding-right:24px!important}
    .h1m{font-size:26px!important}
    .h2m{font-size:20px!important}
    .dm{font-size:40px!important}
    .dms{font-size:30px!important}
    .h2b{font-size:26px!important}
    .ld{font-size:18px!important}
  }
</style>
<center style="width:100%;background:${WG};padding:24px 0;">
<!--[if mso]><table role="presentation" cellspacing="0" cellpadding="0" border="0" width="600" align="center"><tr><td><![endif]-->
<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" class="ec" style="margin:0 auto;width:100%;max-width:600px;">
${rows}
</table>
<!--[if mso]></td></tr></table><![endif]-->
</center>`);
}

export function emailHeader(site = SITE_URL, { rounded = false, logoWidth = 124, pad = 20, mark = false } = {}) {
  // mark: the trimmed logo, as much space above it as below it before the cover's first line
  const width = mark ? 96 : logoWidth;
  return `<tr><td bgcolor="${DD}" style="background:${DD};padding:${mark ? '28px 0 14px' : `${pad}px 0`};${SIDE}text-align:center;${rounded ? 'border-radius:16px 16px 0 0;' : ''}" class="pd${rounded ? ' band' : ''}">
    <a href="${href(site)}" target="_blank" style="display:inline-block;color:#FFFFFF;text-decoration:none;"><img src="${escapeHtml(mark ? LOGO_MARK : LOGO)}" width="${width}" alt="Sunshine on a Ranney Day" style="display:block;width:${width}px;height:auto;font-family:${SANS};font-size:13px;line-height:18px;color:#FFFFFF;" /></a>
  </td></tr>`;
}

export function emailFooter(site = SITE_URL, { mark = false } = {}) {
  // mark: the trimmed logo (LOGO_MARK), the same size on the page as the untrimmed one at 120px
  return `<tr><td bgcolor="${DD}" style="background:${DD};padding:${mark ? '40px 0 36px' : '36px 0'};${SIDE}text-align:center;" class="pd">
    <a href="${href(site)}" target="_blank" style="display:inline-block;margin-bottom:${mark ? 22 : 16}px;"><img src="${escapeHtml(mark ? LOGO_MARK : LOGO)}" width="${mark ? 84 : 120}" alt="Sunshine on a Ranney Day" style="display:block;width:${mark ? 84 : 120}px;height:auto;" /></a>
    <p style="margin:0 0 14px;font-family:${SANS};font-size:12px;color:#8E8F93;">501(c)(3) Nonprofit &middot; EIN 45-4773997</p>
    <p style="margin:0 0 14px;font-family:${SANS};font-size:12px;">
      ${[['Facebook', 'https://www.facebook.com/sunshineonaranneyday'], ['Instagram', 'https://www.instagram.com/sunshineonaranneyday'], ['YouTube', 'https://www.youtube.com/@sunshineonaranneyday'], ['TikTok', 'https://www.tiktok.com/@sunshineonaranneyday']]
    // A plain space on each side of a dot, so a narrow phone can wrap the row between links
    .map(([name, url]) => `<a href="${url}" target="_blank" style="color:#C9CACC;text-decoration:underline;text-underline-offset:3px;white-space:nowrap;">${name}</a>`)
    .join(' <span style="color:#5A5B61;">&middot;</span> ')}
    </p>
    <p style="margin:0;font-family:${SANS};font-size:11px;color:#8E8F93;">You’re receiving this because you’re a valued partner or supporter of SOARD.</p>
  </td></tr>`;
}

/** The closing line, the team picture and who it's from */
export function signOff(line, teamPicture = true) {
  return `<tr><td bgcolor="${CR}" style="background:${CR};padding:36px 0 40px;${SIDE}" class="pd">
    <p style="margin:0 0 18px;font-family:${SERIF};font-size:17px;font-style:italic;line-height:1.7;color:${D};">${noWidow(escapeHtml(line))}</p>
    ${teamPicture ? `<img src="${escapeHtml(TEAM_PICTURE)}" width="504" alt="The SOARD team" class="fl" style="width:100%;height:auto;display:block;border-radius:16px;margin:0 0 18px;" />` : ''}
    <p style="margin:0;font-family:${SANS};font-size:14px;font-weight:700;color:${D};">The SOARD Team</p>
    <p style="margin:4px 0 0;font-family:${SANS};font-size:13px;color:${TM};">Sunshine on a Ranney Day</p>
  </td></tr>`;
}

/**
 * A button that keeps its shape in Outlook, which ignores padding on links. An arrow at the end
 * stays on its last word's line. block: it fills its cell, for a row of equal buttons that
 * shrinks with the phone.
 */
export function button(text, url, { fill = Y, ink = D, center = false, small = false, block = false } = {}) {
  const pad = block ? '13px 4px' : small ? '13px 24px' : '17px 30px';
  const words = escapeHtml(String(text)).replace(/ (→|&rarr;)$/, '&nbsp;$1');
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0"${block ? ' width="100%"' : ''}${center ? ' align="center" style="margin:0 auto;"' : ''}><tr>
      <td align="center" bgcolor="${fill}" style="background:${fill};border-radius:100px;mso-padding-alt:${pad};"><a href="${href(url)}" target="_blank" style="display:${block ? 'block' : 'inline-block'};padding:${pad};font-family:${SANS};font-size:${small || block ? 14 : 16}px;font-weight:700;line-height:1.2;color:${ink};text-decoration:none;border-radius:100px;${block ? 'white-space:nowrap;word-break:keep-all;overflow-wrap:normal;' : 'word-break:keep-all;overflow-wrap:normal;'}">${words}</a></td>
    </tr></table>`;
}

/** A plain link with its arrow, for the second thing a reader might do */
export function textLink(text, url, color = D) {
  return `<a href="${href(url)}" target="_blank" style="font-family:${SANS};font-size:15px;font-weight:700;color:${color};text-decoration:underline;text-underline-offset:4px;">${escapeHtml(text).replace(/ &amp; /g, ' &amp;&nbsp;').replace(/ (\S+ →)$/, '&nbsp;$1').replace(/ →$/, '&nbsp;→')}</a>`;
}

/** The dark cover all three emails open with: the kicker, the name large, the lead photo, then whatever comes first */
export function cover({ kicker, headline, size, phone, lead, alt, url, action = '' }) {
  return `<tr><td bgcolor="${DD}" align="center" style="background:${DD};padding:14px 0 44px;${SIDE}text-align:center;" class="pd">
    <p style="margin:0 0 14px;font-family:${SANS};font-size:12px;font-weight:700;letter-spacing:0.18em;text-transform:uppercase;color:${Y};">${escapeHtml(kicker)}</p>
    <h1 class="${phone}" style="margin:0 0 30px;font-family:${SERIF};font-size:${size}px;font-weight:700;line-height:1.14;letter-spacing:-0.01em;color:#FFFFFF;">${headline}</h1>
    ${lead ? `<a href="${href(url)}" target="_blank" style="display:block;text-decoration:none;"><img src="${escapeHtml(cfImg(lead, COVER_TRANSFORM))}" width="504" alt="${escapeHtml(alt)}" class="fl" style="width:100%;height:auto;display:block;border-radius:20px;" /></a>` : ''}
    ${action ? `<div style="height:28px;line-height:28px;font-size:0;">&nbsp;</div>${action}` : ''}
  </td></tr>`;
}

/** The first words after the cover, a size up from the rest */
export function lede(text, after = '') {
  return `<tr><td bgcolor="${CR}" style="background:${CR};padding:40px 0 0;${SIDE}" class="pd">
    <p class="ld" style="margin:0;font-family:${SERIF};font-size:19px;line-height:1.65;color:${D};">${noWidow(escapeHtml(text))}</p>
    ${after}
  </td></tr>`;
}

/**
 * The photos left for the body of an email, spread across the gallery since
 * neighbors are often the same moment. A kid's gallery opens with the family, which
 * suits an email sent before the reveal; a finished gallery opens on the cover's
 * moment, so `middle` takes the middle of each stretch instead of its start.
 */
export function bodyPhotos(kid, lead, broken, count, middle = false) {
  const usable = galleryPicks(kid).filter((ph) => ph.url !== lead && !broken.has(cfImg(ph.url, PHOTO_TRANSFORM)));
  if (usable.length <= count) return usable;
  return Array.from({ length: count }, (_, i) => usable[Math.floor(((i + (middle ? 0.5 : 0)) * usable.length) / count)]);
}

export const photoImg = (ph, name, transform, width) => `<img src="${escapeHtml(cfImg(ph.url, transform))}" width="${width}" alt="${escapeHtml(ph.alt || name)}" class="fl" style="width:100%;height:auto;display:block;border-radius:14px;" />`;

/** Two photos, side by side at every screen size */
export function photoPair(photos, name, top = 8) {
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin-top:${top}px;"><tr>
      <td width="49%" valign="top">${photoImg(photos[0], name, PHOTO_TRANSFORM, 247)}</td>
      <td width="2%" style="font-size:0;">&nbsp;</td>
      <td width="49%" valign="top">${photoImg(photos[1], name, PHOTO_TRANSFORM, 247)}</td>
    </tr></table>`;
}

/** The small line that thanks whoever took the pictures, and the way to the rest of them */
export function photoNotes(kid, link = '', { photos = true } = {}) {
  const credit = photos && kid.photographer ? `<p style="margin:${link ? 10 : 0}px 0 0;font-family:${SANS};font-size:13px;color:${TM};">Photos by ${noWidow(escapeHtml(tidy(kid.photographer)))}</p>` : '';
  return link || credit ? `<div style="padding-top:16px;">${link}${credit}</div>` : '';
}

/**
 * A typed note as HTML: a pasted link becomes a short name to tap ("Google Maps", "zeffy.com") rather
 * than a run of characters across five lines, and the note never ends on one word alone.
 */
export function noteHtml(text, color = '#FFFFFF') {
  const parts = String(text || '').split(/(https?:\/\/[^\s<>"]+)/g);
  const mail = (t) => escapeHtml(t).replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, (m) => `<a href="mailto:${m}" style="color:${color};font-weight:600;text-decoration:underline;text-underline-offset:2px;">${m}</a>`);
  return noWidow(parts.map((part, i) => {
    if (i % 2 === 0) return mail(tidy(part));
    const url = part.replace(/[.,;:!?)\]]+$/, '');
    const trail = part.slice(url.length);
    let host;
    try { host = new URL(url).hostname.toLowerCase().replace(/^www\./, ''); } catch { return escapeHtml(part); }
    const name = (/^google\.[a-z.]+$/.test(host) && /\/maps\b/.test(url)) || /^maps\.google\.|^maps\.app\.goo\.gl$|^goo\.gl$/.test(host) ? 'Google Maps'
      : /(^|\.)maps\.apple\.com$/.test(host) ? 'Apple Maps' : host;
    return `<a href="${href(url)}" target="_blank" style="color:${color};font-weight:600;text-decoration:underline;text-underline-offset:2px;">${escapeHtml(name).replace(/ /g, '&nbsp;')}</a>${escapeHtml(trail)}`;
  }).join(''));
}

/** The invite's details on the dark cover, ruled like a ticket: rows of { label, lines, sub, keep, even }, then what to know before coming */
function ticket(rows, notes) {
  const line = 'border-top:1px solid #3A3B42;';
  const word = `font-family:${SANS};font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:#A5A6A9;`;
  // Words break only where a person would. A word too long for a whole line (a pasted link) may
  // break; the fixed layout keeps it from widening the email. Gmail's phone app breaks any squeezed
  // word, so this is said on each line, not left to inherit.
  const wrap = 'word-break:normal;overflow-wrap:break-word;';
  const main = `font-family:${SANS};font-size:17px;font-weight:600;line-height:1.4;color:#FFFFFF;${wrap}`;
  const quiet = `font-family:${SANS};font-size:15px;line-height:1.5;color:#C9CACC;${wrap}`;
  // Each label sits over its value, so a date or an address has the full width of a phone
  const block = (labelText, inner) => `<tr><td style="padding:14px 0 15px;${line}">
        <div style="${word}">${escapeHtml(labelText)}</div>
        <div style="height:6px;line-height:6px;font-size:0;">&nbsp;</div>
        ${inner}
      </td></tr>`;
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="text-align:left;table-layout:fixed;">
      ${rows.map((r) => block(r.label, `${r.lines.map((l) => `<div style="${main}">${r.keep ? listJoin(r.keep.map((k) => escapeHtml(k).replace(/ /g, '&nbsp;'))).replace(/ and /g, ' and&nbsp;') : r.even ? noWidow(escapeHtml(l)) : escapeHtml(l)}</div>`).join('')}
        ${r.sub ? `<div style="margin-top:2px;${quiet}">${escapeHtml(r.sub)}</div>` : ''}`)).join('')}
      ${notes.length ? block('Before you come', notes.map((n, i) => `<div style="margin-top:${i ? 6 : 0}px;${i ? quiet : `font-family:${SANS};font-size:15px;font-weight:600;line-height:1.5;color:#FFFFFF;${wrap}`}">${noteHtml(n)}</div>`).join('')) : ''}
    </table>`;
}

/** The soft card of facts: rows of { label, main, sub } */
export function factsCard(rows) {
  const details = rows.map((r, i) => {
    const line = i === rows.length - 1 ? '' : `border-bottom:1px solid ${BD};`;
    return `<tr>
            <td style="padding:14px 0;${line}vertical-align:top;width:84px;"><span style="font-family:${SANS};font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:${TL};">${escapeHtml(r.label)}</span></td>
            <td style="padding:14px 0;${line}vertical-align:top;">
              <span style="font-family:${SERIF};font-size:16px;font-weight:700;color:${D};display:block;line-height:1.4;">${escapeHtml(r.main)}</span>
              ${r.sub ? `<span style="font-family:${SANS};font-size:13px;color:${TM};display:block;margin-top:3px;line-height:1.5;">${escapeHtml(r.sub)}</span>` : ''}
            </td>
          </tr>`;
  }).join('');
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background:${WG};border-radius:14px;">
          <tr><td style="padding:4px 22px;"><table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">${details}</table></td></tr>
        </table>`;
}

/** Three photos in a row (two will do), leaving out the lead photo and any that won't load */
export function photoStrip(kid, leadSrc, brokenLogos = new Set()) {
  const name = curly(kid.name || '');
  const usable = galleryPicks(kid).filter((ph) => ph.url !== leadSrc && !brokenLogos.has(cfImg(ph.url, PHOTO_TRANSFORM)));
  // Spread across the gallery: neighbors are often the same moment
  const photos = usable.length > 3 ? [0, 1, 2].map((i) => usable[Math.floor((i * usable.length) / 3)]) : usable;
  return photos.length >= 2 ? `
  <tr><td style="background:${CR};padding:16px 48px 0;" class="pd">
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%"><tr>
      ${photos.map((ph, i) => `${i ? '<td width="2%" style="font-size:0;">&nbsp;</td>' : ''}<td width="${photos.length === 3 ? 32 : 49}%" valign="top"><img src="${escapeHtml(cfImg(ph.url, PHOTO_TRANSFORM))}" width="160" alt="${escapeHtml(ph.alt || name)}" class="fl" style="width:100%;height:auto;display:block;border-radius:12px;" /></td>`).join('')}
    </tr></table>
  </td></tr>` : '';
}

/** The partner logos on their dark band. '' with none to show. */
/** The partners an email shows: one each, a logo that won't load as the partner's name, a screenshot's file name not at all */
export function shownPartners(kid, brokenLogos = new Set()) {
  // One card per partner, even when a kid page lists a logo twice
  const seenLogo = new Set();
  return (kid?.partnerLogos || []).filter((l) => {
    if (!l || !l.url) return false;
    const key = String(l.name || '').trim().toLowerCase() || cfImg(l.url, '');
    if (seenLogo.has(key)) return false;
    seenLogo.add(key);
    return true;
  }).map((l) => ({ ...l, label: tidy(partnerLabel(l.name)) })).flatMap((l) => {
    if (!brokenLogos.has(cfImg(l.url, LOGO_TRANSFORM))) return [l];
    // Broken: the name in text, unless the "name" is only a file's (a screenshot upload)
    return l.label ? [{ ...l, text: true }] : [];
  });
}

/** Bold sans width in ems, a little generous: capitals run wide */
const sansEm = (s) => [...String(s)].reduce((w, c) => w + (/[MW]/.test(c) ? 0.95 : /[A-Z&]/.test(c) ? 0.74 : /[mw]/.test(c) ? 0.9 : /[a-z0-9]/.test(c) ? 0.6 : /\s/.test(c) ? 0.28 : 0.34), 0);

/**
 * A partner's name for its card, in lines as even as they can be ("Bin There / Dump That / Atlanta",
 * never "Bin There Dump That / Atlanta") at the largest size up to 13px where the widest line fits the
 * card on a phone (about 92px of text) and the lines fit its 66px height. A line never ends on "&".
 */
export function nameCard(label) {
  // Words, and the parts of a hyphenated one ("Sherwin-" "Williams"), which join without a space
  const words = String(label).split(/\s+/).filter(Boolean).flatMap((w) => w.split(/(?<=-)(?=.)/));
  const join = (ws) => ws.reduce((line, w, i) => (i && !/-$/.test(ws[i - 1]) ? `${line} ${w}` : `${line}${w}`), '');
  const splits = (n, from = 0) => {
    if (n === 1) return [[join(words.slice(from))]];
    const out = [];
    for (let i = from + 1; i <= words.length - n + 1; i++) {
      for (const rest of splits(n - 1, i)) out.push([join(words.slice(from, i)), ...rest]);
    }
    return out;
  };
  let best = null;
  for (let n = 1; n <= Math.min(3, words.length); n++) {
    for (const lines of splits(n)) {
      if (lines.slice(0, -1).some((l) => /(^|\s)(&|and)$/i.test(l))) continue;
      const size = Math.min(13, Math.floor(92 / Math.max(...lines.map(sansEm))), Math.floor(60 / (n * 1.25)));
      const even = Math.max(...lines.map(sansEm)) - Math.min(...lines.map(sansEm));
      if (!best || size > best.size || (size === best.size && n === best.lines.length && even < best.even)) best = { size, lines, even };
    }
  }
  return { size: Math.max(9, best?.size || 13), lines: best?.lines || [String(label)] };
}

/** The partner logos on their dark band. '' with none to show. */
export function partnerCards(kid, brokenLogos = new Set()) {
  const logos = shownPartners(kid, brokenLogos);
  // Every tile the same height, whatever the logo's shape; a short last row sits centered
  const tile = (inner) => `<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="table-layout:fixed;"><tr><td align="center" valign="middle" height="66" bgcolor="#FFFFFF" class="lt" style="height:66px;background:#FFFFFF;border-radius:10px;padding:0 8px;text-align:center;">${inner}</td></tr></table>`;
  const logoRows = [];
  // Two to a row: three left each logo about 65px wide on a phone, too small to read a wordmark
  for (let i = 0; i < logos.length; i += 2) {
    const row = logos.slice(i, i + 2);
    // The gap is only between the cards, so the grid's edges line up with the text above it.
    // No phone class on the logo: .fl's max-width:100% would lift its 116px cap and push it out of its card.
    const pad = (k) => (row.length === 1 ? '4px 2px' : k === 0 ? '4px 4px 4px 0' : '4px 0 4px 4px');
    const cells = row.map((l, k) => `<td width="${(100 / row.length).toFixed(2)}%" valign="middle" class="lc" style="padding:${pad(k)};">${l.text
      // A logo that doesn't load reads as the partner's name instead of a broken picture, in even lines (nameCard)
      ? ((c) => tile(`<span style="display:block;font-family:${SANS};font-size:${c.size}px;font-weight:700;line-height:1.25;color:${D};word-break:normal;overflow-wrap:break-word;">${c.lines.map((t) => escapeHtml(t).replace(/ /g, '&nbsp;')).join('<br>')}</span>`))(nameCard(l.label))
      : tile(`<img src="${escapeHtml(cfImg(l.url, LOGO_TRANSFORM))}" width="116" alt="${escapeHtml(l.label || 'Partner logo')}" style="display:block;width:100%;max-width:104px;height:auto;margin:0 auto;" />`)}</td>`);
    // Fixed layout keeps the columns equal, whatever is in them
    logoRows.push(`<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="${row.length === 1 ? '50%' : '100%'}" align="center" style="margin:0 auto;table-layout:fixed;"><tr>${cells.join('')}</tr></table>`);
  }
  const one = logos.length === 1;
  // Two even lines on any phone ("Thank you to our / incredible partners."), one on a desktop
  const heading = headlineFit(['Thank', 'you', 'to', 'our', `incredible ${one ? 'partner.' : 'partners.'}`], 22, { phones: [[20, 'h2m']] });
  return logoRows.length ? `
  <tr><td style="background:${CR};padding:36px 0 0;">
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background:${DD};"><tr>
      <td style="padding:40px 0 34px;${SIDE}" class="pd">
        ${label(one ? 'Our partner' : 'Our partners', Y, '#C9CACC')}
        <h2 class="${heading.phone}" style="margin:18px 0 20px;font-family:${SERIF};font-size:${heading.size}px;font-weight:700;line-height:1.3;color:#FFFFFF;">Thank you to our <em style="font-style:italic;color:${Y};">incredible</em>&nbsp;${one ? 'partner' : 'partners'}.</h2>
        ${logoRows.join('\n        ')}
      </td>
    </tr></table>
  </td></tr>` : '';
}

/**
 * @param {object} p
 * @param {object} p.kid      the kid's page record (name, slug, heroImage, photos, heroSummary, bio, roomTypes, partnerLogos)
 * @param {string} p.date     YYYY-MM-DD (Eastern)
 * @param {string} p.time     HH:MM, 24-hour (Eastern)
 * @param {string} [p.address]  the family's address from the JobTread job
 * @param {string} [p.notes]    JobTread "Reveal Invite Details" (parking, arrival)
 * @param {string} [p.room]     JobTread Makeover Type, when the kid page has no rooms
 * @param {string} [p.subjectPrefix]  "TEST · " for a rehearsal
 * @returns {{ subject: string, preview: string, html: string, text: string }}
 */
export function revealInviteEmail({ kid = {}, date, time, address = '', notes = '', room = '', subjectPrefix = '', site = SITE_URL, brokenLogos = new Set(), teamPicture = true } = {}) {
  const name = kidName(kid, 'our next kid');
  const slug = kid.slug || '';
  const kidUrl = slug ? `${site}/kids/${slug}/` : `${site}/kids/`;
  const liveUrl = slug ? `${site}/live/${slug}/` : `${site}/live/`;
  const roomLines = roomNames(kid, room);
  const roomText = listJoin(roomLines);
  const several = roomLines.length > 1 || Number(kid.roomCount) > 1;
  const when = revealWhen(date, time);
  const cal = calendarLinks(slug, site);

  const subject = `${subjectPrefix}You’re Invited to ${name}’s Reveal Day!`;
  const preview = roomText
    ? `Come celebrate ${name} as we reveal the brand-new ${roomText.toLowerCase()}!`
    : `Come celebrate ${name} on reveal day!`;

  // A picture that won't load is passed over, never shown broken
  const lead = leadPhoto(kid, brokenLogos);

  // The day and the time each keep their own line, so a phone never breaks a date in two
  const rows = [
    // A time not yet confirmed reads as a quieter line, not as a time
    when && (/^\d{1,2}:\d{2}/.test(String(time || ''))
      ? { label: 'When', lines: [longDay(date), when.split(' · ')[1]] }
      : { label: 'When', lines: [longDay(date)], sub: TIME_LATER }),
    // No address from JobTread yet: say so, rather than leave guests with only "Josué’s Home"
    // "Amanda, Caleb & Isaac’s Home" never leaves "Home" alone (even)
    { label: 'Where', lines: [`${name}’s Home`], even: true, sub: addressLines(tidy(cleanAddress(address))) || 'Address to be confirmed' },
    // One line ("Wheelchair-Accessible Bathroom and Dream Bedroom"), so a long name that wraps never reads as another room
    roomLines.length && { label: makeoverWord(roomLines) ? 'Project' : several ? 'Rooms' : 'Room', lines: [roomText], keep: roomLines },
  ].filter(Boolean);
  // Each line of the team's note on its own, without the bullet it was typed with ("- Park on the street")
  const noteLines = String(notes || '').split(/\n+/).map((s) => s.trim().replace(/^([-*•·]|\d+[.)])\s+/, '').trim()).filter(Boolean);
  // The team's own arrival note stands in for ours, so it isn't said twice
  // ("Early Intervention" isn't an arrival note; "come 15 minutes early" is)
  const arrive = /\barriv|\b(come|be|get there|get here|show up)\s+(\w+\s+){0,3}early\b|\b\d+\s*(min|mins|minutes)\s+early\b/i.test(notes) ? null : `Please arrive 15 minutes early so everyone’s in place before ${name} ${twoKids(name) ? 'arrive' : 'arrives'}.`;

  // No date or no confirmed time yet (an early draft): no calendar buttons, since there's nothing to save yet
  const timed = !!when && /^\d{1,2}:\d{2}/.test(String(time || ''));
  const calendar = slug && timed ? `<div style="height:28px;line-height:28px;font-size:0;">&nbsp;</div>
    <p style="margin:0 0 14px;font-family:${SANS};font-size:15px;font-weight:700;color:#FFFFFF;">Save it to your calendar</p>
    <!-- Three equal buttons that share the width, so the row shrinks with a small phone instead of spilling off it -->
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" align="center" style="margin:0 auto;max-width:330px;table-layout:fixed;"><tr>
      <td width="33.33%" style="padding:0 4px 0 0;">${button('Google', cal.google, { block: true })}</td>
      <td width="33.33%" style="padding:0 2px;">${button('Apple', cal.apple, { block: true })}</td>
      <td width="33.33%" style="padding:0 0 0 4px;">${button('Outlook', cal.outlook, { block: true })}</td>
    </tr></table>
    <p style="margin:18px 0 0;font-family:${SANS};font-size:14px;color:#C9CACC;line-height:1.6;">Can’t be there in person? <a href="${href(liveUrl)}" target="_blank" style="color:#FFFFFF;font-weight:600;text-decoration:underline;text-underline-offset:2px;white-space:nowrap;">Watch it live</a> from&nbsp;anywhere.</p>` : '';

  const summary = shortStory(kid);
  const photos = bodyPhotos(kid, lead, brokenLogos, 2);
  const fit = fitName({ name, after: '’s', runs: ['Reveal Day.'], max: 42, min: 30 });
  const space = makeoverWord(roomLines);
  // "Tyrece, Maddie, and the family", never "Tyrece & Maddie and the family" (or "Remi and Nico and the family")
  const who = twoKids(name) ? `${name.replace(/\s(&|and)\s/, ', ')}, and the family` : `${name} and the family`;
  const opening = `After months of planning and building, the day is almost here. ${who} haven’t seen the finished ${space ? space.lower : several ? 'rooms' : 'room'} yet. Come be there for that first reaction.`;

  const html = emailFrame(preview, `
  ${emailHeader(site, { mark: true })}
  ${cover({
    kicker: ['Reveal Day', shortDay(date)].filter(Boolean).join(' · '),
    headline: `<span style="display:block;margin-bottom:8px;font-size:24px;font-weight:400;font-style:italic;line-height:1.3;color:#E4E4E5;">You’re Invited to</span>${fit.html} <em style="font-style:italic;color:${Y};">Reveal&nbsp;Day</em>.`,
    size: fit.size,
    phone: fit.phone,
    lead,
    alt: `${name}’s reveal day`,
    url: kidUrl,
    action: `${ticket(rows, [arrive, ...noteLines].filter(Boolean))}${calendar}`,
  })}
  ${lede(opening)}
  ${summary ? `<tr><td bgcolor="${CR}" style="background:${CR};padding:36px 0 0;${SIDE}" class="pd">
    ${label(`${name}’s story`)}
    <p style="margin:14px 0 0;font-family:${SERIF};font-size:17px;line-height:1.7;color:${D};">${noWidow(escapeHtml(summary))}</p>
  </td></tr>` : ''}
  <tr><td bgcolor="${CR}" style="background:${CR};padding:28px 0 0;${SIDE}" class="pd">
    ${photos.length >= 2 ? photoPair(photos, name, 0) : ''}
    ${photoNotes(kid, textLink(`Read ${name}’s story →`, kidUrl), { photos: !!lead || photos.length >= 2 })}
  </td></tr>
  ${partnerCards(kid, brokenLogos) || `<tr><td bgcolor="${CR}" style="background:${CR};height:8px;font-size:0;line-height:0;">&nbsp;</td></tr>`}
  ${signOff('Hope to see you there.', teamPicture)}
  ${emailFooter(site, { mark: true })}`);

  const text = [
    `You’re Invited to ${name}’s Reveal Day`,
    '',
    opening,
    '',
    when && `When: ${when}`,
    `Where: ${name}’s Home${address ? `, ${tidy(cleanAddress(address))}` : ' (address to be confirmed)'}`,
    roomText && `${makeoverWord(roomLines) ? 'Project' : several ? 'Rooms' : 'Room'}: ${roomText}`,
    '',
    arrive,
    ...noteLines.map(tidy),
    '',
    slug && timed && `Add to your calendar: ${cal.apple}`,
    slug && timed && `Watch it live: ${liveUrl}`,
    `${name}’s story: ${kidUrl}`,
    '',
    'Hope to see you there.',
    'The SOARD Team, Sunshine on a Ranney Day',
  ].filter((l) => l !== false && l !== null && l !== undefined).join('\n').replace(/\n{3,}/g, '\n\n').trim();

  return { subject, preview, html, text };
}
