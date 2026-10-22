/**
 * Emails & invites → What went out (admin)
 * ========================================
 * Loaded by ./messages.js. Every message that went out, newest first, and
 * whether it arrived: Resend reports each email the site sends (delivered,
 * bounced and why, marked as spam), JobTread status emails, calendar
 * invites, Kit's emails with its numbers, browser alerts and staff texts.
 * What goes out next sits on top; what didn't arrive gets its own card with
 * what to do; and "Will it land?" checks SPF, DKIM and DMARC on the sending
 * domains, with the 30-day bounce and spam rates.
 *
 * Read from GET /api/messages-admin?activity=1 when the tab opens and when
 * the browser tab comes back into focus (no refresh button). A row opens the
 * email exactly as it went (?email=<Resend id>), with each report Resend sent.
 */

import { h, htm, useState, useEffect, useRef, useMemo } from './vendor.js';

const html = htm.bind(h);

const API = '/api/messages-admin';
const TZ = 'America/New_York';
const MIN = 60e3;
const DAY = 864e5;

const time = (iso) => new Date(iso).toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
const dayKey = (t) => new Date(t).toLocaleDateString('en-CA', { timeZone: TZ });
function dayLabel(iso, now) {
  const k = dayKey(iso);
  if (k === dayKey(now)) return 'Today';
  if (k === dayKey(now - DAY)) return 'Yesterday';
  if (k === dayKey(now + DAY)) return 'Tomorrow';
  return new Date(iso).toLocaleDateString('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric' });
}
const when = (iso, now) => `${dayLabel(iso, now)}, ${time(iso)}`;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const lower = (s) => String(s || '').toLowerCase();

// What each status says, and its tone (ok | idle | warn | bad; "bad" is amber, never red)
const STATUS = {
  delivered: ['Delivered', 'ok'], sent: ['Sent', 'idle'], scheduled: ['Scheduled', 'idle'], delayed: ['Delayed', 'warn'],
  bounced: ['Bounced', 'bad'], complained: ['Marked as spam', 'bad'], failed: ['Didn’t go', 'bad'], suppressed: ['Not sent', 'bad'],
  canceled: ['Taken back', 'idle'], cancelled: ['Cancelled', 'idle'], posted: ['Posted to JobTread', 'idle'], noted: ['Noted in JobTread', 'idle'],
  handed: ['Sent by Kit', 'ok'], sending: ['Sending', 'idle'], draft: ['Draft in Kit', 'idle'],
};
export const PROBLEM = new Set(['bounced', 'complained', 'failed', 'suppressed']);
const toneOf = (r) => (STATUS[r.status] || ['', 'idle'])[1];

/** The status in words, for a row */
export function statusLine(r, tracking, now = Date.now()) {
  const s = r.status;
  if (r.channel === 'email' && r.emailId) {
    if (s === 'delivered') return r.clicked ? `Delivered, opened and clicked` : r.opened ? `Delivered, opened ${dayLabel(r.opened, now) === dayLabel(r.at, now) ? time(r.opened) : when(r.opened, now)}` : `Delivered${r.statusAt && Date.parse(r.statusAt) - Date.parse(r.at) > 5 * MIN ? ` ${time(r.statusAt)}` : ''}`;
    if (s === 'sent') {
      if (tracking?.state === 'send-only') return 'Sent (Resend can’t report back)';
      if (tracking?.state === 'on' && now - Date.parse(r.at) > 30 * MIN) return 'Sent, no word back from Resend';
      return 'Sent';
    }
    if (s === 'delayed') return 'Delayed: their mail server is slow; Resend keeps trying';
    if (PROBLEM.has(s)) return `${STATUS[s][0]}${r.detail ? `: ${r.detail}` : ''}`;
    if (s === 'scheduled') return 'Scheduled with Resend';
    if (s === 'canceled') return 'Taken back before it went';
  }
  if (r.channel === 'jobtread') return s === 'failed' ? `Didn’t post${r.detail ? `: ${r.detail}` : ''}` : s === 'noted' ? 'Noted in JobTread (staff only)' : 'Posted to JobTread, which emails it';
  if (r.channel === 'invite') return r.note || (s === 'cancelled' ? 'Cancelled; Google tells the guests' : 'Google sent it');
  if (r.channel === 'kit') {
    if (s === 'draft') return `Draft in Kit${r.by ? `, from ${r.by}` : ''}`;
    if (r.kit?.recipients) return `Kit sent it to ${plural(r.kit.recipients, 'person', 'people')}${r.kit.openRate != null ? `, ${r.kit.openRate}% opened` : ''}`;
    return s === 'sending' ? 'Kit is sending it' : s === 'failed' ? 'Kit didn’t take it' : 'Handed to Kit';
  }
  if (r.channel === 'push') return `${plural(r.count || 0, 'browser alert')}${r.failedCount ? `, ${r.failedCount} didn’t go` : ''}`;
  if (r.channel === 'text') return s === 'delivered' ? 'Every phone got it' : s === 'failed' ? (r.detail || 'Didn’t arrive') : 'Sent';
  if (r.channel === 'email') return `${STATUS[s]?.[0] || 'Sent'}${r.count ? ` to ${plural(r.count, 'person', 'people')}` : ''}${r.detail ? `. ${r.detail}` : ''}`;
  return STATUS[s]?.[0] || s;
}

