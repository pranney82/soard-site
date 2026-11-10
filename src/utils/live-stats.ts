/**
 * live-stats.ts — what the live page tells Reveal stats (Admin → Broadcast → History)
 * ===================================================================================
 *  viewerId()   a random id this browser keeps (localStorage), so a person
 *               counts once per reveal however often they reload. Nothing
 *               personal; with storage blocked it lasts for the page only.
 *  who()        'staff' once this browser has opened the admin (it sets
 *               soard-staff), 'test' for an automated browser, else ''.
 *  arrival()    where this visit came from: the link's ?src= (or utm_source)
 *               and the referring site's host, kept for the tab's session so
 *               the page someone landed on decides, not the last click. A new
 *               arrival from another site (a full page load) takes over.
 *  shareable()  a link without ?src= or utm_*, for the page's Share button, so
 *               a friend's visit isn't credited to the sharer's email or QR.
 *               (The address bar keeps them: changing it confuses Astro's
 *               router, which then reloads the page on an in-page # link.)
 *  watchMeter() counts seconds the video actually plays with the tab showing
 *               and reports them: after the first 10 s, then every 20 s live
 *               (60 s on the replay), and what's left when it stops.
 */

const VID_KEY = 'soard-viewer';
export const STAFF_KEY = 'soard-staff';
const ARRIVAL_KEY = 'soard-arrival';

let memoryVid = '';
const randomId = () => {
  try { return crypto.randomUUID().replace(/-/g, ''); } catch { /* old browser */ }
  return Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
};

export function viewerId(): string {
  try {
    const have = localStorage.getItem(VID_KEY);
    if (have && /^[A-Za-z0-9]{8,40}$/.test(have)) return have;
    const id = randomId();
    localStorage.setItem(VID_KEY, id);
    return id;
  } catch {
    return (memoryVid ||= randomId());
  }
}

export function who(): '' | 'staff' | 'test' {
  try { if (navigator.webdriver) return 'test'; } catch { /* no navigator */ }
  try { if (localStorage.getItem(STAFF_KEY) === '1') return 'staff'; } catch { /* storage off */ }
  return '';
}

interface Arrival { src: string; ref: string }

function readHere(): Arrival {
  let src = '';
  let ref = '';
  try {
    const q = new URLSearchParams(location.search);
    src = (q.get('src') || q.get('utm_source') || '').slice(0, 24);
  } catch { /* no location */ }
  try {
    const r = document.referrer ? new URL(document.referrer) : null;
    if (r && r.host !== location.host) ref = r.hostname.slice(0, 100);
    else if (r) ref = location.hostname; // from this site (a banner, the menu)
  } catch { /* odd referrer */ }
  return { src, ref };
}

/** A page load that came from somewhere: its own ?src=, or a link on another site */
const fromOutside = (a: Arrival) => !!a.src || (!!a.ref && a.ref !== location.hostname);

/**
 * Where this visit came from: this page load's own source when it has one
 * (a link with ?src=, or another site), else how the tab's session began.
 */
export function arrival(): Arrival {
  const here = readHere();
  if (fromOutside(here)) return here;
  try {
    const kept = sessionStorage.getItem(ARRIVAL_KEY);
    if (kept) { const a = JSON.parse(kept); if (a && typeof a === 'object') return { src: String(a.src || ''), ref: String(a.ref || '') }; }
  } catch { /* storage off */ }
  return here;
}

/**
 * Remember how this tab arrived (the live client calls it once per page load).
 * The first page of the session is kept, unless a later page load came from
 * outside: someone who opened the site directly and later came back through a
 * Facebook post arrived from Facebook that time.
 */
export function noteArrival(): void {
  try {
    const here = readHere();
    const kept = sessionStorage.getItem(ARRIVAL_KEY);
    if (kept && !fromOutside(here)) return;
    // From this site with nothing kept: the session began before this script ran (an older tab); say nothing
    if (!kept && here.ref && here.ref === location.hostname && !here.src) return;
    sessionStorage.setItem(ARRIVAL_KEY, JSON.stringify(here));
  } catch { /* storage off */ }
}

/** The same address without ?src= or utm_* (what the Share button hands on) */
export function shareable(href: string): string {
  try {
    const url = new URL(href);
    for (const k of [...url.searchParams.keys()]) if (k === 'src' || k.startsWith('utm_')) url.searchParams.delete(k);
    return url.toString();
  } catch { return href; }
}

