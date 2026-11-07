/**
 * The board page → a meeting → notes typed beside the agenda
 * ===========================================================================
 * The paper form and the Word file with nothing to download: the secretary
 * types in a panel docked on the side of the meeting (over the whole page on a
 * phone), who was there, notes under each item, how each vote went, the action
 * items. It stays open through the meeting, while the chair runs it and after.
 * portal.js opens it from the "You take the minutes" card and the meeting's
 * live room, and passes what it draws with (Icon).
 *
 * Nothing typed is ever lost to the room's Wi-Fi: each box saves itself a moment
 * after the typing stops (only what changed, so two devices can't undo each
 * other), and until the server has it, it's kept on this device, trying again by
 * itself. A reload or a sign-in that ran out picks up where it was. Words saved
 * over a box from somewhere else are never written over: both are shown, to choose.
 *
 * It's a draft, for the secretary and Board's admins. The board sees nothing
 * until Send the minutes (../../../functions/api/_board-notes.js).
 */

import { h, htm, useState, useEffect, useRef, useMemo } from '../vendor.js';
import { uid, clock, endedClock } from '../board-shared.js';
import { minutesOutline, approveWords, noteLines } from '../board-minutes-template.js';
import { findToDos } from '../board-todos.js';

const html = htm.bind(h);
const API = '/api/board-portal';
const SAVE_AFTER = 700;
const NO_ANSWER_MS = 15000;
const SEND_MS = 60000;
const SAVE_AT_MOST = 4000;
const LOOK_EVERY = 20000;
const MOST_AT_ONCE = 200;
const MAX_NOTE = 20000;
const MAX_LINE = 1000;
const HERE = [['present', 'Here'], ['remote', 'Video'], ['excused', 'Excused']];
const RESULTS = [['passed', 'Passed'], ['failed', 'Failed'], ['tabled', 'Tabled']];
const RESULT_WORDS = { passed: 'Passed', failed: 'Failed', tabled: 'Tabled' };
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const blank = (s) => !String(s ?? '').trim();
const shortDay = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const number = (n) => typeof n === 'number';
const sameWords = (a, b) => String(a || '').replace(/\s+/g, ' ').trim().toLowerCase() === String(b || '').replace(/\s+/g, ' ').trim().toLowerCase();
const isWords = (k) => k === 'guests' || k.startsWith('n:');
const sameNote = (a, b) => noteLines(a).join('\n') === noteLines(b).join('\n');
// The boxes a save says what it started from (a vote's result the same way, in setField)
const guarded = (k) => isWords(k) || k === 'adjourned' || k.startsWith('r:');
const rowFilled = (v) => !!v && Object.values(v).some((x) => number(x) || !blank(x));

// ─── Kept on this device until the server has it ────────────────────
// { key: { v, was } } shared by every tab of this browser: each adds its own boxes and takes off only what it saved

