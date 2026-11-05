/**
 * The secretary's notes, typed on the board page itself
 * ===========================================================================
 * Peter, Nov 4 2026: "i see the board minutes can be printed, but can they be
 * kept digitally too? by the secretary?", "word file is a down load, i am
 * talking like right in the side type thing to keep notes".
 *
 * Beside the agenda (public/admin/board/notes.js) the secretary keeps what the
 * paper form and the Word file keep: who was there, notes under each item, how
 * each vote went, the action items, when it ended. It's a draft, one row per
 * meeting, the secretary's and Board's admins' alone: no board member sees a
 * word of it until it's sent.
 *
 * The draft is one flat map, each box its own key, so saving is only the boxes
 * (and only the fields of a vote) that changed, merged by SQLite in one
 * statement (json_patch). A phone and a laptop open at once can't undo each
 * other's different boxes. On any words (a row's too), a save says what it
 * started from: words someone else has saved since are never written over, they
 * come back as a clash for the person to choose.
 *   n:<item or part id>   the notes under it
 *   r:<person's key>      present | remote | excused | absent
 *   m:<item id or v_…>    a vote: { text, by, second, for, against, abstain, result }
 *   a:<a_…>               an action item: { text, owner, due }
 *   guests, adjourned
 *
 * "Send the minutes" (sendNotes) puts it on the meeting by exact id, with no
 * reading or guessing, and keeps a filled-in Word file as the minutes as
 * written. Every row typed lands on the meeting, and the words Board says back
 * count what did. Sending again replaces what the last send put there (`sent`
 * knows what that was), so a fix is a fix, never a second copy of a motion;
 * what a founder changed in Board since stays theirs, and is said.
 */

import { getMeeting, patchMeeting, saveMeeting, listMeetings, getSettings, approveMinutes, putFile, rewriteFile, deleteFile, roster, ID } from './_board.js';
import { mergeAttendance, minutesPeople } from './_board-minutes.js';
import { minutesDocx, minutesFileName, approveWords, noteLines } from '../../public/admin/board-minutes-template.js';
import { isDate, todayEastern, endedClock } from '../../public/admin/board-shared.js';

export const MAX_NOTE = 20000;
export const MAX_LINE = 1000;
const MAX_NAME = 120;
const MAX_KEYS = 300;
const MAX_ROW = 900000;
const ROLL = ['present', 'remote', 'excused', 'absent'];
const RESULTS = ['passed', 'failed', 'tabled'];
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

