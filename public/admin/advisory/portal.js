/**
 * The Advisory Board's page (/admin/advisory/)
 * ============================================
 * Advisors said yes to a job: help fund one makeover, open doors, show up, four meetings a year. So this page is
 * built around doing it, where the board's is built around looking things up.
 *
 *   #/                 Home: the next meeting, this month's ask, their to-dos, the group's makeover, what's coming up
 *   #/introductions    Who we're looking for, "I know someone", and what became of each of theirs
 *   #/fundraise        The goal and their part (the only page with dollars on it), their page, what to share, hosting
 *   #/meetings[/<id>]  ./meetings.js
 *   #/people           The advisors, and the papers
 *   #/papers/<id>      One paper, read and signed
 *   #/run[/<tab>]      Running the group, for whoever does (../advisory-admin.js, the same module as the staff admin's)
 *
 * Signed in with the same emailed code as staff. What it's sent is an allow-list (functions/api/_advisory-portal.js):
 * nothing of the board's and no other advisor's email. Only an advisor answers, signs or introduces; anyone else who
 * can open it sees it as advisors do. Dollars stay on Fundraise: no goal bar near a kid or a reveal.
 */

import './links.js';
import { h, htm, render, useState, useEffect, useRef, qrcode } from '../vendor.js';
import { viewerLink, sizeText } from '../file-viewer.js';
import { shortDate, isDate } from '../board-shared.js';
import { Report } from '../board-report.js';
import { mdPlain } from '../board-md.js';
import { askToLeave } from '../ask.js';
import { api } from './api.js';
import { Icon, PageNav, Avatar, DateTile, WindowTile, windowStart, SecHead, noon } from '../board/parts.js';
import { MeetingsPage, NextMeeting } from './meetings.js';

const html = htm.bind(h);
const API = '/api/advisory-portal';
const LOGO = '/cdn-cgi/imagedelivery/ROYFuPmfN2vPS6mt5sCkZQ/brand-logo-admin/w=128';
const QUESTIONS = 'info@soardcharity.com';
const NAV = [['', 'Home', 'home'], ['introductions', 'Introductions', 'hello', 'Intros'], ['fundraise', 'Fundraise', 'heart'], ['meetings', 'Meetings', 'meetings'], ['people', 'People', 'people']];
const RUN = ['run', 'Run it', 'sliders'];
const PAGES = [...NAV.map(([p]) => p), 'run', 'papers'];

