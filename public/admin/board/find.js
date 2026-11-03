/**
 * board/find.js — finding words the way a person types them, for the board page's search
 * =======================================================================================
 * The ⌘K search, the Meetings filter and the Documents filter (./portal.js) all find with this, over what a
 * meeting says and the words inside its files (read once on the server, ../../../functions/api/_board-file-words.js).
 * Nothing here touches the DOM, so it runs in node too (tests/board-find.test.mjs).
 *
 *   - each word typed is found at the start of a word ("bud" finds Budget, "aug 6" August 6 but not 2026),
 *     whatever the punctuation ("w9" finds W-9, "501c3" 501(c)(3), "7500" 7,500, "obrien" O’Brien), and a
 *     word run together ("BudgetvsActuals") as its parts. A long word typed whole is found run on across a
 *     space too ("boardmeeting"), never from inside another word ("elected" isn't in "selected")
 *   - the small words ("of", "vs", "the") never have to be there: "budget vs actual" finds "Budget & Actual"
 *   - a plural or a word's other endings find it ("budgets" Budget, "policies" Policy, "elected" Election)
 *   - a word nothing has, misspelled, is read as the nearest word that's there ("bugdet" is budget,
 *     "insurence" insurance, "wierzon" Wierson), and said as such (`fixed`)
 *   - what's found is ranked: the words in the title before the words in the text, the words as typed
 *     before their endings or a near spelling, the words side by side, how often, and the newer first
 */

// (plain ASCII, the most of a file's words, needs no unfolding: a long text is read once, not three times)
export const norm = (s) => { const t = String(s || '').toLowerCase(); return /[^\x00-\x7f]/.test(t) ? t.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[\u2018\u2019]/g, "'") : t; };

/**
 * Text ready for finding in: ` its words `, then the words joined by punctuation as one ("w 9" and "w9",
 * "d o" and "do"; a number's thousands "7 500" and "7500") and a run-together word's parts ("budgetvs actuals")
 */
