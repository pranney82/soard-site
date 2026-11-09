/**
 * slate-design.ts — the room's story, playing in the starting-soon screen's frame
 * ==============================================================================
 * Peter, Nov 9 2026: "it's more important the slate page is visually
 * interesting, there's something to look at while the users wait for the
 * reveal". From an hour before the reveal (/api/reveal-design decides), the
 * frame that holds the kid's photo plays, and plays again:
 *
 *   the kid → the room today (before photos, drifting) → the floor plan today
 *   → the new plan, wiped in over it → the design boards
 *
 * A chip names each one ("BEFORE · Dylan's room today", "THE PLAN · The new
 * floor plan") and a row of steps shows where it is in the story. Nothing is
 * shown before it has loaded; a picture that can't load is skipped. The
 * screen asks again every few minutes, so a change made in Admin → Kids
 * arrives on its own.
 *
 * Preview (?design=preview, framed by the kid editor): the editor's unsaved
 * slides, read from the parent window (window.__soardRevealDesign), open
 * whatever the clock says. ?slide=N holds one slide (still screenshots).
 */
import { fetchDesign, slideSrc, preload, designSignature, validSlide, type DesignSlide } from './reveal-design-client';

const HOLD_MS: Record<string, number> = { kid: 8000, before: 6500, 'as-built': 9000, proposed: 11000, board: 9000 };
const WIPE_MS = 2600;
const ASK_OPEN_MS = 3 * 60_000;     // open: a change in the admin shows within a few minutes
const ASK_CLOSED_MS = 10 * 60_000;  // closed with no time set: the reveal may get one
const ASK_FAILED_MS = 2 * 60_000;

interface Options {
  body: HTMLElement;
  photoBox: HTMLElement;     // .photo: holds the kid's picture; the slides go on top of it
  chip: HTMLElement;         // the caption chip (kicker + text)
  steps: HTMLElement;        // the row of steps
  kidChip: { kicker: string; caption: string } | null; // "TODAY · Therapy Room", on the kid's slide
  kidSlug: string;
  preview: boolean;
  pinned: number | null;     // ?slide=N
  still: boolean;
  /** Holds scaled by this (?pace=0.2 plays the story five times as fast, for checking it; the wipe keeps its own speed) */
  pace?: number;
}

interface Built { slide: DesignSlide | null; layer: HTMLElement | null; ready: boolean; failed: boolean; step?: HTMLElement | null }
const FADE_MS = 1100; // .slide's opacity transition

