/**
 * Admin → Press and the press monitor
 *   public/admin/press-shared.js  (outlets, duplicates, issues, kids and partners)
 *   functions/api/_press-sources.js, _press-page.js  (on real captured pages)
 *   functions/api/_press.js  (finding, filing, the tidy, the link check, undo)
 * The engine runs on a D1 shim seeded with the real stories, outlets, kids
 * and partners (src/content), against a made-up outside world.
 * Run: node --test tests/
 */
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { createD1 } from './lib/d1-shim.mjs';
import * as P from '../public/admin/press-shared.js';
import { parseGoogleRss, parseBingRss, parseYouTubeFeed, parseYouTubeSearch, decodeGoogleLink, relativeDate } from '../functions/api/_press-sources.js';
import { parsePage, checkLink } from '../functions/api/_press-page.js';
import * as E from '../functions/api/_press.js';
import { EXTRACTORS } from '../functions/api/_collections.js';

const ROOT = new URL('..', import.meta.url).pathname;
const FIX = (f) => readFileSync(`${ROOT}tests/fixtures/press/${f}`, 'utf8');
const readDir = (d) => (existsSync(`${ROOT}src/content/${d}`) ? readdirSync(`${ROOT}src/content/${d}`).filter((f) => f.endsWith('.json')).map((f) => ({ slug: f.replace(/\.json$/, ''), ...JSON.parse(readFileSync(`${ROOT}src/content/${d}/${f}`, 'utf8')) })) : []);
const REAL = { press: readDir('press'), medialogos: readDir('medialogos'), kids: readDir('kids'), partners: readDir('partners') };
const haveReal = REAL.press.length > 50 && REAL.kids.length > 50;
// The copies the old monitor saved live only in D1 (synced into src/content, not in git):
// a fresh checkout has none, so the duplicate checks count what's actually there
const REAL_DUPES = P.duplicateGroups(REAL.press);
const REAL_REMOVED = REAL_DUPES.reduce((n, g) => n + g.length - 1, 0);
const NOW = Date.parse('2026-10-20T16:00:00Z');
/** A Response that says where it came from (fetch's res.url, read-only on a real Response) */
const withUrl = (res, url) => Object.defineProperty(res, 'url', { value: url });
const DAY = 864e5;

// ── The shared rules ─────────────────────────────────────────────────
describe('press-shared', () => {
  test('outlet names: one key per outlet', () => {
    assert.equal(P.outletKey('The Atlanta Journal-Constitution'), P.outletKey('Atlanta Journal-Constitution'));
    assert.equal(P.outletKey('11Alive.com'), P.outletKey('11Alive (NBC Atlanta)'));
    assert.equal(P.outletKey('FOX 5 Atlanta'), P.outletKey('Fox 5 Atlanta'));
    assert.notEqual(P.outletKey('Roswell Patch'), P.outletKey('Atlanta Patch'));
    assert.equal(P.cleanOutletName('ABC News - Breaking News, Latest News and Videos'), 'ABC News');
    assert.equal(P.cleanOutletName('Associated Press / Washington Times'), 'Associated Press / Washington Times');
  });
  test('headlines and addresses', () => {
    assert.equal(P.cleanTitle('Group surprises Haleigh Cox with new therapy room - 13WMAZ', '13WMAZ'), 'Group surprises Haleigh Cox with new therapy room');
    assert.equal(P.storyTitle({ title: 'X marks the spot for a family - The Atlanta Journal-Constitution', outlet: 'The Atlanta Journal-Constitution' }), 'X marks the spot for a family');
    assert.equal(P.urlKey('https://www.ajc.com/a/b/?utm=1'), 'ajc.com/a/b');
    assert.equal(P.urlKey('https://youtu.be/Tej9V0MPQbY'), P.urlKey('https://www.youtube.com/watch?v=Tej9V0MPQbY&t=3s'));
    assert.equal(P.youTubeId('https://www.youtube.com/embed/Tej9V0MPQbY'), 'Tej9V0MPQbY');
    assert.equal(P.youTubeId('not a video'), null);
    assert.ok(P.sameHeadline('A room built with dignity: How Sunshine on a Ranney Day transforms homes and lives', 'How Sunshine on a Ranney Day transforms homes and lives'));
    assert.ok(!P.sameHeadline('Sunshine on a Ranney Day', 'Sunshine on a Ranney Day expands'));
    assert.equal(P.notPressReason('https://projects.propublica.org/nonprofits/organizations/454773997'), 'A listing, not a story');
    assert.equal(P.notPressReason('https://sunshineonaranneyday.com/'), 'SOARD’s own website');
    assert.equal(P.linkFor({ url: 'https://a.com/x', linkGone: '2026-10-01', archiveUrl: 'https://web.archive.org/web/2019/https://a.com/x' }), 'https://web.archive.org/web/2019/https://a.com/x');
    assert.equal(P.linkFor({ url: 'https://a.com/x', linkGone: '2026-10-01' }), null);
  });
  test('a story as saved keeps what it doesn’t know about and drops empty extras', () => {
    const r = P.storyRecord({ outlet: ' WSB-TV ', outletLogo: 'wsb-tv', category: 'nope', title: '<b>Hi</b>', date: '2026-01-02', url: 'https://x.com', excerpt: 'A&amp;B <a href="x">link</a>', image: '', videoId: 'https://youtu.be/Tej9V0MPQbY', featured: false, featuredHeadline: 'Kept', kids: ['a', 'a', ''], somethingNew: 7 });
    assert.equal(r.outlet, 'WSB-TV');
    assert.equal(r.category, 'print');
    assert.equal(r.title, 'Hi');
    assert.equal(r.excerpt, 'A&B link');
    assert.equal(r.image, null);
    assert.equal(r.videoId, 'Tej9V0MPQbY');
    assert.equal(r.featuredHeadline, 'Kept', 'a featured headline survives un-featuring');
    assert.deepEqual(r.kids, ['a']);
    assert.equal(r.somethingNew, 7);
    assert.ok(!('partners' in r) && !('publishStatus' in r));
  });
  test('kid names and candidates', () => {
    assert.deepEqual(P.kidNames({ name: 'Aidan & Brendan' }), ['Aidan', 'Brendan']);
    assert.deepEqual(P.kidNames({ name: 'Anthony Jr. & Lyric' }), ['Anthony', 'Lyric']);
    assert.deepEqual(P.kidNames({ name: 'Damon (DJ)' }), ['Damon', 'DJ']);
    assert.deepEqual(P.kidNames({ name: 'Christian B' }), ['Christian']);
    const kids = [{ slug: 'kalen', name: 'Kalen', year: 2016 }, { slug: 'kalen-2025', name: 'Kalen', year: 2025 }, { slug: 'grace', name: 'Grace', year: 2016 }];
    const c = P.kidCandidates('Powder Springs teen Kalen Reese got a Hawks room. By grace of God.', kids, 2016);
    assert.deepEqual(c.map((k) => k.slug), ['kalen'], 'the right year, and a name only with its capital');
    const partners = [{ slug: 'mohawk', name: 'Mohawk' }, { slug: 'home', name: 'Home' }, { slug: 'top-knobs', name: 'Top Knobs' }];
    assert.deepEqual(P.partnerCandidates('Top Knobs and Mohawk helped at home.', partners).map((p) => p.slug), ['mohawk', 'top-knobs']);
  });
  test('found in a real run: obituaries, place names and stray letters are never coverage or people', () => {
    assert.equal(P.notPressReason('https://www.legacy.com/us/obituaries/name/peter-ranney', 'Peter Ranney Obituary (2026)'), 'An obituary');
    assert.equal(P.notPressReason('https://www.northsidechapel.com/obituary/caitlin-davis', 'Miss Caitlin Ann Davis'), 'An obituary');
    assert.equal(P.notPressReason('https://vnews.com/2018/07/11/virginia-bard-obituary-hanover-nh-18740797/', 'Virginia Carol Bard'), 'An obituary');
    assert.equal(P.notPressReason('https://www.ajc.com/x', 'Ten charities to know'), null);
    const kids = [{ slug: 'georgia', name: 'Georgia', year: 2018 }, { slug: 'peter', name: 'Peter', year: 2019 }, { slug: 'devon', name: 'Devon', year: 2019 }];
    const c = P.kidCandidates('Devon Gales moves to Georgia. Peter Ranney said Devon is home in Georgia.', kids, 2019);
    assert.deepEqual(c.filter((k) => k.ambiguous).map((k) => k.slug).sort(), ['georgia', 'peter']);
    assert.ok(!c.find((k) => k.slug === 'devon').ambiguous);
    const partners = [{ slug: 'at', name: 'A T' }, { slug: 'sr', name: 'Sunny & Ranney' }, { slug: 'rtg', name: 'Rooms To Go' }];
    assert.deepEqual(P.partnerCandidates('A T. Sunny & Ranney opened. Rooms To Go donated.', partners).map((p) => p.slug), ['rtg']);
  });
  test('relevance', () => {
    assert.ok(P.relevance({ title: 'Sunshine on a Ranney Day opens a room' }).strong);
    assert.ok(P.relevance({ title: 'A room', text: 'Sunshine on a Ranney Day ... Sunshine on a Ranney Day' }).strong);
    assert.ok(!P.relevance({ title: 'Holly Ranney wins bake-off' }).strong);
    assert.ok(P.relevance({ title: 'Holly Ranney wins bake-off' }).any);
    assert.ok(!P.relevance({ title: 'City council meets' }).any);
  });
  test('an outlet in the strip: older records with a logo are, new ones only when switched on', () => {
    assert.ok(P.inStrip({ logo: 'x' }));
    assert.ok(!P.inStrip({ logo: 'x', strip: false }));
    assert.ok(!P.inStrip({ logo: '', strip: true }));
  });
  test('matching an outlet: website first, and a shared website needs the name', () => {
    const outlets = [{ slug: 'ajc', name: 'Atlanta Journal-Constitution', domains: ['ajc.com'] }, { slug: 'roswell-patch', name: 'Roswell Patch', domains: ['patch.com'] }, { slug: 'atlanta-patch', name: 'Atlanta Patch', domains: ['patch.com'] }];
    assert.equal(P.matchOutlet(outlets, { url: 'https://www.ajc.com/x' })?.slug, 'ajc');
    assert.equal(P.matchOutlet(outlets, { name: 'Atlanta Patch', url: 'https://patch.com/georgia/atlanta/x' })?.slug, 'atlanta-patch');
    assert.equal(P.matchOutlet(outlets, { name: 'The Atlanta Journal-Constitution' })?.slug, 'ajc');
    assert.equal(P.matchOutlet(outlets, { name: 'Nobody', url: 'https://news.google.com/x' }), null);
  });
});

