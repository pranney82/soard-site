/**
 * The alert design, shown once in Slack
 * ======================================
 * A test run in the Needs attention channel: every kind of message the site
 * sends, each as its own post the way the real ones land, built by the same
 * code with made-up names. Each says it's a test and where the real ones
 * post. The problems play out for real: the problem posts, a reminder replies
 * in its thread and the channel, then a reply says it's fixed and the first
 * post is edited into a short ✅. Nothing is emailed, nothing is remembered as an open problem, and the
 * @here sample shows the mention without pinging anyone.
 *
 * Runs on the hub heartbeat once per SLACK_PREVIEW: the first heartbeat after
 * a deploy that changes it posts the top message and five replies, and each
 * minute after that five more (Slack's pace for one channel), until all are
 * in. It posts in the Needs attention channel, and waits until one of its own
 * is picked, so the channel everyone talks in never gets a test thread twice. A lease in site_config "slack-preview" keeps two heartbeats from posting
 * the same batch; progress and any error are kept there too.
 */

import { readSlackConfig, slackPost, adminCard, SITE_ORIGIN } from './_broadcast-notify.js';
import { slackCard, personName, helloCard } from './_slack-cards.js';
import { staffSlack, stuckCard } from './_applications.js';
import { giftMessage } from './_zeffy.js';
import { slackText as goNoGo } from './_broadcast-preflight.js';

export const SLACK_PREVIEW = '2026-10-21-cards'; // the second look: one line per fact
export const SLACK_PREVIEW_KEY = 'slack-preview';
const PER_RUN = 5;
const LEASE_MS = 90e3;
const GAP_MS = 1100; // about one post a second, as Slack asks
const MAX_TRIES = 5;

const ADMIN = `${SITE_ORIGIN}/admin/#broadcast`;
const CONTROL = `${SITE_ORIGIN}/admin/#broadcast/control-room`;
const JT = 'https://app.jobtread.com';

/**
 * Every message the site sends, in the order they're shown:
 * [{ group, label, step?, kind, card, act: 'post'|'reply'|'edit', story? }].
 * A reply (in the thread and the channel) or edit acts on the first post of
 * the same story.
 */
