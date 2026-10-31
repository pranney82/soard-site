/**
 * The Advisory Board application: its questions in order, and the checks
 * both the page (/advisory-board/apply/) and the server run on the answers.
 * No imports, so the page's script can share it.
 *
 * It asks what the Jotform application asked (form 261805783731058, used
 * July to October 2026), grouped into the page's five steps. JOTFORM_FIELDS
 * maps that form's questions to these ids, so the applications sent there
 * read the same in the admin (./_advisory-applications.js imports them).
 * Applications are always open: nothing here has a deadline.
 */

export const OVERVIEW_PDF = 'https://files.sunshineonaranneyday.com/advisory/SOARD_Advisory%20Board%20Overview.docx.pdf';

const YES_NO = ['Yes', 'No'];
const YES_MAYBE_NO = ['Yes', 'Maybe', 'No'];

export const ADVISORY_STEPS = [
  {
    id: 'you',
    short: 'About you',
    title: 'About you',
    intro: 'How to reach you, and what you do.',
    fields: [
      { id: 'fullName', label: 'Full name', type: 'text', required: true, autocomplete: 'name', max: 120 },
      { id: 'preferredName', label: 'Preferred name', hint: 'What you like to be called, if it’s different.', type: 'text', autocomplete: 'nickname', max: 60 },
      { id: 'email', label: 'Email address', type: 'email', required: true, autocomplete: 'email', max: 200 },
      { id: 'phone', label: 'Phone number', type: 'tel', required: true, autocomplete: 'tel', max: 40 },
      // One line that finds the address as it's typed (the application's suggestions); any words typed still count
      { id: 'address', label: 'Home address', type: 'address', autocomplete: 'street-address', max: 300 },
      { id: 'company', label: 'Employer or company', type: 'text', autocomplete: 'organization', max: 160 },
      { id: 'jobTitle', label: 'Job title', type: 'text', autocomplete: 'organization-title', max: 160 },
      { id: 'link', label: 'LinkedIn profile or website', hint: 'If you have one.', type: 'url', autocomplete: 'url', max: 300 },
    ],
  },
  {
    id: 'interest',
    short: 'Interest',
    title: 'Your interest',
    intro: 'What draws you to SOARD and to the Advisory Board.',
    fields: [
      { id: 'heardFrom', label: 'How did you hear about the Advisory Board?', type: 'text', required: true, max: 300 },
      { id: 'why', label: 'Why are you interested in serving on the Advisory Board?', type: 'textarea', required: true, max: 3000 },
      { id: 'connection', label: 'What connects you to SOARD’s mission?', type: 'textarea', required: true, max: 3000 },
      { id: 'involved', brief: 'Involved before', label: 'Have you supported, volunteered with, attended an event for, or been involved with SOARD before?', type: 'choice', options: YES_NO, required: true },
      { id: 'involvedHow', label: 'Tell us about it', type: 'textarea', showIf: { involved: ['Yes'] }, max: 2000 },
    ],
  },
  {
    id: 'bring',
    short: 'Strengths',
    title: 'What you’d bring',
    intro: 'The board works together to fund one SOARD makeover every year.',
    fields: [
      { id: 'strengths', label: 'What strengths, experience, relationships, or skills would you hope to bring to the Advisory Board?', type: 'textarea', required: true, max: 3000 },
      { id: 'fundraising', label: 'How could you help the board reach its shared fundraising goal of $25,000?', type: 'textarea', required: true, max: 3000 },
      { id: 'introductions', brief: 'Introductions', label: 'Are you comfortable making introductions to potential donors, sponsors, partners, vendors, or volunteers?', type: 'choice', options: YES_MAYBE_NO, required: true },
      { id: 'networks', brief: 'Networks', label: 'Do you have relationships with people, businesses, foundations, community groups, or professional networks that may want to learn about SOARD?', type: 'choice', options: YES_MAYBE_NO, required: true },
      { id: 'networksMore', label: 'Share anything you feel comfortable sharing', type: 'textarea', showIf: { networks: ['Yes', 'Maybe'] }, max: 2000 },
      { id: 'conflict', brief: 'Conflict of interest', label: 'Do you have any relationship that could create a real or perceived conflict of interest with your service on the Advisory Board?', hint: 'Personal, professional, financial, or organizational: for example with vendors, contractors, donors, sponsors, partner organizations, grantmakers, board members, staff, or families SOARD serves.', type: 'choice', options: YES_NO, required: true },
      { id: 'conflictMore', label: 'Please explain briefly', type: 'textarea', required: true, showIf: { conflict: ['Yes'] }, max: 2000 },
    ],
  },
  {
    id: 'commitment',
    short: 'Commitment',
    title: 'Commitment',
    intro: 'A one-year renewable term, with at least four meetings a year.',
    fields: [
      { id: 'hostEvent', brief: 'Hosting an event', label: 'Would you be interested in hosting or helping organize a small fundraiser, awareness event, or peer-to-peer campaign?', type: 'choice', options: YES_MAYBE_NO, required: true },
      { id: 'meetings', brief: 'Four meetings a year', label: 'Can you attend at least four meetings a year?', type: 'choice', options: YES_NO, required: true },
      { id: 'ambassador', brief: 'Ambassador', label: 'Will you serve as a positive ambassador for SOARD?', hint: 'Sharing our mission, supporting events and campaigns when you can, and helping grow awareness in the community.', type: 'choice', options: YES_NO, required: true },
      { id: 'meetingTimes', label: 'What days or times usually work best for meetings?', type: 'text', max: 300 },
      { id: 'hopeToGain', label: 'What do you hope to gain from serving on the Advisory Board?', type: 'textarea', max: 3000 },
      { id: 'anythingElse', label: 'Is there anything else you’d like us to know about you?', type: 'textarea', max: 3000 },
    ],
  },
  {
    id: 'reference',
    short: 'Reference',
    title: 'Reference and signature',
    intro: 'Someone who knows your work or your heart for service.',
    fields: [
      { id: 'refName', group: 'reference', label: 'Reference’s name', type: 'text', required: true, max: 120 },
      { id: 'refRelationship', group: 'reference', label: 'How you know them', type: 'text', required: true, max: 160 },
      { id: 'refEmail', group: 'reference', label: 'Reference’s email', type: 'email', required: true, max: 200 },
      { id: 'refPhone', group: 'reference', label: 'Reference’s phone', type: 'tel', max: 40 },
      { id: 'acknowledge', label: 'I have read and understand the Advisory Board expectations in the overview.', type: 'check', required: true },
      { id: 'signature', label: 'Type your full name to sign', type: 'text', required: true, autocomplete: 'name', max: 120 },
    ],
  },
];

