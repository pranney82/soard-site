/**
 * POST /api/upload-video
 * Creates a Cloudflare Stream direct creator upload URL.
 * The browser then uploads directly to Stream via TUS protocol —
 * the video never passes through this function.
 *
 * Expects JSON body: { name?, fileSize }
 * Returns: { success, uploadUrl, videoId }
 *
 * Environment variables needed:
 *   CF_ACCOUNT_ID, CF_STREAM_TOKEN
 *
 * Note: CF_STREAM_TOKEN requires Stream:Edit permission.
 */

// Never answer 502 or 504 from a Pages Function. Cloudflare's edge replaces the
// body of any 502/504 response, whether from an origin or a Worker, with its
// branded HTML "Bad gateway" page. The admin could then only report "returned
// HTTP 502 instead of JSON" and the real Stream error was never visible.
// 500 passes through untouched (see developers.cloudflare.com/rules/custom-errors).
const UPSTREAM_ERROR_STATUS = 500;

export async function onRequestPost(context) {
  try {
    const { CF_ACCOUNT_ID, CF_STREAM_TOKEN } = context.env;

    if (!CF_ACCOUNT_ID || !CF_STREAM_TOKEN) {
      return Response.json(
        { success: false, error: 'Missing Cloudflare credentials. Set CF_ACCOUNT_ID and CF_STREAM_TOKEN in Pages settings.' },
        { status: 500 }
      );
    }

    const { name, fileSize } = await context.request.json();

    if (!fileSize || fileSize <= 0) {
      return Response.json(
        { success: false, error: 'fileSize is required' },
        { status: 400 }
      );
    }

    // Build TUS Upload-Metadata header (base64-encode each value per spec).
    // btoa() only handles Latin1 — encode UTF-8 first so names with em-dashes,
    // smart quotes, emoji, etc. don't crash the request.
    const b64Utf8 = (s) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
    const metaParts = [];
    if (name) metaParts.push(`name ${b64Utf8(name)}`);

    // Stream restricts which origins can upload to the one-time URL via CORS.
    // Without `allowedorigins`, the browser's HEAD/PATCH gets blocked at preflight
    // and tus-js-client reports "failed to resume upload" with response code n/a.
    // Derive the hostname from the request Origin so the browser is allowed.
    const origin = context.request.headers.get('origin') || '';
    let allowedHost = '';
    try {
      if (origin) allowedHost = new URL(origin).host;
    } catch {
      allowedHost = '';
    }
    if (allowedHost) metaParts.push(`allowedorigins ${b64Utf8(allowedHost)}`);

    // Bounded + retried so a slow Stream API cannot hang the invocation.
    let response;
    let lastError = '';
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        response = await fetch(
          `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/stream?direct_user=true`,
          {
            method: 'POST',
            signal: AbortSignal.timeout(10000),
            headers: {
              'Authorization': `Bearer ${CF_STREAM_TOKEN}`,
              'Tus-Resumable': '1.0.0',
              'Upload-Length': String(fileSize),
              ...(metaParts.length > 0 && { 'Upload-Metadata': metaParts.join(',') }),
            },
          }
        );
      } catch (err) {
        lastError = err?.name === 'TimeoutError'
          ? 'Stream API did not respond within 10s'
          : `Stream API request failed: ${err?.message || err}`;
        console.error('[upload-video]', lastError);
        continue;
      }
      if (response.status < 500) break;
      lastError = `Stream API error ${response.status}`;
    }

    if (!response) {
      return Response.json({ success: false, error: lastError || 'Stream API unreachable' }, { status: UPSTREAM_ERROR_STATUS });
    }

    if (!response.ok) {
      const text = await response.text();
      console.error('[upload-video] Stream API error:', response.status, text);
      let detail = '';
      try {
        const parsed = JSON.parse(text);
        detail = parsed?.errors?.[0]?.message || parsed?.error || '';
      } catch {
        detail = text.slice(0, 200);
      }
      return Response.json(
        { success: false, error: `Stream API error ${response.status}${detail ? `: ${detail}` : ''}` },
        { status: UPSTREAM_ERROR_STATUS }
      );
    }

    const uploadUrl = response.headers.get('location');
    const videoId = response.headers.get('stream-media-id');

    if (!uploadUrl || !videoId) {
      return Response.json(
        { success: false, error: 'Stream API did not return upload URL or video ID' },
        { status: UPSTREAM_ERROR_STATUS }
      );
    }

    return Response.json({ success: true, uploadUrl, videoId });
  } catch (err) {
    console.error('[upload-video]', err);
    return Response.json(
      { success: false, error: 'An unexpected error occurred' },
      { status: 500 }
    );
  }
}

/**
 * GET /api/upload-video — health check.
 * Open this URL in a browser tab while signed in to the admin: it reports
 * whether the Stream credentials are present and what the Stream API says,
 * without uploading anything. Returns no secrets, only status codes and
 * messages, so its output is safe to paste into a bug report.
 */
export async function onRequestGet(context) {
  const { CF_ACCOUNT_ID, CF_STREAM_TOKEN } = context.env;
  const report = {
    endpoint: '/api/upload-video',
    checkedAt: new Date().toISOString(),
    accountIdSet: !!CF_ACCOUNT_ID,
    streamTokenSet: !!CF_STREAM_TOKEN,
  };

  if (!CF_ACCOUNT_ID || !CF_STREAM_TOKEN) {
    return Response.json({ ...report, ok: false, error: 'Missing CF_ACCOUNT_ID or CF_STREAM_TOKEN' }, { status: 500 });
  }

  const started = Date.now();
  try {
    const res = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/stream?per_page=1`,
      { headers: { Authorization: `Bearer ${CF_STREAM_TOKEN}` }, signal: AbortSignal.timeout(10000) }
    );
    const text = await res.text();
    let firstError = '';
    try { firstError = JSON.parse(text)?.errors?.[0]?.message || ''; } catch { firstError = text.slice(0, 200); }
    return Response.json({
      ...report,
      ok: res.ok,
      streamApiStatus: res.status,
      streamApiMs: Date.now() - started,
      ...(firstError && { streamApiError: firstError }),
    });
  } catch (err) {
    return Response.json({
      ...report,
      ok: false,
      streamApiMs: Date.now() - started,
      error: err?.name === 'TimeoutError' ? 'Stream API did not respond within 10s' : `Stream API request failed: ${err?.message || err}`,
    }, { status: UPSTREAM_ERROR_STATUS });
  }
}
