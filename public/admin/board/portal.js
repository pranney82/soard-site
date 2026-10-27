/**
 * The board page (/admin/board/)
 * ==============================
 * The one place a SOARD board member goes for the board: the next meeting
 * (answer whether you're coming, add it to your calendar), every meeting's
 * agenda, notes, minutes, votes and files, the financials, the reveal
 * calendar, who's who, and the documents to read and sign each year.
 *
 * Signed in with the same emailed code as staff; the server answers only
 * board members (People → Board, by their private email) and the Board
 * area's admins (who see it as the board does and can't answer for anyone).
 *
 *   #/             Home          #/meetings/<id>   one meeting
 *   #/meetings     Meetings      #/financials      Financials
 *   #/reveals      Reveals       #/people          People
 *   #/documents    Documents
 * Server: /api/board-portal (and /api/board-file for files).
 */

import { h, htm, render, useState, useEffect } from '../vendor.js';
import { viewerLink, sizeText } from '../file-viewer.js';
import {
  RSVP, DOC_KINDS, meetingName, longDate, shortDate, timeRange, clock, money, plural, noteBlocks, liveLines, attendanceCounts, isDate, todayEastern,
} from '../board-shared.js';

const html = htm.bind(h);
const API = '/api/board-portal';
const LOGO = '/cdn-cgi/imagedelivery/ROYFuPmfN2vPS6mt5sCkZQ/brand-logo-admin/w=128';
const SITE = 'https://sunshineonaranneyday.com';
const NAV = [['', 'Home'], ['meetings', 'Meetings'], ['financials', 'Financials'], ['reveals', 'Reveals'], ['people', 'People'], ['documents', 'Documents']];

