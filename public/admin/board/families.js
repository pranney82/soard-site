/**
 * The families who applied, on the board page, to read (#/families, and
 * #/families/<account> for one): what Applicants has, never changed here.
 * Peter, Nov 4 2026: "names and scores are in the applications admin, board
 * can have access to it ... read only". Reached from Home's Applications tile,
 * "What makeovers cost" and search; Home stays lit in the menu (no new menu item).
 *
 *   the list   each season's families: their status, what they asked for,
 *              their county and their score, ranked once everyone scoring
 *              the season has finished their card
 *   the map    the same families on Applicants' map (#/families/map, and
 *              #/families/map/<account> with one open; ./family-map.js)
 *   a family   their video, photos and application, the facts their score
 *              rests on, and each scorer's card, criterion by criterion (the
 *              differences worth talking about marked). Never their messages,
 *              staff's notes or a scorer's notes
 *              (../../../functions/api/_board-families.js)
 */

import { h, htm, useState, useEffect, useMemo } from '../vendor.js';
import { plural } from '../board-shared.js';
import { criteriaOf, rubricOfSeason, fmtScore, TOTAL_MAX, TIERS } from '../scoring-shared.js';
import { nbw } from './costs.js';
import { STATUSES, Face, Status, Score, asked, place, areaWords, byScore, day, read, cache, seasonsOf, openingSeason, Media } from './family-parts.js';
import { FamilyMap, seasonLine } from './family-map.js';

const html = htm.bind(h);

/** Every family who applied: by season and status, the ranked ones first, best score first */
export function FamiliesPage({ view = 'list', open = '' }) {
  const [data, setData] = useState(cache.list);
  const [err, setErr] = useState('');
  const seasons = useMemo(() => seasonsOf(data?.families), [data]);
  // It opens on the newest season with a family in it, or the season of the family it opens on
  const opening = useMemo(() => {
    const family = open && data?.families.find((f) => f.id === open);
    return family ? family.season || 'all' : openingSeason(data?.families || []);
  }, [data, open]);
  const [season, setSeason] = useState('');
  const [status, setStatus] = useState(null);
  useEffect(() => {
    let live = true;
    read('families').then((j) => { if (!live) return; if (!j.ok) { setErr(j.error); return; } cache.list = j; setData(j); });
    return () => { live = false; };
  }, []);
  useEffect(() => { if (!season && opening) setSeason(opening); }, [opening]);
  const inSeason = (data?.families || []).filter((f) => !season || season === 'all' || f.season === season);
  const shown = inSeason.filter((f) => status === null || f.status === status).sort(byScore);
  const count = (s) => inSeason.filter((f) => f.status === s).length;
  const ranked = inSeason.filter((f) => f.score?.ranked);
  return html`<div class="bf">
    <a class="bp-back" href="#/">← Home</a>
    <header class="bp-pagehead">
      <div><h1 class="bp-h1">Families</h1><p class="bp-lede">Everyone who applied for a makeover: their video, photos, application and score. Read-only here: SOARD’s staff decide in Applicants.</p></div>
      <div class="bc-seg bf-view" role="group" aria-label="Show the families as">
        <a href="#/families" aria-current=${view === 'list' ? 'true' : null}>List</a>
        <a href="#/families/map" aria-current=${view === 'map' ? 'true' : null}>Map</a>
      </div>
    </header>
    ${err ? html`<p class="bf-err" role="alert">${err}</p>` : !data ? html`<p class="bp-muted">Opening the families…</p>` : html`
      <div class="bf-filters">
        ${seasons.length > 1 ? html`<div class="bc-seg" role="group" aria-label="Season">
          ${seasons.map((y) => html`<button type="button" key=${y} aria-pressed=${season === y} onClick=${() => setSeason(y)}>${y}</button>`)}
          <button type="button" aria-pressed=${season === 'all'} onClick=${() => setSeason('all')}>Every season</button>
        </div>` : null}
        ${view === 'list' ? html`<div class="bf-chips" role="group" aria-label="Status">
          <button type="button" aria-pressed=${status === null} onClick=${() => setStatus(null)}>All <span>${inSeason.length}</span></button>
          ${[...STATUSES, ''].filter(count).map((s) => html`<button type="button" key=${s} aria-pressed=${status === s} onClick=${() => setStatus(status === s ? null : s)}>${s || 'No status'} <span>${count(s)}</span></button>`)}
        </div>` : null}
      </div>
      ${view === 'map' ? html`<p class="bf-sum">${seasonLine(inSeason)}</p><${FamilyMap} key="map" families=${inSeason} boundary=${data.boundary} open=${open} tall=${true} />` : html`
      <p class="bf-sum">${nbw([...(() => { const orgs = inSeason.filter((f) => f.kind === 'organization').length; const fams = inSeason.length - orgs; return [fams ? plural(fams, 'family', 'families') : '', orgs ? plural(orgs, 'community project') : '']; })(), ranked.length ? `${ranked.length} ranked` : '', ...TIERS.map((t) => { const k = ranked.filter((f) => f.score.tier === t.id).length; return k ? `${k} ${t.label}` : ''; })].filter(Boolean).join(' · '))}</p>
      ${shown.length ? html`<ul class="bf-list">${shown.map((f) => html`<li key=${f.id}><a class="bf-row" href=${`#/families/${encodeURIComponent(f.id)}`}>
        <${Face} f=${f} size=${44} />
        <span class="bf-row__who"><strong>${f.name}</strong><span>${[asked(f), place(f)].filter(Boolean).join(' · ')}</span></span>
        <span class="bf-row__status"><${Status} s=${f.status} /><small>${nbw(`${f.season}${f.applied ? ` · applied ${day(f.applied)}` : ''}`)}</small></span>
        <span class="bf-row__score"><${Score} s=${f.score} /></span>
      </a></li>`)}</ul>` : html`<p class="bp-muted">No family here.</p>`}`}
    `}
  </div>`;
}

/** One family: what they asked for, the facts their score rests on, and each scorer's card */
export function FamilyPage({ id }) {
  const [f, setF] = useState(cache.one.get(id) || null);
  const [err, setErr] = useState('');
  useEffect(() => {
    let live = true;
    read(`family=${encodeURIComponent(id)}`).then((j) => { if (!live) return; if (!j.ok) { setErr(j.error); return; } cache.one.set(id, j.family); setF(j.family); });
    return () => { live = false; };
  }, [id]);
  useEffect(() => { if (f) document.title = `${f.name} · SOARD Board`; }, [f]);
  const back = html`<a class="bp-back" href="#/families">← All families</a>`;
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
      <div><h1 class="bp-h1">${f.name}</h1><p class="bf-head__meta"><${Status} s=${f.status} /> <span>${nbw([f.season ? `${f.season} season` : '', f.kind === 'organization' ? 'Community project' : ''].filter(Boolean).join(' · '))}</span>${f.page ? html` <a class="bp-link" href=${f.page} target="_blank" rel="noopener">Their page</a>` : null}</p></div>
      <div class="bf-head__score"><${Score} s=${f.score} big=${true} /></div>
    </header>
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
