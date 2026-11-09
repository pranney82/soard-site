/**
 * Running the Advisory Board
 * ===========================================================================
 * One module, drawn in two places, so there's one thing to keep right:
 *   - Board in the staff admin, behind the Board | Advisory switch (./board-admin.js), for Peter and Holly
 *   - Run it on the advisors' page (./advisory/portal.js), for Mary Atchley, who runs the group and signs in as a board
 *     member, so she can't open the staff admin at all
 * Its look is its own (the ar- classes below, on its own tokens) because neither page's stylesheet exists on the other.
 *
 * The same three tabs as Board, the same words in the same place:
 *   Meetings    ./advisory-meeting.js
 *   Documents   the papers advisors read and sign, and the words on their Fundraise page, each edited here
 *   Members     what's waiting on you, this month's ask, who we're looking for, the goal, advisory@, the people, the makeover
 *               (the kid sits apart from the dollars, at the foot of the page: the reveal belongs to the family)
 * Server: /api/advisory-admin.
 */

import { h, htm, useState, useEffect, useRef } from './vendor.js';
import { ask, askToLeave } from './ask.js';
import { viewerLink, sizeText } from './file-viewer.js';
import { shortDate, isDate, todayEastern } from './board-shared.js';
import { ReportEditor } from './board-report.js';
import { AdvisoryMeetings } from './advisory-meeting.js';
import { api } from './advisory/api.js';
import { Thermometer } from './advisory/thermometer.js';
import { ZeffyFormSelect, useZeffyFormList, sameForm } from './zeffy-forms.js';

const html = htm.bind(h);
const API = '/api/advisory-admin';

/** One call: { ok, status, ... } (never throws) */
export const call = (body, { form = null, query = '' } = {}) => api(`${API}${query}`, body, { form });
/** The Zeffy form dropdowns read SOARD's forms through this page's own route: Mary can't reach the staff one */
const ZEFFY_FROM = { key: 'advisory', load: () => call(null, { query: '?zeffyForms=1' }) };

const TABS = [['meetings', 'Meetings'], ['documents', 'Documents'], ['members', 'Members']];
const dollars = (n) => `$${Math.round(Number(n) || 0).toLocaleString('en-US')}`;
const first = (n) => String(n || '').split(/\s+/)[0];
const dayOf = (iso) => (iso ? shortDate(todayEastern(Date.parse(iso))) : '');
const fileUrl = (f) => `/api/advisory-file?id=${encodeURIComponent(f.id)}`;
const viewerFiles = (files) => files.map((f) => ({ name: f.name, type: f.type, size: f.size, at: f.at, url: fileUrl(f) }));
const introNew = (i) => i.status === 'thanks' && !i.updatedBy;
const TODAY = () => todayEastern();
/** A signature that still counts: this term's, on the words as they are now (the page asks the advisor again otherwise) */
const signedNow = (sig, doc, term = null) => !!sig && sig.version === (doc.version || 1) && String(sig.at).slice(0, 10) >= (term?.renewedOn || term?.started || '');

/**
 * Words to start from, so nobody meets a blank page. They come from the overview and the public site, and whoever runs
 * the group edits them before anyone sees them (a paper is only on the page once it's saved).
 */
export const STARTERS = {
  agreement: { title: 'Advisor Agreement', body: 'As a member of the Sunshine on a Ranney Day Advisory Board, I agree to:\n\n- Serve a one-year term, renewable each year\n- Attend at least four meetings a year, plus ad hoc support as needed\n- Help the group raise the funds for one SOARD makeover each year\n- Make introductions to potential donors, sponsors, partners, and volunteers\n- Serve as a positive ambassador for SOARD and the families it serves\n- Keep what I learn about families private\n\nThe Advisory Board is advisory and ambassadorial in nature. Members do not hold fiduciary, governance, operational, budgetary, staffing, or voting authority.' },
  overview: { title: 'Advisory Board Overview', body: '' },
  pitch: { title: 'Your 30-second pitch', body: 'Sunshine on a Ranney Day builds free dream bedrooms, accessible bathrooms, and therapy rooms for children with special needs in Atlanta. Every child deserves a space that makes them feel safe, seen, and loved. I serve on the Advisory Board, and together we’re raising the funds for one makeover this year. I’d love to tell you about it.' },
  post: { title: 'A post to share', body: 'I’m proud to serve on the Advisory Board of Sunshine on a Ranney Day. They build free dream bedrooms, accessible bathrooms, and therapy rooms for children with special needs in Atlanta. This year our group is raising the funds for one makeover: a real room for a real child. If you’d like to help, here’s my page.' },
  sponsor: { title: 'Sponsor one-pager', body: 'A sponsorship funds a free makeover for a child with special needs in Atlanta: a real room, for a real child.\n\nCompanies can sponsor through a gift, a matched gift, or an event. If you know a company that might want to, introduce them on the Introductions page and SOARD will take it from there.' },
  matching: { title: 'Employer matching steps', body: 'Many employers match what their people give. Here’s how to find out.\n\n1. Ask your HR team whether your company matches gifts to nonprofits.\n2. Give through your page, and keep the receipt Zeffy emails you.\n3. Send your employer’s matching form to SOARD with that receipt.' },
  hosting: { title: 'How to host a fundraiser', body: 'A dinner, a game night, a company drive: small fundraisers add up. Here’s how it works.\n\n1. Send your idea from this page: what it is, when, and where.\n2. SOARD reviews it and says yes or suggests changes. Every member-hosted fundraiser is approved first.\n3. Once it’s approved, you get a giving page for it, so every gift counts toward the group’s goal.' },
};
const PAPERS = ['agreement', 'overview'];
const WORDS = ['pitch', 'post', 'sponsor', 'matching', 'hosting'];

// ═══════════════════════════════════════════════════════════════════
// The area
// ═══════════════════════════════════════════════════════════════════
/**
 * tab: which tab, from the page's address. embedded: on the advisors' page, where it draws its own tabs (Board's are
 * above it in the staff admin). onTab: asked to change tabs. addToast (staff admin) or say (advisors' page) tells of a save.
 */
export function AdvisoryArea({ tab = 'meetings', onTab = null, embedded = false, addToast = null, say = null, onDirty = null }) {
  addStyles();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(0);
  const running = useRef(new Set());
  // What's typed and not saved, by who's holding it: whoever draws this asks before leaving (onDirty)
  const unsaved = useRef(new Map());
  const noteDirty = (key, where) => {
    if (where) unsaved.current.set(key, where); else unsaved.current.delete(key);
    onDirty?.([...unsaved.current.values()][0] || '');
  };
  const tell = (text, bad = false) => { if (say) say(text, bad ? 'warn' : ''); else addToast?.(text, bad ? 'error' : 'success'); };
  const load = async () => {
    const j = await call();
    if (j.ok) { setData(j); setError(null); } else setError(j);
    return j;
  };
  useEffect(() => {
    load();
    // Back to a tab left open: what changed meanwhile, unless they're in the middle of something here
    let at = Date.now();
    const back = () => {
      if (document.visibilityState !== 'visible' || unsaved.current.size || Date.now() - at < 10 * 1000) return;
      at = Date.now();
      load();
    };
    addEventListener('focus', back);
    document.addEventListener('visibilitychange', back);
    return () => { removeEventListener('focus', back); document.removeEventListener('visibilitychange', back); };
  }, []);
  // A change, then the page as it is now. Says so only when `done` is given; a refusal always says why.
  // The same change pressed twice goes once (a double click, a slow connection)
  const act = async (body, done = '', { raw = false } = {}) => {
    const key = JSON.stringify(body);
    if (running.current.has(key)) return null;
    running.current.add(key);
    setBusy((n) => n + 1);
    try {
      const j = await call(body);
      if (!j.ok) {
        if (raw) return j;
        tell(j.error || 'That didn’t save. Try again.', true);
        if (j.status === 404 || j.status === 409) await load();
        return null;
      }
      if (done) tell(done);
      await load();
      return j;
    } finally {
      running.current.delete(key);
      setBusy((n) => n - 1);
    }
  };
  const ctx = { data, load, act, tell, busy: busy > 0, noteDirty };
  const body = error && !data ? html`<div class="ar-card ar-empty" role="alert"><p class="ar-empty__t">${error.signedOut ? 'Your sign-in ended' : 'This didn’t open'}</p><p class="ar-muted">${error.error || 'Try again.'}</p>${error.signedOut ? html`<button type="button" class="ar-btn ar-btn--go" onClick=${() => location.reload()}>Reload</button>` : html`<button type="button" class="ar-btn" onClick=${load}>Try again</button>`}</div>`
    : !data ? html`<p class="ar-muted ar-loading">Opening…</p>`
      : tab === 'documents' ? html`<${DocsTab} ctx=${ctx} />`
        : tab === 'members' ? html`<${MembersTab} ctx=${ctx} />`
          : html`<${AdvisoryMeetings} data=${data} reload=${load} call=${call} />`;
  return html`<div class=${`ar ${busy > 0 ? 'is-busy' : ''}`}>
    ${embedded ? html`<div class="ar-tabs" role="tablist" aria-label="Running the Advisory Board">
      ${TABS.map(([id, label]) => html`<button type="button" role="tab" aria-selected=${tab === id} class=${tab === id ? 'is-on' : ''} onClick=${() => onTab?.(id)} key=${id}>${label}</button>`)}
    </div>` : null}
    ${body}
  </div>`;
}

/** This thing's unsaved words, for the question before leaving. Gone when it's saved or closed */
function useDirty(ctx, key, where) {
  useEffect(() => { ctx.noteDirty(key, where); return () => ctx.noteDirty(key, ''); }, [key, where]);
}

