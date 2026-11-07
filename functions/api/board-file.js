/**
 * GET /api/board-file?id=<file id> (Cloudflare Access) — one of the board's
 * files (a meeting's financials, a bylaws PDF), straight from R2.
 *
 * A board member (context.data.boardMember) opens a shared meeting's or
 * document's files, never a staff-only one, and their own signed copy of a
 * paper; the Board area's admins open any. Anyone else, or a file they can't see, gets the same 404. PDFs open in
 * the browser's viewer (or the board page's), everything else downloads,
 * never cached anywhere (files/[[path]].js fileHeaders + private, no-store).
 *
 * GET ?family=<account>&file=<id>[&size=256|600|2048] → one of that family's files, passed through from JobTread (a
 * video's Range too); &site=pdf|<photo>[&thumb=1] the site's own copy until JobTread has it; &face=1 the child's photo
 * for the list. Only the application, the video and the photos: never staff's notes (./_board-families.js familyFile).
 */

import { fileFor, boardFiles } from './_board.js';
import { isBoardAdmin } from './_board-roles.js';
import { fileHeaders } from '../files/[[path]].js';
import { noteFileOpen } from './_board-activity.js';
import { familyFile } from './_board-families.js';

const notFound = () => new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'private, no-store' } });

export async function onRequestGet(context) {
  const { env, request } = context;
  const q = new URL(request.url).searchParams;
  const id = q.get('id') || '';
  const admin = !context.data?.boardMember && await isBoardAdmin(env.DB, context.data?.userEmail);
  if (!admin && !context.data?.boardMember) return notFound();
  // A family's application, video or a photo (./_board-families.js): only those, whoever asks
  if (q.has('family')) return familyFile(context, q);
  const row = await fileFor(env.DB, id, { admin, member: context.data?.boardMember || null });
  if (!row) return notFound();
  const obj = await boardFiles(env)?.get(row.r2_key);
  if (!obj) return notFound();
  const headers = fileHeaders(row.name || row.r2_key, row.type || obj.httpMetadata?.contentType);
  headers.set('Cache-Control', 'private, no-store');
  if (obj.size) headers.set('Content-Length', String(obj.size));
  // A meeting's or document's file a member opened in a tab of its own: opened, for Board → Members (_board-activity.js)
  const member = context.data?.boardMember;
  if (member && ['meeting', 'doc'].includes(row.owner_type)) {
    const noted = noteFileOpen(env, member, request, row.id);
    if (context.waitUntil) context.waitUntil(noted); else await noted;
  }
  return new Response(obj.body, { headers });
}
