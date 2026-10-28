/**
 * Mindmap (admin)
 * ===============
 * The hand-drawn map behind Site → Automations (automations.js) and
 * Site → Emails & invites (messages.js). A page hands over its tree and the
 * words and panels that are its own; this file draws, lays out, pans, zooms,
 * filters and searches it the same way for both.
 *
 * A tree is { t, children: [branch…] }. Branches carry color (a key of the
 * page's palette) and side ('r' or 'l'); groups sit under branches; leaves
 * are the entries, each with a written status s (live | test | off | attn),
 * a kind k, and optionally live(facts) → { s, why, last } (see automations.js).
 *
 * Drawn by hand (no chart library: the admin CSP allows no CDN). Branches
 * split left and right of the center; groups open and close in place and
 * the clicked node stays put on screen.
 */

import { h, htm, useState, useEffect, useRef, useMemo } from './vendor.js';

const html = htm.bind(h);

// ─── Time and words ───────────────────────
export const MIN = 60e3;
export const HOUR = 60 * MIN;
export const ms = (iso) => { const t = Date.parse(iso || ''); return Number.isNaN(t) ? null : t; };
export function ago(iso, now = Date.now()) {
  const t = ms(iso);
  if (t == null) return '';
  const d = Math.max(0, now - t);
  if (d < MIN) return 'just now';
  if (d < HOUR) return `${Math.round(d / MIN)} min ago`;
  if (d < 48 * HOUR) return `${Math.round(d / HOUR)} h ago`;
  return `${Math.round(d / (24 * HOUR))} days ago`;
}
export const stamp = (iso) => new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/New_York' });
export const stale = (iso, maxMs) => { const t = ms(iso); return t == null || Date.now() - t > maxMs; };
export const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

export const STATUS = { live: 'Live', test: 'Test mode', off: 'Off', attn: 'Needs attention' };

// ─── Prepare a tree once ──────────────────
export const leavesOf = (n, out = []) => {
  if (n.children) n.children.forEach((c) => leavesOf(c, out));
  else out.push(n);
  return out;
};
export const crumbs = (n) => {
  const out = [];
  for (let p = n.parent; p && p.depth > 0; p = p.parent) out.unshift(p.t);
  return out;
};

