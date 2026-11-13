/**
 * A donor's timeline (Admin → Donors & Partners, a person's or an organization's page)
 * ===========================================================================
 * Peter, Nov 12 2026: "similar to what i built in crm for datax, … a timeline of emails, donations, etc", for everyone
 * on the team, in place of the page's Gifts, Notes and History. One list, newest first, of everything that happened
 * with them: their gifts (each with its thank-you, from the page), the team's notes (added, changed and deleted here),
 * and what /api/donors-admin?timeline= reads from outside (functions/api/_donor-timeline.js): email with the team
 * (Gmail), meetings (Calendar), calls and texts (Quo), newsletters (Kit), what the website emailed them, the team's
 * changes, and an organization's partner page and makeovers.
 *
 * On top, At a glance: the same lines on one time axis in five lanes (gifts, email, calls and texts, meetings, the
 * team), with a sentence of what the last year held. A day is read by pointing or tapping it, or with the arrow keys,
 * and Enter (or a click) shows it in the list. Filters with counts narrow the list. An email, a call, a day's texts,
 * a month's newsletters and a website email open in place. A source that can't be read says so above the list,
 * rather than the list looking quiet.
 */
import { h, htm, useState, useEffect, useRef, useMemo } from './vendor.js';
import { ask } from './ask.js';
import { useDialog } from './dialog.js';
import { EmailFrame } from './email-sheet.js';
import { zeffyPaymentUrl } from './zeffy-links.js';

const html = htm.bind(h);
const API = '/api/donors-admin';
// Lines drawn at first; "Show more" draws the next ones (a long-time donor has hundreds)
const STEP = 60;
// A timeline read again after this long, else kept (moving between donors and back doesn't read Gmail again)
const FRESH_MS = 3 * 60 * 1000;
const DAY = 864e5;

const STYLE = `
.dn-tl { display: grid; gap: .9rem; min-width: 0; grid-template-columns: minmax(0, 1fr); }
.dn-tl__head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: .4rem .75rem; }
.dn-tl__head h3 { margin: 0; }
.dn-tl__state { display: inline-flex; flex-wrap: wrap; align-items: center; gap: .25rem .6rem; font-size: var(--fs-xs); color: var(--color-text-muted); }
.dn-tl__state .spinner { width: 12px; height: 12px; }
.dn-tl__filters { display: flex; flex-wrap: wrap; gap: .4rem; min-width: 0; }
.dn-tl__notices { display: grid; gap: .5rem; grid-template-columns: minmax(0, 1fr); }
.dn-tl__notices .notice { margin: 0; }
.dn-tl__quiet { margin: 0; font-size: var(--fs-xs); color: var(--color-text-muted); overflow-wrap: anywhere; }
.dn-tl__list, .dn-tl__month ol { margin: 0; padding: 0; list-style: none; display: grid; grid-template-columns: minmax(0, 1fr); }
.dn-tl__month + .dn-tl__month { margin-top: .5rem; }
.dn-tl__month h4 { position: sticky; top: var(--top-h, 56px); z-index: 1; margin: 0; padding: .4rem 0; background: var(--color-bg-card); font-size: var(--fs-xs); font-weight: 650; color: var(--color-text-muted); letter-spacing: .02em; }
.dn-tl__item { display: grid; grid-template-columns: 4.6rem 14px minmax(0, 1fr) auto; gap: .15rem .6rem; align-items: start; padding: .6rem .35rem; border-top: 1px solid var(--color-border); border-radius: 8px; min-width: 0; }
.dn-tl__month li:first-child.dn-tl__item { border-top: none; }
.dn-tl__item.is-flash { background: var(--tone-warn-surface, #FFF9DB); }
.dn-tl__when { font-size: var(--fs-xs); color: var(--color-text-muted); padding-top: .15rem; font-variant-numeric: tabular-nums; }
.dn-tl__clock { display: block; }
.dn-tl__dot { width: 9px; height: 9px; margin-top: .4rem; border-radius: 50%; background: var(--tone-neutral-dot); justify-self: center; }
.dn-tl__dot--gift { background: var(--tone-success-dot); }
.dn-tl__dot--talk { background: var(--tone-info-dot); }
.dn-tl__dot--note { background: var(--color-text); }
.dn-tl__dot--warn { background: var(--tone-warn-dot); }
.dn-tl__dot--soon { background: var(--color-bg-card); border: 2px solid var(--tone-info-dot); width: 10px; height: 10px; }
.dn-tl__body { display: grid; gap: .15rem; min-width: 0; }
.dn-tl__who { font-size: var(--fs-xs); font-weight: 600; color: var(--color-text-secondary); overflow-wrap: anywhere; }
.dn-tl__title { font-size: var(--fs-sm); font-weight: 650; color: var(--color-text); overflow-wrap: anywhere; }
.dn-tl__detail { margin: 0; font-size: var(--fs-sm); color: var(--color-text-secondary); overflow-wrap: anywhere; }
.dn-tl__note { margin: 0; font-size: var(--fs-sm); line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
.dn-tl__meta { display: flex; flex-wrap: wrap; align-items: center; gap: .2rem .6rem; font-size: var(--fs-xs); color: var(--color-text-muted); }
.dn-tl__meta .tag { font-size: var(--fs-2xs, .7rem); }
.dn-tl__do { display: flex; flex-wrap: wrap; align-items: center; gap: .25rem .9rem; font-size: var(--fs-xs); margin-top: .1rem; }
.dn-tl__amt { font-weight: 700; font-variant-numeric: tabular-nums; text-align: right; font-size: var(--fs-sm); white-space: nowrap; }
.dn-tl__more { display: flex; flex-wrap: wrap; justify-content: center; gap: .5rem; padding-top: .25rem; }
.dn-tl__empty { padding: 1rem 0; color: var(--color-text-secondary); font-size: var(--fs-sm); }
.dn-tl__soon { display: grid; gap: .35rem; padding: .65rem .8rem; border: 1px solid var(--tone-info-line); border-radius: 10px; background: var(--tone-info-surface); }
.dn-tl__soon h4 { margin: 0; font-size: var(--fs-xs); color: var(--tone-info-fg); }
.dn-tl__soon ul { margin: 0; padding: 0; list-style: none; display: grid; gap: .25rem; font-size: var(--fs-sm); }
.dn-tl__skel { display: grid; gap: .5rem; padding: .25rem 0; }
.dn-tl__skel .skel { height: 12px; }
/* At a glance */
.dn-gl { display: grid; gap: .45rem; padding: .75rem .85rem; border: 1px solid var(--color-border); border-radius: 12px; min-width: 0; grid-template-columns: minmax(0, 1fr); }
.dn-gl__top { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: .4rem .75rem; }
.dn-gl__top strong { font-size: var(--fs-xs); }
.dn-gl__said { margin: 0; font-size: var(--fs-sm); color: var(--color-text-secondary); overflow-wrap: anywhere; }
.dn-gl__chart { display: grid; grid-template-columns: 6.5rem minmax(0, 1fr); gap: 0 .5rem; align-items: stretch; min-width: 0; }
.dn-gl__lanes { display: grid; margin: 0; padding: 0; list-style: none; font-size: var(--fs-2xs, .7rem); color: var(--color-text-muted); }
.dn-gl__lanes li { height: 20px; display: flex; align-items: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dn-gl__svg { display: block; border-radius: 6px; cursor: crosshair; touch-action: pan-y; overflow: visible; }
.dn-gl__svg:focus { outline: none; }
.dn-gl__svg:focus-visible { box-shadow: var(--focus-ring-strong); }
.dn-gl__day { margin: 0; min-height: 1.25rem; font-size: var(--fs-xs); color: var(--color-text-secondary); overflow-wrap: anywhere; }
.dn-gl__day button { margin-left: .5rem; }
.dn-gl .mm-seg button { padding: .2rem .6rem; }
/* What opens in place */
.dn-tl-sheet .mm-sheet { width: min(720px, 100%); }
.dn-tl-sheet__body { overflow: auto; padding: 1rem 1.25rem 1.25rem; display: grid; gap: .9rem; grid-template-columns: minmax(0, 1fr); }
.dn-tl-msg { display: grid; gap: .35rem; padding: .75rem .85rem; border: 1px solid var(--color-border); border-radius: 12px; min-width: 0; max-width: 92%; }
.dn-tl-msg--theirs { justify-self: start; background: var(--color-bg-card); }
.dn-tl-msg--ours { justify-self: end; background: var(--color-bg-secondary); }
.dn-tl-msg__head { display: flex; flex-wrap: wrap; justify-content: space-between; gap: .2rem .75rem; font-size: var(--fs-xs); color: var(--color-text-muted); }
.dn-tl-msg__head strong { color: var(--color-text); }
.dn-tl-msg__text { margin: 0; font-size: var(--fs-sm); line-height: 1.5; white-space: pre-wrap; overflow-wrap: anywhere; }
.dn-tl-msg__files { margin: 0; font-size: var(--fs-xs); color: var(--color-text-muted); }
.dn-tl-sheet__list { margin: 0; padding: 0; list-style: disc inside; display: grid; gap: .3rem; font-size: var(--fs-sm); }
.dn-tl-sheet__plain { margin: 0; padding: 0; list-style: none; display: grid; gap: .45rem; font-size: var(--fs-sm); }
.dn-tl-sheet__plain li { display: grid; gap: .1rem; }
.dn-tl-sheet h4 { margin: 0; font-size: var(--fs-xs); color: var(--color-text-muted); }
@media (max-width: 720px) {
  .dn-tl__item { grid-template-columns: 14px minmax(0, 1fr) auto; }
  .dn-tl__when { grid-column: 2 / -1; grid-row: 1; padding-top: 0; }
  .dn-tl__clock { display: inline; margin-left: .4rem; }
  .dn-tl__dot { grid-row: 2; grid-column: 1; margin-top: .3rem; }
  .dn-tl__body { grid-row: 2; grid-column: 2; }
  .dn-tl__amt { grid-row: 2; grid-column: 3; }
  .dn-gl__chart { grid-template-columns: 4.6rem minmax(0, 1fr); }
  .dn-tl-msg { max-width: 100%; }
}
@media (pointer: coarse) { .dn-tl__do a, .dn-tl__do button, .dn-gl__day button { min-height: 44px; display: inline-flex; align-items: center; } }
`;
let styled = false;
function useStyles() {
  if (styled) return;
  styled = true;
  const el = document.createElement('style');
  el.dataset.module = 'donor-timeline';
  el.textContent = STYLE;
  document.head.append(el);
}