// ─── Styles ───────────────────────────────
const CSS = `
.ms { --ms-ok: var(--color-success); --ms-warn: #B7791F; --ms-idle: #8C8D93; }
.ms-lede { display: flex; flex-wrap: wrap; gap: 0.35rem 1.1rem; margin: 0.15rem 0 0.4rem; padding: 0; list-style: none; font-size: 0.88rem; color: var(--color-text-secondary); }
.ms-lede b { color: var(--color-text); font-variant-numeric: tabular-nums; font-weight: 700; }
.ms-lede .is-warn b { color: var(--ms-warn); }
.ms-lede button { all: unset; cursor: pointer; border-radius: 4px; }
.ms-lede button:hover span { text-decoration: underline; }
.ms-lede button:focus-visible { box-shadow: var(--focus-ring); }
.ms-check { display: flex; flex-wrap: wrap; align-items: center; gap: 0.35rem 0.6rem; margin: 0 0 1rem; font-size: 0.8rem; color: var(--color-text-muted); }
.ms-check i { width: 7px; height: 7px; border-radius: 50%; background: var(--ms-ok); flex: none; }
.ms-check.is-warn i { background: var(--ms-warn); }
.ms-check.is-idle i { background: var(--ms-idle); }
.ms-work { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 1rem; align-items: start; }
.ms-rail { display: grid; gap: 1rem; position: sticky; top: 1rem; }
.ms-rail > .card { margin: 0; }
.ms-card { padding: 1rem 1.15rem; }
.ms-card h3 { margin: 0 0 0.2rem; font-size: 1rem; letter-spacing: -0.01em; }
.ms-card > p { margin: 0 0 0.6rem; font-size: 0.84rem; color: var(--color-text-secondary); line-height: 1.45; }
.ms-main > .ms-card + .ms-card { margin-top: 1rem; }
.ms-main > .ms-card:first-child { margin-top: 0; }
.ms-look { border-color: color-mix(in srgb, var(--ms-warn) 45%, var(--color-border)); background: color-mix(in srgb, var(--ms-warn) 6%, var(--color-bg-card)); }
.ms-look ul, .ms-next ul { list-style: none; margin: 0; padding: 0; display: grid; }
.ms-look li { padding: 0.6rem 0; border-top: 1px dashed var(--color-border); }
.ms-look li:first-child { border-top: 0; padding-top: 0.2rem; }
.ms-look li b { font-weight: 650; }
.ms-look li p { margin: 0.2rem 0 0; font-size: 0.85rem; line-height: 1.45; color: var(--color-text-secondary); }
.ms-look li .ms-fix { color: var(--color-text); }
.ms-look .ms-links { display: flex; flex-wrap: wrap; gap: 0.35rem 0.9rem; margin-top: 0.3rem; font-size: 0.84rem; }
.ms-link { all: unset; cursor: pointer; color: var(--color-link, #2B6CB0); font-weight: 600; text-decoration: underline; text-underline-offset: 2px; }
.ms-link:focus-visible { box-shadow: var(--focus-ring); border-radius: 3px; }
.ms-next li { display: grid; grid-template-columns: 7.5rem minmax(0, 1fr); gap: 0.15rem 0.75rem; padding: 0.5rem 0; border-top: 1px dashed var(--color-border); font-size: 0.88rem; }
.ms-next li:first-child { border-top: 0; padding-top: 0.2rem; }
.ms-next time { color: var(--color-text-secondary); font-variant-numeric: tabular-nums; font-size: 0.84rem; }
.ms-next small { display: block; color: var(--color-text-muted); font-size: 0.8rem; line-height: 1.4; margin-top: 0.1rem; }
.ms-next .is-off { color: var(--color-text-muted); }
.ms-next .is-off b { font-weight: 600; text-decoration: line-through; text-decoration-color: var(--color-border-strong); }
.ms-tools { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; margin: 1.25rem 0 0.6rem; }
.ms-chips { display: flex; flex-wrap: wrap; gap: 0.35rem; }
.ms-chips button[aria-pressed="true"] { background: var(--color-text); color: var(--color-bg-card); }
.ms-chips .chip em { font-style: normal; font-variant-numeric: tabular-nums; opacity: 0.7; margin-left: 0.3rem; }
.ms-search { flex: 1 1 220px; max-width: 320px; margin-left: auto; }
.ms-search input { width: 100%; }
.ms-only { display: inline-flex; align-items: center; gap: 0.35rem; margin: 0 0 0.6rem; padding: 0.25rem 0.35rem 0.25rem 0.65rem; border-radius: 999px; background: var(--color-bg-secondary); border: 1px solid var(--color-border); font-size: 0.82rem; font-weight: 600; }
.ms-only button { all: unset; cursor: pointer; width: 22px; height: 22px; display: grid; place-items: center; border-radius: 50%; color: var(--color-text-muted); }
.ms-only button:hover { background: var(--color-bg-hover); color: var(--color-text); }
.ms-only button:focus-visible { box-shadow: var(--focus-ring); }
.ms-log { padding: 0; overflow: hidden; }
.ms-day { margin: 0; padding: 0.55rem 1rem; font-size: 0.74rem; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--color-text-muted); background: var(--color-bg-secondary); border-top: 1px solid var(--color-border); position: sticky; top: 0; z-index: 1; }
.ms-day:first-child { border-top: 0; }
.ms-rows { list-style: none; margin: 0; padding: 0; }
.ms-rows li + li { border-top: 1px solid var(--color-border); }
.ms-row { all: unset; box-sizing: border-box; cursor: pointer; display: grid; grid-template-columns: 10px 4.4rem minmax(0, 1fr) minmax(0, 15rem); gap: 0.2rem 0.75rem; align-items: baseline; width: 100%; padding: 0.65rem 1rem; }
.ms-row:hover { background: var(--color-bg-hover); }
.ms-row:focus-visible { box-shadow: inset var(--focus-ring); }
.ms-dot { width: 9px; height: 9px; border-radius: 50%; align-self: center; background: var(--ms-idle); }
.ms-dot.t-ok { background: var(--ms-ok); }
.ms-dot.t-idle { background: color-mix(in srgb, var(--ms-idle) 45%, var(--color-bg-card)); border: 1.5px solid var(--ms-idle); width: 6px; height: 6px; }
.ms-dot.t-warn, .ms-dot.t-bad { background: var(--ms-warn); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ms-warn) 22%, transparent); }
.ms-time { font-size: 0.82rem; color: var(--color-text-secondary); font-variant-numeric: tabular-nums; white-space: nowrap; }
.ms-what { min-width: 0; }
.ms-what b { font-weight: 650; font-size: 0.9rem; }
.ms-what .mm-sender { margin-left: 0.4rem; padding: 0 0.45rem; font-size: 0.7rem; vertical-align: 1px; }
.ms-who { display: block; font-size: 0.84rem; color: var(--color-text-secondary); overflow-wrap: anywhere; }
.ms-why { display: block; margin-top: 0.1rem; font-size: 0.82rem; color: #8A5A12; }
.ms-state { font-size: 0.84rem; color: var(--color-text-secondary); text-align: right; overflow-wrap: anywhere; }
.ms-state.t-ok { color: var(--ms-ok); }
.ms-state.t-warn, .ms-state.t-bad { color: #8A5A12; font-weight: 600; }
.ms-empty { margin: 0; padding: 1.5rem 1rem; text-align: center; color: var(--color-text-secondary); font-size: 0.9rem; }
.ms-more { display: flex; justify-content: center; padding: 0.8rem; border-top: 1px solid var(--color-border); }
.ms-health h4 { margin: 0.9rem 0 0.1rem; font-size: 0.84rem; font-weight: 700; }
.ms-health h4 small { display: block; font-weight: 500; color: var(--color-text-muted); font-size: 0.78rem; margin-top: 0.05rem; }
.ms-health ul { list-style: none; margin: 0.35rem 0 0; padding: 0; display: grid; gap: 0.35rem; }
.ms-health li { display: grid; grid-template-columns: 18px minmax(0, 1fr); gap: 0.45rem; font-size: 0.84rem; line-height: 1.4; }
.ms-health li span { color: var(--color-text-secondary); }
.ms-health li b { font-weight: 650; color: var(--color-text); }
.ms-ok-i, .ms-no-i, .ms-q-i { width: 16px; height: 16px; border-radius: 50%; display: grid; place-items: center; font-size: 0.72rem; font-weight: 800; margin-top: 0.1rem; }
.ms-ok-i { background: color-mix(in srgb, var(--ms-ok) 16%, var(--color-bg-card)); color: var(--ms-ok); }
.ms-no-i { background: color-mix(in srgb, var(--ms-warn) 20%, var(--color-bg-card)); color: #8A5A12; }
.ms-q-i { background: var(--color-bg-secondary); color: var(--color-text-muted); }
.ms-rates { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 0.5rem; margin: 0.3rem 0 0.2rem; }
.ms-rates div { padding: 0.55rem 0.6rem; border-radius: 8px; background: var(--color-bg); }
.ms-rates b { display: block; font-size: 1.1rem; font-variant-numeric: tabular-nums; }
.ms-rates span { font-size: 0.74rem; color: var(--color-text-muted); }
.ms-rates .is-warn b { color: #8A5A12; }
.ms-note { margin: 0.5rem 0 0; font-size: 0.78rem; color: var(--color-text-muted); line-height: 1.45; }
.ms-inv ul { list-style: none; margin: 0; padding: 0; display: grid; }
.ms-inv li { display: grid; gap: 0.1rem; padding: 0.55rem 0; border-top: 1px dashed var(--color-border); font-size: 0.88rem; }
.ms-inv li:first-child { border-top: 0; padding-top: 0.15rem; }
.ms-inv b { font-weight: 650; }
.ms-inv-when { font-size: 0.8rem; color: var(--color-text-secondary); }
.ms-rsvp { display: flex; flex-wrap: wrap; gap: 0.3rem; margin-top: 0.25rem; }
.ms-rsvp em { font-style: normal; font-size: 0.78rem; font-weight: 600; padding: 0.1rem 0.5rem; border-radius: 999px; background: var(--color-bg-secondary); color: var(--color-text-secondary); font-variant-numeric: tabular-nums; }
.ms-rsvp em.is-yes { background: color-mix(in srgb, var(--ms-ok) 13%, var(--color-bg-card)); color: var(--ms-ok); }
.ms-rsvp em.is-wait { background: transparent; border: 1px dashed var(--color-border-strong); }
.ms-steps { margin: 0.4rem 0 0; padding-left: 1.15rem; font-size: 0.85rem; line-height: 1.5; color: var(--color-text-secondary); }
.ms-tl { list-style: none; margin: 0; padding: 0.75rem 1.25rem; display: grid; gap: 0.35rem; border-bottom: 1px solid var(--color-border); font-size: 0.86rem; }
.ms-tl li { display: grid; grid-template-columns: 10px 9.5rem minmax(0, 1fr); gap: 0.6rem; align-items: baseline; }
.ms-tl time { color: var(--color-text-secondary); font-variant-numeric: tabular-nums; }
.ms-tl small { display: block; color: var(--color-text-secondary); }
/* Fingers: every link and count is a 44px target */
@media (pointer: coarse) {
  .ms-lede button, .ms-link, .ms-links a { display: inline-flex; align-items: center; min-height: 44px; }
  .ms-only button { width: 44px; height: 44px; }
}
@media (max-width: 1100px) {
  .ms-work { grid-template-columns: minmax(0, 1fr); }
  .ms-rail { position: static; }
}
@media (max-width: 640px) {
  .ms-row { grid-template-columns: 10px minmax(0, 1fr) auto; }
  .ms-row .ms-state { grid-column: 2 / -1; text-align: left; }
  .ms-row .ms-time { grid-column: 3; grid-row: 1; }
  .ms-row .ms-what { grid-column: 2; grid-row: 1; }
  .ms-search { max-width: none; flex-basis: 100%; margin-left: 0; }
  .ms-next li { grid-template-columns: minmax(0, 1fr); }
  .ms-tl li { grid-template-columns: 10px minmax(0, 1fr); }
  .ms-tl li time { grid-column: 2; }
  .ms-tl li div { grid-column: 2; }
}
`;
let cssDone = false;
function ensureCss() {
  if (cssDone) return;
  const s = document.createElement('style');
  s.textContent = CSS;
  document.head.appendChild(s);
  cssDone = true;
}

