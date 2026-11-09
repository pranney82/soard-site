/**
 * /api/advisory-admin (Cloudflare Access) — running the Advisory Board
 *
 * For whoever runs the group: the board member named in settings.lead (Mary Atchley, who signs in on the advisors' page)
 * and the Board area's admins (Peter, Holly, from the switch at the top of Board). The same module draws it for both:
 * public/admin/advisory-admin.js. Everyone else gets 403, committee members and advisors included.
 *
 * GET                                  → everything it shows
 * GET ?zeffyForms=1                    → { ok, forms }  the forms in SOARD's Zeffy, for its Zeffy link dropdowns (./_zeffy-forms.js)
 * POST { action, ... }                 see the cases below
 * POST multipart (file + docId)        a paper's file (advisory_docs); (file + meetingId) a meeting's (./_advisory-meetings.js)
 */

import {
  whoIs, getSettings, saveSettings, listAsks, saveAsk, putAskOut, closeAsk, deleteAsk, answersTo, listWishes, saveWish, deleteWish, listIntros, setIntroStatus,
  listHosted, setHosted, allTerms, setTerm, listDocs, saveDoc, deleteDoc, signatures, missingEmails, isId, webLink, DOC_KINDS, INTRO_STATUSES, INTRO_HELP, HOSTED_STATUSES, GROUP_ADDRESS, SHELVES } from './_advisory.js';
import { activeAdvisors, peopleRows, readState } from './_board-roles.js';
import { putFile, deleteFile, boardFileProblem } from './_board.js';
import { logAudit } from './_audit.js';
import { moneyView, goalNow, creditGift, uncreditGift, matchPage, findGifts, campaignFromUrl } from './_advisory-money.js';
import { pickableKids, pickKid, clearKid, kidCard } from './_advisory-sponsor.js';
import { sendAsk, sendIntroUpdate, sendHostUpdate, sendWelcome, mailLog, welcomedSlugs } from './_advisory-mail.js';
import { adminMeetings, meetingAction } from './_advisory-meetings.js';
import { advisoryBits, sharableBoardDocs } from './_board.js';
import { boardPapers } from './_advisory-portal.js';
import { seedOnce } from './_advisory-seed.js';
import { advisoryGroupStatus, syncAdvisoryGroup } from './_board-group.js';
import { zeffyForms } from './_zeffy-forms.js';

const fail = (error, status = 400) => Response.json({ ok: false, error }, { status });
const fromError = (e) => {
  if (e.current) return Response.json({ ok: false, error: e.message, current: e.current }, { status: e.status });
  // (a 503 is ours and says what's missing: "Zeffy isn't connected")
  if (e.status && (e.status < 500 || e.status === 503)) return fail(e.message, e.status);
  console.error('[advisory]', e?.message || e);
  return Response.json({ ok: false, error: 'That didn’t go through. Try again in a moment.' }, { status: 500 });
};
const REFUSED = 'Only the people who run the Advisory Board can open this';
const OVERVIEW_KEY = 'advisory/SOARD_Advisory Board Overview.docx.pdf';
const OVERVIEW_URL = 'https://files.sunshineonaranneyday.com/advisory/SOARD_Advisory%20Board%20Overview.docx.pdf';

async function gate(context) {
  const w = await whoIs(context);
  if (!w?.runs) return { refused: fail(REFUSED, 403) };
  return { w, by: w.email || w.name || '' };
}
const audit = (context, by, action, what) => logAudit(context.env.DB, { userEmail: by, action, entityType: 'advisory-board', entitySlug: 'advisory', entityName: what, path: '/api/advisory-admin' }).catch(() => {});

/** The last time each advisor signed in, from what Board's activity keeps */
async function lastSeen(DB) {
  try {
    const rows = (await DB.prepare('SELECT slug, MAX(at) AS at FROM board_signins GROUP BY slug').all()).results || [];
    return Object.fromEntries(rows.map((r) => [r.slug, r.at]));
  } catch { return {}; }
}

