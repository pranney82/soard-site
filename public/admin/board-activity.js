/**
 * Board → Members: who on the board has signed in, when each was last on the
 * board page and on what, the last five weeks day by day, whether they've read
 * the next meeting's documents and signed this year's papers, and (their row
 * opens it) everything they did: each sitting, the pages they were on and the
 * files they read with the time they spent, their answers, sign-ins, and the
 * papers they signed, every year's.
 *
 * The data: GET /api/board-admin's `activity` (each member's summary) and
 * GET ?activity=<slug> (one member's), from ../../functions/api/_board-activity.js.
 * Names are this page's own (meetings, files, documents as they are now).
 */

import { useState, useEffect, useRef, useMemo } from './vendor.js';
import { html, call, ago, Face, viewerFiles, driveLink, dayOf, signedHow } from './board-ui.js';
import { viewerLink } from './file-viewer.js';
import { meetingName, todayEastern, longDate, plural, fileTitle, answerOf, repliesOf, inviteOut, docsOf, itemFiles, looseFiles } from './board-shared.js';
import { welcomeHad } from './board-shared.js';

const DAYS = 35;
const GAP_MS = 30 * 60_000; // one sitting: no gap longer than this (VISIT_GAP_MS on the server)

/** "12 min", "1 hr 5 min", "under a minute" (0: nothing) */
export function span(secs) {
  const s = Math.round(Number(secs) || 0);
  if (s <= 0) return '';
  if (s < 60) return 'under a minute';
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} hr${m % 60 ? ` ${m % 60} min` : ''}`;
}
// Times are SOARD's (Eastern), the same as the day headings, wherever the admin reading them is
const ET = 'America/New_York';
const clock = (ms) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: ET });
const dayName = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const dateOnly = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: ET, ...(todayEastern(Date.parse(iso)).slice(0, 4) !== todayEastern().slice(0, 4) ? { year: 'numeric' } : {}) });
const fullTime = (iso) => new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: ET });
// A file looked at this long was read; a flip past it was only opened
const READ_SECS = 15;
const readWords = (secs) => (secs === null ? 'Not opened' : secs >= 60 ? `Read ${span(secs)}` : secs >= READ_SECS ? 'Read for under a minute' : 'Opened');
/**
 * When they first signed in, as far as Board knows: before it began keeping sign-ins (`began`), only that they have.
 * → { v: "Since Nov 4" | "Yes", s: "3 sign‑ins" | "3 sign‑ins since Nov 3" }
 */
function firstWords(a, began) {
  if (!a?.firstSignIn) return null;
  // A sign-in from before Board began keeping them (an Access sign-in lasts a week): only that they have, and the ones since
  const before = began && a.firstSignIn < began;
  if (!before) return { v: `First on ${dateOnly(a.firstSignIn)}`, s: signIns(a.signIns) };
  const sameDay = todayEastern(Date.parse(a.firstSignIn)) === todayEastern(Date.parse(began));
  return { v: 'Yes', s: a.signInsSince ? `${signIns(a.signInsSince)} since ${dateOnly(began)}` : `${sameDay ? 'Earlier on' : 'Before'} ${dateOnly(began)}` };
}
// "1 sign‑in" with a hyphen that never breaks the word across lines
const signIns = (n) => plural(n, 'sign\u2011in');
const shiftDay = (d, n) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Meetings, files, documents, items, action items and motions by id, to name what the server only knows by id */
export function namesFrom(data, more = {}) {
  const meetings = new Map((data.meetings || []).map((m) => [m.id, m]));
  const files = new Map();
  const items = new Map();
  const actions = new Map();
  const motions = new Map();
  for (const m of data.meetings || []) {
    for (const f of m.files || []) files.set(f.id, { name: f.name, m });
    for (const s of m.sections || []) for (const it of s.items || []) items.set(it.id, { it, m });
    for (const a of m.actions || []) actions.set(a.id, a);
    for (const x of m.motions || []) motions.set(x.id, x);
  }
  for (const d of data.docs || []) {
    if (d.file) files.set(d.file.id, { name: d.file.name, doc: d });
    for (const sig of Object.values(d.signed || {})) if (sig?.copy?.id) files.set(sig.copy.id, { name: d.title, doc: d, signed: true });
  }
  const docs = new Map((data.docs || []).map((d) => [d.id, d]));
  // Files no longer on a meeting or a paper as it is now (`more`: the member's sheet names them): a paper's earlier copy
  for (const [id, f] of Object.entries(more || {})) {
    if (files.has(id)) continue;
    const doc = f.ownerType === 'doc' ? docs.get(f.ownerId) : null;
    files.set(id, doc ? { name: f.name, doc, earlier: true } : { name: f.name, m: meetings.get(f.ownerId) });
  }
  return { meetings, files, items, actions, motions, docs };
}

const PAGE_NAMES = { home: 'Home', meetings: 'All meetings', financials: 'Financials', gifts: 'Major gifts', people: 'People', documents: 'Documents' };

/**
 * One thing they did, in words: { icon, text, secs }. L: namesFrom(data). An id no longer here (a meeting or
 * file since deleted) is named as such, never left blank
 */
export function said(e, L) {
  const m = L.meetings.get(e.ref);
  const mtg = m ? `the ${meetingName(m)}` : 'a meeting since removed';
  const file = (id) => {
    const f = L.files.get(id);
    return !f ? 'a file since removed' : f.signed ? `their signed copy of “${f.doc.title}”` : f.earlier ? `an earlier copy of “${f.doc.title}”` : `“${fileTitle(f.name)}”`;
  };
  const item = (id) => { const x = L.items.get(id); return x ? `“${x.it.title || 'an item'}”` : 'an item'; };
  switch (e.kind) {
    case 'view': {
      const [page, id, sub] = String(e.ref).split('/');
      const pm = L.meetings.get(id);
      const pname = pm ? `the ${meetingName(pm)}` : 'a meeting since removed';
      if (page === 'meeting') return { icon: 'page', text: `Looked at ${pname}`, secs: e.secs };
      if (page === 'screen') return { icon: 'screen', text: `Followed ${pname} on its screen`, secs: e.secs };
      if (page === 'report') return { icon: 'pen', text: `Opened the report page for ${item(sub)}`, secs: e.secs };
      if (page === 'review') return { icon: 'check', text: `Looked over the agenda of ${pname}, to approve it`, secs: e.secs };
      if (page === 'paper') { const d = L.docs.get(id); return { icon: 'page', text: `${(e.secs || 0) >= READ_SECS ? 'Read' : 'Opened'} ${d ? `“${d.title}”` : 'a paper since removed'}`, secs: e.secs }; }
      return { icon: 'page', text: `Looked at ${PAGE_NAMES[page] || 'the board page'}`, secs: e.secs };
    }
    case 'file': return { icon: 'file', text: `${(e.secs || 0) >= READ_SECS ? 'Read' : 'Opened'} ${file(e.ref)}`, secs: e.secs };
    case 'video': return { icon: 'video', text: m ? `Opened the video call for ${mtg}` : 'Opened a meeting’s video call' };
    case 'print': return { icon: 'print', text: L.files.has(e.ref) ? `Printed ${file(e.ref)}` : e.sub === 'paper' ? `Printed ${L.docs.has(e.ref) ? `“${L.docs.get(e.ref).title}”` : 'a paper since removed'}` : !m ? 'Printed from the board page' : e.sub === 'all' ? `Printed ${mtg}, all of it` : e.sub === 'form' ? `Printed the minutes form for ${mtg}` : `Printed the page for ${mtg}` };
    case 'calendar': return { icon: 'calendar', text: `Downloaded the calendar file for ${mtg}` };
    case 'live': return { icon: 'screen', text: `Followed ${mtg} live`, secs: e.secs };
    case 'checkin': return { icon: 'check', text: `Checked in at ${mtg}${e.sub === 'remote' ? ', on video' : e.sub === 'present' ? ', in the room' : ''}` };
    case 'vote': { const x = L.motions.get(e.sub); return { icon: 'vote', text: x?.text ? `Voted on “${x.text}”` : `Voted on a motion at ${mtg}` }; }
    case 'report': return { icon: 'pen', text: `Wrote their report on ${item(e.sub)}`, secs: e.secs };
    case 'nothing': return { icon: 'pen', text: `Said there’s nothing new to report on ${item(e.sub)}` };
    case 'motion': return { icon: 'vote', text: `Wrote the motion on ${item(e.sub)} for the board to vote on` };
    case 'unmotion': return { icon: 'vote', text: `Took the motion off ${item(e.sub)}` };
    case 'attach': return { icon: 'file', text: `Added a document to ${item(e.sub)}` };
    case 'detach': return { icon: 'file', text: `Took a document off ${item(e.sub)}` };
    case 'minutes': return { icon: 'pen', text: `Sent the minutes of ${mtg}` };
    case 'note': return { icon: 'pen', text: e.sub ? `Wrote a note on ${item(e.sub)}` : `Wrote a note on ${mtg}` };
    case 'unnote': return { icon: 'pen', text: e.sub ? `Took their note off ${item(e.sub)}` : `Took their note off ${mtg}` };
    case 'approve': return { icon: 'check', text: `Approved the agenda of ${mtg}` };
    case 'ask': return { icon: 'pen', text: `Sent ${item(e.sub)} back to its presenter` };
    case 'sign': { const d = L.docs.get(e.ref); return { icon: 'pen', text: `${d ? `Signed “${d.title}”` : 'Signed a document'}${e.sub === 'copy' ? ', with the copy they signed on paper' : ''}` }; }
    case 'action': { const a = L.actions.get(e.ref); return { icon: 'check', text: `${e.sub === 'open' ? 'Reopened' : 'Checked off'} ${a?.text ? `“${a.text}”` : 'an action item'}` }; }
    case 'signin': return { icon: 'key', text: `Signed in${e.device ? ` on ${e.device}` : ''}` };
    default: return { icon: 'page', text: 'Used the board page' };
  }
}

/** A sitting's rows with the same page or file again in a row made one, its time added up */
export const merged = (rows) => rows.reduce((out, r) => {
  const prev = out.at(-1);
  if (prev && ['view', 'file'].includes(r.kind) && prev.kind === r.kind && prev.ref === r.ref && (prev.sub || '') === (r.sub || '')) prev.secs = (prev.secs || 0) + (r.secs || 0);
  else out.push({ ...r });
  return out;
}, []);

/** Sittings, newest first, each oldest-first inside: [{ at, until, device, rows }] (sign-ins are rows too) */
export function sittingsOf({ events = [], signIns = [] }) {
  const all = [
    ...events.map((e) => ({ ...e, t: Date.parse(e.at), end: Date.parse(e.until || e.at) })),
    ...signIns.map((s) => ({ kind: 'signin', at: s.at, device: s.device, secs: 0, t: Date.parse(s.at), end: Date.parse(s.at) })),
  ].filter((e) => Number.isFinite(e.t)).sort((a, b) => a.t - b.t);
  const out = [];
  for (const e of all) {
    const cur = out.at(-1);
    if (cur && e.t - cur.until <= GAP_MS) { cur.rows.push(e); cur.until = Math.max(cur.until, e.end); if (e.device) cur.device = e.device; } else out.push({ at: e.t, until: e.end, device: e.device || '', rows: [e] });
  }
  return out.reverse();
}

const PATHS = {
  key: 'M14 7a4 4 0 1 1-7.7 1.5L2 12.8V16h3v-2h2v-2h2l1.2-1.2A4 4 0 0 1 14 7z',
  page: 'M5 2h7l4 4v12H5zM12 2v4h4M8 10h5M8 13h5',
  file: 'M6 2h6l4 4v12H6zM12 2v4h4',
  screen: 'M3 4h14v9H3zM7 17h6M10 13v4',
  video: 'M3 6h9v8H3zM12 9l5-3v8l-5-3',
  print: 'M6 7V3h8v4M5 14H3V8h14v6h-2M6 11h8v6H6z',
  calendar: 'M3 5h14v12H3zM3 9h14M7 3v4M13 3v4',
  check: 'M4 10.5l4 4 8-9',
  pen: 'M13.5 3.5l3 3L7 16H4v-3z',
  vote: 'M4 10h3v7H4zM9 4h3v13H9zM14 8h3v9h-3z',
};
const Icon = ({ name }) => html`<svg class="ba-ico" viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d=${PATHS[name] || PATHS.page} fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" /></svg>`;

