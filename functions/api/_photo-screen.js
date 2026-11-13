/**
 * Is this before photo fine for the public page?
 * ===========================================================================
 * Peter, Nov 12 2026, of the before photos that come in from JobTread at the confirm: "you can review those photos
 * and leave off the ones you think arent good to publish? is there a way to keep a photo from publishing?" The Before
 * tag on a job holds everything taken on the home visit: the family in the room, their framed photos, a phone
 * screenshot of a design idea, shipping boxes, a tape measure in a hand, the electrical panel. Each photo is looked at
 * here, by Workers AI's vision model (the one that reads W-9s, ./_vendor-read.js), through the site's AI Gateway as
 * 'before-photos' (./_ai.js), before it can show anywhere public.
 *
 * As with the W-9s, the model only says what's in the photo, one plain question at a time; whether that keeps it off
 * the page is plain code below (judgePhoto), so a misread can't argue its way onto the page, and the reason staff see
 * is always one of ours, never the model's own words. It's asked to say yes when it isn't sure, and a question it
 * leaves out counts as yes: when in doubt, a photo stays off, and staff can put it on (Admin → Kids → Photos →
 * Before photos → On the page).
 *
 * Called by ./_reveal-design-auto.js for every before photo nobody has looked at yet. A photo the model couldn't
 * answer for comes back null (tried again later); a spending cap reached throws, so nothing is recorded against the
 * photo. Nothing is kept: the photo goes to the model and its answer to the caller, and the AI Gateway logs nothing
 * (./_ai.js).
 */

import { answerOf } from './_vendor-read.js';
import { viaGateway, aiCapped } from './_ai.js';

export const SCREEN_MODEL = '@cf/meta/llama-4-scout-17b-16e-instruct';
/** The photo as the model sees it: Cloudflare Images' own resize of the uploaded picture, big enough for small things */
export const SCREEN_SIZE = 'w=1280,h=1280,fit=scale-down,q=85,format=jpeg';
const SCREEN_TIMEOUT_MS = 12_000;

/**
 * Workers AI didn't answer at all (down, busy, too slow, not bound): no fault of the photo's, so nothing is counted.
 * wide: certainly not one photo's (no binding at all); otherwise it's taken as the service's once two photos hit it
 */
export class AiDown extends Error {
  constructor(message, { wide = false } = {}) { super(message); this.wide = wide; }
}
/**
 * Workers AI turned the picture away (Refused, with its words): the input refused, too big, an error on this one, or
 * any other refusal that isn't plainly the service being down or busy. The photo's, when Workers AI is answering other
 * photos; when it answers none (a model retired, the gateway changed), the site's own setup, and nothing is counted
 * (./_reveal-design-auto.js decides which)
 */
export class Refused extends Error {}
// Workers AI's own trouble: down, busy, overloaded, its upstream failing, the connection
const SERVICE_TROUBLE = /\b(5\d\d|429|408)\b|3040|capacity|upstream|unavailable|overload|rate.?limit|too many requests|timed? ?out|timeout|network|fetch failed|econn|socket|internal (server )?error|try again/i;
/** Why a photo the site tried and tried to look at, and couldn't, is kept off (staff can switch it on) */
export const UNCHECKED = 'Couldn’t be checked';

// The questions, in the order a reason is chosen. `anywhere`: even a small one, in the background or a mirror,
// keeps a photo off; the others are about what the photo is mostly of
export const QUESTIONS = [
  { key: 'person', why: 'A person in it', ask: 'Is a person, or any part of one (a face, a head, a hand, an arm, a leg, feet), anywhere in the photo, even small, at the edge, in the background, or in a mirror, window or reflection?' },
  { key: 'peoplePictures', why: 'Photos of people in it', ask: 'Is there a photo, portrait or picture of a real person anywhere in it: framed on a wall or shelf, on a fridge, or on a screen?' },
  { key: 'screen', why: 'A screen or screenshot', ask: 'Is this a screenshot, or a photo of a phone, tablet, computer or TV screen that is showing something?' },
  { key: 'private', why: 'Papers or a name or number', ask: 'Can you see mail, papers, documents, bills, medicine labels or a calendar with writing on them, or a last name, an address, a house or street number, a phone number or a license plate?' },
  { key: 'outside', why: 'Outside the house', ask: 'Was it taken outdoors, or does it mostly show the outside of a house, a yard, a driveway or a street?' },
  { key: 'boxes', why: 'Boxes or deliveries', ask: 'Is it mostly of packages, shipping boxes, deliveries, pallets or products still in their packaging, rather than of the room?' },
  { key: 'measuring', why: 'A tool or measuring', ask: 'Is it mostly a close-up of a tool or a tape measure, or of something being measured?' },
  { key: 'building', why: 'Wiring, pipes or the panel', ask: 'Is it mostly a close-up of building work rather than the room: an electrical panel or breaker box, open wiring, pipes, a hole cut in a wall, floor or ceiling, or what is inside a wall?' },
  { key: 'noRoom', why: 'Not a picture of the room', ask: 'Is it blurry or dark, or does it show mostly the ceiling, or is it a close-up of one thing (a towel or towel bar, a door, a handle, a shelf, cords, an outlet, a pipe) rather than a view of the room?' },
];

