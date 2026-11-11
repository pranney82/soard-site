/**
 * live-client.ts — one shared connection to the live broadcast state
 * ===================================================================
 * Used by the LIVE pill (every page) and the /live pages. Opens a WebSocket
 * to /api/live-ws (proxied to the real-time hub) so state changes arrive in
 * under a second; falls back to polling /api/broadcast when the socket is
 * unavailable. A single instance lives on window so the pill and the live
 * page never open two sockets; a same-origin iframe (the starting-soon screen
 * shown inside the live page) borrows its parent's instance too.
 *
 * Watch party: a live page calls watch() so the hub counts it as a viewer,
 * then gets 'viewers', 'react' and 'msg' / 'msg-hide' events through on().
 */

import { noteArrival, sender } from './live-stats';

export interface LivePlayer {
  kind: 'live' | 'replay'; uid: string; customerCode: string;
  /** HLS address override; only the dev mock (scripts/dev-live-mock.js) sets it */
  src?: string;
}
export interface LiveState {
  phase: 'idle' | 'scheduled' | 'armed' | 'live' | 'ending' | 'replay';
  live: boolean; upcoming: boolean; replay: boolean;
  id: string | null;
  kidSlug: string | null; kidName: string | null;
  title: string | null; message: string | null; image: string | null;
  scheduledAt: string | null; liveAt: string | null; endedAt: string | null; replayUntil: string | null;
  url: string; liveUrl: string;
  player: LivePlayer | null;
  facebookUrl: string | null; youtubeUrl: string | null; instagramUrl: string | null;
  orientation: 'landscape' | 'portrait';
  source: string | null; updatedAt: string | null;
}
export interface ReminderOptions { enabled: boolean; hours?: number[]; email: boolean; sms: boolean; push: boolean; pushKey: string | null }
type Listener = (state: LiveState | null, meta: { reminders: ReminderOptions | null; timezone: string | null }) => void;
export type ReactionKind = 'heart' | 'sun' | 'clap' | 'wow';
export interface LiveMessage { id: string; name: string; body: string; at: string }
export interface LiveEvents {
  viewers: { n: number };
  react: { c: Partial<Record<ReactionKind, number>> };
  msg: { message: LiveMessage };
  'msg-hide': { id: string };
  connection: { connected: boolean };
  /** The live state couldn't be read (an error, or no connection) and nothing is known yet */
  unreachable: Record<string, never>;
}
type EventListener<K extends keyof LiveEvents> = (data: LiveEvents[K]) => void;

const KEY = '__soardLiveClient';

