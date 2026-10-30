/**
 * /api/books-admin (Cloudflare Access) — Settings → QuickBooks: the cash and the year's revenue and expenses
 * so far on the board page, read from QuickBooks (./_quickbooks.js). Only the Board area's admins, like
 * /api/bank-admin: every other staff sign-in gets 403, and a board member's sign-in never gets this far.
 *
 * GET                       → { status: { configured, env, redirectUri, connected: { company, readAt, through, trouble, needsConnect } | null } }
 * POST { action } (JSON):
 *   connect                 → { url }: Intuit's sign-in page; it comes back through /api/books-callback
 *   disconnect              Intuit and SOARD forget the connection; the board page goes back to the packet's sheet
 *
 * Never an amount or a token in an answer: amounts are the board page's.
 */

import { ensureSchema } from './_board.js';
import { isBoardAdmin, isStaffEmail } from './_board-roles.js';
import { booksConfigured, connectUrl, disconnectBooks, booksStatus } from './_quickbooks.js';
import { logAudit } from './_audit.js';

const fail = (error, status = 400) => Response.json({ ok: false, error }, { status });
const fromError = (err) => (err.status && err.status < 500 ? fail(err.message, err.status) : Response.json({ ok: false, error: err.message }, { status: 500 }));

async function gate(context) {
  const me = context.data?.userEmail || '';
  await ensureSchema(context.env.DB);
  if (!isStaffEmail(me) || !(await isBoardAdmin(context.env.DB, me))) return { me, refused: fail('QuickBooks is open only to the people Board → Settings lists', 403) };
  return { me };
}

const answer = async (env) => Response.json({ ok: true, status: await booksStatus(env) }, { headers: { 'Cache-Control': 'no-store' } });

export async function onRequestGet(context) {
  const { refused } = await gate(context);
  if (refused) return refused;
  try {
    return await answer(context.env);
  } catch (err) {
    return fromError(err);
  }
}

export async function onRequestPost(context) {
  const { env, request } = context;
  const { me, refused } = await gate(context);
  if (refused) return refused;
  let body = {};
  try { body = await request.json(); } catch { return fail('Expected JSON'); }
  try {
    if (!booksConfigured(env)) return fail('QuickBooks’ keys aren’t in Cloudflare yet (QBO_CLIENT_ID and QBO_CLIENT_SECRET)', 409);
    switch (body.action) {
      case 'connect':
        return Response.json({ ok: true, url: await connectUrl(env, { by: me }) }, { headers: { 'Cache-Control': 'no-store' } });
      case 'disconnect': {
        const company = (await booksStatus(env)).connected?.company || 'QuickBooks';
        await disconnectBooks(env);
        await logAudit(env.DB, { userEmail: me, action: 'deleted', entityType: 'board', entitySlug: 'quickbooks', entityName: `QuickBooks disconnected from the board page: ${company}`, gitStatus: 'ok' }).catch(() => {});
        return answer(env);
      }
      default:
        return fail('Unknown action');
    }
  } catch (err) {
    return fromError(err);
  }
}
