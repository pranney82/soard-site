/**
 * Makeovers on the board page, from application to reveal, to read (#/families,
 * #/families/list, #/families/map, and #/families/<account> for one family):
 * what Applicants and JobTread have, never changed here. Peter, Nov 4 2026:
 * "names and scores are in the applications admin, board can have access to
 * it ... read only"; Nov 7: "combining in some way the applications and
 * makeover kanban since that is the life span of a project for us from
 * application to completion". Reached from Home's Makeovers card, "What
 * makeovers cost" and search; Home stays lit in the menu (no new menu item).
 *
 *   the board  a column for each step someone is at, from Applied to Revealed
 *              (./lifecycle.js), now or a season at a time
 *   the list   the same families in rows: their step, what they asked for,
 *              their county and their score, ranked once everyone scoring the
 *              season has finished their card
 *   the map    the same families on Applicants' map, a pin in its step's color
 *              (#/families/map/<account> with one open; ./family-map.js)
 *   a family   where they are on the way, their video, photos and application,
 *              the facts their score rests on, and each scorer's card,
 *              criterion by criterion (the differences worth talking about
 *              marked). Never their messages, staff's notes or a scorer's
 *              notes (../../../functions/api/_board-families.js)
 */

import { h, htm, useState, useEffect, useMemo } from '../vendor.js';
import { plural } from '../board-shared.js';
import { criteriaOf, rubricOfSeason, fmtScore, TOTAL_MAX, TIERS } from '../scoring-shared.js';
import { nbw } from './costs.js';
import { useKept } from './parts.js';
import { Face, Score, asked, place, areaWords, byScore, day, read, cache, seasonsOf, Media } from './family-parts.js';
import { FamilyMap } from './family-map.js';
import { STAGES, stageLabel, byStage, isFamily } from './stages.js';
import { itemsOf, inSeason, sumLine, Track, LifeBoard, SeasonSwitch, StageChip, STAGE_SCHEME, Journey, toStep } from './lifecycle.js';

const html = htm.bind(h);
const external = (href) => /^\//.test(href);

