/**
 * /api/board-portal (Cloudflare Access) — the board page (/admin/board/)
 *
 * Who: a board member (the middleware found their sign-in on People → Board
 * and put them in context.data.boardMember), or one of the Board area's
 * admins looking at it. Any other staff sign-in gets 403.
 *
 * GET                                   → everything the page shows (see _board.js portalData)
 * GET ?live=<id>                        → the meeting as it's held (_board.js liveView): every few seconds while it runs
 * POST { action: 'rsvp', meetingId, answer }        yes | remote | no
 * POST { action: 'action-done', actionId, done }    one of their own action items
 * POST { action: 'sign', docId, name }               "I've read it", this year, with their own name typed
 * POST { action: 'checkin', meetingId, how }         present | remote, on the meeting's day
 * POST { action: 'vote', meetingId, motionId, vote } for | against | abstain, while the chair has it open
 * POST { action: 'report', meetingId, itemId, text, base }  the report on an item they present (Markdown); an admin's
 *                                                    on any. base: the reportAt they started from (409 + current)
 * POST ?attach=<meetingId>&item=<itemId> (multipart "file")  a document with an item they present (an admin's, any)
 * POST { action: 'detach', meetingId, itemId, fileId }  one they put there taken off again (an admin: any)
 * POST ?minutes=<meetingId> (multipart "file")       the secretary's typed minutes template, read into the meeting
 *                                                    (_board-minutes.js secretarySends); the secretary's seat or an admin.
 *                                                    Another meeting's minutes → 409 { error, other }; &anyway=1 sends them all the same
 * An admin looking can't answer, sign, check in or vote for anyone: they have no board seat. In a practice meeting
 * (theirs alone, simulated members) they check in and vote as themselves.
 */

import { portalData, setRsvp, setActionDone, signDoc, ensureSchema, boardIcs, ID, liveView, liveCheckIn, liveVote, saveReport, attachToItem, detachFromItem } from './_board.js';
import { isBoardAdmin } from './_board-roles.js';
import { secretarySends } from './_board-minutes.js';

const fail = (error, status = 400) => Response.json({ ok: false, error }, { status });

async function who(context) {
  const member = context.data?.boardMember || null;
  if (member) return { member, admin: false };
  await ensureSchema(context.env.DB);
  if (await isBoardAdmin(context.env.DB, context.data?.userEmail)) return { member: null, admin: true, adminEmail: context.data?.userEmail || '' };
  return null;
}
const fromError = (err) => (err.status && err.status < 500 ? fail(err.message, err.status) : Response.json({ ok: false, error: err.message }, { status: 500 }));

export async function onRequestGet(context) {
  try {
    const w = await who(context);
    if (!w) return fail('The board page is for SOARD’s board members', 403);
    const q = new URL(context.request.url).searchParams;
    if (q.has('live')) return Response.json({ ok: true, ...(await liveView(context.env, q.get('live'), w)) }, { headers: { 'Cache-Control': 'private, no-store' } });
    // ?ics=<meeting>: that meeting as a calendar file (for someone not on its invite); one whose agenda isn't
    // posted yet comes without it
    const id = q.get('ics');
    if (id) {
      const ics = await boardIcs(context.env.DB, id);
      if (!ics) return fail('That meeting isn’t on the board page', 404);
      return new Response(ics, { headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': 'attachment; filename="soard-board-meeting.ics"', 'Cache-Control': 'private, no-store' } });
    }
    return Response.json({ ok: true, ...(await portalData(context.env, w)) }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    return fromError(err);
  }
}

export async function onRequestPost(context) {
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
    // A document with an item they present (attachToItem checks), as the form's "file"
    const q = new URL(request.url).searchParams;
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
    // A report: who presents the item writes it (saveReport checks), and an admin can on any
    if (body.action === 'report') {
      try {
        const base = typeof body.base === 'string' ? body.base : null;
        return Response.json({ ok: true, ...(await saveReport(env, String(body.meetingId || ''), String(body.itemId || ''), body.text, { ...w, base })) });
      } catch (err) {
        if (err.status === 409 && err.current) return Response.json({ ok: false, error: err.message, current: err.current }, { status: 409 });
        throw err;
      }
    }
    if (!w.member) return fail('Only a board member can answer that for themselves', 403);
    const { member } = w;
    switch (body.action) {
      case 'rsvp':
        if (!ID.test(String(body.meetingId || ''))) return fail('Which meeting?');
        return Response.json({ ok: true, ...(await setRsvp(env.DB, body.meetingId, member.slug, String(body.answer || ''))) });
      case 'action-done':
        return Response.json({ ok: true, ...(await setActionDone(env.DB, String(body.actionId || ''), !!body.done, { by: member.email, slug: member.slug })) });
      case 'sign':
        if (!ID.test(String(body.docId || ''))) return fail('Which document?');
        return Response.json({ ok: true, ...(await signDoc(env.DB, body.docId, member, body.name)) });
      default:
        return fail('Unknown action');
    }
  } catch (err) {
    return fromError(err);
  }
}
