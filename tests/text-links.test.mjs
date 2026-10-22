/**
 * Link previews in staff alert texts: /control-room/ sends a person straight
 * to the control room and shows a link previewer a card (the admin itself is
 * behind the sign-in, so a phone could never preview it), and /alert-contact
 * is the contact card the hello text carries, so phones know the number.
 * Run: node --test tests/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { onRequestGet as door } from '../functions/control-room/[[path]].js';
import { onRequestGet as card, contactCard } from '../functions/alert-contact.js';
import { alertText, ALERT_CONTACT_URL } from '../functions/api/_broadcast-notify.js';

const IMESSAGE = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_11_1) AppleWebKit/601.2.4 (KHTML, like Gecko) Version/9.0.1 Safari/601.2.4 facebookexternalhit/1.1 Facebot Twitterbot/1.0';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const ask = (ua) => door({ request: new Request('https://sunshineonaranneyday.com/control-room/', { headers: { 'User-Agent': ua } }) });

test('a person tapping the link goes straight to the control room', () => {
  const r = ask(IPHONE);
  assert.equal(r.status, 302);
  assert.equal(r.headers.get('Location'), 'https://sunshineonaranneyday.com/admin/#broadcast/control-room');
});

test('a link preview gets a card, and nothing private', async () => {
  for (const ua of [IMESSAGE, 'Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)', 'WhatsApp/2.23']) {
    const r = ask(ua);
    assert.equal(r.status, 200, ua);
    const html = await r.text();
    assert.match(html, /<meta property="og:title" content="SOARD reveal control room">/);
    assert.match(html, /<meta property="og:image" content="https:\/\/sunshineonaranneyday\.com\/og\/control-room\.png">/);
    assert.match(html, /<meta name="robots" content="noindex">/);
    assert.ok(!/<script/i.test(html), 'no script to follow');
  }
});

test('alert texts link to the door, not the sign-in; other links stay as they are', () => {
  assert.match(alertText({ title: 'x', url: 'https://sunshineonaranneyday.com/admin/#broadcast/control-room' }), /\nhttps:\/\/sunshineonaranneyday\.com\/control-room\/$/);
  assert.match(alertText({ title: 'x', url: 'https://sunshineonaranneyday.com/admin/' }), /\nhttps:\/\/sunshineonaranneyday\.com\/control-room\/$/);
  assert.match(alertText({ title: 'x', url: 'https://sunshineonaranneyday.com/live/sam/' }), /\nhttps:\/\/sunshineonaranneyday\.com\/live\/sam\/$/);
});

test('the contact card: the alert number, the name, the icon, folded as vCard wants', async () => {
  const real = globalThis.fetch;
  const asked = [];
  globalThis.fetch = async (url) => { asked.push(String(url)); return new Response(new Uint8Array(900).fill(7), { status: 200 }); };
  try {
    const r = await card({ env: { TWILIO_FROM: '+16786883160' }, request: new Request('https://sunshineonaranneyday.com/alert-contact') });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('Content-Type'), /^text\/vcard/);
    const v = await r.text();
    assert.deepEqual(asked, ['https://sunshineonaranneyday.com/apple-touch-icon.png'], 'the site’s own icon, no image files');
    assert.ok(v.startsWith('BEGIN:VCARD\r\nVERSION:3.0\r\n') && v.endsWith('END:VCARD\r\n'));
    assert.match(v, /\r\nFN:SOARD Reveal Alerts\r\n/);
    assert.match(v, /\r\nTEL;TYPE=CELL,VOICE:\+16786883160\r\n/);
    assert.match(v, /\r\nPHOTO;ENCODING=b;TYPE=PNG:/);
    assert.ok(v.split('\r\n').every((l) => l.length <= 75), 'every line folded to 75');
  } finally {
    globalThis.fetch = real;
  }
  const none = await card({ env: {}, request: new Request('https://sunshineonaranneyday.com/alert-contact') });
  assert.equal(none.status, 404, 'no number, no card');
  assert.ok(!contactCard({ number: '+16786883160' }).includes('PHOTO'), 'and it works without its picture');
  for (const typed of ['6786883160', '(678) 688-3160', '+1 678 688 3160']) {
    assert.match(contactCard({ number: typed }), /\r\nTEL;TYPE=CELL,VOICE:\+16786883160\r\n/, `"${typed}" goes in as +1`);
  }
  assert.equal(ALERT_CONTACT_URL, 'https://sunshineonaranneyday.com/alert-contact');
});
