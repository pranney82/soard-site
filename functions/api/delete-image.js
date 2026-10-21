/**
 * POST /api/delete-image
 * Deletes an image from Cloudflare Images.
 * Expects JSON body: { imageId: "..." }
 *
 * Environment variables needed:
 *   CF_ACCOUNT_ID, CF_IMAGES_TOKEN
 */

/**
 * An image id as /api/upload-image accepts one ("kids/amari/photo-1", or a
 * Cloudflare-made UUID): letters, numbers and / _ . - only, no "..", at most
 * 256 characters. Anything else could reach another Cloudflare API path.
 */
export function validImageId(id) {
  return typeof id === 'string'
    && id.length <= 256
    && !id.includes('..')
    && /^[A-Za-z0-9][A-Za-z0-9/_.-]*$/.test(id)
    && id.split('/').every((seg) => seg && seg !== '.');
}

/** The id as a URL path: each segment encoded, the slashes between them kept */
export function imagePath(id) {
  return id.split('/').map(encodeURIComponent).join('/');
}

export async function onRequestPost(context) {
  try {
    const { CF_ACCOUNT_ID, CF_IMAGES_TOKEN } = context.env;
    const { imageId } = await context.request.json();

    if (!imageId) {
      return Response.json(
        { success: false, error: 'No imageId provided' },
        { status: 400 }
      );
    }
    if (!validImageId(imageId)) {
      return Response.json(
        { success: false, error: 'Invalid image id. Use letters, numbers, and / _ . - only (max 256 chars).' },
        { status: 400 }
      );
    }

    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(CF_ACCOUNT_ID)}/images/v1/${imagePath(imageId)}`,
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
      {}
    );
  } catch (err) {
    console.error("[delete-image]", err);
    return Response.json(
      { success: false, error: "An unexpected error occurred" },
      { status: 500 }
    );
  }
}