async function call(body) {
  let r;
  try {
    r = await fetch(API, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' });
  } catch {
    return { ok: false, error: 'No connection. Check your internet and try again.' };
  }
  let j = {};
  try { j = await r.json(); } catch { j = { ok: false, error: /cloudflareaccess/i.test(r.url || '') ? 'Your sign-in expired. Reload the page to sign in again.' : `Something went wrong (${r.status})` }; }
  if (!r.ok && j.ok !== false) j.ok = false;
  j.status = r.status;
  return j;
}
const readRoute = () => {
  const [page = '', id = null] = location.hash.replace(/^#\/?/, '').split('/').map((x) => decodeURIComponent(x));
  return { page: NAV.some(([p]) => p === page) ? page : '', id };
};
const fileUrl = (f) => `/api/board-file?id=${encodeURIComponent(f.id)}`;
const asViewer = (files) => files.map((f) => ({ name: f.name, type: f.type, size: f.size, at: f.at, url: fileUrl(f) }));
const dayOf = (d) => (isDate(d) ? new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' }) : '');
const monthOf = (ym) => new Date(`${ym}-15T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const firstName = (n) => String(n || '').split(/\s+/)[0];
const greeting = () => { const hr = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: 'America/New_York' }).format(new Date())); return hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening'; };

// ─── Calendar files ─────────────────────────────────────────────────
/** An Atlanta wall-clock time as UTC "20261119T130000Z" */
function utcStamp(date, time) {
  const guess = new Date(`${date}T${time}:00Z`);
  const off = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'shortOffset' }).formatToParts(guess).find((p) => p.type === 'timeZoneName')?.value || 'GMT-5';
  const [, sign, hh, mm] = off.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/) || [null, '-', '5', '0'];
  const minutes = (Number(hh) * 60 + Number(mm || 0)) * (sign === '-' ? -1 : 1);
  return new Date(guess.getTime() - minutes * 60000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}
function meetingEvent(m) {
  if (!isDate(m.date)) return null;
  const start = m.start || '08:00';
  const end = m.end || `${String(Math.min(23, Number(start.slice(0, 2)) + 2)).padStart(2, '0')}${start.slice(2)}`;
  const where = [m.location, m.address].filter(Boolean).join(', ');
  return { title: `SOARD ${meetingName(m)}`, start: utcStamp(m.date, start), end: utcStamp(m.date, end), where, details: `The agenda and packet: ${SITE}/admin/board/#/meetings/${m.id}${m.video ? `\nVideo: ${m.video}` : ''}`, uid: `board-${m.id}@sunshineonaranneyday.com` };
}
const esc = (s) => String(s).replace(/[\\;,]/g, (c) => `\\${c}`).replace(/\n/g, '\\n');
function icsHref(ev) {
  const body = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Sunshine on a Ranney Day//Board//EN', 'BEGIN:VEVENT', `UID:${ev.uid}`, `DTSTAMP:${new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')}`,
    `DTSTART:${ev.start}`, `DTEND:${ev.end}`, `SUMMARY:${esc(ev.title)}`, ev.where ? `LOCATION:${esc(ev.where)}` : '', `DESCRIPTION:${esc(ev.details)}`, 'END:VEVENT', 'END:VCALENDAR'].filter(Boolean).join('\r\n');
  return URL.createObjectURL(new Blob([body], { type: 'text/calendar' }));
}
const googleHref = (ev) => `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(ev.title)}&dates=${ev.start}/${ev.end}&details=${encodeURIComponent(ev.details)}&location=${encodeURIComponent(ev.where)}`;

// ─── The page ───────────────────────────────────────────────────────
function App() {
  const [data, setData] = useState(null);
  const [fail, setFail] = useState(null);
  const [route, setRoute] = useState(readRoute);
  const [note, setNote] = useState('');
  const load = async () => {
    const j = await call();
    if (j.ok) { setData(j); setFail(null); } else setFail(j);
  };
  useEffect(() => { load(); }, []);
  useEffect(() => {
    const on = () => { setRoute(readRoute()); window.scrollTo(0, 0); };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  useEffect(() => { if (note) { const t = setTimeout(() => setNote(''), 4000); return () => clearTimeout(t); } return undefined; }, [note]);
  // On a phone the tabs scroll sideways: keep the open one in view
  useEffect(() => { document.querySelector('.bp-nav [aria-current="page"]')?.scrollIntoView({ inline: 'center', block: 'nearest' }); }, [route.page, !!data]);
  useEffect(() => {
    const m = route.page === 'meetings' && route.id && data?.meetings.find((x) => x.id === route.id);
    document.title = m ? `${meetingName(m)} · SOARD Board` : `${NAV.find(([p]) => p === route.page)?.[1] || 'Home'} · SOARD Board`;
  }, [route, data]);

  if (fail) {
    const staff = fail.status === 403 && /team or board list|board page is for/i.test(fail.error || '');
    return html`<div class="bp-fail" role="alert">
      <h1>${fail.status === 403 ? 'This page is for SOARD’s board' : 'The board page didn’t open'}</h1>
      <p>${fail.status === 403
        ? 'It opens for the email address on file for each board member. If that should be you, ask Holly or Peter to check the email they have for you.'
        : fail.error}</p>
      <p>${staff ? html`<a class="bp-btn" href="/admin/">Go to the admin</a> ` : null}<button class="bp-btn" onClick=${load}>Try again</button> <a class="bp-btn" href="/cdn-cgi/access/logout">Sign out</a></p>
    </div>`;
  }
  if (!data) return html`<p class="bp-loading">Opening the board page…</p>`;
  const ctx = { data, setData, load, say: setNote };
  const page = route.page === 'meetings' && route.id ? html`<${MeetingPage} id=${route.id} ctx=${ctx} />`
    : route.page === 'meetings' ? html`<${MeetingsPage} ctx=${ctx} />`
    : route.page === 'financials' ? html`<${FinancialsPage} ctx=${ctx} />`
    : route.page === 'reveals' ? html`<${RevealsPage} ctx=${ctx} />`
    : route.page === 'people' ? html`<${PeoplePage} ctx=${ctx} />`
    : route.page === 'documents' ? html`<${DocumentsPage} ctx=${ctx} />`
    : html`<${HomePage} ctx=${ctx} />`;
  return html`
    <header class="bp-top">
      <div class="bp-bar">
        <a class="bp-brand" href="#/"><img src=${LOGO} alt="" /><span><strong>Sunshine on a Ranney Day</strong><small>Board of Directors</small></span></a>
        <div class="bp-me"><span class="bp-me__name">${data.me.name || 'Viewing as the board'}</span><a href="/cdn-cgi/access/logout">Sign out</a></div>
      </div>
      <nav class="bp-nav" aria-label="Board">
        ${NAV.map(([p, label]) => html`<a href=${`#/${p}`} aria-current=${route.page === p ? 'page' : null}>${label}</a>`)}
      </nav>
    </header>
    <main class="bp-main" id="main">
      ${data.me.admin ? html`<p class="bp-banner">You’re seeing the board page the way board members do. Answers, ticks and signatures are theirs to give. <a href="/admin/#board">Back to the Board area</a></p>` : null}
      ${page}
    </main>
    <div class="sr-only" role="status" aria-live="polite">${note}</div>`;
}

// ─── Home ───────────────────────────────────────────────────────────
function HomePage({ ctx }) {
  const { data } = ctx;
  const next = data.meetings.find((m) => m.id === data.next);
  const last = data.meetings.filter((m) => m.date < data.today).sort((a, b) => b.date.localeCompare(a.date))[0];
  const mine = data.actions.filter((a) => a.mine);
  const toSign = data.docs.filter((d) => d.sign && !d.signedByMe);
  const n = data.numbers;
  return html`
    <div class="bp-hello">
      <h1>${data.me.name ? `${greeting()}, ${firstName(data.me.name)}` : 'The board page'}</h1>
      <p>Everything for SOARD’s board, in one place.</p>
    </div>
    <div class="bp-grid">
      <div class="bp-stack">
        ${next ? html`<${NextMeeting} m=${next} ctx=${ctx} />` : html`<div class="bp-card"><p class="bp-eyebrow">Next meeting</p><p class="bp-when">Not scheduled yet</p><p class="bp-muted">You’ll get an email when the next packet is ready.</p></div>`}
        ${mine.length || toSign.length ? html`<div class="bp-card">
          <h2 class="bp-h2">Your to-dos</h2>
          <ul class="bp-list">
            ${mine.map((a) => html`<${MyAction} a=${a} ctx=${ctx} key=${a.id} />`)}
            ${toSign.map((d) => html`<li key=${d.id}><div class="bp-list__main"><a class="bp-list__title" href="#/documents">Read and sign: ${d.title}</a><div class="bp-list__meta">Every board member signs it each year</div></div></li>`)}
          </ul>
        </div>` : null}
      </div>
      <div class="bp-stack">
        <div class="bp-card">
          <h2 class="bp-h2">At a glance</h2>
          <div class="bp-stats">
            <div class="bp-stat"><div class="bp-stat__value">${n.impact.kids.toLocaleString()}</div><div class="bp-stat__label">children served since 2012</div></div>
            <div class="bp-stat"><div class="bp-stat__value">${n.impact.rooms.toLocaleString()}</div><div class="bp-stat__label">rooms built</div></div>
            ${n.projects ? html`<div class="bp-stat"><div class="bp-stat__value">${(n.projects.building || []).length}</div><div class="bp-stat__label">makeovers in progress</div></div>` : null}
            ${n.cash ? html`<div class="bp-stat"><div class="bp-stat__value">${money(n.cash.total)}</div><div class="bp-stat__label">in the bank ${n.cash.at ? `(${shortDate(n.cash.at.slice(0, 10))})` : ''}</div></div>` : null}
          </div>
        </div>
        <div class="bp-card">
          <h2 class="bp-h2">Coming up</h2>
          <ul class="bp-list">
            ${data.numbers.reveals.slice(0, 4).map((r) => html`<li key=${`r-${r.slug}`}><div class="bp-list__main"><a class="bp-list__title" href=${r.kidUrl} target="_blank" rel="noopener">${r.name}’s reveal</a><div class="bp-list__meta">${r.confirmed ? `${dayOf(r.date)}${r.time ? `, ${clock(r.time)}` : ''}` : `${r.window?.label || 'Date to come'} · not confirmed yet`}</div></div></li>`)}
            ${data.numbers.events.slice(0, 3).map((e) => html`<li key=${`e-${e.slug}`}><div class="bp-list__main"><a class="bp-list__title" href=${e.url} target="_blank" rel="noopener">${e.title}</a><div class="bp-list__meta">${[dayOf(e.date), e.location].filter(Boolean).join(' · ')}</div></div></li>`)}
          </ul>
          ${!data.numbers.reveals.length && !data.numbers.events.length ? html`<p class="bp-muted">Nothing on the calendar yet.</p>` : null}
          <div class="bp-btns"><a class="bp-btn" href="#/reveals">The reveal calendar</a></div>
        </div>
        ${last ? html`<div class="bp-card">
          <h2 class="bp-h2">Last meeting</h2>
          <a class="bp-list__title" href=${`#/meetings/${last.id}`}>${meetingName(last)}</a>
          <div class="bp-list__meta">${longDate(last.date)} · ${last.minutes === 'approved' ? 'Minutes approved' : 'Draft minutes'}</div>
        </div>` : null}
      </div>
    </div>`;
}

function NextMeeting({ m, ctx }) {
  const ev = meetingEvent(m);
  const [ics, setIcs] = useState(null);
  useEffect(() => { if (!ev) return undefined; const u = icsHref(ev); setIcs(u); return () => URL.revokeObjectURL(u); }, [m.id, m.date, m.start, m.end, m.location]);
  return html`<div class="bp-card bp-card--next">
    <p class="bp-eyebrow">Next meeting</p>
    <p class="bp-when">${dayOf(m.date)}</p>
    <div class="bp-facts">
      ${m.start ? html`<div>${timeRange(m.start, m.end)}</div>` : null}
      ${m.location ? html`<div>${m.location}${m.address ? html`, <a href=${`https://maps.google.com/?q=${encodeURIComponent(m.address)}`} target="_blank" rel="noopener">${m.address}</a>` : null}</div>` : null}
      ${m.video ? html`<div><a href=${m.video} target="_blank" rel="noopener">Join by video</a></div>` : null}
    </div>
    <div class="bp-btns">
      <a class="bp-btn bp-btn--primary" href=${`#/meetings/${m.id}`}>See the agenda</a>
      ${ev && ics ? html`<a class="bp-btn" href=${ics} download="soard-board-meeting.ics">Add to my calendar</a><a class="bp-btn" href=${googleHref(ev)} target="_blank" rel="noopener">Google Calendar</a>` : null}
    </div>
    <${Rsvp} m=${m} ctx=${ctx} />
  </div>`;
}

function Rsvp({ m, ctx }) {
  const { data, setData, say } = ctx;
  const [busy, setBusy] = useState(false);
  if (!data.me.slug || m.date < data.today) return null;
  const answer = async (id) => {
    setBusy(true);
    const j = await call({ action: 'rsvp', meetingId: m.id, answer: id });
    setBusy(false);
    if (!j.ok) { say(j.error); return; }
    setData((d) => ({ ...d, meetings: d.meetings.map((x) => (x.id === m.id ? { ...x, myRsvp: id } : x)) }));
    say('Thanks, Holly and Peter can see your answer.');
  };
  return html`<div class="bp-rsvp">
    <p>${m.myRsvp ? 'Your answer' : 'Will you be there?'}</p>
    <div class="bp-chips" role="group" aria-label="Will you be there?">${RSVP.map((r) => html`<button class="bp-btn" aria-pressed=${m.myRsvp === r.id} disabled=${busy} onClick=${() => answer(r.id)}>${r.label}</button>`)}</div>
  </div>`;
}

function MyAction({ a, ctx }) {
  const { setData, say } = ctx;
  const [done, setDone] = useState(false);
  const tick = async (v) => {
    setDone(v);
    const j = await call({ action: 'action-done', actionId: a.id, done: v });
    if (!j.ok) { setDone(!v); say(j.error); return; }
    say(v ? 'Marked done' : 'Marked not done');
    if (v) setTimeout(() => setData((d) => ({ ...d, actions: d.actions.filter((x) => x.id !== a.id) })), 900);
  };
  return html`<li><label class="bp-todo">
    <input type="checkbox" checked=${done} onChange=${(e) => tick(e.target.checked)} />
    <span><span class="bp-list__title">${a.text}</span><span class="bp-list__meta" style="display:block">${[a.due ? `Due ${shortDate(a.due)}` : '', `From the ${a.meetingName}`].filter(Boolean).join(' · ')}</span></span>
  </label></li>`;
}

// ─── Meetings ───────────────────────────────────────────────────────
function MeetingsPage({ ctx }) {
  const { data } = ctx;
  const upcoming = data.meetings.filter((m) => m.date >= data.today).sort((a, b) => a.date.localeCompare(b.date));
  const past = data.meetings.filter((m) => m.date < data.today);
  const years = [...new Set(past.map((m) => m.date.slice(0, 4)))];
  const row = (m) => html`<li key=${m.id}><div class="bp-list__main"><a class="bp-list__title" href=${`#/meetings/${m.id}`}>${meetingName(m)}</a><div class="bp-list__meta">${[longDate(m.date), m.location].filter(Boolean).join(' · ')}</div></div>
    <span class="bp-chips">${m.date >= data.today ? html`<span class="bp-chip bp-chip--info">Coming up</span>` : m.minutes === 'approved' ? html`<span class="bp-chip bp-chip--ok">Minutes approved</span>` : html`<span class="bp-chip bp-chip--warn">Draft minutes</span>`}${m.files.length ? html`<span class="bp-chip">${plural(m.files.length, 'file')}</span>` : null}</span></li>`;
  return html`
    <h1 class="bp-h1">Meetings</h1>
    <p class="bp-lede" style="margin-bottom:1.25rem">Every agenda, with the notes, votes and files from the meeting.</p>
    ${upcoming.length ? html`<div class="bp-card" style="margin-bottom:1.25rem"><h2 class="bp-h2">Coming up</h2><ul class="bp-list">${upcoming.map(row)}</ul></div>` : null}
    <div class="bp-card">
      <h2 class="bp-h2">Past meetings</h2>
      ${past.length ? years.map((y) => html`<p class="bp-year">${y}</p><ul class="bp-list">${past.filter((m) => m.date.startsWith(y)).map(row)}</ul>`) : html`<p class="bp-muted">Past meetings show here once they’re added.</p>`}
    </div>`;
}

function Notes({ text }) {
  const blocks = noteBlocks(text);
  if (!blocks.length) return null;
  const list = (nodes) => html`<ul class="bp-notes">${nodes.map((n) => html`<li>${n.text}${n.children.length ? list(n.children) : null}</li>`)}</ul>`;
  const out = [];
  let run = [];
  for (const b of blocks) {
    if (b.para) { if (run.length) { out.push(list(run)); run = []; } out.push(html`<p class="bp-para">${b.text}</p>`); } else run.push(b);
  }
  if (run.length) out.push(list(run));
  return out;
}

function MeetingPage({ id, ctx }) {
  const { data } = ctx;
  const m = data.meetings.find((x) => x.id === id);
  if (!m) return html`<a class="bp-back" href="#/meetings">← Meetings</a><div class="bp-card"><h1 class="bp-h2">That meeting isn’t on the board page</h1><p class="bp-muted">It may not be shared yet.</p></div>`;
  const upcoming = m.date >= data.today;
  // A past meeting shows only the numbers locked into its packet; one ahead shows today's until then
  const numbers = m.snapshot || (upcoming ? data.numbers : null);
  const c = attendanceCounts(m);
  const here = m.attendance.filter((p) => p.status === 'present' || p.status === 'remote');
  const away = m.attendance.filter((p) => p.status === 'absent' || p.status === 'excused');
  const vf = asViewer(m.files);
  const ev = upcoming ? meetingEvent(m) : null;
  return html`
    <a class="bp-back" href="#/meetings">← Meetings</a>
    <div class="bp-meeting-head">
      <div>
        <p class="bp-eyebrow">${upcoming ? 'Agenda' : m.minutes === 'approved' ? 'Minutes' : 'Draft minutes'}</p>
        <h1 class="bp-h1">${meetingName(m)}</h1>
        <p class="bp-lede">${[longDate(m.date), timeRange(m.start, m.end), m.location].filter(Boolean).join(' · ')}</p>
        ${m.minutes === 'approved' && m.approvedOn ? html`<p class="bp-muted">Approved ${shortDate(m.approvedOn)}</p>` : null}
      </div>
      <div class="bp-btns bp-noprint" style="margin-top:0">
        ${ev ? html`<a class="bp-btn" href=${googleHref(ev)} target="_blank" rel="noopener">Add to Google Calendar</a>` : null}
        <button class="bp-btn" onClick=${() => window.print()}>Print or save as PDF</button>
      </div>
    </div>
    <div class="bp-grid">
      <div class="bp-stack">
        <div class="bp-card bp-agenda">
          ${m.sections.map((s) => html`<section class="bp-sec">
            <h3>${s.title}</h3>
            ${s.items.map((it) => html`<div class="bp-item">
              <div class="bp-item__title">${it.title}${it.presenter ? html`<span class="bp-item__who">${it.presenter}</span>` : null}${it.confidential ? html`<span class="bp-chip bp-chip--warn">Confidential</span>` : null}</div>
              <${Notes} text=${it.notes} />
              ${it.live && it.live !== 'minutes' && numbers && liveLines(it.live, numbers, { meetingId: m.id }).length ? html`<div class="bp-live">
                <div class="bp-live__label">${m.snapshot ? `As of ${shortDate(m.snapshot.at.slice(0, 10))}` : 'As of today'}</div>
                <ul>${liveLines(it.live, numbers, { meetingId: m.id }).map((l) => html`<li>${l}</li>`)}</ul>
              </div>` : null}
            </div>`)}
          </section>`)}
        </div>
        ${m.motions.length ? html`<div class="bp-card"><h2 class="bp-h2">Motions and votes</h2><ul class="bp-list">${m.motions.map((x) => html`<li><div class="bp-list__main"><div class="bp-list__title">${x.text}</div><div class="bp-list__meta">${[x.by && `Moved by ${x.by}`, x.second && `seconded by ${x.second}`].filter(Boolean).join(', ')}</div></div><span class=${`bp-chip ${x.result === 'passed' ? 'bp-chip--ok' : ''}`}>${{ passed: 'Passed', failed: 'Did not pass', tabled: 'Tabled' }[x.result]}</span></li>`)}</ul></div>` : null}
      </div>
      <div class="bp-stack">
        ${upcoming && m.id === data.next ? html`<div class="bp-card bp-noprint"><${Rsvp} m=${m} ctx=${ctx} /></div>` : null}
        ${m.files.length ? html`<div class="bp-card"><h2 class="bp-h2">Files</h2><ul class="bp-list">${m.files.map((f, i) => html`<li><div class="bp-list__main"><a class="bp-list__title" ...${viewerLink(vf, i)}>${f.name}</a><div class="bp-list__meta">${[{ financials: 'Financial statements', packet: 'Packet', agenda: 'Original agenda', minutes: 'Signed minutes' }[f.kind], sizeText(f.size)].filter(Boolean).join(' · ')}</div></div></li>`)}</ul></div>` : null}
        ${m.attendance.length && !upcoming ? html`<div class="bp-card"><h2 class="bp-h2">Who was there</h2>
          <p class="bp-people-line">${here.map((p) => `${p.name}${p.status === 'remote' ? ' (by video)' : ''}`).join(', ') || 'Not recorded'}</p>
          ${away.length ? html`<p class="bp-muted">Not there: ${away.map((p) => p.name).join(', ')}</p>` : null}
          <p class="bp-muted">${c.boardHere} of ${c.board} board members${data.quorum ? ` · a quorum is ${data.quorum}` : ''}</p>
        </div>` : null}
        ${m.actions.length ? html`<div class="bp-card"><h2 class="bp-h2">Action items</h2><ul class="bp-list">${m.actions.map((a) => html`<li><div class="bp-list__main"><div class="bp-list__title" style=${a.done ? 'text-decoration:line-through;opacity:.7' : ''}>${a.text}</div><div class="bp-list__meta">${[a.ownerName, a.due ? `due ${shortDate(a.due)}` : '', a.done ? 'done' : ''].filter(Boolean).join(' · ')}</div></div></li>`)}</ul></div>` : null}
      </div>
    </div>`;
}

// ─── Financials ─────────────────────────────────────────────────────
function FinancialsPage({ ctx }) {
  const { data } = ctx;
  const statements = data.meetings.flatMap((m) => m.files.filter((f) => f.kind === 'financials').map((f) => ({ ...f, meeting: m }))).sort((a, b) => b.meeting.date.localeCompare(a.meeting.date));
  const budgets = data.docs.filter((d) => d.kind === 'financial' && d.file);
  const sv = asViewer(statements);
  const bv = asViewer(budgets.map((d) => ({ ...d.file, name: d.title })));
  const cash = data.numbers.cash;
  const history = data.cashHistory;
  const s = data.snapshot;
  return html`
    <h1 class="bp-h1">Financials</h1>
    <p class="bp-lede" style="margin-bottom:1.25rem">Cash, the statements from each meeting, budgets and audits, and the tax returns.</p>
    <div class="bp-grid">
      <div class="bp-stack">
        <div class="bp-card">
          <h2 class="bp-h2">Cash in the bank</h2>
          ${cash ? html`<p class="bp-when" style="margin:0">${money(cash.total)}</p><p class="bp-muted">${cash.accounts.length > 1 ? `${cash.accounts.map((a) => `${a.name} ${money(a.balance)}`).join(' · ')} · ` : ''}from Mercury, ${shortDate(cash.at.slice(0, 10))}</p>` : html`<p class="bp-muted">The balance shows here once the bank is connected.</p>`}
          ${history.length > 1 ? html`<table class="bp-table" style="margin-top:1rem"><thead><tr><th>Month</th><th class="num">Balance</th><th class="num">Change</th></tr></thead><tbody>
            ${history.map((r, i) => { const prev = history[i + 1]; const d = prev ? r.total - prev.total : null; return html`<tr><td>${monthOf(r.month)}</td><td class="num">${money(r.total)}</td><td class="num">${d == null ? '' : `${d >= 0 ? '+' : '−'}${money(Math.abs(d))}`}</td></tr>`; })}
          </tbody></table>` : null}
        </div>
        <div class="bp-card">
          <h2 class="bp-h2">Financial statements</h2>
          ${statements.length ? html`<ul class="bp-list">${statements.map((f, i) => html`<li><div class="bp-list__main"><a class="bp-list__title" ...${viewerLink(sv, i)}>${f.name}</a><div class="bp-list__meta">${meetingName(f.meeting)} · ${shortDate(f.meeting.date)}</div></div></li>`)}</ul>` : html`<p class="bp-muted">The income statement and balance sheet from each meeting show here.</p>`}
        </div>
        ${budgets.length ? html`<div class="bp-card"><h2 class="bp-h2">Budgets and audits</h2><ul class="bp-list">${budgets.map((d, i) => html`<li><div class="bp-list__main"><a class="bp-list__title" ...${viewerLink(bv, i)}>${d.title}</a>${d.note ? html`<div class="bp-list__meta">${d.note}</div>` : null}</div></li>`)}</ul></div>` : null}
      </div>
      <div class="bp-stack">
        ${s ? html`<div class="bp-card">
          <h2 class="bp-h2">${s.year} at a glance</h2>
          <table class="bp-table"><tbody>
            ${[['Total revenue', s.totalRevenue], ['Contributions', s.contributions], ['Store revenue', s.storeRevenue], ['Total expenses', s.totalExpenses], ['Program expenses', s.programExpenses], ['Net assets', s.netAssets]].filter(([, v]) => typeof v === 'number').map(([k, v]) => html`<tr><td>${k}</td><td class="num">${money(v)}</td></tr>`)}
          </tbody></table>
          ${s.programPct ? html`<p class="bp-muted" style="margin-top:0.75rem">${s.programPct}% to programs, ${s.managementPct}% management, ${s.fundraisingPct}% fundraising (from the ${s.year} return)</p>` : null}
        </div>` : null}
        ${data.filings.length ? html`<div class="bp-card"><h2 class="bp-h2">Tax returns and filings</h2><ul class="bp-list">${data.filings.map((d) => html`<li><div class="bp-list__main"><a class="bp-list__title" href=${d.url} target="_blank" rel="noopener">${d.title}</a></div></li>`)}</ul><p class="bp-muted" style="margin-top:0.75rem">The public copies, as on the website’s Financials page.</p></div>` : null}
      </div>
    </div>`;
}

// ─── Reveals ────────────────────────────────────────────────────────
function RevealsPage({ ctx }) {
  const { data } = ctx;
  const n = data.numbers;
  const feed = data.revealFeed;
  const webcal = feed.replace(/^https:/, 'webcal:');
  const order = ['Build', 'Mobilization', 'Approval', 'Finalization', 'Design'];
  const building = n.projects?.building || [];
  return html`
    <h1 class="bp-h1">Reveals</h1>
    <p class="bp-lede" style="margin-bottom:1.25rem">Every reveal coming up, and the makeovers being built. You also get a calendar invite with the address for each one.</p>
    <div class="bp-grid">
      <div class="bp-stack">
        <div class="bp-card">
          <h2 class="bp-h2">Coming up</h2>
          ${n.reveals.length ? html`<ul class="bp-list">${n.reveals.map((r) => html`<li key=${r.slug}><div class="bp-list__main"><a class="bp-list__title" href=${r.kidUrl} target="_blank" rel="noopener">${r.name}</a><div class="bp-list__meta">${r.confirmed ? `${dayOf(r.date)}${r.time ? `, ${clock(r.time)}` : ''}` : r.window?.label || 'Date to come'}</div></div><span class=${`bp-chip ${r.confirmed ? 'bp-chip--ok' : ''}`}>${r.confirmed ? 'Confirmed' : 'Not confirmed yet'}</span></li>`)}</ul>` : html`<p class="bp-muted">No reveals on the calendar right now.</p>`}
          <div class="bp-btns">
            <a class="bp-btn bp-btn--primary" href=${webcal}>Subscribe on iPhone or Mac</a>
            <a class="bp-btn" href=${`https://calendar.google.com/calendar/render?cid=${encodeURIComponent(webcal)}`} target="_blank" rel="noopener">Subscribe in Google Calendar</a>
          </div>
          <p class="bp-muted" style="margin-top:0.6rem">The subscription adds each reveal once its day is confirmed, and moves it if the day changes.</p>
        </div>
        ${n.pastReveals.length ? html`<div class="bp-card"><h2 class="bp-h2">Recent reveals</h2><ul class="bp-list">${n.pastReveals.map((r) => html`<li key=${r.slug}><div class="bp-list__main"><a class="bp-list__title" href=${r.kidUrl} target="_blank" rel="noopener">${r.name}</a><div class="bp-list__meta">${dayOf(r.date)}</div></div></li>`)}</ul></div>` : null}
      </div>
      <div class="bp-stack">
        <div class="bp-card">
          <h2 class="bp-h2">Being built now</h2>
          ${building.length ? order.filter((st) => building.some((b) => b.status === st)).map((st) => html`<p class="bp-year" style="margin-top:0.75rem">${st}</p><p style="margin:0">${building.filter((b) => b.status === st).map((b, i) => html`${i ? ', ' : ''}${b.slug ? html`<a href=${`/kids/${b.slug}/`} target="_blank" rel="noopener">${b.name}</a>` : b.name}`)}</p>`)
            : html`<p class="bp-muted">${n.projects ? 'No makeovers in progress right now.' : 'The list from JobTread isn’t available right now.'}</p>`}
        </div>
        ${n.events.length ? html`<div class="bp-card"><h2 class="bp-h2">Events</h2><ul class="bp-list">${n.events.map((e) => html`<li key=${e.slug}><div class="bp-list__main"><a class="bp-list__title" href=${e.url} target="_blank" rel="noopener">${e.title}</a><div class="bp-list__meta">${[dayOf(e.date), e.time, e.location].filter(Boolean).join(' · ')}</div></div></li>`)}</ul></div>` : null}
      </div>
    </div>`;
}

// ─── People ─────────────────────────────────────────────────────────
const initialsOf = (name) => String(name || '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
function Person({ p, email = false }) {
  return html`<div class="bp-person">
    ${p.photo ? html`<img class="bp-avatar" src=${p.photo} alt="" loading="lazy" />` : html`<span class="bp-avatar" aria-hidden="true">${initialsOf(p.name)}</span>`}
    <div style="min-width:0">
      <div class="bp-person__name">${p.name}</div>
      <div class="bp-person__meta">${[p.title, p.organization].filter(Boolean).join(' · ')}</div>
      ${p.committees?.length ? html`<div class="bp-person__meta">${p.committees.join(', ')}</div>` : null}
      ${email && p.email ? html`<div class="bp-person__meta"><a href=${`mailto:${p.email}`}>${p.email}</a></div>` : null}
    </div>
  </div>`;
}
function PeoplePage({ ctx }) {
  const { people } = ctx.data;
  const committees = [...new Set(people.board.flatMap((p) => p.committees || []))].sort();
  return html`
    <h1 class="bp-h1">People</h1>
    <p class="bp-lede" style="margin-bottom:1.25rem">The board, the team and the Advisory Board.</p>
    <h2 class="bp-h2">Board of Directors</h2>
    <div class="bp-people" style="margin-bottom:1.75rem">${people.board.map((p) => html`<${Person} p=${p} email key=${p.slug} />`)}</div>
    ${committees.length ? html`<div class="bp-card" style="margin-bottom:1.75rem"><h2 class="bp-h2">Committees</h2><ul class="bp-list">${committees.map((c) => html`<li><div class="bp-list__main"><div class="bp-list__title">${c}</div><div class="bp-list__meta">${people.board.filter((p) => (p.committees || []).includes(c)).map((p) => p.name).join(', ')}</div></div></li>`)}</ul></div>` : null}
    <h2 class="bp-h2">The team</h2>
    <div class="bp-people" style="margin-bottom:1.75rem">${people.staff.map((p) => html`<${Person} p=${p} key=${p.slug} />`)}</div>
    ${people.advisory.length ? html`<h2 class="bp-h2">Advisory Board</h2><div class="bp-people">${people.advisory.map((p) => html`<${Person} p=${p} key=${p.slug} />`)}</div>` : null}`;
}

// ─── Documents ──────────────────────────────────────────────────────
function SignForm({ d, ctx }) {
  const { data, setData, say } = ctx;
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  if (!data.me.slug) return null;
  if (d.signedByMe) return html`<p class="bp-muted" style="margin:0.4rem 0 0"><span class="bp-chip bp-chip--ok">Signed</span> by ${d.signedByMe.name}, ${shortDate(d.signedByMe.at.slice(0, 10))}</p>`;
  const sign = async (e) => {
    e.preventDefault();
    setBusy(true);
    const j = await call({ action: 'sign', docId: d.id, name });
    setBusy(false);
    if (!j.ok) { say(j.error); return; }
    setData((x) => ({ ...x, docs: x.docs.map((y) => (y.id === d.id ? { ...y, signedByMe: { name: j.name, at: new Date().toISOString() }, signedCount: y.signedCount + 1 } : y)) }));
    say('Signed. Thank you.');
  };
  return html`<form class="bp-sign" onSubmit=${sign}>
    <input aria-label="Type your full name to sign" placeholder="Type your full name to sign" value=${name} autocomplete="name" onInput=${(e) => setName(e.target.value)} />
    <button class="bp-btn bp-btn--primary" type="submit" disabled=${busy || name.trim().length < 3}>I’ve read it and agree</button>
  </form>`;
}
function DocumentsPage({ ctx }) {
  const { docs } = ctx.data;
  const year = todayEastern().slice(0, 4);
  return html`
    <h1 class="bp-h1">Documents</h1>
    <p class="bp-lede" style="margin-bottom:1.25rem">The bylaws, policies and plans. Some ask every board member to sign once a year (${year}).</p>
    ${docs.length ? DOC_KINDS.filter((k) => docs.some((d) => d.kind === k.id)).map((k) => {
      const list = docs.filter((d) => d.kind === k.id);
      const vf = asViewer(list.filter((d) => d.file).map((d) => ({ ...d.file, name: d.title })));
      let vi = -1;
      return html`<div class="bp-card" style="margin-bottom:1.25rem"><h2 class="bp-h2">${k.label}</h2><ul class="bp-list">${list.map((d) => {
        if (d.file) vi += 1;
        return html`<li key=${d.id} style="display:block"><div class="bp-list__main">
          ${d.file ? html`<a class="bp-list__title" ...${viewerLink(vf, vi)}>${d.title}</a>` : html`<span class="bp-list__title">${d.title}</span>`}
          <div class="bp-list__meta">${[d.note, d.file ? sizeText(d.file.size) : ''].filter(Boolean).join(' · ')}</div>
          ${d.sign ? html`<${SignForm} d=${d} ctx=${ctx} />` : null}
        </div></li>`;
      })}</ul></div>`;
    }) : html`<div class="bp-card"><p class="bp-muted">Documents show here once Holly or Peter adds them.</p></div>`}`;
}

render(html`<${App} />`, document.getElementById('board-app'));
