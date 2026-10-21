/**
 * Admin → Press (loaded on first visit, like ./site-config.js)
 * ===========================================================================
 * Three tabs, each a link of its own:
 *   #press            Stories: the featured ones in the publicity page's order
 *                     (drag, or move with the keyboard), then every story by
 *                     year, each with what it still needs. Add a story by
 *                     pasting its link: the page is read for its headline,
 *                     outlet, date, picture, summary, kids and partners.
 *   #press/<slug>     The story editor: History, merge when someone saved
 *                     meanwhile, the real page as a Preview, ⌘S.
 *   #press/found      What the press monitor (functions/api/_press.js) found
 *                     and did: articles that need a look, the ones it added,
 *                     every change it made (each can be undone), and what it
 *                     searches for.
 *   #press/outlets    Every outlet that covered SOARD: the "As Featured"
 *                     strip's order, outlets that look like one outlet, and
 *                     each outlet's logo, other spellings and websites.
 * The rules (outlets, duplicates, what a story needs) are ./press-shared.js,
 * the same file the server and the tests use.
 */

import { h, htm, useState, useEffect, useRef, useMemo, Sortable } from './vendor.js';
import * as PS from './press-shared.js';

const html = htm.bind(h);
const CF = `/cdn-cgi/imagedelivery/${PS.CF_HASH}`;
const MOD = /Mac|iPhone|iPad/.test(navigator.platform || '') ? '⌘' : 'Ctrl+';
const PATH = (slug) => `src/content/press/${slug}.json`;

// ─── Small helpers ─────────────────────────────────────────────────
async function call(path, body) {
  let r;
  try {
    r = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' });
  } catch {
    return { success: false, error: 'No connection. Check your internet and try again.' };
  }
  let j = {};
  try { j = await r.json(); } catch { j = { success: false, error: /cloudflareaccess/i.test(r.url || '') ? 'Your admin session expired. Reload the page and sign in again.' : `HTTP ${r.status}` }; }
  if (!r.ok && j.success !== false) j.success = false;
  j.status = r.status;
  return j;
}
const parseContent = (r) => (typeof r.content === 'string' ? JSON.parse(r.content) : r.content);
const isoOf = (s) => (s ? (/Z$|[+-]\d\d:?\d\d$/.test(s) ? s : `${String(s).replace(' ', 'T')}Z`) : null);
function ago(s) {
  const t = Date.parse(isoOf(s));
  if (!Number.isFinite(t)) return '';
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  if (m < 60 * 24) return `${Math.round(m / 60)} hr ago`;
  const d = Math.round(m / 1440);
  if (d < 14) return d === 1 ? 'yesterday' : `${d} days ago`;
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}
const longDate = (d) => { const t = Date.parse(`${d}T12:00:00Z`); return Number.isFinite(t) ? new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }) : ''; };
const plural = (n, one, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const personName = (email) => {
  const s = String(email || '');
  if (!s.includes('@')) return s || 'Someone';
  return s.split('@')[0].split(/[._+-]+/).filter(Boolean).map((w) => w[0].toUpperCase() + w.slice(1)).join(' ');
};
const prefersReducedMotion = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };
function useNarrow(q = '(max-width: 900px)') {
  const [m, setM] = useState(() => { try { return matchMedia(q).matches; } catch { return false; } });
  useEffect(() => {
    let mq;
    try { mq = matchMedia(q); } catch { return undefined; }
    const on = () => setM(mq.matches);
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, []);
  return m;
}
let uid = 0;
const useId = (p = 'pr') => { const r = useRef(null); if (!r.current) r.current = `${p}-${++uid}`; return r.current; };
/** Sortable moved a node; put it back (Preact draws the new order) and return the new order */
function undoSortableMove(e, order) {
  const parent = e.from;
  parent.removeChild(e.item);
  parent.insertBefore(e.item, parent.children[e.oldIndex] || null);
  const next = [...order];
  const [moved] = next.splice(e.oldIndex, 1);
  next.splice(e.newIndex, 0, moved);
  return next;
}
const initials = (name) => PS.plain(name).replace(/\([^)]*\)/g, '').split(/[\s/&-]+/).filter((w) => w && !/^(the|of|and|a|news|com)$/i.test(w)).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';

// ─── Icons (24px grid, stroked) ────────────────────────────────────
const ICONS = {
  plus: html`<path d="M12 5v14M5 12h14" />`,
  link: html`<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" /><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />`,
  ext: html`<path d="M15 3h6v6" /><path d="M10 14 21 3" /><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />`,
  star: html`<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9z" />`,
  grip: html`<circle cx="9" cy="6" r="1.4" fill="currentColor" stroke="none" /><circle cx="15" cy="6" r="1.4" fill="currentColor" stroke="none" /><circle cx="9" cy="12" r="1.4" fill="currentColor" stroke="none" /><circle cx="15" cy="12" r="1.4" fill="currentColor" stroke="none" /><circle cx="9" cy="18" r="1.4" fill="currentColor" stroke="none" /><circle cx="15" cy="18" r="1.4" fill="currentColor" stroke="none" />`,
  up: html`<path d="m18 15-6-6-6 6" />`,
  down: html`<path d="m6 9 6 6 6-6" />`,
  back: html`<path d="m15 18-6-6 6-6" />`,
  search: html`<circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" />`,
  x: html`<path d="M18 6 6 18M6 6l12 12" />`,
  check: html`<path d="M20 6 9 17l-5-5" />`,
  undo: html`<path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />`,
  history: html`<path d="M3 3v5h5" /><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8" /><path d="M12 7v5l4 2" />`,
  trash: html`<path d="M3 6h18" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />`,
  eye: html`<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" />`,
  play: html`<path d="M8 5v14l11-7z" fill="currentColor" stroke="none" />`,
  image: html`<rect x="3" y="3" width="18" height="18" rx="2" /><circle cx="9" cy="9" r="2" /><path d="m21 15-3.1-3.1a2 2 0 0 0-2.8 0L6 21" />`,
  spark: html`<path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M5.6 18.4l2.8-2.8M15.6 8.4l2.8-2.8" />`,
  radar: html`<path d="M19.07 4.93A10 10 0 0 0 6.99 3.34" /><path d="M4 6h.01" /><path d="M2.29 9.62A10 10 0 1 0 21.31 8.35" /><path d="M16.24 7.76A6 6 0 1 0 8.23 16.67" /><path d="M12 18h.01" /><path d="M17.99 11.66A6 6 0 0 1 15.77 16.67" /><circle cx="12" cy="12" r="2" /><path d="m13.41 10.59 5.66-5.66" />`,
  merge: html`<circle cx="18" cy="18" r="3" /><circle cx="6" cy="6" r="3" /><path d="M6 21V9a9 9 0 0 0 9 9" />`,
  warn: html`<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" /><path d="M12 9v4M12 17h.01" />`,
};
const Icon = ({ name, size = 16, label = null }) => html`<svg width=${size} height=${size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden=${label ? null : 'true'} role=${label ? 'img' : null} aria-label=${label}>${ICONS[name]}</svg>`;

// ─── Pictures ──────────────────────────────────────────────────────
const cfImg = (src, t) => { const id = PS.cfId(src); return id ? `${CF}/${id}/${t}` : ''; };
/**
 * What the story's card would show: its picture, its video, its outlet's logo,
 * or the outlet's name. In the list (`kid`), a story with no picture of its own
 * shows the room of the kid it's about instead of a logo.
 */
function StoryThumb({ story, outlet, w = 112, h = 72, className = '', kid = null }) {
  const [broken, setBroken] = useState(false);
  const yt = PS.youTubeId(story.videoId);
  const kidId = kid ? PS.kidPhoto(kid) : '';
  const src = !broken && story.image ? cfImg(story.image, `w=${w * 2},h=${h * 2},fit=cover,q=75`) : !broken && yt ? `https://i.ytimg.com/vi/${yt}/mqdefault.jpg` : !broken && kidId ? cfImg(kidId, `w=${w * 2},h=${h * 2},fit=cover,q=70`) : null;
  if (src) return html`<span class=${`pr-thumb ${className}`} style=${`--w:${w}px;--h:${h}px`}><img src=${src} alt="" loading="lazy" onError=${() => setBroken(true)} />${yt && !story.image ? html`<span class="pr-thumb__play"><${Icon} name="play" size=${12} /></span>` : null}</span>`;
  if (outlet?.logo) return html`<span class=${`pr-thumb pr-thumb--logo ${className}`} style=${`--w:${w}px;--h:${h}px`}><img src=${cfImg(outlet.logo, `w=${w * 2},h=${h * 2},fit=contain,q=80`)} alt="" loading="lazy" /></span>`;
  return html`<span class=${`pr-thumb pr-thumb--text ${className}`} style=${`--w:${w}px;--h:${h}px`} aria-hidden="true">${initials(outlet?.name || story.outlet)}</span>`;
}
/** A kid's face, from the photo their page leads with */
function KidFace({ kid, size = 22 }) {
  const [broken, setBroken] = useState(false);
  const id = PS.kidPhoto(kid);
  return id && !broken
    ? html`<img class="pr-face" src=${cfImg(id, `w=${size * 2},h=${size * 2},fit=cover,gravity=face,q=70`)} alt="" width=${size} height=${size} loading="lazy" style=${`--s:${size}px`} onError=${() => setBroken(true)} />`
    : html`<span class="pr-face pr-face--text" style=${`--s:${size}px`} aria-hidden="true">${initials(kid?.name)}</span>`;
}
function OutletMark({ outlet, size = 40 }) {
  return outlet?.logo
    ? html`<span class="pr-omark" style=${`--s:${size}px`}><img src=${cfImg(outlet.logo, `w=${size * 4},h=${size * 2},fit=contain,q=80`)} alt="" loading="lazy" /></span>`
    : html`<span class="pr-omark pr-omark--text" style=${`--s:${size}px`} aria-hidden="true">${initials(outlet?.name)}</span>`;
}

// ═══════════════════════════════════════════════════════════════════
// The area
// ═══════════════════════════════════════════════════════════════════
const readHash = () => {
  const m = location.hash.match(/^#press(?:\/([^?]*))?/);
  if (!m) return null;
  const rest = decodeURIComponent(m[1] || '');
  if (!rest) return { tab: 'stories' };
  if (rest === 'found' || rest === 'outlets') return { tab: rest };
  if (rest === 'new') return { tab: 'stories', slug: '' };
  return { tab: 'stories', slug: rest };
};
const hashFor = ({ tab, slug }) => (slug != null && tab === 'stories' ? `#press/${slug || 'new'}` : tab === 'stories' ? '#press' : `#press/${tab}`);

export function PressArea({ addToast = () => {}, setGlobalDirty = null, press = [], outlets = [], kids = [], partners = [], onReload = () => {}, initialTab = null, initialSlug = null, kit = {} }) {
  injectStyles();
  const [route, setRoute] = useState(() => readHash() || { tab: ({ found: 'found', 'press-monitor': 'found', outlets: 'outlets', medialogos: 'outlets' })[initialTab] || 'stories', slug: initialSlug ?? undefined });
  const [ov, setOv] = useState(null);       // /api/press-admin: monitor state, found articles, link health, changes
  const [ovError, setOvError] = useState(null);
  const [adding, setAdding] = useState(false);
  const editorDirty = useRef(false);

  const loadOv = async () => {
    const j = await call('/api/press-admin');
    if (j.success) { setOv(j); setOvError(null); window.dispatchEvent(new CustomEvent('soard-press-changed')); } else setOvError(j.error || 'Couldn’t read the press monitor');
  };
  useEffect(() => { loadOv(); const t = setInterval(() => { if (!document.hidden) loadOv(); }, 90000); return () => clearInterval(t); }, []);
  useEffect(() => { history.replaceState?.(null, '', hashFor(route)); }, []);
  useEffect(() => {
    const on = () => { const r = readHash(); if (r) setRoute(r); };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  // The command palette and the Dashboard ask for a tab or a story
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    const tab = ({ found: 'found', 'press-monitor': 'found', outlets: 'outlets', medialogos: 'outlets', press: 'stories' })[initialTab] || 'stories';
    go({ tab, slug: initialSlug ?? undefined });
  }, [initialTab, initialSlug]);

  const go = (r) => {
    if (editorDirty.current && route.slug !== undefined && r.slug !== route.slug && !confirm('You have unsaved changes to this story. Leave without saving?')) return;
    editorDirty.current = false;
    setGlobalDirty?.(false);
    const next = { tab: r.tab || 'stories', ...(r.slug !== undefined ? { slug: r.slug } : {}) };
    setRoute(next);
    history.replaceState?.(null, '', hashFor(next));
    requestAnimationFrame(() => (document.querySelector('.main') || document.scrollingElement)?.scrollTo?.({ top: 0 }));
  };

  const outletBySlug = useMemo(() => new Map(outlets.map((o) => [o.slug, o])), [outlets]);
  const kidBySlug = useMemo(() => new Map(kids.map((k) => [k.slug, k])), [kids]);
  const partnerBySlug = useMemo(() => new Map(partners.map((p) => [p.slug, p])), [partners]);
  const links = ov?.links || {};
  const dupes = useMemo(() => {
    const m = new Map();
    for (const g of PS.duplicateGroups(press)) for (const s of g) m.set(s, g.filter((x) => x !== s));
    return m;
  }, [press]);
  const issuesOf = (s) => PS.storyIssues(s, { outletBySlug, link: links[s.slug] ? { status: links[s.slug].status, archive_url: links[s.slug].archiveUrl } : null, dupes: dupes.get(s.slug) || [] });
  const reviewCount = (ov?.mentions || []).filter((m) => m.state === 'review').length;
  const ctx = { addToast, outlets, outletBySlug, kidBySlug, partnerBySlug, press, kids, partners, links, ov, loadOv, onReload, issuesOf, go, kit, dupes, setGlobalDirty };

  if (route.slug !== undefined && route.tab === 'stories' && route.slug !== '') {
    return html`<div class="pr-root"><${StoryEditor} key=${route.slug} slug=${route.slug} c=${ctx} onDirty=${(d) => { editorDirty.current = d; }} onBack=${() => go({ tab: 'stories' })} /></div>`;
  }
  const tab = route.tab;
  const tabBtn = (id, label, n, badge = 0) => html`<button type="button" role="tab" aria-selected=${tab === id} class=${`hub-tab ${tab === id ? 'active' : ''}`} onClick=${() => go({ tab: id })}>
    ${label}${n != null ? html`<span class="ppl-tab-count">${n}</span>` : null}${badge ? html`<span class="pr-tab-badge" aria-label=${`${badge} need a look`}>${badge}</span>` : null}</button>`;
  return html`
    <div class="pr-root">
      <div class="hub-tabs" role="tablist" aria-label="Press">
        ${tabBtn('stories', 'Stories', press.length)}
        ${tabBtn('found', 'Found coverage', null, reviewCount)}
        ${tabBtn('outlets', 'Outlets', outlets.length)}
      </div>
      ${tab === 'found' ? html`<${FoundView} c=${ctx} error=${ovError} />`
        : tab === 'outlets' ? html`<${OutletsView} c=${ctx} initialOpen=${route.slug} />`
        : html`<${StoriesView} c=${ctx} onAdd=${() => setAdding(true)} />`}
      ${adding || (route.slug === '' && tab === 'stories') ? html`<${AddStoryDialog} c=${ctx} onClose=${() => { setAdding(false); if (route.slug === '') go({ tab: 'stories' }); }} />` : null}
    </div>`;
}

// ═══════════════════════════════════════════════════════════════════
// Stories
// ═══════════════════════════════════════════════════════════════════
const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'attention', label: 'Needs attention' },
  { id: 'featured', label: 'Featured' },
  { id: 'kids', label: 'About a kid' },
  { id: 'nopicture', label: 'No picture' },
  { id: 'monitor', label: 'Added by the monitor' },
  { id: 'drafts', label: 'Drafts' },
];
const kidsOf = (s, c) => (s.kids || []).map((k) => c.kidBySlug.get(k)).filter(Boolean);
const hasPicture = (s) => !!(s.image || PS.youTubeId(s.videoId));

/**
 * Where things stand, in answer to "does anything need me?": what's waiting
 * for a person, which stories are linked to kids (they show on the kid's
 * page), how many have a picture, and what the monitor is doing.
 */
