/**
 * Google Calendar as a Workspace user, via a service account with
 * domain-wide delegation. Reveal invites are real events on Clareece's
 * calendar, so Google sends the invitations, updates and cancellations
 * itself and every mail app shows them as proper invites.
 *
 * GOOGLE_CALENDAR_KEY (Cloudflare secret) is the service account's JSON key.
 * Workspace Admin → Security → API controls → Domain-wide delegation must
 * grant its client ID the scope below.
 */

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const CAL_API = 'https://www.googleapis.com/calendar/v3';
export const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events';

const _tokens = new Map(); // subject → { token, expiresAt }

export function parseServiceAccount(raw) {
  let key = raw;
  if (typeof raw === 'string') {
    try { key = JSON.parse(raw); } catch { throw new Error('GOOGLE_CALENDAR_KEY is not valid JSON'); }
  }
  if (!key?.client_email || !key?.private_key) throw new Error('GOOGLE_CALENDAR_KEY is missing client_email or private_key');
  return key;
}

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlText = (text) => b64url(new TextEncoder().encode(text));

async function signingKey(pem) {
  const body = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(body), c => c.charCodeAt(0));
  return crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
}

/** Signed JWT for the token exchange, impersonating `subject` */
export async function serviceAccountJwt(key, subject, now = Date.now()) {
  const iat = Math.floor(now / 1000);
  const header = b64urlText(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64urlText(JSON.stringify({ iss: key.client_email, sub: subject, scope: CALENDAR_SCOPE, aud: TOKEN_URL, iat, exp: iat + 3600 }));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', await signingKey(key.private_key), new TextEncoder().encode(`${header}.${claims}`));
  return `${header}.${claims}.${b64url(sig)}`;
}

export async function accessToken(env, subject, { fetchImpl = fetch, now = Date.now() } = {}) {
  const cached = _tokens.get(subject);
  if (cached && cached.expiresAt - 60_000 > now) return cached.token;
  if (!env.GOOGLE_CALENDAR_KEY) throw new Error('GOOGLE_CALENDAR_KEY is not set');
  const key = parseServiceAccount(env.GOOGLE_CALENDAR_KEY);
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: await serviceAccountJwt(key, subject, now) }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    // unauthorized_client here almost always means domain-wide delegation isn't granted yet
    throw new Error(`Google sign-in failed (${res.status}): ${body.error || ''} ${body.error_description || ''}`.trim());
  }
  _tokens.set(subject, { token: body.access_token, expiresAt: now + (body.expires_in || 3600) * 1000 });
  return body.access_token;
}

export function clearTokenCache() { _tokens.clear(); }

/** Google event ids allow a-v and 0-9; hex of our own id is always valid and stable */
export function eventIdFor(prefix, id) {
  return prefix + [...new TextEncoder().encode(String(id))].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function call(token, method, path, body, fetchImpl) {
  const res = await fetchImpl(`${CAL_API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = res.status === 204 ? null : await res.json().catch(() => null);
  return { status: res.status, ok: res.ok, data };
}

/**
 * Create the event, or replace it if it already exists (including one that
 * was cancelled earlier, which brings it back). Google emails every guest.
 */
export async function upsertEvent(token, calendarId, event, { fetchImpl = fetch, sendUpdates = 'all' } = {}) {
  const cal = encodeURIComponent(calendarId);
  const existing = await call(token, 'GET', `/calendars/${cal}/events/${event.id}`, null, fetchImpl);
  const q = `?sendUpdates=${sendUpdates}`;
  const res = existing.status === 404
    ? await call(token, 'POST', `/calendars/${cal}/events${q}`, event, fetchImpl)
    : await call(token, 'PUT', `/calendars/${cal}/events/${event.id}${q}`, event, fetchImpl);
  if (!res.ok) throw new Error(`Google Calendar ${existing.status === 404 ? 'insert' : 'update'} failed (${res.status}): ${res.data?.error?.message || ''}`.trim());
  return { created: existing.status === 404, event: res.data };
}

/** Cancel the event (guests get a cancellation). Already gone is fine. */
export async function cancelEvent(token, calendarId, eventId, { fetchImpl = fetch, sendUpdates = 'all' } = {}) {
  const res = await call(token, 'DELETE', `/calendars/${encodeURIComponent(calendarId)}/events/${eventId}?sendUpdates=${sendUpdates}`, null, fetchImpl);
  if (!res.ok && res.status !== 404 && res.status !== 410) throw new Error(`Google Calendar cancel failed (${res.status}): ${res.data?.error?.message || ''}`.trim());
  return { cancelled: res.ok };
}