// A number as one word: its thousands joined ("41,605" is 41605, so 605 isn't found in it), a decimal with its point
// kept ("1.2" is 1d2, never 12 or 2), a time with its colon ("6:05" is 6h05)
const numbers = (t) => t.replace(/(\d)\.00(?!\d)/g, '$1').replace(/(\d),(?=\d{3}(?!\d))/g, '$1').replace(/(?<![\d.])(\d+)\.(\d+)(?![\d.])/g, '$1d$2').replace(/(?<![\d:])(\d{1,2}):(\d{2})(?![\d:])/g, '$1h$2');
export function prep(text) {
  const raw = String(text || '');
  const t = numbers(norm(raw));
  const plain = t.replace(/[^a-z0-9]+/g, ' ').trim();
  const have = new Set(plain.split(' '));
  const extra = new Set();
  for (const w of t.replace(/([a-z0-9])[&.'’\-/()]+(?=[a-z0-9])/g, '$1').replace(/[^a-z0-9]+/g, ' ').split(' ')) if (w && !have.has(w)) extra.add(w);
  // (a number's plural is the number too: "the 990s" has the 990)
  for (const w of have) if (/^\d+s$/.test(w)) extra.add(w.slice(0, -1));
  // ("BudgetvsActuals": "budgetvs" and "actuals" too; "PartlySunny" "partly" and "sunny")
  for (const run of (/[a-z][A-Z]/.test(raw) ? (/[^\x00-\x7f]/.test(raw) ? raw.normalize('NFKD') : raw).match(/[A-Za-z]*[a-z][A-Z][A-Za-z]*/g) : null) || []) for (const w of run.split(/(?<=[a-z])(?=[A-Z])/)) { const x = norm(w).replace(/[^a-z0-9]/g, ''); if (x && !have.has(x)) extra.add(x); }
  return ` ${plain} ${extra.size ? `${[...extra].join(' ')} ` : ''}`;
}

const pad = (n) => String(n).padStart(2, '0');
/**
 * What's typed, as terms: each word without its punctuation; a fraction ("1/2", "½") its two numbers apart (" 1 2 ",
 * never "12"); an abbreviation with & ("P&L", "D&O") its letters apart, found as that and nothing longer; a date
 * ("4/25/24", "04/25/2024", "2024-04-25") as the year, month and day ("2024 04 25", found written any of those ways)
 */
const MONTH_RE = '(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
const monthOf = (m) => ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(m.slice(0, 3)) + 1;
/**
 * What's typed, before it's split: "last year" and "this year" as the year; a month and its day ("Nov 5",
 * "April 25 2024") as one date; a word with a hyphen as its words ("golf-tournament", never "by-laws" or "w-9"); a
 * word and the number after it apart ("level10")
 */
function before(t, year = new Date().getFullYear()) {
  const QUARTER = { first: 1, '1st': 1, second: 2, '2nd': 2, third: 3, '3rd': 3, fourth: 4, '4th': 4 };
  return t
    // ("Q2 '23" is Q2 2023, "first quarter" Q1, "D and O" D&O, "6:05pm" 6:05 pm)
    .replace(/\bq([1-4])\s*'(\d{2})\b/g, 'q$1 20$2').replace(/(^|\s)'(\d{2})\b/g, '$120$2')
    .replace(/\b(first|second|third|fourth|1st|2nd|3rd|4th)\s+quarter\b/g, (all, n) => `q${QUARTER[n]}`)
    .replace(/\b([a-z]) and ([a-z])\b/g, '$1&$2')
    .replace(/(\d)(am|pm)\b/g, '$1 $2')
    .replace(/\blast year'?s?\b/g, String(year - 1)).replace(/\bthis year'?s?\b/g, String(year)).replace(/\bnext year'?s?\b/g, String(year + 1))
    .replace(new RegExp(`\\b${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?`, 'g'), (all, mon, d, y) => (+d >= 1 && +d <= 31 ? (y ? `${y}-${pad(monthOf(mon))}-${pad(d)}` : `${monthOf(mon)}/${+d}`) : all))
    .replace(/\b([a-z]{3,})-([a-z]{3,})\b/g, (all, a, b) => (`${a}${b}` === 'bylaws' ? all : `${a} ${b}`))
    .replace(/\b([a-z]{3,})(\d+)\b/g, '$1 $2');
}
// (what's typed is read to its first 12 words, each to 40 letters: a pasted page is searched by how it starts)
export const termsOf = (q) => before(norm(String(q || '').slice(0, 600))).replace(/(\d)\u2044(\d)/g, '$1/$2').split(/\s+/).filter(Boolean).slice(0, 12).map((w) => {
  let m = w.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/);
  if (m && +m[1] >= 1 && +m[1] <= 12 && +m[2] >= 1 && +m[2] <= 31) return `${m[3].length === 2 ? `20${m[3]}` : m[3]} ${pad(m[1])} ${pad(m[2])}`;
  m = w.match(/^(\d{4})[/.-](\d{1,2})[/.-](\d{1,2})$/);
  if (m && +m[2] >= 1 && +m[2] <= 12 && +m[3] >= 1 && +m[3] <= 31) return `${m[1]} ${pad(m[2])} ${pad(m[3])}`;
  // A month and day ("11/5", "Nov 5"): that day, any year, "md 11 5" (a fraction like 1/2 or 3/4 stays one)
  m = w.match(/^(\d{1,2})\/(\d{1,2})$/);
  if (m && +m[1] >= 1 && +m[1] <= 12 && +m[2] >= 1 && +m[2] <= 31 && (+m[1] > 4 || +m[2] > 4)) return `md ${+m[1]} ${+m[2]}`;
  if (/^\d+\/\d+$/.test(w)) return w.replace('/', ' ');
  if (/^[a-z0-9]{1,3}&[a-z0-9]{1,3}$/.test(w)) return w.replace('&', ' ');
  return numbers(w).replace(/[^a-z0-9]+/g, '').slice(0, 40);
}).filter(Boolean);
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
/**
 * A term's other ways of being written: a date ("2024 04 25" is also 4/25/24, 04/25/2024 and April 25, 2024), a round
 * number in thousands ("300000" is $300k, "300k" is 300,000)
 */
const samesOf = (w) => {
  const md = w.match(/^md (\d{1,2}) (\d{1,2})$/);
  if (md) { const month = MONTHS[+md[1] - 1]; return [`${month} ${md[2]}`, `${month.slice(0, 3)} ${md[2]}`, `${md[1]} ${md[2]}`, `${pad(md[1])} ${pad(md[2])}`]; }
  const m = w.match(/^(\d{4}) (\d{2}) (\d{2})$/);
  if (m) {
    const month = MONTHS[+m[2] - 1];
    return [...new Set([`${+m[2]} ${+m[3]} ${m[1].slice(2)}`, `${m[2]} ${m[3]} ${m[1]}`, `${+m[2]} ${+m[3]} ${m[1]}`, `${m[2]} ${m[3]} ${m[1].slice(2)}`, `${month} ${+m[3]} ${m[1]}`, `${month.slice(0, 3)} ${+m[3]} ${m[1]}`])];
  }
  if (/^[1-9]\d*000$/.test(w)) return [`${w.slice(0, -3)}k`];
  if (/^[1-9]\d*k$/.test(w)) return [`${w.slice(0, -1)}000`];
  // ("990s" is the 990s; "1.2m" and "$1.2M" are 1.2 million)
  if (/^\d+s$/.test(w)) return [w.slice(0, -1)];
  const mil = w.match(/^(\d+(?:d\d+)?)m$/);
  if (mil) return [`${mil[1]} million`];
  return [...sameWordsOf(w), ...(ABBREV[w] || [])];
};

/**
 * A term at the start of a word in prepped text (a number: the whole number, so "1240" is 1,240 and never 12,401);
 * a long one also two words run together ("boardmeeting", "inkind"), in a title or a point (a file's pages are
 * found by their words as they are)
 */
export function termIn(sp, w) {
  if (!w) return false;
  if (w.includes(' ') || /^\d+([dh]\d+)?$/.test(w)) return sp.includes(` ${w} `);
  if (sp.includes(` ${w}`)) return true;
  if (sp.length > 4000 || w.length < 5) return false;
  // (two words, each of two letters or more: "gala s(ponsors)" isn't "galas")
  for (let k = 2; k <= w.length - 2; k++) if (sp.includes(` ${w.slice(0, k)} ${w.slice(k)}`)) return true;
  return false;
}
/** The term as a whole word */
const wholeIn = (sp, w) => sp.includes(` ${w} `);

/**
 * Words that never have to be there (a query of nothing else still finds by them): the small words, and a question's
 * ("who is the treasurer", "how much did golf raise", "when was the reserve fund policy approved")
 */
export const SMALL = new Set(['a', 'an', 'and', 'the', 'of', 'for', 'to', 'in', 'on', 'at', 'by', 'vs', 'v', 'with', 'or', 'from', 'is', 'it', 'as', 'be', 'our', 'we', 'that', 'this', 'about',
  'who', 'whom', 'whose', 'what', 'when', 'where', 'why', 'how', 'which', 'did', 'does', 'do', 'done', 'are', 'was', 'were', 'been', 'has', 'have', 'had', 'much', 'many',
  'say', 'said', 'says', 'tell', 'me', 'show', 'find', 'i', 'my', 'you', 'can', 'could', 'would', 'should', 'will', 'there', 'their', 'they', 'its', 'any', 'all', 'last', 'latest', 'most']);
/** What a board's short forms stand for: "ED report" is the Executive Director's */
const ABBREV = { ed: ['executive director'], coi: ['conflict of interest', 'certificate of insurance'], sow: ['scope of work'], ytd: ['year to date'], yoy: ['year over year'], pl: ['profit and loss', 'p l'], eoy: ['end of year'], agm: ['annual meeting'], fy: ['fiscal year'] };

/** Words a board's minutes say for one another: what was approved was adopted, passed, carried */
const SAME_WORDS = [['approve', 'approved', 'approval', 'approves', 'adopt', 'adopted', 'adoption', 'pass', 'passed', 'carried', 'ratified', 'ratify']];
/** A first name and the names it's short for (or the short ones it goes by): Tom is Thomas */
const NICKS = [['tom', 'thomas'], ['bill', 'will', 'william'], ['bob', 'rob', 'robert'], ['jim', 'james'], ['mike', 'michael'], ['chris', 'christopher', 'christian', 'christine'],
  ['alex', 'alexander', 'alexandra'], ['liz', 'beth', 'elizabeth'], ['kate', 'katie', 'katherine', 'kathryn'], ['jen', 'jenny', 'jennifer'], ['dave', 'david'], ['dan', 'daniel'],
  ['joe', 'joseph'], ['nick', 'nicholas'], ['matt', 'matthew'], ['pat', 'patrick', 'patricia'], ['sam', 'samuel', 'samantha'], ['steve', 'steven', 'stephen'], ['tony', 'anthony'],
  ['rick', 'rich', 'richard'], ['andy', 'andrew'], ['ben', 'benjamin'], ['greg', 'gregory'], ['jeff', 'jeffrey'], ['ken', 'kenneth'], ['ron', 'ronald'], ['tim', 'timothy'],
  ['sue', 'susan'], ['becky', 'rebecca'], ['cathy', 'catherine'], ['maggie', 'margaret'], ['ed', 'edward'], ['charlie', 'charles'], ['larry', 'lawrence'], ['doug', 'douglas']];
const sameWordsOf = (w) => [...SAME_WORDS, ...NICKS].filter((set) => set.includes(w)).flatMap((set) => set.filter((x) => x !== w));

// (four letters ending in s that aren't plurals)
const KEEP_S = new Set(['news', 'this', 'thus', 'plus', 'less', 'yes', 'bias', 'gas', 'was', 'has', 'his', 'its', 'ours', 'yours', 'chaos', 'lens', 'atlas', 'kudos', 'jobs']);
/** The other endings a word is found by: "budgets" budget, "policies" policy, "taxes" tax, "voting" vot(e), "elected" elect */
export function stemsOf(w) {
  if (!/^[a-z]{4,}$/.test(w)) return [];
  const out = [];
  if (/ies$/.test(w) && w.length > 4) out.push(`${w.slice(0, -3)}y`);
  else if (/(ss|x|ch|sh|z)es$/.test(w)) out.push(w.slice(0, -2));
  else if (/[^su']s$/.test(w) && (w.length >= 5 || (w.length === 4 && !KEEP_S.has(w)))) out.push(w.slice(0, -1));
  if (/ing$/.test(w) && w.length >= 6) out.push(w.slice(0, -3));
  if (/ed$/.test(w) && w.length >= 6) out.push(w.slice(0, -2));
  if (/ship$/.test(w) && w.length >= 8) out.push(w.slice(0, -4));
  if (/ments?$/.test(w) && w.length >= 8) out.push(w.replace(/ments?$/, ''));
  return [...new Set(out)].filter((x) => x.length >= 3 && x !== w);
}

// A word's stem with an ending it takes, and nothing longer: "elect" is elect, elects, elected, election, never
// electric; "park" is parks and parked, never Parker; "policy" never policyholders ("officer" and "founder" keep
// their -er: office and foundation are other words)
export const ENDINGS = '(?:e|s|es|d|ed|ing|ings|ion|ions|al|ment|ments|ship|ships)?';
const stemRe = new Map();
export function stemIn(sp, stem) {
  if (!sp.includes(` ${stem}`)) return false;
  let re = stemRe.get(stem);
  if (!re) { re = new RegExp(` ${stem}${ENDINGS} `); if (stemRe.size > 400) stemRe.clear(); stemRe.set(stem, re); }
  return re.test(sp);
}

/** Damerau–Levenshtein distance, stopping once it's past `max` */
export function distance(a, b, max = 2) {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    let low = Infinity;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2][j - 2] + 1);
      d[i][j] = v;
      if (v < low) low = v;
    }
    if (low > max) return max + 1;
  }
  return d[a.length][b.length];
}

/** Every word in prepped texts, with how many of them it's in: Map(word → count) */
export function vocabOf(sps) {
  const count = new Map();
  for (const sp of sps) {
    const seen = new Set(sp.split(' '));
    for (const w of seen) if (w.length >= 3 && /^[a-z]+$/.test(w)) count.set(w, (count.get(w) || 0) + 1);
  }
  return count;
}

const fixes = new WeakMap();
/**
 * The word there nearest one nothing has: one letter off (two for a word of 8 or more), the same first letter, as
 * a whole word or the start of a longer one ("bugd" is the start of budget); the closer, then the commoner. '' when none
 */
export function nearest(w, vocab, names = null, { whole: wholeOnly = false } = {}) {
  if (!vocab || !/^[a-z]{4,}$/.test(w)) return '';
  let cache = fixes.get(vocab);
  if (!cache) { cache = new Map(); fixes.set(vocab, cache); }
  const ck = wholeOnly ? `=${w}` : w;
  if (cache.has(ck)) return cache.get(ck);
  // (a person's name, as near as any word, is the one meant: "Holy" is Holly, never the hole of a golf course)
  if (names) for (const v of names) if (v[0] === w[0] && !v.startsWith(w) && distance(w, v, w.length >= 8 ? 2 : 1) <= (w.length >= 8 ? 2 : 1)) { cache.set(ck, v); return v; }
  const max = w.length >= 8 ? 2 : 1;
  let best = '';
  let bestD = max + 1;
  let bestN = 0;
  let bestWhole = false;
  for (const [v, n] of vocab) {
    if (v[0] !== w[0] || v.startsWith(w)) continue;
    let dd = Math.abs(v.length - w.length) <= max ? distance(w, v, max) : max + 1;
    let whole = dd <= max;
    // (typing still: the start of a longer word, as near)
    if (!whole && v.length > w.length && !wholeOnly) { dd = Math.min(distance(w, v.slice(0, w.length), max), distance(w, v.slice(0, w.length + 1), max)); whole = false; }
    if (dd > max) continue;
    // The closer; then a whole word that near before the start of one; then the one in more places, then the shorter
    if (dd < bestD || (dd === bestD && ((whole && !bestWhole) || (whole === bestWhole && (n > bestN || (n === bestN && v.length < best.length)))))) { best = v; bestD = dd; bestN = n; bestWhole = whole; }
  }
  cache.set(ck, best);
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return best;
}

/** How many times words starting with `w` are in the page's words (up to `cap`) */
function startsCount(w, vocab, cap = 60) {
  let n = 0;
  for (const [v, c] of vocab) if (v.startsWith(w)) { n += c; if (n >= cap) break; }
  return n;
}

/**
 * What was typed, ready to find with: { terms: [{ w, alts: [{ w, kind }], small, prefer? }], joins, fixed }.
 * Each term with the other ways it's found: its endings ('stem'), the other ways a date is written ('same'), a near
 * spelling ('near') for a word nothing has, or for one that only starts a rare word ("bord" is board, not just a
 * donor named Borden: `prefer`, the near word first). `joins`: two words typed apart that the page has as one
 * ("by laws" is Bylaws): [{ a, b, w }]. `fixed`: [[typed, read as]].
 * `roles`: Map(a role's word → the names of who has it), so "treasurer" finds what Thomas presented ('who');
 * `has(w, how)`: whether anything has the term at all (how 'stem': with an ending; 'one': as one word, never two
 * side by side); `vocab`: Map(word → count), or a
 * function giving it (made only when a word needs it)
 */
export function planOf(terms, { vocab: given = null, has = null, roles = null, names = null } = {}) {
  let made = typeof given === 'function' ? undefined : given;
  const vocabNow = () => (made === undefined ? (made = given()) : made);
  const list = (terms || []).filter(Boolean);
  const anyBig = list.some((w) => !SMALL.has(w));
  const fixed = [];
  // (two words the page has as one, found first: "fund raiser" is fundraiser, never "fund raise")
  const joinable = new Set();
  if (has) for (let i = 0; i < list.length - 1; i++) {
    const j = `${list[i]}${list[i + 1]}`;
    if (/^[a-z]+$/.test(j) && j.length >= 5 && !SMALL.has(list[i + 1]) && has(j, 'one')) { joinable.add(i); joinable.add(i + 1); }
  }
  const out = list.map((w, idx) => {
    const small = anyBig && SMALL.has(w);
    const alts = [...stemsOf(w).map((x) => ({ w: x, kind: 'stem' })), ...samesOf(w).map((x) => ({ w: x, kind: 'same' })), ...(roles?.get(w) || []).map((x) => ({ w: x, kind: 'who' }))];
    let prefer = false;
    const vocab = !small && !joinable.has(idx) && given && has && /^[a-z]{4,}$/.test(w) ? vocabNow() : null;
    if (vocab) {
      const none = !has(w) && !alts.some((a) => has(a.w, true));
      // (or only the start of a word or two seen once or twice, never a name being typed: "bord" is board, while
      // "holl" is Holly being typed and "quor" quorum)
      const rare = !none && !vocab.has(w) && !alts.some((a) => vocab.has(a.w)) && startsCount(w, vocab, 3) <= 2 && !(names && [...names].some((n) => n.startsWith(w)));
      // (a word only starting a rare one is read as another only when one letter makes the whole of it: "bord" board,
      // never "quor" quarter)
      const near = none ? nearest(w, vocab, names) : rare ? nearest(w, vocab, names, { whole: true }) : '';
      if (near && (none || ((vocab.get(near) || 0) >= 3 && (vocab.get(near) || 0) >= 3 * startsCount(w, vocab)))) {
        alts.push({ w: near, kind: 'near' });
        fixed.push([w, near]);
        prefer = rare;
      }
    }
    return { w, alts, small, ...(prefer ? { prefer } : {}) };
  });
  // (two words the page has as one are that, or the two side by side: "by laws" is never "by" anywhere and Lawsky)
  const joins = [];
  if (has) for (let i = 0; i < list.length - 1; i++) {
    const j = `${list[i]}${list[i + 1]}`;
    // (never one ending in a small word: "budget vs" isn't a word, whatever a run-together title makes of it)
    if (/^[a-z]+$/.test(j) && j.length >= 5 && !SMALL.has(list[i + 1]) && has(j, 'one')) { joins.push({ a: i, b: i + 1, w: j, apart: `${list[i]} ${list[i + 1]}` }); out[i].small = false; out[i + 1].small = false; }
  }
  return { terms: out, joins, fixed, words: list };
}

/**
 * How a term is in prepped text: 3 a whole word (a date written another way too), 2 the start of one, 1.5 by its
 * ending, 1 a near spelling (2.5, ahead of the start of a rare word, when that's what it was read as), 0 not
 */
// (a long text's answer for a term is kept while it's searched: typing the next letter looks again only for the word
// being typed, never the ones before it)
const howKept = new Map();
const termKey = (t) => (t.k ??= `${t.w}|${t.prefer ? 1 : 0}|${t.alts.map((a) => `${a.kind[0]}${a.w}`).join(',')}`);
export function howIn(sp, t) {
  if (sp.length < 2000) return howNow(sp, t);
  let kept = howKept.get(sp);
  if (!kept) { if (howKept.size > 4000) howKept.clear(); howKept.set(sp, kept = new Map()); }
  const k = termKey(t);
  let v = kept.get(k);
  if (v === undefined) { v = howNow(sp, t); kept.set(k, v); }
  return v;
}
function howNow(sp, t) {
  if (wholeIn(sp, t.w)) return t.prefer ? 1 : 3;
  if (t.prefer && t.alts.some((a) => a.kind === 'near' && termIn(sp, a.w))) return 2.5;
  if (termIn(sp, t.w)) return t.prefer ? 1 : 2;
  let best = 0;
  for (const a of t.alts) {
    const v = a.kind === 'stem' ? (stemIn(sp, a.w) ? 1.5 : 0) : a.kind === 'same' ? (termIn(sp, a.w) ? 3 : 0) : a.kind === 'who' ? (termIn(sp, a.w) ? 1.5 : 0) : termIn(sp, a.w) ? 1 : 0;
    if (v > best) best = v;
  }
  return best;
}
/** Term i is there as half of two words the page has as one ("laws" of "by laws": Bylaws, or "by laws" side by side) */
const joinedIn = (sp, plan, i) => (plan.joins || []).some((j) => (j.a === i || j.b === i) && (termIn(sp, j.w) || sp.includes(` ${j.apart}`)));
const inJoin = (plan, i) => (plan.joins || []).some((j) => j.a === i || j.b === i);
/** Term i of the plan is in prepped text, by itself (one of two run together: only with the other) */
export const termAt = (sp, plan, i) => (inJoin(plan, i) ? joinedIn(sp, plan, i) : howIn(sp, plan.terms[i]) > 0);

/** Whether prepped text has every term that has to be there */
export const matches = (sp, plan) => plan.terms.length > 0 && plan.terms.every((t, i) => t.small || termAt(sp, plan, i));

/** How many times a term starts a word, up to `cap` (kept for a long text, as howIn's are) */
function countIn(sp, w, cap = 12) {
  if (sp.length >= 2000) {
    let kept = howKept.get(sp);
    if (!kept) { if (howKept.size > 4000) howKept.clear(); howKept.set(sp, kept = new Map()); }
    const k = `#${w}`;
    if (!kept.has(k)) kept.set(k, countNow(sp, w, cap));
    return kept.get(k);
  }
  return countNow(sp, w, cap);
}
function countNow(sp, w, cap) {
  let n = 0;
  for (let at = sp.indexOf(` ${w}`); at >= 0 && n < cap; at = sp.indexOf(` ${w}`, at + w.length + 1)) n++;
  return n;
}

/** The terms side by side, in order (the last one may be the start of a word) */
function phraseIn(sp, words) {
  if (words.length < 2) return false;
  const last = words.length - 1;
  return sp.includes(` ${words.slice(0, last).join(' ')} ${words[last]}`);
}

/**
 * How well a thing found matches: { title: prepped title, sp: prepped everything, date?: 'YYYY-MM-DD' }.
 * Higher is better; the title counts four times what the text does
 */
export function scoreOf(x, plan, { today = '' } = {}) {
  let s = 0;
  const any = plan.terms.some((t) => !t.small);
  const how = (sp, i, t) => (inJoin(plan, i) ? (joinedIn(sp, plan, i) ? 3 : 0) : howIn(sp, t));
  for (const [i, t] of plan.terms.entries()) {
    if (any && t.small) continue;
    const inTitle = how(x.title, i, t);
    // (`near`: what's next to its title, a file's kind and meeting, a person's role: more than the text, less than the title)
    const inNear = !inTitle && x.near ? how(x.near, i, t) : 0;
    const inText = inTitle || inNear ? 0 : how(x.sp, i, t);
    // (a whole word in the title most; the start of one there less than the words as typed side by side in the text)
    s += inTitle >= 3 ? 4 * inTitle : inTitle ? 2.5 * inTitle : inNear ? 2.5 * inNear : inText;
    // (how often, in the text: a little, never more than a word in the title)
    if (!inTitle) s += Math.min(1.5, Math.log2(1 + countIn(x.sp, t.w)) / 2);
  }
  for (const t of plan.terms) if (t.small && howIn(x.title, t)) s += 0.5;
  const words = plan.terms.map((t) => t.w);
  // (two words the page has as one count as side by side)
  if (phraseIn(x.title, words) || (plan.joins || []).some((j) => termIn(x.title, j.w))) s += 10;
  else if (phraseIn(x.sp, words) || (plan.joins || []).some((j) => termIn(x.sp, j.w))) s += 8;
  if (words[0] && x.title.startsWith(` ${words[0]}`)) s += 1;
  // (the title exactly what was typed: "Executive Director Report" is that report before the others named so)
  if (words.length && x.title.split(' ').filter(Boolean).slice(0, 40).join(' ').startsWith(words.join(' ')) && x.title.trim().split(' ').length <= words.length + 1) s += 5;
  // The newer first among the like (a meeting four years back counts about a third of this year's)
  if (x.date && today) {
    const years = Math.max(0, (Date.parse(today) - Date.parse(x.date)) / (365.25 * 86400000));
    if (Number.isFinite(years)) s += 1.5 * Math.exp(-years / 4);
  }
  return s;
}

/** The words to mark in what's shown: each term (the small words only when there's nothing else), the other ways it was found, the words run together */
export const marksOf = (plan) => {
  const any = plan.terms.some((t) => !t.small);
  return [...new Set([...plan.terms.filter((t) => !any || !t.small).flatMap((t) => [t.w, ...t.alts.map((a) => a.w)]), ...(plan.joins || []).map((j) => j.w)])].filter((w) => w.length > 1 || /\d/.test(w));
};

/** Which page of a file's words (pages apart by a form feed) a place in it is on, from 1 */
export function pageAt(words, at) {
  let n = 1;
  for (let i = String(words || '').indexOf('\f'); i >= 0 && i < at; i = words.indexOf('\f', i + 1)) n++;
  return n;
}
