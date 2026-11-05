/**
 * Email all: a note to the whole board, written on Board → Members
 * ===========================================================================
 * Peter, Nov 5 2026: "can you add an email all in the board page on members?",
 * then "make it best in class". Google Calendar's Email guests is the measure:
 * written in the page, sent as you, with who gets it in front of you.
 *
 * It goes from the writer's own Gmail through the Gmail API (the site's
 * domain-wide delegation, gmail.send, as ./_board-asks.js sends), so it's from
 * them, it's in their Sent folder and replies come to their inbox. Never
 * through Resend: SOARD's domain isn't one Resend sends for.
 *
 * Who gets it: the people board@soardcharity.com holds (./_board-group.js
 * groupWanted: the active board at their private addresses, and Board's
 * admins), less the writer. Each is addressed directly, not through the group:
 * the group's "who can post" is Google's setting and the site can't see it, so
 * a member's reply from a personal address could bounce there; addressed
 * directly, reply all always reaches everyone.
 *
 * One message is one email, whatever presses it: the same words to the board
 * from a second tab, a retry after a dropped connection, or the other admin
 * are refused for a day (SAME_MS). A record is kept per message, by a hash of
 * its words, so one send never disturbs another's. A send Gmail refused can be
 * tried again at once. One with no clear answer may have gone: its record stays,
 * and after two minutes the next try reads the writer's Sent folder for that
 * message (each carries its own X-SOARD-Board tag) and only sends if it isn't
 * there. If the folder can't be read, nothing goes. While a writer's last note
 * is unclear nothing else of theirs goes either: a word changed in it could
 * otherwise reach the board as a second copy. And a writer's second note within
 * a day of one that went stops once to say so, which needs nothing from the
 * page: it holds when the answer never reached it, or it was reloaded.
 */

import { accessToken, GMAIL_READ_SCOPE } from './_google-calendar.js';
import { header } from './_mailbox.js';
import { groupWanted } from './_board-group.js';
import { readState, normEmail } from './_board-roles.js';
import { GMAIL_SEND_SCOPE, mimeOf, gmailCall, esc, P } from './_board-asks.js';

