/**
 * Makeovers, from application to reveal, on the board page
 * ===========================================================================
 * Peter, Nov 7 2026: "its almost like we shoudl be combinting in some way the
 * applications and makeover kanban since that is the life span of a project
 * for us from application to completion", and "what happens when the
 * application period is over??". One card on Home (MakeoversCard) and one page
 * (./families.js) carry every family the whole way: applying, being built,
 * revealed (./stages.js).
 *
 *   the track   every step with how many are at it, the application's window
 *               beside its two (open until, opens, closed), so a closed
 *               application reads as closed and its steps empty out on their own
 *   the board   a column for each step someone is at: those applying and those
 *               revealed in short rows with their faces, those being built on
 *               their page's photo with their reveal
 *   the map     the same families against the service area, a pin in its
 *               step's color (./family-map.js, Applicants' map)
 *
 * "Now" is everyone in motion: this season's applications, every makeover
 * being built, the reveals of the seasons still being built. Each season can be
 * read on its own too. A card opens the family's page here; a makeover whose
 * family isn't an applicant (an older family) opens its kid page.
 */

import { h, htm, useState, useEffect, useMemo, useRef } from '../vendor.js';
import { useKept } from './parts.js';
import { plural, initialsOf } from '../board-shared.js';
import { sized, revealTag, cardId } from './kanban.js';
import { Face, asked, read, cache, seasonsOf, day, byScore } from './family-parts.js';
import { FamilyMap } from './family-map.js';
import { nbw } from './costs.js';
import { STAGES, PHASES, STAGE_KEYS, STAGE_OF_JOB, stageInfo, stageLabel, phaseOf, keyOf, colorOf, inMotion, countsOf, shownStages, trackStages, windowWords, byStage } from './stages.js';

const html = htm.bind(h);
const ARROW = html`<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M5 12h14M13 6l6 6-6 6"/></svg>`;
const CHECK = html`<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>`;
const hueOf = (s) => [42, 28, 96, 152, 200, 18][[...String(s)].reduce((a, c) => a + c.charCodeAt(0), 0) % 6];
const slugOf = (page) => String(page || '').match(/^\/kids\/([^/]+)\/$/)?.[1] || null;
// How many a Home column shows before "+N more": short rows, photo cards
const HOME_ROWS = 6;
const HOME_CARDS = 4;

/** A family's step as a chip: its color's dot and its name */
export const StageChip = ({ f }) => html`<span class="lc-chip" style=${`--c:${colorOf(f)}`}><i aria-hidden="true"></i>${stageLabel(f.stage)}</span>`;

/** The map keyed by step (./family-map.js FamilyMap `scheme`) */
export const STAGE_SCHEME = {
  keyOf, colorOf, word: (f) => stageLabel(f.stage), rank: (f) => ({ applied: 500, review: 400, building: 300, revealed: 200 }[keyOf(f)] || 0),
  rows: STAGE_KEYS, sort: (a, b) => byStage(a, b) || byScore(a, b), chip: (f) => html`<${StageChip} f=${f} />`,
};

/** A makeover from JobTread alone, before the families come (or for one whose family isn't an applicant) */
const fromProject = (p) => ({
  id: `job-${p.jobId}`, jobId: p.jobId, name: p.name || '', kind: p.kind === 'community' ? 'organization' : 'family', stage: STAGE_OF_JOB[p.status] || 'approved', season: '',
  ...(p.url || p.slug ? { page: p.url || `/kids/${p.slug}/` } : {}),
  card: { name: p.name || '', photo: p.photo || null, slug: p.slug || null, kind: p.kind, status: p.status },
});

/**
 * Everyone on the way, as the board draws them: each family with their makeover's card (its page's name and photo
 * once there is one, its JobTread status for the reveal), then the makeovers whose family isn't an applicant.
 * `fam`: the families answer, or null until it comes (the makeovers alone, so Home's card is never empty);
 * `projects`: numbers.projects
 */
