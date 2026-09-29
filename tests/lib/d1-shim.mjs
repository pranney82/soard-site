/**
 * Minimal D1 shim over sql.js (WebAssembly SQLite) for Node tests.
 * Supports the subset the functions use: prepare().bind().first()/all()/run(),
 * batch(), exec(). Positional "?" params only.
 */
import initSqlJs from 'sql.js';
import { readFileSync } from 'node:fs';

export async function createD1({ schemaFiles = [], schemaSql = [] } = {}) {
  const SQL = await initSqlJs();
  const db = new SQL.Database();
  for (const f of schemaFiles) db.exec(readFileSync(f, 'utf8'));
  for (const s of schemaSql) db.exec(s);

  const makeStmt = (sql, params) => ({
    bind: (...p) => makeStmt(sql, p),
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