/** An address that breaks only where it reads well: after the @, before a dot ("pnielsen@" / "tridentconstructiongroup" / ".com") */
const emailParts = (email) => {
  const [name, ...rest] = String(email).split('@');
  return html`${name}@<wbr />${rest.join('@').split('.').map((part, i) => (i ? html`<wbr />.${part}` : part))}`;
};

/** The last five weeks, a square a day (today last): darker for more time on the page; a dot under a meeting day */
export function DayStrip({ days = {}, meetingDays = new Set(), today = todayEastern() }) {
  const cells = Array.from({ length: DAYS }, (_, i) => shiftDay(today, i - DAYS + 1));
  const on = cells.filter((d) => d in days).length;
  const level = (d) => (!(d in days) ? 0 : !days[d] ? 'in' : days[d] < 300 ? 1 : days[d] < 1200 ? 2 : 3);
  return html`<span class="ba-strip" role="img" aria-label=${`On the board page ${plural(on, 'day')} of the last ${DAYS}`}>
    ${cells.map((d) => html`<span key=${d} class=${`ba-day ba-day--${level(d)}${meetingDays.has(d) ? ' ba-day--meeting' : ''}`}
      title=${`${dayName(d)}${meetingDays.has(d) ? ' (board meeting)' : ''}: ${d in days ? span(days[d]) || 'on the page briefly' : 'not on the page'}`}></span>`)}
  </span>`;
}

