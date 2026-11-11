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
import { queueProjectEmail, readProjectRow, syncProjectEmail, runProjectEmails, kickoffNow, revealMissing, projectNote, refreshProjectDraft, draftProjectEmailNow, projectEmailStatus, byHandBlock } from '../functions/api/_project-emails.js';
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
const DONE = { ...KID, status: 'completed', videoUrl: 'https://youtu.be/abc123def45' };
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
    const one = path.match(/^\/broadcasts\/(\d+)$/);
    if (one && method === 'GET') {
      if (kit.readDown) return new Response('down', { status: 503 });
      const b = kit.broadcasts.get(one[1]);
      return b ? Response.json({ broadcast: b }) : Response.json({ errors: ['Not found'] }, { status: 404 });
    }
    if (one && method === 'PUT') {
      const b = kit.broadcasts.get(one[1]);
      if (!b) return Response.json({ errors: ['Not found'] }, { status: 404 });
      kit.puts.push({ id: one[1], ...body });
      // Kit fills in what a PUT leaves out: no filter means everyone
      kit.broadcasts.set(one[1], { ...b, ...body, subscriber_filter: body.subscriber_filter || [{ all: [{ type: 'all_subscribers' }], any: null, none: null }] });
      return Response.json({ broadcast: kit.broadcasts.get(one[1]) });
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
  kit = { broadcasts: new Map(), calls: [], puts: [] };
  emails = [];
  const DB = await createD1({ schemaFiles: ['scripts/schema.sql'] });
  await DB.prepare('INSERT INTO kids (slug, name, year, status, data) VALUES (?, ?, ?, ?, ?)').bind(SLUG, KID.name, 2027, KID.status, JSON.stringify(KID)).run();
  env = { DB, KIT_API_KEY: 'kit_test', RESEND_API_KEY: 're_test', SLACK_WEBHOOK_URL: 'https://hooks.slack.example/never', SLACK_BOT_TOKEN: 'xoxb-never' };
});
const config = { enabled: true, kitInvite: { reviewer: 'linzi@soardcharity.com' } };
const queued = (kind, at = NOW) => queueProjectEmail(env, { slug: SLUG, kind, jobId: '22PTestJob001', now: at });
const look = async (kind, extra = {}) => syncProjectEmail(env, await readProjectRow(env.DB, SLUG, kind), { config, alertTo: ['peter@soardcharity.com'], now: NOW, ...extra });
const only = () => [...kit.broadcasts.values()][0];

