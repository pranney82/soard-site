/**
 * /api/reminders — "remind me when the reveal goes live"
 * =======================================================
 * POST (public, rate limited)
 *   { channel: 'email', email, kidSlug?, hp }
 *   { channel: 'sms',   phone, kidSlug?, hp }
 *   { channel: 'push',  subscription: PushSubscription JSON, kidSlug? }
 *   → { ok, channel }
 * GET  ?unsubscribe=<token>   one-click stop (HTML confirmation)
 * GET  ?ics=1                 calendar file for the scheduled reveal
 * GET  ?key=1                 VAPID public key for push subscriptions
 *
 * kidSlug scopes reminders to one reveal; omitted = every reveal.
 */

import { ensureSchema, readConfig, readState, liveUrlFor, recordEvent } from './_broadcast.js';
import * as notify from './_broadcast-notify.js';

const HTML_HEADERS = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' };

function page(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${notify.escapeHtml(title)} | Sunshine on a Ranney Day</title>
<style>body{margin:0;font-family:Outfit,Helvetica,Arial,sans-serif;background:#FEFCF5;color:#2D2E33;display:grid;place-items:center;min-height:100vh;padding:24px}main{max-width:480px;text-align:center}h1{font-family:'Libre Baskerville',Georgia,serif;font-size:1.75rem}a.btn{display:inline-block;margin-top:16px;background:#FFDA24;color:#2D2E33;font-weight:700;text-decoration:none;padding:12px 22px;border-radius:10px}p{line-height:1.6}</style></head>
<body><main><h1>${notify.escapeHtml(title)}</h1>${body}<a class="btn" href="https://sunshineonaranneyday.com/">Back to the site</a></main></body></html>`;
}

function token() {
  const b = crypto.getRandomValues(new Uint8Array(18));
  return notify.b64u.encode(b);
}

export async function onRequestGet(context) {
  const { env } = context;
  const url = new URL(context.request.url);
  try {
    await ensureSchema(env.DB);

    if (url.searchParams.has('unsubscribe')) {
      const t = String(url.searchParams.get('unsubscribe') || '').slice(0, 64);
      const row = t ? await env.DB.prepare('SELECT id, channel FROM broadcast_reminders WHERE token = ?').bind(t).first() : null;
      if (!row) return new Response(page('That link has already been used', '<p>You are not on the reminder list, or this link expired.</p>'), { headers: HTML_HEADERS, status: 404 });
      await env.DB.prepare('UPDATE broadcast_reminders SET unsubscribed_at = ? WHERE id = ?').bind(new Date().toISOString(), row.id).run();
      return new Response(page('Reminders stopped', '<p>You will not get any more reveal reminders. You can sign up again any time from a reveal page.</p>'), { headers: HTML_HEADERS });
    }

    if (url.searchParams.get('key') === '1') {
      const config = await readConfig(env.DB);
      return Response.json({ ok: true, publicKey: config.vapid?.publicKey || null, enabled: !!(config.reminders?.push && config.vapid?.publicKey) }, { headers: { 'Cache-Control': 'public, max-age=300' } });
    }

    if (url.searchParams.get('ics') === '1') {
      const [config, state] = await Promise.all([readConfig(env.DB), readState(env.DB)]);
      if (!state.scheduledAt || !['scheduled', 'armed'].includes(state.phase)) {
        return new Response(page('Nothing scheduled yet', '<p>There is no reveal on the calendar right now. Check back soon.</p>'), { headers: HTML_HEADERS, status: 404 });
      }
      const ics = notify.buildIcs({
        uid: state.broadcastId,
        title: state.title || 'Live room reveal',
        description: `${state.message || 'Watch the reveal live.'}\nWatch: ${liveUrlFor(state)}`,
        start: state.scheduledAt,
        durationMin: 60,
        url: liveUrlFor(state),
      });
      return new Response(ics, { headers: { 'Content-Type': 'text/calendar; charset=utf-8', 'Content-Disposition': `attachment; filename="soard-reveal.ics"`, 'Cache-Control': 'no-store' } });
    }

    return Response.json({ ok: true, endpoint: 'reminders' });
  } catch (err) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
}

export async function onRequestPost(context) {
  const { env } = context;
  let body = {};
  const ct = context.request.headers.get('content-type') || '';
  try {
    if (ct.includes('application/json')) body = await context.request.json();
    else { const f = await context.request.formData(); body = Object.fromEntries(f.entries()); }
  } catch { /* empty */ }

  // Honeypot: bots fill hidden fields; pretend it worked
  if (body.hp || body.website) return Response.json({ ok: true, channel: body.channel || 'email' });

  try {
    await ensureSchema(env.DB);
    const config = await readConfig(env.DB);
    const channel = String(body.channel || 'email').toLowerCase();
    const kidSlug = body.kidSlug ? String(body.kidSlug).replace(/[^a-z0-9-]/gi, '').slice(0, 80) || null : null;
    const source = String(body.source || 'live-page').slice(0, 40);
    let address, subscription = null;

    if (channel === 'email') {
      address = String(body.email || '').trim().toLowerCase();
      if (!notify.isEmail(address)) return Response.json({ ok: false, error: 'Enter a valid email address' }, { status: 400 });
      if (!notify.emailConfigured(env)) return Response.json({ ok: false, error: 'Email reminders are not available right now' }, { status: 503 });
    } else if (channel === 'sms') {
      address = notify.normalizePhone(body.phone);
      if (!address) return Response.json({ ok: false, error: 'Enter a valid mobile number' }, { status: 400 });
      if (!(config.reminders?.sms && notify.smsConfigured(env))) return Response.json({ ok: false, error: 'Text reminders are not available right now' }, { status: 503 });
    } else if (channel === 'push') {
      const sub = typeof body.subscription === 'string' ? JSON.parse(body.subscription) : body.subscription;
      if (!sub?.endpoint || !sub?.keys?.p256dh || !sub?.keys?.auth || !/^https:\/\//.test(sub.endpoint)) return Response.json({ ok: false, error: 'Invalid push subscription' }, { status: 400 });
      if (!(config.reminders?.push && config.vapid?.publicKey)) return Response.json({ ok: false, error: 'Push reminders are not available right now' }, { status: 503 });
      address = sub.endpoint.slice(0, 1000);
      subscription = JSON.stringify({ endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } });
    } else {
      return Response.json({ ok: false, error: 'Unknown channel' }, { status: 400 });
    }

    const id = crypto.randomUUID();
    const t = token();
    const now = new Date().toISOString();
    await env.DB.prepare(`INSERT INTO broadcast_reminders (id, channel, address, subscription, kid_slug, token, source, created_at, unsubscribed_at, last_sent_at, fails)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0)
      ON CONFLICT(channel, address) DO UPDATE SET unsubscribed_at = NULL, kid_slug = excluded.kid_slug, subscription = excluded.subscription, source = excluded.source, fails = 0`)
      .bind(id, channel, address, subscription, kidSlug, t, source, now).run();

    const state = await readState(env.DB);
    context.waitUntil(recordEvent(env.DB, state.broadcastId, 'reminder_signup', { channel, kidSlug, source }));
    return Response.json({ ok: true, channel });
  } catch (err) {
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
}
