/**
 * The advisors' page → Meetings
 * ===========================================================================
 * NextMeeting: the next one, for Home. MeetingsPage: every shared meeting, and one meeting's agenda, documents and
 * recap (#/meetings/<id>). Only what the server sends: a meeting that's shared, with nothing of who else is coming.
 * The calendar invite is the only RSVP, so this shows their answer and never asks for one. No dollar figures here.
 * Server: ../../../functions/api/_advisory-meetings.js meetingsFor (data.meetings on /api/advisory-portal).
 */

import { h, htm, useState, useEffect } from '../vendor.js';
import { viewerLink, sizeText } from '../file-viewer.js';
import { longDate, timeRange, isDate, todayEastern } from '../board-shared.js';
import { Report } from '../board-report.js';

const html = htm.bind(h);

// A meeting's short link (/advisory/<id>, public/_redirects) arrives as ?meeting=<id>: a query survives the sign-in,
// where a #/ link lands on Home
{
  const q = new URLSearchParams(location.search);
  const id = q.get('meeting');
  if (id !== null) {
    q.delete('meeting');
    history.replaceState(null, '', `${location.pathname}${q.size ? `?${q}` : ''}${/^m_[a-z0-9]{4,24}$/.test(id) ? `#/meetings/${id}` : location.hash}`);
  }
}

const fileUrl = (f) => `/api/advisory-file?id=${encodeURIComponent(f.id)}`;
const viewerFiles = (files) => files.map((f) => ({ name: f.name, type: f.type, size: f.size, at: f.at, url: fileUrl(f) }));
const ANSWER = { accepted: 'You said you’re coming', tentative: 'You said maybe', declined: 'You said you can’t make it', invited: 'Answer on your calendar invite' };
const place = (m) => [m.location, m.address].filter(Boolean).join(', ');
const todayOf = (ctx) => ctx.data?.today || todayEastern();
const listOf = (ctx) => (Array.isArray(ctx.data?.meetings) ? ctx.data.meetings : []);
const ahead = (ctx) => listOf(ctx).filter((m) => isDate(m.date) && m.date >= todayOf(ctx)).sort((a, b) => a.date.localeCompare(b.date));
const past = (ctx) => listOf(ctx).filter((m) => isDate(m.date) && m.date < todayOf(ctx)).sort((a, b) => b.date.localeCompare(a.date));

function Tile({ date }) {
  if (!isDate(date)) return null;
  const d = new Date(`${date}T12:00:00Z`);
  return html`<span class="amv-tile" aria-hidden="true"><b>${d.toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' })}</b>${d.getUTCDate()}</span>`;
}

/** A calendar file, for someone who isn't on the invite (a meeting's invite goes out when whoever runs it sends it) */
function addToCalendar(m) {
  const stamp = (d, t) => `${d.replaceAll('-', '')}T${String(t || '00:00').replace(':', '')}00`;
  const ics = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//SOARD//Advisory Board//EN', 'BEGIN:VEVENT', `UID:${m.id}@sunshineonaranneyday.com`, `DTSTAMP:${new Date().toISOString().replace(/[-:]|\.\d+/g, '')}`,
    `DTSTART;TZID=America/New_York:${stamp(m.date, m.start)}`, `DTEND;TZID=America/New_York:${stamp(m.date, m.end || m.start)}`, `SUMMARY:${String(m.title).replace(/[,;\\]/g, ' ')}`,
    ...(place(m) ? [`LOCATION:${place(m).replace(/[,;\\]/g, ' ')}`] : []), 'END:VEVENT', 'END:VCALENDAR'].join('\r\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([ics], { type: 'text/calendar' }));
  a.download = `${m.title}.ics`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function Facts({ m }) {
  return html`<p class="amv-facts">${[longDate(m.date), timeRange(m.start, m.end)].filter(Boolean).join(' · ')}${place(m) ? html`<br />${place(m)}` : null}</p>`;
}
function Actions({ m, ctx }) {
  const held = m.date < todayOf(ctx);
  return html`<div class="amv-actions">
    ${m.meet && !held ? html`<a class="amv-btn amv-btn--main" href=${m.meet} target="_blank" rel="noopener">Join on Google Meet</a>` : null}
    ${!m.invited && !held ? html`<button type="button" class="amv-btn" onClick=${() => addToCalendar(m)}>Add to calendar</button>` : null}
  </div>`;
}

/** The next meeting, for Home. Their answer, never a question: the calendar invite is the only RSVP */
export function NextMeeting({ ctx }) {
  addStyles();
  const m = ahead(ctx)[0];
  if (!m) return html`<section class="amv amv-card amv-next" aria-label="The next meeting"><p class="amv-kick">Next meeting</p><p class="amv-muted">The next meeting will show here once it’s set.</p></section>`;
  return html`<section class="amv amv-card amv-next" aria-label="The next meeting">
    <${Tile} date=${m.date} />
    <div class="amv-grow">
      <p class="amv-kick">Next meeting</p>
      <a class="amv-title" href=${`#/meetings/${m.id}`}>${m.title}</a>
      <${Facts} m=${m} />
      ${m.myAnswer ? html`<p class="amv-muted">${ANSWER[m.myAnswer]}</p>` : null}
      <${Actions} m=${m} ctx=${ctx} />
    </div>
  </section>`;
}

function useMeetingId() {
  const read = () => (location.hash.match(/^#\/meetings\/([\w-]+)/) || [])[1] || '';
  const [id, setId] = useState(read);
  useEffect(() => {
    const on = () => setId(read());
    addEventListener('hashchange', on);
    return () => removeEventListener('hashchange', on);
  }, []);
  return id;
}

function Row({ m }) {
  return html`<li><a class="amv-row" href=${`#/meetings/${m.id}`}><${Tile} date=${m.date} /><span class="amv-grow"><strong>${m.title}</strong><span class="amv-muted">${[timeRange(m.start, m.end), m.location].filter(Boolean).join(' · ')}</span></span>${m.recap ? html`<span class="amv-chip">Recap</span>` : null}</a></li>`;
}

export function MeetingsPage({ ctx }) {
  addStyles();
  const id = useMeetingId();
  const m = id ? listOf(ctx).find((x) => x.id === id) : null;
  if (id) {
    if (!m) return html`<div class="amv"><a class="amv-back" href="#/meetings">All meetings</a><div class="amv-card"><p class="amv-strong">This meeting isn’t here</p><p class="amv-muted">It may have moved, or it isn’t shared yet.</p></div></div>`;
    return html`<${Meeting} m=${m} ctx=${ctx} />`;
  }
  const next = ahead(ctx);
  const done = past(ctx);
  return html`<div class="amv">
    <h1 class="amv-h1">Meetings</h1>
    ${next.length || done.length ? null : html`<div class="amv-card"><p class="amv-strong">No meetings yet</p><p class="amv-muted">Your calendar invite will come by email, and the agenda will be here.</p></div>`}
    ${next.length ? html`<h2 class="amv-h2">Ahead</h2><ul class="amv-list">${next.map((x) => html`<${Row} m=${x} key=${x.id} />`)}</ul>` : null}
    ${done.length ? html`<h2 class="amv-h2">Past</h2><ul class="amv-list">${done.map((x) => html`<${Row} m=${x} key=${x.id} />`)}</ul>` : null}
  </div>`;
}

function Meeting({ m, ctx }) {
  const held = m.date < todayOf(ctx);
  const vf = viewerFiles(m.files);
  const at = (id) => m.files.findIndex((f) => f.id === id);
  const onItems = new Set(m.sections.flatMap((s) => s.items.flatMap((it) => it.docs)));
  const loose = m.files.filter((f) => !onItems.has(f.id));
  const recapFiles = m.recap?.files || [];
  const rf = viewerFiles(recapFiles);
  const recap = m.recap ? html`<section class="amv-card" aria-labelledby="amv-recap"><h2 class="amv-h2" id="amv-recap">Recap</h2>
    ${m.recap.text ? html`<${Report} text=${m.recap.text} level=${3} />` : null}
    ${recapFiles.length ? html`<ul class="amv-files">${recapFiles.map((f, i) => html`<li key=${f.id}><a ...${viewerLink(rf, i)}>${f.name}</a> <span class="amv-muted">${sizeText(f.size)}</span></li>`)}</ul>` : null}
  </section>` : null;
  return html`<div class="amv">
    <a class="amv-back" href="#/meetings">All meetings</a>
    <header class="amv-head"><${Tile} date=${m.date} /><div class="amv-grow"><h1 class="amv-h1">${m.title}</h1><${Facts} m=${m} />
      ${m.myAnswer && !held ? html`<p class="amv-muted">${ANSWER[m.myAnswer]}</p>` : null}
      ${m.inviteNote && !held ? html`<p class="amv-muted">${m.inviteNote}</p>` : null}
      <${Actions} m=${m} ctx=${ctx} /></div></header>
    ${held ? recap : null}
    ${m.sections.length ? html`<section class="amv-card" aria-labelledby="amv-agenda"><h2 class="amv-h2" id="amv-agenda">Agenda</h2>
      <ol class="amv-agenda">${m.sections.map((s) => html`<li key=${s.id}><h3 class="amv-h3">${s.title}</h3>
        <ul class="amv-items">${s.items.map((it) => html`<li key=${it.id}>
          <p class="amv-strong">${it.title}</p>
          ${it.report ? html`<${Report} text=${it.report} level=${4} />` : null}
          ${it.docs.length ? html`<ul class="amv-files">${it.docs.filter((d) => at(d) >= 0).map((d) => html`<li key=${d}><a ...${viewerLink(vf, at(d))}>${m.files[at(d)].name}</a></li>`)}</ul>` : null}
        </li>`)}</ul>
      </li>`)}</ol>
    </section>` : null}
    ${loose.length ? html`<section class="amv-card" aria-labelledby="amv-docs"><h2 class="amv-h2" id="amv-docs">Documents</h2><ul class="amv-files">${loose.map((f) => html`<li key=${f.id}><a ...${viewerLink(vf, at(f.id))}>${f.name}</a> <span class="amv-muted">${sizeText(f.size)}</span></li>`)}</ul></section>` : null}
    ${held ? null : recap}
  </div>`;
}

let added = false;
function addStyles() {
  if (added || document.getElementById('amv-styles')) { added = true; return; }
  added = true;
  const el = document.createElement('style');
  el.id = 'amv-styles';
  el.textContent = `
.amv{--amv-ink:#2D2E33;--amv-soft:#5A5B61;--amv-line:#E5E4E0;--amv-sun:#FFDA24;--amv-dark:#373A36;color:var(--amv-ink);font-family:Outfit,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;display:grid;gap:14px;min-width:0}
.amv *{box-sizing:border-box}
.amv-card{background:#fff;border:1px solid var(--amv-line);border-radius:14px;padding:18px;display:grid;gap:10px;min-width:0}
.amv-next{display:flex;gap:16px;align-items:flex-start}
.amv-grow{flex:1;min-width:0;display:grid;gap:3px}
.amv-kick{margin:0;font-size:13px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--amv-soft)}
.amv-title{font-family:'Libre Baskerville',Georgia,serif;font-size:20px;font-weight:700;color:inherit;text-decoration:none;line-height:1.25}
.amv-title:hover{text-decoration:underline}
.amv-h1{font-family:'Libre Baskerville',Georgia,serif;font-size:clamp(24px,5vw,32px);line-height:1.2;margin:0}
.amv-h2{font-size:17px;font-weight:700;margin:0}
.amv-h3{font-size:15px;font-weight:700;margin:0 0 4px}
.amv-facts{margin:2px 0 0}
.amv-muted{color:var(--amv-soft);margin:0}
.amv-strong{font-weight:600;margin:0}
.amv-back{color:inherit;justify-self:start;text-underline-offset:2px}
.amv-head{display:flex;gap:16px;align-items:flex-start}
.amv-tile{width:60px;height:60px;flex:none;border-radius:12px;background:var(--amv-sun);display:grid;place-items:center;align-content:center;font-size:23px;font-weight:700;line-height:1.05}
.amv-tile b{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.05em}
.amv-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:8px}
.amv-actions:empty{display:none}
.amv-btn{font:inherit;font-weight:600;padding:9px 16px;border-radius:9px;border:1px solid var(--amv-dark);background:#fff;color:var(--amv-dark);cursor:pointer;text-decoration:none;display:inline-block}
.amv-btn--main{background:var(--amv-sun);border-color:var(--amv-sun);color:#2D2E33}
.amv-list,.amv-items,.amv-files{list-style:none;margin:0;padding:0;display:grid;gap:8px}
.amv-row{display:flex;gap:12px;align-items:center;background:#fff;border:1px solid var(--amv-line);border-radius:12px;padding:10px 12px;color:inherit;text-decoration:none}
.amv-row:hover{border-color:var(--amv-dark)}
.amv-row strong{display:block}
.amv-chip{font-size:12px;font-weight:600;padding:2px 9px;border-radius:999px;background:#F5F4F0}
.amv-agenda{margin:0;padding-left:20px;display:grid;gap:14px}
.amv-files a{color:inherit;overflow-wrap:anywhere;text-underline-offset:2px}
.amv a:focus-visible,.amv button:focus-visible{outline:2px solid var(--amv-dark);outline-offset:2px}
@media (max-width:480px){.amv-next,.amv-head{gap:12px}.amv-tile{width:52px;height:52px;font-size:20px}}
`;
  document.head.append(el);
}
