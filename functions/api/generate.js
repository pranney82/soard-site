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
 *   - Vision (alt text): @cf/meta/llama-4-scout-17b-16e-instruct
 *   - Text (SEO): @cf/meta/llama-4-scout-17b-16e-instruct
 */

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

        for (const photo of toProcess) {
          try {
            // Fetch the image and convert to base64
            const imgResponse = await fetch(photo.url);
            if (!imgResponse.ok) {
              altTexts.push('');
              continue;
            }

            const imgBuffer = await imgResponse.arrayBuffer();
            const imgArray = [...new Uint8Array(imgBuffer)];
            const base64 = btoa(String.fromCharCode(...imgArray));

            const visionResult = await ai.run(
              '@cf/meta/llama-4-scout-17b-16e-instruct',
              {
                messages: [
                  {
                    role: 'user',
                    content: [
                      {
                        type: 'text',
                        text: `Write a concise alt text description (10-25 words) for this photo from a nonprofit that builds dream bedrooms for children with special needs. The child's name is ${kid.name}${kid.diagnosis ? ', who has ' + kid.diagnosis : ''}. Do not start with "Image of" or "Photo of". Focus on what you see: people, expressions, room features, colors, furniture. Return ONLY the alt text, nothing else.`,
                      },
                      {
                        type: 'image',
                        image: base64,
                      },
                    ],
                  },
                ],
                max_tokens: 80,
              }
            );

            const text = (visionResult?.response || '').trim().replace(/^["']|["']$/g, '');
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
        '@cf/meta/llama-4-scout-17b-16e-instruct',
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
    return Response.json(
      { success: false, error: err.message },
      { status: 500 }
    );
  }
}
,
  });
}
