/**
 * team-preview.js — the People editor's Preview: the real Leadership page as
 * it will be after the next publish, with this person's unsaved edits. See
 * page-preview.js for how the frame is patched. The page lists everyone, so
 * the whole collection (as saved, plus this draft) rebuilds the board grid,
 * the founders row and the team grid. Mirrors src/pages/about/leadership.astro
 * (with src/utils/team.ts); scripts/test-page-preview.mjs rebuilds the whole
 * page and checks it against the real one.
 */
import { checkBlobs, setLiveBlobs, loadTemplates, tools, guardFrame, cfUrl, isLocal } from './page-preview.js';
import { normalizePerson, isListed, comparePeople, photoUrl, photoSrcset, photoLqip } from './team-shared.js';

export const pagePath = () => '/about/leadership/';
export const listPage = true;

const PLACEHOLDER = 'brand-logo-circle-display';

let kitPromise = null;
export function loadKit() {
  kitPromise ??= loadTemplates('team', ['full']).then((templates) => ({ templates }));
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
  return [...doc.querySelectorAll('.board-name, .founder-name, .member-name')]
    .find((n) => n.textContent.trim() === name)?.closest('.board-card, .founder-card, .member-card') || null;
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
  const people = model.items.map(normalizePerson).filter(isListed);
  const founders = people.filter((p) => p.group === 'team' && p.role === 'founder').sort(comparePeople);
  const staff = people.filter((p) => p.group === 'team' && p.role !== 'founder').sort(comparePeople);
  const board = people.filter((p) => p.group === 'board').sort(comparePeople);

  const placeholderSrc = cfUrl(PLACEHOLDER, { w: 256 });
  // The photo box: the photo with its blurred stand-in, or the logo placeholder
  const photoBox = (withPhoto, plain, p, px, widths) => {
    const box = (p.photo ? withPhoto : plain).cloneNode(true);
    if (p.photo) {
      box.setAttribute('style', `background-image:url(${lqip(p)});background-size:cover;background-position:center`);
      const img = box.querySelector('img');
      img.setAttribute('src', src(p, px));
      attr(img, 'srcset', srcset(p, widths));
    } else {
      box.querySelector('.placeholder-icon')?.setAttribute('src', placeholderSrc);
    }
    return box;
  };
  const textOrDrop = (el, text) => { if (!el) return; if (text) el.textContent = text; else el.remove(); };

  // ── Board ──
  const boardPhoto = take('full', '.board-card:not(.board-card--memorial) .board-photo[style]');
  const boardPlain = take('full', '.board-card .board-photo:not([style])');
  const boardProto = take('full', '.board-card:not(.board-card--memorial):has(.board-org)');
  const memorialLabel = take('full', '.board-card--memorial .board-memorial');
  const boardCard = (p, i) => {
    const card = boardProto.cloneNode(true);
    // Scoped styles ride on data-astro-cid-* attributes, so the class is just these
    card.setAttribute('class', p.status === 'memorial' ? 'board-card board-card--memorial' : 'board-card');
    card.dataset.delay = String(Math.min(i, 4));
    const box = photoBox(boardPhoto, boardPlain, p, 200, [140, 200, 280, 400]);
    if (p.photo) box.querySelector('img').setAttribute('alt', p.status === 'memorial' ? `In memory of ${p.name}, ${p.title}` : `${p.name}, ${p.title}`);
    card.querySelector('.board-photo').replaceWith(box);
    const name = card.querySelector('.board-name');
    if (p.status === 'memorial') name.before(memorialLabel.cloneNode(true));
    name.textContent = p.name;
    card.querySelector('.board-title').textContent = p.title;
    textOrDrop(card.querySelector('.board-org'), p.organization);
    return card;
  };
  main.querySelector('.board-grid')?.replaceChildren(...board.map(boardCard));

  // ── Founders ──
  const founderProto = take('full', '.founder-card:has(.founder-photo[style])');
  const founderPlain = take('full', '.founder-card .founder-photo:not([style])');
  const founderCard = (p, i) => {
    const card = founderProto.cloneNode(true);
    card.dataset.delay = String(i);
    const box = photoBox(founderProto.querySelector('.founder-photo'), founderPlain, p, 220, [160, 220, 320, 440]);
    if (p.photo) box.querySelector('img').setAttribute('alt', `${p.name}, ${p.title}`);
    card.querySelector('.founder-photo').replaceWith(box);
    card.querySelector('.founder-name').textContent = p.name;
    card.querySelector('.founder-title').textContent = p.title.replace(/Co-Founder\/?/i, '').trim();
    return card;
  };
  main.querySelector('.founders-row')?.replaceChildren(...founders.map(founderCard));

  // ── Team ──
  const memberProto = take('full', '.member-card:has(.member-org):has(.member-photo[style])');
  const memberPlain = take('full', '.member-card .member-photo:not([style])');
  const memberCard = (p, i) => {
    const card = memberProto.cloneNode(true);
    card.dataset.delay = String(Math.min(i, 3));
    const box = photoBox(memberProto.querySelector('.member-photo'), memberPlain, p, 220, [160, 220, 320, 440]);
    if (p.photo) box.querySelector('img').setAttribute('alt', `${p.name}, ${p.title}`);
    card.querySelector('.member-photo').replaceWith(box);
    card.querySelector('.member-name').textContent = p.name;
    card.querySelector('.member-title').textContent = p.title;
    textOrDrop(card.querySelector('.member-org'), p.organization);
    return card;
  };
  main.querySelector('.team-grid')?.replaceChildren(...staff.map(memberCard));
}
