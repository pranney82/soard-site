/**
 * What's in a family's files, read one way
 * ===========================================================================
 * A JobTread account holds the family's application beside everything else
 * that lands there: staff's onsite and Zoom notes, signed agreements, letters,
 * whatever a family emailed in. Two readers, two rules:
 *
 *   applicationParts   staff (./applicants.js): everything, the application
 *                      first. Nothing is hidden from staff.
 *   provenParts        the board page (../../functions/api/_board-families.js):
 *                      only what a file's name PROVES is the family's
 *                      application, video or a photo they sent. A name that
 *                      proves nothing (a screenshot, IMG_4471, a doctor's
 *                      letter, a driver's license) stays with staff.
 *
 * The board's rule is an allow-list on purpose. A list of bad words can't be
 * finished: it would need to know every document a family might ever send.
 *
 * The names it knows are the ones the form and staff make: "<Child>_Application.pdf",
 * "Application_<Child>.pdf", "<Child>_Application.mp4", "<Child>.jpg", "<Child> Family.jpg",
 * "<Child> Space 1.jpg", and Jotform's own for older families ("7d4faceBen_5e81d0.jpeg").
 * On every family in JobTread, Nov 7 2026 (85): 48 of 49 applications, 17 of 18 videos and
 * 198 of 208 photos are proven. The rest are camera names (IMG_4471), which prove nothing, and
 * one application under a surname the account doesn't have. Renaming a file in JobTread shows it.
 */

/** What a file is, by its type or else its name */
export function fileKind(f) {
  const t = String(f?.type || '').toLowerCase();
  const n = String(f?.name || '').toLowerCase();
  if (t === 'application/pdf' || n.endsWith('.pdf')) return 'pdf';
  if (t.startsWith('image/') || /\.(jpe?g|png|gif|webp|avif|heic|heif)$/.test(n)) return 'image';
  if (t.startsWith('video/') || /\.(mp4|mov|m4v|webm)$/.test(n)) return 'video';
  if (t.startsWith('audio/') || /\.(mp3|m4a|wav|aac|ogg)$/.test(n)) return 'audio';
  return 'other';
}

/**
 * Words that mean a file is about something other than a person: a name with one of these in it isn't a name. It's a
 * second line only: the first is that a file's name has to match the family's at all. (Also the child's photo in
 * ../../functions/api/_applicants.js.)
 */
export const NOT_A_NAME = new Set(['family', 'families', 'parents', 'siblings', 'space', 'room', 'rooms', 'bedroom', 'bathroom', 'bath', 'bed', 'kitchen',
  'house', 'home', 'ramp', 'therapy', 'mood', 'board', 'plan', 'plans', 'floor', 'before', 'after', 'site', 'onsite', 'note', 'notes',
  'render', 'rendr', 'design', 'layout', 'logo', 'screenshot', 'scan', 'door', 'doorway', 'hall', 'hallway', 'stair', 'stairs', 'yard',
  'porch', 'closet', 'tub', 'shower', 'toilet', 'sink', 'garage', 'exterior', 'interior', 'existing', 'proposed', 'resume', 'letter', 'map',
  // What a family or staff might attach that isn't the application
  'zoom', 'visit', 'interview', 'recording', 'walkthrough', 'review', 'scoring', 'summary', 'report', 'agreement', 'contract', 'signed', 'waiver', 'release', 'consent',
  'license', 'licence', 'passport', 'id', 'card', 'insurance', 'medicaid', 'medicare', 'tefra', 'beckett', 'ssi', 'ssn', 'snap', 'housing', 'benefits', 'disability', 'grant', 'scholarship', 'school', 'camp',
  'birth', 'certificate', 'tax', 'taxes', 'return', 'income', 'w2', 'w9', 'paystub', 'bank', 'statement', 'deed', 'mortgage', 'doctor', 'physician', 'medical', 'records', 'prescription', 'diagnosis', 'denial', 'declined']);

// (only a real extension comes off: "Iris_Application.Notes" isn't the application)
const baseName = (f) => String(f?.name || '').replace(/\.(?:pdf|jpe?g|png|gif|webp|avif|hei[cf]|mp4|mov|m4v|webm)$/i, '');
// (case by hand: an `i` flag would reach the lookahead too, and "Clareece_ApplicationNotesIris" would get through)
const staffNote = (f) => /(?:[Nn]otes?|NOTES?)(?![a-z])/.test(baseName(f));

/** What a family photo is, from the name JobTread has (the form names them "<Child> Family.jpg", "<Child> Space 1.jpg"…) */
export function photoLabel(f, child) {
  const n = baseName(f);
  if (/famil/i.test(n)) return 'Family';
  const sp = n.match(/space ?(\d)/i);
  if (sp) return `Space ${sp[1]}`;
  if (/space/i.test(n)) return 'Space';
  const first = String(child || '').trim().split(/\s+/)[0]?.toLowerCase();
  if (n.toLowerCase() === String(child || '').trim().toLowerCase() || (first && n.toLowerCase() === first)) return 'Child';
  return n;
}

