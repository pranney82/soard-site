/**
 * Where the site lives (functions/api/_hosting.js): Cloudflare's builds,
 * GitHub's main and the domains' registrations come through as short shas,
 * times and dates; each read fails on its own; nothing secret or wordy leaks.
 * Run: node --test tests/
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { hostingFacts, pagesFrom, buildOf, rdapFacts, clearHostingCache, keysFacts, READ_KEYS, DOMAINS } from '../functions/api/_hosting.js';

beforeEach(() => clearHostingCache());

const T = (min) => new Date(Date.parse('2026-11-12T17:00:00Z') - min * 60e3).toISOString();
const deploy = (id, sha, min, stage = 'deploy', status = 'success', type = 'github:push') => ({
  id, environment: 'production', created_on: T(min),
  latest_stage: { name: stage, status, ended_on: status === 'active' ? null : T(min - 2) },
  deployment_trigger: { type, metadata: { commit_hash: `${sha}0000000000000000000000000000000000`, commit_message: 'SECRET-MESSAGE words words', branch: 'main' } },
});
const rdap = (name, { expires = '2029-03-14T15:05:09Z', registrar = 'Cloudflare, Inc.', ns = ['LINA.NS.CLOUDFLARE.COM', 'dakota.ns.cloudflare.com.'] } = {}) => ({
  ldhName: name.toUpperCase(),
  events: [{ eventAction: 'registration', eventDate: '2012-03-14T15:05:09Z' }, { eventAction: 'expiration', eventDate: expires }, { eventAction: 'transfer', eventDate: '2026-08-26T22:21:29Z' }],
  entities: [{ roles: ['registrar'], vcardArray: ['vcard', [['version', {}, 'text', '4.0'], ['fn', {}, 'text', registrar]]] }],
  nameservers: ns.map((n) => ({ ldhName: n })),
});

/** A fetch that answers Cloudflare, GitHub and the registries; `over` swaps any of them */
const fakeFetch = (over = {}) => {
  const calls = [];
  const fn = async (url, init = {}) => {
    calls.push({ url, auth: init.headers?.Authorization || null });
    const u = new URL(url);
    if (u.hostname === 'api.cloudflare.com') return over.pages ? over.pages(u) : Response.json({ success: true, result: [deploy('d2', 'bbbbbbbb', 10), deploy('d1', 'aaaaaaaa', 60, 'deploy', 'success', 'deploy_hook')] });
    if (u.hostname === 'api.github.com') return over.github ? over.github(u) : Response.json({ sha: 'bbbbbbbb1111', commit: { message: 'SECRET-MESSAGE', committer: { date: T(12) } } });
    const name = u.pathname.split('/').pop();
    return over.rdap ? over.rdap(name) : Response.json(rdap(name));
  };
  fn.calls = calls;
  return fn;
};
const ENV = { CF_ACCOUNT_ID: 'acct', CF_PAGES_TOKEN: 'PAGES-TOKEN-SECRET', GITHUB_TOKEN: 'GH-TOKEN-SECRET' };

test('the live build, its commit and how it started', () => {
  const p = pagesFrom([deploy('d3', 'cccccccc', 2, 'build', 'active'), deploy('d2', 'bbbbbbbb', 10), deploy('d1', 'aaaaaaaa', 60, 'deploy', 'success', 'deploy_hook')]);
  assert.equal(p.tracking, true);
  assert.deepEqual(p.live, { at: T(10), endedAt: T(8), commit: 'bbbbbbbb', by: 'push' });
  assert.equal(p.active.commit, 'cccccccc');
  assert.equal(p.failed, null);
  const failed = pagesFrom([deploy('d3', 'cccccccc', 2, 'build', 'failure'), deploy('d1', 'aaaaaaaa', 60, 'deploy', 'success', 'deploy_hook')]);
  assert.equal(failed.failed.commit, 'cccccccc');
  assert.deepEqual(failed.live, { at: T(60), endedAt: T(58), commit: 'aaaaaaaa', by: 'publish' });
});

test('what became of main’s newest commit', () => {
  const list = [deploy('d3', 'cccccccc', 2, 'build', 'active'), deploy('d2', 'bbbbbbbb', 10), deploy('d1', 'aaaaaaaa', 60, 'build', 'failure')];
  assert.equal(buildOf('bbbbbbbb', list), 'live');
  assert.equal(buildOf('cccccccc', list), 'building');
  assert.equal(buildOf('aaaaaaaa', list), 'failed');
  assert.equal(buildOf('dddddddd', list), 'none');
  // A Publish rebuild of the same commit after a failure: the newest build decides
  assert.equal(buildOf('aaaaaaaa', [deploy('d4', 'aaaaaaaa', 1, 'deploy', 'success', 'deploy_hook'), ...list]), 'live');
});