/** Number the tree, pass branch colors and sides down, and gather what the page needs about it */
export function prepareMap(MAP, prefix = 'm') {
  let seq = 0;
  const byId = new Map();
  (function prep(n, depth, parent) {
    n.id = prefix + seq++;
    n.depth = depth;
    n.parent = parent;
    if (parent && depth > 1) n.color = parent.color;
    if (parent && depth > 1) n.side = parent.side;
    n.es = n.s; // effective status, replaced by the live check
    byId.set(n.id, n);
    (n.children || []).forEach((c) => prep(c, depth + 1, n));
  })(MAP, 0, null);
  const ALL = leavesOf(MAP);
  const count = new Map();
  ALL.forEach((n) => (n.touches || []).forEach((t) => count.set(t, (count.get(t) || 0) + 1)));
  const SERVICES = [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  /** Apply the live facts to every entry (null: the written statuses stand) */
  const applyFacts = (facts) => {
    ALL.forEach((n) => {
      let p = null;
      if (facts && n.live) { try { p = n.live(facts) || null; } catch { p = null; } }
      n.probe = p;
      n.es = p?.s || n.s;
    });
  };
  return { MAP, byId, ALL, SERVICES, applyFacts, defaultOpen: () => new Set([MAP.id, ...MAP.children.map((b) => b.id)]) };
}

// The sentence that explains a not-live status
export const reasonOf = (n) => (n.probe?.s && n.probe.s === n.es ? n.probe.why : null) || n.note || null;

// ─── Measuring & layout ───────────────────
const FONT = { 0: '700 17px', 1: '650 14px', 2: '550 13px', 3: '450 12.5px' };
const PAD = { 0: 20, 1: 14, 2: 11 };
const HGT = { 0: 44, 1: 32, 2: 27, 3: 22 };
const BADGE = 28;
const READ_K = 0.9; // zoom at which every label reads comfortably
let ctx2d = null;
function textW(text, depth) {
  ctx2d ||= document.createElement('canvas').getContext('2d');
  ctx2d.font = `${FONT[Math.min(depth, 3)]} Inter, system-ui, sans-serif`;
  return ctx2d.measureText(text).width;
}
// A leaf's tags: small labels drawn after its name (Emails & invites: who sends it)
const TAG_FONT = '650 10.5px';
const TAG_GAP = 7;   // between the name and the first tag
const TAG_SEP = 3;   // between tags
const tagW = (label) => {
  ctx2d ||= document.createElement('canvas').getContext('2d');
  ctx2d.font = `${TAG_FONT} Inter, system-ui, sans-serif`;
  return ctx2d.measureText(label).width + 11;
};
const tagsW = (tags) => (tags?.length ? TAG_GAP + tags.reduce((w, t) => w + tagW(t.label), 0) + TAG_SEP * (tags.length - 1) : 0);
function boxW(n, open) {
  if (!n.children) return textW(n.t, 3) + 22 + tagsW(n._tags);
  const d = Math.min(n.depth, 2);
  return textW(n.t, d) + PAD[d] * 2 + (n.depth > 0 && !open.has(n.id) ? BADGE : 0);
}

// Leaves and closed groups stack top to bottom, parents center on their
// children; each side gets its own column offsets from its widest labels.
function layout(MAP, open, tagsOf = null) {
  const nodes = [];
  MAP._w = boxW(MAP, open);
  MAP._x = -MAP._w / 2;
  MAP._y = 0;
  nodes.push(MAP);
  for (const side of ['r', 'l']) {
    const dir = side === 'r' ? 1 : -1;
    const branches = MAP.children.filter((b) => b.side === side);
    const vis = [];
    let cursor = 0;
    let lastParent = null;
    const place = (n) => {
      vis.push(n);
      if (!n.children) n._tags = tagsOf ? tagsOf(n) || null : null;
      n._w = boxW(n, open);
      const kids = n.children && open.has(n.id) ? n.children : null;
      if (kids) {
        kids.forEach(place);
        n._y = (kids[0]._y + kids[kids.length - 1]._y) / 2;
      } else {
        const hgt = n.children ? (n.depth === 1 ? 44 : 36) : 24;
        if (lastParent && lastParent !== n.parent) cursor += n.depth === 1 || !n.children ? 12 : 6;
        n._y = cursor + hgt / 2;
        cursor += hgt;
        lastParent = n.parent;
      }
    };
    branches.forEach((b) => {
      if (lastParent) cursor += 22;
      place(b);
      lastParent = b;
    });
    const shift = cursor / 2;
    const maxW = {};
    vis.forEach((n) => {
      n._y -= shift;
      maxW[n.depth] = Math.max(maxW[n.depth] || 0, n._w);
    });
    const col = { 1: MAP._w / 2 + 48 };
    for (let d = 2; d <= 4; d++) col[d] = col[d - 1] + (maxW[d - 1] || 0) + (d === 2 ? 44 : 34);
    vis.forEach((n) => {
      n._x = dir > 0 ? col[n.depth] : -col[n.depth] - n._w;
      n._dir = dir;
      nodes.push(n);
    });
  }
  return { nodes, links: nodes.slice(1) };
}
function linkD(n) {
  const p = n.parent;
  const x1 = n._dir > 0 ? p._x + p._w : p._x;
  const x2 = n._dir > 0 ? n._x : n._x + n._w;
  const mx = (x1 + x2) / 2;
  return `M${x1},${p._y}C${mx},${p._y} ${mx},${n._y} ${x2},${n._y}`;
}
function bounds(list) {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  list.forEach((n) => {
    x0 = Math.min(x0, n._x); x1 = Math.max(x1, n._x + n._w);
    y0 = Math.min(y0, n._y - 22); y1 = Math.max(y1, n._y + 22);
  });
  return { x0, x1, y0, y1 };
}

// ─── Styles ───────────────────────────────
const CSS = `
.am { --am-live: var(--tone-success-dot); --am-warn: var(--tone-warn-dot); --am-idle: var(--tone-neutral-dot); }
.am-lede { display: flex; flex-wrap: wrap; gap: 0.35rem 1.1rem; margin: 0.15rem 0 0.4rem; padding: 0; list-style: none; font-size: var(--fs-sm); color: var(--color-text-secondary); }
.am-lede b { color: var(--color-text); font-variant-numeric: tabular-nums; font-weight: 700; }
.am-lede button { all: unset; cursor: pointer; border-radius: 4px; }
.am-lede button:hover span { text-decoration: underline; }
.am-lede button:focus-visible { box-shadow: var(--focus-ring); }
@media (pointer: coarse) { .am-lede button { padding-block: 11px; margin-block: -11px; } .am-zoom button { width: 44px; height: 44px; } }
.am-lede .am-warnstat b { color: var(--am-warn); }
.am-check { display: flex; flex-wrap: wrap; align-items: center; gap: 0.35rem 0.6rem; margin: 0 0 1rem; font-size: var(--fs-xs); color: var(--color-text-muted); }
.am-check i { width: 7px; height: 7px; border-radius: 50%; background: var(--am-live); }
.am-check.is-off i { background: var(--am-idle); }
.am-check button { all: unset; cursor: pointer; color: var(--color-text-secondary); font-weight: 600; text-decoration: underline; text-underline-offset: 2px; }
.am-check button:focus-visible { box-shadow: var(--focus-ring); border-radius: 3px; }
.am-tools { display: flex; flex-wrap: wrap; gap: 0.6rem 0.5rem; align-items: center; margin-bottom: 0.75rem; }
/* Two rows on purpose: the kinds and the map's own buttons, then the pickers and search */
.am-tools > .pill-row { order: 1; flex: 1 1 auto; }
.am-acts { order: 2; display: flex; gap: 0.4rem; margin-left: auto; }
.am-tools::after { content: ''; order: 3; flex-basis: 100%; }
.am-tools > .am-filters--pick, .am-tools > .am-svc, .am-tools > .am-search { order: 4; }
.am-filters { display: flex; flex-wrap: wrap; gap: 0.4rem; }
.am-filters--pick { flex: 0 1 190px; min-width: 0; }
.am-filters--pick select { width: 100%; }
.am-node .am-tag rect { fill: var(--tg); fill-opacity: 0.13; }
.am-node.leaf .am-tag text { font: 650 10.5px Inter, system-ui, sans-serif; fill: var(--tg); text-anchor: middle; dominant-baseline: central; }
.am-svc { flex: 0 1 210px; min-width: 0; }
.am-search { flex: 1 1 220px; min-width: 0; max-width: 360px; }
.am-search input, .am-svc select { width: 100%; }
.am-hits { position: absolute; left: 0.6rem; top: 0.6rem; z-index: 1; padding: 0.2rem 0.55rem; border-radius: 6px; background: var(--color-bg-card); border: 1px solid var(--color-border); font-size: var(--fs-2xs); font-weight: 600; color: var(--color-text-secondary); font-variant-numeric: tabular-nums; pointer-events: none; }
.am-work { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 1rem; align-items: start; }
.am-work.is-wide { grid-template-columns: minmax(0, 1fr); }
.am-work.is-wide .am-panel { position: static; max-height: none; }
.am-canvas { position: relative; padding: 0; margin: 0; height: clamp(460px, 66vh, 780px); background:
  radial-gradient(circle, var(--color-border) 1px, transparent 1.2px) 0 0 / 22px 22px, var(--color-bg-secondary); }
.am-canvas svg { width: 100%; height: 100%; display: block; touch-action: none; cursor: grab; user-select: none; -webkit-user-select: none; }
.am-canvas svg.am-drag { cursor: grabbing; }
.am-zoom { position: absolute; right: 0.6rem; bottom: 0.6rem; display: flex; flex-direction: column; gap: 0.3rem; }
.am-zoom button { width: 36px; height: 36px; padding: 0; background: var(--color-bg-card); border: 1px solid var(--color-border); border-radius: 8px; cursor: pointer; font-size: var(--fs-md); font-weight: 600; color: var(--color-text); box-shadow: var(--shadow-xs); }
.am-zoom button:hover { background: var(--color-bg-hover); }
.am-zoom .am-zoom__fit { font-size: var(--fs-2xs); font-weight: 600; }
.am-legend { position: absolute; left: 0.6rem; bottom: 0.6rem; display: flex; flex-wrap: wrap; gap: 0.25rem 0.8rem; max-width: calc(100% - 4rem); padding: 0.4rem 0.65rem; background: color-mix(in srgb, var(--color-bg-card) 92%, transparent); border: 1px solid var(--color-border); border-radius: 8px; font-size: var(--fs-2xs); color: var(--color-text-secondary); }
.am-legend span { display: inline-flex; align-items: center; gap: 0.35rem; white-space: nowrap; }
.am-link { fill: none; stroke: var(--c); stroke-opacity: 0.5; stroke-width: 1.4; }
.am-link.d1 { stroke-width: 3; stroke-opacity: 0.55; }
.am-link.d2 { stroke-width: 2; }
.am-node { cursor: pointer; outline: none; animation: am-in 0.28s var(--ease-out) both; }
@keyframes am-in { from { opacity: 0; } }
.am-node text { font-family: Inter, system-ui, sans-serif; fill: var(--color-text); dominant-baseline: central; }
.am-node.d0 rect { fill: var(--color-sidebar); }
.am-node.d0 text { fill: #fff; font: 700 17px Inter, system-ui, sans-serif; letter-spacing: 0.02em; }
.am-node.d0 circle { fill: var(--color-primary); }
.am-node.d1 rect.am-pill { fill: color-mix(in srgb, var(--c) 16%, var(--color-bg-card)); stroke: var(--c); stroke-width: 1.5; }
.am-node.d1 text { font: 650 14px Inter, system-ui, sans-serif; }
.am-node.d2 rect.am-pill { fill: var(--color-bg-card); stroke: color-mix(in srgb, var(--c) 55%, var(--color-border)); stroke-width: 1.25; }
.am-node.d2 text { font: 550 13px Inter, system-ui, sans-serif; }
.am-node.leaf text { font: 450 12.5px Inter, system-ui, sans-serif; }
.am-node .am-badge rect { fill: var(--c); fill-opacity: 0.16; }
.am-node .am-badge text { font: 650 11px Inter, system-ui, sans-serif; fill: var(--color-text); text-anchor: middle; }
.am-node .am-badge.has-attn rect { fill: var(--am-warn); fill-opacity: 0.22; }
.am-node .am-hit { fill: transparent; }
.am-node:hover .am-hit, .am-node:focus-visible .am-hit { fill: var(--color-bg-hover); }
.am-node:hover rect.am-pill, .am-node:focus-visible rect.am-pill { stroke-width: 2.25; }
.am-node:focus-visible .am-hit, .am-node:focus-visible rect.am-pill { stroke: var(--color-text); stroke-width: 2; }
.am-node.sel .am-hit { fill: color-mix(in srgb, var(--c) 18%, transparent); }
.am-node.sel rect.am-pill { stroke: var(--color-text); stroke-width: 2; }
.am-node.sel text { font-weight: 650; }
.am-node.dim, .am-link.dim { opacity: 0.18; }
.am-node.hit-on text { font-weight: 650; }
svg .am-dot { stroke-width: 1.6; }
svg .am-dot.s-live { fill: var(--am-live); stroke: var(--am-live); }
svg .am-dot.s-test { fill: var(--color-bg-card); stroke: var(--am-idle); }
svg .am-dot.s-off { fill: var(--am-idle); stroke: var(--am-idle); fill-opacity: 0.35; }
svg .am-dot.s-attn { fill: var(--am-warn); stroke: var(--am-warn); }
svg .am-halo { fill: none; stroke: var(--am-warn); stroke-opacity: 0.4; stroke-width: 3; }
.am-dot-i { display: inline-block; width: 9px; height: 9px; border-radius: 50%; flex: none; border: 1.6px solid var(--am-idle); background: var(--color-bg-card); vertical-align: baseline; }
.am-dot-i.k-link { border-radius: 2px; }
.am-dot-i.s-live { background: var(--am-live); border-color: var(--am-live); }
.am-dot-i.s-attn { background: var(--am-warn); border-color: var(--am-warn); box-shadow: 0 0 0 3px color-mix(in srgb, var(--am-warn) 25%, transparent); }
.am-dot-i.s-off { background: color-mix(in srgb, var(--am-idle) 40%, var(--color-bg-card)); }
.am-panel { position: sticky; top: 1rem; max-height: calc(100vh - 2rem); overflow: auto; }
.am-panel-top { display: flex; align-items: start; justify-content: space-between; gap: 0.5rem; }
.am-close { all: unset; cursor: pointer; flex: none; width: 28px; height: 28px; margin: -0.3rem -0.4rem 0 0; display: grid; place-items: center; border-radius: 6px; color: var(--color-text-muted); font-size: var(--fs-md); }
.am-close:hover { background: var(--color-bg-hover); color: var(--color-text); }
.am-close:focus-visible { box-shadow: var(--focus-ring); }
.am-crumb { margin: 0 0 0.35rem; font-size: var(--fs-2xs); font-weight: 600; letter-spacing: 0.05em; text-transform: uppercase; color: var(--c, var(--color-text-muted)); }
.am-panel h3 { font-size: var(--fs-md); letter-spacing: -0.015em; line-height: 1.3; text-wrap: balance; }
.am-panel h4 { margin: 1.1rem 0 0.2rem; font-size: var(--fs-xs); font-weight: 700; color: var(--color-text-secondary); }
.am-panel h4:first-child { margin-top: 0; }
.am-panel .am-sub { margin: 0.2rem 0 0; color: var(--color-text-muted); font-size: var(--fs-xs); }
.am-panel .am-about { margin: 0.6rem 0 0; font-size: var(--fs-sm); line-height: 1.5; color: var(--color-text-secondary); }
.am-chips { display: flex; flex-wrap: wrap; gap: 0.35rem; margin: 0.65rem 0 0.25rem; }
.am-chip-src { background: transparent !important; border: 1px dashed var(--color-border-strong) !important; color: var(--color-text-muted) !important; }
.am-panel dl { margin: 0.75rem 0 0; display: grid; gap: 0.75rem; }
.am-panel dt { font-size: var(--fs-2xs); font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--color-text-muted); margin-bottom: 0.2rem; }
.am-panel dd { margin: 0; font-size: var(--fs-sm); line-height: 1.5; }
.am-now { padding: 0.55rem 0.7rem; border-radius: 8px; background: var(--color-bg); }
.am-now.s-attn { background: color-mix(in srgb, var(--am-warn) 11%, var(--color-bg-card)); }
.am-now small { display: block; margin-top: 0.15rem; color: var(--color-text-muted); font-size: var(--fs-xs); }
.am-tags { display: flex; flex-wrap: wrap; gap: 0.3rem; }
.am-tags button { all: unset; cursor: pointer; padding: 0.15rem 0.5rem; border-radius: 6px; background: var(--color-bg); border: 1px solid var(--color-border); font-size: var(--fs-xs); }
.am-tags button:hover { border-color: var(--color-border-strong); background: var(--color-bg-hover); }
.am-tags button:focus-visible { box-shadow: var(--focus-ring); }
.am-mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: var(--fs-xs) !important; word-break: break-word; color: var(--color-text-secondary); }
.am-mini { list-style: none; margin: 0.5rem 0 0; padding: 0; display: grid; gap: 0.1rem; }
.am-mini button { all: unset; box-sizing: border-box; cursor: pointer; display: grid; grid-template-columns: 12px minmax(0, 1fr); gap: 0.1rem 0.55rem; align-items: baseline; width: 100%; padding: 0.4rem 0.45rem; border-radius: 6px; font-size: var(--fs-xs); line-height: 1.35; }
.am-mini button:hover { background: var(--color-bg-hover); }
.am-mini button:focus-visible { box-shadow: var(--focus-ring); }
.am-mini small { grid-column: 2; color: var(--color-text-secondary); font-size: var(--fs-xs); line-height: 1.45; }
.am-mini em { font-style: normal; color: var(--color-text-muted); font-size: var(--fs-2xs); margin-left: 0.35rem; }
.am-mini-group { padding: 0.35rem 0.45rem 0.45rem; }
.am-mini-names { display: flex; flex-wrap: wrap; gap: 0.1rem 0.2rem; margin: 0 -0.3rem; }
.am-mini .am-mini-names button { display: inline-flex; align-items: baseline; gap: 0.4rem; width: auto; padding: 0.2rem 0.3rem; font-size: var(--fs-xs); }
.am-mini-group > small { display: block; padding-left: 0.3rem; margin-top: 0.2rem; color: var(--color-text-secondary); font-size: var(--fs-xs); line-height: 1.45; }
.am-mini-group > small em { display: block; margin: 0.1rem 0 0; }
.am-empty { margin: 0.4rem 0 0; font-size: var(--fs-xs); color: var(--color-text-secondary); }
.am-inv { margin-top: 1.5rem; }
.am-inv > h3 { font-size: var(--fs-md); margin: 0 0 0.25rem; }
.am-inv > p { margin: 0 0 1rem; font-size: var(--fs-sm); color: var(--color-text-secondary); }
.am-inv-branch { padding: 0; }
.am-inv-branch > h4 { display: flex; align-items: center; gap: 0.55rem; margin: 0; padding: 1rem 1.25rem 0.6rem; font-size: var(--fs-base); }
.am-inv-branch > h4 i { width: 10px; height: 10px; border-radius: 3px; background: var(--c); }
.am-inv-branch > h4 small { font-weight: 500; color: var(--color-text-muted); font-size: var(--fs-xs); }
.am-inv-branch details { border-top: 1px solid var(--color-border); }
.am-inv-branch summary { cursor: pointer; padding: 0.6rem 1.25rem; font-weight: 600; font-size: var(--fs-sm); list-style-position: inside; }
.am-inv-branch summary span { color: var(--color-text-muted); font-weight: 500; font-variant-numeric: tabular-nums; margin-left: 0.3rem; }
.am-inv-branch ul { list-style: none; margin: 0; padding: 0 1.25rem 0.6rem; display: grid; gap: 0.1rem; }
.am-inv-branch li { display: grid; grid-template-columns: 14px minmax(0, 1fr); gap: 0.6rem; padding: 0.45rem 0; border-top: 1px dashed var(--color-border); }
.am-inv-branch li:first-child { border-top: 0; }
.am-inv-branch li .am-dot-i { margin-top: 0.3rem; }
.am-inv-branch li b { font-weight: 600; font-size: var(--fs-sm); }
.am-inv-branch li .am-meta { display: block; font-size: var(--fs-2xs); color: var(--color-text-muted); margin-top: 0.1rem; }
.am-inv-branch li p { margin: 0.2rem 0 0; font-size: var(--fs-xs); line-height: 1.45; color: var(--color-text-secondary); }
.am-inv-branch li p.am-why { color: var(--color-text); }
.am-inv-branch li code { display: block; margin-top: 0.2rem; font-size: var(--fs-2xs); color: var(--color-text-muted); word-break: break-word; }
@media (max-width: 1100px) {
  .am-work { grid-template-columns: minmax(0, 1fr); }
  .am-panel { position: static; max-height: none; }
}
@media (max-width: 640px) {
  .am-canvas { height: 62vh; }
  .am-search, .am-svc, .am-filters--pick { max-width: none; flex-basis: 100%; margin-left: 0; }
  .am-legend { display: none; }
}
@media (prefers-reduced-motion: reduce) { .am-node { animation: none; } }
`;
let cssDone = false;
function ensureCss() {
  if (cssDone) return;
  const s = document.createElement('style');
  s.textContent = CSS;
  document.head.appendChild(s);
  cssDone = true;
}

export const Dot = ({ n, shape }) => html`<span class=${`am-dot-i s-${n.es}${shape === 'square' ? ' k-link' : ''}`} title=${STATUS[n.es]} aria-hidden="true"></span>`;
export const Ago = ({ iso }) => (iso ? html`<time datetime=${iso} title=${stamp(iso)}>${ago(iso)}</time>` : null);
const smooth = () => (matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth');

/**
 * The page. What's the page's own:
 *  - model:      prepareMap(tree)
 *  - palette:    { colorKey: '#hex' } for the branches
 *  - title, sub: the page header; headerExtra sits on its right
 *  - factsUrl:   GET → { success, checkedAt, … } handed to each entry's live(); onFacts(body|null) too
 *  - written:    the date the tree was written ("Map written …")
 *  - filters:    [[key, label]], or groups [{ label, items: [[key, label]] }] shown side by side
 *                ('Sent by: …'): 'all' clears, 'attn' is the amber entries, any other key asks filterMatch(n, key)
 *  - lede({ stat, attn, parked, home, show }): the counts line, as <li>s; show(key) applies a filter
 *  - tags(n):    [{ label, color }] small labels drawn after an entry's name
 *  - entry(sel): the panel for a picked entry, under its title
 *  - homeNote:   the panel's last line when nothing is picked
 *  - depNoun:    [one, many] for "If X stops working: N … use it"
 *  - hay(n):     extra words search should find an entry by
 *  - shape(n):   'square' draws the entry's dot square (and the legend says what that means)
 *  - legend:     the legend's own items
 *  - list:       { title, intro, meta(l), body(l) } for the written-out list
 *  - children:   rendered after the list (a page's sheets and dialogs)
 */
export function MindMap({
  model, palette = {}, title, sub, headerExtra = null, factsUrl, written, onFacts = () => {},
  filters, filterMatch = () => true, lede, entry, homeNote, depNoun = ['entry', 'entries'],
  hay = () => [], shape = () => 'circle', tags = null, legend = null, list, searchLabel, searchPlaceholder, ariaLabel, children = null,
}) {
  ensureCss();
  const { MAP, byId, ALL, SERVICES, applyFacts, defaultOpen } = model;
  const [open, setOpen] = useState(defaultOpen);
  const [selId, setSelId] = useState(null);
  const [kind, setKind] = useState(null);
  const [svc, setSvc] = useState(null);
  const [q, setQ] = useState('');
  const [tall, setTall] = useState(null); // canvas height while everything is open (the panel moves below)
  const [fontsReady, setFontsReady] = useState(0);
  const [ready, setReady] = useState(false);
  const [, setFacts] = useState(null);
  const [check, setCheck] = useState({ state: 'loading' });
  const wrapRef = useRef(null);
  const gRef = useRef(null);
  const svgRef = useRef(null);
  const panelRef = useRef(null);
  const tf = useRef({ x: 0, y: 0, k: 1 });

  const matches = (n, f) => {
    if (n.children) return false;
    // "Needs a look" is the amber entries only: something switched off on purpose doesn't need one
    if (f.kind === 'attn' && n.es !== 'attn') return false;
    if (f.kind && f.kind !== 'attn' && !filterMatch(n, f.kind)) return false;
    if (f.svc && !(n.touches || []).includes(f.svc)) return false;
    if (f.q) {
      const words = [n.t, n.when, n.does, n.where, n.note, n.info, n.probe?.why, ...(n.touches || []), ...hay(n)].join(' ').toLowerCase();
      if (!words.includes(f.q)) return false;
    }
    return true;
  };
  const anyMatch = (n, f) => (n.children ? n.children.some((c) => anyMatch(c, f)) : matches(n, f));

  useEffect(() => {
    let live = true;
    (document.fonts?.ready || Promise.resolve()).then(() => live && setFontsReady((v) => v + 1));
    return () => { live = false; };
  }, []);

  const loadFacts = async () => {
    setCheck((c) => ({ ...c, state: 'loading' }));
    try {
      const res = await fetch(factsUrl, { headers: { Accept: 'application/json' } });
      const body = await res.json().catch(() => null);
      // An expired Access sign-in answers with a login page, not data
      if (!res.ok || !body?.success || !body.checkedAt) throw new Error(body?.error || (res.ok ? 'the server didn’t send data; try reloading the admin' : `HTTP ${res.status}`));
      applyFacts(body);
      onFacts(body);
      setFacts(body);
      setCheck({ state: 'ok', at: body.checkedAt });
    } catch (e) {
      applyFacts(null);
      onFacts(null);
      setFacts(null);
      setCheck({ state: 'error', error: e.message });
    }
  };
  useEffect(() => { loadFacts(); }, []);

  const filter = { kind, svc, q };
  const filtering = !!(kind || svc || q);
  const lay = (o) => layout(MAP, o, tags);
  const { nodes, links } = useMemo(() => lay(open), [open, fontsReady]);
  const sel = selId ? byId.get(selId) : null;

  const apply = () => {
    const g = gRef.current;
    if (g) g.setAttribute('transform', `translate(${tf.current.x},${tf.current.y}) scale(${tf.current.k})`);
  };
  const fit = (list = nodes) => {
    const el = wrapRef.current;
    if (!el || !list.length) return;
    const W = el.clientWidth, H = el.clientHeight;
    const b = bounds(list);
    const k = Math.min(1.2, Math.max(0.3, Math.min((W - 48) / (b.x1 - b.x0), (H - 48) / (b.y1 - b.y0))));
    tf.current = { x: W / 2 - (k * (b.x0 + b.x1)) / 2, y: H / 2 - (k * (b.y0 + b.y1)) / 2, k };
    apply();
  };
  const centerOn = (n) => {
    const el = wrapRef.current;
    if (!el) return;
    const k = Math.max(tf.current.k, READ_K);
    tf.current = { x: el.clientWidth / 2 - k * (n._x + n._w / 2), y: el.clientHeight / 2 - k * n._y, k };
  };
  const zoomBy = (f, cx, cy) => {
    const el = wrapRef.current;
    const t = tf.current;
    const k = Math.min(2.5, Math.max(0.25, t.k * f));
    const px = cx ?? el.clientWidth / 2, py = cy ?? el.clientHeight / 2;
    tf.current = { k, x: px - ((px - t.x) * k) / t.k, y: py - ((py - t.y) * k) / t.k };
    apply();
  };

  // Fit once on arrival, and again when Inter finishes loading (labels change width)
  useEffect(() => {
    fit();
    if (!ready) setReady(true);
  }, [fontsReady]);
  useEffect(() => {
    const onResize = () => { if (!tall) fit(); };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [nodes, tall]);

  // Pan with one pointer, pinch with two, ctrl/⌘ + wheel (and trackpad pinch) zooms.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const pts = new Map();
    let last = null, pinch = null, moved = 0;
    const local = (e) => { const r = svg.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    const down = (e) => {
      pts.set(e.pointerId, local(e));
      moved = 0;
      if (pts.size === 1) last = local(e);
      if (pts.size === 2) {
        const [a, b] = [...pts.values()];
        pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) };
      }
    };
    const move = (e) => {
      if (!pts.has(e.pointerId)) return;
      const p = local(e);
      pts.set(e.pointerId, p);
      if (pts.size === 2 && pinch) {
        const [a, b] = [...pts.values()];
        const d = Math.hypot(a.x - b.x, a.y - b.y);
        zoomBy(d / pinch.d, (a.x + b.x) / 2, (a.y + b.y) / 2);
        pinch.d = d;
        moved += 10;
        return;
      }
      if (!last) return;
      const dx = p.x - last.x, dy = p.y - last.y;
      moved += Math.abs(dx) + Math.abs(dy);
      if (moved > 4) {
        if (!svg.hasPointerCapture(e.pointerId)) svg.setPointerCapture(e.pointerId);
        svg.classList.add('am-drag');
        tf.current = { ...tf.current, x: tf.current.x + dx, y: tf.current.y + dy };
        apply();
      }
      last = p;
    };
    const up = (e) => {
      pts.delete(e.pointerId);
      if (pts.size < 2) pinch = null;
      if (pts.size === 0) { last = null; svg.classList.remove('am-drag'); }
      else last = [...pts.values()][0];
    };
    // A drag that started on a node must not also click it
    const click = (e) => { if (moved > 4) { e.stopPropagation(); e.preventDefault(); } };
    const wheel = (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const p = local(e);
      zoomBy(Math.exp(-e.deltaY * 0.01), p.x, p.y);
    };
    svg.addEventListener('pointerdown', down);
    svg.addEventListener('pointermove', move);
    svg.addEventListener('pointerup', up);
    svg.addEventListener('pointercancel', up);
    svg.addEventListener('click', click, true);
    svg.addEventListener('wheel', wheel, { passive: false });
    return () => {
      svg.removeEventListener('pointerdown', down);
      svg.removeEventListener('pointermove', move);
      svg.removeEventListener('pointerup', up);
      svg.removeEventListener('pointercancel', up);
      svg.removeEventListener('click', click, true);
      svg.removeEventListener('wheel', wheel);
    };
  }, []);

  // Open or close a group, keeping it under the pointer
  const toggle = (n) => {
    const next = new Set(open);
    if (next.has(n.id)) next.delete(n.id); else next.add(n.id);
    const bx = n._x + (n._dir < 0 ? n._w : 0), by = n._y;
    lay(next);
    const ax = n._x + (n._dir < 0 ? n._w : 0), ay = n._y;
    tf.current = { ...tf.current, x: tf.current.x - (ax - bx) * tf.current.k, y: tf.current.y - (ay - by) * tf.current.k };
    setOpen(next);
  };
  const onNode = (n) => {
    if (n.depth === 0) { fit(); return; }
    setSelId(n.id);
    if (n.children) toggle(n);
    else showPanel();
  };
  const panelBelow = () => window.innerWidth <= 1100 || !!tall;
  const showPanel = () => {
    if (panelBelow()) requestAnimationFrame(() => panelRef.current?.scrollIntoView({ behavior: smooth(), block: 'nearest' }));
  };
  // Jump to an entry from a list: open its parents and bring it to the middle
  const reveal = (n) => {
    const next = new Set(open);
    for (let p = n.parent; p; p = p.parent) next.add(p.id);
    lay(next);
    centerOn(n);
    setOpen(next);
    setSelId(n.id);
    if (window.innerWidth <= 1100) wrapRef.current?.scrollIntoView({ behavior: smooth(), block: 'center' });
  };

  // Open whatever holds a match, then fit the matches into view
  const applyFilter = (next) => {
    const f = { kind, svc, q, ...next };
    if ('kind' in next) setKind(f.kind);
    if ('svc' in next) setSvc(f.svc);
    if ('q' in next) setQ(f.q);
    let o;
    if (f.kind || f.svc || f.q) {
      o = new Set([MAP.id]);
      const walk = (n) => { if (n.children) { if (anyMatch(n, f)) o.add(n.id); n.children.forEach(walk); } };
      MAP.children.forEach(walk);
    } else o = defaultOpen();
    const l = lay(o);
    const filtered = f.kind || f.svc || f.q;
    setTall(null);
    setOpen(o);
    // Zoom to what matched (and the branches holding it), not the dimmed rest
    requestAnimationFrame(() => requestAnimationFrame(() => fit(filtered ? l.nodes.filter((n) => n.depth === 0 || anyMatch(n, f)) : l.nodes)));
  };
  const qTimer = useRef(null);
  const onSearch = (e) => {
    const v = e.target.value;
    clearTimeout(qTimer.current);
    qTimer.current = setTimeout(() => applyFilter({ q: v.trim().toLowerCase() }), 180);
  };
  const pickService = (name) => {
    setSelId(null);
    applyFilter({ svc: name || null });
    showPanel();
  };
  // Everything open at a zoom where labels read: the map takes the full width
  // (the panel moves below) and the canvas grows tall enough to hold it all
  const openAll = () => {
    const all = new Set([...byId.values()].filter((n) => n.children).map((n) => n.id));
    const l = lay(all);
    const el = wrapRef.current;
    const b = bounds(l.nodes);
    const W = el.parentElement.clientWidth;
    const k = Math.max(0.7, Math.min(READ_K, (W - 48) / (b.x1 - b.x0)));
    const H = Math.min(2600, Math.max(el.clientHeight, (b.y1 - b.y0) * k + 64));
    const fitsWide = (b.x1 - b.x0) * k <= W - 48;
    tf.current = { k, x: fitsWide ? W / 2 - (k * (b.x0 + b.x1)) / 2 : W / 2, y: H / 2 - (k * (b.y0 + b.y1)) / 2 };
    setKind(null); setSvc(null); setQ('');
    const input = document.getElementById('am-search');
    if (input) input.value = '';
    setTall(H);
    setOpen(all);
  };
  const resetAll = () => {
    const input = document.getElementById('am-search');
    if (input) input.value = '';
    setSelId(null);
    applyFilter({ kind: null, svc: null, q: '' });
  };

  const hits = filtering ? ALL.filter((n) => matches(n, filter)).length : 0;
  const stat = (f) => ALL.filter(f).length;
  const attn = ALL.filter((n) => n.es === 'attn');
  const parked = ALL.filter((n) => n.es === 'test' || n.es === 'off');
  const home = () => { setSelId(null); if (svc) applyFilter({ svc: null }); showPanel(); };

  const onKey = (e, n) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onNode(n); } };

  const nodeEl = (n) => {
    const style = `--c: var(--am-b-${n.color || 'site'})`;
    const dim = filtering && n.depth > 0 && !anyMatch(n, filter);
    const cls = `am-node d${Math.min(n.depth, 2)}${n.children ? '' : ' leaf'}${n.id === selId ? ' sel' : ''}${dim ? ' dim' : ''}${filtering && !n.children && matches(n, filter) ? ' hit-on' : ''}`;
    const left = n._dir < 0;
    if (n.depth === 0) {
      return html`<g key=${n.id} class=${cls} transform=${`translate(${n._x},${n._y})`} tabindex="0" role="button" aria-label="Fit the whole map" onClick=${() => onNode(n)} onKeyDown=${(e) => onKey(e, n)}>
        <rect x="0" y=${-HGT[0] / 2} width=${n._w} height=${HGT[0]} rx="22" />
        <circle cx=${PAD[0] - 6} cy="0" r="4" />
        <text x=${PAD[0] + 4}>${n.t}</text>
      </g>`;
    }
    if (n.children) {
      const d = Math.min(n.depth, 2);
      const hgt = HGT[d];
      const closed = !open.has(n.id);
      const pad = PAD[d];
      const inside = leavesOf(n);
      const warn = inside.some((l) => l.es === 'attn');
      return html`<g key=${n.id} class=${cls} style=${style} transform=${`translate(${n._x},${n._y})`} tabindex="0" role="button" aria-expanded=${String(!closed)} aria-label=${`${n.t}, ${inside.length} items${warn ? ', some need attention' : ''}`} onClick=${() => onNode(n)} onKeyDown=${(e) => onKey(e, n)}>
        <rect class="am-pill" x="0" y=${-hgt / 2} width=${n._w} height=${hgt} rx=${hgt / 2} />
        <text x=${left && closed ? pad + BADGE : pad}>${n.t}</text>
        ${closed && html`<g class=${`am-badge${warn ? ' has-attn' : ''}`} transform=${`translate(${left ? pad - 4 : n._w - pad - 20},0)`}>
          <rect x="0" y="-9" width="24" height="18" rx="9" />
          <text x="12" y="0.5">${inside.length}</text>
        </g>`}
      </g>`;
    }
    const dotX = left ? n._w - 7 : 7;
    return html`<g key=${n.id} class=${cls} style=${style} transform=${`translate(${n._x},${n._y})`} tabindex="0" role="button" aria-label=${`${n.t}, ${STATUS[n.es]}`} onClick=${() => onNode(n)} onKeyDown=${(e) => onKey(e, n)}>
      <rect class="am-hit" x="0" y="-11" width=${n._w} height="22" rx="6" />
      ${n.es === 'attn' && html`<circle class="am-halo" cx=${dotX} cy="0" r="7.5" />`}
      ${shape(n) === 'square'
        ? html`<rect class=${`am-dot s-${n.es}`} x=${dotX - 4} y="-4" width="8" height="8" rx="1.5" />`
        : html`<circle class=${`am-dot s-${n.es}`} cx=${dotX} cy="0" r="4.25" />`}
      <text x=${left ? n._w - 17 : 17} text-anchor=${left ? 'end' : 'start'}>${n.t}</text>
      ${n._tags?.length && tagEls(n._tags, left ? 5 : 17 + textW(n.t, 3) + TAG_GAP)}
    </g>`;
  };
  // A leaf's tags, left to right from x
  const tagEls = (list, x) => list.map((t) => {
    const w = tagW(t.label);
    const el = html`<g class="am-tag" style=${`--tg: ${t.color || 'var(--color-text-secondary)'}`} transform=${`translate(${x},0)`}>
      <rect x="0" y="-7.5" width=${w} height="15" rx="7.5" />
      <text x=${w / 2} y="0.5">${t.label}</text>
    </g>`;
    x += w + TAG_SEP;
    return el;
  });

  const LeafDot = ({ n }) => html`<${Dot} n=${n} shape=${shape(n)} />`;
  // Entries that share a reason (one switch turns several off) read as one line
  const entryList = (items, why) => {
    const groups = [];
    for (const l of items) {
      const w = why ? why(l) : null;
      const g = w && groups.find((x) => x.why === w);
      if (g) g.items.push(l); else groups.push({ why: w, items: [l] });
    }
    return html`<ul class="am-mini">
      ${groups.map((g) => (g.items.length === 1
        ? html`<li key=${g.items[0].id}><button type="button" onClick=${() => reveal(g.items[0])}>
            <${LeafDot} n=${g.items[0]} /><span>${g.items[0].t}<em>${crumbs(g.items[0])[0]}</em></span>
            ${g.why && html`<small>${g.why}</small>`}
          </button></li>`
        : html`<li key=${g.items[0].id} class="am-mini-group">
            <div class="am-mini-names">${g.items.map((l) => html`<button type="button" key=${l.id} onClick=${() => reveal(l)}><${LeafDot} n=${l} /><span>${l.t}</span></button>`)}</div>
            <small>${g.why}<em>${plural(g.items.length, 'entry', 'entries')}, ${[...new Set(g.items.map((l) => crumbs(l)[0]))].join(', ')}</em></small>
          </li>`))}
    </ul>`;
  };
  const closeBtn = html`<button type="button" class="am-close" aria-label="Close" onClick=${() => { setSelId(null); if (svc) applyFilter({ svc: null }); }}>×</button>`;

  const panel = () => {
    if (!sel && svc) {
      const deps = ALL.filter((n) => (n.touches || []).includes(svc));
      return html`<div>
        <div class="am-panel-top"><p class="am-crumb">Depends on</p>${closeBtn}</div>
        <h3>If ${svc} stops working</h3>
        <p class="am-about">${plural(deps.length, depNoun[0], depNoun[1])} use it. They’re highlighted on the map.</p>
        ${entryList(deps, (l) => (l.es !== 'live' ? reasonOf(l) : null))}
      </div>`;
    }
    if (!sel) {
      return html`<div>
        <h4>Needs attention</h4>
        ${attn.length ? entryList(attn, reasonOf) : html`<p class="am-empty">Nothing needs attention.</p>`}
        <h4>Parked or switched off</h4>
        ${parked.length ? entryList(parked, reasonOf) : html`<p class="am-empty">Nothing is parked.</p>`}
        <p class="am-empty" style="margin-top: 1rem;">${homeNote}</p>
      </div>`;
    }
    const style = `--c: var(--am-b-${sel.color || 'site'})`;
    const path = crumbs(sel);
    if (sel.children) {
      return html`<div style=${style}>
        <div class="am-panel-top"><p class="am-crumb">${path.join(' / ') || 'Branch'}</p>${closeBtn}</div>
        <h3>${sel.t}</h3>
        ${sel.sub && html`<p class="am-sub">${sel.sub}</p>`}
        ${sel.about && html`<p class="am-about">${sel.about}</p>`}
        ${entryList(leavesOf(sel), (l) => (l.es !== 'live' ? reasonOf(l) : null))}
      </div>`;
    }
    return html`<div style=${style}>
      <div class="am-panel-top"><p class="am-crumb">${path.join(' / ')}</p>${closeBtn}</div>
      <h3>${sel.t}</h3>
      ${entry(sel, { pickService, Dot: LeafDot })}
    </div>`;
  };

  const filterGroups = Array.isArray(filters[0]) ? [{ label: null, items: filters }] : filters;
  const show = (k) => { setSelId(null); applyFilter({ kind: k }); };
  const paletteStyle = Object.entries(palette).map(([k, v]) => `--am-b-${k}: ${v}`).join('; ');

  return html`<div class="am" style=${paletteStyle}>
    <div class="page-header" style="margin-bottom: 0.4rem;">
      <div>
        <h2>${title}</h2>
        <p class="page-sub">${sub}</p>
      </div>
      ${headerExtra}
    </div>
    <ul class="am-lede">${lede({ stat, attn, parked, home, show })}</ul>
    <p class=${`am-check${check.state === 'ok' ? '' : ' is-off'}`} aria-live="polite">
      <i aria-hidden="true"></i>
      ${check.state === 'loading' && 'Checking live status…'}
      ${check.state === 'ok' && html`<span>Statuses checked live <${Ago} iso=${check.at} />. Map written ${written}.</span>`}
      ${check.state === 'error' && html`<span>Couldn’t check live status (${check.error}). Showing the map as written ${written}.</span>`}
      ${check.state === 'error' && html`<button type="button" onClick=${loadFacts}>Try again</button>`}
    </p>

    <div class="am-tools">
      ${filterGroups.map((g) => g.label
        // A second dimension (Sent by) is one pick among many: a menu beside Depends on, not a wall of pills
        ? html`<div class="am-filters am-filters--pick" key=${g.label}>
          <select class="form-select" aria-label=${g.label} value=${g.items.some(([k]) => k === kind) ? kind : ''} onChange=${(e) => applyFilter({ kind: e.target.value || null })}>
            <option value="">${g.label} anyone</option>
            ${g.items.map(([k, label]) => html`<option key=${k} value=${k}>${g.label} ${label}</option>`)}
          </select>
        </div>`
        : html`<div class="pill-row am-filters" role="group" aria-label="Show" key="show">
          ${g.items.map(([k, label]) => html`<button key=${k} type="button" class="pill" aria-pressed=${String((kind || 'all') === k)} onClick=${() => applyFilter({ kind: k === 'all' || kind === k ? null : k })}>${label}</button>`)}
        </div>`)}
      <div class="am-svc">
        <select id="am-svc" class="form-select" aria-label="Show what depends on a service" value=${svc || ''} onChange=${(e) => pickService(e.target.value)}>
          <option value="">Depends on…</option>
          ${SERVICES.map(([name, n]) => html`<option key=${name} value=${name}>${name} (${n})</option>`)}
        </select>
      </div>
      <div class="am-search">
        <input id="am-search" class="form-input" type="search" aria-label=${searchLabel} placeholder=${searchPlaceholder} onInput=${onSearch} />
      </div>
      <div class="am-acts">
        <button type="button" class="btn btn-ghost btn-sm" onClick=${openAll}>Open all</button>
        <button type="button" class="btn btn-ghost btn-sm" onClick=${resetAll}>Reset</button>
      </div>
    </div>

    <div class=${`am-work${tall ? ' is-wide' : ''}`}>
      <div class="card am-canvas" ref=${wrapRef} style=${tall ? `height: ${tall}px` : ''}>
        ${filtering && html`<span class="am-hits" aria-live="polite">${hits} match${hits === 1 ? '' : 'es'}</span>`}
        <svg ref=${svgRef} role="group" aria-label=${ariaLabel} style=${ready ? '' : 'opacity: 0'}
          onClick=${(e) => { if (e.target === svgRef.current) setSelId(null); }}>
          <g ref=${gRef} transform=${`translate(${tf.current.x},${tf.current.y}) scale(${tf.current.k})`}>
            <g>${links.map((n) => html`<path key=${'l' + n.id} class=${`am-link d${Math.min(n.depth, 3)}${filtering && !anyMatch(n, filter) ? ' dim' : ''}`} style=${`--c: var(--am-b-${n.color || 'site'})`} d=${linkD(n)} />`)}</g>
            <g>${nodes.map(nodeEl)}</g>
          </g>
        </svg>
        <div class="am-legend" aria-hidden="true">
          <span><span class="am-dot-i s-live"></span>Live</span>
          <span><span class="am-dot-i s-test"></span>Test or off</span>
          <span><span class="am-dot-i s-attn"></span>Needs attention</span>
          ${legend}
          <span>Drag to move · pinch or ⌘ scroll to zoom</span>
        </div>
        <div class="am-zoom">
          <button type="button" aria-label="Zoom in" onClick=${() => zoomBy(1.25)}>+</button>
          <button type="button" aria-label="Zoom out" onClick=${() => zoomBy(0.8)}>−</button>
          <button type="button" class="am-zoom__fit" aria-label="Fit the whole map" onClick=${() => fit()}>Fit</button>
        </div>
      </div>
      <aside class="card am-panel" ref=${panelRef} aria-live="polite">${panel()}</aside>
    </div>

    <section class="am-inv">
      <h3>${list.title}</h3>
      <p>${list.intro}</p>
      ${MAP.children.map((b) => html`<div key=${b.id} class="card am-inv-branch" style=${`--c: var(--am-b-${b.color})`}>
        <h4><i></i>${b.t}${b.sub && html` <small>${b.sub}</small>`}</h4>
        ${b.children.map((g) => html`<details key=${g.id} open>
          <summary>${g.t}<span>${leavesOf(g).length}</span></summary>
          <ul>${leavesOf(g).map((l) => html`<li key=${l.id}><${LeafDot} n=${l} /><div>
            <b>${l.t}</b><span class="am-meta">${list.meta(l)}</span>
            ${l.es !== 'live' && reasonOf(l) && html`<p class="am-why">${reasonOf(l)}</p>`}
            ${list.body(l)}
          </div></li>`)}</ul>
        </details>`)}
      </div>`)}
    </section>
    ${children}
  </div>`;
}
