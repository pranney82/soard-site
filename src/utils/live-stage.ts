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
import { watchMeter } from './live-stats';
import { PHONE, SIDE, typingIn } from './live-media';

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
  late?: boolean; // past the start by a while: "starting soon" has stopped being true
}
export interface Stage {
  update(view: StageView): void;
  readonly party: boolean;
  /**
   * Hold the video in a small player at the top of the screen while something covers the page on a phone:
   * 'give', the give sheet (top right, over the page above the sheet); 'design', the design viewer (its top left corner)
   */
  pin(on: boolean, where?: 'give' | 'design'): void;
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
  let meter: { stop: () => void } | null = null;

  const setHidden = (el: Element | null, hidden: boolean) => { if (el) (el as HTMLElement).hidden = hidden; };
  const flag = (name: string, on: boolean) => { if (on) root.setAttribute(name, ''); else root.removeAttribute(name); };
  const video = () => (player?.video ?? null);
  const shape = () => sized || view.orientation;
  // The shape the page was last told: it hears again whenever the shape changes, not only when the party starts (a phone
  // turned sideways swaps the starting-soon screen's shape mid-party, and the page lays out around it)
  let told = '';

  // ── What goes in the frame ──────────────────────────────────────
  function update(next: StageView) {
    view = next;
    const wasParty = party;
    party = !!next.slate || (!!next.player && (next.mode === 'live' || next.mode === 'replay'));
    root.dataset.mode = next.mode;
    flag('data-party', party);
    root.dataset.orientation = shape();

    // The broadcast is part of the key: the live input is the same for every reveal, and each reveal's watching is its own
    const key = party && next.player ? `${next.player.kind}:${next.player.uid}:${client.state?.id || ''}` : next.slate ? `slate:${next.slate}` : '';
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
        // Reveal stats: seconds actually watched, for the broadcast this player belongs to
        const bid = client.state?.id || null;
        const watchKind = kind === 'live' ? 'live' : 'replay';
        meter = watchMeter({
          kind: watchKind,
          video: () => video(),
          // Stream's own iframe (no <video> to look at): showing counts only live, where it plays by itself
          iframe: () => watchKind === 'live' && pstatus === 'iframe',
          report: (k, sec) => client.watched(k, sec, bid),
        });
      } else if (next.slate) {
        const src = next.slate;
        const f = document.createElement('iframe');
        f.src = src;
        f.title = next.late ? 'Running late' : 'Starting soon';
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
    if (party !== wasParty || !wasParty || shape() !== told) { told = shape(); opts.onShape?.(told as 'portrait' | 'landscape', party); }
    paint();
    updateDock();
  }

