/**
 * A likely typo in an email address's provider ("name@gmial.com", "name@yahoo.con") or an accent before
 * its @ ("maría@gmail.com"): the address it was probably meant to be, else null. Shared by the family, organization and Advisory Board forms.
 */
const MAIL_HOSTS = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'aol.com', 'comcast.net', 'att.net', 'bellsouth.net', 'live.com', 'msn.com', 'me.com', 'ymail.com', 'sbcglobal.net', 'verizon.net', 'charter.net', 'protonmail.com', 'mac.com', 'yahoo.com.mx', 'hotmail.es', 'outlook.es', 'yahoo.es',
  // Real providers that sit a letter or two from the big ones (mail.com is not a typo of gmail.com)
  'mail.com', 'email.com', 'gmx.com', 'gmx.net', 'zoho.com', 'aim.com', 'proton.me', 'pm.me', 'protonmail.ch', 'fastmail.com', 'hey.com',
  'earthlink.net', 'cox.net', 'frontier.com', 'windstream.net', 'juno.com', 'netzero.net', 'optonline.net', 'rocketmail.com',
  'googlemail.com', 'hotmail.co.uk', 'yahoo.co.uk', 'live.co.uk'];
// Big providers that also run country domains (yahoo.ca, hotmail.fr, outlook.de, yahoo.co.jp, yahoo.com.ar, proton.ch,
// email.cz): an address at one of those is real, not a typo of another country's, so it's left alone.
// (.co, .cm and .om after a big name are the classic slips for .com, so those are still offered the fix.)
const REGIONAL = new Set(['yahoo', 'ymail', 'hotmail', 'outlook', 'live', 'msn', 'aol', 'gmx', 'proton', 'protonmail', 'email', 'mail', 'web', 'yandex']);
const COUNTRY_TLD = /^(?:(?:co|com|net|org)\.)?[a-z]{2}$/;
const SLIP_TLD = new Set(['co', 'cm', 'om']);
function regional(host) {
  const [brand, ...rest] = host.split('.');
  const tld = rest.join('.');
  return REGIONAL.has(brand) && COUNTRY_TLD.test(tld) && !SLIP_TLD.has(tld);
}
function editDistance(a, b) { // with a swap of two letters counting as one
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}
/** A label as the browser keeps it, back in its own letters (Chrome keeps "gmaíl" as "xn--gmal-xpa"): RFC 3492 */
function punyDecode(code) {
  const digit = (c) => (c >= 48 && c <= 57 ? c - 22 : c >= 65 && c <= 90 ? c - 65 : c >= 97 && c <= 122 ? c - 97 : 36);
  const adapt = (delta, points, first) => {
    let d = first ? Math.floor(delta / 700) : delta >> 1;
    d += Math.floor(d / points);
    let k = 0;
    for (; d > 455; k += 36) d = Math.floor(d / 35);
    return k + Math.floor((36 * d) / (d + 38));
  };
  const cut = code.lastIndexOf('-');
  const out = cut > 0 ? [...code.slice(0, cut)].map((c) => c.codePointAt(0)) : [];
  let n = 128;
  let i = 0;
  let bias = 72;
  for (let at = cut > 0 ? cut + 1 : 0; at < code.length;) {
    const was = i;
    for (let w = 1, k = 36; ; k += 36) {
      if (at >= code.length) return null;
      const d = digit(code.charCodeAt(at++));
      if (d >= 36) return null;
      i += d * w;
      const t = k <= bias ? 1 : k >= bias + 26 ? 26 : k - bias;
      if (d < t) break;
      w *= 36 - t;
    }
    bias = adapt(i - was, out.length + 1, was === 0);
    n += Math.floor(i / (out.length + 1));
    i %= out.length + 1;
    out.splice(i++, 0, n);
  }
  return n > 0x10ffff ? null : String.fromCodePoint(...out);
}
export function mailFix(v) {
  const raw = String(v || '').trim();
  // A comma or period left on the end ("ana@example.com," from a contacts list), or "..": the address without it
  const tidy = raw.replace(/[.,;:]+$/, '').replace(/\.{2,}/g, '.').replace(/@\./, '@');
  if (tidy !== raw && /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(tidy)) return mailFix(tidy) || tidy;
  const m = /^([^\s@]+)@([^\s@]+)$/.exec(raw);
  if (!m) return null;
  const host = m[2].toLowerCase().split('.').map((l) => (l.startsWith('xn--') && punyDecode(l.slice(4))) || l).join('.');
  // An accent before the @ ("maría@gmail.com"): mail providers take plain letters only, so mail to it never arrives
  const plain = m[1].normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (plain !== m[1] && /^[\x21-\x7e]+$/.test(plain)) return mailFix(`${plain}@${host}`) || `${plain}@${host}`;
  // A two-letter name (ge.com, gm.com) is as likely a real company as a slip: too close to call, so no guess
  if (MAIL_HOSTS.includes(host) || regional(host) || host.split('.')[0].length <= 2) return null;
  let best = null;
  let bestD = Infinity;
  for (const h of MAIL_HOSTS) {
    const dist = editDistance(host, h);
    if (dist < bestD) { bestD = dist; best = h; }
  }
  const allowed = best && best.length <= 7 ? 1 : 2;
  if (best && bestD > 0 && bestD <= allowed) return `${m[1]}@${best}`;
  const tld = host.replace(/\.(con|cmo|cpm|vom|xom|comm|coom)$/, '.com');
  return tld !== host ? `${m[1]}@${tld}` : null;
}
