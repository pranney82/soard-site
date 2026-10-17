/**
 * Broadcast control room (admin)
 * ==============================
 * Loaded on demand by the Broadcast page: the control room on Now while a
 * reveal is live (or about to be), the private mic check on the rehearsal
 * feed, the go/no-go before a reveal, and each reveal's health report in
 * History. It plays the feed with its own HLS player instead of Stream's
 * iframe, so the page can listen to it:
 *
 *  - Sound: an AudioWorklet (meter-worklet.js) sees every sample. Loudness
 *    in LUFS (BS.1770: momentary, short-term, gated integrated), true peak,
 *    per-channel level bars, and a verdict: good, very quiet, very loud,
 *    distorting, one side only, no sound, or no audio track.
 *  - Picture: rendition, delay behind the phone, stalls, black or frozen.
 *  - Destinations: the server's verdict for the site, Facebook, YouTube and
 *    Instagram, with the fix (/api/broadcast-admin { action: 'monitor' }).
 *  - Issues: everything wrong right now in one list, with whether it has
 *    been posted to Slack (the server posts on its own, page open or not).
 *    New issues chime, flag the tab title, and can raise a desktop
 *    notification.
 *
 * hls.js lives in ./vendor-hls.js and is imported only when a feed plays.
 * Meter bars are written straight to the DOM; Preact re-renders a few times
 * a second for the words.
 */

import { h, htm, useState, useEffect, useRef, useCallback } from './vendor.js';

const html = htm.bind(h);

const POLL_LIVE_MS = 8000;
const POLL_IDLE_MS = 20000;
const BAR_FLOOR = -60;            // dBFS at the left edge of the channel bars
const LUFS_FLOOR = -50;           // LUFS at the left edge of the loudness bar
const TARGET = [-20, -12];        // where speech should sit (short-term LUFS)
// Verdict thresholds; the server uses the same numbers (_stream-probe.js AUDIO)
const SOUND_DB = -60;             // any channel above this counts as sound
const QUIET_LUFS = -33;           // short-term under this for 10 s = very quiet
const LOUD_LUFS = -9;             // short-term over this for 5 s = very loud
const CLIP_PEAK = 0.9886;         // sample peak at -0.1 dBFS or a true peak over 0 dBTP = distorting
const ONE_SIDED_DB = 20;
const ONE_SIDED_FLOOR = -50;
const SILENT_WARN_MS = 6000;
const QUIET_WARN_MS = 10000;
const LOUD_WARN_MS = 5000;
const HISTORY_SECONDS = 60;
const PREFS_KEY = 'soard-control-room';

// ─── Styles (scoped to .cr) ─────────────────────────────────────────

const CSS = `
.cr { display: grid; gap: 1rem; margin-bottom: 1rem; }
.cr .card { margin: 0; }
.cr-bar { display: flex; flex-wrap: wrap; gap: .5rem 1rem; align-items: center; justify-content: space-between; }
.cr-feedbar { margin-bottom: .75rem; }
.cr-chips { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; font-size: .85rem; color: var(--color-text-secondary); }
.cr-chip { display: inline-flex; align-items: center; gap: .4rem; padding: .25rem .65rem; border-radius: 999px; background: var(--color-bg); border: 1px solid var(--color-border); font-weight: 600; color: var(--color-text); white-space: nowrap; }
.cr-chip[data-tone] { background: var(--tone-bg); border-color: transparent; color: var(--tone-fg); }
button.cr-chip { cursor: pointer; font: inherit; font-weight: 600; }
.cr-dot { width: 9px; height: 9px; border-radius: 50%; flex: none; background: var(--dot, #CBD5E0); }
.cr-dot.is-live { box-shadow: 0 0 0 4px rgba(255,213,0,.3); animation: cr-pulse 1.6s ease-in-out infinite; }
@keyframes cr-pulse { 50% { box-shadow: 0 0 0 7px rgba(255,213,0,.08); } }
@media (prefers-reduced-motion: reduce) { .cr-dot.is-live, .cr-issues.is-new { animation: none; } }
.cr-main { display: grid; gap: 1rem; align-items: start; grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr); }
.cr-main.is-portrait { grid-template-columns: minmax(280px, 380px) minmax(0, 1fr); }
.cr-side { display: grid; gap: 1rem; align-content: start; min-width: 0; }
@media (max-width: 1000px) { .cr-main, .cr-main.is-portrait { grid-template-columns: 1fr; } }
.cr-stage { position: relative; background: #0f1012; border-radius: var(--radius-md); overflow: hidden; display: grid; place-items: center; }
.cr-stage video { display: block; width: 100%; height: 100%; object-fit: contain; background: #0f1012; }
.cr-stage.is-landscape { aspect-ratio: 16 / 9; }
.cr-stage.is-portrait { aspect-ratio: 9 / 16; max-height: 72vh; margin: 0 auto; }
.cr-stage.is-empty { aspect-ratio: auto; min-height: 200px; max-height: none; }
.cr-stage.is-empty video { position: absolute; inset: 0; opacity: 0; }
@media (max-width: 1000px) { .cr-stage.is-portrait:not(.is-empty) { max-width: 380px; } }
.cr-over { position: absolute; inset: 0; display: grid; place-items: center; text-align: center; padding: 1.25rem; color: #f5f4f0; font-size: .9rem; line-height: 1.5; background: rgba(15,16,18,.72); }
.cr-over strong { display: block; font-size: 1rem; margin-bottom: .25rem; color: #fff; }
.cr-stats { display: flex; flex-wrap: wrap; gap: .35rem .9rem; margin-top: .6rem; font-size: .8rem; color: var(--color-text-secondary); font-variant-numeric: tabular-nums; }
.cr-stats b { color: var(--color-text); font-weight: 600; }
.cr-verdict { display: flex; gap: .75rem; align-items: flex-start; padding: .8rem .9rem; border-radius: var(--radius-sm); background: var(--tone-bg); color: var(--tone-fg); }
.cr-verdict strong { display: block; font-size: 1rem; }
.cr-verdict p { margin: .15rem 0 0; font-size: .85rem; line-height: 1.45; }
.cr-loud { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: .5rem; margin: .9rem 0 .2rem; }
.cr-loud div { background: var(--color-bg-secondary); border-radius: 8px; padding: .45rem .6rem; }
.cr-loud span { display: block; font-size: max(11px, 0.72rem); color: var(--color-text-muted); }
.cr-loud b { font-size: 1.05rem; font-variant-numeric: tabular-nums; }
.cr-meters { display: grid; gap: .45rem; margin: .75rem 0 .25rem; }
.cr-meter { display: grid; grid-template-columns: 2.6rem 1fr 4.4rem; gap: .5rem; align-items: center; font-size: .78rem; font-variant-numeric: tabular-nums; color: var(--color-text-secondary); }
.cr-track { position: relative; height: 16px; border-radius: 4px; overflow: hidden; background: #EDECE8; }
.cr-track.is-lufs { height: 22px; }
.cr-zone { position: absolute; top: 0; bottom: 0; background: rgba(56,161,105,.13); border-left: 1px dashed rgba(56,161,105,.5); border-right: 1px dashed rgba(56,161,105,.5); }
.cr-fill { position: absolute; inset: 0 auto 0 0; width: 0; background: linear-gradient(90deg, #38A169 0%, #38A169 70%, #D69E2E 85%, #E53E3E 99%); background-size: var(--full, 300px) 100%; transition: width 100ms linear; }
.cr-track.is-lufs .cr-fill { background: linear-gradient(90deg, #A0AEC0 0%, #A0AEC0 34%, #38A169 52%, #38A169 76%, #D69E2E 84%, #E53E3E 99%); background-size: var(--full, 300px) 100%; }
.cr-peak { position: absolute; top: 0; bottom: 0; width: 2px; left: 0; background: var(--color-text); opacity: .75; }
.cr-mark { position: absolute; top: -2px; bottom: -2px; width: 3px; left: 0; background: #2D2E33; border-radius: 2px; transition: left 300ms ease-out; }
.cr-scale { display: grid; grid-template-columns: 2.6rem 1fr 4.4rem; gap: .5rem; font-size: max(11px, 0.7rem); color: var(--color-text-muted); }
.cr-scale div { position: relative; height: 1rem; }
.cr-scale div span { position: absolute; transform: translateX(-50%); font-variant-numeric: tabular-nums; }
.cr-hist { width: 100%; height: 56px; display: block; margin-top: .75rem; background: var(--color-bg-secondary); border-radius: 6px; }
.cr-row { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; margin-top: .75rem; }
.cr-note { font-size: .8rem; color: var(--color-text-muted); line-height: 1.5; }
.cr-issues { border-left: 4px solid var(--dot); }
.cr-issues.is-new { animation: cr-flash 1.2s ease-out 2; }
@keyframes cr-flash { 30% { box-shadow: 0 0 0 4px rgba(214,158,46,.35); } }
.cr-issue { display: grid; grid-template-columns: 12px minmax(0, 1fr) auto; gap: .2rem .7rem; padding: .7rem 0; border-top: 1px solid var(--color-border); align-items: baseline; }
.cr-issue:first-of-type { border-top: 0; padding-top: .2rem; }
.cr-issue .cr-dot { align-self: center; }
.cr-issue strong { font-size: .95rem; }
.cr-issue .cr-fixline { grid-column: 2 / -1; font-size: .85rem; color: var(--color-text-secondary); line-height: 1.45; }
.cr-issue .cr-slack { grid-column: 2 / -1; font-size: .78rem; color: var(--color-text-muted); }
.cr-issue time { font-size: .8rem; color: var(--color-text-muted); font-variant-numeric: tabular-nums; white-space: nowrap; }
.cr-dests { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
.cr-dest { border-top: 4px solid var(--dot); display: flex; flex-direction: column; gap: .35rem; }
.cr-dest h4 { margin: 0; font-size: .95rem; display: flex; align-items: center; gap: .5rem; justify-content: space-between; }
.cr-dest .cr-title { font-weight: 600; font-size: .9rem; }
.cr-dest .cr-detail { font-size: .82rem; color: var(--color-text-secondary); line-height: 1.45; }
.cr-dest .cr-fix { font-size: .82rem; line-height: 1.45; background: #FEFCBF; color: #744210; border-radius: 6px; padding: .45rem .6rem; }
.cr-dest .cr-actions { margin-top: auto; padding-top: .35rem; display: flex; gap: .4rem; flex-wrap: wrap; }
.cr-embed { margin-top: .5rem; border-radius: 8px; overflow: hidden; background: #000; aspect-ratio: 16 / 9; }
.cr-embed iframe { width: 100%; height: 100%; border: 0; display: block; }
.cr-pill { font-size: max(11px, 0.72rem); font-weight: 700; letter-spacing: .02em; padding: .15rem .5rem; border-radius: 999px; background: var(--tone-bg); color: var(--tone-fg); white-space: nowrap; }
.cr-go { border-left: 4px solid var(--dot); }
.cr-go-head { display: flex; justify-content: space-between; align-items: center; gap: .5rem 1rem; flex-wrap: wrap; }
.cr-go-head h3 { display: flex; align-items: center; gap: .6rem; }
.cr-check { display: grid; grid-template-columns: 1.4rem minmax(0, 1fr) auto; gap: .1rem .5rem; padding: .6rem 0; border-top: 1px solid var(--color-border); font-size: .88rem; align-items: start; }
.cr-checks { margin-top: .5rem; }
.cr-checks > .cr-check:first-child { border-top: 0; }
.cr-check i { font-style: normal; font-weight: 700; color: var(--tone-fg); text-align: center; }
.cr-check small { grid-column: 2; color: var(--color-text-muted); font-size: .8rem; line-height: 1.45; }
.cr-check .cr-fixline { grid-column: 2; font-size: .82rem; color: #744210; line-height: 1.45; }
.cr-check .cr-do { grid-column: 3; grid-row: 1 / span 3; align-self: center; white-space: nowrap; }
@media (max-width: 600px) { .cr-check .cr-do { grid-column: 2; grid-row: auto; justify-self: start; margin-top: .3rem; } }
.cr-all { margin-top: .5rem; font-size: .85rem; }
.cr-all summary { cursor: pointer; color: var(--color-text-secondary); font-weight: 600; }
.cr-toggles { display: flex; flex-wrap: wrap; gap: .4rem 1rem; font-size: .8rem; color: var(--color-text-secondary); }
.cr-toggles label { display: inline-flex; gap: .35rem; align-items: center; cursor: pointer; }
.cr-report { padding: .25rem 0 0; }
.cr-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
`;

