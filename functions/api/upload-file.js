/**
 * POST /api/upload-file
 * Uploads a binary file (like a PDF) to R2.
 * Expects multipart/form-data with:
 *   - file: the file to upload
 *   - path: destination path (e.g., "public/financials/2024-990.pdf")
 *   - message: description (kept for compatibility)
 *
 * The admin panel handles document metadata (title, year, type) separately
 * via save-content → site_config.financials. This endpoint only stores the file.
 *
 * Env bindings: FILES (R2)
 */

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB
// Map incoming paths to R2 keys
function pathToR2Key(path) {
  // "public/financials/2024-990.pdf" → "financials/2024-990.pdf"
  if (path.startsWith('public/')) {
    return path.slice('public/'.length);
  }
  return path;
}

const ALLOWED_PREFIXES = ['public/financials/'];

function isPathAllowed(path) {
  if (!path || path.includes('..') || path.includes('//') || path.startsWith('/')) return false;
  return ALLOWED_PREFIXES.some(prefix => path.startsWith(prefix));
}

export async function onRequestPost(context) {
  try {
    const { FILES } = context.env;
    const formData = await context.request.formData();
    const file = formData.get('file');
    const path = formData.get('path');

    if (!file || !path) {
      return Response.json(
        { success: false, error: 'Missing file or path' },
        { status: 400 }
      );
    }

    if (!isPathAllowed(path)) {
      return Response.json(
        { success: false, error: 'Path not allowed' },
        { status: 403 }
      );
    }

    if (file.size > MAX_FILE_SIZE) {
      return Response.json(
        { success: false, error: `File too large. Maximum size is ${MAX_FILE_SIZE / 1024 / 1024} MB.` },
        { status: 413 }
      );
    }

    const r2Key = pathToR2Key(path);
    const origin = new URL(context.request.url).origin;
    const publicUrl = `${origin}/files/${r2Key}`;

    // Upload to R2 with cache headers for edge performance
    await FILES.put(r2Key, file.stream(), {
      httpMetadata: {
        contentType: file.type || 'application/octet-stream',
        cacheControl: 'public, max-age=31536000, immutable',
      },
    });

    return Response.json({
      success: true,
      path,
      sha: r2Key,
      downloadUrl: publicUrl,
    });
  } catch (err) {
    console.error("[upload-file]", err);
    return Response.json(
      { success: false, error: err.message || "An unexpected error occurred" },
      { status: 500 }
    );
  }
}
