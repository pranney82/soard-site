/**
 * Project Kickoff and Project Reveal: drafted in Kit by themselves, once each
 * per kid, in the reveal invite's design, and Linzi asked to review them. Past
 * kids are never swept up. Kit and Resend are faked.
 * Run: node --test tests/project-emails.test.mjs
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { revealInviteEmail } from '../functions/api/_reveal-invite-email.js';
import { projectKickoffEmail, projectRevealEmail } from '../functions/api/_project-email.js';
import { queueProjectEmail, readProjectRow, syncProjectEmail, runProjectEmails, kickoffNow, revealMissing, projectNote } from '../functions/api/_project-emails.js';
import { writeConfig } from '../functions/api/_reveal-invites.js';

const IMG = 'https://imagedelivery.net/ROYFuPmfN2vPS6mt5sCkZQ';
const KID = {
  name: 'Rowan', slug: 'rowan-test', publishStatus: 'published', status: 'in-progress', year: 2027, age: '9', diagnosis: 'Cerebral Palsy', roomTypes: ['Accessible Bathroom'],
  heroImage: `${IMG}/kids/rowan-test/hero.jpg/public`,
  heroSummary: "Rowan loves trains and can't wait for a bathroom that fits a chair.",
  fundraisingUrl: 'https://www.zeffy.com/en-US/donation-form/help-rowan',
  photos: ['hero', 'a', 'b', 'c'].map((n) => ({ url: `${IMG}/kids/rowan-test/${n}.jpg/public` })),
  partnerLogos: [{ url: `${IMG}/partners/msi/public`, name: 'MSI' }],
};
const DONE = { ...KID, status: 'completed', videoUrl: 'https://youtu.be/abc123' };
const SLUG = KID.slug;
const NOW = Date.parse('2027-02-01T15:00:00Z');
const DAY = 24 * 60 * 60 * 1000;

let kit; let emails;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = typeof input === 'string' ? input : input.url;
  const method = (init.method || 'GET').toUpperCase();
  const body = init.body ? JSON.parse(init.body) : null;
  if (url.startsWith('https://api.kit.com/v4/')) {
    const path = url.slice('https://api.kit.com/v4'.length);
    kit.calls.push(`${method} ${path.split('?')[0]}`);
    if (path.startsWith('/tags')) return Response.json({ tags: [] });
    if (path.startsWith('/broadcasts?')) {
      if (kit.listDown) return new Response('down', { status: 503 });
      return Response.json({ broadcasts: [...kit.broadcasts.values()].map(({ content, ...b }) => b) });
    }
    if (path === '/broadcasts' && method === 'POST') {
      if (kit.refuse) return Response.json({ errors: ['Refused'] }, { status: 422 });
      const id = 7000 + kit.broadcasts.size + 1;
      kit.broadcasts.set(String(id), { id, status: 'draft', ...body });
      if (kit.loseAnswer) { kit.loseAnswer = false; return new Response('gateway', { status: 502 }); }
      return Response.json({ broadcast: { id } }, { status: 201 });
    }
    return Response.json({ errors: ['unexpected'] }, { status: 500 });
  }
  if (url.startsWith('https://imagedelivery.net/')) {
    if (/broken/.test(url)) return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain' } });
    return new Response('img', { headers: { 'Content-Type': 'image/jpeg' } });
  }
  if (url.startsWith('https://api.resend.com/emails/batch')) {
    if (kit.resendDown) return new Response('down', { status: 500 });
    for (const e of body) emails.push(e);
    return Response.json({ data: body.map((_, i) => ({ id: `re_${emails.length}_${i}` })) });
  }
  if (/slack/.test(url)) throw new Error(`Slack was called (${url}): the reviewer hears by email only`);
  throw new Error(`unexpected fetch ${url}`);
};
after(() => { globalThis.fetch = realFetch; });

let env;
const putKid = (kid) => env.DB.prepare('UPDATE kids SET data = ?, status = ? WHERE slug = ?').bind(JSON.stringify(kid), kid.status, SLUG).run();
beforeEach(async () => {
  kit = { broadcasts: new Map(), calls: [] };
  emails = [];
  const DB = await createD1({ schemaFiles: ['scripts/schema.sql'] });
  await DB.prepare('INSERT INTO kids (slug, name, year, status, data) VALUES (?, ?, ?, ?, ?)').bind(SLUG, KID.name, 2027, KID.status, JSON.stringify(KID)).run();
  env = { DB, KIT_API_KEY: 'kit_test', RESEND_API_KEY: 're_test', SLACK_WEBHOOK_URL: 'https://hooks.slack.example/never', SLACK_BOT_TOKEN: 'xoxb-never' };
});
const config = { enabled: true };
const queued = (kind, at = NOW) => queueProjectEmail(env, { slug: SLUG, kind, jobId: '22PTestJob001', now: at });
const look = async (kind, extra = {}) => syncProjectEmail(env, await readProjectRow(env.DB, SLUG, kind), { config, alertTo: ['peter@soardcharity.com'], now: NOW, ...extra });
const only = () => [...kit.broadcasts.values()][0];

test('Kickoff: the story, the rooms and the kid’s own fundraiser, signed by the team, with no address', () => {
  const e = projectKickoffEmail({ kid: KID });
  assert.equal(e.subject, 'Meet Rowan, Our Next Dream Room Project');
  assert.match(e.html, /Meet <em[^>]*>Rowan<\/em>\./);
  assert.match(e.html, /Our next project · 2027/);
  assert.match(e.html, /Rowan loves trains and can’t wait/);
  assert.match(e.html, /Accessible Bathroom/);
  assert.match(e.html, /Cerebral Palsy/);
  assert.match(e.html, /href="https:\/\/www\.zeffy\.com\/en-US\/donation-form\/help-rowan"/);
  assert.match(e.html, /Give to Rowan’s Room/);
  assert.match(e.html, /emails\/soard-team-plushie/);
  assert.match(e.html, /The SOARD Team/);
  assert.ok(!/Holly|Peter/.test(e.html + e.text));
  assert.ok(!/—/.test(e.html + e.text + e.subject), 'no em dashes');
  assert.ok(!/gradient/i.test(e.html), 'flat colors only');
  assert.ok(!/unsubscribe/i.test(e.html), 'Kit adds that itself');
});

test('Kickoff with no fundraiser of its own gives to SOARD', () => {
  const e = projectKickoffEmail({ kid: { ...KID, fundraisingUrl: null } });
  assert.match(e.html, /href="https:\/\/sunshineonaranneyday\.com\/donate\/"/);
});

test('Project Reveal opens with what’s always true, never a summary written before the room was built', () => {
  const e = projectRevealEmail({ kid: { ...DONE, heroSummary: 'SOARD is building a therapy room he needs.' } });
  assert.ok(!/SOARD is building/.test(e.html + e.text));
  assert.match(e.html, /The wait is over\. Rowan’s new accessible bathroom is finished/);
  const two = projectRevealEmail({ kid: { ...DONE, roomCount: 2, roomTypes: ['Accessible Bathroom', 'Dream Bedroom'] } });
  assert.match(two.html, /accessible bathroom and dream bedroom are finished, and the family has seen them/);
});

test('Kickoff with no fundraiser promises nothing about the kid’s room', () => {
  const e = projectKickoffEmail({ kid: { ...KID, fundraisingUrl: null } });
  assert.ok(!/Give to Rowan/.test(e.html + e.text));
  assert.ok(!/for Rowan’s new space/.test(e.html + e.text));
  assert.match(e.html, /Give Now/);
  assert.match(e.html, /dreams<\/em> like Rowan’s/);
});

test('no rooms on the page: no stray text', () => {
  for (const e of [projectKickoffEmail({ kid: { name: 'Rowan' } }), projectRevealEmail({ kid: { name: 'Rowan' } })]) assert.ok(!/^0$/m.test(e.text));
});

test('Project Reveal: the finished room, the video, the photos, the partners and what’s next', () => {
  const e = projectRevealEmail({ kid: { ...DONE, photos: Array.from({ length: 12 }, (_, i) => ({ url: `${IMG}/kids/rowan-test/p${i}.jpg/public` })) } });
  assert.equal(e.subject, 'Rowan’s Dream Room Is Complete');
  assert.match(e.html, /Project complete · 2027/);
  assert.match(e.html, /Dream&nbsp;Room<br>Is&nbsp;<em[^>]*>Complete<\/em>\./);
  assert.match(e.html, /Watch the Reveal/);
  assert.match(e.html, /kids\/rowan-test\/#chapter-reveal/);
  assert.match(e.html, /See all 12 photos/);
  assert.match(e.html, /kids\/rowan-test\/#chapter-gallery/);
  assert.match(e.html, /partners\/msi\/trim=border/);
  assert.match(e.html, /Another family is/);
  assert.match(e.html, /sunshineonaranneyday\.com\/donate\//);
  assert.ok(!/—/.test(e.html + e.text + e.subject));
  assert.equal(projectRevealEmail({ kid: { ...DONE, roomCount: 2, roomTypes: ['Bathroom', 'Bedroom'] } }).subject, 'Rowan’s Dream Rooms Are Complete');
});

test('a quote shows once, without doubled marks; one the story already says is left out', () => {
  const said = projectRevealEmail({ kid: { ...DONE, quote: '"Rowan lights up every room."' } });
  assert.match(said.html, /“Rowan lights up every room\.”/);
  assert.ok(!/“"/.test(said.html));
  const repeat = projectRevealEmail({ kid: { ...DONE, quote: 'Rowan loves trains', heroSummary: 'Rowan loves trains and more.' } });
  assert.ok(!/“Rowan loves trains”/.test(repeat.html));
  const apostrophe = projectRevealEmail({ kid: { ...DONE, heroSummary: '', bio: "<p>Rowan's smile lights up the room every day.</p>", quote: "Rowan's smile lights up the room every day." } });
  assert.ok(!/“Rowan’s smile/.test(apostrophe.html), 'a curly apostrophe doesn’t hide the repeat');
});

test('a long story opens with its first sentences, cleanly', () => {
  const bio = `<p>Rowan was born at 27 weeks in the NICU . ${'Rowan is a remarkable and vibrant kid who lights up every room. '.repeat(12)}</p>`;
  const e = projectKickoffEmail({ kid: { ...KID, heroSummary: '', bio } });
  const lede = /<p class="ld"[^>]*>([^<]+)</.exec(e.html)[1];
  assert.ok(lede.length <= 320, String(lede.length));
  assert.match(lede, /NICU\./);
  assert.match(lede, /[.!?]$/);
});

test('design plans never reach a mass email: a plan is a floor plan of the family’s home', () => {
  const plans = [{ url: `${IMG}/kids/rowan-test/plan-floor.png/public`, label: 'Floor plan', type: 'as-built' }];
  // Short of photos is when a plan would be tempting filler, so that's tested too
  for (const kid of [{ ...DONE, plans }, { ...DONE, plans, photos: [] }, { ...DONE, plans, photos: [], heroImage: '' }]) {
    for (const e of [projectKickoffEmail({ kid }), projectRevealEmail({ kid })]) assert.ok(!/plan-floor|Floor plan/.test(e.html + e.text));
  }
});

const PAIR = { before: `${IMG}/kids/rowan-test/ba-before.jpg/public`, after: `${IMG}/kids/rowan-test/ba-after.jpg/public`, room: '', beforeAlt: '', afterAlt: '' };

test('Project Reveal shows the before and after with its words underneath, then one wide photo', () => {
  const photos = Array.from({ length: 12 }, (_, i) => ({ url: `${IMG}/kids/rowan-test/p${i}.jpg/public` }));
  const e = projectRevealEmail({ kid: { ...DONE, photos, beforeAfterPhotos: [PAIR] } });
  assert.match(e.html, /The transformation/);
  assert.ok(e.html.indexOf('ba-before') < e.html.indexOf('ba-after'), 'before comes first');
  assert.ok(e.html.indexOf('ba-after') < e.html.indexOf('>After<'), 'the word sits under the picture');
  assert.match(e.html, /alt="Rowan’s room before"/);
  assert.equal((e.html.match(/kids\/rowan-test\/p\d+\.jpg/g) || []).length, 1, 'one photo after the pair');
});

test('with no before and after there are three photos, from inside the gallery rather than the cover’s moment', () => {
  const photos = Array.from({ length: 9 }, (_, i) => ({ url: `${IMG}/kids/rowan-test/p${i}.jpg/public` }));
  const e = projectRevealEmail({ kid: { ...DONE, heroImage: photos[0].url, photos } });
  assert.ok(!/The transformation/.test(e.html));
  assert.deepEqual([...new Set(e.html.match(/p\d(?=\.jpg)/g))], ['p0', 'p2', 'p5', 'p7'], 'the cover, then the middle of each stretch');
});

test('half a before and after shows nothing: a pair missing one side is passed over', () => {
  const e = projectRevealEmail({ kid: { ...DONE, beforeAfterPhotos: [{ ...PAIR, after: '' }] } });
  assert.ok(!/The transformation|ba-before/.test(e.html));
});

test('a before that won’t load drops the pair from the draft, never a broken picture', async () => {
  await putKid({ ...DONE, beforeAfterPhotos: [{ ...PAIR, before: `${IMG}/kids/rowan-test/broken-before.jpg/public` }] });
  await queued('reveal');
  assert.equal((await look('reveal')).project, 'drafted');
  assert.ok(!/broken-before|ba-after|The transformation/.test(only().content));
});

test('an after that won’t load drops the pair too', async () => {
  await putKid({ ...DONE, beforeAfterPhotos: [{ ...PAIR, after: `${IMG}/kids/rowan-test/broken-after.jpg/public` }] });
  await queued('reveal');
  assert.equal((await look('reveal')).project, 'drafted');
  assert.ok(!/broken-after|ba-before|The transformation/.test(only().content));
});

test('the photographer is thanked when the page names one', () => {
  const kid = { ...KID, photographer: "Nicole Wood's Studio" };
  assert.match(projectKickoffEmail({ kid }).html, /Photos by Nicole Wood’s Studio/);
  assert.ok(!/Photos by/.test(projectKickoffEmail({ kid: KID }).html));
});

test('buttons keep their shape in Outlook, and numbers stay out of the serif’s old-style figures', () => {
  const e = projectRevealEmail({ kid: DONE });
  assert.match(e.html, /<td align="center" bgcolor="#FFDA24"[^>]*mso-padding-alt[^>]*><a /);
  assert.match(e.html, /<td align="center" bgcolor="#1E1F25"[^>]*mso-padding-alt[^>]*><a /);
  assert.match(projectKickoffEmail({ kid: KID }).html, /<div style="margin-top:6px;font-family:'Outfit'[^>]*>9<\/div>/);
});

test('partner tiles are all one height, and a short last row sits centered', () => {
  const partnerLogos = ['a', 'b', 'c', 'd'].map((n) => ({ url: `${IMG}/partners/${n}/public`, name: n }));
  const e = projectRevealEmail({ kid: { ...DONE, partnerLogos } });
  assert.equal((e.html.match(/class="lt" style="height:66px/g) || []).length, 4);
  assert.match(e.html, /width="33\.33%" align="center"[^>]*><tr><td width="100\.00%"/);
});

test('a name wraps as a phrase on a phone, and a long one gets a smaller headline', () => {
  const long = projectRevealEmail({ kid: { ...DONE, name: 'Tyrece & Maddie', roomCount: 2, roomTypes: ['Bathroom', 'Bedroom'] } });
  assert.match(long.html, /Tyrece &amp; Maddie’s Dream&nbsp;Rooms<br>Are&nbsp;/);
  assert.match(long.html, /<h1 class="dms" style="[^"]*font-size:30px/);
  assert.match(projectRevealEmail({ kid: DONE }).html, /<h1 class="dms" style="[^"]*font-size:40px/);
});

test('Gmail drops the style block, so nothing that has to fit a phone leans on it', () => {
  const invite = revealInviteEmail({ kid: DONE, date: '2027-03-12', time: '16:00', address: '100 Example Way, Atlanta, GA 30301', notes: 'Park on the street.' });
  for (const e of [projectKickoffEmail({ kid: DONE }), projectRevealEmail({ kid: DONE }), invite]) {
    assert.ok(!/padding:\d+px 48px/.test(e.html), 'side padding moves with the width');
    assert.match(e.html, /padding-left:8%;padding-right:8%;mso-padding-left-alt:48px/, 'Outlook keeps a fixed one');
    assert.match(e.html, /<table role="presentation"[^>]*width="100%"[^>]*max-width:600px/, 'the width is fluid before any style block');
    assert.match(e.html, /<h1[^>]*font-size:\d+px/, 'the headline has its own size');
  }
});

test('neither email carries anything about where the family lives', () => {
  const kid = { ...DONE, address: '100 Example Way', location: '100 Example Way' };
  for (const e of [projectKickoffEmail({ kid }), projectRevealEmail({ kid })]) assert.ok(!/Example Way/.test(e.html + e.text));
});

test('photos and logos that won’t load are passed over', async () => {
  await putKid({ ...KID, heroImage: `${IMG}/kids/rowan-test/broken.jpg/public` });
  await queued('kickoff');
  assert.equal((await look('kickoff')).project, 'drafted');
  assert.ok(!/broken/.test(only().content));
});

test('a queued email is queued once, ever', async () => {
  const first = await queued('kickoff', NOW);
  const second = await queued('kickoff', NOW + DAY);
  assert.equal(second.queued_at, first.queued_at);
  await look('kickoff');
  const again = await queued('kickoff', NOW + 2 * DAY);
  assert.ok(again.broadcast_id, 'it isn’t reset');
  assert.equal(again.state, 'drafted');
});

test('Kickoff: one private draft to the newsletter list, and Linzi is asked to review it', async () => {
  await queued('kickoff');
  const r = await look('kickoff');
  assert.equal(r.project, 'drafted');
  assert.equal(kit.broadcasts.size, 1);
  const b = only();
  assert.equal(b.subject, 'Meet Rowan, Our Next Dream Room Project');
  assert.equal(b.public, false);
  assert.equal(b.send_at, null, 'a draft: nothing is scheduled');
  assert.match(b.description, /· rowan-test · kickoff$/);
  assert.equal(emails.length, 1);
  assert.deepEqual(emails[0].to, ['linzi@soardcharity.com']);
  assert.equal(emails[0].subject, 'Review Rowan’s kickoff email in Kit');
  assert.match(emails[0].html, /app\.kit\.com\/campaigns\/7001/);
  assert.equal((await look('kickoff')).project, 'unchanged');
  assert.equal(kit.broadcasts.size, 1);
  assert.equal(emails.length, 1);
});

test('Kickoff waits for a published page, then drafts', async () => {
  await putKid({ ...KID, publishStatus: 'draft' });
  await queued('kickoff');
  assert.equal((await look('kickoff')).project, 'waiting');
  assert.equal(kit.broadcasts.size, 0);
  assert.equal(emails.length, 0, 'nobody needs telling yet');
  await putKid(KID);
  assert.equal((await look('kickoff')).project, 'drafted');
});

test('a kickoff still open when the makeover finishes never goes: "our next project" would be untrue', async () => {
  await queued('kickoff');
  await putKid(DONE);
  assert.equal((await look('kickoff')).reason, 'the makeover is finished');
  assert.equal(kit.broadcasts.size, 0);
  assert.equal((await readProjectRow(env.DB, SLUG, 'kickoff')).state, 'skipped');
});

// ─── The past stays out ──────────────────────────────────────────────────────
const addKid = (slug, data) => env.DB.prepare('INSERT OR REPLACE INTO kids (slug, name, year, status, data) VALUES (?, ?, ?, ?, ?)')
  .bind(slug, data.name || slug, data.year || 2027, data.status, JSON.stringify({ ...DONE, slug, name: slug, ...data })).run();
const hourly = (at = NOW) => runProjectEmails(env, { now: at });

test('every kid already Completed at the first look is marked done for good, and none is drafted', async () => {
  await writeConfig(env.DB, { enabled: true });
  await addKid('old-one', { status: 'completed', year: 2016 });
  await addKid('old-two', { status: 'completed', year: 2024 });
  await hourly();
  assert.equal(kit.broadcasts.size, 0);
  assert.equal(emails.length, 0);
  assert.equal((await readProjectRow(env.DB, 'old-one', 'reveal')).state, 'skipped');
  assert.equal((await readProjectRow(env.DB, 'old-two', 'reveal')).state, 'skipped');
  await hourly(NOW + 40 * DAY);
  assert.equal(kit.broadcasts.size, 0);
  assert.equal(emails.length, 0, 'never a reminder either');
});

test('a warranty repair: a finished kid’s job leaves Completed and comes back, and nothing happens', async () => {
  await writeConfig(env.DB, { enabled: true });
  await addKid('old-one', { status: 'completed', year: 2024 });
  await hourly();
  await addKid('old-one', { status: 'in-progress', year: 2024 });
  await hourly(NOW + DAY);
  await addKid('old-one', { status: 'completed', year: 2024 });
  await hourly(NOW + 2 * DAY);
  await hourly(NOW + 12 * DAY);
  assert.equal(kit.broadcasts.size, 0);
  assert.equal(emails.length, 0);
});

test('the first look failing part way leaves nothing behind, and no kid counts as new', async () => {
  await writeConfig(env.DB, { enabled: true });
  await addKid('old-one', { status: 'completed', year: 2024 });
  const realBatch = env.DB.batch.bind(env.DB);
  env.DB.batch = async () => { throw new Error('D1_ERROR: Network connection lost.'); };
  assert.deepEqual(await hourly(), []);
  env.DB.batch = realBatch;
  assert.equal(kit.broadcasts.size, 0, 'a failed first look drafts nothing');
  await hourly(NOW + DAY);
  assert.equal(kit.broadcasts.size, 0);
  assert.equal((await readProjectRow(env.DB, 'old-one', 'reveal')).state, 'skipped');
});

test('a kid who finishes after that is found on the next look, even if nothing marked the moment', async () => {
  await writeConfig(env.DB, { enabled: true });
  await hourly();
  await putKid(DONE);
  const out = await hourly(NOW + DAY);
  assert.deepEqual(out.map((r) => [r.slug, r.project]), [[SLUG, 'drafted']]);
  assert.equal(only().subject, 'Rowan’s Dream Room Is Complete');
  await hourly(NOW + 2 * DAY);
  assert.equal(kit.broadcasts.size, 1);
});

test('kids waiting on a video can’t hold up a kid who’s ready', async () => {
  await writeConfig(env.DB, { enabled: true });
  await hourly();
  for (let i = 0; i < 15; i += 1) await addKid(`waiting-${i}`, { status: 'completed', videoUrl: null });
  await hourly(NOW + DAY);
  await putKid(DONE);
  await hourly(NOW + 2 * DAY);
  assert.equal(kit.broadcasts.size, 1);
  assert.equal(only().subject, 'Rowan’s Dream Room Is Complete');
});

test('a reopened job: not "complete" until it says so again', async () => {
  await writeConfig(env.DB, { enabled: true });
  await hourly();
  await putKid({ ...DONE, videoUrl: null });
  await hourly(NOW + DAY);
  await putKid({ ...KID, status: 'in-progress', videoUrl: 'https://youtu.be/abc123' });
  await hourly(NOW + 2 * DAY);
  assert.equal(kit.broadcasts.size, 0);
  await putKid(DONE);
  await hourly(NOW + 3 * DAY);
  assert.equal(kit.broadcasts.size, 1);
});

test('months after the reveal it’s no longer news: dropped quietly', async () => {
  await writeConfig(env.DB, { enabled: true });
  await hourly();
  await putKid({ ...DONE, videoUrl: null });
  await hourly(NOW);
  await putKid(DONE);
  await hourly(NOW + 91 * DAY);
  assert.equal(kit.broadcasts.size, 0);
  assert.equal((await readProjectRow(env.DB, SLUG, 'reveal')).state, 'skipped');
});

test('two looks at once make one draft', async () => {
  await queued('kickoff');
  const row = await readProjectRow(env.DB, SLUG, 'kickoff');
  const opts = { config, alertTo: [], now: NOW };
  const [a, b] = await Promise.all([syncProjectEmail(env, row, opts), syncProjectEmail(env, row, opts)]);
  assert.deepEqual([a.project, b.project].sort(), ['drafted', 'unchanged']);
  assert.equal(kit.broadcasts.size, 1);
  assert.equal(emails.length, 1);
});

test('a worker that died mid-draft frees its claim', async () => {
  await queued('kickoff');
  await env.DB.prepare("UPDATE project_emails SET state = 'claimed', claimed_at = ? WHERE slug = ?").bind(new Date(NOW - 11 * 60 * 1000).toISOString(), SLUG).run();
  assert.equal((await look('kickoff')).project, 'drafted');
});

test('another look’s fresh claim is left alone', async () => {
  await queued('kickoff');
  await env.DB.prepare("UPDATE project_emails SET state = 'claimed', claimed_at = ? WHERE slug = ?").bind(new Date(NOW - 60 * 1000).toISOString(), SLUG).run();
  assert.equal((await look('kickoff')).project, 'unchanged');
  assert.equal(kit.broadcasts.size, 0);
});

test('a hidden page gets its reminder too, saying so', async () => {
  await putKid({ ...DONE, publishStatus: 'draft' });
  await queued('reveal', NOW);
  await look('reveal', { now: NOW + 7 * DAY });
  assert.match(emails[0].text, /still needs publishing/);
});

test('Kit failing with different codes still alarms: the words don’t carry the code', async () => {
  await queued('kickoff');
  kit.listDown = true;
  await look('kickoff');
  await look('kickoff');
  assert.ok(emails.length > 0);
});

test('photos are chosen from a checked few, so a broken one in a big gallery can’t reach the email', async () => {
  const photos = Array.from({ length: 30 }, (_, i) => ({ url: `${IMG}/kids/rowan-test/${i % 2 ? 'broken-' : 'ok-'}${i}.jpg/public` }));
  await putKid({ ...KID, photos });
  await queued('kickoff');
  await look('kickoff');
  assert.ok(!/broken-/.test(only().content));
});

test('Project Reveal waits for what the admin’s checklist asks of a finished kid: 3 photos and the video', async () => {
  assert.deepEqual(revealMissing(DONE), []);
  assert.deepEqual(revealMissing({ ...DONE, videoUrl: null }), ['the reveal video']);
  assert.deepEqual(revealMissing({ ...DONE, streamVideoId: 'abc', videoUrl: null }), []);
  assert.deepEqual(revealMissing({ ...DONE, photos: [{ url: 'x' }], videoUrl: null }), ['at least 3 photos', 'the reveal video']);
  assert.deepEqual(revealMissing({ ...DONE, publishStatus: 'draft' }), ['publishing']);
  await putKid({ ...DONE, videoUrl: null });
  await queued('reveal');
  assert.equal((await look('reveal')).project, 'waiting');
  assert.equal(kit.broadcasts.size, 0);
  await putKid(DONE);
  assert.equal((await look('reveal')).project, 'drafted');
  assert.equal(only().subject, 'Rowan’s Dream Room Is Complete');
  assert.equal(emails.at(-1).subject, 'Review Rowan’s Project Reveal email in Kit');
});

test('still missing a week later: one reminder saying what’s missing, and it still drafts when they arrive', async () => {
  await putKid({ ...DONE, videoUrl: null });
  await queued('reveal', NOW);
  await look('reveal', { now: NOW + 6 * DAY });
  assert.equal(emails.length, 0, 'not yet');
  await look('reveal', { now: NOW + 7 * DAY });
  assert.equal(emails.length, 1);
  assert.deepEqual(emails[0].to, ['linzi@soardcharity.com']);
  assert.match(emails[0].text, /still needs the reveal video/);
  assert.match(emails[0].subject, /is waiting on the page/);
  await look('reveal', { now: NOW + 8 * DAY });
  await look('reveal', { now: NOW + 30 * DAY });
  assert.equal(emails.length, 1, 'once');
  await putKid(DONE);
  assert.equal((await look('reveal', { now: NOW + 31 * DAY })).project, 'drafted');
});

test('Linzi’s email failing is tried again on the next look, once, and never a second draft', async () => {
  await queued('kickoff');
  kit.resendDown = true;
  assert.equal((await look('kickoff')).project, 'drafted');
  assert.equal((await readProjectRow(env.DB, SLUG, 'kickoff')).told, null);
  kit.resendDown = false;
  await look('kickoff');
  assert.equal(emails.length, 1);
  await look('kickoff');
  assert.equal(emails.length, 1);
  assert.equal(kit.broadcasts.size, 1);
});

test('a draft Kit took but never answered isn’t made twice', async () => {
  await queued('kickoff');
  kit.loseAnswer = true;
  assert.equal((await look('kickoff')).project, 'error');
  assert.equal(kit.broadcasts.size, 1);
  assert.equal((await look('kickoff')).project, 'drafted');
  assert.equal(kit.broadcasts.size, 1);
  assert.equal(emails.at(-1).subject, 'Review Rowan’s kickoff email in Kit');
});

test('Kit not answering: nothing new is made, one look is quiet, still failing tells staff once, and it recovers', async () => {
  await queued('kickoff');
  kit.listDown = true;
  assert.equal((await look('kickoff')).project, 'error');
  assert.equal(emails.length, 0, 'a blip isn’t an alarm');
  await look('kickoff');
  assert.deepEqual(emails.flatMap((e) => e.to).sort(), ['linzi@soardcharity.com', 'peter@soardcharity.com']);
  assert.match(emails[0].subject, /wasn’t drafted/);
  const n = emails.length;
  await look('kickoff');
  assert.equal(emails.length, n, 'told once');
  assert.equal(kit.broadcasts.size, 0);
  kit.listDown = false;
  assert.equal((await look('kickoff')).project, 'drafted');
  assert.equal((await readProjectRow(env.DB, SLUG, 'kickoff')).error, null);
});

test('Kit refusing the draft tells staff, and the next look tries again', async () => {
  await queued('kickoff');
  kit.refuse = true;
  await look('kickoff');
  await look('kickoff');
  assert.ok(emails.some((e) => /wasn’t drafted/.test(e.subject)));
  kit.refuse = false;
  assert.equal((await look('kickoff')).project, 'drafted');
});

test('switched off, paused or Kit not connected: nothing happens', async () => {
  await queued('kickoff');
  assert.equal((await look('kickoff', { config: { enabled: true, kitInvite: { enabled: false } } })).project, 'off');
  assert.equal((await look('kickoff', { config: { enabled: false } })).project, 'off');
  env.KIT_API_KEY = '';
  assert.equal((await look('kickoff')).reason, 'Kit is not connected');
  assert.equal(kit.broadcasts.size, 0);
  assert.equal(emails.length, 0);
});

test('a draft deleted in Kit stays deleted', async () => {
  await writeConfig(env.DB, { enabled: true });
  await queued('kickoff');
  await look('kickoff');
  kit.broadcasts.clear();
  await hourly(NOW + DAY);
  await queued('kickoff', NOW + 2 * DAY);
  assert.equal((await kickoffNow(env, { slug: SLUG, jobId: 'x', now: NOW + 3 * DAY })).project, 'unchanged');
  assert.equal(kit.broadcasts.size, 0);
});

test('Linzi hears by email only: never a Slack post', async () => {
  await queued('kickoff');
  await look('kickoff');
  assert.ok(emails.length > 0, 'the fake throws on any Slack call, so reaching here proves it');
});

test('the reviewer’s notes read right', () => {
  const ready = projectNote('ready', { kind: 'reveal', name: 'Rowan', id: '7', subject: 'Rowan’s Dream Room Is Complete' });
  assert.match(ready.text, /Rowan’s reveal is complete and the page has its photos and video/);
  assert.match(ready.html, /The newsletter list in Kit/);
  const start = projectNote('ready', { kind: 'kickoff', name: 'Rowan', id: '7', subject: 'Meet Rowan' });
  assert.match(start.text, /Set Start Date is checked off for Rowan/);
  assert.match(start.text, /Nothing goes out until you do/);
  const waiting = projectNote('waiting', { kind: 'reveal', name: 'Rowan', missing: ['at least 3 photos', 'the reveal video'] });
  assert.match(waiting.text, /still needs at least 3 photos and the reveal video/);
  assert.match(waiting.html, /admin\/#kids/);
});
