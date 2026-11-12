/**
 * What Admin → Donors & Partners → Checks and the site's check reader (functions/api/_check-gifts.js) both decide, in one place:
 * whether two names are one giver, whether two addresses are one, whether an address is whole, and whether text holds a
 * number that could be a bank account. The page uses them to keep a card's choices agreeing with each other as a person
 * picks; the site uses them to check what's sent. One copy, so the page never offers what the site would refuse.
 */

const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const noZeros = (s) => String(s ?? '').replace(/\D+/g, '').replace(/^0+/, '');

// ─── A number that could be a bank account never gets through ───────

/**
 * True when text holds 6 digits or more in a row, other than the check's own number. Anything between digits that
 * isn't a letter doesn't break a run (spaces, dashes, commas, slashes, the check font's symbols, full-width digits),
 * so neither a routing number nor an account number survives, however a model writes it. A date doesn't count.
 */
export function hasAccountDigits(text, checkNumber = '') {
  const plain = String(text ?? '').normalize('NFKC').replace(/\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g, ' ');
  const bare = plain.replace(/[^\p{L}\d]+/gu, '');
  const own = noZeros(checkNumber);
  return (bare.match(/\d{6,}/g) || []).some((run) => !own || run.replace(/^0+/, '') !== own);
}

// ─── One giver, however their name is written ───────────────────────

/** A giver's name to compare: "c/o" and what follows, The, LLC and punctuation gone, a name typed twice once */
export function payerKey(name) {
  // José on the check and Jose typed in Zeffy are one name
  const words = clean(name).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/\bc\s*\/\s*o\b.*$|\bc o\b.*$/, ' ')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9 ]+/g, ' ')
    .replace(/\b(the|and|inc|incorporated|llc|ltd|lp|llp|corp|corporation|company)\b/g, ' ')
    .replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const half = words.length / 2;
  if (words.length > 1 && Number.isInteger(half) && words.slice(0, half).join(' ') === words.slice(half).join(' ')) return words.slice(0, half).join(' ');
  return words.join(' ');
}

// Words a giver's name gains or loses without being someone else: Pine Foundation is Pine Family Foundation, Oakline is Oakline Design Build
const NAME_FILLER = new Set(['family', 'foundation', 'fund', 'trust', 'charitable', 'giving', 'group', 'co', 'design', 'build', 'builders', 'building', 'construction', 'services', 'enterprises', 'holdings', 'of', 'for', 'mr', 'mrs', 'ms', 'dr']);

/**
 * The same giver for sure: the same name, J. Smith and John Smith, or one name holding the other with only filler words
 * added. Atlanta Rotary Club and North Atlanta Rotary Club are not: that's sameGiver, which only ever puts it to a person
 */
