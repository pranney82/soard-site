/**
 * /api/board-portal (Cloudflare Access) — the board page (/admin/board/)
 *
 * Who: a board member (the middleware found their sign-in on People → Board
 * and put them in context.data.boardMember), or one of the Board area's
 * admins looking at it. Any other staff sign-in gets 403.
 *
 * GET                                   → everything the page shows (see _board.js portalData)
 * GET ?live=<id>                        → the meeting as it's held (_board.js liveView): every few seconds while it runs
 * POST { action: 'rsvp' }                           → 410: the calendar invite is the only answer (Peter, Nov 2 2026)
 * POST { action: 'action-done', actionId, done }    one of their own action items
 * POST { action: 'sign', docId, name, version }      "I've read it", this year, with their own name typed (409 { changed }: the words changed since)
 * POST ?signed=<docId> (multipart "file")           the copy they signed on paper, as this year's signature (staff-only;
 *                                                    they open their own)
 * POST { action: 'checkin', meetingId, how }         present | remote, on the meeting's day
 * POST { action: 'vote', meetingId, motionId, vote } for | against | abstain, while the chair has it open
 * POST { action: 'report', meetingId, itemId, text, base }  the report on an item they present (Markdown); an admin's
 *                                                    on any. base: the reportAt they started from (409 + current)
 * POST ?attach=<meetingId>&item=<itemId> (multipart "file")  a document with an item they present (an admin's, any)
 * POST { action: 'detach', meetingId, itemId, fileId }  one they put there taken off again (an admin: any)
 * POST { action: 'motion', meetingId, itemId, text, base }  what an item's presenter asks the board to vote on (an admin's,
 *                                                    any); empty takes it off. base: the motion the page last saw (409 + current)
 * POST { action: 'line-note', meetingId, itemId, key, line, text }  a note on one line of the money's statements by who
 *                                                    presents the item (an admin's, any); empty text takes it off (_board-asks.js)
 * POST { action: 'chair-approve', meetingId }        the chair approves the agenda ahead (or an admin)
 * POST { action: 'chair-note', meetingId, itemId, text }  the chair's own note on an item (the chair's and the admins' only)
 * POST { action: 'ask-presenter', meetingId, itemId, question }  the chair sends a report back to who presents it with a
 *                                                    question, by email from the asker's Gmail; their answer goes under the report
 * POST ?minutes=<meetingId> (multipart "file")       the secretary's typed minutes template, read into the meeting
 *                                                    (_board-minutes.js secretarySends); the secretary's seat or an admin.
 *                                                    Another meeting's minutes → 409 { error, other }; &anyway=1 sends them all the same
 * POST { action: 'activity', events, touch, now }  what a member looked at and for how long (../../public/admin/board/activity.js)
 * A member's sign-ins, looks and answers are kept for Board → Members (_board-activity.js); an admin's never are.
 * An admin looking can't answer, sign, check in or vote for anyone: they have no board seat. In a practice meeting
 * (theirs alone, simulated members) they check in and vote as themselves.
 */

import { portalData, setActionDone, signDoc, signWithCopy, ensureSchema, boardIcs, ID, liveView, liveCheckIn, liveVote, saveReport, saveMotion, attachToItem, detachFromItem, listMeetings } from './_board.js';
import { isBoardAdmin } from './_board-roles.js';
import { secretarySends } from './_board-minutes.js';
import { noteGet, noteLook, noteAnswer, noteEvents, answerOf } from './_board-activity.js';
import { portalExtras, saveLineNote, chairApprove, chairNote, askPresenter } from './_board-asks.js';
import { shorterFor } from './_board-shorter.js';

const fail = (error, status = 400, extra = {}) => Response.json({ ok: false, error, ...extra }, { status });

async function who(context) {
  const member = context.data?.boardMember || null;
  if (member) return { member, admin: false };
  await ensureSchema(context.env.DB);
  if (await isBoardAdmin(context.env.DB, context.data?.userEmail)) return { member: null, admin: true, adminEmail: context.data?.userEmail || '' };
  return null;
}
// After the answer when the platform allows (waitUntil), else before it (tests)
const later = async (context, p) => { if (context.waitUntil) context.waitUntil(p); else await p; };
const fromError = (err) => (err.status && err.status < 500 ? fail(err.message, err.status, err.extra || {}) : Response.json({ ok: false, error: err.message }, { status: 500 }));