// ─── Small pieces ───────────────────────────────────────────────────
/** for: the id of the control the name belongs to, when the field holds more than one (a Zeffy link: the dropdown, then the box) */
function Field({ label, hint = '', for: control, children }) {
  return html`<label class="ar-field" for=${control}><span class="ar-field__l">${label}</span>${children}${hint ? html`<span class="ar-field__h" id=${control ? `${control}-hint` : undefined}>${hint}</span>` : null}</label>`;
}
function Card({ title, sub = '', count = null, children, cls = '' }) {
  return html`<section class=${`ar-card ${cls}`}>
    <div class="ar-card__h"><h3>${title}${count ? html`<span class="ar-count">${count}</span>` : null}</h3>${sub ? html`<p class="ar-muted">${sub}</p>` : null}</div>
    ${children}
  </section>`;
}
function Fold({ summary, children }) {
  return html`<details class="ar-fold"><summary>${summary}</summary><div class="ar-fold__b">${children}</div></details>`;
}
/** Anything that can't be undone asks once, in place: the first press says what will happen, the second does it */
function Sure({ label, yes, note = '', onYes, cls = '', disabled = false }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!asking) return html`<button type="button" class=${`ar-btn ${cls}`} disabled=${disabled} onClick=${() => setAsking(true)}>${label}</button>`;
  return html`<span class="ar-sure" role="group" aria-label=${label}>
    ${note ? html`<span class="ar-sure__n">${note}</span>` : null}
    <button type="button" class="ar-btn ar-btn--go" disabled=${busy} onClick=${async () => { setBusy(true); await onYes(); setBusy(false); setAsking(false); }}>${yes}</button>
    <button type="button" class="ar-btn ar-btn--quiet" disabled=${busy} onClick=${() => setAsking(false)}>Keep it as it is</button>
  </span>`;
}
function Toggle({ checked, onChange, label, sub = '', disabled = false }) {
  return html`<label class="ar-toggle">
    <input type="checkbox" role="switch" checked=${checked} disabled=${disabled} onChange=${(e) => onChange(e.currentTarget.checked)} />
    <span class="ar-toggle__t" aria-hidden="true"></span>
    <span class="ar-toggle__w"><strong>${label}</strong>${sub ? html`<span class="ar-muted">${sub}</span>` : null}</span>
  </label>`;
}
const Face = ({ p, size = 36 }) => (p.photo
  ? html`<img class="ar-face" src=${p.photo} alt="" width=${size} height=${size} loading="lazy" />`
  : html`<span class="ar-face ar-face--i" style=${`--s:${size}px`} aria-hidden="true">${String(p.name || '').split(/\s+/).map((w) => w[0]).slice(0, 2).join('')}</span>`);

// ═══════════════════════════════════════════════════════════════════
// Members
// ═══════════════════════════════════════════════════════════════════
function MembersTab({ ctx }) {
  return html`<div class="ar-cols">
    <div class="ar-col ar-col--main">
      <${Waiting} ctx=${ctx} />
      <${AskCard} ctx=${ctx} />
      <${Wishes} ctx=${ctx} />
    </div>
    <div class="ar-col">
      <${Goal} ctx=${ctx} />
      <${GroupCard} ctx=${ctx} />
    </div>
    <div class="ar-wide"><${People} ctx=${ctx} /></div>
    <div class="ar-wide"><${Makeover} ctx=${ctx} /></div>
  </div>`;
}

// ─── What's waiting ─────────────────────────────────────────────────
function Waiting({ ctx }) {
  const { data } = ctx;
  const intros = data.intros.filter(introNew);
  const hosted = data.hosted.filter((x) => x.status === 'new');
  const pages = data.money.unmatched || [];
  const lost = data.money.hostedMissing || [];
  const n = intros.length + hosted.length + pages.length + lost.length;
  const restIntros = data.intros.filter((i) => !introNew(i));
  const restHosted = data.hosted.filter((x) => x.status !== 'new');
  return html`<${Card} title="Waiting on you" count=${n || null} sub=${n ? 'Every introduction gets an answer, so advisors keep making them.' : ''}>
    ${n ? html`<ul class="ar-list">
      ${intros.map((i) => html`<li key=${i.id}><${IntroRow} i=${i} ctx=${ctx} /></li>`)}
      ${hosted.map((x) => html`<li key=${x.id}><${HostedRow} x=${x} ctx=${ctx} /></li>`)}
      ${pages.map((p) => html`<li key=${p.id}><${PageRow} p=${p} ctx=${ctx} /></li>`)}
      ${lost.map((h) => html`<li key=${h.id}><p class="ar-note"><strong>${h.title}</strong>: its gift page can’t be found in Zeffy, so its gifts aren’t counting yet. Check the link on the request below.</p></li>`)}
    </ul>` : html`<p class="ar-muted">Nothing right now. New introductions and fundraiser ideas land here, and you’ll get an email when they do.</p>`}
    ${restIntros.length ? html`<${Fold} summary=${`All introductions (${restIntros.length})`}><ul class="ar-list">${restIntros.map((i) => html`<li key=${i.id}><${IntroRow} i=${i} ctx=${ctx} /></li>`)}</ul><//>` : null}
    ${restHosted.length ? html`<${Fold} summary=${`All fundraisers (${restHosted.length})`}><ul class="ar-list">${restHosted.map((x) => html`<li key=${x.id}><${HostedRow} x=${x} ctx=${ctx} /></li>`)}</ul><//>` : null}
  <//>`;
}

// "Thanks" is what an advisor reads; here it's the step of having taken it in
const statusWord = (st) => (st.id === 'thanks' ? 'Got it' : st.label);

function IntroRow({ i, ctx }) {
  const { data, act } = ctx;
  const help = (i.help || []).map((id) => data.introHelp.find((x) => x.id === id)?.label).filter(Boolean);
  const [note, setNote] = useState(i.note || '');
  const undecided = introNew(i);
  const typed = note !== (i.note || '');
  // Pressing a status moves the focus out of the note first: the press says both, so the note doesn't save on its own
  const choosing = useRef(false);
  useDirty(ctx, `intro-${i.id}`, typed ? `the note on ${i.name}` : '');
  const set = (status) => { choosing.current = false; return act({ action: 'intro-status', id: i.id, status, note }, status === i.status && !undecided ? 'Saved' : `Marked ${statusWord(data.introStatuses.find((x) => x.id === status) || {})}`); };
  return html`<div class="ar-row">
    <div class="ar-row__t"><strong>${i.name}</strong>${i.company ? html`<span class="ar-muted">${i.company}</span>` : null}</div>
    <p class="ar-muted">From ${i.by || 'an advisor'}, ${dayOf(i.at)}</p>
    ${i.how ? html`<p class="ar-quote">${i.how}</p>` : null}
    ${help.length ? html`<div class="ar-tags">${help.map((t) => html`<span class="ar-tag" key=${t}>${t}</span>`)}</div>` : null}
    ${i.email || i.phone ? html`<p class="ar-contact">${i.email ? html`<a href=${`mailto:${i.email}`}>${i.email}</a>` : null}${i.phone ? html`<a href=${`tel:${i.phone.replace(/[^\d+]/g, '')}`}>${i.phone}</a>` : null}</p>` : null}
    <${Field} label="A note for the advisor (they’ll see where it stands)" hint=${undecided && typed ? 'It saves when you pick where this stands.' : ''}>
      <input class="ar-input" value=${note} maxlength="800" onInput=${(e) => setNote(e.currentTarget.value)} onBlur=${() => { if (typed && !undecided && !choosing.current) set(i.status); }} />
    <//>
    <div class="ar-seg" role="group" aria-label=${`Where ${i.name} stands`} onPointerDown=${() => { choosing.current = true; }}>
      ${data.introStatuses.map((st) => html`<button type="button" key=${st.id} aria-pressed=${i.status === st.id && !undecided} onClick=${() => set(st.id)}>${statusWord(st)}</button>`)}
    </div>
    ${data.settings.emails ? html`<p class="ar-muted ar-small">Changing this emails ${first(i.by) || 'the advisor'}.</p>` : null}
  </div>`;
}

function HostedRow({ x, ctx }) {
  const { act, busy } = ctx;
  const [date, setDate] = useState(x.date || '');
  const [giveUrl, setGiveUrl] = useState(x.giveUrl || '');
  const [note, setNote] = useState(x.note || '');
  const held = x.status === 'done';
  useDirty(ctx, `hosted-${x.id}`, date !== (x.date || '') || giveUrl !== (x.giveUrl || '') || note !== (x.note || '') ? `“${x.title}”` : '');
  const send = async (status, done) => {
    const j = await act({ action: 'hosted-status', id: x.id, status, note, date, giveUrl }, done);
    // (the server finishes a web address typed without https://)
    if (j?.hosted) setGiveUrl(j.hosted.giveUrl || '');
  };
  const approve = async () => {
    if (!date && !(await ask({ title: 'Approve it without a date?', text: 'It won’t show under Coming up for the advisors until it has one.', yes: 'Approve it anyway', no: 'Add the date first', careful: true }))) return;
    send('approved', 'Approved');
  };
  return html`<div class="ar-row">
    <div class="ar-row__t"><strong>${x.title}</strong><span class=${`ar-tag ${x.status === 'approved' ? 'ar-tag--ok' : ''}`}>${{ new: 'New idea', approved: 'Approved', 'not-now': 'Not now', done: 'Held' }[x.status]}</span></div>
    <p class="ar-muted">From ${x.by || 'an advisor'}, ${dayOf(x.at)}</p>
    <dl class="ar-facts">
      ${x.when ? html`<dt>When</dt><dd>${x.when}</dd>` : null}
      ${x.where ? html`<dt>Where</dt><dd>${x.where}</dd>` : null}
      ${x.expected ? html`<dt>Hoping to raise</dt><dd>${x.expected}</dd>` : null}
    </dl>
    ${x.notes ? html`<p class="ar-quote">${x.notes}</p>` : null}
    ${held ? (x.note ? html`<p class="ar-quote">${x.note}</p>` : null) : html`
      <div class="ar-grid2">
        <${Field} label="The date" hint=${x.status === 'approved' && !date ? 'It won’t show under Coming up until it has one.' : ''}><input class="ar-input" type="date" value=${date} onInput=${(e) => setDate(e.currentTarget.value)} /><//>
        <${Field} label="Its Zeffy page" hint="So what it raises counts toward the goal" for=${`ar-give-${x.id}`}><${ZeffyFormSelect} cls="ar-input" from=${ZEFFY_FROM} value=${giveUrl} prefer=${['peer', 'tickets', 'donation']} label="Its Zeffy page" onPick=${(f) => setGiveUrl(f.url)} /><input id=${`ar-give-${x.id}`} class="ar-input" type="url" inputmode="url" placeholder="https://www.zeffy.com/" aria-label="Its Zeffy page" aria-describedby=${`ar-give-${x.id}-hint`} value=${giveUrl} onInput=${(e) => setGiveUrl(e.currentTarget.value)} /><//>
      </div>
      <${Field} label="A note for the advisor"><input class="ar-input" value=${note} maxlength="800" onInput=${(e) => setNote(e.currentTarget.value)} /><//>
      <div class="ar-btns">
        ${x.status === 'approved' ? html`<button type="button" class="ar-btn ar-btn--go" disabled=${busy} onClick=${() => send('approved', 'Saved')}>Save</button><button type="button" class="ar-btn" disabled=${busy} onClick=${() => send('done', 'Marked as held')}>It was held</button>`
          : html`<button type="button" class="ar-btn ar-btn--go" disabled=${busy} onClick=${approve}>Approve</button>`}
        ${x.status !== 'not-now' ? html`<button type="button" class="ar-btn" disabled=${busy} onClick=${() => send('not-now', 'Marked not now')}>Not now</button>` : null}
      </div>
      ${ctx.data.settings.emails ? html`<p class="ar-muted ar-small">Changing this emails ${first(x.by) || 'the advisor'}.</p>` : null}`}
  </div>`;
}

