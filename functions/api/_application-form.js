/**
 * The makeover application, as data
 * ===========================================================================
 * One definition drives everything: the page at /apply/form/ renders it, the
 * browser runs its show/hide rules and checks, /api/apply validates against it
 * on every save and on submit, the PDF copy lists it, and the JobTread load
 * reads its answers by field id. Change a question here and all four follow.
 *
 * Wording is the Jotform "SOARD Application" (form 252326779451161), kept
 * word for word. Answers are stored as the option text, the way Jotform
 * stored them, so the PDF and JobTread read naturally.
 *
 * Field types:
 *   text, textarea, email, phone, date, select, radio, checkbox (max = most
 *   choices), name {first, last}, address {line1, line2, city, state, zip},
 *   ack (one box that must be ticked), signature (typed full name),
 *   photo, video (uploads; their values live in the draft's files, not answers),
 *   content (static html), image (static Cloudflare Images id)
 *
 * showIf: { field, in: [option, ...] } shows a field only for those answers.
 * stops: { option: stopKey } ends the application on that answer with the
 * matching screen from STOPS (Jotform's "we can't help this time" pages).
 */

export const SERVICE_MAP_IMAGE = 'd993cd7c-7863-4a1b-ea5e-50602623cb00';

export const TEXT_MAX = 300;
export const TEXTAREA_MAX = 6000;

const YES_NO = ['Yes', 'No'];

export const MAKEOVER_TYPES = ['Accessible Bathroom', 'Dream Bedroom', 'In-Home Therapy Room', 'Ramp'];
const MAKEOVER_DESCRIPTIONS = {
  'Accessible Bathroom': 'This scope of work typically entails a full demolition of the existing bathroom, followed by a complete rebuild with an accessible layout that includes a zero-entry shower, widened doorway (when structure allows), grab bars, an accessible vanity, and a side-transfer toilet.',
  'Dream Bedroom': 'Our expert designers create a beautifully designed bedroom for a child who needs a comfortable and upbeat place to hang out, recover and just be a kid.',
  'In-Home Therapy Room': "With guidance from the child's therapists, an existing finished room in the home will be converted into a therapy room where the child can thrive. Therapy equipment is limited to funding availability.",
  Ramp: 'SOARD designs and installs exterior ramps at the entrance of the child’s home, providing safe and accessible entry for wheelchair users and families.',
};
export const COUNTIES = ['Cherokee', 'Cobb', 'DeKalb', 'Forsyth', 'Fulton', 'Gwinnett'];
export const LANGUAGES = ['English', 'Spanish', 'French', 'Vietnamese', 'Chinese', 'Korean'];

export const STOPS = {
  rental: {
    title: 'Thank you so much for your interest in Sunshine on a Ranney Day.',
    body: '<p>Families must own their home to qualify for a makeover.</p>',
  },
  outside: {
    title: 'Thank you so much for your interest in Sunshine on a Ranney Day.',
    body: '<p>At this time, we are only able to provide makeovers within the area outlined in red below or its immediate surroundings. Please check back in the future to see if our service area has expanded.</p>',
    image: SERVICE_MAP_IMAGE,
  },
};

/**
 * The form for one application season. `year` is the makeover season
 * (Admin → Site Config → Makeover Application). Matches the Jotform "SOARD
 * Application" as updated for 2027 (copy 262924738674168), page for page.
 */
