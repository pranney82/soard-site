/**
 * Board → Members: each board member, when they last signed in to the board
 * page (or the sign-in email to send), and whether they've signed this year's
 * papers every member signs; their row opens those papers year by year. Just
 * that (Peter, Nov 3 2026: "i dont need to see their level of activity, just
 * when they last signed in and if they are current on the board expectation
 * doc").
 *
 * The helpers below (what a member did, by sitting) read the board page's own
 * record of each visit (../../functions/api/_board-activity.js), which the
 * server still keeps; Members no longer shows it.
 */

import { useState, useEffect, useRef } from './vendor.js';
import { html, call, ago, Face, viewerFiles, driveLink, dayOf, signedHow } from './board-ui.js';
import { viewerLink } from './file-viewer.js';
import { meetingName, todayEastern, fileTitle, docsOf, itemFiles, looseFiles } from './board-shared.js';
import { welcomeHad } from './board-shared.js';

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
const dateOnly = (iso) => new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: ET, ...(todayEastern(Date.parse(iso)).slice(0, 4) !== todayEastern().slice(0, 4) ? { year: 'numeric' } : {}) });
const fullTime = (iso) => new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short', timeZone: ET });
// A file looked at this long was read; a flip past it was only opened
const READ_SECS = 15;

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

/** An address that breaks only where it reads well: after the @, before a dot ("pnielsen@" / "tridentconstructiongroup" / ".com") */
const emailParts = (email) => {
  const [name, ...rest] = String(email).split('@');
  return html`${name}@<wbr />${rest.join('@').split('.').map((part, i) => (i ? html`<wbr />.${part}` : part))}`;
};

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

/**
 * One member: when they last signed in (or the sign-in email to send), asking them by email to sign this year's papers
 * while they haven't, then the papers they signed, each year
 */
function MemberSheet({ p, sentAt, onWelcome, working, onClose, signDocs = [], onCopy = null, onAsk = null }) {
  const last = p.lastSeen || null;
  const first = String(p.name).split(/\s+/)[0];
  const due = signDocs.some((d) => !d.signed[p.slug]);
  return html`<${Dialog} title=${p.name} sub=${[p.title && p.title !== 'Board Member' ? p.title : '', p.email].filter(Boolean).join(' · ')} onClose=${onClose}>
    <div class="ba-sheet">
      <div class="ba-facts">
        <div class="ba-fact"><span class="ba-fact__k">Last signed in</span><span class="ba-fact__v">${last ? ago(last) : 'Never'}</span>
          <span class="ba-fact__s">${last ? fullTime(last) : sentAt ? `Sign-in email sent ${dateOnly(sentAt)}` : p.email ? 'No sign-in email yet' : 'No email on file'}</span></div>
      </div>
      ${!last && p.email && onWelcome ? html`<p class="ba-sheet__ask"><button class="btn btn-ghost btn-sm" disabled=${!!working} aria-label=${`${sentAt ? 'Send the sign-in email again' : 'Send the sign-in email'} to ${p.name}`} onClick=${() => onWelcome(p.slug)}>${working === p.slug ? 'Sending…' : sentAt ? 'Send the sign-in email again' : 'Send the sign-in email'}</button></p>` : null}
      ${due && p.email && onAsk ? html`<p class="ba-sheet__ask">${p.asked ? html`<span class="ba-muted">${askedWords(p.asked)}. </span>` : null}<button class="btn btn-ghost btn-sm" disabled=${!!working} onClick=${() => onAsk(p.slug)}>${working === `ask:${p.slug}` ? 'Emailing…' : p.asked ? `Ask ${first} again` : `Ask ${first} to sign`}</button></p>` : null}
      <${SignedEachYear} p=${p} signDocs=${signDocs} onCopy=${onCopy} />
    </div>
  <//>`;
}

/** "Asked Nov 3" / "Asked twice, last Nov 3" */
function askedWords(a) {
  return a.n > 1 ? `Asked ${a.n === 2 ? 'twice' : `${a.n} times`}, last ${dateOnly(a.at)}` : `Asked ${dateOnly(a.at)}`;
}

/**
 * The board, a row each: who they are and the address they sign in with, when they last signed in (or the sign-in
 * email to send), and each paper every member signs, signed for this year or not (with the last year they did).
 * A row opens their papers year by year
 */
