/**
 * /api/advisory-portal (Cloudflare Access) — the Advisory Board's page (/admin/advisory/)
 *
 * Who: an advisor (context.data.advisor), the board member who runs the group, a board member on its committee,
 * or one of the Board area's admins. Anyone else gets 403. (./_advisory.js whoIs)
 *
 * GET                                          → everything the page shows (./_advisory-portal.js)
 * POST { action: 'answer', askId, answer, note }   this month's ask: 'yes' or 'no', and a line of text if they like
 * POST { action: 'intro', name, company, email, phone, how, help, wish }   "I know someone"
 * POST { action: 'host', title, when, where, expected, notes }   a request to host a fundraiser (staff approve it)
 * POST { action: 'sign', docId, name }         the advisor agreement, with their own name typed
 * POST { action: 'renew' }                     another year, when the term is near its end
 * POST { action: 'activity', events, touch }   what they looked at (../../public/admin/board/activity.js)
 * Only an advisor answers, signs or introduces: someone looking on their behalf has no seat here.
 */

import { whoIs, answerAsk, addIntro, requestHost, signDoc, renew, getSettings } from './_advisory.js';
import { advisoryPortalData } from './_advisory-portal.js';
import { noticeLead } from './_advisory-mail.js';
import { noteGet, noteEvents } from './_board-activity.js';

const fail = (error, status = 400, extra = {}) => Response.json({ ok: false, error, ...extra }, { status });
const fromError = (e) => {
  if (e.status && e.status < 500) return fail(e.message, e.status, e.changed ? { changed: true } : {});
  console.error('[advisory]', e?.message || e);
  return Response.json({ ok: false, error: 'That didn’t go through. Try again in a moment.' }, { status: 500 });
};
const later = async (context, p) => { if (context.waitUntil) context.waitUntil(p); else await p; };
const REFUSED = 'The advisory page is for SOARD’s Advisory Board';

export async function onRequestGet(context) {
  try {
    const w = await whoIs(context);
    if (!w) return fail(REFUSED, 403);
    if (w.kind === 'advisor') await later(context, noteGet(context.env, w, context.request));
    return Response.json(await advisoryPortalData(context.env, w), { headers: { 'Cache-Control': 'no-store' } });
  } catch (e) { return fromError(e); }
}

export async function onRequestPost(context) {
  const { env, request } = context;
  try {
    const w = await whoIs(context);
    if (!w) return fail(REFUSED, 403);
    let body = {};
    try { body = await request.json(); } catch { return fail('Expected JSON'); }
    if (body.action === 'activity') {
      if (w.kind === 'advisor') await later(context, noteEvents(env, w, request, body));
      return Response.json({ ok: true });
    }
    if (!w.answers) return fail('Only an advisor can do this', 403);
    switch (body.action) {
      case 'answer': {
        const mine = await answerAsk(env.DB, String(body.askId || ''), w.slug, { answer: body.answer, note: body.note });
        if (mine.answer === 'yes') await later(context, noticeLead(env, { kind: 'answer', who: w, askId: body.askId, note: mine.note }));
        return Response.json({ ok: true, mine });
      }
      case 'intro': {
        const intro = await addIntro(env.DB, w.slug, body);
        await later(context, noticeLead(env, { kind: 'intro', who: w, intro }));
        return Response.json({ ok: true, intro: { id: intro.id, name: intro.name, company: intro.company, status: intro.status, at: intro.at, updatedAt: intro.updatedAt } });
      }
      case 'host': {
        const hosted = await requestHost(env.DB, w.slug, body);
        await later(context, noticeLead(env, { kind: 'host', who: w, hosted }));
        return Response.json({ ok: true, hosted: { id: hosted.id, title: hosted.title, status: hosted.status, when: hosted.when, note: '' } });
      }
      case 'sign':
        return Response.json({ ok: true, signed: await signDoc(env.DB, String(body.docId || ''), w, body.name, { version: body.version }) });
      case 'renew': {
        const term = await renew(env.DB, w.slug, await getSettings(env.DB));
        await later(context, noticeLead(env, { kind: 'renew', who: w, term }));
        return Response.json({ ok: true, term });
      }
      default: return fail('Unknown action');
    }
  } catch (e) { return fromError(e); }
}
