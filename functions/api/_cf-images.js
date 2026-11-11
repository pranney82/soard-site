/**
 * Cloudflare Images: the one way the site uploads a picture
 * ==========================================================
 * Every upload (Admin's photo pickers, a kid's photos, press and link-preview
 * pictures, a board member's own photo, a reveal design from JobTread, a
 * renamed page's copies) goes through uploadImage(), so none goes up saying
 * where it was taken: a kid's before photos carry the family's home, and
 * Cloudflare hands a file's metadata to anyone who asks (./_photo-location.js).
 *
 *   uploadImage(env, { file | bytes, type?, filename?, id? }, fetchImpl?)
 *     → Cloudflare's answer as it comes ({ success, result, errors })
 *   publicUrl(result)  the /public address of an uploaded picture
 */

import { stripLocation } from './_photo-location.js';

export const CF_HASH = 'ROYFuPmfN2vPS6mt5sCkZQ';
export const imagesApi = (env) => `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/images/v1`;

/**
 * Upload a picture (a File or Blob, or bytes with their type and a file name),
 * with its location taken out, under `id` when given → Cloudflare's JSON answer
 */
export async function uploadImage(env, { file = null, bytes = null, type = '', filename = '', id = '' } = {}, fetchImpl = fetch) {
  const raw = bytes ?? await file.arrayBuffer();
  const clean = stripLocation(raw).bytes;
  const form = new FormData();
  form.append('file', new Blob([clean], { type: type || file?.type || 'application/octet-stream' }), filename || file?.name || 'photo');
  if (id) form.append('id', id);
  const res = await fetchImpl(imagesApi(env), { method: 'POST', headers: { Authorization: `Bearer ${env.CF_IMAGES_TOKEN}` }, body: form });
  return res.json().catch(() => ({ success: false, errors: [{ message: `Cloudflare Images answered ${res.status}` }] }));
}

/** An uploaded picture's /public address, from Cloudflare's `result` */
export function publicUrl(result) {
  const variants = result?.variants || [];
  return variants.find((v) => v.endsWith('/public')) || variants[0] || `https://imagedelivery.net/${CF_HASH}/${result?.id}/public`;
}
