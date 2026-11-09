/**
 * hold-place.ts — change the page without moving what someone is looking at
 * ==========================================================================
 * The live pages redraw on their own (a reveal is scheduled, goes live, its
 * replay ends; the schedule changes). Sections then appear above, go, or
 * trade places. Run the change through holdPlace(): the control in a form
 * that has focus ends up exactly where it was on screen, or, with nobody in
 * a form, whatever was in the middle of the screen does (scroll anchoring,
 * done by hand so it holds in every browser).
 */
export function holdPlace<T>(change: () => T): T {
  const el = document.activeElement as HTMLElement | null;
  const field = el && el !== document.body && el.closest('form') ? el : null;
  const anchor = field || (scrollY > 0 ? onScreen() : null);
  const before = anchor?.getBoundingClientRect().top;
  const out = change();
  if (anchor && before !== undefined && anchor.isConnected && anchor.getBoundingClientRect().height) {
    const moved = anchor.getBoundingClientRect().top - before;
    if (Math.abs(moved) >= 1) window.scrollBy({ top: moved, behavior: 'instant' as ScrollBehavior });
  }
  return out;
}

/** What's in the middle of the screen, leaving out anything pinned there (the header, the reveal banner) */
function onScreen(): HTMLElement | null {
  const pinned = (n: Element) => { for (let at: Element | null = n; at && at !== document.body; at = at.parentElement) { const p = getComputedStyle(at).position; if (p === 'fixed' || p === 'sticky') return true; } return false; };
  return (document.elementsFromPoint(innerWidth / 2, innerHeight / 2).find((n) => n !== document.documentElement && n !== document.body && !pinned(n)) as HTMLElement | undefined) || null;
}

/**
 * Redraw a list of rows (innerHTML) without losing someone's keyboard place: the control they were on comes back
 * in the same child's row (data-slug); if that row went, focus moves to the row now in its place.
 */
export function keepFocus(list: HTMLElement, redraw: () => void): void {
  const el = document.activeElement as HTMLElement | null;
  if (!el || !list.contains(el)) { redraw(); return; }
  const row = el.closest<HTMLElement>('[data-slug]');
  const rows = [...list.querySelectorAll<HTMLElement>('[data-slug]')];
  const index = row ? rows.indexOf(row) : -1;
  const slug = row?.dataset.slug || '';
  // Its own class, or (a child's name link has none) its tag among the row's unclassed ones
  const kind = el.className.split(' ')[0];
  const which = kind ? `.${CSS.escape(kind)}` : `${el.tagName.toLowerCase()}:not([class])`;
  redraw();
  const again = slug ? list.querySelector<HTMLElement>(`[data-slug="${CSS.escape(slug)}"] ${which}`) : null;
  const now = [...list.querySelectorAll<HTMLElement>('[data-slug]')];
  const instead = now[Math.min(Math.max(index, 0), now.length - 1)]?.querySelector<HTMLElement>('a, button');
  (again || instead)?.focus({ preventScroll: true });
}