test('a registry answer becomes registrar, paid-through date and nameservers', () => {
  assert.deepEqual(rdapFacts(rdap('soardcharity.com', { expires: '2028-01-05T16:46:52Z' })), {
    registrar: 'Cloudflare, Inc.', expires: '2028-01-05T16:46:52Z', ns: ['dakota.ns.cloudflare.com', 'lina.ns.cloudflare.com'], transferredAt: '2026-08-26T22:21:29Z',
  });
  assert.deepEqual(rdapFacts({}), { registrar: null, expires: null, ns: [], transferredAt: null });
});

test('everything comes through, with short shas and no secret or commit message', async () => {
  const fetchImpl = fakeFetch();
  const h = await hostingFacts(ENV, { fetchImpl, now: Date.parse('2026-11-12T17:00:00Z') });
  assert.equal(h.pages.live.commit, 'bbbbbbbb');
  assert.deepEqual(h.github, { sha: 'bbbbbbbb', at: T(12), skip: false, build: 'live' });
  assert.deepEqual(Object.keys(h.domains), DOMAINS);
  assert.equal(h.domains['sunshineonaranneyday.org'].expires, '2029-03-14T15:05:09Z');
  const text = JSON.stringify(h);
  for (const s of ['SECRET-MESSAGE', 'PAGES-TOKEN-SECRET', 'GH-TOKEN-SECRET']) assert.ok(!text.includes(s), `leaked ${s}`);
  // Each registry by its TLD; the tokens go only where they belong
  assert.ok(fetchImpl.calls.some((c) => c.url === 'https://rdap.publicinterestregistry.org/rdap/domain/sunshineonaranneyday.org'));
  assert.ok(fetchImpl.calls.some((c) => c.url === 'https://rdap.verisign.com/com/v1/domain/soardcharity.com'));
  for (const c of fetchImpl.calls) {
    const host = new URL(c.url).hostname;
    if (host === 'api.cloudflare.com') assert.equal(c.auth, 'Bearer PAGES-TOKEN-SECRET');
    else if (host === 'api.github.com') assert.equal(c.auth, 'Bearer GH-TOKEN-SECRET');
    else assert.equal(c.auth, null, `no token to ${host}`);
  }
});

test('one read failing leaves the others standing', async () => {
  const h = await hostingFacts(ENV, { fetchImpl: fakeFetch({
    pages: () => new Response('no', { status: 403 }),
    github: () => { throw new Error('offline'); },
    rdap: (name) => (name === 'soardcharity.com' ? new Response('', { status: 503 }) : Response.json(rdap(name))),
  }) });
  assert.equal(h.pages.tracking, true);
  assert.match(h.pages.error, /403/);
  assert.equal(h.github.error, 'offline');
  assert.match(h.domains['soardcharity.com'].error, /503/);
  assert.equal(h.domains['sunshineonaranneyday.com'].registrar, 'Cloudflare, Inc.');
});

test('without the Pages token the builds aren’t tracked, and main has no build state', async () => {
  const h = await hostingFacts({ GITHUB_TOKEN: 'g' }, { fetchImpl: fakeFetch() });
  assert.deepEqual(h.pages, { tracking: false });
  assert.equal(h.github.sha, 'bbbbbbbb');
  assert.equal(h.github.build, undefined);
});

test('a push asking not to be built says so', async () => {
  const h = await hostingFacts(ENV, { fetchImpl: fakeFetch({ github: () => Response.json({ sha: 'eeeeeeee22', commit: { message: 'Docs only [skip ci]', committer: { date: T(1) } } }) }) });
  assert.equal(h.github.skip, true);
  assert.equal(h.github.build, 'none');
});

test('domains are read once every 6 hours, and a registry that stops answering keeps the last reading', async () => {
  const now = Date.parse('2026-11-12T17:00:00Z');
  const first = fakeFetch();
  await hostingFacts(ENV, { fetchImpl: first, now });
  const rdapCalls = (f) => f.calls.filter((c) => /rdap/.test(c.url)).length;
  assert.equal(rdapCalls(first), 4);
  const again = fakeFetch();
  await hostingFacts(ENV, { fetchImpl: again, now: now + 3600e3 });
  assert.equal(rdapCalls(again), 0, 'kept for 6 hours');
  const down = fakeFetch({ rdap: () => new Response('', { status: 500 }) });
  const h = await hostingFacts(ENV, { fetchImpl: down, now: now + 7 * 3600e3 });
  assert.equal(rdapCalls(down), 4);
  assert.equal(h.domains['sunshineonaranneyday.com'].expires, '2029-03-14T15:05:09Z');
  assert.equal(h.domains['sunshineonaranneyday.com'].stale, true);
});

