/**
 * The trade-partner sign-in card (src/components/trade-partners/signin.ts): the
 * page is built with it (account.astro, both languages) and account.ts draws the
 * same markup when it takes over, so nothing moves.
 * Run: node --test tests/trade-partner-signin.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildSync } from 'esbuild';

const load = (entry) => import(`data:text/javascript,${encodeURIComponent(buildSync({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'node', write: false, logLevel: 'silent' }).outputFiles[0].text)}`);
const { signInHtml, langButtonHtml } = await load('src/components/trade-partners/signin.ts');
const { WORDS } = await load('src/components/trade-partners/account-words.ts');

test('the card in each language, with the other language on its button', () => {
  const en = signInHtml(WORDS.en, 'en');
  assert.match(en, /<h1 class="tpa-h1">Sign in<\/h1>/);
  assert.match(en, /<button type="button" class="tpa-lang" data-act="lang" lang="es">Español<\/button>/);
  const es = signInHtml(WORDS.es, 'es');
  assert.match(es, /<h1 class="tpa-h1">Entrar<\/h1>/);
  assert.equal(langButtonHtml(WORDS.es, 'es'), '<button type="button" class="tpa-lang" data-act="lang" lang="en">English</button>');
});

test('a form sent before the page script takes it over goes nowhere (no email in the address)', () => {
  assert.match(signInHtml(WORDS.en, 'en'), /<form class="tpa-form" data-form="signin" method="dialog" novalidate>/);
});

test('"New to SOARD?" unless this device signed in as a company paid off the jobs; a message is escaped', () => {
  assert.match(signInHtml(WORDS.en, 'en'), /class="tpa-small tpa-new-here">New to SOARD\? <a href="\/trade-partners\/#start">/);
  assert.doesNotMatch(signInHtml(WORDS.en, 'en', { papersBefore: true }), /tpa-new-here/);
  assert.match(signInHtml(WORDS.en, 'en', { message: 'That link <expired>' }), /<p class="tpa-callout" role="alert">That link &lt;expired&gt;<\/p>/);
  assert.doesNotMatch(signInHtml(WORDS.en, 'en'), /tpa-callout/);
});

test('the page is built with the card in both languages and the head check uses account.ts\'s keys', () => {
  const page = readFileSync('src/pages/trade-partners/account.astro', 'utf8');
  assert.match(page, /signInHtml\(WORDS\.en, 'en'\)/);
  assert.match(page, /signInHtml\(WORDS\.es, 'es'\)/);
  const account = readFileSync('src/components/trade-partners/account.ts', 'utf8');
  for (const key of ['soard-tp-token', 'soard-tp-scope']) {
    assert.ok(account.includes(`'${key}'`), `account.ts keeps ${key}`);
    assert.ok(page.includes(`'${key}'`), `the page's head check reads ${key}`);
  }
  assert.ok(readFileSync('src/components/trade-partners/words.ts', 'utf8').includes("'soard-tp-lang'"));
  assert.ok(page.includes("'soard-tp-lang'"));
  assert.match(account, /root\.replaceChildren\(html\(signInHtml\(T, lang, \{ message, papersBefore: papersBefore\(\) \}\)\)\)/);
});
