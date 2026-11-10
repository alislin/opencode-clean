import { countOf } from "./db.js";

/**
 * Semantic purge. Two targets:
 *
 * 1. Legacy schema (session/message/part/...) — frozen since OpenCode migrated
 *    to session_v2. We only delete legacy rows whose id has a session_v2 copy,
 *    so nothing is lost. ~15 legacy sessions without a copy are kept.
 * 2. Current schema subagents — session_v2 rows with parent_id that were last
 *    updated before the retention cutoff. Suspended sessions are never touched.
 *
 * The same WHERE predicates drive both the preview (SELECT COUNT) and the
 * deletion (DELETE ... WHERE id IN (SELECT ...)), so dry-run numbers always
 * match what a real run would delete.
 */

const MB = 1024 * 1024;

function legacyIdSelect(hasV2) {
  return hasV2
    ? "SELECT s.id FROM session s WHERE s.id IN (SELECT id FROM session_v2)"
    : "SELECT s.id FROM session s WHERE 0";
}


function v2IdSelect(cutoff) {
  // parameterized; callers must bind cutoff
  return "SELECT id FROM session_v2 WHERE parent_id IS NOT NULL AND time_updated < ? AND time_suspended IS NULL";
}

/** Build the full plan with counts and byte estimates. Pure SELECT — safe on read-only connections. */
export function purgePlan(db, tables, { cutoff }) {
  const plan = { legacy: null, v2: null };

  const hasLegacy = tables.has("session") && tables.has("message") && tables.has("part");
  const hasV2 = tables.has("session_v2");

  if (hasLegacy) {
    const ids = legacyIdSelect(hasV2);
    plan.legacy = {
      sessions: countOf(db, `SELECT COUNT(*) c FROM (${ids})`),
      message: tables.has("message") ? countOf(db, `SELECT COUNT(*) c FROM message WHERE session_id IN (${ids})`) : null,
      part: tables.has("part") ? countOf(db, `SELECT COUNT(*) c FROM part WHERE session_id IN (${ids})`) : null,
      todo: tables.has("todo") ? countOf(db, `SELECT COUNT(*) c FROM todo WHERE session_id IN (${ids})`) : null,
      session_share: tables.has("session_share") ? countOf(db, `SELECT COUNT(*) c FROM session_share WHERE session_id IN (${ids})`) : null,
      event: tables.has("event") ? countOf(db, `SELECT COUNT(*) c FROM event WHERE aggregate_id IN (${ids})`) : null,
      event_sequence: tables.has("event_sequence") ? countOf(db, `SELECT COUNT(*) c FROM event_sequence WHERE aggregate_id IN (${ids})`) : null,
      bytes:
        countOf(db, `SELECT COALESCE(SUM(COALESCE(LENGTH(data),0)),0) c FROM (${ids}) x JOIN message m ON m.session_id = x.id`) +
        countOf(db, `SELECT COALESCE(SUM(COALESCE(LENGTH(data),0)),0) c FROM (${ids}) x JOIN part p ON p.session_id = x.id`),
    };
  }

  if (hasV2) {
    const ids = v2IdSelect(cutoff);
    plan.v2 = {
      sessions: countOf(db, `SELECT COUNT(*) c FROM (${ids})`, cutoff),
      session_message: tables.has("session_message") ? countOf(db, `SELECT COUNT(*) c FROM session_message WHERE session_id IN (${ids})`, cutoff) : null,
      session_part: tables.has("session_part") ? countOf(db, `SELECT COUNT(*) c FROM session_part WHERE session_id IN (${ids})`, cutoff) : null,
      session_inbox: tables.has("session_inbox") ? countOf(db, `SELECT COUNT(*) c FROM session_inbox WHERE session_id IN (${ids})`, cutoff) : null,
      instruction_entry: tables.has("instruction_entry") ? countOf(db, `SELECT COUNT(*) c FROM instruction_entry WHERE session_id IN (${ids})`, cutoff) : null,
      instruction_state: tables.has("instruction_state") ? countOf(db, `SELECT COUNT(*) c FROM instruction_state WHERE session_id IN (${ids})`, cutoff) : null,
      blob_ref: tables.has("blob_ref") ? countOf(db, `SELECT COUNT(*) c FROM blob_ref WHERE session_id IN (${ids})`, cutoff) : null,
      blob_orphan:
        tables.has("blob") && tables.has("blob_ref")
          ? countOf(
              db,
              // blobs that will have no remaining refs after the purge's blob_refs are gone
              `SELECT COUNT(*) c FROM blob WHERE hash NOT IN (SELECT hash FROM blob_ref WHERE session_id NOT IN (${ids}))`,
              cutoff,
            )
          : null,
      job:
        tables.has("job")
          ? countOf(db, `SELECT COUNT(*) c FROM job WHERE session_id IN (${ids}) OR child_session_id IN (${ids})`, cutoff, cutoff)
          : null,
      schedule: tables.has("schedule") ? countOf(db, `SELECT COUNT(*) c FROM schedule WHERE session_id IN (${ids})`, cutoff) : null,
      bytes:
        countOf(db, `SELECT COALESCE(SUM(COALESCE(LENGTH(data),0)),0) c FROM (${ids}) x JOIN session_message m ON m.session_id = x.id`, cutoff),
    };
  }

  plan.totalRows = sumRows(plan);
  plan.totalBytes = plan.legacy?.bytes + plan.v2?.bytes || 0;
  return plan;
}

