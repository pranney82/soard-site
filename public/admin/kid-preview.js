/**
 * kid-preview.js — the kid editor's Preview: the real public page, with
 * unsaved edits in it.
 *
 * The admin frames the kid's live page at /kids/<slug>/?admin-preview=<id>
 * (or another kid's page when this one isn't on the site yet). BaseLayout
 * calls parent.__soardPreview(document, window) as soon as <main> is parsed,
 * before any page script runs, and patchKidPage() replaces every section of
 * the kid's <article> with one cloned from the kid page template
 * (/admin/kid-template/<variant>/, the real template rendered with every
 * optional part switched on) and filled from the draft. The page's scripts
 * then start on the finished page, so the hero choreography, chapter nav,
 * sliders and lightbox behave exactly as they will live.
 *
 * The derivations here mirror src/pages/kids/[slug].astro, cf-image.ts and
 * reveals.ts. scripts/test-page-preview.mjs rebuilds every kid's page from
 * another kid's and checks it against the real one; run it after changing
 * any of those files.
 */

import {
  cfId, cfUrl, cfRaw, cfSrcset, isLocal, isBlob, setLiveBlobs, measure, checkBlobs,
  loadTemplates, tools, guardFrame,
} from './page-preview.js';

import { youTubeId, splitBio, heroHookOf, TITLE_BLOCK, isFloorPlan } from './kids-shared.js';

export { cfId, youTubeId };

// ── Video (mirrors src/utils/reveals.ts) ──────────────────────────────
const STREAM_UID_RE = /^[a-f0-9]{32}$/i;

const streamChecks = new Map();
/**
 * Same check the build makes: does Stream serve this video's manifest?
 * Asked through /api/stream-check because Stream's CORS blocks the browser.
 * A failed check is retried next time instead of being remembered.
 */
function checkStream(uid) {
  if (!streamChecks.has(uid)) {
    const check = (async () => {
      if (!STREAM_UID_RE.test(uid)) return 'gone';
      try {
        const res = await fetch(`/api/stream-check?uid=${encodeURIComponent(uid)}`, { signal: AbortSignal.timeout(10000) });
        const data = await res.json();
        return ['playable', 'gone'].includes(data.state) ? data.state : 'unknown';
      } catch {
        return 'unknown';
      }
    })();
    streamChecks.set(uid, check);
    check.then((s) => { if (s === 'unknown') streamChecks.delete(uid); });
  }
  return streamChecks.get(uid);
}

/** The video the built page will play: { type, id, note } or null */
async function resolveVideo(kid) {
  const streamId = kid.streamVideoId?.trim().toLowerCase() || null;
  const ytId = youTubeId(kid.videoUrl);
  if (streamId) {
    const state = await checkStream(streamId);
    if (state === 'playable' || (state === 'unknown' && !ytId)) {
      return { type: 'stream', id: streamId, note: state === 'unknown' ? 'Couldn’t reach Stream to check the video, so this shows it the way the site will if Stream is reachable when it publishes.' : null };
    }
    const why = 'Stream can’t play the uploaded video yet (it may still be processing)';
    if (ytId) return { type: 'youtube', id: ytId, note: `${why}, so the page shows the YouTube video instead.` };
    return { type: null, note: `${why}, so the page won’t show a video. Publish after it finishes processing.` };
  }
  if (ytId) return { type: 'youtube', id: ytId, note: null };
  if (kid.videoUrl) return { type: null, note: 'The video link isn’t a YouTube link the page can play, so there’s no video section.' };
  return null;
}

// ── Kit: templates + build manifests (fetched once per session) ───────
let kitPromise = null;
export function loadKit() {
  kitPromise ??= Promise.all([
    loadTemplates('kid', ['full', 'alt', 'nophoto']),
    fetch('/admin/kid-manifests.json', { credentials: 'same-origin' }).then((r) => (r.ok ? r.json() : { dims: {}, lqip: {} })),
  ]).then(([templates, manifests]) => ({ templates, dims: manifests.dims || {}, lqip: manifests.lqip || {} }));
  kitPromise.catch(() => { kitPromise = null; });
  return kitPromise;
}

