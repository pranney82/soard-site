/**
 * live-messages.ts — behaviour for LiveMessages.astro (messages for the family)
 * ============================================================================
 * One panel that lives in two places: beside the video during the watch
 * party (the hero's text column) and in its own section before it. It moves
 * between them on its own, but never while someone is typing in it.
 *
 * Chat order: newest at the bottom, next to the box you write in. The wall
 * stays pinned to the newest message unless you've scrolled up to read,
 * in which case a "New messages" button appears instead of yanking you down.
 *
 * Messages arrive over the real-time hub; without one that relays them, the
 * panel polls every 20 seconds.
 */
import type { LiveClient, LiveMessage } from './live-client';

export interface MessagesView {
  /** A broadcast is on (scheduled, live or replay) and it is this page's kid */
  active: boolean;
  broadcastId: string | null;
  kidName: string | null;
  /** Watch party: the panel goes beside the video */
  party: boolean;
}
interface Options {
  client: LiveClient;
  panel: HTMLElement;
  /** Slot in the hero's text column */
  heroSlot: HTMLElement;
  /** The section below the hero, and the slot inside it */
  section: HTMLElement;
  sectionSlot: HTMLElement;
  /** "Leave a message" in the hero, shown while the panel is in its section */
  cta: HTMLElement | null;
}

const POLL_MS = 20_000;
const MAX = 120;

