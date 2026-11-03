/**
 * Board (admin)
 * =============
 * Loaded on demand by the admin's Board area (#board), which only its admins
 * see (Settings → Who can open it; the founders until saved). Meetings are
 * added here (New meeting), and only here; past ones' agendas, minutes and
 * financials come from Drive and email. The agenda drafts itself and the minutes, dropped in, fill in
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
import { html, call, upload, ago, firstOf, youAnd, hashFor, readHash, TABS, PAGE, viewerFiles, Switch, injectStyles, CHECK, callName, daysFrom, whenWords, driveLink, dayOf, signedHow } from './board-ui.js';
import { MeetingEditor, agendaSource } from './board-meeting.js';
import { ReportEditor, Report, PAPER_LETTERS } from './board-report.js';
import { mdPlain } from './board-md.js';
import { pdfLines, docxLines, wordsFromLines } from './board-words.js';
import { BoardActivity } from './board-activity.js';
import {
  isHeic, asJpeg, DOC_KINDS, meetingName, quarterOf, longDate, shortDate, timeRange, plural, todayEastern,
  attendanceCounts, openActions, nextMeeting, parseAgendaText, isDate, docxText, fileTitle, answerOf, repliesOf, agendaIsDraft, majority, agendaItems, isLive, heldEarly,
} from './board-shared.js';
import { welcomeHad, usableEmail } from './board-shared.js';

// ═══════════════════════════════════════════════════════════════════
// The area
// ═══════════════════════════════════════════════════════════════════
export function BoardArea({ addToast = () => {}, setGlobalDirty = null }) {
  injectStyles();
  const [route, setRoute] = useState(() => readHash() || { tab: 'meetings', meetingId: null, step: null });
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const dirty = useRef(false);
  const looks = useRef(0);
  const dirtyWhere = useRef('this meeting');

  // Only the newest look shows: a slow one that comes back after a newer one (a send's) is dropped
  const load = async () => {
    const n = ++looks.current;
    const j = await call();
    if (n !== looks.current) return j;
    // ...and never an older sign-in email record than a quick look already showed (welcomeAt)
    if (j.ok) { setData((d) => (d?.welcomeAt > j.welcomeAt ? { ...j, welcome: d.welcome, welcomeSending: d.welcomeSending, welcomeAt: d.welcomeAt } : j)); setError(null); } else setError({ text: j.error || 'Couldn’t load the board', refused: j.status === 403 });
    return j;
  };
  useEffect(() => { load(); }, []);
  useEffect(() => {
    const on = () => {
      const r = readHash();
      if (!r) return;
      if (dirty.current && (r.meetingId !== route.meetingId || r.tab !== route.tab)) {
        askToLeave(dirtyWhere.current).then((ok) => { if (ok) { dirty.current = false; setGlobalDirty?.(false); setRoute(r); } else history.replaceState(null, '', hashFor(route)); });
        return;
      }
      setRoute(r);
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, [route]);
  const go = (r) => { const next = { tab: 'meetings', meetingId: null, step: null, practice: false, ...r }; if (hashFor(next) !== location.hash) location.hash = hashFor(next); else setRoute(next); };
  // `where`: what's being edited, as the question to leave names it ("this meeting", "this document")
  const markDirty = (d, where = 'this meeting') => { dirty.current = d; if (d) dirtyWhere.current = where; setGlobalDirty?.(d, d ? where : ''); };
  const putMeeting = (m) => setData((d) => ({ ...d, meetings: [m, ...d.meetings.filter((x) => x.id !== m.id)].sort((a, b) => String(b.date).localeCompare(String(a.date))) }));
  const setStep = (step) => setRoute((r) => ({ ...r, step }));
  const ctx = { data, setData, load, addToast, go, putMeeting, markDirty, setStep };

  // Not one of its admins: said as that, with who to ask (nothing to try again)
  if (error && !data && error.refused) return html`<div class="card empty" role="alert"><p class="empty__title">Board is open to its admins</p><p class="empty__text">${error.text}. A founder adds people in Board → Settings.</p></div>`;
  if (error && !data) return html`<div class="card empty" role="alert"><p class="empty__title">The board didn’t load</p><p class="empty__text">${error.text}</p><div class="empty__actions"><button class="btn btn-ghost btn-sm" onClick=${load}>Try again</button></div></div>`;
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
            members: 'Who’s on the board, how they get in, when each last signed in, and who has signed this year’s papers.',
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
    { id: 'invite', label: 'Invite', next: m.inviteGone ? 'send the invite again (it was deleted in Google Calendar)' : 'send the invite', done: !!m.invite },
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

/** Where past meetings' papers come from, and the invites' answers when they couldn't be read */
function SourcesLine({ data }) {
  const c = data.calendar || {};
  if (c.errors?.length) return html`<div class="notice notice--warn"><div class="notice__body"><strong>Couldn’t read every invite’s answers.</strong> ${c.errors.join(' · ')}</div></div>`;
  return html`<p class="bd-muted bh-sources">Past meetings’ minutes and packets come from the Board folder in Google Drive, and anything else for them from ${whose(data.settings.admins, data.me)} email.</p>`;
}

/**
 * Board meetings on the admins' calendars that Board doesn't have (functions/api/_board-calendar.js): meetings are added
 * here and only here (Peter, Nov 2 2026), so each is named, with a button that adds it; its calendar event is then
 * another invite, which the meeting asks to have cancelled
 */
function NotInBoard({ ctx }) {
  const { data, go, putMeeting, addToast } = ctx;
  const [busy, setBusy] = useState('');
  const have = new Set(data.meetings.map((m) => m.date));
  const strays = (data.calendar?.strays || []).filter((x) => !have.has(x.date));
  if (!strays.length) return null;
  const add = async (x) => {
    setBusy(x.date);
    const j = await call({ action: 'new-meeting', date: x.date });
    setBusy('');
    if (!j.ok) { addToast(j.error, 'error'); return; }
    putMeeting(j.meeting);
    go({ meetingId: j.meeting.id });
  };
  const on = (e) => (e === data.me ? 'your' : `${firstOf(e)}’s`);
  return html`<div class="notice notice--warn bh-strays"><div class="notice__body">
    <strong>${strays.length === 1 ? 'A board meeting on the calendar isn’t in Board.' : `${strays.length} board meetings on the calendar aren’t in Board.`}</strong>${' '}Meetings are added here, and their invites go from here: add ${strays.length === 1 ? 'it' : 'each'}, then delete the calendar event so the board gets one invite.
    ${strays.map((x) => html`<div class="bd-inline" key=${x.date + x.title} style="margin-top:0.5rem"><span>“${x.title}”, ${longDate(x.date)}, on ${on(x.on)} calendar</span>
      <button class="btn btn-primary btn-sm" disabled=${!!busy} onClick=${() => add(x)}>${busy === x.date ? 'Adding…' : `Add ${shortDate(x.date)}`}</button></div>`)}
  </div></div>`;
}

/** The scopes Board's service account needs on Google Admin's domain-wide delegation */
const GROUP_SCOPE = 'https://www.googleapis.com/auth/admin.directory.group.member';
/** What “Email the board how to sign in” asks before it sends */
const WELCOME_ASK = 'From you: the board page’s link, what’s waiting for them there, and the three sign-in steps.';
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
  const invited = !!m.invite?.eventId;
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
      <div class="bd-card-head" style="margin:0"><h3>Agenda for ${shortDate(m.date)} <span class=${`tag ${src.empty ? '' : src.label === 'From email' ? 'tag--info' : 'tag--success'}`}>${src.label}</span></h3>${src.text ? html`<p>${src.text}</p>` : null}</div>
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
    <div class="bd-tags">${past ? minutesTag(m) : null}${sharedTag(m)}${!past && m.inviteGone && !m.invite ? html`<span class="tag tag--warn">Invite deleted</span>` : null}${m.notBoard && !m.shared ? html`<span class="tag tag--warn" title="Its calendar event isn’t a board meeting (a coffee, a reminder or another organization’s board), so it came off the board page. Share it to put it back.">Not a board meeting</span>` : null}</div>
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
    if (j.existing) addToast(`The ${meetingName(j.meeting)} is already on ${shortDate(j.meeting.date)}: here it is`, 'info');
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
    <${NotInBoard} ctx=${ctx} />
    ${next ? html`<${NextCard} m=${next} ctx=${ctx} /><${AgendaPreview} m=${next} ctx=${ctx} />`
      : html`<div class="card empty"><p class="empty__title">No meeting coming up</p><p class="empty__text">Add the next one. Its agenda is drafted from the last one, with open action items carried over, and its invite goes from here.</p><div class="empty__actions">${adder}</div></div>`}
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
    <p class="bd-muted" style="margin:0 0 0.75rem">For a past meeting that isn’t in Google Drive or email: choose its agenda or minutes (PDF or Word), or paste the text. The date, place, who was there (the x’s), each section, its items and the notes under them come across. Check it over before it’s added.</p>
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
// What a file is, in a word ("the PDF's words")
const formatWord = (f) => (/\.docx$/i.test(f?.name || '') ? 'Word file' : 'PDF');
/**
 * A copy a board member signed on paper, added as their signature this year (Documents → Who's signed, or their row on
 * Members): a PDF or a photo, checked first (an iPhone's made a JPEG); over a signature they gave themselves, asked
 * first. `setBusy`: told the member's slug while it's going, '' after. → the paper as it is now, or null (nothing changed)
 */
