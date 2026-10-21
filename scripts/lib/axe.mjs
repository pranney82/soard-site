/**
 * An accessibility scan for the browser tests: axe-core (devDependency) run in
 * the page against WCAG 2.1 A and AA. Returns the violations, shortened:
 * [{ id, impact, n, where: [selector, …] }]. axeText() puts them in one line.
 */
import { readFileSync } from 'node:fs';

const AXE = readFileSync(new URL('../../node_modules/axe-core/axe.min.js', import.meta.url), 'utf8');

export async function axeScan(page, scope = 'body') {
  await page.evaluate(AXE);
  return page.evaluate(async (sel) => {
    const ctx = [...document.querySelectorAll(sel)];
    const r = await window.axe.run(ctx.length ? ctx : document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] }, resultTypes: ['violations'] });
    return r.violations.map(v => ({ id: v.id, impact: v.impact, n: v.nodes.length, where: v.nodes.slice(0, 2).map(n => n.target.join(' ').slice(0, 80)) }));
  }, scope);
}

export const axeText = (list) => list.map(v => `${v.id} ×${v.n} (${v.where.join(', ')})`).join('; ');
