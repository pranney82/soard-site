/**
 * The look of the site's one-off emails: staff notices and family reminders
 * ===========================================================================
 * The same system as the site's other transactional mail (the waitlist and
 * reveal reminders): a warm gray page, a cream card, a gold eyebrow with the
 * yellow rule, a Libre Baskerville headline, Outfit text, yellow pill buttons.
 *
 * Built for email clients, not browsers: tables and inline styles; buttons
 * drawn as table cells so Outlook keeps their color and padding; a hidden
 * preheader (the line inboxes show beside the subject); a phone layout; and a
 * dark palette for Apple Mail and iOS Mail (Gmail repaints dark mode itself).
 */

const Y = '#FFDA24';
const INK = '#2D2E33';
const CREAM = '#FEFCF5';
const PAGE = '#F5F4F0';
export const MUTED = '#5A5B61';
const BORDER = '#E5E4E0';
const GOLD = '#8A7200';
const LINK = '#2B6CB0';
export const SERIF = "'Libre Baskerville',Georgia,'Times New Roman',serif";
export const SANS = "Outfit,-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";

export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The admin's status colors (Applicants board), as a soft pill; each tone has a dark-mode twin */
export const TONES = { blue: '#2B6CB0', amber: '#8E5B0E', green: '#2F7D4F', gray: '#5F6066' };
const STATUS_COLORS = { Applied: TONES.blue, 'In Review': TONES.amber, Approved: TONES.green, Denied: TONES.gray };
const tint = (hex, a) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
};
export function pill(text, color = STATUS_COLORS[text] || TONES.gray) {
  const tone = Object.keys(TONES).find(k => TONES[k] === color) || 'gray';
  return `<span class="pill pill-${tone}" style="display:inline-block;padding:3px 11px;border-radius:999px;font-family:${SANS};font-size:12px;font-weight:700;line-height:18px;color:${color};background:${tint(color, 0.1)};border:1px solid ${tint(color, 0.28)};white-space:nowrap;">${esc(text)}</span>`;
}

/**
 * A pill button that survives Outlook. kind: 'primary' (yellow), 'dark',
 * 'outline'. Several in a row wrap on a phone.
 */
