/**
 * Board → one meeting (#board/meeting/<id>/<before|during|after>)
 * ===========================================================================
 * A meeting in the three stages it goes through, opening on the one its date
 * is in. Each stage is a main column (what's being written) beside a
 * checklist of what's left, the next thing first:
 *   Before   the agenda (a draft from the last one until someone writes it
 *            or it's emailed in) and the files; beside them the invite, the
 *            agenda, the numbers, the board page, the documents email, and
 *            who's coming
 *   During   attendance as a check-off with the quorum, notes under each
 *            item, motions and votes, action items
 *   After    the minutes as the board will read them, and the files; beside
 *            them written, attendance (Google Meet fills in who joined),
 *            shared, emailed, approved, the signed copy
 * Everything saves by itself a moment after a change (no Save button to
 * forget in a meeting). Two people editing at once merge item by item
 * (mergeMeeting); only the same thing changed both ways asks.
 * Server: /api/board-admin. Rules: ./board-shared.js. Shared bits: ./board-ui.js.
 */

import { useState, useEffect, useRef, useMemo } from './vendor.js';
import { ask } from './ask.js';
import { viewerLink, sizeText } from './file-viewer.js';
import {
  html, call, upload, ago, savedAt, firstOf, youAnd, hashFor, PAGE, viewerFiles, CHECK, LiveBox, NotesBox, Menu, callName, daysFrom, whenWords, Notes,
} from './board-ui.js';
import {
  RESULTS, FILE_KINDS, LIVE, cleanMeeting, meetingName, quarterOf, longDate, shortDate, timeRange, plural, uid,
  todayEastern, attendanceCounts, liveLines, answerOf, repliesOf, fileTitle, mergeMeeting, nextMeeting, agendaIsDraft,
} from './board-shared.js';