// ─── The tracking, in words ───────────────
function trackingLine(t, now) {
  if (!t || t.state === 'off') return { tone: 'idle', text: 'RESEND_API_KEY isn’t in Cloudflare, so the site sends no email of its own.' };
  if (t.state === 'send-only') return { tone: 'warn', text: 'Resend can’t report back: the site’s Resend key can only send. Sending works; only the delivery reports are missing.' };
  if (t.state === 'error') return { tone: 'warn', text: `Resend’s reports aren’t coming in (${t.error || 'no answer'}). The site tries again every 30 minutes.` };
  if (t.state === 'waiting') return { tone: 'idle', text: 'Resend’s delivery reports start within half an hour: the site sets them up itself.' };
  const last = t.lastReportAt ? ` Last report ${agoText(t.lastReportAt, now)}.` : '';
  return { tone: 'ok', text: `Resend reports back on every email the site sends, so each one shows whether it arrived.${last}` };
}
function agoText(iso, now) {
  const d = Math.max(0, now - Date.parse(iso));
  if (d < MIN) return 'just now';
  if (d < 60 * MIN) return `${Math.round(d / MIN)} min ago`;
  if (d < 48 * 60 * MIN) return `${Math.round(d / (60 * MIN))} h ago`;
  return `${Math.round(d / DAY)} days ago`;
}

