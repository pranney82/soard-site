/**
 * The board page → a meeting's minutes → corrections
 * ===========================================================================
 * Draft minutes are there to be read before the vote. Under what's wrong, a member
 * suggests the words as they should be (or who was really there, or says anything
 * else), and the whole board sees it. The secretary or a founder makes it with one
 * press, or keeps the minutes as they are. portal.js draws these beside the words
 * they're about; ../../../functions/api/_board-corrections.js keeps them.
 */

import { h, htm, useState, useRef, useEffect } from '../vendor.js';
import { minutesIn, shortDate, meetingName } from '../board-shared.js';
import { noteLines } from '../board-minutes-template.js';

const html = htm.bind(h);
const API = '/api/board-portal';
const HOW = { present: 'here', remote: 'on video', excused: 'excused', absent: 'not there' };
const CHOICES = [['present', 'Here'], ['remote', 'On video'], ['excused', 'Excused'], ['absent', 'Not there']];
const day = (iso) => shortDate(String(iso).slice(0, 10)).replace(/, \d{4}$/, '');
const andCount = (n, one) => `${n} ${one}${n === 1 ? '' : 's'}`;

async function post(body) {
  try {
    const r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const j = await r.json().catch(() => ({ ok: false, error: /cloudflareaccess/i.test(r.url || '') ? 'Your sign-in expired. Reload the page to sign in again.' : `Something went wrong (${r.status})` }));
    return r.ok ? j : { ...j, ok: false };
  } catch {
    return { ok: false, error: 'No connection. Check your internet and try again.' };
  }
}

