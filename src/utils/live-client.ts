/**
 * live-client.ts — one shared connection to the live broadcast state
 * ===================================================================
 * Used by the LIVE pill (every page) and the /live pages. Opens a WebSocket
 * to /api/live-ws (proxied to the real-time hub) so state changes arrive in
 * under a second; falls back to polling /api/broadcast when the socket is
 * unavailable. A single instance lives on window so the pill and the live
 * page never open two sockets.
 */

export interface LivePlayer { kind: 'live' | 'replay'; uid: string; customerCode: string }
export interface LiveState {
  phase: 'idle' | 'scheduled' | 'armed' | 'live' | 'ending' | 'replay';
  live: boolean; upcoming: boolean; replay: boolean;
  id: string | null;
  kidSlug: string | null; kidName: string | null;
  title: string | null; message: string | null; image: string | null;
  scheduledAt: string | null; liveAt: string | null; endedAt: string | null; replayUntil: string | null;
  url: string; liveUrl: string;
  player: LivePlayer | null;
  facebookUrl: string | null; youtubeUrl: string | null;
  source: string | null; updatedAt: string | null;
}
export interface ReminderOptions { enabled: boolean; email: boolean; sms: boolean; push: boolean; pushKey: string | null }
type Listener = (state: LiveState | null, meta: { reminders: ReminderOptions | null; timezone: string | null }) => void;

const KEY = '__soardLiveClient';

function createClient() {
  let state: LiveState | null = null;
  let reminders: ReminderOptions | null = null;
  let timezone: string | null = null;
  const listeners = new Set<Listener>();
  let ws: WebSocket | null = null;
  let wsOk = false;
  let failures = 0;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  const emit = () => { for (const l of listeners) { try { l(state, { reminders, timezone }); } catch { /* listener bug */ } } };

  async function fetchState() {
    try {
      const res = await fetch('/api/broadcast', { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      if (data?.state) {
        state = data.state; reminders = data.reminders || null; timezone = data.timezone || null;
        emit();
      }
    } catch { /* offline */ }
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
        }
      } catch { /* ignore */ }
    };
    ws.onclose = () => {
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

  fetchState();
  connect();
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { fetchState(); if (!wsOk && !reconnectTimer) connect(); }
  });

  return {
    subscribe(l: Listener) {
      listeners.add(l);
      if (state) l(state, { reminders, timezone });
      return () => listeners.delete(l);
    },
    get state() { return state; },
    get reminders() { return reminders; },
    get timezone() { return timezone; },
    refresh: fetchState,
    beacon(type: string, meta?: Record<string, string>) {
      try {
        const body = JSON.stringify({ type, broadcastId: state?.id || undefined, meta });
        const blob = new Blob([body], { type: 'application/json' });
        if (!(navigator.sendBeacon && navigator.sendBeacon('/api/broadcast-event', blob))) {
          fetch('/api/broadcast-event', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
        }
      } catch { /* analytics only */ }
    },
  };
}

export type LiveClient = ReturnType<typeof createClient>;

export function getLiveClient(): LiveClient {
  const w = window as unknown as Record<string, LiveClient>;
  if (!w[KEY]) w[KEY] = createClient();
  return w[KEY];
}

/** "in 2 days", "in 3 hours", "in 12 minutes", "any minute now", "" once passed */
export function relativeUntil(iso: string | null, now = Date.now()): string {
  if (!iso) return '';
  const ms = Date.parse(iso) - now;
  if (!Number.isFinite(ms)) return '';
  if (ms <= 60_000) return ms > -10 * 60_000 ? 'any minute now' : '';
  const min = Math.round(ms / 60_000);
  if (min < 60) return `in ${min} minute${min === 1 ? '' : 's'}`;
  const hrs = Math.round(ms / 3_600_000);
  if (hrs < 36) return `in ${hrs} hour${hrs === 1 ? '' : 's'}`;
  const days = Math.round(ms / 86_400_000);
  return `in ${days} day${days === 1 ? '' : 's'}`;
}

export function formatWhen(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
  const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' }).format(d);
  if (sameDay) return `today at ${time}`;
  if (d.toDateString() === tomorrow.toDateString()) return `tomorrow at ${time}`;
  const day = new Intl.DateTimeFormat(undefined, { weekday: 'long', month: 'long', day: 'numeric' }).format(d);
  return `${day} at ${time}`;
}
