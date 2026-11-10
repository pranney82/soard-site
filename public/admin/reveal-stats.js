/**
 * Reveal stats (admin): Broadcast → History
 * =========================================
 * Every reveal side by side, so the ones that did better stand out:
 *
 *  Table    one row per reveal: most watching at once (site, Facebook and
 *           YouTube together), people on the live page, watched live,
 *           average watch, there for the reveal, replay, Facebook and
 *           YouTube's own counts (when there are any), hearts and messages.
 *           Click a heading to sort; the bottom row is the average of the
 *           finished reveals, and a column's best is in bold when one reveal
 *           has it alone. The next reveal and one live right now are listed
 *           with what they have so far, out of the averages. Rehearsals,
 *           cancelled, Facebook-only and kid-less streams sit in a fold.
 *  A reveal its tiles, the "watching at once" line through the reveal with
 *           the reveal moment marked, where people came from, Facebook's and
 *           YouTube's totals, who was left out, then the parent's own extras
 *           (replay links, messages, keepsake, feed health).
 *
 * Numbers come from /api/broadcast-admin (history[].stats, built by
 * functions/api/_reveal-stats.js). Staff and tests are never in them.
 *
 * Props: rows, since (when counting began), error (the numbers couldn't be
 *        read), currentId (the broadcast on the site now), youtubeKey (the
 *        site has a YouTube API key), youtubeOn (reveals are sent to YouTube),
 *        replayHours (how long the replay stays on the live page), when(row)
 *        → date line, fmtDate(iso), renderExtra(row) → the parent's content
 */

import { h, htm, useState, useEffect, useRef, useMemo } from './vendor.js';

const html = htm.bind(h);

// Series colors (validated: dataviz categorical slots 1–3, all pairs; labels and the table carry identity too)
const COLORS = { site: '#2a78d6', facebook: '#eb6834', youtube: '#1baf7a' };
const SERIES = [
  { i: 1, key: 'site', name: 'Site' },
  { i: 2, key: 'facebook', name: 'Facebook' },
  { i: 3, key: 'youtube', name: 'YouTube' },
];

export const SOURCE_LABELS = {
  email: 'Email', facebook: 'Facebook', instagram: 'Instagram', youtube: 'YouTube', qr: 'QR code',
  text: 'Text message', push: 'Phone notification', calendar: 'Calendar', search: 'Search engine',
  site: 'Elsewhere on our site', other: 'Other websites', direct: 'Direct or a shared link',
};

const CLICKS = [
  ['click_donate', 'Donate'], ['reminder_signup', 'Reminder sign-ups'], ['click_calendar', 'Calendar adds'],
  ['share', 'Shares'], ['qr_scan', 'QR scans'], ['click_facebook', 'Facebook link'],
];

// ─── Formatting ─────────────────────────────────────────────────────

const DASH = '—';
const num = (v) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
export const fmtN = (n) => (num(n) == null ? DASH : num(n).toLocaleString('en-US'));
/** 0:42, 4:05, 1:02:10 */
export function fmtDur(sec) {
  if (num(sec) == null) return DASH;
  const s = Math.max(0, Math.round(num(sec)));
  const hh = Math.floor(s / 3600), mm = Math.floor((s % 3600) / 60), ss = s % 60;
  return hh ? `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${mm}:${String(ss).padStart(2, '0')}`;
}
/** A share that never rounds to a claim it isn't: 199 of 200 is 99%, 1 of 1,000 is under 1% */
export function fmtPct(x) {
  if (num(x) == null) return DASH;
  const v = Math.min(1, Math.max(0, num(x)));
  const r = Math.round(v * 100);
  if (r === 100 && v < 1) return '99%';
  if (r === 0 && v > 0) return '<1%';
  return `${r}%`;
}
const plural = (n, one, many = `${one}s`) => `${fmtN(n)} ${n === 1 ? one : many}`;
const ago = (iso) => {
  const ms = Date.now() - Date.parse(iso || '');
  if (!Number.isFinite(ms)) return '';
  const m = Math.round(ms / 60000);
  if (m < 2) return 'just now';
  if (m < 60) return `${m} minutes ago`;
  const hrs = Math.round(m / 60);
  return hrs < 36 ? `${hrs} hour${hrs === 1 ? '' : 's'} ago` : `${Math.round(hrs / 24)} days ago`;
};
/** An outside service's error, as words: no HTML (YouTube's), trace ids or links (Facebook's), one short sentence or two */
const words = (e) => {
  const t = String(e || '').replace(/<[^>]*>/g, '').replace(/\bfbtrace_id=\S+/g, '').replace(/https?:\/\/\S+/g, '').replace(/\s+/g, ' ').trim();
  return t.length > 160 ? `${t.slice(0, 157).replace(/\s+\S*$/, '')}…` : t;
};

// ─── Which reveals compare ──────────────────────────────────────────

const isUpcoming = (r) => ['scheduled', 'armed'].includes(r.phase);
const isLiveNow = (r) => ['live', 'ending'].includes(r.phase);
/** Rows as History should read them: only the broadcast the site is on can still be live or coming up */
export function settle(rows, currentId) {
  return rows.map((r) => {
    if (r.id === currentId || !(isLiveNow(r) || isUpcoming(r))) return r;
    return { ...r, phase: r.live_at ? 'ended' : 'cancelled', ended_at: r.ended_at || (r.live_at && r.source !== 'manual' ? r.updated_at || r.live_at : null) };
  });
}
/** A rehearsal (a JobTread TEST job): never compared, whether or not its numbers loaded */
export const isTest = (r) => !!(r.stats?.test || r.data?.test || /^\s*TEST\b/i.test(r.title || ''));
/** Went live and is over */
const ended = (r) => !!r.live_at && !isLiveNow(r) && !isUpcoming(r);
/** Never went live and never will (cancelled, missed) */
const neverLive = (r) => !r.live_at && !isUpcoming(r);
const real = (r) => !!r.kid_slug && !isTest(r) && r.source !== 'manual';
/** A real reveal that's over: it's compared and in the averages */
export const compared = (r) => ended(r) && real(r);
/** In the table: compared, plus the next reveal and one live now (what they have so far, out of the averages) */
export const inTable = (r) => compared(r) || ((isUpcoming(r) || (isLiveNow(r) && !!r.live_at)) && real(r));

// ─── Columns ────────────────────────────────────────────────────────