/** Every family from application to reveal: a board, a list or the map, now or a season at a time */
export function FamiliesPage({ view = 'board', open = '', projects = null, reveals = [] }) {
  const [data, setData] = useState(cache.list);
  const [err, setErr] = useState('');
  useEffect(() => {
    let live = true;
    read('families').then((j) => { if (!live) return; if (!j.ok) { setErr(j.error); return; } cache.list = j; setData(j); });
    return () => { live = false; };
  }, []);
  const all = useMemo(() => itemsOf(data, projects), [data, projects]);
  const seasons = useMemo(() => seasonsOf(data?.families), [data]);
  const app = data?.application || null;
  // It opens on now, or on the season of the family it opens on (the map, with them open)
  const [season, setSeason] = useKept('lc-page-season', '');
  const opening = open ? all.find((x) => x.id === open)?.season || 'all' : 'now';
  const shownSeason = season || opening;
  const [stage, setStage] = useState(null);
  const list = useMemo(() => inSeason(all, shownSeason, app), [all, shownSeason, app]);
  const families = list.filter(isFamily);
  const aside = list.filter((x) => x.stage === 'denied' || x.stage === 'none').length;
  const windowed = shownSeason === 'now' || shownSeason === app?.year ? app : null;
  const chips = [...STAGES.map((s) => s.key), 'denied', 'none'].filter((k) => list.some((x) => x.stage === k));
  // Now, as the way goes; a season, as it's decided: ranked best first, then partway, then the rest
  const rows = list.filter((x) => stage === null || x.stage === stage).sort(shownSeason === 'now' ? (a, b) => byStage(a, b) || byScore(a, b) : byScore);
  // Who they are and how they're scored: families as families, community projects apart, how many ranked and in which tier
  const ranked = list.filter((f) => f.score?.ranked);
  const orgs = list.filter((f) => f.kind === 'organization').length;
  const rankLine = [list.length - orgs ? plural(list.length - orgs, 'family', 'families') : '', orgs ? plural(orgs, 'community project') : '', ranked.length ? `${ranked.length} ranked` : '', ...TIERS.map((t) => { const k = ranked.filter((f) => f.score.tier === t.id).length; return k ? `${k} ${t.label}` : ''; })].filter(Boolean).join(' · ');
  return html`<div class="bf">
    <a class="bp-back" href="#/">← Home</a>
    <header class="bp-pagehead">
      <div><h1 class="bp-h1">Makeovers</h1><p class="bp-lede">Every family from application to reveal: where they are, their video, photos, application and score. Read-only here: staff decide in Applicants, and the builds run in JobTread.</p></div>
      <div class="bc-seg bf-view" role="group" aria-label="Show them as">
        <a href="#/families" aria-current=${view === 'board' ? 'true' : null}>Board</a>
        <a href="#/families/list" aria-current=${view === 'list' ? 'true' : null}>List</a>
        <a href="#/families/map" aria-current=${view === 'map' ? 'true' : null}>Map</a>
      </div>
    </header>
    ${err ? html`<p class="bf-err" role="alert">${err}</p>` : !data ? html`<p class="bp-muted">Opening the families…</p>` : html`
      <div class="bf-filters">
        <${SeasonSwitch} seasons=${seasons} season=${shownSeason} setSeason=${(y) => { setSeason(y); setStage(null); }} />
      </div>
      <p class="bf-sum">${nbw(sumLine(list, shownSeason, app)) || 'Nobody here.'}</p>
      <${Track} list=${list} application=${windowed} onStep=${view === 'board' ? toStep : view === 'list' ? (k) => setStage(k) : null} />
      ${!data.jobs ? html`<p class="lc-note">JobTread can’t be reached right now, so each family’s step is their application’s.</p>` : null}
      ${view === 'map' ? html`<${FamilyMap} key="map" families=${families} boundary=${data.boundary} open=${open} tall=${true} scheme=${STAGE_SCHEME} />`
      : view === 'board' ? html`<${LifeBoard} key=${shownSeason} list=${list} application=${windowed} reveals=${reveals} />
        ${aside ? html`<p class="lc-note">${nbw(`${plural(aside, 'family', 'families')} not chosen or with no status ${aside === 1 ? 'isn’t' : 'aren’t'} on the board.`)} <a class="bp-link" href="#/families/list">See them in the list</a></p>` : null}`
      : html`
        <div class="bf-chips" role="group" aria-label="Step">
          <button type="button" aria-pressed=${stage === null} onClick=${() => setStage(null)}>All <span>${list.length}</span></button>
          ${chips.map((k) => html`<button type="button" key=${k} aria-pressed=${stage === k} onClick=${() => setStage(stage === k ? null : k)}>${stageLabel(k)} <span>${list.filter((x) => x.stage === k).length}</span></button>`)}
        </div>
        ${rankLine ? html`<p class="bf-sum bf-rank">${nbw(rankLine)}</p>` : null}
        ${rows.length ? html`<ul class="bf-list">${rows.map((f) => {
          const job = !isFamily(f);
          const href = job ? f.page || '' : `#/families/${encodeURIComponent(f.id)}`;
          const inner = html`<${Face} f=${{ ...f, photo: f.card?.photo || f.photo }} size=${44} />
            <span class="bf-row__who"><strong>${(job ? f.card?.name : f.name) || 'A family'}</strong><span>${[asked(f), place(f)].filter(Boolean).join(' · ') || (job ? (f.revealYear ? `Revealed in ${f.revealYear}, from before the applications` : 'From before the applications') : '')}</span></span>
            <span class="bf-row__status"><${StageChip} f=${f} /><small>${nbw([f.season, f.applied ? `applied ${day(f.applied)}` : ''].filter(Boolean).join(' · '))}</small></span>
            <span class="bf-row__score">${job ? null : html`<${Score} s=${f.score} />`}</span>`;
          return html`<li key=${f.id}>${href ? html`<a class="bf-row" href=${href} ...${external(href) ? { target: '_blank', rel: 'noopener' } : {}}>${inner}</a>` : html`<div class="bf-row">${inner}</div>`}</li>`;
        })}</ul>` : html`<p class="bp-muted">Nobody here.</p>`}`}
    `}
  </div>`;
}

