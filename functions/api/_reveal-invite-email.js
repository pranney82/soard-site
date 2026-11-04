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
const href = (url) => escapeHtml(safeHref(url));

/** A Cloudflare Images URL (any variant) → the same image with these transforms */
export function cfImg(src, transforms) {
  const s = String(src || '');
  const m = s.match(/ROYFuPmfN2vPS6mt5sCkZQ\/(.+?)\/(?:public|[a-z]+=[^/]*)$/) || s.match(/ROYFuPmfN2vPS6mt5sCkZQ\/(.+)$/);
  const id = m ? m[1] : s;
  return /^https?:\/\//.test(id) ? id : `${CF}/${id}/${transforms}`;
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&rsquo;/g, '’').replace(/&lsquo;/g, '‘')
    .replace(/&ldquo;/g, '“').replace(/&rdquo;/g, '”')
    .replace(/&mdash;/g, '—').replace(/&ndash;/g, '–')
    .trim();
}

/** Typographic apostrophes, so names and copy read like the rest of the email */
const curly = (s) => String(s || '').replace(/(\w)'(\w)/g, '$1’$2');

/** "2026-11-17" + "16:00" → "Tuesday, November 17, 2026 · 4:00 PM" */
export function revealWhen(date, time) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) return '';
  const day = new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
  const m = String(time || '').match(/^(\d{1,2}):(\d{2})/);
  // Drafted before JobTread confirms: the day is known, the time isn't yet
  if (!m) return `${day} \u00b7 Time to be confirmed`;
  const h = Number(m[1]);
  return `${day} · ${((h + 11) % 12) + 1}:${m[2]} ${h < 12 ? 'AM' : 'PM'}`;
}

