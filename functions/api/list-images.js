/**
 * GET /api/list-images?page=1&search=kids/harper
 * Lists images from Cloudflare Images with pagination and optional search.
 *
 * Query params:
 *   - page: page number (default 1)
 *   - per_page: results per page (default 50, max 100)
 *   - search: optional — filters by image ID prefix (client-side after fetch)
 *
 * Returns: { success, images: [{ id, variants, uploaded }], totalCount, page, perPage }
 *
 * Environment variables needed:
 *   CF_ACCOUNT_ID, CF_IMAGES_TOKEN
 */

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function onRequestGet(context) {
  try {
    const { CF_ACCOUNT_ID, CF_IMAGES_TOKEN } = context.env;

    if (!CF_ACCOUNT_ID || !CF_IMAGES_TOKEN) {
      return Response.json(
        { success: false, error: 'Missing Cloudflare credentials.' },
        { status: 500, headers: cors }
      );
    }

    const url = new URL(context.request.url);
    const page = parseInt(url.searchParams.get('page') || '1', 10);
    const perPage = Math.min(parseInt(url.searchParams.get('per_page') || '50', 10), 100);

    const apiUrl = `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/images/v1?page=${page}&per_page=${perPage}`;

    const response = await fetch(apiUrl, {
      headers: { 'Authorization': `Bearer ${CF_IMAGES_TOKEN}` },
    });

    const result = await response.json();

    if (!result.success) {
      return Response.json(
        { success: false, error: result.errors?.[0]?.message || 'Failed to list images' },
        { status: 400, headers: cors }
      );
    }

    const images = (result.result?.images || []).map(img => ({
      id: img.id,
      uploaded: img.uploaded,
      filename: img.filename || null,
      meta: img.meta || null,
    }));

    return Response.json(
      {
        success: true,
        images,
        totalCount: result.result_info?.total_count || images.length,
        page,
        perPage,
      },
      { headers: cors }
    );
  } catch (err) {
    return Response.json(
      { success: false, error: err.message },
      { status: 500, headers: cors }
    );
  }
}

export async function onRequestOptions() {
  return new Response(null, { headers: cors });
}
