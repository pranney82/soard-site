/**
 * The service-area map on the application (and on its "outside" stop screen)
 * ===========================================================================
 * Drawn here from the live outline (Admin → Applicants → Map), so it always
 * shows the area the address check uses: county lines, the interstates and
 * towns for bearings (./area-map-data.js, Census public domain), the area in
 * SOARD yellow, and the family's home as a pin once their address is placed.
 *
 * Shapes are SVG; town names, county names and the pin are HTML laid over it
 * by percentage, so they stay readable at phone width, and declutter() hides
 * any name that would land on a more important one at the size it's shown.
 * A home a little way out widens the view to include it; one far away gets an
 * arrow on the edge pointing to it, with the distance.
 */
import { COUNTIES, ROADS, TOWNS, COUNTY_LABELS } from './area-map-data.js';
import { milesBetween, areaCenter } from '../../../public/admin/area-shared.js';

const W = 1000;               // the drawing's width in SVG units (its height follows the view)
const DOWNTOWN = [33.749, -84.388];
const WIDE_MILES = 32;        // a home this far from the area's middle or less is brought into view
const PAD = 0.07;
const SERVED = new Set(['Cherokee', 'Cobb', 'DeKalb', 'Forsyth', 'Fulton', 'Gwinnett']); // other county names only on a wide map
const PIN = '<svg class="af-map-pin-head" viewBox="0 0 26 34" aria-hidden="true"><path d="M13 33S2 20.6 2 12.6a11 11 0 0 1 22 0C24 20.6 13 33 13 33z" fill="#373A36"/><circle cx="13" cy="12.6" r="4.8" fill="#FFDA24"/></svg>';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const pairs = (flat) => { const out = []; for (let i = 0; i < flat.length; i += 2) out.push([flat[i], flat[i + 1]]); return out; };

/** The window to draw: the area and downtown (and a home near enough), padded, not too tall or too wide */
function viewFor(polygon, home) {
  const pts = [...polygon, DOWNTOWN];
  const center = areaCenter(polygon);
  const reach = home && milesBetween(center, home) <= WIDE_MILES;
  if (reach) pts.push(home);
  let s = Math.min(...pts.map(p => p[0])); let n = Math.max(...pts.map(p => p[0]));
  let w = Math.min(...pts.map(p => p[1])); let e = Math.max(...pts.map(p => p[1]));
  const k = Math.cos((((s + n) / 2) * Math.PI) / 180);
  const padLat = (n - s) * PAD + 0.02; const padLng = (e - w) * PAD + 0.02;
  s -= padLat; n += padLat; w -= padLng; e += padLng;
  // A home far off: room on its side for the arrow and its distance, clear of the area (not over its top)
  if (home && !reach) {
    const dy = home[0] - center[0]; const dx = (home[1] - center[1]) * k;
    const more = 0.2;
    if (Math.abs(dy) >= Math.abs(dx) * 0.5) { if (dy > 0) n += (n - s) * more; else s -= (n - s) * more; }
    if (Math.abs(dx) >= Math.abs(dy) * 0.5) { if (dx > 0) e += (e - w) * more; else w -= (e - w) * more; }
  }
  // Keep the shape between 1:1 and 1.5:1 (wide), widening the short side about its middle
  let width = (e - w) * k; let height = n - s;
  if (width / height > 1.5) { const add = (width / 1.5 - height) / 2; s -= add; n += add; height = n - s; }
  if (width / height < 1) { const add = (height - width) / 2 / k; w -= add; e += add; width = (e - w) * k; }
  return { s, n, w, e, k, h: Math.round((height / width) * W), homeInView: !!reach };
}

/**
 * The map as HTML. area: { polygon }, home: { lat, lng, miles?, band } | null,
 * words: { label, homeLabel, legendArea, legendHome, away } (in the page's language).
 */