// What a person edits (the server keeps files, the packet's numbers and sent records, and done ticks)
const EDITABLE = ['date', 'start', 'end', 'title', 'location', 'address', 'video', 'shared', 'minutes', 'approvedOn', 'attendance', 'sections', 'motions', 'actions'];
const editable = (m) => {
  const c = cleanMeeting(m);
  return JSON.stringify(EDITABLE.map((f) => (f === 'actions' ? c.actions.map(({ done, doneOn, ...a }) => a) : f === 'attendance' ? c.attendance.map(({ rsvp, ...p }) => p) : c[f])));
};
const stepFor = (m) => { const t = todayEastern(); return !m.date || m.date > t ? 'before' : m.date === t ? 'during' : 'after'; };
const blankItem = () => ({ id: uid('i_'), title: '', presenter: '', notes: '', staffNote: '', confidential: false, live: '' });
const move = (list, i, d) => { const out = [...list]; const [x] = out.splice(i, 1); out.splice(i + d, 0, x); return out; };
const STAGES = [['before', 'Before', 'Getting ready'], ['during', 'During', 'In the meeting'], ['after', 'After', 'The minutes']];

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
  const step = asked || stepFor(meeting);
  const setStep = (s) => { history.replaceState(null, '', hashFor({ meetingId: m.id, step: s })); ctx.setStep(s); window.scrollTo({ top: 0 }); };
  const set = (patch) => setM((x) => ({ ...x, ...(typeof patch === 'function' ? patch(x) : patch) }));
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
    timer.current = setTimeout(save, 1200);
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
  const p = { m, set, ctx, act, save, numbers, people, keepSaved, saved, setStep, openWhere: () => setEditWhere(true) };

  const subs = {
    before: m.packetSentAt ? `Documents emailed ${shortDate(m.packetSentAt.slice(0, 10))}` : m.shared ? 'On the board page' : 'Agenda, invite, documents',
    during: c.boardHere ? `${c.boardHere} of ${c.board} board members there` : 'Attendance and notes',
    after: m.minutes === 'approved' ? `Approved${m.approvedOn ? ` ${shortDate(m.approvedOn)}` : ''}` : m.files.some((f) => f.kind === 'minutes') ? 'Minutes in, not approved yet' : 'Written, shared, approved',
  };
  const done = { before: !!m.packetSentAt, during: c.boardHere > 0, after: m.minutes === 'approved' };
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
          <a class="btn btn-ghost btn-sm" href=${`${PAGE}#/meetings/${m.id}`} target="_blank" rel="noopener">See it as the board does</a>
          <${Menu} label="More for this meeting" items=${[{ label: 'Delete this meeting', danger: true, run: remove }]} />
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
      <div class="bm-stages" role="tablist" aria-label="This meeting">
        ${STAGES.map(([id, t, s], i) => html`<button type="button" role="tab" aria-selected=${step === id} class=${`bm-stage ${done[id] ? 'is-done' : ''}`} onClick=${() => setStep(id)}>
          <span class="bm-stage__n" aria-hidden="true">${done[id] ? CHECK : i + 1}</span>
          <span style="min-width:0"><span class="bm-stage__t">${t}<span class="bm-stage__what"> · ${s}</span></span><span class="bm-stage__s">${subs[id]}</span></span>
        </button>`)}
      </div>
    </div>
    ${editWhere ? html`<${WhenWhere} ...${p} />` : null}
    <div class="bm-layout" role="tabpanel">
      ${step === 'before' ? html`
        <div class="bm-main"><${AgendaEditor} ...${p} /><${FilesCard} ...${p} title="Files for the board" sub="The financial statements, the budget, a deck: PDFs, pictures, Word, Excel or PowerPoint, up to 50 MB. They go with the documents email." /></div>
        <aside class="bm-aside"><${GettingReady} ...${p} /><${Coming} ...${p} /></aside>`
      : step === 'during' ? html`
        <div class="bm-main"><${Attendance} ...${p} /><${RunNotes} ...${p} /><${Motions} ...${p} /><${Actions} ...${p} /></div>
        <aside class="bm-aside"><${Quorum} ...${p} /></aside>`
      : html`
        <div class="bm-main"><${MinutesDoc} ...${p} /><${FilesCard} ...${p} title="Every file" sub="All of this meeting’s files. A staff-only file never reaches the board page." /></div>
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
  const ahead = !m.date || m.date >= todayEastern();
  if (agendaIsDraft(m)) {
    const from = f?.kind === 'last-meeting' ? `Drafted from the ${f.name} agenda.` : 'SOARD’s usual outline.';
    return { draft: true, label: 'Draft', text: ahead ? `${from} This is the meeting’s agenda: change what you need here, then use it. The board reads it on their page and in the documents email.` : from };
  }
  if (f?.kind === 'email') return { draft: false, label: 'From email', text: `From ${fileTitle(f.name)}, emailed${f.at ? ` ${shortDate(f.at.slice(0, 10))}` : ''}.` };
  if (f?.kind === 'drive') return { draft: false, label: 'From the minutes', text: `Read from ${fileTitle(f.name)} in Google Drive.` };
  return { draft: false, label: 'Written', text: '' };
}

/** The agenda, as it reads: numbered sections, their items and who presents each, all editable in place */
function AgendaEditor({ m, set, ctx }) {
  const setSection = (si, patch) => set((x) => ({ sections: x.sections.map((s, i) => (i === si ? { ...s, ...patch } : s)) }));
  const setItem = (si, ii, patch) => set((x) => ({ sections: x.sections.map((s, i) => (i === si ? { ...s, items: s.items.map((it, j) => (j === ii ? { ...it, ...patch } : it)) } : s)) }));
  const others = youAnd(ctx.data.settings.admins, ctx.data.me);
  const src = agendaSource(m);
  const itemMenu = (s, si, it, ii) => html`<${Menu} label=${`More for ${it.title || 'this item'}`} items=${[
    !it.presenter && !it.showWho && { label: 'Add who presents', run: () => setItem(si, ii, { showWho: true }) },
    { label: 'Move up', disabled: ii === 0, run: () => setSection(si, { items: move(s.items, ii, -1) }) },
    { label: 'Move down', disabled: ii === s.items.length - 1, run: () => setSection(si, { items: move(s.items, ii, 1) }) },
    { label: it.notes || it.showNotes ? 'Remove the background' : 'Add background for the board', run: () => setItem(si, ii, it.notes || it.showNotes ? { notes: '', showNotes: false } : { showNotes: true }) },
    { label: it.confidential ? 'Not board only' : 'Board only (never emailed)', run: () => setItem(si, ii, { confidential: !it.confidential }) },
    { label: it.staffNote || it.showStaff ? 'Remove your private note' : `A private note (only ${others})`, run: () => setItem(si, ii, it.staffNote || it.showStaff ? { staffNote: '', showStaff: false } : { showStaff: true }) },
    ...[{ id: '', label: 'No live numbers' }, ...LIVE].filter((l) => l.id !== it.live && l.id !== 'minutes').map((l) => ({ label: l.id ? `Show ${l.label.toLowerCase()}` : 'Show no live numbers', run: () => setItem(si, ii, { live: l.id }) })),
    { label: 'Delete the item', danger: true, run: async () => { if (!it.notes || await ask({ title: `Delete “${it.title || 'this item'}”?`, text: 'Its notes go with it.', yes: 'Delete', danger: true })) setSection(si, { items: s.items.filter((_, j) => j !== ii) }); } },
  ]} />`;
  return html`<div class="card">
    <div class="bd-card-head"><h3>Agenda <span class=${`tag ${src.draft ? 'tag--warn' : src.label === 'From email' ? 'tag--info' : 'tag--success'}`}>${src.label}</span></h3>${src.text ? html`<p>${src.text}</p>` : null}</div>
    <div class="ag">
      ${m.sections.map((s, si) => html`<section class="ag-sec" key=${s.id}>
        <div class="ag-sec__head">
          <span class="ag-num" aria-hidden="true">${si + 1}</span>
          <input class="ag-input ag-input--sec" aria-label=${`Section ${si + 1}`} value=${s.title} placeholder="Section name" onInput=${(e) => setSection(si, { title: e.target.value })} />
          <${Menu} label=${`More for the section ${s.title}`} items=${[
            { label: 'Move up', disabled: si === 0, run: () => set((x) => ({ sections: move(x.sections, si, -1) })) },
            { label: 'Move down', disabled: si === m.sections.length - 1, run: () => set((x) => ({ sections: move(x.sections, si, 1) })) },
            { label: 'Delete the section', danger: true, run: async () => { if (!s.items.some((it) => it.notes) || await ask({ title: `Delete “${s.title || 'this section'}”?`, text: 'Its items and their notes go with it.', yes: 'Delete', danger: true })) set((x) => ({ sections: x.sections.filter((_, i) => i !== si) })); } },
          ]} />
        </div>
        <ul class="ag-items">
          ${s.items.map((it, ii) => html`<li class="ag-item" key=${it.id}>
            <div class="ag-item__row">
              <span class="ag-dot" aria-hidden="true"></span>
              <input class="ag-input" aria-label="Item" value=${it.title} placeholder="Item" onInput=${(e) => setItem(si, ii, { title: e.target.value })} />
              <input class=${`ag-input ag-input--who ${it.showWho ? 'is-shown' : ''}`} aria-label="Presented by" value=${it.presenter} placeholder="Who presents" list="bd-people-first" autofocus=${!!it.showWho && !it.presenter} onInput=${(e) => setItem(si, ii, { presenter: e.target.value })} />
              ${itemMenu(s, si, it, ii)}
            </div>
            ${it.confidential || (it.live && it.live !== 'minutes') ? html`<div class="ag-tags">
              ${it.confidential ? html`<span class="tag tag--warn">Board only</span>` : null}
              ${it.live && it.live !== 'minutes' ? html`<span class="tag tag--info">${LIVE.find((l) => l.id === it.live)?.label}</span>` : null}
            </div>` : null}
            ${it.notes || it.showNotes ? html`<${NotesBox} label=${`Background for ${it.title || 'this item'}`} value=${it.notes} placeholder="Background for the board" onChange=${(v) => setItem(si, ii, { notes: v })} />` : null}
            ${it.staffNote || it.showStaff ? html`<p class="bd-private-label">Only ${others} see this</p><${NotesBox} tone="is-private" label="Your private note" value=${it.staffNote} placeholder="A private note" onChange=${(v) => setItem(si, ii, { staffNote: v })} />` : null}
          </li>`)}
          <li><button type="button" class="ag-add" onClick=${() => setSection(si, { items: [...s.items, blankItem()] })}>+ Add an item</button></li>
        </ul>
      </section>`)}
      <button type="button" class="ag-add ag-add--sec" onClick=${() => set((x) => ({ sections: [...x.sections, { id: uid('s_'), title: '', items: [blankItem()] }] }))}>+ Add a section</button>
    </div>
    <datalist id="bd-people-first">${[...new Set(ctx.data.people.board.concat(ctx.data.people.staff).map((x) => x.name.split(' ')[0]))].map((n) => html`<option value=${n} />`)}</datalist>
  </div>`;
}

// ─── Files ──────────────────────────────────────────────────────────

function FilesCard({ m, ctx, keepSaved, title, sub }) {
  const { addToast } = ctx;
  const [uploading, setUploading] = useState(0);
  const add = async (list) => {
    const files = [...(list || [])];
    if (!files.length) return;
    setUploading(files.length);
    const added = [];
    for (const f of files) {
      const j = await upload(f, { ownerType: 'meeting', ownerId: m.id, kind: /financ|balance|income|p&l|profit|loss|budget|statement/i.test(f.name) ? 'financials' : /minutes/i.test(f.name) ? 'minutes' : /agenda/i.test(f.name) ? 'agenda' : 'other' });
      if (j.ok) added.push(j.file); else addToast(`${f.name}: ${j.error}`, 'error');
      setUploading((n) => n - 1);
    }
    keepSaved((x) => ({ ...x, files: [...x.files, ...added] }));
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
  };
  const vf = viewerFiles(m.files);
  const groups = FILE_KINDS.map((k) => [k, m.files.map((f, i) => ({ f, i })).filter(({ f }) => (FILE_KINDS.some((x) => x.id === f.kind) ? f.kind : 'other') === k.id)]).filter(([, l]) => l.length);
  return html`<div class="card">
    <div class="bd-card-head"><h3>${title}${m.files.length ? html` <span class="count">${m.files.length}</span>` : null}</h3><p>${sub}</p></div>
    ${groups.map(([k, list]) => html`<div class="bf-group">
      <p class="bm-group">${k.label}</p>
      <ul class="bf-list">${list.map(({ f, i }) => html`<li class="bf-file" key=${f.id}>
        <div class="bf-file__main"><a class="bd-file-name" ...${viewerLink(vf, i)}>${fileTitle(f.name)}</a><div class="bd-row__meta">${[sizeText(f.size), f.at ? `added ${shortDate(f.at.slice(0, 10))}` : ''].filter(Boolean).join(' · ')}</div></div>
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

function GettingReady({ m, set, ctx, act, save, numbers }) {
  const { data, addToast } = ctx;
  const [working, setWorking] = useState('');
  const run = async (name, body, ok) => { setWorking(name); const j = await act(body); setWorking(''); if (j && ok) addToast(typeof ok === 'function' ? ok(j) : ok, 'info'); return j; };
  const share = async (v) => { set({ shared: v }); await new Promise((r) => setTimeout(r, 0)); await save(); };
  const facts = [liveLines('cash', numbers)[0], liveLines('projects', numbers)[0]].filter(Boolean).join(' · ');
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
  const ownCall = ['conference', 'place', 'notes'].includes(m.calendar?.callFrom);
  // The invite check found the organizer's Google account can't have transcripts: they're not promised
  const noTranscripts = !!data.google?.check && data.google.check.transcript === 'error';
  const withTranscripts = noTranscripts ? '' : ', with transcripts on';
  const docs = m.files.filter((f) => !f.staffOnly);
  const size = docs.reduce((n, f) => n + (f.size || 0), 0);
  const src = agendaSource(m);
  const [sInvite, sAgenda, sNumbers, sShared, sSent] = statesOf([!!inv && !missing.length, !src.draft, !!m.snapshot, m.shared, !!m.packetSentAt]);
  return html`<div class="card bm-check">
    <div class="bd-card-head"><h3>Getting ready</h3><p>${[sInvite, sAgenda, sNumbers, sShared, sSent].every((x) => x === 'done') ? 'All done for this meeting.' : 'Five things before the meeting, in order. Notes and board-only items are never emailed.'}</p></div>
    <ol class="bm-tasks">
      <${Task} state=${sInvite} title=${inv ? `Invite sent from ${firstOf(inv.organizer)}’s calendar` : m.calendar?.eventId ? `Finish ${firstOf(from)}’s invite` : 'Send the invite'}
        sub=${inv ? [plural(inv.guests, 'guest'), inv.meet ? 'Google Meet' : '', transcript, where, missing.length ? `${missing.length} not on it yet` : ''].filter(Boolean).join(' · ')
          : otherCall && ownCall ? `It’s on ${firstOf(from)}’s calendar with a ${otherCall} call. Board adds every board member, ${youAnd(data.settings.admins, data.me)}, the place and the agenda, and makes Google Meet the call instead${withTranscripts}.${m.calendar.callFrom === 'notes' ? ` The ${otherCall} link in its notes stays until it’s taken out there.` : ''}`
          : otherCall ? `It’s on ${firstOf(from)}’s calendar. Board adds every board member, ${youAnd(data.settings.admins, data.me)}, the place, the agenda and Google Meet${withTranscripts}. Meet replaces the ${otherCall} link from another event that day.`
          : m.calendar?.eventId ? `It’s on ${firstOf(from)}’s calendar. Board adds every board member, ${youAnd(data.settings.admins, data.me)}, ${noTranscripts ? 'Google Meet' : 'Google Meet with transcripts on'}, the place and the agenda.`
          : `From ${firstOf(from)}’s calendar to every board member and ${youAnd(data.settings.admins, data.me)}, with ${noTranscripts ? 'Google Meet' : 'Google Meet and transcripts on'} and the agenda${m.location ? `, at ${m.location}` : '. Add the place any time: the invite updates'}.`}>
        <button class=${btn(sInvite)} disabled=${!!working || !data.setup.calendar || !m.date} onClick=${() => run('invite', { action: 'send-invite', id: m.id }, (j) => `${j.meeting.invite?.guests ? plural(j.meeting.invite.guests, 'guest') : 'The invite'} on ${firstOf(j.meeting.invite?.organizer)}’s calendar`)}>
          ${working === 'invite' ? 'Sending…' : !inv ? (otherCall ? 'Add everyone, switch to Meet' : m.calendar?.eventId ? 'Add everyone and Meet' : 'Send the invite') : missing.length ? `Add the ${missing.length === 1 ? 'one' : missing.length} missing` : 'Update the invite'}</button>
      </${Task}>
      <${Task} state=${sAgenda} title=${src.draft ? 'Write the agenda' : 'The agenda is set'}
        sub=${src.draft ? `Start from the draft${m.agendaFrom?.kind === 'last-meeting' ? ` (from the ${m.agendaFrom.name} agenda)` : ''}: change what you need, then use it. Any change makes it this meeting’s.` : `Changes go on the board page as you make them${inv ? ', and onto the invite without emailing anyone' : ''}.`}>
        ${src.draft ? html`<button class=${btn(sAgenda)} disabled=${!!working} onClick=${() => run('agenda', { action: 'keep-agenda', id: m.id }, 'The agenda is set')}>${working === 'agenda' ? 'Saving…' : 'Use this agenda'}</button>` : null}
      </${Task}>
      <${Task} state=${sNumbers} title=${m.snapshot ? `Numbers locked ${shortDate(m.snapshot.at.slice(0, 10))}` : 'Lock today’s numbers'} sub=${facts || (numbers?.mercury?.empty ? 'Makeovers, reveals and events (Mercury is empty so far)' : 'Makeovers, reveals and events, as of today')}>
        <button class=${btn(sNumbers)} disabled=${!!working} onClick=${() => run('snapshot', { action: 'snapshot', id: m.id }, 'Today’s numbers are locked in')}>${working === 'snapshot' ? 'Locking…' : m.snapshot ? 'Update to today’s' : 'Lock them'}</button>
      </${Task}>
      <${Task} state=${sShared} title=${m.shared ? 'On the board page' : 'Put it on the board page'} sub=${m.shared ? 'Board members see the agenda, notes, votes and files (not staff-only ones).' : 'Board members see nothing of this meeting until then.'}>
        ${m.shared ? html`<button class="btn btn-ghost btn-sm" onClick=${() => share(false)}>Take it off</button>` : html`<button class=${btn(sShared)} onClick=${() => share(true)}>Share with the board</button>`}
      </${Task}>
      <${Task} state=${sSent} title=${m.packetSentAt ? `Documents emailed to ${plural(m.packetSentTo, 'board member')}` : 'Email the board the documents'}
        sub=${m.packetSentAt ? ago(m.packetSentAt) : `The agenda and a link to the board page${docs.length ? `, with ${plural(docs.length, 'file')} attached (${sizeText(size)})` : ' (no files yet)'}, plus one-tap “Will you be there?” buttons for anyone who hasn’t answered. To ${plural(data.packetTo, 'board member')}${data.setup.email ? '' : ' · email isn’t set up'}.`}>
        <button class="btn btn-ghost btn-sm" disabled=${!!working || !data.setup.email} onClick=${() => run('preview', { action: 'send-packet', id: m.id, test: true }, (j) => `Sent to ${j.to?.[0] || 'you'}${j.attached ? ` with ${plural(j.attached, 'file')}` : ''}`)}>${working === 'preview' ? 'Sending…' : 'Send it to me'}</button>
        <button class=${btn(sSent)} disabled=${!!working || !m.shared || !data.packetTo || !data.setup.email} title=${m.shared ? '' : 'Share it first'}
          onClick=${async () => { if (await ask({ title: `Email ${plural(data.packetTo, 'board member')} the documents?`, text: `The agenda, a link to the board page${docs.length ? `, ${plural(docs.length, 'file')} attached` : ''}, and one-tap answers for anyone who hasn’t said whether they’re coming.`, yes: m.packetSentAt ? 'Email them again' : 'Email the board' })) run('send', { action: 'send-packet', id: m.id }, (j) => `Emailed ${plural(j.sent, 'board member')}`); }}>${working === 'send' ? 'Sending…' : m.packetSentAt ? 'Email again' : 'Email the documents'}</button>
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

const ORDER = { Coming: 0, 'By video': 1, Maybe: 2, '': 3, 'Can’t come': 4 };
const CHOICES = [['present', 'Here'], ['remote', 'Video'], ['absent', 'Absent'], ['excused', 'Excused']];

/** The quorum, beside the meeting as it runs */
function Quorum({ m, set, ctx }) {
  const quorum = ctx.data.settings.quorum;
  const c = attendanceCounts(m);
  const answer = (x) => answerOf(x.rsvp, repliesOf(m)[x.slug]);
  const yes = m.attendance.filter((x) => ['Coming', 'By video'].includes(answer(x)) && !x.status);
  const markYes = () => set((x) => ({ attendance: x.attendance.map((y) => (yes.some((z) => z.key === y.key) ? { ...y, status: answer(y) === 'By video' ? 'remote' : 'present' } : y)) }));
  const onMeet = /meet\.google\.com/.test(m.invite?.meet || m.video);
  return html`<div class=${`card bm-quorum ${quorum ? (c.boardHere >= quorum ? 'is-met' : 'is-short') : ''}`} role="status">
    <div class="bm-quorum__n"><b>${c.boardHere}</b> of ${c.board}</div>
    <div class="bm-quorum__t">board members here${c.remote ? ` (${c.remote} by video)` : ''}</div>
    <p class="bm-quorum__q">${quorum ? (c.boardHere >= quorum ? `Quorum met: ${quorum} needed.` : `Quorum is ${quorum}: ${quorum - c.boardHere} more needed.`) : html`No quorum set. <a class="link" href="#board/settings">Set it</a>`}</p>
    ${yes.length ? html`<button class="btn btn-primary btn-sm" onClick=${markYes}>Mark the ${yes.length === 1 ? 'one' : yes.length} who said yes as here</button>` : null}
    ${onMeet ? html`<p class="bd-muted" style="margin-top:0.75rem">On Google Meet: after the meeting Board marks who joined by video, by itself. Mark the people in the room.</p>` : null}
  </div>`;
}

function Attendance({ m, set, people }) {
  const answer = (x) => answerOf(x.rsvp, repliesOf(m)[x.slug]);
  const mark = (key, v) => set((x) => ({ attendance: x.attendance.map((y) => (y.key === key ? { ...y, status: y.status === v ? '' : v } : y)) }));
  const row = (x) => html`<li class="bm-person" key=${x.key}>
    <div class="bm-person__who"><div class="bm-person__name">${x.name}</div><div class="bm-person__meta">${[x.kind === 'board' ? x.org : x.kind === 'staff' ? 'SOARD' : `Guest${x.org ? `, ${x.org}` : ''}`, answer(x) ? `said ${answer(x).toLowerCase()}` : ''].filter(Boolean).join(' · ')}</div></div>
    <div class="bm-choices" role="group" aria-label=${`${x.name} is`}>
      ${CHOICES.map(([v, l]) => html`<button type="button" class=${`bm-choice is-${v}`} aria-pressed=${x.status === v} onClick=${() => mark(x.key, v)}>${l}</button>`)}
    </div>
  </li>`;
  const board = m.attendance.filter((x) => x.kind === 'board').sort((a, b) => (ORDER[answer(a)] ?? 3) - (ORDER[answer(b)] ?? 3));
  const rest = m.attendance.filter((x) => x.kind !== 'board');
  return html`<div class="card">
    <div class="bd-card-head"><h3>Attendance</h3><p>Tap each person as the meeting starts: here, on video, absent or excused. Every tap saves.</p></div>
    <ul class="bm-people">${board.map(row)}</ul>
    ${rest.length ? html`<p class="bm-group">Staff and guests</p><ul class="bm-people">${rest.map(row)}</ul>` : null}
    <${AddPerson} people=${people} present=${m.attendance} onAdd=${(x) => set((y) => ({ attendance: [...y.attendance, x] }))} />
  </div>`;
}

function AddPerson({ people, present, onAdd }) {
  const [name, setName] = useState('');
  const known = people.find((x) => x.name.toLowerCase() === name.trim().toLowerCase());
  const here = new Set(present.map((x) => x.slug).filter(Boolean));
  const add = () => {
    if (!name.trim()) return;
    onAdd(known && !here.has(known.slug) ? { key: known.slug, slug: known.slug, name: known.name, org: known.org, kind: known.kind, status: 'present', rsvp: '' } : { key: `guest:${name.trim().toLowerCase()}`, name: name.trim(), org: '', kind: 'guest', status: 'present', rsvp: '' });
    setName('');
  };
  return html`<div class="bd-inline" style="margin-top:0.85rem">
    <input class="form-input" aria-label="Add someone who’s here" placeholder="Add a guest or a board member" list="bd-add-people" value=${name} onInput=${(e) => setName(e.target.value)} onKeyDown=${(e) => { if (e.key === 'Enter') add(); }} style="min-width:15rem" />
    <button class="btn btn-ghost btn-sm" disabled=${!name.trim()} onClick=${add}>Add</button>
    <datalist id="bd-add-people">${people.filter((x) => !here.has(x.slug)).map((x) => html`<option value=${x.name} />`)}</datalist>
  </div>`;
}

/** Notes under each agenda item, as the meeting goes */
function RunNotes({ m, set, ctx, numbers }) {
  const { data } = ctx;
  const setItem = (si, ii, patch) => set((x) => ({ sections: x.sections.map((s, i) => (i === si ? { ...s, items: s.items.map((it, j) => (j === ii ? { ...it, ...patch } : it)) } : s)) }));
  const others = youAnd(data.settings.admins, data.me);
  const prevName = (id) => { const x = data.meetings.find((y) => y.id === id); return x ? meetingName(x) : 'the last meeting'; };
  // The last meeting's minutes, approved here: that meeting is marked, and the vote goes in this one's motions
  const approve = async (it) => {
    const prev = data.meetings.find((y) => y.id === it.about);
    const j = await call({ action: 'approve-minutes', id: it.about, on: m.date });
    if (!j.ok) { ctx.addToast(j.error, 'error'); return; }
    set((x) => ({ motions: [...x.motions, { id: uid('v_'), text: `Approve the minutes of the ${prevName(it.about)}`, by: '', second: '', result: 'passed' }] }));
    ctx.putMeeting(j.meeting);
    ctx.addToast(`The ${prev ? meetingName(prev) : 'last meeting'}’s minutes are approved`, 'info');
  };
  return html`<div class="card">
    <div class="bd-card-head"><h3>Notes</h3><p>Under each item as it’s discussed: they become the minutes, as written. A yellow note is only for ${others}.</p></div>
    <div class="ag ag--run">
      ${m.sections.map((s, si) => html`<section class="ag-sec" key=${s.id}>
        <div class="ag-sec__head"><span class="ag-num" aria-hidden="true">${si + 1}</span><h4 class="ag-sec__label">${s.title || 'Section'}</h4></div>
        ${s.items.length ? html`<ul class="ag-items">${s.items.map((it, ii) => html`<li class="ag-item" key=${it.id}>
          <div class="ag-item__name">${it.title || html`<em>No title</em>`}${it.presenter ? html`<span class="ag-item__who">${it.presenter}</span>` : null}
            ${it.confidential ? html`<span class="tag tag--warn">Board only</span>` : null}
            <button type="button" class="bm-link" onClick=${() => setItem(si, ii, it.staffNote || it.showStaff ? { staffNote: '', showStaff: false } : { showStaff: true })}>${it.staffNote || it.showStaff ? 'Remove private note' : 'Private note'}</button></div>
          <${NotesBox} label=${`Notes for ${it.title || 'this item'}`} value=${it.notes} placeholder="Notes" onChange=${(v) => setItem(si, ii, { notes: v })} />
          ${it.staffNote || it.showStaff ? html`<${NotesBox} tone="is-private" label="Your private note" value=${it.staffNote} placeholder=${`Only ${others} see this`} onChange=${(v) => setItem(si, ii, { staffNote: v })} />` : null}
          <${LiveBox} kind=${it.live} numbers=${numbers} meetingId=${m.id} locked=${!!m.snapshot} />
          ${it.live === 'minutes' && it.about ? html`<div class="bd-actions" style="margin-top:0.5rem">${data.meetings.find((y) => y.id === it.about)?.minutes === 'approved'
            ? html`<span class="tag tag--success">Approved</span>` : html`<button class="btn btn-primary btn-sm" onClick=${() => approve(it)}>The board approved them</button>`}<span class="bd-muted">${prevName(it.about)}</span></div>` : null}
        </li>`)}</ul>` : html`<p class="bd-muted ag-empty">Nothing on the agenda here.</p>`}
      </section>`)}
    </div>
  </div>`;
}

function Motions({ m, set }) {
  const here = m.attendance.filter((x) => x.status === 'present' || x.status === 'remote').map((x) => x.name);
  const names = here.length ? here : m.attendance.filter((x) => x.kind === 'board').map((x) => x.name);
  const upd = (i, patch) => set((x) => ({ motions: x.motions.map((y, j) => (j === i ? { ...y, ...patch } : y)) }));
  const who = (x, i, f, label) => html`<select class="form-select" aria-label=${label} value=${x[f]} onChange=${(e) => upd(i, { [f]: e.target.value })}>
    <option value="">${label}</option>${[...new Set([...names, x[f]].filter(Boolean))].map((n) => html`<option value=${n}>${n}</option>`)}
  </select>`;
  return html`<div class="card">
    <div class="bd-card-head"><h3>Motions and votes</h3><p>What the board voted on, for the minutes.</p></div>
    ${m.motions.length ? html`<div class="bd-lines">${m.motions.map((x, i) => html`<div class="bd-line bd-line--motion" key=${x.id}>
      <input class="form-input" aria-label="The motion" value=${x.text} placeholder="Approve the 2027 budget" onInput=${(e) => upd(i, { text: e.target.value })} />
      ${who(x, i, 'by', 'Moved by')}${who(x, i, 'second', 'Seconded by')}
      <select class="form-select" aria-label="Result" value=${x.result} onChange=${(e) => upd(i, { result: e.target.value })}>${RESULTS.map((r) => html`<option value=${r.id}>${r.label}</option>`)}</select>
      <button class="bd-icon-btn" aria-label="Delete the motion" onClick=${() => set((y) => ({ motions: y.motions.filter((_, j) => j !== i) }))}>✕</button>
    </div>`)}</div>` : null}
    <button class="btn btn-ghost btn-sm" style=${m.motions.length ? 'margin-top:0.75rem' : ''} onClick=${() => set((x) => ({ motions: [...x.motions, { id: uid('v_'), text: '', by: '', second: '', result: 'passed' }] }))}>Add a motion</button>
  </div>`;
}

function Actions({ m, set, ctx, people, keepSaved, saved }) {
  const upd = (i, patch) => set((x) => ({ actions: x.actions.map((y, j) => (j === i ? { ...y, ...patch } : y)) }));
  const savedIds = new Set(saved.current.actions.map((a) => a.id));
  const tick = async (a, isDone) => {
    const j = await call({ action: 'action-done', actionId: a.id, done: isDone });
    if (!j.ok) { ctx.addToast(j.error, 'error'); return; }
    keepSaved((x) => ({ ...x, actions: x.actions.map((y) => (y.id === a.id ? { ...y, done: isDone } : y)) }));
  };
  return html`<div class="card">
    <div class="bd-card-head"><h3>Action items</h3><p>Who does what by when. Each shows on that person’s board page, and stays on every new agenda until it’s done.</p></div>
    ${m.actions.length ? html`<div class="bd-lines">${m.actions.map((a, i) => html`<div class=${`bd-line bd-line--action ${a.done ? 'is-done' : ''}`} key=${a.id}>
      <input type="checkbox" aria-label="Done" checked=${a.done} disabled=${!savedIds.has(a.id)} title=${savedIds.has(a.id) ? 'Done' : 'Saving…'} onChange=${(e) => tick(a, e.target.checked)} />
      <input class="form-input bd-line__text" aria-label="What needs doing" value=${a.text} placeholder="What needs doing" onInput=${(e) => upd(i, { text: e.target.value })} />
      <select class="form-select" aria-label="Whose it is" value=${a.owner} onChange=${(e) => { const who = people.find((x) => x.slug === e.target.value); upd(i, who ? { owner: who.slug, ownerName: who.name } : { owner: '', ownerName: '' }); }}>
        <option value="">${a.ownerName && !a.owner ? a.ownerName : 'Whose is it?'}</option>${people.map((x) => html`<option value=${x.slug}>${x.name}</option>`)}
      </select>
      <input class="form-input" type="date" aria-label="Due" value=${a.due} onInput=${(e) => upd(i, { due: e.target.value })} />
      <button class="bd-icon-btn" aria-label="Delete the action item" onClick=${() => set((x) => ({ actions: x.actions.filter((_, j) => j !== i) }))}>✕</button>
    </div>`)}</div>` : null}
    <button class="btn btn-ghost btn-sm" style=${m.actions.length ? 'margin-top:0.75rem' : ''} onClick=${() => set((x) => ({ actions: [...x.actions, { id: uid('a_'), text: '', owner: '', ownerName: '', due: '', done: false, doneOn: '' }] }))}>Add an action item</button>
  </div>`;
}

// ─── After ──────────────────────────────────────────────────────────

/** What Google Meet said about who joined, in words (or '' when there's nothing to say) */
function meetLine(m) {
  const f = m.fromMeet;
  if (!f) return /meet\.google\.com/.test(m.invite?.meet || m.video) ? 'Google Meet’s list of who joined comes in half an hour after the meeting.' : '';
  if (f.status === 'needs-setup') return 'Who joined by Google Meet needs one more Google setting (see Meetings).';
  if (f.status === 'error') return `Google Meet didn’t say who joined: ${f.error}`;
  if (f.status === 'none') return 'Nobody joined the Google Meet.';
  const matched = f.joined.filter((j) => j.slug).length;
  return `Google Meet: ${plural(f.joined.length, 'person', 'people')} joined${matched ? `, ${matched} marked “Video” by Board` : ''}${f.joined.length > matched ? `; ${f.joined.length - matched} not on the board or staff (${f.joined.filter((j) => !j.slug).map((j) => j.name).slice(0, 4).join(', ')})` : ''}.`;
}

/** The minutes, as the board will read them on their page */
function MinutesDoc({ m, set, ctx }) {
  const groups = [['Present', 'present'], ['By video', 'remote'], ['Absent', 'absent'], ['Excused', 'excused']].map(([t, s]) => [t, m.attendance.filter((x) => x.status === s)]).filter(([, l]) => l.length);
  const written = m.sections.some((s) => s.items.some((it) => it.notes)) || m.motions.length || m.actions.length;
  const minutesFile = m.files.filter((f) => f.kind === 'minutes').at(-1);
  const vf = viewerFiles(minutesFile ? [minutesFile] : []);
  return html`<div class="card bm-doc">
    <div class="bd-card-head"><h3>The minutes ${m.minutes === 'approved' ? html`<span class="tag tag--success">Approved${m.approvedOn ? ` ${shortDate(m.approvedOn)}` : ''}</span>` : html`<span class="tag">Draft</span>`}</h3>
      <p>${m.shared ? 'This is what board members read on their page.' : 'What board members will read once you share the meeting.'}${minutesFile ? html` Written up in <a class="link" ...${viewerLink(vf, 0)}>${fileTitle(minutesFile.name)}</a>.` : ''}</p></div>
    ${groups.length ? html`<dl class="bm-who bm-who--doc">${groups.map(([t, l]) => html`<div><dt>${t} <b>${l.length}</b></dt><dd>${l.map((x) => x.name).join(', ')}</dd></div>`)}</dl>`
      : html`<p class="bd-muted">Nobody is marked as there yet.${meetLine(m) ? ` ${meetLine(m)}` : ''}</p>`}
    ${written ? html`<ol class="bm-doc__sections">${m.sections.map((s) => html`<li key=${s.id}>
      <h4>${s.title}</h4>
      ${s.items.length ? html`<ul class="bm-doc__items">${s.items.map((it) => html`<li key=${it.id}>
        <div class="bm-doc__item">${it.title}${it.presenter ? html`<span class="ag-item__who">${it.presenter}</span>` : null}${it.confidential ? html` <span class="tag tag--warn">Board only</span>` : null}</div>
        <${Notes} text=${it.notes} />
      </li>`)}</ul>` : null}
    </li>`)}</ol>
    ${m.motions.length ? html`<h4 class="bm-doc__h">Motions</h4><ul class="bm-doc__items">${m.motions.map((x) => html`<li key=${x.id}>${x.text} <span class="bd-muted">(${[x.by && `moved by ${x.by}`, x.second && `seconded by ${x.second}`, RESULTS.find((r) => r.id === x.result)?.label.toLowerCase()].filter(Boolean).join(', ')})</span></li>`)}</ul>` : null}
    ${m.actions.length ? html`<h4 class="bm-doc__h">Action items</h4><ul class="bm-doc__items">${m.actions.map((a) => html`<li key=${a.id}>${a.text} <span class="bd-muted">(${[a.ownerName || 'no one yet', a.due ? `by ${shortDate(a.due)}` : '', a.done ? 'done' : ''].filter(Boolean).join(', ')})</span></li>`)}</ul>` : null}`
      : html`<div class="empty empty--inline"><p class="empty__title">Nothing written yet</p><p class="empty__text">${minutesFile ? 'The minutes are in the file above. Read them into the meeting (on the right) so the board can read them here.' : 'Take notes in During, or upload the minutes on the right (PDF or Word): Board reads them in.'}</p></div>`}
  </div>`;
}

function WrapUp({ m, set, ctx, act, save, keepSaved, setStep }) {
  const { data, addToast } = ctx;
  const [working, setWorking] = useState('');
  const [reading, setReading] = useState(null); // { file, parsed } while a minutes file is looked over
  const approved = m.minutes === 'approved';
  const notes = m.sections.reduce((n, s) => n + s.items.filter((it) => it.notes).length, 0);
  const next = nextMeeting(data.meetings.filter((x) => x.date > m.date));
  const minutesFile = m.files.filter((f) => f.kind === 'minutes').at(-1);
  const signed = m.files.filter((f) => f.kind === 'signed').at(-1);
  const c = attendanceCounts(m);
  const send = async (test) => { setWorking(test ? 'preview' : 'send'); const j = await act({ action: 'send-minutes', id: m.id, test }); setWorking(''); if (j) addToast(test ? `Sent to ${j.to?.[0] || 'you'}` : `Emailed ${plural(j.sent, 'board member')}`, 'info'); };
  const share = async (v) => { set({ shared: v }); await new Promise((r) => setTimeout(r, 0)); await save(); };
  const take = async (file, kind) => {
    setWorking(kind);
    const up = await upload(file, { ownerType: 'meeting', ownerId: m.id, kind });
    if (!up.ok) { setWorking(''); addToast(up.error, 'error'); return; }
    keepSaved((x) => ({ ...x, files: [...x.files, up.file] }));
    if (kind === 'minutes') {
      const j = await call({ action: 'read-file', id: up.file.id });
      if (j.ok) setReading({ file: up.file, parsed: j.parsed });
      else addToast(`${j.error} The file is kept with the meeting.`, 'error');
    }
    setWorking('');
  };
  const use = async () => {
    if (notes && !(await ask({ title: 'Replace the notes with these minutes?', text: `The agenda and its notes (${plural(notes, 'item')} with notes) become what the minutes say. Votes and action items stay.`, yes: 'Use the minutes' }))) return;
    const r = reading.parsed;
    set((x) => ({ sections: r.sections, attendance: r.attendance.length ? r.attendance : x.attendance }));
    setReading(null);
    addToast('The minutes are in the meeting', 'info');
  };
  const drop = (kind) => ({
    onDragOver: (e) => { e.preventDefault(); e.currentTarget.classList.add('is-over'); },
    onDragLeave: (e) => e.currentTarget.classList.remove('is-over'),
    onDrop: (e) => { e.preventDefault(); e.currentTarget.classList.remove('is-over'); if (e.dataTransfer.files[0]) take(e.dataTransfer.files[0], kind); },
  });
  const vf = viewerFiles([minutesFile, signed].filter(Boolean));
  const [sWritten, sThere, sShared, sApproved] = statesOf([notes > 0 || !!minutesFile, c.boardHere > 0, m.shared, approved]);
  return html`<div class="card bm-check">
    <div class="bd-card-head"><h3>After the meeting</h3><p>${approved ? 'Done: the minutes are approved.' : 'The notes, attendance, votes and action items are the minutes. The board approves them at the next meeting.'}</p></div>
    <ol class="bm-tasks">
      <${Task} state=${sWritten} title=${notes ? `Written: ${plural(notes, 'item')} with notes` : minutesFile ? 'Minutes uploaded' : 'Write them'} sub=${minutesFile ? html`From <a class="link" ...${viewerLink(vf, 0)}>${fileTitle(minutesFile.name)}</a>` : notes ? 'From the notes taken in During.' : 'Take notes in During, or upload minutes written elsewhere (PDF or Word): Board reads them in.'}>
        ${!notes ? html`<button class="btn btn-ghost btn-sm" onClick=${() => setStep('during')}>Go to During</button>` : null}
        <label class=${btn(sWritten)} ...${drop('minutes')}>${working === 'minutes' ? 'Reading…' : minutesFile ? 'Upload another copy' : 'Upload the minutes'}<input type="file" hidden accept=".pdf,.docx" onChange=${(e) => { if (e.target.files[0]) take(e.target.files[0], 'minutes'); e.target.value = ''; }} /></label>
      </${Task}>
      ${reading ? html`<li class="notice notice--info" style="margin:0"><div class="notice__body">
        <strong>${fileTitle(reading.file.name)} reads as ${plural(reading.parsed.sections.length, 'section')}, ${plural(reading.parsed.sections.reduce((n, s) => n + s.items.length, 0), 'item')}${reading.parsed.attendance.length ? ` and ${plural(reading.parsed.attendance.filter((a) => a.status === 'present').length, 'person', 'people')} there` : ''}.</strong>
        <ol style="margin:0.35rem 0 0 1.1rem;padding:0">${reading.parsed.sections.map((s) => html`<li>${s.title}: ${s.items.map((it) => it.title).join(', ')}</li>`)}</ol>
      </div><div class="notice__actions"><button class="btn btn-primary btn-sm" onClick=${use}>Use these as the minutes</button><button class="btn btn-ghost btn-sm" onClick=${() => setReading(null)}>Keep the file only</button></div></li>` : null}
      <${Task} state=${sThere} title=${c.boardHere ? `${c.boardHere} of ${c.board} board members were there` : 'Who was there'} sub=${meetLine(m) || (c.boardHere ? '' : 'Mark them in During.')}>
        <button class="btn btn-ghost btn-sm" onClick=${() => setStep('during')}>${c.boardHere ? 'Check it' : 'Mark them'}</button>
      </${Task}>
      <${Task} state=${sShared} title=${m.shared ? 'On the board page' : 'Share them with the board'} sub=${m.shared ? (m.minutesSentAt ? `The board was told ${ago(m.minutesSentAt)}.` : 'The board can read them now.') : 'As draft minutes until they’re approved.'}>
        ${m.shared ? null : html`<button class=${btn(sShared)} onClick=${() => share(true)}>Share with the board</button>`}
        <button class="btn btn-ghost btn-sm" disabled=${!!working || !data.setup.email} onClick=${() => send(true)}>${working === 'preview' ? 'Sending…' : 'Send it to me'}</button>
        <button class="btn btn-ghost btn-sm" disabled=${!!working || !m.shared || !data.packetTo || !data.setup.email} onClick=${() => send(false)}>${working === 'send' ? 'Sending…' : m.minutesSentAt ? 'Email the board again' : 'Email the board'}</button>
      </${Task}>
      <${Task} state=${sApproved} title=${approved ? `Approved${m.approvedOn ? ` ${shortDate(m.approvedOn)}` : ''}` : 'The board approves them'} sub=${approved ? 'Marked on the board page.' : next ? `On the agenda of the ${meetingName(next)} (${shortDate(next.date)}): tap “The board approved them” there in During.` : 'At the next meeting: its agenda asks for this approval.'}>
        ${approved ? html`<button class="btn btn-ghost btn-sm" onClick=${() => set({ minutes: 'draft', approvedOn: '' })}>Mark as draft</button>` : html`<button class="btn btn-ghost btn-sm" onClick=${() => set({ minutes: 'approved', approvedOn: todayEastern() })}>They’re approved</button>`}
      </${Task}>
      <${Task} state=${signed ? 'done' : 'todo'} title=${signed ? 'Signed copy kept' : 'The signed copy (optional)'} sub=${signed ? html`<a class="link" ...${viewerLink(vf, vf.length - 1)}>${fileTitle(signed.name)}</a>` : 'The secretary’s signed minutes, as a PDF or a photo.'}>
        <label class="btn btn-ghost btn-sm" ...${drop('signed')}>${working === 'signed' ? 'Uploading…' : signed ? 'Replace it' : 'Upload it'}<input type="file" hidden accept=".pdf,.jpg,.jpeg,.png,.heic,.docx" onChange=${(e) => { if (e.target.files[0]) take(e.target.files[0], 'signed'); e.target.value = ''; }} /></label>
      </${Task}>
    </ol>
  </div>`;
}
