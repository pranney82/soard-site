/**
 * Board (admin)
 * =============
 * Loaded on demand by the admin's Board area (#board), which only its admins
 * see (Settings → Who can open it; the founders until saved). Meetings come
 * from Peter and Holly's calendars, their agendas, minutes and financials from
 * their email. The agenda drafts itself and the minutes, dropped in, fill in
 * the rest; here are the invite and the packet before, presenting it during,
 * and the minutes after (./board-meeting.js). Board members see what's shared on their own page
 * (/admin/board/, ./board/portal.js), signed in with the same emailed code.
 *
 *   #board                         Meetings: the next one (what to do next, its agenda), past meetings, open action items, from email
 *   #board/meeting/<id>[/<step>]   one meeting (before | during | after)
 *   #board/documents               bylaws, policies, budgets; who has signed this year
 *   #board/members                 who can sign in, their last visit, the sign-in email
 *   #board/settings                who can open this area, who invites come from, quorum, the Drive folder
 * Server: /api/board-admin. Rules: ./board-shared.js. Shared bits: ./board-ui.js.
 */

import { useState, useEffect, useRef, useMemo } from './vendor.js';
import { ask, askToLeave } from './ask.js';
import { viewerLink, sizeText } from './file-viewer.js';
import { html, call, upload, ago, firstOf, youAnd, hashFor, readHash, TABS, PAGE, viewerFiles, Switch, injectStyles, CHECK, callName, daysFrom, whenWords } from './board-ui.js';
import { MeetingEditor, agendaSource } from './board-meeting.js';
import {
  DOC_KINDS, meetingName, quarterOf, longDate, shortDate, timeRange, plural, todayEastern,
  attendanceCounts, openActions, nextMeeting, parseAgendaText, isDate, docxText, fileTitle, answerOf, repliesOf, agendaIsDraft, majority, agendaItems, isLive, heldEarly,
} from './board-shared.js';