export function areaMapHtml(area, home, words = {}) {
  const polygon = area?.polygon;
  if (!Array.isArray(polygon) || polygon.length < 3) return '';
  const hasHome = home && Number.isFinite(home.lat) && Number.isFinite(home.lng);
  const v = viewFor(polygon, hasHome ? [home.lat, home.lng] : null);
  const x = (lng) => ((lng - v.w) / (v.e - v.w)) * W;
  const y = (lat) => ((v.n - lat) / (v.n - v.s)) * v.h;
  const pct = ([lat, lng]) => [((lng - v.w) / (v.e - v.w)) * 100, ((v.n - lat) / (v.n - v.s)) * 100];
  const inView = ([lat, lng], m = 0) => lat > v.s + m && lat < v.n - m && lng > v.w + m && lng < v.e - m;
  const path = (pts, close) => `M${pts.map(([la, ln]) => `${x(ln).toFixed(1)} ${y(la).toFixed(1)}`).join('L')}${close ? 'Z' : ''}`;

  const counties = COUNTIES.map(c => c.r.map(r => path(pairs(r), true)).join('')).join('');
  const roads = ROADS.map(r => r.l.map(l => path(pairs(l), false)).join('')).join('');
  const shape = path(polygon, true);
  const svg = `<svg class="af-map-svg" viewBox="0 0 ${W} ${v.h}" preserveAspectRatio="none" aria-hidden="true" focusable="false">
<path class="af-map-county" d="${counties}"/>
<path class="af-map-area" d="${shape}"/>
<path class="af-map-road" d="${roads}"/>
<path class="af-map-edge" d="${shape}"/>
</svg>`;

  const towns = TOWNS.filter(t => inView(t.p, 0.03)).map(t => {
    const [l, tp] = pct(t.p);
    // A name that would run off the map goes on the other side of its dot
    const side = t.s === 'r' && l > 84 ? 'l' : t.s === 'l' && l < 16 ? 'r' : t.s;
    return `<span class="af-map-town af-map-town--${side}${t.k > 1 ? ' af-map-town--minor' : ''}" data-rank="${t.k > 1 ? 3 : 1}" style="left:${l.toFixed(2)}%;top:${tp.toFixed(2)}%"><span>${esc(t.n)}</span></span>`;
  }).join('');
  const counts = Object.entries(COUNTY_LABELS).filter(([, p]) => inView(p, 0.02)).map(([n, p]) => [n, pct(p)])
    .filter(([, [l, tp]]) => l > 9 && l < 91 && tp > 4 && tp < 96).map(([n, [l, tp]]) => {
    return `<span class="af-map-county-name${SERVED.has(n) ? '' : ' af-map-county-name--minor'}" data-rank="${SERVED.has(n) ? 2 : 4}" style="left:${l.toFixed(2)}%;top:${tp.toFixed(2)}%">${esc(n)}</span>`;
  }).join('');

  let pin = '';
  if (hasHome && v.homeInView) {
    const [l, tp] = pct([home.lat, home.lng]);
    // Near the right edge its "Home" label goes on the left of the pin, inside the map
    pin = `<span class="af-map-pin" data-rank="0" data-band="${esc(home.band || '')}"${l > 62 ? ' data-flip' : ''} style="left:${l.toFixed(2)}%;top:${tp.toFixed(2)}%">${PIN}<span class="af-map-pin-label">${esc(words.homeLabel || 'Home')}</span></span>`;
  } else if (hasHome) {
    // Off the map: an arrow on the edge, toward the home, with how far it is
    const c = [(v.s + v.n) / 2, (v.w + v.e) / 2];
    const dx = (home.lng - c[1]) * v.k; const dy = home.lat - c[0];
    const halfW = ((v.e - v.w) * v.k) / 2 * 0.86; const halfH = (v.n - v.s) / 2 * 0.84;
    const t = Math.min(halfW / Math.abs(dx || 1e-9), halfH / Math.abs(dy || 1e-9));
    const at = [c[0] + dy * t, c[1] + (dx * t) / v.k];
    const [l, tp] = pct(at);
    const deg = Math.round((Math.atan2(-dy, dx) * 180) / Math.PI);
    const miles = home.miles != null ? Math.round(home.miles) : null;
    // Held by the end on the map's side, so it reads inside the map (centred on the edge, half was cut off)
    const anchor = l > 60 ? ' data-anchor="end"' : l < 40 ? ' data-anchor="start"' : '';
    pin = `<span class="af-map-away" data-rank="0"${anchor} style="left:${l.toFixed(2)}%;top:${tp.toFixed(2)}%"><svg class="af-map-away-arrow" viewBox="0 0 20 20" style="transform:rotate(${deg}deg)" aria-hidden="true"><path d="M3 10h12M11 5l5 5-5 5"/></svg><span>${esc(words.away ? words.away.replace('{miles}', miles ?? '') : (words.homeLabel || 'Home'))}</span></span>`;
  }

  const legend = `<span class="af-map-key"><span class="af-map-key-area" aria-hidden="true"></span>${esc(words.legendArea || 'Our service area')}</span>${hasHome && v.homeInView ? `<span class="af-map-key"><span class="af-map-key-pin" aria-hidden="true"></span>${esc(words.legendHome || 'The home you entered')}</span>` : ''}`;
  return `<div class="af-map-frame" style="aspect-ratio:${W} / ${v.h};--r:${(W / v.h).toFixed(3)}" role="img" aria-label="${esc(words.label || '')}">${svg}<div class="af-map-labels" aria-hidden="true">${counts}${towns}${pin}</div></div><p class="af-map-legend" aria-hidden="true">${legend}</p>`;
}

