/**
 * POST /api/upload-video
 * Uploads a video to Cloudflare Stream.
 * Expects multipart/form-data with:
 *   - file: the video file (MP4, MOV, MKV, WebM, etc.)
 *   - name: (optional) display name for the video
 *
 * Returns: { success, videoId, playbackUrl, thumbnailUrl }
 *
 * Environment variables needed:
 *   CF_ACCOUNT_ID, CF_STREAM_TOKEN
 *
 * Note: CF_STREAM_TOKEN requires Stream:Edit permission.
 * This is separate from CF_IMAGES_TOKEN. Create an API token at:
 * https://dash.cloudflare.com/profile/api-tokens with
 * Account > Cloudflare Stream > Edit permission.
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

    const formData = await context.request.formData();
    const file = formData.get('file');
    const name = formData.get('name');

    if (!file) {
      return Response.json(
        { success: false, error: 'No file provided' },
        { status: 400 }
      );
    }

    // Validate it's a video file
    const validTypes = [
      'video/mp4', 'video/quicktime', 'video/x-matroska',
      'video/webm', 'video/avi', 'video/x-msvideo', 'video/mpeg',
    ];
    if (file.type && !validTypes.includes(file.type)) {
      return Response.json(
        { success: false, error: `Invalid file type: ${file.type}. Upload MP4, MOV, WebM, or MKV.` },
        { status: 400 }
      );
    }

    // Upload to Cloudflare Stream via direct upload
    const uploadForm = new FormData();
    uploadForm.append('file', file);
    if (name) {
      uploadForm.append('meta', JSON.stringify({ name }));
    }

    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/stream`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${CF_STREAM_TOKEN}`,
        },
        body: uploadForm,
      }
    );

    const result = await response.json();

    if (!result.success) {
      return Response.json(
        { success: false, error: result.errors?.[0]?.message || 'Stream upload failed' },
        { status: 400 }
      );
    }

    const videoId = result.result.uid;
    const playbackUrl = `https://customer-${CF_ACCOUNT_ID}.cloudflarestream.com/${videoId}/iframe`;
    const thumbnailUrl = `https://customer-${CF_ACCOUNT_ID}.cloudflarestream.com/${videoId}/thumbnails/thumbnail.jpg?width=1280&height=720`;

    return Response.json(
      {
        success: true,
        videoId,
        playbackUrl,
        thumbnailUrl,
        status: result.result.status,
        duration: result.result.duration,
      },
      {}
    );
  } catch (err) {
    return Response.json(
      { success: false, error: err.message },
      { status: 500 }
    );
  }
}
,
  });
}
