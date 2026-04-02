/**
 * Email Templates — Data-driven, on-brand every time
 *
 * Usage:
 *   import { kidProjectComplete } from './_email-templates.js';
 *   const { from, subject, html } = kidProjectComplete(kidJsonData, { founderNote: '...' });
 *
 * Brand tokens (from global.css):
 *   --c-yellow: #FFDA24    --c-dark: #373A36     --c-dark-deep: #1E1F25
 *   --c-cream: #FEFCF5     --c-warm-gray: #F5F4F0  --c-text-muted: #5A5B61
 *   --c-text-light: #6D6E74  --c-border: #E5E4E0
 *   Display: Libre Baskerville   Body: Outfit
 *   Buttons: pill (100px radius)  Section labels: 28px line + 0.14em caps
 */

const SITE_URL = 'https://sunshineonaranneyday.com';
const CF = 'https://imagedelivery.net/ROYFuPmfN2vPS6mt5sCkZQ';

// ─── Brand tokens ────────────────────────────────────────────────

const Y = '#FFDA24';
const YS = 'rgba(255,218,36,0.45)';
const YG = 'rgba(255,218,36,0.3)';
const D = '#373A36';
const DD = '#1E1F25';
const CR = '#FEFCF5';
const WG = '#F5F4F0';
const TM = '#5A5B61';
const TL = '#6D6E74';
const BD = '#E5E4E0';

const SERIF = "'Libre Baskerville',Georgia,'Times New Roman',serif";
const SANS = "'Outfit',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif";

const ZEFFY_BASE = 'https://www.zeffy.com/en-US/donation-form/help-build-a-brighter-home';

// ─── Shared HTML helpers ─────────────────────────────────────────

function sLabel(text, variant = 'dark') {
  const lc = variant === 'light' ? 'rgba(255,255,255,0.35)' : variant === 'yellow' ? Y : D;
  const tc = variant === 'light' ? 'rgba(255,255,255,0.6)' : D;
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr>
    <td style="width:28px;height:2px;background:${lc};vertical-align:middle;"></td>
    <td style="padding-left:12px;font-family:${SANS};font-size:12px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:${tc};vertical-align:middle;">${text}</td>
  </tr></table>`;
}

function hl(text, v = 'light') {
  return `<em style="font-style:italic;background-image:linear-gradient(transparent 55%,${v === 'dark' ? YG : YS} 55%);background-repeat:no-repeat;background-size:100% 100%;padding:0 .1em;">${text}</em>`;
}

function pillBtn(text, href, v = 'primary') {
  const bg = v === 'primary' ? Y : D;
  const c = v === 'primary' ? D : Y;
  return `<a href="${href}" target="_blank" style="display:inline-block;padding:16px 40px;background:${bg};color:${c};font-family:${SANS};font-size:15px;font-weight:600;text-decoration:none;border-radius:100px;letter-spacing:0.01em;">${text}</a>`;
}

/** Extract CF image ID from a full URL */
function cfId(url) {
  const m = url.match(/ROYFuPmfN2vPS6mt5sCkZQ\/(.+?)\/(?:public|w=|h=|fit=)/);
  if (m) return m[1];
  const m2 = url.match(/ROYFuPmfN2vPS6mt5sCkZQ\/(.+?)$/);
  return m2 ? m2[1].replace(/\/public$/, '') : url;
}

/** Build a CF Images URL with transforms */
function cfImg(src, transforms) {
  const id = src.startsWith('http') ? cfId(src) : src;
  return `${CF}/${id}/${transforms}`;
}

/** Strip HTML tags from bio text */
function stripHtml(html) {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&rsquo;/g, '\u2019')
    .replace(/&ldquo;/g, '\u201C')
    .replace(/&rdquo;/g, '\u201D')
    .replace(/&mdash;/g, '\u2014')
    .replace(/&ndash;/g, '\u2013')
    .trim();
}

/** Split bio into sentences, group into ~2-3 sentence paragraphs */
function bioParagraphs(bio) {
  const clean = stripHtml(bio);
  const chunks = clean.split(/\n\n+/).filter(s => s.trim().length > 20);
  if (chunks.length >= 2) return chunks;
  // Fallback: split by sentences
  const sentences = clean.split(/(?<=[.!?])\s+/).filter(Boolean);
  if (sentences.length <= 3) return [sentences.join(' ')];
  const mid = Math.ceil(sentences.length / 2);
  return [sentences.slice(0, mid).join(' '), sentences.slice(mid).join(' ')];
}

/** Generic room description fallbacks */
const ROOM_DESCRIPTIONS = {
  'Accessible Bathroom': 'A fully redesigned, wheelchair-accessible bathroom — roll-in shower, safe maneuvering space, and features built for independence and dignity.',
  'Dream Bedroom': 'A one-of-a-kind bedroom designed around this child\u2019s personality, interests, and unique needs — their own space to dream big.',
  'Therapy Room': 'A calming, sensory-friendly therapy space with dimmable lights, textured walls, and equipment tailored to this child\u2019s development.',
};

// ─── Shared email shell (head, header, footer) ──────────────────

function emailHead(title) {
  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="X-UA-Compatible" content="IE=edge">
  <title>${title}</title>
  <!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Libre+Baskerville:ital,wght@0,400;0,700;1,400&family=Outfit:wght@400;500;600;700&display=swap');
    body,table,td,a{-webkit-text-size-adjust:100%;-ms-text-size-adjust:100%}
    table,td{mso-table-lspace:0pt;mso-table-rspace:0pt}
    img{-ms-interpolation-mode:bicubic;border:0;height:auto;line-height:100%;outline:none;text-decoration:none}
    body{margin:0;padding:0;width:100%!important;background:${WG}}
    .ec{max-width:600px;margin:0 auto}
    @media screen and (max-width:600px){
      .ec{width:100%!important}
      .fl{max-width:100%!important;height:auto!important}
      .st{display:block!important;width:100%!important;max-width:100%!important}
      .st img{width:100%!important;max-width:100%!important}
      .pd{padding-left:24px!important;padding-right:24px!important}
      .hm{display:none!important}
      .h1m{font-size:26px!important}
      .h2m{font-size:20px!important}
      .hero-img{height:300px!important;object-fit:cover!important}
      .mob-stack{padding-top:12px!important;padding-left:0!important}
    }
  </style>
</head>
<body style="margin:0;padding:0;background:${WG};font-family:${SANS};">`;
}

function emailPreheader(text) {
  return `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${text}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</div>`;
}

function emailHeader() {
  const logo = `${CF}/brand-logo-dark-bg-tagline-display/w=400,q=85`;
  return `<tr>
    <td style="background:${DD};padding:28px 48px;text-align:center;" class="pd">
      <a href="${SITE_URL}" target="_blank" style="display:inline-block;">
        <img src="${logo}" width="160" alt="Sunshine on a Ranney Day" style="width:160px;height:auto;" />
      </a>
    </td>
  </tr>`;
}