export function previewSamples() {
  const app = {
    id: 'preview', year: '2027', is_test: 0, lang: 'es', submitted_at: '2026-10-20T19:03:00Z',
    answers: { childName: { first: 'Maya', last: 'Lopez' }, birthdate: '2019-03-14', makeoverTypes: ['Accessible Bathroom'], county: 'Cobb', previouslyApplied: 'Yes', referredBy: 'Children’s Healthcare of Atlanta' },
    files: { video: { uid: 'v' }, photo1: { key: 'p1' }, photo2: { key: 'p2' }, photo3: { key: 'p3' } },
    jt_state: { area: { status: 'inside' }, repeat: { matches: [{ name: 'Maya Lopez', year: '2025' }] } },
  };
  const testApp = {
    ...app, is_test: 1, lang: 'en',
    answers: { ...app.answers, childName: { first: 'TEST', last: 'Applicant' }, previouslyApplied: 'No', referredBy: 'Website admin test' },
    jt_state: { area: { status: 'outside', miles: 6.2 }, repeat: { matches: [] } },
  };
  const gift = (o = {}) => ({ id: 'preview', amount: 5000, currency: 'usd', created: Math.floor(Date.parse('2026-10-20T19:44:00Z') / 1000), buyer: { first_name: 'Jane', last_name: 'Doe' }, description: 'Help Build a Brighter Home', ...o });
  const state = { title: 'Max’s room reveal', scheduledAt: '2026-10-24T20:00:00Z' };
  const checks = (open) => ({
    ready: !open.some((i) => i.status === 'fail'),
    counts: { ok: 14 - open.length, warn: open.filter((i) => i.status === 'warn').length, fail: open.filter((i) => i.status === 'fail').length, unknown: 0 },
    items: [...Array.from({ length: 14 - open.length }, () => ({ status: 'ok' })), ...open],
  });
  const silent = { level: 'error', title: 'Reveal audio is silent', detail: 'No sound reaching the site, Facebook or YouTube.', fix: 'Check the mic: receiver plugged into the phone, transmitter switched on and unmuted, Larix not muted.', url: CONTROL };
  const unstuck = slackCard({ icon: '✅', title: 'Unstuck: Maya Lopez’s application', lead: 'It loaded into JobTread on its own after 6 tries. Nothing to do.', buttons: [{ label: 'Open the application', url: `${SITE_ORIGIN}/admin/#applications` }] });
  const resolved = (title, summary) => slackCard({ icon: '✅', title: `Resolved: ${title}`, lead: summary });
  // Good news posts are marked; everything else needs attention
  const NEWS = new Set(['New application', 'Applications open on schedule', 'Applications close on schedule', 'Waitlist email going out', 'Gift', 'Monthly gift from a company', 'Major gift ($1,000 and up)', 'Countdown is up', 'Reveal moved', 'Live now', 'Ended', 'Instagram Reel posted']);
  const s = (group, label, card, step = null, act = 'post', story = null) => ({ group, label, step, kind: NEWS.has(label) ? 'news' : 'attention', card, act, story });
  return [
    s('Applications', 'New application', staffSlack(app, '22PpreviewA1')),
    s('Applications', 'Test application', staffSlack(testApp, '22PpreviewA2')),
    s('Applications', 'Stuck, then fixes itself', stuckCard(app, { attempts: 4, error: 'account: JobTread answered 503', again: false }), null, 'post', 'stuck'),
    s('Applications', 'Stuck, then fixes itself', unstuck, 'it got through: the reply, in its thread and the channel', 'reply', 'stuck'),
    s('Applications', 'Stuck, then fixes itself', resolved('Maya Lopez’s application was stuck', 'It got through on its own.'), 'and the stuck post, edited', 'edit', 'stuck'),
    s('Applications', 'Applications open on schedule', slackCard({ icon: '📬', title: 'Applications are open for 2027', lead: 'They opened on schedule, so families can apply now.', buttons: [{ label: 'See the form', url: `${SITE_ORIGIN}/apply/form/` }, { label: 'Open Applications', url: `${SITE_ORIGIN}/admin/#applications` }] })),
    s('Applications', 'Applications close on schedule', slackCard({ icon: '📪', title: 'Applications are closed for 2027', lead: 'They closed on schedule. Families who already started can still finish.', buttons: [{ label: 'Open Applications', url: `${SITE_ORIGIN}/admin/#applications` }] })),
    s('Applications', 'Waitlist email going out', slackCard({ icon: '📨', title: 'The applications-open email is going out to 214 families', lead: '2027 applications are open and the families who asked are being told (188 in English, 26 in Spanish). 214 families through Kit.', buttons: [{ label: 'Open the waitlist', url: `${SITE_ORIGIN}/admin/#applications/settings` }], footer: 'Applications waitlist' })),
    s('Gifts', 'Gift', giftMessage(gift())),
    s('Gifts', 'Monthly gift from a company', giftMessage(gift({ amount: 2500, recurring: { interval: 'month' }, buyer: { first_name: 'Ann', last_name: 'Lee', is_corporate: true, company_name: 'Pulte Homes' } }))),
    s('Gifts', 'Major gift ($1,000 and up)', giftMessage(gift({ amount: 250000, buyer: { first_name: 'Ben', last_name: 'Wood' }, description: 'Golf Classic 2026' }))),
    s('Reveals', 'Countdown is up', adminCard({ level: 'info', icon: '⏳', title: 'Countdown is up: Max’s reveal', detail: 'Saturday, October 24 at 4:00 PM. It’s confirmed in JobTread, so the site put up the countdown and reminder signup. Reminders go out the day before and an hour before.', url: ADMIN, links: [{ label: 'Live page', url: `${SITE_ORIGIN}/live/` }, { label: 'JobTread schedule', url: JT }] })),
    s('Reveals', 'Reveal moved', adminCard({ level: 'info', icon: '📅', title: 'Reveal moved: Max', detail: 'From Saturday, October 24 at 4:00 PM to Sunday, October 25 at 2:00 PM, as changed in JobTread. The countdown follows. Everyone who signed up for reminders hears about the new date.', url: ADMIN, links: [{ label: 'JobTread schedule', url: JT }] })),
    s('Reveals', 'Can’t put the countdown up, then fixed', adminCard({ level: 'warn', title: 'No countdown yet: Adrian Scala (2025)', detail: '"Adrian Scala (2025)" is confirmed for Monday, October 26, but no kid page is filed under 2025 with that name. Adrian’s page is filed under 2026.', fix: 'Make the years agree: change the year in the JobTread job name, or on Adrian’s kid page.', url: ADMIN, links: [{ label: 'JobTread schedule', url: JT }] }), null, 'post', 'countdown'),
    s('Reveals', 'Can’t put the countdown up, then fixed', resolved('No countdown yet: Adrian Scala (2025)', 'JobTread and the site agree now, so the countdown goes up when it’s the next reveal.'), 'fixed: the first post, edited', 'edit', 'countdown'),
    s('Reveals', 'Can’t put the countdown up, then fixed', slackCard({ icon: '✅', title: 'Countdown unblocked: Adrian Scala (2025)', lead: 'JobTread and the site agree now, so the countdown goes up when it’s the next reveal.' }), 'fixed: the reply, in its thread and the channel', 'reply', 'countdown'),
    s('Reveals', 'Reveal invite problem', slackCard({ icon: '⚠️', title: 'Reveal invite problem: Isla', lead: 'The calendar invite for Isla couldn’t be updated. Google or JobTread said: Google Calendar answered 503', fix: 'Open Reveals in the admin, open this reveal under Upcoming reveals and press Retry. If it keeps failing, check the job in JobTread.', buttons: [{ label: 'Open Reveals', url: ADMIN }, { label: 'JobTread schedule', url: JT }], footer: 'Reveal calendar invites' })),
    s('Reveals', 'Invite still out', slackCard({ icon: '📅', title: 'Isla’s reveal invite is still out', lead: 'JobTread says: the job is closed. The calendar invite hasn’t been cancelled; the site never cancels one on its own.', fix: 'If the reveal is off, delete the event in the organizer’s Google Calendar and choose to email the guests. If the reveal is still on, there is nothing to do.', buttons: [{ label: 'Open Reveals', url: ADMIN }, { label: 'JobTread schedule', url: JT }], footer: 'Reveal calendar invites' })),
    s('Reveals', 'Kid profile hidden', slackCard({ icon: '⚠️', title: 'Max’s profile is hidden', lead: 'JobTread marks Max’s job Denied, so the site took their profile off Meet the Kids. Everything is kept in the admin.', fix: 'If that’s a mistake, change the job’s Status in JobTread and the profile comes back by itself.', buttons: [{ label: 'Open the job in JobTread', url: JT }, { label: 'Open Kids', url: `${SITE_ORIGIN}/admin/#kids-hub` }] })),
    s('Live broadcast', 'Go/no-go: all clear', adminCard({ ...goNoGo(checks([]), state, {}), url: CONTROL, context: 'Automatic check an hour before' })),
    s('Live broadcast', 'Go/no-go: no-go', adminCard({ ...goNoGo(checks([{ status: 'fail', label: 'The phone isn’t streaming yet', fix: 'Open Larix on the reveal phone and press record.' }, { status: 'warn', label: 'No mic check today', fix: 'Do a 30-second rehearsal stream.' }]), state, {}), url: CONTROL, context: 'Automatic check 10 minutes before' })),
    s('Live broadcast', 'Live now', adminCard({ level: 'info', icon: '📡', title: 'Live now: Max’s room reveal', detail: 'The site, Facebook and YouTube are all showing it.', facts: [['Started from', 'The phone']], url: `${SITE_ORIGIN}/live/`, links: [{ label: 'Open the control room', url: CONTROL }] })),
    s('Live broadcast', 'Live problem, reminder, then fixed', adminCard({ ...silent, context: 'Max’s room reveal · live 6 min', mention: 'here' }), 'with the channel ping shown, not sent', 'post', 'silent'),
    s('Live broadcast', 'Live problem, reminder, then fixed', adminCard({ ...silent, title: `Still: ${silent.title}`, detail: `${silent.detail} Going on 3 min.`, context: 'Max’s room reveal · live 9 min' }), 'three minutes later: the reminder, in its thread and the channel', 'reply', 'silent'),
    s('Live broadcast', 'Live problem, reminder, then fixed', resolved(silent.title, 'Reveal audio is back. It lasted 4 min.'), 'sound is back: the first post, edited', 'edit', 'silent'),
    s('Live broadcast', 'Live problem, reminder, then fixed', adminCard({ level: 'info', title: 'Reveal audio is back', detail: 'It lasted 4 min.', url: CONTROL, context: 'Max’s room reveal · live 10 min', resolves: 'preview' }), 'sound is back: the reply, in its thread and the channel', 'reply', 'silent'),
    s('Live broadcast', 'Ended', adminCard({ level: 'info', icon: '🎬', title: 'Ended: Max’s room reveal', detail: 'Ran 42 minutes.\nReplay will attach to the kid’s page when Stream finishes processing.', url: `${SITE_ORIGIN}/admin/` })),
    s('Live broadcast', 'Instagram Reel posted', adminCard({ level: 'info', icon: '📱', title: 'Instagram Reel posted: Max’s room reveal', detail: 'Cut 12:40 to 13:35 of the recording (picked by loudness).', url: 'https://www.instagram.com/' })),
    s('Live broadcast', 'Health check failed', adminCard({ level: 'error', title: 'Reveal-day check found problems', detail: '• Facebook token failed: the token expired\n• Real-time hub unreachable: timeout', url: `${SITE_ORIGIN}/admin/` })),
    { ...s('Setup', 'Good news channel picked in the admin', helloCard({ role: 'news', who: personName('peter@soardcharity.com'), adminUrl: `${SITE_ORIGIN}/admin/` })), kind: 'news' },
    s('Setup', 'Needs attention channel picked in the admin', helloCard({ role: 'attention', who: personName('peter@soardcharity.com'), adminUrl: `${SITE_ORIGIN}/admin/` })),
  ];
}

