/**
 * The families on a map, on the board page: Applicants' map (../family-map.js)
 * with who's on it beside it, to read, never to change.
 * Peter, Nov 6 2026: "show the application map to the board in one of the
 * tiles ... the ability for the board to see the video, photos and
 * application". The map in Home's Makeovers card and on the Makeovers page
 * (./lifecycle.js, ./families.js), pins by step there (`scheme`).
 *
 *   the map   every family with a home in JobTread against the service area,
 *             pins in their status's color; the key switches a status off
 *   the list  beside it, the same families: a row lights its pin, a pin its row
 *   a family  a pin or a row opens them in the list's place: their video, the
 *             photos, the application (each opens over the page in the file
 *             viewer), what they asked for, where they live, their score
 *
 * A phone's one finger scrolls the page and two move the map; a laptop's wheel
 * scrolls the page and ⌘ or Ctrl (or a pinch) zooms, so Home is never caught
 * in the map on its way down. Whole zoom levels only: in-between ones leave
 * seams between the tiles.
 */

import { h, htm, useState, useEffect, useRef, useMemo } from '../vendor.js';
import { useKept } from './parts.js';
import { plural } from '../board-shared.js';
import { fmtScore } from '../scoring-shared.js';
import { viewerLink } from '../file-viewer.js';
import { STATUS_COLOR, FAR_MILES, loadLeaflet, takeDown, dressMap, areaShape, closeRing, pinIcon, onPress, frameArea, wheelZoom, MapLegend } from '../family-map.js';
import { Face, Status, Score, asked, place, areaWords, byScore, seasonsOf, openingSeason, read, cache, setOf, Video, Photos, mediaNote } from './family-parts.js';
import { nbw } from './costs.js';

const html = htm.bind(h);
// Where pins pile up, the ones still being decided stay on top: a gray pin never hides a family waiting
const PIN_RANK = { Applied: 500, 'In Review': 400, Approved: 300 };
const rankOf = (f) => PIN_RANK[f.status] || 0;
/**
 * How the map colors and keys its families: by Applicants' status unless told otherwise (Home's Makeovers card keys
 * them by their stage, ./lifecycle.js). keyOf → the key's id; colorOf → a pin's color; word → said aloud; rank → on
 * top where pins pile up; rows → the key's rows (null: Applicants' statuses); chip → the family's chip on their card
 */
export const STATUS_SCHEME = {
  keyOf: (f) => f.status || '', colorOf: (f) => STATUS_COLOR[f.status || ''], word: (f) => f.status || 'No status', rank: rankOf, rows: null, sort: null,
  chip: (f) => html`<${Status} s=${f.status} />`,
};
// This many on the map and each pin is drawn smaller
const CROWDED = 30;
const isFar = (f) => f.area === 'outside' && f.areaMiles > FAR_MILES;
const ARROW = html`<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M5 12h14M13 6l6 6-6 6"/></svg>`;
const BACK = html`<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M19 12H5M11 6l-6 6 6 6"/></svg>`;

/** "2 families · 1 community project · 1 outside the service area" */
export function seasonLine(list) {
  const orgs = list.filter((f) => f.kind === 'organization').length;
  const fams = list.length - orgs;
  const out = list.filter((f) => f.area === 'outside').length;
  return nbw([fams ? plural(fams, 'family', 'families') : '', orgs ? plural(orgs, 'community project') : '', out ? `${out} outside the service area` : ''].filter(Boolean).join(' · '));
}

