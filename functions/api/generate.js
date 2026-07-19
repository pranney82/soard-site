/**
 * POST /api/generate
 * Uses Cloudflare Workers AI to generate content for kid profiles.
 * No external API key needed — uses the AI binding.
 *
 * Expects JSON body:
 *   {
 *     type: "alt-text" | "seo" | "all",
 *     kid: { name, age, diagnosis, roomTypes, bio, photos: [{ url }], ... }
 *   }
 *
 * Models used:
 *   - Vision (alt text): @cf/meta/llama-3.2-11b-vision-instruct, with
 *     @cf/llava-hf/llava-1.5-7b-hf as fallback
 *   - Text (SEO): @cf/google/gemma-7b-it
 */

const VISION_MODEL = '@cf/meta/llama-3.2-11b-vision-instruct';
const VISION_FALLBACK = '@cf/llava-hf/llava-1.5-7b-hf';

/** Downscaled imagedelivery.net variant for captioning — full-res isn't
 *  needed for alt text. Returns null for any non-imagedelivery URL. */
function captionVariant(rawUrl) {
  try {
    const u = new URL(rawUrl);
    if (u.hostname !== 'imagedelivery.net') return null;
    const parts = u.pathname.split('/');
    parts[parts.length - 1] = 'w=800,q=80';
    u.pathname = parts.join('/');
    return u.toString();
  } catch {
    return null;
  }
}

function altPrompt(kid) {
  return `Write alt text for a photo on the website of Sunshine on a Ranney Day, a nonprofit that builds dream bedrooms, accessible bathrooms, and therapy rooms for children with special needs — at no cost to families.

The child in this photo is ${kid.name}${kid.diagnosis ? `, who has ${kid.diagnosis}` : ''}.

Rules:
- One sentence, under 125 characters.
- Describe what is actually visible: people, expressions, actions, room features, colors, furniture.
- If mobility or medical equipment is visible, mention it plainly and matter-of-factly (e.g. "in his wheelchair") — never with pity language.
- Do not guess at diagnoses, emotions, or context beyond what the image shows.
- Do not start with "Image of", "Photo of", or "A picture of".
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

            text = text.replace(/^["']|["']$/g, '');
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

    // ─── Generate SEO Fields with Text Model ───
    if (type === 'seo' || type === 'all') {
      const seoPrompt = `You are writing SEO content for Sunshine on a Ranney Day (SOARD), a nonprofit that creates dream bedrooms and accessible spaces for children with special needs in Atlanta, GA.

Child: ${kid.name}
Age: ${kid.age || 'unknown'}
Diagnosis: ${kid.diagnosis || 'not specified'}
Room types: ${(kid.roomTypes || []).join(', ') || 'not specified'}
Bio: ${(kid.bio || '').slice(0, 800)}

Write exactly two things:

1. SHORT_DESCRIPTION: A warm 1-2 sentence summary (50-80 words) of this child's story for a card preview. Focus on who the child is and what SOARD is doing for them.

2. META_DESCRIPTION: An SEO meta description (120-155 characters) including the child's name and "Sunshine on a Ranney Day" or "SOARD".

Return in this exact format, nothing else:
SHORT_DESCRIPTION: [text]
META_DESCRIPTION: [text]`;

      const seoResult = await ai.run(
        '@cf/google/gemma-7b-it',
        {
          messages: [
            { role: 'user', content: seoPrompt },
          ],
          max_tokens: 500,
        }
      );

      const seoText = seoResult?.response || '';

      const shortMatch = seoText.match(/SHORT_DESCRIPTION:\s*(.+?)(?=META_DESCRIPTION:|$)/s);
      const metaMatch = seoText.match(/META_DESCRIPTION:\s*(.+?)$/s);

      results.shortDescription = shortMatch ? shortMatch[1].trim() : '';
      results.metaDescription = metaMatch ? metaMatch[1].trim() : '';
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