function injectCss() {
  if (document.getElementById('cr-css')) { document.getElementById('cr-css').textContent = CSS; return; }
  const s = document.createElement('style');
  s.id = 'cr-css';
  s.textContent = CSS;
  document.head.appendChild(s);
}

// ─── Words and tones ────────────────────────────────────────────────

const TONES = {
  ok: { bg: '#C6F6D5', fg: '#22543D', dot: '#38A169', pill: 'OK' },
  wait: { bg: '#E2E8F0', fg: '#4A5568', dot: '#A0AEC0', pill: 'Starting' },
  warn: { bg: '#FEFCBF', fg: '#744210', dot: '#D69E2E', pill: 'Needs a fix' },
  bad: { bg: '#FED7D7', fg: '#822727', dot: '#E53E3E', pill: 'Problem' },
  off: { bg: '#EDF2F7', fg: '#718096', dot: '#CBD5E0', pill: 'Off' },
  unknown: { bg: '#EDF2F7', fg: '#4A5568', dot: '#A0AEC0', pill: 'Can\'t confirm' },
  idle: { bg: '#EDF2F7', fg: '#4A5568', dot: '#CBD5E0', pill: 'Ready' },
  fail: { bg: '#FED7D7', fg: '#822727', dot: '#E53E3E', pill: 'Fix first' },
};
const tone = (t) => TONES[t] || TONES.idle;
const toneStyle = (t) => `--tone-bg:${tone(t).bg};--tone-fg:${tone(t).fg};--dot:${tone(t).dot}`;
const levelTone = (level) => (level === 'error' ? 'bad' : 'warn');

const CONNECTION = {
  connected: ['ok', 'Phone connected'],
  reconnected: ['ok', 'Phone reconnected'],
  reconnecting: ['warn', 'Phone reconnecting'],
  client_disconnect: ['idle', 'Phone disconnected'],
  ttl_exceeded: ['warn', 'Connection timed out'],
  failed_to_connect: ['bad', 'Phone failed to connect'],
  failed_to_reconnect: ['bad', 'Phone failed to reconnect'],
  new_configuration_accepted: ['ok', 'Phone connected'],
};

/** Verdict → [tone, headline, fix]. Issue keys match the server's (_broadcast-monitor.js). */
const AUDIO_WORDS = {
  ok: ['ok', 'Sound is good', null],
  waiting: ['wait', 'Listening…', 'Waiting for the first sound from the mic.'],
  quiet: ['warn', 'Sound is very quiet', 'Move the mic closer to whoever is talking, or turn up the gain on the mic transmitter.'],
  loud: ['warn', 'Sound is very loud', 'Turn the gain down on the mic transmitter, or move the mic a little further from the loudest voice.'],
  clipping: ['bad', 'Too loud: the sound is distorting', 'Turn the gain down on the mic transmitter right away.'],
  silent: ['bad', 'No sound', 'Check the mic: receiver plugged into the phone, transmitter switched on and unmuted, Larix not muted.'],
  onesided: ['warn', 'Sound on one side only', 'Headphone listeners hear one ear. Set Larix audio to mono so both sides get the mic.'],
  none: ['bad', 'No audio track', 'The phone is sending video without sound. In Larix: Settings → Audio, turn audio on, then stop and restart.'],
  native: ['unknown', 'Meter not available in this browser', 'Use Chrome, Edge, Firefox, or Safari on a Mac for the sound meter. The server check below still runs.'],
};
const AUDIO_ISSUE_KEY = { silent: 'silent', none: 'noAudio', quiet: 'quiet', loud: 'loud', clipping: 'loud', onesided: 'oneSided' };