// ─── Small words ────────────────────────────────────────────────────

const usd = (cents) => { const c = Math.round(Number(cents) || 0); return `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: c % 100 ? 2 : 0, maximumFractionDigits: 2 })}`; };
const plural = (n, w, ws = `${w}s`) => `${n.toLocaleString()} ${n === 1 ? w : ws}`;
const thisYear = () => new Date().getFullYear();
const dayOf = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const shortDate = (ms) => { const d = new Date(ms); return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York', ...(d.getFullYear() !== thisYear() ? { year: 'numeric' } : {}) }); };
const longDate = (ms) => new Date(ms).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' });
const clock = (ms) => new Date(ms).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });
const monthOf = (ms) => new Date(ms).toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'America/New_York' });
const minutes = (s) => (s < 60 ? `${s} sec` : `${Math.round(s / 60)} min`);
const ago = (iso) => { const m = Math.round((Date.now() - Date.parse(iso)) / 60000); return !Number.isFinite(m) ? '' : m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`; };
/** A teammate by their address: their name from Google, else the start of the address */
export const nameOf = (email, staff = []) => {
  if (!email) return '';
  const s = staff.find((x) => x.email === email);
  if (s) return s.name;
  if (!String(email).includes('@')) return String(email);
  const f = String(email).split('@')[0].split(/[._+-]/)[0];
  return f ? f[0].toUpperCase() + f.slice(1) : String(email);
};
const first = (email, staff) => nameOf(email, staff).split(' ')[0];
const names = (list, staff) => { const n = [...new Set((list || []).map((e) => first(e, staff)).filter(Boolean))]; return n.length <= 2 ? n.join(' and ') : `${n.slice(0, -1).join(', ')} and ${n[n.length - 1]}`; };

async function call(params = '', body = null) {
  try {
    const r = await fetch(`${API}${params}`, body ? { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body) } : { headers: { Accept: 'application/json' } });
    const j = await r.json().catch(() => null);
    return j ? (j.success ? j : { ...j, status: r.status }) : { success: false, error: 'The site didn’t answer.', status: r.status };
  } catch {
    return { success: false, error: 'The site didn’t answer.' };
  }
}

// ─── The lines ──────────────────────────────────────────────────────

/** The filters, in order: [key, words, which kinds] */
export const GROUPS = [
  ['gift', 'Gifts', ['gift', 'thanks']],
  ['email', 'Email', ['email']],
  ['phone', 'Calls and texts', ['call', 'text']],
  ['meeting', 'Meetings', ['meeting']],
  ['note', 'Notes', ['note']],
  ['kit', 'Newsletters', ['kit']],
  ['site', 'Website emails', ['site']],
  ['team', 'Team changes', ['team']],
  ['partner', 'Partner page', ['partner', 'makeover']],
];
const GROUP_OF = Object.fromEntries(GROUPS.flatMap(([k, , kinds]) => kinds.map((x) => [x, k])));
// The five lanes of At a glance: [key, words, which kinds]
const LANES = [
  ['gift', 'Gifts', ['gift']],
  ['email', 'Email', ['email', 'site']],
  ['phone', 'Calls, texts', ['call', 'text']],
  ['meeting', 'Meetings', ['meeting']],
  ['team', 'Notes, team', ['note', 'thanks', 'team']],
];
const LANE_OF = Object.fromEntries(LANES.flatMap(([k, , kinds], i) => kinds.map((x) => [x, i])));

/** The page's gifts and notes, and what the site read, as one list newest first (each id once) */
export function linesOf({ gifts = [], notes = [], items = [] }) {
  const out = new Map();
  for (const g of gifts) out.set(`gift:${g.id}`, { id: `gift:${g.id}`, kind: 'gift', at: (Number(g.at) || 0) * 1000, gift: g });
  for (const n of notes) out.set(`note:${n.id}`, { id: `note:${n.id}`, kind: 'note', at: Date.parse(n.at) || 0, note: n });
  for (const x of items) if (!out.has(x.id)) out.set(x.id, x);
  return [...out.values()].sort((a, b) => b.at - a.at || String(a.id).localeCompare(String(b.id)));
}

/** A gift in a few words: where it came from and how */
const giftMeta = (g, byWho) => [byWho && g.by ? `from ${g.by}` : null, g.how, g.every ? g.every[0].toUpperCase() + g.every.slice(1) : null, g.parts > 1 ? `in ${g.parts} charges` : null,
  !byWho && g.forCompany ? `for ${g.forCompany}` : null, g.through ? `through ${g.through}` : null, g.anonymous ? 'anonymous' : null, g.refunded ? 'refunded in full' : null,
  g.sold ? 'a ticket or purchase, not counted as giving' : null].filter(Boolean);

/** Who did what, the line above a line's title */
export function whoLine(x, { staff = [], them = 'them', org = false }) {
  const team = names(x.staff, staff) || 'The team';
  const theirName = org && x.them?.length ? x.from || x.them[0] : them;
  switch (x.kind) {
    case 'email': return x.dir === 'in' ? `${org ? theirName : 'They'} wrote to ${team}` : x.dir === 'out' ? `${team} wrote to ${org && x.them?.length ? x.them.join(', ') : 'them'}` : `${x.from || 'Someone'} wrote to them and ${team}`;
    case 'meeting': return x.big ? `Invited, with ${plural(x.guests, 'guest')}` : `Meeting with ${team}`;
    case 'call': return x.dir === 'in' ? (x.missed ? 'Missed call from them' : `They called${x.by ? ` ${x.by}` : ''}`) : x.missed ? `${x.by || 'The team'} called: no answer` : `${x.by || 'The team'} called them`;
    case 'text': return `Texts with ${x.by?.length ? x.by.join(' and ') : 'the team'}`;
    case 'kit': return 'Kit';
    case 'site': return 'The website emailed them';
    case 'thanks': case 'team': return x.by ? nameOf(x.by, staff) : x.byName || 'The site';
    case 'partner': return x.by ? `${nameOf(x.by, staff)}, Partners` : 'Partners';
    case 'makeover': return 'Makeover credit';
    default: return '';
  }
}

const dotOf = (x, now) => (x.kind === 'meeting' && x.at > now ? 'soon' : x.tone === 'warn' || (x.kind === 'site' && x.tone) ? 'warn'
  : x.kind === 'gift' || x.kind === 'thanks' ? 'gift' : ['email', 'call', 'text', 'meeting'].includes(x.kind) ? 'talk' : x.kind === 'note' ? 'note' : '');

// ─── The timeline ───────────────────────────────────────────────────

const cache = new Map(); // ref → { at, data }
// What the site holds itself: read again after a change on the page (Google, Quo and Kit aren't asked again)
const LOCAL = new Set(['team', 'thanks', 'site', 'partner', 'makeover']);
/** A whole read with the site's own lines of a later quick read in place of its own */
const withLocal = (full, quick) => (!quick ? full : { ...full, items: [...full.items.filter((x) => !LOCAL.has(x.kind)), ...quick.items], sources: full.sources.map((s) => quick.sources.find((q) => q.key === s.key) || s) });

/**
 * subject: the page's key (notes are said against it); ref: its address for the read (a contact id, g:<payment>, or
 * an organization's key); gifts and notes from the page; onChanged reads the page again (a note added)
 */
export function Timeline({ subject, refOf, org = false, name, gifts = [], notes = [], staff = [], me = null, ctx, onChanged, zeffy = false, focusGift = null }) {
  useStyles();
  const [data, setData] = useState(() => cache.get(refOf)?.data || null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState('all');
  // A gift a link opened the page at (Slack's MAJOR GIFT post) is drawn from the start, however far down it is
  const [shown, setShown] = useState(() => {
    if (!focusGift) return STEP;
    const i = linesOf({ gifts, notes, items: cache.get(refOf)?.data?.items || [] }).findIndex((x) => x.gift && (x.gift.ids || [x.gift.id]).includes(focusGift));
    return Math.max(STEP, i + 10);
  });
  const [open, setOpen] = useState(null);
  const [older, setOlder] = useState(false);
  const seq = useRef(0);
  // The latest quick read of the site's own lines, and when it was asked: a whole read asked before it takes its lines
  const quick = useRef({ at: 0, data: null, n: 0 });
  useEffect(() => () => { seq.current++; quick.current.n++; }, []);
  const read = async (force = false) => {
    const had = cache.get(refOf);
    const mine = ++seq.current;
    if (!force && had && Date.now() - had.at < FRESH_MS) { setBusy(false); setData(had.data); return; }
    const asked = Date.now();
    setBusy(true);
    setErr(null);
    const j = await call(`?timeline=${encodeURIComponent(refOf)}`);
    if (mine !== seq.current) return;
    setBusy(false);
    if (!j.success) { setErr(j.error); return; }
    const next = quick.current.at > asked ? withLocal(j, quick.current.data) : j;
    cache.set(refOf, { at: Date.now(), data: next });
    setData(next);
  };
  // Another donor in the same place (a page's address settling): from the top. The first time, as drawn
  const mounted = useRef(false);
  useEffect(() => {
    quick.current = { at: 0, data: null, n: quick.current.n + 1 };
    if (mounted.current) { setData(cache.get(refOf)?.data || null); setFilter('all'); setShown(STEP); }
    mounted.current = true;
    read();
  }, [refOf]);
  // The page read again (a note, an owner, a thank-you said): the site's own lines again at once
  const drawn = useRef(false);
  useEffect(() => {
    if (!drawn.current) { drawn.current = true; return; }
    const n = ++quick.current.n;
    const asked = Date.now();
    call(`?timeline=${encodeURIComponent(refOf)}&local=1`).then((j) => {
      if (n !== quick.current.n || !j.success) return;
      quick.current = { at: asked, data: j, n };
      setData((d) => {
        if (!d) return d;
        const next = withLocal(d, j);
        cache.set(refOf, { at: cache.get(refOf)?.at ?? Date.now(), data: next });
        return next;
      });
    });
  }, [gifts, notes]);
  const showOlder = async () => {
    if (!data?.more || older) return;
    setOlder(true);
    const p = new URLSearchParams({ timeline: refOf, older: '1', ...(data.more.mail ? { mail: data.more.mail } : {}), ...(data.more.quo ? { quo: data.more.quo } : {}) });
    const mine = seq.current;
    const j = await call(`?${p}`);
    setOlder(false);
    if (mine !== seq.current) return;
    if (!j.success) { ctx.addToast(j.error, 'error'); return; }
    // Added to the timeline as it is now (a quick read or Read again may have landed meanwhile)
    setData((d) => {
      if (!d) return d;
      const byId = new Map(j.items.map((x) => [x.id, x]));
      // An email already here, found in another mailbox's older pages: that mailbox's copy too (its Open in Gmail)
      const merged = d.items.map((x) => (byId.has(x.id) && x.copies ? { ...x, copies: { ...byId.get(x.id).copies, ...x.copies }, mailboxes: [...new Set([...(x.mailboxes || []), ...Object.keys(byId.get(x.id).copies || {})])] } : x));
      const have = new Set(d.items.map((x) => x.id));
      const next = { ...d, items: [...merged, ...j.items.filter((x) => !have.has(x.id))], more: j.more };
      cache.set(refOf, { at: cache.get(refOf)?.at ?? Date.now(), data: next });
      return next;
    });
    setShown((n) => n + STEP);
  };
  const now = Date.now();
  const all = useMemo(() => linesOf({ gifts, notes, items: data?.items || [] }), [gifts, notes, data]);
  // The gift a link opened at: drawn however far down the timeline's other lines push it, until the person moves on
  // (a filter, Show more), so the page's mark on it never lands on nothing
  const keepGift = useRef(focusGift);
  const past = all.filter((x) => !(x.kind === 'meeting' && x.at > now));
  const soon = all.filter((x) => x.kind === 'meeting' && x.at > now).sort((a, b) => a.at - b.at);
  const counts = new Map();
  for (const x of past) counts.set(GROUP_OF[x.kind], (counts.get(GROUP_OF[x.kind]) || 0) + 1);
  const list = filter === 'all' ? past : past.filter((x) => GROUP_OF[x.kind] === filter);
  // Worked out as it draws (never a paint later): the gift a link opened at is always among the lines drawn
  const giftAt = keepGift.current ? list.findIndex((x) => x.gift && (x.gift.ids || [x.gift.id]).includes(keepGift.current)) : -1;
  const upTo = Math.max(shown, giftAt + 10);
  const flash = (id) => requestAnimationFrame(() => {
    const el = document.querySelector(`.dn-tl__item[data-line="${CSS.escape(id)}"]`);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.classList.add('is-flash');
    setTimeout(() => el.classList.remove('is-flash'), 2400);
  });
  // A day from At a glance: the whole list (a filter could hide it), drawn far enough to hold it, the day's first line marked
  const showDay = (day) => {
    const i = past.findIndex((x) => dayOf(x.at) === day);
    if (i < 0) return;
    setFilter('all');
    setShown((n) => Math.max(n, i + 10));
    flash(past[i].id);
  };
  const sources = data?.sources || [];
  return html`<section class="card kd-sec dn-tl" aria-labelledby="dn-tl-h">
    <header class="dn-tl__head"><h3 id="dn-tl-h" tabindex="-1">Timeline</h3>
      <span class="dn-tl__state"><span role="status">${busy ? html`<span class="spinner" aria-hidden="true" /> Reading email, meetings, calls and newsletters…` : data ? `Read ${ago(data.checkedAt)}` : ''}</span>
        ${data || err ? html`<button type="button" class="link dn-linkbtn dn-tl__again" aria-disabled=${busy ? 'true' : null} onClick=${() => { if (!busy) read(true); }}>Read again</button>` : null}</span></header>
    <${NoteBox} subject=${subject} name=${name} zeffy=${zeffy} ctx=${ctx} onDone=${onChanged} />
    ${past.length ? html`<${Glance} lines=${past} kit=${data?.kit} onDay=${showDay} />` : null}
    <${Notices} sources=${sources} err=${err} retry=${() => { document.querySelector('.dn-tl__again')?.focus(); read(true); }} searched=${data?.subject?.searched} staff=${staff} kit=${data?.kit} />
    ${soon.length ? html`<div class="dn-tl__soon"><h4>Coming up</h4><ul>${soon.map((x) => html`<li key=${x.id}><strong>${x.title}</strong> · ${longDate(x.at)}${x.allDay ? '' : `, ${clock(x.at)}`} · ${whoLine(x, { staff })}</li>`)}</ul></div>` : null}
    ${past.length ? html`<div class="dn-tl__filters" role="group" aria-label="Show">
      <button type="button" class="pill pill--sm" aria-pressed=${String(filter === 'all')} onClick=${() => { keepGift.current = null; setFilter('all'); setShown(STEP); }}>Everything <span class="count">${past.length}</span></button>
      ${GROUPS.filter(([k]) => counts.get(k)).map(([k, words]) => html`<button key=${k} type="button" class="pill pill--sm" aria-pressed=${String(filter === k)} onClick=${() => { keepGift.current = null; setFilter(k); setShown(STEP); }}>${words} <span class="count">${counts.get(k)}</span></button>`)}
    </div>` : null}
    ${!past.length ? (busy || (!data && !err) ? html`<div class="dn-tl__skel" aria-hidden="true">${[90, 70, 80].map((w) => html`<span class="skel" style=${`--w:${w}%`}></span>`)}</div>`
      : html`<p class="dn-tl__empty">Nothing yet. Gifts, notes, email with the team, calls, meetings and newsletters show here as they happen.</p>`)
      : html`<${Lines} lines=${list.slice(0, upTo)} staff=${staff} me=${me || data?.me || null} org=${org} name=${name} now=${now} ctx=${ctx} onOpen=${setOpen} onChanged=${onChanged} />`}
    ${list.length > upTo || data?.more?.mail || data?.more?.quo ? html`<div class="dn-tl__more">
      ${list.length > upTo ? html`<button type="button" class="btn btn-ghost btn-sm" onClick=${() => setShown(upTo + STEP)}>Show ${Math.min(STEP, list.length - upTo)} more</button>` : null}
      ${list.length <= upTo && (data?.more?.mail || data?.more?.quo) && (filter === 'all' || filter === 'email' || filter === 'phone') ? html`<button type="button" class="btn btn-ghost btn-sm" aria-busy=${older ? 'true' : null} onClick=${showOlder}>${older ? html`<span class="spinner spinner-14" />` : null}Show older email and calls</button>` : null}
    </div>` : null}
    ${open ? html`<${OpenSheet} x=${open} refOf=${refOf} staff=${staff} name=${name} onClose=${() => setOpen(null)} />` : null}
  </section>`;
}

/** What couldn't be read, or isn't connected, said once above the list */
function Notices({ sources, err, retry, searched, staff, kit = null }) {
  const failed = sources.filter((s) => s.state === 'error');
  const partly = sources.filter((s) => s.state === 'ok' && s.errors?.length);
  const off = sources.filter((s) => s.state === 'off');
  const skipped = sources.find((s) => s.state === 'skipped');
  const none = sources.filter((s) => s.state === 'none' && s.note);
  const mailboxes = (s) => names(s.errors.map((e) => e.mailbox), staff);
  const offWords = { mail: 'Gmail', calendar: 'Google Calendar', quo: 'Quo', kit: 'Kit' };
  return html`<div class="dn-tl__notices">
    ${err ? html`<div class="notice notice--warn"><div class="notice__body">Email, meetings, calls and newsletters couldn’t be read just now: ${err} Gifts and notes are all here.</div>
      <div class="notice__actions"><button type="button" class="btn btn-ghost btn-sm" onClick=${retry}>Try again</button></div></div>` : null}
    ${failed.map((s) => html`<div key=${s.key} class="notice notice--warn"><div class="notice__body">${s.label} couldn’t be read: ${s.note || (s.errors?.[0]?.error) || 'it didn’t answer'}. The rest of the timeline is here.</div>
      <div class="notice__actions"><button type="button" class="btn btn-ghost btn-sm" onClick=${retry}>Try again</button></div></div>`)}
    ${partly.map((s) => html`<p key=${s.key} class="dn-tl__quiet">${s.label}: ${mailboxes(s)}’s ${s.errors.length === 1 ? 'account' : 'accounts'} couldn’t be read (${s.errors[0].error}).</p>`)}
    ${sources.filter((s) => s.missed).map((s) => html`<p key=${`${s.key}-missed`} class="dn-tl__quiet">Gmail was busy: ${plural(s.missed, 'conversation')} couldn’t be read this time. Read again to try.</p>`)}
    ${skipped ? html`<p class="dn-tl__quiet">${skipped.note}.</p>` : null}
    ${sources.filter((x) => x.state === 'ok' && x.note).map((x) => html`<p key=${`${x.key}-note`} class="dn-tl__quiet">${x.label}: ${x.note}.</p>`)}
    ${kit?.cant?.length ? html`<div class="notice notice--warn"><div class="notice__body">Kit can’t reach ${kit.cant.map((c) => c.email).join(', ')}: ${kit.cant.some((c) => c.state === 'bounced') ? 'their email bounced' : 'they marked a newsletter as spam'}, so they get no newsletters.</div></div>` : null}
    ${off.length ? html`<p class="dn-tl__quiet">${off.map((s) => offWords[s.key] || s.label).join(', ')} ${off.length === 1 ? 'isn’t' : 'aren’t'} connected yet: ${off.some((s) => s.key === 'quo') ? 'calls and texts' : 'what it knows'} will show here once ${off.length === 1 ? 'it is' : 'they are'}.</p>` : null}
    ${none.length ? html`<p class="dn-tl__quiet">${none.map((s) => `${s.label}: ${s.note}`).join('. ')}.</p>` : null}
    ${searched && (searched.emails.length || searched.domains.length || searched.phones.length || searched.skipped.length) ? html`<p class="dn-tl__quiet">Searched for ${[
      searched.emails.length ? searched.emails.join(', ') : null, searched.domains.length ? `anyone at ${searched.domains.join(', ')}` : null, searched.phones.length ? searched.phones.join(', ') : null,
    ].filter(Boolean).join(' · ') || 'nothing'}${searched.skipped.length ? `. Not searched, as the team’s: ${searched.skipped.map((s) => s.address).join(', ')}` : ''}.</p>` : null}
  </div>`;
}

function Lines({ lines, staff, me, org, name, now, ctx, onOpen, onChanged }) {
  const months = [];
  for (const x of lines) {
    const m = x.undated ? 'Date unknown' : x.year ? String(x.year) : monthOf(x.at);
    if (!months.length || months[months.length - 1].m !== m) months.push({ m, lines: [] });
    months[months.length - 1].lines.push(x);
  }
  // Keyed by the month and which time that month comes (never by position: a month read in above would redraw every
  // group under it, and a note being changed in one with it)
  const seen = new Map();
  for (const g of months) { const n = (seen.get(g.m) || 0) + 1; seen.set(g.m, n); g.key = `${g.m}#${n}`; }
  return html`<ol class="dn-tl__list" aria-label="Timeline, newest first">${months.map((g) => html`<li key=${g.key} class="dn-tl__month"><h4>${g.m}</h4>
    <ol>${g.lines.map((x) => html`<${Line} key=${x.id} x=${x} staff=${staff} me=${me} org=${org} name=${name} now=${now} ctx=${ctx} onOpen=${onOpen} onChanged=${onChanged} />`)}</ol></li>`)}</ol>`;
}

