/**
 * The makeovers as a board: a column per stage, Awaiting funding, then Design
 * to Build, from JobTread (numbers.projects, see _board.js projectsNow). Each
 * card leads with the kid's photo, then their name and the reveal: the day
 * and time once it's set, else the part of the month. A kid with no photo
 * yet, or an organization's room, has a flat block with initials in its place.
 *
 * One board, three places: Home (`home`), the makeovers item of a meeting's
 * agenda (`agenda`), and the meeting on the screen (`screen`, sized to fill a
 * TV without scrolling: the busier the columns, the smaller the cards).
 */

import { h, htm } from '../vendor.js';
import { shortDate, clock, plural } from '../board-shared.js';

const html = htm.bind(h);

export const AWAITING = 'Awaiting Funding';
const STAGE_FLOW = ['Design', 'Finalization', 'Approval', 'Mobilization', 'Build'];
const initialsOf = (name) => { const w = String(name || '').split(/\s+/).filter(Boolean); return ((w[0]?.[0] || '') + (w.length > 1 ? w.at(-1)[0] : '')).toUpperCase() || '?'; };
const hueOf = (s) => [42, 28, 96, 152, 200, 18][[...String(s)].reduce((a, c) => a + c.charCodeAt(0), 0) % 6];
const CAL = html`<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="3.5" y="5" width="17" height="15.5" rx="2" /><path d="M3.5 10h17M8 3v4M16 3v4" /></svg>`;

/** A Cloudflare photo at the size it's shown, through the site so it's same-origin */
export function sized(url, transform) {
  const s = String(url || '');
  const m = s.match(/^(?:https:\/\/imagedelivery\.net|(?:https?:\/\/[^/]+)?\/cdn-cgi\/imagedelivery)\/([^/]+)\/(.+)$/);
  if (!m) return s;
  let id = m[2];
  const cut = id.lastIndexOf('/');
  if (cut > 0 && /=|^(public|thumbnail|avatar|hero|card)$/.test(id.slice(cut + 1))) id = id.slice(0, cut);
  return `/cdn-cgi/imagedelivery/${m[1]}/${id}/${transform}`;
}
/** Where a makeover's link goes: a kid's page, or a community project's page once it's public */
const hrefOf = (b) => (b.kind === 'community' ? b.url || '' : b.url || (b.slug ? `/kids/${b.slug}/` : ''));

/** The columns, in order, each with its cards: [{ stage, label, list }] */
export function columnsOf(projects) {
  const building = projects?.building || [];
  const waiting = projects?.waiting || [];
  const all = [...waiting, ...building];
  const stages = [AWAITING, ...STAGE_FLOW.filter((st) => st !== 'Finalization' || building.some((b) => b.status === st)), ...new Set(building.map((b) => b.status).filter((st) => !STAGE_FLOW.includes(st)))];
  return stages.map((stage) => ({ stage, label: stage === AWAITING ? 'Awaiting funding' : stage, list: all.filter((b) => b.status === stage) }));
}
/** "6 in progress · 3 awaiting funding" */
export function kanbanLine(projects) {
  const building = projects?.building || [];
  const waiting = projects?.waiting || [];
  return [building.length ? `${building.length} in progress` : '', waiting.length ? `${waiting.length} awaiting funding` : ''].filter(Boolean).join(' · ');
}

/**
 * The board itself. `reveals` are numbers.reveals (a kid's reveal on their card); `variant` is home, agenda or
 * screen; `links` makes each card open its page (never on the screen).
 */
export function Kanban({ projects, reveals = [], variant = 'home', links = variant !== 'screen' }) {
  if (!projects) return html`<p class="bk-none">The makeovers from JobTread aren’t available right now.</p>`;
  const cols = columnsOf(projects);
  const revealOf = (b) => (b.slug ? reveals.find((r) => r.slug === b.slug) : null);
  const reveal = (b) => {
    if (b.kind === 'community') return html`<span class="bk-card__reveal is-quiet">Community project</span>`;
    const r = revealOf(b);
    if (r?.confirmed && r.date) return html`<span class="bk-card__reveal is-set">${CAL}Reveal ${shortDate(r.date).replace(/, \d{4}$/, '')}${r.time ? ` · ${clock(r.time).replace(':00', '')}` : ''}</span>`;
    if (r?.window?.label) return html`<span class="bk-card__reveal">${CAL}Reveal ${r.window.label}</span>`;
    // Awaiting funding: the column says why there's no date yet
    return b.status === AWAITING ? null : html`<span class="bk-card__reveal is-quiet">Reveal date to come</span>`;
  };
  // The screen's cards are wide and short: the crop is that shape, around the face, so nobody's head is cut off
  const photoSize = variant === 'screen' ? 'w=720,h=300,fit=cover,gravity=face' : 'w=560,h=380,fit=cover,gravity=face';
  const card = (b) => {
    const href = links ? hrefOf(b) : '';
    const inner = html`<span class="bk-card__photo">${b.photo
      ? html`<img src=${sized(b.photo, photoSize)} alt="" loading=${variant === 'screen' ? 'eager' : 'lazy'} decoding="async" width="280" height="190" />`
      : html`<span class="bk-card__initials" style=${`--hue:${hueOf(b.name)}`} aria-hidden="true">${initialsOf(b.name)}</span>`}</span>
      <span class="bk-card__body"><span class="bk-card__name">${b.name}</span>${reveal(b)}</span>`;
    return html`<li key=${b.slug || b.name}>${href ? html`<a class="bk-card" href=${href} target="_blank" rel="noopener">${inner}</a>` : html`<div class="bk-card">${inner}</div>`}</li>`;
  };
  // On the screen every card has to fit: the fullest column decides how big they all are
  const most = Math.max(1, ...cols.map((c) => c.list.filter((b) => b.name).length + (c.list.some((b) => !b.name) ? 1 : 0)));
  return html`<div class=${`bk bk--${variant}`} style=${`--cols:${cols.length};--rows:${Math.max(2, most)}`} data-dense=${most > 3 ? (most > 5 ? 'more' : 'yes') : null}>
    ${cols.map(({ stage, label, list }) => {
      const named = list.filter((b) => b.name);
      const unnamed = list.filter((b) => !b.name && b.kind !== 'community').length;
      const orgs = list.filter((b) => !b.name && b.kind === 'community').length;
      return html`<div class=${`bk-col ${list.length ? '' : 'is-empty'} ${stage === AWAITING ? 'is-waiting' : ''}`} key=${stage}>
        <p class="bk-col__head"><span>${label}</span><span class="bk-col__n">${list.length}</span></p>
        <ul class="bk-col__cards">
          ${named.map(card)}
          ${unnamed ? html`<li><span class="bk-card is-quiet"><span class="bk-card__body"><span class="bk-card__name">${named.length ? `+${unnamed} more ${unnamed === 1 ? 'family' : 'families'}` : plural(unnamed, 'family', 'families')}</span><span class="bk-card__reveal is-quiet">Named once their page is up</span></span></span></li>` : null}
          ${orgs ? html`<li><span class="bk-card is-quiet"><span class="bk-card__body"><span class="bk-card__name">${plural(orgs, 'community project')}</span><span class="bk-card__reveal is-quiet">Not on Community yet</span></span></span></li>` : null}
          ${list.length ? null : html`<li class="bk-col__none">None now</li>`}
        </ul>
      </div>`;
    })}
  </div>`;
}
