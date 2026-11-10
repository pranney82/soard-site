/**
 * An email staff write themselves (Emails & invites → Write an email), in the
 * same layout as every email the site drafts: the dark logo header, the team's
 * sign-off with the plushie picture, and the dark footer, all from the shared
 * pieces in ./_reveal-invite-email.js. Only the middle is theirs, as blocks:
 *
 *   cover     the dark top: a small line over a big headline, a photo, a button
 *   heading   a headline in the middle of the email
 *   text      paragraphs: a blank line starts a new one, **bold**, *accent*,
 *             [words](https://link)
 *   photo     one picture, uncropped (a Canva design comes through whole);
 *             wide: edge to edge
 *   photos    two pictures side by side
 *   video     a YouTube or Cloudflare Stream video as its picture, linked
 *   button    one yellow button
 *   give      the yellow band that asks, with its button
 *
 * Pure: no fetches, so the preview, "Send it to me" and the Kit draft are the
 * same email. No unsubscribe link: Kit adds its own footer.
 */

import {
  SITE_URL, SIDE, BRAND, escapeHtml, href, cfImg, tidy, noWidow, emailFrame, emailHeader, emailFooter, signOff,
  button, textLink, cover, headlineFit, TEAM_PICTURE,
} from './_reveal-invite-email.js';
import { askBand, gap } from './_project-email.js';

const { Y, D, CR, SANS, SERIF } = BRAND;

export const BLOCK_TYPES = Object.freeze(['cover', 'heading', 'text', 'photo', 'photos', 'video', 'button', 'give']);
export const DEFAULT_SIGNOFF = 'Thank you for being part of the sunshine.';
export const GIVE_DEFAULTS = Object.freeze({
  kicker: 'How you can help',
  headline: 'Help us build the next *dream*.',
  words: 'Families are on our waitlist right now. Every dollar goes directly to materials, labor, and design. Zero platform fees.',
  buttonText: 'Give Now →',
  url: `${SITE_URL}/donate/`,
});
const LIMITS = { subject: 150, preview: 150, line: 160, text: 6000, blocks: 40 };
// A picture uncropped at email size: a Canva design keeps its whole shape
const WHOLE = 'w=1200,fit=scale-down,q=85';
const HALF = 'w=600,fit=scale-down,q=82';
const STREAM_HOST = 'customer-cuav5h47lgfe96ql.cloudflarestream.com';
const YOUTUBE = /(?:youtu\.be\/|youtube(?:-nocookie)?\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/))([a-zA-Z0-9_-]{11})/;

