/**
 * /alert-contact — the contact card for SOARD's alert number
 * ===========================================================================
 * Sent with the hello text (a picture message), so a staff member saves
 * "SOARD Reveal Alerts" in one tap. Phones then show the name instead of a
 * number, and show link previews, which they hide for numbers not in contacts.
 * The number is the site's own Twilio number (TWILIO_FROM); the photo is the
 * site's app icon, read from the site itself. Public: Twilio fetches it.
 */

const SITE = 'https://sunshineonaranneyday.com';

/** vCard 3.0 lines fold at 75 octets: CRLF, then a space */
function fold(line) {
  const out = [];
  for (let i = 0; i < line.length; i += 74) out.push((i ? ' ' : '') + line.slice(i, i + 74));
  return out.join('\r\n');
}

export function contactCard({ number, photo = null }) {
  const digits = String(number || '').replace(/[^\d+]/g, '');
  return [
    'BEGIN:VCARD', 'VERSION:3.0',
    'FN:SOARD Reveal Alerts', 'N:Reveal Alerts;SOARD;;;', 'ORG:Sunshine on a Ranney Day',
    `TEL;TYPE=CELL,VOICE:${digits}`,
    `URL:${SITE}/`,
    'NOTE:Live reveal alert texts for SOARD staff. Reply STOP to opt out\\, HELP for help.',
    ...(photo ? [`PHOTO;ENCODING=b;TYPE=PNG:${photo}`] : []),
    'END:VCARD',
  ].map(fold).join('\r\n') + '\r\n';
}

export async function onRequestGet(context) {
  const { env, request } = context;
  if (!env.TWILIO_FROM) return new Response('Not set up', { status: 404 });
  let photo = null;
  try {
    const res = await fetch(new URL('/apple-touch-icon.png', request.url), { cf: { cacheTtl: 86400 } });
    if (res.ok) {
      const bytes = new Uint8Array(await res.arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      photo = btoa(bin);
    }
  } catch { /* the card works without its picture */ }
  return new Response(contactCard({ number: env.TWILIO_FROM, photo }), {
    headers: {
      'Content-Type': 'text/vcard; charset=utf-8',
      'Content-Disposition': 'attachment; filename="SOARD Reveal Alerts.vcf"',
      'Cache-Control': 'public, max-age=3600',
    },
  });
}
