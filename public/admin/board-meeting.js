/**
 * Board → one meeting (#board/meeting/<id>/<before|during|after>)
 * ===========================================================================
 * A meeting in the three stages it goes through, opening on the one its date
 * is in. Nothing here is a secretary's job: the agenda builds itself from the
 * last one (the last minutes up for approval, the makeovers and the money
 * live), the numbers lock themselves on the day, and the minutes, dropped in
 * after, fill in who was there, the notes, the motions and the action items.
 *   Before   the agenda, ready as it is and changeable in place, and the
 *            packet (each file goes with its item by itself); beside them the
 *            invite, the board page and the email, and who's coming
 *   During   presenting it: Start, the screen (Next, Previous, ← →, a
 *            clicker), any item or document straight onto it, a vote the
 *            board takes on the board page, End. Check-ins on the board page
 *            count toward the quorum. A practice meeting (#board/practice) is
 *            this step alone, with simulated board members.
 *   After    drop the minutes in (PDF or Word): Board reads them into the
 *            meeting, and the board reads them on their page; then shared,
 *            emailed, approved, the signed copy
 * Everything saves by itself a moment after a change (no Save button to
 * forget in a meeting). Two people editing at once merge item by item
 * (mergeMeeting); only the same thing changed both ways asks.
 * Server: /api/board-admin. Rules: ./board-shared.js. Shared bits: ./board-ui.js.
 */

import { useState, useEffect, useRef, useMemo } from './vendor.js';
import { ask } from './ask.js';
import { viewerLink, sizeText } from './file-viewer.js';
import {
  html, call, upload, ago, savedAt, firstOf, youAnd, hashFor, PAGE, viewerFiles, CHECK, NotesBox, Menu, callName, daysFrom, whenWords, Notes,
  PersonPicker, ItemChooser, DocChip, pickable, Face,
} from './board-ui.js';
import {
  RESULTS, FILE_KINDS, LIVE, cleanMeeting, meetingName, quarterOf, longDate, shortDate, timeRange, plural, uid, clock,
  todayEastern, attendanceCounts, quorumFor, answerOf, repliesOf, fileTitle, mergeMeeting, nextMeeting, agendaIsDraft,
  isLive, agendaItems, tallyText, cleanLive, presentersOf, namesText, itemFiles, guessItem, deckOf, stopIndex, liveOfStop, MORE,
  sectionPlan, sectionOf, sectionClock, clockText,
} from './board-shared.js';
import { openScreen, useScreen, usePages, stepKey } from './board-present.js';
import { openDoc } from './board/docs.js';

// What a person edits (the server keeps files, the packet's numbers and sent records, and done ticks)
const EDITABLE = ['date', 'start', 'end', 'title', 'location', 'address', 'video', 'shared', 'minutes', 'approvedOn', 'attendance', 'sections', 'motions', 'actions', 'live'];
const editable = (m) => {
  const c = cleanMeeting(m);
  return JSON.stringify(EDITABLE.map((f) => (f === 'actions' ? c.actions.map(({ done, doneOn, ...a }) => a) : f === 'attendance' ? c.attendance.map(({ rsvp, ...p }) => p) : c[f])));
};
const stepFor = (m) => { const t = todayEastern(); return !m.date || m.date > t ? 'before' : m.date === t ? 'during' : 'after'; };
const blankItem = () => ({ id: uid('i_'), title: '', presenter: '', who: [], notes: '', staffNote: '', confidential: false, live: '', docs: [] });
const move = (list, i, d) => { const out = [...list]; const [x] = out.splice(i, 1); out.splice(i + d, 0, x); return out; };
const STAGES = [['before', 'Before', 'Getting ready'], ['during', 'During', 'Presenting'], ['after', 'After', 'The minutes']];

