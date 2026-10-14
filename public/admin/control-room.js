/**
 * Broadcast control room (admin)
 * ==============================
 * Loaded on demand by the Broadcast page (Control room tab, and the compact
 * preview on Now while live). Plays the reveal feed with its own HLS player
 * instead of Stream's iframe, so the page can listen to the audio:
 *
 *  - Picture: plays Stream's HLS for the live (or rehearsal) input, notes the
 *    rendition, delay and stalls, and flags a black or frozen picture.
 *  - Sound: Web Audio meters per channel (RMS + peak, dBFS) with a verdict:
 *    good, quiet, silent, clipping, one-sided, or no audio track at all.
 *  - Destinations: the server's verdict for the site, Facebook, YouTube and
 *    Instagram (/api/broadcast-admin { action: 'monitor' }), with the fix.
 *
 * hls.js lives in ./vendor-hls.js and is imported only when a feed plays.
 * Metering runs off a 50 ms timer and writes meter widths straight to the
 * DOM; Preact re-renders a few times a second for the words.
 */

import { h, htm, useState, useEffect, useRef, useCallback } from './vendor.js';

const html = htm.bind(h);

const POLL_LIVE_MS = 8000;
const POLL_IDLE_MS = 20000;
const METER_FLOOR = -60;          // dBFS at the left edge of the meters
const SOUND_DB = -60;             // anything above this counts as sound
const QUIET_DB = -45;             // 3 s average below this for 10 s = quiet
const CLIP_DB = -0.5;             // sample peak at or above = clipping
const SILENT_WARN_MS = 6000;
const QUIET_WARN_MS = 10000;
const ONE_SIDED_DB = 20;          // left/right difference that means one side is dead
const HISTORY_SECONDS = 60;

// ─── Styles (scoped to .cr) ─────────────────────────────────────────

