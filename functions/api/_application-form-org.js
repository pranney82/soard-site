/**
 * The organization application, as data
 * ===========================================================================
 * Schools, therapy clinics and nonprofits that serve children with special
 * needs apply for a community project here, at /apply/community-project/, and the
 * application flows the way a family's does (./_application-form.js): its
 * own versions in Admin → Applications → Form (Organizations), a JobTread
 * account named after the organization with its contacts, address, space
 * photos and a PDF copy, the Applicants board, status emails worded for an
 * organization, and on approval its job and a Community project draft
 * (./_applicant-approved.js).
 *
 * The definition has the family form's shape (pages, stops, messages,
 * reminders) plus kind: 'organization'. Messages say {contact} (the people
 * it goes to) and {organization} (its name). English only.
 */

import { YES_NO, COUNTIES, AREA_VALUES } from './_application-constants.js';

/** The spaces an organization can ask about; the first ones match JobTread's Makeover Type */
export const ORG_SPACE_TYPES = ['Sensory room', 'Therapy room', 'Bathroom', 'Classroom or learning space', 'Common area or gathering space', 'Outdoor or playground space', 'Something else'];

/** Questions the site reads by id (see LOCKED_FIELDS in ./_application-form.js) */
export const ORG_LOCKED_FIELDS = {
  orgName: { role: 'Names the JobTread account and the community project', types: ['text'], required: true },
  address: { role: 'JobTread: the organization’s address', types: ['address'], required: true },
  boundary: { role: 'The service-area check (Settings → Service area)', types: ['area'], values: Object.values(AREA_VALUES), allValues: true, required: true },
  county: { role: 'JobTread: County', types: ['select', 'radio', 'text'] },
  referredBy: { role: 'JobTread: Referred By', types: ['text', 'textarea', 'select', 'radio'] },
  spaceTypes: { role: 'JobTread: Makeover Type', types: ['checkbox'], values: ORG_SPACE_TYPES },
  contactName: { role: 'JobTread: main contact', types: ['name'], required: true },
  contactEmail: { role: 'Main contact email; status emails go here', types: ['email'], required: true },
  contactPhone: { role: 'JobTread: main contact phone', types: ['phone'] },
  contactTitle: { role: 'JobTread: main contact title', types: ['text', 'select', 'radio'] },
  contact2Name: { role: 'JobTread: second contact', types: ['name'] },
  contact2Email: { role: 'JobTread: second contact email', types: ['email'] },
  contact2Phone: { role: 'JobTread: second contact phone', types: ['phone'] },
  contact2Title: { role: 'JobTread: second contact title', types: ['text', 'select', 'radio'] },
  photoSpace1: { role: 'Attached in JobTread', types: ['photo'] },
  photoSpace2: { role: 'Attached in JobTread', types: ['photo'] },
  photoSpace3: { role: 'Attached in JobTread', types: ['photo'] },
};

/** The status messages (JobTread comments). {contact} {organization}; {copyNote} marks where the "copy attached" line goes */
export const ORG_DEFAULT_MESSAGES = {
  welcome: `{contact}

Thank you for applying on behalf of *{organization}*. Your application is under review.{copyNote}

Our team reviews each organization's application to see how we can best help the children you serve. If your application moves forward, we will reach out to schedule a visit to see the space in person.

If we are unable to take on a project at this time, we will let you know.

Thank you for the work you do for children with special needs. If you have any questions in the meantime, just reply to this message.`,
  copyNote: 'A copy of your application is attached to this message for your records.',
  inReview: `{contact}

Good news: the application for *{organization}* has moved to the next stage, a visit to see the space in person.

At the visit, our team will tour the space, talk with you about what the children need, and answer your questions. After the visit and an internal review, you will receive our final decision.`,
  approved: `{contact}

We are excited to tell you that the application for *{organization}* has been approved!

Your project is now on our list of upcoming community projects. Our team will be in touch with next steps.`,
  denied: `{contact}

Thank you for applying on behalf of *{organization}*. After careful consideration, we are unable to take on this project.

This decision was made after a careful review, taking into account the feasibility of the project, our current resources, and the needs of the space.

We know this may not be the news you were hoping for, and we are grateful for the work you do for children with special needs.`,
  correction: `{contact}

Please disregard our last message about the application for *{organization}*. It was sent by mistake, and we're sorry for the confusion.

{status}

If you have any questions, just reply to this message.`,
};

