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
// CUSTOM — Block-based composer (only template type)
// ═══════════════════════════════════════════════════════════════════

/**
 * @param {object} blockData
 * @param {object[]} blockData.blocks — Array of block descriptors
 * @param {object} [opts]
 * @param {string} [opts.subject]
 * @param {string} [opts.preheader]
 * @param {string} [opts.from]
 */
export function customTemplate(blockData, opts = {}) {
  const blocks = (blockData && blockData.blocks) || [];
  const subject = opts.subject || 'A note from Sunshine on a Ranney Day';
  const preheader = opts.preheader || '';
  const body = blocks.map(b => renderBlock(b)).filter(Boolean).join('\n');
  return {
    from: opts.from || FROM,
    subject,
    html: emailHead(subject) + emailWrap(preheader, body),
  };
}

// ─── Markdown-lite parser ──────────────────────────────────────────
// Safe inline-only subset: **bold**, *italic*, [text](url). Newlines
// collapse into <br>; double-newline starts a new <p>. HTML in the
// input is fully escaped — nothing else can sneak through.

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(s) {
  return escapeHtml(s);
}

function inlineMd(text) {
  let s = escapeHtml(text || '');
  // [text](url)
  s = s.replace(/\[([^\]]+)\]\((https?:[^\s)]+)\)/g,
    `<a href="$2" target="_blank" style="color:${D};text-decoration:underline;text-underline-offset:2px;">$1</a>`);
  // **bold**
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  // *italic* — only single asterisks not adjacent to another asterisk
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  return s;
}