// ── Page model (mirrors the frontmatter of src/pages/kids/[slug].astro) ──
// (the bio split, hero hook and plan crop rules live in kids-shared.js)

/** Every image whose size the page needs (hero, gallery, plans, before/after) */
function sizedImages(kid) {
  const ids = [kid.heroImage, ...(kid.photos || []).slice(0, 30).map((p) => p.url), ...(kid.plans || []).map((p) => p.url),
    ...(kid.beforeAfterPhotos || []).flatMap((p) => [p.before, p.after])];
  return [...new Set(ids.filter((s) => s && !isBlob(s) && !/^data:/.test(s)).map(cfId))];
}

/**
 * Everything the page shows, worked out from the draft. Async because new
 * photos are measured and a Stream video is checked, like the build does.
 */
export async function buildModel(kid, kit, { measure: measureNew = true, video: forcedVideo } = {}) {
  const dims = { ...kit.dims };
  // (measureNew: false matches a dev server, whose pages use [4, 3] for photos the manifest lacks)
  await Promise.all(sizedImages(kid).filter((id) => measureNew && !dims[id]).map(async (id) => {
    const d = await measure(id);
    if (d) dims[id] = d;
  }));
  // (forcedVideo: the template pages' fixed player, for the accuracy test)
  const video = forcedVideo ? { ...forcedVideo, note: null } : await resolveVideo(kid);
  const blobs = await checkBlobs([kid.heroImage, kid.accentImage, ...(kid.photos || []).map((p) => p.url), ...(kid.plans || []).map((p) => p.url),
    ...(kid.beforeAfterPhotos || []).flatMap((p) => [p.before, p.after]), ...(kid.partnerLogos || []).map((p) => p.url)]);
  const notes = [video?.note, ...blobs.notes].filter(Boolean);
  const alive = blobs.alive;
  return { kid, dims, lqip: kit.lqip, video, notes, liveBlobs: alive, templates: kit.templates };
}

// ── Patch ─────────────────────────────────────────────────────────────
/**
 * Rebuild the kid article in `doc` (the framed page, still parsing) from
 * the model. Runs synchronously from BaseLayout's hook.
 */
