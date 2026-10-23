/**
 * Demo Day (admin)
 * ================
 * Loaded on demand by the admin's Demo Day page (#demo-day), its own place
 * in the menu: demo day has nothing to do with reveals. Demo day calendar invites go out from
 * the organizer's Google Calendar when a job's "Set Start Date" task is
 * checked off in JobTread, for the date on its Demo task
 * (functions/api/_demo-invites.js). Dates and times change only in JobTread;
 * this tab is the switch, every demo day coming up with what its invite has
 * done, who gets invited (everyone comes from JobTread except the
 * every-demo-day list, kept here), and the wording.
 * Server: /api/demo-invites-admin.
 */

import { h, htm, useState, useEffect, useCallback } from './vendor.js';

const html = htm.bind(h);
const API = '/api/demo-invites-admin';
const SITE = 'https://sunshineonaranneyday.com';

const TOKENS = [
  { token: '{name}', hint: "kid's name" },
  { token: '{space}', hint: 'therapy room' },
  { token: '{date}', hint: 'Monday, October 26' },
  { token: '{time}', hint: '9:00 AM' },
  { token: '{when}', hint: 'date and time' },
];
const LENGTHS = [[30, '30 minutes'], [60, '1 hour'], [90, '1½ hours'], [120, '2 hours'], [180, '3 hours'], [240, '4 hours'], [480, 'All day (8 hours)']];
const KIND = { family: 'Family', staff: 'Internal team', sponsor: 'Sponsor', always: 'Every demo day', test: 'Test guests' };