export function applicationForm({ year = '2027' } = {}) {
  return {
    title: `Sunshine on a Ranney Day ${year} Application`,
    year: String(year),
    pages: [
      {
        id: 'welcome',
        title: 'Before You Begin',
        fields: [
          {
            id: 'introText', type: 'content',
            html: `<p><strong>We are so glad you're considering applying for a makeover!</strong></p>
<p>This application helps us get to know your child, your family, and how a makeover could make a difference in your everyday lives.</p>
<p>As part of the application, we'll ask you to:</p>
<ul>
<li>Share information about your child, your family, and your child's needs.</li>
<li>Upload photos of the space you're hoping to have renovated.</li>
<li>Record or upload a short 90-second video introducing your child, sharing their story, and showing us the space.</li>
</ul>
<p>We recommend having your photos and video ready before starting, but there's no need to complete everything in one sitting. Your answers save as you go, and you can tap "Save and finish later" at the bottom of any page. You'll receive a link to return to your application whenever you're ready.</p>
<p>Most importantly, we want to get to know your child beyond their diagnosis. Tell us about their personality, what makes them happy, the challenges your family faces, and how a makeover could make everyday life a little easier.</p>
<p>Thank you for taking the time to share your family's story with us. We look forward to getting to know you!</p>`,
          },
          {
            id: 'scopeList', type: 'content', variant: 'scope',
            html: `<h3 class="af-scope-title">Makeover Guidelines: What We Do &amp; Don't Provide</h3>
<div class="af-scope">
<div class="af-scope-col"><h3>What we do</h3><ul>
<li><strong>Dream bedrooms.</strong> Our expert designers create a beautifully designed bedroom for a child who needs a comfortable and upbeat place to hang out, recover and just be a kid.</li>
<li><strong>Wheelchair-accessible bathrooms.</strong> This scope of work typically entails a full demolition of the existing bathroom, followed by a complete rebuild with an accessible layout that includes a zero-entry shower, widened doorway (when structure allows), grab bars, an accessible vanity, and a side-transfer toilet.</li>
<li><strong>In-home therapy rooms.</strong> With guidance from the child's therapists, an existing finished room in the home will be converted into a therapy room where the child can thrive. Therapy equipment is limited to funding availability.</li>
<li><strong>Exterior ramps.</strong> SOARD designs and installs exterior ramps at the entrance of the child's home, providing safe and accessible entry for wheelchair users and families.</li>
</ul></div>
<div class="af-scope-col"><h3>SOARD does not</h3><ul>
<li>Install bathtubs</li>
<li>Install or build pools and/or hot tubs</li>
<li>Add on to homes or convert unfinished spaces</li>
<li>Complete kitchen remodels</li>
<li>Install or fund lifts</li>
<li>Donate or raise money for bills, mortgages, vehicles, or any other purchases</li>
</ul></div>
</div>`,
          },
          {
            id: 'ackParameters', type: 'ack', required: true,
            label: 'I have read the above and understand that a SOARD makeover includes construction and renovation work to my home and that SOARD only works within the existing structure of the home in a finished, heated and cooled space, free of lead, asbestos, and/or mold, and properly maintained.',
            options: ["Yes, I have read and understand SOARD's makeover parameters."],
          },
          {
            id: 'ackSeason', type: 'ack', required: true,
            label: `I understand that this application is for the ${year} makeover season, with construction expected to begin no sooner than the spring of ${year}.`,
            options: ['Yes, I have read and understand the above statement.'],
          },
        ],
      },
      {
        id: 'service-area',
        title: 'Makeover Service Area Notice',
        fields: [
          {
            id: 'serviceAreaText', type: 'content',
            html: `<p>To ensure we can effectively serve our community, Sunshine on a Ranney Day's makeovers are limited to homes located <strong>within</strong> the red outlined service area shown below.</p>
<p>Only applications for children whose primary residence is inside the red boundary will be considered.</p>`,
          },
          { id: 'serviceMap', type: 'image', image: SERVICE_MAP_IMAGE, alt: 'Map of the makeover service area outlined in red: from Canton and Cumming in the north to Marietta, Sandy Springs and Norcross in the south', width: 938, height: 768 },
          {
            id: 'boundary', type: 'radio', required: true,
            label: "Is the child's home located inside the red boundary shown above?",
            options: ['Yes, it is within the boundary.', 'No, but it is close to the boundary.', 'No, it is not within the boundary nor is it close.'],
            stops: { 'No, it is not within the boundary nor is it close.': 'outside' },
          },
          {
            id: 'boundaryWhere', type: 'text',
            label: "If no, where is the child's home located?",
            showIf: { field: 'boundary', in: ['No, but it is close to the boundary.'] },
          },
        ],
      },
      {
        id: 'basic',
        title: 'Basic Information',
        fields: [
          { id: 'childName', type: 'name', required: true, label: "Child's Name" },
          { id: 'birthdate', type: 'date', required: true, label: "Child's Birthdate" },
          { id: 'gender', type: 'radio', required: true, label: "Child's Gender", options: ['Male', 'Female'] },
          { id: 'diagnosis', type: 'text', required: true, label: "What is the child's illness or diagnosis?" },
          { id: 'address', type: 'address', required: true, label: "Child's Permanent Address (Address where the makeover will be completed)" },
          { id: 'county', type: 'select', required: true, label: "What county is the child's home located in?", options: COUNTIES },
          { id: 'resides50', type: 'radio', required: true, options: YES_NO, label: 'Does the child reside at the above address at least 50% of their time?' },
          { id: 'previouslyApplied', type: 'radio', required: true, options: YES_NO, label: 'Has the child previously been nominated or applied for a Sunshine on a Ranney Day makeover?' },
          { id: 'referredBy', type: 'text', label: 'Who referred you to Sunshine on a Ranney Day?' },
        ],
      },
      {
        id: 'parents',
        title: "Parents' Information",
        fields: [
          { id: 'parentName', type: 'name', required: true, label: "Parent/Legal Guardian's Full Name (main point of contact for all communication)" },
          { id: 'parentEmail', type: 'email', required: true, label: "Parent/Legal Guardian's Email Address" },
          { id: 'parentPhone', type: 'phone', required: true, label: "Parent/Legal Guardian's Phone Number" },
          { id: 'parentRelation', type: 'text', required: true, label: 'Relationship to Child' },
          { id: 'parentAddress', type: 'address', label: "Parent/Legal Guardian's Address (If different from child)" },
          { id: 'parent2Name', type: 'name', label: 'Additional Parent/Legal Guardian' },
          { id: 'parent2Email', type: 'email', label: "Additional Parent/Legal Guardian's Email" },
          { id: 'parent2Phone', type: 'phone', label: 'Additional Parent/Legal Guardian Phone' },
          { id: 'parent2Relation', type: 'text', label: 'Relationship to Child of Additional Contact' },
          { id: 'residesWith', type: 'text', label: 'With whom does the child primarily reside?' },
          {
            id: 'ownership', type: 'radio', required: true,
            label: 'Is the home where the child lives owned by at least one of the occupants (such as parents, family members, or guardians), or is it a rental property?',
            options: ['Yes, at least one person living in the home is the owner.', 'No, the property is rented.'],
            stops: { 'No, the property is rented.': 'rental' },
          },
        ],
      },
      {
        id: 'diagnosis',
        title: 'Diagnosis',
        fields: [
          {
            id: 'diagnosisImpact', type: 'textarea', required: true,
            label: 'Tell us about your child’s diagnosis or illness and how it impacts your daily caregiving routine. This is your chance to help us understand why a SOARD makeover would make a difference for your family.',
          },
          { id: 'verbal', type: 'radio', required: true, label: 'Is the child verbal?', options: YES_NO },
          { id: 'ambulatory', type: 'radio', required: true, label: 'Is the child independently ambulatory?', options: YES_NO },
          { id: 'sensory', type: 'radio', required: true, label: 'Does the child have sensory issues?', options: YES_NO },
          { id: 'sensoryDetail', type: 'text', label: 'If yes, please explain the sensory issues', showIf: { field: 'sensory', in: ['Yes'] } },
          { id: 'destructive', type: 'radio', required: true, label: 'Does the child have destructive tendencies, such as breaking items in the home, kicking holes in walls, etc?', options: YES_NO },
          { id: 'destructiveDetail', type: 'text', label: 'If yes, please explain the destructive tendencies.', showIf: { field: 'destructive', in: ['Yes'] } },
          { id: 'language', type: 'select', required: true, label: "What is the primary language spoken in the child's home?", options: LANGUAGES },
          { id: 'equipment', type: 'textarea', label: 'Please provide a description of the equipment that the child regularly uses to help them navigate the home.' },
        ],
      },
      {
        id: 'child',
        title: "Child's Info",
        fields: [
          { id: 'interests', type: 'textarea', required: true, label: "Please tell us all about the child's interests. What are the child's favorite characters, shows, or interests?" },
          { id: 'photoChild', type: 'photo', required: true, label: 'Please upload a picture of the child' },
          { id: 'photoFamily', type: 'photo', required: true, label: 'Please upload a picture of the child with their family' },
          { id: 'otherChildren', type: 'textarea', required: true, label: 'Are there any other children in your home who have special needs or medical conditions? If so, please tell us a little about them.' },
        ],
      },
      {
        id: 'home',
        title: 'Home and Space',
        fields: [
          {
            id: 'makeoverTypes', type: 'checkbox', required: true, max: 2,
            label: 'Please choose up to two (2) options below where the child would benefit a makeover.',
            options: MAKEOVER_TYPES, descriptions: MAKEOVER_DESCRIPTIONS,
          },
          { id: 'makeoverWhy', type: 'textarea', required: true, label: 'Which of the makeover options you chose would help your child the most, and why?' },
          {
            id: 'positiveImpact', type: 'textarea', required: true,
            label: 'Please explain how this makeover will have a positive impact on your child’s life and why your family would benefit from being selected. This is your final opportunity to share anything else you’d like us to know.',
          },
          { id: 'photoSpace1', type: 'photo', required: true, label: 'Please upload a picture of the space' },
          { id: 'photoSpace2', type: 'photo', required: true, label: 'Please upload a second picture of the space' },
          { id: 'residingDuration', type: 'text', required: true, label: 'How long do you plan on residing at the makeover address?' },
          {
            id: 'permits', type: 'radio', required: true, options: ['Yes', 'No', "I'm not sure"],
            label: 'To your knowledge, has any construction or renovation work been completed on your home without the required permits?',
          },
          { id: 'permitsDetail', type: 'text', label: 'If yes, please explain.', showIf: { field: 'permits', in: ['Yes'] } },
          {
            id: 'conviction', type: 'radio', required: true, options: YES_NO,
            label: 'Has anyone residing at the address provided for the makeover been convicted of a felony or misdemeanor, excluding minor traffic violations?',
          },
          { id: 'convictionDetail', type: 'text', label: 'If yes, please explain.', showIf: { field: 'conviction', in: ['Yes'] } },
        ],
      },
      {
        id: 'video',
        title: 'Video',
        fields: [
          {
            id: 'videoText', type: 'content',
            html: `<p>The last step of the initial part of the application process is to film a short video (about 90 seconds) introducing your child and showing us the space that needs a makeover.</p>
<p>The video doesn’t need to be fancy, a simple phone recording is perfect! Just be sure to include both your child and the room or area in need of renovation.</p>
<p>Please verify your video has processed and uploaded before submitting your application.</p>`,
          },
          { id: 'video', type: 'video', required: true, label: 'Your video' },
        ],
      },
      {
        id: 'finish',
        title: 'Certification',
        fields: [
          {
            id: 'signature', type: 'signature', required: true,
            label: 'By typing my name below, I certify that the information provided in this application is true, accurate, and complete.',
          },
        ],
      },
    ],
  };
}

