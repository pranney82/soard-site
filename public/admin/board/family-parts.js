/**
 * The pieces a family is made of on the board page: their face, status and
 * score, and what they sent with their application. Shared by the Families
 * pages (./families.js) and the map (./family-map.js).
 */

import { h, htm, useState } from '../vendor.js';
import { initialsOf, shortDate } from '../board-shared.js';
import { tierById, fmtScore, TOTAL_MAX } from '../scoring-shared.js';
import { viewerLink, sizeText, VideoTile } from '../file-viewer.js';
import { sized } from './kanban.js';
import { nbw } from './costs.js';

const html = htm.bind(h);
const API = '/api/board-portal';
export const STATUSES = ['Approved', 'In Review', 'Applied', 'Denied'];
const STATUS_TONE = { Approved: 'ok', 'In Review': 'info', Applied: '', Denied: 'quiet', '': 'quiet' };
const hueOf = (s) => [42, 28, 96, 152, 200, 18][[...String(s)].reduce((a, c) => a + c.charCodeAt(0), 0) % 6];
export const day = (iso) => (iso ? shortDate(String(iso).slice(0, 10)) : '');
export const cache = { list: null, one: new Map() };

export async function read(q) {
  try {
    const r = await fetch(`${API}?${q}`, { cache: 'no-store' });
    const j = await r.json().catch(() => ({ ok: false, error: `Something went wrong (${r.status})` }));
    return r.ok && j.ok !== false ? j : { ok: false, error: j.error || `Something went wrong (${r.status})` };
  } catch {
    return { ok: false, error: 'No connection. Check your internet and try again.' };
  }
}

/** Their photo, or their initials (also when the photo can't be reached) */
export function Face({ f, size = 40 }) {
  const [broken, setBroken] = useState(false);
  return f.photo && !broken
    ? html`<img class="bf-face" src=${sized(f.photo, `w=${size * 2},h=${size * 2},fit=cover,gravity=face`)} alt="" width=${size} height=${size} loading="lazy" onError=${() => setBroken(true)} />`
    : html`<span class="bf-face bf-face--initials" style=${`--hue:${hueOf(f.name)};--s:${size}px`} aria-hidden="true">${initialsOf(f.name)}</span>`;
}
export const Status = ({ s }) => html`<span class=${`bf-status ${STATUS_TONE[s] ? `is-${STATUS_TONE[s]}` : ''}`}>${s || 'No status'}</span>`;
export function Score({ s, big = false }) {
  // (a card started but not finished is still no score: never "0 of 0 scored")
  if (!s?.count) return html`<span class="bf-score is-none">Not scored yet</span>`;
  if (!s.ranked || s.total == null) return html`<span class="bf-score is-part">${nbw(`${s.count} of ${s.of || s.count} scored`)}</span>`;
  const t = tierById(s.tier);
  return html`<span class=${`bf-score ${big ? 'is-big' : ''}`}><b>${fmtScore(s.total)}</b>${big ? html`<small>of ${TOTAL_MAX}</small>` : null}${t ? html`<span class=${`bf-tier is-${t.id}`}>${t.label}</span>` : null}</span>`;
}
export const asked = (f) => (f.kind === 'organization' ? 'Community project' : f.types?.length ? f.types.join(', ') : '');
export const place = (f) => [f.city, f.county ? `${f.county} County`.replace(/ County County$/, ' County') : ''].filter(Boolean).join(', ');
/** Where their home sits against the service area, in words */
export const areaWords = (f) => (f.area === 'inside' ? 'Inside' : f.area === 'outside' ? `${f.areaMiles} ${f.areaMiles === 1 ? 'mile' : 'miles'} outside` : '');
/** Ranked ones first, best score first; then who's been scored the most; then the newest */
export const byScore = (a, b) => (b.score?.ranked ? 1 : 0) - (a.score?.ranked ? 1 : 0) || (b.score?.ranked ? b.score.total : -1) - (a.score?.ranked ? a.score.total : -1) || (b.score?.count || 0) - (a.score?.count || 0) || String(b.applied || '').localeCompare(String(a.applied || ''));
/** The newest season with a family in it (a season of one community project alone isn't the place to start) */
export const seasonsOf = (families) => [...new Set((families || []).map((f) => f.season).filter(Boolean))].sort().reverse();
export const openingSeason = (families) => { const all = seasonsOf(families); return all.find((y) => families.some((f) => f.season === y && f.kind !== 'organization')) || all[0] || ''; };

/** One set in the viewer, the way Applicants shows it: the application, the video, then the photos */
export const setOf = (m) => [m?.application, m?.video, ...(m?.photos || [])].filter(Boolean);