const whenOf = (x) => (x.undated ? '' : x.year ? String(x.year) : x.kind === 'gift' || x.allDay ? shortDate(x.at) : html`${shortDate(x.at)}<span class="dn-tl__clock">${clock(x.at)}</span>`);

function Line({ x, staff, me, org, name, now, ctx, onOpen, onChanged }) {
  const dot = dotOf(x, now);
  const base = { class: 'dn-tl__item', 'data-line': x.id, 'data-kind': x.kind, 'data-day': x.undated ? null : dayOf(x.at) };
  const cell = (body, amt = null) => html`<li ...${base} data-gift=${x.gift?.id || null} data-gifts=${x.gift ? (x.gift.ids || [x.gift.id]).join(' ') : null}>
    <span class="dn-tl__when">${whenOf(x)}</span><span class=${`dn-tl__dot${dot ? ` dn-tl__dot--${dot}` : ''}`} aria-hidden="true"></span>
    <div class="dn-tl__body">${body}</div>${amt != null ? html`<span class="dn-tl__amt">${amt}</span>` : html`<span></span>`}</li>`;
  if (x.kind === 'gift') {
    const g = x.gift;
    const t = g.thanks;
    return cell(html`<span class="dn-tl__who">${g.sold ? 'A ticket or purchase' : g.inKind ? 'A gift in kind' : 'A gift'}${org && g.by ? ` from ${g.by}` : ''}</span>
      <span class="dn-tl__title">${g.campaign || 'A gift'}</span>
      <span class="dn-tl__meta">${giftMeta(g, org).filter((m) => !(org && m === `from ${g.by}`)).join(' · ')}
        ${t?.state === 'todo' ? html`<span class="tag dn-tag--thank">To thank</span>` : t?.state === 'thanked' ? html`<span>Thanked${t.by ? ` by ${first(t.by, staff)}` : ''}</span>` : t?.state === 'skipped' ? html`<span>No thank-you needed</span>` : null}</span>
      <span class="dn-tl__do"><a class="link" href=${zeffyPaymentUrl(g.id)} target="_blank" rel="noopener" aria-label=${`Open in Zeffy: ${g.campaign || 'gift'}, ${shortDate(x.at)}`}>Open in Zeffy</a>
        ${g.mercury ? html`<a class="link" href=${g.mercury} target="_blank" rel="noopener">See the check in Mercury</a>` : null}</span>`,
    g.inKind ? html`${usd(g.inKind)}<span class="dn-sub">in kind</span>` : g.sold || g.refunded ? '–' : usd(g.cents));
  }
  if (x.kind === 'note') return html`<${NoteLine} x=${x} base=${base} dot=${dot} staff=${staff} name=${name} ctx=${ctx} onChanged=${onChanged} />`;
  const opens = (x.kind === 'email' && x.thread) || x.kind === 'call' || x.kind === 'text' || (x.kind === 'kit' && x.sends?.length) || (x.kind === 'site' && x.emailId);
  // My own copy of it (each mailbox's conversation has its own id in Gmail)
  const mine = x.kind === 'email' && me ? x.copies?.[me] : null;
  const gmailLink = mine ? `https://mail.google.com/mail/?authuser=${encodeURIComponent(me)}#all/${encodeURIComponent(mine)}` : null;
  const meta = [];
  if (x.kind === 'call') { if (!x.missed && x.duration) meta.push(minutes(x.duration)); if (x.line) meta.push(x.line); if (x.voicemail) meta.push('voicemail'); if (x.ai) meta.push('answered by Quo’s AI'); }
  if (x.kind === 'text') meta.push(plural(x.count, 'text'));
  if (x.kind === 'meeting' && x.answer) meta.push(x.answer === 'yes' ? 'they said yes' : x.answer === 'no' ? 'they said no' : 'they said maybe');
  if (x.kind === 'site') meta.push(...[x.detail, x.status === 'bounced' ? 'bounced' : x.status === 'complained' ? 'marked as spam' : x.status === 'failed' ? 'didn’t send' : x.clicked ? 'opened and clicked' : x.opened ? 'opened' : x.status === 'delivered' ? 'delivered' : null].filter(Boolean));
  if (x.kind === 'email' && org && x.them?.length && x.dir !== 'in') meta.push(x.them.join(', '));
  if (x.kind === 'makeover' && x.draft) meta.push('page not published');
  // The words on the button that opens it in place (a screen reader hears them first, then which line)
  const openWords = x.kind === 'email' ? 'Read the conversation' : x.kind === 'call' ? 'Open the call' : x.kind === 'text' ? 'Read the texts' : x.kind === 'kit' ? (x.sends?.length > 1 ? 'See them' : 'See it') : 'See the email';
  const title = x.kind === 'call' ? (x.summary?.[0] || (x.missed ? 'No answer' : 'A call')) : x.kind === 'text' ? (x.detail || 'Texts') : x.title;
  const detail = x.kind === 'email' ? x.detail : x.kind === 'kit' ? (x.sends?.length > 1 ? x.sends.map((s) => `“${s.subject}”`).join(', ') : x.detail) : null;
  return cell(html`<span class="dn-tl__who">${whoLine(x, { staff, org })}</span>
    <span class="dn-tl__title">${title}</span>
    ${detail ? html`<p class="dn-tl__detail">${detail}</p>` : null}
    ${meta.length ? html`<span class="dn-tl__meta">${meta.join(' · ')}</span>` : null}
    ${opens || gmailLink || x.kind === 'makeover' ? html`<span class="dn-tl__do">
      ${opens ? html`<button type="button" class="link dn-linkbtn" aria-label=${`${openWords}: ${title}, ${shortDate(x.at)}`} onClick=${() => onOpen(x)}>${openWords}</button>` : null}
      ${gmailLink ? html`<a class="link" href=${gmailLink} target="_blank" rel="noopener">Open in Gmail</a>` : null}
      ${x.kind === 'makeover' && x.record ? html`<a class="link" href=${`#kids/${String(x.record).split('/').map(encodeURIComponent).join('/')}`}>Open the page</a>` : null}
    </span>` : null}`);
}

// ─── Notes ──────────────────────────────────────────────────────────

/** A new note, at the top of the timeline (⌘/Ctrl + Enter saves) */
function NoteBox({ subject, name, zeffy, ctx, onDone }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const box = useRef(null);
  const add = async (e) => {
    e?.preventDefault();
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    const r = await call('', { act: 'note-add', key: subject, body: t });
    setBusy(false);
    if (!r.success) { ctx.addToast(r.error, 'error'); return; }
    setText('');
    await onDone();
    box.current?.focus();
  };
  return html`<form class="dn-note-new" onSubmit=${add}>
    <textarea id="dn-note-text" aria-label=${`A note about ${name}`} ref=${box} class="form-input" rows="2" maxlength="4000" placeholder=${`A note about ${name}: a call, a visit, what they care about`} value=${text} readOnly=${busy} aria-busy=${busy ? 'true' : null}
      onInput=${(e) => setText(e.target.value)} onKeyDown=${(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); add(); } }}></textarea>
    <div class="dn-note-new__do"><span class="dn-sub">Only the team sees notes.${zeffy ? ' Notes written in Zeffy before stay there.' : ''}</span>
      <button type="submit" class="btn btn-primary btn-sm" disabled=${!text.trim()} aria-disabled=${busy ? 'true' : null}>Add note</button></div>
  </form>`;
}

/** A note on the timeline: anyone on the team can change or delete it */
function NoteLine({ x, base, dot, staff, name, ctx, onChanged }) {
  const n = x.note;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(n.body);
  const [busy, setBusy] = useState(false);
  const focusChange = (id) => requestAnimationFrame(() => (document.querySelector(`.dn-tl__item[data-line="${CSS.escape(id)}"] .dn-note__change`) || document.getElementById('dn-note-text'))?.focus());
  const stop = () => { setEditing(false); focusChange(x.id); };
  const save = async () => {
    const t = draft.trim();
    if (!t || busy) return;
    if (t === n.body) { stop(); return; }
    setBusy(true);
    const r = await call('', { act: 'note-edit', id: n.id, body: t });
    setBusy(false);
    if (!r.success) { ctx.addToast(r.error, 'error'); return; }
    setEditing(false);
    await onChanged();
    focusChange(x.id);
  };
  const del = async () => {
    if (busy || !(await ask({ title: 'Delete this note?', text: 'It’s gone for everyone, and can’t be brought back.', yes: 'Delete', danger: true }))) return;
    // The focus to the next note's Change, else the note box
    const notesNow = [...document.querySelectorAll('.dn-tl__item[data-kind="note"]')].map((el) => el.dataset.line);
    const i = notesNow.indexOf(x.id);
    const next = notesNow[i + 1] || notesNow[i - 1] || null;
    setBusy(true);
    const r = await call('', { act: 'note-delete', id: n.id });
    setBusy(false);
    if (!r.success) { ctx.addToast(r.error, 'error'); return; }
    ctx.addToast('Note deleted', 'success');
    await onChanged();
    focusChange(next);
  };
  const by = n.by ? nameOf(n.by, staff) : 'Someone';
  return html`<li ...${base}>
    <span class="dn-tl__when">${shortDate(x.at)}<span class="dn-tl__clock">${clock(x.at)}</span></span><span class=${`dn-tl__dot dn-tl__dot--${dot}`} aria-hidden="true"></span>
    <div class="dn-tl__body" data-note=${n.id}>
      <span class="dn-tl__who">${by} wrote a note</span>
      ${editing ? html`<textarea aria-label="Change the note" class="form-input" rows="3" maxlength="4000" value=${draft} readOnly=${busy} aria-busy=${busy ? 'true' : null} data-escape="local"
          onInput=${(e) => setDraft(e.target.value)} onKeyDown=${(e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); stop(); return; } if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); save(); } }}
          ref=${(el) => { if (el && !el.dataset.focused) { el.dataset.focused = '1'; el.focus(); } }}></textarea>
        <span class="dn-row-do"><button type="button" class="btn btn-primary btn-sm" disabled=${!draft.trim()} aria-disabled=${busy ? 'true' : null} onClick=${save}>Save</button>
          <button type="button" class="btn btn-ghost btn-sm" onClick=${() => { if (!busy) stop(); }}>Cancel</button></span>`
      : html`<p class="dn-tl__note dn-note__body">${n.body}</p>`}
      ${n.editedAt ? html`<span class="dn-tl__meta">changed${n.editedBy && n.editedBy !== n.by ? ` by ${first(n.editedBy, staff)}` : ''} ${shortDate(Date.parse(n.editedAt))}</span>` : null}
      ${editing ? null : html`<span class="dn-tl__do"><button type="button" class="link dn-linkbtn dn-note__change" onClick=${() => { if (!busy) { setDraft(n.body); setEditing(true); } }}>Change</button>
        <button type="button" class="link dn-linkbtn" onClick=${del}>Delete</button></span>`}
    </div><span></span></li>`;
}