const CSS = `
.cr { display: grid; gap: 1rem; }
.cr .card { margin: 0; }
.cr-bar { display: flex; flex-wrap: wrap; gap: .75rem 1rem; align-items: center; justify-content: space-between; }
.cr-seg { display: inline-flex; background: var(--color-bg); border: 1px solid var(--color-border); border-radius: 999px; padding: 3px; }
.cr-seg button { border: 0; background: transparent; padding: .4rem .9rem; border-radius: 999px; font-size: .85rem; font-weight: 600; color: var(--color-text-secondary); }
.cr-seg button[aria-pressed="true"] { background: #fff; color: var(--color-text); box-shadow: var(--shadow-sm); }
.cr-chips { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; font-size: .85rem; color: var(--color-text-secondary); }
.cr-chip { display: inline-flex; align-items: center; gap: .4rem; padding: .25rem .65rem; border-radius: 999px; background: var(--color-bg); border: 1px solid var(--color-border); font-weight: 600; color: var(--color-text); white-space: nowrap; }
.cr-dot { width: 9px; height: 9px; border-radius: 50%; flex: none; background: var(--dot, #CBD5E0); }
.cr-dot.is-live { box-shadow: 0 0 0 4px rgba(255,213,0,.3); animation: cr-pulse 1.6s ease-in-out infinite; }
@keyframes cr-pulse { 50% { box-shadow: 0 0 0 7px rgba(255,213,0,.08); } }
@media (prefers-reduced-motion: reduce) { .cr-dot.is-live { animation: none; } }
.cr-main { display: grid; gap: 1rem; align-items: start; grid-template-columns: minmax(0, 1.3fr) minmax(0, 1fr); }
.cr-main.is-portrait { grid-template-columns: minmax(280px, 380px) minmax(0, 1fr); }
.cr-side { display: grid; gap: 1rem; align-content: start; min-width: 0; }
@media (max-width: 1000px) { .cr-main, .cr-main.is-portrait { grid-template-columns: 1fr; } }
.cr-stage { position: relative; background: #0f1012; border-radius: var(--radius-md); overflow: hidden; display: grid; place-items: center; }
.cr-stage video { display: block; width: 100%; height: 100%; object-fit: contain; background: #0f1012; }
.cr-stage.is-landscape { aspect-ratio: 16 / 9; }
.cr-stage.is-portrait { aspect-ratio: 9 / 16; max-height: 72vh; margin: 0 auto; }
.cr-compact .cr-stage.is-portrait { max-height: 440px; }
.cr-stage.is-empty { aspect-ratio: auto; min-height: 200px; max-height: none; }
.cr-stage.is-empty video { position: absolute; inset: 0; opacity: 0; }
@media (max-width: 1000px) { .cr-stage.is-portrait:not(.is-empty) { max-width: 380px; } }
.cr-over { position: absolute; inset: 0; display: grid; place-items: center; text-align: center; padding: 1.25rem; color: #f5f4f0; font-size: .9rem; line-height: 1.5; background: rgba(15,16,18,.72); }
.cr-over strong { display: block; font-size: 1rem; margin-bottom: .25rem; color: #fff; }
.cr-over.is-clear { background: transparent; pointer-events: none; }
.cr-stats { display: flex; flex-wrap: wrap; gap: .35rem .9rem; margin-top: .6rem; font-size: .8rem; color: var(--color-text-secondary); font-variant-numeric: tabular-nums; }
.cr-stats b { color: var(--color-text); font-weight: 600; }
.cr-verdict { display: flex; gap: .75rem; align-items: flex-start; padding: .8rem .9rem; border-radius: var(--radius-sm); background: var(--tone-bg); color: var(--tone-fg); }
.cr-verdict strong { display: block; font-size: 1rem; }
.cr-verdict p { margin: .15rem 0 0; font-size: .85rem; line-height: 1.45; }
.cr-meters { display: grid; gap: .45rem; margin: 1rem 0 .25rem; }
.cr-meter { display: grid; grid-template-columns: 1.1rem 1fr 4.2rem; gap: .5rem; align-items: center; font-size: .78rem; font-variant-numeric: tabular-nums; color: var(--color-text-secondary); }
.cr-track { position: relative; height: 16px; border-radius: 4px; overflow: hidden; background: #EDECE8; }
.cr-zone { position: absolute; top: 0; bottom: 0; background: rgba(56,161,105,.13); border-left: 1px dashed rgba(56,161,105,.5); border-right: 1px dashed rgba(56,161,105,.5); }
.cr-fill { position: absolute; inset: 0 auto 0 0; width: 0; background: linear-gradient(90deg, #38A169 0%, #38A169 70%, #D69E2E 85%, #E53E3E 99%); background-size: var(--full, 300px) 100%; transition: width 60ms linear; }
.cr-peak { position: absolute; top: 0; bottom: 0; width: 2px; left: 0; background: var(--color-text); opacity: .75; }
.cr-scale { display: grid; grid-template-columns: 1.1rem 1fr 4.2rem; gap: .5rem; font-size: .7rem; color: var(--color-text-muted); }
.cr-scale div { position: relative; height: 1rem; }
.cr-scale div span { position: absolute; transform: translateX(-50%); font-variant-numeric: tabular-nums; }
.cr-hist { width: 100%; height: 56px; display: block; margin-top: .75rem; background: var(--color-bg-secondary); border-radius: 6px; }
.cr-row { display: flex; flex-wrap: wrap; gap: .5rem; align-items: center; margin-top: .75rem; }
.cr-note { font-size: .8rem; color: var(--color-text-muted); line-height: 1.5; }
.cr-dests { display: grid; gap: 1rem; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); }
.cr-dest { border-top: 4px solid var(--dot); display: flex; flex-direction: column; gap: .35rem; }
.cr-dest h4 { margin: 0; font-size: .95rem; display: flex; align-items: center; gap: .5rem; justify-content: space-between; }
.cr-dest .cr-title { font-weight: 600; font-size: .9rem; }
.cr-dest .cr-detail { font-size: .82rem; color: var(--color-text-secondary); line-height: 1.45; }
.cr-dest .cr-fix { font-size: .82rem; line-height: 1.45; background: #FEFCBF; color: #744210; border-radius: 6px; padding: .45rem .6rem; }
.cr-dest .cr-actions { margin-top: auto; padding-top: .35rem; display: flex; gap: .4rem; flex-wrap: wrap; }
.cr-embed { margin-top: .5rem; border-radius: 8px; overflow: hidden; background: #000; aspect-ratio: 16 / 9; }
.cr-embed iframe { width: 100%; height: 100%; border: 0; display: block; }
.cr-pill { font-size: .72rem; font-weight: 700; letter-spacing: .02em; padding: .15rem .5rem; border-radius: 999px; background: var(--tone-bg); color: var(--tone-fg); white-space: nowrap; }
.cr-strip { display: flex; flex-wrap: wrap; gap: .5rem; }
.cr-bar-flat { padding: 0 0 .25rem; }
.cr-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
`;

