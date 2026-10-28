/**
 * One-tap answers from a board email: "Will you be there?"
 * ==========================================================
 * The packet and the reminder give each board member who hasn't answered
 * three buttons (I'll be there, by video, I can't make it), each a link to
 * /api/board-rsvp with that member's own token for that meeting: 128 random
 * bits, of which D1 keeps only the hash (board_rsvp_links), working until
 * the day after the meeting. No sign-in, so it works from a phone.
 *
 * GET only shows the answer to confirm, because mail scanners open links by
 * themselves; pressing the button (POST) records it, the same as answering
 * on the board page (board_rsvps).
 */

import { ensureSchema, getMeeting, setRsvp, SITE } from './_board.js';
import { activeBoard } from './_board-roles.js';
import { RSVP, todayEastern } from '../../public/admin/board-shared.js';

const TOKEN = /^[0-9a-f]{32}$/;
const hex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
const hashOf = async (tok) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(tok))));
const dayAfter = (date) => new Date(Date.parse(`${date}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);

/** Each member's three answer links for a meeting → { slug: { yes, remote, no } } (a new token each time) */
export async function answerLinks(DB, m, slugs, { now = Date.now() } = {}) {
  if (!slugs.length || !m?.date) return {};
  await ensureSchema(DB);
  await DB.prepare('DELETE FROM board_rsvp_links WHERE expires < ?').bind(todayEastern(now)).run();
  const out = {};
  for (const slug of slugs) {
    const tok = hex(crypto.getRandomValues(new Uint8Array(16)));
    await DB.prepare('INSERT INTO board_rsvp_links (hash, meeting_id, slug, expires) VALUES (?, ?, ?, ?)').bind(await hashOf(tok), m.id, slug, dayAfter(m.date)).run();
    out[slug] = Object.fromEntries(RSVP.map((r) => [r.id, `${SITE}/api/board-rsvp?t=${tok}&a=${r.id}`]));
  }
  return out;
}

/**
 * Whose link this is → { meeting, member, answer (theirs so far, or '') },
 * { expired: true } after the day after the meeting, or null (no such link,
 * the meeting is gone or off the board page, or they're off the board)
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
  const answer = (await env.DB.prepare('SELECT answer FROM board_rsvps WHERE meeting_id = ? AND slug = ?').bind(meeting.id, member.slug).first())?.answer || '';
  return { meeting, member, answer };
}

/** Record the answer a link's button gave → answerLink's result with the new answer */
export async function answerByLink(env, tok, answer, opts) {
  const link = await answerLink(env, tok, opts);
  if (!link || link.expired) return link;
  await setRsvp(env.DB, link.meeting.id, link.member.slug, answer);
  return { ...link, answer };
}
