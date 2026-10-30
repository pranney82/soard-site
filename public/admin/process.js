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
 * Above the steps, the process map: a swimlane per who does the work (and
 * one for what runs on its own), a column per step, each task in its owner's
 * lane, the flow drawn task to task with every handoff between lanes marked,
 * the decisions, the times the Docs set, how long the application steps
 * really take, and who's at each step now. Pointing at a task lights up its
 * automations; clicking opens the step below. It zooms to fit and prints on
 * one landscape page. On a phone the journey bar stands in for it: a dot per step (something runs on
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
import { TRACK_LABEL, PROJECT_TRACKS, MONEY_TRACKS, DOC_LIKE, APPLYING_SOURCE, WITH_LABEL, pinSteps, lineCounts, reviewOf, retiredMentions, docYear, placeNow, mapOf, byName } from './process-shared.js';

const html = htm.bind(h);
const API = '/api/process-admin';
// A phone's narrower names for the tracks
const TRACK_SHORT = { makeover: 'Makeovers', community: 'Community', payables: 'Payables', receivables: 'Gifts', books: 'Books' };
// The Doc each track reads (its own process); money's rules are in the board's manual beside it
const docOf = (t) => t;
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
.pr-map { padding: 0; margin-bottom: 1.1rem; overflow: hidden; }
.pr-map__bar { display: flex; flex-wrap: wrap; align-items: center; gap: 0.4rem 1rem; padding: 0.6rem 1rem 0.55rem; border-bottom: 1px solid var(--color-border); }
.pr-map__bar h3 { margin: 0; font-size: var(--fs-2xs); font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--color-text-secondary); }
.pr-map__facts { display: flex; flex-wrap: wrap; gap: 0.2rem 0.9rem; font-size: var(--fs-xs); color: var(--color-text-secondary); }
.pr-map__facts b { color: var(--color-text); font-variant-numeric: tabular-nums; }
.pr-map__acts { order: 2; display: flex; gap: 0.3rem; margin-left: auto; }
.pr-map__acts button { all: unset; box-sizing: border-box; cursor: pointer; min-width: 30px; height: 28px; padding: 0 0.55rem; border: 1px solid var(--color-border); border-radius: 7px; background: var(--color-bg-card); font-size: var(--fs-xs); font-weight: 600; color: var(--color-text-secondary); text-align: center; }
.pr-map__acts button:hover { color: var(--color-text); border-color: var(--color-border-strong); }
.pr-map__acts button:focus-visible { box-shadow: var(--focus-ring-strong); }
.pr-map__acts button[aria-pressed="true"] { background: var(--color-text); border-color: var(--color-text); color: #fff; }
.pr-mnav { order: 3; flex-basis: 100%; display: flex; gap: 0.6rem; align-items: center; overflow-x: auto; scrollbar-width: none; padding: 0.2rem 0 0.05rem; }
.pr-mnav::-webkit-scrollbar { display: none; }
.pr-mnav ol { list-style: none; margin: 0; padding: 0; display: flex; }
.pr-mnav li { position: relative; display: flex; padding: 2px 1.5px; }
.pr-mnav button { all: unset; box-sizing: border-box; cursor: pointer; width: 22px; height: 22px; border-radius: 50%; display: grid; place-items: center; font-size: 10px; font-weight: 700; font-variant-numeric: tabular-nums; background: var(--color-bg-card); border: 1.5px solid var(--color-border-strong); color: var(--color-text-secondary); }
.pr-mnav button.is-auto { background: var(--color-sidebar); border-color: var(--color-sidebar); color: #fff; }
.pr-mnav button.is-attn { box-shadow: 0 0 0 2px color-mix(in srgb, var(--am-warn) 50%, transparent); }
.pr-mnav button:focus-visible { box-shadow: var(--focus-ring-strong); }
.pr-mnav li.in-view { background: color-mix(in srgb, var(--color-text) 11%, transparent); }
.pr-mnav li.in-view:first-child, .pr-mnav li:not(.in-view) + li.in-view { border-radius: 999px 0 0 999px; padding-left: 3px; }
.pr-mnav li.in-view:last-child, .pr-mnav li.in-view:has(+ li:not(.in-view)) { border-top-right-radius: 999px; border-bottom-right-radius: 999px; padding-right: 3px; }
.pr-mnav i { font-style: normal; font-size: var(--fs-2xs); font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--color-text-muted); white-space: nowrap; }
.pr-map__body { position: relative; display: flex; }
.pr-map__scroll { position: relative; flex: 1 1 auto; min-width: 0; overflow: auto; max-height: calc(100vh - var(--top-h, 0px) - 8.5rem); min-height: 22rem; background: var(--color-bg-card); }
.pr-map__grid { position: relative; display: grid; grid-template-columns: var(--label) repeat(var(--slots), var(--slot)); grid-auto-rows: auto; width: max-content; }
.pr-map__flow { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; overflow: visible; z-index: 3; color: var(--color-text-muted); }
.pr-map__flow path { fill: none; stroke: currentColor; stroke-width: 1.4; opacity: 0.55; }
.pr-map__flow path.is-handoff { stroke: var(--color-text); stroke-width: 1.6; opacity: 0.75; }
.pr-mcorner { position: sticky; left: 0; top: 0; z-index: 10; background: var(--color-bg-card); border-right: 1px solid var(--color-border); }
.pr-mband { position: sticky; top: 0; z-index: 6; padding: 0.45rem 0.8rem 0.3rem; background: var(--color-bg-card); font-size: var(--fs-2xs); font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; color: var(--color-text-muted); white-space: nowrap; box-shadow: inset 0 2px 0 var(--color-border-strong); }
.pr-mband > span { position: sticky; left: calc(var(--label) + 0.8rem); }
.pr-mband.is-applying { box-shadow: inset 0 2px 0 #2B6CB0; }
.pr-mband.is-doc { box-shadow: inset 0 2px 0 #13807A; }
.pr-mband.is-money { box-shadow: inset 0 2px 0 #A0571A; }
.pr-mh { position: sticky; top: 1.75rem; z-index: 5; display: flex; flex-direction: column; gap: 0.35rem; min-width: 0; padding: 0.4rem 0.7rem 0.55rem; background: var(--color-bg-card); border-bottom: 1px solid var(--color-border); }
.pr-mh.is-focus, .pr-mh.is-open { box-shadow: inset 0 -3px 0 var(--color-text); }
.pr-mh__t { all: unset; cursor: pointer; display: flex; gap: 0.45rem; align-items: flex-start; font-size: var(--fs-sm); font-weight: 650; line-height: 1.3; color: var(--color-text); }
div.pr-mh__t { cursor: default; }
button.pr-mh__t:hover span { text-decoration: underline; text-underline-offset: 2px; }
.pr-mh__t:focus-visible { box-shadow: var(--focus-ring-strong); border-radius: 4px; }
.pr-mh__t b { flex: none; width: 1.35rem; height: 1.35rem; margin-top: -1px; border-radius: 50%; display: grid; place-items: center; font-size: 10.5px; background: var(--color-bg-card); border: 1.5px solid var(--color-border-strong); color: var(--color-text-secondary); }
.pr-mh.is-auto .pr-mh__t b { background: var(--color-sidebar); border-color: var(--color-sidebar); color: #fff; }
.pr-mh.is-attn .pr-mh__t b { box-shadow: 0 0 0 3px color-mix(in srgb, var(--am-warn) 45%, transparent); }
.pr-mh__t span { display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.pr-mh__row { display: flex; flex-wrap: wrap; align-items: center; gap: 0.3rem 0.6rem; padding-left: 1.8rem; }
.pr-avs { display: inline-flex; align-items: center; }
.pr-av { box-sizing: border-box; width: 22px; height: 22px; margin-right: -6px; border-radius: 50%; border: 2px solid var(--color-bg-card); background: var(--color-bg-hover); display: inline-grid; place-items: center; overflow: hidden; font-size: 8.5px; font-weight: 700; color: var(--color-text-secondary); text-decoration: none; }
.pr-av img { width: 100%; height: 100%; object-fit: cover; display: block; }
a.pr-av:hover { border-color: var(--color-text); z-index: 1; }
a.pr-av:focus-visible { box-shadow: var(--focus-ring-strong); }
.pr-av.is-more { background: var(--color-text); color: #fff; }
.pr-avs__n { margin-left: 0.6rem; font-size: var(--fs-2xs); font-weight: 600; color: var(--color-text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 7rem; }
.pr-mh__cycle { display: inline-flex; align-items: center; gap: 0.25rem; white-space: nowrap; font-size: var(--fs-2xs); font-weight: 600; padding: 0.05rem 0.45rem; border-radius: 999px; background: var(--tone-info-bg); color: var(--tone-info-fg); }
.pr-mh__cycle svg { width: 11px; height: 11px; }
.pr-mrow { z-index: 0; border-top: 1px solid var(--color-border); }
.pr-mrow.is-alt { background: color-mix(in srgb, var(--color-bg) 70%, var(--color-bg-card)); }
.pr-mrow.is-rail { position: sticky; bottom: 0; z-index: 5; background: var(--color-bg); border-top: 1px dashed var(--color-border-strong); box-shadow: 0 -6px 12px -10px rgba(0, 0, 0, 0.25); }
.pr-msep { z-index: 1; border-left: 1px solid var(--color-border); pointer-events: none; }
.pr-mopen { z-index: 1; pointer-events: none; background: color-mix(in srgb, var(--color-text) 6%, transparent); }
.pr-mlane { position: sticky; left: 0; z-index: 7; display: flex; align-items: center; padding: 0.55rem 0.7rem 0.55rem 0.8rem; background: var(--color-bg-card); border-right: 1px solid var(--color-border); border-top: 1px solid var(--color-border); box-shadow: inset 3px 0 0 var(--lc, var(--color-border-strong)); font-size: var(--fs-xs); font-weight: 650; line-height: 1.25; color: var(--color-text); }
.pr-mlane > span { display: flex; align-items: center; gap: 0.45rem; }
.pr-mlane svg { flex: none; width: 15px; height: 15px; color: var(--lc, var(--color-text-secondary)); }
.pr-mlane.is-rail { --lc: #13807A; bottom: 0; z-index: 9; background: var(--color-bg); border-top: 1px dashed var(--color-border-strong); color: var(--color-text-secondary); }
.pr-mcard { all: unset; box-sizing: border-box; position: relative; z-index: 4; cursor: pointer; align-self: center; justify-self: center; width: calc(var(--slot) - 22px); margin: 0.5rem 0; display: flex; flex-direction: column; gap: 0.3rem; padding: 0.45rem 0.6rem 0.45rem 0.65rem; border: 1px solid var(--color-border); border-left: 3px solid var(--lc, var(--color-border-strong)); border-radius: 7px; background: var(--color-bg-card); box-shadow: var(--shadow-xs); font-size: 12px; line-height: 1.35; color: var(--color-text); }
div.pr-mcard { cursor: default; }
.pr-mcard:hover, .pr-mcard.is-lit { border-color: var(--color-text); border-left-color: var(--lc, var(--color-text)); box-shadow: var(--shadow-sm); }
.pr-mcard:focus-visible { box-shadow: var(--focus-ring-strong); }
.pr-mcard.s-attn { background: color-mix(in srgb, var(--am-warn) 8%, var(--color-bg-card)); }
.pr-mcard.is-self { font-weight: 650; }
.pr-mcard__t { display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.pr-mtask { display: flex; flex-direction: column; gap: 0.2rem; }
.pr-mcard.is-block { gap: 0; padding-top: 0.2rem; padding-bottom: 0.2rem; }
.pr-mcard.is-block .pr-mtask { padding: 0.3rem 0; }
.pr-mcard.is-block .pr-mtask + .pr-mtask { border-top: 1px dashed var(--color-border); }
.pr-mcard.is-block .pr-mcard__t { -webkit-line-clamp: 2; }
.pr-mtask.is-lit .pr-mcard__t { text-decoration: underline; text-decoration-color: var(--color-border-strong); text-underline-offset: 2px; }
.pr-mtask.is-faded { opacity: 0.35; }
.pr-mcard__meta { display: flex; flex-wrap: wrap; gap: 0.15rem 0.55rem; font-size: 10.5px; font-weight: 600; color: var(--color-text-muted); }
.pr-mcard__meta > span { display: inline-flex; align-items: center; gap: 0.2rem; }
.pr-mcard__meta svg { width: 11px; height: 11px; flex: none; }
.pr-mcard__t .pr-mbolt { display: inline-flex; align-items: center; gap: 1px; margin-right: 0.3rem; padding: 0 0.3rem 0 0.15rem; border-radius: 999px; vertical-align: 1px; font-size: 10px; font-weight: 700; line-height: 15px; background: color-mix(in srgb, currentColor 12%, transparent); }
.pr-mcard__t .pr-mbolt svg { width: 10px; height: 10px; }
.pr-mcard__t .pr-mbolt.s-live { color: var(--tone-success-fg); }
.pr-mbolt.s-live { color: var(--am-live); }
.pr-mbolt.s-attn { color: var(--tone-warn-fg); }
.pr-mbolt.s-off { color: var(--color-text-muted); }
.pr-time { color: var(--tone-info-fg); }
.pr-mdec { position: relative; z-index: 4; align-self: center; justify-self: center; width: calc(var(--slot) - 22px); margin: 0.5rem 0; display: grid; grid-template-columns: 20px minmax(0, 1fr); gap: 0.1rem 0.45rem; align-items: start; padding: 0.45rem 0.55rem; border: 1px dashed var(--color-text-secondary); border-radius: 7px; background: var(--color-bg-card); font-size: 10.5px; line-height: 1.4; color: var(--color-text-secondary); }
.pr-mdec i { grid-row: span 3; width: 13px; height: 13px; margin: 3px 0 0 3px; transform: rotate(45deg); border: 1.5px solid var(--color-text); border-radius: 2px; background: var(--color-bg-card); }
.pr-mdec b { font-size: 12px; color: var(--color-text); }
.pr-mdec em { font-style: normal; font-weight: 700; color: var(--color-text); }
.pr-mrail { all: unset; box-sizing: border-box; position: sticky; bottom: 0; z-index: 6; cursor: pointer; display: flex; flex-wrap: nowrap; align-items: center; gap: 0.3rem 0.55rem; margin: 0.45rem 0.55rem; padding: 0.35rem 0.55rem; border-radius: 7px; font-size: var(--fs-2xs); font-weight: 600; color: var(--color-text-secondary); }
button.pr-mrail:hover, .pr-mrail.is-lit { background: var(--color-bg-card); box-shadow: inset 0 0 0 1px var(--color-border-strong); }
button.pr-mrail:focus-visible { box-shadow: var(--focus-ring-strong); }
.pr-mrail__n { display: inline-flex; align-items: center; gap: 0.2rem; color: var(--color-text); font-variant-numeric: tabular-nums; }
.pr-mrail__n svg { width: 11px; height: 11px; color: #13807A; }
.pr-mrail__dots { display: inline-flex; flex-wrap: wrap; gap: 3px; align-items: center; }
.pr-mrail__dots em { font-style: normal; font-size: 10px; color: var(--color-text-muted); margin-left: 2px; }
.pr-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--am-idle); opacity: 0.45; }
.pr-dot.s-live { background: var(--am-live); opacity: 1; }
.pr-dot.s-attn { background: var(--am-warn); opacity: 1; box-shadow: 0 0 0 2px color-mix(in srgb, var(--am-warn) 30%, transparent); }
.pr-mrail.is-lit .pr-dot:not(.is-lit) { opacity: 0.2; }
.pr-mrail.is-lit .pr-dot.is-lit { transform: scale(1.35); }
.pr-mrail__none { color: var(--color-text-muted); font-weight: 500; }
.pr-map .is-dim { opacity: 0.28; }
.pr-mkey { list-style: none; margin: 0; padding: 0.5rem 1rem 0.6rem; display: flex; flex-wrap: wrap; gap: 0.35rem 1.4rem; border-top: 1px solid var(--color-border); font-size: var(--fs-2xs); color: var(--color-text-secondary); }
.pr-mkey li { display: inline-flex; align-items: center; gap: 0.4rem; }
.pr-mkey .pr-dot { margin-left: 0.2rem; }
.pr-mkey .pr-mbolt { display: inline-flex; }
.pr-mkey svg:not(.pr-mkey__line) { width: 12px; height: 12px; }
.pr-mkey__card { width: 18px; height: 12px; border: 1px solid var(--color-border-strong); border-left: 3px solid #2B6CB0; border-radius: 3px; background: var(--color-bg-card); }
.pr-mkey__dec { width: 9px; height: 9px; margin: 0 2px; transform: rotate(45deg); border: 1.5px solid var(--color-text); border-radius: 1.5px; }
.pr-mkey__line { width: 26px; height: 10px; fill: none; stroke: var(--color-text); stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; opacity: 0.75; }
.pr-panel { flex: 0 0 380px; max-width: 46%; max-height: calc(100vh - var(--top-h, 0px) - 8.5rem); overflow: auto; border-left: 1px solid var(--color-border); background: var(--color-bg); box-shadow: -8px 0 16px -12px rgba(0, 0, 0, 0.18); }
.pr-panel__top { position: sticky; top: 0; z-index: 2; display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; padding: 0.55rem 0.8rem 0.45rem; background: var(--color-bg); font-size: var(--fs-2xs); font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; color: var(--color-text-muted); }
.pr-panel__steps { padding: 0 0.6rem 0.6rem; }
.pr-panel__steps .pr-step { grid-template-columns: minmax(0, 1fr); padding-bottom: 0; }
.pr-panel__steps .pr-step::before, .pr-panel__steps .pr-num { display: none; }
#pr-map-print.is-measuring { display: block !important; position: absolute; left: -100000px; top: 0; width: 1100px; }
@media (min-width: 1025px) { .pr-map__scroll, .pr-panel { max-height: calc(100vh - 8.75rem); } }
@media (max-width: 640px) { .pr-map { display: none; } }
@media (min-width: 641px) { .pr-journey { display: none; } }
@media print {
  body.pr-printing-map > *:not(#pr-map-print) { display: none !important; }
  #pr-map-print { display: block; }
  #pr-map-print .pr-mpage { page: pr-map; break-after: page; }
  #pr-map-print .pr-mpage:last-child { break-after: auto; }
  #pr-map-print .pr-mpage__head { margin: 0 0 6px; font: 600 9pt Inter, system-ui, sans-serif; color: #555; }
  #pr-map-print .pr-map__grid { zoom: 0.85; }
  #pr-map-print .pr-mh, #pr-map-print .pr-mlane, #pr-map-print .pr-mcorner, #pr-map-print .pr-mband, #pr-map-print .pr-mrow, #pr-map-print .pr-mrail { position: static; }
  #pr-map-print .pr-mrow.is-rail { box-shadow: none; }
}
@page pr-map { size: landscape; margin: 0.4in; }
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
.pr-review__manual { margin-top: 0.9rem; padding-top: 0.75rem; border-top: 1px dashed var(--color-border); }
.pr-review__manual h4 { margin-top: 0; }
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
@media screen { #pr-print-root, #pr-map-print { display: none; } }
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

// ─── The process map ──────────────────────

const ClockIcon = () => html`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><circle cx="8" cy="8" r="6.2"/><path d="M8 4.6V8l2.3 1.5"/></svg>`;
const BoltIcon = () => html`<svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M9.2 1 3.5 9h3.9L6.6 15l5.9-8.2H8.6z"/></svg>`;
const PeopleIcon = () => html`<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><circle cx="6" cy="5.4" r="2.3"/><path d="M1.9 13.4c.5-2.3 2.1-3.6 4.1-3.6s3.6 1.3 4.1 3.6"/><circle cx="11.3" cy="6.1" r="1.8"/><path d="M10.7 9.8c1.8-.1 3.1.9 3.5 2.9"/></svg>`;
// Each lane's mark: who it is at a glance
const LANE_ICON = {
  family: 'M2.6 7.6 8 3.2l5.4 4.4v5.6a.6.6 0 0 1-.6.6H9.8V10H6.2v3.8H3.2a.6.6 0 0 1-.6-.6z',
  team: 'M6 7.4a2.3 2.3 0 1 0 0-4.6 2.3 2.3 0 0 0 0 4.6zM1.9 13.4c.5-2.3 2.1-3.6 4.1-3.6s3.6 1.3 4.1 3.6M11.3 7.9a1.8 1.8 0 1 0 0-3.6M10.7 9.8c1.8-.1 3.1.9 3.5 2.9',
  designer: 'M2.8 13.2 3.6 10l7-7 2.4 2.4-7 7zM9.4 4.2l2.4 2.4',
  pm: 'M4.3 3.4h7.4v10.2H4.3zM6.3 3.4V2.2h3.4v1.2M6.4 7h3.2M6.4 9.6h3.2',
  auto: 'M9.2 1 3.5 9h3.9L6.6 15l5.9-8.2H8.6z',
  outside: 'M8 13.6S2.6 10.3 2.6 6.2A2.9 2.9 0 0 1 8 4.7a2.9 2.9 0 0 1 5.4 1.5c0 4.1-5.4 7.4-5.4 7.4z',
  staff: 'M6 7.4a2.3 2.3 0 1 0 0-4.6 2.3 2.3 0 0 0 0 4.6zM1.9 13.4c.5-2.3 2.1-3.6 4.1-3.6s3.6 1.3 4.1 3.6M11.3 7.9a1.8 1.8 0 1 0 0-3.6M10.7 9.8c1.8-.1 3.1.9 3.5 2.9',
  president: 'M8 7.6a2.6 2.6 0 1 0 0-5.2 2.6 2.6 0 0 0 0 5.2zM3.2 14c.5-2.8 2.4-4.4 4.8-4.4s4.3 1.6 4.8 4.4',
  chair: 'M8 2.2l1.7 3.5 3.8.5-2.8 2.7.7 3.8L8 10.9l-3.4 1.8.7-3.8-2.8-2.7 3.8-.5z',
};
const LANE_COLOR = { family: '#2B6CB0', team: '#4A5A6A', designer: '#6352C9', pm: '#A0571A', auto: '#13807A', outside: '#8C3D6B', staff: '#4A5A6A', president: '#2B6CB0', chair: '#6352C9' };
const LaneIcon = ({ id }) => html`<svg viewBox="0 0 16 16" fill=${id === 'auto' || id === 'chair' ? 'currentColor' : 'none'} stroke=${id === 'auto' || id === 'chair' ? 'none' : 'currentColor'} stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d=${LANE_ICON[id] || LANE_ICON.team} /></svg>`;

const ZOOMS = [0.5, 0.65, 0.8, 0.9, 1];
const START_ZOOM = 0.9;
const START_ZOOMS = [0.9, 0.85, 0.8];
/** Tasks on one card at most: a longer run by the same lane goes on in the next slot, so no lane grows tall */
const BLOCK_MAX = 2;
// The map's columns: the lanes' labels, then one per place a task can stand
const LABEL_W = 132;
const SLOT_W = 176;
// Slots on each printed page of the map
const PRINT_SLOTS = 6;
/** The map's width at 100% (its box on screen, over its zoom) */
const naturalWidth = (g) => g.getBoundingClientRect().width / (parseFloat(g.style.zoom) || 1);
const naturalHeight = (g) => g.getBoundingClientRect().height / (parseFloat(g.style.zoom) || 1);
const daysSince = (iso) => Math.max(0, Math.floor((Date.now() - Date.parse(iso)) / 86400000));
const initials = (name) => String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();

/**
 * Where each task stands. Back-to-back tasks by the same lane in a step are
 * one block, two at most (a short checklist: the work hasn't changed hands). Time runs left
 * to right: a lane's next block in a step takes the next slot, while a block
 * in another lane can stand in the same slot (the work changed hands). Each
 * step's slots follow the last's.
 * → { cols: [{ c, start, end, dec }], cells: [{ cards, lane, col, c, id, order }], width }
 */
export function layoutMap(columns, decisionLaneOf) {
  let x = 0;
  const cols = [];
  const cells = [];
  for (const c of columns) {
    const start = x;
    let cur = x;
    const used = new Set();
    const blocks = [];
    for (const card of c.cards) {
      const last = blocks.at(-1);
      if (last && last.lane === card.lane && last.cards.length < BLOCK_MAX) last.cards.push(card);
      else blocks.push({ lane: card.lane, cards: [card] });
    }
    for (const b of blocks) {
      while (used.has(`${b.lane}:${cur}`)) cur++;
      used.add(`${b.lane}:${cur}`);
      cells.push({ ...b, col: cur, c, id: b.cards[0].id, order: b.cards[0].order });
    }
    let dec = null;
    if (c.decision) {
      const lane = decisionLaneOf(c);
      let at = cur;
      while (used.has(`${lane}:${at}`)) at++;
      dec = { lane, col: at, ...c.decision };
      cur = Math.max(cur, at);
    }
    cols.push({ c, start, end: cur, dec });
    x = cur + 1;
  }
  return { cols, cells, width: x };
}

/** A path through points with its corners rounded */
function elbowPath(pts, r = 7) {
  let d = `M${pts[0].x},${pts[0].y}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const [p0, p1, p2] = [pts[i - 1], pts[i], pts[i + 1]];
    const d1 = Math.hypot(p1.x - p0.x, p1.y - p0.y);
    const d2 = Math.hypot(p2.x - p1.x, p2.y - p1.y);
    if (!d1 || !d2) continue;
    const rr = Math.min(r, d1 / 2, d2 / 2);
    const a = { x: p1.x + ((p0.x - p1.x) * rr) / d1, y: p1.y + ((p0.y - p1.y) * rr) / d1 };
    const b = { x: p1.x + ((p2.x - p1.x) * rr) / d2, y: p1.y + ((p2.y - p1.y) * rr) / d2 };
    d += ` L${a.x},${a.y} Q${p1.x},${p1.y} ${b.x},${b.y}`;
  }
  const last = pts[pts.length - 1];
  return `${d} L${last.x},${last.y}`;
}

/**
 * The flow through a map grid, task to task in order, in right angles: down
 * or up within a slot (the work changed hands), across to the next slot.
 * A handoff (one person's lane to another's) is drawn darker → [{ d, handoff }]
 */
function flowPaths(g) {
  const z = parseFloat(g.style.zoom) || 1;
  const box = g.getBoundingClientRect();
  const at = (el) => { const r = el.getBoundingClientRect(); return { x: (r.left - box.left) / z, y: (r.top - box.top) / z, w: r.width / z, h: r.height / z }; };
  const cards = [...g.querySelectorAll('[data-order]')].sort((a, b) => a.dataset.order - b.dataset.order);
  const out = [];
  for (let i = 1; i < cards.length; i++) {
    const a = cards[i - 1];
    const b = cards[i];
    const pa = at(a);
    const pb = at(b);
    const handoff = a.dataset.lane !== b.dataset.lane && a.dataset.lane !== 'auto' && b.dataset.lane !== 'auto';
    let pts;
    if (a.dataset.slot === b.dataset.slot) {
      const x = pa.x + pa.w / 2;
      pts = pb.y > pa.y ? [{ x, y: pa.y + pa.h }, { x, y: pb.y - 4 }] : [{ x, y: pa.y }, { x, y: pb.y + pb.h + 4 }];
    } else {
      const y1 = pa.y + Math.min(pa.h / 2, 18);
      const y2 = pb.y + Math.min(pb.h / 2, 18);
      const x1 = pa.x + pa.w;
      const x2 = pb.x - 4;
      const mx = x1 + Math.max(8, (x2 - x1) / 2);
      pts = Math.abs(y1 - y2) < 1 ? [{ x: x1, y: y1 }, { x: x2, y: y2 }] : [{ x: x1, y: y1 }, { x: mx, y: y1 }, { x: mx, y: y2 }, { x: x2, y: y2 }];
    }
    out.push({ d: elbowPath(pts), handoff });
  }
  return out;
}

/**
 * The grid itself, for the screen and for paper: a band per part, a header
 * per step (who's there, how long it takes), a row per lane, the tasks in
 * their slots, decisions, and a row of each step's automations at the foot.
 */
function MapGrid({ m, lay, steps, byTitle, placed, cycleOn, show, stepWarn, interactive = true, onOpen, onHover, lit, openKey, focusCol, gridRef, zoom = 1, paths = [], bandOf }) {
  const node = (t) => byTitle.get(t);
  const stepOf = (c) => steps.find((x) => `${x.part}-${x.n}` === c.key);
  const laneRow = Object.fromEntries(m.lanes.map((l, i) => [l.id, i + 3]));
  const railRow = m.lanes.length + 3;
  const span = (a, b) => `${a + 2} / ${b + 3}`;
  const parts = [];
  for (const k of lay.cols) {
    const label = bandOf(k.c.part);
    if (parts.at(-1)?.label === label) parts.at(-1).end = k.end; else parts.push({ label, part: k.c.part, start: k.start, end: k.end });
  }
  const dimStep = (st) => st && show === 'attn' && !stepWarn(st);
  const statusOf = (titles) => {
    const ns = titles.map(node).filter(Boolean);
    return ns.some((n) => n.es === 'attn') ? 'attn' : ns.some((n) => n.es === 'live') ? 'live' : ns.length ? 'off' : null;
  };
  const Tag = interactive ? 'button' : 'div';
  return html`<div class="pr-map__grid" ref=${gridRef} style=${`--slots: ${lay.width}; --slot: ${SLOT_W}px; --label: ${LABEL_W}px; zoom: ${zoom}`}>
    <div class="pr-mcorner" style="grid-column: 1; grid-row: 1 / span 2;"></div>
    ${parts.map((p) => html`<div class=${`pr-mband is-${p.part}`} key=${`b-${p.label}`} style=${`grid-column: ${span(p.start, p.end)}; grid-row: 1;`}><span>${p.label}</span></div>`)}
    ${lay.cols.map((k) => {
      const c = k.c;
      const st = stepOf(c);
      const here = placed.get(c.key) || [];
      const people = here.flatMap((h) => h.names.map((x) => ({ ...x, status: h.status })));
      const extra = here.reduce((n, h) => n + h.n, 0) - people.length;
      const live = c.autos.some((t) => node(t)?.es === 'live');
      const cyc = cycleOn(c);
      return html`<div key=${`h-${c.key}`} data-step=${c.key} class=${`pr-mh${live ? ' is-auto' : ''}${st && stepWarn(st) ? ' is-attn' : ''}${dimStep(st) ? ' is-dim' : ''}${focusCol === c.key ? ' is-focus' : ''}${openKey === c.key ? ' is-open' : ''}`} style=${`grid-column: ${span(k.start, k.end)}; grid-row: 2;`}>
        ${interactive
          ? html`<button type="button" class="pr-mh__t" onClick=${() => onOpen(c.key)} title="Open this step"><b>${c.n}</b><span>${c.t}</span></button>`
          : html`<div class="pr-mh__t"><b>${c.n}</b><span>${c.t}</span></div>`}
        ${(people.length + extra > 0 || cyc) && html`<div class="pr-mh__row">
          ${people.length + extra > 0 && html`<span class="pr-avs" title=${people.map((x) => `${x.name}${x.since ? `, ${daysSince(x.since)} days` : ''}`).join('; ')}>
            ${people.slice(0, 4).map((x, i) => html`<a key=${i} class="pr-av" href=${x.href} target=${/^https?:/.test(x.href) ? '_blank' : null} rel="noopener">${x.photo ? html`<img src=${x.photo} alt="" loading="lazy" />` : html`<span aria-hidden="true">${initials(x.name)}</span>`}<span class="sr-only">${x.name}${x.since ? `, ${daysSince(x.since)} days here` : ''}</span></a>`)}
            ${people.length + extra > 4 && html`<span class="pr-av is-more">+${people.length + extra - 4}</span>`}
            <span class="pr-avs__n">${people.length + extra === 1 ? (people[0]?.name || '1 here') : `${people.length + extra} here`}</span>
          </span>`}
          ${cyc && html`<span class="pr-mh__cycle" title=${cyc.title}><${ClockIcon} />${cyc.text}<span class="sr-only"> (${cyc.title.toLowerCase()})</span></span>`}
        </div>`}
      </div>`;
    })}
    ${m.lanes.map((l, i) => html`<div key=${`r-${l.id}`} class=${`pr-mrow${i % 2 ? ' is-alt' : ''}`} style=${`grid-column: 1 / -1; grid-row: ${laneRow[l.id]};`}></div>`)}
    <div class="pr-mrow is-rail" style=${`grid-column: 1 / -1; grid-row: ${railRow};`}></div>
    ${lay.cols.map((k) => html`<div key=${`s-${k.c.key}`} class="pr-msep" style=${`grid-column: ${k.start + 2}; grid-row: 2 / ${railRow + 1};`}></div>`)}
    ${lay.cols.filter((k) => openKey && k.c.key === openKey).map((k) => html`<div key="open" class="pr-mopen" style=${`grid-column: ${span(k.start, k.end)}; grid-row: 3 / ${railRow};`}></div>`)}
    ${m.lanes.map((l) => html`<div key=${`l-${l.id}`} class=${`pr-mlane is-${l.id}`} style=${`grid-column: 1; grid-row: ${laneRow[l.id]}; --lc: ${LANE_COLOR[l.id] || '#4A5A6A'};`}><span><${LaneIcon} id=${l.id} />${l.label}</span></div>`)}
    <div class="pr-mlane is-rail" style=${`grid-column: 1; grid-row: ${railRow};`}><span><${BoltIcon} />Automations</span></div>
    ${lay.cells.map((cell) => {
      const { col, c, lane } = cell;
      const st = stepOf(c);
      const all = [...new Set(cell.cards.flatMap((x) => x.autos))];
      const s = statusOf(all);
      const dim = (show === 'hand' && s === 'live' && cell.cards.every((x) => x.autos.length)) || dimStep(st);
      const isLit = lit?.cards && cell.cards.some((x) => lit.cards.has(x.id));
      const row = (x) => {
        const sx = statusOf(x.autos);
        const withWho = x.with.map((w) => WITH_LABEL[w] || w);
        return html`<span class=${`pr-mtask${sx ? ` s-${sx}` : ''}${show === 'hand' && sx === 'live' ? ' is-faded' : ''}${lit?.cards?.has(x.id) ? ' is-lit' : ''}`} key=${x.id} title=${x.t}
          onMouseEnter=${interactive ? () => onHover({ step: c.key, titles: x.autos, cards: new Set([x.id]) }) : null}>
          <span class="pr-mcard__t">${x.autos.length ? html`<span class=${`pr-mbolt s-${sx}`} title=${plural(x.autos.length, 'automation')} aria-hidden="true"><${BoltIcon} />${x.autos.length}</span>` : null}<span class="pr-mcard__x">${x.t}</span></span>
          ${(withWho.length || x.time || x.details) ? html`<span class="pr-mcard__meta">
            ${x.time ? html`<span class="pr-time"><${ClockIcon} />${x.time}</span>` : null}
            ${withWho.length ? html`<span class="pr-with"><${PeopleIcon} />${withWho.join(', ')}</span>` : null}
            ${x.details ? html`<span>+${x.details}</span>` : null}
          </span>` : null}
        </span>`;
      };
      return html`<${Tag} type=${interactive ? 'button' : null} key=${cell.id} data-order=${cell.order} data-lane=${lane} data-slot=${col} data-step=${c.key}
        class=${`pr-mcard${s ? ` has-auto s-${s}` : ''}${cell.cards.length > 1 ? ' is-block' : ''}${cell.cards.some((x) => x.self) ? ' is-self' : ''}${isLit ? ' is-lit' : ''}${dim ? ' is-dim' : ''}`}
        style=${`grid-column: ${col + 2}; grid-row: ${laneRow[lane]}; --lc: ${LANE_COLOR[lane] || '#4A5A6A'};`}
        onMouseEnter=${interactive && cell.cards.length === 1 ? () => onHover({ step: c.key, titles: all, cards: new Set([cell.id]) }) : null} onMouseLeave=${interactive ? () => onHover(null) : null}
        onFocus=${interactive ? () => onHover({ step: c.key, titles: all, cards: new Set(cell.cards.map((x) => x.id)) }) : null} onBlur=${interactive ? () => onHover(null) : null}
        onClick=${interactive ? () => onOpen(c.key) : null}>
        <span class="sr-only">Step ${c.n}, ${c.t}: </span>
        ${cell.cards.map(row)}
        <span class="sr-only">${all.length ? ` ${plural(all.length, 'automation')}.` : ' By hand.'}</span>
      </${Tag}>`;
    })}
    ${lay.cols.filter((k) => k.dec).map((k) => html`<div key=${`d-${k.c.key}`} class="pr-mdec" style=${`grid-column: ${k.dec.col + 2}; grid-row: ${laneRow[k.dec.lane]};`}>
      <i aria-hidden="true"></i><b>${k.dec.q}</b>
      <span><em>Yes</em> ${k.dec.yes}</span><span><em>No</em> ${k.dec.no}</span>
    </div>`)}
    ${lay.cols.map((k) => {
      const c = k.c;
      const st = stepOf(c);
      const ns = c.autos.map(node).filter(Boolean);
      const warn = ns.filter((n) => n.es === 'attn').length;
      const isLit = lit && lit.step === c.key;
      const fits = (k.end - k.start + 1) * 16 - 9;
      const shown = ns.length > fits ? fits - 1 : ns.length;
      const inner = html`${interactive ? html`<span class="sr-only">Step ${c.n}, ${c.t}: </span>` : null}${ns.length ? html`<span class="pr-mrail__n"><${BoltIcon} />${ns.length}<span class="sr-only"> ${ns.length === 1 ? 'automation' : 'automations'}${warn ? ',' : ''}</span></span>
          <span class="pr-mrail__dots">${ns.slice(0, shown).map((n) => html`<i key=${n.t} class=${`pr-dot s-${n.es}${isLit && lit.titles.includes(n.t) ? ' is-lit' : ''}`} title=${`${n.t}: ${STATUS[n.es]}`}></i>`)}${ns.length > shown ? html`<em>+${ns.length - shown}</em>` : null}</span>
          ${warn ? html`<span class="sr-only">${warn} need${warn === 1 ? 's' : ''} attention</span>` : null}`
        : html`<span class="pr-mrail__none">By hand</span>`}`;
      return interactive
        ? html`<button type="button" key=${`a-${c.key}`} class=${`pr-mrail${isLit ? ' is-lit' : ''}${(st && show === 'hand' && ns.length) || dimStep(st) ? ' is-dim' : ''}`} style=${`grid-column: ${span(k.start, k.end)}; grid-row: ${railRow};`} onClick=${() => onOpen(c.key)} title="Open the step">${inner}</button>`
        : html`<div key=${`a-${c.key}`} class="pr-mrail" style=${`grid-column: ${span(k.start, k.end)}; grid-row: ${railRow};`}>${inner}</div>`;
    })}
    <svg class="pr-map__flow" aria-hidden="true">
      <defs><marker id=${interactive ? 'pr-arrow' : 'pr-arrow-p'} viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="6.5" markerHeight="6.5" orient="auto-start-reverse"><path d="M0,1.2 L8.5,5 L0,8.8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" /></marker></defs>
      ${paths.map((p, i) => html`<path key=${i} d=${p.d} class=${p.handoff ? 'is-handoff' : ''} marker-end=${`url(#${interactive ? 'pr-arrow' : 'pr-arrow-p'})`} />`)}
    </svg>
  </div>`;
}

/**
 * track, steps (pinned), byTitle (the map's entries, live statuses on them),
 * placed (who's where), cycles (how long the application steps take), show
 * (the filter), stepWarn, openKey / onOpen (the step open beside the map),
 * renderStep(key): that step in full, for the panel
 */
function ProcessMap({ track, steps, byTitle, placed, cycles, show, stepWarn, openKey, onOpen, renderStep }) {
  const m = useMemo(() => mapOf(track, steps), [track, steps]);
  const money = MONEY_TRACKS.includes(track);
  const decisionLaneOf = (c) => (money ? (c.cards.find((x) => x.lane !== 'auto' && x.lane !== 'outside')?.lane || 'staff') : 'team');
  const lay = useMemo(() => layoutMap(m.columns, decisionLaneOf), [m]);
  const [zoom, setZoomRaw] = useState(START_ZOOM); // null: fit the whole map
  const zoomed = useRef(false); // once someone zooms, the map keeps their size
  const setZoom = (z) => { zoomed.current = true; setZoomRaw(z); };
  const [fitK, setFitK] = useState(1);
  const [lit, setLit] = useState(null);
  const [paths, setPaths] = useState([]);
  const [inView, setInView] = useState(() => new Set());
  const [focusCol, setFocusCol] = useState(null);
  const scrollRef = useRef(null);
  const gridRef = useRef(null);
  const k = zoom ?? fitK;
  const node = (t) => byTitle.get(t);
  const bandOf = (part) => (part === 'applying' ? 'Applying' : money ? TRACK_LABEL[track] : track === 'makeover' ? 'The makeover' : 'The project');
  const cy = cycles?.[track] || null;
  const decided = m.columns.find((c) => c.decision && c.part === 'doc');
  const cycleOn = (c) => {
    if (money || !cy) return null;
    const of = (x, what) => ({ text: `${x.days} days ${what}`, title: `Median ${what}, of ${x.n} applicants’ history` });
    if (c.part === 'applying' && c.n === 2 && cy.toReview) return of(cy.toReview, 'to an onsite');
    if (track === 'community' && /online application/i.test(c.t) && cy.toReview) return of(cy.toReview, 'to an onsite');
    if (decided && c.key === decided.key && cy.toDecision) return of(cy.toDecision, 'to a decision');
    return null;
  };
  const handLines = m.columns.flatMap((c) => c.cards).filter((c) => c.lane !== 'auto' && !c.autos.length).length;

  // Fit the whole map to the card's width (never past 100%); until someone
  // zooms, open at the largest readable size that shows every lane at once
  useEffect(() => {
    const fit = () => {
      const sc = scrollRef.current;
      const g = gridRef.current;
      if (!sc || !g) return;
      setFitK(Math.max(0.18, Math.min(1, (sc.clientWidth - 2) / naturalWidth(g))));
      const room = parseFloat(getComputedStyle(sc).maxHeight);
      if (!zoomed.current && room > 0) setZoomRaw(START_ZOOMS.find((z) => naturalHeight(g) * z <= room) ?? START_ZOOMS.at(-1));
    };
    fit();
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [lay]);

  // The flow, drawn once the cards have their places (and again when anything moves)
  useEffect(() => {
    const g = gridRef.current;
    if (!g) return undefined;
    const draw = () => setPaths(flowPaths(g));
    const id = requestAnimationFrame(draw);
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => requestAnimationFrame(draw)) : null;
    ro?.observe(g);
    return () => { cancelAnimationFrame(id); ro?.disconnect(); };
  }, [lay, k, show]);

  // Which steps are on screen, for the navigator
  useEffect(() => {
    const sc = scrollRef.current;
    if (!sc) return undefined;
    const track_ = () => {
      const r = sc.getBoundingClientRect();
      const seen = new Set();
      sc.querySelectorAll('.pr-mh[data-step]').forEach((h) => { const b = h.getBoundingClientRect(); if (b.right > r.left + LABEL_W * k + 8 && b.left < r.right - 8) seen.add(h.dataset.step); });
      setInView(seen);
    };
    track_();
    sc.addEventListener('scroll', track_, { passive: true });
    window.addEventListener('resize', track_);
    return () => { sc.removeEventListener('scroll', track_); window.removeEventListener('resize', track_); };
  }, [lay, k]);

  // Escape closes the step panel
  useEffect(() => {
    if (!openKey) return undefined;
    const onKey = (e) => { if (e.key === 'Escape' && !e.defaultPrevented && !document.querySelector('.modal-overlay, .pr-detail')) onOpen(null); };
    document.addEventListener('keydown', onKey);
    // The panel narrows the map: keep the open step in sight beside it
    const id = requestAnimationFrame(() => {
      const sc = scrollRef.current;
      const h = sc?.querySelector(`.pr-mh[data-step="${openKey}"]`);
      if (!h) return;
      const r = sc.getBoundingClientRect();
      const b = h.getBoundingClientRect();
      if (b.left < r.left + LABEL_W * k || b.right > r.right) sc.scrollTo({ left: sc.scrollLeft + (b.left - r.left) - LABEL_W * k - 12 });
    });
    return () => { document.removeEventListener('keydown', onKey); cancelAnimationFrame(id); };
  }, [openKey]);

  const goCol = (key) => {
    const sc = scrollRef.current;
    const h = sc?.querySelector(`.pr-mh[data-step="${key}"]`);
    if (!h) return;
    const r = sc.getBoundingClientRect();
    const b = h.getBoundingClientRect();
    sc.scrollTo({ left: sc.scrollLeft + (b.left - r.left) - LABEL_W * k - 12, behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    setFocusCol(key);
    setTimeout(() => setFocusCol((c) => (c === key ? null : c)), 1600);
  };

  // On paper: landscape pages of a few slots each, the lanes and the flow on each
  const printMap = () => {
    let root = document.getElementById('pr-map-print');
    if (!root) { root = document.createElement('div'); root.id = 'pr-map-print'; document.body.appendChild(root); }
    render(null, root);
    root.classList.add('is-measuring');
    const pages = [];
    let cur = [];
    let w = 0;
    for (const k2 of lay.cols) {
      const cw = k2.end - k2.start + 1;
      if (cur.length && w + cw > PRINT_SLOTS) { pages.push(cur); cur = []; w = 0; }
      cur.push(k2.c);
      w += cw;
    }
    if (cur.length) pages.push(cur);
    render(html`${pages.map((cols, pi) => {
      const sub = { ...m, columns: cols };
      const subLay = layoutMap(cols, decisionLaneOf);
      return html`<section class="pr-mpage" key=${pi}>
        <p class="pr-mpage__head">${TRACK_LABEL[track]}: the process map, steps ${m.columns.indexOf(cols[0]) + 1} to ${m.columns.indexOf(cols.at(-1)) + 1} of ${m.columns.length}${pi ? '' : ` · printed ${longDate()}`}</p>
        <${MapGrid} m=${sub} lay=${subLay} steps=${steps} byTitle=${byTitle} placed=${placed} cycleOn=${cycleOn} show="all" stepWarn=${stepWarn} interactive=${false} bandOf=${bandOf} />
      </section>`;
    })}`, root);
    root.querySelectorAll('.pr-map__grid').forEach((g) => {
      const svg = g.querySelector('.pr-map__flow');
      const defs = svg.querySelector('defs')?.outerHTML || '';
      svg.innerHTML = defs + flowPaths(g).map((p) => `<path d="${p.d}"${p.handoff ? ' class="is-handoff"' : ''} marker-end="url(#pr-arrow-p)"/>`).join('');
    });
    root.classList.remove('is-measuring');
    document.body.classList.add('pr-printing-map');
    const done = () => { document.body.classList.remove('pr-printing-map'); render(null, root); window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    window.print();
  };

  const open = openKey ? steps.find((x) => `${x.part}-${x.n}` === openKey) : null;
  return html`<section class=${`card pr-map${open ? ' has-panel' : ''}`} aria-label="Process map">
    <div class="pr-map__bar">
      <h3>Process map</h3>
      <div class="pr-map__facts">
        <span><b>${m.columns.length}</b> steps</span>
        <span><b>${m.handoffs}</b> handoffs between people</span>
        <span><b>${handLines}</b> tasks by hand</span>
      </div>
      <div class="pr-map__acts" role="group" aria-label="Zoom">
        <button type="button" aria-pressed=${String(zoom === null)} title="The whole process at once" onClick=${() => { setZoom(null); scrollRef.current?.scrollTo({ left: 0 }); }}>Fit</button>
        <button type="button" aria-label="Zoom out" onClick=${() => setZoom(ZOOMS.filter((z) => z < k - 0.01).pop() ?? ZOOMS[0])}>−</button>
        <button type="button" aria-label="Zoom in" onClick=${() => setZoom(ZOOMS.find((z) => z > k + 0.01) ?? 1)}>+</button>
        <button type="button" onClick=${printMap}>Print map</button>
      </div>
      <div class="pr-mnav" role="navigation" aria-label="Go to a step on the map">
        ${[...new Set(m.columns.map((c) => bandOf(c.part)))].map((label) => html`<i key=${`nl-${label}`}>${label}</i><ol key=${`no-${label}`}>
          ${m.columns.filter((c) => bandOf(c.part) === label).map((c) => {
            const st = steps.find((x) => `${x.part}-${x.n}` === c.key);
            const n = (placed.get(c.key) || []).reduce((t, h) => t + h.n, 0);
            return html`<li key=${c.key} class=${inView.has(c.key) ? 'in-view' : ''}>
              <button type="button" class=${`${c.autos.some((t) => node(t)?.es === 'live') ? 'is-auto' : ''}${st && stepWarn(st) ? ' is-attn' : ''}`} title=${`${c.n}. ${c.t}${n ? `: ${n} here now` : ''}`} onClick=${() => goCol(c.key)}>${c.n}<span class="sr-only">. ${c.t}${n ? `, ${n} here now` : ''}</span></button>
            </li>`;
          })}
        </ol>`)}
      </div>
    </div>
    <div class="pr-map__body">
      <div class="pr-map__scroll" ref=${scrollRef}>
        <${MapGrid} m=${m} lay=${lay} steps=${steps} byTitle=${byTitle} placed=${placed} cycleOn=${cycleOn} show=${show} stepWarn=${stepWarn}
          onOpen=${onOpen} onHover=${setLit} lit=${lit} openKey=${openKey} focusCol=${focusCol} gridRef=${gridRef} zoom=${k} paths=${paths} bandOf=${bandOf} />
      </div>
      ${open && html`<aside class="pr-panel" aria-label=${`Step ${open.n}: ${open.t}`}>
        <div class="pr-panel__top">
          <span>${bandOf(open.part)} · step ${open.n} of ${m.columns.filter((c) => c.part === open.part).length}</span>
          <button type="button" class="am-close" aria-label="Close the step" onClick=${() => onOpen(null)}>×</button>
        </div>
        <ol class="pr-steps pr-panel__steps">${renderStep(openKey)}</ol>
      </aside>`}
    </div>
    <ul class="pr-mkey" aria-label="How to read the map">
      <li><span class="pr-mkey__card"></span>A task, in the lane of who does it</li>
      <li><span class="pr-mbolt s-live"><${BoltIcon} /></span>Automations on it</li>
      <li><i class="pr-mkey__dec"></i>A decision</li>
      <li><svg class="pr-mkey__line" viewBox="0 0 26 10" aria-hidden="true"><path d="M1 5 H22 M18 1.5 L22.5 5 L18 8.5" /></svg>The work changes hands</li>
      <li><i class="pr-dot s-live"></i>${STATUS.live} <i class="pr-dot s-attn"></i>${STATUS.attn} <i class="pr-dot s-off"></i>${STATUS.off}</li>
    </ul>
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
  const [panel, setPanel] = useState(null); // the step open beside the map
  const [open, setOpen] = useState(null); // `${step}::${title}` shown in full
  const [linkForm, setLinkForm] = useState(null); // { value, saving, error }
  const [more, setMore] = useState(() => new Set()); // chip rows shown in full
  const mounted = useRef(true);
  useEffect(() => () => { mounted.current = false; }, []);

  const byTitle = useMemo(() => byName(model.ALL), [model]);

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
    setPanel(null);
    if (location.hash !== hashOfTrack(t)) history.replaceState(history.state, '', hashOfTrack(t));
  };

  const docKey = docOf(track);
  const money = MONEY_TRACKS.includes(track);
  const doc = data?.docs?.[docKey] || null;
  const sections = data?.docs?.policy?.sections || [];
  // Each track's own Doc (a money track without its Doc yet: its built-in steps)
  const steps = useMemo(() => pinSteps(track, doc?.steps || []), [track, doc]);
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
    // On a laptop the step opens beside the map; on a phone the list scrolls to it
    const onMap = matchMedia('(min-width: 641px)').matches && !!document.querySelector('.pr-map');
    if (onMap) setPanel(key);
    const scrollTo = () => requestAnimationFrame(() => (onMap ? document.querySelector('.pr-map') : document.getElementById(`pr-${key}`))?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }));
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
  const stepEl = (s, where = 'list') => {
    const key = `${s.part}-${s.n}`;
    const all = stepAutos(s);
    const warn = all.some((n) => n.es === 'attn') || offPolicy(s);
    const running = all.filter((n) => n.es === 'live').length;
    const chk = s.check ? data?.checks?.[s.check] : null;
    return html`<li key=${key} id=${where === 'list' ? `pr-${key}` : null} class=${`pr-step${running ? ' is-auto' : ''}${warn ? ' is-attn' : ''}`}>
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
  const docLabel = doc?.doc?.name ? `“${doc.doc.name}”` : `the ${TRACK_LABEL[docKey]?.toLowerCase() || 'process'} process Doc`;
  const manual = data?.docs?.policy?.doc || null;

  const sourceLine = doc?.doc && html`<p class="pr-src">
    <span>From ${docLabel} in Google Drive${doc.doc.modifiedTime ? `, changed ${shortDate(doc.doc.modifiedTime)}${doc.doc.modifiedBy ? ` by ${doc.doc.modifiedBy}` : ''}` : ''}.</span>
    <a href=${doc.doc.url} target="_blank" rel="noopener">Open the Doc</a>
    ${money && manual && html`<span>The rules: “${manual.name}”.</span><a href=${manual.url} target="_blank" rel="noopener">Open the manual</a>`}
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
  // For money, the board's manual has its own yearly review beside the track's Doc
  const manualRv = money && manual ? reviewOf(manual, { reviewedAt: data?.reviews?.policy?.at }) : null;
  const markManual = async () => {
    setReviewing({ busy: true, error: null });
    try {
      const res = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ review: 'policy' }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.success) throw new Error(body.error || `Couldn’t save (${res.status})`);
      setData(body);
      setReviewing({ busy: false, error: null });
    } catch (e) {
      setReviewing({ busy: false, error: e.message });
    }
  };
  const manualEl = () => {
    if (!manualRv) return null;
    const when = manualRv.state === 'due' ? `Overdue since ${shortDate(manualRv.dueAt)}.` : manualRv.state === 'soon' ? `Due ${shortDate(manualRv.dueAt)}, in ${plural(days(manualRv.dueAt), 'day')}.` : `Next due ${shortDate(manualRv.dueAt)}.`;
    const items = [
      ...retiredMentions(sections).map((m) => html`<li class="is-warn">It names ${m.word} (${m.sections.join(', ')}); ${m.now}.</li>`),
      steps.some(offPolicy) && html`<li class="is-warn">Bill approvals differ from it (Approving a bill).</li>`,
    ].filter(Boolean);
    return html`<div class="pr-review__manual">
      <h4>The board’s policy manual</h4>
      <p class="pr-review__when"><span class=${`dot ${manualRv.state === 'due' ? 'dot--warn' : manualRv.state === 'soon' ? 'dot--info' : 'dot--on'}`} aria-hidden="true"></span><span>${when}</span></p>
      ${items.length > 0 && html`<ul class="pr-agenda">${items}</ul>`}
      <div class="pr-review__acts">
        ${manualRv.state !== 'ok' && html`<button type="button" class="btn btn-ghost btn-sm" disabled=${reviewing.busy} onClick=${markManual}>Manual reviewed, no changes</button>`}
        <a href=${manual.url} target="_blank" rel="noopener">Open the manual</a>
      </div>
    </div>`;
  };
  const reviewEl = () => {
    if (!rv) return manualRv ? html`<section class="card pr-review" id="pr-review" aria-label="Yearly review"><h3>Yearly review</h3>${manualEl()}</section>` : null;
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
        <a href=${doc.doc.url} target="_blank" rel="noopener">Open the Doc</a>
      </div>
      ${manualEl()}
      ${reviewing.error && html`<p class="pr-review__err" role="alert">${reviewing.error}</p>`}
    </section>`;
  };

  const header = html`<div class="page-header" style="margin-bottom: 0.4rem;">
    <div>
      <h2>Automations</h2>
      <p class="page-sub">How SOARD works, step by step, and what runs on its own at each step.</p>
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
      ${[rv, manualRv].filter((x) => x && x.state !== 'ok').slice(0, 1).map((x) => html`<li class=${x.state === 'due' ? 'pr-due' : ''}><button type="button" onClick=${goToReview}>${x.state === 'due' ? html`<span>Yearly review due</span>` : html`<span>Yearly review in ${plural(days(x.dueAt), 'day')}</span>`}</button></li>`)}
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

    ${steps.length > 0 && html`<${ProcessMap} track=${track} steps=${steps} byTitle=${byTitle} placed=${placed} cycles=${data?.cycles || null}
      show=${show} stepWarn=${stepWarn} openKey=${panel} onOpen=${(key) => { setOpen(null); setPanel(key); }}
      renderStep=${(key) => { const st = steps.find((x) => `${x.part}-${x.n}` === key); return st ? stepEl(st, 'panel') : null; }} />`}
    <div class="pr-work">
      <div>
        ${steps.length > 0 && journeyEl()}
        ${show !== 'all' && !steps.some(stepShown) && html`<div class="card pr-empty"><p class="am-empty">${show === 'attn' ? 'Nothing in this process needs attention.' : 'Every task here runs on its own.'}</p></div>`}
        ${money ? html`
          <div class="pr-part"><h3>${TRACK_LABEL[track]}</h3><span>${doc?.steps?.length ? `As ${docLabel} has it; each step shows the board policy that governs it` : doc?.missing ? `How it runs today. Process follows “${doc.missing}” once it’s in Drive; each step shows the board policy that governs it` : 'How it runs today, until its process Doc can be read; each step shows the board policy that governs it'}</span></div>
          <ol class="pr-steps">${steps.filter(stepShown).map((x) => stepEl(x))}</ol>` : html`
          ${applying.some(stepShown) && html`
            <div class="pr-part"><h3>Applying</h3><span>On the website, in the steps of the ${APPLYING_SOURCE} handout</span></div>
            <ol class="pr-steps">${applying.filter(stepShown).map((x) => stepEl(x))}</ol>`}
          ${(show === 'all' || fromDoc.some(stepShown)) && html`<div class="pr-part"><h3>${track === 'makeover' ? 'The makeover' : 'The project'}</h3><span>${doc?.doc ? `As ${docLabel} has it` : 'From the process Doc'}</span></div>`}
          ${fromDoc.length ? html`<ol class="pr-steps">${fromDoc.filter(stepShown).map((x) => stepEl(x))}</ol>`
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