/**
 * Hide the names that would sit on a more important one, or hang off the
 * map, at the size the map is shown now (the home first, then towns, the
 * served counties, smaller towns, other counties). Call once the map is on
 * the page, and again when its width changes.
 */
export function declutter(root) {
  for (const frame of root?.querySelectorAll?.('.af-map-frame') || []) {
    const box = frame.getBoundingClientRect();
    if (!box.width) continue;
    const items = [...frame.querySelectorAll('[data-rank]')];
    items.forEach(el => el.classList.remove('is-crowded'));
    // The home's name beside its pin: on the side where it fits the map (a small map, a long name), else none
    // (the key under the map still says which pin is the home)
    for (const pin of frame.querySelectorAll('.af-map-pin')) {
      const label = pin.querySelector('.af-map-pin-label');
      if (!label) continue;
      label.hidden = false;
      const fits = () => { const r = label.getBoundingClientRect(); return r.left >= box.left + 2 && r.right <= box.right - 2; };
      if (fits()) continue;
      pin.toggleAttribute('data-flip');
      if (!fits()) { pin.toggleAttribute('data-flip'); label.hidden = true; }
    }
    const rectOf = (el) => {
      const parts = [...el.children].map(c => c.getBoundingClientRect()).filter(r => r.width);
      const own = el.getBoundingClientRect();
      // A town is its dot (the anchor point) and its name
      if (!own.width) parts.push({ left: own.left - 4, right: own.left + 4, top: own.top - 4, bottom: own.top + 4 });
      else parts.push(own);
      return { left: Math.min(...parts.map(r => r.left)), right: Math.max(...parts.map(r => r.right)), top: Math.min(...parts.map(r => r.top)), bottom: Math.max(...parts.map(r => r.bottom)) };
    };
    const kept = [];
    for (const el of items.sort((a, b) => a.dataset.rank - b.dataset.rank)) {
      if (getComputedStyle(el).display === 'none') continue;
      const r = rectOf(el);
      const rank = Number(el.dataset.rank);
      const off = r.left < box.left + 2 || r.right > box.right - 2 || r.top < box.top + 2 || r.bottom > box.bottom - 2;
      const hits = kept.some(k => r.left < k.right + 3 && r.right > k.left - 3 && r.top < k.bottom + 2 && r.bottom > k.top - 2);
      if (rank > 0 && (off || hits)) { el.classList.add('is-crowded'); continue; }
      kept.push(r);
    }
  }
}