export function itemsOf(fam, projects) {
  const jobs = new Map([...(projects?.waiting || []), ...(projects?.building || [])].filter((p) => p.jobId).map((p) => [p.jobId, p]));
  if (!fam) return [...jobs.values()].map(fromProject);
  const families = (fam.families || []).map((f) => {
    const p = f.jobId ? jobs.get(f.jobId) : null;
    return { ...f, card: { name: p?.name || f.name, photo: p?.photo || f.photo || null, slug: p?.slug || slugOf(f.page), kind: p?.kind, status: p?.status } };
  });
  const theirs = new Set(families.map((f) => f.jobId).filter(Boolean));
  const others = (fam.makeovers || []).filter((m) => !theirs.has(m.jobId)).map((m) => {
    const p = jobs.get(m.jobId);
    return p ? fromProject(p) : { ...m, card: { name: m.name, photo: m.photo || null, slug: slugOf(m.page), kind: m.kind === 'organization' ? 'community' : undefined } };
  });
  return [...families, ...others];
}

/** Which of them a season shows: 'now' (in motion), 'all', or a season ("2027") */
export function inSeason(all, season, application) {
  if (season === 'now') return inMotion(all, application);
  if (season === 'all') return all;
  return all.filter((x) => String(x.season || '') === season);
}

const hrefOf = (x) => (String(x.id).startsWith('job-') ? x.page || '' : `#/families/${encodeURIComponent(x.id)}`);
const nameOf = (x) => x.card?.name || x.name || (x.kind === 'organization' ? 'A community project' : 'A family');
const external = (href) => /^\//.test(href) && !href.startsWith('#');

/** "2 families applying for 2027 · 9 makeovers being built · 6 revealed" */
export function sumLine(list, season, application) {
  const by = (ph) => list.filter((x) => phaseOf(x.stage) === ph).length;
  const applying = by('applying');
  const building = by('building');
  const revealed = by('revealed');
  const out = list.filter((x) => x.stage === 'denied').length;
  return [
    applying || (season === 'now' && application?.open) ? `${plural(applying, 'family', 'families')} applying${season === 'now' && application?.year ? ` for ${application.year}` : ''}` : '',
    building ? `${plural(building, 'makeover')} being built` : '',
    revealed ? `${revealed} revealed` : '',
    out ? `${out} not chosen` : '',
  ].filter(Boolean).join(' · ');
}

/**
 * The way from application to reveal, every step with how many are at it, the steps grouped as applying, building
 * and revealed. The application's window sits over its two steps, so a closed application says so
 */
export function Track({ list, application = null, onStep = null }) {
  const counts = countsOf(list);
  const steps = trackStages(counts);
  const phases = PHASES.map((p) => ({ ...p, steps: steps.filter((s) => s.phase === p.key) }));
  const words = windowWords(application);
  return html`<div class="lc-track" style=${`grid-template-columns:${phases.map((p) => `${Math.max(1, p.steps.length)}fr`).join(' ')}`}>
    ${phases.map((p) => html`<section class=${`lc-phase is-${p.key}`} key=${p.key} aria-label=${p.label}>
      <p class="lc-phase__head"><span>${p.label}<b class="lc-phase__n" aria-hidden="true">${p.steps.reduce((t, s) => t + (counts[s.key] || 0), 0)}</b></span>${p.key === 'applying' && words ? html`<small class=${application?.open ? 'is-open' : ''}>${words}</small>` : null}</p>
      <ol class="lc-steps">${p.steps.map((s) => {
        const n = counts[s.key] || 0;
        const inner = html`<b>${n}</b><span>${s.label}</span>`;
        return html`<li class=${`lc-step ${n ? '' : 'is-zero'}`} key=${s.key}>${n && onStep ? html`<button type="button" class="lc-step__go" onClick=${() => onStep(s.key)}>${inner}<span class="sr-only">, show them</span></button>` : inner}</li>`;
      })}</ol>
    </section>`)}
  </div>`;
}