const counted = (s) => !!s?.counted;
/** Numbers that need the reveal to have gone live (a dash before then) */
const wentLive = (s, r) => counted(s) && !!r?.live_at;
export const COLUMNS = [
  { key: 'atOnce', label: 'Most at once', means: 'The most people watching at the same moment: the site, Facebook and YouTube together.',
    get: (s, r) => (wentLive(s, r) ? num(s.atOnce?.peakAll) : null), fmt: fmtN },
  { key: 'people', label: 'People', means: 'Different people who opened the live page for this reveal: before it, during it or after.',
    get: (s) => (counted(s) ? num(s.people) : null), fmt: fmtN },
  { key: 'live', label: 'Watched live', means: 'People who watched the reveal live on the site.',
    get: (s, r) => (wentLive(s, r) ? num(s.live) : null), fmt: fmtN },
  { key: 'avgWatch', label: 'Avg. watch', means: 'How long each person who watched live stayed, on average (minutes:seconds; hours:minutes:seconds past an hour).',
    get: (s, r) => (wentLive(s, r) ? num(s.avgLiveSec) : null), fmt: fmtDur },
  { key: 'there', label: 'There for the reveal', means: 'Of the people who watched live on the site, the share watching in the minute the child first saw the room.',
    get: (s, r) => (wentLive(s, r) && num(s.atReveal) != null && num(s.live) ? Math.min(1, num(s.atReveal) / num(s.live)) : null), fmt: fmtPct },
  { key: 'replay', label: 'Replay', means: 'People who played the replay on the live page (it stays there for a few days after, as Settings says).',
    get: (s, r) => (counted(s) && ended(r) && r.replay_uid ? num(s.replay) : null), fmt: fmtN },
  { key: 'facebook', label: 'Facebook', optional: true, means: 'People who watched for 3 seconds or more on Facebook, live or later (Facebook\'s own count).',
    get: (s) => num(s?.facebook?.unique), fmt: fmtN },
  { key: 'youtube', label: 'YouTube', optional: true, means: 'Views on YouTube, live or later (YouTube\'s own count).',
    get: (s) => num(s?.youtube?.views), fmt: fmtN },
  { key: 'hearts', label: 'Hearts', means: 'Hearts tapped on the live page during the reveal (a dash when none were recorded).',
    get: (s, r) => (wentLive(s, r) ? num(s.heartsTotal) : null), fmt: fmtN },
  { key: 'messages', label: 'Messages', means: 'Messages for the family shown on the live page.',
    get: (s, r) => (r.live_at ? num(r.messageCount) ?? 0 : null), fmt: fmtN },
];

const revealTime = (r) => Date.parse(r.live_at || r.scheduled_at || r.created_at || '') || 0;
const valueOf = (col, r) => col.get(r.stats || {}, r);

/** Sort rows by a column: highest first (or lowest), a missing number always last; ties by date, newest first */
export function sortRows(rows, key, dir) {
  const col = COLUMNS.find((c) => c.key === key);
  const sign = dir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    if (!col) return sign * (revealTime(a) - revealTime(b));
    const va = valueOf(col, a), vb = valueOf(col, b);
    if (va == null && vb == null) return revealTime(b) - revealTime(a);
    if (va == null) return 1;
    if (vb == null) return -1;
    return va === vb ? revealTime(b) - revealTime(a) : sign * (va - vb);
  });
}

/**
 * The average reveal: each column's mean over the finished reveals that have
 * it → { key: { avg, n, best } }. It takes two to say what's typical; "best"
 * is a value one reveal has alone, and never a zero.
 */
export function columnSummary(rows, cols = COLUMNS) {
  const out = {};
  for (const c of cols) {
    const vals = rows.filter(compared).map((r) => valueOf(c, r)).filter((v) => v != null && Number.isFinite(v));
    const max = vals.length ? Math.max(...vals) : null;
    // Alone as a reader sees it: 87.4% and 87.1% both read 87%, so neither is bold
    const shows = (v) => (c.fmt ? c.fmt(v) : String(v));
    const alone = max != null && vals.filter((v) => shows(v) === shows(max)).length === 1;
    out[c.key] = { n: vals.length, avg: vals.length >= 2 ? vals.reduce((a, b) => a + b, 0) / vals.length : null, best: vals.length >= 2 && alone && max > 0 ? max : null };
  }
  return out;
}

// ─── The chart: watching at once through the reveal ─────────────────

/** A y-axis in whole, round steps (1, 2 or 5 × 10ⁿ), three to five lines, the top at or above the peak */
export function yScale(top) {
  const want = Math.max(1, top) / 4;
  const pow = 10 ** Math.floor(Math.log10(want));
  const step = Math.max(1, [1, 2, 5, 10].map((m) => m * pow).find((s) => s >= want) || 10 * pow);
  const max = Math.max(step * 2, Math.ceil(Math.max(1, top) / step) * step);
  const ticks = [];
  for (let v = 0; v <= max + 1e-9; v += step) ticks.push(v);
  return { max, ticks };
}

function xStep(totalMin, room) {
  const fit = Math.max(2, Math.floor(room / 64));
  for (const s of [1, 2, 5, 10, 15, 20, 30, 60, 120, 240, 360, 720, 1440]) if (totalMin / s <= fit) return s;
  return Math.ceil(totalMin / fit / 1440) * 1440;
}
/** An x-axis label: minutes, or hours once the steps are whole hours */
const xLabel = (m, step) => (m === 0 ? '0 min' : step >= 60 && m % 60 === 0 ? `${m / 60}h` : `${m}`);

const clockOf = (sec) => fmtDur(sec);

/** Split one series into drawable runs, skipping the gaps (a sample with no number) */
function runs(pts, i, x, y) {
  const out = [];
  let cur = [];
  for (const p of pts) {
    if (Number.isFinite(p[i])) cur.push([x(p[0]), y(p[i])]);
    else if (cur.length) { out.push(cur); cur = []; }
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Each place's last reading carried forward up to 2 minutes over missed readings (the server's rule too) */
export function fillGaps(pts, carrySec = 120) {
  const last = {};
  return pts.map((p) => {
    const q = [p[0], p[1], p[2], p[3]];
    for (const i of [1, 2, 3]) {
      if (Number.isFinite(p[i])) last[i] = { v: p[i], t: p[0] };
      else if (last[i] && p[0] - last[i].t <= carrySec) q[i] = last[i].v;
    }
    return q;
  });
}

/** The series as drawn: in time order, no negative counts, numbers only */
function cleanSeries(series) {
  const n = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Math.max(0, Number(v)));
  return (Array.isArray(series) ? series : [])
    .filter((p) => Array.isArray(p) && Number.isFinite(Number(p[0])) && Number(p[0]) >= 0)
    .map((p) => [Number(p[0]), n(p[1]), n(p[2]), n(p[3])])
    .sort((a, b) => a[0] - b[0]);
}

