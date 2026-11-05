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
const LOGO = `${CF}/brand-logo-dark-bg-tagline-display/w=400,q=85`;
/** The team as plushies, in the signature (Cloudflare Images) */
export const TEAM_PICTURE = `${CF}/emails/soard-team-plushie/w=1008,q=85`;

// trim: many logo files are mostly white space, and would sit tiny in their cards
export const LOGO_TRANSFORM = 'trim=border,w=400,h=160,fit=pad,background=white,q=88';
export const HERO_TRANSFORM = 'w=1200,h=760,fit=cover,gravity=face,q=85';
export const PHOTO_TRANSFORM = 'w=500,h=500,fit=cover,gravity=face,q=75';
/** A partner name a person would write, not an uploaded file's ("Screenshot 2026-08-31 at 15.46.42", "IMG_123.png") */
export const realPartnerName = (name) => !!String(name || '').trim() && !/^(screenshot|screen shot|img[_ -]?\d|image\s*\d|dsc|photo)\b|\.(png|jpe?g|gif|webp|svg)$/i.test(String(name).trim());

/** The photos the email could use, in the order it would try them */
export const kidPhotos = (kid) => (kid?.photos || []).filter((ph) => ph && ph.url);

/** The photos an email chooses from: spread across the gallery, and few enough to check them all */
export const galleryPicks = (kid) => {
  const all = kidPhotos(kid);
  return all.length <= 9 ? all : Array.from({ length: 9 }, (_, i) => all[Math.floor((i * all.length) / 9)]);
};

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

