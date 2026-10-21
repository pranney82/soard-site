/**
 * /api/press-admin — Admin → Press (Access only, like every /api route not in PUBLIC_ROUTES)
 * ===========================================================================
 * GET  → { success, settings, defaults, state, mentions, links, log }
 *        What the monitor found and did: see _press.js overview().
 * POST { action, ... }
 *   fill        { url }            read a story's page: headline, outlet, date, summary, picture, kids, partners
 *   add         { id }             file a found article now
 *   skip        { id }             not coverage: keep it out of the list
 *   restore     { id }             back to "needs a look"
 *   undo        { id }             put a logged change back
 *   mergeOutlets { from, into }    one outlet with two records
 *   mergeStories { keep, drop }    a copy folded into the story kept (logged, so Undo brings it back)
 *   createOutlet { name, url, kind }
 *   settings    { queries, channels }
 *   channel     { url }            a YouTube channel's id from its address
 * GET ?summary=1 → { success, review }: how many found articles need a look (sidebar, Dashboard)
 * Story and outlet edits themselves go through save-content (History, merge on conflict).
 */
import { overview, summary, fillFromUrl, addMention, decideMention, undoChange, mergeOutlets, mergeStories, createOutlet, saveSettings, resolveChannel, ensurePressTables } from './_press.js';

const headers = { 'Cache-Control': 'no-store' };
const reply = (body, status = 200) => Response.json(body, { status, headers });

export async function onRequestGet(context) {
  try {
    // ?summary=1: just the count of articles that need a look (the sidebar and the Dashboard)
    if (new URL(context.request.url).searchParams.get('summary')) return reply({ success: true, ...(await summary(context.env)) });
    return reply({ success: true, ...(await overview(context.env)) });
  } catch (err) {
    console.error('[press-admin]', err);
    return reply({ success: false, error: err.message || 'Couldn’t read the press monitor' }, 500);
  }
}

export async function onRequestPost(context) {
  const { env } = context;
  const user = context.data?.userEmail || 'unknown';
  let body;
  try { body = await context.request.json(); } catch { return reply({ success: false, error: 'Send JSON' }, 400); }
  try {
    await ensurePressTables(env.DB);
    const id = typeof body.id === 'string' ? body.id.slice(0, 300) : body.id;
    switch (body.action) {
      case 'fill': return reply(await fillFromUrl(env, body.url));
      case 'add': return reply(await addMention(env, id, user));
      case 'skip': return reply(await decideMention(env, id, 'skip', user));
      case 'restore': return reply(await decideMention(env, id, 'restore', user));
      case 'undo': return reply(await undoChange(env, Number(body.id), user));
      case 'mergeOutlets': return reply(await mergeOutlets(env, String(body.from || ''), String(body.into || ''), user));
      case 'mergeStories': return reply(await mergeStories(env, String(body.keep || ''), String(body.drop || ''), user));
      case 'createOutlet': return reply(await createOutlet(env, body, user));
      case 'settings': return reply(await saveSettings(env, body, user));
      case 'channel': return reply(await resolveChannel(body.url));
      default: return reply({ success: false, error: 'Unknown action' }, 400);
    }
  } catch (err) {
    console.error('[press-admin]', body?.action, err);
    // 500, not 502: Cloudflare swaps a 502's body for its own error page
    return reply({ success: false, error: err.message || 'Something went wrong' }, 500);
  }
}
