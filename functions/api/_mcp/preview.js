/**
 * The email, seen in the chat: an MCP App (Claude's interactive connector UI) that draws the real email, exactly as
 * the admin's preview does, at phone or computer width. show_email opens it; Write an email and Edit words open it
 * too, after a save, so a change is seen the moment it's made. The view asks the server for the email's HTML
 * itself (email_html, a tool only the view calls), so Claude never has to carry the HTML.
 *
 * Its script is the MCP Apps SDK (@modelcontextprotocol/ext-apps 1.7.5, MIT), served from the site itself
 * (public/mcp-app/), never a CDN. The frame may load only that and the hosts SOARD's emails show pictures from.
 */

import { readCustomEmail, isEmailId } from '../_custom-emails.js';
import { customEmail, emailProblems } from '../_custom-email.js';
import { EMAIL_WORDS, parseWordsKey } from '../_email-words.js';
import { emailWordsView } from '../_email-words-draft.js';
import { done, refuse, adminUrl, SITE_URL, READ } from './core.js';

export const PREVIEW_URI = 'ui://soard/email-preview';
export const APP_MIME = 'text/html;profile=mcp-app';
const SDK = `${SITE_URL}/mcp-app/ext-apps-1.7.5.js`;
/** Where the frame may load from: the SDK, and what SOARD's emails show (Cloudflare Images, YouTube and Stream stills) */
export const PREVIEW_CSP = Object.freeze({
  resourceDomains: [SITE_URL, 'https://imagedelivery.net', 'https://i.ytimg.com', 'https://customer-cuav5h47lgfe96ql.cloudflarestream.com', 'https://videodelivery.net'],
});
/** On a tool: the host draws its result in the preview */
export const SHOWS_EMAIL = Object.freeze({ ui: { resourceUri: PREVIEW_URI }, 'ui/resourceUri': PREVIEW_URI });

/** One email as it would go: a written one by its id, or one of the site's own by its key → { subject, preview, html, what } */
export async function emailAsItGoes(env, { id, key }) {
  if (id) {
    if (!isEmailId(id)) return { error: 'That isn’t a written email’s id.' };
    const e = await readCustomEmail(env.DB, id);
    if (!e) return { error: 'That email isn’t here any more.' };
    const m = customEmail(e);
    return { subject: m.subject, preview: m.preview, html: m.html, what: 'A written email', missing: emailProblems(e), admin: adminUrl(`#messages/write/${id}`) };
  }
  if (!parseWordsKey(key)) return { error: 'Say which email: a written email’s id, or one of the site’s emails by its key.' };
  const v = await emailWordsView(env, key);
  if (!v.email) return { error: v.block || 'This email can’t be shown yet.' };
  return { subject: v.email.subject, preview: v.email.preview, html: v.email.html, what: v.what || EMAIL_WORDS[parseWordsKey(key).kind]?.what || key };
}

async function showEmail(env, { id, key }) {
  if (!id && !key) return refuse('Say which email: a written email’s id, or one of the site’s emails by its key.');
  const m = await emailAsItGoes(env, { id, key });
  if (m.error) return refuse(m.error);
  return done({
    ...(id ? { id } : { key }), what: m.what, subject: m.subject, preview: m.preview,
    ...(m.missing?.length ? { missing: m.missing } : {}), ...(m.admin ? { admin: m.admin } : {}),
    said: 'The email is drawn above as it will look in an inbox (Phone or Computer). Hosts without the view: open it in the admin to see it.',
  });
}

async function emailHtml(env, { id, key }) {
  const m = await emailAsItGoes(env, { id, key });
  if (m.error) return refuse(m.error);
  return { content: [{ type: 'text', text: `${m.subject}` }], structuredContent: { subject: m.subject, preview: m.preview, html: m.html, what: m.what } };
}

const WHICH = {
  id: { type: 'string', maxLength: 40, description: 'A written email’s id' },
  key: { type: 'string', maxLength: 80, description: 'One of the site’s emails by its key (invite:, watch:, kickoff:, reveal:, recap:, monthly:YYYY-MM)' },
};

export const TOOLS = [
  { name: 'show_email', title: 'Show an email', annotations: { title: 'Show an email', ...READ }, _meta: SHOWS_EMAIL,
    description: 'Show an email in the chat exactly as it will look in an inbox, at phone or computer width: a written email by its id, or one of the site’s own emails by its key. Use it whenever someone wants to see an email.',
    inputSchema: { type: 'object', properties: WHICH, additionalProperties: false },
    run: showEmail },
  { name: 'email_html', title: 'The email’s HTML (for the preview)', annotations: { title: 'The email’s HTML (for the preview)', ...READ },
    _meta: { ui: { resourceUri: PREVIEW_URI, visibility: ['app'] }, 'ui/resourceUri': PREVIEW_URI },
    description: 'Used by the email preview to draw an email. To show someone an email, use show_email instead.',
    inputSchema: { type: 'object', properties: WHICH, additionalProperties: false },
    run: emailHtml },
];