export const SUBJECT_MAX = 200;
export const MESSAGE_MAX = 20000;
const KEY = 'email-all';
const HOLD_MS = 2 * 60 * 1000;
const SAME_MS = 24 * 60 * 60 * 1000;
const STILL_GOING = 'That email may still be going out. Give it two minutes, then press Send again and the site will check your Sent folder first.';
const NO_ANSWER = 'Gmail didn’t give a clear answer, so this may have gone. Give it two minutes, then press Send again and the site will check your Sent folder first.';
const NO_ANSWER_TEST = 'Gmail didn’t give a clear answer, so the test may have reached you. Look in your inbox. Nothing went to the board.';
const cantCheck = (by, who) => `The site can’t check whether this went. ${by && by !== who ? `Ask ${by} to look in their Sent folder.` : 'Look in your Sent folder.'} If it isn’t there, change a word and send it.`;
// Characters that show nothing: a subject or message of only these is empty
const UNSEEN = /[\u200B-\u200D\u2060\uFEFF]/g;
const seen = (s) => s.replace(UNSEEN, '').trim();
/** "on Thursday at 2:14 PM", Eastern */
const when = (iso) => new Date(iso).toLocaleString('en-US', { weekday: 'long', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' })
  .replace(/\u202f/g, ' ').replace(/^(\w+),? (?:at )?/, 'on $1 at ');

const err = (message, status) => Object.assign(new Error(message), { status });

/**
 * Text as HTML, its web addresses as links. A sentence's last mark stays outside a link, and so does a closing bracket,
 * unless the address opened one itself (…/wiki/Foo_(bar))
 */
function linked(text) {
  let out = '';
  let at = 0;
  for (const m of text.matchAll(/\b(?:https?:\/\/|www\.)[^\s<>"']+/gi)) {
    let url = m[0];
    const count = (s, c) => s.split(c).length - 1;
    for (;;) {
      const last = url.at(-1);
      if (/[.,;:!?]/.test(last) || (last === ')' && count(url, ')') > count(url, '(')) || (last === ']' && count(url, ']') > count(url, '['))) url = url.slice(0, -1);
      else break;
    }
    out += `${esc(text.slice(at, m.index))}<a href="${esc(/^www\./i.test(url) ? `https://${url}` : url)}" style="color:#1A5FB4;">${esc(url)}</a>`;
    at = m.index + url.length;
  }
  return out + esc(text.slice(at));
}

/** What was typed as an email: a subject on one line, then the words as both parts, the way a person's email reads */
export function noteEmail({ subject = '', message = '' }) {
  const line = String(subject).replace(/\s+/g, ' ').trim();
  const text = String(message).replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').trim();
  const html = `<div>${text.split(/\n{2,}/).map((p) => `<p style="${P}">${linked(p).replace(/\n/g, '<br>')}</p>`).join('')}</div>`;
  return { subject: line, text, html };
}

/** A message's name in board_state: the same words, however they were reached, are the same message */
async function keyOf(note) {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${note.subject}\n${note.text}`)));
  return `${KEY}:${[...bytes.slice(0, 12)].map((b) => b.toString(16).padStart(2, '0')).join('')}`;
}

const tagOf = (key) => key.replace(':', '-');

/** Did this message reach the writer's Sent folder? true, false, or null when that can't be told */
async function inSent(env, by, key, since, { fetchImpl, now }) {
  const PAGE = 25;
  try {
    const token = await accessToken(env, by, { fetchImpl, now, scope: GMAIL_READ_SCOPE });
    const after = Math.floor(Date.parse(since) / 1000) - 300;
    const list = await gmailCall(token, `/messages?q=${encodeURIComponent(`in:sent after:${after}`)}&maxResults=${PAGE}`, { fetchImpl });
    for (const m of list?.messages || []) {
      const got = await gmailCall(token, `/messages/${m.id}?format=metadata&metadataHeaders=X-SOARD-Board`, { fetchImpl });
      if (header(got?.payload?.headers, 'X-SOARD-Board') === tagOf(key)) return true;
    }
    return (list?.messages || []).length < PAGE ? false : null;
  } catch {
    return null;
  }
}

/**
 * This message's turn to send → { mine: true }, { had } (it went), { held, by } (it may be going out now), or
 * { unsure, by } (it may have gone and the Sent folder can't say). Taken atomically, so two posts at once can't both have it.
 */
async function claim(env, key, { by, n, subject, fetchImpl, now }) {
  const DB = env.DB;
  await readState(DB, key);
  const at = new Date(now).toISOString();
  const data = JSON.stringify({ at, by, subject });
  const row = await DB.prepare('SELECT data, updated_at FROM board_state WHERE key = ?').bind(key).first();
  if (!row) {
    const got = await DB.prepare('INSERT INTO board_state (key, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO NOTHING').bind(key, data, at).run();
    return got?.meta?.changes ? { mine: true } : { held: true };
  }
  let had = {};
  try { had = JSON.parse(row.data) || {}; } catch { /* taken over below */ }
  if (had.sentAt && now - Date.parse(had.sentAt) < SAME_MS) return { had };
  if (!had.sentAt && had.at) {
    if (now - Date.parse(had.at) < HOLD_MS) return { held: true, by: had.by };
    const found = await inSent(env, had.by || by, key, had.at, { fetchImpl, now });
    if (found === null) {
      // (told once: a changed word, as it says to do, goes straight on)
      await DB.prepare('UPDATE board_state SET data = ? WHERE key = ?').bind(JSON.stringify({ ...had, told: true }), key).run();
      return { unsure: true, by: had.by };
    }
    if (found) {
      const went = { ...had, sentAt: had.at, sent: n };
      await DB.prepare('UPDATE board_state SET data = ? WHERE key = ?').bind(JSON.stringify(went), key).run();
      return { had: went };
    }
  }
  const got = await DB.prepare('UPDATE board_state SET data = ?, updated_at = ? WHERE key = ? AND updated_at = ?').bind(data, at, key, row.updated_at).run();
  return got?.meta?.changes ? { mine: true } : { held: true };
}

/**
 * The writer's other notes, unclear ones settled by their Sent folder → null when nothing's in the way, else what stops
 * this one: { held: subject } (too soon to look), { went: subject, at } (it went today or just proved to, said once, so
 * the next press goes), or { unsure } (said once: they've been told to look, so the next press goes)
 */
async function earlierNote(env, key, { who, n, fetchImpl, now }) {
  const rows = (await env.DB.prepare('SELECT key, data FROM board_state WHERE key LIKE ?').bind(`${KEY}:%`).all())?.results || [];
  for (const row of rows) {
    let had = {};
    try { had = JSON.parse(row.data) || {}; } catch { continue; }
    if (row.key === key || had.by !== who || !had.at) continue;
    if (had.sentAt) {
      if (had.warned || now - Date.parse(had.sentAt) >= SAME_MS) continue;
      await env.DB.prepare('UPDATE board_state SET data = ? WHERE key = ?').bind(JSON.stringify({ ...had, warned: true }), row.key).run();
      return { went: had.subject || 'your last note', at: had.sentAt };
    }
    if (had.told) continue;
    if (now - Date.parse(had.at) < HOLD_MS) return { held: had.subject || 'your last note' };
    const found = await inSent(env, who, row.key, had.at, { fetchImpl, now });
    if (found === false) { await env.DB.prepare('DELETE FROM board_state WHERE key = ?').bind(row.key).run(); continue; }
    const settled = found ? { ...had, sentAt: had.at, sent: n, warned: true } : { ...had, told: true };
    await env.DB.prepare('UPDATE board_state SET data = ? WHERE key = ?').bind(JSON.stringify(settled), row.key).run();
    return found ? { went: had.subject || 'your last note', at: had.at } : { unsure: true };
  }
  return null;
}

/**
 * Send it. test: to the writer alone, marked, nothing kept.
 * → { sent }, { sent, already, at } when these words already went, or an Error with `.status` and words for the writer
 */
export async function emailAll(env, { me, subject, message, test = false, fetchImpl = fetch, now = Date.now() }) {
  const note = noteEmail({ subject, message });
  if (!seen(note.subject)) throw err('Give it a subject first.', 400);
  if (!seen(note.text)) throw err('Write the message first.', 400);
  if (note.subject.length > SUBJECT_MAX) throw err(`Keep the subject under ${SUBJECT_MAX} characters.`, 400);
  if (note.text.length > MESSAGE_MAX) throw err('That message is too long to send from here. Copy it into your mail app instead.', 400);
  if (!env.GOOGLE_CALENDAR_KEY) throw err('The site has no Google key yet, so it can’t send from your Gmail. Open it in your mail app instead.', 503);

  const who = normEmail(me);
  const want = await groupWanted(env.DB);
  const from = { name: want.members.find((p) => p.email === who)?.name || '', email: who };
  const others = want.members.filter((p) => p.email !== who);
  if (!test && !others.length) throw err('Nobody else on the board has an email on file.', 409);

  const key = test ? '' : await keyOf(note);
  if (!test) {
    const c = await claim(env, key, { by: who, n: others.length, subject: note.subject, fetchImpl, now });
    if (c.had) return { sent: c.had.sent, already: true, at: c.had.sentAt };
    if (c.unsure) throw err(cantCheck(c.by, who), 409);
    if (!c.mine) throw err(c.by && c.by !== who ? `${c.by} is sending these same words now.` : STILL_GOING, 409);
    const before = await earlierNote(env, key, { who, n: others.length, fetchImpl, now }).catch(async (e) => { await env.DB.prepare('DELETE FROM board_state WHERE key = ?').bind(key).run(); throw e; });
    if (before) {
      await env.DB.prepare('DELETE FROM board_state WHERE key = ?').bind(key).run();
      if (before.went) throw err(`Your earlier note, “${before.went}”, reached the board ${when(before.at)}. Press Send again only if this one should go too.`, 409);
      if (before.unsure) throw err('The site can’t check whether your last note went. Look in your Sent folder. If it isn’t there, press Send again.', 409);
      throw err(`Your last note, “${before.held}”, may still be going out, so this one hasn’t been sent. Give it two minutes, then press Send again.`, 409);
    }
  }

  const giveBack = async () => { if (!test) await env.DB.prepare('DELETE FROM board_state WHERE key = ?').bind(key).run(); };
  let token;
  try {
    token = await accessToken(env, who, { fetchImpl, now, scope: GMAIL_SEND_SCOPE });
  } catch (e) {
    await giveBack();
    throw err(/unauthorized_client|access_denied/.test(e.message)
      ? `Google won’t let the site send from ${who}. Open it in your mail app instead.`
      : 'Google didn’t answer, so nothing was sent. Try again in a minute.', 503);
  }
  const raw = mimeOf({
    from,
    to: test ? [from] : others,
    subject: test ? `[Test → the whole board] ${note.subject}` : note.subject,
    text: note.text,
    html: note.html,
    tag: test ? 'email-all-test' : tagOf(key),
  });
  try {
    await gmailCall(token, '/messages/send', { method: 'POST', body: { raw }, fetchImpl });
  } catch (e) {
    // Gmail said no: nothing went. No answer, or Gmail's own trouble: it may have, so its record stays until Sent says
    if (/^Gmail answered 4(?!08)/.test(e.message)) {
      await giveBack();
      throw err(`Gmail didn’t send it (${e.message.replace(/^Gmail answered \d+:?\s*/, '').slice(0, 120) || 'no reason given'}). Nothing went out.`, 503);
    }
    throw err(test ? NO_ANSWER_TEST : NO_ANSWER, 503);
  }
  if (test) return { sent: 1, test: true };
  const at = new Date(now).toISOString();
  // It went, whatever happens to the record now: the Sent folder answers for it if this doesn't save
  try {
    await env.DB.prepare('UPDATE board_state SET data = ?, updated_at = ? WHERE key = ?').bind(JSON.stringify({ at, sentAt: at, by: who, sent: others.length, subject: note.subject }), at, key).run();
    // (messages sent over two days ago are past needing a record)
    await env.DB.prepare('DELETE FROM board_state WHERE key LIKE ? AND updated_at < ?').bind(`${KEY}:%`, new Date(now - 2 * SAME_MS).toISOString()).run();
  } catch (e) {
    console.error('email-all record', e);
  }
  return { sent: others.length };
}