const localKey = (id) => `bp-notes-${id}`;
const localGet = (id) => { try { const v = JSON.parse(localStorage.getItem(localKey(id)) || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; } };
// Whether this device is really keeping them: the status line and the send never promise it when it isn't
let deviceKeeps = true;
const localWrite = (id, all) => { try { if (Object.keys(all).length) localStorage.setItem(localKey(id), JSON.stringify(all)); else localStorage.removeItem(localKey(id)); deviceKeeps = true; } catch { deviceKeeps = false; /* private window, or full: the server still gets it */ } };
const localPut = (id, key, entry) => localWrite(id, { ...localGet(id), [key]: entry });
const localDrop = (id, key, v) => { const all = localGet(id); if (key in all && JSON.stringify(all[key]?.v) === JSON.stringify(v)) { delete all[key]; localWrite(id, all); } };
// The draft as last seen, for opening these on a device with no connection
const seenKey = (id) => `bp-notes-seen-${id}`;
const seenGet = (id) => { try { return JSON.parse(localStorage.getItem(seenKey(id)) || 'null'); } catch { return null; } };
const seenPut = (id, j) => { try { localStorage.setItem(seenKey(id), JSON.stringify({ notes: j.notes, roll: j.roll, approving: j.approving, at: j.at, sent: j.sent })); } catch { /* the page still works */ } };

/** A request that gives up: a room's Wi-Fi can leave one hanging for good */
function timed(url, opts = {}, ms = NO_ANSWER_MS) {
  const stop = new AbortController();
  const t = setTimeout(() => stop.abort(), ms);
  return fetch(url, { ...opts, signal: stop.signal }).finally(() => clearTimeout(t));
}

/** An answer that wasn't the API's: Access's sign-in page in its place, or its refusal */
class SignedOut extends Error {}
async function answer(r) {
  if (r.status === 401) throw new SignedOut();
  const j = await r.json().catch(() => null);
  if (j && r.status === 403 && /access token/i.test(j.error || '')) throw new SignedOut();
  if (j) return j;
  if (/cloudflareaccess/i.test(r.url || '')) throw new SignedOut();
  throw new Error(`Something went wrong (${r.status})`);
}

/** The server's draft with what's still waiting here on top of it, and rows added here that have nothing in them yet */
function laid(server, was, dirty) {
  const out = { ...server };
  for (const [k, e] of Object.entries(dirty)) {
    if (e.v === null) delete out[k];
    else if (typeof e.v === 'object') out[k] = { ...out[k], ...e.v };
    else out[k] = e.v;
  }
  for (const k of Object.keys(was)) if (/^[ma]:/.test(k) && !(k in out) && !(k in dirty) && !rowFilled(was[k])) out[k] = was[k];
  return out;
}

/**
 * The draft: `vals` to draw, `set(key, value)` for a box or a whole row, `setField(key, patch)` for a vote's or an
 * action item's field, `flush({ all })` to save, `clashes` { key: { mine, theirs } } with `settle(key, keepMine)`.
 * state: loading | saved | saving | waiting (no connection) | trouble (the server's) | signin | refused ({ why })
 */
function useDraft(id, onMeeting) {
  const [vals, setVals] = useState({});
  const [state, setState] = useState('loading');
  const [why, setWhy] = useState('');
  const [times, setTimes] = useState({ at: '', sent: '' });
  const [loaded, setLoaded] = useState(false);
  const [base, setBase] = useState({ roll: {}, approving: '' });
  const [clashes, setClashes] = useState({});
  const dirty = useRef(localGet(id));
  const known = useRef({});
  const held = useRef(new Set());
  const timer = useRef(0);
  const first = useRef(0);
  const busy = useRef(null);
  const fails = useRef(0);
  const saves = useRef(0);
  const gone = useRef(false);
  const meetingAt = useRef('');
  const lastSeen = useRef({});
  const remember = () => seenPut(id, { notes: known.current, ...lastSeen.current });

  const later = (ms) => { clearTimeout(timer.current); timer.current = setTimeout(() => flush(), ms); };
  const waiting = () => Object.keys(dirty.current).filter((k) => !held.current.has(k));
  const pending = () => waiting().length > 0;

  async function trouble(err) {
    if (gone.current) return;
    if (err.refused) { setWhy(err.message); setState('refused'); return; }
    fails.current += 1;
    const noAnswer = err instanceof TypeError || err.name === 'AbortError';
    if (err instanceof SignedOut) { setState('signin'); return; }
    if (!noAnswer) { setState('trouble'); return; }
    setState('waiting');
    // No answer, over and over: the public site answering means the connection's fine and Access is what's turning
    // this away. A room's Wi-Fi with no internet says "online" all day, so only this tells the two apart
    if (fails.current < 3) return;
    const reached = await fetch('/robots.txt', { method: 'HEAD', cache: 'no-store' }).then(() => true, () => false);
    if (reached && !gone.current) setState('signin');
  }

  async function saveOnce({ leaving = false } = {}) {
    const keys = waiting().slice(0, MOST_AT_ONCE);
    if (!keys.length) return;
    // What this try sends is remembered with the box until the answer comes: when the server got it and the answer was
    // lost, the next save still knows those are its own words, not someone else's
    for (const k of keys) {
      const e = dirty.current[k];
      if (e.was === undefined && e.wasText === undefined) continue;
      dirty.current = { ...dirty.current, [k]: {
        ...e,
        ...(e.was !== undefined ? { tried: [...(e.tried || []), typeof e.v === 'object' ? e.v?.result ?? '' : e.v ?? ''].slice(-5) } : {}),
        ...(e.wasText !== undefined ? { triedText: [...(e.triedText || []), e.v?.text ?? ''].slice(-5) } : {}),
      } };
      localPut(id, k, dirty.current[k]);
    }
    const sending = Object.fromEntries(keys.map((k) => [k, dirty.current[k]]));
    const changes = Object.fromEntries(keys.map((k) => [k, sending[k].v]));
    const was = Object.fromEntries(keys.filter((k) => sending[k].was !== undefined).map((k) => [k, [sending[k].was ?? '', ...(sending[k].tried || [])]]));
    const wasText = Object.fromEntries(keys.filter((k) => sending[k].wasText !== undefined).map((k) => [k, [sending[k].wasText ?? '', ...(sending[k].triedText || [])]]));
    const body = JSON.stringify({ action: 'notes-save', meetingId: id, changes, was, wasText });
    const r = await timed(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: leaving && body.length < 60000 });
    const j = await answer(r);
    if (!j.ok) {
      const err = new Error(j.error || 'That didn’t save');
      // A refusal won't change by trying again: the words stay on this device and on the screen
      err.refused = r.status >= 400 && r.status < 500 && r.status !== 429;
      throw err;
    }
    saves.current += 1;
    const clash = new Map((j.clashes || []).map((c) => [c.key, c]));
    const left = { ...dirty.current };
    for (const k of keys) {
      const e = sending[k];
      if (clash.has(k)) {
        const c = clash.get(k);
        held.current.add(k);
        if (c.field === 'text') known.current[k] = { ...known.current[k], text: c.theirs };
        else if (k.startsWith('m:')) known.current[k] = { ...known.current[k], result: c.theirs };
        else known.current[k] = c.theirs;
        continue;
      }
      if (e.v === null) delete known.current[k]; else if (typeof e.v === 'object') known.current[k] = { ...known.current[k], ...e.v }; else known.current[k] = e.v;
      if (left[k] === e) { delete left[k]; localDrop(id, k, e.v); } else if (left[k]?.was !== undefined || left[k]?.wasText !== undefined) {
        left[k] = { ...left[k] };
        if (left[k].was !== undefined) { left[k].was = typeof e.v === 'object' ? e.v?.result ?? '' : e.v ?? ''; left[k].tried = []; }
        if (left[k].wasText !== undefined) { left[k].wasText = e.v?.text ?? left[k].wasText; left[k].triedText = []; }
        localPut(id, k, left[k]);
      }
    }
    dirty.current = left;
    if (clash.size && !gone.current) setClashes((was) => ({ ...was, ...Object.fromEntries([...clash].map(([k, c]) => [k, { theirs: c.theirs, field: c.field }])) }));
    if (!gone.current) setTimes((t) => ({ ...t, at: j.at || t.at }));
    lastSeen.current = { ...lastSeen.current, at: j.at || lastSeen.current.at };
    remember();
  }

  /** Saved, or the reason it wasn't → true | false. `all`: everything waiting, not just the next batch */
  function flush(opts = {}) {
    clearTimeout(timer.current);
    if (busy.current) return busy.current.then(() => (opts.all && pending() ? flush(opts) : !pending()));
    if (!pending()) { if (!gone.current) setState('saved'); return Promise.resolve(true); }
    if (!gone.current) setState('saving');
    const run = (async () => {
      try {
        // (one save while they're still typing, however slow the room's Wi-Fi: the next waits for the next pause)
        do await saveOnce(opts); while (opts.all && pending());
        fails.current = 0;
        first.current = pending() ? Date.now() : 0;
        if (pending()) { later(SAVE_AFTER); return false; }
        if (!gone.current) { setState('saved'); setWhy(''); }
        return true;
      } catch (err) {
        trouble(err);
        if (!gone.current && !err.refused) later(Math.min(30000, 2000 * 2 ** Math.min(fails.current, 4)));
        return false;
      }
    })();
    busy.current = run;
    run.finally(() => { busy.current = null; });
    return run;
  }

  // What the server has. `quick`: the look every so often, for what another device saved
  const pull = async ({ quick = false } = {}) => {
    const seq = saves.current;
    try {
      const j = await answer(await timed(`${API}?notes=${encodeURIComponent(id)}${quick ? '&quick=1' : ''}`));
      if (gone.current) return;
      if (!j.ok) { setWhy(j.error || 'Your notes didn’t load'); setState('refused'); return; }
      // A save landed while this was on its way, so this answer is older than it: never drawn over what's newer
      if (saves.current !== seq || busy.current) { setTimeout(() => { if (!gone.current) pull({ quick }); }, 500); return; }
      known.current = { ...j.notes };
      setVals((was) => laid(j.notes, was, dirty.current));
      setTimes((t) => ({ at: dirty.current && pending() ? t.at : j.at, sent: j.sent }));
      setBase((b) => ({ roll: j.roll || b.roll, approving: j.approving ?? b.approving, approvingWaiting: j.approvingWaiting ?? b.approvingWaiting, approvingCorrections: j.approvingCorrections ?? b.approvingCorrections, on: j.on || b.on, fixed: j.fixed || b.fixed }));
      setLoaded(true);
      lastSeen.current = { roll: j.roll, approving: j.approving ?? lastSeen.current.approving, at: j.at, sent: j.sent };
      remember();
      // The meeting moved on under the notes (an item added, a vote closed): the page catches up, the panel with it
      if (meetingAt.current && j.meetingAt && j.meetingAt !== meetingAt.current) onMeeting?.();
      meetingAt.current = j.meetingAt || meetingAt.current;
      fails.current = 0;
      if (pending()) flush(); else if (!held.current.size || !quick) setState('saved');
    } catch (err) {
      trouble(err);
      if (gone.current) return;
      // No connection on opening: the boxes all the same, as this device last saw them
      if (!quick && !loaded) {
        const seen = seenGet(id);
        if (seen) {
          known.current = { ...seen.notes };
          setBase((b) => ({ roll: seen.roll || b.roll, approving: seen.approving ?? b.approving }));
          setTimes({ at: seen.at || '', sent: seen.sent || '' });
        }
        setVals((was) => laid(seen?.notes || {}, was, dirty.current));
        setLoaded(true);
      }
      if (!quick) setTimeout(() => { if (!gone.current) pull(); }, 5000);
    }
  };

  useEffect(() => {
    gone.current = false;
    pull();
    const online = () => { fails.current = 0; flush(); };
    // Leaving: what's waiting goes now. Back again: what another device saved comes in
    const seen = () => { if (document.visibilityState === 'hidden') flush({ leaving: true, all: true }); else pull({ quick: true }); };
    const leaving = () => { flush({ leaving: true, all: true }); };
    const look = setInterval(() => { if (document.visibilityState === 'visible') pull({ quick: true }); }, LOOK_EVERY);
    addEventListener('online', online);
    addEventListener('pagehide', leaving);
    document.addEventListener('visibilitychange', seen);
    return () => {
      clearInterval(look);
      removeEventListener('online', online);
      removeEventListener('pagehide', leaving);
      document.removeEventListener('visibilitychange', seen);
      flush({ leaving: true, all: true });
      gone.current = true;
      clearTimeout(timer.current);
    };
  }, [id]);

  const changed = (quiet = false) => {
    if (!quiet) setTimes((t) => ({ ...t, at: new Date().toISOString() }));
    setState('saving');
    const now = Date.now();
    if (!first.current) first.current = now;
    later(Math.max(0, Math.min(SAVE_AFTER, SAVE_AT_MOST - (now - first.current))));
  };
  /** A box, or a whole row (null takes it off) */
  const set = (key, value) => {
    const v = value === '' || value === undefined ? null : value;
    const had = dirty.current[key];
    const e = guarded(key) ? { v, was: had ? had.was : known.current[key] ?? '', tried: had?.tried || [] } : { v };
    dirty.current = { ...dirty.current, [key]: e };
    localPut(id, key, e);
    setVals((was) => { const n = { ...was }; if (v === null) delete n[key]; else n[key] = v; return n; });
    // (a line that isn't a to-do changes nothing the minutes say: nothing new to send)
    changed(key === 'skipped');
  };
  /** One field of a vote or an action item: only it is sent, so a field set elsewhere stays */
  const setField = (key, patch) => {
    const had = dirty.current[key];
    const e = { v: had?.v && typeof had.v === 'object' ? { ...had.v, ...patch } : { ...patch } };
    // How a vote went is guarded as words are: two devices can't quietly turn Failed into Passed
    if (key.startsWith('m:') && (had?.was !== undefined || 'result' in patch)) { e.was = had?.was ?? known.current[key]?.result ?? ''; e.tried = had?.tried || []; }
    // A row's words the same way
    if ('text' in patch || had?.wasText !== undefined) { e.wasText = had?.wasText ?? known.current[key]?.text ?? ''; e.triedText = had?.triedText || []; }
    dirty.current = { ...dirty.current, [key]: e };
    localPut(id, key, e);
    setVals((was) => ({ ...was, [key]: { ...was[key], ...patch } }));
    changed();
  };
  /** A clash chosen: their version stays, or what's in the box now goes over it */
  const settle = (key, keepMine, both = false) => {
    const c = clashes[key];
    if (!c) return;
    held.current.delete(key);
    setClashes((x) => { const n = { ...x }; delete n[key]; return n; });
    const row = /^[ma]:/.test(key);
    const field = c.field === 'text' ? 'text' : 'result';
    if (keepMine) {
      const e = field === 'text' ? { ...dirty.current[key], wasText: c.theirs, triedText: [] } : { ...dirty.current[key], was: c.theirs, tried: [] };
      if (!row) e.v = vals[key] === '' || vals[key] === undefined ? null : vals[key];
      if (both) {
        const joined = `${c.theirs}${row ? ' ' : '\n'}${(row ? vals[key]?.text : vals[key]) || ''}`.trim();
        e.v = row ? { ...e.v, text: joined } : joined;
        setVals((was) => ({ ...was, [key]: row ? { ...was[key], text: joined } : joined }));
      }
      dirty.current = { ...dirty.current, [key]: e };
      localPut(id, key, e);
      changed();
    } else {
      const left = { ...dirty.current };
      // Their version of that one thing: anything else typed on the row still goes
      // (still guarded: the row's other words or result can clash in their turn. A row emptied elsewhere is simply gone)
      const emptied = field === 'text' && !c.theirs;
      const rest = row && !emptied ? Object.fromEntries(Object.entries(left[key]?.v || {}).filter(([f]) => f !== field)) : {};
      if (Object.keys(rest).length) left[key] = { ...left[key], v: rest }; else delete left[key];
      dirty.current = left;
      if (left[key]) { localPut(id, key, left[key]); changed(); } else {
        const all = localGet(id);
        delete all[key];
        localWrite(id, all);
      }
      setVals((was) => {
        const n = { ...was };
        if (emptied) delete n[key];
        else if (row) n[key] = { ...was[key], [field]: c.theirs || undefined };
        else if (c.theirs === '') delete n[key];
        else n[key] = c.theirs;
        return n;
      });
    }
  };

  return { unsaved: () => Object.keys(dirty.current).length > 0, vals, setVals, set, setField, flush, state, why, times, setTimes, loaded, base, clashes, settle, retry: pull, clashing: () => held.current.size > 0 };
}