describe('press-shared on the real press list', { skip: !haveReal && 'src/content not synced' }, () => {
  test('every story ends up with one outlet; spellings fold together', () => {
    const plan = P.planOutletTidy(REAL.press, REAL.medialogos);
    const after = new Map(REAL.press.map((s) => [s.slug, s.outletLogo]));
    for (const c of plan.stories) after.set(c.slug, c.outletLogo);
    const known = new Set([...REAL.medialogos.map((o) => o.slug), ...plan.create.map((o) => o.slug)]);
    for (const s of REAL.press) assert.ok(known.has(after.get(s.slug)), `${s.slug} → ${after.get(s.slug)}`);
    const wsb = REAL.press.filter((s) => /^WSB-TV/.test(s.outlet)).map((s) => after.get(s.slug));
    assert.equal(new Set(wsb).size, 1, 'WSB-TV and WSB-TV (ABC Atlanta) are one outlet');
    assert.ok(plan.update.find((o) => o.slug === 'today-show')?.domains?.includes('today.com'));
    assert.ok(!plan.create.some((o) => /today/i.test(o.name) && P.outletKey(o.name) === 'todayshow'));
  });
  test('the duplicates are found, and the hand-entered copy is kept', (t) => {
    if (!REAL_DUPES.length) return t.skip('no duplicates in this copy of the content (they live in D1)');
    const groups = REAL_DUPES;
    assert.ok(groups.length >= 6, `found ${groups.length}`);
    for (const g of groups) {
      const keep = P.pickKeeper(g.map((s) => REAL.press.find((x) => x.slug === s)));
      assert.ok(!P.googleLink(keep.url), `${keep.slug} keeps a real link`);
    }
  });
});

