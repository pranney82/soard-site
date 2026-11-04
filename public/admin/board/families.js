/**
 * The families who applied, on the board page, to read (#/families, and
 * #/families/<account> for one): what Applicants has, never changed here.
 * Peter, Nov 4 2026: "names and scores are in the applications admin, board
 * can have access to it ... read only". Reached from Home's "What makeovers
 * cost" and search; Home stays lit in the menu (no new menu item).
 *
 *   the list   each season's families: their status, what they asked for,
 *              their county and their score, ranked once everyone scoring
 *              the season has finished their card
 *   a family   the facts their score rests on, and each scorer's card,
 *              criterion by criterion (the differences worth talking about
 *              marked). Never how to reach them, their messages, their files
 *              or a scorer's notes (../../../functions/api/_board-families.js)
 */

import { h, htm, useState, useEffect, useMemo } from '../vendor.js';
import { initialsOf, shortDate, plural } from '../board-shared.js';
import { criteriaOf, rubricOfSeason, tierById, fmtScore, TOTAL_MAX, TIERS } from '../scoring-shared.js';
import { sized } from './kanban.js';
import { nbw } from './costs.js';

const html = htm.bind(h);
const API = '/api/board-portal';
const STATUSES = ['Approved', 'In Review', 'Applied', 'Denied'];
const STATUS_TONE = { Approved: 'ok', 'In Review': 'info', Applied: '', Denied: 'quiet' };
const hueOf = (s) => [42, 28, 96, 152, 200, 18][[...String(s)].reduce((a, c) => a + c.charCodeAt(0), 0) % 6];
const day = (iso) => (iso ? shortDate(String(iso).slice(0, 10)) : '');
const cache = { list: null, at: 0, one: new Map() };

async function read(q) {
  try {
    const r = await fetch(`${API}?${q}`, { cache: 'no-store' });
    const j = await r.json().catch(() => ({ ok: false, error: `Something went wrong (${r.status})` }));
    return r.ok && j.ok !== false ? j : { ok: false, error: j.error || `Something went wrong (${r.status})` };
  } catch {
    return { ok: false, error: 'No connection. Check your internet and try again.' };
  }
}

function Face({ f, size = 40 }) {
  return f.photo
    ? html`<img class="bf-face" src=${sized(f.photo, `w=${size * 2},h=${size * 2},fit=cover,gravity=face`)} alt="" width=${size} height=${size} loading="lazy" />`
    : html`<span class="bf-face bf-face--initials" style=${`--hue:${hueOf(f.name)};--s:${size}px`} aria-hidden="true">${initialsOf(f.name)}</span>`;
}
const Status = ({ s }) => html`<span class=${`bf-status ${STATUS_TONE[s] ? `is-${STATUS_TONE[s]}` : ''}`}>${s}</span>`;
function Score({ s, big = false }) {
  if (!s) return html`<span class="bf-score is-none">Not scored yet</span>`;
  if (!s.ranked || s.total == null) return html`<span class="bf-score is-part">${nbw(`${s.count} of ${s.of || s.count} scored`)}</span>`;
  const t = tierById(s.tier);
  return html`<span class=${`bf-score ${big ? 'is-big' : ''}`}><b>${fmtScore(s.total)}</b>${big ? html`<small>of ${TOTAL_MAX}</small>` : null}${t ? html`<span class=${`bf-tier is-${t.id}`}>${t.label}</span>` : null}</span>`;
}
const asked = (f) => (f.kind === 'organization' ? 'Community project' : f.types?.length ? f.types.join(', ') : '');
const place = (f) => [f.city, f.county ? `${f.county} County`.replace(/ County County$/, ' County') : ''].filter(Boolean).join(', ');

