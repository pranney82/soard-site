/**
 * POST /api/generate
 * Uses Cloudflare Workers AI to generate content for kid profiles.
 * No external API key needed — uses the AI binding.
 *
 * Expects JSON body:
 *   {
 *     type: "alt-text" | "seo" | "hero-summary" | "all",
 *     kid: { name, age, diagnosis, roomTypes, status, bio, photos: [{ url }], ... }
 *   }
 *
 * Models used:
 *   - Vision (alt text): @cf/meta/llama-3.2-11b-vision-instruct, with
 *     @cf/llava-hf/llava-1.5-7b-hf as fallback
 *   - Text (SEO, hero summary): @cf/meta/llama-3.3-70b-instruct-fp8-fast
 *     (gemma-7b-it, used before, was retired from Workers AI)
 *
 * Written copy follows the site's style: no em dashes, no stock phrases.
 */

const VISION_MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';
const VISION_FALLBACK = '@cf/llava-hf/llava-1.5-7b-hf';
const TEXT_MODEL = '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

// The site's copy rules, for everything written here
const STYLE = `Style: plain, warm and specific, like a person who knows the family. Use only facts from the details given; never invent names, dates or outcomes. No em dashes or en dashes (use commas or periods). No exclamation marks. Avoid stock phrases such as "journey", "testament", "heartwarming", "life-changing", "truly", "a space where", "not only ... but".`;