const fmtDb = (db, unit = 'dB') => (db == null || !Number.isFinite(db) || db < -100 ? (unit === 'LUFS' ? '—' : 'silent') : `${db > -10 ? db.toFixed(1) : Math.round(db)} ${unit}`);
const fmtClock = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  return `${hh ? `${hh}:${String(mm).padStart(2, '0')}` : mm}:${String(ss).padStart(2, '0')}`;
};
const ago = (iso) => {
  if (!iso) return '';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  return s < 5 ? 'just now' : s < 90 ? `${s} s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`;
};
const timeOf = (iso) => (iso ? new Date(iso).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }) : '');
const pctOf = (db, floor) => Math.max(0, Math.min(100, ((db - floor) / -floor) * 100));
const lufsOf = (power) => (power > 0 ? -0.691 + 10 * Math.log10(power) : -Infinity);

function loadPrefs() {
  try { return { sound: true, desktop: false, ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }; } catch { return { sound: true, desktop: false }; }
}
function savePrefs(p) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* private mode */ }
}

async function post(body) {
  const res = await fetch('/api/broadcast-admin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (res.status === 401 || res.status === 403) throw new Error('Your admin sign-in expired. Reload the page.');
  const d = await res.json().catch(() => null);
  if (!d) throw new Error(`The server returned ${res.status}`);
  if (!d.success) throw new Error(d.error || 'Check failed');
  return d;
}

// ─── Server report ──────────────────────────────────────────────────

function useReport(feed, phase, refreshKey) {
  const [report, setReport] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef(null);
  const live = report?.phoneLive;

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const d = await post({ action: 'monitor', feed });
      if (d.feed === feed) { setReport(d); setError(null); }
    } catch (e) {
      setError(e.message);
    }
    setBusy(false);
  }, [feed]);

  const shownFeed = useRef(feed);
  useEffect(() => {
    if (shownFeed.current !== feed) { shownFeed.current = feed; setReport(null); }
    load();
  }, [feed, phase, refreshKey]);
  useEffect(() => {
    clearInterval(timer.current);
    timer.current = setInterval(() => { if (!document.hidden) load(); }, live ? POLL_LIVE_MS : POLL_IDLE_MS);
    const onVis = () => { if (!document.hidden) load(); };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(timer.current); document.removeEventListener('visibilitychange', onVis); };
  }, [feed, live, load]);

  return { report, error, busy, refresh: load };
}

// ─── HLS player ─────────────────────────────────────────────────────

let hlsModule = null;
function loadHls() {
  hlsModule ||= import('./vendor-hls.js').then((m) => m.Hls);
  return hlsModule;
}

/**
 * Plays `urls` (LL-HLS first, plain HLS as the fallback) into videoRef while
 * `on`. Retries on its own: a feed that hasn't started yet 404s, so it waits
 * and tries again rather than giving up.
 */
function usePlayer(videoRef, urls, on) {
  const [st, setSt] = useState({ state: 'off' });
  const ref = useRef({ hls: null, retry: null, stalls: 0, useLl: true });

  useEffect(() => {
    const video = videoRef.current;
    const r = ref.current;
    let dead = false;
    const stop = () => {
      clearTimeout(r.retry);
      if (r.hls) { try { r.hls.destroy(); } catch {} r.hls = null; }
    };
    if (!on || !video || !urls?.hls) { stop(); setSt({ state: 'off' }); return stop; }

    const start = async () => {
      stop();
      let Hls;
      try { Hls = await loadHls(); } catch (e) { setSt({ state: 'error', error: `Player didn't load: ${e.message}` }); return; }
      if (dead) return;
      if (!Hls.isSupported()) {
        // iPhone Safari without MSE: picture works natively, the meter can't hear it
        video.src = urls.hls;
        video.play().catch(() => {});
        setSt({ state: 'native' });
        return;
      }
      const src = r.useLl && urls.llhls ? urls.llhls : urls.hls;
      const hls = new Hls({ enableWorker: false, lowLatencyMode: true, backBufferLength: 20, capLevelToPlayerSize: true, manifestLoadingMaxRetry: 1, levelLoadingMaxRetry: 4, fragLoadingMaxRetry: 4 });
      r.hls = hls;
      setSt((s) => ({ ...s, state: 'loading', error: null }));
      hls.on(Hls.Events.MANIFEST_PARSED, (_e, d) => {
        const codecs = d.levels.map((l) => `${l.audioCodec || ''} ${l.attrs?.CODECS || ''}`).join(' ');
        const hasAudio = (d.audioTracks?.length || 0) > 0 || /mp4a|ac-3|ec-3|opus/i.test(codecs);
        const top = [...d.levels].sort((a, b) => b.bitrate - a.bitrate)[0];
        setSt((s) => ({ ...s, state: 'buffering', hasAudio, top: top ? { width: top.width, height: top.height, bitrate: top.bitrate, fps: Number(top.attrs?.['FRAME-RATE']) || null } : null, renditions: d.levels.length, ll: src === urls.llhls }));
        video.play().catch(() => {});
      });
      hls.on(Hls.Events.LEVEL_SWITCHED, (_e, d) => {
        const l = hls.levels[d.level];
        if (l) setSt((s) => ({ ...s, playing: { width: l.width, height: l.height, bitrate: l.bitrate } }));
      });
      hls.on(Hls.Events.ERROR, (_e, d) => {
        if (d.details === 'bufferStalledError') { r.stalls++; setSt((s) => ({ ...s, stalls: r.stalls })); }
        if (!d.fatal) return;
        const code = d.response?.code;
        if (d.type === 'mediaError') { hls.recoverMediaError(); return; }
        // LL-HLS refused? Fall back to plain HLS once.
        if (r.useLl && urls.llhls && code && code !== 404) { r.useLl = false; start(); return; }
        stop();
        setSt((s) => ({ ...s, state: code === 404 ? 'waiting' : 'retrying', error: code === 404 ? null : (d.details || 'network error') }));
        r.retry = setTimeout(() => { if (!dead) start(); }, code === 404 ? 4000 : 3000);
      });
      hls.loadSource(src);
      hls.attachMedia(video);
    };

    const onPlaying = () => setSt((s) => ({ ...s, state: 'playing' }));
    const onWaiting = () => setSt((s) => (s.state === 'playing' ? { ...s, state: 'buffering' } : s));
    video.addEventListener('playing', onPlaying);
    video.addEventListener('waiting', onWaiting);
    start();
    return () => { dead = true; stop(); video.removeEventListener('playing', onPlaying); video.removeEventListener('waiting', onWaiting); };
  }, [on, urls?.hls, urls?.llhls]);

  // Delay behind the phone, ~1 Hz (live playlists only)
  useEffect(() => {
    if (!on) return undefined;
    const t = setInterval(() => {
      const hls = ref.current.hls;
      if (!hls) return;
      const details = hls.latestLevelDetails || hls.levels?.[hls.currentLevel]?.details;
      const date = hls.playingDate;
      const behind = !details?.live ? null : date ? (Date.now() - date.getTime()) / 1000 : (Number.isFinite(hls.latency) ? hls.latency : null);
      setSt((s) => ({ ...s, behind: behind != null && behind >= 0 && behind < 600 ? behind : null }));
    }, 1000);
    return () => clearInterval(t);
  }, [on]);

  return st;
}

