/**
 * press-preview.js — the press editor's Preview: the real publicity page as
 * it will be after the next publish, with this story's unsaved edits. See
 * page-preview.js for how the frame is patched. The page lists every story,
 * so the whole collection (as saved, plus this draft) rebuilds the counts,
 * the featured stories and the year-by-year archive. Mirrors
 * src/pages/publicity.astro; scripts/test-page-preview.mjs rebuilds the whole
 * page and checks it against the real one.
 */
import { CF_BASE as CF, cfRaw, cfId, checkBlobs, setLiveBlobs, loadTemplates, tools, guardFrame } from './page-preview.js';
import { linkFor, outletNameFor, outletCount, isDraft } from './press-shared.js';

export const pagePath = () => '/publicity/';
export const listPage = true;

const plain = (s) => (s || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
const formatDate = (d) => new Date(d + 'T00:00:00').toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
const CATEGORY_LABELS = {
  all: 'All', 'national-tv': 'National TV', 'local-tv': 'Local TV',
  print: 'Print & Online', magazine: 'Magazine', entertainment: 'Entertainment',
};
const VARIANTS = ['video', 'image', 'logo', 'text'];

let kitPromise = null;
export function loadKit() {
  kitPromise ??= loadTemplates('press', VARIANTS).then((templates) => ({ templates }));
  kitPromise.catch(() => { kitPromise = null; });
  return kitPromise;
}

/**
 * collection: every saved story (the draft replaces its saved self), each
 * with its slug. mediaLogos: the outlet logos, for stories without a picture.
 */
export async function buildModel(item, kit, { collection = [], mediaLogos = [] } = {}) {
  const rest = collection.filter((p) => !item || p.slug !== item.slug);
  // Drafts stay off the page, like the build
  const items = (item ? [...rest, item] : rest).filter((p) => !isDraft(p));
  const blobs = await checkBlobs(item ? [item.image] : []);
  return { item, items, mediaLogos, notes: blobs.notes, liveBlobs: blobs.alive, templates: kit.templates };
}

/** The draft story on the framed page, to scroll it into view */
export function findFocus(doc, item) {
  if (!item?.title) return null;
  const t = item.title.trim();
  const headline = (item.featuredHeadline || item.title).trim();
  return [...doc.querySelectorAll('.fph__title, .fpe__title, .ci__title')]
    .find((n) => [t, headline].includes(n.textContent.trim()))?.closest('.fph, .fpe__item, .ci') || null;
}

export function patchPage(doc, win, model) {
  guardFrame(doc, win);
  setLiveBlobs(model.liveBlobs);
  const main = doc.querySelector('main');
  if (!main) return;
  const T = model.templates;
  const { take } = tools(doc, T);
  const logoById = {};
  for (const m of model.mediaLogos) if (m.logo) logoById[m.slug] = cfId(m.logo);
  const logoFor = (key) => (key && logoById[key]) || null;
  const outletBySlug = new Map(model.mediaLogos.map((m) => [m.slug, m]));
  const outletName = (d) => outletNameFor(d, outletBySlug);
  const archived = (d) => !!(d.linkGone && d.archiveUrl);
  // A link's words, keeping the spaces around them (the arrow follows)
  const relabel = (a, words) => { const t = [...a.childNodes].find((n) => n.nodeType === 3 && n.nodeValue.trim()); if (t) t.nodeValue = t.nodeValue.replace(/\S(.*\S)?/, words); };

  // Years as the build sees them: Cloudflare builds in UTC
  // The build's order: newest first, same-day stories by id (the file name)
  const press = [...model.items]
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime() || String(a.slug).localeCompare(String(b.slug)));
  const featuredCards = press.filter((p) => p.featured).sort((a, b) => (a.order || 0) - (b.order || 0));
  const archive = press.filter((p) => !p.featured);
  const years = [...new Set(archive.map((p) => new Date(p.date).getUTCFullYear()))].sort((a, b) => b - a);

  // ── Stats ──
  const nums = main.querySelectorAll('.stats__num');
  if (nums[0]) nums[0].textContent = `${press.length}+`;
  if (nums[1]) nums[1].textContent = `${outletCount(press, outletBySlug)}+`;
  if (nums[2]) nums[2].textContent = String(press.filter((p) => p.category === 'national-tv' || p.category === 'local-tv').length);

  const kind = (d) => (d.videoId ? 'video' : d.image ? 'image' : logoFor(d.outletLogo) ? 'logo' : 'text');
  const fill = (el, sel, text) => { const n = el.querySelector(sel); if (n) n.textContent = text; };

  // ── Lead featured story ──
  let fph = null;
  if (featuredCards[0]) {
    const d = featuredCards[0];
    const headline = d.featuredHeadline || d.title;
    fph = take(kind(d), 'section.fph');
    const media = fph.querySelector('.fph__media');
    if (d.videoId) {
      const img = media.querySelector('.fph__poster');
      img.src = `https://i.ytimg.com/vi/${d.videoId}/maxresdefault.jpg`;
      img.alt = headline;
      const play = media.querySelector('.fph__play');
      play.setAttribute('aria-label', `Play ${outletName(d)} video`);
      play.dataset.ytId = d.videoId;
    } else if (d.image) {
      const img = media.querySelector('.fph__img');
      img.src = cfRaw(d.image, 'w=1200,h=800,fit=cover,q=80');
      img.setAttribute('srcset', `${cfRaw(d.image, 'w=800,h=534,fit=cover,q=70')} 800w, ${cfRaw(d.image, 'w=1200,h=800,fit=cover,q=80')} 1200w`);
      img.alt = headline;
    } else if (logoFor(d.outletLogo)) {
      const logo = logoFor(d.outletLogo);
      const img = media.querySelector('.fph__logo img');
      img.src = `${CF}/${logo}/w=480,fit=contain,q=85`;
      img.setAttribute('srcset', `${CF}/${logo}/w=480,fit=contain,q=85 1x, ${CF}/${logo}/w=960,fit=contain,q=85 2x`);
    } else {
      fill(media, '.fph__logo--text span', outletName(d));
    }
    fill(fph, '.fph__outlet', outletName(d));
    fill(fph, '.fph__title', headline);
    fill(fph, '.fph__desc', plain(d.featuredDescription || d.excerpt));
    const time = fph.querySelector('.fph__date');
    time.setAttribute('datetime', d.date);
    time.textContent = formatDate(d.date);
    const read = fph.querySelector('.fph__body a');
    if (linkFor(d)) { read.setAttribute('href', linkFor(d)); read.textContent = archived(d) ? 'Read the archived story →' : 'Read the Story →'; } else read.remove();
  }

  // ── More featured stories, alternating sides ──
  let fpe = null;
  if (featuredCards.length > 1) {
    fpe = take('video', 'section.fpe');
    const protoOf = (k) => {
      const sel = { video: '.fpe__frame', image: '.fpe__img', logo: '.fpe__logo:not(.fpe__logo--text)', text: '.fpe__logo--text' }[k];
      for (const v of VARIANTS) {
        const el = [...T[v].querySelectorAll('.fpe__item')].find((x) => x.querySelector(sel));
        if (el) {
          const copy = el.cloneNode(true);
          copy.querySelectorAll('img, source').forEach((n) => { n.removeAttribute('src'); n.removeAttribute('srcset'); });
          return doc.importNode(copy, true);
        }
      }
      return null;
    };
    const protos = Object.fromEntries(VARIANTS.map((k) => [k, protoOf(k)]));
    fpe.querySelector('.fpe__inner').replaceChildren(...featuredCards.slice(1).map((d, i) => {
      const headline = d.featuredHeadline || d.title;
      const item = protos[kind(d)].cloneNode(true);
      item.className = `fpe__item ${i % 2 !== 0 ? 'fpe__item--flip' : ''}`;
      const media = item.querySelector('.fpe__media');
      if (d.videoId) {
        const img = media.querySelector('.fpe__poster');
        img.src = `https://i.ytimg.com/vi/${d.videoId}/maxresdefault.jpg`;
        img.alt = headline;
        const play = media.querySelector('.fpe__play-btn');
        play.setAttribute('aria-label', `Play ${outletName(d)} video`);
        play.dataset.ytId = d.videoId;
      } else if (d.image) {
        const img = media.querySelector('.fpe__img');
        img.src = cfRaw(d.image, 'w=900,h=600,fit=cover,q=75');
        img.setAttribute('srcset', `${cfRaw(d.image, 'w=600,h=400,fit=cover,q=65')} 600w, ${cfRaw(d.image, 'w=900,h=600,fit=cover,q=75')} 900w`);
        img.alt = headline;
      } else if (logoFor(d.outletLogo)) {
        const logo = logoFor(d.outletLogo);
        const img = media.querySelector('.fpe__logo img');
        img.src = `${CF}/${logo}/w=400,fit=contain,q=85`;
        img.setAttribute('srcset', `${CF}/${logo}/w=400,fit=contain,q=85 1x, ${CF}/${logo}/w=800,fit=contain,q=85 2x`);
      } else {
        fill(media, '.fpe__logo--text span', outletName(d));
      }
      fill(item, '.fpe__num', String(i + 2).padStart(2, '0'));
      fill(item, '.fpe__outlet', outletName(d));
      fill(item, '.fpe__title', headline);
      fill(item, '.fpe__desc', plain(d.featuredDescription || d.excerpt));
      const time = item.querySelector('.fpe__foot time');
      time.setAttribute('datetime', d.date);
      time.textContent = formatDate(d.date);
      const link = item.querySelector('.fpe__link');
      if (linkFor(d)) { link.setAttribute('href', linkFor(d)); relabel(link, archived(d) ? 'Read the archived story' : 'Read the story'); } else link.remove();
      return item;
    }));
  }

  // Featured sections sit right after the press logos row
  main.querySelector('section.fph')?.remove();
  main.querySelector('section.fpe')?.remove();
  const after = main.querySelector('section.celebs');
  [fph, fpe].filter(Boolean).forEach((s) => after.before(s));

  // ── Archive ──
  const em = main.querySelector('#arch-heading em');
  if (em) em.textContent = `${archive.length} stories`;
  main.querySelectorAll('.archive__tabs .ftab').forEach((tab) => {
    const cat = tab.dataset.filter;
    const ct = tab.querySelector('.ftab__ct');
    if (ct) ct.textContent = String(cat === 'all' ? archive.length : archive.filter((p) => p.category === cat).length);
  });
  const groupProto = take('video', '.archive__body details.yg');
  const withUrl = groupProto.querySelector('.ci');
  const noUrl = [...T.video.querySelectorAll('.archive__body .ci')].find((c) => !c.querySelector('.ci__arrow'));
  const noUrlProto = noUrl ? doc.importNode(noUrl.cloneNode(true), true) : null;
  const card = (p) => {
    const href = linkFor(p);
    const c = (href ? withUrl : noUrlProto).cloneNode(true);
    c.dataset.category = p.category;
    fill(c, '.ci__outlet', outletName(p));
    const time = c.querySelector('.ci__meta time');
    time.setAttribute('datetime', p.date);
    time.textContent = formatDate(p.date);
    fill(c, '.ci__tag', CATEGORY_LABELS[p.category]);
    c.querySelectorAll('.ci__tag--archived').forEach((n) => n.remove());
    if (archived(p)) {
      const tag = c.querySelector('.ci__tag').cloneNode(true);
      tag.className = 'ci__tag ci__tag--archived';
      tag.setAttribute('title', 'The outlet took the story down. This links to a saved copy.');
      tag.textContent = 'Archived copy';
      c.querySelector('.ci__meta').append(tag);
    }
    const title = c.querySelector('.ci__title');
    if (href) {
      const a = title.querySelector('a');
      a.setAttribute('href', href);
      a.textContent = p.title;
      const arrow = c.querySelector('.ci__arrow');
      arrow.setAttribute('href', href);
      arrow.setAttribute('aria-label', `Read: ${p.title}`);
    } else {
      title.querySelector('span').textContent = p.title;
    }
    fill(c, '.ci__excerpt', plain(p.excerpt));
    return c;
  };
  main.querySelector('.archive__body')?.replaceChildren(...years.map((year, yi) => {
    const list = archive.filter((p) => new Date(p.date).getUTCFullYear() === year);
    const g = groupProto.cloneNode(true);
    g.dataset.year = String(year);
    if (yi === 0) g.setAttribute('open', ''); else g.removeAttribute('open');
    fill(g, '.yg__year', String(year));
    fill(g, '.yg__ct', String(list.length));
    g.querySelector('.cl').replaceChildren(...list.map(card));
    return g;
  }));
}
