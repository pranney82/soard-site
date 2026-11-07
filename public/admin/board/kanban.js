/**
 * The makeovers as a board: a column per stage, Awaiting funding, then Design
 * to Build, from JobTread (numbers.projects, see _board.js projectsNow). Each
 * card leads with the kid's photo, then their name and the reveal: the day
 * and time once it's set, else the part of the month. A kid or organization
 * with no photo yet has a flat block with initials in its place.
 *
 * One board, three places: Home (`home`), the makeovers item of a meeting's
 * agenda (`agenda`), and the meeting on the screen (`screen`, sized to fill a
 * TV without scrolling: the busier the columns, the smaller the cards).
 */

import { h, htm } from '../vendor.js';
import { sized } from './parts.js';
import { shortDate, clock, plural, initialsOf } from '../board-shared.js';

const html = htm.bind(h);
export { sized };
// "+2 more families", "10 AM": the number kept with its word
const kept = (s) => s.replace(/(\d) (\S+)/, '$1 $2');

export const AWAITING = 'Awaiting Funding';
const STAGE_FLOW = ['Design', 'Finalization', 'Approval', 'Mobilization', 'Build'];
// The narrowest a makeover's card goes on the screen, in the screen's units (175px at 1080p)
const CARD_MIN = 11;
// A reveal's part of a month as the day it starts ("2026-11" late → "2026-11-21"), to put reveals in order
const windowStartOf = (w) => (/^\d{4}-\d{2}$/.test(String(w?.month || '')) ? `${w.month}-${{ early: '01', mid: '11', late: '21' }[w.part] || '01'}` : '');
const hueOf = (s) => [42, 28, 96, 152, 200, 18][[...String(s)].reduce((a, c) => a + c.charCodeAt(0), 0) % 6];
const CAL = html`<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="3.5" y="5" width="17" height="15.5" rx="2" /><path d="M3.5 10h17M8 3v4M16 3v4" /></svg>`;

/** Where a makeover's link goes: a kid's page, or a community project's page once it's public */
/** A makeover's card on Home, for a search to land on */
/**
 * A name's widest line, in letters, set in two lines (the break that leaves the shorter longest line) and in one: the
 * screen sets it no bigger than its card fits ("Perfect Harmony / Health" whole, not "Perfect / Harmony…")
 */
export function nameFit(name) {
  const words = String(name || '').trim().split(/\s+/);
  const one = words.join(' ').length;
  let two = one;
  for (let k = 1; k < words.length; k++) two = Math.min(two, Math.max(words.slice(0, k).join(' ').length, words.slice(k).join(' ').length));
  // (and its longest piece no line can break inside: a hyphenated name breaks after its hyphen)
  const piece = Math.max(...words.flatMap((w) => w.split(/(?<=-)/)).map((w) => w.length));
  return `--c1:${Math.max(4, one)};--c2:${Math.max(4, two)};--w:${Math.max(4, piece)}`;
}
export const cardId = (b) => `kb-${String(b.slug || b.name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
export const hrefOf = (b) => (b.kind === 'community' ? b.url || '' : b.url || (b.slug ? `/kids/${b.slug}/` : ''));

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
    if (r?.confirmed && r.date) return html`<span class="bk-card__reveal is-set">${CAL}Reveal ${shortDate(r.date).replace(/, \d{4}$/, '')}${r.time ? ` · ${kept(clock(r.time).replace(':00', ''))}` : ''}</span>`;
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
      <span class="bk-card__body"><span class="bk-card__name" title=${b.name}>${b.name}</span>${reveal(b)}</span>`;
    // (an id a search for them lands on: Home's board brought round to their card)
    return html`<li key=${b.slug || b.name} id=${variant === 'home' ? cardId(b) : null}>${href ? html`<a class="bk-card" href=${href} target="_blank" rel="noopener">${inner}</a>` : html`<div class="bk-card">${inner}</div>`}</li>`;
  };
  // On the screen every card has to fit: the fullest column decides how big they all are
  const most = Math.max(1, ...cols.map((c) => c.list.filter((b) => b.name).length + (c.list.some((b) => !b.name) ? 1 : 0)));
  return html`<div class=${`bk bk--${variant}`} style=${`--cols:${cols.length};--rows:${Math.max(2, most)}`} data-dense=${most > 3 ? (most > 5 ? 'more' : 'yes') : null}>
    ${cols.map(({ stage, label, list }) => {
      const named = list.filter((b) => b.name);
      const unnamed = list.filter((b) => !b.name && b.kind !== 'community').length;
      const orgs = list.filter((b) => !b.name && b.kind === 'community').length;
      return html`<div class=${`bk-col ${list.length ? '' : 'is-empty'}`} key=${stage}>
        <p class="bk-col__head"><span title=${label}>${label}</span><span class="bk-col__n">${list.length}</span></p>
        <ul class="bk-col__cards">
          ${named.map(card)}
          ${unnamed ? html`<li><span class="bk-card is-quiet"><span class="bk-card__body"><span class="bk-card__name">${kept(named.length ? `+${unnamed} more ${unnamed === 1 ? 'family' : 'families'}` : plural(unnamed, 'family', 'families'))}</span><span class="bk-card__reveal is-quiet">Named once their page is up</span></span></span></li>` : null}
          ${orgs ? html`<li><span class="bk-card is-quiet"><span class="bk-card__body"><span class="bk-card__name">${kept(plural(orgs, 'community project'))}</span><span class="bk-card__reveal is-quiet">Not on Community yet</span></span></span></li>` : null}
          ${list.length ? null : html`<li class="bk-col__none">None now</li>`}
        </ul>
      </div>`;
    })}
  </div>`;
}

