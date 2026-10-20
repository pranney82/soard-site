/**
 * Draft translations for the application (Admin → Applications → Spanish)
 * ===========================================================================
 * Fills in missing or out-of-date Spanish with Workers AI, a batch at a time.
 * Staff can change any of it afterwards; nothing here is final until they put
 * the form live. Placeholders ({year}, {parent}, {child}, {copyNote},
 * {percent}), HTML tags and *bold* markers must come back untouched, and
 * anything that doesn't is left out rather than saved broken.
 */

const MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const BATCH = 12;

const PROMPT = `You translate a children's charity's makeover application from English into Spanish for families in the United States (many from Mexico and Central America).
Write warm, plain, respectful Spanish using "usted". Say "su hijo o hija" for "your child" and "el niño o la niña" for "the child".
Keep these exactly as they are: anything in curly braces like {year} {parent} {child} {copyNote} {percent} {status}; HTML tags and their attributes; *asterisks* used for bold; the names "Sunshine on a Ranney Day", "SOARD", "JobTread", county and city names.
Reply with JSON only: an object with the same keys as the input and the Spanish as each value.`;

const tokens = (s) => [...String(s).matchAll(/\{[a-zA-Z]+\}|<\/?[a-z0-9]+[^>]*>|\*/g)].map(m => m[0].replace(/\s+/g, ' ')).sort().join('|');

/** { path: spanish } for the given { path: english }. Leaves out anything the model mangled. */
export async function translateStrings(env, strings, { lang = 'es' } = {}) {
  if (lang !== 'es') throw new Error('Only Spanish is set up');
  if (!env.AI) throw new Error('Workers AI isn’t bound to the site');
  const entries = Object.entries(strings).filter(([, v]) => String(v || '').trim());
  const out = {};
  const failed = [];
  for (let i = 0; i < entries.length; i += BATCH) {
    const batch = Object.fromEntries(entries.slice(i, i + BATCH));
    let parsed = null;
    for (let attempt = 0; attempt < 2 && !parsed; attempt++) {
      try {
        const res = await env.AI.run(MODEL, {
          messages: [{ role: 'system', content: PROMPT }, { role: 'user', content: JSON.stringify(batch) }],
          max_tokens: 4000,
          temperature: 0.2,
        });
        const text = typeof res === 'string' ? res : (res?.response ?? JSON.stringify(res));
        const m = String(text).match(/\{[\s\S]*\}/);
        parsed = m ? JSON.parse(m[0]) : null;
      } catch { parsed = null; }
    }
    for (const [path, en] of Object.entries(batch)) {
      const es = parsed?.[path];
      if (typeof es === 'string' && es.trim() && tokens(es) === tokens(en)) out[path] = es.trim();
      else failed.push(path);
    }
  }
  return { strings: out, failed };
}