/**
 * A meeting's documents as the board page lists them, with what they've opened of each: [{ d, secs | null }]. Each
 * item's (the last meeting's minutes with "approve the minutes"), then the rest; a document in two formats is one,
 * opened when either copy was; staff-only files left out
 */
export function readOf(m, a, meetings = []) {
  if (!m) return [];
  const board = (files) => files.filter((f) => !f.staffOnly && f.kind !== 'signed');
  const all = [...(m.sections || []).flatMap((s) => (s.items || []).flatMap((it) => docsOf(board(itemFiles(m, it, meetings))))), ...docsOf(board(looseFiles(m)))];
  const seen = new Set();
  return all.filter((d) => !seen.has(d.file.id) && seen.add(d.file.id)).map((d) => {
    const opened = d.copies.filter((f) => a?.files && f.id in a.files);
    return { d, secs: opened.length ? opened.reduce((t, f) => t + (a.files[f.id] || 0), 0) : null };
  });
}
/** How many of these documents came after Print it all at `at` (0: it printed them all), or null when they didn't print */
export const cameAfter = (reads, at) => (at ? reads.filter((x) => x.d.copies.some((f) => f.at && f.at > at)).length : null);
/** What they've opened of the next meeting's documents, in a line: "Opened 2 of 3 documents, printed them all" */
export function docsLine(reads, printed = false) {
  const n = reads.length;
  const read = reads.filter((x) => x.secs !== null).length; // opened, however briefly
  const said = read === n ? (n === 1 ? 'Opened the document' : n === 2 ? 'Opened both documents' : `Opened all ${n} documents`)
    : read ? `Opened ${read} of ${n} documents` : '';
  if (printed) return said ? `${said}, printed them all` : 'Printed them all';
  return said || `Hasn’t opened the ${n === 1 ? 'document' : `${n} documents`}`;
}

/** Whether they're coming, as the meeting's calendar invite says (the only answer SOARD goes by) */
function Coming({ m, slug }) {
  const reply = repliesOf(m)[slug];
  if (!reply && !inviteOut(m)) return html`<span class="ba-muted">No invite yet</span>`;
  // Board sends every invite, so the meeting's own button adds them
  if (!reply) return html`<span class="tag tag--warn" title="Send the invite on the meeting adds them">Not on the invite</span>`;
  return answerOf('', reply) || html`<span class="ba-muted">No answer yet</span>`;
}

// Members' last summary, kept while the admin is open: shown at once the next time Members opens, while it's asked again
let lastOverview = null;

let dlgSeq = 0;
/** The admin's shared dialog (its kd-dialog classes, as ./advisory-applications.js draws it) */
function Dialog({ title, sub = '', children, onClose }) {
  const ref = useRef(null);
  const idRef = useRef(`ba-dlg-${++dlgSeq}`);
  const live = useRef(onClose);
  live.current = onClose;
  useEffect(() => {
    const prev = document.activeElement;
    document.body.classList.add('modal-open');
    const onKey = (e) => {
      // A question asked over it (ask.js) or a file opened from it has the keys until it closes
      if (document.querySelector('.ask-overlay') || document.querySelector('.fv-host')?.firstElementChild) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); live.current(); return; }
      if (e.key !== 'Tab') return;
      const f = [...(ref.current?.querySelectorAll('button:not([disabled]), [href], input:not([disabled]):not([tabindex="-1"]), [tabindex="0"]') || [])].filter((el) => el.getClientRects().length);
      if (!f.length) return;
      const inside = ref.current.contains(document.activeElement);
      if (e.shiftKey && (!inside || document.activeElement === f[0])) { e.preventDefault(); f[f.length - 1].focus(); } else if (!e.shiftKey && (!inside || document.activeElement === f[f.length - 1])) { e.preventDefault(); f[0].focus(); }
    };
    window.addEventListener('keydown', onKey, true);
    requestAnimationFrame(() => (ref.current?.querySelector('.kd-dialog__body') || ref.current)?.focus());
    return () => {
      window.removeEventListener('keydown', onKey, true);
      if (document.querySelectorAll('.modal-overlay').length <= 1) document.body.classList.remove('modal-open');
      if (prev?.isConnected) prev.focus?.();
    };
  }, []);
  return html`<div class="modal-overlay kd-overlay" onClick=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div class="modal kd-dialog kd-dialog--lg ba-dialog" role="dialog" aria-modal="true" aria-labelledby=${idRef.current} ref=${ref} tabindex="-1">
      <header class="kd-dialog__head">
        <div class="kd-dialog__titles"><h2 id=${idRef.current}>${title}</h2>${sub ? html`<p class="kd-dialog__sub">${sub}</p>` : null}</div>
        <button type="button" class="kd-x" aria-label="Close" onClick=${onClose}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>
      </header>
      <div class="kd-dialog__body" tabindex="0" role="region" aria-labelledby=${idRef.current}>${children}</div>
    </div>
  </div>`;
}