/** Every field, in form order, with its page id */
export function allFields(form) {
  return form.pages.flatMap(p => p.fields.map(f => ({ ...f, page: p.id })));
}

const INPUT_TYPES = new Set(['text', 'textarea', 'email', 'phone', 'date', 'select', 'radio', 'checkbox', 'name', 'address', 'ack', 'signature']);
const UPLOAD_TYPES = new Set(['photo', 'video']);

export function isInput(field) { return INPUT_TYPES.has(field.type); }
export function isUpload(field) { return UPLOAD_TYPES.has(field.type); }

/** Shown for these answers? Fields hidden behind a hidden field are hidden too. */
export function isVisible(field, answers, byId) {
  if (!field.showIf) return true;
  const parent = byId?.[field.showIf.field];
  if (parent && !isVisible(parent, answers, byId)) return false;
  const v = answers?.[field.showIf.field];
  const vals = Array.isArray(v) ? v : [v];
  return vals.some(x => field.showIf.in.includes(x));
}

function indexById(form) {
  return Object.fromEntries(allFields(form).map(f => [f.id, f]));
}

/** The stop screen these answers lead to, or null. */
export function stopFor(form, answers) {
  const byId = indexById(form);
  for (const f of allFields(form)) {
    if (!f.stops || !isVisible(f, answers, byId)) continue;
    const key = f.stops[answers?.[f.id]];
    if (key) return { key, field: f.id, page: f.page, ...STOPS[key] };
  }
  return null;
}

