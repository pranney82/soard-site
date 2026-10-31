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
 * season from Admin → Applications → Settings.
 *
 * Field types:
 *   text, textarea, email, phone, date, select, radio, checkbox (max = most
 *   choices), name {first, last}, address {line1, line2, city, state, zip},
 *   ack (one box that must be ticked), signature (typed full name),
 *   photo, video (uploads; their values live in the draft's files, not answers),
 *   content (static html), image (static Cloudflare Images id),
 *   guidelines (the "what we do / don't" lists),
 *   area (the service-area check: the form answers it from the home address
 *     on the same page, by placing it on the map; the family only picks an
 *     answer when the address can't be found. Its three choices are, in
 *     order, inside / close / farther out (AREA_VALUES); each description is
 *     what the family reads when the check lands there, {miles} filled in.)
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

import { DEFAULT_ES } from './_application-form-es.js';
import { areaRules, NEAR_MILES } from '../../public/admin/area-shared.js';
import { YES_NO, COUNTIES, AREA_VALUES } from './_application-constants.js';
import { ORG_LOCKED_FIELDS, ORG_DEFAULT_MESSAGES, ORG_DEFAULT_REMINDERS, ORG_DEFAULT_DEFINITION, ORG_SPACE_TYPES } from './_application-form-org.js';

export { YES_NO, COUNTIES, AREA_VALUES, ORG_LOCKED_FIELDS, ORG_DEFAULT_DEFINITION, ORG_SPACE_TYPES };

// The old static map picture (the form draws a live map now; kept for older stop screens)
export const SERVICE_MAP_IMAGE = 'd993cd7c-7863-4a1b-ea5e-50602623cb00';

export const TEXT_MAX = 300;
export const TEXTAREA_MAX = 6000;
export const HTML_MAX = 20000;

export const MAKEOVER_TYPES = ['Accessible Bathroom', 'Dream Bedroom', 'In-Home Therapy Room', 'Ramp'];
/** The Primary Language choices JobTread has (a choice must be one of these to reach JobTread) */
export const LANGUAGES = ['English', 'Spanish', 'French', 'Vietnamese', 'Chinese', 'Korean'];

/** What each type is called in the editor, and which ones families answer */
export const FIELD_TYPES = {
  text: 'Short answer',
  textarea: 'Long answer',
  email: 'Email',
  phone: 'Phone',
  number: 'Number',
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
  area: 'Service-area check',
};
export const CHOICE_TYPES = ['select', 'radio', 'checkbox', 'ack', 'area'];

// The service-area answers (AREA_VALUES, ./_application-constants.js), back to their band
export const AREA_BANDS = Object.fromEntries(Object.entries(AREA_VALUES).map(([k, v]) => [v, k]));

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
  boundary: { role: 'The service-area check (Settings → Service area)', types: ['area'], values: Object.values(AREA_VALUES), allValues: true, required: true },
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
  // Sent by staff (never automatically) when a family was emailed a status by
  // mistake. {status} becomes a line about where the application really stands.
  correction: `{parent}

Please disregard our last message about the application for *{child}*. It was sent by mistake, and we're sorry for the confusion.

{status}

If you have any questions, just reply to this message.`,
};
export const MESSAGE_KEYS = ['welcome', 'copyNote', 'inReview', 'approved', 'denied', 'correction'];

/**
 * When status emails go out (./_applicant-notify.js). A family is emailed
 * the status they should know once it has stayed put for `waits` minutes
 * (welcome = a hand-made JobTread account reaching Applied; decision =
 * Approved or Denied), never between quiet.start and quiet.end Eastern
 * (24-hour clock; equal = no quiet hours). `summary`: the person who made
 * changes in JobTread gets one email listing them, with undo links.
 */
export const DEFAULT_NOTIFY = {
  waits: { welcome: 10, inReview: 10, decision: 30 },
  quiet: { start: 20, end: 8 },
  summary: true,
};
export const MESSAGE_MAX = 3600; // JobTread comments hold 4096; room for names and the copy line

export const DEFAULT_STAFF_EMAILS = ['selection@soardcharity.com'];

/**
 * Reminder emails to families who started and stopped. days = days of quiet
 * before each one (counted from their last change). Placeholders: {parent}
 * (first name), {child} (first name), {percent} (how far along), {year}.
 */
export const DEFAULT_REMINDERS = {
  enabled: true,
  days: [2, 7, 21],
  subject: 'Your SOARD application is waiting for you',
  body: `Hi {parent},

You started a {year} makeover application for {child} with Sunshine on a Ranney Day, and your answers are saved. You're about {percent}% done. Whenever you're ready, you can pick up right where you left off.

If you have questions or need help with any part of it, just reply to this email.`,
};

/**
 * The service area, as [lat, lng] corners (traced from the old Jotform map:
 * north of Canton, east of Cumming, Suwanee, Norcross, I-285, west of
 * Kennesaw). Every home address is placed against it; staff reshape it on the
 * Applicants map. nearMiles: homes outside it by no more than this count as
 * close. beyond: what families farther out get ('warn': told, and they can
 * still apply; 'stop': the "outside" stop screen).
 */
export const DEFAULT_SERVICE_AREA = {
  polygon: [[34.330, -84.480], [34.222, -84.072], [33.969, -84.082], [33.893, -84.263], [33.884, -84.460], [34.005, -84.703]],
  nearMiles: NEAR_MILES,
  beyond: 'warn',
};

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
      title: 'Service Area',
      fields: [
        {
          id: 'serviceAreaText', type: 'content',
          html: `<p>Sunshine on a Ranney Day's makeovers are for children whose home is <strong>inside</strong> our service area, shown on the map. Enter the address where the makeover would happen, and we'll check it for you.</p>`,
        },
        { id: 'address', type: 'address', required: true, label: "Child's Permanent Address (Address where the makeover will be completed)" },
        {
          id: 'boundary', type: 'area', required: true,
          label: "Is the child's home inside the service area shown on the map?",
          options: [
            { value: AREA_VALUES.inside, label: 'Yes, it is inside the service area.', description: 'Good news: this home is inside our service area.' },
            { value: AREA_VALUES.near, label: 'No, but it is close to it.', description: 'This home is about {miles} miles outside our service area. You can still apply, and our team will review it.' },
            { value: AREA_VALUES.far, label: 'No, it is not inside it or close to it.', description: 'This home is about {miles} miles outside our service area. We only do makeovers inside it, so we likely can’t help this time. You’re still welcome to send your application.' },
          ],
        },
        { id: 'county', type: 'select', required: true, label: "What county is the child's home located in?", options: COUNTIES },
        { id: 'resides50', type: 'radio', required: true, options: YES_NO, label: 'Does the child reside at the above address at least 50% of their time?' },
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
    // Shown to families far outside the area when Settings say to stop them (with the map and their pin)
    outside: {
      title: 'Thank you so much for your interest in Sunshine on a Ranney Day.',
      body: '<p>Our makeovers are only for homes inside our service area, and this address is outside it. Please check back in the future to see if our service area has grown.</p>',
    },
    rental: {
      title: 'Thank you so much for your interest in Sunshine on a Ranney Day.',
      body: '<p>Families must own their home to qualify for a makeover.</p>',
    },
  },
  messages: DEFAULT_MESSAGES,
  staffEmails: DEFAULT_STAFF_EMAILS,
  reminders: DEFAULT_REMINDERS,
  notify: DEFAULT_NOTIFY,
  serviceArea: DEFAULT_SERVICE_AREA,
  i18n: { es: { strings: DEFAULT_ES, sources: {} } },
};

