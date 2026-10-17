/**
 * POST /api/reveal-checks (public) — weekday 8 AM wake-up from the SOARD
 * JobTread workflow "Weekday 8 AM → Site reveal checks".
 *
 * Runs the reveal checks (./_reveal-nudges.js) if they're switched on and
 * haven't run today. A forged post can't do more than that: the run happens
 * at most once per weekday, after 8 AM Eastern, whoever asks. Site traffic
 * (/api/reveals, admin loads) is the backup trigger if a wake-up is missed.
 */

import { maybeNudge } from './_reveal-nudges.js';
import { maybeSweep } from './_reveal-invites.js';

export async function onRequestPost(context) {
  const { env } = context;
  try {
    const ran = await maybeNudge(env);
    // The calendar invite safety sweep rides along (it keeps its own 6-hour pace)
    context.waitUntil(maybeSweep(env));
    return Response.json({ ok: true, ran: ran || null });
  } catch (err) {
    // 500, not 502: Cloudflare swaps 502 bodies for its own error page
    return Response.json({ ok: false, error: err.message }, { status: 500 });
  }
}