export async function onRequestGet(context) {
  try {
    const w = await who(context);
    if (!w) return fail('The board page is for SOARD’s board members', 403);
    if (w.member) await later(context, noteGet(context.env, w.member, context.request));
    const q = new URL(context.request.url).searchParams;
    if (q.has('live')) {
      const view = await liveView(context.env, q.get('live'), w);
      // Following it counts only while it's being held
      if (w.member && view?.live?.startedAt && !view.live.endedAt) await later(context, noteLook(context.env, w.member, context.request, 'live', q.get('live')));
      return Response.json({ ok: true, ...view }, { headers: { 'Cache-Control': 'private, no-store' } });
    }
    // ?ics=<meeting>: that meeting as a calendar file (for someone not on its invite); one whose agenda isn't
    // posted yet comes without it
    const id = q.get('ics');
    if (id) {
      const ics = await boardIcs(context.env.DB, id);
      if (!ics) return fail('That meeting isn’t on the board page', 404);
      if (w.member) await later(context, noteLook(context.env, w.member, context.request, 'calendar', id));
      return new Response(ics, { headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': 'attachment; filename="soard-board-meeting.ics"', 'Cache-Control': 'private, no-store' } });
    }
    // Beside it: the notes on the money's lines, a member's own report asks (when each is due), and a meeting ahead
    // not shared yet that they present in (their items only), so the ask's link opens (_board-asks.js)
    const [data, extras] = await Promise.all([portalData(context.env, w), listMeetings(context.env.DB).then((meetings) => portalExtras(context.env, { ...w, meetings }))]);
    return Response.json({ ok: true, ...data, ...extras }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    return fromError(err);
  }
}

/**
 * A member's answers are kept once they worked (a JSON body is read from a copy; a file upload, from its query
 * only), and the tracker's report goes straight in
 */
export async function onRequestPost(context) {
  const member = context.data?.boardMember || null;
  const json = /application\/json/i.test(context.request.headers.get('Content-Type') || '');
  // A tracker's report is a few kilobytes: a body far bigger is never read here (the action it is reads it, as before),
  // whatever its Content-Length says
  const small = Number(context.request.headers.get('Content-Length') || 0) <= 256_000;
  const copy = json && small ? context.request.clone() : null;
  let body = null;
  if (copy?.body) {
    const reader = copy.body.getReader();
    const parts = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read().catch(() => ({ done: true }));
      if (done) break;
      size += value.byteLength;
      if (size > 256_000) { reader.cancel().catch(() => {}); parts.length = 0; break; }
      parts.push(value);
    }
    if (parts.length) { try { body = JSON.parse(new TextDecoder().decode(await new Blob(parts).arrayBuffer())); } catch { body = null; } }
  }
  // An admin looking at the page isn't recorded: their tracker's reports are let go, and it stops sending
  if (body?.action === 'activity') {
    try {
      return Response.json({ ok: true, ...(member ? await noteEvents(context.env, member, context.request, body) : { kept: 0, stop: true }) });
    } catch (err) {
      return fromError(err);
    }
  }
  const res = await post(context);
  if (member && res.status === 200) {
    // An answer that kept nothing isn't something they did: an agenda someone else had approved first, a test
    const said = (res.headers.get('Content-Type') || '').includes('json') ? await res.clone().json().catch(() => null) : null;
    if (!said?.already && !said?.test) await later(context, noteAnswer(context.env, member, context.request, answerOf(body, new URL(context.request.url).searchParams)));
  }
  return res;
}

async function post(context) {
  const { env, request } = context;
  try {
    const w = await who(context);
    if (!w) return fail('The board page is for SOARD’s board members', 403);
    // The secretary's typed minutes (the minutes template), as the form's "file": secretarySends checks the seat
    const sends = new URL(request.url).searchParams.get('minutes');
    if (sends !== null) {
      let file = null;
      try { file = (await request.formData()).get('file'); } catch { return fail('Send the minutes as a file'); }
      try {
        return Response.json({ ok: true, ...(await secretarySends(env, sends, file, w, { anyway: new URL(request.url).searchParams.get('anyway') === '1' })) });
      } catch (err) {
        // Another meeting's minutes: nothing kept; sent again with &anyway=1 they go in all the same
        if (err.status === 409 && err.other) return Response.json({ ok: false, error: err.message, other: err.other }, { status: 409 });
        throw err;
      }
    }
    const q = new URL(request.url).searchParams;
    // The copy of a paper they signed on paper, as the form's "file": their own signature, so a board member's only
    if (q.has('signed')) {
      if (!w.member) return fail('Only a board member can sign for themselves', 403);
      if (!ID.test(String(q.get('signed') || ''))) return fail('Which document?');
      let form = null;
      try { form = await request.formData(); } catch { return fail('Send your signed copy as a file'); }
      if (form.get('as') && String(form.get('as')) !== w.member.slug) return fail(`This browser is signed in as ${w.member.name} now. Reload the page to sign as yourself.`, 409, { who: true });
      // The wording on their page when they added it (a newer one is read first)
      const version = form.get('version');
      return Response.json({ ok: true, ...(await signWithCopy(env, q.get('signed'), form.get('file'), { member: w.member, by: w.member.email, version: version == null ? null : Number(version) })) });
    }
    // A document with an item they present (attachToItem checks), as the form's "file"
    if (q.has('attach')) {
      let file = null;
      try { file = (await request.formData()).get('file'); } catch { return fail('Send the document as a file'); }
      return Response.json({ ok: true, ...(await attachToItem(env, q.get('attach'), String(q.get('item') || ''), file, w)) });
    }
    let body = {};
    try { body = await request.json(); } catch { return fail('Expected JSON'); }
    // A meeting as it's held: a member for themselves; an admin only in their practice meeting (liveMeeting decides)
    if (body.action === 'checkin') return Response.json({ ok: true, ...(await liveCheckIn(env, String(body.meetingId || ''), { ...w, how: String(body.how || '') })) });
    if (body.action === 'vote') return Response.json({ ok: true, ...(await liveVote(env, String(body.meetingId || ''), String(body.motionId || ''), String(body.vote || ''), w)) });
    if (body.action === 'detach') return Response.json({ ok: true, ...(await detachFromItem(env, String(body.meetingId || ''), String(body.itemId || ''), String(body.fileId || ''), w)) });
    // The chair's review (the chair's seat, or an admin: _board-asks.js chairGate checks)
    if (body.action === 'chair-approve') return Response.json({ ok: true, ...(await chairApprove(env, { meetingId: String(body.meetingId || '') }, w)) });
    if (body.action === 'chair-note') return Response.json({ ok: true, ...(await chairNote(env, { meetingId: String(body.meetingId || ''), itemId: String(body.itemId || ''), text: String(body.text ?? '') }, w)) });
    if (body.action === 'ask-presenter') return Response.json({ ok: true, ...(await askPresenter(env, { meetingId: String(body.meetingId || ''), itemId: String(body.itemId || ''), question: String(body.question ?? '') }, w)) });
    if (body.action === 'line-note') {
      const note = { meetingId: String(body.meetingId || ''), itemId: String(body.itemId || ''), key: String(body.key || ''), line: String(body.line || ''), text: String(body.text ?? '') };
      return Response.json({ ok: true, ...(await saveLineNote(env, note, w)) });
    }
    // A motion for the board to vote on: who presents the item, or an admin (saveMotion checks, as for a report)
    if (body.action === 'motion') {
      try {
        const base = typeof body.base === 'string' ? body.base : null;
        return Response.json({ ok: true, ...(await saveMotion(env, String(body.meetingId || ''), String(body.itemId || ''), body.text, { ...w, base })) });
      } catch (err) {
        if (err.status === 409 && err.current) return Response.json({ ok: false, error: err.message, current: err.current }, { status: 409 });
        throw err;
      }
    }
    // A report: who presents the item writes it (saveReport checks), and an admin can on any
    if (body.action === 'report') {
      try {
        const base = typeof body.base === 'string' ? body.base : null;
        const look = typeof body.look === 'string' ? body.look : undefined;
        return Response.json({ ok: true, ...(await saveReport(env, String(body.meetingId || ''), String(body.itemId || ''), body.text, { ...w, base, look })) });
      } catch (err) {
        if (err.status === 409 && err.current) return Response.json({ ok: false, error: err.message, current: err.current }, { status: 409 });
        throw err;
      }
    }
    // A shorter version of a report, offered beside it (nothing saved): who presents the item, or an admin
    if (body.action === 'report-shorter') {
      const ask = { id: String(body.meetingId || body.id || ''), itemId: String(body.itemId || ''), text: body.text, title: String(body.title || '') };
      return Response.json(await shorterFor(env, ask, w));
    }
    if (!w.member) return fail('Only a board member can answer that for themselves', 403);
    const { member } = w;
    switch (body.action) {
      // Who's coming is the calendar invite's alone (a page open from before still has the buttons)
      case 'rsvp':
        return fail('Answer the calendar invite: that’s where SOARD sees who’s coming.', 410);
      case 'action-done':
        return Response.json({ ok: true, ...(await setActionDone(env.DB, String(body.actionId || ''), !!body.done, { by: member.email, slug: member.slug })) });
      case 'sign':
        if (!ID.test(String(body.docId || ''))) return fail('Which document?');
        // (the page was opened by someone else: another sign-in in this browser since)
        if (body.as && body.as !== member.slug) return fail(`This browser is signed in as ${member.name} now. Reload the page to sign as yourself.`, 409, { who: true });
        return Response.json({ ok: true, ...(await signDoc(env.DB, body.docId, member, body.name, { version: Number.isInteger(body.version) ? body.version : null })) });
      default:
        return fail('Unknown action');
    }
  } catch (err) {
    return fromError(err);
  }
}