/** The preview itself: one small page, styled to sit in Claude's chat in light or dark */
export function previewHtml() {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark">
<title>SOARD email</title>
<style>
  :root { --fg: var(--color-text-primary, #1f1d1a); --muted: var(--color-text-secondary, #6b6660); --line: var(--color-border-primary, rgba(0,0,0,.12)); --bg: var(--color-background-primary, #fff); --soft: var(--color-background-secondary, #f6f4f1); --accent: #e8a33d; }
  @media (prefers-color-scheme: dark) { :root { --fg: var(--color-text-primary, #f2efe9); --muted: var(--color-text-secondary, #a9a39b); --line: var(--color-border-primary, rgba(255,255,255,.14)); --bg: var(--color-background-primary, #1d1c1a); --soft: var(--color-background-secondary, #262522); } }
  * { box-sizing: border-box; }
  html, body { margin: 0; background: transparent; color: var(--fg); font: 14px/1.45 var(--font-sans, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif); }
  .wrap { padding: 12px; }
  .top { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 10px; }
  .what { font-size: 12px; color: var(--muted); }
  .subject { font-weight: 600; font-size: 15px; margin: 2px 0 0; overflow-wrap: anywhere; }
  .pre { color: var(--muted); font-size: 13px; overflow-wrap: anywhere; }
  .seg { display: inline-flex; border: 1px solid var(--line); border-radius: 999px; padding: 2px; flex: none; }
  .seg button { border: 0; background: none; color: var(--muted); font: inherit; font-size: 12px; padding: 6px 12px; border-radius: 999px; cursor: pointer; min-height: 32px; }
  .seg button[aria-pressed="true"] { background: var(--soft); color: var(--fg); font-weight: 600; }
  .seg button:focus-visible { outline: 2px solid var(--accent); outline-offset: 1px; }
  .stage { background: var(--soft); border: 1px solid var(--line); border-radius: 12px; padding: 12px; display: flex; justify-content: center; overflow: hidden; }
  iframe { border: 0; background: #fff; border-radius: 6px; width: 100%; max-width: 640px; height: 640px; display: block; transition: max-width .2s ease; }
  .phone iframe { max-width: 375px; }
  .note { color: var(--muted); padding: 24px 4px; text-align: center; }
  @media (prefers-reduced-motion: reduce) { iframe { transition: none; } }
</style></head>
<body><div class="wrap">
  <div class="top"><div><div class="what" id="what">SOARD email</div><p class="subject" id="subject"></p><div class="pre" id="pre"></div></div>
    <div class="seg" role="group" aria-label="Width"><button type="button" id="phone" aria-pressed="false">Phone</button><button type="button" id="computer" aria-pressed="true">Computer</button></div></div>
  <div class="stage" id="stage"><div class="note" id="note">Getting the email…</div></div>
</div>
<script type="module">
  import { App } from ${JSON.stringify(SDK)};
  const $ = (id) => document.getElementById(id);
  const app = new App({ name: 'SOARD email', version: '1.0.0' });
  let which = null;
  const setWidth = (phone) => { $('stage').classList.toggle('phone', phone); $('phone').setAttribute('aria-pressed', String(phone)); $('computer').setAttribute('aria-pressed', String(!phone)); fit(); };
  // The frame is as tall as the email at its width: measured from nothing, so it can shrink as well as grow
  $('phone').onclick = () => setWidth(true);
  $('computer').onclick = () => setWidth(false);
  const say = (t) => { $('stage').replaceChildren(Object.assign(document.createElement('div'), { className: 'note', textContent: t })); };
  function fit() {
    const f = $('stage').querySelector('iframe');
    try {
      const doc = f?.contentDocument;
      if (!doc?.documentElement) return;
      f.style.height = '0px';
      f.style.height = Math.min(doc.documentElement.scrollHeight + 2, 8000) + 'px';
    } catch { /* the frame keeps its height */ }
  }
  function draw(m) {
    $('what').textContent = m.what || 'SOARD email';
    $('subject').textContent = m.subject || '';
    $('pre').textContent = m.preview || '';
    const f = document.createElement('iframe');
    f.title = 'The email: ' + (m.subject || '');
    f.setAttribute('sandbox', 'allow-same-origin allow-popups');
    f.srcdoc = m.html;
    f.addEventListener('transitionend', fit);
    f.onload = () => {
      fit();
      // Pictures and fonts that arrive later change its height
      try { new ResizeObserver(() => requestAnimationFrame(fit)).observe(f.contentDocument.body); } catch { /* measured once */ }
      // A link in the email opens in the person's browser, through Claude
      try { f.contentDocument.addEventListener('click', (e) => { const a = e.target.closest && e.target.closest('a[href]'); if (!a) return; e.preventDefault(); app.openLink?.({ url: a.href }); }); } catch { /* links keep their own behavior */ }
    };
    $('stage').replaceChildren(f);
  }
  async function load(args, force = false) {
    const id = args?.id || null; const key = args?.key || null;
    if (!id && !key) return;
    const next = JSON.stringify({ id, key });
    if (next === which && !force) return;
    which = next;
    try {
      const r = await app.callServerTool({ name: 'email_html', arguments: id ? { id } : { key } });
      if (r?.isError || !r?.structuredContent?.html) return say(r?.content?.[0]?.text || 'The email can’t be shown right now.');
      draw(r.structuredContent);
    } catch { which = null; say('The email can’t be shown right now.'); }
  }
  // Showing an email starts on the request; a change (new words or blocks) waits for the saved result, never the email from before it
  let early = false;
  app.ontoolinput = ({ arguments: a }) => { if (!a || a.words || a.blocks) return; if (a.id || a.key) { early = true; load(a); } };
  app.ontoolresult = (r) => { const s = r?.structuredContent || {}; const fresh = !early; early = false; if (r?.isError) return say(r?.content?.[0]?.text || 'That didn’t work.'); load({ id: s.id, key: s.key }, fresh); };
  await app.connect();
</script>
</body></html>`;
}