// ─── Picture check (black / frozen) ─────────────────────────────────

function usePicture(videoRef, on) {
  const [pic, setPic] = useState({ dark: false, frozen: false, width: 0, height: 0 });
  useEffect(() => {
    if (!on) { setPic({ dark: false, frozen: false, width: 0, height: 0 }); return undefined; }
    const canvas = document.createElement('canvas');
    canvas.width = 32; canvas.height = 18;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    let darkSince = null, lastTime = -1, stuckSince = null;
    const t = setInterval(() => {
      const v = videoRef.current;
      if (!v || v.readyState < 2) return;
      const now = Date.now();
      let luma = null;
      try {
        ctx.drawImage(v, 0, 0, 32, 18);
        const px = ctx.getImageData(0, 0, 32, 18).data;
        let sum = 0;
        for (let i = 0; i < px.length; i += 4) sum += 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2];
        luma = sum / (px.length / 4) / 255;
      } catch { /* not ready */ }
      darkSince = luma != null && luma < 0.05 ? (darkSince || now) : null;
      if (!v.paused && v.currentTime === lastTime) stuckSince ||= now; else stuckSince = null;
      lastTime = v.currentTime;
      setPic({ dark: !!darkSince && now - darkSince > 5000, frozen: !!stuckSince && now - stuckSince > 6000, width: v.videoWidth, height: v.videoHeight });
    }, 1000);
    return () => clearInterval(t);
  }, [on]);
  return pic;
}

// ─── Loudness meter ─────────────────────────────────────────────────

/**
 * Web Audio graph: <video> → speaker up-mix to 2 channels (so a mono mic
 * shows on both sides) → meter worklet, and → gain (0 unless listening) →
 * speakers. The element stays unmuted: a muted element feeds silence.
 * Bars are written straight to the DOM through `bars`.
 */
function useMeter(videoRef, on, bars) {
  const [m, setM] = useState({ running: false, needsGesture: false, unsupported: false, verdict: 'waiting', listen: false });
  const g = useRef({ ctx: null, node: null, gain: null, building: null, hist: [], onBlock: null });

  const ensureGraph = useCallback(async () => {
    const video = videoRef.current;
    const s = g.current;
    if (!video) return false;
    if (!s.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) { setM((x) => ({ ...x, unsupported: true })); return false; }
      s.ctx = new AC();
      s.building = (async () => {
        try {
          await s.ctx.audioWorklet.addModule(new URL('./meter-worklet.js', import.meta.url));
        } catch {
          setM((x) => ({ ...x, unsupported: true }));
          return false;
        }
        const src = s.ctx.createMediaElementSource(video);
        const up = s.ctx.createGain();
        up.channelCount = 2; up.channelCountMode = 'explicit'; up.channelInterpretation = 'speakers';
        s.node = new AudioWorkletNode(s.ctx, 'soard-meter', { numberOfInputs: 1, numberOfOutputs: 0, channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'speakers' });
        s.node.port.onmessage = (e) => s.onBlock?.(e.data);
        s.gain = s.ctx.createGain();
        s.gain.gain.value = 0;
        src.connect(up).connect(s.node);
        src.connect(s.gain).connect(s.ctx.destination);
        return true;
      })();
    }
    if (!(await s.building)) return false;
    if (s.ctx.state !== 'running') { try { await s.ctx.resume(); } catch {} }
    const ok = s.ctx.state === 'running';
    if (ok) { video.muted = false; video.volume = 1; }
    setM((x) => ({ ...x, running: ok, needsGesture: !ok }));
    return ok;
  }, []);

  useEffect(() => {
    if (!on) return undefined;
    const s = g.current;
    const t0 = Date.now();
    const st = { blocks: [], mom: [], chE: [[], []], lastSound: t0, lastClip: 0, loudSince: null, quietSince: null, started: t0, everSound: false, pausedAt: 0, lastUi: 0, lastHist: 0, peakHold: [{ v: 0, at: 0 }, { v: 0, at: 0 }], disp: [BAR_FLOOR, BAR_FLOOR], tpMax: 0, integrated: null, n: 0 };
    s.onBlock = (b) => {
      const video = videoRef.current;
      const now = Date.now();
      // Buffering isn't silence: stop the clocks while nothing plays
      if (!video || video.paused || video.readyState < 3) { st.pausedAt ||= now; return; }
      if (st.pausedAt) { const d = now - st.pausedAt; st.lastSound += d; if (st.loudSince) st.loudSince += d; if (st.quietSince) st.quietSince += d; st.pausedAt = 0; }
      const k = b.kms[0] + b.kms[1];
      st.blocks.push(k);
      if (st.blocks.length > 30) st.blocks.shift();
      const mean = (arr) => arr.reduce((a, x) => a + x, 0) / arr.length;
      const momentary = st.blocks.length >= 4 ? lufsOf(mean(st.blocks.slice(-4))) : null;
      const shortTerm = st.blocks.length >= 30 ? lufsOf(mean(st.blocks)) : null;
      if (st.blocks.length >= 4) st.mom.push(mean(st.blocks.slice(-4)));
      const rms = b.ms.map((x) => 10 * Math.log10(x || 1e-12));
      const peak = Math.max(...b.peak), tp = Math.max(...b.tp);
      if (tp > st.tpMax) st.tpMax = tp;
      if (Math.max(...rms) > SOUND_DB) { st.lastSound = now; st.everSound = true; }
      if (peak >= CLIP_PEAK || tp > 1) st.lastClip = now;
      if (shortTerm != null) {
        st.loudSince = shortTerm > LOUD_LUFS ? (st.loudSince || now) : null;
        st.quietSince = shortTerm < QUIET_LUFS ? (st.quietSince || now) : null;
      }
      for (let c = 0; c < 2; c++) { st.chE[c].push(b.ms[c]); if (st.chE[c].length > 80) st.chE[c].shift(); }

      // Bars: channel RMS with ~24 dB/s release, sample-peak marker held 1.5 s; loudness bar = momentary, mark = short-term
      for (let c = 0; c < 2; c++) {
        st.disp[c] = Math.max(rms[c], st.disp[c] - 2.4);
        const hold = st.peakHold[c];
        if (b.peak[c] >= hold.v || now - hold.at > 1500) { hold.v = b.peak[c]; hold.at = now; }
        const bar = bars.current?.[c];
        if (bar?.fill) { bar.fill.style.width = `${pctOf(st.disp[c], BAR_FLOOR)}%`; bar.peak.style.left = `calc(${pctOf(20 * Math.log10(hold.v || 1e-9), BAR_FLOOR)}% - 1px)`; bar.label.textContent = fmtDb(rms[c]); }
      }
      const lb = bars.current?.[2];
      if (lb?.fill && momentary != null) { lb.fill.style.width = `${pctOf(momentary, LUFS_FLOOR)}%`; if (shortTerm != null) lb.mark.style.left = `calc(${pctOf(shortTerm, LUFS_FLOOR)}% - 1px)`; lb.label.textContent = fmtDb(momentary, 'LUFS'); }

      if (shortTerm != null && now - st.lastHist >= 250) { st.lastHist = now; s.hist.push(shortTerm); if (s.hist.length > HISTORY_SECONDS * 4) s.hist.shift(); }
      if (now - st.lastUi < 400) return;
      st.lastUi = now;
      // Gated integrated loudness since the meter started (BS.1770: -70 absolute, -10 relative)
      if (st.mom.length && ++st.n % 3 === 0) {
        const loud = st.mom.filter((p) => lufsOf(p) > -70);
        if (loud.length) {
          const gate = lufsOf(mean(loud)) - 10;
          const kept = loud.filter((p) => lufsOf(p) > gate);
          st.integrated = lufsOf(mean(kept));
        }
      }
      const e = st.chE.map((list) => 10 * Math.log10(mean(list) || 1e-12));
      const oneSided = Math.max(...e) > ONE_SIDED_FLOOR && Math.abs(e[0] - e[1]) > ONE_SIDED_DB && now - st.started > 8000 ? (e[0] > e[1] ? 'left' : 'right') : null;
      const silentFor = now - st.lastSound;
      let verdict = 'ok';
      if (silentFor > SILENT_WARN_MS) verdict = 'silent';
      else if (now - st.lastClip < 3000) verdict = 'clipping';
      else if (st.loudSince && now - st.loudSince > LOUD_WARN_MS) verdict = 'loud';
      else if (oneSided) verdict = 'onesided';
      else if (st.quietSince && now - st.quietSince > QUIET_WARN_MS) verdict = 'quiet';
      else if (!st.everSound) verdict = 'waiting';
      setM((x) => ({ ...x, verdict, silentFor, oneSided, momentary, shortTerm, integrated: st.integrated, truePeak: st.tpMax ? 20 * Math.log10(st.tpMax) : null, chDb: e, hist: s.hist.slice(), running: true, needsGesture: false }));
    };
    ensureGraph();
    return () => { s.onBlock = null; };
  }, [on]);

  useEffect(() => () => { const s = g.current; try { s.ctx?.close(); } catch {} }, []);

  const setListen = useCallback(async (listen) => {
    const ok = await ensureGraph();
    const s = g.current;
    if (ok && s.gain) s.gain.gain.setTargetAtTime(listen ? 1 : 0, s.ctx.currentTime, 0.02);
    setM((x) => ({ ...x, listen: ok && listen }));
  }, [ensureGraph]);

  return { ...m, start: ensureGraph, setListen };
}

