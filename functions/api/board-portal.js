/**
 * /api/board-portal (Cloudflare Access) — the board page (/admin/board/)
 *
 * Who: a board member (the middleware found their sign-in on People → Board
 * and put them in context.data.boardMember), or one of the Board area's
 * admins looking at it. Any other staff sign-in gets 403.
 *
 * GET                                   → everything the page shows (see _board.js portalData)
 * POST { action: 'rsvp', meetingId, answer }        yes | remote | no
 * POST { action: 'action-done', actionId, done }    one of their own action items
 * POST { action: 'sign', docId, name }               "I've read it", this year, with their typed name
 * An admin looking can't answer or sign for anyone: they have no board seat.
 */

import { portalData, setRsvp, setActionDone, signDoc, ensureSchema, getMeeting, meetingIcs, ID } from './_board.js';
import { isBoardAdmin } from './_board-roles.js';

const fail = (error, status = 400) => Response.json({ ok: false, error }, { status });

async function who(context) {
  const member = context.data?.boardMember || null;
  if (member) return { member, admin: false };
  await ensureSchema(context.env.DB);
  if (await isBoardAdmin(context.env.DB, context.data?.userEmail)) return { member: null, admin: true };
  return null;
}

export async function onRequestGet(context) {
  try {
    const w = await who(context);
    if (!w) return fail('The board page is for SOARD’s board members', 403);
    // ?ics=<meeting>: that meeting as a calendar file (for someone not on its invite)
    const ics = new URL(context.request.url).searchParams.get('ics');
    if (ics) {
      const m = ID.test(ics) ? await getMeeting(context.env.DB, ics) : null;
      if (!m?.shared || !m.date) return fail('That meeting isn’t on the board page', 404);
      return new Response(meetingIcs(m), { headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': 'attachment; filename="soard-board-meeting.ics"', 'Cache-Control': 'private, no-store' } });
    }
    return Response.json({ ok: true, ...(await portalData(context.env, w)) }, { headers: { 'Cache-Control': 'private, no-store' } });
  } catch (err) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
}

export async function onRequestPost(context) {
  const { env, request } = context;
  try {
    const w = await who(context);
    if (!w) return fail('The board page is for SOARD’s board members', 403);
    if (!w.member) return fail('Only a board member can answer that for themselves', 403);
    let body = {};
    try { body = await request.json(); } catch { return fail('Expected JSON'); }
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
    return err.status && err.status < 500 ? fail(err.message, err.status) : Response.json({ ok: false, error: err.message }, { status: 500 });
  }
}
