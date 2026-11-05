/**
 * The small pages the emails lead to: "Confirm your reminders", "You're on the
 * list", "Stop reveal reminders?", the newsletter's "One more step". The same
 * look as the emails: the official logo on its dark band, a cream card,
 * Libre Baskerville and Outfit, a yellow pill. No scripts on any of them.
 */
import { LOGO } from './_reveal-invite-email.js';

/** Our pictures and fonts, and nothing that runs */
export const NOTE_PAGE_CSP = "default-src 'none'; img-src https://imagedelivery.net; style-src 'unsafe-inline' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

const STYLE = `:root{--page:#F5F4F0;--card:#FEFCF5;--ink:#2D2E33;--muted:#5A5B61;--band:#1E1F25;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--page:#141518;--card:#1F2024;--ink:#ECECEA;--muted:#ABACB2}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px 16px;background:var(--page);color:var(--ink);font-family:Outfit,-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;font-size:16px;line-height:1.6}
main{width:100%;max-width:480px;background:var(--card);border-radius:16px;overflow:hidden;text-align:center}
.band{display:block;padding:14px;background:var(--band)}
.band img{display:block;margin:0 auto;width:84px;height:auto;color:#FFFFFF;font-size:13px}
.note{padding:30px 28px 32px}
h1{margin:0 0 12px;font-family:'Libre Baskerville',Georgia,'Times New Roman',serif;font-size:26px;line-height:1.25;text-wrap:balance}
p{margin:0 0 12px;overflow-wrap:anywhere}
form{margin:0}
.btn{display:block;width:100%;margin-top:18px;padding:15px 28px;background:#FFDA24;color:#2D2E33;font:inherit;font-weight:700;line-height:20px;text-align:center;text-decoration:none;border:0;border-radius:999px;cursor:pointer}
.btn:focus-visible,a:focus-visible{outline:3px solid var(--ink);outline-offset:2px}
.quiet{display:inline-block;margin-top:16px;color:var(--muted);font-size:14px}
.hp{position:absolute;left:-9999px;top:-9999px}
@media (min-width:480px){.btn{display:inline-block;width:auto}}`;

/** A whole page around its words. inner is HTML the caller has escaped. */
export function notePage({ title, inner, lang = 'en', site = 'https://sunshineonaranneyday.com' }) {
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return `<!doctype html><html lang="${lang === 'es' ? 'es' : 'en'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><meta name="color-scheme" content="light dark"><title>${esc(title)} | Sunshine on a Ranney Day</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Libre+Baskerville:wght@700&family=Outfit:wght@400;600;700&display=swap"><style>${STYLE}</style></head>
<body><main><a class="band" href="${site}/"><img src="${esc(LOGO)}" width="84" alt="Sunshine on a Ranney Day"></a><div class="note"><h1>${esc(title)}</h1>${inner}</div></main></body></html>`;
}
