/**
 * /api/email-words-admin — "Edit words" on the emails the site drafts in Kit by itself
 * =====================================================================
 * Behind Cloudflare Access (not in the middleware's public list).
 *
 * GET  ?key=<email>              → { ok, key, kind, what, parts, words, by, at, siteWords, email, block }
 *        the email's own parts, the words saved for it, the site's own words (what an empty box keeps)
 *        and the email as it would be drafted now
 * POST { key, words, preview: true } → { ok, email }  the email with these words, nothing saved
 * POST { key, words }            → { ok, words, by, at, result, message, email }  saved, and an untouched
 *        draft already in Kit brought up to date; none in Kit yet takes them when it's drafted
 *
 * The work is ./_email-words-draft.js (shared with the SOARD connection for
 * Claude); keys and parts: ./_email-words.js.
 */

import { parseWordsKey } from './_email-words.js';
import { emailWordsView, emailWordsPreview, saveEmailWords } from './_email-words-draft.js';

const NO_STORE = { 'Cache-Control': 'no-store' };
const fail = (error, status = 400) => Response.json({ ok: false, error }, { status, headers: NO_STORE });

export async function onRequestGet({ env, request }) {
  if (!env.DB) return fail('DB not bound', 500);
  const key = new URL(request.url).searchParams.get('key') || '';
  if (!parseWordsKey(key)) return fail('Not one of the emails');
  try {
    return Response.json({ ok: true, ...(await emailWordsView(env, key)) }, { headers: NO_STORE });
  } catch (err) {
    return fail(err.message, 500);
  }
}

export async function onRequestPost(context) {
  const { env, request } = context;
  if (!env.DB) return fail('DB not bound', 500);
  const me = context.data?.userEmail || '';
  if (!me.includes('@')) return fail('Could not tell who you are from Access', 403);
  let body;
  try { body = await request.json(); } catch { return fail('Bad request'); }
  const key = String(body?.key || '');
  if (!parseWordsKey(key)) return fail('Not one of the emails');
  try {
    if (body?.preview === true) {
      const p = await emailWordsPreview(env, key, body?.words || {});
      return p.email ? Response.json({ ok: true, email: p.email }, { headers: NO_STORE }) : fail(p.block, 409);
    }
    return Response.json({ ok: true, ...(await saveEmailWords(env, key, body?.words || {}, { by: me })) }, { headers: NO_STORE });
  } catch (err) {
    return fail(err.message, 500);
  }
}
