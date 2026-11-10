import fs from "node:fs";
import path from "node:path";
import { openDatabase } from "./db.js";

/**
 * The ocdbc-inspired nine-step physical maintenance sequence.
 * Order is the point: checkpoint before backup means the .db file contains
 * all committed WAL data; verifying the backup means the fallback is real;
 * auto_vacuum=INCREMENTAL during the rebuild means future free pages can be
 * reclaimed cheaply. VACUUM may reset journal mode, so WAL is restored after.
 */

const MB = 1024 * 1024;

export class VacuumError extends Error {
  constructor(step, cause) {
    super(`vacuum step "${step}" failed: ${cause?.message ?? cause}`);
    this.name = "VacuumError";
    this.step = step;
    this.cause = cause;
  }
}

export function freeDiskBytes(dir, { statfs = fs.statfsSync } = {}) {
  try {
    const s = statfs(dir);
    return s.bavail * s.bsize;
  } catch {
    return Number.MAX_SAFE_INTEGER; // unknown => assume enough, backup step will surface real errors
  }
}

/**
 * Run the full sequence against dbPath.
 * Caller must already have verified: OpenCode not running / DB quiet.
 * deps are injectable for tests (open, copyFile, statfs, unlink, readdir...).
 */
export function runVacuumSequence(
  dbPath,
  { backupDir, keepBackups = 1, makeBackup = true, now = Date.now, logger = () => {} } = {},
  deps = {},
) {
  const open = deps.open ?? openDatabase;
  const copyFile = deps.copyFile ?? fs.copyFileSync;
  const steps = [];
  const record = (name, ok, detail = "") => {
    steps.push({ name, ok, detail });
    logger(`  [vacuum] ${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
    if (!ok) throw new VacuumError(name, new Error(detail || "step failed"));
  };

  let db = null;
  let backupPath = null;
  let beforeBytes = 0;

  try {
    // 1. checkpoint WAL so the main file holds every committed transaction
    db = open(dbPath, { readOnly: false });
    db.exec("PRAGMA busy_timeout = 2000");
    const ck = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get();
    db.exec("PRAGMA busy_timeout = 10000");
    record("wal-checkpoint", Number(ck?.busy) === 0, ck ? `busy=${ck.busy}` : "");
    // measure only after the checkpoint: in WAL mode the main file may lag behind
    beforeBytes = fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0;
    const pageSize = db.prepare("PRAGMA page_size").get().page_size;
    const beforePages = db.prepare("PRAGMA page_count").get().page_count;

    // 2. integrity before touching anything
    const ic1 = db.prepare("PRAGMA integrity_check").get();
    record("integrity-before", Object.values(ic1)[0] === "ok");

    // 3+4. backup, then verify the backup independently
    if (makeBackup) {
      fs.mkdirSync(backupDir, { recursive: true });
      const ts = new Date(now()).toISOString().replace(/[:.]/g, "-").slice(0, 19);
      backupPath = path.join(backupDir, `opencode-${ts}.db`);
      db.close();
      db = null;
      copyFile(dbPath, backupPath);
      const bdb = open(backupPath, { readOnly: true });
      const bic = bdb.prepare("PRAGMA integrity_check").get();
      const okBackup = Object.values(bic)[0] === "ok";
      bdb.close();
      record("backup", fs.existsSync(backupPath), backupPath);
      record("backup-verify", okBackup);
      db = open(dbPath, { readOnly: false });
    } else {
      record("backup", true, "skipped (--no-backup)");
      record("backup-verify", true, "skipped");
    }

    // 5. incremental auto-vacuum takes effect with the rebuild in step 6
    try {
      db.exec("PRAGMA auto_vacuum = INCREMENTAL");
      db.exec("VACUUM");
      record("vacuum", true);
    } catch (err) {
      record("vacuum", false, err.message);
    }

    // 7. VACUUM can reset journal mode — restore WAL
    try {
      db.exec("PRAGMA journal_mode = WAL");
      const jm = Object.values(db.prepare("PRAGMA journal_mode").get())[0];
      record("journal-wal", jm === "wal", jm);
    } catch (err) {
      record("journal-wal", false, err.message);
    }

    // 8. integrity after
    let ic2;
    try {
      ic2 = db.prepare("PRAGMA integrity_check").get();
    } catch (err) {
      record("integrity-after", false, err.message);
    }
    record("integrity-after", Object.values(ic2)[0] === "ok");

    // 9. rotate backups: keep the newest keepBackups files
    let removed = [];
    try {
      const files = fs
        .readdirSync(backupDir)
        .filter((f) => /^opencode-\d{4}-\d{2}-\d{2}T.*\.db$/.test(f))
        .sort()
        .reverse();
      removed = files.slice(keepBackups);
      for (const f of removed) fs.rmSync(path.join(backupDir, f), { force: true });
      record("backup-rotate", true, removed.length ? `removed ${removed.length} old` : "nothing to remove");
    } catch {
      record("backup-rotate", true, "no backup dir");
    }

    const autoVac = db.prepare("PRAGMA auto_vacuum").get().auto_vacuum;
    const afterPages = db.prepare("PRAGMA page_count").get().page_count;
    // close before measuring: on Windows statSync of an open handle can lag
    db.close();
    db = null;
    const afterBytes = fs.statSync(dbPath).size;
    // page accounting is authoritative; OS stat can lag while handles are open
    const freedBytes = (beforePages - afterPages) * pageSize;
    return { steps, backupPath, beforeBytes, afterBytes, freedBytes, autoVacuum: autoVac, removedBackups: removed.length };
  } catch (err) {
    const isVacuumError = err instanceof VacuumError;
    if (!isVacuumError) {
      // figure out which step we were in from the last record
      steps.push({ name: "unexpected", ok: false, detail: err.message });
    }
    throw isVacuumError ? err : new VacuumError("unexpected", err);
  } finally {
    try {
      db?.close();
    } catch {
      /* already closed */
    }
  }
}
