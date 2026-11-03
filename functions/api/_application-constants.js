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
export const isWebAddress = (s) => {
  const v = String(s || '').trim();
  // ("www.example", the ending forgotten, isn't one: past "www." it still needs a name and an ending; an email
  // address, "jordan@example.com" or "mailto:…", isn't one either)
  return /^(?:https?:\/\/)?[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}(?::\d{2,5})?(?:[/?#]\S*)?$/i.test(v)
    && /^[^/?#:]+\.[a-z]{2,}(?:[:/?#]|$)/i.test(v.replace(/^https?:\/\//i, '').replace(/^www\./i, ''));
};
