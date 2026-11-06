/**
 * One call to the advisors' API: { ok, status, ... }, never throws. Shared by the page and Run it.
 * When Cloudflare's sign-in has run out, a call doesn't fail like a lost connection: it's sent to the sign-in page, which
 * shows as a redirect, or as a page of HTML where JSON should be. That reads as signedOut, so the page can say so.
 */
const SIGNED_OUT = { ok: false, signedOut: true, status: 401, error: 'Your sign-in ended. Reload the page to sign in again.' };

export async function api(url, body = null, { form = null } = {}) {
  let r;
  try {
    r = await fetch(url, { redirect: 'manual', ...(form ? { method: 'POST', body: form } : body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' }) });
  } catch {
    return { ok: false, error: 'No connection. Check your internet and try again.' };
  }
  if (r.type === 'opaqueredirect' || (r.status >= 300 && r.status < 400)) return { ...SIGNED_OUT };
  const json = /json/i.test(r.headers.get('content-type') || '');
  let j = null;
  if (json) { try { j = await r.json(); } catch { j = null; } }
  if (!j) return r.ok || r.status === 401 || r.status === 403 ? { ...SIGNED_OUT } : { ok: false, status: r.status, error: `Something went wrong (${r.status}). Try again.` };
  if (r.status === 403 && /sign-in expired/i.test(j.error || '')) return { ...SIGNED_OUT };
  if (!r.ok && j.ok !== false) j.ok = false;
  j.status = r.status;
  return j;
}
