/**
 * event-preview.js — the event editor's Preview: the real event page with
 * unsaved edits in it. See page-preview.js for how the frame is patched.
 * Mirrors src/pages/events/[slug].astro: before the event its own layout,
 * after it the recap (src/components/events/EventRecap.astro with
 * RecapPhotos and RecapSponsors). The rules for both come from
 * ./events-shared.js. scripts/test-page-preview.mjs checks every event
 * against its real page.
 *
 * A gala or golf tournament has no page of its own: it shows on /events/gala/
 * or /events/golf/ (laid out by the Gala and Golf editors) and, after the next
 * one is added, on its year's page.
 */
import { cfRaw, cfSrcset, cfLqip, cfId, checkBlobs, setLiveBlobs, loadTemplates, tools, guardFrame, measure } from './page-preview.js';
import * as ES from './events-shared.js';

const CAT_LABEL = { fundraiser: 'Fundraiser', volunteer: 'Volunteer', reveal: 'Room Reveal', community: 'Community', other: 'Event' };
const getYouTubeId = (url) => url.match(/(?:youtu\.be\/|youtube\.com\/(?:watch\?v=|embed\/|v\/|shorts\/))([\w-]{11})/)?.[1] || null;
const fmtDate = (d) => new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
const fmtWeekday = (d) => new Date(d + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long' });

export const pagePath = (slug) => `/events/${slug}/`;
// No event page on the site to build in yet (every one is a gala or golf event): the template page
export const fallbackPath = () => '/admin/event-template/upcoming/';

/** Does the build give this event a page of its own? (getStaticPaths in [slug].astro) */
export const hasPage = (ev) => ES.hasOwnPage(ev, [ev]);
export const noPageNote = 'This event won’t have a page of its own yet: an event gets one when it has a full description, photos or a video, or once its date has passed. Until then it’s listed on the Events page. A gala or golf tournament shows on the gala or golf page instead, and keeps a page of its own year once the next one is added.';

let kitPromise = null;
export function loadKit() {
  kitPromise ??= loadTemplates('event', ['upcoming', 'youtube', 'past', 'pending', 'poster']).then((templates) => ({ templates }));
  kitPromise.catch(() => { kitPromise = null; });
  return kitPromise;
}

/**
 * opts.partners: partner records, for the sponsor links the page finds by logo
 * or name; opts.measure === false skips measuring photo shapes (the build's
 * manifest does it for saved photos; new ones are measured the same way).
 */
export async function buildModel(ev, kit, opts = {}) {
  const photos = ES.cleanPhotos(ev.photos);
  const logos = ES.cleanSponsors(ev.sponsors).flatMap((t) => t.names.map((n) => n.logo).filter(Boolean));
  const blobs = await checkBlobs([ev.image, ...photos.map((p) => p.id), ...logos]);
  const notes = [...blobs.notes];
  if (ev.videoUrl && !ev.streamVideoId && !getYouTubeId(ev.videoUrl)) notes.push('The video link isn’t a YouTube link the page can play, so there’s no video section.');
  const dims = {};
  if (opts.measure !== false && ES.isOver(ev)) {
    await Promise.all(photos.map(async (p) => { const d = await measure(cfId(p.id)); if (d) dims[p.id] = d; }));
  }
  const sites = { byLogo: new Map(), byName: new Map() };
  for (const p of opts.partners || []) {
    if (!p?.website) continue;
    if (p.logo) sites.byLogo.set(cfId(p.logo), p.website);
    sites.byName.set(ES.nameKey(p.name), p.website);
  }
  return { item: ev, notes, liveBlobs: blobs.alive, templates: kit.templates, dims, sites };
}

export function patchPage(doc, win, model) {
  guardFrame(doc, win);
  setLiveBlobs(model.liveBlobs);
  const main = doc.querySelector('main');
  if (!main) return;
  const ev = { category: 'other', photos: [], ...model.item };
  if (ES.isOver(ev)) patchRecap(doc, main, ev, model);
  else patchUpcoming(doc, main, ev, model);
  doc.querySelectorAll('link[rel="preload"][as="image"][imagesrcset]').forEach((l) => {
    const keep = !ES.isOver(ev) && ev.image;
    if (keep) l.setAttribute('imagesrcset', cfSrcset(ev.image, [600, 900, 1200], { fit: 'cover' })); else l.remove();
  });
}

// ── Before the event ─────────────────────────────────────────────────────
function patchUpcoming(doc, main, ev, model) {
  const { take, textSwap, drop, setParsedHtml } = tools(doc, model.templates);
  const photos = (ev.photos || []).map((p) => ({ alt: '', ...p }));
  const streamVideoId = ev.streamVideoId || null;
  const videoYtId = ev.videoUrl ? getYouTubeId(ev.videoUrl) : null;
  const title = ev.title || 'New event';
  const heroSrcset = ev.image ? cfSrcset(ev.image, [600, 900, 1200], { fit: 'cover' }) : '';
  const setMetaText = (span, text) => {
    const nodes = [...span.childNodes].filter((n) => n.nodeType === 3 && n.nodeValue.trim());
    nodes.forEach((n, i) => { if (i) n.remove(); });
    if (nodes[0]) nodes[0].nodeValue = ` ${text} `;
  };

  const hero = take('upcoming', 'section.ev-hero');
  hero.querySelector('.ev-hero__eyebrow').textContent = CAT_LABEL[ev.category] || 'Event';
  hero.querySelector('.ev-hero__title').textContent = title;
  const [dateItem, timeItem, placeItem] = hero.querySelectorAll('.ev-hero__meta-item');
  const time = dateItem.querySelector('time');
  time.setAttribute('datetime', ev.date);
  time.textContent = `${fmtWeekday(ev.date)}, ${fmtDate(ev.date)}`;
  if (ev.time) setMetaText(timeItem, ev.time); else drop(timeItem);
  setMetaText(placeItem, ev.location || '');
  hero.querySelector('.ev-hero__desc').textContent = ev.description || '';
  const actions = hero.querySelector('.ev-hero__actions');
  if (ev.ticketUrl) {
    const a = actions.querySelector('a');
    a.href = ev.ticketUrl;
    textSwap(a, 'Get Tickets — $100', ev.ticketPrice ? `Get Tickets — ${ev.ticketPrice}` : 'Get Tickets');
  } else drop(actions);
  const visual = hero.querySelector('.ev-hero__visual');
  if (ev.image) {
    visual.setAttribute('style', `background-image:url('${cfLqip(ev.image)}')`);
    const img = visual.querySelector('img');
    img.src = cfRaw(ev.image, 'w=900,fit=cover,q=85');
    img.setAttribute('srcset', heroSrcset);
    img.alt = title;
  } else drop(visual);

  let body = null;
  if (ev.body) {
    body = take('upcoming', 'section.ev-body');
    setParsedHtml(body.querySelector('.ev-body__content'), ev.body);
  }

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
    video = take('youtube', 'section.ev-video');
    const b = video.querySelector('.ev-video__facade');
    b.dataset.ytId = videoYtId;
    b.setAttribute('aria-label', `Play ${title} video`);
    b.querySelector('source').setAttribute('srcset', `https://i.ytimg.com/vi_webp/${videoYtId}/maxresdefault.webp`);
    const img = b.querySelector('img');
    img.src = `https://i.ytimg.com/vi/${videoYtId}/maxresdefault.jpg`;
    img.alt = `Video preview for ${title}`;
  }

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

  const cta = take('upcoming', 'section.ev-cta');
  main.replaceChildren(...[hero, body, video, gallery, cta].filter(Boolean));
}