/** A word diff as runs: the words next to each other that changed the same way, one mark */
export const runsOf = (diff) => diff.reduce((out, p) => { const last = out.at(-1); if (last && last.op === p.op) last.w += ` ${p.w}`; else out.push({ ...p }); return out; }, []);
/** Two lines' words, the old against the new: [{ w, op: '' (both), '+' (new), '-' (gone) }] (the longest run they share kept) */
export function wordDiff(a, b) {
  const x = a.split(/\s+/); const y = b.split(/\s+/);
  const L = Array.from({ length: x.length + 1 }, () => new Array(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  let i = 0; let j = 0;
  while (i < x.length && j < y.length) {
    if (x[i] === y[j]) { out.push({ w: y[j], op: '' }); i++; j++; } else if (L[i + 1][j] >= L[i][j + 1]) out.push({ w: x[i++], op: '-' }); else out.push({ w: y[j++], op: '+' });
  }
  while (i < x.length) out.push({ w: x[i++], op: '-' });
  while (j < y.length) out.push({ w: y[j++], op: '+' });
  return out;
}

/** Whether these minutes take corrections: in, on the board page, not approved */
export const correctable = (m) => !!m && !m.pending && !m.preview && !m.practice && !!m.shared && m.minutes !== 'approved' && minutesIn(m);
export const correctionsOf = (data, id) => data.corrections?.[id] || [];
/** The waiting ones someone on this page can decide */
export const toDecide = (data, id) => correctionsOf(data, id).filter((c) => c.state === 'waiting');
const lines = (s) => noteLines(s).join(' / ');
const sameLines = (a, b) => noteLines(a).join('\n') === noteLines(b).join('\n');
/** What the meeting says now where a correction is aimed: null when it isn't on the meeting any more */
function nowOf(m, c) {
  const key = c.target.slice(2);
  if (c.kind === 'roll') { const p = (m.attendance || []).find((x) => x.key === key); return p ? p.status || '' : null; }
  if (c.kind !== 'words') return null;
  for (const s of m.sections || []) { if (s.id === key) return s.notes || ''; const it = s.items.find((x) => x.id === key); if (it) return it.notes || ''; }
  return null;
}
const moves = () => (matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');
const focusOn = (id) => requestAnimationFrame(() => document.getElementById(id)?.focus({ preventScroll: true }));
const nameOn = (m, c) => (m.attendance || []).find((p) => p.key === c.target.slice(2))?.name || 'Someone';

/** What it would change: the same words, with what's gone and what's new marked */
function Change({ c, m }) {
  if (c.kind === 'words' && !(m.sections || []).some((s) => s.id === c.target.slice(2) || s.items.some((it) => it.id === c.target.slice(2)))) return html`<p class="mfix-said">${c.words}</p><p class="mfix-note">The item it was under isn’t on the meeting any more.</p>`;
  if (c.kind === 'roll') return html`<p class="mfix-said">${nameOn(m, c)} was ${HOW[c.words] || c.words}.${c.was ? ` The minutes said ${HOW[c.was] || c.was}.` : ''}</p>`;
  if (c.kind === 'other') return html`<p class="mfix-said">${c.words}</p>`;
  if (!c.words.trim()) return html`<p class="mfix-said">Take these words out.</p>`;
  const was = lines(c.was);
  const now = lines(c.words);
  return html`<p class="mfix-said">${(was ? runsOf(wordDiff(was, now)) : [{ w: now, op: '+' }]).map((r, i) => (r.op === '+' ? html`<ins key=${i}><span class="sr-only">New words: </span>${r.w} </ins>` : r.op === '-' ? html`<del key=${i}><span class="sr-only">Taken out: </span>${r.w} </del>` : html`<span key=${i}>${r.w} </span>`))}</p>`;
}

/**
 * The words as they should be, the person on the roll, or anything else: `kind`. `kept`: what was in the box when Esc
 * closed it, back when it opens. `shut`: the minutes were approved with this open, so the words stay to copy and can't go.
 * The words it opened on are what it sends as what it read: when the page catches up with newer ones, the box says so and
 * nothing goes until they've read them, so a correction never quietly puts back what someone just fixed.
 */
function Box({ m, ctx, target, was, label, kind, onClose, onSent, kept, shut }) {
  const { data, load, say } = ctx;
  const secretary = data.people?.board?.find((p) => p.seat === 'secretary');
  const box = useRef(null);
  const form = useRef(null);
  const [read, setRead] = useState(kept.current?.read ?? was);
  const [text, setText] = useState(kept.current?.text ?? (kind === 'words' ? was : ''));
  const [person, setPerson] = useState('');
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const grow = () => { const t = box.current; if (t?.tagName !== 'TEXTAREA') return; t.style.height = 'auto'; t.style.height = `${Math.min(t.scrollHeight + 2, Math.round(innerHeight * 0.6))}px`; };
  useEffect(() => { box.current?.focus({ preventScroll: true }); grow(); form.current?.scrollIntoView({ behavior: moves(), block: 'nearest' }); }, []);
  const roll = (m.attendance || []).filter((p) => p.kind === 'board' || p.kind === 'staff');
  const who = person || roll.find((p) => p.slug && p.slug === data.me.slug)?.key || '';
  const moved = kind === 'words' && !sameLines(read, was);
  const send = async (e) => {
    e.preventDefault();
    if (moved || shut) return;
    if (kind === 'roll' && (!who || !status)) { setProblem(!who ? 'Who is it about?' : 'Were they here, on video, excused or not there?'); return; }
    setBusy(true);
    setProblem('');
    const j = await post({ action: 'correction', meetingId: m.id, target: kind === 'roll' ? `r:${who}` : target, words: kind === 'roll' ? status : text, ...(kind === 'words' ? { was: read } : {}) });
    setBusy(false);
    if (!j.ok) {
      // (the page catches up: newer words are said in the box, and a meeting approved meanwhile keeps theirs to copy)
      if (j.changed || j.reload) load({ keep: true });
      if (!j.changed) setProblem(j.error || 'That didn’t go through. Try again.');
      return;
    }
    await load({ keep: true });
    say(`Sent. ${secretary ? `${secretary.name.split(/\s+/)[0]} will see it.` : 'SOARD will see it.'}`);
    onSent(j.correction?.id);
  };
  const useNew = () => { setRead(was); setText(was); requestAnimationFrame(() => { box.current?.focus({ preventScroll: true }); grow(); }); };
  return html`<form class="mfix-box" ref=${form} onSubmit=${send} onKeyDown=${(e) => { if (e.key === 'Escape') { e.stopPropagation(); kept.current = { text, read }; onClose(); } }}>
    ${shut ? html`<p class="mfix-problem" role="alert">The board approved these while you had this open, so it can’t be sent. Your words are here to copy.</p>` : null}
    ${moved && !shut ? html`<div class="mfix-moved" role="alert"><p>These words changed while you had them open. They read:</p><p class="mfix-said">${lines(was) || 'Nothing is written here now.'}</p><button type="button" class="bp-mini" onClick=${useNew}>Start from the new words</button></div>` : null}
    ${kind === 'words' ? html`<label class="mfix-box__l" for=${`mfix-${target}`}>How it should read</label><textarea ref=${box} id=${`mfix-${target}`} class="mfix-in" rows="3" maxlength="20000" value=${text} onInput=${(e) => { setText(e.target.value); grow(); }}></textarea>`
      : kind === 'roll' ? html`<label class="mfix-box__l" for=${`mfix-who-${m.id}`}>Who</label>
        <select ref=${box} id=${`mfix-who-${m.id}`} class="mfix-in" value=${who} onChange=${(e) => setPerson(e.target.value)}><option value=""></option>${roll.map((p) => html`<option key=${p.key} value=${p.key}>${p.name}</option>`)}</select>
        <p class="mfix-box__l" id=${`mfix-how-${m.id}`}>They were</p>
        <div class="mfix-pick" role="group" aria-labelledby=${`mfix-how-${m.id}`}>${CHOICES.map(([id, words]) => html`<button type="button" key=${id} class="bp-mini" aria-pressed=${status === id} onClick=${() => setStatus(id)}>${words}</button>`)}</div>`
      : html`<label class="mfix-box__l" for=${`mfix-${target}`}>${label}</label><textarea ref=${box} id=${`mfix-${target}`} class="mfix-in" rows="3" maxlength="20000" value=${text} onInput=${(e) => { setText(e.target.value); grow(); }}></textarea>`}
    ${problem ? html`<p class="mfix-problem" role="alert">${problem}</p>` : null}
    <div class="mfix-do">
      ${shut || moved ? null : html`<button type="submit" class="bp-btn bp-btn--primary bp-btn--sm" disabled=${busy}>${busy ? 'Sending…' : 'Send the correction'}</button>`}
      <button type="button" class="bp-mini" onClick=${() => { kept.current = null; onClose(); }}>${shut ? 'Close' : 'Cancel'}</button>
    </div>
  </form>`;
}

/** One correction: what it says, who said it, and what the person looking can do about it */
function Row({ c, m, ctx, Icon, decider, onBack }) {
  const { load, say } = ctx;
  const [busy, setBusy] = useState('');
  const [keeping, setKeeping] = useState(false);
  const [why, setWhy] = useState('');
  const keep = useRef(null);
  const whyBox = useRef(null);
  useEffect(() => { if (keeping) whyBox.current?.focus({ preventScroll: true }); }, [keeping]);
  const notKeeping = () => { setKeeping(false); requestAnimationFrame(() => keep.current?.focus({ preventScroll: true })); };
  const decide = async (make) => {
    setBusy(make ? 'make' : 'keep');
    const j = await post({ action: 'correction-decide', id: c.id, make, reason: make ? '' : why, saw: c.words });
    setBusy('');
    if (!j.ok) { say(j.error || 'That didn’t go through. Try again.', 'warn', { stay: !!j.unsent }); if (j.reload || j.stale) load({ keep: true }); return; }
    await load({ keep: true });
    focusOn(`c-${c.id}`);
    say(!make ? (j.state === 'made' ? 'The minutes already say that, so it’s marked as made.' : 'The minutes stay as they are.') : c.kind === 'other' ? 'Marked as made.' : j.fileKeeps ? 'Made on this page. The file of the minutes keeps its words until a newer one is sent.' : 'Made. The minutes say that now.');
  };
  const takeBack = async () => {
    setBusy('back');
    const j = await post({ action: 'correction-withdraw', id: c.id });
    setBusy('');
    if (!j.ok) { say(j.error || 'That didn’t go through. Try again.', 'warn'); load({ keep: true }); return; }
    await load({ keep: true });
    onBack();
    say('Taken back.');
  };
  if (c.state === 'made') {
    return html`<div class="mfix-row mfix-row--made" id=${`c-${c.id}`} tabindex="-1">
      <p class="mfix-who"><${Icon} name="check" size=${14} />Corrected ${day(c.decidedAt)}. Suggested by ${c.by}${c.decidedBy && c.decidedBy !== c.by ? `, made by ${c.decidedBy}` : ''}.</p>
      ${c.kind === 'other' ? html`<${Change} c=${c} m=${m} />` : c.kind === 'roll' ? html`<${Change} c=${c} m=${m} />` : html`<details class="mfix-more"><summary>What it said before</summary><p>${c.was || 'Nothing was written here.'}</p></details>`}
    </div>`;
  }
  if (c.state === 'declined') {
    return html`<div class="mfix-row mfix-row--kept" id=${`c-${c.id}`} tabindex="-1">
      <p class="mfix-who">${c.mine ? 'Your correction' : `${c.by}’s correction`}: ${c.decidedBy ? `${c.decidedBy} kept` : 'kept'} the minutes as they are${c.reason ? `. “${c.reason}”` : '.'}</p>
      <${Change} c=${c} m=${m} />
    </div>`;
  }
  if (c.state === 'closed') {
    return html`<div class="mfix-row mfix-row--kept" id=${`c-${c.id}`}>
      <p class="mfix-who">${c.mine ? 'Your correction' : `${c.by}’s correction`} wasn’t decided before the board approved these.</p>
      <${Change} c=${c} m=${m} />
    </div>`;
  }
  const inFile = !m.minutesFrom?.typed && c.kind !== 'other';
  // What the minutes say there now: already this (nothing left to change), or moved since it was suggested (it can't go over them)
  const now = nowOf(m, c);
  const same = now !== null && (c.kind === 'roll' ? now === c.words : sameLines(now, c.words));
  const moved = c.kind !== 'other' && !same && (now === null || (c.kind === 'roll' ? now !== c.was : !sameLines(now, c.was)));
  return html`<div class="mfix-row" id=${`c-${c.id}`} tabindex="-1">
    <p class="mfix-who">${c.mine ? 'You suggested' : `${c.by} suggested`} ${c.kind === 'words' ? 'this correction' : 'a correction'}, ${day(c.at)}</p>
    <${Change} c=${c} m=${m} />
    ${decider ? keeping ? html`<div class="mfix-keep">
        <label class="mfix-box__l" for=${`mfix-why-${c.id}`}>Why, if you’d like to say</label>
        <input id=${`mfix-why-${c.id}`} ref=${whyBox} class="mfix-in" maxlength="1000" value=${why} onInput=${(e) => setWhy(e.target.value)} onKeyDown=${(e) => { if (e.key === 'Escape') { e.stopPropagation(); notKeeping(); } }} />
        <div class="mfix-do"><button type="button" class="bp-btn bp-btn--sm" disabled=${!!busy} onClick=${() => decide(false)}>${busy === 'keep' ? 'Saving…' : 'Keep them as they are'}</button><button type="button" class="bp-mini" onClick=${notKeeping}>Back</button></div>
      </div>` : html`<div class="mfix-do">
        ${moved ? null : html`<button type="button" class="bp-btn bp-btn--primary bp-btn--sm" disabled=${!!busy} onClick=${() => decide(true)}>${busy === 'make' ? 'Making it…' : same ? 'Mark it as made' : c.kind === 'other' ? 'I’ve made this change' : 'Make this change'}</button>`}
        <button type="button" class="bp-mini" ref=${keep} disabled=${!!busy} onClick=${() => setKeeping(true)}>Keep them as they are</button>
      </div>${moved ? html`<p class="mfix-note">The minutes changed there after this was suggested, so it can’t go over them. If it’s still right, change it in the notes.</p>` : same ? html`<p class="mfix-note">The minutes already say this.</p>` : inFile ? html`<p class="mfix-note">The minutes came from a file: this changes the page, and the file keeps its words.</p>` : c.kind === 'other' ? html`<p class="mfix-note">Change it in the notes first, then mark it made.</p>` : null}`
      : c.mine ? html`<div class="mfix-do"><button type="button" class="bp-mini" disabled=${!!busy} onClick=${takeBack}>${busy === 'back' ? 'Taking it back…' : 'Take it back'}</button></div>` : null}
  </div>`;
}

/**
 * What's been suggested about some of the minutes, and Suggest a correction. `target`: what it's about (`n:<id>`, `r`
 * for who was there, `general`). `was`: the words now. `readOnly`: a look at the page as someone else.
 */
export function Correct({ m, ctx, Icon, target, was = '', label = 'What needs correcting?', about = '', readOnly = false, offer = true, cue = 'Suggest a correction' }) {
  const { data, d } = ctx;
  const [open, setOpen] = useState(false);
  const opener = useRef(null);
  const kept = useRef(null);
  const kind = target === 'general' ? 'other' : target === 'r' ? 'roll' : 'words';
  // (a correction to something no longer on the meeting is still there to decide, under Anything else)
  const here = (c) => (c.kind === 'roll' ? (m.attendance || []).some((p) => p.key === c.target.slice(2)) : c.kind === 'other' || (m.sections || []).some((s) => s.id === c.target.slice(2) || s.items.some((it) => it.id === c.target.slice(2))));
  const mineHere = (c) => (target === 'general' ? c.target === 'general' || !here(c) : target === 'r' ? c.kind === 'roll' && here(c) : c.target === target);
  // (a look at the page as a member shows what a member sees: why something was kept is only for who suggested it and who decides)
  const list = correctionsOf(data, m.id).filter(mineHere).filter((c) => !(readOnly && c.state === 'declined'));
  const shut = !correctable(m) || readOnly || !(data.me.slug || data.me.admin);
  const decider = !readOnly && (d.me?.seat === 'secretary' || !!data.me.admin) && correctable(m);
  // (their own correction on these words is already waiting: changing it is taking it back and saying it again)
  const mineWaiting = kind === 'words' && list.some((c) => c.mine && c.state === 'waiting');
  if (!list.length && !open && (shut || !offer)) return null;
  const toOpener = () => requestAnimationFrame(() => opener.current?.focus({ preventScroll: true }));
  const close = () => { setOpen(false); toOpener(); };
  const sent = (id) => { kept.current = null; setOpen(false); if (id) focusOn(`c-${id}`); };
  return html`<div class="mfix bp-noprint">
    ${list.length ? html`<div class="mfix-list">${list.map((c) => html`<${Row} key=${c.id} c=${c} m=${m} ctx=${ctx} Icon=${Icon} decider=${decider} onBack=${toOpener} />`)}</div>` : null}
    ${open ? html`<${Box} m=${m} ctx=${ctx} target=${target} was=${was} label=${label} kind=${kind} kept=${kept} shut=${shut} onClose=${close} onSent=${sent} />`
      : shut || !offer || mineWaiting ? null : html`<button type="button" class="mfix-open" ref=${opener} aria-label=${about ? `${cue}: ${about}` : null} onClick=${() => setOpen(true)}><${Icon} name="edit" size=${14} />${cue}</button>`}
  </div>`;
}

/** The card beside draft minutes for whoever reads them: when the vote is, and what to do about something wrong */
export function ReadFirst({ m, ctx, readOnly = false }) {
  const { data } = ctx;
  // (the next one still to come: one held already isn't when the board votes on these)
  const next = data.meetings.filter((x) => x.date > m.date && x.date >= data.today).sort((a, b) => a.date.localeCompare(b.date))[0] || null;
  const written = (m.sections || []).some((s) => s.notes || s.items.some((it) => it.notes));
  return html`<div class="bp-minutes bp-noprint" role="group" aria-labelledby=${`rf-${m.id}`}>
    <p class="bp-minutes__q" id=${`rf-${m.id}`}>Read before the vote</p>
    <p class="bp-minutes__said">${next ? `The board votes on these at the ${meetingName(next)}, ${day(next.date)}.` : 'The board votes on these at its next meeting.'}${readOnly ? '' : written ? ' See something wrong? Suggest a correction right under it.' : ' See something wrong? Suggest a correction under Anything else, below.'}</p>
    <${Counts} m=${m} data=${data} />
  </div>`;
}

/** "1 correction waiting, 1 made", for the people reading them and for the agenda's vote on them */
export function Counts({ m, data }) {
  const all = correctionsOf(data, m.id);
  const waiting = all.filter((c) => c.state === 'waiting').length;
  const made = all.filter((c) => c.state === 'made').length;
  if (!waiting && !made) return null;
  return html`<p class="mfix-counts bp-noprint">${[waiting ? `${andCount(waiting, 'correction')} waiting` : '', made ? (waiting ? `${made} made` : `${andCount(made, 'correction')} made`) : ''].filter(Boolean).join(', ')}</p>`;
}

/** For who decides: what's waiting, and a way to it */
export function Waiting({ m, ctx }) {
  const list = toDecide(ctx.data, m.id);
  if (!list.length || !correctable(m)) return null;
  const go = () => { const el = document.getElementById(`c-${list[0].id}`); el?.scrollIntoView({ behavior: moves(), block: 'center' }); el?.focus({ preventScroll: true }); };
  return html`<p class="mfix-waiting bp-noprint"><span>${list.length === 1 ? 'A correction is waiting.' : `${list.length} corrections are waiting.`}</span><button type="button" class="bp-linkbtn" onClick=${go}>Read ${list.length === 1 ? 'it' : 'them'}</button></p>`;
}