// ─── At a glance ────────────────────────────────────────────────────

const RANGES = [['year', '12 months', 365], ['three', '3 years', 3 * 365], ['all', 'All', null]];

/** The year in a sentence: gifts, email, calls, meetings, newsletters opened */
export function yearSaid(lines, kit, now = Date.now()) {
  const since = now - 365 * DAY;
  const year = lines.filter((x) => x.at >= since && !x.undated);
  const n = (kinds) => year.filter((x) => kinds.includes(x.kind));
  const gifts = n(['gift']).filter((x) => !x.gift?.sold && !x.gift?.refunded);
  const cents = gifts.reduce((t, x) => t + (Number(x.gift.cents) || 0), 0);
  const mail = n(['email']);
  const phone = n(['call', 'text']);
  const meet = n(['meeting']);
  const parts = [
    gifts.length ? `${plural(gifts.length, 'gift')} (${usd(cents)})` : 'no gifts',
    mail.length ? `${plural(mail.length, 'email')} with the team, the last ${shortDate(Math.max(...mail.map((x) => x.at)))}` : null,
    phone.length ? `${plural(n(['call']).length, 'call')} and ${plural(n(['text']).reduce((t, x) => t + (x.count || 1), 0), 'text')}` : null,
    meet.length ? plural(meet.length, 'meeting') : null,
    kit && kit.sent ? `opened ${kit.opened} of ${plural(kit.sent, 'newsletter')}` : null,
  ].filter(Boolean);
  return `In the last 12 months: ${parts.join(', ')}.`;
}

