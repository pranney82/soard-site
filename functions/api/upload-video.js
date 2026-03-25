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

    // Build TUS Upload-Metadata header (base64-encode each value per spec)
    const metaParts = [];
    if (name) metaParts.push(`name ${btoa(name)}`);

    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/stream?direct_user=true`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${CF_STREAM_TOKEN}`,
          'Tus-Resumable': '1.0.0',
          'Upload-Length': String(fileSize),
          ...(metaParts.length > 0 && { 'Upload-Metadata': metaParts.join(',') }),
        },
      }
    );

    if (!response.ok) {
      const text = await response.text();
      console.error('[upload-video] Stream API error:', response.status, text);
      return Response.json(
        { success: false, error: `Stream API error: ${response.status}` },
        { status: 502 }
      );
    }

    const uploadUrl = response.headers.get('location');
    const videoId = response.headers.get('stream-media-id');

    if (!uploadUrl || !videoId) {
      return Response.json(
        { success: false, error: 'Stream API did not return upload URL or video ID' },
        { status: 502 }
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
