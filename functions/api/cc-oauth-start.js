/**
 * GET /api/cc-oauth-start
 *
 * Initiates the Constant Contact OAuth2 Authorization Code Flow.
 * Redirects the admin to Constant Contact's consent screen.
 * After authorization, CC redirects back to /api/cc-oauth-callback.
 *
 * Admin-only (behind Cloudflare Access middleware).
 * Required env vars: CC_CLIENT_ID
 */

const AUTH_ENDPOINT = 'https://authz.constantcontact.com/oauth2/default/v1/authorize';

export async function onRequestGet(context) {
  const clientId = context.env.CC_CLIENT_ID;

  if (!clientId) {
    return new Response(
      '<h2>Missing CC_CLIENT_ID</h2><p>Set CC_CLIENT_ID in Cloudflare Pages → Settings → Environment Variables.</p>',
      { status: 503, headers: { 'Content-Type': 'text/html' } }
    );
  }

  // Build callback URL from the current request origin
  const origin = new URL(context.request.url).origin;
  const redirectUri = `${origin}/api/cc-oauth-callback`;

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: 'contact_data offline_access',
    state: crypto.randomUUID(),
  });

  return Response.redirect(`${AUTH_ENDPOINT}?${params}`, 302);
}