/**
 * The papers every board member signs, for one member, a year at a time: this year's each (how and when they signed,
 * its copy, or not yet, with the copy they signed on paper to add), then each earlier year's they signed, kept
 */
function SignedEachYear({ p, signDocs, onCopy }) {
  const [busy, setBusy] = useState('');
  const pick = useRef(null);
  const forDoc = useRef(null);
  const year = Number(todayEastern().slice(0, 4));
  const past = (p.pastYears || []).filter((s) => s.year < year);
  if (!signDocs.length && !past.length) return null;
  const see = (s, title) => (s?.copy ? html` · <a ...${viewerLink(viewerFiles([{ ...s.copy, name: `${title}, signed by ${p.name}` }]), 0)}>See it</a>`
    : s?.drive ? html` · <a href=${driveLink(s.drive.id)} target="_blank" rel="noopener">Open it in Drive</a>` : null);
  const add = async (file) => {
    if (pick.current) pick.current.value = '';
    const d = forDoc.current;
    if (!file || !d || !onCopy) return;
    await onCopy(d, p, file, (k) => setBusy(k ? d.id : ''));
    // The focus stays on its line (signed now, it has no button: the line itself)
    requestAnimationFrame(() => { const li = document.querySelector(`[data-sign-row="${CSS.escape(d.id)}"]`); (li?.querySelector('button') || li)?.focus(); });
  };
  const years = [year, ...new Set(past.map((s) => s.year))];
  return html`<section class="ba-sec">
    <h3 class="ba-sec__h">Papers signed, each year</h3>
    ${years.map((y) => {
      const rows = y === year
        ? signDocs.map((d) => {
          const s = d.signed[p.slug];
          const was = !s && d.before?.[p.slug];
          return html`<li class="ba-sign" key=${d.id} data-sign-row=${d.id} tabindex="-1">
            <span class=${`ba-sign__dot ${s ? 'is-on' : ''}`} aria-hidden="true"></span>
            <span class="ba-sign__name">${d.title}</span>
            <span class="ba-sign__how">${s ? signedHow(s) : was ? `Signed the earlier version on ${dayOf(was.at)}, not the new one yet` : 'Not signed yet'}${see(s || was, d.title)}</span>
            ${!s && onCopy ? html`<button type="button" class="btn btn-ghost btn-sm" disabled=${!!busy} onClick=${() => { forDoc.current = d; pick.current?.click(); }}>${busy === d.id ? 'Adding…' : was ? 'Add their new signed copy' : 'Add their signed copy'}</button>` : null}
          </li>`;
        })
        : past.filter((s) => s.year === y).map((s) => html`<li class="ba-sign" key=${s.docId}>
            <span class="ba-sign__dot is-on" aria-hidden="true"></span>
            <span class="ba-sign__name">${s.title}</span>
            <span class="ba-sign__how">${signedHow(s)}${see(s, s.title)}</span>
          </li>`);
      return rows.length ? html`<h4 class="ba-sign__y" key=${`y-${y}`}>${y}</h4><ul class="ba-signs" key=${`l-${y}`} aria-label=${`Signed for ${y}`}>${rows}</ul>` : null;
    })}
    <input ref=${pick} type="file" class="sr-only" tabindex="-1" aria-hidden="true" accept=".pdf,image/*" onChange=${(e) => add(e.target.files[0])} />
  </section>`;
}

