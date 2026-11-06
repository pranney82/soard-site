/**
 * What a board member looks at on the board page, for Board → Members
 * ====================================================================
 * The page in front of them (Home, a meeting, Financials…) and each file they
 * open in the viewer, with the time they were really there: the tab in front
 * and someone at it (a touch, a key, a scroll in the last three minutes).
 * Also when they open the meeting's video call or print. Sent about once a
 * minute, and when the page goes to the background or closes.
 *
 * It only watches: the hash routes (./portal.js) and the file viewer
 * (../file-viewer.js), so neither knows it's here. The server keeps it for a
 * board member only (../../../functions/api/_board-activity.js); an admin
 * looking, previewing or presenting is never recorded.
 */

// The advisors' page reports to its own route, and the server keeps it for an advisor only
const API = typeof location !== 'undefined' && location.pathname.startsWith('/admin/advisory') ? '/api/advisory-portal' : '/api/board-portal';
// Reading a long page can go a while without a touch
const IDLE_MS = 3 * 60_000;
const FLUSH_MS = 60_000;
// This long past a look's last counted second (the tab in the background, nobody at it, the computer asleep), it's a new
// look when they're back
const AWAY_MS = 5 * 60_000;
const FILE = /\/api\/(?:board|advisory)-file\?id=([A-Za-z0-9_]{3,40})/;
const ID = /^[A-Za-z0-9_]{3,40}$/;
const CALL = /^https:\/\/(meet\.google\.com|([\w-]+\.)*zoom\.us|teams\.microsoft\.com|teams\.live\.com|([\w-]+\.)*webex\.com)\//;