// ─── Attention: chime, tab title, desktop notifications ─────────────

let chimeCtx = null;
function chime(level) {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    chimeCtx ||= new AC();
    if (chimeCtx.state !== 'running') chimeCtx.resume();
    const t = chimeCtx.currentTime;
    const notes = level === 'error' ? [880, 660, 880] : [660, 880];
    notes.forEach((f, i) => {
      const o = chimeCtx.createOscillator(), gn = chimeCtx.createGain();
      o.frequency.value = f;
      gn.gain.setValueAtTime(0.0001, t + i * 0.18);
      gn.gain.exponentialRampToValueAtTime(0.18, t + i * 0.18 + 0.02);
      gn.gain.exponentialRampToValueAtTime(0.0001, t + i * 0.18 + 0.16);
      o.connect(gn).connect(chimeCtx.destination);
      o.start(t + i * 0.18); o.stop(t + i * 0.18 + 0.17);
    });
  } catch { /* no audio output */ }
}

function useAttention(issues, prefs) {
  const seen = useRef(null);
  const baseTitle = useRef(document.title.replace(/^⚠ [^·]*· /, ''));
  const [fresh, setFresh] = useState(false);
  useEffect(() => {
    const keys = new Set(issues.map((i) => i.key));
    if (seen.current) {
      const added = issues.filter((i) => !seen.current.has(i.key));
      if (added.length) {
        const worst = added.find((i) => i.level === 'error') || added[0];
        if (prefs.sound) chime(worst.level);
        if (prefs.desktop && 'Notification' in window && Notification.permission === 'granted' && (document.hidden || !document.hasFocus())) {
          try { new Notification(worst.title, { body: worst.fix || '', tag: `soard-${worst.key}`, icon: '/apple-touch-icon.png' }); } catch { /* blocked */ }
        }
        setFresh(true);
        setTimeout(() => setFresh(false), 3000);
      }
    }
    seen.current = keys;
    document.title = issues.length ? `⚠ ${issues[0].title} · ${baseTitle.current}` : baseTitle.current;
  }, [issues.map((i) => i.key).join(',')]);
  useEffect(() => () => { document.title = baseTitle.current; }, []);
  return fresh;
}

/**
 * Everything wrong right now: the server's open issues (with their Slack
 * status) plus what this page sees first (the meter, the picture, a
 * destination that just turned yellow). Same keys as the server, so an
 * issue shows once.
 */
function mergeIssues({ report, audioKey, pic, phase, live, since }) {
  const server = report?.watch?.issues || [];
  const byKey = new Map(server.map((i) => [i.key, { ...i, source: 'server' }]));
  const local = [];
  const add = (key, level, title, fix) => { if (!byKey.has(key)) local.push({ key, level, title, fix, source: 'here' }); };
  if (live) {
    const issueKey = AUDIO_ISSUE_KEY[audioKey];
    if (issueKey) add(issueKey, audioKey === 'silent' || audioKey === 'none' || audioKey === 'clipping' ? 'error' : 'warn', AUDIO_WORDS[audioKey][1], AUDIO_WORDS[audioKey][2]);
    if (pic.frozen) add('frozen', 'error', 'The picture has stopped moving', 'The phone may be losing signal: switch Larix to the weak-signal profile, or move toward better coverage.');
    if (pic.dark) add('dark', 'warn', 'The picture is black', 'Is the lens covered, or did the phone switch apps?');
    if (report?.watch?.signal?.status === 'weak') add('weakSignal', 'warn', 'The phone\'s signal is weak', 'Switch Larix to the Weak signal profile (Settings → Phones), or move toward better coverage.');
    for (const [key, label] of [['facebook', 'Facebook'], ['youtube', 'YouTube']]) {
      const d = report?.destinations?.[key];
      if (d?.status === 'warn') add(key, 'warn', `${label}: ${d.title.toLowerCase()}`, d.fix || d.detail);
    }
  }
  if (phase === 'ending') add('disconnected', 'error', 'The phone lost its connection', 'Check that Larix is still streaming. If it stopped, tap Start: the reveal picks up where it left off.');
  const now = Date.now();
  for (const i of local) { since.current[i.key] ||= new Date(now).toISOString(); i.since = since.current[i.key]; }
  for (const k of Object.keys(since.current)) if (!local.some((i) => i.key === k)) delete since.current[k];
  return [...byKey.values(), ...local].sort((a, b) => (a.level === 'error' ? 0 : 1) - (b.level === 'error' ? 0 : 1));
}

// ─── Pieces ─────────────────────────────────────────────────────────

function Scale({ floor, ticks, unit }) {
  return html`<div class="cr-scale" aria-hidden="true"><span>${unit}</span><div>${ticks.map((t) => html`<span style=${`left:${pctOf(t, floor)}%`}>${t}</span>`)}</div><span></span></div>`;
}

function History({ hist }) {
  const n = HISTORY_SECONDS * 4;
  const y = (db) => 56 - (pctOf(db, LUFS_FLOOR) / 100) * 52 - 2;
  const pts = (hist || []).map((db, i, a) => `${((n - a.length + i) / (n - 1)) * 240},${y(db).toFixed(1)}`).join(' ');
  return html`<svg class="cr-hist" viewBox="0 0 240 56" preserveAspectRatio="none" role="img" aria-label="Short-term loudness over the last minute">
    <rect x="0" width="240" y=${y(TARGET[1])} height=${y(TARGET[0]) - y(TARGET[1])} fill="rgba(56,161,105,.12)" />
    <line x1="0" x2="240" y1=${y(QUIET_LUFS)} y2=${y(QUIET_LUFS)} stroke="#CBD5E0" stroke-dasharray="3 3" stroke-width="1" vector-effect="non-scaling-stroke" />
    ${pts ? html`<polyline points=${pts} fill="none" stroke="#2D2E33" stroke-width="1.5" stroke-linejoin="round" vector-effect="non-scaling-stroke" />` : null}
  </svg>`;
}