function paragraphMd(text, paraStyle) {
  const blocks = String(text || '').split(/\n{2,}/).map(p => p.trim()).filter(Boolean);
  return blocks
    .map(p => `<p style="${paraStyle}">${inlineMd(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

// ─── Block renderers ───────────────────────────────────────────────

const BLOCKS = {
  hero(p) {
    const src = p.src || '';
    if (!src) return '';
    const url = src.startsWith('http') ? cfImg(src, 'w=1200,fit=cover,q=80') : src;
    const alt = escapeAttr(p.alt || '');
    const inner = `<div style="border-radius:${p.rounded === false ? '0' : '20px'};overflow:hidden;${p.shadow !== false ? 'box-shadow:0 24px 64px rgba(0,0,0,0.1),0 4px 16px rgba(0,0,0,0.06);' : ''}"><img src="${url}" width="${p.fullBleed ? '600' : '552'}" alt="${alt}" class="fl hero-img" style="width:100%;display:block;" /></div>`;
    const wrap = p.link
      ? `<a href="${escapeAttr(p.link)}" target="_blank" style="display:block;text-decoration:none;">${inner}</a>`
      : inner;
    const sidePad = p.fullBleed ? '0' : '24px';
    return `<tr><td style="background:${CR};padding:0 ${sidePad};">${wrap}</td></tr>`;
  },

  headline(p) {
    const text = inlineMd(p.text || '');
    const align = p.align || 'left';
    const size = p.size === 'small' ? 26 : p.size === 'medium' ? 30 : 34;
    const mobileClass = size >= 30 ? 'h1m' : 'h2m';
    return `<tr>
      <td style="background:${CR};padding:32px 48px 0;text-align:${align};" class="pd">
        <h1 class="${mobileClass}" style="margin:0;font-family:${SERIF};font-size:${size}px;font-weight:700;line-height:1.18;color:${D};letter-spacing:-0.02em;">${text}</h1>
      </td></tr>`;
  },

  subheadline(p) {
    const text = inlineMd(p.text || '');
    const align = p.align || 'left';
    return `<tr>
      <td style="background:${CR};padding:24px 48px 0;text-align:${align};" class="pd">
        <h2 class="h2m" style="margin:0;font-family:${SERIF};font-size:22px;font-weight:700;line-height:1.3;color:${D};">${text}</h2>
      </td></tr>`;
  },

  sectionLabel(p) {
    const variant = p.variant === 'yellow' ? 'yellow' : p.variant === 'light' ? 'light' : 'dark';
    return `<tr>
      <td style="background:${variant === 'light' ? DD : CR};padding:32px 48px 0;" class="pd">
        ${sLabel(escapeHtml(p.text || ''), variant)}
      </td></tr>`;
  },

  paragraph(p) {
    const align = p.align || 'left';
    const isLede = p.style === 'lede';
    const family = isLede ? SERIF : SANS;
    const size = isLede ? 18 : (p.size === 'small' ? 14 : 16);
    const lh = isLede ? 1.7 : 1.75;
    const color = p.muted ? TM : D;
    const paraStyle = `margin:0 0 16px;font-family:${family};font-size:${size}px;line-height:${lh};color:${color};text-align:${align};`;
    const html = paragraphMd(p.text || '', paraStyle);
    if (!html) return '';
    return `<tr>
      <td style="background:${CR};padding:20px 48px 0;" class="pd">${html.replace(/<p style="([^"]+)margin:0 0 16px;/, '<p style="$1margin:0;')}</td>
    </tr>`;
  },

  button(p) {
    const label = inlineMd(p.label || 'Donate Now');
    const href = escapeAttr(p.href || `${SITE_URL}/donate`);
    const variant = p.variant === 'dark' ? 'dark' : 'primary';
    const align = p.align || 'center';
    return `<tr>
      <td style="background:${CR};padding:28px 48px 0;text-align:${align};" class="pd">
        ${pillBtn(label, href, variant)}
      </td></tr>`;
  },

  kidCard(p) {
    const k = p.kid;
    if (!k || !k.name) return '';
    const slug = k.slug || '';
    const profileUrl = `${SITE_URL}/kids/${slug}`;
    const heroSrc = k.heroImage || (k.photos && k.photos[0] && k.photos[0].url) || '';
    const heroImg = heroSrc ? cfImg(heroSrc, 'w=600,h=400,fit=cover,gravity=face,q=80') : '';
    const ageLabel = Array.isArray(k.age) && k.age.length > 1 ? 'Ages' : 'Age';
    const ageStr = Array.isArray(k.age) ? k.age.join(', ') : k.age;
    const diagnosis = k.diagnosis ? `<p style="margin:0 0 6px;font-family:${SANS};font-size:13px;color:${TM};"><strong style="color:${D};font-weight:600;">${escapeHtml(k.diagnosis)}</strong></p>` : '';
    const rooms = (k.roomTypes || []).map(t => `<span style="display:inline-block;padding:4px 10px;margin:0 4px 4px 0;background:${WG};border-radius:100px;font-family:${SANS};font-size:11px;font-weight:600;color:${TM};">${escapeHtml(t)}</span>`).join('');
    const labelText = p.label || (k.status === 'completed' ? 'Project Reveal' : 'Coming Soon');
    return `<tr>
      <td style="background:${CR};padding:24px 48px 0;" class="pd">
        ${sLabel(labelText)}
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin-top:16px;background:${WG};border-radius:14px;overflow:hidden;"><tr>
          ${heroImg ? `<td width="40%" class="st" valign="top" style="vertical-align:top;">
            <a href="${profileUrl}" target="_blank" style="display:block;"><img src="${heroImg}" width="220" alt="${escapeAttr(k.name)}" class="fl" style="width:100%;display:block;" /></a>
          </td>` : ''}
          <td class="st" valign="top" style="padding:20px 22px;">
            <p style="margin:0 0 6px;font-family:${SERIF};font-size:20px;font-weight:700;color:${D};line-height:1.2;">${escapeHtml(k.name)}${ageStr ? `<span style="font-family:${SANS};font-size:13px;font-weight:400;color:${TM};">, ${ageLabel.toLowerCase()} ${escapeHtml(ageStr)}</span>` : ''}</p>
            ${diagnosis}
            ${rooms ? `<div style="margin:8px 0 12px;">${rooms}</div>` : ''}
            <a href="${profileUrl}" target="_blank" style="font-family:${SANS};font-size:13px;font-weight:600;color:${D};text-decoration:underline;text-underline-offset:3px;">${escapeHtml(p.linkLabel || `See ${k.name}'s story`)} &rarr;</a>
          </td>
        </tr></table>
      </td></tr>`;
  },

  stats(p) {
    const items = (p.items || []).slice(0, 3);
    if (!items.length) return '';
    const cols = items.map((it, i) => `
      ${i > 0 ? `<td width="5%"><div style="width:1px;height:36px;background:rgba(255,255,255,0.08);margin:0 auto;"></div></td>` : ''}
      <td width="${items.length === 3 ? '30%' : '47%'}" style="text-align:center;">
        <span style="font-family:${SERIF};font-size:36px;font-weight:700;color:${Y};line-height:1;display:block;">${escapeHtml(String(it.value))}</span>
        <span style="font-family:${SANS};font-size:11px;font-weight:600;color:rgba(255,255,255,0.6);text-transform:uppercase;letter-spacing:0.12em;display:block;margin-top:6px;">${escapeHtml(it.label || '')}</span>
      </td>
    `).join('');
    return `<tr>
      <td style="background:${CR};padding:32px 0 0;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background:${DD};"><tr>
          <td style="padding:36px 48px;" class="pd">
            <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%"><tr>${cols}</tr></table>
          </td>
        </tr></table>
      </td></tr>`;
  },

  photo(p) {
    const src = p.src || '';
    if (!src) return '';
    const url = src.startsWith('http') ? cfImg(src, 'w=1100,fit=cover,q=80') : src;
    const caption = p.caption ? `<p style="margin:10px 0 0;text-align:center;font-family:${SANS};font-size:12px;color:${TL};letter-spacing:0.02em;font-style:italic;">${escapeHtml(p.caption)}</p>` : '';
    return `<tr>
      <td style="background:${CR};padding:24px 48px 0;" class="pd">
        <img src="${url}" width="552" alt="${escapeAttr(p.alt || '')}" class="fl" style="width:100%;border-radius:12px;display:block;" />
        ${caption}
      </td></tr>`;
  },

  photoGrid(p) {
    const items = (p.items || []).filter(i => i.src).slice(0, 3);
    if (items.length < 2) return '';
    const cols = items.length === 3 ? items : items.slice(0, 2);
    const colW = Math.floor(94 / cols.length);
    const cells = cols.map((it, i) => {
      const url = it.src.startsWith('http') ? cfImg(it.src, 'w=500,fit=cover,q=75') : it.src;
      return `${i > 0 ? `<td width="2%" class="hm">&nbsp;</td>` : ''}
        <td width="${colW}%" class="st ${i > 0 ? 'mob-stack' : ''}" valign="top">
          <img src="${url}" width="244" alt="${escapeAttr(it.alt || '')}" class="fl" style="width:100%;border-radius:12px;display:block;" />
          ${it.caption ? `<p style="margin:8px 0 0;font-family:${SANS};font-size:11px;color:${TL};letter-spacing:0.02em;">${escapeHtml(it.caption)}</p>` : ''}
        </td>`;
    }).join('');
    return `<tr>
      <td style="background:${CR};padding:24px 48px 0;" class="pd">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%"><tr>${cells}</tr></table>
      </td></tr>`;
  },

  quote(p) {
    const text = inlineMd(p.text || '');
    const cite = p.cite ? `<p style="margin:16px 0 0;font-family:${SANS};font-size:12px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:${TL};">— ${escapeHtml(p.cite)}</p>` : '';
    return `<tr>
      <td style="background:${CR};padding:32px 48px 0;" class="pd">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background:${WG};border-radius:16px;"><tr>
          <td style="padding:32px;">
            <div style="margin-bottom:12px;">
              <svg width="32" height="32" viewBox="0 0 48 48" fill="none" style="display:block;"><path d="M14 28c-2.2 0-4-1.8-4-4 0-6.6 5.4-12 12-12v4c-4.4 0-8 3.6-8 8h4c2.2 0 4 1.8 4 4s-1.8 4-4 4h-4zm20 0c-2.2 0-4-1.8-4-4 0-6.6 5.4-12 12-12v4c-4.4 0-8 3.6-8 8h4c2.2 0 4 1.8 4 4s-1.8 4-4 4h-4z" fill="${Y}"/></svg>
            </div>
            <p style="margin:0;font-family:${SERIF};font-size:20px;font-style:italic;line-height:1.5;color:${D};">${text}</p>
            ${cite}
          </td></tr></table>
      </td></tr>`;
  },

  divider(p) {
    return `<tr>
      <td style="background:${CR};padding:${p.size === 'large' ? '40' : '24'}px 48px;" class="pd">
        <div style="height:1px;background:${BD};"></div>
      </td></tr>`;
  },

  signature(p) {
    const note = inlineMd(p.note || '');
    const from = escapeHtml(p.from || 'Peter & Holly Ranney');
    const title = escapeHtml(p.title || 'Founders, Sunshine on a Ranney Day');
    return `<tr>
      <td style="background:${CR};padding:32px 48px 0;" class="pd">
        <div style="height:1px;background:${BD};margin-bottom:28px;"></div>
        ${note ? `<p style="margin:0 0 18px;font-family:${SERIF};font-size:17px;font-style:italic;line-height:1.7;color:${D};">${note}</p>` : ''}
        <p style="margin:0 0 2px;font-family:${SANS};font-size:14px;font-weight:700;color:${D};">${from}</p>
        <p style="margin:0;font-family:${SANS};font-size:13px;color:${TM};">${title}</p>
      </td></tr>`;
  },

  spacer(p) {
    const h = Math.max(8, Math.min(96, parseInt(p.height, 10) || 24));
    return `<tr><td style="background:${CR};padding:${h}px 0;line-height:0;font-size:0;">&nbsp;</td></tr>`;
  },

  eventCard(p) {
    const name = escapeHtml(p.name || 'Upcoming Event');
    const date = p.date ? escapeHtml(p.date) : '';
    const url = escapeAttr(p.url || `${SITE_URL}/events`);
    const desc = p.description ? `<p style="margin:6px 0 0;font-family:${SANS};font-size:13px;line-height:1.6;color:${TM};">${escapeHtml(p.description)}</p>` : '';
    return `<tr>
      <td style="background:${CR};padding:16px 48px 0;" class="pd">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%"><tr>
          <td style="padding:18px 22px;background:${WG};border-radius:12px;border-left:3px solid ${Y};">
            <p style="margin:0 0 2px;font-family:${SANS};font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.12em;color:${TL};">${date || 'Save the date'}</p>
            <p style="margin:0;font-family:${SERIF};font-size:18px;font-weight:700;color:${D};line-height:1.3;"><a href="${url}" target="_blank" style="color:${D};text-decoration:none;">${name} &rarr;</a></p>
            ${desc}
          </td></tr></table>
      </td></tr>`;
  },
};

function renderBlock(b) {
  if (!b || !b.type) return '';
  const fn = BLOCKS[b.type];
  if (!fn) return '';
  try {
    return fn(b.props || b) || '';
  } catch (e) {
    console.error(`Block render error (${b.type}):`, e);
    return '';
  }
}

// Expose the list of available block types so the admin can render a palette.
export const BLOCK_TYPES = Object.keys(BLOCKS);
