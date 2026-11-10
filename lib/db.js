import { DatabaseSync } from "node:sqlite";

/**
 * Open an OpenCode SQLite database.
 * - readOnly connections are used for dry-run/analyze and guarantee no writes.
 * - writable connections get foreign_keys ON and a busy timeout so short
 *   purge transactions coexist with a running OpenCode (WAL mode).
 */
export function openDatabase(dbPath, { readOnly = false, busyTimeoutMs = 10000 } = {}) {
  const db = new DatabaseSync(dbPath, { readOnly });
  db.exec(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  if (!readOnly) db.exec("PRAGMA foreign_keys = ON");
  return db;
}

/** Set of table names present in the database. */
export function existingTables(db) {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all();
  return new Set(rows.map((r) => r.name));
}

export function hasTable(tables, name) {
  return tables.has(name);
}

/** Helper: first cell of a single-row query aliased as c. */
export function countOf(db, sql, ...params) {
  return db.prepare(sql).get(...params)?.c ?? 0;
}