/**
 * The makeovers on the meeting's screen: the stages as one track left to right toward the reveal, each with how many
 * and its families under it, photo first and as big as the screen allows. Every card fits without scrolling: the
 * more families, the more rows (one, two or three), and a stage with none is a sliver of the track, not a column.
 * Past what fits at a size the room can read, each stage shows its soonest reveals and "+N more"
 */
export function Pipeline({ projects, reveals = [] }) {
  if (!projects) return html`<p class="bs-quiet">The makeovers from JobTread aren’t available right now.</p>`;
  const revealOf = (b) => (b.slug ? reveals.find((r) => r.slug === b.slug) : null);
  // In each stage the soonest reveal first (a set day, then the part of the month), so a full stage shows who's next
  const soon = (b) => { const r = revealOf(b); return r?.confirmed && r.date ? r.date : windowStartOf(r?.window) || '9999'; };
  const all = columnsOf(projects).map((c) => {
    const named = c.list.filter((b) => b.name).sort((a, b) => soon(a).localeCompare(soon(b)));
    const families = c.list.filter((b) => !b.name && b.kind !== 'community').length;
    const orgs = c.list.filter((b) => !b.name && b.kind === 'community').length;
    return { ...c, named, families, orgs, cards: named.length + (families ? 1 : 0) + (orgs ? 1 : 0) };
  });
  const total = all.reduce((n, c) => n + c.cards, 0);
  if (!total) return html`<p class="bs-quiet bs-pipe__none">No makeovers in progress right now.</p>`;
  // How many cards fit across: each at least CARD_MIN of the screen's units wide (a "Date to come" tag and a name at
  // its full size), in the slide's width (an item is at most 98 units, inside the stage's 3.8 each side) less the empty
  // stages' slivers and the reveal's end. A phone stacks the stages, so only the old limit of ten across holds there
  const vw = typeof innerWidth === 'number' ? innerWidth : 1600;
  const unit = Math.min((typeof innerHeight === 'number' ? innerHeight : 900) * 0.0148, vw * 0.0083);
  const slivers = all.filter((c) => !c.cards).length;
  const fits = vw <= 900 ? 10 : Math.max(1, Math.floor((Math.min(98, vw / unit - 7.6) - 7 - slivers * (8.5 + 1.81)) / (CARD_MIN + 1.81)));
  // One row, two or three as the families need; when even three won't hold them all, two (a photo in three rows is a
  // sliver) and each stage's soonest
  const need = (r) => all.reduce((t, c) => t + (c.cards ? Math.ceil(c.cards / r) : 0), 0);
  const rows = total <= 6 && need(1) <= fits ? 1 : total <= 14 && need(2) <= fits ? 2 : need(3) <= fits ? 3 : 2;
  // Each stage the columns its cards need; when that's more than fit, a column each and the rest one at a time to the
  // stage with the most families still out of view (the later stage on a tie: it's nearer its reveal)
  const width = all.map((c) => (c.cards ? Math.ceil(c.cards / rows) : 0));
  if (need(rows) > fits) {
    width.forEach((w, i) => { width[i] = Math.min(w, 1); });
    for (let left = fits - width.reduce((a, b) => a + b, 0); left > 0; left--) {
      let k = -1;
      all.forEach((c, i) => { if (c.cards > width[i] * rows && (k < 0 || c.cards - width[i] * rows >= all[k].cards - width[k] * rows)) k = i; });
      if (k < 0) break;
      width[k]++;
    }
  }
  // A stage with more families than its cards: its soonest, and "+N more" in the last card
  const cols = all.map((c, i) => {
    const room = width[i] * rows;
    if (!c.cards || c.cards <= room) return { ...c, over: 0, across: Math.max(1, width[i]) };
    return { ...c, named: c.named.slice(0, room - 1), families: 0, orgs: 0, over: c.list.length - (room - 1), cards: room, across: width[i] };
  });
  // One column a card across every stage (each stage spans its own), so every card is the same width; a stage with none
  // a sliver; the reveal the line's end, a column of its own past the last stage's cards
  const template = [...cols.map((c) => (c.cards ? Array(c.across).fill('minmax(0, 1fr)').join(' ') : 'minmax(calc(var(--bs-u) * 8.5), 0.45fr)')), 'minmax(calc(var(--bs-u) * 7), 0.4fr)'].join(' ');
  // The reveal's tag: in full on a big card ("Reveal mid November"), short on a small one ("Mid Nov", "Nov 6 · 1 PM")
  const roomy = rows === 1;
  const monthOf = (w) => (/^\d{4}-\d{2}$/.test(String(w?.month || '')) ? new Date(`${w.month}-15T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' }) : '');
  const when = (b) => {
    if (b.kind === 'community') return html`<span class="bs-pipe__when is-quiet">${roomy ? 'Community project' : 'Community'}</span>`;
    const r = revealOf(b);
    // (the day alone on a small card: the reveals slide has its time)
    if (r?.confirmed && r.date) return html`<span class="bs-pipe__when is-set">${roomy ? 'Reveal ' : ''}${shortDate(r.date).replace(/, \d{4}$/, '')}${roomy && r.time ? ` · ${kept(clock(r.time).replace(':00', ''))}` : ''}</span>`;
    if (r?.window?.label) return html`<span class="bs-pipe__when">${roomy || !monthOf(r.window) || !r.window.part ? `${roomy ? 'Reveal ' : ''}${r.window.label}` : `${r.window.part.charAt(0).toUpperCase()}${r.window.part.slice(1)} ${monthOf(r.window)}`}</span>`;
    return b.status === AWAITING ? null : html`<span class="bs-pipe__when is-quiet">${roomy ? 'Reveal date to come' : 'Date to come'}</span>`;
  };
  // Each photo cut to its card's shape around the face: tall on one row, wider on two or three
  const crop = rows === 1 ? 'w=640,h=760' : rows === 2 ? 'w=640,h=520' : 'w=640,h=380';
  // The reveal on the photo's corner, the name under it (in a box of its own the name is sized against: a card that's
  // a container can't share the rows, so its photo would lose its height)
  const card = (b) => html`<li class="bs-pipe__card" key=${b.slug || b.name}>
    <span class="bs-pipe__photo">${b.photo
      ? html`<img src=${sized(b.photo, `${crop},fit=cover,gravity=face`)} alt="" decoding="async" />`
      : html`<span class="bs-pipe__initials" style=${`--hue:${hueOf(b.name)}`} aria-hidden="true">${initialsOf(b.name)}</span>`}${when(b)}</span>
    <span class="bs-pipe__namebox"><span class="bs-pipe__name" style=${nameFit(b.name)}>${b.name}</span></span>
  </li>`;
  const quiet = (words, sub) => html`<li class="bs-pipe__card is-quiet"><span class="bs-pipe__name">${words}</span><span class="bs-pipe__when is-quiet">${sub}</span></li>`;
  const units = cols.reduce((t, c) => t + (c.cards ? c.across : 0.45), 0.4);
  return html`<div class="bs-pipe" data-rows=${rows} style=${`--tmpl:${template};--rows:${rows};--units:${units}`}>
    <ol class="bs-pipe__track" aria-label="The makeovers by stage">${cols.map((c) => html`<li class=${c.cards ? '' : 'is-empty'} style=${`--across:${c.cards ? c.across : 1}`} key=${c.stage}>
      <span class="bs-pipe__n">${c.list.length}</span><span class="bs-pipe__stage">${c.label}</span>
    </li>`)}<li class="is-end"><span class="bs-pipe__end">Reveal</span></li></ol>
    <div class="bs-pipe__cols">${cols.map((c) => html`<div class=${`bs-pipe__col ${c.cards ? '' : 'is-empty'}`} style=${`--across:${c.cards ? c.across : 1}`} key=${c.stage}>
      <p class="bs-pipe__colhead"><span>${c.label}</span><span class="bs-pipe__n">${c.list.length}</span></p>
      <ul>
        ${c.named.map(card)}
        ${c.families ? quiet(c.named.length ? `+${c.families} more ${c.families === 1 ? 'family' : 'families'}` : plural(c.families, 'family', 'families'), 'Named once their page is up') : null}
        ${c.orgs ? quiet(plural(c.orgs, 'community project'), 'Not on Community yet') : null}
        ${c.over > 0 ? quiet(`+${c.over} more`, 'in this stage') : null}
      </ul>
    </div>`)}<div class="bs-pipe__col is-end" aria-hidden="true"></div></div>
  </div>`;
}
