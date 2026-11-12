/**
 * live-design.ts — the room's design on a reveal's live page
 * ==========================================================
 * The page says which kid it's showing and what moment it's in (setKid: its
 * own kid, or on /live/ the one being revealed); this asks /api/reveal-design
 * for them, draws the room as it was, the plan and the look once it's open
 * (an hour before the reveal), and asks again: when the moment changes
 * (starting soon, live, replay), at the moment it opens, and every few
 * minutes after, so a change in Admin → Kids shows up on its own.
 *
 * Two places, the same pictures:
 *   - The strip beside the video (LiveDesignRail.astro), during the watch
 *     party: the hero gets data-design while there's something to show, and
 *     its CSS makes room in the frame. The server marks the hero the same way
 *     at first paint, so the strip's place is there before the pictures.
 *   - "The design" under the hero (LiveDesign.astro), in three parts, each
 *     shown only when it has something:
 *       The room today   before photos ("The room before" once the reveal has started)
 *       The plan         the as-built and proposed drawings, side by side
 *       The look         the design boards
 *     Every picture carries its badge, on it, in each place (the section, the
 *     strip, the viewer): BEFORE on the room's photos, EXISTING and PROPOSED
 *     on the plans (Peter, Nov 11 2026).
 *     Each card keeps its picture's shape before the picture arrives (read off
 *     a tiny copy first), so nothing below it jumps.
 * A picture that can't load leaves both, and the viewer.
 *
 * The viewer: any picture opens large. During the watch party the reveal
 * keeps playing in sight (Peter, Nov 9 2026: the design has to be seen
 * during the reveal): on a laptop the viewer opens beside the video, over
 * the messages, and the strip stays usable and marks the picture being
 * looked at; on a phone it fills the screen with the video held in a small
 * player in its top corner (a tap on it goes back). Otherwise it's a plain
 * full-screen viewer. The page holds still behind it either way.
 */
import { fetchDesign, slideSrc, designSignature, type DesignSlide } from './reveal-design-client';
import { holdPlace } from './hold-place';
import type { Stage } from './live-stage';
import { DESK } from './live-media';

const ASK_OPEN_MS = 3 * 60_000;
const ASK_CLOSED_MS = 10 * 60_000;
const ASK_FAILED_MS = 2 * 60_000;
/** The viewer opens beside the video only with at least this much room to its left */
const SIDE_MIN_W = 420;
// The rest of /live/ writes names with a straight apostrophe ("Don't miss Dylan's reveal")
const straight = (s: string) => s.replace(/’/g, "'");
const possessive = (name: string) => (/s$/i.test(name) ? `${name}'` : `${name}'s`);

/** height ÷ width of a slide's picture as it will show, from a tiny copy of the same picture */
function shapeOf(s: DesignSlide): Promise<number | null> {
  return slideSrc(s, 96).then((src) => new Promise((done) => {
    if (!src) { done(null); return; }
    const img = new Image();
    img.onload = () => done(img.naturalWidth ? img.naturalHeight / img.naturalWidth : null);
    img.onerror = () => done(null);
    img.src = src;
  }));
}

interface Options {
  /** The live hero: data-design on it gives the strip its place during the watch party (data-party) */
  hero?: HTMLElement | null;
  /** The strip beside the video (LiveDesignRail.astro) */
  rail?: HTMLElement | null;
  /** The hero's frame, video and strip: on a laptop the viewer opens to its left */
  frame?: HTMLElement | null;
  /** The video: held in a small player while the viewer covers a phone's screen */
  stage?: Stage | null;
}

type ViewerMode = 'modal' | 'side' | 'pinned';

