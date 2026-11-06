/**
 * /api/advisory-action — the buttons in the monthly ask's email
 * =====================================================================
 * Public (no sign-in, so it works from a phone): each link carries a token for one
 * ask and one advisor (./_advisory-mail.js; D1 keeps only its hash, and it works for
 * 30 days). GET only shows the question, because mail scanners open links on their
 * own; the answer is saved when a person presses the button (POST).
 *   ?t=<token>&do=yes   I can help
 *   ?t=<token>&do=no    Not this time
 */

import { linkFrom, answerFromLink, noticeLead } from './_advisory-mail.js';
import { escapeHtml, SITE_ORIGIN } from './_broadcast-notify.js';
import { ensureAdvisory } from './_advisory.js';
import { peopleRows } from './_board-roles.js';

function page(title, body, { status = 200 } = {}) {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>${escapeHtml(title)} · SOARD Advisory Board</title>
<style>
@font-face{font-family:Outfit;src:url(/fonts/outfit-latin-variable.woff2) format('woff2');font-weight:100 900;font-display:swap}
@font-face{font-family:'Libre Baskerville';src:url(/fonts/libre-baskerville-latin-700-normal.woff2) format('woff2');font-weight:700;font-display:swap}
*{box-sizing:border-box}body{margin:0;background:#F5F4F0;color:#2D2E33;font:400 17px/1.55 Outfit,system-ui,sans-serif;padding:32px 16px}
main{max-width:520px;margin:0 auto;background:#FEFCF5;border:1px solid #E5E4E0;border-radius:14px;padding:28px}
h1{font:700 24px/1.25 'Libre Baskerville',Georgia,serif;margin:0 0 10px}p{margin:0 0 14px}
textarea{width:100%;min-height:96px;font:inherit;padding:10px 12px;border:1px solid #D4D2CB;border-radius:10px;background:#fff;color:inherit}
label{display:block;font-weight:600;margin:0 0 6px}
button,a.b{display:inline-block;font:600 16px Outfit,sans-serif;background:#FFDA24;color:#2D2E33;border:0;border-radius:999px;padding:12px 24px;margin-top:14px;text-decoration:none;cursor:pointer}
button:focus-visible,a.b:focus-visible,textarea:focus-visible{outline:3px solid #2D2E33;outline-offset:2px}
</style></head><body><main>${body}</main></body></html>`, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer' } });
}
const gone = () => page('This link has expired', `<h1>This link has expired</h1><p>You can still answer on the Advisory Board page.</p><a class="b" href="${SITE_ORIGIN}/admin/advisory/">Open the page</a>`, { status: 410 });

async function askOf(DB, id) {
  const row = await DB.prepare('SELECT data, closed_at FROM advisory_asks WHERE id = ?').bind(id).first();
  if (!row) return null;
  try { return { ...JSON.parse(row.data), closed: !!row.closed_at }; } catch { return null; }
}

export async function onRequestGet({ env, request }) {
  const q = new URL(request.url).searchParams;
  const t = q.get('t') || '';
  const yes = q.get('do') === 'yes';
  await ensureAdvisory(env.DB);
  const link = await linkFrom(env.DB, t);
  const ask = link && await askOf(env.DB, link.askId);
  if (!ask) return gone();
  if (ask.closed) return page('That ask has closed', `<h1>That ask has closed</h1><p>Thank you for looking. Your page always has what’s current.</p><a class="b" href="${SITE_ORIGIN}/admin/advisory/">Open the page</a>`);
  return page(ask.title, `<h1>${escapeHtml(ask.title)}</h1>${ask.body ? `<p>${escapeHtml(ask.body)}</p>` : ''}
<form method="post"><input type="hidden" name="t" value="${escapeHtml(t)}"><input type="hidden" name="do" value="${yes ? 'yes' : 'no'}">
<label for="note">${yes ? 'Anything to add? (you can leave this blank)' : 'Want to say why? (you can leave this blank)'}</label><textarea id="note" name="note" maxlength="800"></textarea>
<button type="submit">${yes ? 'Yes, I can help' : 'Not this time'}</button></form>`);
}

export async function onRequestPost(context) {
  const { env, request } = context;
  await ensureAdvisory(env.DB);
  const form = await request.formData().catch(() => null);
  const answer = form?.get('do') === 'yes' ? 'yes' : 'no';
  try {
    const r = await answerFromLink(env.DB, String(form?.get('t') || ''), { answer, note: String(form?.get('note') || '') });
    if (answer === 'yes') {
      const who = (await peopleRows(env.DB)).find((p) => p.slug === r.slug);
      const told = noticeLead(env, { kind: 'answer', who: { name: who?.name || '' }, note: r.note });
      if (context.waitUntil) context.waitUntil(told); else await told;
    }
    return page('Thank you', `<h1>Thank you</h1><p>${answer === 'yes' ? 'We’ll be in touch.' : 'Thanks for letting us know.'}</p>`);
  } catch (e) {
    if (e.status === 410) return gone();
    return page('That didn’t go through', `<h1>That didn’t go through</h1><p>${escapeHtml(e.message)}</p>`, { status: e.status || 500 });
  }
}
