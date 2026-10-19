/**
 * person-preview.js — the People editor's profile Preview: someone's page at
 * /about/leadership/<slug>/ as it will be after the next publish, with their
 * unsaved edits. See page-preview.js for how the frame is patched. Mirrors
 * src/pages/about/leadership/[slug].astro; scripts/test-page-preview.mjs
 * rebuilds each template variant inside another and checks it.
 */
import { checkBlobs, setLiveBlobs, loadTemplates, tools, guardFrame, cfUrl, isLocal } from './page-preview.js';
import {
  normalizePerson, hasProfile, comparePeople, profilePath, bioParagraphs,
  portraitUrl, portraitSrcset, photoUrl, photoSrcset, photoLqip,
} from './team-shared.js';

export const pagePath = (slug) => profilePath(slug);
export const hasPage = (item) => hasProfile(normalizePerson(item || {}));
export const noPageNote = 'They get a profile page once they have a bio (and are shown on the Leadership page).';
// Before anyone has a profile on the site, the preview builds in the template page
export const fallbackPath = () => '/admin/person-template/full/';

const PLACEHOLDER = 'brand-logo-circle-display';

let kitPromise = null;
export function loadKit() {
  kitPromise ??= loadTemplates('person', ['full', 'plain']).then((templates) => ({ templates }));
  kitPromise.catch(() => { kitPromise = null; });
  return kitPromise;
}

/** collection: every saved person (the draft replaces its saved self); partners: for the company logo */
export async function buildModel(item, kit, { collection = [], partners = [] } = {}) {
  const rest = collection.filter((p) => p.slug !== item.slug);
  const blobs = await checkBlobs([item.photo]);
  return { item, people: [...rest, item], partners, notes: blobs.notes, liveBlobs: blobs.alive, templates: kit.templates };
}