/** The stop screens of the built-in form (kept for callers that predate versions) */
export const STOPS = DEFAULT_DEFINITION.stops;

// ─── Kinds: a family's application, or an organization's ───────────

/**
 * Two applications run through the same pipeline: a family's for their child
 * (this file) and an organization's for a community project
 * (./_application-form-org.js). Everything without a kind is a family's.
 */
export const FORM_KINDS = ['family', 'organization'];
export const kindOf = (v) => (v === 'organization' || v?.kind === 'organization' ? 'organization' : 'family');
export const isOrganizationKind = (v) => kindOf(v) === 'organization';
export const lockedFieldsFor = (kind) => (isOrganizationKind(kind) ? ORG_LOCKED_FIELDS : LOCKED_FIELDS);
export const defaultDefinitionFor = (kind) => (isOrganizationKind(kind) ? ORG_DEFAULT_DEFINITION : DEFAULT_DEFINITION);
export const defaultMessagesFor = (kind) => (isOrganizationKind(kind) ? ORG_DEFAULT_MESSAGES : DEFAULT_MESSAGES);
export const defaultRemindersFor = (kind) => (isOrganizationKind(kind) ? ORG_DEFAULT_REMINDERS : DEFAULT_REMINDERS);
/** The token every status message must have: the child's name, or the organization's */
export const nameTokenFor = (kind) => (isOrganizationKind(kind) ? '{organization}' : '{child}');

/**
 * Which question plays each part, so the pipeline reads an application the
 * same way whoever applied: who it's for (the JobTread account's name), the
 * main and second contacts, where, the kinds of space, the photos.
 */
export const FORM_ROLES = {
  family: {
    name: 'childName', nameType: 'name', contactName: 'parentName', email: 'parentEmail', phone: 'parentPhone', title: 'parentRelation',
    contact2: { name: 'parent2Name', email: 'parent2Email', phone: 'parent2Phone', title: 'parent2Relation' },
    types: 'makeoverTypes', photos: ['photoChild', 'photoFamily', 'photoSpace1', 'photoSpace2'],
  },
  organization: {
    name: 'orgName', nameType: 'text', contactName: 'contactName', email: 'contactEmail', phone: 'contactPhone', title: 'contactTitle',
    contact2: { name: 'contact2Name', email: 'contact2Email', phone: 'contact2Phone', title: 'contact2Title' },
    types: 'spaceTypes', photos: ['photoSpace1', 'photoSpace2', 'photoSpace3'],
  },
};
export const rolesFor = (kind) => FORM_ROLES[kindOf(kind)];

// ─── Translations ──────────────────────────────────────────────────

/** Languages the application can be shown in (English is always there) */
export const LANGS = { en: 'English', es: 'Español' };

/**
 * Every piece of family-facing English in a definition, by a stable path:
 * title, page:<id>, field:<id>:label|help|html|alt|title|doTitle|dontTitle,
 * field:<id>:doItems:<n>:title|text, field:<id>:dontItems:<n>,
 * field:<id>:option:<value>, field:<id>:desc:<value>, stop:<key>:title|body,
 * message:<key>, reminder:subject|body. Translations are keyed the same way.
 */
export function englishStrings(def) {
  const out = {};
  const put = (path, v) => { if (typeof v === 'string' && v.trim()) out[path] = v; };
  put('title', def.title);
  for (const p of def.pages || []) {
    put(`page:${p.id}`, p.title);
    for (const f of p.fields || []) {
      for (const k of ['label', 'help', 'html', 'alt', 'title', 'doTitle', 'dontTitle']) put(`field:${f.id}:${k}`, f[k]);
      (f.doItems || []).forEach((it, i) => { put(`field:${f.id}:doItems:${i}:title`, it.title); put(`field:${f.id}:doItems:${i}:text`, it.text); });
      (f.dontItems || []).forEach((it, i) => put(`field:${f.id}:dontItems:${i}`, it));
      for (const o of f.options || []) {
        const c = choice(o);
        put(`field:${f.id}:option:${c.value}`, c.label);
        put(`field:${f.id}:desc:${c.value}`, c.description);
      }
    }
  }
  for (const [k, s] of Object.entries(def.stops || {})) { put(`stop:${k}:title`, s.title); put(`stop:${k}:body`, s.body); }
  const msgs = { ...defaultMessagesFor(def), ...(def.messages || {}) };
  for (const k of MESSAGE_KEYS) put(`message:${k}`, msgs[k]);
  const rem = { ...defaultRemindersFor(def), ...(def.reminders || {}) };
  put('reminder:subject', rem.subject);
  put('reminder:body', rem.body);
  return out;
}

/**
 * Where each translation stands against the current English:
 * { path: 'done' | 'missing' | 'stale' } (stale = the English changed after
 * it was translated). Only paths with English are listed.
 */
export function translationStatus(def, lang = 'es') {
  const en = englishStrings(def);
  const tr = def.i18n?.[lang] || {};
  const strings = tr.strings || {};
  const sources = tr.sources || {};
  const out = {};
  for (const [path, text] of Object.entries(en)) {
    if (!strings[path]) out[path] = 'missing';
    else if (sources[path] != null && sources[path] !== text) out[path] = 'stale';
    else out[path] = 'done';
  }
  return out;
}

// The built-in Spanish was written from the built-in English
DEFAULT_DEFINITION.i18n.es.sources = Object.fromEntries(Object.entries(englishStrings(DEFAULT_DEFINITION)).filter(([p]) => DEFAULT_ES[p]));

/**
 * Strings still carrying the built-in Spanish under English that has since
 * changed, whatever their source says: the built-in Spanish was written from
 * the built-in English. (A keystroke in the Spanish box used to mark old
 * Spanish as current without changing it; the live Denied email, Oct 2026.)
 * Spanish someone kept with "The Spanish is still right" for today's English
 * stays as it is. → { path: the built-in English it was made from }
 */
export function builtInSpanishBehind(def) {
  const es = def?.i18n?.es?.strings || {};
  const kept = def?.i18n?.es?.kept || {};
  const from = DEFAULT_DEFINITION.i18n.es.sources;
  const en = englishStrings(def);
  return Object.fromEntries(Object.keys(en).filter(p => es[p] && es[p] === DEFAULT_ES[p] && from[p] != null && en[p] !== from[p] && kept[p] !== en[p]).map(p => [p, from[p]]));
}

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
 * The form families see for `year` in `lang`: {year} filled in, translations
 * laid over the English (missing ones stay English), each field's options as
 * a list of values plus optionLabels / descriptions maps.
 * Returns { title, year, version, lang, languages, pages, stops, messages,
 * reminders, staffEmails, serviceArea }.
 */
