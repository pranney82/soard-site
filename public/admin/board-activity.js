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

import { useState, useEffect, useRef, qrcode } from './vendor.js';
import { html, call, ago, Face, viewerFiles, driveLink, dayOf, signedHow } from './board-ui.js';
import { viewerLink } from './file-viewer.js';
import { meetingName, todayEastern, fileTitle, docsOf, itemFiles, looseFiles } from './board-shared.js';
import { welcomeHad, usableEmail } from './board-shared.js';
import { andText } from './board/money.js';

// A held Enter or Space presses a button once, not again with every repeat
const once = (e) => { if (e.repeat && (e.key === 'Enter' || e.key === ' ')) e.preventDefault(); };

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
    case 'family': {
      const [what, who] = String(e.sub || '').split('|');
      const whose = who ? `${who}’s` : 'a family’s';
      return what === 'video' ? { icon: 'video', text: `Watched ${whose} video` } : what === 'photos' ? { icon: 'file', text: `Looked at ${whose} photos` } : { icon: 'file', text: `Read ${whose} application` };
    }
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
function Dialog({ title, sub = '', children, onClose, size = 'lg', first = '.kd-dialog__body', foot = null }) {
  const ref = useRef(null);
  const idRef = useRef(`ba-dlg-${++dlgSeq}`);
  const live = useRef(onClose);
  live.current = onClose;
  const downOn = useRef(false);
  useEffect(() => {
    const prev = document.activeElement;
    document.body.classList.add('modal-open');
    const onKey = (e) => {
      // A question asked over it (ask.js) or a file opened from it has the keys until it closes
      if (document.querySelector('.ask-overlay') || document.querySelector('.fv-host')?.firstElementChild || document.querySelector('.cmd-palette-overlay')) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); live.current(); return; }
      if (e.key !== 'Tab') return;
      const f = [...(ref.current?.querySelectorAll('button:not([disabled]), [href], input:not([disabled]):not([tabindex="-1"]), textarea:not([disabled]), [tabindex="0"]') || [])].filter((el) => el.getClientRects().length);
      if (!f.length) return;
      const at = document.activeElement;
      const inside = ref.current.contains(at);
      // From anywhere inside (a line given focus too), the way round stays in the sheet: past its last stop to its first
      const ahead = f.some((el) => at.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING);
      const behind = f.some((el) => at.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING);
      if (e.shiftKey && (!inside || !behind)) { e.preventDefault(); f[f.length - 1].focus(); } else if (!e.shiftKey && (!inside || !ahead)) { e.preventDefault(); f[0].focus(); }
    };
    window.addEventListener('keydown', onKey, true);
    requestAnimationFrame(() => (ref.current?.querySelector(first) || ref.current)?.focus());
    return () => {
      window.removeEventListener('keydown', onKey, true);
      if (document.querySelectorAll('.modal-overlay').length <= 1) document.body.classList.remove('modal-open');
      if (prev?.isConnected) prev.focus?.();
    };
  }, []);
  // (a press that began inside, a drag out of a box, isn't a click on the backdrop)
  return html`<div class="modal-overlay kd-overlay" onMouseDown=${(e) => { downOn.current = e.target === e.currentTarget; }} onClick=${(e) => { if (e.target === e.currentTarget && downOn.current) onClose(); }}>
    <div class=${`modal kd-dialog kd-dialog--${size} ba-dialog`} role="dialog" aria-modal="true" aria-labelledby=${idRef.current} ref=${ref} tabindex="-1">
      <header class="kd-dialog__head">
        <div class="kd-dialog__titles"><h2 id=${idRef.current}>${title}</h2>${sub ? html`<p class="kd-dialog__sub">${sub}</p>` : null}</div>
        <button type="button" class="kd-x" aria-label="Close" onClick=${onClose}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>
      </header>
      <div class="kd-dialog__body" tabindex="0" role="region" aria-labelledby=${idRef.current}>${children}</div>
      ${foot ? html`<footer class="kd-dialog__foot">${foot}</footer>` : null}
    </div>
  </div>`;
}

