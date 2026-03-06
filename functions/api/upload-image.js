/**
 * POST /api/upload-image
 * Uploads an image to Cloudflare Images.
 * Expects multipart/form-data with:
 *   - file: the image file
 *   - id: (optional) custom image ID like "kids/amari/photo-1"
 *
 * Returns: { success, imageUrl, imageId }
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

    if (!CF_ACCOUNT_ID || !CF_IMAGES_TOKEN) {
      return Response.json(
        { success: false, error: 'Missing Cloudflare credentials. Set CF_ACCOUNT_ID and CF_IMAGES_TOKEN in Pages settings.' },
        { status: 500, headers: cors }
      );
    }

    const formData = await context.request.formData();
    const file = formData.get('file');
    const customId = formData.get('id');

    if (!file) {
      return Response.json(
        { success: false, error: 'No file provided' },
        { status: 400, headers: cors }
      );
    }

    // Build the upload form for Cloudflare Images API
    const uploadForm = new FormData();
    uploadForm.append('file', file);
    if (customId) {
      uploadForm.append('id', customId);
    }

    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/images/v1`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${CF_IMAGES_TOKEN}`,
        },
        body: uploadForm,
      }
    );

    const result = await response.json();

    if (!result.success) {
      return Response.json(
        { success: false, error: result.errors?.[0]?.message || 'Upload failed' },
        { status: 400, headers: cors }
      );
    }

    // Return the delivery URL
    const imageId = result.result.id;
    const variants = result.result.variants || [];
    const publicUrl = variants.find(v => v.endsWith('/public')) || variants[0] || '';

    return Response.json(
      {
        success: true,
        imageId,
        imageUrl: publicUrl,
        variants,
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
  return new Response(null, {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
