/**
 * The map of the families who applied, shared by Applicants (./applicants.js)
 * and the board page (./board/family-map.js): one look, drawn one way.
 * ===========================================================================
 * Leaflet (./vendor-map.js, loaded the first time a map opens) on
 * OpenStreetMap's own tiles (no key), quieted to gray so the pins carry the
 * color; the service area the way families see it on the form (yellow fill,
 * charcoal line, the "close" ring dashed); a pin in its status's color.
 */

import { h, htm } from './vendor.js';
import { nearRing } from './area-shared.js';

const html = htm.bind(h);

export const STATUS_COLOR = { Applied: '#2B6CB0', 'In Review': '#B7791F', Approved: '#2F7D4F', Denied: '#7C7D84', '': '#A3A4AA' };
export const AREA_INK = '#373A36';
export const AREA_FILL = '#FFDA24';

// (a count stays on the line with its word)
const plural = (n, one, many = `${one}s`) => `${n}\u00a0${n === 1 ? one : many}`;

const CSS = `
.apl-legend { position: absolute; z-index: 500; top: .75rem; left: .75rem; background: rgba(255,255,255,.96); border: 1px solid var(--color-border, rgba(45,47,44,.1)); border-radius: 10px; box-shadow: var(--shadow-md, 0 6px 18px -8px rgba(45,47,44,.28)); padding: .55rem .6rem; display: grid; gap: .2rem; min-width: 190px; }
.apl-legend button { all: unset; display: flex; align-items: center; gap: .5rem; font-size: var(--fs-xs, .82rem); padding: .25rem .35rem; border-radius: 6px; cursor: pointer; }
.apl-legend button:hover { background: var(--color-bg-hover, rgba(45,47,44,.05)); }
.apl-legend button:focus-visible { outline: 2px solid var(--color-text, #2D2F2C); }
.apl-legend button[aria-pressed="false"] { opacity: .45; }
.apl-legend b { margin-left: auto; font-variant-numeric: tabular-nums; }
.apl-legend-line { display: flex; align-items: center; gap: .5rem; font-size: var(--fs-xs, .82rem); color: var(--color-text-secondary, #5F615A); padding: .3rem .35rem 0; border-top: 1px solid var(--color-border, rgba(45,47,44,.1)); margin-top: .2rem; }
.apl-legend-line.is-plain { border-top: 0; margin-top: 0; padding-top: 0; }
.apl-legend-line i { width: 18px; height: 11px; border: 2px solid ${AREA_INK}; background: color-mix(in srgb, ${AREA_FILL} 45%, transparent); border-radius: 3px; display: inline-block; }
.apl-legend-line i.is-ring { background: none; border: 1.5px dashed ${AREA_INK}; opacity: .7; }
.apl-legend-note { font-size: var(--fs-xs, .8rem); color: var(--color-text-secondary, #5F615A); padding: .2rem .35rem 0; }
.apl-legend .apl-dot { display: inline-block; flex: none; width: 10px; height: 10px; border-radius: 50%; }
.apl-pin { width: 18px; height: 18px; border-radius: 50%; background: var(--c); border: 2.5px solid #fff; box-shadow: 0 1px 4px rgba(0,0,0,.35); transition: transform .15s; }
.apl-pin.is-moving { box-shadow: 0 0 0 3px #fff, 0 0 0 5.5px ${AREA_INK}, 0 1px 4px rgba(0,0,0,.35); }
.apl-pin.is-focus { transform: scale(1.5); box-shadow: 0 0 0 6px color-mix(in srgb, var(--c) 30%, transparent), 0 1px 4px rgba(0,0,0,.35); }
.leaflet-container { font: inherit; }
.apl-tiles { filter: grayscale(1) contrast(.8) brightness(1.13); }
.leaflet-container img { max-width: none !important; max-height: none !important; border-radius: 0 !important; box-shadow: none !important; }
.leaflet-popup-content-wrapper { border-radius: 12px; box-shadow: var(--shadow-lg, 0 18px 40px -14px rgba(45,47,44,.3)); }
`;
if (typeof document !== 'undefined' && !document.getElementById('family-map-css')) {
  const el = document.createElement('style');
  el.id = 'family-map-css';
  el.textContent = CSS;
  document.head.appendChild(el);
}

let _leaflet = null;
/** Leaflet, the first time a map opens (and its own CSS, which lands after everything else) */
export function loadLeaflet() {
  _leaflet ||= import('./vendor-map.js').then((m) => {
    const el = document.createElement('style');
    el.textContent = m.leafletCss;
    document.head.appendChild(el);
    return m.L;
  }).catch((e) => { _leaflet = null; throw e; });
  return _leaflet;
}

/** A map goes once any zoom has finished: Leaflet throws if it's taken down partway through one */
export const takeDown = (map) => setTimeout(() => map.remove(), 300);

/** OpenStreetMap's tiles and the credit they ask for, the zoom buttons bottom right */
export function dressMap(L, map, { credit = '' } = {}) {
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  map.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>');
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19, className: 'apl-tiles',
    attribution: `© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>${credit}`,
  }).addTo(map);
}

/** The service area's shape */
export const areaShape = (L, polygon, opts = {}) => L.polygon(polygon, { color: AREA_INK, weight: 2.5, opacity: 0.95, fillColor: AREA_FILL, fillOpacity: 0.16, interactive: false, ...opts });
/** The dashed "close" ring around it, or null when there's no ring to draw */
export function closeRing(L, polygon, nearMiles) {
  const ring = nearMiles > 0 && polygon?.length >= 3 ? nearRing(polygon, nearMiles) : [];
  return ring.length ? L.polygon(ring, { color: AREA_INK, weight: 1.5, opacity: 0.6, dashArray: '5 6', fill: false, interactive: false }) : null;
}
/** A family's pin, in its status's color (`cls`: is-focus, is-moving) */
export const pinIcon = (L, color, cls = '') => L.divIcon({ className: '', html: `<div class="apl-pin${cls ? ` ${cls}` : ''}" style="--c:${color}"></div>`, iconSize: [18, 18], iconAnchor: [9, 9] });

/**
 * The key: a switch for each status with how many are on the map, the area and its ring, and who has no point.
 * `counts`: { [status]: n } with '' for a family with no status; `hidden`: a Set of statuses switched off
 */
export function MapLegend({ counts, hidden, onToggle, outside = 0, nearMiles = 0, noPoint = 0 }) {
  return html`<div class="apl-legend">
    ${['Applied', 'In Review', 'Approved', 'Denied', ...(counts[''] ? [''] : [])].map((s) => html`<button key=${s} aria-pressed=${!hidden.has(s)} onClick=${() => onToggle(s)}>
      <span class="apl-dot" style=${`background:${STATUS_COLOR[s]}`}></span>${s || 'No status'}<b>${counts[s] || 0}</b></button>`)}
    <div class="apl-legend-line"><i></i> Service area${outside ? ` · ${outside} outside` : ''}</div>
    ${nearMiles > 0 ? html`<div class="apl-legend-line is-plain"><i class="is-ring"></i> Close: within ${plural(nearMiles, 'mile')}</div>` : null}
    ${noPoint > 0 ? html`<div class="apl-legend-note">${plural(noPoint, 'family has', 'families have')} no home in JobTread yet</div>` : null}
  </div>`;
}
