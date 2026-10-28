/**
 * /api/vendors-admin — Admin → Vendors (see ./_vendors.js)
 * ===========================================================================
 * Behind Cloudflare Access (not in the middleware's public list).
 *
 * GET                          → vendors, link suggestions, 1099 lists, settings, health
 * GET ?file=<vendorId>&doc=coi|w9  → that vendor's file (from R2, or Mercury's W-9 link)
 * GET ?csv=1099&year=YYYY      → the 1099 list as CSV, for the CPA
 * POST { action: 'settings', autoW9?, autoCoi?, threshold?, coiDays?, replyTo? }
 * POST { action: 'set', id, email?, kind?: 'sub'|'supplier'|null, corp?, coiNeeded?: true|false|null, coiExpires?, coiInsurer? }
 * POST { action: 'link', a, b }       b becomes part of a
 * POST { action: 'not-same', a, b }   stop suggesting these two
 * POST { action: 'unlink', id, part: 'mercury'|'jobtread' }
 * POST { action: 'ask-w9', id }       Mercury emails them its W-9 page now
 * POST { action: 'ask-coi', id }      email them our upload link now
 * POST { action: 'coi-link', id }     a link to copy and send by hand
 * POST { action: 'preview', kind: 'w9'|'coi', id? }  the vendor's email, sent to you
 * POST { action: 'refresh' }          read Mercury and JobTread again now (after a fix)
 * POST multipart: action=upload, id, doc=coi|w9, file, coiExpires?, coiInsurer?
 */

import {
  vendorsView, readVendor, patchVendor, readSettings, linkVendors, unlinkVendor, askW9, askCoi, createUploadLink, saveDocuments,
  vendorStatus, vendorFiles, csv1099, maybeRunVendors, STATE_KEY, DEFAULTS,
} from './_vendors.js';
import { readState, writeState, getRecipient, mercuryConfigured } from './_mercury.js';
import { fileHeaders } from '../files/[[path]].js';
import { logAudit } from './_audit.js';

const ok = (body = {}) => Response.json({ success: true, ...body });
const fail = (error, status = 400) => Response.json({ success: false, error }, { status });
const isEmail = (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(s || ''));
const notFound = () => new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'private, no-store' } });

async function audit(env, userEmail, action, name) {
  await logAudit(env.DB, { userEmail, action, entityType: 'vendor', entitySlug: 'vendors', entityName: name, gitStatus: 'ok' }).catch(() => {});
}