export function MeetingEditor({ meeting, ctx, step: asked }) {
  const { data, addToast, go, putMeeting, markDirty } = ctx;
  const [m, setM] = useState(meeting);
  const mRef = useRef(m);
  mRef.current = m;
  const saved = useRef(cleanMeeting(meeting)); // the server's copy as last seen
  const base = useRef(meeting.updatedAt);
  const [st, setSt] = useState({ s: 'saved', at: meeting.updatedAt });
  const [editWhere, setEditWhere] = useState(!meeting.date);
  const busy = useRef(null);
  const again = useRef(false);
  const timer = useRef(0);
  const practice = !!meeting.practice;
  const step = practice ? 'during' : asked || stepFor(meeting);
  const setStep = (s) => { if (practice) return; history.replaceState(null, '', hashFor({ meetingId: m.id, step: s })); ctx.setStep(s); window.scrollTo({ top: 0 }); };
  const set = (patch) => setM((x) => ({ ...x, ...(typeof patch === 'function' ? patch(x) : patch) }));
  // What the board page follows (the item, a vote opening or closing) saves at once, not a moment later
  const right = useRef(false);
  const setNow = (patch) => { right.current = true; set(patch); };
  const dirty = editable(m) !== editable(saved.current);

  // ── Saving by itself ──
  async function save() {
    clearTimeout(timer.current);
    if (busy.current) { again.current = true; return busy.current; }
    const mine = mRef.current;
    // Nothing new (a save already took it): say so, in case a change was announced before that save landed
    if (editable(mine) === editable(saved.current)) { setSt((x) => (x.s === 'unsaved' ? { ...x, s: 'saved' } : x)); return null; }
    if (!mine.date) { setSt({ s: 'error', why: 'A meeting needs a date' }); return null; }
    setSt((x) => ({ ...x, s: 'saving' }));
    busy.current = (async () => {
      let sent = mine;
      let j = await call({ action: 'save-meeting', meeting: sent, base: base.current });
      if (j.status === 409 && j.current) {
        // Saved meanwhile (Holly, the calendar, board mail): both sets of changes, item by item
        const theirs = j.current;
        let { merged, clashes } = mergeMeeting(saved.current, cleanMeeting(sent), cleanMeeting(theirs));
        if (clashes.length) {
          const keepMine = await ask({ title: `${firstOf(theirs.updatedBy)} changed this meeting too`, text: `You both changed ${clashes.slice(0, 3).join(', ')}${clashes.length > 3 ? ' and more' : ''}. Keep yours there, or take theirs? Everything else from both of you is kept.`, yes: 'Keep mine', no: 'Take theirs' });
          if (!keepMine) merged = mergeMeeting(saved.current, cleanMeeting(sent), cleanMeeting(theirs), { prefer: 'theirs' }).merged;
        }
        saved.current = cleanMeeting(theirs);
        base.current = theirs.updatedAt;
        sent = { ...merged, files: theirs.files };
        setM((x) => ({ ...x, ...sent }));
        j = await call({ action: 'save-meeting', meeting: sent, base: base.current });
      }
      busy.current = null;
      if (!j.ok) { setSt({ s: 'error', why: j.error || 'Couldn’t save' }); return null; }
      saved.current = cleanMeeting(j.meeting);
      base.current = j.meeting.updatedAt;
      // What only the server sets, into the copy being edited (never over what's been typed since)
      setM((x) => ({
        ...x, files: j.meeting.files, snapshot: j.meeting.snapshot, packetSentAt: j.meeting.packetSentAt, packetSentTo: j.meeting.packetSentTo,
        minutesSentAt: j.meeting.minutesSentAt, updatedAt: j.meeting.updatedAt, updatedBy: j.meeting.updatedBy, calendar: j.meeting.calendar, invite: j.meeting.invite,
        agendaFrom: j.meeting.agendaFrom, fromMeet: j.meeting.fromMeet, approvedOn: x.approvedOn || j.meeting.approvedOn,
      }));
      putMeeting(j.meeting);
      setSt({ s: 'saved', at: j.meeting.updatedAt });
      if (again.current) { again.current = false; return save(); }
      return j.meeting;
    })();
    return busy.current;
  }
  const key = editable(m);
  useEffect(() => {
    // Checked now, not at render: a save may have landed in between
    if (editable(mRef.current) === editable(saved.current)) return undefined;
    setSt((x) => (x.s === 'saving' ? x : { ...x, s: 'unsaved' }));
    clearTimeout(timer.current);
    timer.current = setTimeout(save, right.current ? 0 : 1200);
    right.current = false;
    return undefined;
  }, [key]);
  useEffect(() => { markDirty(dirty || st.s === 'error'); }, [dirty, st.s]);
  useEffect(() => {
    const onKey = (e) => { if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); save(); } };
    const onLeave = (e) => { if (editable(mRef.current) !== editable(saved.current)) { save(); e.preventDefault(); e.returnValue = ''; } };
    window.addEventListener('keydown', onKey);
    window.addEventListener('beforeunload', onLeave);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('beforeunload', onLeave); save(); markDirty(false); };
  }, []);

  /** An action the server takes on the saved meeting: anything typed is saved first */
  const act = async (body) => {
    await save();
    const j = await call(body);
    if (!j.ok) { addToast(j.error, 'error'); return null; }
    if (j.meeting) {
      saved.current = cleanMeeting(j.meeting);
      base.current = j.meeting.updatedAt;
      setM((x) => ({ ...x, ...j.meeting }));
      putMeeting(j.meeting);
      setSt({ s: 'saved', at: j.meeting.updatedAt });
    }
    return j;
  };
  const remove = async () => {
    if (!(await ask({ title: `Delete the ${meetingName(m)}?`, text: 'Its agenda, notes, minutes and files go for good. Board members stop seeing it.', yes: 'Delete', danger: true }))) return;
    clearTimeout(timer.current);
    saved.current = cleanMeeting(mRef.current);
    const j = await call({ action: 'delete-meeting', id: m.id });
    if (!j.ok) { addToast(j.error, 'error'); return; }
    markDirty(false);
    ctx.setData((d) => ({ ...d, meetings: d.meetings.filter((x) => x.id !== m.id) }));
    go({});
  };
  // A change the server already has (a file, a ticked action): onto both copies, so it isn't "unsaved"
  const keepSaved = (fn) => { saved.current = cleanMeeting(fn(saved.current)); setM((x) => fn(x)); putMeeting(fn(mRef.current)); };

  const people = useMemo(() => [
    ...data.people.board.map((p) => ({ slug: p.slug, name: p.name, org: p.organization, kind: 'board' })),
    ...data.people.staff.map((p) => ({ slug: p.slug, name: p.name, org: 'SOARD', kind: 'staff' })),
  ], [data.people]);
  const numbers = m.snapshot || data.numbers;
  const c = attendanceCounts(m);
  // While it's held (and all day on its date): who checked in on the board page, and the votes, every few seconds
  const following = step === 'during' && (practice || isLive(m) || m.date === todayEastern());
  const live = useLivePoll(m.id, following);
  // A check-in fills in someone the chair hasn't marked; never over a mark the chair made (each check-in once)
  const applied = useRef(new Set());
  useEffect(() => {
    const fresh = live.checkins.filter((x) => !applied.current.has(`${x.slug}|${x.at}`));
    if (!fresh.length) return;
    fresh.forEach((x) => applied.current.add(`${x.slug}|${x.at}`));
    const how = new Map(fresh.map((x) => [x.slug, x.how]));
    if (mRef.current.attendance.some((x) => x.slug && how.has(x.slug) && !x.status)) {
      set((y) => ({ attendance: y.attendance.map((x) => (x.slug && how.has(x.slug) && !x.status ? { ...x, status: how.get(x.slug) } : x)) }));
    }
  }, [live.checkins]);
  const jump = useRef(null);
  // The screen opens on the board page, which shows only shared meetings: sharing comes first
  const present = async () => {
    if (!practice && !m.shared) {
      if (!(await ask({ title: 'Put the meeting on the board page?', text: 'The screen shows the meeting the way the board sees it on their page, so it’s shared first. Board members see its agenda and documents from now on.', yes: 'Share and present' }))) return;
      set({ shared: true });
      await new Promise((r) => setTimeout(r, 0));
      await save();
    }
    openScreen(m.id);
    if (step !== 'during') setStep('during');
  };
  const p = { m, set, setNow, ctx, act, save, numbers, people, keepSaved, saved, setStep, live, practice, jump, openWhere: () => setEditWhere(true) };

  const subs = {
    before: m.packetSentAt ? `Board emailed ${shortDate(m.packetSentAt.slice(0, 10))}` : m.shared ? 'On the board page' : 'Agenda, documents, invite',
    during: isLive(m) ? 'Live now' : m.live.endedAt ? 'Held' : 'The agenda on the screen',
    after: m.minutes === 'approved' ? `Approved${m.approvedOn ? ` ${shortDate(m.approvedOn)}` : ''}` : m.minutesFrom ? 'Read from the minutes' : 'Drop the minutes in',
  };
  const done = { before: !!m.packetSentAt, during: !!m.live.endedAt || (!!m.date && m.date < todayEastern() && c.boardHere > 0), after: m.minutes === 'approved' };
  const days = daysFrom(m.date);
  const place = [m.location, m.address].filter(Boolean).join(', ');
  return html`
    <div class="bm-top">
      <div class="bm-top__bar">
        <a class="bd-back" href="#board" onClick=${(e) => { e.preventDefault(); go({}); }}>← All meetings</a>
        <div class="bd-actions">
          <span class=${`bm-saved ${st.s === 'error' ? 'is-error' : ''}`} role="status" aria-live="polite">
            ${st.s === 'saving' ? 'Saving…' : st.s === 'unsaved' ? 'Saving in a moment' : st.s === 'error' ? html`Not saved: ${st.why} <button class="btn btn-ghost btn-sm" onClick=${save}>Try again</button>` : `Saved ${st.at ? savedAt(st.at) : ''}`}
          </span>
          <a class="btn btn-ghost btn-sm" href=${`${PAGE}#/meetings/${m.id}`} target="_blank" rel="noopener">Open on the board page</a>
          <button type="button" class=${`btn btn-sm ${m.date === todayEastern() || practice ? 'btn-primary' : 'btn-ghost'}`} onClick=${present} title="The agenda and its documents on a screen: share it on Google Meet or put it on the TV">Present</button>
          ${practice ? null : html`<${Menu} label="More for this meeting" items=${[{ label: 'Delete this meeting', danger: true, run: remove }]} />`}
        </div>
      </div>
      <div class="bm-title">
        <span class=${`bm-when ${days === 0 ? 'is-today' : days > 0 ? 'is-ahead' : ''}`}>${whenWords(days)}</span>
        <h2>${meetingName(m)}</h2>
        <p class="bm-facts">
          <span>${[longDate(m.date), timeRange(m.start, m.end)].filter(Boolean).join(' · ') || 'No date yet'}</span>
          <span>${place || html`<button type="button" class="bm-link" onClick=${() => setEditWhere(true)}>Add the place</button>`}</span>
          ${m.video ? html`<span><a class="link" href=${m.video} target="_blank" rel="noopener">${callName(m.video)}</a></span>` : null}
          <button type="button" class="bm-link" aria-expanded=${editWhere} onClick=${() => setEditWhere(!editWhere)}>${editWhere ? 'Done' : 'Change when and where'}</button>
        </p>
      </div>
      ${practice ? html`<div class="bm-practice" role="note">
        <div><strong>Practice meeting.</strong> Only ${youAnd(data.settings.admins, data.me)} see it. Its board members are simulated: once you start, they check in over the first minute, and they vote a few seconds after you open a vote. Nothing here reaches the board, the calendar or anyone’s email.</div>
        <button type="button" class="btn btn-ghost btn-sm" onClick=${async () => { if (await ask({ title: 'Start the practice over?', text: 'A fresh practice meeting: the agenda again, nobody checked in, no votes.', yes: 'Start over' })) { clearTimeout(timer.current); saved.current = cleanMeeting(mRef.current); markDirty(false); ctx.startOver?.(); } }}>Start over</button>
      </div>` : html`<div class="bm-stages" role="tablist" aria-label="This meeting">
        ${STAGES.map(([id, t, sub], i) => html`<button type="button" role="tab" aria-selected=${step === id} class=${`bm-stage ${done[id] ? 'is-done' : ''}`} onClick=${() => setStep(id)}>
          <span class="bm-stage__n" aria-hidden="true">${done[id] ? CHECK : i + 1}</span>
          <span style="min-width:0"><span class="bm-stage__t">${t}<span class="bm-stage__what"> · ${sub}</span></span><span class="bm-stage__s">${subs[id]}</span></span>
        </button>`)}
      </div>`}
    </div>
    ${editWhere ? html`<${WhenWhere} ...${p} />` : null}
    <div class="bm-layout" role="tabpanel">
      ${step === 'before' ? html`
        <div class="bm-main"><${AgendaEditor} ...${p} /><${FilesCard} ...${p} goes title="The packet" sub="Drop the financial statements, the budget, a report: each goes with its agenda item by itself, so it’s under that item on the board page and on the screen when the meeting gets to it. PDFs, pictures, Word, Excel or PowerPoint, up to 50 MB." /></div>
        <aside class="bm-aside"><${GettingReady} ...${p} /><${Coming} ...${p} /></aside>`
      : step === 'during' ? html`
        <div class="bm-main"><${RunBar} ...${p} /><${RunOrder} ...${p} /><${Motions} ...${p} /></div>
        <aside class="bm-aside"><${Quorum} ...${p} /></aside>`
      : html`
        <div class="bm-main"><${MinutesDrop} ...${p} /><${MinutesDoc} ...${p} /><${FilesCard} ...${p} title="Every file" sub="All of this meeting’s files. A staff-only file never reaches the board page." /></div>
        <aside class="bm-aside"><${WrapUp} ...${p} /></aside>`}
    </div>`;
}

// ─── When and where ─────────────────────────────────────────────────

function WhenWhere({ m, set }) {
  const cal = m.calendar;
  const fromCal = !!cal && !cal.gone;
  return html`<div class="card">
    <div class="bd-card-head"><h3>When and where</h3>${cal ? html`<p>${cal.gone
      ? html`This meeting is no longer on ${firstOf(cal.from)}’s calendar. If it’s off, delete it (⋯ at the top).`
      : html`From ${firstOf(cal.from)}’s calendar (“${cal.title}”). Change the day or time there, and it follows here within the hour.${cal.place ? '' : ` The invite has no address${cal.said ? ` (its place says “${cal.said}”)` : ''}: type it here and the invite gets it.`}${cal.link ? html` <a class="link" href=${cal.link} target="_blank" rel="noopener">Open the event</a>` : null}`}</p>` : null}</div>
    <div class="bd-grid3">
      <div class="form-group"><label class="form-label" for="bd-date">Date</label><input id="bd-date" class="form-input" type="date" value=${m.date} disabled=${fromCal} onInput=${(e) => set({ date: e.target.value })} /></div>
      <div class="form-group"><label class="form-label" for="bd-start">Starts</label><input id="bd-start" class="form-input" type="time" value=${m.start} disabled=${fromCal} onInput=${(e) => set({ start: e.target.value })} /></div>
      <div class="form-group"><label class="form-label" for="bd-end">Ends</label><input id="bd-end" class="form-input" type="time" value=${m.end} disabled=${fromCal} onInput=${(e) => set({ end: e.target.value })} /></div>
      <div class="form-group"><label class="form-label" for="bd-loc">Place</label><input id="bd-loc" class="form-input" value=${m.location} placeholder="Whose office" disabled=${fromCal && cal.place} onInput=${(e) => set({ location: e.target.value })} /></div>
      <div class="form-group"><label class="form-label" for="bd-addr">Address</label><input id="bd-addr" class="form-input" value=${m.address} placeholder="Street, city" disabled=${fromCal && cal.place} onInput=${(e) => set({ address: e.target.value })} /></div>
      <div class="form-group"><label class="form-label" for="bd-video">Video link</label><input id="bd-video" class="form-input" type="url" value=${m.video} placeholder="https://" disabled=${fromCal && cal.call} onInput=${(e) => set({ video: e.target.value })} /></div>
      <div class="form-group span-3"><label class="form-label" for="bd-title">Name</label><input id="bd-title" class="form-input" value=${m.title} placeholder=${m.date ? `${quarterOf(m.date)} Board Meeting` : 'Board meeting'} onInput=${(e) => set({ title: e.target.value })} /></div>
    </div>
  </div>`;
}

// ─── Before: the agenda ─────────────────────────────────────────────

/** Where the agenda came from, in words (and whether it's still a draft) */
export function agendaSource(m) {
  const f = m.agendaFrom;
  if (agendaIsDraft(m)) {
    const from = f?.kind === 'last-meeting' ? `Built from the ${f.name} agenda: the last minutes up for approval, the makeovers and the money filled in live.` : 'SOARD’s usual outline, with the makeovers and the money filled in live.';
    return { draft: true, label: 'Ready', text: `${from} It’s ready as it is. Change anything and it saves as you type.` };
  }
  if (f?.kind === 'email') return { draft: false, label: 'From email', text: `From ${fileTitle(f.name)}, emailed${f.at ? ` ${shortDate(f.at.slice(0, 10))}` : ''}.` };
  if (f?.kind === 'drive') return { draft: false, label: 'From the minutes', text: `Read from ${fileTitle(f.name)} in Google Drive.` };
  return { draft: false, label: 'Ready', text: 'Changes go on the board page as you make them.' };
}

/** What a file is, by its name, when it's uploaded (it can be changed after) */
const kindOfName = (name) => (/financ|balance|income|p&l|profit|loss|budget|statement/i.test(name) ? 'financials' : /minutes/i.test(name) ? 'minutes' : /agenda/i.test(name) ? 'agenda' : 'other');
/** One item changed, found by its id (so a change after an upload lands on the right item even if the agenda moved) */
const withItem = (id, fn) => (x) => ({ sections: x.sections.map((s) => ({ ...s, items: s.items.map((it) => (it.id === id ? { ...it, ...fn(it) } : it)) })) });

/**
 * The agenda, as it reads: numbered sections and their items, who presents each (faces, from People), and the
 * documents that go with each, all editable in place. A file dropped on an item is uploaded and goes with it.
 */
function AgendaEditor({ m, set, ctx, keepSaved }) {
  const { data, addToast } = ctx;
  const setSection = (si, patch) => set((x) => ({ sections: x.sections.map((s, i) => (i === si ? { ...s, ...patch } : s)) }));
  const setItem = (si, ii, patch) => set((x) => ({ sections: x.sections.map((s, i) => (i === si ? { ...s, items: s.items.map((it, j) => (j === ii ? { ...it, ...patch } : it)) } : s)) }));
  const others = youAnd(data.settings.admins, data.me);
  const src = agendaSource(m);
  const people = useMemo(() => pickable(data.people), [data.people]);
  // Each part's time: its own minutes, else its share of the meeting's
  const plan = useMemo(() => sectionPlan(m), [m.sections, m.start, m.end]);
  const vf = viewerFiles(m.files);
  const [over, setOver] = useState('');
  const [busy, setBusy] = useState('');
  const attach = async (id, list) => {
    const files = [...(list || [])];
    if (!files.length) return;
    setBusy(id);
    for (const f of files) {
      const j = await upload(f, { ownerType: 'meeting', ownerId: m.id, kind: kindOfName(f.name) });
      if (!j.ok) { addToast(`${f.name}: ${j.error}`, 'error'); continue; }
      keepSaved((x) => ({ ...x, files: [...x.files, j.file] }));
      set(withItem(id, (it) => ({ docs: [...(it.docs || []), j.file.id] })));
    }
    setBusy('');
  };
  const drop = (id) => ({
    onDragOver: (e) => { if ([...(e.dataTransfer?.types || [])].includes('Files')) { e.preventDefault(); setOver(id); } },
    onDragLeave: (e) => { if (!e.currentTarget.contains(e.relatedTarget)) setOver(''); },
    onDrop: (e) => { e.preventDefault(); setOver(''); attach(id, e.dataTransfer.files); },
  });
  const itemMenu = (s, si, it, ii) => html`<${Menu} label=${`More for ${it.title || 'this item'}`} items=${[
    !it.presenter && !it.who?.length && !it.showWho && { label: 'Add who presents', run: () => setItem(si, ii, { showWho: true }) },
    { label: 'Add a document', run: () => setItem(si, ii, { showDocs: true }) },
    { label: 'Move up', disabled: ii === 0, run: () => setSection(si, { items: move(s.items, ii, -1) }) },
    { label: 'Move down', disabled: ii === s.items.length - 1, run: () => setSection(si, { items: move(s.items, ii, 1) }) },
    { label: it.notes || it.showNotes ? 'Remove the background' : 'Add background for the board', run: () => setItem(si, ii, it.notes || it.showNotes ? { notes: '', showNotes: false } : { showNotes: true }) },
    { label: it.confidential ? 'Not board only' : 'Board only (never emailed)', run: () => setItem(si, ii, { confidential: !it.confidential }) },
    { label: it.staffNote || it.showStaff ? 'Remove your private note' : `A private note (only ${others})`, run: () => setItem(si, ii, it.staffNote || it.showStaff ? { staffNote: '', showStaff: false } : { showStaff: true }) },
    ...[{ id: '', label: 'No live numbers' }, ...LIVE].filter((l) => l.id !== it.live && l.id !== 'minutes').map((l) => ({ label: l.id ? `Show ${l.label.toLowerCase()}` : 'Show no live numbers', run: () => setItem(si, ii, { live: l.id }) })),
    { label: 'Delete the item', danger: true, run: async () => { if (!it.notes || await ask({ title: `Delete “${it.title || 'this item'}”?`, text: 'Its notes go with it. Its documents stay with the meeting.', yes: 'Delete', danger: true })) setSection(si, { items: s.items.filter((_, j) => j !== ii) }); } },
  ]} />`;
  return html`<div class="card">
    <div class="bd-card-head"><h3>Agenda <span class=${`tag ${src.label === 'From email' ? 'tag--info' : 'tag--success'}`}>${src.label}</span></h3>${src.text ? html`<p>${src.text}</p>` : null}</div>
    <div class="ag">
      ${m.sections.map((s, si) => html`<section class="ag-sec" key=${s.id}>
        <div class="ag-sec__head">
          <span class="ag-num" aria-hidden="true">${si + 1}</span>
          <input class="ag-input ag-input--sec" aria-label=${`Section ${si + 1}`} value=${s.title} placeholder="Section name" onInput=${(e) => setSection(si, { title: e.target.value })} />
          <label class="ag-mins" title=${s.minutes ? 'The time this part has. Empty shares out the meeting’s time by itself.' : 'Shared out from the meeting’s time by itself. Type minutes to give it its own.'}>
            ${plan.get(s.id)?.start ? html`<span class="ag-mins__at">${clock(plan.get(s.id).start)}</span>` : null}
            <input type="number" min="1" max="600" inputmode="numeric" aria-label=${`Minutes for ${s.title || `section ${si + 1}`}`} value=${s.minutes || ''} placeholder=${String(plan.get(s.id)?.minutes || '')} onInput=${(e) => setSection(si, { minutes: Math.max(0, Math.min(600, Math.round(Number(e.target.value) || 0))) })} />
            <span>min</span>
          </label>
          <${Menu} label=${`More for the section ${s.title}`} items=${[
            { label: 'Move up', disabled: si === 0, run: () => set((x) => ({ sections: move(x.sections, si, -1) })) },
            { label: 'Move down', disabled: si === m.sections.length - 1, run: () => set((x) => ({ sections: move(x.sections, si, 1) })) },
            { label: 'Delete the section', danger: true, run: async () => { if (!s.items.some((it) => it.notes) || await ask({ title: `Delete “${s.title || 'this section'}”?`, text: 'Its items and their notes go with it. Their documents stay with the meeting.', yes: 'Delete', danger: true })) set((x) => ({ sections: x.sections.filter((_, i) => i !== si) })); } },
          ]} />
        </div>
        <ul class="ag-items">
          ${s.items.map((it, ii) => {
            const files = itemFiles(m, it, data.meetings);
            const free = m.files.filter((f) => !(it.docs || []).includes(f.id) && f.kind !== 'signed');
            return html`<li class=${`ag-item ${over === it.id ? 'is-over' : ''}`} key=${it.id} ...${drop(it.id)}>
            <div class="ag-item__row">
              <span class="ag-dot" aria-hidden="true"></span>
              <input class="ag-input" aria-label="Item" value=${it.title} placeholder="Item" onInput=${(e) => setItem(si, ii, { title: e.target.value })} />
              <${PersonPicker} people=${people} value=${presentersOf(it, people)} label=${`Who presents ${it.title || 'this item'}`} startOpen=${!!it.showWho}
                onClosed=${() => { if (it.showWho) setItem(si, ii, { showWho: false }); }}
                onChange=${(list) => setItem(si, ii, { who: list.filter((x) => x.slug).map((x) => x.slug), presenter: namesText(list.map((x) => x.name)) })} />
              ${itemMenu(s, si, it, ii)}
            </div>
            ${it.confidential || (it.live && it.live !== 'minutes') ? html`<div class="ag-tags">
              ${it.confidential ? html`<span class="tag tag--warn">Board only</span>` : null}
              ${it.live && it.live !== 'minutes' ? html`<span class="tag tag--info">${LIVE.find((l) => l.id === it.live)?.label}</span>` : null}
            </div>` : null}
            ${files.length || it.showDocs || busy === it.id ? html`<div class="ag-docs">
              ${files.map((f) => {
                const mine = m.files.some((x) => x.id === f.id);
                return html`<${DocChip} key=${f.id} f=${f} link=${mine ? viewerLink(vf, m.files.indexOf(f)) : viewerLink(viewerFiles([f]), 0)} note=${mine ? '' : 'from the last meeting'}
                  onRemove=${mine ? () => set(withItem(it.id, (x) => ({ docs: (x.docs || []).filter((d) => d !== f.id) }))) : null} />`;
              })}
              ${busy === it.id ? html`<span class="bd-muted">Uploading…</span>` : null}
              ${it.showDocs ? html`<${DocAdder} free=${free} onPick=${(f) => set(withItem(it.id, (x) => ({ docs: [...(x.docs || []), f.id] })))} onUpload=${(list) => attach(it.id, list)} onDone=${() => setItem(si, ii, { showDocs: false })} />` : null}
            </div>` : null}
            ${it.notes || it.showNotes ? html`<${NotesBox} label=${`Background for ${it.title || 'this item'}`} value=${it.notes} placeholder="Background for the board" onChange=${(v) => setItem(si, ii, { notes: v })} />` : null}
            ${it.staffNote || it.showStaff ? html`<p class="bd-private-label">Only ${others} see this</p><${NotesBox} tone="is-private" label="Your private note" value=${it.staffNote} placeholder="A private note" onChange=${(v) => setItem(si, ii, { staffNote: v })} />` : null}
          </li>`;
          })}
          <li><button type="button" class="ag-add" onClick=${() => setSection(si, { items: [...s.items, blankItem()] })}>+ Add an item</button></li>
        </ul>
      </section>`)}
      <button type="button" class="ag-add ag-add--sec" onClick=${() => set((x) => ({ sections: [...x.sections, { id: uid('s_'), title: '', items: [blankItem()] }] }))}>+ Add a section</button>
    </div>
  </div>`;
}

/** Adding a document to an item: one of the meeting's files, or a new one uploaded */
function DocAdder({ free, onPick, onUpload, onDone }) {
  return html`<div class="bd-docadd" role="group" aria-label="Add a document">
    ${free.map((f) => html`<button type="button" class="ag-add-doc" key=${f.id} onClick=${() => onPick(f)}>+ ${fileTitle(f.name)}</button>`)}
    <label class="btn btn-ghost btn-sm">Upload a file<input type="file" multiple hidden accept=".pdf,.jpg,.jpeg,.png,.webp,.heic,.docx,.xlsx,.pptx,.doc,.xls" onChange=${(e) => { onUpload(e.target.files); e.target.value = ''; }} /></label>
    <button type="button" class="btn btn-ghost btn-sm" onClick=${onDone}>Done</button>
  </div>`;
}

// ─── Files ──────────────────────────────────────────────────────────

/** A file onto one item (or none): off every other item first */
const placeFile = (fileId, itemId) => (x) => ({ sections: x.sections.map((s) => ({ ...s, items: s.items.map((it) => {
  const rest = (it.docs || []).filter((d) => d !== fileId);
  return { ...it, docs: it.id === itemId ? [...rest, fileId] : rest };
}) })) });

/**
 * The meeting's files. Before the meeting (`goes`), each shows the agenda item it goes with, and a new one goes
 * with the item it most likely belongs to (financial statements with the money item, and so on).
 */
function FilesCard({ m, set, ctx, keepSaved, title, sub, goes = false }) {
  const { addToast } = ctx;
  const [uploading, setUploading] = useState(0);
  const items = agendaItems(m);
  const whereOf = (f) => items.find((it) => m.sections[it.si].items[it.ii].docs?.includes(f.id))?.id || '';
  const add = async (list) => {
    const files = [...(list || [])];
    if (!files.length) return;
    setUploading(files.length);
    const added = [];
    for (const f of files) {
      const j = await upload(f, { ownerType: 'meeting', ownerId: m.id, kind: kindOfName(f.name) });
      if (j.ok) added.push(j.file); else addToast(`${f.name}: ${j.error}`, 'error');
      setUploading((n) => n - 1);
    }
    keepSaved((x) => ({ ...x, files: [...x.files, ...added] }));
    if (!goes) return;
    const placed = added.map((f) => [f, guessItem(m, f)]).filter(([, id]) => id);
    for (const [f, id] of placed) set(placeFile(f.id, id));
    if (placed.length === 1) addToast(`${fileTitle(placed[0][0].name)} goes with ${items.find((it) => it.id === placed[0][1])?.title || 'its item'}`, 'info');
    else if (placed.length) addToast(`${plural(placed.length, 'file')} put with their agenda items`, 'info');
  };
  const update = async (f, patch) => {
    const j = await call({ action: 'update-file', id: f.id, ...patch });
    if (!j.ok) { addToast(j.error, 'error'); return; }
    keepSaved((x) => ({ ...x, files: x.files.map((y) => (y.id === f.id ? { ...y, ...j.file } : y)) }));
  };
  const remove = async (f) => {
    if (!(await ask({ title: `Delete ${fileTitle(f.name)}?`, text: 'It goes for good, from the board page too.', yes: 'Delete', danger: true }))) return;
    const j = await call({ action: 'delete-file', id: f.id });
    if (!j.ok) { addToast(j.error, 'error'); return; }
    keepSaved((x) => ({ ...x, files: x.files.filter((y) => y.id !== f.id) }));
    set(placeFile(f.id, ''));
  };
  const vf = viewerFiles(m.files);
  const groups = FILE_KINDS.map((k) => [k, m.files.map((f, i) => ({ f, i })).filter(({ f }) => (FILE_KINDS.some((x) => x.id === f.kind) ? f.kind : 'other') === k.id)]).filter(([, l]) => l.length);
  return html`<div class="card">
    <div class="bd-card-head"><h3>${title}${m.files.length ? html` <span class="count">${m.files.length}</span>` : null}</h3><p>${sub}</p></div>
    ${groups.map(([k, list]) => html`<div class="bf-group">
      <p class="bm-group">${k.label}</p>
      <ul class="bf-list">${list.map(({ f, i }) => html`<li class="bf-file" key=${f.id}>
        <div class="bf-file__main"><a class="bd-file-name" ...${viewerLink(vf, i)}>${fileTitle(f.name)}</a><div class="bd-row__meta">${[sizeText(f.size), f.at ? `added ${shortDate(f.at.slice(0, 10))}` : ''].filter(Boolean).join(' · ')}</div></div>
        ${goes && f.kind !== 'signed' ? html`<${ItemChooser} items=${items} value=${whereOf(f)} label=${`Which agenda item ${fileTitle(f.name)} goes with`} onChange=${(id) => set(placeFile(f.id, id))} />` : null}
        <button type="button" class=${`bf-seen ${f.staffOnly ? 'is-staff' : ''}`} aria-pressed=${!f.staffOnly} title=${f.staffOnly ? 'Only you and Holly see it. Tap to let the board see it.' : 'The board sees it. Tap to keep it staff only.'} onClick=${() => update(f, { staffOnly: !f.staffOnly })}>${f.staffOnly ? 'Staff only' : html`${CHECK} The board sees it`}</button>
        <${Menu} label=${`More for ${fileTitle(f.name)}`} items=${[
          ...FILE_KINDS.filter((x) => x.id !== f.kind).map((x) => ({ label: `File it as ${x.label.toLowerCase()}`, run: () => update(f, { kind: x.id }) })),
          { label: 'Delete the file', danger: true, run: () => remove(f) },
        ]} />
      </li>`)}</ul>
    </div>`)}
    <div class="bd-drop" style=${m.files.length ? 'margin-top:0.75rem' : ''} onDragOver=${(e) => { e.preventDefault(); e.currentTarget.classList.add('is-over'); }} onDragLeave=${(e) => e.currentTarget.classList.remove('is-over')}
      onDrop=${(e) => { e.preventDefault(); e.currentTarget.classList.remove('is-over'); add(e.dataTransfer.files); }}>
      <label class="btn btn-ghost btn-sm">Add files<input type="file" multiple hidden accept=".pdf,.jpg,.jpeg,.png,.webp,.heic,.docx,.xlsx,.pptx,.doc,.xls" onChange=${(e) => { add(e.target.files); e.target.value = ''; }} /></label>
      <span class="bd-muted">${uploading ? `Uploading ${plural(uploading, 'file')}…` : 'or drop them here'}</span>
    </div>
  </div>`;
}

// ─── The checklists ─────────────────────────────────────────────────

/** One thing to do: done, the next one (its button stands out), or still to come */
const Task = ({ state, title, sub, children }) => {
  const kids = [].concat(children ?? []).filter(Boolean);
  return html`<li class=${`bm-task is-${state}`}>
    <span class="bm-task__mark" aria-hidden="true">${state === 'done' ? CHECK : null}</span>
    <div class="bm-task__body">
      <div class="bm-task__t">${title}</div>
      ${sub ? html`<div class="bm-task__s">${sub}</div>` : null}
      ${kids.length ? html`<div class="bm-task__do">${kids}</div>` : null}
    </div>
  </li>`;
};
/** States for a list of done flags: the first not done is next */
const statesOf = (dones) => { const first = dones.indexOf(false); return dones.map((d, i) => (d ? 'done' : i === first ? 'next' : 'todo')); };
const btn = (state) => `btn btn-sm ${state === 'next' ? 'btn-primary' : 'btn-ghost'}`;

function GettingReady({ m, set, ctx, act, save }) {
  const { data, addToast } = ctx;
  const [working, setWorking] = useState('');
  const run = async (name, body, ok) => { setWorking(name); const j = await act(body); setWorking(''); if (j && ok) addToast(typeof ok === 'function' ? ok(j) : ok, 'info'); return j; };
  const share = async (v) => { set({ shared: v }); await new Promise((r) => setTimeout(r, 0)); await save(); };
  // The invite: who's on it, and who should be
  const inv = m.invite;
  const from = inv?.organizer || m.calendar?.organizer || data.settings.invitesFrom;
  const guests = [...new Set([...data.members.map((x) => x.email).filter(Boolean), ...data.settings.admins])];
  const missing = inv ? guests.filter((e) => !(inv.emails || []).includes(e) && e !== inv.organizer) : [];
  const transcript = !inv ? '' : inv.transcript === 'on' ? 'transcript on' : inv.transcript === 'needs-setup' ? 'transcript needs one Google setting (see Meetings)' : inv.transcript === 'error' ? 'no transcript (SOARD’s Google plan)' : '';
  const placeNow = [m.location, m.address].filter(Boolean).join(', ');
  const where = !inv ? '' : placeNow && placeNow !== inv.place ? 'the new place goes on it a couple of minutes after you stop typing' : inv.place ? `at ${inv.place}` : 'the place goes on it when you add one';
  // Another call (Teams, Zoom) on the organizer's event, or from another event that day: Google Meet takes its place
  const otherCall = !inv && m.calendar?.eventId && m.video && !/meet\.google\.com/.test(m.video) ? callName(m.video) : '';
  // The invite check found the organizer's Google account can't have transcripts: they're not promised
  const noTranscripts = !!data.google?.check && data.google.check.transcript === 'error';
  const meetWords = noTranscripts ? 'Google Meet' : 'Google Meet with transcripts on';
  const docs = m.files.filter((f) => !f.staffOnly);
  const [sInvite, sShared, sSent] = statesOf([!!inv && !missing.length, m.shared, !!m.packetSentAt]);
  // Emailing the link puts the meeting on the board page first: one press, not two
  const email = async () => {
    if (!(await ask({ title: `Email ${plural(data.packetTo, 'board member')} the link?`, text: `${m.shared ? '' : 'The meeting goes on the board page, and '}the board gets the link to the agenda and ${docs.length ? plural(docs.length, 'document') : 'documents'}, with one-tap answers for anyone who hasn’t said whether they’re coming. Nothing is attached.`, yes: m.packetSentAt ? 'Email them again' : 'Email the board' }))) return;
    if (!m.shared) await share(true);
    run('send', { action: 'send-packet', id: m.id }, (j) => `Emailed ${plural(j.sent, 'board member')}`);
  };
  return html`<div class="card bm-check">
    <div class="bd-card-head"><h3>Getting ready</h3><p>${[sInvite, sShared, sSent].every((x) => x === 'done') ? 'All set. The numbers lock themselves on the day.' : 'The agenda is ready and the numbers lock themselves on the day. What’s left:'}</p></div>
    <ol class="bm-tasks">
      <${Task} state=${sInvite} title=${inv ? `Invite sent from ${firstOf(inv.organizer)}’s calendar` : m.calendar?.eventId ? `Finish ${firstOf(from)}’s invite` : 'Send the invite'}
        sub=${inv ? [plural(inv.guests, 'guest'), inv.meet ? 'Google Meet' : '', transcript, where, missing.length ? `${missing.length} not on it yet` : ''].filter(Boolean).join(' · ')
          : otherCall ? `On ${firstOf(from)}’s calendar with a ${otherCall} call. Board adds the board, ${youAnd(data.settings.admins, data.me)}, the place and the agenda link, and makes it ${meetWords}.`
          : m.calendar?.eventId ? `On ${firstOf(from)}’s calendar. Board adds the board, ${youAnd(data.settings.admins, data.me)}, ${meetWords}, the place and the agenda link.`
          : `From ${firstOf(from)}’s calendar to the board and ${youAnd(data.settings.admins, data.me)}: ${meetWords}, and the link to the agenda.`}>
        <button class=${btn(sInvite)} disabled=${!!working || !data.setup.calendar || !m.date} onClick=${() => run('invite', { action: 'send-invite', id: m.id }, (j) => `${j.meeting.invite?.guests ? plural(j.meeting.invite.guests, 'guest') : 'The invite'} on ${firstOf(j.meeting.invite?.organizer)}’s calendar`)}>
          ${working === 'invite' ? 'Sending…' : !inv ? (otherCall ? 'Add everyone, switch to Meet' : m.calendar?.eventId ? 'Add everyone and Meet' : 'Send the invite') : missing.length ? `Add the ${missing.length === 1 ? 'one' : missing.length} missing` : 'Update the invite'}</button>
      </${Task}>
      <${Task} state=${sShared} title=${m.shared ? 'On the board page' : 'Put it on the board page'} sub=${m.shared ? 'Board members see the agenda and files (never a private note or a staff-only file).' : 'Board members see nothing of this meeting until then. Emailing the board puts it there too.'}>
        ${m.shared ? html`<button class="btn btn-ghost btn-sm" onClick=${() => share(false)}>Take it off</button>` : html`<button class=${btn(sShared)} onClick=${() => share(true)}>Share with the board</button>`}
      </${Task}>
      <${Task} state=${sSent} title=${m.packetSentAt ? `${plural(m.packetSentTo, 'board member')} emailed the link` : 'Email the board the link'}
        sub=${m.packetSentAt ? ago(m.packetSentAt) : `The link, ${docs.length ? `the ${plural(docs.length, 'document')} by name` : 'the documents by name once there are some'} (nothing attached), and one-tap “Will you be there?”. To ${plural(data.packetTo, 'board member')}${data.setup.email ? '' : ' · email isn’t set up'}.`}>
        <button class="btn btn-ghost btn-sm" disabled=${!!working || !data.setup.email} onClick=${() => run('preview', { action: 'send-packet', id: m.id, test: true }, (j) => `Sent to ${j.to?.[0] || 'you'}`)}>${working === 'preview' ? 'Sending…' : 'Send it to me'}</button>
        <button class=${btn(sSent)} disabled=${!!working || !data.packetTo || !data.setup.email} onClick=${email}>${working === 'send' ? 'Sending…' : m.packetSentAt ? 'Email again' : 'Email the board'}</button>
      </${Task}>
    </ol>
  </div>`;
}

/** Who's coming: answers on the board page and replies to the calendar invite */
function Coming({ m, ctx, act }) {
  const { data, addToast } = ctx;
  const [working, setWorking] = useState('');
  const board = m.attendance.filter((x) => x.kind === 'board');
  const answer = (x) => answerOf(x.rsvp, repliesOf(m)[x.slug]);
  const groups = [['Coming', board.filter((x) => answer(x) === 'Coming')], ['By video', board.filter((x) => answer(x) === 'By video')], ['Maybe', board.filter((x) => answer(x) === 'Maybe')], ['Can’t come', board.filter((x) => answer(x) === 'Can’t come')], ['No answer', board.filter((x) => !answer(x))]];
  const quiet = groups.at(-1)[1].filter((x) => data.members.find((y) => y.slug === x.slug)?.email);
  const remind = async (test) => { setWorking(test ? 'preview' : 'send'); const j = await act({ action: 'remind-rsvp', id: m.id, test }); setWorking(''); if (j) addToast(test ? `Sent to ${j.to?.[0] || 'you'}` : `Asked ${plural(j.sent, 'board member')}`, 'info'); };
  const answered = board.length - groups.at(-1)[1].length;
  return html`<div class="card">
    <div class="bd-card-head"><h3>Who’s coming</h3><p>${answered ? `${answered} of ${board.length} board members have answered,` : 'Nobody has answered yet,'} on the board page or the calendar invite.</p></div>
    <div class="bm-bar" role="img" aria-label=${groups.filter(([, l]) => l.length).map(([t, l]) => `${l.length} ${t.toLowerCase()}`).join(', ')}>
      ${groups.map(([t, l]) => (l.length ? html`<span class=${`bm-bar__part is-${t === 'Coming' || t === 'By video' ? 'yes' : t === 'Can’t come' ? 'no' : t === 'Maybe' ? 'maybe' : 'none'}`} style=${`flex:${l.length}`}></span>` : null))}
    </div>
    <dl class="bm-who">${groups.filter(([, l]) => l.length).map(([t, l]) => html`<div><dt>${t} <b>${l.length}</b></dt><dd>${l.map((x) => x.name).join(', ')}</dd></div>`)}</dl>
    ${quiet.length && m.date >= todayEastern() ? html`<div class="bd-actions" style="margin-top:0.75rem">
      <button class="btn btn-ghost btn-sm" disabled=${!!working || !m.shared} onClick=${() => remind(true)}>${working === 'preview' ? 'Sending…' : 'Send it to me'}</button>
      <button class="btn btn-ghost btn-sm" disabled=${!!working || !m.shared} title=${m.shared ? '' : 'Share the meeting first'} onClick=${() => remind(false)}>${working === 'send' ? 'Sending…' : `Ask the ${quiet.length === 1 ? 'one' : quiet.length} who haven’t answered`}</button>
    </div>` : null}
  </div>`;
}

// ─── During ─────────────────────────────────────────────────────────

/** Who checked in on the board page and how each one voted: { checkins, votes: { motionId: [...] } }, every 3 seconds while on */
function useLivePoll(id, on) {
  const [live, setLive] = useState({ checkins: [], votes: {} });
  useEffect(() => {
    if (!on) return undefined;
    let stop = false;
    let t = 0;
    const look = async () => {
      const j = await call(null, { query: `?live=${encodeURIComponent(id)}` });
      if (stop) return;
      if (j.ok) setLive({ checkins: j.checkins || [], votes: j.votes || {} });
      t = setTimeout(look, document.hidden ? 15000 : 3000);
    };
    look();
    return () => { stop = true; clearTimeout(t); };
  }, [id, on]);
  return live;
}
const typingIn = (el) => !!el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable);
const clockOf = (ms) => { const sec = Math.max(0, Math.floor(ms / 1000)); const h = Math.floor(sec / 3600); const mm = String(Math.floor((sec % 3600) / 60)).padStart(h ? 2 : 1, '0'); return `${h ? `${h}:` : ''}${mm}:${String(sec % 60).padStart(2, '0')}`; };
/** A vote's counts from the poll, for the motion that's open */
const countsOf = (list = []) => ({ for: list.filter((x) => x.vote === 'for').length, against: list.filter((x) => x.vote === 'against').length, abstain: list.filter((x) => x.vote === 'abstain').length, voted: list.length });
/** Board members here (practising, the admin who checked in is one more), for "6 of 9 here have voted" */
const hereCount = (m, live, practice) => attendanceCounts(m).boardHere + (practice && live.checkins.some((x) => x.slug.startsWith('admin:')) ? 1 : 0);
/** Close the open vote: its tally onto the motion (passed when more for than against; the chair can still change it) */
function closeVote(x, live, practice) {
  const v = x.live.vote;
  if (!v) return {};
  const n = countsOf(live.votes[v.motionId]);
  const at = new Date().toISOString();
  return {
    live: { ...cleanLive(x.live), vote: null },
    motions: x.motions.map((y) => (y.id === v.motionId ? { ...y, result: n.for > n.against ? 'passed' : 'failed', tally: { for: n.for, against: n.against, abstain: n.abstain, of: hereCount(x, live, practice), at } } : y)),
  };
}

/** Each file once, in the order the deck shows them */
const deckFiles = (m, meetings) => {
  const all = [...m.files, ...meetings.flatMap((x) => x.files || [])];
  return [...new Set(deckOf(m, { meetings }).filter((s) => s.fileId).map((s) => s.fileId))].map((id) => all.find((f) => f.id === id)).filter(Boolean);
};
/** What a stop is, in words: { label: '3.2' | '', title, sub } */
function stopWords(stop, m, items, pages, files) {
  if (!stop || stop.kind === 'cover') return { label: '', title: 'The cover', sub: `${meetingName(m)} and the agenda` };
  if (stop.kind === 'end') return { label: '', title: 'The close', sub: 'Thank you, and the next meeting' };
  const it = stop.n >= 0 ? items[stop.n] : { label: '', title: MORE.title };
  if (stop.kind === 'item') return { label: it.label, title: it.title, sub: [it.section !== it.title ? it.section : '', it.presenter].filter(Boolean).join(' · ') };
  const f = files.find((x) => x.id === stop.fileId);
  const n = pages[stop.fileId];
  return { label: it.label, title: f ? fileTitle(f.name) : 'A document', sub: `${it.title} · page ${stop.page + 1}${n ? ` of ${n}` : ''}` };
}

/**
 * The meeting as it's held, at the top of During, and the screen it puts up: Start; then a live clock, what's on
 * the screen (the item, its document and page) with Previous and Next (← → and J K, or a clicker's Page Up and
 * Page Down), the screen in its own window, and End. The board page follows each move within seconds, a screen on
 * this computer at once. Before Start, the screen can be opened to rehearse on: only it moves.
 */
function RunBar({ m, setNow, live, practice, ctx, jump, act }) {
  const meetings = ctx.data.meetings;
  const running = isLive(m);
  const items = agendaItems(m);
  const [rehearsal, setRehearsal] = useState(() => liveOfStop(null));
  const files = useMemo(() => deckFiles(m, meetings), [m.sections, m.files, meetings]);
  const here = useRef({});
  const [send, screenOn] = useScreen(m.id, (msg) => {
    if (msg.type === 'hello') send({ type: 'show', live: here.current.pos, rehearsal: !running, practice });
    if (msg.type === 'key' && (running || screenOn)) here.current.go(here.current.at + (msg.dir > 0 ? 1 : -1));
    if (msg.type === 'pages' && msg.pages) addPages(msg.pages);
  });
  const [pages, addPages] = usePages(files, running || screenOn);
  const deck = useMemo(() => deckOf(m, { pages, meetings }), [m.sections, m.files, pages, meetings]);
  const pos = running ? cleanLive(m.live) : rehearsal;
  const at = stopIndex(deck, pos);
  const [, tick] = useState(0);
  useEffect(() => { if (!running && !screenOn) return undefined; const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, [running, screenOn]);
  const go = (i, target = null) => {
    const s = target || deck[Math.max(0, Math.min(deck.length - 1, i))];
    if (!s) return;
    const next = liveOfStop(s);
    // A new part of the agenda starts its timer; a new item gives the floor back to whoever presents it
    const sec = sectionOf(m, next.itemId);
    next.sectionAt = !next.itemId ? '' : sec !== sectionOf(m, pos.itemId) || !pos.sectionAt ? new Date().toISOString() : pos.sectionAt;
    next.floor = next.itemId && next.itemId === pos.itemId ? pos.floor || '' : '';
    if (running) setNow((x) => ({ live: { ...cleanLive(x.live), ...next } }));
    else setRehearsal((r) => ({ ...r, ...next }));
    send({ type: 'show', live: { ...pos, ...next }, rehearsal: !running, practice });
  };
  /** Someone else has the floor ('' gives it back to the item's presenter) */
  const giveFloor = (slug) => {
    const next = { floor: slug };
    if (running) setNow((x) => ({ live: { ...cleanLive(x.live), ...next } }));
    else setRehearsal((r) => ({ ...r, ...next }));
    send({ type: 'show', live: { ...pos, ...next }, rehearsal: !running, practice });
  };
  here.current = { pos, at, go };
  // From the notes below: an item ("Discuss now") or one of its documents ("Show")
  jump.current = (want) => {
    const i = deck.findIndex((s) => s.itemId === want.itemId && s.fileId === (want.fileId || '') && s.page === 0);
    if (i >= 0) go(i);
  };
  useEffect(() => {
    if (!running && !screenOn) return undefined;
    const keys = (e) => {
      if (typingIn(e.target) || document.querySelector('.modal-overlay, .ask-overlay, .bd-pop.is-open')) return;
      const dir = stepKey(e);
      if (dir) { e.preventDefault(); here.current.go(here.current.at + dir); }
    };
    window.addEventListener('keydown', keys);
    return () => window.removeEventListener('keydown', keys);
  }, [running, screenOn]);
  const present = () => { openScreen(m.id); };
  const start = () => {
    const live0 = { startedAt: new Date().toISOString(), endedAt: '', itemId: '', fileId: '', page: 0, screen: '' };
    setNow((x) => ({ live: { ...cleanLive(x.live), ...live0 } }));
    send({ type: 'show', live: live0, rehearsal: false, practice });
    // The numbers the board sees today, locked for the minutes (the heartbeat does it that morning; this if it hasn't)
    if (!practice && !m.snapshot) act({ action: 'snapshot', id: m.id });
  };
  const end = async () => {
    const open = m.live.vote ? m.motions.find((y) => y.id === m.live.vote.motionId) : null;
    if (!(await ask({ title: 'End the meeting?', text: `The board page stops showing it as live and the screen says thank you.${open ? ` The open vote on “${open.text.slice(0, 60)}” closes with the votes in so far.` : ''} Notes, attendance and votes stay for the minutes.`, yes: 'End the meeting' }))) return;
    const endedAt = new Date().toISOString();
    setNow((x) => { const closed = closeVote(x, live, practice); return { ...closed, live: { ...cleanLive(closed.live || x.live), vote: null, endedAt, screen: 'end', itemId: '', fileId: '', page: 0 } }; });
    send({ type: 'show', live: { ...pos, endedAt, screen: 'end', itemId: '', fileId: '', page: 0 }, rehearsal: false, practice });
  };
  const words = stopWords(deck[at], m, items, pages, files);
  const next = deck[at + 1] ? stopWords(deck[at + 1], m, items, pages, files) : null;
  const screenBtn = html`<button type="button" class="btn btn-ghost btn-sm" onClick=${present} title=${screenOn ? 'Bring the screen’s window to the front' : 'The screen in its own window: share it on Google Meet, or drag it onto the TV'}>${screenOn ? 'Show the screen' : 'Open the screen'}</button>`;
  const stepper = html`<div class="bm-run__do">
    <button type="button" class="btn btn-ghost btn-sm" disabled=${at <= 0} onClick=${() => go(at - 1)} aria-keyshortcuts="ArrowLeft PageUp K">← Previous</button>
    <button type="button" class="btn btn-primary btn-sm" disabled=${at >= deck.length - 1} onClick=${() => go(at + 1)} aria-keyshortcuts="ArrowRight PageDown J">Next →</button>
  </div>`;
  const people = useMemo(() => pickable(ctx.data.people), [ctx.data.people]);
  const plan = useMemo(() => sectionPlan(m), [m.sections, m.start, m.end]);
  const curItem = items.find((x) => x.id === pos.itemId);
  const curSec = curItem ? m.sections[curItem.si] : null;
  const timer = curSec ? sectionClock(plan, curSec.id, pos.sectionAt) : null;
  const presenting = curItem ? presentersOf(m.sections[curItem.si].items[curItem.ii], people) : [];
  const floorer = pos.floor ? people.find((x) => x.slug === pos.floor) || null : null;
  const floor = floorer ? [floorer] : presenting;
  const floorMenu = curItem ? [
    ...(floorer && presenting.length ? [{ label: `Back to ${namesText(presenting.map((x) => x.name))}`, run: () => giveFloor('') }] : []),
    ...m.attendance.filter((x) => x.slug && x.slug !== pos.floor && !presenting.some((y) => y.slug === x.slug) && people.some((y) => y.slug === x.slug))
      .map((x) => ({ label: x.name, run: () => giveFloor(x.slug) })),
  ] : [];
  const meta = curSec ? html`<div class="bm-run__meta">
    <div class=${`bm-timer ${timer?.over ? 'is-over' : ''}`} role="timer" aria-live="off">
      <span class="bm-timer__t">${timer ? (timer.over ? `${clockText(timer.left)} over` : `${clockText(timer.left)} left`) : `${plan.get(curSec.id)?.minutes} min`}</span>
      <span class="bm-timer__s">${timer?.over ? 'Time’s up for' : 'for'} ${curSec.title || 'this part'} · ${plan.get(curSec.id)?.minutes} min</span>
    </div>
    <div class="bm-floor">
      ${floor.length ? html`<span class="bm-floor__faces">${floor.map((p) => html`<${Face} p=${p} size=${28} key=${p.slug || p.name} />`)}</span>` : null}
      <span class="bm-floor__t"><strong>${floor.length ? namesText(floor.map((x) => x.name)) : 'The chair'}</strong> has the floor</span>
      ${floorMenu.length ? html`<${Menu} label="Give the floor to someone else" items=${floorMenu} />` : null}
    </div>
  </div>` : null;
  const now = html`<div class="bm-run__screen">
    <${ScreenThumb} stop=${deck[at]} files=${files} text=${words.label || (deck[at]?.kind === 'end' ? 'End' : 'Cover')} />
    <div class="bm-run__now" aria-live="polite">
      <span class="bm-run__label">${running ? 'On the screen' : 'Rehearsing'}${words.label ? ` · ${words.label}` : ''}</span>
      <span class="bm-run__title">${words.title}</span>
      <span class="bm-run__sec">${words.sub}</span>
      ${next ? html`<span class="bm-run__next">Next: ${deck[at + 1].fileId && deck[at + 1].fileId === deck[at]?.fileId ? `page ${deck[at + 1].page + 1}` : `${next.title}${next.label && next.label !== words.label ? ` (${next.label})` : ''}`}</span>` : null}
    </div>
  </div>`;
  if (!m.live.startedAt) {
    return html`<div class=${`card bm-run is-ready ${screenOn ? 'is-rehearsing' : ''}`}>
      <div class="bm-run__lead"><span class="bm-run__state">Not started</span><p>Starting puts the meeting live on the board page: members check in, follow along item by item, see each document as it’s shown, and vote when you open a vote. Open the screen first to share it on Google Meet or put it on the TV${screenOn ? '' : ', and to rehearse on it'}.</p></div>
      <div class="bm-run__do">${screenBtn}<button type="button" class="btn btn-primary" onClick=${start}>Start the meeting</button></div>
      ${screenOn ? html`<div class="bm-run__rehearse">${now}${meta}${stepper}<p class="bm-run__hint">Rehearsing: only the screen on this computer moves, and the board page doesn’t follow until you start.</p></div>` : null}
    </div>`;
  }
  if (!running) {
    const took = Date.parse(m.live.endedAt) - Date.parse(m.live.startedAt);
    return html`<div class="card bm-run is-ended">
      <div class="bm-run__lead"><span class="bm-run__state">Ended</span><p>${new Date(m.live.endedAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}, after ${clockOf(took)}. The notes, attendance and votes are ready for the minutes in After.</p></div>
      <button type="button" class="btn btn-ghost btn-sm" onClick=${() => setNow((x) => ({ live: { ...cleanLive(x.live), endedAt: '', screen: '' } }))}>Resume</button>
    </div>`;
  }
  return html`<div class="card bm-run is-live" role="region" aria-label="The meeting, live">
    <div class="bm-run__clock"><span class="bm-live-dot" aria-hidden="true"></span><span class="bm-run__state">Live</span><span class="bm-run__time" aria-label="Time since it started">${clockOf(Date.now() - Date.parse(m.live.startedAt))}</span></div>
    ${now}
    <div class="bm-run__side">${stepper}<div class="bm-run__do">${screenBtn}<button type="button" class="btn btn-ghost btn-sm" onClick=${end}>End the meeting</button></div></div>
    ${meta}
    <p class="bm-run__hint">${items.length ? html`<span class="kbd">←</span> <span class="kbd">→</span> or a clicker move the screen when you’re not typing. ` : null}The board page follows within seconds${practice ? ', and so do the simulated members' : ''}.</p>
  </div>`;
}

/** A small picture of what's on the screen: the document's page, or the item's card in words */
function ScreenThumb({ stop, files, text }) {
  const ref = useRef(null);
  const f = stop?.fileId ? files.find((x) => x.id === stop.fileId) : null;
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    el.replaceChildren();
    if (!f) return undefined;
    let gone = false;
    openDoc(f).then((doc) => doc.draw(Math.min(stop.page, doc.count - 1), { width: 74 })).then((page) => { if (!gone && page) el.replaceChildren(page); }).catch(() => {});
    return () => { gone = true; };
  }, [f?.id, stop?.page]);
  return html`<span class=${`bm-thumb ${f ? 'is-doc' : `is-${stop?.kind || 'cover'}`}`} ref=${ref} aria-hidden="true">${f ? null : html`<span>${text}</span>`}</span>`;
}

/** The quorum, beside the meeting as it runs: board members who checked in on the board page (the minutes settle it after) */
function Quorum({ m, ctx }) {
  const fixed = ctx.data.settings.quorum;
  const quorum = quorumFor(m, fixed);
  const c = attendanceCounts(m);
  return html`<div class=${`card bm-quorum ${quorum ? (c.boardHere >= quorum ? 'is-met' : 'is-short') : ''}`} role="status">
    <div class="bm-quorum__n"><b>${c.boardHere}</b> of ${c.board}</div>
    <div class="bm-quorum__t">board members checked in${c.remote ? ` (${c.remote} by video)` : ''}</div>
    <p class="bm-quorum__q">${quorum ? (c.boardHere >= quorum ? `Quorum met: ${quorum} needed${fixed ? '' : ', a majority'}.` : `Quorum is ${quorum}${fixed ? '' : ', a majority'}: ${quorum - c.boardHere} more needed.`) : 'No board members on the list yet.'}</p>
    <p class="bd-muted" style="margin-top:0.75rem">Members check in with one tap on the board page. Nobody takes roll: the minutes say who was there.</p>
  </div>`;
}

const LIVE_TAGS = { projects: 'Makeovers board', cash: 'The money', reveals: 'Reveals', events: 'Events', meetings: 'Meetings' };
/**
 * The agenda in order, for presenting: the item on the screen marked, and any item or document put straight onto it
 * (while rehearsing, only the screen on this computer moves). The minutes item can be marked approved here.
 */
function RunOrder({ m, set, ctx, practice, jump }) {
  const { data } = ctx;
  const running = isLive(m);
  const items = agendaItems(m);
  const plan = useMemo(() => sectionPlan(m), [m.sections, m.start, m.end]);
  // The item being discussed comes into view as the chair moves on
  const was = useRef(m.live.itemId);
  useEffect(() => {
    if (!m.live.itemId || m.live.itemId === was.current) return;
    was.current = m.live.itemId;
    document.getElementById(`run-${m.live.itemId}`)?.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  }, [m.live.itemId]);
  const prevName = (id) => { const x = data.meetings.find((y) => y.id === id); return x ? meetingName(x) : 'the last meeting'; };
  // The last meeting's minutes, approved here: that meeting is marked, and the vote goes in this one's motions
  const approve = async (it) => {
    const j = await call({ action: 'approve-minutes', id: it.about, on: m.date });
    if (!j.ok) { ctx.addToast(j.error, 'error'); return; }
    set((x) => ({ motions: [...x.motions, { id: uid('v_'), text: `Approve the minutes of the ${prevName(it.about)}`, by: '', second: '', result: 'passed' }] }));
    ctx.putMeeting(j.meeting);
    ctx.addToast(`The ${prevName(it.about)}’s minutes are approved`, 'info');
  };
  if (!items.length) return null;
  return html`<div class="card">
    <div class="bd-card-head"><h3>The agenda, in order</h3><p>Tap an item or a document to put it on the screen. ${running ? 'The board page follows.' : 'Before you start, only the screen on this computer moves.'}</p></div>
    <ol class="bm-order">${m.sections.map((s, si) => html`<li class="bm-order__sec" key=${s.id}>
      <p class="bm-order__head"><span>${String(si + 1).padStart(2, '0')}</span>${s.title || 'Section'}<small>${[plan.get(s.id)?.start ? clock(plan.get(s.id).start) : '', `${plan.get(s.id)?.minutes} min`].filter(Boolean).join(' · ')}</small></p>
      ${s.items.length ? html`<ol>${s.items.map((it) => {
        const label = items.find((x) => x.id === it.id)?.label;
        const on = running && m.live.itemId === it.id;
        const files = itemFiles(m, it, data.meetings);
        return html`<li class=${`bm-order__item ${on ? 'is-now' : ''}`} id=${`run-${it.id}`} key=${it.id}>
          <button type="button" class="bm-order__go" onClick=${() => jump.current?.({ itemId: it.id })} aria-current=${on ? 'step' : null}>
            <span class="bm-order__n">${on ? html`<span class="bm-live-dot" aria-hidden="true"></span>` : label}</span>
            <span class="bm-order__t">${it.title || html`<em>No title</em>`}${it.presenter ? html`<small>${it.presenter}</small>` : null}</span>
            ${it.live && it.live !== 'minutes' ? html`<span class="tag tag--info">${LIVE_TAGS[it.live] || 'Live'}</span>` : null}
            ${it.confidential ? html`<span class="tag tag--warn">Board only</span>` : null}
          </button>
          ${files.length ? html`<div class="bm-showdocs">${files.map((f) => {
            const showing = on && m.live.fileId === f.id;
            return html`<button type="button" class=${`bm-showdoc ${showing ? 'is-on' : ''}`} key=${f.id} aria-pressed=${showing} onClick=${() => jump.current?.({ itemId: it.id, fileId: f.id })}>${showing ? 'On the screen: ' : ''}${fileTitle(f.name)}</button>`;
          })}</div>` : null}
          ${it.live === 'minutes' && it.about && !practice ? html`<div class="bd-actions bm-order__approve">${data.meetings.find((y) => y.id === it.about)?.minutes === 'approved'
            ? html`<span class="tag tag--success">Approved</span>` : html`<button class="btn btn-ghost btn-sm" onClick=${() => approve(it)}>The board approved them</button>`}<span class="bd-muted">${prevName(it.about)}</span></div>` : null}
        </li>`;
      })}</ol>` : null}
    </li>`)}</ol>
  </div>`;
}

function Motions({ m, set, setNow, live, practice, saved }) {
  const running = isLive(m);
  const open = running ? m.live.vote?.motionId || '' : '';
  const savedIds = new Set(saved.current.motions.map((x) => x.id));
  const openVote = async (x) => {
    if (x.tally && !(await ask({ title: 'Take the vote again?', text: `The last result (${tallyText(x)}) stays until you close this one. Everyone votes again.`, yes: 'Take it again' }))) return;
    setNow((y) => ({ live: { ...cleanLive(y.live), vote: { motionId: x.id, openedAt: new Date().toISOString() } } }));
  };
  const upd = (i, patch) => set((x) => ({ motions: x.motions.map((y, j) => (j === i ? { ...y, ...patch } : y)) }));
  return html`<div class="card">
    <div class="bd-card-head"><h3>Votes</h3><p>${running ? 'Type the motion and open the vote: the board votes on the board page, in the room or on video. Close it to record the result.' : 'Once the meeting is started, the board can vote on the board page. Who moved and seconded it, and every other decision, come from the minutes.'}</p></div>
    ${m.motions.length ? html`<div class="bd-lines">${m.motions.map((x, i) => html`<div class=${`bm-motion ${open === x.id ? 'is-voting' : ''}`} key=${x.id}>
      <div class="bd-line bd-line--vote">
        <input class="form-input" aria-label="The motion" value=${x.text} placeholder="Approve the 2027 budget" onInput=${(e) => upd(i, { text: e.target.value })} />
        <button class="bd-icon-btn" aria-label="Delete the motion" disabled=${open === x.id} onClick=${() => set((y) => ({ motions: y.motions.filter((_, j) => j !== i) }))}>✕</button>
      </div>
      ${open === x.id ? html`<${VotePanel} m=${m} x=${x} live=${live} practice=${practice} setNow=${setNow} />`
        : x.tally || running ? html`<div class="bm-vote-line">
          ${x.tally ? html`<span class=${`tag ${x.result === 'passed' ? 'tag--success' : ''}`}>${tallyText(x)}</span><span class="bd-muted">on the board page${x.tally.of ? `, ${x.tally.of} here` : ''}</span>` : null}
          ${running ? html`<button type="button" class=${`btn btn-sm ${x.tally ? 'btn-ghost' : 'btn-primary'}`} disabled=${!!open || !x.text.trim() || !savedIds.has(x.id)} title=${open ? 'Close the open vote first' : !savedIds.has(x.id) ? 'Saving…' : ''} onClick=${() => openVote(x)}>${x.tally ? 'Vote again' : 'Open the vote'}</button>` : null}
        </div>` : null}
    </div>`)}</div>` : null}
    <button class=${`btn btn-sm ${running && !m.motions.length ? 'btn-primary' : 'btn-ghost'}`} style=${m.motions.length ? 'margin-top:0.75rem' : ''} onClick=${() => set((x) => ({ motions: [...x.motions, { id: uid('v_'), text: '', by: '', second: '', result: 'passed' }] }))}>Put a motion to a vote</button>
  </div>`;
}

/** An open vote, live: the counts as they come in, who has voted, and Close */
function VotePanel({ m, x, live, practice, setNow }) {
  const list = live.votes[x.id] || [];
  const n = countsOf(list);
  const of = hereCount(m, live, practice);
  const bar = (k, label) => html`<div class=${`bm-vote__n is-${k}`}><span class="bm-vote__num">${n[k]}</span><span class="bm-vote__lab">${label}</span><span class="bm-vote__bar" aria-hidden="true"><i style=${`--w:${of ? Math.min(100, (n[k] / of) * 100) : 0}%`}></i></span></div>`;
  return html`<div class="bm-vote" role="region" aria-label="The vote, live">
    <div class="bm-vote__head"><span class="bm-live-dot" aria-hidden="true"></span><strong>Voting now</strong><span class="bd-muted" aria-live="polite">${n.voted} of ${of} here ${n.voted === 1 ? 'has' : 'have'} voted</span></div>
    <div class="bm-vote__counts">${bar('for', 'For')}${bar('against', 'Against')}${bar('abstain', 'Abstain')}</div>
    ${list.length ? html`<ul class="bm-vote__who">${list.map((v) => html`<li class=${`is-${v.vote}`} key=${v.slug}>${v.name || v.slug}<span>${{ for: 'for', against: 'against', abstain: 'abstains' }[v.vote]}</span></li>`)}</ul>` : html`<p class="bd-muted">Votes show here as the board taps them on the board page.</p>`}
    <div class="bd-actions"><button type="button" class="btn btn-primary btn-sm" onClick=${() => setNow((y) => closeVote(y, live, practice))}>Close the vote</button><span class="bd-muted">${n.for > n.against ? 'It passes as it stands.' : n.voted ? 'It doesn’t pass as it stands.' : ''}</span></div>
  </div>`;
}

// ─── After ──────────────────────────────────────────────────────────

/** The minutes, as the board will read them on their page */
function MinutesDoc({ m }) {
  const groups = [['Present', 'present'], ['By video', 'remote'], ['Absent', 'absent'], ['Excused', 'excused']].map(([t, s]) => [t, m.attendance.filter((x) => x.status === s)]).filter(([, l]) => l.length);
  const written = m.sections.some((s) => s.items.some((it) => it.notes)) || m.motions.length || m.actions.length;
  const minutesFile = m.files.filter((f) => f.kind === 'minutes').at(-1);
  const vf = viewerFiles(minutesFile ? [minutesFile] : []);
  return html`<div class="card bm-doc">
    <div class="bd-card-head"><h3>The minutes ${m.minutes === 'approved' ? html`<span class="tag tag--success">Approved${m.approvedOn ? ` ${shortDate(m.approvedOn)}` : ''}</span>` : html`<span class="tag">Draft</span>`}</h3>
      <p>${m.shared ? 'This is what board members read on their page.' : 'What board members will read once you share the meeting.'}${m.minutesFrom ? ` Read from ${fileTitle(m.minutesFrom.name)}.` : minutesFile ? html` Written up in <a class="link" ...${viewerLink(vf, 0)}>${fileTitle(minutesFile.name)}</a>.` : ''}</p></div>
    ${groups.length ? html`<dl class="bm-who bm-who--doc">${groups.map(([t, l]) => html`<div><dt>${t} <b>${l.length}</b></dt><dd>${l.map((x) => x.name).join(', ')}</dd></div>`)}</dl>` : null}
    ${written ? html`<ol class="bm-doc__sections">${m.sections.map((s) => html`<li key=${s.id}>
      <h4>${s.title}</h4>
      ${s.items.length ? html`<ul class="bm-doc__items">${s.items.map((it) => html`<li key=${it.id}>
        <div class="bm-doc__item">${it.title}${it.presenter ? html`<span class="ag-item__who">${it.presenter}</span>` : null}${it.confidential ? html` <span class="tag tag--warn">Board only</span>` : null}</div>
        <${Notes} text=${it.notes} />
      </li>`)}</ul>` : null}
    </li>`)}</ol>
    ${m.motions.length ? html`<h4 class="bm-doc__h">Decisions</h4><ul class="bm-doc__items">${m.motions.map((x) => html`<li key=${x.id}>${x.text} <span class="bd-muted">(${[x.by && `moved by ${x.by}`, x.second && `seconded by ${x.second}`, x.tally ? tallyText(x) : RESULTS.find((r) => r.id === x.result)?.label.toLowerCase()].filter(Boolean).join(', ')})</span></li>`)}</ul>` : null}
    ${m.actions.length ? html`<h4 class="bm-doc__h">Action items</h4><ul class="bm-doc__items">${m.actions.map((a) => html`<li key=${a.id}>${a.text} <span class="bd-muted">(${[a.ownerName || 'no one yet', a.due ? `by ${shortDate(a.due)}` : '', a.done ? 'done' : ''].filter(Boolean).join(', ')})</span></li>`)}</ul>` : null}`
      : html`<div class="empty empty--inline"><p class="empty__title">Nothing here yet</p><p class="empty__text">Drop the minutes in (above): who was there, what was said under each item, the decisions and the action items fill in by themselves.</p></div>`}
  </div>`;
}

/** "10 of 12 board members there, notes under 9 items, 3 decisions and 2 action items" */
function readWords(r) {
  if (!r) return '';
  const parts = [
    r.attendance?.of ? `${r.attendance.here} of ${r.attendance.of} board members there` : '',
    r.notes ? `notes under ${plural(r.notes, 'item')}` : '',
    r.motions ? plural(r.motions, 'decision') : '',
    r.actions ? plural(r.actions, 'action item') : '',
  ].filter(Boolean);
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0] || 'nothing Board could use';
}

/**
 * The minutes, dropped in: uploaded, then read into the meeting by the server straight away (who was there, the
 * notes under each item, the decisions, the action items). Undo puts back what was there
 */
function MinutesDrop({ m, set, ctx, act, keepSaved }) {
  const { addToast } = ctx;
  const [busy, setBusy] = useState(false);
  const [over, setOver] = useState(false);
  const [lastRead, setLastRead] = useState(null);
  const c = attendanceCounts(m);
  const readIn = async (file) => {
    if (!file) return;
    setBusy(true);
    const up = await upload(file, { ownerType: 'meeting', ownerId: m.id, kind: 'minutes' });
    if (!up.ok) { setBusy(false); addToast(up.error, 'error'); return; }
    keepSaved((x) => ({ ...x, files: [...x.files, up.file] }));
    const before = { sections: m.sections, attendance: m.attendance, motions: m.motions, actions: m.actions };
    const j = await act({ action: 'read-minutes', id: m.id, fileId: up.file.id });
    setBusy(false);
    if (!j) return;
    if (j.approvedPrev) ctx.load();
    setLastRead({ name: up.file.name, read: j.read });
    addToast(`Read from the minutes: ${readWords(j.read)}`, 'info', { label: 'Undo', fn: () => { set(before); setLastRead(null); } });
  };
  return html`<label class=${`bm-minutes-drop ${over ? 'is-over' : ''} ${busy ? 'is-busy' : ''} ${m.minutesFrom ? 'is-done' : ''}`}
    onDragOver=${(e) => { e.preventDefault(); setOver(true); }} onDragLeave=${() => setOver(false)} onDrop=${(e) => { e.preventDefault(); setOver(false); readIn(e.dataTransfer.files[0]); }}>
    <input type="file" class="sr-only" accept=".pdf,.docx" disabled=${busy} onChange=${(e) => { readIn(e.target.files[0]); e.target.value = ''; }} />
    <span class="bm-minutes-drop__icon" aria-hidden="true">${m.minutesFrom && !busy ? CHECK : html`<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3.5H6.5a1 1 0 0 0-1 1v15a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V8z" /><path d="M14 3.5V8h4.5M12 17v-6M9.5 13.5 12 11l2.5 2.5" /></svg>`}</span>
    <span class="bm-minutes-drop__text">
      <strong>${busy ? 'Reading the minutes…' : m.minutesFrom ? 'Read from the minutes' : 'Drop the minutes here'}</strong>
      <span>${busy ? 'Who was there, the notes under each item, the decisions and the action items.'
        : lastRead ? `${fileTitle(lastRead.name)}: ${readWords(lastRead.read)}.`
        : m.minutesFrom ? `${fileTitle(m.minutesFrom.name)}${c.board ? `: ${c.boardHere} of ${c.board} board members there` : ''}. Drop a newer copy to read it again.`
        : 'A PDF or Word file. Board fills in who was there, the notes under each item, the decisions and the action items by itself.'}</span>
    </span>
    ${busy ? html`<span class="spinner" aria-hidden="true"></span>` : html`<span class="btn btn-ghost btn-sm" aria-hidden="true">${m.minutesFrom ? 'Another copy' : 'Choose the file'}</span>`}
  </label>`;
}

function WrapUp({ m, set, ctx, act, save, keepSaved }) {
  const { data, addToast } = ctx;
  const [working, setWorking] = useState('');
  const approved = m.minutes === 'approved';
  const next = nextMeeting(data.meetings.filter((x) => x.date > m.date));
  const signed = m.files.filter((f) => f.kind === 'signed').at(-1);
  const send = async (test) => { setWorking(test ? 'preview' : 'send'); const j = await act({ action: 'send-minutes', id: m.id, test }); setWorking(''); if (j) addToast(test ? `Sent to ${j.to?.[0] || 'you'}` : `Emailed ${plural(j.sent, 'board member')}`, 'info'); };
  const share = async (v) => { set({ shared: v }); await new Promise((r) => setTimeout(r, 0)); await save(); };
  const takeSigned = async (file) => {
    if (!file) return;
    setWorking('signed');
    const up = await upload(file, { ownerType: 'meeting', ownerId: m.id, kind: 'signed' });
    setWorking('');
    if (!up.ok) { addToast(up.error, 'error'); return; }
    keepSaved((x) => ({ ...x, files: [...x.files, up.file] }));
  };
  const vf = viewerFiles([signed].filter(Boolean));
  const [sShared, sApproved] = statesOf([m.shared, approved]);
  return html`<div class="card bm-check">
    <div class="bd-card-head"><h3>After the meeting</h3><p>${approved ? 'Done: the minutes are approved.' : 'Drop the minutes in and Board does the rest. The board approves them at the next meeting.'}</p></div>
    <ol class="bm-tasks">
      <${Task} state=${sShared} title=${m.shared ? 'On the board page' : 'Share them with the board'} sub=${m.shared ? (m.minutesSentAt ? `The board was told ${ago(m.minutesSentAt)}.` : 'The board can read them now.') : 'As draft minutes until they’re approved.'}>
        ${m.shared ? null : html`<button class=${btn(sShared)} onClick=${() => share(true)}>Share with the board</button>`}
        <button class="btn btn-ghost btn-sm" disabled=${!!working || !data.setup.email} onClick=${() => send(true)}>${working === 'preview' ? 'Sending…' : 'Send it to me'}</button>
        <button class="btn btn-ghost btn-sm" disabled=${!!working || !m.shared || !data.packetTo || !data.setup.email} onClick=${() => send(false)}>${working === 'send' ? 'Sending…' : m.minutesSentAt ? 'Email the board again' : 'Email the board'}</button>
      </${Task}>
      <${Task} state=${sApproved} title=${approved ? `Approved${m.approvedOn ? ` ${shortDate(m.approvedOn)}` : ''}` : 'The board approves them'} sub=${approved ? 'Marked on the board page.' : next ? `On the agenda of the ${meetingName(next)} (${shortDate(next.date)}). Its minutes mark these approved by themselves.` : 'At the next meeting: its agenda asks for this approval.'}>
        ${approved ? html`<button class="btn btn-ghost btn-sm" onClick=${() => set({ minutes: 'draft', approvedOn: '' })}>Mark as draft</button>` : html`<button class="btn btn-ghost btn-sm" onClick=${() => set({ minutes: 'approved', approvedOn: todayEastern() })}>They’re approved</button>`}
      </${Task}>
      <${Task} state=${signed ? 'done' : 'todo'} title=${signed ? 'Signed copy kept' : 'The signed copy (optional)'} sub=${signed ? html`<a class="link" ...${viewerLink(vf, 0)}>${fileTitle(signed.name)}</a>` : 'The secretary’s signed minutes, as a PDF or a photo.'}>
        <label class="btn btn-ghost btn-sm">${working === 'signed' ? 'Uploading…' : signed ? 'Replace it' : 'Upload it'}<input type="file" hidden accept=".pdf,.jpg,.jpeg,.png,.heic,.docx" onChange=${(e) => { takeSigned(e.target.files[0]); e.target.value = ''; }} /></label>
      </${Task}>
    </ol>
  </div>`;
}