function StatusPanel({ c, attention, onFilter }) {
  const st = c.ov?.state;
  const review = (c.ov?.mentions || []).filter((m) => m.state === 'review').length;
  const total = c.press.length;
  const aboutKids = c.press.filter((s) => kidsOf(s, c).length);
  const kidList = [...new Map(aboutKids.flatMap((s) => kidsOf(s, c)).map((k) => [k.slug, k])).values()];
  const withPartners = c.press.filter((s) => (s.partners || []).length).length;
  const pictured = c.press.filter(hasPicture).length;
  const tidying = !!st && (st.tidy?.version || 0) < st.tidyVersion;
  const checked = Object.values(c.links).filter((l) => l.enrichedAt).length;
  const second = tidying && (st.tidy?.round || 0) > 1;
  const scans = Object.values(st?.scans || {}).map((x) => x?.at).filter(Boolean).sort();
  const last = scans[scans.length - 1];
  const needs = review + attention;
  const faces = kidList.slice(0, 9);
  return html`<section class="card pr-status" aria-label="Where things stand">
    <div class="pr-status__grid">
      <div class=${`pr-stat${needs ? ' is-warn' : ' is-ok'}`}>
        <p class="pr-stat__label">Needs you</p>
        <p class="pr-stat__big">${needs ? html`<${Icon} name="warn" size=${18} /> ${plural(needs, 'thing')}` : html`<${Icon} name="check" size=${18} /> Nothing`}</p>
        <p class="pr-stat__sub">${needs ? 'Everything else runs by itself.' : 'Nothing is waiting for a person. New coverage is found, checked and added by itself.'}</p>
        ${needs ? html`<div class="pr-stat__acts">
          ${review ? html`<button type="button" class="btn btn-primary btn-sm" onClick=${() => c.go({ tab: 'found' })}>${plural(review, 'found article')} to check</button>` : null}
          ${attention ? html`<button type="button" class="btn btn-ghost btn-sm" onClick=${() => onFilter('attention')}>${plural(attention, 'story', 'stories')} to fix</button>` : null}
        </div>` : null}
      </div>
      <button type="button" class="pr-stat pr-stat--btn" onClick=${() => onFilter('kids')} aria-label=${`${aboutKids.length} stories are about ${kidList.length} kids. Show them`}>
        <p class="pr-stat__label">About a kid</p>
        <p class="pr-stat__big">${plural(aboutKids.length, 'story', 'stories')}</p>
        ${faces.length ? html`<span class="pr-faces" aria-hidden="true">${faces.map((k) => html`<${KidFace} key=${k.slug} kid=${k} size=${28} />`)}${kidList.length > faces.length ? html`<span class="pr-face pr-face--more" style="--s:28px">+${kidList.length - faces.length}</span>` : null}</span>` : null}
        <p class="pr-stat__sub">${plural(kidList.length, 'kid')}. Each story shows on that kid’s page${withPartners ? `; ${withPartners} also name a partner` : ''}.</p>
      </button>
      <button type="button" class="pr-stat pr-stat--btn" onClick=${() => onFilter('nopicture')} aria-label=${`${pictured} of ${total} stories have a picture. Show the ones without`}>
        <p class="pr-stat__label">Pictures</p>
        <p class="pr-stat__big">${pictured} <span class="pr-stat__of">of ${total}</span></p>
        <span class="pr-meter" aria-hidden="true"><span style=${`width:${total ? Math.round((pictured / total) * 100) : 0}%`}></span></span>
        <p class="pr-stat__sub">${second && st.tidy?.phase === 'stories' ? `The monitor is looking at every story again for its picture and who it’s about: ${Math.min(checked, total)} of ${total} done.`
          : second ? 'The monitor is about to look at every story again for its picture and who it’s about.'
          : pictured < total ? 'Without one, the list shows the kid’s room or the outlet’s logo.' : 'Every story has one.'}</p>
      </button>
    </div>
    <button type="button" class="pr-status__foot" onClick=${() => c.go({ tab: 'found' })}>
      <span class="pr-monitor__dot" aria-hidden="true"></span>
      <span>${tidying && !second ? html`<strong>Tidying the list.</strong> ${st.tidy?.phase === 'stories' ? `${Math.min(checked, total)} of ${total} stories checked.` : ''}` : last ? `The monitor last looked for new coverage ${ago(last)}.` : 'The monitor starts looking for coverage within the hour.'}</span>
      <span class="pr-monitor__go">See what it found</span>
    </button>
  </section>`;
}

function StoriesView({ c, onAdd }) {
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('all');
  const searchRef = useRef(null);
  const monitorSlugs = useMemo(() => new Set((c.ov?.log || []).filter((e) => e.kind === 'filed' && !e.undone_at).map((e) => e.slug)), [c.ov]);
  useEffect(() => {
    const on = (e) => { if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(e.target.tagName) && !e.target.isContentEditable) { e.preventDefault(); searchRef.current?.focus(); } };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);
  const withIssues = useMemo(() => c.press.map((s) => ({ s, issues: c.issuesOf(s) })), [c.press, c.links, c.outlets]);
  const counts = {
    all: c.press.length,
    attention: withIssues.filter((x) => x.issues.some((i) => i.level === 'warn')).length,
    featured: c.press.filter((s) => s.featured).length,
    kids: c.press.filter((s) => kidsOf(s, c).length).length,
    nopicture: c.press.filter((s) => !hasPicture(s)).length,
    monitor: c.press.filter((s) => monitorSlugs.has(s.slug)).length,
    drafts: c.press.filter((s) => PS.isDraft(s)).length,
  };
  const listRef = useRef(null);
  const showFilter = (f) => { setQ(''); setFilter(f); requestAnimationFrame(() => listRef.current?.scrollIntoView?.({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'start' })); };
  const needle = q.trim().toLowerCase();
  const shown = withIssues.filter(({ s, issues }) => {
    if (filter === 'attention' && !issues.some((i) => i.level === 'warn')) return false;
    if (filter === 'featured' && !s.featured) return false;
    if (filter === 'kids' && !kidsOf(s, c).length) return false;
    if (filter === 'nopicture' && hasPicture(s)) return false;
    if (filter === 'monitor' && !monitorSlugs.has(s.slug)) return false;
    if (filter === 'drafts' && !PS.isDraft(s)) return false;
    if (!needle) return true;
    return [s.title, PS.outletNameFor(s, c.outletBySlug), s.date, PS.CATEGORY_LABELS[s.category], ...kidsOf(s, c).map((k) => k.name), ...(s.partners || []).map((p) => c.partnerBySlug.get(p)?.name)].some((v) => String(v || '').toLowerCase().includes(needle));
  }).sort((a, b) => String(b.s.date).localeCompare(String(a.s.date)) || String(a.s.slug).localeCompare(String(b.s.slug)));
  const byYear = new Map();
  for (const x of shown) { const y = PS.yearOf(x.s) || 'No date'; if (!byYear.has(y)) byYear.set(y, []); byYear.get(y).push(x); }
  const featured = c.press.filter((s) => s.featured && !PS.isDraft(s)).sort((a, b) => (a.order || 0) - (b.order || 0) || String(b.date).localeCompare(String(a.date)));
  return html`
    <div class="page-header pr-head">
      <div>
        <h2>Press</h2>
        <p class="page-sub">Every story on the publicity page. New coverage is found and added by itself; stories about a kid also show on that kid’s page.</p>
      </div>
      <div class="pr-head__actions">
        <a class="btn btn-ghost btn-sm" href="/publicity/" target="_blank" rel="noopener">Publicity page <${Icon} name="ext" size=${14} /></a>
        <button type="button" class="btn btn-primary" onClick=${onAdd}><${Icon} name="plus" /> Add a story</button>
      </div>
    </div>
    <${StatusPanel} c=${c} attention=${counts.attention} onFilter=${showFilter} />
    ${!needle && filter === 'all' && featured.length ? html`<${FeaturedOrder} c=${c} featured=${featured} />` : null}
    <section class="card pr-list" aria-labelledby="pr-all" ref=${listRef}>
      <header class="pr-list__head">
        <h3 id="pr-all">${filter === 'all' && !needle ? 'All stories' : 'Stories'} <span class="ppl-count">${shown.length}</span></h3>
        <div class="pr-search">
          <${Icon} name="search" />
          <input ref=${searchRef} type="search" class="form-input" placeholder="Search headlines, outlets, kids" aria-label="Search stories" aria-keyshortcuts="/" value=${q} onInput=${(e) => setQ(e.target.value)} />
        </div>
      </header>
      <div class="pr-pills" role="group" aria-label="Show">
        ${FILTERS.map((f) => counts[f.id] || f.id === 'all' || filter === f.id ? html`<button type="button" key=${f.id} class="pr-pill" aria-pressed=${filter === f.id} onClick=${() => setFilter(filter === f.id && f.id !== 'all' ? 'all' : f.id)}>${f.label} <span>${counts[f.id]}</span></button>` : null)}
      </div>
      ${shown.length ? [...byYear.entries()].map(([year, list]) => html`
        <div class="pr-year" key=${year}>
          <h4 class="pr-year__label"><span>${year}</span><span class="pr-year__n">${list.length}</span></h4>
          <ul class="pr-rows">
            ${list.map(({ s, issues }) => html`<${StoryRow} key=${s.slug} s=${s} issues=${issues} c=${c} monitor=${monitorSlugs.has(s.slug)} />`)}
          </ul>
        </div>`) : html`<div class="pr-empty">
          <p><strong>${needle ? `No stories match “${q.trim()}”.` : filter === 'attention' ? 'Nothing needs attention.' : filter === 'nopicture' ? 'Every story has a picture.' : 'No stories here.'}</strong></p>
          ${needle || filter !== 'all' ? html`<button type="button" class="btn btn-ghost btn-sm" onClick=${() => { setQ(''); setFilter('all'); }}>Show every story</button>` : html`<button type="button" class="btn btn-primary" onClick=${onAdd}>Add a story</button>`}
        </div>`}
    </section>`;
}

function StoryRow({ s, issues, c, monitor }) {
  const outlet = c.outletBySlug.get(s.outletLogo);
  const warn = issues.filter((i) => i.level === 'warn');
  const info = issues.filter((i) => i.level !== 'warn');
  const kids = kidsOf(s, c);
  const partners = (s.partners || []).map((p) => c.partnerBySlug.get(p)).filter(Boolean);
  const who = [kids.length ? `About ${kids.map((k) => PS.plain(k.name)).join(', ')}` : null, partners.length ? `with ${partners.map((p) => PS.plain(p.name)).join(', ')}` : null].filter(Boolean).join(' ');
  return html`<li class="pr-row">
    <button type="button" class="pr-row__open" onClick=${() => c.go({ tab: 'stories', slug: s.slug })} aria-label=${`${s.title}. ${PS.outletNameFor(s, c.outletBySlug)}, ${longDate(s.date)}${who ? `. ${who}` : ''}${warn.length ? `. Needs: ${warn.map((i) => i.label).join(', ')}` : ''}`}>
      <${StoryThumb} story=${s} outlet=${outlet} kid=${kids[0] || null} />
      <span class="pr-row__body">
        <span class="pr-row__title">${s.featured ? html`<span class="pr-star" title="Featured"><${Icon} name="star" size=${13} /></span>` : null}${s.title || 'Untitled'}</span>
        <span class="pr-row__meta">
          <span class="pr-row__outlet">${PS.outletNameFor(s, c.outletBySlug) || 'No outlet'}</span>
          <span>${longDate(s.date)}</span>
          <span>${PS.CATEGORY_LABELS[s.category] || ''}</span>
        </span>
        ${kids.length || partners.length ? html`<span class="pr-row__who" aria-hidden="true">
          ${kids.map((k) => html`<span class="pr-who pr-who--kid" key=${k.slug}><${KidFace} kid=${k} size=${20} />${PS.plain(k.name)}${k.year ? html`<small>${k.year}</small>` : null}</span>`)}
          ${partners.slice(0, 3).map((p) => html`<span class="pr-who" key=${p.slug}>${PS.plain(p.name)}</span>`)}
          ${partners.length > 3 ? html`<span class="pr-who pr-who--more">+${partners.length - 3} more</span>` : null}
        </span>` : null}
        ${PS.isDraft(s) || monitor || warn.length || info.length ? html`<span class="pr-row__chips">
          ${PS.isDraft(s) ? html`<span class="pr-chip pr-chip--draft">Draft</span>` : null}
          ${monitor ? html`<span class="pr-chip pr-chip--auto">Added by the monitor</span>` : null}
          ${warn.map((i) => html`<span class="pr-chip pr-chip--warn" title=${i.detail}>${i.label}</span>`)}
          ${info.slice(0, 2).map((i) => html`<span class="pr-chip" title=${i.detail}>${i.label}</span>`)}
        </span>` : null}
      </span>
    </button>
  </li>`;
}

/** The featured stories, in the page's order: drag, or Move up/down */
function FeaturedOrder({ c, featured }) {
  const [order, setOrder] = useState(featured.map((s) => s.slug));
  const [busy, setBusy] = useState(false);
  const [announce, setAnnounce] = useState('');
  const listRef = useRef(null);
  const key = featured.map((s) => `${s.slug}:${s.order}`).join(',');
  useEffect(() => { setOrder(featured.map((s) => s.slug)); }, [key]);
  const bySlug = new Map(featured.map((s) => [s.slug, s]));
  const save = async (next, prev) => {
    setOrder(next);
    setBusy(true);
    const j = await call('/api/reorder-content', { collection: 'press', items: next.map((slug, i) => ({ slug, order: i })) });
    setBusy(false);
    if (!j.success) { setOrder(prev); c.addToast(`Couldn’t save the order: ${j.error}`, 'error'); return; }
    window.dispatchEvent(new CustomEvent('soard-content-changed'));
    c.addToast('Order saved', 'success', { label: 'Undo', fn: () => save(prev, next) });
    c.onReload();
  };
  useEffect(() => {
    if (!listRef.current || !Sortable) return undefined;
    const sortable = Sortable.create(listRef.current, {
      handle: '.pr-feat__grip', animation: prefersReducedMotion() ? 0 : 150, ghostClass: 'is-ghost',
      onEnd: (e) => {
        if (e.oldIndex === e.newIndex) return;
        save(undoSortableMove(e, order), order);
      },
    });
    return () => sortable.destroy();
  }, [order.join(',')]);
  const move = (i, d) => {
    const j = i + d;
    if (j < 0 || j >= order.length) return;
    const next = [...order];
    [next[i], next[j]] = [next[j], next[i]];
    setAnnounce(`${bySlug.get(order[i])?.title} moved to position ${j + 1} of ${order.length}`);
    save(next, order);
    requestAnimationFrame(() => listRef.current?.querySelector(`[data-slug="${order[i]}"] .pr-feat__move[data-dir="${d}"]`)?.focus());
  };
  return html`<section class="card pr-feat" aria-labelledby="pr-feat-h">
    <header class="pr-list__head">
      <div>
        <h3 id="pr-feat-h">Featured <span class="ppl-count">${featured.length}</span></h3>
        <p class="pr-sub">The big cards at the top of the publicity page, in this order. The first is the large one.</p>
      </div>
      ${busy ? html`<span class="pr-saving"><span class="spinner spinner-14" /> Saving order</span>` : featured.length > 1 ? html`<span class="pr-hint">Drag to reorder</span>` : null}
    </header>
    <ol class="pr-feat__list" ref=${listRef}>
      ${order.map((slug, i) => { const s = bySlug.get(slug); if (!s) return null; return html`<li key=${slug} data-slug=${slug} class=${`pr-feat__item${i === 0 ? ' is-lead' : ''}`}>
        <button type="button" class="pr-feat__grip" aria-label=${`Drag ${s.title}`} tabindex="-1"><${Icon} name="grip" /></button>
        <span class="pr-feat__n" aria-hidden="true">${i + 1}</span>
        <button type="button" class="pr-feat__open" onClick=${() => c.go({ tab: 'stories', slug })}>
          <${StoryThumb} story=${s} outlet=${c.outletBySlug.get(s.outletLogo)} w=${i === 0 ? 132 : 96} h=${i === 0 ? 84 : 62} />
          <span class="pr-feat__text"><span class="pr-feat__title">${s.featuredHeadline || s.title}</span><span class="pr-feat__meta">${PS.outletNameFor(s, c.outletBySlug)} · ${longDate(s.date)}</span></span>
        </button>
        <span class="pr-feat__moves">
          <button type="button" class="pr-icon-btn pr-feat__move" data-dir="-1" disabled=${i === 0 || busy} aria-label=${`Move ${s.title} up`} onClick=${() => move(i, -1)}><${Icon} name="up" /></button>
          <button type="button" class="pr-icon-btn pr-feat__move" data-dir="1" disabled=${i === order.length - 1 || busy} aria-label=${`Move ${s.title} down`} onClick=${() => move(i, 1)}><${Icon} name="down" /></button>
        </span>
      </li>`; })}
    </ol>
    <div class="sr-only" aria-live="assertive">${announce}</div>
  </section>`;
}

