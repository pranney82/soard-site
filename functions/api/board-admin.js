/**
 * /api/board-admin (Cloudflare Access) — the admin's Board area: meetings,
 * documents, members, settings. Only the Board area's admins (Settings →
 * Who can open it; the founders until saved): every other staff sign-in
 * gets 403, and the middleware never lets a board member's sign-in this far.
 *
 * GET                       → { settings, meetings, docs, members, staff, access, numbers, mercury, email }
 * GET ?me=1                 → { admin } for any staff sign-in (the menu shows Board only to admins)
 * GET ?numbers=1            → the live numbers (cash, makeovers, reveals, events) right now
 * GET ?activity=<slug>      → { signIns, events } one board member's sign-ins and what they did on the board page
 *                             (_board-activity.js)
 * GET ?activity=             → { activity, activityBegan } everyone's summary (Members asks when it opens)
 * GET ?live=<id>            → { checkins, votes } for the chair's screen while a meeting is held (_board.js chairLive)
 * POST { action, ... } (JSON):
 *   new-meeting { date }                      a meeting from the template, saved, not shared
 *   import-meeting { meeting }                an old agenda read by parseAgendaText, saved
 *   save-meeting { meeting, base }            base = the updatedAt the editor loaded (409 when someone saved since)
 *   delete-meeting { id }
 *   snapshot { id }                           lock today's numbers into the packet
 *   approve-agenda { id }                     approve the agenda: it goes on the board page and the board is emailed, once
 *   send-packet { id, test }                  email the board, once its agenda is approved (test: only you)
 *   action-done { actionId, done }
 *   save-doc { doc, askAgain, base, fromFile, wordsFrom, newFile }, delete-doc { id }   doc.body: its words, written here (a change is the next wording;
 *                                             409 { conflict } or { ask }: see saveDoc);
 *                                             askAgain: the board signs the new wording again
 *   doc-versions { id }                      a paper's wordings written here, newest first
 *   unsign { docId, slug }                    a member's signature this year taken off (its copy goes with it)
 *   ask-to-sign { slugs?, test? }             an email to each picked member (none: everyone) who hasn't signed this
 *                                             year's papers, asking them to; test: to the admin only
 *   update-file { id, kind, staffOnly, name }, delete-file { id }
 *   save-settings { settings }
 *   sync-access                               try the sign-in list again (offered only when it failed)
 *   sync-group                                bring board@soardcharity.com up to the board now (offered when it failed)
 *   practice                                  today's practice meeting (made the first time): only the admins see it
 *   practice-reset { id }                     start the practice over (a new one; its check-ins and votes go)
 *   read-minutes { id, fileId }               that file read as the meeting's minutes and put on it (_board-minutes.js):
 *                                             → { meeting, approvedPrev, read: { attendance: { here, of }, notes, motions, actions, ai } }
 *                                             another meeting's minutes (their heading or file name) → 409 { error, other:
 *                                             { date, name }, fileId }, nothing put on it; anyway: true reads them in all the same
 *                                             dry: true reads it without saving → { dry, read, would }
 * POST multipart (?upload=1): file, ownerType (meeting|doc), ownerId, kind, staffOnly → the stored file
 * POST multipart: file, signFor (a document), slug   the copy a member signed on paper, as their signature this year
 *
 * The audit log gets what changed by name only: its readers are every staff
 * member, and board notes are for the board.
 */

