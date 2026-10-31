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
