/**
 * Board → one meeting (#board/meeting/<id>)
 * ===========================================================================
 * One page that follows the meeting's date. Nothing here is a secretary's job:
 * the agenda builds itself from the last one (the last minutes up for
 * approval, the makeovers and the money live), the numbers lock themselves on
 * the day, and the minutes, dropped in after, fill in who was there, the
 * notes, the motions and the action items. Nothing is run from here during
 * the meeting: the presentation moves itself (./board/screen.js PRESENT).
 *   The line under its name: the agenda, the invite, the board page, the
 *            email, the day, the minutes; done, next, or to come
 *   The agenda beside the presentation as it's written (AgendaStage: the
 *            slide for the item being worked on, every slide in order, Play
 *            from here), the board page or a phone; never the board's until
 *            the meeting is shared
 *   Ahead    then getting it to the board (the invite, the board page, the
 *            email, the reports), who's coming, the minutes template
 *            (./board-minutes-template.js), the packet
 *   On the day  Present: the presentation in its own window, shared or not
 *   Held     drop the minutes in (PDF or Word) first: Board reads them into
 *            the meeting; then shared, emailed, approved, the signed copy
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
  PersonPicker, ItemChooser, DocChip, pickable, Face, ShowsPicker,
} from './board-ui.js';
import {
  RESULTS, FILE_KINDS, LIVE, cleanMeeting, meetingName, longDate, shortDate, timeRange, plural, uid, clock,
  todayEastern, attendanceCounts, quorumFor, answerOf, repliesOf, fileTitle, mergeMeeting, nextMeeting, agendaIsDraft,
  isLive, agendaItems, isFilled, reportsOn, showsOf, slidesOf, booksDraw, isStatement, LIVE_TITLES, SHOW_KINDS, tallyText, cleanLive, presentersOf, namesText, itemFiles, guessItem, deckOf, stopIndex, liveOfStop, MORE,
  sectionPlan, sectionOf, sectionClock, clockText, facesOf, itemDocs, docTitle, formatOf, docsOf, looseFiles, NOTHING_NEW, isNothingNew,
} from './board-shared.js';
import { openScreen, mirrorUrl, useScreen, usePages, stepKey, useCover } from './board-present.js';
import { printMinutesTemplate, downloadMinutesDocx } from './board-minutes-template.js';
import { ReportEditor, Report } from './board-report.js';
import { partFor } from './board-coach.js';
import { mdWords } from './board-md.js';
import { booksTitle } from './board/books.js';

// What a person edits (the server keeps files, the packet's numbers and sent records, and done ticks)
const EDITABLE = ['date', 'start', 'end', 'title', 'location', 'address', 'inviteNote', 'video', 'shared', 'minutes', 'approvedOn', 'attendance', 'sections', 'motions', 'actions', 'live'];
const editable = (m) => {
  const c = cleanMeeting(m);
  // Who wrote a report when is the server's to say (_board.js stampReports), never a change to save
  const sections = c.sections.map((s) => ({ ...s, items: s.items.map(({ reportBy, reportAt, ...it }) => it) }));
  return JSON.stringify(EDITABLE.map((f) => (f === 'actions' ? c.actions.map(({ done, doneOn, ...a }) => a) : f === 'attendance' ? c.attendance.map(({ rsvp, ...p }) => p) : f === 'sections' ? sections : c[f])));
};
/** Each report's writer and time from the server's copy, onto the one being edited (where the words still match) */
const stampsFrom = (sections, saved) => {
  const by = new Map(saved.sections.flatMap((s) => s.items).map((it) => [it.id, it]));
  return sections.map((s) => ({ ...s, items: s.items.map((it) => { const x = by.get(it.id); return x && (x.report || '') === (it.report || '') ? { ...it, reportBy: x.reportBy, reportAt: x.reportAt } : it; }) }));
};
const blankItem = () => ({ id: uid('i_'), title: '', presenter: '', who: [], notes: '', staffNote: '', confidential: false, live: '', docs: [] });
const move = (list, i, d) => { const out = [...list]; const [x] = out.splice(i, 1); out.splice(i + d, 0, x); return out; };

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
  const failing = useRef(0); // saves failed in a row
  const retry = useRef(0);
  const timer = useRef(0);
  const practice = !!meeting.practice;
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
    if (editable(mine) === editable(saved.current)) { setSt((x) => (x.s === 'unsaved' || x.s === 'error' ? { s: 'saved', at: x.at } : x)); return null; }
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
      if (!j.ok) {
        // Said once per outage, then tried again by itself (sooner when the connection comes back)
        if (!failing.current) addToast(`Not saved: ${j.error || 'try again in a moment'}. Board keeps trying.`, 'error');
        failing.current += 1;
        setSt({ s: 'error', why: j.error || 'Couldn’t save' });
        clearTimeout(retry.current);
        retry.current = setTimeout(save, [3000, 10000, 30000][Math.min(failing.current - 1, 2)]);
        return null;
      }
      if (failing.current) { failing.current = 0; clearTimeout(retry.current); addToast('Saved', 'info'); }
      saved.current = cleanMeeting(j.meeting);
      base.current = j.meeting.updatedAt;
      // What only the server sets, into the copy being edited (never over what's been typed since)
      setM((x) => ({
        ...x, files: j.meeting.files, snapshot: j.meeting.snapshot, packetSentAt: j.meeting.packetSentAt, packetSentTo: j.meeting.packetSentTo,
        minutesSentAt: j.meeting.minutesSentAt, updatedAt: j.meeting.updatedAt, updatedBy: j.meeting.updatedBy, calendar: j.meeting.calendar, invite: j.meeting.invite,
        agendaFrom: j.meeting.agendaFrom, fromMeet: j.meeting.fromMeet, approvedOn: x.approvedOn || j.meeting.approvedOn,
        sections: stampsFrom(x.sections, j.meeting),
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
    const back = () => { if (failing.current) save(); };
    window.addEventListener('keydown', onKey);
    window.addEventListener('beforeunload', onLeave);
    window.addEventListener('online', back);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('beforeunload', onLeave); window.removeEventListener('online', back); clearTimeout(retry.current); save(); markDirty(false); };
  }, []);

  /** An action the server takes on the saved meeting: anything typed is saved first */
  const act = async (body, { keep = null } = {}) => {
    // A change made a moment ago (Start, just before the numbers lock) reaches the copy being saved first
    await new Promise((r) => setTimeout(r, 0));
    await save();
    const before = editable(mRef.current);
    const j = await call(body);
    if (!j.ok) { if (keep?.(j)) return j; addToast(j.error, 'error'); return null; }
    if (j.meeting) {
      // Changed here while the server worked (the next item, a vote opening): kept over its copy, and saved after
      const moved = editable(mRef.current) !== before;
      saved.current = cleanMeeting(j.meeting);
      base.current = j.meeting.updatedAt;
      setM((x) => (moved ? { ...x, ...j.meeting, ...Object.fromEntries(EDITABLE.map((k) => [k, x[k]])) } : { ...x, ...j.meeting }));
      putMeeting(j.meeting);
      setSt({ s: 'saved', at: j.meeting.updatedAt });
      if (moved) setTimeout(save, 0);
    }
    return j;
  };
  const remove = async () => {
    if (!(await ask({ title: `Delete the ${meetingName(m)}?`, text: `Its agenda, notes, minutes and files go for good. Board members stop seeing it.${m.invite && m.date >= todayEastern() ? ' Its calendar invite is cancelled too, and Google emails everyone on it.' : ''}`, yes: 'Delete', danger: true }))) return;
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

  const numbers = m.snapshot || data.numbers;
  const [focusId, setFocusId] = useState('');
  // The presentation in its own window: shared with the board or not (only Board's admins can open one that isn't)
  const present = () => openScreen(m.id);
  const p = { m, set, setNow, ctx, act, save, numbers, keepSaved, saved, practice, onFocusItem: setFocusId, openWhere: () => setEditWhere(true), closeWhere: () => { setEditWhere(false); requestAnimationFrame(() => document.getElementById('bm-where-toggle')?.focus()); } };

  const days = daysFrom(m.date);
  // Where it is in its life: ahead (getting it to the board), its day (present it), held (the minutes): a meeting is
  // held once its day is over, or once its end time has passed on the day (the secretary's minutes may come that
  // afternoon), or once the chair has ended it (one moved up and held early is held, whatever its date says)
  const over = days === 0 && /^\d{2}:\d{2}$/.test(m.end || '') && nowEastern() >= m.end;
  const ended = !!m.live?.endedAt && !isLive(m);
  const phase = practice ? 'today' : ended ? 'held' : !m.date || days > 0 ? 'ahead' : days === 0 && !over ? 'today' : 'held';
  const when = phase === 'held' ? ['Held', 'is-held'] : [whenWords(days), days === 0 ? 'is-today' : days > 0 ? 'is-ahead' : ''];
  const place = [m.location, m.address].filter(Boolean).join(', ');
  const path = pathOf(m, data, phase);
  // The status line stays at the top as the page scrolls. Its height goes on the page (--bm-path-h) for whatever sticks
  // or is scrolled to below it. Too narrow for every step (one row that scrolls sideways), the next one is brought into
  // view, and again when the window turns; with a mouse, ‹ and › at its ends go to the steps out of sight
  const pathRef = useRef(null);
  const [edge, setEdge] = useState({ l: false, r: false });
  const edges = () => {
    const ol = pathRef.current?.querySelector('ol');
    if (!ol) return;
    const l = ol.scrollLeft > 2;
    const r = ol.scrollLeft + ol.clientWidth < ol.scrollWidth - 2;
    setEdge((e) => (e.l === l && e.r === r ? e : { l, r }));
  };
  const slide = (d) => {
    const ol = pathRef.current?.querySelector('ol');
    ol?.scrollBy({ left: d * ol.clientWidth * 0.7, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  };
  const nextStep = path.find((s) => s.state === 'next')?.id || '';
  const showNext = () => {
    const ol = pathRef.current?.querySelector('ol');
    const li = ol?.querySelector('.is-next');
    if (!li || ol.scrollWidth <= ol.clientWidth) return;
    const o = ol.getBoundingClientRect();
    const r = li.getBoundingClientRect();
    ol.scrollLeft += r.left - o.left - (o.width - r.width) / 2;
  };
  useEffect(() => {
    const nav = pathRef.current;
    if (!nav) return undefined;
    const root = document.documentElement;
    let wide = 0;
    const ro = new ResizeObserver(() => {
      root.style.setProperty('--bm-path-h', `${nav.offsetHeight}px`);
      if (nav.offsetWidth !== wide) { wide = nav.offsetWidth; showNext(); }
      edges();
    });
    ro.observe(nav);
    // What the keyboard or the page focuses comes out from under the line, all of it (the browser's own scroll stops at
    // the window's top). A step on the line is always in view, yet the browser scrolls the page for it anyway: the page
    // goes back to where it was before it draws, and the step slides into the line's view, clear of ‹ and ›. Never a
    // click, so nothing moves under the pointer
    let pointer = 0;
    let tabY = 0;
    let tabAt = 0;
    const down = () => { pointer = performance.now(); };
    const key = (e) => { if (e.key === 'Tab') { tabY = scrollY; tabAt = performance.now(); } };
    const onFocus = (e) => {
      const el = e.target;
      if (performance.now() - pointer < 600) return;
      if (nav.contains(el)) {
        const y = performance.now() - tabAt < 300 ? tabY : scrollY;
        requestAnimationFrame(() => {
          el.closest('li')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
          scrollTo({ top: y, behavior: 'instant' });
        });
        return;
      }
      if (!el.closest?.('.bd') || el.closest('[popover], dialog')) return;
      requestAnimationFrame(() => clearOfLine(el));
    };
    addEventListener('pointerdown', down, true);
    addEventListener('keydown', key, true);
    addEventListener('focusin', onFocus);
    return () => { ro.disconnect(); root.style.removeProperty('--bm-path-h'); removeEventListener('pointerdown', down, true); removeEventListener('keydown', key, true); removeEventListener('focusin', onFocus); };
  }, [practice]);
  useEffect(showNext, [nextStep]);
  // The status line's steps go to the card that does them
  // (lit once the page stops there: a long way on a phone scrolls longer than the light lasts. A second step a moment
  // later lights its card the whole time, not cut short by the first one's timer)
  const lit = useRef({});
  const toCard = (id) => {
    const el = document.getElementById(id);
    if (!el) return;
    el.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    clearTimeout(lit.current.t);
    cancelAnimationFrame(lit.current.f);
    lit.current.el?.classList.remove('is-found');
    el.classList.remove('is-found');
    let y = NaN;
    let still = 0;
    let frames = 0;
    const there = () => {
      still = scrollY === y ? still + 1 : 0;
      y = scrollY;
      if (still < 3 && ++frames < 180) { lit.current.f = requestAnimationFrame(there); return; }
      el.classList.add('is-found');
      lit.current.t = setTimeout(() => el.classList.remove('is-found'), 1600);
    };
    lit.current = { el, f: requestAnimationFrame(there) };
  };
  const work = html`<div class="bm-work" id="bm-work">
    <${AgendaEditor} ...${p} />
    <${AgendaStage} m=${m} focusId=${focusId} meetings=${data.meetings} />
  </div>`;
  return html`
    <div class="bm-top" data-meeting=${m.id}>
      <div class="bm-top__bar">
        <a class="bd-back" href="#board" onClick=${(e) => { e.preventDefault(); go({}); }}>← All meetings</a>
        <div class="bd-actions">
          <span class=${`bm-saved ${st.s === 'error' ? 'is-error' : st.s === 'saved' ? 'is-quiet' : ''}`} role="status" aria-live="polite" tabindex="-1">
            ${st.s === 'saving' ? 'Saving…' : st.s === 'unsaved' ? 'Saving in a moment' : st.s === 'error' ? html`<span title=${st.why}>Not saved</span> <button class="btn btn-ghost btn-sm" onClick=${async () => { await save(); requestAnimationFrame(() => document.querySelector('.bm-saved')?.focus()); }}>Try again</button>` : `Saved ${st.at ? savedAt(st.at) : ''}`}
          </span>
          <button type="button" class=${`btn btn-sm bm-present ${phase === 'today' ? 'btn-primary' : 'btn-ghost'}`} onClick=${present}
            title="The agenda and its documents as slides, in their own window: → and ← or a clicker move them. Share it on Google Meet or put it on the TV">${phase === 'ahead' ? 'Preview the presentation' : phase === 'today' ? 'Present' : 'See the presentation'}</button>
          <${Menu} label="More for this meeting" items=${[
            { icon: 'open', label: 'Open it on the board page', run: () => window.open(`${PAGE}${m.shared ? '' : '?as-board'}#/meetings/${m.id}`, '_blank', 'noopener') },
            !practice && { divider: true },
            !practice && { icon: 'trash', label: 'Delete this meeting', danger: true, run: remove },
          ]} />
        </div>
      </div>
      <div class="bm-title">
        <span class=${`bm-when ${when[1]}`}>${when[0]}</span>
        <h2>${meetingName(m)}</h2>
        <p class="bm-facts">
          <span>${[longDate(m.date), timeRange(m.start, m.end)].filter(Boolean).join(' · ') || 'No date yet'}</span>
          <span>${place || html`<button type="button" class="bm-link" onClick=${() => setEditWhere(true)}>Add the place</button>`}</span>
          ${/^https?:\/\/\S+\.\S+/i.test(m.video || '') ? html`<span><a class="link" href=${m.video} target="_blank" rel="noopener">${callName(m.video)}</a></span>` : null}
          <button type="button" class="bm-link" id="bm-where-toggle" aria-expanded=${editWhere} aria-controls="bm-where" onClick=${() => setEditWhere(!editWhere)}>Change when and where</button>
        </p>
      </div>
    </div>
    ${practice ? null : html`<nav class="bm-path" aria-label="Where this meeting stands" ref=${pathRef}>
      <ol onScroll=${edges}>${path.map((s) => html`<li key=${s.id} class=${`bm-path__step is-${s.state}`} aria-current=${s.state === 'next' ? 'step' : null}>
        <${s.card ? 'button' : 'span'} type=${s.card ? 'button' : null} class="bm-path__btn" onClick=${s.card ? () => toCard(s.card) : null}>
          <span class="bm-path__dot" aria-hidden="true">${s.state === 'done' ? CHECK : null}</span>
          <span class="bm-path__words"><span class="bm-path__t">${s.title}</span><span class="bm-path__s">${s.sub}</span></span>
        </${s.card ? 'button' : 'span'}>
      </li>`)}</ol>
      ${edge.l ? html`<button type="button" class="bm-path__more is-back" tabindex="-1" aria-label="The steps before these" onClick=${() => slide(-1)}>‹</button>` : null}
      ${edge.r ? html`<button type="button" class="bm-path__more is-on" tabindex="-1" aria-label="The steps after these" onClick=${() => slide(1)}>›</button>` : null}
    </nav>`}
    ${editWhere ? html`<${WhenWhere} ...${p} />` : null}
    ${phase === 'held' ? html`
      <div class="bm-row">
        <div class="bm-row__main" id="bm-minutes"><${MinutesDrop} ...${p} /><${MinutesDoc} ...${p} /></div>
        <div class="bm-row__side" id="bm-after"><${WrapUp} ...${p} />${m.minutesFrom ? null : html`<${MinutesTemplate} ...${p} />`}</div>
      </div>
      ${work}
      <${FilesCard} ...${p} title="Every file" sub="All of this meeting’s files. A staff-only file never reaches the board page." />`
    : html`
      ${work}
      ${phase === 'today' ? html`<div class="bm-row">
        <div class="bm-row__main" id="bm-minutes"><${MinutesDrop} ...${p} /></div>
        <div class="bm-row__side"><${WrapUp} ...${p} /></div>
      </div>` : null}
      <div class="bm-row" id="bm-ready">
        <div class="bm-row__main"><${GettingReady} ...${p} /></div>
        <div class="bm-row__side"><${Coming} ...${p} /><${MinutesTemplate} ...${p} /></div>
      </div>
      <${FilesCard} ...${p} goes title="The packet" sub="Each file goes under its agenda item, on the board page and on the screen. PDF, pictures, Word, Excel or PowerPoint, up to 50 MB." />`}`;
}

/** The time in Atlanta now, "HH:MM" */
const nowEastern = () => new Intl.DateTimeFormat('en-GB', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());

/**
 * Where a meeting stands, step by step, for the line under its name: the agenda, the invite, the board page, the
 * email, the day, the minutes. Each step is done, the next one, or still to come; `card` is where it's done (none once
 * the meeting is held and its card is gone: the invite and the email were before; the board page is After the meeting's,
 * beside the minutes)
 */
function pathOf(m, data, phase) {
  const items = agendaItems(m);
  const asked = items.filter((x) => reportsOn(m.sections[x.si].items[x.ii]));
  const reportsIn = asked.filter((x) => m.sections[x.si].items[x.ii].report).length;
  const inv = m.invite;
  const held = phase === 'held';
  const ready = held ? '' : 'bm-ready';
  const steps = [
    { id: 'agenda', card: 'bm-work', title: 'Agenda', done: items.length > 0 && reportsIn === asked.length, sub: !items.length ? 'Nothing on it yet' : asked.length ? `${plural(items.length, 'item')} · ${reportsIn} of ${asked.length} reports in` : plural(items.length, 'item') },
    { id: 'invite', card: ready, title: 'Invite', done: !!inv, sub: inv ? `On ${firstOf(inv.organizer)}’s calendar` : m.inviteGone ? 'Deleted in Google Calendar' : 'Not sent' },
    { id: 'shared', card: held ? 'bm-after' : 'bm-ready', title: 'Board page', done: !!m.shared, sub: m.shared ? 'The board can see it' : 'Only you can see it' },
    { id: 'emailed', card: ready, title: 'Board emailed', done: !!m.packetSentAt, sub: m.packetSentAt ? `${plural(m.packetSentTo || 0, 'member')}, ${shortDate(m.packetSentAt.slice(0, 10))}` : 'Not yet' },
    { id: 'day', card: 'bm-work', title: phase === 'today' ? 'Today' : held ? 'Held' : 'The meeting', done: held, sub: [m.date ? shortDate(m.date) : 'No date yet', m.start ? clock(m.start) : ''].filter(Boolean).join(' · ') },
    { id: 'minutes', card: phase === 'ahead' ? 'bm-work' : 'bm-minutes', title: 'Minutes', done: m.minutes === 'approved', sub: m.minutes === 'approved' ? `Approved${m.approvedOn ? ` ${shortDate(m.approvedOn)}` : ''}` : m.minutesFrom ? 'Read in, to approve next time' : held ? 'Drop them in' : 'After the meeting' },
  ];
  // The next step: the first one not done (before the day, the agenda's reports count only once the rest is out)
  const order = held ? ['minutes'] : phase === 'today' ? ['invite', 'shared', 'emailed', 'day'] : ['invite', 'shared', 'emailed', 'agenda'];
  const next = order.find((id) => !steps.find((s) => s.id === id).done) || (held ? '' : 'day');
  return steps.map((s) => ({ ...s, state: s.done ? 'done' : s.id === next ? 'next' : 'todo' }));
}

// ─── When and where ─────────────────────────────────────────────────

function WhenWhere({ m, set, closeWhere }) {
  // Opened: the focus goes into it; Escape closes it
  const head = useRef(null);
  useEffect(() => { head.current?.focus(); }, []);
  const meet = m.invite?.meet || '';
  const field = (id, label, input) => html`<div class="form-group"><label class="form-label" for=${id}>${label}</label>${input}</div>`;
  return html`<div class="card" id="bm-where" onKeyDown=${(e) => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); closeWhere(); } }}>
    <div class="bd-card-head bm-where__head"><div><h3 tabindex="-1" ref=${head}>When and where</h3>${m.invite ? html`<p>A new day, time or place goes on the invite a couple of minutes after you stop typing, and Google emails the guests once.</p>` : null}</div>
      <button type="button" class="btn btn-ghost btn-sm" onClick=${closeWhere}>Done</button></div>
    <div class="bd-grid3">
      ${field('bd-date', 'Date', html`<input id="bd-date" class="form-input" type="date" value=${m.date} onInput=${(e) => set({ date: e.target.value })} />`)}
      ${field('bd-start', 'Starts', html`<input id="bd-start" class="form-input" type="time" value=${m.start} onInput=${(e) => set({ start: e.target.value })} />`)}
      ${field('bd-end', 'Ends', html`<input id="bd-end" class="form-input" type="time" value=${m.end} onInput=${(e) => set({ end: e.target.value })} />`)}
      ${field('bd-loc', 'Place', html`<input id="bd-loc" class="form-input" value=${m.location} placeholder="Whose office" onInput=${(e) => set({ location: e.target.value })} />`)}
      ${field('bd-addr', 'Address', html`<input id="bd-addr" class="form-input" value=${m.address} placeholder="Street, city" onInput=${(e) => set({ address: e.target.value })} />`)}
      <div class="form-group"><span class="form-label">Video call</span><p class="bm-fixed">${meet ? html`<a class="link" href=${meet} target="_blank" rel="noopener">Google Meet</a>` : html`<span>Google Meet, added with the invite</span>`}</p></div>
      <div class="form-group span-3"><label class="form-label" for="bd-title">Name</label><input id="bd-title" class="form-input" value=${m.title} placeholder=${meetingName({ ...m, title: '' })} aria-describedby="bd-title-hint" onInput=${(e) => set({ title: e.target.value })} />
        <p class="form-hint bm-hint" id="bd-title-hint">${m.title ? 'Empty it to go back to the quarter’s name.' : `Left empty, it’s the “${meetingName({ ...m, title: '' })}”.`}</p></div>
      <div class="form-group span-3"><label class="form-label" for="bd-invite-note">Notes for the invite</label><textarea id="bd-invite-note" class="form-textarea" rows="2" maxlength="1000" value=${m.inviteNote} placeholder="Parking, which door to use, a gate code" aria-describedby="bd-invite-note-hint" onInput=${(e) => set({ inviteNote: e.target.value })}></textarea>
        <p class="form-hint bm-hint" id="bd-invite-note-hint">On the calendar invite, the board page and the meeting emails. A change updates the invite without emailing anyone.</p></div>
    </div>
  </div>`;
}
/** "the day, the times and the place" */
const andList = (l) => (l.length > 1 ? `${l.slice(0, -1).join(', ')} and ${l.at(-1)}` : l[0] || '');

// ─── Before: the agenda ─────────────────────────────────────────────

/** Where the agenda came from, in words (and whether it's still a draft) */
export function agendaSource(m) {
  const f = m.agendaFrom;
  // Nothing on it (every part taken out): never "Ready", as the status line says
  if (!agendaItems(m).length) return { draft: false, empty: true, label: 'Empty', text: 'Nothing on it yet.' };
  if (agendaIsDraft(m)) {
    const from = f?.kind === 'last-meeting' ? `Built from the ${f.name} agenda: the last minutes up for approval, the makeovers and the money filled in live.` : 'SOARD’s usual outline, with the makeovers and the money filled in live.';
    return { draft: true, label: 'Ready', text: `${from} It’s ready as it is. Change anything and it saves as you type.` };
  }
  if (f?.kind === 'email') return { draft: false, label: 'From email', text: `From ${fileTitle(f.name)}, emailed${f.at ? ` ${shortDate(f.at.slice(0, 10))}` : ''}.` };
  if (f?.kind === 'drive') return { draft: false, label: 'From the minutes', text: `Read from ${fileTitle(f.name)} in Google Drive.` };
  return { draft: false, label: 'Ready', text: m.shared ? 'Changes go on the board page as you make them.' : 'Changes save as you type. The board sees them once the meeting is on the board page.' };
}

/** What a file is, by its name, when it's uploaded (it can be changed after) */
const kindOfName = (name) => (/financ|balance|income|p&l|profit|loss|budget|statement/i.test(name) ? 'financials' : /minutes/i.test(name) ? 'minutes' : /agenda/i.test(name) ? 'agenda' : 'other');
/** One item changed, found by its id (so a change after an upload lands on the right item even if the agenda moved) */
const withItem = (id, fn) => (x) => ({ sections: x.sections.map((s) => ({ ...s, items: s.items.map((it) => (it.id === id ? { ...it, ...fn(it) } : it)) })) });

/** An item's name as tall as its words: a long one wraps instead of being cut off (CSS field-sizing where there is it) */
const FITS = typeof CSS !== 'undefined' && !!CSS.supports?.('field-sizing', 'content');
const grow = (el) => { if (!el || FITS) return; el.style.height = 'auto'; el.style.height = `${el.scrollHeight + 2}px`; };

/** A change that moves things (an item or a part dragged, moved up or down), as a view transition: each slides to its place */
function withMotion(fn) {
  if (!document.startViewTransition || matchMedia('(prefers-reduced-motion: reduce)').matches) { fn(); return Promise.resolve(); }
  const t = document.startViewTransition(async () => { fn(); await new Promise((r) => setTimeout(r, 0)); });
  t.ready.catch(() => {});
  setTimeout(() => t.skipTransition?.(), 1200);
  return t.finished.catch(() => {});
}
/** Out from under the meeting's status line, which stays at the top: what moved there or took the focus there */
function clearOfLine(el) {
  const line = document.querySelector('.bm-path');
  if (!el || !line) return;
  const under = line.getBoundingClientRect().bottom + 12 - el.getBoundingClientRect().top;
  if (under > 0) scrollBy({ top: -under, behavior: 'instant' });
}
const LIVE_SHORT = { projects: 'Makeovers board', cash: 'The money', reveals: 'Reveals', events: 'Events', meetings: 'Board meetings' };
const DRAG_ITEM = 'text/x-board-item';
const DRAG_PART = 'text/x-board-part';
const dragKind = (e) => { const t = [...(e.dataTransfer?.types || [])]; return t.includes(DRAG_ITEM) ? 'item' : t.includes(DRAG_PART) ? 'part' : t.includes('Files') ? 'files' : ''; };

/**
 * The agenda, built the way it reads on the board page: the run of show along the top (each part's share of the
 * meeting, its time and where it ends), then the parts as numbered chapters with their minutes, and each item as
 * a card: its number, its name, who presents it (faces, from People), what it shows live, its documents, the
 * background for the board and a private note. Everything is edited in place and saves as you type. Items and
 * parts move by dragging their grip (or ⋯ → Move, or Alt ↑ ↓ in an item's name), and slide to their new places.
 * A file dropped on an item is uploaded and goes with it.
 */
function AgendaEditor({ m, set, ctx, keepSaved, onFocusItem = () => {} }) {
  const { data, addToast } = ctx;
  const setSection = (si, patch) => set((x) => ({ sections: x.sections.map((s, i) => (i === si ? { ...s, ...patch } : s)) }));
  const setItem = (si, ii, patch) => set((x) => ({ sections: x.sections.map((s, i) => (i === si ? { ...s, items: s.items.map((it, j) => (j === ii ? { ...it, ...patch } : it)) } : s)) }));
  const others = youAnd(data.settings.admins, data.me);
  const src = agendaSource(m);
  const people = useMemo(() => pickable(data.people), [data.people]);
  // Each part's time: its own minutes, else its share of the meeting's
  const plan = useMemo(() => sectionPlan(m), [m.sections, m.start, m.end]);
  const labels = useMemo(() => new Map(agendaItems(m).map((x) => [x.id, x.label])), [m.sections]);
  const vf = viewerFiles(m.files);
  const [over, setOver] = useState('');
  const [busy, setBusy] = useState('');
  const [drag, setDrag] = useState(null); // { kind: 'item' | 'part', id }
  const [hint, setHint] = useState(null); // { id, after } where the dragged one would land
  // Items whose report is open to write in (a report reads until Edit, so a long one never fills the agenda)
  const [writing, setWriting] = useState(() => new Set());
  const write = (id, on) => setWriting((w) => { const n = new Set(w); if (on) n.add(id); else n.delete(id); return n; });
  // Getting ready's Reports: a row goes to its item, and one to write opens its editor there, ready to type
  useEffect(() => {
    const go = (e) => {
      const { id, write: open } = e.detail || {};
      if (open) write(id, true);
      setTimeout(() => {
        const li = document.querySelector(`[data-item="${id}"]`);
        li?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
        if (!open) li?.querySelector('.agx-item__title')?.focus({ preventScroll: true });
      }, 80);
    };
    addEventListener('agx-report', go);
    // A slide picked beside the agenda: its item brought into view and lit a moment (the focus stays where it is)
    const show = (e) => {
      const li = document.querySelector(`[data-item="${e.detail?.id}"]`);
      if (!li) return;
      const r = li.getBoundingClientRect();
      // Out of view: above the meeting's status line (it stays at the top) or below the window
      const clear = Math.max(80, (document.querySelector('.bm-path')?.getBoundingClientRect().bottom || 0) + 16);
      if (r.top < clear || r.bottom > innerHeight - 24) li.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
      li.classList.remove('is-found');
      requestAnimationFrame(() => li.classList.add('is-found'));
      setTimeout(() => li.classList.remove('is-found'), 1400);
    };
    addEventListener('agx-go', show);
    return () => { removeEventListener('agx-report', go); removeEventListener('agx-go', show); };
  }, []);
  // After the editor closes (Done, Delete): the focus on what's there now, never lost to the page
  const refocus = (id, sel) => setTimeout(() => document.querySelector(`[data-item="${id}"]`)?.querySelector(sel)?.focus(), 60);
  // Moved up or down: where it went, out from under the status line once the move has played
  const keepClear = (done, sel) => done?.then(() => setTimeout(() => clearOfLine(document.querySelector(sel)), 30));
  // Without field-sizing, each part's and item's name is sized to its words by hand, again when the window changes
  useEffect(() => {
    if (FITS) return undefined;
    const all = () => document.querySelectorAll('.agx-item__title, .agx-sec__title').forEach(grow);
    addEventListener('resize', all);
    return () => removeEventListener('resize', all);
  }, []);
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
  // An item taken out of its place and put before `beforeId` in part `toPart` ('' puts it last)
  const moveItem = (id, toPart, beforeId) => withMotion(() => set((x) => {
    let item = null;
    const lifted = x.sections.map((s) => ({ ...s, items: s.items.filter((it) => (it.id === id ? ((item = it), false) : true)) }));
    if (!item) return {};
    return { sections: lifted.map((s) => {
      if (s.id !== toPart) return s;
      const items = [...s.items];
      const at = beforeId ? items.findIndex((it) => it.id === beforeId) : -1;
      items.splice(at < 0 ? items.length : at, 0, item);
      return { ...s, items };
    }) };
  }));
  const movePart = (id, beforeId) => withMotion(() => set((x) => {
    const part = x.sections.find((s) => s.id === id);
    if (!part) return {};
    const rest = x.sections.filter((s) => s.id !== id);
    const at = beforeId ? rest.findIndex((s) => s.id === beforeId) : -1;
    rest.splice(at < 0 ? rest.length : at, 0, part);
    return { sections: rest };
  }));
  const endDrag = () => { setDrag(null); setHint(null); setOver(''); };
  /** Where a drag over a row would land it: before or after that row, by which half the pointer is in */
  const half = (e) => { const r = e.currentTarget.getBoundingClientRect(); return e.clientY > r.top + r.height / 2; };
  const itemTarget = (s, it) => ({
    onDragOver: (e) => {
      const k = dragKind(e);
      if (k === 'files') { e.preventDefault(); setOver(it.id); return; }
      if (k !== 'item' || drag?.id === it.id) return;
      e.preventDefault();
      const after = half(e);
      if (hint?.id !== it.id || hint.after !== after) setHint({ id: it.id, after });
    },
    onDragLeave: (e) => { if (!e.currentTarget.contains(e.relatedTarget)) { setOver(''); } },
    onDrop: (e) => {
      const k = dragKind(e);
      e.preventDefault();
      if (k === 'files') { setOver(''); attach(it.id, e.dataTransfer.files); return; }
      if (k !== 'item' || !drag) return;
      const after = half(e);
      const i = s.items.findIndex((x) => x.id === it.id);
      const next = after ? s.items.slice(i + 1).find((x) => x.id !== drag.id) : it;
      moveItem(drag.id, s.id, next?.id || '');
      endDrag();
    },
  });
  // An empty part, or the space under a part's last item, takes an item dropped at its end
  const partEnd = (s) => ({
    onDragOver: (e) => { if (dragKind(e) === 'item') { e.preventDefault(); if (hint?.id !== `end:${s.id}`) setHint({ id: `end:${s.id}`, after: false }); } },
    onDrop: (e) => { if (dragKind(e) !== 'item' || !drag) return; e.preventDefault(); moveItem(drag.id, s.id, ''); endDrag(); },
  });
  const partTarget = (s, si) => ({
    onDragOver: (e) => {
      if (dragKind(e) !== 'part' || drag?.id === s.id) return;
      e.preventDefault();
      const after = half(e);
      if (hint?.id !== s.id || hint.after !== after) setHint({ id: s.id, after });
    },
    onDrop: (e) => {
      if (dragKind(e) !== 'part' || !drag) return;
      e.preventDefault();
      const after = half(e);
      const next = after ? m.sections.slice(si + 1).find((x) => x.id !== drag.id) : s;
      movePart(drag.id, next?.id || '');
      endDrag();
    },
  });
  const grip = (kind, id, label) => html`<button type="button" class="agx-grip" draggable="true" aria-label=${label} title="Drag to move"
    onDragStart=${(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData(kind === 'item' ? DRAG_ITEM : DRAG_PART, id); const row = e.currentTarget.closest(kind === 'item' ? '.agx-item' : '.agx-sec'); if (row) e.dataTransfer.setDragImage(row, 24, 20); setDrag({ kind, id }); }}
    onDragEnd=${endDrag}><svg viewBox="0 0 10 16" width="10" height="16" aria-hidden="true"><circle cx="2.5" cy="3" r="1.4" /><circle cx="7.5" cy="3" r="1.4" /><circle cx="2.5" cy="8" r="1.4" /><circle cx="7.5" cy="8" r="1.4" /><circle cx="2.5" cy="13" r="1.4" /><circle cx="7.5" cy="13" r="1.4" /></svg></button>`;
  // An item's ⋯: what it can have and doesn't yet; who sees it; moving it; taking things off it
  const itemMenu = (s, si, it, ii) => {
    const named = it.title || LIVE_TITLES[it.live] || 'this item';
    const first = ii === 0 && si === 0;
    const last = ii === s.items.length - 1 && si === m.sections.length - 1;
    // Words typed under it go only once asked: what took a while to write is never one slip away
    const clear = async (what, text, patch) => {
      if (String(text || '').replace(/[-\s]/g, '') && !(await ask({ title: `Remove ${what} on “${named}”?`, text: 'What’s written there goes with it.', yes: 'Remove', danger: true }))) return;
      setItem(si, ii, patch);
      refocus(it.id, '.agx-item__title');
    };
    return html`<${Menu} label=${`More for ${named}`} items=${[
      !it.presenter && !it.who?.length && !it.showWho && { icon: 'person', label: 'Add who presents', run: () => setItem(si, ii, { showWho: true }) },
      { icon: 'doc', label: 'Add a document', run: () => setItem(si, ii, { showDocs: true }) },
      !it.report && !writing.has(it.id) && { icon: 'report', label: 'Write the report', run: () => write(it.id, true) },
      // What the presenter asks the board to vote on: one line, on the board page, the screen, paper and the minutes template
      !it.motion && !it.showMotion && { icon: 'report', label: 'Ask the board to vote', run: () => setItem(si, ii, { showMotion: true }) },
      // The live lists are on the item itself (Shows); here only the way in for an item that shows none yet
      it.live !== 'minutes' && !showsOf(it).length && !it.showShows && { icon: 'live', label: 'Show live numbers…', run: () => setItem(si, ii, { showShows: true }) },
      { divider: true },
      { icon: 'lock', label: 'Board only', hint: 'Never emailed', checked: !!it.confidential, run: () => setItem(si, ii, { confidential: !it.confidential }) },
      !(it.staffNote || it.showStaff) && { icon: 'private', label: 'Private note', hint: `Only ${others}`, run: () => setItem(si, ii, { showStaff: true }) },
      { divider: true },
      { pair: [
        { icon: 'up', label: 'Move up', disabled: first, title: 'Move up (Alt ↑ in its name does it too)', run: () => { keepClear(ii > 0 ? withMotion(() => setSection(si, { items: move(s.items, ii, -1) })) : moveItem(it.id, m.sections[si - 1].id, ''), `[data-item="${it.id}"]`); refocus(it.id, '.bd-menu > summary'); } },
        { icon: 'down', label: 'Move down', disabled: last, title: 'Move down (Alt ↓ in its name does it too)', run: () => { keepClear(ii < s.items.length - 1 ? withMotion(() => setSection(si, { items: move(s.items, ii, 1) })) : moveItem(it.id, m.sections[si + 1].id, m.sections[si + 1].items[0]?.id || ''), `[data-item="${it.id}"]`); refocus(it.id, '.bd-menu > summary'); } },
      ] },
      { divider: true },
      (it.notes || it.showNotes) && { icon: 'remove', label: 'Remove the background', run: () => clear('the background', it.notes, { notes: '', showNotes: false }) },
      (it.motion || it.showMotion) && { icon: 'remove', label: 'Remove the motion', run: () => clear('the motion', it.motion, { motion: '', showMotion: false }) },
      (it.staffNote || it.showStaff) && { icon: 'remove', label: 'Remove your private note', run: () => clear('your private note', it.staffNote, { staffNote: '', showStaff: false }) },
      it.report && { icon: 'trash', label: 'Delete the report', danger: true, run: async () => { if (await ask({ title: `Delete the report on “${named}”?`, text: `${it.reportBy ? `${it.reportBy} wrote it. ` : ''}The board stops seeing it.`, yes: 'Delete', danger: true })) { write(it.id, false); setItem(si, ii, { report: '' }); refocus(it.id, '.agx-item__title'); } } },
      { icon: 'trash', label: 'Delete the item', danger: true, run: async () => {
        if ((it.notes || it.report) && !(await ask({ title: `Delete “${named}”?`, text: `${it.report ? 'Its report goes with it.' : 'Its notes go with it.'} Its documents stay with the meeting.`, yes: 'Delete', danger: true }))) return;
        // The focus onto what's there now: the next item's name, else the last one's, else the part's "Add an item"
        const next = s.items[ii + 1]?.id || s.items[ii - 1]?.id;
        withMotion(() => setSection(si, { items: s.items.filter((_, j) => j !== ii) }));
        setTimeout(() => (next ? document.querySelector(`[data-item="${next}"] .agx-item__title`) : document.querySelector(`#agx-${s.id} .agx-add`))?.focus(), 140);
      } },
    ]} />`;
  };
  // Alt ↑ ↓ in an item's name moves it, across parts too
  const keys = (s, si, it, ii) => (e) => {
    // A name is one line, however it wraps
    if (e.key === 'Enter' && !e.altKey) { e.preventDefault(); return; }
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
    e.preventDefault();
    const up = e.key === 'ArrowUp';
    let done = null;
    if (up && ii > 0) done = withMotion(() => setSection(si, { items: move(s.items, ii, -1) }));
    else if (!up && ii < s.items.length - 1) done = withMotion(() => setSection(si, { items: move(s.items, ii, 1) }));
    else if (up && si > 0) done = moveItem(it.id, m.sections[si - 1].id, '');
    else if (!up && si < m.sections.length - 1) done = moveItem(it.id, m.sections[si + 1].id, m.sections[si + 1].items[0]?.id || '');
    keepClear(done, `[data-item="${it.id}"]`);
    // Back into its name once it has moved (the move runs inside a view transition)
    setTimeout(() => document.querySelector(`[data-item="${it.id}"] .agx-item__title`)?.focus(), 120);
  };
  // The run of show: the meeting's time and what's planned in it
  const total = [...plan.values()].reduce((n, p) => n + p.minutes, 0);
  const s0 = /^\d{2}:\d{2}$/.test(m.start) ? m.start : '';
  const e0 = /^\d{2}:\d{2}$/.test(m.end) ? m.end : '';
  const length = s0 && e0 ? (Number(e0.slice(0, 2)) * 60 + Number(e0.slice(3))) - (Number(s0.slice(0, 2)) * 60 + Number(s0.slice(3))) : 120;
  const overBy = total - length;
  const lastEnd = [...plan.values()].at(-1)?.end || '';
  // Items with something in them, as the board page and the slides count them (a blank row isn't one)
  const itemCount = agendaItems(m).length;
  return html`<div class="card agx">
    <div class="agx-head">
      <div class="bd-card-head"><h3>Agenda <span class=${`tag ${src.empty ? '' : src.label === 'From email' ? 'tag--info' : 'tag--success'}`}>${src.label}</span></h3>${src.text ? html`<p>${src.text}</p>` : null}</div>
    </div>
    <nav class="agx-run" aria-label="The run of show">
      ${m.sections.map((s, si) => html`<a class=${`agx-run__part ${s.minutes ? 'is-own' : ''}`} key=${s.id} href=${`#agx-${s.id}`} style=${`flex:${plan.get(s.id)?.minutes || 5} 1 0`} title=${`${s.title || 'A part'}: ${plan.get(s.id)?.minutes} min`}
        onClick=${(e) => { e.preventDefault(); document.getElementById(`agx-${s.id}`)?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' }); }}>
        <b>${String(si + 1).padStart(2, '0')}</b>${(plan.get(s.id)?.minutes || 0) / Math.max(1, total) >= 0.085 ? html`<span>${plan.get(s.id)?.minutes} min</span>` : null}<span class="sr-only">, ${s.title || 'a part'}, ${plan.get(s.id)?.minutes} minutes</span>
      </a>`)}
    </nav>
    <p class="agx-runmeta">
      <span>${s0 ? `Starts ${clock(s0)}` : 'Two hours'}</span>
      <span>${plural(m.sections.length, 'part')} · ${plural(itemCount, 'item')}</span>
      <span class=${overBy > 0 ? 'is-over' : ''}>${overBy > 0 ? `${overBy} min over the meeting’s ${length}` : lastEnd ? `Ends ${clock(lastEnd)}` : `${total} min`}</span>
    </p>
    <div class="agx-edit" onFocusIn=${(e) => { const li = e.target.closest?.('[data-item]'); if (li) onFocusItem(li.dataset.item); }} onPointerDown=${(e) => { const li = e.target.closest?.('[data-item]'); if (li) onFocusItem(li.dataset.item); }}>
    <ol class="agx-secs">
      ${m.sections.map((s, si) => {
        const t = plan.get(s.id);
        return html`<li class=${`agx-sec ${drag?.id === s.id ? 'is-dragging' : ''} ${hint?.id === s.id ? (hint.after ? 'drop-after' : 'drop-before') : ''}`} key=${s.id} id=${`agx-${s.id}`} style=${`view-transition-name: agx-${s.id}`} ...${partTarget(s, si)}>
        <div class="ag-sec__head agx-sec__head">
          ${grip('part', s.id, `Move the part ${s.title || si + 1}`)}
          <span class="agx-sec__n" aria-hidden="true">${String(si + 1).padStart(2, '0')}</span>
          <textarea class="ag-input ag-input--sec agx-sec__title" rows="1" aria-label=${`Section ${si + 1}`} value=${s.title} placeholder="Name this part" ref=${grow}
            onInput=${(e) => { grow(e.target); setSection(si, { title: e.target.value.replace(/\s*\n\s*/g, ' ') }); }} onKeyDown=${(e) => { if (e.key === 'Enter') e.preventDefault(); }} />
          <label class="ag-mins" title=${s.minutes ? 'The time this part has. Empty shares out the meeting’s time by itself.' : 'Shared out from the meeting’s time by itself. Type minutes to give it its own.'}>
            ${t?.start ? html`<span class="ag-mins__at">${clock(t.start)}</span>` : null}
            <input type="number" min="1" max="600" inputmode="numeric" aria-label=${`Minutes for ${s.title || `section ${si + 1}`}`} value=${s.minutes || ''} placeholder=${String(t?.minutes || '')} onInput=${(e) => setSection(si, { minutes: Math.max(0, Math.min(600, Math.round(Number(e.target.value) || 0))) })} />
            <span>min</span>
          </label>
          <${Menu} label=${`More for the part ${s.title || si + 1}`} items=${[
            { pair: [
              { icon: 'up', label: 'Move up', disabled: si === 0, run: () => keepClear(withMotion(() => set((x) => ({ sections: move(x.sections, si, -1) }))), `#agx-${s.id}`) },
              { icon: 'down', label: 'Move down', disabled: si === m.sections.length - 1, run: () => keepClear(withMotion(() => set((x) => ({ sections: move(x.sections, si, 1) }))), `#agx-${s.id}`) },
            ] },
            { divider: true },
            { icon: 'trash', label: 'Delete the part', danger: true, run: async () => { if (!s.items.some((it) => it.notes || it.report) || await ask({ title: `Delete “${s.title || 'this part'}”?`, text: 'Its items and their notes go with it. Their documents stay with the meeting.', yes: 'Delete', danger: true })) withMotion(() => set((x) => ({ sections: x.sections.filter((_, i) => i !== si) }))); } },
          ]} />
        </div>
        <ul class="ag-items agx-items">
          ${s.items.map((it, ii) => {
            const files = itemFiles(m, it, data.meetings);
            const free = m.files.filter((f) => !(it.docs || []).includes(f.id) && f.kind !== 'signed');
            const live = it.live && it.live !== 'minutes' ? it.live : '';
            const shows = showsOf(it);
            return html`<li class=${`ag-item agx-item ${over === it.id ? 'is-over' : ''} ${live ? 'has-live' : ''} ${drag?.id === it.id ? 'is-dragging' : ''} ${hint?.id === it.id ? (hint.after ? 'drop-after' : 'drop-before') : ''}`} key=${it.id} data-item=${it.id} style=${`view-transition-name: agx-${it.id}`} ...${itemTarget(s, it)}>
            <div class="ag-item__row agx-item__row">
              ${grip('item', it.id, `Move ${it.title || 'this item'}`)}
              ${labels.get(it.id) ? html`<span class="agx-item__n" aria-hidden="true">${labels.get(it.id)}</span>` : html`<span class="agx-item__n is-blank" aria-hidden="true"></span>`}
              <textarea class="ag-input agx-item__title" rows="1" aria-label=${labels.get(it.id) ? `Item ${labels.get(it.id)}` : 'New item'} value=${it.title} placeholder=${LIVE_TITLES[it.live] || 'What’s it about?'} ref=${grow}
                onInput=${(e) => { grow(e.target); setItem(si, ii, { title: e.target.value.replace(/\s*\n\s*/g, ' ') }); }} onKeyDown=${keys(s, si, it, ii)} />
              <${PersonPicker} people=${people} value=${presentersOf(it, people)} label=${`Who presents ${it.title || 'this item'}`} startOpen=${!!it.showWho}
                onClosed=${() => { if (it.showWho) setItem(si, ii, { showWho: false }); }}
                onChange=${(list) => setItem(si, ii, { who: list.filter((x) => x.slug).map((x) => x.slug), presenter: namesText(list.map((x) => x.name)) })} />
              ${itemMenu(s, si, it, ii)}
            </div>
            ${it.confidential || shows.length || it.showShows || it.live === 'minutes' ? html`<div class="ag-tags agx-tags">
              ${it.live !== 'minutes' && (shows.length || it.showShows) ? html`<${ShowsPicker} value=${shows} label=${`What ${it.title || 'this item'} shows live`} startOpen=${!!it.showShows}
                onClosed=${() => { if (it.showShows) setItem(si, ii, { showShows: false }); }}
                onChange=${(list) => setItem(si, ii, { live: list[0] || '', also: list.slice(1), showShows: true })} />` : null}
              ${it.live === 'minutes' ? html`<span class="agx-live is-minutes"><span class="agx-live__dot" aria-hidden="true"></span>Up for approval</span>` : null}
              ${it.confidential ? html`<span class="tag tag--warn">Board only</span>` : null}
            </div>` : null}
            ${files.length || it.showDocs || busy === it.id ? html`<div class="ag-docs agx-docs">
              ${files.map((f) => {
                const mine = m.files.some((x) => x.id === f.id);
                return html`<${DocChip} key=${f.id} f=${f} link=${mine ? viewerLink(vf, m.files.indexOf(f)) : viewerLink(viewerFiles([f]), 0)} note=${mine ? '' : 'from the last meeting'}
                  onRemove=${mine ? () => set(withItem(it.id, (x) => ({ docs: (x.docs || []).filter((d) => d !== f.id) }))) : null} />`;
              })}
              ${busy === it.id ? html`<span class="bd-muted">Uploading…</span>` : null}
              ${it.showDocs ? html`<${DocAdder} free=${free} onPick=${(f) => set(withItem(it.id, (x) => ({ docs: [...(x.docs || []), f.id] })))} onUpload=${(list) => attach(it.id, list)} onDone=${() => setItem(si, ii, { showDocs: false })} />` : null}
            </div>` : null}
            ${writing.has(it.id) ? html`<div class="agx-report is-writing">
              <${ReportEditor} value=${it.report} onChange=${(md) => setItem(si, ii, { report: md })} label=${`The report on ${it.title || 'this item'}`} autofocus minHeight=${150} starter=${true}
                onNothing=${async (current) => {
                  if (mdWords(current) && !isNothingNew(current) && !(await ask({ title: `Swap the report on “${it.title || 'this item'}” for “${NOTHING_NEW}”?`, text: 'The words written there go.', yes: 'Swap it', careful: true }))) return;
                  setItem(si, ii, { report: NOTHING_NEW });
                  write(it.id, false);
                  refocus(it.id, '.agx-report__head button, .agx-item__title');
                }}
                status=${html`<button type="button" class="btn btn-ghost btn-sm" onClick=${() => { write(it.id, false); refocus(it.id, '.agx-report__head button, .agx-item__title'); }}>Done</button>`}
                coach=${{ part: partFor(m, it.id), admin: true, id: m.id, itemId: it.id, title: it.title, confidential: !!it.confidential, look: it.reportLook || '', onLook: (k) => setItem(si, ii, { reportLook: k }) }} />
            </div>`
            : it.report ? html`<div class="agx-report">
              <div class="agx-report__head"><span class="agx-report__label">Report</span><span class="agx-report__by">${[it.reportBy, it.reportAt ? ago(it.reportAt) : ''].filter(Boolean).join(' · ')}</span>
                <button type="button" class="btn btn-ghost btn-sm" aria-label=${`Edit the report on ${it.title || 'this item'}`} onClick=${() => write(it.id, true)}>Edit</button></div>
              <${Report} text=${it.report} clamp=${50} />
            </div>` : null}
            ${it.motion || it.showMotion ? html`<div class="agx-motion">
              <label class="agx-motion__label" for=${`agx-mo-${it.id}`}>The board votes on</label>
              <textarea id=${`agx-mo-${it.id}`} class="ag-input agx-motion__box" rows="1" maxlength="1000" value=${it.motion || ''} placeholder="Move to …"
                ref=${(el) => { grow(el); if (el && it.showMotion && !it.motion && !el.dataset.focused) { el.dataset.focused = '1'; el.focus({ preventScroll: true }); } }}
                onKeyDown=${(e) => { if (e.key === 'Enter') e.preventDefault(); }}
                onInput=${(e) => { grow(e.target); setItem(si, ii, { motion: e.target.value.replace(/\s*\n\s*/g, ' ') }); }} />
            </div>` : null}
            ${it.notes || it.showNotes ? html`<${NotesBox} label=${`Background for ${it.title || 'this item'}`} value=${it.notes} placeholder="Background for the board" onChange=${(v) => setItem(si, ii, { notes: v })} />` : null}
            ${it.staffNote || it.showStaff ? html`<p class="bd-private-label">Only ${others} see this</p><${NotesBox} tone="is-private" label="Your private note" value=${it.staffNote} placeholder="A private note" onChange=${(v) => setItem(si, ii, { staffNote: v })} />` : null}
            ${over === it.id ? html`<p class="agx-dropnote" aria-hidden="true">Drop to put it with ${it.title || 'this item'}</p>` : null}
          </li>`;
          })}
          <li class=${`agx-end ${hint?.id === `end:${s.id}` ? 'drop-before' : ''}`} ...${partEnd(s)}><button type="button" class="ag-add agx-add" onClick=${() => { const it = blankItem(); withMotion(() => setSection(si, { items: [...s.items, it] })); setTimeout(() => document.querySelector(`[data-item="${it.id}"] .agx-item__title`)?.focus(), 140); }}>+ Add an item</button></li>
        </ul>
      </li>`;
      })}
    </ol>
    <button type="button" class="ag-add ag-add--sec agx-addsec" onClick=${() => { const id = uid('s_'); withMotion(() => set((x) => ({ sections: [...x.sections, { id, title: '', minutes: 0, items: [blankItem()] }] }))); setTimeout(() => document.querySelector(`#agx-${id} .agx-sec__title`)?.focus(), 140); }}>+ Add a part</button>
    </div>
  </div>`;
}

/**
 * The presentation beside the agenda, as it's written: the slide for the item being worked on, ← → through every
 * slide, Play from here (the presentation in its own window, on that slide), and every slide in order to pick from;
 * or the board page, as a laptop or a phone shows it. Each change reaches it a moment later, before it's saved. Never
 * saved from there, and never the board's: they see nothing of a meeting until it's shared
 */
const STAGE_AS = [['screen', 'Presentation'], ['page', 'Board page'], ['phone', 'Phone']];
const SLIDE_KIND = { cover: 'Cover', since: 'Since we met', section: 'Part', item: 'Item', report: 'Report', decision: 'Vote', doc: 'Page', live: 'Live', books: 'QuickBooks', end: 'Close' };
function AgendaStage({ m, focusId, meetings }) {
  const [as, setAs] = useState(() => { try { const k = localStorage.getItem('bd-stage-as'); return STAGE_AS.some(([x]) => x === k) ? k : 'screen'; } catch { return 'screen'; } });
  const pick = (k) => { setAs(k); try { localStorage.setItem('bd-stage-as', k); } catch { /* private browsing */ } };
  const frame = useRef(null);
  const ready = useRef(false);
  const mRef = useRef(m);
  mRef.current = m;
  const focusRef = useRef(focusId);
  focusRef.current = focusId;
  const [box, setBox] = useState({ w: 560, h: 640 });
  const holder = useRef(null);
  const list = useRef(null);
  // The screen in the frame tells its slides and where it is: { stops, at, pages, halves }
  const [deck, setDeck] = useState(null);
  const src = `${PAGE}?preview#/meetings/${encodeURIComponent(m.id)}${as === 'screen' ? '/screen' : ''}`;
  const post = (msg) => frame.current?.contentWindow?.postMessage(msg, location.origin);
  // The frame's size: the screen's 1280 × 720 (or the board page at a laptop's width, or a phone's), scaled to fit
  useEffect(() => {
    const el = holder.current;
    if (!el) return undefined;
    const measure = () => setBox({ w: el.clientWidth, h: Math.max(360, innerHeight - el.getBoundingClientRect().top - 24) });
    measure();
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null;
    ro?.observe(el);
    addEventListener('resize', measure);
    return () => { ro?.disconnect(); removeEventListener('resize', measure); };
  }, []);
  // Once the page in the frame has its data: the draft, and the item worked on; then its slides as they change
  useEffect(() => {
    ready.current = false;
    setDeck(null);
    const on = (e) => {
      if (e.origin !== location.origin || e.source !== frame.current?.contentWindow) return;
      if (e.data?.type === 'board-preview-ready') {
        ready.current = true;
        post({ type: 'board-preview', meeting: mRef.current });
        if (focusRef.current) post({ type: 'board-preview-focus', itemId: focusRef.current });
      }
      if (e.data?.type === 'board-preview-deck' && e.data.id === mRef.current.id && Array.isArray(e.data.stops)) setDeck(e.data);
    };
    addEventListener('message', on);
    return () => removeEventListener('message', on);
  }, [src]);
  useEffect(() => { if (!ready.current) return undefined; const t = setTimeout(() => post({ type: 'board-preview', meeting: m }), 180); return () => clearTimeout(t); }, [m]);
  useEffect(() => { if (ready.current && focusId) post({ type: 'board-preview-focus', itemId: focusId }); }, [focusId]);
  const stops = as === 'screen' ? deck?.stops || [] : [];
  const at = Math.min(deck?.at || 0, Math.max(0, stops.length - 1));
  const items = useMemo(() => agendaItems(m), [m.sections]);
  const files = useMemo(() => [...m.files, ...(meetings || []).flatMap((x) => x.files || [])], [m.files, meetings]);
  const words = (s) => stopWords(s, m, items, deck?.pages || {}, files, deck?.halves || {});
  const step = (dir) => post({ type: 'board-preview-step', dir });
  // A slide picked: on the screen here, and its item brought into view in the agenda
  const goTo = (s) => { post({ type: 'board-preview-stop', key: s.key }); if (s.itemId) dispatchEvent(new CustomEvent('agx-go', { detail: { id: s.itemId } })); };
  // The slide on, kept in view in the list (the list scrolls, never the page)
  useEffect(() => {
    const el = list.current?.querySelector('.is-on');
    const box2 = list.current;
    if (!el || !box2) return;
    const top = el.offsetTop - box2.offsetTop;
    if (top < box2.scrollTop + 8 || top + el.offsetHeight > box2.scrollTop + box2.clientHeight - 8) box2.scrollTop = Math.max(0, top - box2.clientHeight / 3);
  }, [at, stops.length]);
  const onKeys = (e) => {
    if (as !== 'screen' || e.altKey || e.metaKey || e.ctrlKey || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') { e.preventDefault(); step(e.key === 'ArrowRight' ? 1 : -1); }
  };
  // The board page at a small laptop's width (its words read at the size they're shown here), a phone's, or the screen's
  const base = as === 'phone' ? { w: 390, h: 844 } : as === 'screen' ? { w: 1280, h: 720 } : { w: 1024, h: 0 };
  const scale = Math.min(1, (box.w - (as === 'phone' ? 28 : 2)) / base.w);
  const h = as === 'page' ? box.h : Math.round(base.h * scale);
  const now = stops[at] ? words(stops[at]) : null;
  return html`<aside class=${`agx-stage is-${as}`} aria-label="The presentation, as you build the agenda" onKeyDown=${onKeys}>
    <div class="agx-stage__bar">
      <div class="bd-seg" role="group" aria-label="Show">
        ${STAGE_AS.map(([k, label]) => html`<button type="button" key=${k} aria-pressed=${as === k} class=${as === k ? 'is-on' : ''} onClick=${() => pick(k)}>${label}</button>`)}
      </div>
      <span class="agx-stage__note">${m.shared ? 'As the board sees it' : 'Only you see this until it’s shared'}</span>
    </div>
    <div class=${`agx-stage__frame is-${as}`} ref=${holder} style=${`height:${h + (as === 'phone' ? 28 : 2)}px`}>
      <iframe ref=${frame} src=${src} key=${src} title=${as === 'screen' ? 'The presentation' : `The board page, as ${as === 'phone' ? 'a phone' : 'a laptop'} shows it`}
        style=${`width:${base.w}px;height:${Math.round(h / scale)}px;transform:scale(${scale})`}></iframe>
    </div>
    ${as === 'screen' ? html`
      <div class="agx-stage__nav">
        <button type="button" class="bd-icon-btn agx-stage__step" disabled=${!stops.length || at <= 0} onClick=${() => step(-1)} aria-label="Back a slide" title="Back a slide (←)">‹</button>
        <span class="agx-stage__count" aria-live="polite">${stops.length ? html`<b>${at + 1}</b> of ${stops.length}` : 'Opening…'}</span>
        <button type="button" class="bd-icon-btn agx-stage__step" disabled=${!stops.length || at >= stops.length - 1} onClick=${() => step(1)} aria-label="Next slide" title="Next slide (→)">›</button>
        <span class="agx-stage__now">${now ? html`${now.label ? html`<b>${now.label}</b>` : null}<span>${now.title}</span>` : null}</span>
        <button type="button" class="btn btn-primary btn-sm agx-stage__play" disabled=${!stops.length} onClick=${() => openScreen(m.id, stops[at]?.key || '')} title="The presentation in its own window, from this slide: share it on Google Meet or put it on the TV">Play from here</button>
      </div>
      <ol class="agx-slides" ref=${list} aria-label="Every slide, in order">
        ${stops.map((s, i) => {
          const w = words(s);
          return html`<li key=${s.key}><button type="button" class=${`agx-slide is-${s.kind} ${i === at ? 'is-on' : ''}`} aria-current=${i === at ? 'step' : null} onClick=${() => goTo(s)}>
            <span class="agx-slide__n">${i + 1}</span>
            <span class="agx-slide__t">${w.label && s.kind !== 'doc' && s.kind !== 'live' && s.kind !== 'books' ? html`<b>${w.label}</b>` : null}${w.title}${s.kind === 'doc' && w.sub ? html`<small>${w.sub.split(' · ').slice(1).join(' · ')}</small>` : null}</span>
            <span class="agx-slide__k">${SLIDE_KIND[s.kind] || ''}</span>
          </button></li>`;
        })}
      </ol>` : null}
  </aside>`;
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
/** What a board file can be (as the server takes it): PDFs, pictures, Word, Excel and PowerPoint */
const FILE_OK = /\.(pdf|jpe?g|png|webp|heic|docx?|xlsx?|pptx)$/i;
const extOf = (name) => (String(name).match(/\.[a-z0-9]{2,5}$/i) || [''])[0];

function FilesCard({ m, set, ctx, keepSaved, title, sub, goes = false }) {
  const { addToast } = ctx;
  const [uploading, setUploading] = useState([]); // the names on their way up
  const [renaming, setRenaming] = useState('');
  const renamed = useRef(''); // a rename saves once: Enter, or the box losing the focus, whichever comes first
  const [over, setOver] = useState(false);
  const items = agendaItems(m);
  const whereOf = (f) => items.find((it) => m.sections[it.si].items[it.ii].docs?.includes(f.id))?.id || '';
  const add = async (list) => {
    const all = [...(list || [])];
    const bad = all.filter((f) => !FILE_OK.test(f.name));
    if (bad.length) addToast(`${bad.length === 1 ? bad[0].name : plural(bad.length, 'file')} can’t go in: a PDF, a picture, or a Word, Excel or PowerPoint file can.`, 'error');
    const files = all.filter((f) => FILE_OK.test(f.name));
    if (!files.length) return;
    setUploading((u) => [...u, ...files.map((f) => f.name)]);
    const added = [];
    for (const f of files) {
      const kind = kindOfName(f.name);
      const j = await upload(f, { ownerType: 'meeting', ownerId: m.id, kind: goes && (kind === 'minutes' || kind === 'signed') ? 'other' : kind });
      if (j.ok) added.push(j.file); else addToast(`${f.name}: ${j.error}`, 'error');
      setUploading((u) => { const i = u.indexOf(f.name); return i < 0 ? u : [...u.slice(0, i), ...u.slice(i + 1)]; });
    }
    keepSaved((x) => ({ ...x, files: [...x.files, ...added] }));
    // The focus goes to the file that came in
    if (added.length) requestAnimationFrame(() => document.querySelector(`#${cardId} [data-file="${added[0].id}"]`)?.focus());
    if (!goes) { if (added.length) addToast(`${added.length === 1 ? docTitle(added[0].name) : plural(added.length, 'file')} added`, 'info'); return; }
    const placed = added.map((f) => [f, guessItem(m, f)]).filter(([, id]) => id);
    for (const [f, id] of placed) set(placeFile(f.id, id));
    // What went where, and what's on no item yet, in one message
    const loose = added.filter((f) => !placed.some(([x]) => x.id === f.id));
    const said = [
      placed.length === 1 ? `${docTitle(placed[0][0].name)} goes with ${items.find((it) => it.id === placed[0][1])?.title || 'its item'}` : placed.length ? `${plural(placed.length, 'file')} put with their agenda items` : '',
      loose.length ? `${loose.length === 1 ? docTitle(loose[0].name) : plural(loose.length, 'file')} ${loose.length === 1 ? 'is' : 'are'} on no item yet: choose one, or leave ${loose.length === 1 ? 'it' : 'them'} for the end` : '',
    ].filter(Boolean);
    if (said.length) addToast(`${said.join('. ')}.`, 'info');
  };
  const update = async (f, patch, said = '', undo = null) => {
    const j = await call({ action: 'update-file', id: f.id, ...patch });
    if (!j.ok) { addToast(j.error, 'error'); return false; }
    keepSaved((x) => ({ ...x, files: x.files.map((y) => (y.id === f.id ? { ...y, ...j.file } : y)) }));
    if (said) addToast(said, 'info', undo ? { label: 'Undo', fn: () => update({ ...f, ...j.file }, undo) } : undefined);
    return true;
  };
  const remove = async (f, at) => {
    if (!(await ask({ title: `Delete ${docTitle(f.name)}?`, text: 'It goes for good, from the board page too.', yes: 'Delete', danger: true }))) return;
    const j = await call({ action: 'delete-file', id: f.id });
    if (!j.ok) { addToast(j.error, 'error'); return; }
    keepSaved((x) => ({ ...x, files: x.files.filter((y) => y.id !== f.id) }));
    set(placeFile(f.id, ''));
    // The focus goes to the file that took its place, else to adding one
    requestAnimationFrame(() => (document.querySelectorAll(`#${cardId} .bd-file-name`)[at] || document.querySelector(`#${cardId} .bd-drop .btn`))?.focus());
  };
  const rename = async (f, typed) => {
    if (renamed.current === f.id) return;
    renamed.current = f.id;
    const name = typed.trim();
    setRenaming('');
    if (name && name !== docTitle(f.name)) await update(f, { name: `${name}${extOf(f.name)}` }, `Renamed ${name}`, { name: f.name });
    requestAnimationFrame(() => document.querySelector(`#${cardId} [data-file="${f.id}"]`)?.focus());
  };
  // A file dropped anywhere on Before goes in the packet (an agenda item dragged never carries files)
  useEffect(() => {
    if (!goes) return undefined;
    const has = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
    const enter = (e) => { if (has(e)) { e.preventDefault(); setOver(true); } };
    const leave = (e) => { if (!e.relatedTarget) setOver(false); };
    const drop = (e) => { if (!has(e)) return; e.preventDefault(); setOver(false); add(e.dataTransfer.files); };
    window.addEventListener('dragover', enter);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => { window.removeEventListener('dragover', enter); window.removeEventListener('dragleave', leave); window.removeEventListener('drop', drop); };
  }, [goes, m.id, m.sections]);
  // The packet is what goes out before the meeting: this meeting's own minutes and their signed copy are After's
  const files = goes ? m.files.filter((f) => f.kind !== 'minutes' && f.kind !== 'signed') : m.files;
  const vf = viewerFiles(files);
  // The packet is one list (what matters there is the item each goes with); Every file is by kind
  const groups = goes ? [[null, files.map((f, i) => ({ f, i }))]].filter(([, l]) => l.length)
    : FILE_KINDS.map((k) => [k, files.map((f, i) => ({ f, i })).filter(({ f }) => (FILE_KINDS.some((x) => x.id === f.kind) ? f.kind : 'other') === k.id)]).filter(([, l]) => l.length);
  // What a file can be filed as: before the meeting, nothing that's this meeting's own minutes
  const kinds = goes ? FILE_KINDS.filter((x) => ['financials', 'agenda', 'other'].includes(x.id)) : FILE_KINDS;
  const cardId = goes ? 'bm-packet' : 'bm-files';
  let at = -1;
  return html`<div class=${`card bm-files ${over ? 'is-over' : ''}`} id=${cardId}>
    <div class="bd-card-head"><h3>${title}${files.length ? html` <span class="count">${files.length}</span>` : null}</h3><p>${sub}</p></div>
    ${groups.map(([k, list]) => html`<div class="bf-group">
      ${k && groups.length > 1 ? html`<p class="bm-group">${k.label}</p>` : null}
      <ul class="bf-list">${list.map(({ f, i }) => {
        const n = (at += 1);
        const name = docTitle(f.name);
        return html`<li class="bf-file" key=${f.id}>
        <div class="bf-file__main">${renaming === f.id
          ? html`<input class="form-input bf-rename" aria-label=${`New name for ${name}`} value=${name} ref=${(el) => { if (el && !el.dataset.on) { el.dataset.on = '1'; renamed.current = ''; el.focus(); el.select(); } }}
              onKeyDown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); rename(f, e.target.value); } if (e.key === 'Escape') { e.preventDefault(); setRenaming(''); } }} onBlur=${(e) => rename(f, e.target.value)} />`
          : html`<a class="bd-file-name" data-file=${f.id} ...${viewerLink(vf, i)}>${name}</a>`}<div class="bd-row__meta">${[sizeText(f.size), f.at ? `added ${shortDate(f.at.slice(0, 10))}` : ''].filter(Boolean).join(' · ')}</div></div>
        ${goes && f.kind !== 'signed' ? html`<${ItemChooser} items=${items} value=${whereOf(f)} label=${`Which agenda item ${name} goes with`} onChange=${(id) => set(placeFile(f.id, id))} />` : null}
        <button type="button" role="switch" class=${`bf-seen ${f.staffOnly ? 'is-staff' : ''}`} aria-checked=${!f.staffOnly} aria-label=${`The board sees ${name}`}
          onClick=${() => update(f, { staffOnly: !f.staffOnly }, f.staffOnly ? `The board sees ${name}` : `${name} is staff only: only ${youAnd(ctx.data.settings.admins, ctx.data.me)} see it`, { staffOnly: !!f.staffOnly })}>
          <span class="bf-seen__track" aria-hidden="true"><span class="bf-seen__dot"></span></span><span class="bf-seen__t">${f.staffOnly ? 'Staff only' : 'Board sees it'}</span></button>
        <${Menu} label=${`More for ${name}`} items=${[
          { icon: 'rename', label: 'Rename', run: () => setRenaming(f.id) },
          { divider: true },
          { heading: 'File it under' },
          ...kinds.map((x) => ({ label: x.label, chosen: x.id === f.kind, run: () => { if (x.id !== f.kind) update(f, { kind: x.id }, `${name} is under ${x.label}`, { kind: f.kind }); } })),
          { divider: true },
          { icon: 'trash', label: 'Delete the file', danger: true, run: () => remove(f, n) },
        ]} />
      </li>`;
      })}</ul>
    </div>`)}
    ${uploading.length ? html`<ul class="bf-list bf-up" aria-live="polite">${uploading.map((name, i) => html`<li class="bf-file is-up" key=${`${name}-${i}`}><span class="spinner" aria-hidden="true"></span><div class="bf-file__main"><span class="bd-file-name">${docTitle(name)}</span><div class="bd-row__meta">Uploading…</div></div></li>`)}</ul>` : null}
    <div class=${`bd-drop ${over ? 'is-over' : ''}`} style=${files.length || uploading.length ? 'margin-top:0.75rem' : ''} onDragOver=${(e) => { e.preventDefault(); if (!goes) setOver(true); }} onDragLeave=${() => { if (!goes) setOver(false); }}
      onDrop=${(e) => { e.preventDefault(); e.stopPropagation(); setOver(false); add(e.dataTransfer.files); }}>
      <label class="btn btn-ghost btn-sm bd-pick">Add files<input type="file" class="sr-only" multiple accept=".pdf,.jpg,.jpeg,.png,.webp,.heic,.docx,.xlsx,.pptx,.doc,.xls" onChange=${(e) => { add(e.target.files); e.target.value = ''; }} /></label>
      <span class="bd-muted bd-drop__hint">${over ? 'Let go to add them' : goes ? 'or drop them anywhere on this page' : 'or drop them here'}</span>
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
      <div class="bm-task__t" tabindex="-1">${title}</div>
      ${sub ? html`<div class="bm-task__s">${sub}</div>` : null}
      ${kids.length ? html`<div class="bm-task__do">${kids}</div>` : null}
    </div>
  </li>`;
};
/** States for a list of done flags: the first not done is next */
const statesOf = (dones) => { const first = dones.indexOf(false); return dones.map((d, i) => (d ? 'done' : i === first ? 'next' : 'todo')); };
const btn = (state) => `btn btn-sm ${state === 'next' ? 'btn-primary' : 'btn-ghost'}`;
/**
 * Once one's done, the focus goes to what's next: its name, never a button (a space or Enter typed a moment later
 * mustn't send anything), and never the undo that just took the done one's place
 */
const focusNext = (sel) => requestAnimationFrame(() => (document.querySelector(`${sel} .bm-task.is-next .bm-task__t`) || document.querySelector(`${sel} h3`))?.focus());
const NO_MAIL = html`<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6h16v12H4z" /><path d="m4 7 8 6 8-6" /><path d="M3 21 21 3" /></svg>`;
/** Board members with no email on file: named where it matters, each with the way to add theirs */
function NoEmail({ ctx, what }) {
  const none = ctx.data.members.filter((x) => !x.email);
  if (!none.length) return null;
  const one = none.length === 1;
  return html`<p class="bm-note is-warn" role="note">${NO_MAIL}<span><strong>${namesText(none.map((x) => x.name))} ${one ? 'has' : 'have'} no email on file</strong>, so ${one ? 'gets' : 'get'} ${what}.${none.map((x) => html` <a class="link" href=${`#people/board/${x.slug}`}>${one ? 'Add it' : `Add ${x.name.split(' ')[0]}’s`}</a>`)}</span></p>`;
}

function GettingReady({ m, set, ctx, act, save }) {
  const { data, addToast } = ctx;
  const [working, setWorking] = useState('');
  const run = async (name, body, ok) => { setWorking(name); const j = await act(body); setWorking(''); if (j && ok) addToast(typeof ok === 'function' ? ok(j) : ok, 'info'); if (j && !body.test) focusNext('.bm-ready'); return j; };
  // Shared says so and moves on to what's next; taking it off asks first (its button is where Share was)
  const share = async (v) => {
    if (!v && !(await ask({ title: 'Take it off the board page?', text: 'Board members stop seeing its agenda and files until you share it again.', yes: 'Take it off' }))) return;
    set({ shared: v });
    await new Promise((r) => setTimeout(r, 0));
    await save();
    addToast(v ? 'On the board page: board members see the agenda and files' : 'Taken off the board page', 'info', v ? { label: 'Undo', fn: () => { set({ shared: false }); addToast('Taken off the board page', 'info'); } } : undefined);
    focusNext('.bm-ready');
  };
  // The invite: who's on it, and who should be
  const inv = m.invite;
  const from = inv?.organizer || data.settings.invitesFrom;
  // The organizer reads "your calendar"; anyone else reads whose it is
  const whoseOf = (e) => (String(e || '').toLowerCase() === String(data.me || '').toLowerCase() ? 'your' : `${firstOf(e)}’s`);
  const whose = whoseOf(from);
  const nameOf = (e) => data.members.find((x) => x.email === e)?.name || firstOf(e);
  // Who's added besides the board: the other admins (the organizer is on it already)
  const alsoAdded = data.settings.admins.filter((e) => e !== from).map(firstOf);
  const adds = `the board${alsoAdded.length ? ` and ${andList(alsoAdded)}` : ''}`;
  const guests = [...new Set([...data.members.map((x) => x.email).filter(Boolean), ...data.settings.admins])];
  const missing = inv ? guests.filter((e) => !(inv.emails || []).includes(e) && e !== inv.organizer) : [];
  const transcript = !inv ? '' : inv.transcript === 'on' ? 'transcripts on' : inv.transcript === 'needs-setup' ? 'transcript needs one Google setting (see Meetings)' : inv.transcript === 'error' ? 'no transcript (SOARD’s Google plan)' : '';
  const placeNow = [m.location, m.address].filter(Boolean).join(', ');
  // A new day, time or place: onto the invite once the typing has stopped (functions/api/_board-invite.js, whose "when"
  // is "YYYY-MM-DD HH:MM-HH:MM")
  const changed = !inv ? [] : [m.date !== String(inv.when).slice(0, 10) && 'day', `${m.start || ''}-${m.end || ''}` !== String(inv.when).slice(11) && 'time', !!placeNow && placeNow !== inv.place && 'place'].filter(Boolean);
  const where = !inv ? '' : changed.length ? `the new ${andList(changed)} ${changed.length > 1 ? 'go' : 'goes'} on it a couple of minutes after you stop typing` : inv.place ? `at ${inv.place}` : 'the place goes on it when you add one';
  // Board meeting invites Board didn't send, on an admin's calendar on this meeting's day (functions/api/_board-calendar.js)
  const others = data.calendar?.others?.[m.id] || [];
  const senders = [...new Set(others.map((o) => o.by).filter(Boolean))];
  const mineOnly = senders.length === 1 && senders[0] === String(data.me || '').toLowerCase();
  const senderName = (e) => (/@soardcharity\.com$/i.test(e) ? firstOf(e) : data.members.find((x) => x.email === e)?.name || e);
  // The invite check found the organizer's Google account can't have transcripts: they're not promised
  const noTranscripts = !!data.google?.check && data.google.check.transcript === 'error';
  const meetWords = noTranscripts ? 'Google Meet' : 'Google Meet with transcripts on';
  // What the board gets: the packet, as they see it (never this meeting's own minutes, nor a staff-only file)
  const docs = m.files.filter((f) => !f.staffOnly && f.kind !== 'minutes' && f.kind !== 'signed');
  const [sInvite, sShared, sSent] = statesOf([!!inv && !missing.length, m.shared, !!m.packetSentAt]);
  // The reports: each presenter writes theirs on the board page (it asks them there); here, which are in
  const people = useMemo(() => pickable(data.people), [data.people]);
  const asked = agendaItems(m).map((x) => ({ x, it: m.sections[x.si].items[x.ii] })).filter(({ it }) => reportsOn(it));
  // Who can sign in to the board page to write theirs: a board member with an email on file, or one of Board's admins
  const admins = data.settings.admins.map((e) => String(e).toLowerCase());
  const signsIn = (p) => !!p.slug && (data.members.some((x) => x.slug === p.slug && x.email) || data.people.staff.some((x) => x.slug === p.slug && admins.some((e) => e.startsWith(`${String(x.name).split(/\s+/)[0].toLowerCase()}@`))));
  const here = (it) => !presentersOf(it, people).some(signsIn);
  const inCount = asked.filter(({ it }) => it.report).length;
  // Emailing the link puts the meeting on the board page first: one press, not two
  const email = async () => {
    const to = data.members.filter((x) => x.email).map((x) => x.name);
    const none = data.members.filter((x) => !x.email).map((x) => x.name);
    if (!(await ask({ title: `Email ${andList(to)} the link?`, text: `${m.shared ? 'They get' : 'The meeting goes on the board page, and they get'} the link to the agenda${docs.length ? ` and ${plural(docs.length, 'document')}` : ' (no documents yet)'}, and anyone on the calendar invite who hasn’t answered it is asked to. Nothing is attached.${none.length ? ` ${andList(none)} ${none.length === 1 ? 'has' : 'have'} no email, so ${none.length === 1 ? 'gets' : 'get'} nothing.` : ''}`, yes: m.packetSentAt ? 'Email them again' : 'Email the board' }))) return;
    if (!m.shared) { set({ shared: true }); await new Promise((r) => setTimeout(r, 0)); await save(); }
    run('send', { action: 'send-packet', id: m.id }, (j) => `Emailed ${plural(j.sent, 'board member')}`);
  };
  // The invite names who Google emails before it goes, and who it can't reach
  const noEmail = data.members.filter((x) => !x.email).map((x) => x.name);
  const invite = async () => {
    const to = inv ? missing : guests.filter((e) => e !== from);
    const names = andList(to.map(nameOf));
    if (!(await ask({
      title: !inv ? 'Send the invite?' : `Add ${names} to the invite?`,
      text: !inv ? `Google emails the invite to ${names}, with ${meetWords}, the place and the link to the agenda.${noEmail.length ? ` ${andList(noEmail)} ${noEmail.length === 1 ? 'has' : 'have'} no email, so ${noEmail.length === 1 ? 'gets' : 'get'} no invite.` : ''}` : `Google emails ${to.length === 1 ? 'the invite to them' : 'each of them the invite'}. Nobody else hears about it.`,
      yes: !inv ? 'Send the invite' : 'Add them',
    }))) return;
    run('invite', { action: 'send-invite', id: m.id }, () => `Invite sent to ${names}`);
  };
  // Held (its day gone by, or run here and ended): what was done, nothing left to send
  if (((m.date && m.date < todayEastern()) || m.live.endedAt) && !isLive(m)) {
    return html`<div class="card bm-check bm-ready">
      <div class="bd-card-head"><h3 tabindex="-1">Getting ready</h3><p>${m.live.endedAt ? 'This meeting was held' : `This meeting was on ${longDate(m.date)}`}. ${minutesIn(m) ? 'Its minutes are in After.' : 'Its minutes go in After.'}</p></div>
      <ol class="bm-tasks">
        <${Task} state=${inv ? 'done' : 'skip'} title=${inv ? `Invite sent from ${whoseOf(inv.organizer)} calendar` : 'No invite went out from Board'} />
        <${Task} state=${m.shared ? 'done' : 'skip'} title=${m.shared ? 'On the board page' : 'Not on the board page'} sub=${m.shared ? '' : 'It goes there with its minutes, from After.'} />
        <${Task} state=${m.packetSentAt ? 'done' : 'skip'} title=${m.packetSentAt ? `${plural(m.packetSentTo, 'board member')} emailed the link` : 'The board wasn’t emailed the link'} />
      </ol>
    </div>`;
  }
  return html`<div class="card bm-check bm-ready">
    <div class="bd-card-head"><h3 tabindex="-1">Getting ready</h3><p>${[sInvite, sShared, sSent].every((x) => x === 'done') ? 'The invite, the board page and the email are done. The numbers lock on the meeting day.' : 'The agenda is ready, and the numbers lock on the meeting day. What’s left:'}</p></div>
    <${NoEmail} ctx=${ctx} what="no invite or email, and can’t check in on the board page" />
    <ol class="bm-tasks">
      <${Task} state=${sInvite} title=${inv ? `Invite sent from ${whoseOf(inv.organizer)} calendar` : m.inviteGone ? 'The invite was deleted' : 'Send the invite'}
        sub=${inv ? [plural(inv.guests, 'guest'), inv.meet ? 'Google Meet' : '', transcript, where, missing.length ? `${andList(missing.map(nameOf))} not on it yet` : '', inv.putBackAt ? `changed in Google Calendar, Board’s put back ${ago(inv.putBackAt)}` : ''].filter(Boolean).join(' · ')
          : m.inviteGone ? `Someone deleted it in Google Calendar ${ago(m.inviteGone)}, so it’s off the board’s calendars. Send it again, or delete this meeting (⋯ at the top).`
          : `From ${whose} calendar to ${adds}: ${meetWords}, the place and the link to the agenda.`}>
        ${!inv || missing.length ? html`<button class=${btn(sInvite)} disabled=${!!working || !data.setup.calendar || !m.date} onClick=${invite}>
          ${working === 'invite' ? 'Sending…' : !inv ? (m.inviteGone ? 'Send it again' : 'Send the invite') : `Add ${missing.length === 1 ? nameOf(missing[0]).split(' ')[0] : `the ${missing.length} missing`}`}</button>` : null}
        ${!data.setup.calendar ? html`<span class="bd-muted">Board can’t reach Google Calendar yet (Settings).</span>` : null}
        ${inv?.differs ? html`<div class="bm-note is-warn" role="note"><span>Someone changed this invite in Google Calendar again after Board put its day, time and place back. Change them here (Change when and where) and they go on it, or send Board’s again.</span>
          <button class="btn btn-sm btn-primary" disabled=${!!working} onClick=${() => run('invite', { action: 'send-invite', id: m.id }, 'Board’s day, time and place are back on the invite')}>${working === 'invite' ? 'Sending…' : 'Send Board’s again'}</button></div>` : null}
        ${others.length ? html`<p class="bm-note is-warn" role="note">${others.length === 1 ? 'Another invite for this meeting is' : `${others.length} other invites for this meeting are`} on ${andList([...new Set(others.map((o) => whoseOf(o.on)))])} calendar: ${andList(others.map((o) => `“${o.title}”`))}${senders.length && !mineOnly ? `, sent by ${andList(senders.map(senderName))}` : ''}. ${mineOnly ? `Cancel ${others.length === 1 ? 'it' : 'them'}` : `Ask ${senders.length ? (senders.length === 1 ? 'them' : 'each') : 'whoever sent it'} to cancel ${others.length === 1 ? 'it' : 'theirs'}`}, so the board has one invite and one call.</p>` : null}
      </${Task}>
      <${Task} state=${sShared} title=${m.shared ? 'On the board page' : 'Put it on the board page'} sub=${m.shared ? 'Board members see the agenda and files (never a private note or a staff-only file).' : 'Board members see nothing of this meeting until then. Emailing the board puts it there too.'}>
        ${m.shared ? html`<button class="btn btn-ghost btn-sm" onClick=${() => share(false)}>Take it off</button>` : html`<button class=${btn(sShared)} onClick=${() => share(true)}>Share with the board</button>`}
      </${Task}>
      <${Task} state=${sSent} title=${m.packetSentAt ? `${plural(m.packetSentTo, 'board member')} emailed the link` : 'Email the board the link'}
        sub=${m.packetSentAt ? ago(m.packetSentAt) : `It goes by itself when the agenda is approved on the chair’s review (on the board page, where you can approve it too), or now from here. The link to the agenda and ${docs.length ? `the ${plural(docs.length, 'document')} by name` : 'the documents by name'} (nothing attached), and a nudge to answer the calendar invite for anyone who hasn’t. It goes to ${plural(data.packetTo, 'board member')}.`}>
        <button class="btn btn-ghost btn-sm" disabled=${!!working || !data.setup.email} onClick=${() => run('preview', { action: 'send-packet', id: m.id, test: true }, (j) => `Sent to ${j.to?.[0] || 'you'}`)}>${working === 'preview' ? 'Sending…' : 'Send me the email'}</button>
        <button class=${btn(sSent)} disabled=${!!working || !data.packetTo || !data.setup.email} onClick=${email}>${working === 'send' ? 'Sending…' : m.packetSentAt ? 'Email again' : 'Email the board'}</button>
        ${!data.setup.email ? html`<span class="bd-muted">Email isn’t set up yet (Settings).</span>` : null}
      </${Task}>
    </ol>
    ${asked.length ? html`<div class="bm-reports">
      <p class="bm-reports__h"><strong>Reports</strong><span class=${inCount === asked.length ? 'is-all' : ''}>${inCount} of ${asked.length} in</span></p>
      <p class="bd-muted">${asked.every(({ it }) => here(it)) ? 'These presenters don’t sign in to the board page, so their reports are written here: tap one to write it.' : `${m.shared ? 'Each presenter writes theirs on the board page, where it asks them.' : 'Once the meeting is on the board page, each presenter writes theirs there.'}${asked.some(({ it }) => here(it)) ? ' Where it says “Write it here”, the presenter doesn’t sign in to the board page: tap it to write theirs here.' : ''}`}</p>
      <ul class="bm-reports__list">${asked.map(({ x, it }) => html`<li key=${it.id}>
        <a class=${`bm-reports__row ${it.report ? 'is-in' : ''}`} href=${`#agx-${m.sections[x.si].id}`} onClick=${(e) => { e.preventDefault(); dispatchEvent(new CustomEvent('agx-report', { detail: { id: it.id, write: !it.report } })); }}>
          <span class="bm-reports__n">${x.label}</span>
          <span class="bm-reports__t"><span>${x.title}</span><small>${namesText(presentersOf(it, people).map((p) => (presentersOf(it, people).length > 1 ? p.name.split(' ')[0] : p.name)))}</small></span>
          <span class="bm-reports__s">${it.report ? html`${CHECK}<span>${ago(it.reportAt) || 'In'}</span>` : here(it) ? 'Write it here' : 'Not yet'}</span>
        </a>
      </li>`)}</ul>
    </div>` : null}
  </div>`;
}

/** Who's coming: answers on the board page and replies to the calendar invite */
function Coming({ m, ctx, act }) {
  const { data, addToast } = ctx;
  const [working, setWorking] = useState('');
  const [asked, setAsked] = useState(null); // { names, at } once a reminder went (here, this visit)
  const askRef = useRef(null);
  const board = m.attendance.filter((x) => x.kind === 'board');
  // Their reply to the calendar invite, the only answer SOARD goes by (Peter, Nov 2 2026); checked in on the day, there
  const replies = repliesOf(m);
  const answer = (x) => (x.status === 'present' ? 'Coming' : x.status === 'remote' ? 'By video' : answerOf('', replies[x.slug]));
  const emailOf = (x) => data.members.find((y) => y.slug === x.slug)?.email || '';
  // Before any invite went out nobody is "not on" it
  const invited = !!m.invite?.eventId;
  const groups = [['Coming', board.filter((x) => answer(x) === 'Coming')], ['By video', board.filter((x) => answer(x) === 'By video')], ['Maybe', board.filter((x) => answer(x) === 'Maybe')], ['Can’t come', board.filter((x) => answer(x) === 'Can’t come')],
    ['No answer', board.filter((x) => !answer(x) && replies[x.slug])], [invited ? 'Not on the invite' : 'No invite yet', board.filter((x) => !answer(x) && !replies[x.slug])]];
  const quiet = groups.at(-2)[1].filter(emailOf);
  const off = invited ? groups.at(-1)[1] : [];
  // Only someone with an email on file can be added (Getting ready's button adds them)
  const addable = off.filter(emailOf);
  const them = addable.length === 1 ? 'them' : 'them all';
  const adds = !addable.length ? 'they have no email on file' : `Send the invite adds ${them}${addable.length < off.length ? ` (${off.length - addable.length} with no email can’t be)` : ''}`;
  // A reminder names who gets it before it goes
  const remind = async (test) => {
    if (!test && !(await ask({ title: `Ask ${andList(quiet.map((x) => x.name))}?`, text: `${quiet.length === 1 ? 'They get' : 'Each gets'} an email asking them to answer the calendar invite. Their answer shows here.`, yes: quiet.length === 1 ? 'Ask them' : `Ask all ${quiet.length}` }))) return;
    setWorking(test ? 'preview' : 'send');
    const j = await act({ action: 'remind-rsvp', id: m.id, test });
    setWorking('');
    if (j) addToast(test ? `Sent to ${j.to?.[0] || 'you'}` : `Asked ${plural(j.sent, 'board member')}${j.notOnInvite?.length ? `. Not on the invite: ${j.notOnInvite.join(', ')}` : ''}`, 'info');
    if (j && !test) setAsked({ names: andList(quiet.map((x) => x.name.split(' ')[0])), at: new Date().toISOString() });
    requestAnimationFrame(() => askRef.current?.focus());
  };
  const answered = board.length - groups.at(-2)[1].length - groups.at(-1)[1].length;
  // Past (and not run here): who was there is the minutes' to say
  if (m.date && m.date < todayEastern() && !m.live.startedAt) return null;
  return html`<div class="card bm-coming">
    <div class="bd-card-head"><h3>Who’s coming</h3><p>${answered ? `${answered} of ${board.length} board members ${answered === 1 ? 'has' : 'have'} answered` : 'Nobody has answered'} the calendar invite${!invited ? '. The invite hasn’t gone out yet' : off.length ? `. ${off.length === 1 ? `${off[0].name} isn’t` : `${off.length} aren’t`} on it: ${adds}` : ''}.</p></div>
    <div class="bm-bar" role="img" aria-label=${groups.filter(([, l]) => l.length).map(([t, l]) => `${l.length} ${t.toLowerCase()}`).join(', ')}>
      ${groups.map(([t, l]) => (l.length ? html`<span class=${`bm-bar__part is-${t === 'Coming' || t === 'By video' ? 'yes' : t === 'Can’t come' ? 'no' : t === 'Maybe' ? 'maybe' : 'none'}`} style=${`flex:${l.length}`}></span>` : null))}
    </div>
    <dl class="bm-who">${groups.filter(([, l]) => l.length).map(([t, l]) => html`<div><dt>${t} <b>${l.length}</b></dt><dd>${l.map((x, i) => html`${i ? ', ' : ''}${x.name}${emailOf(x) ? null : html` <span class="bm-who__no">(no email)</span>`}`)}</dd></div>`)}</dl>
    ${quiet.length && m.date >= todayEastern() && !m.live.startedAt ? (m.shared ? html`${asked ? html`<p class="bd-muted bm-coming__wait" role="status">Asked ${asked.names} ${ago(asked.at)}.</p>` : null}<div class="bd-actions" style="margin-top:0.75rem">
      <button class=${`btn btn-sm ${asked ? 'btn-ghost' : 'btn-primary'}`} ref=${askRef} disabled=${!!working} onClick=${() => remind(false)}>${working === 'send' ? 'Sending…' : asked ? 'Ask again' : quiet.length === 1 ? `Ask ${quiet[0].name.split(' ')[0]}` : `Ask the ${quiet.length} who haven’t answered`}</button>
      <button class="btn btn-ghost btn-sm" disabled=${!!working} onClick=${() => remind(true)}>${working === 'preview' ? 'Sending…' : 'Send me the reminder'}</button>
    </div>` : html`<p class="bd-muted bm-coming__wait">Once it’s on the board page, you can ask the ones who haven’t answered.</p>`) : null}
  </div>`;
}

// ─── The presentation's slides, in words ──────────────────────────

/** What a stop is, in words: { label: '3.2' | '', title, sub } */
function stopWords(stop, m, items, pages, files, parts = {}) {
  if (!stop || stop.kind === 'cover') return { label: '', title: 'The cover', sub: `${meetingName(m)} and the agenda` };
  if (stop.kind === 'end') return { label: '', title: 'The close', sub: 'What the board decided, and the next meeting' };
  if (stop.kind === 'since') return { label: '', title: 'Since we last met', sub: 'The reveals and events since, and the action items' };
  if (stop.kind === 'section') { const si = m.sections.findIndex((x) => x.id === stop.sectionId); const sec = m.sections[si]; return { label: String(si + 1).padStart(2, '0'), title: sec?.title || 'Agenda', sub: sec?.items.filter(isFilled).length ? `Opens the part: ${plural(sec.items.filter(isFilled).length, 'item')}` : 'Open to the floor' }; }
  // By its item's id, not its place: the presentation's list can be a moment behind the agenda (an item just deleted
  // or moved); a stop whose item has just gone reads as nothing until the list catches up
  const it = stop.n < 0 && !items.some((x) => x.id === stop.itemId) ? { label: '', title: MORE.title }
    : items.find((x) => x.id === stop.itemId) || { label: '', title: '', section: '', presenter: '' };
  if (stop.kind === 'item') return { label: it.label, title: it.title, sub: [it.section !== it.title ? it.section : '', it.presenter].filter(Boolean).join(' · ') };
  if (stop.kind === 'books') return { label: it.label, title: booksTitle(stop), sub: `${it.title} · from QuickBooks` };
  if (stop.kind === 'live') return { label: it.label, title: LIVE_TITLES[stop.fileId.slice(5)], sub: it.title };
  // The report on an item that shows live facts, its own slide after them
  if (stop.kind === 'report') return { label: it.label, title: `${stop.of > 1 ? `Report, ${(stop.page || 0) + 1} of ${stop.of}` : 'Report'} · ${it.title}`, sub: it.presenter || '' };
  // Its motion, a slide of its own after all it shows
  if (stop.kind === 'decision') return { label: it.label, title: `The decision · ${it.title}`, sub: it.presenter || '' };
  const f = files.find((x) => x.id === stop.fileId);
  const n = pages[stop.fileId];
  // A tall page cut in parts (the stop says how many, else the screen's count of them)
  const cuts = stop.parts || Math.min(8, Math.floor(Number(parts[stop.fileId]?.[stop.page]) || 1));
  return { label: it.label, title: f ? docTitle(f.name) : 'A document', sub: `${it.title} · page ${stop.page + 1}${n ? ` of ${n}` : ''}${cuts === 2 ? `, ${stop.part ? 'bottom' : 'top'} half` : cuts > 2 ? `, part ${(stop.part || 0) + 1} of ${cuts}` : ''}` };
}


// ─── After ──────────────────────────────────────────────────────────

/** This meeting's own minutes file, if any: a minutes file on an agenda item is the last meeting's, up for approval */
const ownMinutesFile = (m) => { const onItem = new Set(m.sections.flatMap((x) => x.items.flatMap((it) => it.docs || []))); return m.files.filter((f) => f.kind === 'minutes' && !onItem.has(f.id)).at(-1) || null; };
/** There's something to read once the minutes are in: read in, or their file here (an approval is not minutes, nor an item's notes before the meeting) */
const minutesIn = (m) => !!m.minutesFrom || !!ownMinutesFile(m);

/** The minutes, as the board will read them on their page */
function MinutesDoc({ m, ctx }) {
  // Who wasn't there is known once there's something to go by: the minutes, the meeting run here, or anyone marked
  const held = (!!m.minutesFrom || !!m.live.endedAt || m.attendance.some((x) => x.status)) && !isLive(m);
  const quorum = quorumFor(m, ctx.data.settings.quorum);
  const people = useMemo(() => pickable(ctx.data.people), [ctx.data.people]);
  const groups = [['Present', 'present'], ['By video', 'remote'], ['Absent', 'absent'], ['Excused', 'excused']].map(([t, s]) => [t, m.attendance.filter((x) => x.status === s)])
    .concat(held ? [['Not there', m.attendance.filter((x) => x.kind === 'board' && !x.status)]] : []).filter(([, l]) => l.length);
  const names = new Map(agendaItems(m).map((x) => [x.id, x.title]));
  const written = (minutesIn(m) || m.motions.length || m.actions.length) && (m.sections.some((s) => s.items.some((it) => it.notes)) || m.motions.length || m.actions.length);
  const minutesFile = ownMinutesFile(m);
  const vf = viewerFiles(minutesFile ? [minutesFile] : []);
  return html`<div class="card bm-minutes">
    <div class="bd-card-head"><h3>The minutes ${m.minutes === 'approved' ? html`<span class="tag tag--success">Approved${m.approvedOn ? ` ${shortDate(m.approvedOn)}` : ''}</span>` : written ? html`<span class="tag">Draft</span>` : null}</h3>
      <p>${m.shared ? 'This is what board members read on their page.' : 'What board members will read once you share the meeting.'}${m.minutesFrom ? ` Read from ${fileTitle(m.minutesFrom.name)}.` : minutesFile ? html` Written up in <a class="link" ...${viewerLink(vf, 0)}>${fileTitle(minutesFile.name)}</a>.` : ''}</p></div>
    ${groups.length ? html`<dl class="bm-who bm-who--doc">${groups.map(([t, l]) => html`<div><dt>${t} <b>${l.length}</b></dt><dd>${l.map((x) => x.name).join(', ')}</dd></div>`)}</dl>` : null}
    ${written ? html`<ol class="bm-doc__sections">${m.sections.map((s) => html`<li key=${s.id}>
      <h4>${s.title}</h4>
      ${s.items.some(isFilled) ? html`<ul class="bm-doc__items">${s.items.filter(isFilled).map((it) => html`<li key=${it.id}>
        <div class="bm-doc__item">${it.title || names.get(it.id)}${presentersOf(it, people).length ? html`<span class="ag-item__who">${namesText(presentersOf(it, people).map((x) => x.name))}</span>` : null}${it.confidential ? html` <span class="tag tag--warn">Board only</span>` : null}</div>
        <${Notes} text=${it.notes} />
      </li>`)}</ul>` : null}
    </li>`)}</ol>
    ${m.motions.length ? html`<h4 class="bm-doc__h">Decisions</h4><ul class="bm-doc__items">${m.motions.map((x) => html`<li key=${x.id}>${x.text} <span class="bd-muted">(${[x.by && `moved by ${x.by}`, x.second && `seconded by ${x.second}`, x.tally ? `${tallyText(x)}${quorum && x.tally.of < quorum ? ', no quorum checked in' : ''}` : RESULTS.find((r) => r.id === x.result)?.label.toLowerCase()].filter(Boolean).join(', ')})</span></li>`)}</ul>` : null}
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
    // Unfiled until it's read in: a question left unanswered never leaves it as this meeting's minutes
    const up = await upload(file, { ownerType: 'meeting', ownerId: m.id, kind: 'other' });
    if (!up.ok) { setBusy(false); addToast(up.error, 'error'); return; }
    keepSaved((x) => ({ ...x, files: [...x.files, up.file] }));
    const replaced = ownMinutesFile(m);
    const before = { sections: m.sections, attendance: m.attendance, motions: m.motions, actions: m.actions, minutesFrom: m.minutesFrom || null };
    const body = { action: 'read-minutes', id: m.id, fileId: up.file.id };
    const dropHere = async () => {
      const d = await call({ action: 'delete-file', id: up.file.id });
      if (d.ok) keepSaved((x) => ({ ...x, files: x.files.filter((f) => f.id !== up.file.id) }));
      return d;
    };
    let j = await act(body, { keep: (r) => r.status === 409 && !!r.other });
    if (j && !j.ok) {
      setBusy(false);
      const other = ctx.data.meetings.find((x) => x.id !== m.id && (x.date === j.other.date || meetingName(x) === j.other.name)) || null;
      // Where they belong, first: that meeting, when Board has it
      if (other && await ask({ title: `Put them on the ${meetingName(other)}?`, text: `${j.error} Board can read them into that meeting instead, and this one stays as it is.`, yes: `Put them on the ${shortDate(other.date)} meeting`, no: 'Not those' })) {
        setBusy(true);
        const there = await upload(file, { ownerType: 'meeting', ownerId: other.id, kind: 'other' });
        const k = there.ok ? await call({ action: 'read-minutes', id: other.id, fileId: there.file.id }) : there;
        setBusy(false);
        if (!k.ok) { addToast(k.error || 'Couldn’t read them in there', 'error'); return; }
        if (k.meeting) ctx.putMeeting(k.meeting);
        await call({ action: 'update-file', id: there.file.id, kind: 'minutes' });
        await dropHere();
        addToast(`Read into the ${meetingName(other)}: ${readWords(k.read)}`, 'info');
        return;
      }
      if (!(await ask({ title: 'Read them into this meeting?', text: `${other ? '' : `${j.error} `}Board would fill in this meeting’s attendance, notes, decisions and action items from them.`, yes: 'Read them into this one', no: 'Remove the file', careful: true }))) {
        const d = await dropHere();
        addToast(d.ok ? `${fileTitle(up.file.name)} is removed. Nothing changed on this meeting.` : d.error, d.ok ? 'info' : 'error');
        requestAnimationFrame(() => document.querySelector('.bm-minutes-drop input')?.focus());
        return;
      }
      setBusy(true);
      j = await act({ ...body, anyway: true });
    }
    setBusy(false);
    if (!j) return;
    // Read in: this file is the minutes now, and a newer copy takes the last one's place
    await call({ action: 'update-file', id: up.file.id, kind: 'minutes' });
    keepSaved((x) => ({ ...x, files: x.files.map((f) => (f.id === up.file.id ? { ...f, kind: 'minutes' } : f)) }));
    if (replaced && replaced.id !== up.file.id) {
      const d = await call({ action: 'delete-file', id: replaced.id });
      if (d.ok) keepSaved((x) => ({ ...x, files: x.files.filter((f) => f.id !== replaced.id) }));
    }
    if (j.approvedPrev) ctx.load();
    const undo = async () => {
      set(before);
      setLastRead(null);
      const d = await call({ action: 'delete-file', id: up.file.id });
      if (d.ok) keepSaved((x) => ({ ...x, files: x.files.filter((f) => f.id !== up.file.id) }));
      addToast('Put back as it was', 'info');
    };
    setLastRead({ name: up.file.name, read: j.read, undo });
    addToast(`Read from the minutes: ${readWords(j.read)}`, 'info', { label: 'Undo', fn: undo });
  };
  return html`<label class=${`bm-minutes-drop ${over ? 'is-over' : ''} ${busy ? 'is-busy' : ''} ${m.minutesFrom && !busy ? 'is-done' : ''}`}
    onDragOver=${(e) => { e.preventDefault(); setOver(true); }} onDragLeave=${() => setOver(false)} onDrop=${(e) => { e.preventDefault(); setOver(false); readIn(e.dataTransfer.files[0]); }}>
    <input type="file" class="sr-only" accept=".pdf,.docx" disabled=${busy} onChange=${(e) => { readIn(e.target.files[0]); e.target.value = ''; }} />
    <span class="bm-minutes-drop__icon" aria-hidden="true">${m.minutesFrom && !busy ? CHECK : html`<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14 3.5H6.5a1 1 0 0 0-1 1v15a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1V8z" /><path d="M14 3.5V8h4.5M12 17v-6M9.5 13.5 12 11l2.5 2.5" /></svg>`}</span>
    <span class="bm-minutes-drop__text">
      <strong>${busy ? 'Reading the minutes…' : m.minutesFrom ? 'Read from the minutes' : 'Drop the minutes here'}</strong>
      <span>${busy ? 'Who was there, the notes under each item, the decisions and the action items.'
        : lastRead ? `${fileTitle(lastRead.name)}: ${readWords(lastRead.read)}.`
        : m.minutesFrom ? `${fileTitle(m.minutesFrom.name)}${c.board ? `: ${c.boardHere} of ${c.board} board members there` : ''}.`
        : 'A PDF or Word file. Board fills in who was there, the notes under each item, the decisions and the action items.'}</span>
    </span>
    ${busy ? html`<span class="spinner" aria-hidden="true"></span>` : html`<span class="btn btn-ghost btn-sm bm-minutes-drop__btn" aria-hidden="true">${m.minutesFrom ? 'Replace the minutes' : 'Choose the file'}</span>`}
    ${lastRead?.undo && !busy ? html`<button type="button" class="btn btn-ghost btn-sm bm-minutes-drop__undo" onClick=${(e) => { e.preventDefault(); lastRead.undo(); }}>Undo</button>` : null}
  </label>`;
}

/** The minutes template (./board-minutes-template.js): this agenda to take the minutes on, on paper or typed into Word */
function MinutesTemplate({ m, ctx }) {
  const { data, addToast } = ctx;
  const [printing, setPrinting] = useState(false);
  const opts = { meetings: data.meetings, quorum: data.settings.quorum, people: pickable(data.people) };
  const print = async () => {
    setPrinting(true);
    try { await printMinutesTemplate(m, opts); } catch (err) { addToast(`Couldn’t print it: ${err.message}`, 'error'); }
    setPrinting(false);
  };
  const word = () => { try { downloadMinutesDocx(m, opts); } catch (err) { addToast(`Couldn’t make the Word file: ${err.message}`, 'error'); } };
  // The board's secretary has it on the board page too, and sends the typed minutes from there
  const secretary = m.practice ? null : data.members.find((p) => p.seat === 'secretary' && p.email);
  return html`<div class="card">
    <div class="bd-card-head"><h3>Minutes template</h3><p>This agenda with room under each item, the roll, the motions and the action items. Type into the Word file and drop it in after the meeting: every note lands on its item.${secretary ? ` ${secretary.name} (Board Secretary) has it on the board page too, and can send the typed minutes from there.` : ''}</p></div>
    <div class="bd-actions">
      <button type="button" class="btn btn-ghost btn-sm" disabled=${printing} onClick=${print}>${printing ? 'Printing…' : 'Print'}</button>
      <button type="button" class="btn btn-ghost btn-sm" onClick=${word}>Word file</button>
    </div>
  </div>`;
}

function WrapUp({ m, set, ctx, act, save, keepSaved }) {
  const { data, addToast } = ctx;
  const [working, setWorking] = useState('');
  const approved = m.minutes === 'approved';
  const next = nextMeeting(data.meetings.filter((x) => x.date > m.date));
  const signed = m.files.filter((f) => f.kind === 'signed').at(-1);
  const send = async (test) => {
    const to = data.members.filter((x) => x.email).map((x) => x.name);
    const none = data.members.filter((x) => !x.email).map((x) => x.name);
    if (!test && !(await ask({ careful: true, title: `Email ${andList(to)} that the minutes are up?`, text: `Each gets the link to the ${approved ? 'approved' : 'draft'} minutes on the board page. Nothing is attached.${none.length ? ` ${andList(none)} ${none.length === 1 ? 'has' : 'have'} no email, so ${none.length === 1 ? 'gets' : 'get'} nothing.` : ''}`, yes: m.minutesSentAt ? 'Email them again' : 'Email the board' }))) return;
    setWorking(test ? 'preview' : 'send');
    const j = await act({ action: 'send-minutes', id: m.id, test });
    setWorking('');
    if (j) { addToast(test ? `Sent to ${j.to?.[0] || 'you'}` : `Emailed ${plural(j.sent, 'board member')}`, 'info'); focusNext('.bm-wrap'); }
  };
  const share = async (v) => { set({ shared: v }); await new Promise((r) => setTimeout(r, 0)); await save(); addToast(v ? 'On the board page' : 'Taken off the board page', 'info', v ? { label: 'Undo', fn: () => share(false) } : undefined); focusNext('.bm-wrap'); };
  const hasMinutes = minutesIn(m);
  const today = todayEastern();
  // Not held yet: its day is ahead and it hasn't been run here (a meeting held early is held)
  const ahead = !!m.date && m.date > today && !m.live.startedAt;
  // Approved on the day the next meeting approved them, once it's been held; else today
  const approvedDay = next && next.date <= today ? next.date : today;
  const approve = async (v) => {
    if (v && !(await ask({ title: 'Mark the minutes approved?', text: `As approved on ${shortDate(approvedDay)}${next && next.date <= today ? `, at the ${meetingName(next)}` : ''}. The board page shows them approved.`, yes: 'Mark them approved' }))) return;
    set(v ? { minutes: 'approved', approvedOn: approvedDay } : { minutes: 'draft', approvedOn: '' });
    // The board was told about draft minutes: offer to tell them they're approved
    addToast(v ? `Marked approved, ${shortDate(approvedDay)}` : 'Back to draft minutes', 'info', v && m.shared && m.minutesSentAt ? { label: 'Tell the board', fn: () => send(false) } : undefined);
    focusNext('.bm-wrap');
  };
  const takeSigned = async (file) => {
    if (!file) return;
    setWorking('signed');
    // Named for what it is, whatever the file was called
    const named = new File([file], `Signed minutes, ${meetingName(m)}${(String(file.name).match(/\.[a-z0-9]{2,5}$/i) || [''])[0]}`, { type: file.type });
    const up = await upload(named, { ownerType: 'meeting', ownerId: m.id, kind: 'signed' });
    setWorking('');
    if (!up.ok) { addToast(up.error, 'error'); return; }
    keepSaved((x) => ({ ...x, files: [...x.files, up.file] }));
    addToast('The signed copy is kept with the meeting', 'info');
  };
  const vf = viewerFiles([signed].filter(Boolean));
  const [sIn, sShared, sApproved] = statesOf([hasMinutes, m.shared, approved]);
  return html`<div class="card bm-check bm-wrap">
    <div class="bd-card-head"><h3 tabindex="-1">After the meeting</h3><p>${approved ? 'Done: the minutes are approved.' : 'Drop the minutes in and Board does the rest. The board approves them at the next meeting.'}</p></div>
    <ol class="bm-tasks">
      <${Task} state=${sIn} title=${hasMinutes ? 'The minutes are in' : 'The minutes'} sub=${m.minutesFrom ? `Read from ${fileTitle(m.minutesFrom.name)}.` : hasMinutes ? '' : ahead ? 'After the meeting, drop them in: a PDF or Word file.' : 'Drop them in: a PDF or Word file.'} />
      <${Task} state=${sShared} title=${m.shared ? 'On the board page' : 'Share them with the board'} sub=${m.shared ? (m.minutesSentAt ? `The board was told ${ago(m.minutesSentAt)}.` : hasMinutes ? 'The board can read them now.' : 'The minutes show there once they’re in.') : 'As draft minutes until they’re approved.'}>
        ${m.shared || ahead ? null : html`<button class=${btn(sShared)} onClick=${() => share(true)}>Share with the board</button>`}
        <button class="btn btn-ghost btn-sm" disabled=${!!working || !data.setup.email || !hasMinutes} onClick=${() => send(true)}>${working === 'preview' ? 'Sending…' : 'Send me the email'}</button>
        <button class="btn btn-ghost btn-sm" disabled=${!!working || !m.shared || !data.packetTo || !data.setup.email || !hasMinutes} onClick=${() => send(false)}>${working === 'send' ? 'Sending…' : m.minutesSentAt ? 'Email the board again' : 'Email the board'}</button>
        ${ahead && !m.shared ? html`<span class="bd-muted">After the meeting.</span>` : !hasMinutes ? html`<span class="bd-muted">Once the minutes are in.</span>` : !m.shared ? html`<span class="bd-muted">Share them first, so the email has something to open.</span>` : null}
      </${Task}>
      <${Task} state=${sApproved} title=${approved ? `Approved${m.approvedOn ? ` ${shortDate(m.approvedOn)}` : ''}` : 'The board approves them'} sub=${approved ? 'Marked on the board page.' : next ? `On the agenda of the ${meetingName(next)} (${shortDate(next.date)}). Approving them there marks them here too.` : 'At the next meeting: its agenda asks for this approval.'}>
        ${approved ? html`<button class="btn btn-ghost btn-sm" onClick=${() => approve(false)}>Mark as draft</button>` : html`<button class="btn btn-ghost btn-sm" disabled=${ahead || !hasMinutes} onClick=${() => approve(true)}>Mark them approved</button>`}
        ${!approved && ahead ? html`<span class="bd-muted">The meeting hasn’t happened yet.</span>` : !approved && !hasMinutes ? html`<span class="bd-muted">Once the minutes are in.</span>` : null}
      </${Task}>
      <${Task} state=${signed ? 'done' : 'todo'} title=${signed ? 'Signed copy kept' : 'The signed copy (optional)'} sub=${signed ? html`<a class="link" ...${viewerLink(vf, 0)}>${fileTitle(signed.name)}</a>` : 'The secretary’s signed minutes, as a PDF or a photo.'}>
        ${ahead ? html`<span class="bd-muted">After the meeting.</span>` : html`<label class="btn btn-ghost btn-sm bd-pick">${working === 'signed' ? 'Uploading…' : signed ? 'Replace it' : 'Upload it'}<input type="file" class="sr-only" accept=".pdf,.jpg,.jpeg,.png,.heic,.docx" onChange=${(e) => { takeSigned(e.target.files[0]); e.target.value = ''; }} /></label>`}
      </${Task}>
    </ol>
  </div>`;
}

// The motion under an item in the agenda editor (the editor's other styles are board-ui.js's)
const MOTION_CSS = `
.agx-motion { margin: 0.45rem 0 0.25rem 2.95rem; padding: 0.5rem 0.75rem 0.55rem; border-left: 4px solid var(--color-primary, #FFDA24); border-radius: 0 10px 10px 0; background: #FFFAE0; }
.agx-motion__label { display: block; margin: 0 0 0.25rem; font-size: var(--fs-2xs, 0.72rem); font-weight: 750; letter-spacing: 0.07em; text-transform: uppercase; color: #765C00; }
.agx-motion__box { display: block; width: 100%; min-height: 2.4rem; resize: none; background: #fff; font-weight: 600; }
@media (max-width: 640px) { .agx-motion { margin-left: 0; } }
`;
if (typeof document !== 'undefined' && !document.getElementById('board-motion-css')) {
  const st = document.createElement('style');
  st.id = 'board-motion-css';
  st.textContent = MOTION_CSS;
  document.head.append(st);
}
