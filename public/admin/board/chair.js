/**
 * chair.js — the chair's review of the agenda ahead
 * ===========================================================================
 * The page the board chair's review email links to (#/meetings/<id>/review): the whole agenda of the meeting ahead,
 * before the board sees it, part by part with its planned times; each item with who presents it, whether its report
 * is in (or late), the report itself and its documents. The chair approves the agenda with one button, keeps their
 * own notes on any item (theirs and the founders' only), and sends a report back to who presents it with a question,
 * emailed from the founders' address; the answer comes back under the report.
 *
 * Its data is the board page's `review` (functions/api/_board-asks.js reviewFor): the chair by seat and Board's
 * admins, within two weeks of the meeting once its agenda is real. The actions are /api/board-portal's 'chair-approve',
 * 'chair-note' and 'ask-presenter'.
 *
 *   ChairReview    the page (portal.js passes the pieces it draws with: Icon, Presenters, DocTiles, NotFound)
 *   reviewTodo     the chair's "Review the agenda" row on Home's For you, or null
 *   ChairNoteLine  the chair's own note under an item on the meeting's page
 */

import { h, htm, useState, useEffect, useRef } from '../vendor.js';
import { meetingName, longDate, timeRange, clock, presentersOf, sectionPlan, agendaItems, itemFiles, reportsOn } from '../board-shared.js';
import { Report } from '../board-report.js';
import { dueText } from './review.js';

const html = htm.bind(h);
const API = '/api/board-portal';
const ET = 'America/New_York';

const first = (name) => String(name || '').trim().split(/\s+/)[0] || '';
/** "Peter", "Peter and Holly", "Peter, Holly and Alex" */
const andNames = (list) => (list.length > 2 ? `${list.slice(0, -1).join(', ')} and ${list.at(-1)}` : list.join(' and '));
/** "Nov 4" (Atlanta's day) */
const dayShort = (iso) => { const t = Date.parse(iso || ''); return Number.isFinite(t) ? new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: ET }) : ''; };
/** "Thursday" for a meeting's YYYY-MM-DD */
const weekday = (d) => (d ? new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'long', timeZone: 'UTC' }) : '');

async function post(body) {
  try {
    const r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({ ok: false, error: /cloudflareaccess/i.test(r.url || '') ? 'Your sign-in expired. Reload the page to sign in again.' : `Something went wrong (${r.status})` }));
    if (!r.ok && j.ok !== false) j.ok = false;
    j.status = r.status;
    return j;
  } catch {
    return { ok: false, error: 'No connection. Check your internet and try again.' };
  }
}

/** A box that takes the caret the moment it's there (a ref, not an effect: an effect runs a frame late, after the first keys) */
const focusOnce = (ref) => (el) => { ref.current = el; if (el && !el.dataset.focused) { el.dataset.focused = '1'; el.focus({ preventScroll: true }); el.setSelectionRange(el.value.length, el.value.length); } };

/** The page's data with the review changed */
const withReview = (data, patch) => ({ ...data, review: data.review ? { ...data.review, ...patch } : data.review });

/** Who I am here: a board member, or the admin looking (their staff record) */
const meOf = (data, d) => d.me || (data.me.as ? d.bySlug.get(data.me.as) : null) || null;
/** The chair, by seat */
const chairOf = (d) => d.people.find((p) => p.group === 'board' && p.seat === 'chair') || null;

/** An item's report: in (the report itself is the truth), late (was due), due, or nothing asked → { tone, text } | null */
export function reportState(it, reports = []) {
  const asks = reports.filter((r) => r.itemId === it.id);
  if (it.report) return { tone: 'ok', text: 'Report in' };
  const late = asks.find((a) => a.status === 'late');
  if (late) return { tone: 'warn', text: `Late, was due ${dueText(late.due)}` };
  const asked = asks.find((a) => a.status === 'asked' && a.due);
  if (asked) return { tone: '', text: `Due ${dueText(asked.due)}` };
  return null;
}

