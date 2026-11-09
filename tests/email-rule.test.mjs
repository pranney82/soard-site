// The browser's address check (src/utils/email-rule.js) is the server's (isEmail in
// functions/api/_broadcast-notify.js): a sign-up form never accepts what the server turns down
import test from 'node:test';
import assert from 'node:assert/strict';
import { isEmail as page } from '../src/utils/email-rule.js';
import { isEmail as server } from '../functions/api/_broadcast-notify.js';

const CASES = [
  'ana@gmail.com', 'Ana.Lopez+reveals@soardcharity.com', 'a@b.co', 'first.last@sub.domain.org', ' ana@gmail.com ',
  'ana@gmail.com.', 'ana@gmail..com', '<ana@gmail.com>', 'ana@gmail', 'ana@@gmail.com', '.ana@gmail.com', 'ana.@gmail.com',
  'ana@gmail.c', 'ana gmail@x.com', 'ana@gmail.com,bo@x.com', 'mailto:ana@gmail.com', 'ana@(gmail).com', '"ana"@gmail.com', '', '@gmail.com',
];

test('the page and the server agree on every address', () => {
  for (const c of CASES) assert.equal(page(c), server(c), JSON.stringify(c));
});

test('the slips the server refuses are refused on the page first', () => {
  for (const c of ['ana@gmail.com.', 'ana@gmail..com', '<ana@gmail.com>']) assert.equal(page(c), false, c);
  assert.equal(page('ana@gmail.com'), true);
});

test('an address too long to send is refused, as the server refuses it', () => {
  const long = `${'a'.repeat(250)}@x.co`;
  assert.equal(page(long), false);
});
