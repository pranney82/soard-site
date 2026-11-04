/**
 * /api/drive-admin — search SOARD's Google Drive (founders only, Access like every admin route; see _drive-search.js)
 * ===========================================================================
 * GET ?q=&images=1&account=      → { success, q, files, problems }   every account's Drive (or one), newest first
 * GET ?account=&file=            → the file, always as a download
 * Read-only: there is no POST.
 */
import { canRead, searchDrive, readDriveFile } from './_drive-search.js';

const headers = { 'Cache-Control': 'no-store' };
const reply = (body, status = 200) => Response.json(body, { status, headers });
// Opened from the admin's own address, so only types a browser shows safely keep theirs
const SHOWN = /^(application\/pdf|image\/(png|jpeg|gif|webp|heic|heif))$/i;

export async function onRequestGet(context) {
  const { env } = context;
  const me = context.data?.userEmail || '';
  try {
    if (!(await canRead(env, me))) return reply({ success: false, error: 'Searching SOARD’s Drive is open only to the founders on People → Team' }, 403);
    const p = new URL(context.request.url).searchParams;
    if (p.get('file')) {
      const f = await readDriveFile(env, { me, account: p.get('account') || '', id: p.get('file') });
      return new Response(f.bytes, {
        headers: {
          ...headers,
          'Content-Type': SHOWN.test(f.type) ? f.type : 'application/octet-stream',
          'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`,
          'X-Content-Type-Options': 'nosniff',
          'Content-Security-Policy': "sandbox; default-src 'none'",
        },
      });
    }
    return reply({ success: true, ...(await searchDrive(env, { me, q: p.get('q') || '', account: p.get('account') || '', images: p.get('images') === '1' })) });
  } catch (err) {
    if (!err.status) console.error('[drive-admin]', err);
    return reply({ success: false, error: err.message || 'Couldn’t search Drive' }, err.status && err.status < 500 ? err.status : 500);
  }
}