test('keys: a count, and the names nothing reads; never a value, never a binding', () => {
  const k = keysFacts({ KIT_API_KEY: 'kit-SECRET', CC_CLIENT_ID: 'cc-SECRET', MEDUSA_ADMIN_KEY: 'm-SECRET', CF_PAGES_URL: 'https://x', DB: {}, FILES: {}, lowercase: 'x' });
  assert.deepEqual(k, { set: 3, unused: ['CC_CLIENT_ID', 'MEDUSA_ADMIN_KEY'] });
  assert.ok(!JSON.stringify(k).includes('SECRET'));
  assert.deepEqual(keysFacts({}), { set: 0, unused: [] });
});

// Bindings (not keys), and names only a computer or Cloudflare's build sets, never a key in Cloudflare
const BINDINGS = new Set(['AI', 'ASSETS', 'BROWSER', 'DB', 'FILES', 'VENDOR_FILES', 'APPLICANT_FILES', 'BOARD_FILES', 'LIVE_HUB', 'PRINT_HUB']);
const NOT_KEYS = new Set(['POPUP_AUDIT_STRICT', 'BOOK_FIXTURE', 'SOARD_OG_SPEC_DIR', 'NODE_ENV', 'SITE', 'R2_PUBLIC_URL', 'CF_PAGES', 'CF_PAGES_COMMIT_SHA']);
// These only check whether a key is set, for this map (a key only they read is one nothing uses)
const PRESENCE_ONLY = new Set(['functions/api/automations-admin.js', 'functions/api/_hosting.js']);

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}
const names = (text, re) => [...text.matchAll(re)].map((m) => m[1]);
const destructured = (text, from) => [...text.matchAll(new RegExp(String.raw`(?:const|let)\s*\{([^}]+)\}\s*=\s*${from}`, 'g'))]
  .flatMap((m) => m[1].split(',').map((x) => x.split(':')[0].split('=')[0].trim())).filter((x) => /^[A-Z][A-Z0-9_]+$/.test(x));

test('every key the code reads is on the list, so a key nothing reads is really unused', () => {
  const read = new Map();
  const note = (n, f) => { if (!read.has(n)) read.set(n, f); };
  for (const f of walk('functions').filter((x) => x.endsWith('.js') && !PRESENCE_ONLY.has(x))) {
    const t = readFileSync(f, 'utf8');
    for (const n of [...names(t, /\benv\??\.([A-Z][A-Z0-9_]+)\b/g), ...names(t, /\benv\[\s*['"]([A-Z][A-Z0-9_]+)['"]\s*\]/g), ...destructured(t, String.raw`(?:context\.|ctx\.|c\.)?env\b`)]) note(n, f);
  }
  const build = [...walk('scripts').filter((x) => /\.(m?js)$/.test(x) && !/(^|\/)test-/.test(x)), ...walk('src').filter((x) => /\.(ts|astro|mjs|js)$/.test(x))];
  for (const f of build) {
    const t = readFileSync(f, 'utf8');
    for (const n of [...names(t, /(?:process\.env|import\.meta\.env)\.([A-Z][A-Z0-9_]+)/g), ...destructured(t, String.raw`process\.env\b`)]) note(n, f);
  }
  assert.ok(read.size > 40, `found the keys the code reads (${read.size})`);
  const missing = [...read].filter(([n]) => !READ_KEYS.has(n) && !BINDINGS.has(n) && !NOT_KEYS.has(n)).map(([n, f]) => `${n} (${f})`);
  assert.deepEqual(missing, [], 'add these to READ_KEYS in functions/api/_hosting.js');
  // And nothing on the list that no code reads any more
  const stale = [...READ_KEYS].filter((n) => !read.has(n));
  assert.deepEqual(stale, [], 'take these off READ_KEYS: no code reads them');
});

test('a GitHub key that can’t see the repo (made before the move to the organization) falls back to reading it without the key', async () => {
  const seen = [];
  const fetchImpl = fakeFetch();
  const wrapped = async (url, init = {}) => {
    if (new URL(url).hostname === 'api.github.com') {
      seen.push(init.headers?.Authorization || null);
      if (init.headers?.Authorization) return new Response('{"message":"Not Found"}', { status: 404 });
    }
    return fetchImpl(url, init);
  };
  const r = await hostingFacts(ENV, { fetchImpl: wrapped });
  assert.equal(r.github.sha, 'bbbbbbbb');
  assert.deepEqual(seen, ['Bearer GH-TOKEN-SECRET', null]);
  // Any other failure isn't retried without the key
  const down = await hostingFacts(ENV, { fetchImpl: fakeFetch({ github: () => new Response('', { status: 500 }) }) });
  assert.match(down.github.error, /500/);
});