const no = (message, status) => Object.assign(new Error(message), { status });
// (a vertical tab or a form feed from a paste is a line break, never nothing: words on either side stay apart)
const words = (v, max) => String(v ?? '').replace(/\r\n?|[\u000B\u000C]/g, '\n').replace(/[\u0000-\u0008\u000E-\u001F]/g, '').slice(0, max);
const one = (v, max) => words(v, max).replace(/\s+/g, ' ').trim();
const parse = (s) => { try { const v = JSON.parse(s || '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; } };
const count = (v) => { const n = Math.floor(Number(v)); return v === '' || v == null || !Number.isFinite(n) || n < 0 ? '' : Math.min(n, 999); };
const asId = (s) => String(s).slice(0, 40);
const iso = (t) => new Date(t).toISOString();
const voteOf = (key) => (key.startsWith('v_') ? key : asId(`vn_${key}`));
// The boxes a save says what it started from: words, a person's mark, the time (a vote's result the same way)
const guarded = (key) => key === 'guests' || key === 'adjourned' || key[0] === 'n' || key[0] === 'r';
/** A note the same in what it says, whatever a person's list marks or the meeting's tidying made of its edges */
const sameNote = (a, b) => noteLines(a).join('\n') === noteLines(b).join('\n');
/** The same words, whatever the capitals and spaces */
const sameWords = (a, b) => one(a, MAX_LINE).toLowerCase() === one(b, MAX_LINE).toLowerCase();
const print = (x) => JSON.stringify([one(x.text, MAX_LINE), x.by || '', x.second || '', x.result || '', x.owner || '', x.due || '', x.tally?.for ?? x.for ?? '', x.tally?.against ?? x.against ?? '']);

/** The meeting, for the secretary's seat or one of Board's admins (who the board page offers it to) */
async function meetingFor(env, id, w) {
  if (!w?.admin && w?.member?.seat !== 'secretary') throw no('Only the board’s secretary keeps the minutes here', 403);
  if (!ID.test(String(id || ''))) throw no('Which meeting?', 400);
  const m = await getMeeting(env.DB, id);
  if (!m || m.practice || m.notBoard || !(m.shared || w.admin)) throw no('That meeting isn’t on the board page', 404);
  return m;
}
const rowOf = (DB, id) => DB.prepare('SELECT data, sent, updated_at, updated_by, took FROM board_minutes_notes WHERE meeting_id = ?').bind(id).first();
const checkinsOf = async (DB, id) => Object.fromEntries(((await DB.prepare('SELECT slug, how FROM board_checkins WHERE meeting_id = ?').bind(id).all()).results || []).map((c) => [c.slug, c.how]));

/** The meeting an agenda's "approve the minutes" item is about: the one it names, else the last one the board had */
function minutesTarget(m, meetings) {
  const it = (m.sections || []).flatMap((s) => s.items).find((x) => x.live === 'minutes');
  const named = it?.about ? meetings.find((x) => x.id === it.about) : null;
  return named || meetings.filter((x) => x.id !== m.id && x.shared && !x.notBoard && !x.practice && isDate(x.date) && x.date < m.date).sort((a, b) => b.date.localeCompare(a.date))[0] || null;
}

/** One box as it's kept: a key nobody's box has is refused, and an empty box is taken off (null). A vote or an action item is the fields that changed */
export function cleanChange(key, v) {
  const refused = () => { throw no('That didn’t look like the minutes', 400); };
  if (key !== 'guests' && key !== 'adjourned' && !/^(?:[nma]:[a-z0-9_]{3,40}|r:[^\u0000-\u001F]{1,210})$/i.test(key)) refused();
  if (v === null || v === undefined || v === '') return null;
  if (key === 'guests') { const t = words(v, MAX_LINE); return t.trim() ? t : null; }
  if (key === 'adjourned') return one(v, 20) || null;
  if (key[0] === 'n') { const t = words(v, MAX_NOTE); return t.trim() ? t : null; }
  if (key[0] === 'r') return ROLL.includes(v) ? v : refused();
  if (typeof v !== 'object' || Array.isArray(v)) refused();
  const out = {};
  const put = (f, x) => { if (f in v) out[f] = x === '' ? null : x; };
  if (key[0] === 'm') {
    put('text', words(v.text, MAX_LINE));
    put('by', words(v.by, MAX_NAME));
    put('second', words(v.second, MAX_NAME));
    for (const f of ['for', 'against', 'abstain']) put(f, count(v[f]));
    put('result', RESULTS.includes(v.result) ? v.result : '');
  } else {
    put('text', words(v.text, MAX_LINE));
    put('owner', /^[a-z0-9-]{1,80}$/.test(String(v.owner || '')) ? v.owner : '');
    put('ownerName', one(v.ownerName, MAX_NAME));
    put('due', isDate(v.due) ? v.due : '');
  }
  return out;
}

/** The items a send put words on (`on`) and those whose words have changed in Board since (`fixed`: Board's stand) */
function wordsOnMeeting(m, last) {
  const put = last.put || {};
  const left = last.left || null;
  const flat = (m.sections || []).flatMap((s) => s.items);
  return {
    on: flat.filter((it) => it.id in put && sameNote(it.notes, put[it.id])).map((it) => it.id),
    fixed: flat.filter((it) => (it.id in put ? !sameNote(it.notes, put[it.id]) : !!left && !sameNote(it.notes, left[it.id]))).map((it) => it.id),
  };
}

/**
 * GET ?notes=<meeting>: the draft, when it was last saved and last sent, who the meeting already has as there
 * (marked on it, or checked in on the board page), and (not `quick`) the vote the agenda's minutes item asks for
 */
export async function notesFor(env, id, w, { quick = false } = {}) {
  const m = await meetingFor(env, id, w);
  const [row, checkins] = await Promise.all([rowOf(env.DB, id), checkinsOf(env.DB, id)]);
  const roll = { ...checkins };
  for (const p of m.attendance) if (p.status) roll[p.key] = p.status;
  const last = parse(row?.sent);
  const out = { notes: parse(row?.data), at: row?.updated_at || '', sent: last.at || '', roll, meetingAt: m.updatedAt || '', ...wordsOnMeeting(m, last) };
  if (!quick) {
    const target = minutesTarget(m, (await listMeetings(env.DB)).filter((x) => !x.practice));
    out.approving = approveWords(target);
    // Its own notes typed and never sent: a passed vote on it closes them, so the send says so first
    out.approvingWaiting = !!target && (await notesWaiting(env.DB)).includes(target.id);
  }
  return out;
}

/**
 * POST { action: 'notes-save', meetingId, changes, was, wasText }: the boxes that changed, merged in one statement. `was`:
 * what each box of words started from; `wasText`: the same for a row's words. Words saved over it since by someone else
 * stay: → { at, clashes: [{ key, theirs, field }] } (`field: 'text'`: a row's words, and the whole row waits for the choice)
 */
export async function saveNotes(env, id, { changes, was = null, wasText = null } = {}, w, { now = Date.now() } = {}) {
  const m = await meetingFor(env, id, w);
  if (m.minutes === 'approved') throw no('These minutes are approved, so they can’t change here', 409);
  if (!changes || typeof changes !== 'object' || Array.isArray(changes)) throw no('What changed?', 400);
  const entries = Object.entries(changes);
  if (entries.length > MAX_KEYS) throw no('That’s too much to save at once', 413);
  const at = iso(now);
  if (!entries.length) return { at, clashes: [] };
  const patch = Object.fromEntries(entries.map(([k, v]) => [k, cleanChange(k, v)]));
  const clashes = [];
  const asked = (map) => !!map && typeof map === 'object' && entries.some(([k]) => k in map);
  if (asked(was) || asked(wasText)) {
    const cur = parse((await rowOf(env.DB, id))?.data);
    for (const [k] of entries) {
      if (asked(wasText) && k in wasText && patch[k] && 'text' in patch[k]) {
        const theirs = one(cur[k]?.text, MAX_LINE);
        if (![].concat(wasText[k]).map((x) => one(x, MAX_LINE)).includes(theirs) && theirs !== one(patch[k].text, MAX_LINE)) { clashes.push({ key: k, theirs: cur[k]?.text ?? '', field: 'text' }); delete patch[k]; continue; }
      }
      if (!asked(was) || !(k in was)) continue;
      // What it started from, and what it tried to save with no answer back (the server may well have it)
      const started = [].concat(was[k]);
      if (guarded(k)) {
        const theirs = cur[k] ?? '';
        if (!started.map((x) => cleanChange(k, x) ?? '').includes(theirs) && theirs !== (patch[k] ?? '')) { clashes.push({ key: k, theirs }); delete patch[k]; }
      } else if (k[0] === 'm' && patch[k] && 'result' in patch[k]) {
        const theirs = cur[k]?.result ?? '';
        if (!started.map((x) => String(x ?? '')).includes(theirs) && theirs !== (patch[k].result ?? '')) { clashes.push({ key: k, theirs }); delete patch[k].result; }
      }
    }
  }
  if (!Object.keys(patch).length) return { at, clashes };
  const json = JSON.stringify(patch);
  if (json.length > MAX_ROW) throw no('That’s too much to save at once', 413);
  const by = w.member?.email || w.adminEmail || '';
  // The secretary's name, the first time they type: it's who took these minutes, whoever saved last, or sits in that seat later
  const took = w.member?.seat === 'secretary' ? w.member.name || '' : '';
  const r = await env.DB.prepare(`INSERT INTO board_minutes_notes (meeting_id, data, updated_at, updated_by, took) VALUES (?1, json_patch('{}', ?2), ?3, ?4, NULLIF(?6, ''))
    ON CONFLICT(meeting_id) DO UPDATE SET data = json_patch(data, ?2), updated_at = ?3, updated_by = ?4, took = COALESCE(took, NULLIF(?6, '')) WHERE length(data) + length(?2) < ?5`).bind(id, json, at, by, MAX_ROW, took).run();
  if (!((r?.meta?.changes ?? r?.changes ?? 0) > 0)) throw no('These notes have grown too long to keep here. Send what you have, then keep going in a Word file.', 413);
  return { at, clashes };
}

const said = (v) => (typeof v === 'string' ? words(v, MAX_NOTE).trim() : '');
/** Guests, one to a line ("Dr. Pat Ames, CPA" is one person) */
const guestsIn = (s) => String(s || '').split(/[;\n]+/).map((x) => one(x, MAX_NAME)).filter(Boolean);
const keysWith = (notes, kind) => Object.keys(notes).filter((k) => k.startsWith(`${kind}:`));

/**
 * What the draft puts on the meeting (pure). `sent`: what the last send put there, taken back first. Whatever's been
 * changed or deleted in Board since stays as Board has it, this send and the ones after, and `kept` counts where the
 * draft says otherwise. `target`: the meeting the agenda's minutes vote is about. `checkins`: slug → how they checked
 * in on the board page.
 *   Notes go on their item by id.
 *   The roll: what the secretary marked, over what the meeting had, and who checked in. With anyone there, the board
 *     nobody marked weren't. With nobody marked and nobody checked in, the attendance is left alone.
 *   Each vote with a result is a motion, each action item with words is one: all of them, none folded into another.
 *     One with the very words of a motion already on the meeting is that motion (who moved it filled in), and a vote
 *     taken on the board page keeps its own result.
 *   `approves`: a passed vote on the agenda's minutes item, and only that, approves the meeting it's about.
 * → { next, sent, approves, kept, read, record }
 */
export function applyNotes(cur, notes, { sent = null, people = [], target = null, checkins = {}, taker = '', fileName = '', now = Date.now() } = {}) {
  const was = sent || {};
  const at = iso(now);
  let kept = 0;

  const anything = anythingIn(notes);
  // The notes, and the words each item had before notes went on it (an item's notes taken out give them back). What's
  // noted about a part itself is the part's own
  const had = { ...(was.items || {}) };
  const lastPut = was.put || {};
  const put = {};
  const shown = {};
  // What each item the last send left alone had under it: words that differ now went on in Board since
  const lastLeft = was.left || null;
  const left = {};
  const lastParts = was.parts || null;
  const parts = {};
  const flat = (cur.sections || []).flatMap((s) => s.items);
  const sections = (cur.sections || []).map((s) => {
    const items = s.items.map((it) => {
      const text = said(notes[`n:${it.id}`]);
      if (it.id in lastPut && !sameNote(it.notes, lastPut[it.id])) {
        put[it.id] = lastPut[it.id];
        shown[it.id] = it.notes || '';
        if (!sameNote(text, it.notes)) kept += 1;
        return it;
      }
      if (lastLeft && !(it.id in lastPut) && !sameNote(it.notes, lastLeft[it.id])) {
        left[it.id] = lastLeft[it.id] ?? '';
        shown[it.id] = it.notes || '';
        if (text && !sameNote(text, it.notes)) kept += 1;
        return it;
      }
      if (text) { if (!(it.id in had)) had[it.id] = it.notes || ''; put[it.id] = text; shown[it.id] = text; return { ...it, notes: text }; }
      if (it.id in had) { const back = had[it.id]; delete had[it.id]; left[it.id] = back; return { ...it, notes: back }; }
      left[it.id] = it.notes || '';
      return it;
    });
    const part = said(notes[`n:${s.id}`]);
    // A part's own notes changed since the last send (a founder's Word file): theirs stand, the same as an item's
    if (lastParts && !sameNote(s.notes, lastParts[s.id])) {
      parts[s.id] = lastParts[s.id] ?? '';
      if (s.notes) shown[s.id] = s.notes;
      if (part && !sameNote(part, s.notes)) kept += 1;
      return { ...s, items };
    }
    if (part) shown[s.id] = part;
    parts[s.id] = part;
    return { ...s, items, notes: part };
  });

  // Who was there: everyone on the meeting (the board as People has it when it has no list), as it was before the last send
  const noList = !(cur.attendance || []).some((p) => p.kind === 'board');
  const everyone = noList ? [...(cur.attendance || []), ...people.filter((p) => p.kind === 'board').map((p) => ({ key: p.slug, slug: p.slug, name: p.name, org: p.org || '', kind: 'board', status: '', rsvp: '' }))] : cur.attendance || [];
  const lastExtra = new Set(was.extra || []);
  const lastRollWas = was.rollWas || {};
  const lastRollPut = was.rollPut || {};
  const inBoard = new Set();
  const list = everyone.filter((p) => !lastExtra.has(p.key)).map((p) => {
    if (!(p.key in lastRollWas)) return p;
    if ((p.status || '') !== (lastRollPut[p.key] ?? '')) { inBoard.add(p.key); return p; }
    return { ...p, status: lastRollWas[p.key] };
  });
  // (everything cleared and sent takes the last send back, marks with it)
  const marked = new Map(anything ? keysWith(notes, 'r').map((k) => [k.slice(2), notes[k]]).filter(([, s]) => ROLL.includes(s)) : []);
  // A guest typed who's on the roll is that person, there
  const guests = [];
  for (const g of guestsIn(notes.guests)) {
    const p = list.find((x) => x.name.toLowerCase() === g.toLowerCase()) || people.find((x) => x.name.toLowerCase() === g.toLowerCase());
    if (!p) { if (!guests.some((x) => x.toLowerCase() === g.toLowerCase())) guests.push(g); continue; }
    if (!marked.has(p.key || p.slug)) marked.set(p.key || p.slug, 'present');
  }
  // Whoever took the minutes was there, unless they said otherwise. Settled by the first send: a correction never changes it.
  // (with nobody at all marked or checked in, the list is left as it is, the person keeping it with the rest)
  const keeperKey = was.at ? was.keeper || '' : list.find((p) => p.name === taker)?.key || '';
  const keeper = keeperKey && (marked.size > 0 || list.some((p) => p.status || checkins[p.slug])) ? list.find((p) => p.key === keeperKey) : null;
  if (keeper && !marked.has(keeper.key) && !keeper.status) marked.set(keeper.key, 'present');
  // Corrected in Board since: what Board has stands
  for (const key of inBoard) {
    const p = list.find((x) => x.key === key);
    if (marked.has(key) && marked.get(key) !== (p?.status || '')) kept += 1;
    marked.delete(key);
  }
  const person = (p, status) => ({ ...(p.slug ? { slug: p.slug } : {}), name: p.name, org: p.org || '', kind: ['staff', 'guest'].includes(p.kind) ? p.kind : 'board', status });
  const read = [];
  for (const p of list) { const status = marked.get(p.key) || p.status || checkins[p.slug] || ''; if (status) read.push(person(p, status)); }
  for (const [key, status] of marked) { if (list.some((x) => x.key === key)) continue; const p = people.find((x) => x.slug === key); if (p) read.push(person(p, status)); }
  const touched = marked.size > 0 || list.some((p) => !p.status && checkins[p.slug]);
  const merged = touched ? mergeAttendance({ ...cur, attendance: list }, { attendance: read }, { keepMarked: false }) : list;
  const attendance = [...merged, ...guests.filter((name) => !merged.some((p) => p.key === `guest:${name.toLowerCase()}`)).map((name) => ({ key: `guest:${name.toLowerCase()}`, name, org: '', kind: 'guest', status: 'present', rsvp: '' }))];
  const rollWas = {};
  const rollPut = {};
  for (const p of list) {
    const after = attendance.find((x) => x.key === p.key);
    if (inBoard.has(p.key)) { rollWas[p.key] = lastRollWas[p.key]; rollPut[p.key] = lastRollPut[p.key]; } else if (after && (after.status || '') !== (p.status || '')) { rollWas[p.key] = p.status || ''; rollPut[p.key] = after.status || ''; }
  }

  // The votes. Each row this draft put on stays known as its own, whatever becomes of it in Board
  const items = new Map(flat.map((it) => [it.id, it]));
  const textOf = (id, v) => { const it = items.get(id); return it?.live === 'minutes' ? approveWords(target) : one(it?.motion, MAX_LINE) || one(v?.text, MAX_LINE); };
  const wrote = keysWith(notes, 'm').map((k) => [k.slice(2), notes[k]]);
  const typedIds = new Set(wrote.map(([id]) => voteOf(id)));
  const ours = new Set(was.motions || []);
  const prints = was.votePrints || {};
  const editedVote = (x) => ours.has(x.id) && prints[x.id] !== print(x);
  const motions = (cur.motions || []).filter((x) => (ours.has(x.id) ? editedVote(x) : !typedIds.has(x.id)));
  const before = [...motions];
  const onMeeting = new Set((cur.motions || []).map((x) => x.id));
  const sentVotes = [];
  const votePrints = {};
  for (const [id, v] of wrote) {
    const text = textOf(id, v);
    const rowId = voteOf(id);
    const same = before.find((y) => y.id !== rowId && sameWords(y.text, text));
    // (a vote the board took keeps its result; so does one the notes only name who moved)
    const taken = same && (same.tally?.at || id.startsWith('t_')) ? same : null;
    if (!text || (!RESULTS.includes(v?.result) && !taken)) continue;
    const tallied = [v.for, v.against, v.abstain].some((n) => typeof n === 'number');
    const x = { id: rowId, text, by: one(v.by, MAX_NAME), second: one(v.second, MAX_NAME), result: v.result, voice: false, tally: tallied ? { for: Number(v.for) || 0, against: Number(v.against) || 0, abstain: Number(v.abstain) || 0, of: 0, at: '' } : null };
    // Changed or deleted in Board since it went on: as Board has it, and it stays known as this draft's
    if (ours.has(rowId) && (!onMeeting.has(rowId) || motions.some((y) => y.id === rowId))) {
      const row = motions.find((y) => y.id === rowId);
      sentVotes.push(rowId);
      votePrints[rowId] = prints[rowId];
      if (!row || print(row) !== print(x)) kept += 1;
      continue;
    }
    if (same) {
      // Already on the meeting: that motion, who moved it filled in. The board page's own vote keeps its result
      motions[motions.indexOf(same)] = { ...same, by: x.by || same.by, second: x.second || same.second, ...(taken ? {} : { result: x.result, tally: x.tally || same.tally }) };
      continue;
    }
    motions.push(x);
    sentVotes.push(rowId);
    votePrints[rowId] = print(x);
  }

  // The record says what the meeting says: each agenda vote under its item, every other motion after, however it came to be there
  const onRecord = (row) => ({ ...row, for: row.tally?.for, against: row.tally?.against, abstain: row.tally?.abstain });
  const votes = {};
  const placed = new Set();
  for (const it of flat) {
    const text = it.live === 'minutes' ? approveWords(target) : one(it.motion, MAX_LINE);
    if (!text) continue;
    const row = motions.find((y) => y.id === voteOf(it.id)) || motions.find((y) => sameWords(y.text, text));
    if (row && !placed.has(row.id)) { votes[it.id] = onRecord(row); placed.add(row.id); }
  }
  const floor = motions.filter((x) => !placed.has(x.id)).map(onRecord);

  // The action items, the same way
  const ownerOf = (v) => {
    const p = people.find((x) => x.slug === v.owner) || list.find((x) => x.slug === v.owner);
    return { owner: p?.slug || (v.ownerName ? v.owner || '' : ''), ownerName: p?.name || one(v.ownerName, MAX_NAME) };
  };
  const wroteActions = keysWith(notes, 'a').map((k) => [k.slice(2), notes[k]]).filter(([, v]) => one(v?.text, MAX_LINE));
  const actionIds = new Set(wroteActions.map(([id]) => id));
  const oursA = new Set(was.actions || []);
  const printsA = was.actionPrints || {};
  const editedAction = (x) => oursA.has(x.id) && printsA[x.id] !== print(x);
  const actions = (cur.actions || []).filter((x) => (oursA.has(x.id) ? editedAction(x) : !actionIds.has(x.id)));
  const beforeA = [...actions];
  const onMeetingA = new Set((cur.actions || []).map((x) => x.id));
  const sentActions = [];
  const actionPrints = {};
  for (const [id, v] of wroteActions) {
    const x = { id, text: one(v.text, MAX_LINE), ...ownerOf(v), due: isDate(v.due) ? v.due : '', done: false, doneOn: '' };
    if (oursA.has(id) && (!onMeetingA.has(id) || actions.some((y) => y.id === id))) {
      const row = actions.find((y) => y.id === id);
      sentActions.push(id);
      actionPrints[id] = printsA[id];
      if (!row || print(row) !== print(x)) kept += 1;
      continue;
    }
    if (beforeA.some((y) => y.id !== id && sameWords(y.text, x.text))) continue;
    actions.push(x);
    sentActions.push(id);
    actionPrints[id] = print(x);
  }

  const minutesItem = flat.find((it) => it.live === 'minutes');
  const fromBefore = 'fromBefore' in was ? was.fromBefore : cur.minutesFrom || null;
  return {
    // (`ai`: nothing to read again: the heartbeat goes back only to minutes the model hasn't read, and these were never read)
    next: { ...cur, sections, attendance, motions, actions, minutesFrom: anything ? { name: one(fileName, 200), at, ai: true, tries: 0, typed: true } : fromBefore },
    sent: {
      at, items: had, put, left, parts, rollWas, rollPut, fromBefore, keeper: keeperKey,
      // Everyone this draft added to the meeting's list, guests or not
      extra: attendance.filter((x) => !list.some((p) => p.key === x.key)).map((x) => x.key),
      motions: sentVotes, votePrints, actions: sentActions, actionPrints,
    },
    approves: target && minutesItem && votes[minutesItem.id]?.result === 'passed' ? target.id : '',
    kept,
    read: { notes: Object.keys(shown).length, motions: motions.length, actions: actions.length },
    // What the Word file says: the same as the meeting, never what was only typed
    record: {
      words: shown, votes, floor, adjourned: notes.adjourned || endedClock(cur),
      guests: attendance.filter((p) => p.kind === 'guest' && (p.status === 'present' || p.status === 'remote')).map((p) => p.name),
      actions: actions.map((a) => ({ text: a.text, who: a.ownerName || '', due: a.due || '' })),
    },
  };
}

/** Whether there's anything in the draft to send: a box filled in, a person marked, a vote or an action item */
export const anythingIn = (notes) => Object.entries(notes).some(([k, v]) => {
  if (k === 'guests') return true;
  if (k[1] !== ':') return false;
  if (k[0] === 'm') return !!v?.result;
  if (k[0] === 'a') return !!one(v?.text, MAX_LINE);
  return k[0] === 'r' ? v !== 'absent' : true;
});

/** Anything at all typed in a box, whether or not it can go in yet */
const typedIn = (notes) => Object.values(notes).some((v) => (v && typeof v === 'object' ? Object.values(v).some((x) => x !== null && x !== '') : !!v && v !== 'absent'));

/** The meetings with notes typed that never went on them (for the secretary, the admins, and Board's approve) */
export async function notesWaiting(DB) {
  const rows = (await DB.prepare('SELECT meeting_id, data, sent, updated_at FROM board_minutes_notes').all()).results || [];
  return rows.filter((r) => { const sentAt = parse(r.sent).at; return typedIn(parse(r.data)) && (!sentAt || (r.updated_at || '') > sentAt); }).map((r) => r.meeting_id);
}

/**
 * POST { action: 'notes-send', meetingId }: the draft on the meeting, and a filled-in Word file kept as the minutes as
 * written (made first: when storage fails, nothing has changed and they can send again). As secretarySends, only on
 * the meeting's day or after, and a board member gets back what went in, never the meeting as Board keeps it. Sent
 * empty after an earlier send, it takes that send back off the meeting. Only one send of a meeting's notes at a time.
 * → { read: { attendance, notes, motions, actions, ai }, approvedPrev, sent, kept, cleared }
 */
export async function sendNotes(env, id, w, { now = Date.now() } = {}) {
  const m = await meetingFor(env, id, w);
  // (a meeting the chair ended ahead of its date has been held)
  if (!isDate(m.date) || (m.date > todayEastern(now) && !m.live?.endedAt)) throw no('The minutes come in on the day of the meeting or after', 400);
  if (m.minutes === 'approved') throw no('These minutes are approved, so they can’t change here', 409);
  const row = await rowOf(env.DB, id);
  const notes = parse(row?.data);
  const lastSent = parse(row?.sent);
  const anything = anythingIn(notes);
  if (!anything && !lastSent.at) throw no('Nothing is typed yet', 400);
  const claim = await env.DB.prepare('UPDATE board_minutes_notes SET sending = ?1 WHERE meeting_id = ?2 AND (sending IS NULL OR sending < ?3)').bind(iso(now), id, iso(now - 60000)).run();
  if (!((claim?.meta?.changes ?? claim?.changes ?? 0) > 0)) throw no('These are being sent right now. Give it a moment.', 409);
  let fileId = '';
  try {
    const [people, meetings, settings, seats, checkins] = await Promise.all([minutesPeople(env.DB), listMeetings(env.DB), getSettings(env.DB), roster(env.DB, { withEmails: true }), checkinsOf(env.DB, id)]);
    const target = minutesTarget(m, meetings.filter((x) => !x.practice));
    const by = w.member?.email || w.adminEmail || '';
    const fileName = minutesFileName(m);
    // Who took them is settled by the first send: fixing a word later, in whoever's hands, doesn't change it
    const taker = lastSent.at ? lastSent.taker || '' : row.took || '';
    const opts = { sent: lastSent, people, target, checkins, taker, fileName, now };
    let tookBy = '';
    if (anything) {
      const seen = applyNotes(m, notes, opts);
      // The secretary, once they've typed anything; else whoever kept them, who isn't always who pressed Send
      const typedBy = [...seats.board, ...seats.staff].find((p) => p.email && String(p.email).toLowerCase() === String(row.updated_by || '').toLowerCase());
      tookBy = 'by' in lastSent ? lastSent.by : row.took || typedBy?.name || w.member?.name || '';
      const bytes = minutesDocx(seen.next, { meetings, quorum: settings.quorum, people, filled: { ...seen.record, by: tookBy } });
      // (a founder made the last one staff-only: this one stays that way)
      const staffOnly = !!m.files.find((f) => f.id === lastSent.fileId)?.staffOnly;
      fileId = (await putFile(env, { ownerType: 'meeting', ownerId: id, file: new File([bytes], fileName, { type: DOCX }), kind: 'minutes', by, staffOnly })).id;
    }
    let done = null;
    const meeting = await patchMeeting(env.DB, id, (cur) => { done = applyNotes(cur, notes, opts); return done.next; }, { by });
    if (!meeting) throw no('That meeting is gone', 404);

    // The approval follows the vote: passed approves the meeting it's about, and a vote corrected takes back the approval this made
    let approved = '';
    let undone = 0;
    let withdrawn = false;
    if (done.approves) {
      const t = meetings.find((x) => x.id === done.approves);
      // Approved by the last send and put back to draft in Board since: Board's word stands, and is said
      if (lastSent.approved === done.approves) { approved = done.approves; if (t?.minutes !== 'approved') undone = 1; } else if (t && t.minutes !== 'approved') { await approveMinutes(env, t.id, { on: m.date, by }); approved = t.id; }
    }
    if (lastSent.approved && lastSent.approved !== approved) {
      const t = await getMeeting(env.DB, lastSent.approved);
      if (t?.minutes === 'approved') { await saveMeeting(env.DB, { ...t, minutes: 'draft', approvedOn: '' }, { by }); withdrawn = true; }
    }

    // (what was sent, to bring the kept Word file up to a founder's fixes without what's only typed since)
    const keeps = anything ? JSON.stringify({ ...done.sent, fileId, approved, taker, by: tookBy, notes }) : null;
    await env.DB.prepare('UPDATE board_minutes_notes SET sent = ? WHERE meeting_id = ?').bind(keeps, id).run();
    fileId = '';
    // The Word file the last send kept: this one takes its place
    if (lastSent.fileId) await deleteFile(env, lastSent.fileId).catch(() => {});
    const board = meeting.attendance.filter((p) => p.kind === 'board');
    return {
      sent: anything ? done.sent.at : '',
      cleared: !anything,
      approvedPrev: !!approved && approved !== lastSent.approved,
      withdrawn,
      kept: done.kept + undone,
      read: {
        attendance: { here: board.filter((p) => p.status === 'present' || p.status === 'remote').length, of: board.length },
        ...done.read, ai: false,
      },
    };
  } catch (err) {
    // Nothing went on the meeting: the Word file made for it goes too
    if (fileId) await deleteFile(env, fileId).catch(() => {});
    throw err;
  } finally {
    await env.DB.prepare('UPDATE board_minutes_notes SET sending = NULL WHERE meeting_id = ?').bind(id).run();
  }
}

/**
 * The Word file a send kept, brought up to what the meeting says now: a founder's fix in Board goes in by itself, the same
 * file in the same place, and only what was sent counts (never what's typed since). Called after Board saves.
 */
export async function refreshMinutesFile(env, id, { now = Date.now() } = {}) {
  const last = parse((await env.DB.prepare('SELECT sent FROM board_minutes_notes WHERE meeting_id = ?').bind(id).first())?.sent);
  if (!last.fileId || !last.notes) return false;
  const m = await getMeeting(env.DB, id);
  if (!m?.minutesFrom?.typed || !m.files.some((f) => f.id === last.fileId)) return false;
  const [people, meetings, settings, checkins] = await Promise.all([minutesPeople(env.DB), listMeetings(env.DB), getSettings(env.DB), checkinsOf(env.DB, id)]);
  const seen = applyNotes(m, last.notes, { sent: last, people, target: minutesTarget(m, meetings.filter((x) => !x.practice)), checkins, taker: last.taker || '', fileName: m.minutesFrom.name, now });
  return rewriteFile(env, last.fileId, minutesDocx(seen.next, { meetings, quorum: settings.quorum, people, filled: { ...seen.record, by: last.by || '' } }));
}
