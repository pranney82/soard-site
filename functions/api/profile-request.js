/**
 * The public side of a profile request (/profile-update/#t=<token>).
 *
 * GET  /api/profile-request?token=…  → { person: { first, name, title, group, bio, quote, linkedin, photo, sent, sentPhoto } }
 *                                       (after a send, the fields show what was sent)
 *                                       or 404 (unknown) / 410 (expired or already used)
 * POST /api/profile-request          multipart: token, bio, quote, linkedin, photo (optional file)
 *                                       → { ok: true }
 *
 * Public: listed in the middleware's PUBLIC_ROUTES and rate limited per IP.
 * The token is the only key (see _profile-requests.js). What's sent is stored
 * as a suggestion in the admin; nothing reaches the site until someone uses it.
 * Env: DB, CF_ACCOUNT_ID + CF_IMAGES_TOKEN (for the photo).
 */
import { findRequest, saveSubmission, LIMITS, normalizeLinkedIn, cleanText } from './_profile-requests.js';
import { personName } from './_team.js';
import { checkImage } from './_image-types.js';

const CF_HASH = 'ROYFuPmfN2vPS6mt5sCkZQ';
const GONE = { expired: 'This link has expired. Ask SOARD for a new one.', closed: 'This link has already been used or replaced. Ask SOARD for a new one if you need to send changes.' };

async function loadPerson(DB, slug) {
  const row = await DB.prepare('SELECT data FROM team WHERE slug = ?').bind(slug).first();
  if (!row) return null;
  try { return JSON.parse(row.data); } catch { return null; }
}

function imageId(photo) {
  const m = String(photo || '').match(/imagedelivery\.net\/[^/]+\/(.+?)(?:\/(?:public|[^/]*=[^/]*))?$/);
  return m ? m[1] : '';
}

export async function onRequestGet(context) {
  const { DB } = context.env;
  const token = new URL(context.request.url).searchParams.get('token');
  const { row, problem } = await findRequest(DB, token);
  if (problem === 'unknown') return Response.json({ ok: false, error: 'This link isn’t right. Check that you copied all of it.' }, { status: 404 });
  if (problem) return Response.json({ ok: false, error: GONE[problem] }, { status: 410 });
  const d = await loadPerson(DB, row.slug);
  if (!d) return Response.json({ ok: false, error: GONE.closed }, { status: 410 });
  const name = personName(d);
  // Opened again after sending: they pick up from what they sent
  let sent = null;
  try { sent = row.submission ? JSON.parse(row.submission) : null; } catch {}
  const id = imageId(sent?.photo || d.photo);
  return Response.json({
    ok: true,
    person: {
      first: name.split(/\s+/)[0], name, title: d.title || '', group: d.group === 'board' || d.group === 'advisory' ? d.group : 'team',
      bio: sent?.bio || d.bio || '', quote: sent?.quote || d.quote || '', linkedin: sent?.linkedin || d.linkedin || '',
      photo: id ? `https://imagedelivery.net/${CF_HASH}/${id}/w=320,h=320,fit=cover,gravity=face` : '',
      sent: !!row.submitted_at, sentPhoto: !!sent?.photo,
    },
  }, { headers: { 'Cache-Control': 'no-store' } });
}

async function deletePhoto(env, photo) {
  const id = imageId(photo);
  if (!id || !/\/submitted-\d+$/.test(id)) return;
  await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/images/v1/${id}`, {
    method: 'DELETE', headers: { Authorization: `Bearer ${env.CF_IMAGES_TOKEN}` },
  }).catch(() => {});
}

async function uploadPhoto(env, file, slug) {
  const form = new FormData();
  form.append('file', file);
  form.append('id', `team/${slug}/submitted-${Date.now()}`);
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/images/v1`, {
    method: 'POST', headers: { Authorization: `Bearer ${env.CF_IMAGES_TOKEN}` }, body: form,
  });
  const body = await res.json().catch(() => ({}));
  if (!body?.success) throw new Error(body?.errors?.[0]?.message || 'upload failed');
  const variants = body.result?.variants || [];
  return variants.find((v) => v.endsWith('/public')) || `https://imagedelivery.net/${CF_HASH}/${body.result.id}/public`;
}

export async function onRequestPost(context) {
  try {
    const { DB } = context.env;
    let form;
    try { form = await context.request.formData(); } catch { return Response.json({ ok: false, error: 'Send the form again' }, { status: 400 }); }
    if (form.get('website')) return Response.json({ ok: true }); // a bot filled the hidden field
    const { row, problem } = await findRequest(DB, form.get('token'));
    if (problem === 'unknown') return Response.json({ ok: false, error: 'This link isn’t right. Check that you copied all of it.' }, { status: 404 });
    if (problem) return Response.json({ ok: false, error: GONE[problem] }, { status: 410 });
    if (row.submissions >= LIMITS.submissions) return Response.json({ ok: false, error: 'This link has been used too many times. Ask SOARD for a new one.' }, { status: 429 });

    const bio = cleanText(form.get('bio'), LIMITS.bio);
    const quote = cleanText(form.get('quote'), LIMITS.quote);
    const linkedin = normalizeLinkedIn(String(form.get('linkedin') || '').slice(0, LIMITS.linkedin));
    if (linkedin === null) return Response.json({ ok: false, error: 'That LinkedIn link doesn’t look right. It should look like linkedin.com/in/your-name.' }, { status: 400 });
    const file = form.get('photo');
    const hasPhoto = file && typeof file === 'object' && file.size > 0;
    if (!bio && !quote && !linkedin && !hasPhoto) return Response.json({ ok: false, error: 'Add at least one thing to send.' }, { status: 400 });

    let photo = '';
    if (hasPhoto) {
      if (file.size > LIMITS.photoBytes) return Response.json({ ok: false, error: 'That photo is over 10 MB. Try a smaller copy.' }, { status: 413 });
      // JPG, PNG, WebP, HEIC or GIF by its own bytes as well as its label: never SVG or anything else
      const head = new Uint8Array(await file.slice(0, 64).arrayBuffer());
      if (!checkImage(head, file.type).ok) return Response.json({ ok: false, error: 'The photo should be a JPG, PNG, WebP or HEIC image.' }, { status: 400 });
      if (!context.env.CF_ACCOUNT_ID || !context.env.CF_IMAGES_TOKEN) return Response.json({ ok: false, error: 'Photos can’t be received right now. Send the rest, and email the photo to SOARD.' }, { status: 503 });
      try { photo = await uploadPhoto(context.env, file, row.slug); }
      catch { return Response.json({ ok: false, error: 'The photo didn’t upload. Try again, or send the rest without it.' }, { status: 500 }); }
    }

    // Sending again replaces what was sent before, except a photo: the form can't
    // show the earlier one, so it stays unless a new one comes with this send
    let prev = null;
    try { prev = row.submission ? JSON.parse(row.submission) : null; } catch {}
    if (!photo && prev?.photo) photo = prev.photo;
    else if (photo && prev?.photo && prev.photo !== photo) context.waitUntil(deletePhoto(context.env, prev.photo));

    await saveSubmission(DB, row.id, { bio, quote, linkedin, photo });
    return Response.json({ ok: true });
  } catch (err) {
    console.error('[profile-request]', err);
    return Response.json({ ok: false, error: 'Something went wrong. Please try again in a minute.' }, { status: 500 });
  }
}