function PageRow({ p, ctx }) {
  const { data, act } = ctx;
  const [slug, setSlug] = useState('');
  return html`<div class="ar-row">
    <div class="ar-row__t"><strong>A Zeffy page nobody’s matched to</strong></div>
    <p class="ar-muted">${p.url ? html`<a href=${p.url} target="_blank" rel="noopener">${p.title || 'Open the page'}</a>` : p.title}</p>
    <div class="ar-inline">
      <${Field} label="Whose page is it?"><select class="ar-input" value=${slug} onChange=${(e) => setSlug(e.currentTarget.value)}><option value="">Choose an advisor</option>${data.advisors.map((a) => html`<option value=${a.slug} key=${a.slug}>${a.name}</option>`)}</select><//>
      <button type="button" class="ar-btn ar-btn--go" disabled=${!slug || ctx.busy} onClick=${() => act({ action: 'match-page', campaignId: p.id, slug }, 'Matched')}>Match it</button>
    </div>
  </div>`;
}

// ─── This month's ask ───────────────────────────────────────────────
function AskCard({ ctx }) {
  const { data, act, busy } = ctx;
  const out = data.asks.find((a) => a.sentAt && !a.closedAt) || null;
  const drafts = data.asks.filter((a) => !a.sentAt);
  const past = data.asks.filter((a) => a.sentAt && a.closedAt);
  const blank = { title: '', body: '', link: '' };
  const [draft, setDraft] = useState(blank);
  const up = (k) => (e) => setDraft({ ...draft, [k]: e.currentTarget.value });
  useDirty(ctx, 'ask', draft.title || draft.body || draft.link ? 'the ask you’re writing' : '');
  // With the emails on, this reaches every advisor's inbox at once: it asks first
  const agree = ({ text = 'This puts the ask on the page and emails every advisor now.', yes = 'Put it out and email them' } = {}) => ask({ title: `Email all ${data.advisors.length} advisors?`, text, yes, no: 'Not yet', careful: true });
  // What really happened, from the server's answer
  const sentWords = (r) => (r?.off ? 'It’s on the page. Emails are off, so nothing was sent.'
    : r?.already ? 'It’s on the page. Advisors already had this email.'
      : r?.sent ? `It’s out, and emailed to ${r.sent === 1 ? '1 advisor' : `${r.sent} advisors`}${r.failed ? `. ${r.failed} didn’t go` : ''}`
        : 'It’s on the page, but no email went out.');
  // Out already and never emailed (the switch was off, or the send failed)
  const emailIt = async (id) => {
    if (!(await agree({ text: 'This emails every advisor now.', yes: 'Email them' }))) return;
    const j = await act({ action: 'email-ask', id }, '', { raw: true });
    if (!j) return;
    if (!j.ok) { ctx.tell(j.error || 'That didn’t go out. Try again.', true); return; }
    const r = j.sent && typeof j.sent === 'object' ? j.sent : j;
    ctx.tell(r.off ? 'Nothing went out: emails are off.' : r.already ? 'Advisors already had this email.' : r.sent ? `Emailed to ${r.sent === 1 ? '1 advisor' : `${r.sent} advisors`}${r.failed ? `. ${r.failed} didn’t go` : ''}` : 'No email went out. Try again in a while.', !r.sent || !!r.failed);
  };
  // agreed: they said yes to emailing everyone. The server holds the real switch: if it was turned on since this
  // screen last looked, it says so, and this asks before anything goes
  const putOut = async (id, agreed) => {
    let j = await act({ action: 'send-ask', id, ...(agreed ? { emailsOk: true } : {}) }, '', { raw: true });
    if (j?.emails) {
      await ctx.load();
      if (!(await agree())) { ctx.tell('Nothing went out. Emails are on now, so it’s waiting for you.'); return false; }
      j = await act({ action: 'send-ask', id, emailsOk: true }, '', { raw: true });
    }
    if (!j) return false;
    if (!j.ok) { ctx.tell(j.error || 'That didn’t go out. Try again.', true); await ctx.load(); return false; }
    ctx.tell(sentWords(j.sent), !!j.sent?.failed);
    return true;
  };
  const save = async (thenOut) => {
    const emailing = thenOut && data.settings.emails;
    if (emailing && !(await agree())) return;
    const j = await act({ action: 'save-ask', ask: draft }, thenOut ? '' : 'Saved for later');
    if (j && thenOut) await putOut(j.ask.id, emailing);
    if (j) setDraft(blank);
  };
  return html`<${Card} title="This month’s ask" sub="One clear ask at a time. It sits on every advisor’s Home page.">
    ${out ? html`<${AskOut} a=${out} ctx=${ctx} emailIt=${emailIt} />` : html`<p class="ar-muted">Nothing is out right now.</p>`}
    <div class="ar-sub">
      <h4>${out ? 'Write the next one' : 'Write one'}</h4>
      <${Field} label="The ask"><input class="ar-input" maxlength="140" placeholder="Do you know a plumber who’d work with us?" value=${draft.title} onInput=${up('title')} /><//>
      <${Field} label="A little more, if it helps"><textarea class="ar-input" rows="3" maxlength="1500" value=${draft.body} onInput=${up('body')}></textarea><//>
      <${Field} label="A link, if there’s one"><input class="ar-input" type="url" inputmode="url" placeholder="https://" value=${draft.link} onInput=${up('link')} /><//>
      <div class="ar-btns">
        <button type="button" class="ar-btn ar-btn--go" disabled=${busy || !draft.title.trim()} onClick=${() => save(true)}>${data.settings.emails ? 'Put it out and email advisors' : 'Put it on the page'}</button>
        <button type="button" class="ar-btn" disabled=${busy || !draft.title.trim()} onClick=${() => save(false)}>Save for later</button>
      </div>
      <p class="ar-muted ar-small">${data.settings.emails ? `This emails all ${data.advisors.length} advisors.` : 'Emails are off, so this only goes on the page.'}${out ? ' A new one closes the one that’s out now.' : ''}</p>
    </div>
    ${drafts.length ? html`<${Fold} summary=${`Saved for later (${drafts.length})`}><ul class="ar-list">${drafts.map((a) => html`<li key=${a.id}><${DraftAsk} a=${a} ctx=${ctx} agree=${agree} putOut=${putOut} /></li>`)}</ul><//>` : null}
    ${past.length ? html`<${Fold} summary=${`Past asks (${past.length})`}><ul class="ar-list">${past.map((a) => html`<li key=${a.id}><${AskOut} a=${a} ctx=${ctx} past=${true} /></li>`)}</ul><//>` : null}
  <//>`;
}

/** A saved ask, still changeable: nobody has seen it */
function DraftAsk({ a, ctx, agree, putOut }) {
  const { act, busy } = ctx;
  const [f, setF] = useState(null);
  const up = (k) => (e) => setF({ ...f, [k]: e.currentTarget.value });
  useDirty(ctx, `ask-${a.id}`, f && (f.title !== a.title || f.body !== (a.body || '') || f.link !== (a.link || '')) ? `“${a.title}”` : '');
  if (f) {
    return html`<div class="ar-row">
      <${Field} label="The ask"><input class="ar-input" maxlength="140" value=${f.title} onInput=${up('title')} /><//>
      <${Field} label="A little more, if it helps"><textarea class="ar-input" rows="3" maxlength="1500" value=${f.body} onInput=${up('body')}></textarea><//>
      <${Field} label="A link, if there’s one"><input class="ar-input" type="url" inputmode="url" placeholder="https://" value=${f.link} onInput=${up('link')} /><//>
      <div class="ar-btns">
        <button type="button" class="ar-btn ar-btn--go" disabled=${busy || !f.title.trim()} onClick=${async () => { if (await act({ action: 'save-ask', ask: { id: a.id, ...f } }, 'Saved')) setF(null); }}>Save</button>
        <button type="button" class="ar-btn ar-btn--quiet" onClick=${() => setF(null)}>Keep it as it was</button>
      </div>
    </div>`;
  }
  return html`<div class="ar-row">
    <div class="ar-row__t"><strong>${a.title}</strong></div>${a.body ? html`<p class="ar-muted">${a.body}</p>` : null}
    <div class="ar-btns">
      <button type="button" class="ar-btn ar-btn--go" disabled=${busy} onClick=${async () => { const emailing = ctx.data.settings.emails; if (emailing && !(await agree())) return; putOut(a.id, emailing); }}>Put it out</button>
      <button type="button" class="ar-btn" onClick=${() => setF({ title: a.title, body: a.body || '', link: a.link || '' })}>Edit</button>
      <${Sure} label="Delete" yes="Yes, delete it" onYes=${() => act({ action: 'delete-ask', id: a.id }, 'Deleted')} />
    </div>
  </div>`;
}

