/**
 * Instagram Reel from every reveal, fully automatic
 * ==================================================
 * Instagram has no API for going live, but it does let a Page's linked
 * professional account publish Reels. So after each reveal:
 *
 *   replay ready ──▶ fits in a Reel? ──yes──────────────────────────┐
 *                        │ no                                         │
 *                        ▼                                            │
 *        find the reveal moment (captions → keyword scoring,          │
 *        Workers AI as a second opinion, admin override wins)         │
 *                        ▼                                            │
 *        Stream clips [moment − lead, … up to 15 min] into a new      │
 *        video (the full recording is untouched)                      │
 *                        ▼                                            ▼
 *        Stream makes an MP4 ──▶ Instagram container (REELS, caption) ──▶
 *        poll until FINISHED ──▶ media_publish ──▶ permalink in the admin
 *
 * The pipeline lives on state.reel and advances one step per tick (the hub
 * ticks every minute during replay), so nothing here runs long. Every step
 * is idempotent: a crashed tick just repeats the check next time.
 *
 * Needs: CF_ACCOUNT_ID, CF_STREAM_TOKEN, FB_PAGE_ID, and FB_PAGE_TOKEN
 * carrying instagram_basic + instagram_content_publish (see
 * docs/facebook-app-review.md → "Instagram Reels").
 */

import * as stream from './_stream-live.js';

const FB_GRAPH = 'https://graph.facebook.com/v25.0';
export const REEL_MAX_SECONDS = 895;        // Instagram's API ceiling is 15:00; keep a margin
const STEP_INTERVAL_MS = 20 * 1000;
const CAPTION_WAIT_MS = 25 * 60 * 1000;     // Stream's AI captions usually land within minutes
const PIPELINE_TIMEOUT_MS = 4 * 60 * 60 * 1000;
const AI_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

export function defaultReelConfig() {
  return {
    enabled: true,
    leadSeconds: 240,          // keep this much lead-up before the reveal moment
    maxSeconds: REEL_MAX_SECONDS,
    caption: "{kid}'s room reveal, the moment it all came together. Watch the full reveal on our website, link in bio. #SunshineOnARanneyDay #DreamsBuiltHere",
    shareToFeed: true,
  };
}

// ─── Reveal-moment detection ────────────────────────────────────────

export function parseVtt(vtt) {
  const cues = [];
  const toSec = (t) => {
    const p = t.trim().split(':').map(Number);
    return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
  };
  const blocks = String(vtt || '').replace(/\r/g, '').split(/\n\n+/);
  for (const b of blocks) {
    const lines = b.split('\n');
    const i = lines.findIndex(l => l.includes('-->'));
    if (i < 0) continue;
    const [a, z] = lines[i].split('-->');
    const text = lines.slice(i + 1).join(' ').replace(/<[^>]+>/g, '').trim();
    if (!text) continue;
    const start = toSec(a), end = toSec(z.trim().split(/\s+/)[0]);
    if (Number.isFinite(start) && Number.isFinite(end)) cues.push({ start, end, text });
  }
  return cues;
}

// Phrases that cluster around the moment a child sees the room
const SIGNALS = [
  [/open (your|ur) eyes|open them|take (it|them) off|take off the blindfold|you can look|go ahead and look/i, 8],
  [/welcome (home|to your)|your new (room|bedroom|bathroom|space|playroom)|this is (all )?yours|this is your room/i, 7],
  [/\b(three|3)[,.\s]+(two|2)[,.\s]+(one|1)\b|\b(one|1)[,.\s]+(two|2)[,.\s]+(three|3)\b/i, 6],
  [/are you ready|ready to see|big reveal|here it is|surprise/i, 5],
  [/oh my (god|gosh)|oh wow|i can'?t believe|no way|it'?s (so )?(beautiful|amazing|perfect)|do you like it|do you love it/i, 4],
  [/\bwow\b|\byay\b|\bwoo+\b|look at (this|that|it)|\[(applause|cheering|laughter|crying)\]/i, 2],
];

export function scoreCues(cues) {
  return cues.map(c => ({ ...c, score: SIGNALS.reduce((n, [re, w]) => n + (re.test(c.text) ? w : 0), 0) }));
}

/**
 * Densest 45 s window of reveal language. Returns { seconds, score, confidence }
 * where seconds is the first strong cue inside the peak window (the instant
 * the eyes open, not the average of the reactions after).
 */
export function detectByKeywords(cues, windowSec = 45) {
  const scored = scoreCues(cues).filter(c => c.score > 0);
  if (!scored.length) return null;
  let best = null;
  for (let i = 0; i < scored.length; i++) {
    let sum = 0;
    const inWin = [];
    for (let j = i; j < scored.length && scored[j].start < scored[i].start + windowSec; j++) { sum += scored[j].score; inWin.push(scored[j]); }
    if (!best || sum > best.score) best = { score: sum, cues: inWin };
  }
  const anchor = best.cues.find(c => c.score >= 5) || best.cues[0];
  const confidence = Math.min(1, best.score / 20);
  return { seconds: Math.round(anchor.start), score: best.score, confidence };
}

