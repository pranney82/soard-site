/**
 * community-preview.js — the community project editor's Preview: the real
 * project page with unsaved edits in it. See page-preview.js for how the
 * frame is patched. Mirrors src/pages/community/[slug].astro;
 * scripts/test-page-preview.mjs checks every project against its real page.
 */
import { cfRaw, cfImage, checkBlobs, setLiveBlobs, loadTemplates, tools, guardFrame } from './page-preview.js';

const getYouTubeId = (url) => (url ? url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|shorts\/))([a-zA-Z0-9_-]{11})/)?.[1] || null : null);
// Schema defaults (src/content/config.ts) the build applies before rendering
const withDefaults = (p) => ({
  color: '#373A36', status: 'completed', stats: [], ...p,
  photos: (p.photos || []).map((x) => ({ alt: '', ...x })),
  partnerLogos: (p.partnerLogos || []).map((x) => ({ name: '', ...x })),
});

export const pagePath = (slug) => `/community/${slug}/`;
/** The build gives a project a page only when it has a full story */
export const hasPage = (p) => !!p.story;
export const noPageNote = 'This project won’t have a page of its own until it has a full story. Until then it’s listed on the Community Projects page.';

let kitPromise = null;
export function loadKit() {
  kitPromise ??= loadTemplates('community', ['full', 'alt']).then((templates) => ({ templates }));
  kitPromise.catch(() => { kitPromise = null; });
  return kitPromise;
}

export async function buildModel(project, kit) {
  const blobs = await checkBlobs([project.heroImage, ...(project.photos || []).map((p) => p.url), ...(project.partnerLogos || []).map((p) => p.url)]);
  const notes = [...blobs.notes];
  if (project.videoUrl && !project.streamVideoId && !getYouTubeId(project.videoUrl)) notes.push('The video link isn’t a YouTube link the page can play, so there’s no video section.');
  return { item: project, notes, liveBlobs: blobs.alive, templates: kit.templates };
}

