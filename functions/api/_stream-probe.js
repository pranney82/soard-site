/**
 * HLS probe for a Stream live input
 * =================================
 * Reads a feed the way a viewer's player would, from Stream's public
 * playback host: the master manifest (is there a picture, how big, is there
 * an audio track), the top video rendition's playlist (is it advancing), and
 * the newest audio segments (how loud, via _aac-level.js). No token needed;
 * live inputs are public playback.
 *
 * Never throws. Every result has { ok, error } plus whatever it could learn,
 * so a half-working feed still reports the half that works.
 */

import { analyzeSegment, mergeLevels, SILENT_DB } from './_aac-level.js';
import { playbackHost } from './_stream-live.js';

const TIMEOUT_MS = 6000;
/** Audio below this (RMS over the probe window) reads as "quiet" in the admin. Not an alert. */
export const QUIET_DB = -50;
/** Share of silent frames that makes a window "silent". */
const SILENT_SHARE = 90;

// Init segments rarely change during a broadcast; keep a few per isolate
const initCache = new Map();

async function get(url, kind = 'text') {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), cf: { cacheTtl: 0 } });
  if (!res.ok) { const e = new Error(`HTTP ${res.status}`); e.status = res.status; throw e; }
  return kind === 'bytes' ? new Uint8Array(await res.arrayBuffer()) : res.text();
}

function attrs(line) {
  const out = {};
  const re = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g;
  let m;
  while ((m = re.exec(line))) out[m[1]] = m[3] !== undefined ? m[3] : m[2];
  return out;
}

/** Master playlist → { variants, audio } with absolute URIs. */
export function parseMaster(text, base) {
  const lines = String(text).split(/\r?\n/);
  const variants = [], audio = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.startsWith('#EXT-X-MEDIA:')) {
      const a = attrs(line.slice(13));
      if (a.TYPE === 'AUDIO') audio.push({ group: a['GROUP-ID'] || null, name: a.NAME || null, default: a.DEFAULT === 'YES', uri: a.URI ? new URL(a.URI, base).toString() : null });
    } else if (line.startsWith('#EXT-X-STREAM-INF:')) {
      const a = attrs(line.slice(18));
      let uri = null;
      for (let j = i + 1; j < lines.length; j++) { const l = lines[j].trim(); if (l && !l.startsWith('#')) { uri = new URL(l, base).toString(); i = j; break; } }
      const [w, h] = String(a.RESOLUTION || '').split('x').map(Number);
      variants.push({
        bandwidth: Number(a.BANDWIDTH) || null,
        avgBandwidth: Number(a['AVERAGE-BANDWIDTH']) || null,
        width: w || null, height: h || null,
        fps: a['FRAME-RATE'] ? Math.round(Number(a['FRAME-RATE']) * 100) / 100 : null,
        codecs: a.CODECS || '',
        audioGroup: a.AUDIO || null,
        uri,
      });
    }
  }
  variants.sort((x, y) => (y.bandwidth || 0) - (x.bandwidth || 0));
  return { variants, audio };
}

/** Media playlist → segments (absolute URIs), init map, sequence numbers, wall-clock times when present. */
export function parseMedia(text, base) {
  const lines = String(text).split(/\r?\n/);
  const out = { targetDuration: null, mediaSequence: 0, endList: false, map: null, segments: [] };
  let duration = null, pdt = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#EXT-X-TARGETDURATION:')) out.targetDuration = Number(line.slice(22));
    else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) out.mediaSequence = Number(line.slice(22)) || 0;
    else if (line.startsWith('#EXT-X-ENDLIST')) out.endList = true;
    else if (line.startsWith('#EXT-X-MAP:')) { const a = attrs(line.slice(11)); if (a.URI) out.map = new URL(a.URI, base).toString(); }
    else if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) pdt = Date.parse(line.slice(25));
    else if (line.startsWith('#EXTINF:')) duration = parseFloat(line.slice(8));
    else if (!line.startsWith('#')) {
      out.segments.push({ uri: new URL(line, base).toString(), duration: duration ?? out.targetDuration ?? null, pdt: Number.isFinite(pdt) ? pdt : null });
      duration = null; pdt = null;
    }
  }
  out.lastSequence = out.mediaSequence + out.segments.length - 1;
  return out;
}

