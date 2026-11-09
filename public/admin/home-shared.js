/**
 * A home, from JobTread's location fields
 * ===========================================================================
 * Shared by Admin → Kids (the Home card beside a kid's profile) and
 * Applications → Insights (Their homes), and by the tests. JobTread stays the
 * record: nothing here stores or changes a value. Fields come in JobTread's own
 * order under JobTread's own names, so a field staff add to locations in
 * JobTread shows up here by itself, read the way its type and values suggest:
 *
 *  - money: a number named like a price or value (Zestimate, Latest Sale Price,
 *    Property Tax), never an ID or a district
 *  - area: a number named like an area (Living Area), in square feet; a lot's
 *    area stays a plain number, since it may be in acres
 *  - year: whole years, as a number or text (Year Built)
 *  - number, date, yes/no, choice (an option list), link (a URL)
 *  - bedbath: text like "3 bed, 2.5 bath", which Insights splits in two
 *  - text: anything else. On Insights, text that repeats (Power Company,
 *    Water Source) is counted like a choice; text that names one home (Parcel
 *    Number, Permit Number) stays on that home's card.
 *
 * Bookkeeping fields ("**…**"), retired ones ("Year Built (old)") and ones SOARD doesn't use (Water Source)
 * stay out.
 * Typed values are messy, so a field reads as numbers when most of its values
 * are numbers; the few that aren't ("Unknown", "1950s") are counted apart and
 * shown as typed, never dropped.
 */

