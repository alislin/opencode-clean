import { spawnSync } from "node:child_process";
import { countOf } from "./db.js";

/**
 * Running-state detection (three levels, cheapest first):
 *
 * 1. Process detection   — is an opencode binary alive? (best effort, per OS)
 * 2. DB activity probe   — recent writes into session_message/message and
 *                          recently busy session_v2 rows prove "executing".
 * 3. Quiescence probe    — PRAGMA wal_checkpoint(TRUNCATE) succeeds only when
 *                          no other connection holds the database; used to
 *                          gate the physical phase (backup + VACUUM).
 */

const WIN_IMAGE_NAMES = /"(?:[^"]*\\)?opencode[^"]*\.exe"/i;

/** Is an OpenCode process running? Never matches this script's own process. */
export function detectProcessRunning({ platform = process.platform, selfPid = process.pid, parentPid = process.ppid, exec = spawnSync } = {}) {
  try {
    if (platform === "win32") {
      const r = exec("tasklist", ["/FO", "CSV", "/NH"], { windowsHide: true });
      if (r.status !== 0 || !r.stdout) return false;
      return r.stdout
        .toString()
        .split("\n")
        .some((line) => WIN_IMAGE_NAMES.test(line.trim()));
    }
    // posix: match command lines, then exclude our own process
    const r = exec("pgrep", ["-f", "opencode"], { windowsHide: true });
    if (r.status !== 0 || !r.stdout) return false;
    const pids = r.stdout
      .toString()
      .split("\n")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
    return pids.some((pid) => pid !== selfPid && pid !== parentPid);
  } catch {
    return false; // tool missing => assume not running, other probes still apply
  }
}

/** Is OpenCode actively executing right now? (recent DB writes / busy markers) */
export function dbActivity(db, tables, { now = Date.now(), windowMs = 120000 } = {}) {
  let recentWrites = 0;
  let lastWriteAgoSec = null;
  for (const t of ["session_message", "message"]) {
    if (!tables.has(t)) continue;
    const r = db.prepare(`SELECT COUNT(*) c, MAX(time_updated) m FROM "${t}" WHERE time_updated >= ?`).get(now - windowMs);
    recentWrites += r.c;
    if (typeof r.m === "number") {
      const ago = (now - r.m) / 1000;
      if (lastWriteAgoSec === null || ago < lastWriteAgoSec) lastWriteAgoSec = ago;
    }
  }
  let busySessions = 0;
  if (tables.has("session_v2")) {
    busySessions = countOf(db, "SELECT COUNT(*) c FROM session_v2 WHERE time_busy IS NOT NULL AND time_busy >= ?", now - windowMs);
  }
  return { active: recentWrites > 0 || busySessions > 0, recentWrites, lastWriteAgoSec, busySessions };
}

/**
 * Physical-phase gate: succeeds only when no other connection is using the DB.
 * A read-only connection cannot checkpoint — callers must pass a writable one.
 */
export function isDbQuiet(db) {
  try {
    db.exec("PRAGMA busy_timeout = 2000");
    const r = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    db.exec("PRAGMA busy_timeout = 10000");
    return Number(r?.busy) === 0;
  } catch {
    try {
      db.exec("PRAGMA busy_timeout = 10000");
    } catch {
      /* ignore */
    }
    return false;
  }
}

/**
 * Wait for OpenCode to go idle. `check()` returns { idle } and is re-probed
 * every intervalMs until idle or maxWaitMs elapsed. Timeout accounting uses
 * the real wall clock (never an injectable frozen test clock). Sleep is
 * injectable for tests; in production it actually waits.
 */
export async function waitForIdle({ check, intervalMs = 60000, maxWaitMs = 15 * 60000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const start = Date.now();
  for (;;) {
    const { idle } = check();
    if (idle) return { idle: true, waitedMs: Date.now() - start, timedOut: false };
    if (Date.now() - start >= maxWaitMs) return { idle: false, waitedMs: Date.now() - start, timedOut: true };
    await sleep(Math.min(intervalMs, maxWaitMs));
  }
}