/** One member, everything: the facts, the next meeting's documents, the papers they signed each year, then each sitting */
function MemberSheet({ p, face, a, loaded = true, began = null, data, next, sentAt, onWelcome, working, onClose, signDocs = [], onCopy = null }) {
  const [got, setGot] = useState(null);
  const [asking, setAsking] = useState(0);
  useEffect(() => {
    let live = true;
    call(null, { query: `?activity=${encodeURIComponent(p.slug)}` }).then((j) => { if (live) setGot(j); });
    return () => { live = false; };
  }, [p.slug, asking]);
  const L = useMemo(() => namesFrom(data, got?.files), [data, got]);
  const sittings = useMemo(() => (got?.ok ? sittingsOf(got) : []), [got]);
  const first = String(p.name).split(/\s+/)[0];
  const reads = readOf(next, a, data.meetings);
  const printedAt = next ? a?.printedAll?.[next.id] : null;
  const since = cameAfter(reads, printedAt);
  const last = [a?.lastAt, p.lastSeen].filter(Boolean).sort().at(-1) || null;
  let day = '';
  return html`<${Dialog} title=${p.name} sub=${[p.title && p.title !== 'Board Member' ? p.title : '', p.email].filter(Boolean).join(' · ')} onClose=${onClose}>
    <div class="ba-sheet">
      <div class="ba-facts">
        <div class="ba-fact"><span class="ba-fact__k">Signed in</span><span class="ba-fact__v">${firstWords(a, began)?.v || (last ? 'Yes' : 'Not yet')}</span>
          <span class="ba-fact__s">${a?.signIns ? firstWords(a, began).s : !last && sentAt ? `Sign-in email sent ${dateOnly(sentAt)}` : !last ? 'No sign-in email yet' : ''}</span></div>
        <div class="ba-fact"><span class="ba-fact__k">Last on the board page</span><span class="ba-fact__v">${last ? ago(last) : 'Never'}</span><span class="ba-fact__s">${a?.device || ''}</span></div>
        ${loaded ? html`<div class="ba-fact"><span class="ba-fact__k">The last 5 weeks</span><span class="ba-fact__v">${a?.visits35 ? plural(a.visits35, 'visit') : 'No visits'}</span><span class="ba-fact__s">${span(a?.secs35) ? `${span(a.secs35)} on the page` : ''}</span></div>` : null}
      </div>
      ${!last && p.email && onWelcome ? html`<p class="ba-sheet__ask"><button class="btn btn-ghost btn-sm" disabled=${!!working} aria-label=${`${sentAt ? 'Send the sign-in email again' : 'Send the sign-in email'} to ${p.name}`} onClick=${() => onWelcome(p.slug)}>${working === p.slug ? 'Sending…' : sentAt ? 'Send the sign-in email again' : 'Send the sign-in email'}</button></p>` : null}
      ${next ? html`<section class="ba-sec">
        <h3 class="ba-sec__h">For the ${meetingName(next)}, ${longDate(next.date)}</h3>
        ${printedAt ? html`<p class="ba-coming">${since ? `Printed it all ${ago(printedAt)}, before ${plural(since, 'more document')} came.` : `Printed it all (the agenda and documents) ${ago(printedAt)}.`}</p>` : null}
        <p class="ba-coming">On the calendar invite: <${Coming} m=${next} slug=${p.slug} /></p>
        ${loaded && reads.length ? html`<ul class="ba-reads">${reads.map(({ d, secs }) => html`<li key=${d.file.id} class=${secs === null ? 'is-unread' : 'is-read'}>
          <span class="ba-reads__mark" aria-hidden="true">${secs === null || !next.shared ? '' : html`<${Icon} name="check" />`}</span>
          <span class="ba-reads__name">${d.title}</span>
          <span class="ba-reads__t">${next.shared ? readWords(secs) : 'Not on the board page yet'}</span></li>`)}</ul>` : null}
      </section>` : null}
      <${SignedEachYear} p=${p} signDocs=${signDocs} onCopy=${onCopy} />
      <section class="ba-sec">
        <h3 class="ba-sec__h">What ${first} did</h3>
        ${!got ? html`<p class="ba-muted" role="status">Loading…</p>`
          : !got.ok ? html`<p class="ba-muted" role="status">What ${first} did didn’t load (${got.error || 'no answer'}). <button type="button" class="btn btn-ghost btn-sm" onClick=${() => { setGot(null); setAsking((n) => n + 1); }}>Try again</button></p>`
            : !sittings.length ? html`<div class="empty empty--inline"><p class="empty__title">Nothing yet</p><p class="empty__text">${last ? `${first} was on the board page before it kept this. What they open from now on shows here.` : `Once ${first} signs in, each visit and what they open shows here.`}</p></div>`
              : html`<ol class="ba-log">${sittings.map((v) => {
                const d = todayEastern(v.at);
                const head = d !== day ? (day = d, html`<li class="ba-log__day" key=${`d-${d}`}><h4>${d === todayEastern() ? 'Today' : d === shiftDay(todayEastern(), -1) ? 'Yesterday' : longDate(d)}</h4></li>`) : null;
                const secs = v.rows.reduce((t, r) => t + (['view', 'file'].includes(r.kind) ? r.secs || 0 : 0), 0);
                return html`${head}<li class="ba-visit" key=${`v-${v.at}`}>
                  <p class="ba-visit__h"><span>${clock(v.at)}${v.until - v.at >= 60_000 ? ` to ${clock(v.until)}` : ''} ET</span>${v.device ? html`<span class="ba-muted">${v.device}</span>` : null}${span(secs) ? html`<span class="ba-muted">${span(secs)} on the page</span>` : null}</p>
                  <ul class="ba-rows">${merged(v.rows).map((r, i) => { const s = said(r, L); return html`<li key=${i} class=${`ba-row ba-row--${r.kind}`}><${Icon} name=${s.icon} /><span class="ba-row__t">${s.text}</span>${span(s.secs) ? html`<span class="ba-row__s">${span(s.secs)}</span>` : null}</li>`; })}</ul>
                </li>`;
              })}</ol>${got.events.length >= 1500 ? html`<p class="ba-muted ba-since">This shows from ${longDate(todayEastern(Date.parse(got.from)))}.</p>` : a?.firstSignIn && Date.now() - Date.parse(a.firstSignIn) > 180 * 86_400_000 ? html`<p class="ba-muted ba-since">This shows the last 180 days.</p>` : null}`}
      </section>
    </div>
  <//>`;
}

/**
 * The board, a row each: who they are and the address they sign in with, signed in (or the sign-in email), last
 * on the page and on what, the five-week strip, the next meeting (their answer and what they've read), papers signed
 */
