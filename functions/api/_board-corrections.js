/**
 * Corrections to the minutes, suggested on the board page
 * ===========================================================================
 * Peter, Nov 6 2026: "yes i want this best in class". The board reads the draft
 * before it votes on it, and until now a correction meant replying to an email.
 *
 * A member suggests new words under the item they're about (or marks who was
 * there, or says anything else), and the whole board sees it, so nobody suggests
 * it twice. The secretary or a founder makes it in one press, or keeps the minutes
 * as they are and may say why. Nobody retypes anything, and the page says it was
 * corrected and who suggested it. Nothing here changes the minutes until someone
 * decides.
 *
 * A correction writes one box and nothing else, and never runs a send: a send goes over
 * the whole meeting, so it can wake words held back from an earlier send, change another
 * meeting's approval, or carry what's typed and unsent. It goes on the meeting, its box in
 * the notes says the same, what the last send kept records it just as a send would have,
 * and the Word file is rewritten from what the meeting now says. One at a time with any
 * send (the same claim), and safe to press again if it stopped partway.
 *
 * board_minutes_corrections, one row a correction:
 *   target   n:<item or part id> | r:<person's key> | general
 *   kind     words (`words`: all the new words) | roll (`words`: present, remote, excused, absent) | other (anything else)
 *   was      what it said when suggested: changed since, it's not made over the change
 *   state    waiting → made | declined | withdrawn (making: claimed, for the moment it's being made)
 */

import { getMeeting, listMeetings, patchMeeting, roster, getSettings, ensureSchema, ID, SITE } from './_board.js';
import { refreshMinutesFile, claimSending, releaseSending, boxPath, withBox, anythingIn } from './_board-notes.js';
import { minutesIn, meetingName, uid } from '../../public/admin/board-shared.js';
import { noteLines } from '../../public/admin/board-minutes-template.js';
import { limit } from './_rate-limit.js';
import { sendEmailOne, emailConfigured, EMAIL_FROM } from './_broadcast-notify.js';
import { emailShell, button, esc } from './_email-shell.js';

const ROLL = ['present', 'remote', 'excused', 'absent'];
const MAX_WORDS = 20000;
const MAKING_MS = 2 * 60 * 1000;
const HOW = { present: 'here', remote: 'on video', excused: 'excused', absent: 'not there' };

const no = (message, status, extra) => Object.assign(new Error(message), { status, ...(extra ? { extra } : {}) });
const iso = (t) => new Date(t).toISOString();
const parse = (s) => { try { const v = JSON.parse(s || '{}'); return v && typeof v === 'object' ? v : {}; } catch { return {}; } };
const cleanWords = (v) => String(v ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, MAX_WORDS);
const sameNote = (a, b) => noteLines(a).join('\n') === noteLines(b).join('\n');
/** Who decides: the secretary's seat, or one of Board's admins, the same people who keep the notes */
export const canDecide = (w) => !!w?.admin || w?.member?.seat === 'secretary';

/** What a target is on this meeting now → { kind, where, now, secret, person } | null (it isn't there any more) */
export function targetOf(m, target) {
  const t = String(target || '');
  if (t === 'general') return { kind: 'other', where: '', now: '', secret: false };
  if (t.startsWith('r:')) {
    // (the board and staff: a guest is a line of the notes, not someone on the roll)
    const p = (m.attendance || []).find((x) => x.key === t.slice(2) && x.kind !== 'guest');
    return p ? { kind: 'roll', where: `who was there (${p.name})`, now: p.status || '', secret: false, person: p } : null;
  }
  if (!t.startsWith('n:')) return null;
  const id = t.slice(2);
  for (const s of m.sections || []) {
    if (s.id === id) return { kind: 'words', where: s.title || 'the meeting', now: s.notes || '', secret: s.items.some((it) => it.confidential) };
    const it = s.items.find((x) => x.id === id);
    if (it) return { kind: 'words', where: it.title || s.title || 'an item', now: it.notes || '', secret: !!it.confidential };
  }
  return null;
}