export const ADVISORY_FIELDS = ADVISORY_STEPS.flatMap((s) => s.fields.map((f) => ({ ...f, step: s.id })));
const BY_ID = Object.fromEntries(ADVISORY_FIELDS.map((f) => [f.id, f]));

/** Is this field asked, given the answers so far? (follow-ups show after a Yes) */
export function isShown(field, answers) {
  if (!field.showIf) return true;
  return Object.entries(field.showIf).every(([id, values]) => values.includes(answers?.[id]));
}

export const EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[a-z]{2,}$/i;

/** A link people typed without https:// still works */
export function normalizeLink(s) {
  const t = String(s || '').trim();
  if (!t) return '';
  return /^https?:\/\//i.test(t) ? t : `https://${t.replace(/^\/+/, '')}`;
}

/** One answer, cleaned to what the field takes ('' when it's empty) */
function clean(field, raw) {
  if (field.type === 'check') return raw === true || raw === 'true' || raw === 'on' || raw === 'yes';
  let v = String(raw ?? '').replace(/\r\n?/g, '\n');
  v = field.type === 'textarea' ? v.replace(/[ \t]+\n/g, '\n').trim() : v.replace(/\s+/g, ' ').trim();
  if (field.type === 'url') v = normalizeLink(v);
  if (field.type === 'email') v = v.toLowerCase();
  return v.slice(0, field.max || 500);
}

