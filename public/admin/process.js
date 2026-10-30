/**
 * Site → Automations → Process (admin)
 * ====================================
 * How a kid's makeover and a community project go, step by step, as SOARD's
 * own process Docs in Google Drive say (read live by /api/process-admin), and
 * at each step what runs on its own: the automations on the map, pinned to
 * the Doc's lines by ./process-shared.js, with the same live status the map
 * shows. A line with nothing pinned is done by hand.
 *
 * The money side (accounts payable, gifts and deposits, books and reporting)
 * has no process Doc: its steps are how it runs (./process-shared.js MONEY),
 * each with the board's Financial Policy Manual sections that govern it, read
 * live from that Doc, and the bill approval settings checked against it.
 *
 * Above the steps, the journey at a glance: a dot per step (something runs on
 * its own, done by hand, or needs attention) with who's there now, each kid or
 * project placed on the step its JobTread status means (process-shared.js
 * STATUS_STEPS). A filter narrows the steps to what needs attention or what's
 * still by hand, the two questions of a yearly review.
 *
 * Every Doc gets a yearly review: the Review card says when it's due (a year
 * after it last changed or was marked reviewed), what to look at (tasks still
 * by hand, tools the manual names that SOARD has moved off, settings that
 * differ from it), and takes "Reviewed, no changes" once it's due.
 *
 * Beside the steps, who's at each stage right now (Applicants and JobTread),
 * or for money, what's waiting (bills, receipts, gifts, cash). Print gives the
 * steps with their automations written out, in place of the PDFs that used
 * to be printed from the Doc.
 *
 * Loaded by ./automations.js, which owns the map, its live facts and the
 * Map | Process switch.
 */

import { h, htm, render, useState, useEffect, useMemo, useRef } from './vendor.js';
import { STATUS, ensureCss as ensureMapCss, Ago, ago } from './mindmap.js';
import { TRACK_LABEL, PROJECT_TRACKS, MONEY_TRACKS, DOC_LIKE, APPLYING_SOURCE, pinSteps, lineCounts, reviewOf, retiredMentions, docYear, placeNow } from './process-shared.js';

const html = htm.bind(h);
const API = '/api/process-admin';
// A phone's narrower names for the tracks
const TRACK_SHORT = { makeover: 'Makeovers', community: 'Community', payables: 'Payables', receivables: 'Gifts', books: 'Books' };
// The Doc each track reads: its own process, or for money the board's manual
const docOf = (t) => (MONEY_TRACKS.includes(t) ? 'policy' : t);
const JOB_LABEL = { 'On Site': 'On Site', 'Awaiting Funding': 'Awaiting funding', Design: 'Design', Finalization: 'Finalization', Approval: 'Approval', Mobilization: 'Mobilization', Build: 'Build' };
// "Oct 28", with the year when it isn't this one ("Nov 13, 2025")
const shortDate = (iso) => {
  if (!iso) return '';
  const d = new Date(iso);
  const year = d.getFullYear() !== new Date().getFullYear();
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', ...(year ? { year: 'numeric' } : {}), timeZone: 'America/New_York' });
};
const longDate = (d = new Date()) => d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' });
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
// Chips a row shows before "N more"
const CHIPS = 8;

