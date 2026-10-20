/**
 * The makeover application, as data
 * ===========================================================================
 * One definition drives everything: the page at /apply/form/ renders it, the
 * browser runs its show/hide rules and checks, /api/apply validates against it
 * on every save and on submit, the PDF copy lists it, and the JobTread load
 * reads its answers by field id.
 *
 * Staff edit it in Admin → Applications → Form. Each "Put live" is a new
 * version (./_application-forms.js); every application records the version it
 * was answered on, so its PDF and admin view always read the questions the
 * family saw. DEFAULT_DEFINITION below is version 0: the Jotform "SOARD
 * Application" as updated for 2027 (copy 262924738674168), word for word.
 *
 * Stored definition: { schema, title, pages: [{ id, title, fields }], stops,
 * messages, staffEmails }. Any text may say {year}; resolveForm() fills in the
 * season from Admin → Site Config → Makeover Application.
 *
 * Field types:
 *   text, textarea, email, phone, date, select, radio, checkbox (max = most
 *   choices), name {first, last}, address {line1, line2, city, state, zip},
 *   ack (one box that must be ticked), signature (typed full name),
 *   photo, video (uploads; their values live in the draft's files, not answers),
 *   content (static html), image (static Cloudflare Images id),
 *   guidelines (the "what we do / don't" lists)
 *
 * Choices are { value, label?, description? } (or a plain string, value =
 * label). Answers are stored as the value, which never changes once made, so
 * staff can reword a choice without breaking JobTread or older applications.
 *
 * showIf: { field, in: [value, ...] } shows a field only for those answers.
 * stops: { value: stopKey } ends the application on that answer with the
 * matching screen from `stops` (Jotform's "we can't help this time" pages).
 *
 * LOCKED_FIELDS feed JobTread and the family messages: they can be reworded
 * and moved, never deleted or changed into something JobTread can't read.
 */

export const SERVICE_MAP_IMAGE = 'd993cd7c-7863-4a1b-ea5e-50602623cb00';

export const TEXT_MAX = 300;
export const TEXTAREA_MAX = 6000;
export const HTML_MAX = 20000;

export const YES_NO = ['Yes', 'No'];
export const MAKEOVER_TYPES = ['Accessible Bathroom', 'Dream Bedroom', 'In-Home Therapy Room', 'Ramp'];
export const COUNTIES = ['Cherokee', 'Cobb', 'DeKalb', 'Forsyth', 'Fulton', 'Gwinnett'];
/** The Primary Language choices JobTread has (a choice must be one of these to reach JobTread) */
export const LANGUAGES = ['English', 'Spanish', 'French', 'Vietnamese', 'Chinese', 'Korean'];

/** What each type is called in the editor, and which ones families answer */
export const FIELD_TYPES = {
  text: 'Short answer',
  textarea: 'Long answer',
  email: 'Email',
  phone: 'Phone',
  date: 'Date',
  select: 'Dropdown',
  radio: 'One choice',
  checkbox: 'Several choices',
  name: 'Full name',
  address: 'Address',
  ack: 'Checkbox to agree',
  signature: 'Typed signature',
  photo: 'Photo upload',
  video: 'Video upload',
  content: 'Text block',
  image: 'Image',
  guidelines: 'Guidelines (do / don’t lists)',
};
export const CHOICE_TYPES = ['select', 'radio', 'checkbox', 'ack'];

/**
 * Questions the site reads by id. `role` is shown in the editor; `types` are
 * what it may be; `values` limits the choices (`allValues`: every one must stay).
 */
