/**
 * Values the family and organization applications share
 * ===========================================================================
 * Here so ./_application-form.js and ./_application-form-org.js can both
 * read them without importing each other (the family module re-exports them).
 * The Advisory Board's form (./_advisory-form.js) takes its web-address rule
 * from here too.
 */

export const YES_NO = ['Yes', 'No'];
export const COUNTIES = ['Cherokee', 'Cobb', 'DeKalb', 'Forsyth', 'Fulton', 'Gwinnett'];

/**
 * The Makeover Type that makes an account a community project, not a family's
 * makeover. An organization's application gets it, and staff can pick it on any
 * account; whichever way it got there, the account counts as a community project.
 */
export const COMMUNITY_PROJECT_TYPE = 'Community Project';
export const isCommunityProject = (types) => [].concat(types ?? []).includes(COMMUNITY_PROJECT_TYPE);
/** The same test in SQL, over the applicants mirror's `types` column (a JSON list) */
export const COMMUNITY_PROJECT_LIKE = `%"${COMMUNITY_PROJECT_TYPE}"%`;

/**
 * The service-area answers, by band. Stored as these values (the Jotform
 * wording, so every application ever made reads the same way); the family
 * sees each choice's label and description.
 */
export const AREA_VALUES = {
  inside: 'Yes, it is within the boundary.',
  near: 'No, but it is close to the boundary.',
  far: 'No, it is not within the boundary nor is it close.',
};

/** A web address as people type one ("soard.org", "www.example.org/about", with or without https://) */
const WEB_LABEL = '[\\p{L}\\p{N}](?:[\\p{L}\\p{N}-]*[\\p{L}\\p{N}])?'; // (a name in any letters: "bücher.de")
const WEB_END = '(?:\\p{L}{2,}|xn--[a-z0-9-]+)\\.?'; // the ending, and a period after it ("ourschool.org.") still the address
const WEB_WHOLE = new RegExp(`^(?:https?:\\/\\/)?${WEB_LABEL}(?:\\.${WEB_LABEL})*\\.${WEB_END}(?::\\d{2,5})?(?:[/?#]\\S*)?$`, 'iu');
const WEB_NAMED = new RegExp(`^[^/?#:]+\\.${WEB_END}(?:[:/?#]|$)`, 'iu');
export const isWebAddress = (s) => {
  const v = String(s || '').trim();
  // ("www.example", the ending forgotten, isn't one: past "www." it still needs a name and an ending; an email
  // address, "jordan@example.com" or "mailto:…", isn't one either)
  return WEB_WHOLE.test(v) && WEB_NAMED.test(v.replace(/^https?:\/\//i, '').replace(/^www\./i, ''));
};
