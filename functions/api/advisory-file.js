/**
 * GET /api/advisory-file?id=<file id> (Cloudflare Access) — a paper or a meeting's file for the Advisory Board, from R2.
 *
 * Only files that are the advisors' own (board_files owner_type 'advisory-doc' or 'advisory-meeting', under the private
 * board/ prefix) on a shared paper or a shared meeting, and never a staff-only one. Anyone who runs the group opens any
 * of theirs. A board file gets the same 404 as a file that doesn't exist, unless it's the current file of a paper staff
 * turned on for advisors (settings.boardDocs). Never cached anywhere.
 */

import { whoIs, isSharedDoc, getSettings } from './_advisory.js';
import { boardPapers } from './_advisory-portal.js';
import { boardFiles, ID } from './_board.js';
import { isSharedAdvisoryMeeting } from './_advisory-meetings.js';
import { fileHeaders } from '../files/[[path]].js';
import { noteFileOpen } from './_board-activity.js';

const notFound = () => new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'private, no-store' } });

export async function advisoryFileFor(DB, id, w) {
  if (!ID.test(String(id || ''))) return null;
  const row = await DB.prepare("SELECT * FROM board_files WHERE id = ? AND owner_type IN ('advisory-doc', 'advisory-meeting')").bind(id).first();
  if (!row) {
    const paper = (await boardPapers(DB, await getSettings(DB))).find((p) => p.file.id === id);
    return paper ? DB.prepare("SELECT * FROM board_files WHERE id = ? AND owner_type = 'doc'").bind(id).first() : null;
  }
  if (w.runs) return row;
  if (row.staff_only) return null;
  const open = row.owner_type === 'advisory-doc' ? await isSharedDoc(DB, row.owner_id) : await isSharedAdvisoryMeeting(DB, row.owner_id);
  return open ? row : null;
}

export async function onRequestGet(context) {
  const { env, request } = context;
  const w = await whoIs(context).catch(() => null);
  if (!w) return notFound();
  const id = new URL(request.url).searchParams.get('id') || '';
  const row = await advisoryFileFor(env.DB, id, w);
  if (!row) return notFound();
  const obj = await boardFiles(env)?.get(row.r2_key);
  if (!obj) return notFound();
  const headers = fileHeaders(row.name || row.r2_key, row.type || obj.httpMetadata?.contentType);
  headers.set('Cache-Control', 'private, no-store');
  if (obj.size) headers.set('Content-Length', String(obj.size));
  if (w.kind === 'advisor' && context.waitUntil) context.waitUntil(noteFileOpen(env, w, request, id).catch(() => {}));
  return new Response(obj.body, { headers });
}