const RETIRED = /\((?:old|retired|unused)\)\s*$/i;
// Fields SOARD doesn't use, left off both screens though JobTread still has them (Peter, Nov 9 2026: "we dont need water source")
const NOT_USED = new Set(['water source']);
const MONEY = /zestimate|price|\bvalues?\b|valuation|\bcosts?\b|amount|apprais|\bassess(?:ed|ment)?\b|\btax(?:es)?\b|\brent\b|\bequity\b|\bmortgage\b|\bloan\b|\bbalance\b|\bdebt\b|\bowed\b|\bhoa\b|\bfees?\b|\bdues\b|payment|premium|income|\bbills?\b|estimate\b|budget|\bsold\b|insurance|\$/i;
// Words that make a number a label, a count or a rate, not dollars: "Tax ID", "Tax District", "Tax Rate"
const NOT_MONEY = /\b(?:id|number|no|#|district|code|zone|rate|percent|year|count|occupants|people)\b|%/i;
const AREA = /\barea\b|sq\.?\s*f(?:ee)?t|square\s*f(?:ee|oo)t/i;
const NOT_AREA = /\blot\b|acre/i;
// Names of things that belong to one home ("Parcel Number", "Tax ID", "Lot #"): never counted across homes,
// never read as an amount. "Number of Stories" is a count, not one of these.
const ONE_HOME = /(?:\bnumber|\bno\.?|#|\bid)\s*$|\bcode\b|parcel|url|link|notes?\b|comments?\b|address|\bzip\b|postal|phone|e-?mail|\bname\b|instructions?|directions?|\bgate\b|lockbox|description|details?\b/i;
const BEDS = /(\d+(?:\.\d+)?)\s*(?:bed|bd|br)/i;
const BATHS = /(\d+(?:\.\d+)?)\s*(?:bath|ba\b)/i;
const STUDIO = /\bstudio\b/i;
const NUMERIC_KINDS = new Set(['money', 'area', 'year', 'number', 'date']);
// A field reads as numbers when at least this share of its values are numbers
const MOSTLY = 0.75;
// A count with this few different whole numbers (Stories: 1 or 2) reads better as rows than as a strip
const FEW = 6;
// Where SOARD works: a date and time reads as it was in Georgia
const TZ = 'America/New_York';

/** A value as plain words: an object (an address field can be one) reads as its parts, never "[object Object]" */
const words = (v) => (v && typeof v === 'object'
  ? Object.values(v).filter((x) => (typeof x === 'string' || typeof x === 'number') && String(x).trim() !== '').join(', ')
  : String(v ?? '').trim());

/** Has a value worth showing */
export const filled = (v) => (Array.isArray(v) ? v.some(filled) : v != null && words(v) !== '');

/** A field staff should see: not JobTread bookkeeping, not retired */
export const isShown = (f) => !!String(f?.name || '').trim() && !/^\*\*/.test(f.name) && !RETIRED.test(f.name) && !NOT_USED.has(String(f.name).trim().toLowerCase());

/** JobTread's order: positions as numbers when they are, else as plain text (character by character, never by locale) */
function byPosition(a, b) {
  const x = a.position;
  const y = b.position;
  if (x == null || y == null || x === y) return a.at - b.at;
  const nx = Number(x);
  const ny = Number(y);
  if (String(x).trim() !== '' && String(y).trim() !== '' && Number.isFinite(nx) && Number.isFinite(ny)) return nx - ny || a.at - b.at;
  return String(x) < String(y) ? -1 : 1;
}

/** The fields to show, in JobTread's order ({ id, name, type, options?, position? } from JobTread) */
export function homeFields(defs) {
  return (defs || [])
    .filter((f) => f?.id && isShown(f))
    .map((f, i) => ({ id: f.id, name: String(f.name).replace(/^\*+|\*+$/g, '').trim(), type: f.type || 'text', position: f.position ?? null, at: i, ...(Array.isArray(f.options) ? { options: f.options } : {}) }))
    .sort(byPosition)
    .map(({ at, ...f }) => f);
}

/**
 * A number from a number or from text the way people type amounts: "$336,500", "$ 3,100", "$2.1k",
 * "$1.2M", "about $2,000", "$2,300/yr", "($5,000)", "1,435 sq ft". null when it isn't one.
 */
export function asNumber(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v == null || typeof v === 'object') return null;
  let t = String(v).trim().toLowerCase();
  let sign = 1;
  const paren = t.match(/^\((.*)\)$/);
  if (paren) { t = paren[1].trim(); sign = -1; }
  t = t.replace(/^(?:about|approx\.?|approximately|around|roughly|est\.?|~)\s*/, '')
    .replace(/\s*(?:\/\s*(?:yr|year|mo|month)|(?:per|a|each)\s+(?:year|month)|annually|monthly|usd)\.?$/, '')
    .replace(/\s*(?:sq\.?\s*f(?:ee)?t|sf)\.?$/, '');
  if (t.startsWith('-')) { sign = -sign; t = t.slice(1).trim(); }
  t = t.replace(/^\$\s*/, '').replace(/,/g, '');
  const m = t.match(/^(\d+(?:\.\d+)?)\s*([km])?$/);
  if (!m) return null;
  return sign * Number(m[1]) * (m[2] === 'k' ? 1e3 : m[2] === 'm' ? 1e6 : 1);
}
const isYear = (n) => n != null && Number.isInteger(n) && n >= 1700 && n <= 2100;
// A date with a time of day, read in Georgia. Midnight UTC exactly is how a plain date often arrives, so it stays that date.
const hasTime = (v) => /\d{4}-\d{2}-\d{2}[T ]\d/.test(String(v ?? '')) && !/[T ]00:00(?::00(?:\.0+)?)?(?:z|\+00:?00)$/i.test(String(v ?? '').trim());
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ][\d:.]+(?:z|[+-]\d{2}:?\d{2})?)?$/i;

