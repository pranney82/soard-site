/**
 * Finding where the house is, with Esri first (functions/api/_esri.js through ./_geo.js): only the
 * house the family entered counts (never a guess on another street), the Census and OpenStreetMap
 * carry on when Esri can't be asked, the two-week pass is kept and renewed by itself, the monthly
 * limit, and the address the family entered is never changed.
 * The case that started it (Nov 12 2026): 420 Copper Ridge Dr, Loganville. The Census has no Copper
 * Ridge Dr and answered "420 Cooper Rd", exactly 10.0 miles out (close), so a home 19.6 miles out
 * got through a 10-mile stop.
 * Esri and the Census are faked here. Run: node --test tests/
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { fakeApplicantWorld } from './lib/fake-applicant-world.mjs';
import { DEFAULT_SERVICE_AREA, AREA_VALUES } from '../functions/api/_application-form.js';
import {
  createDraft, getDraft, saveDraft, setDraftFile, submitDraft, processApplication, getApplication, areaCheck,
  photoKey, TEST_JPEG, testAnswers, placedArea,
} from '../functions/api/_applications.js';
import { saveFormRules, formFor, clearFormCache } from '../functions/api/_application-forms.js';
import { esriLocator, resetEsri, spendEsri, esriFacts, ESRI_MONTHLY } from '../functions/api/_esri.js';
import { entries, applyFacts } from '../public/admin/automations.js';
import { writeSlackConfig } from '../functions/api/_broadcast-notify.js';
import { placeHomeByStaff, staffEmail, staffSlack, JT_FIELDS, forgetCountyChoices } from '../functions/api/_applications.js';
import { listApplicants, getApplicantRow, setApplicantStatus, previewStatus, ensureApplicantSchema, HELD_APPROVAL } from '../functions/api/_applicants.js';
import { checkServiceArea, sameHouse } from '../functions/api/_geo.js';
import { ALERT_EMAILS } from '../functions/api/_applications.js';

const YEAR = '2027';
const PHOTOS = ['photoChild', 'photoFamily', 'photoSpace1', 'photoSpace2'];
const addr = (line1, city, zip) => ({ line1, line2: '', city, state: 'GA', zip });
const COPPER = addr('420 Copper Ridge Dr', 'Loganville', '30052');
// Where each really is: the house (JobTread's point for it) and the Census's guess on another street
const COPPER_HOUSE = { x: -83.8702969, y: 33.746919 };
const COOPER_GUESS = { lat: 33.877562546863, lng: -83.946500926949, county: 'Gwinnett', matched: '420 COOPER RD, LOGANVILLE, GA, 30052' };
const MARIETTA = { lat: 33.95327, lng: -84.54682, county: 'Cobb', matched: '205 LAWRENCE ST NE, MARIETTA, GA, 30060' };
const HOME_IN = addr('205 Lawrence St NE', 'Marietta', '30060');

let w;
let env;
let esri;   // what the fake Esri answers: { candidates } | a number (HTTP error) | { error }
let asks;   // what was asked of Esri: { kind: 'token' | 'geocode', url, auth, body }
let tokenNo;
let emails;
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const point = (x, y, attrs) => ({ candidates: [{ address: attrs.Match_addr, location: { x, y }, score: attrs.Score ?? 100, attributes: { Score: 100, ...attrs } }] });

beforeEach(async () => {
  w = fakeApplicantWorld();
  w.world.census = { '420 copper ridge': COOPER_GUESS, '205 lawrence': MARIETTA };
  env = { ...w.env, DB: await createD1(), ESRI_CLIENT_ID: 'soard-website-id', ESRI_CLIENT_SECRET: 'not-a-real-secret', RESEND_API_KEY: 're_test' };
  resetEsri();
  clearFormCache();
  asks = [];
  emails = [];
  tokenNo = 0;
  esri = point(COPPER_HOUSE.x, COPPER_HOUSE.y, { Addr_type: 'PointAddress', StAddr: '420 Copper Ridge Dr', Subregion: 'Walton County', Match_addr: '420 Copper Ridge Dr, Loganville, Georgia, 30052' });
  globalThis.fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    if (u.host === 'www.arcgis.com') {
      const body = Object.fromEntries(new URLSearchParams(String(init.body)));
      asks.push({ kind: 'token', url: u.href, body });
      if (body.client_secret !== 'not-a-real-secret') return json({ error: { code: 400, message: 'Invalid client_secret' } });
      tokenNo += 1;
      return json({ access_token: `pass-${tokenNo}`, expires_in: 1209600 });
    }
    if (u.host === 'geocode-api.arcgis.com') {
      asks.push({ kind: 'geocode', url: u.href, auth: new Headers(init.headers).get('X-Esri-Authorization'), referer: new Headers(init.headers).get('Referer'), q: u.searchParams });
      return typeof esri === 'number' ? new Response('down', { status: esri }) : json(typeof esri === 'function' ? esri(u, init) : esri);
    }
    if (u.host === 'api.resend.com') { const b = JSON.parse(init.body); emails.push(...b); return json(b.map((_, i) => ({ id: `em_${i}` }))); }
    return w.fetchImpl(url, init);
  };
});

const form = async (over = {}) => {
  await saveFormRules(env.DB, { serviceArea: { nearMiles: 10, beyond: 'stop', ...over } }, { user: 'test' }).catch(() => {});
  clearFormCache();
  return formFor(env.DB, { year: YEAR });
};
async function readyDraft(answers) {
  const id = await createDraft(env.DB, { year: YEAR, ipHash: 'ip', verified: true });
  await saveDraft(env.DB, await getDraft(env.DB, id), { answers, page: 'finish' });
  for (const f of PHOTOS) {
    await env.FILES.put(photoKey(id, f), TEST_JPEG, { httpMetadata: { contentType: 'image/jpeg' } });
    await setDraftFile(env.DB, id, f, { key: photoKey(id, f), type: 'image/jpeg', size: TEST_JPEG.byteLength, name: `${f}.jpg` });
  }
  w.world.videos.vid1 = { uid: 'vid1', readyToStream: false, status: { state: 'inprogress' }, duration: -1 };
  await setDraftFile(env.DB, id, 'video', { uid: 'vid1', uploaded: true, size: 1000, name: 'clip.mov' });
  return getDraft(env.DB, id);
}
const answersAt = (address) => ({ ...testAnswers('mom@example.com', YEAR), childName: { first: 'Avery', last: 'Stone' }, address });

test('the same house: the same number on the same street, however a map service writes it', () => {
  assert.equal(sameHouse('420 Copper Ridge Dr', '420 COOPER RD'), false, 'another street is never the house');
  assert.equal(sameHouse('420 Copper Ridge Dr', '400 Copper Ridge Dr'), false, 'nor another number on it');
  assert.equal(sameHouse('175 Summer Lake Dr SW', '175 SUMMER LAKE DR'), true, 'a direction left off');
  assert.equal(sameHouse('3001 Holcomb Woods Pkwy', '3001 HOLCOMB WOOD PKWY'), true, 'a letter apart');
  assert.equal(sameHouse('250 Hembree Park Drive', '250 HEMBREE PARK DR'), true, 'Drive is Dr');
  assert.equal(sameHouse('12 Main St', '12 MAIN AVE'), false, 'a street of another kind');
  assert.equal(sameHouse('5 Peachtree Rd NE', '5 PEACHTREE RD NW'), false, 'the other side of town');
  // Three real homes Esri had, turned away until the street's type and the unit were read the Postal Service's way
  assert.equal(sameHouse('210 Gold Valley Crossing', '210 Gold Valley Xing'), true, 'Crossing is Xing');
  assert.equal(sameHouse('345 Burdock Trce', '345 Burdock Trace'), true, 'Trce is Trace');
  assert.equal(sameHouse('1000 Holcomb Woods Pkwy #328', '1000 Holcomb Woods Pkwy'), true, 'an apartment is the same building');
  assert.equal(sameHouse('9 Main St Apt 4B', '9 MAIN ST'), true);
  assert.equal(sameHouse('9 Main St Rear', '9 Main St'), true);
  assert.equal(sameHouse('9 Lot Ln', '9 Lot Ln'), true, 'a street named like a unit is still the street');
  assert.equal(sameHouse('12 Saint Andrews Ct', '12 St Andrews Ct'), true);
  assert.equal(sameHouse('12 Oak Mountain Rd', '12 Oak Mtn Rd'), true);
  assert.equal(sameHouse('123 Lake Forest', '123 Lake Forest Dr'), true, 'the type left off, its name ending in a type word');
  assert.equal(sameHouse('123 Copper Ridge Dr', '123 Copper Ridge Ct'), false, 'Dr is never Ct');
  assert.equal(sameHouse('55 Highway 20', '55 State Route 20'), true, 'a numbered highway however it is written');
  assert.equal(sameHouse('55 GA-20', '55 Hwy 20'), true);
  assert.equal(sameHouse('55 Hwy 20', '55 Hwy 9'), false);
  assert.equal(sameHouse('55 Hwy 9', '55 Old Hwy 9'), false, 'the old road is another road');
  assert.equal(sameHouse('12 Elm St', '12 Elk St'), false, 'short names must match exactly');
  assert.equal(sameHouse('500 N Main St', '500 S Main St'), false);
});

test('Copper Ridge Dr: Esri has the house, 19.6 miles out, so a 10-mile stop stops it; the address is never changed', async () => {
  const f = await form();
  const draft = await readyDraft(answersAt(COPPER));
  const out = await areaCheck(env, f, COPPER, { draft });
  assert.equal(out.band, 'far');
  assert.equal(out.miles, 19.6);
  assert.equal(out.county, 'Walton', '"Walton County" from Esri, as JobTread wants it');
  assert.equal(out.source, 'esri');
  assert.equal(w.world.censusCalls || 0, 0, 'Esri had it: the Census never asked');
  const saved = await getDraft(env.DB, draft.id);
  assert.deepEqual(saved.answers.address, COPPER, 'the address the family entered, untouched');
  const sub = await submitDraft(env, saved);
  assert.equal(sub.ok, false, 'submit refuses a home far out when Settings stop them');
});

test('without Esri, the Census’s guess on another street is no answer: the family is asked, never told "close"', async () => {
  delete env.ESRI_CLIENT_ID;
  const f = await form();
  const out = await checkServiceArea('420 Copper Ridge Dr, Loganville, GA 30052', f.serviceArea, fetch, { esri: esriLocator(env) });
  assert.equal(out.band, 'unknown');
  assert.equal(out.reason, 'no-match');
  assert.equal(w.world.censusCalls, 1);
  const census = await checkServiceArea('205 Lawrence St NE, Marietta, GA 30060', f.serviceArea);
  assert.equal(census.band, 'inside', 'the Census’s own house still counts');
  assert.equal(census.source, 'census');
});

test('what Esri is asked: one stored result, the pass in a header, the address as entered', async () => {
  await areaCheck(env, await form(), COPPER, {});
  const token = asks.find(a => a.kind === 'token');
  assert.equal(token.body.grant_type, 'client_credentials');
  assert.equal(token.body.client_id, 'soard-website-id');
  assert.equal(token.body.expiration, '20160', 'two weeks');
  const g = asks.find(a => a.kind === 'geocode');
  assert.equal(g.q.get('forStorage'), 'true', 'only stored results may be kept and used for the check');
  assert.equal(g.q.get('maxLocations'), '1');
  assert.equal(g.q.get('countryCode'), 'USA');
  assert.equal(g.q.get('SingleLine'), '420 Copper Ridge Dr, Loganville, GA 30052');
  assert.equal(g.auth, 'Bearer pass-1');
  assert.equal(g.referer, 'https://sunshineonaranneyday.com/', 'the credential takes requests from the website only (its Referrer URLs)');
  assert.ok(!g.url.includes('pass-1') && !g.url.includes('not-a-real-secret'), 'no pass or secret in a URL');
});

test('Esri with only the street, another number or a number past the street’s range: not the house, so the Census is asked (its exact house only)', async () => {
  const f = await form();
  for (const attrs of [
    { Addr_type: 'StreetName', StAddr: 'Lawrence St NE' },
    { Addr_type: 'PointAddress', StAddr: '211 Lawrence St NE' },
    { Addr_type: 'StreetAddressExt', StAddr: '205 Lawrence St NE' },
    { Addr_type: 'Locality', StAddr: '' },
    { Addr_type: 'PointAddress', StAddr: '205 Lawrence St NE', Score: 62 },
  ]) {
    esri = point(-84.5, 33.9, { ...attrs, Subregion: 'Cobb County', Match_addr: 'x' });
    const out = await checkServiceArea('205 Lawrence St NE, Marietta, GA 30060', f.serviceArea, fetch, { esri: esriLocator(env) });
    assert.equal(out.source, 'census', `${attrs.Addr_type} ${attrs.StAddr}: fell to the Census`);
    assert.match(out.esriSaid, /^Esri found (only|another house)/, `${attrs.Addr_type}: why, for staff`);
    assert.equal(out.band, 'inside');
  }
  esri = point(-84.54, 33.95, { Addr_type: 'StreetAddress', StAddr: '205 Lawrence St NE', Subregion: 'Cobb County', Match_addr: '205 Lawrence St NE, Marietta, Georgia, 30060' });
  const along = await checkServiceArea('205 Lawrence St NE, Marietta, GA 30060', f.serviceArea, fetch, { esri: esriLocator(env) });
  assert.equal(along.source, 'esri', 'its place along its own street, from the street’s numbers, counts');
});

test('Esri down or turning SOARD away: the Census and OpenStreetMap carry on; all down is asked again later', async () => {
  const f = await form();
  esri = 503;
  const a = await checkServiceArea('205 Lawrence St NE, Marietta, GA 30060', f.serviceArea, fetch, { esri: esriLocator(env) });
  assert.equal(a.source, 'census');
  esri = { error: { code: 403, message: 'User does not have permissions to store geocoding results.' } };
  const b = await checkServiceArea('205 Lawrence St NE, Marietta, GA 30060', f.serviceArea, fetch, { esri: esriLocator(env) });
  assert.equal(b.source, 'census', 'no pay-as-you-go yet: the Census, not a failure');
  assert.match(b.esriSaid, /permissions to store geocoding results/, 'and staff are told why Esri didn’t answer');
  assert.match(a.esriSaid, /Esri returned 503/);
  w.world.censusDown = true;
  esri = 503;
  const c = await checkServiceArea('205 Lawrence St NE, Marietta, GA 30060', f.serviceArea, fetch, { esri: esriLocator(env) });
  assert.equal(c.reason, 'error', 'no one could be asked: not stored, tried again');
  env.ESRI_CLIENT_SECRET = 'wrong';
  resetEsri();
  await env.DB.prepare('DELETE FROM esri_pass').run();
  w.world.censusDown = false;
  esri = point(COPPER_HOUSE.x, COPPER_HOUSE.y, { Addr_type: 'PointAddress', StAddr: '205 Lawrence St NE', Subregion: 'Cobb County', Match_addr: 'x' });
  const d = await checkServiceArea('205 Lawrence St NE, Marietta, GA 30060', f.serviceArea, fetch, { esri: esriLocator(env) });
  assert.equal(d.source, 'census', 'credentials Esri won’t take: the Census');
});

test('Esri refusing shows on Site → Automations in its own words, until it answers again', async () => {
  const f = await form();
  const entry = entries.find((n) => n.t === 'Service-area check');
  const LAWRENCE = '205 Lawrence St NE, Marietta, GA 30060';
  assert.deepEqual(await esriFacts({ ...env, ESRI_CLIENT_SECRET: '' }), { on: false });
  applyFacts({ env: {}, esri: { on: false } });
  assert.equal(entry.es, 'attn', 'no keys: only the Census finds homes');
  assert.match(entry.probe.why, /ESRI_CLIENT_ID and ESRI_CLIENT_SECRET/);
  // This morning's failure: every pass "Invalid Token", every home quietly to the Census
  esri = { error: { code: 498, message: 'Invalid Token' } };
  assert.equal((await checkServiceArea(LAWRENCE, f.serviceArea, fetch, { esri: esriLocator(env) })).source, 'census');
  let facts = await esriFacts(env);
  assert.equal(facts.okAt, null);
  assert.ok(facts.errAt);
  assert.match(facts.err, /Invalid Token/);
  assert.equal(facts.used, 0, 'a refusal isn’t billed, so it isn’t counted');
  applyFacts({ env: {}, esri: facts });
  assert.equal(entry.es, 'attn');
  assert.match(entry.probe.why, /Esri refused its last lookup .*“Esri: Invalid Token”.*the Census finds homes/);
  await new Promise((r) => setTimeout(r, 5));
  esri = point(-84.55, 33.95, { Addr_type: 'PointAddress', StAddr: '205 Lawrence St NE', Subregion: 'Cobb County', Match_addr: '205 Lawrence St NE, Marietta, Georgia, 30060' });
  assert.equal((await checkServiceArea(LAWRENCE, f.serviceArea, fetch, { esri: esriLocator(env) })).source, 'esri');
  facts = await esriFacts(env);
  assert.ok(Date.parse(facts.okAt) > Date.parse(facts.errAt));
  applyFacts({ env: {}, esri: facts });
  assert.equal(entry.es, 'live', 'answering again: back to working');
  assert.match(entry.probe.why, new RegExp(`Esri last answered .*\\. 1 of ${ESRI_MONTHLY} lookups used this month\\.`));
  assert.equal(entry.probe.last, facts.okAt);
  // "Not that house" is Esri answering, not refusing
  await new Promise((r) => setTimeout(r, 5));
  esri = { candidates: [] };
  await checkServiceArea(LAWRENCE, f.serviceArea, fetch, { esri: esriLocator(env) });
  applyFacts({ env: {}, esri: await esriFacts(env) });
  assert.equal(entry.es, 'live');
  // The month's lookups all used: the Census finds homes, and that's not Esri refusing
  await env.DB.prepare('UPDATE esri_usage SET n = ?').bind(ESRI_MONTHLY).run();
  await checkServiceArea(LAWRENCE, f.serviceArea, fetch, { esri: esriLocator(env) });
  facts = await esriFacts(env);
  assert.ok(Date.parse(facts.okAt) > Date.parse(facts.errAt), 'the limit isn’t noted as a refusal');
  applyFacts({ env: {}, esri: facts });
  assert.equal(entry.es, 'attn');
  assert.match(entry.probe.why, /All 1000 of this month’s Esri lookups are used/);
});

test('staff hear in Slack when Esri starts refusing, once, and ✅ when it answers again', async () => {
  const f = await form();
  env.SLACK_BOT_TOKEN = 'xoxb-test';
  await env.DB.prepare('CREATE TABLE IF NOT EXISTS site_config (key TEXT PRIMARY KEY, data TEXT, updated_at TEXT)').run();
  await writeSlackConfig(env.DB, { channel: { id: 'CNEWS', name: 'team' }, attention: { id: 'CATT', name: 'website-alerts' } });
  const LAWRENCE = '205 Lawrence St NE, Marietta, GA 30060';
  const posts = () => w.world.slack.filter((p) => JSON.stringify(p).includes('Esri'));
  const good = point(-84.55, 33.95, { Addr_type: 'PointAddress', StAddr: '205 Lawrence St NE', Subregion: 'Cobb County', Match_addr: '205 Lawrence St NE, Marietta, Georgia, 30060' });
  const look = () => checkServiceArea(LAWRENCE, f.serviceArea, fetch, { esri: esriLocator(env) });
  const tick = () => new Promise((r) => setTimeout(r, 3));
  // One dropped connection isn't trouble; a second in a row is
  esri = 503;
  await look();
  assert.equal(posts().length, 0, 'one hiccup: no post');
  await tick();
  esri = good;
  await look();
  await tick();
  esri = 503;
  await look();
  assert.equal(posts().length, 0, 'answered in between: still no post');
  await tick();
  await look();
  assert.equal(posts().length, 1, 'two refusals in a row: one post');
  assert.equal(posts()[0].channel, 'CATT', 'with the website’s problems');
  assert.match(JSON.stringify(posts()[0]), /Esri isn’t finding homes.*Esri returned 503/);
  await tick();
  await look();
  assert.equal(posts().length, 1, 'still refusing: no more posts');
  await tick();
  esri = good;
  await look();
  assert.equal(posts().length, 2);
  assert.match(JSON.stringify(posts()[1]), /Esri is finding homes again/);
  assert.ok((w.world.slackEdits || []).some((e) => JSON.stringify(e).includes('Resolved: Esri wasn’t finding homes')), 'the first post turns ✅');
  // Esri itself saying no (a pass it won't take): at once
  await tick();
  esri = { error: { code: 403, message: 'User does not have permissions to store geocoding results.' } };
  await look();
  assert.equal(posts().length, 3);
  assert.match(JSON.stringify(posts()[2]), /permissions to store geocoding results/);
  assert.doesNotMatch(JSON.stringify(posts()), /—/, 'no em dashes');
});

test('the two-week pass: kept and reused, renewed by itself when Esri stops taking it', async () => {
  const f = await form();
  await checkServiceArea('420 Copper Ridge Dr, Loganville, GA 30052', f.serviceArea, fetch, { esri: esriLocator(env) });
  await checkServiceArea('420 Copper Ridge Dr, Loganville, GA 30052', f.serviceArea, fetch, { esri: esriLocator(env) });
  assert.equal(asks.filter(a => a.kind === 'token').length, 1, 'one sign-in for both');
  resetEsri(); // a new worker: the pass comes from the database
  await checkServiceArea('420 Copper Ridge Dr, Loganville, GA 30052', f.serviceArea, fetch, { esri: esriLocator(env) });
  assert.equal(asks.filter(a => a.kind === 'token').length, 1, 'still one: kept in the database');
  let first = true;
  esri = (u, init) => {
    if (first && new Headers(init.headers).get('X-Esri-Authorization') === 'Bearer pass-1') { first = false; return { error: { code: 498, message: 'Invalid token.' } }; }
    return point(COPPER_HOUSE.x, COPPER_HOUSE.y, { Addr_type: 'PointAddress', StAddr: '420 Copper Ridge Dr', Subregion: 'Walton County', Match_addr: 'x' });
  };
  const out = await checkServiceArea('420 Copper Ridge Dr, Loganville, GA 30052', f.serviceArea, fetch, { esri: esriLocator(env) });
  assert.equal(out.source, 'esri', 'a new pass, and the lookup again');
  assert.equal(asks.filter(a => a.kind === 'token').length, 2);
  assert.equal(asks.at(-1).auth, 'Bearer pass-2');
  // A pass with under an hour left isn't used
  await env.DB.prepare('UPDATE esri_pass SET exp = ?').bind(Date.now() + 30 * 60e3).run();
  resetEsri();
  await checkServiceArea('420 Copper Ridge Dr, Loganville, GA 30052', f.serviceArea, fetch, { esri: esriLocator(env) });
  assert.equal(asks.filter(a => a.kind === 'token').length, 3);
});

test('the monthly limit: past it the Census finds homes; Peter hears at 80% and when it runs out', async () => {
  const f = await form();
  const nov = new Date();
  await spendEsri(env, nov); // makes the table
  await env.DB.prepare('UPDATE esri_usage SET n = ?').bind(Math.ceil(ESRI_MONTHLY * 0.8) - 1).run();
  await checkServiceArea('205 Lawrence St NE, Marietta, GA 30060', f.serviceArea, fetch, { esri: esriLocator(env) });
  assert.equal(emails.length, 1);
  assert.deepEqual(emails[0].to, ALERT_EMAILS);
  assert.match(emails[0].subject, /Esri home lookups: 80%/);
  assert.doesNotMatch(emails[0].subject + emails[0].text, /—/, 'no em dashes');
  // The month's last lookup: Esri answers, and Peter hears they're all used
  await env.DB.prepare('UPDATE esri_usage SET n = ?').bind(ESRI_MONTHLY - 1).run();
  esri = point(-84.5, 33.9, { Addr_type: 'PointAddress', StAddr: '205 Lawrence St NE', Subregion: 'Cobb County', Match_addr: 'x' });
  assert.equal((await checkServiceArea('205 Lawrence St NE, Marietta, GA 30060', f.serviceArea, fetch, { esri: esriLocator(env) })).source, 'esri');
  assert.equal(emails.length, 2);
  const before = asks.filter(a => a.kind === 'geocode').length;
  const out = await checkServiceArea('205 Lawrence St NE, Marietta, GA 30060', f.serviceArea, fetch, { esri: esriLocator(env) });
  assert.equal(out.source, 'census');
  assert.equal(asks.filter(a => a.kind === 'geocode').length, before, 'Esri not asked past the limit');
  assert.equal(emails.length, 2);
  assert.match(emails[1].subject, /limit reached/);
});

test('a check kept before only the house entered counted (the Cooper Rd guess) is looked up again', async () => {
  const f = await form();
  const draft = await readyDraft(answersAt(COPPER));
  const wrong = { key: '420 copper ridge dr, loganville, ga 30052', band: 'near', miles: 10, edgeMiles: 10, nearMiles: 10, lat: COOPER_GUESS.lat, lng: COOPER_GUESS.lng, county: 'Gwinnett', matched: COOPER_GUESS.matched, at: '2026-11-12T14:55:08.833Z' };
  assert.equal(placedArea(wrong, COPPER, f.serviceArea), null, 'not reused');
  await env.DB.prepare('UPDATE application_drafts SET area = ? WHERE id = ?').bind(JSON.stringify(wrong), draft.id).run();
  const again = await areaCheck(env, f, COPPER, { draft: await getDraft(env.DB, draft.id) });
  assert.equal(again.band, 'far');
  assert.equal(again.source, 'esri');
});

test('a house no one had before Esri was set up is looked up again once it is', async () => {
  delete env.ESRI_CLIENT_ID;
  const f = await form();
  const draft = await readyDraft(answersAt(addr('9 Newer Ct', 'Loganville', '30052')));
  const first = await areaCheck(env, f, draft.answers.address, { draft });
  assert.equal(first.reason, 'no-match');
  env.ESRI_CLIENT_ID = 'soard-website-id';
  esri = point(-83.9, 33.8, { Addr_type: 'PointAddress', StAddr: '9 Newer Ct', Subregion: 'Walton County', Match_addr: '9 Newer Ct, Loganville, Georgia, 30052' });
  const second = await areaCheck(env, f, draft.answers.address, { draft: await getDraft(env.DB, draft.id) });
  assert.equal(second.source, 'esri');
  assert.equal(second.band, 'far');
  esri = { candidates: [] };
  const draft2 = await readyDraft(answersAt(addr('11 Newer Ct', 'Loganville', '30052')));
  const none = await areaCheck(env, f, draft2.answers.address, { draft: draft2 });
  assert.equal(none.reason, 'no-match');
  const n = asks.filter(a => a.kind === 'geocode').length;
  await areaCheck(env, f, draft2.answers.address, { draft: await getDraft(env.DB, draft2.id) });
  assert.equal(asks.filter(a => a.kind === 'geocode').length, n, 'Esri said no with everyone asked: not asked twice');
});

test('intake: staff see who found the house and the county comes from it', async () => {
  const f = await form({ beyond: 'warn' });
  assert.ok(f);
  const sub = await submitDraft(env, await readyDraft({ ...answersAt(COPPER), boundary: AREA_VALUES.far }));
  assert.equal(sub.ok, true);
  await processApplication(env, sub.id, { fetchImpl: fetch });
  const app = await getApplication(env.DB, sub.id);
  assert.equal(app.jt_state.area.band, 'far');
  assert.equal(app.jt_state.area.county, 'Walton');
  const note = w.account(app.jt_account_id).comments.find(c => c.name === 'Service area check (automatic)');
  assert.match(note.message, /About 19\.6 miles outside the service area/);
  assert.match(note.message, /Found by Esri: 420 COPPER RIDGE DR, LOGANVILLE, GEORGIA, 30052/);
  assert.doesNotMatch(note.message, /Census/);
});

test('a home no map service finds is held: the family’s answer isn’t taken, and approving waits until staff place it', async () => {
  const f = await form({ beyond: 'stop' });
  esri = { candidates: [] }; // a brand-new street: Esri, the Census and OpenStreetMap don't have it
  const NEW_STREET = addr('77 Brand New Ln', 'Loganville', '30052');
  const sub = await submitDraft(env, await readyDraft({ ...answersAt(NEW_STREET), boundary: AREA_VALUES.near }));
  assert.equal(sub.ok, true, 'the family can still apply');
  await processApplication(env, sub.id, { fetchImpl: fetch });
  let app = await getApplication(env.DB, sub.id);
  assert.equal(app.jt_state.area.band, 'unknown');
  const acct = app.jt_account_id;
  const note = w.account(acct).comments.find(c => c.name === 'Service area check (automatic)');
  assert.match(note.message, /The family's answer: No, but it is close to it/);
  assert.match(note.message, /Held: no map service found this home, so the family’s answer isn’t taken for it\. Before approving, place the home on the map/);
  assert.match(staffEmail(app, acct).html, /Not found on any map: place the home in Applicants/);
  assert.match(JSON.stringify(staffSlack(app, acct)), /No map service found the home, so it waits/);
  // Applicants: held, and Approved waits (JobTread's own point for it doesn't count)
  await ensureApplicantSchema(env.DB);
  await env.DB.prepare("INSERT INTO applicants (account_id, name, status, year, types, fields, lat, lng, area, area_miles, created_at, synced_at) VALUES (?, 'Avery Stone', 'In Review', '2027', '[]', '{}', 33.95, -84.0, 'inside', 0, ?, ?)")
    .bind(acct, new Date().toISOString(), new Date().toISOString()).run();
  let row = (await listApplicants(env.DB)).find(a => a.id === acct);
  assert.equal(row.homeHeld, true);
  assert.equal((await getApplicantRow(env.DB, acct)).homeHeld, true, 'the drawer too');
  await assert.rejects(setApplicantStatus(env, acct, 'Approved', { user: 'linzi@soardcharity.com' }), (e) => e.message === HELD_APPROVAL);
  await assert.rejects(previewStatus(env, acct, 'Approved'), (e) => e.message === HELD_APPROVAL, 'the confirm sheet says why');
  assert.match(HELD_APPROVAL, /Place the home on the map/);
  // Staff place it: 19.6 miles out, Walton County, from the Census's map
  w.world.countyAt = 'Walton';
  w.world.customFields = [{ id: JT_FIELDS.county, targetType: 'location', options: ['Cobb', 'Gwinnett', 'Walton'] }]; // JobTread's County choices
  forgetCountyChoices();
  await assert.rejects(placeHomeByStaff(env, acct, { lat: 40.7, lng: -74 }), /isn’t in Georgia/);
  const out = await placeHomeByStaff(env, acct, { lat: COPPER_HOUSE.y, lng: COPPER_HOUSE.x, by: 'Linzi' });
  assert.equal(out.area.band, 'far');
  assert.equal(out.area.miles, 19.6);
  assert.equal(out.area.county, 'Walton');
  assert.equal(out.area.source, 'staff');
  app = await getApplication(env.DB, sub.id);
  assert.equal(app.jt_state.area.by, 'Linzi');
  const loc = w.account(acct).locations[0];
  assert.equal(Object.values(loc.customFieldValues).includes('Walton'), true, 'JobTread’s County field from where the home is');
  const placed = w.account(acct).comments.find(c => c.name === 'Service area check (placed by staff)');
  assert.match(placed.message, /Linzi placed the home on the map: About 19\.6 miles outside the service area\./);
  assert.match(placed.message, /farther out than Settings → Service area allows/);
  assert.doesNotMatch(placed.message + note.message, /—/, 'no em dashes');
  row = (await listApplicants(env.DB)).find(a => a.id === acct);
  assert.equal(row.homeHeld, false, 'no longer held');
  assert.deepEqual([row.lat, row.lng, row.area, row.areaMiles, row.county], [COPPER_HOUSE.y, COPPER_HOUSE.x, 'outside', 19.6, 'Walton'], 'where staff placed it stands over JobTread’s point');
  assert.equal(row.placed.by, 'Linzi');
  await previewStatus(env, acct, 'Approved').catch((e) => assert.notEqual(e.message, HELD_APPROVAL));
  // Placed again (a slip of the mouse) is fine; a home a map service found isn't placed by hand
  await placeHomeByStaff(env, acct, { lat: COPPER_HOUSE.y + 0.001, lng: COPPER_HOUSE.x, by: 'Linzi' });
  esri = point(COPPER_HOUSE.x, COPPER_HOUSE.y, { Addr_type: 'PointAddress', StAddr: '420 Copper Ridge Dr', Subregion: 'Walton County', Match_addr: '420 Copper Ridge Dr, Loganville, Georgia, 30052' });
  const sub2 = await submitDraft(env, await readyDraft({ ...answersAt(COPPER), boundary: AREA_VALUES.far }));
  assert.equal(sub2.ok, false, 'found 19.6 miles out with stop on: stopped at the form');
  await form({ beyond: 'warn' });
  const sub3 = await submitDraft(env, await readyDraft({ ...answersAt(COPPER), boundary: AREA_VALUES.far }));
  await processApplication(env, sub3.id, { fetchImpl: fetch });
  const found = await getApplication(env.DB, sub3.id);
  await assert.rejects(placeHomeByStaff(env, found.jt_account_id, { lat: 34, lng: -84 }), /Esri already found this home/);
});

test('the default outline is the one in use (the miles above are the live ones)', () => {
  assert.equal(DEFAULT_SERVICE_AREA.polygon.length, 6);
});