const PICTURE = html`<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="3.5" y="5" width="17" height="14" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="m20.5 16-4.6-4.6L7 19"/></svg>`;
const PAGE = html`<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M6 3.5h8.5L19 8v12.5H6z"/><path d="M14.5 3.5V8H19M9 12.5h7M9 16h7"/></svg>`;

/**
 * A tile that opens one file in the set; it keeps its shape whether or not the picture ever arrives. `src` is only
 * ever a thumbnail: a photo with none shows `mark` (fetching the photo itself would be opening it)
 */
function Tile({ file, set, cls, label, children, src, mark = null }) {
  const [broken, setBroken] = useState(false);
  return html`<a class=${`bm-tile ${cls}`} ...${viewerLink(set, set.indexOf(file))} aria-label=${label}>
    ${src && !broken ? html`<img src=${src} alt="" loading="lazy" decoding="async" onError=${() => setBroken(true)} />` : mark ? html`<span class="bm-mark">${mark}</span>` : null}
    ${children}
  </a>`;
}

/** Their video on the shared card (../file-viewer.js), the one Applicants shows */
export const Video = ({ m, set, who }) => html`<${VideoTile} f=${m.video} files=${set} index=${set.indexOf(m.video)} title=${`${who}’s video`} />`;

export const Photos = ({ m, set, who, limit = 0 }) => {
  const shown = limit ? m.photos.slice(0, limit) : m.photos;
  const more = m.photos.length - shown.length;
  return html`<ul class="bm-photos">${shown.map((p, i) => html`<li key=${p.id}>
    <${Tile} file=${p} set=${set} cls="bm-photo" label=${`${who}: ${p.label || 'photo'}`} src=${p.thumb} mark=${PICTURE}>
      ${more > 0 && i === shown.length - 1 ? html`<span class="bm-more">+${more}</span>` : null}
    </${Tile}>
    <span class="bm-cap">${p.label || ''}</span>
  </li>`)}</ul>`;
};

/** Why something isn't there: it's on its way, it couldn't be reached, or SOARD doesn't have it */
export function mediaNote(m) {
  if (!m || m.unavailable) return 'The video, photos and application can’t be reached right now. Try again in a minute.';
  if (m.videoSoon) return 'Their video is still being processed. It shows here once it’s ready.';
  return '';
}

/** A family's page: the video large, the application beside it, the photos under them */
export function Media({ f }) {
  const m = f.media;
  const who = f.kind === 'organization' ? f.name : String(f.name || '').split(/\s+/)[0];
  const set = setOf(m);
  const note = mediaNote(m);
  if (!set.length) return html`<section class="bp-card bm" aria-labelledby="bm-h"><h2 class="bp-h2" id="bm-h">What they sent</h2><p class="bp-muted">${note || 'SOARD has no video, photos or application on file for them.'}</p></section>`;
  const sent = m.application ? [m.application.at ? `Sent ${day(m.application.at)}` : '', sizeText(m.application.size)].filter(Boolean).join(' · ') : '';
  const paper = m.application ? html`<div class="bm-paper">
    <${Tile} file=${m.application} set=${set} cls="bm-cover" label=${`Read ${who}’s application`} src=${m.application.thumb}><span class="bm-cover__mark">${PAGE}</span></${Tile}>
    <div class="bm-paper__text"><h3 class="bm-paper__title">The application</h3>${sent ? html`<p class="bp-muted">${sent}</p>` : null}
      <a class="bp-btn bp-btn--primary bp-btn--sm" ...${viewerLink(set, set.indexOf(m.application))}>Read it</a></div>
  </div>` : m.unavailable ? null : html`<p class="bp-muted bm-none">No application on file.</p>`;
  return html`<section class="bp-card bm" aria-labelledby="bm-h">
    <h2 class="bp-h2" id="bm-h">What they sent</h2>
    <div class=${`bm-lead ${m.video ? '' : 'is-short'}`}>
      ${m.video ? html`<${Video} m=${m} set=${set} who=${who} />` : null}
      ${paper}
    </div>
    ${note ? html`<p class="bp-muted bm-note">${note}</p>` : !m.video ? html`<p class="bp-muted bm-note">No video on file.</p>` : null}
    ${m.photos.length ? html`<${Photos} m=${m} set=${set} who=${who} />` : null}
    <p class="bm-private">Shared with the board in confidence. Please keep ${who === f.name ? 'this' : `${who}’s`} application, video and photos to yourself.</p>
  </section>`;
}
