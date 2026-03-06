/**
 * POST /api/delete-image
 * Deletes an image from Cloudflare Images.
 * Expects JSON body: { imageId: "..." }
 *
 * Environment variables needed:
 *   CF_ACCOUNT_ID, CF_IMAGES_TOKEN
 */

export async function onRequestPost(context) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };

  try {
    const { CF_ACCOUNT_ID, CF_IMAGES_TOKEN } = context.env;
    const { imageId } = await context.request.json();

    if (!imageId) {
      return Response.json(
        { success: false, error: 'No imageId provided' },
        { status: 400, headers: cors }
      );
    }

    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/images/v1/${imageId}`,
      {
        method: 'DELETE',
        headers: {
          'Authorization': `Bearer ${CF_IMAGES_TOKEN}`,
        },
      }
    );

    const result = await response.json();

    return Response.json(
      { success: result.success },
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
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
