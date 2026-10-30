/**
 * The makeover process, shared by the server (functions/api/_process-docs.js)
 * and Site → Automations → Process (./process.js)
 * ===========================================================================
 * SOARD writes its process down in two Google Docs in the shared drive's
 * "Sunshine Folders": "2026 Sunshine Makeover Process" and "2026 Sunshine
 * Community Project Process", one numbered list each (a step, the work under
 * it, and notes under that). Those Docs are the process; the admin reads them
 * as they are and never keeps its own copy, so an edit in the Doc shows up
 * here the next time Process opens.
 *
 * What the admin adds is what runs on its own at each step: RULES below pin
 * the automations on Site → Automations (by their names there) to the Doc's
 * lines by what a line says ("JT sends family message" is the status email),
 * and to a step as a whole ("Mobilization": vendors on their jobs, W-9s).
 * A line no rule knows reads as done by hand. A Doc reworded so a rule stops
 * matching loses that pin, never the line.
 *
 * Before "Onsite" the makeover Doc has nothing: a family applies on the
 * website. APPLYING is that part, the way the site runs it and the way the
 * "2026 Application Timeline" handout tells families (Info Sheets/Handouts).
 * The community Doc starts at the application itself.
 *
 * Money has no process Doc. The board's "Financial Policy Manual" (a Google
 * Doc too) sets its rules, and the site, Mercury, JobTread and Zeffy do most
 * of the work, so MONEY below is the money side as it runs, step by step, and
 * each step names the manual's sections that govern it. The manual is read
 * live like the process Docs and its sections are shown with their step, so
 * its words are never copied here either.
 */

/** What Process shows: the two project tracks, then the money side */
export const TRACKS = ['makeover', 'community', 'payables', 'receivables', 'books'];
export const PROJECT_TRACKS = ['makeover', 'community'];
export const MONEY_TRACKS = ['payables', 'receivables', 'books'];
export const TRACK_LABEL = { makeover: 'Kids’ makeovers', community: 'Community projects', payables: 'Accounts payable', receivables: 'Gifts & deposits', books: 'Books & reporting' };
/** The Docs read from Drive: each project track's process, and the board's financial policy */
export const DOCS = ['makeover', 'community', 'policy'];
/** Each Doc by its name in Drive (the year in front changes) */
export const DOC_NAME = {
  makeover: /\bsunshine makeover process\b/i,
  community: /\bsunshine community project process\b/i,
  policy: /\bfinancial policy manual\b/i,
};
/** Drive's search for those names: whole words, then the pattern above */
export const DOC_SEARCH = {
  makeover: ["name contains 'Makeover'", "name contains 'Process'"],
  community: ["name contains 'Community'", "name contains 'Process'"],
  policy: ["name contains 'Financial'", "name contains 'Policy'"],
};
/** How each Doc is named when it can't be found */
export const DOC_LIKE = { makeover: 'Sunshine Makeover Process', community: 'Sunshine Community Project Process', policy: 'Board Financial Policy Manual' };
export const GOOGLE_DOC = 'application/vnd.google-apps.document';

// ─── The Doc ──────────────────────────────

const NAMED = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: '’', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—', hellip: '…', bull: '•' };
const entities = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (all, e) => (e[0] === '#'
  ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)))
  : NAMED[e.toLowerCase()] ?? all));
const words = (s) => s.replace(/\s+/g, ' ').trim();

/**
 * A Doc exported as HTML (Drive's text/html) → { title, steps: [{ t, items: [{ t, items }] }] }.
 * Google writes a nested list as one flat list per level, side by side
 * (<ol class="lst-kix_abc-0">, then <ol class="lst-kix_abc-1">…), so each
 * item's level comes from its list's class. The top level is the steps.
 * Paragraphs outside a list: the first is the title, the rest aren't steps.
 */