/** Plain text from the editor's HTML story */
const plainText = (html) => String(html || '').replace(/<\/p>\s*<p>/gi, '\n\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').trim();
/** Model output, tidied: no wrapping quotes, no dashes the style rules ban */
const tidy = (s) => String(s || '').trim().replace(/^["'“”]+|["'“”]+$/g, '').replace(/\s*[—–]\s*/g, ', ').replace(/\s+/g, ' ').trim();
const statusWords = (s) => (s === 'completed' ? 'SOARD built' : s === 'in-progress' ? 'SOARD is building' : 'SOARD is raising money to build');

async function runText(ai, prompt, maxTokens = 400) {
  const r = await ai.run(TEXT_MODEL, { messages: [{ role: 'user', content: prompt }], max_tokens: maxTokens });
  return typeof r?.response === 'string' ? r.response : JSON.stringify(r?.response ?? '');
}

const CF_HASH = 'ROYFuPmfN2vPS6mt5sCkZQ';

/** Downscaled imagedelivery.net variant for captioning (full-res isn't
 *  needed for alt text). Takes an imagedelivery.net URL, the site's own
 *  /cdn-cgi/imagedelivery/ proxy URL, or a bare image ID (some older photos
 *  are stored that way). Anything else returns null: only our own images
 *  are ever fetched. */
export function captionVariant(rawUrl) {
  const s = String(rawUrl || '').trim();
  if (/^[a-z0-9][\w\-./]*$/i.test(s) && !s.includes('..') && !s.includes('//')) {
    return `https://imagedelivery.net/${CF_HASH}/${s.replace(/\/(?:public|[^/]*=[^/]*)$/, '')}/w=800,q=80`;
  }
  try {
    const u = new URL(s);
    const proxy = u.pathname.match(/^\/cdn-cgi\/imagedelivery\/([^/]+)\/(.+)$/);
    if (u.protocol === 'https:' && u.hostname === 'sunshineonaranneyday.com' && proxy && proxy[1] === CF_HASH) {
      return `https://imagedelivery.net/${CF_HASH}/${proxy[2].replace(/\/(?:public|[^/]*=[^/]*)$/, '')}/w=800,q=80`;
    }
    if (u.hostname !== 'imagedelivery.net') return null;
    const parts = u.pathname.split('/');
    parts[parts.length - 1] = 'w=800,q=80';
    u.pathname = parts.join('/');
    return u.toString();
  } catch {
    return null;
  }
}

// Community projects: an organization's building, renovated by SOARD (kid.kind === 'community')
function projectAltPrompt(p) {
  return `Write alt text for a photo on the website of Sunshine on a Ranney Day, a nonprofit that renovates spaces for children with special needs. This photo is from its renovation project at ${p.name}${plainText(p.description) ? ` (${plainText(p.description).slice(0, 220)})` : ''}.

Rules:
- One sentence, under 125 characters.
- Describe what is actually visible: the room or space, its features, colors and furniture, and any people and what they are doing.
- Name the organization only if its name is visible in the photo.
- Do not guess at who people are, emotions, or context beyond what the image shows.
- Do not start with "Image of", "Photo of", or "A picture of".
- No em dashes.
- Return ONLY the alt text, nothing else.`;
}

function altPrompt(kid) {
  if (kid.kind === 'community') return projectAltPrompt(kid);
  return `Write alt text for a photo on the website of Sunshine on a Ranney Day, a nonprofit that builds dream bedrooms, accessible bathrooms, and therapy rooms for children with special needs — at no cost to families.

The child in this photo is ${kid.name}${kid.diagnosis ? `, who has ${kid.diagnosis}` : ''}.

Rules:
- One sentence, under 125 characters.
- Describe what is actually visible: people, expressions, actions, room features, colors, furniture.
- If mobility or medical equipment is visible, mention it plainly and matter-of-factly (e.g. "in his wheelchair") — never with pity language.
- Do not guess at diagnoses, emotions, or context beyond what the image shows.
- Do not start with "Image of", "Photo of", or "A picture of".
- No em dashes.
- Return ONLY the alt text, nothing else.`;
}

export async function onRequestPost(context) {
  try {
    const ai = context.env.AI;

    if (!ai) {
      return Response.json(
        { success: false, error: 'AI binding not configured. Add [ai] binding = "AI" to wrangler.toml.' },
        { status: 500 }
      );
    }

    const { type, kid } = await context.request.json();

    if (!type || !kid) {
      return Response.json(
        { success: false, error: 'Missing type or kid data' },
        { status: 400 }
      );
    }

    const results = {};

    // ─── Generate Alt Text with Vision Model ───
    if (type === 'alt-text' || type === 'all') {
      const photos = kid.photos || [];
      if (photos.length === 0) {
        results.altTexts = [];
      } else {
        const altTexts = [];
        // Process up to 20 photos
        const toProcess = photos.slice(0, 20);

        const prompt = altPrompt(kid);
        let visionModelOk = true; // flips off after a hard failure so we don't retry it per-photo

        for (const photo of toProcess) {
          try {
            // SSRF protection: only fetch from Cloudflare Images (also
            // swaps in a width-capped variant — full-res isn't needed)
            const fetchUrl = captionVariant(photo.url);
            if (!fetchUrl) {
              altTexts.push('');
              continue;
            }

            // Fetch the image and convert to base64
            const imgResponse = await fetch(fetchUrl);
            if (!imgResponse.ok) {
              altTexts.push('');
              continue;
            }

            // Base64-encode in 32KB chunks. Spreading a whole multi-MB image
            // into String.fromCharCode(...) can blow the call stack, so walk
            // the byte array with apply() over bounded subarrays instead.
            const imgBytes = new Uint8Array(await imgResponse.arrayBuffer());
            let binary = '';
            const CHUNK = 0x8000;
            for (let i = 0; i < imgBytes.length; i += CHUNK) {
              binary += String.fromCharCode.apply(null, imgBytes.subarray(i, i + CHUNK));
            }
            const base64 = btoa(binary);

            let text = '';

            // Primary: llama-3.2-11b-vision (much better captions than llava).
            // Documented input shape is top-level { prompt, image }.
            if (visionModelOk) {
              try {
                const visionResult = await ai.run(VISION_MODEL, {
                  prompt,
                  image: base64,
                  max_tokens: 120,
                });
                text = (visionResult?.response || '').trim();
              } catch (visionErr) {
                // Meta requires a one-time license acknowledgement per account;
                // send it once and retry if the model asks for it.
                if (/agree|license|acceptable use/i.test(visionErr.message || '')) {
                  try {
                    await ai.run(VISION_MODEL, { prompt: 'agree' });
                    const retry = await ai.run(VISION_MODEL, { prompt, image: base64, max_tokens: 120 });
                    text = (retry?.response || '').trim();
                  } catch {
                    visionModelOk = false;
                  }
                } else {
                  visionModelOk = false;
                }
              }
            }

            // Fallback: llava (the previous behavior)
            if (!text) {
              const llavaResult = await ai.run(VISION_FALLBACK, {
                messages: [
                  {
                    role: 'user',
                    content: [
                      { type: 'text', text: prompt },
                      { type: 'image', image: base64 },
                    ],
                  },
                ],
                max_tokens: 80,
              });
              text = (llavaResult?.response || '').trim();
            }

            text = tidy(text);
            if (text.length > 160) text = text.slice(0, 157).replace(/\s+\S*$/, '') + '…';
            altTexts.push(text);
          } catch (err) {
            console.error('Vision error for photo:', err.message);
            altTexts.push('');
          }
        }

        // Pad remaining photos with empty strings
        while (altTexts.length < photos.length) {
          altTexts.push('');
        }

        results.altTexts = altTexts;
      }
    }

    // ─── A community project's search description ───
    if (type === 'seo' && kid.kind === 'community') {
      const prompt = `You are writing the search description for one community project page on the website of Sunshine on a Ranney Day (SOARD), a nonprofit in Atlanta that renovates spaces for children with special needs: classrooms, therapy rooms, camps and nonprofit facilities.

Organization: ${kid.name}
Project year: ${kid.year || 'not given'}
Status: ${kid.status === 'in-progress' ? 'SOARD is renovating it now' : 'SOARD completed it'}
Impact: ${(kid.stats || []).map((x) => `${x.value} ${x.label}`).join('; ') || 'not given'}
Summary: ${plainText(kid.description).slice(0, 800)}
Story: ${plainText(kid.story).slice(0, 1800)}

Write META_DESCRIPTION: 120 to 155 characters for Google's search results. Name the organization and "Sunshine on a Ranney Day", and say what was renovated and who it serves.

${STYLE}

Return in this exact format, nothing else:
META_DESCRIPTION: [text]`;
      const text = await runText(ai, prompt, 200);
      const m = text.match(/META_DESCRIPTION:\s*(.+?)$/s);
      results.metaDescription = m ? tidy(m[1]) : tidy(text);
      if (!results.metaDescription) return Response.json({ success: false, error: 'The AI didn’t return usable text. Try again.' }, { status: 500 });
    }

    // ─── A community project's summary, from its story ───
    if (type === 'project-summary') {
      const story = plainText(kid.story);
      if (!story) return Response.json({ success: false, error: 'Write the story first; the summary comes from it.' }, { status: 400 });
      const prompt = `Write the summary of a community project for the website of Sunshine on a Ranney Day (SOARD), a nonprofit in Atlanta that renovates spaces for children with special needs. It is used when the project is shared or found in search.

Organization: ${kid.name}
Project year: ${kid.year || 'not given'}
Status: ${kid.status === 'in-progress' ? 'SOARD is renovating it now' : 'SOARD completed it'}
Story: ${story.slice(0, 2500)}

Rules:
- Two sentences, 300 characters or fewer in total.
- First sentence: who the organization serves, in plain words.
- Second sentence: what SOARD renovated for them, naming the main sponsor if the story names one.
- ${STYLE}
- Return only the two sentences.`;
      let text = tidy(await runText(ai, prompt, 220));
      if (text.length > 320) {
        const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
        text = sentences.map((x) => x.trim()).reduce((acc, x) => ((acc + ' ' + x).trim().length <= 320 ? (acc + ' ' + x).trim() : acc), '') || sentences[0].trim();
      }
      if (!text) return Response.json({ success: false, error: 'The AI didn’t return a summary. Try again.' }, { status: 500 });
      results.description = text;
    }

    // ─── Generate SEO Fields with Text Model ───
    if ((type === 'seo' && kid.kind !== 'community') || type === 'all') {
      const seoPrompt = `You are writing search and sharing text for one child's page on the website of Sunshine on a Ranney Day (SOARD), a nonprofit in Atlanta that builds dream bedrooms, accessible bathrooms and therapy rooms for children with special needs, at no cost to their families.

Child: ${kid.name}
Age: ${Array.isArray(kid.age) ? kid.age.join(' and ') : kid.age || 'unknown'}
Diagnosis: ${kid.diagnosis || 'not specified'}
What was built: ${(kid.roomTypes || []).join(', ') || 'not specified'} (${statusWords(kid.status)} it)
Story: ${plainText(kid.bio).slice(0, 1800)}

Write exactly two things:
1. SHORT_DESCRIPTION: one sentence, at most 150 characters, for a card on the home page. Who the child is and what ${statusWords(kid.status)} for them.
2. META_DESCRIPTION: 120 to 155 characters for Google's search results. Include the child's first name and "Sunshine on a Ranney Day".

${STYLE}

Return in this exact format, nothing else:
SHORT_DESCRIPTION: [text]
META_DESCRIPTION: [text]`;

      const seoText = await runText(ai, seoPrompt);
      const shortMatch = seoText.match(/SHORT_DESCRIPTION:\s*(.+?)(?=META_DESCRIPTION:|$)/s);
      const metaMatch = seoText.match(/META_DESCRIPTION:\s*(.+?)$/s);
      results.shortDescription = shortMatch ? tidy(shortMatch[1]) : '';
      results.metaDescription = metaMatch ? tidy(metaMatch[1]) : '';
      if (!results.shortDescription && !results.metaDescription) {
        return Response.json({ success: false, error: 'The AI didn’t return usable text. Try again.' }, { status: 500 });
      }
    }

    // ─── Hero summary: the line under the child's name at the top of the page ───
    if (type === 'hero-summary') {
      const story = plainText(kid.bio);
      if (!story) return Response.json({ success: false, error: 'Write the story first; the summary comes from it.' }, { status: 400 });
      const prompt = `Write the short introduction that appears under a child's name at the top of their page on the website of Sunshine on a Ranney Day (SOARD), a nonprofit in Atlanta that builds dream bedrooms, accessible bathrooms and therapy rooms for children with special needs.

Child: ${kid.name}
Diagnosis: ${kid.diagnosis || 'not specified'}
What was built: ${(kid.roomTypes || []).join(', ') || 'not specified'} (${statusWords(kid.status)} it)
Story: ${story.slice(0, 2500)}

Rules:
- Exactly two sentences, 200 characters or fewer in total.
- First sentence: who ${kid.name} is and what they live with, in plain words.
- Second sentence: what ${statusWords(kid.status)} for them, naming the main sponsor if the story names one.
- ${STYLE}
- Return only the two sentences.`;
      let text = tidy(await runText(ai, prompt, 200));
      // The page shows two sentences up to 220 characters; never hand back more
      if (text.length > 220) {
        const sentences = text.match(/[^.!?]+[.!?]+/g) || [text];
        text = sentences.map((x) => x.trim()).reduce((acc, x) => ((acc + ' ' + x).trim().length <= 220 ? (acc + ' ' + x).trim() : acc), '') || sentences[0].trim();
      }
      if (!text) return Response.json({ success: false, error: 'The AI didn’t return a summary. Try again.' }, { status: 500 });
      results.heroSummary = text;
    }

    return Response.json(
      { success: true, ...results },
      {}
    );
  } catch (err) {
    console.error("[generate]", err);
    return Response.json(
      { success: false, error: "An unexpected error occurred" },
      { status: 500 }
    );
  }
}