let styled = false;
export function BoardActivity({ data, signDocs, ready, working, onWelcome, onCopy = null, onAsk = null, onAskAll = null, onAskPreview = null }) {
  if (!styled && typeof document !== 'undefined') {
    styled = true;
    const el = document.createElement('style');
    el.id = 'ba-styles';
    el.textContent = ACTIVITY_STYLES;
    document.head.appendChild(el);
  }
  const [open, setOpen] = useState(null);
  // Who has had the sign-in email: one rule with Board access and the server's send (board-shared.js welcomeHad)
  const onBoard = data.members.map((x) => x.slug);
  const sent = Object.fromEntries(data.members.map((p) => [p.slug, welcomeHad(data.welcome, p, onBoard)]).filter(([, at]) => at));
  const faces = new Map([...(data.people?.board || [])].map((p) => [p.slug, p]));
  const year = todayEastern().slice(0, 4);
  const current = (p) => signDocs.every((d) => d.signed[p.slug]);
  const done = data.members.filter(current).length;
  // Who an email can ask to sign: not signed, with an email, once the board page's sign-in works (their code has to come)
  const asking = ready && signDocs.length && onAsk;
  const unsigned = data.members.filter((p) => !current(p) && p.email);
  const papersWord = signDocs.length === 1 ? `the ${signDocs[0].title.replace(/^the\s+/i, '')}` : 'the papers to sign';
  const person = open && data.members.find((p) => p.slug === open);
  return html`<div class="card ba-card" style="padding:0">
    <div class="sec-head ba-head"><h3>The board <span class="count">${data.members.length}</span></h3>
      ${signDocs.length && data.members.length ? html`<div class="ba-asks"><span class="sec-head__hint">${done === data.members.length ? `Everyone has signed for ${year}` : `${done} of ${data.members.length} signed for ${year}`}</span>
        ${asking && unsigned.length ? html`<button class="btn btn-ghost btn-sm" disabled=${!!working} onClick=${() => onAskPreview?.()}>${working === 'ask:me' ? 'Sending…' : 'Send it to me'}</button>
          <button class="btn btn-primary btn-sm" disabled=${!!working} onClick=${() => onAskAll?.(unsigned, papersWord)}>${working === 'ask:all' ? 'Emailing…' : unsigned.length === 1 ? `Ask ${unsigned[0].name.split(/\s+/)[0]} to sign` : `Ask the ${unsigned.length} who haven’t signed`}</button>` : null}</div>` : null}</div>
    ${!data.members.length ? html`<div class="empty empty--inline ba-none"><p class="empty__title">Nobody is on the board in People yet</p></div>` : html`<table class="bd-table ba-table">
      <thead><tr><th>Member</th><th>Last signed in</th>${signDocs.map((d) => html`<th key=${d.id}>${d.title}</th>`)}<th class="ba-go-h" aria-hidden="true"></th></tr></thead>
      <tbody>${data.members.map((p) => {
        const last = p.lastSeen || null;
        const openRow = () => setOpen(p.slug);
        return html`<tr key=${p.slug} class="ba-tr" onClick=${(e) => { if (!e.target.closest('button, a')) openRow(); }}>
          <td><span class="ba-who"><${Face} p=${faces.get(p.slug) || p} size=${32} /><span class="ba-who__text"><button type="button" class="ba-name" data-slug=${p.slug} onClick=${openRow}>${p.name}</button>
            <span class="bd-row__meta ba-email">${p.email ? emailParts(p.email) : html`<span class="tag tag--warn">No email on file</span>`}</span></span></span></td>
          <td data-label="Last signed in">${last
            ? html`<span class="ba-line" title=${fullTime(last)}>${ago(last)}</span>`
            : html`<span class="ba-not"><span class="ba-line ba-muted">Never</span>${sent[p.slug] ? html`<span class="bd-row__meta">Sign-in email sent ${dateOnly(sent[p.slug])}</span>` : null}
              ${ready && p.email ? html`<button class="btn btn-ghost btn-sm" disabled=${!!working} aria-label=${`${sent[p.slug] ? 'Send the sign-in email again' : 'Send the sign-in email'} to ${p.name}`} onClick=${() => onWelcome(p.slug)}>${working === p.slug ? 'Sending…' : sent[p.slug] ? 'Send it again' : 'Send the sign-in email'}</button>` : null}</span>`}</td>
          ${signDocs.map((d, k) => {
            const s = d.signed[p.slug];
            const was = !s && d.before?.[p.slug];
            const prior = !s && !was && d.prior?.[p.slug];
            // (asked once for all their papers: said, with its button, under the last one)
            const ask = k === signDocs.length - 1 && !current(p);
            return html`<td key=${d.id} data-label=${d.title}>${s
              ? html`<span class="tag tag--success">Signed</span>${s.how !== 'drive' && s.at ? html`<span class="bd-row__meta">${dayOf(s.at)}</span>` : null}`
              : html`<span class="tag">Not signed</span>${was ? html`<span class="bd-row__meta">Signed the earlier version</span>` : prior ? html`<span class="bd-row__meta">Signed for ${prior.year}</span>` : null}`}
              ${ask && p.asked ? html`<span class="bd-row__meta">${askedWords(p.asked)}</span>` : null}
              ${ask && asking && p.email ? html`<button class="btn btn-ghost btn-sm ba-ask" disabled=${!!working} aria-label=${`${p.asked ? 'Ask again' : 'Ask to sign'}: email ${p.name}`} onClick=${() => onAsk(p.slug)}>${working === `ask:${p.slug}` ? 'Emailing…' : p.asked ? 'Ask again' : 'Ask to sign'}</button>` : null}</td>`;
          })}
          <td class="ba-go" aria-hidden="true"><svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M8 5l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg></td>
        </tr>`;
      })}</tbody>
    </table>`}
    ${person ? html`<${MemberSheet} p=${person} sentAt=${sent[person.slug]} onWelcome=${ready ? onWelcome : null} working=${working} signDocs=${signDocs} onCopy=${onCopy} onAsk=${asking ? onAsk : null} onClose=${() => { const slug = open; setOpen(null); requestAnimationFrame(() => document.querySelector(`.ba-name[data-slug="${CSS.escape(slug)}"]`)?.focus()); }} />` : null}
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
    .ba-table td[data-label="Last signed in"] .bd-row__meta, .ba-table td[data-label="Last signed in"] .btn { white-space: nowrap; }
  }
  .ba-table td[data-label="Last signed in"] > .ba-line { white-space: nowrap; }
  .ba-name { all: unset; cursor: pointer; font-weight: 600; color: var(--color-text); overflow-wrap: anywhere; }
  .ba-name:hover { text-decoration: underline; text-underline-offset: 3px; }
  .ba-name:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 2px; border-radius: 4px; }
  .ba-not { display: flex; flex-direction: column; align-items: flex-start; gap: 0.35rem; }
  .ba-asks { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 0.5rem 0.75rem; }
  .ba-ask { display: block; margin-top: 0.4rem; }
  .ba-go { width: 1%; color: var(--color-text-muted); vertical-align: middle !important; }
  .ba-go-h { width: 1%; }
  .ba-sheet { display: grid; gap: 1.25rem; }
  .ba-facts { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0.75rem; }
  .ba-fact { display: grid; align-content: start; gap: 0.15rem; padding: 0.75rem 0.9rem; border: 1px solid var(--color-border); border-radius: 10px; background: var(--color-bg-card); }
  .ba-fact__k { font-size: var(--fs-2xs); letter-spacing: 0.06em; text-transform: uppercase; color: var(--color-text-secondary); }
  .ba-fact__v { font-size: var(--fs-lg); font-weight: 600; color: var(--color-text); }
  .ba-fact__s { font-size: var(--fs-xs); color: var(--color-text-muted); }
  .ba-sheet__ask { margin: -0.25rem 0 0; }
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
  .ba-dialog .kd-dialog__body:focus { outline: none; }
  .ba-dialog .kd-dialog__titles { min-width: 0; }
  .ba-dialog .kd-dialog__titles h2, .ba-dialog .kd-dialog__sub { overflow-wrap: anywhere; }
  .ba-dialog .kd-dialog__body:focus-visible { outline: 2px solid var(--color-primary); outline-offset: -2px; }
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
  }
  @media (max-width: 720px) {
    .ba-facts { grid-template-columns: 1fr; }
    .ba-table td.ba-go { display: none; }
  }
`;