const str = (v, max) => String(v ?? '').replace(/\r\n?/g, '\n').slice(0, max);
const line = (v, max = LIMITS.line) => str(v, max).replace(/\s+/g, ' ').trim();
const isLink = (u) => /^https?:\/\/\S+$/i.test(String(u || '').trim());
/** A picture's id on Cloudflare Images, from an id or any of its delivery URLs; '' when it isn't one */
export function imageId(v) {
  const s = String(v || '').trim();
  const m = s.match(/ROYFuPmfN2vPS6mt5sCkZQ\/(.+?)\/(?:public|[a-z]+=[^/]*)$/) || s.match(/ROYFuPmfN2vPS6mt5sCkZQ\/([^?#]+)$/);
  if (m) return m[1];
  return /^[a-z0-9][a-z0-9/_.-]{0,200}$/i.test(s) && !/\.\./.test(s) && !/^https?:/i.test(s) ? s : '';
}
const pic = (v) => ({ id: imageId(v?.id ?? v), alt: line(v?.alt, 200) });

/** What a block may hold, and nothing else: anything typed or sent in is cut to this */
function cleanBlock(b) {
  const type = BLOCK_TYPES.includes(b?.type) ? b.type : null;
  if (!type) return null;
  switch (type) {
    case 'cover': return { type, kicker: line(b.kicker, 80), headline: line(b.headline, 120), photo: pic(b.photo), buttonText: line(b.buttonText, 40), url: isLink(b.url) ? String(b.url).trim() : '' };
    case 'heading': return { type, text: line(b.text, 140) };
    case 'text': return { type, text: str(b.text, LIMITS.text).trim() };
    case 'photo': return { type, ...pic(b), wide: b.wide === true, url: isLink(b.url) ? String(b.url).trim() : '' };
    case 'photos': return { type, a: pic(b.a), b: pic(b.b) };
    case 'video': return { type, url: isLink(b.url) ? String(b.url).trim() : '', caption: line(b.caption, 80) };
    case 'button': return { type, text: line(b.text, 40), url: isLink(b.url) ? String(b.url).trim() : '' };
    case 'give': return { type, kicker: line(b.kicker, 60), headline: line(b.headline, 100), words: line(b.words, 400), buttonText: line(b.buttonText, 40), url: isLink(b.url) ? String(b.url).trim() : '' };
    default: return null;
  }
}

/** An email as stored and drafted: { subject, preview, signoff, blocks } */
export function cleanEmail(input = {}) {
  return {
    subject: line(input.subject, LIMITS.subject),
    preview: line(input.preview, LIMITS.preview),
    signoff: line(input.signoff, 200),
    blocks: (Array.isArray(input.blocks) ? input.blocks : []).slice(0, LIMITS.blocks).map(cleanBlock).filter(Boolean),
  };
}

/** What's missing before it can go to Kit, in words: [] when it's ready */
export function emailProblems(email) {
  const e = cleanEmail(email);
  const out = [];
  if (!e.subject) out.push('a subject');
  const real = e.blocks.filter((b) => (b.type === 'text' && b.text) || (b.type === 'heading' && b.text) || (b.type === 'photo' && b.id)
    || (b.type === 'photos' && (b.a.id || b.b.id)) || (b.type === 'cover' && (b.headline || b.photo.id)) || (b.type === 'video' && b.url) || b.type === 'give');
  if (!real.length) out.push('something in the middle: words or a picture');
  if (e.blocks.some((b) => (b.type === 'button' && b.text && !b.url) || (b.type === 'cover' && b.buttonText && !b.url))) out.push('a link for each button');
  if (e.blocks.some((b) => b.type === 'video' && b.url && !videoOf(b.url))) out.push('a YouTube or Cloudflare Stream link for the video');
  return out;
}

/** Typed words as HTML: escaped, curly quotes, a typed em dash read as a spaced en dash, **bold**, *accent*, [words](link) */
function inline(raw, { accent = D } = {}) {
  let s = escapeHtml(tidy(raw));
  s = s.replace(/\[([^\]]{1,200})\]\((https?:\/\/[^\s)]{1,500})\)/g, (m, words, url) => `<a href="${href(url.replace(/&amp;/g, '&'))}" target="_blank" style="color:${D};font-weight:700;text-decoration:underline;text-underline-offset:3px;">${words}</a>`);
  s = s.replace(/\*\*([^*]{1,300})\*\*/g, '<strong style="font-weight:700;">$1</strong>');
  s = s.replace(/(^|[\s(>])\*([^*\s][^*]{0,120}?)\*(?=[\s.,!?;:)<]|$)/g, `$1<em style="font-style:italic;color:${accent};">$2</em>`);
  return s;
}
const plainOf = (raw) => tidy(raw).replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1 ($2)').replace(/\*\*([^*]+)\*\*/g, '$1').replace(/(^|\s)\*([^*]+)\*/g, '$1$2');

/** A YouTube or Stream link → { kind, id, thumb } or null */
export function videoOf(url) {
  const s = String(url || '');
  const yt = s.match(YOUTUBE);
  // YouTube's widescreen picture first (no black bars), its standard one if a video has none
  if (yt) return { kind: 'youtube', id: yt[1], thumbs: [`https://i.ytimg.com/vi/${yt[1]}/hq720.jpg`, `https://i.ytimg.com/vi/${yt[1]}/hqdefault.jpg`] };
  const st = s.match(/(?:cloudflarestream\.com|videodelivery\.net)\/([a-f0-9]{32})/i);
  if (st) return { kind: 'stream', id: st[1].toLowerCase(), thumbs: [`https://${STREAM_HOST}/${st[1].toLowerCase()}/thumbnails/thumbnail.jpg?width=1200`] };
  return null;
}

const row = (inner, top = 28) => `<tr><td bgcolor="${CR}" style="background:${CR};padding:${top}px 0 0;${SIDE}" class="pd">${inner}</td></tr>`;
const img = (p, transform, width, extra = '') => `<img src="${escapeHtml(cfImg(p.id, transform))}" width="${width}" alt="${escapeHtml(p.alt)}" class="fl" style="width:100%;height:auto;display:block;border:0;${extra}" />`;
const linked = (url, inner) => (url ? `<a href="${href(url)}" target="_blank" style="display:block;text-decoration:none;">${inner}</a>` : inner);
/** The headline's size: fits a small phone, as every cover does */
const fitOf = (text, max, phones) => headlineFit(String(text).replace(/\*/g, '').split(/\s+/).filter(Boolean), max, phones ? { phones } : undefined);

function renderBlock(b, i, { brokenLogos, site }) {
  const ok = (p) => p.id && !brokenLogos.has(cfImg(p.id, WHOLE)) && !brokenLogos.has(cfImg(p.id, HALF));
  switch (b.type) {
    case 'cover': {
      if (!b.headline && !ok(b.photo)) return '';
      const fit = fitOf(b.headline || ' ', 44);
      return cover({
        kicker: tidy(b.kicker),
        headline: inline(b.headline, { accent: Y }),
        size: fit.size,
        phone: fit.phone,
        lead: ok(b.photo) ? b.photo.id : '',
        alt: b.photo.alt || tidy(b.headline),
        url: b.url || site,
        action: b.buttonText && b.url ? button(tidy(b.buttonText), b.url, { center: true }) : '',
      });
    }
    case 'heading': {
      if (!b.text) return '';
      const fit = fitOf(b.text, 28, [[24, 'h2m']]);
      return row(`<h2 class="${fit.phone}" style="margin:0;font-family:${SERIF};font-size:${fit.size}px;font-weight:700;line-height:1.25;color:${D};">${noWidow(inline(b.text, { accent: D }))}</h2>`, i ? 40 : 36);
    }
    case 'text': {
      const paras = b.text.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean);
      if (!paras.length) return '';
      return row(paras.map((p, k) => `<p style="margin:${k ? 16 : 0}px 0 0;font-family:${SANS};font-size:16px;line-height:1.65;color:${D};word-break:normal;overflow-wrap:break-word;">${noWidow(inline(p).replace(/\n/g, '<br>'))}</p>`).join(''), 20);
    }
    case 'photo': {
      if (!ok(b)) return '';
      // Edge to edge: a designed graphic the width of the email, no rounding
      if (b.wide) return `<tr><td bgcolor="${CR}" style="background:${CR};padding:24px 0 0;line-height:0;font-size:0;">${linked(b.url, img(b, WHOLE, 600))}</td></tr>`;
      return row(linked(b.url, img(b, WHOLE, 504, 'border-radius:14px;')), 24);
    }
    case 'photos': {
      const two = [b.a, b.b].filter(ok);
      if (!two.length) return '';
      if (two.length === 1) return row(img(two[0], WHOLE, 504, 'border-radius:14px;'), 24);
      return row(`<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%"><tr>
        <td width="49%" valign="top">${img(two[0], HALF, 247, 'border-radius:14px;')}</td>
        <td width="2%" style="font-size:0;">&nbsp;</td>
        <td width="49%" valign="top">${img(two[1], HALF, 247, 'border-radius:14px;')}</td>
      </tr></table>`, 24);
    }
    case 'video': {
      const v = videoOf(b.url);
      const thumb = v?.thumbs.find((t) => !brokenLogos.has(t));
      if (!thumb) return '';
      return row(`<a href="${href(b.url)}" target="_blank" style="display:block;text-decoration:none;"><img src="${escapeHtml(thumb)}" width="504" alt="${escapeHtml(tidy(b.caption) || 'Watch the video')}" class="fl" style="width:100%;height:auto;display:block;border:0;border-radius:14px;" /></a>
        <p style="margin:14px 0 0;font-family:${SANS};font-size:15px;line-height:1.5;">${textLink(`▶︎ ${tidy(b.caption) || 'Watch the video'} →`, b.url)}</p>`, 24);
    }
    case 'button':
      return b.text && b.url ? row(button(tidy(b.text), b.url, { center: true }), 28) : '';
    case 'give': {
      const g = { ...GIVE_DEFAULTS, ...Object.fromEntries(Object.entries(b).filter(([k, v]) => k !== 'type' && v)) };
      return `${gap(40)}${askBand({
        kicker: tidy(g.kicker),
        headline: noWidow(inline(g.headline, { accent: D })),
        fit: fitOf(g.headline, 30, [[26, 'h2b']]),
        words: tidy(g.words),
        action: tidy(g.buttonText),
        url: g.url,
      })}`;
    }
    default: return '';
  }
}