/** A makeover on its page's photo: their name and their reveal */
function PhotoCard({ x, reveals }) {
  const c = x.card || {};
  const name = nameOf(x);
  const href = hrefOf(x);
  const [broken, setBroken] = useState(false);
  const inner = html`<span class="bk-card__photo">${c.photo && !broken
    ? html`<img src=${sized(c.photo, 'w=560,h=380,fit=cover,gravity=face')} alt="" loading="lazy" decoding="async" width="280" height="190" onError=${() => setBroken(true)} />`
    : html`<span class="bk-card__initials" style=${`--hue:${hueOf(name)}`} aria-hidden="true">${initialsOf(name)}</span>`}</span>
    <span class="bk-card__body"><span class="bk-card__name" title=${name}>${name}</span>${revealTag({ slug: c.slug, kind: c.kind, status: c.status || (x.stage === 'funding' ? 'Awaiting Funding' : '') }, reveals)}</span>`;
  // (an id a search for them lands on: Home's board brought round to their card)
  return html`<li id=${c.slug || c.name ? cardId({ slug: c.slug, name: c.name }) : null}>${href
    ? html`<a class="bk-card" href=${href} ...${external(href) ? { target: '_blank', rel: 'noopener' } : {}}>${inner}</a>`
    : html`<div class="bk-card">${inner}</div>`}</li>`;
}

/** Someone applying, or revealed: their face, their name, a line under it */
function Row({ x, step = false }) {
  const href = hrefOf(x);
  const sub = x.stage === 'revealed' ? [x.season ? `${x.season} season` : '', asked(x)] : [asked(x), x.city];
  const inner = html`<${Face} f=${{ ...x, photo: x.card?.photo || x.photo }} size=${34} />
    <span class="lc-row__who"><strong>${nameOf(x)}</strong><span>${step ? html`<i class="lc-row__step" style=${`--c:${colorOf(x)}`}></i>${stageLabel(x.stage)}${sub.some(Boolean) ? ' · ' : ''}` : null}${sub.filter(Boolean).join(' · ')}</span></span>
    ${x.stage === 'revealed' ? html`<span class="lc-row__done" aria-hidden="true">${CHECK}</span>` : null}`;
  return html`<li>${href ? html`<a class="lc-row" href=${href} ...${external(href) ? { target: '_blank', rel: 'noopener' } : {}}>${inner}</a>` : html`<div class="lc-row">${inner}</div>`}</li>`;
}

// In a column: those applying ranked, then the newest; those being built by their reveal, soonest first; the
// revealed newest season first
const revealAt = (x, reveals) => { const r = x.card?.slug ? reveals.find((y) => y.slug === x.card.slug) : null; return r?.confirmed && r.date ? r.date : r?.window?.month || '9999'; };
function ordered(list, phase, reveals) {
  if (phase === 'applying') return [...list].sort(byScore);
  if (phase === 'building') return [...list].sort((a, b) => revealAt(a, reveals).localeCompare(revealAt(b, reveals)) || nameOf(a).localeCompare(nameOf(b)));
  return [...list].sort((a, b) => String(b.season || '').localeCompare(String(a.season || '')) || nameOf(a).localeCompare(nameOf(b)));
}

/**
 * The board: a column for each step someone is at (Applied too while applications are open, so an open application
 * with nobody yet says so), the application's two in one (each row says which: the track counts them apart), so
 * the makeovers being built and revealed fit beside it. `limit`: Home's, a few to a column and "+N more" to the page
 */