/** Typographic apostrophes, so names and copy read like the rest of the email */
export const curly = (s) => String(s || '').replace(/(\w)'(\w)/g, '$1’$2');

/** "2026-11-17" + "16:00" → "Tuesday, November 17, 2026 · 4:00 PM" */
/** JobTread's address, as a person would write it: no ", USA" */
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

/** "Wed, Nov 18", for the label over the headline */
function shortDay(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return '';
  return new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
}

/** A small caps label with the brand's bar in front of it */
export function label(text, bar = Y, color = D) {
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr>
    <td style="width:28px;height:10px;background:${bar};border-radius:2px;font-size:0;line-height:0;">&nbsp;</td>
    <td style="padding-left:12px;font-family:${SANS};font-size:12px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:${color};">${escapeHtml(text)}</td>
  </tr></table>`;
}

export function pill(text, url, main = false) {
  return `<a href="${href(url)}" target="_blank" style="display:inline-block;padding:${main ? '13px 24px' : '11px 20px'};background:${main ? Y : '#FFFFFF'};border:1.5px solid ${main ? Y : BD};border-radius:100px;font-family:${SANS};font-size:13px;font-weight:600;color:${D};text-decoration:none;margin:0 3px 8px;">${escapeHtml(text)}</a>`;
}

/** The site's own calendar links for this kid's reveal: they follow JobTread if the date moves */
export function calendarLinks(slug, site = SITE_URL) {
  const base = `${site}/api/calendar.ics?reveal=${encodeURIComponent(slug)}`;
  return { google: `${base}&app=google`, apple: base, outlook: `${base}&app=outlook` };
}

/** The email around its rows: the width, the phone rules and the hidden preview line. Fluid, so a phone that drops the style block still fits it; Outlook's ghost table holds the width there. */
export function emailFrame(preview, rows, phoneRules = '') {
  return `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${escapeHtml(preview)}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>
<style>
  @media screen and (max-width:600px){
    .ec{width:100%!important}
    .fl{max-width:100%!important;height:auto!important}
    .pd{padding-left:24px!important;padding-right:24px!important}
    .h1m{font-size:26px!important}
    .h2m{font-size:20px!important}
    .lt{height:50px!important;padding:0 8px!important}
    .lc{padding:3px!important}${phoneRules}
  }
</style>
<center style="width:100%;background:${WG};padding:24px 0;">
<!--[if mso]><table role="presentation" cellspacing="0" cellpadding="0" border="0" width="600" align="center"><tr><td><![endif]-->
<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" class="ec" style="margin:0 auto;width:100%;max-width:600px;">
${rows}
</table>
<!--[if mso]></td></tr></table><![endif]-->
</center>`;
}

export function emailHeader(site = SITE_URL) {
  return `<tr><td style="background:${DD};padding:20px 48px;text-align:center;" class="pd">
    <a href="${href(site)}" target="_blank" style="display:inline-block;"><img src="${escapeHtml(LOGO)}" width="124" alt="Sunshine on a Ranney Day" style="width:124px;height:auto;" /></a>
  </td></tr>`;
}

export function emailFooter(site = SITE_URL) {
  return `<tr><td style="background:${DD};padding:36px 48px;text-align:center;" class="pd">
    <a href="${href(site)}" target="_blank" style="display:inline-block;margin-bottom:16px;"><img src="${escapeHtml(LOGO)}" width="120" alt="Sunshine on a Ranney Day" style="width:120px;height:auto;" /></a>
    <p style="margin:0 0 14px;font-family:${SANS};font-size:12px;color:#8E8F93;">501(c)(3) Nonprofit &middot; EIN 45-4773997</p>
    <p style="margin:0 0 14px;font-family:${SANS};font-size:13px;">
      <a href="https://www.facebook.com/sunshineonaranneyday" target="_blank" style="color:#C9CACC;text-decoration:underline;text-underline-offset:3px;">Facebook</a><span style="color:#5A5B61;padding:0 8px;">&middot;</span><a href="https://www.instagram.com/sunshineonaranneyday" target="_blank" style="color:#C9CACC;text-decoration:underline;text-underline-offset:3px;">Instagram</a><span style="color:#5A5B61;padding:0 8px;">&middot;</span><a href="https://www.youtube.com/@sunshineonaranneyday" target="_blank" style="color:#C9CACC;text-decoration:underline;text-underline-offset:3px;">YouTube</a><span style="color:#5A5B61;padding:0 8px;">&middot;</span><a href="https://www.tiktok.com/@sunshineonaranneyday" target="_blank" style="color:#C9CACC;text-decoration:underline;text-underline-offset:3px;">TikTok</a>
    </p>
    <p style="margin:0;font-family:${SANS};font-size:11px;color:#8E8F93;">You’re receiving this because you’re a valued partner or supporter of SOARD.</p>
  </td></tr>`;
}

/** The closing line, the team picture and who it's from */
export function signOff(line, teamPicture = true) {
  return `<tr><td style="background:${CR};padding:36px 48px 40px;" class="pd">
    <p style="margin:0 0 18px;font-family:${SERIF};font-size:17px;font-style:italic;line-height:1.7;color:${D};">${escapeHtml(line)}</p>
    ${teamPicture ? `<img src="${escapeHtml(TEAM_PICTURE)}" width="504" alt="The SOARD team" class="fl" style="width:100%;height:auto;display:block;border-radius:16px;margin:0 0 18px;" />` : ''}
    <p style="margin:0;font-family:${SANS};font-size:14px;font-weight:700;color:${D};">The SOARD Team</p>
    <p style="margin:4px 0 0;font-family:${SANS};font-size:13px;color:${TM};">Sunshine on a Ranney Day</p>
  </td></tr>`;
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
export function partnerCards(kid, brokenLogos = new Set(), lead = 'Made possible by these') {
  // One card per partner, even when a kid page lists a logo twice
  const seenLogo = new Set();
  const logos = (kid.partnerLogos || []).filter((l) => {
    if (!l || !l.url) return false;
    const key = String(l.name || '').trim().toLowerCase() || cfImg(l.url, '');
    if (seenLogo.has(key)) return false;
    seenLogo.add(key);
    return true;
  }).flatMap((l) => {
    if (!brokenLogos.has(cfImg(l.url, LOGO_TRANSFORM))) return [l];
    // Broken: the name in text, unless the "name" is only a file's (a screenshot upload)
    return realPartnerName(l.name) ? [{ ...l, text: true }] : [];
  });
  // Every tile the same height, whatever the logo's shape; a short last row sits centered
  const tile = (inner) => `<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%"><tr><td align="center" valign="middle" height="66" bgcolor="#FFFFFF" class="lt" style="height:66px;background:#FFFFFF;border-radius:10px;padding:0 12px;text-align:center;">${inner}</td></tr></table>`;
  const logoRows = [];
  for (let i = 0; i < logos.length; i += 3) {
    const row = logos.slice(i, i + 3);
    const cells = row.map((l) => `<td width="${(100 / row.length).toFixed(2)}%" valign="middle" class="lc" style="padding:5px;">${l.text
      // A logo that doesn't load reads as the partner's name instead of a broken picture
      ? tile(`<span style="font-family:${SANS};font-size:13px;font-weight:700;line-height:1.25;color:${D};">${escapeHtml(l.name)}</span>`)
      : tile(`<img src="${escapeHtml(cfImg(l.url, LOGO_TRANSFORM))}" width="132" alt="${escapeHtml(l.name || '')}" class="fl" style="width:100%;max-width:150px;height:auto;display:inline-block;vertical-align:middle;" />`)}</td>`);
    logoRows.push(`<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="${['33.33%', '66.66%', '100%'][row.length - 1]}" align="center" style="margin:0 auto;"><tr>${cells.join('')}</tr></table>`);
  }
  return logoRows.length ? `
  <tr><td style="background:${CR};padding:36px 0 0;">
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background:${DD};"><tr>
      <td style="padding:40px 48px 34px;" class="pd">
        ${label('Our partners', '#5A5B61', '#A5A6A9')}
        <h2 class="h2m" style="margin:18px 0 20px;font-family:${SERIF};font-size:22px;font-weight:700;line-height:1.3;color:#FFFFFF;">${escapeHtml(lead)} <em style="font-style:italic;color:${Y};">incredible</em> partners.</h2>
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
  const name = curly(kid.name || 'our next kid');
  const slug = kid.slug || '';
  const kidUrl = slug ? `${site}/kids/${slug}/` : `${site}/kids/`;
  const liveUrl = slug ? `${site}/live/${slug}/` : `${site}/live/`;
  const rooms = (Array.isArray(kid.roomTypes) ? kid.roomTypes.filter(Boolean) : []);
  const roomText = rooms.length ? rooms.join(' + ') : String(room || '').trim();
  const when = revealWhen(date, time);
  const cal = calendarLinks(slug, site);

  const subject = `${subjectPrefix}You’re Invited to ${name}’s Reveal Day!`;
  const preview = roomText
    ? `Come celebrate ${name} as we reveal their brand-new ${roomText.toLowerCase()}!`
    : `Come celebrate ${name} on reveal day!`;

  // A picture that won't load is passed over, never shown broken
  const shows = (src, transform) => !brokenLogos.has(cfImg(src, transform));
  const heroSrc = [kid.heroImage, ...galleryPicks(kid).map((ph) => ph.url)].filter(Boolean).find((src) => shows(src, HERO_TRANSFORM)) || '';
  const hero = heroSrc ? `
        <tr><td style="padding:0 0 28px;">
          <a href="${href(kidUrl)}" target="_blank" style="display:block;text-decoration:none;">
            <img src="${escapeHtml(cfImg(heroSrc, HERO_TRANSFORM))}" width="504" alt="${escapeHtml(`${name}’s reveal day`)}" class="fl" style="width:100%;height:auto;display:block;border-radius:20px;" />
          </a>
        </td></tr>` : '';

  const rows = [
    when && { label: 'When', main: when },
    { label: 'Where', main: `${name}’s Home`, sub: cleanAddress(address) },
    roomText && { label: 'Room', main: roomText },
  ].filter(Boolean);
  const noteLines = String(notes || '').split(/\n+/).map((s) => s.trim()).filter(Boolean);
  // The team's own arrival note stands in for ours, so it isn't said twice
  const arrive = /\barriv|\bearly\b/i.test(notes) ? null : `Please arrive 15 minutes early so everyone’s in place before ${name} ${/\s(&|and)\s/.test(name) ? 'arrive' : 'arrives'}.`;
  const before = `
        <tr><td style="padding:16px 0 0;">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background:#FFF6CC;border-radius:12px;">
            <tr><td style="padding:14px 18px;">
              <span style="font-family:${SANS};font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:#7A6400;display:block;margin-bottom:4px;">Before you come</span>
              ${arrive ? `<span style="font-family:${SANS};font-size:14px;font-weight:600;color:${D};line-height:1.5;display:block;">${escapeHtml(arrive)}</span>` : ''}
              ${noteLines.map((l, i) => `<span style="font-family:${SANS};font-size:14px;${arrive ? '' : 'font-weight:600;'}color:${D};line-height:1.5;display:block;${arrive || i ? 'margin-top:6px;' : ''}">${escapeHtml(curly(l))}</span>`).join('')}
            </td></tr>
          </table>
        </td></tr>`;

  const calendar = slug ? `
        <tr><td style="padding:24px 0 0;text-align:center;">
          <p style="margin:0 0 12px;font-family:${SANS};font-size:15px;font-weight:700;color:${D};">Save it to your calendar</p>
          ${pill('Google', cal.google, true)}${pill('Apple', cal.apple, true)}${pill('Outlook', cal.outlook, true)}
          <p style="margin:10px 0 0;font-family:${SANS};font-size:14px;color:${TM};line-height:1.6;">Can’t be there in person? <a href="${href(liveUrl)}" target="_blank" style="color:${D};font-weight:600;text-decoration:underline;text-underline-offset:2px;">Watch it live</a> from anywhere.</p>
        </td></tr>` : '';

  const summary = kid.heroSummary ? [curly(kid.heroSummary)] : stripHtml(kid.bio).split(/\n\n+/).filter((s) => s.trim().length > 20).slice(0, 1);
  const story = summary.length ? `
  <tr><td style="background:${CR};padding:36px 48px 0;" class="pd">
    ${label(`${name}’s story`, D)}
    <div style="height:10px;line-height:10px;font-size:0;">&nbsp;</div>
    ${summary.map((t) => `<p style="margin:0 0 16px;font-family:${SANS};font-size:16px;line-height:1.75;color:${D};">${escapeHtml(t)}</p>`).join('')}
  </td></tr>` : '';

  const photoRow = photoStrip(kid, heroSrc, brokenLogos);

  const partners = partnerCards(kid, brokenLogos, 'A reveal day made possible by these');

  const html = emailFrame(preview, `
  ${emailHeader(site)}
  <tr><td style="background:${CR};padding:36px 48px 0;" class="pd">
    ${label(['Reveal Day', shortDay(date)].filter(Boolean).join(' · '))}
    <h1 class="h1m" style="margin:18px 0 12px;font-family:${SERIF};font-size:30px;font-weight:700;line-height:1.2;color:${D};">You’re Invited to<br>${escapeHtml(name)}’s Reveal Day</h1>
    <p style="margin:0 0 28px;font-family:${SERIF};font-size:17px;line-height:1.7;color:${D};">After months of planning and building, the day is almost here. ${escapeHtml(name)} and the family haven’t seen the finished room yet. Come be there for that first reaction.</p>
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
      ${hero}
      <tr><td style="padding:0;">
        ${factsCard(rows)}
      </td></tr>
      ${before}
      ${calendar}
    </table>
  </td></tr>
  ${story}
  ${photoRow}
  <tr><td style="background:${CR};padding:24px 48px 0;" class="pd">
    ${pill(`See ${name}’s Story →`, kidUrl)}
  </td></tr>
  ${partners}
  ${signOff('Hope to see you there.', teamPicture)}
  ${emailFooter(site)}`);

  const text = [
    `You’re Invited to ${name}’s Reveal Day`,
    '',
    `After months of planning and building, the day is almost here. ${name} and the family haven’t seen the finished room yet. Come be there for that first reaction.`,
    '',
    when && `When: ${when}`,
    `Where: ${name}’s Home${address ? `, ${cleanAddress(address)}` : ''}`,
    roomText && `Room: ${roomText}`,
    '',
    arrive,
    ...noteLines.map(curly),
    '',
    slug && `Add to your calendar: ${cal.apple}`,
    `Watch it live: ${liveUrl}`,
    `${name}’s story: ${kidUrl}`,
    '',
    'Hope to see you there.',
    'The SOARD Team, Sunshine on a Ranney Day',
  ].filter((l) => l !== false && l !== null && l !== undefined).join('\n');

  return { subject, preview, html, text };
}