function Destination({ name, d, embedUrl }) {
  const [show, setShow] = useState(false);
  if (!d) return null;
  const t = d.status || 'idle';
  return html`<div class="card cr-dest" style=${toneStyle(t)}>
    <h4><span>${name}</span><span class="cr-pill">${tone(t).pill}</span></h4>
    <div class="cr-title">${d.title}</div>
    ${d.detail ? html`<div class="cr-detail">${d.detail}</div>` : null}
    ${d.fix ? html`<div class="cr-fix">${d.fix}</div>` : null}
    <div class="cr-actions">
      ${d.action ? html`<a class="btn btn-primary btn-sm" href=${d.action.url} target="_blank" rel="noopener">${d.action.label} ↗</a>` : null}
      ${d.url ? html`<a class="btn btn-ghost btn-sm" href=${d.url} target="_blank" rel="noopener">Open ↗</a>` : null}
      ${embedUrl ? html`<button class="btn btn-ghost btn-sm" type="button" aria-expanded=${show} onClick=${() => setShow(!show)}>${show ? 'Hide player' : 'Watch here'}</button>` : null}
    </div>
    ${show && embedUrl ? html`<div class="cr-embed"><iframe src=${embedUrl} title=${`${name} live player`} allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe></div>` : null}
  </div>`;
}

function Issues({ issues, fresh, slackOn, prefs, setPrefs, log, watchAt }) {
  const [showLog, setShowLog] = useState(false);
  const worst = issues.find((i) => i.level === 'error') ? 'bad' : issues.length ? 'warn' : 'ok';
  const askDesktop = async (on) => {
    if (on && 'Notification' in window && Notification.permission !== 'granted') {
      const p = await Notification.requestPermission().catch(() => 'denied');
      if (p !== 'granted') return;
    }
    setPrefs({ ...prefs, desktop: on });
  };
  const slackLine = (i) => {
    if (i.source === 'server') {
      if (i.slack?.skipped) return 'Slack isn\'t set up, so this wasn\'t posted.';
      const posted = `Posted to Slack ${timeOf(i.postedAt)}${i.reminders ? `, reminded ${i.reminders}×` : ''}`;
      return i.slack?.ok === false ? `Slack post failed (${i.slack.error || 'no reply'}). Tell the team directly.` : posted;
    }
    return slackOn ? 'Seen here first. The server posts it to Slack if it lasts.' : 'Seen here. Slack isn\'t set up.';
  };
  return html`<div class=${`card cr-issues ${fresh ? 'is-new' : ''}`} style=${toneStyle(worst)} aria-live="polite">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:.5rem;flex-wrap:wrap;margin-bottom:.4rem">
      <h3 style="margin:0">${issues.length ? `${issues.length} issue${issues.length > 1 ? 's' : ''} right now` : 'No issues'}</h3>
      <div class="cr-toggles">
        <label><input type="checkbox" checked=${prefs.sound} onChange=${(e) => setPrefs({ ...prefs, sound: e.target.checked })} /> Sound alert</label>
        ${'Notification' in window ? html`<label><input type="checkbox" checked=${prefs.desktop && Notification.permission === 'granted'} onChange=${(e) => askDesktop(e.target.checked)} /> Desktop alert</label>` : null}
        ${log?.length ? html`<button class="btn btn-ghost btn-sm" type="button" aria-expanded=${showLog} onClick=${() => setShowLog(!showLog)}>Slack activity (${log.length})</button>` : null}
      </div>
    </div>
    ${issues.length ? issues.map((i) => html`<div class="cr-issue" style=${toneStyle(levelTone(i.level))}>
        <span class="cr-dot"></span>
        <strong>${i.title}</strong>
        <time title=${i.since ? new Date(i.since).toLocaleString() : ''}>${i.since ? `for ${fmtClock(Date.now() - Date.parse(i.since))}` : ''}</time>
        ${i.fix ? html`<div class="cr-fixline">${i.fix}</div>` : null}
        <div class="cr-slack">${slackLine(i)}</div>
      </div>`)
      : html`<p class="cr-note" style="margin:0">${slackOn
        ? `Problems show here first. The server ${watchAt ? `last checked the feed ${ago(watchAt)} and ` : ''}posts anything that lasts to Slack, even with this page closed.`
        : 'Problems show here. Slack alerts aren\'t set up (Settings → Alerts), so nobody away from this page will hear about them.'}</p>`}
    ${showLog ? html`<div style="margin-top:.6rem">${log.slice().reverse().map((l) => html`<div class="cr-note">${timeOf(l.at)} · ${{ open: 'Posted', reminder: 'Reminder', resolved: 'Resolved' }[l.kind] || l.kind}: ${l.title}${l.slack && l.slack.ok === false ? ' (Slack post failed)' : ''}</div>`)}</div>` : null}
  </div>`;
}

const CHECK_ICON = { ok: '✓', warn: '!', fail: '×', unknown: '?', off: '–' };
const checkTone = (s) => (s === 'fail' ? 'fail' : s === 'ok' ? 'ok' : s === 'unknown' ? 'unknown' : 'warn');

/**
 * Go / no-go before a reveal. Lists only what needs attention; the full
 * list folds away. `actions` maps an item key to the button that fixes it:
 * { label, onClick } or { label, href }. Bump `refreshKey` to run it again
 * (after a mic check, say).
 */
export function Preflight({ initial = null, actions = {}, refreshKey = 0 }) {
  useEffect(injectCss, []);
  const [res, setRes] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const run = async () => {
    setBusy(true); setErr(null);
    try { setRes(await post({ action: 'preflight' })); } catch (e) { setErr(e.message); }
    setBusy(false);
  };
  const first = useRef(true);
  useEffect(() => { if (!initial || !first.current) run(); first.current = false; }, [refreshKey]);
  const items = (res?.items || []).filter((i) => i.status !== 'off');
  const open = items.filter((i) => i.status !== 'ok');
  const verdict = !res ? null : !res.ready ? ['fail', 'No-go: fix these first'] : open.length ? ['warn', 'Go, with notes'] : ['ok', 'Go: everything checks out'];
  const row = (i, withAction) => {
    const a = withAction && i.status !== 'ok' ? actions[i.key] : null;
    return html`<div class="cr-check" style=${toneStyle(checkTone(i.status))}>
      <i aria-label=${i.status}>${CHECK_ICON[i.status]}</i><span>${i.label}</span>
      ${i.detail ? html`<small>${i.detail}</small>` : null}
      ${i.fix && i.status !== 'ok' ? html`<span class="cr-fixline">${i.fix}</span>` : null}
      ${a ? (a.href
        ? html`<a class="btn btn-ghost btn-sm cr-do" href=${a.href} target="_blank" rel="noopener">${a.label} ↗</a>`
        : html`<button class="btn btn-secondary btn-sm cr-do" type="button" onClick=${a.onClick}>${a.label}</button>`) : null}
    </div>`;
  };
  return html`<div class="card cr-go" style=${toneStyle(verdict ? verdict[0] : 'idle')}>
    <div class="cr-go-head">
      <h3>Go / no-go ${verdict ? html`<span class="cr-pill">${verdict[1]}</span>` : null}</h3>
      <div class="cr-chips">${res?.at ? html`<span>Checked ${ago(res.at)}</span>` : null}<button class="btn btn-ghost btn-sm" type="button" disabled=${busy} onClick=${run}>${busy ? 'Checking…' : 'Run again'}</button></div>
    </div>
    ${err ? html`<p class="cr-note" style="color:#744210">${err}</p>` : null}
    ${!res && !err ? html`<p class="cr-note">Checking…</p>` : null}
    ${open.length ? html`<div class="cr-checks">${open.map((i) => row(i, true))}</div>` : null}
    ${items.length ? html`<details class="cr-all"><summary>${open.length ? `All ${items.length} checks` : `All ${items.length} checks pass`}</summary><div class="cr-checks">${items.map((i) => row(i, false))}</div></details>` : null}
    <p class="cr-note" style="margin:.6rem 0 0">Runs by itself an hour before the reveal and posts to Slack, and again 10 minutes before if anything is still open.</p>
  </div>`;
}

