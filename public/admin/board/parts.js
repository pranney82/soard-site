/**
 * What the board's page and the advisors' page draw alike
 * =======================================================
 * The icons, a person's face, a date tile, a section's heading and a fold, and the
 * history-kept state the fold uses. ./portal.js and ../advisory/portal.js import these,
 * so the two pages can't drift apart. Their looks are in ./portal.css.
 */

import { h, htm, useState, useEffect, useRef } from '../vendor.js';
import { isDate, initialsOf } from '../board-shared.js';

const html = htm.bind(h);

// ─── Icons (24px line drawings, in the text's color) ────────────────
export const ICONS = {
  home: html`<path d="M3.5 10.5 12 3.5l8.5 7V20a1 1 0 0 1-1 1H15v-6H9v6H4.5a1 1 0 0 1-1-1z" />`,
  meetings: html`<rect x="3.5" y="5" width="17" height="15.5" rx="2" /><path d="M3.5 10h17M8 3v4M16 3v4" />`,
  financials: html`<path d="M4 20.5h16M7 17v-5M12 17V7M17 17v-8" />`,
  people: html`<circle cx="9" cy="8.5" r="3.25" /><path d="M3 20a6 6 0 0 1 12 0" /><circle cx="17" cy="9.5" r="2.5" /><path d="M16.5 14.6A4.8 4.8 0 0 1 21 19.5" />`,
  documents: html`<path d="M14 3.5H6.5a1 1 0 0 0-1 1v15a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V8z" /><path d="M14 3.5V8h4.5M9 12.5h6M9 16.5h6" />`,
  clock: html`<circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" />`,
  pin: html`<path d="M12 21s-6.5-5.8-6.5-10.5a6.5 6.5 0 0 1 13 0C18.5 15.2 12 21 12 21z" /><circle cx="12" cy="10.5" r="2.25" />`,
  video: html`<rect x="3" y="6.5" width="12.5" height="11" rx="2" /><path d="m15.5 10.5 5.5-3v9l-5.5-3" />`,
  check: html`<path d="m5 12.5 4.5 4.5L19 7.5" />`,
  edit: html`<path d="M4.5 19.5h4l10.5-10.5a2.83 2.83 0 0 0-4-4L4.5 15.5z" /><path d="m13.5 6.5 4 4" />`,
  search: html`<circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.2-4.2" />`,
  arrow: html`<path d="M5 12h14M13 6l6 6-6 6" />`,
  back: html`<path d="M19 12H5M11 18l-6-6 6-6" />`,
  chevron: html`<path d="m6 9 6 6 6-6" />`,
  mail: html`<rect x="3.5" y="5.5" width="17" height="13" rx="2" /><path d="m4 7 8 6 8-6" />`,
  copy: html`<rect x="8.5" y="8.5" width="11" height="11" rx="2" /><path d="M15.5 8.5V6A1.5 1.5 0 0 0 14 4.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5" />`,
  calendar: html`<rect x="3.5" y="5" width="17" height="15.5" rx="2" /><path d="M3.5 10h17M8 3v4M16 3v4M12 13v5M9.5 15.5h5" />`,
  print: html`<path d="M7 9V3.5h10V9M7 17.5H5A1.5 1.5 0 0 1 3.5 16v-5A1.5 1.5 0 0 1 5 9.5h14a1.5 1.5 0 0 1 1.5 1.5v5a1.5 1.5 0 0 1-1.5 1.5h-2" /><rect x="7" y="14" width="10" height="6.5" rx="1" />`,
  close: html`<path d="M6 6l12 12M18 6 6 18" />`,
  plus: html`<path d="M12 5v14M5 12h14" />`,
  logout: html`<path d="M14 4.5h4A1.5 1.5 0 0 1 19.5 6v12a1.5 1.5 0 0 1-1.5 1.5h-4M10 16l-4-4 4-4M6 12h9" />`,
  external: html`<path d="M14 4.5h5.5V10M19.5 4.5 11 13M17 14v4.5a1 1 0 0 1-1 1H5.5a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1H10" />`,
  download: html`<path d="M12 4v11M7 11l5 5 5-5M5 20h14" />`,
  gavel: html`<path d="m13.5 4.5 6 6M11 7l6 6M12.25 5.75l-4.5 4.5M17.75 11.25l-4.5 4.5M10 12l-6.5 6.5M3.5 20.5h9" />`,
  present: html`<rect x="3" y="4.5" width="18" height="12" rx="1.5" /><path d="M12 16.5v3.5M8 20.5h8M10 8.5v4.5l4-2.25z" />`,
  list: html`<path d="M9 6.5h11M9 12h11M9 17.5h11" /><circle cx="4.75" cy="6.5" r="1" /><circle cx="4.75" cy="12" r="1" /><circle cx="4.75" cy="17.5" r="1" />`,
  // The advisors' page
  hello: html`<circle cx="10" cy="8.5" r="3.25" /><path d="M4 20a6 6 0 0 1 12 0M18 8v6M15 11h6" />`,
  heart: html`<path d="M12 20.5s-8-4.9-8-10.6A4.4 4.4 0 0 1 12 7.4a4.4 4.4 0 0 1 8 2.5c0 5.7-8 10.6-8 10.6z" />`,
  sliders: html`<path d="M4 7h9M17 7h3M4 12h3M11 12h9M4 17h11M19 17h1" /><circle cx="15" cy="7" r="2" /><circle cx="9" cy="12" r="2" /><circle cx="17" cy="17" r="2" />`,
  share: html`<circle cx="6" cy="12" r="2.5" /><circle cx="17.5" cy="6" r="2.5" /><circle cx="17.5" cy="18" r="2.5" /><path d="m8.2 10.9 7.1-3.7M8.2 13.1l7.1 3.7" />`,
  star: html`<path d="M12 3.5c.7 5 3.5 7.8 8.5 8.5-5 .7-7.8 3.5-8.5 8.5-.7-5-3.5-7.8-8.5-8.5 5-.7 7.8-3.5 8.5-8.5z" />`,
};