// ═══════════════════════════════════════════════════════════════════
// Adding a story: paste its link
// ═══════════════════════════════════════════════════════════════════
function AddStoryDialog({ c, onClose }) {
  const Dialog = c.kit.KdDialog;
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [found, setFound] = useState(null);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const read = async () => {
    const u = url.trim();
    if (!/^https?:\/\/\S+\.\S+/i.test(u)) { setError('Paste the story’s full web address, starting with https://'); return; }
    setBusy(true); setError(null); setFound(null);
    const j = await call('/api/press-admin', { action: 'fill', url: u });
    setBusy(false);
    if (!j.success) { setError(j.error || 'Couldn’t read that page'); return; }
    setFound(j);
  };
  const ensureOutlet = async (story) => {
    if (story.outletLogo || !found?.newOutlet) return story;
    const j = await call('/api/press-admin', { action: 'createOutlet', name: found.newOutlet.name, url: story.url, kind: found.newOutlet.kind });
    if (!j.success) throw new Error(j.error);
    return { ...story, outletLogo: j.outlet.slug, outlet: j.outlet.name };
  };
  const add = async (edit) => {
    setSaving(true);
    try {
      const story = await ensureOutlet({ ...found.story, featured: false, order: 0 });
      if (edit) { sessionStorage.setItem('press-draft', JSON.stringify(story)); c.onReload(); onClose(); c.go({ tab: 'stories', slug: '__new' }); return; }
      if (!story.title) throw new Error('The page didn’t give a headline. Use “Edit first” to write one.');
      // The editor's check too: the story's link must be a web address (Edit first keeps it to fix there)
      if (!PS.isWebAddress(story.url)) throw new Error('The story’s link should start with https://. Use “Edit first” to fix it.');
      const slug = PS.storySlug(story, c.press.map((s) => s.slug));
      const res = await c.kit.api.saveContent(PATH(slug), JSON.stringify(PS.storyRecord(story), null, 2), `Add press: ${story.title}`);
      if (!res.success) throw new Error(res.error);
      c.addToast(`Added “${story.title}”`, 'success', { label: 'Open', fn: () => c.go({ tab: 'stories', slug }) });
      c.onReload();
      onClose();
    } catch (e) { c.addToast(`Couldn’t add it: ${e.message}`, 'error'); }
    setSaving(false);
  };
  const st = found?.story;
  const outlet = st?.outletLogo ? c.outletBySlug.get(st.outletLogo) : null;
  const footer = found ? html`
    <button type="button" class="btn btn-ghost" onClick=${() => { setFound(null); }} disabled=${saving}>Try another link</button>
    <span class="ppl-spacer"></span>
    <button type="button" class="btn btn-ghost" onClick=${() => add(true)} disabled=${saving}>Edit first</button>
    <button type="button" class="btn btn-primary" onClick=${() => add(false)} disabled=${saving || !st?.title}>${saving ? html`<span class="spinner spinner-14" /> Adding…` : 'Add story'}</button>`
    : html`<button type="button" class="btn btn-ghost" onClick=${onClose} disabled=${busy}>Cancel</button>
    <button type="button" class="btn btn-primary" onClick=${read} disabled=${busy || !url.trim()}>${busy ? html`<span class="spinner spinner-14" /> Reading the page…` : 'Read the page'}</button>`;
  return html`<${Dialog} title="Add a story" sub=${found ? null : 'Paste the link. The page is read for its headline, outlet, date, picture and a summary, and any kids or partners it names.'} size="md" onClose=${onClose} busy=${busy || saving} footer=${footer}>
    ${!found ? html`<form class="pr-add" onSubmit=${(e) => { e.preventDefault(); read(); }}>
      <label class="form-label" for="pr-add-url">Story link</label>
      <input id="pr-add-url" class=${`form-input${error ? ' is-invalid' : ''}`} type="url" inputmode="url" autocomplete="off" placeholder="https://www.11alive.com/article/…" value=${url} onInput=${(e) => { setUrl(e.target.value); setError(null); }} data-autofocus />
      ${error ? html`<p class="form-hint kd-bad" role="alert">${error}</p>` : html`<p class="form-hint">A news story, a TV segment’s page, or a YouTube video. Google News links work too.</p>`}
    </form>` : html`<div class="pr-filled">
      ${found.duplicateOf ? html`<div class="pr-note pr-note--warn" role="alert"><${Icon} name="warn" /> <span>This looks like a story already on the page: <button type="button" class="pr-linkbtn" onClick=${() => { onClose(); c.go({ tab: 'stories', slug: found.duplicateOf.slug }); }}>${found.duplicateOf.title}</button>.</span></div>` : null}
      ${found.read !== 'ok' ? html`<div class="pr-note"><${Icon} name="warn" /> <span>The outlet wouldn’t let the page be read, so only part of it could be filled in. Use “Edit first” to finish it.</span></div>` : null}
      <div class="pr-filled__card">
        <${StoryThumb} story=${st} outlet=${outlet} w=${160} h=${104} />
        <div>
          <p class="pr-filled__outlet">${st.outlet || 'Outlet unknown'}${found.newOutlet ? html` <span class="pr-chip">New outlet</span>` : null} · ${st.date ? longDate(st.date) : 'Date unknown'} · ${PS.CATEGORY_LABELS[st.category]}</p>
          <p class="pr-filled__title">${st.title || html`<em>No headline found</em>`}</p>
          <p class="pr-filled__sum">${st.excerpt || html`<em>No summary yet</em>`}</p>
          ${st.kids?.length || st.partners?.length ? html`<p class="pr-filled__people">${[...(st.kids || []).map((k) => c.kids.find((x) => x.slug === k)?.name || k), ...(st.partners || []).map((p) => c.partners.find((x) => x.slug === p)?.name || p)].join(', ')}</p>` : null}
        </div>
      </div>
      ${found.imageError && !st.image && !st.videoId ? html`<p class="form-hint">No picture: ${found.imageError}. Add one after with Edit first.</p>` : null}
      ${found.about === 'mentions' ? html`<p class="form-hint">Workers AI thinks SOARD only comes up in passing here.</p>` : found.about === 'unrelated' ? html`<p class="form-hint kd-bad">Workers AI doesn’t think this story is about SOARD.</p>` : null}
    </div>`}
  <//>`;
}

// ═══════════════════════════════════════════════════════════════════
// The story editor
// ═══════════════════════════════════════════════════════════════════
const EMPTY = { outlet: '', outletLogo: '', category: 'print', title: '', date: new Date().toISOString().slice(0, 10), url: '', excerpt: '', image: null, featured: false, order: 0 };
const same = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
/** My changes on top of what someone saved meanwhile; fields both changed differently clash */
function threeWay(base, mine, theirs) {
  const merged = { ...theirs };
  const clashes = [];
  for (const k of new Set([...Object.keys(base || {}), ...Object.keys(mine || {}), ...Object.keys(theirs || {})])) {
    if (same(mine[k], base?.[k])) continue;
    if (same(theirs[k], base?.[k]) || same(theirs[k], mine[k])) { if (mine[k] === undefined) delete merged[k]; else merged[k] = mine[k]; continue; }
    clashes.push(k);
  }
  return { merged, clashes };
}