export function createMessages(opts: Options) {
  const { client, panel, heroSlot, section, sectionSlot, cta } = opts;
  const $ = <T extends HTMLElement = HTMLElement>(k: string) => panel.querySelector(`[data-msgs="${k}"]`) as T | null;
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const list = $<HTMLOListElement>('list');
  const wall = $('wall');
  const form = $<HTMLFormElement>('form');
  const setHidden = (el: Element | null, hidden: boolean) => { if (el) (el as HTMLElement).hidden = hidden; };

  let view: MessagesView = { active: false, broadcastId: null, kidName: null, party: false };
  let broadcast = '';
  let open = false;
  let enabled = true;
  let loading = false;
  let shown = false;
  let relayed = false; // the hub relays messages, so no polling
  const ids = new Set<string>();

  const nearEnd = () => !wall || wall.scrollHeight - wall.scrollTop - wall.clientHeight < 80;
  function toEnd() {
    if (wall) { wall.style.scrollBehavior = 'auto'; wall.scrollTop = wall.scrollHeight; wall.style.scrollBehavior = ''; }
    setHidden($('jump'), true);
  }
  wall?.addEventListener('scroll', () => { if (nearEnd()) setHidden($('jump'), true); }, { passive: true });
  $('jump')?.addEventListener('click', () => { wall?.scrollTo({ top: wall.scrollHeight, behavior: reduced ? 'auto' : 'smooth' }); setHidden($('jump'), true); });

  function place() {
    const target = view.party ? heroSlot : sectionSlot;
    if (panel.parentElement === target || panel.contains(document.activeElement)) return;
    target.appendChild(panel);
    panel.dataset.place = view.party ? 'hero' : 'section';
    toEnd();
  }
  panel.addEventListener('focusout', () => setTimeout(() => { place(); paint(); }, 0));

  function paint() {
    place();
    const show = view.active && enabled && (open || ids.size > 0);
    const inHero = panel.parentElement === heroSlot;
    setHidden(heroSlot, !(show && inHero));
    setHidden(section, !(show && !inHero));
    setHidden(form, !open);
    setHidden($('closed'), open || !ids.size);
    setHidden($('empty'), !!ids.size || !open);
    setHidden(cta, !(show && open && !inHero));
    if (show && !shown) requestAnimationFrame(toEnd);
    shown = show;
  }

  function add(m: LiveMessage, animate = true, mine = false) {
    if (!list || ids.has(m.id)) return;
    const stick = mine || nearEnd();
    ids.add(m.id);
    const li = document.createElement('li');
    li.className = 'msg';
    li.dataset.id = m.id;
    if (!animate) li.style.animation = 'none';
    const who = document.createElement('span');
    who.className = 'msg__name';
    who.textContent = m.name;
    const text = document.createElement('p');
    text.className = 'msg__body';
    text.textContent = m.body;
    li.append(who, text);
    list.append(li);
    while (list.children.length > MAX) list.firstElementChild?.remove();
    setHidden($('empty'), true);
    if (stick) toEnd(); else setHidden($('jump'), false);
  }
  function remove(id: string) {
    ids.delete(id);
    list?.querySelector(`[data-id="${CSS.escape(id)}"]`)?.remove();
    setHidden($('empty'), !!list?.children.length);
  }

  async function load(fresh: boolean) {
    if (loading) return;
    loading = true;
    try {
      const res = await fetch('/api/live-messages', { cache: 'no-store' });
      const data = await res.json().catch(() => null);
      if (!data || !res.ok) return;
      enabled = !!data.enabled;
      if (!data.enabled || (data.broadcastId && data.broadcastId !== broadcast)) { paint(); return; }
      if (fresh && list) { list.innerHTML = ''; ids.clear(); }
      const incoming: LiveMessage[] = data.messages || [];
      const keep = new Set(incoming.map((m) => m.id));
      if (!fresh) for (const id of [...ids]) if (!keep.has(id)) remove(id);
      for (const m of incoming) add(m, !fresh);
      if (fresh) toEnd();
      open = !!data.open;
      paint();
    } catch { /* offline */ } finally { loading = false; }
  }

  const offs = [
    client.on('msg', ({ message }) => { if (broadcast) add(message); }),
    client.on('msg-hide', ({ id }) => remove(id)),
    client.on('connection', ({ connected }) => { if (connected && broadcast) load(false); }),
    // A hub that counts viewers also relays messages
    client.on('viewers', () => { relayed = true; }),
  ];
  const poll = setInterval(() => { if (broadcast && !(client.connected && relayed) && !document.hidden && shown) load(false); }, POLL_MS);

  // ── Posting ─────────────────────────────────────────────────────
  function store(key: string, value?: string) {
    try { if (value === undefined) return localStorage.getItem(key) || ''; localStorage.setItem(key, value); } catch { /* private mode */ }
    return '';
  }
  const clientId = store('soard-live-id') || (() => {
    const id = (crypto.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`).replace(/[^a-zA-Z0-9-]/g, '');
    store('soard-live-id', id);
    return id;
  })();
  if (form) {
    const nameInput = form.querySelector<HTMLInputElement>('input[name="name"]');
    const bodyInput = form.querySelector<HTMLTextAreaElement>('textarea[name="body"]');
    const count = $('count');
    const note = $('note');
    if (nameInput) nameInput.value = store('soard-live-name');
    bodyInput?.addEventListener('input', () => { if (count) count.textContent = `${bodyInput.value.length}/280`; });
    // Enter posts, Shift+Enter is a new line, like every chat
    bodyInput?.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); form.requestSubmit(); } });
    const say = (text: string, error = false) => { if (note) { note.className = error ? 'remind-note remind-note--error' : 'remind-note'; note.textContent = text; } };
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = form.querySelector('button[type="submit"]') as HTMLButtonElement;
      const name = nameInput?.value.trim() || '';
      const text = bodyInput?.value.trim() || '';
      if (!name) { say('Add your first name.', true); nameInput?.focus(); return; }
      if (text.length < 2) { say('Write a little more.', true); bodyInput?.focus(); return; }
      btn.disabled = true; say('Posting…');
      try {
        const res = await fetch('/api/live-messages', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name, body: text, clientId, website: (form.querySelector('input[name="website"]') as HTMLInputElement)?.value || '' }),
        });
        const data = await res.json().catch(() => ({}));
        if (res.ok && data.ok) {
          store('soard-live-name', name);
          if (bodyInput) bodyInput.value = '';
          if (count) count.textContent = '0/280';
          if (data.status === 'shown' && data.message) { add(data.message, true, true); say('Posted. Thank you!'); }
          else say('Thank you! Your message will show up once someone on our team takes a look.');
        } else {
          say(data.error || 'Something went wrong. Please try again.', true);
        }
      } catch {
        say('No connection. Please try again.', true);
      } finally {
        btn.disabled = false;
      }
    });
  }

  return {
    update(next: MessagesView) {
      view = next;
      const heading = $('heading');
      if (heading) heading.textContent = next.kidName ? `Messages for ${next.kidName}'s family` : 'Messages for the family';
      const area = panel.querySelector<HTMLTextAreaElement>('textarea');
      if (area) area.placeholder = next.kidName ? `${next.kidName}, we are so happy for you!` : 'We are so happy for you!';
      if (!next.active) { broadcast = ''; open = false; }
      else if (next.broadcastId !== broadcast) { broadcast = next.broadcastId || ''; load(true); }
      paint();
    },
    /** The page is being swapped out by a client-side navigation */
    destroy() {
      clearInterval(poll);
      for (const off of offs) off();
    },
  };
}
