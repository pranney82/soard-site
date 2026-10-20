/**
 * advisory-preview.js — the People editor's Preview for an advisor: the real
 * Advisory Board page as it will be after the next publish, with this
 * person's unsaved edits. See page-preview.js for how the frame is patched.
 * The page lists every advisor, so the whole collection (as saved, plus this
 * draft) rebuilds the members section, which is there only while someone is
 * on the board. Mirrors src/pages/advisory-board.astro (with
 * src/utils/team.ts); scripts/test-page-preview.mjs rebuilds the page and
 * checks it against the real one.
 */
import { checkBlobs, setLiveBlobs, loadTemplates, tools, guardFrame, isLocal } from './page-preview.js';
import { normalizePerson, isListed, comparePeople, photoUrl, photoSrcset, photoLqip, hasProfile, profilePath, initials, advisoryTitle } from './team-shared.js';

export const pagePath = () => '/advisory-board/';
export const listPage = true;

let kitPromise = null;
export function loadKit() {
  kitPromise ??= loadTemplates('advisory', ['full']).then((templates) => ({ templates }));
  kitPromise.catch(() => { kitPromise = null; });
  return kitPromise;
}

/** collection: every saved person (the draft replaces its saved self) */
export async function buildModel(item, kit, { collection = [] } = {}) {
  const rest = collection.filter((p) => !item || p.slug !== item.slug);
  const items = item ? [...rest, item] : rest;
  const blobs = await checkBlobs(item ? [item.photo] : []);
  return { item, items, notes: blobs.notes, liveBlobs: blobs.alive, templates: kit.templates };
}

/** The draft person's card in the framed page, to scroll it into view */
export function findFocus(doc, item) {
  if (!item?.name) return null;
  const name = normalizePerson(item).name.trim();
  return [...doc.querySelectorAll('.abm-name')].find((n) => n.textContent.trim() === name)?.closest('.abm-card') || null;
}

// A photo still uploading is a blob: URL in this tab; show it as-is
const src = (p, px) => (isLocal(p.photo) ? p.photo : photoUrl(p, px));
const srcset = (p, widths) => (isLocal(p.photo) ? null : photoSrcset(p, widths));
const lqip = (p) => (isLocal(p.photo) ? p.photo : photoLqip(p));

export function patchPage(doc, win, model) {
  guardFrame(doc, win);
  setLiveBlobs(model.liveBlobs);
  const main = doc.querySelector('main');
  if (!main) return;
  const { take, attr } = tools(doc, model.templates);
  const advisors = model.items.map((x) => ({ ...normalizePerson(x), slug: x.slug }))
    .filter((p) => p.group === 'advisory' && isListed(p)).sort(comparePeople);

  let section = main.querySelector('#members');
  if (!advisors.length) { section?.remove(); return; }
  if (!section) { section = take('full', '#members'); main.querySelector('#the-role')?.before(section); }

  // Each card from its parts, in the page's order
  const cardProto = take('full', '.abm-card');
  const photoWith = take('full', '.abm-photo[style]');
  const photoPlain = take('full', '.abm-photo:not([style])');
  const memorialProto = take('full', '.abm-memorial');
  const nameProto = take('full', '.abm-card:not(.has-profile) .abm-name');
  const linkProto = take('full', '.abm-link');
  const titleProto = take('full', '.abm-title');
  const orgProto = take('full', '.abm-org');
  const moreProto = take('full', '.abm-more');
  const card = (p, i) => {
    const li = cardProto.cloneNode(false);
    // Scoped styles ride on data-astro-cid-* attributes, so the class is just these
    li.setAttribute('class', ['abm-card', p.status === 'memorial' && 'abm-card--memorial', hasProfile(p) && 'has-profile'].filter(Boolean).join(' '));
    li.dataset.delay = String(i % 4);
    const box = (p.photo ? photoWith : photoPlain).cloneNode(true);
    if (p.photo) {
      box.setAttribute('style', `background-image:url(${lqip(p)})`);
      const img = box.querySelector('img');
      img.setAttribute('src', src(p, 224));
      attr(img, 'srcset', srcset(p, [112, 168, 224, 336]));
      img.setAttribute('alt', p.status === 'memorial' ? `In memory of ${p.name}` : p.name);
    } else box.querySelector('.abm-initials').textContent = initials(p.name);
    const parts = [box];
    if (p.status === 'memorial') parts.push(memorialProto.cloneNode(true));
    const name = nameProto.cloneNode(false);
    if (hasProfile(p)) {
      const a = linkProto.cloneNode(false);
      a.setAttribute('href', profilePath(p.slug));
      a.textContent = p.name;
      name.append(a);
    } else name.textContent = p.name;
    parts.push(name);
    const title = advisoryTitle(p);
    if (title) { const t = titleProto.cloneNode(false); t.textContent = title; parts.push(t); }
    if (p.organization) { const o = orgProto.cloneNode(false); o.textContent = p.organization; parts.push(o); }
    if (hasProfile(p)) parts.push(moreProto.cloneNode(true));
    li.replaceChildren(...parts);
    return li;
  };
  section.querySelector('.abm-grid').replaceChildren(...advisors.map(card));
}