const isBlank = (v) => v == null || (typeof v === 'string' && !v.trim()) || (Array.isArray(v) && !v.length)
  || (typeof v === 'object' && !Array.isArray(v) && Object.values(v).every(x => !String(x ?? '').trim()));

export function isEmailAddress(s) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(s || '').trim());
}

/** US numbers to E.164 (+1XXXXXXXXXX); international numbers kept when they start with + */
export function toE164(s) {
  const digits = String(s || '').replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return /^\+\d{8,15}$/.test(digits) ? digits : null;
  if (/^1\d{10}$/.test(digits)) return `+${digits}`;
  if (/^\d{10}$/.test(digits)) return `+1${digits}`;
  return null;
}

/**
 * The problem with one answer, or null. `value` for uploads is the draft's
 * file record ({ key } for photos, { uid, uploaded } for the video).
 */
export function fieldError(field, value) {
  const blank = isBlank(value);
  if (field.type === 'video') {
    if (field.required && !value?.uid) return 'Please upload your video.';
    if (value?.uid && !value.uploaded) return 'Your video is still uploading. Please wait for it to finish.';
    return null;
  }
  if (field.type === 'photo') return field.required && !value?.key ? 'Please add a photo.' : null;
  if (blank) {
    if (!field.required) return null;
    if (field.type === 'ack') return 'Please check the box to continue.';
    if (['radio', 'select', 'checkbox'].includes(field.type)) return 'Please choose an answer.';
    if (field.type === 'signature') return 'Please type your full name.';
    return 'Please answer this question.';
  }
  switch (field.type) {
    case 'email': return isEmailAddress(value) ? null : 'Please enter a valid email address, like name@example.com.';
    case 'phone': return toE164(value) ? null : 'Please enter a 10-digit phone number.';
    case 'date': {
      const m = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
      const d = m ? new Date(`${value}T12:00:00Z`) : null;
      if (!d || Number.isNaN(d.getTime()) || d.getUTCDate() !== Number(m[3])) return 'Please enter a valid date.';
      if (d.getTime() > Date.now()) return 'Please enter a date in the past.';
      return null;
    }
    case 'name': {
      if (field.required && (!String(value.first || '').trim() || !String(value.last || '').trim())) return 'Please enter a first and last name.';
      return null;
    }
    case 'address': {
      const missing = ['line1', 'city', 'state', 'zip'].filter(k => !String(value[k] || '').trim());
      if (missing.length && (field.required || missing.length < 4)) return 'Please enter the street address, city, state and ZIP code.';
      if (value.zip && !/^\d{5}(-\d{4})?$/.test(String(value.zip).trim())) return 'Please enter a 5-digit ZIP code.';
      return null;
    }
    case 'radio': case 'select': case 'ack':
      return field.options.includes(value) ? null : 'Please choose one of the answers.';
    case 'checkbox': {
      if (!Array.isArray(value) || value.some(v => !field.options.includes(v))) return 'Please choose from the answers listed.';
      if (field.max && value.length > field.max) return `Please choose up to ${field.max}.`;
      return null;
    }
    default: return null;
  }
}