export function LifeBoard({ list, application = null, reveals = [], limit = false, more = '#/families' }) {
  const counts = countsOf(list);
  const steps = shownStages(counts, application);
  const applying = steps.filter((s) => s.phase === 'applying');
  const cols = applying.length > 1 ? [{ key: 'applying', label: 'Applying', phase: 'applying', keys: applying.map((s) => s.key) }, ...steps.filter((s) => s.phase !== 'applying')] : steps;
  if (!cols.length) return html`<p class="lc-none">Nobody here.</p>`;
  return html`<div class="lc-board bk bk--home" style=${`--cols:${cols.length}`} tabindex="-1">
    ${cols.map((s) => {
      const phase = s.phase;
      const all = ordered(list.filter((x) => (s.keys ? s.keys.includes(x.stage) : x.stage === s.key)), phase, reveals);
      const cards = phase === 'building' && s.key !== 'approved';
      // A makeover whose family isn't named yet (no applicant, no page published) waits in one quiet card, as it did
      const named = cards ? all.filter((x) => x.card?.name || x.name) : all;
      const families = cards ? all.filter((x) => !named.includes(x) && x.kind !== 'organization').length : 0;
      const orgs = cards ? all.filter((x) => !named.includes(x) && x.kind === 'organization').length : 0;
      const shown = limit ? named.slice(0, cards ? HOME_CARDS : HOME_ROWS) : named;
      const rest = named.length - shown.length;
      return html`<div class=${`bk-col lc-col is-${phase} ${all.length ? '' : 'is-empty'}`} key=${s.key} id=${`lc-col-${s.key}`} data-steps=${s.keys ? s.keys.join(' ') : null} style=${`--c:${colorOf({ stage: s.keys ? s.keys[0] : s.key })}`}>
        <p class="bk-col__head"><span title=${s.label}>${s.label}</span><span class="bk-col__n">${all.length}</span></p>
        ${all.length ? html`<ul class=${cards ? 'bk-col__cards' : 'lc-rows'}>${shown.map((x) => (cards ? html`<${PhotoCard} key=${x.id} x=${x} reveals=${reveals} />` : html`<${Row} key=${x.id} x=${x} step=${!!s.keys} />`))}
          ${families ? html`<li><span class="bk-card is-quiet"><span class="bk-card__body"><span class="bk-card__name">${nbw(named.length ? `+${families} more ${families === 1 ? 'family' : 'families'}` : plural(families, 'family', 'families'))}</span><span class="bk-card__reveal is-quiet">Named once their page is up</span></span></span></li>` : null}
          ${orgs ? html`<li><span class="bk-card is-quiet"><span class="bk-card__body"><span class="bk-card__name">${nbw(plural(orgs, 'community project'))}</span><span class="bk-card__reveal is-quiet">Not on Community yet</span></span></span></li>` : null}</ul>`
          : html`<p class="bk-col__none">${s.key === 'applied' || s.keys ? 'No applications yet' : 'None now'}</p>`}
        ${rest > 0 ? html`<a class="lc-more" href=${more}>${nbw(`+${rest} more`)}</a>` : null}
      </div>`;
    })}
  </div>`;
}

/** Bring a step's column round in its board (sideways only) and mark it a moment */
export function toStep(key) {
  const col = document.getElementById(`lc-col-${key}`) || document.querySelector(`.lc-col[data-steps~="${key}"]`);
  const board = col?.closest('.lc-board');
  if (!col || !board) return;
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  board.scrollTo({ left: col.offsetLeft - board.offsetLeft - parseFloat(getComputedStyle(board).paddingLeft || 0), behavior: still ? 'auto' : 'smooth' });
  col.classList.remove('is-picked');
  void col.offsetWidth;
  col.classList.add('is-picked');
  col.querySelector('a, button')?.focus({ preventScroll: true });
}

/** Now, each season, every season: a switch (`seasons` newest first) */
export function SeasonSwitch({ seasons, season, setSeason }) {
  return html`<div class="bc-seg lc-seasons" role="group" aria-label="Which families">
    <button type="button" aria-pressed=${season === 'now'} onClick=${() => setSeason('now')}>Now</button>
    ${seasons.map((y) => html`<button type="button" key=${y} aria-pressed=${season === y} onClick=${() => setSeason(y)}>${y}</button>`)}
    <button type="button" aria-pressed=${season === 'all'} onClick=${() => setSeason('all')}>Every season</button>
  </div>`;
}

