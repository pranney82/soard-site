/**
 * Board → presenting a meeting (the chair's side)
 * ===========================================================================
 * The screen is the board page's #/meetings/<id>/screen (./board/screen.js):
 * the agenda item, who presents it, and its documents page by page, made to
 * share on Google Meet or put on the room's TV. It shows only what the board
 * can see (never a private note or a staff-only file).
 *
 * The chair moves it from the meeting's During step: Next and Previous, the
 * arrow keys, or a presentation clicker (they send Page Down / Page Up), one
 * stop at a time through deckOf (./board-shared.js): the cover, each item's
 * card, each page of its documents, the close. The screen's own window takes
 * the same keys and passes them back here.
 *
 *   - this computer: a BroadcastChannel puts each move on the screen at once
 *   - anywhere else (the TV's own laptop, board members' board pages): the
 *     meeting's live state, saved with each move, within a second or two
 *   - before Start, the chair can rehearse: only this computer's screen moves
 */

import { useState, useEffect, useRef } from './vendor.js';
import { openDoc, partsOf } from './board/docs.js';

export const CHANNEL = 'soard-board-screen';
export const screenUrl = (id) => `/admin/board/#/meetings/${encodeURIComponent(id)}/screen`;
/** The same screen as a small copy in the chair's During (it follows, but isn't a screen window: ./board/screen.js MIRROR) */
export const mirrorUrl = (id) => `/admin/board/?mirror#/meetings/${encodeURIComponent(id)}/screen`;

const windows = new Map();
/** The screen in its own window (the same one again if it's open), to share or drag onto the TV */
export function openScreen(id) {
  const was = windows.get(id);
  if (was && !was.closed) { was.focus(); return was; }
  const w = window.open(screenUrl(id), `soard-screen-${id}`, 'popup,width=1280,height=760');
  if (w) windows.set(id, w);
  return w;
}
export const screenIsOpen = (id) => { const w = windows.get(id); return !!w && !w.closed; };

/**
 * The channel to the screen: `send(message)`, and `on` hears the screen's own messages ({ type: 'hello' } when it
 * opens or is asked, { type: 'bye' } when it closes, { type: 'key', dir } when someone presses a key on it,
 * { type: 'pages', pages } as it opens documents, { type: 'want' } from the chair's preview asking where it is).
 * → [send, open]: open once a screen has said hello, until it goes (the preview never says hello).
 */
export function useScreen(id, on) {
  const ch = useRef(null);
  const handler = useRef(on);
  handler.current = on;
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!('BroadcastChannel' in window)) return undefined;
    const c = new BroadcastChannel(CHANNEL);
    ch.current = c;
    c.onmessage = (e) => {
      const msg = e.data || {};
      if (msg.id !== id) return;
      if (msg.type === 'hello') setOpen(true);
      if (msg.type === 'bye') setOpen(false);
      handler.current?.(msg);
    };
    // A screen already open (this page reloaded) says hello back
    c.postMessage({ type: 'ping', id });
    // A window this page opened and someone closed (its goodbye may not have come)
    const look = setInterval(() => { const w = windows.get(id); if (w?.closed) { windows.delete(id); setOpen(false); } }, 2000);
    return () => { clearInterval(look); c.close(); ch.current = null; };
  }, [id]);
  const send = (msg) => ch.current?.postMessage({ ...msg, id });
  return [send, open];
}

/**
 * How many pages each document has, as the screen draws them ({ fileId: pages }), and then which pages are tall
 * enough to show in two halves ({ fileId: [1 | 2 a page] }, ./board/docs.js partsOf), worked out one file at a
 * time in the background while `on` (the deck steps through every page and half). The screen's own counts come in too.
 * → [pages, addPages, parts]
 */
export function usePages(files, on) {
  const [pages, setPages] = useState({});
  const [parts, setParts] = useState({});
  const key = files.map((f) => f.id).join();
  useEffect(() => {
    if (!on) return undefined;
    let stop = false;
    (async () => {
      for (const f of files) {
        if (stop) return;
        if (pages[f.id]) continue;
        try {
          const doc = await openDoc(f);
          if (!stop && doc?.count) setPages((p) => (p[f.id] === doc.count ? p : { ...p, [f.id]: doc.count }));
        } catch { /* a file that won't open is one page on the screen */ }
      }
      // The counts first (every page in the deck), then the halves
      for (const f of files) {
        if (stop) return;
        if (parts[f.id]) continue;
        try {
          const n = await partsOf(f);
          if (!stop) setParts((p) => ({ ...p, [f.id]: n }));
        } catch { /* one page, whole */ }
      }
    })();
    return () => { stop = true; };
  }, [key, on]);
  return [pages, (more) => setPages((p) => ({ ...p, ...more })), parts];
}

/**
 * The keys that move a presentation → 1 | -1 | 0: ← → and J K, and a clicker's Page Down and Page Up. On the
 * screen itself (`all`, nothing there scrolls) also ↑ ↓ and the space bar.
 */
export function stepKey(e, { all = false } = {}) {
  if (e.metaKey || e.ctrlKey || e.altKey) return 0;
  const next = ['ArrowRight', 'PageDown', 'j', ...(all ? ['ArrowDown', ' '] : [])];
  const back = ['ArrowLeft', 'PageUp', 'k', ...(all ? ['ArrowUp'] : [])];
  if (next.includes(e.key)) return e.key === ' ' && e.shiftKey ? -1 : 1;
  if (back.includes(e.key)) return -1;
  return 0;
}