/** Whether the meeting says what the correction says */
const holds = (m, c) => { const t = targetOf(m, c.target); return !!t && (c.kind === 'roll' ? (t.now || '') === c.words : sameNote(t.now, c.words)); };
/** The meeting with the correction on it (typed minutes say when they last changed; when they first went in stays) */
function withCorrection(m, c, now) {
  const key = c.target.slice(2);
  const from = m.minutesFrom?.typed ? { minutesFrom: { ...m.minutesFrom, first: m.minutesFrom.first || m.minutesFrom.at, at: iso(now) } } : {};
  if (c.kind === 'roll') return { ...m, ...from, attendance: m.attendance.map((p) => (p.key === key ? { ...p, status: c.words } : p)) };
  return { ...m, ...from, sections: m.sections.map((s) => (s.id === key ? { ...s, notes: c.words } : { ...s, items: s.items.map((it) => (it.id === key ? { ...it, notes: c.words } : it)) })) };
}

/** Who's writing: a member, or a founder or staff member looking at the page */
async function authorOf(env, w) {
  if (w?.member) return { slug: w.member.slug, name: w.member.name, email: w.member.email || '' };
  if (!w?.admin) throw no('The board page is for SOARD’s board members', 403);
  const email = String(w.adminEmail || '').toLowerCase();
  const staff = (await roster(env.DB)).staff.find((p) => email.startsWith(`${String(p.name).split(/\s+/)[0].toLowerCase()}@`));
  return { slug: staff?.slug || email, name: staff?.name || email, email };
}

/**
 * The corrections as a person's board page shows them: a decline is for who suggested it and who decides; one taken back
 * is nobody's; a member sees only meetings on the board page, since these carry the minutes' words. One nobody decided
 * before the board approved the minutes is `closed` (back to waiting if they go back to draft). → { meetingId: [...] }
 */
export async function correctionsForPage(DB, w, meetings = null) {
  await ensureSchema(DB);
  const rows = (await DB.prepare("SELECT * FROM board_minutes_corrections WHERE state != 'withdrawn' ORDER BY at").all()).results || [];
  if (!rows.length) return {};
  const on = new Map((meetings || await listMeetings(DB)).map((m) => [m.id, m]));
  const decider = canDecide(w);
  const me = w?.member?.slug || '';
  const email = String(w?.adminEmail || '').toLowerCase();
  const out = {};
  for (const r of rows) {
    const m = on.get(r.meeting_id);
    if (!m || (!w?.admin && (!m.shared || m.notBoard))) continue;
    const mine = !!me && r.by_slug === me || (!!email && String(r.by_email || '').toLowerCase() === email);
    if (r.state === 'declined' && !decider && !mine) continue;
    const open = r.state === 'waiting' || r.state === 'making';
    (out[r.meeting_id] ||= []).push({
      id: r.id, target: r.target, kind: r.kind, was: r.was || '', words: r.words || '', by: r.by_name || '', mine, at: r.at,
      state: open ? (m.minutes === 'approved' ? 'closed' : 'waiting') : r.state, decidedBy: r.decided_by || '', decidedAt: r.decided_at || '', ...(r.state === 'declined' ? { reason: r.reason || '' } : {}),
    });
  }
  return out;
}

/** How many wait on one meeting */
export async function waitingOn(DB, id) {
  const r = await DB.prepare("SELECT count(*) AS n FROM board_minutes_corrections WHERE meeting_id = ? AND state IN ('waiting', 'making')").bind(id).first();
  return Number(r?.n) || 0;
}

/**
 * POST { action: 'correction', meetingId, target, words, was }: a correction, while the minutes are in, on the board page
 * and not approved. Their own waiting one on the same words is replaced. `was`: what their page showed (changed since:
 * 409 { changed }). → { correction }
 */
