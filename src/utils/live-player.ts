/**
 * live-player.ts — the video inside the live page's frame
 * ========================================================
 * Plays the Cloudflare Stream feed in a plain <video> (hls.js wherever the
 * browser has Media Source, the browser's own HLS on iPhone) instead of the
 * Stream iframe, so the page can do what an iframe can't:
 *
 *   - start muted (browsers allow nothing else) and offer sound with one tap
 *   - size the frame to the real picture: the crew shoots portrait, but a
 *     phone turned sideways still fits instead of letterboxing
 *   - tell viewers the truth when the camera drops or hasn't connected yet,
 *     instead of a black box under a LIVE badge
 *
 * Nothing is drawn on the picture: the page's own controls sit beside and
 * under it (live-stage.ts), so even a replay has no native control bar.
 *
 * Live tries LL-HLS first and drops to plain HLS once if LL is refused (the
 * same order as the admin control room). A feed that isn't there yet (an
 * empty playlist or a 404) is retried every few seconds for as long as the
 * page keeps the player mounted, so it picks up the moment the phone
 * reconnects. If neither playback path exists, the Stream iframe takes over.
 */
import type { LivePlayer } from './live-client';

export type PlayerStatus =
  | 'connecting'   // loading, nothing on screen yet
  | 'waiting'      // the feed isn't there yet (camera not connected)
  | 'playing'
  | 'buffering'    // a short stall
  | 'reconnecting' // was playing, then the feed dropped or stalled
  | 'blocked'      // the browser refused to autoplay (iPhone Low Power Mode): needs a tap
  | 'paused'       // also: a replay loaded and waiting for its first tap
  | 'ended'        // replay finished
  | 'iframe';      // Stream iframe fallback, which handles everything itself

export interface PlayerHandle {
  readonly video: HTMLVideoElement | null;
  readonly status: PlayerStatus;
  setMuted(muted: boolean): void;
  play(): void;
  destroy(): void;
}

interface Options {
  player: LivePlayer;
  onStatus?: (status: PlayerStatus) => void;
  /** The picture's real size, once known (and again if the phone turns) */
  onSize?: (width: number, height: number) => void;
  onMuted?: (muted: boolean) => void;
}

/** A stall this long reads as the feed dropping, not a hiccup */
const STALL_MS = 4000;
/** The browser's own HLS (iPhone) can sit silently on an empty playlist; give it this long to show a frame */
const NATIVE_START_MS = 12_000;
/** Picture stuck this long while "playing": start over */
const FROZEN_MS = 12_000;
const RETRY_MS = 4000;
const RETRY_SLOW_MS = 10_000;

type HlsClass = typeof import('hls.js').default;
let hlsModule: Promise<HlsClass> | null = null;
// The light build: no captions, alternate audio or DRM, none of which a Stream feed uses
const loadHls = () => (hlsModule ||= import('hls.js/light').then((m) => m.default));

export function streamUrls(p: LivePlayer) {
  const host = `https://customer-${p.customerCode}.cloudflarestream.com/${p.uid}`;
  const hls = p.src || `${host}/manifest/video.m3u8`;
  return {
    hls,
    llhls: p.kind === 'live' && !p.src ? `${hls}?protocol=llhls` : null,
    poster: p.kind === 'replay' && !p.src ? `${host}/thumbnails/thumbnail.jpg` : '',
    iframe: `${host}/iframe?${p.kind === 'live' ? 'autoplay=true&muted=true' : 'preload=metadata'}`,
  };
}

