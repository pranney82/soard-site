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

// Display-class markdown — same as inlineMd but renders *italic* with the
// brand's yellow highlight bar (used in headlines, transition lines, and
// partner-section heads). Body copy keeps plain italic via inlineMd().
function displayMd(text, variant = 'light') {
  let s = escapeHtml(text || '');
  s = s.replace(/\[([^\]]+)\]\((https?:[^\s)]+)\)/g,
    `<a href="$2" target="_blank" style="color:${D};text-decoration:underline;text-underline-offset:2px;">$1</a>`);
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  const bg = variant === 'dark' ? YG : YS;
  s = s.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g,
    `$1<em style="font-style:italic;background-image:linear-gradient(transparent 55%,${bg} 55%);background-repeat:no-repeat;background-size:100% 100%;padding:0 .1em;">$2</em>`);
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
    const text = displayMd(p.text || '');
    const align = p.align || 'left';
    const size = p.size === 'small' ? 26 : p.size === 'medium' ? 30 : 34;
    const mobileClass = size >= 30 ? 'h1m' : 'h2m';
    return `<tr>
      <td style="background:${CR};padding:32px 48px 0;text-align:${align};" class="pd">
        <h1 class="${mobileClass}" style="margin:0;font-family:${SERIF};font-size:${size}px;font-weight:700;line-height:1.18;color:${D};letter-spacing:-0.02em;">${text}</h1>
      </td></tr>`;
  },

  subheadline(p) {
    const text = displayMd(p.text || '');
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
    if (p.variant === 'reveal') {
      return `<tr>
        <td style="background:${CR};padding:24px 24px 0;">
          <div style="border-radius:16px;overflow:hidden;box-shadow:0 16px 48px rgba(0,0,0,0.1);">
            <img src="${url}" width="552" alt="${escapeAttr(p.alt || '')}" class="fl" style="width:100%;display:block;" />
          </div>
          ${caption}
        </td></tr>`;
    }
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
      <td style="background:${CR};padding:40px 48px 0;" class="pd">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background:${WG};border-radius:16px;"><tr>
          <td style="padding:36px 32px 32px;">
            <div style="margin-bottom:12px;">
              <svg width="36" height="36" viewBox="0 0 48 48" fill="none" style="display:block;"><path d="M14 28c-2.2 0-4-1.8-4-4 0-6.6 5.4-12 12-12v4c-4.4 0-8 3.6-8 8h4c2.2 0 4 1.8 4 4s-1.8 4-4 4h-4zm20 0c-2.2 0-4-1.8-4-4 0-6.6 5.4-12 12-12v4c-4.4 0-8 3.6-8 8h4c2.2 0 4 1.8 4 4s-1.8 4-4 4h-4z" fill="${Y}"/></svg>
            </div>
            <p style="margin:0;font-family:${SERIF};font-size:22px;font-style:italic;line-height:1.45;color:${D};">${text}</p>
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
    // Team line falls back to "Sunshine Team" when not explicitly set.
    // Pass team:"" (empty string) to suppress.
    const team = p.team === undefined ? 'Sunshine Team' : p.team;
    const teamHtml = team ? `<p style="margin:2px 0 0;font-family:${SANS};font-size:14px;font-weight:600;color:${D};">${escapeHtml(team)}</p>` : '';
    const title = escapeHtml(p.title || 'Founders, Sunshine on a Ranney Day');
    return `<tr>
      <td style="background:${CR};padding:32px 48px 0;" class="pd">
        <div style="height:1px;background:${BD};margin-bottom:28px;"></div>
        ${note ? `<p style="margin:0 0 18px;font-family:${SERIF};font-size:17px;font-style:italic;line-height:1.7;color:${D};">${note}</p>` : ''}
        <p style="margin:0;font-family:${SANS};font-size:14px;font-weight:700;color:${D};">${from}</p>
        ${teamHtml}
        <p style="margin:6px 0 0;font-family:${SANS};font-size:13px;color:${TM};">${title}</p>
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

  // Hero photo with floating name pill + optional status badge
  // Used for kid project announcements (kickoff, reveal)
  heroPortrait(p) {
    const src = p.src || '';
    if (!src) return '';
    const url = src.startsWith('http') ? cfImg(src, 'w=1200,h=900,fit=cover,gravity=face,q=80') : src;
    const alt = escapeAttr(p.alt || '');
    const link = escapeAttr(p.link || '');
    const inner = `<div style="border-radius:20px;overflow:hidden;box-shadow:0 24px 64px rgba(0,0,0,0.1),0 4px 16px rgba(0,0,0,0.06);"><img src="${url}" width="552" alt="${alt}" class="fl hero-img" style="width:100%;display:block;" /></div>`;
    const wrap = link ? `<a href="${link}" target="_blank" style="display:block;text-decoration:none;">${inner}</a>` : inner;

    const namePill = p.name ? `<td style="padding:10px 22px;background:rgba(30,31,37,0.85);border-radius:100px;font-family:${SANS};font-size:13px;font-weight:600;color:#fff;letter-spacing:0.01em;">${escapeHtml(p.name)}${p.age ? `, age ${escapeHtml(String(p.age))}` : ''}</td>` : '';
    const badgeBg = p.badgeVariant === 'dark' ? D : Y;
    const badgeColor = p.badgeVariant === 'dark' ? Y : D;
    const badgePill = p.badge ? `<td width="8"></td><td style="padding:8px 16px;background:${badgeBg};border-radius:100px;font-family:${SANS};font-size:11px;font-weight:700;color:${badgeColor};letter-spacing:0.08em;text-transform:uppercase;">${escapeHtml(p.badge)}</td>` : '';
    const overlay = (namePill || badgePill) ? `
      <tr><td style="background:${CR};padding:0 48px;" class="pd">
        <div style="margin-top:-22px;position:relative;z-index:2;">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr>
            ${namePill}${badgePill}
          </tr></table>
        </div>
      </td></tr>` : '';

    return `<tr><td style="background:${CR};padding:0 24px;">${wrap}</td></tr>${overlay}`;
  },

  // Row of detail chips (Diagnosis, Rooms, Year, etc) — auto-wraps on mobile
  detailChips(p) {
    const items = (p.items || []).filter(i => i.value);
    if (!items.length) return '';
    const cells = items.map((it, i) => `${i > 0 ? '<td width="8" class="hm">&nbsp;</td>' : ''}<td class="st" valign="top" style="padding-bottom:8px;"><table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr><td style="padding:7px 16px;background:${WG};border-radius:100px;font-family:${SANS};font-size:12px;color:${TL};">${it.label ? `<span style="font-weight:400;">${escapeHtml(it.label)}</span>&nbsp;&nbsp;` : ''}<strong style="color:${D};">${escapeHtml(it.value)}</strong></td></tr></table></td>`).join('');
    return `<tr>
      <td style="background:${CR};padding:16px 48px 0;" class="pd">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr>${cells}</tr></table>
      </td></tr>`;
  },

  // Numbered editorial card (01, 02, ...) with serif numeral, yellow underline, body
  // Used for "What we built" sections
  numberedCard(p) {
    const number = escapeHtml(p.number || '01');
    const title = escapeHtml(p.title || '');
    const body = inlineMd(p.body || '');
    return `<tr>
      <td style="background:${CR};padding:0 48px 12px;" class="pd">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%"><tr>
          <td style="padding:24px;background:${WG};border-radius:12px;">
            <span style="font-family:${SERIF};font-size:26px;font-weight:700;color:${BD};line-height:1;display:block;margin-bottom:6px;">${number}</span>
            ${title ? `<p style="margin:0 0 6px;font-family:${SANS};font-size:16px;font-weight:700;color:${D};">${title}</p>` : ''}
            <div style="width:32px;height:2px;background:${Y};margin-bottom:14px;"></div>
            ${body ? `<p style="margin:0;font-family:${SANS};font-size:14px;line-height:1.7;color:${TM};">${body}</p>` : ''}
          </td>
        </tr></table>
      </td></tr>`;
  },

  // Side-by-side before/after photos with eyebrow labels
  beforeAfter(p) {
    const before = p.before || {};
    const after = p.after || {};
    if (!before.src || !after.src) return '';
    const beforeUrl = before.src.startsWith('http') ? cfImg(before.src, 'w=560,fit=cover,q=70') : before.src;
    const afterUrl = after.src.startsWith('http') ? cfImg(after.src, 'w=560,fit=cover,q=70') : after.src;
    const eyebrow = `font-family:${SANS};font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.14em;color:${TL};`;
    return `<tr>
      <td style="background:${CR};padding:24px 48px 0;" class="pd">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%"><tr>
          <td width="49%" class="st" valign="top">
            <p style="margin:0 0 8px;${eyebrow}">${escapeHtml(p.beforeLabel || 'Before')}</p>
            <img src="${beforeUrl}" width="244" alt="${escapeAttr(before.alt || 'Before')}" class="fl" style="width:100%;border-radius:12px;display:block;" />
          </td>
          <td width="2%" class="hm">&nbsp;</td>
          <td width="49%" class="st mob-stack" valign="top">
            <p style="margin:0 0 8px;${eyebrow}">${escapeHtml(p.afterLabel || 'After')}</p>
            <img src="${afterUrl}" width="244" alt="${escapeAttr(after.alt || 'After')}" class="fl" style="width:100%;border-radius:12px;display:block;" />
          </td>
        </tr></table>
      </td></tr>`;
  },

  // Centered transition line — single phrase with yellow highlight on key word
  // e.g. "That all *changed*."
  transitionLine(p) {
    const text = displayMd(p.text || '');
    if (!text) return '';
    return `<tr>
      <td style="background:${CR};padding:32px 48px;text-align:center;" class="pd">
        <p style="margin:0;font-family:${SERIF};font-size:24px;font-weight:700;line-height:1.3;color:${D};">${text}</p>
      </td></tr>`;
  },

  // Donation tiers — featured "Most Popular" card + up to 2 small tiers
  donationTiers(p) {
    const featured = p.featured;
    const small = (p.small || []).slice(0, 2);
    let html = '';
    if (featured && featured.amount) {
      const ftBadge = featured.badge !== false ? `<span style="display:inline-block;padding:5px 14px;background:${Y};border-radius:100px;font-family:${SANS};font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:${D};margin-bottom:14px;">${escapeHtml(featured.badge || 'Most Popular')}</span>` : '';
      const href = escapeAttr(featured.href || `${ZEFFY_BASE}?amount=${featured.amount}`);
      html += `<tr>
        <td style="background:${CR};padding:0 48px 12px;" class="pd">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%"><tr>
            <td style="padding:28px;background:${D};border-radius:12px;text-align:center;">
              ${ftBadge}
              <p style="margin:0 0 4px;font-family:${SERIF};font-size:34px;font-weight:700;color:#fff;">$${escapeHtml(String(featured.amount))}</p>
              ${featured.label ? `<p style="margin:0 0 8px;font-family:${SANS};font-size:14px;font-weight:600;color:${Y};">${escapeHtml(featured.label)}</p>` : ''}
              ${featured.description ? `<p style="margin:0 0 22px;font-family:${SANS};font-size:13px;line-height:1.6;color:rgba(255,255,255,0.55);">${escapeHtml(featured.description)}</p>` : ''}
              <a href="${href}" target="_blank" style="display:inline-block;padding:16px 40px;background:${Y};color:${D};font-family:${SANS};font-size:15px;font-weight:600;text-decoration:none;border-radius:100px;letter-spacing:0.01em;">Give $${escapeHtml(String(featured.amount))} &rarr;</a>
            </td>
          </tr></table>
        </td></tr>`;
    }
    if (small.length === 2) {
      const cell = (t) => {
        const href = escapeAttr(t.href || `${ZEFFY_BASE}?amount=${t.amount}`);
        return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%"><tr>
          <td style="padding:22px;background:${WG};border-radius:12px;text-align:center;">
            <p style="margin:0 0 2px;font-family:${SERIF};font-size:26px;font-weight:700;color:${D};">$${escapeHtml(String(t.amount))}</p>
            ${t.label ? `<p style="margin:0 0 8px;font-family:${SANS};font-size:13px;font-weight:600;color:${TM};">${escapeHtml(t.label)}</p>` : ''}
            ${t.description ? `<p style="margin:0 0 16px;font-family:${SANS};font-size:12px;line-height:1.6;color:${TL};">${escapeHtml(t.description)}</p>` : ''}
            <a href="${href}" target="_blank" style="font-family:${SANS};font-size:13px;font-weight:600;color:${D};text-decoration:underline;text-underline-offset:3px;">Give $${escapeHtml(String(t.amount))} &rarr;</a>
          </td></tr></table>`;
      };
      html += `<tr>
        <td style="background:${CR};padding:0 48px;" class="pd">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%"><tr>
            <td width="49%" class="st" valign="top">${cell(small[0])}</td>
            <td width="2%" class="hm">&nbsp;</td>
            <td width="49%" class="st mob-stack" valign="top">${cell(small[1])}</td>
          </tr></table>
        </td></tr>`;
    } else if (small.length === 1) {
      const t = small[0];
      const href = escapeAttr(t.href || `${ZEFFY_BASE}?amount=${t.amount}`);
      html += `<tr>
        <td style="background:${CR};padding:0 48px;" class="pd">
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%"><tr>
            <td style="padding:22px;background:${WG};border-radius:12px;text-align:center;">
              <p style="margin:0 0 2px;font-family:${SERIF};font-size:26px;font-weight:700;color:${D};">$${escapeHtml(String(t.amount))}</p>
              ${t.label ? `<p style="margin:0 0 8px;font-family:${SANS};font-size:13px;font-weight:600;color:${TM};">${escapeHtml(t.label)}</p>` : ''}
              ${t.description ? `<p style="margin:0 0 16px;font-family:${SANS};font-size:12px;line-height:1.6;color:${TL};">${escapeHtml(t.description)}</p>` : ''}
              <a href="${href}" target="_blank" style="font-family:${SANS};font-size:13px;font-weight:600;color:${D};text-decoration:underline;text-underline-offset:3px;">Give $${escapeHtml(String(t.amount))} &rarr;</a>
            </td>
          </tr></table>
        </td></tr>`;
    }
    return html;
  },

  // Dark partners section — eyebrow, headline, intro, comma-separated list
  partnersList(p) {
    const partners = (p.partners || []).filter(Boolean);
    if (!partners.length && !p.headline) return '';
    const headlineHtml = displayMd(p.headline || 'Made possible by *incredible* partners', 'dark');
    const intro = p.intro ? `<p style="margin:0 0 24px;font-family:${SANS};font-size:15px;line-height:1.7;color:rgba(255,255,255,0.6);">${inlineMd(p.intro)}</p>` : '';
    const list = partners.length ? `<p style="margin:0;font-family:${SANS};font-size:13px;line-height:2.2;color:rgba(255,255,255,0.4);">${partners.map(escapeHtml).join(' &middot; ')}</p>` : '';
    return `<tr>
      <td style="background:${CR};padding:32px 0 0;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background:${DD};"><tr>
          <td style="padding:44px 48px;" class="pd">
            ${sLabel(escapeHtml(p.label || 'Our Partners'), 'light')}
            <h2 class="h2m" style="margin:20px 0 12px;font-family:${SERIF};font-size:24px;font-weight:700;line-height:1.3;color:#fff;">${headlineHtml}</h2>
            ${intro}
            ${list}
          </td>
        </tr></table>
      </td></tr>`;
  },

  // Trust signal row — Tax-Deductible · Zero Platform Fees · 501(c)(3) with shield icon
  trustSignals(p) {
    const items = (p.items && p.items.length ? p.items : ['Tax-Deductible', 'Zero Platform Fees', '501(c)(3)']);
    const sep = `<span style="padding:0 10px;color:${BD};">&middot;</span>`;
    const list = items.map((it, i) => `${i > 0 ? sep : ''}${escapeHtml(it)}`).join('');
    return `<tr>
      <td style="background:${CR};padding:24px 48px 0;text-align:center;" class="pd">
        <p style="margin:0;font-family:${SANS};font-size:12px;color:${TL};">
          <span style="vertical-align:middle;display:inline-block;margin-right:4px;"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" style="vertical-align:middle;"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z" stroke="${TL}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/><path d="m9 12 2 2 4-4" stroke="${TL}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg></span>
          ${list}
        </p>
      </td></tr>`;
  },

  revealInvite(p) {
    const k = p.kid || {};
    const name = k.name || p.kidName || '';
    const slug = k.slug || p.slug || '';
    const profileUrl = slug ? `${SITE_URL}/kids/${slug}` : '';

    const customSrc = p.image || p.src || '';
    const kidSrc = k.heroImage || (k.photos && k.photos[0] && k.photos[0].url) || '';
    const heroSrc = customSrc || kidSrc;
    const heroImg = heroSrc ? cfImg(heroSrc, 'w=1200,h=750,fit=cover,gravity=face,q=80') : '';
    const heroAlt = escapeAttr(p.alt || (name ? `${name}'s reveal day` : 'Reveal day'));

    const headline = p.headline || (name ? `You're Invited to ${name}'s Reveal Day` : `You're Invited to a Reveal Day`);
    const intro = p.intro || (name
      ? `After months of planning and building, the day is almost here. ${name} and the family haven't seen the finished room yet — come be there for that first reaction.`
      : `After months of planning and building, the day is almost here. The family hasn't seen the finished room yet — come be there for that first reaction.`);

    const tz = p.tz || 'America/New_York';
    const dateDisplay = p.dateDisplay || formatRevealDate(p.date, p.time, tz);
    const location = p.location || '';
    const address = p.address || '';

    const cal = buildCalLinks({
      title: p.calendarTitle || (name ? `${name}'s Reveal Day — Sunshine on a Ranney Day` : 'Reveal Day — Sunshine on a Ranney Day'),
      date: p.date || '',
      time: p.time || '',
      endDate: p.endDate || '',
      endTime: p.endTime || '',
      location: [location, address].filter(Boolean).join(', '),
      details: p.calendarDetails || stripHtml(intro || ''),
      url: profileUrl,
      tz,
      uid: slug && p.date ? `reveal-${slug}-${p.date.replace(/-/g, '')}@sunshineonaranneyday.com` : '',
    });

    const detailRows = [];
    if (dateDisplay) {
      detailRows.push(`
        <tr>
          <td style="padding:14px 0;border-bottom:1px solid ${BD};vertical-align:top;width:84px;">
            <span style="font-family:${SANS};font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:${TL};">When</span>
          </td>
          <td style="padding:14px 0;border-bottom:1px solid ${BD};vertical-align:top;">
            <span style="font-family:${SERIF};font-size:16px;font-weight:700;color:${D};line-height:1.4;">${escapeHtml(dateDisplay)}</span>
          </td>
        </tr>`);
    }
    if (location || address) {
      detailRows.push(`
        <tr>
          <td style="padding:14px 0;vertical-align:top;width:84px;">
            <span style="font-family:${SANS};font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:${TL};">Where</span>
          </td>
          <td style="padding:14px 0;vertical-align:top;">
            ${location ? `<span style="font-family:${SERIF};font-size:16px;font-weight:700;color:${D};display:block;line-height:1.4;">${escapeHtml(location)}</span>` : ''}
            ${address ? `<span style="font-family:${SANS};font-size:13px;color:${TM};display:block;margin-top:3px;line-height:1.5;">${escapeHtml(address)}</span>` : ''}
          </td>
        </tr>`);
    }

    const heroBlock = heroImg
      ? `<tr><td style="padding:0 0 28px;">
          ${profileUrl
            ? `<a href="${profileUrl}" target="_blank" style="display:block;text-decoration:none;">`
            : ''}
            <div style="border-radius:20px;overflow:hidden;box-shadow:0 24px 64px rgba(0,0,0,0.1),0 4px 16px rgba(0,0,0,0.06);">
              <img src="${heroImg}" width="552" alt="${heroAlt}" class="fl hero-img" style="width:100%;display:block;" />
            </div>
          ${profileUrl ? `</a>` : ''}
        </td></tr>`
      : '';

    const calPill = (label, href) => `<a href="${escapeAttr(href)}" target="_blank" style="display:inline-block;padding:11px 20px;background:#FFFFFF;border:1.5px solid ${BD};border-radius:100px;font-family:${SANS};font-size:13px;font-weight:600;color:${D};text-decoration:none;letter-spacing:0.01em;margin:0 3px 8px;">${label}</a>`;
    const calRow = (cal.google || cal.outlook || cal.ical) ? `
      <tr><td style="padding:24px 0 4px;text-align:center;">
        <p style="margin:0 0 12px;font-family:${SANS};font-size:11px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:${TL};">Add to Calendar</p>
        ${cal.google ? calPill('Google', cal.google) : ''}
        ${cal.ical ? calPill('Apple', cal.ical) : ''}
        ${cal.outlook ? calPill('Outlook', cal.outlook) : ''}
      </td></tr>` : '';

    const profileBtn = profileUrl
      ? `<tr><td style="padding:18px 0 0;text-align:center;">
          <a href="${profileUrl}" target="_blank" style="display:inline-block;padding:16px 36px;background:${Y};color:${D};font-family:${SANS};font-size:15px;font-weight:600;text-decoration:none;border-radius:100px;letter-spacing:0.01em;">${escapeHtml(p.profileLabel || (name ? `See ${name}'s Story` : `See the Story`))} &rarr;</a>
        </td></tr>`
      : '';

    return `<tr>
      <td style="background:${CR};padding:8px 48px 0;" class="pd">
        ${sLabel(p.label || "You're Invited", 'yellow')}
        <h1 class="h1m" style="margin:18px 0 12px;font-family:${SERIF};font-size:30px;font-weight:700;line-height:1.2;color:${D};letter-spacing:-0.02em;">${displayMd(headline)}</h1>
        <p style="margin:0 0 28px;font-family:${SERIF};font-size:17px;line-height:1.7;color:${D};">${inlineMd(intro)}</p>
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
          ${heroBlock}
          ${detailRows.length ? `<tr><td style="padding:0;">
            <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background:${WG};border-radius:14px;">
              <tr><td style="padding:4px 22px;"><table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">${detailRows.join('')}</table></td></tr>
            </table>
          </td></tr>` : ''}
          ${calRow}
          ${profileBtn}
        </table>
      </td></tr>`;
  },
};

// ─── Reveal-invite calendar helpers ─────────────────────────────────
// Build Google Calendar, Outlook web, and .ics download URLs for a given
// event. All times are converted to UTC server-side using Intl.DateTimeFormat
// so daylight-saving transitions in the source timezone are handled correctly.

/** Format a date+time for human display in the email body. */
function formatRevealDate(dateStr, timeStr, tz) {
  if (!dateStr) return '';
  try {
    const d = new Date(`${dateStr}T12:00:00Z`); // noon UTC keeps us on the right day
    if (isNaN(d.getTime())) return timeStr ? `${dateStr} · ${timeStr}` : dateStr;
    const datePart = d.toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric', year: 'numeric',
      timeZone: tz || 'America/New_York',
    });
    return timeStr ? `${datePart} · ${timeStr}` : datePart;
  } catch {
    return timeStr ? `${dateStr} · ${timeStr}` : dateStr;
  }
}

/** Parse "3:00 PM", "3 PM", "15:00" → { h, m }, or null. */
function parseTime(t) {
  if (!t) return null;
  const s = String(t).trim();
  const m12 = s.match(/^(\d{1,2})(?::(\d{2}))?\s*(AM|PM)$/i);
  if (m12) {
    let h = parseInt(m12[1], 10) % 12;
    if (m12[3].toUpperCase() === 'PM') h += 12;
    return { h, m: parseInt(m12[2] || '0', 10) };
  }
  const m24 = s.match(/^(\d{1,2}):(\d{2})$/);
  if (m24) return { h: parseInt(m24[1], 10), m: parseInt(m24[2], 10) };
  return null;
}

/**
 * Convert a wall-clock time in the given IANA timezone to the matching UTC
 * Date instant. Iteratively converges in 1–2 rounds; correct across DST
 * transitions because Intl.DateTimeFormat applies the active offset.
 */
function localInTzToUTC(year, month, day, hour, min, tz) {
  let t = Date.UTC(year, month - 1, day, hour, min);
  for (let i = 0; i < 3; i++) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hourCycle: 'h23',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit',
    }).formatToParts(new Date(t));
    const v = (k) => parseInt(parts.find(p => p.type === k).value, 10);
    let h = v('hour'); if (h === 24) h = 0;
    const observed = Date.UTC(v('year'), v('month') - 1, v('day'), h, v('minute'));
    const wanted = Date.UTC(year, month - 1, day, hour, min);
    const diff = wanted - observed;
    if (diff === 0) break;
    t += diff;
  }
  return new Date(t);
}

/** Format Date as compact UTC for Google: "20260615T190000Z". */
function utcCompact(d) {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/** Format a YYYY-MM-DD string as "YYYYMMDD" for all-day Google events. */
function ymdCompact(s) { return String(s).replace(/-/g, ''); }

/**
 * Build the three calendar URLs (Google, Outlook web, .ics download).
 * Returns { google, outlook, ical } — any field empty if `date` is missing.
 *
 * For timed events, all three URLs encode UTC instants so recipients in any
 * timezone see the correct local time. For all-day events (no `time`), Google
 * uses inclusive/exclusive YYYYMMDD pairs and the .ics endpoint emits
 * VALUE=DATE entries.
 */
function buildCalLinks({ title, date, time, endDate, endTime, location, details, url, tz, uid }) {
  if (!date) return { google: '', outlook: '', ical: '' };
  const TZ = tz || 'America/New_York';
  const start = parseTime(time);
  const isAllDay = !start;

  let googleDates, outlookStart, outlookEnd, icsStart, icsEnd, icsAllDay = false;

  if (isAllDay) {
    icsAllDay = true;
    const startYmd = ymdCompact(date);
    let endYmdInclusive = endDate ? ymdCompact(endDate) : startYmd;
    // Google + iCal both use exclusive end for all-day → bump by one day
    const d = new Date(`${endYmdInclusive.slice(0, 4)}-${endYmdInclusive.slice(4, 6)}-${endYmdInclusive.slice(6, 8)}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    const endYmdExclusive = utcCompact(d).slice(0, 8);
    googleDates = `${startYmd}/${endYmdExclusive}`;
    outlookStart = `${date}T00:00:00`;
    outlookEnd = `${endDate || date}T23:59:59`;
    icsStart = startYmd;
    icsEnd = endYmdExclusive;
  } else {
    const [sy, smo, sd] = date.split('-').map(Number);
    const startUtc = localInTzToUTC(sy, smo, sd, start.h, start.m, TZ);
    let endParsed = parseTime(endTime);
    let endUtc;
    if (endParsed) {
      const ed = endDate || date;
      const [ey, emo, edd] = ed.split('-').map(Number);
      endUtc = localInTzToUTC(ey, emo, edd, endParsed.h, endParsed.m, TZ);
    } else {
      endUtc = new Date(startUtc.getTime() + 2 * 60 * 60 * 1000); // +2h default
    }
    googleDates = `${utcCompact(startUtc)}/${utcCompact(endUtc)}`;
    outlookStart = startUtc.toISOString().replace(/\.\d{3}Z$/, 'Z');
    outlookEnd = endUtc.toISOString().replace(/\.\d{3}Z$/, 'Z');
    icsStart = utcCompact(startUtc);
    icsEnd = utcCompact(endUtc);
  }

  const safeTitle = title || '';
  const safeLocation = location || '';
  const safeDetails = (details || '') + (url ? `\n\n${url}` : '');

  const googleParams = new URLSearchParams({
    action: 'TEMPLATE',
    text: safeTitle,
    dates: googleDates,
    location: safeLocation,
    details: safeDetails,
    ctz: TZ,
  });
  const google = `https://calendar.google.com/calendar/render?${googleParams}`;

  const outlookParams = new URLSearchParams({
    path: '/calendar/action/compose',
    rru: 'addevent',
    subject: safeTitle,
    startdt: outlookStart,
    enddt: outlookEnd,
    body: safeDetails,
    location: safeLocation,
    allday: isAllDay ? 'true' : 'false',
  });
  const outlook = `https://outlook.live.com/calendar/0/deeplink/compose?${outlookParams}`;

  const icalParams = new URLSearchParams({
    title: safeTitle,
    start: icsStart,
    end: icsEnd,
    location: safeLocation,
    details: safeDetails,
  });
  if (icsAllDay) icalParams.set('allday', '1');
  if (uid) icalParams.set('uid', uid);
  if (url) icalParams.set('url', url);
  const ical = `${SITE_URL}/api/calendar.ics?${icalParams}`;

  return { google, outlook, ical };
}

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