export function startSlateDesign(o: Options) {
  const { body, photoBox, chip, steps, kidChip, kidSlug, preview, pinned, still } = o;
  const pace = o.pace && o.pace > 0 && o.pace <= 1 ? o.pace : 1;
  const reduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const show = document.createElement('div');
  show.className = 'show';
  show.setAttribute('aria-hidden', 'true');
  photoBox.append(show);
  const line = document.createElement('div');
  line.className = 'wipe-line';
  photoBox.append(line);

  let built: Built[] = [];
  let sig = '';
  let at = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let askTimer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0;
  let underTimer: ReturnType<typeof setTimeout> | undefined;

  const portrait = () => body.dataset.o === 'portrait';
  // About twice the frame's width on the 1920/1080 canvas: sharp on a TV, light enough for a phone
  const widthFor = (s: DesignSlide) => (s.kind === 'before' ? 1800 : portrait() ? 2000 : 1700);

  let chipTimer: ReturnType<typeof setTimeout> | undefined;
  /** The chip for a slide; the kid's own slide says what's being built today (the rooms chip's words) */
  function chipFor(s: { kicker: string; caption: string } | null) {
    const k = chip.querySelector<HTMLElement>('[data-chip="kicker"]');
    const t = chip.querySelector<HTMLElement>('[data-chip="text"]');
    clearTimeout(chipTimer);
    // The same words for the next slide (one before photo to the next): the chip just stays
    if (s && chip.classList.contains('is-on') && k?.textContent === s.kicker && t?.textContent === s.caption) return;
    // The words change while it's faded, never in view
    chip.classList.remove('is-on');
    if (!s) return;
    chipTimer = setTimeout(() => {
      if (k) k.textContent = s.kicker;
      if (t) t.textContent = s.caption;
      chip.classList.add('is-on');
    }, still ? 0 : 260);
  }

  // One step per slide that plays: a slide whose picture can't load takes its step with it
  function drawSteps() {
    steps.replaceChildren(...built.map((b) => {
      const el = document.createElement('span');
      el.className = 'step';
      el.append(document.createElement('i'));
      b.step = el;
      return el;
    }));
    steps.hidden = built.length < 2;
  }
  function dropStep(b: Built) {
    b.step?.remove();
    b.step = null;
    steps.hidden = steps.children.length < 2;
  }
  function markStep(i: number, ms: number) {
    built.forEach((b, n) => {
      const s = b.step;
      if (!s) return;
      s.classList.toggle('is-done', n < i);
      s.classList.remove('is-on');
      if (n === i) { s.style.setProperty('--hold', `${ms}ms`); void s.offsetWidth; s.classList.add('is-on'); }
    });
  }

  function go(i: number) {
    const prev = built[at];
    const next = built[i];
    if (!next) return;
    const wipe = !still && !reduced && prev?.slide?.kind === 'as-built' && next.slide?.kind === 'proposed';
    // From one picture to another, the old one stays whole underneath while the new one fades (or wipes) in over
    // it: two half-faded pictures would let the kid's photo show through. Back to the kid, the last one fades away.
    const under = prev && prev !== next && prev.layer && next.layer ? prev : null;
    for (const [n, b] of built.entries()) {
      if (!b.layer) continue;
      b.layer.classList.toggle('is-on', n === i);
      b.layer.classList.toggle('is-under', !!under && b === under);
      b.layer.classList.remove('is-wiping');
    }
    clearTimeout(underTimer);
    if (under) underTimer = setTimeout(() => { if (under !== built[at]) under.layer?.classList.remove('is-under'); }, (wipe ? WIPE_MS : FADE_MS) + 80);
    if (wipe && next.layer) {
      void next.layer.offsetWidth;
      next.layer.classList.add('is-wiping');
      line.classList.remove('is-wiping');
      void line.offsetWidth;
      line.classList.add('is-wiping');
    }
    // A before photo drifts from the start each time it comes round
    if (next.layer && next.slide?.kind === 'before') {
      const img = next.layer.querySelector('img');
      if (img) { img.classList.remove('drift'); void img.offsetWidth; if (!still && !reduced) img.classList.add('drift'); }
    }
    at = i;
    chipFor(next.slide || kidChip);
    const hold = Math.max(1000, HOLD_MS[next.slide?.kind || 'kid'] * pace) + (wipe ? WIPE_MS : 0);
    markStep(i, still ? 0 : hold);
    clearTimeout(timer);
    if (still || pinned != null) return;
    timer = setTimeout(advance, hold);
  }

  function advance() {
    if (!built.length) return;
    for (let step = 1; step <= built.length; step++) {
      const n = (at + step) % built.length;
      const b = built[n];
      if (n === 0 || (b.ready && !b.failed)) { go(n); return; }
    }
  }

  async function apply(slides: DesignSlide[]) {
    const next = designSignature(slides);
    if (next === sig) return;
    sig = next;
    const gen = ++generation;
    clearTimeout(timer);
    show.replaceChildren();
    built = [{ slide: null, layer: null, ready: true, failed: false }];
    body.toggleAttribute('data-design', slides.length > 0);
    if (!slides.length) { at = 0; steps.replaceChildren(); steps.hidden = true; chipFor(null); return; }
    for (const s of slides) {
      const layer = document.createElement('div');
      layer.className = `slide slide--${s.kind}${s.kind === 'before' ? '' : ' paper'}`;
      const img = document.createElement('img');
      img.alt = '';
      img.decoding = 'async';
      layer.append(img);
      show.append(layer);
      const b: Built = { slide: s, layer, ready: false, failed: false };
      built.push(b);
      void slideSrc(s, widthFor(s)).then(async (src) => {
        if (gen !== generation) return;
        if (!src || !(await preload(src))) { b.failed = true; layer.remove(); dropStep(b); return; }
        if (gen !== generation) return;
        img.src = src;
        b.ready = true;
        // A held slide (?slide=N) shows as soon as it can
        if (pinned != null && built.indexOf(b) === Math.min(pinned, built.length - 1)) go(built.indexOf(b));
      });
    }
    drawSteps();
    at = 0;
    if (pinned != null) { if (pinned === 0) go(0); return; }
    go(0);
  }

  // ── Where the slides come from ──
  async function ask() {
    clearTimeout(askTimer);
    if (preview) return;
    const d = await fetchDesign(kidSlug);
    let wait = ASK_FAILED_MS;
    if (d) {
      if (d.open) { await apply(d.slides || []); wait = ASK_OPEN_MS; } else {
        await apply([]);
        const until = d.opensAt ? Date.parse(d.opensAt) - Date.now() : NaN;
        // Asked again the moment it opens (a moment after, so the server agrees)
        wait = Number.isFinite(until) ? Math.min(ASK_CLOSED_MS, Math.max(1500, until + 1500)) : ASK_CLOSED_MS;
      }
    }
    askTimer = setTimeout(ask, wait);
  }

  let previewTimer: ReturnType<typeof setInterval> | undefined;
  if (preview) {
    const read = () => {
      try {
        const fn = (window.parent && window.parent !== window ? (window.parent as any).__soardRevealDesign : null) as (() => { slides?: unknown[] }) | null;
        const d = typeof fn === 'function' ? fn() : null;
        void apply(((d?.slides || []) as unknown[]).filter(validSlide));
      } catch { /* not framed by the admin */ }
    };
    read();
    previewTimer = setInterval(read, 1000);
  } else if (kidSlug) {
    void ask();
  }
  // Back on screen after a while away (a laptop asleep): ask now rather than at the next turn
  const onVisible = () => { if (document.visibilityState === 'visible' && !preview && kidSlug) void ask(); };
  document.addEventListener('visibilitychange', onVisible);

  return {
    /** The screen turned (landscape ↔ portrait): pictures sized for the new frame */
    refit() { const s = sig; sig = ''; if (s) void apply(built.map((b) => b.slide).filter((x): x is DesignSlide => !!x)); },
    stop() { clearTimeout(timer); clearTimeout(askTimer); clearTimeout(underTimer); clearInterval(previewTimer); document.removeEventListener('visibilitychange', onVisible); },
  };
}