// A note to the board keeps its words until it's sent: closing the sheet, another Board tab or a reload loses nothing.
// Each browser tab keeps its own, so two notes can't overwrite each other; a tab that's gone (`closed`, or untouched for
// a day) leaves its note to the next one opened. Once a note is sent it leaves every tab. `unsaved`: one the browser
// wouldn't store, kept for this visit
const DRAFTS = 'board-email-all';
const TAB = 'board-email-all-tab';
let unsaved = null;
const tabId = () => {
  try {
    let id = sessionStorage.getItem(TAB);
    if (!id) { id = Math.random().toString(36).slice(2, 12); sessionStorage.setItem(TAB, id); }
    return id;
  } catch { return 'here'; }
};
const drafts = () => { try { return JSON.parse(localStorage.getItem(DRAFTS) || '{}') || {}; } catch { return {}; } };
const storeDrafts = (all) => { localStorage.setItem(DRAFTS, JSON.stringify(all)); };
const draftOf = () => {
  if (unsaved) return unsaved;
  const all = drafts();
  const gone = ([, x]) => x.closed || Date.now() - Date.parse(x.at) > 24 * 60 * 60 * 1000;
  let d = all[tabId()];
  // (a gone tab's note moves here, so it has one home and clearing or sending it is the end of it)
  const [from, left] = d ? [] : Object.entries(all).filter(gone).sort(([, x], [, y]) => String(y.at).localeCompare(String(x.at)))[0] || [];
  if (from) { d = left; delete all[from]; }
  if (d?.closed || from) {
    all[tabId()] = { subject: d.subject, message: d.message, at: d.at };
    try { storeDrafts(all); } catch { /* it stays where it was */ }
  }
  return { subject: String(d?.subject || ''), message: String(d?.message || '') };
};
// (a reload says this too: the same tab finds its own note first and takes the mark off)
globalThis.addEventListener?.('pagehide', () => {
  const all = drafts();
  if (!all[tabId()]) return;
  all[tabId()].closed = true;
  try { storeDrafts(all); } catch { /* a day's wait instead */ }
});
const keepDraft = (d) => {
  const all = drafts();
  if (d.subject || d.message) all[tabId()] = { ...d, at: new Date().toISOString() }; else delete all[tabId()];
  try { storeDrafts(all); unsaved = null; } catch { unsaved = d; }
};
const dropDraft = (d) => {
  unsaved = null;
  const all = drafts();
  for (const [id, x] of Object.entries(all)) if (x.subject === d.subject && x.message === d.message) delete all[id];
  try { storeDrafts(all); } catch { /* nothing kept to clear */ }
};
// As the server allows (../../functions/api/_board-email-all.js)
const SUBJECT_MAX = 200;
const MESSAGE_MAX = 20000;
// (a mail link that long may not open: past this the mail app gets the subject and the addresses)
const MAILTO_MAX = 1800;
/** A mail link to these addresses, with the words typed so far when they fit */
export function mailLink(emails, { subject = '', message = '' } = {}) {
  const to = `mailto:${emails.join(',')}`;
  const titled = subject.trim() ? `${to}?subject=${encodeURIComponent(subject.trim())}` : to;
  const withSubject = titled.length <= MAILTO_MAX ? titled : to;
  if (!message.trim()) return withSubject;
  const whole = `${withSubject}${withSubject === to ? '?' : '&'}body=${encodeURIComponent(message.trim())}`;
  return whole.length <= MAILTO_MAX ? whole : withSubject;
}
// Characters that show nothing: a subject or message of only these is empty
const seen = (s) => s.replace(/[\u200B-\u200D\u2060\uFEFF]/g, '').trim();
const howMany = (n, one) => `${n.toLocaleString()} ${one}${n === 1 ? '' : 's'}`;