function Glance({ lines, kit, onDay }) {
  const [range, setRange] = useState('year');
  const [at, setAt] = useState(null);
  // What a screen reader hears: only a day reached by the arrow keys (pointing never speaks)
  const [spoken, setSpoken] = useState('');
  const [W, setW] = useState(600);
  const wrap = useRef(null);
  // Drawn in the chart's own pixels, so marks stay square and the dates readable at any width
  useEffect(() => {
    const el = wrap.current;
    if (!el) return undefined;
    const fit = () => setW(Math.max(160, Math.round(el.clientWidth)));
    fit();
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(fit) : null;
    ro?.observe(el);
    return () => ro?.disconnect();
  }, []);
  const now = Date.now();
  const dated = lines.filter((x) => !x.undated && x.at > 0 && LANE_OF[x.kind] != null);
  const oldest = dated.length ? Math.min(...dated.map((x) => x.at)) : now - 365 * DAY;
  const days = RANGES.find((r) => r[0] === range)[2];
  const from = days ? now - days * DAY : Math.min(oldest, now - 365 * DAY);
  const span = Math.max(DAY, now - from);
  const LANE_H = 20;
  const H = LANES.length * LANE_H + 16;
  // Each day with something on it: per lane, how many, and for gifts how much
  const byDay = new Map();
  for (const x of dated) {
    if (x.at < from) continue;
    const d = dayOf(x.at);
    const e = byDay.get(d) || { day: d, at: x.at, lanes: LANES.map(() => ({ n: 0, cents: 0 })) };
    const lane = e.lanes[LANE_OF[x.kind]];
    lane.n++;
    if (x.kind === 'gift') lane.cents += Number(x.gift?.cents) || 0;
    byDay.set(d, e);
  }
  const marked = [...byDay.values()].sort((a, b) => a.at - b.at);
  const xOf = (t) => Math.round(((t - from) / span) * (W - 10)) + 5;
  const maxCents = Math.max(1, ...marked.map((e) => e.lanes[0].cents));
  // A gift's mark grows with its size (by area); the others with how many that day
  const half = (i, l) => (i === 0 ? 3 + Math.round(4 * Math.sqrt(l.cents / maxCents)) : Math.min(7, 2 + l.n));
  const said = (e) => `${longDate(e.at)}: ${LANES.map(([, words], i) => (e.lanes[i].n ? `${e.lanes[i].n} ${i === 0 ? (e.lanes[i].n === 1 ? 'gift' : 'gifts') : words.toLowerCase()}` : null)).filter(Boolean).join(', ')}`;
  const ticks = [];
  if (days && days <= 366) {
    const d = new Date(from);
    d.setDate(1);
    for (let i = 0; i < 13; i++) { d.setMonth(d.getMonth() + 1); if (d.getTime() < now) ticks.push({ t: d.getTime(), label: d.toLocaleDateString('en-US', { month: 'short' }) }); }
  } else {
    for (let y = new Date(from).getFullYear() + 1; y <= new Date(now).getFullYear(); y++) ticks.push({ t: new Date(y, 0, 1).getTime(), label: String(y) });
  }
  // Labels a narrow chart has no room for are left out (every other one, then every third…)
  const every = Math.max(1, Math.ceil((ticks.length * 34) / W));
  const nearest = (clientX) => {
    const r = wrap.current?.getBoundingClientRect();
    if (!r || !marked.length) return null;
    const px = clientX - r.left;
    let best = null;
    for (const e of marked) if (!best || Math.abs(xOf(e.at) - px) < Math.abs(xOf(best.at) - px)) best = e;
    return best && Math.abs(xOf(best.at) - px) <= 14 ? best : null;
  };
  const key = (e) => {
    if (!marked.length) return;
    const i = at ? marked.findIndex((m) => m.day === at.day) : -1;
    const go = (j) => { e.preventDefault(); const d = marked[Math.max(0, Math.min(marked.length - 1, j))]; setAt(d); setSpoken(said(d)); };
    if (e.key === 'ArrowRight') go(i < 0 ? marked.length - 1 : i + 1);
    else if (e.key === 'ArrowLeft') go(i < 0 ? marked.length - 1 : i - 1);
    else if (e.key === 'Home') go(0);
    else if (e.key === 'End') go(marked.length - 1);
    else if (e.key === 'Enter' && at) { e.preventDefault(); onDay(at.day); }
  };
  return html`<div class="dn-gl">
    <div class="dn-gl__top"><strong>At a glance</strong>
      <div class="mm-seg" role="group" aria-label="How far back">${RANGES.map(([k, words]) => html`<button key=${k} type="button" aria-pressed=${String(range === k)} onClick=${() => { setRange(k); setAt(null); }}>${words}</button>`)}</div></div>
    <p class="dn-gl__said">${yearSaid(lines, kit, now)}</p>
    <div class="dn-gl__chart">
      <ul class="dn-gl__lanes" aria-hidden="true">${LANES.map(([k, words]) => html`<li key=${k}>${words}</li>`)}</ul>
      <div ref=${wrap} style="min-width:0">
        <svg class="dn-gl__svg" width=${W} height=${H} viewBox=${`0 0 ${W} ${H}`} tabindex="0" role="group"
          aria-label=${`At a glance: ${plural(marked.length, 'day')} with something on them${range === 'all' ? '' : ` in the last ${RANGES.find((r) => r[0] === range)[1]}`}. The left and right arrows move between them; Enter shows one in the list.`}
          onKeyDown=${key} onPointerMove=${(e) => { const n = nearest(e.clientX); if (n) setAt(n); }} onClick=${(e) => { const n = nearest(e.clientX); if (n) { setAt(n); onDay(n.day); } }}>
          ${LANES.map((_, i) => html`<line key=${`l${i}`} x1="0" x2=${W} y1=${i * LANE_H + LANE_H / 2} y2=${i * LANE_H + LANE_H / 2} stroke="var(--color-border)" stroke-width="1" />`)}
          ${ticks.map((t, j) => html`<g key=${t.t}><line x1=${xOf(t.t)} x2=${xOf(t.t)} y1="0" y2=${LANES.length * LANE_H} stroke="var(--color-border)" stroke-dasharray="2 3" />
            ${j % every === 0 ? html`<text x=${xOf(t.t) + 3} y=${H - 3} fill="var(--color-text-muted)" style="font-size:10px">${t.label}</text>` : null}</g>`)}
          ${at ? html`<rect x=${xOf(at.at) - 6} y="0" width="12" height=${LANES.length * LANE_H} rx="3" fill="var(--tone-warn-bg)" />` : null}
          ${marked.flatMap((e) => e.lanes.map((l, i) => (!l.n ? null : html`<rect key=${`${e.day}:${i}`} x=${xOf(e.at) - (i === 0 ? half(i, l) : 2)} y=${i * LANE_H + LANE_H / 2 - half(i, l)}
            width=${i === 0 ? 2 * half(i, l) : 4} height=${2 * half(i, l)} rx="2"
            fill=${i === 0 ? 'var(--tone-success-dot)' : i === 4 ? 'var(--color-text-secondary)' : 'var(--tone-info-dot)'} />`)))}
        </svg>
      </div>
    </div>
    <span class="sr-only" aria-live="polite">${spoken}</span>
    <p class="dn-gl__day">${at ? html`${said(at)}<button type="button" class="link dn-linkbtn" onClick=${() => onDay(at.day)}>Show in the list</button>` : html`<span class="dn-sub">Point at a day, or tap it, to see what happened.</span>`}</p>
  </div>`;
}