/** "Reports 3 of 4 in" and who's late, by the items board members were asked about → { line, late: [{ name, title }] } | null */
export function reportsLine(m, reports = []) {
  const items = m.sections.flatMap((s) => s.items);
  const ids = [...new Set(reports.map((r) => r.itemId))].filter((id) => items.some((it) => it.id === id));
  if (!ids.length) return null;
  const inNow = ids.filter((id) => items.find((it) => it.id === id).report).length;
  const late = reports.filter((r) => r.status === 'late' && !items.find((it) => it.id === r.itemId)?.report)
    .map((r) => ({ name: r.name, title: items.find((it) => it.id === r.itemId)?.title || '' }));
  return { line: `Reports ${inNow} of ${ids.length} in`, late };
}

/** Home's For you: the chair's agenda to review, until it's approved (the chair only: the founders have Board) */
export function reviewTodo(data, d) {
  const r = data.review;
  if (!r?.meeting || r.approvedAt || data.me.admin || d.me?.seat !== 'chair') return null;
  const m = r.meeting;
  return {
    href: `#/meetings/${encodeURIComponent(m.id)}/review`,
    title: `Review the agenda for ${weekday(m.date)}`,
    meta: `The ${meetingName(m)}, ${new Date(`${m.date}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}`,
  };
}

/** The chair's own note under an item on the meeting's page (the chair and the founders see these) */
export function ChairNoteLine({ data, d, m, it }) {
  const r = data.review;
  const note = r?.meeting?.id === m.id ? r.notes?.[it.id] : null;
  if (!note?.text) return null;
  const me = meOf(data, d);
  const mine = !note.by || (me && note.by === me.name);
  return html`<p class="cr-mine"><a class="cr-mine__label" href=${`#/meetings/${encodeURIComponent(m.id)}/review`}>${mine ? 'Your note' : `${first(note.by)}’s note`}</a><span class="cr-mine__text">${note.text}</span></p>`;
}

/** The chair's own note on one item: saved a moment after they stop typing, when the box loses focus and when the page goes */
function NoteBox({ meetingId, itemId, title, note, who, onSaved }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(note?.text || '');
  const [st, setSt] = useState('');
  const sent = useRef((note?.text || '').trim());
  const latest = useRef(text);
  latest.current = text;
  const timer = useRef(0);
  const busy = useRef(null);
  const box = useRef(null);
  const body = (words) => ({ action: 'chair-note', meetingId, itemId, text: words });
  const save = async () => {
    clearTimeout(timer.current);
    if (busy.current) await busy.current;
    const words = latest.current.trim();
    if (words === sent.current) { setSt((x) => (x === 'waiting' ? 'saved' : x)); return true; }
    setSt('saving');
    busy.current = post(body(words));
    const j = await busy.current;
    busy.current = null;
    if (!j.ok) { setSt(j.error || 'Couldn’t save'); return false; }
    sent.current = words;
    onSaved(j.notes || {});
    if (latest.current.trim() !== words) { setSt('waiting'); timer.current = setTimeout(save, 400); } else setSt('saved');
    return true;
  };
  useEffect(() => {
    const flush = () => {
      const words = latest.current.trim();
      if (words === sent.current) return;
      try { fetch(API, { method: 'POST', keepalive: true, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body(words)) }); } catch { /* the page is going */ }
    };
    addEventListener('pagehide', flush);
    return () => { removeEventListener('pagehide', flush); clearTimeout(timer.current); if (latest.current.trim() !== sent.current) save(); };
  }, []);
  const id = `cr-n-${itemId}`;
  const status = st === 'saving' ? 'Saving…' : st === 'waiting' ? 'Saving in a moment' : st === 'saved' ? (sent.current ? 'Saved' : 'Note taken off') : st
    ? html`<span class="cr-err" role="alert">Not saved: ${st} <button type="button" class="cr-linkbtn" onClick=${save}>Try again</button></span>` : '';
  if (!open) {
    return note?.text
      ? html`<div class="cr-note"><p class="cr-label">Your note</p><p class="cr-note__text">${note.text}</p><button type="button" class="cr-linkbtn" onClick=${() => setOpen(true)}>Change your note</button></div>`
      : html`<button type="button" class="cr-act" onClick=${() => setOpen(true)} aria-expanded="false"><span class="cr-act__plus" aria-hidden="true">+</span>Add a note</button>`;
  }
  return html`<div class="cr-note is-editing">
    <label class="cr-label" for=${id}>Your note on ${title}</label>
    <textarea id=${id} ref=${focusOnce(box)} rows="3" value=${text} placeholder="Something to raise, check or remember at the meeting"
      onInput=${(e) => { setText(e.target.value); latest.current = e.target.value; setSt('waiting'); clearTimeout(timer.current); timer.current = setTimeout(save, 900); }}
      onBlur=${() => save()} onKeyDown=${(e) => { if (e.key === 'Escape') { e.preventDefault(); save().then((ok) => ok && setOpen(false)); } }}></textarea>
    <div class="cr-foot">
      <span class="cr-quiet">${who}</span>
      <span class="cr-foot__end"><span class="cr-st" aria-live="polite">${status}</span><button type="button" class="cr-done" onClick=${() => save().then((ok) => ok && setOpen(false))}>Done</button></span>
    </div>
  </div>`;
}

/** Sending a report back to who presents it with a question, and the questions already sent on this item */
function AskBox({ meetingId, it, to, questions, onSent, say }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [why, setWhy] = useState('');
  const box = useRef(null);
  const names = andNames(to.map((p) => first(p.name)));
  const send = async () => {
    const q = text.trim();
    if (!q || busy) return;
    setBusy(true);
    setWhy('');
    const j = await post({ action: 'ask-presenter', meetingId, itemId: it.id, question: q });
    setBusy(false);
    if (!j.ok) { setWhy(j.error || 'It didn’t send'); return; }
    onSent(j.questions || []);
    setText('');
    setOpen(false);
    say(`Sent to ${names}. Their answer goes under the report.`);
  };
  const sent = questions.filter((q) => q.itemId === it.id);
  const id = `cr-q-${it.id}`;
  return html`<div class="cr-ask">
    ${sent.length ? html`<ul class="cr-qs" aria-label=${`Questions sent on ${it.title}`}>${sent.map((q) => html`<li key=${q.id}>
      <p class="cr-q__text">“${q.text}”</p>
      <p class="cr-q__meta">${`Sent to ${andNames(String(q.to || '').split(/\s*&\s*/).filter(Boolean).map(first)) || names} · ${dayShort(q.at)}`}${q.answeredAt ? html` <span class="bp-chip bp-chip--ok cr-q__chip">Answered</span>` : null}</p>
    </li>`)}</ul>` : null}
    ${open ? html`<div class="cr-askbox">
      <label class="cr-label" for=${id}>A question for ${names}</label>
      <textarea id=${id} ref=${focusOnce(box)} rows="3" value=${text} placeholder=${`What should ${names} clear up in the report?`}
        onInput=${(e) => setText(e.target.value)} onKeyDown=${(e) => { if (e.key === 'Escape') { e.preventDefault(); setOpen(false); } if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') send(); }}></textarea>
      <p class="cr-quiet">It’s emailed to ${names}. Their answer goes under the report, for the whole board.</p>
      ${why ? html`<p class="cr-err" role="alert">${why}</p>` : null}
      <div class="cr-btns">
        <button type="button" class="bp-btn bp-btn--primary bp-btn--sm" disabled=${!text.trim() || busy} onClick=${send}>${busy ? 'Sending…' : `Send to ${names}`}</button>
        <button type="button" class="bp-btn bp-btn--quiet bp-btn--sm" onClick=${() => { setOpen(false); setWhy(''); }}>Cancel</button>
      </div>
    </div>` : html`<button type="button" class="cr-act" aria-expanded="false" onClick=${() => setOpen(true)}><span class="cr-act__plus" aria-hidden="true">?</span>${sent.length ? 'Ask another question' : 'Send back with a question'}</button>`}
  </div>`;
}

/** Approve the agenda, or who approved it and when */
function Approve({ r, ctx, founders }) {
  const { setData, say } = ctx;
  const [busy, setBusy] = useState(false);
  if (r.approvedAt) return html`<p class="cr-approved"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>Approved by ${first(r.approvedBy) || 'the chair'}, ${dueText(r.approvedAt)}</p>`;
  const go = async () => {
    setBusy(true);
    const j = await post({ action: 'chair-approve', meetingId: r.meeting.id });
    setBusy(false);
    if (!j.ok) { say(j.error || 'It wasn’t approved. Try again.', 'warn'); return; }
    setData((dd) => withReview(dd, { approvedAt: j.approvedAt, approvedBy: j.approvedBy }));
    say(`The agenda is approved. ${founders} get word by email.`);
  };
  return html`<button type="button" class=${`bp-btn bp-btn--primary cr-approve ${busy ? 'is-busy' : ''}`} disabled=${busy} onClick=${go}>${busy ? 'Approving…' : 'Approve the agenda'}</button>`;
}

/** One item for the chair: who presents it, its report (or where it stands), its documents, a note, a question */
function ReviewItem({ m, it, label, ctx, ui, r, who }) {
  const { data, d, setData, say } = ctx;
  const { Presenters, DocTiles } = ui;
  const people = presentersOf(it, d.people).map((p) => d.bySlug.get(p.slug) || p);
  const state = reportsOn(it) ? reportState(it, r.reports) : null;
  // A question goes to the board members who present it (never to the one asking: the chair's own item)
  const me = meOf(data, d);
  const askable = people.filter((p) => p.group === 'board' && p.slug && p.slug !== me?.slug);
  const files = itemFiles(m, it, data.meetings);
  return html`<li class="cr-item" id=${`i-${it.id}`}>
    <div class="cr-item__head">
      <span class="cr-item__n" aria-hidden="true">${label}</span>
      <div class="cr-item__titles">
        <h3 class="cr-item__title">${it.title || 'Item'}</h3>
        <div class="cr-item__meta">
          ${state ? html`<span class=${`bp-chip ${state.tone ? `bp-chip--${state.tone}` : ''}`}>${state.text}</span>` : null}
          ${it.confidential ? html`<span class="bp-chip bp-chip--warn">Board only</span>` : null}
        </div>
      </div>
      <${Presenters} people=${people} />
    </div>
    ${it.notes ? html`<div class="cr-item__notes"><${Report} text=${it.notes} clamp=${70} /></div>` : null}
    ${it.report ? html`<section class="cr-report" aria-label=${`The report on ${it.title}`}>
      <p class="cr-report__by"><span class="cr-label">Report</span>${it.reportBy ? html`<span>by ${it.reportBy}${it.reportAt ? `, ${dayShort(it.reportAt)}` : ''}</span>` : null}</p>
      <${Report} text=${it.report} clamp=${140} />
    </section>` : null}
    ${files.length ? html`<div class="cr-item__docs"><${DocTiles} files=${files} /></div>` : null}
    <div class="cr-item__tools">
      <${NoteBox} meetingId=${m.id} itemId=${it.id} title=${it.title || 'this item'} note=${r.notes?.[it.id]} who=${who}
        onSaved=${(notes) => setData((dd) => withReview(dd, { notes }))} />
      ${askable.length ? html`<${AskBox} meetingId=${m.id} it=${it} to=${askable} questions=${r.questions || []} say=${say}
        onSent=${(questions) => setData((dd) => withReview(dd, { questions }))} />` : null}
    </div>
  </li>`;
}

/**
 * The chair's review: the meeting, how many reports are in and who's late, Approve, then the agenda part by part.
 * `ui`: the board page's own pieces (Icon, Presenters, DocTiles, NotFound)
 */
export function ChairReview({ id, ctx, ui }) {
  const { data, d } = ctx;
  const { Icon, NotFound } = ui;
  const r = data.review;
  useEffect(() => { document.title = r?.meeting ? `Review: ${meetingName(r.meeting)} · SOARD Board` : 'Review · SOARD Board'; }, [r?.meeting?.id]);
  if (!r?.meeting || r.meeting.id !== id) {
    if (!data.me.admin && d.me?.seat !== 'chair') return html`<${NotFound} />`;
    return html`<a class="bp-back" href="#/"><${Icon} name="back" size=${18} />Home</a>
      <div class="bp-card bp-empty"><h1 class="bp-h2">This agenda isn’t open for review</h1><p class="bp-muted">The chair’s review opens two weeks before a meeting, once its agenda is written.</p></div>`;
  }
  const m = r.meeting;
  const plan = sectionPlan(m);
  const labels = new Map(agendaItems(m).map((x) => [x.id, x.label]));
  const status = reportsLine(m, r.reports);
  const me = meOf(data, d);
  const chair = chairOf(d);
  // Who reads the chair's notes besides them: the chair and Board's admins, by first name
  const readers = [...new Set([...(chair ? [first(chair.name)] : []), ...(data.admins || []).map(first)])].filter((n) => n && n !== first(me?.name));
  const who = readers.length ? `Only you, ${andNames(readers)} see this.` : 'Only you see this.';
  const founders = andNames((data.admins || []).map(first).filter(Boolean)) || 'SOARD';
  const back = m.shared ? `#/meetings/${encodeURIComponent(m.id)}` : '#/';
  return html`<div class="cr">
    <a class="bp-back" href=${back}><${Icon} name="back" size=${18} />${m.shared ? meetingName(m) : 'Home'}</a>
    <header class="cr-head">
      <p class="bp-eyebrow">The chair’s review${m.shared ? null : html`<span class="bp-chip bp-chip--plain cr-unshared">The board doesn’t see it yet</span>`}</p>
      <h1 class="cr-title">${meetingName(m)}</h1>
      <p class="cr-when">${[longDate(m.date), timeRange(m.start, m.end)].filter(Boolean).join(' · ')}</p>
      ${status ? html`<p class="cr-status"><strong>${status.line}</strong>${status.late.length ? html`<span class="cr-late"> · Late: ${status.late.map((x) => `${x.name}${x.title ? ` (${x.title})` : ''}`).join(', ')}</span>` : null}</p>` : null}
      <div class="cr-head__act"><${Approve} r=${r} ctx=${ctx} founders=${founders} /></div>
    </header>
    <ol class="cr-parts">${m.sections.map((s, si) => {
      const items = s.items.filter((it) => labels.has(it.id));
      const t = plan.get(s.id);
      return html`<li class="cr-part" key=${s.id}>
        <h2 class="cr-part__head"><span class="cr-part__n" aria-hidden="true">${String(si + 1).padStart(2, '0')}</span><span class="cr-part__title">${s.title || 'Agenda'}</span>${t ? html`<span class="cr-part__time">${[t.start ? clock(t.start) : '', `${t.minutes} min`].filter(Boolean).join(' · ')}</span>` : null}</h2>
        ${items.length ? html`<ol class="cr-items">${items.map((it) => html`<${ReviewItem} key=${it.id} m=${m} it=${it} label=${labels.get(it.id)} ctx=${ctx} ui=${ui} r=${r} who=${who} />`)}</ol>`
          : html`<p class="cr-quiet cr-open">Open to the floor.</p>`}
      </li>`;
    })}</ol>
    <footer class="cr-end">
      ${r.approvedAt ? null : html`<${Approve} r=${r} ctx=${ctx} founders=${founders} />`}
      <p class="cr-quiet">Anything else? ${r.sentAt ? `Reply to the review email. It goes to ${founders}.` : html`Email ${data.contact?.email ? html`<a class="bp-link" href=${`mailto:${data.contact.email}`}>${first(data.contact.name) || founders}</a>` : founders}.`}</p>
    </footer>
  </div>`;
}