/** The first post of the test run */
export function previewIntro(count) {
  return slackCard({
    icon: '🧪',
    title: 'Test run: every alert the website sends',
    lead: `The next posts are every kind of alert, exactly as they really post, with made-up names. Each one says it’s a test and which channel the real ones use.\nThe problems play out for real: the problem posts, updates reply under it and show in the channel too, and the first post turns ✅ when it’s fixed.`,
    footer: 'Sent once by the website. Nothing real happened.',
  });
}

/** The last post: the run is over */
export function previewClosing(count) {
  return slackCard({ icon: '✅', title: 'That’s the whole test run', lead: `All ${count} test posts are in. From here on, only real alerts post here.` });
}

/** A sample with a small caption on top: a test, which one, and where the real ones post */
function captioned({ group, label, step, kind, card }, n, total, where) {
  const caption = `🧪 *Test ${n} of ${total}* · ${group} · ${label}${step ? ` · ${step}` : ''} · real ones post ${kind === 'news' ? `in ${where.news}` : 'here'}`;
  return { ...card, blocks: [{ type: 'context', elements: [{ type: 'mrkdwn', text: caption }] }, ...card.blocks] };
}

async function readState(DB) {
  const row = await DB.prepare('SELECT data FROM site_config WHERE key = ?').bind(SLACK_PREVIEW_KEY).first().catch(() => null);
  let state = null;
  try { state = row ? JSON.parse(row.data) : null; } catch { state = null; }
  return { raw: row?.data ?? null, state };
}