const call = (body) => api(API, body);
// What's half typed in a form, kept while the page is open: going to another tab and back doesn't lose it
const drafts = new Map();
function useDraft(key, blank) {
  const [v, setV] = useState(() => drafts.get(key) ?? blank);
  const set = (x) => { drafts.set(key, x); setV(x); };
  return [v, set, () => { drafts.delete(key); setV(blank); }];
}
const readRoute = () => {
  const [page = '', id = null] = location.hash.replace(/^#\/?/, '').split('/').map((x) => { try { return decodeURIComponent(x); } catch { return ''; } });
  return { page: PAGES.includes(page) ? page : '', id: id || null };
};

// ─── Words ──────────────────────────────────────────────────────────
const firstName = (n) => String(n || '').split(/\s+/)[0];
const dollars = (n) => `$${Math.round(Number(n) || 0).toLocaleString('en-US')}`;
const greeting = () => { const hr = Number(new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone: 'America/New_York' }).format(new Date())); return hr < 12 ? 'Good morning' : hr < 17 ? 'Good afternoon' : 'Good evening'; };
const dayOf = (d) => (isDate(d) ? new Date(noon(d)).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' }) : '');
const monthOf = (w) => (windowStart(w) ? new Date(noon(windowStart(w))).toLocaleDateString('en-US', { month: 'long', timeZone: 'UTC' }) : '');
const windowWords = (w) => w?.label || [w?.part, monthOf(w)].filter(Boolean).join(' ');
const dateOfIso = (iso) => { const t = Date.parse(iso || ''); return Number.isFinite(t) ? new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/New_York' }) : ''; };
const rise = (i) => `--i:${i}`;
const fileUrl = (f) => `/api/advisory-file?id=${encodeURIComponent(f.id)}`;
const viewerFiles = (files) => files.map((f) => ({ name: f.name, type: f.type, size: f.size, at: f.at, url: fileUrl(f) }));

// ─── The page around it all ─────────────────────────────────────────
// A note typed on the ask, kept while the page is open (moving between tabs redraws Home)
const askDrafts = new Map();

function App() {
  const [data, setData] = useState(null);
  const [fail, setFail] = useState(null);
  const [route, setRoute] = useState(readRoute);
  const [note, setNote] = useState(null);
  // Words typed on Run it and not saved yet: asked about before leaving
  const unsaved = useRef('');
  const load = async ({ keep = false } = {}) => {
    const j = await call();
    if (j.ok) { setData(j); setFail(null); } else if (!keep) setFail(j);
    return j;
  };
  useEffect(() => {
    load();
    let at = Date.now();
    const back = () => { if (document.visibilityState === 'visible' && Date.now() - at > 10 * 1000) { at = Date.now(); call().then((j) => { if (j.ok) setData(j); }); } };
    addEventListener('focus', back);
    document.addEventListener('visibilitychange', back);
    return () => { document.removeEventListener('visibilitychange', back); removeEventListener('focus', back); };
  }, []);
  useEffect(() => {
    let was = readRoute();
    let hash = location.hash;
    const on = async () => {
      const r = readRoute();
      if (unsaved.current && (r.page !== was.page || r.id !== was.id)) {
        const to = location.hash;
        history.replaceState(null, '', hash || '#/');
        if (!(await askToLeave(unsaved.current))) return;
        unsaved.current = '';
        history.replaceState(null, '', to);
      }
      // A new page starts at the top; a tab of Run it stays where it is
      if (r.page !== was.page || (r.page !== 'run' && r.id !== was.id)) scrollTo(0, 0);
      was = r;
      hash = location.hash;
      setRoute(r);
    };
    const closing = (e) => { if (unsaved.current) { e.preventDefault(); e.returnValue = ''; } };
    addEventListener('hashchange', on);
    addEventListener('beforeunload', closing);
    return () => { removeEventListener('hashchange', on); removeEventListener('beforeunload', closing); };
  }, []);
  useEffect(() => { if (!note || note.act) return undefined; const t = setTimeout(() => setNote(null), note.tone ? 6000 : 3200); return () => clearTimeout(t); }, [note]);
  useEffect(() => { document.documentElement.classList.toggle('is-scrolled', false); const f = () => document.documentElement.classList.toggle('is-scrolled', scrollY > 8); addEventListener('scroll', f, { passive: true }); return () => removeEventListener('scroll', f); }, []);
  useEffect(() => {
    if (!data || matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;
    const root = document.documentElement;
    root.classList.add('is-entering');
    const t = setTimeout(() => root.classList.remove('is-entering'), 1400);
    return () => clearTimeout(t);
  }, [!!data]);
  useEffect(() => {
    const label = [...NAV, RUN].find(([p]) => p === route.page)?.[1];
    document.title = `${route.page && label ? label : 'Home'} · SOARD Advisory Board`;
  }, [route]);

  if (fail) {
    // (a board member who isn't on the committee, the one sign-in that gets here and has somewhere else to go)
    const staff = fail.status === 403 && /advisory page is for/i.test(fail.error || '');
    if (fail.signedOut) {
      return html`<div class="bp-fail" role="alert">
        <img src=${LOGO} alt="" width="64" height="64" />
        <h1>Your sign-in ended</h1>
        <p>Reload the page and we’ll send you a new code.</p>
        <p class="bp-btns bp-btns--center"><button type="button" class="bp-btn bp-btn--primary" onClick=${() => location.reload()}>Reload</button></p>
      </div>`;
    }
    return html`<div class="bp-fail" role="alert">
      <img src=${LOGO} alt="" width="64" height="64" />
      <h1>${fail.status === 403 ? 'This page is for SOARD’s Advisory Board' : 'The advisory page didn’t open'}</h1>
      <p>${fail.status === 403 ? `It opens for the email address SOARD has on file for each advisor. If that should be you, write to ${QUESTIONS} and we’ll check the address we have.` : fail.error}</p>
      <p class="bp-btns bp-btns--center">${staff ? html`<a class="bp-btn" href="/admin/board/">Go to the board page</a>` : null}<button type="button" class="bp-btn" onClick=${() => load()}>Try again</button><a class="bp-btn bp-btn--quiet" href="/cdn-cgi/access/logout">Sign out</a></p>
    </div>`;
  }
  if (!data) return html`<div class="bp-boot"><img src=${LOGO} alt="" width="56" height="56" /><p>Opening the advisory page…</p></div>`;
  const say = (text, tone = '', act = null) => setNote({ text, tone, act, at: Date.now() });
  /** A change, then the page as it is now. A refusal says why and leaves what they typed where it is */
  const post = async (body, done = '', { refused = null } = {}) => {
    const j = await call(body);
    if (!j.ok) {
      say(j.error || 'That didn’t save. Try again.', 'warn', j.signedOut ? { label: 'Reload', fn: () => location.reload() } : null);
      // Something moved on underneath them (the ask closed, the paper went): the page catches up, what they typed stays
      if (j.status === 404 || j.status === 409) await load({ keep: true });
      refused?.(j);
      return null;
    }
    if (done) say(done);
    await load({ keep: true });
    return j;
  };
  const ctx = { data, setData, load, post, say, route, setUnsaved: (where) => { unsaved.current = where; } };
  const items = data.me.runs ? [...NAV, RUN] : NAV;
  const page = route.page === 'introductions' ? html`<${IntroductionsPage} ctx=${ctx} />`
    : route.page === 'fundraise' ? html`<${FundraisePage} ctx=${ctx} />`
      : route.page === 'meetings' ? html`<${MeetingsPage} ctx=${ctx} key=${route.id || 'all'} />`
        : route.page === 'people' ? html`<${PeoplePage} ctx=${ctx} />`
          : route.page === 'papers' ? html`<${PaperPage} id=${route.id} ctx=${ctx} key=${route.id} />`
            : route.page === 'run' && data.me.runs ? html`<${RunPage} ctx=${ctx} />`
              : html`<${HomePage} ctx=${ctx} />`;
  return html`
    <a class="bp-skip" href="#main" onClick=${(e) => { e.preventDefault(); document.getElementById('main')?.focus(); }}>Skip to the page</a>
    <header class="bp-top">
      <div class="bp-bar">
        <a class="bp-brand" href="#/"><img src=${LOGO} alt="SOARD Advisory Board home" width="44" height="44" /><span class="bp-brand__words"><strong>Sunshine on a Ranney Day</strong> <small>Advisory Board</small></span></a>
        <${PageNav} items=${items} page=${route.page === 'papers' ? 'people' : route.page} label="Advisory Board" due=${{ people: data.todos.filter((t) => t.kind === 'sign').length }} />
        <div class="bp-tools"><${Account} data=${data} /></div>
      </div>
    </header>
    <main class="bp-main" id="main" tabindex="-1" key=${route.page}><div class="ad-page">${page}</div></main>
    <footer class="bp-foot">
      <div class="bp-foot__in">
        <p>Questions about this page? <a href=${`mailto:${QUESTIONS}`}>${QUESTIONS}</a></p>
        <p class="bp-muted"><a href="/cdn-cgi/access/logout">Sign out</a></p>
      </div>
    </footer>
    <div class=${`bp-toast ${note ? 'is-on' : ''} ${note?.tone ? `bp-toast--${note.tone}` : ''}`} role="status" aria-live="polite">${note ? html`<${Icon} name="check" size=${18} /><span>${note.text}</span>${note.act ? html`<button type="button" class="bp-toast__act" onClick=${note.act.fn}>${note.act.label}</button>` : null}` : null}</div>`;
}

function Account({ data }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const away = (e) => { if (!ref.current?.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') { setOpen(false); ref.current?.querySelector('button')?.focus(); } };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  const card = data.people.find((p) => p.slug === data.me.slug) || { name: data.me.name || 'SOARD' };
  const admin = data.me.kind === 'admin';
  return html`<div class="bp-me" ref=${ref}>
    <button type="button" class="bp-me__btn" aria-expanded=${open} aria-haspopup="true" aria-label=${`${firstName(card.name)}, your account`} onClick=${() => setOpen(!open)}>
      <${Avatar} p=${card} size=${36} /><span class="bp-me__name">${firstName(card.name)}</span>
    </button>
    <div class=${`bp-menu ${open ? 'is-open' : ''}`} role="menu" hidden=${!open}>
      <div class="bp-menu__who"><strong>${card.name}</strong><span>${{ advisor: 'Advisory Board', lead: 'Runs the Advisory Board', committee: 'Advisory Board committee', admin: 'SOARD staff' }[data.me.kind]}</span></div>
      ${admin ? html`<a role="menuitem" href="/admin/#board/advisory"><${Icon} name="back" size=${18} />Back to Board</a>` : data.me.kind !== 'advisor' ? html`<a role="menuitem" href="/admin/board/"><${Icon} name="back" size=${18} />Back to the board page</a>` : null}
      <a role="menuitem" href="/cdn-cgi/access/logout"><${Icon} name="logout" size=${18} />Sign out</a>
    </div>
  </div>`;
}

// ─── Home ───────────────────────────────────────────────────────────
function HomePage({ ctx }) {
  const { data } = ctx;
  const { me, ask, todos } = data;
  const name = firstName(me.name);
  const today = new Date(noon(data.today)).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'UTC' });
  return html`<div class="ad-home">
    <header class="bp-brief bp-rise" style=${rise(0)}>
      <h1 class="bp-brief__h">${name ? `${greeting()}, ${name}.` : 'The Advisory Board'}</h1>
      <p class="bp-brief__date">${today}</p>
    </header>
    ${me.answers ? null : html`<p class="ad-seeing bp-rise" style=${rise(0)}>This is the page as advisors see it. Only an advisor can answer or sign here.${me.runs ? html` <a href="#/run">Go to Run it</a>` : null}</p>`}
    <div class="bp-meets">
      <div class="bp-meets__col bp-rise" style=${rise(1)}>
        <${NextMeeting} ctx=${ctx} />
        ${ask ? html`<${AskCard} ctx=${ctx} key=${ask.id} />` : null}
      </div>
      <div class="bp-meets__col bp-rise" style=${rise(2)}>
        ${todos.length ? html`<${ForYou} ctx=${ctx} />` : null}
        <${MakeoverCard} m=${data.makeover} />
      </div>
    </div>
    <div class="bp-rise" style=${rise(3)}><${Doors} ctx=${ctx} /></div>
    <div class="bp-rise" style=${rise(4)}><${ComingUp} data=${data} /></div>
    ${data.rooms.length ? html`<div class="bp-rise" style=${rise(5)}><${Rooms} rooms=${data.rooms} /></div>` : null}
    ${me.answers ? html`<div class="bp-rise" style=${rise(6)}><${YourYear} ctx=${ctx} /></div>` : null}
  </div>`;
}

/** This month's one ask. An answer is a tap; a line of text is a second, optional step */
function AskCard({ ctx }) {
  const { data, post, setData } = ctx;
  const { ask, me } = data;
  const mine = ask.mine;
  const [note, setNoteNow] = useState(askDrafts.get(ask.id) ?? mine?.note ?? '');
  const setNote = (v) => { askDrafts.set(ask.id, v); setNoteNow(v); };
  const [busy, setBusy] = useState(false);
  const [changing, setChanging] = useState(false);
  const answer = async (a, typed = note) => {
    setBusy(true);
    const j = await post({ action: 'answer', askId: ask.id, answer: a, note: typed }, a === 'yes' ? 'Thank you. We’ll be in touch.' : 'Thanks for letting us know.');
    setBusy(false);
    if (j) { setChanging(false); setData((d) => ({ ...d, ask: { ...d.ask, mine: j.mine } })); }
  };
  return html`<section class="bp-card ad-ask" aria-labelledby="ask-h">
    <p class="ad-kicker">This month’s ask</p>
    <h2 class="ad-ask__t" id="ask-h">${ask.title}</h2>
    ${ask.body ? html`<p class="ad-ask__b">${ask.body}</p>` : null}
    ${ask.link ? html`<p><a class="bp-link" href=${ask.link} target="_blank" rel="noopener">Read more</a></p>` : null}
    ${!me.answers ? null : mine && !changing ? html`<div class="ad-answered">
        <p><${Icon} name="check" size=${18} /> ${mine.answer === 'yes' ? 'You said you can help. Thank you.' : 'You said not this time. Thanks for answering.'}</p>
        ${mine.note ? html`<p class="bp-muted">“${mine.note}”</p>` : null}
        <button type="button" class="bp-btn bp-btn--sm" onClick=${() => setChanging(true)}>Change my answer</button>
      </div>` : html`<div class="ad-answer">
        <label class="ad-field"><span>Anything to add? This part is optional.</span><textarea class="ad-input" id="ask-note" rows="2" maxlength="800" value=${note} onInput=${(e) => setNote(e.currentTarget.value)}></textarea></label>
        <div class="bp-btns"><button type="button" class="bp-btn bp-btn--primary" disabled=${busy} onClick=${() => answer('yes')}>I can help</button><button type="button" class="bp-btn" disabled=${busy} onClick=${() => answer('no')}>Not this time</button></div>
      </div>`}
  </section>`;
}

function ForYou({ ctx }) {
  const { data, post } = ctx;
  const [busy, setBusy] = useState(false);
  const renew = async () => { setBusy(true); await post({ action: 'renew' }, 'You’re renewed for another year. Thank you.'); setBusy(false); };
  return html`<section class="bp-card bp-forme" aria-labelledby="todo-h">
    <div class="bp-cardhead"><h2 class="bp-h2" id="todo-h">For you<span class="bp-count">${data.todos.length}</span></h2></div>
    <ul class="bp-todos">${data.todos.map((t) => (t.kind === 'sign'
    ? html`<li class="bp-todo-card" key="sign"><a class="bp-todo bp-todo--link" href=${`#/papers/${t.id}`}>
        <span class="bp-todo__icon"><${Icon} name="documents" size=${20} /></span>
        <span class="bp-todo__text"><span class="bp-todo__title">${t.title}</span><span class="bp-todo__meta">Once a year, with your name typed</span></span>
        <${Icon} name="arrow" size=${18} cls="bp-go" />
      </a></li>`
    : html`<li class="bp-todo-card" key="renew"><div class="bp-todo">
        <span class="bp-todo__icon"><${Icon} name="star" size=${20} /></span>
        <span class="bp-todo__text"><span class="bp-todo__title">${t.title}</span><span class="bp-todo__meta">Your term ${t.ends < data.today ? 'ended' : 'ends'} ${shortDate(t.ends)}</span></span>
        <button type="button" class="bp-btn bp-btn--primary bp-btn--sm" disabled=${busy} onClick=${renew}>Renew</button>
      </div></li>`))}</ul>
  </section>`;
}

/** The group's makeover: never a dollar here */
function MakeoverCard({ m }) {
  if (m?.state === 'kid') {
    const r = m.reveal;
    return html`<section class="bp-card ad-kid" aria-labelledby="kid-h">
      ${m.photo ? html`<img class="ad-kid__photo" src=${m.photo} alt="" loading="lazy" />` : null}
      <div class="ad-kid__b">
        <p class="ad-kicker">Your makeover</p>
        <h2 class="bp-h2" id="kid-h">${m.name}</h2>
        <p class="bp-chips"><span class="bp-chip bp-chip--ok">${m.stage}</span></p>
        <dl class="ad-dates">
          ${m.demo ? html`<dt>Demo Day</dt><dd>${dayOf(m.demo)}</dd>` : null}
          ${r ? html`<dt>Reveal</dt><dd>${r.date ? dayOf(r.date) : windowWords(r.window)}${r.confirmed === false ? ' (planned)' : ''}</dd>` : null}
        </dl>
        <a class="bp-link" href=${m.url} target="_blank" rel="noopener">Read ${m.name}’s story</a>
      </div>
    </section>`;
  }
  return html`<section class="bp-card ad-kid ad-kid--open" aria-labelledby="kid-h">
    <p class="ad-kicker">Your makeover</p>
    <h2 class="bp-h2" id="kid-h">A real room for a real child</h2>
    <p class="bp-muted">When the group reaches its goal, you’ll sponsor one child’s makeover. Their story, their build, and their reveal will show here.</p>
  </section>`;
}

const DOORS = [
  ['#/introductions', 'hello', 'Open a door', 'Tell us who to meet. We’ll let you know how it goes.'],
  ['#/fundraise', 'share', 'Share SOARD', 'Words to post, your page to send, and how to host a fundraiser.'],
  ['#/people', 'people', 'Meet the group', 'See who’s serving with you.'],
];
function Doors() {
  return html`<nav class="ad-doors" aria-label="Ways to help">${DOORS.map(([href, icon, t, sub]) => html`<a class="bp-card bp-card--link ad-door" href=${href} key=${href}>
    <${Icon} name=${icon} size=${24} /><span><strong>${t}</strong><span class="bp-muted">${sub}</span></span>
  </a>`)}</nav>`;
}

function ComingUp({ data }) {
  const { reveals, events, hosted } = data.coming;
  const rows = [
    ...reveals.map((r) => ({ key: `r-${r.date}-${r.slug || ''}-${windowStart(r.window)}`, date: r.date || windowStart(r.window), w: r.date ? null : r.window, title: r.name ? `${r.name}’s reveal` : 'A makeover reveal', sub: r.date ? (r.confirmed === false ? 'Date to be confirmed' : 'Your invite comes by calendar') : 'Date to be set', href: r.url || '', photo: r.photo })),
    ...events.map((e) => ({ key: `e-${e.slug}`, date: e.date, title: e.title, sub: [e.time, e.location].filter(Boolean).join(' · '), href: e.url })),
    ...hosted.map((x) => ({ key: `h-${x.id}`, date: x.date, title: x.title, sub: x.where || 'Hosted by an advisor', href: x.giveUrl })),
  ].filter((x) => x.date).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 6);
  return html`<section class="bp-card" aria-labelledby="up-h">
    <${SecHead} title="Coming up" id="up-h" />
    ${rows.length ? html`<ul class="ad-rows">${rows.map((x) => {
    const row = html`${x.w ? html`<${WindowTile} w=${x.w} />` : html`<${DateTile} d=${x.date} />`}<span class="ad-rows__t"><strong>${x.title}</strong>${x.sub ? html`<span class="bp-muted">${x.sub}</span>` : null}</span>${x.href ? html`<${Icon} name="arrow" size=${18} cls="bp-go" />` : null}`;
    return html`<li key=${x.key}>${x.href ? html`<a class="ad-rows__row" href=${x.href} target=${/^https?:/.test(x.href) ? '_blank' : null} rel="noopener">${row}</a>` : html`<div class="ad-rows__row">${row}</div>`}</li>`;
  })}</ul>` : html`<p class="bp-muted">Reveals and events will show here as they’re set.</p>`}
  </section>`;
}

function Rooms({ rooms }) {
  return html`<section class="bp-card" aria-labelledby="rooms-h">
    <${SecHead} title="Rooms finished this year" count=${rooms.length} id="rooms-h" />
    <ul class="ad-rooms">${rooms.map((r) => html`<li key=${r.slug}><a href=${r.url} target="_blank" rel="noopener">
      ${r.photo ? html`<img src=${r.photo} alt="" loading="lazy" width="200" height="150" />` : html`<span class="ad-rooms__none" aria-hidden="true"></span>`}
      <strong>${r.name}</strong>
    </a></li>`)}</ul>
  </section>`;
}

function YourYear({ ctx }) {
  const { data } = ctx;
  const yes = data.intros.filter((i) => i.status === 'yes').length;
  return html`<section class="bp-card ad-year" aria-labelledby="year-h">
    <${SecHead} title="Your year" id="year-h" />
    <dl class="ad-stats">
      <div><dt>Introductions</dt><dd>${data.intros.length}</dd></div>
      <div><dt>Said yes</dt><dd>${yes}</dd></div>
      <div><dt>${data.term?.ends && data.term.ends < data.today ? 'Term ended' : 'Term ends'}</dt><dd>${data.term?.ends ? shortDate(data.term.ends) : '–'}</dd></div>
    </dl>
  </section>`;
}

// ─── Introductions ──────────────────────────────────────────────────
function IntroductionsPage({ ctx }) {
  const { data } = ctx;
  const [wish, setWish] = useState('');
  const formRef = useRef(null);
  const reply = (id) => { setWish(id); formRef.current?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' }); formRef.current?.querySelector('input')?.focus({ preventScroll: true }); };
  const on = data.wishes.find((w) => w.id === wish) || null;
  const statusOf = (id) => data.introStatuses.find((s) => s.id === id);
  return html`<div>
    <header class="bp-pagehead bp-rise" style=${rise(0)}><div><h1 class="bp-h1">Introductions</h1><p class="bp-lede">The people you know are how SOARD grows. Tell us who to meet, and we’ll tell you how it goes.</p></div></header>
    <div class="bp-split">
      <div class="bp-stack">
        <section class="bp-card bp-rise" style=${rise(1)} aria-labelledby="wish-h">
          <${SecHead} title="Who we’re looking for" id="wish-h" />
          ${data.wishes.length ? html`<ul class="ad-wishes">${data.wishes.map((w) => html`<li key=${w.id}>
            <div><strong>${w.title}</strong>${w.detail ? html`<p class="bp-muted">${w.detail}</p>` : null}</div>
            ${data.me.answers ? html`<button type="button" class="bp-btn bp-btn--sm" onClick=${() => reply(w.id)}>I know someone</button>` : null}
          </li>`)}</ul>` : html`<p class="bp-muted">The list is being put together. You can introduce anyone in the meantime.</p>`}
        </section>
        <section class="bp-card bp-rise" style=${rise(2)} aria-labelledby="mine-h">
          <${SecHead} title="Your introductions" count=${data.intros.length || null} id="mine-h" />
          ${data.intros.length ? html`<ul class="ad-intros">${data.intros.map((i) => {
    const s = statusOf(i.status);
    return html`<li key=${i.id}><div><strong>${i.name}</strong><span class="bp-muted">${[i.company, dateOfIso(i.at)].filter(Boolean).join(' · ')}</span></div>
              <div class="ad-intros__s"><span class=${`bp-chip ${i.status === 'yes' ? 'bp-chip--ok' : i.status === 'talking' ? 'bp-chip--info' : ''}`}>${s?.label || i.status}</span><span class="bp-muted">${s?.sub || ''}</span></div>
              ${i.note ? html`<p class="ad-intros__note">${i.note}</p>` : null}</li>`;
  })}</ul>` : html`<p class="bp-muted">${data.me.answers ? 'Your introductions will show here, with where each one stands.' : 'Each advisor sees their own here.'}</p>`}
        </section>
      </div>
      <section class="bp-card bp-rise ad-form" ref=${formRef} style=${rise(1)} aria-labelledby="know-h">
        <h2 class="bp-h2" id="know-h" tabindex="-1">I know someone</h2>
        ${data.me.answers ? html`<${IntroForm} ctx=${ctx} wish=${on} clearWish=${() => setWish('')} />` : html`<p class="bp-muted">Advisors introduce people here. What they send goes to whoever runs the group.</p>`}
      </section>
    </div>
  </div>`;
}

const blankIntro = { name: '', company: '', email: '', phone: '', how: '', help: [] };
function IntroForm({ ctx, wish, clearWish }) {
  const { data, post } = ctx;
  const [f, setF, clear] = useDraft('intro', blankIntro);
  const [busy, setBusy] = useState(false);
  const up = (k) => (e) => setF({ ...f, [k]: e.currentTarget.value });
  const flip = (id) => setF({ ...f, help: f.help.includes(id) ? f.help.filter((x) => x !== id) : [...f.help, id] });
  const send = async (e) => {
    e.preventDefault();
    setBusy(true);
    const j = await post({ action: 'intro', ...f, wish: wish?.id || '' }, 'Thank you. We’ll let you know how it goes.');
    setBusy(false);
    if (j) { clear(); clearWish(); }
  };
  return html`<form class="ad-fields" onSubmit=${send}>
    ${wish ? html`<p class="ad-for">For: ${wish.title} <button type="button" class="bp-more-btn ad-for__x" onClick=${clearWish}>Clear</button></p>` : null}
    <label class="ad-field"><span>Their name</span><input class="ad-input" id="in-name" required maxlength="120" autocomplete="off" value=${f.name} onInput=${up('name')} /></label>
    <label class="ad-field"><span>Company, if there is one</span><input class="ad-input" id="in-co" maxlength="120" autocomplete="off" value=${f.company} onInput=${up('company')} /></label>
    <div class="ad-two">
      <label class="ad-field"><span>Email</span><input class="ad-input" id="in-email" type="email" inputmode="email" maxlength="200" autocomplete="off" value=${f.email} onInput=${up('email')} /></label>
      <label class="ad-field"><span>Phone</span><input class="ad-input" id="in-phone" type="tel" inputmode="tel" maxlength="40" autocomplete="off" value=${f.phone} onInput=${up('phone')} /></label>
    </div>
    <label class="ad-field"><span>How do you know them?</span><textarea class="ad-input" id="in-how" rows="3" maxlength="800" value=${f.how} onInput=${up('how')}></textarea></label>
    <fieldset class="ad-chips"><legend>How could they help?</legend>
      ${data.introHelp.map((x) => html`<label key=${x.id} class=${f.help.includes(x.id) ? 'is-on' : ''}><input type="checkbox" checked=${f.help.includes(x.id)} onChange=${() => flip(x.id)} />${x.label}</label>`)}
    </fieldset>
    <div class="bp-btns"><button type="submit" class="bp-btn bp-btn--primary" disabled=${busy || !f.name.trim()}>${busy ? 'Sending…' : 'Send the introduction'}</button></div>
  </form>`;
}

// ─── Fundraise: the only page with dollars ──────────────────────────
function FundraisePage({ ctx }) {
  const { data } = ctx;
  const f = data.fundraise;
  const byKind = (k) => data.share.filter((d) => d.kind === k);
  const [pitch, posts, sponsor, matching, hosting] = ['pitch', 'post', 'sponsor', 'matching', 'hosting'].map(byKind);
  return html`<div>
    <header class="bp-pagehead bp-rise" style=${rise(0)}><div><h1 class="bp-h1">Fundraise</h1><p class="bp-lede">Together, the group funds one makeover each year.</p></div></header>
    <${GoalCard} f=${f} me=${data.me} />
    <div class="bp-split">
      <div class="bp-stack">
        ${f.ready ? html`<${PageCard} f=${f} me=${data.me} ctx=${ctx} />` : null}
        ${pitch.length || posts.length ? html`<section class="bp-card bp-rise" style=${rise(2)} aria-labelledby="say-h">
          <${SecHead} title="What to say" sub="Copy these and make them your own." id="say-h" />
          <div class="ad-copies">${[...pitch, ...posts].map((d) => html`<${CopyBlock} d=${d} ctx=${ctx} key=${d.id} />`)}</div>
        </section>` : null}
        ${[...sponsor, ...matching].map((d, i) => html`<section class="bp-card bp-rise" style=${rise(3 + i)} key=${d.id} aria-label=${d.title}>
          <${SecHead} title=${d.title} />
          ${d.body ? html`<${Report} text=${d.body} level=${3} />` : null}
          <${Files} files=${d.files} />
        </section>`)}
        ${!pitch.length && !posts.length && !sponsor.length && !matching.length ? html`<section class="bp-card bp-rise" style=${rise(2)}><${SecHead} title="What to say" /><p class="bp-muted">Ready-made words to share are on their way.</p></section>` : null}
      </div>
      <div class="bp-stack">
        <${HostCard} ctx=${ctx} guide=${hosting[0] || null} />
        <${BrandCard} org=${data.org} />
      </div>
    </div>
  </div>`;
}

function GoalCard({ f, me }) {
  if (!f.ready) {
    return html`<section class="bp-card ad-goal ad-goal--soon bp-rise" style=${rise(1)} aria-labelledby="goal-h">
      <p class="ad-kicker">This year’s goal</p>
      <h2 class="ad-goal__n" id="goal-h">${dollars(f.goal)}</h2>
      <p class="bp-muted">The group’s fundraising page is coming soon. Gifts will count here by themselves once it’s ready.</p>
    </section>`;
  }
  const pct = f.goal > 0 ? Math.min(100, Math.round((f.raised / f.goal) * 100)) : 0;
  return html`<section class="bp-card ad-goal bp-rise" style=${rise(1)} aria-labelledby="goal-h">
    <div class="ad-goal__top">
      <div><p class="ad-kicker">Raised together</p><h2 class="ad-goal__n" id="goal-h">${dollars(f.raised)} <span>of ${dollars(f.goal)}</span></h2></div>
      ${me.answers ? html`<div class="ad-goal__mine"><p class="ad-kicker">Through your page</p><p class="ad-goal__me">${dollars(f.mine)}</p><p class="bp-muted">${f.gifts === 1 ? '1 gift' : `${f.gifts || 0} gifts`}</p></div>` : null}
    </div>
    <div class="ad-bar" role="img" aria-label=${`${pct}% of the goal`}><i style=${`width:${pct}%`}></i></div>
  </section>`;
}

function PageCard({ f, me, ctx }) {
  const url = f.pageUrl || f.groupUrl;
  const mine = !!f.pageUrl;
  let svg = '';
  if (url) { try { const q = qrcode(0, 'M'); q.addData(url); q.make(); svg = q.createSvgTag({ cellSize: 6, margin: 2, scalable: true }); } catch { svg = ''; } }
  if (!url) return null;
  return html`<section class="bp-card bp-rise ad-pagecard" style=${rise(2)} aria-labelledby="page-h">
    <${SecHead} title=${mine ? 'Your page' : 'The group’s page'} sub="Send it to anyone. Every gift counts toward the goal." id="page-h" />
    <div class="ad-qr">
      ${svg ? html`<div class="ad-qr__c" role="img" aria-label="A code a phone camera can open" dangerouslySetInnerHTML=${{ __html: svg }}></div>` : null}
      <div class="ad-qr__t">
        <p class="ad-url">${url}</p>
        <div class="bp-btns"><${CopyBtn} text=${url} label="Copy the link" ctx=${ctx} primary=${true} /><a class="bp-btn" href=${url} target="_blank" rel="noopener">Open it</a></div>
      </div>
    </div>
  </section>`;
}

function CopyBtn({ text, label, ctx, primary = false }) {
  const copy = async () => {
    try { await navigator.clipboard.writeText(text); ctx.say('Copied'); } catch { ctx.say('Your browser didn’t allow copying. Select the words and copy them.', 'warn'); }
  };
  return html`<button type="button" class=${`bp-btn bp-btn--sm ${primary ? 'bp-btn--primary' : ''}`} onClick=${copy}><${Icon} name="copy" size=${16} />${label}</button>`;
}

function CopyBlock({ d, ctx }) {
  return html`<article class="ad-copy">
    <h3>${d.title}</h3>
    <${Report} text=${d.body} level=${4} />
    <${Files} files=${d.files} />
    ${d.body ? html`<div class="bp-btns"><${CopyBtn} text=${mdPlain(d.body)} label="Copy the words" ctx=${ctx} /></div>` : null}
  </article>`;
}

function Files({ files = [] }) {
  if (!files.length) return null;
  const views = viewerFiles(files);
  return html`<ul class="ad-files">${files.map((f, i) => html`<li key=${f.id}><a ...${viewerLink(views, i)}><${Icon} name="documents" size=${18} /><span>${f.name}</span><span class="bp-muted">${sizeText(f.size)}</span></a></li>`)}</ul>`;
}

const blankHost = { title: '', when: '', where: '', expected: '', notes: '' };
const HOST_WORDS = { new: 'Waiting for an answer', approved: 'Approved', 'not-now': 'Not now', done: 'Held' };
function HostCard({ ctx, guide }) {
  const { data, post } = ctx;
  const [f, setF, clear] = useDraft('host', blankHost);
  const [open, setOpen] = useState(Object.values(f).some(Boolean));
  const [busy, setBusy] = useState(false);
  const up = (k) => (e) => setF({ ...f, [k]: e.currentTarget.value });
  const send = async (e) => {
    e.preventDefault();
    setBusy(true);
    const j = await post({ action: 'host', ...f }, 'Got it. You’ll hear back soon.');
    setBusy(false);
    if (j) { clear(); setOpen(false); }
  };
  return html`<section class="bp-card bp-rise" style=${rise(2)} aria-labelledby="host-h">
    <${SecHead} title="Host a fundraiser" id="host-h" />
    ${guide?.body ? html`<${Report} text=${guide.body} level=${3} />` : html`<p class="bp-muted">A dinner, a game night, a company drive. Send your idea and SOARD will review it. Every hosted fundraiser is approved first.</p>`}
    <${Files} files=${guide?.files} />
    ${data.hosted.length ? html`<ul class="ad-intros">${data.hosted.map((x) => html`<li key=${x.id}><div><strong>${x.title}</strong>${x.when ? html`<span class="bp-muted">${x.when}</span>` : null}${x.note ? html`<span class="bp-muted">${x.note}</span>` : null}</div><div class="ad-intros__s"><span class=${`bp-chip ${x.status === 'approved' ? 'bp-chip--ok' : ''}`}>${HOST_WORDS[x.status] || x.status}</span></div></li>`)}</ul>` : null}
    ${!data.me.answers ? null : open ? html`<form class="ad-fields ad-fields--top" onSubmit=${send}>
      <label class="ad-field"><span>What’s the idea?</span><input class="ad-input" id="h-title" required maxlength="140" value=${f.title} onInput=${up('title')} /></label>
      <div class="ad-two">
        <label class="ad-field"><span>When</span><input class="ad-input" id="h-when" maxlength="120" value=${f.when} onInput=${up('when')} /></label>
        <label class="ad-field"><span>Where</span><input class="ad-input" id="h-where" maxlength="200" value=${f.where} onInput=${up('where')} /></label>
      </div>
      <label class="ad-field"><span>What are you hoping to raise?</span><input class="ad-input" id="h-exp" maxlength="120" value=${f.expected} onInput=${up('expected')} /></label>
      <label class="ad-field"><span>Anything else we should know</span><textarea class="ad-input" id="h-notes" rows="3" maxlength="1500" value=${f.notes} onInput=${up('notes')}></textarea></label>
      <div class="bp-btns"><button type="submit" class="bp-btn bp-btn--primary" disabled=${busy || !f.title.trim()}>${busy ? 'Sending…' : 'Send my idea'}</button><button type="button" class="bp-btn bp-btn--quiet" onClick=${() => setOpen(false)}>Not now</button></div>
    </form>` : html`<div class="bp-btns"><button type="button" class="bp-btn" onClick=${() => setOpen(true)}>Send an idea</button></div>`}
  </section>`;
}

function BrandCard({ org }) {
  return html`<section class="bp-card bp-rise" style=${rise(3)} aria-labelledby="brand-h">
    <${SecHead} title="SOARD at a glance" id="brand-h" />
    ${org?.mission ? html`<p>${org.mission}</p>` : null}
    <dl class="ad-dates ad-dates--top">
      ${org?.legalName || org?.name ? html`<dt>Name</dt><dd>${org.legalName || org.name}</dd>` : null}
      ${org?.ein ? html`<dt>EIN</dt><dd>${org.ein}</dd>` : null}
      ${org?.website ? html`<dt>Website</dt><dd>${org.website}</dd>` : null}
    </dl>
    <div class="bp-btns"><a class="bp-btn bp-btn--sm" href="/branding/" target="_blank" rel="noopener">Official logos and photos</a></div>
  </section>`;
}

// ─── People ─────────────────────────────────────────────────────────
function PeoplePage({ ctx }) {
  const { data } = ctx;
  const { people, lead, papers, filings, groupEmail, todos } = data;
  const toSign = new Set(todos.filter((t) => t.kind === 'sign').map((t) => t.id));
  return html`<div>
    <header class="bp-pagehead bp-rise" style=${rise(0)}>
      <div><h1 class="bp-h1">People</h1><p class="bp-lede">${people.length === 1 ? '1 advisor' : `${people.length} advisors`}${lead ? `, led by ${lead.name}` : ''}.</p></div>
      <div class="bp-btns ad-head"><a class="bp-btn bp-btn--primary" href=${`mailto:${groupEmail}`}><${Icon} name="mail" size=${18} />Email the group</a><${CopyBtn} text=${groupEmail} label="Copy the address" ctx=${ctx} /></div>
    </header>
    <ul class="ad-people bp-rise" style=${rise(1)}>${people.map((p) => html`<li class="bp-card" key=${p.slug}>
      <${Avatar} p=${p} size=${72} />
      <div class="ad-person">
        <h2>${p.name}</h2>
        ${p.organization ? html`<p class="bp-muted">${p.organization}</p>` : null}
        ${p.bio ? html`<p class="ad-bio">${p.bio}</p>` : null}
        ${p.linkedin ? html`<a class="bp-link" href=${p.linkedin} target="_blank" rel="noopener">LinkedIn</a>` : null}
      </div>
    </li>`)}</ul>
    ${!people.length ? html`<p class="bp-muted">The advisors will show here.</p>` : null}
    <div class="bp-split bp-split--even">
      <section class="bp-card bp-rise" style=${rise(2)} aria-labelledby="papers-h">
        <${SecHead} title="Papers" id="papers-h" />
        ${papers.length ? html`<ul class="ad-rows">${papers.map((d) => html`<li key=${d.id}><a class="ad-rows__row" href=${`#/papers/${d.id}`}>
          <${Icon} name="documents" size=${22} />
          <span class="ad-rows__t"><strong>${d.title}</strong>${d.kind === 'agreement' && data.me.answers ? html`<span class="bp-muted">${toSign.has(d.id) ? 'To sign' : d.signedByMe ? `Signed ${dateOfIso(d.signedByMe.at)}` : ''}</span>` : null}</span>
          <${Icon} name="arrow" size=${18} cls="bp-go" />
        </a></li>`)}</ul>` : html`<p class="bp-muted">The agreement and the overview will be here.</p>`}
      </section>
      <section class="bp-card bp-rise" style=${rise(3)} aria-labelledby="filings-h">
        <${SecHead} title="Public filings" id="filings-h" />
        ${filings.length ? html`<ul class="ad-rows">${filings.slice(0, 6).map((d, i) => { const v = filings.slice(0, 6).map((x) => ({ name: x.title, type: 'application/pdf', url: x.url })); return html`<li key=${d.url}><a class="ad-rows__row" ...${viewerLink(v, i)}>
          <${Icon} name="documents" size=${22} /><span class="ad-rows__t"><strong>${d.title}</strong>${d.year ? html`<span class="bp-muted">${d.year}</span>` : null}</span>
        </a></li>`; })}</ul>` : html`<p class="bp-muted">SOARD’s public filings are on the <a class="bp-link" href="/about/financials/" target="_blank" rel="noopener">financials page</a>.</p>`}
      </section>
    </div>
  </div>`;
}

function PaperPage({ id, ctx }) {
  const { data, post, setData } = ctx;
  const d = data.papers.find((x) => x.id === id);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [changed, setChanged] = useState(false);
  if (!d) return html`<div><a class="bp-back" href="#/people"><${Icon} name="back" size=${18} />People</a><div class="bp-card bp-empty"><h1 class="bp-h2">That paper isn’t here</h1><p class="bp-muted">It may have been taken down.</p></div></div>`;
  const signed = d.signedByMe;
  const due = data.todos.some((t) => t.kind === 'sign' && t.id === d.id);
  const sign = async (e) => {
    e.preventDefault();
    setBusy(true);
    // Which words they read: if the paper changed while it was open, the server says so and they read the new ones
    const j = await post({ action: 'sign', docId: d.id, name, version: d.version }, 'Signed. Thank you.', { refused: (r) => { if (r.changed) { setChanged(true); setName(''); scrollTo(0, 0); } } });
    setBusy(false);
    if (j) setChanged(false);
    if (j) setData((x) => ({ ...x, papers: x.papers.map((p) => (p.id === d.id ? { ...p, signedByMe: j.signed } : p)) }));
  };
  return html`<div class="ad-paper">
    <a class="bp-back" href="#/people"><${Icon} name="back" size=${18} />People</a>
    ${changed ? html`<p class="ad-changed" role="alert">These words changed while you had them open. Read them again, then sign.</p>` : null}
    <article class="bp-card">
      <h1 class="bp-h1">${d.title}</h1>
      ${d.body ? html`<${Report} text=${d.body} level=${2} />` : null}
      ${d.url ? html`<div class="bp-btns"><a class="bp-btn bp-btn--primary" href=${d.url} target="_blank" rel="noopener"><${Icon} name="external" size=${18} />Open the ${/\.pdf(\?|$)/i.test(d.url) ? 'PDF' : 'paper'}</a></div>` : null}
      <${Files} files=${d.files} />
    </article>
    ${d.kind !== 'agreement' ? null : !data.me.answers ? html`<p class="bp-muted ad-under">Each advisor signs this once a year.</p>`
    : signed && !due ? html`<p class="bp-chips ad-under"><span class="bp-chip bp-chip--ok"><${Icon} name="check" size=${14} />Signed ${dateOfIso(signed.at)}</span></p>`
      : html`<form class="bp-card ad-sign" onSubmit=${sign}>
        <h2 class="bp-h2">Sign with your name</h2>
        <label class="ad-field"><span>Type your full name: ${data.me.name}</span><input class="ad-input ad-sign__name" id="sign-name" required autocomplete="off" maxlength="120" value=${name} onInput=${(e) => setName(e.currentTarget.value)} /></label>
        <div class="bp-btns"><button type="submit" class="bp-btn bp-btn--primary" disabled=${busy || !name.trim()}>${busy ? 'Signing…' : 'Sign'}</button></div>
      </form>`}
  </div>`;
}

// ─── Run it ─────────────────────────────────────────────────────────
function RunPage({ ctx }) {
  const { route, say, setUnsaved } = ctx;
  const [Area, setArea] = useState(null);
  const [broke, setBroke] = useState(false);
  useEffect(() => { import('../advisory-admin.js').then((m) => setArea(() => m.AdvisoryArea)).catch(() => setBroke(true)); }, []);
  const tab = ['meetings', 'documents', 'members'].includes(route.id) ? route.id : 'members';
  return html`<div>
    <header class="bp-pagehead"><div><h1 class="bp-h1">Run it</h1><p class="bp-lede">What’s waiting, the monthly ask, the meetings, and the words on this page.</p></div></header>
    ${broke ? html`<div class="bp-card bp-empty"><p class="bp-muted">This didn’t open. Check your connection and reload the page.</p></div>`
    : Area ? html`<${Area} embedded=${true} tab=${tab} onTab=${(t) => { location.hash = `#/run/${t}`; }} say=${say} onDirty=${setUnsaved} />` : html`<p class="bp-muted">Opening…</p>`}
  </div>`;
}

render(html`<${App} />`, document.getElementById('advisory-app'));
