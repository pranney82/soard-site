/**
 * The site's look at a before photo (functions/api/_photo-screen.js): the model only answers questions; plain code
 * decides, and anything unsure keeps a photo off. Peter, Nov 12 2026: "you can review those photos and leave off the
 * ones you think arent good to publish?" Tried on Max's and Dylan's 88 real Before photos the same day: every one with
 * a person (a reflection in a mirror, two people in a far room), framed family photos, a screenshot, the panel, a
 * plumbing hole, boxes or a tape measure was kept off.
 * Run: node --test tests/photo-screen.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgePhoto, screenPhoto, screenUrl, QUESTIONS, SCREEN_MODEL, SCREEN_REQUEST, AiDown, Refused } from '../functions/api/_photo-screen.js';

const no = () => Object.fromEntries(QUESTIONS.map((q) => [q.key, false]));

test('a photo shows only when every question is answered no; the first yes says why, in our words', () => {
  assert.deepEqual(judgePhoto(no()), { show: true, why: '', answers: no() });
  assert.equal(judgePhoto({ ...no(), person: true }).why, 'A person in it');
  assert.equal(judgePhoto({ ...no(), boxes: true, noRoom: true }).why, 'Boxes or deliveries', 'the first in the list');
  // Not answered, or answered with something that isn't yes or no: kept off, as a yes
  const { noRoom, ...rest } = no();
  assert.deepEqual([judgePhoto(rest).show, judgePhoto(rest).why], [false, 'Not a picture of the room']);
  assert.equal(judgePhoto({ ...no(), screen: 'maybe' }).show, false);
  assert.equal(judgePhoto(null).show, false);
  // Words a model may give instead of booleans
  assert.equal(judgePhoto(Object.fromEntries(QUESTIONS.map((q) => [q.key, 'No']))).show, true);
  assert.equal(judgePhoto({ ...no(), peoplePictures: 'yes, on the shelf' }).why, 'Photos of people in it');
  // Every reason is short and plain, with no em dash
  for (const q of QUESTIONS) assert.ok(q.why.split(' ').length <= 6 && !/—/.test(q.why + q.ask), q.key);
});

test('the model is asked every question, for JSON first, through the site’s gateway as before-photos', async () => {
  const seen = [];
  const env = { AI: { run: async (model, input, opts) => { seen.push({ model, input, opts }); return { response: { ...no(), person: true } }; } } };
  const r = await screenPhoto(env, { bytes: new Uint8Array([1, 2, 3]), type: 'image/jpeg' });
  assert.deepEqual([r.show, r.why], [false, 'A person in it']);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].model, SCREEN_MODEL);
  assert.deepEqual(seen[0].opts.gateway, { id: 'soard-site', collectLog: false, metadata: { feature: 'before-photos' } });
  assert.deepEqual(seen[0].input.response_format.json_schema.required, QUESTIONS.map((q) => q.key));
  assert.equal(seen[0].input.temperature, 0);
  const user = seen[0].input.messages[1].content;
  assert.match(user[0].text, /person: Is a person/);
  assert.equal(user[1].image_url.url, 'data:image/jpeg;base64,AQID');
  assert.match(SCREEN_REQUEST.prompt, /When you are not sure, answer true/);
});

test('JSON refused: asked again in plain words; an answer that won’t read: null (the photo’s, tried again later); the model down, slow or unbound: AiDown (nobody’s fault); a spending cap: thrown', async () => {
  let n = 0;
  const plain = { AI: { run: async (_m, input) => { n++; if (input.response_format) throw new Error('5006: response_format not supported'); return { response: `Sure: ${JSON.stringify(no())}` }; } } };
  assert.equal((await screenPhoto(plain, { bytes: new Uint8Array([1]) })).show, true);
  assert.equal(n, 2);
  const silent = { AI: { run: async () => ({ response: 'I cannot help with that.' }) } };
  assert.equal(await screenPhoto(silent, { bytes: new Uint8Array([1]) }), null);
  const capped = { AI: { run: async () => { throw new Error("2045: Spend limit exceeded: rule 'site-day'"); } } };
  await assert.rejects(screenPhoto(capped, { bytes: new Uint8Array([1]) }), /2045/);
  await assert.rejects(screenPhoto({}, { bytes: new Uint8Array([1]) }), (e) => e instanceof AiDown && /isn’t bound/.test(e.message), 'no AI binding');
  // Too slow, both times: the model's, not the photo's
  let tries = 0;
  const slow = { AI: { run: () => { tries++; return new Promise((res) => setTimeout(() => res({ response: no() }), 1500)); } } };
  await assert.rejects(screenPhoto(slow, { bytes: new Uint8Array([1]) }, { timeoutMs: 1000 }), (e) => e instanceof AiDown && /took too long/.test(e.message));
  assert.equal(tries, 1, 'a model too slow once isn’t asked again (it would be slow again)');
  // An answer that won't read gets its second try only with time for it
  let asked = 0;
  const odd = { AI: { run: async () => { asked++; return { response: 'hmm' }; } } };
  assert.equal(await screenPhoto(odd, { bytes: new Uint8Array([1]) }, { canRetry: () => false }), null);
  assert.equal(asked, 1);
  const busy = { AI: { run: async () => { throw new Error('3040: Capacity temporarily exceeded'); } } };
  await assert.rejects(screenPhoto(busy, { bytes: new Uint8Array([1]) }), (e) => e instanceof AiDown && /3040/.test(e.message));
});

test('the model sees Cloudflare Images’ own resize of the picture', () => {
  assert.equal(screenUrl('https://imagedelivery.net/H/kids/max/before-1.jpg/public'), 'https://imagedelivery.net/H/kids/max/before-1.jpg/w=1280,h=1280,fit=scale-down,q=85,format=jpeg');
  assert.equal(screenUrl('https://example.com/a.jpg'), 'https://example.com/a.jpg');
});

test('the picture turned away (not the service down or busy): Refused, with Workers AI’s words; the service’s trouble: AiDown; no binding: AiDown, certainly the service’s', async () => {
  const refuse = { AI: { run: async () => { throw new Error('3010: Invalid or incomplete input for the model'); } } };
  await assert.rejects(screenPhoto(refuse, { bytes: new Uint8Array([1]) }), (e) => e instanceof Refused && /Workers AI turned it away: 3010: Invalid or incomplete input/.test(e.message));
  const retired = { AI: { run: async () => { throw new Error('5007: No such model'); } } };
  await assert.rejects(screenPhoto(retired, { bytes: new Uint8Array([1]) }), (e) => e instanceof Refused && /5007/.test(e.message), 'the setup’s, as far as this photo knows: the caller decides by whether others are answered');
  const upstream = { AI: { run: async () => { throw new Error('InferenceUpstreamError: 503 Service Unavailable'); } } };
  await assert.rejects(screenPhoto(upstream, { bytes: new Uint8Array([1]) }), (e) => e instanceof AiDown && !e.wide);
  await assert.rejects(screenPhoto({}, { bytes: new Uint8Array([1]) }), (e) => e instanceof AiDown && e.wide);
});