/**
 * Words left on this device with the panel closed (typed offline, then closed), saved without it. A box another device
 * has saved over stays here until the notes are opened, to choose
 */
export async function saveLeft(id) {
  const all = localGet(id);
  const keys = Object.keys(all).slice(0, MOST_AT_ONCE);
  if (!keys.length) return;
  const was = Object.fromEntries(keys.filter((k) => all[k].was !== undefined).map((k) => [k, [all[k].was ?? '', ...(all[k].tried || [])]]));
  const wasText = Object.fromEntries(keys.filter((k) => all[k].wasText !== undefined).map((k) => [k, [all[k].wasText ?? '', ...(all[k].triedText || [])]]));
  const j = await answer(await timed(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'notes-save', meetingId: id, changes: Object.fromEntries(keys.map((k) => [k, all[k].v])), was, wasText }) }));
  if (!j.ok) return;
  const clashing = new Set((j.clashes || []).map((c) => c.key));
  for (const k of keys) if (!clashing.has(k)) localDrop(id, k, all[k].v);
}

// ─── The boxes ──────────────────────────────────────────────────────

/** A box that grows with what's typed, so nothing scrolls inside a scrolling panel */
function Grow({ value, onInput, label, placeholder = '', rows = 2, onFocus = null, max = MAX_NOTE, ro = false }) {
  const el = useRef(null);
  // Measured at its smallest, which would pull the panel back up: where the panel had scrolled to is put straight back
  const size = () => {
    const t = el.current;
    if (!t) return;
    const panel = t.closest('.bn-scroll');
    const top = panel?.scrollTop ?? 0;
    t.style.height = 'auto';
    t.style.height = `${t.scrollHeight + 2}px`;
    if (panel) panel.scrollTop = top;
  };
  // Typing at the end of a box as it grows: the line being typed stays in view
  const typed = () => {
    const t = el.current;
    const panel = t?.closest('.bn-scroll');
    if (!panel || document.activeElement !== t || t.selectionEnd !== t.value.length) return;
    // (above the on-screen keyboard too, which covers the panel without changing its size)
    const seen = window.visualViewport ? visualViewport.offsetTop + visualViewport.height : Infinity;
    const over = t.getBoundingClientRect().bottom - Math.min(panel.getBoundingClientRect().bottom, seen) + 8;
    if (over > 0) panel.scrollTop += over;
  };
  useEffect(size, [value]);
  useEffect(() => { if (!window.ResizeObserver || !el.current) return undefined; let w = el.current.offsetWidth; const ro = new ResizeObserver(() => { if (el.current && el.current.offsetWidth !== w) { w = el.current.offsetWidth; size(); } }); ro.observe(el.current); return () => ro.disconnect(); }, []);
  return html`<textarea ref=${el} class="bn-box" rows=${rows} maxlength=${max} aria-label=${label} placeholder=${ro ? '' : placeholder} readonly=${ro} value=${value} onInput=${(e) => { onInput(e.target.value); size(); typed(); }} onFocus=${onFocus}></textarea>
    ${String(value || '').length >= max ? html`<p class="bn-need">That’s as much as this box holds.</p>` : null}`;
}