/** A small caps label with the brand's bar in front of it */
function label(text, bar = Y, color = D) {
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr>
    <td style="width:28px;height:10px;background:${bar};border-radius:2px;font-size:0;line-height:0;">&nbsp;</td>
    <td style="padding-left:12px;font-family:${SANS};font-size:12px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:${color};">${escapeHtml(text)}</td>
  </tr></table>`;
}

function pill(text, url) {
  return `<a href="${href(url)}" target="_blank" style="display:inline-block;padding:11px 20px;background:#FFFFFF;border:1.5px solid ${BD};border-radius:100px;font-family:${SANS};font-size:13px;font-weight:600;color:${D};text-decoration:none;margin:0 3px 8px;">${escapeHtml(text)}</a>`;
}

/** The site's own calendar links for this kid's reveal: they follow JobTread if the date moves */
export function calendarLinks(slug, site = SITE_URL) {
  const base = `${site}/api/calendar.ics?reveal=${encodeURIComponent(slug)}`;
  return { google: `${base}&app=google`, apple: base, outlook: `${base}&app=outlook` };
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
export function revealInviteEmail({ kid = {}, date, time, address = '', notes = '', room = '', subjectPrefix = '', site = SITE_URL } = {}) {
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

  const heroSrc = kid.heroImage || kid.photos?.[0]?.url || '';
  const hero = heroSrc ? `
        <tr><td style="padding:0 0 28px;">
          <a href="${href(kidUrl)}" target="_blank" style="display:block;text-decoration:none;">
            <img src="${escapeHtml(cfImg(heroSrc, 'w=1200,h=760,fit=cover,gravity=face,q=85'))}" width="504" alt="${escapeHtml(`${name}’s reveal day`)}" class="fl" style="width:100%;height:auto;display:block;border-radius:20px;" />
          </a>
        </td></tr>` : '';

  const rows = [
    when && { label: 'When', main: when },
    { label: 'Where', main: `${name}’s Home`, sub: address },
    roomText && { label: 'Room', main: roomText },
  ].filter(Boolean);
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

  const noteLines = String(notes || '').split(/\n+/).map((s) => s.trim()).filter(Boolean);
  const before = `
        <tr><td style="padding:16px 0 0;">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background:#FFF6CC;border-radius:12px;">
            <tr><td style="padding:14px 18px;">
              <span style="font-family:${SANS};font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:#7A6400;display:block;margin-bottom:4px;">Before you come</span>
              <span style="font-family:${SANS};font-size:14px;font-weight:600;color:${D};line-height:1.5;display:block;">Please arrive 15 minutes early so everyone’s in place before ${escapeHtml(name)} arrives.</span>
              ${noteLines.map((l) => `<span style="font-family:${SANS};font-size:14px;color:${D};line-height:1.5;display:block;margin-top:6px;">${escapeHtml(curly(l))}</span>`).join('')}
            </td></tr>
          </table>
        </td></tr>`;

  const calendar = slug ? `
        <tr><td style="padding:24px 0 0;text-align:center;">
          <p style="margin:0 0 12px;font-family:${SANS};font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:${TL};">Add to calendar</p>
          ${pill('Google', cal.google)}${pill('Apple', cal.apple)}${pill('Outlook', cal.outlook)}
          <p style="margin:10px 0 0;font-family:${SANS};font-size:14px;color:${TM};line-height:1.6;">Can’t be there in person? <a href="${href(liveUrl)}" target="_blank" style="color:${D};font-weight:600;text-decoration:underline;text-underline-offset:2px;">Watch it live</a> from anywhere.</p>
        </td></tr>` : '';

  const summary = kid.heroSummary ? [curly(kid.heroSummary)] : stripHtml(kid.bio).split(/\n\n+/).filter((s) => s.trim().length > 20).slice(0, 1);
  const story = summary.length ? `
  <tr><td style="background:${CR};padding:36px 48px 0;" class="pd">
    ${label(`${name}’s story`, D)}
    <div style="height:10px;line-height:10px;font-size:0;">&nbsp;</div>
    ${summary.map((t) => `<p style="margin:0 0 16px;font-family:${SANS};font-size:16px;line-height:1.75;color:${D};">${escapeHtml(t)}</p>`).join('')}
  </td></tr>` : '';

  const photos = (kid.photos || []).filter((ph) => ph && ph.url && ph.url !== heroSrc).slice(0, 3);
  const photoRow = photos.length >= 2 ? `
  <tr><td style="background:${CR};padding:16px 48px 0;" class="pd">
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%"><tr>
      ${photos.map((ph, i) => `${i ? '<td width="2%" style="font-size:0;">&nbsp;</td>' : ''}<td width="${photos.length === 3 ? 32 : 49}%" valign="top"><img src="${escapeHtml(cfImg(ph.url, 'w=500,h=500,fit=cover,gravity=face,q=75'))}" width="160" alt="${escapeHtml(ph.alt || name)}" class="fl" style="width:100%;height:auto;display:block;border-radius:12px;" /></td>`).join('')}
    </tr></table>
  </td></tr>` : '';

  // One card per partner, even when a kid page lists a logo twice
  const seenLogo = new Set();
  const logos = (kid.partnerLogos || []).filter((l) => {
    if (!l || !l.url) return false;
    const key = String(l.name || '').trim().toLowerCase() || cfImg(l.url, '');
    if (seenLogo.has(key)) return false;
    seenLogo.add(key);
    return true;
  });
  const logoRows = [];
  for (let i = 0; i < logos.length; i += 3) {
    const cells = [0, 1, 2].map((c) => {
      const l = logos[i + c];
      if (!l) return '<td width="33.33%" style="padding:5px;">&nbsp;</td>';
      return `<td width="33.33%" valign="middle" style="padding:5px;"><div style="background:#FFFFFF;border-radius:10px;padding:8px 10px;text-align:center;"><img src="${escapeHtml(cfImg(l.url, 'w=400,h=160,fit=pad,background=white,q=88'))}" width="140" alt="${escapeHtml(l.name || '')}" class="fl" style="width:100%;max-width:150px;height:auto;display:inline-block;vertical-align:middle;" /></div></td>`;
    });
    logoRows.push(`<tr>${cells.join('')}</tr>`);
  }
  const partners = logoRows.length ? `
  <tr><td style="background:${CR};padding:36px 0 0;">
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background:${DD};"><tr>
      <td style="padding:40px 48px 34px;" class="pd">
        ${label('Made possible by', '#5A5B61', '#A5A6A9')}
        <h2 class="h2m" style="margin:18px 0 20px;font-family:${SERIF};font-size:22px;font-weight:700;line-height:1.3;color:#FFFFFF;">A reveal day made possible by these <em style="font-style:italic;color:${Y};">incredible</em> partners.</h2>
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">${logoRows.join('')}</table>
      </td>
    </tr></table>
  </td></tr>` : '';

  const html = `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${escapeHtml(preview)}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>
<style>
  @media screen and (max-width:600px){
    .ec{width:100%!important}
    .fl{max-width:100%!important;height:auto!important}
    .pd{padding-left:24px!important;padding-right:24px!important}
    .h1m{font-size:26px!important}
    .h2m{font-size:20px!important}
  }
</style>
<center style="width:100%;background:${WG};padding:24px 0;">
<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="600" class="ec" style="margin:0 auto;max-width:600px;">
  <tr><td style="background:${DD};padding:32px 48px;text-align:center;" class="pd">
    <a href="${href(site)}" target="_blank" style="display:inline-block;"><img src="${escapeHtml(LOGO)}" width="160" alt="Sunshine on a Ranney Day" style="width:160px;height:auto;" /></a>
  </td></tr>
  <tr><td style="background:${CR};padding:36px 48px 0;" class="pd">
    ${label('You’re invited')}
    <h1 class="h1m" style="margin:18px 0 12px;font-family:${SERIF};font-size:30px;font-weight:700;line-height:1.2;color:${D};">You’re Invited to ${escapeHtml(name)}’s Reveal Day</h1>
    <p style="margin:0 0 28px;font-family:${SERIF};font-size:17px;line-height:1.7;color:${D};">After months of planning and building, the day is almost here. ${escapeHtml(name)} and the family haven’t seen the finished room yet. Come be there for that first reaction.</p>
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
      ${hero}
      <tr><td style="padding:0;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background:${WG};border-radius:14px;">
          <tr><td style="padding:4px 22px;"><table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">${details}</table></td></tr>
        </table>
      </td></tr>
      ${before}
      ${calendar}
    </table>
  </td></tr>
  ${story}
  ${photoRow}
  ${partners}
  <tr><td style="background:${CR};padding:36px 48px 0;text-align:center;" class="pd">
    <a href="${href(kidUrl)}" target="_blank" style="display:inline-block;padding:16px 36px;background:${Y};color:${D};font-family:${SANS};font-size:15px;font-weight:600;text-decoration:none;border-radius:100px;">See ${escapeHtml(name)}’s Story &rarr;</a>
  </td></tr>
  <tr><td style="background:${CR};padding:32px 48px 40px;" class="pd">
    <div style="height:1px;line-height:1px;font-size:0;background:${BD};margin-bottom:28px;">&nbsp;</div>
    <p style="margin:0 0 18px;font-family:${SERIF};font-size:17px;font-style:italic;line-height:1.7;color:${D};">Hope to see you there.</p>
    <p style="margin:0;font-family:${SANS};font-size:14px;font-weight:700;color:${D};">Peter &amp; Holly Ranney</p>
    <p style="margin:2px 0 0;font-family:${SANS};font-size:14px;font-weight:600;color:${D};">Sunshine Team</p>
    <p style="margin:6px 0 0;font-family:${SANS};font-size:13px;color:${TM};">Founders, Sunshine on a Ranney Day</p>
  </td></tr>
  <tr><td style="background:${DD};padding:36px 48px;text-align:center;" class="pd">
    <a href="${href(site)}" target="_blank" style="display:inline-block;margin-bottom:16px;"><img src="${escapeHtml(LOGO)}" width="120" alt="Sunshine on a Ranney Day" style="width:120px;height:auto;" /></a>
    <p style="margin:0 0 14px;font-family:${SANS};font-size:12px;color:#8E8F93;">501(c)(3) Nonprofit &middot; EIN 45-4773997</p>
    <p style="margin:0 0 14px;font-family:${SANS};font-size:13px;">
      <a href="https://www.facebook.com/sunshineonaranneyday" target="_blank" style="color:#C9CACC;text-decoration:underline;text-underline-offset:3px;">Facebook</a><span style="color:#5A5B61;padding:0 8px;">&middot;</span><a href="https://www.instagram.com/sunshineonaranneyday" target="_blank" style="color:#C9CACC;text-decoration:underline;text-underline-offset:3px;">Instagram</a><span style="color:#5A5B61;padding:0 8px;">&middot;</span><a href="https://www.youtube.com/@sunshineonaranneyday" target="_blank" style="color:#C9CACC;text-decoration:underline;text-underline-offset:3px;">YouTube</a><span style="color:#5A5B61;padding:0 8px;">&middot;</span><a href="https://www.tiktok.com/@sunshineonaranneyday" target="_blank" style="color:#C9CACC;text-decoration:underline;text-underline-offset:3px;">TikTok</a>
    </p>
    <p style="margin:0;font-family:${SANS};font-size:11px;color:#8E8F93;">You’re receiving this because you’re a valued partner or supporter of SOARD.</p>
  </td></tr>
</table>
</center>`;

  const text = [
    `You’re Invited to ${name}’s Reveal Day`,
    '',
    `After months of planning and building, the day is almost here. ${name} and the family haven’t seen the finished room yet. Come be there for that first reaction.`,
    '',
    when && `When: ${when}`,
    `Where: ${name}’s Home${address ? `, ${address}` : ''}`,
    roomText && `Room: ${roomText}`,
    '',
    `Please arrive 15 minutes early so everyone’s in place before ${name} arrives.`,
    ...noteLines.map(curly),
    '',
    slug && `Add to your calendar: ${cal.apple}`,
    `Watch it live: ${liveUrl}`,
    `${name}’s story: ${kidUrl}`,
    '',
    'Hope to see you there.',
    'Peter & Holly Ranney, Founders, Sunshine on a Ranney Day',
  ].filter((l) => l !== false && l !== null && l !== undefined).join('\n');

  return { subject, preview, html, text };
}