export function resolveForm(definition = DEFAULT_DEFINITION, { year = '2027', version = 0, lang = 'en' } = {}) {
  const def = clone(definition || DEFAULT_DEFINITION);
  const kind = kindOf(def);
  const y = String(year);
  const languages = ['en', ...Object.keys(def.i18n || {}).filter(l => LANGS[l] && Object.keys(def.i18n[l]?.strings || {}).length)];
  const useLang = languages.includes(lang) ? lang : 'en';
  const tr = useLang === 'en' ? {} : (def.i18n?.[useLang]?.strings || {});
  const t = (path, en) => fillYear(tr[path] || en, y);
  const area = areaRules(def.serviceArea, DEFAULT_SERVICE_AREA.polygon);
  const pages = (def.pages || []).map(p => ({
    id: p.id,
    title: t(`page:${p.id}`, p.title),
    ...(p.showIf ? { showIf: p.showIf } : {}),
    fields: (p.fields || []).map((f) => {
      const out = { ...f };
      for (const k of ['label', 'help', 'html', 'alt', 'title', 'doTitle', 'dontTitle']) if (out[k] != null) out[k] = t(`field:${f.id}:${k}`, out[k]);
      if (Array.isArray(out.doItems)) out.doItems = out.doItems.map((i, n) => ({ title: t(`field:${f.id}:doItems:${n}:title`, i.title), text: t(`field:${f.id}:doItems:${n}:text`, i.text) }));
      if (Array.isArray(out.dontItems)) out.dontItems = out.dontItems.map((i, n) => t(`field:${f.id}:dontItems:${n}`, i));
      if (Array.isArray(f.options)) {
        const choices = f.options.map(choice);
        out.options = choices.map(c => c.value);
        out.optionLabels = Object.fromEntries(choices.map(c => [c.value, t(`field:${f.id}:option:${c.value}`, c.label)]));
        out.descriptions = Object.fromEntries(choices.filter(c => c.description).map(c => [c.value, t(`field:${f.id}:desc:${c.value}`, c.description)]));
        // Staff read applications in English: keep the English wording alongside
        if (useLang !== 'en') out.optionLabelsEn = Object.fromEntries(choices.map(c => [c.value, fillYear(c.label, y)]));
      }
      if (useLang !== 'en' && f.label) out.labelEn = fillYear(f.label, y);
      // The service-area check ends the application only when Settings say to stop families far out
      if (f.type === 'area') {
        delete out.stops;
        if (area.beyond === 'stop' && def.stops?.outside) out.stops = { [AREA_VALUES.far]: 'outside' };
      }
      return out;
    }),
  }));
  const stops = Object.fromEntries(Object.entries(def.stops || {}).map(([k, s]) => [k, { ...s, title: t(`stop:${k}:title`, s.title), body: t(`stop:${k}:body`, s.body) }]));
  const baseMessages = { ...defaultMessagesFor(kind), ...(def.messages || {}) };
  const messages = Object.fromEntries(MESSAGE_KEYS.map(k => [k, tr[`message:${k}`] || baseMessages[k]]));
  const rem = { ...defaultRemindersFor(kind), ...(def.reminders || {}) };
  return {
    kind,
    title: t('title', def.title || defaultDefinitionFor(kind).title),
    year: y,
    version,
    lang: useLang,
    languages,
    pages,
    stops,
    messages,
    reminders: { ...rem, subject: fillYear(tr['reminder:subject'] || rem.subject, y), body: fillYear(tr['reminder:body'] || rem.body, y) },
    staffEmails: Array.isArray(def.staffEmails) && def.staffEmails.length ? def.staffEmails : DEFAULT_STAFF_EMAILS,
    serviceArea: area,
    notify: notifySettings(def.notify),
  };
}

/** Wait times, quiet hours and the summary switch, with the built-in values filled in */
export function notifySettings(n) {
  const o = n && typeof n === 'object' ? n : {};
  const mins = (v, d) => (Number.isFinite(Number(v)) ? Math.max(0, Math.min(1440, Math.round(Number(v)))) : d);
  const hour = (v, d) => (Number.isFinite(Number(v)) ? Math.max(0, Math.min(23, Math.floor(Number(v)))) : d);
  const w = o.waits || {};
  return {
    waits: { welcome: mins(w.welcome, DEFAULT_NOTIFY.waits.welcome), inReview: mins(w.inReview, DEFAULT_NOTIFY.waits.inReview), decision: mins(w.decision, DEFAULT_NOTIFY.waits.decision) },
    quiet: { start: hour(o.quiet?.start, DEFAULT_NOTIFY.quiet.start), end: hour(o.quiet?.end, DEFAULT_NOTIFY.quiet.end) },
    summary: o.summary !== false,
  };
}

/** The built-in form for a season (version 0); pass `definition` for an edited one */
export function applicationForm({ year = '2027', definition = null, version = 0, lang = 'en' } = {}) {
  return resolveForm(definition || DEFAULT_DEFINITION, { year, version, lang });
}

/**
 * A family message with its blanks filled. An organization's messages say
 * {contact} and {organization} for the same two blanks.
 */
export function renderMessage(template, { parent = 'Hello', child = '', copyNote = '', percent = '', year = '', status = '' } = {}) {
  return String(template || '')
    .replace(/\{status\}/g, status)
    .replace(/\{parent\}|\{contact\}/g, parent)
    .replace(/\{child\}|\{organization\}/g, child)
    .replace(/\{percent\}/g, percent)
    .replace(/\{year\}/g, year)
    .replace(/\{copyNote\}/g, copyNote ? `\n\n${copyNote}` : '')
    .slice(0, 4096);
}

// ─── Rules: "show only when" for questions and pages ───────────────

/**
 * A rule is { field, in: [values] } (that question's answer is one of these),
 * or { all: [rules] } / { any: [rules] }. A question on a hidden page, or
 * behind a hidden question, counts as unanswered.
 */
export function ruleFields(rule) {
  if (!rule) return [];
  if (Array.isArray(rule.all)) return rule.all.flatMap(ruleFields);
  if (Array.isArray(rule.any)) return rule.any.flatMap(ruleFields);
  return rule.field ? [rule.field] : [];
}

export function ruleMatches(rule, answers, byId, seen = new Set()) {
  if (!rule) return true;
  if (Array.isArray(rule.all)) return rule.all.every(r => ruleMatches(r, answers, byId, seen));
  if (Array.isArray(rule.any)) return rule.any.some(r => ruleMatches(r, answers, byId, seen));
  if (!rule.field) return true;
  const parent = byId?.[rule.field];
  if (parent && !isVisible(parent, answers, byId, seen)) return false;
  const v = answers?.[rule.field];
  const vals = Array.isArray(v) ? v : [v];
  return vals.some(x => (rule.in || []).includes(x));
}

/** In plain words, for the editor: 'Gender is Female, and County is Cobb or Fulton' */
export function ruleText(rule, labelOf = (id) => id, valueOf = (id, v) => v) {
  if (!rule) return '';
  if (Array.isArray(rule.all)) return rule.all.map(r => ruleText(r, labelOf, valueOf)).join(', and ');
  if (Array.isArray(rule.any)) return rule.any.map(r => ruleText(r, labelOf, valueOf)).join(', or ');
  return `${labelOf(rule.field)} is ${(rule.in || []).map(v => valueOf(rule.field, v)).join(' or ')}`;
}

// ─── Cleaning and checking an edited definition ────────────────────

const ALLOWED_TAGS = new Set(['p', 'br', 'strong', 'b', 'em', 'i', 'u', 'ul', 'ol', 'li', 'a', 'h3', 'h4']);

/**
 * Allow-listed HTML for the text blocks and stop screens: the tags above, no
 * attributes except a safe href on links. It walks the text: a "<" that
 * starts a whole tag (closed by ">") becomes that tag if it's allowed and
 * nothing if not; any other "<" is shown as text, so a tag left unclosed can
 * never carry its attributes into the page. Script, style and the like go
 * with their contents.
 */