export async function onRequestGet(context) {
  const { env, request } = context;
  if (!env.DB) return fail('DB not bound', 500);
  const url = new URL(request.url);
  try {
    const fileFor = url.searchParams.get('file');
    if (fileFor) {
      const v = await readVendor(env.DB, fileFor);
      const doc = url.searchParams.get('doc') === 'w9' ? 'w9' : 'coi';
      if (!v) return notFound();
      // A W-9 the vendor gave Mercury: Mercury's own link, good for 12 hours
      if (doc === 'w9' && v.w9?.source === 'mercury' && v.mercuryId && mercuryConfigured(env)) {
        const r = await getRecipient(env, v.mercuryId);
        const a = (r?.attachments || []).filter((x) => x.formType).sort((x, y) => String(y.uploadedAt).localeCompare(String(x.uploadedAt)))[0];
        return a?.url ? Response.redirect(a.url, 302) : notFound();
      }
      const key = doc === 'w9' ? v.w9?.key : v.coi?.key;
      if (!key || !key.startsWith(`vendors/${v.id}/`)) return notFound();
      const obj = await vendorFiles(env)?.get(key);
      if (!obj) return notFound();
      const headers = fileHeaders(`${v.name} ${doc === 'w9' ? 'W-9' : 'COI'}.${key.split('.').pop()}`, obj.httpMetadata?.contentType);
      headers.set('Cache-Control', 'private, no-store');
      return new Response(obj.body, { headers });
    }
    if (url.searchParams.get('csv') === '1099') {
      const view = await vendorsView(env);
      const year = Number(url.searchParams.get('year')) || view.year - 1;
      const rows = view.filings[year] || [];
      return new Response(csv1099(rows, year), {
        headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="SOARD 1099 vendors ${year}.csv"`, 'Cache-Control': 'private, no-store' },
      });
    }
    return ok(await vendorsView(env));
  } catch (e) {
    return fail(e.message, 500);
  }
}

export async function onRequestPost(context) {
  const { env, request } = context;
  if (!env.DB) return fail('DB not bound', 500);
  const by = context.data?.userEmail || 'admin';
  try {
    // A file staff received by email: multipart
    if ((request.headers.get('Content-Type') || '').startsWith('multipart/form-data')) {
      const form = await request.formData();
      if (form.get('action') !== 'upload') return fail('Unknown action');
      const v = await readVendor(env.DB, String(form.get('id') || ''));
      if (!v) return fail('That vendor isn’t here', 404);
      const doc = form.get('doc') === 'w9' ? 'w9' : 'coi';
      const file = form.get('file');
      const next = await saveDocuments(env, v, doc === 'w9'
        ? { w9File: file, by }
        : { coiFile: file, coiExpires: String(form.get('coiExpires') || ''), coiInsurer: String(form.get('coiInsurer') || ''), by });
      await audit(env, by, 'updated', `${v.name}: ${doc === 'w9' ? 'W-9' : 'certificate of insurance'} added`);
      return ok({ vendor: next, ...(await vendorsView(env)) });
    }

    let b = {};
    try { b = await request.json(); } catch { return fail('Send JSON'); }
    const vendor = b.id ? await readVendor(env.DB, String(b.id)) : null;
    if (b.id && !vendor) return fail('That vendor isn’t here', 404);
    let extra = {};
    switch (b.action) {
      case 'settings': {
        const cur = await readSettings(env.DB);
        const next = { ...cur };
        if (typeof b.autoW9 === 'boolean') next.autoW9 = b.autoW9;
        if (typeof b.autoCoi === 'boolean') next.autoCoi = b.autoCoi;
        if (b.threshold !== undefined) {
          const n = Math.round(Number(b.threshold));
          if (!(n >= 0 && n <= 100000)) return fail('Pick an amount from $0 to $100,000');
          next.threshold = n;
        }
        if (b.coiDays !== undefined) {
          const n = Math.round(Number(b.coiDays));
          if (!(n >= 7 && n <= 90)) return fail('Pick 7 to 90 days');
          next.coiDays = n;
        }
        if (b.replyTo !== undefined) {
          const r = String(b.replyTo || '').trim().toLowerCase();
          if (r && !isEmail(r)) return fail('That reply-to address doesn’t look right');
          next.replyTo = r;
        }
        await writeState(env.DB, STATE_KEY, { settings: { ...DEFAULTS, ...next } });
        if (cur.autoW9 !== next.autoW9) await audit(env, by, 'updated', `Vendors: automatic W-9 requests ${next.autoW9 ? 'on' : 'off'}`);
        if (cur.autoCoi !== next.autoCoi) await audit(env, by, 'updated', `Vendors: automatic insurance requests ${next.autoCoi ? 'on' : 'off'}`);
        break;
      }
      case 'set': {
        const patch = {};
        if (b.email !== undefined) {
          const e = String(b.email || '').trim().toLowerCase();
          if (e && !isEmail(e)) return fail('That email doesn’t look right');
          Object.assign(patch, { email: e || null, emailSet: true });
        }
        if (b.kind !== undefined) patch.kindSet = b.kind === 'sub' || b.kind === 'supplier' ? b.kind : null;
        if (b.corp !== undefined) patch.corp = !!b.corp;
        if (b.coiNeeded !== undefined) patch.coiNeeded = b.coiNeeded === null ? null : !!b.coiNeeded;
        await patchVendor(env.DB, vendor.id, patch);
        // A certificate's details typed by staff (the file came another way, or is already here)
        if (b.coiExpires !== undefined) await saveDocuments(env, await readVendor(env.DB, vendor.id), { coiExpires: b.coiExpires, coiInsurer: b.coiInsurer, by });
        break;
      }
      case 'link': {
        const kept = await linkVendors(env.DB, String(b.a || ''), String(b.b || ''));
        await audit(env, by, 'updated', `Vendors: linked into ${kept.name}`);
        extra = { keptId: kept.id };
        break;
      }
      case 'not-same': {
        const st = await readState(env.DB, STATE_KEY);
        await writeState(env.DB, STATE_KEY, { notSame: [...new Set([...(st.notSame || []), `${b.a}|${b.b}`])].slice(-500) });
        break;
      }
      case 'unlink': {
        const made = await unlinkVendor(env.DB, vendor.id, b.part);
        await audit(env, by, 'updated', `Vendors: ${vendor.name} pulled apart`);
        extra = { newId: made.id };
        break;
      }
      case 'ask-w9':
        await askW9(env, vendor, { by });
        await audit(env, by, 'updated', `${vendor.name}: W-9 asked for through Mercury`);
        break;
      case 'ask-coi': {
        const settings = await readSettings(env.DB);
        await askCoi(env, vendor, vendorStatus(vendor, null, settings), { by, replyTo: settings.replyTo });
        await audit(env, by, 'updated', `${vendor.name}: certificate of insurance asked for`);
        break;
      }
      case 'coi-link': {
        const link = await createUploadLink(env.DB, vendor.id, { by });
        extra = { link };
        break;
      }
      case 'preview': {
        if (!isEmail(by)) return fail('Sign in with your SOARD email to get a preview');
        const settings = await readSettings(env.DB);
        const sample = vendor || { id: 'preview', name: 'Example Plumbing LLC', email: by, facts: { jobs: [{ jobName: 'A makeover' }] }, coi: null, coiAsk: null };
        if (b.kind === 'w9') await askW9(env, sample, { email: by, preview: true });
        else await askCoi(env, sample, { coiState: sample.coi?.expires ? 'expiring' : 'missing' }, { to: by, preview: true, replyTo: settings.replyTo });
        extra = { sentTo: by };
        break;
      }
      case 'refresh':
        await maybeRunVendors(env, { force: true });
        break;
      default:
        return fail('Unknown action');
    }
    return ok({ ...extra, ...(await vendorsView(env)) });
  } catch (e) {
    return fail(e.message, e.status && e.status < 500 ? e.status : 500);
  }
}