function StoryEditor({ slug, c, onBack, onDirty }) {
  const isNew = slug === '__new';
  const narrow = useNarrow('(max-width: 1100px)');
  const [base, setBase] = useState(null);
  const [rec, setRec] = useState(null);
  const [sha, setSha] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [touched, setTouched] = useState(false);
  const [preview, setPreview] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [conflict, setConflict] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [filling, setFilling] = useState(false);
  const [picker, setPicker] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [merging, setMerging] = useState(null);
  const history = c.kit.useContentHistory ? c.kit.useContentHistory('press', isNew ? null : slug, { describe: PS.describeChanges, labels: PS.changedLabels }) : null;

  useEffect(() => {
    if (isNew) {
      let d = null;
      try { d = JSON.parse(sessionStorage.getItem('press-draft') || 'null'); sessionStorage.removeItem('press-draft'); } catch { /* none */ }
      setBase({ ...EMPTY });
      setRec({ ...EMPTY, ...(d || {}) });
      return;
    }
    c.kit.api.readContent(PATH(slug)).then((r) => {
      if (!r.success) { setLoadError(r.error || 'Couldn’t open this story'); return; }
      const d = parseContent(r);
      setBase(d); setRec(d); setSha(r.sha);
    }).catch((e) => setLoadError(e.message));
  }, [slug]);

  const outlet = rec ? c.outletBySlug.get(rec.outletLogo) : null;
  const shaped = (x) => PS.storyRecord({ ...x, outlet: c.outletBySlug.get(x.outletLogo)?.name || x.outlet });
  const dirty = !!(rec && base && !same(shaped(rec), shaped(base)));
  useEffect(() => { onDirty?.(dirty); c.setGlobalDirty?.(dirty, 'a press story'); return () => { c.setGlobalDirty?.(false); }; }, [dirty]);
  useEffect(() => {
    if (!dirty) return undefined;
    const h = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', h);
    return () => window.removeEventListener('beforeunload', h);
  }, [dirty]);
  const set = (k, v) => setRec((r) => ({ ...r, [k]: v }));
  const problems = rec ? [
    !PS.plain(rec.title) ? 'Add the headline' : null,
    !rec.outletLogo && !PS.plain(rec.outlet) ? 'Pick the outlet' : null,
    !/^\d{4}-\d{2}-\d{2}$/.test(rec.date || '') ? 'Add the date' : null,
    rec.url && (!/^https?:\/\/\S+\.\S+/i.test(rec.url) || !PS.isWebAddress(rec.url)) ? 'The link should start with https://' : null,
  ].filter(Boolean) : [];
  const link = c.links[slug];
  const issues = rec ? c.issuesOf({ ...rec, slug }) : [];

  const save = async () => {
    setTouched(true);
    if (problems.length || saving) { if (problems.length) c.addToast(problems[0], 'error'); return false; }
    setSaving(true);
    const next = shaped(rec);
    const s = isNew ? PS.storySlug(next, c.press.map((x) => x.slug)) : slug;
    let res = await c.kit.api.saveContent(PATH(s), JSON.stringify(next, null, 2), `${isNew ? 'Add' : 'Update'} press: ${next.title}`, sha || undefined).catch((e) => ({ success: false, error: e.message }));
    if (!res.success && !isNew && /^Conflict/i.test(res.error || '')) {
      const r = await c.kit.api.readContent(PATH(slug));
      if (r.success) {
        const theirs = parseContent(r);
        const { merged, clashes } = threeWay(shaped(base), next, shaped(theirs));
        if (clashes.length) { setSaving(false); setBase(theirs); setSha(r.sha); setConflict({ clashes, mine: next, theirs: shaped(theirs), merged }); return false; }
        res = await c.kit.api.saveContent(PATH(slug), JSON.stringify(PS.storyRecord(merged), null, 2), `Update press: ${next.title}`, r.sha);
        if (res.success) { c.addToast('Someone saved this story meanwhile. Their changes and yours are both kept.', 'info'); setRec(merged); }
      }
    }
    setSaving(false);
    if (!res.success) { c.addToast(`Couldn’t save: ${res.error}`, 'error'); return false; }
    setSha(res.sha);
    setBase(next);
    setRec(next);
    setTouched(false);
    history?.reload?.();
    c.addToast(isNew ? `Added “${next.title}”` : 'Saved', 'success');
    c.onReload();
    if (isNew) { onDirty?.(false); c.go({ tab: 'stories', slug: s }); }
    return true;
  };
  const saveRef = useRef(save);
  saveRef.current = save;
  useEffect(() => { const fn = () => saveRef.current(); window.addEventListener('soard-save', fn); return () => window.removeEventListener('soard-save', fn); }, []);

  const fill = async () => {
    setFilling(true);
    const j = await call('/api/press-admin', { action: 'fill', url: rec.url });
    setFilling(false);
    if (!j.success) { c.addToast(j.error || 'Couldn’t read the page', 'error'); return; }
    const f = j.story;
    let filled = [];
    setRec((r) => {
      const n = { ...r };
      const take = (k, v, label) => { if (v && (!PS.plain(r[k]) || k === 'url')) { n[k] = v; if (label) filled.push(label); } };
      take('title', f.title, 'headline');
      if (!r.outletLogo && f.outletLogo) { n.outletLogo = f.outletLogo; n.outlet = f.outlet; filled.push('outlet'); }
      take('excerpt', f.excerpt, 'summary');
      if (f.date && (!r.date || r.date === EMPTY.date)) { n.date = f.date; filled.push('date'); }
      if (!r.image && f.image) { n.image = f.image; filled.push('picture'); }
      if (!r.videoId && f.videoId) { n.videoId = f.videoId; filled.push('video'); }
      if (!(r.kids || []).length && f.kids?.length) { n.kids = f.kids; filled.push('kids'); }
      if (!(r.partners || []).length && f.partners?.length) { n.partners = f.partners; filled.push('partners'); }
      if (f.url && f.url !== r.url) n.url = f.url;
      return n;
    });
    setTimeout(() => c.addToast(filled.length ? `Filled in: ${[...new Set(filled)].join(', ')}. Check them, then save.` : 'Nothing was missing.', 'info'), 0);
    if (j.duplicateOf && j.duplicateOf.slug !== slug) c.addToast(`This looks like “${j.duplicateOf.title}”, already on the page`, 'info', { label: 'Open', fn: () => c.go({ tab: 'stories', slug: j.duplicateOf.slug }) });
  };
  const pullPicture = async () => {
    setPulling(true);
    const r = await c.kit.api.fetchOgImage(rec.url, `press/${slug && !isNew ? slug : PS.slugify(`${rec.outletLogo || rec.outlet} ${rec.date}`) || 'press'}`).catch((e) => ({ success: false, error: e.message }));
    setPulling(false);
    if (r.success && r.imageId) { set('image', r.imageId); c.addToast('Picture pulled from the story', 'info'); } else c.addToast(r.error || 'No picture on that page', 'error');
  };
  // Another copy of this story: what only it has fills this one's gaps, then it's removed (Undo brings it back)
  const mergeIn = async (drop, title) => {
    setMerging(drop);
    const j = await call('/api/press-admin', { action: 'mergeStories', keep: slug, drop });
    setMerging(null);
    if (!j.success) { c.addToast(j.error || 'Couldn’t merge them', 'error'); return; }
    window.dispatchEvent(new CustomEvent('soard-content-changed'));
    const r = await c.kit.api.readContent(PATH(slug));
    if (r.success) { const d = parseContent(r); setBase(d); setRec(d); setSha(r.sha); }
    c.addToast(`Merged “${title}” into this story`, 'success', j.logId ? { label: 'Undo', fn: async () => { const u = await call('/api/press-admin', { action: 'undo', id: j.logId }); if (u.success) { c.addToast('Merge undone', 'info'); window.dispatchEvent(new CustomEvent('soard-content-changed')); c.onReload(); const b = await c.kit.api.readContent(PATH(slug)); if (b.success) { const d = parseContent(b); setBase(d); setRec(d); setSha(b.sha); } } else c.addToast(u.error, 'error'); } } : undefined);
    c.onReload();
    c.loadOv();
  };
  const doDelete = async () => {
    const r = await c.kit.api.readContent(PATH(slug));
    if (!r.success) { c.addToast(`Couldn’t delete: ${r.error}`, 'error'); return; }
    const cached = r.content;
    const res = await c.kit.api.deleteContent(PATH(slug), r.sha, `Delete press: ${rec.title}`);
    if (!res.success) { c.addToast(`Couldn’t delete: ${res.error}`, 'error'); return; }
    onDirty?.(false);
    c.addToast(`Deleted “${rec.title}”`, 'success', { label: 'Undo', fn: async () => { const b = await c.kit.api.saveContent(PATH(slug), typeof cached === 'string' ? cached : JSON.stringify(cached, null, 2), `Undo delete: ${rec.title}`); if (b.success) { c.addToast('Story restored', 'success'); c.onReload(); } else c.addToast(`Couldn’t restore: ${b.error}`, 'error'); } });
    c.onReload();
    onBack();
  };

  if (loadError) return html`<div class="card pr-empty"><p><strong>${loadError}</strong></p><button type="button" class="btn btn-ghost" onClick=${onBack}>Back to Press</button></div>`;
  if (!rec) return html`<div class="pr-loading"><span class="spinner" /></div>`;
  const P = c.kit.PagePreview;
  const Badge = c.kit.PublishBadge;
  const previewItem = { ...shaped(rec), slug: isNew ? PS.storySlug(shaped(rec), c.press.map((x) => x.slug)) : slug };
  const side = html`
    <section class="card pr-side__card">
      <h3>On the site</h3>
      <label class="pr-switch">
        <input type="checkbox" role="switch" checked=${!PS.isDraft(rec)} onChange=${(e) => set('publishStatus', e.target.checked ? undefined : 'draft')} />
        <span><strong>${PS.isDraft(rec) ? 'Hidden (draft)' : 'On the publicity page'}</strong><small>${PS.isDraft(rec) ? 'Nobody sees it until you switch it on.' : (rec.kids || []).length ? 'Also on the kid’s page, under In the news.' : 'In the archive under its year.'}</small></span>
      </label>
      <label class="pr-switch">
        <input type="checkbox" role="switch" checked=${!!rec.featured} onChange=${(e) => set('featured', e.target.checked)} />
        <span><strong>Featured</strong><small>${rec.featured ? 'A big card at the top. Order them on the Stories list.' : 'Show it as a big card at the top of the page.'}</small></span>
      </label>
      ${!isNew ? html`<div class="pr-side__links">
        <button type="button" class="btn btn-ghost btn-sm" onClick=${() => setPreview((v) => !v)} aria-pressed=${preview}><${Icon} name="eye" /> Preview</button>
        ${history?.versions?.length ? html`<button type="button" class="btn btn-ghost btn-sm" onClick=${() => setShowHistory(true)}><${Icon} name="history" /> History</button>` : null}
      </div>` : null}
    </section>
    ${issues.length ? html`<section class="card pr-side__card">
      <h3>Needs</h3>
      <ul class="pr-needs">${issues.map((i) => html`<li key=${i.id} class=${i.level === 'warn' ? 'is-warn' : ''}><strong>${i.label}</strong><span>${i.detail}</span>
        ${i.id === 'dupe' ? html`<ul class="pr-dupes">${(c.dupes.get(slug) || []).map((d) => { const o = c.press.find((x) => x.slug === d); return o ? html`<li key=${d}>
          <button type="button" class="pr-linkbtn" onClick=${() => c.go({ tab: 'stories', slug: d })}>${o.title}</button>
          <small>${PS.outletNameFor(o, c.outletBySlug)} · ${longDate(o.date)}</small>
          <button type="button" class="btn btn-ghost btn-sm" disabled=${dirty || merging} title=${dirty ? 'Save your changes first' : ''} onClick=${() => mergeIn(d, o.title)}>${merging === d ? html`<span class="spinner spinner-14" /> Merging` : 'Merge into this story'}</button>
        </li>` : null; })}</ul>` : null}</li>`)}</ul>
    </section>` : null}
    ${!isNew && rec.url ? html`<section class="card pr-side__card">
      <h3>The link</h3>
      <p class="pr-side__p">${!link?.checkedAt ? 'Not checked yet. The monitor checks every link each week.'
        : rec.linkGone ? html`The outlet took the story down (${longDate(rec.linkGone)}). ${rec.archiveUrl ? html`The site links to <a href=${rec.archiveUrl} target="_blank" rel="noopener">the archived copy</a>.` : 'No archived copy exists, so it’s shown without a link.'}`
        : link.status === 'ok' ? `Working when checked ${ago(link.checkedAt)}.`
        : link.status === 'failing' ? `Didn’t open when checked ${ago(link.checkedAt)}. If it’s still down next week, the site links to the archived copy.`
        : link.status === 'blocked' ? `The outlet blocks automated checks (checked ${ago(link.checkedAt)}), so it’s left as it is.`
        : `Checked ${ago(link.checkedAt)}.`}</p>
      ${link?.archiveUrl && !rec.linkGone ? html`<p class="pr-side__p"><a href=${link.archiveUrl} target="_blank" rel="noopener">Archived copy <${Icon} name="ext" size=${12} /></a> kept in case the story disappears.</p>` : null}
    </section>` : null}
    ${!isNew ? html`<button type="button" class="btn btn-ghost btn-sm pr-delete" onClick=${() => setConfirmDelete(true)}><${Icon} name="trash" /> Delete story</button>` : null}`;

  return html`
    <div class="pr-editor">
      <div class="pr-bar" role="region" aria-label="Story">
        <button type="button" class="pr-icon-btn pr-bar__back" onClick=${onBack} aria-label="Back to Press"><${Icon} name="back" size=${20} /></button>
        <div class="pr-bar__title">
          <p class="pr-bar__crumb">Press ${Badge && !isNew ? html`<${Badge} type="press" slug=${slug} draft=${PS.isDraft(rec)} />` : null}</p>
          <h2>${PS.plain(rec.title) || (isNew ? 'New story' : 'Untitled')}</h2>
        </div>
        <span class="pr-bar__state" aria-live="polite">${saving ? 'Saving…' : dirty ? 'Unsaved changes' : isNew ? '' : 'Saved'}</span>
        ${dirty && !isNew ? html`<button type="button" class="btn btn-ghost btn-sm" onClick=${() => { const prev = rec; setRec(base); c.addToast('Changes discarded', 'info', { label: 'Undo', fn: () => setRec(prev) }); }}>Discard</button>` : null}
        <button type="button" class="btn btn-primary" onClick=${save} disabled=${saving || (!dirty && !isNew)} aria-keyshortcuts="Meta+S">${saving ? html`<span class="spinner spinner-14" /> Saving` : isNew ? 'Add story' : 'Save'}</button>
      </div>
      ${preview && P ? html`<${P} kind="press" item=${previewItem} slug=${isNew ? null : slug} dirty=${dirty} buildOpts=${{ collection: c.press, mediaLogos: c.outlets }} onClose=${() => setPreview(false)} />` : null}
      <div class="pr-editor__grid">
        <div class="pr-editor__main">
          <section class="card pr-card">
            <h3>The story</h3>
            <div class="form-group">
              <label class="form-label" for="pr-url">Link</label>
              <div class="pr-row-input">
                <input id="pr-url" class=${`form-input${touched && problems.includes('The link should start with https://') ? ' is-invalid' : ''}`} type="url" inputmode="url" placeholder="https://" value=${rec.url || ''} onInput=${(e) => set('url', e.target.value.trim())} />
                <button type="button" class="btn btn-ghost" onClick=${fill} disabled=${filling || !/^https?:\/\/\S+\.\S+/i.test(rec.url || '')} title="Read the page and fill in what’s missing">${filling ? html`<span class="spinner spinner-14" /> Reading` : html`<${Icon} name="spark" /> Fill from the page`}</button>
                ${rec.url ? html`<a class="btn btn-ghost pr-open" href=${rec.url} target="_blank" rel="noopener" aria-label="Open the story"><${Icon} name="ext" /></a>` : null}
              </div>
              ${PS.googleLink(rec.url) ? html`<p class="form-hint">A Google News link. Fill from the page swaps it for the outlet’s own.</p>` : null}
            </div>
            <div class="form-group">
              <label class="form-label" for="pr-title">Headline</label>
              <input id="pr-title" class=${`form-input${touched && !PS.plain(rec.title) ? ' is-invalid' : ''}`} value=${rec.title || ''} onInput=${(e) => set('title', e.target.value)} />
              ${PS.storyTitle({ ...rec, outlet: outlet?.name || rec.outlet, outletAliases: outlet?.aliases }) !== PS.plain(rec.title) ? html`<p class="form-hint">It ends with the outlet’s name. <button type="button" class="pr-linkbtn" onClick=${() => set('title', PS.storyTitle({ ...rec, outlet: outlet?.name || rec.outlet, outletAliases: outlet?.aliases }))}>Take it off</button></p>` : null}
            </div>
            <div class="pr-two">
              <div class="form-group">
                <span class="form-label" id="pr-outlet-l">Outlet</span>
                <${OutletPicker} c=${c} value=${rec.outletLogo} name=${rec.outlet} url=${rec.url} invalid=${touched && !rec.outletLogo && !PS.plain(rec.outlet)}
                  onPick=${(o) => setRec((r) => ({ ...r, outletLogo: o.slug, outlet: o.name, category: o.kind && r.category === (base?.category || EMPTY.category) ? o.kind : r.category }))} />
              </div>
              <div class="form-group">
                <label class="form-label" for="pr-date">Date</label>
                <input id="pr-date" class="form-input" type="date" value=${rec.date || ''} onInput=${(e) => set('date', e.target.value)} />
              </div>
            </div>
            <div class="form-group">
              <span class="form-label" id="pr-cat-l">Kind</span>
              <div class="pr-seg" role="radiogroup" aria-labelledby="pr-cat-l">
                ${PS.CATEGORIES.map((k) => html`<button type="button" key=${k} role="radio" aria-checked=${rec.category === k} class="pr-seg__btn" onClick=${() => set('category', k)}>${PS.CATEGORY_LABELS[k]}</button>`)}
              </div>
              <p class="form-hint">The archive’s filter on the publicity page.${outlet?.kind && outlet.kind !== rec.category ? ` ${outlet.name} is usually ${PS.CATEGORY_LABELS[outlet.kind]}.` : ''}</p>
            </div>
            <div class="form-group">
              <label class="form-label" for="pr-sum">Summary</label>
              <textarea id="pr-sum" class="form-textarea" rows="3" maxlength=${PS.SUMMARY_MAX + 200} value=${PS.hasMarkup(rec.excerpt) ? PS.plain(rec.excerpt) : rec.excerpt || ''} onInput=${(e) => set('excerpt', e.target.value)}></textarea>
              <p class=${`form-hint${PS.plain(rec.excerpt).length > PS.SUMMARY_MAX ? ' kd-bad' : ''}`}>${PS.plain(rec.excerpt).length}/${PS.SUMMARY_MAX}. A sentence or two on what the story says, under its headline in the archive.</p>
            </div>
          </section>

          <${PictureCard} c=${c} rec=${rec} outlet=${outlet} link=${link} set=${set} setRec=${setRec} pulling=${pulling} onPull=${pullPicture} onBrowse=${() => setPicker(true)} />

          ${rec.featured ? html`<section class="card pr-card">
            <h3>Featured card</h3>
            <p class="pr-sub">Leave these empty to use the headline and summary.</p>
            <div class="form-group">
              <label class="form-label" for="pr-fh">Card headline</label>
              <input id="pr-fh" class="form-input" value=${rec.featuredHeadline || ''} placeholder=${rec.title} onInput=${(e) => set('featuredHeadline', e.target.value || null)} />
            </div>
            <div class="form-group">
              <label class="form-label" for="pr-fd">Card summary</label>
              <textarea id="pr-fd" class="form-textarea" rows="3" value=${rec.featuredDescription || ''} placeholder=${PS.plain(rec.excerpt)} onInput=${(e) => set('featuredDescription', e.target.value || null)}></textarea>
            </div>
          </section>` : null}

          <section class="card pr-card">
            <h3>Who it’s about</h3>
            <p class="pr-sub">A story linked to a kid shows on that kid’s page under In the news.</p>
            <${PeoplePicker} label="Kids" face=${true} items=${c.kids.filter((k) => k.publishStatus !== 'draft')} value=${rec.kids || []} onChange=${(v) => set('kids', v)} sub=${(k) => [k.year, PS.plain(k.diagnosis).slice(0, 40)].filter(Boolean).join(' · ')} />
            <${PeoplePicker} label="Partners" items=${c.partners} value=${rec.partners || []} onChange=${(v) => set('partners', v)} sub=${(p) => p.level ? p.level[0].toUpperCase() + p.level.slice(1) : ''} />
          </section>
          ${narrow ? html`<div class="pr-side pr-side--stacked">${side}</div>` : null}
        </div>
        ${narrow ? null : html`<aside class="pr-side">${side}</aside>`}
      </div>
      ${picker && c.kit.ImagePicker ? html`<${c.kit.ImagePicker} value=${rec.image} uploadPrefix=${`press/${isNew ? 'new' : slug}`} onSelect=${(id) => { set('image', id); setPicker(false); }} onClose=${() => setPicker(false)} />` : null}
      ${showHistory && history && c.kit.KdHistoryDialog ? html`<${c.kit.KdHistoryDialog} name=${rec.title} history=${history} current=${rec} dirty=${dirty} noun="story"
        onRestore=${(v) => { setRec({ ...v }); setShowHistory(false); c.addToast('Version restored. Save to keep it.', 'info'); }} onClose=${() => setShowHistory(false)} />` : null}
      ${conflict ? html`<${ConflictDialog} c=${c} conflict=${conflict} onCancel=${() => setConflict(null)} onPick=${(picked) => { const m = { ...conflict.merged, ...picked }; setConflict(null); setRec(m); setTimeout(() => saveRef.current(), 0); }} />` : null}
      ${confirmDelete ? html`<${c.kit.KdDialog} title=${`Delete “${rec.title}”?`} size="sm" onClose=${() => setConfirmDelete(false)}
        footer=${html`<button type="button" class="btn btn-ghost" onClick=${() => setConfirmDelete(false)}>Cancel</button><button type="button" class="btn btn-danger" data-autofocus onClick=${() => { setConfirmDelete(false); doDelete(); }}>Delete story</button>`}>
        <p>It leaves the publicity page${(rec.kids || []).length ? ' and the kid’s page' : ''} when the site next updates. Changed your mind? Undo, or bring it back from its History.</p>
      <//>` : null}
    </div>`;
}

function ConflictDialog({ c, conflict, onCancel, onPick }) {
  const [pick, setPick] = useState(() => Object.fromEntries(conflict.clashes.map((k) => [k, 'mine'])));
  const show = (k, v) => (k === 'image' ? (v ? 'A picture' : 'No picture') : k === 'kids' || k === 'partners' ? `${(v || []).length} linked` : typeof v === 'boolean' ? (v ? 'Yes' : 'No') : String(v ?? '') || '(empty)');
  return html`<${c.kit.KdDialog} title="Someone saved this story meanwhile" sub="These fields changed on both sides. Pick which to keep; everything else is merged." size="md" onClose=${onCancel}
    footer=${html`<button type="button" class="btn btn-ghost" onClick=${onCancel}>Cancel</button><button type="button" class="btn btn-primary" onClick=${() => onPick(Object.fromEntries(conflict.clashes.map((k) => [k, (pick[k] === 'mine' ? conflict.mine : conflict.theirs)[k]])))}>Save</button>`}>
    ${conflict.clashes.map((k) => html`<fieldset class="pr-clash" key=${k}>
      <legend>${PS.FIELD_LABELS[k] || k}</legend>
      ${['mine', 'theirs'].map((side) => html`<label class=${`pr-clash__opt${pick[k] === side ? ' is-on' : ''}`}><input type="radio" name=${`pr-clash-${k}`} checked=${pick[k] === side} onChange=${() => setPick((p) => ({ ...p, [k]: side }))} />
        <span><strong>${side === 'mine' ? 'Yours' : 'Theirs'}</strong><small>${show(k, conflict[side][k])}</small></span></label>`)}
    </fieldset>`)}
  <//>`;
}

/** The picture: what the card shows now, and ways to change it */
function PictureCard({ c, rec, outlet, link, set, setRec, pulling, onPull, onBrowse }) {
  const [videoText, setVideoText] = useState(rec.videoId || '');
  useEffect(() => { setVideoText(rec.videoId || ''); }, [rec.videoId]);
  const yt = PS.youTubeId(rec.videoId);
  const typed = PS.youTubeId(videoText);
  const shows = yt ? 'video' : rec.image ? 'picture' : outlet?.logo ? 'logo' : 'name';
  const suggestImage = link?.suggestImage && link.suggestImage !== rec.image ? link.suggestImage : null;
  const suggestVideo = link?.suggestVideo && link.suggestVideo !== yt ? link.suggestVideo : null;
  // The kids it's about: their pages' photos, one click away
  const kidShots = (rec.kids || []).map((k) => c.kidBySlug.get(k)).filter(Boolean)
    .map((k) => ({ kid: k, ids: [...new Set([k.heroImage, ...(k.photos || []).map((x) => x?.url)].map((x) => PS.cfId(x)).filter(Boolean))].slice(0, 4) }))
    .filter((x) => x.ids.length).slice(0, 2);
  const from = rec.image && link?.imageFrom && PS.cfId(rec.image) ? link.imageFrom : null;
  const fromKid = from?.startsWith('kid:') ? c.kidBySlug.get(from.slice(4)) : null;
  return html`<section class="card pr-card">
    <h3>Picture and video</h3>
    <div class="pr-pic">
      <div class="pr-pic__stage">
        <${StoryThumb} story=${rec} outlet=${outlet} w=${320} h=${200} className="pr-pic__thumb" />
        <p class="pr-pic__says">${rec.featured
          ? (shows === 'video' ? 'The featured card plays this video.' : shows === 'picture' ? 'The featured card shows this picture.' : shows === 'logo' ? `No picture: the featured card shows ${outlet.name}’s logo.` : 'No picture or logo: the featured card shows the outlet’s name in plain type.')
          : 'Featured cards show it. The archive list shows words only.'}</p>
        ${from ? html`<p class="pr-pic__from">${fromKid ? `The monitor chose ${PS.plain(fromKid.name)}’s room: the story had no picture it could use.` : from === 'archive' ? 'Pulled by the monitor from the archived copy of the story.' : 'Pulled by the monitor from the story.'}</p>` : null}
      </div>
      <div class="pr-pic__tools">
        <div class="pr-btns">
          <button type="button" class="btn btn-ghost btn-sm" onClick=${onBrowse}><${Icon} name="image" /> ${rec.image ? 'Change' : 'Choose or upload'}</button>
          <button type="button" class="btn btn-ghost btn-sm" onClick=${onPull} disabled=${pulling || !/^https?:\/\//.test(rec.url || '')}>${pulling ? html`<span class="spinner spinner-14" /> Pulling` : 'Pull from the story'}</button>
          ${rec.image ? html`<button type="button" class="btn btn-ghost btn-sm" onClick=${() => { const prev = rec.image; set('image', null); c.addToast('Picture removed', 'info', { label: 'Undo', fn: () => set('image', prev) }); }}>Remove</button>` : null}
        </div>
        ${kidShots.map(({ kid, ids }) => html`<div class="pr-kidpics" key=${kid.slug}>
          <p class="pr-kidpics__label"><${KidFace} kid=${kid} size=${20} /> Photos from ${PS.plain(kid.name)}’s page</p>
          <div class="pr-kidpics__row">${ids.map((id) => html`<button type="button" key=${id} class="pr-kidpic" aria-pressed=${PS.cfId(rec.image) === id} aria-label=${`Use this photo of ${PS.plain(kid.name)}’s room`} onClick=${() => set('image', id)}><img src=${cfImg(id, 'w=192,h=128,fit=cover,q=70')} alt="" loading="lazy" /></button>`)}</div>
        </div>`)}
        ${suggestImage ? html`<div class="pr-suggest">
          <img src=${cfImg(suggestImage, 'w=160,h=100,fit=cover,q=70')} alt="" />
          <span>The story has a picture. The featured card shows ${outlet?.name || 'the outlet'}’s logo now.</span>
          <button type="button" class="btn btn-ghost btn-sm" onClick=${() => set('image', suggestImage)}>Use the picture</button>
        </div>` : null}
        <div class="form-group pr-video">
          <label class="form-label" for="pr-video">YouTube video</label>
          <input id="pr-video" class=${`form-input${videoText && !typed ? ' is-invalid' : ''}`} placeholder="Paste a YouTube link" value=${videoText}
            onInput=${(e) => { setVideoText(e.target.value); const id = PS.youTubeId(e.target.value); if (id || !e.target.value.trim()) setRec((r) => { const n = { ...r }; if (id) n.videoId = id; else delete n.videoId; return n; }); }} />
          <p class=${`form-hint${videoText && !typed ? ' kd-bad' : ''}`}>${videoText && !typed ? 'That isn’t a YouTube link.' : 'A featured card with a video plays it in place.'}</p>
        </div>
        ${suggestVideo ? html`<div class="pr-suggest">
          <img src=${`https://i.ytimg.com/vi/${suggestVideo}/mqdefault.jpg`} alt="" />
          <span>The story’s page has this YouTube video in it.</span>
          <button type="button" class="btn btn-ghost btn-sm" onClick=${() => set('videoId', suggestVideo)}>Use the video</button>
        </div>` : null}
      </div>
    </div>
  </section>`;
}

