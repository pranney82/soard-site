/**
 * GET /api/board-file?id=<file id> (Cloudflare Access) — one of the board's
 * files (a meeting's financials, a bylaws PDF), straight from R2.
 *
 * A board member (context.data.boardMember) opens a shared meeting's or
 * document's files, never a staff-only one; the Board area's admins open
 * any. Anyone else, or a file they can't see, gets the same 404. PDFs open in
 * the browser's viewer (or the board page's), everything else downloads,
 * never cached anywhere (files/[[path]].js fileHeaders + private, no-store).
 */

import { fileFor, boardFiles } from './_board.js';
import { isBoardAdmin } from './_board-roles.js';
import { fileHeaders } from '../files/[[path]].js';

const notFound = () => new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'private, no-store' } });

export async function onRequestGet(context) {
  const { env, request } = context;
  const id = new URL(request.url).searchParams.get('id') || '';
  const admin = !context.data?.boardMember && await isBoardAdmin(env.DB, context.data?.userEmail);
  if (!admin && !context.data?.boardMember) return notFound();
  const row = await fileFor(env.DB, id, { admin });
  if (!row) return notFound();
  const obj = await boardFiles(env)?.get(row.r2_key);
  if (!obj) return notFound();
  const headers = fileHeaders(row.name || row.r2_key, row.type || obj.httpMetadata?.contentType);
  headers.set('Cache-Control', 'private, no-store');
  if (obj.size) headers.set('Content-Length', String(obj.size));
  return new Response(obj.body, { headers });
}