export function parseProcessHtml(html) {
  const s = String(html || '');
  const body = ((s.match(/<body\b[^>]*>([\s\S]*)<\/body>/i) || [])[1] ?? s)
    // Comments' and footnotes' markers, and their text at the end
    .replace(/<sup\b[^>]*>\s*<a\b[^>]*href="#(cmnt|ftnt)\d+"[^>]*>[\s\S]*?<\/a>\s*<\/sup>/gi, '')
    .replace(/<div\b[^>]*>\s*<p\b[^>]*>\s*<a\b[^>]*id="(cmnt|ftnt)\d+"[\s\S]*?<\/div>/gi, '');
  const steps = [];
  let title = '';
  let level = null; // the open list's level, null outside a list
  let text = null; // the open item's or paragraph's words
  const path = []; // the last item at each level
  const add = (t, lv) => {
    const node = { t, items: [] };
    if (lv === 0 || !steps.length) {
      steps.push(node);
      path.length = 0;
      path[0] = node;
      return;
    }
    // Under the nearest item above it (a level skipped hangs on the one before)
    let p = null;
    for (let i = Math.min(lv - 1, path.length - 1); i >= 0 && !p; i--) p = path[i] || null;
    (p || steps[steps.length - 1]).items.push(node);
    path.length = Math.min(lv, path.length);
    path[lv] = node;
  };
  for (const [, close, tag, attrs, chunk] of body.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>|([^<]+)/g)) {
    if (chunk !== undefined) { if (text !== null) text += entities(chunk); continue; }
    const t = tag.toLowerCase();
    if (t === 'br') { if (text !== null) text += ' '; continue; }
    if (t === 'ol' || t === 'ul') {
      if (close) { level = null; continue; }
      const kix = attrs.match(/lst-kix_[\w-]+?-(\d+)\b/);
      level = kix ? Number(kix[1]) : 0;
      continue;
    }
    if (t === 'li') {
      if (!close) { text = ''; continue; }
      const w = words(text || '');
      text = null;
      if (w) add(w, level ?? 0);
      continue;
    }
    if (/^(p|h[1-6])$/.test(t)) {
      if (level !== null) continue; // a paragraph inside a list item
      if (!close) { text = ''; continue; }
      const w = words(text || '');
      text = null;
      if (w && !title && !steps.length) title = w;
    }
  }
  return { title, steps };
}

/**
 * The manual's sections, by its table of contents ("A. Accounting 2"):
 * → [{ t: 'Accounting', lines: [{ t, level }] }]. A section runs from the
 * line that is its title to the next section's (or a SECTION / Exhibit
 * heading). None when the Doc has no contents list.
 */
export function policySections(html) {
  const s = String(html || '');
  const body = ((s.match(/<body\b[^>]*>([\s\S]*)<\/body>/i) || [])[1] ?? s);
  const lines = [];
  let level = null;
  let text = null;
  for (const [, close, tag, attrs, chunk] of body.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b([^>]*)>|([^<]+)/g)) {
    if (chunk !== undefined) { if (text !== null) text += entities(chunk); continue; }
    const t = tag.toLowerCase();
    if (t === 'br') { if (text !== null) text += ' '; continue; }
    if (t === 'ol' || t === 'ul') {
      if (close) { level = null; continue; }
      const kix = attrs.match(/lst-kix_[\w-]+?-(\d+)\b/);
      level = kix ? Number(kix[1]) : 0;
      continue;
    }
    if (t === 'li' || /^(p|h[1-6])$/.test(t)) {
      if (t !== 'li' && level !== null) continue;
      if (!close) { text = ''; continue; }
      const w = words(text || '');
      text = null;
      if (w) lines.push({ t: w, level: t === 'li' ? level : null, head: /^h/.test(t) });
    }
  }
  const titles = lines.map((l) => (l.head ? null : l.t.match(/^[A-Z]\.\s+(.+?)\s+\d+$/)?.[1])).filter(Boolean);
  const start = lines.findIndex((l) => l.head);
  if (!titles.length || start < 0) return [];
  const key = (t) => t.toLowerCase();
  const isTitle = new Set(titles.map(key));
  const out = [];
  let cur = null;
  for (const l of lines.slice(start)) {
    if (l.head || /^(section [ivx]+:|exhibit [a-z]\b)/i.test(l.t)) { cur = null; continue; }
    if (isTitle.has(key(l.t)) && !out.some((x) => key(x.t) === key(l.t))) {
      cur = { t: titles.find((x) => key(x) === key(l.t)), lines: [] };
      out.push(cur);
      continue;
    }
    if (cur) cur.lines.push({ t: l.t, level: l.level });
  }
  return out;
}

