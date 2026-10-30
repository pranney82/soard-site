/**
 * Vendors and agents may be emailed for a W-9 or certificate (functions/api/_vendors.js asksOnHold): someone at
 * SOARD turned asking on, and the certificate search has looked through email, JobTread and Ramp once with
 * nothing left to read. Off is the real default; tests about the asks themselves start from here.
 */
import { saveDocSettings } from '../../functions/api/_vendors.js';
import { ensureCoverageSchema } from '../../functions/api/_coi-backfill.js';
import { writeState } from '../../functions/api/_mercury.js';

export async function asksOn(DB) {
  await ensureCoverageSchema(DB);
  await saveDocSettings(DB, { asking: true, by: 'pat@example.org' });
  await writeState(DB, 'coi-backfill', { mail: { 'pat@example.org': { doneAt: 1 } }, jt: { doneAt: 1 }, ramp: { doneAt: 1 } });
}