// ─── What opens in place ────────────────────────────────────────────

function Sheet({ title, sub, onClose, children }) {
  const box = useRef(null);
  useDialog(box, onClose);
  return html`<div class="mm-sheet-wrap dn-tl-sheet" onClick=${(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div class="mm-sheet" role="dialog" aria-modal="true" aria-labelledby="dn-tl-sheet-h" tabindex="-1" ref=${box}>
      <div class="mm-sheet-head"><div><h3 id="dn-tl-sheet-h">${title}</h3>${sub ? html`<p>${sub}</p>` : null}</div>
        <button type="button" class="mm-sheet-x" aria-label="Close" onClick=${onClose}>×</button></div>
      <div class="dn-tl-sheet__body">${children}</div>
    </div></div>`;
}

function useRead(params) {
  const [v, setV] = useState(null);
  useEffect(() => { let live = true; call(params).then((j) => { if (live) setV(j); }); return () => { live = false; }; }, [params]);
  return v;
}

function OpenSheet({ x, refOf, staff, name, onClose }) {
  if (x.kind === 'email') return html`<${MailSheet} x=${x} refOf=${refOf} staff=${staff} name=${name} onClose=${onClose} />`;
  if (x.kind === 'call') return html`<${CallSheet} x=${x} refOf=${refOf} name=${name} onClose=${onClose} />`;
  if (x.kind === 'text') return html`<${Sheet} title=${whoLine(x, { staff })} sub=${longDate(x.at)} onClose=${onClose}>
    ${x.messages.map((m, i) => html`<div key=${i} class=${`dn-tl-msg ${m.dir === 'in' ? 'dn-tl-msg--theirs' : 'dn-tl-msg--ours'}`}>
      <div class="dn-tl-msg__head"><strong>${m.dir === 'in' ? name : m.by || 'SOARD'}</strong><span>${clock(m.at)}</span></div>
      <p class="dn-tl-msg__text">${m.text || (m.media ? 'A picture' : '')}</p>${m.media && m.text ? html`<p class="dn-tl-msg__files">With ${plural(m.media, 'picture')} (in Quo)</p>` : null}</div>`)}
  <//>`;
  if (x.kind === 'kit') return html`<${Sheet} title=${x.sends.length > 1 ? `${x.sends.length} newsletters` : 'A newsletter'} sub=${monthOf(x.at)} onClose=${onClose}>
    <ul class="dn-tl-sheet__plain">${x.sends.map((s) => html`<li key=${s.id}><strong>${s.subject}</strong><span class="dn-sub">${longDate(s.at)}${s.url ? html` · <a class="link" href=${s.url} target="_blank" rel="noopener">Read it</a>` : ''}</span></li>`)}</ul>
    <p class="dn-sub">Kit sent these to everyone on the list, or to a tag they had, while they were on it. Kit counts opens for the year, not for each email.</p>
  <//>`;
  if (x.kind === 'site') return html`<${SentSheet} x=${x} refOf=${refOf} onClose=${onClose} />`;
  return null;
}

