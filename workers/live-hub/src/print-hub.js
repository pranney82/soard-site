/**
 * PrintHub: SOARD's label printer at the Office, held open over Zebra's Cloud Connect (Weblink)
 * ==============================================================================================
 * The Zebra ZD421 opens a WebSocket to the site (/api/printer-ws/, which checks its
 * password and hands the socket here over the PRINT_HUB binding) and keeps it open.
 * Zebra's protocol (application note "Creating a Weblink endpoint"):
 *   - every frame is binary (a text frame makes the printer hang up);
 *   - the first socket is the main channel ("v1.weblink.zebra.com"): the printer
 *     says {"discovery_b64": …}; the hub answers {"open":"v1.raw.zebra.com"} and
 *     asks for every alert {"configure_alert":"ALL MESSAGES,SDK,Y,Y,,,N"};
 *   - the printer then opens a second socket, the raw channel ("v1.raw.zebra.com"),
 *     says {"unique_id", "channel_name", "channel_id"}; ZPL sent on it prints;
 *   - alerts on the main channel: {"alert":{"condition_id":"HEAD OPEN","condition_state":"SET"|"CLEAR"}}.
 * The site asks POST /print { labels: [zpl] } → { sent, online, problems } and GET /status.
 * Sockets hibernate between labels; the printer's pings are answered without waking the object.
 */

import { DurableObject } from 'cloudflare:workers';

const PROTOCOLS = ['v1.weblink.zebra.com', 'v1.raw.zebra.com', 'v1.config.zebra.com'];
const enc = new TextEncoder();
const dec = new TextDecoder();
const bin = (obj) => enc.encode(JSON.stringify(obj));
// The conditions that stop a label, in plain words
const PROBLEMS = {
  'PAPER OUT': 'Out of labels', 'MEDIA OUT': 'Out of labels', 'RIBBON OUT': 'Out of ribbon', 'HEAD OPEN': 'The lid is open',
  'PRINTER PAUSED': 'Paused', 'HEAD TOO HOT': 'Too hot', 'HEAD COLD': 'Warming up', 'MEDIA LOW': 'Labels running low', 'RIBBON LOW': 'Ribbon running low',
};
const QUEUE_MAX = 60;
// Labels wait this long for the printer to come back (the page says they print when it's back on)
const QUEUE_MS = 2 * 60 * 60 * 1000;
const fresh = (queue) => (queue || []).filter((q) => Date.now() - q.at < QUEUE_MS);

export class PrintHub extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/printer') return this.connect(request);
    if (url.pathname === '/print' && request.method === 'POST') return Response.json(await this.print(await request.json().catch(() => ({}))));
    if (url.pathname === '/status') return Response.json(await this.status());
    return new Response('Not found', { status: 404 });
  }

  /** The printer's socket: the channel it asks for, echoed back (Zebra requires it) */
  connect(request) {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('Expected a WebSocket', { status: 426 });
    const asked = String(request.headers.get('Sec-WebSocket-Protocol') || '').split(',').map((s) => s.trim());
    const channel = PROTOCOLS.find((p) => asked.includes(p)) || PROTOCOLS[0];
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server, [channel]);
    server.serializeAttachment({ channel, at: Date.now() });
    if (channel === PROTOCOLS[0]) this.ctx.storage.put('seenAt', Date.now());
    return new Response(null, { status: 101, webSocket: client, headers: { 'Sec-WebSocket-Protocol': channel, 'Content-Length': '0' } });
  }

  async webSocketMessage(ws, message) {
    const { channel } = ws.deserializeAttachment() || {};
    let msg = null;
    try { msg = JSON.parse(typeof message === 'string' ? message : dec.decode(message)); } catch { /* status replies on the raw channel aren't JSON */ }
    await this.ctx.storage.put('seenAt', Date.now());
    if (channel === PROTOCOLS[0]) {
      if (msg?.discovery_b64 !== undefined) {
        ws.send(bin({ open: PROTOCOLS[1] }));
        ws.send(bin({ configure_alert: 'ALL MESSAGES,SDK,Y,Y,,,N' }));
        await this.ctx.storage.put('printer', { discoveredAt: Date.now() });
      }
      const a = msg?.alert;
      if (a?.condition_id) {
        const problems = (await this.ctx.storage.get('problems')) || {};
        const words = PROBLEMS[String(a.condition_id).toUpperCase()];
        if (words) {
          if (String(a.condition_state).toUpperCase() === 'CLEAR') delete problems[a.condition_id];
          else problems[a.condition_id] = { words, at: Date.now() };
          await this.ctx.storage.put('problems', problems);
        }
        if (String(a.condition_id).toUpperCase() === 'PQ JOB COMPLETED') await this.ctx.storage.put('printedAt', Date.now());
      }
      return;
    }
    if (channel === PROTOCOLS[1] && msg?.channel_name) {
      ws.serializeAttachment({ channel, at: Date.now(), id: msg.unique_id || null });
      await this.ctx.storage.put('rawAt', Date.now());
      // The printer's new raw channel replaces any old one (after a power cut the old socket can linger, dead)
      for (const old of this.ctx.getWebSockets(PROTOCOLS[1])) {
        if (old !== ws) { try { old.close(1000, 'replaced'); } catch { /* already gone */ } }
      }
      // Labels that waited for the printer go now, oldest first
      const queue = fresh(await this.ctx.storage.get('queue'));
      for (const q of queue) ws.send(enc.encode(q.zpl));
      await this.ctx.storage.put('queue', []);
    }
  }

  async webSocketClose(ws, code) {
    try { ws.close(code === 1005 ? 1000 : code, 'bye'); } catch { /* already closed */ }
  }

  async webSocketError() { /* the printer reconnects on its own after its retry interval */ }

  /** The newest open raw channel (the one the printer opened last) */
  raw() {
    const open = this.ctx.getWebSockets(PROTOCOLS[1]).filter((ws) => ws.readyState === 1);
    return open.sort((a, b) => (b.deserializeAttachment()?.at || 0) - (a.deserializeAttachment()?.at || 0))[0] || null;
  }

  /** Print labels now, or keep them for the moment the printer is back (up to two hours) */
  async print({ labels = [] } = {}) {
    const zpls = labels.map(String).filter((z) => z.startsWith('^XA')).slice(0, 40);
    const problems = Object.values((await this.ctx.storage.get('problems')) || {}).map((p) => p.words);
    const ws = this.raw();
    if (ws) {
      for (const z of zpls) ws.send(enc.encode(z));
      return { sent: zpls.length, online: true, problems };
    }
    const queue = fresh(await this.ctx.storage.get('queue'));
    queue.push(...zpls.map((zpl) => ({ zpl, at: Date.now() })));
    await this.ctx.storage.put('queue', queue.slice(-QUEUE_MAX));
    return { sent: 0, queued: zpls.length, online: false, problems };
  }

  async status() {
    const [seenAt, printedAt, problems, queue] = await Promise.all(['seenAt', 'printedAt', 'problems', 'queue'].map((k) => this.ctx.storage.get(k)));
    return {
      online: Boolean(this.raw()), main: this.ctx.getWebSockets(PROTOCOLS[0]).length > 0, seenAt: seenAt || null, printedAt: printedAt || null,
      problems: Object.values(problems || {}).map((p) => p.words), waiting: fresh(queue).length,
    };
  }
}
