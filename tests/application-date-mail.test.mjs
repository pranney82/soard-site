/**
 * Two slips an application catches before it's sent: a birth year typed wrong, and a likely typo in an
 * email's provider (the shared "Did you mean …?" of the family, organization and Advisory Board forms)
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fieldError, DATE_MIN } from '../functions/api/_application-form.js';
import { mailFix } from '../src/components/apply/mail-fix.js';

test('a birth year typed wrong ("0201", 1950) is caught; a real one passes; the box takes the same earliest date', () => {
  const f = { id: 'birthdate', type: 'date', required: true };
  assert.equal(DATE_MIN, '1990-01-01');
  assert.equal(fieldError(f, '0201-05-05', 'en'), 'Please check the year.');
  assert.equal(fieldError(f, '1950-05-05', 'en'), 'Please check the year.');
  assert.equal(fieldError(f, '0201-05-05', 'es'), 'Revise el año.');
  assert.equal(fieldError(f, '2016-05-05', 'en'), null);
  assert.equal(fieldError(f, '1990-01-01', 'en'), null);
  assert.equal(fieldError(f, '2999-01-01', 'en'), 'Please enter a date in the past.');
});

test('a likely typo in an email provider is offered its fix; a real address never is', () => {
  assert.equal(mailFix('name@gmial.com'), 'name@gmail.com');
  assert.equal(mailFix('name@yahoo.con'), 'name@yahoo.com');
  assert.equal(mailFix('name@hotmial.com'), 'name@hotmail.com');
  assert.equal(mailFix('name@gmail.com'), null);
  assert.equal(mailFix('name@soardcharity.com'), null);
  assert.equal(mailFix('kim@mail.com'), null); // a real provider, a letter from gmail.com
  assert.equal(mailFix('kim@gmx.com'), null);
  assert.equal(mailFix('not an email'), null);
});

test('the home is a place, not a mailbox: a PO box is turned away there (a parent\'s mailing address may be one)', () => {
  const home = { id: 'address', type: 'address', required: true };
  const box = { line1: 'PO Box 123', line2: '', city: 'Roswell', state: 'GA', zip: '30076' };
  assert.equal(fieldError(home, box, 'en'), 'Please enter a street address, not a PO box.');
  assert.equal(fieldError(home, { ...box, line1: 'P.O. Box 9' }, 'es'), 'Escriba una dirección con calle, no un apartado postal.');
  assert.equal(fieldError(home, { ...box, line1: '12 Main St', line2: 'Post Office Box 4' }, 'en'), 'Please enter a street address, not a PO box.');
  assert.equal(fieldError(home, { ...box, line1: '1000 Boxwood Ln' }, 'en'), null, 'a street with "box" in its name is a street');
  assert.equal(fieldError({ id: 'parentAddress', type: 'address' }, box, 'en'), null);
});

test('an email ending no address has ("gmail.con") is turned away, with the fix offered; real endings pass', () => {
  const f = { id: 'parentEmail', type: 'email', required: true };
  for (const v of ['mom@gmail.con', 'mom@yahoo.cmo', 'mom@comcast.nte', 'mom@school.ogr']) assert.equal(fieldError(f, v, 'en'), 'Please enter a valid email address, like name@example.com.', v);
  for (const v of ['mom@gmail.com', 'mom@school.co', 'mom@example.org', 'mom@mail.com']) assert.equal(fieldError(f, v, 'en'), null, v);
  assert.equal(mailFix('mom@gmail.con'), 'mom@gmail.com');
});

test('a number answered as a range ("200-300") asks for one number, a guess; "1e3" is not a count', () => {
  const f = { id: 'children', type: 'number', required: true, rules: { integer: true } };
  for (const v of ['200-300', '200 to 300', '200 – 300', '50 or 60']) assert.equal(fieldError(f, v, 'en'), 'Please enter one number. Your best guess is fine.', v);
  assert.equal(fieldError(f, '200-300', 'es'), 'Escriba un solo número. Un cálculo aproximado está bien.');
  assert.equal(fieldError(f, '1e3', 'en'), 'Please enter a number.');
  assert.equal(fieldError(f, '12.5', 'en'), 'Please enter a whole number.');
  for (const v of ['250', '1,200', ' 40 ']) assert.equal(fieldError(f, v, 'en'), null, v);
});

test('a limit is written as people write it ("1,000,000 or less"); a typed name to sign is more than one letter', () => {
  const f = { id: 'childrenServed', type: 'number', required: true, rules: { min: 1, max: 1000000, integer: true } };
  assert.equal(fieldError(f, '1,250,000', 'en'), 'Please enter 1,000,000 or less.');
  assert.equal(fieldError(f, '1250000', 'es'), 'Escriba 1,000,000 o menos.');
  assert.equal(fieldError(f, '0', 'en'), 'Please enter 1 or more.');
  const sign = { id: 'signature', type: 'signature', required: true };
  for (const v of ['x', ' . ', 'J.']) assert.equal(fieldError(sign, v, 'en'), 'Please type your full name.', v);
  for (const v of ['Jo Li', 'Ana', '李明']) assert.equal(fieldError(sign, v, 'en'), null, v);
});

test('ten digits no one can dial ("123-456-7890") are asked to be checked, not counted again', () => {
  const f = { id: 'parentPhone', type: 'phone', required: true };
  for (const v of ['123-456-7890', '0000000000', '1-123-456-7890']) assert.equal(fieldError(f, v, 'en'), "That doesn't look like a US phone number. Please check it.", v);
  assert.equal(fieldError(f, '123-456-7890', 'es'), 'Ese no parece un número de teléfono de EE. UU. Revíselo, por favor.');
  assert.equal(fieldError(f, '555-1234', 'en'), 'Please add the area code, like (404) 555-0123.');
  assert.equal(fieldError(f, '12345', 'en'), 'Please enter a 10-digit phone number.');
  for (const v of ['(404) 555-0123', '+44 20 7946 0958', '404 555 0123 ext 5']) assert.equal(fieldError(f, v, 'en'), null, v);
});

test('an email that can\'t get mail (a comma or period left on the end, "..") is turned away, with the fix offered', () => {
  const f = { id: 'parentEmail', type: 'email', required: true };
  for (const v of ['ana.qa@example.com,', 'ana.qa@example.com.', 'ana.qa@example..com', '.ana@example.com']) assert.equal(fieldError(f, v, 'en'), 'Please enter a valid email address, like name@example.com.', v);
  for (const v of ['ana.qa@example.com,', 'ana.qa@example.com.', 'ana.qa@example..com']) assert.equal(mailFix(v), 'ana.qa@example.com', v);
  assert.equal(mailFix('ana@gmial.com,'), 'ana@gmail.com');
  for (const v of ["o'brien@example.com", 'jordan+apply@example.com', 'contact@school.k12.ga.us']) assert.equal(fieldError(f, v, 'en'), null, v);
});