/** Keep only known answers, trimmed and capped, in the shape each type expects. */
export function cleanAnswers(form, answers) {
  const out = {};
  const cap = (s, n) => String(s ?? '').replace(/\u0000/g, '').trim().slice(0, n);
  for (const f of allFields(form)) {
    if (!isInput(f)) continue;
    const v = answers?.[f.id];
    if (v == null) continue;
    switch (f.type) {
      case 'name':
        if (typeof v === 'object') out[f.id] = { first: cap(v.first, 80), last: cap(v.last, 80) };
        break;
      case 'address':
        if (typeof v === 'object') out[f.id] = { line1: cap(v.line1, 160), line2: cap(v.line2, 80), city: cap(v.city, 80), state: cap(v.state, 40), zip: cap(v.zip, 10) };
        break;
      case 'checkbox':
        if (Array.isArray(v)) out[f.id] = [...new Set(v.map(x => cap(x, TEXT_MAX)))].filter(x => f.options.includes(x));
        break;
      case 'textarea':
        out[f.id] = cap(v, TEXTAREA_MAX);
        break;
      default:
        out[f.id] = cap(v, TEXT_MAX);
    }
  }
  return out;
}

/**
 * Problems on the given pages ({ fieldId: message }), counting only fields
 * these answers show. `pages` defaults to the whole form.
 */