function emailFooter() {
  const logo = `${CF}/brand-logo-dark-bg-tagline-display/w=400,q=85`;
  return `<tr>
    <td style="background:${DD};padding:36px 48px;text-align:center;" class="pd">
      <a href="${SITE_URL}" target="_blank" style="display:inline-block;margin-bottom:16px;">
        <img src="${logo}" width="120" alt="Sunshine on a Ranney Day" style="width:120px;height:auto;" />
      </a>
      <p style="margin:0 0 8px;font-family:${SANS};font-size:13px;color:rgba(255,255,255,0.45);line-height:1.6;">250 Hembree Park Drive, Suite 106 &middot; Roswell, GA 30076</p>
      <p style="margin:0 0 16px;font-family:${SANS};font-size:12px;color:rgba(255,255,255,0.3);">501(c)(3) Nonprofit &middot; EIN 45-4773997</p>
      <p style="margin:0 0 20px;font-family:${SANS};font-size:13px;">
        <a href="https://www.facebook.com/sunshineonaranneyday" target="_blank" style="color:rgba(255,255,255,0.45);text-decoration:underline;text-underline-offset:3px;">Facebook</a>
        <span style="color:rgba(255,255,255,0.15);padding:0 8px;">&middot;</span>
        <a href="https://www.instagram.com/sunshineonaranneyday" target="_blank" style="color:rgba(255,255,255,0.45);text-decoration:underline;text-underline-offset:3px;">Instagram</a>
        <span style="color:rgba(255,255,255,0.15);padding:0 8px;">&middot;</span>
        <a href="https://www.youtube.com/@sunshineonaranneyday" target="_blank" style="color:rgba(255,255,255,0.45);text-decoration:underline;text-underline-offset:3px;">YouTube</a>
        <span style="color:rgba(255,255,255,0.15);padding:0 8px;">&middot;</span>
        <a href="https://www.tiktok.com/@sunshineonaranneyday" target="_blank" style="color:rgba(255,255,255,0.45);text-decoration:underline;text-underline-offset:3px;">TikTok</a>
      </p>
      <p style="margin:0 0 8px;font-family:${SANS};font-size:11px;color:rgba(255,255,255,0.2);">You're receiving this because you're a valued partner or supporter of SOARD.</p>
      <a href="{{{RESEND_UNSUBSCRIBE_URL}}}" style="font-family:${SANS};font-size:11px;color:rgba(255,255,255,0.3);text-decoration:underline;text-underline-offset:2px;">Unsubscribe</a>
    </td>
  </tr>`;
}

function emailWrap(preheader, body) {
  return `${emailPreheader(preheader)}
  <center style="width:100%;background:${WG};padding:32px 0;">
    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="600" class="ec" style="margin:0 auto;">
      ${emailHeader()}
      ${body}
      ${emailFooter()}
    </table>
  </center>
</body>
</html>`;
}

const FROM = 'Sunshine on a Ranney Day <sunshine@comms.soardcharity.com>';

// ═══════════════════════════════════════════════════════════════════
// 1. PROJECT REVEAL — Completed project announcement
// ═══════════════════════════════════════════════════════════════════

/**
 * @param {object} kid — Kid JSON data
 * @param {object} [opts]
 * @param {string} [opts.founderNote]
 * @param {string[]} [opts.roomDescriptions]
 * @param {string} [opts.preheader]
 * @param {string} [opts.subject]
 * @param {string} [opts.headline]
 */
export function projectReveal(kid, opts = {}) {
  const subject = opts.subject || `${kid.name}'s Dream Room is Complete — See the Transformation`;
  const html = buildRevealHtml(kid, opts);
  return { from: FROM, subject, html };
}

// Keep old name as alias
export const kidProjectComplete = projectReveal;

// ═══════════════════════════════════════════════════════════════════
// 2. PROJECT KICKOFF — Introducing an upcoming kid
// ═══════════════════════════════════════════════════════════════════

/**
 * @param {object} kid — Kid JSON data (status: 'in-progress')
 * @param {object} [opts]
 * @param {string} [opts.founderNote]
 * @param {string} [opts.preheader]
 * @param {string} [opts.subject]
 * @param {string} [opts.headline]
 */
export function projectKickoff(kid, opts = {}) {
  const subject = opts.subject || `Meet ${kid.name} — Our Next Dream Room Project`;
  const html = buildKickoffHtml(kid, opts);
  return { from: FROM, subject, html };
}

// ═══════════════════════════════════════════════════════════════════
// 3. MONTHLY IMPACT — Recurring update for donors/partners
// ═══════════════════════════════════════════════════════════════════

/**
 * @param {object} data
 * @param {string} data.month — Display month (e.g. "March 2026")
 * @param {number} data.totalKids — Total kids served to date
 * @param {number} data.totalRooms — Total rooms built to date
 * @param {number} data.years — Years of impact
 * @param {object} [data.recentReveal] — A recently completed kid { name, slug, heroImage, diagnosis, roomTypes }
 * @param {object} [data.currentProject] — An in-progress kid { name, slug, heroImage, diagnosis, roomTypes }
 * @param {object[]} [data.upcomingEvents] — Array of { name, date, url }
 * @param {string} [data.founderNote] — Monthly personal note
 * @param {object} [opts]
 * @param {string} [opts.subject]
 * @param {string} [opts.preheader]
 */
export function monthlyImpact(data, opts = {}) {
  const subject = opts.subject || `SOARD ${data.month} Update — Building Dreams, Changing Lives`;
  const html = buildMonthlyHtml(data, opts);
  return { from: FROM, subject, html };
}

// ─── REVEAL HTML builder ─────────────────────────────────────────