function MailSheet({ x, refOf, staff, name, onClose }) {
  const v = useRead(`?${new URLSearchParams({ timeline: refOf, mailbox: x.mailbox, thread: x.thread })}`);
  return html`<${Sheet} title=${x.title} sub=${`In ${nameOf(x.mailbox, staff)}’s mailbox · only the team sees this`} onClose=${onClose}>
    ${!v ? html`<div class="dn-tl__skel" aria-hidden="true"><span class="skel" style="--w:80%"></span><span class="skel" style="--w:60%"></span></div>`
      : !v.success ? html`<div class="notice notice--warn"><div class="notice__body">${v.error}</div></div>`
      : html`${v.messages.map((m) => html`<div key=${m.id} class=${`dn-tl-msg ${m.theirs ? 'dn-tl-msg--theirs' : 'dn-tl-msg--ours'}`}>
          <div class="dn-tl-msg__head"><strong>${m.from || (m.theirs ? name : 'SOARD')}</strong><span>${shortDate(m.at)}, ${clock(m.at)}</span></div>
          <p class="dn-tl-msg__text">${m.text || '(No words: an email of pictures or files)'}</p>
          ${m.files.length ? html`<p class="dn-tl-msg__files">With ${m.files.map((f) => f.name).join(', ')}</p>` : null}</div>`)}
        ${v.hidden ? html`<p class="dn-sub">${plural(v.hidden, 'more email')} in this conversation ${v.hidden === 1 ? 'doesn’t' : 'don’t'} include ${name}, so ${v.hidden === 1 ? 'it isn’t' : 'they aren’t'} shown here.</p>` : null}`}
  <//>`;
}

