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
// Board reads board mail (agendas, minutes, financials) with this one, added next to the calendar scope (_board-mail.js)
export const GMAIL_READ_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

const _tokens = new Map(); // subject → { token, expiresAt }

/**
 * The service account key as pasted into Cloudflare. Accepts the downloaded
 * JSON file as-is, plus the usual paste accidents: wrapped in quotes, curly
 * "smart" quotes, line breaks inside the private key, or base64 of the file.
 * Errors describe the value's shape without ever echoing it (JSON.parse
 * messages include a snippet of the input, so they're never passed on).
 */
export function parseServiceAccount(raw) {
  if (raw && typeof raw === 'object') return checkKey(raw);
  const text = String(raw ?? '').trim();
  const attempts = [
    text,
    text.replace(/[“”„‟″]/g, '"').replace(/[‘’]/g, "'"),
    text.replace(/[\r\n]+/g, ' '),
  ];
  if (/^[A-Za-z0-9+/=_\s-]{200,}$/.test(text)) {
    try { attempts.push(atob(text.replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/'))); } catch { /* not base64 */ }
  }
  for (const attempt of attempts) {
    let value;
    try { value = JSON.parse(attempt); } catch { continue; }
    if (typeof value === 'string') { try { value = JSON.parse(value); } catch { continue; } } // JSON wrapped in quotes
    if (value && typeof value === 'object') return checkKey(value);
  }
  throw new Error(`GOOGLE_CALENDAR_KEY is not valid JSON (${describeShape(text)}). Paste the entire downloaded .json key file, exactly as it is.`);
}

function checkKey(key) {
  const missing = ['client_email', 'private_key'].filter(f => !key[f]);
  if (missing.length) throw new Error(`GOOGLE_CALENDAR_KEY is missing ${missing.join(' and ')}. Paste the entire downloaded .json key file, not just one value from it.`);
  if (key.type && key.type !== 'service_account') throw new Error(`GOOGLE_CALENDAR_KEY is a "${key.type}" key; it needs a service account key`);
  return key;
}

/** Safe hints about a pasted value: never any of its content */
function describeShape(text) {
  const hints = [`${text.length} characters`];
  if (!text) return 'it is empty';
  if (text.includes('BEGIN PRIVATE KEY') && !text.includes('client_email')) hints.push('looks like only the private key');
  if (/^["']/.test(text)) hints.push('starts with a quote mark');
  else if (text[0] !== '{') hints.push('does not start with {');
  if (/[“”‘’]/.test(text)) hints.push('has curly quotes');
  if (text[0] === '{' && !text.endsWith('}')) hints.push('does not end with }, maybe cut off');
  return hints.join(', ');
}

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlText = (text) => b64url(new TextEncoder().encode(text));

async function signingKey(pem) {
  const body = pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(body), c => c.charCodeAt(0));
  return crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
}

/** Signed JWT for the token exchange, impersonating `subject` (the calendar scope unless another is named) */
export async function serviceAccountJwt(key, subject, now = Date.now(), scope = CALENDAR_SCOPE) {
  const iat = Math.floor(now / 1000);
  const header = b64urlText(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64urlText(JSON.stringify({ iss: key.client_email, sub: subject, scope, aud: TOKEN_URL, iat, exp: iat + 3600 }));
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', await signingKey(key.private_key), new TextEncoder().encode(`${header}.${claims}`));
  return `${header}.${claims}.${b64url(sig)}`;
}

/** A token acting as `subject`; `scope` for another Google API the delegation grants (Board reads Gmail with GMAIL_READ_SCOPE) */
export async function accessToken(env, subject, { fetchImpl = fetch, now = Date.now(), scope = CALENDAR_SCOPE } = {}) {
  const cacheKey = scope === CALENDAR_SCOPE ? subject : `${subject} ${scope}`;
  const cached = _tokens.get(cacheKey);
  if (cached && cached.expiresAt - 60_000 > now) return cached.token;
  if (!env.GOOGLE_CALENDAR_KEY) throw new Error('GOOGLE_CALENDAR_KEY is not set');
  const key = parseServiceAccount(env.GOOGLE_CALENDAR_KEY);
  const res = await fetchImpl(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: await serviceAccountJwt(key, subject, now, scope) }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.access_token) {
    // unauthorized_client here almost always means domain-wide delegation isn't granted yet
    throw new Error(`Google sign-in failed (${res.status}): ${body.error || ''} ${body.error_description || ''}`.trim());
  }
  _tokens.set(cacheKey, { token: body.access_token, expiresAt: now + (body.expires_in || 3600) * 1000 });
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
  let created = existing.status === 404;
  let res = created
    ? await call(token, 'POST', `/calendars/${cal}/events${q}`, event, fetchImpl)
    : await call(token, 'PUT', `/calendars/${cal}/events/${event.id}${q}`, event, fetchImpl);
  // Two JobTread changes at once can both see "not found"; the second insert
  // then gets 409 (the id is taken) and should simply update instead.
  if (created && res.status === 409) {
    created = false;
    res = await call(token, 'PUT', `/calendars/${cal}/events/${event.id}${q}`, event, fetchImpl);
  }
  if (!res.ok) throw new Error(`Google Calendar ${created ? 'insert' : 'update'} failed (${res.status}): ${res.data?.error?.message || ''}`.trim());
  return { created, event: res.data };
}

/** The event as it is on the calendar, or null when it isn't there */
export async function getEvent(token, calendarId, eventId, { fetchImpl = fetch } = {}) {
  const res = await call(token, 'GET', `/calendars/${encodeURIComponent(calendarId)}/events/${eventId}`, null, fetchImpl);
  if (res.status === 404 || res.status === 410) return null;
  if (!res.ok) throw new Error(`Google Calendar read failed (${res.status}): ${res.data?.error?.message || ''}`.trim());
  return res.data;
}

/**
 * Events on the calendar between two instants (RFC 3339), optionally matching
 * Google's free-text search `q`. Repeating events come back as their single
 * days. Cancelled events are left out.
 */
export async function listEvents(token, calendarId, { timeMin, timeMax, q, fetchImpl = fetch } = {}) {
  const params = new URLSearchParams({ singleEvents: 'true', maxResults: '100', timeMin, timeMax, ...(q ? { q } : {}) });
  const res = await call(token, 'GET', `/calendars/${encodeURIComponent(calendarId)}/events?${params}`, null, fetchImpl);
  if (!res.ok) throw new Error(`Google Calendar read failed (${res.status}): ${res.data?.error?.message || ''}`.trim());
  return (res.data?.items || []).filter((e) => e.status !== 'cancelled');
}

/** Cancel the event (guests get a cancellation). Already gone is fine. */
export async function cancelEvent(token, calendarId, eventId, { fetchImpl = fetch, sendUpdates = 'all' } = {}) {
  const res = await call(token, 'DELETE', `/calendars/${encodeURIComponent(calendarId)}/events/${eventId}?sendUpdates=${sendUpdates}`, null, fetchImpl);
  if (!res.ok && res.status !== 404 && res.status !== 410) throw new Error(`Google Calendar cancel failed (${res.status}): ${res.data?.error?.message || ''}`.trim());
  return { cancelled: res.ok };
}