const TAG_AT = /^<(\/?)([a-zA-Z][a-zA-Z0-9]*)((?:\s[^<>]*?)?)\/?>/;
export function sanitizeHtml(html) {
  let s = String(html || '').slice(0, HTML_MAX * 2);
  s = s.replace(/<!--[\s\S]*?-->/g, '').replace(/<(script|style|iframe|object|embed|template)[\s\S]*?<\/\1\s*>/gi, '');
  let out = '';
  let i = 0;
  while (i < s.length) {
    const lt = s.indexOf('<', i);
    out += (lt < 0 ? s.slice(i) : s.slice(i, lt)).replace(/>/g, '&gt;');
    if (lt < 0) break;
    const m = TAG_AT.exec(s.slice(lt, lt + 2000));
    if (!m) { out += '&lt;'; i = lt + 1; continue; }
    i = lt + m[0].length;
    const t = m[2].toLowerCase();
    if (!ALLOWED_TAGS.has(t)) continue;
    if (m[1]) { if (t !== 'br') out += `</${t}>`; continue; }
    if (t === 'a') {
      const attrs = m[3] || '';
      const href = (attrs.match(/href\s*=\s*"([^"]*)"/i) || attrs.match(/href\s*=\s*'([^']*)'/i) || [])[1] || '';
      const ok = /^(https?:\/\/|mailto:|tel:|\/)/i.test(href.trim()) && !/["'<>\s]/.test(href.trim());
      out += ok ? `<a href="${href.trim()}">` : '<a>';
      continue;
    }
    out += t === 'br' ? '<br>' : `<${t}>`;
  }
  // Cut to size on a whole tag, never through one
  return out.trim().slice(0, HTML_MAX).replace(/<[^>]*$/, '');
}

const str = (v, n) => String(v ?? '').replace(/\u0000/g, '').trim().slice(0, n);
const num = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v));

function normalizeRule(r, depth = 0) {
  if (!r || typeof r !== 'object' || depth > 2) return null;
  for (const k of ['all', 'any']) {
    if (Array.isArray(r[k])) {
      const list = r[k].slice(0, 12).map(x => normalizeRule(x, depth + 1)).filter(Boolean);
      return list.length ? { [k]: list } : null;
    }
  }
  if (!r.field) return null;
  return { field: str(r.field, 48), in: (Array.isArray(r.in) ? r.in : []).map(v => str(v, TEXT_MAX)).filter(Boolean) };
}

/** A definition reduced to known keys, trimmed, HTML cleaned (doesn't judge it; see validateDefinition) */
export function normalizeDefinition(input) {
  const d = input && typeof input === 'object' ? input : {};
  const kind = kindOf(d);
  const pages = (Array.isArray(d.pages) ? d.pages : []).slice(0, 40).map(p => {
    const page = { id: str(p?.id, 40), title: str(p?.title, 160), fields: (Array.isArray(p?.fields) ? p.fields : []).slice(0, 80).map(normalizeField) };
    const rule = normalizeRule(p?.showIf);
    if (rule) page.showIf = rule;
    return page;
  });
  const stops = {};
  for (const [k, s] of Object.entries(d.stops && typeof d.stops === 'object' ? d.stops : {}).slice(0, 12)) {
    stops[str(k, 30)] = { title: str(s?.title, 240), body: sanitizeHtml(s?.body), ...(s?.image ? { image: str(s.image, 200) } : {}) };
  }
  const messages = {};
  for (const k of MESSAGE_KEYS) messages[k] = str(d.messages?.[k] ?? defaultMessagesFor(kind)[k], k === 'copyNote' ? 400 : MESSAGE_MAX);
  const staffEmails = (Array.isArray(d.staffEmails) ? d.staffEmails : []).map(e => str(e, 160)).filter(Boolean).slice(0, 10);
  const r = { ...defaultRemindersFor(kind), ...(d.reminders && typeof d.reminders === 'object' ? d.reminders : {}) };
  const reminders = {
    enabled: r.enabled !== false,
    days: (Array.isArray(r.days) ? r.days : []).map(n => Math.floor(Number(n))).filter(n => n >= 1 && n <= 60).slice(0, 6),
    subject: str(r.subject, 200),
    body: str(r.body, 3000),
  };
  const poly = Array.isArray(d.serviceArea?.polygon) ? d.serviceArea.polygon : DEFAULT_SERVICE_AREA.polygon;
  const { nearMiles, beyond } = areaRules(d.serviceArea);
  const serviceArea = {
    polygon: poly.slice(0, 200).map(pt => [Number(pt?.[0]), Number(pt?.[1])]).filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a) <= 90 && Math.abs(b) <= 180),
    nearMiles,
    beyond,
  };
  const i18n = {};
  for (const [lang, tr] of Object.entries(d.i18n && typeof d.i18n === 'object' ? d.i18n : {})) {
    if (!LANGS[lang] || lang === 'en') continue;
    const strings = {};
    const sources = {};
    for (const [path, text] of Object.entries(tr?.strings || {}).slice(0, 2000)) {
      const v = /:html$|^stop:.*:body$/.test(path) ? sanitizeHtml(text) : str(text, /^message:|^reminder:body/.test(path) ? MESSAGE_MAX : 6000);
      if (v) strings[str(path, 400)] = v;
    }
    for (const [path, text] of Object.entries(tr?.sources || {}).slice(0, 2000)) if (strings[path]) sources[str(path, 400)] = String(text ?? '').slice(0, HTML_MAX);
    // "The Spanish is still right": the English it was checked against (see builtInSpanishBehind)
    const kept = {};
    for (const [path, text] of Object.entries(tr?.kept || {}).slice(0, 2000)) if (strings[path]) kept[str(path, 400)] = String(text ?? '').slice(0, HTML_MAX);
    i18n[lang] = { strings, sources, ...(Object.keys(kept).length ? { kept } : {}) };
  }
  return { schema: 2, ...(kind === 'organization' ? { kind } : {}), title: str(d.title || defaultDefinitionFor(kind).title, 200), pages, stops, messages, staffEmails, reminders, notify: notifySettings(d.notify), serviceArea, i18n };
}

const JT_TYPES_FOR = {
  text: ['text', 'textarea', 'select', 'radio', 'email', 'phone', 'number', 'date'],
  option: ['select', 'radio', 'checkbox'],
  date: ['date'],
  number: ['number'],
  url: ['text'],
  emailAddress: ['email'],
  phoneNumber: ['phone'],
  boolean: ['ack'],
};

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
  const rule = normalizeRule(o.showIf);
  if (rule) out.showIf = rule;
  // The service-area check's stop comes from Settings, never the field
  if (o.stops && typeof o.stops === 'object' && out.type !== 'area') {
    const stops = Object.fromEntries(Object.entries(o.stops).map(([v, k]) => [str(v, TEXT_MAX), str(k, 30)]).filter(([v, k]) => v && k));
    if (Object.keys(stops).length) out.stops = stops;
  }
  if (o.rules && typeof o.rules === 'object') {
    const rules = {};
    for (const k of ['minLength', 'maxLength', 'min', 'max', 'minAge', 'maxAge']) { const n = num(o.rules[k]); if (n != null) rules[k] = n; }
    if (o.rules.integer) rules.integer = true;
    if (Object.keys(rules).length) out.rules = rules;
  }
  if (o.jobtread && typeof o.jobtread === 'object' && o.jobtread.fieldId) {
    out.jobtread = {
      fieldId: str(o.jobtread.fieldId, 40),
      target: o.jobtread.target === 'location' ? 'location' : 'account',
      name: str(o.jobtread.name, 120),
      type: str(o.jobtread.type, 30),
      ...(Array.isArray(o.jobtread.options) ? { options: o.jobtread.options.slice(0, 100).map(x => str(x, TEXT_MAX)) } : {}),
      ...(o.jobtread.multiple ? { multiple: true } : {}),
    };
  }
  return out;
}

/**
 * Problems that would stop a definition going live: [{ where, message }].
 * `where` is a page id, "pageId/fieldId", "stops/<key>", "messages/<key>",
 * "reminders", "serviceArea" or "staffEmails".
 */
