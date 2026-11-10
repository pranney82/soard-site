/**
 * /api/kid-folders-admin — Dropbox folders to name (Admin → Kids)
 * ===============================================================
 * GET  → { success, folders: [{ folder, photos, videos, decision, kidSlug, newName, newYear, note, decidedBy, decidedAt, url, guesses }],
 *          kids: [{ slug, name, year }] }
 * POST { folder, decision: 'kid' | 'new' | 'not' | null, kidSlug?, newName?, newYear?, note? } → { success, folder }
 *
 * Which kid each unmatched Dropbox Makeover Photos folder is (./_kid-folders.js).
 * Staff only (Cloudflare Access, the middleware's default); never cached.
 */

import { listFolders, checkAnswer, saveAnswer } from './_kid-folders.js';
import { loadAllKids } from './_kid-status.js';

const headers = { 'Cache-Control': 'private, no-store' };
const kidList = (kids) => kids.map((k) => ({ slug: k.slug, name: k.name || k.slug, year: k.year ?? null }))
  .sort((a, b) => String(a.name).localeCompare(String(b.name)) || (Number(a.year) || 0) - (Number(b.year) || 0));

export async function onRequestGet(context) {
  const { env } = context;
  try {
    const kids = kidList(await loadAllKids(env.DB));
    return Response.json({ success: true, folders: await listFolders(env.DB, kids), kids }, { headers });
  } catch (err) {
    // 500, not 502: Cloudflare replaces 502 bodies with its own error page
    return Response.json({ success: false, error: err.message, folders: [], kids: [] }, { status: 500, headers });
  }
}

export async function onRequestPost(context) {
  const { env } = context;
  try {
    const body = await context.request.json().catch(() => null);
    const kids = kidList(await loadAllKids(env.DB));
    const checked = checkAnswer(body, kids);
    if (!checked.ok) return Response.json({ success: false, error: checked.error }, { status: 400, headers });
    const saved = await saveAnswer(env.DB, checked.row, { by: context.data?.userEmail || null, kids });
    if (!saved) return Response.json({ success: false, error: 'That folder isn’t on the list any more. Reload.' }, { status: 404, headers });
    return Response.json({ success: true, folder: saved }, { headers });
  } catch (err) {
    return Response.json({ success: false, error: err.message }, { status: 500, headers });
  }
}