function createClient() {
  let state: LiveState | null = null;
  let reminders: ReminderOptions | null = null;
  let timezone: string | null = null;
  const listeners = new Set<Listener>();
  const eventListeners: { [K in keyof LiveEvents]?: Set<EventListener<K>> } = {};
  let watching = false;
  const fire = <K extends keyof LiveEvents>(type: K, data: LiveEvents[K]) => {
    for (const l of (eventListeners[type] || []) as Set<EventListener<K>>) { try { l(data); } catch { /* listener bug */ } }
  };
  const send = (obj: unknown) => { if (!wsOk || !ws) return false; try { ws.send(JSON.stringify(obj)); return true; } catch { return false; } };
  let ws: WebSocket | null = null;
  let wsOk = false;
  let failures = 0;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  // Listeners hear nothing until /api/broadcast has answered: the reminder options and time zone come only with it, and
  // the real-time hub's state (often first) without them read as "no reminders", so /live/ dropped its sign-up button
  // and form for a moment and put them back. A state from the hub before then is kept, and heard with the answer.
  let settled = false;
  const emit = () => { if (!settled) return; for (const l of listeners) { try { l(state, { reminders, timezone }); } catch { /* listener bug */ } } };

  let unreachable = false;
  // No answer to wait for any more: whatever state the hub gave is heard (its reminders unknown)
  const failed = () => { settled = true; if (state) { emit(); return; } unreachable = true; fire('unreachable', {}); };
  async function fetchState() {
    try {
      const res = await fetch('/api/broadcast', { cache: 'no-store' });
      if (!res.ok) { failed(); return; }
      const data = await res.json();
      if (data?.state) {
        state = data.state; reminders = data.reminders || null; timezone = data.timezone || null;
        settled = true;
        emit();
      } else {
        // Answered with no state yet (the hub has no snapshot): the hub's own, if it gave one, is heard now
        settled = true;
        if (state) emit();
      }
    } catch { failed(); }
  }

  function pollDelay() {
    const p = state?.phase;
    if (p === 'live' || p === 'ending' || p === 'armed') return 10_000;
    if (p === 'scheduled') return 30_000;
    return 60_000;
  }

  function schedulePoll() {
    clearTimeout(pollTimer);
    if (wsOk) return;
    pollTimer = setTimeout(async () => {
      if (!document.hidden) await fetchState();
      schedulePoll();
    }, pollDelay());
  }

  function connect() {
    if (!('WebSocket' in window)) { schedulePoll(); return; }
    try {
      ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/live-ws`);
    } catch { schedulePoll(); return; }
    ws.onopen = () => {
      wsOk = true; failures = 0;
      if (watching) send({ t: 'watch' });
      fire('connection', { connected: true });
      clearTimeout(pollTimer);
      clearInterval(pingTimer);
      pingTimer = setInterval(() => { try { ws?.send('ping'); } catch { /* closing */ } }, 25_000);
    };
    ws.onmessage = (ev) => {
      if (typeof ev.data !== 'string' || ev.data === 'pong') return;
      try {
        const m = JSON.parse(ev.data);
        if (m.type === 'state') {
          if (m.state) { state = m.state; emit(); }
          else fetchState(); // hub has no snapshot yet
        } else if (m.type === 'viewers' && typeof m.n === 'number') fire('viewers', { n: m.n });
        else if (m.type === 'react' && m.c && typeof m.c === 'object') fire('react', { c: m.c });
        else if (m.type === 'msg' && m.message?.id) fire('msg', { message: m.message });
        else if (m.type === 'msg-hide' && m.id) fire('msg-hide', { id: m.id });
      } catch { /* ignore */ }
    };
    ws.onclose = () => {
      if (wsOk) fire('connection', { connected: false });
      wsOk = false;
      clearInterval(pingTimer);
      failures++;
      // Quick retries at first; if the hub really isn't there, back off to 5 min and rely on polling
      const delay = failures <= 4 ? Math.min(15_000, 1000 * 2 ** failures) : 5 * 60_000;
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, delay);
      schedulePoll();
    };
    ws.onerror = () => { try { ws?.close(); } catch { /* already closed */ } };
  }

  // How this tab arrived, for Reveal stats' "where viewers came from" (once per session)
  noteArrival();
  fetchState();
  connect();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { fetchState(); if (!wsOk && !reconnectTimer) connect(); }
  });

  return {
    subscribe(l: Listener) {
      listeners.add(l);
      if (state && settled) l(state, { reminders, timezone });
      return () => listeners.delete(l);
    },
    /** Count this page as a viewer (live pages only). Re-sent after reconnects. */
    watch() { watching = true; send({ t: 'watch' }); },
    /** Stop counting this tab as a viewer (it navigated away from the live page). */
    unwatch() { if (!watching) return; watching = false; send({ t: 'unwatch' }); },
    /** Send a reaction to everyone watching. False when there is no real-time connection. */
    react(kind: ReactionKind) { return send({ t: 'react', k: kind }); },
    on<K extends keyof LiveEvents>(type: K, l: EventListener<K>) {
      ((eventListeners[type] ||= new Set() as never) as Set<EventListener<K>>).add(l);
      return () => (eventListeners[type] as Set<EventListener<K>>).delete(l);
    },
    get connected() { return wsOk; },
    /** Its first read failed and nothing is known yet: a page can show what it can without waiting */
    get unreachable() { return unreachable && !state; },
    get state() { return state; },
    get reminders() { return reminders; },
    get timezone() { return timezone; },
    refresh: fetchState,
    beacon(type: string, meta?: Record<string, string>) {
      try {
        const body = JSON.stringify({ type, broadcastId: state?.id || undefined, meta, ...sender() });
        const blob = new Blob([body], { type: 'application/json' });
        if (!(navigator.sendBeacon && navigator.sendBeacon('/api/broadcast-event', blob))) {
          fetch('/api/broadcast-event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
        }
      } catch { /* analytics only */ }
    },
    /** Reveal stats: this browser watched `sec` more seconds of the reveal (live) or its replay */
    watched(kind: 'live' | 'replay', sec: number, broadcastId: string | null) {
      if (!broadcastId || !(sec > 0)) return;
      try {
        const body = JSON.stringify({ broadcastId, kind, sec, ...sender() });
        if (!(navigator.sendBeacon && navigator.sendBeacon('/api/live-watch', new Blob([body], { type: 'application/json' })))) {
          fetch('/api/live-watch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
        }
      } catch { /* counting only */ }
    },
  };
}

export type LiveClient = ReturnType<typeof createClient>;

export function getLiveClient(): LiveClient {
  // Inside a same-origin frame (the starting-soon screen on the live page), share the parent's socket
  try {
    if (window.parent !== window) {
      const parent = window.parent as unknown as Record<string, LiveClient>;
      if (parent[KEY]) return parent[KEY];
    }
  } catch { /* cross-origin parent */ }
  const w = window as unknown as Record<string, LiveClient>;
  if (!w[KEY]) w[KEY] = createClient();
  return w[KEY];
}

// The time words ("in 8 days", "Wednesday, November 18 at 4:00 PM EST", "Reveal day") live in ./live-when, where the
// server can use them too (functions/live/[[path]].js writes the hero before the page script runs)
export { relativeUntil, revealLabel, formatWhen } from './live-when';