/** Pick an outlet, or add a new one by name */
function OutletPicker({ c, value, name, url, invalid, onPick }) {
  const id = useId('pr-op');
  const current = c.outletBySlug.get(value);
  const [q, setQ] = useState(null);
  const [open, setOpen] = useState(false);
  const [hi, setHi] = useState(0);
  const [adding, setAdding] = useState(false);
  const wrap = useRef(null);
  useEffect(() => {
    const on = (e) => { if (!wrap.current?.contains(e.target)) { setOpen(false); setQ(null); } };
    document.addEventListener('pointerdown', on);
    return () => document.removeEventListener('pointerdown', on);
  }, []);
  const text = q ?? (current?.name || name || '');
  const key = PS.outletKey(text);
  const counts = useMemo(() => { const m = new Map(); for (const s of c.press) m.set(s.outletLogo, (m.get(s.outletLogo) || 0) + 1); return m; }, [c.press]);
  const list = useMemo(() => {
    const all = [...c.outlets].sort((a, b) => (counts.get(b.slug) || 0) - (counts.get(a.slug) || 0) || a.name.localeCompare(b.name));
    if (q == null || !key) return all.slice(0, 40);
    return all.filter((o) => [...PS.outletKeys(o)].some((k) => k.includes(key)) || (o.domains || []).some((d) => d.includes(q.trim().toLowerCase()))).slice(0, 40);
  }, [c.outlets, q, counts]);
  const exact = q != null && list.find((o) => PS.outletKeys(o).has(key));
  const options = [...list.map((o) => ({ o })), ...(q != null && q.trim() && !exact ? [{ add: q.trim() }] : [])];
  const choose = async (opt) => {
    if (!opt) return;
    if (opt.o) { onPick(opt.o); setOpen(false); setQ(null); return; }
    setAdding(true);
    const j = await call('/api/press-admin', { action: 'createOutlet', name: opt.add, url });
    setAdding(false);
    if (!j.success) { c.addToast(`Couldn’t add the outlet: ${j.error}`, 'error'); return; }
    c.onReload();
    onPick(j.outlet);
    c.addToast(j.existed ? `${j.outlet.name} was already an outlet` : `${j.outlet.name} added as an outlet`, 'info');
    setOpen(false); setQ(null);
  };
  const onKey = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setHi((x) => Math.min(options.length - 1, x + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((x) => Math.max(0, x - 1)); }
    else if (e.key === 'Enter' && open) { e.preventDefault(); choose(options[hi]); }
    else if (e.key === 'Escape' && open) { e.stopPropagation(); setOpen(false); setQ(null); }
  };
  return html`<div class="pr-combo" ref=${wrap}>
    <div class="pr-combo__field">
      <${OutletMark} outlet=${current || { name: text }} size=${28} />
      <input class=${`form-input${invalid ? ' is-invalid' : ''}`} role="combobox" aria-expanded=${open} aria-controls=${`${id}-list`} aria-autocomplete="list" aria-labelledby="pr-outlet-l"
        aria-activedescendant=${open && options[hi] ? `${id}-${hi}` : null} value=${text} placeholder="Search or add an outlet"
        onFocus=${() => setOpen(true)} onInput=${(e) => { setQ(e.target.value); setOpen(true); setHi(0); }} onKeyDown=${onKey} />
      ${adding ? html`<span class="spinner spinner-14" />` : null}
    </div>
    ${!current && name ? html`<p class="form-hint">“${name}” isn’t linked to an outlet. Pick it from the list, or add it.</p>` : null}
    ${open ? html`<ul class="pr-combo__list" role="listbox" id=${`${id}-list`}>
      ${options.map((opt, i) => html`<li key=${opt.o?.slug || 'add'} id=${`${id}-${i}`} role="option" aria-selected=${i === hi} class=${`pr-combo__opt${i === hi ? ' is-hi' : ''}`}
          onMouseDown=${(e) => e.preventDefault()} onClick=${() => choose(opt)} onPointerEnter=${() => setHi(i)}>
        ${opt.o ? html`<${OutletMark} outlet=${opt.o} size=${24} /><span class="pr-combo__name">${opt.o.name}</span><span class="pr-combo__n">${plural(counts.get(opt.o.slug) || 0, 'story', 'stories')}</span>`
          : html`<${Icon} name="plus" /><span class="pr-combo__name">Add “${opt.add}” as a new outlet</span>`}
      </li>`)}
      ${!options.length ? html`<li class="pr-combo__none">No outlets match</li>` : null}
    </ul>` : null}
  </div>`;
}

/** Kids or partners: chips, and a search to add more */
function PeoplePicker({ label, items, value, onChange, sub = () => '', face = false }) {
  const id = useId('pr-pp');
  const [q, setQ] = useState('');
  const [hi, setHi] = useState(0);
  const bySlug = new Map(items.map((x) => [x.slug, x]));
  const needle = q.trim().toLowerCase();
  const matches = needle ? items.filter((x) => !value.includes(x.slug) && PS.plain(x.name).toLowerCase().includes(needle)).slice(0, 8) : [];
  const add = (x) => { if (!x) return; onChange([...value, x.slug]); setQ(''); setHi(0); };
  return html`<div class="pr-people">
    <label class="form-label" for=${id}>${label}</label>
    ${value.length ? html`<ul class="pr-people__chips">${value.map((s) => html`<li key=${s} class=${`pr-people__chip${face && bySlug.get(s) ? ' pr-people__chip--face' : ''}`}>${face && bySlug.get(s) ? html`<${KidFace} kid=${bySlug.get(s)} size=${24} />` : null}<span>${bySlug.get(s)?.name || s}${bySlug.get(s) ? null : html` <small>(not found)</small>`}</span>
      <button type="button" class="pr-icon-btn" aria-label=${`Remove ${bySlug.get(s)?.name || s}`} onClick=${() => onChange(value.filter((x) => x !== s))}><${Icon} name="x" size=${14} /></button></li>`)}</ul>` : null}
    <div class="pr-people__add">
      <input id=${id} class="form-input" placeholder=${`Add ${label.toLowerCase()} by name`} value=${q} role="combobox" aria-expanded=${matches.length > 0} aria-controls=${`${id}-list`}
        aria-activedescendant=${matches[hi] ? `${id}-${hi}` : null} autocomplete="off"
        onInput=${(e) => { setQ(e.target.value); setHi(0); }}
        onKeyDown=${(e) => { if (e.key === 'ArrowDown') { e.preventDefault(); setHi((x) => Math.min(matches.length - 1, x + 1)); } else if (e.key === 'ArrowUp') { e.preventDefault(); setHi((x) => Math.max(0, x - 1)); } else if (e.key === 'Enter' && matches.length) { e.preventDefault(); add(matches[hi]); } else if (e.key === 'Escape') setQ(''); }} />
      ${matches.length ? html`<ul class="pr-combo__list" role="listbox" id=${`${id}-list`}>${matches.map((x, i) => html`<li key=${x.slug} id=${`${id}-${i}`} role="option" aria-selected=${i === hi} class=${`pr-combo__opt${i === hi ? ' is-hi' : ''}`}
        onMouseDown=${(e) => e.preventDefault()} onClick=${() => add(x)} onPointerEnter=${() => setHi(i)}><span class="pr-combo__name">${x.name}</span><span class="pr-combo__n">${sub(x)}</span></li>`)}</ul>` : null}
    </div>
  </div>`;
}

// ═══════════════════════════════════════════════════════════════════
// Found coverage: what the monitor found and did
// ═══════════════════════════════════════════════════════════════════
const SOURCES = [
  { id: 'google', name: 'Google News', every: 'every 3 hours' },
  { id: 'bing', name: 'Bing News', every: 'every 3 hours' },
  { id: 'youtube', name: 'YouTube', every: 'every 6 hours' },
];
const STATE_WORDS = { dismissed: 'Skipped', unrelated: 'Not about SOARD', duplicate: 'Already on the page', failed: 'Couldn’t be read', filed: 'Added' };

function FoundView({ c, error }) {
  const ov = c.ov;
  const [busy, setBusy] = useState(null);
  const [showSkipped, setShowSkipped] = useState(false);
  const [showAllChanges, setShowAllChanges] = useState(false);
  if (!ov) return error ? html`<div class="card pr-empty"><p><strong>${error}</strong></p><button type="button" class="btn btn-ghost" onClick=${c.loadOv}>Try again</button></div>` : html`<div class="pr-loading"><span class="spinner" /></div>`;
  const act = async (action, id, okText) => {
    setBusy(`${action}:${id}`);
    const j = await call('/api/press-admin', { action, id });
    setBusy(null);
    if (!j.success) { c.addToast(j.error || 'That didn’t work', 'error'); return null; }
    if (okText) c.addToast(okText, action === 'add' ? 'success' : 'info');
    await c.loadOv();
    c.onReload();
    if (action === 'add' || action === 'undo') window.dispatchEvent(new CustomEvent('soard-content-changed'));
    return j;
  };
  const review = ov.mentions.filter((m) => m.state === 'review');
  const waiting = ov.mentions.filter((m) => m.state === 'new').length;
  const filed = ov.mentions.filter((m) => m.state === 'filed').slice(0, 12);
  const skipped = ov.mentions.filter((m) => ['dismissed', 'unrelated', 'duplicate', 'failed'].includes(m.state));
  const st = ov.state;
  const tidying = (st.tidy?.version || 0) < st.tidyVersion;
  const changes = ov.log;
  const counts = st.tidy?.counts || {};
  const second = (st.tidy?.round || 0) > 1;
  const tidyBits = [
    counts.storiesLinked ? `${plural(counts.storiesLinked, 'story', 'stories')} linked to outlets` : null,
    counts.outletsCreated ? `${plural(counts.outletsCreated, 'outlet')} added` : null,
    counts.duplicatesRemoved ? `${plural(counts.duplicatesRemoved, 'duplicate')} merged` : null,
    counts.outletsMerged ? `${plural(counts.outletsMerged, 'outlet')} folded into ${counts.outletsMerged === 1 ? 'its twin' : 'their twins'}` : null,
    counts.googleLinksFixed ? `${plural(counts.googleLinksFixed, 'Google News link')} replaced` : null,
    counts.titlesCleaned ? `${plural(counts.titlesCleaned, 'headline')} tidied` : null,
    counts.pictures ? `${plural(counts.pictures, 'picture')} added` : null,
    counts.summaries ? `${plural(counts.summaries, 'summary', 'summaries')} rewritten` : null,
    counts.kidLinks ? `${plural(counts.kidLinks, 'kid link')}` : null,
    counts.kidLinksRemoved ? `${plural(counts.kidLinksRemoved, 'wrong kid link')} taken off` : null,
    counts.partnerLinks ? `${plural(counts.partnerLinks, 'partner link')}` : null,
  ].filter(Boolean);
  const storyOf = (slug) => c.press.find((s) => s.slug === slug);
  return html`
    <div class="page-header pr-head">
      <div>
        <h2>Found coverage</h2>
        <p class="page-sub">The press monitor looks for SOARD in the news and on TV stations’ YouTube channels. Clear stories go on the publicity page by themselves and the site publishes itself; anything it isn’t sure about waits here, and Slack hears about both.</p>
      </div>
    </div>
    <div class="pr-sources">
      ${SOURCES.map((s) => { const x = st.scans?.[s.id]; return html`<div class="card pr-source" key=${s.id}>
        <p class="pr-source__name">${s.name}</p>
        <p class="pr-source__when">${x?.at ? `Checked ${ago(x.at)}` : 'Not checked yet'}</p>
        <p class=${`pr-source__what${x?.error ? ' kd-bad' : ''}`}>${x?.error ? `Couldn’t reach it: ${x.error}${x.diag?.title ? ` (“${x.diag.title}”)` : ''}` : x?.at ? `${plural(x.found || 0, 'result')}, ${x.added || 0} new` : `Checks ${s.every}`}</p>
      </div>`; })}
      <div class="card pr-source">
        <p class="pr-source__name">Link check</p>
        <p class="pr-source__when">${st.sweep?.doneAt ? `Last ran ${ago(st.sweep.doneAt)}` : st.sweep?.cursor != null ? 'Running now' : tidying ? 'Starts after the tidy' : 'Not run yet'}</p>
        <p class="pr-source__what">Every link, weekly${st.sweep?.changes ? `. ${plural(st.sweep.changes, 'change')} last time` : ''}</p>
      </div>
    </div>

    ${tidying || tidyBits.length ? html`<section class=${`card pr-tidy${tidying ? ' is-running' : ''}`}>
      <h3>${second ? (tidying ? 'Taking a second look at every story' : 'Every story had a second look') : tidying ? 'Tidying the press list' : 'The press list was tidied'}${st.tidy?.doneAt ? html` <span class="pr-muted">${ago(st.tidy.doneAt)}</span>` : null}</h3>
      <p>${second && tidying ? 'Once, by itself: each story’s page read again for its picture (or its archived copy’s), the kids and partners it names linked, a kid whose makeover came after the story taken off, and Google News finds that never got their link tried again. Each change is listed below and can be undone.'
        : tidying ? 'Once, by itself: every story linked to its outlet, duplicates merged, Google News links swapped for the outlet’s own, pictures pulled from the stories, kids and partners linked. Each change is listed below and can be undone.' : 'Each change is listed below and can be undone.'}</p>
      ${tidyBits.length ? html`<p class="pr-tidy__bits">${tidyBits.join(' · ')}</p>` : null}
    </section>` : null}

    <section class="card pr-list" aria-labelledby="pr-review">
      <header class="pr-list__head"><h3 id="pr-review">Needs a look <span class="ppl-count">${review.length}</span></h3></header>
      ${review.length ? html`<ul class="pr-found">${review.map((m) => html`<${MentionRow} key=${m.id} m=${m} c=${c} busy=${busy}
        actions=${html`<button type="button" class="btn btn-primary btn-sm" disabled=${!!busy} onClick=${() => act('add', m.id, 'Added to the publicity page')}>${busy === `add:${m.id}` ? html`<span class="spinner spinner-14" /> Adding` : 'Add to the page'}</button>
          <button type="button" class="btn btn-ghost btn-sm" disabled=${!!busy} onClick=${() => act('skip', m.id, 'Skipped')}>Skip</button>`} />`)}</ul>`
        : html`<p class="pr-empty pr-empty--inline">Nothing waiting. ${waiting ? `${plural(waiting, 'more find is', 'more finds are')} still being checked by the monitor.` : filed.length ? 'The monitor handled everything it found.' : ''}</p>`}
    </section>

    ${filed.length ? html`<section class="card pr-list" aria-labelledby="pr-filed">
      <header class="pr-list__head"><h3 id="pr-filed">Added by the monitor</h3></header>
      <ul class="pr-found">${filed.map((m) => { const s = storyOf(m.story); const e = changes.find((x) => x.kind === 'filed' && x.slug === m.story && !x.undone_at); return html`<${MentionRow} key=${m.id} m=${m} c=${c} story=${s}
        actions=${html`${s ? html`<button type="button" class="btn btn-ghost btn-sm" onClick=${() => c.go({ tab: 'stories', slug: s.slug })}>Open</button>` : null}
          ${e ? html`<button type="button" class="btn btn-ghost btn-sm" disabled=${!!busy} onClick=${() => act('undo', e.id, 'Taken off the page')}><${Icon} name="undo" /> Undo</button>` : null}`} />`; })}</ul>
    </section>` : null}

    <section class="card pr-list" aria-labelledby="pr-changes">
      <header class="pr-list__head"><h3 id="pr-changes">What changed <span class="ppl-count">${changes.length}</span></h3></header>
      ${changes.length ? html`<ul class="pr-log">${(showAllChanges ? changes : changes.slice(0, 25)).map((e) => html`<li key=${e.id} class=${`pr-log__item${e.undone_at ? ' is-undone' : ''}`}>
        <span class="pr-log__when">${ago(e.at)}</span>
        <span class="pr-log__what">${e.slug && storyOf(e.slug) && !e.kind.startsWith('outlet') ? html`<button type="button" class="pr-linkbtn" onClick=${() => c.go({ tab: 'stories', slug: e.slug })}>${e.label}</button>` : e.label}
          ${e.undone_at ? html`<small>Undone by ${personName(e.undone_by)} ${ago(e.undone_at)}</small>` : null}</span>
        ${e.undone_at ? null : html`<button type="button" class="btn btn-ghost btn-sm" disabled=${!!busy} onClick=${async () => { const j = await act('undo', e.id, 'Put back'); if (j?.kept?.length) c.addToast(`Left alone (changed since): ${j.kept.map((k) => PS.FIELD_LABELS[k] || k).join(', ')}`, 'info'); }}><${Icon} name="undo" /> Undo</button>`}
      </li>`)}</ul>
      ${changes.length > 25 && !showAllChanges ? html`<button type="button" class="btn btn-ghost btn-sm pr-more" onClick=${() => setShowAllChanges(true)}>Show all ${changes.length}</button>` : null}`
        : html`<p class="pr-empty pr-empty--inline">No changes yet.</p>`}
    </section>

    ${skipped.length ? html`<section class="card pr-list">
      <button type="button" class="pr-disclose" aria-expanded=${showSkipped} onClick=${() => setShowSkipped((v) => !v)}><${Icon} name=${showSkipped ? 'up' : 'down'} /> Skipped and left out <span class="ppl-count">${skipped.length}</span></button>
      ${showSkipped ? html`<ul class="pr-found">${skipped.map((m) => html`<${MentionRow} key=${m.id} m=${m} c=${c} quiet=${true} story=${m.story ? storyOf(m.story) : null}
        actions=${m.state === 'duplicate' && m.story && storyOf(m.story) ? html`<button type="button" class="btn btn-ghost btn-sm" onClick=${() => c.go({ tab: 'stories', slug: m.story })}>Open the story</button>`
          : html`<button type="button" class="btn btn-ghost btn-sm" disabled=${!!busy} onClick=${() => act('add', m.id, 'Added to the publicity page')}>Add anyway</button>`} />`)}</ul>` : null}
    </section>` : null}

    <${SearchSettings} c=${c} />`;
}

