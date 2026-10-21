/**
 * Small security helpers shared by the public routes.
 *
 *   safeEqual(a, b)              constant-time string compare (secrets, signatures)
 *   wakeSecretOk(request, env, name)
 *                                a shared secret on a webhook / workflow wake-up,
 *                                sent as ?key=… or the X-Webhook-Secret header.
 *                                Refused when the env var is set and doesn't match;
 *                                `required: true` also refuses when it isn't set.
 *   turnstileSiteKey(env)        the public Turnstile site key (not a secret)
 *   verifyTurnstile(env, token, ip)
 *                                Cloudflare's siteverify; false on any failure
 *   clientIp(request)            CF-Connecting-IP, IPv6 folded to its /64 so one
 *                                household or one attacker's block counts once
 */

const enc = new TextEncoder();

/** Compare two strings without leaking where they differ */
export function safeEqual(a, b) {
  const x = enc.encode(String(a ?? ''));
  const y = enc.encode(String(b ?? ''));
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

/**
 * A wake-up's shared secret. JobTread workflows and other callers put it in the
 * URL (`?key=…`) or the X-Webhook-Secret header. Returns true when it matches,
 * or when no secret is configured and it isn't required.
 */
export function wakeSecretOk(request, env, name, { required = false } = {}) {
  const expected = String(env?.[name] || '').trim();
  if (!expected) return !required;
  let given = request.headers.get('X-Webhook-Secret') || '';
  if (!given) {
    try { given = new URL(request.url).searchParams.get('key') || ''; } catch { given = ''; }
  }
  return !!given && safeEqual(given.trim(), expected);
}

// The site's Turnstile widget (Cloudflare → Turnstile → sunshineonaranneyday.com).
// Site keys are public by design: they ship in every page that shows the widget.
const DEFAULT_TURNSTILE_SITE_KEY = '0x4AAAAAACpMJDcIPz2DI536';

export function turnstileSiteKey(env) {
  return String(env?.TURNSTILE_SITE_KEY || DEFAULT_TURNSTILE_SITE_KEY);
}

export function turnstileOn(env) {
  return !!(turnstileSiteKey(env) && env?.TURNSTILE_SECRET_KEY);
}

export async function verifyTurnstile(env, token, ip, { fetchImpl = fetch } = {}) {
  if (!token || !env?.TURNSTILE_SECRET_KEY) return false;
  try {
    const body = new FormData();
    body.append('secret', env.TURNSTILE_SECRET_KEY);
    body.append('response', String(token).slice(0, 2048));
    if (ip) body.append('remoteip', ip);
    const res = await fetchImpl('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body, signal: AbortSignal.timeout(8000) });
    const out = await res.json();
    return !!out.success;
  } catch {
    return false;
  }
}

/** The caller's address for limits: IPv4 as is, IPv6 folded to its /64 */
export function clientIp(request) {
  const ip = String(request.headers.get('CF-Connecting-IP') || '').trim();
  if (!ip) return 'unknown';
  if (!ip.includes(':')) return ip;
  // Expand "::" so every spelling of one address gives the same /64
  const [head, tail = ''] = ip.toLowerCase().split('%')[0].split('::');
  const left = head ? head.split(':') : [];
  const right = ip.includes('::') && tail ? tail.split(':') : [];
  const groups = ip.includes('::') ? [...left, ...Array(Math.max(0, 8 - left.length - right.length)).fill('0'), ...right] : left;
  return `${groups.slice(0, 4).map((g) => (g || '0').replace(/^0+(?=.)/, '')).join(':')}::/64`;
}