function injectCss() {
  if (document.getElementById('cr-css')) return;
  const s = document.createElement('style');
  s.id = 'cr-css';
  s.textContent = CSS;
  document.head.appendChild(s);
}

// ─── Tones ──────────────────────────────────────────────────────────

const TONES = {
  ok: { bg: '#C6F6D5', fg: '#22543D', dot: '#38A169', pill: 'OK' },
  wait: { bg: '#E2E8F0', fg: '#4A5568', dot: '#A0AEC0', pill: 'Starting' },
  warn: { bg: '#FEFCBF', fg: '#744210', dot: '#D69E2E', pill: 'Needs a fix' },
  bad: { bg: '#FED7D7', fg: '#822727', dot: '#E53E3E', pill: 'Problem' },
  off: { bg: '#EDF2F7', fg: '#718096', dot: '#CBD5E0', pill: 'Off' },
  unknown: { bg: '#EDF2F7', fg: '#4A5568', dot: '#A0AEC0', pill: 'Can\'t confirm' },
  idle: { bg: '#EDF2F7', fg: '#4A5568', dot: '#CBD5E0', pill: 'Ready' },
};
const toneStyle = (t) => `--tone-bg:${(TONES[t] || TONES.idle).bg};--tone-fg:${(TONES[t] || TONES.idle).fg};--dot:${(TONES[t] || TONES.idle).dot}`;

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

const fmtDb = (db) => (db == null || !Number.isFinite(db) || db < -100 ? 'silent' : `${db > -10 ? db.toFixed(1) : Math.round(db)} dB`);
const fmtRate = (bps) => (bps == null ? null : bps >= 1e6 ? `${(bps / 1e6).toFixed(1)} Mbps` : `${Math.round(bps / 1000)} kbps`);
const fmtClock = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  return `${hh ? `${hh}:${String(mm).padStart(2, '0')}` : mm}:${String(ss).padStart(2, '0')}`;
};
const ago = (iso) => {
  if (!iso) return '';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  return s < 5 ? 'just now' : s < 90 ? `${s} s ago` : `${Math.round(s / 60)} min ago`;
};
const pct = (db) => Math.max(0, Math.min(100, ((db - METER_FLOOR) / -METER_FLOOR) * 100));

// ─── Server report ──────────────────────────────────────────────────

function useReport(feed, phase) {
  const [report, setReport] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const timer = useRef(null);
  const live = report?.phoneLive;

  const load = useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch('/api/broadcast-admin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'monitor', feed }) });
      if (res.status === 401 || res.status === 403) throw new Error('Your admin sign-in expired. Reload the page.');
      const d = await res.json().catch(() => null);
      if (!d) throw new Error(`The server returned ${res.status}`);
      if (!d.success) throw new Error(d.error || 'Check failed');
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
  }, [feed, phase]);
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

  // Delay behind the phone, ~1 Hz
  useEffect(() => {
    if (!on) return undefined;
    const t = setInterval(() => {
      const hls = ref.current.hls;
      const video = videoRef.current;
      if (!hls || !video) return;
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
      } catch { /* tainted or not ready */ }
      darkSince = luma != null && luma < 0.05 ? (darkSince || now) : null;
      if (!v.paused && v.currentTime === lastTime) stuckSince ||= now; else stuckSince = null;
      lastTime = v.currentTime;
      setPic({ dark: !!darkSince && now - darkSince > 5000, frozen: !!stuckSince && now - stuckSince > 6000, width: v.videoWidth, height: v.videoHeight });
    }, 1000);
    return () => clearInterval(t);
  }, [on]);
  return pic;
}

