/**
 * Admin → Articles: the list is in the Resources page's order, dragged into
 * place in one request (functions/api/reorder-content.js).
 *
 *   node --test tests/articles-admin.test.mjs
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createD1 } from './lib/d1-shim.mjs';
import { reorder } from '../functions/api/reorder-content.js';

const article = (o) => ({ title: 'Guide', slug: 'guide', tag: 'Accessibility', body: '<p>Text</p>', faqs: [], order: 0, ...o });

test('reorder articles: one request writes `order` for the movers, nothing else', async () => {
  const DB = await createD1({ schemaFiles: ['scripts/schema.sql'] });
  for (const a of [article({ slug: 'a', title: 'A', order: 1 }), article({ slug: 'b', title: 'B', order: 2 }), article({ slug: 'c', title: 'C', order: 3 })]) {
    await DB.prepare('INSERT INTO articles (slug, title, order_num, data) VALUES (?, ?, ?, ?)').bind(a.slug, a.title, a.order, JSON.stringify(a)).run();
  }
  const r = await reorder({ DB }, { collection: 'articles', items: [{ slug: 'c', order: 1 }, { slug: 'a', order: 2 }, { slug: 'b', order: 3 }] }, 'staff@example.org');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.changed.sort(), ['a', 'b', 'c']);
  const row = (s) => DB.prepare('SELECT order_num, data FROM articles WHERE slug = ?').bind(s).first();
  assert.equal(JSON.parse((await row('c')).data).order, 1);
  assert.equal((await row('c')).order_num, 1, 'the indexed column follows');
  assert.equal(JSON.parse((await row('b')).data).body, '<p>Text</p>', 'the rest of the article stays');
  const audit = (await DB.prepare("SELECT entity_type, entity_name FROM audit_log WHERE entity_slug = 'c'").first());
  assert.deepEqual({ ...audit }, { entity_type: 'articles', entity_name: 'C' }, 'Publish lists the move under the article’s title');
});