export async function onRequestGet(context) {
  const { env } = context;
  try {
    const { w, refused } = await gate(context);
    if (refused) return refused;
    // The Zeffy form dropdowns (public/admin/zeffy-forms.js): the staff route is out of reach from the advisors' page
    if (new URL(context.request.url).searchParams.get('zeffyForms')) return Response.json({ ok: true, forms: await zeffyForms(env) });
    await seedOnce(env.DB, () => sharableBoardDocs(env.DB));
    await boardPapers(env.DB, await getSettings(env.DB));
    const settings = await getSettings(env.DB);
    const [advisors, people, term, seen, sigs, missing, docs, asks, wishes, intros, hosted, money, bits, group, meetings, kids, log] = await Promise.all([
      activeAdvisors(env.DB), peopleRows(env.DB), allTerms(env.DB, settings), lastSeen(env.DB), signatures(env.DB), missingEmails(env.DB), listDocs(env.DB), listAsks(env.DB),
      listWishes(env.DB), listIntros(env.DB), listHosted(env.DB), moneyView(env, settings), advisoryBits(env), advisoryGroupStatus(env).catch(() => null),
      adminMeetings(env), pickableKids(env), mailLog(env.DB).catch(() => []),
    ]);
    const nameOf = (slug) => people.find((p) => p.slug === slug)?.name || '';
    const withAnswers = await Promise.all(asks.map(async (a) => ({ ...a, mailed: log.some((l) => l.kind === 'ask' && l.id === a.id && l.sent > 0), answers: (await answersTo(env.DB, a.id)).map((r) => ({ ...r, name: nameOf(r.slug) })) })));
    return Response.json({
      ok: true,
      me: { kind: w.kind, name: w.name || '' },
      settings,
      leadName: nameOf(settings.lead),
      groupEmail: GROUP_ADDRESS,
      group,
      advisors: advisors.map((a) => ({ slug: a.slug, name: a.name, email: a.email, photo: a.photo || '', organization: a.organization || '', term: term(a.slug), lastSeen: seen[a.slug] || '', signed: Object.fromEntries(Object.entries(sigs).map(([id, by]) => [id, by[a.slug] || null])) })),
      missing,
      board: people.filter((p) => p.group === 'board' && p.status === 'active').map((p) => ({ slug: p.slug, name: p.name, committees: p.committees || [] })),
      docs, docKinds: DOC_KINDS, shelves: SHELVES, boardDocs: await sharableBoardDocs(env.DB),
      asks: withAnswers,
      wishes,
      intros: intros.map((i) => ({ ...i, by: nameOf(i.slug) })), introStatuses: INTRO_STATUSES, introHelp: INTRO_HELP,
      hosted: hosted.map((h) => ({ ...h, by: nameOf(h.slug) })), hostedStatuses: HOSTED_STATUSES,
      money,
      kids,
      makeover: await kidCard(env, settings, bits),
      meetings,
      mail: log,
      welcomed: await welcomedSlugs(env.DB),
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) { return fromError(e); }
}

export async function onRequestPost(context) {
  const { env, request } = context;
  try {
    const { w, by, refused } = await gate(context);
    if (refused) return refused;
    if ((request.headers.get('Content-Type') || '').includes('multipart/form-data')) {
      const form = await request.formData();
      const upload = form.get('file');
      const why = await boardFileProblem(upload);
      if (why) return fail(String(why).replace(/Board files?/g, 'Files'), 415);
      // The public overview the /advisory-board/ page links to, replaced in place (same address, a PDF only)
      if (form.get('overview')) {
        const bytes = await upload.arrayBuffer();
        // By what the file is, not what it's called
        if (new TextDecoder().decode(bytes.slice(0, 5)) !== '%PDF-') return fail('The overview has to be a PDF', 415);
        await env.FILES.put(OVERVIEW_KEY, bytes, { httpMetadata: { contentType: 'application/pdf' } });
        await audit(context, by, 'updated', 'Advisory Board overview PDF replaced');
        return Response.json({ ok: true, overview: OVERVIEW_URL });
      }
      const docId = String(form.get('docId') || '');
      if (docId) {
        if (!isId(docId)) return fail('Which paper?');
        const file = await putFile(env, { ownerType: 'advisory-doc', ownerId: docId, file: upload, by });
        await audit(context, by, 'created', `Advisory paper file added: ${file.name}`);
        return Response.json({ ok: true, file });
      }
      return await meetingAction(context, { action: 'upload', form, by, w });
    }
    let body = {};
    try { body = await request.json(); } catch { return fail('Expected JSON'); }
    const id = String(body.id || '');
    const settings = await getSettings(env.DB);
    switch (body.action) {
      case 'save-settings': {
        const s = body.settings || {};
        // Only what a person sets here. The kid goes through Pick the kid, and pages through their own action
        const patch = Object.fromEntries(['goal', 'termStart', 'termEnd', 'emails', 'campaignId', 'campaignUrl'].filter((k) => k in s).map((k) => [k, s[k]]));
        if ('lead' in s && s.lead !== settings.lead) {
          if (w.kind !== 'admin') return fail('Only Peter or Holly can change who runs the group', 403);
          const person = (await peopleRows(env.DB)).find((p) => p.slug === s.lead && p.group === 'board' && p.status === 'active');
          if (!person) return fail('Pick an active board member');
          patch.lead = person.slug;
        }
        // The address is enough: its id comes from Zeffy
        if (patch.campaignUrl && patch.campaignUrl !== settings.campaignUrl && !patch.campaignId) {
          const found = await campaignFromUrl(env, webLink(patch.campaignUrl));
          if (found === '') return fail('That address isn’t a campaign in SOARD’s Zeffy. Check the link and try again.');
          // Never the old campaign's ID beside a new address: with Zeffy not answering it waits for the next Save
          if (found === null && env.ZEFFY_API_KEY) return fail('Zeffy didn’t answer, so the site couldn’t check that address. Try Save again in a minute.', 503);
          patch.campaignId = found || '';
        }
        const next = await saveSettings(env.DB, patch);
        await audit(context, by, 'updated', 'Advisory settings');
        return Response.json({ ok: true, settings: next });
      }
      case 'save-ask': return Response.json({ ok: true, ask: await saveAsk(env.DB, body.ask || {}, { by }) });
      case 'send-ask': {
        // The switch as it stands now, not as this screen last saw it: nobody emails the group by surprise
        if (settings.emails && body.emailsOk !== true) return Response.json({ ok: false, emails: true, error: 'Emails are on, so this will email every advisor.' }, { status: 409 });
        const ask = await putAskOut(env.DB, id);
        const sent = settings.emails ? await sendAsk(env, ask) : { off: true };
        await audit(context, by, 'updated', `Advisory ask out: ${ask.title}`);
        return Response.json({ ok: true, ask, sent });
      }
      case 'email-ask': {
        // One that went out while emails were off, or whose send failed
        const ask = (await listAsks(env.DB)).find((a) => a.id === id);
        if (!ask?.sentAt || ask.closedAt) return fail('That ask isn’t out', 409);
        return Response.json({ ok: true, sent: await sendAsk(env, ask) });
      }
      case 'close-ask': await closeAsk(env.DB, id); return Response.json({ ok: true });
      case 'delete-ask': await deleteAsk(env.DB, id); await audit(context, by, 'deleted', 'Advisory ask'); return Response.json({ ok: true });
      case 'save-wish': return Response.json({ ok: true, wish: await saveWish(env.DB, body.wish || {}, { by }) });
      case 'delete-wish': await deleteWish(env.DB, id); return Response.json({ ok: true });
      case 'intro-status': {
        const { intro, changed } = await setIntroStatus(env.DB, id, body, { by });
        const sent = changed && settings.emails ? await sendIntroUpdate(env, intro) : null;
        return Response.json({ ok: true, intro, sent });
      }
      case 'hosted-status': {
        const { hosted, changed } = await setHosted(env.DB, id, body, { by });
        const sent = changed && settings.emails ? await sendHostUpdate(env, hosted) : null;
        await audit(context, by, 'updated', `Advisory fundraiser ${hosted.status}: ${hosted.title}`);
        return Response.json({ ok: true, hosted, sent });
      }
      case 'set-term': return Response.json({ ok: true, term: await setTerm(env.DB, String(body.slug || ''), body, settings) });
      case 'save-doc': {
        const doc = await saveDoc(env.DB, body.doc || {}, { by, base: body.base || null });
        await audit(context, by, 'updated', `Advisory paper saved: ${doc.title}`);
        return Response.json({ ok: true, doc });
      }
      case 'delete-doc': {
        // Its files go with it: nothing of a deleted paper stays where someone could open it
        const files = (await env.DB.prepare("SELECT id FROM board_files WHERE owner_type = 'advisory-doc' AND owner_id = ?").bind(id).all()).results || [];
        for (const f of files) await deleteFile(env, f.id);
        await deleteDoc(env.DB, id);
        await audit(context, by, 'deleted', 'Advisory paper');
        return Response.json({ ok: true });
      }
      case 'board-doc': {
        // One paper at a time, so a stale tab can't undo someone else's switch. Only a paper that can be shared: never one
        // the board signs, a written one, or a staff-only file
        const on = body.on === true;
        if (on && !(await sharableBoardDocs(env.DB)).some((d) => d.id === id)) return fail('That paper can’t be shared with advisors');
        const ids = new Set(settings.boardDocs || []);
        if (on) ids.add(id); else ids.delete(id);
        const next = await saveSettings(env.DB, { boardDocs: [...ids] });
        await audit(context, by, 'updated', `Advisors ${on ? 'can open' : 'can no longer open'} a board paper`);
        return Response.json({ ok: true, boardDocs: next.boardDocs });
      }
      case 'delete-file': {
        // Only a paper of the advisors': this route must never reach a board file
        const row = await env.DB.prepare("SELECT id FROM board_files WHERE id = ? AND owner_type = 'advisory-doc'").bind(id).first();
        if (!row) return fail('That file is gone', 404);
        await deleteFile(env, id);
        return Response.json({ ok: true });
      }
      case 'credit': return Response.json({ ok: true, money: await creditGift(env, settings, body, { by }) });
      case 'uncredit': return Response.json({ ok: true, money: await uncreditGift(env, settings, body) });
      case 'match-page': return Response.json({ ok: true, money: await matchPage(env, settings, body) });
      case 'find-gifts': return Response.json({ ok: true, gifts: await findGifts(env, settings, body) });
      case 'pick-kid': {
        const out = await pickKid(env, settings, String(body.kid || ''), { by, raised: (await goalNow(env, settings)).raised });
        await audit(context, by, 'updated', `Advisory Board makeover picked: ${body.kid}`);
        return Response.json({ ok: true, ...out });
      }
      case 'clear-kid': {
        const out = await clearKid(env, settings, { by });
        await audit(context, by, 'updated', 'Advisory Board makeover cleared');
        return Response.json({ ok: true, ...out });
      }
      case 'send-welcome': return Response.json({ ok: true, ...(await sendWelcome(env, { by, slugs: body.slugs })) });
      case 'sync-group': return Response.json({ ok: true, group: await syncAdvisoryGroup(env) });
      default:
        return await meetingAction(context, { action: body.action, body, by, w });
    }
  } catch (e) { return fromError(e); }
}