/** Reminder emails to organizations that started and stopped ({contact} {organization} {percent} {year}) */
export const ORG_DEFAULT_REMINDERS = {
  enabled: true,
  days: [2, 7, 21],
  subject: 'Your SOARD application is waiting for you',
  body: `Hi {contact},

You started a {year} community project application for {organization} with Sunshine on a Ranney Day, and your answers are saved. You're about {percent}% done. Whenever you're ready, you can pick up right where you left off.

If you have questions or need help with any part of it, just reply to this email.`,
};

/** Version 0 of the organization form */
export const ORG_DEFAULT_DEFINITION = {
  schema: 2,
  kind: 'organization',
  title: 'Sunshine on a Ranney Day {year} Community Project Application',
  pages: [
    {
      id: 'welcome',
      title: 'Before You Begin',
      fields: [
        {
          id: 'introText', type: 'content',
          html: `<p><strong>Thank you for thinking of Sunshine on a Ranney Day for your organization.</strong></p>
<p>Alongside our makeovers for families, we partner with schools, therapy clinics and nonprofits that serve children with special needs, and transform the spaces where those children learn, heal and play.</p>
<p>This application helps us understand who you serve and the space you hope to transform. We'll ask you to:</p>
<ul>
<li>Tell us about your organization and the children you serve.</li>
<li>Describe the space and what would change for the children if it were transformed.</li>
<li>Upload a few photos of the space as it is today.</li>
</ul>
<p>Your answers save as you go, and you can tap "Save and finish later" at the bottom of any page. You'll receive a link to return to your application whenever you're ready.</p>`,
        },
        {
          id: 'ackParameters', type: 'ack', required: true,
          label: 'I understand that a community project transforms an existing, finished space at our organization, and that applying does not guarantee a project.',
          options: ['Yes, I understand.'],
        },
        {
          id: 'ackSeason', type: 'ack', required: true,
          label: 'I understand that this application is for the {year} project season.',
          options: ['Yes, I have read and understand the above statement.'],
        },
      ],
    },
    {
      id: 'service-area',
      title: 'Location',
      fields: [
        {
          id: 'serviceAreaText', type: 'content',
          html: `<p>Our community projects are for organizations <strong>inside</strong> our service area, shown on the map. Enter the address of the space you'd like transformed, and we'll check it for you.</p>`,
        },
        { id: 'address', type: 'address', required: true, label: 'Address of the space (where the project would happen)' },
        {
          id: 'boundary', type: 'area', required: true,
          label: 'Is your organization inside the service area shown on the map?',
          options: [
            { value: AREA_VALUES.inside, label: 'Yes, it is inside the service area.', description: 'Good news: this address is inside our service area.' },
            { value: AREA_VALUES.near, label: 'No, but it is close to it.', description: 'This address is about {miles} miles outside our service area. You can still apply, and our team will review it.' },
            { value: AREA_VALUES.far, label: 'No, it is not inside it or close to it.', description: 'This address is about {miles} miles outside our service area. We only take on projects inside it, so we likely can’t help this time. You’re still welcome to send your application.' },
          ],
        },
        { id: 'county', type: 'select', required: true, label: 'What county is it in?', options: COUNTIES },
      ],
    },
    {
      id: 'organization',
      title: 'Your Organization',
      fields: [
        { id: 'orgName', type: 'text', required: true, label: 'Organization name' },
        {
          id: 'orgType', type: 'radio', required: true, label: 'What kind of organization is it?',
          options: ['School', 'Therapy clinic or practice', 'Hospital or medical program', 'Nonprofit organization', 'Camp', 'Something else'],
        },
        { id: 'orgTypeOther', type: 'text', label: 'What kind of organization?', showIf: { field: 'orgType', in: ['Something else'] } },
        {
          id: 'orgStatus', type: 'radio', required: true, label: 'Is your organization a nonprofit or a public school?',
          options: ['Yes, a 501(c)(3) nonprofit', 'Yes, a public school', 'No'],
        },
        { id: 'website', type: 'text', label: 'Website' },
        { id: 'mission', type: 'textarea', required: true, label: 'Tell us about your organization: your mission and the work you do.' },
        { id: 'childrenServed', type: 'number', required: true, label: 'About how many children with special needs do you serve each year?', rules: { min: 0, integer: true } },
        { id: 'agesServed', type: 'text', required: true, label: 'What ages are the children you serve?' },
        { id: 'needsServed', type: 'textarea', required: true, label: 'Tell us about the children you serve: their diagnoses and needs.' },
        { id: 'previouslyApplied', type: 'radio', required: true, options: YES_NO, label: 'Has your organization worked with or applied to Sunshine on a Ranney Day before?' },
        { id: 'referredBy', type: 'text', label: 'Who referred you to Sunshine on a Ranney Day?' },
      ],
    },
    {
      id: 'contact',
      title: 'Contact',
      fields: [
        { id: 'contactName', type: 'name', required: true, label: 'Your name (main point of contact for all communication)' },
        { id: 'contactTitle', type: 'text', required: true, label: 'Your title or role' },
        { id: 'contactEmail', type: 'email', required: true, label: 'Your email address' },
        { id: 'contactPhone', type: 'phone', required: true, label: 'Your phone number' },
        { id: 'contact2Name', type: 'name', label: 'Another contact at your organization' },
        { id: 'contact2Title', type: 'text', label: 'Their title or role' },
        { id: 'contact2Email', type: 'email', label: 'Their email address' },
        { id: 'contact2Phone', type: 'phone', label: 'Their phone number' },
        {
          id: 'building', type: 'radio', required: true, label: 'Does your organization own the building, or lease it?',
          options: ['We own it', 'We lease it', 'A school district or another public body owns it'],
        },
        {
          id: 'ownerApproval', type: 'radio', label: 'Would the property owner approve a renovation of the space?',
          options: ['Yes', 'No', "I'm not sure"], showIf: { field: 'building', in: ['We lease it', 'A school district or another public body owns it'] },
        },
        {
          id: 'approver', type: 'radio', required: true, label: 'Can you approve a renovation of this space yourself?',
          options: ['Yes, I can approve it', 'No, someone else at our organization approves it'],
        },
        { id: 'approverName', type: 'text', label: 'Who approves it? (name and title)', showIf: { field: 'approver', in: ['No, someone else at our organization approves it'] } },
      ],
    },
    {
      id: 'space',
      title: 'The Space',
      fields: [
        {
          id: 'spaceTypes', type: 'checkbox', required: true, max: 2,
          label: 'What kind of space would you like transformed? Choose up to two.',
          options: ORG_SPACE_TYPES,
        },
        { id: 'spaceOther', type: 'text', label: 'What kind of space?', showIf: { field: 'spaceTypes', in: ['Something else'] } },
        { id: 'spaceToday', type: 'textarea', required: true, label: "Tell us about the space today: how it's used, about how big it is, and what isn't working for the children." },
        { id: 'spaceDream', type: 'textarea', required: true, label: 'If the space were transformed, what would change for the children who use it?' },
        { id: 'childrenUsing', type: 'number', required: true, label: 'About how many children would use the space each week?', rules: { min: 0, integer: true } },
        { id: 'photoSpace1', type: 'photo', required: true, label: 'Please upload a picture of the space' },
        { id: 'photoSpace2', type: 'photo', required: true, label: 'Please upload a second picture of the space' },
        { id: 'photoSpace3', type: 'photo', label: 'Another picture of the space (optional)' },
        { id: 'timing', type: 'textarea', label: 'Is there anything about timing or access we should know? For example, school breaks, building rules, or when the space is in use.' },
      ],
    },
    {
      id: 'finish',
      title: 'Certification',
      fields: [
        { id: 'anythingElse', type: 'textarea', label: 'Is there anything else you would like us to know?' },
        {
          id: 'signature', type: 'signature', required: true,
          label: 'By typing my name below, I certify that the information in this application is true, accurate and complete, and that I am authorized to apply on behalf of this organization.',
        },
      ],
    },
  ],
  stops: {
    // Shown to organizations far outside the area when Settings say to stop them (with the map and their pin)
    outside: {
      title: 'Thank you so much for your interest in Sunshine on a Ranney Day.',
      body: '<p>Our community projects are only for organizations inside our service area, and this address is outside it. Please check back in the future to see if our service area has grown.</p>',
    },
  },
  messages: ORG_DEFAULT_MESSAGES,
  reminders: ORG_DEFAULT_REMINDERS,
};
