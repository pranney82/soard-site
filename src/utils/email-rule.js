/**
 * The address rule a reveal reminder sign-up is held to, in the browser.
 * It is the server's own rule (isEmail in functions/api/_broadcast-notify.js:
 * a plain address Resend takes, no "..", trailing dot, comma or <>), so the
 * page never accepts an address the server then turns down.
 * tests/email-rule.test.mjs keeps the two the same.
 */
const RULE = /^(?!\.)(?!.*\.\.)(?!.*\.@)[^\s@<>()[\],;:"]+@[^\s@<>()[\],;:".]+(?:\.[^\s@<>()[\],;:".]+)*\.[^\s@<>()[\],;:".]{2,}$/;

export function isEmail(s) {
  const v = String(s || '').trim();
  return v.length <= 254 && RULE.test(v);
}
