/**
 * The board page (/admin/board/)
 * ==============================
 * The one place a SOARD board member goes for the board: the next meeting
 * (when, where, the Google Meet link, whether you're coming), every meeting's
 * agenda, notes, minutes, votes and files, the money, what's coming up and
 * being built, who's who, and the documents to read and sign each year.
 *
 * Signed in with the same emailed code as staff; the server answers only
 * board members (People → Board, by their private email) and the Board
 * area's admins (who see it as the board does and can't answer for anyone).
 *
 *   #/             Home: the next meeting, your to-dos, what's coming up and being built
 *   #/meetings     Meetings          #/meetings/<id>   one meeting
 *   #/financials   Financials        #/people          People
 *   #/documents    Documents         (#/reveals, the old reveals page, is Home now)
 * On a phone the five pages are a bar along the bottom, in thumb's reach.
 * Server: /api/board-portal (and /api/board-file for files).
 */

import { h, htm, render, useState, useEffect } from '../vendor.js';
import { viewerLink, sizeText } from '../file-viewer.js';
import {
  RSVP, DOC_KINDS, FILE_KINDS, meetingName, longDate, shortDate, timeRange, clock, money, plural, noteBlocks, liveLines, attendanceCounts, isDate, todayEastern, monthName, answerOf, fileTitle,
} from '../board-shared.js';

const html = htm.bind(h);
const API = '/api/board-portal';
const LOGO = '/cdn-cgi/imagedelivery/ROYFuPmfN2vPS6mt5sCkZQ/brand-logo-admin/w=128';

// ─── Icons (24px line drawings, in the text's color) ────────────────
const ICONS = {
  home: html`<path d="M3.5 10.5 12 3.5l8.5 7V20a1 1 0 0 1-1 1H15v-6H9v6H4.5a1 1 0 0 1-1-1z" />`,
  meetings: html`<rect x="3.5" y="5" width="17" height="15.5" rx="2" /><path d="M3.5 10h17M8 3v4M16 3v4" />`,
  financials: html`<path d="M4 20.5h16M7 17v-5M12 17V7M17 17v-8" />`,
  people: html`<circle cx="9" cy="8.5" r="3.25" /><path d="M3 20a6 6 0 0 1 12 0" /><circle cx="17" cy="9.5" r="2.5" /><path d="M16.5 14.6A4.8 4.8 0 0 1 21 19.5" />`,
  documents: html`<path d="M14 3.5H6.5a1 1 0 0 0-1 1v15a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V8z" /><path d="M14 3.5V8h4.5M9 12.5h6M9 16.5h6" />`,
  clock: html`<circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" />`,
  pin: html`<path d="M12 21s-6.5-5.8-6.5-10.5a6.5 6.5 0 0 1 13 0C18.5 15.2 12 21 12 21z" /><circle cx="12" cy="10.5" r="2.25" />`,
  video: html`<rect x="3" y="6.5" width="12.5" height="11" rx="2" /><path d="m15.5 10.5 5.5-3v9l-5.5-3" />`,
  check: html`<path d="m5 12.5 4.5 4.5L19 7.5" />`,
  file: html`<path d="M14 3.5H6.5a1 1 0 0 0-1 1v15a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V8z" /><path d="M14 3.5V8h4.5" />`,
};
const Icon = ({ name, size = 20 }) => html`<svg class="bp-icon" width=${size} height=${size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name]}</svg>`;

