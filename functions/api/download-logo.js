/**
 * GET /api/download-logo?id=<image-id>
 *
 * Proxies a logo download from Cloudflare Images with
 * Content-Disposition: attachment so the browser triggers
 * a file save instead of navigating to the image.
 *
 * Only SOARD's official logos are served: the six in src/data/brand.js,
 * the one list /branding/ and the board page draw from.
 */

import { LOGOS } from '../../src/data/brand.js';

const CF_IMAGES_HASH = 'ROYFuPmfN2vPS6mt5sCkZQ';

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const logo = LOGOS.find((l) => l.download === url.searchParams.get('id'));
  if (!logo) return new Response('Not found', { status: 404 });

  // Serve at high resolution, keep as PNG
  const imageRes = await fetch(`https://imagedelivery.net/${CF_IMAGES_HASH}/${logo.download}/w=2048`);
  if (!imageRes.ok) return new Response('Image not found', { status: 404 });

  // brand-logo-light-bg-tagline-download → logo-light-bg-tagline.png
  return new Response(imageRes.body, {
    headers: {
      'Content-Type': 'image/png',
      'Content-Disposition': `attachment; filename="${logo.file}.png"`,
      'Cache-Control': 'public, max-age=86400',
    },
  });
}