/**
 * The manual's approval tiers, from its Expenditures section ("Item cost:
 * Greater than $15,000.00 / Required approval: Board Chair") → [{ over, by }]
 * (over: dollars, 0 for the first tier)
 */
export function approvalTiers(sections) {
  const sec = (sections || []).find((x) => /^expenditures$/i.test(x.t));
  if (!sec) return [];
  const text = sec.lines.map((l) => l.t).join('\n');
  const out = [];
  for (const m of text.matchAll(/item cost:?\s*(less than or equal to|greater than|up to|over)\s*\$?([\d,]+(?:\.\d+)?)[\s\S]{0,80}?required approval:?\s*([^\n]+)/gi)) {
    const amount = Number(m[2].replace(/,/g, ''));
    out.push({ over: /greater|over/i.test(m[1]) ? amount : 0, by: m[3].trim().replace(/[.;]$/, '') });
  }
  return out;
}

/** The year a Doc's name is for ("2026 Sunshine Makeover Process" → 2026), else 0 */
export const docYear = (name) => Number((String(name || '').match(/\b(20\d{2})\b/) || [])[1]) || 0;

/**
 * The Doc a track follows among Drive's search results: a Google Doc by that
 * name, the latest year first, then the one changed last. A "Copy of …" only
 * when there's nothing else.
 */
export function pickDoc(files, track) {
  const named = (files || []).filter((f) => f && f.mimeType === GOOGLE_DOC && !f.trashed && DOC_NAME[track]?.test(f.name || ''));
  const real = named.filter((f) => !/^\s*copy of\b/i.test(f.name));
  const list = real.length ? real : named;
  return list.sort((a, b) => docYear(b.name) - docYear(a.name) || String(b.modifiedTime || '').localeCompare(String(a.modifiedTime || '')))[0] || null;
}

// ─── The yearly review ────────────────────

/** A Doc is looked over once a year; it shows as coming up this many days before */
export const SOON_DAYS = 60;
const DAY = 86400000;

/**
 * When a Doc is next due for its yearly review → { state: 'ok'|'soon'|'due', dueAt, last, nextYear? }
 * A year after it last changed or was last marked reviewed, whichever is later.
 * A process Doc named for a past year ("2026 …" in 2027) is due now: the new
 * year's Doc is written, and Process follows it on its own. Null without dates.
 */
export function reviewOf(doc, { reviewedAt = null, yearly = false, now = Date.now() } = {}) {
  const last = [doc?.modifiedTime, reviewedAt].filter(Boolean).sort().pop() || null;
  if (!last) return null;
  const due = new Date(last);
  due.setUTCFullYear(due.getUTCFullYear() + 1);
  const year = docYear(doc?.name);
  const thisYear = new Date(now).getUTCFullYear();
  if (yearly && year && year < thisYear && !(reviewedAt && new Date(reviewedAt).getUTCFullYear() === thisYear)) {
    return { state: 'due', dueAt: new Date(Date.UTC(thisYear, 0, 1)).toISOString(), last, nextYear: thisYear };
  }
  const days = (due.getTime() - now) / DAY;
  return { state: days < 0 ? 'due' : days <= SOON_DAYS ? 'soon' : 'ok', dueAt: due.toISOString(), last };
}

/** Tools the manual may still name that SOARD has moved off, and where things are now */
export const RETIRED = [
  { re: /\bquickbooks\b/i, word: 'QuickBooks', now: 'the books are in Mercury Books' },
];
/** The manual's lines that name a retired tool → [{ word, now, sections: [titles], count }] */
export function retiredMentions(sections) {
  return RETIRED.map((r) => {
    const hits = (sections || []).flatMap((x) => x.lines.filter((l) => r.re.test(l.t)).map(() => x.t));
    return hits.length ? { word: r.word, now: r.now, sections: [...new Set(hits)], count: hits.length } : null;
  }).filter(Boolean);
}

/** A Doc's id from its link ("…/document/d/<id>/edit…", "…?id=<id>") or the bare id; '' when it isn't one */
export function docIdOf(link) {
  const s = String(link || '').trim();
  const m = s.match(/\/document\/(?:u\/\d+\/)?d\/([\w-]{20,})/) || s.match(/[?&]id=([\w-]{20,})/);
  if (m) return m[1];
  return /^[\w-]{20,}$/.test(s) ? s : '';
}