export const LOCKED_FIELDS = {
  childName: { role: 'Names the JobTread account', types: ['name'], required: true },
  birthdate: { role: 'JobTread: Birthday', types: ['date'] },
  gender: { role: 'JobTread: Gender', types: ['radio', 'select'], values: ['Male', 'Female'], allValues: true },
  diagnosis: { role: 'JobTread: Diagnosis (and the medical note)', types: ['text', 'textarea'] },
  address: { role: 'JobTread: the home', types: ['address'] },
  county: { role: 'JobTread: County', types: ['select', 'radio', 'text'] },
  language: { role: 'JobTread: Primary Language', types: ['select', 'radio'], values: LANGUAGES },
  referredBy: { role: 'JobTread: Referred By', types: ['text', 'textarea', 'select', 'radio'] },
  verbal: { role: 'JobTread: Verbal', types: ['radio', 'select'], values: YES_NO, allValues: true },
  ambulatory: { role: 'JobTread: Mobile', types: ['radio', 'select'], values: YES_NO, allValues: true },
  makeoverTypes: { role: 'JobTread: Makeover Type', types: ['checkbox'], values: MAKEOVER_TYPES },
  parentName: { role: 'JobTread: main contact', types: ['name'], required: true },
  parentEmail: { role: 'Main contact email; family messages go here', types: ['email'], required: true },
  parentPhone: { role: 'JobTread: main contact phone', types: ['phone'] },
  parentRelation: { role: 'JobTread: main contact title', types: ['text', 'select', 'radio'] },
  parent2Name: { role: 'JobTread: second contact', types: ['name'] },
  parent2Email: { role: 'JobTread: second contact email', types: ['email'] },
  parent2Phone: { role: 'JobTread: second contact phone', types: ['phone'] },
  parent2Relation: { role: 'JobTread: second contact title', types: ['text', 'select', 'radio'] },
  photoChild: { role: 'Attached in JobTread', types: ['photo'] },
  photoFamily: { role: 'Attached in JobTread', types: ['photo'] },
  photoSpace1: { role: 'Attached in JobTread', types: ['photo'] },
  photoSpace2: { role: 'Attached in JobTread', types: ['photo'] },
  video: { role: 'Attached in JobTread', types: ['video'] },
};

/** The family messages (JobTread comments). {parent} {child}; {copyNote} marks where the "copy attached" line goes */
export const DEFAULT_MESSAGES = {
  welcome: `{parent}

The application for *{child}* is under review.{copyNote}

Our team carefully evaluates each submission to determine how we can best serve the families who apply. If your application is selected to move forward, we will contact you to schedule an on-site visit as the next step to complete your application for review.

If we are unable to proceed with a makeover at this time, we will also notify you of our decision.

Please note that due to the high volume of applications we receive, this process may take some time. We appreciate your patience as we work through each application with the care and consideration it deserves.

Thank you again for allowing us to be part of your story. We will keep you updated as your application progresses, but if you have any questions in the meantime, please don’t hesitate to reach out.`,
  copyNote: 'A copy of your application is attached to this message for your records.',
  inReview: `{parent}

Congratulations, the application for *{child}* has moved to the next stage which is the on-site visit. After completing the on-site visit, your application will be complete and ready for our team to review to be able to make a final decision.

At the on-site visit, our team will get a chance to meet your child, better understand their needs, as well as review the space in person.

After completing the on-site and an internal review, you will receive a final decision.`,
  approved: `{parent}

We are excited to tell you that the application for *{child}* has been approved!

Your child's makeover is now on our official makeover waitlist. Our team will be in touch with next steps.`,
  denied: `{parent}

After careful consideration of the application for *{child}* we are unable to move forward with your family’s request.

This decision was made following a comprehensive evaluation process, taking into account factors such as the feasibility of the project, alignment with our current resources, and the specific needs of your space.

While we understand this may not be the decision you were hoping for, we wish your family the best and thank you for sharing your story with us.`,
};
export const MESSAGE_KEYS = ['welcome', 'copyNote', 'inReview', 'approved', 'denied'];
export const MESSAGE_MAX = 3600; // JobTread comments hold 4096; room for names and the copy line

export const DEFAULT_STAFF_EMAILS = ['selection@soardcharity.com'];