import { notesWaiting, refreshMinutesFile } from './_board-notes.js';
import {
  ensureSchema, getSettings, saveSettings, listMeetings, getMeeting, saveMeeting, createMeeting, importMeeting, deleteMeeting,
  setActionDone, listDocs, saveDoc, deleteDoc, boardFileProblem, fillDocWords, docVersions, signWithCopy, unsignDoc, putFile, updateFile, deleteFile, fileLocked, liveNumbers, takeSnapshot, sendPacket,
  memberStatus, roster, packetList, ID, readFileAsAgenda, sendWelcome, askToSign, approveMinutes, remindRsvp, sendMinutesNotice, patchMeeting,
  chairLive, createPractice, resetPractice, agendaApprovals, holdSharing,
} from './_board.js';
import { chairApprove } from './_board-asks.js';
import { isBoardAdmin, isStaffEmail, readState, activeBoard } from './_board-roles.js';
import { accessStatus, syncBoardAccess, accessConfigured } from './_board-access.js';
import { groupStatus, syncBoardGroup } from './_board-group.js';
import { maybeSyncBoardCalendar, calendarStatus } from './_board-calendar.js';
import { maybeReadBoardMail, mailStatus, mailLog, clientIdOf } from './_board-mail.js';
import { sendInvite, cancelInvite, noteInviteChange, projectOf, inviteCheck, maybeCheckInvites } from './_board-invite.js';
import { meetingName } from '../../public/admin/board-shared.js';
import { readMinutesInto } from './_board-minutes.js';
import { activityOverview, memberActivity, deviceOf, accessIat } from './_board-activity.js';
import { evidenceOf, voidEmail, appendEvents, exportYear } from './_board-sign.js';
import { sendEmailOne, EMAIL_FROM } from './_broadcast-notify.js';
// Where an admin's change to a signature came from: its evidence, under the admin's own name
const evidence = (context) => evidenceOf(context, { deviceOf, accessIat });
import { shorterFor } from './_board-shorter.js';
import { emailConfigured } from './_broadcast-notify.js';
import { logAudit } from './_audit.js';

/**
 * Who has had the sign-in email and whether one is going out, read in one query so both are from the same moment (a
 * send that's put back can never show as done). `welcomeAt` orders it against other looks.
 */
async function welcomeNow(DB) {
  let rows = [];
  try { rows = (await DB.prepare("SELECT key, data, updated_at FROM board_state WHERE key IN ('welcome', 'welcome-sending')").all()).results || []; } catch { /* no board state yet */ }
  const w = rows.find((r) => r.key === 'welcome');
  const c = rows.find((r) => r.key === 'welcome-sending');
  let welcome = {};
  try { welcome = w ? JSON.parse(w.data) || {} : {}; } catch { /* a broken record reads as none */ }
  let sendingTo = [];
  try { sendingTo = c ? JSON.parse(c.data || '{}').to || [] : []; } catch { /* a claim without its list */ }
  const sending = !!c && Date.now() - Date.parse(c.updated_at) < 2 * 60 * 1000;
  return { welcome, welcomeSending: sending, welcomeSendingTo: sending ? sendingTo : [], welcomeAt: Date.now() };
}