  function unmount() {
    meter?.stop(); meter = null;
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
    told = sized;
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
        // How far it's played (0 to 1), on the line's cell (the line you see is drawn there, under the slider)
        seek.parentElement?.style.setProperty('--f', String(Math.min(1, Math.max(0, t / d))));
        seek.setAttribute('aria-valuetext', `${formatTime(t)} of ${formatTime(d)}`);
      }
      // The time and the length are two pieces, so the length can step aside when the bar is narrow
      const now = $('time-now'); const total = $('time-total');
      if (now) now.textContent = formatTime(t);
      if (total) total.textContent = Number.isFinite(d) && d > 0 ? `/ ${formatTime(d)}` : '';
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
    if (status) status.textContent = starting ? (view.late ? 'Running late' : 'Starting soon') : live ? (onAir ? 'Live' : STATUS[pstatus as PlayerStatus] || 'Connecting') : kind === 'replay' ? 'Replay' : '';
    const count = (live && onAir || starting) && viewers >= VIEWERS_MIN;
    setHidden($('count'), !count);
    // The number and its word apart, so the word can step aside first on a narrow bar
    const cn = $('count-num'); const cw = $('count-word');
    if (count) { if (cn) cn.textContent = viewers.toLocaleString(); if (cw) cw.textContent = starting ? 'waiting' : 'watching'; }
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
    // The line (its gap) and the star both read where it is, so it's set on the line's cell
    const cell = mark?.parentElement;
    if (cell) {
      cell.toggleAttribute('data-mark', ok);
      if (ok) cell.style.setProperty('--at', String(Math.min(1, Math.max(0, revealAt! / d))));
    }
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
  $('jump')?.addEventListener('click', jumpToReveal);
  // Tapping the picture: sound on for a muted live video, play / pause for a replay
  playerEl?.addEventListener('click', () => {
    if (docked) return;
    if (kind === 'live' && muted) soundOn('video');
    else if (kind === 'replay') togglePlay();
  });
  let seeking = false;
  // A tap on the reveal's star plays from the reveal, exactly, as Jump to the reveal does: the star is drawn on the
  // line and the line takes the tap, which on its own would land wherever on the star the finger did (on a short line,
  // a minute or more either side). A press that moves is a drag, star or not. It jumps when the finger lifts; the
  // slider's own move to where the finger was, which for a tap in its 8px end comes after the lift, is put back
  // (starTapped: until the next press or key, the only things that move the slider)
  let press: { x: number; y: number; star: boolean } | null = null;
  let starTapped = false;
  const onStar = (e: PointerEvent) => {
    const m = $('mark');
    if (!m || m.hidden) return false;
    const r = m.getBoundingClientRect();
    // (its 3px white ring included)
    return Math.hypot(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2)) <= r.width / 2 + 3;
  };
  seek?.addEventListener('pointerdown', (e) => { starTapped = false; press = { x: e.clientX, y: e.clientY, star: onStar(e) }; });
  seek?.addEventListener('pointermove', (e) => { if (press?.star && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 6) press.star = false; });
  seek?.addEventListener('pointercancel', () => { press = null; });
  seek?.addEventListener('pointerup', () => {
    const star = press?.star;
    press = null;
    if (star) { starTapped = true; seeking = false; jumpToReveal(); }
  });
  seek?.addEventListener('keydown', () => { press = null; starTapped = false; });
  seek?.addEventListener('input', () => {
    const v = video();
    if (!v || !Number.isFinite(v.duration) || v.duration <= 0) return;
    // (a tap on the star goes to the reveal, never first to where it touched: the handle stays where the video is)
    if (press?.star || starTapped) { seek.value = String(Math.round((v.currentTime / v.duration) * 1000)); return; }
    seeking = true;
    v.currentTime = (Number(seek.value) / 1000) * v.duration;
  });
  seek?.addEventListener('change', () => { seeking = false; });
  // Keyboard, while focus is anywhere in the stage
  root.addEventListener('keydown', (e) => {
    if (!party || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target as HTMLElement;
    // Typing stays typing; the progress line is no text box, so the keys work there too. The design strip beside the
    // picture has keys of its own (its pictures open the viewer), so the video's don't reach into it
    if (t.matches('textarea, input:not([data-s="seek"])') || t.closest('.stage__beside')) return;
    const k = e.key.toLowerCase();
    if (k === 'm' && player) { e.preventDefault(); toggleSound(); }
    else if (k === 'f') { e.preventDefault(); toggleFullscreen(); }
    else if (k === 'c' && hasCaptions) { e.preventDefault(); toggleCaptions(); }
    else if ((k === 'k' || (k === ' ' && (t === root || t === seek))) && kind === 'replay') { e.preventDefault(); togglePlay(); }
    // On the line, the arrows go 5 seconds (the slider's own step is a thousandth of the video: under a second here)
    else if (t === seek && kind === 'replay' && /^Arrow(Left|Right|Up|Down)$/.test(e.key)) {
      const v = video();
      if (!v || !Number.isFinite(v.duration)) return;
      e.preventDefault();
      const back = e.key === 'ArrowLeft' || e.key === 'ArrowDown';
      v.currentTime = Math.max(0, Math.min(v.duration, v.currentTime + (back ? -5 : 5)));
    }
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
      const label = $('dock-label'); if (label) label.textContent = view.mode === 'replay' ? 'Replay' : view.mode === 'starting' ? (view.late ? 'Running late' : 'Starting soon') : 'Live';
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
    setDock(pin || (party && going && !inView && !dockOff && !typing && !document.fullscreenElement));
    setPinned(pin && docked);
  }
  // While someone types on a phone the small player steps aside: its keyboard leaves no room on the screen for both,
  // and it sat over the message being typed (or, on a page the keyboard left very short, its × went off the top). The
  // reveal keeps playing, and the player comes back when typing ends
  const phone = matchMedia(PHONE);
  let typing = false;
  const onTyping = () => {
    const now = phone.matches && typingIn(document.activeElement) && !root.contains(document.activeElement);
    if (now !== typing) { typing = now; updateDock(); }
  };
  // (on its way out, focus is on nothing for a moment: wait to see where it lands)
  const onTypingOut = () => requestAnimationFrame(onTyping);
  document.addEventListener('focusin', onTyping);
  document.addEventListener('focusout', onTypingOut);
  phone.addEventListener('change', onTyping);
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
  const onFullscreen = () => { updateDock(); refit(); };
  document.addEventListener('fullscreenchange', onFullscreen);

  // ── Which way round, on a phone held sideways ──
  // LiveStage has more than one way to lay the stage out there (data-fit): in full screen, the controls beside the
  // picture or under it; on the page, with captions on beside a wide picture that has the design with it, the
  // captions above the controls (with the design under them), under the picture, or the design in a column of its
  // own. Which leaves the picture biggest turns on the screen's exact width and height, so the stage tries each and
  // keeps the one with the biggest picture that fits on the screen. It runs before the screen is next drawn, so no
  // other way ever shows
  const sideways = matchMedia(SIDE);
  const besideEl = root.querySelector<HTMLElement>('.stage__beside');
  // (the height the page's frame goes by: the screen's, held while someone types; LivePage)
  const roomProbe = document.createElement('div');
  roomProbe.setAttribute('aria-hidden', 'true');
  roomProbe.style.cssText = 'position:fixed;top:0;left:0;width:0;height:var(--live-vh, 100svh);visibility:hidden;pointer-events:none';
  document.body.append(roomProbe);
  const setFit = (w: string) => { if (w) root.dataset.fit = w; else delete root.dataset.fit; };
  function fitWays(): string[] {
    if (!party || !sideways.matches || !screen) return [];
    // ('' is the stage's usual way: in full screen, the controls under the picture)
    if (document.fullscreenElement === root) return ['side', ''];
    if (root.dataset.orientation === 'landscape' && root.hasAttribute('data-cc') && (besideEl?.offsetHeight ?? 0) > 0) return ['', 'under', 'col'];
    return [];
  }
  function fit() {
    const ways = fitWays();
    if (ways.length < 2) { setFit(''); return; }
    const full = document.fullscreenElement === root;
    const room = full ? innerHeight : roomProbe.getBoundingClientRect().height;
    let best = ''; let bestW = -1; let bestOver = Infinity;
    for (const w of ways) {
      setFit(w);
      const pic = screen!.getBoundingClientRect().width;
      const r = root.getBoundingClientRect();
      // How far it runs past the bottom of the screen (on the page: with the page at its top, where the frame is sized)
      const over = Math.max(0, (full ? r.bottom : r.bottom + scrollY) - room);
      const better = over <= 1 ? bestOver > 1 || pic > bestW + 0.5 : bestOver > 1 && over < bestOver - 0.5;
      if (better) { best = w; bestW = pic; bestOver = over; }
    }
    setFit(best);
  }
  let fitQueued = false;
  // (in the next frame's first step, before it's drawn: after anything else that resizes the frame, like LivePage's
  // hold while typing, has had its turn)
  function refit() {
    if (fitQueued) return;
    fitQueued = true;
    requestAnimationFrame(() => { fitQueued = false; fit(); });
  }
  addEventListener('resize', refit);
  // What changes the choice: captions, Jump, the picture's shape, the mode, and the design being shown (on the page)
  const fitWatch = new MutationObserver(refit);
  fitWatch.observe(root, { attributes: true, attributeFilter: ['data-party', 'data-mode', 'data-orientation', 'data-cc', 'data-jump', 'style'] });
  const host = root.closest('.hero');
  if (host) fitWatch.observe(host, { attributes: true, attributeFilter: ['data-party', 'data-design', 'data-orientation'] });
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
    pin(on: boolean, where: 'give' | 'design' = 'give') {
      pinned = on;
      if (on) root.dataset.pin = where; else delete root.dataset.pin;
      updateDock();
    },
    destroy() {
      unmount();
      mounted = '';
      if (watching) { watching = false; client.unwatch(); }
      io?.disconnect();
      document.removeEventListener('fullscreenchange', onFullscreen);
      document.removeEventListener('focusin', onTyping);
      document.removeEventListener('focusout', onTypingOut);
      phone.removeEventListener('change', onTyping);
      removeEventListener('resize', refit);
      fitWatch.disconnect();
      roomProbe.remove();
      for (const off of offs) off();
    },
  };
}