// ── After the event: the recap ───────────────────────────────────────────
const LOGO = { xl: [600, 300], lg: [480, 240], md: [360, 180], sm: [280, 140] };
const logoAt = (logo, w, h, q = 88) => cfRaw(logo, `trim=border,w=${w},h=${h},fit=contain,q=${q}`);

function patchRecap(doc, main, ev, model) {
  const { take, drop, setParsedHtml } = tools(doc, model.templates);
  const events = [ev];
  const year = ES.yearOf(ev);
  const name = ES.displayName(ev);
  const label = `${name} ${year}`.trim();
  const when = 'day';
  const photos = ES.recapPhotos(ev, events, null);
  const sponsors = ES.recapSponsors(ev, events, null);
  const highlights = ES.cleanHighlights(ev.highlights);
  const credit = ev.photographer ? { name: String(ev.photographer).trim(), url: ev.photographerUrl || '' } : null;
  const websiteOf = (s) => s.website || (s.logo && model.sites.byLogo.get(cfId(s.logo))) || model.sites.byName.get(ES.nameKey(s.name)) || '';
  const cidOf = (el) => [...el.attributes].find((a) => a.name.startsWith('data-astro-cid-'))?.name;
  const make = (tag, like, attrs = {}) => {
    const el = doc.createElement(tag);
    const cid = cidOf(like);
    if (cid) el.setAttribute(cid, '');
    for (const [k, v] of Object.entries(attrs)) if (v !== null && v !== undefined && v !== false) el.setAttribute(k, v === true ? '' : String(v));
    return el;
  };

  const rc = take('past', 'div.rc');
  rc.replaceChildren();

  // Hero
  const hero = take('past', 'section.rh');
  hero.querySelector('.rh-eyebrow').textContent = `${year} · Thank you`;
  const h1 = hero.querySelector('.rh-title');
  const em = h1.querySelector('em');
  const m = name.match(/^(.*\s)(\S+)$/);
  em.textContent = m ? m[2] : name;
  h1.replaceChildren(...[m ? doc.createTextNode(` ${m[1]}`) : null, em].filter(Boolean));
  const [dateLi, placeLi] = hero.querySelectorAll('.rh-meta li');
  const t = dateLi.querySelector('time');
  t.setAttribute('datetime', ev.date);
  t.textContent = ES.fmtDay(ev.date, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  if (ev.location) {
    [...placeLi.childNodes].filter((n) => n.nodeType === 3).forEach((n) => n.remove());
    placeLi.append(doc.createTextNode(` ${String(ev.location).trim()} `));
  } else drop(placeLi);
  hero.querySelector('.rh-lead').textContent = ES.recapLead(ev, { photos: photos.length, sponsors: sponsors.length });
  const ctas = hero.querySelector('.rh-ctas');
  const [toPhotos, toSponsors] = ctas.querySelectorAll('a');
  if (!photos.length) drop(toPhotos);
  if (sponsors.length) toSponsors.className = photos.length ? 'btn btn-outline-dark rh-btn-2' : 'btn btn-primary btn-lg';
  else drop(toSponsors);
  if (!photos.length && !sponsors.length) drop(ctas);
  const dl = hero.querySelector('.rh-highlights');
  if (highlights.length) {
    const proto = dl.querySelector('div');
    dl.replaceChildren(...highlights.map((hl) => {
      const d = proto.cloneNode(true);
      d.querySelector('dt').textContent = hl.label;
      d.querySelector('dd').textContent = hl.value;
      return d;
    }));
  } else drop(dl);

  // Cover: the first photo, the second overlapping it; the poster before photos; else the made cover
  const frame = hero.querySelector('.rh-frame');
  const accent = frame.querySelector('.rh-accent');
  const cover = photos[0]?.id || ev.image || null;
  const coverAlt = photos[0]?.alt || (!photos.length && ev.image ? `${label} poster` : `${label}, a moment from the ${when}`);
  let coverEl;
  if (photos.length) {
    coverEl = frame.querySelector('a.rh-photo:not(.rh-photo--small)');
    coverEl.setAttribute('style', `background-image:url('${cfLqip(cover)}')`);
    const img = coverEl.querySelector('img');
    img.src = cfRaw(cover, 'w=640,h=800,fit=cover,gravity=face,q=82');
    img.setAttribute('srcset', cfSrcset(cover, [400, 640, 800, 1024], { fit: 'cover', gravity: 'face', aspectRatio: 1.25, quality: 82 }));
    img.alt = coverAlt;
  } else if (cover) {
    coverEl = take('poster', 'div.rh-photo');
    coverEl.setAttribute('style', `background-image:url('${cfLqip(cover)}')`);
    const img = coverEl.querySelector('img');
    img.src = cfRaw(cover, 'w=640,h=800,fit=cover,gravity=top,q=82');
    img.setAttribute('srcset', cfSrcset(cover, [400, 640, 800, 1024], { fit: 'cover', gravity: 'top', aspectRatio: 1.25, quality: 82 }));
    img.alt = coverAlt;
  } else {
    coverEl = take('pending', '.rh-photo--made');
    coverEl.querySelector('.rh-made__year').textContent = year;
    coverEl.querySelector('.rh-made__name').textContent = name;
  }
  let small = frame.querySelector('.rh-photo--small');
  if (photos[1]) {
    const s = photos[1].id;
    small.setAttribute('style', `background-image:url('${cfLqip(s)}')`);
    const img = small.querySelector('img');
    img.src = cfRaw(s, 'w=360,h=432,fit=cover,gravity=face,q=75');
    img.setAttribute('srcset', `${cfRaw(s, 'w=200,h=240,fit=cover,gravity=face,q=75')} 200w, ${cfRaw(s, 'w=360,h=432,fit=cover,gravity=face,q=75')} 360w`);
  } else small = null;
  frame.replaceChildren(...[accent, coverEl, small].filter(Boolean));
  const stat = hero.querySelector('.rh-stat');
  if (photos.length) stat.querySelector('.rh-stat__num').textContent = String(photos.length);
  else drop(stat);
  rc.append(hero);

  // Photos, or the note that they're on the way
  if (photos.length) {
    const rp = take('past', 'section.rp');
    const fileBase = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'photo';
    rp.dataset.file = fileBase;
    rp.dataset.label = label;
    rp.querySelector('.rp-title').firstChild.nodeValue = `The ${when} in `;
    const total = photos.length;
    rp.querySelector('.rp-sub').textContent = `${total} ${total === 1 ? 'photo' : 'photos'}. Tap any one to see it full size, save it, or send it to a friend.`;
    const cred = rp.querySelector('.rp-credit');
    if (credit?.name) {
      const svg = cred.querySelector('svg');
      const link = cred.querySelector('a');
      cred.replaceChildren(svg, doc.createTextNode(' Photos by '));
      if (credit.url) { link.href = credit.url; link.textContent = credit.name; cred.append(link); }
      else cred.append(doc.createTextNode(credit.name));
    } else drop(cred);
    const grid = rp.querySelector('.rp-grid');
    const proto = grid.querySelector('.rp-item');
    const shown = total <= 24 ? total : 20;
    grid.replaceChildren(...photos.map((p, i) => {
      const d = model.dims[p.id];
      const ar = d ? Math.round((d[0] / d[1]) * 1000) / 1000 : 1.5;
      const alt = p.alt || `${label}, photo ${i + 1} of ${total}`;
      const li = proto.cloneNode(true);
      li.setAttribute('style', `--ar:${ar}`);
      if (i >= shown) li.setAttribute('hidden', ''); else li.removeAttribute('hidden');
      const a = li.querySelector('a');
      a.href = cfRaw(p.id, 'w=2000,fit=scale-down,q=86');
      a.id = `photo-${i + 1}`;
      a.dataset.rpOpen = String(i);
      a.dataset.id = p.id;
      a.dataset.ar = String(ar);
      a.dataset.alt = alt;
      a.setAttribute('aria-label', `Open photo ${i + 1} of ${total}`);
      a.setAttribute('style', `background-image:url('${cfLqip(p.id)}')`);
      const img = a.querySelector('img');
      img.src = cfRaw(p.id, 'w=480,fit=scale-down,q=80');
      img.setAttribute('srcset', cfSrcset(p.id, [240, 360, 480, 720, 960, 1200], { fit: 'scale-down', quality: 80 }));
      img.setAttribute('sizes', `(max-width: 640px) ${Math.ceil(ar * 170)}px, ${Math.ceil(ar * 340)}px`);
      img.alt = alt;
      img.setAttribute('width', String(Math.round(ar * 400)));
      img.setAttribute('loading', i < 8 ? 'eager' : 'lazy');
      return li;
    }));
    rp.querySelector('.rp-more')?.remove();
    if (total > shown) {
      const more = make('div', grid, { class: 'rp-more' });
      const btn = make('button', grid, { type: 'button', class: 'rp-more__btn', 'data-rp-more': true, 'aria-controls': 'photos' });
      btn.innerHTML = `Show all ${total} photos <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg>`;
      const cid = cidOf(grid);
      if (cid) btn.querySelectorAll('svg, path').forEach((n) => n.setAttribute(cid, ''));
      more.append(btn);
      grid.after(more);
    }
    const dlg = rp.querySelector('[data-rv]');
    dlg.setAttribute('aria-label', `${label} photos`);
    dlg.querySelector('.rv-of').textContent = ` of ${total}`;
    dlg.querySelector('[data-rv-save]').href = cfRaw(photos[0].id, 'w=2000,fit=scale-down,q=86');
    const rvCredit = dlg.querySelector('.rv-credit');
    if (credit?.name) rvCredit.textContent = `Photo by ${credit.name}`;
    else drop(rvCredit);
    rc.append(rp, take('past', 'script[src*="RecapPhotos"]'));
  } else {
    rc.append(take('pending', 'section.rc-pending'));
  }

  // Sponsors
  if (sponsors.length) {
    const rs = take('past', 'section.rs');
    const count = ES.sponsorCount(sponsors);
    rs.querySelector('.rs-sub').textContent = `${count === 1 ? 'This sponsor' : `These ${count} businesses, families and friends`} made the ${when} possible.`;
    const tierProto = rs.querySelector('.rs-tier--md');
    const logoProto = tierProto.querySelector('.rs-logo');
    const nameProto = tierProto.querySelector('.rs-name');
    const momentsProto = rs.querySelector('.rs-moments');
    const momentProto = momentsProto.querySelector('.rs-moment');
    const momentImg = momentProto.querySelector('img');
    const momentName = momentProto.querySelector('.rs-moment__sponsor > span');
    const foot = rs.querySelector('.rs-foot');
    rs.querySelectorAll('.rs-tier, .rs-moments').forEach((n) => n.remove());
    const { levels, moments } = ES.splitSponsors(sponsors);
    for (const tier of levels) {
      const block = tierProto.cloneNode(true);
      block.className = `rs-tier rs-tier--${tier.size}`;
      block.querySelector('.rs-tier__label span').textContent = tier.tier;
      const ul = block.querySelector('ul');
      ul.className = `rs-grid rs-grid--${tier.size}`;
      ul.dataset.count = String(tier.names.length);
      const liProto = ul.querySelector('li');
      ul.replaceChildren(...tier.names.map((s) => {
        const li = liProto.cloneNode(false);
        const href = websiteOf(s);
        const card = make(href ? 'a' : 'div', ul, href ? { class: 'rs-card', href, target: '_blank', rel: 'noopener', 'aria-label': `${s.name}, opens their website` } : { class: 'rs-card' });
        if (s.logo) {
          const [w, h] = LOGO[tier.size] || LOGO.md;
          const img = logoProto.cloneNode(false);
          img.src = logoAt(s.logo, w, h);
          img.setAttribute('srcset', `${logoAt(s.logo, w, h)} 1x, ${logoAt(s.logo, w * 2, h * 2, 82)} 2x`);
          img.alt = s.name;
          img.setAttribute('width', String(w));
          img.setAttribute('height', String(h));
          if (s.scale) img.setAttribute('style', `--logo-scale:${s.scale}`); else img.removeAttribute('style');
          card.append(img);
        } else {
          const span = nameProto.cloneNode(false);
          span.textContent = s.name;
          card.append(span);
        }
        li.append(card);
        return li;
      }));
      foot.before(block);
    }
    if (moments.length) {
      const block = momentsProto.cloneNode(true);
      const ul = block.querySelector('ul');
      ul.replaceChildren(...moments.map((tier) => {
        const li = momentProto.cloneNode(true);
        li.querySelector('.rs-moment__what').textContent = ES.momentName(tier.tier);
        const who = li.querySelector('.rs-moment__who');
        who.replaceChildren(...tier.names.map((s) => {
          const href = websiteOf(s);
          const el = make(href ? 'a' : 'span', ul, href ? { class: 'rs-moment__sponsor', href, target: '_blank', rel: 'noopener' } : { class: 'rs-moment__sponsor' });
          if (s.logo) {
            const img = momentImg.cloneNode(false);
            img.src = logoAt(s.logo, 160, 80, 85);
            img.setAttribute('srcset', `${logoAt(s.logo, 160, 80, 85)} 1x, ${logoAt(s.logo, 320, 160, 80)} 2x`);
            el.append(img);
          }
          const span = momentName.cloneNode(false);
          span.textContent = s.name;
          el.append(span);
          return el;
        }));
        return li;
      }));
      foot.before(block);
    }
    foot.querySelector('a').href = `mailto:info@soardcharity.com?subject=${encodeURIComponent(`${name} sponsorship`)}`;
    rc.append(rs);
  }

  // Video and the longer story (events outside a series)
  const streamId = ev.streamVideoId || null;
  const ytId = !streamId && ev.videoUrl ? getYouTubeId(ev.videoUrl) : null;
  if (streamId || ytId) {
    const video = take(streamId ? 'poster' : 'past', 'section.rc-video');
    const b = video.querySelector('.rc-video__facade');
    b.setAttribute('aria-label', `Play the ${label} video`);
    if (streamId) b.dataset.streamId = streamId; else b.dataset.ytId = ytId;
    b.querySelector('img').src = streamId
      ? `https://videodelivery.net/${streamId}/thumbnails/thumbnail.jpg?time=2s&width=1600&height=900&fit=crop`
      : `https://i.ytimg.com/vi/${ytId}/maxresdefault.jpg`;
    rc.append(video);
  }
  if (ev.body) {
    const body = take('past', 'section.rc-body');
    setParsedHtml(body.querySelector('.rc-body__inner'), ev.body);
    rc.append(body);
  }
  rc.append(take('past', 'section.rc-close'));
  main.replaceChildren(rc, take('past', 'script[src*="EventRecap"]'));
}
