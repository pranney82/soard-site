/**
 * /api/mailbox-admin — read a SOARD inbox (founders only, Access like every admin route; see _mailbox.js)
 * ===========================================================================
 * GET                                → { success, mailboxes }   active accounts and their aliases
 * GET ?mailbox=&q=&max=&page=        → { success, mailbox, q, total, next, messages }   Gmail's search words, newest first
 * GET ?mailbox=&id=                  → { success, mailbox, message }   one email: its words and files
 * GET ?mailbox=&thread=              → { success, mailbox, thread, messages }   a whole conversation
 * GET ?mailbox=&id=&part=            → the attached file, always as a download
 * Read-only: there is no POST.
 */
import { canRead, mailboxes, searchMail, readMessage, readThread, readFile } from './_mailbox.js';

const headers = { 'Cache-Control': 'no-store' };
const reply = (body, status = 200) => Response.json(body, { status, headers });
// Opened from the admin's own address, so only types a browser shows safely keep theirs; anything else (HTML, SVG) is just bytes
const SHOWN = /^(application\/pdf|image\/(png|jpeg|gif|webp|heic|heif))$/i;

export async function onRequestGet(context) {
  const { env } = context;
  const me = context.data?.userEmail || '';
  try {
    if (!(await canRead(env, me))) return reply({ success: false, error: 'Reading a SOARD mailbox is open only to the founders on People → Team' }, 403);
    const p = new URL(context.request.url).searchParams;
    const mailbox = p.get('mailbox');
    if (!mailbox) return reply({ success: true, mailboxes: await mailboxes(env) });
    if (p.get('part')) {
      const f = await readFile(env, { me, mailbox, id: p.get('id'), part: p.get('part') });
      return new Response(f.bytes, {
        headers: {
          ...headers,
          'Content-Type': SHOWN.test(f.type) ? f.type : 'application/octet-stream',
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`,
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "sandbox; default-src 'none'",
        },
      });
    }
    if (p.get('thread')) return reply({ success: true, ...(await readThread(env, { me, mailbox, thread: p.get('thread') })) });
    if (p.get('id')) return reply({ success: true, ...(await readMessage(env, { me, mailbox, id: p.get('id') })) });
    return reply({ success: true, ...(await searchMail(env, { me, mailbox, q: p.get('q') || '', max: p.get('max'), page: p.get('page') || '' })) });
  } catch (err) {
    if (!err.status) console.error('[mailbox-admin]', err);
    return reply({ success: false, error: err.message || 'Couldn’t read that mailbox' }, err.status && err.status < 500 ? err.status : 500);
  }
}