function mmss(sec) {
  const m = Math.floor(sec / 60), s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Ask Workers AI for the moment. Returns { seconds, confidence } or null. Never throws. */
export async function detectByAi(env, cues, duration) {
  if (!env.AI || !cues.length) return null;
  try {
    let transcript = cues.map(c => `[${mmss(c.start)}] ${c.text}`).join('\n');
    if (transcript.length > 24000) {
      // keep every cue with a signal plus an even sample of the rest
      const scored = scoreCues(cues);
      const keep = scored.filter((c, i) => c.score > 0 || i % Math.ceil(cues.length / 300) === 0);
      transcript = keep.map(c => `[${mmss(c.start)}] ${c.text}`).join('\n').slice(0, 24000);
    }
    const out = await env.AI.run(AI_MODEL, {
      messages: [
        { role: 'system', content: 'You find the reveal moment in transcripts of live home-makeover reveals: the instant a child first sees their finished room (eyes opened, blindfold off, door opened). Reply with JSON only: {"revealSeconds": <number>, "confidence": <0 to 1>}.' },
        { role: 'user', content: `Video length ${mmss(duration)}. Transcript with [minutes:seconds] timestamps:\n${transcript}` },
      ],
      max_tokens: 60,
      temperature: 0,
    });
    const text = typeof out === 'string' ? out : (out?.response ?? JSON.stringify(out));
    const m = String(text).match(/\{[^}]*\}/);
    if (!m) return null;
    const j = JSON.parse(m[0]);
    const seconds = Number(j.revealSeconds);
    const confidence = Math.max(0, Math.min(1, Number(j.confidence) || 0));
    if (!Number.isFinite(seconds) || seconds < 0 || seconds > duration) return null;
    return { seconds: Math.round(seconds), confidence };
  } catch {
    return null;
  }
}

/** Combine the two opinions. Keyword timing is precise; AI is a sanity check. */
export function chooseMoment(kw, ai) {
  if (kw && ai && Math.abs(kw.seconds - ai.seconds) <= 120) return { seconds: kw.seconds, method: 'captions+ai', confidence: Math.max(kw.confidence, ai.confidence) };
  if (kw && kw.confidence >= 0.5) return { seconds: kw.seconds, method: 'captions', confidence: kw.confidence };
  if (ai && ai.confidence >= 0.6) return { seconds: ai.seconds, method: 'ai', confidence: ai.confidence };
  if (kw) return { seconds: kw.seconds, method: 'captions', confidence: kw.confidence };
  if (ai) return { seconds: ai.seconds, method: 'ai', confidence: ai.confidence };
  return null;
}

/** Window of at most maxLen seconds with `lead` seconds before the moment, clamped to the video. */
export function clipWindow(duration, momentSec, { leadSeconds = 240, maxSeconds = REEL_MAX_SECONDS } = {}) {
  if (duration <= maxSeconds) return { start: 0, end: duration };
  if (momentSec == null) return { start: Math.max(0, duration - maxSeconds), end: duration }; // fallback: the ending
  let start = Math.max(0, momentSec - leadSeconds);
  let end = start + maxSeconds;
  if (end > duration) { end = duration; start = Math.max(0, end - maxSeconds); }
  return { start: Math.floor(start), end: Math.floor(end) };
}

