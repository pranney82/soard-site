/**
 * GET /api/list-images?per_page=100&continuation_token=...
 * Lists images from Cloudflare Images v2 API with cursor-based pagination.
 *
 * Query params:
 *   - per_page: results per page (default 100, max 10000)
 *   - continuation_token: optional cursor for next page
 *
 * Returns: { success, images: [{ id, uploaded, filename, meta }], continuation_token }
 *
 * Environment variables needed:
 *   CF_ACCOUNT_ID, CF_IMAGES_TOKEN
 */
export async function onRequestGet(context) {
  try {
    const { CF_ACCOUNT_ID, CF_IMAGES_TOKEN } = context.env;

    if (!CF_ACCOUNT_ID || !CF_IMAGES_TOKEN) {
      return Response.json(
        { success: false, error: 'Missing Cloudflare credentials.' },
        { status: 500 }
      );
    }

    const url = new URL(context.request.url);
    const perPage = Math.min(parseInt(url.searchParams.get('per_page') || '100', 10), 10000);
    const continuationToken = url.searchParams.get('continuation_token') || '';

    let apiUrl = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/images/v2?per_page=${perPage}`;
    if (continuationToken) {
      apiUrl += `&continuation_token=${encodeURIComponent(continuationToken)}`;
    }

    const response = await fetch(apiUrl, {
      headers: { 'Authorization': `Bearer ${CF_IMAGES_TOKEN}` },
    });

    const result = await response.json();

    if (!result.success) {
      return Response.json(
        { success: false, error: result.errors?.[0]?.message || 'Failed to list images' },
        { status: 400 }
      );
    }

    const images = (result.result?.images || []).map(img => ({
      id: img.id,
      uploaded: img.uploaded,
      filename: img.filename || null,
      meta: img.meta || null,
    }));

    return Response.json({
      success: true,
      images,
      continuation_token: result.result?.continuation_token || null,
    });
  } catch (err) {
    console.error("[list-images]", err);
    return Response.json(
      { success: false, error: "An unexpected error occurred" },
      { status: 500 }
    );
  }
}
