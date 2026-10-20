/**
 * /api/applicant-email-action — the buttons in a status summary email
 * =====================================================================
 * Public (no sign-in, so it works from a phone): each link carries the
 * one-time token of one status change (./_applicant-notify.js). GET only
 * shows what would happen, because mail scanners open links on their own;
 * the change happens when a person presses the button (POST).
 *   ?t=<token>&do=back  move the status back in JobTread (no email)
 *   ?t=<token>&do=skip  don't email the family about this status
 *   ?t=<token>&do=send  send the email now
 */

import { linkAction, linkPreview } from './_applicant-notify.js';
import { escapeHtml, SITE_ORIGIN } from './_broadcast-notify.js';

const ACTIONS = ['back', 'skip', 'send'];

function page(title, body, { status = 200 } = {}) {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${escapeHtml(title)} · Sunshine on a Ranney Day</title>
<style>
body{margin:0;background:#F5F4F0;font:16px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;color:#373A36}
main{max-width:460px;margin:12vh auto 0;padding:0 16px}
.card{background:#fff;border:1px solid #E5E4E0;border-radius:16px;padding:28px 24px;box-shadow:0 6px 16px -4px rgba(26,27,31,.08)}
.brand{font-size:13px;font-weight:700;letter-spacing:.02em;color:#7A5C00;margin:0 0 10px}
h1{font-size:22px;line-height:1.25;margin:0 0 10px}
p{margin:0 0 16px;color:#5A5B61}
button,.btn{display:inline-block;font:inherit;font-weight:700;border:0;border-radius:999px;padding:12px 22px;cursor:pointer;text-decoration:none;min-height:44px}
button{background:#FFDA24;color:#373A36}
.btn{background:#F1F0EC;color:#373A36;margin-left:8px}
button:focus-visible,.btn:focus-visible{outline:3px solid #373A36;outline-offset:2px}
</style></head><body><main><div class="card"><p class="brand">Sunshine on a Ranney Day · Applications</p>${body}</div></main></body></html>`, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
  });
}

const adminLink = (id) => `<a class="btn" href="${SITE_ORIGIN}/admin/#applications/applicants/${encodeURIComponent(id || '')}">Open in the admin</a>`;
const gone = () => page('Already handled', '<h1>Already handled</h1><p>This change was already handled, or the status has changed again since. The admin shows where things stand.</p>' + adminLink(''), { status: 410 });

export async function onRequestGet({ request, env }) {
  if (!env.DB) return page('Unavailable', '<h1>Not available right now</h1><p>Please try again in a minute.</p>', { status: 500 });
  const url = new URL(request.url);
  const tok = url.searchParams.get('t') || '';
  const act = url.searchParams.get('do') || '';
  if (!ACTIONS.includes(act)) return page('Not found', '<h1>This link isn’t complete</h1><p>Open the family in the admin instead.</p>' + adminLink(''), { status: 400 });
  const row = await linkPreview(env, tok);
  if (!row || (act !== 'back' && !row.kind)) return gone();
  const name = escapeHtml(row.name || 'this family');
  const label = escapeHtml(row.label || row.status);
  const copy = {
    back: [`Move ${name} back to ${escapeHtml(row.previous || '')}?`, `This changes the status in JobTread${row.kind ? ` and cancels the ${label} email` : ''}. The family isn’t told anything.`, 'Move back'],
    skip: [`Don’t email ${name}’s family?`, `${name} stays ${escapeHtml(row.status)} in JobTread, but the ${label} email won’t go out. Use this when the family already knows.`, 'Don’t email'],
    send: [`Send the ${label} email now?`, `${name}’s family gets it right away instead of waiting.`, 'Send now'],
  }[act];
  if (act === 'back' && !row.previous) return gone();
  return page(copy[0], `<h1>${copy[0]}</h1><p>${copy[1]}</p><form method="post"><input type="hidden" name="t" value="${escapeHtml(tok)}"><input type="hidden" name="do" value="${act}"><button type="submit">${copy[2]}</button>${adminLink(row.account_id)}</form>`);
}

export async function onRequestPost({ request, env }) {
  if (!env.DB || !env.JOBTREAD_GRANT_KEY) return page('Unavailable', '<h1>Not available right now</h1><p>Please try again in a minute.</p>', { status: 500 });
  let tok = '';
  let act = '';
  try {
    const form = await request.formData();
    tok = String(form.get('t') || '');
    act = String(form.get('do') || '');
  } catch { /* fall through to the error page */ }
  if (!ACTIONS.includes(act)) return page('Not found', '<h1>This link isn’t complete</h1>', { status: 400 });
  const preview = await linkPreview(env, tok);
  let out;
  try {
    out = await linkAction(env, tok, act);
  } catch (e) {
    return page('Something went wrong', `<h1>That didn’t work</h1><p>${escapeHtml(e.message)}. Nothing was sent to the family. Try again from the admin.</p>${adminLink(preview?.account_id)}`, { status: 500 });
  }
  if (out.gone) return gone();
  if (!out.ok) return page('Not done', `<h1>Not done</h1><p>${escapeHtml(out.error || 'That didn’t work.')}</p>${adminLink(preview?.account_id)}`, { status: 409 });
  const name = escapeHtml(out.name || preview?.name || 'The family');
  const done = {
    back: `${name} is back to ${escapeHtml(out.status || preview?.previous || '')} in JobTread. No email was sent.`,
    skip: `${name}’s family won’t be emailed about ${escapeHtml(preview?.status || 'this')}.`,
    send: out.result === 'already' ? `${name}’s family already had this email, so it wasn’t sent again.` : `The email went to ${name}’s family just now.`,
  }[act];
  return page('Done', `<h1>Done</h1><p>${done}</p>${adminLink(preview?.account_id)}`);
}