function AskOut({ a, ctx, past = false, emailIt = null }) {
  const { act } = ctx;
  const yes = a.answers.filter((x) => x.answer === 'yes');
  const no = a.answers.filter((x) => x.answer === 'no');
  return html`<div class="ar-row">
    <div class="ar-row__t"><strong>${a.title}</strong></div>
    ${a.body ? html`<p class="ar-muted">${a.body}</p>` : null}
    <p class="ar-muted ar-small">Out since ${dayOf(a.sentAt)}. ${yes.length} can help, ${no.length} not this time.</p>
    ${a.answers.length ? html`<ul class="ar-answers">${[...yes, ...no].map((x) => html`<li key=${x.slug}><span class="ar-answers__w"><strong>${x.name}</strong><span class=${`ar-tag ${x.answer === 'yes' ? 'ar-tag--ok' : ''}`}>${x.answer === 'yes' ? 'Can help' : 'Not this time'}</span></span>${x.note ? html`<span>${x.note}</span>` : null}</li>`)}</ul>` : null}
    ${past ? null : html`<div class="ar-btns">
      ${ctx.data.settings.emails && a.mailed === false ? html`<button type="button" class="ar-btn ar-btn--go" disabled=${ctx.busy} onClick=${() => emailIt?.(a.id)}>Email it to advisors</button>` : null}
      <${Sure} label="Close it" yes="Yes, close it" note="It comes off every advisor’s Home page." onYes=${() => act({ action: 'close-ask', id: a.id }, 'Closed')} />
    </div>`}
  </div>`;
}

// ─── Who we're looking for ──────────────────────────────────────────
function Wishes({ ctx }) {
  const { data, act } = ctx;
  const blank = { title: '', detail: '' };
  const [w, setW] = useState(blank);
  const add = async () => { if (await act({ action: 'save-wish', wish: w }, 'Added')) setW(blank); };
  useDirty(ctx, 'wish', w.title || w.detail ? 'the person you’re adding' : '');
  return html`<${Card} title="Who we’re looking for" sub="On every advisor’s Introductions page. Be specific: a name or a trade gets answers.">
    ${data.wishes.length ? html`<ul class="ar-list">${data.wishes.map((x) => html`<li key=${x.id}><${WishRow} w=${x} ctx=${ctx} /></li>`)}</ul>` : html`<p class="ar-muted">The list is empty. Advisors told us they know vendors, contractors, event people, and corporate partners, so that’s a good place to start.</p>`}
    <div class="ar-sub">
      <div class="ar-grid2">
        <${Field} label="Who"><input class="ar-input" maxlength="140" placeholder="A licensed electrician in Cherokee County" value=${w.title} onInput=${(e) => setW({ ...w, title: e.currentTarget.value })} /><//>
        <${Field} label="Why, if it helps"><input class="ar-input" maxlength="400" value=${w.detail} onInput=${(e) => setW({ ...w, detail: e.currentTarget.value })} /><//>
      </div>
      <div class="ar-btns"><button type="button" class="ar-btn" disabled=${!w.title.trim() || ctx.busy} onClick=${add}>Add to the list</button></div>
    </div>
  <//>`;
}
function WishRow({ w, ctx }) {
  const { act } = ctx;
  const [t, setT] = useState(w.title);
  const [d, setD] = useState(w.detail || '');
  const save = () => { if (t.trim() && (t !== w.title || d !== (w.detail || ''))) act({ action: 'save-wish', wish: { id: w.id, title: t, detail: d } }, 'Saved'); };
  return html`<div class="ar-row ar-row--tight">
    <div class="ar-grid2">
      <input class="ar-input" aria-label="Who" value=${t} maxlength="140" onInput=${(e) => setT(e.currentTarget.value)} onBlur=${save} />
      <input class="ar-input" aria-label="Why" value=${d} maxlength="400" placeholder="Why, if it helps" onInput=${(e) => setD(e.currentTarget.value)} onBlur=${save} />
    </div>
    <${Sure} label="Take it off" yes="Yes, take it off" cls="ar-btn--small" onYes=${() => act({ action: 'delete-wish', id: w.id }, 'Taken off')} />
  </div>`;
}

// ─── The goal ───────────────────────────────────────────────────────
const GOAL_FIELDS = ['goal', 'termStart', 'termEnd', 'lead', 'campaignUrl', 'campaignId'];
function Goal({ ctx }) {
  const { data, act } = ctx;
  const s = data.settings;
  const m = data.money;
  // Only what this person typed: everything else keeps following the server, and only what they changed is sent, so an
  // older tab can't put back a goal someone else has since saved
  const [edits, setEdits] = useState({});
  const f = Object.fromEntries(GOAL_FIELDS.map((k) => [k, k in edits ? edits[k] : s[k]]));
  const up = (k) => (e) => setEdits({ ...edits, [k]: e.currentTarget.value });
  // The campaign's ID follows its address: picked from Zeffy's list, or typed and Zeffy lists it, the ID fills in; typed
  // and not listed, the ID empties and Save asks Zeffy for it; cleared, the campaign is unlinked. An ID typed by hand
  // stays while an address is typed, until a campaign is picked. The server has the last word (functions/api/
  // advisory-admin.js save-settings): an address Zeffy lists decides the ID, and a typed ID is checked with Zeffy
  const zeffyList = useZeffyFormList(ZEFFY_FROM);
  const autoId = useRef(null);
  const pickCampaign = (c) => { autoId.current = c.id; setEdits({ ...edits, campaignUrl: c.url, campaignId: c.id }); };
  // Zeffy's list came (or was read again) while an address was being typed: the ID catches up with it
  useEffect(() => {
    if (!zeffyList || !('campaignUrl' in edits) || !String(edits.campaignUrl || '').trim()) return;
    const byHand = 'campaignId' in edits && edits.campaignId !== '' && edits.campaignId !== autoId.current && edits.campaignId !== (s.campaignId || '');
    const listed = zeffyList.find((c) => sameForm(c.url, edits.campaignUrl));
    if (!byHand && listed && edits.campaignId !== listed.id) { autoId.current = listed.id; setEdits({ ...edits, campaignId: listed.id }); }
  }, [zeffyList]);
  const typeCampaignUrl = (e) => {
    const url = e.currentTarget.value;
    const next = { ...edits, campaignUrl: url };
    const byHand = 'campaignId' in edits && edits.campaignId !== '' && edits.campaignId !== autoId.current && edits.campaignId !== (s.campaignId || '');
    if (!url.trim()) { next.campaignId = ''; autoId.current = ''; } else if (!byHand) {
      const listed = url.trim() ? (zeffyList || []).find((c) => sameForm(c.url, url)) : null;
      // The saved address, typed back (or with Zeffy's list not in yet), keeps the saved ID
      const saved = !!url.trim() && (url.trim() === String(s.campaignUrl || '').trim() || sameForm(url, s.campaignUrl));
      next.campaignId = listed ? listed.id : saved ? s.campaignId || '' : '';
      autoId.current = next.campaignId;
    }
    setEdits(next);
  };
  const moved = GOAL_FIELDS.filter((k) => k in edits && String(edits[k] ?? '') !== String(s[k] ?? ''));
  const changed = moved.length > 0;
  useDirty(ctx, 'goal', changed ? 'the goal and term' : '');
  const saveIt = async () => {
    if (moved.includes('goal') && (String(edits.goal).trim() === '' || !Number.isFinite(Number(edits.goal)))) { ctx.tell('Type the goal in dollars.', true); return; }
    if (moved.includes('lead')) {
      const next = data.board.find((p) => p.slug === f.lead)?.name || 'them';
      const yours = data.me.kind === 'lead';
      if (!(await ask({ title: `Hand the group to ${next}?`, text: `${next} gets Run it on the advisors’ page${yours ? ', and you lose it the next time this page opens.' : `, and ${data.leadName || 'the person running it now'} loses it.`}`, yes: `Yes, hand it to ${first(next)}`, no: 'Keep it as it is', careful: true }))) return;
    }
    const patch = Object.fromEntries(moved.map((k) => [k, k === 'goal' ? Number(edits.goal) : edits[k]]));
    // A new address goes with the ID shown beside it, even when that ID hasn't changed: Zeffy is asked only when there's none
    if ('campaignUrl' in patch && !('campaignId' in patch)) patch.campaignId = f.campaignId || '';
    if (await act({ action: 'save-settings', settings: patch }, 'Saved')) setEdits({});
  };
  const people = data.board.filter((p) => (p.committees || []).includes('Advisory Board') || p.slug === s.lead);
  const [email, setEmail] = useState('');
  const [found, setFound] = useState(null);
  const look = async () => { const j = await ctx.act({ action: 'find-gifts', email }); if (j) setFound(j.gifts || []); };
  return html`<${Card} title="The goal" sub=${`${dayOf(`${s.termStart}T17:00:00Z`)} to ${dayOf(`${s.termEnd}T17:00:00Z`)}`}>
    <div class="ar-goal">
      <${Thermometer} raised=${m.raised} goal=${m.goal} cls="ar-thermo" />
      <div class="ar-goal__w">
        <p class="ar-big">${dollars(m.raised)}<span class="ar-muted"> of ${dollars(m.goal)}</span></p>
        ${m.ready && m.noPage?.length ? html`<p class="ar-muted ar-small">No Zeffy page yet: ${m.noPage.join(', ')}. Until they have one, they share the group’s page.</p>` : null}
        ${!m.ready ? html`<p class="ar-muted ar-small">Add the group’s Zeffy campaign below and gifts count by themselves.</p>`
          : m.error ? html`<p class="ar-note">Zeffy didn’t answer at the last look, so this may be behind. ${m.error}</p>`
            : m.at ? html`<p class="ar-muted ar-small">Read from Zeffy ${dayOf(m.at)}.</p>` : null}
      </div>
    </div>
    <${Fold} summary="Goal, term, and Zeffy">
      <div class="ar-grid2">
        <${Field} label="The goal, in dollars"><input class="ar-input" type="number" min="0" step="500" value=${f.goal} onInput=${up('goal')} /><//>
        ${data.me.kind === 'admin' ? html`<${Field} label="Who runs the group"><select class="ar-input" value=${f.lead} onChange=${up('lead')}>${people.map((p) => html`<option value=${p.slug} key=${p.slug}>${p.name}</option>`)}</select><//>` : null}
        <${Field} label="The term starts"><input class="ar-input" type="date" value=${f.termStart} onInput=${up('termStart')} /><//>
        <${Field} label="The term ends"><input class="ar-input" type="date" value=${f.termEnd} onInput=${up('termEnd')} /><//>
      </div>
      <${Field} label="The Zeffy campaign’s web address" for="ar-campaign-url"><${ZeffyFormSelect} cls="ar-input" from=${ZEFFY_FROM} value=${f.campaignUrl} id=${f.campaignId || ''} prefer=${['peer']} label="The Zeffy campaign’s web address" onPick=${pickCampaign} /><input id="ar-campaign-url" class="ar-input" type="url" inputmode="url" placeholder="https://www.zeffy.com/" aria-label="The Zeffy campaign’s web address" value=${f.campaignUrl} onInput=${typeCampaignUrl} /><//>
      <${Field} label="The campaign’s ID in Zeffy, if you have it" hint="The site finds it from the address when it can, and says so if it can’t"><input class="ar-input" value=${f.campaignId} onInput=${up('campaignId')} /><//>
      <div class="ar-btns"><button type="button" class="ar-btn ar-btn--go" disabled=${!changed || ctx.busy} onClick=${saveIt}>Save</button></div>
    <//>
    ${m.byAdvisor?.some((a) => a.gifts) ? html`<${Fold} summary="By advisor">
      <ul class="ar-money">${m.byAdvisor.filter((a) => a.gifts).map((a) => html`<li key=${a.slug}><span>${a.name}</span><span>${dollars(a.dollars)} · ${a.gifts} ${a.gifts === 1 ? 'gift' : 'gifts'}</span></li>`)}</ul>
    <//>` : null}
    <${Fold} summary=${`Credit a gift from another campaign${m.credits?.length ? ` (${m.credits.length})` : ''}`}>
      <p class="ar-muted ar-small">A gala table an advisor brought in, say. Find it by the donor’s email. The amount stays Zeffy’s, so a refund comes off by itself.</p>
      <div class="ar-inline">
        <${Field} label="Donor’s email"><input class="ar-input" type="email" inputmode="email" value=${email} onInput=${(e) => setEmail(e.currentTarget.value)} /><//>
        <button type="button" class="ar-btn" disabled=${!email.includes('@') || ctx.busy} onClick=${look}>Find their gifts</button>
      </div>
      ${found ? (found.length ? html`<ul class="ar-list">${found.map((g) => html`<li key=${g.id}><${GiftRow} g=${g} ctx=${ctx} /></li>`)}</ul>` : html`<p class="ar-muted">No gifts from that email this term.</p>`) : null}
      ${m.credits?.length ? html`<ul class="ar-list">${m.credits.map((c) => html`<li key=${c.payment_id}><div class="ar-row ar-row--tight"><span>${c.dollars != null ? `${dollars(c.dollars)} · ` : ''}${c.who || 'The group'}${c.note ? html`<span class="ar-muted"> · ${c.note}</span>` : null}</span><${Sure} label="Take it off" yes="Yes, take it off" cls="ar-btn--small" onYes=${() => act({ action: 'uncredit', paymentId: c.payment_id }, 'Taken off')} /></div></li>`)}</ul>` : null}
    <//>
  <//>`;
}
function GiftRow({ g, ctx }) {
  const { data, act } = ctx;
  const [slug, setSlug] = useState('');
  return html`<div class="ar-row ar-row--tight">
    <span>${dollars(g.dollars)}<span class="ar-muted"> · ${g.campaign}</span></span>
    <div class="ar-inline">
      <select class="ar-input" aria-label="Who brought it in" value=${slug} onChange=${(e) => setSlug(e.currentTarget.value)}><option value="">The group</option>${data.advisors.map((a) => html`<option value=${a.slug} key=${a.slug}>${a.name}</option>`)}</select>
      <button type="button" class="ar-btn" disabled=${ctx.busy} onClick=${() => act({ action: 'credit', paymentId: g.id, slug }, 'Credited')}>Credit it</button>
    </div>
  </div>`;
}

