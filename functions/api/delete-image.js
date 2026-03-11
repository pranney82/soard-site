/**
 * POST /api/delete-image
 * Deletes an image from Cloudflare Images.
 * Expects JSON body: { imageId: "..." }
 *
 * Environment variables needed:
 *   CF_ACCOUNT_ID, CF_IMAGES_TOKEN
 */

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