/** Email all: the note written here and sent from the writer's own Gmail (../../functions/api/_board-email-all.js) */
function EmailAll({ data, onSay, onClose }) {
  const me = String(data.me || '').toLowerCase();
  const to = (data.group?.everyone || []).filter((p) => p.email !== me).sort((a, b) => a.name.localeCompare(b.name));
  const left = (data.group?.missing || []).map((p) => p.name);
  const emails = to.map((p) => p.email);
  const [d, setD] = useState(draftOf);
  const [busy, setBusy] = useState('');
  // The one line above the buttons, where it can't fall below the fold: what went wrong, or that the test went
  const [line, setLine] = useState(null);
  const change = (k, v) => { const next = { ...d, [k]: v }; setD(next); keepDraft(next); setLine(null); };
  const subjectOver = d.subject.trim().length - SUBJECT_MAX;
  const messageOver = d.message.trim().length - MESSAGE_MAX;
  const tooLong = subjectOver > 0 ? `The subject is ${howMany(subjectOver, 'character')} too long.`
    : messageOver > 0 ? `This is ${howMany(messageOver, 'character')} too long to send from here. Open it in your mail app instead.` : '';
  const can = !!seen(d.subject) && !!seen(d.message) && !tooLong;
  // (pressed, then the page moved on: what comes back is still said)
  const here = useRef(true);
  useEffect(() => { here.current = true; return () => { here.current = false; }; }, []);
  const say = (x) => { if (here.current) setLine(x); else onSay(x.text, x.bad ? 'error' : 'info'); };
  const send = async (test) => {
    if (busy || !can || (!test && !to.length)) return;
    setBusy(test ? 'test' : 'all');
    setLine(null);
    const j = await call({ action: 'email-all', subject: d.subject, message: d.message, ...(test ? { test: true } : {}) });
    setBusy('');
    if (!j.ok) {
      // No words from the server (no connection, a bad gateway): it may have gone. Pressing Send again checks first
      const unknown = !j.status || j.unknown || /^HTTP \d+$/.test(j.error || '');
      say({ bad: true, text: !unknown ? j.error || 'That didn’t send. Try again.'
        : test ? 'The connection dropped, so this page can’t tell whether the test went. Look in your inbox. Nothing went to the board.'
          : 'The connection dropped, so this page can’t tell whether it went. Press Send again and the site will check first. If this keeps happening, copy your words and reload the page.' });
      return;
    }
    if (test) { say({ text: `Sent to you at ${me}. Nothing went to the board.` }); return; }
    dropDraft(d);
    onSay(j.already ? `That note already went to the board ${ago(j.at)}, so it wasn’t sent twice.` : `Sent to ${j.sent === 1 ? to[0]?.name || '1 person' : `all ${j.sent}`}. It’s in your Sent folder.`, 'info');
    onClose();
  };
  const copyOut = async (words, said, sorry) => {
    try { await navigator.clipboard.writeText(words); say({ text: said }); } catch { say({ bad: true, text: sorry }); }
  };
  // Too long for a mail link: the link opens with the addresses and subject, and the message comes by the clipboard
  const link = mailLink(emails, d);
  const leftBehind = [!link.includes('subject=') && d.subject.trim(), !link.includes('body=') && d.message.trim()].filter(Boolean).join('\n\n');
  // (what a press just did comes first; a change to the words clears it)
  const says = line || (tooLong ? { bad: true, text: tooLong } : null);
  const pressed = (name) => (busy === name ? 'true' : null);
  return html`<${Dialog} title="Email the board" sub=${`From your Gmail, ${me}`} size="md" first=${d.subject.trim() ? '#ba-mail-message' : '#ba-mail-subject'} onClose=${() => { if (!busy) onClose(); }}
    foot=${html`${says ? html`<p key=${says.text} class=${`ba-mail__line ${says.bad ? 'form-error' : 'form-hint'}`} role=${says.bad ? 'alert' : 'status'}>${says.text}</p>` : null}
      <button type="button" class="btn btn-ghost" disabled=${!can} aria-disabled=${pressed('all')} onKeyDown=${once} onClick=${() => send(true)}>${busy === 'test' ? 'Sending…' : 'Send it to me'}</button>
      <button type="button" class="btn btn-primary" disabled=${!can || !to.length} aria-disabled=${pressed('test')} onKeyDown=${once} onClick=${() => send(false)}>${busy === 'all' ? 'Sending…' : !to.length ? 'Send' : to.length === 1 ? `Send to ${to[0].name.split(/\s+/)[0]}` : `Send to all ${to.length}`}</button>`}>
    <div class="ba-mail">
      <dl class="ba-mail__to"><dt>To</dt><dd>${to.length ? andText(to.map((p) => p.name)) : 'Nobody else on the board has an email on file.'}</dd></dl>
      ${left.length ? html`<p class="ba-mail__left"><span class="tag tag--warn">No email on file</span> ${andText(left)} won’t get this.</p>` : null}
      <div class="form-group"><label class="form-label" for="ba-mail-subject">Subject</label>
        <input id="ba-mail-subject" class="form-input" autocomplete="off" value=${d.subject} readonly=${!!busy} aria-invalid=${subjectOver > 0 ? 'true' : null} onKeyDown=${once} onInput=${(e) => change('subject', e.target.value)} /></div>
      <div class="form-group"><label class="form-label" for="ba-mail-message">Message</label>
        <textarea id="ba-mail-message" class="form-textarea ba-mail__words" rows="9" value=${d.message} readonly=${!!busy} aria-invalid=${messageOver > 0 ? 'true' : null} onKeyDown=${once} onInput=${(e) => change('message', e.target.value)}></textarea></div>
      ${emails.length ? html`<p class="form-hint ba-mail__alt">Need to attach a file? <a class="link" href=${link} onClick=${() => { if (leftBehind) copyOut(leftBehind, 'Your words are copied. Paste them into the email.', 'Those words are too long to carry over. Copy them from here into the email.'); }}>Open it in your mail app</a> or <button type="button" class="ba-mail__copy" onClick=${() => copyOut(emails.join(', '), `Copied ${emails.length === 1 ? 'the address' : `${emails.length} addresses`}`, 'Couldn’t copy them here. Open it in your mail app instead.')}>copy the addresses</button>.</p>` : null}
    </div>
  <//>`;
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
  const see = (s, title) => html`${s?.copy ? html` · <a ...${viewerLink(viewerFiles([{ ...s.copy, name: `${title}, signed by ${p.name}` }]), 0)}>See it</a>`
    : s?.drive ? html` · <a href=${driveLink(s.drive.id)} target="_blank" rel="noopener">Open it in Drive</a>` : null}${s?.record?.id ? html` · <a ...${viewerLink(viewerFiles([{ id: s.record.id, name: `${title}, signed by ${p.name}.pdf`, type: 'application/pdf' }]), 0)}>Signed copy (PDF)</a>` : null}`;
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
            <span class="ba-sign__how">${s ? signedHow(s) : d.declined?.[p.slug] ? html`Declined on ${dayOf(d.declined[p.slug].at)}: <q class="ba-why">${d.declined[p.slug].reason}</q>` : was ? `Signed the earlier version on ${dayOf(was.at)}, not the new one yet` : 'Not signed yet'}${see(s || was, d.title)}</span>
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
 * Signing in person (at a meeting, say): a code their own phone's camera opens, straight to the paper (or to
 * Documents, with more than one). They sign in with their own email's code and sign it themselves: nobody signs
 * for them (an admin's copy of a paper they signed is the other way)
 */
function InPerson({ p, papers }) {
  const [shown, setShown] = useState(false);
  if (!papers.length) return null;
  const first = String(p.name).split(/\s+/)[0];
  const url = `${location.origin}/board/${papers.length === 1 ? papers[0].id : 'documents'}`;
  let svg = '';
  if (shown) {
    try { const q = qrcode(0, 'M'); q.addData(url); q.make(); svg = q.createSvgTag({ cellSize: 6, margin: 2, scalable: true }); } catch { svg = ''; }
  }
  return html`<div class="ba-inperson">
    <p class="ba-sheet__ask"><button type="button" class="btn btn-ghost btn-sm" aria-expanded=${shown ? 'true' : 'false'} onClick=${() => setShown(!shown)}>${shown ? 'Hide the code' : 'Sign in person'}</button></p>
    ${shown ? html`<div class="ba-qr">
      <div class="ba-qr__code" role="img" aria-label=${`A code for ${first}’s phone camera, opening ${url}`} dangerouslySetInnerHTML=${{ __html: svg }}></div>
      <div class="ba-qr__text">
        <p><strong>${first} points their phone’s camera at this</strong> and opens the link: ${papers.length === 1 ? `the ${papers[0].title}` : 'their papers to sign'}, on the board page.</p>
        <p class="ba-muted">The board page emails ${first} a code at ${p.email} to sign in, so it’s their own phone and their own signature. Nobody can sign it for them.</p>
        <p class="ba-muted ba-qr__url">${url}</p>
      </div>
    </div>` : null}
  </div>`;
}

/**
 * One member: when they last signed in (or the sign-in email to send), asking them by email to sign this year's papers
 * while they haven't, then the papers they signed, each year
 */
function MemberSheet({ p, sentAt, going = false, unconfirmed = false, tooSoon = false, held = false, onWelcome, working, onClose, signDocs = [], onCopy = null, onAsk = null }) {
  const last = p.lastSeen || null;
  const first = String(p.name).split(/\s+/)[0];
  const due = signDocs.some((d) => !d.signed[p.slug]);
  return html`<${Dialog} title=${p.name} sub=${[p.title && p.title !== 'Board Member' ? p.title : '', p.email].filter(Boolean).join(' · ')} onClose=${onClose}>
    <div class="ba-sheet">
      <div class="ba-facts">
        <div class="ba-fact ba-fact--in" tabindex="-1"><span class="ba-fact__k">Last signed in</span><span class="ba-fact__v">${last ? ago(last) : 'Never'}</span>
          <span class="ba-fact__s">${last ? fullTime(last) : going ? 'Sign-in email going out now' : sentAt ? `Sign-in email sent ${dateOnly(sentAt)}${unconfirmed ? ' (not confirmed)' : ''}` : !p.email ? 'No email on file' : usableEmail(p.email) ? 'No sign-in email yet' : 'The email on People → Board isn’t a whole address'}</span></div>
      </div>
      ${!last && usableEmail(p.email) && onWelcome && !going && !tooSoon ? html`<p class="ba-sheet__ask"><button class="btn btn-ghost btn-sm" aria-disabled=${held ? 'true' : null} onKeyDown=${once} onClick=${() => { if (!held) onWelcome(p.slug); }}>${working === p.slug ? 'Sending…' : sentAt ? 'Send the sign-in email again' : 'Send the sign-in email'}</button></p>` : null}
      ${due && p.email && onAsk ? html`<p class="ba-sheet__ask">${p.asked ? html`<span class="ba-muted">${askedWords(p.asked)}. </span>` : null}<button class="btn btn-ghost btn-sm" disabled=${!!working} onClick=${() => onAsk(p.slug)}>${working === `ask:${p.slug}` ? 'Emailing…' : p.asked ? `Ask ${first} again` : `Ask ${first} to sign`}</button></p>` : null}
      ${due && p.email ? html`<${InPerson} p=${p} papers=${signDocs.filter((d) => !d.signed[p.slug])} />` : null}
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
export function BoardActivity({ data, signDocs, ready, working, now = Date.now(), onWelcome, onSay = () => {}, onCopy = null, onAsk = null, onAskAll = null, onAskPreview = null, onRemind = null }) {
  if (!styled && typeof document !== 'undefined') {
    styled = true;
    const el = document.createElement('style');
    el.id = 'ba-styles';
    el.textContent = ACTIVITY_STYLES;
    document.head.appendChild(el);
  }
  const [open, setOpen] = useState(null);
  const [writing, setWriting] = useState(false);
  // Who has had the sign-in email: one rule with Board access and the server's send (board-shared.js welcomeHad)
  const onBoard = data.members.map((x) => x.slug);
  const sent = Object.fromEntries(data.members.map((p) => [p.slug, welcomeHad(data.welcome, p, onBoard)]).filter(([, at]) => at));
  // A send going out to them now, and one Resend didn't confirm (as Board access says)
  const unconfirmed = data.welcome?.unconfirmed || [];
  const going = (p) => !!data.welcomeSending && (data.welcomeSendingTo || []).includes(p.slug);
  // "Send it again" only once it would send (the server skips anyone emailed in the last ten minutes), on Board access's clock
  const tooSoon = (p) => !!sent[p.slug] && now - Date.parse(sent[p.slug]) < 10 * 60 * 1000;
  // Every sign-in email button is held while any send is going out (this page's, another tab's, or one from before
  // switching Board tabs)
  const held = !!working || !!data.welcomeSending;
  // The button can go while it's sent ("Going out now") or after (held ten minutes): focus moves to the member's name, or
  // the sheet's Last signed in line, never the page
  const pressed = useRef(null);
  const refocus = (slug) => {
    const el = document.activeElement;
    if (el && el !== document.body && el.isConnected) return;
    (document.querySelector('.ba-sheet .ba-fact--in') || document.querySelector(`.ba-name[data-slug="${CSS.escape(slug)}"]`))?.focus();
  };
  // ...and when a fresh look takes away a button that had focus (another admin's send), the same
  const lastIn = useRef(null);
  const onFocusIn = (e) => {
    const tr = e.target.closest?.('.ba-tr');
    const slug = tr ? tr.querySelector('.ba-name')?.dataset.slug : e.target.closest?.('.ba-sheet') ? open : null;
    lastIn.current = slug ? { el: e.target, slug } : null;
  };
  // (focus taken elsewhere on purpose, the control still there, is forgotten: only a control taken away brings it back)
  const onFocusOut = (e) => {
    const el = e.target;
    requestAnimationFrame(() => {
      if (lastIn.current?.el === el && el.isConnected) lastIn.current = null;
      if (pressed.current?.el === el && el.isConnected && document.activeElement !== el) pressed.current = null;
    });
  };
  useEffect(() => {
    const l = lastIn.current;
    // (once: the name or line it went to is then the one followed, so a click elsewhere after keeps its place)
    if (pressed.current && !pressed.current.el?.isConnected) { refocus(pressed.current.slug); pressed.current = { ...pressed.current, el: document.activeElement }; }
    else if (l && !l.el.isConnected) refocus(l.slug);
  });
  const sendTo = async (slug) => {
    // (the button pressed: focus taken off it on purpose meanwhile, a click elsewhere, stays where it went)
    pressed.current = { slug, el: document.activeElement };
    try { await onWelcome(slug); } finally {
      requestAnimationFrame(() => { if (pressed.current) refocus(pressed.current.slug); pressed.current = null; });
    }
  };
  const faces = new Map([...(data.people?.board || [])].map((p) => [p.slug, p]));
  const year = todayEastern().slice(0, 4);
  const current = (p) => signDocs.every((d) => d.signed[p.slug]);
  const done = data.members.filter(current).length;
  // Who an email can ask to sign: not signed, with an email, once the board page's sign-in works (their code has to come)
  const asking = ready && signDocs.length && onAsk;
  const unsigned = data.members.filter((p) => !current(p) && p.email && signDocs.some((d) => !d.signed[p.slug] && !d.declined?.[p.slug]));
  const papersWord = signDocs.length === 1 ? `the ${signDocs[0].title.replace(/^the\s+/i, '')}` : 'the papers to sign';
  const person = open && data.members.find((p) => p.slug === open);
  return html`<div class="card ba-card" style="padding:0" onFocusIn=${onFocusIn} onFocusOut=${onFocusOut}>
    <div class="sec-head ba-head"><div class="ba-title"><h3>The board <span class="count">${data.members.length}</span></h3>
      ${data.members.length && data.group?.everyone ? html`<button type="button" class="btn btn-ghost btn-sm" onKeyDown=${once} onClick=${() => setWriting(true)}>Email all</button>` : null}</div>
      ${signDocs.length && data.members.length ? html`<div class="ba-asks"><span class="sec-head__hint">${done === data.members.length ? `Everyone has signed for ${year}` : `${done} of ${data.members.length} signed for ${year}`}</span>
        ${asking && unsigned.length ? html`<button class="btn btn-ghost btn-sm" disabled=${!!working} onClick=${() => onAskPreview?.()}>${working === 'ask:me' ? 'Sending…' : 'Send it to me'}</button>
          <button class="btn btn-primary btn-sm" disabled=${!!working} onClick=${() => onAskAll?.(unsigned, papersWord)}>${working === 'ask:all' ? 'Emailing…' : unsigned.length === 1 ? `Ask ${unsigned[0].name.split(/\s+/)[0]} to sign` : `Ask the ${unsigned.length} who haven’t signed`}</button>` : null}
        ${asking && onRemind ? html`<label class="ba-remind"><span>Remind by email</span><select class="form-select" value=${data.settings?.remind || 'off'} aria-busy=${working === 'remind' ? 'true' : null} onChange=${(e) => onRemind(e.target.value, e.target)}>
          <option value="off">Off</option><option value="3">Every 3 days</option><option value="7">Weekly</option></select></label>` : null}</div>` : null}</div>
    ${!data.members.length ? html`<div class="empty empty--inline ba-none"><p class="empty__title">Nobody is on the board in People yet</p></div>` : html`<table class="bd-table ba-table">
      <thead><tr><th>Member</th><th>Last signed in</th>${signDocs.map((d) => html`<th key=${d.id}>${d.title}</th>`)}<th class="ba-go-h" aria-hidden="true"></th></tr></thead>
      <tbody>${data.members.map((p) => {
        const last = p.lastSeen || null;
        const openRow = () => setOpen(p.slug);
        return html`<tr key=${p.slug} class="ba-tr" onClick=${(e) => { if (!e.target.closest('button, a')) openRow(); }}>
          <td><span class="ba-who"><${Face} p=${faces.get(p.slug) || p} size=${32} /><span class="ba-who__text"><button type="button" class="ba-name" data-slug=${p.slug} onKeyDown=${once} onClick=${openRow}>${p.name}</button>
            <span class="bd-row__meta ba-email">${p.email ? html`${emailParts(p.email)}${usableEmail(p.email) ? null : html` <span class="tag tag--warn">Not a whole address</span>`}` : html`<span class="tag tag--warn">No email on file</span>`}</span></span></span></td>
          <td data-label="Last signed in">${last
            ? html`<span class="ba-line" title=${fullTime(last)}>${ago(last)}</span>`
            : html`<span class="ba-not"><span class="ba-line ba-muted">Never</span>${going(p) ? html`<span class="bd-row__meta">Sign-in email going out now</span>` : sent[p.slug] ? html`<span class="bd-row__meta">Sign-in email sent ${dateOnly(sent[p.slug])}${unconfirmed.includes(p.slug) ? ' (not confirmed)' : ''}</span>` : null}
              ${ready && usableEmail(p.email) && !going(p) && !tooSoon(p) ? html`<button class="btn btn-ghost btn-sm" aria-disabled=${held ? 'true' : null} aria-label=${`${working === p.slug ? 'Sending…' : sent[p.slug] ? 'Send it again' : 'Send the sign-in email'}, ${p.name}`} onKeyDown=${once} onClick=${() => { if (!held) sendTo(p.slug); }}>${working === p.slug ? 'Sending…' : sent[p.slug] ? 'Send it again' : 'Send the sign-in email'}</button>` : null}</span>`}</td>
          ${signDocs.map((d, k) => {
            const s = d.signed[p.slug];
            const was = !s && d.before?.[p.slug];
            const prior = !s && !was && d.prior?.[p.slug];
            // (asked once for all their papers: said, with its button, under the last one)
            const ask = k === signDocs.length - 1 && !current(p);
            return html`<td key=${d.id} data-label=${d.title}>${s
              ? html`<span class="tag tag--success">Signed</span>${s.how !== 'drive' && s.at ? html`<span class="bd-row__meta">${dayOf(s.at)}</span>` : null}`
              : d.declined?.[p.slug] ? html`<span class="tag tag--warn">Declined</span><span class="bd-row__meta" title=${d.declined[p.slug].reason}>${dayOf(d.declined[p.slug].at)}</span>`
              : html`<span class="tag">Not signed</span>${was ? html`<span class="bd-row__meta">Signed the earlier version</span>` : prior ? html`<span class="bd-row__meta">Signed for ${prior.year}</span>` : null}`}
              ${ask && p.asked ? html`<span class="bd-row__meta">${askedWords(p.asked)}</span>` : null}
              ${ask && asking && p.email ? html`<button class="btn btn-ghost btn-sm ba-ask" disabled=${!!working} aria-label=${`${p.asked ? 'Ask again' : 'Ask to sign'}: email ${p.name}`} onClick=${() => onAsk(p.slug)}>${working === `ask:${p.slug}` ? 'Emailing…' : p.asked ? 'Ask again' : 'Ask to sign'}</button>` : null}</td>`;
          })}
          <td class="ba-go" aria-hidden="true"><svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path d="M8 5l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" /></svg></td>
        </tr>`;
      })}</tbody>
    </table>`}
    ${writing ? html`<${EmailAll} data=${data} onSay=${onSay} onClose=${() => setWriting(false)} />` : null}
    ${person ? html`<${MemberSheet} p=${person} sentAt=${sent[person.slug]} going=${going(person)} unconfirmed=${unconfirmed.includes(person.slug)} tooSoon=${tooSoon(person)} held=${held} onWelcome=${ready ? sendTo : null} working=${working} signDocs=${signDocs} onCopy=${onCopy} onAsk=${asking ? onAsk : null} onClose=${() => { const slug = open; setOpen(null); requestAnimationFrame(() => document.querySelector(`.ba-name[data-slug="${CSS.escape(slug)}"]`)?.focus()); }} />` : null}
  </div>`;
}

export const ACTIVITY_STYLES = `
  .ba-card { container-type: inline-size; }
  .ba-head { flex-wrap: wrap; gap: 0.75rem; }
  .ba-title { display: flex; align-items: center; gap: 0.75rem; }
  .ba-mail { display: grid; gap: 0.9rem; }
  .ba-mail .form-group { margin: 0; }
  .ba-mail__to { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 0.75rem; margin: 0; padding-bottom: 0.9rem; border-bottom: 1px solid var(--color-border); font-size: var(--fs-sm); line-height: 1.5; }
  .ba-mail__to dt { color: var(--color-text-secondary); }
  .ba-mail__to dd { margin: 0; color: var(--color-text); }
  .ba-mail__left { margin: -0.3rem 0 0; font-size: var(--fs-sm); line-height: 1.5; color: var(--color-text-secondary); }
  .ba-mail__words { resize: vertical; min-height: 11rem; }
  .ba-mail__line { flex-basis: 100%; margin: 0; font-size: var(--fs-sm); line-height: 1.45; text-align: right; }
  .ba-mail__alt { margin: 0; }
  .ba-mail__copy { all: unset; cursor: pointer; text-decoration: underline; text-underline-offset: 2px; }
  .ba-mail__copy:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 2px; border-radius: 3px; }
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
  .ba-fact--in:focus { outline: none; }
  .ba-fact--in:focus-visible { outline: 2px solid var(--color-primary); outline-offset: 2px; }
  .ba-not { display: flex; flex-direction: column; align-items: flex-start; gap: 0.35rem; }
  .ba-asks { display: flex; flex-wrap: wrap; align-items: center; justify-content: flex-end; gap: 0.5rem 0.75rem; }
  .ba-remind { display: inline-flex; align-items: center; gap: 0.5rem; font-size: var(--fs-sm); color: var(--color-text-secondary); white-space: nowrap; }
  .ba-remind .form-select { width: auto; min-height: 36px; padding-block: 0.3rem; }
  .ba-why { font-style: italic; color: var(--color-text); }
  .ba-qr { display: flex; flex-wrap: wrap; gap: 1rem 1.25rem; align-items: flex-start; margin: 0.5rem 0 0.75rem; padding: 1rem; border: 1px solid var(--color-border); border-radius: 12px; background: var(--color-surface, #fff); }
  .ba-qr__code { flex: none; width: 168px; height: 168px; background: #fff; }
  .ba-qr__code svg { display: block; width: 100%; height: 100%; }
  .ba-qr__text { flex: 1 1 16rem; min-width: 0; }
  .ba-qr__text p { margin: 0 0 0.5rem; line-height: 1.45; }
  .ba-qr__url { font-size: var(--fs-xs); overflow-wrap: anywhere; }
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