/** "ok" | "quiet" | "silent" | "none" | "unknown" for an audio reading. */
export function audioVerdict(audio) {
  if (!audio) return 'unknown';
  if (audio.present === false) return 'none';
  if (!audio.supported || audio.frames === 0) return 'unknown';
  if (audio.silentPct >= SILENT_SHARE || audio.levelDb == null || audio.levelDb < SILENT_DB) return 'silent';
  if (audio.levelDb < QUIET_DB) return 'quiet';
  return 'ok';
}

/**
 * Probe one feed (a live input uid while it is live, or any video uid).
 *   audioSegments  how many of the newest audio segments to measure (0 = skip audio)
 * → { ok, at, uid, status, error, live, video, audio }
 */
export async function probeFeed(customerCode, uid, { audioSegments = 2 } = {}) {
  const at = new Date(Date.now()).toISOString();
  const masterUrl = `${playbackHost(customerCode)}/${uid}/manifest/video.m3u8`;
  const out = { ok: false, at, uid, status: null, error: null, live: null, video: null, audio: null };
  let master;
  try {
    master = parseMaster(await get(masterUrl), masterUrl);
    out.status = 200;
  } catch (e) {
    out.status = e.status || null;
    out.error = e.status === 404 ? 'No video on this feed right now' : `Manifest: ${e.message}`;
    return out;
  }
  const top = master.variants[0];
  if (!top) { out.error = 'Manifest has no video renditions yet'; return out; }

  const audioTrack = master.audio.find((a) => a.default && a.uri) || master.audio.find((a) => a.uri) || null;
  const muxedAudio = !audioTrack && /mp4a|ac-3|ec-3|opus/i.test(top.codecs);
  out.video = {
    width: top.width, height: top.height, fps: top.fps,
    bitrate: top.avgBandwidth || top.bandwidth,
    codecs: top.codecs,
    renditions: master.variants.length,
    ladder: master.variants.map((v) => (v.height ? `${Math.min(v.width, v.height)}p` : null)).filter(Boolean),
  };
  out.audio = {
    present: !!audioTrack || muxedAudio,
    codec: (top.codecs.match(/mp4a[.\w]*|ac-3|ec-3|opus/i) || [null])[0],
  };

  const [videoPl, audioPl] = await Promise.allSettled([
    get(top.uri).then((t) => parseMedia(t, top.uri)),
    audioTrack ? get(audioTrack.uri).then((t) => parseMedia(t, audioTrack.uri)) : Promise.resolve(null),
  ]);

  if (videoPl.status === 'fulfilled') {
    const v = videoPl.value;
    const last = v.segments[v.segments.length - 1];
    out.live = !v.endList;
    Object.assign(out.video, {
      segments: v.segments.length,
      segmentSec: v.targetDuration,
      lastSequence: v.lastSequence,
      // Wall-clock age of the newest segment, when Stream stamps program date-times
      edgeAgeSec: last?.pdt ? Math.round((Date.now() - (last.pdt + (last.duration || 0) * 1000)) / 100) / 10 : null,
    });
  } else {
    out.error = `Video playlist: ${videoPl.reason?.message || 'unreachable'}`;
  }

  if (audioSegments > 0 && out.audio.present) {
    const pl = audioPl.status === 'fulfilled' && audioPl.value ? audioPl.value : (muxedAudio && videoPl.status === 'fulfilled' ? videoPl.value : null);
    if (pl?.segments.length) {
      try {
        let init = null;
        if (pl.map) {
          init = initCache.get(pl.map);
          if (!init) {
            init = await get(pl.map, 'bytes');
            if (initCache.size > 16) initCache.delete(initCache.keys().next().value);
            initCache.set(pl.map, init);
          }
        }
        const picks = pl.segments.slice(-audioSegments);
        const bytes = await Promise.all(picks.map((s) => get(s.uri, 'bytes')));
        const level = mergeLevels(bytes.map((segment) => analyzeSegment({ init, segment })));
        Object.assign(out.audio, {
          supported: level.supported !== false,
          levelDb: level.levelDb ?? null,
          peakDb: level.peakDb ?? null,
          silentPct: level.silentPct ?? null,
          frames: level.frames || 0,
          seconds: Math.round(picks.reduce((s, x) => s + (x.duration || 0), 0) * 10) / 10,
          sampleRate: level.sampleRate || null,
          channels: level.channels || null,
          error: level.error || null,
        });
      } catch (e) {
        out.audio.error = `Audio segments: ${e.message}`;
      }
    } else if (audioPl.status === 'rejected') {
      out.audio.error = `Audio playlist: ${audioPl.reason?.message || 'unreachable'}`;
    }
  }
  out.audio.verdict = audioVerdict(out.audio);
  out.ok = !out.error;
  return out;
}
