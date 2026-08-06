/**
 * POST /api/newsletter
 *
 * Adds an email to a Resend Audience via their API, and dual-writes the
 * same address to Kit (formerly ConvertKit) when KIT_API_KEY is set —
 * both lists stay in sync while broadcasts migrate to Kit. The signup
 * succeeds if EITHER provider accepts the address.
 *
 * Cloudflare Pages env vars:
 *   RESEND_API_KEY  — Resend audience write
 *   KIT_API_KEY     — Kit subscriber write (see _kit.js, optional KIT_FORM_ID)
 *
 * Audience ID source (in priority order):
 *   1. RESEND_AUDIENCE_ID env var (override)
 *   2. Last known-good audience (per-isolate cache)
 *   3. newsletter.audienceId from site settings (set via admin panel)
 *   4. Self-heal: the "Newsletter Subscribers" audience, looked up (or created)
 *      by name — so signups keep working even if the configured audience was
 *      deleted or the settings are stale.
 *
 * Accepts both JSON (JS-enhanced) and form-encoded (no-JS fallback) POSTs.
 * JSON:  { "email": "user@example.com" }  →  { "ok": true/false }
 * Form:  standard form POST  →  302 redirect back with ?subscribed=1 or ?newsletter_error=...
 */

import { kitSubscribe } from './_kit.js';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Content-Type': 'application/json',
};

// Canonical newsletter audience used when the configured one is missing.
// If this list is renamed in Resend, the next self-heal creates a fresh empty
// list under this name — keep the Resend list name in sync with this constant.
const NEWSLETTER_AUDIENCE_NAME = 'Newsletter Subscribers';
const AUDIENCE_CACHE_TTL = 60 * 60 * 1000;
let _audienceCache = { id: null, at: 0 }; // per-isolate, survives across requests

function addContact(apiKey, audienceId, email) {
  return fetch(`https://api.resend.com/audiences/${audienceId}/contacts`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email }),
  });
}

async function resolveNewsletterAudience(apiKey) {
  try {
    const listRes = await fetch('https://api.resend.com/audiences', {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!listRes.ok) return null;
    const { data } = await listRes.json();
    let audience = (data || []).find(
      a => a.name && a.name.toLowerCase() === NEWSLETTER_AUDIENCE_NAME.toLowerCase()
    );
    if (!audience) {
      const createRes = await fetch('https://api.resend.com/audiences', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: NEWSLETTER_AUDIENCE_NAME }),
      });
      if (!createRes.ok) return null;
      audience = await createRes.json();
    }
    if (!audience || !audience.id) return null;
    _audienceCache = { id: audience.id, at: Date.now() };
    return audience.id;
  } catch (e) {
    console.error('Newsletter audience self-heal failed:', e);
    return null;
  }
}

function jsonOk(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: cors });
}

function redirect(baseUrl, path, params) {
  const url = new URL(path, baseUrl);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.hash = 'newsletter-form';
  return Response.redirect(url.toString(), 302);
}

function safeRedirectPath(referer, requestUrl) {
  try {
    const ref = new URL(referer);
    const req = new URL(requestUrl);
    if (ref.origin === req.origin) return ref.pathname;
  } catch { /* invalid URL, fall through */ }
  return '/';
}