/** Every family who applied: by season and status, the ranked ones first, best score first */
export function FamiliesPage() {
  const [data, setData] = useState(cache.list);
  const [err, setErr] = useState('');
  const seasons = useMemo(() => [...new Set((data?.families || []).map((f) => f.season).filter(Boolean))].sort().reverse(), [data]);
  // It opens on the newest season with a family in it (a season of one community project alone isn't the place to start)
  const opening = useMemo(() => seasons.find((y) => (data?.families || []).some((f) => f.season === y && f.kind !== 'organization')) || seasons[0], [seasons.join(','), data]);
  const [season, setSeason] = useState('');
  const [status, setStatus] = useState('');
  useEffect(() => {
    let live = true;
    read('families').then((j) => { if (!live) return; if (!j.ok) { setErr(j.error); return; } cache.list = j; setData(j); });
    return () => { live = false; };
  }, []);
  useEffect(() => { if (!season && opening) setSeason(opening); }, [opening]);
  const inSeason = (data?.families || []).filter((f) => !season || season === 'all' || f.season === season);
  const shown = inSeason.filter((f) => !status || f.status === status)
    .sort((a, b) => (b.score?.ranked ? 1 : 0) - (a.score?.ranked ? 1 : 0) || (b.score?.ranked ? b.score.total : -1) - (a.score?.ranked ? a.score.total : -1) || (b.score?.count || 0) - (a.score?.count || 0) || String(b.applied || '').localeCompare(String(a.applied || '')));
  const count = (s) => inSeason.filter((f) => f.status === s).length;
  const ranked = inSeason.filter((f) => f.score?.ranked);
  return html`<div class="bf">
    <a class="bp-back" href="#/">← Home</a>
    <header class="bp-pagehead">
      <div><h1 class="bp-h1">Families</h1><p class="bp-lede">Everyone who applied for a makeover, and their score. Read-only here: SOARD’s staff decide in Applicants.</p></div>
    </header>
    ${err ? html`<p class="bf-err" role="alert">${err}</p>` : !data ? html`<p class="bp-muted">Opening the families…</p>` : html`
      <div class="bf-filters">
        ${seasons.length > 1 ? html`<div class="bc-seg" role="group" aria-label="Season">
          ${seasons.map((y) => html`<button type="button" key=${y} aria-pressed=${season === y} onClick=${() => setSeason(y)}>${y}</button>`)}
          <button type="button" aria-pressed=${season === 'all'} onClick=${() => setSeason('all')}>Every season</button>
        </div>` : null}
        <div class="bf-chips" role="group" aria-label="Status">
          <button type="button" aria-pressed=${!status} onClick=${() => setStatus('')}>All <span>${inSeason.length}</span></button>
          ${STATUSES.filter(count).map((s) => html`<button type="button" key=${s} aria-pressed=${status === s} onClick=${() => setStatus(status === s ? '' : s)}>${s} <span>${count(s)}</span></button>`)}
        </div>
      </div>
      <p class="bf-sum">${nbw([...(() => { const orgs = inSeason.filter((f) => f.kind === 'organization').length; const fams = inSeason.length - orgs; return [fams ? plural(fams, 'family', 'families') : '', orgs ? plural(orgs, 'community project') : '']; })(), ranked.length ? `${ranked.length} ranked` : '', ...TIERS.map((t) => { const k = ranked.filter((f) => f.score.tier === t.id).length; return k ? `${k} ${t.label}` : ''; })].filter(Boolean).join(' · '))}</p>
      ${shown.length ? html`<ul class="bf-list">${shown.map((f) => html`<li key=${f.id}><a class="bf-row" href=${`#/families/${encodeURIComponent(f.id)}`}>
        <${Face} f=${f} size=${44} />
        <span class="bf-row__who"><strong>${f.name}</strong><span>${[asked(f), place(f)].filter(Boolean).join(' · ')}</span></span>
        <span class="bf-row__status"><${Status} s=${f.status} /><small>${nbw(`${f.season}${f.applied ? ` · applied ${day(f.applied)}` : ''}`)}</small></span>
        <span class="bf-row__score"><${Score} s=${f.score} /></span>
      </a></li>`)}</ul>` : html`<p class="bp-muted">No family here.</p>`}
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
    <div class="bf-split">
      <section class="bp-card" aria-labelledby="bf-facts-h">
        <h2 class="bp-h2" id="bf-facts-h">The application</h2>
        <dl class="bf-facts">${facts.map(([k, v]) => html`<div key=${k}><dt>${k}</dt><dd dir="auto">${nbw(v)}</dd></div>`)}</dl>
      </section>
      <section class="bp-card" aria-labelledby="bf-score-h">
        <h2 class="bp-h2" id="bf-score-h">The score</h2>
        ${!cards.length ? html`<p class="bp-muted">Nobody has scored ${f.kind === 'organization' ? 'this application' : 'this family'} yet.</p>` : html`
          <p class="bf-score-line">${nbw(f.score?.ranked ? `${plural(f.score.count, 'scorer')} finished: the score is the average of their totals.` : `${f.score?.count || 0} of ${f.score?.of || cards.length} scorers finished. It’s ranked once everyone scoring ${f.season || 'the season'} has.`)}</p>
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
