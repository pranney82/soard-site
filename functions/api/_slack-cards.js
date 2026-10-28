/**
 * Slack cards: one look for everything the website posts to Slack.
 *
 *   📝 Headline                      header block: icon + a few words
 *   🧪 Test · nothing real happened   only for test data
 *   What happened, in a sentence.    the lead (several lines read as a list)
 *   Label: value                     facts: one line each, so they read the
 *   Label: value                     same in a wide channel, a thread or a phone
 *   What to do                       problems only
 *   [ Main action ]  [ Other ]       buttons; the first one is the main one
 *   Where it came from · when        footer: small grey line
 *
 * `text` is what lock screens and desktop notifications show: the headline
 * and the lead's first line, never a URL. `plain` is the whole card as text,
 * sent if Slack ever refuses the blocks, so nothing is lost.
 *
 * Icons name the kind of event, not a traffic light. Problems are ⚠️ (or 🚨
 * when something is failing right now) and turn into ✅ when they clear.
 */

const MAX_HEADER = 150; // Slack's header limit
const MAX_SECTION = 3000;
const MAX_BUTTON = 75;

/** Escape text for Slack mrkdwn (and the top-level text, which Slack parses too). */
export function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const cut = (s, n) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);
const clean = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const lines = (s) => String(s ?? '').split('\n').map((l) => l.trimEnd()).filter((l) => l.trim());
const noUrls = (s) => s.replace(/https?:\/\/\S+/g, '').replace(/\s{2,}/g, ' ').trim();

/** A link inside mrkdwn text. */
export function link(url, label) {
  return `<${String(url).replace(/[<>|]/g, '')}|${esc(label)}>`;
}

/**
 * "peter@soardcharity.com" → "Peter"; "jane.doe@x.org" → "Jane Doe". A shared
 * inbox (info@, hello@) stays the address, since no one person sent it.
 */
export function personName(email) {
  const s = String(email || '').trim();
  const local = s.split('@')[0] || '';
  if (!local || !s.includes('@')) return s || 'someone';
  if (/^(info|hello|admin|team|office|contact|support|noreply|no-reply|staff|website)$/i.test(local)) return s;
  const words = local.split(/[._-]+/).filter((w) => /^[a-z]+$/i.test(w));
  if (!words.length) return s;
  return words.map((w) => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

/**
 * Build a card. Every part but `title` is optional.
 * @param {object} c
 * @param {string} c.icon       one emoji for the kind of event
 * @param {string} c.title      the headline (plain text)
 * @param {string|true} [c.test] mark as test data: true, or the words to show
 * @param {string} [c.lead]     what happened; newlines become separate lines
 * @param {Array<[string, any]|{label, value}>} [c.facts] label/value pairs; empty values are left out
 * @param {string} [c.fix]      what to do about it
 * @param {Array<{label, url}>} [c.buttons] up to 5; the first is the main one
 * @param {string|string[]} [c.footer] small grey line(s)
 * @param {string} [c.notify]   the notification line, if the default isn't right
 * @param {'here'} [c.mention]  @here: buzzes everyone active in the channel (live problems only)
 * @returns {{ text: string, blocks: object[], plain: string }}
 */
export function slackCard({ icon = '', title, test, lead, facts = [], fix, buttons = [], footer, notify, mention } = {}) {
  const head = cut(clean(`${icon} ${title || ''}`), MAX_HEADER);
  const blocks = [{ type: 'header', text: { type: 'plain_text', text: head, emoji: true } }];
  const testWords = test ? (test === true ? 'Test · nothing real happened' : String(test)) : null;
  if (testWords) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `🧪 *${esc(testWords)}*` }] });
  const here = mention === 'here' && !testWords; // a test never pings people
  if (here) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: '<!here> needs someone right now' }] });

  const leadLines = lines(lead);
  if (leadLines.length) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: cut(leadLines.map(esc).join('\n'), MAX_SECTION) } });

  const pairs = facts
    .map((f) => (Array.isArray(f) ? { label: f[0], value: f[1] } : f))
    .filter((f) => f && f.label && f.value != null && clean(f.value) !== '')
    .slice(0, 10);
  if (pairs.length) {
    // Not Slack's two-column fields: those stack label over value in a thread or on a phone
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: cut(pairs.map((f) => `*${esc(f.label)}:* ${esc(clean(f.value))}`).join('\n'), MAX_SECTION) } });
  }

  if (clean(fix)) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: cut(`*What to do*\n${lines(fix).map(esc).join('\n')}`, MAX_SECTION) } });

  const btns = buttons.filter((b) => b?.url && b?.label).slice(0, 5);
  if (btns.length) {
    blocks.push({
      type: 'actions',
      elements: btns.map((b, i) => ({
        type: 'button',
        action_id: `open-${i}`,
        text: { type: 'plain_text', text: cut(clean(b.label), MAX_BUTTON), emoji: true },
        url: String(b.url).slice(0, 3000),
        ...(i === 0 ? { style: 'primary' } : {}),
      })),
    });
  }

  const foot = (Array.isArray(footer) ? footer : [footer]).map(clean).filter(Boolean);
  if (foot.length) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: esc(foot.join('  ·  ')) }] });

  const first = leadLines[0] ? noUrls(clean(leadLines[0])) : '';
  // Tests say so on the lock screen too
  const text = `${here ? '<!here> ' : ''}${esc(notify ? clean(notify) : cut(`${testWords ? '🧪 Test · ' : ''}${head}${first ? `\n${first}` : ''}`, 240))}`;

  const plain = [
    head,
    testWords ? `🧪 ${testWords}` : null,
    ...leadLines,
    ...pairs.map((f) => `${f.label}: ${clean(f.value)}`),
    clean(fix) ? `What to do: ${lines(fix).join(' ')}` : null,
    ...btns.map((b) => `${b.label}: ${b.url}`),
    foot.length ? foot.join(' · ') : null,
  ].filter(Boolean).map(esc).join('\n');

  return { text, blocks, plain: here ? `<!here> ${plain}` : plain };
}