export function button(label, href, kind = 'primary') {
  const [bg, fg, border] = { primary: [Y, INK, Y], dark: [INK, '#FFFFFF', INK], outline: ['#FFFFFF', INK, '#D4D2CB'] }[kind] || [Y, INK, Y];
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="display:inline-table;margin:0 6px 8px 0;border-collapse:separate;"><tr>`
    + `<td class="btn-${kind}" bgcolor="${bg}" style="border-radius:999px;background:${bg};border:1px solid ${border};">`
    + `<a href="${esc(href)}" target="_blank" style="display:inline-block;padding:11px 20px;font-family:${SANS};font-size:14px;font-weight:700;line-height:18px;color:${fg};text-decoration:none;border-radius:999px;white-space:nowrap;">${esc(label)}</a>`
    + '</td></tr></table>';
}

/** A quiet text link */
export const link = (label, href) => `<a class="lnk" href="${esc(href)}" target="_blank" style="color:${LINK};text-decoration:underline;text-underline-offset:3px;">${esc(label)}</a>`;

/** Paragraphs from plain text (blank line = new paragraph) */
export function paragraphs(text, style = '') {
  return String(text || '').split(/\n{2,}/).map(p => p.trim()).filter(Boolean)
    .map(p => `<p class="ink" style="margin:0 0 14px;${style}">${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
}

/** A white panel inside the card (one family, one fact list) */
export function panel(inner, { accent = false } = {}) {
  return `<table role="presentation" class="panel" cellspacing="0" cellpadding="0" border="0" width="100%" style="width:100%;background:#FFFFFF;border:1px solid ${BORDER};${accent ? `border-left:3px solid ${Y};` : ''}border-radius:12px;margin:0 0 12px;border-collapse:separate;">`
    + `<tr><td style="padding:16px 18px;">${inner}</td></tr></table>`;
}

/** A progress bar (Outlook-safe: two cells) */
export function progress(percent) {
  const p = Math.max(4, Math.min(100, Math.round(Number(percent) || 0)));
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="width:100%;border-collapse:separate;border-radius:99px;overflow:hidden;"><tr>`
    + `<td width="${p}%" bgcolor="${Y}" style="width:${p}%;height:10px;line-height:10px;font-size:0;background:${Y};border-radius:99px 0 0 99px;">&nbsp;</td>`
    + (p < 100 ? `<td class="track" bgcolor="#ECEAE3" style="height:10px;line-height:10px;font-size:0;background:#ECEAE3;border-radius:0 99px 99px 0;">&nbsp;</td>` : '')
    + '</tr></table>';
}

/** label → value rows (values are HTML) */
export function facts(rows) {
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="width:100%;">${rows.filter(([, v]) => v).map(([k, v]) => `<tr>
<td class="muted" valign="top" style="padding:6px 14px 6px 0;font-family:${SANS};font-size:13px;line-height:20px;color:${MUTED};white-space:nowrap;width:1%;">${esc(k)}</td>
<td class="ink" valign="top" style="padding:6px 0;font-family:${SANS};font-size:14px;line-height:20px;color:${INK};">${v}</td></tr>`).join('')}</table>`;
}

/**
 * The whole email. heading is plain text; intro and bodyHtml are HTML;
 * footerHtml is the small print under a rule.
 */
export function emailShell({ lang = 'en', preheader = '', eyebrow = 'Sunshine on a Ranney Day', heading, intro = '', bodyHtml = '', footerHtml = '' }) {
  return `<!doctype html>
<html lang="${esc(lang)}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">
<title>${esc(heading)}</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Libre+Baskerville:wght@400;700&family=Outfit:wght@400;600;700&display=swap');
body{margin:0;padding:0;-webkit-text-size-adjust:100%}
table,td{border-collapse:collapse}
@media (max-width:620px){.card{border-radius:0!important}.pad{padding-left:20px!important;padding-right:20px!important}.h1{font-size:23px!important}}
@media (prefers-color-scheme:dark){
body,.page{background:#141518!important}.card{background:#1F2024!important}
.ink,.ink a{color:#ECECEA!important}.muted{color:#ABACB2!important}.eyebrow{color:#E6C744!important}
.panel{background:#26272C!important;border-color:#3A3B41!important}.quote{background:#1A1B1F!important}
.rule{border-color:#3A3B41!important}.btn-outline{background:#26272C!important;border-color:#56575D!important}.btn-outline a{color:#ECECEA!important}
.btn-primary a{color:${INK}!important}.btn-dark{background:#ECECEA!important;border-color:#ECECEA!important}.btn-dark a{color:#1F2024!important}
a.lnk{color:#8DB8EC!important}
.pill{background:#2E2F35!important;border-color:#45464C!important}.pill-blue{color:#8DB8EC!important}.pill-amber{color:#E8B25A!important}
.pill-green{color:#7FCB9A!important}.pill-gray{color:#C9CACE!important}.track{background:#3A3B41!important}
}
</style></head>
<body class="page" style="margin:0;padding:0;background:${PAGE};">
<div style="display:none;max-height:0;max-width:0;overflow:hidden;opacity:0;mso-hide:all;">${esc(preheader)}${'&#8199;&#65279;&#847;'.repeat(60)}</div>
<center class="page" style="width:100%;background:${PAGE};padding:28px 0 20px;">
<table role="presentation" class="card" cellspacing="0" cellpadding="0" border="0" width="600" style="margin:0 auto;width:100%;max-width:600px;background:${CREAM};border-radius:16px;border-collapse:separate;">
<tr><td class="pad" style="padding:30px 32px 6px;">
<table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr>
<td valign="middle" style="width:28px;vertical-align:middle;"><div style="width:28px;height:2px;line-height:2px;font-size:0;background:${Y};">&nbsp;</div></td>
<td class="eyebrow" style="padding-left:10px;font-family:${SANS};font-size:12px;font-weight:700;letter-spacing:0.14em;text-transform:uppercase;color:${GOLD};">${esc(eyebrow)}</td>
</tr></table>
<h1 class="ink h1" style="margin:14px 0 10px;font-family:${SERIF};font-size:27px;line-height:1.25;font-weight:700;color:${INK};">${esc(heading)}</h1>
${intro ? `<p class="muted" style="margin:0 0 6px;font-family:${SANS};font-size:15px;line-height:1.55;color:${MUTED};">${intro}</p>` : ''}
</td></tr>
<tr><td class="pad ink" style="padding:14px 32px 22px;font-family:${SANS};font-size:15px;line-height:1.55;color:${INK};">${bodyHtml}</td></tr>
${footerHtml ? `<tr><td class="pad rule muted" style="padding:16px 32px 26px;border-top:1px solid ${BORDER};font-family:${SANS};font-size:12px;line-height:1.6;color:#6B6C72;">${footerHtml}</td></tr>` : ''}
</table>
<p class="muted" style="margin:16px 0 0;font-family:${SANS};font-size:11px;line-height:1.5;color:#8A8B91;">Sunshine on a Ranney Day &middot; Roswell, Georgia</p>
</center>
</body></html>`;
}