/** A family in the list's place: what they sent, first */
function FamilyCard({ f, onBack, back, scheme = STATUS_SCHEME }) {
  const [d, setD] = useState(cache.one.get(f.id) || null);
  const [err, setErr] = useState('');
  const head = useRef(null);
  useEffect(() => {
    let live = true;
    setD(cache.one.get(f.id) || null);
    setErr('');
    read(`family=${encodeURIComponent(f.id)}`).then((j) => { if (!live) return; if (!j.ok) { setErr(j.error); return; } cache.one.set(f.id, j.family); setD(j.family); });
    return () => { live = false; };
  }, [f.id]);
  useEffect(() => { head.current?.focus({ preventScroll: true }); }, [f.id]);
  const m = d?.media;
  const set = setOf(m);
  const who = f.kind === 'organization' ? f.name : String(f.name || '').split(/\s+/)[0];
  const note = m ? mediaNote(m) : err;
  // No video: their first photo with a thumbnail leads, and the rest sit under it
  const lead = m && !m.video ? m.photos.find((p) => p.thumb) || null : null;
  const rest = m ? { ...m, photos: m.photos.filter((p) => p !== lead) } : null;
  const facts = [['Asked for', asked(f)], ['Lives in', place(f)], ['Service area', areaWords(f)]].filter(([, v]) => v);
  return html`<div class="fm-card" onKeyDown=${(e) => { if (e.key === 'Escape') { e.stopPropagation(); onBack(); } }}>
    <button type="button" class="fm-back" onClick=${onBack}>${BACK}${back}</button>
    <div class="fm-card__head">
      <${Face} f=${f} size=${48} />
      <div><h3 class="fm-card__name" ref=${head} tabindex="-1">${f.name}</h3><p class="fm-card__meta">${scheme.chip(f)}<span>${nbw([f.season, f.kind === 'organization' ? 'Community project' : ''].filter(Boolean).join(' · '))}</span></p></div>
    </div>
    ${!d && !err ? html`<div class="fm-card__wait" role="status">Opening what they sent…</div>` : null}
    ${m?.video ? html`<${Video} m=${m} set=${set} who=${who} />` : null}
    ${lead ? html`<a class="bm-tile bm-leadphoto" ...${viewerLink(set, set.indexOf(lead))} aria-label=${`${who}: ${lead.label || 'photo'}`}><img src=${lead.thumb} alt="" decoding="async" /></a>` : null}
    ${rest?.photos.length ? html`<${Photos} m=${rest} set=${set} who=${who} limit=${4} />` : null}
    ${m?.application ? html`<a class="bp-btn bp-btn--primary fm-card__read" ...${viewerLink(set, set.indexOf(m.application))}>Read the application</a>` : m && !m.unavailable ? html`<p class="bp-muted fm-card__note">No application on file.</p>` : null}
    ${note ? html`<p class="bp-muted fm-card__note">${note}</p>` : m && !set.length ? html`<p class="bp-muted fm-card__note">No video or photos on file.</p>` : null}
    <dl class="fm-card__facts">
      ${facts.map(([k, v]) => html`<div key=${k}><dt>${k}</dt><dd>${nbw(v)}</dd></div>`)}
      <div><dt>Score</dt><dd><${Score} s=${f.score} /></dd></div>
    </dl>
    <a class="fm-card__more" href=${`#/families/${encodeURIComponent(f.id)}`}>Everything about ${who}${ARROW}</a>
  </div>`;
}

/**
 * The map and who's on it. `families`: the season's, each as the list has them; `boundary`: the service area;
 * `open`: a family to open with; `tall`: Families → Map's height, and the wheel zooms there
 */
export function FamilyMap({ families, boundary, open = '', tall = false, scheme = STATUS_SCHEME }) {
  const box = useRef(null);
  const st = useRef({});
  const listEl = useRef(null);
  const [L, setL] = useState(null);
  const [err, setErr] = useState('');
  const [hidden, setHidden] = useState(() => new Set());
  // (Back from a family's page comes back to them, here)
  const [openId, setOpenId] = useKept('fm-open', open || null);
  const [all, setAll] = useState(false);
  const [wide, setWide] = useState(false);
  const openRef = useRef(openId);
  openRef.current = openId;
  const poly = boundary?.polygon || [];
  const nearMiles = boundary?.nearMiles ?? 0;

  const rows = useMemo(() => [...families].sort(scheme.sort || byScore), [families]);
  const onMap = useMemo(() => rows.filter((f) => f.lat != null && f.lng != null), [rows]);
  const showing = useMemo(() => onMap.filter((f) => !hidden.has(scheme.keyOf(f))), [onMap, hidden]);
  const counts = useMemo(() => onMap.reduce((c, f) => ({ ...c, [scheme.keyOf(f)]: (c[scheme.keyOf(f)] || 0) + 1 }), {}), [onMap]);
  const listed = rows.filter((f) => !hidden.has(scheme.keyOf(f)));
  const picked = openId ? rows.find((f) => f.id === openId) : null;

  useEffect(() => { let live = true; loadLeaflet().then((l) => { if (live) setL(l); }).catch((e) => { if (live) setErr(e.message); }); return () => { live = false; }; }, []);

  // The whole picture: the area, its ring and the families around it (with those far off, once asked), clear of the key
  const frame = (animate, everyone = wide) => {
    const s = st.current;
    if (!s.map) return;
    const key = box.current?.parentElement?.querySelector('.apl-legend');
    const left = key && getComputedStyle(key).position === 'absolute' ? key.offsetWidth + 22 : 22;
    frameArea(L, s.map, { polygon: poly, nearMiles, points: showing.filter((f) => everyone || !isFar(f)).map((f) => [f.lat, f.lng]), left, animate: animate && !s.still });
  };
  const frameRef = useRef(frame);
  frameRef.current = frame;

  // The map itself, once
  useEffect(() => {
    if (!L || !box.current || st.current.map) return undefined;
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const map = L.map(box.current, { zoomControl: false, scrollWheelZoom: tall, dragging: !L.Browser.mobile, zoomAnimation: !still, fadeAnimation: !still, markerZoomAnimation: !still });
    dressMap(L, map);
    closeRing(L, poly, nearMiles)?.addTo(map);
    if (poly.length >= 3) areaShape(L, poly).addTo(map);
    st.current = { map, still, pins: L.layerGroup().addTo(map), markers: new Map() };
    // (Families → Map is tall enough that the wheel zooms it)
    const unwheel = tall ? () => {} : wheelZoom(map, box.current);
    const here = box.current;
    let width = here.offsetWidth;
    const ro = new ResizeObserver(() => { map.invalidateSize({ pan: false }); if (here.offsetWidth !== width) { width = here.offsetWidth; if (!openRef.current) frameRef.current(false); } });
    ro.observe(here);
    return () => { ro.disconnect(); unwheel(); takeDown(map); st.current = {}; };
  }, [L]);

  // A pin and its row light together
  const lightRow = (id, on) => {
    const list = listEl.current;
    const row = list?.querySelector(`[data-id="${id}"]`);
    if (!row) return;
    row.classList.toggle('is-hot', on);
    if (on && list.scrollHeight > list.clientHeight) {
      const top = row.offsetTop - list.offsetTop;
      if (top < list.scrollTop) list.scrollTop = top;
      else if (top + row.offsetHeight > list.scrollTop + list.clientHeight) list.scrollTop = top + row.offsetHeight - list.clientHeight;
    }
  };
  const lightPin = (id, on) => {
    const m = st.current.markers?.get(id);
    m?.getElement()?.firstElementChild?.classList.toggle('is-focus', on || id === openRef.current);
    if (m) m.setZIndexOffset(on || id === openRef.current ? 2000 : m.options.rank);
  };

  const pick = (id, fromList = false) => {
    const s = st.current;
    const was = openRef.current;
    setOpenId(id);
    if (was && was !== id) lightPin(was, false);
    const m = s.markers?.get(id);
    if (m) {
      openRef.current = id;
      lightPin(id, true);
      s.map.setView(m.getLatLng(), Math.max(s.map.getZoom(), 10), { animate: !s.still });
    }
    // (a tap on a phone's pin: the family opens under the map)
    if (!fromList && matchMedia('(max-width: 899px)').matches) setTimeout(() => box.current?.closest('.fm')?.querySelector('.fm-side')?.scrollIntoView({ block: 'nearest', behavior: s.still ? 'auto' : 'smooth' }), 60);
  };
  const close = () => {
    const was = openRef.current;
    openRef.current = null;
    setOpenId(null);
    if (was) lightPin(was, false);
    frame(true);
    // Back to the row they came from
    setTimeout(() => { const row = listEl.current?.querySelector(`[data-id="${was}"]`); row?.focus({ preventScroll: true }); }, 0);
  };

  // Pins (a refresh that changed nothing leaves the map alone)
  useEffect(() => {
    const s = st.current;
    if (!L || !s.map) return;
    const drawing = JSON.stringify(showing.map((f) => [f.id, f.lat, f.lng, scheme.keyOf(f)]));
    if (drawing === s.drawn) return;
    s.drawn = drawing;
    s.pins.clearLayers();
    s.markers.clear();
    s.map.getContainer().classList.toggle('is-crowded', showing.length > CROWDED);
    for (const f of showing) {
      const on = f.id === openRef.current;
      const m = L.marker([f.lat, f.lng], { icon: pinIcon(L, scheme.colorOf(f), on ? 'is-focus' : ''), riseOnHover: true, riseOffset: 2500, keyboard: true, zIndexOffset: on ? 2000 : scheme.rank(f), rank: scheme.rank(f) });
      // (a pin's element comes once the map has its view, which may be after this)
      m.on('add', () => m.getElement()?.setAttribute('aria-label', `${f.name}, ${scheme.word(f).toLowerCase()}`));
      m.addTo(s.pins);
      if (!L.Browser.mobile) {
        const tip = document.createElement('span');
        tip.textContent = f.name;
        m.bindTooltip(tip, { direction: 'top', offset: [0, -10], className: 'fm-tip' });
      }
      onPress(m, () => pick(f.id));
      m.on('mouseover', () => lightRow(f.id, true));
      m.on('mouseout', () => lightRow(f.id, false));
      s.markers.set(f.id, m);
    }
  }, [L, showing]);

  // A new season: the new picture, the family that was open closed if they aren't in it
  const seasonKey = rows.map((f) => f.id).join(',');
  useEffect(() => {
    setWide(false);
    if (openRef.current && !rows.some((f) => f.id === openRef.current)) { openRef.current = null; setOpenId(null); }
    const s = st.current;
    if (!L || !s.map) return;
    // (the map needs a view whoever is open: one with no home in JobTread has no pin to go to)
    const m = openRef.current && s.markers.get(openRef.current);
    if (m) s.map.setView(m.getLatLng(), 11, { animate: false });
    else frame(false, false);
  }, [L, seasonKey]);

  const toggle = (status) => setHidden((h) => { const n = new Set(h); if (n.has(status)) n.delete(status); else n.add(status); return n; });
  const noPoint = rows.length - onMap.length;
  const outside = onMap.filter((f) => f.area === 'outside').length;
  const far = showing.filter(isFar).length;
  const widen = () => { const next = !wide; setWide(next); frame(true, next); };

  return html`<div class=${`fm ${tall ? 'fm--tall' : ''}`}>
    <div class="fm-stage">
      ${err ? html`<p class="fm-opening">The map couldn’t load. Reload the page to try again.</p>` : html`<div class="fm-map" ref=${box} role="region" aria-label="Map of the families who applied and the service area"></div>`}
      ${!L && !err ? html`<p class="fm-opening">Opening the map…</p>` : null}
      <${MapLegend} counts=${counts} hidden=${hidden} onToggle=${toggle} outside=${outside} nearMiles=${nearMiles} noPoint=${noPoint} rows=${scheme.rows ? scheme.rows.filter((r) => counts[r.key]) : null} />
      ${L && (far || L.Browser.mobile) ? html`<div class="fm-under">
        ${far ? html`<button type="button" class="fm-far" onClick=${widen}>${wide ? 'Back to the service area' : `Show ${far} farther out`}</button>` : null}
        ${L.Browser.mobile ? html`<p class="fm-hint">Two fingers move the map</p>` : null}
      </div>` : null}
    </div>
    <aside class="fm-side" aria-label=${picked ? picked.name : 'Who’s on the map'}>
      ${picked ? html`<${FamilyCard} key=${picked.id} f=${picked} onBack=${close} back=${plural(rows.length, 'family', 'families').replace(/^(\d+) /, 'All $1 ')} scheme=${scheme} />` : html`
        ${listed.length ? html`<ul class=${`fm-list ${all ? 'is-all' : ''}`} ref=${listEl}>${listed.map((f) => html`<li key=${f.id}>
          <button type="button" class="fm-row" data-id=${f.id} onClick=${() => pick(f.id, true)} onMouseEnter=${() => lightPin(f.id, true)} onMouseLeave=${() => lightPin(f.id, false)} onFocus=${() => lightPin(f.id, true)} onBlur=${() => lightPin(f.id, false)}>
            <${Face} f=${f} size=${38} />
            <span class="fm-row__who"><strong>${f.name}</strong><span>${[asked(f), f.city].filter(Boolean).join(' · ') || scheme.word(f)}</span></span>
            <span class="fm-row__end">
              ${f.score?.ranked ? html`<b class="fm-row__score">${fmtScore(f.score.total)}</b>` : null}
              <span class="apl-pin fm-row__pin" style=${`--c:${scheme.colorOf(f)}`} title=${scheme.word(f)}></span><span class="sr-only">${scheme.word(f)}</span>
            </span>
          </button>
        </li>`)}</ul>` : html`<p class="bp-muted fm-none">No family here.</p>`}
        ${listed.length > 6 && !all ? html`<button type="button" class="bp-btn bp-btn--quiet bp-btn--sm fm-all" onClick=${() => setAll(true)}>${`Show all ${listed.length}`}</button>` : null}
      `}
    </aside>
  </div>`;
}
