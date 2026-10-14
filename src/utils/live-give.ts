/**
 * live-give.ts — behaviour for LiveGive.astro (give without leaving the reveal)
 * ============================================================================
 * Opens the Zeffy form beside or under the video during the watch party.
 * Not a modal: the video's controls stay usable, so there is no focus trap;
 * focus moves into the panel on open and back where it came from on close,
 * and Escape closes it. The form stays loaded after closing, so someone who
 * closes it halfway through doesn't lose what they typed.
 */
import type { LiveClient } from './live-client';
import type { Stage } from './live-stage';

interface Options {
  client: LiveClient;
  stage: Stage;
}

export function createGive(root: HTMLElement, opts: Options) {
  const frame = root.querySelector<HTMLIFrameElement>('iframe');
  const close = root.querySelector<HTMLButtonElement>('[data-give-close]');
  const phones = matchMedia('(max-width: 960px)');
  let previous: HTMLElement | null = null;
  let isOpen = false;

  function open(where: string) {
    if (!frame) return;
    if (!frame.getAttribute('src')) frame.src = root.dataset.src || '';
    previous = document.activeElement as HTMLElement | null;
    root.hidden = false;
    isOpen = true;
    // On a phone the sheet covers the video, so the video moves to a small player above it
    if (phones.matches) opts.stage.pin(true);
    close?.focus({ preventScroll: true });
    opts.client.beacon('click_donate', { where, how: 'panel' });
  }
  function hide() {
    if (!isOpen) return;
    root.hidden = true;
    isOpen = false;
    opts.stage.pin(false);
    previous?.focus({ preventScroll: true });
    previous = null;
  }
  close?.addEventListener('click', hide);
  const onKey = (e: KeyboardEvent) => { if (isOpen && e.key === 'Escape') hide(); };
  document.addEventListener('keydown', onKey);

  return {
    open,
    close: hide,
    get isOpen() { return isOpen; },
    destroy() {
      document.removeEventListener('keydown', onKey);
      opts.stage.pin(false);
    },
  };
}