export function patchPage(doc, win, model) {
  guardFrame(doc, win);
  setLiveBlobs(model.liveBlobs);
  const main = doc.querySelector('main');
  if (!main) return;
  const { take, attr } = tools(doc, model.templates);
  const p = normalizePerson(model.item);
  const slug = model.item.slug;
  const board = p.group === 'board';
  const memorial = p.status === 'memorial';
  const first = p.name.split(/\s+/)[0];
  const nameParts = p.name.trim().split(/\s+/);
  const lastName = nameParts.length > 1 ? nameParts.pop() : '';
  const firstNames = nameParts.join(' ');
  const shownTitle = p.role === 'founder' ? p.title.replace(/Co-Founder\/?/i, '').trim() || p.title : p.title;
  const eyebrow = memorial ? 'In memoriam' : board ? 'Board of Directors' : p.role === 'founder' ? 'Co-Founder' : 'Our Team';
  const partner = p.partner ? model.partners.find((x) => (x.slug || x.id) === p.partner) : null;
  const since = typeof p.since === 'number' ? p.since : null;
  const until = typeof p.until === 'number' ? p.until : null;
  const groupLabel = board ? 'board' : 'team';
  const backHref = `/about/leadership/#${board ? 'board' : 'our-team'}`;
  const local = isLocal(p.photo);

  // ── Hero ──
  const hero = take('full', 'section.hero');
  hero.setAttribute('class', memorial ? 'hero hero--memorial' : 'hero');
  hero.querySelector('.hero-eyebrow').textContent = eyebrow;
  const h1 = hero.querySelector('h1');
  const em = h1.querySelector('em');
  h1.replaceChildren(doc.createTextNode(`${firstNames}${lastName ? ' ' : ''}`));
  if (lastName) { em.textContent = lastName; h1.append(em); }
  hero.querySelector('.hero-role').textContent = shownTitle;
  const org = hero.querySelector('.hero-org');
  if (p.organization) org.textContent = p.organization; else org.remove();
  const ctas = hero.querySelectorAll('.hero-ctas a');
  ctas[0].setAttribute('href', backHref);
  ctas[0].textContent = `Meet the ${board ? 'Board' : 'Team'}`;
  if (p.linkedin && !memorial) ctas[1].setAttribute('href', p.linkedin); else ctas[1].remove();
  const frame = hero.querySelector('.hero-frame');
  if (p.photo) {
    const box = frame.querySelector('.hero-photo');
    box.setAttribute('style', `background-image:url('${local ? p.photo : photoLqip(p)}')`);
    const img = box.querySelector('img');
    img.setAttribute('src', local ? p.photo : portraitUrl(p, 640));
    attr(img, 'srcset', local ? null : portraitSrcset(p, [400, 640, 800, 1024]));
    img.setAttribute('alt', memorial ? `In memory of ${p.name}` : p.name);
  } else {
    const plain = take('plain', '.hero-photo');
    plain.querySelector('img').setAttribute('src', cfUrl(PLACEHOLDER, { w: 256 }));
    frame.querySelector('.hero-photo').replaceWith(plain);
  }
  const logo = frame.querySelector('.hero-logo');
  if (partner?.logo) {
    logo.setAttribute('aria-label', `${partner.name}, a SOARD partner`);
    logo.querySelector('img').setAttribute('src', cfUrl(partner.logo, { w: 240, h: 160, fit: 'contain' }));
  } else logo.remove();
  const stat = hero.querySelector('.hero-stat');
  if (since) {
    stat.querySelector('.hero-stat-num').textContent = memorial && until ? `${since}–${until}` : String(since);
    stat.querySelector('.hero-stat-label').innerHTML = memorial ? (board ? 'served on<br/>the board' : 'with<br/>SOARD') : board ? 'on the board<br/>since' : 'with SOARD<br/>since';
  } else stat.remove();

  // ── Bio + details ──
  const bio = take('full', 'section.bio');
  bio.querySelector('#bio-heading').textContent = `About ${first}`;
  const text = bio.querySelector('.bio-text');
  const paraProto = text.querySelector('p');
  text.querySelectorAll('p').forEach((n) => n.remove());
  for (const para of bioParagraphs(p.bio)) { const n = paraProto.cloneNode(true); n.textContent = para; text.append(n); }
  const aside = bio.querySelector('aside.facts');
  aside.setAttribute('aria-label', `${p.name} at a glance`);
  const factBy = Object.fromEntries([...aside.querySelectorAll('.fact')].map((f) => [f.querySelector('dt').textContent.trim(), f]));
  const fact = (key, dt) => { const f = factBy[key].cloneNode(true); f.querySelector('dt').textContent = dt; return f; };
  const facts = [];
  const role = fact('Role', 'Role');
  role.querySelector('dd').textContent = `${shownTitle}${p.role === 'founder' ? ', Co-Founder' : ''}`;
  facts.push(role);
  if (p.organization) {
    const f = fact('Company', board ? 'Company' : 'Organization');
    const dd = f.querySelector('dd');
    const link = dd.querySelector('.fact-partner');
    dd.replaceChildren(doc.createTextNode(p.organization));
    if (partner) dd.append(link);
    facts.push(f);
  }
  if (since) {
    const f = fact('On the board', board ? 'On the board' : 'With SOARD');
    f.querySelector('dd').textContent = memorial && until ? `${since} to ${until}` : `Since ${since}`;
    facts.push(f);
  }
  if (board && p.committees?.length) {
    const f = fact('Committees', p.committees.length === 1 ? 'Committee' : 'Committees');
    const ul = f.querySelector('.fact-chips');
    const li = ul.querySelector('li');
    ul.replaceChildren(...p.committees.map((c) => { const n = li.cloneNode(true); n.textContent = c; return n; }));
    facts.push(f);
  }
  if (p.linkedin && !memorial) {
    const f = fact('LinkedIn', 'LinkedIn');
    f.querySelector('dd a').setAttribute('href', p.linkedin);
    facts.push(f);
  }
  aside.querySelector('dl').replaceChildren(...facts);

  // ── In their words ──
  let words = null;
  if (p.quote && p.quote.trim()) {
    words = take('full', 'section.words');
    words.setAttribute('aria-label', memorial ? 'In their words' : `Why ${first} serves`);
    words.querySelector('.words-label').textContent = memorial ? 'In their words' : 'Why I serve';
    words.querySelector('blockquote p').textContent = p.quote.trim();
    words.querySelector('figcaption').textContent = p.name;
  }

  // ── More people ──
  let more = null;
  const others = model.people.map((x) => ({ slug: x.slug, data: normalizePerson(x) }))
    .filter((o) => o.slug !== slug && o.data.group === p.group && hasProfile(o.data))
    .sort((a, b) => comparePeople(a.data, b.data)).slice(0, 4);
  if (others.length) {
    more = take('full', 'section.more');
    more.querySelector('#more-heading').textContent = `More of our ${groupLabel}`;
    const all = more.querySelector('.more-all');
    all.setAttribute('href', backHref);
    all.firstChild.nodeValue = `See the whole ${groupLabel} `;
    const withPhoto = more.querySelector('.more-card:has(img)');
    const without = more.querySelector('.more-card:not(:has(img))');
    more.querySelector('.more-grid').replaceChildren(...others.map((o) => {
      const card = (o.data.photo ? withPhoto : without).cloneNode(true);
      if (o.data.photo) {
        card.querySelector('.more-photo').setAttribute('style', `background-image:url(${photoLqip(o.data)});background-size:cover;background-position:center`);
        const img = card.querySelector('img');
        img.setAttribute('src', photoUrl(o.data, 160));
        img.setAttribute('srcset', photoSrcset(o.data, [120, 160, 240, 320]));
      }
      const a = card.querySelector('.more-name');
      a.setAttribute('href', profilePath(o.slug));
      a.textContent = o.data.name;
      card.querySelector('.more-title').textContent = o.data.role === 'founder' ? o.data.title.replace(/Co-Founder\/?/i, '').trim() || o.data.title : o.data.title;
      return card;
    }));
  }

  // The page's sections in order, before the closing call to action
  ['section.hero', 'section.bio', 'section.words', 'section.more'].forEach((sel) => main.querySelector(sel)?.remove());
  const cta = main.querySelector('section.cta');
  for (const s of [hero, bio, words, more]) if (s) cta.before(s);
}
