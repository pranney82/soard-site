/**
 * /apply/form/ and /apply/community-project/: embed the live application form in the page
 * =====================================================================
 * The pages are static (src/components/apply/ApplicationPage.astro); the form itself is data
 * that staff change in Admin → Applications → Form, live without a Publish.
 * This puts the live form, the open/closed switch and the season year into
 * the page as JSON, so the browser draws the right questions on first paint
 * without asking the API. If anything here fails the page is served as built
 * and the script asks /api/apply?config instead.
 *
 * ?test=1 is a staff test run (Admin → Applications → Form, "Go through it as a family"): for a
 * signed-in staff member the form opens even while applications are closed, and the page says
 * whose inbox every email will go to. Without a sign-in it says to sign in first.
 *
 * The organization application (kind 'organization') follows its own switch
 * (application.orgOpen) and closed message, and has no season limit.
 */

import { applicationSettings, cleanYear } from '../api/_applications.js';
import { getLiveForm } from '../api/_application-forms.js';
import { resolveForm } from '../api/_application-form.js';
import { publicForm, publicDefinition, staffEmail, formOpen } from '../api/apply.js';
import { seasonFull, defaultFullMessage } from '../api/_application-cap.js';
import { t } from '../../src/components/apply/application-render.js';

const PATHS = { family: /^\/apply\/form\/?$/, organization: /^\/apply\/community-project\/?$/ };

export async function embedForm(context, kind = 'family') {
  const { request, env, next } = context;
  const url = new URL(request.url);
  const org = kind === 'organization';
  if ((request.method !== 'GET' && request.method !== 'HEAD') || !PATHS[kind].test(url.pathname)) return next();
  try {
    if (!env.DB) return next();
    const settings = await applicationSettings(env.DB);
    const year = cleanYear(settings.year);
    const live = await getLiveForm(env.DB, { kind });
    const form = resolveForm(live.definition, { year, version: live.version });
    // Closed at the application limit, the closed card says the season is full (./_application-cap.js)
    const full = org ? false : await seasonFull(env.DB, settings, year);
    const testBy = url.searchParams.has('test') ? await staffEmail(request, env) : null;
    const config = {
      kind, open: formOpen(settings, kind), full, year, version: live.version,
      definition: publicDefinition(live.definition), form: publicForm(form),
      turnstileSiteKey: env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY ? env.TURNSTILE_SITE_KEY : null,
      ...(url.searchParams.has('test') ? { testRun: testBy ? { by: testBy } : { signIn: true } } : {}),
    };
    // A staff test run shows the form whether or not applications are open; without a sign-in,
    // the test-run bar says to sign in (and the form stays out of reach)
    const showForm = config.open || !!config.testRun;
    const signIn = !!config.testRun?.signIn;
    // Always the full page (never a 304): a cached copy would skip the embed
    const fresh = new Request(request);
    fresh.headers.delete('If-None-Match');
    fresh.headers.delete('If-Modified-Since');
    const res = await next(fresh);
    if (res.status !== 200 || !(res.headers.get('content-type') || '').includes('text/html')) return res;
    // JSON in a <script> can't contain "</script>": escape every "<"
    const json = JSON.stringify(config).replace(/</g, '\\u003c');
    const out = new HTMLRewriter()
      .on('[data-application]', {
        element(el) {
          el.setAttribute('data-year', year);
          el.prepend(`<script type="application/json" id="af-config">${json}</script>`, { html: true });
          if (showForm) el.removeAttribute('hidden');
          else el.setAttribute('hidden', '');
          if (signIn) el.setAttribute('class', `${el.getAttribute('class') || ''} is-signin`.trim());
        },
      })
      .on('[data-form]', { element(el) { if (signIn) el.setAttribute('hidden', ''); } })
      .on('[data-closed]', {
        element(el) {
          if (showForm) el.setAttribute('hidden', '');
          else el.removeAttribute('hidden');
        },
      })
      // Its headline, from the live settings: a message staff wrote stays as written, the
      // built-in one (data-af-t) follows the family's language in the browser
      .on('[data-closed] h2', {
        element(el) {
          const mine = String((full ? settings.fullMessage : org ? settings.orgClosedMessage : settings.closedMessage) || '').trim();
          if (mine) { el.removeAttribute('data-af-t'); el.setInnerContent(mine); return; }
          el.setAttribute('data-af-t', full ? 'fullTitle' : 'closedTitle');
          el.setInnerContent(full ? defaultFullMessage(year) : org ? t('en', 'closedTitle', { year }, kind) : `The ${year} application period is currently closed.`);
        },
      })
      .transform(res);
    const headers = new Headers(out.headers);
    // The form and its switch change without a deploy: browsers and the edge recheck every visit
    headers.set('Cache-Control', 'no-cache');
    // A test run's page names the staff member: never kept by any cache
    if (config.testRun) headers.set('Cache-Control', 'private, no-store');
    headers.delete('ETag');
    headers.delete('Last-Modified');
    headers.delete('Content-Length');
    return new Response(out.body, { status: out.status, headers });
  } catch {
    return next();
  }
}