function MentionRow({ m, c, actions, quiet = false, story = null }) {
  const host = PS.hostOf(m.url || m.link);
  return html`<li class=${`pr-mention${quiet ? ' is-quiet' : ''}`}>
    <div class="pr-mention__body">
      <p class="pr-mention__meta">
        <span class="pr-mention__src">${m.source || host || 'Unknown'}</span>
        ${story?.date || m.published ? html`<span>${longDate(String(story?.date || m.published).slice(0, 10))}</span>` : html`<span>Found ${ago(m.found_at)}</span>`}
        <span>${m.provider === 'youtube' ? 'YouTube' : m.provider === 'bing' ? 'Bing News' : 'Google News'}</span>
        ${quiet ? html`<span class="pr-chip">${STATE_WORDS[m.state] || m.state}</span>` : null}
      </p>
      <p class="pr-mention__title"><a href=${m.url || m.link} target="_blank" rel="noopener">${m.title}</a></p>
      ${m.summary && !quiet ? html`<p class="pr-mention__sum">${m.summary}</p>` : null}
      ${m.reason ? html`<p class="pr-mention__why">${m.reason}${m.decided_by ? ` · ${personName(m.decided_by)}` : ''}</p>` : null}
      ${story && m.state === 'filed' ? html`<p class="pr-mention__why">On the page as “${story.title}”</p>` : null}
    </div>
    <div class="pr-mention__actions">${actions}</div>
  </li>`;
}

function SearchSettings({ c }) {
  const s = c.ov.settings;
  const [queries, setQueries] = useState(s.queries);
  const [channels, setChannels] = useState(s.channels);
  const [newQ, setNewQ] = useState('');
  const [newCh, setNewCh] = useState('');
  const [busy, setBusy] = useState(false);
  const [finding, setFinding] = useState(false);
  useEffect(() => { setQueries(s.queries); setChannels(s.channels); }, [JSON.stringify(s)]);
  const dirty = !same(queries, s.queries) || !same(channels, s.channels);
  const save = async () => {
    setBusy(true);
    const j = await call('/api/press-admin', { action: 'settings', queries, channels });
    setBusy(false);
    if (!j.success) { c.addToast(j.error, 'error'); return; }
    c.addToast('Saved. The next check uses these.', 'info');
    c.loadOv();
  };
  const addChannel = async () => {
    setFinding(true);
    const j = await call('/api/press-admin', { action: 'channel', url: newCh });
    setFinding(false);
    if (!j.success) { c.addToast(j.error, 'error'); return; }
    if (channels.some((x) => x.id === j.channel.id)) { c.addToast(`${j.channel.name} is already on the list`, 'info'); return; }
    setChannels([...channels, j.channel]);
    setNewCh('');
  };
  return html`<section class="card pr-list pr-settings" aria-labelledby="pr-set">
    <header class="pr-list__head"><div><h3 id="pr-set">What it looks for</h3><p class="pr-sub">${s.updatedBy ? `Changed by ${personName(s.updatedBy)} ${ago(s.updatedAt)}.` : 'The standard searches.'} Quotes keep words together.</p></div></header>
    <div class="pr-set__grid">
      <div>
        <p class="form-label">Searches (Google News and Bing News)</p>
        <ul class="pr-people__chips">${queries.map((q, i) => html`<li key=${q} class="pr-people__chip"><span>${q}</span><button type="button" class="pr-icon-btn" aria-label=${`Remove ${q}`} disabled=${queries.length === 1} onClick=${() => setQueries(queries.filter((_, j) => j !== i))}><${Icon} name="x" size=${14} /></button></li>`)}</ul>
        <form class="pr-row-input" onSubmit=${(e) => { e.preventDefault(); const v = newQ.trim(); if (v && !queries.includes(v)) setQueries([...queries, v]); setNewQ(''); }}>
          <input class="form-input" placeholder="Add a search" aria-label="Add a search" value=${newQ} onInput=${(e) => setNewQ(e.target.value)} />
          <button type="submit" class="btn btn-ghost" disabled=${!newQ.trim()}>Add</button>
        </form>
      </div>
      <div>
        <p class="form-label">TV stations’ YouTube channels</p>
        <ul class="pr-people__chips">${channels.map((ch) => html`<li key=${ch.id} class="pr-people__chip"><span>${ch.name}</span><button type="button" class="pr-icon-btn" aria-label=${`Remove ${ch.name}`} onClick=${() => setChannels(channels.filter((x) => x.id !== ch.id))}><${Icon} name="x" size=${14} /></button></li>`)}</ul>
        <form class="pr-row-input" onSubmit=${(e) => { e.preventDefault(); if (newCh.trim()) addChannel(); }}>
          <input class="form-input" placeholder="youtube.com/@11Alive" aria-label="Add a YouTube channel by its address" value=${newCh} onInput=${(e) => setNewCh(e.target.value)} />
          <button type="submit" class="btn btn-ghost" disabled=${!newCh.trim() || finding}>${finding ? html`<span class="spinner spinner-14" />` : 'Add'}</button>
        </form>
        <p class="form-hint">YouTube is also searched for “Sunshine on a Ranney Day”. SOARD’s own channel is left out.</p>
      </div>
    </div>
    ${dirty ? html`<div class="pr-set__save"><button type="button" class="btn btn-ghost btn-sm" onClick=${() => { setQueries(s.queries); setChannels(s.channels); }}>Discard</button><button type="button" class="btn btn-primary btn-sm" disabled=${busy} onClick=${save}>${busy ? 'Saving…' : 'Save'}</button></div>` : null}
  </section>`;
}

// ═══════════════════════════════════════════════════════════════════
// Outlets
// ═══════════════════════════════════════════════════════════════════
const OUTLET_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'strip', label: 'In the strip' },
  { id: 'nologo', label: 'No logo' },
  { id: 'attention', label: 'Needs attention' },
];
function OutletsView({ c, initialOpen = undefined }) {
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('all');
  const [open, setOpen] = useState(initialOpen === undefined ? null : initialOpen); // slug, '' for new
  const [merging, setMerging] = useState(null);
  const [dismissed, setDismissed] = useState(() => { try { return new Set(JSON.parse(localStorage.getItem('soard-press-not-same') || '[]')); } catch { return new Set(); } });
  const stories = useMemo(() => { const m = new Map(); for (const s of c.press) { if (!m.has(s.outletLogo)) m.set(s.outletLogo, []); m.get(s.outletLogo).push(s); } return m; }, [c.press]);
  const needs = (o) => (stories.get(o.slug) || []).some((s) => s.featured && !s.image && !s.videoId) && !o.logo;
  const strip = c.outlets.filter(PS.inStrip).sort((a, b) => (a.order || 0) - (b.order || 0) || a.name.localeCompare(b.name));
  // Two records that look like one outlet: the same name once tidied, or one's other spelling is the other's name
  const pairs = useMemo(() => {
    const out = [];
    const list = c.outlets;
    for (let i = 0; i < list.length; i++) for (let j = i + 1; j < list.length; j++) {
      const a = list[i], b = list[j];
      const ka = PS.outletKeys(a), kb = PS.outletKeys(b);
      const hit = [...ka].some((k) => k.length >= 3 && kb.has(k));
      const key = [a.slug, b.slug].sort().join('|');
      if (hit && !dismissed.has(key)) out.push({ a, b, key });
    }
    return out;
  }, [c.outlets, dismissed]);
  const needle = q.trim().toLowerCase();
  const shown = c.outlets.filter((o) => {
    if (filter === 'strip' && !PS.inStrip(o)) return false;
    if (filter === 'nologo' && o.logo) return false;
    if (filter === 'attention' && !needs(o)) return false;
    return !needle || [o.name, ...(o.aliases || []), ...(o.domains || [])].some((v) => String(v).toLowerCase().includes(needle));
  }).sort((a, b) => (stories.get(b.slug)?.length || 0) - (stories.get(a.slug)?.length || 0) || a.name.localeCompare(b.name));
  const counts = { all: c.outlets.length, strip: strip.length, nologo: c.outlets.filter((o) => !o.logo).length, attention: c.outlets.filter(needs).length };
  const Dialog = c.kit.OutletDialog;
  const merge = async (from, into) => {
    setMerging(`${from.slug}|${into.slug}`);
    const j = await call('/api/press-admin', { action: 'mergeOutlets', from: from.slug, into: into.slug });
    setMerging(null);
    if (!j.success) { c.addToast(j.error, 'error'); return; }
    window.dispatchEvent(new CustomEvent('soard-content-changed'));
    c.addToast(`${from.name} merged into ${into.name}${j.moved ? `: ${plural(j.moved, 'story', 'stories')} moved` : ''}. Undo it in Found coverage → What changed.`, 'success');
    c.onReload();
    c.loadOv();
  };
  const notSame = (key) => { const n = new Set(dismissed); n.add(key); setDismissed(n); try { localStorage.setItem('soard-press-not-same', JSON.stringify([...n])); } catch { /* fine */ } };
  return html`
    <div class="page-header pr-head">
      <div>
        <h2>Outlets</h2>
        <p class="page-sub">Every outlet that has covered SOARD. Each story links to one, so its name reads the same everywhere. Outlets with a logo can join the “As Featured” strip on the home, donate, resources and publicity pages.</p>
      </div>
      <div class="pr-head__actions">
        ${Dialog ? html`<button type="button" class="btn btn-primary" onClick=${() => setOpen('')}><${Icon} name="plus" /> Add an outlet</button>` : null}
      </div>
    </div>
    <${StripOrder} c=${c} strip=${strip} onOpen=${(s) => setOpen(s)} />
    ${pairs.length ? html`<section class="card pr-list" aria-labelledby="pr-pairs">
      <header class="pr-list__head"><div><h3 id="pr-pairs">These look like one outlet <span class="ppl-count">${pairs.length}</span></h3><p class="pr-sub">Merging moves the stories, other spellings and websites into the one you keep.</p></div></header>
      <ul class="pr-pairs">${pairs.map(({ a, b, key }) => {
        const [keep, drop] = (stories.get(a.slug)?.length || 0) + (a.logo ? 100 : 0) >= (stories.get(b.slug)?.length || 0) + (b.logo ? 100 : 0) ? [a, b] : [b, a];
        return html`<li key=${key} class="pr-pair">
          <span class="pr-pair__names"><${OutletMark} outlet=${drop} size=${28} /> <strong>${drop.name}</strong> <span class="pr-muted">(${plural(stories.get(drop.slug)?.length || 0, 'story', 'stories')})</span> <${Icon} name="merge" /> <${OutletMark} outlet=${keep} size=${28} /> <strong>${keep.name}</strong> <span class="pr-muted">(${plural(stories.get(keep.slug)?.length || 0, 'story', 'stories')})</span></span>
          <span class="pr-pair__actions">
            <button type="button" class="btn btn-primary btn-sm" disabled=${!!merging} onClick=${() => merge(drop, keep)}>${merging === `${drop.slug}|${keep.slug}` ? html`<span class="spinner spinner-14" /> Merging` : `Merge into ${keep.name}`}</button>
            <button type="button" class="btn btn-ghost btn-sm" onClick=${() => notSame(key)}>Not the same</button>
          </span>
        </li>`; })}</ul>
    </section>` : null}
    <section class="card pr-list" aria-labelledby="pr-outlets">
      <header class="pr-list__head">
        <h3 id="pr-outlets">All outlets <span class="ppl-count">${shown.length}</span></h3>
        <div class="pr-search"><${Icon} name="search" /><input type="search" class="form-input" placeholder="Search outlets" aria-label="Search outlets" value=${q} onInput=${(e) => setQ(e.target.value)} /></div>
      </header>
      <div class="pr-pills" role="group" aria-label="Show">
        ${OUTLET_FILTERS.map((f) => counts[f.id] || f.id === 'all' || filter === f.id ? html`<button type="button" key=${f.id} class="pr-pill" aria-pressed=${filter === f.id} onClick=${() => setFilter(filter === f.id && f.id !== 'all' ? 'all' : f.id)}>${f.label} <span>${counts[f.id]}</span></button>` : null)}
      </div>
      <ul class="pr-outlets">${shown.map((o) => { const n = stories.get(o.slug)?.length || 0; return html`<li key=${o.slug}>
        <button type="button" class="pr-outlet" onClick=${() => Dialog && setOpen(o.slug)} disabled=${!Dialog}>
          <${OutletMark} outlet=${o} size=${44} />
          <span class="pr-outlet__body">
            <span class="pr-outlet__name">${o.name}</span>
            <span class="pr-outlet__meta">${[plural(n, 'story', 'stories'), o.kind ? PS.CATEGORY_LABELS[o.kind] : null, (o.domains || [])[0]].filter(Boolean).join(' · ')}</span>
            <span class="pr-row__chips">
              ${PS.inStrip(o) ? html`<span class="pr-chip pr-chip--on">In the strip</span>` : null}
              ${needs(o) ? html`<span class="pr-chip pr-chip--warn" title="A featured story shows this outlet’s name in plain type">Featured story needs a logo or picture</span>` : null}
              ${(o.aliases || []).length ? html`<span class="pr-chip" title=${o.aliases.join(', ')}>${plural(o.aliases.length, 'other spelling')}</span>` : null}
            </span>
          </span>
        </button>
      </li>`; })}</ul>
      ${!shown.length ? html`<p class="pr-empty pr-empty--inline">No outlets match.</p>` : null}
    </section>
    ${open !== null && Dialog ? html`<${Dialog} key=${open || 'new'} slug=${open || null} logos=${c.outlets} press=${c.press} addToast=${c.addToast}
      onClose=${() => setOpen(null)} onSaved=${() => { setOpen(null); c.onReload(); }} />` : null}`;
}

