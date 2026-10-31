/**
 * A likely typo in an email address's provider ("name@gmial.com", "name@yahoo.con"): the address it
 * was probably meant to be, else null. Shared by the family, organization and Advisory Board forms.
 */
const MAIL_HOSTS = ['gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com', 'aol.com', 'comcast.net', 'att.net', 'bellsouth.net', 'live.com', 'msn.com', 'me.com', 'ymail.com', 'sbcglobal.net', 'verizon.net', 'charter.net', 'protonmail.com', 'mac.com', 'yahoo.com.mx', 'hotmail.es', 'outlook.es', 'yahoo.es',
  // Real providers that sit a letter or two from the big ones (mail.com is not a typo of gmail.com)
  'mail.com', 'email.com', 'gmx.com', 'gmx.net', 'zoho.com', 'aim.com', 'proton.me', 'pm.me', 'protonmail.ch', 'fastmail.com', 'hey.com',
  'earthlink.net', 'cox.net', 'frontier.com', 'windstream.net', 'juno.com', 'netzero.net', 'optonline.net', 'rocketmail.com',
  'googlemail.com', 'hotmail.co.uk', 'yahoo.co.uk', 'live.co.uk'];
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
export function mailFix(v) {
  const m = /^([^\s@]+)@([^\s@]+)$/.exec(String(v || '').trim());
  if (!m) return null;
  const host = m[2].toLowerCase();
  if (MAIL_HOSTS.includes(host)) return null;
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
