/**
 * reveal-design.js — a kid's design, shown while everyone waits for their reveal
 * ==========================================================================
 * Peter, Nov 9 2026: show the design on the reveal's starting-soon screen
 * "about 1 hour before the reveal": "the asbuilt drawing, proposed drawing,
 * about 4-6 before photos and any design boards", and "it should remain on
 * the page during the reveal too". The family is at the house for the reveal,
 * not on the site, so it goes to everyone watching.
 *
 * What it is: the kid's own profile in Admin → Kids, nothing kept anywhere else.
 *   - Before photos: the "before" half of each Before & after pair. A pair can
 *     wait for its "after" until the room is done; the kid page only ever
 *     shows whole pairs.
 *   - Drawings: Design plans, each an as-built drawing, a proposed drawing or
 *     a design board (plans[i].type).
 *
 * When: from DESIGN_LEAD_MS before the reveal (JobTread's confirmed time, or
 * the broadcast's own), through the reveal and after it. Until then none of
 * it is public: the kid page leaves out its Design and Transformation
 * chapters until the room is revealed, and /api/reveal-design says only when
 * it opens.
 *
 * Shared by functions/api/reveal-design.js (who sees it, when), the kid
 * editor (Admin → Kids) and its JobTread import, and tests. The kid page,
 * How It Works and kid-preview.js keep the same hold (isRevealed, whole
 * pairs) in their own words.
 */

/** The design opens this long before the reveal starts */
export const DESIGN_LEAD_MS = 60 * 60 * 1000;
/** Before photos on the starting-soon screen (Peter: "about 4-6") */
export const BEFORE_SHOWN = 6;
export const BEFORE_SUGGESTED = 6;

/**
 * badge: what a picture is, in one word, on the picture itself wherever it's shown (the starting-soon screen, the live
 * page's design, the strip beside the video, the viewer). Peter, Nov 11 2026: the plans have to say whether they're
 * existing or proposed, and a before photo has to say so strongly enough that nobody takes the old room for our work.
 */
export const BEFORE_BADGE = 'Before';
export const PLAN_KINDS = [
  { id: 'as-built', label: 'As-built', long: 'As-built drawing', badge: 'Existing', kicker: 'The plan', caption: 'The floor plan today', captionAfter: 'The floor plan before' },
  { id: 'proposed', label: 'Proposed', long: 'Proposed drawing', badge: 'Proposed', kicker: 'The plan', caption: 'The new floor plan' },
  { id: 'board', label: 'Design board', long: 'Design board', badge: '', kicker: 'The look', caption: 'The design' },
];
const KIND = Object.fromEntries(PLAN_KINDS.map((k) => [k.id, k]));

/** A plan's kind: the three above, with anything older read as as-built (how plans were stored before boards had their own) */
export const planKind = (p) => (p?.type === 'board' ? 'board' : p?.type === 'proposed' ? 'proposed' : 'as-built');
export const normalizePlanType = (t) => (t === 'board' || t === 'proposed' ? t : 'as-built');

/** A Before & after pair the kid page can show: both halves */
export const isCompletePair = (p) => !!(p && p.before && p.after);
export const completePairs = (pairs) => (pairs || []).filter(isCompletePair);

/** The room has been revealed: its design belongs on the kid page from now on */
export const isRevealed = (kid) => kid?.status === 'completed';

// ── The family's address ─────────────────────────────────────────────
// A drawing sheet's title block carries the street address along the bottom.
// A sheet that went up without it is named -notitle. Any other floor plan
// (by its caption, or because it's an as-built or proposed drawing) is shown
// with the bottom TITLE_BLOCK cropped off, wherever it's shown. Boards are
// shown whole.
export const TITLE_BLOCK = 0.10;
const FLOOR_PLAN_WORDS = /(before|after|existing|existi|proposed|layout|floor\s*plan)/i;
export const isTrimmed = (url) => /-notitle\./i.test(String(url || ''));
export const needsTitleCrop = (p) => !isTrimmed(p?.url) && (FLOOR_PLAN_WORDS.test(p?.label || '') || planKind(p) !== 'board');

