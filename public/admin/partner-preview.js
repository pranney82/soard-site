/**
 * partner-preview.js — the partner editor's Preview: the real partners page
 * as it will be after the next publish, with this partner's unsaved edits.
 * See page-preview.js for how the frame is patched. The page lists every
 * partner, so the whole collection (as saved, plus this draft) rebuilds the
 * counts, the Signature and Champion sections and the directory. Mirrors
 * src/pages/partners/index.astro; scripts/test-page-preview.mjs rebuilds the
 * whole page and checks it against the real one.
 */
import { cfRaw, cfId, cfDensitySrcset, checkBlobs, setLiveBlobs, loadTemplates, tools, guardFrame } from './page-preview.js';

export const pagePath = () => '/partners/';
export const listPage = true;

// A card links only to an http(s) website (the page's linkable())
const linkable = (url) => /^https?:\/\//i.test(url || '');

// Schema defaults (src/content/config.ts) the build applies before rendering
const withDefaults = (p) => ({
  level: 'friend', featured: false, order: 0, ...p,
  category: Array.isArray(p.category) ? p.category : [p.category ?? 'build'],
});

let kitPromise = null;
export function loadKit() {
  kitPromise ??= loadTemplates('partner', ['full']).then((templates) => ({ templates }));
  kitPromise.catch(() => { kitPromise = null; });
  return kitPromise;
}

/** collection: every saved partner (the draft replaces its saved self) */
export async function buildModel(item, kit, { collection = [] } = {}) {
  const rest = collection.filter((p) => !item || p.slug !== item.slug);
  const items = item ? [...rest, item] : rest;
  const blobs = await checkBlobs(item ? [item.logo] : []);
  return { item, items, notes: blobs.notes, liveBlobs: blobs.alive, templates: kit.templates };
}

/** The draft partner's card in the framed page, to scroll it into view */
export function findFocus(doc, item) {
  if (!item?.name) return null;
  return [...doc.querySelectorAll('.sig-card__name, .champ-card__name, .ap-card__name')]
    .find((n) => n.textContent.trim() === item.name.trim())?.closest('.sig-card, .champ-card, .ap-card') || null;
}

