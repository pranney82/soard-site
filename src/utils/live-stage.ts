/**
 * live-stage.ts — behaviour for LiveStage.astro (the live page's frame)
 * =====================================================================
 * The page tells the stage what should be on it (update()); the stage owns
 * everything after that: mounting the video or the starting-soon screen,
 * the one bar under the video (LIVE, viewers, sound, a heart, full screen;
 * or replay controls with the reveal marked), captions under the picture,
 * the corner mini player and keyboard shortcuts.
 *
 * Nothing is ever drawn on a playing picture, and the controls are kept to
 * what a first-time viewer understands at a glance.
 */
import type { LiveClient, LivePlayer } from './live-client';
import { mountPlayer, type PlayerHandle, type PlayerStatus } from './live-player';

export type StageMode = 'loading' | 'idle' | 'upcoming' | 'starting' | 'live' | 'replay';
export interface StageView {
  mode: StageMode;
  /** The live or replay video (live and replay modes only) */
  player: LivePlayer | null;
  /** Starting-soon screen address, when it should fill the frame */
  slate: string;
  /** The broadcast's setting; the picture's real shape wins once known */
  orientation: 'portrait' | 'landscape';
  /** Badge on the photo before the watch party ('' hides it) */
  badge: string;
}
export interface Stage {
  update(view: StageView): void;
  readonly party: boolean;
  /** Hold the video in a small player at the top of the screen (while the give sheet covers the page on a phone) */
  pin(on: boolean): void;
  /** Stop everything: the page is being swapped out by a client-side navigation */
  destroy(): void;
}
interface Options {
  client: LiveClient;
  /** The page lays itself out around the stage's shape */
  onShape?: (orientation: 'portrait' | 'landscape', party: boolean) => void;
  /** The starting-soon screen didn't load (kid page not built) */
  onSlateFailed?: (src: string) => void;
}

/** Below this the count reads as lonely rather than lively, so it stays hidden. */
const VIEWERS_MIN = 5;
/** Share of the video still on screen below which it docks into the corner */
const DOCK_AT = 0.35;
/** Start this far before the reveal moment, so the countdown is in the shot */
const JUMP_LEAD = 5;
const REPLAY_META_MS = 2 * 60 * 1000;
const REPLAY_META_FOR_MS = 45 * 60 * 1000;
const CC_KEY = 'soard-live-cc';

const NOTES: Record<string, Partial<Record<PlayerStatus, [string, string]>>> = {
  live: {
    connecting: ['Loading the video', ''],
    waiting: ['The camera is getting ready', 'Stay right here. The reveal starts playing by itself.'],
    reconnecting: ['Reconnecting', 'The signal dropped for a moment. Stay right here, it comes back by itself.'],
  },
  replay: {
    waiting: ['Getting the replay ready', 'It will start here in a moment.'],
    reconnecting: ['Reconnecting', ''],
  },
};
const STATUS: Partial<Record<PlayerStatus, string>> = {
  connecting: 'Connecting', waiting: 'Waiting for the camera', reconnecting: 'Reconnecting',
};

export function formatTime(sec: number) {
  if (!Number.isFinite(sec) || sec < 0) sec = 0;
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

interface Cue { start: number; end: number; text: string }
export function parseVtt(vtt: string): Cue[] {
  const toSec = (t: string) => { const p = t.trim().split(':').map(Number); return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1]; };
  const cues: Cue[] = [];
  for (const block of String(vtt || '').replace(/\r/g, '').split(/\n\n+/)) {
    const lines = block.split('\n');
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) continue;
    const [a, z] = lines[i].split('-->');
    const text = lines.slice(i + 1).join(' ').replace(/<[^>]+>/g, '').trim();
    const start = toSec(a), end = toSec(z.trim().split(/\s+/)[0]);
    if (text && Number.isFinite(start) && Number.isFinite(end)) cues.push({ start, end, text });
  }
  return cues;
}