/** The track an address asks for: #automations/process/<track>, else makeovers */
export const trackOfHash = (hash = location.hash) => {
  const t = (String(hash).match(/^#automations\/process\/([\w-]+)/) || [])[1];
  return [...PROJECT_TRACKS, ...MONEY_TRACKS].includes(t) ? t : 'makeover';
};
export const hashOfTrack = (t) => (t && t !== 'makeover' ? `#automations/process/${t}` : '#automations/process');
// The track last shown, so coming back from the map opens the same one
let lastTrack = null;
export const currentTrack = () => lastTrack || trackOfHash();

// ─── Styles ───────────────────────────────
const CSS = `
.pr-tools { display: flex; flex-wrap: wrap; align-items: center; gap: 0.6rem; margin: 0.25rem 0 0.75rem; }
.pr-tools .pr-print { margin-left: auto; }
.pr-src { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.25rem 0.6rem; margin: 0 0 1rem; font-size: var(--fs-xs); color: var(--color-text-muted); }
.pr-src a, .pr-src button { all: unset; cursor: pointer; color: var(--color-text-secondary); font-weight: 600; text-decoration: underline; text-underline-offset: 2px; }
.pr-src a:focus-visible, .pr-src button:focus-visible { box-shadow: var(--focus-ring); border-radius: 3px; }
.pr-link { display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center; margin: -0.4rem 0 1rem; }
.pr-link input { flex: 1 1 320px; min-width: 0; max-width: 560px; }
.pr-link p { flex-basis: 100%; margin: 0; font-size: var(--fs-xs); color: var(--color-text-muted); }
.pr-link .pr-link__err { color: var(--tone-warn-fg); }
.pr-work { display: grid; grid-template-columns: minmax(0, 1fr) 290px; gap: 1.25rem; align-items: start; }
.pr-part { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.2rem 0.6rem; margin: 0 0 0.75rem; }
.pr-part h3 { margin: 0; font-size: var(--fs-2xs); font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--color-text-secondary); }
.pr-part span { font-size: var(--fs-xs); color: var(--color-text-muted); }
.pr-part:not(:first-child) { margin-top: 1.5rem; }
.pr-steps { list-style: none; margin: 0; padding: 0; }
.pr-step { position: relative; display: grid; grid-template-columns: 2.25rem minmax(0, 1fr); gap: 0 0.85rem; padding-bottom: 0.85rem; scroll-margin-top: calc(var(--top-h, 0px) + 1rem); }
.pr-step::before { content: ''; position: absolute; left: calc(1.125rem - 1px); top: 2.5rem; bottom: 0.35rem; width: 2px; border-radius: 1px; background: var(--color-border); }
.pr-step:last-child::before { display: none; }
.pr-num { width: 2.25rem; height: 2.25rem; margin-top: 0.4rem; border-radius: 50%; display: grid; place-items: center; background: var(--color-bg-card); border: 1.5px solid var(--color-border-strong); color: var(--color-text-secondary); font-size: var(--fs-sm); font-weight: 700; font-variant-numeric: tabular-nums; }
.pr-step.is-auto .pr-num { background: var(--color-sidebar); border-color: var(--color-sidebar); color: #fff; }
.pr-step.is-attn .pr-num { box-shadow: 0 0 0 3px color-mix(in srgb, var(--am-warn) 35%, transparent); }
.pr-card { padding: 0.8rem 1rem 0.85rem; min-width: 0; }
.pr-head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 0.3rem 0.75rem; }
.pr-head h4 { margin: 0; font-size: var(--fs-md); font-weight: 650; letter-spacing: -0.01em; line-height: 1.35; }
.pr-lines { list-style: none; margin: 0.45rem 0 0; padding: 0; display: grid; gap: 0.4rem; }
.pr-lines .pr-lines { margin-top: 0.35rem; gap: 0.3rem; }
.pr-line { display: grid; grid-template-columns: 0.75rem minmax(0, 1fr); gap: 0 0.5rem; font-size: var(--fs-sm); line-height: 1.45; color: var(--color-text); }
.pr-lines .pr-lines .pr-line { font-size: var(--fs-xs); color: var(--color-text-secondary); }
.pr-line::before { content: ''; width: 5px; height: 5px; margin: 0.6em auto 0; border-radius: 50%; background: var(--color-border-strong); }
.pr-line.has-auto::before { width: 7px; height: 7px; margin-top: 0.5em; background: var(--am-live); }
.pr-line > :not(.pr-text) { grid-column: 2; }
.pr-autos { display: flex; flex-wrap: wrap; gap: 0.3rem; margin-top: 0.3rem; }
.pr-whole { margin-top: 0.7rem; padding-top: 0.6rem; border-top: 1px dashed var(--color-border); }
.pr-whole > p { margin: 0; font-size: var(--fs-2xs); font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--color-text-muted); }
.pr-auto { all: unset; box-sizing: border-box; cursor: pointer; display: inline-flex; align-items: center; gap: 0.4rem; max-width: 100%; min-height: 24px; padding: 0.15rem 0.6rem 0.15rem 0.5rem; border: 1px solid var(--color-border); border-radius: 999px; background: var(--color-bg); font-size: var(--fs-2xs); font-weight: 600; line-height: 1.3; color: var(--color-text-secondary); }
.pr-auto > span:last-child { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pr-auto:hover { border-color: var(--color-border-strong); color: var(--color-text); }
.pr-auto:focus-visible { box-shadow: var(--focus-ring-strong); }
.pr-auto.s-attn { background: var(--tone-warn-bg); border-color: var(--tone-warn-line); color: var(--tone-warn-fg); }
.pr-auto.s-off, .pr-auto.s-test { color: var(--color-text-muted); }
.pr-auto[aria-expanded="true"] { border-color: var(--color-text); color: var(--color-text); box-shadow: inset 0 0 0 1px var(--color-text); }
.pr-detail { margin: 0.45rem 0 0.2rem; padding: 0.75rem 0.9rem; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-bg-card); box-shadow: var(--shadow-sm); }
.pr-detail h5 { margin: 0; font-size: var(--fs-sm); font-weight: 650; }
.pr-detail .am-chips { margin-top: 0.4rem; }
.pr-detail dl { margin: 0.6rem 0 0; display: grid; gap: 0.6rem; }
.pr-detail dt { font-size: var(--fs-2xs); font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--color-text-muted); margin-bottom: 0.15rem; }
.pr-detail dd { margin: 0; font-size: var(--fs-sm); line-height: 1.5; }
.pr-detail .btn { margin-top: 0.7rem; }
.pr-aside { position: sticky; top: 1rem; display: grid; gap: 1rem; }
.pr-now { padding: 0.9rem 1rem 1rem; }
.card.pr-now > h3 { margin: 0 0 0.15rem; font-size: var(--fs-2xs); font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--color-text-secondary); }
.pr-now > p { margin: 0 0 0.5rem; font-size: var(--fs-xs); color: var(--color-text-muted); }
.pr-now h4 { margin: 0.75rem 0 0.2rem; font-size: var(--fs-xs); font-weight: 650; color: var(--color-text-secondary); }
.pr-rows { list-style: none; margin: 0; padding: 0; }
.pr-row { all: unset; box-sizing: border-box; cursor: pointer; display: flex; align-items: baseline; justify-content: space-between; gap: 0.5rem; width: 100%; padding: 0.3rem 0.4rem; margin: 0 -0.4rem; border-radius: 6px; font-size: var(--fs-sm); }
.pr-row:hover:not(:disabled) { background: var(--color-bg-hover); }
.pr-row:focus-visible { box-shadow: var(--focus-ring); }
.pr-row:disabled { cursor: default; color: var(--color-text-muted); }
.pr-row b { font-variant-numeric: tabular-nums; font-weight: 700; }
.pr-row:disabled b { font-weight: 500; }
.pr-names { margin: 0.1rem 0 0.35rem; padding: 0 0 0 0.4rem; list-style: none; font-size: var(--fs-xs); line-height: 1.5; color: var(--color-text-secondary); }
.pr-names a { color: inherit; text-decoration: underline; text-decoration-color: var(--color-border-strong); text-underline-offset: 2px; }
.pr-names a:hover { color: var(--color-text); text-decoration-color: currentColor; }
.pr-names .pr-page { font-size: var(--fs-2xs); color: var(--color-text-muted); }
.pr-more { all: unset; cursor: pointer; display: inline-flex; align-items: center; min-height: 24px; padding: 0.15rem 0.55rem; border-radius: 999px; font-size: var(--fs-2xs); font-weight: 600; color: var(--color-text-secondary); text-decoration: underline; text-underline-offset: 2px; }
.pr-more:focus-visible { box-shadow: var(--focus-ring-strong); }
.pr-now .pr-foot { margin: 0.75rem 0 0; font-size: var(--fs-xs); color: var(--color-text-muted); }
.pr-now .pr-foot a { color: var(--color-text-secondary); font-weight: 600; }
.pr-key { padding: 0.8rem 1rem; font-size: var(--fs-xs); line-height: 1.5; color: var(--color-text-secondary); }
.pr-key p { margin: 0; display: flex; gap: 0.55rem; align-items: baseline; }
.pr-key p + p { margin-top: 0.35rem; }
.pr-key i { flex: none; width: 1rem; height: 1rem; border-radius: 50%; transform: translateY(0.2rem); }
.pr-key .k-auto { background: var(--color-sidebar); }
.pr-key .k-hand { border: 1.5px solid var(--color-border-strong); background: var(--color-bg-card); }
.pr-empty { padding: 1rem 1.25rem; }
.pr-journey { padding: 0.85rem 1rem 0.7rem; margin-bottom: 1.1rem; }
.pr-jrow { display: flex; gap: 0.9rem; overflow-x: auto; scrollbar-width: thin; padding: 0.55rem 0.1rem 0.2rem; }
.pr-jpart { flex: 1 0 auto; min-width: 0; display: flex; flex-direction: column; gap: 0.35rem; }
.pr-jpart + .pr-jpart { padding-left: 0.9rem; border-left: 1px dashed var(--color-border); }
.pr-jlabel { font-size: var(--fs-2xs); font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--color-text-muted); }
.pr-jpart ol { list-style: none; margin: 0; padding: 0; display: grid; grid-auto-flow: column; grid-auto-columns: minmax(32px, 1fr); }
.pr-jstep { position: relative; display: flex; justify-content: center; }
.pr-jstep::before { content: ''; position: absolute; top: 50%; left: 0; right: 0; height: 2px; background: var(--color-border); transform: translateY(-50%); }
.pr-jstep:first-child::before { left: 50%; }
.pr-jstep:last-child::before { right: 50%; }
.pr-jdot { all: unset; box-sizing: border-box; position: relative; z-index: 1; cursor: pointer; width: 28px; height: 28px; border-radius: 50%; display: grid; place-items: center; font-size: var(--fs-2xs); font-weight: 700; font-variant-numeric: tabular-nums; background: var(--color-bg-card); border: 1.5px solid var(--color-border-strong); color: var(--color-text-secondary); }
.pr-jstep.is-auto .pr-jdot { background: var(--color-sidebar); border-color: var(--color-sidebar); color: #fff; }
.pr-jstep.is-attn .pr-jdot { box-shadow: 0 0 0 3px color-mix(in srgb, var(--am-warn) 45%, transparent); }
.pr-jstep.is-dim .pr-jdot { opacity: 0.35; }
.pr-jdot:hover { border-color: var(--color-text); }
.pr-jdot:focus-visible { box-shadow: var(--focus-ring-strong); }
.pr-jcount { position: absolute; z-index: 2; top: -0.55rem; left: calc(50% + 6px); min-width: 1.15rem; padding: 0 0.3rem; border-radius: 999px; background: var(--color-text); color: #fff; font-size: 10px; font-weight: 700; line-height: 1.15rem; text-align: center; pointer-events: none; }
.pr-jcap { display: flex; flex-wrap: wrap; gap: 0.2rem 0.9rem; align-items: center; min-height: 1.3rem; margin: 0.45rem 0 0; font-size: var(--fs-xs); color: var(--color-text-secondary); }
.pr-jcap b { color: var(--color-text); font-weight: 650; }
.pr-jkey { display: inline-flex; align-items: center; gap: 0.35rem; color: var(--color-text-muted); }
.pr-jkey i { width: 10px; height: 10px; border-radius: 50%; border: 1.5px solid var(--color-border-strong); background: var(--color-bg-card); }
.pr-jkey i.k-auto { background: var(--color-sidebar); border-color: var(--color-sidebar); }
.pr-jkey i.k-attn { box-shadow: 0 0 0 2px color-mix(in srgb, var(--am-warn) 45%, transparent); }
.pr-jkey b { min-width: 1rem; padding: 0 0.25rem; border-radius: 999px; background: var(--color-text); color: #fff; font-size: 10px; text-align: center; }
.pr-head h4:focus { outline: none; }
.pr-step.is-jumped .pr-card { box-shadow: 0 0 0 2px var(--color-text), var(--shadow-sm); transition: box-shadow 0.2s; }
.pr-here { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.3rem 0.6rem; margin: 0.45rem 0 0.1rem; padding: 0.45rem 0.6rem; border-radius: var(--radius-md); background: var(--color-bg); font-size: var(--fs-xs); }
.pr-here > span:first-child { font-size: var(--fs-2xs); font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--color-text-muted); }
.pr-here__group { display: inline-flex; flex-wrap: wrap; align-items: baseline; gap: 0.15rem 0.4rem; }
.pr-here a { color: var(--color-text); text-decoration: underline; text-decoration-color: var(--color-border-strong); text-underline-offset: 2px; }
.pr-here a:hover { text-decoration-color: currentColor; }
.pr-tools .pr-show { margin-left: auto; }
.pr-tools .pr-show + .pr-print { margin-left: 0; }
.pr-review { padding: 0.9rem 1rem 1rem; scroll-margin-top: calc(var(--top-h, 0px) + 1rem); }
.card.pr-review > h3 { margin: 0 0 0.35rem; font-size: var(--fs-2xs); font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--color-text-secondary); }
.pr-review__when { display: flex; gap: 0.5rem; align-items: baseline; margin: 0; font-size: var(--fs-sm); font-weight: 600; }
.pr-review__when .dot { transform: translateY(-1px); }
.pr-review__last { margin: 0.2rem 0 0; font-size: var(--fs-xs); color: var(--color-text-muted); }
.pr-review h4 { margin: 0.8rem 0 0.3rem; font-size: var(--fs-xs); font-weight: 650; color: var(--color-text-secondary); }
.pr-agenda { margin: 0; padding: 0 0 0 1.1rem; display: grid; gap: 0.3rem; font-size: var(--fs-xs); line-height: 1.5; color: var(--color-text-secondary); }
.pr-agenda .is-warn { color: var(--tone-warn-fg); }
.pr-review__acts { display: flex; flex-wrap: wrap; gap: 0.5rem 0.75rem; align-items: center; margin-top: 0.85rem; }
.pr-review__acts a { font-size: var(--fs-xs); font-weight: 600; color: var(--color-text-secondary); }
.pr .am-lede .pr-due span { color: var(--am-warn); font-weight: 600; }
.pr-review__err { margin: 0.5rem 0 0; font-size: var(--fs-xs); color: var(--tone-warn-fg); }
.pr-tools .pill-row__label { margin-left: 0; }
.pr-tools .pill-row + .pill-row { margin-left: 0.6rem; }
.pr-policy { display: flex; flex-wrap: wrap; align-items: center; gap: 0.3rem 0.4rem; margin-top: 0.7rem; padding-top: 0.6rem; border-top: 1px dashed var(--color-border); }
.pr-policy > span { font-size: var(--fs-2xs); font-weight: 600; letter-spacing: 0.06em; text-transform: uppercase; color: var(--color-text-muted); margin-right: 0.15rem; }
.pr-policy button { all: unset; box-sizing: border-box; cursor: pointer; display: inline-flex; align-items: center; gap: 0.3rem; min-height: 24px; padding: 0.15rem 0.6rem; border-radius: 6px; border: 1px solid var(--color-border); background: var(--color-bg-card); font-size: var(--fs-2xs); font-weight: 600; color: var(--color-text-secondary); }
.pr-policy button:hover:not(:disabled) { border-color: var(--color-border-strong); color: var(--color-text); }
.pr-policy button:focus-visible { box-shadow: var(--focus-ring-strong); }
.pr-policy button[aria-expanded="true"] { border-color: var(--color-text); color: var(--color-text); }
.pr-policy button:disabled { cursor: default; opacity: 0.6; }
.pr-quote { flex-basis: 100%; margin: 0.35rem 0 0; padding: 0.6rem 0.85rem; border-left: 3px solid var(--color-border-strong); border-radius: 0 var(--radius-md) var(--radius-md) 0; background: var(--color-bg); font-size: var(--fs-xs); line-height: 1.55; color: var(--color-text-secondary); }
.pr-quote h5 { margin: 0 0 0.3rem; font-size: var(--fs-xs); font-weight: 650; color: var(--color-text); }
.pr-quote p { margin: 0.15rem 0 0; }
.pr-quote p.l1 { padding-left: 0.9rem; }
.pr-quote p.l2, .pr-quote p.l3 { padding-left: 1.8rem; }
.pr-check { display: flex; gap: 0.55rem; align-items: baseline; margin: 0.6rem 0 0; padding: 0.55rem 0.75rem; border-radius: var(--radius-md); font-size: var(--fs-xs); line-height: 1.5; background: var(--tone-success-surface); color: var(--color-text); }
.pr-check.is-warn { background: var(--tone-warn-surface); box-shadow: inset 0 0 0 1px var(--tone-warn-line); }
.pr-check .dot { transform: translateY(-1px); }
.pr-now .pr-val { font-variant-numeric: tabular-nums; font-weight: 700; }
.pr-now .pr-val.is-warn { color: var(--tone-warn-fg); }
.pr-now a.pr-row { color: inherit; }
.pr-now div.pr-row { cursor: default; }
.pr-now div.pr-row:hover { background: none; }
@media (max-width: 1100px) {
  .pr-work { grid-template-columns: minmax(0, 1fr); }
  .pr-aside { position: static; order: -1; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); }
}
@media (max-width: 640px) {
  .pr-step { grid-template-columns: 1.75rem minmax(0, 1fr); gap: 0 0.6rem; }
  .pr-step::before { left: calc(0.875rem - 1px); top: 2.1rem; }
  .pr-num { width: 1.75rem; height: 1.75rem; font-size: var(--fs-xs); }
  .pr-card { padding: 0.7rem 0.8rem; }
  .pr-print, .pr-tools .pr-print { display: none; }
  .pr-tools .pr-show { margin-left: 0; }
  .pr-journey { padding-inline: 0.75rem; }
  /* On a phone the journey carries who's where; Right now and the review follow the steps */
  .pr-aside { order: 1; }
  .pr-rows { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); column-gap: 1.25rem; }
  .pr-rows > li:has(.pr-names) { grid-column: 1 / -1; }
  .pr-key { display: none; }
  .pr-tools .pill .pr-full { display: none; }
}
@media (min-width: 641px) { .pr-tools .pill .pr-short { display: none; } }
@media (pointer: coarse) {
  .pr-auto, .pr-more, .pr-policy button { min-height: 44px; padding-inline: 0.75rem; }
  .pr-jpart ol { grid-auto-columns: 44px; }
  .pr-jdot { width: 36px; height: 36px; }
  .pr-jstep { min-height: 44px; align-items: center; }
  .pr-row { min-height: 44px; align-items: center; }
}
@media screen { #pr-print-root { display: none; } }
@media print {
  body.pr-printing > *:not(#pr-print-root) { display: none !important; }
  body.pr-printing { background: #fff; padding: 0; }
  #pr-print-root { display: block; color: #1A1B1F; font: 11pt/1.45 Inter, system-ui, sans-serif; }
  .prp h1 { margin: 0; font-size: 18pt; letter-spacing: -0.01em; }
  .prp .prp-sub { margin: 0.2rem 0 1.1rem; color: #555; font-size: 9.5pt; }
  .prp h2 { margin: 1.1rem 0 0.4rem; font-size: 9pt; letter-spacing: 0.08em; text-transform: uppercase; color: #555; }
  .prp ol { margin: 0; padding-left: 1.4rem; }
  .prp > ol > li { margin: 0 0 0.55rem; break-inside: avoid; }
  .prp li b { font-weight: 650; }
  .prp ul { margin: 0.15rem 0 0; padding-left: 1.1rem; }
  .prp .prp-auto { color: #3d6b2a; font-size: 9pt; }
  .prp .prp-auto.is-off { color: #777; }
  .prp .prp-auto.is-attn { color: #8a5a00; }
  .prp .prp-policy { color: #555; font-size: 9pt; }
  @page { margin: 0.7in; }
}
`;
let cssDone = false;
function ensureCss() {
  ensureMapCss();
  if (cssDone) return;
  const s = document.createElement('style');
  s.textContent = CSS;
  document.head.appendChild(s);
  cssDone = true;
}

const Dot = ({ n }) => html`<span class=${`am-dot-i s-${n.es}${n.k === 'link' ? ' k-link' : ''}`} aria-hidden="true"></span>`;
// The sentence that explains a status that isn't simply on
const reasonOf = (n) => (n.probe?.s && n.probe.s === n.es ? n.probe.why : null) || n.note || null;

/** Every automation pinned in a list of steps (lines and the steps themselves), once each */
function autosIn(steps) {
  const out = new Set();
  const walk = (items) => items.forEach((i) => { i.autos.forEach((t) => out.add(t)); walk(i.items); });
  steps.forEach((s) => { s.autos.forEach((t) => out.add(t)); walk(s.items); });
  return out;
}

// ─── Print ────────────────────────────────

function PrintDoc({ track, doc, steps, byTitle, checks }) {
  const auto = (titles) => {
    const nodes = titles.map((t) => byTitle.get(t)).filter(Boolean);
    if (!nodes.length) return null;
    return html`<div class="prp-auto">Runs on its own: ${nodes.map((n, i) => html`${i ? ', ' : ''}<span class=${`prp-auto${n.es === 'attn' ? ' is-attn' : n.es === 'live' ? '' : ' is-off'}`}>${n.t} (${STATUS[n.es]})</span>`)}</div>`;
  };
  const lines = (items) => (items.length ? html`<ul>${items.map((i) => html`<li>${i.t}${auto(i.autos)}${lines(i.items)}</li>`)}</ul>` : null);
  const policy = (s) => [
    s.policy?.length ? html`<div class="prp-policy">Board policy: ${s.policy.join(', ')}</div>` : null,
    s.check && checks?.[s.check] ? html`<div class=${`prp-auto${checks[s.check].ok ? '' : ' is-attn'}`}>${checks[s.check].text}</div>` : null,
  ];
  const part = (list) => html`<ol>${list.map((s) => html`<li value=${s.n}><b>${s.t}</b>${lines(s.items)}${auto(s.autos)}${policy(s)}</li>`)}</ol>`;
  const applying = steps.filter((s) => s.part === 'applying');
  const fromDoc = steps.filter((s) => s.part !== 'applying');
  if (MONEY_TRACKS.includes(track)) {
    return html`<div class="prp">
      <h1>${TRACK_LABEL[track]}</h1>
      <p class="prp-sub">How it runs, with what runs on its own at each step and the board policy that governs it${doc?.name ? ` (“${doc.name}”)` : ''}. Printed ${longDate()} from Site → Automations → Process.</p>
      ${part(fromDoc)}
    </div>`;
  }
  return html`<div class="prp">
    <h1>${doc?.name || TRACK_LABEL[track]}</h1>
    <p class="prp-sub">${TRACK_LABEL[track]}, with what runs on its own at each step. Printed ${longDate()} from Site → Automations → Process${doc?.modifiedTime ? `; the Doc was last changed ${shortDate(doc.modifiedTime)}` : ''}.</p>
    ${applying.length > 0 && html`<h2>Applying, on the website</h2>${part(applying)}<h2>${doc?.name || 'The process'}</h2>`}
    ${part(fromDoc)}
  </div>`;
}

function printTrack(props) {
  let root = document.getElementById('pr-print-root');
  if (!root) {
    root = document.createElement('div');
    root.id = 'pr-print-root';
    document.body.appendChild(root);
  }
  render(html`<${PrintDoc} ...${props} />`, root);
  document.body.classList.add('pr-printing');
  const done = () => {
    document.body.classList.remove('pr-printing');
    render(null, root);
    window.removeEventListener('afterprint', done);
  };
  window.addEventListener('afterprint', done);
  window.print();
}

// ─── Right now ────────────────────────────

function RightNow({ now, track }) {
  const [openRow, setOpenRow] = useState(null);
  useEffect(() => setOpenRow(null), [track]);
  const t = now?.[track];
  const row = (key, label, v) => {
    if (!v) return null;
    const open = openRow === key;
    const unnamed = v.n - v.names.length;
    const link = (x) => (/^https?:/.test(x.href)
      ? html`<a href=${x.href} target="_blank" rel="noopener" title="Open the job in JobTread">${x.name}</a>`
      : html`<a href=${x.href} title="Open the family in Applicants">${x.name}</a>`);
    return html`<li key=${key}>
      <button type="button" class="pr-row" disabled=${!v.n} aria-expanded=${v.n ? String(open) : null} onClick=${() => setOpenRow(open ? null : key)}>
        <span>${label}</span><b>${v.n}</b>
      </button>
      ${open && html`<ul class="pr-names">
        ${v.names.map((x, i) => html`<li key=${i}>${link(x)}${x.page && html` <a class="pr-page" href=${x.page} target="_blank" rel="noopener">page</a>`}</li>`)}
        ${unnamed > 0 && html`<li>and ${unnamed} more</li>`}
      </ul>`}
    </li>`;
  };
  const apps = t && (t.applied || t.inReview);
  return html`<section class="card pr-now" aria-label="Right now">
    <h3>Right now</h3>
    ${!t ? html`<p>Couldn’t read Applicants and JobTread just now.</p>` : html`
      <p>Who’s at each stage, from Applicants and JobTread.</p>
      ${apps && html`<h4>Applications</h4>
        <ul class="pr-rows">${row('applied', 'Applied', t.applied)}${row('review', 'In review', t.inReview)}</ul>`}
      ${t.jobs && html`<h4>Jobs in JobTread</h4>
        <ul class="pr-rows">${Object.entries(t.jobs).map(([s, v]) => row(`job:${s}`, JOB_LABEL[s] || s, v))}</ul>`}
      <p class="pr-foot"><a href="#applications/applicants">Open Applicants</a></p>`}
  </section>`;
}

/** The money side right now, from the map's live facts: what's waiting, and the cash */
function MoneyNow({ facts, track }) {
  const jc = facts?.jobCosts;
  const z = facts?.zeffy;
  const fin = jc?.finance;
  const count = (label, n, href, warnAt = 1) => (typeof n === 'number' ? { label, value: n, href, warn: n >= warnAt } : null);
  const rows = (track === 'payables' ? [
    count('Bills waiting for an answer', jc?.billPay?.waiting, '#job-costs/bills'),
    count('Bills held for W-9 or insurance', jc?.vendors?.held, '#job-costs/bills'),
    count('Vendors asked for their papers', jc?.vendors?.asking, '#job-costs/bills', Infinity),
    count('Charges not sorted onto a job', jc?.unsorted, '#job-costs/charges'),
    count('Odd charges to look at', jc?.odd, '#job-costs/charges'),
  ] : track === 'receivables' ? [
    z?.lastPostAt ? { label: 'Last gift alert', value: html`<${Ago} iso=${z.lastPostAt} />` } : null,
    count('Gift alerts that didn’t post', z?.failing, null),
    count('Gifts the alert missed', z?.missed, null),
  ] : [
    fin ? { label: 'Cash 13 weeks ahead', value: fin.mercuryEmpty ? 'Waiting for Mercury' : fin.cashLow ? 'Under the floor' : 'Above the floor', warn: !!fin.cashLow } : null,
    fin?.at ? { label: 'Money in and out updated', value: html`<${Ago} iso=${fin.at} />` } : null,
    count('Finished jobs still to close out', jc?.closeouts?.historyLeft, '#job-costs/closeouts', Infinity),
  ]).filter(Boolean);
  return html`<section class="card pr-now" aria-label="Right now">
    <h3>Right now</h3>
    ${!facts ? html`<p>Couldn’t read the money side just now.</p>` : !rows.length ? html`<p>Nothing to show yet.</p>` : html`
      <p>${track === 'receivables' ? 'From Zeffy’s gift alerts.' : 'From Job Costs, Mercury and JobTread.'}</p>
      <ul class="pr-rows">${rows.map((r) => html`<li key=${r.label}>${r.href
        ? html`<a class="pr-row" href=${r.href}><span>${r.label}</span><span class=${`pr-val${r.warn ? ' is-warn' : ''}`}>${r.value}</span></a>`
        : html`<div class="pr-row" role="presentation"><span>${r.label}</span><span class=${`pr-val${r.warn ? ' is-warn' : ''}`}>${r.value}</span></div>`}</li>`)}</ul>
      ${track !== 'receivables' && html`<p class="pr-foot"><a href="#job-costs">Open Job Costs</a></p>`}`}
  </section>`;
}

// ─── One automation, in full ──────────────

function Detail({ n, kinds, onShowOnMap }) {
  const p = n.probe;
  const reason = n.es !== 'live' ? reasonOf(n) : null;
  return html`<div class="pr-detail" role="region" aria-label=${n.t}>
    <h5>${n.t}</h5>
    <div class="am-chips">
      <span class="tag"><${Dot} n=${n} /> ${STATUS[n.es]}</span>
      ${kinds[n.k] && html`<span class="tag">${kinds[n.k]}</span>`}
      <span class="tag am-chip-src">${p ? 'Checked live' : 'From the map'}</span>
    </div>
    <dl>
      ${p && (p.why || p.last) && html`<div><dt>Right now</dt><dd class=${`am-now s-${n.es}`}>${p.why || 'Running.'}${p.last && html`<small>Last ran <${Ago} iso=${p.last} /></small>`}</dd></div>`}
      ${reason && !(p && p.why === reason) && html`<div><dt>${n.es === 'attn' ? 'What needs doing' : 'Why it’s off'}</dt><dd class=${`am-now s-${n.es}`}>${reason}</dd></div>`}
      ${n.when && html`<div><dt>What starts it</dt><dd>${n.when}</dd></div>`}
      ${n.does && html`<div><dt>What it does</dt><dd>${n.does}</dd></div>`}
    </dl>
    <button type="button" class="btn btn-ghost btn-sm" onClick=${() => onShowOnMap(n.id)}>Show on the map</button>
  </div>`;
}

// ─── The page ─────────────────────────────

/**
 * model:      the map's prepared tree (its entries carry the live status once facts are in)
 * getFacts:   the page's shared read of the map's live facts
 * switcher:   the Map | Process control for the header
 * kinds:      the map's words for what starts an entry
 * onShowOnMap(id): open the map on an entry
 */
export function ProcessView({ model, getFacts, switcher, kinds, onShowOnMap }) {
  ensureCss();
  const [track, setTrackState] = useState(trackOfHash);
  lastTrack = track;
  const [data, setData] = useState(null);
  const [loadErr, setLoadErr] = useState(null);
  const [check, setCheck] = useState({ state: 'loading' });
  const [facts, setFacts] = useState(null);
  const [policyOpen, setPolicyOpen] = useState(null); // `${step}|${section}` shown
  const [reviewing, setReviewing] = useState({ busy: false, error: null });
  const [show, setShow] = useState('all'); // all | attn | hand
  const [jfocus, setJfocus] = useState(null); // the journey dot pointed at
  const [open, setOpen] = useState(null); // `${step}::${title}` shown in full
  const [linkForm, setLinkForm] = useState(null); // { value, saving, error }
  const [more, setMore] = useState(() => new Set()); // chip rows shown in full
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const byTitle = useMemo(() => new Map(model.ALL.map((n) => [n.t, n])), [model]);

  const load = async (fresh = false) => {
    setLoadErr(null);
    try {
      const res = await fetch(`${API}${fresh ? '?fresh=1' : ''}`, { headers: { Accept: 'application/json' } });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.success) throw new Error(body?.error || (res.ok ? 'the server didn’t send data; try reloading the admin' : `HTTP ${res.status}`));
      if (mounted.current) setData(body);
    } catch (e) {
      if (mounted.current) setLoadErr(e.message);
    }
  };
  const loadFacts = async (fresh = false) => {
    setCheck((c) => ({ ...c, state: 'loading' }));
    try {
      const body = await getFacts(fresh);
      model.applyFacts(body);
      if (!mounted.current) return;
      setFacts(body);
      setCheck({ state: 'ok', at: body.checkedAt });
    } catch (e) {
      model.applyFacts(null);
      if (mounted.current) { setFacts(null); setCheck({ state: 'error', error: e.message }); }
    }
  };
  useEffect(() => { load(); loadFacts(); }, []);

  // Escape closes the automation shown in full, back to its chip
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Escape' || e.defaultPrevented || document.querySelector('.modal-overlay')) return;
      const chip = document.querySelector('.pr-auto[aria-expanded="true"]');
      setOpen(null);
      chip?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  // Back and Forward between the tracks
  useEffect(() => {
    const on = () => { if (/^#automations\/process\b/.test(location.hash)) setTrackState(trackOfHash()); };
    window.addEventListener('popstate', on);
    window.addEventListener('hashchange', on);
    return () => { window.removeEventListener('popstate', on); window.removeEventListener('hashchange', on); };
  }, []);
  const setTrack = (t) => {
    setTrackState(t);
    setOpen(null);
    setLinkForm(null);
    setMore(new Set());
    setPolicyOpen(null);
    setReviewing({ busy: false, error: null });
    setShow('all');
    setJfocus(null);
    if (location.hash !== hashOfTrack(t)) history.replaceState(history.state, '', hashOfTrack(t));
  };

  const docKey = docOf(track);
  const money = MONEY_TRACKS.includes(track);
  const doc = data?.docs?.[docKey] || null;
  const sections = data?.docs?.policy?.sections || [];
  const steps = useMemo(() => pinSteps(track, money ? [] : doc?.steps || []), [track, doc]);
  // A money step whose settings differ from the manual
  const offPolicy = (s) => !!(s.check && data?.checks?.[s.check] && !data.checks[s.check].ok);
  // Who's at which step: each status on the step it means
  const placed = useMemo(() => (money ? new Map() : placeNow(track, steps, data?.now?.[track])), [track, steps, data]);
  const titles = useMemo(() => [...autosIn(steps)].filter((t) => byTitle.has(t)), [steps, byTitle]);
  const nodes = titles.map((t) => byTitle.get(t));
  const attn = nodes.filter((n) => n.es === 'attn');
  const counts = lineCounts(steps);
  const stepAutos = (s) => [...autosIn([s])].map((t) => byTitle.get(t)).filter(Boolean);
  // The filter: what needs attention, or what's still done by hand
  const byHand = (i) => !i.autos.length || i.items.some(byHand);
  const stepWarn = (s) => offPolicy(s) || stepAutos(s).some((n) => n.es === 'attn');
  const stepShown = (s) => (show === 'attn' ? stepWarn(s) : show === 'hand' ? (s.items.length ? s.items.some(byHand) : !s.autos.length) : true);

  const pipelineTotal = (t) => {
    const p = data?.now?.[t];
    if (!p) return null;
    return (p.applied?.n || 0) + (p.inReview?.n || 0) + Object.values(p.jobs || {}).reduce((s, v) => s + v.n, 0);
  };

  const followLink = async (link) => {
    setLinkForm((f) => ({ ...f, saving: true, error: null }));
    try {
      const res = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ track: docKey, link }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.success) throw new Error(body.error || `Couldn’t save (${res.status})`);
      setData(body);
      setLinkForm(null);
    } catch (e) {
      setLinkForm((f) => ({ ...f, saving: false, error: e.message }));
    }
  };

  // The yearly review of this track's Doc (the manual, for money)
  const reviewed = data?.reviews?.[docKey] || null;
  const rv = doc?.doc ? reviewOf(doc.doc, { reviewedAt: reviewed?.at, yearly: docKey !== 'policy' }) : null;
  const markReviewed = async () => {
    setReviewing({ busy: true, error: null });
    try {
      const res = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ review: docKey }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.success) throw new Error(body.error || `Couldn’t save (${res.status})`);
      setData(body);
      setReviewing({ busy: false, error: null });
    } catch (e) {
      setReviewing({ busy: false, error: e.message });
    }
  };
  const jump = (key) => {
    const el = document.getElementById(`pr-${key}`);
    if (!el) return;
    el.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    el.classList.add('is-jumped');
    setTimeout(() => el.classList.remove('is-jumped'), 1600);
    el.querySelector('h4')?.focus({ preventScroll: true });
  };
  const goToReview = () => requestAnimationFrame(() => document.getElementById('pr-review')?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }));

  const goToFirstAttn = () => {
    const s = steps.find((x) => offPolicy(x) || stepAutos(x).some((n) => n.es === 'attn'));
    if (!s) return;
    const key = `${s.part}-${s.n}`;
    const scrollTo = () => requestAnimationFrame(() => document.getElementById(`pr-${key}`)?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }));
    const n = stepAutos(s).find((x) => x.es === 'attn');
    if (!n) { scrollTo(); return; }
    // Its chip: on the first line that names it (keys as lineList makes them), else the step's own row
    const lineKey = (items, k, depth) => {
      for (const [idx, i] of items.entries()) {
        const here = `${k}.${depth}-${idx}`;
        const found = i.autos.includes(n.t) ? here : lineKey(i.items, here, depth + 1);
        if (found) return found;
      }
      return null;
    };
    setOpen(`${lineKey(s.items, key, 0) || `${key}:whole`}::${n.t}`);
    scrollTo();
  };

  // ─── Pieces ───
  const chips = (key, list) => {
    const all = list.map((t) => byTitle.get(t)).filter(Boolean);
    if (!all.length) return null;
    const shown = all.find((n) => open === `${key}::${n.t}`);
    // A long row shows what needs a look first and the first few; the rest one tap away (and always the one open)
    const rank = (n) => (n.es === 'attn' ? 0 : 1);
    const ordered = [...all].sort((a, b) => rank(a) - rank(b));
    const long = ordered.length > CHIPS && !more.has(key);
    const here = long ? ordered.filter((n, i) => i < CHIPS - 1 || n === shown) : ordered;
    return html`<div class="pr-autos">
      ${here.map((n) => {
        const id = `${key}::${n.t}`;
        const isOpen = open === id;
        return html`<button type="button" key=${n.t} class=${`pr-auto s-${n.es}`} aria-expanded=${String(isOpen)} title=${`${n.t}: ${STATUS[n.es]}`} onClick=${() => setOpen(isOpen ? null : id)}>
          <${Dot} n=${n} /><span>${n.t}</span>
        </button>`;
      })}
      ${long && html`<button type="button" class="pr-more" onClick=${() => setMore((m) => new Set(m).add(key))}>${ordered.length - here.length} more</button>`}
    </div>
    ${shown && html`<${Detail} n=${shown} kinds=${kinds} onShowOnMap=${onShowOnMap} />`}`;
  };
  const lineList = (key, items, depth = 0) => (items.length ? html`<ul class="pr-lines">
    ${items.map((i, idx) => {
      const k = `${key}.${depth}-${idx}`;
      if (show === 'hand' && !byHand(i)) return null;
      return html`<li key=${k} class=${`pr-line${i.autos.length ? ' has-auto' : ''}`}>
        <span class="pr-text">${i.t}</span>
        ${chips(k, i.autos)}
        ${lineList(k, i.items, depth + 1)}
      </li>`;
    })}
  </ul>` : null);
  const stepEl = (s) => {
    const key = `${s.part}-${s.n}`;
    const all = stepAutos(s);
    const warn = all.some((n) => n.es === 'attn') || offPolicy(s);
    const running = all.filter((n) => n.es === 'live').length;
    const chk = s.check ? data?.checks?.[s.check] : null;
    return html`<li key=${key} id=${`pr-${key}`} class=${`pr-step${running ? ' is-auto' : ''}${warn ? ' is-attn' : ''}`}>
      <span class="pr-num" aria-hidden="true">${s.n}</span>
      <div class="card pr-card">
        <div class="pr-head">
          <h4 tabindex="-1"><span class="sr-only">Step ${s.n}: </span>${s.t}</h4>
          ${warn ? html`<span class="tag tag--warn">Needs attention</span>`
            : running ? html`<span class="tag tag--success">${running === all.length ? plural(all.length, 'automation') : `${running} of ${all.length} automations on`}</span>`
            : all.length ? html`<span class="tag">${all.length === 1 ? 'Automation off' : 'Automations off'}</span>`
            : html`<span class="tag">By hand</span>`}
        </div>
        ${hereEl(key)}
        ${lineList(key, s.items)}
        ${s.autos.length > 0 && show !== 'hand' && html`<div class="pr-whole">
          <p>${s.items.length ? 'Also through this step' : 'Through this step'}</p>
          ${chips(`${key}:whole`, s.autos)}
        </div>`}
        ${chk && html`<p class=${`pr-check${chk.ok ? '' : ' is-warn'}`} role="status"><span class=${`dot ${chk.ok ? 'dot--on' : 'dot--warn'}`} aria-hidden="true"></span><span>${chk.text}${chk.ok ? '' : ' Change it in Job Costs → Bills → Settings, or People → Board.'}</span></p>`}
        ${s.policy?.length > 0 && policyEl(key, s.policy)}
      </div>
    </li>`;
  };
  // Who's at this step now, by the JobTread status that puts them here
  const hereEl = (key) => {
    const here = placed.get(key);
    if (!here?.length) return null;
    const link = (x) => (/^https?:/.test(x.href)
      ? html`<a href=${x.href} target="_blank" rel="noopener" title="Open the job in JobTread">${x.name}</a>`
      : html`<a href=${x.href} title="Open the family in Applicants">${x.name}</a>`);
    return html`<div class="pr-here">
      <span>Here now</span>
      ${here.map((h) => html`<span class="pr-here__group" key=${h.status}>
        <span class="tag" title="Their status in JobTread">${JOB_LABEL[h.status] || h.status}</span>
        <span class="pr-here__names">${h.names.map((x, i) => html`${i ? ', ' : ''}${link(x)}`)}${h.n > h.names.length ? `${h.names.length ? ', and' : ''} ${h.n - h.names.length} more` : ''}</span>
      </span>`)}
    </div>`;
  };
  // The journey at a glance: a dot per step, who's there, a click away
  const journeyEl = () => {
    const parts = money ? [['', steps]] : [['Applying', applying], [track === 'makeover' ? 'The makeover' : 'The project', fromDoc]].filter(([, l]) => l.length);
    const at = (s) => (placed.get(`${s.part}-${s.n}`) || []).reduce((n, h) => n + h.n, 0);
    const focused = jfocus && steps.find((s) => `${s.part}-${s.n}` === jfocus);
    const words = (s) => {
      const all = stepAutos(s);
      const n = at(s);
      return `${stepWarn(s) ? 'needs attention' : all.some((x) => x.es === 'live') ? `${plural(all.length, 'automation')}` : 'by hand'}${n ? `, ${n} here now` : ''}`;
    };
    return html`<nav class="card pr-journey" aria-label="The steps at a glance">
      <div class="pr-jrow">
        ${parts.map(([label, list]) => html`<div class="pr-jpart" key=${label || 'all'}>
          ${label && html`<span class="pr-jlabel">${label}</span>`}
          <ol>${list.map((s) => {
            const key = `${s.part}-${s.n}`;
            const all = stepAutos(s);
            const n = at(s);
            const cls = `pr-jstep${all.some((x) => x.es === 'live') ? ' is-auto' : ''}${stepWarn(s) ? ' is-attn' : ''}${stepShown(s) ? '' : ' is-dim'}`;
            return html`<li key=${key} class=${cls}>
              <button type="button" class="pr-jdot" aria-label=${`Step ${s.n}: ${s.t}, ${words(s)}`}
                onClick=${() => jump(key)} onMouseEnter=${() => setJfocus(key)} onFocus=${() => setJfocus(key)}
                onMouseLeave=${() => setJfocus(null)} onBlur=${() => setJfocus(null)}>${s.n}</button>
              ${n > 0 && html`<span class="pr-jcount" aria-hidden="true">${n}</span>`}
            </li>`;
          })}</ol>
        </div>`)}
      </div>
      <p class="pr-jcap" aria-hidden="true">
        ${focused ? html`<span><b>${focused.n}. ${focused.t}</b>: ${words(focused)}</span>` : html`
          <span class="pr-jkey"><i class="k-auto"></i>Runs on its own</span>
          <span class="pr-jkey"><i></i>By hand</span>
          <span class="pr-jkey"><i class="k-auto k-attn"></i>Needs attention</span>
          ${!money && html`<span class="pr-jkey"><b>2</b>Here now</span>`}`}
      </p>
    </nav>`;
  };
  // The manual's sections that govern a step, each opening to its words as the manual has them
  const policyEl = (key, names) => {
    const found = (name) => sections.find((x) => x.t.toLowerCase() === name.toLowerCase()) || null;
    const shownName = names.find((name) => policyOpen === `${key}|${name}`);
    const shown = shownName ? found(shownName) : null;
    return html`<div class="pr-policy">
      <span>Board policy</span>
      ${names.map((name) => {
        const sec = found(name);
        const isOpen = policyOpen === `${key}|${name}`;
        return html`<button type="button" key=${name} disabled=${!sec} aria-expanded=${sec ? String(isOpen) : null}
          title=${sec ? `The manual’s “${name}” section` : 'Not in the manual as Process last read it'} onClick=${() => setPolicyOpen(isOpen ? null : `${key}|${name}`)}>${name}</button>`;
      })}
      ${shown && html`<div class="pr-quote" role="region" aria-label=${`Board policy: ${shown.t}`}>
        <h5>${shown.t}</h5>
        ${shown.lines.map((l, i) => html`<p key=${i} class=${`l${Math.min(l.level ?? 1, 3)}`}>${l.t}</p>`)}
      </div>`}
    </div>`;
  };

  const applying = steps.filter((s) => s.part === 'applying');
  const fromDoc = steps.filter((s) => s.part === 'doc');
  const docLabel = doc?.doc?.name ? `“${doc.doc.name}”` : { makeover: 'the makeover process Doc', community: 'the community project process Doc', policy: 'the board’s Financial Policy Manual' }[docKey];

  const sourceLine = doc?.doc && html`<p class="pr-src">
    <span>${money ? 'The board policy is' : 'From'} ${docLabel} in Google Drive${doc.doc.modifiedTime ? `, changed ${shortDate(doc.doc.modifiedTime)}${doc.doc.modifiedBy ? ` by ${doc.doc.modifiedBy}` : ''}` : ''}.</span>
    <a href=${doc.doc.url} target="_blank" rel="noopener">${money ? 'Open the manual' : 'Open the Doc'}</a>
    ${!linkForm && html`<button type="button" onClick=${() => setLinkForm({ value: '', saving: false, error: null })}>${doc.override ? 'Following a pasted link' : 'Not the right Doc?'}</button>`}
  </p>`;
  const linkEl = linkForm && html`<form class="pr-link" onSubmit=${(e) => { e.preventDefault(); followLink(linkForm.value.trim()); }}>
    <input class="form-input" type="url" inputmode="url" aria-label="The process Doc’s link" placeholder="Paste the Doc’s link from Google Drive" value=${linkForm.value}
      onInput=${(e) => setLinkForm((f) => ({ ...f, value: e.target.value, error: null }))} />
    <button type="submit" class="btn btn-primary btn-sm" disabled=${linkForm.saving || !linkForm.value.trim()}>${linkForm.saving ? 'Reading it…' : 'Follow this Doc'}</button>
    ${doc?.override && html`<button type="button" class="btn btn-ghost btn-sm" disabled=${linkForm.saving} onClick=${() => followLink('')}>Find it by name again</button>`}
    <button type="button" class="btn btn-ghost btn-sm" disabled=${linkForm.saving} onClick=${() => setLinkForm(null)}>Cancel</button>
    <p class=${linkForm.error ? 'pr-link__err' : ''} role=${linkForm.error ? 'alert' : null}>${linkForm.error || `Process finds the newest Doc named like “${docKey === 'policy' ? DOC_LIKE.policy : `${new Date().getFullYear()} ${DOC_LIKE[docKey]}`}” on its own. Paste a link only for a Doc named some other way.`}</p>
  </form>`;
  const docProblem = doc?.error && html`<div class="notice notice--warn" role="status">
    <div class="notice__body"><strong>${doc.steps.length || doc.sections?.length ? `Couldn’t read ${docLabel} just now.` : `Couldn’t read ${docLabel}.`}</strong> ${doc.error}${(doc.steps.length || doc.sections?.length) && doc.readAt ? ` ${money ? 'The policy shown is as' : 'These are the steps as'} read ${ago(doc.readAt)}.` : ''}</div>
    ${!linkForm && !doc.doc && html`<div class="notice__actions"><button type="button" class="btn btn-ghost btn-sm" onClick=${() => setLinkForm({ value: '', saving: false, error: null })}>Paste the Doc’s link</button></div>`}
  </div>`;

  const who = (email) => { const n = String(email || '').split('@')[0]; return n ? n[0].toUpperCase() + n.slice(1) : ''; };
  const days = (iso) => Math.max(0, Math.ceil((Date.parse(iso) - Date.now()) / 86400000));
  const reviewEl = () => {
    if (!rv) return null;
    const what = money ? 'manual' : 'Doc';
    const when = rv.nextYear ? `Due now: it’s ${rv.nextYear}.`
      : rv.state === 'due' ? `Overdue since ${shortDate(rv.dueAt)}.`
      : rv.state === 'soon' ? `Due ${shortDate(rv.dueAt)}, in ${plural(days(rv.dueAt), 'day')}.`
      : `Next due ${shortDate(rv.dueAt)}.`;
    const marked = reviewed && (!doc.doc.modifiedTime || reviewed.at >= doc.doc.modifiedTime);
    const last = marked ? `Marked reviewed ${shortDate(reviewed.at)}${reviewed.by ? ` by ${who(reviewed.by)}` : ''}.`
      : `The ${what} last changed ${shortDate(doc.doc.modifiedTime)}${doc.doc.modifiedBy ? ` by ${doc.doc.modifiedBy}` : ''}.`;
    const byHand = counts.lines - counts.auto;
    const agenda = [
      rv.nextYear && html`<li class="is-warn">The Doc is named for ${docYear(doc.doc.name)}. Make the ${rv.nextYear} Doc; Process follows it once it’s in Drive.</li>`,
      byHand > 0 && html`<li>${byHand} of ${counts.lines} tasks are done by hand.</li>`,
      attn.length > 0 && html`<li class="is-warn">${plural(attn.length, 'automation')} here ${attn.length === 1 ? 'needs' : 'need'} attention.</li>`,
      ...(money ? retiredMentions(sections).map((m) => html`<li class="is-warn">The manual names ${m.word} (${m.sections.join(', ')}); ${m.now}.</li>`) : []),
      money && steps.some(offPolicy) && html`<li class="is-warn">Bill approvals differ from the manual (Approving a bill).</li>`,
      html`<li>Every step still matches how the work is done today.</li>`,
    ].filter(Boolean);
    return html`<section class="card pr-review" id="pr-review" aria-label="Yearly review">
      <h3>Yearly review</h3>
      <p class="pr-review__when"><span class=${`dot ${rv.state === 'due' ? 'dot--warn' : rv.state === 'soon' ? 'dot--info' : 'dot--on'}`} aria-hidden="true"></span><span>${when}</span></p>
      <p class="pr-review__last">${last}</p>
      <h4>To look at</h4>
      <ul class="pr-agenda">${agenda}</ul>
      <div class="pr-review__acts">
        ${rv.state !== 'ok' && html`<button type="button" class="btn btn-primary btn-sm" disabled=${reviewing.busy} onClick=${markReviewed}>${reviewing.busy ? 'Saving…' : 'Reviewed, no changes'}</button>`}
        <a href=${doc.doc.url} target="_blank" rel="noopener">${money ? 'Open the manual' : 'Open the Doc'}</a>
      </div>
      ${reviewing.error && html`<p class="pr-review__err" role="alert">${reviewing.error}</p>`}
    </section>`;
  };

  const header = html`<div class="page-header" style="margin-bottom: 0.4rem;">
    <div>
      <h2>Automations</h2>
      <p class="page-sub">How SOARD works, step by step: kids’ makeovers and community projects as SOARD’s process Docs say, and the money side under the board’s financial policy, with what runs on its own at each step.</p>
    </div>
    ${switcher}
  </div>`;

  if (loadErr && !data) {
    return html`<div class="am pr">${header}
      <div class="notice notice--warn" role="alert"><div class="notice__body"><strong>Couldn’t load the process.</strong> ${loadErr}</div>
        <div class="notice__actions"><button type="button" class="btn btn-ghost btn-sm" onClick=${() => load(true)}>Try again</button></div></div>
    </div>`;
  }
  if (!data) return html`<div class="am pr">${header}<div style="text-align:center;padding:2rem"><span class="spinner" /></div></div>`;

  return html`<div class="am pr">
    ${header}
    <div class="pr-tools">
      ${[['Projects', PROJECT_TRACKS], ['Money', MONEY_TRACKS]].map(([group, list]) => html`<div class="pill-row" role="group" aria-label=${group} key=${group}>
        <span class="pill-row__label" aria-hidden="true">${group}</span>
        ${list.map((t) => {
          const n = pipelineTotal(t);
          return html`<button key=${t} type="button" class="pill" aria-pressed=${String(track === t)} onClick=${() => setTrack(t)}>
            <span class="pr-full">${TRACK_LABEL[t]}</span><span class="pr-short">${TRACK_SHORT[t]}</span>${n ? html`<span class="count" title=${`${n} under way right now`}>${n}</span>` : null}
          </button>`;
        })}
      </div>`)}
      <div class="seg pr-show" role="group" aria-label="Show">
        ${[['all', 'Everything'], ['attn', 'Needs attention'], ['hand', 'By hand']].map(([k, label]) => html`<button key=${k} type="button" aria-pressed=${String(show === k)} onClick=${() => setShow(k)}>${label}</button>`)}
      </div>
      <button type="button" class="btn btn-ghost btn-sm pr-print" disabled=${!steps.length} onClick=${() => printTrack({ track, doc: doc?.doc, steps, byTitle, checks: data?.checks })}>Print</button>
    </div>
    <ul class="am-lede">
      <li><b>${steps.length}</b> steps</li>
      <li><b>${counts.auto}</b> of ${counts.lines} tasks run on their own</li>
      <li><b>${nodes.length}</b> automations along the way</li>
      ${attn.length + steps.filter(offPolicy).length > 0 && html`<li class="am-warnstat"><button type="button" onClick=${goToFirstAttn}><b>${attn.length + steps.filter(offPolicy).length}</b> <span>need${attn.length + steps.filter(offPolicy).length === 1 ? 's' : ''} attention</span></button></li>`}
      ${rv && rv.state !== 'ok' && html`<li class=${rv.state === 'due' ? 'pr-due' : ''}><button type="button" onClick=${goToReview}>${rv.state === 'due' ? html`<span>Yearly review due</span>` : html`<span>Yearly review in ${plural(days(rv.dueAt), 'day')}</span>`}</button></li>`}
    </ul>
    <p class=${`am-check${check.state === 'ok' ? '' : ' is-off'}`} aria-live="polite">
      <i aria-hidden="true"></i>
      ${check.state === 'loading' && 'Checking live status…'}
      ${check.state === 'ok' && html`<span>Statuses checked live <${Ago} iso=${check.at} />.</span>`}
      ${check.state === 'error' && html`<span>Couldn’t check live status (${check.error}). Showing the statuses as written on the map.</span>`}
      ${check.state === 'error' && html`<button type="button" onClick=${() => loadFacts(true)}>Try again</button>`}
    </p>
    ${sourceLine}
    ${linkEl}
    ${docProblem}

    <div class="pr-work">
      <div>
        ${steps.length > 0 && journeyEl()}
        ${show !== 'all' && !steps.some(stepShown) && html`<div class="card pr-empty"><p class="am-empty">${show === 'attn' ? 'Nothing in this process needs attention.' : 'Every task here runs on its own.'}</p></div>`}
        ${money ? html`
          <div class="pr-part"><h3>${TRACK_LABEL[track]}</h3><span>How it runs today. SOARD has no process Doc for it; each step shows the board policy that governs it.</span></div>
          <ol class="pr-steps">${steps.filter(stepShown).map(stepEl)}</ol>` : html`
          ${applying.some(stepShown) && html`
            <div class="pr-part"><h3>Applying</h3><span>On the website, in the steps of the ${APPLYING_SOURCE} handout</span></div>
            <ol class="pr-steps">${applying.filter(stepShown).map(stepEl)}</ol>`}
          ${(show === 'all' || fromDoc.some(stepShown)) && html`<div class="pr-part"><h3>${track === 'makeover' ? 'The makeover' : 'The project'}</h3><span>${doc?.doc ? `As ${docLabel} has it` : 'From the process Doc'}</span></div>`}
          ${fromDoc.length ? html`<ol class="pr-steps">${fromDoc.filter(stepShown).map(stepEl)}</ol>`
            : html`<div class="card pr-empty"><p class="am-empty">${doc?.error ? 'The steps show here once the Doc can be read.' : 'No steps in the Doc yet.'}</p></div>`}`}
      </div>
      <aside class="pr-aside">
        ${money ? html`<${MoneyNow} facts=${facts} track=${track} />` : html`<${RightNow} now=${data.now} track=${track} />`}
        ${reviewEl()}
        <div class="card pr-key">
          <p><i class="k-auto"></i><span>A step where something runs on its own. Pick one to see what it does and how it’s doing.</span></p>
          <p><i class="k-hand"></i><span>Done by hand: nothing runs on its own here yet.</span></p>
        </div>
      </aside>
    </div>
  </div>`;
}