// ─── Applying (the website's part) ────────

/**
 * A family's way in, before the Doc's "Onsite": the website's form and
 * statuses, in the steps of the 2026 Application Timeline handout. Each line
 * names the automations that do it.
 */
export const APPLYING = [
  { t: 'Applications open', items: [
    { t: 'While applications are closed, families leave their email to hear when they open', autos: ['Tell me when applications open'] },
    { t: 'Applications open and close on the dates in Applications → Settings', autos: ['Open and close on schedule'] },
    { t: 'Everyone waiting gets the link the moment they open', autos: ['Applications-open email'] },
    { t: 'They close on their own once the season’s limit is reached', autos: ['Application limit'] },
  ]},
  { t: 'Application submitted', items: [
    { t: 'The family applies on the website, in English or Spanish, with photos and a video', autos: ['Makeover application', 'Service-area check', 'Save and finish later', 'Bot check'] },
    { t: 'It becomes a JobTread account at Applied, with the application PDF, photos and video', autos: ['Application → JobTread', 'Application sweep', 'Admin → Applications', 'Comms Thread on new families', 'Clean up new addresses', 'Zillow lookup'] },
    { t: 'The family gets the Application Status message with their copy', autos: ['Family confirmation'] },
    { t: 'Selection hears about it, with a note on the child’s condition', autos: ['Staff heads-up', 'Medical condition note'] },
  ]},
  { t: 'Reviewed internally', items: [
    { t: 'Check the application is complete and ask for anything missing', autos: ['Admin → Applicants', 'JobTread → Applicants sync', 'A family replied → staff alert', 'Family emails → JobTread', 'Quo texts and calls → JobTread', '/text → Quo text'] },
  ]},
  { t: 'Video interview', items: [
    { t: 'Meet the family online to learn more about the child and their story' },
  ]},
  { t: 'Reviewed internally', items: [
    { t: 'Decide on an onsite visit: moving the family to In Review emails them about it', autos: ['Status → family message', 'Status change summary'] },
    { t: 'Denial is possible at any step until the final approval', autos: ['Status → family message'] },
  ]},
];
export const APPLYING_SOURCE = '2026 Application Timeline';

// ─── The money side (how it runs) ─────────

/**
 * Each step: its lines and the automations that do them, and `policy`, the
 * manual's sections (their titles in its contents) that govern the step.
 * A line with no automations is done by hand.
 */