export function surelySameGiver(a, b) {
  const ka = payerKey(a);
  const kb = payerKey(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  const wa = ka.split(' ');
  const wb = kb.split(' ');
  const [few, many] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
  if (few.length >= 2 && few.at(-1) === many.at(-1) && few[0][0] === many[0][0] && (few[0].length === 1 || many[0].length === 1) && few.length === many.length) return true;
  return few.join('').length >= 4 && few.every((w) => many.includes(w)) && many.filter((w) => !few.includes(w)).every((w) => NAME_FILLER.has(w));
}

/**
 * One name, however it's written (case, spacing, punctuation, The, LLC): for telling which of a card's own names something
 * is tied to. Never loose, so a joint check's name doesn't make one spouse the other: Elena Abernathy is "Marcus and Elena
 * Abernathy" as sameGiver says, and that name is Marcus Abernathy too, but Elena is never Marcus
 */
export const sameName = (a, b) => !!payerKey(a) && payerKey(a) === payerKey(b);

/**
 * A name fixed by a letter or two (a misread "Wilhemina" typed as "Wilhelmina"): still that giver, for what a card starts
 * on (whose address it is). Never for filing or learning, which go by sameGiver and surelySameGiver
 */
export function nearlySameName(a, b) {
  if (sameGiver(a, b)) return true;
  const ka = payerKey(a);
  const kb = payerKey(b);
  if (!ka || !kb || ka.split(' ').length !== kb.split(' ').length || Math.min(ka.length, kb.length) < 8) return false;
  // Edits between the two, up to one in every ten letters (two at most)
  const most = Math.min(2, Math.floor(Math.max(ka.length, kb.length) / 10));
  if (Math.abs(ka.length - kb.length) > most) return false;
  let prev = Array.from({ length: kb.length + 1 }, (_, j) => j);
  for (let i = 1; i <= ka.length; i++) {
    const row = [i];
    for (let j = 1; j <= kb.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (ka[i - 1] === kb[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[kb.length] <= most;
}

/** The same giver, as far as two names can say: the same words, all of one in the other, or J. Smith and John Smith */
export function sameGiver(a, b) {
  const ka = payerKey(a);
  const kb = payerKey(b);
  if (!ka || !kb) return false;
  if (ka === kb) return true;
  const wa = ka.split(' ');
  const wb = kb.split(' ');
  const [few, many] = wa.length <= wb.length ? [wa, wb] : [wb, wa];
  if (few.join('').length >= 4 && few.every((w) => many.includes(w))) return true;
  return few.length >= 2 && few.at(-1) === many.at(-1) && few[0][0] === many[0][0] && (few[0].length === 1 || many[0].length === 1);
}

/** What's wrong with a name a person gives for who a check is from, or '' */
export function nameProblem(name, checkNumber = '') {
  if (hasAccountDigits(clean(name), checkNumber)) return 'Leave the long number out of the name. Six or more digits in a row look like a bank account number, so the site never saves them.';
  return '';
}

// ─── The donor's email ──────────────────────────────────────────────

/** The address the site puts on a donor's contact for a moment to file a gift under them: it reaches no one */
export const TAG_DOMAIN = 'nomail.soardcharity.com';
export const isTag = (email) => clean(email).toLowerCase().endsWith(`@${TAG_DOMAIN}`);
const EMAIL = /^[^\s@,;<>()]+@[^\s@,;<>()]+\.[a-z]{2,}$/i;
/** SOARD's own addresses: never a donor's */
export const ownEmail = (mail) => /@(soardcharity\.com|sunshineonaranneyday\.com)$/i.test(clean(mail));
/** An email to put on a donor, as it would be saved, or '' when it isn't one */
export const emailOf = (mail) => {
  const m = clean(mail).toLowerCase();
  return m.length <= 120 && EMAIL.test(m) && !isTag(m) && !ownEmail(m) ? m : '';
};
/** What's wrong with an email a person gives for the donor, or '' (an empty one is none, which is fine) */
export function emailProblem(mail) {
  const m = clean(mail).toLowerCase();
  if (!m || emailOf(m)) return '';
  if (ownEmail(m)) return 'That’s a SOARD email. Use the donor’s own, or leave it empty.';
  return 'That email doesn’t look right. Leave it empty if there isn’t one.';
}

// ─── Where the donor's mail goes ────────────────────────────────────

export const US_STATES = new Set('AL AK AZ AR CA CO CT DE DC FL GA HI ID IL IN IA KS KY LA ME MD MA MI MN MS MO MT NE NV NH NJ NM NY NC ND OH OK OR PA RI SC SD TN TX UT VT VA WA WV WI WY PR VI GU AS MP AA AE AP'.split(' '));

/**
 * What's wrong with an address, in words a person can act on, or '' when it's whole: a street with a number and a word
 * ("123 Main St", "PO Box 9"), a city, a US state's two letters, a five-digit ZIP (or ZIP+4, of which the first five are
 * kept). { line1, city, state, postal_code }
 */
export function addressProblem(a, checkNumber = '') {
  const line1 = clean(String(a?.line1 ?? '').normalize('NFKC')).replace(/[,;]+$/, '');
  const city = clean(String(a?.city ?? '').normalize('NFKC')).replace(/[,;.]+$/, '');
  const state = clean(a?.state).toUpperCase().replace(/[^A-Z]/g, '');
  const zip = clean(a?.postal_code).replace(/\s+/g, '');
  if (!line1) return 'Type the street.';
  if (line1.length > 100) return 'The street is too long.';
  if (!/\d/.test(line1) || !/\p{L}/u.test(line1)) return 'The street needs its number, like 12 Oak St or PO Box 9.';
  if (hasAccountDigits(line1, checkNumber)) return 'The street has six or more digits in a row, which look like a bank account number, so the site never saves them.';
  if (!city) return 'Type the city.';
  if (!/^[\p{L} .'’-]{2,50}$/u.test(city)) return 'The city can only have letters, spaces, periods, dashes and apostrophes.';
  if (!state) return 'Type the state’s two letters, like GA.';
  if (!US_STATES.has(state)) return `${state} isn’t a US state. Use its two letters, like GA.`;
  if (!zip) return 'Type the ZIP.';
  if (!/^\d{5}(?:-?\d{4})?$/.test(zip)) return 'The ZIP is five digits, like 30030.';
  return '';
}

// Ways one street is written: 12 Oak Street #4 and 12 Oak St Apt 4 are one address
const STREET_WORDS = {
  street: 'st', avenue: 'ave', av: 'ave', road: 'rd', drive: 'dr', lane: 'ln', court: 'ct', boulevard: 'blvd', place: 'pl', parkway: 'pkwy',
  circle: 'cir', highway: 'hwy', terrace: 'ter', trail: 'trl', square: 'sq', north: 'n', south: 's', east: 'e', west: 'w',
  northeast: 'ne', northwest: 'nw', southeast: 'se', southwest: 'sw', apartment: '', apt: '', suite: '', ste: '', unit: '', number: '', no: '', post: 'po', office: '',
};

/** One address as a comparable key, the ZIP's first five digits only: "" for none */
export function addressKey(a) {
  if (!a?.line1) return '';
  return [a.line1, a.city, a.state, String(a.postal_code || '').slice(0, 5)].map((s) => clean(s).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9 ]+/g, ' ').replace(/\bp o\b/g, 'po').split(' ').filter(Boolean).map((w) => STREET_WORDS[w] ?? w).filter(Boolean).join(' ')).join('|');
}

/** Two addresses that are one, however they're written */
export const sameAddress = (a, b) => !!addressKey(a) && addressKey(a) === addressKey(b);

/** An address on one line */
export const addressLine = (a) => (a?.line1 ? `${a.line1}, ${a.city}, ${a.state} ${a.postal_code}` : '');