/** Replace the row only if it still holds `raw` (null: only if there is none). True when this caller won. */
async function swap(DB, raw, next) {
  const at = new Date().toISOString();
  const r = raw == null
    ? await DB.prepare('INSERT OR IGNORE INTO site_config (key, data, updated_at) VALUES (?, ?, ?)').bind(SLACK_PREVIEW_KEY, JSON.stringify(next), at).run()
    : await DB.prepare('UPDATE site_config SET data = ?, updated_at = ? WHERE key = ? AND data = ?').bind(JSON.stringify(next), at, SLACK_PREVIEW_KEY, raw).run();
  return (r.meta?.changes || 0) === 1;
}

/**
 * One heartbeat's share of the preview. Never throws.
 * → null (nothing to do) or { posted, next, total, done, error? }
 */
export async function maybeSlackPreview(env, { now = Date.now(), gapMs = GAP_MS } = {}) {
  try {
    if (!env.DB || !env.SLACK_BOT_TOKEN) return null;
    const cfg = await readSlackConfig(env.DB, { fresh: true });
    const channel = cfg.attention?.id && cfg.attention.id !== cfg.channel?.id ? cfg.attention.id : null;
    if (!channel) return null; // waits for a Needs attention channel of its own
    const where = { news: `#${cfg.channel.name}`, attention: cfg.attention?.id ? `#${cfg.attention.name}` : 'the Needs attention channel' };
    const { raw, state } = await readState(env.DB);
    const mine = state?.id === SLACK_PREVIEW ? state : null;
    if (mine?.done) return null;
    if (mine?.leaseUntil && mine.leaseUntil > now) return null;
    const leased = { ...(mine || { id: SLACK_PREVIEW, startedAt: new Date(now).toISOString(), next: 0, tries: 0 }), leaseUntil: now + LEASE_MS };
    if (!(await swap(env.DB, raw, leased))) return null; // another heartbeat has it
    let s = leased;
    const save = async (patch) => {
      const { raw: cur } = await readState(env.DB);
      s = { ...s, ...patch };
      await swap(env.DB, cur, s);
    };

    const samples = previewSamples();
    const fail = async (error) => {
      const tries = (s.tries || 0) + 1;
      await save({ leaseUntil: 0, tries, error, ...(tries >= MAX_TRIES ? { done: true } : {}) });
      return { posted: 0, next: s.next, total: samples.length, done: tries >= MAX_TRIES, error };
    };
    if (!s.intro) {
      const r = await slackPost(env, previewIntro(samples.length), { channel });
      if (!r.ok || !r.ts) return fail(r.error || 'Slack did not take the post');
      // Kept right away: a crash below must never lead to a second intro
      await save({ intro: { channel: r.channel || channel, ts: r.ts }, refs: {}, tries: 0, error: null });
    }

    // A test never pings anyone. Slack turns even the plain words into a real
    // mention, so the sample shows it with a full-width at sign, which it never does
    const SHOWN = '\uFF20here';
    const quiet = (c) => ({ ...c, text: c.text.replace(/^<!here> /, `${SHOWN} `), plain: c.plain.replace(/^<!here> /, `${SHOWN} `), blocks: c.blocks.map((b) => (b.type === 'context' ? { ...b, elements: b.elements.map((e) => ({ ...e, text: e.text.replace('<!here>', SHOWN) })) } : b)) });
    let posted = 0;
    let error = null;
    while (s.next < samples.length && posted < PER_RUN) {
      if (posted) await new Promise((res) => setTimeout(res, gapMs));
      const item = samples[s.next];
      const card = quiet(captioned(item, s.next + 1, samples.length, where));
      const ref = item.story ? s.refs?.[item.story] : null;
      let r;
      if (item.act === 'post') r = await slackPost(env, card, { channel });
      else if (!ref) r = { ok: true, skipped: true }; // its post never landed: nothing to act on
      else if (item.act === 'edit') r = await slackPost(env, card, { update: ref });
      else r = await slackPost(env, card, { thread: { ...ref, broadcast: true } });
      if (!r.ok) { error = r.error || 'Slack did not take the post'; break; }
      const refs = item.act === 'post' && item.story && r.ts ? { ...(s.refs || {}), [item.story]: { channel: r.channel || channel, ts: r.ts } } : s.refs;
      await save({ next: s.next + 1, refs, tries: 0 });
      posted++;
    }
    if (!error && s.next >= samples.length && !s.closed) {
      const r = await slackPost(env, previewClosing(samples.length), { channel });
      if (r.ok) s = { ...s, closed: true };
      else error = r.error || 'Slack did not take the post';
    }
    const tries = error ? (s.tries || 0) + 1 : 0;
    const done = !!s.closed || tries >= MAX_TRIES;
    await save({ leaseUntil: 0, tries, error, done, ...(done ? { finishedAt: new Date(now).toISOString() } : {}) });
    return { posted, next: s.next, total: samples.length, done, ...(error ? { error } : {}) };
  } catch (e) {
    return { posted: 0, error: e.message };
  }
}