/** save-doc's options from what the page sent (its words' source, the wording it started from, its answer to "sign again?") */
const docOptions = (body, me) => ({
  by: me, askAgain: typeof body.askAgain === 'boolean' ? body.askAgain : null, base: Number.isInteger(body.base) ? body.base : null,
  fromFile: body.fromFile === true, wordsFrom: String(body.wordsFrom || '').slice(0, 200),
});
const fail = (error, status = 400, extra = {}) => Response.json({ ok: false, error, ...extra }, { status });
const fromError = (err) => (err.status && err.status < 500 ? fail(err.message, err.status, { ...(err.current ? { current: err.current } : {}), ...(err.extra || {}) }) : Response.json({ ok: false, error: err.message }, { status: 500 }));

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
    // A paper's signing record for a year, for an auditor: one ZIP (./_board-sign.js exportYear)
    if (q.has('record')) {
      const docId = String(q.get('record') || '');
      if (!ID.test(docId)) return Response.json({ ok: false, error: 'Which paper?' }, { status: 400 });
      await audit(env, me, 'exported', `Board signing record downloaded: ${docId} ${q.get('year') || ''}`.trim());
      return exportYear(env, docId, Number(q.get('year')) || null, { waitUntil: (p) => context.waitUntil?.(p) });
    }
    // Papers' PDFs read for the board page's search, a few each time an admin comes by
    context.waitUntil?.(fillDocWords(env));
    // Board access's quick look while a sign-in email is going out (and as the panel opens)
    if (q.has('welcome')) return Response.json({ ok: true, ...(await welcomeNow(env.DB)) }, { headers: { 'Cache-Control': 'no-store' } });
    // One board member's sign-ins and what they did on the board page (Members → their row)
    if (q.has('activity') && !q.get('activity')) {
      const activity = await activityOverview(env.DB);
      return Response.json({ ok: true, activity, activityBegan: activity.began || null }, { headers: { 'Cache-Control': 'no-store' } });
    }
    if (q.has('activity')) {
      const slug = String(q.get('activity') || '');
      if (!(await memberStatus(env.DB)).some((p) => p.slug === slug)) return Response.json({ ok: false, error: 'That isn’t a board member now' }, { status: 404 });
      return Response.json({ ok: true, ...(await memberActivity(env.DB, slug)) }, { headers: { 'Cache-Control': 'no-store' } });
    }
    if (q.has('live')) return Response.json({ ok: true, ...(await chairLive(env, q.get('live'))) }, { headers: { 'Cache-Control': 'no-store' } });
    // The invites' answers read again when the last look is over 10 minutes old (at most 6 seconds; the rest finishes after)
    const looking = maybeSyncBoardCalendar(env, { minAgeMs: 10 * 60 * 1000 });
    context.waitUntil?.(looking);
    await Promise.race([looking, new Promise((r) => setTimeout(r, 6000))]);
    // Board mail is slower (files to read): it runs after the answer, and shows on the next open
    context.waitUntil?.(maybeReadBoardMail(env, { minAgeMs: 10 * 60 * 1000 }));
    // The invite check, when it hasn't passed: a change made in Google shows on the next open
    context.waitUntil?.(maybeCheckInvites(env, { retryMs: 10 * 60 * 1000 }));
    const [settings, meetings, docs, members, people, access, numbers, recipients, calendar] = await Promise.all([
      getSettings(env.DB), listMeetings(env.DB), listDocs(env.DB), memberStatus(env.DB), roster(env.DB),
      accessStatus(env), liveNumbers(env), packetList(env.DB), calendarStatus(env.DB),
    ]);
    const [mail, mailRecent, welcome, check, group] = await Promise.all([mailStatus(env.DB), mailLog(env.DB), readState(env.DB, 'welcome'), inviteCheck(env.DB), groupStatus(env)]);
    return Response.json({
      ok: true, me, settings, meetings, docs, members, access, numbers, calendar, mail, mailRecent, welcome, notesWaiting: await notesWaiting(env.DB),
      // Whose approval each agenda has: nothing reaches the board before it (_board.js holdUntilApproved)
      approvals: await agendaApprovals(env.DB),
      // board@soardcharity.com following the board (_board-group.js)
      group,
      // Who has had the sign-in email and whether one is going out right now (its claim, _board.js sendWelcome), from one
      // moment: Board access says so instead of offering another
      ...(await welcomeNow(env.DB)),
      // For the one-time Google setup: the service account's client ID and its Cloud project (neither is secret),
      // and the heartbeat's check that the invite's Calendar, Meet and attendance work
      google: env.GOOGLE_CALENDAR_KEY ? { clientId: clientIdOf(env), project: projectOf(env), check } : null,
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
      // A paper a member signed and handed in: their signature for this year
      if (form.get('signFor')) {
        const docId = String(form.get('signFor'));
        if (!ID.test(docId)) return fail('Which document?');
        const original = form.get('original');
        const signed = await signWithCopy(env, docId, form.get('file'), { slug: String(form.get('slug') || ''), by: me, replace: form.get('replace') === '1', evidence: evidence(context), original: original && typeof original.arrayBuffer === 'function' ? original : null });
        await audit(env, me, 'updated', `Board signature added for ${signed.name}`);
        // (one they gave themselves, replaced by a copy SOARD added: they're told, as a signature taken off is)
        if (signed.replaced?.email) {
          context.waitUntil?.((async () => {
            const doc = (await listDocs(env.DB)).find((d) => d.id === docId);
            const r = await sendEmailOne(env, { to: signed.replaced.email, from: EMAIL_FROM.replace(/^[^<]*/, 'SOARD Board '), replyTo: (await getSettings(env.DB)).admins, tags: [{ name: 'kind', value: 'board-void' }], idempotencyKey: `void:${docId}:${signed.replaced.slug}:${signed.year}:${signed.replaced.at}`, ...voidEmail({ doc, year: signed.year, reason: 'SOARD put a signed copy it was given in its place', replacedByCopy: true }) });
            if (r.sent || r.already) await appendEvents(env.DB, async () => ({ events: [{ kind: 'void-sent', docId, slug: signed.replaced.slug, year: signed.year, by: me, detail: { to: signed.replaced.email, replacedByCopy: true } }] }));
          })().catch(() => {}));
        }
        return Response.json({ ok: true, signed, doc: (await listDocs(env.DB)).find((d) => d.id === docId) });
      }
      // A paper saved with its new file, in one: the file checked first, so nothing changes (no new version, nobody
      // asked to sign again) unless it can go up; a new paper whose file then didn't go isn't left without it
      if (form.get('saveDoc')) {
        let req = {};
        try { req = JSON.parse(String(form.get('saveDoc'))); } catch { return fail('Expected the paper with its file'); }
        const upload = form.get('file');
        const why = await boardFileProblem(upload);
        if (why) return fail(why, 415);
        const d = await saveDoc(env.DB, req.doc || {}, { ...docOptions(req, me), newFile: String(upload.name || 'file').slice(0, 200) });
        let put;
        try { put = await putFile(env, { ownerType: 'doc', ownerId: d.id, file: upload, by: me }); } catch (err) { if (!req.doc?.id) await deleteDoc(env, d.id); throw err; }
        // (a new version that's this file: which file it was, for what a signature on it signed)
        // (a paper's first file, version 0, gets its row too: what a signature on it signed is never a later file)
        if (!d.body) await env.DB.prepare("INSERT OR IGNORE INTO board_doc_versions (doc_id, version, body, at, by, note) VALUES (?, ?, '', ?, ?, ?)").bind(d.id, d.version, new Date().toISOString(), me, `Its file: ${String(upload.name || 'file').slice(0, 200)}`).run();
        await env.DB.prepare("UPDATE board_doc_versions SET file_id = ? WHERE doc_id = ? AND version = ? AND (body IS NULL OR body = '')").bind(put.id, d.id, d.version).run();
        let doc = (await listDocs(env.DB)).find((x) => x.id === d.id);
        // Its words read from this file: where they came from
        if (req.wordsFromNew) doc = await saveDoc(env.DB, { ...doc, body: undefined, wordsFile: put.id }, { by: me });
        await audit(env, me, 'updated', `Board document saved with a new file: ${doc.title}`);
        return Response.json({ ok: true, doc });
      }
      // A meeting's file only: a paper's file goes with its save (above), a signed copy with its signature, and a
      // signing record is the site's own
      if (String(form.get('ownerType') || '') !== 'meeting') return fail('Add a paper’s file from Documents, and a signed copy from Who’s signed', 400);
      const file = await putFile(env, {
        ownerType: 'meeting', ownerId: String(form.get('ownerId') || ''), file: form.get('file'),
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
        // One meeting a day: one already on that day opens instead, so the board never gets two invites for it
        const same = (await listMeetings(env.DB)).find((x) => x.date === body.date && !x.notBoard && !x.practice);
        if (same) return Response.json({ ok: true, meeting: same, existing: true });
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
        // What only the server sets never comes from the editor (where the agenda came from, who joined by Meet)
        const { agendaFrom, fromMeet, ...mine } = body.meeting || {};
        // Only an approved agenda goes on the board page
        await holdSharing(env.DB, mine);
        const m = await saveMeeting(env.DB, mine, { by: me, base: typeof body.base === 'string' ? body.base : null });
        // Typed minutes corrected here: the Word file kept with them says the same. (Never in the way of the save)
        if (m.minutesFrom?.typed) await refreshMinutesFile(env, m.id).catch(() => {});
        // A practice meeting is the admins' alone: nothing for the audit log
        if (m.practice) return Response.json({ ok: true, meeting: m });
        await audit(env, me, 'updated', `Board meeting saved: ${meetingName(m)}`);
        // An invite already out follows a new place, once it has settled (./_board-invite.js)
        if (m.invite) await noteInviteChange(env, m);
        return Response.json({ ok: true, meeting: m });
      }
      case 'delete-meeting': {
        needId();
        const m = await getMeeting(env.DB, id);
        // Its invite comes off the board's calendars first (Google tells them): should Google refuse, nothing is deleted
        const cancelled = await cancelInvite(env, m);
        await deleteMeeting(env, id);
        await audit(env, me, 'deleted', `Board meeting deleted: ${m ? meetingName(m) : id}${cancelled ? ', its calendar invite cancelled' : ''}`);
        return Response.json({ ok: true, cancelled });
      }
      case 'keep-agenda': {
        // The draft agenda, as it is, becomes the meeting's (an emailed agenda no longer replaces it)
        needId();
        const m = await patchMeeting(env.DB, id, (cur) => ({ ...cur, agendaFrom: { kind: 'typed', name: '', at: new Date().toISOString() } }));
        if (!m) throw Object.assign(new Error('That meeting is gone'), { status: 404 });
        return Response.json({ ok: true, meeting: m });
      }
      case 'snapshot': {
        needId();
        return Response.json({ ok: true, meeting: await takeSnapshot(env, id, { by: me }) });
      }
      case 'approve-agenda': {
        // Board's own way to approve, the same as on the chair's review: it's what sends the agenda to the board
        needId();
        const r = await chairApprove(env, { meetingId: id }, { admin: true, adminEmail: me }, { always: true });
        const m = await getMeeting(env.DB, id);
        if (!r.already) await audit(env, me, 'updated', `Board agenda approved: ${meetingName(m)}`);
        return Response.json({ ok: true, ...r, meeting: m, approvals: await agendaApprovals(env.DB) });
      }
      case 'send-packet': {
        needId();
        const admins = (await getSettings(env.DB)).admins;
        const r = await sendPacket(env, id, { by: me, to: body.test ? [me] : null, replyTo: admins });
        if (!body.test && r.sent) await audit(env, me, 'updated', `Board emailed the link to the agenda and documents (${r.sent} board members)`);
        return Response.json({ ok: r.failed === 0, ...r, meeting: await getMeeting(env.DB, id), ...(r.failed ? { error: r.errors[0] || 'Some emails didn’t go' } : {}) });
      }
      case 'action-done':
        return Response.json({ ok: true, ...(await setActionDone(env.DB, String(body.actionId || ''), !!body.done, { by: me })) });
      case 'save-doc': {
        const d = await saveDoc(env.DB, body.doc || {}, docOptions(body, me));
        await audit(env, me, 'updated', `Board document saved: ${d.title}`);
        return Response.json({ ok: true, doc: d });
      }
      case 'delete-doc': {
        needId();
        await deleteDoc(env, id);
        await audit(env, me, 'deleted', 'Board document deleted');
        return Response.json({ ok: true });
      }
      case 'doc-versions':
        needId();
        return Response.json({ ok: true, versions: await docVersions(env.DB, id) });
      case 'unsign': {
        const docId = String(body.docId || '');
        if (!ID.test(docId)) return fail('Which document?');
        const reason = String(body.reason || '').slice(0, 500);
        const off = await unsignDoc(env, docId, String(body.slug || ''), undefined, { by: me, evidence: evidence(context), reason });
        if (!off) return fail('That signature is gone', 404);
        await audit(env, me, 'deleted', 'Board signature taken off');
        // A signature they gave themselves (typed, drawn, their own copy) taken off: they're told (a copy filed under
        // the wrong member isn't theirs to hear about)
        if (['typed', 'drawn', 'copy'].includes(off.row.how)) {
          context.waitUntil?.((async () => {
            const who = (await activeBoard(env.DB)).find((p) => p.slug === off.row.slug);
            const doc = (await listDocs(env.DB)).find((d) => d.id === docId);
            if (!who?.email || !doc) return;
            const r = await sendEmailOne(env, { to: who.email, from: EMAIL_FROM.replace(/^[^<]*/, 'SOARD Board '), replyTo: (await getSettings(env.DB)).admins, tags: [{ name: 'kind', value: 'board-void' }], idempotencyKey: `void:${docId}:${off.row.slug}:${off.row.year}:${off.row.at}`, ...voidEmail({ doc, year: off.row.year, reason }) });
            if (r.sent || r.already) await appendEvents(env.DB, async () => ({ events: [{ kind: 'void-sent', docId, slug: off.row.slug, year: off.row.year, by: me, detail: { to: who.email } }] }));
          })().catch(() => {}));
        }
        return Response.json({ ok: true, doc: (await listDocs(env.DB)).find((d) => d.id === docId) });
      }
      case 'update-file':
        needId();
        return Response.json({ ok: true, file: await updateFile(env.DB, id, { kind: body.kind, staffOnly: body.staffOnly, name: body.name }) });
      case 'delete-file': {
        needId();
        // (a signed copy, a record, or a signed paper's file is SOARD's record: kept)
        const locked = await fileLocked(env.DB, id);
        if (locked) return fail(locked, 409, { kept: true });
        await deleteFile(env, id);
        await audit(env, me, 'deleted', 'Board file deleted');
        return Response.json({ ok: true });
      }
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
      case 'read-minutes': {
        // The minutes, uploaded after the meeting: who was there, the notes under each item, the motions and the
        // action items read in by themselves (./_board-minutes.js), the last meeting's minutes approved when they say so
        needId();
        let r;
        try {
          r = await readMinutesInto(env, id, String(body.fileId || ''), { by: me, dry: body.dry === true, anyway: body.anyway === true });
        } catch (err) {
          // Another meeting's minutes, by their heading or file name: say whose, and read them in only when asked again with anyway
          if (err.status === 409 && err.other) return fail(err.message, 409, { other: err.other, fileId: err.fileId });
          throw err;
        }
        if (!r.dry) await audit(env, me, 'updated', `Board minutes read in: ${meetingName(r.meeting)}`);
        return Response.json({ ok: true, ...r });
      }
      case 'send-invite': {
        needId();
        const m = await sendInvite(env, id, { by: me });
        await audit(env, me, 'updated', `Board meeting invite sent or updated: ${meetingName(m)}`);
        return Response.json({ ok: true, meeting: m });
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
      case 'ask-to-sign': {
        // An email asking each board member picked (none: the whole board) who hasn't signed this year's papers to;
        // `test`: to the admin asking only. Their codes have to come: a member added minutes ago is put on Access's list first
        const admins = (await getSettings(env.DB)).admins;
        if (!body.test && accessConfigured(env)) {
          let st = await accessStatus(env);
          if (!st.current || !st.ok) st = await syncBoardAccess(env);
          if (!st.ok) return Response.json({ ok: false, sent: 0, error: `Cloudflare doesn’t have the board’s addresses yet (${String(st.error || 'it didn’t answer').replace(/^Cloudflare \w+ \S+: /, '')}), so their sign-in codes wouldn’t come. Try again in a minute.` }, { status: 503 });
          if (!st.attached) return Response.json({ ok: false, sent: 0, error: 'The board’s sign-in list isn’t on the admin app in Cloudflare (Board access), so their sign-in codes wouldn’t come.' }, { status: 409 });
        }
        let r;
        try {
          const going = askToSign(env, { slugs: Array.isArray(body.slugs) ? body.slugs.map(String) : null, by: me, replyTo: admins, to: body.test ? [me] : null });
          // Finished even if the page goes away mid-send, so the emails and the record always match
          context.waitUntil?.(going.catch(() => {}));
          r = await going;
        } catch (err) {
          if (err.status) return Response.json({ ok: false, sent: 0, error: err.message }, { status: err.status });
          throw err;
        }
        if (!body.test && r.sent) await audit(env, me, 'updated', `Board asked ${r.sent === 1 ? 'a board member' : `${r.sent} board members`} by email to sign this year’s papers`);
        return Response.json({ ok: r.failed === 0, ...r, ...(body.test ? {} : { members: await memberStatus(env.DB) }), ...(r.failed ? { error: r.errors[0] || 'Some emails didn’t go' } : {}) });
      }
      case 'send-welcome': {
        const admins = (await getSettings(env.DB)).admins;
        // Only once their codes will come: a member added minutes ago is put on Access's list now (not at the next
        // heartbeat), and the list has to be on the admin app. Checked inside the send's claim, so the page shows it going out
        const check = body.test || !accessConfigured(env) ? null : async () => {
          let st = await accessStatus(env);
          if (!st.current || !st.ok) st = await syncBoardAccess(env);
          if (!st.ok) throw Object.assign(new Error(`Cloudflare doesn’t have the board’s addresses yet (${String(st.error || 'it didn’t answer').replace(/^Cloudflare \w+ \S+: /, '')}), so their codes wouldn’t come. Try again in a minute.`), { status: 503 });
          if (!st.attached) throw Object.assign(new Error('The board’s sign-in list isn’t on the admin app in Cloudflare (Board access), so their codes wouldn’t come.'), { status: 409 });
        };
        let r;
        try {
          const going = sendWelcome(env, { to: body.test ? [me] : null, slugs: Array.isArray(body.slugs) ? body.slugs.map(String) : null, due: body.due === true, again: body.again === true, check, replyTo: admins, by: me, click: typeof body.click === 'string' ? body.click : '' });
          // Finished even if the page goes away mid-send, so the emails and the record always match
          context.waitUntil?.(going.catch(() => {}));
          r = await going;
        } catch (err) {
          if (err.status) return Response.json({ ok: false, sent: 0, error: err.message }, { status: err.status });
          throw err;
        }
        if (!body.test && r.sent) await audit(env, me, 'updated', `Board page sign-in email sent to ${r.sent} board members`);
        // Who has it now, with the answer: the page shows it even if its next look is dropped
        return Response.json({ ok: r.failed === 0, ...r, ...(body.test ? {} : await welcomeNow(env.DB)), ...(r.failed ? { error: r.errors[0] || 'Some emails didn’t go' } : {}) });
      }
      case 'practice':
        return Response.json({ ok: true, meeting: await createPractice(env, { by: me }) });
      case 'practice-reset':
        needId();
        return Response.json({ ok: true, meeting: await resetPractice(env, id, { by: me }) });
      case 'sync-access':
        return Response.json({ ok: true, access: { ...(await syncBoardAccess(env)), ...(await accessStatus(env)) } });
      // A shorter version of a report being written in the agenda (nothing saved; the item may not be saved yet)
      case 'report-shorter':
        return Response.json(await shorterFor(env, { id, itemId: String(body.itemId || ''), text: body.text, title: String(body.title || '') }, { admin: true, adminEmail: me }));
      case 'sync-group':
        await syncBoardGroup(env);
        return Response.json({ ok: true, group: await groupStatus(env) });
      default:
        return fail('Unknown action');
    }
  } catch (err) {
    return fromError(err);
  }
}
