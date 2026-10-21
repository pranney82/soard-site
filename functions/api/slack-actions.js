/**
 * POST /api/slack-actions — the Slack app's Interactivity Request URL
 * ====================================================================
 * Every button on the site's Slack cards opens a page, but Slack also tells
 * the app about the click and marks the button with a warning when nothing
 * answers. This answers. It takes no action, so a forged request can't do
 * anything. Only a click signed with SLACK_SIGNING_SECRET is kept; until
 * that's set, every request gets the same empty 200 and nothing is written.
 *
 * Public (in _middleware's PUBLIC_ROUTES). Set up once in api.slack.com/apps
 * → the SOARD Website app → Interactivity & Shortcuts: turn it on, Request URL
 * https://sunshineonaranneyday.com/api/slack-actions.
 * The last click is kept in site_config "slack-actions" so the admin can show
 * that buttons are answered.
 */

export const SLACK_ACTIONS_KEY = 'slack-actions';
const TOLERANCE_S = 5 * 60;

const enc = new TextEncoder();
const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

/** Slack's v0 signature: HMAC-SHA256 of "v0:{timestamp}:{body}" with the signing secret */
export async function verifySlack(secret, { timestamp, signature, body, now = Date.now() }) {
  const t = Number(timestamp);
  if (!Number.isFinite(t) || Math.abs(now / 1000 - t) > TOLERANCE_S) return false;
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expected = `v0=${toHex(await crypto.subtle.sign('HMAC', key, enc.encode(`v0:${timestamp}:${body}`)))}`;
  const got = String(signature || '');
  if (got.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < got.length; i++) diff |= got.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

export async function onRequestPost({ env, request }) {
  // Unsigned (no secret to check against): answered, never recorded, so anyone
  // on the internet can't write to D1 through here
  if (!env.SLACK_SIGNING_SECRET) return new Response('', { status: 200 });
  const body = await request.text();
  const ok = await verifySlack(env.SLACK_SIGNING_SECRET, {
    timestamp: request.headers.get('X-Slack-Request-Timestamp'),
    signature: request.headers.get('X-Slack-Signature'),
    body,
  });
  if (!ok) return new Response('bad signature', { status: 401 });
  let payload = null;
  try { payload = JSON.parse(new URLSearchParams(body).get('payload') || 'null'); } catch { /* not Slack */ }
  if (payload?.type === 'block_actions' && env.DB) {
    const data = JSON.stringify({ lastAt: new Date().toISOString(), action: String(payload.actions?.[0]?.action_id || '').slice(0, 40) });
    await env.DB.prepare('INSERT OR REPLACE INTO site_config (key, data, updated_at) VALUES (?, ?, ?)')
      .bind(SLACK_ACTIONS_KEY, data, new Date().toISOString()).run().catch(() => {});
  }
  // An empty 200 is all Slack needs for a link button
  return new Response('', { status: 200 });
}

export async function onRequestGet() {
  return Response.json({ ok: true, endpoint: 'slack-actions', method: 'POST' });
}