/** Version 0: the Jotform form as it stood for the 2027 season */
export const DEFAULT_DEFINITION = {
  schema: 2,
  title: 'Sunshine on a Ranney Day {year} Application',
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
          id: 'scopeList', type: 'guidelines',
          title: "Makeover Guidelines: What We Do & Don't Provide",
          doTitle: 'What we do',
          doItems: [
            { title: 'Dream bedrooms', text: 'Our expert designers create a beautifully designed bedroom for a child who needs a comfortable and upbeat place to hang out, recover and just be a kid.' },
            { title: 'Wheelchair-accessible bathrooms', text: 'This scope of work typically entails a full demolition of the existing bathroom, followed by a complete rebuild with an accessible layout that includes a zero-entry shower, widened doorway (when structure allows), grab bars, an accessible vanity, and a side-transfer toilet.' },
            { title: 'In-home therapy rooms', text: "With guidance from the child's therapists, an existing finished room in the home will be converted into a therapy room where the child can thrive. Therapy equipment is limited to funding availability." },
            { title: 'Exterior ramps', text: "SOARD designs and installs exterior ramps at the entrance of the child's home, providing safe and accessible entry for wheelchair users and families." },
          ],
          dontTitle: 'SOARD does not',
          dontItems: [
            'Install bathtubs',
            'Install or build pools and/or hot tubs',
            'Add on to homes or convert unfinished spaces',
            'Complete kitchen remodels',
            'Install or fund lifts',
            'Donate or raise money for bills, mortgages, vehicles, or any other purchases',
          ],
        },
        {
          id: 'ackParameters', type: 'ack', required: true,
          label: 'I have read the above and understand that a SOARD makeover includes construction and renovation work to my home and that SOARD only works within the existing structure of the home in a finished, heated and cooled space, free of lead, asbestos, and/or mold, and properly maintained.',
          options: ["Yes, I have read and understand SOARD's makeover parameters."],
        },
        {
          id: 'ackSeason', type: 'ack', required: true,
          label: 'I understand that this application is for the {year} makeover season, with construction expected to begin no sooner than the spring of {year}.',
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
          options: [
            { value: 'Accessible Bathroom', description: 'This scope of work typically entails a full demolition of the existing bathroom, followed by a complete rebuild with an accessible layout that includes a zero-entry shower, widened doorway (when structure allows), grab bars, an accessible vanity, and a side-transfer toilet.' },
            { value: 'Dream Bedroom', description: 'Our expert designers create a beautifully designed bedroom for a child who needs a comfortable and upbeat place to hang out, recover and just be a kid.' },
            { value: 'In-Home Therapy Room', description: "With guidance from the child's therapists, an existing finished room in the home will be converted into a therapy room where the child can thrive. Therapy equipment is limited to funding availability." },
            { value: 'Ramp', description: 'SOARD designs and installs exterior ramps at the entrance of the child’s home, providing safe and accessible entry for wheelchair users and families.' },
          ],
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
  stops: {
    outside: {
      title: 'Thank you so much for your interest in Sunshine on a Ranney Day.',
      body: '<p>At this time, we are only able to provide makeovers within the area outlined in red below or its immediate surroundings. Please check back in the future to see if our service area has expanded.</p>',
      image: SERVICE_MAP_IMAGE,
    },
    rental: {
      title: 'Thank you so much for your interest in Sunshine on a Ranney Day.',
      body: '<p>Families must own their home to qualify for a makeover.</p>',
    },
  },
  messages: DEFAULT_MESSAGES,
  staffEmails: DEFAULT_STAFF_EMAILS,
};

/** The stop screens of the built-in form (kept for callers that predate versions) */
export const STOPS = DEFAULT_DEFINITION.stops;

// ─── Resolving a stored definition for one season ──────────────────

const clone = (o) => JSON.parse(JSON.stringify(o));
const fillYear = (s, year) => (typeof s === 'string' ? s.replace(/\{year\}/g, year) : s);

/** A choice as { value, label, description } */
export function choice(o) {
  if (o && typeof o === 'object') {
    const value = String(o.value ?? o.label ?? '');
    return { value, label: String(o.label || value), description: o.description ? String(o.description) : '' };
  }
  return { value: String(o ?? ''), label: String(o ?? ''), description: '' };
}

/**
 * The form families see for `year`: {year} filled in, each field's options as
 * a list of values plus optionLabels / descriptions maps.
 * Returns { title, year, version, pages, stops, messages, staffEmails }.
 */
export function resolveForm(definition = DEFAULT_DEFINITION, { year = '2027', version = 0 } = {}) {
  const def = clone(definition || DEFAULT_DEFINITION);
  const y = String(year);
  const pages = (def.pages || []).map(p => ({
    id: p.id,
    title: fillYear(p.title, y),
    fields: (p.fields || []).map((f) => {
      const out = { ...f };
      for (const k of ['label', 'help', 'html', 'alt', 'title', 'doTitle', 'dontTitle']) if (out[k] != null) out[k] = fillYear(out[k], y);
      if (Array.isArray(out.doItems)) out.doItems = out.doItems.map(i => ({ title: fillYear(i.title, y), text: fillYear(i.text, y) }));
      if (Array.isArray(out.dontItems)) out.dontItems = out.dontItems.map(i => fillYear(i, y));
      if (Array.isArray(f.options)) {
        const choices = f.options.map(choice);
        out.options = choices.map(c => c.value);
        out.optionLabels = Object.fromEntries(choices.map(c => [c.value, fillYear(c.label, y)]));
        out.descriptions = Object.fromEntries(choices.filter(c => c.description).map(c => [c.value, fillYear(c.description, y)]));
      }
      return out;
    }),
  }));
  const stops = Object.fromEntries(Object.entries(def.stops || {}).map(([k, s]) => [k, { ...s, title: fillYear(s.title, y), body: fillYear(s.body, y) }]));
  return {
    title: fillYear(def.title || DEFAULT_DEFINITION.title, y),
    year: y,
    version,
    pages,
    stops,
    messages: { ...DEFAULT_MESSAGES, ...(def.messages || {}) },
    staffEmails: Array.isArray(def.staffEmails) && def.staffEmails.length ? def.staffEmails : DEFAULT_STAFF_EMAILS,
  };
}