export const MONEY = {
  payables: [
    { t: 'Buying for a makeover', policy: ['Credit Cards'], items: [
      { t: 'Staff buy on their SOARD cards; each charge is sorted onto its makeover, the store or operating', autos: ['Charges onto jobs, live'] },
      { t: 'A job’s costs show against its budget as they land, with a heads-up at 80% and 100%', autos: ['Budget alerts'] },
      { t: 'A charge that looks wrong is flagged: twice in a day, far over the usual, a new monthly charge', autos: ['Odd charges'] },
    ]},
    { t: 'Receipts', policy: ['Credit Cards'], items: [
      { t: 'A receipt in anyone’s inbox goes to the receipt inbox without being forwarded', autos: ['Receipts from inboxes'] },
      { t: 'Each receipt becomes a paid JobTread bill, one line per cost code', autos: ['Receipts → JobTread bills'] },
      { t: 'Receipts are matched between Mercury and JobTread both ways', autos: ['Receipts both ways'] },
      { t: 'Charges still without a receipt after 2 days are listed each weekday morning', autos: ['Budget alerts'] },
    ]},
    { t: 'Vendor papers', policy: ['IRS Form 1099'], items: [
      { t: 'Every vendor on a job is asked for a current W-9 and insurance, and their papers are checked', autos: ['W-9s and insurance', 'Vendors on their JobTread jobs'] },
      { t: 'A bill waits unpaid until its vendor’s papers are current', autos: ['W-9s and insurance'] },
    ]},
    { t: 'Approving a bill', policy: ['Expenditures', 'Segregation of Duties'], check: 'approvals', items: [
      { t: 'A sub’s bill lands in JobTread and its approver is asked by email', autos: ['Bill approvals and pay'] },
      { t: 'A bill over the second-approval amount needs a second approver', autos: ['Bill approvals and pay'] },
    ]},
    { t: 'Paying', policy: ['Check Preparation and Mailing', 'Wire Transfers'], items: [
      { t: 'Approved bills are paid from Mercury the way Job Costs → Bills → Settings says, and each payment is recorded on its bill', autos: ['Bill approvals and pay'] },
      { t: 'Card balances are paid before they’re due' },
    ]},
    { t: 'Reimbursing staff and volunteers', policy: ['Expense Reimbursements'], items: [
      { t: 'Approved expenses are paid back through the payroll system' },
    ]},
    { t: 'Closing out a makeover', items: [
      { t: 'A finished job’s final numbers by cost code, cost per room and what ran over', autos: ['Close-outs'] },
    ]},
    { t: 'Year end', policy: ['IRS Form 1099'], items: [
      { t: 'Vendors’ W-9s go to Mercury for their 1099s', autos: ['W-9s and insurance'] },
    ]},
  ],
  receivables: [
    { t: 'Gifts online', policy: ['Contributions'], items: [
      { t: 'Donors give through Zeffy on the donate page, the live page and the golf page, and during a live reveal', autos: ['Zeffy donations', 'Give panel (Zeffy)'] },
      { t: 'The team hears about each gift as it comes in, with major gifts called out', autos: ['Gift alerts in Slack'] },
      { t: 'Every gift is acknowledged in writing' },
    ]},
    { t: 'Events and the auction', policy: ['Contributions'], items: [
      { t: 'Gala bids and paddle raises run through Qtego', autos: ['Qtego auction'] },
      { t: 'A gift that came with something in return tells the donor what’s deductible' },
    ]},
    { t: 'Sponsors', items: [
      { t: 'A sponsor paying for a kid’s room is picked on the kid’s profile: they get the job in JobTread and the invites', autos: ['Monetary sponsor ↔ JobTread'] },
      { t: 'Their logo goes on the kid’s page', autos: ['Vendor and sponsor logos on kid pages'] },
    ]},
    { t: 'Checks by mail', policy: ['Accounting and Controls of Checks'], items: [
      { t: 'Checks are opened, recorded, kept locked and deposited' },
    ]},
    { t: 'Into the books', policy: ['Accounting'], items: [
      { t: 'Every deposit and gift lands in Mercury; Mercury Books is the books', autos: ['Mercury connection', 'P&L'] },
    ]},
  ],
  books: [
    { t: 'Watching the bank', policy: ['Bank Statements'], items: [
      { t: 'Unusual charges are flagged as they happen', autos: ['Odd charges'] },
      { t: 'Balances from Mercury and Chase, day by day', autos: ['Mercury connection', 'Cash in the bank, month by month'] },
    ]},
    { t: 'Month end', policy: ['Accounting'], items: [
      { t: 'The month is closed in Mercury Books' },
      { t: 'Money in and out by month, in three columns: makeovers, the store, operating', autos: ['P&L'] },
    ]},
    { t: 'Quarterly statements to the board', policy: ['Accounting'], items: [
      { t: 'The numbers are on the board page, against last year', autos: ['P&L'] },
      { t: 'The financials go to the board with each meeting’s packet', autos: ['Board mail → agendas, minutes and financials', 'The packet email'] },
    ]},
    { t: 'Budget and cash', policy: ['Budget', 'Reserve Fund Policy'], items: [
      { t: 'The year’s budget goes to the board for approval' },
      { t: 'Cash 13 weeks ahead, with a heads-up when it dips under the floor', autos: ['Cash forecast'] },
    ]},
    { t: 'Audit or review', policy: ['Accounting'], items: [
      { t: 'A CPA firm audits or reviews the year’s statements' },
    ]},
  ],
};

// ─── What runs on its own at each step ────

/**
 * A line of a Doc → the automations that do it. `re` reads the line's
 * words; `makeover` / `community` add the ones that are that track's only.
 */