export function createStage(root: HTMLElement, opts: Options): Stage {
  const $ = <T extends HTMLElement = HTMLElement>(k: string) => root.querySelector(`[data-s="${k}"]`) as T | null;
  const { client } = opts;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const picture = $('picture');
  const screen = root.querySelector<HTMLElement>('.stage__screen');
  const playerEl = $('player');
  const seek = $<HTMLInputElement>('seek');

  let view: StageView = { mode: 'loading', player: null, slate: '', orientation: 'portrait', badge: '' };
  let party = false;
  let mounted = '';
  let player: PlayerHandle | null = null;
  let kind = '';
  let pstatus: PlayerStatus | '' = '';
  let muted = true;
  let sized: 'portrait' | 'landscape' | '' = '';
  let viewers = 0;
  let watching = false;
  let slowConnect = false;
  let connectingTimer: ReturnType<typeof setTimeout> | undefined;
  let soundBeacon = false;
  let replayBeacon = false;
  // Replay extras
  let revealAt: number | null = null;
  let hasCaptions = false;
  let cues: Cue[] | null = null;
  let ccOn = (() => { try { return localStorage.getItem(CC_KEY) === '1'; } catch { return false; } })();
  let metaTimer: ReturnType<typeof setTimeout> | undefined;
  let metaSince = 0;
  let detach: (() => void) | null = null;

  const setHidden = (el: Element | null, hidden: boolean) => { if (el) (el as HTMLElement).hidden = hidden; };
  const flag = (name: string, on: boolean) => { if (on) root.setAttribute(name, ''); else root.removeAttribute(name); };
  const video = () => (player?.video ?? null);
  const shape = () => sized || view.orientation;

  // ── What goes in the frame ──────────────────────────────────────
  function update(next: StageView) {
    view = next;
    const wasParty = party;
    party = !!next.slate || (!!next.player && (next.mode === 'live' || next.mode === 'replay'));
    root.dataset.mode = next.mode;
    flag('data-party', party);
    root.dataset.orientation = shape();

    const key = party && next.player ? `${next.player.kind}:${next.player.uid}` : next.slate ? `slate:${next.slate}` : '';
    if (key !== mounted && playerEl) {
      mounted = key;
      unmount();
      if (party && next.player) {
        kind = next.player.kind;
        root.dataset.pkind = kind;
        playerEl.hidden = false;
        player = mountPlayer(playerEl, { player: next.player, onStatus, onSize, onMuted });
        // Live starts muted, a replay doesn't; after that, volume events keep this current
        muted = player.video?.muted ?? true;
        attachMedia();
        if (kind === 'replay') { metaSince = Date.now(); loadReplayMeta(); }
      } else if (next.slate) {
        const src = next.slate;
        const f = document.createElement('iframe');
        f.src = src;
        f.title = 'Starting soon';
        f.loading = 'eager';
        f.tabIndex = -1;
        // Same origin, so an unreadable document (or one without the canvas) means it didn't load
        f.addEventListener('load', () => {
          let ok = false;
          try { ok = !!f.contentDocument?.getElementById('canvas'); } catch { ok = false; }
          if (!ok) opts.onSlateFailed?.(src);
        });
        playerEl.appendChild(f);
        playerEl.hidden = false;
      } else {
        playerEl.hidden = true;
      }
    }
    if (party && (next.mode === 'live' || next.mode === 'starting') && !watching) { watching = true; client.watch(); }
    if (party !== wasParty || !wasParty) opts.onShape?.(shape(), party);
    paint();
    updateDock();
  }

  function unmount() {
    detach?.(); detach = null;
    player?.destroy();
    player = null;
    kind = '';
    pstatus = '';
    sized = '';
    revealAt = null; hasCaptions = false; cues = null;
    clearTimeout(metaTimer);
    clearTimeout(connectingTimer);
    slowConnect = false;
    delete root.dataset.pstatus;
    delete root.dataset.pkind;
    root.style.removeProperty('--ar');
    flag('data-playing', false);
    if (playerEl) playerEl.innerHTML = '';
    setDock(false);
  }

  // ── Player callbacks ────────────────────────────────────────────
  function onStatus(st: PlayerStatus) {
    pstatus = st;
    root.dataset.pstatus = st;
    clearTimeout(connectingTimer);
    slowConnect = false;
    // Only say "loading" when it is actually slow
    if (st === 'connecting') connectingTimer = setTimeout(() => { slowConnect = true; paint(); }, 2500);
    if (st === 'playing' && kind === 'replay' && !replayBeacon) { replayBeacon = true; client.beacon('click_replay'); }
    if (st === 'iframe') attachMedia();
    paint();
    updateDock();
  }
  function onSize(w: number, h: number) {
    sized = h > w ? 'portrait' : 'landscape';
    root.dataset.orientation = sized;
    root.style.setProperty('--ar', String(Math.min(2.4, Math.max(0.42, w / h))));
    opts.onShape?.(sized, party);
  }
  function onMuted(m: boolean) { muted = m; paint(); }

  /** Replay clock: play state, seek bar, time, captions line */
  function attachMedia() {
    detach?.(); detach = null;
    const v = video();
    if (!v) return;
    const tick = () => {
      const d = v.duration;
      const t = v.currentTime;
      if (seek && Number.isFinite(d) && d > 0) {
        if (document.activeElement !== seek || !seeking) seek.value = String(Math.round((t / d) * 1000));
        seek.style.setProperty('--p', `${(t / d) * 100}%`);
        seek.setAttribute('aria-valuetext', `${formatTime(t)} of ${formatTime(d)}`);
      }
      const time = $('time');
      if (time) time.textContent = Number.isFinite(d) && d > 0 ? `${formatTime(t)} / ${formatTime(d)}` : formatTime(t);
      paintCaption(t);
      paintJump(t);
    };
    const playing = () => { flag('data-playing', !v.paused && !v.ended); const b = $('play'); if (b) b.setAttribute('aria-label', v.paused || v.ended ? 'Play' : 'Pause'); };
    const evs: [string, () => void][] = [['timeupdate', tick], ['durationchange', () => { tick(); paintMark(); }], ['seeked', tick], ['play', playing], ['pause', playing], ['ended', playing]];
    for (const [e, fn] of evs) v.addEventListener(e, fn);
    detach = () => { for (const [e, fn] of evs) v.removeEventListener(e, fn); };
    tick(); playing();
  }

  // ── Painting ────────────────────────────────────────────────────
  function paint() {
    const v = video();
    const isVideo = !!player && pstatus !== 'iframe';
    const showing = pstatus === 'playing' || pstatus === 'buffering' || pstatus === 'paused';
    const live = view.mode === 'live';
    const starting = view.mode === 'starting';
    flag('data-muted', muted);

    // Photo badge, before the watch party only
    setHidden($('badge'), party || !view.badge);
    const bt = $('badge-text'); if (bt) bt.textContent = view.badge;

    // Over the frame only when there is no picture
    const note = isVideo && pstatus && (pstatus !== 'connecting' || slowConnect) ? NOTES[kind]?.[pstatus] : null;
    setHidden($('note'), !note);
    if (note) { const t = $('note-title'); const x = $('note-text'); if (t) t.textContent = note[0]; if (x) x.textContent = note[1]; }
    setHidden($('tap'), !(isVideo && pstatus === 'blocked'));

    // Bar
    setHidden($('bar'), !party);
    const replayControls = kind === 'replay' && isVideo;
    setHidden($('livebar'), replayControls);
    setHidden($('replaybar'), !replayControls);
    const onAir = starting || (live && (!isVideo || showing || pstatus === 'blocked'));
    flag('data-onair', onAir);
    const status = $('status');
    if (status) status.textContent = starting ? 'Starting soon' : live ? (onAir ? 'Live' : STATUS[pstatus as PlayerStatus] || 'Connecting') : kind === 'replay' ? 'Replay' : '';
    const count = (live && onAir || starting) && viewers >= VIEWERS_MIN;
    setHidden($('count'), !count);
    const ct = $('count-text'); if (ct && count) ct.textContent = `${viewers.toLocaleString()} ${starting ? 'waiting' : 'watching'}`;
    // Muted: one clear "Tap for sound". After that: sound, a heart, full screen
    const soundCta = live && isVideo && showing && muted;
    setHidden($('sound'), !soundCta);
    const mute = $('mute');
    setHidden(mute, !(live && isVideo && showing && !muted));
    mute?.setAttribute('aria-label', muted ? 'Turn sound on' : 'Mute');
    setHidden($('heart'), !((live && !soundCta && (onAir || !isVideo)) || starting));
    root.querySelectorAll<HTMLElement>('[data-full]').forEach((b) => setHidden(b, !(isVideo && (kind === 'replay' || (live && !soundCta)))));
    const cc = $('cc-toggle');
    setHidden(cc, !(kind === 'replay' && hasCaptions && isVideo));
    cc?.setAttribute('aria-pressed', String(ccOn));

    // Replay extras
    flag('data-cc', party && kind === 'replay' && hasCaptions && ccOn && isVideo);
    setHidden($('cc'), !root.hasAttribute('data-cc'));
    paintMark();
    paintJump(v?.currentTime ?? 0);
  }

  function paintMark() {
    const v = video();
    const d = v?.duration ?? NaN;
    const ok = kind === 'replay' && revealAt != null && Number.isFinite(d) && d > 0 && revealAt < d;
    const mark = $('mark');
    setHidden(mark, !ok);
    if (mark && ok) mark.style.setProperty('--at', `${(revealAt! / d) * 100}%`);
  }
  function paintJump(t: number) {
    const show = party && kind === 'replay' && revealAt != null && !!player && pstatus !== 'iframe';
    flag('data-jump', show);
    setHidden($('jump'), !show);
    if (!show) return;
    const label = $('jump-label'); const at = $('jump-at');
    // After the moment has played, the button offers it again
    const text = t > revealAt! + 30 ? 'Watch the reveal again' : 'Jump to the reveal';
    if (label) label.textContent = text;
    if (at) at.textContent = formatTime(revealAt!);
    $('jump')?.setAttribute('aria-label', `${text}, at ${formatTime(revealAt!)}`);
  }
  function paintCaption(t: number) {
    if (!root.hasAttribute('data-cc') || !cues) return;
    const cue = cues.find((c) => t >= c.start && t <= c.end + 0.25);
    const el = $('cc-text');
    if (el && el.textContent !== (cue?.text || '')) el.textContent = cue?.text || '';
  }

  // ── Replay: the reveal moment and captions ──────────────────────
  async function loadReplayMeta() {
    clearTimeout(metaTimer);
    if (kind !== 'replay') return;
    try {
      const res = await fetch('/api/live-replay', { cache: 'no-store' });
      const data = res.ok ? await res.json() : null;
      if (data?.ok && data.uid === view.player?.uid) {
        revealAt = typeof data.revealAt === 'number' ? data.revealAt : null;
        hasCaptions = !!data.captions;
        if (hasCaptions && ccOn) loadCues();
        paint();
      }
    } catch { /* offline: the replay still plays */ }
    // The moment and captions can land a while after the replay is up
    if ((revealAt == null || !hasCaptions) && Date.now() - metaSince < REPLAY_META_FOR_MS) metaTimer = setTimeout(loadReplayMeta, REPLAY_META_MS);
  }
  async function loadCues() {
    if (cues) return;
    try {
      const res = await fetch('/api/live-replay?vtt=en');
      cues = res.ok ? parseVtt(await res.text()) : [];
    } catch { cues = []; }
    paintCaption(video()?.currentTime ?? 0);
  }
  function jumpToReveal() {
    const v = video();
    if (!v || revealAt == null) return;
    v.currentTime = Math.max(0, revealAt - JUMP_LEAD);
    player?.setMuted(false);
    player?.play();
    client.beacon('click_replay', { how: 'jump' });
  }

  // ── Controls ────────────────────────────────────────────────────
  function soundOn(how: string) {
    if (!player) return;
    player.setMuted(false);
    if (!soundBeacon) { soundBeacon = true; client.beacon('click_watch', { how }); }
  }
  function toggleSound() { if (!player) return; if (muted) soundOn('button'); else player.setMuted(true); }
  function togglePlay() {
    const v = video();
    if (!v || !player) return;
    if (v.paused || v.ended) { player.setMuted(false); player.play(); } else v.pause();
  }
  function toggleCaptions() {
    ccOn = !ccOn;
    try { localStorage.setItem(CC_KEY, ccOn ? '1' : '0'); } catch { /* private mode */ }
    if (ccOn) loadCues();
    paint();
    paintCaption(video()?.currentTime ?? 0);
  }
  async function toggleFullscreen() {
    const v = video() as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (root.requestFullscreen) await root.requestFullscreen();
      else v?.webkitEnterFullscreen?.(); // iPhone: only the video itself can go full screen
    } catch { v?.webkitEnterFullscreen?.(); }
  }

  $('sound')?.addEventListener('click', () => soundOn('sound'));
  $('tap')?.addEventListener('click', () => { if (!player) return; soundOn('tap'); player.play(); });
  $('mute')?.addEventListener('click', toggleSound);
  $('cc-toggle')?.addEventListener('click', toggleCaptions);
  root.querySelectorAll('[data-full]').forEach((b) => b.addEventListener('click', toggleFullscreen));
  $('play')?.addEventListener('click', togglePlay);
  $('mark')?.addEventListener('click', jumpToReveal);
  $('jump')?.addEventListener('click', jumpToReveal);
  // Tapping the picture: sound on for a muted live video, play / pause for a replay
  playerEl?.addEventListener('click', () => {
    if (docked) return;
    if (kind === 'live' && muted) soundOn('video');
    else if (kind === 'replay') togglePlay();
  });
  let seeking = false;
  seek?.addEventListener('input', () => {
    const v = video();
    if (!v || !Number.isFinite(v.duration)) return;
    seeking = true;
    v.currentTime = (Number(seek.value) / 1000) * v.duration;
  });
  seek?.addEventListener('change', () => { seeking = false; });
  // Keyboard, while focus is anywhere in the stage
  root.addEventListener('keydown', (e) => {
    if (!party || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target as HTMLElement;
    if (t.matches('input, textarea')) return;
    const k = e.key.toLowerCase();
    if (k === 'm' && player) { e.preventDefault(); toggleSound(); }
    else if (k === 'f') { e.preventDefault(); toggleFullscreen(); }
    else if (k === 'c' && hasCaptions) { e.preventDefault(); toggleCaptions(); }
    else if ((k === 'k' || (k === ' ' && t === root)) && kind === 'replay') { e.preventDefault(); togglePlay(); }
  });

  // ── Love: one heart. Yours pops; when others send love, it beats ──
  // (nothing floats over the picture, and no numbers)
  const heart = $('heart');
  const bump = (cls: string, ms: number) => {
    if (!heart || reduced) return;
    heart.classList.remove(cls); void heart.offsetWidth; heart.classList.add(cls);
    setTimeout(() => heart.classList.remove(cls), ms);
  };
  let mine = 0;
  heart?.addEventListener('click', () => { bump('is-pop', 160); if (client.react('heart')) mine++; });
  const offs: (() => void)[] = [];
  offs.push(client.on('react', ({ c }) => {
    if (view.mode !== 'live' && view.mode !== 'starting') return;
    const total = Object.values(c).reduce((n, v) => n + (Number(v) || 0), 0);
    const theirs = total - Math.min(mine, total);
    mine = Math.max(0, mine - total);
    if (theirs > 0) bump('is-beat', 600);
  }));
  offs.push(client.on('viewers', ({ n }) => { viewers = n; paint(); }));

  // ── Mini player ─────────────────────────────────────────────────
  let docked = false;
  let dockOff = false;
  let inView = true;
  let pinned = false;
  function setDock(on: boolean) {
    if (!picture || on === docked) return;
    docked = on;
    if (on) {
      // Sit above the auction bar when one is showing
      const bar = document.querySelector<HTMLElement>('.auction-bar');
      const off = bar && bar.offsetHeight && getComputedStyle(bar).display !== 'none' ? bar.offsetHeight : 0;
      picture.style.setProperty('--dock-bottom', `${off}px`);
      const label = $('dock-label'); if (label) label.textContent = view.mode === 'replay' ? 'Replay' : view.mode === 'starting' ? 'Starting soon' : 'Live';
    }
    picture.classList.toggle('is-docked', on);
    setHidden($('dockbar'), !on);
  }
  function setPinned(on: boolean) {
    picture?.classList.toggle('is-pinned', on);
    // A pinned player stays until the sheet closes, so it has no close button
    setHidden($('undock'), on);
  }
  function updateDock() {
    const going = !!player && (kind === 'live'
      ? pstatus === 'iframe' || pstatus === 'playing' || pstatus === 'buffering' || pstatus === 'reconnecting'
      : pstatus === 'playing' || pstatus === 'buffering');
    const pin = pinned && party;
    setDock(pin || (party && going && !inView && !dockOff && !document.fullscreenElement));
    setPinned(pin && docked);
  }
  let io: IntersectionObserver | null = null;
  if (screen && 'IntersectionObserver' in window) {
    io = new IntersectionObserver(([e]) => {
      // Only once you've scrolled past the video, never while it is still below the fold
      inView = e.intersectionRatio >= DOCK_AT || e.boundingClientRect.top > 0;
      if (e.intersectionRatio >= DOCK_AT) dockOff = false;
      updateDock();
    }, { threshold: [0, DOCK_AT, 1] });
    io.observe(screen);
  }
  const onFullscreen = () => updateDock();
  document.addEventListener('fullscreenchange', onFullscreen);
  $('undock')?.addEventListener('click', (e) => {
    e.stopPropagation();
    dockOff = true;
    // Closing the mini player stops the sound too, the way every mini player works
    if (kind === 'live') player?.setMuted(true); else video()?.pause();
    updateDock();
  });
  // Tapping the mini player takes you back to it
  picture?.addEventListener('click', (e) => {
    if (!docked || (e.target as Element).closest('[data-s="undock"]')) return;
    e.preventDefault();
    e.stopPropagation();
    screen?.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'center' });
  }, true);

  return {
    update,
    get party() { return party; },
    pin(on: boolean) { pinned = on; updateDock(); },
    destroy() {
      unmount();
      mounted = '';
      if (watching) { watching = false; client.unwatch(); }
      io?.disconnect();
      document.removeEventListener('fullscreenchange', onFullscreen);
      for (const off of offs) off();
    },
  };
}