function buildRevealHtml(kid, opts) {
  const name = kid.name;
  const slug = kid.slug;
  const age = Array.isArray(kid.age) ? kid.age.join(', ') : kid.age;
  const ageLabel = Array.isArray(kid.age) && kid.age.length > 1 ? 'Ages' : 'Age';
  const diagnosis = kid.diagnosis || '';
  const year = kid.year || new Date().getFullYear();
  const roomTypes = kid.roomTypes || [];
  const roomCount = kid.roomCount || roomTypes.length;
  const quote = kid.quote || null;
  const photographer = kid.photographer || null;
  const partnerLogos = kid.partnerLogos || [];
  const photos = kid.photos || [];

  const profileUrl = `${SITE_URL}/kids/${slug}`;
  const donateUrl = `${SITE_URL}/donate`;

  // ── Image selection ──
  const heroSrc = kid.heroImage || (photos[0] && photos[0].url) || '';
  const heroImg = cfImg(heroSrc, 'w=1200,h=900,fit=cover,gravity=face,q=80');

  // Pick duo photos (2nd and 3rd from gallery, skipping hero)
  const galleryPhotos = photos.filter(p => cfId(p.url) !== cfId(heroSrc));
  const duoPhoto1 = galleryPhotos[0] ? cfImg(galleryPhotos[0].url, 'w=500,fit=cover,q=75') : null;
  const duoPhoto2 = galleryPhotos[1] ? cfImg(galleryPhotos[1].url, 'w=500,fit=cover,q=75') : null;

  // Before/after: pick from mid-gallery
  const midIdx = Math.floor(galleryPhotos.length / 2);
  const beforePhoto = galleryPhotos[midIdx] ? cfImg(galleryPhotos[midIdx].url, 'w=560,fit=cover,q=70') : null;
  const afterPhoto = galleryPhotos[midIdx + 1] ? cfImg(galleryPhotos[midIdx + 1].url, 'w=560,fit=cover,q=70') : null;

  // Reveal: pick a later photo for the cinematic moment
  const revealIdx = Math.min(galleryPhotos.length - 1, Math.floor(galleryPhotos.length * 0.75));
  const revealPhoto = galleryPhotos[revealIdx] ? cfImg(galleryPhotos[revealIdx].url, 'w=1100,fit=cover,gravity=face,q=80') : null;

  // ── Story text ──
  const paras = kid.bio ? bioParagraphs(kid.bio) : [];
  const lede = paras[0] || '';
  const bodyParas = paras.slice(1);

  // ── Partner names ──
  const partnerNames = partnerLogos.map(p => p.name).filter(Boolean);
  const partnerList = partnerNames.join(' &middot; ');

  // ── Room labels ──
  const roomLabel = roomTypes.join(' + ');

  // ── Headline ──
  const headline = opts.headline || `Meet ${name}`;

  // ── Preheader ──
  const preheader = opts.preheader || (lede.length > 40 ? lede.slice(0, 140) + '...' : `${name}'s dream room is complete — see the transformation.`);

  // ── Founder note ──
  const founderNote = opts.founderNote || `${name} reminded us why we started SOARD. Every room we build is a promise that these kids and their families aren't alone. Thank you for making this possible.`;

  // ── Room descriptions ──
  const roomDescs = roomTypes.map((type, i) => {
    if (opts.roomDescriptions && opts.roomDescriptions[i]) return opts.roomDescriptions[i];
    return ROOM_DESCRIPTIONS[type] || `A custom ${type.toLowerCase()} designed around ${name}'s unique needs.`;
  });

  const body = `<!-- HERO PHOTO -->
      <tr>
        <td style="background:${CR};padding:0;">
          <a href="${profileUrl}" target="_blank" style="display:block;text-decoration:none;">
            <div style="margin:0 24px;border-radius:20px;overflow:hidden;box-shadow:0 24px 64px rgba(0,0,0,0.1),0 4px 16px rgba(0,0,0,0.06);">
              <img src="${heroImg}" width="552" alt="${name} in their dream room" class="fl hero-img" style="width:100%;display:block;" />
            </div>
          </a>
        </td>
      </tr>

      <!-- NAME PILL -->
      <tr>
        <td style="background:${CR};padding:0 48px;" class="pd">
          <div style="margin-top:-22px;position:relative;z-index:2;">
            <table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr>
              <td style="padding:10px 22px;background:rgba(30,31,37,0.85);border-radius:100px;font-family:${SANS};font-size:13px;font-weight:600;color:#fff;letter-spacing:0.01em;">
                ${name}${age ? `, ${ageLabel.toLowerCase()} ${age}` : ''}
              </td>
            </tr></table>
          </div>
        </td>
      </tr>

      <!-- DETAIL CHIPS -->
      <tr>
        <td style="background:${CR};padding:16px 48px 0;" class="pd">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr>
            ${diagnosis ? `<td style="padding:7px 16px;background:${WG};border-radius:100px;font-family:${SANS};font-size:12px;color:${TL};"><span style="font-weight:400;">Diagnosis</span>&nbsp;&nbsp;<strong style="color:${D};">${diagnosis}</strong></td><td width="8"></td>` : ''}
            ${roomLabel ? `<td style="padding:7px 16px;background:${WG};border-radius:100px;font-family:${SANS};font-size:12px;color:${TL};"><span style="font-weight:400;">Rooms</span>&nbsp;&nbsp;<strong style="color:${D};">${roomLabel}</strong></td><td width="8"></td>` : ''}
            <td style="padding:7px 16px;background:${WG};border-radius:100px;font-family:${SANS};font-size:12px;color:${TL};"><span style="font-weight:400;">Year</span>&nbsp;&nbsp;<strong style="color:${D};">${year}</strong></td>
          </tr></table>
        </td>
      </tr>

      <!-- HEADLINE -->
      <tr>
        <td style="background:${CR};padding:32px 48px 0;" class="pd">
          ${sLabel('Project Complete &middot; ' + year)}
          <h1 class="h1m" style="margin:20px 0 0;font-family:${SERIF};font-size:34px;font-weight:700;line-height:1.18;color:${D};letter-spacing:-0.025em;">
            ${headline}
          </h1>
        </td>
      </tr>

      <!-- LEDE -->
      ${lede ? `<tr>
        <td style="background:${CR};padding:24px 48px 0;" class="pd">
          <p style="margin:0;font-family:${SERIF};font-size:18px;line-height:1.7;color:${D};font-weight:400;">${lede}</p>
        </td>
      </tr>` : ''}

      <!-- DUO PHOTOS -->
      ${duoPhoto1 && duoPhoto2 ? `<tr>
        <td style="background:${CR};padding:32px 48px 0;" class="pd">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%"><tr>
            <td width="49%" class="st" valign="top">
              <img src="${duoPhoto1}" width="244" alt="${name}" style="width:100%;border-radius:12px;display:block;" class="fl" />
            </td>
            <td width="2%" class="hm">&nbsp;</td>
            <td width="49%" class="st mob-stack" valign="top">
              <img src="${duoPhoto2}" width="244" alt="${name}" style="width:100%;border-radius:12px;display:block;" class="fl" />
            </td>
          </tr></table>
          ${photographer ? `<p style="margin:8px 0 0;font-family:${SANS};font-size:11px;color:${TL};letter-spacing:0.02em;">Photos by ${photographer}</p>` : ''}
        </td>
      </tr>` : ''}

      <!-- STORY BODY -->
      ${bodyParas.length > 0 ? `<tr>
        <td style="background:${CR};padding:28px 48px 0;" class="pd">
          ${bodyParas.map(p => `<p style="margin:0 0 20px;font-family:${SANS};font-size:16px;line-height:1.75;color:${D};">${p}</p>`).join('')}
        </td>
      </tr>` : ''}

      <!-- QUOTE -->
      ${quote ? `<tr>
        <td style="background:${CR};padding:40px 48px;" class="pd">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background:${WG};border-radius:16px;"><tr>
            <td style="padding:36px 32px 32px;">
              <div style="margin-bottom:12px;">
                <svg width="36" height="36" viewBox="0 0 48 48" fill="none" style="display:block;"><path d="M14 28c-2.2 0-4-1.8-4-4 0-6.6 5.4-12 12-12v4c-4.4 0-8 3.6-8 8h4c2.2 0 4 1.8 4 4s-1.8 4-4 4h-4zm20 0c-2.2 0-4-1.8-4-4 0-6.6 5.4-12 12-12v4c-4.4 0-8 3.6-8 8h4c2.2 0 4 1.8 4 4s-1.8 4-4 4h-4z" fill="${Y}"/></svg>
              </div>
              <p style="margin:0;font-family:${SERIF};font-size:22px;font-style:italic;line-height:1.45;color:${D};">${quote}</p>
              <p style="margin:16px 0 0;font-family:${SANS};font-size:12px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:${TL};">— ${name}</p>
            </td>
          </tr></table>
        </td>
      </tr>` : ''}

      <!-- TRANSITION -->
      <tr>
        <td style="background:${CR};padding:${quote ? '0' : '40px'} 48px;text-align:center;" class="pd">
          <p style="margin:0;font-family:${SERIF};font-size:24px;font-weight:700;line-height:1.3;color:${D};">
            That all ${hl('changed')}.
          </p>
        </td>
      </tr>

      <!-- IMPACT RIBBON -->
      <tr>
        <td style="background:${CR};padding:40px 0 0;">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background:${DD};"><tr>
            <td style="padding:36px 48px;" class="pd">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%"><tr>
                <td width="30%" style="text-align:center;">
                  <span style="font-family:${SERIF};font-size:36px;font-weight:700;color:${Y};line-height:1;display:block;">${roomCount}</span>
                  <span style="font-family:${SANS};font-size:11px;font-weight:600;color:rgba(255,255,255,0.6);text-transform:uppercase;letter-spacing:0.12em;display:block;margin-top:6px;">Room${roomCount !== 1 ? 's' : ''} Built</span>
                </td>
                <td width="5%"><div style="width:1px;height:36px;background:rgba(255,255,255,0.08);margin:0 auto;"></div></td>
                <td width="30%" style="text-align:center;">
                  <span style="font-family:${SERIF};font-size:36px;font-weight:700;color:${Y};line-height:1;display:block;">${partnerNames.length}</span>
                  <span style="font-family:${SANS};font-size:11px;font-weight:600;color:rgba(255,255,255,0.6);text-transform:uppercase;letter-spacing:0.12em;display:block;margin-top:6px;">Partners</span>
                </td>
                <td width="5%"><div style="width:1px;height:36px;background:rgba(255,255,255,0.08);margin:0 auto;"></div></td>
                <td width="30%" style="text-align:center;">
                  <span style="font-family:${SERIF};font-size:36px;font-weight:700;color:${Y};line-height:1;display:block;">1</span>
                  <span style="font-family:${SANS};font-size:11px;font-weight:600;color:rgba(255,255,255,0.6);text-transform:uppercase;letter-spacing:0.12em;display:block;margin-top:6px;">Dream</span>
                </td>
              </tr></table>
            </td>
          </tr></table>
        </td>
      </tr>

      <!-- WHAT WE BUILT -->
      ${roomTypes.length > 0 ? `<tr>
        <td style="background:${CR};padding:44px 48px 0;" class="pd">
          ${sLabel('What We Built', 'yellow')}
          <h2 class="h2m" style="margin:20px 0 8px;font-family:${SERIF};font-size:26px;font-weight:700;line-height:1.25;color:${D};letter-spacing:-0.01em;">
            ${roomTypes.length === 1 ? `One room, one ${hl('purpose')}` : roomTypes.length === 2 ? `Two rooms, one ${hl('purpose')}` : `${roomTypes.length} rooms, one ${hl('purpose')}`}
          </h2>
          <p style="margin:0 0 28px;font-family:${SANS};font-size:15px;line-height:1.7;color:${TM};">
            Safety, independence, and joy — at the center of every decision.
          </p>
        </td>
      </tr>
      ${roomTypes.map((type, i) => `<tr>
        <td style="background:${CR};padding:0 48px ${i < roomTypes.length - 1 ? '12px' : '0'};" class="pd">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%"><tr>
            <td style="padding:24px;background:${WG};border-radius:12px;">
              <span style="font-family:${SERIF};font-size:26px;font-weight:700;color:${BD};line-height:1;display:block;margin-bottom:6px;">${String(i + 1).padStart(2, '0')}</span>
              <p style="margin:0 0 6px;font-family:${SANS};font-size:16px;font-weight:700;color:${D};">${type}</p>
              <div style="width:32px;height:2px;background:${Y};margin-bottom:14px;"></div>
              <p style="margin:0;font-family:${SANS};font-size:14px;line-height:1.7;color:${TM};">${roomDescs[i]}</p>
            </td>
          </tr></table>
        </td>
      </tr>`).join('')}` : ''}

      <!-- THE TRANSFORMATION -->
      ${beforePhoto && afterPhoto ? `<tr>
        <td style="background:${CR};padding:40px 48px 0;" class="pd">
          ${sLabel('The Transformation')}
          <h2 class="h2m" style="margin:20px 0 24px;font-family:${SERIF};font-size:26px;font-weight:700;line-height:1.25;color:${D};">
            From struggle to ${hl('sunshine')}
          </h2>
        </td>
      </tr>
      <tr>
        <td style="background:${CR};padding:0 48px;" class="pd">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%"><tr>
            <td width="49%" class="st" valign="top">
              <p style="margin:0 0 8px;font-family:${SANS};font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.14em;color:${TL};">Before</p>
              <img src="${beforePhoto}" width="244" alt="${name}'s space before renovation" style="width:100%;border-radius:12px;display:block;" class="fl">
            </td>
            <td width="2%" class="hm">&nbsp;</td>
            <td width="49%" class="st mob-stack" valign="top">
              <p style="margin:0 0 8px;font-family:${SANS};font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.14em;color:${TL};">After</p>
              <img src="${afterPhoto}" width="244" alt="${name}'s beautiful new space" style="width:100%;border-radius:12px;display:block;" class="fl">
            </td>
          </tr></table>
        </td>
      </tr>` : ''}

      <!-- REVEAL PHOTO -->
      ${revealPhoto ? `<tr>
        <td style="background:${CR};padding:28px 24px 0;">
          <div style="border-radius:16px;overflow:hidden;box-shadow:0 16px 48px rgba(0,0,0,0.1);">
            <img src="${revealPhoto}" width="552" alt="${name} seeing their new room for the first time" style="width:100%;display:block;" class="fl" />
          </div>
          <p style="margin:10px 0 0;text-align:center;font-family:${SANS};font-size:12px;color:${TL};letter-spacing:0.02em;font-style:italic;">The big reveal — the moment everything changed</p>
        </td>
      </tr>` : ''}

      <!-- PRIMARY CTA -->
      <tr>
        <td style="background:${CR};padding:40px 48px 0;text-align:center;" class="pd">
          ${pillBtn(`See ${name}'s Full Story &rarr;`, profileUrl)}
        </td>
      </tr>

      <!-- PARTNERS -->
      ${partnerNames.length > 0 ? `<tr>
        <td style="background:${CR};padding:48px 0 0;">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background:${DD};"><tr>
            <td style="padding:44px 48px;" class="pd">
              ${sLabel('Our Partners', 'light')}
              <h2 class="h2m" style="margin:20px 0 12px;font-family:${SERIF};font-size:24px;font-weight:700;line-height:1.3;color:#fff;">
                Made possible by ${hl('incredible', 'dark')} partners
              </h2>
              <p style="margin:0 0 24px;font-family:${SANS};font-size:15px;line-height:1.7;color:rgba(255,255,255,0.6);">
                This project wouldn't exist without the generosity of partners who show up, project after project, with heart and hands ready to build.
              </p>
              <p style="margin:0;font-family:${SANS};font-size:13px;line-height:2.2;color:rgba(255,255,255,0.35);">${partnerList}</p>
            </td>
          </tr></table>
        </td>
      </tr>` : ''}

      <!-- IMPACT TIERS -->
      <tr>
        <td style="background:${CR};padding:48px 48px 0;" class="pd">
          ${sLabel('Your Impact', 'yellow')}
          <h2 class="h2m" style="margin:20px 0 8px;font-family:${SERIF};font-size:24px;font-weight:700;line-height:1.25;color:${D};">
            Every dollar has a ${hl('purpose')}
          </h2>
          <p style="margin:0 0 28px;font-family:${SANS};font-size:15px;line-height:1.7;color:${TM};">
            Families are on our waitlist right now. Your gift brings us closer to saying ${hl('yes')} to the next child.
          </p>
        </td>
      </tr>
      <tr>
        <td style="background:${CR};padding:0 48px 12px;" class="pd">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%"><tr>
            <td style="padding:28px;background:${D};border-radius:12px;text-align:center;">
              <span style="display:inline-block;padding:5px 14px;background:${Y};border-radius:100px;font-family:${SANS};font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:${D};margin-bottom:14px;">Most Popular</span>
              <p style="margin:0 0 4px;font-family:${SERIF};font-size:34px;font-weight:700;color:#fff;">$500</p>
              <p style="margin:0 0 8px;font-family:${SANS};font-size:14px;font-weight:600;color:${Y};">Furniture &amp; Flooring</p>
              <p style="margin:0 0 22px;font-family:${SANS};font-size:13px;line-height:1.6;color:rgba(255,255,255,0.55);">Adaptive furniture or accessible flooring — the structural pieces that change a child's daily life.</p>
              ${pillBtn('Give $500 &rarr;', ZEFFY_BASE + '?amount=500')}
            </td>
          </tr></table>
        </td>
      </tr>
      <tr>
        <td style="background:${CR};padding:0 48px;" class="pd">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%"><tr>
            <td width="49%" class="st" valign="top">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%"><tr>
                <td style="padding:22px;background:${WG};border-radius:12px;text-align:center;">
                  <p style="margin:0 0 2px;font-family:${SERIF};font-size:26px;font-weight:700;color:${D};">$60</p>
                  <p style="margin:0 0 8px;font-family:${SANS};font-size:13px;font-weight:600;color:${TM};">Paint &amp; Supplies</p>
                  <p style="margin:0 0 16px;font-family:${SANS};font-size:12px;line-height:1.6;color:${TL};">Transforms walls into a child's dream canvas.</p>
                  <a href="${ZEFFY_BASE}?amount=60" target="_blank" style="font-family:${SANS};font-size:13px;font-weight:600;color:${D};text-decoration:underline;text-underline-offset:3px;">Give $60 &rarr;</a>
                </td>
              </tr></table>
            </td>
            <td width="2%" class="hm">&nbsp;</td>
            <td width="49%" class="st mob-stack" valign="top">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%"><tr>
                <td style="padding:22px;background:${WG};border-radius:12px;text-align:center;">
                  <p style="margin:0 0 2px;font-family:${SERIF};font-size:26px;font-weight:700;color:${D};">$125</p>
                  <p style="margin:0 0 8px;font-family:${SANS};font-size:13px;font-weight:600;color:${TM};">Bedding &amp; Decor</p>
                  <p style="margin:0 0 16px;font-family:${SANS};font-size:12px;line-height:1.6;color:${TL};">The details that make a room feel like home.</p>
                  <a href="${ZEFFY_BASE}?amount=125" target="_blank" style="font-family:${SANS};font-size:13px;font-weight:600;color:${D};text-decoration:underline;text-underline-offset:3px;">Give $125 &rarr;</a>
                </td>
              </tr></table>
            </td>
          </tr></table>
        </td>
      </tr>

      <!-- TRUST SIGNALS -->
      <tr>
        <td style="background:${CR};padding:24px 48px 0;text-align:center;" class="pd">
          <p style="margin:0;font-family:${SANS};font-size:12px;color:${TL};">
            <span style="vertical-align:middle;display:inline-block;margin-right:4px;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" style="vertical-align:middle;"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" stroke="${TL}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="m9 12 2 2 4-4" stroke="${TL}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
            Tax-Deductible<span style="padding:0 10px;color:${BD};">&middot;</span>Zero Platform Fees<span style="padding:0 10px;color:${BD};">&middot;</span>501(c)(3)
          </p>
        </td>
      </tr>

      <!-- FOUNDER NOTE -->
      <tr>
        <td style="background:${CR};padding:40px 48px 0;" class="pd">
          <div style="height:1px;background:${BD};margin-bottom:36px;"></div>
          <p style="margin:0 0 20px;font-family:${SERIF};font-size:17px;font-style:italic;line-height:1.7;color:${D};">${founderNote}</p>
          <p style="margin:0 0 2px;font-family:${SANS};font-size:14px;font-weight:700;color:${D};">Peter &amp; Holly Ranney</p>
          <p style="margin:0;font-family:${SANS};font-size:13px;color:${TM};">Founders, Sunshine on a Ranney Day</p>
        </td>
      </tr>

      <!-- FINAL CTA -->
      <tr>
        <td style="background:${CR};padding:40px 48px 48px;text-align:center;" class="pd">
          ${pillBtn('Donate Now &rarr;', donateUrl, 'dark')}
        </td>
      </tr>

`;

  return emailHead(`${name}'s Dream Room is Complete`) + emailWrap(preheader, body);
}