/** One family: what they asked for, the facts their score rests on, and each scorer's card */
export function FamilyPage({ id, reveals = [] }) {
  const [f, setF] = useState(cache.one.get(id) || null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let live = true;
    read(`family=${encodeURIComponent(id)}`).then((j) => { if (!live) return; if (!j.ok) { setErr(j.error); return; } cache.one.set(id, j.family); setF(j.family); });
    return () => { live = false; };
  }, [id]);
  useEffect(() => { if (f) document.title = `${f.name} · SOARD Board`; }, [f]);
  const back = html`<a class="bp-back" href="#/families">← Makeovers</a>`;
  if (err) return html`<div class="bf">${back}<p class="bf-err" role="alert">${err}</p></div>`;
  if (!f) return html`<div class="bf">${back}<p class="bp-muted">Opening…</p></div>`;
  const x = f.facts || {};
  const facts = [
    ['Asked for', asked(f)],
    ['Age', x.age != null ? `${x.age}` : ''],
    ['Diagnosis', x.diagnosis],
    ['Walks on their own', x.mobile],
    ['Speaks', x.verbal],
    ['Primary language', x.language],
    ['Lives in', place(f)],
    ['Service area', areaWords(f)],
    ['Referred by', x.referredBy],
    ['Qualified', x.qualified],
    ['Applied', day(f.applied)],
    ['Why not', x.denialReason],
  ].filter(([, v]) => v);
  const rubric = f.rubric || rubricOfSeason(f.season);
  const crit = criteriaOf(rubric);
  const cards = (f.cards || []).filter((c) => c.done > 0);
  const avg = f.score?.criteria || {};
  const talk = new Set(f.score?.talk || []);
  return html`<div class="bf">
    ${back}
    <header class="bf-head">
      <${Face} f=${f} size=${72} />
      <div><h1 class="bp-h1">${f.name}</h1><p class="bf-head__meta"><${StageChip} f=${f} /> <span>${nbw([f.season ? `${f.season} season` : '', f.kind === 'organization' ? 'Community project' : ''].filter(Boolean).join(' · '))}</span>${f.page ? html` <a class="bp-link" href=${f.page} target="_blank" rel="noopener">Their page</a>` : null}</p></div>
      <div class="bf-head__score"><${Score} s=${f.score} big=${true} /></div>
    </header>
    <${Journey} f=${f} reveals=${reveals} />
    <${Media} f=${f} />
    <div class="bf-split">
      <section class="bp-card" aria-labelledby="bf-facts-h">
        <div class="bp-cardhead"><h2 class="bp-h2" id="bf-facts-h">At a glance</h2>${f.lat != null ? html`<a class="bp-link" href=${`#/families/map/${encodeURIComponent(f.id)}`}>Show on the map</a>` : null}</div>
        <dl class="bf-facts">${facts.map(([k, v]) => html`<div key=${k}><dt>${k}</dt><dd dir="auto">${nbw(v)}</dd></div>`)}</dl>
      </section>
      <section class="bp-card" aria-labelledby="bf-score-h">
        <h2 class="bp-h2" id="bf-score-h">The score</h2>
        ${!cards.length ? html`<p class="bp-muted">Nobody has scored ${f.kind === 'organization' ? 'this application' : 'this family'} yet.</p>` : html`
          <p class="bf-score-line">${nbw(f.score?.ranked ? `${plural(f.score.count, 'scorer')} finished: the score is the average of their totals.` : `${f.score?.count || 0} of ${plural(f.score?.of || cards.length, 'scorer')} finished. It’s ranked once everyone scoring ${f.season || 'the season'} has.`)}</p>
          <div class="bf-cards-wrap"><table class="bp-table bf-cards">
            <thead><tr><th scope="col">Criterion</th>${f.score?.count ? html`<th scope="col" class="num">Average</th>` : null}${cards.map((c, i) => html`<th scope="col" class="num" key=${i} title=${c.name}>${String(c.name || '').split(/\s+/)[0]}${c.complete ? '' : html`<small> partway</small>`}</th>`)}</tr></thead>
            <tbody>${crit.map((c) => html`<tr key=${c.key} class=${talk.has(c.key) ? 'is-talk' : ''}>
              <th scope="row">${c.label}${talk.has(c.key) ? html`<span class="bf-talk">Worth talking about</span>` : null}</th>
              ${f.score?.count ? html`<td class="num"><b>${fmtScore(avg[c.key])}</b></td>` : null}
              ${cards.map((card, i) => html`<td class="num" key=${i} title=${card.scores?.[c.key] ? c.levels?.[card.scores[c.key] - 1] || '' : ''}>${card.scores?.[c.key] ?? '–'}</td>`)}
            </tr>`)}</tbody>
            <tfoot><tr><th scope="row">Total, of ${TOTAL_MAX}</th>${f.score?.count ? html`<td class="num"><b>${fmtScore(f.score.total)}</b></td>` : null}${cards.map((c, i) => html`<td class="num" key=${i}>${c.complete ? fmtScore(c.total) : '–'}</td>`)}</tr></tfoot>
          </table></div>
          <p class="bf-note">Each criterion is scored 1 to 5. Hover a score for what it means.</p>`}
      </section>
    </div>
  </div>`;
}