/** The "As Featured" strip as visitors see it, in its order */
function StripOrder({ c, strip, onOpen }) {
  const [order, setOrder] = useState(strip.map((o) => o.slug));
  const [busy, setBusy] = useState(false);
  const ref = useRef(null);
  const key = strip.map((o) => `${o.slug}:${o.order}`).join(',');
  useEffect(() => { setOrder(strip.map((o) => o.slug)); }, [key]);
  const by = new Map(strip.map((o) => [o.slug, o]));
  const save = async (next, prev) => {
    setOrder(next);
    setBusy(true);
    const j = await call('/api/reorder-content', { collection: 'medialogos', items: next.map((slug, i) => ({ slug, order: i })) });
    setBusy(false);
    if (!j.success) { setOrder(prev); c.addToast(`Couldn’t save the order: ${j.error}`, 'error'); return; }
    window.dispatchEvent(new CustomEvent('soard-content-changed'));
    c.addToast('Strip order saved', 'success', { label: 'Undo', fn: () => save(prev, next) });
    c.onReload();
  };
  useEffect(() => {
    if (!ref.current || !Sortable) return undefined;
    const s = Sortable.create(ref.current, {
      animation: prefersReducedMotion() ? 0 : 150, ghostClass: 'is-ghost', direction: 'horizontal',
      onEnd: (e) => {
        if (e.oldIndex === e.newIndex) return;
        save(undoSortableMove(e, order), order);
      },
    });
    return () => s.destroy();
  }, [order.join(',')]);
  const move = (i, d) => { const j = i + d; if (j < 0 || j >= order.length) return; const next = [...order]; [next[i], next[j]] = [next[j], next[i]]; save(next, order); };
  return html`<section class="card pr-strip" aria-labelledby="pr-strip-h">
    <header class="pr-list__head">
      <div><h3 id="pr-strip-h">“As Featured” strip <span class="ppl-count">${strip.length}</span></h3><p class="pr-sub">What visitors see, in this order: dimmed until they point at it. Drag to reorder, or open a logo to move it with the keyboard.</p></div>
      ${busy ? html`<span class="pr-saving"><span class="spinner spinner-14" /> Saving order</span>` : null}
    </header>
    ${strip.length ? html`<ol class="pr-strip__row" ref=${ref}>${order.map((slug, i) => { const o = by.get(slug); return o ? html`<li key=${slug} class="pr-strip__item">
      <button type="button" class="pr-strip__logo" onClick=${() => onOpen(slug)} aria-label=${`${o.name}, position ${i + 1}. Open`}><img src=${cfImg(o.logo, 'w=320,q=75')} alt="" /></button>
      <span class="pr-strip__moves">
        <button type="button" class="pr-icon-btn" disabled=${i === 0 || busy} aria-label=${`Move ${o.name} earlier`} onClick=${() => move(i, -1)}><${Icon} name="back" size=${14} /></button>
        <button type="button" class="pr-icon-btn pr-flip" disabled=${i === order.length - 1 || busy} aria-label=${`Move ${o.name} later`} onClick=${() => move(i, 1)}><${Icon} name="back" size=${14} /></button>
      </span>
    </li>` : null; })}</ol>` : html`<p class="pr-empty pr-empty--inline">No outlet is in the strip. Open an outlet with a logo and switch on “In the As Featured strip”.</p>`}
  </section>`;
}