// ─── Audio meter ────────────────────────────────────────────────────

/**
 * Web Audio meter on the <video>. The element stays unmuted (a muted element
 * feeds the graph silence) and a gain node decides whether you hear it.
 * Meter bars are written straight to the DOM through `bars`.
 */
function useMeter(videoRef, on, bars) {
  const [m, setM] = useState({ running: false, needsGesture: false, verdict: 'waiting', channels: 0, listen: false });
  const g = useRef({ ctx: null, src: null, gain: null, analysers: [], buf: null, hist: [], timer: null });

  const ensureGraph = useCallback(async () => {
    const video = videoRef.current;
    const s = g.current;
    if (!video) return false;
    if (!s.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return false;
      s.ctx = new AC();
      s.src = s.ctx.createMediaElementSource(video);
      // Speaker up-mix first, so a mono feed shows on both meters instead of reading as "left only"
      const up = s.ctx.createGain();
      up.channelCount = 2; up.channelCountMode = 'explicit'; up.channelInterpretation = 'speakers';
      const split = s.ctx.createChannelSplitter(2);
      s.analysers = [0, 1].map(() => { const a = s.ctx.createAnalyser(); a.fftSize = 2048; a.smoothingTimeConstant = 0; return a; });
      s.gain = s.ctx.createGain();
      s.gain.gain.value = 0;
      s.src.connect(up).connect(split);
      split.connect(s.analysers[0], 0);
      split.connect(s.analysers[1], 1);
      s.src.connect(s.gain).connect(s.ctx.destination);
      s.buf = new Float32Array(2048);
    }
    if (s.ctx.state !== 'running') { try { await s.ctx.resume(); } catch {} }
    if (s.ctx.state === 'running') { video.muted = false; video.volume = 1; }
    const ok = s.ctx.state === 'running';
    setM((x) => ({ ...x, running: ok, needsGesture: !ok }));
    return ok;
  }, []);

  useEffect(() => {
    if (!on) return undefined;
    const s = g.current;
    let alive = true;
    ensureGraph();
    const t0 = Date.now();
    const st = { lastSound: t0, lastLoud: t0, lastClip: 0, short: [], chE: [[], []], lastUi: 0, lastHist: 0, peakHold: [{ db: -Infinity, at: 0 }, { db: -Infinity, at: 0 }], disp: [METER_FLOOR, METER_FLOOR], started: t0, everSound: false, pausedAt: 0 };
    s.timer = setInterval(() => {
      if (!alive || !s.ctx || s.ctx.state !== 'running') return;
      const video = videoRef.current;
      const now = Date.now();
      // Buffering isn't silence: stop the clocks while nothing plays
      if (!video || video.paused || video.readyState < 3) { st.pausedAt ||= now; return; }
      if (st.pausedAt) { const d = now - st.pausedAt; st.lastSound += d; st.lastLoud += d; st.pausedAt = 0; }
      const ch = [];
      for (let c = 0; c < 2; c++) {
        s.analysers[c].getFloatTimeDomainData(s.buf);
        let sum = 0, peak = 0;
        for (let i = 0; i < s.buf.length; i++) { const v = s.buf[i]; sum += v * v; const a = v < 0 ? -v : v; if (a > peak) peak = a; }
        const ms = sum / s.buf.length;
        ch.push({ ms, rms: 10 * Math.log10(ms || 1e-12), peak: 20 * Math.log10(peak || 1e-9) });
      }
      const loudest = Math.max(ch[0].rms, ch[1].rms);
      if (loudest > SOUND_DB) { st.lastSound = now; st.everSound = true; }
      if (Math.max(ch[0].peak, ch[1].peak) >= CLIP_DB) st.lastClip = now;
      st.short.push([now, (ch[0].ms + ch[1].ms) / 2]);
      while (st.short.length && now - st.short[0][0] > 3000) st.short.shift();
      const shortDb = 10 * Math.log10((st.short.reduce((a, x) => a + x[1], 0) / st.short.length) || 1e-12);
      if (shortDb > QUIET_DB) st.lastLoud = now;
      for (let c = 0; c < 2; c++) { st.chE[c].push([now, ch[c].ms]); while (now - st.chE[c][0][0] > 8000) st.chE[c].shift(); }

      // Bars: fast attack, ~24 dB/s release; peak marker holds 1.5 s
      for (let c = 0; c < 2; c++) {
        st.disp[c] = Math.max(ch[c].rms, st.disp[c] - 1.2);
        const hold = st.peakHold[c];
        if (ch[c].peak >= hold.db || now - hold.at > 1500) { hold.db = ch[c].peak; hold.at = now; }
        const b = bars.current?.[c];
        if (b) { b.fill.style.width = `${pct(st.disp[c])}%`; b.peak.style.left = `calc(${pct(hold.db)}% - 1px)`; b.label.textContent = fmtDb(ch[c].rms); }
      }
      if (now - st.lastHist >= 250) { st.lastHist = now; s.hist.push(shortDb); if (s.hist.length > HISTORY_SECONDS * 4) s.hist.shift(); }

      if (now - st.lastUi < 400) return;
      st.lastUi = now;
      const e = st.chE.map((list) => 10 * Math.log10((list.reduce((a, x) => a + x[1], 0) / list.length) || 1e-12));
      const louder = e[0] >= e[1] ? 0 : 1;
      const oneSided = Math.max(e[0], e[1]) > QUIET_DB && Math.abs(e[0] - e[1]) > ONE_SIDED_DB && now - st.started > 8000 ? (louder === 0 ? 'left' : 'right') : null;
      const silentFor = now - st.lastSound;
      let verdict = 'ok';
      if (silentFor > SILENT_WARN_MS) verdict = 'silent';
      else if (now - st.lastClip < 3000) verdict = 'clipping';
      else if (now - st.lastLoud > QUIET_WARN_MS) verdict = 'quiet';
      else if (oneSided) verdict = 'onesided';
      else if (!st.everSound) verdict = 'waiting';
      setM((x) => ({ ...x, verdict, silentFor, oneSided, shortDb, chDb: e, hist: s.hist.slice(), running: true, needsGesture: false }));
    }, 50);
    return () => { alive = false; clearInterval(s.timer); };
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

// ─── Pieces ─────────────────────────────────────────────────────────

const AUDIO_WORDS = {
  ok: ['ok', 'Sound is good', null],
  waiting: ['wait', 'Listening…', 'Waiting for the first sound from the mic.'],
  quiet: ['warn', 'Sound is very quiet', 'Move the mic closer to whoever is talking, or turn up the gain on the mic transmitter.'],
  silent: ['bad', 'No sound', 'Check the mic: receiver plugged into the phone, transmitter switched on and unmuted, Larix not muted.'],
  clipping: ['warn', 'Too loud: the sound is distorting', 'Turn the gain down on the mic transmitter, or move the mic a little further away.'],
  onesided: ['warn', 'Sound on one side only', 'Headphone listeners hear one ear. Set Larix audio to mono so both sides get the mic.'],
  none: ['bad', 'No audio track', 'The phone is sending video without sound. In Larix: Settings → Audio, turn audio on, then stop and restart.'],
  native: ['unknown', 'Meter not available in this browser', 'Use Chrome, Edge, Firefox, or Safari on a Mac for the sound meter. The server check below still runs.'],
};

function MeterScale() {
  const ticks = [-48, -36, -24, -18, -12, -6, 0];
  return html`<div class="cr-scale" aria-hidden="true"><span></span><div>${ticks.map((t) => html`<span style=${`left:${pct(t)}%`}>${t}</span>`)}</div><span></span></div>`;
}

function History({ hist }) {
  if (!hist?.length) return html`<svg class="cr-hist" viewBox="0 0 240 56" preserveAspectRatio="none" aria-hidden="true"></svg>`;
  const n = HISTORY_SECONDS * 4;
  const y = (db) => 56 - (pct(db) / 100) * 52 - 2;
  const pts = hist.map((db, i) => `${((n - hist.length + i) / (n - 1)) * 240},${y(db).toFixed(1)}`).join(' ');
  return html`<svg class="cr-hist" viewBox="0 0 240 56" preserveAspectRatio="none" role="img" aria-label="Sound level over the last minute">
    <rect x="0" width="240" y=${y(-12)} height=${y(-24) - y(-12)} fill="rgba(56,161,105,.10)" />
    <line x1="0" x2="240" y1=${y(SOUND_DB)} y2=${y(SOUND_DB)} stroke="#CBD5E0" stroke-dasharray="3 3" stroke-width="1" vector-effect="non-scaling-stroke" />
    <polyline points=${pts} fill="none" stroke="#2D2E33" stroke-width="1.5" stroke-linejoin="round" vector-effect="non-scaling-stroke" />
  </svg>`;
}

function Destination({ name, d, embedUrl }) {
  const [show, setShow] = useState(false);
  if (!d) return null;
  const tone = d.status || 'idle';
  return html`<div class="card cr-dest" style=${toneStyle(tone)}>
    <h4><span>${name}</span><span class="cr-pill">${(TONES[tone] || TONES.idle).pill}</span></h4>
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

// ─── Control room ───────────────────────────────────────────────────

/**
 * Props
 *   phase          broadcast phase from the parent (refreshes the report on change)
 *   hasRehearsal   a rehearsal input exists
 *   alertTargets   who unattended alerts reach, for the explainer ("Slack, ops@…")
 *   compact        small version for the Now tab
 *   onOpen         compact only: switch to the full Control room tab
 *   onSetup        jump to the Setup tab
 */
export function ControlRoom({ phase, hasRehearsal = false, alertTargets = '', compact = false, onOpen, onSetup }) {
  useEffect(injectCss, []);
  const [feed, setFeed] = useState('live');
  const { report, error, busy, refresh } = useReport(feed, phase);
  const videoRef = useRef(null);
  // Start muted so autoplay is allowed; the sound check unmutes it (a gain node keeps it quiet)
  const muteOnce = useCallback((el) => { if (el && videoRef.current !== el) { el.muted = true; el.autoplay = true; } videoRef.current = el; }, []);
  const bars = useRef([]);
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
  else if (player.state === 'native') audioKey = 'native';
  else if (!meter.running && meter.needsGesture) audioKey = null;
  const words = audioKey ? AUDIO_WORDS[audioKey] : null;
  let detail = words?.[2];
  if (audioKey === 'ok' && meter.shortDb != null) detail = `Averaging ${fmtDb(meter.shortDb)} over the last 3 seconds. Speech sits best between -24 and -12.`;
  if (audioKey === 'silent' && meter.silentFor) detail = `Nothing for ${Math.round(meter.silentFor / 1000)} s. ${words[2]}`;
  if (audioKey === 'onesided') detail = `Only the ${meter.oneSided} side has sound. ${words[2]}`;

  const overlay = !report ? ['Checking the feed…', null]
    : !report.ready ? ['No input yet', report.error]
    : !live ? (feed === 'rehearsal'
      ? ['Rehearsal feed is idle', 'Scan the rehearsal code in Setup with Larix and start streaming. Nothing here reaches the public.']
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
  ].filter(Boolean);

  const picWarn = pic.dark ? 'The picture is black. Is the lens covered, or did the phone switch apps?' : pic.frozen ? 'The picture has stopped moving. The phone may be losing signal.' : null;
  const liveFor = report?.liveAt && live ? fmtClock(Date.now() - Date.parse(report.liveAt)) : null;
  const dests = report?.destinations;
  const fbEmbed = dests?.facebook?.status === 'ok' && dests.facebook.url && /facebook\.com\/.*(videos|watch)/.test(dests.facebook.url)
    ? `https://www.facebook.com/plugins/video.php?href=${encodeURIComponent(dests.facebook.url)}&show_text=false&autoplay=true&mute=1` : null;

  const feedSwitch = !compact ? html`<div class="cr-seg" role="group" aria-label="Which feed">
    <button type="button" aria-pressed=${feed === 'live'} onClick=${() => setFeed('live')}>Reveal feed</button>
    <button type="button" aria-pressed=${feed === 'rehearsal'} onClick=${() => (hasRehearsal ? setFeed('rehearsal') : onSetup?.())} title=${hasRehearsal ? 'Private practice feed' : 'Create the rehearsal input in Setup first'}>Rehearsal feed</button>
  </div>` : null;

  const topBar = html`<div class=${compact ? 'cr-bar cr-bar-flat' : 'card cr-bar'}>
    <div class="cr-chips">
      ${feedSwitch}
      <span class="cr-chip" style=${toneStyle(conn[0])}><span class=${`cr-dot ${live ? 'is-live' : ''}`} style=${live ? '--dot:#FFD500' : ''}></span>${conn[1]}</span>
      ${liveFor ? html`<span class="cr-chip">Live ${liveFor}</span>` : null}
      ${report?.at ? html`<span>Checked ${ago(report.at)}</span>` : null}
    </div>
    <div class="cr-chips">
      ${error ? html`<span style="color:#744210">${error}</span>` : null}
      <button class="btn btn-ghost btn-sm" type="button" disabled=${busy} onClick=${refresh}>Check now</button>
      ${compact && onOpen ? html`<button class="btn btn-secondary btn-sm" type="button" onClick=${onOpen}>Open control room</button>` : null}
    </div>
  </div>`;

  const stage = html`<div class="card">
    <div class=${`cr-stage ${portrait ? 'is-portrait' : 'is-landscape'}${live && player.state !== 'off' ? '' : ' is-empty'}`}>
      <video ref=${muteOnce} playsinline aria-label="Live feed preview"></video>
      ${overlay ? html`<div class="cr-over"><div><strong>${overlay[0]}</strong>${overlay[1] || ''}</div></div>` : null}
    </div>
    ${stats.length ? html`<div class="cr-stats">${stats.map((x) => html`<span>${x}</span>`)}</div>` : null}
    ${picWarn ? html`<div class="cr-verdict" style=${`${toneStyle('warn')};margin-top:.75rem`}><div><strong>Check the picture</strong><p>${picWarn}</p></div></div>` : null}
  </div>`;

  const audioCard = html`<div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:.5rem;margin-bottom:.75rem">
      <h3 style="margin:0">Sound</h3>
      ${live && player.state !== 'native' ? html`<button class="btn btn-ghost btn-sm" type="button" aria-pressed=${meter.listen} onClick=${() => meter.setListen(!meter.listen)}>${meter.listen ? 'Stop listening' : 'Listen here'}</button>` : null}
    </div>
    ${!live ? html`<p class="cr-note" style="margin:0">The meter starts when the phone is live.${feed === 'live' && hasRehearsal ? ' For a mic check that stays private, use the Rehearsal feed.' : ''}</p>`
      : meter.needsGesture && audioKey !== 'none' ? html`<div class="cr-verdict" style=${toneStyle('wait')}><div><strong>Turn on the sound check</strong><p>The browser needs one click before it can listen.</p><button class="btn btn-primary btn-sm" type="button" style="margin-top:.5rem" onClick=${() => meter.start()}>Start sound check</button></div></div>`
      : words ? html`<div class="cr-verdict" style=${toneStyle(words[0])} role="status" aria-live="polite"><div><strong>${words[1]}</strong>${detail ? html`<p>${detail}</p>` : null}</div></div>` : null}
    ${live && audioKey !== 'none' && audioKey !== 'native' ? html`
      <div class="cr-meters">
        ${['L', 'R'].map((label, c) => html`<div class="cr-meter">
          <span>${label}</span>
          <div class="cr-track" role="meter" aria-label=${`${label === 'L' ? 'Left' : 'Right'} channel level`} aria-valuemin=${METER_FLOOR} aria-valuemax="0" aria-valuenow=${meter.chDb ? Math.round(Math.max(METER_FLOOR, meter.chDb[c])) : METER_FLOOR}
            ref=${(el) => { if (!el) return; bars.current[c] = { fill: el.querySelector('.cr-fill'), peak: el.querySelector('.cr-peak'), label: el.parentElement.querySelector('.cr-db') }; el.querySelector('.cr-fill').style.setProperty('--full', `${el.clientWidth}px`); }}>
            <div class="cr-zone" style=${`left:${pct(-24)}%;width:${pct(-12) - pct(-24)}%`}></div>
            <div class="cr-fill"></div><div class="cr-peak"></div>
          </div>
          <span class="cr-db" style="text-align:right">silent</span>
        </div>`)}
        <${MeterScale} />
      </div>
      <${History} hist=${meter.hist} />
      <div class="cr-note">Last minute. Shaded band: where speech should sit. Dashed line: silence.</div>` : null}
    ${probe?.audio && feed === 'live' ? html`<div class="cr-row cr-note">Server check (what Facebook and YouTube get): ${probe.audio.present === false ? 'no audio track' : probe.audio.levelDb != null ? html`<b style="color:var(--color-text)">${fmtDb(probe.audio.levelDb)}</b> over ${probe.audio.seconds || 8} s` : (probe.audio.silentPct === 100 ? 'silent' : 'not measured')} · ${ago(probe.at)}</div>` : null}
  </div>`;

  const destCards = dests ? html`<div class="cr-dests">
    <${Destination} name="Website" d=${dests.site} />
    <${Destination} name="Facebook" d=${dests.facebook} embedUrl=${fbEmbed} />
    <${Destination} name="YouTube" d=${dests.youtube} embedUrl=${dests.youtube?.status === 'ok' ? dests.youtube.embed : null} />
    ${!compact || dests.instagram?.status !== 'off' ? html`<${Destination} name="Instagram Live" d=${dests.instagram} />` : null}
  </div>` : null;

  const destStrip = dests ? html`<div class="cr-strip">${[['Website', dests.site], ['Facebook', dests.facebook], ['YouTube', dests.youtube], ['Instagram', dests.instagram]].filter(([, d]) => d && d.status !== 'off').map(([n, d]) => html`<span class="cr-chip" style=${toneStyle(d.status)} title=${[d.title, d.detail, d.fix].filter(Boolean).join(' · ')}><span class="cr-dot"></span>${n}: ${d.title}</span>`)}</div>` : null;

  const mainClass = `cr-main ${portrait ? 'is-portrait' : 'is-landscape'}`;
  if (compact) {
    return html`<div class="cr cr-compact">
      ${topBar}
      <div class=${mainClass}>${stage}<div class="cr-side">${audioCard}${destStrip}</div></div>
    </div>`;
  }

  const w = report?.watch;
  const below = html`
    ${feed === 'live' ? destCards : html`<div class="card"><p class="cr-note" style="margin:0">The rehearsal feed is private. It never reaches the website, Facebook or YouTube, so use it to check the mic and the picture before reveal day. Recordings delete themselves after 30 days.</p></div>`}
    ${feed === 'live' ? html`<div class="card" style="background:#FEFCF5;border-left:3px solid #FFD500">
      <h3 style="margin:0 0 .4rem;font-size:.95rem">Checks that run without this page</h3>
      <p class="cr-note" style="margin:0">While the phone is live, the site checks the feed every 15 seconds and alerts ${alertTargets || 'the alert contacts (Health tab)'} once if the sound goes silent or disappears, the picture freezes, or Facebook or YouTube still aren't live a couple of minutes in. A note follows when the sound comes back.</p>
      ${w?.at ? html`<p class="cr-note" style="margin:.5rem 0 0">Last unattended check ${ago(w.at)}${w.audio ? ` · sound ${w.audio.verdict}${w.audio.levelDb != null ? ` (${fmtDb(w.audio.levelDb)})` : ''}` : ''}${Object.keys(w.alerts || {}).length ? ` · alerts sent: ${Object.keys(w.alerts).join(', ')}` : ''}</p>` : null}
    </div>` : null}`;
  // Portrait: a tall, narrow player, so everything else sits beside it
  return html`<div class="cr">
    ${topBar}
    ${portrait
      ? html`<div class=${mainClass}>${stage}<div class="cr-side">${audioCard}${below}</div></div>`
      : html`<div class=${mainClass}>${stage}${audioCard}</div>${below}`}
  </div>`;
}
