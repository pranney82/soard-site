/**
 * /api/board-admin (Cloudflare Access) — the admin's Board area: meetings,
 * documents, members, settings. Only the Board area's admins (Settings →
 * Who can open it; the founders until saved): every other staff sign-in
 * gets 403, and the middleware never lets a board member's sign-in this far.
 *
 * GET                       → { settings, meetings, docs, members, staff, access, numbers, mercury, email }
 * GET ?me=1                 → { admin } for any staff sign-in (the menu shows Board only to admins)
 * GET ?numbers=1            → the live numbers (cash, makeovers, reveals, events) right now
 * POST { action, ... } (JSON):
 *   new-meeting { date }                      a meeting from the template, saved, not shared
 *   import-meeting { meeting }                an old agenda read by parseAgendaText, saved
 *   save-meeting { meeting, base }            base = the updatedAt the editor loaded (409 when someone saved since)
 *   delete-meeting { id }
 *   snapshot { id }                           lock today's numbers into the packet
 *   send-packet { id, test }                  email the board (test: only you)
 *   action-done { actionId, done }
 *   save-doc { doc }, delete-doc { id }
 *   update-file { id, kind, staffOnly, name }, delete-file { id }
 *   save-settings { settings }
 *   sync-access                               try the sign-in list again (offered only when it failed)
 * POST multipart (?upload=1): file, ownerType (meeting|doc), ownerId, kind, staffOnly → the stored file
 *
 * The audit log gets what changed by name only: its readers are every staff
 * member, and board notes are for the board.
 */

import {
  ensureSchema, getSettings, saveSettings, listMeetings, getMeeting, saveMeeting, createMeeting, importMeeting, deleteMeeting,
  setActionDone, listDocs, saveDoc, deleteDoc, putFile, updateFile, deleteFile, liveNumbers, takeSnapshot, sendPacket,
  memberStatus, roster, packetList, ID, readFileAsAgenda, sendWelcome, approveMinutes, remindRsvp, sendMinutesNotice,
} from './_board.js';
import { isBoardAdmin, isStaffEmail, readState } from './_board-roles.js';
import { accessStatus, syncBoardAccess } from './_board-access.js';
import { maybeSyncBoardCalendar, calendarStatus } from './_board-calendar.js';
import { maybeReadBoardMail, mailStatus, mailLog } from './_board-mail.js';
import { meetingName } from '../../public/admin/board-shared.js';
import { emailConfigured } from './_broadcast-notify.js';
import { logAudit } from './_audit.js';

const fail = (error, status = 400, extra = {}) => Response.json({ ok: false, error, ...extra }, { status });
const fromError = (err) => (err.status && err.status < 500 ? fail(err.message, err.status, err.current ? { current: err.current } : {}) : Response.json({ ok: false, error: err.message }, { status: 500 }));

async function gate(context) {
  const me = context.data?.userEmail || '';
  await ensureSchema(context.env.DB);
  if (!isStaffEmail(me) || !(await isBoardAdmin(context.env.DB, me))) return { me, refused: fail('The Board area is open only to the people its Settings list', 403) };
  return { me };
}

const audit = (env, me, action, name) => logAudit(env.DB, { userEmail: me, action, entityType: 'board', entitySlug: 'board', entityName: name, gitStatus: 'ok' }).catch(() => {});

export async function onRequestGet(context) {
  const { env } = context;
  const q = new URL(context.request.url).searchParams;
  try {
    if (q.has('me')) {
      const me = context.data?.userEmail || '';
      await ensureSchema(env.DB);
      return Response.json({ ok: true, admin: await isBoardAdmin(env.DB, me) });
    }
    const { me, refused } = await gate(context);
    if (refused) return refused;
    if (q.has('numbers')) return Response.json({ ok: true, numbers: await liveNumbers(env) });
    // A look at the calendars when the last one is over 10 minutes old (at most 6 seconds; the rest finishes after)
    const looking = maybeSyncBoardCalendar(env, { minAgeMs: 10 * 60 * 1000 });
    context.waitUntil?.(looking);
    await Promise.race([looking, new Promise((r) => setTimeout(r, 6000))]);
    // Board mail is slower (files to read): it runs after the answer, and shows on the next open
    context.waitUntil?.(maybeReadBoardMail(env, { minAgeMs: 10 * 60 * 1000 }));
    const [settings, meetings, docs, members, people, access, numbers, recipients, calendar] = await Promise.all([
      getSettings(env.DB), listMeetings(env.DB), listDocs(env.DB), memberStatus(env.DB), roster(env.DB),
      accessStatus(env), liveNumbers(env), packetList(env.DB), calendarStatus(env.DB),
    ]);
    const [mail, mailRecent, welcome] = await Promise.all([mailStatus(env.DB), mailLog(env.DB), readState(env.DB, 'welcome')]);
    return Response.json({
      ok: true, me, settings, meetings, docs, members, access, numbers, calendar, mail, mailRecent, welcome,
      people: { board: people.board, staff: people.staff },
      // Mercury answers only through SOARD's relay (_mercury.js), so the balance needs both keys
      setup: { calendar: Boolean(env.GOOGLE_CALENDAR_KEY), mercury: Boolean(String(env.MERCURY_API_TOKEN || '').trim() && String(env.MERCURY_RELAY_KEY || '').trim()), email: emailConfigured(env), jobtread: Boolean(env.JOBTREAD_GRANT_KEY) },
      packetTo: recipients.length,
    });
  } catch (err) {
    return fromError(err);
  }
}