export function createLiveDesign(section: HTMLElement, opts: Options = {}) {
  const { hero = null, rail = null, frame = null, stage = null } = opts;
  const parts = section.querySelector<HTMLElement>('[data-ldz="parts"]')!;
  const nameEl = section.querySelector<HTMLElement>('[data-ldz="name"]');
  const railName = rail?.querySelector<HTMLElement>('[data-hds="name"]') || null;
  const railScroll = rail?.querySelector<HTMLElement>('[data-hds="scroll"]') || null;
  const viewer = document.querySelector<HTMLDialogElement>('[data-ldz-viewer]');
  const laptop = matchMedia(DESK);
  let kid = '';
  let moment = '';
  let sig = '';
  let slides: DesignSlide[] = [];
  let askTimer: ReturnType<typeof setTimeout> | undefined;
  let alive = true;
  let asking: AbortController | null = null;
  // Every card showing a slide (in the section and the strip), and each part's own count, for a picture that fails
  const cards = new Map<DesignSlide, HTMLElement[]>();
  const railCards = new Map<DesignSlide, HTMLButtonElement>();
  let recounts: (() => void)[] = [];

  /** The strip's place in the hero: for this kid, while there's a picture to show */
  function mark(on: boolean) {
    if (!hero) return;
    const want = on && kid ? kid : '';
    if ((hero.dataset.design || '') === want) return;
    holdPlace(() => { if (want) hero.dataset.design = want; else delete hero.dataset.design; });
  }

  /** Nothing to show. keepPlace: the strip's place stays (the server gave it for this kid; the pictures are coming) */
  function hide(keepPlace = false) {
    if (viewer?.open) viewer.close();
    holdPlace(() => {
      section.hidden = true;
      parts.replaceChildren();
      railScroll?.replaceChildren();
    });
    cards.clear();
    railCards.clear();
    recounts = [];
    sig = '';
    slides = [];
    if (!keepPlace) mark(false);
  }

  function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  }

  const track = (s: DesignSlide, li: HTMLElement) => { const l = cards.get(s); if (l) l.push(li); else cards.set(s, [li]); };

  /** A picture that can't load leaves the viewer, every card of it, and any part it was the last of */
  function drop(s: DesignSlide) {
    if (!slides.includes(s)) return;
    slides = slides.filter((y) => y !== s);
    const gone = cards.get(s) || [];
    cards.delete(s);
    railCards.delete(s);
    if (shown === s && viewer?.open) {
      if (slides.length) void show(slides[0]); else viewer.close();
    }
    holdPlace(() => {
      for (const li of gone) li.remove();
      for (const r of recounts) r();
      if (!slides.length) { section.hidden = true; mark(false); }
    });
  }

  /** What a picture is, on it ('Before', 'Existing', 'Proposed'): the same badge in the section, the strip and the viewer */
  const badge = (s: DesignSlide, cls: string) => (s.badge ? el('span', `${cls} ${cls}--${s.kind}`, s.badge) : null);

  /** One picture card in the section, opening the viewer at its place among the pictures that loaded */
  function item(s: DesignSlide, width: number, label: string) {
    const li = el('li');
    const b = el('button', `ldz-item${s.kind === 'before' ? '' : ' ldz-paper'}`);
    b.type = 'button';
    b.setAttribute('aria-label', `Enlarge: ${s.badge ? `${s.badge}, ` : ''}${label}`);
    const tag = badge(s, 'ldz-badge');
    if (tag) b.append(tag);
    const pic = el('span', 'ldz-pic');
    const img = el('img');
    img.alt = straight(s.alt);
    img.decoding = 'async';
    pic.append(img);
    b.append(pic);
    const gone = () => drop(s);
    img.addEventListener('error', gone, { once: true });
    // The card takes its picture's shape first (photos are always 4:3), then the picture comes
    const shape = s.kind === 'before' ? Promise.resolve(0.75) : shapeOf(s);
    void shape.then((r) => {
      if (!cards.get(s)?.includes(li)) return; // redrawn or dropped meanwhile
      if (!r) { gone(); return; }
      if (s.kind !== 'before') pic.style.aspectRatio = `1 / ${r.toFixed(4)}`;
      return slideSrc(s, width).then((src) => { if (src) img.src = src; else gone(); });
    });
    b.addEventListener('click', () => open(s));
    li.append(b);
    track(s, li);
    return li;
  }

  function part(title: string, list: HTMLElement, note = '') {
    const wrap = el('div', 'ldz-part');
    const head = el('div', 'ldz-part__head');
    head.append(el('h3', 'ldz-part__title', title));
    const noteEl = el('p', 'ldz-part__note', note);
    noteEl.hidden = !note;
    head.append(noteEl);
    wrap.append(head, list);
    return { wrap, noteEl };
  }

  /** One picture in the strip beside the video: a small card with its badge */
  function railItem(s: DesignSlide, label: string) {
    const li = el('li');
    const b = el('button', `hds-item${s.kind === 'before' ? '' : ' hds-paper'}`);
    b.type = 'button';
    b.setAttribute('aria-label', `See it big: ${s.badge ? `${s.badge}, ` : ''}${label}`);
    const img = el('img');
    img.alt = '';
    img.decoding = 'async';
    b.append(img);
    const tag = badge(s, 'hds-tag');
    if (tag) b.append(tag);
    img.addEventListener('error', () => drop(s), { once: true });
    void slideSrc(s, 320).then((src) => { if (!cards.get(s)?.includes(li)) return; if (src) img.src = src; else drop(s); });
    b.addEventListener('click', () => open(s));
    li.append(b);
    track(s, li);
    railCards.set(s, b);
    return li;
  }

  function drawRail(next: DesignSlide[]) {
    if (!railScroll) return;
    const groups: [string, DesignSlide[]][] = [
      ['Before', next.filter((x) => x.kind === 'before')],
      ['The plan', next.filter((x) => x.kind === 'as-built' || x.kind === 'proposed')],
      ['The look', next.filter((x) => x.kind === 'board')],
    ];
    const out: HTMLElement[] = [];
    for (const [title, list] of groups) {
      if (!list.length) continue;
      const wrap = el('div', 'hds-group');
      const ul = el('ul', 'hds-list');
      ul.setAttribute('aria-label', title);
      wrap.append(el('p', 'hds-label', title), ul);
      ul.append(...list.map((x, i) => {
        const caption = straight(x.caption);
        const label = x.kind === 'before' ? `photo ${i + 1} of ${list.length}, ${caption}` : caption;
        return railItem(x, label);
      }));
      recounts.push(() => { if (!ul.children.length) wrap.remove(); });
      out.push(wrap);
    }
    railScroll.replaceChildren(...out);
    railScroll.scrollTo({ top: 0, left: 0 });
  }

  function draw(name: string, next: DesignSlide[], isAfter: boolean) {
    const s = designSignature(next) + (isAfter ? '|after' : '');
    if (s === sig) return;
    if (!next.length) { hide(); return; }
    // Someone looking at a picture keeps it when the design is redrawn (the reveal starting turns "today" into "before")
    const looking = viewer?.open && shown ? `${shown.kind}|${shown.url}` : '';
    sig = s;
    slides = next.slice();
    cards.clear();
    railCards.clear();
    recounts = [];
    if (nameEl) nameEl.textContent = name ? possessive(name) : 'The';
    if (railName) railName.textContent = name ? `${possessive(name)} design` : 'The design';
    const befores = next.filter((x) => x.kind === 'before');
    const plans = next.filter((x) => x.kind === 'as-built' || x.kind === 'proposed');
    const boards = next.filter((x) => x.kind === 'board');
    const out: HTMLElement[] = [];
    if (befores.length) {
      const ul = el('ul', 'ldz-grid ldz-grid--photos');
      const { wrap } = part(isAfter ? 'The room before' : 'The room today', ul);
      ul.append(...befores.map((x, i) => item(x, befores.length === 1 ? 1600 : 900, `photo ${i + 1} of ${befores.length}`)));
      const recount = () => { ul.dataset.n = String(ul.children.length); if (!ul.children.length) wrap.remove(); };
      recount();
      recounts.push(recount);
      out.push(wrap);
    }
    if (plans.length) {
      const ul = el('ul', 'ldz-grid');
      const both = 'Before and after, from above';
      const { wrap, noteEl } = part('The plan', ul);
      const recount = () => {
        const left = slides.filter((y) => plans.includes(y));
        ul.className = `ldz-grid ${left.length === 1 ? 'ldz-grid--one' : 'ldz-grid--plans'}`;
        const pair = left.some((y) => y.kind === 'as-built') && left.some((y) => y.kind === 'proposed');
        noteEl.textContent = pair ? both : '';
        noteEl.hidden = !pair;
        if (!ul.children.length) wrap.remove();
      };
      // The badge on the drawing says which plan it is; its caption sits under it, as a board's does
      ul.append(...plans.map((x) => {
        const li = item(x, plans.length === 1 ? 1800 : 1200, straight(x.caption));
        li.append(el('p', 'ldz-cap', straight(x.caption)));
        return li;
      }));
      recount();
      recounts.push(recount);
      out.push(wrap);
    }
    if (boards.length) {
      const ul = el('ul', `ldz-grid ldz-boards ${boards.length === 1 ? 'ldz-grid--one' : 'ldz-grid--boards'}`);
      const { wrap } = part('The look', ul);
      ul.append(...boards.map((x) => {
        const li = item(x, boards.length === 1 ? 1800 : 1200, straight(x.caption));
        // A board's caption sits under it, outside the picture
        li.append(el('p', 'ldz-cap', straight(x.caption)));
        return li;
      }));
      recounts.push(() => { if (!ul.children.length) wrap.remove(); });
      out.push(wrap);
    }
    holdPlace(() => {
      parts.replaceChildren(...out);
      drawRail(next);
      section.hidden = false;
    });
    mark(true);
    if (looking) {
      const again = slides.find((x) => `${x.kind}|${x.url}` === looking);
      if (again) void show(again); else viewer?.close();
    }
  }

  async function ask() {
    clearTimeout(askTimer);
    if (!alive || !kid) return;
    asking?.abort();
    asking = new AbortController();
    const forKid = kid;
    const d = await fetchDesign(forKid, asking.signal);
    if (!alive || forKid !== kid) return;
    let wait = ASK_FAILED_MS;
    if (d) {
      if (d.open) { draw(d.name || '', d.slides || [], !!d.after); wait = ASK_OPEN_MS; } else {
        hide();
        const until = d.opensAt ? Date.parse(d.opensAt) - Date.now() : NaN;
        wait = Number.isFinite(until) ? Math.min(ASK_CLOSED_MS, Math.max(1500, until + 1500)) : ASK_CLOSED_MS;
      }
    } else if (!slides.length) {
      // No answer and nothing drawn: a place kept for the pictures shouldn't stand empty
      mark(false);
    }
    askTimer = setTimeout(ask, wait);
  }

  // ── Viewer ──
  let shown: DesignSlide | null = null;
  let mode: ViewerMode = 'modal';
  const vq = <T extends Element>(k: string) => viewer?.querySelector<T>(`[data-ldv="${k}"]`) || null;
  let opener: HTMLElement | null = null;
  let held: { y: number; overflow: string } | null = null;

  /** The strip marks the picture open in the viewer, and scrolls it into its own view (never the page) */
  function markShown(s: DesignSlide | null) {
    for (const [x, b] of railCards) {
      if (x === s) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current');
    }
    const b = s ? railCards.get(s) : null;
    if (!b || !railScroll) return;
    const r = b.getBoundingClientRect();
    const c = railScroll.getBoundingClientRect();
    const behavior = (matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth') as ScrollBehavior;
    if (r.top < c.top) railScroll.scrollBy({ top: r.top - c.top - 6, behavior });
    else if (r.bottom > c.bottom) railScroll.scrollBy({ top: r.bottom - c.bottom + 6, behavior });
    if (r.left < c.left) railScroll.scrollBy({ left: r.left - c.left - 6, behavior });
    else if (r.right > c.right) railScroll.scrollBy({ left: r.right - c.right + 6, behavior });
  }

  async function show(s: DesignSlide) {
    const img = vq<HTMLImageElement>('img');
    if (!img) return;
    shown = s;
    const i = slides.indexOf(s);
    // The badge leads the caption ("BEFORE  Dylan's room today", "PROPOSED  The new floor plan"); a board keeps its kicker
    const k = vq<HTMLElement>('kicker'); if (k) { k.textContent = s.badge || s.kicker; k.dataset.kind = s.badge ? s.kind : ''; }
    const c = vq<HTMLElement>('caption'); if (c) c.textContent = straight(s.caption);
    const n = vq<HTMLElement>('count'); if (n) n.textContent = slides.length > 1 ? `${i + 1} of ${slides.length}` : '';
    img.alt = straight(s.alt);
    for (const k2 of ['prev', 'next']) { const b = vq<HTMLButtonElement>(k2); if (b) b.hidden = slides.length < 2; }
    markShown(s);
    const src = await slideSrc(s, Math.min(2400, Math.round(Math.max(innerWidth, innerHeight) * (devicePixelRatio || 1))));
    if (shown === s && src) img.src = src;
  }

  /** How the viewer opens now: beside the video (laptop), over a phone with the video kept small, or alone */
  function modeNow(): ViewerMode {
    if (!hero?.hasAttribute('data-party')) return 'modal';
    if (laptop.matches) return frame && sideWidth() >= SIDE_MIN_W ? 'side' : 'modal';
    return stage ? 'pinned' : 'modal';
  }
  // From the screen's left edge to the frame (the video and its strip), with a margin each side
  const sideWidth = () => Math.floor((frame?.getBoundingClientRect().left || 0) - 24);
  const fitSide = () => { if (viewer && mode === 'side') viewer.style.setProperty('--ldv-w', `${Math.max(SIDE_MIN_W, sideWidth())}px`); };
  // On a phone the small video's shape decides the room the viewer leaves it, and that shape can change while the viewer
  // is open (a phone turned sideways gets the landscape starting-soon screen), so it's followed, not read once
  const wideNow = () => mode === 'pinned' && hero?.dataset.orientation === 'landscape';
  const fitPin = () => { if (viewer?.open) viewer.classList.toggle('ldv--wide', wideNow()); };
  const shapeWatch = hero ? new MutationObserver(fitPin) : null;
  // An iPad turned (or a window resized) across the laptop/phone line while it's open: it opens again, on the same
  // picture, in the way that fits now (beside the video, or over it with the video pinned)
  const onLayout = () => {
    if (!viewer?.open || !shown) return;
    if (modeNow() === mode) { fitSide(); return; }
    const again = shown;
    viewer.addEventListener('close', () => { if (alive) open(again); }, { once: true });
    viewer.close();
  };
  laptop.addEventListener('change', onLayout);
  if (hero) shapeWatch?.observe(hero, { attributes: true, attributeFilter: ['data-orientation'] });

  function open(s: DesignSlide) {
    if (!viewer || !slides.includes(s)) return;
    if (viewer.open) { void show(s); return; }
    opener = document.activeElement as HTMLElement | null;
    mode = modeNow();
    viewer.classList.toggle('ldv--side', mode === 'side');
    viewer.classList.toggle('ldv--pinned', mode === 'pinned');
    viewer.classList.toggle('ldv--wide', wideNow());
    viewer.setAttribute('aria-modal', mode === 'modal' ? 'true' : 'false');
    fitSide();
    void show(s);
    // The page holds still behind it: no wheel or swipe scrolls what's underneath
    held = { y: scrollY, overflow: document.documentElement.style.overflow };
    document.documentElement.style.overflow = 'hidden';
    if (mode === 'modal') { viewer.showModal(); return; }
    // Not modal: the video stays in sight and in reach (its sound, its controls), and so does the strip
    viewer.show();
    if (mode === 'pinned') stage?.pin(true, 'design');
    vq<HTMLElement>('close')?.focus({ preventScroll: true });
    document.addEventListener('keydown', onDocKey);
    document.addEventListener('click', onDocClick, true);
    addEventListener('resize', fitSide);
  }
  const step = (d: number) => {
    if (!shown || slides.length < 2) return;
    const i = Math.max(0, slides.indexOf(shown));
    void show(slides[(i + d + slides.length) % slides.length]);
  };
  const onPrev = () => step(-1);
  const onNext = () => step(1);
  const onKey = (e: KeyboardEvent) => { if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); } else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); } };
  // Not modal, the keys work wherever focus is (the strip, the video), except in a field someone is typing in
  const typing = (t: EventTarget | null) => t instanceof HTMLElement && !!t.closest('input, textarea, select, [contenteditable="true"]');
  const onDocKey = (e: KeyboardEvent) => {
    if (!viewer?.open) return;
    if (e.key === 'Escape') { e.preventDefault(); viewer.close(); return; }
    if (viewer.contains(e.target as Node) || typing(e.target)) return;
    onKey(e);
  };
  // On a phone, a tap on the small video goes back to it (rather than the mini player's own scroll to it)
  const onDocClick = (e: MouseEvent) => {
    if (!viewer?.open || mode !== 'pinned') return;
    if (!(e.target as Element).closest?.('[data-stage] [data-s="picture"]')) return;
    e.preventDefault();
    e.stopPropagation();
    viewer.close();
  };
  let touchX: number | null = null;
  const onTouchStart = (e: TouchEvent) => { touchX = e.touches.length === 1 ? e.touches[0].clientX : null; };
  const onTouchEnd = (e: TouchEvent) => {
    if (touchX == null || e.changedTouches.length !== 1) return;
    const dx = e.changedTouches[0].clientX - touchX;
    touchX = null;
    // A swipe, not a pinch or a tap
    if (Math.abs(dx) > 50 && (!window.visualViewport || window.visualViewport.scale <= 1.01)) step(dx < 0 ? 1 : -1);
  };
  // A click on the dark around the picture closes it
  const onBackdrop = (e: MouseEvent) => { if (e.target === viewer || e.target === vq('stage')) viewer?.close(); };
  const onClose = () => {
    document.removeEventListener('keydown', onDocKey);
    document.removeEventListener('click', onDocClick, true);
    removeEventListener('resize', fitSide);
    if (mode === 'pinned') stage?.pin(false);
    mode = 'modal';
    markShown(null);
    shown = null;
    if (held) {
      document.documentElement.style.overflow = held.overflow;
      if (Math.abs(scrollY - held.y) > 1) scrollTo({ top: held.y, behavior: 'instant' as ScrollBehavior });
      held = null;
    }
    opener?.focus({ preventScroll: true });
    opener = null;
  };
  vq('prev')?.addEventListener('click', onPrev);
  vq('next')?.addEventListener('click', onNext);
  viewer?.addEventListener('keydown', onKey);
  viewer?.addEventListener('touchstart', onTouchStart, { passive: true });
  viewer?.addEventListener('touchend', onTouchEnd);
  viewer?.addEventListener('click', onBackdrop);
  viewer?.addEventListener('close', onClose);

  const onVisible = () => { if (document.visibilityState === 'visible' && kid) void ask(); };
  document.addEventListener('visibilitychange', onVisible);

  return {
    /** The kid the page is showing now ('' for none), and its moment (upcoming, starting, live…): a change asks again */
    setKid(slug: string, now = '') {
      const sameKid = slug === kid;
      if (sameKid && now === moment) return;
      kid = slug;
      moment = now;
      asking?.abort();
      clearTimeout(askTimer);
      // A place the server kept for this kid's pictures stays while they're asked for
      if (!sameKid) hide(!!slug && hero?.dataset.design === slug);
      if (kid) void ask();
    },
    destroy() {
      alive = false;
      shapeWatch?.disconnect();
      laptop.removeEventListener('change', onLayout);
      asking?.abort();
      clearTimeout(askTimer);
      document.removeEventListener('visibilitychange', onVisible);
      vq('prev')?.removeEventListener('click', onPrev);
      vq('next')?.removeEventListener('click', onNext);
      viewer?.removeEventListener('keydown', onKey);
      viewer?.removeEventListener('touchstart', onTouchStart);
      viewer?.removeEventListener('touchend', onTouchEnd);
      viewer?.removeEventListener('click', onBackdrop);
      if (viewer?.open) viewer.close();
      onClose();
      viewer?.removeEventListener('close', onClose);
    },
  };
}
