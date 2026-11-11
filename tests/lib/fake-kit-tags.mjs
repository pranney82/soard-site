/**
 * Kit's tags, for a test's pretend Kit: listing them, making one, tagging and
 * untagging a subscriber, and a subscriber's own tags. The reveal sign-up tags
 * (functions/api/_reveal-signups.js) are made the first time they're needed,
 * as the real Kit allows. Use: `const tags = fakeKitTags(); … const hit = await tags.answer(url, method, body); if (hit) return hit;`
 */
export function fakeKitTags({ start = 70000, tags = [], idOf = () => 0 } = {}) {
  // idOf: a subscriber's id from their address, for tagging by email_address as Kit allows
  const list = tags.map((t) => ({ subscriber_count: 0, ...t }));
  const members = new Map(); // tag id → Set of subscriber ids
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
  const byName = (name) => list.find((t) => t.name.toLowerCase() === String(name).toLowerCase());
  return {
    list,
    members,
    byName,
    /** Who has this tag, by subscriber id */
    has: (name) => [...(members.get(Number(byName(name)?.id)) || [])],
    async answer(url, method, body) {
      const path = String(url).replace('https://api.kit.com/v4', '');
      if (path === '/tags' && method === 'POST') {
        const t = byName(body?.name) || { id: start + list.length, name: body.name, subscriber_count: 0 };
        if (!list.includes(t)) list.push(t);
        return json({ tag: t }, 201);
      }
      if (/^\/tags(\?|$)/.test(path) && method === 'GET') return json({ tags: list, pagination: { has_next_page: false } });
      let m = path.match(/^\/tags\/(\d+)\/subscribers(?:\/(\d+))?$/);
      if (m) {
        const set = members.get(Number(m[1])) || new Set();
        members.set(Number(m[1]), set);
        const sub = Number(m[2] || body?.id || idOf(body?.email_address) || 0);
        if (method === 'DELETE') { set.delete(sub); return new Response(null, { status: 204 }); }
        if (method === 'POST') { set.add(sub); return json({ subscriber: { id: sub } }, 201); }
      }
      m = path.match(/^\/subscribers\/(\d+)\/tags/);
      if (m && method === 'GET') return json({ tags: list.filter((t) => members.get(Number(t.id))?.has(Number(m[1]))), pagination: { has_next_page: false } });
      return null;
    },
  };
}
