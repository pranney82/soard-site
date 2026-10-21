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
 * What the admin uploads here (Site Config → Financials: tax returns, audits,
 * annual reports, a license scan) is PDFs and pictures, so those are all it
 * takes, recognized by their first bytes, not the name or the type the
 * browser claims. The stored type is the one found. Never a web page, an SVG
 * or a script: those would run on the site's own origin when opened.
 *
 * Env bindings: FILES (R2)
 */

const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50 MB

// Kind → its file name endings. The first bytes decide the kind (sniffType)
const ALLOWED_TYPES = {
  'application/pdf': ['pdf'],
  'image/jpeg': ['jpg', 'jpeg'],
  'image/png': ['png'],
  'image/webp': ['webp'],
  'image/gif': ['gif'],
  'image/avif': ['avif'],
  'image/heic': ['heic'],
  'image/heif': ['heif'],
};
const ALLOWED_ENDINGS = new Set(Object.values(ALLOWED_TYPES).flat());

const startsWith = (bytes, sig, at = 0) => sig.every((b, i) => bytes[at + i] === b);
const ascii = (s) => [...s].map((c) => c.charCodeAt(0));

/** The file's real type from its first bytes, or null when it isn't one we take */
export function sniffType(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  // A PDF reader finds the header anywhere in the first 1 KB
  const pdf = ascii('%PDF-');
  for (let i = 0; i + pdf.length <= Math.min(b.length, 1024); i++) if (startsWith(b, pdf, i)) return 'application/pdf';
  if (startsWith(b, [0xFF, 0xD8, 0xFF])) return 'image/jpeg';
  if (startsWith(b, [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])) return 'image/png';
  if (startsWith(b, ascii('GIF87a')) || startsWith(b, ascii('GIF89a'))) return 'image/gif';
  if (startsWith(b, ascii('RIFF')) && startsWith(b, ascii('WEBP'), 8)) return 'image/webp';
  if (startsWith(b, ascii('ftyp'), 4) && (startsWith(b, ascii('avif'), 8) || startsWith(b, ascii('avis'), 8))) return 'image/avif';
  if (startsWith(b, ascii('ftyp'), 4) && ['heic', 'heix', 'hevc', 'hevx'].some((brand) => startsWith(b, ascii(brand), 8))) return 'image/heic';
  if (startsWith(b, ascii('ftyp'), 4) && ['mif1', 'msf1', 'heim', 'heis'].some((brand) => startsWith(b, ascii(brand), 8))) return 'image/heif';
  return null;
}
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

    if (!file || typeof file === 'string' || typeof path !== 'string' || !path) {
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

    // A PDF or a picture, by its first bytes, under a name that says so
    const ending = (path.split('/').pop().match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
    const contentType = sniffType(new Uint8Array(await file.slice(0, 1024).arrayBuffer()));
    if (!contentType || !ALLOWED_ENDINGS.has(ending)) {
      return Response.json(
        { success: false, error: 'Only PDFs and pictures (JPG, PNG, WebP, GIF or AVIF) can be uploaded here.' },
        { status: 415 }
      );
    }

    const r2Key = pathToR2Key(path);
    const origin = new URL(context.request.url).origin;
    const publicUrl = `${origin}/files/${r2Key}`;

    // Upload to R2 with cache headers for edge performance
    await FILES.put(r2Key, file.stream(), {
      httpMetadata: {
        contentType,
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