// ─── The makeover ───────────────────────────────────────────────────
function Makeover({ ctx }) {
  const { data, act, tell } = ctx;
  const k = data.makeover;
  const picked = k?.state === 'kid';
  const [problems, setProblems] = useState([]);
  // The pick is the site's; JobTread follows, and says so when it can't
  const change = async (body, done) => {
    const j = await act(body);
    if (!j) return;
    const list = [...(j.problems || []), ...(j.sync?.problems || [])];
    setProblems(list);
    if (list.length) tell(`${done}, but JobTread needs a look.`, true); else tell(done);
  };
  return html`<${Card} title="The group’s makeover" sub=${picked ? '' : 'When the goal is met, pick the kid the group sponsors. Only kids waiting on funding with a public page are listed.'}>
    ${problems.length ? html`<div class="ar-note" role="status"><strong>JobTread didn’t follow:</strong><ul class="ar-plain">${problems.map((p, i) => html`<li key=${i}>${p}</li>`)}</ul></div>` : null}
    ${picked ? html`<div class="ar-kid">
      ${k.photo ? html`<img src=${k.photo} alt="" width="72" height="72" loading="lazy" />` : null}
      <div><strong><a href=${k.url} target="_blank" rel="noopener">${k.name}</a></strong><p class="ar-muted">${k.stage}</p></div>
    </div>
    <div class="ar-btns"><${Sure} label="Choose another kid" yes="Yes, take them off" note=${`This takes the Advisory Board off ${k.name}’s job and page.`} onYes=${() => change({ action: 'clear-kid' }, 'Taken off')} /></div>`
      : data.kids.length ? html`<ul class="ar-list">${data.kids.map((x) => html`<li key=${x.slug}><div class="ar-row ar-row--tight">
          <span class="ar-kid ar-kid--small">${x.photo ? html`<img src=${x.photo} alt="" width="44" height="44" loading="lazy" />` : null}<a href=${x.url} target="_blank" rel="noopener">${x.name}</a></span>
          <${Sure} label=${`Pick ${x.name}`} yes=${`Yes, pick ${x.name}`} note="Every advisor gets their Demo Day invite, and the group’s logo goes on their page." cls="ar-btn--small" onYes=${() => change({ action: 'pick-kid', kid: x.slug }, `${x.name} is the group’s makeover`)} />
        </div></li>`)}</ul>`
        : html`<p class="ar-muted">No kid is waiting on funding with a public page right now.</p>`}
  <//>`;
}

// ─── advisory@ and the emails ───────────────────────────────────────
function GroupCard({ ctx }) {
  const { data, act } = ctx;
  const g = data.group;
  const [busy, setBusy] = useState(false);
  const missing = g?.missing?.length || 0;
  const line = !data.settings.emails ? 'The group fills in by itself once emails are on.'
    : !g ? 'The group’s list isn’t being kept yet.'
    : g.error ? (/HTTP \d|answered \d/.test(g.error) ? 'Google didn’t answer the last time. The site will try again.' : `Google didn’t take the last change: ${g.error}`)
      : g.current === false ? 'A change is on its way to the group.'
        : g.syncedAt ? `Matches the advisors on People, as of ${dayOf(g.syncedAt)}.` : 'The site will fill the group on its next look.';
  const unsent = data.advisors.filter((a) => !a.lastSeen && a.email && !data.welcomed?.[a.slug]);
  const welcome = async () => {
    const j = await act({ action: 'send-welcome', slugs: unsent.map((a) => a.slug) });
    if (!j) return;
    if (j.sent) ctx.tell(`Sent to ${j.sent === 1 ? '1 advisor' : `${j.sent} advisors`}${j.failed ? `. ${j.failed} didn’t go` : ''}`, !!j.failed);
    else ctx.tell(j.off ? 'Nothing went out: emails are off.' : j.failed ? `Nothing went out: ${j.failed === 1 ? 'the email' : `all ${j.failed} emails`} failed. Try again in a while.` : 'Nothing went out: they’ve all had it already.', true);
  };
  return html`<${Card} title="Reaching the group">
    <p class="ar-addr">${data.groupEmail}</p>
    <p class=${g?.error ? 'ar-note' : 'ar-muted ar-small'}>${line}</p>
    ${missing ? html`<p class="ar-note">No email on file for ${g.missing.map((p) => p.name).join(', ')}.</p>` : null}
    ${g?.error ? html`<div class="ar-btns"><button type="button" class="ar-btn" disabled=${busy} onClick=${async () => { setBusy(true); await act({ action: 'sync-group' }, 'Tried again'); setBusy(false); }}>Try again</button></div>` : null}
    <div class="ar-sub">
      <${Toggle} checked=${data.settings.emails} label="Email the advisors" sub="The monthly ask, updates on introductions, and invites to meetings and Demo Days. Off, it all stays on the page."
        onChange=${(on) => act({ action: 'save-settings', settings: { emails: on } }, on ? 'Emails are on' : 'Emails are off')} />
      ${data.settings.emails && unsent.length ? html`<div class="ar-btns"><${Sure} label=${`Send the sign-in email to ${unsent.length}`} yes="Yes, send it" note=${`To ${unsent.map((a) => first(a.name)).join(', ')}: how to open the page.`} onYes=${welcome} /></div>` : null}
    </div>
    ${data.mail?.length ? html`<${Fold} summary="What’s gone out"><ul class="ar-money">${data.mail.slice(0, 12).map((x, i) => html`<li key=${i}><span>${x.what || x.subject || x.kind}</span><span class="ar-muted">${dayOf(x.at)}</span></li>`)}</ul><//>` : null}
  <//>`;
}

