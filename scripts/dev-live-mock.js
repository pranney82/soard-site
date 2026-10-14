/**
 * Astro integration: Dev Live Mock
 *
 * `astro dev` serves no Pages Functions, so /api/broadcast 404s and the LIVE
 * pill never shows locally. This answers /api/broadcast with a fake broadcast
 * so the pill (and the /live pages) can be seen and styled in dev.
 *
 * Switch states by visiting:
 *   /__live/?state=live       pulsing "Live now"
 *   /__live/?state=upcoming   "Reveal day" countdown (3 hours out)
 *   /__live/?state=starting   10 minutes out: the starting-soon screen fills the frame
 *   /__live/?state=replay     "Replay ready"
 *   /__live/?state=off        idle, no pill (the default)
 * Add &kid=<slug> to feature a specific kid; otherwise the most recent
 * in-progress kid is used. The switch redirects to the home page.
 *
 * Also answers /api/live-messages from memory (a few sample notes, and
 * anything you post that has no link in it), so the messages wall works in
 * dev. Reactions animate locally only: there is no real-time hub in dev.
 *
 * Dev only: never registered for builds, and the mode lives in memory, so a
 * dev server restart goes back to off.
 */

import { readdirSync, readFileSync } from 'node:fs';

const KIDS_DIR = new URL('../src/content/kids/', import.meta.url);
const STATES = ['live', 'upcoming', 'starting', 'replay', 'off'];
const SAMPLE_NOTES = [
  ['Dana', 'We have been following since day one. Enjoy every inch of it!'],
  ['Marcus', 'Proud of you, buddy. Best room in Georgia.'],
  ['Ms. Lee', 'Watching from the classroom with your whole class cheering!'],
];
const notes = new Map(); // broadcast id → [{ id, name, body, at }]
const notesFor = (id) => {
  if (!notes.has(id)) notes.set(id, SAMPLE_NOTES.map(([name, body], i) => ({ id: `${id}-s${i}`, name, body, at: new Date(Date.now() - (3 - i) * 60e3).toISOString() })));
  return notes.get(id);
};

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => { data += c; });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
  });
}

let mode = 'off';
let kidSlug = null;

function readKid(slug) {
  try { return JSON.parse(readFileSync(new URL(`${slug}.json`, KIDS_DIR), 'utf8')); } catch { return null; }
}

function defaultKid() {
  const kids = readdirSync(KIDS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readKid(f.replace(/\.json$/, '')))
    .filter((k) => k?.heroImage && k.publishStatus !== 'draft');
  kids.sort((a, b) => (b.year || 0) - (a.year || 0) || String(a.name).localeCompare(String(b.name)));
  return kids.find((k) => k.status === 'in-progress') || kids[0] || null;
}

// The broadcast state stores a bare Cloudflare Images id, not a delivery URL
function imageId(src) {
  if (!src) return null;
  return src.replace(/^https:\/\/imagedelivery\.net\/[^/]+\//, '').replace(/\/(public|[^/]*=[^/]*)$/, '');
}

function buildState(origin) {
  const at = (h) => new Date(Date.now() + h * 3600e3).toISOString();
  const kid = (kidSlug && readKid(kidSlug)) || defaultKid();
  const slug = kid?.slug || null;
  const liveUrl = slug ? `${origin}/live/${slug}/` : `${origin}/live/`;
  const idle = {
    phase: 'idle', live: false, upcoming: false, replay: false,
    id: null, kidSlug: null, kidName: null, title: null, message: null, image: null,
    scheduledAt: null, liveAt: null, endedAt: null, replayUntil: null,
    url: `${origin}/live/`, liveUrl: `${origin}/live/`, player: null,
    facebookUrl: 'https://www.facebook.com/SunshineOnaRanneyDay', youtubeUrl: null, instagramUrl: null,
    orientation: 'landscape', source: 'dev-mock', updatedAt: new Date().toISOString(),
  };
  if (mode === 'off' || !kid) return idle;

  const common = {
    ...idle,
    // A fresh id per state and kid, so a dismissed pill comes back after switching
    id: `dev-${mode}-${slug}`,
    kidSlug: slug, kidName: kid.name, title: `${kid.name}'s room reveal`,
    image: imageId(kid.heroImage), url: liveUrl, liveUrl,
  };
  if (mode === 'live') return { ...common, phase: 'live', live: true, scheduledAt: at(-0.25), liveAt: at(-0.1) };
  if (mode === 'starting') return { ...common, phase: 'armed', upcoming: true, scheduledAt: at(10 / 60) };
  if (mode === 'replay') return { ...common, phase: 'replay', replay: true, scheduledAt: at(-3), liveAt: at(-3), endedAt: at(-2), replayUntil: at(70) };
  const halfHour = 1800e3;
  return { ...common, phase: 'scheduled', upcoming: true, scheduledAt: new Date(Math.ceil((Date.now() + 3 * 3600e3) / halfHour) * halfHour).toISOString() };
}

function handler(logger) {
  return (req, res, next) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === '/__live' || url.pathname === '/__live/') {
      const requested = url.searchParams.get('state');
      if (STATES.includes(requested)) mode = requested;
      if (url.searchParams.has('kid')) kidSlug = url.searchParams.get('kid') || null;
      logger.info(`live banner mock: ${mode}${mode !== 'off' ? ` (${(kidSlug && readKid(kidSlug)?.name) || defaultKid()?.name})` : ''}`);
      res.writeHead(302, { Location: '/' });
      return res.end();
    }

    if (url.pathname === '/api/broadcast' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({
        state: buildState(url.origin),
        reminders: { enabled: true, email: true, sms: false, push: false, pushKey: null },
        messages: { enabled: true },
        timezone: 'America/New_York',
        hub: false,
      }));
    }

    if (url.pathname === '/api/live-messages') {
      const state = buildState(url.origin);
      const json = (status, obj) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); };
      if (!state.id) return json(200, { ok: true, open: false, enabled: true, broadcastId: null, messages: [] });
      if (req.method === 'GET') return json(200, { ok: true, open: true, enabled: true, broadcastId: state.id, messages: notesFor(state.id) });
      return readBody(req).then((b) => {
        const name = String(b.name || '').trim().slice(0, 40);
        const body = String(b.body || '').trim().slice(0, 280);
        if (/https?:\/\/|www\./i.test(`${name} ${body}`)) return json(422, { ok: false, status: 'blocked', error: 'Please leave out links.' });
        const message = { id: `${state.id}-${Date.now().toString(36)}`, name: name || 'A friend', body, at: new Date().toISOString() };
        notesFor(state.id).push(message);
        return json(200, { ok: true, status: 'shown', message });
      });
    }

    next();
  };
}

export default function devLiveMock() {
  return {
    name: 'dev-live-mock',
    hooks: {
      'astro:config:setup': ({ command, updateConfig, logger }) => {
        if (command !== 'dev') return;
        updateConfig({
          vite: {
            plugins: [{
              name: 'soard:dev-live-mock',
              apply: 'serve',
              // Post hook, registered after Astro's own: Astro unshifts a
              // trailing-slash check (which 404s /api/broadcast) to the front
              // of the stack there, so this has to be unshifted after it.
              configureServer(server) {
                return () => {
                  server.middlewares.stack.unshift({ route: '', handle: handler(logger) });
                  logger.info('live banner mock ready: visit /__live/?state=live (or upcoming, starting, replay, off)');
                };
              },
            }],
          },
        });
      },
    },
  };
}