export function mountPlayer(container: HTMLElement, opts: Options): PlayerHandle {
  const p = opts.player;
  const live = p.kind === 'live';
  const urls = streamUrls(p);
  const video = document.createElement('video');
  video.setAttribute('playsinline', '');
  video.setAttribute('webkit-playsinline', ''); // iOS before 10
  video.playsInline = true;
  // Live starts muted so it can start on its own; a replay waits for a tap and plays with sound.
  // iPhone checks the muted *attribute* before it allows autoplay, so set both.
  if (live) { video.setAttribute('muted', ''); video.defaultMuted = true; }
  video.muted = live;
  video.autoplay = live;
  video.preload = live ? 'auto' : 'metadata';
  video.controls = false;
  if (urls.poster) video.poster = urls.poster;
  video.setAttribute('aria-label', live ? 'Live reveal video' : 'Reveal replay');
  container.appendChild(video);

  let status: PlayerStatus = 'connecting';
  let everPlayed = false;
  let dead = false;
  let restarting = false;
  let pending = false; // a retry is scheduled
  let useLl = !!urls.llhls;
  let failures = 0;
  let hls: InstanceType<HlsClass> | null = null;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let stallTimer: ReturnType<typeof setTimeout> | undefined;
  let nativeTimer: ReturnType<typeof setTimeout> | undefined;
  let lastTime = -1;
  let lastMove = Date.now();

  const set = (s: PlayerStatus) => {
    if (s === status || dead) return;
    status = s;
    opts.onStatus?.(s);
  };

  function tryPlay() {
    const pr = video.play();
    pr?.catch((err: DOMException) => { if (err?.name === 'NotAllowedError' && !dead) set('blocked'); });
  }

  function stopEngine() {
    clearTimeout(retryTimer);
    clearTimeout(stallTimer);
    clearTimeout(nativeTimer);
    restarting = true;
    if (hls) { try { hls.destroy(); } catch { /* already gone */ } hls = null; }
    if (video.getAttribute('src')) { video.removeAttribute('src'); video.load(); }
    restarting = false;
  }

  function restart(delay = failures > 15 ? RETRY_SLOW_MS : RETRY_MS) {
    if (dead) return;
    failures++;
    stopEngine();
    set(everPlayed ? 'reconnecting' : 'waiting');
    pending = true;
    retryTimer = setTimeout(start, delay);
  }

  function useIframe() {
    stopEngine();
    container.innerHTML = '';
    const f = document.createElement('iframe');
    f.src = urls.iframe;
    f.title = live ? 'Live reveal video' : 'Reveal replay';
    f.allow = 'accelerometer; autoplay; encrypted-media; gyroscope; picture-in-picture; fullscreen';
    f.setAttribute('allowfullscreen', 'true');
    container.appendChild(f);
    set('iframe');
  }

  function viaNative() {
    video.src = urls.hls;
    if (!live) return;
    tryPlay();
    // Safari may neither error nor play while the camera is off; start over until a frame shows
    nativeTimer = setTimeout(() => { if (!dead && video.readyState < 2 && status !== 'blocked') restart(); }, NATIVE_START_MS);
  }

  function viaHls(Hls: HlsClass) {
    const src = useLl && urls.llhls ? urls.llhls : urls.hls;
    const h = new Hls({
      enableWorker: false, // the site CSP allows workers from 'self' only
      lowLatencyMode: live,
      backBufferLength: 30,
      capLevelToPlayerSize: true,
      manifestLoadingMaxRetry: 1,
      levelLoadingMaxRetry: 4,
      fragLoadingMaxRetry: 4,
    });
    hls = h;
    h.on(Hls.Events.MANIFEST_PARSED, () => { if (live) tryPlay(); });
    h.on(Hls.Events.ERROR, (_e, d) => {
      if (!d.fatal || hls !== h) return;
      if (d.type === Hls.ErrorTypes.MEDIA_ERROR) { h.recoverMediaError(); return; }
      const code = d.response?.code;
      // LL-HLS refused outright (not just "nothing live yet"): plain HLS from here on
      if (useLl && code && code !== 404 && code !== 204) { useLl = false; restart(0); return; }
      restart();
    });
    h.loadSource(src);
    h.attachMedia(video);
  }

  async function start() {
    pending = false;
    lastMove = Date.now();
    if (dead) return;
    set(everPlayed ? 'reconnecting' : 'connecting');
    const native = !!video.canPlayType('application/vnd.apple.mpegurl');
    // iPhone has no classic Media Source; its own HLS is the steadier path there
    if (native && !('MediaSource' in window)) { viaNative(); return; }
    let Hls: HlsClass | null = null;
    try { Hls = await loadHls(); } catch { Hls = null; }
    if (dead) return;
    if (Hls?.isSupported()) viaHls(Hls);
    else if (native) viaNative();
    else useIframe();
  }

  // ── Media events ──
  const size = () => { if (video.videoWidth && video.videoHeight) opts.onSize?.(video.videoWidth, video.videoHeight); };
  video.addEventListener('loadedmetadata', size);
  // A replay that has loaded is ready and waiting for its first tap
  video.addEventListener('loadedmetadata', () => { if (!live && status === 'connecting') set('paused'); });
  video.addEventListener('resize', size);
  video.addEventListener('volumechange', () => opts.onMuted?.(video.muted));
  video.addEventListener('playing', () => {
    clearTimeout(stallTimer);
    everPlayed = true;
    failures = 0;
    lastMove = Date.now();
    set('playing');
  });
  video.addEventListener('waiting', () => {
    if (status !== 'playing') return;
    set('buffering');
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => { if (status === 'buffering') set('reconnecting'); }, STALL_MS);
  });
  video.addEventListener('pause', () => {
    if (restarting || video.ended || dead) return;
    if (status === 'playing' || status === 'buffering') set('paused');
  });
  video.addEventListener('play', () => { if (status === 'paused' || status === 'ended') set(everPlayed ? 'buffering' : 'connecting'); });
  video.addEventListener('ended', () => {
    // A live playlist that ends is the camera dropping; the replay ending is just the end
    if (live) restart(); else set('ended');
  });
  video.addEventListener('error', () => {
    if (restarting || dead || hls) return; // hls.js reports its own errors
    if (video.getAttribute('src')) restart();
  });

  // Live watchdog: a picture that stops moving without an error gets a fresh start
  const watchdog = live ? setInterval(() => {
    if (dead || pending || video.paused || !everPlayed) return;
    if (video.currentTime !== lastTime) { lastTime = video.currentTime; lastMove = Date.now(); return; }
    if (Date.now() - lastMove > FROZEN_MS) restart(0);
  }, 2000) : undefined;

  opts.onStatus?.(status);
  start();

  return {
    get video() { return status === 'iframe' ? null : video; },
    get status() { return status; },
    setMuted(muted: boolean) {
      video.muted = muted;
      if (!muted && video.volume === 0) video.volume = 1;
      if (video.paused && !video.ended && (live || !muted)) tryPlay();
    },
    play() {
      if (status === 'ended') video.currentTime = 0;
      tryPlay();
    },
    destroy() {
      dead = true;
      clearInterval(watchdog);
      stopEngine();
      container.innerHTML = '';
    },
  };
}