export async function onRequestPost(context) {
  const { env, request } = context;
  const { me, refused } = await gate(context);
  if (refused) return refused;
  try {
    if ((request.headers.get('Content-Type') || '').includes('multipart/form-data')) {
      const form = await request.formData();
      const file = await putFile(env, {
        ownerType: String(form.get('ownerType') || ''), ownerId: String(form.get('ownerId') || ''), file: form.get('file'),
        kind: String(form.get('kind') || 'other'), staffOnly: form.get('staffOnly') === 'true', by: me,
      });
      await audit(env, me, 'created', `Board file added: ${file.name}`);
      return Response.json({ ok: true, file });
    }
    let body = {};
    try { body = await request.json(); } catch { return fail('Expected JSON'); }
    const id = String(body.id || '');
    const needId = () => { if (!ID.test(id)) throw Object.assign(new Error('Which one?'), { status: 400 }); };
    switch (body.action) {
      case 'new-meeting': {
        const m = await createMeeting(env, { date: body.date, by: me });
        await audit(env, me, 'created', `Board meeting added: ${meetingName(m)}`);
        return Response.json({ ok: true, meeting: m });
      }
      case 'import-meeting': {
        const m = await importMeeting(env, body.meeting || {}, { by: me });
        await audit(env, me, 'created', `Board meeting brought in from an old agenda: ${meetingName(m)}`);
        return Response.json({ ok: true, meeting: m });
      }
      case 'save-meeting': {
        const m = await saveMeeting(env.DB, body.meeting || {}, { by: me, base: typeof body.base === 'string' ? body.base : null });
        await audit(env, me, 'updated', `Board meeting saved: ${meetingName(m)}`);
        return Response.json({ ok: true, meeting: m });
      }
      case 'delete-meeting': {
        needId();
        const m = await getMeeting(env.DB, id);
        await deleteMeeting(env, id);
        await audit(env, me, 'deleted', `Board meeting deleted: ${m ? meetingName(m) : id}`);
        return Response.json({ ok: true });
      }
      case 'snapshot': {
        needId();
        return Response.json({ ok: true, meeting: await takeSnapshot(env, id, { by: me }) });
      }
      case 'send-packet': {
        needId();
        const admins = (await getSettings(env.DB)).admins;
        const r = await sendPacket(env, id, { by: me, to: body.test ? [me] : null, replyTo: admins });
        if (!body.test && r.sent) await audit(env, me, 'updated', `Board packet emailed to ${r.sent} board members`);
        return Response.json({ ok: r.failed === 0, ...r, meeting: await getMeeting(env.DB, id), ...(r.failed ? { error: r.errors[0] || 'Some emails didn’t go' } : {}) });
      }
      case 'action-done':
        return Response.json({ ok: true, ...(await setActionDone(env.DB, String(body.actionId || ''), !!body.done, { by: me })) });
      case 'save-doc': {
        const d = await saveDoc(env.DB, body.doc || {});
        await audit(env, me, 'updated', `Board document saved: ${d.title}`);
        return Response.json({ ok: true, doc: d });
      }
      case 'delete-doc': {
        needId();
        await deleteDoc(env, id);
        await audit(env, me, 'deleted', 'Board document deleted');
        return Response.json({ ok: true });
      }
      case 'update-file':
        needId();
        return Response.json({ ok: true, file: await updateFile(env.DB, id, { kind: body.kind, staffOnly: body.staffOnly, name: body.name }) });
      case 'delete-file':
        needId();
        await deleteFile(env, id);
        await audit(env, me, 'deleted', 'Board file deleted');
        return Response.json({ ok: true });
      case 'save-settings': {
        const s = await saveSettings(env.DB, body.settings || {}, me);
        await audit(env, me, 'updated', 'Board settings saved');
        return Response.json({ ok: true, settings: s });
      }
      case 'read-file': {
        // The minutes (or an old agenda) uploaded to a meeting, read for the admin to look over before it fills the meeting
        needId();
        const parsed = await readFileAsAgenda(env, id);
        return parsed ? Response.json({ ok: true, parsed }) : fail('Couldn’t read an agenda in that file. Is it the minutes, as a PDF or Word file?', 422);
      }
      case 'approve-minutes': {
        needId();
        const m = await approveMinutes(env, id, { on: body.on, by: me });
        await audit(env, me, 'updated', `Board minutes approved: ${meetingName(m)}`);
        return Response.json({ ok: true, meeting: m });
      }
      case 'remind-rsvp': {
        needId();
        const r = await remindRsvp(env, id, { to: body.test ? [me] : null, replyTo: (await getSettings(env.DB)).admins });
        return Response.json({ ok: r.failed === 0, ...r, ...(r.failed ? { error: r.errors[0] || 'Some emails didn’t go' } : {}) });
      }
      case 'send-minutes': {
        needId();
        const r = await sendMinutesNotice(env, id, { to: body.test ? [me] : null, replyTo: (await getSettings(env.DB)).admins });
        if (!body.test && r.sent) await audit(env, me, 'updated', `Board told the minutes are up (${r.sent})`);
        return Response.json({ ok: r.failed === 0, ...r, meeting: await getMeeting(env.DB, id), ...(r.failed ? { error: r.errors[0] || 'Some emails didn’t go' } : {}) });
      }
      case 'send-welcome': {
        const admins = (await getSettings(env.DB)).admins;
        const r = await sendWelcome(env, { to: body.test ? [me] : null, replyTo: admins });
        if (!body.test && r.sent) await audit(env, me, 'updated', `Board page sign-in email sent to ${r.sent} board members`);
        return Response.json({ ok: r.failed === 0, ...r, ...(r.failed ? { error: r.errors[0] || 'Some emails didn’t go' } : {}) });
      }
      case 'sync-access':
        return Response.json({ ok: true, access: { ...(await syncBoardAccess(env)), ...(await accessStatus(env)) } });
      default:
        return fail('Unknown action');
    }
  } catch (err) {
    return fromError(err);
  }
}