async function addSignedCopy({ d, p, picked, addToast, setBusy = () => {}, replace = false }) {
  let file = picked;
  if (!file || !p) return null;
  if (file.size > MAX_FILE) { addToast(`${file.name} is over 50 MB. A PDF or a photo of the signed page is plenty.`, 'error'); return null; }
  if (!['pdf', 'image'].includes(await fileKind(file))) { addToast('A signed copy is a PDF, or a photo of the signed page', 'error'); return null; }
  setBusy(p.slug);
  if (isHeic(file)) { try { file = await asJpeg(file); } catch { /* sent as it is */ } }
  const fd = new FormData();
  fd.append('signFor', d.id);
  fd.append('slug', p.slug);
  fd.append('file', file);
  if (replace) fd.append('replace', '1');
  const j = await call(null, { form: fd });
  setBusy('');
  if (j.exists) {
    const who = j.exists.name.split(/\s+/)[0];
    if (await ask({ title: `${who} has signed it already`, text: `${j.exists.name} signed it ${j.exists.how === 'typed' ? 'by typing their name on the board page' : 'with their own copy'}${j.exists.at ? `, ${dayOf(j.exists.at)}` : ''}. Put this copy in its place?`, yes: 'Use this copy', no: 'Keep theirs', careful: true })) return addSignedCopy({ d, p, picked, addToast, setBusy, replace: true });
    return (await call()).docs?.find((x) => x.id === d.id) || null;
  }
  if (!j.ok) { addToast(j.error, 'error'); return null; }
  addToast(`${j.signed.name}’s signed copy is in: signed for ${todayEastern().slice(0, 4)}`, 'info');
  return j.doc;
}

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
  const add = async (picked) => {
    if (pick.current) pick.current.value = '';
    const slug = forWho.current;
    const doc = await addSignedCopy({ d, p: data.members.find((x) => x.slug === slug), picked, addToast, setBusy });
    if (doc) onDoc(doc);
    // The focus stays on their row (its button is "Take it off" now)
    requestAnimationFrame(() => document.querySelector(`[data-signer="${slug}"] button`)?.focus());
  };
  const off = async (p) => {
    const s = d.signed[p.slug] || d.before?.[p.slug];
    const first = p.name.split(/\s+/)[0];
    if (!(await ask({ title: `Take off ${p.name}’s signature${d.signed[p.slug] ? '' : ' on the earlier version'}?`, text: d.signed[p.slug] ? `${first} then shows as still to sign the ${d.title} for ${year}${s?.copy ? ', and the copy added for it is deleted' : ''}.` : `It goes from the record${s?.copy ? ' with the copy added for it' : ''}. ${first} is still to sign the new version.`, yes: 'Take it off', danger: true }))) return;
    setBusy(p.slug);
    const j = await call({ action: 'unsign', docId: d.id, slug: p.slug });
    setBusy('');
    if (!j.ok) { addToast(j.error, 'error'); return; }
    onDoc(j.doc);
    // The focus stays on their row (its button is "Add their signed copy" now)
    requestAnimationFrame(() => document.querySelector(`[data-signer="${p.slug}"] button`)?.focus());
  };
  return html`<div class="bd-signers">
    <ul class="bd-signers__list" aria-label=${`Who has signed ${d.title} for ${year}`}>${data.members.map((p) => {
      const s = d.signed[p.slug];
      // Signed an earlier wording, before the board was asked to sign again: said, so it isn't read as never signed
      const was = !s && d.before?.[p.slug];
      return html`<li class="bd-signer" key=${p.slug} data-signer=${p.slug}>
        <span class=${`bd-signer__dot ${s ? 'is-on' : ''}`} aria-hidden="true"></span>
        <span class="bd-signer__name">${p.name}</span>
        <span class="bd-signer__how">${s ? signedHow(s) : was ? `Signed the earlier version on ${dayOf(was.at)}, not the new one yet` : d.prior?.[p.slug] ? `Not signed for ${year} yet (signed for ${d.prior[p.slug].year})` : 'Not signed yet'}${was?.copy ? html` · <a ...${viewerLink(viewerFiles([{ ...was.copy, name: `${d.title}, signed by ${p.name}` }]), 0)}>See it</a>` : null}${s?.copy ? html` · <a ...${viewerLink(viewerFiles([{ ...s.copy, name: `${d.title}, signed by ${p.name}` }]), 0)}>See it</a>` : null}${s?.drive ? html` · <a href=${driveLink(s.drive.id)} target="_blank" rel="noopener">Open it in Drive</a>` : null}</span>
        <span class="bd-signer__act">${was ? html`<button class="btn btn-ghost btn-sm" disabled=${!!busy} onClick=${() => { forWho.current = p.slug; pick.current?.click(); }}>${busy === p.slug ? 'Adding…' : 'Add their new signed copy'}</button>` : null}${s || was
          ? html`<button class="btn btn-ghost btn-sm" disabled=${!!busy} onClick=${() => off(p)}>${was ? 'Take the earlier one off' : 'Take it off'}</button>`
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

/** A paper's earlier wordings, newest first: each to read (when, who, where it came from, who signed it), and to start from again (`onUse`) */
function Wordings({ id, current, signFrom = 0, onUse, addToast }) {
  const [list, setList] = useState(null);
  const [shown, setShown] = useState(0);
  const load = async () => {
    if (list) { setList(null); return; }
    const j = await call({ action: 'doc-versions', id });
    if (!j.ok) { addToast(j.error, 'error'); return; }
    setList(j.versions.filter((v) => v.version !== current));
  };
  // The day and the time, as Atlanta has them: two saved the same day are told apart
  const when = (iso) => (iso ? `${dayOf(iso)}, ${new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' })}` : '');
  return html`<div class="bd-wordings">
    <button type="button" class="btn btn-ghost btn-sm" aria-expanded=${list ? 'true' : 'false'} onClick=${load}>${list ? 'Hide the earlier wordings' : `Earlier wordings (${current - 1})`}</button>
    ${list ? html`<ol class="bd-wordings__list">${list.map((v) => html`<li key=${v.version}>
      <div class="bd-wordings__row">
        <span><strong>Wording ${v.version}</strong>${v.version === signFrom || /The board signs again from here/.test(v.note) ? html` <span class="tag">Signing again started here</span>` : null} · ${[when(v.at), v.by ? firstOf(v.by) : '', v.note.replace(/\s*·?\s*The board signs again from here/, '').replace(/^(From |A new file: )(.+)$/, (_, a, n) => a + fileTitle(n)), v.signed ? `${plural(v.signed, 'signature')} on it this year${v.version < signFrom ? ', before the board was asked to sign again' : ''}` : ''].filter(Boolean).join(' · ')}</span>
        <span class="bd-actions">
          <button type="button" class="btn btn-ghost btn-sm" aria-expanded=${shown === v.version ? 'true' : 'false'} onClick=${() => setShown(shown === v.version ? 0 : v.version)}>${shown === v.version ? 'Hide' : 'Read it'}</button>
          ${v.body && !/^A new file:/.test(v.note) ? html`<button type="button" class="btn btn-ghost btn-sm" onClick=${() => onUse(v.body)}>Use these words</button>` : null}
        </span>
      </div>
      ${shown === v.version ? html`<div class="bd-wordings__words">${v.body ? html`<${Report} text=${v.body} level=${4} />` : html`<p class="form-hint" style="margin:0">No words were written for it here: the board read its file.</p>`}</div>` : null}
    </li>`)}</ol>` : null}
  </div>`;
}

// What a paper's file can be on the board page (the server checks too: functions/api/_board.js fileTypeOf)
const MAX_FILE = 50 * 1024 * 1024;
/** What a file really is, from its first bytes (its name can say anything): 'pdf', 'image', 'zip' (a .docx, .xlsx, .pptx), 'ole' (a .doc, .xls) or '' */
async function fileKind(f) {
  const b = new Uint8Array(await f.slice(0, 12).arrayBuffer());
  const s = String.fromCharCode(...b);
  if (s.startsWith('%PDF')) return 'pdf';
  if ((b[0] === 0xFF && b[1] === 0xD8) || s.startsWith('\x89PNG') || s.startsWith('GIF8') || (s.startsWith('RIFF') && s.slice(8, 12) === 'WEBP') || s.slice(4, 8) === 'ftyp') return 'image';
  if (b[0] === 0x50 && b[1] === 0x4B) return 'zip';
  if (b[0] === 0xD0 && b[1] === 0xCF) return 'ole';
  return '';
}
const kindOfName = (n) => (/\.pdf$/i.test(n) ? 'pdf' : /\.(jpe?g|png|gif|webp|hei[cf])$/i.test(n) ? 'image' : /\.(docx|xlsx|pptx)$/i.test(n) ? 'zip' : /\.(doc|xls)$/i.test(n) ? 'ole' : '');
const KIND_WORD = { pdf: 'PDF', image: 'picture', zip: 'Word, Excel or PowerPoint file', ole: 'older Word or Excel file (.doc, .xls)' };
/** Why a file can't go on the board page, said before anything's saved ('' when it can) */
async function fileProblem(f) {
  const want = kindOfName(f.name || '');
  if (!want) return `${f.name} can’t go on the board page: choose a PDF, a picture, or a Word, Excel or PowerPoint file`;
  if (f.size > MAX_FILE) return `${f.name} is over 50 MB`;
  if ((await fileKind(f)) !== want) return `${f.name} isn’t really a ${KIND_WORD[want]} (another kind of file renamed, perhaps). Open it and save it as a ${KIND_WORD[want]} again.`;
  return '';
}
/** Why a file's words didn't come out, in plain words */
const unread = (err) => (/invalid pdf|pdf structure|password|unexpected server response|not a pdf/i.test(err?.message || '') ? 'it isn’t a PDF its words can be read from' : String(err?.message || 'it didn’t open').replace(/\.+$/, ''));

function DocumentsTab({ ctx }) {
  const { data, setData, addToast, markDirty } = ctx;
  const [draft, setDraft] = useState(null); // { ...doc, body, file (one just chosen), existing (its file now) }
  // The draft as it opened, to tell what's changed since; its words now (to know they were typed into while a file was read)
  const opened = useRef('');
  const bodyNow = useRef('');
  bodyNow.current = draft?.body || '';
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState('');
  // Words brought in from a file: reading them, and what was read from which ({ md, from: 'existing' | 'new', name }).
  // Saved as read, they're that file's own words: the paper's own file's aren't new words to sign again
  const [reading, setReading] = useState('');
  const [read, setRead] = useState(null);
  const [wordsKey, setWordsKey] = useState(0);
  const boardCount = data.members.length;
  const year = todayEastern().slice(0, 4);
  const putDoc = (d) => setData((x) => ({ ...x, docs: [...x.docs.filter((y) => y.id !== d.id), d].sort((a, b) => a.title.localeCompare(b.title)) }));
  const snap = (d) => JSON.stringify(d ? [d.title, d.kind, d.note, !!d.sign, (d.body || '').trim(), d.file?.name || ''] : null);
  const dirty = !!draft && snap(draft) !== opened.current;
  useEffect(() => { markDirty(dirty, 'this document'); }, [dirty]);
  useEffect(() => () => markDirty(false), []);
  // Back to this tab: who's signed as it is now (members sign meanwhile)
  useEffect(() => {
    let at = Date.now();
    const back = () => { if (document.visibilityState === 'visible' && Date.now() - at > 10 * 1000) { at = Date.now(); call().then((r) => { if (r.ok) setData(r); }); } };
    document.addEventListener('visibilitychange', back);
    addEventListener('focus', back);
    return () => { document.removeEventListener('visibilitychange', back); removeEventListener('focus', back); };
  }, []);
  // Closing the tab or reloading with words changed asks first, as every editor here does
  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const hasWords = !!draft?.body?.trim();
  const hasFile = draft && (draft.file || draft.existing || hasWords);
  const readable = (f) => f && (/\.(pdf|docx)$/i.test(f.name || '') || /pdf|wordprocessingml/.test(f.type || ''));
  const asRead = read && hasWords && mdPlain(draft.body) === mdPlain(read.md) ? read : null;
  /** A file's words into the editor, read the way its pages lay them out: the paper's own file, or one just chosen */
  const bringWords = async (d, source, from) => {
    const before = bodyNow.current;
    setReading(source.name || 'the file');
    try {
      let bytes;
      if (source instanceof Blob) {
        const problem = await fileProblem(source);
        if (problem) { addToast(problem, 'error'); setReading(''); return; }
        bytes = new Uint8Array(await source.arrayBuffer());
      } else {
        const r = await fetch(`/api/board-file?id=${encodeURIComponent(source.id)}`, { cache: 'no-store' });
        if (!r.ok) throw new Error(`the file didn’t open (${r.status})`);
        bytes = new Uint8Array(await r.arrayBuffer());
      }
      const lines = /\.docx$/i.test(source.name || '') ? docxLines(await docxText(bytes, { paragraphs: true })) : await pdfLines(bytes);
      const md = wordsFromLines(lines, { title: d.title });
      if (!md) throw new Error('it has no words to read (a scan?)');
      if (mdPlain(md).length > PAPER_LETTERS) { addToast(`${fileTitle(source.name)} is longer than a paper written here can be, so it stays its file: the board reads it there.`, 'error'); setReading(''); return; }
      // Typed into while it was read: what they typed stays
      if (bodyNow.current !== before) addToast(`You typed while ${fileTitle(source.name)} was being read, so your words stay. To use its words instead, bring them in again.`, 'info');
      else {
        setDraft((x) => (x && x.id === d.id ? { ...x, body: md } : x));
        setRead({ md, from, name: source.name });
        setWordsKey((k) => k + 1);
        setTimeout(() => document.querySelector('.bd-words .rp-edit')?.focus({ preventScroll: true }), 60);
      }
    } catch (err) {
      addToast(`Couldn’t read ${fileTitle(source.name)}: ${unread(err)}. Write the words in the box instead.`, 'error');
    }
    setReading('');
  };
  /** Words already in the editor: asked first, since a file's words take their place */
  const bringFrom = async (source, from) => {
    if (hasWords && !(await ask({
      title: `Put ${fileTitle(source.name)}’s words in the editor?`,
      text: 'They take the place of the words there now. Nothing changes on the board page until you save, and saved, today’s words are kept under Earlier wordings.',
      yes: 'Bring them in', no: 'Keep these words',
    }))) return;
    bringWords(draft, source, from);
  };
  const edit = async (doc) => {
    if (dirty && !(await askToLeave('this document'))) return;
    const fresh = await call();
    if (fresh.ok) setData(fresh);
    const d = (fresh.ok && fresh.docs.find((x) => x.id === doc.id)) || doc;
    const next = { ...d, body: d.body || '', file: null, existing: d.file };
    opened.current = snap(next);
    setRead(null);
    setDraft(next);
    setWordsKey((k) => k + 1);
    focusTitle();
  };
  const focusTitle = (always = false) => requestAnimationFrame(() => {
    const t = document.getElementById('bd-doc-title');
    t?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    if (always || !matchMedia('(pointer: coarse)').matches) t?.focus({ preventScroll: true });
  });
  // The focus back where the editor was opened from: its row's Edit, or Add a document
  const refocus = (id) => requestAnimationFrame(() => (document.querySelector(id ? `[data-edit="${id}"]` : '[data-add-doc]') || document.querySelector('[data-add-doc]'))?.focus());
  const close = async () => {
    if (dirty && !(await askToLeave('this document'))) return;
    const id = draft?.id;
    setDraft(null);
    setRead(null);
    refocus(id);
  };
  const save = async ({ askAgain = null, base = null } = {}) => {
    if (!draft.title.trim()) { addToast('Give it a title', 'error'); focusTitle(true); return; }
    const { file, existing, ...doc } = draft;
    const body = (doc.body || '').trim();
    // Checked before anything's saved, so a paper never goes on the board page without the file it was added with
    if (file) { const problem = await fileProblem(file); if (problem) { addToast(problem, 'error'); return; } }
    if (doc.sign && !body && !file && !existing) { addToast('A paper every member signs needs its words or its file: write them, add the file, or untick Required', 'error'); return; }
    const words = asRead;
    const back = () => requestAnimationFrame(() => document.querySelector('[data-save-doc]')?.focus());
    setSaving(true);
    const payload = {
      action: 'save-doc', askAgain, base: doc.id ? base ?? doc.version ?? 0 : undefined,
      // (On the board page is its switch's: an editor opened before it was flipped never flips it back)
      doc: { ...doc, shared: doc.id ? undefined : doc.shared, body, ...(words?.from === 'existing' && existing ? { wordsFile: existing.id } : {}) },
      fromFile: words?.from === 'existing', wordsFrom: words ? fileTitle(words.name) : '',
    };
    let j;
    if (file) {
      const fd = new FormData();
      fd.append('saveDoc', JSON.stringify({ ...payload, wordsFromNew: words?.from === 'new' }));
      fd.append('file', file);
      j = await call(null, { form: fd });
    } else j = await call(payload);
    if (!j.ok) {
      setSaving(false);
      // A new version over signatures: the server asks, naming who signed. Keeping them is the safe answer, so it has
      // the focus; Escape goes back to editing, nothing saved
      if (j.ask) {
        const n = j.ask.names;
        const who = n.length > 2 ? `${n.slice(0, -1).join(', ')} and ${n.at(-1)}` : n.join(' and ');
        const first = n[0].split(/\s+/)[0];
        const choice = await ask({
          title: n.length === 1 ? `Ask ${first} to sign again?` : `Ask the ${n.length} who signed to sign again?`,
          text: `${who} signed the earlier version for ${year}. ${j.ask.newFile && j.ask.now === 'file' ? `With ${fileTitle(j.ask.newFile)} it’s a new version: if what they agree to changed, they sign it.`
            : j.ask.newFile ? `With the words from ${fileTitle(j.ask.newFile)} it’s a new version: if what they agree to changed, they sign it.`
            : j.ask.paused ? 'Its words changed while it wasn’t required: if what they agree to changed, they sign the new version.'
            : j.ask.now === 'file' ? 'With the words taken out, the board reads its file again: if that’s not what they signed, they sign it.'
            : j.ask.since === 'file' ? 'Its words written here are what the board reads now: if they say something the file didn’t, they sign them.'
            : 'If what they agreed to has changed, they sign the new words. A typo or a heading fixed doesn’t need it.'}`,
          yes: n.length === 1 ? `Ask ${first} to sign again` : 'Ask them to sign again', no: n.length === 1 ? `Keep ${first}’s signature` : 'Keep their signatures', dismiss: null, careful: true,
        });
        if (choice === null) { back(); return; }
        save({ askAgain: choice, base });
        return;
      }
      // Newer words saved meanwhile (someone else, or this admin in another tab): theirs or these, chosen
      if (j.conflict) {
        const c = j.conflict;
        const self = !!c.by && c.by === data.me;
        const mine = await ask({
          title: self ? 'You changed these words in another tab' : `${c.by ? firstOf(c.by) : 'Someone'} changed these words`,
          text: `${self ? 'Wording' : 'They saved wording'} ${c.version}${self ? ' was saved' : ''}${c.at ? ` ${ago(c.at)}` : ''}, while ${self ? 'this one was' : 'you had the paper'} open. Save these words over it (it’s kept under Earlier wordings), or load it to work from.`,
          yes: 'Save these', no: self ? 'Load that one' : 'Load theirs', dismiss: null,
        });
        if (mine === true) save({ askAgain, base: c.version });
        else if (mine === false) {
          setDraft((x) => (x ? { ...x, body: c.body, version: c.version } : x));
          opened.current = snap({ ...draft, body: c.body });
          setRead(null);
          setWordsKey((k) => k + 1);
          call().then((r) => { if (r.ok) setData(r); });
        } else back();
        return;
      }
      // Deleted meanwhile: what's in the editor can be saved as a new paper (or Cancel)
      if (j.deleted) {
        addToast(`${j.error}. Save to add it again as a new paper, or Cancel.`, 'error');
        setDraft((x) => (x ? { ...x, id: undefined, version: 0, signFrom: 0, existing: null } : x));
        call().then((r) => { if (r.ok) setData(r); });
        return;
      }
      addToast(j.error, 'error');
      return;
    }
    const d = j.doc;
    setSaving(false);
    putDoc(d);
    opened.current = snap(null);
    setDraft(null);
    setRead(null);
    refocus(d.id);
    addToast(askAgain === true ? `Saved. The board signs the new version for ${year}: each member sees it on Home and on the paper, and in the next documents email.` : `Saved: ${d.title}`, 'info');
  };
  const remove = async (d) => {
    if (!(await ask({ title: `Delete ${d.title}?`, text: (() => { const l = [d.file ? 'its file' : '', d.version > 1 ? 'its earlier wordings' : '', 'every signature and signed copy on it'].filter(Boolean); const t = l.length > 1 ? `${l.slice(0, -1).join(', ')} and ${l.at(-1)}` : l[0]; return `${t.charAt(0).toUpperCase()}${t.slice(1)} go with it.`; })(), yes: 'Delete', danger: true }))) return;
    const j = await call({ action: 'delete-doc', id: d.id });
    if (!j.ok) { addToast(j.error, 'error'); return; }
    setData((x) => ({ ...x, docs: x.docs.filter((y) => y.id !== d.id) }));
    refocus(null);
  };
  const toggle = async (d, patch) => {
    const j = await call({ action: 'save-doc', doc: { ...d, ...patch, body: undefined }, base: d.version || 0 });
    if (!j.ok) { addToast(j.error, 'error'); if (j.deleted) call().then((r) => { if (r.ok) setData(r); }); return; }
    putDoc(j.doc);
  };
  const signable = data.docs.filter((d) => d.sign);
  // The file to read words from: one just chosen, else the paper's own
  const source = draft && readable(draft.file) ? draft.file : draft && readable(draft.existing) ? draft.existing : null;
  const sourceFrom = draft && readable(draft.file) ? 'new' : 'existing';
  // Its file newer than its words, and not the one they were read from (next year's PDF from Drive, say)
  const newerOf = (d, f) => !!(d.body && f && d.wordsAt && f.id !== d.wordsFile && f.at > d.wordsAt);
  const fileLink = (f, label) => html`<a class="link" ...${viewerLink(viewerFiles([f]), 0)}>${label}</a>`;
  return html`
    ${draft ? html`<div class="card">
      <div class="bd-card-head"><h3>${draft.id ? 'Edit the document' : 'Add a document'}</h3></div>
      <div class="form-grid">
        <div class="form-group"><label class="form-label" for="bd-doc-title">Title</label><input id="bd-doc-title" class="form-input" value=${draft.title} placeholder="Bylaws" onInput=${(e) => setDraft({ ...draft, title: e.target.value })} /></div>
        <div class="form-group"><label class="form-label" for="bd-doc-kind">Kind</label><select id="bd-doc-kind" class="form-select" value=${draft.kind} onChange=${(e) => setDraft({ ...draft, kind: e.target.value })}>${DOC_KINDS.map((k) => html`<option value=${k.id}>${k.label}</option>`)}</select></div>
        <div class="form-group span-2"><label class="form-label" for="bd-doc-note">A line about it <span class="form-optional">optional</span></label><input id="bd-doc-note" class="form-input" value=${draft.note} placeholder="Adopted June 2025" onInput=${(e) => setDraft({ ...draft, note: e.target.value })} /></div>
        <div class="form-group span-2 bd-words">
          <div class="bd-words__head">
            <span class="form-label" id="bd-doc-words-l">The words <span class="form-optional">${hasWords ? 'the board reads these on the board page' : 'write it here, or add a file below'}</span></span>
            ${source && sourceFrom === 'existing' && hasWords && !(asRead && asRead.from === sourceFrom) && !(draft.wordsFile === source.id && !newerOf(draft, draft.existing)) ? html`<button class="btn btn-ghost btn-sm" disabled=${!!reading} onClick=${() => bringFrom(source, sourceFrom)}>${reading ? `Reading ${formatWord(source)}…` : `Bring in the words from ${fileTitle(source.name)}`}</button>` : null}
          </div>
          ${!hasWords && source ? html`<div class="bd-words__start">
            <p>${draft.sign && draft.existing && !draft.file && !data.docs.find((x) => x.id === draft.id)?.body ? 'The board reads it as its file now. ' : ''}Write its words here and the board reads them on the board page${draft.sign ? ', then signs at the end' : ''}. Start from what ${fileTitle(source.name)} says, and read it over before you save.</p>
            <button class="btn btn-primary btn-sm" disabled=${!!reading} onClick=${() => bringFrom(source, sourceFrom)}>${reading ? `Reading ${formatWord(source)}…` : `Start from the ${formatWord(source)}’s words`}</button>
          </div>` : null}
          ${reading ? html`<p class="form-hint" role="status">Reading the words in ${fileTitle(reading)}…</p>` : null}
          ${newerOf(draft, draft.existing) && !read ? html`<p class="form-hint bd-words__newer">${fileLink(draft.existing, fileTitle(draft.existing.name))} came in on ${dayOf(draft.existing.at)}, after these words were last changed${dayOf(draft.wordsAt) === dayOf(draft.existing.at) ? '' : ` (${dayOf(draft.wordsAt)})`}. If it’s a new version, bring its words in above.</p>` : null}
          <${ReportEditor} value=${draft.body || ''} resetKey=${wordsKey} label=${`The words of ${draft.title || 'the document'}`} minHeight=${hasWords ? 280 : 160} timed="read"
            placeholder="What the board reads and agrees to. Headings, points and bold are in the bar above; text pasted from Word or Google Docs keeps its shape."
            onChange=${(md) => setDraft((x) => (x ? { ...x, body: md } : x))} />
          ${draft.id && draft.version > 1 ? html`<${Wordings} id=${draft.id} current=${draft.version} signFrom=${draft.signFrom} addToast=${addToast}
            onUse=${async (body) => {
              if (dirty && (draft.body || '').trim() !== (data.docs.find((x) => x.id === draft.id)?.body || '').trim() && !(await ask({ title: 'Put those words in the editor?', text: 'They take the place of the changes there now, which aren’t saved.', yes: 'Put them in', no: 'Keep my changes' }))) return;
              setDraft((x) => (x ? { ...x, body } : x)); setRead(null); setWordsKey((k) => k + 1); addToast('Those words are in the editor. Save to make them the paper’s again.', 'info');
            }} />` : null}
          ${asRead ? html`<p class="form-hint">These are the words from ${asRead.from === 'new' ? fileTitle(asRead.name) : draft.existing ? html`${fileLink(draft.existing, fileTitle(draft.existing.name))} (open it to compare)` : fileTitle(asRead.name)}. Read them over and fix anything, then save: ${data.docs.find((x) => x.id === draft.id)?.body ? 'they take the place of the words the board reads now' : 'the board page shows these words in place of the file'}.
            ${!data.docs.find((x) => x.id === draft.id)?.body ? html` <button type="button" class="bd-linkbtn" onClick=${() => { setDraft((x) => ({ ...x, body: '' })); setRead(null); setWordsKey((k) => k + 1); requestAnimationFrame(() => document.querySelector('.bd-words__start button')?.focus()); }}>Keep the file instead</button>` : null}</p>` : null}
        </div>
        <div class="form-group span-2">
          <label class="form-label" for="bd-doc-file">${draft.file && draft.existing ? html`The file: ${fileTitle(draft.file.name)}, replacing ${fileLink(draft.existing, fileTitle(draft.existing.name))}` : draft.existing ? html`The file: ${fileLink(draft.existing, fileTitle(draft.existing.name))}` : 'The file'} <span class="form-optional">${hasWords ? 'kept, but the board reads the words' : 'optional when the words are written here'}</span></label>
          <input id="bd-doc-file" type="file" accept=".pdf,.jpg,.jpeg,.png,.docx,.xlsx,.pptx,.doc,.xls" onChange=${(e) => { const f = e.target.files[0] || null; setDraft({ ...draft, file: f, title: draft.title.trim() || !f ? draft.title : fileTitle(f.name) }); }} />
          ${draft.file && readable(draft.file) && !(asRead && asRead.from === 'new') ? html`<div class="bd-words__start" style="margin-top:0.5rem">
            <p>${hasWords ? `Saved as it is, the board keeps reading the words above, with ${fileTitle(draft.file.name)} as its file.` : `The board reads ${fileTitle(draft.file.name)} as its file, or its words written here.`}</p>
            <button class="btn btn-primary btn-sm" disabled=${!!reading} onClick=${async () => { await bringFrom(draft.file, 'new'); document.querySelector('.bd-words')?.scrollIntoView({ block: 'start', behavior: 'smooth' }); }}>${reading ? `Reading ${formatWord(draft.file)}…` : `Bring in its words`}</button>
          </div>` : draft.existing ? html`<p class="form-hint">Choose another to replace it.</p>` : null}
        </div>
        <div class="form-group span-2"><label class="bd-check"><input type="checkbox" checked=${!!draft.sign} disabled=${!hasFile && !draft.sign} onChange=${(e) => setDraft({ ...draft, sign: e.target.checked })} /> Required: every board member reads and signs it each year (the board expectations, the conflict of interest policy)</label>
          ${hasFile ? null : html`<p class="form-hint">${draft.sign ? 'Nothing to read yet: write the words or add the file, or untick Required.' : 'To make it required, write its words or add its file first: the board signs what they can read.'}</p>`}</div>
      </div>
      <div class="bd-actions" style="margin-top:1rem">
        <button class="btn btn-primary" data-save-doc disabled=${saving || !!reading} onClick=${() => save()}>${saving ? 'Saving…' : 'Save'}</button>
        <button class="btn btn-ghost" onClick=${close}>Cancel</button>
      </div>
    </div>` : html`<div class="bd-actions"><button class="btn btn-primary btn-sm" data-add-doc onClick=${() => { const next = { title: '', kind: 'governance', note: '', sign: false, file: null, existing: null }; opened.current = snap(next); setRead(null); setDraft(next); focusTitle(); }}>Add a document</button></div>`}
    <div class="card" style="padding:0">
      <div class="sec-head"><h3>Papers <span class="count">${data.docs.length}</span></h3><span class="sec-head__hint">Signatures are for ${year}</span></div>
      ${data.docs.length ? html`<ul class="bd-row-list">${data.docs.map((d) => {
        // Who's on the board now, signed or not (a signature from someone who has since left isn't counted)
        const signed = data.members.filter((p) => d.signed[p.slug]);
        const left = data.members.filter((p) => !d.signed[p.slug]);
        const earlier = left.filter((p) => d.before?.[p.slug]).length;
        const all = boardCount && !left.length;
        return html`<li class="bd-row" key=${d.id}>
          <div class="bd-row__main">
            ${d.body ? html`<a class="bd-row__title" href=${`/admin/board/#/documents/${d.id}`} target="_blank" rel="noopener">${d.title}</a>`
              : d.file ? html`<a class="bd-row__title" ...${viewerLink(viewerFiles([d.file]), 0)}>${d.title}</a>` : html`<span class="bd-row__title">${d.title}</span>`}
            <div class="bd-row__meta">${[DOC_KINDS.find((k) => k.id === d.kind)?.label, d.note,
              d.body ? `Written here${d.wordsAt ? `, last changed ${dayOf(d.wordsAt)}` : ''}` : d.file ? `${fileTitle(d.file.name)} · ${sizeText(d.file.size).replace(' ', '\u00a0')}` : 'No words or file yet'].filter(Boolean).join(' · ')}${d.body && d.file ? html` · its ${formatWord(d.file)}: ${fileLink(d.file, fileTitle(d.file.name))}` : null}</div>
            ${newerOf(d, d.file) ? html`<div class="bd-row__meta bd-row__newer">A newer ${formatWord(d.file)} came in on ${dayOf(d.file.at)}, after these words were last changed. If it’s a new version, Edit to bring its words in.</div>` : null}
            ${d.sign && !d.shared ? html`<div class="bd-row__meta">Off the board page: the board can’t read or sign it until it’s back on.</div>` : null}
            ${d.sign ? html`<div class="bd-row__meta">${all ? `Every board member has signed it for ${year}` : !signed.length ? `No one has signed ${earlier ? 'the new version' : 'it'} for ${year} yet${earlier ? ` (${plural(earlier, 'member')} signed the earlier one)` : ''}` : `Still to sign: ${left.map((p) => (d.before?.[p.slug] ? `${p.name} (signed the earlier version)` : p.name)).join(', ')}`}</div>` : null}
          </div>
          <div class="bd-tags">
            ${d.sign ? html`<span class="tag">Required</span><span class=${`tag ${all ? 'tag--success' : ''}`}>${signed.length} of ${boardCount} signed</span>
              <button class="btn btn-ghost btn-sm" aria-expanded=${open === d.id ? 'true' : 'false'} onClick=${() => { if (open !== d.id) call().then((r) => { if (r.ok) setData(r); }); setOpen(open === d.id ? '' : d.id); }}>${open === d.id ? 'Hide who’s signed' : 'Who’s signed'}</button>` : null}
            <${Switch} checked=${d.shared} label="On the board page" onChange=${(v) => toggle(d, { shared: v })} />
            <button class="btn btn-ghost btn-sm" data-edit=${d.id} onClick=${() => edit(d)}>Edit</button>
            <button class="btn btn-ghost btn-sm btn-row-danger" onClick=${() => remove(d)}>Delete</button>
          </div>
          ${d.sign && open === d.id ? html`<${Signers} d=${d} ctx=${ctx} onDoc=${putDoc} />` : null}
        </li>`;
      })}</ul>` : html`<div class="empty empty--inline"><p class="empty__title">No documents yet</p><p class="empty__text">Start with the bylaws, the board expectations and the conflict of interest policy.</p></div>`}
    </div>
    <${DriveCopies} ctx=${ctx} signable=${signable} onDoc=${putDoc} />`;
}

// ─── Members ────────────────────────────────────────────────────────
/**
 * Board access, a line each: the board page's sign-in (Cloudflare's list, functions/api/_board-access.js),
 * board@soardcharity.com (functions/api/_board-group.js) and the sign-in email. Green works, grey is on its way,
 * amber is waiting on you ("Needs you", with what to do and its button after the steps). A passing outage is grey
 * for half an hour, then amber. Every line says only what's true now; how soon it follows People → Board is said once.
 */
function AccessPanel({ ctx, ready, working, welcome }) {
  const { data, setData, addToast } = ctx;
  const a = data.access;
  const g = data.group;
  const board = data.members;
  const [trying, setTrying] = useState('');
  const [sending, setSending] = useState(false);
  const [copied, setCopied] = useState(false);
  const [, setTick] = useState(0);
  const looking = useRef(false);
  useEffect(() => { const t = setInterval(() => setTick((n) => n + 1), 60 * 1000); return () => clearInterval(t); }, []);
  const busy = !!working || sending;
  const names = (list) => (list.length > 1 ? `${list.slice(0, -1).join(', ')} and ${list.at(-1)}` : list[0]);
  // A long list (the first look at an old group, a board with no emails yet) as its first two and how many more
  const some = (list) => (list.length > 3 ? `${list.slice(0, 2).join(', ')} and ${list.length - 2} more` : names(list));
  // A failure younger than half an hour is a passing outage: the site is already asking again
  const passing = (since) => !!since && Date.now() - Date.parse(since) < 30 * 60 * 1000;
  const clock = (iso) => {
    const d = new Date(iso);
    const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}, ${time}`;
  };
  // After any action, focus stays on its button, or on its line when the button went away
  const refocus = (btn, row) => requestAnimationFrame(() => {
    const at = document.activeElement;
    if (at && at !== document.body && at !== btn && !at.closest?.('.bd-access')) return; // moved on meanwhile: left there
    (btn?.isConnected ? btn : document.getElementById(`bd-access-${row}`))?.focus();
  });

  const retry = async (e, action, key, row) => {
    if (trying) return;
    const btn = e.currentTarget;
    setTrying(key);
    const j = await call({ action });
    if (j.ok) {
      // The check's answer now (focus follows at once), then a fresh look, so an older look still on its way can't put the line back
      setData((d) => ({ ...d, [key]: j[key] }));
      refocus(btn, row);
      await ctx.load();
    }
    setTrying('');
    if (!j.ok) addToast(j.error, 'error');
    else {
      // What worked shows on the line itself; a toast only for what still doesn't, so the two never disagree
      const r = j[key];
      const still = key === 'access'
        ? (!r.ok ? (badKey(r.error) ? 'Cloudflare still refuses the key' : `Cloudflare still has a problem: ${cfWhy(r.error)}`) : !r.attached ? 'The “SOARD board members” policy still isn’t on the admin’s application' : '')
        : (r.ok ? '' : {
          scope: 'Google still doesn’t allow it. Check the scope was saved with Authorize.',
          api: 'The Admin SDK API is still off in Google Cloud',
          admin: 'Google still says no founder is a Workspace admin',
          founder: 'People → Team still has no founder marked',
          group: `Google still has no ${r.group} group`,
          outside: 'Google still won’t take addresses from outside soardcharity.com',
        }[r.needs] || `Google still has a problem: ${gWhy(r.error)}`);
      if (still) addToast(still, 'error');
    }
    refocus(btn, row);
  };
  // A held Enter or Space acts once, not once per repeat
  const once = (e) => { if (e.repeat && (e.key === 'Enter' || e.key === ' ')) e.preventDefault(); };
  const again = (action, key, row, label = 'Try again') => html`<button class="btn btn-ghost btn-sm" aria-disabled=${trying ? 'true' : null} onKeyDown=${once} onClick=${(e) => retry(e, action, key, row)}>${trying === key ? 'Checking…' : label}</button>`;
  // welcome() holds every send button until the page has the result; this covers the moment before it starts
  const send = async (btn, body, label) => {
    if (busy) return;
    setSending(true);
    if (!body.test) {
      setData((d) => ({ ...d, welcomeSending: true }));
      requestAnimationFrame(() => document.getElementById('bd-access-email')?.focus());
    }
    try {
      const looked = await welcome(body, label);
      // Never reached the server and no look since (signed out, offline): not going out after all
      if (!body.test && !looked?.ok) setData((d) => ({ ...d, welcomeSending: false }));
    } finally { setSending(false); }
    refocus(btn, 'email');
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(GROUP_SCOPE); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { addToast('Couldn’t copy it here: select the line and copy it instead', 'error'); }
  };
  const tokenSteps = (replace) => html`<ol class="bd-steps">
      <li>In Cloudflare, open <strong>My Profile → API Tokens → Create Token → Custom token</strong>. Give it two permissions, both under Account: <span class="bd-code">Access: Organizations, Identity Providers, and Groups</span> Edit, and <span class="bd-code">Access: Apps and Policies</span> Edit.</li>
      <li>Open <strong>Workers & Pages → soard-site → Settings → Variables and Secrets</strong>, ${replace ? html`replace the secret <span class="bd-code">CF_ACCESS_API_TOKEN</span> with the new token` : html`add a secret named <span class="bd-code">CF_ACCESS_API_TOKEN</span> with that token`}, then publish.</li>
      <li>Within 5 minutes this line says what’s left${replace ? ', or choose Check now' : ''}.</li>
    </ol>`;
  const peopleLink = (text) => html`<a class="link" href="#people/board">${text}</a>`;

  // The board page's sign-in
  const missing = (a.missing || []).map((p) => p.name);
  // An address no code can reach (kim@gmail.c), from before People → Board checked them the mailer's way
  const broken = board.filter((p) => p.email && !usableEmail(p.email));
  const brokenText = broken.length ? html` ${peopleLink(`The email for ${some(broken.map((p) => p.name))} on People → Board ${broken.length === 1 ? 'isn’t a whole address' : 'aren’t whole addresses'}`)}.` : '';
  const signIn = !board.length ? { meta: html`Nobody is on ${peopleLink('People → Board')} yet.` }
    : !a.configured && a.groupId ? { warn: true, meta: 'The site’s Cloudflare key is gone, so changes on People → Board can’t reach the sign-in list. Everyone already on it can still sign in.', fix: tokenSteps(false) }
    : !a.configured ? { warn: true, meta: 'Nobody can sign in yet: the site needs a Cloudflare key to keep the list of board emails.', fix: tokenSteps(false) }
    : !a.syncedAt && !a.failedAt ? { meta: 'Making the sign-in list now.' }
    : a.error && !a.ok ? (badKey(a.error)
      ? { warn: true, meta: 'Cloudflare refused the site’s key, so the sign-in list can’t be kept. Make a new one:', fix: tokenSteps(true), actions: again('sync-access', 'access', 'signin', 'Check now') }
      : passing(a.failingSince) ? { meta: `Cloudflare had a problem at ${clock(a.failingSince)} (${cfWhy(a.error)}). The site is asking again.` }
        : { warn: true, meta: `Cloudflare has had a problem since ${clock(a.failingSince || a.failedAt)} (${cfWhy(a.error)}), so changes on People → Board aren’t reaching the sign-in list. Everyone already on it can still sign in.`, actions: again('sync-access', 'access', 'signin') })
    : !a.attached ? { warn: true, meta: 'One step left in Cloudflare, then board members can sign in.', actions: again('sync-access', 'access', 'signin', 'Check now'), fix: html`<ol class="bd-steps">
      <li>In Cloudflare, open <strong>Zero Trust → Access → Applications → ${a.appName || 'the admin’s application'} → Policies</strong>.</li>
      <li>Choose <strong>Select existing policies</strong>, tick <strong>SOARD board members</strong>, save, then choose Check now.</li>
    </ol>` }
    : !a.current ? { meta: 'Updating the sign-in list.' }
    : !a.emails && !broken.length ? { warn: true, meta: html`Nobody can sign in yet: ${peopleLink('no board member has an email on People → Board')}.` }
    : missing.length || broken.length ? { warn: true, meta: html`${board.filter((p) => usableEmail(p.email)).length} of ${plural(board.length, 'board member')} can sign in with an emailed code.${missing.length ? html` ${peopleLink(`${some(missing)} ${missing.length === 1 ? 'has' : 'have'} no email on People → Board`)}.` : ''}${brokenText}` }
    : { on: true, meta: board.length === 1 ? `${board[0].name} can sign in with an emailed code.` : 'Everyone on the board can sign in with an emailed code.' };

  // board@soardcharity.com (not shown until there's a board, or while the site has no Google key: there's nothing it can keep)
  const last = g?.changes?.[0];
  const recent = last && Date.now() - Date.parse(last.at) < 7 * 86400000;
  // A name both taken out and added is a changed address
  const moved = recent ? last.removed.filter((n) => last.added.includes(n)) : [];
  const out = recent ? last.removed.filter((n) => !moved.includes(n)) : [];
  const added = recent ? last.added.length - moved.length : 0;
  const history = recent ? ` Last change ${ago(last.at)}: ${[moved.length && `new address for ${some(moved)}`, out.length && `took out ${some(out)}`, added && `${plural(added, 'person', 'people')} added`].filter(Boolean).join('; ')}.` : '';
  const admins = [...(data.settings.admins.includes(data.me) ? ['you'] : []), ...data.settings.admins.filter((e) => e !== data.me).map(firstOf)];
  const inGroup = g?.missing?.length ? `the ${plural(g.board, 'board member')} with an email` : board.length === 1 ? board[0].name : 'every board member';
  const project = data.google?.project;
  const groupFix = {
    api: html`In Google Cloud${project ? html` (project <span class="bd-code">${project}</span>)` : ''}, turn on the <a class="link" href=${`https://console.cloud.google.com/apis/library/admin.googleapis.com${project ? `?project=${encodeURIComponent(project)}` : ''}`} target="_blank" rel="noopener">Admin SDK API</a> (Enable), then choose Try again.`,
    admin: 'Google says none of the founders on People → Team is a Workspace admin. Give one of them the Super Admin role in Google Admin, then choose Try again.',
    founder: html`The site changes the group as a founder, and nobody on ${html`<a class="link" href="#people">People → Team</a>`} is marked as one. Mark the founders there, then choose Try again.`,
    group: html`Google has no group called ${g?.group}. Make it in <a class="link" href="https://admin.google.com/ac/groups" target="_blank" rel="noopener">Google Admin → Directory → Groups</a> with that address, then choose Try again.`,
    outside: html`Google won’t put addresses from outside soardcharity.com in it. In <a class="link" href="https://admin.google.com/ac/groups" target="_blank" rel="noopener">Google Admin → Directory → Groups</a>, open ${g?.group}, then Access settings, and turn on <strong>Allow members outside your organization</strong>. Then choose Try again.`,
  }[g?.needs];
  const group = !g || !g.configured || !board.length ? null
    : g.needs === 'empty' ? { meta: 'Left as it is for now.' }
    : !g.syncedAt && !g.failedAt ? { meta: 'Adding the board now.' }
    : g.needs === 'scope' ? { warn: true, meta: 'Needs one Google setting before the site can keep it.', actions: again('sync-group', 'group', 'group', 'Check now'), fix: html`<ol class="bd-steps">
      <li>In <a class="link" href="https://admin.google.com/ac/owl/domainwidedelegation" target="_blank" rel="noopener">Google Admin → Security → API controls → Domain-wide delegation</a>, find client ID <span class="bd-code">${data.google?.clientId || 'the site’s service account'}</span>. Choose Edit, add this to the end of its OAuth scopes (after a comma, keeping the ones already there), and choose Authorize:
        <div class="bd-inline" style="margin-top:0.4rem"><span class="bd-code">${GROUP_SCOPE}</span><button class="btn btn-ghost btn-sm" onClick=${copy}>${copied ? 'Copied' : 'Copy'}</button></div></li>
      <li>Choose Check now, or this line updates by itself within half an hour.</li>
    </ol>` }
    : !g.ok && !groupFix && passing(g.failingSince) ? { meta: `Google had a problem at ${clock(g.failingSince)}. The site is asking again.${history}` }
    : !g.ok ? { warn: true, meta: groupFix || (/^Google didn’t take/.test(g.error || '') ? `${g.error}. The site keeps trying every half hour.` : `Google has had a problem since ${clock(g.failingSince || g.failedAt)} (${gWhy(g.error)}), so changes on People → Board aren’t reaching the group. The site keeps trying every half hour.`), actions: again('sync-group', 'group', 'group') }
    : !g.current ? { meta: `Updating the group.${history}` }
    : { on: true, meta: `Has ${names([inGroup, ...admins])}.${history}` };

  // The sign-in email, from who has had it (welcomeHad: their own send at the address it went to). It can go when the
  // server would send it (`ready`, MembersTab's one rule for the panel and every row).
  const w = data.welcome || {};
  const canSend = ready && !!data.packetTo;
  // What it waits for, in the words of the sign-in line above
  const waitFor = !data.setup.email ? 'the site can send email'
    : !a.configured ? (a.groupId ? 'the site has its Cloudflare key again' : 'the site has its Cloudflare key')
      : !a.syncedAt && !a.failedAt ? 'the sign-in list is made'
        : a.error && !a.ok ? (badKey(a.error) ? 'Cloudflare takes the site’s new key' : 'Cloudflare answers again')
          : !a.attached ? 'the step above is done' : 'the sign-in list is updated';
  // Who has had it: the same rule as the server's send and each member's row (board-shared.js)
  const hadIt = (p) => welcomeHad(w, p, board.map((x) => x.slug));
  const told = board.filter((p) => usableEmail(p.email) && hadIt(p));
  const notYet = board.filter((p) => usableEmail(p.email) && !hadIt(p));
  const latest = told.map(hadIt).sort().at(-1) || null;
  // Sends Resend didn't confirm (it may not have gone): said beside them
  const unconfirmed = told.filter((p) => (w.unconfirmed || []).includes(p.slug));
  const who = (list) => (list.length <= 3 ? names(list.map((p) => p.name)) : `the ${list.length} board members${told.length ? ' who haven’t had it' : ''}`);
  const confirm = async (e, list) => {
    if (busy) return;
    const btn = e.currentTarget;
    if (await ask({ title: `Email ${who(list)} how to sign in?`, text: WELCOME_ASK, yes: list.length === 1 ? `Email ${list[0].name}` : 'Email them' })) {
      // Exactly who the question named, and only those who still haven't had it when it goes (a stale page can't double anyone)
      send(btn, { slugs: list.map((p) => p.slug), due: true }, told.length ? 'some' : 'all');
    }
  };
  // Everyone again (a rebuilt email), but not who had it in the last ten minutes (the server skips them too)
  const justSent = told.filter((p) => Date.now() - Date.parse(hadIt(p)) < 10 * 60 * 1000);
  const againTo = told.filter((p) => !justSent.includes(p));
  const resend = async (e) => {
    if (busy) return;
    const btn = e.currentTarget;
    const skip = justSent.length ? ` Not ${names(justSent.map((p) => p.name))}: had it in the last ten minutes.` : '';
    if (await ask({ title: `Email ${againTo.length <= 3 ? names(againTo.map((p) => p.name)) : `${againTo.length === told.length ? 'all ' : ''}${againTo.length} board members`} again?`, text: `${WELCOME_ASK}${skip}`, yes: 'Email them again' })) send(btn, { slugs: againTo.map((p) => p.slug), again: true }, 'again');
  };
  const preview = html`<button key="preview" class="btn btn-ghost btn-sm" aria-disabled=${busy ? 'true' : null} onKeyDown=${once} onClick=${(e) => send(e.currentTarget, { test: true }, 'preview')}>${working === 'preview' ? 'Sending…' : 'Send it to me'}</button>`;
  const noKey = html`The site can’t send email yet: add <span class="bd-code">RESEND_API_KEY</span> in Cloudflare (Workers & Pages → soard-site → Settings → Variables and Secrets).`;
  const has = (list) => `${some(list.map((p) => p.name))} ${list.length === 1 ? 'has' : 'have'} it`;
  const doubt = unconfirmed.length ? ` Resend didn’t confirm the email to ${some(unconfirmed.map((p) => p.name))}; Emails & invites → What went out shows whether it was delivered.` : '';
  const email = !board.length || (!latest && !notYet.length) ? null
    // This page's send, another admin's or another tab's, going out right now
    : data.welcomeSending || (working && working !== 'preview') ? { meta: 'Going out now.' }
    // Everyone with an email has it
    : !notYet.length ? { on: true, meta: `${told.length === 1 ? `${told[0].name} has` : `All ${told.length}${board.some((p) => !usableEmail(p.email)) ? ' with an email' : ''} have`} it (last sent ${ago(latest)}).${doubt}`,
      actions: data.setup.email ? html`${preview}${canSend && againTo.length ? html`<button key="again" class="btn btn-ghost btn-sm" aria-disabled=${busy ? 'true' : null} onKeyDown=${once} onClick=${(e) => resend(e)}>${working === 'again' ? 'Sending…' : 'Email them again'}</button>` : null}` : null }
    : !data.setup.email ? { warn: true, meta: noKey }
    : !told.length ? (canSend
      ? { warn: true, meta: 'Not sent yet.', actions: html`${preview}<button key="all" class="btn btn-primary btn-sm" aria-disabled=${busy ? 'true' : null} onKeyDown=${once} onClick=${(e) => confirm(e, notYet)}>${working === 'all' ? 'Sending…' : 'Email the board how to sign in'}</button>` }
      : { meta: `Not sent yet. It can go once ${waitFor}.`, actions: preview })
    : canSend
      ? { warn: true, meta: `${has(told)}. ${some(notYet.map((p) => p.name))} ${notYet.length === 1 ? 'hasn’t' : 'haven’t'} yet.${doubt}`,
        actions: html`${preview}<button key="some" class="btn btn-primary btn-sm" aria-disabled=${busy ? 'true' : null} onKeyDown=${once} onClick=${(e) => confirm(e, notYet)}>${working === 'some' ? 'Sending…' : notYet.length <= 2 ? `Email ${names(notYet.map((p) => p.name))}` : `Email the ${notYet.length} who haven’t had it`}</button>` }
      : { meta: `${has(told)}. ${some(notYet.map((p) => p.name))} ${notYet.length === 1 ? 'hasn’t' : 'haven’t'} yet; it can go once ${waitFor}.${doubt}`, actions: preview };

  // An open page keeps up: a fresh look on coming back to the tab, and each minute while anything is on its way or waiting.
  // Focus that was on a button the fresh look took away goes to its line.
  const settled = [signIn, group, email].every((r) => !r || r.on);
  useEffect(() => {
    const look = async () => {
      // One look at a time: a slow one is never overtaken by the next (whose answer would then be the only one kept)
      if (looking.current || document.visibilityState !== 'visible' || document.querySelector('.modal-overlay') || busy || trying) return;
      looking.current = true;
      const row = document.activeElement?.closest?.('.bd-access')?.id;
      try { await ctx.load(); } finally { looking.current = false; }
      if (row && (!document.activeElement || document.activeElement === document.body)) document.getElementById(row)?.focus();
    };
    const t = settled ? null : setInterval(look, 60 * 1000);
    document.addEventListener('visibilitychange', look);
    return () => { if (t) clearInterval(t); document.removeEventListener('visibilitychange', look); };
  }, [settled, busy, trying]);
  useEffect(() => {
    let stop = false;
    let next = null;
    let misses = 0;
    const quick = async () => {
      const q = await Promise.race([call(null, { query: '?welcome=1' }), new Promise((r) => setTimeout(() => r({ ok: false }), 5000))]);
      if (stop) return;
      if (q.ok) { misses = 0; setData((d) => (d.welcomeAt > q.welcomeAt ? d : { ...d, welcome: q.welcome, welcomeSending: q.welcomeSending, welcomeAt: q.welcomeAt })); }
      else if (++misses >= 5) { setData((d) => ({ ...d, welcomeSending: false })); return; } // can't check: the minute's look takes over
      if (q.ok ? q.welcomeSending : data.welcomeSending) next = setTimeout(quick, 2000);
    };
    quick();
    return () => { stop = true; clearTimeout(next); };
  }, [data.welcomeSending]);

  // A line with steps puts its button after them, where the steps say to choose it
  const row = (id, title, r) => r && html`<li class="bd-row bd-access" id=${`bd-access-${id}`} tabindex="-1" key=${id}>
    <div class="bd-row__main">
      <div class="bd-access__t"><span class=${`dot ${r.on ? 'dot--on' : r.warn ? 'dot--warn' : ''}`} aria-hidden="true"></span><span class="bd-row__title">${title}</span>${r.warn ? html`<span class="tag tag--warn">Needs you</span>` : null}</div>
      <div class="bd-row__meta">${r.meta}</div>
    </div>
    ${r.fix ? html`<div class="bd-access__fix">${r.fix}</div>` : null}
    ${r.actions ? html`<div class=${`bd-inline ${r.fix ? 'bd-access__after' : ''}`}>${r.actions}</div>` : null}
  </li>`;
  return html`<div class="card" style="padding:0">
    <div class="sec-head"><h3>Board access</h3><span class="sec-head__hint">Follows People → Board within 5 minutes</span></div>
    <ul class="bd-row-list">
      ${row('signin', 'Board page sign-in', signIn)}
      ${row('group', g?.group || 'board@soardcharity.com', group)}
      ${row('email', 'Sign-in email', email)}
    </ul>
  </div>`;
}
/** Cloudflare's reason without the request it came from ("Cloudflare GET /access/groups: Authentication error" → "Authentication error") */
const cfWhy = (e) => (/aborted|timed? ?out/i.test(String(e)) ? 'no answer in time' : String(e || 'no answer').replace(/^Cloudflare \w+ \S+: /, ''));
/** Google's reason without the wrapping ("Google: The service is currently unavailable." → "The service is currently unavailable") */
const gWhy = (e) => (/aborted|timed? ?out/i.test(String(e)) ? 'no answer in time' : String(e || 'no answer').replace(/^Google: /, '').replace(/^no answer \(.*\)$/, 'no answer in time').replace(/\.$/, ''));
/** Cloudflare refusing the key itself: only a new token fixes that, so Try again isn't offered as the fix */
const badKey = (e) => /Authentication error|Unauthorized|Invalid API Token|not authorized|permission|HTTP 40[13]/i.test(String(e || ''));

function MembersTab({ ctx }) {
  const { data, addToast } = ctx;
  const [working, setWorking] = useState('');
  // The papers each member signs this year: written in Board, or a file the board can open (as the sign-in email counts them)
  const signDocs = data.docs.filter((d) => d.sign && d.shared && (d.body || (d.file && !d.file.staffOnly)));
  // When the sign-in email can go, for Board access and every row alike (the server's own rule): email set up, and the list
  // kept and on the admin's application, or the key gone with the list still matching the board
  const a = data.access;
  const ready = !!data.setup.email && (a.configured ? a.ok && a.attached : !!a.groupId && a.current);
  const welcome = async (body, label) => {
    setWorking(label);
    const j = await call({ action: 'send-welcome', ...body });
    let looked = null;
    // Every send button (here and on each row) stays held until the page knows who has it (the server never sends anyone
    // a second copy either way). Who has it usually comes with the answer; without it (turned away while another send went
    // out, or no answer at all) the page looks first, waiting out the other send
    if (!body.test && j.welcome) ctx.setData((d) => ({ ...d, welcome: j.welcome, welcomeSending: j.welcomeSending, welcomeAt: j.welcomeAt }));
    else if (!body.test) {
      if (j.status === 409) {
        for (let i = 0; i < 30; i++) {
          const q = await call(null, { query: '?welcome=1' });
          if (!q.ok || !q.welcomeSending) break;
          await new Promise((r) => setTimeout(r, 2000));
        }
      }
      looked = await ctx.load();
    }
    setWorking('');
    // One batch: it all went or none of it did, so after a failure sending again never doubles anyone's
    const one = body.slugs?.length === 1 ? data.members.find((p) => p.slug === body.slugs[0])?.name : '';
    // Only the server's own answer says who got it: no answer at all says nothing either way, a refusal (sent: 0, nothing
    // failed) sent nobody, and Resend not answering may still have sent it (the server counts it as sent)
    if (body.test) addToast(j.ok ? `Sent to ${j.to?.[0] || 'you'}` : j.error, j.ok ? 'info' : 'error');
    else if (typeof j.sent !== 'number') addToast(`Couldn’t tell whether it went (${j.status === 200 ? 'the answer was cut off' : j.error}). ${looked?.ok ? 'Board access now shows who has it.' : 'Reload the page to see who has it; sending again never gives anyone a second copy.'}`, 'error');
    else if (j.unsure) addToast('Resend didn’t confirm it went, so it may have gone. It’s counted as sent; Emails & invites → What went out shows whether it was delivered.', 'error');
    else if (j.status === 409 && /going out at the same moment/.test(j.error || '')) {
      // Another send went at the same moment (another tab, or the browser posting this one again): say who has it now
      const asked = data.members.filter((p) => usableEmail(p.email) && (!body.slugs || body.slugs.includes(p.slug)));
      const have = looked?.welcome && asked.length && asked.every((p) => welcomeHad(looked.welcome, p, data.members.map((x) => x.slug)));
      addToast(have ? `${asked.length === 1 ? `${asked[0].name} has` : 'They have'} it now: another send went out at the same moment.` : j.error, have ? 'info' : 'error');
    }
    else if (!j.ok) addToast(j.failed ? (j.sent ? `Emailed ${j.sent}; ${plural(j.failed, 'email')} didn’t go (${j.error})` : `Nobody got it, so sending again is safe. ${j.error}`) : `Not sent: ${j.error}`, 'error');
    else {
      // An address the mailer can't use (kim@gmail.c) is named, so it gets fixed on People → Board
      const bad = j.unusable?.length ? ` The email on People → Board for ${j.unusable.join(', ')} isn’t a whole address.` : '';
      if (!j.sent && j.already) addToast(`${body.again ? 'Nobody was emailed again: everyone had it in the last ten minutes' : one ? `${one} already has it` : 'They already have it'}.${bad}`, bad ? 'error' : 'info');
      else addToast(`${one && j.sent === 1 ? `Emailed ${one}` : `Emailed ${plural(j.reached || j.sent, 'board member')}`}.${bad}`, bad ? 'error' : 'info');
    }
    // The full look, after the answer is shown
    if (!body.test && j.welcome) looked = await ctx.load();
    return looked;
  };
  const rowHad = (slug) => { const p = data.members.find((x) => x.slug === slug); return !!(p && welcomeHad(data.welcome, p, data.members.map((x) => x.slug))); };
  // A copy a member signed on paper, added from their row (as Documents → Who's signed does)
  const onCopy = async (d, p, file, setBusy) => {
    const doc = await addSignedCopy({ d, p, picked: file, addToast, setBusy });
    if (doc) ctx.setData((x) => ({ ...x, docs: x.docs.map((y) => (y.id === doc.id ? doc : y)) }));
  };
  return html`
    <${AccessPanel} ctx=${ctx} ready=${ready} working=${working} welcome=${welcome} />
    <${BoardActivity} data=${data} signDocs=${signDocs} ready=${ready} working=${working} onWelcome=${(slug) => welcome({ slugs: [slug], ...(rowHad(slug) ? {} : { due: true }) }, slug)} onCopy=${onCopy} />`;
}

// ─── Settings ───────────────────────────────────────────────────────
function SettingsTab({ ctx }) {
  const { data, setData, addToast } = ctx;
  const pick = (x) => ({ admins: x.admins, invitesFrom: x.invitesFrom, quorum: x.quorum, defaults: x.defaults, template: x.template, driveFolder: x.driveFolder || '', asks: x.asks || 'test' });
  const [s, setS] = useState(() => pick(data.settings));
  const [newAdmin, setNewAdmin] = useState('');
  const [saving, setSaving] = useState(false);
  const dirty = JSON.stringify(s) !== JSON.stringify(pick(data.settings));
  useEffect(() => { ctx.markDirty(dirty, 'the settings'); return () => ctx.markDirty(false); }, [dirty]);
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
      <div class="bd-card-head"><h3>Who can open the Board area</h3><p>The agenda, notes, minutes and files here are for these people only. Other staff don’t see Board in the menu, and its pages refuse them. Past agendas come from their email.</p></div>
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
    <div class="bd-card-head"><h3>Reports from presenters</h3><p>Two weeks before each meeting, each board member presenting an item is emailed from ${firstOf(asker)}’s Gmail${copied ? `, ${copied} copied,` : ''} for their report, due a week before the meeting. A reminder, then past due with the chair copied. Six days before, the chair and Holly get the whole agenda to review, Peter copied; approving it emails it to the board.</p></div>
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
      ${row(c.ok && !c.errors?.length ? true : c.errors?.length ? false : null, 'Answers to the invites', c.errors?.length ? c.errors.join(' · ') : c.checkedAt ? `Read ${ago(c.checkedAt)}.` : 'Not read yet.')}
      ${row(need.drive ? false : data.drive?.ok ? true : data.drive?.errors?.length ? false : null, 'Past minutes and packets from Google Drive', need.drive ? 'Needs the Drive permission (Meetings shows how).' : data.drive?.errors?.length ? data.drive.errors.join(' · ') : data.drive?.checkedAt ? `${plural(data.drive.folders || 0, 'meeting')} found, ${plural(data.drive.files || 0, 'file')} brought in${data.drive.backlog ? `, ${data.drive.backlog} still to read` : ''}. Read ${ago(data.drive.checkedAt)}.` : 'Not read yet.')}
      ${row(need.drive ? false : data.drive?.docs?.count ? true : data.drive?.docs ? false : null, 'Bylaws and SOARD’s papers from Google Drive', need.drive ? 'Needs the Drive permission (Meetings shows how).' : data.drive?.docs ? `${plural(data.drive.docs.count || 0, 'document')} on Documents${data.drive.docs.manual ? `, from “${data.drive.docs.manual}”` : ''}${data.drive.docs.missing?.length ? `. Not found in Drive: ${data.drive.docs.missing.join(', ')}` : ''}. Read ${ago(data.drive.docs.checkedAt)}.` : 'Read once the past meetings are in.')}
      ${row(need.mail ? false : mail.ok ? true : null, 'Agendas and minutes from email', need.mail ? 'Needs the Gmail permission (Meetings shows how).' : mail.checkedAt ? `Read ${ago(mail.checkedAt)}.` : 'Not read yet.')}
      ${row(!check ? null : check.calendar === 'ok' && check.meet === 'ok', 'Invites with Google Meet', !check ? 'Not checked yet.' : check.calendar === 'ok' && check.meet === 'ok' ? 'Board can put meetings on the calendar with a Meet.' : check.error)}
      ${row(!check ? null : check.transcript === 'on' ? true : check.transcript === 'needs-setup' ? false : null, 'Meet transcripts', !check ? 'Not checked yet.' : check.transcript === 'on' ? 'Turned on for every invite.' : check.transcript === 'needs-setup' ? 'Needs the meetings.space.settings permission (Meetings shows how).' : check.error || 'Not available.')}
      ${data.group?.configured ? row(data.group.ok && data.group.current ? true : data.group.failedAt && data.group.needs !== 'empty' ? false : null, `${data.group.group} follows the board`, data.group.ok && data.group.current ? `Has every board member at their email on People → Board. Checked ${ago(data.group.syncedAt)}.` : data.group.needs === 'scope' ? 'Needs the admin.directory.group.member permission (Members shows how).' : data.group.needs === 'empty' ? 'Left as it is until a board member has an email on People → Board.' : data.group.failedAt ? 'Members says what Google said.' : 'Catching up with People → Board.') : null}
      ${row(!check?.attendance ? null : check.attendance === 'ok', 'Attendance from Google Meet', !check?.attendance ? 'Not checked yet.' : check.attendance === 'ok' ? 'After a meeting, who joined is marked “Video”.' : check.attendance === 'needs-setup' ? 'Needs the meetings.space.readonly permission (Meetings shows how).' : check.attendanceError)}
    </ul>
  </div>`;
}
