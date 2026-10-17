/**
 * event-preview.js — the event editor's Preview: the real event page with
 * unsaved edits in it. See page-preview.js for how the frame is patched.
 * Mirrors src/pages/events/[slug].astro; scripts/test-page-preview.mjs
 * checks every event against its real page.
 */
import { cfRaw, cfSrcset, cfLqip, checkBlobs, setLiveBlobs, loadTemplates, tools, guardFrame } from './page-preview.js';

const today = () => new Date().toISOString().split('T')[0];
const CAT_LABEL = { fundraiser: 'Fundraiser', volunteer: 'Volunteer', reveal: 'Room Reveal', community: 'Community', other: 'Event' };
const getYouTubeId = (url) => url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|v\/|shorts\/))([\w-]{11})/)?.[1] || null;
const fmtDate = (d) => new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
const fmtWeekday = (d) => new Date(d + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long' });

export const pagePath = (slug) => `/events/${slug}/`;

/** Does the build give this event a page? (getStaticPaths in [slug].astro) */
export function hasPage(ev) {
  if (ev.body || (ev.photos || []).length > 0 || ev.streamVideoId || ev.videoUrl) return true;
  return ev.status !== 'cancelled' && (ev.endDate || ev.date) < today();
}
export const noPageNote = 'This event won’t have a page of its own yet: an event gets one when it has a full description, photos or a video, or once its date has passed. Until then it’s listed on the Events page.';

let kitPromise = null;
export function loadKit() {
  kitPromise ??= loadTemplates('event', ['upcoming', 'past', 'pending']).then((templates) => ({ templates }));
  kitPromise.catch(() => { kitPromise = null; });
  return kitPromise;
}

export async function buildModel(ev, kit) {
  const blobs = await checkBlobs([ev.image, ...(ev.photos || []).map((p) => p.id)]);
  const notes = [...blobs.notes];
  if (ev.videoUrl && !ev.streamVideoId && !getYouTubeId(ev.videoUrl)) notes.push('The video link isn’t a YouTube link the page can play, so there’s no video section.');
  return { item: ev, notes, liveBlobs: blobs.alive, templates: kit.templates };
}

export function patchPage(doc, win, model) {
  guardFrame(doc, win);
  setLiveBlobs(model.liveBlobs);
  const main = doc.querySelector('main');
  if (!main) return;
  const ev = { category: 'other', photos: [], ...model.item };
  const { take, textSwap, drop, setParsedHtml } = tools(doc, model.templates);
  const photos = (ev.photos || []).map((p) => ({ alt: '', ...p }));
  const isPast = (ev.endDate || ev.date) < today();
  const heroDesc = isPast ? (ev.shortDescription || ev.description) : ev.description;
  const streamVideoId = ev.streamVideoId || null;
  const videoYtId = ev.videoUrl ? getYouTubeId(ev.videoUrl) : null;
  const hasVideo = Boolean(streamVideoId || videoYtId);
  const title = ev.title || 'New event';
  const heroSrcset = ev.image ? cfSrcset(ev.image, [600, 900, 1200], { fit: 'cover' }) : '';
  const setMetaText = (span, text) => {
    const nodes = [...span.childNodes].filter((n) => n.nodeType === 3 && n.nodeValue.trim());
    nodes.forEach((n, i) => { if (i) n.remove(); });
    if (nodes[0]) nodes[0].nodeValue = ` ${text} `;
  };

  // ── Hero ──
  const hero = take(isPast ? 'past' : 'upcoming', 'section.ev-hero');
  hero.querySelector('.ev-hero__eyebrow').textContent = `${CAT_LABEL[ev.category] || 'Event'}${isPast ? ` · ${ev.date.slice(0, 4)}` : ''}`;
  hero.querySelector('.ev-hero__title').textContent = title;
  const [dateItem, timeItem, placeItem] = hero.querySelectorAll('.ev-hero__meta-item');
  const time = dateItem.querySelector('time');
  time.setAttribute('datetime', ev.date);
  time.textContent = `${fmtWeekday(ev.date)}, ${fmtDate(ev.date)}`;
  if (ev.time) setMetaText(timeItem, ev.time); else drop(timeItem);
  setMetaText(placeItem, ev.location || '');
  hero.querySelector('.ev-hero__desc').textContent = heroDesc || '';
  const actions = hero.querySelector('.ev-hero__actions');
  if (!isPast) {
    if (ev.ticketUrl) {
      const a = actions.querySelector('a');
      a.href = ev.ticketUrl;
      textSwap(a, 'Get Tickets — $100', ev.ticketPrice ? `Get Tickets — ${ev.ticketPrice}` : 'Get Tickets');
    } else drop(actions);
  } else if (photos.length > 0 || hasVideo) {
    const [photosLink, videoLink] = actions.querySelectorAll('a');
    if (!photos.length) drop(photosLink);
    if (hasVideo) videoLink.className = photos.length > 0 ? 'ev-btn ev-btn--outline' : 'ev-btn ev-btn--gold';
    else drop(videoLink);
  } else {
    drop(actions);
  }
  const visual = hero.querySelector('.ev-hero__visual');
  if (ev.image) {
    visual.setAttribute('style', `background-image:url('${cfLqip(ev.image)}')`);
    const img = visual.querySelector('img');
    img.src = cfRaw(ev.image, 'w=900,fit=cover,q=85');
    img.setAttribute('srcset', heroSrcset);
    img.alt = title;
  } else drop(visual);

  // ── Body ──
  let body = null;
  if (ev.body) {
    body = take('upcoming', 'section.ev-body');
    setParsedHtml(body.querySelector('.ev-body__content'), ev.body);
  }

  // ── Video ──
  let video = null;
  if (streamVideoId) {
    video = take('upcoming', 'section.ev-video');
    const b = video.querySelector('.ev-video__facade');
    b.dataset.streamId = streamVideoId;
    b.setAttribute('aria-label', `Play ${title} video`);
    const img = b.querySelector('img');
    img.src = `https://videodelivery.net/${streamVideoId}/thumbnails/thumbnail.jpg?time=2s&width=1600&height=900&fit=crop`;
    img.alt = `Video preview for ${title}`;
  } else if (videoYtId) {
    video = take('past', 'section.ev-video');
    const b = video.querySelector('.ev-video__facade');
    b.dataset.ytId = videoYtId;
    b.setAttribute('aria-label', `Play ${title} video`);
    b.querySelector('source').setAttribute('srcset', `https://i.ytimg.com/vi_webp/${videoYtId}/maxresdefault.webp`);
    const img = b.querySelector('img');
    img.src = `https://i.ytimg.com/vi/${videoYtId}/maxresdefault.jpg`;
    img.alt = `Video preview for ${title}`;
  }

  // ── Photos ──
  let gallery = null;
  if (photos.length > 0) {
    gallery = take('upcoming', 'section.ev-gallery');
    const grid = gallery.querySelector('.ev-gallery__grid');
    const proto = grid.querySelector('.ev-gallery__item');
    grid.replaceChildren(...photos.map((photo, i) => {
      const item = proto.cloneNode(true);
      item.dataset.delay = String(Math.min(i, 3));
      item.setAttribute('style', `background-image:url('${cfLqip(photo.id)}')`);
      const img = item.querySelector('img');
      img.src = cfRaw(photo.id, 'w=600,fit=cover,q=80');
      img.setAttribute('srcset', cfSrcset(photo.id, [400, 600, 900], { fit: 'cover' }));
      img.alt = photo.alt || title;
      return item;
    }));
  }

  const pending = isPast && photos.length === 0 && !hasVideo ? take('pending', 'section.ev-pending') : null;
  const cta = take('upcoming', 'section.ev-cta');
  main.replaceChildren(...[hero, body, video, gallery, pending, cta].filter(Boolean));

  doc.querySelectorAll('link[rel="preload"][as="image"][imagesrcset]').forEach((l) => {
    if (ev.image && heroSrcset) l.setAttribute('imagesrcset', heroSrcset); else l.remove();
  });
}