const Mark = ({ ok }) => (ok === true ? html`<span class="ms-ok-i" aria-label="Passes">✓</span>`
  : ok === false ? html`<span class="ms-no-i" aria-label="Needs a look">!</span>`
    : html`<span class="ms-q-i" aria-label="Couldn’t check">?</span>`);

// ─── One message, exactly as it went ──────
function RowSheet({ row, label, entry, onClose, onPreview, Sender, senderOf, EmailFrame, now, returnTo = null }) {
  const [d, setD] = useState(null);
  const [err, setErr] = useState(null);
  const closeRef = useRef(null);
  // Focus goes back to the row that opened it (Safari doesn't focus a clicked button, so it's passed in)
  const back = useRef(returnTo || document.activeElement);
  useEffect(() => {
    if (!row.emailId) return undefined;
    let live = true;
    fetch(`${API}?email=${encodeURIComponent(row.emailId)}`, { headers: { Accept: 'application/json' } })
      .then((r) => r.json().catch(() => null).then((b) => ({ ok: r.ok, b })))
      .then(({ ok, b }) => { if (!live) return; if (!ok || !b?.success) throw new Error(b?.error || 'It didn’t load'); setD(b); })
      .catch((e) => live && setErr(e.message));
    return () => { live = false; };
  }, [row.key]);
  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); onClose(); } };
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('keydown', onKey); back.current?.focus?.(); };
  }, []);
  const events = d?.events || [{ type: 'sent', at: row.at }, ...(row.statusAt && row.status !== 'sent' ? [{ type: row.status, at: row.statusAt, detail: row.detail }] : [])];
  const EV = { sent: 'Sent', scheduled: 'Scheduled', delivered: 'Delivered', delivery_delayed: 'Delayed', delayed: 'Delayed', bounced: 'Bounced', complained: 'Marked as spam', failed: 'Didn’t go', suppressed: 'Not sent', opened: 'Opened', clicked: 'Clicked a link', canceled: 'Taken back' };
  const evTone = (t) => (['bounced', 'complained', 'failed', 'suppressed', 'delivery_delayed', 'delayed'].includes(t) ? 'bad' : ['delivered', 'opened', 'clicked'].includes(t) ? 'ok' : 'idle');
  const doc = d?.html ? d.html.replace(/<head>/i, '<head><base target="_blank">') : '';
  return html`<div class="mm-sheet-wrap" onClick=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div class="mm-sheet" role="dialog" aria-modal="true" aria-labelledby="ms-sheet-title">
      <div class="mm-sheet-head">
        <div>
          <h3 id="ms-sheet-title">${label}</h3>
          <p>${row.who || row.to || ''}${row.who && row.to && row.who !== row.to ? ` · ${row.to}` : ''}</p>
        </div>
        <button type="button" class="am-close" ref=${closeRef} aria-label="Close" onClick=${onClose}>×</button>
      </div>
      <dl class="mm-env">
        <dt>Sent by</dt><dd><${Sender} s=${senderOf(row)} /></dd>
        ${(row.to || d?.to) && html`<dt>To</dt><dd>${d?.to || row.to}</dd>`}
        ${(d?.subject || row.subject) && html`<dt>Subject</dt><dd class="mm-env-subject">${d?.subject || row.subject}</dd>`}
        <dt>When</dt><dd>${when(row.at, now)}</dd>
        <dt>Now</dt><dd class=${`ms-state t-${toneOf(row)}`} style="text-align: left;">${statusLine(d ? { ...row, status: d.status, statusAt: d.statusAt, detail: d.detail, opened: d.opened, clicked: d.clicked } : row, { state: 'on' }, now)}</dd>
        ${row.fix && html`<dt>What to do</dt><dd>${row.fix}</dd>`}
      </dl>
      ${row.emailId && html`<ol class="ms-tl" aria-label="What Resend reported">
        ${events.map((e, i) => html`<li key=${i}><span class=${`ms-dot t-${evTone(e.type)}`}></span><time datetime=${e.at}>${when(e.at, now)}</time><div>${EV[e.type] || e.type}${e.detail && html`<small>${e.detail}</small>`}</div></li>`)}
      </ol>`}
      <div class="mm-body" tabindex="0" role="region" aria-label="The message">
        ${row.emailId && !d && !err && html`<div class="mm-wait">Loading the email…</div>`}
        ${err && html`<div class="mm-wait" role="alert">${err}</div>`}
        ${doc && html`<${EmailFrame} doc=${doc} phone=${false} title=${`The email: ${d.subject || label}`} />`}
        ${d && !doc && d.text && html`<div class="mm-jt"><div class="mm-jt-body">${d.text}</div></div>`}
        ${(d && !doc && !d.text) || !row.emailId ? html`<div class="mm-wait" style="min-height: 140px; text-align: center; padding: 1rem;">
          ${d?.why || (row.channel === 'jobtread' ? 'JobTread keeps this one: it’s on the family’s page there.' : row.channel === 'invite' ? 'Google keeps the invite: it’s on the organizer’s calendar.' : row.channel === 'kit' ? 'Kit keeps this one, with its opens and clicks.' : 'The words aren’t kept here.')}
          ${entry?.preview && html`<br />Its wording, filled in for a sample family, is one click away.`}
        </div>` : null}
      </div>
      <div class="mm-foot">
        <p>${row.link ? 'The family’s page in Applicants has every email and reply.' : entry?.preview ? 'The sample uses the same code that sent this one.' : ''}</p>
        <div style="display: flex; flex-wrap: wrap; gap: 0.45rem;">
          ${row.link && html`<a class="btn btn-secondary btn-sm" href=${row.link} onClick=${() => onClose()}>Open in Applicants</a>`}
          ${entry?.preview && html`<button type="button" class="btn btn-secondary btn-sm" onClick=${() => { onClose(); onPreview(entry); }}>See the sample</button>`}
        </div>
      </div>
    </div>
  </div>`;
}