// ─── The people ─────────────────────────────────────────────────────
function People({ ctx }) {
  const { data } = ctx;
  const agreement = data.docs.find((d) => d.kind === 'agreement' && d.shared !== false);
  return html`<${Card} title="The Advisory Board" count=${data.advisors.length} sub="Added and removed on People in the staff admin. Each person’s sign-in and the group’s list follow by themselves.">
    ${data.missing.length ? html`<p class="ar-note">Can’t sign in yet, no email on file: ${data.missing.map((p) => p.name).join(', ')}.</p>` : null}
    ${data.advisors.length ? html`<div class="ar-table" role="table" aria-label="Advisors">
      <div class="ar-tr ar-tr--h" role="row"><span role="columnheader">Advisor</span><span role="columnheader">Last signed in</span><span role="columnheader">Agreement</span><span role="columnheader">Term ends</span></div>
      ${data.advisors.map((a) => html`<${PersonRow} a=${a} agreement=${agreement} ctx=${ctx} key=${a.slug} />`)}
    </div>` : html`<p class="ar-muted">Nobody’s on the Advisory Board yet.</p>`}
  <//>`;
}
function PersonRow({ a, agreement, ctx }) {
  const { act } = ctx;
  // null until someone types: tabbing through saves nothing, and the group's own date keeps coming through
  const [typed, setTyped] = useState(null);
  const ends = typed ?? a.term.ends;
  const sig = agreement ? a.signed[agreement.id] : null;
  const ended = isDate(a.term.ends) && a.term.ends < TODAY();
  const leave = async () => {
    if (typed === null) return;
    if (isDate(typed) && typed !== a.term.ends) await act({ action: 'set-term', slug: a.slug, ends: typed }, 'Saved');
    setTyped(null);
  };
  return html`<div class="ar-tr" role="row">
    <span class="ar-who" role="cell"><${Face} p=${a} /><span><strong>${a.name}</strong>${a.organization ? html`<span class="ar-muted">${a.organization}</span>` : null}</span></span>
    <span role="cell" data-label="Last signed in">${a.lastSeen ? dayOf(a.lastSeen) : html`<span class="ar-muted">Not yet</span>`}</span>
    <span role="cell" data-label="Agreement">${!agreement ? html`<span class="ar-muted">Not written yet</span>` : signedNow(sig, agreement, a.term) ? `Signed ${dayOf(sig.at)}` : sig ? html`<span class="ar-muted">Asked to sign again</span>` : html`<span class="ar-muted">Not yet</span>`}</span>
    <span role="cell" data-label=${ended ? 'Term ended' : 'Term ends'}><input class="ar-input ar-input--date" type="date" aria-label=${`${a.name}’s term ${ended ? 'ended' : 'ends'}`} value=${ends} onInput=${(e) => setTyped(e.currentTarget.value)} onBlur=${leave} />${ended ? html`<span class="ar-tag">Ended</span>` : null}${a.term.renewedOn ? html`<span class="ar-muted ar-small">Renewed ${shortDate(a.term.renewedOn)}</span>` : null}</span>
  </div>`;
}

// ═══════════════════════════════════════════════════════════════════
// Documents
// ═══════════════════════════════════════════════════════════════════
function DocsTab({ ctx }) {
  const { data } = ctx;
  const [open, setOpenNow] = useState(null); // a doc's id, or 'new:<kind>'
  // What's typed and not saved in the paper that's open: moving to another asks first, as Close does
  const editing = useRef('');
  const setOpen = async (next) => { if (next !== null && editing.current && !(await askToLeave(editing.current))) return; setOpenNow(next); };
  const group = (kinds) => kinds.map((k) => {
    const kind = data.docKinds.find((x) => x.id === k);
    const docs = data.docs.filter((d) => d.kind === k);
    return html`<li key=${k}>
      ${docs.map((d) => (open === d.id ? html`<${DocEditor} doc=${d} kind=${kind} ctx=${ctx} track=${editing} onDone=${() => setOpen(null)} key=${d.id} />` : html`<${DocRow} d=${d} kind=${kind} ctx=${ctx} onOpen=${() => setOpen(d.id)} key=${d.id} />`))}
      ${open === `new:${k}` ? html`<${DocEditor} doc=${{ kind: k, ...STARTERS[k], shared: true, files: [] }} kind=${kind} ctx=${ctx} track=${editing} onDone=${() => setOpen(null)} key=${`new-${k}`} />`
        : !docs.length ? html`<div class="ar-row ar-row--tight"><span><strong>${kind?.label}</strong><span class="ar-muted"> · Not written yet</span></span><button type="button" class="ar-btn ar-btn--small" onClick=${() => setOpen(`new:${k}`)}>Start from a draft</button></div>`
          : k === 'post' ? html`<div class="ar-row ar-row--tight"><span></span><button type="button" class="ar-btn ar-btn--small" onClick=${() => setOpen('new:post')}>Add another post</button></div>` : null}
    </li>`;
  });
  return html`<div class="ar-stack">
    <${Card} title="Papers" sub="On their Documents page. The agreement is signed by each advisor once a term."><ul class="ar-list">${group(PAPERS)}</ul><//>
    <${LibraryCard} ctx=${ctx} open=${open} setOpen=${setOpen} editing=${editing} />
    <${BoardPapersCard} ctx=${ctx} />
    <${PublicOverview} ctx=${ctx} />
    <${Card} title="Words for the Fundraise page" sub="What advisors copy and share. Nobody sees a draft until it’s saved."><ul class="ar-list">${group(WORDS)}</ul><//>
  </div>`;
}

/** The shelves on their Documents page: a link, a file, or both, on any shelf */
function LibraryCard({ ctx, open, setOpen, editing }) {
  const { data } = ctx;
  const kind = data.docKinds.find((k) => k.id === 'library');
  return html`<${Card} title="On their Documents page" sub="Links and files, shelf by shelf. Advisors also see SOARD’s facts, logos, photos, filings, and the words below.">
    ${data.shelves.map((sh) => {
    const docs = data.docs.filter((d) => d.kind === 'library' && d.shelf === sh.id);
    return html`<div class="ar-shelf" key=${sh.id}>
      <h4>${sh.label}</h4>
      <ul class="ar-list">
        ${docs.map((d) => html`<li key=${d.id}>${open === d.id ? html`<${DocEditor} doc=${d} kind=${kind} ctx=${ctx} track=${editing} onDone=${() => setOpen(null)} key=${d.id} />` : html`<${DocRow} d=${d} kind=${kind} ctx=${ctx} onOpen=${() => setOpen(d.id)} />`}</li>`)}
        <li>${open === `new:${sh.id}` ? html`<${DocEditor} doc=${{ kind: 'library', shelf: sh.id, shared: true, files: [] }} kind=${kind} ctx=${ctx} track=${editing} onDone=${() => setOpen(null)} key=${`new-${sh.id}`} />`
      : html`<div class="ar-row ar-row--tight"><span></span><button type="button" class="ar-btn ar-btn--small" aria-label=${`Add a link or file to ${sh.label}`} onClick=${() => setOpen(`new:${sh.id}`)}>Add a link or file</button></div>`}</li>
      </ul>
    </div>`;
  })}
  <//>`;
}

/** Which of the board's papers advisors can open. Nothing else of the board's reaches them */
function BoardPapersCard({ ctx }) {
  const { data, act } = ctx;
  const on = new Set(data.settings.boardDocs || []);
  const [want, setWant] = useState({});
  const queue = useRef(Promise.resolve());
  const flip = (id, v) => {
    setWant((w) => ({ ...w, [id]: v }));
    queue.current = queue.current.then(() => act({ action: 'board-doc', id, on: v }, v ? 'It’s on their Documents page' : 'It’s off their Documents page'))
      .finally(() => setWant(({ [id]: gone, ...rest }) => rest));
  };
  if (!data.boardDocs.length) return null;
  return html`<${Card} title="From the board’s documents" sub="Advisors can open only the ones turned on here. Papers the board signs stay with the board.">
    <div class="ar-stack ar-stack--tight">${data.boardDocs.map((d) => html`<${Toggle} checked=${d.id in want ? want[d.id] : on.has(d.id)} disabled=${d.id in want} onChange=${(v) => flip(d.id, v)} label=${d.title} key=${d.id} />`)}</div>
  <//>`;
}

/** The PDF the public Advisory Board page links to, replaced at the address it already has */
function PublicOverview({ ctx }) {
  const { tell, load } = ctx;
  const ref = useRef(null);
  const [busy, setBusy] = useState(false);
  const pick = async (e) => {
    const file = e.currentTarget.files?.[0];
    e.currentTarget.value = '';
    if (!file) return;
    if (!/pdf$/i.test(file.type) && !/\.pdf$/i.test(file.name)) { tell('The public overview has to be a PDF.', true); return; }
    setBusy(true);
    const form = new FormData();
    form.set('file', file);
    form.set('overview', '1');
    const j = await call(null, { form });
    setBusy(false);
    if (j.ok) { tell('The public overview is replaced'); await load(); } else tell(j.error || 'That file didn’t go up. Try again.', true);
  };
  return html`<${Card} title="The public overview" sub="The PDF linked from the Advisory Board page on your website. A new one replaces it at the same address.">
    <div class="ar-btns">
      <input ref=${ref} type="file" accept="application/pdf,.pdf" hidden onChange=${pick} />
      <button type="button" class="ar-btn" disabled=${busy} onClick=${() => ref.current?.click()}>${busy ? 'Replacing…' : 'Replace the public overview PDF'}</button>
      <a class="ar-btn ar-btn--quiet" href="/advisory-board/" target="_blank" rel="noopener">See the public page</a>
    </div>
  <//>`;
}

function DocRow({ d, kind, ctx, onOpen }) {
  const { data } = ctx;
  const signed = kind?.sign ? data.advisors.filter((a) => signedNow(a.signed[d.id], d, a.term)).length : null;
  return html`<div class="ar-row ar-row--tight">
    <span><strong>${d.title}</strong><span class="ar-muted"> · ${d.shared === false ? 'Not on the page' : signed !== null ? `${signed} of ${data.advisors.length} signed` : d.kind === 'library' ? (!d.url && !d.files?.length ? 'Not on the page: add a link or a file' : d.note || (d.url ? 'A link' : 'A file')) : `Saved ${dayOf(d.updatedAt)}`}${d.files?.length ? ` · ${d.files.length} ${d.files.length === 1 ? 'file' : 'files'}` : ''}</span></span>
    <button type="button" class="ar-btn ar-btn--small" onClick=${onOpen}>Edit</button>
  </div>`;
}

