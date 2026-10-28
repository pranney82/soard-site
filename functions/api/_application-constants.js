/**
 * Values the family and organization applications share
 * ===========================================================================
 * Here so ./_application-form.js and ./_application-form-org.js can both
 * read them without importing each other (the family module re-exports them).
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