let styled = false;
export function BoardActivity({ data, next, signDocs, ready, working, onWelcome, onCopy = null }) {
  if (!styled && typeof document !== 'undefined') {
    styled = true;
    const el = document.createElement('style');
    el.id = 'ba-styles';
    el.textContent = ACTIVITY_STYLES;
    document.head.appendChild(el);
  }
  const [show, setShow] = useState('all');
  const [open, setOpen] = useState(null);
  // Everyone's summary, asked for when Members opens (never on the rest of Board's tabs). The table is Board's own at
  // once (who, signed in, the invite, the papers); what each did fills in, and last time's shows while it's asked again
  const [got, setGot] = useState(lastOverview);
  const [asking, setAsking] = useState(0);
  useEffect(() => {
    let live = true;
    call(null, { query: '?activity=' }).then((j) => {
      if (!live) return;
      if (j?.ok) lastOverview = j;
      setGot((was) => (j?.ok || !was?.ok ? j : { ...was, failed: j?.error || 'no answer' }));
    });
    return () => { live = false; };
  }, [asking]);
  const loaded = !!got?.ok;
  const act = got?.activity || {};
  // Who has had the sign-in email: one rule with Board access and the server's send (board-shared.js welcomeHad)
  const onBoard = data.members.map((x) => x.slug);
  const sent = Object.fromEntries(data.members.map((p) => [p.slug, welcomeHad(data.welcome, p, onBoard)]).filter(([, at]) => at));
  const faces = new Map([...(data.people?.board || [])].map((p) => [p.slug, p]));
  const today = todayEastern();
  const meetingDays = useMemo(() => new Set((data.meetings || []).filter((m) => !m.notBoard && !m.practice).map((m) => m.date)), [data.meetings]);
  const began = got?.activityBegan || null;
  const meetingIn = [...meetingDays].some((d) => d <= today && d > shiftDay(today, -DAYS));
  const lastOf = (p) => [act[p.slug]?.lastAt, p.lastSeen].filter(Boolean).sort().at(-1) || null;
  const inCount = data.members.filter(lastOf).length;
  const shown = data.members.filter((p) => (show === 'in' ? lastOf(p) : show === 'not' ? !lastOf(p) : true));
  const nextFiles = readOf(next, null, data.meetings).length;
  const segs = [['all', 'All', data.members.length], ['in', 'Signed in', inCount], ['not', 'Not yet', data.members.length - inCount]];
  const person = open && data.members.find((p) => p.slug === open);
  return html`<div class="card ba-card" style="padding:0">
    <div class="sec-head ba-head"><h3>The board <span class="count">${data.members.length}</span></h3>
      <div class="seg ba-seg" role="group" aria-label="Show">${segs.map(([k, label, n]) => html`<button type="button" key=${k} aria-pressed=${show === k} onClick=${() => setShow(k)}>${label} <span class="count">${n}</span></button>`)}</div>
    </div>
    ${!got ? html`<p class="ba-status" role="status">Loading what each member did on the board page…</p>`
      : !got.ok || got.failed ? html`<p class="ba-status" role="status">${loaded ? 'This is from when Members last opened: loading it again didn’t work' : 'What each member did on the board page didn’t load'} (${got.failed || got.error || 'no answer'}).
        <button type="button" class="btn btn-ghost btn-sm" onClick=${() => { setGot((g) => (g?.ok ? { ...g, failed: '' } : null)); setAsking((n) => n + 1); }}>Try again</button></p>` : null}
    ${!shown.length ? html`<div class="empty empty--inline ba-none"><p class="empty__title">${!data.members.length ? 'Nobody is on the board in People yet' : show === 'not' ? 'Everyone has signed in' : 'Nobody has signed in yet'}</p></div>` : html`<table class="bd-table ba-table">
      <thead><tr><th>Member</th><th>Signed in</th><th>Last on the board page</th><th>The last 5 weeks</th>${next ? html`<th>${meetingName(next)}</th>` : null}${signDocs.length ? html`<th>Signed for ${today.slice(0, 4)}</th>` : null}<th class="ba-go-h" aria-hidden="true"></th></tr></thead>
      <tbody>${shown.map((p) => {
        const a = act[p.slug];
        const last = lastOf(p);
        const reads = next ? readOf(next, a, data.meetings) : [];
        const signed = signDocs.filter((d) => d.signed[p.slug]).length;
        // Not all signed this year: the last year they had (a new year's first weeks), said under it
        const lastYear = (x) => (signed < signDocs.length && x.pastYears?.length ? x.pastYears[0].year : 0);
        const openRow = () => setOpen(p.slug);
        return html`<tr key=${p.slug} class="ba-tr" onClick=${(e) => { if (!e.target.closest('button, a')) openRow(); }}>
          <td><span class="ba-who"><${Face} p=${faces.get(p.slug) || p} size=${32} /><span class="ba-who__text"><button type="button" class="ba-name" data-slug=${p.slug} onClick=${openRow}>${p.name}</button>
            <span class="bd-row__meta ba-email">${p.email ? emailParts(p.email) : html`<span class="tag tag--warn">No email on file</span>`}</span></span></span></td>
          <td data-label="Signed in">${last
            ? html`<span class="ba-line">${firstWords(a, began)?.v || 'Yes'}</span>${a?.signIns ? html`<span class="bd-row__meta">${firstWords(a, began).s}</span>` : null}`
            : html`<span class="ba-not"><span class="ba-line ba-muted">Not yet</span>${sent[p.slug] ? html`<span class="bd-row__meta">Email sent ${dateOnly(sent[p.slug])}</span>` : null}
              ${ready && p.email ? html`<button class="btn btn-ghost btn-sm" disabled=${!!working} aria-label=${`${sent[p.slug] ? 'Send the sign-in email again' : 'Send the sign-in email'} to ${p.name}`} onClick=${() => onWelcome(p.slug)}>${working === p.slug ? 'Sending…' : sent[p.slug] ? 'Send it again' : 'Send the sign-in email'}</button>` : null}</span>`}</td>
          <td data-label="Last on the board page">${last ? html`<span class="ba-line" title=${fullTime(last)}>${ago(last)}</span>${a?.device ? html`<span class="bd-row__meta">${a.device}</span>` : null}` : html`<span class="ba-line ba-muted">Never</span>`}</td>
          <td data-label="The last 5 weeks">${loaded ? html`<${DayStrip} days=${a?.days || {}} meetingDays=${meetingDays} today=${today} />${a?.visits35 ? html`<span class="bd-row__meta">${plural(a.visits35, 'visit')} in 5 weeks${(a.secs35 || 0) >= 60 ? `, ${span(a.secs35)} in all` : ''}</span>` : null}` : null}</td>
          ${next ? html`<td data-label=${meetingName(next)}><span class="ba-line"><${Coming} m=${next} slug=${p.slug} /></span>${nextFiles && !next.shared ? html`<span class="bd-row__meta">Not shared with the board yet</span>` : nextFiles && loaded ? html`<span class="bd-row__meta">${docsLine(reads, cameAfter(reads, a?.printedAll?.[next.id]) === 0)}</span>` : null}</td>` : null}
          ${signDocs.length ? html`<td data-label=${`Signed for ${today.slice(0, 4)}`}><span class=${`tag ${signed === signDocs.length ? 'tag--success' : ''}`}>${signDocs.length === 1 ? (signed ? 'Signed' : 'Not yet') : `${signed} of ${signDocs.length}`}</span>${lastYear(p) ? html`<span class="bd-row__meta">Signed for ${lastYear(p)}</span>` : null}</td>` : null}
          <td class="ba-go" aria-hidden="true"><svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M8 5l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg></td>
        </tr>`;
      })}</tbody>
    </table>`}
    ${loaded && shown.length ? html`<p class="ba-key"><span class="ba-key__i"><span class="ba-strip" aria-hidden="true"><span class="ba-day"></span><span class="ba-day ba-day--in"></span><span class="ba-day ba-day--1"></span><span class="ba-day ba-day--2"></span><span class="ba-day ba-day--3"></span></span>Each square is a day, darker for more time on the board page</span>${meetingIn ? html`<span class="ba-key__i"><span class="ba-key__dot" aria-hidden="true"></span>A board meeting</span>` : null}</p>` : null}
    ${person ? html`<${MemberSheet} p=${person} face=${faces.get(person.slug)} a=${act[person.slug]} loaded=${loaded} began=${began} data=${data} next=${next} sentAt=${sent[person.slug]} onWelcome=${ready ? onWelcome : null} working=${working} signDocs=${signDocs} onCopy=${onCopy} onClose=${() => { const slug = open; setOpen(null); requestAnimationFrame(() => document.querySelector(`.ba-name[data-slug="${CSS.escape(slug)}"]`)?.focus()); }} />` : null}
  </div>`;
}