/** What every beacon carries about its sender */
export function sender(): { vid: string; who?: string; src?: string; ref?: string } {
  const a = arrival();
  const w = who();
  return { vid: viewerId(), ...(w ? { who: w } : {}), ...(a.src ? { src: a.src } : {}), ...(a.ref ? { ref: a.ref } : {}) };
}

export const FIRST_REPORT_SEC = 10;
export const LIVE_EVERY_SEC = 20;
export const REPLAY_EVERY_SEC = 60;

export interface WatchMeterOptions {
  kind: 'live' | 'replay';
  /** The playing <video>, or null while there isn't one */
  video: () => HTMLVideoElement | null;
  /** True while Stream's own iframe plays instead (no <video> to look at): showing counts as watching */
  iframe?: () => boolean;
  /** Send `sec` seconds of watching; `final` when the page is going away (use a beacon) */
  report: (kind: 'live' | 'replay', sec: number, final: boolean) => void;
  /** For tests: the clock and the timer */
  now?: () => number;
  every?: number;
}

/**
 * Counts seconds of real watching and reports them. Watching means the video
 * is playing (not paused, ended or stuck loading) and the tab is showing.
 * A gap longer than 5 s between ticks (a sleeping laptop, a frozen
 * background tab) isn't counted. Returns stop(), which reports what's left.
 */
export function watchMeter(opts: WatchMeterOptions): { stop: () => void; flush: () => void } {
  const now = opts.now || (() => performance.now());
  let last = now();
  // Where the picture's clock was at the last tick (from the start, so the first second counts too)
  let lastTime = (() => { try { const v = opts.video(); return v ? v.currentTime : -1; } catch { return -1; } })();
  let acc = 0;
  let sent = false;
  let stopped = false;
  let still = 0; // seconds the picture hasn't moved
  const due = () => (sent ? (opts.kind === 'live' ? LIVE_EVERY_SEC : REPLAY_EVERY_SEC) : FIRST_REPORT_SEC);
  const showing = () => { try { return document.visibilityState === 'visible'; } catch { return true; } };
  // Watching is the picture moving: playing, not ended, the tab showing, and how far its clock advanced since the last
  // tick (a stall or a stutter counts only the picture that played, in hls.js and in Safari's own player alike)
  const playing = () => {
    if (opts.iframe?.()) return showing() ? Infinity : 0;
    const v = opts.video();
    if (!v) { lastTime = -1; return false; }
    const t = v.currentTime;
    const moved = lastTime >= 0 ? t - lastTime : 0;
    lastTime = t;
    return !v.paused && !v.ended && showing() ? Math.max(0, moved) : 0;
  };
  const tick = () => {
    if (stopped) return;
    const t = now();
    const dt = (t - last) / 1000;
    last = t;
    const played = playing(); // every tick, so the picture's clock is always tracked (a long gap included)
    if (dt > 0 && dt <= 5 && played > 0) acc += Math.min(dt, played); // the picture's own time, never more than passed
    still = played > 0 ? 0 : still + Math.max(0, dt);
    // A report marks the minutes just before it arrives: when the picture stops (paused, frozen) for 3 s, the
    // seconds watched go now, so "there for the reveal" counts the minutes they were really watched in
    const stalled = still >= 3 && acc >= 1;
    // Whole seconds go; the fraction stays for the next report, so rounding never adds up to time that didn't play
    if ((acc >= due() || stalled) && Math.round(acc) >= 1) { const n = Math.round(acc); opts.report(opts.kind, n, false); acc -= n; sent = true; }
  };
  // What's left goes when the tab hides or the page goes away (a hidden tab isn't watching anyway)
  const flush = () => {
    tick();
    if (Math.round(acc) >= 1) { opts.report(opts.kind, Math.round(acc), true); acc = 0; sent = true; }
  };
  const onHide = () => { if (document.visibilityState === 'hidden') flush(); };
  const timer = setInterval(tick, opts.every ?? 1000);
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('pagehide', flush);
  return {
    flush,
    stop() {
      if (stopped) return;
      flush();
      stopped = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onHide);
      window.removeEventListener('pagehide', flush);
    },
  };
}