/** Something else saved here from somewhere else: never written over, both shown, the person chooses */
function Clash({ draft, k, label, show }) {
  const c = draft.clashes[k];
  if (!c) return null;
  return html`<div class="bn-clash" id=${`bn-c-${k}`} role="group" aria-label=${`Another version of ${label}`}>
    <p><strong>Something different was saved here from another device or person.</strong> Yours is showing. The other is:</p>
    <p class="bn-clash__theirs">${c.field === 'text' ? c.theirs || 'Nothing: the box was emptied.' : show(c.theirs)}</p>
    <div class="bn-clash__do"><button type="button" class="bp-mini" onClick=${() => draft.settle(k, true)}>Keep mine</button><button type="button" class="bp-mini" onClick=${() => draft.settle(k, false)}>Use that one</button>${typeof c.theirs === 'string' && c.theirs.trim() && (c.field === 'text' || isWords(k)) ? html`<button type="button" class="bp-mini" onClick=${() => draft.settle(k, true, true)}>Keep both</button>` : null}</div>
  </div>`;
}

/** A box of words, and the other words when someone else saved over it */
function Words({ draft, k, label, onFocus = null, placeholder = 'What was said', rows = 2, max = MAX_NOTE, ro = false }) {
  const { vals, set } = draft;
  return html`<${Grow} label=${label} value=${vals[k] || ''} onInput=${(v) => set(k, v)} onFocus=${onFocus} placeholder=${placeholder} rows=${rows} max=${max} ro=${ro} />
    <${Clash} draft=${draft} k=${k} label=${label} show=${(t) => t || 'Nothing: the box was emptied.'} />`;
}

/** Choose one of a few, or none: pressed again takes it back */
function Pick({ value, choices, onPick, label, ro = false }) {
  return html`<div class="bn-pick" role="group" aria-label=${label}>${choices.map(([id, words]) => html`<button type="button" key=${id} aria-pressed=${value === id} disabled=${ro} onClick=${() => onPick(value === id ? '' : id)}>${words}</button>`)}</div>`;
}

/**
 * A phone raises its keyboard only for a box focused in the tap itself, and a new row's box is drawn after it: a stand-in
 * takes the focus in the tap, and the row's own box takes it from there with the keyboard already up
 */
function holdKeyboard() {
  if (!window.matchMedia?.('(pointer: coarse)').matches) return;
  const el = document.createElement('input');
  el.className = 'bn-hold';
  el.setAttribute('aria-hidden', 'true');
  el.tabIndex = -1;
  document.body.append(el);
  el.focus({ preventScroll: true });
  setTimeout(() => el.remove(), 800);
}

const RESULT_SHOWN = (r) => RESULT_WORDS[r] || 'No result yet';
// A count with its other half missing can't be told from a zero: "Passed 0–1"
const halfCounted = (v) => (number(v.for) || number(v.against) || number(v.abstain)) && !(number(v.for) && number(v.against));
const COUNTS_WORDS = 'How many for, and how many against?';
const nums = [['for', 'For'], ['against', 'Against'], ['abstain', 'Abstain']];
const counted = (s) => { const n = Math.floor(Number(s)); return s === '' || !Number.isFinite(n) || n < 0 ? '' : Math.min(n, 999); };

/**
 * How a vote went, as the form's record line. `taken`: the vote the board page already took on it (its result stands,
 * only who moved it is left to write). `need`: what it still needs, said under it
 */
function Vote({ id, v = {}, put, counts = true, need = '', taken = null, draft, k, ro = false }) {
  const tally = taken?.tally ? `, ${taken.tally.for} for, ${taken.tally.against} against${taken.tally.abstain ? `, ${taken.tally.abstain} abstaining` : ''}` : '';
  return html`<div class="bn-vote" id=${`bn-v-${id}`}>
    <div class="bn-two">
      <label class="bn-f"><span>Moved by</span><input class="bn-in" list="bn-names" maxlength="120" readonly=${ro} value=${v?.by || ''} autocomplete="off" onInput=${(e) => put({ by: e.target.value })} /></label>
      <label class="bn-f"><span>Seconded by</span><input class="bn-in" list="bn-names" maxlength="120" readonly=${ro} value=${v?.second || ''} autocomplete="off" onInput=${(e) => put({ second: e.target.value })} /></label>
    </div>
    ${taken ? html`<p class="bn-taken">${taken.tally?.at ? 'Voted on the board page' : 'Already on the meeting'}: ${RESULT_WORDS[taken.result] || 'Recorded'}${tally}.</p>` : html`
      ${counts ? html`<div class="bn-three">${nums.map(([f, words]) => html`<label class="bn-f" key=${f}><span>${words}</span><input class="bn-in" type="text" inputmode="numeric" pattern="[0-9]*" maxlength="3" autocomplete="off" readonly=${ro} value=${v?.[f] ?? ''} onInput=${(e) => { const typed = e.target.value.replace(/\D/g, ''); e.target.value = typed; put({ [f]: counted(typed) }); }} /></label>`)}</div>` : null}
      <${Pick} label="How the vote went" value=${v?.result || ''} choices=${RESULTS} ro=${ro} onPick=${(result) => put({ result })} />`}
    <${Clash} draft=${draft} k=${k} label="how the vote went" show=${RESULT_SHOWN} />
    ${need ? html`<p class="bn-need">${need}</p>` : null}
  </div>`;
}

const stateWords = (state, why, { at, sent }, ro, split, keeps) => (ro ? 'These minutes are approved. Anything here that didn’t go in can’t be sent now.' : split && !['signin', 'waiting', 'trouble', 'refused'].includes(state) ? 'One box has two versions. Choose which to keep.' : {
  loading: 'Getting your notes…',
  saving: 'Saving…',
  waiting: keeps ? 'No connection. Your notes are safe on this device, and saving will pick back up.' : 'No connection. Keep this page open, and saving will pick back up.',
  trouble: keeps ? 'The site didn’t answer just now. Your notes are safe on this device, and it’s trying again.' : 'The site didn’t answer just now. Keep this page open: it’s trying again.',
  signin: keeps ? 'Your sign-in may have run out. Reload the page to sign in: your notes are safe on this device.' : 'Your sign-in may have run out, and this device can’t keep your notes. Copy what you typed, then reload the page.',
  refused: why,
  saved: at || sent ? 'Saved' : 'Saves as you type',
}[state] || '');
const HOW = { present: 'Here', remote: 'Video', excused: 'Excused', absent: 'Not there' };

// ─── The panel ──────────────────────────────────────────────────────

const scrollKept = new Map();