export const LINE_RULES = [
  { re: /\bonline application\b|\bapplication submitted\b/i,
    makeover: ['Makeover application'], community: ['Community project application'],
    autos: ['Service-area check', 'Application → JobTread', 'Family confirmation', 'Staff heads-up', 'Application sweep'] },
  { re: /\bteam review\b|\breviewed internally\b/i, autos: ['Admin → Applicants', 'JobTread → Applicants sync', 'Status → family message', 'Family emails → JobTread'] },
  { re: /\bdigital documentation\b|\bscans\b/i, autos: ['CompanyCam for families in review'] },
  { re: /\bchooses who moves forward\b/i, makeover: ['Makeover scoring'] },
  { re: /\b(jt|jobtread)\b.*\bmessage\b/i, autos: ['Status → family message', 'Status change summary'] },
  { re: /\b(jt|jobtread) job\b/i, autos: ['Approved → job and its page', 'Kid photo as the job’s cover'] },
  { re: /\bwebpage\b|\bweb page\b/i, autos: ['Approved → job and its page', 'Kid and project status follow JobTread'] },
  { re: /\bfamily photo\b/i, autos: ['Kid photo as the job’s cover'] },
  { re: /\bsigns? (approval|off on selections)\b/i, autos: ['Scope approved → Mobilization'] },
  { re: /\border (building|selection)? ?materials\b/i, autos: ['Charges onto jobs, live', 'Receipts → JobTread bills', 'Receipts from inboxes'] },
  { re: /\bschedule trades\b/i, autos: ['Vendors on their JobTread jobs', 'W-9s and insurance'] },
  { re: /\bstart date\b/i, autos: ['Demo day invites', 'Demo Day page'] },
  { re: /\battends?\b/i, step: /\bdemo day\b/i, autos: ['Demo day invites'] },
  { re: /\breveal day\b/i, step: /\bin progress\b|\bunderway\b/i, autos: ['Reveal date sync', 'Reveal checks for PMs', 'Dashboard reveal dates', 'Live countdown follows JobTread', 'Public reveal feed'] },
  { re: /\binvite board\b|\binvite\b.*\bsponsor\b/i, autos: ['Invite engine', 'New guest check', 'Reveals → Now tracker', 'Invite problem alerts'] },
  { re: /\bphotographer\b/i, autos: ['New guest check'] },
];

/** A step of a Doc as a whole (by its name) → what runs through it that no one line does */
export const STEP_RULES = [
  { re: /^demo day\b/i, autos: ['Invite engine', 'CompanyCam photos on every job'] },
  { re: /^mobilization\b/i, makeover: ['Monetary sponsor ↔ JobTread'], autos: ['Vendor and sponsor logos on kid pages', 'Vendors on their JobTread jobs', 'W-9s and insurance'] },
  { re: /\bin progress\b|\bunderway\b/i, autos: ['Charges onto jobs, live', 'Budget alerts', 'Bill approvals and pay', 'Receipts both ways', 'Odd charges', 'CompanyCam photos on every job'] },
  { re: /^reveal day\b/i, autos: ['Go / no-go', 'Phone stream (Larix)', 'Automatic start & stop', 'Simulcast to Facebook', 'Simulcast to YouTube', '/live/ page follows the kid', 'Live hub', 'Family messages, AI screened', 'Give panel (Zeffy)', '“We’re live” email (Kit)', 'Reminder emails', 'Browser push reminders', 'Reveal reminder signup', 'Feed monitor', 'Reveal-day health check', 'Alert emails', 'Kid and project status follow JobTread'] },
  { re: /^post[- ]?construction\b/i, autos: ['Replay goes up', 'Instagram Reel', 'Facebook replay rescue', 'Jump to the reveal', 'Close-outs'] },
];

// ─── Who's at which step ──────────────────

/**
 * A JobTread status (an applicant's, or a job's) → the Doc step it means,
 * by the step's name: In Review is the on-site visit (its email says so), a
 * job just approved or waiting on its funding sits at the first approval
 * step, Design at the charrette, Finalization at the PM review, Approval at
 * the last approval step (the design's), Build while the project is in
 * progress. A Doc renamed so a rule stops matching just leaves that status
 * off the steps (it's still in Right now).
 */