/** What's wrong with one answer, in words for the applicant, or null */
export function fieldProblem(field, value) {
  const empty = field.type === 'check' ? value !== true : !value;
  if (empty) {
    if (!field.required) return null;
    if (field.type === 'check') return 'Please confirm you’ve read the overview.';
    if (field.type === 'choice') return 'Please choose one.';
    return 'Please fill this in.';
  }
  // (an ending no address has, "gmail.con", is a typo: the page's "Did you mean" says the fix)
  if (field.type === 'email' && (!EMAIL_RE.test(value) || /\.(?:con|cmo|ocm|vom|xom|comm|coom|cpm|cim|nte|ent|nett|ogr|rog|orgg)$/i.test(value))) return 'That doesn’t look like an email address.';
  if (field.type === 'tel') {
    // Ten digits (a 1 before them, or a + number from abroad, is fine; so is a work line's extension), as the family application asks
    const d = String(value).replace(/\s*(?:x|ext\.?|extension)\s*\d{1,6}\s*$/i, '').replace(/[^\d+]/g, '');
    if (!/^(?:\+\d{8,15}|1?\d{10})$/.test(d)) return 'Please enter a 10-digit phone number.';
  }
  if (field.type === 'url' && !/^https?:\/\/[^\s.]+\.[^\s]+$/i.test(value)) return 'That doesn’t look like a web address.';
  if (field.type === 'choice' && !field.options.includes(value)) return 'Please choose one.';
  return null;
}

/**
 * Clean every answer and check it. Unknown fields and follow-ups that don't
 * apply are left out. Returns { answers, problems } where problems maps a
 * field id to its message; `step` limits the check to one step's fields.
 */
export function checkAnswers(raw, { step = null } = {}) {
  const answers = {};
  for (const f of ADVISORY_FIELDS) answers[f.id] = clean(f, raw?.[f.id]);
  const problems = {};
  for (const f of ADVISORY_FIELDS) {
    if (!isShown(f, answers)) { delete answers[f.id]; continue; }
    if (step && f.step !== step) continue;
    const p = fieldProblem(f, answers[f.id]);
    if (p) problems[f.id] = p;
  }
  for (const [k, v] of Object.entries(answers)) if (v === '' || v === false) delete answers[k];
  return { answers, problems };
}

/** An answer as words for an email or the admin */
export function answerText(id, value) {
  const f = BY_ID[id];
  if (value == null || value === '') return '';
  if (f?.type === 'check') return value ? 'Yes' : 'No';
  return String(value);
}

/** The questions and answers, step by step, for an email or the admin (empty answers left out) */
export function answerSections(answers) {
  return ADVISORY_STEPS.map((s) => ({
    id: s.id,
    title: s.title,
    items: s.fields.filter((f) => answers?.[f.id] != null && answers[f.id] !== '' && f.id !== 'acknowledge').map((f) => ({ id: f.id, label: f.label, value: answerText(f.id, answers[f.id]) })),
  })).filter((s) => s.items.length);
}

/**
 * The Jotform application's questions → these ids (by the start of each
 * question, so small wording changes still match). Order matters: the first
 * pattern that fits wins.
 */
export const JOTFORM_FIELDS = [
  [/^full name/i, 'fullName'],
  [/^preferred name/i, 'preferredName'],
  [/^email address/i, 'email'],
  [/^phone number/i, 'phone'],
  [/^home address/i, 'address'],
  [/^employer/i, 'company'],
  [/^job title/i, 'jobTitle'],
  [/^linkedin/i, 'link'],
  [/^how did you hear/i, 'heardFrom'],
  [/^why are you interested/i, 'why'],
  [/^what connects you/i, 'connection'],
  [/^have you previously supported/i, 'involved'],
  [/^if yes, please describe/i, 'involvedHow'],
  [/^what strengths/i, 'strengths'],
  [/^how do you feel you could contribute/i, 'fundraising'],
  [/^are you comfortable making introductions/i, 'introductions'],
  [/^do you have relationships/i, 'networks'],
  [/^if yes or maybe/i, 'networksMore'],
  [/^would you be interested in hosting/i, 'hostEvent'],
  [/^are you able to commit/i, 'meetings'],
  [/^are you willing to serve/i, 'ambassador'],
  [/^what days or times/i, 'meetingTimes'],
  [/^what do you hope to gain/i, 'hopeToGain'],
  [/^is there anything else/i, 'anythingElse'],
  [/^reference name/i, 'refName'],
  [/^relationship$/i, 'refRelationship'],
  [/^reference email/i, 'refEmail'],
  [/^reference phone/i, 'refPhone'],
  [/^i have read and understand/i, 'acknowledge'],
  [/^applicant signature/i, 'signature'],
  [/^date$/i, 'signedOn'],
  [/^do you have any personal, professional/i, 'conflict'],
  [/^if yes, please briefly explain/i, 'conflictMore'],
];
