/**
 * The old one-tap answer links in board emails ("Will you be there?")
 * =====================================================================
 * Until Nov 2 2026 the packet and the reminder gave each board member three
 * links to /api/board-rsvp with their own token for that meeting (128 random
 * bits; D1 keeps only the hash, board_rsvp_links, until the day after the
 * meeting). Since then the calendar invite is the only answer (Peter), so no
 * new links are made and an old one only says which meeting it was for, so
 * its page can send them to the invite. It records nothing.
 */

import { ensureSchema, getMeeting } from './_board.js';
import { activeBoard } from './_board-roles.js';
import { todayEastern } from '../../public/admin/board-shared.js';

const TOKEN = /^[0-9a-f]{32}$/;
const hex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
const hashOf = async (tok) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(tok))));

/**
 * Whose link this is → { meeting, member }, { expired: true } after the day
 * after the meeting, or null (no such link, the meeting is gone or off the
 * board page, or they're off the board)
 */
export async function answerLink(env, tok, { now = Date.now() } = {}) {
  if (!env?.DB || !TOKEN.test(String(tok || ''))) return null;
  await ensureSchema(env.DB);
  const row = await env.DB.prepare('SELECT meeting_id, slug, expires FROM board_rsvp_links WHERE hash = ?').bind(await hashOf(tok)).first();
  if (!row) return null;
  if (row.expires < todayEastern(now)) return { expired: true };
  const [meeting, board] = await Promise.all([getMeeting(env.DB, row.meeting_id), activeBoard(env.DB)]);
  const member = board.find((p) => p.slug === row.slug);
  if (!meeting?.shared || !member) return null;
  return { meeting, member };
}