/** The same card, cleared: ✅, the headline, how it ended. For editing the first post in place. */
export function resolvedCard({ title, lead, footer }) {
  return slackCard({ icon: '✅', title, lead, footer });
}

/**
 * The hello posted when a channel is picked in the admin: proves the app can
 * post there and says what will. `role` 'news' | 'attention'; `shared` when
 * alerts that need a hand have no channel of their own yet.
 */
export function helloCard({ role, who, shared = false, adminUrl }) {
  const common = { buttons: [{ label: 'Open the admin', url: adminUrl }], footer: 'To change it, pick another channel in Reveals → Settings → Alerts.' };
  if (role === 'finance') {
    return slackCard({
      icon: '💵', title: 'Money alerts will post here', ...common,
      lead: `${who} picked this channel in the admin for SOARD's money: makeover budgets passing 80% and 100%, odd charges, bills waiting for approval, vendors missing a W-9 or insurance certificate, the cash forecast running low, and the month-end close. Keep it private: only the people who handle money.`,
    });
  }
  if (role === 'applications') {
    return slackCard({
      icon: '🏡', title: 'Makeover applications will post here', ...common,
      lead: `${who} picked this channel in the admin for the makeover team: new applications, families replying to a message (with a Reply button that answers in the same conversation), approvals that make a JobTread job, and application problems.`,
    });
  }
  return role === 'attention'
    ? slackCard({
      icon: '👋', title: 'Website alerts that need a hand will post here', ...common,
      lead: `${who} picked this channel in the admin. Problems during a live reveal, stuck applications, reveal invites and countdowns show up here. Updates on a problem reply under its first post and show in the channel too, and the first post turns ✅ when it’s fixed. Something failing during a live reveal pings whoever is active here, so phones buzz.`,
    })
    : slackCard({
      icon: '🎉', title: 'Good news from the website will post here', ...common,
      lead: `${who} picked this channel in the admin for the moments everyone celebrates: gifts, new applications, reveals going live and their replays.${shared ? '\nUntil a Needs attention channel is picked, alerts that need a hand post here too.' : ''}`,
    });
}
