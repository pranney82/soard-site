/**
 * A family's way from application to reveal, as the board page draws it: one
 * set of stages for Home's Makeovers card, the Makeovers page, the map and a
 * family's own page (./lifecycle.js). Peter, Nov 7 2026: "combining in some way
 * the applications and makeover kanban since that is the life span of a project
 * for us from application to completion".
 *
 * Where a family is comes from the server (../../../functions/api/_board-families.js
 * stageOf): their open job's JobTread status once it says one, else their
 * application's. Nothing here touches the page, so the tests read it as it is.
 */

export const STAGES = [
  { key: 'applied', label: 'Applied', phase: 'applying' },
  { key: 'review', label: 'In review', phase: 'applying' },
  { key: 'approved', label: 'Approved', phase: 'building' },
  { key: 'funding', label: 'Awaiting funding', phase: 'building' },
  { key: 'design', label: 'Design', phase: 'building' },
  { key: 'finalization', label: 'Finalization', phase: 'building' },
  { key: 'approval', label: 'Approval', phase: 'building' },
  { key: 'mobilization', label: 'Mobilization', phase: 'building' },
  { key: 'build', label: 'Build', phase: 'building' },
  { key: 'revealed', label: 'Revealed', phase: 'revealed' },
];
export const PHASES = [
  { key: 'applying', label: 'Applying' },
  { key: 'building', label: 'Building' },
  { key: 'revealed', label: 'Revealed' },
];
/** A makeover's JobTread Status as its stage (Closed Done and Warranty: done; On Site and others: the application says) */
export const STAGE_OF_JOB = { 'Awaiting Funding': 'funding', Design: 'design', Finalization: 'finalization', Approval: 'approval', Mobilization: 'mobilization', Build: 'build', 'Closed Done': 'revealed', Warranty: 'revealed', Denied: 'denied' };
const BY_KEY = new Map(STAGES.map((s, i) => [s.key, { ...s, i }]));
export const stageInfo = (key) => BY_KEY.get(key) || null;
export const stageLabel = (key) => BY_KEY.get(key)?.label || (key === 'denied' ? 'Not chosen' : 'No status');
export const phaseOf = (key) => BY_KEY.get(key)?.phase || '';

// The map's key, a color to a step of the way: the application's two (as Applicants colors them), one for building,
// one for revealed. Never red; brand yellow is the service area's
export const STAGE_KEYS = [
  { key: 'applied', label: 'Applied', color: '#2B6CB0' },
  { key: 'review', label: 'In review', color: '#B7791F' },
  { key: 'building', label: 'Building', color: '#2F7D4F' },
  { key: 'revealed', label: 'Revealed', color: '#6B4FA3' },
  { key: 'denied', label: 'Not chosen', color: '#7C7D84' },
  { key: 'none', label: 'No status', color: '#A3A4AA' },
];
/** A family's key on the map: their stage, the building ones as one */
export const keyOf = (f) => (phaseOf(f?.stage) === 'building' ? 'building' : f?.stage === 'applied' || f?.stage === 'review' || f?.stage === 'revealed' || f?.stage === 'denied' ? f.stage : 'none');
export const colorOf = (f) => STAGE_KEYS.find((k) => k.key === keyOf(f))?.color || '#A3A4AA';

/** The newest season among them ("2027") */
const newest = (list) => (list || []).map((f) => String(f.season || '')).filter(Boolean).sort().at(-1) || '';
const before = (y) => (/^\d{4}$/.test(y) ? String(Number(y) - 1) : y);

/**
 * Everyone in motion now: this season's applications, every makeover being built (any season), the families just
 * approved, and the reveals of the seasons still being built. Older families who were never decided, and anyone not
 * chosen, aren't "now". `application`: the window ({ year }) the server gives, or none
 */
export function inMotion(list, application = null) {
  const all = list || [];
  const current = String(application?.year || '') || newest(all);
  const building = all.filter((f) => phaseOf(f.stage) === 'building' && f.stage !== 'approved');
  const buildSeasons = new Set(building.map((f) => String(f.season || '')).filter(Boolean));
  if (!buildSeasons.size) buildSeasons.add(before(current));
  return all.filter((f) => {
    const y = String(f.season || '');
    if (f.stage === 'applied' || f.stage === 'review') return !y || y >= current;
    if (f.stage === 'approved') return !y || y >= before(current);
    if (phaseOf(f.stage) === 'building') return true;
    if (f.stage === 'revealed') return buildSeasons.has(y) || y >= current;
    return false;
  });
}

/** How many at each stage: { applied: 3, … } */
export function countsOf(list) {
  const out = {};
  for (const f of list || []) out[f.stage] = (out[f.stage] || 0) + 1;
  return out;
}

/** The stages a board shows: every one with someone in it, Finalization only then, and Applied while applications are open */
export function shownStages(counts, application = null) {
  return STAGES.filter((s) => (counts[s.key] || 0) > 0 || (s.key === 'applied' && application?.open));
}

/** The stages a track shows: all but Finalization (it shows when someone's in it) */
export const trackStages = (counts) => STAGES.filter((s) => s.key !== 'finalization' || (counts[s.key] || 0) > 0);

const DAY = (iso) => new Date(`${String(iso).slice(0, 10)}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
/** The application's window in a few words: "Open until Jan 31", "Opens Mar 1", "Closed" */
export function windowWords(app, today = new Date().toISOString().slice(0, 10)) {
  if (!app) return '';
  if (app.open) return app.closesAt ? `Open until ${DAY(app.closesAt)}` : 'Open now';
  if (app.opensAt && String(app.opensAt).slice(0, 10) >= today) return `Opens ${DAY(app.opensAt)}`;
  return 'Closed';
}

/** Stage order for a list, as the way goes: applying first, revealed last, then not chosen and no status */
export const byStage = (a, b) => (stageInfo(a.stage)?.i ?? (a.stage === 'denied' ? 98 : 99)) - (stageInfo(b.stage)?.i ?? (b.stage === 'denied' ? 98 : 99));