export function renderCaption(template, state) {
  const kid = state.kidName || 'Today';
  const t = String(template || defaultReelConfig().caption);
  const text = state.kidName ? t : t.replace(/\{kid\}'s room reveal/g, 'Room reveal day');
  return text
    .replace(/\{kid\}/g, kid)
    .replace(/\{title\}/g, state.title || 'Room reveal')
    .replace(/\{link\}/g, 'sunshineonaranneyday.com')
    .slice(0, 2200);
}

// ─── Instagram Graph ────────────────────────────────────────────────

async function graph(env, method, path, params = {}) {
  const url = new URL(`${FB_GRAPH}/${path}`);
  const body = new URLSearchParams({ ...params, access_token: env.FB_PAGE_TOKEN });
  const init = { method, signal: AbortSignal.timeout(20000) };
  if (method === 'GET') url.search = body.toString();
  else { init.body = body; init.headers = { 'Content-Type': 'application/x-www-form-urlencoded' }; }
  const res = await fetch(url, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) return { ok: false, error: data.error?.message || `Graph API returned ${res.status}`, code: data.error?.code || null };
  return { ok: true, data };
}

/** The professional Instagram account linked to the Page: { id, username } or an error. */
export async function instagramAccount(env) {
  if (!env.FB_PAGE_ID || !env.FB_PAGE_TOKEN) return { ok: false, error: 'FB_PAGE_ID / FB_PAGE_TOKEN not set' };
  const r = await graph(env, 'GET', env.FB_PAGE_ID, { fields: 'instagram_business_account{id,username}' });
  if (!r.ok) return { ok: false, error: r.error, code: r.code };
  const ig = r.data.instagram_business_account;
  if (!ig?.id) return { ok: false, error: 'No professional Instagram account is linked to the Facebook Page. Instagram app → Settings → Account type → switch to Business, then link it to the Page.' };
  return { ok: true, id: ig.id, username: ig.username || null };
}

export async function createReelContainer(env, igUserId, { videoUrl, caption, thumbOffsetMs, shareToFeed = true }) {
  const params = { media_type: 'REELS', video_url: videoUrl, caption, share_to_feed: shareToFeed ? 'true' : 'false' };
  if (Number.isFinite(thumbOffsetMs) && thumbOffsetMs > 0) params.thumb_offset = String(Math.round(thumbOffsetMs));
  return graph(env, 'POST', `${igUserId}/media`, params);
}

export function containerStatus(env, containerId) {
  return graph(env, 'GET', containerId, { fields: 'status_code,status' });
}

export function publishContainer(env, igUserId, containerId) {
  return graph(env, 'POST', `${igUserId}/media_publish`, { creation_id: containerId });
}

export async function mediaPermalink(env, mediaId) {
  const r = await graph(env, 'GET', mediaId, { fields: 'permalink' });
  return r.ok ? r.data.permalink || null : null;
}

function isPermissionError(r) {
  return r && (r.code === 10 || r.code === 200 || r.code === 190 || /permission|not authorized|scope/i.test(r.error || ''));
}

// ─── The pipeline (one step per call) ───────────────────────────────

const nowIso = () => new Date(Date.now()).toISOString();

export function reelEnabled(config) {
  return config?.reels?.enabled !== false;
}

/** Create the pipeline record when the replay becomes ready. */
export function startReel(state, sourceUid, overrideSeconds) {
  return {
    stage: 'pending', sourceUid, startedAt: nowIso(), updatedAt: nowIso(), checkedAt: null,
    duration: null, method: null, momentSeconds: null, confidence: null, overrideSeconds: overrideSeconds ?? null,
    start: null, end: null, clipUid: null, mp4Url: null, igUserId: null, containerId: null, mediaId: null, permalink: null,
    error: null, attempts: 0,
  };
}

/**
 * Advance state.reel one step. Returns { state, events } where events is a
 * list of short strings for the tick's work log. Never throws.
 */
export async function advanceReel(env, config, state, { force = false } = {}) {
  const r = state.reel;
  if (!r || ['done', 'failed', 'skipped', 'blocked'].includes(r.stage)) return { state, events: [] };
  if (!force && r.checkedAt && Date.now() - Date.parse(r.checkedAt) < STEP_INTERVAL_MS) return { state, events: [] };
  const cfg = { ...defaultReelConfig(), ...(config.reels || {}) };
  const reel = { ...r, checkedAt: nowIso(), attempts: (r.attempts || 0) + 1 };
  const events = [];
  const set = (patch) => Object.assign(reel, patch, { updatedAt: nowIso() });
  const fail = (error, stage = 'failed') => { set({ stage, error }); events.push(`reel:${stage}`); };

  try {
    if (Date.now() - Date.parse(reel.startedAt) > PIPELINE_TIMEOUT_MS) { fail('Timed out after 4 hours'); return { state: { ...state, reel }, events }; }

    switch (reel.stage) {
      case 'pending': {
        const v = await stream.getVideo(env, reel.sourceUid);
        if (!v.ok) { set({ error: stream.errorMessage(v) }); break; }
        const duration = Number(v.result?.duration) || 0;
        if (v.result?.status?.state !== 'ready' || !duration) break;
        set({ duration });
        if (duration <= cfg.maxSeconds) { set({ stage: 'download', start: 0, end: duration, method: 'fits', clipUid: null }); events.push('reel:fits'); break; }
        if (reel.overrideSeconds != null) { set({ stage: 'window', momentSeconds: reel.overrideSeconds, method: 'override', confidence: 1 }); break; }
        set({ stage: 'captions' });
        break;
      }
      case 'captions': {
        const waited = Date.now() - Date.parse(reel.startedAt);
        const list = await stream.listCaptions(env, reel.sourceUid);
        const tracks = Array.isArray(list.result) ? list.result : [];
        const en = tracks.find(t => (t.language || '').startsWith('en'));
        if (!en) {
          if (waited > 5 * 60 * 1000 && !reel.captionRequested) { await stream.requestCaptions(env, reel.sourceUid); set({ captionRequested: true }); }
          if (waited > CAPTION_WAIT_MS) { set({ stage: 'window', method: 'fallback', momentSeconds: null, error: 'No captions arrived; used the ending' }); events.push('reel:fallback'); }
          break;
        }
        if (en.status && en.status !== 'ready') {
          if (en.status === 'error' || waited > CAPTION_WAIT_MS) { set({ stage: 'window', method: 'fallback', momentSeconds: null, error: 'Captions failed; used the ending' }); events.push('reel:fallback'); }
          break;
        }
        const vtt = await stream.getCaptionsVtt(env, reel.sourceUid, en.language || 'en');
        const cues = parseVtt(vtt);
        const kw = detectByKeywords(cues);
        const ai = await detectByAi(env, cues, reel.duration);
        const pick = chooseMoment(kw, ai);
        if (pick) { set({ stage: 'window', momentSeconds: pick.seconds, method: pick.method, confidence: Math.round(pick.confidence * 100) / 100, kw: kw ? kw.seconds : null, ai: ai ? ai.seconds : null }); events.push(`reel:moment@${pick.seconds}`); }
        else { set({ stage: 'window', method: 'fallback', momentSeconds: null, error: 'No reveal language found; used the ending' }); events.push('reel:fallback'); }
        break;
      }
      case 'window': {
        const w = clipWindow(reel.duration, reel.momentSeconds, cfg);
        const c = await stream.createClip(env, { uid: reel.sourceUid, startTimeSeconds: w.start, endTimeSeconds: w.end, name: `${state.kidName ? `${state.kidName}'s` : 'Live'} reveal (Instagram cut)` });
        if (!c.ok || !c.result?.uid) { set({ error: stream.errorMessage(c, 'Clip failed') }); if (reel.attempts > 6) fail(reel.error); break; }
        set({ stage: 'clipping', start: w.start, end: w.end, clipUid: c.result.uid, error: null });
        events.push('reel:clip');
        break;
      }
      case 'clipping': {
        const v = await stream.getVideo(env, reel.clipUid);
        const st = v.result?.status?.state;
        if (st === 'error') { fail(`Stream could not make the clip: ${v.result?.status?.errorReasonText || 'unknown'}`); break; }
        if (st === 'ready') set({ stage: 'download' });
        break;
      }
      case 'download': {
        const uid = reel.clipUid || reel.sourceUid;
        let d = await stream.getDownloads(env, uid);
        let def = d.result?.default;
        if (!def) { d = await stream.createDownload(env, uid); def = d.result?.default; }
        if (!def) { set({ error: stream.errorMessage(d, 'MP4 not available') }); if (reel.attempts > 10) fail(reel.error); break; }
        if (def.status === 'error') { fail('Stream could not make the MP4'); break; }
        if (def.status === 'ready' && def.url) { set({ stage: 'instagram', mp4Url: def.url, error: null }); events.push('reel:mp4'); }
        break;
      }
      case 'instagram': {
        const ig = await instagramAccount(env);
        if (!ig.ok) { isPermissionError(ig) || /No professional Instagram/.test(ig.error) ? fail(ig.error, 'blocked') : set({ error: ig.error }); break; }
        const thumb = reel.momentSeconds != null && reel.start != null ? (reel.momentSeconds - reel.start + 3) * 1000 : undefined;
        const c = await createReelContainer(env, ig.id, { videoUrl: reel.mp4Url, caption: renderCaption(cfg.caption, state), thumbOffsetMs: thumb, shareToFeed: cfg.shareToFeed });
        if (!c.ok) { isPermissionError(c) ? fail(`Instagram refused: ${c.error}. The page token needs instagram_basic and instagram_content_publish.`, 'blocked') : set({ error: c.error }); if (reel.attempts > 12 && reel.stage !== 'blocked') fail(c.error); break; }
        set({ stage: 'processing', igUserId: ig.id, igUsername: ig.username, containerId: c.data.id, error: null });
        events.push('reel:container');
        break;
      }
      case 'processing': {
        const s = await containerStatus(env, reel.containerId);
        if (!s.ok) { set({ error: s.error }); break; }
        const code = s.data.status_code;
        if (code === 'ERROR' || code === 'EXPIRED') { fail(`Instagram could not process the video: ${s.data.status || code}`); break; }
        if (code !== 'FINISHED') break;
        const p = await publishContainer(env, reel.igUserId, reel.containerId);
        if (!p.ok) { set({ error: p.error }); if (reel.attempts > 20) fail(p.error); break; }
        const permalink = await mediaPermalink(env, p.data.id);
        set({ stage: 'done', mediaId: p.data.id, permalink, publishedAt: nowIso(), error: null });
        events.push('reel:published');
        break;
      }
      default:
        break;
    }
  } catch (e) {
    set({ error: e.message || String(e) });
  }
  return { state: { ...state, reel }, events };
}