/** A JobTread date ("2001-01-23", or a date and time) as a time; a plain date is read in UTC so it never slips a day */
export function asTime(v) {
  if (v == null || typeof v === 'object') return null;
  const s = String(v).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  const t = m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

const isMoneyName = (name) => MONEY.test(name) && !NOT_MONEY.test(name);
const isAreaName = (name) => AREA.test(name) && !NOT_AREA.test(name);

/** The number-like kind a field's name and numbers suggest, or null for digits that name one home (a parcel number, a tax ID) */
function numberKind(f, nums) {
  const name = String(f?.name || '');
  if (ONE_HOME.test(name)) return null;
  if (isMoneyName(name)) return 'money';
  if (isAreaName(name)) return 'area';
  // A year field reads as years even with a typo in it ("19877" is counted apart, never as 19,877)
  if (/\byear\b/i.test(name) && (!nums.length || nums.some((n) => isYear(n)))) return 'year';
  return 'number';
}
const isBedBath = (v) => BEDS.test(words(v)) || BATHS.test(words(v)) || STUDIO.test(words(v));

/** How a field reads, from its JobTread type, its name and the values it holds */
export function kindOf(f, values = []) {
  const vals = [].concat(values).flat().filter(filled);
  switch (f?.type) {
    case 'url': return 'link';
    case 'date': case 'datetime': return 'date';
    case 'boolean': return 'yesno';
    case 'option': return 'choice';
    case 'emailAddress': case 'phoneNumber': case 'address': case 'time': return 'text';
    default: break;
  }
  const nums = vals.map(asNumber).filter((n) => n != null);
  const most = (n) => vals.length > 0 && n >= Math.max(1, Math.ceil(vals.length * MOSTLY));
  if (f?.type === 'number') return numberKind(f, nums) || 'text';
  // Text that holds dates ("2001-01-23"), most of them
  if (most(vals.filter((v) => ISO_DATE.test(words(v)) && asTime(v) != null).length)) return 'date';
  // Text that holds numbers: most of them (a stray "Unknown" doesn't change what the field is)
  if (most(nums.length)) {
    const kind = numberKind(f, nums);
    if (kind) return kind;
  }
  // "3 bed, 2.5 bath", most of the time
  if (most(vals.filter(isBedBath).length) && vals.some((v) => BEDS.test(words(v)) || STUDIO.test(words(v)))) return 'bedbath';
  return 'text';
}

const money = (n) => `${n < 0 ? '-' : ''}$${Math.abs(Math.round(n)).toLocaleString('en-US')}`;
/** "$336K", "$1.2M": for the ends of a scale, where the full amount is a hover away */
export function shortMoney(n) {
  const sign = n < 0 ? '-' : '';
  const a = Math.abs(n);
  const m = (x) => `${sign}$${x}M`;
  if (a >= 1e6 || Math.round(a / 1e3) >= 1000) return m((a / 1e6).toFixed(a >= 9.95e6 ? 0 : 1).replace(/\.0$/, ''));
  if (a >= 1e3) return `${sign}$${Math.round(a / 1e3).toLocaleString('en-US')}K`;
  return money(n);
}
/** A date as people read it; one with a time of day, as it was in Georgia */
function dateText(t, timed = false) {
  return new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: timed ? TZ : 'UTC' });
}
const yearOf = (t, timed = false) => Number(new Date(t).toLocaleDateString('en-US', { year: 'numeric', timeZone: timed ? TZ : 'UTC' }));