export const Icon = ({ name, size = 20, cls = '' }) => html`<svg class=${`bp-icon ${cls}`} width=${size} height=${size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`;

// ─── Words and dates ────────────────────────────────────────────────
/** A count that stays with its word, and a year with the word before it, on a narrow phone ("1 awaiting", "in 2026") */
export const nbw = (s) => String(s ?? '').replace(/(\d[KMB%]?) (?=\p{L})/gu, '$1\u00a0').replace(/(\p{L}) (?=\d{4}\b)/gu, '$1\u00a0');
export const mapsHref = (s) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(s)}`;
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
export const hueOf = (s) => [42, 28, 96, 152, 200, 18][[...String(s)].reduce((a, c) => a + c.charCodeAt(0), 0) % 6];

export const noon = (d) => Date.parse(`${d}T12:00:00Z`);

export const partsOf = (d) => { const t = new Date(noon(d)); return { mon: t.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' }), day: t.getUTCDate(), wk: t.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }), year: t.getUTCFullYear() }; };

export const together = (names) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0] || '');


// ─── Where you were ─────────────────────────────────────────────────
export const kept = () => (history.state && typeof history.state === 'object' ? history.state : {});
export const keep = (patch) => { try { history.replaceState({ ...kept(), ...patch }, ''); } catch { /* the browser's limit on how often: the next one saves it */ } };
/** useState that this step in the history remembers (`key` unique on its page) */
export function useKept(key, initial) {
  const [v, setV] = useState(() => (kept().ui && key in kept().ui ? kept().ui[key] : initial));
  const set = (x) => setV((was) => {
    const now = typeof x === 'function' ? x(was) : x;
    keep({ ui: { ...(kept().ui || {}), [key]: now } });
    dispatchEvent(new Event('bp-kept'));
    return now;
  });
  return [v, set];
}

// ─── Shared pieces ──────────────────────────────────────────────────
export function Avatar({ p, size = 40, ring = false, named = false }) {
  const [broken, setBroken] = useState('');
  const name = p?.name || '';
  const style = `--s:${size}px`;
  // In a row of faces each says whose it is on hover
  const title = named && name ? name : null;
  return p?.photo && broken !== p.photo
    ? html`<img class=${`bp-avatar ${ring ? 'bp-avatar--ring' : ''}`} src=${p.photo} alt="" title=${title} loading="lazy" decoding="async" width=${size} height=${size} style=${style} onError=${() => setBroken(p.photo)} />`
    : html`<span class=${`bp-avatar bp-avatar--initials ${ring ? 'bp-avatar--ring' : ''}`} style=${`${style};--hue:${hueOf(name)}`} data-i=${initialsOf(name)} title=${title} aria-hidden="true"></span>`;
}
/** A row of faces, each named on hover (and all of them to a screen reader); "+3" names the rest */
export function Faces({ people, max = 6, size = 32 }) {
  const shown = people.slice(0, max);
  const rest = people.slice(max);
  const names = people.map((p) => p.name).filter(Boolean);
  return html`<span class="bp-faces" style=${`--s:${size}px`} role=${names.length ? 'img' : null} aria-label=${names.length ? together(names) : null}>${shown.map((p) => html`<${Avatar} p=${p} size=${size} ring named key=${p.slug || p.name} />`)}${rest.length ? html`<span class="bp-faces__more" title=${together(rest.map((p) => p.name).filter(Boolean)) || null}>+${rest.length}</span>` : null}</span>`;
}
export function DateTile({ d, mid = null, big = false, head = false }) {
  if (!isDate(d)) return null;
  const p = partsOf(d);
  return html`<span class=${`bp-date ${big ? 'bp-date--big' : ''}`} data-mid=${mid} style=${head ? 'view-transition-name: bp-morph' : null} aria-hidden="true">
    <span class="bp-date__mon">${p.mon}</span><strong class="bp-date__day">${p.day}</strong>${big ? html`<span class="bp-date__wk">${p.wk}</span>` : null}
  </span>`;
}
/** Where a reveal's window starts ({ part: 'mid', month: '2026-11' } → "2026-11-11"), for putting it in order */
export const windowStart = (w) => (/^\d{4}-\d{2}$/.test(String(w?.month || '')) ? `${w.month}-${{ early: '01', mid: '11', late: '21' }[w.part] || '01'}` : '');
/** A reveal whose day isn't set: "mid" November */
export function WindowTile({ w }) {
  const start = windowStart(w);
  return html`<span class="bp-date bp-date--soft" aria-hidden="true"><span class="bp-date__mon">${start ? partsOf(start).mon : ''}</span><strong class="bp-date__day bp-date__day--word">${w?.part || '·'}</strong></span>`;
}
export function SecHead({ title, sub = '', count = null, id, children }) {
  return html`<div class="bp-sechead">
    <div><h2 class="bp-h2" id=${id}>${title}${count != null ? html`<span class="bp-count">${count}</span>` : null}</h2>${sub ? html`<p class="bp-sub">${sub}</p>` : null}</div>
    ${children || null}
  </div>`;
}
/** A fold that this step in the history remembers open (Back to the page finds it as it was) */
export function More({ k, summary, children }) {
  const [open, setOpen] = useKept(`more-${k}`, false);
  return html`<details class="bp-more" open=${open} onToggle=${(e) => { if (e.currentTarget.open !== open) setOpen(e.currentTarget.open); }}><summary>${summary}</summary>${children}</details>`;
}

/**
 * The pages. The yellow marker is one element that slides behind the labels to the open page (a CSS move).
 * It's never part of the page's view transition: as its own layer there it was drawn over the labels while it moved.
 * items: [[page, label, icon, short label for the phone's bar]]; due: { page: how many to sign }.
 */
export function PageNav({ items, page, label, due = {} }) {
  const ref = useRef(null);
  const [ink, setInk] = useState(null);
  useEffect(() => {
    const place = () => {
      const a = ref.current?.querySelector('a[aria-current="page"]');
      if (a) setInk((was) => ({ x: a.offsetLeft, y: a.offsetTop, w: a.offsetWidth, h: a.offsetHeight, moving: !!was }));
    };
    place();
    document.fonts?.ready.then(place);
    addEventListener('resize', place);
    return () => removeEventListener('resize', place);
  }, [page, items.length]);
  return html`<nav class="bp-nav" aria-label=${label} ref=${ref}>
    ${ink ? html`<span class=${`bp-nav__ink ${ink.moving ? 'is-moving' : ''}`} style=${`--x:${ink.x}px;--y:${ink.y}px;--w:${ink.w}px;--h:${ink.h}px`} aria-hidden="true"></span>` : null}
    ${items.map(([p, text, icon, short]) => html`<a href=${`#/${p}`} aria-current=${page === p ? 'page' : null} key=${p}>
      <${Icon} name=${icon} size=${20} />${short ? html`<span class="bp-nav__label bp-nav__label--long">${text}</span><span class="bp-nav__label bp-nav__label--short">${short}</span>` : html`<span class="bp-nav__label">${text}</span>`}${due[p] ? html`<span class="bp-nav__due" aria-label=${`${due[p]} to sign`}>${due[p]}</span>` : null}
    </a>`)}
  </nav>`;
}