export function AtOnceChart({ series, revealAt = null }) {
  const wrap = useRef(null);
  const tipRef = useRef(null);
  const [w, setW] = useState(0);
  const [tipW, setTipW] = useState(160);
  const [hoverT, setHoverT] = useState(null); // seconds after going live (a refresh that adds points doesn't move it)
  useEffect(() => {
    const el = wrap.current;
    if (!el) return undefined;
    setW(el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // The tooltip's real width, so it can be kept inside the chart
  useEffect(() => { const t = tipRef.current; if (t && Math.abs(t.offsetWidth - tipW) > 1) setTipW(t.offsetWidth); });
  const pts = useMemo(() => cleanSeries(series), [series]);
  const shown = SERIES.filter((s) => pts.some((p) => Number.isFinite(p[s.i])));
  const total = (p) => shown.reduce((a, s) => a + (Number.isFinite(p[s.i]) ? p[s.i] : 0), 0);
  // Together: a missed reading stands in for up to 2 minutes (as the server's "most at once" does); past that, not known
  const filled = useMemo(() => new Map(fillGaps(pts).map((q) => [q[0], q])), [pts]);
  const together = (p) => { const q = filled.get(p[0]) || p; return shown.every((s) => Number.isFinite(q[s.i])) ? total(q) : null; };
  const top = Math.max(0, ...pts.flatMap((p) => shown.map((s) => (Number.isFinite(p[s.i]) ? p[s.i] : 0))));
  const { max: maxY, ticks: yTicks } = yScale(top);
  const H = 200, padT = 22, padB = 26;
  const padL = 12 + 7 * Math.max(...yTicks.map((v) => fmtN(v).length));
  const padR = shown.length > 1 ? 74 : 16;
  const maxT = Math.max(60, pts.length ? pts[pts.length - 1][0] : 0, revealAt != null ? revealAt + 30 : 0);
  const plotW = Math.max(10, w - padL - padR);
  const narrow = w > 0 && w < 480;
  const x = (t) => padL + (t / maxT) * plotW;
  const y = (v) => padT + (1 - v / maxY) * (H - padT - padB);
  const step = xStep(maxT / 60, plotW);
  const xTicks = [];
  for (let m = 0; m * 60 <= maxT; m += step) xTicks.push(m);

  // Labels at the end of each line that reaches the end; kept 13px apart inside the plot (a thin leader shows any that moved)
  const lastT = pts.length ? pts[pts.length - 1][0] : 0;
  const ends = shown.map((s) => {
    const last = [...pts].reverse().find((p) => Number.isFinite(p[s.i]));
    return last && last[0] >= lastT - 90 ? { ...s, x: x(last[0]), y: y(last[s.i]), ly: y(last[s.i]) } : null;
  }).filter(Boolean).sort((a, b) => a.y - b.y);
  const lo = padT + 4, hi = H - padB - 4;
  for (let k = 1; k < ends.length; k++) if (ends[k].ly - ends[k - 1].ly < 13) ends[k].ly = ends[k - 1].ly + 13;
  const over = ends.length ? ends[ends.length - 1].ly - hi : 0;
  if (over > 0) for (const e of ends) e.ly -= over;
  for (const e of ends) e.ly = Math.max(lo, e.ly);

  const nearest = (t) => { let best = 0; for (let k = 1; k < pts.length; k++) if (Math.abs(pts[k][0] - t) < Math.abs(pts[best][0] - t)) best = k; return best; };
  const hover = hoverT == null || !pts.length ? null : nearest(hoverT);
  const setHover = (k) => setHoverT(k == null ? null : pts[k][0]);
  const pick = (clientX) => {
    const box = wrap.current?.getBoundingClientRect();
    if (!box || !pts.length) return;
    setHover(nearest(((clientX - box.left - padL) / plotW) * maxT));
  };
  const onKey = (e) => {
    if (!pts.length) return;
    if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
      e.preventDefault();
      const d = e.key === 'ArrowRight' ? 1 : -1;
      setHover(Math.max(0, Math.min(pts.length - 1, (hover == null ? (d > 0 ? -1 : pts.length) : hover) + d)));
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      setHover(e.key === 'Home' ? 0 : pts.length - 1);
    } else if (e.key === 'Escape') setHover(null);
  };
  const hp = hover != null ? pts[hover] : null;
  // Beside the crosshair, on whichever side has room, and never past the chart's edges
  const tipLeft = hp ? (() => {
    const cx = x(hp[0]);
    const right = cx + 10, left = cx - 10 - tipW;
    const pos = right + tipW <= w ? right : left >= 0 ? left : w - tipW;
    return Math.max(0, Math.min(pos, w - tipW));
  })() : 0;
  const peak = pts.length ? pts.reduce((a, b) => ((together(b) ?? -1) > (together(a) ?? -1) ? b : a)) : null;
  const label = `Watching at once, by minutes after going live. ${shown.map((s) => `${s.name} peaked at ${fmtN(Math.max(...pts.map((p) => (Number.isFinite(p[s.i]) ? p[s.i] : 0))))}`).join('. ')}.${revealAt != null ? ` The room was revealed ${clockOf(revealAt)} after going live.` : ''} Use the left and right arrow keys to read each moment.`;

  return html`<div class="rs-chart">
    ${narrow ? html`<p class="rs-readout" role="status">${hp
      ? html`<strong>${clockOf(hp[0])}</strong> after going live: ${shown.map((s, k) => html`${k ? ' · ' : ''}${s.name} <strong>${Number.isFinite(hp[s.i]) ? fmtN(hp[s.i]) : DASH}</strong>`)}${shown.length > 1 ? html` · Together <strong>${fmtN(together(hp))}</strong>` : null}`
      : 'Tap or drag along the line to read each moment.'}</p>` : null}
    ${shown.length > 1 ? html`<div class="rs-legend" aria-hidden="true">${shown.map((s) => html`<span><svg width="16" height="8"><line x1="0" y1="4" x2="16" y2="4" stroke=${COLORS[s.key]} stroke-width="2" stroke-linecap="round" /></svg>${s.name}</span>`)}</div>` : null}
    <div class="rs-plot" ref=${wrap}
      onPointerMove=${(e) => pick(e.clientX)}
      onPointerDown=${(e) => pick(e.clientX)}
      onPointerLeave=${(e) => { if (e.pointerType === 'mouse') setHover(null); }}>
      ${w > 0 ? html`<svg width="100%" height=${H} viewBox=${`0 0 ${w} ${H}`} preserveAspectRatio="none" role="img" aria-label=${label} tabindex="0" onKeyDown=${onKey} onBlur=${() => setHover(null)} class="rs-svg">
        ${yTicks.map((v) => html`<g><line x1=${padL} x2=${padL + plotW} y1=${y(v)} y2=${y(v)} class="rs-grid" /><text x=${padL - 6} y=${y(v) + 4} text-anchor="end" class="rs-axis">${fmtN(v)}</text></g>`)}
        ${xTicks.map((m) => html`<text x=${x(m * 60)} y=${H - 8} text-anchor=${m === 0 ? 'start' : 'middle'} class="rs-axis">${xLabel(m, step)}</text>`)}
        ${revealAt != null && revealAt <= maxT ? html`<g class="rs-reveal"><line x1=${x(revealAt)} x2=${x(revealAt)} y1=${padT - 6} y2=${H - padB} /><text x=${Math.min(Math.max(x(revealAt), padL + 20), padL + plotW - 20)} y=${padT - 10} text-anchor="middle">Reveal</text></g>` : null}
        ${shown.map((s) => runs(pts, s.i, x, y).map((r) => r.length === 1
          ? html`<circle cx=${r[0][0]} cy=${r[0][1]} r="2.5" fill=${COLORS[s.key]} />`
          : html`<polyline points=${r.map(([a, b]) => `${a.toFixed(1)},${b.toFixed(1)}`).join(' ')} fill="none" stroke=${COLORS[s.key]} stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />`))}
        ${shown.length > 1 ? ends.map((e) => html`<g class="rs-end">${Math.abs(e.ly - e.y) > 2 ? html`<line x1=${e.x + 3} y1=${e.y} x2=${e.x + 10} y2=${e.ly} />` : null}<text x=${e.x + 12} y=${e.ly + 4}>${e.name}</text></g>`) : null}
        ${hp ? html`<g class="rs-cross"><line x1=${x(hp[0])} x2=${x(hp[0])} y1=${padT} y2=${H - padB} />${shown.map((s) => (Number.isFinite(hp[s.i]) ? html`<circle cx=${x(hp[0])} cy=${y(hp[s.i])} r="4" fill=${COLORS[s.key]} stroke="#fff" stroke-width="2" />` : null))}</g>` : null}
      </svg>` : null}
      ${hp && !narrow ? html`<div class="rs-tip" ref=${tipRef} style=${`left:${tipLeft}px`} role="status">
        <div class="rs-tip__when">${clockOf(hp[0])} after going live</div>
        ${shown.map((s) => html`<div class="rs-tip__row"><svg width="12" height="6" aria-hidden="true"><line x1="0" y1="3" x2="12" y2="3" stroke=${COLORS[s.key]} stroke-width="2" stroke-linecap="round" /></svg><strong>${Number.isFinite(hp[s.i]) ? fmtN(hp[s.i]) : DASH}</strong><span>${s.name}</span></div>`)}
        ${shown.length > 1 ? html`<div class="rs-tip__row rs-tip__total"><strong>${fmtN(together(hp))}</strong><span>Together</span></div>` : null}
      </div>` : null}
    </div>
    <details class="rs-numbers">
      <summary>See the numbers</summary>
      <div class="rs-numbers__wrap"><table>
        <thead><tr><th>After going live</th>${shown.map((s) => html`<th class="num">${s.name}</th>`)}${shown.length > 1 ? html`<th class="num">Together</th>` : null}</tr></thead>
        <tbody>${byMinute(pts).map((p) => html`<tr class=${p === peak ? 'is-peak' : ''}><td>${clockOf(p[0])}</td>${shown.map((s) => html`<td class="num">${Number.isFinite(p[s.i]) ? fmtN(p[s.i]) : DASH}</td>`)}${shown.length > 1 ? html`<td class="num">${fmtN(together(p))}</td>` : null}</tr>`)}</tbody>
      </table></div>
    </details>
  </div>`;
}

/** One row a minute (that minute's busiest moment), for the numbers table */
function byMinute(pts) {
  const out = new Map();
  const tot = (p) => (p[1] || 0) + (p[2] || 0) + (p[3] || 0);
  for (const p of pts) {
    const m = Math.floor(p[0] / 60);
    const have = out.get(m);
    if (!have || tot(p) > tot(have)) out.set(m, p);
  }
  return [...out.values()];
}

// ─── One reveal ─────────────────────────────────────────────────────

function Tile({ label, value, note }) {
  return html`<div class="stat"><span class="stat__label">${label}</span><span class="stat__value">${value}</span>${note ? html`<span class="stat__note">${note}</span>` : null}</div>`;
}

function Sources({ sources }) {
  const list = Object.entries(sources || {}).map(([k, n]) => [k, num(n) || 0]).filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  const sum = list.reduce((a, [, n]) => a + n, 0);
  if (!sum) return html`<p class="rs-muted">No one has opened the live page for this reveal yet.</p>`;
  const max = list[0][1];
  return html`<ul class="rs-bars">${list.map(([k, n]) => html`<li>
    <span class="rs-bars__name">${SOURCE_LABELS[k] || 'Other websites'}</span>
    <span class="rs-bars__track" aria-hidden="true"><span style=${`width:${Math.max(2, (n / max) * 100)}%`}></span></span>
    <span class="rs-bars__n">${fmtN(n)} <small>${fmtPct(n / sum)}</small></span>
  </li>`)}</ul>`;
}

function Platforms({ r, s, youtubeKey, youtubeOn }) {
  const f = s.facebook && typeof s.facebook === 'object' ? s.facebook : {};
  const yt = s.youtube && typeof s.youtube === 'object' ? s.youtube : {};
  const a = s.atOnce || {};
  const old = Date.now() - Date.parse(r.live_at || '') > 30 * 86400e3; // read for 30 days, then left as they were
  const fbNums = [
    ['People 3+ seconds', fmtN(f.unique)], ['Views', fmtN(f.views)], ['Avg. watch', fmtDur(f.avgSec)],
    ['Watched live', fmtN(f.liveUnique)], ['Most at once', fmtN(a.peakFb)], ['Reactions', fmtN(f.reactions)], ['Comments', fmtN(f.comments)],
  ].filter(([, v]) => v !== DASH);
  const ytNums = [['Views', fmtN(yt.views)], ['Most at once', fmtN(a.peakYt)], ['Likes', fmtN(yt.likes)], ['Comments', fmtN(yt.comments)]].filter(([, v]) => v !== DASH);
  // When the numbers shown were read: a read that failed later doesn't make them new
  const readAt = (x) => x.readAt || (!x.error ? x.checkedAt : null);
  const viewsAt = f.viewsReadAt || (!f.error && !f.missing ? readAt(f) : null);
  const hasViews = f.unique != null || f.views != null;
  const fbNote = f.missing
    ? `Facebook only shares its view totals once the site's Facebook connection has the "read insights" permission. Reactions and comments still come through.${hasViews && viewsAt ? ` The views shown are from ${ago(viewsAt)}.` : ''}`
    : f.error ? `Facebook didn't answer when last asked${ago(f.checkedAt) ? ` (${ago(f.checkedAt)})` : ''}: ${words(f.error)}${fbNums.length && readAt(f) ? ` The numbers shown are from ${ago(hasViews && viewsAt ? viewsAt : readAt(f))}.` : ''}`
    : fbNums.length ? null
    : isUpcoming(r) ? 'Facebook\'s numbers come in once the reveal is live.'
    : isLiveNow(r) ? 'Facebook\'s totals come in after the reveal.'
    : r.fb_permalink || f.videoId || f.liveVideoId ? (old ? 'Facebook didn\'t report numbers for this reveal.' : 'Facebook\'s totals come in after the reveal.')
    : r.source === 'manual' ? 'This reveal was live on Facebook, but the site doesn\'t know which video it was, so it can\'t read Facebook\'s numbers.'
    : 'This reveal wasn\'t on the Facebook Page.';
  const ytNote = yt.error ? `YouTube didn't answer when last asked${ago(yt.checkedAt) ? ` (${ago(yt.checkedAt)})` : ''}: ${words(yt.error)}`
    : ytNums.length ? null
    : yt.videoId ? (!youtubeKey ? 'YouTube isn\'t connected for numbers yet: it needs a YouTube API key.' : old ? 'YouTube didn\'t report numbers for this reveal.' : 'YouTube\'s numbers come in after the reveal.')
    : !youtubeOn ? 'Reveals aren\'t sent to YouTube (Settings → YouTube).'
    : !youtubeKey ? 'YouTube isn\'t connected for numbers yet: it needs a YouTube API key.'
    : isUpcoming(r) || isLiveNow(r) ? 'Counted once it\'s live on YouTube.'
    : 'YouTube wasn\'t showing this reveal.';
  const block = (name, nums, note, when) => html`<div class="rs-plat">
    <h5>${name}</h5>
    ${nums.length ? html`<dl>${nums.map(([k, v]) => html`<div><dt>${k}</dt><dd>${v}</dd></div>`)}</dl>` : null}
    ${note ? html`<p class="rs-muted">${note}</p>` : null}
    ${when && nums.length && !note ? html`<p class="rs-muted">Read ${ago(when)}.</p>` : null}
  </div>`;
  return html`<div class="rs-plats">${block('Facebook', fbNums, fbNote, readAt(f))}${block('YouTube', ytNums, ytNote, readAt(yt))}</div>`;
}

/** "Site 120 · Facebook 160 · YouTube 18, 20:30 after going live": where the most-at-once crowd was */
export function peakNote(a) {
  const split = a.peakSplit || [a.peakSite, a.peakFb, a.peakYt];
  const parts = [['Site', split[0]], ['Facebook', a.hasFb ? split[1] : null], ['YouTube', a.hasYt ? split[2] : null]]
    .filter(([name, n]) => name === 'Site' || n != null).map(([name, n]) => `${name} ${fmtN(n ?? 0)}`);
  return `${parts.join(' · ')}${a.peakAllAt != null ? `, ${clockOf(a.peakAllAt)} after going live` : ''}${a.peakPartial ? '. Not every place was read then, so it may have been more.' : ''}`;
}

/** "120 came before, 171 watched live, 64 the replay": the groups overlap, and it says so when they do */
function peopleNote(r, s) {
  const parts = [[num(s.before) || 0, 'came before'], r.live_at ? [num(s.live) || 0, 'watched live'] : null, ended(r) && r.replay_uid ? [num(s.replay) || 0, 'the replay'] : null].filter(Boolean);
  const sum = parts.reduce((t, [n]) => t + n, 0);
  return parts.map(([n, w]) => `${fmtN(n)} ${w}`).join(', ') + (sum > (num(s.people) || 0) ? ' (some did more than one)' : '');
}

export function RevealDetail({ r, since, error, currentId, youtubeKey, youtubeOn, fmtDate, renderExtra }) {
  const s = r.stats || null;
  const a = s?.atOnce;
  const events = r.events || {};
  const clicks = CLICKS.filter(([k]) => events[k] > 0).map(([k, label]) => `${label} ${fmtN(events[k])}`);
  const leftOut = s ? [s.staff ? plural(s.staff, 'staff visit') : null, s.tests ? plural(s.tests, 'test visit') : null].filter(Boolean) : [];
  const live = !!r.live_at;
  const there = s && live && num(s.atReveal) != null && num(s.live) ? Math.min(1, num(s.atReveal) / num(s.live)) : null;
  const thereNote = there != null ? `${fmtN(s.atReveal)} of ${fmtN(s.live)} watching live`
    : !live ? 'Counted once the reveal is live.'
    : isLiveNow(r) || (!r.replay_uid && r.source !== 'manual' && Date.now() - Date.parse(r.ended_at || r.live_at || '') < 6 * 3600e3) ? 'Known once the replay is ready.'
    : r.source === 'manual' ? 'This reveal was on Facebook only; the site didn\'t show it.'
    : !num(s?.live) ? 'Nobody watched live on the site.'
    : !r.replay_uid ? 'There\'s no recording to find the reveal moment in.'
    : s?.revealAt == null ? (r.id === currentId && r.phase === 'replay' ? 'The reveal moment isn\'t known yet. Set it under Now → replay.' : 'The reveal moment wasn\'t found in the recording.')
    : null;
  const platforms = s && !neverLive(r) && (s.counted || s.facebook || s.youtube);
  return html`<div class="rs-detail">
    ${!s ? html`<p class="rs-note">${error ? 'The numbers for this reveal couldn\'t be loaded. Reload the page to try again.' : 'There are no numbers for this reveal.'}</p>`
      : !s.counted ? html`<p class="rs-note">This reveal was before the site counted people${events.view_live_page ? `; it only kept page loads (${fmtN(events.view_live_page)})` : ''}. Its messages and links are below.</p>` : null}
    ${s?.counted && s.partial && since && !neverLive(r) ? html`<p class="rs-note">Counting began ${fmtDate(since)}, after this reveal was planned, so "before" misses anyone who looked earlier.</p>` : null}
    ${s?.counted && neverLive(r) ? html`<p class="rs-note">This reveal didn't go live, so there's nothing to compare.${num(s.people) ? ` ${plural(num(s.people), 'person', 'people')} opened its page before then.` : ''}</p>` : null}
    ${s?.counted && !neverLive(r) ? html`
      <div class="stats rs-tiles">
        <${Tile} label="Most at once" value=${fmtN(live ? a?.peakAll : null)} note=${a && live ? peakNote(a) : !live ? 'Counted while it\'s live.' : 'Not measured.'} />
        <${Tile} label="Average at once" value=${fmtN(live && a?.avgAll != null ? Math.round(a.avgAll) : null)} note=${a && live ? (a.avgAll != null ? 'Across the whole reveal, every place together.' : 'Facebook or YouTube wasn\'t read for much of the reveal, so there\'s no fair average.') : null} />
        <${Tile} label="People" value=${fmtN(s.people)} note=${peopleNote(r, s)} />
        <${Tile} label="Avg. watch, live" value=${fmtDur(live ? s.avgLiveSec : null)} note=${s.avgReplaySec != null ? `Replay ${fmtDur(s.avgReplaySec)}` : null} />
        <${Tile} label="There for the reveal" value=${fmtPct(there)} note=${thereNote} />
        <${Tile} label="Hearts" value=${fmtN(live ? s.heartsTotal : null)} note=${live && s.heartsTotal == null ? 'None recorded.' : null} />
      </div>
      ${s.series?.length ? html`<section class="rs-sec"><h4>Watching at once</h4><${AtOnceChart} series=${s.series} revealAt=${num(s.revealAt)} /></section>` : null}` : null}
    ${platforms ? html`<div class="rs-cols">
        ${s.counted ? html`<section class="rs-sec"><h4>Where people came from</h4><${Sources} sources=${s.sources} /></section>` : null}
        <section class="rs-sec"><h4>On Facebook and YouTube</h4><${Platforms} r=${r} s=${s} youtubeKey=${youtubeKey} youtubeOn=${youtubeOn} /></section>
      </div>` : null}
    ${s?.counted && clicks.length ? html`<p class="rs-muted rs-clicks">Clicks: ${clicks.join(' · ')}</p>` : null}
    ${leftOut.length ? html`<p class="rs-muted">Not counted: ${leftOut.join(' and ')}.</p>` : null}
    ${renderExtra ? renderExtra(r) : null}
  </div>`;
}

// ─── The table ──────────────────────────────────────────────────────

/** Keep the row someone opened where it was on screen, though the one above closes */
function keepInPlace(id, run) {
  const find = () => document.querySelector(`[data-rid="${String(id).replace(/["\\]/g, '\\$&')}"]`);
  const before = find()?.getBoundingClientRect().top;
  run();
  if (before == null) return;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    const after = find()?.getBoundingClientRect().top;
    if (after != null && Math.abs(after - before) > 1) window.scrollBy(0, after - before);
  }));
}

