/**
 * Reveal videos: build-time data for /reveals/, the /live/ "past reveals"
 * section, and the video block on each kid page.
 *
 * Cloudflare Stream purges a video for good once it is deleted (or 30 days
 * after a subscription lapse), and most of the old streamVideoId values in
 * content now 404. So a Stream id is only trusted after the build has seen
 * its HLS manifest answer 200. Everything else falls back to YouTube.
 *
 * The check runs once per build process: the first caller fires a request
 * for every Stream id in content (16 at a time, 6s timeout each) and every
 * later page reads the memoized result. With no network, ids come back
 * "unknown" and the kid keeps whatever it can still show (YouTube first).
 */
import type { CollectionEntry } from 'astro:content';
import { getPublishedKids } from './collections';
import { cfId } from './cf-image';

export const STREAM_CUSTOMER_HOST = 'customer-cuav5h47lgfe96ql.cloudflarestream.com';
const STREAM_ORIGIN = `https://${STREAM_CUSTOMER_HOST}`;

const CHECK_TIMEOUT_MS = 6000;
const MAX_CONCURRENT_CHECKS = 16;

type KidData = CollectionEntry<'kids'>['data'];
type KidVideoFields = Pick<KidData, 'streamVideoId' | 'videoUrl'>;

export interface KidVideo {
  type: 'stream' | 'youtube';
  id: string;
}

export interface RevealSource extends KidVideo {
  /** width / height of the video frame (portrait phone lives are < 1) */
  aspect: number;
}

export interface RevealKid {
  slug: string;
  name: string;
  year: number | null;
}

export interface Reveal {
  /** Stable, DOM-safe key: "youtube-<id>" or "stream-<uid>" */
  key: string;
  /** 'live' = a recorded live stream replay (revealVideoUrl) */
  kind: 'live' | 'video';
  source: RevealSource;
  /** Player URL for the lightbox iframe (autoplays) */
  embedUrl: string;
  /** Plain watch page, used as the no-JS link target */
  watchUrl: string;
  kids: RevealKid[];
  /** Newest year this video covers; drives sorting */
  year: number | null;
  /** Every year this video belongs to, newest first; drives the year filter */
  years: number[];
  /** "2024", "2019 and 2020", "2016 to 2018" */
  yearLabel: string;
  rooms: string[];
  /** Cloudflare Images id for the card art (first kid with a hero photo) */
  image: string | null;
  /** "Axel's room reveal", "Remi & Nico's room reveal", "2018 reveals" */
  title: string;
  /** Every kid name, in prose: "Ben, Caleb and Kyle" */
  names: string;
}

// ── URL parsing ──────────────────────────────────────────────