export function patchKidPage(doc, win, model) {
  guardFrame(doc, win);
  setLiveBlobs(model.liveBlobs);
  const article = doc.querySelector('article.kid-profile');
  if (!article) return;
  const { kid, templates: T } = model;
  const dimsOf = (src) => model.dims[cfId(src)] || [4, 3];
  const lqip = (src) => (isLocal(src) ? 'none' : model.lqip[cfId(src)] || cfRaw(src, 'w=30,q=30,blur=20'));
  const lqipVar = (src) => (isLocal(src) ? 'none' : `url('${lqip(src)}')`);
  const { take, textSwap, drop, setParsedHtml } = tools(doc, T);

  const name = kid.name || 'New kid';
  const photos = kid.photos || [];
  const bioParas = splitBio(kid.bio || '');
  const introPara = bioParas[0] || '';
  const pullQuote = kid.quote && kid.quote !== kid.bio && kid.quote !== introPara ? kid.quote : null;
  const galleryPhotos = photos.slice(0, 30);
  const plans = kid.plans || [];
  const pairs = kid.beforeAfterPhotos || [];
  const partnerLogos = kid.partnerLogos || [];
  const accentPhoto = kid.accentImage || null;
  const heroDims = kid.heroImage ? dimsOf(kid.heroImage) : [3, 4];
  const isHeroLandscape = heroDims[0] > heroDims[1];
  const rawHook = kid.heroSummary || (introPara ? introPara.replace(/<[^>]+>/g, '') : '');
  const heroHook = heroHookOf(rawHook);
  const hasVideo = !!model.video?.type;

  const planRatio = (p) => {
    const known = model.dims[cfId(p.url)];
    const r = known ? known[1] / known[0] : 768 / 1187;
    return r * (1 - TITLE_BLOCK);
  };
  const planUrl = (p, w, q = 85) => (isFloorPlan(p)
    ? cfUrl(p.url, { w, h: Math.round(w * planRatio(p)), fit: 'cover', gravity: 'top', q })
    : cfRaw(p.url, `w=${w},q=${q}`));
  const planSrcset = (p, widths) => (isFloorPlan(p)
    ? cfSrcset(p.url, widths, { fit: 'cover', gravity: 'top', aspectRatio: planRatio(p) })
    : cfSrcset(p.url, widths));
  const planDims = (p) => (isFloorPlan(p) ? [1000, Math.round(1000 * planRatio(p))] : dimsOf(p.url));

  // ── Hero ──
  const hero = take('full', 'section.hero');
  hero.dataset.kidSlug = kid.slug || '';
  hero.dataset.kidStatus = kid.status || '';
  const portrait = hero.querySelector('.hero__portrait');
  if (kid.heroImage) {
    portrait.setAttribute('style', `--lqip: ${lqipVar(kid.heroImage)}; --hero-ar: ${heroDims[0]} / ${heroDims[1]}`);
    portrait.querySelector('source').setAttribute('srcset', cfSrcset(kid.heroImage, [600, 900, 1200], { fit: 'cover', gravity: 'face' }));
    const img = portrait.querySelector('img.hero__img');
    img.src = cfRaw(kid.heroImage, 'w=1200,fit=cover,gravity=face,q=85');
    img.setAttribute('srcset', cfSrcset(kid.heroImage, [600, 900, 1200, 1600, 2400], { fit: 'cover', gravity: 'face' }));
    img.alt = `Photo of ${name}${kid.diagnosis ? ` — ${kid.diagnosis}` : ''}`;
    const building = portrait.querySelector('.hero__badge--building');
    if (kid.status === 'needs-funding') building.replaceWith(take('alt', '.hero__badge--funding'));
    else if (kid.status !== 'in-progress') drop(building);
  } else {
    const empty = take('nophoto', '.hero__portrait--empty');
    empty.querySelector('.hero__placeholder-text').textContent = name;
    portrait.replaceWith(empty);
    // Without the photo's view transition, the name's transition is numbered first
    const scope = T.nophoto.querySelector('.hero__name')?.getAttribute('data-astro-transition-scope');
    if (scope) hero.querySelector('.hero__name').setAttribute('data-astro-transition-scope', scope);
  }
  const accent = hero.querySelector('.hero__accent');
  if (accentPhoto && kid.heroImage) {
    accent.classList.toggle('hero__accent--landscape', isHeroLandscape);
    const [mobile, desktop] = accent.querySelectorAll('source');
    mobile.setAttribute('srcset', cfSrcset(accentPhoto, [180, 280, 400], { fit: 'cover', gravity: 'face', aspectRatio: 1.15 }));
    desktop.setAttribute('srcset', cfSrcset(accentPhoto, [280, 400, 560], { fit: 'cover', gravity: 'face', aspectRatio: 1.15 }));
    const img = accent.querySelector('img');
    img.src = cfRaw(accentPhoto, 'w=400,h=460,fit=cover,gravity=face,q=80');
    img.alt = `${name}'s transformed room`;
    img.setAttribute('style', `--lqip: ${lqipVar(accentPhoto)}`);
  } else {
    drop(accent);
  }
  hero.querySelector('.hero__name').textContent = name;
  const hook = hero.querySelector('.hero__hook');
  if (heroHook) hook.textContent = heroHook; else drop(hook);
  const [roomsEl, yearEl] = hero.querySelectorAll('.hero__meta-item');
  if (kid.roomTypes?.length) roomsEl.textContent = kid.roomTypes.join(', '); else drop(roomsEl);
  if (kid.year) yearEl.textContent = String(kid.year); else drop(yearEl);
  const actions = hero.querySelector('.hero__actions');
  if (kid.fundraisingUrl || kid.revealVideoUrl) {
    const cta = actions.querySelector('.hero__cta');
    if (kid.fundraisingUrl) { cta.href = kid.fundraisingUrl; textSwap(cta, 'Template', name); } else drop(cta);
    const reveal = actions.querySelector('.hero__reveal-link');
    if (kid.revealVideoUrl) {
      reveal.href = kid.revealVideoUrl;
      reveal.dataset.revealUid = kid.revealVideoUrl.split('/').filter(Boolean).pop();
    } else drop(reveal);
  } else {
    drop(actions);
  }

  // ── Reveal video modal ──
  let modal = null;
  if (kid.revealVideoUrl) {
    modal = take('full', '#reveal-modal');
    modal.querySelector('[role="dialog"]').setAttribute('aria-label', `${name}'s reveal video`);
  }

  // ── Chapter nav ──
  const chapters = {
    'chapter-meet': true,
    'chapter-story': bioParas.length > 0,
    'chapter-design': plans.length > 0,
    'chapter-transform': pairs.length > 0,
    'chapter-reveal': hasVideo,
    'chapter-gallery': galleryPhotos.length > 1,
    'chapter-partners': partnerLogos.length > 0,
  };
  let nav = null;
  if (Object.values(chapters).filter(Boolean).length > 1) {
    nav = take('full', '#chapter-nav');
    nav.querySelectorAll('.chapter-nav__link').forEach((a) => {
      if (!chapters[a.dataset.target]) a.remove();
      else if (a.dataset.target === 'chapter-meet') a.textContent = name;
    });
  }

  // ── Story ──
  let story = null;
  if (bioParas.length) {
    story = take('full', 'section.story');
    setParsedHtml(story.querySelector('.story__lead'), bioParas[0]);
    const more = story.querySelector('#story-more');
    if (bioParas.length > 1) {
      const paraProto = more.querySelector('.story__para');
      const quoteProto = more.querySelector('.story__quote');
      more.replaceChildren();
      bioParas.slice(1).forEach((para, i) => {
        const p = paraProto.cloneNode(true);
        more.append(p);
        setParsedHtml(p, para);
        if (pullQuote && i === Math.floor((bioParas.length - 2) / 2)) {
          const q = quoteProto.cloneNode(true);
          q.querySelector('.story__quote-text').textContent = pullQuote;
          more.append(q);
        }
      });
    } else {
      drop(story.querySelector('#story-expand'));
      drop(more);
    }
  }

  // ── Design ──
  let design = null;
  if (plans.length) {
    design = take('full', 'section.design');
    const grid = design.querySelector('.design__grid');
    const itemProto = grid.querySelector('.design__item');
    grid.replaceChildren(...plans.slice(0, 2).map((plan, i) => {
      const b = itemProto.cloneNode(true);
      b.dataset.lbIndex = String(galleryPhotos.length + i);
      b.setAttribute('aria-label', `View ${plan.label || 'design plan'}`);
      b.setAttribute('style', `--lqip: ${lqipVar(plan.url)}`);
      const img = b.querySelector('img');
      img.src = planUrl(plan, 800);
      img.setAttribute('srcset', planSrcset(plan, [400, 600, 800, 1200]));
      img.alt = plan.label || 'Design plan';
      const [w, h] = planDims(plan);
      img.setAttribute('width', w); img.setAttribute('height', h);
      return b;
    }));
    const moreBtn = design.querySelector('#design-view-all');
    if (plans.length > 2) {
      moreBtn.dataset.firstPlanIndex = String(galleryPhotos.length);
      textSwap(moreBtn, 'View all 3 designs', `View all ${plans.length} designs`);
    } else drop(moreBtn);
    const hidden = design.querySelector('div[hidden]');
    const lbProto = hidden.querySelector('.masonry__item');
    hidden.replaceChildren(...plans.map((plan, i) => {
      const b = lbProto.cloneNode(true);
      b.dataset.index = String(galleryPhotos.length + i);
      b.dataset.src = planUrl(plan, 1600);
      b.dataset.srcset = planSrcset(plan, [800, 1200, 1600, 2400]);
      b.dataset.alt = plan.label || `Plan ${i + 1}`;
      b.dataset.caption = plan.label || '';
      b.setAttribute('style', `--lqip: ${lqipVar(plan.url)}`);
      return b;
    }));
  }

  // ── Before & after ──
  let transform = null;
  if (pairs.length) {
    transform = take('full', 'section.ba-section');
    const list = transform.querySelector('.ba-section__sliders');
    const proto = list.querySelector('.ba-slider');
    list.replaceChildren(...pairs.map((pair) => {
      const s = proto.cloneNode(true);
      const room = s.querySelector('.ba-slider__room');
      if (pair.room) room.textContent = pair.room; else drop(room);
      const fill = (img, src, alt) => {
        img.src = cfUrl(src, { w: 1200, q: 85 });
        img.setAttribute('srcset', cfSrcset(src, [600, 900, 1200, 1600, 2400]));
        img.alt = alt;
        img.setAttribute('style', `--lqip: ${lqipVar(src)}`);
      };
      fill(s.querySelector('.ba-slider__after'), pair.after, pair.afterAlt || `${name}'s room after`);
      fill(s.querySelector('.ba-slider__before'), pair.before, pair.beforeAlt || `${name}'s room before`);
      s.querySelector('.ba-slider__range').setAttribute('aria-label', `Compare before and after${pair.room ? ` for ${pair.room}` : ''}`);
      return s;
    }));
  }

  // ── Reveal video ──
  let reveal = null;
  if (model.video?.type === 'stream') {
    reveal = take('full', 'section.reveal');
    const f = reveal.querySelector('#stream-facade');
    f.dataset.id = model.video.id;
    f.setAttribute('aria-label', `Play ${name}'s video`);
    const img = f.querySelector('img');
    img.src = `https://videodelivery.net/${model.video.id}/thumbnails/thumbnail.jpg?time=2s&width=1920&height=1080&fit=crop`;
    img.alt = `Video thumbnail for ${name}'s story`;
  } else if (model.video?.type === 'youtube') {
    reveal = take('alt', 'section.reveal');
    const f = reveal.querySelector('#yt-facade');
    f.dataset.id = model.video.id;
    f.setAttribute('aria-label', `Play ${name}'s video`);
    f.querySelector('source').setAttribute('srcset', `https://i.ytimg.com/vi_webp/${model.video.id}/maxresdefault.webp`);
    const img = f.querySelector('img');
    img.src = `https://i.ytimg.com/vi/${model.video.id}/maxresdefault.jpg`;
    img.alt = `Video thumbnail for ${name}'s story`;
  }

  // ── Gallery ──
  let gallery = null;
  if (galleryPhotos.length > 1) {
    gallery = take('full', 'section.gallery');
    const n = galleryPhotos.length;
    const credit = gallery.querySelector('.gallery__credit');
    if (kid.photographer) credit.textContent = `Photos by ${kid.photographer}`; else drop(credit);
    const grid = gallery.querySelector('#gallery');
    const heroProto = grid.querySelector('.gallery__cell--hero');
    const supportProto = grid.querySelector('.gallery__cell:not(.gallery__cell--hero)');
    const overflow = gallery.querySelector('#gallery-overflow');
    const overflowProto = overflow.querySelector('.gallery__cell');
    const cell = (proto, photo, i, img) => {
      const b = proto.cloneNode(true);
      const altText = photo.alt || `${name}'s room transformation photo ${i + 1}`;
      b.dataset.index = String(i);
      b.dataset.src = cfRaw(photo.url, 'w=1600,q=85');
      b.dataset.srcset = cfSrcset(photo.url, [800, 1200, 1600, 2400]);
      b.dataset.alt = altText;
      b.setAttribute('aria-label', `View photo ${i + 1} of ${n}`);
      b.setAttribute('style', `--lqip: ${lqipVar(photo.url)}; --stagger: ${i}`);
      const im = b.querySelector('img');
      im.src = cfRaw(photo.url, img.src);
      im.setAttribute('srcset', cfSrcset(photo.url, img.widths));
      if (img.sizes) im.setAttribute('sizes', img.sizes);
      im.alt = altText;
      const [w, h] = dimsOf(photo.url);
      im.setAttribute('width', w); im.setAttribute('height', h);
      const counter = b.querySelector('.gallery__counter');
      if (counter) counter.textContent = `${i + 1}/${n}`;
      return b;
    };
    grid.replaceChildren(
      ...galleryPhotos.slice(0, 2).map((p, i) => cell(heroProto, p, i, {
        src: 'w=1200,q=85', widths: [600, 900, 1200, 1600],
        sizes: i === 0 ? '(max-width: 768px) 92vw, 60vw' : '(max-width: 768px) 92vw, 40vw',
      })),
      ...galleryPhotos.slice(2, 8).map((p, i) => cell(supportProto, p, i + 2, { src: 'w=700,q=85', widths: [400, 600, 900] })),
    );
    if (n > 8) {
      overflow.replaceChildren(...galleryPhotos.slice(8).map((p, i) => cell(overflowProto, p, i + 8, { src: 'w=700,q=85', widths: [400, 600, 900] })));
      textSwap(gallery.querySelector('#gallery-expand'), 'Show all 10 photos', `Show all ${n} photos`);
    } else {
      drop(overflow);
      drop(gallery.querySelector('.gallery__expand-wrap'));
    }
  }

  // ── Partners ──
  let village = null;
  if (partnerLogos.length) {
    village = take('full', 'section.village');
    const list = village.querySelector('.village__logos');
    const proto = list.querySelector('.village__logo');
    list.replaceChildren(...partnerLogos.map((logo) => {
      const d = proto.cloneNode(true);
      const img = d.querySelector('img');
      img.src = cfRaw(logo.url, 'w=200,q=85');
      img.setAttribute('srcset', isLocal(logo.url) ? '' : `${cfRaw(logo.url, 'w=200,q=85')} 1x, ${cfRaw(logo.url, 'w=400,q=80')} 2x`);
      img.alt = logo.name || 'Project partner';
      return d;
    }));
  }

  // ── Closing call to action ──
  const cta = kid.fundraisingUrl ? take('full', 'section.page-cta') : take('alt', 'section.page-cta');
  textSwap(cta, 'Template', name);
  if (kid.fundraisingUrl) cta.querySelector('.page-cta__btn').href = kid.fundraisingUrl;

  // ── Assemble: every section is rebuilt; "More Stories" stays the page's ──
  const strip = article.querySelector('.kids-strip');
  article.replaceChildren(...[hero, modal, nav, story, design, transform, reveal, gallery, village, strip, cta].filter(Boolean));

  const meta = doc.getElementById('lb-meta');
  if (meta) { meta.dataset.galleryCount = String(galleryPhotos.length); meta.dataset.planCount = String(plans.length); }
  doc.querySelectorAll('link[rel="preload"][as="image"][imagesrcset]').forEach((l) => {
    if (!kid.heroImage || isLocal(kid.heroImage)) return l.remove();
    const mobile = l.media.includes('max-width');
    l.setAttribute('imagesrcset', mobile
      ? cfSrcset(kid.heroImage, [600, 900, 1200], { fit: 'cover', gravity: 'face' })
      : cfSrcset(kid.heroImage, [600, 900, 1200, 1600, 2400], { fit: 'cover', gravity: 'face' }));
  });
}

// The shape every page type's Preview module shares
export const patchPage = patchKidPage;
export const pagePath = (slug) => `/kids/${slug}/`;