/**
 * Someone has made sure the address isn't on it: its words were found and
 * painted out ('wiped'), staff covered it by hand ('covered'), or staff
 * looked and ticked that it has none ('checked'). The reveal screen and live
 * page show an as-built or proposed drawing only once one of those is true;
 * a design board (marked as one) is shown whole without it. Plans from before
 * the check (and before boards had their own kind) never go out here; they're
 * on the revealed kid's page, as they always were.
 */
export const ADDRESS_CHECKS = ['wiped', 'covered', 'checked'];
export const addressChecked = (p) => planKind(p) === 'board' || ADDRESS_CHECKS.includes(p?.addressCheck);

const usable = (u) => typeof u === 'string' && !!u.trim() && !/^(blob|data):/.test(u);
const possessive = (name) => (/s$/i.test(name || '') ? `${name}’` : `${name}’s`);

/**
 * What the reveal shows, in the order the story goes: the room today, its
 * floor plan, the new plan, then the look. Each slide:
 * { kind: 'before'|'as-built'|'proposed'|'board', url, alt, badge, kicker, caption, crop, w?, h? }
 * badge ('Before', 'Existing', 'Proposed'; '' for a board) goes on the picture; kicker and caption say the rest.
 * after: the reveal has started, so the room isn't "today" any more ("Dylan’s room before").
 */
export function revealSlides(kid, { after = false } = {}) {
  const name = String(kid?.name || '').trim();
  const room = name ? `${possessive(name)} room ${after ? 'before' : 'today'}` : `The room ${after ? 'before' : 'today'}`;
  const befores = (kid?.beforeAfterPhotos || [])
    .filter((p) => usable(p?.before))
    .slice(0, BEFORE_SHOWN)
    .map((p) => ({
      kind: 'before', url: p.before, crop: false,
      alt: String(p.beforeAlt || '').trim() || `${name ? possessive(name) : 'The'} room before the makeover`,
      badge: BEFORE_BADGE, kicker: 'Before', caption: String(p.room || '').trim() || room,
    }));
  const plans = (kid?.plans || []).filter((p) => usable(p?.url) && addressChecked(p));
  const drawings = (k) => plans.filter((p) => planKind(p) === k).map((p) => {
    const label = String(p.label || '').trim();
    return {
      kind: k, url: p.url, crop: needsTitleCrop(p),
      alt: label || KIND[k].long,
      badge: KIND[k].badge,
      kicker: KIND[k].kicker,
      // A board's own caption says what it is ("Bathroom design board"); a plan says which plan it is
      caption: k === 'board' ? (label && !looksLikeFileName(label) ? label : KIND[k].caption) : (after && KIND[k].captionAfter) || KIND[k].caption,
      ...(Number(p.w) > 0 && Number(p.h) > 0 ? { w: Math.round(p.w), h: Math.round(p.h) } : {}),
    };
  });
  return [...befores, ...drawings('as-built'), ...drawings('proposed'), ...drawings('board')];
}

/** A caption that is really a file name ("CompanyCam 2445", "IMG_0042", "Plan Set_093026.pdf") */
export const looksLikeFileName = (s) => /^\s*(?:companycam|img|dsc|pxl|screenshot|scan|photo|image|untitled)[\s_-]*\d/i.test(String(s || ''))
  || /^\s*[\d_-]+\s*$/.test(String(s || '')) || /\.(?:jpe?g|png|pdf|heic|webp)\s*$/i.test(String(s || '')) || /_\d{6,}/.test(String(s || ''));

const OPEN_PHASES = new Set(['armed', 'live', 'ending', 'replay']);
const STARTED_PHASES = new Set(['live', 'ending', 'replay']);