function DocEditor({ doc, kind, ctx, onDone, track }) {
  const { act, load, tell, data } = ctx;
  const library = doc.kind === 'library';
  const [title, setTitle] = useState(doc.title || (library ? '' : kind?.label) || '');
  const [body, setBody] = useState(doc.body || '');
  const [shared, setShared] = useState(doc.shared !== false);
  const [url, setUrl] = useState(doc.url || '');
  const [note, setNote] = useState(doc.note || '');
  const [shelf, setShelf] = useState(doc.shelf || '');
  const [saved, setSaved] = useState(doc.id ? { title: doc.title, body: doc.body || '', shared: doc.shared !== false, url: doc.url || '', note: doc.note || '', shelf: doc.shelf || '' } : null);
  const [saving, setSaving] = useState(false);
  const [id, setId] = useState(doc.id || '');
  // Which saved copy these words started from: the server refuses if someone has saved since (conflict: theirs)
  const [base, setBase] = useState(doc.updatedAt || '');
  const [conflict, setConflict] = useState(null);
  const [fresh, setFresh] = useState(0);
  const fileRef = useRef(null);
  const changed = saved ? title !== saved.title || body !== saved.body || shared !== saved.shared || url !== saved.url || note !== saved.note || shelf !== saved.shelf
    : !library || !!(title.trim() || url.trim() || note.trim());
  useDirty(ctx, `doc-${doc.id || doc.kind}`, changed ? `“${title || 'this paper'}”` : '');
  useEffect(() => { if (track) track.current = changed ? `“${title || 'this paper'}”` : ''; return () => { if (track) track.current = ''; }; }, [changed, title]);
  const current = data.docs.find((d) => d.id === id) || doc;
  // hide: a paper with no saved copy yet, saved so a file has somewhere to go. It stays off the page until someone
  // saves it there on purpose, so advisors never get a draft, or a signature to-do for one. The switch stays as they
  // set it, and the note under it says what's left to do
  const save = async ({ hide = false } = {}) => {
    // New words on a paper people signed: their signatures stop counting, so it says so first
    if (kind?.sign && saved && body !== saved.body) {
      const n = data.advisors.filter((a) => signedNow(a.signed[id], current)).length;
      if (n && !(await ask({ title: 'Ask everyone to sign again?', text: `The words changed, so the ${n === 1 ? 'advisor who has signed' : `${n} advisors who have signed`} will be asked to sign again.`, yes: 'Save and ask them', no: 'Keep editing', careful: true }))) return null;
    }
    setSaving(true);
    const onPage = shared && !hide;
    const j = await act({ action: 'save-doc', ...(base ? { base } : {}), doc: { id: id || undefined, kind: doc.kind, title, body, shared: onPage, ...(base ? { base } : {}), ...(doc.kind === 'overview' || library ? { url } : {}), ...(library ? { note, shelf } : {}) } }, hide ? '' : 'Saved', { raw: true });
    setSaving(false);
    if (!j) return null;
    if (!j.ok) {
      if (j.current) { setConflict(j.current); await load(); }
      tell(j.error || 'That didn’t save. Try again.', true);
      return null;
    }
    setConflict(null);
    // (compared with what the server kept: it finishes a web address typed without https://)
    setId(j.doc.id); setUrl(j.doc.url || ''); setBase(j.doc.updatedAt || '');
    setSaved({ title, body, shared: onPage, url: j.doc.url || '', note: j.doc.note || '', shelf: j.doc.shelf || '' });
    setNote(j.doc.note || '');
    return j.doc;
  };
  const takeTheirs = () => {
    const c = conflict;
    setTitle(c.title || title); setBody(c.body || ''); setShared(c.shared !== false); setUrl(c.url || ''); setNote(c.note || ''); setShelf(c.shelf || '');
    setSaved({ title: c.title || title, body: c.body || '', shared: c.shared !== false, url: c.url || '', note: c.note || '', shelf: c.shelf || '' });
    setBase(c.updatedAt || ''); setConflict(null); setFresh((n) => n + 1);
  };
  const keepMine = () => { setBase(conflict.updatedAt || ''); setConflict(null); tell('Press Save to put yours in its place'); };
  const addFile = async (e) => {
    const file = e.currentTarget.files?.[0];
    e.currentTarget.value = '';
    if (!file) return;
    setSaving(true);
    // A paper not saved yet is saved first: a file needs somewhere to go
    const put = id ? { id } : await save({ hide: true });
    if (put) {
      const form = new FormData();
      form.set('file', file);
      form.set('docId', put.id);
      const j = await call(null, { form });
      if (j.ok) { tell('Added'); await load(); } else tell(j.error || 'That file didn’t go up. Try again.', true);
    }
    setSaving(false);
  };
  const close = async () => { if (changed && !(await askToLeave(`“${title || 'this paper'}”`))) return; onDone(); };
  const files = current.files || [];
  const views = viewerFiles(files);
  return html`<div class="ar-editor">
    ${conflict ? html`<div class="ar-note" role="alert">
      <p><strong>${conflict.updatedBy || 'Someone'} saved this while you were working.</strong> Your words are still here.</p>
      <div class="ar-btns"><button type="button" class="ar-btn ar-btn--small" onClick=${takeTheirs}>Load their version</button><button type="button" class="ar-btn ar-btn--small" onClick=${keepMine}>Keep mine</button></div>
    </div>` : null}
    <${Field} label="Title"><input class="ar-input" maxlength="160" value=${title} onInput=${(e) => setTitle(e.currentTarget.value)} /><//>
    ${library ? html`
      <${Field} label="A few words about it" hint="Optional"><input class="ar-input" maxlength="200" value=${note} onInput=${(e) => setNote(e.currentTarget.value)} /><//>
      <${Field} label="Its web address" hint="Or add a file below"><input class="ar-input" type="url" inputmode="url" placeholder="https://" value=${url} onInput=${(e) => setUrl(e.currentTarget.value)} /><//>
      <${Field} label="Shelf"><select class="ar-input" value=${shelf} onChange=${(e) => setShelf(e.currentTarget.value)}>${data.shelves.map((sh) => html`<option value=${sh.id} key=${sh.id}>${sh.label}</option>`)}</select><//>
    ` : html`<${ReportEditor} value=${body} onChange=${setBody} resetKey=${fresh} label="The words" placeholder="The words advisors read" timed="read" fields=${false} minHeight=${200} />`}
    ${doc.kind === 'overview' ? html`<${Field} label="The PDF’s web address" hint="Advisors get an Open button for it"><input class="ar-input" type="url" inputmode="url" placeholder="https://" value=${url} onInput=${(e) => setUrl(e.currentTarget.value)} /><//>` : null}
    <div class="ar-files">
      ${files.length ? html`<ul class="ar-list">${files.map((f, i) => html`<li key=${f.id}><div class="ar-row ar-row--tight">
        <a ...${viewerLink(views, i)}>${f.name}</a><span class="ar-inline"><span class="ar-muted">${sizeText(f.size)}</span><${Sure} label="Remove" yes="Yes, remove it" cls="ar-btn--small" onYes=${() => act({ action: 'delete-file', id: f.id }, 'Removed')} /></span>
      </div></li>`)}</ul>` : null}
      <input ref=${fileRef} type="file" hidden onChange=${addFile} />
      <button type="button" class="ar-btn" disabled=${saving} onClick=${() => fileRef.current?.click()}>${files.length ? 'Add another file' : 'Add a file'}</button>
    </div>
    <${Toggle} checked=${shared} onChange=${setShared} label="On the advisors’ page" />
    ${saved && !saved.shared && shared ? html`<p class="ar-note">It’s saved as a draft. Press Save to put it on the page.</p>` : null}
    ${library && !url.trim() && !files.length ? html`<p class="ar-muted ar-small">Add a web address or a file so advisors have something to open.</p>` : null}
    <div class="ar-btns">
      <button type="button" class="ar-btn ar-btn--go" disabled=${saving || ctx.busy || !title.trim() || (library && !url.trim() && !files.length)} onClick=${async () => { if (await save()) onDone(); }}>Save</button>
      <button type="button" class="ar-btn ar-btn--quiet" onClick=${close}>Close</button>
      ${id ? html`<${Sure} label="Delete" yes="Yes, delete it" note=${kind?.sign ? 'Its signatures go with it.' : ''} onYes=${async () => { if (await act({ action: 'delete-doc', id }, 'Deleted')) onDone(); }} />` : null}
    </div>
  </div>`;
}

// ═══════════════════════════════════════════════════════════════════
// The look: its own, so it's the same in the staff admin and on the advisors' page
// ═══════════════════════════════════════════════════════════════════
let styled = false;
function addStyles() {
  if (styled || typeof document === 'undefined') return;
  styled = true;
  const el = document.createElement('style');
  el.id = 'ar-styles';
  el.textContent = STYLES;
  document.head.appendChild(el);
}
const STYLES = `
.ar { --ar-ink: #2D2F2C; --ar-ink-2: #4E504C; --ar-muted: #5F615A; --ar-line: #E7E5DE; --ar-line-2: #D3D0C7; --ar-warm: #F5F4F0; --ar-yellow: #FFDA24; --ar-yellow-2: #F5CC00; --ar-ok: #2B7349; --ar-ok-bg: #E7F3EB; --ar-warn: #84550C; --ar-warn-bg: #FBF0D9;
  container-type: inline-size; color: var(--ar-ink); font-size: 15px; line-height: 1.5; overflow-wrap: anywhere; }
.ar.is-busy .ar-btn { cursor: progress; }
.ar *, .ar *::before { box-sizing: border-box; }
.ar p { margin: 0; }
.ar a { color: inherit; }
.ar-muted { color: var(--ar-muted); }
.ar-small { font-size: 0.88em; }
.ar-loading { padding: 2em 0; }
.ar-stack, .ar-col { display: grid; grid-template-columns: minmax(0, 1fr); gap: 14px; align-content: start; min-width: 0; }
.ar-cols { display: grid; gap: 14px; grid-template-columns: minmax(0, 1fr); }
@container (min-width: 940px) { .ar-cols { grid-template-columns: minmax(0, 1.5fr) minmax(0, 1fr); } .ar-wide { grid-column: 1 / -1; } }
.ar-wide { min-width: 0; }
.ar-tabs { display: inline-flex; gap: 2px; max-width: 100%; margin: 0 0 14px; padding: 3px; border-radius: 12px; background: var(--ar-warm); overflow-x: auto; }
.ar-tabs button { flex: none; min-height: 40px; padding: 0 16px; border: 0; border-radius: 9px; background: none; color: var(--ar-ink-2); font: inherit; font-weight: 600; cursor: pointer; }
.ar-tabs button.is-on { background: #fff; color: var(--ar-ink); box-shadow: 0 1px 2px rgba(45, 47, 44, 0.12); }
.ar-card { background: #fff; border: 1px solid var(--ar-line); border-radius: 14px; padding: 16px 18px; min-width: 0; }
.ar-card__h { margin: 0 0 12px; }
.ar-card__h h3 { display: flex; align-items: center; gap: 8px; margin: 0; font-size: 1.1em; font-weight: 700; line-height: 1.3; }
.ar-card__h p { margin-top: 2px; font-size: 0.93em; }
.ar-count { min-width: 22px; padding: 0 7px; border-radius: 999px; background: var(--ar-yellow); font-size: 0.8em; font-weight: 700; text-align: center; }
.ar-empty { text-align: center; padding: 32px 18px; display: grid; gap: 10px; justify-items: center; }
.ar-empty__t { font-weight: 700; font-size: 1.1em; }
.ar-list { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: minmax(0, 1fr); min-width: 0; }
.ar-list > li + li { border-top: 1px solid var(--ar-line); }
.ar-row { display: grid; grid-template-columns: minmax(0, 1fr); gap: 7px; padding: 12px 0; min-width: 0; }
.ar-list > li:first-child .ar-row { padding-top: 2px; }
.ar-list > li:last-child .ar-row { padding-bottom: 2px; }
.ar-row--tight { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 8px 14px; }
.ar-row__t { display: flex; align-items: baseline; flex-wrap: wrap; gap: 2px 8px; }
.ar-quote { padding-left: 11px; border-left: 3px solid var(--ar-line-2); color: var(--ar-ink-2); white-space: pre-wrap; overflow-wrap: anywhere; }
.ar-contact { display: flex; flex-wrap: wrap; gap: 3px 14px; overflow-wrap: anywhere; }
.ar-tags { display: flex; flex-wrap: wrap; gap: 5px; }
.ar-tag { padding: 1px 9px; border-radius: 999px; background: var(--ar-warm); color: var(--ar-ink-2); font-size: 0.85em; font-weight: 600; }
.ar-tag--ok { background: var(--ar-ok-bg); color: var(--ar-ok); }
.ar-facts { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: 1px 12px; margin: 0; }
.ar-facts dt { color: var(--ar-muted); }
.ar-facts dd { margin: 0; overflow-wrap: anywhere; }
.ar-field { display: grid; grid-template-columns: minmax(0, 1fr); align-content: start; gap: 3px; min-width: 0; }
.ar-field__l { font-size: 0.9em; font-weight: 600; color: var(--ar-ink-2); }
.ar-field__h { font-size: 0.85em; color: var(--ar-muted); }
.ar .ar-input { width: 100%; max-width: 100%; min-width: 0; min-height: 42px; margin: 0; padding: 8px 11px; border: 1px solid var(--ar-line-2); border-radius: 9px; background: #fff; color: var(--ar-ink); font: inherit; }
textarea.ar-input { resize: vertical; }
.ar-input:focus-visible, .ar-btn:focus-visible, .ar-seg button:focus-visible { outline: 3px solid var(--ar-ink); outline-offset: 1px; }
.ar .ar-input--date { width: 11.5em; }
.ar-grid2 { display: grid; gap: 10px 12px; grid-template-columns: minmax(0, 1fr); flex: 1 1 18em; min-width: 0; }
@container (min-width: 520px) { .ar-grid2 { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); } }
.ar-inline { display: flex; flex-wrap: wrap; align-items: flex-end; gap: 8px 10px; }
.ar-inline .ar-field { flex: 1 1 13em; }
.ar-btns { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-top: 2px; }
.ar-btn { display: inline-flex; align-items: center; justify-content: center; min-height: 42px; padding: 6px 15px; border: 1px solid var(--ar-line-2); border-radius: 10px; background: #fff; color: var(--ar-ink); font: inherit; font-weight: 600; cursor: pointer; }
.ar-btn:hover:not(:disabled) { border-color: var(--ar-ink-2); }
.ar-btn:disabled { opacity: 0.5; cursor: default; }
.ar-btn--go { background: var(--ar-yellow); border-color: var(--ar-yellow); color: #1E1F1C; }
.ar-btn--go:hover:not(:disabled) { background: var(--ar-yellow-2); border-color: var(--ar-yellow-2); }
.ar-btn--quiet { background: none; border-color: transparent; }
.ar-btn--small { min-height: 36px; padding: 3px 12px; font-size: 0.93em; }
@media (max-width: 640px) {
  .ar .ar-btn, .ar .ar-btn--small, .ar .ar-tabs button, .ar .ar-seg button, .ar .ar-input, .ar .ar-fold > summary, .ar .ar-toggle { min-height: 44px; }
  .ar-toggle { align-items: center; }
  .ar-row a:not(.ar-btn), .ar-files a:not(.ar-btn) { display: inline-block; padding: 0.7em 0; margin: -0.7em 0; }
}
.ar-sure { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 6px 8px; }
.ar-sure__n { flex-basis: 100%; color: var(--ar-ink-2); font-size: 0.9em; }
.ar-seg { display: inline-flex; flex-wrap: wrap; gap: 2px; width: max-content; max-width: 100%; padding: 3px; border-radius: 11px; background: var(--ar-warm); }
.ar-seg button:disabled { cursor: progress; }
.ar-seg button { min-height: 38px; padding: 0 13px; border: 0; border-radius: 8px; background: none; color: var(--ar-ink-2); font: inherit; font-weight: 600; cursor: pointer; }
.ar-seg button[aria-pressed="true"] { background: var(--ar-yellow); color: #1E1F1C; }
.ar-sub { display: grid; grid-template-columns: minmax(0, 1fr); gap: 9px; margin-top: 13px; padding-top: 13px; border-top: 1px solid var(--ar-line); }
.ar-sub h4 { margin: 0; font-size: 1em; }
.ar-fold { margin-top: 11px; border-top: 1px solid var(--ar-line); }
.ar-fold > summary { min-height: 42px; display: flex; align-items: center; gap: 8px; font-weight: 600; cursor: pointer; list-style: none; }
.ar-fold > summary::-webkit-details-marker { display: none; }
.ar-fold > summary::before { content: ''; flex: none; width: 8px; height: 8px; margin-left: 2px; border-right: 2px solid var(--ar-muted); border-bottom: 2px solid var(--ar-muted); transform: rotate(-45deg); transition: transform 0.15s; }
.ar-fold[open] > summary::before { transform: rotate(45deg); }
@media (prefers-reduced-motion: reduce) { .ar-fold > summary::before { transition: none; } }
.ar-fold__b { display: grid; grid-template-columns: minmax(0, 1fr); gap: 10px; padding-bottom: 6px; }
.ar-big { font-size: 1.55em; font-weight: 700; line-height: 1.25; }
.ar-big .ar-muted { font-size: 0.62em; font-weight: 500; }
.ar-shelf + .ar-shelf { margin-top: 14px; padding-top: 12px; border-top: 1px solid var(--ar-line); }
.ar-shelf h4 { margin: 0 0 4px; font-size: 1em; }
.ar-stack--tight { gap: 8px; }
.ar-goal { display: flex; align-items: center; flex-wrap: wrap; gap: 12px 24px; margin: 4px 0 8px; }
.ar-thermo { display: block; flex: none; width: 114px; height: 220px; }
.ar-goal__w { flex: 1 1 200px; min-width: 0; }
.ar-plain { margin: 3px 0 0; padding-left: 18px; }
.ar-note { padding: 7px 11px; border-radius: 9px; background: var(--ar-warn-bg); color: var(--ar-warn); font-size: 0.93em; }
.ar-money { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
.ar-money li { display: flex; justify-content: space-between; gap: 12px; }
.ar-answers { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
.ar-answers li { display: grid; gap: 1px; }
.ar-answers li > span:not(.ar-answers__w) { color: var(--ar-ink-2); white-space: pre-wrap; }
.ar-answers__w { display: flex; flex-wrap: wrap; align-items: center; gap: 2px 8px; }
.ar-kid { display: flex; align-items: center; gap: 12px; }
.ar-kid img { border-radius: 12px; object-fit: cover; }
.ar-kid--small { gap: 9px; font-weight: 600; }
.ar-addr { font-weight: 700; overflow-wrap: anywhere; }
.ar-toggle { display: flex; align-items: flex-start; gap: 11px; cursor: pointer; }
.ar-toggle input { position: absolute; opacity: 0; width: 1px; height: 1px; }
.ar-toggle__t { flex: none; position: relative; width: 44px; height: 26px; margin-top: 1px; border-radius: 999px; background: #B9B7AE; transition: background 0.2s; }
.ar-toggle__t::after { content: ''; position: absolute; left: 3px; top: 3px; width: 20px; height: 20px; border-radius: 50%; background: #fff; transition: transform 0.2s; }
.ar-toggle input:checked + .ar-toggle__t { background: var(--ar-ok); }
.ar-toggle input:checked + .ar-toggle__t::after { transform: translateX(18px); }
.ar-toggle input:focus-visible + .ar-toggle__t { outline: 3px solid var(--ar-ink); outline-offset: 2px; }
.ar-toggle__w { display: grid; min-width: 0; }
.ar-toggle__w .ar-muted { font-size: 0.9em; }
.ar-table { display: grid; }
.ar-tr { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 1fr) minmax(0, 1fr) minmax(0, 1.1fr); gap: 4px 14px; align-items: center; padding: 9px 0; border-top: 1px solid var(--ar-line); }
.ar-tr--h { border-top: 0; padding-top: 0; color: var(--ar-muted); font-size: 0.86em; font-weight: 600; }
.ar-who { display: flex; align-items: center; gap: 10px; min-width: 0; }
.ar-who > span { display: grid; min-width: 0; }
.ar-face { flex: none; width: var(--s, 36px); height: var(--s, 36px); border-radius: 50%; object-fit: cover; }
.ar-face--i { display: grid; place-items: center; background: var(--ar-warm); color: var(--ar-ink-2); font-size: 0.8em; font-weight: 700; }
@container (max-width: 640px) {
  .ar-tr--h { display: none; }
  .ar-tr { grid-template-columns: minmax(0, 1fr); }
  .ar-tr > [data-label] { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 2px 10px; font-size: 0.95em; }
  .ar-tr > [data-label]::before { content: attr(data-label); color: var(--ar-muted); }
}
.ar-editor { display: grid; grid-template-columns: minmax(0, 1fr); gap: 11px; margin: 7px 0; padding: 14px; border: 1px solid var(--ar-line-2); border-radius: 12px; background: #FEFCF5; min-width: 0; }
.ar-files { display: grid; gap: 7px; justify-items: start; }
.ar-files .ar-list { width: 100%; }
`;