// ── Readers, on pages captured from the real sites ───────────────────
describe('sources and pages (real captures)', () => {
  test('Google News RSS', () => {
    const items = parseGoogleRss(FIX('google-rss.xml'), 'q');
    assert.ok(items.length >= 10);
    assert.ok(items.every((i) => i.id.startsWith('g:') && i.link.includes('news.google.com') && !i.url));
    assert.ok(items.every((i) => !i.title.endsWith(` - ${i.source}`)), 'the outlet name comes off the headline');
  });
  test('Google’s link decodes to the outlet’s own', async () => {
    const id = FIX('google-first-id.txt').trim();
    const fetchImpl = async (u) => (u.includes('/rss/articles/') ? new Response(FIX('google-article.html')) : u.includes('batchexecute') ? new Response(FIX('google-batchexecute.txt')) : new Response('', { status: 404 }));
    const url = await decodeGoogleLink(`https://news.google.com/rss/articles/${id}?oc=5`, { fetchImpl });
    assert.match(url, /^https:\/\/www\.11alive\.com\/article\//);
    assert.equal(await decodeGoogleLink('https://example.com/x', { fetchImpl }), null);
  });
  test('Bing News RSS gives real addresses', () => {
    const items = parseBingRss(FIX('bing-rss.xml'), 'q');
    assert.ok(items.length >= 3);
    assert.ok(items.every((i) => /^https?:\/\//.test(i.url) && !/bing\.com/.test(i.url)));
  });
  test('YouTube: a channel feed keeps only SOARD videos; search leaves out SOARD’s own channel', () => {
    assert.equal(parseYouTubeFeed(FIX('youtube-feed.xml'), { name: 'TODAY', id: 'x' }).length, 0);
    const feed = `<feed><entry><yt:videoId>abcdefghijk</yt:videoId><title>Sunshine on a Ranney Day builds a room</title><author><name>11Alive</name></author><published>2026-10-01T10:00:00Z</published><media:group><media:description>x</media:description></media:group></entry><entry><yt:videoId>zzzzzzzzzzz</yt:videoId><title>Traffic</title></entry></feed>`;
    const hits = parseYouTubeFeed(feed, { name: '11Alive', id: 'x' });
    assert.deepEqual(hits.map((h) => h.videoId), ['abcdefghijk']);
    assert.equal(hits[0].source, '11Alive');
    const search = parseYouTubeSearch(FIX('youtube-search.html'), 'q');
    assert.ok(search.length >= 2);
    assert.ok(search.every((v) => !/^Sunshine on a Ranney Day/i.test(v.source)));
  });
  test('an article page: headline, outlet, date, picture, words', () => {
    const p = parsePage(FIX('article-fox5.html'), 'https://www.fox5atlanta.com/news/hawks-plan-surprise-for-local-teen-paralyzed-in-car-accident');
    assert.equal(p.title, 'Hawks plan surprise for local teen paralyzed in car accident');
    assert.equal(p.siteName, 'FOX 5 Atlanta');
    assert.match(p.published, /^2016-11-0/);
    assert.match(p.image, /^https:\/\/images\.foxtv\.com\//);
    assert.ok(p.text.includes('Kalen'));
  });
  test('link check: gone, moved, blocked, fine', async () => {
    const mk = (status, url) => async () => withUrl(new Response('x', { status }), url || 'https://a.com/story/1');
    assert.equal((await checkLink('https://a.com/story/1', { fetchImpl: mk(404) })).status, 'gone');
    assert.equal((await checkLink('https://a.com/story/1', { fetchImpl: mk(403) })).status, 'blocked');
    assert.equal((await checkLink('https://a.com/story/1', { fetchImpl: mk(200, 'https://a.com/') })).status, 'moved');
    assert.equal((await checkLink('https://a.com/story/1', { fetchImpl: mk(200) })).status, 'ok');
    assert.equal((await checkLink('http://127.0.0.1/x', { fetchImpl: mk(200) })).status, 'gone', 'never a private address');
  });
});

// ── The engine, against a made-up world ──────────────────────────────
let world;
const freshWorld = () => ({
  google: [], bing: [], youtube: {}, decode: {}, pages: {}, archive: {}, archivePages: {}, images: 0, deploys: 0, slack: [], saved: [], ai: null, calls: [],
});
const HOOK = 'https://api.cloudflare.com/client/v4/pages/webhooks/deploy_hooks/test';
const SLACK = 'https://hooks.slack.com/services/test';
const rss = (items) => `<rss><channel>${items.map((i) => `<item><title>${i.title} - ${i.source}</title><link>https://news.google.com/rss/articles/${i.id}?oc=5</link><pubDate>${i.date}</pubDate><source url="${i.sourceUrl || ''}">${i.source}</source></item>`).join('')}</channel></rss>`;
const article = ({ title, site, date, image, text, video }) => `<html><head><title>${title}</title><meta property="og:title" content="${title}"><meta property="og:site_name" content="${site}"><meta property="article:published_time" content="${date}">${image ? `<meta property="og:image" content="${image}">` : ''}<meta name="description" content="${text.slice(0, 120)}"></head><body><article>${text.split('\n').map((p) => `<p>${p}</p>`).join('')}${video ? `<iframe src="https://www.youtube.com/embed/${video}"></iframe>` : ''}</article></body></html>`;
async function fakeFetch(input, init = {}) {
  const url = typeof input === 'string' ? input : input.url;
  world.calls.push(url);
  const u = new URL(url);
  const html = (body, status = 200) => withUrl(new Response(body, { status, headers: { 'content-type': 'text/html' } }), url);
  if (url === HOOK) { world.deploys++; return Response.json({ result: { id: `dep${world.deploys}` } }); }
  if (url === SLACK) { world.slack.push(String(init.body)); return new Response('ok'); }
  if (u.hostname === 'news.google.com' && u.pathname === '/rss/search') return new Response(rss(world.google));
  if (u.hostname === 'news.google.com' && u.pathname.startsWith('/rss/articles/')) { const id = u.pathname.split('/').pop(); return html(`<div data-n-a-id="${id}" data-n-a-ts="1" data-n-a-sg="sig-${id}"></div>`); }
  if (u.hostname === 'news.google.com' && u.pathname.includes('batchexecute')) {
    const req = JSON.parse(decodeURIComponent(String(init.body).slice(6)));
    const id = JSON.parse(req[0][0][1])[2];
    const real = world.decode[id];
    return new Response(real ? `)]}'\n\n${JSON.stringify([['wrb.fr', 'Fbv4je', JSON.stringify(['garturlres', real, 1])]])}` : ')]}\'\n\n[]');
  }
  if (u.hostname === 'www.bing.com') return new Response(`<rss><channel>${world.bing.map((b) => `<item><title>${b.title}</title><link>http://www.bing.com/news/apiclick.aspx?url=${encodeURIComponent(b.url)}&amp;c=1</link><News:Source>${b.source}</News:Source><pubDate>${b.date}</pubDate></item>`).join('')}</channel></rss>`);
  if (u.hostname === 'www.youtube.com' && u.pathname === '/feeds/videos.xml') return new Response(world.youtube[u.searchParams.get('channel_id')] || '<feed></feed>');
  if (u.hostname === 'www.youtube.com' && u.pathname === '/results') return html('<html></html>');
  if (u.hostname === 'archive.org' && u.pathname === '/wayback/available') {
    const snap = world.archive[u.searchParams.get('url')];
    return Response.json({ archived_snapshots: snap ? { closest: { available: true, status: '200', url: snap } } : {} });
  }
  if (u.hostname === 'web.archive.org' && u.pathname.startsWith('/save/')) { world.saved.push(url.slice(url.indexOf('/save/') + 6)); return new Response('ok'); }
  if (u.hostname === 'web.archive.org') { const p = world.archivePages[url]; return p ? html(p) : html('', 404); }
  if (u.hostname === 'api.cloudflare.com' && u.pathname.endsWith('/images/v1')) { world.images++; return Response.json({ success: true, result: { id: init.body.get('id') || `img${world.images}` } }); }
  if (/\.(jpe?g|png)(\?|$)/.test(u.pathname)) return new Response(new Uint8Array(20000), { headers: { 'content-type': 'image/jpeg' } });
  const page = world.pages[url];
  if (page === undefined) return html('not here', 404);
  if (typeof page === 'number') return html('', page);
  return html(page);
}
globalThis.fetch = fakeFetch;
const fakeAi = { run: async (model, { messages }) => {
  const prompt = messages[0].content;
  if (world.ai) return { response: JSON.stringify(world.ai(prompt)) };
  const kids = [...prompt.matchAll(/^- ([a-z0-9-]+): .*room built/gm)].map((m) => m[1]);
  const partners = [...prompt.split('SOARD partners named')[1]?.matchAll(/^- ([a-z0-9-]+):/gm) || []].map((m) => m[1]);
  const text = prompt.split('"""')[1] || '';
  return { response: JSON.stringify({ about: /Sunshine on a Ranney Day|SOARD/.test(text) ? 'about' : 'unrelated', summary: 'A family in Roswell got a new accessible bedroom built by Sunshine on a Ranney Day.', category: 'local-tv', kids, partners }) };
} };

async function seed(DB, { press = REAL.press, medialogos = REAL.medialogos, kids = REAL.kids, partners = REAL.partners } = {}) {
  const put = async (table, list) => {
    for (const r of list) {
      const data = { ...r };
      // As the real files are: press stories without a slug field, the rest with one
      if (table === 'press') delete data.slug;
      const [cols, vals] = EXTRACTORS[table](data);
      const all = ['"slug"', '"data"', '"updated_at"', ...cols];
      await DB.prepare(`INSERT OR REPLACE INTO ${table} (${all.join(', ')}) VALUES (${all.map(() => '?').join(', ')})`).bind(r.slug, JSON.stringify(data), '2026-10-01T00:00:00Z', ...vals).run();
    }
  };
  await put('press', press);
  await put('medialogos', medialogos);
  await put('kids', kids);
  await put('partners', partners);
}
async function newEnv(opts) {
  E._resetTablesForTests();
  const DB = await createD1({ schemaFiles: [`${ROOT}scripts/schema.sql`] });
  await seed(DB, opts);
  return { DB, AI: fakeAi, CF_ACCOUNT_ID: 'acct', CF_IMAGES_TOKEN: 'tok', CF_PAGES_DEPLOY_HOOK: HOOK, SLACK_WEBHOOK_URL: SLACK };
}
const rows = async (DB, sql, ...b) => (await DB.prepare(sql).bind(...b).all()).results;
const story = async (DB, slug) => { const r = await DB.prepare('SELECT data FROM press WHERE slug = ?').bind(slug).first(); return r ? JSON.parse(r.data) : null; };
/** Run beats until nothing is due (or `until` says stop) */
async function beats(env, { now = NOW, max = 400, until = null } = {}) {
  let n = 0;
  for (; n < max; n++) {
    const r = await E.maybeRunPress(env, { now: now + n * 1000, budgetMs: 60000, archiveGapMs: 0 });
    if (until && (await until())) break;
    if (r === null) break;
  }
  return n;
}
const doneTidy = async (env) => { const s = await E.readState(env.DB); return { ...s.tidy, version: E.TIDY_VERSION, phase: 'done' }; };
const quietState = async (env, extra = {}) => {
  const s = await E.readState(env.DB);
  const at = new Date(NOW).toISOString();
  s.tidy = await doneTidy(env);
  s.scans = { google: { at }, bing: { at }, youtube: { at } };
  s.sweep = { doneAt: at };
  Object.assign(s, extra);
  await env.DB.prepare('INSERT OR REPLACE INTO site_config (key, data, updated_at) VALUES (?, ?, ?)').bind(E.STATE_KEY, JSON.stringify(s), at).run();
};

describe('press monitor: finding and filing', () => {
  beforeEach(() => { world = freshWorld(); });

  test('a clear story from Google News is read, judged, pictured and filed, then the site publishes itself', async () => {
    const env = await newEnv({ press: [], medialogos: REAL.medialogos.length ? REAL.medialogos : [{ slug: 'wsb-tv', name: 'WSB-TV', logo: 'x', order: 1 }], kids: [{ slug: 'maya', name: 'Maya', year: 2026 }], partners: [{ slug: 'top-knobs', name: 'Top Knobs' }] });
    await quietState(env);
    const s = await E.readState(env.DB);
    s.scans.google.at = new Date(NOW - 4 * 3600e3).toISOString();
    await env.DB.prepare('UPDATE site_config SET data = ? WHERE key = ?').bind(JSON.stringify(s), E.STATE_KEY).run();
    world.google = [{ id: 'AAA', title: 'Maya gets a dream bedroom', source: 'WSB-TV', date: 'Mon, 12 Oct 2026 10:00:00 GMT', sourceUrl: 'https://www.wsbtv.com' }];
    world.decode.AAA = 'https://www.wsbtv.com/news/local/maya-dream-bedroom/abc';
    world.pages['https://www.wsbtv.com/news/local/maya-dream-bedroom/abc'] = article({ title: 'Maya gets a dream bedroom', site: 'WSB-TV', date: '2026-10-12T10:00:00Z', image: 'https://cdn.wsbtv.com/maya.jpg', text: 'Sunshine on a Ranney Day built Maya a new room in Roswell.\nTop Knobs donated the hardware for Maya and her family, and SOARD founder Holly Ranney led the build.' });
    await beats(env, { max: 20 });
    const filed = await rows(env.DB, "SELECT * FROM press_mentions WHERE state = 'filed'");
    assert.equal(filed.length, 1, JSON.stringify(await rows(env.DB, 'SELECT id, state, stage, reason FROM press_mentions')));
    const st = await story(env.DB, filed[0].story);
    assert.equal(st.url, 'https://www.wsbtv.com/news/local/maya-dream-bedroom/abc');
    assert.equal(st.outletLogo, P.matchOutlet((await rows(env.DB, 'SELECT data FROM medialogos')).map((r) => JSON.parse(r.data)), { name: 'WSB-TV' })?.slug || st.outletLogo);
    assert.equal(st.date, '2026-10-12');
    assert.match(st.image, /^press\//);
    assert.deepEqual(st.kids, ['maya']);
    assert.deepEqual(st.partners, ['top-knobs']);
    assert.match(st.excerpt, /accessible bedroom/);
    assert.ok(world.saved.some((u) => u.includes('maya-dream-bedroom')), 'asked the Internet Archive to keep a copy');
    assert.ok(world.slack.some((t) => /New coverage/.test(t) && /Maya gets a dream bedroom/.test(t)));
    assert.equal(world.deploys, 1, 'published itself');
    const log = await rows(env.DB, "SELECT * FROM press_log WHERE kind = 'filed'");
    assert.equal(log.length, 1);
    const audit = await rows(env.DB, "SELECT * FROM audit_log WHERE entity_type = 'press'");
    assert.equal(audit.length, 1, 'Publish lists it');
    // Found again by Bing: a duplicate, not a second story
    world.bing = [{ title: 'Maya gets a dream bedroom', url: 'https://www.wsbtv.com/news/local/maya-dream-bedroom/abc', source: 'WSB-TV', date: 'Mon, 12 Oct 2026 11:00:00 GMT' }];
    const s2 = await E.readState(env.DB);
    s2.scans.bing.at = new Date(NOW - 4 * 3600e3).toISOString();
    await env.DB.prepare('UPDATE site_config SET data = ? WHERE key = ?').bind(JSON.stringify(s2), E.STATE_KEY).run();
    await beats(env, { now: NOW + 3600e3, max: 10 });
    assert.equal((await rows(env.DB, 'SELECT slug FROM press')).length, 1);
    assert.equal((await rows(env.DB, "SELECT * FROM press_mentions WHERE state = 'duplicate'")).length, 1);
  });

  test('a passing mention waits for a person; Add files it; a copy on MSN and a listing never file themselves', async () => {
    const env = await newEnv({ press: [], medialogos: [{ slug: 'ajc', name: 'Atlanta Journal-Constitution', logo: 'x', order: 0, domains: ['ajc.com'] }], kids: [], partners: [] });
    await quietState(env);
    world.ai = () => ({ about: 'mentions', summary: 'A list of local charities.', category: 'print', kids: [], partners: [] });
    const now = new Date(NOW).toISOString();
    for (const [id, url, title, source] of [
      ['b:1', 'https://www.ajc.com/life/ten-charities/x', 'Ten charities to know', 'AJC'],
      ['b:2', 'https://www.msn.com/en-us/news/soard-room/ar-1', 'Sunshine on a Ranney Day builds a room', 'MSN'],
      ['b:3', 'https://projects.propublica.org/nonprofits/organizations/454773997', 'Sunshine On A Ranney Day Incorporated', 'ProPublica'],
    ]) await env.DB.prepare("INSERT INTO press_mentions (id, key, provider, url, link, title, source, state, stage, found_at) VALUES (?, ?, 'bing', ?, ?, ?, ?, 'new', 'match', ?)").bind(id, P.urlKey(url), url, url, title, source, now).run();
    world.pages['https://www.ajc.com/life/ten-charities/x'] = article({ title: 'Ten charities to know', site: 'The Atlanta Journal-Constitution', date: '2026-10-10', text: 'Ten groups doing good work. One is Sunshine on a Ranney Day in Roswell.' });
    world.pages['https://www.msn.com/en-us/news/soard-room/ar-1'] = article({ title: 'Sunshine on a Ranney Day builds a room', site: 'MSN', date: '2026-10-10', text: 'Sunshine on a Ranney Day built a room. SOARD founder Holly Ranney said so.' });
    world.ai = (p) => (/MSN/.test(p) ? { about: 'about', summary: 'x', category: 'print', kids: [], partners: [] } : { about: 'mentions', summary: 'A list of local charities.', category: 'print', kids: [], partners: [] });
    await beats(env, { max: 10 });
    const st = Object.fromEntries((await rows(env.DB, 'SELECT id, state, reason FROM press_mentions')).map((r) => [r.id, r]));
    assert.equal(st['b:1'].state, 'review');
    assert.match(st['b:1'].reason, /in passing/);
    assert.equal(st['b:2'].state, 'review');
    assert.match(st['b:2'].reason, /copy on MSN/);
    assert.equal(st['b:3'].state, 'unrelated');
    assert.equal((await rows(env.DB, 'SELECT slug FROM press')).length, 0);
    assert.equal(world.slack.filter((t) => /Needs a look/.test(t)).length, 2, 'one Slack post per article that needs a look');
    const r = await E.addMention(env, 'b:1', 'peter@example.com');
    assert.ok(r.success, r.error);
    const s = await story(env.DB, r.slug);
    assert.equal(s.outletLogo, 'ajc', 'matched by website');
    assert.equal(s.outlet, 'Atlanta Journal-Constitution');
    const m = await env.DB.prepare("SELECT state, decided_by FROM press_mentions WHERE id = 'b:1'").first();
    assert.equal(m.state, 'filed');
    assert.equal(m.decided_by, 'peter@example.com');
    // Skip and restore
    assert.ok((await E.decideMention(env, 'b:2', 'skip', 'peter@example.com')).success);
    assert.equal((await env.DB.prepare("SELECT state FROM press_mentions WHERE id = 'b:2'").first()).state, 'dismissed');
    assert.ok((await E.decideMention(env, 'b:2', 'restore', 'peter@example.com')).success);
    assert.equal((await env.DB.prepare("SELECT state FROM press_mentions WHERE id = 'b:2'").first()).state, 'review');
  });

  test('a TV station’s YouTube upload naming SOARD is filed with its video', async () => {
    const env = await newEnv({ press: [], medialogos: [{ slug: '11alive', name: '11Alive', logo: 'x', order: 0 }], kids: [], partners: [] });
    await quietState(env);
    const s = await E.readState(env.DB);
    s.scans.youtube.at = new Date(NOW - 7 * 3600e3).toISOString();
    await env.DB.prepare('UPDATE site_config SET data = ? WHERE key = ?').bind(JSON.stringify(s), E.STATE_KEY).run();
    world.youtube.UCzF4Ryn8TKn64md77gS5Q5Q = `<feed><entry><yt:videoId>Vid11111111</yt:videoId><title>Sunshine on a Ranney Day surprises a family</title><author><name>11Alive</name></author><published>2026-10-15T10:00:00Z</published><media:description>Watch the reveal.</media:description></entry></feed>`;
    world.pages['https://www.youtube.com/watch?v=Vid11111111'] = article({ title: 'Sunshine on a Ranney Day surprises a family', site: 'YouTube', date: '2026-10-15', text: 'Sunshine on a Ranney Day surprises a family in Marietta with a new room. SOARD built it.' }).replace('<meta property="og:site_name" content="YouTube">', '<link itemprop="name" content="11Alive">');
    await beats(env, { max: 10 });
    const [st] = (await rows(env.DB, 'SELECT data FROM press')).map((r) => JSON.parse(r.data));
    assert.ok(st, JSON.stringify(await rows(env.DB, 'SELECT id, state, reason FROM press_mentions')));
    assert.equal(st.videoId, 'Vid11111111');
    assert.equal(st.outletLogo, '11alive');
  });
});

describe('press monitor: what a real run taught it', () => {
  beforeEach(() => { world = freshWorld(); });
  test('obituaries never wait for a person', async () => {
    const env = await newEnv({ press: [], medialogos: [], kids: [], partners: [] });
    await quietState(env);
    await env.DB.prepare("INSERT INTO press_mentions (id, key, provider, url, link, title, source, state, stage, found_at) VALUES ('g:obit', 'x', 'google', 'https://www.legacy.com/us/obituaries/x', 'https://www.legacy.com/us/obituaries/x', 'Peter Ranney Obituary (2026)', 'Legacy', 'new', 'match', ?)").bind(new Date(NOW).toISOString()).run();
    await beats(env, { max: 3 });
    const m = await env.DB.prepare("SELECT state, reason FROM press_mentions WHERE id = 'g:obit'").first();
    assert.equal(m.state, 'unrelated');
    assert.equal(m.reason, 'An obituary');
    assert.equal(world.slack.length, 0, 'and Slack isn’t bothered');
  });
  test('a kid named like a place is linked only when Workers AI agrees and the name comes up twice', async () => {
    const env = await newEnv({ press: [], medialogos: [{ slug: 'wsb-tv', name: 'WSB-TV', logo: 'x', order: 0, domains: ['wsbtv.com'] }], kids: [{ slug: 'georgia', name: 'Georgia', year: 2026 }, { slug: 'devon', name: 'Devon', year: 2026 }], partners: [] });
    await quietState(env);
    const url = 'https://www.wsbtv.com/news/devon-home';
    world.pages[url] = article({ title: 'Devon moves into a new home', site: 'WSB-TV', date: '2026-10-10', text: 'Sunshine on a Ranney Day built Devon a home in Georgia.\nDevon thanked SOARD.' });
    world.ai = (prompt) => ({ about: 'about', summary: 'Devon got a new home.', category: 'local-tv', kids: [...prompt.matchAll(/^- ([a-z0-9-]+): .*room built/gm)].map((m) => m[1]), partners: [] });
    await env.DB.prepare("INSERT INTO press_mentions (id, key, provider, url, link, title, source, state, stage, found_at) VALUES ('b:dev', ?, 'bing', ?, ?, 'Devon moves into a new home', 'WSB-TV', 'new', 'match', ?)").bind(P.urlKey(url), url, url, new Date(NOW).toISOString()).run();
    await beats(env, { max: 6 });
    const [st] = (await rows(env.DB, 'SELECT data FROM press')).map((r) => JSON.parse(r.data));
    assert.deepEqual(st.kids, ['devon'], 'Georgia (the state, once) isn’t linked even though Workers AI said so');
  });
  test('a TV station’s YouTube video is filed under the station, not “YouTube”', async () => {
    const env = await newEnv({ press: [], medialogos: [{ slug: 'wsb-tv', name: 'WSB-TV', logo: 'x', order: 0 }], kids: [], partners: [] });
    await quietState(env);
    const url = 'https://www.youtube.com/watch?v=WsbVideo001';
    world.pages[url] = article({ title: 'Sunshine on a Ranney Day brings teen’s dream space to life', site: 'YouTube', date: '2026-10-01', text: 'Sunshine on a Ranney Day built a room. SOARD did it again.' });
    await env.DB.prepare("INSERT INTO press_mentions (id, key, provider, url, link, title, source, video_id, query, state, stage, found_at) VALUES ('y:w', ?, 'youtube', ?, ?, 'Sunshine on a Ranney Day brings teen’s dream space to life', 'WSB-TV', 'WsbVideo001', 'q', 'new', 'match', ?)").bind(P.urlKey(url), url, url, new Date(NOW).toISOString()).run();
    // A watched station with no outlet record yet still counts as news
    const url2 = 'https://www.youtube.com/watch?v=NewStation1';
    world.pages[url2] = article({ title: 'Sunshine on a Ranney Day surprises a family', site: 'YouTube', date: '2026-10-02', text: 'Sunshine on a Ranney Day surprised a family. SOARD built the room.' });
    await env.DB.prepare("INSERT INTO press_mentions (id, key, provider, url, link, title, source, video_id, query, state, stage, found_at) VALUES ('y:n', ?, 'youtube', ?, ?, 'Sunshine on a Ranney Day surprises a family', 'WRDW News 12', 'NewStation1', 'channel:UCxxxxxxxxxxxxxxxxxxxxxx', 'new', 'match', ?)").bind(P.urlKey(url2), url2, url2, new Date(NOW).toISOString()).run();
    await beats(env, { max: 8 });
    const stories = (await rows(env.DB, 'SELECT data FROM press')).map((r) => JSON.parse(r.data));
    const wsb = stories.find((x) => x.videoId === 'WsbVideo001');
    assert.equal(wsb?.outletLogo, 'wsb-tv');
    const wrdw = stories.find((x) => x.videoId === 'NewStation1');
    assert.equal(wrdw?.outlet, 'WRDW News 12');
    assert.ok(!(await rows(env.DB, "SELECT slug FROM medialogos WHERE name = 'YouTube'")).length, 'no outlet called YouTube');
  });
  test('searches go one at a time, two per beat (a Worker run holds six connections, shared with the other jobs)', async () => {
    const env = await newEnv({ press: [], medialogos: [], kids: [], partners: [] });
    await quietState(env);
    const s0 = await E.readState(env.DB);
    s0.scans.google = {};
    await env.DB.prepare('UPDATE site_config SET data = ? WHERE key = ?').bind(JSON.stringify(s0), E.STATE_KEY).run();
    let inFlight = 0;
    let most = 0;
    let calls = 0;
    const slow = async (u, o) => { calls++; inFlight++; most = Math.max(most, inFlight); await new Promise((r) => setTimeout(r, 5)); inFlight--; return fakeFetch(u, o); };
    const r1 = await E.maybeRunPress(env, { now: NOW, budgetMs: 1, fetchImpl: slow });
    assert.match(r1.join(' '), /scan google: 2 of 6 searches/);
    assert.equal(calls, 2);
    const mid = (await E.readState(env.DB)).scans.google;
    assert.equal(mid.cursor, 2);
    await E.maybeRunPress(env, { now: NOW + 60e3, budgetMs: 1, fetchImpl: slow });
    const r3 = await E.maybeRunPress(env, { now: NOW + 120e3, budgetMs: 1, fetchImpl: slow });
    assert.match(r3.join(' '), /scan google: \d+ found/);
    const done = (await E.readState(env.DB)).scans.google;
    assert.ok(done.at && done.cursor == null, JSON.stringify(done));
    assert.equal(most, 1, 'never two at once');
    // A source that failed outright is tried again in half an hour
    const s1 = await E.readState(env.DB);
    s1.scans.google = { at: new Date(NOW).toISOString(), found: 0, added: 0, error: 'Google News: timed out' };
    s1.scans.bing = { at: new Date(NOW).toISOString() };
    s1.scans.youtube = { at: new Date(NOW).toISOString() };
    await env.DB.prepare('UPDATE site_config SET data = ? WHERE key = ?').bind(JSON.stringify(s1), E.STATE_KEY).run();
    assert.equal(await E.maybeRunPress(env, { now: NOW + 10 * 60e3, budgetMs: 1, fetchImpl: slow }), null, 'not yet');
    const again = await E.maybeRunPress(env, { now: NOW + 31 * 60e3, budgetMs: 1, fetchImpl: slow });
    assert.match(again.join(' '), /scan google/);
  });
  test('YouTube search dates: "9mo ago", "8y ago", "3 weeks ago"', () => {
    const now = Date.parse('2026-10-21T00:00:00Z');
    assert.equal(relativeDate('9mo ago', now).slice(0, 7), '2026-01');
    assert.equal(relativeDate('8y ago', now).slice(0, 4), '2018');
    assert.equal(relativeDate('Streamed 3 weeks ago', now).slice(0, 10), '2026-09-30');
    assert.equal(relativeDate('Premiered Oct 3', now), null);
    assert.ok(parseYouTubeSearch(FIX('youtube-search.html'), 'q').every((v) => v.published), 'every search result gets a date');
  });
  test('a story with no date at all waits for a person, and a guessed date is put right when the real one turns up', async () => {
    const env = await newEnv({ press: [], medialogos: [{ slug: 'wsb-tv', name: 'WSB-TV', logo: 'x', order: 0 }], kids: [], partners: [] });
    await quietState(env);
    const url = 'https://www.youtube.com/watch?v=NoDateVid01';
    world.pages[url] = 403; // what YouTube says to Cloudflare's servers
    await env.DB.prepare("INSERT INTO press_mentions (id, key, provider, url, link, title, source, video_id, query, state, stage, found_at) VALUES ('y:nd', ?, 'youtube', ?, ?, 'Sunshine on a Ranney Day brings teen’s dream space to life', 'WSB-TV', 'NoDateVid01', 'q', 'new', 'match', ?)").bind(P.urlKey(url), url, url, new Date(NOW).toISOString()).run();
    await beats(env, { max: 6 });
    const m = await env.DB.prepare("SELECT state, reason FROM press_mentions WHERE id = 'y:nd'").first();
    assert.equal(m.state, 'review', 'not filed with today’s date');
    assert.match(m.reason, /No date|wouldn’t show/);
    assert.equal((await rows(env.DB, "SELECT slug FROM press WHERE data LIKE '%NoDateVid01%'")).length, 0);
    // One filed before this rule, with the day it was found as its date
    const filedDay = new Date(NOW).toISOString().slice(0, 10);
    const st = { outlet: 'WSB-TV', outletLogo: 'wsb-tv', category: 'local-tv', title: 'A teen’s dream space', date: filedDay, url: 'https://www.youtube.com/watch?v=Guessed0001', excerpt: 'x', image: null, featured: false, order: 0, videoId: 'Guessed0001' };
    await E.writeRecord(env, 'press', 'wsb-tv-guess', null, st);
    await env.DB.prepare("INSERT INTO press_log (at, kind, slug, label) VALUES (?, 'filed', 'wsb-tv-guess', 'Added')").bind(new Date(NOW).toISOString()).run();
    await env.DB.prepare("INSERT INTO press_mentions (id, key, provider, url, title, source, state, story, found_at) VALUES ('y:g', 'k', 'youtube', ?, 'A teen’s dream space', 'WSB-TV', 'filed', 'wsb-tv-guess', ?)").bind(st.url, new Date(NOW).toISOString()).run();
    assert.equal(await E.fixGuessedDates(env), 0, 'nothing to go on yet');
    await env.DB.prepare("UPDATE press_mentions SET published = '2025-12-15T00:00:00Z' WHERE id = 'y:g'").run();
    assert.equal(await E.fixGuessedDates(env), 1);
    assert.equal((await story(env.DB, 'wsb-tv-guess')).date, '2025-12-15');
    assert.equal(await E.fixGuessedDates(env), 0, 'once');
  });
  test('the Internet Archive is asked one thing at a time, and left alone for an hour after a 429', async () => {
    const state = {};
    let calls = 0;
    const fetchImpl = async () => { calls++; return new Response('slow down', { status: 429 }); };
    const gate = E.archiveGate(state, 20000);
    assert.ok((await gate.lookup('https://a.com/x', '2020-01-01', fetchImpl)).limited);
    assert.ok((await gate.lookup('https://a.com/y', '2020-01-01', fetchImpl)).skipped, 'paused');
    assert.equal(calls, 1);
    assert.ok(Date.parse(state.archiveNextAt) - Date.now() > 50 * 60e3, 'for about an hour');
  });
  test('the same video on two stories is the outlet’s own player, so neither is offered it', async () => {
    const a = { slug: 'fc-a', outlet: 'Floor Covering News', outletLogo: '', category: 'print', title: 'Mohawk helps one', date: '2020-01-01', url: 'https://www.fcnews.net/a', excerpt: 'x', image: null, featured: false, order: 0 };
    const b = { ...a, slug: 'fc-b', title: 'Mohawk helps two', url: 'https://www.fcnews.net/b' };
    const env = await newEnv({ press: [a, b], medialogos: [], kids: [], partners: [] });
    await E.ensurePressTables(env.DB);
    for (const st of [a, b]) world.pages[st.url] = article({ title: st.title, site: 'FCNews', date: st.date, text: 'Sunshine on a Ranney Day and Mohawk.', video: 'qbgdQfq9zvM' });
    for (const st of [a, b]) for (let i = 0; i < 6; i++) await E.storyStep(env, st.slug);
    const links = (await rows(env.DB, 'SELECT data FROM press_links')).map((r) => JSON.parse(r.data));
    assert.ok(links.every((d) => !d.suggestVideo), JSON.stringify(links));
  });
});

describe('press monitor: the tidy, on the real press list', { skip: !haveReal && 'src/content not synced' }, () => {
  let env;
  before(async () => {
    world = freshWorld();
    env = await newEnv();
    const s = await E.readState(env.DB);
    const at = new Date(NOW).toISOString();
    s.scans = { google: { at }, bing: { at }, youtube: { at } };
    await env.DB.prepare('INSERT OR REPLACE INTO site_config (key, data, updated_at) VALUES (?, ?, ?)').bind(E.STATE_KEY, JSON.stringify(s), at).run();
    // Every story's page answers with a picture and its own headline; a few are gone
    for (const st of REAL.press) {
      if (!st.url || P.googleLink(st.url)) continue;
      world.pages[st.url] = article({ title: P.storyTitle(st), site: st.outlet, date: `${st.date}T12:00:00Z`, image: `https://cdn.example.com/${st.slug}.jpg`, text: `${P.storyTitle(st)}.\nSunshine on a Ranney Day helped a family.` });
    }
    for (const st of REAL.press.filter((x) => P.googleLink(x.url))) world.decode[st.url.match(/articles\/([^?]+)/)[1]] = `https://decoded.example.com/${st.slug}`;
    const gone = REAL.press.find((s) => s.slug === 'braves-community-heroes-2018') || REAL.press.find((s) => s.url && !P.googleLink(s.url));
    world.pages[gone.url] = 404;
    world.archive[gone.url] = `https://web.archive.org/web/20181001000000/${gone.url}`;
    world.archivePages[`https://web.archive.org/web/20181001000000id_/${gone.url}`] = article({ title: P.storyTitle(gone), site: gone.outlet, date: gone.date, image: 'https://cdn.example.com/archived.jpg', text: 'From the archive. Sunshine on a Ranney Day.' });
    env.gone = gone;
    await beats(env, { max: 2000, until: async () => (await E.readState(env.DB)).tidy?.version === E.TIDY_VERSION });
  });

  test('the tidy finishes and tells Slack once', async () => {
    const s = await E.readState(env.DB);
    assert.equal(s.tidy.version, E.TIDY_VERSION);
    assert.equal(world.slack.filter((t) => /Press list tidied/.test(t)).length, 1);
    assert.ok(s.deployPending || world.deploys >= 1);
  });
  test('every story is linked to an outlet record and shows its name', async () => {
    const outlets = new Map((await rows(env.DB, 'SELECT slug, data FROM medialogos')).map((r) => [r.slug, JSON.parse(r.data)]));
    const stories = (await rows(env.DB, 'SELECT slug, data FROM press')).map((r) => ({ slug: r.slug, ...JSON.parse(r.data) }));
    for (const st of stories) {
      assert.ok(outlets.has(st.outletLogo), `${st.slug}: ${st.outletLogo}`);
      assert.equal(st.outlet, outlets.get(st.outletLogo).name, st.slug);
    }
    for (const [slug, o] of outlets) assert.equal(o.slug, slug, `outlet ${slug} carries its slug (the site's content schema needs it)`);
    assert.ok(![...outlets.values()].some((o) => o.name === 'TODAY.com'), 'TODAY.com joins Today Show (its Google link is decoded before outlets are sorted)');
    const created = [...outlets.values()].filter((o) => o.strip === false);
    assert.ok(created.length > 20 && created.every((o) => !o.logo), 'new outlets have no logo and stay out of the strip');
  });
  test('duplicates are merged and recoverable; Google links, headlines and summaries are repaired', async () => {
    const stories = (await rows(env.DB, 'SELECT slug, data FROM press')).map((r) => ({ slug: r.slug, ...JSON.parse(r.data) }));
    assert.equal(stories.length, REAL.press.length - REAL_REMOVED, `${REAL.press.length} → ${stories.length}`);
    assert.equal(P.duplicateGroups(stories).length, 0);
    assert.equal(stories.filter((s) => P.googleLink(s.url)).length, 0, 'no Google News links left');
    assert.equal(stories.filter((s) => P.storyTitle(s) !== s.title).length, 0, 'no outlet names on headlines');
    assert.equal(stories.filter((s) => P.hasMarkup(s.excerpt)).length, 0, 'no web code in summaries');
    const deleted = await rows(env.DB, "SELECT slug FROM content_versions WHERE collection = 'press' AND action = 'delete'");
    assert.equal(deleted.length, REAL_REMOVED, 'each removed copy is in Recently deleted');
    const orphans = await rows(env.DB, 'SELECT l.slug FROM press_links l LEFT JOIN press p ON p.slug = l.slug WHERE p.slug IS NULL');
    assert.equal(orphans.length, 0, 'no link records left behind for removed copies');
  });
  test('pictures come from the article (or its archived copy); featured logo cards are only offered one', async () => {
    const stories = (await rows(env.DB, 'SELECT slug, data FROM press')).map((r) => ({ slug: r.slug, ...JSON.parse(r.data) }));
    assert.ok(stories.filter((s) => s.image).length > 60, `${stories.filter((s) => s.image).length} with pictures`);
    const g = await story(env.DB, env.gone.slug);
    if (g) assert.ok(g.image, 'the gone story got its picture from the archive');
    const logos = new Map((await rows(env.DB, 'SELECT slug, data FROM medialogos')).map((r) => [r.slug, JSON.parse(r.data)]));
    const before = new Map(REAL.press.map((s) => [s.slug, s]));
    for (const s of stories.filter((x) => x.featured && x.url && before.get(x.slug) && !before.get(x.slug).image && logos.get(x.outletLogo)?.logo)) {
      assert.ok(!s.image || before.get(s.slug).image, `${s.slug} keeps its logo card`);
      const link = await env.DB.prepare('SELECT data FROM press_links WHERE slug = ?').bind(s.slug).first();
      assert.ok(JSON.parse(link.data).suggestImage, `${s.slug} is offered the picture`);
    }
  });
  test('kids and partners named in the article are linked', async () => {
    const stories = (await rows(env.DB, 'SELECT data FROM press')).map((r) => JSON.parse(r.data));
    assert.ok(stories.every((s) => !s.kids || s.kids.every((k) => REAL.kids.some((x) => x.slug === k))));
  });
  test('every change is logged; undoing a merge brings the copy back', async (t) => {
    const merges = await rows(env.DB, "SELECT * FROM press_log WHERE kind = 'merge' AND undone_at IS NULL");
    assert.equal(merges.length, REAL_DUPES.length);
    if (!merges.length) return t.skip('no duplicates in this copy of the content');
    const m = merges[0];
    const removed = JSON.parse(m.extra).removed;
    assert.ok(removed.length);
    const r = await E.undoChange(env, m.id, 'peter@example.com');
    assert.ok(r.success, r.error);
    for (const x of removed) assert.ok(await story(env.DB, x.slug), `${x.slug} is back`);
    assert.ok((await env.DB.prepare('SELECT undone_at FROM press_log WHERE id = ?').bind(m.id).first()).undone_at);
  });
  test('undoing a story change puts back only fields nobody touched since', async () => {
    const e = (await rows(env.DB, "SELECT * FROM press_log WHERE kind = 'story' AND after LIKE '%\"image\"%' AND undone_at IS NULL LIMIT 1"))[0];
    const slug = e.slug;
    const cur = await story(env.DB, slug);
    const raw = JSON.stringify(cur);
    const edited = { ...cur, excerpt: 'Written by a person after the tidy.' };
    await env.DB.prepare('UPDATE press SET data = ? WHERE slug = ? AND data = ?').bind(JSON.stringify(edited), slug, raw).run();
    const r = await E.undoChange(env, e.id, 'peter@example.com');
    assert.ok(r.success, r.error);
    const after = await story(env.DB, slug);
    assert.ok(!after.image || JSON.parse(e.before).image, 'the picture came off');
    if ('excerpt' in JSON.parse(e.after)) assert.equal(after.excerpt, 'Written by a person after the tidy.', 'the person’s summary stayed');
  });
});

describe('press monitor: links, merges, concurrency', () => {
  beforeEach(() => { world = freshWorld(); });
  const one = { slug: 'wsb-2020', outlet: 'WSB-TV', outletLogo: 'wsb-tv', category: 'local-tv', title: 'A room for Sam', date: '2020-05-01', url: 'https://www.wsbtv.com/news/sam', excerpt: 'Sam got a room.', image: null, featured: false, order: 0 };

  test('a story gone on two checks days apart links to its archived copy, then comes back', async () => {
    const env = await newEnv({ press: [one], medialogos: [{ slug: 'wsb-tv', name: 'WSB-TV', logo: 'x', order: 0 }], kids: [], partners: [] });
    await E.ensurePressTables(env.DB);
    world.pages[one.url] = 404;
    world.archive[one.url] = 'https://web.archive.org/web/20200502000000/https://www.wsbtv.com/news/sam';
    let r = await E.checkStory(env, one.slug, { now: NOW });
    assert.equal(r.status, 'gone');
    assert.ok(!r.confirmed, 'one miss isn’t enough');
    assert.ok(!(await story(env.DB, one.slug)).linkGone);
    r = await E.checkStory(env, one.slug, { now: NOW + 6 * DAY });
    assert.ok(r.confirmed);
    let st = await story(env.DB, one.slug);
    assert.equal(st.linkGone, new Date(NOW + 6 * DAY).toISOString().slice(0, 10));
    assert.equal(P.linkFor(st), world.archive[one.url]);
    world.pages[one.url] = '<html><title>Sam</title></html>';
    await E.checkStory(env, one.slug, { now: NOW + 13 * DAY });
    st = await story(env.DB, one.slug);
    assert.ok(!st.linkGone);
    assert.equal(P.linkFor(st), one.url);
    assert.equal((await rows(env.DB, "SELECT * FROM press_log WHERE kind = 'link'")).length, 2);
  });
  test('a step cut short three times is skipped, not retried forever', async () => {
    const env = await newEnv({ press: [one], medialogos: [], kids: [], partners: [] });
    await E.ensurePressTables(env.DB);
    await env.DB.prepare('INSERT INTO press_links (slug, url, data) VALUES (?, ?, ?)').bind(one.slug, one.url, JSON.stringify({ stage: 'read', tries: { read: 3 } })).run();
    const r = await E.storyStep(env, one.slug);
    assert.match(r.did, /skipped read/);
    assert.equal(JSON.parse((await env.DB.prepare('SELECT data FROM press_links WHERE slug = ?').bind(one.slug).first()).data).stage, 'judge');
    // A found article whose outlet never answers goes on with what's known
    await env.DB.prepare("INSERT INTO press_mentions (id, key, provider, url, link, title, source, state, stage, data, found_at) VALUES ('b:slow', 'x', 'bing', 'https://slow.example.com/a', 'https://slow.example.com/a', 'Sunshine on a Ranney Day builds a room', 'Slow Daily', 'new', 'read', ?, ?)").bind(JSON.stringify({ tries: { read: 3 } }), new Date(NOW).toISOString()).run();
    const m = await env.DB.prepare("SELECT * FROM press_mentions WHERE id = 'b:slow'").first();
    const s = await E.stepMention(env, m);
    assert.equal(s.next, 'judge');
  });
  test('a blocked outlet is never marked gone', async () => {
    const env = await newEnv({ press: [one], medialogos: [], kids: [], partners: [] });
    await E.ensurePressTables(env.DB);
    world.pages[one.url] = 403;
    await E.checkStory(env, one.slug, { now: NOW });
    await E.checkStory(env, one.slug, { now: NOW + 8 * DAY });
    assert.ok(!(await story(env.DB, one.slug)).linkGone);
  });
  test('writes never clobber an edit made meanwhile', async () => {
    const env = await newEnv({ press: [one], medialogos: [], kids: [], partners: [] });
    const raw = (await env.DB.prepare('SELECT data FROM press WHERE slug = ?').bind(one.slug).first()).data;
    await env.DB.prepare('UPDATE press SET data = ? WHERE slug = ?').bind(JSON.stringify({ ...JSON.parse(raw), title: 'Edited by a person' }), one.slug).run();
    const ok = await E.writeRecord(env, 'press', one.slug, raw, { ...JSON.parse(raw), image: 'press/x' });
    assert.equal(ok, false);
    assert.equal((await story(env.DB, one.slug)).title, 'Edited by a person');
  });
  test('merging two outlets moves the stories and the spellings; undo moves them back', async () => {
    const env = await newEnv({ press: [one, { ...one, slug: 'wsb-2021', outletLogo: 'wsb-tv-abc', outlet: 'WSB-TV (ABC Atlanta)', url: 'https://www.wsbtv.com/news/b' }], medialogos: [{ slug: 'wsb-tv', name: 'WSB-TV', logo: 'x', order: 0 }, { slug: 'wsb-tv-abc', name: 'WSB-TV (ABC Atlanta)', logo: '', order: 0, strip: false, domains: ['wsbtv.com'] }], kids: [], partners: [] });
    await E.ensurePressTables(env.DB);
    const r = await E.mergeOutlets(env, 'wsb-tv-abc', 'wsb-tv', 'peter@example.com');
    assert.ok(r.success, r.error);
    assert.equal(r.moved, 1);
    const into = JSON.parse((await env.DB.prepare("SELECT data FROM medialogos WHERE slug = 'wsb-tv'").first()).data);
    assert.equal(into.slug, 'wsb-tv');
    assert.ok(into.aliases.includes('WSB-TV (ABC Atlanta)'));
    assert.ok(into.domains.includes('wsbtv.com'));
    assert.equal(await env.DB.prepare("SELECT slug FROM medialogos WHERE slug = 'wsb-tv-abc'").first(), null);
    assert.equal((await story(env.DB, 'wsb-2021')).outletLogo, 'wsb-tv');
    const e = (await rows(env.DB, "SELECT id FROM press_log WHERE kind = 'outlet-merge'"))[0];
    assert.ok((await E.undoChange(env, e.id, 'peter@example.com')).success);
    assert.equal((await story(env.DB, 'wsb-2021')).outletLogo, 'wsb-tv-abc');
  });
  test('filling a story from its link', async () => {
    const env = await newEnv({ press: [one], medialogos: [{ slug: 'fox5', name: 'Fox 5 Atlanta', logo: 'x', order: 0, domains: ['fox5atlanta.com'] }], kids: [{ slug: 'kalen', name: 'Kalen', year: 2016 }], partners: [] });
    world.pages['https://www.fox5atlanta.com/news/hawks-plan-surprise-for-local-teen-paralyzed-in-car-accident'] = FIX('article-fox5.html');
    const r = await E.fillFromUrl(env, 'https://www.fox5atlanta.com/news/hawks-plan-surprise-for-local-teen-paralyzed-in-car-accident');
    assert.ok(r.success);
    assert.equal(r.story.outletLogo, 'fox5');
    assert.equal(r.story.title, 'Hawks plan surprise for local teen paralyzed in car accident');
    assert.match(r.story.date, /^2016-11-0/);
    assert.match(r.story.image, /^press\//);
    assert.deepEqual(r.story.kids, ['kalen']);
    assert.equal(r.duplicateOf, null);
    const again = await E.fillFromUrl(env, one.url);
    assert.equal(again.duplicateOf?.slug, one.slug, 'a story already on the page is caught');
  });
  test('settings: searches and channels', async () => {
    const env = await newEnv({ press: [], medialogos: [], kids: [], partners: [] });
    assert.equal((await E.saveSettings(env, { queries: [] }, 'p')).success, false);
    const r = await E.saveSettings(env, { queries: ['"Sunshine on a Ranney Day"', ' x '], channels: [{ name: 'Bad', id: 'nope' }, { name: '11Alive', id: 'UCzF4Ryn8TKn64md77gS5Q5Q' }] }, 'p');
    assert.ok(r.success);
    const s = await E.readSettings(env.DB);
    assert.deepEqual(s.queries, ['"Sunshine on a Ranney Day"', 'x']);
    assert.deepEqual(s.channels.map((c) => c.id), ['UCzF4Ryn8TKn64md77gS5Q5Q']);
  });
});

// ── The site and the admin agree ─────────────────────────────────────
describe('src/utils/press.ts mirrors press-shared.js', () => {
  test('links, outlet names, counts and the strip', async () => {
    const { transformSync } = await import('esbuild');
    const ts = transformSync(readFileSync(`${ROOT}src/utils/press.ts`, 'utf8'), { loader: 'ts', format: 'esm' }).code;
    const site = await import(`data:text/javascript,${encodeURIComponent(ts)}`);
    const outlets = new Map([...REAL.medialogos, { slug: 'x', name: 'X News', logo: '' }].map((o) => [o.slug, o]));
    const stories = [...REAL.press, { slug: 'g', outlet: 'Gone Daily', url: 'https://g.com/a', linkGone: '2026-01-01', archiveUrl: 'https://web.archive.org/web/1/https://g.com/a' }, { slug: 'h', outlet: 'Lost', url: 'https://h.com', linkGone: '2026-01-01' }, { slug: 'd', outlet: 'Draft', publishStatus: 'draft' }];
    for (const s of stories) {
      assert.equal(site.linkFor(s), P.linkFor(s), s.slug);
      assert.equal(site.outletNameFor(s, outlets), P.outletNameFor(s, outlets), s.slug);
      assert.equal(site.isPublished(s), !P.isDraft(s), s.slug);
      assert.equal(site.outletKey(s.outlet), P.outletKey(s.outlet), s.slug);
    }
    assert.equal(site.outletCount(stories, outlets), P.outletCount(stories, outlets));
    for (const o of [...outlets.values(), { logo: 'x', strip: false }, { logo: 'x' }]) assert.equal(site.inStrip(o), P.inStrip(o));
  });
});