const PROMPT = `You look at photos for a children's charity before it shows them on a public web page. Each photo was taken on a visit to a family's home, before the charity remodels a child's room (a bedroom, a bathroom or a therapy room). The page shows the room as it is now, before the makeover.

Answer every question about this one photo with true or false. Look at the whole photo: the edges, the background, mirrors, windows, and anything on the walls, shelves and furniture. When you are not sure, answer true.

The room itself is fine to show however it looks: furniture, a bed, a toilet, a tub or shower, medical equipment, a wheelchair or lift, toys, clothes, books, children's art, mess, damage and wear are all fine. Questions about what a photo is "mostly" of are only true when that is what the photo is of, not when it is somewhere in a room.`;

const SCHEMA = {
  type: 'object',
  properties: Object.fromEntries(QUESTIONS.map((q) => [q.key, { type: 'boolean', description: q.ask }])),
  required: QUESTIONS.map((q) => q.key),
};

const QUESTION_TEXT = QUESTIONS.map((q, i) => `${i + 1}. ${q.key}: ${q.ask}`).join('\n');

/** true, false, or null when the model gave no clear answer (counted as true by judgePhoto) */
const yesNo = (v) => (v === true || /^\s*(true|yes)\b/i.test(String(v ?? '')) ? true : v === false || /^\s*(false|no)\b/i.test(String(v ?? '')) ? false : null);

/**
 * The model's answers → { show, why, answers }. show only when every question was answered, and answered no; why:
 * the first question answered yes (or not answered), in staff's words ('' when it shows).
 */
export function judgePhoto(answers) {
  const got = Object.fromEntries(QUESTIONS.map((q) => [q.key, yesNo(answers?.[q.key])]));
  const hit = QUESTIONS.find((q) => got[q.key] !== false);
  return { show: !hit, why: hit ? hit.why : '', answers: got };
}

/**
 * Looks at one picture (bytes and its type) → judgePhoto's { show, why, answers }, or null when the model answered
 * with nothing that reads (that's the photo's: tried again later). A spending cap reached throws (aiCapped); the model
 * not answering at all (too slow, down or busy, or no AI binding) throws AiDown; turning the picture away throws
 * Refused, with its words. opts: timeoutMs, each try at most this
 * long; canRetry(), whether there's time for a second try (asked in plain words, after an answer that won't read or
 * a refusal of the JSON form). A try that was too slow isn't tried again: the model is slow, not the photo's.
 */
export async function screenPhoto(env, { bytes, type = 'image/jpeg' }, { timeoutMs = SCREEN_TIMEOUT_MS, canRetry = () => true } = {}) {
  if (!env.AI) throw new AiDown('Workers AI isn’t bound (AI)', { wide: true });
  const messages = [
    { role: 'system', content: PROMPT },
    { role: 'user', content: [
      { type: 'text', text: `Answer each question about this photo with true or false:\n${QUESTION_TEXT}` },
      { type: 'image_url', image_url: { url: `data:${type};base64,${toBase64(bytes)}` } },
    ] },
  ];
  const wait = Math.max(1000, Math.min(SCREEN_TIMEOUT_MS, timeoutMs));
  let answered = false;
  let lastError = null;
  // Its answers in JSON first; a model that won't is asked again in plain words (answerOf reads either)
  for (const json of [true, false]) {
    if (!json && !canRetry()) break;
    try {
      const out = await withTimeout(env.AI.run(SCREEN_MODEL, {
        messages, max_tokens: 200, temperature: 0,
        ...(json ? { response_format: { type: 'json_schema', json_schema: SCHEMA } } : {}),
      }, viaGateway('before-photos')), wait);
      answered = true;
      const a = answerOf(out);
      if (a) return judgePhoto(a);
    } catch (err) {
      if (aiCapped(err)) throw err;
      if (err instanceof TooSlow) throw new AiDown(`Workers AI didn’t answer (${err.message})`);
      lastError = err;
      console.error('[photo-screen]', err.message);
    }
  }
  if (!answered && (!lastError || SERVICE_TROUBLE.test(String(lastError.message)))) throw new AiDown(`Workers AI didn’t answer (${lastError?.message || 'no answer'})`);
  if (!answered) throw new Refused(`Workers AI turned it away: ${String(lastError.message).slice(0, 160)}`);
  // (An answer that won't read: the photo's, tried again later)
  return null;
}

class TooSlow extends Error {}
function withTimeout(p, ms) {
  let timer;
  return Promise.race([p, new Promise((_, reject) => { timer = setTimeout(() => reject(new TooSlow('Workers AI took too long')), ms); })]).finally(() => clearTimeout(timer));
}

/** The photo as the model gets it: Cloudflare Images' resize of a /public picture (any other address as it is) */
export const screenUrl = (url) => String(url || '').replace(/\/public$/, `/${SCREEN_SIZE}`);

const toBase64 = (bytes) => {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
};

/** For the prompt's tests and the one-off calibration: exactly what the model is sent, less the picture */
export const SCREEN_REQUEST = { prompt: PROMPT, schema: SCHEMA, questions: QUESTION_TEXT };
