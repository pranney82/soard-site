/**
 * /api/finance-admin — Admin → Finance (see ./_finance.js)
 * ===========================================================================
 * Behind Cloudflare Access (not in the middleware's public list).
 *
 * GET ?view=pnl&month=YYYY-MM   → the P&L for a month, with last year and year to date
 * GET ?view=cash[&fresh=1]      → the 13-week cash forecast (fresh asks Mercury for balances now)
 * GET ?view=close               → the close checklist for last month and earlier open months
 * GET ?view=setup               → settings
 * GET ?view=csv&month=YYYY-MM   → the month's P&L as a CSV download
 * POST { action: 'income-source', key, kind: 'donations'|'store'|'other'|null }
 * POST { action: 'settings', floorCents?, cpaEmail?, replyTo? }
 * POST { action: 'close', month } / { action: 'reopen', month }
 * POST { action: 'preview-close', month }   (the CPA's email, sent only to whoever pressed it)
 */

import {
  monthReport, cashForecast, openMonths, closeMonth, reopenMonth, closeEmail, monthCsv, readFinance, writeFinance,
  monthsAvailable, monthOf, INCOME_KINDS,
} from './_finance.js';
import { mercuryConfigured } from './_mercury.js';
import { emailConfigured, isEmail } from './_broadcast-notify.js';

const ok = (body = {}) => Response.json({ success: true, ...body });
const fail = (error, status = 400) => Response.json({ success: false, error }, { status });
const MONTH = /^\d{4}-\d{2}$/;

async function common(env, now) {
  const fin = await readFinance(env.DB);
  return {
    months: monthsAvailable(fin, now),
    health: {
      mercury: mercuryConfigured(env),
      email: emailConfigured(env),
      history: { since: fin.backfill?.since || null, doneAt: fin.backfill?.doneAt || null, reachedTo: fin.backfill?.reachedTo || null, read: fin.backfill?.read || 0, error: fin.backfill?.error || null },
      balancesError: fin.balancesError || null,
      cpaError: fin.cpaError || null,
      lastRunAt: fin.lastRunAt || null,
    },
    settings: { floorCents: Number.isFinite(fin.floorCents) ? fin.floorCents : null, cpaEmail: fin.cpaEmail || '', replyTo: fin.replyTo || '' },
  };
}

export async function onRequestGet(context) {
  const { env, request } = context;
  if (!env.DB) return fail('DB not bound', 500);
  const url = new URL(request.url);
  const view = url.searchParams.get('view') || 'pnl';
  const now = Date.now();
  try {
    if (view === 'csv') {
      const month = url.searchParams.get('month') || '';
      if (!MONTH.test(month)) return fail('Pick a month');
      return new Response(await monthCsv(env, month), {
        headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="SOARD-PL-${month}.csv"`, 'Cache-Control': 'no-store' },
      });
    }
    const base = await common(env, now);
    if (view === 'pnl') {
      const month = MONTH.test(url.searchParams.get('month') || '') ? url.searchParams.get('month') : monthOf(now);
      return ok({ ...base, pnl: await monthReport(env, month, { now }) });
    }
    if (view === 'cash') return ok({ ...base, cash: await cashForecast(env, { now, fresh: url.searchParams.get('fresh') === '1' }) });
    if (view === 'close') return ok({ ...base, close: await openMonths(env, { now }) });
    if (view === 'setup') return ok(base);
    return fail('Unknown view');
  } catch (e) {
    return fail(e.message, 500);
  }
}

export async function onRequestPost(context) {
  const { env, request } = context;
  if (!env.DB) return fail('DB not bound', 500);
  let b = {};
  try { b = await request.json(); } catch { return fail('Send JSON'); }
  const by = context.data?.userEmail || null;
  const now = Date.now();
  try {
    switch (b.action) {
      case 'income-source': {
        const key = String(b.key || '').slice(0, 60);
        if (!key) return fail('Pick who sent it');
        const fin = await readFinance(env.DB);
        const map = { ...(fin.incomeMap || {}) };
        if (INCOME_KINDS.includes(b.kind) && b.kind !== 'interest') map[key] = b.kind;
        else delete map[key];
        await writeFinance(env.DB, { incomeMap: map });
        const month = MONTH.test(b.month || '') ? b.month : monthOf(now);
        return ok({ ...(await common(env, now)), pnl: await monthReport(env, month, { now }) });
      }
      case 'settings': {
        const patch = {};
        if (b.floorCents !== undefined) {
          const n = Math.round(Number(b.floorCents));
          if (!Number.isFinite(n) || n < 0 || n > 1e11) return fail('The cash floor should be a dollar amount');
          patch.floorCents = n;
          patch.lastRunAt = null; // the forecast checks the new floor on the next heartbeat
        }
        for (const k of ['cpaEmail', 'replyTo']) {
          if (b[k] === undefined) continue;
          const v = String(b[k] || '').trim().toLowerCase();
          if (v && !isEmail(v)) return fail(`${k === 'cpaEmail' ? 'The CPA’s email' : 'The reply-to address'} doesn’t look right`);
          patch[k] = v || null;
        }
        await writeFinance(env.DB, patch);
        return ok(await common(env, now));
      }
      case 'close': {
        if (!MONTH.test(b.month || '')) return fail('Pick a month');
        await closeMonth(env, b.month, { by, now });
        return ok({ ...(await common(env, now)), close: await openMonths(env, { now }) });
      }
      case 'reopen': {
        if (!MONTH.test(b.month || '')) return fail('Pick a month');
        await reopenMonth(env, b.month);
        return ok({ ...(await common(env, now)), close: await openMonths(env, { now }) });
      }
      case 'preview-close': {
        if (!MONTH.test(b.month || '')) return fail('Pick a month');
        if (!isEmail(by)) return fail('Sign in with your SOARD email to get a preview');
        await closeEmail(env, b.month, { to: by, preview: true, by });
        return ok({ sentTo: by });
      }
      default:
        return fail('Unknown action');
    }
  } catch (e) {
    return fail(e.message, 500);
  }
}