export function formErrors(form, answers, files = {}, pages = null) {
  const byId = indexById(form);
  const errors = {};
  for (const f of allFields(form)) {
    if (pages && !pages.includes(f.page)) continue;
    if (!(isInput(f) || isUpload(f)) || !isVisible(f, answers, byId)) continue;
    const err = fieldError(f, isUpload(f) ? files?.[f.id] : answers?.[f.id]);
    if (err) errors[f.id] = err;
  }
  return errors;
}

export function nameText(v) {
  return [v?.first, v?.last].map(s => String(s || '').trim()).filter(Boolean).join(' ');
}

export function addressText(v) {
  if (!v) return '';
  const street = [v.line1, v.line2].map(s => String(s || '').trim()).filter(Boolean).join(', ');
  const cityState = [v.city, v.state].map(s => String(s || '').trim()).filter(Boolean).join(', ');
  return [street, [cityState, String(v.zip || '').trim()].filter(Boolean).join(' ')].filter(Boolean).join(', ');
}

/** "2019-03-08" → "March 8, 2019" */
export function dateText(v) {
  const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return String(v || '');
  return new Date(`${v}T12:00:00Z`).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

/** One answer as plain text, for the PDF, emails and JobTread */
export function answerText(field, value) {
  if (value == null) return '';
  switch (field.type) {
    case 'name': case 'signature': return field.type === 'name' ? nameText(value) : String(value);
    case 'address': return addressText(value);
    case 'date': return dateText(value);
    case 'checkbox': return (value || []).join(', ');
    case 'phone': {
      const e = toE164(value);
      const m = e && e.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
      return m ? `(${m[1]}) ${m[2]}-${m[3]}` : String(value);
    }
    default: return String(value);
  }
}

/**
 * The answered questions, page by page, for the PDF and the review screen:
 * [{ title, items: [{ id, type, label, text }] }]. Uploads appear with
 * `upload: true` and the file record.
 */
export function answerSections(form, answers, files = {}) {
  const byId = indexById(form);
  const sections = [];
  for (const p of form.pages) {
    const items = [];
    for (const f of p.fields) {
      if (!isVisible(f, answers, byId)) continue;
      if (isUpload(f)) {
        if (files?.[f.id]) items.push({ id: f.id, type: f.type, label: f.label, upload: true, file: files[f.id] });
        continue;
      }
      if (!isInput(f)) continue;
      const text = answerText(f, answers?.[f.id]);
      if (text) items.push({ id: f.id, type: f.type, label: f.label, text });
    }
    if (items.length) sections.push({ id: p.id, title: p.title, items });
  }
  return sections;
}
