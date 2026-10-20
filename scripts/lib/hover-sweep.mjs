/**
 * hover-sweep.mjs — does any control lose its label under the pointer?
 * ============================================================================
 * Hovers one example of every kind of control on screen (same tag, classes,
 * state attributes and parent: one kind) with the real mouse, so the control
 * and everything around it is :hover the way it is for a person, and measures
 * each line of text inside it against the colour actually behind it (WCAG
 * contrast, transparent fills composited down to the first solid one). A
 * finding is text that reads worse hovered than resting and falls under
 * 4.5:1 (3:1 for large text): the selected pill whose label went dark on dark.
 *
 * Phones count too: after a tap, :hover sticks to what was tapped.
 *
 *   const seen = new Set();   // one per run: each kind is checked once per width
 *   const found = await hoverSweep(page, seen);
 */

const CONTROLS = 'button, a[href], summary, [role="button"], [role="tab"], [role="radio"], [role="checkbox"], [role="switch"], [role="option"], [role="menuitem"], [role="menuitemradio"], label:has(input)';

export async function hoverSweep(page, seen = new Set()) {
  const width = page.viewport()?.width || 0;
  const picked = await page.evaluate((sel, width, seenList) => {
    const seenSet = new Set(seenList);
    const kindOf = (el) => {
      const own = (e) => e ? `${e.tagName.toLowerCase()}.${[...e.classList].sort().join('.')}` : '';
      const state = ['aria-pressed', 'aria-selected', 'aria-current', 'aria-checked', 'aria-expanded', 'data-state']
        .map((a) => el.hasAttribute(a) ? `[${a}=${el.getAttribute(a)}]` : '').join('');
      return `${width}|${own(el.parentElement)} > ${own(el)}${state}${el.getAttribute('style') ? `{${el.getAttribute('style')}}` : ''}`;
    };
    const out = [];
    document.querySelectorAll(sel).forEach((el) => {
      if (el.closest('[aria-hidden="true"], [inert]') || el.matches(':disabled, [aria-disabled="true"]')) return;
      const r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4 || getComputedStyle(el).visibility === 'hidden') return;
      if (!(el.innerText || '').trim()) return;
      const kind = kindOf(el);
      if (seenSet.has(kind)) return;
      seenSet.add(kind);
      el.setAttribute('data-hover-sweep', String(out.length));
      out.push({ kind, label: (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 40) });
    });
    return out;
  }, CONTROLS, width, [...seen]);
  if (!picked.length) return [];

  // Measure without transitions, so a reading is the settled colour, not a frame mid-fade
  const scroll = await page.evaluate(() => {
    const s = document.createElement('style');
    s.id = 'hover-sweep-still';
    s.textContent = '*, *::before, *::after { transition: none !important; animation-play-state: paused !important; }';
    document.head.append(s);
    return [...document.querySelectorAll('*')].filter((e) => e.scrollTop || e.scrollLeft).map((e) => [e, e.scrollTop, e.scrollLeft])
      .concat([[document.scrollingElement, document.scrollingElement.scrollTop, document.scrollingElement.scrollLeft]])
      .map(([e, t, l], i) => { e.setAttribute('data-hover-sweep-scroll', String(i)); return [i, t, l]; });
  });
  const measure = (i, at) => page.evaluate((i, at) => {
    const el = document.querySelector(`[data-hover-sweep="${i}"]`);
    if (!el) return null;
    const rgba = (c) => { const m = c.match(/[\d.]+/g)?.map(Number) || [0, 0, 0, 0]; return { r: m[0], g: m[1], b: m[2], a: m.length > 3 ? m[3] : 1 }; };
    const over = (top, under) => ({ r: top.r * top.a + under.r * (1 - top.a), g: top.g * top.a + under.g * (1 - top.a), b: top.b * top.a + under.b * (1 - top.a), a: 1 });
    const lum = ({ r, g, b }) => [r, g, b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; })
      .reduce((s, v, k) => s + v * [0.2126, 0.7152, 0.0722][k], 0);
    const ratio = (x, y) => { const [a, b] = [lum(x), lum(y)].sort((p, q) => q - p); return (a + 0.05) / (b + 0.05); };
    // The colour behind a node: its fills and its ancestors', top down until one is solid. Photos and gradients can't be read.
    const behind = (node) => {
      const layers = [];
      for (let e = node; e; e = e.parentElement) {
        const s = getComputedStyle(e);
        if (s.backgroundImage !== 'none') return null;
        const c = rgba(s.backgroundColor);
        if (c.a > 0) layers.push(c);
        if (c.a >= 1) break;
      }
      return layers.reduceRight((under, top) => over(top, under), { r: 255, g: 255, b: 255, a: 1 });
    };
    const lines = [];
    const walk = (e) => {
      const s = getComputedStyle(e);
      if (s.display === 'none' || s.visibility === 'hidden') return;
      const text = [...e.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('').trim();
      const r = e.getBoundingClientRect();
      if (text && r.width > 1 && r.height > 1 && parseFloat(s.fontSize) > 0) {
        const bg = behind(e);
        if (bg) {
          let opacity = 1;
          for (let p = e; p; p = p.parentElement) opacity *= parseFloat(getComputedStyle(p).opacity);
          const ink = over({ ...rgba(s.color), a: rgba(s.color).a * opacity }, bg);
          const size = parseFloat(s.fontSize), bold = parseInt(s.fontWeight, 10) >= 700;
          lines.push({ text: text.slice(0, 30), ratio: ratio(ink, bg), large: size >= 24 || (size >= 18.66 && bold),
            ink: `rgb(${[ink.r, ink.g, ink.b].map(Math.round)})`, bg: `rgb(${[bg.r, bg.g, bg.b].map(Math.round)})` });
        }
      }
      for (const c of e.children) walk(c);
    };
    walk(el);
    // matches(':hover') can say no while the hover styles apply, so ask what is under the pointer instead
    return { hovered: !!at && el.contains(document.elementFromPoint(at.x, at.y)), lines };
  }, i, at);

  const findings = [];
  try {
    await page.mouse.move(0, 0);
    const resting = [];
    for (let i = 0; i < picked.length; i++) resting.push(await measure(i));
    for (let i = 0; i < picked.length; i++) {
      seen.add(picked[i].kind);
      if (!resting[i]) continue;
      await page.evaluate((i) => document.querySelector(`[data-hover-sweep="${i}"]`)?.scrollIntoView({ block: 'center', inline: 'center' }), i);
      const box = await (await page.$(`[data-hover-sweep="${i}"]`))?.boundingBox();
      if (!box) continue;
      const at = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      await page.mouse.move(at.x, at.y);
      const hot = await measure(i, at);
      // Covered by something else (a sticky bar, a sheet): not this control's hover to judge
      if (!hot?.hovered) continue;
      hot.lines.forEach((line) => {
        const rest = resting[i].lines.find((r) => r.text === line.text);
        const floor = line.large ? 3 : 4.5;
        if (line.ratio < floor && (!rest || line.ratio < rest.ratio - 0.05)) {
          findings.push({ kind: picked[i].kind, label: picked[i].label, text: line.text, hover: +line.ratio.toFixed(2),
            resting: rest ? +rest.ratio.toFixed(2) : null, colors: `${line.ink} on ${line.bg}` });
        }
      });
    }
  } finally {
    await page.mouse.move(0, 0);
    await page.evaluate((scroll) => {
      document.getElementById('hover-sweep-still')?.remove();
      document.querySelectorAll('[data-hover-sweep]').forEach((e) => e.removeAttribute('data-hover-sweep'));
      for (const [i, t, l] of scroll) {
        const e = document.querySelector(`[data-hover-sweep-scroll="${i}"]`);
        if (e) { e.scrollTop = t; e.scrollLeft = l; e.removeAttribute('data-hover-sweep-scroll'); }
      }
    }, scroll).catch(() => {});
  }
  return findings;
}
