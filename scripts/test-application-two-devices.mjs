/**
 * test-application-two-devices.mjs — one application on a phone and a laptop
 * ==========================================================================
 * A family starts on a phone, opens the emailed link on a laptop and answers further
 * there, and the phone's tab is still open. Against the real Pages Functions (wrangler
 * pages dev with local D1), with the laptop's saves sent straight to /api/apply:
 *   - looked at again, the phone brings in the laptop's answers (and says so), and a
 *     change typed on the phone meanwhile stays the phone's
 *   - the phone's own save a few seconds later doesn't undo the laptop's newer answer
 *   - the draft ends up with both
 *
 * Usage: SITE=http://127.0.0.1:8791 node scripts/test-application-two-devices.mjs
 */
import puppeteer from 'puppeteer';

const SITE = (process.env.SITE || 'http://127.0.0.1:8791').replace(/\/$/, '');
const failures = [];
const ok = (cond, msg) => { if (!cond) failures.push(msg); console.log(`${cond ? '  ✓' : '  ✗'} ${msg}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const api = async (body) => (await fetch(`${SITE}/api/apply`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: SITE }, body: JSON.stringify(body) })).json();

// The season the page is taking applications for
const year = ((await (await fetch(`${SITE}/apply/form/`)).text()).match(/data-year="(\d{4})"/) || [])[1];
const st = await api({ action: 'start', kind: 'family', year, lang: 'en' });
if (!st.ok) { console.log(`Could not start an application: ${st.error || 'no answer'}`); process.exit(1); }
const token = st.token;
const phoneAnswers = {
  ackParameters: 'I understand', ackSeason: 'I understand',
  childName: { first: 'Avery', last: 'Stone' }, birthdate: '2016-04-02', gender: 'Female', diagnosis: 'Cerebral palsy', previouslyApplied: 'No',
  parentName: { first: 'Jordan', last: 'Stone' }, parentEmail: 'jordan@example.com', parentPhone: '(404) 555-0100', parentRelation: 'Mother',
};
let r = await api({ action: 'save', token, answers: phoneAnswers, page: 'parents', lang: 'en', rev: 0, changed: Object.keys(phoneAnswers) });
ok(r.ok && r.rev === 1, `the phone's first save is save 1 (${r.rev})`);

// 'shell': keeps working while the Mac's display sleeps
const browser = await puppeteer.launch({ headless: 'shell', args: ['--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await page.goto(`${SITE}/apply/form/?resume=${token}`, { waitUntil: 'networkidle0' });
  await sleep(1200);
  ok(await page.evaluate(() => document.documentElement.classList.contains('af-focus')), 'the link opens the application on the phone');

  console.log('The laptop: the emailed link, two answers further on');
  const lap = await api({ action: 'resume', token });
  ok(lap.ok && lap.rev === 1, `the laptop opens save 1 (${lap.rev})`);
  r = await api({ action: 'save', token, answers: { ...lap.answers, interests: 'Dinosaurs and space', diagnosisImpact: 'She uses a walker at home.' }, page: 'child', lang: 'en', rev: lap.rev, changed: ['interests', 'diagnosisImpact'] });
  ok(r.ok && r.rev === 2 && !r.theirs, `its save is save 2, nothing of anyone else's in it (${r.rev})`);

  console.log('Back on the phone: a change typed, then the phone looked at again');
  await page.evaluate(() => { const i = document.getElementById('af-parentPhone'); i.value = '(770) 555-0142'; i.dispatchEvent(new Event('input', { bubbles: true })); });
  await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await sleep(2500);
  const after = await page.evaluate(() => ({
    interests: document.getElementById('af-interests')?.value,
    impact: document.getElementById('af-diagnosisImpact')?.value,
    phone: document.getElementById('af-parentPhone')?.value,
    notice: document.querySelector('[data-notice]:not([hidden])')?.textContent || '',
  }));
  ok(after.interests === 'Dinosaurs and space' && after.impact === 'She uses a walker at home.', "the phone shows the laptop's answers");
  ok(after.phone === '(770) 555-0142', 'and keeps its own change');
  ok(/another device/.test(after.notice), `it says where they came from ("${after.notice}")`);
  const server = await api({ action: 'resume', token });
  ok(server.answers.interests === 'Dinosaurs and space' && server.answers.diagnosisImpact === 'She uses a walker at home.' && server.answers.parentPhone === '(770) 555-0142', 'the draft has both');

  console.log('The laptop again, then the phone saves on its own (not looked at again)');
  await api({ action: 'save', token, answers: { ...server.answers, otherChildren: 'A brother, 8' }, page: 'child', lang: 'en', rev: server.rev, changed: ['otherChildren'] });
  await page.evaluate(() => { const i = document.getElementById('af-parentRelation'); i.value = 'Mom'; i.dispatchEvent(new Event('input', { bubbles: true })); });
  await sleep(5500); // its save waits 4 seconds after typing
  const s2 = await api({ action: 'resume', token });
  ok(s2.answers.otherChildren === 'A brother, 8' && s2.answers.parentRelation === 'Mom', "the phone's save doesn't undo the laptop's answer");
  ok(await page.evaluate(() => document.getElementById('af-otherChildren')?.value) === 'A brother, 8', 'and the phone shows it');
} catch (e) {
  failures.push(`crashed: ${e.message}`);
  console.log(e);
} finally {
  await browser.close();
}
console.log(failures.length ? `\n${failures.length} failed` : '\nAll passed');
process.exit(failures.length ? 1 : 0);