/** The page as the server names it: #/meetings/<id> → meeting/<id>; null for one it doesn't know */
export function pageOf(hash) {
  const [page = '', id = '', sub = '', item = ''] = String(hash || '').replace(/^#\/?/, '').replace(/\?.*$/, '').split('/').map((x) => { try { return decodeURIComponent(x); } catch { return x; } });
  if (page === '' || page === 'reveals') return 'home';
  if (page === 'meetings') {
    if (!id) return 'meetings';
    if (!ID.test(id)) return null;
    if (sub === 'screen') return `screen/${id}`;
    if (sub === 'review') return `review/${id}`;
    if (sub === 'report') return ID.test(item) ? `report/${id}/${item}` : `meeting/${id}`;
    return `meeting/${id}`;
  }
  if (page === 'financials') return sub === 'gifts' || id === 'gifts' ? 'gifts' : 'financials';
  // A paper written in Board, read on its own page
  if ((page === 'documents' || page === 'papers') && id) return ID.test(id) ? `paper/${id}` : null;
  return ['people', 'documents', 'introductions', 'fundraise'].includes(page) ? page : null;
}
const meetingOf = (page) => (/^(meeting|screen|report|review)\//.test(page || '') ? page.split('/')[1] : '');
const paperOf = (page) => (/^paper\//.test(page || '') ? page.split('/')[1] : '');

export function startTracking({ win = window, doc = document, send = null, now = () => Date.now() } = {}) {
  // An admin presenting or previewing (?present, ?preview) isn't anyone's activity
  if (/[?&](present|preview)\b/.test(win.location.search)) return null;
  let seg = null; // what's in front now: { id, kind, ref, sub, at, last (its last counted second), secs, sent, reported }
  // Each look has its own id: the server keeps one row per id, whatever the clocks say
  let n = 0;
  const lookId = () => `${now().toString(36)}${(n++).toString(36)}${Math.random().toString(36).slice(2, 6)}`.slice(0, 24);
  const look = (cur, t, reported = false) => ({ ...cur, id: lookId(), at: t, last: t, secs: 0, touched: 0, sent: 0, reported });
  let lastInput = now();
  let stopped = false;
  const queue = [];
  // A report that didn't get through (no connection, too many at once) goes again with the next one; a look's report
  // carries its total, so sending it twice changes nothing
  const again = (events) => { queue.unshift(...events); if (queue.length > 120) queue.splice(0, queue.length - 120); };
  const post = send || ((events) => fetch(API, {
    method: 'POST', keepalive: true, credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'activity', events, touch: (win.navigator?.maxTouchPoints || 0) > 1, now: now() }),
  }).then(async (r) => {
    if (r.status === 401 || r.status === 403) { stopped = true; return; }
    const j = await r.json().catch(() => null);
    // An admin looking: nothing of theirs is kept, so the page stops sending
    if (j?.stop) stopped = true;
    else if (!r.ok || j?.later) again(events);
  }).catch(() => again(events)));

  const current = () => {
    const page = pageOf(win.location.hash);
    const href = doc.querySelector('.fv[role="dialog"] .fv-newtab')?.getAttribute('href') || '';
    const f = href.match(FILE);
    if (f) return { kind: 'file', ref: f[1], sub: meetingOf(page) };
    return page ? { kind: 'view', ref: page, sub: '' } : null;
  };
  const same = (a, b) => !!a && !!b && a.kind === b.kind && a.ref === b.ref && a.sub === b.sub;
  // The look in front, reported: when it began and its time so far (the server keeps the most it's told, so a report
  // sent twice or out of order changes nothing)
  const chunk = (final) => {
    if (!seg) return;
    // A file counts as opened at once; a page only once they've been on it a second
    if (seg.secs > seg.sent || (seg.kind === 'file' && !seg.reported)) queue.push({ id: seg.id, kind: seg.kind, ref: seg.ref, sub: seg.sub, at: seg.at, end: seg.last, secs: seg.secs, touched: seg.touched });
    seg.reported = seg.reported || seg.secs > 0 || seg.kind === 'file';
    seg.sent = seg.secs;
    if (final) seg = null;
  };
  const flush = () => {
    if (stopped) return;
    chunk(false);
    if (!queue.length) return;
    post(queue.splice(0, 60));
  };
  const tick = () => {
    if (stopped) return;
    const t = now();
    const cur = current();
    if (!same(cur, seg)) {
      chunk(true);
      if (cur) {
        seg = look(cur, t);
        if (cur.kind === 'file') { chunk(false); flush(); }
      }
      // Its first second is the next one
      return;
    }
    // A meeting's screen is watched, not touched: in front is enough there (the server counts its untouched time only in
    // the meeting's own hours). Anything else: the window they're at (a board page beside another app, the mouse only
    // passing over it, isn't being read). A file the viewer can't show is opened, never read
    const focused = typeof doc.hasFocus === 'function' ? doc.hasFocus() : true;
    // (a video playing in the viewer is being watched, hands off)
    const playing = [...(doc.querySelectorAll?.('.fv video') || [])].some((v) => !v.paused && !v.ended);
    const touching = (t - lastInput < IDLE_MS || playing) && focused;
    const here = doc.visibilityState === 'visible' && (touching || /^screen\//.test(seg?.ref || ''));
    if (!seg || !here) return;
    if (seg.kind === 'file' && doc.querySelector('.fv[role="dialog"] .fv-card')) return;
    // Back after a while away (the tab in the background, nobody at it, the computer asleep): a new look, from now
    if (t - seg.last >= AWAY_MS) {
      const was = { kind: seg.kind, ref: seg.ref, sub: seg.sub };
      chunk(true);
      seg = look(was, t, was.kind === 'file');
      return;
    }
    seg.secs += 1;
    if (touching) seg.touched += 1;
    seg.last = t;
  };
  const touched = () => { lastInput = now(); };
  const clicked = (e) => {
    const t = now();
    const page = pageOf(win.location.hash);
    const a = e.target?.closest?.('a[href]');
    // The board page passes on a quick tap made during a page change itself, so a video link's click counts however it
    // came. A file opened in a tab of its own is the server's to see (../../../functions/api/board-file.js), and a
    // print is counted when it prints (beforeprint)
    if (a && CALL.test(a.href)) { queue.push({ id: lookId(), kind: 'video', ref: meetingOf(page), at: t, secs: 0 }); flush(); return; }
    if (e.isTrusted === false) return;
    const b = e.target?.closest?.('button');
    // Downloaded from the viewer: the file it shows
    if (b && b.closest('.fv') && /^Download/.test(b.getAttribute('aria-label') || b.textContent.trim()) && seg?.kind === 'file') { queue.push({ id: seg.id, kind: 'file', ref: seg.ref, sub: seg.sub, at: seg.at, end: seg.last, secs: seg.secs }); flush(); }
  };
  const away = () => flush();
  // A print, when it prints (its button or ⌘P), told by what the page has put up for it: Print it all (every document
  // of the meeting), the viewer's one file, a paper written in Board, else the page itself
  const beforePrint = () => {
    const page = pageOf(win.location.hash);
    const meeting = meetingOf(page);
    const html = doc.documentElement?.classList;
    const all = html?.contains('bp-printing-all');
    const form = html?.contains('mt-printing');
    const file = doc.body?.classList?.contains('fv-printing') && seg?.kind === 'file' ? seg.ref : '';
    const paper = paperOf(page);
    const id = lookId();
    queue.push(all && meeting ? { id, kind: 'print', ref: meeting, sub: 'all', at: now(), secs: 0 }
      : form && meeting ? { id, kind: 'print', ref: meeting, sub: 'form', at: now(), secs: 0 }
        : file ? { id, kind: 'print', ref: file, sub: meeting, at: now(), secs: 0 }
          : paper ? { id, kind: 'print', ref: paper, sub: 'paper', at: now(), secs: 0 }
            : { id, kind: 'print', ref: meeting, sub: 'page', at: now(), secs: 0 });
    flush();
  };
  // Brought back by Back or Forward (the browser kept the page): a new look, from now
  const shown = (e) => { if (e.persisted) { chunk(true); flush(); tick(); } };
  const onHidden = () => { if (doc.visibilityState === 'hidden') away(); };

  for (const k of ['pointerdown', 'keydown', 'wheel', 'touchstart']) win.addEventListener(k, touched, { capture: true, passive: true });
  win.addEventListener('scroll', touched, { capture: true, passive: true });
  let moved = 0;
  const mouse = () => { const t = now(); if (t - moved > 5000) { moved = t; touched(); } };
  win.addEventListener('mousemove', mouse, { passive: true });
  doc.addEventListener('click', clicked, true);
  doc.addEventListener('visibilitychange', onHidden);
  win.addEventListener('pagehide', away);
  win.addEventListener('pageshow', shown);
  win.addEventListener('beforeprint', beforePrint);
  const ticking = win.setInterval(tick, 1000);
  const flushing = win.setInterval(() => { chunk(false); flush(); }, FLUSH_MS);
  tick();
  return {
    tick, flush: away,
    stop() {
      win.clearInterval(ticking); win.clearInterval(flushing);
      for (const k of ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll']) win.removeEventListener(k, touched, { capture: true });
      win.removeEventListener('mousemove', mouse);
      doc.removeEventListener('click', clicked, true);
      doc.removeEventListener('visibilitychange', onHidden);
      win.removeEventListener('pagehide', away);
      win.removeEventListener('pageshow', shown);
      win.removeEventListener('beforeprint', beforePrint);
    },
  };
}

if (typeof window !== 'undefined' && typeof document !== 'undefined' && !window.__boardActivity) window.__boardActivity = startTracking();