export function RevealStats({ rows: given = [], since = null, error = null, currentId = null, youtubeKey = true, youtubeOn = true, replayHours = 72, when = () => '', fmtDate = (x) => x, renderExtra = null }) {
  useEffect(injectCss, []);
  const [sort, setSort] = useState({ key: 'date', dir: 'desc' });
  const [open, setOpen] = useState(null);
  const [cards, setCards] = useState(0); // the table's width when it didn't fit (cards until the card is that wide)
  const cardRef = useRef(null);
  const rows = useMemo(() => settle(given, currentId), [given, currentId]);
  const table = useMemo(() => rows.filter(inTable), [rows]);
  const rest = useMemo(() => rows.filter((r) => !inTable(r)), [rows]);
  const cols = useMemo(() => COLUMNS.filter((c) => !c.optional || table.some((r) => valueOf(c, r) != null)), [table]);
  const sum = useMemo(() => columnSummary(table, cols), [table, cols]);
  const sorted = useMemo(() => (sort.key === 'date' ? sortRows(table, null, sort.dir) : sortRows(table, sort.key, sort.dir)), [table, sort]);
  const nCompared = table.filter(compared).length;
  // The row says how many reveals most of its averages cover; a column over a different number says "of N"
  const nAvg = useMemo(() => {
    const counts = {};
    for (const c of cols) { const n = sum[c.key]?.n || 0; if (n >= 2) counts[n] = (counts[n] || 0) + 1; }
    return Number(Object.entries(counts).sort((x, y) => y[1] - x[1] || y[0] - x[0])[0]?.[0] || 0);
  }, [cols, sum]);
  const toggle = (id) => keepInPlace(id, () => setOpen((cur) => (cur === id ? null : id)));
  // A row opens on a single click: a double-click (selecting a number to copy) or a drag-select doesn't toggle it
  const pending = useRef(null);
  const selecting = () => { try { return !!String(window.getSelection?.() || '').trim(); } catch { return false; } };
  const rowClick = (e, id) => {
    clearTimeout(pending.current);
    if (e.detail > 1 || selecting()) return;
    pending.current = setTimeout(() => { if (!selecting()) toggle(id); }, 260);
  };
  const nameClick = (e, id) => { e.stopPropagation(); clearTimeout(pending.current); if (e.detail > 1) return; toggle(id); };
  const replayWords = replayHours >= 48 ? `${Math.round(replayHours / 24)} days` : `${replayHours} hours`;
  const resort = (next) => (open ? keepInPlace(open, () => setSort(next)) : setSort(next));
  const sortBy = (key) => resort((cur) => (cur.key === key ? { key, dir: cur.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: 'desc' }));
  const ariaSort = (key) => (sort.key === key ? (sort.dir === 'desc' ? 'descending' : 'ascending') : 'none');
  const arrow = (key) => (sort.key === key ? (sort.dir === 'desc' ? '↓' : '↑') : '');
  const span = cols.length + 1;

  // Numbers wider than the switch points expect (millions, long dashes of columns): turn into cards rather than spill
  useEffect(() => {
    const card = cardRef.current;
    if (!card) return undefined;
    const check = () => {
      const tbl = card.querySelector('.rs-table table');
      const head = card.querySelector('.rs-table thead');
      if (!tbl || !head) return;
      const asTable = getComputedStyle(head).display !== 'none';
      if (asTable && tbl.scrollWidth > card.clientWidth + 1) setCards(tbl.scrollWidth);
      else if (cards && card.clientWidth >= cards) setCards(0);
    };
    check();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(check);
    ro.observe(card);
    return () => ro.disconnect();
  }, [cards, cols.length, rows, open]);

  const cell = (c, r) => {
    const v = valueOf(c, r);
    const best = compared(r) && v != null && sum[c.key]?.best != null && v === sum[c.key].best;
    return html`<td class=${`num${best ? ' is-best' : ''}`} data-label=${c.label}>${c.fmt(v)}${best ? html`<span class="rs-sr"> (highest)</span>` : null}</td>`;
  };
  const avgCell = (c) => {
    const { avg, n } = sum[c.key];
    const v = avg == null ? DASH : c.key === 'there' ? fmtPct(avg) : c.key === 'avgWatch' ? fmtDur(avg) : avg < 10 ? (Math.round(avg * 10) / 10).toLocaleString('en-US') : fmtN(Math.round(avg));
    return html`<td class="num" data-label=${`${c.label}, average`} title=${avg == null ? 'Needs two reveals with this number' : `Average of ${plural(n, 'reveal')}`}>${v}${avg != null && n !== nAvg ? html`<small class="rs-avg__n">of ${fmtN(n)}</small>` : null}</td>`;
  };
  const head = [
    error ? null : nCompared ? `${plural(nCompared, 'finished reveal')} compared.${nCompared >= 2 ? ' Sort by any number. Bold marks the one finished reveal that did best at it.' : ' The best and the averages show from the second one on.'}` : 'Each reveal is compared here once it\'s over.',
    'Staff and tests are never counted.',
  ].filter(Boolean).join(' ');
  const sizeClass = cols.length >= 10 ? ' rs-card--c10' : cols.length === 9 ? ' rs-card--c9' : '';

  return html`<div class="rs">
    <div class=${`card rs-card${sizeClass}${cards ? ' rs-card--cards' : ''}`} ref=${cardRef}>
      <div class="rs-head">
        ${error ? html`<p class="rs-note rs-note--warn" role="status">The reveal numbers couldn't be loaded (${words(error)}). Reload the page to try again; the reveals and their messages are below.</p>` : null}
        <p class="text-sm text-muted">${head}</p>
      </div>
      ${table.length ? html`<label class="rs-sortpick">
        <span class="rs-sortpick__label">Sort by</span>
        <select class="form-select" value=${`${sort.key}:${sort.dir}`} onChange=${(e) => { const [key, dir] = e.target.value.split(':'); resort({ key, dir }); }}>
          <option value="date:desc">Newest first</option>
          <option value="date:asc">Oldest first</option>
          ${cols.map((c) => html`<option value=${`${c.key}:desc`}>${c.label}, highest first</option><option value=${`${c.key}:asc`}>${c.label}, lowest first</option>`)}
        </select>
      </label>` : null}
      ${table.length ? html`<div class="rs-table"><table>
        <thead><tr>
          <th aria-sort=${ariaSort('date')}><button type="button" class="rs-sort" onClick=${() => sortBy('date')}>Reveal <span aria-hidden="true">${arrow('date')}</span></button></th>
          ${cols.map((c) => html`<th class="num" aria-sort=${ariaSort(c.key)}><button type="button" class="rs-sort" title=${c.means} onClick=${() => sortBy(c.key)}>${c.label}<span aria-hidden="true">${arrow(c.key) ? ` ${arrow(c.key)}` : ''}</span></button></th>`)}
        </tr></thead>
        <tbody>${sorted.map((r) => { const isOpen = open === r.id; return [
          html`<tr key=${r.id} data-rid=${r.id} class=${`rs-row${isOpen ? ' is-open' : ''}`} onClick=${(e) => rowClick(e, r.id)} onDblClick=${() => clearTimeout(pending.current)}>
            <td class="rs-name">
              <button type="button" class="rs-namebtn" aria-expanded=${isOpen} onClick=${(ev) => nameClick(ev, r.id)}><span class="rs-chev" aria-hidden="true"></span><strong>${r.kid_name || r.title || r.id}</strong></button>
              ${isUpcoming(r) ? html`<span class="tag tag--info">Coming up</span>` : r.phase === 'live' ? html`<span class="tag tag--success">Live now</span>` : r.phase === 'ending' ? html`<span class="tag tag--warn">Reconnecting</span>` : null}
              <div class="text-sm text-muted rs-when">${when(r)}</div></td>
            ${cols.map((c) => cell(c, r))}
          </tr>`,
          isOpen ? html`<tr key=${`${r.id}:open`} class="rs-open"><td colspan=${span}><${RevealDetail} r=${r} since=${since} error=${error} currentId=${currentId} youtubeKey=${youtubeKey} youtubeOn=${youtubeOn} fmtDate=${fmtDate} renderExtra=${renderExtra} /></td></tr>` : null,
        ]; })}
        </tbody>
        ${nAvg >= 2 ? html`<tfoot><tr class="rs-avg">
          <th scope="row">Average reveal <div class="text-sm text-muted">${plural(nAvg, 'finished reveal')}</div></th>
          ${cols.map(avgCell)}
        </tr></tfoot>` : null}
      </table></div>` : html`<div class="empty empty--inline"><p class="empty__text">${error ? 'No reveals to compare until the numbers load.' : rest.length ? 'Nothing to compare yet: the reveals below are tests, cancelled, Facebook-only or without a kid. The next reveal the site shows comes up here.' : 'No reveals yet. The next one shows up here.'}</p></div>`}
      <details class="rs-means">
        <summary>What each number means</summary>
        <dl>${cols.map((c) => html`<div><dt>${c.label}</dt><dd>${c.key === 'replay' ? c.means.replace('a few days after, as Settings says', `${replayWords} after`) : c.means}</dd></div>`)}</dl>
        <p class="rs-muted">History covers the latest 60 broadcasts. The average reveal is each number's average over the finished reveals that have it (at least two); "of 3" under one says how many. The next reveal and one live now show what they have so far and stay out of the averages. Anyone who has opened this admin counts as staff on that browser, and automated tests are recognized, so neither is ever in these numbers.${since ? ` People have been counted since ${fmtDate(since)}.` : ''}</p>
      </details>
    </div>
    ${rest.length ? html`<details class="card bc-fold rs-rest">
      <summary>Not compared: tests, cancelled reveals, Facebook-only lives and streams without a kid <span class="bc-fold-note">${rest.length}</span></summary>
      <div class="bc-fold-body">
        <p class="text-sm text-muted" style="margin:0 0 .5rem">Kept out of the comparison and the averages.</p>
        ${rest.map((r) => { const isOpen = open === r.id; return html`<div key=${r.id} data-rid=${r.id} class=${`rs-restrow${isOpen ? ' is-open' : ''}`}>
          <button type="button" class="rs-restbtn" aria-expanded=${isOpen} onClick=${() => toggle(r.id)}>
            <span><strong>${r.title || r.kid_name || r.id}</strong>${isTest(r) ? html` <span class="tag">Test</span>` : null}<span class="text-sm text-muted"> ${when(r)}</span></span>
            <span class="rs-restbtn__go">${isOpen ? 'Close' : 'Open'}</span>
          </button>
          ${isOpen ? html`<${RevealDetail} r=${r} since=${since} error=${error} currentId=${currentId} youtubeKey=${youtubeKey} youtubeOn=${youtubeOn} fmtDate=${fmtDate} renderExtra=${renderExtra} />` : null}
        </div>`; })}
      </div>
    </details>` : null}
  </div>`;
}

// ─── Styles ─────────────────────────────────────────────────────────

// The card widths below which the table turns into cards: at its narrowest it's about 620px with the
// eight usual numbers, 700 with Facebook or YouTube and 765 with both (measured), plus room for bigger
// numbers. Anything wider still (millions) is caught as it happens (RevealStats' check).
const CARDS_AT = 700;
const CARDS_AT_C9 = 790;
const CARDS_AT_C10 = 860;
const cards = (c) => `
  ${c} .rs-head { padding: 1rem 1rem .25rem; }
  ${c} .rs-sortpick { display: flex; align-items: center; gap: .5rem; padding: .25rem 1rem .5rem; font-size: var(--fs-sm); color: var(--color-text-secondary); }
  ${c} .rs-sortpick__label { white-space: nowrap; }
  ${c} .rs-sortpick select { width: auto; max-width: 100%; min-width: 0; }
  ${c} .rs-table table, ${c} .rs-table tbody, ${c} .rs-table tfoot { display: block; }
  ${c} .rs-table thead { display: none; }
  ${c} .rs-row, ${c} .rs-avg { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: .6rem .75rem; padding: .85rem 1rem; border-top: 1px solid var(--color-border); }
  ${c} .rs-avg { border-top: 2px solid var(--color-border-strong); }
  ${c} .rs-row td, ${c} .rs-avg td, ${c} .rs-avg th { padding: 0 !important; border: 0; background: none !important; }
  ${c} .rs-row td.rs-name, ${c} .rs-avg th { grid-column: 1 / -1; }
  ${c} .rs-row td.num, ${c} .rs-avg td.num { text-align: left; font-size: var(--fs-base); padding-top: 0; }
  ${c} .rs-row td.num::before, ${c} .rs-avg td.num::before { content: attr(data-label); display: block; font-size: var(--fs-2xs); font-weight: 600; letter-spacing: .04em; text-transform: uppercase; color: var(--color-text-muted); white-space: normal; }
  ${c} .rs-open, ${c} .rs-open > td { display: block; }
  ${c} .rs-open > td { padding: .25rem 1rem 1rem; }
  ${c} .rs-means { padding: .25rem 1rem 1rem; }
  ${c} .rs-means dl div { grid-template-columns: minmax(0, 1fr); gap: .1rem; }`;

const CSS = `
.rs { display: grid; gap: 1rem; min-width: 0; }
/* clip, not hidden: a card that hides its overflow is a scroll box, and the headings couldn't stick to the page */
.rs-card { padding: 0; container: rs / inline-size; min-width: 0; overflow: clip; }
.rs-head { padding: 1.1rem 1.5rem .5rem; }
.rs-head p { margin: 0; }
.rs-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.rs-sortpick { display: none; }
.rs-table { min-width: 0; }
.rs-table table { width: 100%; border-collapse: collapse; }
.rs-table th, .rs-table td { padding: .6rem .4rem; border-top: 1px solid var(--color-border); border-bottom: 0; vertical-align: top; text-align: left; }
/* Headings wrap at their words so every number fits beside the reveal's name, and stay in view down a long list */
.rs-table thead th { position: sticky; top: 0; z-index: 2; background: var(--color-bg-card); border-top: 0; border-bottom: 1px solid var(--color-border); vertical-align: bottom; white-space: normal; line-height: 1.25; font-size: var(--fs-2xs); font-weight: 700; letter-spacing: .03em; text-transform: uppercase; color: var(--color-text-secondary); }
.rs-table th:first-child, .rs-table td:first-child { padding-left: 1.5rem; }
.rs-table th:last-child, .rs-table td:last-child { padding-right: 1.5rem; }
.rs-table .num { text-align: right; font-variant-numeric: tabular-nums; }
.rs-table td.num { white-space: nowrap; }
@media (max-width: 1024px) { .rs-table thead th { top: var(--top-h); } }
.rs-sort { all: unset; cursor: pointer; display: inline; line-height: 1.3; border-radius: 4px; }
.rs-table th.num .rs-sort { text-align: right; }
.rs-sort:hover { color: var(--color-text); }
.rs-sort:focus-visible { box-shadow: var(--focus-ring-strong); }
.rs-row { cursor: pointer; }
.rs-row:hover td, .rs-row.is-open td { background: var(--color-bg-secondary); }
.rs-name { min-width: 9rem; }
.rs-name strong { min-width: 0; font-size: var(--fs-md); overflow-wrap: break-word; hyphens: auto; }
.rs-namebtn { all: unset; cursor: pointer; display: inline-flex; align-items: baseline; gap: .45rem; max-width: 100%; border-radius: 4px; color: var(--color-text); }
.rs-namebtn:focus-visible { box-shadow: var(--focus-ring-strong); }
.rs-chev { flex: none; width: 6px; height: 6px; border-right: 2px solid var(--color-text-muted); border-bottom: 2px solid var(--color-text-muted); transform: translateY(-2px) rotate(-45deg); transition: transform .15s; }
.rs-namebtn[aria-expanded="true"] .rs-chev { transform: translateY(-3px) rotate(45deg); }
.rs-name .tag { margin-left: .4rem; }
.rs-when { padding-left: calc(6px + .45rem + 2px); }
.rs-row td.num { font-size: var(--fs-md); padding-top: .75rem; }
.rs-row td.is-best { font-weight: 700; }
.rs-open > td { background: var(--color-bg-secondary); padding: .25rem 1.5rem 1.25rem; }
.rs-avg th, .rs-avg td { border-top: 2px solid var(--color-border-strong); color: var(--color-text-secondary); font-weight: 600; }
.rs-avg th { font-size: var(--fs-sm); text-transform: none; letter-spacing: 0; text-align: left; }
.rs-means { padding: .25rem 1.5rem 1.25rem; font-size: var(--fs-sm); }
.rs-means summary { cursor: pointer; color: var(--color-text-secondary); font-weight: 600; padding: .5rem 0; }
.rs-means dl { display: grid; gap: .4rem; margin: .25rem 0 .5rem; }
.rs-means dl div { display: grid; grid-template-columns: minmax(0, 11rem) minmax(0, 1fr); gap: .75rem; }
.rs-means dt { font-weight: 600; }
.rs-means dd { margin: 0; color: var(--color-text-secondary); }
.rs-muted { margin: .35rem 0 0; font-size: var(--fs-xs); line-height: 1.5; color: var(--color-text-muted); }
.rs-avg__n { display: block; font-size: var(--fs-2xs); font-weight: 500; color: var(--color-text-muted); }
.rs-note--warn { margin: 0 0 .6rem !important; background: var(--tone-warn-surface) !important; border-color: var(--tone-warn-line-strong) !important; color: var(--tone-warn-fg) !important; }
.rs-note { margin: .75rem 0 0; padding: .6rem .8rem; border-radius: var(--radius-sm); background: var(--tone-info-surface); border: 1px solid var(--tone-info-line); color: var(--tone-info-fg); font-size: var(--fs-sm); line-height: 1.5; }
.rs-detail { display: grid; gap: 1rem; padding-top: .5rem; min-width: 0; }
/* Six tiles: three to a row at most (3 + 3), two on a phone */
.rs-tiles { margin: 0; grid-template-columns: repeat(auto-fit, minmax(max(120px, calc((100% - 1.5rem) / 3)), 1fr)); }
.rs-sec { min-width: 0; }
.rs-sec h4 { margin: 0 0 .5rem; font-size: var(--fs-sm); font-weight: 700; }
.rs-cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 280px), 1fr)); gap: 1rem 1.5rem; }
.rs-clicks { margin: 0; }
.rs-chart { position: relative; min-width: 0; padding: .75rem .75rem .5rem; border: 1px solid var(--color-border); border-radius: var(--radius-md); background: var(--color-bg-card); }
.rs-readout { margin: 0 0 .4rem; min-height: 2.6em; font-size: var(--fs-xs); line-height: 1.3; color: var(--color-text-secondary); }
.rs-readout strong { color: var(--color-text); font-variant-numeric: tabular-nums; }
.rs-legend { display: flex; flex-wrap: wrap; gap: .35rem 1rem; margin: 0 0 .25rem; font-size: var(--fs-xs); color: var(--color-text-secondary); }
.rs-legend span { display: inline-flex; align-items: center; gap: .35rem; }
.rs-plot { position: relative; min-width: 0; touch-action: pan-y; }
.rs-svg { display: block; overflow: visible; }
.rs-svg:focus-visible { outline: none; box-shadow: var(--focus-ring-strong); border-radius: 6px; }
.rs-grid { stroke: var(--color-border); stroke-width: 1; shape-rendering: crispEdges; }
.rs-axis { font-size: 11px; fill: var(--color-text-muted); font-variant-numeric: tabular-nums; }
.rs-reveal line { stroke: var(--color-text); stroke-width: 1; }
.rs-reveal text { font-size: 11px; font-weight: 700; fill: var(--color-text); }
.rs-end text { font-size: 11px; fill: var(--color-text-secondary); }
.rs-end line { stroke: var(--color-border-strong); stroke-width: 1; }
.rs-cross line { stroke: var(--color-text-muted); stroke-width: 1; }
.rs-tip { position: absolute; top: 4px; min-width: 9.5rem; padding: .5rem .65rem; border-radius: var(--radius-sm); background: var(--color-bg-card); border: 1px solid var(--color-border-strong); box-shadow: var(--shadow-md); font-size: var(--fs-xs); pointer-events: none; z-index: 2; }
.rs-tip__when { color: var(--color-text-muted); margin-bottom: .25rem; }
.rs-tip__row { display: flex; align-items: center; gap: .4rem; line-height: 1.6; }
.rs-tip__row strong { font-size: var(--fs-sm); font-variant-numeric: tabular-nums; color: var(--color-text); }
.rs-tip__row span { color: var(--color-text-secondary); }
.rs-tip__total { border-top: 1px solid var(--color-border); margin-top: .2rem; padding-top: .2rem; padding-left: 1.15rem; }
.rs-numbers { margin-top: .35rem; font-size: var(--fs-xs); }
.rs-numbers summary { cursor: pointer; color: var(--color-text-secondary); font-weight: 600; }
.rs-numbers__wrap { max-height: 16rem; overflow: auto; margin-top: .35rem; }
.rs-numbers table { width: 100%; border-collapse: collapse; }
.rs-numbers th, .rs-numbers td { padding: .25rem .5rem; border-top: 1px solid var(--color-border); text-align: left; }
.rs-numbers .num { text-align: right; font-variant-numeric: tabular-nums; }
.rs-numbers tr.is-peak td { font-weight: 700; }
.rs-bars { list-style: none; margin: 0; padding: 0; display: grid; gap: .45rem; }
.rs-bars li { display: grid; grid-template-columns: minmax(0, 10rem) minmax(0, 1fr) auto; align-items: center; gap: .6rem; font-size: var(--fs-sm); }
.rs-bars__name { min-width: 0; overflow-wrap: anywhere; }
.rs-bars__track { height: 10px; border-radius: 0 4px 4px 0; background: transparent; }
.rs-bars__track > span { display: block; height: 100%; border-radius: 0 4px 4px 0; background: ${COLORS.site}; }
.rs-bars__n { font-variant-numeric: tabular-nums; white-space: nowrap; text-align: right; min-width: 4.5rem; }
.rs-bars__n small { color: var(--color-text-muted); font-size: var(--fs-xs); }
.rs-plats { display: grid; gap: .9rem; }
.rs-plat h5 { margin: 0 0 .3rem; font-size: var(--fs-sm); }
.rs-plat dl { display: grid; grid-template-columns: repeat(auto-fill, minmax(8rem, 1fr)); gap: .4rem .9rem; margin: 0; }
.rs-plat dt { font-size: var(--fs-2xs); font-weight: 700; letter-spacing: .04em; text-transform: uppercase; color: var(--color-text-secondary); }
.rs-plat dd { margin: 0; font-size: var(--fs-md); font-weight: 700; font-variant-numeric: tabular-nums; }
.rs-rest .bc-fold-body { display: grid; gap: .25rem; }
.rs-restrow { border-top: 1px solid var(--color-border); min-width: 0; }
.rs-restrow:first-of-type { border-top: 0; }
.rs-restbtn { all: unset; box-sizing: border-box; display: flex; justify-content: space-between; align-items: baseline; gap: 1rem; width: 100%; padding: .6rem 0; cursor: pointer; min-width: 0; }
.rs-restbtn > span:first-child { min-width: 0; overflow-wrap: anywhere; }
.rs-restbtn:focus-visible { box-shadow: var(--focus-ring-strong); border-radius: 4px; }
.rs-restbtn__go { font-size: var(--fs-sm); font-weight: 600; color: var(--color-text-secondary); flex: none; }
.rs-restrow.is-open { padding-bottom: 1rem; }

/* Narrow (a phone, or the card beside a wide sidebar): each reveal is a card of labeled numbers.
   With Facebook and YouTube's columns too, the table needs more room before it fits. */
@container rs (max-width: ${CARDS_AT}px) { ${cards('.rs-card')} }
@container rs (max-width: ${CARDS_AT_C9}px) { ${cards('.rs-card--c9')} }
@container rs (max-width: ${CARDS_AT_C10}px) { ${cards('.rs-card--c10')} }
${cards('.rs-card--cards')}
@container rs (max-width: 420px) {
  .rs-row, .rs-avg { grid-template-columns: repeat(2, minmax(0, 1fr)) !important; }
  .rs-bars li { grid-template-columns: minmax(0, 1fr) auto; }
  .rs-bars__track { grid-column: 1 / -1; grid-row: 2; }
}
`;

function injectCss() {
  const have = document.getElementById('rs-css');
  if (have) { have.textContent = CSS; return; }
  const s = document.createElement('style');
  s.id = 'rs-css';
  s.textContent = CSS;
  document.head.appendChild(s);
}