export const STATUS_STEPS = [
  { status: 'Applied', track: 'makeover', step: /^application submitted$/i },
  { status: 'Applied', track: 'community', step: /\bonline application\b/i },
  { status: 'In Review', step: /^onsite\b/i },
  { status: 'On Site', step: /\bapproval\b/i, pick: 'first' },
  { status: 'Awaiting Funding', step: /\bapproval\b/i, pick: 'first' },
  { status: 'Design', step: /\bdesign charrette\b/i },
  { status: 'Finalization', step: /\bpm review\b/i },
  { status: 'Approval', step: /^approval$/i, pick: 'last' },
  { status: 'Mobilization', step: /^mobilization\b/i },
  { status: 'Build', step: /\bin progress\b|\bunderway\b/i },
];

/**
 * Right now's lists placed on the steps → Map(stepKey → [{ status, n, names }])
 * (stepKey: `${part}-${n}`; applicants by status, jobs by JobTread status)
 */
export function placeNow(track, steps, now) {
  const out = new Map();
  if (!now) return out;
  const lists = { Applied: now.applied, 'In Review': now.inReview, ...(now.jobs || {}) };
  for (const r of STATUS_STEPS) {
    if (r.track && r.track !== track) continue;
    const v = lists[r.status];
    if (!v?.n) continue;
    const hits = steps.filter((s) => r.step.test(s.t.trim()));
    const s = r.pick === 'last' ? hits.at(-1) : hits[0];
    if (!s) continue;
    const key = `${s.part}-${s.n}`;
    out.set(key, [...(out.get(key) || []), { status: r.status, n: v.n, names: v.names || [] }]);
  }
  return out;
}

/** Every automation the rules can name (a test checks each is on the map) */
export function ruleTitles() {
  const all = new Set();
  for (const r of [...LINE_RULES, ...STEP_RULES]) for (const k of ['autos', 'makeover', 'community']) (r[k] || []).forEach((t) => all.add(t));
  for (const s of [...APPLYING, ...Object.values(MONEY).flat()]) for (const i of s.items) (i.autos || []).forEach((t) => all.add(t));
  return [...all];
}

const named = (r, track) => [...(r[track] || []), ...(r.autos || [])];
const uniq = (list) => [...new Set(list)];

/**
 * A track's steps with their automations pinned:
 *   [{ part: 'applying'|'doc', n, t, items: [{ t, autos, items }], autos }]
 * `autos` on a line are its own; on a step, the ones that run through it and
 * aren't already on one of its lines. Doc steps keep the Doc's numbering.
 */
export function pinSteps(track, docSteps = []) {
  // The Docs' lines are read by the rules; the built-in steps' lines name their own (none: by hand)
  const pinItems = (items, step, part) => (items || []).map((i) => ({
    t: i.t,
    autos: uniq(part === 'doc' ? LINE_RULES.filter((r) => r.re.test(i.t) && (!r.step || r.step.test(step))).flatMap((r) => named(r, track)) : i.autos || []),
    items: pinItems(i.items, step, part),
  }));
  const onLines = (items, out = new Set()) => { for (const i of items) { i.autos.forEach((t) => out.add(t)); onLines(i.items, out); } return out; };
  const pin = (part) => (s, idx) => {
    const items = pinItems(s.items, s.t, part);
    const lined = onLines(items);
    // A Doc step's own name can be a line's too ("Fill out online application"); the built-in steps name their own
    const self = part === 'doc' ? LINE_RULES.filter((r) => r.re.test(s.t) && !r.step).flatMap((r) => named(r, track)) : [];
    const whole = STEP_RULES.filter((r) => r.re.test(s.t.trim())).flatMap((r) => named(r, track));
    return { part, n: idx + 1, t: s.t, items, autos: uniq([...self, ...whole]).filter((t) => !lined.has(t)) };
  };
  if (MONEY[track]) return MONEY[track].map((s, idx) => ({ ...pin('money')(s, idx), ...(s.policy ? { policy: s.policy } : {}), ...(s.check ? { check: s.check } : {}) }));
  return [...(track === 'makeover' ? APPLYING.map(pin('applying')) : []), ...docSteps.map(pin('doc'))];
}

/** How many lines a list of steps has (a step's own name not counted), and how many of them an automation does */
export function lineCounts(steps) {
  let lines = 0;
  let auto = 0;
  const walk = (items) => { for (const i of items) { lines++; if (i.autos.length) auto++; walk(i.items); } };
  steps.forEach((s) => walk(s.items));
  return { lines, auto };
}
