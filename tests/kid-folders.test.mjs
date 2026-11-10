/**
 * Dropbox folders to name (functions/api/_kid-folders.js, kid-folders-admin.js):
 * the list with its guesses, unanswered first; an answer checked and saved with
 * who and when; clearing it; and nothing saved for a folder not on the list.
 * All names are made up.
 * Run: node --test tests/
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { guessesFor, checkAnswer, dropboxUrl, ensureKidFolders } from '../functions/api/_kid-folders.js';
import { onRequestGet, onRequestPost } from '../functions/api/kid-folders-admin.js';

const KIDS = [
  { slug: 'ellie-2022', name: 'Ellie', year: 2022 },
  { slug: 'ellie', name: 'Ellie', year: 2023 },
  { slug: 'grace-2016', name: 'Grace', year: 2016 },
  { slug: 'marco', name: 'Marco & Lia', year: 2021 },
];
let env;
beforeEach(async () => {
  env = { DB: await createD1({ schemaFiles: ['scripts/schema.sql'] }) };
  for (const k of KIDS) await env.DB.prepare('INSERT INTO kids (slug, name, year, data, updated_at) VALUES (?, ?, ?, ?, ?)').bind(k.slug, k.name, k.year, JSON.stringify({ name: k.name, year: k.year }), '2026-11-10T00:00:00Z').run();
  await ensureKidFolders(env.DB);
  for (const [f, p, v] of [['Ellie Grant 2023', 181, 4], ['Zed Story 2014', 49, 0], ['Lia 2021', 73, 2]]) {
    await env.DB.prepare('INSERT INTO kid_folders (folder, photos, videos, created_at) VALUES (?, ?, ?, ?)').bind(f, p, v, '2026-11-10T00:00:00Z').run();
  }
});
const get = async () => (await onRequestGet({ env, data: {} })).json();
const post = async (body, who = 'linzi@example.org') => {
  const res = await onRequestPost({ env, data: { userEmail: who }, request: new Request('https://x/api/kid-folders-admin', { method: 'POST', body: JSON.stringify(body) }) });
  return { status: res.status, body: await res.json() };
};

test('guesses: the folder’s first name on a page within a year, closest year first', () => {
  assert.deepEqual(guessesFor('Ellie Grant 2023', KIDS).map((k) => k.slug), ['ellie', 'ellie-2022']);
  assert.deepEqual(guessesFor('Lia 2021', KIDS).map((k) => k.slug), ['marco'], 'a sibling named on a shared page');
  assert.deepEqual(guessesFor('Zed Story 2014', KIDS), []);
  assert.equal(dropboxUrl('Ellie Grant 2023'), 'https://www.dropbox.com/home/SOARD-Main/Makeover%20Photos/Ellie%20Grant%202023');
});

test('the list: every folder with its counts, Dropbox link and guesses, unanswered first; the kid pages to pick from', async () => {
  const r = await get();
  assert.equal(r.success, true);
  assert.deepEqual(r.folders.map((f) => [f.folder, f.photos, f.videos, f.decision]), [['Ellie Grant 2023', 181, 4, null], ['Lia 2021', 73, 2, null], ['Zed Story 2014', 49, 0, null]]);
  assert.match(r.folders[0].url, /dropbox\.com\/home\/SOARD-Main\/Makeover%20Photos\/Ellie%20Grant%202023$/);
  assert.deepEqual(r.kids.map((k) => k.slug), ['ellie-2022', 'ellie', 'grace-2016', 'marco']);
});

test('an answer is checked, saved with who and when, and moves the folder to the end; clearing it puts it back', async () => {
  assert.equal((await post({ folder: 'Ellie Grant 2023', decision: 'kid', kidSlug: 'nobody' })).status, 400);
  const saved = await post({ folder: 'Ellie Grant 2023', decision: 'kid', kidSlug: 'ellie' });
  assert.equal(saved.status, 200);
  assert.deepEqual([saved.body.folder.decision, saved.body.folder.kidSlug, saved.body.folder.decidedBy], ['kid', 'ellie', 'linzi@example.org']);
  assert.ok(saved.body.folder.decidedAt);
  const newKid = await post({ folder: 'Zed Story 2014', decision: 'new', newName: 'Zed Story', newYear: 2014 });
  assert.deepEqual([newKid.body.folder.newName, newKid.body.folder.newYear], ['Zed Story', 2014]);
  assert.equal((await post({ folder: 'Lia 2021', decision: 'new', newName: 'Lia', newYear: 1999 })).status, 400, 'a year that can’t be a makeover');
  assert.equal((await post({ folder: 'Lia 2021', decision: 'not', note: 'Event photos' })).body.folder.note, 'Event photos');
  assert.deepEqual((await get()).folders.map((f) => [f.folder, f.decision]), [['Ellie Grant 2023', 'kid'], ['Lia 2021', 'not'], ['Zed Story 2014', 'new']]);
  const cleared = await post({ folder: 'Ellie Grant 2023', decision: null });
  assert.deepEqual([cleared.body.folder.decision, cleared.body.folder.decidedBy, cleared.body.folder.kidSlug], [null, null, null]);
  assert.equal((await get()).folders[0].folder, 'Ellie Grant 2023', 'unanswered again, so first');
});

test('nothing is saved for a folder not on the list', async () => {
  const r = await post({ folder: 'Somebody 2020', decision: 'not' });
  assert.equal(r.status, 404);
  assert.deepEqual(checkAnswer({ decision: 'kid' }, KIDS), { ok: false, error: 'Which folder?' });
});
