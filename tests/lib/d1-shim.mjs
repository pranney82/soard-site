/**
 * Minimal D1 shim over sql.js (WebAssembly SQLite) for Node tests.
 * Supports the subset the functions use: prepare().bind().first()/all()/run(),
 * batch(), exec(). Positional "?" params only.
 */
import initSqlJs from 'sql.js';
import { readFileSync } from 'node:fs';

// D1 refuses a LIKE pattern over 50 bytes ("LIKE or GLOB pattern too complex").
// Plain SQLite allows 50,000, so the shim checks bound patterns the way D1 would.
const LIKE_MAX = 50;
function checkLikePatterns(sql, params) {
  if (!/\bLIKE\s+\?/i.test(sql)) return;
  const marks = [...sql.matchAll(/\?/g)].map((m) => m.index);
  for (const m of sql.matchAll(/\bLIKE\s+\?/gi)) {
    const v = params[marks.indexOf(m.index + m[0].length - 1)];
    if (typeof v === 'string' && new TextEncoder().encode(v).length > LIKE_MAX) throw new Error('LIKE or GLOB pattern too complex: SQLITE_ERROR');
  }
}

export async function createD1({ schemaFiles = [], schemaSql = [] } = {}) {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  for (const f of schemaFiles) db.exec(readFileSync(f, 'utf8'));
  for (const s of schemaSql) db.exec(s);

  const makeStmt = (sql, params) => ({
    bind: (...p) => { checkLikePatterns(sql, p); return makeStmt(sql, p); },
    async first(col) {
      const st = db.prepare(sql);
      st.bind(params);
      const row = st.step() ? st.getAsObject() : null;
      st.free();
      if (!row) return null;
      return col ? row[col] : row;
    },
    async all() {
      const st = db.prepare(sql);
      st.bind(params);
      const results = [];
      while (st.step()) results.push(st.getAsObject());
      st.free();
      return { results, success: true, meta: {} };
    },
    async run() {
      db.run(sql, params);
      return { success: true, meta: { changes: db.getRowsModified() } };
    },
  });

  return {
    prepare: (sql) => makeStmt(sql, []),
    async batch(stmts) { const out = []; for (const s of stmts) out.push(await s.run()); return out; },
    async exec(sql) { db.exec(sql); return { count: 1 }; },
    _db: db,
  };
}
