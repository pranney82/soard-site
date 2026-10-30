/**
 * /api/bank-admin (Cloudflare Access) — Settings → Bank balances: the banks outside Mercury that the
 * board page's cash counts, connected through Plaid (./_plaid.js). Only the Board area's admins, like
 * /api/board-admin: every other staff sign-in gets 403, and a board member's sign-in never gets this far.
 *
 * GET                                  → { status: { configured, env, banks: [{ itemId, bank, accounts, readAt, trouble, needsSignIn }] }, mercury }
 * POST { action, ... } (JSON):
 *   link-token { itemId? }             a one-time token for Plaid's window (itemId: sign in to that bank again)
 *   connect { publicToken, institution: { id, name } }   Plaid's window said yes: keep the bank, read it now
 *   refresh { itemId }                 after signing in again: read it now (its trouble clears when it reads)
 *   disconnect { itemId }              Plaid and SOARD forget the bank; the board page stops counting it
 *
 * Never a balance, an account number or a token in an answer: amounts are the board page's.
 */

import { ensureSchema } from './_board.js';
import { isBoardAdmin, isStaffEmail, readState } from './_board-roles.js';
import { plaidConfigured, linkToken, connectBank, readBanks, disconnectBank, bankStatus } from './_plaid.js';
import { logAudit } from './_audit.js';

const fail = (error, status = 400) => Response.json({ ok: false, error }, { status });
const fromError = (err) => (err.status && err.status < 500 ? fail(err.message, err.status) : Response.json({ ok: false, error: err.message }, { status: 500 }));

async function gate(context) {
  const me = context.data?.userEmail || '';
  await ensureSchema(context.env.DB);
  if (!isStaffEmail(me) || !(await isBoardAdmin(context.env.DB, me))) return { me, refused: fail('Bank balances are open only to the people Board → Settings lists', 403) };
  return { me };
}

/** Mercury's side, from the board's last read of it (names only) */
async function mercuryNow(env) {
  const on = !!String(env.MERCURY_API_TOKEN || '').trim() && !!String(env.MERCURY_RELAY_KEY || '').trim();
  if (!on) return { on, accounts: [], readAt: null };
  const c = await readState(env.DB, 'cash');
  return { on, accounts: (c.value?.accounts || []).filter((a) => !a.bank || a.bank === 'Mercury').map((a) => a.name), readAt: c.at || null };
}

const answer = async (env) => Response.json({ ok: true, status: await bankStatus(env), mercury: await mercuryNow(env) }, { headers: { 'Cache-Control': 'no-store' } });

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
  const audit = (action, name) => logAudit(env.DB, { userEmail: me, action, entityType: 'board', entitySlug: 'bank-balances', entityName: name, gitStatus: 'ok' }).catch(() => {});
  try {
    if (!plaidConfigured(env)) return fail('Plaid’s keys aren’t in Cloudflare yet (PLAID_CLIENT_ID and PLAID_SECRET)', 409);
    const itemId = body.itemId ? String(body.itemId) : null;
    switch (body.action) {
      case 'link-token':
        return Response.json({ ok: true, linkToken: await linkToken(env, { email: me, itemId }) });
      case 'connect': {
        await connectBank(env, { publicToken: body.publicToken, institution: body.institution || {}, by: me });
        await audit('created', `Bank connected for the board page: ${String(body.institution?.name || 'a bank').slice(0, 60)}`);
        return answer(env);
      }
      case 'refresh':
        if (!itemId) return fail('Which bank?');
        await readBanks(env, { only: itemId });
        return answer(env);
      case 'disconnect': {
        if (!itemId) return fail('Which bank?');
        const bank = (await bankStatus(env)).banks.find((b) => b.itemId === itemId)?.bank || 'A bank';
        await disconnectBank(env, itemId);
        await audit('deleted', `Bank disconnected from the board page: ${bank}`);
        return answer(env);
      }
      default:
        return fail('Unknown action');
    }
  } catch (err) {
    return fromError(err);
  }
}