// ─── Its look (the board page's tokens) ─────────────────────────────

const CSS = `
.cr { max-width: 52rem; margin: 0 auto; }
.cr-head { margin: 0.5rem 0 1.6rem; }
.cr-unshared { margin-left: 0.15rem; letter-spacing: 0; text-transform: none; font-weight: 600; }
.cr-title { margin: 0.25rem 0 0.35rem; font-family: var(--display); font-size: clamp(1.6rem, 4vw, 2.2rem); line-height: 1.2; }
.cr-when { margin: 0; color: var(--ink-2); font-weight: 550; }
.cr-status { margin: 0.55rem 0 0; font-size: 0.95rem; color: var(--ink-2); font-variant-numeric: tabular-nums; }
.cr-late { color: var(--warn); font-weight: 600; }
.cr-head__act { margin-top: 1.1rem; }
.cr-approve { min-width: 14rem; }
.cr-approve.is-busy { cursor: progress; }
.cr-approved { display: inline-flex; align-items: center; gap: 0.5rem; margin: 0; padding: 0.55rem 1rem; border-radius: 999px; background: var(--ok-bg); color: var(--ok); font-weight: 650; }
.cr-parts, .cr-items { list-style: none; margin: 0; padding: 0; }
.cr-part { margin: 0 0 1.9rem; }
.cr-part__head { display: flex; align-items: baseline; gap: 0.75rem; margin: 0 0 0.8rem; padding-bottom: 0.5rem; border-bottom: 2px solid var(--line-2); font-size: 1.12rem; font-family: var(--display); }
.cr-part__n { font-family: var(--body); font-size: 0.8rem; font-weight: 750; color: var(--gold); letter-spacing: 0.04em; }
.cr-part__title { flex: 1; min-width: 0; }
.cr-part__time { font-family: var(--body); font-size: 0.82rem; font-weight: 600; color: var(--muted); white-space: nowrap; font-variant-numeric: tabular-nums; }
.cr-open { margin: 0 0 0 2rem; }
.cr-item { margin: 0 0 0.85rem; padding: 1rem 1.15rem 0.9rem; background: var(--card); border: 1px solid rgba(45, 47, 44, 0.08); border-radius: var(--r); box-shadow: var(--shadow-1); }
.cr-item__head { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 0.5rem 0.9rem; }
.cr-item__n { flex: none; min-width: 2.2rem; padding-top: 0.15rem; font-size: 0.82rem; font-weight: 750; color: var(--gold); font-variant-numeric: tabular-nums; }
.cr-item__titles { flex: 1 1 14rem; min-width: 0; }
.cr-item__title { margin: 0; font-size: 1.05rem; font-weight: 700; line-height: 1.35; overflow-wrap: anywhere; }
.cr-item__meta { display: flex; flex-wrap: wrap; gap: 0.35rem; margin-top: 0.35rem; }
.cr-item__meta:empty { display: none; }
.cr-item__head .bp-pres { margin: 0; }
.cr-item__notes, .cr-report, .cr-item__docs, .cr-item__tools { margin-left: 3.1rem; }
.cr-item__notes { margin-top: 0.55rem; color: var(--ink-2); }
.cr-report { margin-top: 0.75rem; padding: 0.75rem 0.95rem; border-radius: var(--r-sm); background: var(--warm); }
.cr-report__by { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.25rem 0.6rem; margin: 0 0 0.35rem; font-size: 0.82rem; color: var(--muted); }
.cr-item__docs { margin-top: 0.75rem; }
.cr-item__tools { display: grid; gap: 0.55rem; margin-top: 0.75rem; padding-top: 0.65rem; border-top: 1px solid var(--line); }
.cr-item__head + .cr-item__tools { margin-top: 0.55rem; padding-top: 0; border-top: none; }
.cr-label { display: block; margin: 0 0 0.3rem; font-size: 0.72rem; font-weight: 750; letter-spacing: 0.1em; text-transform: uppercase; color: var(--faint); }
.cr-report__by .cr-label { display: inline; margin: 0; }
.cr-act { display: inline-flex; align-items: center; gap: 0.5rem; justify-self: start; min-height: 40px; padding: 0 0.85rem 0 0.4rem; border: 1px dashed var(--line-2); border-radius: 999px; background: none; color: var(--ink-2); font: inherit; font-size: 0.9rem; font-weight: 600; cursor: pointer; transition: border-color 0.2s, background 0.2s, color 0.2s; }
.cr-act:hover { border-style: solid; border-color: var(--ink-2); color: var(--ink); background: var(--card); }
.cr-act__plus { display: inline-grid; place-items: center; width: 26px; height: 26px; border-radius: 50%; background: var(--yellow-soft); color: var(--gold); font-weight: 750; font-size: 0.95rem; }
.cr-note { padding: 0.55rem 0.8rem 0.6rem; border-left: 3px solid var(--yellow); background: var(--yellow-wash); border-radius: 0 10px 10px 0; }
.cr-note__text { margin: 0 0 0.2rem; white-space: pre-wrap; overflow-wrap: anywhere; }
.cr-note textarea, .cr-askbox textarea { display: block; width: 100%; min-height: 4.6em; field-sizing: content; max-height: 18rem; padding: 0.55rem 0.7rem; border: 1px solid var(--line-2); border-radius: 10px; background: var(--card); color: var(--ink); font: inherit; font-size: 0.95rem; line-height: 1.45; resize: vertical; }
.cr-note textarea:focus, .cr-askbox textarea:focus { outline: none; border-color: var(--ink); box-shadow: 0 0 0 3px var(--yellow-soft); }
.cr-foot { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.35rem 1rem; margin-top: 0.45rem; font-size: 0.82rem; color: var(--muted); }
.cr-foot__end { display: inline-flex; align-items: center; gap: 0.9rem; margin-left: auto; }
.cr-quiet { margin: 0; color: var(--muted); font-size: 0.85rem; }
.cr-err { margin: 0.35rem 0 0; color: var(--warn); font-weight: 600; font-size: 0.88rem; }
.cr-done { min-height: 36px; padding: 0 1rem; border: none; border-radius: 999px; background: var(--yellow); color: #1E1F1C; font: inherit; font-size: 0.88rem; font-weight: 650; cursor: pointer; }
.cr-done:hover { background: var(--yellow-2); }
.cr-linkbtn { padding: 0.3rem 0; border: none; background: none; color: var(--info); font: inherit; font-size: 0.88rem; text-decoration: underline; text-underline-offset: 3px; cursor: pointer; }
.cr-askbox { padding: 0.75rem 0.85rem 0.8rem; border: 1px solid var(--line-2); border-radius: var(--r-sm); background: var(--cream); }
.cr-askbox .cr-quiet { margin-top: 0.4rem; }
.cr-btns { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-top: 0.6rem; }
.cr-qs { list-style: none; margin: 0 0 0.5rem; padding: 0; display: grid; gap: 0.45rem; }
.cr-qs li { padding: 0.5rem 0.75rem; border-radius: 10px; background: var(--info-bg); }
.cr-q__text { margin: 0; overflow-wrap: anywhere; }
.cr-q__meta { display: flex; flex-wrap: wrap; align-items: center; gap: 0.35rem 0.5rem; margin: 0.15rem 0 0; font-size: 0.8rem; color: var(--muted); }
.cr-q__chip { min-height: 22px; padding: 0 0.55rem; font-size: 0.74rem; }
.cr-end { display: grid; justify-items: start; gap: 0.9rem; margin: 0.5rem 0 2.5rem; padding-top: 1.1rem; border-top: 1px solid var(--line); }
.cr-mine { display: flex; flex-wrap: wrap; gap: 0.15rem 0.6rem; margin: 0.6rem 0 0; padding: 0.45rem 0.75rem; border-left: 3px solid var(--yellow); background: var(--yellow-wash); border-radius: 0 8px 8px 0; font-size: 0.9rem; }
.cr-mine__label { font-size: 0.72rem; font-weight: 750; letter-spacing: 0.08em; text-transform: uppercase; color: var(--gold); text-decoration: none; padding-top: 0.15rem; }
.cr-mine__label:hover { text-decoration: underline; }
.cr-mine__text { flex: 1 1 16rem; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--ink-2); }
@media (max-width: 640px) {
  .cr-item { padding: 0.9rem 0.9rem 0.8rem; }
  .cr-item__notes, .cr-report, .cr-item__docs, .cr-item__tools { margin-left: 0; }
  .cr-item__head .bp-pres { flex-basis: 100%; }
  .cr-approve, .cr-end .bp-btn--primary { width: 100%; }
  .cr-approved { border-radius: var(--r-sm); }
  .cr-part__head { flex-wrap: wrap; }
}
@media (prefers-reduced-motion: reduce) { .cr-act { transition: none; } }
`;
if (typeof document !== 'undefined' && !document.getElementById('board-chair-css')) {
  const s = document.createElement('style');
  s.id = 'board-chair-css';
  s.textContent = CSS;
  document.head.append(s);
}