const day = (date, style = 'long') => new Date(`${date}T12:00:00Z`).toLocaleDateString('en-US', style === 'long'
  ? { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' }
  : { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
const clock = (time) => {
  const [hh, mm] = time.split(':').map(Number);
  return `${hh % 12 || 12}:${String(mm).padStart(2, '0')} ${hh < 12 ? 'AM' : 'PM'}`;
};
const addMinutes = (time, minutes) => {
  const [hh, mm] = time.split(':').map(Number);
  const t = Math.min(hh * 60 + mm + minutes, 23 * 60 + 59);
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};
// Same placeholders as the server: {name} {space} {date} {time} {when}
const fill = (text, { name, space, date, time }) => {
  const d = day(date);
  const values = { name, space: String(space || '').trim().toLowerCase() || 'room', date: d, time: clock(time), when: `${d} at ${clock(time)}` };
  return String(text || '').replace(/\{(name|space|date|time|when)\}/g, (_, k) => values[k]);
};
const ago = (iso) => {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)} hr ago`;
  return new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
};
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const STYLES = `
  .dd { display: grid; gap: 1.25rem; }
  .dd h3 { margin: 0; font-size: 1.05rem; }
  .dd h4 { margin: 0; font-size: 0.95rem; }
  .dd-status { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 1rem 1.5rem; }
  .dd-status__main { display: flex; gap: 0.85rem; align-items: flex-start; min-width: 0; flex: 1 1 26rem; }
  .dd-dot { width: 10px; height: 10px; border-radius: 50%; margin-top: 0.45rem; flex-shrink: 0; background: var(--color-text-muted); }
  .dd-dot--on { background: var(--color-success); box-shadow: 0 0 0 4px rgba(47,125,79,0.14); }
  .dd-meta { margin: 0.2rem 0 0; color: var(--color-text-secondary); font-size: 0.85rem; line-height: 1.5; overflow-wrap: anywhere; }
  .dd-warn { color: var(--color-danger); }
  .dd-chip { display: inline-flex; align-items: center; padding: 0.15rem 0.55rem; border-radius: 999px; font-size: 0.72rem; font-weight: 700; letter-spacing: 0.02em; white-space: nowrap; }
  .dd-chip--on { background: rgba(47,125,79,0.1); color: var(--color-success); }
  .dd-chip--neutral { background: var(--color-bg-secondary); color: var(--color-text-secondary); box-shadow: inset 0 0 0 1px var(--color-border); }
  .dd-chip--ready { background: var(--color-primary-bg); color: var(--color-primary-ink); box-shadow: inset 0 0 0 1px rgba(214,158,46,0.35); }
  .dd-chip--warn { background: rgba(197,48,48,0.08); color: var(--color-danger); }
  .dd-chip--muted { background: var(--color-bg-secondary); color: var(--color-text-muted); }
  .dd-list { list-style: none; margin: 0.9rem 0 0; padding: 0; display: grid; gap: 0.75rem; }
  .dd-row { border: 1px solid var(--color-border); border-radius: var(--radius-md); padding: 0.9rem 1rem; background: var(--color-bg-card); }
  .dd-row__head { display: flex; flex-wrap: wrap; align-items: baseline; justify-content: space-between; gap: 0.25rem 1rem; }
  .dd-row__name { display: flex; flex-wrap: wrap; align-items: center; gap: 0.35rem 0.55rem; font-weight: 700; font-size: 1rem; }
  .dd-row__when { color: var(--color-text-secondary); font-size: 0.88rem; margin-top: 0.15rem; }
  .dd-row__head a, .dd-link { color: var(--color-text-secondary); font-size: 0.85rem; text-decoration: underline; text-underline-offset: 3px; }
  .dd-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem; margin-top: 0.75rem; }
  .dd-invite { border: 1px solid var(--color-border); border-radius: var(--radius-md); padding: 0.95rem 1rem; background: var(--color-bg-secondary); margin-top: 0.85rem; }
  .dd-invite__title { font-weight: 700; font-size: 1rem; margin-bottom: 0.45rem; overflow-wrap: anywhere; }
  .dd-facts { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 0.15rem 0.75rem; margin: 0 0 0.6rem; font-size: 0.86rem; }
  .dd-facts dt { color: var(--color-text-muted); }
  .dd-facts dd { margin: 0; overflow-wrap: anywhere; }
  .dd-desc { white-space: pre-line; font-size: 0.88rem; line-height: 1.55; margin: 0; overflow-wrap: anywhere; }
  .dd-guests { display: grid; gap: 0.5rem; margin-top: 0.85rem; font-size: 0.86rem; }
  .dd-guests__group { display: grid; grid-template-columns: 8.5rem minmax(0, 1fr); gap: 0.15rem 0.75rem; }
  .dd-guests__group dt { color: var(--color-text-muted); }
  .dd-guests__group dd { margin: 0; overflow-wrap: anywhere; }
  .dd-who { display: grid; gap: 1.1rem; margin-top: 0.9rem; }
  .dd-who__group { display: grid; gap: 0.35rem; }
  .dd-people { display: flex; flex-wrap: wrap; gap: 0.4rem; margin-top: 0.15rem; }
  .dd-person { display: inline-flex; align-items: center; gap: 0.4rem; max-width: 100%; border: 1px solid var(--color-border); border-radius: 999px; padding: 0.2rem 0.3rem 0.2rem 0.7rem; font-size: 0.84rem; background: var(--color-bg-card); }
  .dd-person span { overflow-wrap: anywhere; }
  .dd-person small { color: var(--color-text-muted); }
  .dd-person button { border: 0; background: transparent; color: var(--color-text-muted); cursor: pointer; border-radius: 999px; width: 1.6rem; height: 1.6rem; font-size: 1rem; line-height: 1; flex-shrink: 0; }
  .dd-person button:hover { background: var(--color-bg-hover); color: var(--color-text); }
  .dd-person button:focus-visible { outline: none; box-shadow: var(--focus-ring-strong); }
  .dd-add { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; margin-top: 0.4rem; }
  .dd-add .form-input { flex: 1 1 12rem; min-width: 0; width: auto; }
  .dd-add .form-input--short { flex: 0 1 10rem; }
  .dd-wording { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 1.5rem; margin-top: 1rem; }
  .dd-tokens { display: flex; flex-wrap: wrap; gap: 0.35rem; margin: -0.25rem 0 0.9rem; }
  .dd-token { border: 1px solid var(--color-border); background: var(--color-bg-card); border-radius: 999px; padding: 0.2rem 0.6rem; font-size: 0.78rem; cursor: pointer; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .dd-token:hover { border-color: var(--color-border-strong); background: var(--color-bg-hover); }
  .dd-token:focus-visible { outline: none; box-shadow: var(--focus-ring-strong); }
  .dd-token span { color: var(--color-text-muted); margin-left: 0.35rem; font-family: system-ui, sans-serif; }
  .dd-time { display: flex; flex-wrap: wrap; gap: 0.75rem; }
  .dd-time .form-group { flex: 1 1 9rem; margin: 0; }
  .dd-answers { margin-top: 0.85rem; }
  .dd-label { display: block; font-size: 0.72rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--color-text-muted); margin-bottom: 0.35rem; }
  .dd-savebar { display: flex; flex-wrap: wrap; align-items: center; gap: 0.75rem 1.25rem; margin-top: 1.25rem; padding-top: 1.1rem; border-top: 1px solid var(--color-border); }
  .dd-check { display: inline-flex; align-items: center; gap: 0.5rem; font-size: 0.88rem; color: var(--color-text-secondary); }
  @media (max-width: 900px) {
    .dd-wording { grid-template-columns: minmax(0, 1fr); }
  }
  @media (max-width: 600px) {
    .dd-guests__group { grid-template-columns: minmax(0, 1fr); gap: 0; }
    .dd-guests__group dd { margin-bottom: 0.35rem; }
  }
`;

/** The invite as guests will see it */
function InviteCard({ title, start, end, location, description, organizer }) {
  if (!start?.dateTime) return null;
  return html`
    <div class="dd-invite">
      <div class="dd-invite__title">${title}</div>
      <dl class="dd-facts">
        <dt>When</dt><dd>${day(start.dateTime.slice(0, 10))} · ${clock(start.dateTime.slice(11, 16))} to ${clock(end.dateTime.slice(11, 16))} ET</dd>
        ${location ? html`<dt>Where</dt><dd>${location}</dd>` : null}
        <dt>From</dt><dd>${organizer}</dd>
      </dl>
      <p class="dd-desc">${description}</p>
    </div>`;
}

/** Guests by group, named */
function Guests({ guests }) {
  const groups = {};
  for (const g of guests || []) (groups[g.kind] ||= []).push(g);
  const order = ['family', 'staff', 'sponsor', 'always', 'test'].filter((k) => groups[k]);
  if (!order.length) return html`<p class="dd-meta">Nobody to invite yet.</p>`;
  return html`
    <dl class="dd-guests">
      ${order.map((k) => html`
        <div class="dd-guests__group" key=${k}>
          <dt>${KIND[k]}</dt>
          <dd>${groups[k].map((g) => (g.name ? `${g.name}${g.role ? ` (${g.role})` : ''}` : g.email)).join(', ')}</dd>
        </div>`)}
    </dl>`;
}

// Guests' answers, from Google (on our invite, or on one sent by hand)
const ANSWERS = [['yes', 'Coming'], ['maybe', 'Maybe'], ['no', 'Can’t make it'], ['waiting', 'Not answered yet']];
const answersLine = (a) => {
  const parts = [a.yes.length && `${a.yes.length} coming`, a.maybe.length && `${a.maybe.length} maybe`, a.no.length && `${a.no.length} can’t make it`, a.waiting.length && `${a.waiting.length} not answered yet`].filter(Boolean);
  return `${a.from === 'by-hand' ? 'Answers on the invite sent by hand' : 'Answers'}: ${parts.join(', ') || 'no guests'}.`;
};
function Answers({ a }) {
  const rows = ANSWERS.filter(([k]) => a[k]?.length);
  if (!rows.length) return null;
  return html`
    <div class="dd-answers">
      <span class="dd-label">${a.from === 'by-hand' ? 'Answers on the invite sent by hand' : 'Answers so far'}</span>
      <dl class="dd-guests">
        ${rows.map(([k, label]) => html`<div class="dd-guests__group" key=${k}><dt>${label}</dt><dd>${a[k].join(', ')}</dd></div>`)}
      </dl>
    </div>`;
}

/** Where a demo day stands: { chip, tone, line, act } */
function standing(d, { enabled, organizerName }) {
  const inv = d.invite;
  if (inv?.error) return { chip: 'Not sent', tone: 'warn', line: `Couldn't send: ${inv.error}`, act: 'retry' };
  if (inv?.state === 'sent') {
    const first = (inv.log || []).find((l) => l.action === 'created');
    const last = inv.lastAction && inv.lastAction !== 'created' ? ` Last change: ${inv.lastAction.replace(/^kept: /, 'kept as it is, ')} ${ago(inv.updatedAt)}.` : '';
    return { chip: 'Sent', tone: 'on', line: `${first ? `Sent ${ago(first.at)}` : 'Sent'} to ${plural(inv.guests, 'person', 'people')}.${last}` };
  }
  if (inv?.state === 'by-hand') {
    const title = /^sent by hand: (.*)$/.exec(inv.lastAction || '')?.[1] || '';
    return { chip: 'Sent by hand', tone: 'neutral', line: `An invite was already sent by hand from ${organizerName || 'the organizer'}'s calendar${title ? ` (${title})` : ''}, so the site leaves this demo day alone.`, act: 'anyway' };
  }
  if (!inv?.state && d.handSent) {
    return { chip: 'Sent by hand', tone: 'neutral', line: `An invite was already sent by hand from ${organizerName || 'the organizer'}'s calendar ("${d.handSent.title}"${d.handSent.date && d.handSent.date !== d.date ? ` on ${day(d.handSent.date, 'short')}` : ''}), so the site will leave this demo day alone.`, act: 'anyway' };
  }
  if (inv?.state === 'cancelled') return { chip: 'Deleted', tone: 'muted', line: 'The invite was deleted in Google Calendar, so the site leaves this demo day alone.', act: 'again' };
  if (d.hold) return { chip: 'On hold', tone: 'neutral', line: `JobTread says: ${d.hold}. Nothing goes out while it's on hold.` };
  if (!d.date) return { chip: 'No date', tone: 'warn', line: 'Set Start Date is checked off, but the Demo task has no date. Give it one in JobTread and the invite goes out within a few minutes.' };
  if (!d.startSet) return { chip: 'Waiting', tone: 'neutral', line: 'Goes out when Set Start Date is checked off in JobTread.' };
  if (!enabled) return { chip: 'Ready', tone: 'ready', line: 'Set Start Date is checked off. This goes out as soon as demo day invites are turned on.' };
  return { chip: 'Going out', tone: 'ready', line: 'Set Start Date is checked off. The invite goes out within a few minutes.' };
}

