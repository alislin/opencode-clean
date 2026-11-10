import fs from "node:fs";

const MB = 1024 * 1024;

/**
 * Physical health report (the ocdbc-style measurement):
 * file size vs live data vs freelist ("empty space") pages.
 */
export function freelistReport(db, dbPath) {
  const pageSize = db.prepare("PRAGMA page_size").get().page_size;
  const pageCount = db.prepare("PRAGMA page_count").get().page_count;
  const freelistCount = db.prepare("PRAGMA freelist_count").get().freelist_count;
  const journalRow = db.prepare("PRAGMA journal_mode").get();
  const autoVacuum = db.prepare("PRAGMA auto_vacuum").get().auto_vacuum;
  const fileBytes = fs.existsSync(dbPath) ? fs.statSync(dbPath).size : pageCount * pageSize;
  const liveBytes = (pageCount - freelistCount) * pageSize;
  const freelistBytes = freelistCount * pageSize;
  return {
    fileBytes,
    pageSize,
    pageCount,
    freelistCount,
    liveBytes,
    freelistBytes,
    freelistPct: pageCount > 0 ? (freelistCount / pageCount) * 100 : 0,
    journalMode: Object.values(journalRow)[0],
    autoVacuum,
  };
}

/** Row counts for the interesting tables (missing tables reported as null). */
export function tableCounts(db, tables) {
  const wanted = ["session", "message", "part", "session_v2", "session_message", "blob"];
  const out = {};
  for (const t of wanted) {
    out[t] = tables.has(t)
      ? db.prepare(`SELECT COUNT(*) c FROM "${t}"`).get().c
      : null;
  }
  return out;
}

/** Most recent write timestamp across current (v2) and legacy message tables. */
export function lastWriteAt(db, tables) {
  let latest = 0;
  for (const t of ["session_message", "message"]) {
    if (!tables.has(t)) continue;
    const m = db.prepare(`SELECT MAX(time_updated) m FROM "${t}"`).get().m;
    if (typeof m === "number" && m > latest) latest = m;
  }
  return latest || null;
}

/**
 * Decide whether a full VACUUM is worth its cost (~2x db size of temp IO).
 * - always worthwhile right after we deleted rows (freelist grew)
 * - otherwise only when the freelist share is significant
 */
export function vacuumDecision(report, { purgedBytes = 0, freelistPct = 20, freelistMB = 100, force = false } = {}) {
  if (force) return { should: true, reason: "forced via --force-vacuum" };
  if (purgedBytes > 0) return { should: true, reason: `purge freed ${purgedBytes} bytes (freelist grew)` };
  if (report.freelistPct >= freelistPct) {
    return { should: true, reason: `freelist is ${report.freelistPct.toFixed(1)}% of file (>= ${freelistPct}%)` };
  }
  if (report.freelistBytes >= freelistMB * MB) {
    return { should: true, reason: `freelist is ${(report.freelistBytes / MB).toFixed(0)} MB (>= ${freelistMB} MB)` };
  }
  return { should: false, reason: `freelist ${report.freelistPct.toFixed(1)}% / ${(report.freelistBytes / MB).toFixed(1)} MB below thresholds — VACUUM not worth the IO` };
}