// ═══════════════════════════════════════════════════════════════════
// Styles (the admin's tokens; light and dark)
// ═══════════════════════════════════════════════════════════════════
const CSS = `
.pr-root { --pr-gap: 16px; }
.pr-root .hub-tab { display: inline-flex; align-items: center; gap: 6px; }
.pr-tab-badge { min-width: 20px; height: 20px; padding: 0 6px; border-radius: 10px; background: var(--color-primary); color: #1A1B1F; font-size: 11px; font-weight: 700; display: inline-flex; align-items: center; justify-content: center; }
.pr-head { align-items: flex-start; gap: 16px; }
.pr-head .page-sub { max-width: 68ch; }
.pr-head__actions { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.pr-sub { color: var(--color-text-secondary); font-size: 13px; margin-top: 2px; max-width: 70ch; }
.pr-muted { color: var(--color-text-muted); font-weight: 400; font-size: 13px; }
.pr-hint, .pr-saving { color: var(--color-text-muted); font-size: 12px; display: inline-flex; gap: 6px; align-items: center; white-space: nowrap; }
.pr-loading { display: flex; justify-content: center; padding: 48px; }
.pr-empty { text-align: center; padding: 32px 16px; color: var(--color-text-secondary); display: grid; gap: 12px; justify-items: center; }
.pr-empty--inline { text-align: left; padding: 4px 0 8px; display: block; }
.pr-linkbtn { background: none; border: 0; padding: 0; color: inherit; font: inherit; text-decoration: underline; text-underline-offset: 2px; cursor: pointer; text-align: left; }
.pr-linkbtn:hover { color: var(--color-text); text-decoration-color: var(--color-primary); }
.pr-icon-btn { width: 32px; height: 32px; border-radius: 8px; border: 1px solid transparent; background: transparent; color: var(--color-text-secondary); display: inline-flex; align-items: center; justify-content: center; cursor: pointer; flex: none; }
.pr-icon-btn:hover:not(:disabled) { background: var(--color-bg-hover); color: var(--color-text); }
.pr-icon-btn:disabled { opacity: 0.35; cursor: default; }
.pr-icon-btn:focus-visible, .pr-row__open:focus-visible, .pr-feat__open:focus-visible, .pr-outlet:focus-visible, .pr-strip__logo:focus-visible, .pr-pill:focus-visible, .pr-seg__btn:focus-visible, .pr-disclose:focus-visible { outline: none; box-shadow: var(--focus-ring-strong); }
.pr-flip svg { transform: scaleX(-1); }

/* The monitor's line (under Where things stand) */
.pr-monitor__dot { width: 10px; height: 10px; border-radius: 50%; background: var(--color-primary); box-shadow: 0 0 0 4px var(--color-primary-ring); flex: none; animation: pr-pulse 2.4s ease-in-out infinite; }
@keyframes pr-pulse { 50% { box-shadow: 0 0 0 7px transparent; } }
.pr-monitor__go { font-size: 13px; font-weight: 600; white-space: nowrap; text-decoration: underline; text-decoration-color: var(--color-primary); text-underline-offset: 3px; }

/* Where things stand */
.pr-status { margin-bottom: var(--pr-gap); padding: 0; overflow: hidden; }
.pr-status__grid { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); }
.pr-stat { display: grid; align-content: start; gap: 6px; padding: 16px 18px; min-width: 0; text-align: left; font: inherit; color: inherit; }
.pr-stat + .pr-stat { border-left: 1px solid var(--color-border); }
.pr-stat--btn { background: transparent; border: 0; border-radius: 0; cursor: pointer; }
.pr-stat--btn:hover { background: var(--color-bg-hover); }
.pr-stat--btn:focus-visible, .pr-status__foot:focus-visible { outline: none; box-shadow: inset var(--focus-ring-strong); }
.pr-stat__label { font-size: 11.5px; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--color-text-muted); }
.pr-stat__big { display: flex; align-items: center; gap: 8px; font-size: 22px; font-weight: 700; line-height: 1.2; color: var(--color-text); }
.pr-stat__of { font-size: 15px; font-weight: 600; color: var(--color-text-muted); }
.pr-stat.is-ok .pr-stat__big svg { color: var(--color-success); }
.pr-stat.is-warn .pr-stat__big svg { color: var(--color-warning); }
.pr-stat__sub { font-size: 12.5px; line-height: 1.45; color: var(--color-text-secondary); }
.pr-stat__acts { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 4px; }
.pr-faces { display: flex; align-items: center; padding-left: 6px; margin: 2px 0; }
.pr-faces .pr-face { margin-left: -6px; box-shadow: 0 0 0 2px var(--color-bg-card); }
.pr-stat--btn:hover .pr-faces .pr-face { box-shadow: 0 0 0 2px var(--color-bg-hover); }
.pr-face { width: var(--s, 22px); height: var(--s, 22px); border-radius: 50%; object-fit: cover; flex: none; background: var(--color-bg-secondary); display: inline-block; }
.pr-face--text, .pr-face--more { display: inline-flex; align-items: center; justify-content: center; font-size: calc(var(--s, 22px) * 0.38); font-weight: 700; color: var(--color-text-muted); }
.pr-meter { display: block; height: 6px; border-radius: 3px; background: var(--color-bg-secondary); overflow: hidden; margin: 4px 0 2px; }
.pr-meter span { display: block; height: 100%; border-radius: 3px; background: var(--color-primary); }
.pr-status__foot { width: 100%; display: flex; align-items: center; gap: 12px; padding: 10px 18px; border: 0; border-top: 1px solid var(--color-border); background: var(--color-bg-secondary); font: inherit; font-size: 13px; color: var(--color-text-secondary); text-align: left; cursor: pointer; }
.pr-status__foot > span:nth-child(2) { flex: 1; }
.pr-status__foot strong { color: var(--color-text); }
.pr-status__foot:hover { color: var(--color-text); }

/* Who a story is about */
.pr-row__who { display: flex; flex-wrap: wrap; gap: 4px 6px; margin-top: 3px; }
.pr-who { display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 8px; border-radius: 12px; background: var(--color-bg-secondary); border: 1px solid var(--color-border); font-size: 12px; font-weight: 500; color: var(--color-text-secondary); max-width: 100%; }
.pr-who--kid { padding-left: 2px; color: var(--color-text); }
.pr-who small { font-size: 11px; color: var(--color-text-muted); }
.pr-who--more { background: transparent; }

/* Lists */
.pr-list, .pr-feat, .pr-strip { margin-bottom: var(--pr-gap); }
.pr-list__head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
.pr-list__head h3 { font-size: 15px; display: flex; align-items: center; gap: 8px; }
.pr-search { position: relative; flex: 0 1 320px; min-width: 200px; }
.pr-search svg { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); color: var(--color-text-muted); pointer-events: none; }
.pr-search .form-input { padding-left: 32px; }
.pr-pills { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 12px; }
.pr-pill { display: inline-flex; align-items: center; gap: 6px; height: 32px; padding: 0 12px; border-radius: 16px; border: 1px solid var(--color-border); background: var(--color-bg-card); color: var(--color-text-secondary); font: inherit; font-size: 13px; font-weight: 500; cursor: pointer; }
.pr-pill span { font-size: 11px; font-weight: 700; padding: 1px 7px; border-radius: 10px; background: var(--color-bg-secondary); color: var(--color-text-muted); }
.pr-pill:hover { border-color: var(--color-border-strong); color: var(--color-text); }
.pr-pill[aria-pressed="true"] { background: var(--color-text); border-color: var(--color-text); color: var(--color-bg-card); }
.pr-pill[aria-pressed="true"] span { background: rgba(255,255,255,0.18); color: inherit; }
.pr-year + .pr-year { margin-top: 8px; }
.pr-year__label { position: sticky; top: 0; z-index: 1; display: flex; align-items: center; gap: 8px; padding: 8px 0 6px; background: var(--color-bg-card); font-size: 12px; font-weight: 700; letter-spacing: 0.06em; color: var(--color-text-muted); }
.pr-year__n { font-weight: 600; letter-spacing: 0; }
.pr-rows, .pr-found, .pr-log, .pr-outlets, .pr-pairs, .pr-needs { list-style: none; margin: 0; padding: 0; }
.pr-row + .pr-row { border-top: 1px solid var(--color-border); }
.pr-row__open { width: 100%; display: flex; gap: 14px; align-items: flex-start; padding: 10px 8px; border: 0; background: transparent; text-align: left; font: inherit; color: inherit; cursor: pointer; border-radius: var(--radius-sm); }
.pr-row__open:hover { background: var(--color-bg-hover); }
.pr-row__body { flex: 1; min-width: 0; display: grid; gap: 3px; }
.pr-row__title { font-weight: 600; font-size: 14px; line-height: 1.35; color: var(--color-text); display: block; overflow-wrap: anywhere; }
.pr-star { color: var(--color-primary-ink); margin-right: 5px; vertical-align: -1px; }
.pr-star svg { fill: var(--color-primary); }
.pr-row__meta { display: flex; flex-wrap: wrap; gap: 2px 12px; font-size: 12.5px; color: var(--color-text-secondary); }
.pr-row__outlet { font-weight: 600; color: var(--color-text); }
.pr-row__chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 3px; }
.pr-chip { display: inline-flex; align-items: center; height: 22px; padding: 0 8px; border-radius: 6px; background: var(--color-bg-secondary); border: 1px solid var(--color-border); color: var(--color-text-secondary); font-size: 11.5px; font-weight: 500; white-space: nowrap; }
.pr-chip--warn { background: var(--color-primary-bg); border-color: rgba(214, 158, 46, 0.45); color: var(--color-text); }
.pr-chip--draft { background: var(--color-bg); border-style: dashed; }
.pr-chip--auto { border-color: var(--color-border-strong); }
.pr-chip--on { background: var(--color-text); border-color: var(--color-text); color: var(--color-bg-card); }

/* Thumbnails and outlet marks */
.pr-thumb { position: relative; width: var(--w); height: var(--h); flex: none; border-radius: 8px; overflow: hidden; background: var(--color-bg-secondary); border: 1px solid var(--color-border); display: inline-flex; align-items: center; justify-content: center; }
.pr-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
.pr-thumb--logo { background: #fff; }
.pr-thumb--logo img { object-fit: contain; padding: 10%; }
.pr-thumb--text { font-weight: 800; font-size: calc(var(--h) / 3); letter-spacing: 0.02em; color: var(--color-text-muted); background: var(--color-bg); }
.pr-thumb__play { position: absolute; inset: auto 6px 6px auto; width: 22px; height: 22px; border-radius: 50%; background: rgba(26,27,31,0.75); color: #fff; display: flex; align-items: center; justify-content: center; }
.pr-omark { width: calc(var(--s) * 1.6); height: var(--s); flex: none; border-radius: 6px; background: #fff; border: 1px solid var(--color-border); display: inline-flex; align-items: center; justify-content: center; overflow: hidden; }
.pr-omark img { max-width: 86%; max-height: 76%; object-fit: contain; }
.pr-omark--text { background: var(--color-bg); font-weight: 800; font-size: calc(var(--s) * 0.36); color: var(--color-text-muted); }

/* Featured order */
.pr-feat__list { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.pr-feat__item { display: flex; align-items: center; gap: 8px; padding: 6px; border: 1px solid var(--color-border); border-radius: var(--radius-sm); background: var(--color-bg-card); }
.pr-feat__item.is-ghost { opacity: 0.5; }
.pr-feat__item.is-lead { border-color: var(--color-border-strong); background: var(--color-bg-secondary); }
.pr-feat__grip { width: 28px; height: 44px; border: 0; background: transparent; color: var(--color-text-muted); cursor: grab; flex: none; display: inline-flex; align-items: center; justify-content: center; touch-action: none; }
.pr-feat__n { width: 22px; text-align: center; font-weight: 700; font-size: 13px; color: var(--color-text-muted); flex: none; }
.pr-feat__open { flex: 1; min-width: 0; display: flex; align-items: center; gap: 12px; border: 0; background: transparent; font: inherit; color: inherit; text-align: left; cursor: pointer; padding: 2px; border-radius: 6px; }
.pr-feat__text { display: grid; gap: 2px; min-width: 0; }
.pr-feat__title { font-weight: 600; line-height: 1.3; overflow-wrap: anywhere; }
.is-lead .pr-feat__title { font-size: 15px; }
.pr-feat__meta { font-size: 12.5px; color: var(--color-text-secondary); }
.pr-feat__moves { display: flex; gap: 2px; flex: none; }

/* Add a story */
.pr-add { display: grid; gap: 6px; }
.pr-filled { display: grid; gap: 12px; }
.pr-filled__card { display: flex; gap: 16px; align-items: flex-start; }
.pr-filled__outlet { font-size: 12.5px; color: var(--color-text-secondary); display: flex; gap: 6px; flex-wrap: wrap; align-items: center; }
.pr-filled__title { font-weight: 700; font-size: 16px; line-height: 1.3; margin: 4px 0; }
.pr-filled__sum { color: var(--color-text-secondary); font-size: 13.5px; }
.pr-filled__people { margin-top: 6px; font-size: 12.5px; color: var(--color-text-secondary); }
.pr-note { display: flex; gap: 10px; align-items: flex-start; padding: 10px 12px; border-radius: var(--radius-sm); background: var(--color-bg-secondary); border: 1px solid var(--color-border); font-size: 13px; }
.pr-note svg { flex: none; margin-top: 2px; color: var(--color-warning); }
.pr-note--warn { background: var(--color-primary-bg); border-color: rgba(214, 158, 46, 0.45); }

/* The editor */
.pr-bar { position: sticky; top: 0; z-index: 30; display: flex; align-items: center; gap: 10px; padding: 10px 0 12px; margin-bottom: 8px; background: var(--color-bg); border-bottom: 1px solid var(--color-border); }
.pr-bar__title { flex: 1; min-width: 0; }
.pr-bar__crumb { font-size: 12px; color: var(--color-text-muted); display: flex; align-items: center; gap: 8px; min-height: 22px; }
.pr-bar__title h2 { font-size: 1.25rem; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pr-bar__state { font-size: 12.5px; color: var(--color-text-muted); white-space: nowrap; }
.pr-editor__grid { display: grid; grid-template-columns: minmax(0, 1fr) 300px; gap: var(--pr-gap); align-items: start; }
.pr-editor__main { display: grid; gap: var(--pr-gap); min-width: 0; }
.pr-card h3, .pr-side__card h3 { font-size: 15px; margin-bottom: 12px; }
.pr-card h3 + .pr-sub { margin: -6px 0 14px; }
.pr-card .form-group + .form-group, .pr-card .pr-two + .form-group, .pr-card .form-group + .pr-two { margin-top: 14px; }
.pr-two { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr); gap: 14px; }
.pr-row-input { display: flex; gap: 8px; align-items: stretch; }
.pr-row-input .form-input { flex: 1; min-width: 0; }
.pr-row-input .btn { white-space: nowrap; display: inline-flex; align-items: center; gap: 6px; }
.pr-open { width: 40px; padding: 0; justify-content: center; }
.pr-seg { display: flex; flex-wrap: wrap; gap: 6px; }
.pr-seg__btn { height: 34px; padding: 0 12px; border-radius: 8px; border: 1px solid var(--color-border); background: var(--color-bg-card); color: var(--color-text-secondary); font: inherit; font-size: 13px; cursor: pointer; }
.pr-seg__btn:hover { border-color: var(--color-border-strong); color: var(--color-text); }
.pr-seg__btn[aria-checked="true"] { background: var(--color-text); border-color: var(--color-text); color: var(--color-bg-card); font-weight: 600; }
.pr-side { position: sticky; top: 76px; display: grid; gap: var(--pr-gap); }
.pr-side--stacked { position: static; }
.pr-side__card { padding: 16px !important; }
.pr-side__p { font-size: 13px; color: var(--color-text-secondary); }
.pr-side__p + .pr-side__p { margin-top: 8px; }
.pr-side__p a { color: var(--color-text); }
.pr-side__links { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 12px; }
.pr-side__links .btn { display: inline-flex; gap: 6px; align-items: center; }
.pr-switch { display: flex; gap: 10px; align-items: flex-start; padding: 8px 0; cursor: pointer; }
.pr-switch + .pr-switch { border-top: 1px solid var(--color-border); }
.pr-switch input { appearance: none; width: 36px; height: 20px; border-radius: 10px; background: var(--color-border-strong); position: relative; flex: none; margin-top: 2px; cursor: pointer; transition: background 0.15s; }
.pr-switch input::after { content: ''; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgba(0,0,0,0.2); transition: transform 0.15s var(--ease-out); }
.pr-switch input:checked { background: var(--color-text); }
.pr-switch input:checked::after { transform: translateX(16px); }
.pr-switch input:focus-visible { outline: none; box-shadow: var(--focus-ring-strong); }
.pr-switch span { display: grid; gap: 2px; font-size: 13.5px; }
.pr-switch small { color: var(--color-text-secondary); font-size: 12.5px; }
.pr-needs li { display: grid; gap: 2px; padding: 8px 0 8px 12px; border-left: 3px solid var(--color-border); font-size: 13px; }
.pr-needs li + li { margin-top: 6px; }
.pr-needs li.is-warn { border-left-color: var(--color-primary); }
.pr-needs span { color: var(--color-text-secondary); font-size: 12.5px; }
.pr-dupes { list-style: none; margin: 8px 0 0; padding: 0; display: grid; gap: 8px; }
.pr-dupes li { display: grid; gap: 4px; justify-items: start; }
.pr-dupes small { color: var(--color-text-muted); font-size: 12px; }
.pr-delete { justify-self: start; display: inline-flex; gap: 6px; align-items: center; color: var(--color-text-secondary); }
.pr-delete:hover { color: var(--color-danger); }
.pr-pic { display: grid; grid-template-columns: 320px minmax(0, 1fr); gap: 16px; align-items: start; }
.pr-pic__thumb { width: 100% !important; height: auto !important; aspect-ratio: 16 / 10; }
.pr-pic__says { margin-top: 8px; font-size: 12.5px; color: var(--color-text-secondary); }
.pr-pic__tools { display: grid; gap: 12px; }
.pr-btns { display: flex; flex-wrap: wrap; gap: 6px; }
.pr-btns .btn { display: inline-flex; gap: 6px; align-items: center; }
.pr-pic__from { font-size: 12px; color: var(--color-text-muted); margin-top: 6px; }
.pr-people__chip.pr-people__chip--face { padding-left: 4px; gap: 6px; }
.pr-kidpics { display: grid; gap: 6px; }
.pr-kidpics__label { display: flex; align-items: center; gap: 8px; font-size: 12.5px; font-weight: 600; color: var(--color-text-secondary); }
.pr-kidpics__row { display: flex; flex-wrap: wrap; gap: 6px; }
.pr-kidpic { width: 96px; height: 64px; padding: 0; border-radius: 6px; overflow: hidden; border: 2px solid transparent; background: var(--color-bg-secondary); cursor: pointer; flex: none; }
.pr-kidpic img { width: 100%; height: 100%; object-fit: cover; display: block; }
.pr-kidpic:hover { border-color: var(--color-border-strong); }
.pr-kidpic[aria-pressed="true"] { border-color: var(--color-primary); }
.pr-kidpic:focus-visible { outline: none; box-shadow: var(--focus-ring-strong); }
.pr-suggest { display: flex; gap: 10px; align-items: center; padding: 8px; border-radius: var(--radius-sm); border: 1px dashed var(--color-border-strong); background: var(--color-bg-secondary); font-size: 12.5px; }
.pr-suggest img { width: 80px; height: 50px; object-fit: cover; border-radius: 4px; flex: none; }
.pr-suggest span { flex: 1; color: var(--color-text-secondary); }
.pr-video { margin: 0; }
.pr-combo { position: relative; }
.pr-combo__field { display: flex; align-items: center; gap: 8px; }
.pr-combo__field .form-input { flex: 1; min-width: 0; }
.pr-combo__list { position: absolute; z-index: 40; left: 0; right: 0; top: calc(100% + 4px); max-height: 300px; overflow: auto; list-style: none; margin: 0; padding: 4px; background: var(--color-bg-card); border: 1px solid var(--color-border-strong); border-radius: var(--radius-sm); box-shadow: var(--shadow-lg); }
.pr-combo__opt { display: flex; align-items: center; gap: 10px; padding: 8px; border-radius: 6px; cursor: pointer; min-height: 40px; }
.pr-combo__opt.is-hi { background: var(--color-bg-hover); }
.pr-combo__name { flex: 1; min-width: 0; font-weight: 500; }
.pr-combo__n { font-size: 12px; color: var(--color-text-muted); white-space: nowrap; }
.pr-combo__none { padding: 10px; color: var(--color-text-muted); }
.pr-people + .pr-people { margin-top: 14px; }
.pr-people__chips { list-style: none; margin: 4px 0 8px; padding: 0; display: flex; flex-wrap: wrap; gap: 6px; }
.pr-people__chip { display: inline-flex; align-items: center; gap: 2px; height: 32px; padding-left: 12px; border-radius: 16px; background: var(--color-bg-secondary); border: 1px solid var(--color-border); font-size: 13px; font-weight: 500; }
.pr-people__chip .pr-icon-btn { width: 28px; height: 28px; border-radius: 14px; }
.pr-people__chip small { color: var(--color-text-muted); }
.pr-people__add { position: relative; }
.pr-clash { border: 0; margin: 0 0 12px; padding: 0; }
.pr-clash legend { font-weight: 600; margin-bottom: 6px; }
.pr-clash__opt { display: flex; gap: 10px; align-items: flex-start; padding: 10px; border: 1px solid var(--color-border); border-radius: var(--radius-sm); cursor: pointer; }
.pr-clash__opt + .pr-clash__opt { margin-top: 6px; }
.pr-clash__opt.is-on { border-color: var(--color-text); }
.pr-clash__opt span { display: grid; gap: 2px; }
.pr-clash__opt small { color: var(--color-text-secondary); overflow-wrap: anywhere; }

/* Found coverage */
.pr-sources { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin-bottom: var(--pr-gap); }
.pr-source { padding: 14px 16px !important; }
.pr-source__name { font-weight: 700; font-size: 13px; }
.pr-source__when { font-size: 12.5px; color: var(--color-text-secondary); margin-top: 2px; }
.pr-source__what { font-size: 12.5px; color: var(--color-text-muted); margin-top: 2px; }
.pr-tidy { margin-bottom: var(--pr-gap); border-left: 4px solid var(--color-border-strong) !important; }
.pr-tidy.is-running { border-left-color: var(--color-primary) !important; }
.pr-tidy h3 { font-size: 15px; margin-bottom: 4px; }
.pr-tidy p { font-size: 13px; color: var(--color-text-secondary); max-width: 80ch; }
.pr-tidy__bits { margin-top: 8px; color: var(--color-text) !important; font-weight: 500; }
.pr-mention { display: flex; gap: 16px; align-items: flex-start; padding: 12px 0; }
.pr-mention + .pr-mention { border-top: 1px solid var(--color-border); }
.pr-mention__body { flex: 1; min-width: 0; display: grid; gap: 4px; }
.pr-mention__meta { display: flex; flex-wrap: wrap; gap: 4px 12px; font-size: 12.5px; color: var(--color-text-secondary); align-items: center; }
.pr-mention__src { font-weight: 700; color: var(--color-text); }
.pr-mention__title a { font-weight: 600; color: var(--color-text); text-decoration: none; overflow-wrap: anywhere; }
.pr-mention__title a:hover { text-decoration: underline; text-decoration-color: var(--color-primary); text-underline-offset: 3px; }
.pr-mention__sum { font-size: 13px; color: var(--color-text-secondary); }
.pr-mention__why { font-size: 12.5px; color: var(--color-text-muted); }
.pr-mention.is-quiet .pr-mention__title a { font-weight: 500; }
.pr-mention__actions { display: flex; gap: 6px; flex: none; flex-wrap: wrap; justify-content: flex-end; }
.pr-mention__actions .btn { display: inline-flex; gap: 6px; align-items: center; }
.pr-log__item { display: grid; grid-template-columns: 110px minmax(0, 1fr) auto; gap: 12px; align-items: center; padding: 8px 0; font-size: 13px; }
.pr-log__item + .pr-log__item { border-top: 1px solid var(--color-border); }
.pr-log__when { color: var(--color-text-muted); font-size: 12.5px; }
.pr-log__what { display: grid; gap: 2px; overflow-wrap: anywhere; }
.pr-log__what small { color: var(--color-text-muted); }
.pr-log__item.is-undone .pr-log__what > :first-child { text-decoration: line-through; color: var(--color-text-muted); }
.pr-log__item .btn { display: inline-flex; gap: 6px; align-items: center; }
.pr-more { margin-top: 8px; }
.pr-disclose { display: flex; align-items: center; gap: 8px; width: 100%; padding: 4px 0; border: 0; background: transparent; font: inherit; font-weight: 600; font-size: 15px; color: var(--color-text); cursor: pointer; text-align: left; border-radius: 6px; }
.pr-set__grid { display: grid; grid-template-columns: 1fr 1fr; gap: 24px; }
.pr-set__save { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; padding-top: 12px; border-top: 1px solid var(--color-border); }

/* Outlets */
.pr-strip__row { list-style: none; margin: 0; padding: 20px 16px; display: flex; flex-wrap: wrap; justify-content: center; gap: 16px 32px; background: var(--color-bg-secondary); border-radius: var(--radius-sm); }
.pr-strip__item { display: grid; justify-items: center; gap: 4px; cursor: grab; }
.pr-strip__item.is-ghost { opacity: 0.4; }
.pr-strip__logo { border: 0; background: transparent; padding: 6px; border-radius: 6px; cursor: pointer; opacity: 0.55; transition: opacity 0.2s; }
.pr-strip__logo:hover, .pr-strip__logo:focus-visible { opacity: 1; }
.pr-strip__logo img { height: 40px; width: auto; max-width: 170px; object-fit: contain; display: block; }
.pr-strip__moves { display: flex; gap: 2px; opacity: 0; transition: opacity 0.15s; }
.pr-strip__item:hover .pr-strip__moves, .pr-strip__item:focus-within .pr-strip__moves { opacity: 1; }
.pr-outlets { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 8px; }
.pr-outlet { width: 100%; height: 100%; display: flex; gap: 12px; align-items: flex-start; padding: 12px; border: 1px solid var(--color-border); border-radius: var(--radius-sm); background: var(--color-bg-card); font: inherit; color: inherit; text-align: left; cursor: pointer; }
.pr-outlet:hover:not(:disabled) { border-color: var(--color-border-strong); background: var(--color-bg-hover); }
.pr-outlet__body { display: grid; gap: 3px; min-width: 0; }
.pr-outlet__name { font-weight: 600; overflow-wrap: anywhere; }
.pr-outlet__meta { font-size: 12.5px; color: var(--color-text-secondary); overflow-wrap: anywhere; }
.pr-pair { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 0; flex-wrap: wrap; }
.pr-pair + .pr-pair { border-top: 1px solid var(--color-border); }
.pr-pair__names { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; font-size: 13.5px; }
.pr-pair__names svg { color: var(--color-text-muted); }
.pr-pair__actions { display: flex; gap: 6px; }

/* Narrower screens */
@media (max-width: 1100px) {
  .pr-status__grid { grid-template-columns: minmax(0, 1fr); }
  .pr-stat + .pr-stat { border-left: 0; border-top: 1px solid var(--color-border); }
  .pr-editor__grid { grid-template-columns: minmax(0, 1fr); }
  .pr-pic { grid-template-columns: minmax(0, 1fr); }
  .pr-pic__stage { max-width: 420px; }
  .pr-sources { grid-template-columns: repeat(2, minmax(0, 1fr)); }
}
@media (max-width: 768px) {
  .pr-head { flex-direction: column; }
  .pr-head__actions { width: 100%; }
  .pr-head__actions .btn-primary { flex: 1; justify-content: center; }
  .pr-search { flex: 1 1 100%; }
  .pr-row__open { gap: 12px; padding: 10px 4px; }
  .pr-row__open .pr-thumb { --w: 72px !important; --h: 52px !important; }
  .pr-two, .pr-set__grid { grid-template-columns: minmax(0, 1fr); }
  .pr-row-input { flex-wrap: wrap; }
  .pr-row-input .form-input { flex: 1 1 100%; }
  .pr-bar { flex-wrap: wrap; top: 0; row-gap: 6px; }
  .pr-bar__title { flex: 1 1 calc(100% - 70px); }
  .pr-bar__state { flex: 1; text-align: right; }
  .pr-feat__grip, .pr-feat .pr-hint { display: none; }
  .pr-feat__n { width: 16px; }
  .pr-feat__moves { flex-direction: column; }
  .pr-feat__title { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  .pr-mention { flex-direction: column; gap: 8px; }
  .pr-mention__actions { justify-content: flex-start; }
  .pr-log__item { grid-template-columns: minmax(0, 1fr) auto; }
  .pr-log__when { grid-column: 1 / -1; }
  .pr-sources { grid-template-columns: minmax(0, 1fr); }
  .pr-filled__card { flex-direction: column; }
  .pr-feat__open .pr-thumb { display: none; }
  .pr-status__foot { flex-wrap: wrap; }
  .pr-status__foot .pr-monitor__go { flex-basis: 100%; padding-left: 22px; }
  .pr-strip__moves { opacity: 1; }
}
@media (pointer: coarse) {
  .pr-icon-btn { width: 44px; height: 44px; }
  .pr-pill, .pr-seg__btn { height: 44px; }
  .pr-people__chip { height: 44px; }
  .pr-kidpic { width: 112px; height: 76px; }
  .pr-people__chip .pr-icon-btn { width: 44px; height: 44px; border-radius: 22px; }
  /* The whole row is the switch; the knob itself is a thumb's width too */
  .pr-switch { min-height: 48px; align-items: center; }
  .pr-switch input { width: 48px; height: 28px; border-radius: 14px; margin-top: 0; }
  .pr-switch input::after { top: 3px; left: 3px; width: 22px; height: 22px; }
  .pr-switch input:checked::after { transform: translateX(20px); }
}
@media (prefers-reduced-motion: reduce) {
  .pr-monitor__dot { animation: none; }
  .pr-switch input, .pr-switch input::after, .pr-strip__logo, .pr-strip__moves { transition: none; }
}
`;
function injectStyles() {
  let s = document.getElementById('pr-style');
  if (!s) { s = document.createElement('style'); s.id = 'pr-style'; document.head.append(s); }
  if (s.textContent !== CSS) s.textContent = CSS;
}