function DemoRow({ d, enabled, organizer, organizerName, busy, onTest, onSync }) {
  const [open, setOpen] = useState(false);
  const s = standing(d, { enabled, organizerName });
  const time = d.time ? clock(d.time) : d.preview?.start?.dateTime ? `${clock(d.preview.start.dateTime.slice(11, 16))} (the default time)` : null;
  const onJob = d.sponsorOnJob || [];
  // The sponsor named on the job with nobody from it on the job: worth fixing before the invite goes
  const sponsorMissing = !!d.sponsor && !onJob.length;
  const sponsorLine = d.sponsor
    ? (onJob.length ? `Monetary Sponsor: ${d.sponsor} (${onJob.join(', ')}).` : `Monetary Sponsor: ${d.sponsor}. Nobody with the Sponsor role has access to this job in JobTread, so no one from ${d.sponsor} is invited yet.`)
    : onJob.length ? `Sponsor on the job: ${onJob.join(', ')}. The Monetary Sponsor field is empty in JobTread.` : 'No Monetary Sponsor in JobTread yet.';
  return html`
    <li class="dd-row">
      <div class="dd-row__head">
        <div>
          <div class="dd-row__name">${d.name}${d.test ? ' (test)' : ''} <span class=${`dd-chip dd-chip--${s.tone}`}>${s.chip}</span></div>
          <div class="dd-row__when">${d.date ? `${day(d.date, 'short')}${time ? ` · ${time}` : ''}` : 'No Demo date yet'}</div>
        </div>
        <a href=${d.scheduleUrl} target="_blank" rel="noopener">Open in JobTread ↗</a>
      </div>
      <p class=${`dd-meta${s.tone === 'warn' ? ' dd-warn' : ''}`}>${s.line}</p>
      <p class=${`dd-meta${sponsorMissing && (d.startSet || d.invite?.state === 'sent') ? ' dd-warn' : ''}`}>${sponsorLine}</p>
      ${d.answers ? html`<p class="dd-meta">${answersLine(d.answers)}</p>` : null}
      <div class="dd-actions">
        ${s.act === 'retry' ? html`<button class="btn btn-primary btn-sm" disabled=${!!busy} onClick=${() => onSync(d, false)}>${busy === `sync-${d.jobId}` ? html`<span class="spinner" /> Retrying...` : 'Retry'}</button>` : null}
        ${s.act === 'anyway' || s.act === 'again' ? html`<button class="btn btn-ghost btn-sm" disabled=${!!busy} onClick=${() => onSync(d, true)}>${s.act === 'anyway' ? 'Send ours anyway' : 'Send it again'}</button>` : null}
        ${d.preview ? html`<button class="btn btn-ghost btn-sm" aria-expanded=${open} onClick=${() => setOpen(!open)}>${open ? 'Hide the invite' : `See the invite (${plural(d.preview.guests.length, 'guest')})`}</button>` : null}
        ${d.preview ? html`<button class="btn btn-ghost btn-sm" disabled=${!!busy} onClick=${() => onTest(d)}>${busy === `test-${d.jobId}` ? html`<span class="spinner" /> Sending...` : 'Send it to me'}</button>` : null}
      </div>
      ${open && d.preview ? html`
        ${d.answers ? html`<${Answers} a=${d.answers} />` : null}
        <${InviteCard} ...${d.preview} organizer=${organizer} />
        <${Guests} guests=${d.preview.guests} />` : null}
    </li>`;
}

