/**
 * GET /api/download-logo?id=<image-id>
 *
 * Proxies a logo download from Cloudflare Images with
 * Content-Disposition: attachment so the browser triggers
 * a file save instead of navigating to the image.
 *
 * Only whitelisted image IDs are allowed to prevent abuse.
 */

const ALLOWED_IDS = new Set([
  'brand-logo-light-bg-tagline-download',
  'brand-logo-dark-bg-tagline-download',
  'brand-logo-circle-tagline-download',
  'brand-logo-light-bg-download',
  'brand-logo-dark-bg-download',
  'brand-logo-circle-download',
]);

const CF_IMAGES_HASH = 'ROYFuPmfN2vPS6mt5sCkZQ';

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const id = url.searchParams.get('id');

  if (!id || !ALLOWED_IDS.has(id)) {
    return new Response('Not found', { status: 404 });
  }

  // Serve at high resolution, keep as PNG
  const imageUrl = `https://imagedelivery.net/${CF_IMAGES_HASH}/${id}/w=2048`;

  const imageRes = await fetch(imageUrl);
  if (!imageRes.ok) {
    return new Response('Image not found', { status: 404 });
  }

  // Derive a clean filename from the ID: brand-logo-light-bg-tagline-download → logo-light-bg-tagline.png
  const filename = id.replace('brand-', '').replace('-download', '') + '.png';

  return new Response(imageRes.body, {
    headers: {
      'Content-Type': 'image/png',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'public, max-age=86400',
    },
  });
}