/** The built-in form for a season (version 0); pass `definition` for an edited one */
export function applicationForm({ year = '2027', definition = null, version = 0 } = {}) {
  return resolveForm(definition || DEFAULT_DEFINITION, { year, version });
}

/** A family message with its blanks filled */
export function renderMessage(template, { parent = 'Hello', child = '', copyNote = '' } = {}) {
  return String(template || '')
    .replace(/\{parent\}/g, parent)
    .replace(/\{child\}/g, child)
    .replace(/\{copyNote\}/g, copyNote ? `\n\n${copyNote}` : '')
    .slice(0, 4096);
}

// ─── Cleaning and checking an edited definition ────────────────────

const ALLOWED_TAGS = new Set(['p', 'br', 'strong', 'b', 'em', 'i', 'u', 'ul', 'ol', 'li', 'a', 'h3', 'h4']);

/**
 * Whitelist HTML for the text blocks and stop screens: the tags above, no
 * attributes except a safe href on links. Everything else is dropped (script
 * and style with their contents).
 */
export function sanitizeHtml(html) {
  let s = String(html || '').slice(0, HTML_MAX * 2);
  s = s.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|iframe|object|embed|template)[\s\S]*?<\/\1\s*>/gi, '');
  s = s.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)([^<>]*)>/g, (m, tag, attrs) => {
    const t = tag.toLowerCase();
    if (!ALLOWED_TAGS.has(t)) return '';
    if (m.startsWith('</')) return `</${t}>`;
    if (t === 'a') {
      const href = (attrs.match(/href\s*=\s*"([^"]*)"/i) || attrs.match(/href\s*=\s*'([^']*)'/i) || [])[1] || '';
      const ok = /^(https?:\/\/|mailto:|tel:|\/)/i.test(href.trim()) && !/["<>]/.test(href);
      return ok ? `<a href="${href.trim()}">` : '<a>';
    }
    return t === 'br' ? '<br>' : `<${t}>`;
  });
  // A stray "<" that isn't a tag can't start one now
  s = s.replace(/<(?![a-z/])/gi, '&lt;');
  return s.trim().slice(0, HTML_MAX);
}

const str = (v, n) => String(v ?? '').replace(/\u0000/g, '').trim().slice(0, n);

/** A definition reduced to known keys, trimmed, HTML cleaned (doesn't judge it; see validateDefinition) */
export function normalizeDefinition(input) {
  const d = input && typeof input === 'object' ? input : {};
  const pages = (Array.isArray(d.pages) ? d.pages : []).slice(0, 40).map(p => ({
    id: str(p?.id, 40),
    title: str(p?.title, 160),
    fields: (Array.isArray(p?.fields) ? p.fields : []).slice(0, 80).map(normalizeField),
  }));
  const stops = {};
  for (const [k, s] of Object.entries(d.stops && typeof d.stops === 'object' ? d.stops : {}).slice(0, 12)) {
    stops[str(k, 30)] = { title: str(s?.title, 240), body: sanitizeHtml(s?.body), ...(s?.image ? { image: str(s.image, 200) } : {}) };
  }
  const messages = {};
  for (const k of MESSAGE_KEYS) messages[k] = str(d.messages?.[k] ?? DEFAULT_MESSAGES[k], k === 'copyNote' ? 400 : MESSAGE_MAX);
  const staffEmails = (Array.isArray(d.staffEmails) ? d.staffEmails : []).map(e => str(e, 160)).filter(Boolean).slice(0, 10);
  return { schema: 2, title: str(d.title || DEFAULT_DEFINITION.title, 200), pages, stops, messages, staffEmails };
}