/** The every-demo-day list, with its add form */
function People({ list, people, busy, onAdd, onRemove }) {
  const [form, setForm] = useState({ email: '', name: '', role: '' });
  const submit = async (e) => {
    e.preventDefault();
    if (await onAdd({ list, ...form })) setForm({ email: '', name: '', role: '' });
  };
  const id = list.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  return html`
    <div>
      ${people.length ? html`
        <div class="dd-people">
          ${people.map((p) => html`
            <span class="dd-person" key=${p.email}>
              <span>${p.name || p.email}${p.name ? html` <small>${p.email}</small>` : null}${p.role ? html` <small>· ${p.role}</small>` : null}</span>
              <button type="button" disabled=${!!busy} aria-label=${`Take ${p.name || p.email} off`} title="Take off the list" onClick=${() => onRemove({ list, email: p.email, label: p.name || p.email })}>×</button>
            </span>`)}
        </div>` : null}
      <form class="dd-add" onSubmit=${submit}>
          <label class="sr-only" for=${`dd-email-${id}`}>Email</label>
          <input id=${`dd-email-${id}`} class="form-input" type="email" required placeholder="Email" autocomplete="off" value=${form.email} onInput=${(e) => setForm({ ...form, email: e.target.value })} />
          <label class="sr-only" for=${`dd-name-${id}`}>Name</label>
          <input id=${`dd-name-${id}`} class="form-input" type="text" placeholder="Name" autocomplete="off" value=${form.name} onInput=${(e) => setForm({ ...form, name: e.target.value })} />
          <label class="sr-only" for=${`dd-role-${id}`}>What they do</label>
          <input id=${`dd-role-${id}`} class="form-input form-input--short" type="text" placeholder="e.g. Social media" autocomplete="off" value=${form.role} onInput=${(e) => setForm({ ...form, role: e.target.value })} />
          <button class="btn btn-primary btn-sm" type="submit" disabled=${!!busy}>${busy === `add-${list}` ? html`<span class="spinner" /> Adding...` : 'Add'}</button>
      </form>
    </div>`;
}

