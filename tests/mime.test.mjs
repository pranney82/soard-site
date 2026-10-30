/**
 * A raw email in Gmail's shape (functions/api/_mime.js): what the certificate search reads out of the email a vendor
 * sent a Ramp bill in. Made-up senders only.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEmail, decodeWords } from '../functions/api/_mime.js';
import { filesOf, textOf, partsOf, bytesOf } from '../functions/api/_mailbox.js';

const enc = (s) => new TextEncoder().encode(s);
const PDF = Buffer.from('%PDF-1.7 ACORD 25 certificate '.repeat(30));

test('a vendor’s email: nested parts, encoded names and words, an attached email, and the file’s exact bytes', () => {
  const eml = [
    'From sender@example.com Mon Oct 27 10:00:00 2026',
    'From: =?utf-8?Q?Sam_Sample?= <office@samplepainting.example>',
    'Subject: =?UTF-8?B?SW52b2ljZSA3IGFuZCBvdXIgQ09J?=',
    'Content-Type: multipart/mixed; boundary="outer"',
    '', 'a preamble nobody reads',
    '--outer',
    'Content-Type: multipart/alternative; boundary=inner',
    '', '--inner', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: quoted-printable', '',
    'Here is the invoice and our certificate of insurance =E2=80=94 thanks!', '--inner', 'Content-Type: text/html', '', '<p>Here</p>', '--inner--',
    '--outer',
    'Content-Type: application/pdf;', " name*=utf-8''Sample%20COI%E2%84%A2.pdf",
    'Content-Disposition: attachment;', ' filename*0="Sample COI";', ' filename*1=".pdf"',
    'Content-Transfer-Encoding: base64', '', PDF.toString('base64').replace(/(.{76})/g, '$1\r\n'),
    '--outer',
    'Content-Type: message/rfc822', '',
    'From: agent@insure.example', 'Content-Type: multipart/mixed; boundary=fw', '',
    '--fw', 'Content-Type: image/jpeg; name="w9.jpg"', 'Content-Transfer-Encoding: base64', '', Buffer.from('JPEGDATA').toString('base64'), '--fw--',
    '--outer--', 'an epilogue',
  ].join('\r\n');
  const p = parseEmail(enc(eml));
  const h = (n) => p.headers.find((x) => x.name === n).value;
  assert.equal(h('Subject'), 'Invoice 7 and our COI');
  assert.equal(h('From'), 'Sam Sample <office@samplepainting.example>');
  assert.deepEqual(filesOf(p).map((f) => [f.name, f.type, f.size]), [['Sample COI.pdf', 'application/pdf', PDF.length], ['w9.jpg', 'image/jpeg', 8]]);
  assert.equal(textOf(p), 'Here is the invoice and our certificate of insurance — thanks!');
  assert.ok(Buffer.from(bytesOf(partsOf(p).find((x) => x.filename === 'Sample COI.pdf').body.data)).equals(PDF), 'the PDF, byte for byte');
});

test('a name only in an RFC 2231 parameter, and plain LF line ends', () => {
  const p = parseEmail(enc(['From: a@example.org', 'Content-Type: multipart/mixed; boundary=x', '', '--x', "Content-Type: application/pdf; name*=utf-8''W-9%20Caf%C3%A9.pdf", 'Content-Transfer-Encoding: base64', '', PDF.toString('base64'), '--x--'].join('\n')));
  assert.deepEqual(filesOf(p).map((f) => f.name), ['W-9 Café.pdf']);
});

test('not an email: a PDF, a web page, nothing', () => {
  assert.equal(parseEmail(enc('%PDF-1.7 hello\n\nworld')), null);
  assert.equal(parseEmail(enc('<html><body>hi</body></html>')), null);
  assert.equal(parseEmail(new Uint8Array(0)), null);
  assert.equal(decodeWords('=?x-unknown?B?Q2Fmw6k=?= Tile'), 'Café Tile', 'a charset nobody knows is read as UTF-8');
});
