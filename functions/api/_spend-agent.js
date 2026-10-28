/**
 * The key the DataX agents use to reach the job-cost endpoints
 * ===========================================================================
 * /api/spend-rules, /api/spend-hint and /api/spend-recode are public routes
 * (DataX isn't behind Cloudflare Access), so each checks this key: made by
 * the site the first time it's asked for, kept in D1 spend_state "agent",
 * and written into the agents' instructions. Sent as X-Agent-Key or ?key=.
 */

import { readState, writeState } from './_mercury.js';
import { safeEqual, clientIp } from './_secure.js';
import { limit, tooMany } from './_rate-limit.js';

const KEY = 'agent';

export async function agentKey(DB) {
  const st = await readState(DB, KEY);
  if (st.key) return st.key;
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  const key = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  await writeState(DB, KEY, { key, at: new Date().toISOString() });
  return key;
}

/** null when the request may go on, else the Response to send */
export async function agentGate(env, request) {
  if (!env.DB) return Response.json({ ok: false, error: 'D1 binding missing' }, { status: 503 });
  const rl = await limit(env.DB, `spend-agent:${clientIp(request)}`, 120, 60);
  if (!rl.ok) return tooMany(rl.retryAfter);
  const url = new URL(request.url);
  const sent = request.headers.get('X-Agent-Key') || url.searchParams.get('key') || '';
  const key = (await readState(env.DB, KEY)).key;
  if (!key || !sent || !safeEqual(sent, key)) return Response.json({ ok: false, error: 'bad key' }, { status: 401 });
  await writeState(env.DB, KEY, { lastUsedAt: new Date().toISOString(), lastPath: url.pathname });
  return null;
}