/**
 * Whether the design is public yet. kid: the profile; reveal: this kid's
 * reveal from JobTread's schedule ({ startsAt, confirmed }), coming up or from
 * the last few months; broadcast: the live state ({ kidSlug, phase, scheduledAt }).
 * It belongs to a reveal: open from an hour before it, through it and its
 * replay, and while JobTread's schedule still keeps it. A room revealed long
 * ago has its design on its kid page instead, so it isn't open here.
 * → { open, opensAt, after } (opensAt: when it will open, if that's known;
 *   after: the reveal has started)
 */
export function designWindow({ kid, reveal = null, broadcast = null, now = Date.now() }) {
  const closed = (opensAt = null) => ({ open: false, opensAt, after: false });
  if (!kid || kid.publishStatus === 'draft') return closed();
  const starts = [];
  if (reveal && reveal.confirmed !== false && reveal.startsAt) starts.push(Date.parse(reveal.startsAt));
  const ours = !!broadcast && !!broadcast.kidSlug && broadcast.kidSlug === kid.slug;
  if (ours && broadcast.scheduledAt && (broadcast.phase === 'scheduled' || OPEN_PHASES.has(broadcast.phase))) starts.push(Date.parse(broadcast.scheduledAt));
  const known = starts.filter(Number.isFinite);
  const first = known.length ? Math.min(...known) : NaN;
  const after = (ours && STARTED_PHASES.has(broadcast.phase)) || (Number.isFinite(first) && now >= first);
  // The crew's stream is up (or over) for this kid: open, whatever the clock says
  if (ours && OPEN_PHASES.has(broadcast.phase)) return { open: true, opensAt: null, after };
  if (!Number.isFinite(first)) return closed();
  const opens = first - DESIGN_LEAD_MS;
  return now >= opens ? { open: true, opensAt: null, after } : closed(new Date(opens).toISOString());
}

// ── Bringing drawings in from JobTread ───────────────────────────────

/**
 * A drawing's kind from its sheet title or the words on it: "EXISTING FLOOR
 * PLAN" is as-built, "PROPOSED FLOOR PLAN" proposed, a design or mood board
 * or a rendering a board. Anything else (a cover sheet, elevations, electrical,
 * notes) is null: not one for the reveal.
 */
export function kindFromText(text) {
  const t = String(text || '').toLowerCase().replace(/\s+/g, ' ');
  if (/\b(design|mood|inspiration|finish(?:es)?|material|selections?|concept|presentation)\s*boards?\b|\brender(?:ing)?s?\b|\b3d\b|\bperspective\b/.test(t)) return 'board';
  if (/\bas[\s-]?built\b|\bexisting\b|\bdemo(?:lition)?\s*plan\b/.test(t)) return 'as-built';
  if (/\bproposed\b|\bnew\s+(?:floor\s*)?plan\b|\bfloor\s*plan\b|\blayout\b/.test(t)) return 'proposed';
  return null;
}

/** The before photos to start with: up to n, spread across the visit in the order they were taken */
export function suggestBefores(photos, n = BEFORE_SUGGESTED) {
  const list = [...(photos || [])];
  if (list.length <= n) return list;
  const out = [];
  for (let i = 0; i < n; i++) out.push(list[Math.round((i * (list.length - 1)) / (n - 1))]);
  return [...new Set(out)];
}

/** The family's address as words to wipe off a drawing: the street line, its number and name, city, zip, and the family name */
export function addressWords({ street = '', city = '', zip = '', family = '' } = {}) {
  const words = new Set();
  const add = (s) => { const v = String(s || '').trim(); if (v.length >= 3) words.add(v.toLowerCase()); };
  add(street);
  const m = String(street || '').match(/^\s*(\d+[a-z]?)\s+(.+?)\s*$/i);
  if (m) { add(m[1].length >= 3 ? m[1] : ''); add(m[2].replace(/\b(ln|lane|st|street|rd|road|dr|drive|ave|avenue|ct|court|way|blvd|cir|circle|pl|place|trl|trail|pkwy)\.?$/i, '').trim()); }
  add(city); add(zip); add(family);
  return [...words];
}
