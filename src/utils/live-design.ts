/**
 * live-design.ts — fills "The design" on a reveal's live page (LiveDesign.astro)
 * =============================================================================
 * The page says which kid it's showing and what moment it's in (setKid: its
 * own kid, or on /live/ the one being revealed); this asks /api/reveal-design
 * for them, draws the room as it was, the plan and the look once it's open
 * (an hour before the reveal), and asks again: when the moment changes
 * (starting soon, live, replay), at the moment it opens, and every few
 * minutes after, so a change in Admin → Kids shows up on its own. Three
 * parts, each shown only when it has something:
 *   The room today   before photos ("The room before" once the reveal has started)
 *   The plan         the as-built and proposed drawings, side by side
 *   The look         the design boards
 * Each card keeps its picture's shape before the picture arrives (read off a
 * tiny copy first), so nothing below it jumps; a picture that can't load is
 * left out, as the starting-soon screen leaves it out. Any picture opens in
 * the viewer, which holds the page still behind it.
 */
import { fetchDesign, slideSrc, designSignature, type DesignSlide } from './reveal-design-client';

const ASK_OPEN_MS = 3 * 60_000;
const ASK_CLOSED_MS = 10 * 60_000;
const ASK_FAILED_MS = 2 * 60_000;
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

export function createLiveDesign(section: HTMLElement) {
  const parts = section.querySelector<HTMLElement>('[data-ldz="parts"]')!;
  const nameEl = section.querySelector<HTMLElement>('[data-ldz="name"]');
  const viewer = document.querySelector<HTMLDialogElement>('[data-ldz-viewer]');
  let kid = '';
  let moment = '';
  let sig = '';
  let slides: DesignSlide[] = [];
  let after = false;
  let askTimer: ReturnType<typeof setTimeout> | undefined;
  let alive = true;
  let asking: AbortController | null = null;

  function hide() {
    section.hidden = true;
    parts.replaceChildren();
    sig = '';
    slides = [];
  }

  function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = '', text = ''): HTMLElementTagNameMap[K] {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text) e.textContent = text;
    return e;
  }

  /** One picture card, opening the viewer at its place among the pictures that loaded */
  function item(s: DesignSlide, width: number, label: string, tag: boolean, onGone: () => void) {
    const li = el('li');
    const b = el('button', `ldz-item${s.kind === 'before' ? '' : ' ldz-paper'}`);
    b.type = 'button';
    b.setAttribute('aria-label', `Enlarge: ${label}`);
    if (tag && s.kind !== 'before') b.append(el('span', 'ldz-tag', straight(s.caption)));
    const pic = el('span', 'ldz-pic');
    const img = el('img');
    img.alt = straight(s.alt);
    img.decoding = 'async';
    pic.append(img);
    b.append(pic);
    const gone = () => { if (li.isConnected) { li.remove(); onGone(); } };
    img.addEventListener('error', gone, { once: true });
    // The card takes its picture's shape first (photos are always 4:3), then the picture comes
    const shape = s.kind === 'before' ? Promise.resolve(0.75) : shapeOf(s);
    void shape.then((r) => {
      if (!r) { gone(); return; }
      if (s.kind !== 'before') pic.style.aspectRatio = `1 / ${r.toFixed(4)}`;
      return slideSrc(s, width).then((src) => { if (src) img.src = src; else gone(); });
    });
    b.addEventListener('click', () => open(s));
    li.append(b);
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

  function draw(name: string, next: DesignSlide[], isAfter: boolean) {
    const s = designSignature(next) + (isAfter ? '|after' : '');
    if (s === sig) return;
    sig = s;
    slides = next.slice();
    after = isAfter;
    if (!next.length) { hide(); return; }
    if (nameEl) nameEl.textContent = name ? possessive(name) : 'The';
    const befores = next.filter((x) => x.kind === 'before');
    const plans = next.filter((x) => x.kind === 'as-built' || x.kind === 'proposed');
    const boards = next.filter((x) => x.kind === 'board');
    const out: HTMLElement[] = [];
    // A picture that can't load leaves the viewer, its card, and its part when it was the last one
    const lost = (x: DesignSlide, list: HTMLElement, wrap: HTMLElement, recount?: () => void) => () => {
      slides = slides.filter((y) => y !== x);
      if (!list.children.length) wrap.remove();
      recount?.();
      if (!parts.children.length) section.hidden = true;
    };
    if (befores.length) {
      const ul = el('ul', 'ldz-grid ldz-grid--photos');
      const { wrap } = part(isAfter ? 'The room before' : 'The room today', ul);
      const recount = () => { ul.dataset.n = String(ul.children.length); };
      ul.append(...befores.map((x, i) => item(x, befores.length === 1 ? 1600 : 900, `before photo ${i + 1} of ${befores.length}`, false, lost(x, ul, wrap, recount))));
      recount();
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
      };
      ul.append(...plans.map((x) => item(x, plans.length === 1 ? 1800 : 1200, straight(x.caption), true, lost(x, ul, wrap, recount))));
      recount();
      out.push(wrap);
    }
    if (boards.length) {
      const ul = el('ul', `ldz-grid ldz-boards ${boards.length === 1 ? 'ldz-grid--one' : 'ldz-grid--boards'}`);
      const { wrap } = part('The look', ul);
      ul.append(...boards.map((x) => {
        const li = item(x, boards.length === 1 ? 1800 : 1200, straight(x.caption), false, lost(x, ul, wrap));
        // A board's caption sits under it, outside the picture
        li.append(el('p', 'ldz-tag', straight(x.caption)));
        return li;
      }));
      out.push(wrap);
    }
    parts.replaceChildren(...out);
    section.hidden = false;
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
    }
    askTimer = setTimeout(ask, wait);
  }

  // ── Viewer ──
  let shown: DesignSlide | null = null;
  const vq = <T extends Element>(k: string) => viewer?.querySelector<T>(`[data-ldv="${k}"]`) || null;
  let opener: HTMLElement | null = null;
  let held: { y: number; overflow: string } | null = null;
  async function show(s: DesignSlide) {
    const img = vq<HTMLImageElement>('img');
    if (!img) return;
    shown = s;
    const i = slides.indexOf(s);
    const k = vq<HTMLElement>('kicker'); if (k) k.textContent = s.kicker;
    const c = vq<HTMLElement>('caption'); if (c) c.textContent = straight(s.caption);
    const n = vq<HTMLElement>('count'); if (n) n.textContent = slides.length > 1 ? `${i + 1} of ${slides.length}` : '';
    img.alt = straight(s.alt);
    for (const k2 of ['prev', 'next']) { const b = vq<HTMLButtonElement>(k2); if (b) b.hidden = slides.length < 2; }
    const src = await slideSrc(s, Math.min(2400, Math.round(Math.max(innerWidth, innerHeight) * (devicePixelRatio || 1))));
    if (shown === s && src) img.src = src;
  }
  function open(s: DesignSlide) {
    if (!viewer || !slides.includes(s)) return;
    opener = document.activeElement as HTMLElement | null;
    void show(s);
    if (!viewer.open) {
      // The page holds still behind it: no wheel or swipe scrolls what's underneath
      held = { y: scrollY, overflow: document.documentElement.style.overflow };
      document.documentElement.style.overflow = 'hidden';
      viewer.showModal();
    }
  }
  const step = (d: number) => {
    if (!shown || slides.length < 2) return;
    const i = Math.max(0, slides.indexOf(shown));
    void show(slides[(i + d + slides.length) % slides.length]);
  };
  const onPrev = () => step(-1);
  const onNext = () => step(1);
  const onKey = (e: KeyboardEvent) => { if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); } else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); } };
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
      if (!sameKid) hide();
      if (kid) void ask();
    },
    destroy() {
      alive = false;
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
