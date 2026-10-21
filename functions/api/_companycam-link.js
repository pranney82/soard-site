/**
 * The family's CompanyCam project, for the moment their job is made
 * ===========================================================================
 * ./_applicant-approved.js makes the job with this project's id
 * (createJob companycamId), so JobTread's CompanyCam integration uses the
 * home-visit project instead of starting a second one. Kept apart from
 * ./_companycam-sync.js so the approval code doesn't import the whole
 * connector (which imports it back).
 */

/** The CompanyCam project id for a family still before their job, or null. Never throws. */
export async function familyProjectId(DB, accountId) {
  try {
    const row = await DB.prepare("SELECT project_id FROM companycam_projects WHERE account_id = ? AND stage = 'customer' AND project_id IS NOT NULL")
      .bind(String(accountId)).first();
    return row?.project_id ? String(row.project_id) : null;
  } catch {
    return null; // no table until CompanyCam is set up
  }
}