function CallSheet({ x, refOf, name, onClose }) {
  const [t, setT] = useState(null);
  const getWords = async () => { setT('reading'); const j = await call(`?${new URLSearchParams({ timeline: refOf, call: x.callId })}`); setT(j); };
  return html`<${Sheet} title=${whoLine(x, {})} sub=${`${longDate(x.at)}, ${clock(x.at)}${x.duration && !x.missed ? ` · ${minutes(x.duration)}` : ''}${x.line ? ` · ${x.line}` : ''}`} onClose=${onClose}>
    ${x.summary?.length ? html`<div><h4>What it was about (Quo’s summary)</h4><ul class="dn-tl-sheet__list">${x.summary.map((s, i) => html`<li key=${i}>${s}</li>`)}</ul></div>` : null}
    ${x.nextSteps?.length ? html`<div><h4>Next steps</h4><ul class="dn-tl-sheet__list">${x.nextSteps.map((s, i) => html`<li key=${i}>${s}</li>`)}</ul></div>` : null}
    ${x.voicemail ? html`<div><h4>Voicemail${x.voicemail.duration ? ` (${minutes(x.voicemail.duration)})` : ''}</h4><p class="dn-tl-msg__text">${x.voicemail.transcript || 'No words for it yet.'}</p></div>` : null}
    ${x.missed ? null : !t ? html`<p><button type="button" class="btn btn-ghost btn-sm" onClick=${getWords}>Read the whole call</button></p>`
      : t === 'reading' ? html`<div class="dn-tl__skel" aria-hidden="true"><span class="skel" style="--w:80%"></span></div>`
      : !t.success ? html`<div class="notice notice--warn"><div class="notice__body">${t.error}</div></div>`
      : !t.dialogue.length ? html`<p class="dn-sub">${t.status === 'in-progress' ? 'Quo is still writing it out.' : 'Quo has no words for this call (it wasn’t recorded).'}</p>`
      : t.dialogue.map((d, i) => html`<div key=${i} class=${`dn-tl-msg ${d.theirs ? 'dn-tl-msg--theirs' : 'dn-tl-msg--ours'}`}><div class="dn-tl-msg__head"><strong>${d.theirs ? name : d.who}</strong></div><p class="dn-tl-msg__text">${d.text}</p></div>`)}
  <//>`;
}

function SentSheet({ x, refOf, onClose }) {
  const v = useRead(`?${new URLSearchParams({ timeline: refOf, sent: x.emailId })}`);
  return html`<${Sheet} title=${x.title} sub=${`${longDate(x.at)}, ${clock(x.at)} · from the website`} onClose=${onClose}>
    ${!v ? html`<div class="dn-tl__skel" aria-hidden="true"><span class="skel" style="--w:80%"></span></div>`
      : !v.success ? html`<div class="notice notice--warn"><div class="notice__body">${v.error}</div></div>`
      : v.gone ? html`<p class="dn-sub">${v.why}.</p>`
      : html`<${EmailFrame} doc=${v.html} phone=${false} title=${x.title} />`}
  <//>`;
}