function normalizeField(f) {
  const o = f && typeof f === 'object' ? f : {};
  const out = { id: str(o.id, 48), type: str(o.type, 20) };
  if (o.label != null) out.label = str(o.label, 1200);
  if (o.help) out.help = str(o.help, 1200);
  if (o.required) out.required = true;
  if (out.type === 'content') out.html = sanitizeHtml(o.html);
  if (out.type === 'image') { out.image = str(o.image, 200); out.alt = str(o.alt, 300); out.width = Number(o.width) || 938; out.height = Number(o.height) || 768; }
  if (out.type === 'guidelines') {
    out.title = str(o.title, 240);
    out.doTitle = str(o.doTitle, 120);
    out.doItems = (Array.isArray(o.doItems) ? o.doItems : []).slice(0, 20).map(i => ({ title: str(i?.title, 160), text: str(i?.text, 800) })).filter(i => i.title || i.text);
    out.dontTitle = str(o.dontTitle, 120);
    out.dontItems = (Array.isArray(o.dontItems) ? o.dontItems : []).slice(0, 20).map(i => str(i, 400)).filter(Boolean);
  }
  if (Array.isArray(o.options)) {
    out.options = o.options.slice(0, 40).map(choice).map(c => {
      const opt = { value: str(c.value, TEXT_MAX) };
      if (c.label && c.label !== c.value) opt.label = str(c.label, TEXT_MAX);
      if (c.description) opt.description = str(c.description, 1200);
      return opt.label || opt.description ? opt : opt.value;
    });
  }
  if (o.max) out.max = Math.max(1, Math.min(40, Math.floor(Number(o.max)) || 1));
  if (o.rows) out.rows = Math.max(1, Math.min(20, Math.floor(Number(o.rows)) || 5));
  if (o.showIf?.field) out.showIf = { field: str(o.showIf.field, 48), in: (Array.isArray(o.showIf.in) ? o.showIf.in : []).map(v => str(v, TEXT_MAX)).filter(Boolean) };
  if (o.stops && typeof o.stops === 'object') {
    const stops = Object.fromEntries(Object.entries(o.stops).map(([v, k]) => [str(v, TEXT_MAX), str(k, 30)]).filter(([v, k]) => v && k));
    if (Object.keys(stops).length) out.stops = stops;
  }
  return out;
}

/**
 * Problems that would stop a definition going live: [{ where, message }].
 * `where` is a page id, "pageId/fieldId", "stops/<key>" or "messages/<key>".
 */
