/**
 * Board → one meeting (#board/meeting/<id>/<before|during|after>)
 * ===========================================================================
 * A meeting in the three steps it goes through, opening on the one its date
 * is in:
 *   Before   when and where, the agenda, the files, the packet (numbers
 *            locked, on the board page, emailed), who's coming
 *   During   attendance as a check-off with the quorum, notes under each
 *            item, motions and votes, action items
 *   After    the minutes: shared, emailed, approved, the signed copy; or
 *            minutes written elsewhere, uploaded and read in
 * Everything saves by itself a moment after a change (no Save button to
 * forget in a meeting). Two people editing at once merge item by item
 * (mergeMeeting); only the same thing changed both ways asks.
 * Server: /api/board-admin. Rules: ./board-shared.js. Shared bits: ./board-ui.js.
 */

import { useState, useEffect, useRef, useMemo } from './vendor.js';
import { ask } from './ask.js';
import { viewerLink, sizeText } from './file-viewer.js';
import {
  html, call, upload, ago, savedAt, firstOf, youAnd, hashFor, PAGE, viewerFiles, Switch, CHECK, LiveBox, NotesBox, Menu,
} from './board-ui.js';
import {
  ATTEND, RESULTS, FILE_KINDS, LIVE, cleanMeeting, meetingName, quarterOf, longDate, shortDate, timeRange, plural, uid,
  todayEastern, attendanceCounts, liveLines, answerOf, repliesOf, fileTitle, mergeMeeting, nextMeeting,
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

export function MeetingEditor({ meeting, ctx, step: asked }) {
  const { data, addToast, go, putMeeting, markDirty } = ctx;
  const [m, setM] = useState(meeting);
  const mRef = useRef(m);
  mRef.current = m;
  const saved = useRef(cleanMeeting(meeting)); // the server's copy as last seen
  const base = useRef(meeting.updatedAt);
  const [st, setSt] = useState({ s: 'saved', at: meeting.updatedAt });
  const busy = useRef(null);
  const again = useRef(false);
  const timer = useRef(0);
  const step = asked || stepFor(meeting);
  const setStep = (s) => history.replaceState(null, '', hashFor({ meetingId: m.id, step: s })) || ctx.setStep(s);
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
        approvedOn: x.approvedOn || j.meeting.approvedOn,
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
  const p = { m, set, ctx, act, save, numbers, people, keepSaved, saved, setStep };

  const tabs = [
    { id: 'before', t: 'Before', s: m.packetSentAt ? `Packet emailed ${shortDate(m.packetSentAt.slice(0, 10))}` : m.shared ? 'On the board page' : 'Agenda, files, the packet', done: !!m.packetSentAt },
    { id: 'during', t: 'During', s: c.boardHere ? `${c.boardHere} of ${c.board} here` : 'Attendance and notes', done: c.boardHere > 0 },
    { id: 'after', t: 'After', s: m.minutes === 'approved' ? `Minutes approved${m.approvedOn ? ` ${shortDate(m.approvedOn)}` : ''}` : 'The minutes', done: m.minutes === 'approved' },
  ];
  return html`
    <div>
      <a class="bd-back" href="#board" onClick=${(e) => { e.preventDefault(); go({}); }}>← All meetings</a>
      <div class="bm-head">
        <div>
          <h2>${meetingName(m)}</h2>
          <p class="page-sub">${[longDate(m.date), timeRange(m.start, m.end), m.location].filter(Boolean).join(' · ') || 'Add the date, time and place'}</p>
        </div>
        <div class="bd-actions">
          <span class=${`bm-saved ${st.s === 'error' ? 'is-error' : ''}`} role="status" aria-live="polite">
            ${st.s === 'saving' ? 'Saving…' : st.s === 'unsaved' ? 'Saving in a moment' : st.s === 'error' ? html`Not saved: ${st.why} <button class="btn btn-ghost btn-sm" onClick=${save}>Try again</button>` : `Saved ${st.at ? savedAt(st.at) : ''}`}
          </span>
          <a class="btn btn-ghost btn-sm" href=${`${PAGE}#/meetings/${m.id}`} target="_blank" rel="noopener">See it as the board does</a>
        </div>
      </div>
      <div class="bm-steps" role="tablist" aria-label="This meeting">
        ${tabs.map((t, i) => html`<button type="button" role="tab" aria-selected=${step === t.id} class=${`bm-step-tab ${t.done ? 'is-done' : ''}`} onClick=${() => setStep(t.id)}>
          <span class="bm-step-tab__n" aria-hidden="true">${t.done ? CHECK : i + 1}</span>
          <span style="min-width:0"><span class="bm-step-tab__t">${t.t}</span><span class="bm-step-tab__s">${t.s}</span></span>
        </button>`)}
      </div>
    </div>
    <div class="bm-pane" role="tabpanel">
      ${step === 'before' ? html`
        <${WhenWhere} ...${p} />
        <${Agenda} ...${p} mode="plan" />
        <${FilesCard} ...${p} title="Files for the board" sub="The income statement and balance sheet, the budget, a deck. PDFs, pictures, Word, Excel or PowerPoint, up to 50 MB." />
        <${Packet} ...${p} />
        <${Coming} ...${p} />`
      : step === 'during' ? html`
        <${Attendance} ...${p} />
        <${Agenda} ...${p} mode="run" />
        <${Motions} ...${p} />
        <${Actions} ...${p} />`
      : html`
        <${Minutes} ...${p} />
        <${FilesCard} ...${p} title="Every file" sub="All of this meeting’s files. A staff-only file never reaches the board page." />
        <div class="card"><div class="bd-card-head--row"><div><h3>Delete this meeting</h3><p class="bd-muted">Its agenda, notes, minutes and files go for good.</p></div><button class="btn btn-ghost btn-sm btn-row-danger" onClick=${remove}>Delete meeting</button></div></div>`}
    </div>`;
}

// ─── Before ─────────────────────────────────────────────────────────

function WhenWhere({ m, set }) {
  const cal = m.calendar;
  const fromCal = !!cal && !cal.gone;
  return html`<div class="card">
    <div class="bd-card-head"><h3>When and where</h3>${cal ? html`<p>${cal.gone
      ? html`This meeting is no longer on ${firstOf(cal.from)}’s calendar. If it’s off, delete it in After.`
      : html`From ${firstOf(cal.from)}’s calendar (“${cal.title}”). Change the day, time${cal.place ? ' or place' : ''} there, and it follows here within the hour.${cal.place ? '' : ` The invite has no address${cal.said ? ` (its place says “${cal.said}”)` : ''}, so type it here or add it to the invite.`}${cal.link ? html` <a class="link" href=${cal.link} target="_blank" rel="noopener">Open the event</a>` : null}`}</p>` : null}</div>
    <div class="bd-grid3">
      <div class="form-group"><label class="form-label" for="bd-date">Date</label><input id="bd-date" class="form-input" type="date" value=${m.date} disabled=${fromCal} onInput=${(e) => set({ date: e.target.value })} /></div>
      <div class="form-group"><label class="form-label" for="bd-start">Starts</label><input id="bd-start" class="form-input" type="time" value=${m.start} disabled=${fromCal} onInput=${(e) => set({ start: e.target.value })} /></div>
      <div class="form-group"><label class="form-label" for="bd-end">Ends</label><input id="bd-end" class="form-input" type="time" value=${m.end} disabled=${fromCal} onInput=${(e) => set({ end: e.target.value })} /></div>
      <div class="form-group"><label class="form-label" for="bd-loc">Place</label><input id="bd-loc" class="form-input" value=${m.location} placeholder="Crosby Design Group" disabled=${fromCal && cal.place} onInput=${(e) => set({ location: e.target.value })} /></div>
      <div class="form-group"><label class="form-label" for="bd-addr">Address</label><input id="bd-addr" class="form-input" value=${m.address} placeholder="Street, city" disabled=${fromCal && cal.place} onInput=${(e) => set({ address: e.target.value })} /></div>
      <div class="form-group"><label class="form-label" for="bd-video">Video link</label><input id="bd-video" class="form-input" type="url" value=${m.video} placeholder="https://" disabled=${fromCal && cal.call} onInput=${(e) => set({ video: e.target.value })} /></div>
      <div class="form-group span-3"><label class="form-label" for="bd-title">Name</label><input id="bd-title" class="form-input" value=${m.title} placeholder=${m.date ? `${quarterOf(m.date)} Board Meeting` : 'Board meeting'} onInput=${(e) => set({ title: e.target.value })} /></div>
    </div>
  </div>`;
}

/** The agenda: plan (titles, presenters, order) or run (notes under each item) */
function Agenda({ m, set, ctx, numbers, mode }) {
  const { data } = ctx;
  const plan = mode === 'plan';
  const setSection = (si, patch) => set((x) => ({ sections: x.sections.map((s, i) => (i === si ? { ...s, ...patch } : s)) }));
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
  const itemMenu = (s, si, it, ii) => html`<${Menu} label=${`More for ${it.title || 'this item'}`} items=${[
    { label: 'Move up', disabled: ii === 0, run: () => setSection(si, { items: move(s.items, ii, -1) }) },
    { label: 'Move down', disabled: ii === s.items.length - 1, run: () => setSection(si, { items: move(s.items, ii, 1) }) },
    { label: it.confidential ? 'Not board only' : 'Board only (never emailed)', run: () => setItem(si, ii, { confidential: !it.confidential }) },
    { label: it.staffNote || it.showStaff ? 'Remove your private note' : 'Add a private note', run: () => setItem(si, ii, it.staffNote || it.showStaff ? { staffNote: '', showStaff: false } : { showStaff: true }) },
    ...[{ id: '', label: 'No live numbers' }, ...LIVE].filter((l) => l.id !== it.live).map((l) => ({ label: l.id ? `Show ${l.label.toLowerCase()}` : 'Show no live numbers', run: () => setItem(si, ii, { live: l.id }) })),
    { label: 'Delete the item', danger: true, run: async () => { if (!it.notes || await ask({ title: `Delete “${it.title || 'this item'}”?`, text: 'Its notes go with it.', yes: 'Delete', danger: true })) setSection(si, { items: s.items.filter((_, j) => j !== ii) }); } },
  ]} />`;
  return html`<div class="card">
    <div class="bd-card-head"><h3>${plan ? 'The agenda' : 'Notes'}</h3><p>${plan
      ? 'What the board will discuss, in order. You type notes under each item in During.'
      : `Type under each item as it’s discussed. The notes go to the board as written. Yellow notes are only for ${others}.`}</p></div>
    ${m.sections.map((s, si) => html`<div class="bd-section" key=${s.id}>
      <div class="bd-section__head">
        <span class="bd-section__num">${si + 1}.</span>
        ${plan ? html`<input class="form-input bd-section__title" aria-label=${`Section ${si + 1}`} value=${s.title} placeholder="Section" onInput=${(e) => setSection(si, { title: e.target.value })} />` : html`<span class="bd-section__label">${s.title}</span>`}
        ${plan ? html`<${Menu} label=${`More for the section ${s.title}`} items=${[
          { label: 'Move up', disabled: si === 0, run: () => set((x) => ({ sections: move(x.sections, si, -1) })) },
          { label: 'Move down', disabled: si === m.sections.length - 1, run: () => set((x) => ({ sections: move(x.sections, si, 1) })) },
          { label: 'Delete the section', danger: true, run: async () => { if (!s.items.some((it) => it.notes) || await ask({ title: `Delete “${s.title || 'this section'}”?`, text: 'Its items and their notes go with it.', yes: 'Delete', danger: true })) set((x) => ({ sections: x.sections.filter((_, i) => i !== si) })); } },
        ]} />` : null}
      </div>
      <div class="bd-items">
        ${s.items.map((it, ii) => html`<div class="bd-item" key=${it.id}>
          ${plan ? html`<div class="bd-item__top">
              <input class="form-input" aria-label="Item" value=${it.title} placeholder="Item" onInput=${(e) => setItem(si, ii, { title: e.target.value })} />
              <input class="form-input bd-presenter" aria-label="Presented by" value=${it.presenter} placeholder="Presented by" list="bd-people-first" onInput=${(e) => setItem(si, ii, { presenter: e.target.value })} />
              ${itemMenu(s, si, it, ii)}
            </div>`
            : html`<div class="bd-item__top" style="grid-template-columns:minmax(0,1fr) auto">
              <div class="bd-item__name">${it.title || html`<em>No title</em>`}${it.presenter ? html`<span class="bd-item__who">${it.presenter}</span>` : null}</div>
              ${itemMenu(s, si, it, ii)}
            </div>`}
          ${it.confidential || it.live ? html`<div class="bd-item__tags">${it.confidential ? html`<span class="tag tag--warn">Board only</span>` : null}</div>` : null}
          ${!plan || it.notes ? html`<${NotesBox} big=${!plan} label=${`Notes for ${it.title || 'this item'}`} value=${it.notes} placeholder=${plan ? 'Background for the board (optional)' : 'Notes'} onChange=${(v) => setItem(si, ii, { notes: v })} />` : null}
          ${it.staffNote || it.showStaff ? html`<p class="bd-private-label">Only ${others} see this</p><${NotesBox} tone="is-private" label="Your private note" value=${it.staffNote} placeholder="A private note" onChange=${(v) => setItem(si, ii, { staffNote: v })} />` : null}
          <${LiveBox} kind=${it.live} numbers=${numbers} meetingId=${m.id} locked=${!!m.snapshot} />
          ${it.live === 'minutes' && it.about && !plan ? html`<div class="bd-actions" style="margin-top:0.5rem">${data.meetings.find((y) => y.id === it.about)?.minutes === 'approved'
            ? html`<span class="tag tag--success">Approved</span>` : html`<button class="btn btn-primary btn-sm" onClick=${() => approve(it)}>The board approved them</button>`}<span class="bd-muted">${prevName(it.about)}</span></div>` : null}
        </div>`)}
        ${plan ? html`<button class="btn btn-ghost btn-sm" style="margin-top:0.5rem" onClick=${() => setSection(si, { items: [...s.items, blankItem()] })}>Add an item</button>` : null}
      </div>
    </div>`)}
    <datalist id="bd-people-first">${[...new Set(ctx.data.people.board.concat(ctx.data.people.staff).map((x) => x.name.split(' ')[0]))].map((n) => html`<option value=${n} />`)}</datalist>
    ${plan ? html`<button class="btn btn-ghost btn-sm" style="margin-top:0.85rem" onClick=${() => set((x) => ({ sections: [...x.sections, { id: uid('s_'), title: '', items: [blankItem()] }] }))}>Add a section</button>` : null}
  </div>`;
}

function FilesCard({ m, ctx, keepSaved, title, sub }) {
  const { addToast } = ctx;
  const [uploading, setUploading] = useState(0);
  const add = async (list) => {
    const files = [...(list || [])];
    if (!files.length) return;
    setUploading(files.length);
    const added = [];
    for (const f of files) {
      const j = await upload(f, { ownerType: 'meeting', ownerId: m.id, kind: /financ|balance|income|p&l|profit|loss|budget|statement/i.test(f.name) ? 'financials' : /minutes/i.test(f.name) ? 'minutes' : 'other' });
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
  return html`<div class="card">
    <div class="bd-card-head"><h3>${title}</h3><p>${sub}</p></div>
    ${m.files.length ? html`<div class="bd-lines">${m.files.map((f, i) => html`<div class="bd-line bd-line--file" key=${f.id}>
      <div><a class="bd-file-name" ...${viewerLink(vf, i)}>${fileTitle(f.name)}</a><div class="bd-row__meta">${[f.name, sizeText(f.size), f.at ? shortDate(f.at.slice(0, 10)) : ''].filter(Boolean).join(' · ')}</div></div>
      <select class="form-select" aria-label="What it is" value=${f.kind} onChange=${(e) => update(f, { kind: e.target.value })}>${FILE_KINDS.map((k) => html`<option value=${k.id}>${k.label}</option>`)}</select>
      <label class="bd-check"><input type="checkbox" checked=${f.staffOnly} onChange=${(e) => update(f, { staffOnly: e.target.checked })} /> Staff only</label>
      <button class="bd-icon-btn" aria-label=${`Delete ${fileTitle(f.name)}`} onClick=${() => remove(f)}>✕</button>
    </div>`)}</div>` : null}
    <div class="bd-drop" style="margin-top:0.75rem" onDragOver=${(e) => { e.preventDefault(); e.currentTarget.classList.add('is-over'); }} onDragLeave=${(e) => e.currentTarget.classList.remove('is-over')}
      onDrop=${(e) => { e.preventDefault(); e.currentTarget.classList.remove('is-over'); add(e.dataTransfer.files); }}>
      <label class="btn btn-ghost btn-sm">Add files<input type="file" multiple hidden accept=".pdf,.jpg,.jpeg,.png,.webp,.heic,.docx,.xlsx,.pptx,.doc,.xls" onChange=${(e) => { add(e.target.files); e.target.value = ''; }} /></label>
      <span class="bd-muted">${uploading ? `Uploading ${plural(uploading, 'file')}…` : 'or drop them here'}</span>
    </div>
  </div>`;
}

/** A numbered step: what it is, where it stands, its buttons */
const StepRow = ({ n, done, title, sub, children }) => html`<li class=${`bm-steprow ${done ? 'is-done' : ''}`}>
  <span class="bm-steprow__n" aria-hidden="true">${done ? CHECK : n}</span>
  <div><div class="bm-steprow__t">${title}</div>${sub ? html`<div class="bm-steprow__s">${sub}</div>` : null}</div>
  <div class="bd-actions">${children}</div>
</li>`;

function Packet({ m, set, ctx, act, save, numbers }) {
  const { data, addToast } = ctx;
  const [working, setWorking] = useState('');
  const run = async (name, body, ok) => { setWorking(name); const j = await act(body); setWorking(''); if (j && ok) addToast(typeof ok === 'function' ? ok(j) : ok, 'info'); return j; };
  const share = async (v) => { set({ shared: v }); await new Promise((r) => setTimeout(r, 0)); await save(); };
  const facts = [liveLines('cash', numbers)[0], liveLines('projects', numbers)[0]].filter(Boolean).join(' · ');
  // The invite: who's on it, and who should be
  const inv = m.invite;
  const from = inv?.organizer || m.calendar?.organizer || data.settings.invitesFrom;
  const guests = [...new Set([...data.members.map((p) => p.email).filter(Boolean), ...data.settings.admins])];
  const missing = inv ? guests.filter((e) => !(inv.emails || []).includes(e) && e !== inv.organizer) : [];
  const transcript = !inv ? '' : inv.transcript === 'on' ? 'transcript on' : inv.transcript === 'needs-setup' ? 'transcript needs one Google setting (see Meetings)' : inv.transcript === 'error' ? `transcript not set (${inv.error})` : '';
  const placeNow = [m.location, m.address].filter(Boolean).join(', ');
  const where = !inv ? '' : placeNow && placeNow !== inv.place ? 'the new place goes on it a couple of minutes after you stop typing' : inv.place ? `at ${inv.place}` : 'the place goes on it when you add one';
  const docs = m.files.filter((f) => !f.staffOnly);
  const size = docs.reduce((n, f) => n + (f.size || 0), 0);
  return html`<div class="card">
    <div class="bd-card-head"><h3>Getting ready</h3><p>Four steps before the meeting. Notes and board-only items are never emailed.</p></div>
    <ol class="bm-steplist">
      <${StepRow} n="1" done=${!!inv && !missing.length} title=${inv ? `Invite sent from ${firstOf(inv.organizer)}’s calendar` : m.calendar?.eventId ? `Finish ${firstOf(from)}’s invite` : 'Send the invite'}
        sub=${inv ? [plural(inv.guests, 'guest'), inv.meet ? 'Google Meet' : '', transcript, where, missing.length ? `${missing.length} not on it yet` : ''].filter(Boolean).join(' · ')
          : m.calendar?.eventId ? `It’s on ${firstOf(from)}’s calendar. Board adds every board member, ${youAnd(data.settings.admins, data.me)}, Google Meet with transcripts on, and the place.`
          : `From ${firstOf(from)}’s calendar to every board member and ${youAnd(data.settings.admins, data.me)}, with Google Meet and transcripts on${m.location ? `, at ${m.location}` : '. Add the place any time: the invite updates'}.`}>
        <button class=${`btn btn-sm ${inv && !missing.length ? 'btn-ghost' : 'btn-primary'}`} disabled=${!!working || !data.setup.calendar || !m.date} onClick=${() => run('invite', { action: 'send-invite', id: m.id }, (j) => `${j.meeting.invite?.guests ? plural(j.meeting.invite.guests, 'guest') : 'The invite'} on ${firstOf(j.meeting.invite?.organizer)}’s calendar`)}>
          ${working === 'invite' ? 'Sending…' : !inv ? (m.calendar?.eventId ? 'Add everyone and Meet' : 'Send the invite') : missing.length ? `Add the ${missing.length === 1 ? 'one' : missing.length} missing` : 'Update the invite'}</button>
      </${StepRow}>
      <${StepRow} n="2" done=${!!m.snapshot} title=${m.snapshot ? `Numbers locked ${shortDate(m.snapshot.at.slice(0, 10))}` : 'Lock today’s numbers'} sub=${facts || (numbers?.mercury?.empty ? 'Makeovers, reveals and events (Mercury is empty so far)' : 'Makeovers, reveals and events, as of today')}>
        <button class="btn btn-ghost btn-sm" disabled=${!!working} onClick=${() => run('snapshot', { action: 'snapshot', id: m.id }, 'Today’s numbers are locked in')}>${working === 'snapshot' ? 'Locking…' : m.snapshot ? 'Update to today’s' : 'Lock them'}</button>
      </${StepRow}>
      <${StepRow} n="3" done=${m.shared} title=${m.shared ? 'On the board page' : 'Put it on the board page'} sub=${m.shared ? 'Board members see the agenda, notes, votes and files (not staff-only ones).' : 'Board members see nothing of this meeting until then.'}>
        ${m.shared ? html`<button class="btn btn-ghost btn-sm" onClick=${() => share(false)}>Take it off</button>` : html`<button class="btn btn-primary btn-sm" onClick=${() => share(true)}>Share with the board</button>`}
      </${StepRow}>
      <${StepRow} n="4" done=${!!m.packetSentAt} title=${m.packetSentAt ? `Documents emailed to ${plural(m.packetSentTo, 'board member')}` : 'Email the board the documents'}
        sub=${m.packetSentAt ? ago(m.packetSentAt) : `The agenda’s headings and a link to the board page${docs.length ? `, with ${plural(docs.length, 'file')} attached (${sizeText(size)})` : ' (no files yet)'}. To ${plural(data.packetTo, 'board member')}${data.setup.email ? '' : ' · email isn’t set up'}.`}>
        <button class="btn btn-ghost btn-sm" disabled=${!!working || !data.setup.email} onClick=${() => run('preview', { action: 'send-packet', id: m.id, test: true }, (j) => `Sent to ${j.to?.[0] || 'you'}${j.attached ? ` with ${plural(j.attached, 'file')}` : ''}`)}>${working === 'preview' ? 'Sending…' : 'Send it to me'}</button>
        <button class=${`btn btn-sm ${m.packetSentAt ? 'btn-ghost' : 'btn-primary'}`} disabled=${!!working || !m.shared || !data.packetTo || !data.setup.email} title=${m.shared ? '' : 'Share it first'}
          onClick=${async () => { if (await ask({ title: `Email ${plural(data.packetTo, 'board member')} the documents?`, text: `The agenda’s headings, a link to the board page${docs.length ? `, and ${plural(docs.length, 'file')} attached` : ''}.`, yes: m.packetSentAt ? 'Email them again' : 'Email the board' })) run('send', { action: 'send-packet', id: m.id }, (j) => `Emailed ${plural(j.sent, 'board member')}`); }}>${working === 'send' ? 'Sending…' : m.packetSentAt ? 'Email again' : 'Email the documents'}</button>
      </${StepRow}>
    </ol>
  </div>`;
}

/** Who's coming: answers on the board page and replies to the calendar invite */
function Coming({ m, ctx, act }) {
  const { data, addToast } = ctx;
  const [working, setWorking] = useState('');
  const board = m.attendance.filter((p) => p.kind === 'board');
  const answer = (p) => answerOf(p.rsvp, repliesOf(m)[p.slug]);
  const groups = [['Coming', board.filter((p) => answer(p) === 'Coming')], ['By video', board.filter((p) => answer(p) === 'By video')], ['Can’t come', board.filter((p) => answer(p) === 'Can’t come')], ['Maybe', board.filter((p) => answer(p) === 'Maybe')], ['No answer', board.filter((p) => !answer(p))]];
  const quiet = groups.at(-1)[1].filter((p) => data.members.find((x) => x.slug === p.slug)?.email);
  const remind = async (test) => { setWorking(test ? 'preview' : 'send'); const j = await act({ action: 'remind-rsvp', id: m.id, test }); setWorking(''); if (j) addToast(test ? `Sent to ${j.to?.[0] || 'you'}` : `Asked ${plural(j.sent, 'board member')}`, 'info'); };
  return html`<div class="card">
    <div class="bd-card-head--row"><div class="bd-card-head" style="margin:0"><h3>Who’s coming</h3><p>From the board page and the replies to the calendar invite.</p></div>
      ${quiet.length && m.date >= todayEastern() ? html`<div class="bd-actions">
        <button class="btn btn-ghost btn-sm" disabled=${!!working || !m.shared} onClick=${() => remind(true)}>${working === 'preview' ? 'Sending…' : 'Send it to me'}</button>
        <button class="btn btn-primary btn-sm" disabled=${!!working || !m.shared} title=${m.shared ? '' : 'Share the meeting first'} onClick=${() => remind(false)}>${working === 'send' ? 'Sending…' : `Ask the ${quiet.length === 1 ? 'one' : quiet.length} who haven’t answered`}</button>
      </div>` : null}
    </div>
    <div class="bm-counts" style="margin-top:0.85rem">${groups.filter(([, l]) => l.length).map(([t, l]) => html`<span><b>${l.length}</b> ${t.toLowerCase()}</span>`)}</div>
    ${groups.filter(([, l]) => l.length).map(([t, l]) => html`<p class="bd-muted"><strong>${t}:</strong> ${l.map((p) => p.name).join(', ')}</p>`)}
  </div>`;
}

// ─── During ─────────────────────────────────────────────────────────

const ORDER = { Coming: 0, 'By video': 1, Maybe: 2, '': 3, 'Can’t come': 4 };
function Attendance({ m, set, ctx, people }) {
  const quorum = ctx.data.settings.quorum;
  const c = attendanceCounts(m);
  const answer = (p) => answerOf(p.rsvp, repliesOf(m)[p.slug]);
  const mark = (key, v) => set((x) => ({ attendance: x.attendance.map((p) => (p.key === key ? { ...p, status: p.status === v ? '' : v } : p)) }));
  const yes = m.attendance.filter((p) => ['Coming', 'By video'].includes(answer(p)) && !p.status);
  const markYes = () => set((x) => ({ attendance: x.attendance.map((p) => (yes.some((y) => y.key === p.key) ? { ...p, status: answer(p) === 'By video' ? 'remote' : 'present' } : p)) }));
  const row = (p) => html`<li class="bm-person" key=${p.key}>
    <div><div class="bm-person__name">${p.name}</div><div class="bm-person__meta">${[p.kind === 'board' ? p.org : p.kind === 'staff' ? 'SOARD' : `Guest${p.org ? `, ${p.org}` : ''}`, answer(p) ? `Said: ${answer(p).toLowerCase()}` : p.kind === 'board' ? 'No answer' : ''].filter(Boolean).join(' · ')}</div></div>
    <div class="bm-choices" role="group" aria-label=${`${p.name} is`}>
      ${[['present', 'Here'], ['remote', 'By video'], ['absent', 'Not here'], ['excused', 'Excused']].map(([v, l]) => html`<button type="button" class=${`bm-choice ${v === 'excused' ? 'bm-choice--quiet' : ''}`} aria-pressed=${p.status === v} onClick=${() => mark(p.key, v)}>${p.status === v ? CHECK : null}${l}</button>`)}
    </div>
  </li>`;
  const board = m.attendance.filter((p) => p.kind === 'board').sort((a, b) => (ORDER[answer(a)] ?? 3) - (ORDER[answer(b)] ?? 3));
  const rest = m.attendance.filter((p) => p.kind !== 'board');
  return html`<div class="card">
    <div class="bd-card-head--row" style="margin-bottom:0.85rem"><div class="bd-card-head" style="margin:0"><h3>Attendance</h3><p>Tap who’s here as the meeting starts. Every tap saves.</p></div>
      ${yes.length ? html`<button class="btn btn-primary btn-sm" onClick=${markYes}>Mark the ${yes.length === 1 ? 'one' : yes.length} who said yes as here</button>` : null}</div>
    <div class=${`bm-quorum ${quorum ? (c.boardHere >= quorum ? 'is-met' : 'is-short') : ''}`} role="status">
      <span>${c.boardHere} of ${c.board} board members here${c.remote ? ` (${c.remote} by video)` : ''}</span>
      <span>${quorum ? (c.boardHere >= quorum ? `Quorum met (${quorum} needed)` : `Quorum is ${quorum}: ${quorum - c.boardHere} more needed`) : html`<a class="link" href="#board/settings">Set the quorum</a>`}</span>
    </div>
    <ul class="bm-people">${board.map(row)}</ul>
    ${rest.length ? html`<p class="bm-group">Staff and guests</p><ul class="bm-people">${rest.map(row)}</ul>` : null}
    <${AddPerson} people=${people} present=${m.attendance} onAdd=${(p) => set((x) => ({ attendance: [...x.attendance, p] }))} />
  </div>`;
}

function AddPerson({ people, present, onAdd }) {
  const [name, setName] = useState('');
  const known = people.find((p) => p.name.toLowerCase() === name.trim().toLowerCase());
  const here = new Set(present.map((p) => p.slug).filter(Boolean));
  const add = () => {
    if (!name.trim()) return;
    onAdd(known && !here.has(known.slug) ? { key: known.slug, slug: known.slug, name: known.name, org: known.org, kind: known.kind, status: 'present', rsvp: '' } : { key: `guest:${name.trim().toLowerCase()}`, name: name.trim(), org: '', kind: 'guest', status: 'present', rsvp: '' });
    setName('');
  };
  return html`<div class="bd-inline" style="margin-top:0.85rem">
    <input class="form-input" aria-label="Add someone who’s here" placeholder="Add a guest or a board member" list="bd-add-people" value=${name} onInput=${(e) => setName(e.target.value)} onKeyDown=${(e) => { if (e.key === 'Enter') add(); }} style="min-width:15rem" />
    <button class="btn btn-ghost btn-sm" disabled=${!name.trim()} onClick=${add}>Add</button>
    <datalist id="bd-add-people">${people.filter((p) => !here.has(p.slug)).map((p) => html`<option value=${p.name} />`)}</datalist>
  </div>`;
}

function Motions({ m, set }) {
  const here = m.attendance.filter((p) => p.status === 'present' || p.status === 'remote').map((p) => p.name);
  const names = here.length ? here : m.attendance.filter((p) => p.kind === 'board').map((p) => p.name);
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
    <button class="btn btn-ghost btn-sm" style="margin-top:0.75rem" onClick=${() => set((x) => ({ motions: [...x.motions, { id: uid('v_'), text: '', by: '', second: '', result: 'passed' }] }))}>Add a motion</button>
  </div>`;
}

function Actions({ m, set, ctx, people, keepSaved, saved }) {
  const upd = (i, patch) => set((x) => ({ actions: x.actions.map((y, j) => (j === i ? { ...y, ...patch } : y)) }));
  const savedIds = new Set(saved.current.actions.map((a) => a.id));
  const tick = async (a, done) => {
    const j = await call({ action: 'action-done', actionId: a.id, done });
    if (!j.ok) { ctx.addToast(j.error, 'error'); return; }
    keepSaved((x) => ({ ...x, actions: x.actions.map((y) => (y.id === a.id ? { ...y, done } : y)) }));
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
    <button class="btn btn-ghost btn-sm" style="margin-top:0.75rem" onClick=${() => set((x) => ({ actions: [...x.actions, { id: uid('a_'), text: '', owner: '', ownerName: '', due: '', done: false, doneOn: '' }] }))}>Add an action item</button>
  </div>`;
}

// ─── After ──────────────────────────────────────────────────────────

function Minutes({ m, set, ctx, act, save, keepSaved, setStep }) {
  const { data, addToast } = ctx;
  const [working, setWorking] = useState('');
  const [reading, setReading] = useState(null); // { file, parsed } while a minutes file is looked over
  const approved = m.minutes === 'approved';
  const notes = m.sections.reduce((n, s) => n + s.items.filter((it) => it.notes).length, 0);
  const next = nextMeeting(data.meetings.filter((x) => x.date > m.date));
  const minutesFile = m.files.filter((f) => f.kind === 'minutes').at(-1);
  const signed = m.files.filter((f) => f.kind === 'signed').at(-1);
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
    const p = reading.parsed;
    set((x) => ({ sections: p.sections, attendance: p.attendance.length ? p.attendance : x.attendance }));
    setReading(null);
    addToast('The minutes are in the meeting', 'info');
  };
  const drop = (kind) => ({
    onDragOver: (e) => { e.preventDefault(); e.currentTarget.classList.add('is-over'); },
    onDragLeave: (e) => e.currentTarget.classList.remove('is-over'),
    onDrop: (e) => { e.preventDefault(); e.currentTarget.classList.remove('is-over'); if (e.dataTransfer.files[0]) take(e.dataTransfer.files[0], kind); },
  });
  const vf = viewerFiles([minutesFile, signed].filter(Boolean));
  return html`<div class="card">
    <div class="bd-card-head"><h3>The minutes</h3><p>${approved
      ? `Approved${m.approvedOn ? ` ${shortDate(m.approvedOn)}` : ''}. The board page shows them as approved minutes.`
      : 'The notes, attendance, votes and action items from During are the minutes. The board approves them at the next meeting.'}</p></div>
    <ol class="bm-steplist">
      <${StepRow} n="1" done=${notes > 0 || !!minutesFile} title=${notes ? `Written: ${plural(notes, 'item')} with notes` : 'Write them'} sub=${minutesFile ? html`From <a class="link" ...${viewerLink(vf, 0)}>${fileTitle(minutesFile.name)}</a>` : notes ? 'From the notes taken in During' : 'Take notes in During, or upload minutes written elsewhere (PDF or Word).'}>
        ${!notes ? html`<button class="btn btn-ghost btn-sm" onClick=${() => setStep('during')}>Go to During</button>` : null}
        <label class="btn btn-ghost btn-sm">${working === 'minutes' ? 'Reading…' : 'Upload the minutes instead'}<input type="file" hidden accept=".pdf,.docx" onChange=${(e) => { if (e.target.files[0]) take(e.target.files[0], 'minutes'); e.target.value = ''; }} /></label>
      </${StepRow}>
      ${reading ? html`<li class="notice notice--info" style="margin:0"><div class="notice__body">
        <strong>${fileTitle(reading.file.name)} reads as ${plural(reading.parsed.sections.length, 'section')}, ${plural(reading.parsed.sections.reduce((n, s) => n + s.items.length, 0), 'item')}${reading.parsed.attendance.length ? ` and ${plural(reading.parsed.attendance.filter((a) => a.status === 'present').length, 'person', 'people')} there` : ''}.</strong>
        <ol style="margin:0.35rem 0 0 1.1rem;padding:0">${reading.parsed.sections.map((s) => html`<li>${s.title}: ${s.items.map((it) => it.title).join(', ')}</li>`)}</ol>
      </div><div class="notice__actions"><button class="btn btn-primary btn-sm" onClick=${use}>Use these as the minutes</button><button class="btn btn-ghost btn-sm" onClick=${() => setReading(null)}>Keep the file only</button></div></li>` : null}
      <${StepRow} n="2" done=${m.shared} title=${m.shared ? 'On the board page' : 'Share them with the board'} sub=${m.shared ? (m.minutesSentAt ? `The board was told ${ago(m.minutesSentAt)}` : 'The board can read them now.') : 'As draft minutes until they’re approved.'}>
        ${m.shared ? null : html`<button class="btn btn-primary btn-sm" onClick=${() => share(true)}>Share with the board</button>`}
        <button class="btn btn-ghost btn-sm" disabled=${!!working || !data.setup.email} onClick=${() => send(true)}>${working === 'preview' ? 'Sending…' : 'Send it to me'}</button>
        <button class="btn btn-ghost btn-sm" disabled=${!!working || !m.shared || !data.packetTo || !data.setup.email} onClick=${() => send(false)}>${working === 'send' ? 'Sending…' : m.minutesSentAt ? 'Email the board again' : 'Email the board'}</button>
      </${StepRow}>
      <${StepRow} n="3" done=${approved} title=${approved ? `Approved${m.approvedOn ? ` ${shortDate(m.approvedOn)}` : ''}` : 'The board approves them'} sub=${approved ? 'Marked on the board page.' : next ? `On the agenda of the ${meetingName(next)} (${shortDate(next.date)}). Tap “The board approved them” there in During.` : 'At the next meeting. Add it, and its agenda asks for this approval.'}>
        ${approved ? html`<button class="btn btn-ghost btn-sm" onClick=${() => set({ minutes: 'draft', approvedOn: '' })}>Mark as draft</button>` : html`<button class="btn btn-ghost btn-sm" onClick=${() => set({ minutes: 'approved', approvedOn: todayEastern() })}>They’re approved</button>`}
      </${StepRow}>
      <${StepRow} n="4" done=${!!signed} title=${signed ? 'Signed copy kept' : 'The signed copy'} sub=${signed ? html`<a class="link" ...${viewerLink(vf, vf.length - 1)}>${fileTitle(signed.name)}</a>` : 'Optional: the secretary’s signed minutes, as a PDF or a photo.'}>
        <label class="btn btn-ghost btn-sm" ...${drop('signed')}>${working === 'signed' ? 'Uploading…' : signed ? 'Replace it' : 'Upload it'}<input type="file" hidden accept=".pdf,.jpg,.jpeg,.png,.heic,.docx" onChange=${(e) => { if (e.target.files[0]) take(e.target.files[0], 'signed'); e.target.value = ''; }} /></label>
      </${StepRow}>
    </ol>
  </div>`;
}