export async function onRequestPost(context) {
  const contentType = context.request.headers.get('Content-Type') || '';
  const isFormPost = !contentType.includes('application/json');
  const redirectPath = safeRedirectPath(
    context.request.headers.get('Referer') || '',
    context.request.url
  );
  const origin = new URL(context.request.url).origin;

  try {
    let email, hp;

    if (contentType.includes('application/json')) {
      ({ email, hp } = await context.request.json());
    } else {
      const form = await context.request.formData();
      email = form.get('email');
      hp = form.get('website');
    }

    // Honeypot: if the hidden field has a value, it's a bot
    if (hp) {
      if (isFormPost) return redirect(origin, redirectPath, { subscribed: '1' });
      return jsonOk({ ok: true });
    }

    email = String(email || '').trim().toLowerCase();
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      if (isFormPost) return redirect(origin, redirectPath, { newsletter_error: 'invalid_email' });
      return jsonOk({ ok: false, error: 'Please enter a valid email address.' }, 400);
    }

    const apiKey = context.env.RESEND_API_KEY;

    // Kit dual-write runs concurrently with the Resend flow below; the
    // signup succeeds if either provider accepts the address.
    const kitPromise = kitSubscribe(context.env, email);

    let resendOk = false;
    if (!apiKey) {
      console.error('RESEND_API_KEY is not set');
    } else {
      // Resolve audience ID: env var takes priority, then the last known-good
      // audience for this isolate, then static config from admin
      let audienceId = context.env.RESEND_AUDIENCE_ID || '';
      if (!audienceId && _audienceCache.id && Date.now() - _audienceCache.at < AUDIENCE_CACHE_TTL) {
        audienceId = _audienceCache.id;
      }
      if (!audienceId) {
        try {
          const configRes = await context.env.ASSETS.fetch(
            new URL('/newsletter-config.json', context.request.url)
          );
          if (configRes.ok) {
            const config = await configRes.json();
            audienceId = config.audienceId || '';
          }
        } catch (e) {
          console.error('Failed to read newsletter config:', e);
        }
      }

      let res = audienceId ? await addContact(apiKey, audienceId, email) : null;

      // Self-heal: no audience configured, or the configured one no longer exists
      // (audiences have been deleted/recreated in Resend before) — fall back to
      // the canonical newsletter audience by name so signups never silently die.
      if (!res || res.status === 404) {
        const healedId = await resolveNewsletterAudience(apiKey);
        if (healedId && healedId !== audienceId) {
          console.warn(`Configured audience ${audienceId || '(none)'} unavailable — using "${NEWSLETTER_AUDIENCE_NAME}" (${healedId}). Update Site Settings → Newsletter in admin to match.`);
          audienceId = healedId;
          res = await addContact(apiKey, audienceId, email);
        }
      }

      if (!res) {
        console.error('No Resend audience configured and self-heal failed');
      } else if (res.ok) {
        resendOk = true;
      } else if (res.status === 409) {
        // Resend returns 409 if contact already exists. Re-subscribe them in case
        // they previously unsubscribed — best-effort, still a success for the user.
        try {
          await fetch(`https://api.resend.com/audiences/${audienceId}/contacts/${encodeURIComponent(email)}`, {
            method: 'PATCH',
            headers: {
              Authorization: `Bearer ${apiKey}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify({ unsubscribed: false }),
          });
        } catch (e) {
          console.error('Resend re-subscribe PATCH failed:', e);
        }
        resendOk = true;
      } else {
        const errBody = await res.text();
        console.error(`Resend API error ${res.status}: ${errBody}`);
      }
    }

    const kit = await kitPromise;

    if (resendOk || kit.ok) {
      if (isFormPost) return redirect(origin, redirectPath, { subscribed: '1' });
      return jsonOk({ ok: true });
    }

    if (!apiKey && !kit.configured) {
      if (isFormPost) return redirect(origin, redirectPath, { newsletter_error: 'not_configured' });
      return jsonOk({ ok: false, error: 'Newsletter signup is not configured yet. Please try again later.' }, 503);
    }

    // 503, not 502: Cloudflare replaces 502/504 bodies with its own error page,
    // which would hide this JSON from the client.
    if (isFormPost) return redirect(origin, redirectPath, { newsletter_error: 'server' });
    return jsonOk({ ok: false, error: 'Something went wrong. Please try again.' }, 503);
  } catch (err) {
    console.error('Newsletter handler error:', err);
    if (isFormPost) return redirect(origin, redirectPath, { newsletter_error: 'server' });
    return jsonOk({ ok: false, error: 'Something went wrong. Please try again.' }, 500);
  }
}

// Handle CORS preflight
export async function onRequestOptions() {
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
