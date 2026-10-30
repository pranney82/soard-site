/**
 * Words the trade-partner pages share in English and Spanish: the trades
 * (JobTread's "Trades" options, see functions/api/_vendors.js TRADES) and the
 * insurance minimums from Job Costs → Bills → Settings.
 */

export type Lang = 'en' | 'es';

export const TRADE_ES: Record<string, string> = {
  'General contracting': 'Contratista general',
  'Carpentry and framing': 'Carpintería y estructura',
  Drywall: 'Tablaroca (drywall)',
  Electrical: 'Electricidad',
  Plumbing: 'Plomería',
  HVAC: 'Aire acondicionado y calefacción',
  Painting: 'Pintura',
  Flooring: 'Pisos',
  Tile: 'Azulejo',
  'Cabinets and countertops': 'Gabinetes y cubiertas',
  'Windows and doors': 'Ventanas y puertas',
  Roofing: 'Techos',
  'Concrete and masonry': 'Concreto y albañilería',
  'Accessibility and lifts': 'Accesibilidad y elevadores',
  Landscaping: 'Jardinería',
  Cleaning: 'Limpieza',
  'Hauling and dumpsters': 'Acarreo y contenedores',
  Design: 'Diseño',
  'Materials and supplies': 'Materiales y suministros',
  Other: 'Otro',
};

export const tradeLabel = (t: string, lang: Lang) => (lang === 'es' ? TRADE_ES[t] || t : t);

export const money = (n: number) => `$${Math.round(Number(n) || 0).toLocaleString('en-US')}`;

export interface Minimums { glOccurrence: number; glAggregate: number; workersComp: boolean; elEachAccident: number; renewDays?: number }

/** What a certificate needs to show, in the page's language */
export function requirementLines(m: Minimums, holder: string, lang: Lang): string[] {
  if (lang === 'es') {
    return [
      `Responsabilidad general: al menos ${money(m.glOccurrence)} por evento y ${money(m.glAggregate)} en total (aggregate)`,
      ...(m.workersComp ? [`Compensación al trabajador${m.elEachAccident ? `, con responsabilidad del empleador de al menos ${money(m.elEachAccident)} por accidente` : ''}`] : []),
      `Pólizas vigentes hoy, con ${holder} como titular del certificado (certificate holder)`,
    ];
  }
  return [
    `General liability: at least ${money(m.glOccurrence)} each occurrence and ${money(m.glAggregate)} aggregate`,
    ...(m.workersComp ? [`Workers’ compensation${m.elEachAccident ? `, with employer’s liability of at least ${money(m.elEachAccident)} each accident` : ''}`] : []),
    `Policies in force today, with ${holder} as certificate holder`,
  ];
}

/** The language a visitor picked before, or their browser's */
export function startLang(): Lang {
  try {
    const saved = localStorage.getItem('soard-tp-lang');
    if (saved === 'es' || saved === 'en') return saved;
  } catch { /* private mode */ }
  return /^es\b/i.test(navigator.language || '') ? 'es' : 'en';
}
export function keepLang(lang: Lang) {
  try { localStorage.setItem('soard-tp-lang', lang); } catch { /* private mode */ }
}