export function validateDefinition(def) {
  const errors = [];
  const err = (where, message) => errors.push({ where, message });
  const LOCKED = lockedFieldsFor(def);
  const organization = isOrganizationKind(def);
  if (!def || !Array.isArray(def.pages) || !def.pages.length) { err('', 'The form needs at least one page.'); return errors; }
  const pageIds = new Set();
  const seen = new Map(); // field id → field (in order)
  const pageOf = new Map();
  const jtUsed = new Map();
  const checkRule = (rule, where, earlierOnly) => {
    for (const fid of ruleFields(rule)) {
      const parent = seen.get(fid);
      if (!parent || (earlierOnly && !earlierOnly(fid))) { err(where, '"Show only when" must point to a question earlier in the form.'); continue; }
      if (!CHOICE_TYPES.includes(parent.type)) { err(where, '"Show only when" must point to a question with choices.'); continue; }
    }
    const walk = (r) => {
      if (!r) return;
      if (r.all || r.any) { (r.all || r.any).forEach(walk); return; }
      const parent = seen.get(r.field);
      if (!parent || !CHOICE_TYPES.includes(parent.type)) return;
      const pv = parent.options.map(o => choice(o).value);
      if (!r.in.length) err(where, '"Show only when" needs at least one answer picked.');
      if (r.in.some(v => !pv.includes(v))) err(where, '"Show only when" picks an answer that no longer exists.');
    };
    walk(rule);
  };
  for (const p of def.pages) {
    if (!/^[a-z0-9-]{1,40}$/.test(p.id || '')) err(p.id || '?', 'Each page needs an id of lowercase letters, numbers and dashes.');
    else if (pageIds.has(p.id)) err(p.id, 'Two pages have the same id.');
    pageIds.add(p.id);
    if (!p.title) err(p.id, 'This page needs a title.');
    if (!p.fields.length) err(p.id, 'This page has no questions or text.');
    // A page's rule can only look at questions on earlier pages
    if (p.showIf) checkRule(p.showIf, p.id, (fid) => pageOf.get(fid) !== p.id);
    if (p.showIf && p.fields.some(f => LOCKED[f.id]?.required)) err(p.id, 'This page has questions the site needs, so it must always show.');
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
      if (f.showIf) checkRule(f.showIf, where, null);
      const r = f.rules || {};
      if (r.minLength != null && r.maxLength != null && r.minLength > r.maxLength) err(where, 'The shortest answer allowed is longer than the longest.');
      if (r.min != null && r.max != null && r.min > r.max) err(where, 'The smallest number allowed is bigger than the largest.');
      if (r.minAge != null && r.maxAge != null && r.minAge > r.maxAge) err(where, 'The youngest age allowed is older than the oldest.');
      if (r.maxLength != null && r.maxLength < 1) err(where, 'The longest answer allowed must be at least 1 character.');
      const lock = LOCKED[f.id];
      if (lock) {
        if (!lock.types.includes(f.type)) err(where, `This question feeds ${lock.role.replace(/^JobTread: /, 'JobTread ')} and must stay a ${lock.types.map(t => FIELD_TYPES[t]).join(' or ')} question.`);
        if (lock.required && !f.required) err(where, 'This question must stay required.');
        if (lock.required && f.showIf) err(where, 'This question must always show (the site needs it), so it can’t have "Show only when".');
        if (lock.values && CHOICE_TYPES.includes(f.type)) {
          const values = (f.options || []).map(o => choice(o).value);
          if (values.some(v => !lock.values.includes(v))) err(where, `JobTread only knows these choices: ${lock.values.join(', ')}. You can reword them, not add new ones.`);
          if (lock.allValues && lock.values.some(v => !values.includes(v))) err(where, `Keep all of these choices: ${lock.values.join(', ')}.`);
          if (!values.length) err(where, 'Keep at least one choice.');
        }
        if (f.jobtread) err(where, 'This question already feeds JobTread; it can’t be sent to a second field.');
      }
      if (f.jobtread) {
        const jt = f.jobtread;
        if (!(JT_TYPES_FOR[jt.type] || []).includes(f.type)) err(where, `A ${FIELD_TYPES[f.type]} question can't fill the JobTread field "${jt.name}" (${jt.type}).`);
        if (jtUsed.has(jt.fieldId)) err(where, `Another question already fills the JobTread field "${jt.name}".`);
        jtUsed.set(jt.fieldId, f.id);
        if (jt.type === 'option' && Array.isArray(jt.options) && CHOICE_TYPES.includes(f.type)) {
          const values = (f.options || []).map(o => choice(o).value);
          const unknown = values.filter(v => !jt.options.includes(v));
          if (unknown.length) err(where, `JobTread's "${jt.name}" doesn't have ${unknown.map(v => `"${v}"`).join(', ')}. Its choices are: ${jt.options.join(', ')}.`);
          if (f.type === 'checkbox' && !jt.multiple) err(where, `JobTread's "${jt.name}" holds one choice; use One choice or Dropdown.`);
        }
      }
      if (f.type === 'area') {
        if ([...seen.values()].some(x => x.type === 'area')) err(where, 'A form has one service-area check.');
        // It reads the home address, so the map and its answer sit just under it
        if (pageOf.get('address') !== p.id) err(where, organization ? 'The service-area check reads the address: keep it on the same page, below the address question.' : 'The service-area check reads the home address: keep it on the same page, below "Child’s Permanent Address".');
      }
      seen.set(f.id, f);
      pageOf.set(f.id, p.id);
    }
  }
  for (const id of Object.keys(LOCKED)) if (!seen.has(id)) err(id, `The question "${id}" feeds ${LOCKED[id].role.replace(/^JobTread: /, 'JobTread ')}; it can be reworded or moved, not removed.`);
  if ([...seen.values()].some(f => f.type === 'area') && !def.stops?.outside) err('stops/outside', 'Keep the "outside" stop screen: the service-area check shows it when Settings say to stop families far outside the area.');
  for (const [k, s] of Object.entries(def.stops || {})) {
    if (!/^[a-z0-9-]{1,30}$/.test(k)) err(`stops/${k}`, 'A stop screen has an invalid id.');
    if (!s.title) err(`stops/${k}`, 'This stop screen needs a title.');
  }
  for (const k of ['welcome', 'inReview', 'approved', 'denied', 'correction']) {
    const m = def.messages?.[k];
    if (!m) err(`messages/${k}`, 'This message is empty.');
    else if (!m.includes(nameTokenFor(def))) err(`messages/${k}`, organization ? 'This message should name the organization with {organization}.' : 'This message should name the child with {child}.');
  }
  if (def.messages?.correction && !def.messages.correction.includes('{status}')) err('messages/correction', 'The correction should say where the application stands with {status}.');
  for (const e of def.staffEmails || []) if (!isEmailAddress(e)) err('staffEmails', `"${e}" isn't an email address.`);
  const rem = def.reminders;
  if (rem?.enabled) {
    if (!rem.days?.length) err('reminders', 'Reminders are on but no days are set.');
    if (!rem.subject) err('reminders', 'The reminder email needs a subject.');
    if (!rem.body) err('reminders', 'The reminder email needs a message.');
    if ((rem.days || []).some((d, i, a) => i && d <= a[i - 1])) err('reminders', 'Reminder days must go up (for example 2, 7, 21).');
  }
  if (def.serviceArea && (def.serviceArea.polygon || []).length < 3) err('serviceArea', 'The service area needs at least three corners.');
  return errors;
}

/** A fresh id for a question added in the editor */
export function newFieldId(existing = new Set()) {
  let id;
  do id = `q${Math.random().toString(36).slice(2, 8)}`; while (existing.has(id));
  return id;
}

// ─── What changed between two versions ─────────────────────────────

