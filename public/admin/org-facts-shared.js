/**
 * SOARD's own facts, the parts with no screen
 * ===========================================================================
 * The name, EIN, addresses and mission are the site's (Site Config →
 * Organization & contact: settings, and media.mission). The IRS's list of
 * tax-exempt organizations and SOARD's W-9 are checked against them
 * (functions/api/_org-facts.js). This says what doesn't match, the same way
 * on the server (Slack, Automations) and in Site Config, where it's worked
 * out again from what's typed, so a fix shows as fixed before it's saved.
 * No DOM, no imports. tests/org-facts.test.mjs checks it.
 */

export const SITE_HOST = 'sunshineonaranneyday.com';
export const FORM_8822B = 'https://www.irs.gov/forms-pubs/about-form-8822-b';
export const TEOS = 'https://apps.irs.gov/app/eos/';

// ─── Words in, keys out ─────────────────────────────────────────────

export const einDigits = (s) => String(s || '').replace(/\D/g, '');
export const einText = (s) => { const d = einDigits(s); return d.length === 9 ? `${d.slice(0, 2)}-${d.slice(2)}` : String(s || ''); };
const words = (s) => String(s || '').toUpperCase().replace(/&/g, ' AND ').replace(/[^A-Z0-9]+/g, ' ').trim().split(' ').filter(Boolean);

// A company's name however it's written: case, punctuation, "Inc." for "Incorporated"
const NAME_WORDS = { INC: 'INCORPORATED', CORP: 'CORPORATION', CO: 'COMPANY', LTD: 'LIMITED' };
export const nameKey = (s) => words(s).map((w) => NAME_WORDS[w] || w).join(' ');
/** Two names for the same company: one the other with Inc. (or Incorporated) left off counts too */
export function sameName(a, b) {
  const x = nameKey(a); const y = nameKey(b);
  if (!x || !y) return false;
  const bare = (k) => k.replace(/ (INCORPORATED|CORPORATION|COMPANY|LIMITED|LLC)$/, '');
  return x === y || bare(x) === bare(y);
}