// ─── KICKOFF HTML builder ────────────────────────────────────────

function buildKickoffHtml(kid, opts) {
  const name = kid.name;
  const slug = kid.slug;
  const age = Array.isArray(kid.age) ? kid.age.join(', ') : kid.age;
  const ageLabel = Array.isArray(kid.age) && kid.age.length > 1 ? 'Ages' : 'Age';
  const diagnosis = kid.diagnosis || '';
  const year = kid.year || new Date().getFullYear();
  const roomTypes = kid.roomTypes || [];
  const quote = kid.quote || null;
  const photos = kid.photos || [];

  const profileUrl = `${SITE_URL}/kids/${slug}`;
  const donateUrl = kid.fundraisingUrl || `${SITE_URL}/donate`;
  const roomLabel = roomTypes.join(' + ');

  const heroSrc = kid.heroImage || (photos[0] && photos[0].url) || '';
  const heroImg = heroSrc ? cfImg(heroSrc, 'w=1200,h=900,fit=cover,gravity=face,q=80') : '';

  const paras = kid.bio ? bioParagraphs(kid.bio) : [];
  const lede = paras[0] || '';
  const bodyParas = paras.slice(1, 3); // Keep it shorter for kickoff

  const headline = opts.headline || `Meet ${name}`;
  const preheader = opts.preheader || `Meet ${name} — our next dream room project. Here's their story and how you can help.`;
  const founderNote = opts.founderNote || `We can't wait to get started on ${name}'s project. With your help, we'll transform their space into something that changes daily life for ${name} and their entire family.`;

  const body = `<!-- HERO PHOTO -->
      ${heroImg ? `<tr>
        <td style="background:${CR};padding:0;">
          <a href="${profileUrl}" target="_blank" style="display:block;text-decoration:none;">
            <div style="margin:0 24px;border-radius:20px;overflow:hidden;box-shadow:0 24px 64px rgba(0,0,0,0.1),0 4px 16px rgba(0,0,0,0.06);">
              <img src="${heroImg}" width="552" alt="${name}" class="fl hero-img" style="width:100%;display:block;" />
            </div>
          </a>
        </td>
      </tr>` : ''}

      <!-- NAME PILL + BADGE -->
      <tr>
        <td style="background:${CR};padding:0 48px;" class="pd">
          <div style="margin-top:${heroImg ? '-22px' : '24px'};position:relative;z-index:2;">
            <table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr>
              <td style="padding:10px 22px;background:rgba(30,31,37,0.85);border-radius:100px;font-family:${SANS};font-size:13px;font-weight:600;color:#fff;letter-spacing:0.01em;">
                ${name}${age ? `, ${ageLabel.toLowerCase()} ${age}` : ''}
              </td>
              <td width="8"></td>
              <td style="padding:8px 16px;background:${Y};border-radius:100px;font-family:${SANS};font-size:11px;font-weight:700;color:${D};letter-spacing:0.08em;text-transform:uppercase;">
                Coming Soon
              </td>
            </tr></table>
          </div>
        </td>
      </tr>

      <!-- DETAIL CHIPS -->
      <tr>
        <td style="background:${CR};padding:16px 48px 0;" class="pd">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr>
            ${diagnosis ? `<td style="padding:7px 16px;background:${WG};border-radius:100px;font-family:${SANS};font-size:12px;color:${TL};"><span style="font-weight:400;">Diagnosis</span>&nbsp;&nbsp;<strong style="color:${D};">${diagnosis}</strong></td><td width="8"></td>` : ''}
            ${roomLabel ? `<td style="padding:7px 16px;background:${WG};border-radius:100px;font-family:${SANS};font-size:12px;color:${TL};"><span style="font-weight:400;">Rooms</span>&nbsp;&nbsp;<strong style="color:${D};">${roomLabel}</strong></td><td width="8"></td>` : ''}
            <td style="padding:7px 16px;background:${WG};border-radius:100px;font-family:${SANS};font-size:12px;color:${TL};"><span style="font-weight:400;">Year</span>&nbsp;&nbsp;<strong style="color:${D};">${year}</strong></td>
          </tr></table>
        </td>
      </tr>

      <!-- HEADLINE -->
      <tr>
        <td style="background:${CR};padding:32px 48px 0;" class="pd">
          ${sLabel('Introducing &middot; ' + year)}
          <h1 class="h1m" style="margin:20px 0 0;font-family:${SERIF};font-size:34px;font-weight:700;line-height:1.18;color:${D};letter-spacing:-0.025em;">
            ${headline}
          </h1>
        </td>
      </tr>

      <!-- LEDE -->
      ${lede ? `<tr>
        <td style="background:${CR};padding:24px 48px 0;" class="pd">
          <p style="margin:0;font-family:${SERIF};font-size:18px;line-height:1.7;color:${D};font-weight:400;">${lede}</p>
        </td>
      </tr>` : ''}

      <!-- STORY BODY -->
      ${bodyParas.length > 0 ? `<tr>
        <td style="background:${CR};padding:24px 48px 0;" class="pd">
          ${bodyParas.map(p => `<p style="margin:0 0 20px;font-family:${SANS};font-size:16px;line-height:1.75;color:${D};">${p}</p>`).join('')}
        </td>
      </tr>` : ''}

      <!-- QUOTE -->
      ${quote ? `<tr>
        <td style="background:${CR};padding:36px 48px;" class="pd">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background:${WG};border-radius:16px;"><tr>
            <td style="padding:36px 32px 32px;">
              <div style="margin-bottom:12px;">
                <svg width="36" height="36" viewBox="0 0 48 48" fill="none" style="display:block;"><path d="M14 28c-2.2 0-4-1.8-4-4 0-6.6 5.4-12 12-12v4c-4.4 0-8 3.6-8 8h4c2.2 0 4 1.8 4 4s-1.8 4-4 4h-4zm20 0c-2.2 0-4-1.8-4-4 0-6.6 5.4-12 12-12v4c-4.4 0-8 3.6-8 8h4c2.2 0 4 1.8 4 4s-1.8 4-4 4h-4z" fill="${Y}"/></svg>
              </div>
              <p style="margin:0;font-family:${SERIF};font-size:22px;font-style:italic;line-height:1.45;color:${D};">${quote}</p>
              <p style="margin:16px 0 0;font-family:${SANS};font-size:12px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:${TL};">— ${name}</p>
            </td>
          </tr></table>
        </td>
      </tr>` : ''}

      <!-- THE PLAN -->
      ${roomTypes.length > 0 ? `<tr>
        <td style="background:${CR};padding:${quote ? '0' : '36px'} 48px 0;" class="pd">
          ${sLabel('The Plan', 'yellow')}
          <h2 class="h2m" style="margin:20px 0 8px;font-family:${SERIF};font-size:26px;font-weight:700;line-height:1.25;color:${D};">
            What we're ${hl('building')}
          </h2>
          <p style="margin:0 0 28px;font-family:${SANS};font-size:15px;line-height:1.7;color:${TM};">
            Here's what ${name}'s renovation will include:
          </p>
        </td>
      </tr>
      ${roomTypes.map((type, i) => {
        const desc = ROOM_DESCRIPTIONS[type] || `A custom ${type.toLowerCase()} designed around ${name}'s unique needs.`;
        return `<tr>
        <td style="background:${CR};padding:0 48px ${i < roomTypes.length - 1 ? '12px' : '0'};" class="pd">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%"><tr>
            <td style="padding:24px;background:${WG};border-radius:12px;">
              <span style="font-family:${SERIF};font-size:26px;font-weight:700;color:${BD};line-height:1;display:block;margin-bottom:6px;">${String(i + 1).padStart(2, '0')}</span>
              <p style="margin:0 0 6px;font-family:${SANS};font-size:16px;font-weight:700;color:${D};">${type}</p>
              <div style="width:32px;height:2px;background:${Y};margin-bottom:14px;"></div>
              <p style="margin:0;font-family:${SANS};font-size:14px;line-height:1.7;color:${TM};">${desc}</p>
            </td>
          </tr></table>
        </td>
      </tr>`;
      }).join('')}` : ''}

      <!-- HOW TO HELP -->
      <tr>
        <td style="background:${CR};padding:44px 48px 0;" class="pd">
          ${sLabel('How You Can Help', 'yellow')}
          <h2 class="h2m" style="margin:20px 0 12px;font-family:${SERIF};font-size:26px;font-weight:700;line-height:1.25;color:${D};">
            Help us build ${name}'s ${hl('dream')}
          </h2>
          <p style="margin:0 0 28px;font-family:${SANS};font-size:15px;line-height:1.7;color:${TM};">
            Every dollar goes directly to materials, labor, and design for ${name}'s new space. Zero platform fees.
          </p>
        </td>
      </tr>

      <!-- DONATE CTA -->
      <tr>
        <td style="background:${CR};padding:0 48px;text-align:center;" class="pd">
          ${pillBtn(`Donate for ${name} &rarr;`, donateUrl)}
        </td>
      </tr>

      <!-- TRUST -->
      <tr>
        <td style="background:${CR};padding:24px 48px 0;text-align:center;" class="pd">
          <p style="margin:0;font-family:${SANS};font-size:12px;color:${TL};">
            <span style="vertical-align:middle;display:inline-block;margin-right:4px;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" style="vertical-align:middle;"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" stroke="${TL}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="m9 12 2 2 4-4" stroke="${TL}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
            Tax-Deductible<span style="padding:0 10px;color:${BD};">&middot;</span>Zero Platform Fees<span style="padding:0 10px;color:${BD};">&middot;</span>501(c)(3)
          </p>
        </td>
      </tr>

      <!-- FOUNDER NOTE -->
      <tr>
        <td style="background:${CR};padding:40px 48px 0;" class="pd">
          <div style="height:1px;background:${BD};margin-bottom:36px;"></div>
          <p style="margin:0 0 20px;font-family:${SERIF};font-size:17px;font-style:italic;line-height:1.7;color:${D};">${founderNote}</p>
          <p style="margin:0 0 2px;font-family:${SANS};font-size:14px;font-weight:700;color:${D};">Peter &amp; Holly Ranney</p>
          <p style="margin:0;font-family:${SANS};font-size:13px;color:${TM};">Founders, Sunshine on a Ranney Day</p>
        </td>
      </tr>

      <!-- FINAL CTA -->
      <tr>
        <td style="background:${CR};padding:40px 48px 48px;text-align:center;" class="pd">
          ${pillBtn(`See ${name}'s Story &rarr;`, profileUrl, 'dark')}
        </td>
      </tr>
`;

  return emailHead(`Meet ${name} — Our Next Project`) + emailWrap(preheader, body);
}

// ─── MONTHLY IMPACT HTML builder ─────────────────────────────────

function buildMonthlyHtml(data, opts) {
  const { month, totalKids, totalRooms, years } = data;
  const reveal = data.recentReveal || null;
  const current = data.currentProject || null;
  const events = data.upcomingEvents || [];
  const founderNote = data.founderNote || `Another month of building dreams. Thank you for being part of the SOARD family — none of this happens without you.`;

  const preheader = opts.preheader || `Your ${month} SOARD update: ${totalRooms}+ rooms built, ${totalKids}+ kids served, and we're just getting started.`;
  const donateUrl = `${SITE_URL}/donate`;

  const body = `<!-- IMPACT RIBBON -->
      <tr>
        <td style="background:${DD};padding:40px 48px;" class="pd">
          <p style="margin:0 0 20px;font-family:${SANS};font-size:12px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:rgba(255,255,255,0.5);">${month} Update</p>
          <h1 class="h1m" style="margin:0 0 8px;font-family:${SERIF};font-size:30px;font-weight:700;line-height:1.2;color:#fff;">
            Building dreams, changing ${hl('lives', 'dark')}
          </h1>
          <p style="margin:0;font-family:${SANS};font-size:15px;line-height:1.7;color:rgba(255,255,255,0.6);">
            Here's what your support made possible this month.
          </p>
        </td>
      </tr>

      <!-- STATS -->
      <tr>
        <td style="background:${CR};padding:40px 48px;" class="pd">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%"><tr>
            <td width="30%" style="text-align:center;">
              <span style="font-family:${SERIF};font-size:36px;font-weight:700;color:${D};line-height:1;display:block;">${totalRooms}+</span>
              <span style="font-family:${SANS};font-size:11px;font-weight:600;color:${TM};text-transform:uppercase;letter-spacing:0.12em;display:block;margin-top:6px;">Rooms Built</span>
            </td>
            <td width="5%"><div style="width:1px;height:36px;background:${BD};margin:0 auto;"></div></td>
            <td width="30%" style="text-align:center;">
              <span style="font-family:${SERIF};font-size:36px;font-weight:700;color:${D};line-height:1;display:block;">${totalKids}+</span>
              <span style="font-family:${SANS};font-size:11px;font-weight:600;color:${TM};text-transform:uppercase;letter-spacing:0.12em;display:block;margin-top:6px;">Kids Served</span>
            </td>
            <td width="5%"><div style="width:1px;height:36px;background:${BD};margin:0 auto;"></div></td>
            <td width="30%" style="text-align:center;">
              <span style="font-family:${SERIF};font-size:36px;font-weight:700;color:${D};line-height:1;display:block;">${years}</span>
              <span style="font-family:${SANS};font-size:11px;font-weight:600;color:${TM};text-transform:uppercase;letter-spacing:0.12em;display:block;margin-top:6px;">Years of Impact</span>
            </td>
          </tr></table>
        </td>
      </tr>

      ${reveal ? `<!-- RECENT REVEAL -->
      <tr>
        <td style="background:${CR};padding:0 48px;" class="pd">
          ${sLabel('Recently Completed', 'yellow')}
          <h2 class="h2m" style="margin:20px 0 20px;font-family:${SERIF};font-size:24px;font-weight:700;line-height:1.25;color:${D};">
            ${reveal.name}'s room is ${hl('complete')}
          </h2>
        </td>
      </tr>
      <tr>
        <td style="background:${CR};padding:0 48px;" class="pd">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.06);"><tr>
            ${reveal.heroImage ? `<td width="40%" valign="top" class="st">
              <img src="${cfImg(reveal.heroImage, 'w=500,h=400,fit=cover,gravity=face,q=75')}" width="200" alt="${reveal.name}" style="width:100%;height:auto;display:block;" class="fl" />
            </td>` : ''}
            <td ${reveal.heroImage ? '' : 'width="100%"'} valign="middle" style="padding:24px 28px;" class="st">
              <p style="margin:0 0 4px;font-family:${SANS};font-size:16px;font-weight:700;color:${D};">${reveal.name}</p>
              ${reveal.diagnosis ? `<p style="margin:0 0 8px;font-family:${SANS};font-size:13px;color:${TM};">${reveal.diagnosis}</p>` : ''}
              ${reveal.roomTypes ? `<p style="margin:0 0 16px;font-family:${SANS};font-size:12px;color:${TL};">${reveal.roomTypes.join(' &amp; ')}</p>` : ''}
              <a href="${SITE_URL}/kids/${reveal.slug}" target="_blank" style="font-family:${SANS};font-size:14px;font-weight:600;color:${D};text-decoration:underline;text-underline-offset:3px;">Read ${reveal.name}'s story &rarr;</a>
            </td>
          </tr></table>
        </td>
      </tr>` : ''}

      ${current ? `<!-- CURRENT PROJECT -->
      <tr>
        <td style="background:${CR};padding:${reveal ? '36px' : '0'} 48px 0;" class="pd">
          ${sLabel('In Progress')}
          <h2 class="h2m" style="margin:20px 0 20px;font-family:${SERIF};font-size:24px;font-weight:700;line-height:1.25;color:${D};">
            Up next: ${current.name}'s ${hl('dream room')}
          </h2>
        </td>
      </tr>
      <tr>
        <td style="background:${CR};padding:0 48px;" class="pd">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.06);"><tr>
            ${current.heroImage ? `<td width="40%" valign="top" class="st">
              <img src="${cfImg(current.heroImage, 'w=500,h=400,fit=cover,gravity=face,q=75')}" width="200" alt="${current.name}" style="width:100%;height:auto;display:block;" class="fl" />
            </td>` : ''}
            <td ${current.heroImage ? '' : 'width="100%"'} valign="middle" style="padding:24px 28px;" class="st">
              <p style="margin:0 0 4px;font-family:${SANS};font-size:16px;font-weight:700;color:${D};">${current.name}</p>
              ${current.diagnosis ? `<p style="margin:0 0 8px;font-family:${SANS};font-size:13px;color:${TM};">${current.diagnosis}</p>` : ''}
              ${current.roomTypes ? `<p style="margin:0 0 16px;font-family:${SANS};font-size:12px;color:${TL};">${current.roomTypes.join(' &amp; ')}</p>` : ''}
              <a href="${SITE_URL}/kids/${current.slug}" target="_blank" style="font-family:${SANS};font-size:14px;font-weight:600;color:${D};text-decoration:underline;text-underline-offset:3px;">Meet ${current.name} &rarr;</a>
            </td>
          </tr></table>
        </td>
      </tr>` : ''}

      ${events.length > 0 ? `<!-- UPCOMING EVENTS -->
      <tr>
        <td style="background:${CR};padding:36px 48px 0;" class="pd">
          ${sLabel('Upcoming Events')}
          <h2 class="h2m" style="margin:20px 0 20px;font-family:${SERIF};font-size:24px;font-weight:700;line-height:1.25;color:${D};">
            Mark your ${hl('calendar')}
          </h2>
        </td>
      </tr>
      ${events.map(ev => `<tr>
        <td style="background:${CR};padding:0 48px 12px;" class="pd">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%"><tr>
            <td style="padding:20px 24px;background:${WG};border-radius:12px;">
              <p style="margin:0 0 4px;font-family:${SANS};font-size:15px;font-weight:700;color:${D};">${ev.name}</p>
              <p style="margin:0 0 8px;font-family:${SANS};font-size:13px;color:${TM};">${ev.date}</p>
              ${ev.url ? `<a href="${ev.url}" target="_blank" style="font-family:${SANS};font-size:13px;font-weight:600;color:${D};text-decoration:underline;text-underline-offset:3px;">Learn more &rarr;</a>` : ''}
            </td>
          </tr></table>
        </td>
      </tr>`).join('')}` : ''}

      <!-- DONATE CTA -->
      <tr>
        <td style="background:${CR};padding:36px 48px 0;" class="pd">
          <div style="height:1px;background:${BD};margin-bottom:36px;"></div>
          <h2 class="h2m" style="margin:0 0 12px;font-family:${SERIF};font-size:22px;font-weight:700;line-height:1.3;color:${D};text-align:center;">
            Help us build the ${hl('next')} dream room
          </h2>
          <p style="margin:0 0 28px;font-family:${SANS};font-size:15px;line-height:1.65;color:${TM};text-align:center;">
            Every dollar goes directly to building life-changing spaces — at no cost to families.
          </p>
          <div style="text-align:center;">
            ${pillBtn('Donate Now &rarr;', donateUrl)}
          </div>
        </td>
      </tr>

      <!-- FOUNDER NOTE -->
      <tr>
        <td style="background:${CR};padding:40px 48px 0;" class="pd">
          <div style="height:1px;background:${BD};margin-bottom:36px;"></div>
          <p style="margin:0 0 20px;font-family:${SERIF};font-size:17px;font-style:italic;line-height:1.7;color:${D};">${founderNote}</p>
          <p style="margin:0 0 2px;font-family:${SANS};font-size:14px;font-weight:700;color:${D};">Peter &amp; Holly Ranney</p>
          <p style="margin:0;font-family:${SANS};font-size:13px;color:${TM};">Founders, Sunshine on a Ranney Day</p>
        </td>
      </tr>

      <!-- SPACER -->
      <tr><td style="background:${CR};padding:24px 0;"></td></tr>
`;

  return emailHead(`SOARD ${month} Update`) + emailWrap(preheader, body);
}
