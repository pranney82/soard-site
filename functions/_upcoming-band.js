/**
 * The Coming up band (src/components/live/UpcomingReveals.astro), drawn from the schedule as it is now.
 *
 * The build drew the band's rows from the schedule it had; a reveal set, moved or passed since then made the
 * page script redraw them after load, and everything under the band moved (/events/ shows it on the first
 * screen of a laptop). Now the rows go out redrawn from the same edge copy of /api/reveals the kid pages read
 * (./_kid-reveal.js), by the same function the script uses (src/utils/band-rows.ts), in the visitor's own time
 * zone (Cloudflare's request.cf.timezone), with the same signature, and the list and the sign-up setting ride
 * along on the band (data-schedule) for the script to start from. So the script finds nothing to change.
 *
 * Each band keeps its own settings: the child it leaves out (data-exclude), how many rows open first
 * (data-limit), and whether it stays with nothing scheduled (data-keep-empty: while email sign-up is open).
 *
 * The "Get every reveal by email" card goes out the same way, from the sign-up setting in that same answer
 * (Reveals → Settings): left out when sign-ups are off, with the notes it promises. Before, the script took it
 * out after load and the rest of the page moved up 200 to 300px. Used by /reveals/ and /events/ (their
 * _middleware.js).
 */

import { bandRowsHtml, bandShows } from '../src/utils/band-rows.ts';
import { rowsSignature } from '../src/utils/upcoming-rows.ts';
import { remindPromise } from '../src/utils/live-banner.ts';
import { scheduleAttr } from './_kid-reveal.js';

/** What one band shows: the schedule less the children it leaves out, its rows, their signature, and whether "See every reveal" applies */
export function bandFor(all, { exclude = [], limit = 0, tz }) {
  const skip = new Set([exclude].flat().filter(Boolean));
  const shown = all.filter((r) => !skip.has(r.slug));
  return { shown, html: bandRowsHtml(shown, { limit, tz }), sig: rowsSignature(shown, tz), moreHidden: shown.length <= limit };
}

/**
 * Adds the band's handlers to an HTMLRewriter (every band on the page). schedule: /api/reveals as the page script
 * reads it, { upcoming, signup } (./_kid-reveal.js, edgeSchedule). current: the reveal the page is showing, which
 * the band leaves out too (/live/, as LivePage marks it)
 */
export function onBands(rw, schedule, tz, { current = '' } = {}) {
  const { upcoming: all, signup } = schedule;
  let band = null; // the band being written: its handlers fire in document order, the section's first
  return rw
    .on('[data-upnext]', {
      element(el) {
        band = bandFor(all, { exclude: [el.getAttribute('data-exclude') || '', current], limit: Number(el.getAttribute('data-limit')) || 0, tz });
        el.setAttribute('data-schedule', scheduleAttr(schedule));
        if (current) el.setAttribute('data-current', current);
        if (band.shown.length) el.removeAttribute('data-empty'); else el.setAttribute('data-empty', '');
        if (bandShows(band.shown.length, el.hasAttribute('data-keep-empty'), signup)) el.removeAttribute('hidden');
        else el.setAttribute('hidden', '');
      },
    })
    .on('[data-upnext] [data-upn-list]', {
      element(el) { if (!band) return; el.setInnerContent(band.html, { html: true }); el.setAttribute('data-sig', band.sig); },
    })
    .on('[data-upnext] [data-upn-more]', {
      element(el) { if (!band) return; if (band.moreHidden) el.setAttribute('hidden', ''); else el.removeAttribute('hidden'); },
    })
    // The email card: in while sign-ups are open, with the notes they promise, as the script leaves it
    .on('[data-upnext] [data-upn-mail]', {
      element(el) { if (signup?.email) el.removeAttribute('hidden'); else el.setAttribute('hidden', ''); },
    })
    .on('[data-upnext] [data-upn-mail-lead]', {
      element(el) { if (signup) el.setInnerContent(remindPromise(signup.hours)); },
    });
}
