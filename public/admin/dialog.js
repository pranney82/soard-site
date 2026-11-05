/**
 * How a dialog behaves, in one place for the whole admin: the focus starts
 * inside it, Tab stays inside, Escape closes (unless busy), the page behind
 * doesn't scroll, and focus goes back to whatever opened it.
 *
 *   const box = useRef(null);
 *   useDialog(box, onClose, busy);
 *   html`<div role="dialog" aria-modal="true" tabindex="-1" ref=${box}>…</div>`
 *
 * `returnTo` is a selector for where focus goes when what opened the dialog has
 * gone, like a menu that closed as it opened. While `busy`, Escape does nothing
 * and goes no further, so the page behind doesn't act on it either.
 */
import { useEffect, useRef } from './vendor.js';

const STOPS = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]:not([tabindex="-1"])';

/** Tab goes round inside el, and never behind it */
export function holdTab(e, el) {
  const stops = [...el.querySelectorAll(STOPS)].filter((x) => x.getClientRects().length);
  const at = document.activeElement;
  const off = !el.contains(at) || at === el;
  if (!stops.length) e.preventDefault();
  else if (e.shiftKey && (off || at === stops[0])) { e.preventDefault(); stops[stops.length - 1].focus(); }
  else if (!e.shiftKey && (off || at === stops[stops.length - 1])) { e.preventDefault(); stops[0].focus(); }
}

export function useDialog(ref, onClose, busy = false, { returnTo = null } = {}) {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  useEffect(() => {
    const opener = document.activeElement;
    document.body.classList.add('modal-open');
    if (ref.current && !ref.current.contains(opener)) ref.current.focus();
    const onKey = (e) => {
      // A field marked data-escape="local" uses Escape itself (cancelling an inline edit)
      if (e.key === 'Escape' && e.target?.closest?.('[data-escape="local"]')) return;
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (!busyRef.current) closeRef.current(); return; }
      if (e.key === 'Tab' && ref.current) holdTab(e, ref.current);
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      document.body.classList.remove('modal-open');
      const back = opener?.isConnected && opener !== document.body ? opener : returnTo && document.querySelector(returnTo);
      back?.focus?.();
    };
  }, []);
}