test('Kickoff: the story, the rooms and the kid’s own fundraiser, signed by the team, with no address', () => {
  const e = projectKickoffEmail({ kid: KID });
  assert.equal(e.subject, 'Meet Rowan, Our Next Dream Room Project');
  assert.match(e.html, /Meet <span style="white-space:nowrap;"><em[^>]*>Rowan<\/em>\.<\/span>/);
  assert.match(e.html, /Our next project · 2027/);
  assert.match(e.html, /Rowan loves trains and can’t wait/);
  assert.match(e.html, /Accessible Bathroom/);
  assert.match(e.html, /Cerebral Palsy/);
  assert.match(e.html, /href="https:\/\/www\.zeffy\.com\/en-US\/donation-form\/help-rowan"/);
  assert.match(e.html, /help-rowan" target="_blank" style="[^"]*">Give Now&nbsp;→/, 'the give button goes to Rowan’s own fundraiser');
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
  assert.match(e.html, /Help us build more&nbsp;<em[^>]*>dreams<\/em>\./);
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
  assert.match(e.html, /See all 12(?: |&nbsp;)photos/);
  assert.match(e.html, /kids\/rowan-test\/#chapter-gallery/);
  assert.match(e.html, /partners\/msi\/trim=border/);
  assert.match(e.html, /Another family is/);
  assert.match(e.html, /sunshineonaranneyday\.com\/donate\//);
  assert.ok(!/—/.test(e.html + e.text + e.subject));
  assert.equal(projectRevealEmail({ kid: { ...DONE, roomCount: 2, roomTypes: ['Bathroom', 'Bedroom'] } }).subject, 'Rowan’s Dream Rooms Are Complete');
});

test('a quote shows once, without doubled marks; one the story already says is left out', () => {
  const said = projectRevealEmail({ kid: { ...DONE, quote: '"Rowan lights up every room."' } });
  assert.match(said.html, /“Rowan lights up every(?: |&nbsp;)room\.”/);
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
  assert.match(projectKickoffEmail({ kid }).html, /Photos by Nicole Wood’s&nbsp;Studio/);
  assert.ok(!/Photos by/.test(projectKickoffEmail({ kid: KID }).html));
});

test('buttons keep their shape in Outlook, and numbers stay out of the serif’s old-style figures', () => {
  const e = projectRevealEmail({ kid: DONE });
  assert.match(e.html, /<td align="center" bgcolor="#FFDA24"[^>]*mso-padding-alt[^>]*><a /);
  assert.match(e.html, /<td align="center" bgcolor="#1E1F25"[^>]*mso-padding-alt[^>]*><a /);
  assert.match(projectKickoffEmail({ kid: KID }).html, /<div style="margin-top:6px;font-family:'Outfit'[^>]*>9<\/div>/);
});

test('partner tiles are all one height, and a short last row sits centered', () => {
  const partnerLogos = ['a', 'b', 'c'].map((n) => ({ url: `${IMG}/partners/${n}/public`, name: n }));
  const e = projectRevealEmail({ kid: { ...DONE, partnerLogos } });
  assert.equal((e.html.match(/class="lt" style="vertical-align:middle;height:66px/g) || []).length, 3);
  // Two to a row; the odd one out sits centered at a card's width
  assert.equal((e.html.match(/width="100%" align="center"[^>]*><tr><td width="50\.00%"/g) || []).length, 1);
  assert.match(e.html, /width="50%" align="center"[^>]*><tr><td width="100\.00%"/);
});

test('Kit’s template puts every cell at the top, so each cell says inline where it sits: logos stay centered in their cards', () => {
  // Kit wraps every email in a style block with `table td { vertical-align:top }`, which beats valign="middle"
  const partnerLogos = ['a', 'b', 'c', 'd'].map((n) => ({ url: `${IMG}/partners/${n}/public`, name: n }));
  const invite = revealInviteEmail({ kid: { ...KID, partnerLogos }, date: '2027-03-12', time: '16:00', address: '100 Example Way, Atlanta, GA 30301', notes: 'Park on the street.' });
  const kickoff = projectKickoffEmail({ kid: { ...KID, partnerLogos, roomTypes: ['Bedroom', 'Accessible Bathroom'] } });
  const reveal = projectRevealEmail({ kid: { ...DONE, partnerLogos } });
  for (const e of [invite, kickoff, reveal]) {
    const cells = e.html.match(/<td\b[^>]*>/g);
    assert.ok(cells.length > 20);
    for (const td of cells) {
      const valign = (td.match(/\svalign="(\w+)"/) || [])[1] || 'middle';
      assert.match(td, new RegExp(`style="[^"]*vertical-align:${valign};`), td);
      assert.equal((td.match(/vertical-align:/g) || []).length, 1, td);
    }
  }
  // The invite and Project Reveal carry the partner band (Kickoff has none)
  for (const e of [invite, reveal]) {
    assert.equal((e.html.match(/class="lt" style="vertical-align:middle;height:66px/g) || []).length, 4);
    // The logo is a centered block, so a thin one isn't nudged by the line it would sit on
    assert.equal((e.html.match(/<img [^>]*partners\/[a-d]\/[^>]*style="display:block;[^"]*margin:0 auto;/g) || []).length, 4);
  }
  // Each room's yellow mark sits at the top, level with the room's first line
  assert.match(kickoff.html, /<td width="24" valign="top" style="vertical-align:top;width:24px;padding:21px 0 14px;">/);
});

test('pinCells keeps a cell’s own alignment and adds a style only where there is none', async () => {
  const { pinCells } = await import('../functions/api/_reveal-invite-email.js');
  assert.equal(pinCells('<td valign="top" style="padding:0;">x</td>'), '<td valign="top" style="vertical-align:top;padding:0;">x</td>');
  assert.equal(pinCells('<td width="46">x</td>'), '<td width="46" style="vertical-align:middle;">x</td>');
  assert.equal(pinCells('<td VALIGN="Bottom">x</td>'), '<td VALIGN="Bottom" style="vertical-align:bottom;">x</td>');
  assert.equal(pinCells('<td style="vertical-align:top;">x</td>'), '<td style="vertical-align:top;">x</td>');
  assert.equal(pinCells('<table><tr><th>t</th><td>y</td></tr></table>'), '<table><tr><th>t</th><td style="vertical-align:middle;">y</td></tr></table>');
});

test('a name wraps as a phrase on a phone, and a long one gets a smaller headline', () => {
  const long = projectRevealEmail({ kid: { ...DONE, name: 'Tyrece & Maddie', roomCount: 2, roomTypes: ['Bathroom', 'Bedroom'] } });
  assert.match(long.html, /<span style="white-space:nowrap;">Tyrece<\/span> <span style="white-space:nowrap;">&amp;&nbsp;Maddie’s<\/span> Dream&nbsp;Rooms<br>Are&nbsp;/);
  const sizeOf = (html) => Number(html.match(/<h1 class="[^"]*" style="[^"]*font-size:(\d+)px/)[1]);
  assert.ok(sizeOf(long.html) <= sizeOf(projectRevealEmail({ kid: DONE }).html));
});

// ─── Found by an independent review of the emails as Kit delivers them (Nov 9 2026) ───

const h1Of = (html) => { const m = html.match(/<h1 class="([^"]*)" style="[^"]*font-size:(\d+)px/); return { phone: m[1], size: Number(m[2]) }; };

test('a long name never runs off a phone: the headline fits its widest word in 250px, and the phone rule only shrinks it', async () => {
  const { fitName } = await import('../functions/api/_reveal-invite-email.js');
  for (const name of ['Max', 'Lizzie', 'Alexander', 'Mackenzie', 'Evangeline', 'Christopher', 'Bartholomew', 'Maximilian', 'Tyrece & Maddie', 'Jean-Baptiste']) {
    const kick = h1Of(projectKickoffEmail({ kid: { ...KID, name } }).html);
    // A name that breaks between names is set at 40px at most
    const k0 = fitName({ name, after: '.', runs: ['Meet'], max: 54, min: 30 });
    const k = k0.whole ? k0 : fitName({ name, after: '.', runs: ['Meet'], max: 40, min: 30 });
    assert.deepEqual(kick, { phone: k.phone, size: k.size }, name);
    const inv = h1Of(revealInviteEmail({ kid: { ...KID, name }, date: '2027-03-12', time: '16:00' }).html);
    const v = fitName({ name, after: '’s', runs: ['Reveal Day.'], max: 42, min: 30 });
    assert.deepEqual(inv, { phone: v.phone, size: v.size }, name);
    for (const fit of [kick, inv]) {
      // .dm is 40px and .dms 30px on a phone: never bigger than the inline size
      assert.ok(fit.phone === '' ? true : fit.phone === 'dm' ? fit.size > 40 : fit.size > 30, `${name}: ${JSON.stringify(fit)}`);
    }
  }
  assert.equal(h1Of(projectKickoffEmail({ kid: { ...KID, name: 'Max' } }).html).size, 54, 'a short name keeps the big headline');
  assert.ok(h1Of(projectKickoffEmail({ kid: { ...KID, name: 'Christopher' } }).html).size <= 36);
});

test('Project Reveal promises the video only when the page has one', () => {
  const none = projectRevealEmail({ kid: { ...DONE, videoUrl: '', streamVideoId: '' } });
  assert.ok(!/Watch the Reveal|chapter-reveal|the video/.test(none.html + none.text + none.preview));
  assert.match(none.html, /See the Photos</);
  assert.match(none.html, /#chapter-gallery/);
  const withVideo = projectRevealEmail({ kid: DONE });
  assert.match(withVideo.html, /Watch the Reveal/);
  assert.match(withVideo.preview, /the video/);
  const stream = projectRevealEmail({ kid: { ...DONE, videoUrl: '', streamVideoId: 'ca28d84a781fd71ec692d45009f47936' } });
  assert.match(stream.html, /Watch the Reveal/);
  // The kid page only has a Reveal section for a Stream upload or a link that really is YouTube
  const vimeo = projectRevealEmail({ kid: { ...DONE, videoUrl: 'https://vimeo.com/12345', streamVideoId: '' } });
  assert.ok(!/Watch the Reveal|chapter-reveal/.test(vimeo.html));
});

test('a partner logo that won’t load shows a tidy name that fits its card; a generated file name shows nothing', async () => {
  const partnerLogos = [
    { url: `${IMG}/partners/bin/public`, name: 'Bin There Dump That Atlanta' },
    { url: `${IMG}/partners/gpt/public`, name: 'ChatGPT Image May 5, 2026, 04_42_19 PM' },
    { url: `${IMG}/partners/ok/public`, name: 'OkelleysLOGO' },
    { url: `${IMG}/partners/msi/public`, name: 'MSI' },
  ];
  const { LOGO_TRANSFORM } = await import('../functions/api/_reveal-invite-email.js');
  const broken = new Set([`${IMG}/partners/bin/${LOGO_TRANSFORM}`, `${IMG}/partners/gpt/${LOGO_TRANSFORM}`]);
  const html = projectRevealEmail({ kid: { ...DONE, partnerLogos }, brokenLogos: broken }).html;
  // In even lines, never "Bin There Dump That / Atlanta"
  assert.match(html, /font-size:13px;[^"]*word-break:normal;overflow-wrap:break-word;">Bin&nbsp;There<br>Dump&nbsp;That<br>Atlanta</);
  assert.ok(!/ChatGPT|04_42_19|OkelleysLOGO/.test(html), 'no file names, in text or alt');
  assert.match(html, /alt="Okelleys"/);
  assert.equal((html.match(/table-layout:fixed;"><tr><td width="50\.00%"/g) || []).length, 1, 'equal columns');
});

test('partnerLabel keeps real names and drops generated ones', async () => {
  const { partnerLabel } = await import('../functions/api/_reveal-invite-email.js');
  for (const [n, want] of [['ChatGPT Image May 5, 2026, 04_42_19 PM', ''], ['Screenshot 2026-08-31 at 15.46.42', ''], ['IMG_123.png', ''], ['DSC_0042', ''], ['logo.png', ''], ['12345', ''],
    ['OkelleysLOGO', 'Okelleys'], ['O’Kelley’s Logo', 'O’Kelley’s'], ['Image Signs Inc', 'Image Signs Inc'], ['Logos Church', 'Logos Church'], ['Walk Your Plans', 'Walk Your Plans'], ['MSI', 'MSI']]) {
    assert.equal(partnerLabel(n), want, n);
  }
});

test('one partner is "this incredible partner", several are "these incredible partners"', () => {
  const one = projectRevealEmail({ kid: DONE }).html;
  assert.match(one, /Thank you to our <em[^>]*>incredible<\/em>&nbsp;partner\./);
  assert.match(one, /Our partner</);
  const two = projectRevealEmail({ kid: { ...DONE, partnerLogos: [...DONE.partnerLogos, { url: `${IMG}/partners/cr/public`, name: 'CR' }] } }).html;
  assert.match(two, /Thank you to our <em[^>]*>incredible<\/em>&nbsp;partners\./);
  const inv = revealInviteEmail({ kid: KID, date: '2027-03-12', time: '16:00' }).html;
  assert.match(inv, /Thank you to our <em[^>]*>incredible<\/em>&nbsp;partner\./);
});

test('the invite’s calendar buttons share the width, and typed notes and addresses may wrap', () => {
  const e = revealInviteEmail({ kid: KID, date: '2027-03-12', time: '16:00', address: '100 Example Way, Atlanta, GA 30301', notes: 'Parking: https://www.google.com/maps/place/100+Example+Way,+Atlanta,+GA+30301/@33.7,-84.4,17z' });
  assert.match(e.html, /max-width:330px;table-layout:fixed;"><tr>\s*<td width="33\.33%"/);
  assert.equal((e.html.match(/<a href="[^"]*calendar\.ics[^"]*" target="_blank" style="display:block;/g) || []).length, 3);
  assert.match(e.html, /word-break:normal;overflow-wrap:break-word;">Parking: <a href="https:\/\/www\.google\.com\/maps\/place\/[^"]+"[^>]*>Google&nbsp;Maps<\/a>/, 'a pasted link reads as a short name to tap');
  assert.match(e.html, /word-break:normal;overflow-wrap:break-word;">100[ \u00A0]Example[ \u00A0]Way/);
  assert.match(e.html, /width="100%" style="text-align:left;table-layout:fixed;"/, 'a pasted link can’t widen the ticket');
});

test('the footer’s links can wrap on a narrow phone', () => {
  const html = projectKickoffEmail({ kid: KID }).html;
  assert.match(html, />Facebook<\/a> <span[^>]*>&middot;<\/span> <a /);
});

test('the give button names the kid only when it fits a phone, and its arrow never sits alone', () => {
  assert.match(projectKickoffEmail({ kid: { ...KID, name: 'Max' } }).html, /Give to Max’s Room&nbsp;→/);
  for (const name of ['Dylan', 'Tyrece & Maddie', 'Remi & Nico', 'Christopher']) {
    const html = projectKickoffEmail({ kid: { ...KID, name } }).html;
    assert.ok(!/Give to/.test(html), name);
    assert.match(html, /Give Now&nbsp;→/);
  }
});

test('the words follow the kids and rooms: ages, plurals, lists, and who the gift is for', () => {
  const twins = projectKickoffEmail({ kid: { ...KID, name: 'Remi & Nico', age: [10, 11] } }).html;
  assert.match(twins, /Ages<\/div>\s*<div[^>]*>10 &amp;&nbsp;11</);
  assert.match(projectKickoffEmail({ kid: { ...KID, age: '10,11' } }).html, />10 &amp;&nbsp;11</);
  assert.match(projectKickoffEmail({ kid: { ...KID, age: '9' } }).html, />Age<\/div>\s*<div[^>]*>9</);
  const bedrooms = projectRevealEmail({ kid: { ...DONE, name: 'Remi & Nico', roomCount: 2, roomTypes: ['Dream Bedroom'] } });
  assert.match(bedrooms.html, /new dream bedrooms are finished, and the family has seen them/);
  const three = projectRevealEmail({ kid: { ...DONE, roomTypes: ['Dream Bedroom', 'Accessible Bathroom', 'Therapy Room'] } });
  assert.match(three.html, /new dream bedroom, accessible bathroom, and therapy room are finished/);
  assert.match(three.text, /What we built: Dream Bedroom, Accessible Bathroom, and Therapy Room/);
  const inv = revealInviteEmail({ kid: { ...KID, roomTypes: ['Accessible Bathroom', 'Dream Bedroom'] }, date: '2027-03-12', time: '16:00' });
  assert.ok(!/\+/.test(inv.preview));
  assert.match(inv.preview, /brand-new accessible bathroom and dream bedroom!/);
  assert.match(inv.html, /finished rooms yet/);
  assert.match(inv.html, />Rooms<\/div>/);
  assert.match(inv.html, />Accessible&nbsp;Bathroom and&nbsp;Dream&nbsp;Bedroom<\/div>/, 'the rooms on one line, "and" with the room after it');
  assert.match(revealInviteEmail({ kid: KID, date: '2027-03-12', time: '16:00' }).html, /finished room yet/);
  const noFund = projectKickoffEmail({ kid: { ...KID, fundraisingUrl: '' } });
  assert.ok(!/kids like these/.test(noFund.html + noFund.text));
  assert.match(noFund.html, /kids like Rowan\./);
  assert.match(inv.html, /Read Rowan’s&nbsp;story&nbsp;→/);
  assert.match(projectKickoffEmail({ kid: KID }).html, /Read Rowan’s&nbsp;story&nbsp;→/);
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
  await writeConfig(env.DB, { enabled: true, kitInvite: { reviewer: 'linzi@soardcharity.com' } });
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
  await writeConfig(env.DB, { enabled: true, kitInvite: { reviewer: 'linzi@soardcharity.com' } });
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
  await writeConfig(env.DB, { enabled: true, kitInvite: { reviewer: 'linzi@soardcharity.com' } });
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
  await writeConfig(env.DB, { enabled: true, kitInvite: { reviewer: 'linzi@soardcharity.com' } });
  await hourly();
  await putKid(DONE);
  const out = await hourly(NOW + DAY);
  assert.deepEqual(out.map((r) => [r.slug, r.project]), [[SLUG, 'drafted']]);
  assert.equal(only().subject, 'Rowan’s Dream Room Is Complete');
  await hourly(NOW + 2 * DAY);
  assert.equal(kit.broadcasts.size, 1);
});

test('kids waiting on a video can’t hold up a kid who’s ready', async () => {
  await writeConfig(env.DB, { enabled: true, kitInvite: { reviewer: 'linzi@soardcharity.com' } });
  await hourly();
  for (let i = 0; i < 15; i += 1) await addKid(`waiting-${i}`, { status: 'completed', videoUrl: null });
  await hourly(NOW + DAY);
  await putKid(DONE);
  await hourly(NOW + 2 * DAY);
  assert.equal(kit.broadcasts.size, 1);
  assert.equal(only().subject, 'Rowan’s Dream Room Is Complete');
});

test('a reopened job: not "complete" until it says so again', async () => {
  await writeConfig(env.DB, { enabled: true, kitInvite: { reviewer: 'linzi@soardcharity.com' } });
  await hourly();
  await putKid({ ...DONE, videoUrl: null });
  await hourly(NOW + DAY);
  await putKid({ ...KID, status: 'in-progress', videoUrl: 'https://youtu.be/abc123def45' });
  await hourly(NOW + 2 * DAY);
  assert.equal(kit.broadcasts.size, 0);
  await putKid(DONE);
  await hourly(NOW + 3 * DAY);
  assert.equal(kit.broadcasts.size, 1);
});

test('months after the reveal it’s no longer news: dropped quietly', async () => {
  await writeConfig(env.DB, { enabled: true, kitInvite: { reviewer: 'linzi@soardcharity.com' } });
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
  await writeConfig(env.DB, { enabled: true, kitInvite: { reviewer: 'linzi@soardcharity.com' } });
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

// ─── Found by the second independent review, with the Gmail phone app modeled from Peter's screenshot ───

test('each room is plural when the page counts more than one of it', () => {
  const tm = { ...DONE, name: 'Tyrece & Maddie', roomTypes: ['Accessible Bathroom', 'Dream Bedroom'], roomCount: 3, bedroomCount: 2, bathroomCount: 1 };
  assert.match(projectRevealEmail({ kid: tm }).html, /new accessible bathroom and dream bedrooms are finished/);
  assert.match(projectKickoffEmail({ kid: tm }).html, />Two Dream&nbsp;Bedrooms<\/td>/);
  const inv = revealInviteEmail({ kid: tm, date: '2027-03-12', time: '16:00' });
  assert.match(inv.html, />Accessible&nbsp;Bathroom and&nbsp;Dream&nbsp;Bedrooms<\/div>/);
  assert.match(inv.preview, /accessible bathroom and dream bedrooms!/);
  assert.match(projectRevealEmail({ kid: { ...DONE, roomTypes: ['Therapy Room'], roomCount: 1 } }).html, /new therapy room is finished/);
});

test('the ticket puts each label over its value; an unconfirmed time is a quieter line; no date, no calendar buttons', () => {
  const sure = revealInviteEmail({ kid: KID, date: '2027-03-12', time: '16:00', address: '100 Example Way, Atlanta, GA 30301' }).html;
  assert.match(sure, />When<\/div>\s*<div[^>]*>&nbsp;<\/div>\s*<div style="font-family:[^"]*font-size:17px[^"]*">Friday, March 12<\/div><div style="[^"]*font-size:17px[^"]*">4:00 PM<\/div>/);
  const later = revealInviteEmail({ kid: KID, date: '2027-03-12', time: '' }).html;
  assert.match(later, />Friday, March 12<\/div>\s*<div style="margin-top:2px;[^"]*font-size:15px[^"]*">Time to be confirmed<\/div>/);
  // The time not yet confirmed: nothing to save to a calendar yet, as Linzi's note says the time turns them on
  assert.ok(!/Save it to your calendar|calendar\.ics/.test(later));
  assert.ok(!/Add to your calendar/.test(revealInviteEmail({ kid: KID, date: '2027-03-12', time: '' }).text));
  assert.match(sure, /Save it to your calendar/);
  const noDate = revealInviteEmail({ kid: KID, date: '', time: '' }).html;
  assert.ok(!/Save it to your calendar|calendar\.ics/.test(noDate));
});

test('names and closing lines break only where a person would', () => {
  assert.match(projectKickoffEmail({ kid: { ...KID, name: 'Anastasia-Rose' } }).html, /nowrap;"><em[^>]*>Anastasia-<\/em><\/span>&#8203;<span style="white-space:nowrap;"><em[^>]*>Rose<\/em>\.<\/span>/, 'breaks after its hyphen, never mid-name');
  assert.match(projectRevealEmail({ kid: DONE }).html, /Thank you for making this&nbsp;possible\./);
  assert.match(projectKickoffEmail({ kid: KID }).html, /Zero platform&nbsp;fees\.<\/p>/);
  assert.match(revealInviteEmail({ kid: KID, date: '2027-03-12', time: '16:00' }).html, /white-space:nowrap;">Watch it live</);
  // What's being built is a label over the rooms: no heading to leave a name alone on its line
  const plan = projectKickoffEmail({ kid: { ...KID, name: 'Summer' } }).html;
  assert.match(plan, />What we’re&nbsp;building<\/td>/);
  assert.ok(!/dream&nbsp;room|Summer’s<\/span> dream/.test(plan));
});

test('the Project Reveal preview only promises what the email has', () => {
  // DONE has one partner: "the partner", as the band says "Our partner"
  assert.match(projectRevealEmail({ kid: DONE }).preview, /the photos, the video, and the partner who made it possible\.$/);
  assert.match(projectRevealEmail({ kid: { ...DONE, videoUrl: '' } }).preview, /: the photos and the partner who/);
  const two = { ...DONE, partnerLogos: [...DONE.partnerLogos, { url: `${IMG}/partners/cr/public`, name: 'CR' }] };
  assert.match(projectRevealEmail({ kid: two }).preview, /and the partners who made it possible\.$/);
  const bare = projectRevealEmail({ kid: { ...DONE, videoUrl: '', photos: [], heroImage: '' } });
  assert.ok(!/photos|video/.test(bare.preview));
  assert.match(bare.html, /Read the Story</);
});

test('the footer’s links fit one line on a phone', () => {
  assert.match(projectKickoffEmail({ kid: KID }).html, /<p style="margin:0 0 14px;font-family:[^"]*;font-size:12px;">\s*<a [^>]*>Facebook<\/a> <span style="color:#5A5B61;">&middot;<\/span> <a /);
});

test('typed notes get the same curly apostrophes as the rest of the email', () => {
  const html = revealInviteEmail({ kid: KID, date: '2027-03-12', time: '16:00', notes: "Be respectful of neighbors' driveways. Can't wait!" }).html;
  assert.match(html, /neighbors’ driveways\. Can’t(?: |&nbsp;)wait!/);
});

// ─── Found by the third independent review (Nov 9 2026) ───

test('Project Reveal never promises more photos than the page shows (30)', () => {
  const many = projectRevealEmail({ kid: { ...DONE, photos: Array.from({ length: 44 }, (_, i) => ({ url: `${IMG}/kids/rowan-test/p${i}.jpg/public` })) } });
  assert.match(many.html, /See all 30(?: |&nbsp;)photos/);
  assert.ok(!/See all 44/.test(many.html));
});

test('the Kickoff preview is its own line, not the subject again', () => {
  const e = projectKickoffEmail({ kid: KID });
  assert.equal(e.preview, 'Rowan’s story, what we’re building, and how you can help.');
  assert.equal(projectKickoffEmail({ kid: { ...KID, roomTypes: [] } }).preview, 'Rowan’s story and how you can help.');
});

test('the invite says Rooms over a room the page counts twice', () => {
  const inv = revealInviteEmail({ kid: { ...KID, name: 'Remi & Nico', roomTypes: ['Dream Bedroom'], roomCount: 2 }, date: '2027-03-12', time: '16:00' });
  assert.match(inv.html, />Rooms<\/div>[\s\S]*?>Dream&nbsp;Bedrooms<\/div>/);
  assert.match(inv.text, /Rooms: Dream Bedrooms/);
});

test('a label that wraps keeps a bar, not a slab', () => {
  const html = revealInviteEmail({ kid: { ...KID, name: 'Amanda, Caleb & Isaac' }, date: '2027-03-12', time: '16:00' }).html;
  assert.match(html, /<td valign="top" width="28" style="vertical-align:top;width:28px;padding-top:4px;"><div style="width:28px;height:10px;/);
});

test('logos keep clear of their card’s edges, with no phone rule squeezing the card', () => {
  const html = projectRevealEmail({ kid: DONE }).html;
  // 104px: a wide logo's 2:1 box leaves 7px above and below it in the 66px card, like its sides
  assert.match(html, /max-width:104px;height:auto;margin:0 auto;/);
  assert.ok(!/\.lt\{|\.lc\{/.test(html));
});

test('a two- or three-kid name breaks between names, never after "&", and keeps "’s" on its last name', () => {
  const long = projectKickoffEmail({ kid: { ...KID, name: 'Amanda, Caleb & Isaac' } }).html;
  assert.match(long, /<span style="white-space:nowrap;"><em[^>]*>&amp;&nbsp;Isaac<\/em>\.<\/span>/);
  const remi = projectKickoffEmail({ kid: { ...KID, name: 'Remi & Nico' } }).html;
  // Two names that fit at 30px stay whole, as in the invite: "Meet / Remi & Nico.", never "Meet Remi / & Nico."
  assert.match(remi, /Meet <span style="white-space:nowrap;"><em[^>]*>Remi &amp; Nico<\/em>\.<\/span><\/h1>/);
  // "Remi & Nico’s dream." can't stay whole on a phone line, and "Remi" alone would be stranded
  assert.match(remi, /Help us build this&nbsp;<em[^>]*>dream<\/em>\./);
  // A long name can't stay on one line with "dream", so the ask says "this dream"
  assert.match(projectKickoffEmail({ kid: { ...KID, name: 'Christopher' } }).html, /Help us build this&nbsp;<em[^>]*>dream<\/em>\./);
  const rev = projectRevealEmail({ kid: { ...DONE, name: 'Maximilian-Alexander' } }).html;
  assert.match(rev, /<span style="white-space:nowrap;">Maximilian-<\/span>&#8203;<span style="white-space:nowrap;">Alexander’s<\/span>/, 'too long to keep whole: it breaks after its hyphen');
});

test('a story ending in a newline still keeps its last two words together', () => {
  const html = revealInviteEmail({ kid: { ...KID, heroSummary: 'Josué lives with his mother.\n' }, date: '2027-03-12', time: '16:00' }).html;
  assert.match(html, /with his&nbsp;mother\.<\/p>/);
});

test('straight quotes come out curly everywhere a family or staff typed them', async () => {
  const { curly } = await import('../functions/api/_reveal-invite-email.js');
  assert.equal(curly(`film "the moment" by the 'big oak' near Georgia's kids' room. It's "great," she said.`), 'film “the moment” by the ‘big oak’ near Georgia’s kids’ room. It’s “great,” she said.');
  const inv = revealInviteEmail({ kid: { ...KID, heroSummary: '', bio: "<p>Georgia's family can't wait for the new room and the \"big reveal\".</p>" }, date: '2027-03-12', time: '16:00' }).html;
  assert.match(inv, /Georgia’s family can’t wait for the new room and the “big&nbsp;reveal”\./);
});

test('small copy: three ages, a ramp is named as itself, partners only when shown, no blank runs', () => {
  assert.match(projectKickoffEmail({ kid: { ...KID, age: [8, 11, 13] } }).html, />8, 11&nbsp;&amp;&nbsp;13</);
  const ramp = { ...DONE, roomTypes: ['Wheelchair Ramp'], roomCount: 1 };
  const rev = projectRevealEmail({ kid: ramp });
  assert.equal(rev.subject, 'Rowan’s Wheelchair Ramp Is Complete');
  assert.ok(!/Dream Room/.test(rev.html + rev.text));
  const inv = revealInviteEmail({ kid: ramp, date: '2027-03-12', time: '16:00' });
  assert.match(inv.html, /finished wheelchair ramp yet/);
  assert.match(inv.html, />Project<\/div>/);
  // Named once, in the list: no "Rowan’s wheelchair ramp" heading over "Wheelchair Ramp"
  const rampKick = projectKickoffEmail({ kid: ramp }).html;
  assert.match(rampKick, /<td valign="top"[^>]*>Wheelchair Ramp<\/td>/);
  assert.equal((rampKick.match(/wheelchair(&nbsp;| )ramp/gi) || []).length, 1);
  const noLogos = projectRevealEmail({ kid: { ...DONE, partnerLogos: [] } });
  assert.ok(!/partners/.test(noLogos.preview));
  for (const e of [projectRevealEmail({ kid: { ...DONE, photos: [], heroSummary: '' } }), projectKickoffEmail({ kid: { ...KID, heroSummary: '', bio: '', roomTypes: [] } }), revealInviteEmail({ kid: KID, date: '', time: '' })]) {
    assert.ok(!/\n\s*\n\s*\n/.test(e.text), 'no runs of blank lines');
  }
});

// ─── Found by the fourth independent review (Nov 9 2026) ───

test('the plan counts the rooms in words, so a count never reads as the list’s numbering: "Two Dream Bedrooms"', () => {
  const html = projectKickoffEmail({ kid: { ...KID, roomTypes: ['Accessible Bathroom', 'Dream Bedroom'], bedroomCount: 2, bathroomCount: 1, roomCount: 3 } }).html;
  assert.match(html, /&nbsp;<\/div><\/td>\s*<td[^>]*>Accessible Bathroom<\/td>/);
  assert.match(html, /&nbsp;<\/div><\/td>\s*<td[^>]*>Two Dream&nbsp;Bedrooms<\/td>/);
  assert.ok(!/>[12]<\/td>/.test(html), 'no bare numbers');
  assert.match(projectKickoffEmail({ kid: { ...KID, name: 'Remi & Nico', roomTypes: ['Dream Bedroom'], roomCount: 2 } }).html, /<td[^>]*>Two Dream&nbsp;Bedrooms<\/td>/);
});

test('"Jr." stays with its name, with one period', () => {
  const html = projectKickoffEmail({ kid: { ...KID, name: 'Marcus Jr.' } }).html;
  assert.ok(!/Jr\.\./.test(html));
  assert.match(html, /Meet <span style="white-space:nowrap;"><em[^>]*>Marcus Jr\.<\/em><\/span>/);
  assert.match(projectKickoffEmail({ kid: { ...KID, name: 'Anthony Jr. & Lyric' } }).html, /<em[^>]*>Anthony&nbsp;Jr\.<\/em>/);
});

test('a hyphenated name stays whole unless that would set the headline under 28px', async () => {
  const { fitName } = await import('../functions/api/_reveal-invite-email.js');
  assert.equal(fitName({ name: 'Mary-Lou', after: '.', runs: ['Meet'], max: 54, min: 36 }).whole, true);
  assert.equal(fitName({ name: 'Jean-Baptiste', after: '.', runs: ['Meet'], max: 54, min: 36 }).whole, false);
  const long = fitName({ name: 'Christopher-Alexander', after: '’s', runs: ['Reveal Day.'], max: 42, min: 30 });
  assert.ok(long.size >= 24, `headline ${long.size}px`);
  assert.match(long.html, /Christopher-<\/span>&#8203;<span/);
});

test('ramps and lifts are never called rooms', () => {
  const ramp = { ...KID, roomTypes: ['Wheelchair Ramp', 'Chair Lift'], roomCount: 2 };
  const kick = projectKickoffEmail({ kid: ramp });
  assert.equal(kick.subject, 'Meet Rowan, Our Next Project');
  assert.ok(!/Give to Rowan’s Room/.test(kick.html));
  const mixed = projectRevealEmail({ kid: { ...DONE, roomTypes: ['Dream Bedroom', 'Wheelchair Ramp'], roomCount: 2 } });
  assert.equal(mixed.subject, 'Rowan’s Makeover Is Complete');
});

test('typed notes: a pasted link is a short name to tap, no em dash, curly quotes, and no word alone', () => {
  const e = revealInviteEmail({ kid: KID, date: '2027-03-12', time: '16:00', address: "1234 O'Malley's Crossing, Roswell, GA 30076",
    notes: "Park on Holcomb Bridge Rd — it's tight. Map: https://maps.app.goo.gl/AbC123" });
  assert.match(e.html, /Park on Holcomb Bridge Rd\u00A0\u2013 it’s tight\. Map:&nbsp;<a href="https:\/\/maps\.app\.goo\.gl\/AbC123"[^>]*>Google&nbsp;Maps<\/a>/, 'the word before a closing link stays on its line');
  assert.match(e.html, /1234 O’Malley’s Crossing/);
  assert.ok(!/—/.test(e.html + e.text));
  const noAddress = revealInviteEmail({ kid: KID, date: '2027-03-12', time: '16:00' }).html;
  assert.match(noAddress, />Rowan’s&nbsp;Home<\/div>\s*<div style="margin-top:2px;[^"]*">Address to be confirmed<\/div>/);
});

test('a bio with an em dash reads with a comma', () => {
  const inv = revealInviteEmail({ kid: { ...KID, heroSummary: '', bio: '<p>Tyrece loves music and plays—especially the drums—every day after school.</p>' }, date: '2027-03-12', time: '16:00' });
  assert.match(inv.html, /plays\u00A0\u2013 especially the drums\u00A0\u2013 every day/);
});

// ─── Found by the fifth independent review (Nov 9 2026) ───

test('without the kid’s own fundraiser, the ask is "Help us build more dreams." (no name left alone)', () => {
  const html = projectKickoffEmail({ kid: { ...KID, name: 'Tyrece & Maddie', fundraisingUrl: '' } }).html;
  assert.match(html, /Help us build more&nbsp;<em[^>]*>dreams<\/em>\./);
  assert.ok(!/dreams<\/em> like/.test(html));
});

test('a quote typed with who said it keeps its own marks, with no stray one added', () => {
  const html = projectRevealEmail({ kid: { ...DONE, quote: '"It is everything we hoped for," said Elvia.' } }).html;
  assert.match(html, /“It is everything we hoped for,” said&nbsp;Elvia\./);
  assert.ok(!/Elvia\.”/.test(html));
  assert.match(projectRevealEmail({ kid: { ...DONE, quote: 'We cried happy tears.' } }).html, /“We cried happy&nbsp;tears\.”/);
});

test('a typed em dash becomes a spaced en dash, never a comma splice', async () => {
  const { tidy } = await import('../functions/api/_reveal-invite-email.js');
  assert.equal(tidy('Park at the church lot across the street—it’s free.'), 'Park at the church lot across the street\u00A0– it’s free.');
});

test('the inbox preview is padded so the email’s first words never run on after it', () => {
  const html = revealInviteEmail({ kid: KID, date: '2027-03-12', time: '16:00' }).html;
  assert.ok((html.match(/&#847;&zwnj;&nbsp;/g) || []).length >= 80);
});

test('the partner heading reads in two even lines, and the logo grid lines up with the text', () => {
  const html = projectRevealEmail({ kid: { ...DONE, partnerLogos: ['a', 'b', 'c'].map((n) => ({ url: `${IMG}/partners/${n}/public`, name: n })) } }).html;
  assert.match(html, /Thank you to our <em[^>]*>incredible<\/em>&nbsp;partners\./);
  assert.match(html, /style="vertical-align:middle;padding:4px 4px 4px 0;"/);
  assert.match(html, /style="vertical-align:middle;padding:4px 0 4px 4px;"/);
});

test('a long diagnosis beside several ages gets its own row', () => {
  const html = projectKickoffEmail({ kid: { ...KID, age: [8, 11, 13], diagnosis: 'Neurofibromatosis Type 1' } }).html;
  assert.match(html, /<tr><td valign="top" style="vertical-align:top;padding:16px 0px 16px 0;border-top:1px solid #E5E4E0;">[\s\S]*?Ages[\s\S]*?<\/td><\/tr><tr>/);
  assert.match(html, /word-break:normal;overflow-wrap:break-word;">Neurofibromatosis Type&nbsp;1</);
});

test('the Reveal preview promises photos only when one loads; the invite’s plain text matches its page', async () => {
  const { cfImg, HERO_TRANSFORM, PHOTO_TRANSFORM } = await import('../functions/api/_reveal-invite-email.js');
  const kid = { ...DONE, heroImage: `${IMG}/kids/rowan-test/hero.jpg/public` };
  const broken = new Set([kid.heroImage, ...kid.photos.map((p) => p.url)].flatMap((u) => [cfImg(u, HERO_TRANSFORM), cfImg(u, PHOTO_TRANSFORM)]));
  assert.ok(!/the photos/.test(projectRevealEmail({ kid, brokenLogos: broken }).preview));
  const noDate = revealInviteEmail({ kid: KID, date: '', time: '' }).text;
  assert.ok(!/Add to your calendar/.test(noDate));
  assert.match(noDate, /Where: Rowan’s Home \(address to be confirmed\)/);
});

// ─── Found by the sixth independent review (Nov 9 2026) ───

test('Project Reveal shows "Watch the Reveal" only for a Stream video the drafter found playing', async () => {
  const { streamCheckUrl } = await import('../functions/api/_project-email.js');
  const kid = { ...DONE, videoUrl: '', streamVideoId: 'ca28d84a781fd71ec692d45009f47936' };
  assert.match(projectRevealEmail({ kid }).html, /Watch the Reveal/);
  const gone = new Set([streamCheckUrl(kid)]);
  const e = projectRevealEmail({ kid, brokenLogos: gone });
  assert.ok(!/Watch the Reveal|chapter-reveal|the video/.test(e.html + e.preview));
  assert.equal(streamCheckUrl(kid), 'https://customer-cuav5h47lgfe96ql.cloudflarestream.com/ca28d84a781fd71ec692d45009f47936/manifest/video.m3u8');
});

test('quotes: who said it keeps the marks right, and a quote inside a quote takes single marks', () => {
  assert.match(projectRevealEmail({ kid: { ...DONE, quote: "'We love it,' said Mom." } }).html, /“We love it,” said&nbsp;Mom\./);
  assert.match(projectRevealEmail({ kid: { ...DONE, quote: 'When he saw it he said "wow" and cried.' } }).html, /“When he saw it he said ‘wow’ and&nbsp;cried\.”/);
});

test('labels and links never leave a word alone; a lone last logo card matches the others', () => {
  const inv = revealInviteEmail({ kid: { ...KID, name: 'Tyrece & Maddie' }, date: '2027-03-12', time: '16:00' }).html;
  assert.match(inv, />Tyrece &amp;&nbsp;Maddie’s&nbsp;story<\/td>/);
  assert.match(projectKickoffEmail({ kid: { ...KID, name: 'Christopher-Alexander' } }).html, /Read Christopher-Alexander’s&nbsp;story&nbsp;→/);
  const odd = projectRevealEmail({ kid: { ...DONE, partnerLogos: ['a', 'b', 'c'].map((n) => ({ url: `${IMG}/partners/${n}/public`, name: n })) } }).html;
  assert.match(odd, /width="50%" align="center"[^>]*><tr><td width="100\.00%" valign="middle" class="lc" style="vertical-align:middle;padding:4px 2px;"/);
});

test('a bedroom plus a ramp is the kid’s makeover in all three emails', () => {
  const kid = { ...KID, roomTypes: ['Dream Bedroom', 'Wheelchair Ramp'], roomCount: 2 };
  assert.match(projectKickoffEmail({ kid }).html, /What we’re&nbsp;building[\s\S]*>Dream Bedroom<\/td>[\s\S]*>Wheelchair Ramp<\/td>/);
  const inv = revealInviteEmail({ kid, date: '2027-03-12', time: '16:00' }).html;
  assert.match(inv, />Project<\/div>/);
  assert.match(inv, /finished makeover yet/);
});

test('copy: no guessed pronoun, "Tyrece, Maddie, and the family", the invite story capped like the Kickoff’s, and the photo count in the preview', () => {
  const inv = revealInviteEmail({ kid: { ...KID, name: 'Tyrece & Maddie', heroSummary: '', bio: `<p>${'A long sentence about the family and their home. '.repeat(20)}</p>` }, date: '2027-03-12', time: '16:00' });
  assert.ok(!/\btheir brand-new/.test(inv.preview));
  assert.match(inv.html, /Tyrece, Maddie, and the family haven’t seen/);
  const story = inv.html.match(/<p style="margin:14px 0 0;[^"]*">([^<]*)<\/p>/)[1];
  assert.ok(story.length <= 360, `story ${story.length} characters`);
  const one = projectRevealEmail({ kid: { ...DONE, heroImage: '', photos: [DONE.photos[0]] } });
  assert.match(one.preview, /: the photo, /);
  const none = projectRevealEmail({ kid: { ...DONE, heroImage: '', photos: [], videoUrl: '' } });
  assert.equal(none.preview, 'See Rowan’s transformation and the partner who made it possible.');
});

// ─── Found by the seventh independent review (Nov 9 2026) ───

test('the ticket’s rooms break only between rooms, never inside one', () => {
  const inv = revealInviteEmail({ kid: { ...KID, roomTypes: ['Wheelchair-Accessible Bathroom', 'Dream Bedroom'] }, date: '2027-03-12', time: '16:00' }).html;
  assert.match(inv, />Wheelchair-Accessible&nbsp;Bathroom and&nbsp;Dream&nbsp;Bedroom<\/div>/);
});

test('a story cut from the bio ends at a real sentence: not at "Jr." or "St.", and a closing quote stays with it', async () => {
  const { shortStory } = await import('../functions/api/_reveal-invite-email.js');
  const story = shortStory({ bio: `<p>Ava is nine and loves horses. She says "Horses are my best friends." Marcus Jr. lives on Peachtree St. near Atlanta. ${'More about her day and her family. '.repeat(12)}</p>` });
  assert.match(story, /She says “Horses are my best friends\.” Marcus Jr\. lives on Peachtree St\. near Atlanta\./);
  assert.ok(story.length <= 320 && /\.$/.test(story));
});

test('quotes in every shape a family types them come out curly and matched', () => {
  const q = (quote) => projectRevealEmail({ kid: { ...DONE, quote } }).html.match(/padding:4px 0 4px 22px[^>]*>([\s\S]*?)<\/td>/)[1];
  // Signed with a dash: who said it goes on its own line under the quote, so it never splits off the last line
  assert.match(q('"It’s perfect." — Mom'), /^“It’s&nbsp;perfect\.”<span style="display:block;[^"]*font-size:14px;[^"]*">–&nbsp;Mom<\/span>$/);
  assert.match(q('"We will forever be grateful. It is what we pray for" - Jade, Dewone’s mother'), /^“We will forever be grateful\. It is what we pray&nbsp;for”<span [^>]*>–&nbsp;Jade, Dewone’s&nbsp;mother<\/span>$/);
  assert.match(q('We love it. - Mom'), /^“We love&nbsp;it\.”<span [^>]*>–&nbsp;Mom<\/span>$/);
  // A dash inside a sentence is not a signature, and a typed " - " reads as a dash
  assert.equal(q('We cried - happy tears all day.'), '“We cried\u00A0– happy tears all&nbsp;day.”');
  assert.equal(q('"They can finally get through the door," Vicki said.'), '“They can finally get through the door,” Vicki&nbsp;said.');
  assert.equal(q('She said, "This is home now."'), 'She said, “This is home&nbsp;now.”');
  assert.equal(q('When he saw it he said "wow" and cried.'), '“When he saw it he said ‘wow’ and&nbsp;cried.”');
});

test('therapy rooms are counted like the others; "Marcus Jr." never gets a second period', () => {
  const kid = { ...KID, roomTypes: ['Dream Bedroom', 'Therapy Room'], roomCount: 3, bedroomCount: 1, therapyRoomCount: 2 };
  assert.match(projectKickoffEmail({ kid }).html, /<td[^>]*>Two Therapy&nbsp;Rooms<\/td>/);
  const jr = projectKickoffEmail({ kid: { ...KID, name: 'Marcus Jr.', fundraisingUrl: '' } });
  assert.ok(!/Jr\.\./.test(jr.html + jr.text));
});

test('a ramp headline keeps its words together: "Ava’s Ramp Is Complete."', () => {
  const e = projectRevealEmail({ kid: { ...DONE, name: 'Mohammed', roomTypes: ['Wheelchair Ramp'], roomCount: 1 } });
  assert.equal(e.subject, 'Mohammed’s Wheelchair Ramp Is Complete');
  // "Mohammed’s Ramp" as one run would shrink the headline under 28px, so "Ramp" takes its own line at full size
  assert.match(e.html, /Mohammed’s<\/span> Ramp<br>Is&nbsp;<em/);
  assert.ok(Number(e.html.match(/<h1 class="[^"]*" style="[^"]*font-size:(\d+)px/)[1]) >= 28);
  assert.match(projectRevealEmail({ kid: { ...DONE, roomTypes: ['Wheelchair Ramp', 'Chair Lift'], roomCount: 2 } }).html, /Rowan’s<\/span> Ramp&nbsp;and&nbsp;Lift<br>Are&nbsp;<em/);
  assert.match(projectRevealEmail({ kid: { ...DONE, name: 'Bartholomew' } }).html, /Bartholomew’s<\/span> Dream&nbsp;Room<br>/);
});

test('"&" stays with the name after it in the arrival line and the story link', () => {
  const inv = revealInviteEmail({ kid: { ...KID, name: 'Tyrece & Maddie' }, date: '2027-03-12', time: '16:00' }).html;
  assert.match(inv, /before Tyrece &amp;&nbsp;Maddie&nbsp;arrive\./);
  assert.match(inv, /Read Tyrece &amp;&nbsp;Maddie’s&nbsp;story&nbsp;→/);
});

// ─── A new design reaches drafts nobody has touched, by itself (Nov 9 2026) ───

const drafted = async () => {
  await queued('kickoff');
  const r = await look('kickoff');
  assert.equal(r.project, 'drafted');
  return readProjectRow(env.DB, SLUG, 'kickoff');
};
const ageDesign = (design = 'older') => env.DB.prepare('UPDATE project_emails SET design = ? WHERE slug = ? AND kind = ?').bind(design, SLUG, 'kickoff').run();

test('a draft keeps Kit’s copy and the design it was written in', async () => {
  const { EMAIL_DESIGN } = await import('../functions/api/_reveal-invite-email.js');
  const row = await drafted();
  assert.equal(row.design, EMAIL_DESIGN);
  assert.ok(row.content_hash, 'Kit’s copy, to tell a person’s edit later');
  // Nothing to do while the design is current: Kit isn’t even asked
  kit.calls = [];
  assert.equal((await refreshProjectDraft(env, row, { config })).project, 'unchanged');
  assert.deepEqual(kit.calls, []);
});

test('a new design rebuilds an untouched draft on the next look, keeping who it goes to, and emails nobody', async () => {
  const row = await drafted();
  const filter = [{ all: null, any: null, none: [{ type: 'tag', ids: [42] }] }];
  kit.broadcasts.get(row.broadcast_id).subscriber_filter = filter;
  // the copy the site wrote includes that leave-out
  const { copyHash } = await import('../functions/api/_reveal-invite-kit.js');
  await env.DB.prepare('UPDATE project_emails SET content_hash = ? WHERE slug = ?').bind(await copyHash(kit.broadcasts.get(row.broadcast_id)), SLUG).run();
  await ageDesign();
  await writeConfig(env.DB, config);
  const sent = emails.length;
  const out = await runProjectEmails(env, { now: NOW + DAY });
  assert.ok(out.some((o) => o.project === 'redesigned'), JSON.stringify(out));
  assert.equal(kit.puts.length, 1);
  assert.deepEqual(kit.puts[0].subscriber_filter, filter, 'the newsletter leave-out is sent again, never reset to everyone');
  assert.equal(emails.length, sent, 'a rebuild emails nobody');
  const after = await readProjectRow(env.DB, SLUG, 'kickoff');
  const { EMAIL_DESIGN } = await import('../functions/api/_reveal-invite-email.js');
  assert.equal(after.design, EMAIL_DESIGN);
  assert.equal(after.state, 'drafted');
});

test('a draft someone edited in Kit is left alone, and the site stops looking at it', async () => {
  const row = await drafted();
  kit.broadcasts.get(row.broadcast_id).subject = 'Linzi’s own subject';
  await ageDesign();
  const r = await refreshProjectDraft(env, await readProjectRow(env.DB, SLUG, 'kickoff'), { config });
  assert.equal(r.project, 'edited');
  assert.equal(kit.puts.length, 0);
  assert.equal((await readProjectRow(env.DB, SLUG, 'kickoff')).state, 'edited');
});

test('a draft from before the site kept its copy is reached only by a rebuild asked for by hand', async () => {
  const row = await drafted();
  await env.DB.prepare('UPDATE project_emails SET content_hash = NULL, design = NULL WHERE slug = ?').bind(SLUG).run();
  assert.equal((await refreshProjectDraft(env, await readProjectRow(env.DB, SLUG, 'kickoff'), { config })).project, 'unchanged');
  assert.equal(kit.puts.length, 0);
  const forced = await refreshProjectDraft(env, { ...(await readProjectRow(env.DB, SLUG, 'kickoff')), refresh: 'force' }, { config });
  assert.equal(forced.project, 'redesigned');
  assert.equal(kit.puts.length, 1);
  assert.equal(kit.puts[0].description, kit.broadcasts.get(row.broadcast_id).description, 'its mark stays, so a lost answer is still found');
  assert.ok((await readProjectRow(env.DB, SLUG, 'kickoff')).content_hash, 'and from now on the site knows its copy');
});

test('a draft staff scheduled or sent is never rebuilt', async () => {
  const row = await drafted();
  Object.assign(kit.broadcasts.get(row.broadcast_id), { status: 'scheduled', send_at: '2027-02-10T15:00:00Z' });
  await ageDesign();
  const r = await refreshProjectDraft(env, await readProjectRow(env.DB, SLUG, 'kickoff'), { config });
  assert.equal(r.project, 'skip');
  assert.equal(kit.puts.length, 0);
  assert.equal((await readProjectRow(env.DB, SLUG, 'kickoff')).state, 'scheduled');
});

// ── By hand: Draft in Kit on the kid's card in Admin → Kids ──
const STAFF = 'clareece@soardcharity.com';
const byHand = (kind, extra = {}) => draftProjectEmailNow(env, { slug: SLUG, kind, by: STAFF, now: NOW, ...extra });

test('by hand: a Kickoff drafts now, before JobTread’s step, as a draft only, and Linzi hears who drafted it', async () => {
  await writeConfig(env.DB, { enabled: true, kitInvite: { reviewer: 'linzi@soardcharity.com' } });
  const r = await byHand('kickoff');
  assert.equal(r.project, 'drafted');
  const b = only();
  assert.equal(b.send_at, null, 'never scheduled');
  assert.equal(b.public, false);
  assert.equal(b.subject, 'Meet Rowan, Our Next Dream Room Project');
  assert.ok(!kit.calls.some((c) => /PUT|DELETE/.test(c)), 'only a new draft');
  assert.equal(emails.length, 1);
  assert.deepEqual(emails[0].to, ['linzi@soardcharity.com']);
  assert.match(emails[0].text, /Clareece drafted it from Rowan’s profile in the admin/);
  assert.ok(!/Set Start Date/.test(emails[0].text), 'not JobTread’s doing');
  // A second press, and JobTread's own moment later, make nothing new
  assert.equal((await byHand('kickoff')).project, 'unchanged');
  assert.equal((await kickoffNow(env, { slug: SLUG, jobId: 'x', now: NOW + DAY })).project, 'unchanged');
  assert.equal(kit.broadcasts.size, 1);
  assert.equal(emails.length, 1);
});

test('by hand: Linzi drafting it herself gets no email about it', async () => {
  await writeConfig(env.DB, { enabled: true, kitInvite: { reviewer: 'linzi@soardcharity.com' } });
  assert.equal((await byHand('kickoff', { by: 'Linzi@soardcharity.com' })).project, 'drafted');
  assert.equal(emails.length, 0);
  assert.ok((await readProjectRow(env.DB, SLUG, 'kickoff')).told, 'and the hourly look owes her nothing');
});

test('by hand: only what would make the email untrue holds it back', async () => {
  await writeConfig(env.DB, { enabled: true, kitInvite: { reviewer: 'linzi@soardcharity.com' } });
  assert.match((await byHand('reveal')).reason, /Ready once the kid is Completed/);
  await putKid(DONE);
  assert.match((await byHand('kickoff')).reason, /makeover is finished/);
  await putKid({ ...DONE, publishStatus: 'draft' });
  assert.match((await byHand('reveal')).reason, /Publish the page first/);
  assert.equal(kit.broadcasts.size, 0);
  assert.equal(byHandBlock(null, 'kickoff'), 'Save the profile first');
});

test('by hand: a Project Reveal for a kid finished before these emails began, without its video', async () => {
  await writeConfig(env.DB, { enabled: true, kitInvite: { reviewer: 'linzi@soardcharity.com' } });
  await putKid({ ...DONE, videoUrl: '', photos: DONE.photos.slice(0, 2) });
  await hourly(NOW); // the first look marks every finished kid as past
  assert.equal((await readProjectRow(env.DB, SLUG, 'reveal')).state, 'skipped');
  assert.equal(kit.broadcasts.size, 0);
  const st = await projectEmailStatus(env, SLUG, { now: NOW });
  assert.equal(st.reveal.state, 'skipped');
  assert.deepEqual(st.reveal.missing, ['at least 3 photos', 'the reveal video']);
  assert.equal(st.reveal.block, null);
  const r = await byHand('reveal', { now: NOW + 200 * DAY });
  assert.equal(r.project, 'drafted', 'not held by the 90 days, the photos or the video');
  assert.equal(only().subject, 'Rowan’s Dream Room Is Complete');
  assert.ok(!/Watch the Reveal/.test(only().content), 'no video, so no video button');
  // The hourly look leaves it be
  await hourly(NOW + 201 * DAY);
  assert.equal(kit.broadcasts.size, 1);
});

test('by hand: deleted in Kit, it can be drafted again; scheduled or sent, never', async () => {
  await writeConfig(env.DB, { enabled: true, kitInvite: { reviewer: 'linzi@soardcharity.com' } });
  await byHand('kickoff');
  const first = String(only().id);
  kit.broadcasts.get(first).status = 'scheduled';
  kit.broadcasts.get(first).send_at = new Date(NOW + DAY).toISOString();
  const again = await byHand('kickoff');
  assert.equal(again.project, 'unchanged');
  assert.equal(again.state, 'scheduled');
  kit.broadcasts.clear();
  assert.equal((await projectEmailStatus(env, SLUG, { now: NOW })).kickoff.state, 'deleted');
  const r = await byHand('kickoff');
  assert.equal(r.project, 'drafted');
  assert.equal(kit.calls.filter((c) => c === 'POST /broadcasts').length, 2, 'a new draft (the fake reuses ids once cleared)');
  assert.equal(kit.broadcasts.size, 1);
  assert.equal(String((await readProjectRow(env.DB, SLUG, 'kickoff')).broadcast_id), String(r.id));
});

test('by hand: Kit not answering drafts nothing, and says so', async () => {
  await writeConfig(env.DB, { enabled: true, kitInvite: { reviewer: 'linzi@soardcharity.com' } });
  await byHand('kickoff');
  kit.readDown = true;
  const r = await byHand('kickoff');
  assert.equal(r.project, 'error');
  assert.match(r.error, /Kit couldn’t be reached/);
  assert.equal(kit.broadcasts.size, 1);
  const st = await projectEmailStatus(env, SLUG, { now: NOW });
  assert.equal(st.kickoff.state, 'draft', 'as the site last knew it');
  assert.equal(st.kickoff.unread, true);
});

test('by hand: off while invites are paused, and with no one to say who asked', async () => {
  await writeConfig(env.DB, { enabled: false });
  assert.equal((await byHand('kickoff')).project, 'off');
  assert.match((await projectEmailStatus(env, SLUG)).off, /paused/);
  await writeConfig(env.DB, { enabled: true, kitInvite: { reviewer: 'linzi@soardcharity.com' } });
  assert.equal((await byHand('kickoff', { by: 'unknown' })).project, 'error');
  assert.equal((await byHand('invite')).project, 'error');
  assert.equal(kit.broadcasts.size, 0);
});

test('status: each email as Kit has it, and what the page still needs', async () => {
  await writeConfig(env.DB, { enabled: true, kitInvite: { reviewer: 'linzi@soardcharity.com' } });
  let st = await projectEmailStatus(env, SLUG, { now: NOW });
  assert.equal(st.off, null);
  assert.deepEqual(st.page, { published: true, completed: false });
  assert.equal(st.kickoff.state, 'none');
  assert.equal(st.kickoff.block, null);
  assert.match(st.reveal.block, /Completed/);
  await byHand('kickoff');
  st = await projectEmailStatus(env, SLUG, { now: NOW });
  assert.equal(st.kickoff.state, 'draft');
  assert.equal(String(st.kickoff.id), String(only().id));
  kit.broadcasts.get(String(only().id)).status = 'completed';
  kit.broadcasts.get(String(only().id)).published_at = new Date(NOW).toISOString();
  assert.equal((await projectEmailStatus(env, SLUG, { now: NOW })).kickoff.state, 'sent');
});

// ─── Found by the eighth independent review (Nov 9 2026) ───

test('a diagnosis never ends a line on "&"', () => {
  const html = projectKickoffEmail({ kid: { ...KID, diagnosis: 'Autism Spectrum Disorder & Global Development Delays' } }).html;
  assert.match(html, />Autism Spectrum Disorder &amp;&nbsp;Global Development&nbsp;Delays</);
  assert.match(projectKickoffEmail({ kid: { ...KID, diagnosis: 'Spina Bifida, Deaf, & Blind' } }).html, />Spina Bifida, Deaf,&nbsp;&amp;&nbsp;Blind</);
  assert.match(projectKickoffEmail({ kid: { ...KID, diagnosis: 'Spina Bifida, Neurogenic Bowel and Bladder' } }).html, />Spina Bifida, Neurogenic Bowel&nbsp;and&nbsp;Bladder</);
});

test('a name typed with a stray space reads right everywhere', () => {
  const kid = { ...KID, name: ' Max  ' };
  const inv = revealInviteEmail({ kid, date: '2027-03-12', time: '16:00' });
  const kick = projectKickoffEmail({ kid });
  const rev = projectRevealEmail({ kid: { ...DONE, name: 'Max ' } });
  assert.equal(inv.subject, 'You’re Invited to Max’s Reveal Day!');
  assert.equal(kick.subject, 'Meet Max, Our Next Dream Room Project');
  assert.equal(rev.subject, 'Max’s Dream Room Is Complete');
  for (const e of [inv, kick, rev]) assert.ok(!/Max ’|Max ,|Max  /.test(e.html + e.text + e.preview));
});

test('two kids joined by "and" read like two kids joined by "&"', () => {
  const inv = revealInviteEmail({ kid: { ...KID, name: 'Remi and Nico' }, date: '2027-03-12', time: '16:00' }).html;
  assert.match(inv, /Remi, Nico, and the family haven’t seen/);
});

test('a ramp and lift stays one phrase in the headline, and a gallery that won’t load isn’t promised', async () => {
  const e = projectRevealEmail({ kid: { ...DONE, name: 'Noah', roomTypes: ['Wheelchair Ramp', 'Chair Lift'], roomCount: 2 } });
  assert.match(e.html, /Noah’s<\/span> Ramp&nbsp;and&nbsp;Lift<br>Are&nbsp;<em/);
  const { PHOTO_TRANSFORM, HERO_TRANSFORM, cfImg } = await import('../functions/api/_reveal-invite-email.js');
  const kid = { ...DONE, videoUrl: '', streamVideoId: '' };
  const broken = new Set([...kid.photos.map((ph) => cfImg(ph.url, PHOTO_TRANSFORM)), ...kid.photos.map((ph) => cfImg(ph.url, HERO_TRANSFORM))]);
  const r = projectRevealEmail({ kid, brokenLogos: broken });
  assert.ok(!/See the Photos|See all \d+ photos/.test(r.html));
  assert.match(r.html, /Read the Story</);
});

test('a partner’s name card is in even lines at the largest size that fits', async () => {
  const { nameCard } = await import('../functions/api/_reveal-invite-email.js');
  assert.deepEqual(nameCard('Bin There Dump That Atlanta'), { size: 13, lines: ['Bin There', 'Dump That', 'Atlanta'] });
  assert.deepEqual(nameCard('MSI'), { size: 13, lines: ['MSI'] });
  assert.equal(nameCard('Jude & Jojos').lines.some((l) => /&$/.test(l)), false, 'a line never ends on "&"');
  const long = nameCard('Interdenominational');
  assert.ok(long.size >= 9 && long.size < 13);
});

test('an SVG logo counts as broken: Gmail and Outlook show nothing for one', async () => {
  const { brokenLogos } = await import('../functions/api/_reveal-invite-kit.js');
  const kid = { partnerLogos: [{ url: `${IMG}/partners/svg/public`, name: 'Bell Cabinetry' }, { url: `${IMG}/partners/png/public`, name: 'MSI' }] };
  const fetchImpl = async (url) => new Response('x', { headers: { 'content-type': /partners\/svg/.test(url) ? 'image/svg+xml' : 'image/png' } });
  const broken = await brokenLogos(kid, { fetchImpl });
  const html = projectRevealEmail({ kid: { ...DONE, partnerLogos: kid.partnerLogos }, brokenLogos: broken }).html;
  assert.ok(!/partners\/svg\//.test(html), 'no SVG picture');
  assert.match(html, />Bell&nbsp;Cabinetry<|>Bell<br>Cabinetry</);
  assert.match(html, /partners\/png\//);
});

test('a hyphenated word keeps together: a note’s last word, and a diagnosis', async () => {
  const { noWidow } = await import('../functions/api/_reveal-invite-email.js');
  assert.equal(noWidow('park at the end of the cul-de-sac.'), 'park at the end of the&nbsp;<span style="white-space:nowrap;">cul-de-sac.</span>');
  const html = projectKickoffEmail({ kid: { ...KID, diagnosis: 'Cortical Visual Impairment, Non-Verbal, Rubinstein-Taybi Syndrome' } }).html;
  // A no-break hyphen (U+2011), so the last-two-words rule can hold "Reflex, Non‑Verbal" together too
  assert.match(html, />Cortical Visual Impairment, Non\u2011Verbal, Rubinstein\u2011Taybi Syndrome</, 'a pair longer than a phone line keeps its space');
  const summer = projectKickoffEmail({ kid: { ...KID, diagnosis: 'Cortical Visual Impairment, Startle Reflex, Non-Verbal' } }).html;
  assert.match(summer, /Startle Reflex,&nbsp;Non\u2011Verbal</);
  // A long hyphenated room breaks only after its hyphen: "Wheelchair- / Accessible Bathroom"
  assert.match(projectKickoffEmail({ kid: { ...KID, roomTypes: ['Wheelchair-Accessible Bathroom'] } }).html, />Wheelchair-Accessible&nbsp;Bathroom<\/td>/);
  const inv = revealInviteEmail({ kid: { ...KID, name: 'Amanda, Caleb & Isaac' }, date: '2027-03-12', time: '16:00' }).html;
  assert.match(inv, />Amanda, Caleb &amp;&nbsp;Isaac’s&nbsp;Home</);
});

test('a logo is asked for twice before it’s left out, so one dropped connection never makes a name card', async () => {
  const { brokenLogos } = await import('../functions/api/_reveal-invite-kit.js');
  const kid = { partnerLogos: [{ url: `${IMG}/partners/flaky/public`, name: 'Flaky' }, { url: `${IMG}/partners/gone/public`, name: 'Gone' }] };
  const asked = new Map();
  const fetchImpl = async (url) => {
    asked.set(url, (asked.get(url) || 0) + 1);
    if (/flaky/.test(url) && asked.get(url) === 1) throw new TypeError('connection reset');
    return new Response('x', { status: /gone/.test(url) ? 404 : 200, headers: { 'content-type': 'image/png' } });
  };
  const broken = [...(await brokenLogos(kid, { fetchImpl }))].join(' ');
  assert.ok(!/flaky/.test(broken), 'a second try that loads is a logo');
  assert.match(broken, /gone/, 'two misses is gone');
});

// ─── Found by the ninth independent review (Nov 9 2026) ───

test('quotes signed at length, signed without marks, and with a quote inside, all read right', () => {
  const q = (quote) => projectRevealEmail({ kid: { ...DONE, quote } }).html.match(/padding:4px 0 4px 22px[^>]*>([\s\S]*?)<\/td>/)[1];
  assert.match(q('"It is everything he wanted, a room of his own" - Monique and Darnell, Jaylen\'s parents and biggest fans'),
    /^“It is everything he wanted, a room of his&nbsp;own”<span [^>]*>–&nbsp;Monique and&nbsp;Darnell, Jaylen’s parents and&nbsp;biggest&nbsp;fans<\/span>$/, '"and" goes with the word after it');
  assert.match(q('We love it so much. - Monique and Darnell, Jaylen\'s parents'), /^“We love it so&nbsp;much\.”<span [^>]*>–&nbsp;Monique and&nbsp;Darnell, Jaylen’s&nbsp;parents<\/span>$/);
  assert.equal(q('"He said "wow" and cried."'), '“He said ‘wow’ and&nbsp;cried.”');
  assert.equal(q('He said "wow" and cried.'), '“He said ‘wow’ and&nbsp;cried.”');
  assert.equal(q('It was amazing - The whole family cried.'), '“It was amazing\u00A0– The whole family&nbsp;cried.”', 'a sentence after a dash isn’t a signature');
});

test('typed bullets in the team’s note are dropped, and only an arrival note stands in for ours', () => {
  const e = revealInviteEmail({ kid: KID, date: '2027-03-12', time: '16:00', notes: '- Park on the street\n* Use the side gate\n• Bring a smile' });
  assert.match(e.html, />Park on the&nbsp;street</);
  assert.match(e.html, />Use the side&nbsp;gate</);
  assert.ok(!/>[-*•] /.test(e.html));
  assert.match(e.html, /Please arrive 15 minutes early/);
  assert.match(revealInviteEmail({ kid: KID, date: '2027-03-12', time: '16:00', notes: 'Rowan’s Early Intervention team will be there.' }).html, /Please arrive 15 minutes early/);
  assert.ok(!/Please arrive 15 minutes early/.test(revealInviteEmail({ kid: KID, date: '2027-03-12', time: '16:00', notes: 'Please come 20 minutes early.' }).html));
  assert.ok(!/Please arrive 15 minutes early/.test(revealInviteEmail({ kid: KID, date: '2027-03-12', time: '16:00', notes: 'Be there 10 mins early!' }).html));
});

test('file names are never partner names; ramps counted by the page are still ramps; a hyphenated name card breaks at its hyphen', async () => {
  const { partnerLabel, nameCard, makeoverWord } = await import('../functions/api/_reveal-invite-email.js');
  for (const n of ['MAW_Georgia_CMYK C_76633', 'F38FA186-88E1-4C2B-9F0A-1234567890AB_1_105_c', '27576835_1529384_n']) assert.equal(partnerLabel(n), '', n);
  assert.equal(partnerLabel('Make-A-Wish Georgia'), 'Make-A-Wish Georgia');
  assert.equal(partnerLabel('1-800-FIGUREITOUT'), '1-800-FIGUREITOUT');
  assert.equal(makeoverWord(['Wheelchair Ramps'])?.label, 'Project');
  assert.deepEqual(nameCard('Sherwin-Williams'), { size: 13, lines: ['Sherwin-', 'Williams'] });
});

test('the header logo has as much room above it as below, and a Kickoff with no story still links to the page', async () => {
  const { LOGO_MARK } = await import('../functions/api/_reveal-invite-email.js');
  for (const e of [revealInviteEmail({ kid: KID, date: '2027-03-12', time: '16:00' }), projectKickoffEmail({ kid: KID }), projectRevealEmail({ kid: DONE })]) {
    assert.match(e.html, /padding:28px 0 14px;[^"]*"[^>]*>\s*<a [^>]*><img src="[^"]*trim=92;94;123;96[^"]*" width="96"/);
    assert.equal(e.html.split(LOGO_MARK).length - 1, 2, 'header and footer');
  }
  const bare = projectKickoffEmail({ kid: { ...KID, heroSummary: '', bio: '' } }).html;
  assert.match(bare, /Read Rowan’s&nbsp;story&nbsp;→/);
  const noDate = revealInviteEmail({ kid: KID, date: '', time: '' }).text;
  assert.ok(!/Watch it live/.test(noDate), 'the text offers only what the email does');
});

// ─── Found by the tenth independent review (Nov 9 2026) ───

test('iPhone Mail’s detected dates and addresses keep the email’s own look, and a typed email address is a link in the note’s colors', () => {
  const e = revealInviteEmail({ kid: KID, date: '2027-03-12', time: '16:00', notes: 'Questions? Email events@soardcharity.com.' }).html;
  assert.match(e, /a\[x-apple-data-detectors\]\{color:inherit!important;text-decoration:none!important;/);
  assert.match(e, /<a href="mailto:events@soardcharity\.com" style="color:#FFFFFF;[^"]*">events@soardcharity\.com<\/a>/, 'a short address stays whole');
  assert.match(revealInviteEmail({ kid: KID, date: '2027-03-12', time: '16:00', notes: 'Email info@sunshineonaranneyday.com' }).html, />info@&#8203;sunshineonaranneyday\.com<\/a>/, 'a long one may break after its @, never mid-letter');
});

test('an address breaks only after a comma, and the city stays with its state and ZIP', async () => {
  const { addressLines } = await import('../functions/api/_reveal-invite-email.js');
  const nb = (t) => t.replace(/ /g, ' ');
  assert.equal(addressLines('4521 Lakeview Trace, Peachtree Corners, GA 30092'), `${nb('4521 Lakeview Trace')}, ${nb('Peachtree Corners, GA 30092')}`);
  assert.equal(addressLines('100 Example Way, Johns Creek, GA 30022'), `${nb('100 Example Way')}, ${nb('Johns Creek, GA 30022')}`);
  // A street too long for a phone line keeps its spaces
  assert.equal(addressLines('1234 Peachtree Industrial Boulevard Northwest, Duluth, GA 30097'), `1234 Peachtree Industrial Boulevard Northwest, ${nb('Duluth, GA 30097')}`);
});

test('a typed "--" reads as a dash; the last two words of a diagnosis or a room stay together', async () => {
  const { tidy } = await import('../functions/api/_reveal-invite-email.js');
  assert.equal(tidy('Park on the street -- the drive is tight'), 'Park on the street\u00A0– the drive is tight');
  assert.equal(tidy('well--known'), 'well\u00A0– known');
  const max = projectKickoffEmail({ kid: { ...KID, age: 6, diagnosis: 'Multiple Sulfatase Deficiency', roomTypes: ['Accessible Bathroom', 'Dream Bedroom'], bathroomCount: 2, bedroomCount: 3, roomCount: 5 } }).html;
  assert.match(max, />Multiple Sulfatase&nbsp;Deficiency</);
  assert.match(max, />Two Accessible&nbsp;Bathrooms<\/td>/);
  assert.match(max, />Three Dream&nbsp;Bedrooms<\/td>/);
  // Ages stay as they were: "8, 11 & 13"
  assert.match(projectKickoffEmail({ kid: { ...KID, age: [8, 11, 13] } }).html, />8, 11&nbsp;&amp;&nbsp;13</);
});

test('the cover is only ever a picture that was checked, and "Photos by" only shows with photos', async () => {
  const { HERO_TRANSFORM, PHOTO_TRANSFORM, cfImg, leadPhoto } = await import('../functions/api/_reveal-invite-email.js');
  const kid = { ...DONE, heroImage: `${IMG}/kids/rowan-test/h.jpg/public`, photos: ['a', 'b', 'c', 'd'].map((x) => ({ url: `${IMG}/kids/rowan-test/${x}.jpg/public` })) };
  const firstThree = [kid.heroImage, ...kid.photos.slice(0, 2).map((p) => p.url)];
  const broken = new Set(firstThree.flatMap((u) => [cfImg(u, HERO_TRANSFORM), cfImg(u, PHOTO_TRANSFORM)]));
  assert.equal(leadPhoto(kid, broken), '', 'the fourth was never checked, so it isn’t used');
  const inv = revealInviteEmail({ kid: { ...KID, photographer: 'Niki Murphy', heroImage: '', photos: [] }, date: '2027-03-12', time: '16:00' }).html;
  assert.ok(!/Photos by/.test(inv));
});

// ─── Found by the eleventh independent review (Nov 9 2026) ───

test('a mixed or ramp Reveal headline is the same size as a room’s; two names stay whole; a three-kid Kickoff isn’t 50px', () => {
  const size = (html) => Number(html.match(/<h1 class="[^"]*" style="[^"]*font-size:(\d+)px/)[1]);
  const room = size(projectRevealEmail({ kid: { ...DONE, name: 'Jordan' } }).html);
  const mixed = projectRevealEmail({ kid: { ...DONE, name: 'Jordan', roomTypes: ['Dream Bedroom', 'Wheelchair Ramp'], roomCount: 2 } }).html;
  assert.equal(size(mixed), room);
  assert.match(mixed, /Jordan’s<\/span> Makeover<br>Is&nbsp;/);
  const remi = revealInviteEmail({ kid: { ...KID, name: 'Remi & Nico' }, date: '2027-03-12', time: '16:00' }).html;
  assert.match(remi, /<span style="white-space:nowrap;">Remi &amp; Nico’s<\/span>/);
  assert.ok(size(projectKickoffEmail({ kid: { ...KID, name: 'Amanda, Caleb & Isaac' } }).html) <= 40);
});

test('JobTread’s multi-choice rooms read as a list; the preview with only photos reads whole; spacing with few photos', () => {
  const inv = revealInviteEmail({ kid: { ...KID, roomTypes: [] }, room: 'Bedroom,Bathroom', date: '2027-03-12', time: '16:00' });
  assert.match(inv.html, />Bedroom and&nbsp;Bathroom<\/div>/);
  assert.match(inv.html, />Rooms<\/div>/);
  assert.match(inv.preview, /brand-new bedroom and bathroom!/);
  assert.equal(projectRevealEmail({ kid: { ...DONE, videoUrl: '', partnerLogos: [] } }).preview, 'See Rowan’s transformation in the photos.');
  const few = revealInviteEmail({ kid: { ...KID, photos: [] }, date: '2027-03-12', time: '16:00' }).html;
  assert.match(few, /padding:0px 0 0;[^"]*" class="pd">\s*<div style="padding-top:16px;"><a /, 'the story link 16px under the story');
  const bare = projectKickoffEmail({ kid: { ...KID, heroImage: '', photos: [] } }).html;
  assert.match(bare, /<h1 class="[^"]*" style="margin:0 0 0px;/, 'no picture: no gap under the headline');
});

// ─── Found by the twelfth independent review (Nov 9 2026) ───

test('a Kickoff bio that opens "Meet Dylan, a…" says it once under the "Meet Dylan." headline', () => {
  const html = projectKickoffEmail({ kid: { ...KID, name: 'Dylan', heroSummary: '', bio: '<p>Meet Dylan, a teenager with a quiet sense of humor and a playful spirit.</p>' } }).html;
  assert.match(html, /class="ld"[^>]*>Dylan is a teenager with a quiet sense of humor/);
  assert.match(projectKickoffEmail({ kid: { ...KID, name: 'Remi & Nico', heroSummary: '', bio: '<p>Meet Remi &amp; Nico, two brothers who love trains and music.</p>' } }).html, /class="ld"[^>]*>Remi &amp;&nbsp;Nico are two brothers/);
  // The invite keeps the page's own words under "Dylan’s story"
  assert.match(revealInviteEmail({ kid: { ...KID, name: 'Dylan', heroSummary: '', bio: '<p>Meet Dylan, a teenager with a quiet sense of humor and a playful spirit.</p>' }, date: '2027-03-12', time: '16:00' }).html, /Meet Dylan, a teenager/);
});

test('our arrival line steps aside only for the team’s own arrival time or "arrive early"', () => {
  const ours = (notes) => /Please arrive 15 minutes early/.test(revealInviteEmail({ kid: KID, date: '2027-03-12', time: '16:00', notes }).html);
  for (const n of ['Please be there by 3:30', 'Gather at 3:30 pm', 'Plan to be here no later than 3:40', 'Please arrive at least 15 mins early!', 'Please arrive early']) assert.equal(ours(n), false, n);
  for (const n of ['Arrival parking is at the church', 'Kids can come early to make signs', 'Park on the street', 'The Early Intervention team will be there']) assert.equal(ours(n), true, n);
});

test('a dash never starts a line, and "and" between names stays with the name after it', async () => {
  const { tidy, label, textLink } = await import('../functions/api/_reveal-invite-email.js');
  assert.equal(tidy('a productive member of society - to give back'), 'a productive member of society – to give back');
  assert.match(label('Jean-Luc and Marie’s story'), />Jean-Luc and&nbsp;Marie’s&nbsp;story</);
  assert.match(textLink('Read Jean-Luc and Marie’s story →', 'https://x'), /Jean-Luc and&nbsp;Marie’s&nbsp;story&nbsp;→/);
  // "& Hearing Impaired" keeps together, so "Impaired" never ends a line alone
  assert.match(projectKickoffEmail({ kid: { ...KID, diagnosis: 'Down Syndrome, Autism & Hearing Impaired' } }).html, />Down Syndrome, Autism &amp;&nbsp;Hearing&nbsp;Impaired</);
});

test('a name card never ends a line on a small joining word: "Friends / & Family / of Max Daniel"', async () => {
  const { nameCard } = await import('../functions/api/_reveal-invite-email.js');
  const c = nameCard('Friends & Family of Max Daniel');
  assert.deepEqual(c.lines, ['Friends', '& Family', 'of Max Daniel']);
  assert.ok(c.lines.slice(0, -1).every((l) => !/(^|\s)(&|and|of|the|for|to)$/i.test(l)));
});

// ─── Edit words (Nov 11 2026): /api/email-words-admin on a kid's Kickoff ───

const asStaff = (body) => ({ env, data: { userEmail: 'linzi@soardcharity.com' }, request: new Request('https://x/api/email-words-admin', { method: 'POST', body: JSON.stringify(body) }) });

test('Edit words: the box shows the site’s own words, a preview saves nothing, and saving brings an untouched draft up quietly', async () => {
  const api = await import('../functions/api/email-words-admin.js');
  const { readWords } = await import('../functions/api/_email-words.js');
  await writeConfig(env.DB, config);
  const row = await drafted();
  const key = `kickoff:${SLUG}`;
  const got = await (await api.onRequestGet({ env, request: new Request(`https://x/api/email-words-admin?key=${key}`) })).json();
  assert.equal(got.ok, true);
  assert.deepEqual(got.parts.map((p) => p.key), ['subject', 'preview', 'opening', 'askHeadline', 'askWords', 'closing']);
  assert.equal(got.siteWords.subject, 'Meet Rowan, Our Next Dream Room Project');
  assert.equal(got.siteWords.askHeadline, 'Help us build Rowan’s *dream*.');
  assert.deepEqual(got.words, {});
  // A preview: her words in the email, nothing kept, nothing sent to Kit
  kit.puts.length = 0;
  const seen = await (await api.onRequestPost(asStaff({ key, words: { subject: 'Rowan’s room starts Monday' }, preview: true }))).json();
  assert.equal(seen.email.subject, 'Rowan’s room starts Monday');
  assert.deepEqual((await readWords(env.DB, key)).words, {});
  assert.equal(kit.puts.length, 0);
  // Saved: the draft in Kit has them, and nobody is emailed
  const sent = emails.length;
  const r = await (await api.onRequestPost(asStaff({ key, words: { subject: 'Rowan’s room starts Monday', askWords: 'Every gift counts.' } }))).json();
  assert.equal(r.result, 'updated', JSON.stringify(r));
  assert.match(r.message, /has your words now/);
  assert.equal(kit.puts.length, 1);
  assert.equal(kit.broadcasts.get(row.broadcast_id).subject, 'Rowan’s room starts Monday');
  assert.match(kit.broadcasts.get(row.broadcast_id).content, /Every gift&nbsp;counts\./);
  assert.equal(emails.length, sent);
  assert.equal((await readProjectRow(env.DB, SLUG, 'kickoff')).refresh, null, 'done, nothing owed');
  // All boxes emptied: back to the site's own words
  const back = await (await api.onRequestPost(asStaff({ key, words: {} }))).json();
  assert.equal(back.result, 'updated');
  assert.match(back.message, /the site’s own words again/);
  assert.equal(kit.broadcasts.get(row.broadcast_id).subject, 'Meet Rowan, Our Next Dream Room Project');
});

test('Edit words: a draft someone changed in Kit is left as they made it, and saying so; none in Kit yet takes them when drafted', async () => {
  const api = await import('../functions/api/email-words-admin.js');
  await writeConfig(env.DB, config);
  // Not drafted yet: kept for when it is
  await queued('kickoff');
  const first = await (await api.onRequestPost(asStaff({ key: `kickoff:${SLUG}`, words: { closing: 'With love, the SOARD crew.' } }))).json();
  assert.equal(first.result, 'saved');
  assert.match(first.message, /when it’s drafted/);
  const r = await look('kickoff');
  assert.equal(r.project, 'drafted');
  const row = await readProjectRow(env.DB, SLUG, 'kickoff');
  const b = kit.broadcasts.get(row.broadcast_id);
  assert.match(b.content, /With love, the SOARD&nbsp;crew\./, 'drafted with her words');
  // A person edits it in Kit; new words leave it alone
  b.subject = 'Linzi’s own subject';
  kit.puts.length = 0;
  const later = await (await api.onRequestPost(asStaff({ key: `kickoff:${SLUG}`, words: { closing: 'Something new.' } }))).json();
  assert.equal(later.result, 'edited');
  assert.match(later.message, /leaves it as they made it/);
  assert.equal(kit.puts.length, 0);
  assert.equal(b.subject, 'Linzi’s own subject');
});

test('Edit words: the hourly look finishes what Kit didn’t take, never on a draft a person changed', async () => {
  const { saveWords } = await import('../functions/api/_email-words.js');
  const row = await drafted();
  await saveWords(env.DB, `kickoff:${SLUG}`, { subject: 'Rowan’s room starts Monday' });
  await env.DB.prepare("UPDATE project_emails SET refresh = 'words' WHERE slug = ?").bind(SLUG).run();
  await writeConfig(env.DB, config);
  const out = await runProjectEmails(env, { now: NOW + DAY });
  assert.ok(out.some((o) => o.project === 'redesigned'), JSON.stringify(out));
  assert.equal(kit.broadcasts.get(row.broadcast_id).subject, 'Rowan’s room starts Monday');
  assert.equal((await readProjectRow(env.DB, SLUG, 'kickoff')).refresh, null);
});
