/**
 * The application season's year, on its own so the pages that only need the
 * year (the application bar on every page about SOARD, ../_apply-bar.js) don't
 * load the whole application backend (./_applications.js re-exports it).
 */

/** A season year the form may be filled for: this year through two years out */
export function cleanYear(y, now = Date.now()) {
  const n = Number(String(y || '').trim());
  const thisYear = new Date(now).getUTCFullYear();
  return Number.isInteger(n) && n >= thisYear - 1 && n <= thisYear + 2 ? String(n) : String(thisYear + 1);
}
