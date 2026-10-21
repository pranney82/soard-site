/**
 * /api/applicant-email-action — the buttons in a status summary email
 * =====================================================================
 * Public (no sign-in, so it works from a phone): each link carries the
 * one-time token of one status change (./_applicant-notify.js; D1 keeps only
 * its hash, and it works for 7 days). GET only
 * shows what would happen, because mail scanners open links on their own;
 * the change happens when a person presses the button (POST).
 *   ?t=<token>&do=back  move the status back in JobTread (no email)
 *   ?t=<token>&do=skip  don't email the family about this status
 *   ?t=<token>&do=send  send the email now
 */

import { linkAction, linkPreview } from './_applicant-notify.js';
import { escapeHtml, SITE_ORIGIN } from './_broadcast-notify.js';

const ACTIONS = ['back', 'skip', 'send'];

/** The same look as the emails these links come from (./_email-shell.js), with the site's own fonts */
function page(title, body, { status = 200 } = {}) {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<meta name="color-scheme" content="light dark">
<title>${escapeHtml(title)} · Sunshine on a Ranney Day</title>
<link rel="preload" href="/fonts/outfit-latin-variable.woff2" as="font" type="font/woff2" crossorigin>
<style>
@font-face{font-family:Outfit;src:url(/fonts/outfit-latin-variable.woff2) format('woff2');font-weight:100 900;font-display:swap}
@font-face{font-family:'Libre Baskerville';src:url(/fonts/libre-baskerville-latin-700-normal.woff2) format('woff2');font-weight:700;font-display:swap}
:root{--page:#F5F4F0;--card:#FEFCF5;--ink:#2D2E33;--muted:#5A5B61;--gold:#8A7200;--line:#E5E4E0;--y:#FFDA24;--outline:#D4D2CB;--outline-bg:#fff}
@media (prefers-color-scheme:dark){:root{--page:#141518;--card:#1F2024;--ink:#ECECEA;--muted:#ABACB2;--gold:#E6C744;--line:#3A3B41;--outline:#56575D;--outline-bg:#26272C}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:var(--page);font:16px/1.55 Outfit,-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:var(--ink);-webkit-text-size-adjust:100%}
main{max-width:480px;margin:0 auto;padding:12vh 16px 40px}
.card{background:var(--card);border-radius:16px;padding:30px 28px 28px;box-shadow:0 1px 2px rgba(26,27,31,.04),0 8px 24px -8px rgba(26,27,31,.1)}
.eyebrow{display:flex;align-items:center;gap:10px;margin:0 0 14px;font-size:12px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--gold)}
.eyebrow::before{content:'';width:28px;height:2px;background:var(--y);flex:none}
h1{font-family:'Libre Baskerville',Georgia,serif;font-size:25px;line-height:1.3;font-weight:700;margin:0 0 10px;text-wrap:balance}
p{margin:0 0 22px;color:var(--muted)}
.actions{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin:0}
button,.btn{display:inline-flex;align-items:center;justify-content:center;min-height:46px;padding:0 22px;border-radius:999px;font:inherit;font-size:15px;font-weight:700;line-height:1;text-decoration:none;cursor:pointer;-webkit-tap-highlight-color:transparent}
button{background:var(--y);color:#2D2E33;border:1px solid var(--y)}
button:hover{filter:brightness(.97)}
button[disabled]{opacity:.7;cursor:progress}
.btn{background:var(--outline-bg);color:var(--ink);border:1px solid var(--outline)}
.btn:hover{border-color:var(--ink)}
button:focus-visible,.btn:focus-visible{outline:3px solid var(--ink);outline-offset:2px}
.foot{margin:18px 4px 0;font-size:12px;color:var(--muted);text-align:center}
@media (max-width:420px){main{padding-top:8vh}.card{padding:26px 20px 22px}h1{font-size:22px}.actions>*{flex:1 1 100%}}
</style></head><body><main><div class="card"><p class="eyebrow">Applicants · Status emails</p>${body}</div><p class="foot">Sunshine on a Ranney Day</p></main>
<script>document.querySelectorAll('form').forEach(f=>f.addEventListener('submit',()=>{const b=f.querySelector('button');if(b){b.disabled=true;b.textContent='Working…';}}));</script>
</body></html>`, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' },
  });
}

const adminHref = (id) => `${SITE_ORIGIN}/admin/#applications/applicants/${encodeURIComponent(id || '')}`;
const adminBtn = (id) => `<a class="btn" href="${adminHref(id)}">Open in the admin</a>`;
const adminLink = (id) => `<div class="actions">${adminBtn(id)}</div>`;
const gone = () => page('Already handled', '<h1>Already handled</h1><p>This change was already handled, or the status has changed again since. The admin shows where things stand.</p>' + adminLink(''), { status: 410 });
const expired = () => page('Link expired', '<h1>This link has expired</h1><p>The links in a status summary work for 7 days. Make the change from the family’s page in the admin.</p>' + adminLink(''), { status: 410 });

export async function onRequestGet({ request, env }) {
  if (!env.DB) return page('Unavailable', '<h1>Not available right now</h1><p>Please try again in a minute.</p>', { status: 500 });
  const url = new URL(request.url);
  const tok = url.searchParams.get('t') || '';
  const act = url.searchParams.get('do') || '';
  if (!ACTIONS.includes(act)) return page('Not found', '<h1>This link isn’t complete</h1><p>Open the family in the admin instead.</p>' + adminLink(''), { status: 400 });
  const row = await linkPreview(env, tok);
  if (row?.expired) return expired();
  if (!row || (act !== 'back' && !row.kind)) return gone();
  const name = escapeHtml(row.name || 'this family');
  const label = escapeHtml(row.label || row.status);
  const copy = {
    back: [`Move ${name} back to ${escapeHtml(row.previous || '')}?`, `This changes the status in JobTread${row.kind ? ` and cancels the ${label} email` : ''}. The family isn’t told anything.`, 'Move back'],
    skip: [`Don’t email ${name}’s family?`, `${name} stays ${escapeHtml(row.status)} in JobTread, but the ${label} email won’t go out. Use this when the family already knows.`, 'Don’t email'],
    send: [`Send the ${label} email now?`, `${name}’s family gets it right away instead of waiting.`, 'Send now'],
  }[act];
  if (act === 'back' && !row.previous) return gone();
  return page(copy[0], `<h1>${copy[0]}</h1><p>${copy[1]}</p><form method="post" class="actions"><input type="hidden" name="t" value="${escapeHtml(tok)}"><input type="hidden" name="do" value="${act}"><button type="submit">${copy[2]}</button>${adminBtn(row.account_id)}</form>`);
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
  if (preview?.expired) return expired();
  let out;
  try {
    out = await linkAction(env, tok, act);
  } catch (e) {
    return page('Something went wrong', `<h1>That didn’t work</h1><p>${escapeHtml(e.message)}. Nothing was sent to the family. Try again from the admin.</p>${adminLink(preview?.account_id)}`, { status: 500 });
  }
  if (out.expired) return expired();
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