export async function suggestCorrection(env, { meetingId, target, words, was = null } = {}, w, { now = Date.now(), waitUntil = null } = {}) {
  await ensureSchema(env.DB);
  const id = String(meetingId || '');
  if (!ID.test(id)) throw no('Which meeting?', 400);
  const m = await getMeeting(env.DB, id);
  if (!m || m.practice || m.notBoard || !m.shared) throw no('That meeting isn’t on the board page', 404);
  if (m.minutes === 'approved') throw no('These minutes are approved, so they can’t change here', 409);
  if (!minutesIn(m)) throw no('The minutes aren’t in yet', 409);
  const t = targetOf(m, target);
  if (!t) throw no('That part of the minutes has changed. Reload the page.', 409, { reload: true });
  const me = await authorOf(env, w);
  const rl = await limit(env.DB, `board-correct:${me.slug}`, 30, 3600, { now });
  if (!rl.ok) throw no('That’s a lot of corrections at once. Try again in a while.', 429);
  const said = cleanWords(words);
  if (t.kind === 'words') {
    if (was === null) throw no('Reload the page, then suggest your correction.', 409, { reload: true });
    if (!sameNote(was, t.now)) throw no('These words changed while you had them open. Read them again, then suggest your correction.', 409, { changed: true });
    if (sameNote(said, t.now)) throw no('That’s what it says now. Change the words first.', 400);
  } else if (t.kind === 'roll') {
    // (the page offers this only once someone's marked as there: with nobody yet, one mark changes everyone at the next send)
    if (!m.attendance.some((p) => p.status === 'present' || p.status === 'remote')) throw no('Nobody is marked as there yet.', 409);
    if (!ROLL.includes(said)) throw no('Here, on video, excused or not there?', 400);
    if (said === (t.now || 'absent')) throw no('That’s what it says now.', 400);
  } else if (said.length < 3) throw no('What needs correcting?', 400);

  const at = iso(now);
  const before = t.kind === 'other' ? '' : t.now;
  // (saying it again in other words: theirs is replaced, never a second one to decide)
  const had = t.kind === 'other' ? null : await env.DB.prepare("SELECT id FROM board_minutes_corrections WHERE meeting_id = ? AND target = ? AND by_slug = ? AND state = 'waiting'").bind(id, String(target), me.slug).first();
  const cid = had?.id || uid('c_');
  if (had) await env.DB.prepare('UPDATE board_minutes_corrections SET was = ?, words = ?, at = ? WHERE id = ?').bind(before, said, at, cid).run();
  else await env.DB.prepare('INSERT INTO board_minutes_corrections (id, meeting_id, target, kind, was, words, by_slug, by_name, by_email, at, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(cid, id, String(target), t.kind, before, said, me.slug, me.name, me.email, at, 'waiting').run();
  // (a word changed in one already sent isn't news: the email said to open the page)
  if (!had) {
    const told = tellSecretary(env, m, { by: me, t }).catch((err) => console.error('[board] correction email', err?.message || err));
    if (waitUntil) waitUntil(told); else await told;
  }
  return { correction: { id: cid, target: String(target), kind: t.kind, was: before, words: said, by: me.name, mine: true, at, state: 'waiting', decidedBy: '', decidedAt: '' } };
}

/** POST { action: 'correction-withdraw', id }: theirs, while it's waiting */
export async function withdrawCorrection(env, id, w) {
  await ensureSchema(env.DB);
  const me = await authorOf(env, w);
  const r = await env.DB.prepare("UPDATE board_minutes_corrections SET state = 'withdrawn' WHERE id = ? AND by_slug = ? AND state = 'waiting'").bind(String(id || ''), me.slug).run();
  if (!((r?.meta?.changes ?? r?.changes ?? 0) > 0)) {
    // (already taken back, in another tab: that's what they asked for)
    const c = await env.DB.prepare('SELECT state FROM board_minutes_corrections WHERE id = ? AND by_slug = ?').bind(String(id || ''), me.slug).first();
    if (c?.state !== 'withdrawn') throw no('That correction has already been decided', 409, { reload: true });
  }
  return { id: String(id) };
}

/** A box of the notes as words, empty or not */
const boxOf = (notes, key) => { const v = notes?.[key]; return v === undefined || v === null ? '' : String(v); };

const STALE = 'The minutes changed there after this was suggested, so it can’t go over them. Read them, then change them in the notes or keep them as they are.';
/** Whether the meeting no longer says what the correction was suggested against */
const changedSince = (m, c) => { const t = targetOf(m, c.target); return !t || (c.kind === 'roll' ? (t.now || '') !== (c.was || '') : !sameNote(t.now, c.was)); };

/** A draft's words, for telling whether anything in it is still to send */
const typedOf = (x) => JSON.stringify(Object.entries(x).filter(([k]) => k !== 'skipped').sort(([a], [b]) => a.localeCompare(b)));

/**
 * What a send would have recorded had this box been sent: the next send then sees a box it put there, so it can't read as
 * someone else's change or put old words back. `before`: what the meeting said there. Null takes a field off.
 */
function keptFor(m, c, last, before, mark) {
  const box = c.target;
  const id = box.slice(2);
  const words = c.words;
  if (c.kind === 'roll') {
    if (!mark) return {};
    return { notes: { [box]: words }, ...((last.extra || []).includes(id) ? {} : { rollPut: { [id]: words }, ...(id in (last.rollWas || {}) ? {} : { rollWas: { [id]: before } }) }) };
  }
  const notes = { [box]: words || null };
  if ((m.sections || []).some((s) => s.id === id)) return { notes, ...(last.parts ? { parts: { [id]: words } } : {}) };
  // (taken out: gone, never the agenda's words back, as they would be from a box emptied at a send)
  if (!words) return { notes, put: { [id]: null }, items: { [id]: null }, cleared: { [id]: id in (last.items || {}) ? last.items[id] : before }, ...(last.left ? { left: { [id]: '' } } : {}) };
  return { notes, put: { [id]: words }, ...(id in (last.put || {}) ? {} : { items: { [id]: before }, ...(last.left ? { left: { [id]: null } } : {}) }) };
}

/**
 * Put a correction on the meeting, safe to press again: words already there are only brought into step. Words that changed
 * since it was suggested, or unsent words in the same box, are never gone over, and it can't empty the minutes. Minutes read
 * from a file: on the meeting; the file stays as it was, and the answer says so.
 */
async function makeIt(env, id, c, w, { now }) {
  if (c.kind === 'other') return {};
  const typed = !!(await getMeeting(env.DB, id))?.minutesFrom?.typed;
  if (typed && !await claimSending(env.DB, id, now)) throw no('These are being sent right now. Give it a moment.', 409);
  try {
    // (read with the claim held: nothing can have been sent since)
    const m = await getMeeting(env.DB, id);
    const row = typed ? await env.DB.prepare('SELECT data, sent FROM board_minutes_notes WHERE meeting_id = ?').bind(id).first() : null;
    const draft = parse(row?.data);
    const last = parse(row?.sent);
    const box = c.target;
    const here = boxOf(draft, box);
    const sent = boxOf(last.notes, box);
    const left = last.notes ? withBox(last.notes, box, c.words) : null;
    const there = holds(m, c);
    if (!there) {
      const t = targetOf(m, box);
      if (!t) throw no('That part of the minutes isn’t on the meeting any more. Keep the minutes as they are, or change them in the notes.', 409, { stale: true });
      if (changedSince(m, c)) throw no(STALE, 409, { stale: true });
      if (left) {
        if (here !== sent && here !== c.words) throw no('There are words in the notes there that aren’t sent yet. Send them first, then make this one.', 409, { unsent: true });
        // (the notes with nothing left in them would take the whole minutes off the meeting at the next send)
        if (!anythingIn(left) || !anythingIn(withBox(draft, box, c.words))) throw no('That would leave these minutes with nothing in them. Change them in the notes instead.', 409, { empties: true });
      }
      await patchMeeting(env.DB, id, (cur) => {
        // (a founder's save can land at any moment: looked at again as it's written)
        if (changedSince(cur, c)) throw no(STALE, 409, { stale: true });
        return withCorrection(cur, c, now);
      }, { by: w?.member?.email || w?.adminEmail || '' });
    }
    if (!typed) return { fileKeeps: true };
    if (left && anythingIn(left)) {
      // A person on the roll: their box says it too, or the next send puts the old mark back. With nobody marked in the notes
      // the list is the meeting's own and stays so: one mark there would turn everyone unmarked into not there
      const person = (m.attendance || []).find((p) => p.key === box.slice(2));
      const named = String(draft.guests || '').toLowerCase().split(/[;\n]+/).map((x) => x.trim()).includes(String(person?.name || '').toLowerCase());
      const mark = c.kind === 'roll' && (box in draft || named || (last.extra || []).includes(box.slice(2)) || Object.keys(draft).some((k) => k.startsWith('r:')));
      const kept = keptFor(m, c, last, c.was || '', mark);
      if (Object.keys(kept).length) {
        const carried = here === sent || here === c.words;
        // (nothing else waiting in the notes: nothing left to send)
        if (typedOf(carried ? withBox(draft, box, c.words) : draft) === typedOf(left)) kept.at = iso(now);
        await env.DB.batch([
          env.DB.prepare('UPDATE board_minutes_notes SET sent = json_patch(sent, ?1) WHERE meeting_id = ?2').bind(JSON.stringify(kept), id),
          env.DB.prepare("UPDATE board_minutes_notes SET data = json_patch(data, ?1) WHERE meeting_id = ?2 AND COALESCE(json_extract(data, ?3), '') = ?4").bind(JSON.stringify({ [box]: c.words || null }), id, boxPath(box), sent),
        ]);
      }
    }
    await refreshMinutesFile(env, id, { now });
    return {};
  } finally {
    if (typed) await releaseSending(env.DB, id);
  }
}

/**
 * POST { action: 'correction-decide', id, make, reason, saw }: the secretary or a founder. `make`: on the meeting (a
 * correction that's about anything else: they've changed it themselves); not `make`: the minutes stay as they are, with why
 * if they say. Words already on the minutes are made, whichever was pressed: "kept as they are" would be untrue. `saw`: the
 * words on their page: reworded since, they read it first. → { id, state, fileKeeps }
 */
export async function decideCorrection(env, { id, make = false, reason = '', saw = null } = {}, w, { now = Date.now(), waitUntil = null } = {}) {
  await ensureSchema(env.DB);
  if (!canDecide(w)) throw no('Only the board’s secretary or a founder decides a correction', 403);
  const cid = String(id || '');
  const claim = await env.DB.prepare("UPDATE board_minutes_corrections SET state = 'making', decided_at = ?1 WHERE id = ?2 AND (state = 'waiting' OR (state = 'making' AND decided_at < ?3))").bind(iso(now), cid, iso(now - MAKING_MS)).run();
  if (!((claim?.meta?.changes ?? claim?.changes ?? 0) > 0)) {
    const was = await env.DB.prepare('SELECT state FROM board_minutes_corrections WHERE id = ?').bind(cid).first();
    throw no(was?.state === 'making' ? 'That one is being made right now. Give it a moment.' : 'That one has already been decided', 409, { reload: was?.state !== 'making' });
  }
  const c = await env.DB.prepare('SELECT * FROM board_minutes_corrections WHERE id = ?').bind(cid).first();
  const back = () => env.DB.prepare("UPDATE board_minutes_corrections SET state = 'waiting', decided_at = NULL WHERE id = ?").bind(cid).run();
  let made = {};
  let m = null;
  let doing = !!make;
  try {
    m = await getMeeting(env.DB, c.meeting_id);
    if (!m) throw no('That meeting is gone', 404);
    if (!w?.admin && (!m.shared || m.notBoard || m.practice)) throw no('That meeting isn’t on the board page', 404);
    if (m.minutes === 'approved') throw no('These minutes are approved, so they can’t change here', 409, { reload: true });
    if (saw !== null && cleanWords(saw) !== c.words) throw no('That correction was reworded a moment ago. Read it again.', 409, { reload: true });
    doing = !!make || (c.kind !== 'other' && holds(m, c));
    // (taken back off the meeting since it was suggested: there are no minutes for it to go on)
    if (doing && !minutesIn(m)) throw no('These minutes aren’t on the meeting any more.', 409, { reload: true });
    if (doing) made = await makeIt(env, c.meeting_id, c, w, { now });
  } catch (err) {
    await back();
    throw err;
  }
  const me = await authorOf(env, w);
  const state = doing ? 'made' : 'declined';
  await env.DB.prepare('UPDATE board_minutes_corrections SET state = ?, decided_by = ?, decided_at = ?, reason = ? WHERE id = ?').bind(state, me.name, iso(now), doing ? '' : cleanWords(reason).slice(0, 1000), cid).run();
  if (c.by_slug !== me.slug) {
    const told = tellProposer(env, m, c, { made: doing, by: me.name }).catch((err) => console.error('[board] correction email', err?.message || err));
    if (waitUntil) waitUntil(told); else await told;
  }
  return { id: cid, state, ...made };
}

// ─── The two emails: who and where, never the words ─────────────────
// The minutes stay on the board page; an email can be forwarded and can't be taken back.

const fromBoard = () => EMAIL_FROM.replace(/^[^<]*/, 'SOARD Board ');
const FOOTER = 'You’re getting this as a member of the Sunshine on a Ranney Day Board of Directors.';
const whereOf = (t) => (!t?.where ? '' : t.secret ? 'a board-only item' : t.where);

/** To the secretary and the founders: who suggested one, and where */
export function correctionEmail(m, { by = '', where = '', test = false } = {}) {
  const name = meetingName(m);
  const url = `${SITE}/board/${m.id}`;
  const intro = `${by} suggested a correction to the minutes of the ${name}${where ? `, under ${where}` : ''}.`;
  return {
    subject: `${test ? '[Preview] ' : ''}A correction to the minutes: ${name}`,
    html: emailShell({
      eyebrow: 'SOARD Board', preheader: intro, heading: 'A correction to the minutes', intro: esc(intro),
      bodyHtml: `<div style="margin:18px 0 0;">${button('Read it', url)}</div>`
        + '<p class="muted" style="margin:6px 0 0;font-size:13px;line-height:1.5;color:#5A5B61;">One press there makes it, or keeps the minutes as they are.</p>',
      footerHtml: FOOTER,
    }),
    text: `${intro}\n\nRead it: ${url}\n\nOne press there makes it, or keeps the minutes as they are.`,
  };
}

/** To who suggested it: what was decided (why, if it was kept as it is, stays on the page) */
export function correctionDecidedEmail(m, { made = false, by = '', test = false } = {}) {
  const name = meetingName(m);
  const url = `${SITE}/board/${m.id}`;
  const heading = made ? 'Your correction was made' : 'The minutes stay as they are';
  const intro = made ? `${by} made your correction to the minutes of the ${name}.` : `${by} read your correction to the minutes of the ${name} and kept them as they are.`;
  return {
    subject: `${test ? '[Preview] ' : ''}${made ? 'Your correction was made' : 'Your correction to the minutes'}: ${name}`,
    html: emailShell({ eyebrow: 'SOARD Board', preheader: intro, heading, intro: esc(intro), bodyHtml: `<div style="margin:18px 0 0;">${button('See the minutes', url)}</div>`, footerHtml: FOOTER }),
    text: `${intro}\n\nSee the minutes: ${url}`,
  };
}

async function tellSecretary(env, m, { by, t }) {
  if (!emailConfigured(env)) return;
  const [people, settings] = await Promise.all([roster(env.DB, { withEmails: true }), getSettings(env.DB)]);
  const secretary = people.board.find((p) => p.seat === 'secretary');
  const to = [...new Set([secretary?.email, ...settings.admins].filter(Boolean).map((e) => String(e).toLowerCase()))].filter((e) => e !== String(by.email || '').toLowerCase());
  const mail = correctionEmail(m, { by: by.name, where: whereOf(t) });
  for (const address of to) await sendEmailOne(env, { to: address, from: fromBoard(), ...mail, replyTo: by.email || settings.admins, tags: [{ name: 'kind', value: 'board-correction' }] });
}

async function tellProposer(env, m, c, { made, by }) {
  if (!emailConfigured(env)) return;
  const to = c.by_email || (await roster(env.DB, { withEmails: true })).board.find((p) => p.slug === c.by_slug)?.email;
  if (!to) return;
  const { admins } = await getSettings(env.DB);
  await sendEmailOne(env, { to, from: fromBoard(), ...correctionDecidedEmail(m, { made, by }), replyTo: admins, tags: [{ name: 'kind', value: 'board-correction-decided' }] });
}

/** For Board's own words, and a test: what a roll correction says */
export const rollWords = (status) => HOW[status] || status;