const NAV = [['', 'Home', 'home'], ['meetings', 'Meetings', 'meetings'], ['financials', 'Financials', 'financials'], ['people', 'People', 'people'], ['documents', 'Documents', 'documents']];

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
const asViewer = (files) => files.map((f) => ({ name: f.name, type: f.type, size: f.size, at: f.at, url: f.url || fileUrl(f) }));
const dayOf = (d) => (isDate(d) ? new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' }) : '');
const monthOf = (ym) => new Date(`${ym}-15T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const firstName = (n) => String(n || '').split(/\s+/)[0];
const together = (names) => (names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : names[0] || '');
const greeting = () => { const hr = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: 'America/New_York' }).format(new Date())); return hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening'; };
const kindLabel = (k) => FILE_KINDS.find((x) => x.id === k)?.label || '';
const mapsHref = (s) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(s)}`;
const callName = (url) => (/meet\.google\.com/.test(url) ? 'Join with Google Meet' : /teams\.(microsoft|live)/.test(url) ? 'Join with Microsoft Teams' : /zoom\.us/.test(url) ? 'Join with Zoom' : 'Join by video');
const videoOf = (m) => m.video || m.invite?.meet || '';
/** Who the board's answers go to: "Holly and Peter" */
const theTeam = (data) => together((data.admins || []).map(firstName)) || 'SOARD';

// ─── Google Calendar link (the .ics comes from the server) ──────────
/** An Atlanta wall-clock time as UTC "20261119T130000Z" */
function utcStamp(date, time) {
  const guess = new Date(`${date}T${time}:00Z`);
  const off = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', timeZoneName: 'shortOffset' }).formatToParts(guess).find((p) => p.type === 'timeZoneName')?.value || 'GMT-5';
  const [, sign, hh, mm] = off.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/) || [null, '-', '5', '0'];
  const minutes = (Number(hh) * 60 + Number(mm || 0)) * (sign === '-' ? -1 : 1);
  return new Date(guess.getTime() - minutes * 60000).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}
function googleHref(m) {
  const start = m.start || '08:00';
  const end = m.end || `${String(Math.min(23, Number(start.slice(0, 2)) + 2)).padStart(2, '0')}${start.slice(2)}`;
  const details = `The agenda and packet: ${location.origin}/admin/board/#/meetings/${m.id}${videoOf(m) ? `\nVideo: ${videoOf(m)}` : ''}`;
  return `https://calendar.google.com/calendar/render?action=TEMPLATE&text=${encodeURIComponent(`SOARD ${meetingName(m)}`)}&dates=${utcStamp(m.date, start)}/${utcStamp(m.date, end)}&details=${encodeURIComponent(details)}&location=${encodeURIComponent([m.location, m.address].filter(Boolean).join(', '))}`;
}

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
    // The old Reveals page is part of Home now
    const home = () => { if (/^#\/?reveals/.test(location.hash)) history.replaceState(null, '', '#/'); };
    home();
    const on = () => { home(); setRoute(readRoute()); window.scrollTo(0, 0); };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  useEffect(() => { if (note) { const t = setTimeout(() => setNote(''), 5000); return () => clearTimeout(t); } return undefined; }, [note]);
  useEffect(() => {
    const m = route.page === 'meetings' && route.id && data?.meetings.find((x) => x.id === route.id);
    document.title = m ? `${meetingName(m)} · SOARD Board` : `${NAV.find(([p]) => p === route.page)?.[1] || 'Home'} · SOARD Board`;
  }, [route, data]);

  if (fail) {
    const staff = fail.status === 403 && /team or board list|board page is for/i.test(fail.error || '');
    return html`<div class="bp-fail" role="alert">
      <img src=${LOGO} alt="" width="56" height="56" />
      <h1>${fail.status === 403 ? 'This page is for SOARD’s board' : 'The board page didn’t open'}</h1>
      <p>${fail.status === 403
        ? 'It opens for the email address SOARD has on file for each board member. If that should be you, reply to any board email and we’ll check the address we have.'
        : fail.error}</p>
      <p class="bp-btns" style="justify-content:center">${staff ? html`<a class="bp-btn bp-btn--primary" href="/admin/">Go to the admin</a>` : null}<button class="bp-btn" onClick=${load}>Try again</button><a class="bp-btn" href="/cdn-cgi/access/logout">Sign out</a></p>
    </div>`;
  }
  if (!data) return html`<p class="bp-loading">Opening the board page…</p>`;
  const ctx = { data, setData, load, say: setNote };
  const page = route.page === 'meetings' && route.id ? html`<${MeetingPage} id=${route.id} ctx=${ctx} />`
    : route.page === 'meetings' ? html`<${MeetingsPage} ctx=${ctx} />`
    : route.page === 'financials' ? html`<${FinancialsPage} ctx=${ctx} />`
    : route.page === 'people' ? html`<${PeoplePage} ctx=${ctx} />`
    : route.page === 'documents' ? html`<${DocumentsPage} ctx=${ctx} />`
    : html`<${HomePage} ctx=${ctx} />`;
  return html`
    <a class="bp-skip" href="#main" onClick=${(e) => { e.preventDefault(); document.getElementById('main')?.focus(); }}>Skip to the page</a>
    <header class="bp-top">
      <div class="bp-bar">
        <a class="bp-brand" href="#/"><img src=${LOGO} alt="" width="40" height="40" /><span><strong>Sunshine on a Ranney Day</strong><small>Board of Directors</small></span></a>
        <div class="bp-me"><span class="bp-me__name">${data.me.name || 'Viewing as the board'}</span><a href="/cdn-cgi/access/logout">Sign out</a></div>
      </div>
      <nav class="bp-nav" aria-label="Board">
        ${NAV.map(([p, label, icon]) => html`<a href=${`#/${p}`} aria-current=${route.page === p ? 'page' : null}><${Icon} name=${icon} size=${22} /><span>${label}</span></a>`)}
      </nav>
    </header>
    <main class="bp-main" id="main" tabindex="-1">
      ${data.me.admin ? html`<p class="bp-banner">You’re seeing the board page the way board members do. Their answers, ticks and signatures are theirs to give. <a href="/admin/#board">Back to the Board area</a></p>` : null}
      ${page}
    </main>
    <footer class="bp-foot">
      ${data.contact ? html`<p>Questions about a meeting or this page? <a href=${`mailto:${data.contact.email}`}>Email ${firstName(data.contact.name)}</a></p>` : null}
      <p class="bp-muted">${data.me.email ? `Signed in as ${data.me.email} · ` : ''}<a href="/cdn-cgi/access/logout">Sign out</a></p>
    </footer>
    <div class=${`bp-toast ${note ? 'is-on' : ''}`} role="status" aria-live="polite">${note}</div>`;
}

// ─── Home ───────────────────────────────────────────────────────────
function HomePage({ ctx }) {
  const { data } = ctx;
  const next = data.meetings.find((m) => m.id === data.next);
  const last = data.meetings.filter((m) => m.date < data.today).sort((a, b) => b.date.localeCompare(a.date))[0];
  const mine = data.actions.filter((a) => a.mine);
  const toSign = data.docs.filter((d) => d.sign && d.file && !d.signedByMe);
  return html`
    <div class="bp-hello">
      <h1>${data.me.name ? `${greeting()}, ${firstName(data.me.name)}` : 'The board page'}</h1>
      <p>Everything for SOARD’s board in one place: meetings, money, people and documents.</p>
    </div>
    <div class="bp-grid">
      <div class="bp-stack">
        ${next ? html`<${NextMeeting} m=${next} ctx=${ctx} />` : html`<section class="bp-card bp-next">
          <p class="bp-eyebrow">Next board meeting</p>
          <h2 class="bp-when">Not scheduled yet</h2>
          <p class="bp-muted">The invite comes to your email once it’s set, and it shows here.</p>
        </section>`}
        ${mine.length || toSign.length ? html`<section class="bp-card" aria-labelledby="todo-h">
          <h2 class="bp-h2" id="todo-h">Your to-dos <span class="bp-count">${mine.length + toSign.length}</span></h2>
          <ul class="bp-list">
            ${mine.map((a) => html`<${MyAction} a=${a} ctx=${ctx} key=${a.id} />`)}
            ${toSign.map((d) => html`<li key=${d.id}><a class="bp-todo bp-todo--link" href="#/documents"><${Icon} name="documents" size=${24} /><span><span class="bp-list__title">Read and sign: ${d.title}</span><span class="bp-list__meta" style="display:block">Every board member signs it once a year</span></span></a></li>`)}
          </ul>
        </section>` : null}
        ${last ? html`<section class="bp-card" aria-labelledby="last-h">
          <h2 class="bp-h2" id="last-h">Last meeting</h2>
          <ul class="bp-list"><li><div class="bp-list__main">
            <a class="bp-list__title" href=${`#/meetings/${last.id}`}>${meetingName(last)}</a>
            <div class="bp-list__meta">${longDate(last.date)}</div>
          </div><${MinutesChip} m=${last} /></li></ul>
        </section>` : null}
      </div>
      <div class="bp-stack">
        <${Glance} n=${data.numbers} />
        <${ComingUp} data=${data} />
        <${Building} n=${data.numbers} />
        <${Recent} n=${data.numbers} />
      </div>
    </div>`;
}

function NextMeeting({ m, ctx }) {
  const { data } = ctx;
  const today = m.date === data.today;
  const video = videoOf(m);
  return html`<section class="bp-card bp-next" aria-labelledby="next-h">
    <p class="bp-eyebrow">${today ? 'Today’s board meeting' : 'Next board meeting'}</p>
    <h2 class="bp-when" id="next-h">${dayOf(m.date)}</h2>
    <ul class="bp-facts">
      <li><${Icon} name="clock" /><span>${m.start ? timeRange(m.start, m.end) : 'Time to come'}</span></li>
      <li><${Icon} name="pin" /><span>${m.location || m.address
        ? html`${m.location}${m.location && m.address ? html`<br />` : null}${m.address ? html`<a href=${mapsHref(m.address)} target="_blank" rel="noopener">${m.address}</a>` : null}`
        : 'Place to come. Your invite updates when it’s set.'}</span></li>
      ${video ? html`<li><${Icon} name="video" /><span><a href=${video} target="_blank" rel="noopener">${callName(video)}</a>${today ? '' : ' (if you can’t be there in person)'}</span></li>` : null}
    </ul>
    <div class="bp-btns">
      ${today && video ? html`<a class="bp-btn bp-btn--primary" href=${video} target="_blank" rel="noopener"><${Icon} name="video" />${callName(video)}</a>` : null}
      <a class=${`bp-btn ${today && video ? '' : 'bp-btn--primary'}`} href=${`#/meetings/${m.id}`}>See the agenda${m.files.length ? ` and ${plural(m.files.length, 'file')}` : ''}</a>
    </div>
    <${OnCalendar} m=${m} data=${data} />
    <${Rsvp} m=${m} ctx=${ctx} />
  </section>`;
}

/** Whether the meeting is already on their calendar (they got the invite), else a way to add it */
function OnCalendar({ m, data }) {
  if (m.onCalendar) return html`<p class="bp-oncal"><${Icon} name="check" size=${18} /><span>It’s on your calendar: the invite went to ${data.me.email}.</span></p>`;
  if (!isDate(m.date) || m.date < data.today) return null;
  return html`<p class="bp-oncal bp-oncal--add">
    <a class="bp-btn bp-btn--quiet" href=${`${API}?ics=${encodeURIComponent(m.id)}`} download="soard-board-meeting.ics">Add it to my calendar</a>
    <a class="bp-link" href=${googleHref(m)} target="_blank" rel="noopener">or to Google Calendar</a>
  </p>`;
}

function Rsvp({ m, ctx }) {
  const { data, setData, say } = ctx;
  const [busy, setBusy] = useState('');
  const [thanks, setThanks] = useState(false);
  if (m.date < data.today) return null;
  const team = theTeam(data);
  const chosen = RSVP.find((r) => r.id === m.myRsvp);
  const onInvite = !chosen && m.myInvite && m.myInvite !== 'invited' ? answerOf('', m.myInvite) : '';
  const answer = async (id) => {
    if (!data.me.slug) return;
    setBusy(id);
    const j = await call({ action: 'rsvp', meetingId: m.id, answer: id });
    setBusy('');
    if (!j.ok) { say(j.error); return; }
    setData((d) => ({ ...d, meetings: d.meetings.map((x) => (x.id === m.id ? { ...x, myRsvp: id } : x)) }));
    setThanks(true);
    say(`Thanks. ${team} can see your answer.`);
  };
  const qid = `rsvp-${m.id}`;
  return html`<div class="bp-rsvp" role="group" aria-labelledby=${qid}>
    <p class="bp-rsvp__q" id=${qid}>Will you be there?</p>
    <div class="bp-choices">${RSVP.map((r) => html`<button type="button" class="bp-choice" aria-pressed=${m.myRsvp === r.id} disabled=${!!busy || !data.me.slug} onClick=${() => answer(r.id)}>
      ${m.myRsvp === r.id ? html`<${Icon} name="check" size=${18} />` : null}${busy === r.id ? 'Saving…' : r.ask}</button>`)}</div>
    <p class="bp-rsvp__said">${!data.me.slug ? 'Board members answer here.'
      : chosen ? (thanks ? `Thanks. ${team} can see your answer.` : `You said “${chosen.ask}.” You can change it any time.`)
      : onInvite ? `You answered the calendar invite: ${onInvite}. Tap one to tell ${team} here too.`
      : `Tap one. ${team} see your answer.`}</p>
  </div>`;
}

function MyAction({ a, ctx }) {
  const { setData, say } = ctx;
  const [done, setDone] = useState(false);
  const tick = async (v) => {
    setDone(v);
    const j = await call({ action: 'action-done', actionId: a.id, done: v });
    if (!j.ok) { setDone(!v); say(j.error); return; }
    say(v ? `Done: ${a.text.slice(0, 60)}` : 'Marked not done');
    if (v) setTimeout(() => setData((d) => ({ ...d, actions: d.actions.filter((x) => x.id !== a.id) })), 1200);
  };
  return html`<li><label class="bp-todo">
    <input type="checkbox" checked=${done} onChange=${(e) => tick(e.target.checked)} />
    <span><span class="bp-list__title" style=${done ? 'text-decoration:line-through' : ''}>${a.text}</span><span class="bp-list__meta" style="display:block">${[a.due ? `Due ${shortDate(a.due)}` : '', `From the ${a.meetingName}`].filter(Boolean).join(' · ')}</span></span>
  </label></li>`;
}

/** SOARD's own numbers, flat: no tiles, no motion */
function Glance({ n }) {
  const stats = [
    [n.impact.kids.toLocaleString(), 'children served since 2012'],
    [n.impact.rooms.toLocaleString(), 'rooms built'],
    n.projects ? [String((n.projects.building || []).length), 'makeovers in progress'] : null,
    n.cash ? [money(n.cash.total), `in Mercury${n.cash.at ? `, ${shortDate(n.cash.at.slice(0, 10))}` : ''}`] : null,
  ].filter(Boolean);
  return html`<section class="bp-card" aria-labelledby="glance-h">
    <h2 class="bp-h2" id="glance-h">SOARD at a glance</h2>
    <dl class="bp-glance">${stats.map(([v, label]) => html`<div><dd>${v}</dd><dt>${label}</dt></div>`)}</dl>
  </section>`;
}

/** Reveals and events from today on */
function ComingUp({ data }) {
  const n = data.numbers;
  const [all, setAll] = useState(false);
  const rows = [
    ...n.reveals.map((r) => ({ key: `r-${r.slug}`, sort: r.confirmed && r.date ? r.date : (r.window?.from || r.date || '9999'), title: `${r.name}’s reveal`, href: r.kidUrl, when: r.confirmed ? `${dayOf(r.date)}${r.time ? `, ${clock(r.time)}` : ''}` : r.window?.label || 'Date to come', firm: r.confirmed })),
    ...n.events.map((e) => ({ key: `e-${e.slug}`, sort: e.date, title: e.title, href: e.url, when: [dayOf(e.date), e.time, e.location].filter(Boolean).join(' · '), firm: true })),
  ].sort((a, b) => String(a.sort).localeCompare(String(b.sort)));
  const shown = all ? rows : rows.slice(0, 6);
  return html`<section class="bp-card" aria-labelledby="coming-h" id="coming-up">
    <h2 class="bp-h2" id="coming-h">Coming up</h2>
    ${rows.length ? html`<ul class="bp-list">${shown.map((r) => html`<li key=${r.key}><div class="bp-list__main"><a class="bp-list__title" href=${r.href} target="_blank" rel="noopener">${r.title}</a><div class="bp-list__meta">${r.when}</div></div>${r.firm ? null : html`<span class="bp-chip">Date not set yet</span>`}</li>`)}</ul>
      ${rows.length > 6 ? html`<button class="bp-btn bp-btn--quiet" style="margin-top:0.75rem" onClick=${() => setAll(!all)}>${all ? 'Show fewer' : `Show all ${rows.length}`}</button>` : null}`
      : html`<p class="bp-muted">Nothing on the calendar yet.</p>`}
    ${n.reveals.length ? html`<p class="bp-muted bp-after">${data.me.email ? html`Each reveal comes to <strong>${data.me.email}</strong> as a calendar invite with the address, and moves there if the day changes.` : 'Each board member gets a calendar invite with the address for every reveal.'}</p>` : null}
  </section>`;
}

/** Where a makeover's link goes: a kid's page, or a community project's page once it's public */
const projectHref = (b) => (b.kind === 'community' ? b.url || '' : b.url || (b.slug ? `/kids/${b.slug}/` : ''));
const STAGES = ['Build', 'Mobilization', 'Approval', 'Finalization', 'Design'];
function Building({ n }) {
  const building = n.projects?.building || [];
  const stages = [...STAGES.filter((st) => building.some((b) => b.status === st)), ...new Set(building.map((b) => b.status).filter((st) => !STAGES.includes(st)))];
  const unnamed = (list) => {
    const kids = list.filter((b) => b.kind !== 'community').length;
    const community = list.length - kids;
    return [kids ? plural(kids, 'family', 'families') : '', community ? plural(community, 'community project') : ''].filter(Boolean).join(' and ');
  };
  return html`<section class="bp-card" aria-labelledby="building-h">
    <h2 class="bp-h2" id="building-h">Being built now ${building.length ? html`<span class="bp-count">${building.length}</span>` : null}</h2>
    ${building.length ? html`<dl class="bp-stages">${stages.map((st) => {
      const list = building.filter((b) => b.status === st);
      const named = list.filter((b) => b.name);
      const rest = list.filter((b) => !b.name);
      return html`<div class="bp-stage"><dt>${st}</dt><dd>
        ${named.map((b, i) => { const href = projectHref(b); return html`${i ? ', ' : ''}${href ? html`<a href=${href} target="_blank" rel="noopener">${b.name}</a>` : b.name}`; })}
        ${rest.length ? `${named.length ? ` and ${rest.length} more` : unnamed(rest)}` : ''}
      </dd></div>`;
    })}</dl>`
      : html`<p class="bp-muted">${n.projects ? 'No makeovers in progress right now.' : 'The list from JobTread isn’t available right now.'}</p>`}
  </section>`;
}

function Recent({ n }) {
  const rows = [
    ...n.pastReveals.map((r) => ({ key: `r-${r.slug}`, date: r.date, title: `${r.name}’s reveal`, href: r.kidUrl })),
    ...(n.recentEvents || []).map((e) => ({ key: `e-${e.slug}`, date: e.date, title: e.title, href: e.url })),
  ].sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 5);
  if (!rows.length) return null;
  return html`<section class="bp-card" aria-labelledby="recent-h">
    <h2 class="bp-h2" id="recent-h">Recently</h2>
    <ul class="bp-list">${rows.map((r) => html`<li key=${r.key}><div class="bp-list__main"><a class="bp-list__title" href=${r.href} target="_blank" rel="noopener">${r.title}</a><div class="bp-list__meta">${dayOf(r.date)}</div></div></li>`)}</ul>
  </section>`;
}

// ─── Meetings ───────────────────────────────────────────────────────
const MinutesChip = ({ m }) => (m.minutes === 'approved' ? html`<span class="bp-chip bp-chip--ok">Minutes approved</span>` : html`<span class="bp-chip">Draft minutes</span>`);
const DateBlock = ({ d }) => (isDate(d) ? html`<span class="bp-date" aria-hidden="true"><span>${new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', timeZone: 'UTC' })}</span><strong>${Number(d.slice(8, 10))}</strong></span>` : null);

function MeetingsPage({ ctx }) {
  const { data } = ctx;
  const upcoming = data.meetings.filter((m) => m.date >= data.today).sort((a, b) => a.date.localeCompare(b.date));
  const past = data.meetings.filter((m) => m.date < data.today);
  const years = [...new Set(past.map((m) => m.date.slice(0, 4)))];
  const row = (m) => html`<li key=${m.id} class="bp-mrow">
    <${DateBlock} d=${m.date} />
    <div class="bp-list__main"><a class="bp-list__title" href=${`#/meetings/${m.id}`}>${meetingName(m)}</a><div class="bp-list__meta">${[longDate(m.date), m.location].filter(Boolean).join(' · ')}</div></div>
    <span class="bp-chips">${m.date >= data.today ? html`<span class="bp-chip bp-chip--info">Coming up</span>` : html`<${MinutesChip} m=${m} />`}${m.files.length ? html`<span class="bp-chip">${plural(m.files.length, 'file')}</span>` : null}</span>
  </li>`;
  return html`
    <h1 class="bp-h1">Meetings</h1>
    <p class="bp-lede">Every agenda, with the notes, votes, minutes and files from the meeting.</p>
    ${upcoming.length ? html`<section class="bp-card bp-gap" aria-labelledby="up-h"><h2 class="bp-h2" id="up-h">Coming up</h2><ul class="bp-list">${upcoming.map(row)}</ul></section>` : null}
    <section class="bp-card" aria-labelledby="past-h">
      <h2 class="bp-h2" id="past-h">Past meetings</h2>
      ${past.length ? years.map((y) => html`<h3 class="bp-year">${y}</h3><ul class="bp-list">${past.filter((m) => m.date.startsWith(y)).map(row)}</ul>`) : html`<p class="bp-muted">Past meetings show here once they’re added.</p>`}
    </section>`;
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
  if (!m) return html`<a class="bp-back" href="#/meetings">← All meetings</a><div class="bp-card"><h1 class="bp-h2">That meeting isn’t on the board page</h1><p class="bp-muted">It may not be shared yet.</p></div>`;
  const upcoming = m.date >= data.today;
  // A past meeting shows only the numbers locked into its packet; one ahead shows today's until then
  const numbers = m.snapshot || (upcoming ? data.numbers : null);
  const c = attendanceCounts(m);
  const here = m.attendance.filter((p) => p.status === 'present' || p.status === 'remote');
  const away = m.attendance.filter((p) => p.status === 'absent' || p.status === 'excused');
  const files = m.files.filter((f) => f.kind !== 'signed');
  const signed = m.files.find((f) => f.kind === 'signed');
  const vf = asViewer(m.files);
  const video = upcoming ? videoOf(m) : '';
  const motionChip = (r) => html`<span class=${`bp-chip ${r === 'passed' ? 'bp-chip--ok' : ''}`}>${{ passed: 'Passed', failed: 'Did not pass', tabled: 'Tabled' }[r]}</span>`;
  return html`
    <a class="bp-back" href="#/meetings">← All meetings</a>
    <div class="bp-meeting-head">
      <div>
        <p class="bp-eyebrow">${upcoming ? 'Agenda' : m.minutes === 'approved' ? 'Minutes' : 'Draft minutes'}</p>
        <h1 class="bp-h1">${meetingName(m)}</h1>
        <p class="bp-lede">${[longDate(m.date), timeRange(m.start, m.end), m.location].filter(Boolean).join(' · ')}</p>
        ${upcoming ? null : html`<p class="bp-status">${m.minutes === 'approved'
          ? html`<span class="bp-chip bp-chip--ok">Minutes approved${m.approvedOn ? ` ${shortDate(m.approvedOn)}` : ''}</span>${signed ? html` <a ...${viewerLink(vf, m.files.indexOf(signed))}>The signed copy</a>` : null}`
          : html`<span class="bp-chip">Draft minutes</span> The board votes on them at the next meeting.`}</p>`}
      </div>
      <div class="bp-btns bp-noprint">
        ${video ? html`<a class=${`bp-btn ${m.date === data.today ? 'bp-btn--primary' : ''}`} href=${video} target="_blank" rel="noopener"><${Icon} name="video" />${callName(video)}</a>` : null}
        <button class="bp-btn bp-btn--quiet" onClick=${() => window.print()}>Print or save as PDF</button>
      </div>
    </div>
    <div class="bp-meeting">
      <div class="bp-meeting__top bp-stack">
        ${upcoming && m.id === data.next ? html`<div class="bp-card bp-noprint">
          <ul class="bp-facts" style="margin-top:0">
            ${m.address ? html`<li><${Icon} name="pin" /><span>${m.location ? html`${m.location}<br />` : null}<a href=${mapsHref(m.address)} target="_blank" rel="noopener">${m.address}</a></span></li>` : null}
          </ul>
          <${OnCalendar} m=${m} data=${data} />
          <${Rsvp} m=${m} ctx=${ctx} />
        </div>` : null}
        ${files.length ? html`<section class="bp-card" aria-labelledby="files-h"><h2 class="bp-h2" id="files-h">${upcoming ? 'The packet' : 'Files'}</h2>
          <ul class="bp-files">${files.map((f) => html`<li><a ...${viewerLink(vf, m.files.indexOf(f))}><${Icon} name="file" /><span><span class="bp-list__title">${fileTitle(f.name)}</span><span class="bp-list__meta">${[kindLabel(f.kind), sizeText(f.size)].filter(Boolean).join(' · ')}</span></span></a></li>`)}</ul>
        </section>` : null}
        ${m.attendance.length && !upcoming ? html`<section class="bp-card" aria-labelledby="who-h"><h2 class="bp-h2" id="who-h">Who was there</h2>
          <p class="bp-people-line">${here.map((p) => `${p.name}${p.status === 'remote' ? ' (by video)' : ''}`).join(', ') || 'Not recorded'}</p>
          ${away.length ? html`<p class="bp-muted">Not there: ${away.map((p) => `${p.name}${p.status === 'excused' ? ' (excused)' : ''}`).join(', ')}</p>` : null}
          <p class="bp-muted">${c.boardHere} of ${c.board} board members${data.quorum ? ` · a quorum is ${data.quorum}` : ''}</p>
        </section>` : null}
      </div>
      <div class="bp-meeting__main bp-stack">
        <div class="bp-card bp-agenda">
          ${m.sections.map((s) => html`<section class="bp-sec">
            <h2>${s.title}</h2>
            ${s.items.map((it) => {
              const lines = it.live && it.live !== 'minutes' && numbers ? liveLines(it.live, numbers, { meetingId: m.id }) : [];
              return html`<div class="bp-item">
                <h3 class="bp-item__title">${it.title}${it.presenter ? html`<span class="bp-item__who">${it.presenter}</span>` : null}${it.confidential ? html`<span class="bp-chip bp-chip--warn">Board only · please don’t share</span>` : null}</h3>
                <${Notes} text=${it.notes} />
                ${lines.length ? html`<div class="bp-live">
                  <div class="bp-live__label">${m.snapshot ? `Numbers from ${shortDate(m.snapshot.at.slice(0, 10))}` : 'Numbers as of today'}</div>
                  <ul>${lines.map((l) => html`<li>${l}</li>`)}</ul>
                </div>` : null}
              </div>`;
            })}
          </section>`)}
        </div>
        ${m.motions.length ? html`<section class="bp-card" aria-labelledby="mo-h"><h2 class="bp-h2" id="mo-h">Motions and votes</h2><ul class="bp-list">${m.motions.map((x) => html`<li><div class="bp-list__main"><div class="bp-list__title">${x.text}</div><div class="bp-list__meta">${[x.by && `Moved by ${x.by}`, x.second && `seconded by ${x.second}`].filter(Boolean).join(', ')}</div></div>${motionChip(x.result)}</li>`)}</ul></section>` : null}
      </div>
      <div class="bp-meeting__rest bp-stack">
        ${m.actions.length ? html`<section class="bp-card" aria-labelledby="ai-h"><h2 class="bp-h2" id="ai-h">Action items</h2><ul class="bp-list">${m.actions.map((a) => html`<li><div class="bp-list__main"><div class="bp-list__title" style=${a.done ? 'text-decoration:line-through;color:var(--muted)' : ''}>${a.text}</div><div class="bp-list__meta">${[a.ownerName, a.due ? `due ${shortDate(a.due)}` : ''].filter(Boolean).join(' · ')}</div></div>${a.done ? html`<span class="bp-chip bp-chip--ok">Done</span>` : null}</li>`)}</ul></section>` : null}
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
  const fv = data.filings.map((d) => ({ name: `${d.title}.pdf`, type: 'application/pdf', url: d.url }));
  const cash = data.numbers.cash;
  const history = data.cashHistory;
  const s = data.snapshot;
  const f = data.numbers.finance;
  const spent = (p) => (p.makeovers || 0) + (p.store || 0) + (p.operating || 0);
  const signed = (n) => (typeof n === 'number' ? `${n < 0 ? '−' : ''}${money(Math.abs(n))}` : '');
  const monthShort = (ym) => new Date(`${ym}-15T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  const ytdRows = [
    ['Money in', (p) => money(p.income), 'total'],
    ['Money out', (p) => money(spent(p)), 'total'],
    ['Makeovers', (p) => money(p.makeovers), 'part'],
    ['The Sunny & Ranney store', (p) => money(p.store), 'part'],
    ['Running SOARD', (p) => money(p.operating), 'part'],
    ['Net', (p) => signed(p.net), 'net'],
  ];
  return html`
    <h1 class="bp-h1">Financials</h1>
    <p class="bp-lede">The money in and out, the statements from each meeting, budgets and audits, and the tax returns.</p>
    <div class="bp-grid">
      <div class="bp-stack">
        ${f?.ytd ? html`<section class="bp-card" aria-labelledby="io-h">
          <h2 class="bp-h2" id="io-h">Money in and out</h2>
          <table class="bp-table">
            <thead><tr><th scope="col"><span class="sr-only">What</span></th><th scope="col" class="num">${f.ytd.year} so far</th>${f.lastYtd ? html`<th scope="col" class="num">${f.lastYtd.year}, same days</th>` : null}</tr></thead>
            <tbody>${ytdRows.map(([label, val, kind]) => html`<tr class=${`bp-row--${kind}`}><th scope="row">${label}</th><td class="num">${val(f.ytd)}</td>${f.lastYtd ? html`<td class="num">${val(f.lastYtd)}</td>` : null}</tr>`)}</tbody>
          </table>
          <p class="bp-muted bp-after">Through ${monthName(f.ytd.through)} ${Number(String(f.ytd.through).slice(8, 10)) || ''}, from Mercury’s record.${f.close?.label ? ` ${f.close.label}’s books are ${{ closed: 'closed', ready: 'ready to close', open: 'still open' }[f.close.state] || f.close.state}.` : ''}${f.perMakeover ? ` ${plural(f.perMakeover.count, 'makeover')} finished this year, ${money(f.perMakeover.average)} each on average.` : ''}</p>
          ${f.months?.length ? html`<details class="bp-more"><summary>Month by month</summary>
            <table class="bp-table">
              <thead><tr><th scope="col">Month</th><th scope="col" class="num">In</th><th scope="col" class="num">Out</th><th scope="col" class="num">Net</th></tr></thead>
              <tbody>${[...f.months].reverse().map((r) => html`<tr><th scope="row">${monthShort(r.month)}</th><td class="num">${money(r.income)}</td><td class="num">${money(spent(r))}</td><td class="num">${signed(r.net)}</td></tr>`)}</tbody>
            </table>
          </details>` : null}
        </section>` : null}
        ${cash || f?.cash ? html`<section class="bp-card" aria-labelledby="cash-h">
          <h2 class="bp-h2" id="cash-h">Cash</h2>
          ${cash ? html`<p class="bp-big">${money(cash.total)} <span class="bp-muted">in Mercury</span></p><p class="bp-muted">${cash.accounts.length > 1 ? `${cash.accounts.map((a) => `${a.name} ${money(a.balance)}`).join(' · ')} · ` : ''}${shortDate(cash.at.slice(0, 10))}</p>` : null}
          ${f?.cash ? html`<div class="bp-live" style="margin-top:0.9rem">
            <div class="bp-live__label">The next 13 weeks</div>
            <ul>
              <li>The lowest point: ${money(f.cash.lowest.dollars)}${f.cash.lowest.week ? `, the week of ${shortDate(f.cash.lowest.week)}` : ''}${f.cash.cautiousLowest && f.cash.cautiousLowest.dollars !== f.cash.lowest.dollars ? ` (a cautious guess: ${money(f.cash.cautiousLowest.dollars)})` : ''}</li>
              <li>In 13 weeks: ${money(f.cash.in13Weeks)}</li>
              ${f.cash.floor ? html`<li>The least we keep in the bank: ${money(f.cash.floor)}${f.cash.belowFloor ? html` <span class="bp-chip bp-chip--warn">The forecast dips under it</span>` : null}</li>` : null}
            </ul>
          </div>` : null}
          ${history.length > 1 ? html`<details class="bp-more"><summary>Month-end balances</summary><table class="bp-table"><thead><tr><th scope="col">Month</th><th scope="col" class="num">Balance</th><th scope="col" class="num">Change</th></tr></thead><tbody>
            ${history.map((r, i) => { const prev = history[i + 1]; const d = prev ? r.total - prev.total : null; return html`<tr><th scope="row">${monthOf(r.month)}</th><td class="num">${money(r.total)}</td><td class="num">${d == null ? '' : `${d >= 0 ? '+' : '−'}${money(Math.abs(d))}`}</td></tr>`; })}
          </tbody></table></details>` : null}
        </section>` : null}
        <section class="bp-card" aria-labelledby="st-h">
          <h2 class="bp-h2" id="st-h">Financial statements</h2>
          ${statements.length ? html`<ul class="bp-files">${statements.map((x, i) => html`<li><a ...${viewerLink(sv, i)}><${Icon} name="file" /><span><span class="bp-list__title">${fileTitle(x.name)}</span><span class="bp-list__meta">${meetingName(x.meeting)} · ${shortDate(x.meeting.date)}</span></span></a></li>`)}</ul>`
            : html`<p class="bp-muted">The income statement and balance sheet from each meeting show here, with the bank balance.</p>`}
        </section>
        ${budgets.length ? html`<section class="bp-card" aria-labelledby="bu-h"><h2 class="bp-h2" id="bu-h">Budgets and audits</h2><ul class="bp-files">${budgets.map((d, i) => html`<li><a ...${viewerLink(bv, i)}><${Icon} name="file" /><span><span class="bp-list__title">${d.title}</span>${d.note ? html`<span class="bp-list__meta">${d.note}</span>` : null}</span></a></li>`)}</ul></section>` : null}
      </div>
      <div class="bp-stack">
        ${s ? html`<section class="bp-card" aria-labelledby="yr-h">
          <h2 class="bp-h2" id="yr-h">${s.year} at a glance</h2>
          <table class="bp-table"><tbody>
            ${[['Total revenue', s.totalRevenue], ['Contributions', s.contributions], ['Store revenue', s.storeRevenue], ['Total expenses', s.totalExpenses], ['Program expenses', s.programExpenses], ['Net assets', s.netAssets]].filter(([, v]) => typeof v === 'number').map(([k, v]) => html`<tr><th scope="row">${k}</th><td class="num">${money(v)}</td></tr>`)}
          </tbody></table>
          ${s.programPct ? html`<p class="bp-muted bp-after">${s.programPct}% to programs, ${s.managementPct}% management, ${s.fundraisingPct}% fundraising (from the ${s.year} tax return)</p>` : null}
        </section>` : null}
        ${data.filings.length ? html`<section class="bp-card" aria-labelledby="tx-h"><h2 class="bp-h2" id="tx-h">Tax returns and filings</h2>
          <ul class="bp-files">${data.filings.map((d, i) => html`<li><a ...${viewerLink(fv, i)}><${Icon} name="file" /><span><span class="bp-list__title">${d.title}</span></span></a></li>`)}</ul>
          <p class="bp-muted bp-after">The public copies, as on the website’s Financials page.</p></section>` : null}
      </div>
    </div>`;
}

// ─── People ─────────────────────────────────────────────────────────
const initialsOf = (name) => String(name || '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
function Person({ p, email = false }) {
  return html`<li class="bp-person">
    ${p.photo ? html`<img class="bp-avatar" src=${p.photo} alt="" loading="lazy" width="56" height="56" />` : html`<span class="bp-avatar" aria-hidden="true">${initialsOf(p.name)}</span>`}
    <div style="min-width:0">
      <div class="bp-person__name">${p.name}</div>
      <div class="bp-person__meta">${[p.title, p.organization].filter(Boolean).join(' · ')}</div>
      ${p.committees?.length ? html`<div class="bp-person__meta">${p.committees.join(', ')}</div>` : null}
      ${email && p.email ? html`<div class="bp-person__meta"><a href=${`mailto:${p.email}`}>${p.email}</a></div>` : null}
    </div>
  </li>`;
}
function PeoplePage({ ctx }) {
  const { people } = ctx.data;
  const committees = [...new Set(people.board.flatMap((p) => p.committees || []))].sort();
  return html`
    <h1 class="bp-h1">People</h1>
    <p class="bp-lede">The board, the team and the Advisory Board.</p>
    <section class="bp-gap" aria-labelledby="bd-h"><h2 class="bp-h2" id="bd-h">Board of Directors</h2>
      <ul class="bp-people">${people.board.map((p) => html`<${Person} p=${p} email key=${p.slug} />`)}</ul></section>
    ${committees.length ? html`<section class="bp-card bp-gap" aria-labelledby="cm-h"><h2 class="bp-h2" id="cm-h">Committees</h2><ul class="bp-list">${committees.map((c) => html`<li><div class="bp-list__main"><div class="bp-list__title">${c}</div><div class="bp-list__meta">${people.board.filter((p) => (p.committees || []).includes(c)).map((p) => p.name).join(', ')}</div></div></li>`)}</ul></section>` : null}
    <section class="bp-gap" aria-labelledby="tm-h"><h2 class="bp-h2" id="tm-h">The team</h2>
      <ul class="bp-people">${people.staff.map((p) => html`<${Person} p=${p} key=${p.slug} />`)}</ul></section>
    ${people.advisory.length ? html`<section aria-labelledby="ad-h"><h2 class="bp-h2" id="ad-h">Advisory Board</h2><ul class="bp-people">${people.advisory.map((p) => html`<${Person} p=${p} key=${p.slug} />`)}</ul></section>` : null}`;
}

// ─── Documents ──────────────────────────────────────────────────────
function SignForm({ d, ctx }) {
  const { data, setData, say } = ctx;
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  if (d.signedByMe) return html`<p class="bp-signed"><span class="bp-chip bp-chip--ok"><${Icon} name="check" size=${16} />Signed</span> by ${d.signedByMe.name}, ${shortDate(d.signedByMe.at.slice(0, 10))}</p>`;
  if (!data.me.slug) return html`<p class="bp-muted bp-after">Each board member signs it here once a year.</p>`;
  const id = `sign-${d.id}`;
  const sign = async (e) => {
    e.preventDefault();
    if (name.trim().length < 3) { setProblem('Type your full name, the way you sign it.'); document.getElementById(id)?.focus(); return; }
    setProblem('');
    setBusy(true);
    const j = await call({ action: 'sign', docId: d.id, name: name.trim() });
    setBusy(false);
    if (!j.ok) { setProblem(j.error); return; }
    setData((x) => ({ ...x, docs: x.docs.map((y) => (y.id === d.id ? { ...y, signedByMe: { name: j.name, at: new Date().toISOString() }, signedCount: y.signedCount + 1 } : y)) }));
    say(`Signed: ${d.title}. Thank you.`);
  };
  return html`<form class="bp-sign" onSubmit=${sign} noValidate>
    <label class="bp-sign__label" for=${id}>Type your full name to sign it for ${todayEastern().slice(0, 4)}</label>
    <div class="bp-sign__row">
      <input id=${id} value=${name} autocomplete="name" aria-invalid=${problem ? 'true' : null} aria-describedby=${problem ? `${id}-p` : null} onInput=${(e) => { setName(e.target.value); if (problem) setProblem(''); }} />
      <button class="bp-btn bp-btn--primary" type="submit" disabled=${busy}>${busy ? 'Signing…' : 'I’ve read it and agree'}</button>
    </div>
    ${problem ? html`<p class="bp-sign__problem" id=${`${id}-p`}>${problem}</p>` : null}
  </form>`;
}
function DocumentsPage({ ctx }) {
  const { docs } = ctx.data;
  const year = todayEastern().slice(0, 4);
  return html`
    <h1 class="bp-h1">Documents</h1>
    <p class="bp-lede">The bylaws, policies and plans. A few ask every board member to read and sign them once a year (${year}).</p>
    ${docs.length ? DOC_KINDS.filter((k) => docs.some((d) => d.kind === k.id)).map((k) => {
      const list = docs.filter((d) => d.kind === k.id);
      const withFile = list.filter((d) => d.file);
      const vf = asViewer(withFile.map((d) => ({ ...d.file, name: d.title })));
      return html`<section class="bp-card bp-gap" aria-labelledby=${`dk-${k.id}`}><h2 class="bp-h2" id=${`dk-${k.id}`}>${k.label}</h2><ul class="bp-list">${list.map((d) => html`<li key=${d.id} class="bp-doc">
        <div class="bp-doc__head">
          <div class="bp-list__main">
            <div class="bp-list__title">${d.title}</div>
            <div class="bp-list__meta">${[d.note, d.file ? sizeText(d.file.size) : 'The file is on its way'].filter(Boolean).join(' · ')}</div>
          </div>
          ${d.file ? html`<a class="bp-btn" ...${viewerLink(vf, withFile.indexOf(d))}>${d.sign ? 'Read it' : 'Open it'}</a>` : null}
        </div>
        ${d.sign && d.file ? html`<${SignForm} d=${d} ctx=${ctx} />` : null}
      </li>`)}</ul></section>`;
    }) : html`<div class="bp-card"><p class="bp-muted">Documents show here once they’re added.</p></div>`}`;
}

render(html`<${App} />`, document.getElementById('board-app'));