/** Home's card: everyone from application to reveal, as a board or on the map */
export function MakeoversCard({ n }) {
  const [fam, setFam] = useState(cache.list);
  const [err, setErr] = useState('');
  const [season, setSeason] = useKept('lc-season', 'now');
  const [view, setView] = useKept('lc-view', 'board');
  useEffect(() => {
    let live = true;
    read('families').then((j) => { if (!live) return; if (!j.ok) { setErr(j.error); return; } cache.list = j; setFam(j); });
    return () => { live = false; };
  }, []);
  const all = useMemo(() => itemsOf(fam, n.projects), [fam, n.projects]);
  const seasons = useMemo(() => seasonsOf(fam?.families), [fam]);
  const app = fam?.application || null;
  const list = useMemo(() => inSeason(all, season, app), [all, season, app]);
  const families = useMemo(() => list.filter((x) => !String(x.id).startsWith('job-')), [list]);
  const away = list.length - families.length;
  return html`<section class="bp-card lc" id="makeovers" aria-labelledby="lc-h">
    <div class="bp-cardhead">
      <h2 class="bp-h2" id="lc-h">Makeovers</h2>
      <span class="bp-cardhead__end"><span class="bp-muted">From the applications and JobTread</span>${n.costs ? html`<a class="bp-cardhead__go" href="#/financials/costs">What they cost${ARROW}</a>` : null}<a class="bp-cardhead__go" href="#/families">Every family${ARROW}</a></span>
    </div>
    <div class="lc-bar">
      ${fam ? html`<${SeasonSwitch} seasons=${seasons} season=${season} setSeason=${setSeason} />` : html`<span></span>`}
      <div class="bc-seg lc-views" role="group" aria-label="Show them as">
        <button type="button" aria-pressed=${view === 'board'} onClick=${() => setView('board')}>Board</button>
        <button type="button" aria-pressed=${view === 'map'} onClick=${() => setView('map')}>Map</button>
      </div>
    </div>
    ${err ? html`<p class="bf-err" role="alert">${err} The makeovers from JobTread are below.</p>` : null}
    <p class="lc-sum">${fam ? nbw(sumLine(list, season, app)) || 'Nobody here.' : nbw('Opening the families…')}</p>
    ${fam ? html`<${Track} list=${list} application=${season === 'now' || season === app?.year ? app : null} onStep=${view === 'board' ? toStep : null} />` : null}
    ${fam && !fam.jobs ? html`<p class="lc-note">JobTread can’t be reached right now, so each family’s step is their application’s.</p>` : null}
    ${view === 'map' && fam
      ? html`<${FamilyMap} key="lc-map" families=${families} boundary=${fam.boundary} scheme=${STAGE_SCHEME} />${away ? html`<p class="lc-note">${nbw(`${plural(away, 'makeover')} from before the applications ${away === 1 ? 'isn’t' : 'aren’t'} on the map.`)}</p>` : null}`
      : html`<${LifeBoard} key=${`${fam ? 'all' : 'jobs'}-${season}`} list=${list} application=${season === 'now' || season === app?.year ? app : null} reveals=${n.reveals || []} limit=${true} />`}
  </section>`;
}

/**
 * One family's way: each step, those behind them ticked, theirs lit, the dates that are known (applied; the reveal).
 * Not chosen: their two application steps, then that. No status: nothing to draw
 */
export function Journey({ f, reveals = [] }) {
  const ref = useRef(null);
  // (a phone's strip scrolls: it opens on where they are, the page itself left where it is)
  useEffect(() => {
    const strip = ref.current;
    const now = strip?.querySelector('[aria-current="step"]');
    if (strip && now && strip.scrollWidth > strip.clientWidth) strip.scrollLeft = Math.max(0, now.offsetLeft - strip.offsetLeft - strip.clientWidth / 2 + now.offsetWidth / 2);
  }, [f.stage]);
  if (!stageInfo(f.stage) && f.stage !== 'denied') return null;
  const denied = f.stage === 'denied';
  const at = denied ? 2 : stageInfo(f.stage).i;
  const steps = denied ? [...STAGES.slice(0, 2), { key: 'denied', label: 'Not chosen', phase: 'denied' }] : STAGES.filter((s) => s.key !== 'finalization' || f.stage === 'finalization');
  const slug = slugOf(f.page);
  const r = slug ? reveals.find((x) => x.slug === slug) : null;
  const when = (s) => (s.key === 'applied' ? day(f.applied) : s.key === 'revealed' && r?.confirmed && r.date ? day(r.date) : s.key === 'revealed' && r?.window?.label ? r.window.label : '');
  // (focusable: on a phone it scrolls sideways, and a keyboard has to be able to)
  return html`<ol class="lc-journey" aria-label="From application to reveal" ref=${ref} tabindex="0">
    ${steps.map((s, k) => {
      const i = denied ? k : stageInfo(s.key).i;
      const state = i < at ? 'done' : i === at ? 'now' : 'next';
      const w = when(s);
      return html`<li class=${`lc-j is-${state} is-${s.phase}`} key=${s.key} aria-current=${state === 'now' ? 'step' : null}>
        <i aria-hidden="true">${state === 'done' ? CHECK : null}</i><span>${s.label}</span>${w ? html`<small>${nbw(w)}</small>` : null}
        <span class="sr-only">${state === 'done' ? ', done' : state === 'now' ? ', where they are' : ''}</span>
      </li>`;
    })}
  </ol>`;
}