/** Every picture the email would load, for the check before it goes to Kit */
export function customImageUrls(email) {
  const e = cleanEmail(email);
  return [...new Set(e.blocks.flatMap((b) => {
    if (b.type === 'cover') return b.photo.id ? [cfImg(b.photo.id, WHOLE)] : [];
    if (b.type === 'photo') return b.id ? [cfImg(b.id, WHOLE)] : [];
    if (b.type === 'photos') return [b.a, b.b].filter((p) => p.id).map((p) => cfImg(p.id, HALF));
    if (b.type === 'video') { const v = videoOf(b.url); return v ? v.thumbs : []; }
    return [];
  }))];
}

/**
 * The email, as Kit will send it.
 * @returns {{ subject: string, preview: string, html: string, text: string }}
 */
export function customEmail(input, { site = SITE_URL, brokenLogos = new Set(), teamPicture = !brokenLogos.has(TEAM_PICTURE) } = {}) {
  const e = cleanEmail(input);
  const subject = tidy(e.subject) || 'A note from SOARD';
  const firstWords = e.blocks.find((b) => b.type === 'text' && b.text)?.text || '';
  const preview = tidy(e.preview) || plainOf(firstWords).replace(/\s+/g, ' ').slice(0, 140);
  const blocks = e.blocks.map((b, i) => renderBlock(b, i, { brokenLogos, site })).filter(Boolean);
  const startsWithCover = e.blocks[0]?.type === 'cover' && blocks.length && blocks[0].includes('<h1');
  const endsWithGive = e.blocks[e.blocks.length - 1]?.type === 'give';
  const html = emailFrame(preview, `
  ${emailHeader(site)}
  ${blocks.join('\n')}
  ${endsWithGive ? '' : gap(startsWithCover && blocks.length === 1 ? 8 : 12)}
  ${signOff(tidy(e.signoff) || DEFAULT_SIGNOFF, teamPicture)}
  ${emailFooter(site)}`);
  const text = [
    ...e.blocks.map((b) => {
      if (b.type === 'cover') return [tidy(b.kicker), plainOf(b.headline), b.buttonText && b.url ? `${tidy(b.buttonText).replace(/\s*→$/, '')}: ${b.url}` : ''].filter(Boolean).join('\n');
      if (b.type === 'heading') return plainOf(b.text);
      if (b.type === 'text') return plainOf(b.text);
      if (b.type === 'video') return b.url ? `${tidy(b.caption) || 'Watch the video'}: ${b.url}` : '';
      if (b.type === 'button') return b.text && b.url ? `${tidy(b.text).replace(/\s*→$/, '')}: ${b.url}` : '';
      if (b.type === 'give') { const g = { ...GIVE_DEFAULTS, ...Object.fromEntries(Object.entries(b).filter(([k, v]) => k !== 'type' && v)) }; return `${plainOf(g.headline)} ${tidy(g.words)}\n${tidy(g.buttonText).replace(/ →$/, '')}: ${g.url}`; }
      return '';
    }).filter(Boolean),
    '',
    tidy(e.signoff) || DEFAULT_SIGNOFF,
    'The SOARD Team, Sunshine on a Ranney Day',
  ].join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
  return { subject, preview, html, text };
}

