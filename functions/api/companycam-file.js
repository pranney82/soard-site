/**
 * GET /api/companycam-file?v=<video>&p=<project>&e=<expiry>&s=<signature>
 * ===========================================================================
 * One CompanyCam video's original upload, streamed to JobTread before
 * CompanyCam closes (Nov 2026). JobTread takes a file by address only up to
 * 1024 characters and CompanyCam's signed address for an original is longer,
 * so the copier (./_companycam-jobs.js) hands JobTread this short link,
 * signed with a key worked out from COMPANYCAM_TOKEN and good for six hours.
 *
 * The bytes pass straight through (a stream, never held in memory), so a
 * phone's full-size video is fine. Anything that isn't a valid, unexpired
 * link to a video in that project is 404, and nothing is cached.
 * Public for GET in the middleware (JobTread can't sign in).
 */

import { companycamOn, checkFileLink, projectVideos, isOriginalUpload, videoFileUrl } from './_companycam.js';

const TYPES = { mov: 'video/quicktime', mp4: 'video/mp4', m4v: 'video/x-m4v' };
const notFound = () => new Response('Not found', { status: 404, headers: { 'Cache-Control': 'no-store' } });

export async function onRequestGet(context) {
  const { env, request } = context;
  const fetchImpl = context.fetchImpl || fetch;
  if (!companycamOn(env)) return notFound();
  const q = Object.fromEntries(new URL(request.url).searchParams);
  if (!(await checkFileLink(env, q))) return notFound();
  let video = null;
  try {
    video = (await projectVideos(env, q.p, { fetchImpl })).find((x) => String(x?.id) === q.v) || null;
  } catch {
    // 503, not 502: Cloudflare replaces 502 bodies with its own page
    return new Response('CompanyCam didn’t answer', { status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '60' } });
  }
  const src = video ? videoFileUrl(video) : null;
  if (!src || !isOriginalUpload(src)) return notFound();
  const res = await fetchImpl(src);
  if (!res.ok || !res.body) return new Response('CompanyCam’s file isn’t available', { status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '60' } });
  const ext = (String(src).split('?')[0].match(/\.(\w+)$/) || [, 'mp4'])[1].toLowerCase();
  const headers = new Headers({
    'Content-Type': res.headers.get('content-type')?.startsWith('video/') ? res.headers.get('content-type') : TYPES[ext] || 'application/octet-stream',
    'Content-Disposition': `attachment; filename="CompanyCam ${q.v}.${ext}"`,
    'Cache-Control': 'private, no-store',
  });
  if (res.headers.get('content-length')) headers.set('Content-Length', res.headers.get('content-length'));
  return new Response(res.body, { status: 200, headers });
}

export async function onRequestHead(context) {
  const res = await onRequestGet(context);
  res.body?.cancel?.().catch?.(() => null);
  return new Response(null, { status: res.status, headers: res.headers });
}