/** The way the form asks for them: the child, the family, the spaces; anything else after, oldest first */
function photoRank(label) {
  return label === 'Child' ? 0 : label === 'Family' ? 1 : /^Space/.test(label) ? 2 + (Number(label.split(' ')[1]) || 0) : 20;
}
const byLabel = (lx, ly, x, y) => photoRank(lx) - photoRank(ly) || String(x.at || '').localeCompare(String(y.at || ''));

/** Staff's view of a family's files → { pdf, video, photos, docs }: all of them, the application first */
export function applicationParts(files, child) {
  const list = files || [];
  const sure = provenParts(list, child);
  const pdf = sure.pdf ? list.find((f) => f.id === sure.pdf.id) : list.find((f) => fileKind(f) === 'pdf' && /application/i.test(baseName(f)) && !staffNote(f)) || null;
  const videos = list.filter((f) => fileKind(f) === 'video' && !staffNote(f));
  const video = (sure.video ? list.find((f) => f.id === sure.video.id) : videos.find((f) => /application/i.test(baseName(f))) || videos[0]) || null;
  const photos = list.filter((f) => fileKind(f) === 'image' && !staffNote(f))
    .sort((x, y) => byLabel(photoLabel(x, child), photoLabel(y, child), x, y));
  const docs = list.filter((f) => f !== pdf && f !== video && !photos.includes(f));
  return { pdf, video, photos, docs };
}

// A name's words: "Remi & Nico_Smith" → remi, nico, smith; glued ones apart too ("Iris_DriversLicense" → iris, drivers, license)
const wordsOf = (s) => String(s || '').replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2').toLowerCase().split(/[\s_&,+-]+/).filter(Boolean);
const isWord = (w) => /^[\p{L}'’.]+$/u.test(w);
// A copy's "(1)" says nothing about what it is
const plainName = (f) => baseName(f).replace(/\s*\(\d+\)\s*$/, '').trim();

/** Could these words be a person's name? Nothing but words, not too many, none of them about something else */
const nameish = (words) => words.length <= 6 && words.every(isWord) && !words.some((w) => NOT_A_NAME.has(w));

const FORM_PHOTO = /^(.*?)[\s_-]*(famil(?:y|ies)|space)(?:[\s_-]*(\d))?$/i;
const JOTFORM_PHOTO = /^[0-9a-f]{3,}(face|famil|space)/i;

/**
 * The board's view of a family's files → { pdf, video, photos }, each proven by its name, with a `label` on each
 * photo. `child`: the account's name. The oldest wins where two say the same: the family's own came first.
 */
export function provenParts(files, child) {
  const list = [...(files || [])].sort((x, y) => String(x.at || '').localeCompare(String(y.at || '')));
  const own = new Set(wordsOf(child));
  // The name their own family and space photos go by ("Lizzie Family.jpg" on Elizabeth's account) is theirs too
  const theirs = new Set(own);
  for (const f of list) {
    const m = fileKind(f) === 'image' ? plainName(f).match(FORM_PHOTO) : null;
    const words = m ? wordsOf(m[1]) : [];
    if (words.length && nameish(words)) for (const w of words) theirs.add(w);
  }
  // Nothing in it but their name: "Iris", "Iris Example", "Lizzie Example". One word more ("Iris_PeachCare",
  // "Iris Xray") and it could be any paper about them, so it stays with staff
  const theirName = (words) => words.length > 0 && words.every((w) => theirs.has(w));

  const photoAs = (f) => {
    const name = plainName(f);
    const jotform = name.match(JOTFORM_PHOTO);
    if (jotform) return /face/i.test(jotform[1]) ? 'Child' : /famil/i.test(jotform[1]) ? 'Family' : 'Space';
    const m = name.match(FORM_PHOTO);
    if (m) {
      const words = wordsOf(m[1]);
      // (an organization's own name can be anything: "Lionheart School Space 1")
      if (!words.length || nameish(words) || words.every((w) => own.has(w))) return /famil/i.test(m[2]) ? 'Family' : m[3] ? `Space ${m[3]}` : 'Space';
      return null;
    }
    return theirName(wordsOf(name)) ? 'Child' : null;
  };
  const named = (kind) => {
    // "<Child>_Application", or the other way round: "Application_<Child>"
    const whose = (f) => wordsOf(plainName(f).match(/^(.+?)[\s_-]+application$/i)?.[1] || plainName(f).match(/^application[\s_-]+(.+)$/i)?.[1]);
    const found = list.filter((f) => fileKind(f) === kind && theirName(whose(f)));
    // Exactly the account's name first; the oldest of those
    return found.find((f) => whose(f).every((w) => own.has(w))) || found[0] || null;
  };
  const photos = list.filter((f) => fileKind(f) === 'image').map((f) => ({ ...f, label: photoAs(f) })).filter((f) => f.label)
    .sort((x, y) => byLabel(x.label, y.label, x, y));
  return { pdf: named('pdf'), video: named('video'), photos };
}