// ═══════════════════════════════════════════════════════════════════
// The area
// ═══════════════════════════════════════════════════════════════════
export function BoardArea({ addToast = () => {}, setGlobalDirty = null }) {
  injectStyles();
  const [route, setRoute] = useState(() => readHash() || { tab: 'meetings', meetingId: null, step: null });
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const dirty = useRef(false);

  const load = async () => {
    const j = await call();
    if (j.ok) { setData(j); setError(null); } else setError(j.error || 'Couldn’t load the board');
    return j;
  };
  useEffect(() => { load(); }, []);
  useEffect(() => {
    const on = () => {
      const r = readHash();
      if (!r) return;
      if (dirty.current && r.meetingId !== route.meetingId) {
        askToLeave('this meeting').then((ok) => { if (ok) { dirty.current = false; setGlobalDirty?.(false); setRoute(r); } else history.replaceState(null, '', hashFor(route)); });
        return;
      }
      setRoute(r);
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, [route]);
  const go = (r) => { const next = { tab: 'meetings', meetingId: null, step: null, practice: false, ...r }; if (hashFor(next) !== location.hash) location.hash = hashFor(next); else setRoute(next); };
  const markDirty = (d) => { dirty.current = d; setGlobalDirty?.(d, d ? 'board meeting' : ''); };
  const putMeeting = (m) => setData((d) => ({ ...d, meetings: [m, ...d.meetings.filter((x) => x.id !== m.id)].sort((a, b) => String(b.date).localeCompare(String(a.date))) }));
  const setStep = (step) => setRoute((r) => ({ ...r, step }));
  const ctx = { data, setData, load, addToast, go, putMeeting, markDirty, setStep };

  if (error && !data) return html`<div class="card empty" role="alert"><p class="empty__title">The board didn’t load</p><p class="empty__text">${error}</p><div class="empty__actions"><button class="btn btn-ghost btn-sm" onClick=${load}>Try again</button></div></div>`;
  if (!data) return html`<div class="area-loading"><span class="spinner" /></div>`;
  const meeting = route.meetingId ? data.meetings.find((m) => m.id === route.meetingId) : null;

  return html`<div class="bd">
    ${route.meetingId || route.practice ? null : html`
      <div class="hub-tabs" role="tablist" aria-label="Board">
        ${TABS.map(([id, label]) => html`<button type="button" role="tab" aria-selected=${route.tab === id} class=${`hub-tab ${route.tab === id ? 'active' : ''}`} onClick=${() => go({ tab: id })}>${label}</button>`)}
      </div>
      <div class="page-header">
        <div>
          <h2>${{ meetings: 'Board meetings', documents: 'Board documents', members: 'Board members', settings: 'Board settings' }[route.tab]}</h2>
          <p class="page-sub">${{
            meetings: 'The next meeting and what’s left to do for it, then every past meeting with its agenda and minutes. The board sees a meeting once it’s shared.',
            documents: 'Bylaws, policies, budgets and plans, on the board page for every member. Ask for a signature where the board signs each year.',
            members: 'Board members sign in at sunshineonaranneyday.com/board with the email on People → Board, the way you do.',
            settings: 'Who can open this area, who invites come from, the quorum, and where past minutes come from. The banks and QuickBooks the board page’s money comes from are in System → Settings.',
          }[route.tab]}</p>
        </div>
        <a class="btn btn-ghost btn-sm" href=${PAGE} target="_blank" rel="noopener">Open the board page</a>
      </div>`}
    ${route.practice ? html`<${PracticeMeeting} ctx=${ctx} />`
      : route.meetingId
      ? (meeting ? html`<${MeetingEditor} key=${meeting.id} meeting=${meeting} step=${route.step} ctx=${ctx} />` : html`<div class="card empty"><p class="empty__title">That meeting isn’t here</p><div class="empty__actions"><button class="btn btn-ghost btn-sm" onClick=${() => go({})}>All meetings</button></div></div>`)
      : route.tab === 'documents' ? html`<${DocumentsTab} ctx=${ctx} />`
      : route.tab === 'members' ? html`<${MembersTab} ctx=${ctx} />`
      : route.tab === 'settings' ? html`<${SettingsTab} ctx=${ctx} />`
      : html`<${MeetingsTab} ctx=${ctx} />`}
  </div>`;
}

/**
 * #board/practice: today's practice meeting, the admins' alone, open on During. Its board members are simulated
 * (functions/api/_board.js), so the live meeting can be tried end to end before a real one. Start over makes a new one.
 */
function PracticeMeeting({ ctx }) {
  const [m, setM] = useState(null);
  const [error, setError] = useState('');
  const open = async (body) => {
    const j = await call(body);
    if (j.ok) { setError(''); setM(j.meeting); } else setError(j.error || 'The practice meeting didn’t open');
  };
  useEffect(() => { open({ action: 'practice' }); }, []);
  if (error) return html`<div class="card empty" role="alert"><p class="empty__title">The practice meeting didn’t open</p><p class="empty__text">${error}</p><div class="empty__actions"><button class="btn btn-ghost btn-sm" onClick=${() => open({ action: 'practice' })}>Try again</button></div></div>`;
  if (!m) return html`<div class="area-loading"><span class="spinner" /></div>`;
  // Never into the Board area's list of meetings: the editor keeps its own copy
  const pctx = { ...ctx, putMeeting: () => {}, startOver: () => open({ action: 'practice-reset', id: m.id }) };
  return html`<${MeetingEditor} key=${m.id} meeting=${m} step="during" ctx=${pctx} />`;
}

// ─── Where a meeting stands ─────────────────────────────────────────
/** Before a meeting, what's left (the same as the meeting's Getting ready; the agenda and the numbers take care of themselves): { id, label, next, done } */
function prepOf(m) {
  return [
    { id: 'invite', label: 'Invite', next: m.calendar?.eventId ? `add everyone and Google Meet to ${firstOf(m.calendar.organizer)}’s invite` : 'send the invite', done: !!m.invite },
    { id: 'agenda', label: 'Agenda', next: '', done: true },
    { id: 'shared', label: 'Board page', next: 'put the meeting on the board page', done: m.shared },
    { id: 'packet', label: 'Email', next: 'email the board the link to the agenda and documents', done: !!m.packetSentAt },
  ];
}
/** Where a past meeting's minutes stand, as a tag */
const minutesTag = (m) => (m.minutes === 'approved' ? html`<span class="tag tag--success">Minutes approved</span>`
  : m.files.some((f) => f.kind === 'minutes') || m.sections.some((s) => s.items.some((it) => it.notes)) ? html`<span class="tag tag--warn">Draft minutes</span>`
  : html`<span class="tag">No minutes yet</span>`);
const sharedTag = (m) => (m.shared ? html`<span class="tag tag--success">On the board page</span>` : html`<span class="tag">Not shared</span>`);
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
function DateBlock({ date, small = false }) {
  if (!isDate(date)) return html`<div class=${`bh-date ${small ? 'bh-date--sm' : ''}`}><span class="bh-date__d">?</span></div>`;
  const d = new Date(`${date}T12:00:00Z`);
  return html`<div class=${`bh-date ${small ? 'bh-date--sm' : ''}`} aria-hidden="true"><span class="bh-date__m">${MONTHS[d.getUTCMonth()]}</span><span class="bh-date__d">${d.getUTCDate()}</span>${small ? null : html`<span class="bh-date__w">${d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' })}</span>`}</div>`;
}

/** The admins' calendars or email, said to whoever reads it: "your and Holly’s", "Jane and Holly’s", "your or Holly’s" */
const whose = (admins = [], me = '', joiner = 'and') => {
  const names = [...(admins.includes(me) ? ['your'] : []), ...admins.filter((e) => e !== me).map(firstOf)];
  if (!names.length) return 'your';
  const list = names.length > 1 ? `${names.slice(0, -1).join(', ')} ${joiner} ${names.at(-1)}` : names[0];
  return names.at(-1) === 'your' ? list : `${list}’s`;
};

/** Where meetings come from: the admins' calendars and email, when they were last read */
function SourcesLine({ data }) {
  const c = data.calendar || {};
  const many = data.settings.admins.length > 1;
  if (!data.setup.calendar) return html`<p class="bd-muted bh-sources">Add meetings with New meeting. (Board can take them from the calendar once GOOGLE_CALENDAR_KEY is in Cloudflare.)</p>`;
  if (c.errors?.length) return html`<div class="notice notice--warn"><div class="notice__body"><strong>Couldn’t read every calendar.</strong> ${c.errors.join(' · ')}</div></div>`;
  return html`<p class="bd-muted bh-sources">Meetings come from ${whose(data.settings.admins, data.me)} ${many ? 'calendars' : 'calendar'} by themselves (any event named like “Board Meeting”). Past meetings’ minutes and packets come from the Board folder in Google Drive, and anything else for them from ${whose(data.settings.admins, data.me)} email. ${c.checkedAt ? `Calendars last looked at ${ago(c.checkedAt)}.` : 'Looking for the first time.'}</p>`;
}

/** The scopes Board's service account needs on Google Admin's domain-wide delegation */
const GROUP_SCOPE = 'https://www.googleapis.com/auth/admin.directory.group.member';
const SCOPES = ['https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/meetings.space.settings', 'https://www.googleapis.com/auth/meetings.space.readonly', 'https://www.googleapis.com/auth/drive.readonly', GROUP_SCOPE];
/** What still needs a Google setting: email, Drive, Meet transcripts, Meet attendance (each only once it's known) */
function googleNeeds(data) {
  const mail = data.mail || {};
  const check = data.google?.check;
  return {
    mail: !!(mail.needsScope || (mail.errors || []).some((e) => /has not been used|disabled|403/i.test(e))),
    drive: !!(data.drive?.needsScope || data.drive?.apiOff),
    transcript: check?.transcript === 'needs-setup' || data.meetings.some((m) => m.invite?.transcript === 'needs-setup'),
    attendance: check?.attendance === 'needs-setup' || data.meetings.some((m) => m.fromMeet?.status === 'needs-setup'),
  };
}

/** The one-time Google setup, until it works (and a problem no setting here fixes, in Google's words) */
function GoogleSetup({ data }) {
  const g = data.google;
  const [copied, setCopied] = useState(false);
  if (!g) return null;
  const check = g.check;
  const need = googleNeeds(data);
  if (check && (check.calendar === 'error' || check.meet === 'error') && check.error) {
    return html`<div class="notice notice--warn"><div class="notice__body"><strong>${check.calendar === 'error' ? 'Board can’t write invites on the calendar.' : 'Google Calendar won’t add Google Meet to invites.'}</strong> Google said: ${check.error} Board checks again by itself.</div></div>`;
  }
  if (!need.mail && !need.drive && !need.transcript && !need.attendance) return null;
  const what = [need.drive && 'bring in past minutes and packets from the Board folder in Google Drive', need.mail && 'read past agendas and minutes from email', need.transcript && 'turn on transcripts in Google Meet', need.attendance && 'fill in attendance from who joined the Google Meet'].filter(Boolean);
  const apis = [need.mail && ['gmail.googleapis.com', 'Gmail API'], need.drive && ['drive.googleapis.com', 'Google Drive API'], (need.transcript || need.attendance) && ['meet.googleapis.com', 'Google Meet REST API']].filter(Boolean);
  const scopes = SCOPES.join(',');
  const api = (id) => `https://console.cloud.google.com/apis/library/${id}${g.project ? `?project=${encodeURIComponent(g.project)}` : ''}`;
  const copy = async () => { try { await navigator.clipboard.writeText(scopes); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* the line is there to select */ } };
  return html`<div class="card">
    <div class="status-head"><div class="status-head__main"><span class="dot dot--warn" aria-hidden="true"></span><div>
      <h3>One Google setting, about five minutes</h3>
      <p class="status-head__text">So Board can ${what.length > 1 ? `${what.slice(0, -1).join(', ')} and ${what.at(-1)}` : what[0]}.</p>
    </div></div></div>
    <ol class="bd-steps">
      <li>In <a class="link" href="https://admin.google.com/ac/owl/domainwidedelegation" target="_blank" rel="noopener">Google Admin → Security → API controls → Domain-wide delegation</a>, find client ID <span class="bd-code">${g.clientId || 'the site’s service account'}</span>. Choose Edit, make its OAuth scopes this line (keep anything else already there, separated by commas), and choose Authorize:
        <div class="bd-inline" style="margin-top:0.4rem"><span class="bd-code">${scopes}</span><button class="btn btn-ghost btn-sm" onClick=${copy}>${copied ? 'Copied' : 'Copy'}</button></div></li>
      <li>In Google Cloud${g.project ? html` (project <span class="bd-code">${g.project}</span>)` : ''}, make sure ${apis.map(([id, name], i) => html`${i ? (i === apis.length - 1 ? ' and ' : ', ') : ''}the <a class="link" href=${api(id)} target="_blank" rel="noopener">${name}</a>`)} ${apis.length > 1 ? 'are' : 'is'} turned on (Enable).</li>
      <li>That’s it. Board checks again by itself within the hour (or the next time you open Board) and this goes away.</li>
    </ol>
  </div>`;
}

/** What came in from Peter and Holly's email, and what Board did with each */
function MailCard({ data }) {
  const m = data.mail || {};
  const t = m.totals || {};
  const recent = data.mailRecent || [];
  const [open, setOpen] = useState(false);
  if (!recent.length && !(m.errors?.length && !m.needsScope)) return null;
  const summary = m.backlog ? `Reading through the email now: ${plural(m.backlog, 'email')} to go.`
    : t.emails ? `${plural(t.emails, 'email')} read. ${t.meetings ? `${plural(t.meetings, 'meeting')} got ${t.files ? `${plural(t.files, 'file')} (agendas, minutes, financials)` : 'their agendas and minutes'} from them` : 'Nothing in them was board material yet'}${t.skipped ? `; ${plural(t.skipped, 'file')} left out as not board material` : ''}.` : '';
  return html`<div class="card" style="padding:0">
    <div class="sec-head"><h3>From your email</h3><span class="sec-head__hint">${m.checkedAt ? `Looked ${ago(m.checkedAt)}` : 'Not looked yet'}</span>
      <p class="sec-head__desc">Agendas, minutes and board financials come in from your and Holly’s email by themselves and land on their meeting. Board only reads: it never sends, deletes or marks anything.${summary ? ` ${summary}` : ''}</p></div>
    ${m.errors?.length && !m.needsScope ? html`<div class="notice notice--warn" style="margin:1rem 1.25rem"><div class="notice__body"><strong>Couldn’t read every inbox.</strong> ${m.errors.join(' · ')}</div></div>` : null}
    ${recent.length ? html`<ul class="bd-row-list">${(open ? recent : recent.slice(0, 4)).map((r) => html`<li class="bd-row">
      <div class="bd-row__main"><div class="bd-row__title">${r.subject || '(no subject)'}</div>
        <div class="bd-row__meta">${[shortDate(String(r.sentAt).slice(0, 10)), String(r.sender || '').replace(/<.*>/, '').trim(), r.result].filter(Boolean).join(' · ')}</div></div>
      ${r.meetingId ? html`<a class="btn btn-ghost btn-sm" href=${hashFor({ meetingId: r.meetingId })}>${r.meeting || 'The meeting'}</a>` : null}
    </li>`)}</ul>
    ${recent.length > 4 ? html`<div style="padding:0.5rem 1.25rem 1rem"><button class="btn btn-ghost btn-sm" onClick=${() => setOpen(!open)}>${open ? 'Show fewer' : `Show all ${recent.length}`}</button></div>` : null}` : null}
  </div>`;
}

// ─── Meetings ───────────────────────────────────────────────────────

/** The next meeting: when and where, what to do next for it, and who's coming */
function NextCard({ m, ctx }) {
  const { data, go } = ctx;
  const days = daysFrom(m.date);
  // Being held now (on its day, or moved up and started early), or held already today
  const now = isLive(m);
  const ended = !now && !!m.live?.endedAt;
  const today = days === 0 || now;
  const place = [m.location, m.address].filter(Boolean).join(', ');
  const prep = prepOf(m);
  const up = prep.find((x) => !x.done);
  const board = m.attendance.filter((x) => x.kind === 'board');
  // Who's coming, as the calendar invite says (the only answer): each board member counted once
  const replies = repliesOf(m);
  const answers = board.map((x) => answerOf('', replies[x.slug]));
  const yes = answers.filter((a) => a === 'Coming').length;
  const maybe = answers.filter((a) => a === 'Maybe').length;
  const no = answers.filter((a) => a === 'Can’t come').length;
  const quiet = board.filter((x) => replies[x.slug] === 'invited').length;
  const off = board.filter((x) => !replies[x.slug]).length;
  const invited = !!(m.invite?.eventId || (m.calendar && !m.calendar.gone));
  const here = attendanceCounts(m);
  return html`<div class="card bh-next">
    <div class="bh-next__top">
      <${DateBlock} date=${m.date} />
      <div class="bh-next__main">
        <p class="bh-eyebrow">${now ? `Meeting now · started ${ago(m.live.startedAt)}` : ended ? `Held today · ended ${ago(m.live.endedAt)}` : `Next meeting · ${whenWords(days)}`}</p>
        <h3 class="bh-next__title"><a href=${hashFor({ meetingId: m.id })}>${meetingName(m)}</a></h3>
        <p class="bh-facts">
          <span>${[longDate(m.date), timeRange(m.start, m.end)].filter(Boolean).join(' · ')}</span>
          <span>${place || 'Place not set yet'}</span>
          ${m.video ? html`<span>${callName(m.video)}</span>` : null}
        </p>
      </div>
      <button class="btn btn-primary" onClick=${() => go({ meetingId: m.id })}>${today && !ended ? 'Open for the meeting' : 'Open the meeting'}</button>
    </div>
    ${ended ? html`<p class="bh-nextline"><strong>Next:</strong> its minutes.</p>` : today ? html`<p class="bh-nextline">${now ? null : html`<strong>Today.</strong> `}Open it to present the agenda and its documents on the screen.</p>` : html`
      <ol class="bh-prep" aria-label="Getting ready">${prep.map((x) => html`<li class=${x.done ? 'is-done' : x === up ? 'is-next' : ''}><span class="bh-prep__mark" aria-hidden="true">${x.done ? CHECK : null}</span>${x.label}</li>`)}</ol>
      <p class="bh-nextline">${up ? html`<strong>Next:</strong> ${up.next}.` : html`<strong>Ready.</strong> The board was emailed the link ${ago(m.packetSentAt)}.`}</p>`}
    ${ended ? html`<p class="bh-rsvp"><strong>Who was there:</strong> ${here.boardHere} of ${plural(here.board, 'board member')}</p>`
      : html`<p class="bh-rsvp"><strong>Who’s coming:</strong> ${!invited ? 'the invite hasn’t gone out yet' : [yes && `${yes} coming`, maybe && `${maybe} maybe`, no && `${no} can’t`, quiet && `${quiet} haven’t answered`, off && `${off} not on the invite`].filter(Boolean).join(' · ') || 'nobody has answered yet'}</p>`}
  </div>`;
}

/** The next meeting's agenda, as it reads, with where it came from */
function AgendaPreview({ m, ctx }) {
  const src = agendaSource(m);
  return html`<div class="card">
    <div class="bd-card-head--row">
      <div class="bd-card-head" style="margin:0"><h3>Agenda for ${shortDate(m.date)} <span class=${`tag ${src.label === 'From email' ? 'tag--info' : 'tag--success'}`}>${src.label}</span></h3>${src.text ? html`<p>${src.text}</p>` : null}</div>
      <button class="btn btn-ghost btn-sm" onClick=${() => ctx.go({ meetingId: m.id })}>Change the agenda</button>
    </div>
    <ol class="bh-agenda">${m.sections.map((s, si) => {
      // The items as the board reads them: an empty row left out, a live list called what it shows
      const items = agendaItems(m).filter((x) => x.si === si);
      return html`<li key=${s.id}>
      <span class="bh-agenda__sec">${s.title || 'Section'}</span>
      ${items.length ? html`<span class="bh-agenda__items">${items.map((x) => `${x.title}${x.presenter ? ` (${x.presenter})` : ''}`).join(' · ')}</span>` : null}
    </li>`;
    })}</ol>
  </div>`;
}

function MeetingRow({ m, go }) {
  const c = attendanceCounts(m);
  const past = heldEarly(m) || (m.date && m.date < todayEastern());
  return html`<li class="bh-row" key=${m.id} onClick=${(e) => { if (!e.target.closest('a,button')) go({ meetingId: m.id }); }}>
    <${DateBlock} date=${m.date} small />
    <div class="bh-row__main">
      <a class="bd-row__title" href=${hashFor({ meetingId: m.id })}>${meetingName(m)}</a>
      <div class="bd-row__meta">${[longDate(m.date), m.location, c.boardHere ? `${c.boardHere} of ${c.board} board members there` : '', m.files.length ? plural(m.files.length, 'file') : ''].filter(Boolean).join(' · ')}</div>
    </div>
    <div class="bd-tags">${past ? minutesTag(m) : null}${sharedTag(m)}${m.calendar?.gone ? html`<span class="tag tag--warn">Off the calendar</span>` : null}${m.notBoard && !m.shared ? html`<span class="tag tag--warn" title="Its calendar event isn’t a board meeting (a coffee, a reminder or another organization’s board), so it came off the board page. Share it to put it back.">Not a board meeting</span>` : null}</div>
  </li>`;
}

function MeetingsTab({ ctx }) {
  const { data, go, putMeeting, addToast } = ctx;
  const [adding, setAdding] = useState(false);
  const [date, setDate] = useState('');
  const [importing, setImporting] = useState(false);
  const [busy, setBusy] = useState(false);
  const today = todayEastern();
  const next = nextMeeting(data.meetings);
  const ahead = data.meetings.filter((m) => m !== next && !heldEarly(m) && (!m.date || m.date >= today)).sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const past = data.meetings.filter((m) => m.date && (m.date < today || heldEarly(m)));
  const actions = openActions(data.meetings);
  const years = useMemo(() => {
    const by = new Map();
    for (const m of past) { const y = m.date.slice(0, 4); if (!by.has(y)) by.set(y, []); by.get(y).push(m); }
    return [...by.entries()];
  }, [data.meetings]);
  const create = async () => {
    if (!isDate(date)) { addToast('Pick the meeting’s date', 'error'); return; }
    setBusy(true);
    const j = await call({ action: 'new-meeting', date });
    setBusy(false);
    if (!j.ok) { addToast(j.error, 'error'); return; }
    putMeeting(j.meeting);
    setAdding(false); setDate('');
    go({ meetingId: j.meeting.id });
  };
  const done = async (a) => {
    const j = await call({ action: 'action-done', actionId: a.id, done: true });
    if (!j.ok) { addToast(j.error, 'error'); return; }
    ctx.load();
    addToast(`Done: ${a.text.slice(0, 60)}`, 'info', { label: 'Undo', fn: async () => { await call({ action: 'action-done', actionId: a.id, done: false }); ctx.load(); } });
  };
  // New meeting turns into its date, ready to type; Cancel (or Esc) goes back to the button
  const stopAdding = () => { setAdding(false); setDate(''); requestAnimationFrame(() => document.querySelector('.bh-new')?.focus()); };
  const adder = adding ? html`<span class="bd-inline">
      <input class="form-input" type="date" aria-label="Meeting date" value=${date} onInput=${(e) => setDate(e.target.value)}
        ref=${(el) => { if (el && !el.dataset.focused) { el.dataset.focused = '1'; el.focus(); } }}
        onKeyDown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); create(); } else if (e.key === 'Escape') { e.preventDefault(); stopAdding(); } }} />
      <button class="btn btn-primary btn-sm" disabled=${busy} onClick=${create}>${busy ? 'Adding…' : 'Add'}</button>
      <button class="btn btn-ghost btn-sm" onClick=${stopAdding}>Cancel</button>
    </span>` : html`<button class=${`btn btn-sm bh-new ${next ? 'btn-ghost' : 'btn-primary'}`} onClick=${() => setAdding(true)}>New meeting</button>`;
  return html`
    <${GoogleSetup} data=${data} />
    ${next ? html`<${NextCard} m=${next} ctx=${ctx} /><${AgendaPreview} m=${next} ctx=${ctx} />`
      : html`<div class="card empty"><p class="empty__title">No meeting coming up</p><p class="empty__text">A board meeting on ${whose(data.settings.admins, data.me, 'or')} calendar shows up here by itself. Or add it: its agenda is drafted from the last one, with open action items carried over.</p><div class="empty__actions">${adder}</div></div>`}
    ${ahead.length ? html`<div class="card" style="padding:0">
      <div class="sec-head"><h3>Also coming up <span class="count">${ahead.length}</span></h3></div>
      <ul class="bd-row-list">${ahead.map((m) => html`<${MeetingRow} m=${m} go=${go} />`)}</ul>
    </div>` : null}

    <div class="card" style="padding:0">
      <div class="sec-head bh-past-head">
        <h3>Past meetings ${past.length ? html`<span class="count">${past.length}</span>` : null}</h3>
        <div class="bd-actions">${next ? adder : null}<button class="btn btn-ghost btn-sm" onClick=${() => setImporting(!importing)} aria-expanded=${importing}>Add a past meeting from a file</button></div>
      </div>
      ${importing ? html`<div style="padding:0 1.25rem 1.25rem"><${ImportPanel} ctx=${ctx} onDone=${(m) => { setImporting(false); if (m) go({ meetingId: m.id }); }} /></div>` : null}
      ${past.length ? years.map(([y, list]) => html`<div class="bd-year">${y}</div><ul class="bd-row-list">${list.map((m) => html`<${MeetingRow} m=${m} go=${go} />`)}</ul>`)
        : html`<div class="empty empty--inline"><p class="empty__text">${data.drive?.backlog || data.mail?.backlog ? 'Board is bringing in past meetings from Google Drive now. They show up here as they come in.' : 'Past meetings come in from the Board folder in Google Drive and the calendars by themselves.'}</p></div>`}
    </div>

    ${actions.length ? html`<div class="card" style="padding:0">
      <div class="sec-head"><h3>Open action items <span class="count">${actions.length}</span></h3><span class="sec-head__hint">Carried onto each new agenda until done</span></div>
      <ul class="bd-row-list">${actions.map((a) => html`<li class="bd-row" key=${a.id}>
        <div class="bd-row__main">
          <div class="bd-row__title">${a.text}</div>
          <div class="bd-row__meta">${[a.ownerName || 'No one yet', a.due ? `due ${shortDate(a.due)}` : '', `from the ${a.meetingName}`].filter(Boolean).join(' · ')}</div>
        </div>
        <button class="btn btn-ghost btn-sm" onClick=${() => done(a)}>Mark done</button>
      </li>`)}</ul>
    </div>` : null}
    <${MailCard} data=${data} />
    <${SourcesLine} data=${data} />`;
}

// ─── Bring in an old agenda ─────────────────────────────────────────
/** A PDF's text, line by line, the way it reads on the page */
async function pdfText(file) {
  const { pdfjsLib } = await import('./vendor-pdf.js');
  const doc = await pdfjsLib.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const lines = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const content = await (await doc.getPage(p)).getTextContent();
    const rows = [];
    for (const it of content.items) {
      if (!it.str?.trim()) continue;
      const y = Math.round(it.transform[5]);
      let row = rows.find((r) => Math.abs(r.y - y) <= 2);
      if (!row) { row = { y, parts: [] }; rows.push(row); }
      row.parts.push({ x: it.transform[4], s: it.str });
    }
    rows.sort((a, b) => b.y - a.y);
    for (const r of rows) lines.push(r.parts.sort((a, b) => a.x - b.x).map((x) => x.s).join(' ').replace(/\s+/g, ' ').trim());
  }
  return lines.join('\n');
}

function ImportPanel({ ctx, onDone }) {
  const { data, addToast, putMeeting } = ctx;
  const [text, setText] = useState('');
  const [file, setFile] = useState(null);
  const [reading, setReading] = useState(false);
  const [saving, setSaving] = useState(false);
  const people = useMemo(() => [
    ...data.people.board.map((p) => ({ slug: p.slug, name: p.name, org: p.organization, kind: 'board' })),
    ...data.people.staff.map((p) => ({ slug: p.slug, name: p.name, org: 'SOARD', kind: 'staff' })),
  ], [data.people]);
  const parsed = useMemo(() => (text.trim() ? parseAgendaText(text, people) : null), [text, people]);
  const choose = async (f) => {
    if (!f) return;
    setFile(f);
    setReading(true);
    try {
      if (/\.docx$/i.test(f.name)) setText(await docxText(new Uint8Array(await f.arrayBuffer())));
      else if (/pdf$/i.test(f.type) || /\.pdf$/i.test(f.name)) setText(await pdfText(f));
      else addToast('Choose the agenda as a PDF or a Word file (.docx), or paste its text below.', 'error');
    } catch (e) { addToast(`Couldn’t read that file: ${e.message}`, 'error'); }
    setReading(false);
  };
  const save = async () => {
    setSaving(true);
    const j = await call({ action: 'import-meeting', meeting: parsed });
    if (!j.ok) { setSaving(false); addToast(j.error, 'error'); return; }
    let m = j.meeting;
    if (file) {
      const up = await upload(file, { ownerType: 'meeting', ownerId: m.id, kind: /minutes/i.test(file.name) ? 'minutes' : 'agenda' });
      if (up.ok) m = { ...m, files: [...m.files, up.file] };
      else addToast(`The meeting is in, but its file didn’t attach: ${up.error}`, 'error');
    }
    setSaving(false);
    putMeeting(m);
    addToast(`${meetingName(m)} is in. Check it over, then share it with the board.`, 'success');
    onDone(m);
  };
  const items = parsed ? parsed.sections.reduce((n, s) => n + s.items.length, 0) : 0;
  return html`<div class="bd-import">
    <p class="bd-muted" style="margin:0 0 0.75rem">For a meeting that isn’t on the calendars or in email: choose its agenda or minutes (PDF or Word), or paste the text. The date, place, who was there (the x’s), each section, its items and the notes under them come across. Check it over before it’s added.</p>
    <div class="bd-drop" onDragOver=${(e) => { e.preventDefault(); e.currentTarget.classList.add('is-over'); }} onDragLeave=${(e) => e.currentTarget.classList.remove('is-over')}
      onDrop=${(e) => { e.preventDefault(); e.currentTarget.classList.remove('is-over'); choose(e.dataTransfer.files[0]); }}>
      <label class="btn btn-ghost btn-sm">Choose the file<input type="file" accept="application/pdf,.pdf,.docx" hidden onChange=${(e) => choose(e.target.files[0])} /></label>
      <span class="bd-muted">${reading ? 'Reading it…' : file ? file.name : 'or drop it here, or paste the text below'}</span>
    </div>
    <div class="form-group" style="margin-top:0.75rem">
      <label class="form-label" for="bd-import-text">The agenda’s text</label>
      <textarea id="bd-import-text" class="form-textarea" rows="8" value=${text} onInput=${(e) => setText(e.target.value)} placeholder="MEETING  SOARD Board – Agenda   DATE 04/30/2026&#10;1. CALL TO ORDER&#10;1. Roll Call&#10;…" />
    </div>
    ${parsed ? html`<div class="bd-preview">
      <div class=${`notice ${parsed.date ? 'notice--info' : 'notice--warn'}`}><div class="notice__body">
        <strong>${parsed.date ? `${quarterOf(parsed.date)} Board Meeting, ${longDate(parsed.date)}` : 'No date found: add it in the meeting after'}</strong>
        ${parsed.start ? ` · ${timeRange(parsed.start, parsed.end)}` : ''}${parsed.location ? ` · ${parsed.location}` : ''}<br />
        ${plural(parsed.attendance.filter((a) => a.status === 'present').length, 'person', 'people')} there, ${parsed.attendance.filter((a) => a.status === 'absent').length} absent · ${plural(parsed.sections.length, 'section')}, ${plural(items, 'item')}
        ${parsed.unmatched.length ? html`<br />Couldn’t place: ${parsed.unmatched.map((u) => `“${u}”`).join(', ')}` : null}
      </div></div>
      <ol>${parsed.sections.map((s) => html`<li><strong>${s.title}</strong>
        <ol>${s.items.map((it) => html`<li>${it.title || html`<em>(no title)</em>`}${it.presenter ? html` <span class="tag">${it.presenter}</span>` : null}${it.notes ? html`<div class="bd-pre">${it.notes}</div>` : null}</li>`)}</ol>
      </li>`)}</ol>
      <div class="bd-actions">
        <button class="btn btn-primary" disabled=${saving || !parsed.sections.length} onClick=${save}>${saving ? 'Adding…' : 'Add this meeting'}</button>
        <button class="btn btn-ghost" onClick=${() => onDone(null)}>Cancel</button>
        <span class="bd-muted">It’s added as ${parsed.date && parsed.date < todayEastern() ? 'approved minutes' : 'a draft'}, not shared with the board until you say so.</span>
      </div>
    </div>` : null}
  </div>`;
}

// ─── Documents ──────────────────────────────────────────────────────
const driveLink = (id) => `https://drive.google.com/file/d/${encodeURIComponent(id)}/view`;
// How a signature came (_board.js SIGNED_BY)
const SIGNED_HOW = { typed: 'Typed their name', copy: 'Added their signed copy', staff: 'Signed copy added here', drive: 'Their signed copy in Drive' };

/**
 * Each board member's signature this year on a paper every member signs: how it came, with its copy (here or in
 * Drive); a copy someone handed in added for them, and one added by mistake taken off
 */
function Signers({ d, ctx, onDoc }) {
  const { data, addToast } = ctx;
  const [busy, setBusy] = useState('');
  const pick = useRef(null);
  const forWho = useRef('');
  const year = todayEastern().slice(0, 4);
  const add = async (file) => {
    if (pick.current) pick.current.value = '';
    const slug = forWho.current;
    if (!file || !slug) return;
    setBusy(slug);
    const fd = new FormData();
    fd.append('signFor', d.id);
    fd.append('slug', slug);
    fd.append('file', file);
    const j = await call(null, { form: fd });
    setBusy('');
    if (!j.ok) { addToast(j.error, 'error'); return; }
    onDoc(j.doc);
    addToast(`${j.signed.name}’s signed copy is in: signed for ${year}`, 'info');
  };
  const off = async (p) => {
    const s = d.signed[p.slug];
    if (!(await ask({ title: `Take off ${p.name}’s signature?`, text: `${p.name.split(/\s+/)[0]} is asked to sign ${d.title} for ${year} again${s.copy ? ', and the copy added for it is deleted' : ''}.`, yes: 'Take it off', danger: true }))) return;
    setBusy(p.slug);
    const j = await call({ action: 'unsign', docId: d.id, slug: p.slug });
    setBusy('');
    if (!j.ok) { addToast(j.error, 'error'); return; }
    onDoc(j.doc);
  };
  return html`<div class="bd-signers">
    <ul class="bd-signers__list" aria-label=${`Who has signed ${d.title} for ${year}`}>${data.members.map((p) => {
      const s = d.signed[p.slug];
      const when = s && s.how !== 'drive' && s.at ? shortDate(s.at.slice(0, 10)) : '';
      return html`<li class="bd-signer" key=${p.slug}>
        <span class=${`bd-signer__dot ${s ? 'is-on' : ''}`} aria-hidden="true"></span>
        <span class="bd-signer__name">${p.name}</span>
        <span class="bd-signer__how">${s ? [SIGNED_HOW[s.how] || SIGNED_HOW.typed, when].filter(Boolean).join(', ') : 'Not signed yet'}${s?.copy ? html` · <a ...${viewerLink(viewerFiles([{ ...s.copy, name: `${d.title}, signed by ${p.name}` }]), 0)}>See it</a>` : null}${s?.drive ? html` · <a href=${driveLink(s.drive.id)} target="_blank" rel="noopener">Open it in Drive</a>` : null}</span>
        <span class="bd-signer__act">${s
          ? html`<button class="btn btn-ghost btn-sm" disabled=${!!busy} onClick=${() => off(p)}>Take it off</button>`
          : html`<button class="btn btn-ghost btn-sm" disabled=${!!busy} onClick=${() => { forWho.current = p.slug; pick.current?.click(); }}>${busy === p.slug ? 'Adding…' : 'Add their signed copy'}</button>`}</span>
      </li>`;
    })}</ul>
    <input ref=${pick} type="file" class="sr-only" tabindex="-1" aria-hidden="true" accept=".pdf,image/*" onChange=${(e) => add(e.target.files[0])} />
  </div>`;
}

/** Signed copies in Drive Board couldn't place by their names: whose each is and which paper, said once (or left out) */
function DriveCopies({ ctx, signable, onDoc }) {
  const { data, setData, addToast } = ctx;
  const waiting = data.drive?.signed?.waiting || [];
  const [picks, setPicks] = useState({});
  const [busy, setBusy] = useState('');
  if (!waiting.length || !signable.length) return null;
  const pickOf = (w) => ({ slug: w.slug || '', docId: w.docId || (signable.length === 1 ? signable[0].id : ''), ...(picks[w.id] || {}) });
  const set = (w, patch) => setPicks((x) => ({ ...x, [w.id]: { ...pickOf(w), ...patch } }));
  const place = async (w, leave = false) => {
    const pk = pickOf(w);
    if (!leave && !pk.slug) { addToast('Choose whose signed copy it is', 'error'); return; }
    if (!leave && !pk.docId) { addToast('Choose which paper it is', 'error'); return; }
    setBusy(w.id);
    const j = await call({ action: 'place-signed', driveId: w.id, docId: leave ? '' : pk.docId, slug: leave ? '' : pk.slug });
    setBusy('');
    if (!j.ok) { addToast(j.error, 'error'); return; }
    if (j.doc) onDoc(j.doc);
    setData((x) => ({ ...x, drive: x.drive ? { ...x.drive, signed: j.drive?.signed || x.drive.signed } : x.drive }));
  };
  return html`<div class="card" style="padding:0">
    <div class="sec-head"><h3>Signed copies in Drive to place <span class="count">${waiting.length}</span></h3><span class="sec-head__hint">${(data.drive.signed.folders || []).join(', ')}</span></div>
    <ul class="bd-row-list">${waiting.map((w) => {
      const pk = pickOf(w);
      return html`<li class="bd-row" key=${w.id}>
        <div class="bd-row__main">
          <a class="bd-row__title" href=${driveLink(w.id)} target="_blank" rel="noopener">${w.name}</a>
          <div class="bd-row__meta">${[w.why, w.year ? `Put in Drive in ${w.year}` : ''].filter(Boolean).join(' · ')}</div>
        </div>
        <div class="bd-tags">
          <select class="form-select bd-select" aria-label=${`Whose signed copy is ${w.name}?`} value=${pk.slug} onChange=${(e) => set(w, { slug: e.target.value })}>
            <option value="">Whose is it?</option>${data.members.map((p) => html`<option value=${p.slug}>${p.name}</option>`)}
          </select>
          ${signable.length > 1 ? html`<select class="form-select bd-select" aria-label=${`Which paper is ${w.name}?`} value=${pk.docId} onChange=${(e) => set(w, { docId: e.target.value })}>
            <option value="">Which paper?</option>${signable.map((d) => html`<option value=${d.id}>${d.title}</option>`)}
          </select>` : null}
          <button class="btn btn-primary btn-sm" disabled=${busy === w.id} onClick=${() => place(w)}>${busy === w.id ? 'Saving…' : 'Count it'}</button>
          <button class="btn btn-ghost btn-sm" disabled=${busy === w.id} onClick=${() => place(w, true)}>It isn’t a signature</button>
        </div>
      </li>`;
    })}</ul>
  </div>`;
}

function DocumentsTab({ ctx }) {
  const { data, setData, addToast } = ctx;
  const [draft, setDraft] = useState(null); // { title, kind, sign, note, file, existing }
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState('');
  const boardCount = data.members.length;
  const year = todayEastern().slice(0, 4);
  const putDoc = (d) => setData((x) => ({ ...x, docs: [...x.docs.filter((y) => y.id !== d.id), d].sort((a, b) => a.title.localeCompare(b.title)) }));
  const hasFile = draft && (draft.file || draft.existing);
  const save = async () => {
    if (!draft.title.trim()) { addToast('Give it a title', 'error'); return; }
    setSaving(true);
    const { file, existing, ...doc } = draft;
    const j = await call({ action: 'save-doc', doc: { ...doc, sign: doc.sign && !!(file || existing) } });
    if (!j.ok) { setSaving(false); addToast(j.error, 'error'); return; }
    let d = j.doc;
    if (file) {
      const up = await upload(file, { ownerType: 'doc', ownerId: d.id });
      if (up.ok) d = { ...d, file: up.file }; else addToast(`Saved, but the file didn’t upload: ${up.error}`, 'error');
    }
    setSaving(false);
    putDoc(d);
    setDraft(null);
  };
  const remove = async (d) => {
    if (!(await ask({ title: `Delete ${d.title}?`, text: 'Its file and this year’s signatures go with it.', yes: 'Delete', danger: true }))) return;
    const j = await call({ action: 'delete-doc', id: d.id });
    if (!j.ok) { addToast(j.error, 'error'); return; }
    setData((x) => ({ ...x, docs: x.docs.filter((y) => y.id !== d.id) }));
  };
  const toggle = async (d, patch) => {
    const j = await call({ action: 'save-doc', doc: { ...d, ...patch } });
    if (!j.ok) { addToast(j.error, 'error'); return; }
    putDoc(j.doc);
  };
  const signable = data.docs.filter((d) => d.sign);
  return html`
    ${draft ? html`<div class="card">
      <div class="bd-card-head"><h3>${draft.id ? 'Edit the document' : 'Add a document'}</h3></div>
      <div class="form-grid">
        <div class="form-group"><label class="form-label" for="bd-doc-title">Title</label><input id="bd-doc-title" class="form-input" value=${draft.title} placeholder="Bylaws" onInput=${(e) => setDraft({ ...draft, title: e.target.value })} /></div>
        <div class="form-group"><label class="form-label" for="bd-doc-kind">Kind</label><select id="bd-doc-kind" class="form-select" value=${draft.kind} onChange=${(e) => setDraft({ ...draft, kind: e.target.value })}>${DOC_KINDS.map((k) => html`<option value=${k.id}>${k.label}</option>`)}</select></div>
        <div class="form-group span-2"><label class="form-label" for="bd-doc-note">A line about it <span class="form-optional">optional</span></label><input id="bd-doc-note" class="form-input" value=${draft.note} placeholder="Adopted June 2025" onInput=${(e) => setDraft({ ...draft, note: e.target.value })} /></div>
        <div class="form-group span-2">
          <label class="form-label" for="bd-doc-file">${draft.existing ? `The file: ${fileTitle(draft.existing.name)}` : 'The file'}</label>
          <input id="bd-doc-file" type="file" accept=".pdf,.jpg,.jpeg,.png,.docx,.xlsx,.pptx,.doc,.xls" onChange=${(e) => setDraft({ ...draft, file: e.target.files[0] || null })} />
          ${draft.existing ? html`<p class="form-hint">Choose another to replace it.</p>` : null}
        </div>
        <div class="form-group span-2"><label class="bd-check"><input type="checkbox" checked=${draft.sign && hasFile} disabled=${!hasFile} onChange=${(e) => setDraft({ ...draft, sign: e.target.checked })} /> Required: every board member reads and signs it each year (the board expectations, the conflict of interest policy)</label>
          ${hasFile ? null : html`<p class="form-hint">Add the file first: the board signs what they can read.</p>`}</div>
      </div>
      <div class="bd-actions" style="margin-top:1rem">
        <button class="btn btn-primary" disabled=${saving} onClick=${save}>${saving ? 'Saving…' : 'Save'}</button>
        <button class="btn btn-ghost" onClick=${() => setDraft(null)}>Cancel</button>
      </div>
    </div>` : html`<div class="bd-actions"><button class="btn btn-primary btn-sm" onClick=${() => setDraft({ title: '', kind: 'governance', note: '', sign: false, file: null, existing: null })}>Add a document</button></div>`}
    <div class="card" style="padding:0">
      <div class="sec-head"><h3>On the board page <span class="count">${data.docs.length}</span></h3><span class="sec-head__hint">Signatures are for ${year}</span></div>
      ${data.docs.length ? html`<ul class="bd-row-list">${data.docs.map((d) => {
        // Who's on the board now, signed or not (a signature from someone who has since left isn't counted)
        const signed = data.members.filter((p) => d.signed[p.slug]);
        const left = data.members.filter((p) => !d.signed[p.slug]);
        const all = boardCount && !left.length;
        return html`<li class="bd-row" key=${d.id}>
          <div class="bd-row__main">
            ${d.file ? html`<a class="bd-row__title" ...${viewerLink(viewerFiles([d.file]), 0)}>${d.title}</a>` : html`<span class="bd-row__title">${d.title}</span>`}
            <div class="bd-row__meta">${[DOC_KINDS.find((k) => k.id === d.kind)?.label, d.note, d.file ? `${fileTitle(d.file.name)} · ${sizeText(d.file.size)}` : 'No file yet'].filter(Boolean).join(' · ')}</div>
            ${d.sign ? html`<div class="bd-row__meta">${all ? `Every board member has signed it for ${year}` : !signed.length ? `No one has signed it for ${year} yet` : `Still to sign: ${left.map((p) => p.name).join(', ')}`}</div>` : null}
          </div>
          <div class="bd-tags">
            ${d.sign ? html`<span class="tag">Required</span><span class=${`tag ${all ? 'tag--success' : ''}`}>${signed.length} of ${boardCount} signed</span>
              <button class="btn btn-ghost btn-sm" aria-expanded=${open === d.id ? 'true' : 'false'} onClick=${() => setOpen(open === d.id ? '' : d.id)}>${open === d.id ? 'Hide who’s signed' : 'Who’s signed'}</button>` : null}
            <${Switch} checked=${d.shared} label="On the board page" onChange=${(v) => toggle(d, { shared: v })} />
            <button class="btn btn-ghost btn-sm" onClick=${() => setDraft({ ...d, file: null, existing: d.file })}>Edit</button>
            <button class="btn btn-ghost btn-sm btn-row-danger" onClick=${() => remove(d)}>Delete</button>
          </div>
          ${d.sign && open === d.id ? html`<${Signers} d=${d} ctx=${ctx} onDoc=${putDoc} />` : null}
        </li>`;
      })}</ul>` : html`<div class="empty empty--inline"><p class="empty__title">No documents yet</p><p class="empty__text">Start with the bylaws, the board expectations and the conflict of interest policy.</p></div>`}
    </div>
    <${DriveCopies} ctx=${ctx} signable=${signable} onDoc=${putDoc} />`;
}

// ─── Members ────────────────────────────────────────────────────────
function AccessCard({ ctx }) {
  const { data, setData, addToast } = ctx;
  const a = data.access;
  const [trying, setTrying] = useState(false);
  const retry = async () => {
    setTrying(true);
    const j = await call({ action: 'sync-access' });
    setTrying(false);
    if (j.ok) setData((d) => ({ ...d, access: j.access })); else addToast(j.error, 'error');
  };
  const ready = a.configured && a.ok && a.attached;
  const head = !a.configured ? 'Board members can’t sign in yet'
    : a.error && !a.ok ? 'The sign-in list couldn’t be updated'
    : !a.attached ? 'One step left in Cloudflare'
    : `${plural(a.emails, 'board member')} can sign in`;
  return html`<div class="card">
    <div class="status-head">
      <div class="status-head__main"><span class=${`dot ${ready ? 'dot--on' : 'dot--warn'}`} aria-hidden="true"></span><div>
        <h3>${head}</h3>
        <p class="status-head__text">${ready
          ? html`They go to <a class="link" href=${PAGE} target="_blank" rel="noopener">sunshineonaranneyday.com/board</a> and sign in with their email’s code, the way you do. Cloudflare’s list follows People → Board within 5 minutes${a.syncedAt ? ` (checked ${ago(a.syncedAt)})` : ''}. A board sign-in opens the board page and nothing else.`
          : a.error && !a.ok ? html`Cloudflare said: ${a.error}`
          : 'The site keeps Cloudflare’s list of board emails itself once it has a key to do it.'}</p>
      </div></div>
      ${a.configured && a.error && !a.ok ? html`<div class="status-head__actions"><button class="btn btn-primary btn-sm" disabled=${trying} onClick=${retry}>${trying ? 'Trying…' : 'Try again'}</button></div>` : null}
    </div>
    ${!a.configured ? html`<ol class="bd-steps">
      <li>In Cloudflare, open <strong>My Profile → API Tokens → Create Token → Custom token</strong>. Give it two permissions, both under Account: <span class="bd-code">Access: Organizations, Identity Providers, and Groups</span> Edit, and <span class="bd-code">Access: Apps and Policies</span> Edit.</li>
      <li>Open <strong>Workers & Pages → soard-site → Settings → Variables and Secrets</strong>, add a secret named <span class="bd-code">CF_ACCESS_API_TOKEN</span> with that token, then publish.</li>
      <li>Within 5 minutes the site makes the list “SOARD board (kept by the website)” and the policy “SOARD board members”. This card then names the one setting left.</li>
    </ol>` : a.ok && !a.attached ? html`<ol class="bd-steps">
      <li>In Cloudflare, open <strong>Zero Trust → Access → Applications → ${a.appName || 'the admin’s application'} → Policies</strong>.</li>
      <li>Choose <strong>Select existing policies</strong>, tick <strong>SOARD board members</strong>, and save. This card turns green within 5 minutes. (The site never changes the application itself, so a mistake can’t lock staff out.)</li>
    </ol>` : null}
    ${a.missing?.length ? html`<div class="notice notice--warn" style="margin:1rem 0 0"><div class="notice__body"><strong>No email on file for ${a.missing.map((p) => p.name).join(', ')}.</strong> Add it on People → Board (the private email reveal invites go to), and they can sign in a few minutes later.</div><div class="notice__actions"><a class="btn btn-ghost btn-sm" href="#people/board">People → Board</a></div></div>` : null}
  </div>`;
}

/** board@soardcharity.com: follows People → Board by itself (functions/api/_board-group.js); what it last did, or the one thing it needs */
function GroupCard({ ctx }) {
  const { data, setData, addToast } = ctx;
  const g = data.group;
  const [trying, setTrying] = useState(false);
  const [copied, setCopied] = useState(false);
  if (!g) return null;
  const retry = async () => {
    setTrying(true);
    const j = await call({ action: 'sync-group' });
    setTrying(false);
    if (j.ok) setData((d) => ({ ...d, group: j.group })); else addToast(j.error, 'error');
  };
  const copy = async () => { try { await navigator.clipboard.writeText(GROUP_SCOPE); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { /* the line is there to select */ } };
  const ready = g.configured && g.ok;
  const first = !g.syncedAt && !g.failedAt;
  const head = !g.configured ? `${g.group} isn’t kept by the site yet`
    : first ? `${g.group} joins the board within 5 minutes`
    : g.needs === 'scope' ? `One Google setting, so the site can keep ${g.group}`
    : !ready ? `${g.group} couldn’t be brought up to date`
    : `${g.group} reaches ${plural(g.wanted, 'person', 'people')}`;
  const last = g.changes?.[0];
  const said = (list) => (list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list.at(-1)}` : list[0]);
  const fix = {
    api: html`In Google Cloud${data.google?.project ? html` (project <span class="bd-code">${data.google.project}</span>)` : ''}, turn on the <a class="link" href=${`https://console.cloud.google.com/apis/library/admin.googleapis.com${data.google?.project ? `?project=${encodeURIComponent(data.google.project)}` : ''}`} target="_blank" rel="noopener">Admin SDK API</a> (Enable).`,
    admin: 'Google says no founder on People → Team is a Workspace admin, so nobody the site can act as may change the group. A founder needs the Super Admin role in Google Admin.',
    group: html`Google has no group called ${g.group}. Make it in <a class="link" href="https://admin.google.com/ac/groups" target="_blank" rel="noopener">Google Admin → Directory → Groups</a> with that address, and the board goes in within half an hour.`,
    outside: html`Google won’t put addresses from outside soardcharity.com in the group. In <a class="link" href="https://admin.google.com/ac/groups" target="_blank" rel="noopener">Google Admin → Directory → Groups</a>, open ${g.group}, then Access settings, and turn on <strong>Allow members outside your organization</strong>.`,
  }[g.needs];
  return html`<div class="card">
    <div class="status-head">
      <div class="status-head__main"><span class=${`dot ${ready ? 'dot--on' : first && g.configured ? '' : 'dot--warn'}`} aria-hidden="true"></span><div>
        <h3>${head}</h3>
        <p class="status-head__text">${!g.configured ? 'Once GOOGLE_CALENDAR_KEY is in Cloudflare, the group follows People → Board by itself.'
          : g.needs === 'scope' ? `Then the group holds exactly the board on People → Board, plus ${youAnd(data.settings.admins, data.me)}, and follows every change there by itself.`
          : html`Email to <span class="bd-code">${g.group}</span> goes to the board on People → Board and ${youAnd(data.settings.admins, data.me)}, the people the meeting invite goes to. Google’s list follows People → Board within 5 minutes${g.syncedAt ? ` (checked ${ago(g.syncedAt)})` : ''}. The group’s owners and managers in Google stay as they are; anyone else not on the board is taken out.`}</p>
        ${ready && last ? html`<p class="status-head__text" style="margin-top:0.35rem">Last change ${ago(last.at)}: ${[last.added.length && `added ${said(last.added)}`, last.removed.length && `took out ${said(last.removed)}`].filter(Boolean).join('; ')}.</p>` : null}
      </div></div>
      ${g.configured && !ready && !first && g.needs !== 'scope' ? html`<div class="status-head__actions"><button class="btn btn-primary btn-sm" disabled=${trying} onClick=${retry}>${trying ? 'Trying…' : 'Try again'}</button></div>` : null}
    </div>
    ${g.needs === 'scope' ? html`<ol class="bd-steps">
      <li>In <a class="link" href="https://admin.google.com/ac/owl/domainwidedelegation" target="_blank" rel="noopener">Google Admin → Security → API controls → Domain-wide delegation</a>, find client ID <span class="bd-code">${data.google?.clientId || 'the site’s service account'}</span>. Choose Edit, add this to the end of its OAuth scopes (after a comma, keeping the ones already there), and choose Authorize:
        <div class="bd-inline" style="margin-top:0.4rem"><span class="bd-code">${GROUP_SCOPE}</span><button class="btn btn-ghost btn-sm" onClick=${copy}>${copied ? 'Copied' : 'Copy'}</button></div></li>
      <li>That’s it. Within half an hour the board is in the group and this card turns green. <button class="btn btn-ghost btn-sm" disabled=${trying} onClick=${retry}>${trying ? 'Checking…' : 'Check now'}</button></li>
    </ol>` : g.configured && !ready && !first ? html`<div class="notice notice--warn" style="margin:1rem 0 0"><div class="notice__body">${fix || html`Google said: ${g.error}`}</div></div>` : null}
  </div>`;
}

function MembersTab({ ctx }) {
  const { data, addToast } = ctx;
  const [working, setWorking] = useState('');
  const next = nextMeeting(data.meetings);
  const signDocs = data.docs.filter((d) => d.sign && d.shared && d.file);
  const ready = data.access.configured && data.access.ok && data.access.attached;
  const welcome = async (body, label) => {
    setWorking(label);
    const j = await call({ action: 'send-welcome', ...body });
    setWorking('');
    // One batch: it all went or none of it did, so after a failure sending again never doubles anyone's
    if (!j.ok) addToast(j.sent ? `Emailed ${j.sent}; ${plural(j.failed, 'email')} didn’t go (${j.error})` : `Nobody got it, so sending again is safe. ${j.error}`, 'error');
    else addToast(body.test ? `Sent to ${j.to?.[0] || 'you'}` : `Emailed ${plural(j.sent, 'board member')}`, 'info');
    ctx.load();
  };
  const answer = (p) => {
    const a = next?.attendance.find((x) => x.slug === p.slug);
    return next ? answerOf(a?.rsvp, repliesOf(next)[p.slug]) : '';
  };
  return html`
    <${AccessCard} ctx=${ctx} />
    <${GroupCard} ctx=${ctx} />
    <div class="card">
      <div class="status-head">
        <div class="status-head__main"><span class=${`dot ${data.welcome?.sentAt ? 'dot--on' : ''}`} aria-hidden="true"></span><div>
          <h3>${data.welcome?.sentAt ? `Told how to sign in ${ago(data.welcome.sentAt)}` : 'Tell the board how to sign in'}</h3>
          <p class="status-head__text">${ready ? 'An email to each board member: what the board page has, a button to it, and the three steps to sign in with the emailed code.' : 'Once board members can sign in (the card above), email each of them the link and the three steps.'}</p>
        </div></div>
        <div class="status-head__actions">
          <button class="btn btn-ghost btn-sm" disabled=${!!working || !data.setup.email} onClick=${() => welcome({ test: true }, 'preview')}>${working === 'preview' ? 'Sending…' : 'Send it to me'}</button>
          <button class="btn btn-primary btn-sm" disabled=${!!working || !ready || !data.packetTo}
            onClick=${async () => { if (await ask({ title: `Email ${plural(data.packetTo, 'board member')} how to sign in?`, text: '“Your SOARD board page is ready,” with the link and the three steps.', yes: 'Email the board' })) welcome({}, 'all'); }}>${working === 'all' ? 'Sending…' : data.welcome?.sentAt ? 'Email them again' : 'Email the board how to sign in'}</button>
        </div>
      </div>
    </div>
    <div class="card" style="padding:0">
      <div class="sec-head"><h3>The board <span class="count">${data.members.length}</span></h3><span class="sec-head__hint">From People → Board</span></div>
      <table class="bd-table">
        <thead><tr><th>Member</th><th>Signs in with</th><th>Last on the board page</th>${next ? html`<th>${meetingName(next)}</th>` : null}${signDocs.length ? html`<th>Signed this year</th>` : null}</tr></thead>
        <tbody>${data.members.map((p) => {
          const signed = signDocs.filter((d) => d.signed[p.slug]).length;
          return html`<tr key=${p.slug}>
            <td><strong>${p.name}</strong>${p.title && p.title !== 'Board Member' ? html`<div class="bd-row__meta">${p.title}</div>` : null}</td>
            <td data-label="Signs in with">${p.email ? p.email : html`<span class="tag tag--warn">No email on file</span>`}</td>
            <td data-label="Last on the board page">${p.lastSeen ? ago(p.lastSeen) : html`<span class="bd-inline"><span class="bd-muted">Not yet</span>${ready && p.email ? html`<button class="btn btn-ghost btn-sm" disabled=${!!working} onClick=${() => welcome({ slugs: [p.slug] }, p.slug)}>${working === p.slug ? 'Sending…' : 'Send the sign-in email'}</button>` : null}</span>`}</td>
            ${next ? html`<td data-label=${meetingName(next)}>${answer(p) || html`<span class="bd-muted">No answer</span>`}</td>` : null}
            ${signDocs.length ? html`<td data-label="Signed this year"><span class=${`tag ${signed === signDocs.length ? 'tag--success' : ''}`}>${signed} of ${signDocs.length}</span></td>` : null}
          </tr>`;
        })}</tbody>
      </table>
    </div>`;
}

// ─── Settings ───────────────────────────────────────────────────────
function SettingsTab({ ctx }) {
  const { data, setData, addToast } = ctx;
  const pick = (x) => ({ admins: x.admins, invitesFrom: x.invitesFrom, quorum: x.quorum, defaults: x.defaults, template: x.template, driveFolder: x.driveFolder || '', asks: x.asks || 'test' });
  const [s, setS] = useState(() => pick(data.settings));
  const [newAdmin, setNewAdmin] = useState('');
  const [saving, setSaving] = useState(false);
  const dirty = JSON.stringify(s) !== JSON.stringify(pick(data.settings));
  useEffect(() => { ctx.markDirty(dirty); return () => ctx.markDirty(false); }, [dirty]);
  const setDef = (patch) => setS({ ...s, defaults: { ...s.defaults, ...patch } });
  const save = async () => {
    setSaving(true);
    const j = await call({ action: 'save-settings', settings: s });
    setSaving(false);
    if (!j.ok) { addToast(j.error, 'error'); return; }
    setData((d) => ({ ...d, settings: j.settings }));
    setS(pick(j.settings));
    addToast('Board settings saved', 'info');
  };
  const addAdmin = () => {
    const e = newAdmin.trim().toLowerCase();
    if (!/^[^\s@]+@soardcharity\.com$/.test(e)) { addToast('Only a soardcharity.com sign-in can open the Board area', 'error'); return; }
    if (!s.admins.includes(e)) setS({ ...s, admins: [...s.admins, e] });
    setNewAdmin('');
  };
  return html`
    <div class="card">
      <div class="bd-card-head"><h3>Who can open the Board area</h3><p>The agenda, notes, minutes and files here are for these people only. Other staff don’t see Board in the menu, and its pages refuse them. Meetings come from their calendars, and past agendas from their email.</p></div>
      <ul class="bm-people">${s.admins.map((e) => html`<li class="bm-person" key=${e} style="min-height:0"><span>${e}${e === data.me ? html` <span class="tag">You</span>` : null}</span>
        ${e === data.me ? null : html`<button class="btn btn-ghost btn-sm btn-row-danger" onClick=${() => setS({ ...s, admins: s.admins.filter((x) => x !== e) })}>Remove</button>`}</li>`)}</ul>
      <div class="bd-inline" style="margin-top:0.75rem">
        <input class="form-input" type="email" aria-label="Add someone" placeholder="name@soardcharity.com" value=${newAdmin} onInput=${(e) => setNewAdmin(e.target.value)} onKeyDown=${(e) => { if (e.key === 'Enter') addAdmin(); }} />
        <button class="btn btn-ghost btn-sm" disabled=${!newAdmin.trim()} onClick=${addAdmin}>Add</button>
      </div>
      ${data.settings.adminsSaved ? null : html`<p class="form-hint">Until this is saved, it’s the founders on People → Team.</p>`}
    </div>
    <div class="card">
      <div class="bd-card-head"><h3>Meetings</h3></div>
      <div class="bd-grid3">
        <div class="form-group"><label class="form-label" for="bd-from">Invites come from</label><select id="bd-from" class="form-select" value=${s.invitesFrom} onChange=${(e) => setS({ ...s, invitesFrom: e.target.value })}>${s.admins.map((e) => html`<option value=${e}>${firstOf(e)}’s calendar (${e})</option>`)}</select><p class="form-hint">Every board member, ${s.admins.map(firstOf).join(' and ')} are invited.</p></div>
        <div class="form-group"><label class="form-label" for="bd-q">Quorum (board members)</label><input id="bd-q" class="form-input" type="number" min="0" max="50" value=${s.quorum || ''} placeholder=${`A majority${data.members?.length ? `: ${majority(data.members.length)}` : ''}`} onInput=${(e) => setS({ ...s, quorum: Number(e.target.value) || 0 })} /><p class="form-hint">Empty is a majority of the board on each meeting’s list${data.members?.length ? ` (${majority(data.members.length)} of ${data.members.length} today)` : ''}. A number here only if the bylaws say otherwise.</p></div>
        <div class="form-group"><label class="form-label" for="bd-ds">Usually starts</label><input id="bd-ds" class="form-input" type="time" value=${s.defaults.start} onInput=${(e) => setDef({ start: e.target.value })} /></div>
        <div class="form-group"><label class="form-label" for="bd-de">Usually ends</label><input id="bd-de" class="form-input" type="time" value=${s.defaults.end} onInput=${(e) => setDef({ end: e.target.value })} /></div>
        <div class="form-group"><label class="form-label" for="bd-dl">Usual place</label><input id="bd-dl" class="form-input" value=${s.defaults.location} onInput=${(e) => setDef({ location: e.target.value })} /></div>
        <div class="form-group"><label class="form-label" for="bd-da">Its address</label><input id="bd-da" class="form-input" value=${s.defaults.address} onInput=${(e) => setDef({ address: e.target.value })} /></div>
      </div>
    </div>
    <${AsksCard} s=${s} setS=${setS} />
    <div class="card">
      <div class="bd-card-head"><h3>Past meetings from Google Drive</h3><p>Board reads the Board folder in Google Drive: in each year’s folder (“2025 Board”), a folder per meeting (“7.24.25 Meeting”), with its minutes and packet. They come onto that meeting by themselves, on the board page. Loose files in a year’s folder (policies, photos, sign-up sheets) stay in Drive.</p></div>
      <div class="form-group" style="max-width:44rem">
        <label class="form-label" for="bd-drive">The Board folder</label>
        <input id="bd-drive" class="form-input" value=${s.driveFolder} placeholder="The usual Board folder (Sunshine - Leadership → Board)" onInput=${(e) => setS({ ...s, driveFolder: e.target.value })} />
        <p class="form-hint">Paste a folder’s link to read another one. ${data.drive?.folder ? html`<a class="link" href=${`https://drive.google.com/drive/folders/${data.drive.folder}`} target="_blank" rel="noopener">Open the folder Board reads</a>` : null}</p>
      </div>
    </div>
    <${GoogleStatus} data=${data} />
    <div class="bd-savebar">
      <span class="bd-savebar__state">${saving ? 'Saving…' : dirty ? 'Unsaved changes' : 'Saved'}</span>
      <button class="btn btn-primary" disabled=${saving || !dirty} onClick=${save}>Save</button>
    </div>`;
}

/**
 * The emails asking presenters for their reports, and the chair's review (functions/api/_board-asks.js): sent from the
 * admin the invites don't come from, the organizer copied. Test sends each one to that admin alone, once a meeting.
 */
function AsksCard({ s, setS }) {
  const asker = s.admins.find((e) => e !== s.invitesFrom) || s.invitesFrom || s.admins[0] || '';
  const copied = s.invitesFrom && s.invitesFrom !== asker ? firstOf(s.invitesFrom) : '';
  const hint = { test: `Each email comes to ${firstOf(asker)} alone, once for each meeting, its subject saying who it would go to. The board gets nothing.`, on: 'The board gets them on the schedule above. Replies go on the agenda.', off: 'No emails. Presenters write their reports on the board page.' };
  return html`<div class="card">
    <div class="bd-card-head"><h3>Reports from presenters</h3><p>Two weeks before each meeting, each board member presenting an item is emailed from ${firstOf(asker)}’s Gmail${copied ? `, ${copied} copied,` : ''} for their report, due a week before the meeting. A reminder, then past due with the chair copied. Six days before, the chair gets the whole agenda to review.</p></div>
    <div class="form-group" style="max-width:24rem">
      <label class="form-label" for="bd-asks">Emails to presenters and the chair</label>
      <select id="bd-asks" class="form-select" value=${s.asks} onChange=${(e) => setS({ ...s, asks: e.target.value })}>
        <option value="test">Test: to ${firstOf(asker)} only</option>
        <option value="on">On: to the board</option>
        <option value="off">Off</option>
      </select>
      <p class="form-hint">${hint[s.asks] || hint.test}</p>
    </div>
  </div>`;
}

/** What Board does with Google, and whether each part works (from the hourly looks and the invite check) */
function GoogleStatus({ data }) {
  if (!data.google) return null;
  const c = data.calendar || {};
  const mail = data.mail || {};
  const check = data.google.check;
  const need = googleNeeds(data);
  const row = (ok, t, s) => html`<li class=${`bm-task is-${ok === true ? 'done' : ok === false ? 'next' : 'todo'}`}><span class="bm-task__mark" aria-hidden="true">${ok === true ? CHECK : null}</span><div><div class="bm-task__t">${t}</div><div class="bm-task__s">${s}</div></div></li>`;
  return html`<div class="card">
    <div class="bd-card-head"><h3>Google</h3><p>What Board does through SOARD’s Google account, as the last looks found it.${check?.checkedAt ? ` Invites checked ${ago(check.checkedAt)}.` : ''}</p></div>
    <ul class="bm-tasks">
      ${row(c.ok && !c.errors?.length ? true : c.errors?.length ? false : null, 'Meetings from the calendars', c.errors?.length ? c.errors.join(' · ') : c.checkedAt ? `Read ${ago(c.checkedAt)}.` : 'Not read yet.')}
      ${row(need.drive ? false : data.drive?.ok ? true : data.drive?.errors?.length ? false : null, 'Past minutes and packets from Google Drive', need.drive ? 'Needs the Drive permission (Meetings shows how).' : data.drive?.errors?.length ? data.drive.errors.join(' · ') : data.drive?.checkedAt ? `${plural(data.drive.folders || 0, 'meeting')} found, ${plural(data.drive.files || 0, 'file')} brought in${data.drive.backlog ? `, ${data.drive.backlog} still to read` : ''}. Read ${ago(data.drive.checkedAt)}.` : 'Not read yet.')}
      ${row(need.drive ? false : data.drive?.docs?.count ? true : data.drive?.docs ? false : null, 'Bylaws and SOARD’s papers from Google Drive', need.drive ? 'Needs the Drive permission (Meetings shows how).' : data.drive?.docs ? `${plural(data.drive.docs.count || 0, 'document')} on Documents${data.drive.docs.manual ? `, from “${data.drive.docs.manual}”` : ''}${data.drive.docs.missing?.length ? `. Not found in Drive: ${data.drive.docs.missing.join(', ')}` : ''}. Read ${ago(data.drive.docs.checkedAt)}.` : 'Read once the past meetings are in.')}
      ${row(need.mail ? false : mail.ok ? true : null, 'Agendas and minutes from email', need.mail ? 'Needs the Gmail permission (Meetings shows how).' : mail.checkedAt ? `Read ${ago(mail.checkedAt)}.` : 'Not read yet.')}
      ${row(!check ? null : check.calendar === 'ok' && check.meet === 'ok', 'Invites with Google Meet', !check ? 'Not checked yet.' : check.calendar === 'ok' && check.meet === 'ok' ? 'Board can put meetings on the calendar with a Meet.' : check.error)}
      ${row(!check ? null : check.transcript === 'on' ? true : check.transcript === 'needs-setup' ? false : null, 'Meet transcripts', !check ? 'Not checked yet.' : check.transcript === 'on' ? 'Turned on for every invite.' : check.transcript === 'needs-setup' ? 'Needs the meetings.space.settings permission (Meetings shows how).' : check.error || 'Not available.')}
      ${data.group?.configured ? row(data.group.ok ? true : data.group.failedAt ? false : null, `${data.group.group} follows the board`, data.group.ok ? `${plural(data.group.wanted, 'person', 'people')} in it, as on People → Board. Checked ${ago(data.group.syncedAt)}.` : data.group.needs === 'scope' ? 'Needs the admin.directory.group.member permission (Members shows how).' : data.group.failedAt ? 'Members says what Google said.' : 'Not checked yet.') : null}
      ${row(!check?.attendance ? null : check.attendance === 'ok', 'Attendance from Google Meet', !check?.attendance ? 'Not checked yet.' : check.attendance === 'ok' ? 'After a meeting, who joined is marked “Video”.' : check.attendance === 'needs-setup' ? 'Needs the meetings.space.readonly permission (Meetings shows how).' : check.attendanceError)}
    </ul>
  </div>`;
}