export function DemoInvitesPanel({ addToast = () => {}, ConfirmModal = null }) {
  const [data, setData] = useState(null);
  const [loadError, setLoadError] = useState('');
  const [form, setForm] = useState(null); // { template, startTime, minutes }
  const [updateExisting, setUpdateExisting] = useState(false);
  const [busy, setBusy] = useState(null);
  const [confirm, setConfirm] = useState(null); // { title, message, confirmLabel, busyLabel, fn }
  const [lastField, setLastField] = useState('message');

  const load = useCallback(async ({ keepEdits = false } = {}) => {
    setLoadError('');
    try {
      const res = await fetch(API, { cache: 'no-store' });
      const d = await res.json();
      if (!d.ok) throw new Error(d.error || 'Could not load demo day invites');
      setData(d);
      if (!keepEdits) setForm({ template: { ...d.config.template }, startTime: d.config.startTime, minutes: d.config.minutes });
    } catch (e) { setLoadError(e.message); }
  }, []);
  useEffect(() => { load(); }, [load]);

  const post = async (body) => {
    const res = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const d = await res.json().catch(() => ({}));
    if (!res.ok || !d.ok) throw new Error(d.error || `Couldn't save (${res.status})`);
    return d;
  };
  const get = async (query) => {
    const res = await fetch(`${API}?${query}`, { cache: 'no-store' });
    const d = await res.json().catch(() => ({}));
    if (!d.ok) throw new Error(d.error || `That didn't work (${res.status})`);
    return d;
  };

  if (loadError) {
    return html`<div class="card"><p class="dd-meta dd-warn">Couldn't load demo day invites: ${loadError}</p><div class="dd-actions"><button class="btn btn-ghost btn-sm" onClick=${() => load()}>Try again</button></div></div>`;
  }
  if (!data || !form) return html`<div style="text-align:center;padding:3rem"><span class="spinner" /></div>`;

  const { config, defaults, limits, setup, demos = [], people = { always: [] }, staff = [] } = data;
  const organizerEmail = data.organizer || 'ccunningham@soardcharity.com';
  const organizer = data.organizerName ? `${data.organizerName} (${organizerEmail})` : organizerEmail;
  const problems = demos.filter((d) => d.invite?.error);
  const ready = demos.filter((d) => d.startSet && d.date && !d.invite && !d.hold && !d.handSent);
  const noSponsorOnJob = demos.filter((d) => d.sponsor && !(d.sponsorOnJob || []).length);
  const dirty = JSON.stringify(form) !== JSON.stringify({ template: config.template, startTime: config.startTime, minutes: config.minutes });

  const run = async (key, fn) => {
    setBusy(key);
    try { return await fn(); } catch (e) { addToast(e.message, 'error'); return null; } finally { setBusy(null); }
  };

  const setEnabled = (enabled) => run('toggle', async () => {
    await post({ enabled });
    addToast(enabled ? 'Demo day invites are on' : 'Demo day invites are paused', 'success');
    setConfirm(null);
    await load({ keepEdits: true });
  });
  const askEnabled = (enabled) => {
    const message = enabled
      ? `Families, the internal team, each job's sponsor and everyone on the every-demo-day list will get a calendar invite from ${data.organizerName || organizerEmail} when Set Start Date is checked off in JobTread.${ready.length ? ` Ready now: ${ready.map((d) => `${d.name} (${day(d.date, 'short')})`).join(', ')}.` : ''}`
      : 'Nothing new goes out while paused. Invites already sent stay on calendars as they are.';
    if (!ConfirmModal) return setEnabled(enabled);
    setConfirm({ title: enabled ? 'Turn on demo day invites?' : 'Pause demo day invites?', message, confirmLabel: enabled ? 'Turn on' : 'Pause', busyLabel: enabled ? 'Turning on...' : 'Pausing...', fn: () => setEnabled(enabled) });
  };

  const sendTest = (d) => run(`test-${d.jobId}`, async () => {
    const r = await get(`test=${encodeURIComponent(d.jobId)}`);
    addToast(r.action === 'skip' ? `No invite yet: ${r.reason}` : `Test of ${d.name}'s demo day invite sent to ${r.sentTo}`, r.action === 'skip' ? 'info' : 'success');
  });
  const doSync = (d, force) => run(`sync-${d.jobId}`, async () => {
    const r = await get(`sync=${encodeURIComponent(d.jobId)}${force ? '&force=1' : ''}`);
    const said = { created: 'sent', updated: 'updated', 'updated quietly': 'updated', unchanged: 'already up to date', 'by-hand': 'left alone: an invite was already sent by hand' }[r.action];
    addToast(said ? `${d.name}'s invite: ${said}` : r.reason ? `${d.name}: ${r.reason}` : 'Done', 'success');
    setConfirm(null);
    await load({ keepEdits: true });
  });
  const sync = (d, force) => {
    if (!force || !ConfirmModal) return doSync(d, force);
    const handSent = d.invite?.state === 'by-hand' || !!d.handSent;
    setConfirm({
      title: handSent ? `Send the site's invite for ${d.name}?` : `Send ${d.name}'s invite again?`,
      message: handSent
        ? 'An invite for this demo day was already sent by hand, so guests on both may see two. The site\'s invite then follows the Demo task in JobTread from here on.'
        : 'It was deleted in Google Calendar. Sending it again puts it back on every guest\'s calendar.',
      confirmLabel: 'Send it', busyLabel: 'Sending...', fn: () => doSync(d, true),
    });
  };

  const addPerson = (p) => run(`add-${p.list}`, async () => {
    const r = await post({ person: { list: p.list, email: p.email, name: p.name, role: p.role } });
    setData((cur) => ({ ...cur, people: r.people }));
    addToast(config.enabled ? `Added. Invites already out get them within a minute.` : 'Added', 'success');
    return true;
  });
  const removePerson = (p) => run(`remove-${p.list}`, async () => {
    const r = await post({ removePerson: { list: p.list, email: p.email } });
    setData((cur) => ({ ...cur, people: r.people }));
    addToast(`${p.label} taken off`, 'success');
  });

  const save = () => run('save', async () => {
    const d = await post({ template: form.template, startTime: form.startTime, minutes: Number(form.minutes), updateExisting });
    const changed = (d.updated || []).filter((r) => /^(updated|created)/.test(r.action)).length;
    addToast(d.updated ? `Saved. ${plural(changed, 'invite')} updated.` : 'Saved', 'success');
    setUpdateExisting(false);
    await load();
  });
  const insertToken = (token) => {
    const key = lastField;
    const el = document.getElementById(`dd-${key}`);
    const value = form.template[key] || '';
    const a = el && typeof el.selectionStart === 'number' ? el.selectionStart : value.length;
    const b = el && typeof el.selectionEnd === 'number' ? el.selectionEnd : value.length;
    setForm({ ...form, template: { ...form.template, [key]: value.slice(0, a) + token + value.slice(b) } });
    requestAnimationFrame(() => { if (el) { el.focus(); el.setSelectionRange(a + token.length, a + token.length); } });
  };

  // Wording preview: a real demo day coming up, at its own time or the default
  const sample = demos.find((d) => d.preview) || { name: 'Dylan', slug: null, date: new Date(Date.now() + 7 * 864e5).toISOString().slice(0, 10), time: null };
  const sampleTime = sample.time || form.startTime;
  const sampleSpace = sample.preview ? sample.space : 'Therapy Room';
  const sampleDesc = [
    fill(form.template.message, { name: sample.name, space: sampleSpace, date: sample.date, time: sampleTime }).trim(),
    sample.slug ? `Meet ${sample.name}: ${SITE}/kids/${sample.slug}/` : '',
    `Questions? Email ${data.organizerName ? `${data.organizerName} at ` : ''}${organizerEmail}.\nSunshine on a Ranney Day`,
  ].filter(Boolean).join('\n\n');
  const sampleEnd = sample.time && sample.preview ? sample.preview.end.dateTime.slice(11, 16) : addMinutes(sampleTime, Number(form.minutes) || 60);

  return html`
    <div class="dd">
      <style>${STYLES}</style>

      <div class="card dd-status">
        <div class="dd-status__main">
          <span class=${`dd-dot${config.enabled ? ' dd-dot--on' : ''}`} aria-hidden="true"></span>
          <div>
            <h3>${config.enabled ? 'Demo day invites are on' : 'Demo day invites are paused'}</h3>
            <p class="dd-meta">From ${organizer} as soon as a job's <strong>Set Start Date</strong> task is checked off in JobTread. The date comes from the job's <strong>Demo</strong> task, and the time too when the task has one. If the Demo task moves, the invite moves with it.</p>
            ${problems.length ? html`<p class="dd-meta dd-warn">${plural(problems.length, 'invite')} not sent. Retry is on each one below.</p>` : null}
            ${!setup.google ? html`<p class="dd-meta dd-warn">The Google Calendar key is missing in Cloudflare.</p>` : null}
            ${!setup.jobtread ? html`<p class="dd-meta dd-warn">The JobTread grant key is missing in Cloudflare.</p>` : null}
            ${data.listError ? html`<p class="dd-meta dd-warn">Couldn't read JobTread: ${data.listError}</p>` : null}
          </div>
        </div>
        <button class=${`btn ${config.enabled ? 'btn-ghost' : 'btn-primary'}`} disabled=${busy === 'toggle'} onClick=${() => askEnabled(!config.enabled)}>
          ${config.enabled ? 'Pause invites' : 'Turn on invites'}
        </button>
      </div>

      <div class="card">
        <h3>Coming up</h3>
        <p class="dd-meta">Every open job whose demo day is ahead, from JobTread.</p>
        ${demos.length ? html`
          <ul class="dd-list">
            ${demos.map((d) => html`<${DemoRow} key=${d.jobId} d=${d} enabled=${config.enabled} organizer=${organizer} organizerName=${data.organizerName} busy=${busy} onTest=${sendTest} onSync=${sync} />`)}
          </ul>` : html`<p class="dd-meta">No demo days ahead in JobTread.</p>`}
      </div>

      <div class="card">
        <h3>Who gets the invite</h3>
        <p class="dd-meta">The family, the internal team, the monetary sponsor and the every-demo-day list. Nobody else with access to the job in JobTread. Guests don't see each other, and the organizer is never a guest.</p>
        <div class="dd-who">
          <div class="dd-who__group">
            <h4>Family</h4>
            <p class="dd-meta">The job's customer contacts with an email, and anyone with the Makeover Family role who has access to the job. From JobTread.</p>
          </div>
          <div class="dd-who__group">
            <h4>Internal team</h4>
            <p class="dd-meta">${staff.length ? `${staff.map((s) => s.name).join(', ')}: ` : ''}the Admin and Designer users in JobTread.</p>
          </div>
          <div class="dd-who__group">
            <h4>The monetary sponsor</h4>
            <p class="dd-meta">Anyone with the <strong>Sponsor</strong> role who has access to the job in JobTread. The job's <strong>Monetary Sponsor</strong> field says which sponsor it is. Give someone from the sponsor access to the job and they're added within 5 minutes, even to an invite already out.</p>
            ${noSponsorOnJob.length ? html`<p class="dd-meta dd-warn">Nobody from the sponsor is on ${noSponsorOnJob.length === 1 ? 'this job' : 'these jobs'} in JobTread yet: ${noSponsorOnJob.map((d) => `${d.name} (${d.sponsor})`).join(', ')}.</p>` : null}
          </div>
          <div class="dd-who__group">
            <h4>Every demo day</h4>
            <p class="dd-meta">People invited to every demo day, like whoever covers it for social media.</p>
            <${People} list="always" people=${people.always || []} busy=${busy} onAdd=${addPerson} onRemove=${removePerson} />
          </div>
        </div>
      </div>

      <div class="card">
        <h3>Invite wording and time</h3>
        <p class="dd-meta">Used for every demo day. Click a placeholder to insert it where your cursor is.</p>
        <div class="dd-wording">
          <div>
            <div class="form-group">
              <label class="form-label" for="dd-title">Title</label>
              <input id="dd-title" class="form-input" type="text" maxlength=${limits?.title} value=${form.template.title}
                onFocus=${() => setLastField('title')} onInput=${(e) => setForm({ ...form, template: { ...form.template, title: e.target.value } })} />
            </div>
            <div class="form-group">
              <label class="form-label" for="dd-message">Message</label>
              <textarea id="dd-message" class="form-textarea" rows="5" maxlength=${limits?.message} value=${form.template.message}
                onFocus=${() => setLastField('message')} onInput=${(e) => setForm({ ...form, template: { ...form.template, message: e.target.value } })}></textarea>
            </div>
            <div class="dd-tokens" role="group" aria-label="Insert a placeholder">
              ${TOKENS.map((t) => html`<button type="button" class="dd-token" key=${t.token} onClick=${() => insertToken(t.token)}>${t.token}<span>${t.hint}</span></button>`)}
            </div>
            <div class="dd-time">
              <div class="form-group">
                <label class="form-label" for="dd-start">Start time</label>
                <input id="dd-start" class="form-input" type="time" step="900" value=${form.startTime} onInput=${(e) => setForm({ ...form, startTime: e.target.value })} />
              </div>
              <div class="form-group">
                <label class="form-label" for="dd-length">How long</label>
                <select id="dd-length" class="form-select" value=${String(form.minutes)} onChange=${(e) => setForm({ ...form, minutes: Number(e.target.value) })}>
                  ${(LENGTHS.some(([m]) => m === Number(form.minutes)) ? LENGTHS : [...LENGTHS, [Number(form.minutes), `${form.minutes} minutes`]]).map(([m, label]) => html`<option value=${String(m)}>${label}</option>`)}
                </select>
              </div>
            </div>
            <p class="dd-meta">For a Demo task with no time in JobTread. A Demo task's own time always wins.</p>
          </div>
          <div>
            <span class="dd-label">Preview, ${sample.name}</span>
            <${InviteCard} title=${fill(form.template.title, { name: sample.name, space: sampleSpace, date: sample.date, time: sampleTime })}
              start=${{ dateTime: `${sample.date}T${sampleTime}:00` }} end=${{ dateTime: `${sample.date}T${sampleEnd}:00` }}
              location=${sample.preview?.location || null} description=${sampleDesc} organizer=${organizer} />
          </div>
        </div>
        <div class="dd-savebar">
          <button class="btn btn-primary" disabled=${!dirty || busy === 'save'} onClick=${save}>
            ${busy === 'save' ? html`<span class="spinner" /> Saving...` : dirty ? 'Save' : 'Saved'}
          </button>
          ${dirty ? html`<button class="btn btn-ghost" onClick=${() => setForm({ template: { ...config.template }, startTime: config.startTime, minutes: config.minutes })}>Undo changes</button>` : null}
          <label class="dd-check">
            <input type="checkbox" checked=${updateExisting} disabled=${!config.enabled || !dirty} onChange=${(e) => setUpdateExisting(e.target.checked)} />
            Also update invites already sent (each guest gets an update email)
          </label>
          ${JSON.stringify(form.template) !== JSON.stringify(defaults.template) ? html`
            <button class="btn btn-ghost" onClick=${() => setForm({ ...form, template: { ...defaults.template } })}>Use the original wording</button>` : null}
        </div>
        <p class="dd-meta">A new start time or length moves invites already out that use it, and their guests get an update. New wording goes on new invites, and on invites already out the next time their date, time or guests change.</p>
      </div>

      ${confirm && ConfirmModal ? html`<${ConfirmModal}
        title=${confirm.title} message=${confirm.message} confirmLabel=${confirm.confirmLabel} busyLabel=${confirm.busyLabel}
        loading=${!!busy} onConfirm=${confirm.fn} onCancel=${() => setConfirm(null)} />` : null}
    </div>`;
}
