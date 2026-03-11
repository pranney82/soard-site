/**
 * GET /api/cc-oauth-callback
 *
 * Handles the OAuth2 redirect from Constant Contact.
 * Exchanges the authorization code for an access + refresh token,
 * then displays the refresh token for the admin to copy into env vars.
 *
 * Admin-only (behind Cloudflare Access middleware).
 * Required env vars: CC_CLIENT_ID, CC_CLIENT_SECRET
 */

const TOKEN_ENDPOINT = 'https://authz.constantcontact.com/oauth2/default/v1/token';

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  if (error) {
    return htmlResponse(`
      <h2>Authorization Denied</h2>
      <p>Constant Contact returned: <code>${escHtml(error)}</code></p>
      <p>${escHtml(url.searchParams.get('error_description') || '')}</p>
      <p><a href="/admin/">← Back to Admin</a></p>
    `, 400);
  }

  if (!code) {
    return htmlResponse(`
      <h2>Missing Authorization Code</h2>
      <p>No code parameter received from Constant Contact.</p>
      <p><a href="/admin/">← Back to Admin</a></p>
    `, 400);
  }

  const { CC_CLIENT_ID, CC_CLIENT_SECRET } = context.env;
  if (!CC_CLIENT_ID || !CC_CLIENT_SECRET) {
    return htmlResponse(`
      <h2>Missing Credentials</h2>
      <p>Set CC_CLIENT_ID and CC_CLIENT_SECRET in Cloudflare Pages env vars.</p>
    `, 503);
  }

  const redirectUri = `${url.origin}/api/cc-oauth-callback`;
  const credentials = btoa(`${CC_CLIENT_ID}:${CC_CLIENT_SECRET}`);

  try {
    const res = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${credentials}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        redirect_uri: redirectUri,
      }),
    });

    const body = await res.text();

    if (!res.ok) {
      console.error(`CC token exchange failed (${res.status}): ${body}`);
      return htmlResponse(`
        <h2>Token Exchange Failed</h2>
        <p>Constant Contact returned HTTP ${res.status}.</p>
        <p>Auth codes expire in 60 seconds — if you waited too long, <a href="/api/cc-oauth-start">try again</a>.</p>
        <p><a href="/admin/">← Back to Admin</a></p>
      `, 502);
    }

    const data = JSON.parse(body);
    const refreshToken = data.refresh_token;
    const accessToken = data.access_token;

    // Verify the access token works by fetching account info
    const verifyRes = await fetch('https://api.cc.email/v3/account/summary', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const accountOk = verifyRes.ok;
    let accountName = '';
    if (accountOk) {
      try {
        const acct = await verifyRes.json();
        accountName = acct.organization_name || acct.first_name || '';
      } catch { /* ignore */ }
    }

    return htmlResponse(`
      <h2>Connected to Constant Contact${accountName ? `: ${escHtml(accountName)}` : ''}</h2>
      <p>Copy the refresh token below and add it as <code>CC_REFRESH_TOKEN</code> in
      <strong>Cloudflare Pages → Settings → Environment Variables</strong>.</p>

      <div style="position: relative; margin: 1.5rem 0;">
        <pre id="token" style="background: #1a1b1f; color: #ffd500; padding: 1rem; border-radius: 8px; word-break: break-all; font-size: 0.85rem; cursor: pointer;">${escHtml(refreshToken)}</pre>
        <button onclick="navigator.clipboard.writeText(document.getElementById('token').textContent).then(()=>{this.textContent='Copied!';setTimeout(()=>this.textContent='Copy',2000)})" style="position: absolute; top: 0.5rem; right: 0.5rem; padding: 0.3rem 0.8rem; border: 1px solid #ffd500; background: transparent; color: #ffd500; border-radius: 4px; cursor: pointer; font-size: 0.8rem;">Copy</button>
      </div>

      <h3>Env vars checklist:</h3>
      <table style="border-collapse: collapse; width: 100%; margin: 1rem 0;">
        <tr><td style="padding: 0.4rem; border-bottom: 1px solid #ddd;"><code>CC_CLIENT_ID</code></td><td style="padding: 0.4rem; border-bottom: 1px solid #ddd;">${accountOk ? '✅' : '⚠️'} Already set</td></tr>
        <tr><td style="padding: 0.4rem; border-bottom: 1px solid #ddd;"><code>CC_CLIENT_SECRET</code></td><td style="padding: 0.4rem; border-bottom: 1px solid #ddd;">${accountOk ? '✅' : '⚠️'} Already set</td></tr>
        <tr><td style="padding: 0.4rem; border-bottom: 1px solid #ddd;"><code>CC_REFRESH_TOKEN</code></td><td style="padding: 0.4rem; border-bottom: 1px solid #ddd;">⬆️ Copy from above</td></tr>
      </table>

      <p style="color: #666; font-size: 0.9rem;">You can delete <code>CC_API_TOKEN</code> — it's no longer used.</p>

      <p><a href="/admin/" style="display: inline-block; margin-top: 1rem; padding: 0.6rem 1.5rem; background: #ffd500; color: #1a1b1f; border-radius: 6px; text-decoration: none; font-weight: 600;">← Back to Admin</a></p>
    `);
  } catch (err) {
    console.error('CC OAuth callback error:', err);
    return htmlResponse(`
      <h2>Something Went Wrong</h2>
      <p>${escHtml(err.message)}</p>
      <p><a href="/api/cc-oauth-start">Try again</a> · <a href="/admin/">Back to Admin</a></p>
    `, 500);
  }
}

function htmlResponse(body, status = 200) {
  return new Response(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Constant Contact Setup — SOARD Admin</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 640px; margin: 2rem auto; padding: 0 1rem; line-height: 1.6; color: #2d2e33; }
    code { background: #f5f4f0; padding: 0.15rem 0.4rem; border-radius: 3px; font-size: 0.9em; }
    h2 { color: #2d2e33; }
    a { color: #7a00df; }
  </style>
</head>
<body>${body}</body>
</html>`, { status, headers: { 'Content-Type': 'text/html' } });
}

function escHtml(str) {
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