export function youTubeId(url?: string | null): string | null {
  if (!url) return null;
  const m = url.match(/(?:youtu\.be\/|youtube(?:-nocookie)?\.com\/(?:watch\?(?:.*&)?v=|embed\/|shorts\/|live\/))([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}

const STREAM_UID_RE = /^[a-f0-9]{32}$/i;

/** Pull the Stream uid out of a revealVideoUrl (watch.cloudflarestream.com/<uid>, customer-*.../<uid>/watch, ...) */
export function streamUidFromUrl(url?: string | null): string | null {
  if (!url) return null;
  const m = url.match(/(?:^|\/)([a-f0-9]{32})(?:\/|$|\?|#)/i);
  return m ? m[1].toLowerCase() : null;
}

// ── Build-time Stream playability check ─────────────────────

type StreamState = 'playable' | 'gone' | 'unknown';
interface StreamCheck {
  state: StreamState;
  aspect: number | null;
}

const UNKNOWN: StreamCheck = { state: 'unknown', aspect: null };
const checks = new Map<string, Promise<StreamCheck>>();

let activeChecks = 0;
const waitingChecks: Array<() => void> = [];
let networkOk = 0;
let networkFailed = 0;
/** No answer at all from the first few requests: stop waiting on timeouts and treat the rest as unknown */
const networkDown = () => networkOk === 0 && networkFailed >= 3;

function acquireSlot(): Promise<void> {
  if (activeChecks < MAX_CONCURRENT_CHECKS) {
    activeChecks++;
    return Promise.resolve();
  }
  return new Promise((resolve) => waitingChecks.push(resolve));
}

function releaseSlot() {
  const next = waitingChecks.shift();
  // Hand the slot straight to the next waiter so the cap can never be exceeded
  if (next) next();
  else activeChecks--;
}

/** Master playlists list RESOLUTION=WxH per rendition; any one gives the frame shape */
function parseAspect(manifest: string): number | null {
  const m = manifest.match(/RESOLUTION=(\d+)x(\d+)/);
  if (!m) return null;
  const w = Number(m[1]);
  const h = Number(m[2]);
  return w > 0 && h > 0 ? Math.round((w / h) * 1000) / 1000 : null;
}

async function runStreamCheck(uid: string): Promise<StreamCheck> {
  if (!STREAM_UID_RE.test(uid)) return { state: 'gone', aspect: null };
  if (networkDown()) return UNKNOWN;
  await acquireSlot();
  try {
    if (networkDown()) return UNKNOWN;
    const res = await fetch(`${STREAM_ORIGIN}/${uid}/manifest/video.m3u8`, {
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
    });
    networkOk++;
    if (res.status === 200) {
      const body = await res.text().catch(() => '');
      return { state: 'playable', aspect: parseAspect(body) };
    }
    await res.body?.cancel().catch(() => {});
    // 404 = purged, 403 = subscription lapsed: either way it will not play
    if (res.status >= 400 && res.status < 500) return { state: 'gone', aspect: null };
    return UNKNOWN;
  } catch {
    networkFailed++;
    return UNKNOWN;
  } finally {
    releaseSlot();
  }
}

function checkStream(uid: string): Promise<StreamCheck> {
  const key = uid.toLowerCase();
  let pending = checks.get(key);
  if (!pending) {
    pending = runStreamCheck(key);
    checks.set(key, pending);
  }
  return pending;
}

let warmed: Promise<void> | null = null;

/** Check every Stream id in published content in one parallel pass (memoized) */
function warmStreamChecks(): Promise<void> {
  warmed ??= (async () => {
    try {
      const kids = await getPublishedKids();
      const uids = new Set<string>();
      for (const { data } of kids) {
        if (data.streamVideoId) uids.add(data.streamVideoId.trim().toLowerCase());
        const live = streamUidFromUrl(data.revealVideoUrl);
        if (live) uids.add(live);
      }
      const results = await Promise.all([...uids].map(checkStream));
      const tally = { playable: 0, gone: 0, unknown: 0 };
      for (const r of results) tally[r.state]++;
      console.log(`[reveals] Stream check: ${tally.playable} playable, ${tally.gone} gone, ${tally.unknown} unknown`);
    } catch (err) {
      console.warn('[reveals] Stream check skipped:', err);
    }
  })();
  return warmed;
}

// ── Per-kid video ────────────────────────────────────────────

async function resolveSource(kid: KidVideoFields): Promise<RevealSource | null> {
  const streamId = kid.streamVideoId?.trim().toLowerCase() || null;
  const ytId = youTubeId(kid.videoUrl);
  if (streamId) {
    await warmStreamChecks();
    const check = await checkStream(streamId);
    if (check.state === 'playable' || (check.state === 'unknown' && !ytId)) {
      return { type: 'stream', id: streamId, aspect: check.aspect ?? 16 / 9 };
    }
  }
  if (ytId) return { type: 'youtube', id: ytId, aspect: 16 / 9 };
  return null;
}

/**
 * The video a kid page should play: the Stream upload when the build saw it
 * play, otherwise YouTube, otherwise nothing (no dead player on the page).
 */
export async function resolveKidVideo(kid: KidVideoFields): Promise<KidVideo | null> {
  const source = await resolveSource(kid);
  return source ? { type: source.type, id: source.id } : null;
}

export function embedUrl(source: KidVideo): string {
  return source.type === 'youtube'
    ? `https://www.youtube-nocookie.com/embed/${source.id}?autoplay=1&rel=0&playsinline=1`
    : `${STREAM_ORIGIN}/${source.id}/iframe?autoplay=true`;
}

export function watchUrl(source: KidVideo): string {
  return source.type === 'youtube'
    ? `https://www.youtube.com/watch?v=${source.id}`
    : `${STREAM_ORIGIN}/${source.id}/watch`;
}

// ── Reveal list ──────────────────────────────────────────────

const ROOM_ORDER: Record<string, number> = {
  'Dream Bedroom': 0,
  'Accessible Bathroom': 1,
  'Therapy Room': 2,
  'Wheelchair Ramp': 3,
  'Chair Lift': 4,
};

/** "Ben", "Ben & Kyle", "Ben, Kyle & Zyah" */
function joinShort(names: string[]): string {
  if (names.length <= 1) return names[0] || '';
  return `${names.slice(0, -1).join(', ')} & ${names[names.length - 1]}`;
}

/** "Ben", "Ben and Kyle", "Ben, Kyle and Zyah" */
export function joinNames(names: string[]): string {
  if (names.length <= 1) return names[0] || '';
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

function yearLabel(yearsAsc: number[]): string {
  if (!yearsAsc.length) return '';
  if (yearsAsc.length === 1) return String(yearsAsc[0]);
  if (yearsAsc.length === 2) return `${yearsAsc[0]} and ${yearsAsc[1]}`;
  return `${yearsAsc[0]} to ${yearsAsc[yearsAsc.length - 1]}`;
}

/**
 * Years a video belongs to. A small group keeps every kid's year. A big
 * compilation keeps the years that hold at least two of its kids, so one
 * stray record (a kid with a later page reusing an old video) does not
 * stretch "2018 reveals" into "2018 and 2024 reveals".
 */
function videoYears(kids: RevealKid[]): number[] {
  const counts = new Map<number, number>();
  for (const k of kids) if (k.year) counts.set(k.year, (counts.get(k.year) || 0) + 1);
  let years = [...counts.keys()];
  if (kids.length > 3) {
    const shared = years.filter((y) => (counts.get(y) || 0) >= 2);
    if (shared.length) years = shared;
  }
  return years.sort((a, b) => a - b);
}

interface Group {
  kind: Reveal['kind'];
  source: RevealSource;
  kids: KidData[];
}

let revealsMemo: Promise<Reveal[]> | null = null;

/**
 * One entry per unique playable video across published kids. Live stream
 * replays first, then newest year, then name.
 */
export function getReveals(): Promise<Reveal[]> {
  revealsMemo ??= buildReveals();
  return revealsMemo;
}

async function buildReveals(): Promise<Reveal[]> {
  const kids = await getPublishedKids();
  await warmStreamChecks();

  const groups = new Map<string, Group>();
  const add = (kind: Reveal['kind'], source: RevealSource, kid: KidData) => {
    const key = `${source.type}-${source.id}`;
    const group = groups.get(key);
    if (!group) {
      groups.set(key, { kind, source, kids: [kid] });
      return;
    }
    if (kind === 'live') group.kind = 'live';
    if (!group.kids.some((k) => k.slug === kid.slug)) group.kids.push(kid);
  };

  for (const { data: kid } of kids) {
    const liveUid = streamUidFromUrl(kid.revealVideoUrl);
    if (liveUid) {
      const check = await checkStream(liveUid);
      if (check.state !== 'gone') {
        add('live', { type: 'stream', id: liveUid, aspect: check.aspect ?? 16 / 9 }, kid);
      }
    }
    const source = await resolveSource(kid);
    if (source) add('video', source, kid);
  }

  const reveals: Reveal[] = [...groups.entries()].map(([key, group]) => {
    const sortedKids = [...group.kids].sort((a, b) => a.name.localeCompare(b.name));
    const revealKids: RevealKid[] = sortedKids.map((k) => ({ slug: k.slug, name: k.name, year: k.year ?? null }));
    const yearsAsc = videoYears(revealKids);
    const label = yearLabel(yearsAsc);
    const names = revealKids.map((k) => k.name);
    const rooms = [...new Set(sortedKids.flatMap((k) => k.roomTypes || []))]
      .sort((a, b) => (ROOM_ORDER[a] ?? 99) - (ROOM_ORDER[b] ?? 99));
    const withPhoto = sortedKids.find((k) => k.heroImage);

    const title = names.length > 3
      ? `${label || 'Room'} reveals`
      : `${joinShort(names)}'s room reveal`;

    return {
      key,
      kind: group.kind,
      source: group.source,
      embedUrl: embedUrl(group.source),
      watchUrl: watchUrl(group.source),
      kids: revealKids,
      year: yearsAsc.length ? yearsAsc[yearsAsc.length - 1] : null,
      years: [...yearsAsc].reverse(),
      yearLabel: label,
      rooms,
      image: withPhoto?.heroImage ? cfId(withPhoto.heroImage) : null,
      title,
      names: joinNames(names),
    };
  });

  return reveals.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'live' ? -1 : 1;
    if ((b.year ?? 0) !== (a.year ?? 0)) return (b.year ?? 0) - (a.year ?? 0);
    return a.kids[0].name.localeCompare(b.kids[0].name);
  });
}

let gridSeq = 0;
/** Unique DOM id prefix per RevealGrid instance (the component can appear twice on a page) */
export function nextRevealGridId(): string {
  gridSeq += 1;
  return `rv${gridSeq}`;
}