export function patchPage(doc, win, model) {
  guardFrame(doc, win);
  setLiveBlobs(model.liveBlobs);
  const main = doc.querySelector('main');
  if (!main) return;
  const { take } = tools(doc, model.templates);
  const all = model.items.map(withDefaults);
  const sorted = [...all].sort((a, b) => (a.order || 0) - (b.order || 0) || a.name.localeCompare(b.name));
  const signature = sorted.filter((p) => p.level === 'signature');
  const champions = sorted.filter((p) => p.level === 'champion');
  const directory = sorted.filter((p) => p.level === 'builder' || p.level === 'friend');
  const n = all.length;

  // ── Counts ──
  const heroNum = main.querySelector('.hero-stat-num');
  if (heroNum) heroNum.textContent = `${n}+`;
  const ribbonNums = main.querySelectorAll('.ribbon-stat__number');
  if (ribbonNums[3]) ribbonNums[3].textContent = `${n}+`;
  const ctaText = main.querySelector('.partners-cta-content > p');
  if (ctaText) ctaText.textContent = `Join ${n}+ organizations building something bigger than any one of us.`;

  // Logo box: the image (with its name as a fallback) or the name alone
  const logoBox = (withLogo, plain, p, transforms, w, h, q) => {
    const box = (p.logo ? withLogo : plain).cloneNode(true);
    const img = box.querySelector('img');
    if (img) {
      img.src = cfRaw(p.logo, transforms);
      img.setAttribute('srcset', cfDensitySrcset(cfId(p.logo), w, h, { quality: q, fit: 'contain' }));
      img.alt = p.name;
    }
    box.querySelector('.logo-placeholder').textContent = p.name;
    return box;
  };
  const shell = (linkedProto, plainProto, p, className) => {
    const card = (linkable(p.website) ? linkedProto : plainProto).cloneNode(true);
    if (linkable(p.website)) card.setAttribute('href', p.website);
    card.className = className;
    return card;
  };

  // ── Signature ──
  const sigLinked = take('full', '.sig-card.sig-card--linked');
  const sigPlain = take('full', 'div.sig-card');
  const sigTagline = sigLinked.querySelector('.sig-card__tagline').cloneNode(true);
  const sigCard = (p) => {
    const card = shell(sigLinked, sigPlain, p, linkable(p.website) ? 'sig-card sig-card--linked' : 'sig-card');
    card.querySelector('.sig-card__logo').replaceWith(logoBox(sigLinked.querySelector('.sig-card__logo'), sigPlain.querySelector('.sig-card__logo'), p, 'w=400,h=120,fit=contain,q=85', 200, 60, 85));
    card.querySelector('.sig-card__name').textContent = p.name;
    const info = card.querySelector('.sig-card__info');
    info.querySelector('.sig-card__tagline')?.remove();
    if (p.tagline) { const t = sigTagline.cloneNode(true); t.textContent = p.tagline; info.append(t); }
    return card;
  };
  section(main, 'section.sig', signature, sigCard, '.sig-grid', () => take('full', 'section.sig'), (s) => main.querySelector('section.ribbon')?.before(s));

  // ── Champions ──
  const champLinked = take('full', '.champ-card.champ-card--linked');
  const champPlain = take('full', 'div.champ-card');
  const champCard = (p) => {
    const card = shell(champLinked, champPlain, p, linkable(p.website) ? 'champ-card champ-card--linked' : 'champ-card');
    card.querySelector('.champ-card__logo').replaceWith(logoBox(champLinked.querySelector('.champ-card__logo'), champPlain.querySelector('.champ-card__logo'), p, 'w=280,h=80,fit=contain,q=80', 140, 40, 80));
    card.querySelector('.champ-card__name').textContent = p.name;
    return card;
  };
  section(main, 'section.champ', champions, champCard, '.champ-grid', () => take('full', 'section.champ'), (s) => main.querySelector('section.ribbon')?.after(s));

  // ── Directory (builders + friends) ──
  const lead = main.querySelector('.all-lead');
  if (lead) lead.textContent = `${directory.length}+ organizations and individuals who donate time, materials, and funding: the full community behind every SOARD room.`;
  const counts = {
    all: directory.length,
    build: directory.filter((p) => p.category.includes('build')).length,
    design: directory.filter((p) => p.category.includes('design')).length,
    funding: directory.filter((p) => p.category.includes('funding')).length,
    community: directory.filter((p) => p.category.includes('community')).length,
  };
  main.querySelectorAll('.filter-tab').forEach((tab) => {
    const ct = tab.querySelector('.filter-tab__count');
    if (ct && tab.dataset.cat in counts) ct.textContent = String(counts[tab.dataset.cat]);
  });
  const apLinked = take('full', 'a.ap-card');
  const apPlain = take('full', 'div.ap-card');
  const badge = apLinked.querySelector('.ap-badge').cloneNode(true);
  const apTagline = apLinked.querySelector('.ap-card__tagline').cloneNode(true);
  const apCard = (p) => {
    const cls = ['ap-card', `ap-card--${p.level}`, linkable(p.website) && 'ap-card--linked', p.featured && 'ap-card--featured'].filter(Boolean).join(' ');
    const card = shell(apLinked, apPlain, p, cls);
    card.dataset.category = p.category.join(',');
    card.dataset.name = p.name.toLowerCase();
    card.dataset.level = p.level;
    card.querySelector('.ap-badge')?.remove();
    if (p.level === 'builder') card.prepend(badge.cloneNode(true));
    card.querySelector('.ap-card__logo').replaceWith(logoBox(apLinked.querySelector('.ap-card__logo'), apPlain.querySelector('.ap-card__logo'), p, 'w=180,h=64,fit=contain,q=75', 90, 32, 75));
    const name = card.querySelector('.ap-card__name');
    name.textContent = p.name;
    card.querySelector('.ap-card__tagline')?.remove();
    if (p.tagline) { const t = apTagline.cloneNode(true); t.textContent = p.tagline; name.after(t); }
    return card;
  };
  main.querySelector('.all-grid')?.replaceChildren(...directory.map(apCard));
}

/** Rebuild a level's section, adding it from the template or removing it as the build would */
function section(main, sel, list, card, gridSel, fromTemplate, place) {
  let s = main.querySelector(sel);
  if (!list.length) { s?.remove(); return; }
  if (!s) { s = fromTemplate(); place(s); }
  s.querySelector(gridSel).replaceChildren(...list.map(card));
}
