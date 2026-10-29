/**
 * float.js — menus, dropdown lists and popovers that always draw on top
 * ===========================================================================
 * A pop-up opens in the browser's top layer (popover="manual"), so no sticky
 * bar, toast, clipping card or stacking context can cover it. It stays where
 * it is in the page, so focus, Tab order and events work as before. It is
 * pinned to its anchor: below it, or above when there's more room there, and
 * it scrolls inside when neither side fits. As the page scrolls it follows
 * the anchor, and calls onHide once the anchor goes off screen or under a
 * sticky bar.
 *
 *   const listRef = useMemo(() => floatRef({ align: 'stretch' }), []);
 *   html`<ul class="ppl-listbox" role="listbox" ref=${listRef}>…</ul>`
 *
 * Make the ref once per component (useMemo/useCallback): a new one on every
 * render would hide and re-show the pop-up each time.
 *
 * Options (an object, or a function returning one, read when it opens):
 *   anchor  element (or () => element) to pin to; default the box its CSS
 *           positions it against (its offsetParent), else its parent
 *   align   'stretch' takes the anchor's width (dropdown lists), 'end' lines
 *           up right edges, 'start' left edges
 *   width   px for 'start'/'end'; default the pop-up's own CSS width
 *   gap     px between anchor and pop-up (default 4)
 *   sheet   a media query under which the CSS places it (a phone bottom
 *           sheet): it's only lifted to the top layer
 *   onHide  called when the anchor is no longer visible
 */

const EDGE = 8;

// Undo the browser's own popover look (centered, bordered, padded) with no
// specificity, so each pop-up's class styles it as before, in any order
function addReset() {
  if (document.getElementById('float-reset')) return;
  const s = document.createElement('style');
  s.id = 'float-reset';
  s.textContent = ':where([popover]) { inset: auto; margin: 0; padding: 0; border: 0; width: auto; height: auto; overflow: visible; color: inherit; background: none; }';
  document.head.prepend(s);
}

// Under a sticky bar, or a fixed bar along the top (a toast doesn't count)
function underBar(n) {
  for (; n && n !== document.body; n = n.parentElement) {
    const p = getComputedStyle(n).position;
    if (p === 'sticky') return true;
    if (p === 'fixed') return n.getBoundingClientRect().top <= 1;
  }
  return false;
}

/** Is this off screen, or under a sticky bar or the top bar? (`pop` may sit over it) */
export function hiddenAnchor(a, pop) {
  const r = a.getBoundingClientRect();
  const y = r.top + r.height / 2;
  if (y < 0 || y >= innerHeight) return true;
  const hit = document.elementFromPoint(Math.min(Math.max(r.left + r.width / 2, 0), innerWidth - 1), y);
  return !hit || (!a.contains(hit) && !pop?.contains(hit) && underBar(hit));
}

export function float(el, { anchor, align = 'stretch', width, gap = 4, sheet, onHide } = {}) {
  // By default the box its CSS placed it against (top: 100% of what?)
  const own = el.offsetParent || el.parentElement;
  const anchorEl = () => (typeof anchor === 'function' ? anchor() : anchor) || own;
  const cssMax = parseFloat(getComputedStyle(el).maxHeight) || Infinity;
  const isSheet = () => !!sheet && matchMedia(sheet).matches;
  addReset();
  if (!el.hasAttribute('popover')) el.setAttribute('popover', 'manual');
  try { el.showPopover?.(); } catch { /* already showing */ }
  el.style.zIndex = '1010'; // only matters where there's no top layer

  const place = (scrolled) => {
    const a = anchorEl();
    if (!a || !el.isConnected) return;
    if (isSheet()) {
      for (const k of ['position', 'boxSizing', 'top', 'left', 'right', 'bottom', 'width', 'maxHeight', 'overflowY']) el.style[k] = '';
      return;
    }
    const r = a.getBoundingClientRect();
    if (scrolled && hiddenAnchor(a, el)) { onHide?.(); return; }
    // border-box, so the width it's given is the width it measures (no creep)
    Object.assign(el.style, { position: 'fixed', boxSizing: 'border-box', right: 'auto', bottom: 'auto', left: '0px', top: '0px', maxHeight: 'none' });
    if (align === 'stretch' || width) el.style.width = `${Math.min(align === 'stretch' ? r.width : width, innerWidth - EDGE * 2)}px`;
    else el.style.width = '';
    const w = Math.min(el.offsetWidth, innerWidth - EDGE * 2);
    el.style.width = `${w}px`;
    const tall = Math.min(el.offsetHeight, cssMax);
    const below = innerHeight - r.bottom - gap - EDGE, above = r.top - gap - EDGE;
    const up = tall > below && above > below;
    const room = Math.max(up ? above : below, 120);
    const h = Math.min(tall, room);
    el.style.maxHeight = `${Math.min(cssMax, room)}px`;
    el.style.overflowY = tall > room ? 'auto' : ''; // cut short: it scrolls inside
    el.style.top = `${up ? Math.max(EDGE, r.top - gap - h) : r.bottom + gap}px`;
    const x = align === 'end' ? r.right - w : r.left;
    el.style.left = `${Math.max(EDGE, Math.min(x, innerWidth - w - EDGE))}px`;
    el.dataset.side = up ? 'top' : 'bottom';
  };

  let frame = 0;
  const follow = (e) => {
    if (e?.target instanceof Node && el.contains(e.target)) return; // its own list scrolling
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => (el.isConnected ? place(e?.type === 'scroll') : stop()));
  };
  // Content that grows or shrinks (a list filtering as you type) is placed again
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => follow()) : null;
  ro?.observe(el);
  addEventListener('scroll', follow, true);
  addEventListener('resize', follow);
  place();
  // Also runs on its own if the pop-up leaves the page while open
  function stop() {
    cancelAnimationFrame(frame);
    ro?.disconnect();
    removeEventListener('scroll', follow, true);
    removeEventListener('resize', follow);
    try { el.hidePopover?.(); } catch { /* already gone */ }
  }
  return stop;
}

/** A ref callback for preact: float() while the element is in the page */
export function floatRef(opts) {
  let stop = null;
  return (el) => {
    stop?.();
    stop = el ? float(el, typeof opts === 'function' ? opts() : opts) : null;
  };
}
