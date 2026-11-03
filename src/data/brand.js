/**
 * SOARD's brand, in one place: the official logos (the files in public/SOARD-Logo-Kit.zip, unaltered, shown from
 * Cloudflare Images), the colors and the fonts. /branding/ draws them for press and partners, and the board page
 * (functions/api/_org-facts.js → Documents → SOARD's facts) for the board. Plain JS so both can import it.
 *
 * A logo downloads as a PNG (/api/download-logo?id=<download id>, from Cloudflare Images at 2048px). The kit's .svg
 * files hold the same PNG pictures inside an SVG, not drawings that scale, so they aren't offered on their own: a
 * logo drawn as vectors would have to come from SOARD's designer.
 */

export const KIT = { href: '/SOARD-Logo-Kit.zip', size: '2.6 MB' };

/** id: Cloudflare Images' display copy; download: its full-size copy (functions/api/download-logo.js); file: the kit's name for it */
export const LOGOS = [
  { key: 'lightTagline', group: 'primary', name: 'White background', sub: 'With the tagline, for light backgrounds', bg: 'light', id: 'brand-logo-light-bg-tagline-display', download: 'brand-logo-light-bg-tagline-download', file: 'logo-light-bg-tagline' },
  { key: 'darkTagline', group: 'primary', name: 'Dark background', sub: 'With the tagline, for dark backgrounds', bg: 'dark', id: 'brand-logo-dark-bg-tagline-display', download: 'brand-logo-dark-bg-tagline-download', file: 'logo-dark-bg-tagline' },
  { key: 'circleTagline', group: 'primary', name: 'Circle', sub: 'The circle logo with the tagline', bg: 'light', circle: true, id: 'brand-logo-circle-tagline-display', download: 'brand-logo-circle-tagline-download', file: 'logo-circle-tagline' },
  { key: 'light', group: 'alternate', name: 'White background', sub: 'Without the tagline, for light backgrounds', bg: 'light', id: 'brand-logo-light-bg-display', download: 'brand-logo-light-bg-download', file: 'logo-light-bg' },
  { key: 'dark', group: 'alternate', name: 'Dark background', sub: 'Without the tagline, for dark backgrounds', bg: 'dark', id: 'brand-logo-dark-bg-display', download: 'brand-logo-dark-bg-download', file: 'logo-dark-bg' },
  { key: 'circle', group: 'alternate', name: 'Circle', sub: 'The circle logo without the tagline', bg: 'light', circle: true, id: 'brand-logo-circle-display', download: 'brand-logo-circle-download', file: 'logo-circle' },
];
export const pngHref = (l) => `/api/download-logo?id=${l.download}`;

export const COLORS = [
  { name: 'Sunshine Yellow', use: 'CTAs, brand accents', hex: '#FFDA24', pms: 'PMS 116 C', rgb: '254, 217, 37', cmyk: '0, 6, 87, 0', core: true },
  { name: 'SOARD Dark', use: 'Primary text, headings', hex: '#373A36', pms: 'PMS 447 C', rgb: '55, 58, 54', cmyk: '50, 30, 40, 90', core: true },
  { name: 'White', use: 'Backgrounds, logo element', hex: '#FFFFFF', rgb: '255, 255, 255', cmyk: '0, 0, 0, 0', core: true, light: true },
  { name: 'Dark Deep', use: 'Footer, dark sections', hex: '#1A1B1F', rgb: '26, 27, 31' },
  { name: 'Cream', use: 'Page backgrounds', hex: '#FEFCF5', rgb: '254, 252, 245', light: true },
  { name: 'Warm Gray', use: 'Section backgrounds, cards', hex: '#F5F4F0', rgb: '245, 244, 240', light: true },
];

/** The website's fonts, and the licensed ones for print (ask SOARD for access) */
export const FONTS = {
  web: [{ name: 'Libre Baskerville', use: 'Display and headlines' }, { name: 'Outfit', use: 'Body and buttons' }],
  print: [{ name: 'Rainer North 100', use: 'Primary display' }, { name: 'Brandon Grotesque Bold', use: 'Headlines and subheads' }, { name: 'DIN Neuzeit Grotesk', use: 'Body copy' }, { name: 'Montserrat', use: 'Alternate and digital fallback' }],
};