// A street the way the Postal Service shortens it, so "Suite 106" is "Ste. 106" and "Highway" is "Hwy"
const STREET_WORDS = {
  STREET: 'ST', DRIVE: 'DR', ROAD: 'RD', AVENUE: 'AVE', BOULEVARD: 'BLVD', HIGHWAY: 'HWY', PARKWAY: 'PKWY', LANE: 'LN', COURT: 'CT',
  CIRCLE: 'CIR', PLACE: 'PL', TERRACE: 'TER', TRAIL: 'TRL', POINT: 'PT', CROSSING: 'XING', MOUNT: 'MT', FREEWAY: 'FWY', EXPRESSWAY: 'EXPY',
  SQUARE: 'SQ', SUITE: 'STE', UNIT: 'STE', APARTMENT: 'APT', BUILDING: 'BLDG', FLOOR: 'FL', ROOM: 'RM',
  NORTH: 'N', SOUTH: 'S', EAST: 'E', WEST: 'W', NORTHEAST: 'NE', NORTHWEST: 'NW', SOUTHEAST: 'SE', SOUTHWEST: 'SW',
};
export const streetKey = (s) => words(String(s || '').replace(/#/g, ' STE ')).map((w) => STREET_WORDS[w] || w).join(' ');
const zip5 = (z) => String(z || '').replace(/\D/g, '').slice(0, 5);

export const isAddress = (a) => !!String(a?.street || '').trim();
/** One line: "250 Hembree Park Drive, Suite 106, Roswell, GA 30076" */
export const addressLine = (a) => (isAddress(a) ? [a.street, a.city, [a.state, a.zip].filter(Boolean).join(' ')].map((x) => String(x || '').trim()).filter(Boolean).join(', ') : '');
/** The same place: the street, the city and the first five digits of the ZIP (the state goes with the ZIP) */
export function sameAddress(a, b) {
  if (!isAddress(a) || !isAddress(b)) return false;
  return streetKey(a.street) === streetKey(b.street) && words(a.city).join(' ') === words(b.city).join(' ') && zip5(a.zip) === zip5(b.zip);
}
/** Where SOARD's mail goes: the mailing address when there is one, else the office */
export const hasMailing = (settings) => isAddress(settings?.mailingAddress);
export const mailingOf = (settings) => (hasMailing(settings) ? settings.mailingAddress : settings?.address || {});

/** The IRS's capitals as a person writes them: "Sunshine on a Ranney Day Incorporated", "10800 Alpharetta Hwy Suite 208 625" */
const SMALL = new Set(['A', 'AN', 'AND', 'AT', 'BY', 'FOR', 'IN', 'OF', 'ON', 'OR', 'THE', 'TO']);
const KEEP = new Set(['NE', 'NW', 'SE', 'SW', 'PO', 'LLC', 'USA']);
export function titleCase(s) {
  return String(s || '').toLowerCase().split(/(\s+)/).map((w, i) => {
    const up = w.toUpperCase();
    if (KEEP.has(up)) return up;
    if (i > 0 && SMALL.has(up)) return w;
    // (a number's ending stays small: "10th", "208a")
    return /^\d/.test(w) ? w : w.replace(/^([^a-z]*)([a-z])/, (_, a, b) => a + b.toUpperCase());
  }).join('');
}

/** The mission however it's punctuated or spaced */
export const missionKey = (s) => String(s || '').toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

// ─── The IRS's list (the Business Master File, irs.gov/pub/irs-soi/eo_<state>.csv) ─

/** One CSV line → its cells (a cell may be quoted, with "" for a quote inside) */
export function csvCells(line) {
  const out = []; let cur = ''; let q = false;
  const s = String(line || '').replace(/\r$/, '');
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) {
      if (c === '"' && s[i + 1] === '"') { cur += '"'; i++; } else if (c === '"') q = false; else cur += c;
    } else if (c === '"') q = true;
    else if (c === ',') { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out;
}

/** The header and SOARD's line → what the site keeps of it */
export function irsRecord(header, line) {
  const names = csvCells(header).map((x) => x.trim().toUpperCase());
  const cells = csvCells(line);
  const at = (k) => String(cells[names.indexOf(k)] ?? '').trim();
  return {
    ein: einDigits(at('EIN')),
    name: at('NAME'),
    careOf: at('ICO'),
    street: at('STREET'),
    city: at('CITY'),
    state: at('STATE'),
    zip: at('ZIP'),
    subsection: at('SUBSECTION'),
    ruling: at('RULING'),
    deductibility: at('DEDUCTIBILITY'),
    foundation: at('FOUNDATION'),
    status: at('STATUS'),
    taxPeriod: at('TAX_PERIOD'),
    ntee: at('NTEE_CD'),
  };
}
export const irsAddress = (r) => ({ street: titleCase(r?.street), city: titleCase(r?.city), state: String(r?.state || '').toUpperCase(), zip: String(r?.zip || '') });
/** A 501(c)(3) the IRS lists as exempt, gifts to it deductible */
export const exempt = (r) => !!r && r.subsection === '03' && r.status === '01' && r.deductibility === '1';
/** "201207" → "July 2012" */
export function rulingText(s) {
  const m = String(s || '').match(/^(\d{4})(\d{2})$/);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) return '';
  return `${['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][Number(m[2]) - 1]} ${m[1]}`;
}
/** The kind of public charity a grant form asks about, by the IRS's foundation code (only the two a charity like SOARD is) */
export const PUBLIC_CHARITY = { 15: '509(a)(1) and 170(b)(1)(A)(vi)', 16: '509(a)(2)' };
/** What the IRS's list says, in words, for a status that isn't right */
export function statusWords(r) {
  const bits = [];
  if (r.subsection !== '03') bits.push(`501(c)(${Number(r.subsection) || r.subsection || '?'}) rather than 501(c)(3)`);
  if (r.status !== '01') bits.push(`exemption status code ${r.status || 'blank'} rather than 01 (exempt)`);
  if (r.deductibility !== '1') bits.push('gifts not listed as deductible');
  return bits.join(', ');
}

// ─── The Board Manual's own mission statement ───────────────────────

/** "MISSION STATEMENT Creating spaces … needs. GOALS AND PURPOSE …" → the statement */
export function manualMission(text) {
  const m = String(text || '').replace(/\s+/g, ' ').match(/MISSION STATEMENT:?\s+(.{20,700}?)\s+(?=GOALS|VISION|VALUES|PURPOSE|FACTS ABOUT|PROGRAMS)/);
  return m ? m[1].trim() : '';
}

// ─── What doesn't match ─────────────────────────────────────────────

/**
 * { settings, media, check } → [{ key, level, title, detail, site, other, otherLabel, fix, link }], most urgent first.
 * check: site_config 'org-check' (functions/api/_org-facts.js). level: 'urgent' (the exemption itself), 'warn'
 * (a form or a W-9 would be wrong), 'note' (two of SOARD's own papers disagree). fix.set: [[doc, path, value]]
 * for Site Config to put in; link: { label, url }.
 */
export function problemsFor({ settings = {}, media = {}, check = null } = {}) {
  const out = [];
  if (!check) return out;
  const ein = einDigits(settings.ein);
  const irs = check.irs || {};
  const listed = irs.date ? ` (updated ${irs.date})` : '';
  const rec = irs.record && irs.record.ein === ein ? irs.record : null;
  if (irs.ein && ein && irs.ein !== ein) {
    out.push({ key: 'ein-changed', level: 'note', title: 'The EIN changed since the last check', detail: 'It’s looked up on the IRS’s list again within a few hours.', check: true });
  } else if (irs.found === false && ein) {
    out.push({ key: 'irs-missing', level: 'urgent', title: 'The IRS’s list of tax-exempt organizations doesn’t have this EIN',
      detail: `${einText(ein)} isn’t on the IRS’s list for ${irs.state || 'SOARD’s state'}${listed}. Check the EIN here first; if it’s right, SOARD’s exemption needs looking at today.`,
      link: { label: 'Look it up on the IRS’s site', url: TEOS } });
  }
  if (rec) {
    if (!exempt(rec)) {
      out.push({ key: 'irs-status', level: 'urgent', title: 'The IRS’s list doesn’t show SOARD as a 501(c)(3) whose gifts are deductible',
        detail: `It shows ${statusWords(rec)}${listed}.`, link: { label: 'Look it up on the IRS’s site', url: TEOS } });
    }
    const legal = String(settings.legalName || '').trim();
    const irsName = titleCase(rec.name);
    if (!legal || !sameName(legal, rec.name)) {
      out.push({ key: 'legal-name', level: 'warn', title: legal ? 'The legal name isn’t the one the IRS has' : 'No legal name yet',
        detail: legal ? 'Forms and grants are checked against the IRS’s name.' : 'Forms and grants ask for it exactly as the IRS has it.',
        site: legal, other: irsName, otherLabel: 'The IRS has', fix: { label: legal ? 'Use the IRS’s' : 'Add it', set: [['settings', 'legalName', irsName]] } });
    }
    const mail = mailingOf(settings);
    const theirs = irsAddress(rec);
    if (isAddress(theirs) && !sameAddress(mail, theirs)) {
      const office = !hasMailing(settings);
      out.push({ key: 'mailing', level: 'warn', title: office ? 'The IRS has another address for SOARD' : 'The mailing address isn’t the one the IRS has',
        detail: office ? 'If SOARD’s mail goes there, add it as the mailing address. If SOARD moved, tell the IRS with Form 8822-B.' : 'Use the IRS’s, or if SOARD moved, tell the IRS with Form 8822-B.',
        site: addressLine(mail), siteLabel: office ? 'The office' : 'The mailing address', other: addressLine(theirs), otherLabel: 'The IRS has',
        fix: { label: office ? 'Add it as the mailing address' : 'Use the IRS’s', set: [['settings', 'mailingAddress', theirs]] }, link: { label: 'Form 8822-B', url: FORM_8822B } });
    }
  }
  // SOARD's W-9 (Board → Documents): only what two readings agreed on counts (_org-facts.js)
  const w = check.w9?.read;
  if (w && w.isW9) {
    const where = check.w9.title ? `“${check.w9.title}” on Board → Documents` : 'SOARD’s W-9 on Board → Documents';
    const newW9 = { label: 'Board → Documents', url: '#board/documents' };
    if (w.ein && ein && einDigits(w.ein) !== ein) out.push({ key: 'w9-ein', level: 'warn', title: 'SOARD’s W-9 has another EIN', detail: `${where} says ${einText(w.ein)}. Put a W-9 with ${einText(ein)} in its place.`, site: einText(ein), other: einText(w.ein), otherLabel: 'The W-9 has', link: newW9 });
    const names = [settings.legalName, rec?.name, settings.name].filter((x) => String(x || '').trim());
    if (w.name && names.length && !names.some((n) => sameName(n, w.name))) out.push({ key: 'w9-name', level: 'warn', title: 'SOARD’s W-9 is in another name', detail: `${where} has “${w.name}” on line 1. It should be SOARD’s legal name.`, link: newW9 });
    const mail = mailingOf(settings);
    if (w.street && isAddress(mail) && (streetKey(w.street) !== streetKey(mail.street) || (w.zip && zip5(w.zip) !== zip5(mail.zip)))) {
      out.push({ key: 'w9-address', level: 'warn', title: 'SOARD’s W-9 has another address', detail: `One of them is out of date: whoever SOARD gives its W-9 sends their tax forms to the address on it. If the W-9’s is right, put it in here${hasMailing(settings) ? '' : ' as the mailing address'}; if not, put a new W-9 on Board → Documents.`,
        site: addressLine(mail), siteLabel: hasMailing(settings) ? 'The mailing address' : 'The office', other: [w.street, w.cityStateZip].filter(Boolean).join(', '), otherLabel: 'The W-9 has', link: newW9 });
    }
  }
  const manual = String(check.manual?.mission || '').trim();
  const mission = String(media.mission || '').trim();
  if (manual && mission && missionKey(manual) !== missionKey(mission)) {
    out.push({ key: 'mission-manual', level: 'note', title: 'The Board Manual words the mission another way',
      detail: 'Use one of them for both: put the Board Manual’s here, or change the Board Manual on Board → Documents.',
      site: mission, other: manual, otherLabel: 'The Board Manual has', fix: { label: 'Use the Board Manual’s', set: [['media', 'mission', manual]] } });
  }
  const rank = { urgent: 0, warn: 1, note: 2 };
  return out.sort((a, b) => rank[a.level] - rank[b.level]);
}