export function NotesPanel({ m, ctx, Icon, onClose, thanks, mine }) {
  const { data, d, say, load } = ctx;
  const draft = useDraft(m.id, () => load({ keep: true }));
  const { vals, setVals, set, setField, flush, state, why, times, setTimes, loaded, base, clashes } = draft;
  // Approved before these went in: still here to read and copy, no longer to send
  const ro = m.minutes === 'approved';
  const [sending, setSending] = useState(false);
  const [needs, setNeeds] = useState(false);
  // Send pressed with to-dos found in the notes: what it was going to send with, until they're added or set aside
  const [askingToDos, setAskingToDos] = useState(null);
  const [phone, setPhone] = useState(() => matchMedia('(max-width: 900px)').matches);
  const root = useRef(null);
  // Closed and opened again, it's where it was (on a phone the sheet has to close to read the agenda)
  const scroller = useRef(null);

  useEffect(() => {
    document.documentElement.classList.add('bp-noting');
    root.current?.focus({ preventScroll: true });
    // On a phone it's the whole page: what's behind it can't be reached until it's closed
    const mq = matchMedia('(max-width: 900px)');
    const behind = () => { setPhone(mq.matches); for (const el of document.querySelectorAll('.bp-top, .bp-main, .bp-foot')) el.inert = mq.matches; };
    behind();
    mq.addEventListener('change', behind);
    return () => {
      mq.removeEventListener('change', behind);
      document.documentElement.classList.remove('bp-noting');
      for (const el of document.querySelectorAll('.bp-top, .bp-main, .bp-foot')) el.inert = false;
    };
  }, []);

  const o = useMemo(() => minutesOutline(m, { meetings: data.meetings, quorum: data.quorum, people: d.people }), [m, data.meetings, data.quorum, d.people]);
  // No list on the meeting yet: the board as People has it
  const roll = o.roll.length ? o.roll : data.people.board.map((p) => ({ key: p.slug, slug: p.slug, name: p.name, kind: 'board' }));
  const everyone = useMemo(() => {
    const seen = new Map();
    for (const p of [...roll, ...d.people]) if (p.slug && p.name && !seen.has(p.slug)) seen.set(p.slug, { slug: p.slug, name: p.name });
    return [...seen.values()];
  }, [roll, d.people]);

  // Who's marked: what's typed here, over what the meeting already knows (marked on it, or checked in on the board page)
  // (the secretary keeping these was there, until they say otherwise)
  const keeper = (p) => mine && !times.sent && !!p.slug && p.slug === d.me?.slug;
  const statusOf = (p) => { const s = vals[`r:${p.key}`] || base.roll[p.key] || (keeper(p) ? 'present' : ''); return s === 'absent' ? '' : s; };
  const here = roll.filter((p) => p.kind === 'board' && ['present', 'remote'].includes(statusOf(p))).length;
  // Someone really marked (the keeper counted by default isn't: with nobody marked, the meeting's list is left as it is)
  const marked = roll.some((p) => p.kind === 'board' && (vals[`r:${p.key}`] || base.roll[p.key]) && ['present', 'remote'].includes(statusOf(p)));
  const boardCount = roll.filter((p) => p.kind === 'board').length;

  const items = o.parts.flatMap((p) => p.items);
  const motionOf = (it) => (it.minutes ? base.approving || approveWords(null) : it.motion);
  const votesDrawn = new Set(items.filter((it) => motionOf(it)).map((it) => it.id));
  const itemIds = new Set(items.map((it) => it.id));
  const partIds = new Set(o.parts.map((p) => p.id));
  const takenOn = (text) => (m.motions || []).find((x) => x.tally?.at && sameWords(x.text, text)) || null;
  // A decision on the meeting that isn't on the agenda (a vote on the board page, or one from Board): it's in the minutes, so
  // it's shown, with who moved it to fill in
  const floorKey = (x) => `m:${`t_${x.id}`.slice(0, 40)}`;
  const takenFloor = (m.motions || []).filter((x) => !(`m:${x.id}` in vals) && !items.some((it) => motionOf(it) && sameWords(motionOf(it), x.text)) && !Object.entries(vals).some(([k, v]) => k.startsWith('m:') && !k.startsWith('m:t_') && sameWords(v?.text, x.text)));
  // The same for an action item already on the meeting: it's in the minutes, so it's shown
  const actionsOn = (m.actions || []).filter((x) => !(`a:${x.id}` in vals) && !Object.entries(vals).some(([k, v]) => k.startsWith('a:') && sameWords(v?.text, x.text)));
  // Every other vote (one typed here, or an item's whose motion has come off the agenda since): a row of its own, never lost
  const floor = Object.keys(vals).filter((k) => k.startsWith('m:') && !k.startsWith('m:t_') && !votesDrawn.has(k.slice(2)) && (!ro || rowFilled(vals[k])));
  const todo = Object.keys(vals).filter((k) => k.startsWith('a:'));
  // Notes typed under an item that's since come off the agenda: never dropped without a word
  const left = Object.keys(vals).filter((k) => k.startsWith('n:') && !itemIds.has(k.slice(2)) && !partIds.has(k.slice(2)) && !blank(vals[k]));

  // Lines in the notes that read as to-dos and aren't action items yet (../board-todos.js): offered, never added by themselves
  const nextDate = useMemo(() => data.meetings.filter((x) => x.date > m.date).map((x) => x.date).sort()[0] || '', [data.meetings, m.date]);
  const found = useMemo(() => (ro || !loaded ? [] : findToDos(m, vals, { people: everyone, next: nextDate })), [ro, loaded, m, vals, everyone, nextDate]);
  const addFound = (f) => set(`a:${uid('a_')}`, { text: f.text, owner: f.owner, ownerName: f.ownerName, due: f.due, from: f.from });
  const skipFound = (list) => set('skipped', [...String(vals.skipped || '').split('\n').filter(Boolean), ...list.map((f) => f.key)].join('\n'));
  useEffect(() => { if (askingToDos && !found.length) setAskingToDos(null); }, [askingToDos, found.length]);
  // Send gives way to the question: the focus goes to it, so it's read out and the keyboard is on the answer
  const asking = !!askingToDos;
  useEffect(() => { if (asking) document.querySelector('.bn-ask__do button')?.focus({ preventScroll: true }); }, [asking]);
  // A line dealt with leaves the list: the focus stays on what's next
  const onFound = () => requestAnimationFrame(() => (document.querySelector('.bn-found button') || document.querySelector('[data-add="a"]'))?.focus({ preventScroll: true }));

  // What a send needs first: a vote written on but not how it went, a row with no words
  const issues = {};
  for (const it of items) {
    const v = vals[`m:${it.id}`];
    if (votesDrawn.has(it.id) && v && !v.result && !takenOn(motionOf(it)) && (!blank(v.by) || !blank(v.second) || number(v.for) || number(v.against) || number(v.abstain))) issues[it.id] = 'Passed, failed or tabled?';
    else if (votesDrawn.has(it.id) && v && !takenOn(motionOf(it)) && halfCounted(v)) issues[it.id] = COUNTS_WORDS;
  }
  for (const k of floor) {
    const v = vals[k];
    if (!rowFilled(v)) continue;
    if (blank(v.text)) issues[k.slice(2)] = 'What was moved?';
    else if (!v.result) issues[k.slice(2)] = 'Passed, failed or tabled?';
    else if (halfCounted(v)) issues[k.slice(2)] = COUNTS_WORDS;
  }
  for (const k of todo) if (rowFilled(vals[k]) && blank(vals[k].text)) issues[k.slice(2)] = 'What needs doing?';

  // Something that can go in, and anything typed at all (a press with only the second says what's missing)
  // A version to choose whose box isn't on the page any more (its item came off, say): drawn at the top, never out of reach
  const boxed = new Set(['guests', 'adjourned', ...roll.map((p) => `r:${p.key}`), ...items.map((it) => `n:${it.id}`), ...o.parts.filter((p) => !p.items.length || vals[`n:${p.id}`]).map((p) => `n:${p.id}`), ...[...votesDrawn].map((id) => `m:${id}`), ...takenFloor.map(floorKey), ...floor, ...todo, ...left]);
  const stray = Object.keys(clashes).filter((k) => !boxed.has(k));

  const typedAny = Object.entries(vals).some(([k, v]) => {
    if (k === 'guests') return !blank(v);
    if (k[1] !== ':') return false;
    if (k[0] === 'm') return !!v?.result;
    if (k[0] === 'a') return !blank(v?.text);
    return k[0] === 'r' ? v !== 'absent' : !!v;
  });
  const anyWords = Object.entries(vals).some(([k, v]) => k !== 'skipped' && (v && typeof v === 'object' ? rowFilled(v) : !blank(v)));
  // (a meeting the chair ended ahead of its date has been held)
  const canSend = m.date <= data.today || !!m.live?.endedAt;
  const sent = times.sent;
  const unsent = !sent || (times.at && times.at > sent);

  // The agenda follows: the item being typed about comes into view beside it (on a phone the panel covers the page)
  const show = (id) => {
    if (phone) return;
    const el = document.getElementById(id);
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.top >= 84 && r.top < innerHeight * 0.45) return;
    el.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'start' });
  };
  const jump = (id) => requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView({ behavior: reduceMotion() ? 'auto' : 'smooth', block: 'center' }));

  // An item that came off the agenda while the notes were open: said, never just left out
  const leftCount = useRef(null);
  useEffect(() => {
    if (!loaded) return;
    if (leftCount.current !== null && left.length > leftCount.current) say('An item you typed under came off the agenda. Your words are at the bottom of your notes.', 'warn');
    leftCount.current = left.length;
  }, [loaded, left.length]);

  const removeRow = (key, words, kind) => {
    const was = vals[key];
    set(key, null);
    if (rowFilled(was)) say(`${words} is taken out.`, '', { label: 'Undo', run: () => set(key, was) });
    requestAnimationFrame(() => document.querySelector(`[data-add="${kind}"]`)?.focus());
  };
  // A row just added takes the typing the moment it's drawn
  const newRow = useRef('');
  useEffect(() => {
    const box = newRow.current && document.querySelector(`[data-row="${newRow.current}"] textarea`);
    if (!box) return;
    box.focus();
    newRow.current = '';
  });
  const addRow = (kind) => {
    holdKeyboard();
    const key = `${kind}:${uid(kind === 'm' ? 'v_' : 'a_')}`;
    newRow.current = key;
    setVals((v) => ({ ...v, [key]: {} }));
  };

  useEffect(() => { if (loaded && scroller.current && scrollKept.get(m.id)) scroller.current.scrollTop = scrollKept.get(m.id); }, [loaded]);

  // Words this device can't keep, not saved yet, live only in this panel: it stays open until they're safe
  const closing = () => {
    if (!deviceKeeps && draft.unsaved()) { say('Your notes haven’t saved, and this device can’t keep them. Stay here until it says Saved.', 'warn'); return; }
    onClose();
  };

  // A choice to make comes into view, wherever it turned up
  const choices = Object.keys(clashes).join('|');
  const lastChoices = useRef('');
  useEffect(() => {
    const fresh = Object.keys(clashes).find((k) => !lastChoices.current.split('|').includes(k));
    lastChoices.current = choices;
    if (fresh) jump(`bn-c-${fresh}`);
  }, [choices]);

  const sendNow = useRef(null);
  const send = async (fine = {}) => {
    if (sending) return;
    const clash = Object.keys(clashes)[0];
    if (clash) { say('One box has two versions. Choose which to keep first.', 'warn'); jump(`bn-c-${clash}`); return; }
    const issue = Object.keys(issues)[0];
    if (issue) {
      setNeeds(true);
      jump(document.getElementById(`bn-v-${issue}`) ? `bn-v-${issue}` : `bn-a-${issue}`);
      say(issues[issue] === 'Passed, failed or tabled?' ? 'One vote still needs how it went: passed, failed or tabled.' : issues[issue] === COUNTS_WORDS ? 'One vote still needs both counts, for and against.' : 'One row still needs its words.', 'warn');
      return;
    }
    if (!typedAny && !sent) { say('Nothing to send yet. Mark who was there, or add a note or a vote’s result.', 'warn'); return; }
    // The first time, on the day, with the chair not having ended it: this goes to the whole board
    if (!sent && m.date === data.today && !m.live?.endedAt && !fine.over) {
      say('The board sees the minutes as soon as they’re sent. Is the meeting over?', 'warn', { stay: true, label: 'Yes, send them', run: () => sendNow.current({ ...fine, over: true }) });
      return;
    }
    // A count and a result that don't go together: asked, never refused (some votes need more than a majority)
    // (a vote the board took on the board page is its own record: what's typed for it doesn't go in)
    const odd = Object.entries(vals).find(([k, v]) => k.startsWith('m:') && !takenOn(v?.text) && number(v?.for) && number(v?.against) && ((v.result === 'failed' && v.for > v.against) || (v.result === 'passed' && v.for < v.against)));
    if (odd && !fine.counts) {
      jump(`bn-v-${odd[0].slice(2)}`);
      say(`One vote says ${odd[1].result === 'failed' ? 'Failed' : 'Passed'} with ${odd[1].for} for and ${odd[1].against} against. Is that right?`, 'warn', { stay: true, label: 'Send anyway', run: () => sendNow.current({ ...fine, counts: true }) });
      return;
    }
    if (typedAny && !marked && !fine.nobody && roll.length) {
      jump('bn-roll');
      say(`Nobody ${roll.some(keeper) ? 'else ' : ''}is marked as here yet, so the minutes won’t show who was there.`, 'warn', { stay: true, label: 'Send anyway', run: () => sendNow.current({ ...fine, nobody: true }) });
      return;
    }
    // Everyone not marked goes in as not there
    const unmarked = roll.filter((p) => p.kind === 'board' && !statusOf(p)).length;
    if (typedAny && marked && unmarked && !sent && !fine.unmarked) {
      jump('bn-roll');
      say(`${unmarked === 1 ? 'One board member isn’t marked, so the minutes will say they weren’t there.' : `${unmarked} board members aren’t marked, so the minutes will say they weren’t there.`}`, 'warn', { stay: true, label: 'Send anyway', run: () => sendNow.current({ ...fine, unmarked: true }) });
      return;
    }
    const minutesItem = items.find((it) => it.minutes);
    if (base.approvingWaiting && minutesItem && vals[`m:${minutesItem.id}`]?.result === 'passed' && !fine.closes) {
      say('The meeting this approves has typed notes that were never sent. Approving it closes them.', 'warn', { stay: true, label: 'Send anyway', run: () => sendNow.current({ ...fine, closes: true }) });
      return;
    }
    if (base.approvingCorrections && minutesItem && vals[`m:${minutesItem.id}`]?.result === 'passed' && !fine.corrections) {
      say(`${base.approvingCorrections === 1 ? 'A correction' : `${base.approvingCorrections} corrections`} to the minutes this approves ${base.approvingCorrections === 1 ? 'is' : 'are'} still waiting. Approving them leaves ${base.approvingCorrections === 1 ? 'it' : 'those'} out.`, 'warn', { stay: true, label: 'Send anyway', run: () => sendNow.current({ ...fine, corrections: true }) });
      return;
    }
    if (left.length && !fine.left) {
      jump('bn-left');
      say('Notes under an item that’s off the agenda won’t go in.', 'warn', { stay: true, label: 'Send anyway', run: () => sendNow.current({ ...fine, left: true }) });
      return;
    }
    if (found.length && !fine.todos) {
      jump('bn-found');
      setAskingToDos(fine);
      return;
    }
    setAskingToDos(null);
    setSending(true);
    let j = null;
    try {
      if (!await flush({ all: true })) { say(`Your notes haven’t saved yet, so they weren’t sent. ${deviceKeeps ? 'They’re safe on this device.' : 'Keep this page open.'}`, 'warn'); setSending(false); return; }
      // Found as they saved: another device got to a box first, so nothing goes until it's chosen
      if (draft.clashing()) { say('One box has two versions. Choose which to keep first.', 'warn'); setSending(false); return; }
      j = await answer(await timed(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'notes-send', meetingId: m.id }) }, SEND_MS));
    } catch (err) {
      j = { ok: false, error: err instanceof SignedOut ? 'Your sign-in ran out. Reload the page to sign in again: your notes are saved.' : 'No answer from the site. Your notes are saved. It may have gone through: if the button still says send, try again.' };
      draft.retry({ quick: true });
    }
    setSending(false);
    if (!j.ok) { say(j.error || 'The minutes didn’t go through. Try again.', 'warn'); return; }
    setTimes((t) => ({ at: t.at, sent: j.sent || '' }));
    // (sent is sent: a page that can't refresh just now stays as it is)
    await load({ keep: true });
    await draft.retry({ quick: true });
    if (j.cleared) { say('Done. Everything you sent is back off the meeting.'); return; }
    const got = thanks(j.read);
    const approved = j.approvedPrev ? ' The minutes that vote approved now show as approved.' : j.withdrawn ? ' That vote no longer approves the last meeting’s minutes, so they’re back to draft.' : '';
    const stayed = j.kept ? ` ${j.kept === 1 ? 'One thing' : `${j.kept} things`} changed on the meeting since, so ${j.kept === 1 ? 'it stays as it is' : 'they stay as they are'}.` : '';
    say(`Thank you. Board has the minutes${got ? `: ${got}` : ''}.${approved}${stayed}`);
  };

  sendNow.current = send;

  const removeLabel = (what, text) => (blank(text) ? `Remove this ${what}` : `Remove the ${what}: ${String(text).trim().slice(0, 60)}`);

  return html`<aside class="bn bp-noprint" ref=${root} tabindex="-1" role=${phone ? 'dialog' : null} aria-modal=${phone ? 'true' : null} aria-label="Notes for the minutes" onKeyDown=${(e) => { if (e.key === 'Escape' && !e.defaultPrevented && !e.target.list) closing(); }}>
    <datalist id="bn-names">${everyone.map((p) => html`<option key=${p.slug} value=${p.name}></option>`)}</datalist>
    <header class="bn-head">
      <div class="bn-head__t">
        <h2>${mine ? 'Your notes' : 'Notes for the minutes'}</h2>
        <p class=${`bn-state is-${Object.keys(clashes).length ? 'refused' : state}`} role="status"><span>${stateWords(state, why, times, ro, Object.keys(clashes).length > 0, deviceKeeps)}</span>${!ro && !times.sent && !Object.keys(clashes).length && ['loading', 'saving', 'saved'].includes(state) ? html`<span class="bn-state__who">Only you and the founders see these until they’re sent.</span>` : null}</p>
      </div>
      <button type="button" class="bn-close" onClick=${closing} aria-label="Close the notes"><${Icon} name="close" size=${20} /></button>
    </header>

    <div class="bn-scroll" ref=${scroller} onScroll=${(e) => scrollKept.set(m.id, e.target.scrollTop)}>
      ${loaded ? html`
      ${stray.map((k) => html`<${Clash} key=${k} draft=${draft} k=${k} label="a box no longer on the agenda" show=${(t) => (typeof t === 'string' && RESULT_WORDS[t]) || t || 'Nothing'} />`)}
      <section class="bn-sec" aria-labelledby="bn-who">
        <div class="bn-sec__h"><h3 id="bn-who">Who was there</h3><span class="bn-sec__c">${here} of ${boardCount}${o.quorum ? ` · quorum ${o.quorum}` : ''}</span></div>
        <ul class="bn-roll" id="bn-roll">${roll.map((p) => html`<li key=${p.key}>
          <span class="bn-roll__n">${p.name}${p.kind === 'staff' ? html`<small>Staff</small>` : null}</span>
          <${Pick} label=${p.name} value=${statusOf(p)} choices=${HERE} ro=${ro} onPick=${(x) => set(`r:${p.key}`, x || (keeper(p) && !vals[`r:${p.key}`] ? 'present' : base.roll[p.key] || keeper(p) ? 'absent' : ''))} />
          <${Clash} draft=${draft} k=${`r:${p.key}`} label=${p.name} show=${(x) => HOW[x] || 'Not marked'} />
        </li>`)}</ul>
        <div class="bn-f"><span aria-hidden="true">Guests, one to a line</span><${Words} draft=${draft} k="guests" label="Guests, one to a line" placeholder="" rows=${1} max=${MAX_LINE} ro=${ro} /></div>
      </section>

      ${o.parts.map((part, pi) => html`<section class="bn-sec" key=${part.id}>
        <div class="bn-sec__h"><h3><span class="bn-n">${String(pi + 1).padStart(2, '0')}</span>${part.title}</h3></div>
        ${part.items.map((it) => {
          const key = `m:${it.id}`;
          const motion = motionOf(it);
          return html`<div class="bn-item" key=${it.id}>
            <p class="bn-item__t"><span class="bn-item__n">${it.label}</span><span>${it.title}${it.presenter ? html`<small>${it.presenter}</small>` : null}</span></p>
            ${(base.fixed || []).includes(it.id) ? html`<p class="bn-had"><strong>This changed on the meeting since you sent it:</strong> ${it.notes || 'Nothing under it now.'}<span>That’s what the meeting keeps.</span></p>`
              : it.notes && !(base.on || []).includes(it.id) && !blank(vals[`n:${it.id}`]) && !sameNote(it.notes, vals[`n:${it.id}`]) ? html`<p class="bn-had"><strong>On the agenda now:</strong> ${it.notes}${ro ? null : html`<span>Your notes take its place when you send them.</span>`}</p>` : null}
            ${motion ? html`<p class="bn-motion">${motion}</p><${Vote} id=${it.id} v=${vals[key]} draft=${draft} k=${key} ro=${ro} counts=${!it.minutes} taken=${takenOn(motion)} need=${needs ? issues[it.id] : ''} put=${(patch) => setField(key, { text: motion, ...patch })} />` : null}
            <${Words} draft=${draft} k=${`n:${it.id}`} label=${`Notes on ${it.title}`} ro=${ro} onFocus=${() => show(`i-${it.id}`)} />
          </div>`;
        })}
        ${!part.items.length || vals[`n:${part.id}`] ? html`<div class="bn-item"><${Words} draft=${draft} k=${`n:${part.id}`} label=${`Notes on ${part.title}`} ro=${ro} onFocus=${() => show(`s-${part.id}`)} /></div>` : null}
      </section>`)}

      ${left.length ? html`<section class="bn-sec" id="bn-left">
        <div class="bn-sec__h"><h3>Off the agenda now</h3></div>
        <p class="bn-muted">You typed these under an item that’s no longer on the agenda. They won’t go in with the minutes, so copy what you need.</p>
        ${left.map((k) => html`<div class="bn-row" key=${k}><p class="bn-left">${vals[k]}</p><${Clash} draft=${draft} k=${k} label="this note" show=${(t) => t || 'Nothing: the box was emptied.'} />${ro ? null : html`<button type="button" class="bn-x" aria-label=${removeLabel('note', vals[k])} onClick=${() => { const was = vals[k]; set(k, null); say('The note is taken out.', '', { label: 'Undo', run: () => set(k, was) }); }}>Remove</button>`}</div>`)}
      </section>` : null}

      <section class="bn-sec">
        <div class="bn-sec__h"><h3>Other motions</h3></div>
        ${takenFloor.map((x) => { const key = floorKey(x); return html`<div class="bn-row" key=${key}>
          <p class="bn-motion">${x.text}</p>
          <${Vote} id=${key.slice(2)} v=${{ by: x.by, second: x.second, ...vals[key] }} draft=${draft} k=${key} ro=${ro} taken=${x} put=${(patch) => setField(key, { text: x.text, ...patch })} />
        </div>`; })}
        ${floor.map((k) => { const id = k.slice(2); return html`<div class="bn-row" key=${k} data-row=${k}>
          <${Grow} label="What was moved" placeholder="What was moved" rows=${1} max=${MAX_LINE} ro=${ro} value=${vals[k]?.text || ''} onInput=${(text) => setField(k, { text })} />
          <${Vote} id=${id} v=${vals[k]} draft=${draft} k=${k} ro=${ro} need=${needs ? issues[id] : ''} put=${(patch) => setField(k, patch)} />
          ${ro ? null : html`<button type="button" class="bn-x" aria-label=${removeLabel('motion', vals[k]?.text)} onClick=${() => removeRow(k, 'The motion', 'm')}>Remove</button>`}
        </div>`; })}
        ${ro ? null : html`<button type="button" class="bp-mini" data-add="m" onClick=${() => addRow('m')}><${Icon} name="plus" size=${16} />Add a motion</button>`}
      </section>

      <section class="bn-sec">
        <div class="bn-sec__h"><h3>Action items</h3></div>
        ${found.length ? html`<div class="bn-found" id="bn-found" role="group" aria-labelledby="bn-found-t" tabindex="-1">
          <p class="bn-found__t" id="bn-found-t">${found.length === 1 ? 'This line in your notes reads like a to-do' : `These ${found.length} lines in your notes read like to-dos`}</p>
          <ul>${found.map((f) => html`<li key=${f.key}>
            <p>${f.text}</p>
            ${f.ownerName || f.due ? html`<small>${[f.ownerName, f.due ? `by ${shortDay(f.due)}` : ''].filter(Boolean).join(' · ')}</small>` : null}
            <div class="bn-found__do"><button type="button" class="bp-mini" aria-label=${`Add it: ${f.text.slice(0, 80)}`} onClick=${() => { addFound(f); onFound(); }}><${Icon} name="plus" size=${16} />Add it</button><button type="button" class="bp-mini" aria-label=${`Not a to-do: ${f.text.slice(0, 80)}`} onClick=${() => { skipFound([f]); onFound(); }}>Not a to-do</button></div>
          </li>`)}</ul>
          ${found.length > 1 ? html`<button type="button" class="bp-mini bn-found__all" onClick=${() => { found.forEach(addFound); onFound(); }}>Add all ${found.length}</button>` : null}
        </div>` : null}
        ${actionsOn.length ? html`<ul class="bn-on" aria-label="Already on the meeting">${actionsOn.map((x) => html`<li key=${x.id}>${x.text}${x.ownerName ? ` (${x.ownerName})` : ''}</li>`)}</ul>` : null}
        ${todo.map((k) => { const id = k.slice(2); return html`<div class="bn-row" key=${k} data-row=${k} id=${`bn-a-${id}`}>
          <${Grow} label="What needs doing" placeholder="What needs doing" rows=${1} max=${MAX_LINE} ro=${ro} value=${vals[k]?.text || ''} onInput=${(text) => setField(k, { text })} />
          <div class="bn-two">
            <label class="bn-f"><span>Who</span><select class="bn-in" disabled=${ro} value=${vals[k]?.owner || ''} onChange=${(e) => setField(k, { owner: e.target.value, ownerName: everyone.find((p) => p.slug === e.target.value)?.name || '' })}><option value=""></option>${everyone.map((p) => html`<option key=${p.slug} value=${p.slug}>${p.name}</option>`)}</select></label>
            <label class="bn-f"><span>By when</span><input class="bn-in" type="date" min=${m.date} readonly=${ro} value=${vals[k]?.due || ''} onInput=${(e) => setField(k, { due: e.target.value })} /></label>
          </div>
          ${vals[k]?.due && vals[k].due < m.date ? html`<p class="bn-need">That’s before the meeting.</p>` : null}
          <${Clash} draft=${draft} k=${k} label="this action item" show=${(t) => t} />
          ${needs && issues[id] ? html`<p class="bn-need">${issues[id]}</p>` : null}
          ${ro ? null : html`<button type="button" class="bn-x" aria-label=${removeLabel('action item', vals[k]?.text)} onClick=${() => removeRow(k, 'The action item', 'a')}>Remove</button>`}
        </div>`; })}
        ${ro ? null : html`<button type="button" class="bp-mini" data-add="a" onClick=${() => addRow('a')}><${Icon} name="plus" size=${16} />Add an action item</button>`}
      </section>

      <section class="bn-sec">
        <label class="bn-f bn-f--end"><span>Adjourned at</span><input class="bn-in" type="time" readonly=${ro} value=${vals.adjourned || ''} onInput=${(e) => set('adjourned', e.target.value)} /></label>
        ${!vals.adjourned && endedClock(m) ? html`<p class="bn-muted bn-ended">The chair ended it at ${clock(endedClock(m))}. That goes in unless you change it.</p>` : null}
        <${Clash} draft=${draft} k="adjourned" label="when it adjourned" show=${(t) => t || 'Not set'} />
      </section>` : html`<p class="bn-muted bn-wait">${state === 'refused' ? why : 'Getting your notes…'}</p>`}
    </div>

    <footer class="bn-foot">
      ${ro ? html`<p class="bn-muted">Copy anything that’s needed from here.</p>`
        : canSend && askingToDos && found.length ? html`<div role="group" aria-labelledby="bn-ask-t">
          <p class="bn-ask" id="bn-ask-t">${found.length === 1 ? 'One line reads like a to-do and isn’t an action item yet.' : `${found.length} lines read like to-dos and aren’t action items yet.`}</p>
          <div class="bn-ask__do">
            <button type="button" class="bp-btn bp-btn--primary bn-send" onClick=${() => { const fine = askingToDos; found.forEach(addFound); requestAnimationFrame(() => sendNow.current({ ...fine, todos: true })); }}>${found.length === 1 ? 'Add it and send' : 'Add them and send'}</button>
            <button type="button" class="bp-btn" onClick=${() => { const fine = askingToDos; skipFound(found); requestAnimationFrame(() => sendNow.current({ ...fine, todos: true })); }}>Send without</button>
          </div>
        </div>`
        : canSend ? html`<button type="button" class="bp-btn bp-btn--primary bn-send" disabled=${sending || !loaded || (!anyWords && !sent) || (sent && !unsent)} onClick=${() => send()}>${sending ? 'Sending…' : sent ? (unsent ? 'Send the changes' : 'Sent') : 'Send the minutes'}</button>`
        : html`<p class="bn-muted">You can send these on the day of the meeting.</p>`}
    </footer>
  </aside>`;
}