function sumRows(plan) {
  let n = 0;
  for (const group of [plan.legacy, plan.v2]) {
    if (!group) continue;
    for (const [k, v] of Object.entries(group)) {
      if (k !== "bytes" && typeof v === "number") n += v;
    }
  }
  return n;
}

/**
 * Execute the purge. With dryRun=true this is exactly purgePlan (no writes).
 * With dryRun=false it runs the deletions in one transaction, children first.
 */
export function executePurge(db, tables, { cutoff, dryRun }) {
  if (dryRun) return { plan: purgePlan(db, tables, { cutoff }), executed: false };

  const stats = [];
  const step = (label, sql, ...params) => {
    const info = db.prepare(sql).run(...params);
    stats.push({ target: label, rows: info.changes });
    return info.changes;
  };
  const bytesOf = (sql, ...params) => db.prepare(sql).get(...params)?.c ?? 0;

  db.exec("BEGIN IMMEDIATE");
  try {
    const hasLegacy = tables.has("session") && tables.has("message") && tables.has("part");
    const hasV2 = tables.has("session_v2");

    // ---- legacy schema (children first) ----
    if (hasLegacy) {
      const ids = legacyIdSelect(hasLegacy && hasV2);
      const bytes =
        bytesOf(`SELECT COALESCE(SUM(COALESCE(LENGTH(data),0)),0) c FROM (${ids}) x JOIN message m ON m.session_id = x.id`) +
        bytesOf(`SELECT COALESCE(SUM(COALESCE(LENGTH(data),0)),0) c FROM (${ids}) x JOIN part p ON p.session_id = x.id`);
      let rows = 0;
      if (tables.has("part")) rows += step("legacy:part", `DELETE FROM part WHERE session_id IN (${ids})`);
      if (tables.has("message")) rows += step("legacy:message", `DELETE FROM message WHERE session_id IN (${ids})`);
      if (tables.has("todo")) rows += step("legacy:todo", `DELETE FROM todo WHERE session_id IN (${ids})`);
      if (tables.has("session_share")) rows += step("legacy:session_share", `DELETE FROM session_share WHERE session_id IN (${ids})`);
      if (tables.has("event")) rows += step("legacy:event", `DELETE FROM event WHERE aggregate_id IN (${ids})`);
      if (tables.has("event_sequence")) rows += step("legacy:event_sequence", `DELETE FROM event_sequence WHERE aggregate_id IN (${ids})`);
      rows += step("legacy:session", `DELETE FROM session WHERE id IN (${ids})`);
      stats.push({ target: "legacy:total", rows, bytes });
    }

    // ---- current schema subagents (children first) ----
    if (hasV2) {
      const ids = v2IdSelect(cutoff);
      const bytes = bytesOf(
        `SELECT COALESCE(SUM(COALESCE(LENGTH(data),0)),0) c FROM (${ids}) x JOIN session_message m ON m.session_id = x.id`,
        cutoff,
      );
      let rows = 0;
      if (tables.has("session_part")) rows += step("v2:session_part", `DELETE FROM session_part WHERE session_id IN (${ids})`, cutoff);
      if (tables.has("session_message")) rows += step("v2:session_message", `DELETE FROM session_message WHERE session_id IN (${ids})`, cutoff);
      if (tables.has("session_inbox")) rows += step("v2:session_inbox", `DELETE FROM session_inbox WHERE session_id IN (${ids})`, cutoff);
      if (tables.has("instruction_entry")) rows += step("v2:instruction_entry", `DELETE FROM instruction_entry WHERE session_id IN (${ids})`, cutoff);
      if (tables.has("instruction_state")) rows += step("v2:instruction_state", `DELETE FROM instruction_state WHERE session_id IN (${ids})`, cutoff);
      if (tables.has("blob_ref")) rows += step("v2:blob_ref", `DELETE FROM blob_ref WHERE session_id IN (${ids})`, cutoff);
      if (tables.has("blob")) rows += step("v2:blob_orphan", `DELETE FROM blob WHERE hash NOT IN (SELECT hash FROM blob_ref)`);
      if (tables.has("job"))
        rows += step("v2:job", `DELETE FROM job WHERE session_id IN (${ids}) OR child_session_id IN (${ids})`, cutoff, cutoff);
      if (tables.has("schedule")) rows += step("v2:schedule", `DELETE FROM schedule WHERE session_id IN (${ids})`, cutoff);
      rows += step("v2:session", `DELETE FROM session_v2 WHERE id IN (${ids})`, cutoff);
      stats.push({ target: "v2:total", rows, bytes });
    }

    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }

  const total = stats.filter((s) => s.target.endsWith(":total"));
  return {
    executed: true,
    plan: null,
    stats,
    totalRows: total.reduce((a, s) => a + s.rows, 0),
    totalBytes: total.reduce((a, s) => a + s.bytes, 0),
  };
}

export function formatMB(bytes) {
  return (bytes / MB).toFixed(1);
}