const short = (s, n = 80) => { const t = String(s || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };

/**
 * A plain-language list of changes from `before` to `after`:
 * [{ kind: 'added'|'removed'|'changed'|'moved', area, text }].
 */
export function diffDefinitions(before, after) {
  const out = [];
  const add = (kind, area, text) => out.push({ kind, area, text });
  const a = before || { pages: [] };
  const b = after || { pages: [] };
  const fieldsOf = (d) => new Map(d.pages.flatMap((p, pi) => p.fields.map((f, fi) => [f.id, { f, page: p.id, pageTitle: p.title, pi, fi }])));
  const fa = fieldsOf(a);
  const fb = fieldsOf(b);
  const pa = new Map(a.pages.map((p, i) => [p.id, { p, i }]));
  const pb = new Map(b.pages.map((p, i) => [p.id, { p, i }]));
  const name = (f) => short(f.label || f.title || f.alt || f.html || FIELD_TYPES[f.type] || f.id, 70);

  for (const [id, { p }] of pb) if (!pa.has(id)) add('added', 'Pages', `New page "${short(p.title)}"`);
  for (const [id, { p }] of pa) if (!pb.has(id)) add('removed', 'Pages', `Removed page "${short(p.title)}"`);
  for (const [id, { p, i }] of pb) {
    const old = pa.get(id);
    if (!old) continue;
    if (old.p.title !== p.title) add('changed', 'Pages', `Page renamed "${short(old.p.title)}" → "${short(p.title)}"`);
    if (JSON.stringify(old.p.showIf || null) !== JSON.stringify(p.showIf || null)) add('changed', 'Pages', `"${short(p.title)}": ${p.showIf ? 'now shows only for some answers' : 'now always shows'}`);
  }
  const order = (d) => d.pages.map(p => p.id).filter(id => pa.has(id) && pb.has(id)).join(',');
  if (order(a) !== order(b)) add('moved', 'Pages', 'Pages were reordered');

  for (const [id, { f, pageTitle }] of fb) if (!fa.has(id)) add('added', 'Questions', `New ${FIELD_TYPES[f.type]?.toLowerCase() || 'item'} on "${short(pageTitle, 40)}": "${name(f)}"`);
  for (const [id, { f }] of fa) if (!fb.has(id)) add('removed', 'Questions', `Removed "${name(f)}"`);
  for (const [id, now] of fb) {
    const was = fa.get(id);
    if (!was) continue;
    const f0 = was.f;
    const f1 = now.f;
    const nm = name(f1);
    if (was.page !== now.page) add('moved', 'Questions', `"${nm}" moved to "${short(now.pageTitle, 40)}"`);
    if ((f0.label || '') !== (f1.label || '')) add('changed', 'Questions', `Reworded: "${short(f0.label)}" → "${short(f1.label)}"`);
    if ((f0.help || '') !== (f1.help || '')) add('changed', 'Questions', `"${nm}": help text ${f1.help ? 'changed' : 'removed'}`);
    if ((f0.html || '') !== (f1.html || '')) add('changed', 'Questions', `Text block changed: "${short(f1.html, 60)}"`);
    if (f0.type !== f1.type) add('changed', 'Questions', `"${nm}" is now ${FIELD_TYPES[f1.type]}`);
    if (!!f0.required !== !!f1.required) add('changed', 'Questions', `"${nm}" is now ${f1.required ? 'required' : 'optional'}`);
    if (JSON.stringify(f0.showIf || null) !== JSON.stringify(f1.showIf || null)) add('changed', 'Rules', `"${nm}": ${f1.showIf ? '"show only when" changed' : 'now always shows'}`);
    if (JSON.stringify(f0.stops || null) !== JSON.stringify(f1.stops || null)) add('changed', 'Rules', `"${nm}": which answers end the application changed`);
    if (JSON.stringify(f0.rules || null) !== JSON.stringify(f1.rules || null)) add('changed', 'Rules', `"${nm}": answer rules changed`);
    if (JSON.stringify(f0.jobtread || null) !== JSON.stringify(f1.jobtread || null)) add('changed', 'JobTread', f1.jobtread ? `"${nm}" now fills JobTread's "${f1.jobtread.name}"` : `"${nm}" no longer fills a JobTread field`);
    if ((f0.max || 0) !== (f1.max || 0)) add('changed', 'Questions', `"${nm}": choose up to ${f1.max || 'any number'}`);
    const c0 = (f0.options || []).map(choice);
    const c1 = (f1.options || []).map(choice);
    const v0 = new Map(c0.map(c => [c.value, c]));
    const v1 = new Map(c1.map(c => [c.value, c]));
    for (const c of c1) if (!v0.has(c.value)) add('added', 'Choices', `"${nm}": new choice "${short(c.label, 50)}"`);
    for (const c of c0) if (!v1.has(c.value)) add('removed', 'Choices', `"${nm}": removed choice "${short(c.label, 50)}"`);
    for (const c of c1) {
      const o = v0.get(c.value);
      if (o && o.label !== c.label) add('changed', 'Choices', `"${nm}": "${short(o.label, 40)}" → "${short(c.label, 40)}"`);
      if (o && o.description !== c.description) add('changed', 'Choices', `"${nm}": description of "${short(c.label, 40)}" changed`);
    }
    if (c0.length && c1.length && c0.map(c => c.value).filter(v => v1.has(v)).join('|') !== c1.map(c => c.value).filter(v => v0.has(v)).join('|')) add('moved', 'Choices', `"${nm}": choices reordered`);
    if (JSON.stringify([f0.title, f0.doTitle, f0.doItems, f0.dontTitle, f0.dontItems]) !== JSON.stringify([f1.title, f1.doTitle, f1.doItems, f1.dontTitle, f1.dontItems]) && f1.type === 'guidelines') add('changed', 'Questions', 'The guidelines lists changed');
    if ((f0.image || '') !== (f1.image || '') || (f0.alt || '') !== (f1.alt || '')) if (f1.type === 'image') add('changed', 'Questions', 'An image changed');
  }
  const moved = [...fb.keys()].filter(id => fa.has(id) && fa.get(id).page === fb.get(id).page);
  const seq = (m) => moved.slice().sort((x, y) => (m.get(x).pi - m.get(y).pi) || (m.get(x).fi - m.get(y).fi)).join(',');
  if (seq(fa) !== seq(fb)) add('moved', 'Questions', 'Questions were reordered');

  const sa = a.stops || {};
  const sb = b.stops || {};
  for (const k of Object.keys(sb)) if (!sa[k]) add('added', 'Stop screens', `New stop screen "${short(sb[k].title)}"`);
  for (const k of Object.keys(sa)) if (!sb[k]) add('removed', 'Stop screens', `Removed stop screen "${short(sa[k].title)}"`);
  for (const k of Object.keys(sb)) if (sa[k] && JSON.stringify(sa[k]) !== JSON.stringify(sb[k])) add('changed', 'Stop screens', `Stop screen "${short(sb[k].title)}" changed`);

  const ma = { ...defaultMessagesFor(a), ...(a.messages || {}) };
  const mb = { ...defaultMessagesFor(b), ...(b.messages || {}) };
  const MSG_NAMES = { welcome: 'Application Status', copyNote: 'the "copy attached" line', inReview: 'Application In Review', approved: 'Application Decision: approved', denied: 'Application Decision: denied', correction: 'Correction' };
  for (const k of MESSAGE_KEYS) if (ma[k] !== mb[k]) add('changed', 'Messages', `${MSG_NAMES[k]} message reworded`);
  const ra = { ...defaultRemindersFor(a), ...(a.reminders || {}) };
  const rb = { ...defaultRemindersFor(b), ...(b.reminders || {}) };
  if (ra.enabled !== rb.enabled) add('changed', 'Reminders', `Reminder emails turned ${rb.enabled ? 'on' : 'off'}`);
  if (JSON.stringify(ra.days) !== JSON.stringify(rb.days)) add('changed', 'Reminders', `Reminders now go ${(rb.days || []).join(', ')} days after a family stops`);
  if (ra.subject !== rb.subject || ra.body !== rb.body) add('changed', 'Reminders', 'Reminder email reworded');
  const na = notifySettings(a.notify);
  const nb = notifySettings(b.notify);
  for (const [k, name] of [['inReview', 'In Review'], ['decision', 'Approved and Denied'], ['welcome', 'Welcome']]) {
    if (na.waits[k] !== nb.waits[k]) add('changed', 'Email timing', `${name} emails now wait ${nb.waits[k]} minutes`);
  }
  if (na.quiet.start !== nb.quiet.start || na.quiet.end !== nb.quiet.end) add('changed', 'Email timing', nb.quiet.start === nb.quiet.end ? 'Quiet hours turned off' : `Quiet hours now ${nb.quiet.start}:00 to ${nb.quiet.end}:00 Eastern`);
  if (na.summary !== nb.summary) add('changed', 'Email timing', `Change summaries for staff turned ${nb.summary ? 'on' : 'off'}`);
  if (JSON.stringify(a.staffEmails || DEFAULT_STAFF_EMAILS) !== JSON.stringify(b.staffEmails || DEFAULT_STAFF_EMAILS)) add('changed', 'Settings', `New-application email goes to ${(b.staffEmails || []).join(', ') || 'nobody'}`);
  if (JSON.stringify(a.serviceArea?.polygon || DEFAULT_SERVICE_AREA.polygon) !== JSON.stringify(b.serviceArea?.polygon || DEFAULT_SERVICE_AREA.polygon)) add('changed', 'Settings', 'The service area boundary changed');
  const aa = areaRules(a.serviceArea);
  const ab = areaRules(b.serviceArea);
  if (aa.nearMiles !== ab.nearMiles) add('changed', 'Settings', `"Close to the area" is now ${ab.nearMiles ? `within ${ab.nearMiles} miles` : 'off'}`);
  if (aa.beyond !== ab.beyond) add('changed', 'Settings', ab.beyond === 'stop' ? 'Families far outside the area are now stopped' : 'Families far outside the area can now apply');
  const ta = a.i18n?.es?.strings || {};
  const tb = b.i18n?.es?.strings || {};
  const tChanged = [...new Set([...Object.keys(ta), ...Object.keys(tb)])].filter(p => ta[p] !== tb[p]).length;
  if (tChanged) add('changed', 'Spanish', `${tChanged} Spanish ${tChanged === 1 ? 'translation' : 'translations'} changed`);
  return out;
}

// ─── Using a resolved form ─────────────────────────────────────────

/** Every field, in form order, with its page id (and the page's own rule) */
export function allFields(form) {
  return form.pages.flatMap(p => p.fields.map(f => ({ ...f, page: p.id, ...(p.showIf ? { pageShowIf: p.showIf } : {}) })));
}

/** The earliest date a date question takes (the box's min too): earlier is a typo in the year */
export const DATE_MIN = '1990-01-01';
const INPUT_TYPES = new Set(['text', 'textarea', 'email', 'phone', 'number', 'date', 'select', 'radio', 'checkbox', 'name', 'address', 'ack', 'signature', 'area']);
const UPLOAD_TYPES = new Set(['photo', 'video']);

export function isInput(field) { return INPUT_TYPES.has(field.type); }
export function isUpload(field) { return UPLOAD_TYPES.has(field.type); }

/** Shown for these answers? Not when its page is skipped, or a question it depends on is hidden. */
export function isVisible(field, answers, byId, seen = new Set()) {
  if (seen.has(field.id)) return false; // a loop in the rules: treat as hidden
  if (!field.showIf && !field.pageShowIf) return true;
  const next = new Set(seen).add(field.id);
  if (field.pageShowIf && !ruleMatches(field.pageShowIf, answers, byId, next)) return false;
  return ruleMatches(field.showIf, answers, byId, next);
}

/** Is this page shown for these answers? */
export function pageVisible(page, answers, byId) {
  return !page.showIf || ruleMatches(page.showIf, answers, byId);
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

// Endings no address has, a key or two from .com / .net / .org ("gmail.con"): turned away, the "Did you mean" says the fix
export const TYPO_TLD = /\.(?:con|cmo|ocm|vom|xom|comm|coom|cpm|cim|nte|ent|nett|ogr|rog|orgg)$/i;
export function isEmailAddress(s) {
  const v = String(s || '').trim();
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) && !TYPO_TLD.test(v);
}

/** US numbers to E.164 (+1XXXXXXXXXX); international numbers kept when they start with + */
export function toE164(s) {
  const digits = String(s || '').replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return /^\+\d{8,15}$/.test(digits) ? digits : null;
  if (/^1\d{10}$/.test(digits)) return `+${digits}`;
  if (/^\d{10}$/.test(digits)) return `+1${digits}`;
  return null;
}

/** Whole years between a YYYY-MM-DD birthday and now */
export function ageOn(birthdate, now = Date.now()) {
  const m = String(birthdate || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const d = new Date(now);
  let age = d.getUTCFullYear() - Number(m[1]);
  if (d.getUTCMonth() + 1 < Number(m[2]) || (d.getUTCMonth() + 1 === Number(m[2]) && d.getUTCDate() < Number(m[3]))) age--;
  return age;
}

/** What families read when an answer needs attention, in English and Spanish */
export const ERROR_TEXT = {
  en: {
    video: 'Please upload your video.', videoBusy: 'Your video is still uploading. Please wait for it to finish.', photo: 'Please add a photo.',
    ack: 'Please check the box to continue.', choose: 'Please choose an answer.', signature: 'Please type your full name.', answer: 'Please answer this question.',
    area: 'Please enter the home address so we can check it, or choose an answer.',
    email: 'Please enter a valid email address, like name@example.com.', phone: 'Please enter a 10-digit phone number.',
    date: 'Please enter a valid date.', year: 'Please check the year.', future: 'Please enter a date in the past.', name: 'Please enter a first and last name.',
    address: 'Please enter the street address, city, state and ZIP code.', zip: 'Please enter a 5-digit ZIP code.', poBox: 'Please enter a street address, not a PO box.',
    oneOf: 'Please choose one of the answers.', listed: 'Please choose from the answers listed.', upTo: (n) => `Please choose up to ${n}.`,
    number: 'Please enter a number.', whole: 'Please enter a whole number.', min: (n) => `Please enter ${n} or more.`, max: (n) => `Please enter ${n} or less.`,
    minLength: (n) => `Please write at least ${n} characters.`, maxLength: (n) => `Please keep this to ${n} characters or fewer.`,
    minAge: (n) => `The child must be at least ${n} years old.`, maxAge: (n) => `The child must be ${n} years old or younger.`,
  },
  es: {
    video: 'Suba su video.', videoBusy: 'Su video todavía se está subiendo. Espere a que termine.', photo: 'Agregue una foto.',
    ack: 'Marque la casilla para continuar.', choose: 'Elija una respuesta.', signature: 'Escriba su nombre completo.', answer: 'Responda esta pregunta.',
    area: 'Escriba la dirección de la casa para que podamos revisarla, o elija una respuesta.',
    email: 'Escriba un correo electrónico válido, como nombre@ejemplo.com.', phone: 'Escriba un número de teléfono de 10 dígitos.',
    date: 'Escriba una fecha válida.', year: 'Revise el año.', future: 'Escriba una fecha en el pasado.', name: 'Escriba el nombre y el apellido.',
    address: 'Escriba la dirección, la ciudad, el estado y el código postal.', zip: 'Escriba un código postal de 5 dígitos.', poBox: 'Escriba una dirección con calle, no un apartado postal.',
    oneOf: 'Elija una de las respuestas.', listed: 'Elija entre las respuestas de la lista.', upTo: (n) => `Elija hasta ${n}.`,
    number: 'Escriba un número.', whole: 'Escriba un número entero.', min: (n) => `Escriba ${n} o más.`, max: (n) => `Escriba ${n} o menos.`,
    minLength: (n) => `Escriba al menos ${n} caracteres.`, maxLength: (n) => `Use ${n} caracteres o menos.`,
    minAge: (n) => `El niño o la niña debe tener al menos ${n} años.`, maxAge: (n) => `El niño o la niña debe tener ${n} años o menos.`,
  },
};

/**
 * The problem with one answer, or null. `value` for uploads is the draft's
 * file record ({ key } for photos, { uid, uploaded } for the video).
 */
export function fieldError(field, value, lang = 'en') {
  const E = ERROR_TEXT[lang] || ERROR_TEXT.en;
  const blank = isBlank(value);
  if (field.type === 'video') {
    if (field.required && !value?.uid) return E.video;
    if (value?.uid && !value.uploaded) return E.videoBusy;
    return null;
  }
  if (field.type === 'photo') return field.required && !value?.key ? E.photo : null;
  if (blank) {
    if (!field.required) return null;
    if (field.type === 'ack') return E.ack;
    if (field.type === 'area') return E.area;
    if (['radio', 'select', 'checkbox'].includes(field.type)) return E.choose;
    if (field.type === 'signature') return E.signature;
    return E.answer;
  }
  const r = field.rules || {};
  switch (field.type) {
    case 'email': return isEmailAddress(value) ? null : E.email;
    case 'phone': return toE164(value) ? null : E.phone;
    case 'number': {
      const n = Number(String(value).replace(/,/g, '').trim());
      if (!Number.isFinite(n)) return E.number;
      if (r.integer && !Number.isInteger(n)) return E.whole;
      if (r.min != null && n < r.min) return E.min(r.min);
      if (r.max != null && n > r.max) return E.max(r.max);
      return null;
    }
    case 'date': {
      const m = String(value).match(/^(\d{4})-(\d{2})-(\d{2})$/);
      const d = m ? new Date(`${value}T12:00:00Z`) : null;
      if (!d || Number.isNaN(d.getTime()) || d.getUTCDate() !== Number(m[3])) return E.date;
      if (value < DATE_MIN) return E.year; // a slip of the year ("0201"): the box's own earliest date
      if (d.getTime() > Date.now()) return E.future;
      const age = ageOn(value);
      if (r.minAge != null && age < r.minAge) return E.minAge(r.minAge);
      if (r.maxAge != null && age > r.maxAge) return E.maxAge(r.maxAge);
      return null;
    }
    case 'name': {
      if (field.required && (!String(value.first || '').trim() || !String(value.last || '').trim())) return E.name;
      return null;
    }
    case 'address': {
      const missing = ['line1', 'city', 'state', 'zip'].filter(k => !String(value[k] || '').trim());
      if (missing.length && (field.required || missing.length < 4)) return E.address;
      if (value.zip && !/^\d{5}(-\d{4})?$/.test(String(value.zip).trim())) return E.zip;
      // The home (the address the service area is checked on) is a place, not a mailbox
      if (field.id === 'address' && /\b(?:p\.?\s*o\.?\s*box|post\s+office\s+box)\b/i.test(`${value.line1 || ''} ${value.line2 || ''}`)) return E.poBox;
      return null;
    }
    case 'radio': case 'select': case 'ack': case 'area':
      return field.options.includes(value) ? null : E.oneOf;
    case 'checkbox': {
      if (!Array.isArray(value) || value.some(v => !field.options.includes(v))) return E.listed;
      if (field.max && value.length > field.max) return E.upTo(field.max);
      return null;
    }
    case 'text': case 'textarea': case 'signature': {
      const len = String(value).trim().length;
      if (r.minLength != null && len < r.minLength) return E.minLength(r.minLength);
      if (r.maxLength != null && len > r.maxLength) return E.maxLength(r.maxLength);
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
export function formErrors(form, answers, files = {}, pages = null, lang = 'en') {
  const byId = indexById(form);
  const errors = {};
  for (const f of allFields(form)) {
    if (pages && !pages.includes(f.page)) continue;
    if (!(isInput(f) || isUpload(f)) || !isVisible(f, answers, byId)) continue;
    const err = fieldError(f, isUpload(f) ? files?.[f.id] : answers?.[f.id], lang);
    if (err) errors[f.id] = err;
  }
  return errors;
}

/** The pages these answers show, in order */
export function visiblePages(form, answers) {
  const byId = indexById(form);
  return form.pages.filter(p => pageVisible(p, answers, byId));
}

/** How far along these answers are, 0 to 100 (required questions shown and answered) */
export function progressPercent(form, answers, files = {}) {
  const byId = indexById(form);
  const req = allFields(form).filter(f => f.required && (isInput(f) || isUpload(f)) && isVisible(f, answers, byId));
  if (!req.length) return 0;
  const done = req.filter(f => !fieldError(f, isUpload(f) ? files?.[f.id] : answers?.[f.id])).length;
  return Math.round((done / req.length) * 100);
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
export function dateText(v, lang = 'en') {
  const m = String(v || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return String(v || '');
  return new Date(`${v}T12:00:00Z`).toLocaleDateString(lang === 'es' ? 'es-US' : 'en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

/** A choice's wording (an answer is stored as the choice's value). `en` = staff wording */
export function optionLabel(field, value, en = false) {
  return (en ? field?.optionLabelsEn?.[value] : null) || field?.optionLabels?.[value] || String(value ?? '');
}

/** One answer as plain text, for the PDF, emails and JobTread. `en` reads choices in English for staff */
export function answerText(field, value, en = false) {
  if (value == null) return '';
  switch (field.type) {
    case 'name': return nameText(value);
    case 'signature': return String(value);
    case 'address': return addressText(value);
    case 'date': return dateText(value);
    case 'checkbox': return (value || []).map(v => optionLabel(field, v, en)).join(', ');
    case 'radio': case 'select': case 'ack': case 'area': return optionLabel(field, value, en);
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
 * [{ title, items: [{ id, type, label, labelEn?, text }] }]. Uploads appear
 * with `upload: true` and the file record. Skipped pages are left out.
 */
export function answerSections(form, answers, files = {}, { en = false } = {}) {
  const byId = indexById(form);
  const sections = [];
  for (const p of form.pages) {
    if (!pageVisible(p, answers, byId)) continue;
    const items = [];
    for (const f of p.fields) {
      if (!isVisible({ ...f, ...(p.showIf ? { pageShowIf: p.showIf } : {}) }, answers, byId)) continue;
      const labels = { label: f.label, ...(f.labelEn ? { labelEn: f.labelEn } : {}) };
      if (isUpload(f)) {
        if (files?.[f.id]) items.push({ id: f.id, type: f.type, ...labels, upload: true, file: files[f.id] });
        continue;
      }
      if (!isInput(f)) continue;
      const text = answerText(f, answers?.[f.id], en);
      if (text) items.push({ id: f.id, type: f.type, ...labels, text });
    }
    if (items.length) sections.push({ id: p.id, title: p.title, items });
  }
  return sections;
}