/** One reveal's health report, for its row in History. Times are minutes into the reveal. */
export function HealthReport({ report: x }) {
  useEffect(injectCss, []);
  if (!x) return null;
  const at = (s) => (s == null ? '' : fmtClock(s * 1000));
  const parts = [
    x.okPct != null ? `Sound good ${x.okPct}%` : null,
    x.lufs != null ? `avg ${Math.round(x.lufs)} LUFS` : null,
    `${x.issues?.length || 0} issue${(x.issues?.length || 0) === 1 ? '' : 's'}`,
    x.fb != null ? `Facebook +${at(x.fb)}` : null,
    x.yt != null ? `YouTube +${at(x.yt)}` : null,
    x.peak != null ? `peak ${x.peak} watching` : null,
    x.reconnects ? `${x.reconnects} reconnect${x.reconnects > 1 ? 's' : ''}` : null,
  ].filter(Boolean);
  const series = (x.series || []).filter((p) => p[1] != null);
  const maxT = Math.max(1, ...(x.series || []).map((p) => p[0]));
  const y = (l) => 40 - (pctOf(l, LUFS_FLOOR) / 100) * 36 - 2;
  return html`<div class="cr-report">
    <div><strong style="font-size:.9rem">Feed health</strong> <span class="cr-note">${x.minutes} min · ${parts.join(' · ')}</span></div>
    ${series.length > 1 ? html`<svg class="cr-hist" style="height:40px" viewBox="0 0 240 40" preserveAspectRatio="none" role="img" aria-label="Loudness through the reveal">
      <rect x="0" width="240" y=${y(TARGET[1])} height=${y(TARGET[0]) - y(TARGET[1])} fill="rgba(56,161,105,.12)" />
      <polyline points=${series.map((p) => `${(p[0] / maxT) * 240},${y(p[1]).toFixed(1)}`).join(' ')} fill="none" stroke="#2D2E33" stroke-width="1.5" vector-effect="non-scaling-stroke" />
    </svg>` : null}
    ${x.issues?.length ? html`<ul style="margin:.5rem 0 0;padding-left:1.1rem;font-size:.85rem;line-height:1.6">${x.issues.map((i) => html`<li>${at(i.at)}: ${i.t} for ${at(i.s)}${i.e ? ' (still open at the end)' : ''}</li>`)}</ul>` : html`<p class="cr-note" style="margin:.4rem 0 0">No issues during the reveal.</p>`}
  </div>`;
}

// ─── Control room ───────────────────────────────────────────────────

/**
 * Props
 *   feed        'live' (the reveal) or 'rehearsal' (the private mic check)
 *   phase       broadcast phase from the parent (refreshes the report on change)
 *   refreshKey  bump to check the feed right now (the page's Refresh button)
 */
