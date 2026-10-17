/**
 * article-preview.js — the article editor's Preview: the real resource
 * guide page with unsaved edits in it. See page-preview.js for how the frame
 * is patched. Mirrors src/pages/resources/[slug].astro and FAQSection.astro;
 * scripts/test-page-preview.mjs checks every article against its real page.
 */
import { cfRaw, cfLqip, checkBlobs, setLiveBlobs, loadTemplates, tools, guardFrame } from './page-preview.js';

// Schema defaults (src/content/config.ts) the build applies before rendering
const DEFAULTS = {
  tag: 'Guide', aboutTopics: [], faqs: [],
  ctaHeading: 'Need help with your home?',
  ctaText: 'Sunshine on a Ranney Day builds accessible bathrooms, dream bedrooms, and therapy rooms for children with special needs — at no cost to families in the greater Atlanta area.',
  ctaPrimaryLink: '/apply/', ctaPrimaryLabel: 'Apply for a Makeover',
  ctaSecondaryLink: '/donate/', ctaSecondaryLabel: 'Support Our Mission',
};
const withDefaults = (a) => {
  const out = { ...a };
  for (const [k, v] of Object.entries(DEFAULTS)) if (out[k] === undefined) out[k] = v;
  return out;
};

export const pagePath = (slug) => `/resources/${slug}/`;
export const hasPage = () => true;

let kitPromise = null;
export function loadKit() {
  kitPromise ??= loadTemplates('article', ['full', 'nohero']).then((templates) => ({ templates }));
  kitPromise.catch(() => { kitPromise = null; });
  return kitPromise;
}

export async function buildModel(article, kit) {
  const blobs = await checkBlobs([article.heroImage]);
  return { item: article, notes: blobs.notes, liveBlobs: blobs.alive, templates: kit.templates };
}

export function patchPage(doc, win, model) {
  guardFrame(doc, win);
  setLiveBlobs(model.liveBlobs);
  const root = doc.querySelector('main article');
  if (!root) return;
  const a = withDefaults(model.item);
  const { take, drop, setParsedHtml } = tools(doc, model.templates);
  const body = a.body || '';

  const wordCount = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().split(/\s+/).length;
  const readingTime = Math.max(1, Math.round(wordCount / 238));
  const h2Regex = /<h2>(.*?)<\/h2>/g;
  const tocItems = [];
  const seenIds = new Map();
  let match;
  while ((match = h2Regex.exec(body)) !== null) {
    const text = match[1].replace(/<[^>]+>/g, '');
    const base = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const n = (seenIds.get(base) ?? 0) + 1;
    seenIds.set(base, n);
    tocItems.push({ text, id: n === 1 ? base : `${base}-${n}` });
  }
  let bodyWithIds = body;
  for (const item of tocItems) bodyWithIds = bodyWithIds.replace(`<h2>${item.text}</h2>`, `<h2 id="${item.id}">${item.text}</h2>`);

  // ── Hero (without a photo of its own, the site's fallback photo) ──
  const hero = take(a.heroImage ? 'full' : 'nohero', 'section.hero');
  hero.querySelector('.section-label').textContent = a.tag || 'Resource Guide';
  setParsedHtml(hero.querySelector('h1'), a.title || '');
  hero.querySelector('.hero-lead').textContent = a.heroLead ?? '';
  const [timeItem, sectionsItem] = hero.querySelectorAll('.hero-meta-item');
  const lastText = (el) => [...el.childNodes].filter((n) => n.nodeType === 3 && n.nodeValue.trim()).pop();
  lastText(timeItem).nodeValue = ` ${readingTime} min read `;
  lastText(sectionsItem).nodeValue = ` ${tocItems.length} sections `;
  const heroPhotoId = a.heroImage || null;
  const frame = hero.querySelector('.hero-frame');
  const img = frame.querySelector('img');
  if (heroPhotoId) {
    frame.setAttribute('style', `background-image:url('${cfLqip(heroPhotoId)}')`);
    img.src = cfRaw(heroPhotoId, 'w=800,h=1000,fit=cover,gravity=face,q=65');
    img.setAttribute('srcset', `${cfRaw(heroPhotoId, 'w=400,h=500,fit=cover,gravity=face,q=65')} 400w, ${cfRaw(heroPhotoId, 'w=560,h=700,fit=cover,gravity=face,q=65')} 560w, ${cfRaw(heroPhotoId, 'w=800,h=1000,fit=cover,gravity=face,q=65')} 800w`);
  } else {
    // The template page's own fallback photo, exactly as the build sets it
    const tplImg = model.templates.nohero.querySelector('section.hero .hero-frame img');
    img.src = tplImg.getAttribute('src');
    img.setAttribute('srcset', tplImg.getAttribute('srcset'));
  }

  // ── Body: table of contents + prose ──
  const section = take('full', 'section.article-body');
  const toc = section.querySelector('.toc');
  if (tocItems.length) {
    const list = toc.querySelector('.toc-list');
    const proto = list.querySelector('li');
    list.replaceChildren(...tocItems.map((item, idx) => {
      const li = proto.cloneNode(true);
      const link = li.querySelector('a');
      link.setAttribute('href', `#${item.id}`);
      link.querySelector('.toc-num').textContent = String(idx + 1).padStart(2, '0');
      [...link.childNodes].filter((n) => n.nodeType === 3).forEach((n) => n.remove());
      link.append(doc.createTextNode(item.text));
      return li;
    }));
  } else drop(toc);
  setParsedHtml(section.querySelector('.prose'), bodyWithIds);

  // ── Questions ──
  let faq = null;
  if (a.faqs && a.faqs.length > 0) {
    faq = take('full', 'section.faq');
    const right = faq.querySelector('.faq-right');
    const proto = right.querySelector('details');
    right.replaceChildren(...a.faqs.map((item, idx) => {
      const d = proto.cloneNode(true);
      d.setAttribute('name', `faq-${a.slug}`);
      d.querySelector('.faq-num').textContent = String(idx + 1).padStart(2, '0');
      d.querySelector('.faq-q').textContent = item.question;
      setParsedHtml(d.querySelector('.faq-answer p'), item.answer);
      return d;
    }));
  }

  // ── Closing call to action ──
  const cta = take('full', 'section.article-cta');
  cta.querySelector('h2').textContent = a.ctaHeading ?? '';
  cta.querySelector('.article-cta-body').textContent = a.ctaText ?? '';
  const [primary, secondary] = cta.querySelectorAll('.article-cta-btns a');
  primary.setAttribute('href', a.ctaPrimaryLink); primary.textContent = a.ctaPrimaryLabel;
  secondary.setAttribute('href', a.ctaSecondaryLink); secondary.textContent = a.ctaSecondaryLabel;

  // Swap in place: the press logos row and "More guides" stay the page's
  root.querySelector('section.hero')?.replaceWith(hero);
  root.querySelector('section.article-body')?.replaceWith(section);
  const oldFaq = root.querySelector('section.faq');
  if (faq) { if (oldFaq) oldFaq.replaceWith(faq); else section.after(faq); } else drop(oldFaq);
  const more = root.querySelector('section.more');
  if (more) more.querySelectorAll(`a[href="/resources/${a.slug}/"]`).forEach((x) => x.remove());
  root.querySelector('section.article-cta')?.replaceWith(cta);

  const pre = doc.querySelector('link[rel="preload"][as="image"][imagesrcset]');
  if (pre) pre.setAttribute('imagesrcset', img.getAttribute('srcset'));
}