/** "zillow.com" from a link */
export function hostOf(url) {
  try { return new URL(String(url)).hostname.replace(/^www\./, ''); } catch { return ''; }
}
/** Only web links open from the admin; "www.zillow.com/…" (no https) is one too */
export function safeUrl(v) {
  const s = words(v);
  const tryUrl = (x) => { try { const u = new URL(x); return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null; } catch { return null; } };
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return tryUrl(s);
  return /^(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:[/?#]\S*)?$/i.test(s) ? tryUrl(`https://${s}`) : null;
}
/** A link's words: its field's name without "URL" ("Zillow URL" → "Zillow"), else where it goes */
export function linkLabel(f, url) {
  const name = String(f?.name || '').replace(/\b(?:url|link|website|web site)\b/ig, '').replace(/\s+/g, ' ').trim();
  return name || hostOf(url) || 'Link';
}

/** One value, the way a person reads it */
export function show(kind, v) {
  if (Array.isArray(v)) return v.filter(filled).map((x) => show(kind, x)).join(', ');
  if (!filled(v)) return '';
  const n = asNumber(v);
  switch (kind) {
    case 'money': return n == null ? words(v) : money(n);
    case 'area': return n == null ? words(v) : `${Math.round(n).toLocaleString('en-US')} sq ft`;
    case 'year': return n == null ? words(v) : String(n);
    case 'number': return n == null ? words(v) : n.toLocaleString('en-US', { maximumFractionDigits: 2 });
    case 'date': { const t = asTime(v); return t == null ? words(v) : dateText(t, hasTime(v)); }
    case 'yesno': return v === true || /^(true|yes|1)$/i.test(words(v)) ? 'Yes' : 'No';
    case 'link': return hostOf(safeUrl(v)) || words(v);
    default: return words(v);
  }
}

/**
 * The home's value, which leads on both pages: the Zestimate itself first, then a field named for the home's
 * value. Never a rent, tax or assessed figure, and never one that says $0.
 */
export function leadOf(list) {
  const worth = (x) => x.kind === 'money' && !/rent|tax|assess/i.test(x.name) && (x.median ?? asNumber([].concat(x.value).find(filled))) > 0;
  return list.find((x) => worth(x) && /^\s*zestimate\s*$/i.test(x.name))
    || list.find((x) => worth(x) && /\b(?:home|market|estimated|current)?\s*value\b/i.test(x.name))
    || list.find((x) => worth(x) && /zestimate/i.test(x.name))
    || null;
}

/**
 * One home's card: what JobTread has, in its order.
 * lead: the home's value (Zestimate); links: its web links (Zillow); rest: every other filled field, a
 * link that isn't a web link shown as typed; blank: names of the fields still empty.
 */
export function homeFacts(defs, values = {}) {
  const facts = [];
  const blank = [];
  for (const f of homeFields(defs)) {
    const v = values?.[f.id];
    if (!filled(v)) { blank.push(f.name); continue; }
    const kind = kindOf(f, [v]);
    const href = kind === 'link' ? safeUrl(v) : null;
    facts.push({ id: f.id, name: f.name, kind, value: v, text: kind === 'link' && href ? linkLabel(f, href) : show(kind === 'link' ? 'text' : kind, v), href });
  }
  const lead = leadOf(facts);
  const links = facts.filter((x) => x.kind === 'link' && x.href);
  const rest = facts.filter((x) => x !== lead && !links.includes(x));
  return { lead, links, rest, blank, filled: facts.length };
}

const medianOf = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length ? (s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) : null;
};
/** A sorted list's value at a share of the way along (0.25 is the lower quartile), between values when it falls between */
const quantile = (sorted, q) => {
  const at = (sorted.length - 1) * q;
  const lo = Math.floor(at);
  return sorted[lo] + (sorted[Math.min(sorted.length - 1, lo + 1)] - sorted[lo]) * (at - lo);
};

/** A strip's own value, as text: a date's median is its year, an amount's median is rounded the way the field reads */
export function stripText(kind, v, timed = false) {
  if (v == null) return '';
  if (kind === 'date') return String(yearOf(v, timed));
  if (kind === 'year') return String(Math.round(v));
  if (kind === 'area') return `${Math.round(v).toLocaleString('en-US')} sq ft`;
  return show(kind, v);
}
/** The ends of a strip's scale, kept short */
export function endText(kind, v, timed = false) {
  if (kind === 'money') return shortMoney(v);
  return stripText(kind, v, timed);
}

const plural = (n, one, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const halfWords = (n, one, many) => `${String(n).replace(/\.0$/, '')} ${n === 1 ? one : many}`;
const capital = (t) => (/^[A-Z]/.test(t) ? 1 : 0);

/** Count a field's homes by their answer: the way most homes spell it, most first (ties alphabetical) */
function countBy(homes, keyOf, labelOf, order = null) {
  const byKey = new Map();
  for (const p of homes) {
    for (const raw of [].concat(keyOf(p)).filter((x) => x != null && x !== '')) {
      const key = typeof raw === 'number' ? raw : raw && typeof raw === 'object' && 'key' in raw ? raw.key : words(raw).replace(/\s+/g, ' ').toLowerCase();
      if (key === '') continue;
      const row = byKey.get(key) || { key, said: {}, list: [] };
      const said = labelOf(raw);
      row.said[said] = (row.said[said] || 0) + 1;
      if (!row.list.includes(p)) row.list.push(p);
      byKey.set(key, row);
    }
  }
  const rows = [...byKey.values()].map((r) => ({
    key: r.key,
    // On a tie, the spelling that reads like a label ("Public" over "public")
    label: Object.entries(r.said).sort((a, b) => b[1] - a[1] || capital(b[0]) - capital(a[0]) || a[0].localeCompare(b[0]))[0][0],
    n: r.list.length,
    list: r.list,
  }));
  return rows.sort(order || ((a, b) => b.n - a.n || a.label.localeCompare(b.label)));
}
const byNumber = (a, b) => a.key - b.key;

/** "not a number", "not a year", "not a date": what a value a strip can't place isn't */
export const oddWords = (kind) => (kind === 'year' ? 'not a year' : kind === 'date' ? 'not a date' : 'not a number');

/** The least a strip's scale spans, so a tiny spread ($200K to $204K) never looks as wide as a big one */
function leastSpan(kind, median) {
  if (kind === 'year') return 10;
  if (kind === 'date') return 365 * 864e5;
  return Math.max(1, Math.abs(median || 0) * 0.1);
}
/**
 * An answer's key for counting: without the field's own words, so answers that differ only by them are one
 * ("Public Water" and "Public" under Water Source, "Cobb County" and "Cobb" under County). Never empty.
 */
function answerKey(fieldName, v) {
  const own = new Set(String(fieldName || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean));
  const all = words(v).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const kept = all.filter((w) => !own.has(w));
  return (kept.length ? kept : all).join(' ');
}

/**
 * Their homes, across the people shown. people: [{ id, name, home: { [fieldId]: value }, ... }],
 * only those with a home in JobTread (home may be empty). Returns
 *  - strips: a number-like field each, its homes in order of value, with the median and the range;
 *    the home's value (Zestimate) first, the rest in JobTread's order. `missing`: nothing filled in;
 *    `odd`: filled in with something that isn't a number (shown as typed). `low`/`high`: the
 *    min and max of the homes that aren't far out; a home far past the rest sits beyond a break
 *    in the scale, so one mansion doesn't squash everyone else into a corner.
 *  - groups: a choice-like field each (bedrooms and bathrooms count apart; a whole number with
 *    only a few different values, like Stories, too), its answers most first or in number order.
 *    `missing` as above.
 * A field no one has filled in is left out; text that names one home is too.
 */
export function homeInsights(defs, people) {
  const homes = (people || []).filter((p) => p && p.home && typeof p.home === 'object');
  const strips = [];
  const groups = [];
  for (const f of homeFields(defs)) {
    const have = homes.filter((p) => filled(p.home[f.id]));
    if (!have.length) continue;
    const missing = homes.filter((p) => !filled(p.home[f.id]));
    const kind = kindOf(f, have.map((p) => p.home[f.id]));
    if (NUMERIC_KINDS.has(kind)) {
      const timed = kind === 'date' && have.some((p) => hasTime([].concat(p.home[f.id]).find(filled)));
      const read = (p) => {
        const raw = [].concat(p.home[f.id]).find(filled);
        let v = kind === 'date' ? asTime(raw) : asNumber(raw);
        // A year field's typo ("19877") or a 0 for unknown is counted apart, not placed
        if (kind === 'year' && v != null && !isYear(v)) v = null;
        return { p, v, raw, text: v == null ? words(raw) : show(kind, raw) };
      };
      const all = have.map(read);
      // $0 is no one's home value (DataX and staff write it for "unknown"): counted apart, never pulling the median down
      const zero = kind === 'money' ? all.filter((x) => x.v === 0) : [];
      const points = all.filter((x) => x.v != null && !zero.includes(x)).sort((a, b) => a.v - b.v || String(a.p.name || '').localeCompare(String(b.p.name || '')));
      const odd = all.filter((x) => x.v == null);
      if (!points.length) continue;
      // A whole-number count with a few values that repeat (Stories: 1 or 2 across many homes) is clearer as rows
      const distinct = new Set(points.map((x) => x.v));
      if (kind === 'number' && distinct.size <= FEW && points.length >= distinct.size * 2 && points.every((x) => Number.isInteger(x.v))) {
        const rows = countBy(points.map((x) => x.p), (p) => asNumber([].concat(p.home[f.id]).find(filled)), (n) => n.toLocaleString('en-US'), byNumber);
        if (odd.length) rows.push({ key: 'odd', label: 'Written another way', n: odd.length, list: odd.map((x) => x.p), odd: true });
        groups.push({ id: f.id, name: f.name, kind, rows, missing, said: Object.fromEntries(odd.map((x) => [x.p.id, x.text])) });
        continue;
      }
      const vs = points.map((x) => x.v);
      let low = vs[0];
      let high = vs[vs.length - 1];
      // Far out: past three times the middle half's spread beyond it (only with enough homes to know what the middle is)
      if (vs.length >= 5) {
        const q1 = quantile(vs, 0.25);
        const q3 = quantile(vs, 0.75);
        const spread = q3 - q1;
        if (spread > 0) {
          const inside = vs.filter((v) => v >= q1 - 3 * spread && v <= q3 + 3 * spread);
          low = inside[0];
          high = inside[inside.length - 1];
        }
      }
      const median = medianOf(vs);
      const least = leastSpan(kind, median);
      if (high - low < least) {
        const mid = (low + high) / 2;
        low = mid - least / 2;
        high = mid + least / 2;
      }
      strips.push({
        id: f.id, name: f.name, kind, timed, points, odd: odd.map((x) => ({ p: x.p, text: x.text })), zero: zero.map((x) => x.p),
        median, min: vs[0], max: vs[vs.length - 1], low, high, missing,
      });
    } else if (kind === 'bedbath') {
      // A 0 is how DataX writes "Zillow doesn't know" ("undefined bed, 0 bath"), so it counts as not given;
      // a studio is only a studio when it says so
      const part = (re, studio) => (p) => [].concat(p.home[f.id]).map((x) => {
        const t = words(x);
        if (studio && STUDIO.test(t)) return 0;
        const m = t.match(re);
        return m && Number(m[1]) > 0 ? Number(m[1]) : null;
      }).filter((x) => x != null);
      const beds = countBy(have, part(BEDS, true), (n) => (n === 0 ? 'Studio' : halfWords(n, 'bedroom', 'bedrooms')), byNumber);
      const baths = countBy(have, part(BATHS, false), (n) => halfWords(n, 'bath', 'baths'), byNumber);
      const said = Object.fromEntries(have.map((p) => [p.id, show('text', p.home[f.id])]));
      const split = (rows, name, id, none, otherPart) => {
        const counted = new Set(rows.flatMap((r) => r.list));
        // Filled in, but not with a number of these: the other half only ("3 bed") says none was given;
        // anything else ("Mobile home") is shown as typed. Never "not filled in": something is there.
        const other = have.filter((p) => !counted.has(p));
        const gaveOther = other.filter((p) => [].concat(p.home[f.id]).some((x) => otherPart.test(words(x)) || /\b(?:bed|bath)/i.test(words(x))));
        const rest = other.filter((p) => !gaveOther.includes(p));
        if (gaveOther.length) rows.push({ key: 'none', label: none, n: gaveOther.length, list: gaveOther, odd: true });
        if (rest.length) rows.push({ key: 'odd', label: 'Written another way', n: rest.length, list: rest, odd: true });
        if (rows.length) groups.push({ id: `${f.id}:${id}`, name, from: f.name, kind, rows, missing, said });
      };
      split(beds, 'Bedrooms', 'beds', 'No bedrooms given', BATHS);
      split(baths, 'Bathrooms', 'baths', 'No baths given', new RegExp(`${BEDS.source}|${STUDIO.source}`, 'i'));
    } else if (kind === 'choice' || kind === 'yesno' || (kind === 'text' && !ONE_HOME.test(f.name))) {
      const rows = countBy(have, (p) => [].concat(p.home[f.id]).filter(filled).map((x) => ({ key: answerKey(f.name, x), said: show(kind, x) })), (x) => x.said);
      // Typed text counts only when homes share answers: most answers alike (Water Source: Public, Well), not
      // each home's own words, which belong on that home's card
      if (kind === 'text' && rows.filter((r) => r.n >= 2).reduce((n, r) => n + r.n, 0) < have.length / 2) continue;
      groups.push({ id: f.id, name: f.name, kind, rows, missing });
    }
  }
  // The home's value leads, as on a kid's Home card; the rest keep JobTread's order
  const lead = leadOf(strips);
  return { homes, strips: lead ? [lead, ...strips.filter((x) => x !== lead)] : strips, groups };
}

/** "12 homes", "1 home" */
export const homesText = (n) => plural(n, 'home');

/**
 * Where a strip's dots sit. x runs from `low` to `high` across the width (pad at both ends); a home past
 * them sits in a zone of its own beyond a break (`zone` px wide). Each dot takes a lane so no two overlap,
 * lanes alternating below and above the line (0, 1, -1, 2, -2…) like a swarm, at most `maxLanes` of them:
 * past that a dot shares the lane with the most room, so a pile stays a pile instead of a tower.
 * gap: a dot's width plus air.
 */
export function placeDots(points, { width, pad = 10, gap = 14, maxLanes = 7, min, max, low = min, high = max, zone = 30 }) {
  const before = points.some((p) => p.v < low);
  const after = points.some((p) => p.v > high);
  const left = pad + (before ? zone : 0);
  const right = width - pad - (after ? zone : 0);
  const span = high - low;
  const usable = Math.max(1, right - left);
  const xOf = (v) => {
    if (v < low) return pad + zone / 2;
    if (v > high) return width - pad - zone / 2;
    return left + (span > 0 ? ((v - low) / span) * usable : usable / 2);
  };
  const lanes = []; // last x in each lane, in the order 0, 1, -1, 2, -2…
  const laneAt = (i) => (i === 0 ? 0 : i % 2 ? (i + 1) / 2 : -i / 2);
  const placed = points.map((pt) => {
    const x = xOf(pt.v);
    let i = lanes.findIndex((last) => x - last >= gap);
    let piled = false;
    if (i < 0 && lanes.length < maxLanes) { i = lanes.length; lanes.push(x); } else if (i < 0) {
      // Every lane is taken here: the one whose last dot is furthest back
      i = lanes.reduce((best, last, k) => (last < lanes[best] ? k : best), 0);
      lanes[i] = x;
      piled = true;
    } else lanes[i] = x;
    return { ...pt, x, lane: laneAt(i), piled };
  });
  const lo = Math.min(0, ...placed.map((d) => d.lane));
  const hi = Math.max(0, ...placed.map((d) => d.lane));
  // Where dots had to share a lane: one pile per place, with every home in it, so the strip can say how many
  const piles = [];
  for (const d of placed.filter((x) => x.piled)) {
    const pile = piles.find((q) => Math.abs(q.x - d.x) < gap * 1.5);
    if (pile) { pile.list.push(d); pile.x = (pile.x * (pile.list.length - 1) + d.x) / pile.list.length; } else piles.push({ x: d.x, list: [d] });
  }
  return { dots: placed, lo, hi, xOf, piles, breaks: { before, after, left, right } };
}

// ─── By decision ────────────────────────────────────────────────────
// Insights compares homes by what JobTread's Status says about each family

/** Approved, Denied, still deciding (Applied or In Review), or no status recorded, in that order */
export const DECISIONS = [
  { key: 'approved', label: 'Approved' },
  { key: 'denied', label: 'Denied' },
  { key: 'deciding', label: 'Still deciding' },
  { key: 'none', label: 'No status' },
];
/** Which of DECISIONS a JobTread Status is */
export function decisionOf(status) {
  const s = String(status || '').trim().toLowerCase();
  if (s === 'approved') return 'approved';
  if (s === 'denied') return 'denied';
  return s ? 'deciding' : 'none';
}
const meanOf = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/**
 * A strip's homes by decision: [{ key, label, points, median, mean }] for each decision that has any,
 * then everyone ({ key: 'all' }). Medians and averages of the placed values only (no blanks, no $0, no typos).
 */
export function byDecision(strip) {
  const groups = DECISIONS.map((d) => {
    const points = strip.points.filter((x) => decisionOf(x.p.status) === d.key);
    const vs = points.map((x) => x.v);
    return { ...d, points, median: medianOf(vs), mean: meanOf(vs) };
  }).filter((d) => d.points.length);
  const vs = strip.points.map((x) => x.v);
  return [...groups, { key: 'all', label: 'Everyone', points: strip.points, median: medianOf(vs), mean: meanOf(vs) }];
}

/** How many of a list are in each decision: { approved: 3, denied: 1, … } */
export function decisionCounts(list) {
  const out = {};
  for (const p of list || []) { const k = decisionOf(p.status); out[k] = (out[k] || 0) + 1; }
  return out;
}
