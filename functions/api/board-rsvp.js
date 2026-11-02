/**
 * /api/board-rsvp — where the old "Will you be there?" buttons in a board email go
 * ==================================================================================
 * Public (no sign-in, so it works from a phone). Until Nov 2 2026 these links
 * recorded an answer; since then the calendar invite is the only answer
 * (Peter), so a link (GET, or a page's old button, POST) only sends them to
 * the invite, by name and meeting when its token is still good
 * (./_board-rsvp.js). Nothing is recorded.
 *   ?t=<token>&a=yes|remote|no
 */

import { answerLink } from './_board-rsvp.js';
import { BOARD_PAGE } from './_board-roles.js';
import { SITE } from './_board.js';
import { escapeHtml as esc } from './_broadcast-notify.js';
import { meetingName, longDate, timeRange, callName, repliesOf } from '../../public/admin/board-shared.js';

/** The same look as the board emails (./_email-shell.js), with the site's own fonts */
function page(title, body, { status = 200 } = {}) {
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<meta name="color-scheme" content="light dark">
<title>${esc(title)} · SOARD Board</title>
<link rel="preload" href="/fonts/outfit-latin-variable.woff2" as="font" type="font/woff2" crossorigin>
<style>
@font-face{font-family:Outfit;src:url(/fonts/outfit-latin-variable.woff2) format('woff2');font-weight:100 900;font-display:swap}
@font-face{font-family:'Libre Baskerville';src:url(/fonts/libre-baskerville-latin-700-normal.woff2) format('woff2');font-weight:700;font-display:swap}
:root{--page:#F5F4F0;--card:#FEFCF5;--ink:#2D2E33;--muted:#5A5B61;--gold:#8A7200;--line:#E5E4E0;--y:#FFDA24;--outline:#D4D2CB;--outline-bg:#fff;--link:#2B6CB0}
@media (prefers-color-scheme:dark){:root{--page:#141518;--card:#1F2024;--ink:#ECECEA;--muted:#ABACB2;--gold:#E6C744;--line:#3A3B41;--outline:#56575D;--outline-bg:#26272C;--link:#8DB8EC}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:var(--page);font:16px/1.55 Outfit,-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;color:var(--ink);-webkit-text-size-adjust:100%}
main{max-width:520px;margin:0 auto;padding:10vh 16px 40px}
.card{background:var(--card);border-radius:16px;padding:30px 28px 28px;box-shadow:0 1px 2px rgba(26,27,31,.04),0 8px 24px -8px rgba(26,27,31,.1)}
.eyebrow{display:flex;align-items:center;gap:10px;margin:0 0 14px;font-size:12px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--gold)}
.eyebrow::before{content:'';width:28px;height:2px;background:var(--y);flex:none}
h1{font-family:'Libre Baskerville',Georgia,serif;font-size:25px;line-height:1.3;font-weight:700;margin:0 0 10px;text-wrap:balance}
p{margin:0 0 18px;color:var(--muted)}
.when{margin:0 0 22px;color:var(--ink)}
.when b{font-weight:inherit;white-space:nowrap}
.when span{display:block;color:var(--muted)}
.said{margin:0 0 16px;padding:10px 14px;border-radius:10px;background:var(--outline-bg);border:1px solid var(--line);color:var(--ink);font-size:15px}
.actions{display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin:0}
.then{margin:24px 0 0;padding:20px 0 0;border-top:1px solid var(--line)}
.then p{margin:0 0 12px;font-size:15px}
button,.btn{display:inline-flex;align-items:center;justify-content:center;min-height:46px;padding:0 22px;border-radius:999px;font:inherit;font-size:15px;font-weight:700;line-height:1;text-decoration:none;cursor:pointer;-webkit-tap-highlight-color:transparent;background:var(--outline-bg);color:var(--ink);border:1px solid var(--outline)}
button:hover,.btn:hover{border-color:var(--ink)}
button.primary{background:var(--y);color:#2D2E33;border-color:var(--y)}
button.primary:hover{filter:brightness(.97)}
button:focus-visible,.btn:focus-visible{outline:3px solid var(--ink);outline-offset:2px}
a{color:var(--link)}
.foot{margin:18px 4px 0;font-size:12px;color:var(--muted);text-align:center}
@media (max-width:440px){main{padding-top:6vh}.card{padding:26px 20px 22px}h1{font-size:22px}.actions>*{flex:1 1 100%}}
</style></head><body><main><div class="card"><p class="eyebrow">SOARD Board</p>${body}</div><p class="foot">Sunshine on a Ranney Day</p></main></body></html>`, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Robots-Tag': 'noindex' },
  });
}

const boardPage = (label = 'Open the board page', hash = '') => `<a class="btn" href="${SITE}${BOARD_PAGE}${esc(hash)}">${esc(label)}</a>`;
const INVITE = 'Answer the calendar invite for it in your email or calendar: yes, no or maybe. That’s where SOARD sees who’s coming.';
const broken = () => page('Answer the calendar invite', `<h1>Answer the calendar invite</h1><p>This link is from an older email. ${INVITE}</p><div class="actions">${boardPage()}</div>`, { status: 404 });
const expired = () => page('Meeting passed', `<h1>This meeting has passed</h1><p>Its minutes go on the board page once they’re up.</p><div class="actions">${boardPage()}</div>`, { status: 410 });

const first = (name) => String(name || '').trim().split(/\s+/)[0] || '';
/** When and where, under the question */
function whenBlock(m) {
  const call = m.video ? `on ${callName(m.video)}` : '';
  const where = m.location && call ? `${m.location}, or ${call}` : m.location || (call && call[0].toUpperCase() + call.slice(1));
  return `<p class="when">${esc(longDate(m.date))}${m.start ? `, <b>${esc(timeRange(m.start, m.end))}</b>` : ''}${where ? `<span>${esc(where)}</span>` : ''}</p>`;
}
/** A link's meeting, by name, and where its answer goes now */
async function toInvite(env, tok) {
  const link = await answerLink(env, tok).catch(() => null);
  if (!link) return broken();
  if (link.expired) return expired();
  const { meeting: m, member } = link;
  const name = first(member.name);
  // Not on its invite: there's nothing to answer until they are
  const on = !!repliesOf(m)[member.slug];
  return page('Answer the calendar invite', `<h1>${name ? `${esc(name)}, will` : 'Will'} you be at the ${esc(meetingName(m))}?</h1>${whenBlock(m)}`
    + `<p class="said">This link doesn’t save an answer any more: SOARD goes by the calendar invite now.</p>`
    + `<p>${on ? esc(INVITE) : 'You’re not on its calendar invite yet. Reply to the email this link came in, and SOARD will send it to you.'}</p>`
    + `<div class="actions">${boardPage('See the meeting', `#/meetings/${m.id}`)}</div>`);
}

export async function onRequestGet({ request, env }) {
  return toInvite(env, new URL(request.url).searchParams.get('t') || '');
}

// A page opened before Nov 2 2026 still has the buttons: pressing one records nothing, the same page says where to answer
export async function onRequestPost({ request, env }) {
  let tok = '';
  try { tok = String((await request.formData()).get('t') || ''); } catch { /* the page for a broken link */ }
  return toInvite(env, tok);
}
