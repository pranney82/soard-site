/**
 * People (Team & Board) status on the server. Records carry `status`
 * ('active' | 'alumni' | 'memorial'); older ones mark a memorial only by
 * starting the name with "In memoriam". Same rule as public/admin/team-shared.js.
 */

const MEMORIAL_PREFIX = /^\s*in memoriam\s*[,:]?\s*/i;
const STATUSES = new Set(['active', 'alumni', 'memorial']);

export function personStatus(d) {
  if (STATUSES.has(d?.status)) return d.status;
  return MEMORIAL_PREFIX.test(d?.name || '') ? 'memorial' : 'active';
}

/** The name without an older record's "In memoriam, " prefix */
export const personName = (d) => String(d?.name || '').replace(MEMORIAL_PREFIX, '').trim();

/** On the board today: reveal invites go to these members (a draft is still on the board) */
export const onActiveBoard = (d) => d?.group === 'board' && personStatus(d) === 'active';
