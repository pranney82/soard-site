/**
 * /book-version.json — which upload of the anniversary book this build put
 * on the site, if any: { live, version, slug }. The admin reads it so a new
 * upload never clears away the pictures the live page still shows
 * (public/admin/book-editor.js clearOld).
 */
import { getBook } from '../utils/book';

export function GET() {
  const book = getBook();
  const body = book?.live ? { live: true, version: book.version, slug: book.slug } : { live: false };
  return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json; charset=utf-8' } });
}