// ─── The view ─────────────────────────────

/**
 * props: entryOf(key) → the map entry (or null), branchOf(entry) → its
 * branch's title, labelOf(row), senderOf(row), Sender, EmailFrame,
 * onPreview(entry), only / setOnly (an entry key the log is narrowed to),
 * show / setShow (the chip picked: 'all', a branch, 'problems' or 'tests'),
 * onProblems(n) (how many didn't arrive in 30 days, for the tab's badge).
 */
export function SentView({ entryOf, branchOf, labelOf, senderOf, Sender, EmailFrame, onPreview, only = null, setOnly, show: showProp, setShow: setShowProp, onProblems = () => {} }) {
  ensureCss();
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [older, setOlder] = useState({ items: [], more: null, busy: false });
  const [found, setFound] = useState(null); // a search of older messages
  const [showLocal, setShowLocal] = useState('all');
  const show = showProp ?? showLocal;
  const setShow = setShowProp ?? setShowLocal;
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(null);
  const [now, setNow] = useState(Date.now());

  const load = async () => {
    try {
      const r = await fetch(`${API}?activity=1`, { headers: { Accept: 'application/json' } });
      const b = await r.json().catch(() => null);
      if (!r.ok || !b?.success) throw new Error(b?.error || (r.ok ? 'the server didn’t send data; try reloading the admin' : `HTTP ${r.status}`));
      setData(b); setErr(null); setNow(Date.now());
      setOlder({ items: [], more: b.more, busy: false });
    } catch (e) { setErr(e.message); }
  };
  useEffect(() => {
    load();
    const onVis = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  const all = useMemo(() => [...(data?.items || []), ...older.items], [data, older.items]);
  const isTest = (r) => r.entry === 'preview' || r.test;
  const problems = all.filter((r) => PROBLEM.has(r.status) && !isTest(r) && now - Date.parse(r.at) < 30 * DAY);
  useEffect(() => { onProblems(problems.length); }, [problems.length]);

  // Search older messages on the server when what's loaded doesn't reach back far enough
  const needle = lower(q.trim());
  const qTimer = useRef(null);
  useEffect(() => {
    clearTimeout(qTimer.current);
    if (!needle || needle.length < 3 || !(data?.more || older.more)) { setFound(null); return undefined; }
    qTimer.current = setTimeout(async () => {
      try {
        const r = await fetch(`${API}?activity=1&q=${encodeURIComponent(needle)}&before=${encodeURIComponent(all[all.length - 1]?.at || new Date().toISOString())}`);
        const b = await r.json();
        if (b?.success) setFound(b.items || []);
      } catch { /* the loaded matches still show */ }
    }, 400);
    return () => clearTimeout(qTimer.current);
  }, [needle, data]);

  const loadOlder = async () => {
    setOlder((o) => ({ ...o, busy: true }));
    try {
      const r = await fetch(`${API}?activity=1&before=${encodeURIComponent(all[all.length - 1].at)}`);
      const b = await r.json();
      if (!b?.success) throw new Error(b?.error);
      setOlder((o) => ({ items: [...o.items, ...(b.items || [])], more: b.more, busy: false }));
    } catch { setOlder((o) => ({ ...o, busy: false })); }
  };

  const branches = [...new Set(all.filter((r) => !isTest(r)).map((r) => branchOf(entryOf(r.entry))).filter(Boolean))];
  const matchesShow = (r) => (show === 'tests' ? isTest(r) : isTest(r) ? false : show === 'all' ? true : show === 'problems' ? PROBLEM.has(r.status) : branchOf(entryOf(r.entry)) === show);
  const words = (r) => [r.to, r.who, r.subject, labelOf(r), r.detail].map(lower).join(' ');
  const seen = new Set();
  const rows = [...all, ...(found || [])].filter((r) => {
    if (seen.has(r.key)) return false;
    seen.add(r.key);
    if (only && r.entry !== only) return false;
    if (!matchesShow(r)) return false;
    return !needle || words(r).includes(needle);
  });
  const days = [];
  for (const r of rows) {
    const k = dayKey(r.at);
    const g = days[days.length - 1];
    if (g?.k === k) g.rows.push(r); else days.push({ k, label: dayLabel(r.at, now), rows: [r] });
  }

  const tracking = data?.tracking;
  const t = trackingLine(tracking, now);
  const health = data?.health;
  const rates = health?.rates;
  const coming = data?.coming || [];
  const counts = (pred) => all.filter((r) => !isTest(r) && pred(r)).length;
  const onlyEntry = only ? entryOf(only) : null;

  const Row = (r) => {
    const e = entryOf(r.entry);
    const bad = PROBLEM.has(r.status) || r.status === 'delayed';
    return html`<li key=${r.key}><button type="button" class="ms-row" onClick=${(ev) => setOpen({ row: r, from: ev.currentTarget })} aria-label=${`${labelOf(r)}, ${r.who || r.to || ''}, ${statusLine(r, tracking, now)}`}>
      <span class=${`ms-dot t-${toneOf(r)}`} aria-hidden="true"></span>
      <span class="ms-time">${time(r.at)}</span>
      <span class="ms-what"><b>${labelOf(r)}</b><${Sender} s=${senderOf(r)} /><span class="ms-who">${r.who && r.to && r.who !== r.to ? `${r.who} · ${r.to}` : r.who || r.to || (e?.who || '')}</span>
        ${bad && r.detail && html`<span class="ms-why">${r.detail}</span>`}</span>
      <span class=${`ms-state t-${toneOf(r)}`}>${bad && r.channel === 'email' ? STATUS[r.status][0] : statusLine(r, tracking, now)}</span>
    </button></li>`;
  };

  return html`<div class="ms">
    <div class="page-header" style="margin-bottom: 0.4rem;">
      <div>
        <h2>What went out</h2>
        <p class="page-sub">Every message, newest first, and whether it arrived. What goes out next is at the top. Pick one to see it exactly as it went.</p>
      </div>
    </div>
    ${rates && html`<ul class="ms-lede">
      <li><button type="button" onClick=${() => { setShow('all'); setOnly(null); }}><b>${rates.sent}</b> <span>emails from the site in 30 days</span></button></li>
      ${rates.deliveredPct != null && html`<li><b>${rates.deliveredPct}%</b> <span>delivered</span></li>`}
      <li class=${problems.length ? 'is-warn' : ''}><button type="button" onClick=${() => { setShow('problems'); setOnly(null); }}><b>${problems.length}</b> <span>didn’t arrive</span></button></li>
      <li><b>${coming.length}</b> <span>coming up</span></li>
    </ul>`}
    <p class=${`ms-check is-${t.tone}`} aria-live="polite"><i aria-hidden="true"></i><span>${err ? `Couldn’t load what went out (${err}).` : !data ? 'Loading…' : t.text}</span>
      ${err && html`<button type="button" class="ms-link" onClick=${load}>Try again</button>`}</p>

    <div class="ms-work">
      <div class="ms-main">
        ${problems.length > 0 && html`<section class="card ms-card ms-look" aria-labelledby="ms-look-h">
          <h3 id="ms-look-h">Didn’t arrive</h3>
          <p>In the last 30 days. Staff hear about a family’s or a staff address in Slack and by email when it happens; a reveal-reminder address that bounces is unsubscribed by itself.</p>
          <ul>${problems.slice(0, 8).map((r) => html`<li key=${r.key}>
            <b>${labelOf(r)}</b> to ${r.who && r.who !== r.to ? `${r.who} (${r.to})` : r.to || r.who}
            <p>${when(r.at, now)}. ${statusLine(r, tracking, now)}</p>
            ${r.fix && html`<p class="ms-fix"><b>What to do:</b> ${r.fix}</p>`}
            <div class="ms-links">
              <button type="button" class="ms-link" onClick=${(ev) => setOpen({ row: r, from: ev.currentTarget })}>See what happened</button>
              ${r.link && html`<a class="ms-link" href=${r.link}>Open the family</a>`}
            </div>
          </li>`)}</ul>
          ${problems.length > 8 && html`<button type="button" class="ms-link" onClick=${() => setShow('problems')}>All ${problems.length}</button>`}
        </section>`}

        <section class="card ms-card ms-next" aria-labelledby="ms-next-h">
          <h3 id="ms-next-h">Coming up</h3>
          ${!data ? html`<p>Loading…</p>`
            : coming.length ? html`<p>The next two weeks, soonest first.</p><ul>${coming.map((c) => html`<li key=${c.key} class=${c.off || c.held ? 'is-off' : ''}>
              <time datetime=${c.at}>${when(c.at, now)}</time>
              <div><b>${labelOf(c)}</b> to ${c.who}${c.note && html`<small>${c.note}</small>`}
                ${(entryOf(c.entry)?.preview || c.link) && html`<small>${entryOf(c.entry)?.preview && html`<button type="button" class="ms-link" onClick=${() => onPreview(entryOf(c.entry))}>See what it says</button>`}${entryOf(c.entry)?.preview && c.link ? ' · ' : ''}${c.link && html`<a class="ms-link" href=${c.link}>Open the family</a>`}</small>`}
              </div>
            </li>`)}</ul>`
            : html`<p style="margin: 0;">Nothing is scheduled in the next two weeks. Messages that go out when something happens (an application, a status change, a reveal going live) aren’t listed until then.</p>`}
        </section>

        <div class="ms-tools">
          <div class="ms-chips" role="group" aria-label="Show">
            ${[['all', 'Everything', counts(() => true)], ...branches.map((b) => [b, b, counts((r) => branchOf(entryOf(r.entry)) === b)]), ['problems', 'Didn’t arrive', problems.length], ['tests', 'Previews and tests', all.filter(isTest).length]]
              .filter(([k, , n]) => k === 'all' || n > 0)
              .map(([k, label, n]) => html`<button key=${k} type="button" class="chip" aria-pressed=${String(show === k)} onClick=${() => setShow(show === k && k !== 'all' ? 'all' : k)}>${label}<em>${n}</em></button>`)}
          </div>
          <div class="ms-search"><input class="form-input" type="search" aria-label="Find a person or an email" placeholder="Find a person, address or subject…" value=${q} onInput=${(e) => setQ(e.target.value)} /></div>
        </div>
        ${onlyEntry && html`<p class="ms-only">Only “${onlyEntry.t}”<button type="button" aria-label="Show everything" onClick=${() => setOnly(null)}>×</button></p>`}

        <div class="card ms-log" aria-busy=${!data && !err ? 'true' : 'false'}>
          ${!data && !err && html`<p class="ms-empty">Loading…</p>`}
          ${data && !rows.length && html`<p class="ms-empty">${needle ? `Nothing matches “${q.trim()}”${found === null && (data.more || older.more) ? '. Searching older messages…' : '.'}` : show === 'problems' ? 'Everything arrived.' : 'Nothing has gone out yet.'}</p>`}
          ${days.map((g) => html`<div key=${g.k}>
            <h4 class="ms-day">${g.label}</h4>
            <ul class="ms-rows">${g.rows.map(Row)}</ul>
          </div>`)}
          ${(older.more ?? data?.more) && !needle && html`<div class="ms-more"><button type="button" class="btn btn-ghost btn-sm" disabled=${older.busy} onClick=${loadOlder}>${older.busy ? 'Loading…' : 'Show older'}</button></div>`}
        </div>
        ${data?.trackedSince && html`<p class="ms-note">Each email the site sends is listed by itself from ${new Date(data.trackedSince).toLocaleDateString('en-US', { timeZone: TZ, month: 'long', day: 'numeric' })}, when delivery tracking began. JobTread, Google Calendar and Kit rows come from the site’s own records. Rows are kept 180 days.</p>`}
      </div>

      <aside class="ms-rail">
        ${tracking?.state === 'send-only' && html`<section class="card ms-card" aria-labelledby="ms-key-h">
          <h3 id="ms-key-h">To see whether emails arrive</h3>
          <p>The site’s Resend key was made with “Sending access”, which can send but not read Resend’s reports. One change turns the reports on; the site does the rest.</p>
          <ol class="ms-steps">
            <li>In Resend, API Keys → Create API key, with <b>Full access</b>, for comms.sunshineonaranneyday.com.</li>
            <li>In Cloudflare, replace RESEND_API_KEY on the soard-site Pages project with it.</li>
          </ol>
          <p class="ms-note">Within half an hour the site registers its own webhook with Resend, and every email from then on shows whether it arrived.</p>
        </section>`}
        ${data?.invites?.length > 0 && html`<section class="card ms-card ms-inv" aria-labelledby="ms-inv-h">
          <h3 id="ms-inv-h">Invites out now</h3>
          <p>Each reveal’s calendar invite, and how guests answered in Google Calendar.</p>
          <ul>${data.invites.map((v) => html`<li key=${v.jobId}>
            <b>${v.kid ? `${v.kid}’s Reveal Day` : 'A reveal'}</b>
            <span class="ms-inv-when">${new Date(`${v.date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' })} · ${v.state === 'confirmed' ? 'Confirmed' : 'Save-the-date'}</span>
            ${v.answers && (v.state === 'confirmed' || v.answers.yes + v.answers.no + v.answers.maybe > 0)
              ? html`<span class="ms-rsvp"><em class="is-yes">${v.answers.yes} coming</em><em>${v.answers.no} can’t</em>${v.answers.maybe > 0 && html`<em>${v.answers.maybe} maybe</em>`}<em class="is-wait">${v.answers.waiting} haven’t answered</em></span>
                ${v.state !== 'confirmed' && html`<span class="ms-inv-when">Guests answered the save-the-date on their own; replies are asked for once it’s confirmed.</span>`}`
              : html`<span class="ms-inv-when">${v.guests != null ? `${plural(v.guests, 'guest')}. ` : ''}${v.state === 'confirmed' ? 'Answers show once Google Calendar can be read.' : 'No reply needed until it’s confirmed.'}</span>`}
          </li>`)}</ul>
        </section>`}
        <section class="card ms-card ms-health" aria-labelledby="ms-health-h">
          <h3 id="ms-health-h">Will it land?</h3>
          <p>Whether inboxes trust mail from SOARD, checked in public DNS when this page opens.</p>
          ${rates && html`<div class="ms-rates">
            <div><b>${rates.deliveredPct ?? '–'}${rates.deliveredPct != null ? '%' : ''}</b><span>delivered</span></div>
            <div class=${rates.bounceOk ? '' : 'is-warn'}><b>${rates.bouncePct ?? '–'}${rates.bouncePct != null ? '%' : ''}</b><span>bounced</span></div>
            <div class=${rates.spamOk ? '' : 'is-warn'}><b>${rates.spamPct ?? '–'}${rates.spamPct != null ? '%' : ''}</b><span>marked spam</span></div>
          </div>
          <p class="ms-note">Emails from the site in the last 30 days. Resend asks for under 4% bounced and under 0.08% marked as spam.</p>`}
          ${(health?.domains || []).map((dm) => html`<div key=${dm.name}>
            <h4>${dm.name}<small>${dm.for}</small></h4>
            <ul>${dm.checks.map((c) => html`<li key=${c.label}><${Mark} ok=${c.ok} /><span><b>${c.label}.</b> ${c.note}</span></li>`)}</ul>
          </div>`)}
          ${!health && data && html`<p class="ms-note">Couldn’t check DNS just now.</p>`}
        </section>
      </aside>
    </div>
    ${open && html`<${RowSheet} row=${open.row} label=${labelOf(open.row)} entry=${entryOf(open.row.entry)} onClose=${() => setOpen(null)} returnTo=${open.from}
      onPreview=${onPreview} Sender=${Sender} senderOf=${senderOf} EmailFrame=${EmailFrame} now=${now} />`}
  </div>`;
}