export function patchPage(doc, win, model) {
  guardFrame(doc, win);
  setLiveBlobs(model.liveBlobs);
  const main = doc.querySelector('main');
  if (!main) return;
  const p = withDefaults(model.item);
  const { take, drop, setParsedHtml } = tools(doc, model.templates);
  const name = p.name || 'New project';
  const rawStory = p.story || '';
  const storyIsHtml = /<\/?(p|br|strong|em|b|i|u|ul|ol|li|a|h[1-6]|blockquote)\b/i.test(rawStory);
  const storyParas = storyIsHtml ? [] : rawStory.split('\n\n').filter((x) => x.trim());
  const ytId = p.videoUrl ? getYouTubeId(p.videoUrl) : null;
  const streamId = p.streamVideoId || null;
  const heroStats = (p.stats?.length ? p.stats : [{ value: p.impact, label: p.impactLabel }]).slice(0, 3);
  const setImage = (img, src, alt, opts) => {
    const r = cfImage(src, opts);
    img.src = r.src;
    if (r.srcset !== null) img.setAttribute('srcset', r.srcset); else { img.removeAttribute('srcset'); img.removeAttribute('sizes'); }
    img.alt = alt;
  };

  // ── Hero ──
  const hero = take('full', 'section.cp-detail-hero');
  hero.setAttribute('aria-label', name);
  if (p.heroImage) {
    setImage(hero.querySelector('.cp-detail-hero-img'), p.heroImage, p.imageAlt || `${name} project by SOARD`, { widths: [400, 600, 700, 1000], fit: 'cover' });
  } else {
    const color = take('alt', '.cp-detail-hero-color');
    color.setAttribute('style', `background: ${p.color};`);
    color.querySelector('.cp-detail-hero-color-num').textContent = p.impact ?? '';
    color.querySelector('.cp-detail-hero-color-label').textContent = p.impactLabel ?? '';
    hero.querySelector('.cp-detail-hero-photo').replaceWith(color);
  }
  hero.querySelector('.section-label').textContent = `${p.year} Community Project`;
  hero.querySelector('.cp-detail-hero-name').textContent = name;
  const founded = hero.querySelector('.cp-detail-hero-founded');
  if (p.founded) founded.textContent = `Founded in ${p.founded}`; else drop(founded);
  const stats = hero.querySelector('.cp-detail-hero-stats');
  const statProto = stats.querySelector('.cp-detail-stat');
  stats.replaceChildren(...heroStats.map((st) => {
    const el = statProto.cloneNode(true);
    el.querySelector('.cp-detail-stat-num').textContent = st.value ?? '';
    el.querySelector('.cp-detail-stat-label').textContent = st.label ?? '';
    return el;
  }));
  if (p.status !== 'in-progress') drop(hero.querySelector('.cp-detail-badge'));

  // ── Story ──
  const story = take('full', 'section.cp-detail-story');
  story.querySelector('.cp-detail-story-heading em').textContent = name;
  if (storyIsHtml) {
    setParsedHtml(story.querySelector('.cp-detail-story-body'), rawStory);
  } else {
    const plain = take('alt', '.cp-detail-story-body');
    const paraProto = plain.querySelector('p');
    plain.replaceChildren(...storyParas.map((para, i) => {
      const el = paraProto.cloneNode(true);
      el.dataset.delay = String(Math.min(i, 3));
      el.textContent = para;
      return el;
    }));
    story.querySelector('.cp-detail-story-body').replaceWith(plain);
  }

  // ── Quote ──
  let quote = null;
  if (p.quote) {
    quote = take('full', 'section.cp-detail-quote');
    quote.querySelector('blockquote p').textContent = `"${p.quote}"`;
  }

  // ── Video ──
  let video = null;
  if (streamId || ytId) {
    video = take(streamId ? 'full' : 'alt', 'section.cp-detail-video');
    const f = video.querySelector(streamId ? '#stream-facade' : '#yt-facade');
    f.dataset.id = streamId || ytId;
    f.setAttribute('aria-label', `Play ${name} video`);
    const img = f.querySelector('img');
    img.alt = `Video thumbnail for ${name}`;
    if (streamId) {
      img.src = `https://videodelivery.net/${streamId}/thumbnails/thumbnail.jpg?time=2s&height=720`;
    } else {
      f.querySelector('source').setAttribute('srcset', `https://i.ytimg.com/vi_webp/${ytId}/maxresdefault.webp`);
      img.src = `https://i.ytimg.com/vi/${ytId}/maxresdefault.jpg`;
    }
  }

  // ── Photos (shown from two up) ──
  let gallery = null;
  if (p.photos.length > 1) {
    gallery = take('full', 'section.cp-detail-gallery');
    const grid = gallery.querySelector('.cp-detail-gallery-grid');
    const proto = grid.querySelector('.cp-detail-gallery-item');
    grid.replaceChildren(...p.photos.map((photo) => {
      const el = proto.cloneNode(true);
      setImage(el.querySelector('img'), photo.url, photo.alt || `${name} project photo`, { widths: [300, 400, 600], fit: 'cover' });
      return el;
    }));
  }

  // ── Partners ──
  let partners = null;
  if (p.partnerLogos.length > 0) {
    partners = take('full', 'section.cp-detail-partners');
    const grid = partners.querySelector('.cp-detail-partners-grid');
    const proto = grid.querySelector('.cp-detail-partner-logo');
    grid.replaceChildren(...p.partnerLogos.map((logo) => {
      const el = proto.cloneNode(true);
      el.setAttribute('title', logo.name);
      const img = el.querySelector('img');
      img.src = cfRaw(logo.url, 'w=280,h=140,fit=contain,q=80');
      img.alt = logo.name || 'Project partner logo';
      return el;
    }));
  }

  // "More Community Projects" stays the page's; it lists the other projects
  const more = main.querySelector('section.cp-detail-more');
  if (more) more.querySelectorAll(`a[href="/community/${p.slug}/"]`).forEach((a) => a.remove());
  const cta = take('full', 'section.cp-detail-cta');
  main.replaceChildren(...[hero, story, quote, video, gallery, partners, more, cta].filter(Boolean));
}