export const ACTIVITY_STYLES = `
  .ba-card { container-type: inline-size; }
  .ba-head { flex-wrap: wrap; gap: 0.75rem; }
  .ba-none { padding: 1.5rem 1.25rem; }
  .ba-table td { vertical-align: top; }
  .ba-line { display: block; }
  .ba-table .bd-row__meta { display: block; }
  .ba-tr { cursor: pointer; }
  .ba-tr:hover td { background: var(--color-bg-hover); }
  .ba-who { display: flex; align-items: center; gap: 0.7rem; min-width: 0; }
  .ba-who__text { display: grid; gap: 0.05rem; min-width: 0; }
  .ba-who .bd-row__meta { margin-top: 0; }
  .ba-email { overflow-wrap: anywhere; }
  /* Wide enough for the table: room for a member's name on a line and their address in two or three pieces, and
     the sign-in email's line and button each on one */
  @container (min-width: 1101px) {
    .ba-table th:first-child, .ba-table td:first-child { min-width: 15rem; }
    /* (a heading as wide as its column needs, on two lines if it must: "Last on the / board page") */
    .ba-table th { white-space: normal; vertical-align: bottom; }
    .ba-table td[data-label="Signed in"] .bd-row__meta, .ba-table td[data-label="Signed in"] .btn { white-space: nowrap; }
  }
  .ba-table td[data-label="Signed in"] > .ba-line { white-space: nowrap; }
  .ba-name { all: unset; cursor: pointer; font-weight: 600; color: var(--color-text); overflow-wrap: anywhere; }
  .ba-name:hover { text-decoration: underline; text-underline-offset: 3px; }
  .ba-name:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 2px; border-radius: 4px; }
  .ba-not { display: flex; flex-direction: column; align-items: flex-start; gap: 0.35rem; }
  .ba-go { width: 1%; color: var(--color-text-muted); vertical-align: middle !important; }
  .ba-go-h { width: 1%; }
  .ba-strip { display: flex; gap: 2px; padding: 3px 0 8px; }
  .ba-day { display: block; flex: 0 0 auto; position: relative; width: 4px; height: 16px; border-radius: 2px; background: #ECEBE6; }
  .ba-day--in { background: #D9DADD; }
  .ba-day--1 { background: #B9BABF; }
  .ba-day--2 { background: #77787E; }
  .ba-day--3 { background: var(--color-text); }
  .ba-key { display: flex; flex-wrap: wrap; align-items: center; gap: 0.35rem 1rem; margin: 0; padding: 0.7rem 1.25rem 0.9rem; border-top: 1px solid var(--color-border); font-size: var(--fs-xs); color: var(--color-text-muted); }
  .ba-key__i { display: inline-flex; align-items: center; gap: 0.4rem; }
  .ba-key .ba-strip { padding: 0; }
  .ba-key .ba-day { height: 12px; }
  .ba-key__dot { width: 4px; height: 4px; border-radius: 50%; background: var(--color-text); }
  .ba-day--meeting::after { content: ''; position: absolute; left: 50%; bottom: -6px; width: 4px; height: 4px; margin-left: -2px; border-radius: 50%; background: var(--color-text); }
  .ba-sheet { display: grid; gap: 1.25rem; }
  .ba-facts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0.75rem; }
  .ba-fact { display: grid; align-content: start; gap: 0.15rem; padding: 0.75rem 0.9rem; border: 1px solid var(--color-border); border-radius: 10px; background: var(--color-bg-card); }
  .ba-fact__k { font-size: var(--fs-2xs); letter-spacing: 0.06em; text-transform: uppercase; color: var(--color-text-secondary); }
  .ba-fact__v { font-size: var(--fs-lg); font-weight: 600; color: var(--color-text); }
  .ba-fact__s { font-size: var(--fs-xs); color: var(--color-text-muted); }
  .ba-sheet__ask { margin: -0.25rem 0 0; }
  .ba-coming { margin: -0.2rem 0 0.6rem; font-size: var(--fs-sm); color: var(--color-text-secondary); }
  .ba-sec__h { margin: 0 0 0.6rem; font-size: var(--fs-sm); font-weight: 600; color: var(--color-text); }
  .ba-sign__y { margin: 0.75rem 0 0.35rem; font-size: var(--fs-2xs); font-weight: 700; letter-spacing: 0.08em; color: var(--color-text-secondary); }
  .ba-sign__y:first-of-type { margin-top: 0; }
  .ba-signs { list-style: none; margin: 0; padding: 0; border: 1px solid var(--color-border); border-radius: 10px; }
  .ba-sign { display: grid; grid-template-columns: 0.5rem minmax(0, 1fr) auto; gap: 0.15rem 0.6rem; align-items: center; padding: 0.55rem 0.8rem; border-top: 1px solid var(--color-border); font-size: var(--fs-sm); }
  .ba-sign:first-child { border-top: none; }
  .ba-sign:focus { outline: none; }
  .ba-sign:focus-visible { outline: 2px solid var(--color-focus, currentColor); outline-offset: -2px; }
  .ba-sign__dot { width: 0.5rem; height: 0.5rem; border-radius: 50%; background: var(--color-border-strong); grid-row: 1 / span 2; }
  .ba-sign__dot.is-on { background: var(--tone-success-dot, var(--tone-success-fg)); }
  .ba-sign__name { font-weight: 600; color: var(--color-text); grid-column: 2; }
  .ba-sign__how { color: var(--color-text-secondary); grid-column: 2; overflow-wrap: anywhere; }
  .ba-sign__how a { color: inherit; text-decoration: underline; text-underline-offset: 3px; }
  .ba-sign > .btn { grid-column: 3; grid-row: 1 / span 2; }
  @media (max-width: 560px) { .ba-sign > .btn { grid-column: 2; grid-row: auto; justify-self: start; } }
  .ba-muted { color: var(--color-text-muted); }
  .ba-since { margin: 0.6rem 0 0; font-size: var(--fs-xs); }
  .ba-reads { list-style: none; margin: 0; padding: 0; border: 1px solid var(--color-border); border-radius: 10px; }
  .ba-reads li { display: grid; grid-template-columns: 18px minmax(0, 1fr) auto; gap: 0.6rem; align-items: center; padding: 0.55rem 0.8rem; border-top: 1px solid var(--color-border); font-size: var(--fs-sm); }
  .ba-reads li:first-child { border-top: none; }
  .ba-reads__mark { color: var(--tone-success-fg); display: inline-flex; }
  .ba-reads__name { overflow-wrap: anywhere; }
  .ba-reads__t { color: var(--color-text-secondary); white-space: nowrap; font-size: var(--fs-xs); }
  .ba-reads .is-unread .ba-reads__t { color: var(--color-text-muted); }
  .ba-log { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.6rem; }
  .ba-log__day { margin: 0.6rem 0 0; font-size: var(--fs-2xs); letter-spacing: 0.06em; text-transform: uppercase; color: var(--color-text-secondary); }
  .ba-log__day:first-child { margin-top: 0; }
  .ba-log__day h4 { margin: 0; font: inherit; letter-spacing: inherit; color: inherit; }
  .ba-status { margin: 0; padding: 0.75rem 1.25rem; border-bottom: 1px solid var(--color-border); color: var(--color-text-secondary); font-size: var(--fs-sm); }
  .ba-status .btn { margin-left: 0.4rem; }
  .ba-visit { border: 1px solid var(--color-border); border-radius: 10px; padding: 0.65rem 0.85rem; }
  .ba-sheet .ba-visit__h { display: flex; flex-wrap: wrap; gap: 0.25rem 0.75rem; margin: 0 0 0.45rem; font-size: var(--fs-sm); font-weight: 600; color: var(--color-text); }
  .ba-visit__h .ba-muted { font-weight: 400; }
  .ba-rows { list-style: none; margin: 0; padding: 0; display: grid; gap: 0.3rem; }
  .ba-row { display: grid; grid-template-columns: 16px minmax(0, 1fr) auto; gap: 0.55rem; align-items: start; font-size: var(--fs-sm); color: var(--color-text); }
  .ba-ico { margin-top: 2px; color: var(--color-text-muted); }
  .ba-dialog .kd-dialog__body:focus { outline: none; }
  .ba-dialog .kd-dialog__titles { min-width: 0; }
  .ba-dialog .kd-dialog__titles h2, .ba-dialog .kd-dialog__sub { overflow-wrap: anywhere; }
  .ba-dialog .kd-dialog__body:focus-visible { outline: 2px solid var(--color-primary); outline-offset: -2px; }
  .ba-row--signin .ba-row__t { color: var(--color-text-secondary); }
  .ba-row__t { overflow-wrap: anywhere; }
  .ba-row__s { color: var(--color-text-muted); font-size: var(--fs-xs); white-space: nowrap; padding-top: 1px; }
  /* Narrower than the table needs: each member a block of labelled facts, two across (one on a phone) */
  @container (max-width: 1100px) {
    .ba-table thead { display: none; }
    .ba-table, .ba-table tbody { display: block; }
    .ba-table tr { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.75rem 1.25rem; padding: 0.95rem 1.25rem; border-bottom: 1px solid var(--color-border); }
    .ba-table tr:last-child { border-bottom: none; }
    .ba-table td { display: block; padding: 0; border: none; min-width: 0; }
    .ba-table td:first-child { grid-column: 1 / -1; }
    .ba-table td[data-label]::before { content: attr(data-label); display: block; margin-bottom: 0.15rem; font-size: var(--fs-2xs); letter-spacing: 0.06em; text-transform: uppercase; color: var(--color-text-secondary); }
    .ba-table td.ba-go { display: none; }
  }
  @container (max-width: 520px) {
    .ba-table tr { grid-template-columns: minmax(0, 1fr); gap: 0.6rem; }
    .ba-seg { width: 100%; }
    .ba-seg > button { flex: 1 1 0; justify-content: center; padding-inline: 0.5rem; }
  }
  /* A phone: each choice's count under its name, so all three fit however big the board */
  @container (max-width: 420px) {
    .ba-seg > button { flex-direction: column; gap: 0.15rem; min-width: 0; padding: 0.3rem 0.35rem; }
  }
  @media (max-width: 720px) {
    .ba-facts { grid-template-columns: 1fr; }
    .ba-table td.ba-go { display: none; }
  }
`;