export function validateDefinition(def) {
  const errors = [];
  const err = (where, message) => errors.push({ where, message });
  if (!def || !Array.isArray(def.pages) || !def.pages.length) { err('', 'The form needs at least one page.'); return errors; }
  const pageIds = new Set();
  const seen = new Map(); // field id → field (in order)
  for (const p of def.pages) {
    if (!/^[a-z0-9-]{1,40}$/.test(p.id || '')) err(p.id || '?', 'Each page needs an id of lowercase letters, numbers and dashes.');
    else if (pageIds.has(p.id)) err(p.id, 'Two pages have the same id.');
    pageIds.add(p.id);
    if (!p.title) err(p.id, 'This page needs a title.');
    if (!p.fields.length) err(p.id, 'This page has no questions or text.');
    for (const f of p.fields) {
      const where = `${p.id}/${f.id}`;
      if (!/^[A-Za-z][A-Za-z0-9_]{0,47}$/.test(f.id || '')) { err(where, 'A question has an invalid id.'); continue; }
      if (seen.has(f.id)) err(where, 'Two questions have the same id.');
      if (!FIELD_TYPES[f.type]) { err(where, `Unknown question type "${f.type}".`); continue; }
      const answered = !['content', 'image', 'guidelines'].includes(f.type);
      if (answered && !f.label) err(where, 'This question needs wording.');
      if (f.type === 'content' && !f.html) err(where, 'This text block is empty.');
      if (f.type === 'image' && !/^[\w\-./%]+$/.test(f.image || '')) err(where, 'This image needs a Cloudflare Images id.');
      if (f.type === 'guidelines' && !(f.doItems?.length || f.dontItems?.length)) err(where, 'The guidelines lists are empty.');
      if (CHOICE_TYPES.includes(f.type)) {
        const values = (f.options || []).map(o => choice(o).value);
        if (!values.length || values.some(v => !v)) err(where, 'Every choice needs wording.');
        if (new Set(values).size !== values.length) err(where, 'Two choices are the same.');
        if (f.type === 'ack' && values.length !== 1) err(where, 'A checkbox to agree has exactly one box.');
        if (f.type === 'checkbox' && f.max && f.max > values.length) err(where, `"Choose up to ${f.max}" is more than the ${values.length} choices.`);
        for (const [v, key] of Object.entries(f.stops || {})) {
          if (!values.includes(v)) err(where, `A stop screen is set on a choice that no longer exists ("${v}").`);
          if (!def.stops?.[key]) err(where, `The stop screen "${key}" doesn't exist.`);
        }
      } else if (f.stops) err(where, 'Only questions with choices can end the application.');
      if (f.showIf) {
        const parent = seen.get(f.showIf.field);
        if (!parent) err(where, '"Show only when" must point to a question earlier in the form.');
        else if (!CHOICE_TYPES.includes(parent.type)) err(where, '"Show only when" must point to a question with choices.');
        else {
          const pv = parent.options.map(o => choice(o).value);
          if (!f.showIf.in.length) err(where, '"Show only when" needs at least one answer picked.');
          if (f.showIf.in.some(v => !pv.includes(v))) err(where, '"Show only when" picks an answer that no longer exists.');
        }
      }
      const lock = LOCKED_FIELDS[f.id];
      if (lock) {
        if (!lock.types.includes(f.type)) err(where, `This question feeds ${lock.role.replace(/^JobTread: /, 'JobTread ')} and must stay a ${lock.types.map(t => FIELD_TYPES[t]).join(' or ')} question.`);
        if (lock.required && !f.required) err(where, 'This question must stay required.');
        if (lock.values && CHOICE_TYPES.includes(f.type)) {
          const values = (f.options || []).map(o => choice(o).value);
          if (values.some(v => !lock.values.includes(v))) err(where, `JobTread only knows these choices: ${lock.values.join(', ')}. You can reword them, not add new ones.`);
          if (lock.allValues && lock.values.some(v => !values.includes(v))) err(where, `Keep all of these choices: ${lock.values.join(', ')}.`);
          if (!values.length) err(where, 'Keep at least one choice.');
        }
      }
      seen.set(f.id, f);
    }
  }
  for (const id of Object.keys(LOCKED_FIELDS)) if (!seen.has(id)) err(id, `The question "${id}" feeds ${LOCKED_FIELDS[id].role.replace(/^JobTread: /, 'JobTread ')}; it can be reworded or moved, not removed.`);
  for (const [k, s] of Object.entries(def.stops || {})) {
    if (!/^[a-z0-9-]{1,30}$/.test(k)) err(`stops/${k}`, 'A stop screen has an invalid id.');
    if (!s.title) err(`stops/${k}`, 'This stop screen needs a title.');
  }
  for (const k of ['welcome', 'inReview', 'approved', 'denied']) {
    const m = def.messages?.[k];
    if (!m) err(`messages/${k}`, 'This message is empty.');
    else if (!m.includes('{child}')) err(`messages/${k}`, 'This message should name the child with {child}.');
  }
  for (const e of def.staffEmails || []) if (!isEmailAddress(e)) err('staffEmails', `"${e}" isn't an email address.`);
  return errors;
}

/** A fresh id for a question added in the editor */
export function newFieldId(existing = new Set()) {
  let id;
  do id = `q${Math.random().toString(36).slice(2, 8)}`; while (existing.has(id));
  return id;
}

// ─── Using a resolved form ─────────────────────────────────────────

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

export function indexById(form) {
  return Object.fromEntries(allFields(form).map(f => [f.id, f]));
}

/** The stop screen these answers lead to, or null. */
export function stopFor(form, answers) {
  const byId = indexById(form);
  const stops = form.stops || STOPS;
  for (const f of allFields(form)) {
    if (!f.stops || !isVisible(f, answers, byId)) continue;
    const key = f.stops[answers?.[f.id]];
    if (key && stops[key]) return { key, field: f.id, page: f.page, ...stops[key] };
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

/** A choice's wording (an answer is stored as the choice's value) */
export function optionLabel(field, value) {
  return field?.optionLabels?.[value] || String(value ?? '');
}

/** One answer as plain text, for the PDF, emails and JobTread */
export function answerText(field, value) {
  if (value == null) return '';
  switch (field.type) {
    case 'name': return nameText(value);
    case 'signature': return String(value);
    case 'address': return addressText(value);
    case 'date': return dateText(value);
    case 'checkbox': return (value || []).map(v => optionLabel(field, v)).join(', ');
    case 'radio': case 'select': case 'ack': return optionLabel(field, value);
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
