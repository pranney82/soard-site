/**
 * The group's goal as a thermometer, the one drawing of it: advisors see it on
 * Fundraise, and staff and the group's lead see the same one on The goal.
 *
 * Flat brand fills and no movement: the level is simply where it is.
 * The size comes from the class passed in.
 */
import { h, htm } from '../vendor.js';

const html = htm.bind(h);
const money = (n) => `$${Math.round(Number(n) || 0).toLocaleString('en-US')}`;

const INK = '#2D2F2C';
const YELLOW = '#FFDA24';
const GLASS = '#FEFCF5';

// Where things sit in the drawing
const ZERO = 226; // The $0 mark, just above the bulb
const TOP = 30; // The goal's mark, just under the cap
const NECK = 250; // Where the liquid in the tube meets the bulb
const STEPS = 5; // Numbered marks up the side, with a small one between each

const markAt = (share) => ZERO - share * (ZERO - TOP);

/** How full it is, 0 to 1, and how to say it: never "100%" until the goal is truly met, never "0%" once a gift is in */
export function goalLevel(raised, goal) {
  const r = Math.max(0, Number(raised) || 0);
  const g = Math.max(0, Number(goal) || 0);
  if (!g) return { share: 0, said: 'No goal set' };
  const share = Math.min(1, r / g);
  const pct = Math.floor(share * 100);
  const part = r > 0 && pct < 1 ? 'Less than 1%' : `${pct}%`;
  return { share, said: `${part} of the ${money(g)} goal` };
}

export function Thermometer({ raised, goal, cls = '' }) {
  const { share, said } = goalLevel(raised, goal);
  const level = markAt(share);
  const g = Math.max(0, Number(goal) || 0);
  const marks = [];
  for (let i = 0; i <= STEPS * 2; i += 1) {
    const y = markAt(i / (STEPS * 2));
    const major = i % 2 === 0;
    marks.push(html`<line x1="66" x2=${major ? 80 : 73} y1=${y} y2=${y} stroke=${INK} stroke-width=${major ? 2 : 1.5} stroke-linecap="round" />`);
    if (major && g) {
      marks.push(html`<text x="86" y=${y + 5} font-size="15" font-weight=${i === STEPS * 2 ? 700 : 500} fill=${INK}>${money((g * i) / (STEPS * 2))}</text>`);
    }
  }
  return html`<svg class=${cls} viewBox="0 0 156 300" role="img" aria-label=${said}>
    <path d="M30 29a15 15 0 0 1 30 0V240.4A28 28 0 1 1 30 240.4Z" fill=${GLASS} />
    <rect class="thermo__level" x="36" y=${level} width="18" height=${NECK - level} rx="9" fill=${YELLOW} />
    <circle cx="45" cy="264" r="22" fill=${YELLOW} />
    <path d="M30 29a15 15 0 0 1 30 0V240.4A28 28 0 1 1 30 240.4Z" fill="none" stroke=${INK} stroke-width="3" />
    ${marks}
  </svg>`;
}