export function ControlRoom({ feed = 'live', phase, refreshKey = 0 }) {
  useEffect(injectCss, []);
  const [prefs, setPrefsState] = useState(loadPrefs);
  const setPrefs = (p) => { setPrefsState(p); savePrefs(p); };
  const { report, error } = useReport(feed, phase, refreshKey);
  const videoRef = useRef(null);
  // Start muted so autoplay is allowed; the sound check unmutes it (a gain node keeps it quiet)
  const muteOnce = useCallback((el) => { if (el && videoRef.current !== el) { el.muted = true; el.autoplay = true; } videoRef.current = el; }, []);
  const bars = useRef([]);
  const since = useRef({});
  const live = !!report?.phoneLive;
  const player = usePlayer(videoRef, report?.playback, live);
  const pic = usePicture(videoRef, live && player.state === 'playing');
  const meter = useMeter(videoRef, live && player.state !== 'native' && player.state !== 'off', bars);
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, []);

  const probe = report?.probe;
  const said = CONNECTION[report?.connection];
  const conn = live ? (said && said[0] !== 'idle' ? said : ['ok', 'Receiving video'])
    : said && said[0] === 'ok' ? ['wait', 'Phone connected, video starting']
    : said && (said[0] === 'bad' || said[0] === 'warn') ? said
    : ['idle', 'Phone not connected'];
  const portrait = pic.width && pic.height ? pic.height > pic.width : report?.orientation === 'portrait';

  // Audio verdict: the server knows "no track" for sure; the meter knows everything else
  let audioKey = meter.verdict;
  if (probe?.audio?.present === false || (player.hasAudio === false && player.state !== 'loading')) audioKey = 'none';
  else if (player.state === 'native' || meter.unsupported) audioKey = 'native';
  else if (!meter.running && meter.needsGesture) audioKey = null;
  const words = audioKey ? AUDIO_WORDS[audioKey] : null;
  let detail = words?.[2];
  if (audioKey === 'ok' && meter.shortTerm != null) detail = `${fmtDb(meter.shortTerm, 'LUFS')} over the last 3 seconds. Speech sits best between ${TARGET[0]} and ${TARGET[1]}.`;
  if (audioKey === 'silent' && meter.silentFor) detail = `Nothing for ${Math.round(meter.silentFor / 1000)} s. ${words[2]}`;
  if (audioKey === 'onesided') detail = `Only the ${meter.oneSided} side has sound. ${words[2]}`;
  if ((audioKey === 'quiet' || audioKey === 'loud') && meter.shortTerm != null) detail = `${fmtDb(meter.shortTerm, 'LUFS')} (speech sits best between ${TARGET[0]} and ${TARGET[1]}). ${words[2]}`;

  const issues = feed === 'live' ? mergeIssues({ report, audioKey, pic, phase, live, since }) : [];
  const fresh = useAttention(feed === 'live' ? issues : [], prefs);

  const overlay = !report ? ['Checking the feed…', null]
    : !report.ready ? ['No input yet', report.error]
    : !live ? (feed === 'rehearsal'
      ? ['Rehearsal feed is idle', 'Start Larix on the Rehearsal profile. Picture and sound show up here within a few seconds.']
      : [phase === 'ending' ? 'Phone disconnected' : 'Waiting for the phone', phase === 'ending' ? 'Waiting up to 45 seconds for it to come back.' : 'When Larix connects, the picture and sound show up here within a few seconds.'])
    : player.state === 'waiting' ? ['Stream is starting', 'The phone is connected; the first video is on its way.']
    : player.state === 'retrying' ? ['Reconnecting the player…', player.error]
    : player.state === 'error' ? ['Player error', player.error]
    : player.state === 'loading' ? ['Loading…', null]
    : null;

  const top = probe?.video || player.top;
  const stats = [
    top?.height ? html`Feed <b>${Math.min(top.width, top.height)}p</b>${top.fps ? html` · <b>${Math.round(top.fps)} fps</b>` : null}` : null,
    player.playing?.height ? html`playing <b>${Math.min(player.playing.width, player.playing.height)}p</b> here` : null,
    player.behind != null ? html`<b>${Math.round(player.behind)} s</b> behind the phone` : null,
    player.stalls ? html`<b>${player.stalls}</b> stall${player.stalls > 1 ? 's' : ''}` : null,
    probe?.video?.renditions > 1 ? html`${probe.video.renditions} quality levels for viewers` : null,
    report?.at ? html`checked ${ago(report.at)}` : null,
  ].filter(Boolean);

  const signal = feed === 'live' && live ? report?.watch?.signal : null;
  const dests = feed === 'live' ? report?.destinations : null;
  const fbEmbed = dests?.facebook?.status === 'ok' && dests.facebook.url && /facebook\.com\/.*(videos|watch)/.test(dests.facebook.url)
    ? `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(dests.facebook.url)}&show_text=false&autoplay=true&mute=1` : null;

  // Phone, signal and freshness sit on the picture's own card, so they read as the feed's status
  const feedBar = html`<div class="cr-bar cr-feedbar">
    <div class="cr-chips">
      <span class="cr-chip" data-tone style=${toneStyle(conn[0])}><span class=${`cr-dot ${live ? 'is-live' : ''}`} style=${live ? '--dot:#FFD500' : ''}></span>${conn[1]}</span>
      ${signal ? html`<span class="cr-chip" data-tone style=${toneStyle(signal.status === 'strong' ? 'ok' : 'warn')} title=${signal.ratio != null ? `Video arriving at ${Math.round(signal.ratio * 100)}% of real time${signal.reconnects5m ? `, ${signal.reconnects5m} reconnect(s) in 5 min` : ''}` : ''}>Signal ${signal.status}</span>` : null}
      ${report && report.slack === false && feed === 'live' ? html`<span class="cr-chip" data-tone style=${toneStyle('warn')}>Slack alerts off</span>` : null}
    </div>
    ${error ? html`<span class="cr-note" style="color:#744210">${error}</span>` : null}
  </div>`;

  const stage = html`<div class="card">
    ${feedBar}
    <div class=${`cr-stage ${portrait ? 'is-portrait' : 'is-landscape'}${live && player.state !== 'off' ? '' : ' is-empty'}`}>
      <video ref=${muteOnce} playsinline aria-label=${feed === 'rehearsal' ? 'Rehearsal feed preview' : 'Live feed preview'}></video>
      ${overlay ? html`<div class="cr-over"><div><strong>${overlay[0]}</strong>${overlay[1] || ''}</div></div>` : null}
    </div>
    ${stats.length ? html`<div class="cr-stats">${stats.map((x) => html`<span>${x}</span>`)}</div>` : null}
  </div>`;

  const barRef = (i) => (el) => {
    if (!el) return;
    bars.current[i] = { fill: el.querySelector('.cr-fill'), peak: el.querySelector('.cr-peak'), mark: el.querySelector('.cr-mark'), label: el.parentElement.querySelector('.cr-db') };
    el.querySelector('.cr-fill').style.setProperty('--full', `${el.clientWidth}px`);
  };
  const audioCard = html`<div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:.5rem;margin-bottom:.75rem">
      <h3 style="margin:0">Sound</h3>
      ${live && audioKey !== 'native' ? html`<button class="btn btn-ghost btn-sm" type="button" aria-pressed=${meter.listen} onClick=${() => meter.setListen(!meter.listen)}>${meter.listen ? 'Stop listening' : 'Listen here'}</button>` : null}
    </div>
    ${!live ? html`<p class="cr-note" style="margin:0">The meter starts when the phone is live.</p>`
      : meter.needsGesture && audioKey !== 'none' ? html`<div class="cr-verdict" style=${toneStyle('wait')}><div><strong>Turn on the sound check</strong><p>The browser needs one click before it can listen.</p><button class="btn btn-primary btn-sm" type="button" style="margin-top:.5rem" onClick=${() => meter.start()}>Start sound check</button></div></div>`
      : words ? html`<div class="cr-verdict" style=${toneStyle(words[0])} role="status" aria-live="polite"><div><strong>${words[1]}</strong>${detail ? html`<p>${detail}</p>` : null}</div></div>` : null}
    ${live && audioKey !== 'none' && audioKey !== 'native' ? html`
      <div class="cr-loud">
        <div><span>Short-term</span><b>${fmtDb(meter.shortTerm, 'LUFS')}</b></div>
        <div><span>Integrated</span><b>${fmtDb(meter.integrated, 'LUFS')}</b></div>
        <div><span>True peak</span><b>${meter.truePeak != null && meter.truePeak > -100 ? `${meter.truePeak.toFixed(1)} dBTP` : '—'}</b></div>
      </div>
      <div class="cr-meters">
        <div class="cr-meter">
          <span>LUFS</span>
          <div class="cr-track is-lufs" role="meter" aria-label="Loudness, momentary" aria-valuemin=${LUFS_FLOOR} aria-valuemax="0" aria-valuenow=${meter.momentary != null ? Math.round(Math.max(LUFS_FLOOR, meter.momentary)) : LUFS_FLOOR} ref=${barRef(2)}>
            <div class="cr-zone" style=${`left:${pctOf(TARGET[0], LUFS_FLOOR)}%;width:${pctOf(TARGET[1], LUFS_FLOOR) - pctOf(TARGET[0], LUFS_FLOOR)}%`}></div>
            <div class="cr-fill"></div><div class="cr-mark"></div>
          </div>
          <span class="cr-db" style="text-align:right">—</span>
        </div>
        <${Scale} floor=${LUFS_FLOOR} ticks=${[-40, -30, -20, -12, -6, 0]} unit="" />
        ${['L', 'R'].map((label, c) => html`<div class="cr-meter">
          <span>${label}</span>
          <div class="cr-track" role="meter" aria-label=${`${label === 'L' ? 'Left' : 'Right'} channel level`} aria-valuemin=${BAR_FLOOR} aria-valuemax="0" aria-valuenow=${meter.chDb ? Math.round(Math.max(BAR_FLOOR, meter.chDb[c])) : BAR_FLOOR} ref=${barRef(c)}>
            <div class="cr-fill"></div><div class="cr-peak"></div>
          </div>
          <span class="cr-db" style="text-align:right">silent</span>
        </div>`)}
        <${Scale} floor=${BAR_FLOOR} ticks=${[-48, -36, -24, -18, -12, -6, 0]} unit="dBFS" />
      </div>
      <${History} hist=${meter.hist} />
      <div class="cr-note">Last minute of loudness. Green band: where speech should sit. Dashed line: too quiet.</div>` : null}
    ${probe?.audio && feed === 'live' ? html`<div class="cr-row cr-note">What Facebook and YouTube get: ${probe.audio.present === false ? 'no audio track' : probe.audio.lufs != null ? html`<b style="color:var(--color-text)">${fmtDb(probe.audio.lufs, 'LUFS')}</b> over ${probe.audio.seconds || 8} s${probe.audio.channels === 2 && probe.audio.deadSide ? `, ${probe.audio.deadSide} side silent` : ''}` : (probe.audio.silentPct === 100 ? 'silent' : 'not measured')} · ${ago(probe.at)}</div>` : null}
    ${feed === 'rehearsal' && report?.rehearsal?.goodAt ? html`<div class="cr-row cr-note">Last good mic check: ${ago(report.rehearsal.goodAt)}${report.rehearsal.goodLufs != null ? ` (${Math.round(report.rehearsal.goodLufs)} LUFS)` : ''}. The go/no-go counts it.</div>` : null}
  </div>`;

  // Destinations that aren't set up stay out of the way; the go/no-go and Settings cover them
  const destList = dests ? [['Website', dests.site], ['Facebook', dests.facebook, fbEmbed], ['YouTube', dests.youtube, dests.youtube?.status === 'ok' ? dests.youtube.embed : null], ['Instagram Live', dests.instagram]].filter(([, d]) => d && d.status !== 'off') : [];
  const destCards = destList.length ? html`<div class="cr-dests">${destList.map(([name, d, embedUrl]) => html`<${Destination} name=${name} d=${d} embedUrl=${embedUrl} />`)}</div>` : null;

  const issuesCard = feed === 'live' && (live || phase === 'ending' || issues.length) ? html`<${Issues} issues=${issues} fresh=${fresh} slackOn=${report?.slack !== false} prefs=${prefs} setPrefs=${setPrefs} log=${report?.watch?.log} watchAt=${report?.watch?.at} />` : null;
  const mainClass = `cr-main ${portrait ? 'is-portrait' : 'is-landscape'}`;
  // Portrait: a tall, narrow player, so everything else sits beside it
  return html`<div class="cr">
    ${issuesCard}
    ${portrait
      ? html`<div class=${mainClass}>${stage}<div class="cr-side">${audioCard}${destCards}</div></div>`
      : html`<div class=${mainClass}>${stage}${audioCard}</div>${destCards}`}
  </div>`;
}
