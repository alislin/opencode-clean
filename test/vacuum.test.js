import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createFixtureDb, makeTempDir } from "./helpers/fixture.js";
import { openDatabase } from "../lib/db.js";
import { freelistReport, vacuumDecision } from "../lib/analyze.js";
import { runVacuumSequence, VacuumError, freeDiskBytes } from "../lib/vacuum.js";

let dir, ctx, dbPath, backupDir;

beforeEach(() => {
  dir = makeTempDir();
  ctx = createFixtureDb(dir, { wal: true });
  dbPath = ctx.dbPath;
  backupDir = path.join(dir, "backup");
});

afterEach(() => {
  try {
    ctx.db.close();
  } catch {}
  fs.rmSync(dir, { recursive: true, force: true });
});

function growFreelist(db) {
  db.exec("CREATE TABLE junk (data TEXT)");
  db.exec("BEGIN");
  const ins = db.prepare("INSERT INTO junk (data) VALUES (?)");
  for (let i = 0; i < 3000; i++) ins.run("z".repeat(100));
  db.exec("COMMIT");
  db.exec("DELETE FROM junk"); // ~300KB of free pages, no vacuum
}

test("vacuumDecision: skip when freelist is small and nothing purged", () => {
  const rep = { freelistPct: 0.1, freelistBytes: 4096 };
  const d = vacuumDecision(rep, { purgedBytes: 0 });
  assert.equal(d.should, false);
});

test("vacuumDecision: run after purge, on big freelist pct, on big freelist bytes, on force", () => {
  assert.equal(vacuumDecision({ freelistPct: 0, freelistBytes: 0 }, { purgedBytes: 123 }).should, true);
  assert.equal(vacuumDecision({ freelistPct: 25, freelistBytes: 4096 }, { purgedBytes: 0 }).should, true);
  assert.equal(vacuumDecision({ freelistPct: 1, freelistBytes: 200 * 1024 * 1024 }, { purgedBytes: 0 }).should, true);
  assert.equal(vacuumDecision({ freelistPct: 0, freelistBytes: 0 }, { force: true }).should, true);
});

test("freeDiskBytes returns a sane positive number for a real dir", () => {
  assert.ok(freeDiskBytes(dir) > 0);
});

test("full nine-step sequence: backup created+verified, WAL restored, freelist emptied, rotation keeps 1", async (t) => {
  const db = openDatabase(dbPath);
  growFreelist(db);
  db.close();

  // fake older backups to test rotation
  fs.mkdirSync(backupDir, { recursive: true });
  fs.writeFileSync(path.join(backupDir, "opencode-2020-01-01T00-00-00.db"), "old1");
  fs.writeFileSync(path.join(backupDir, "opencode-2021-01-01T00-00-00.db"), "old2");

  const result = runVacuumSequence(dbPath, { backupDir, keepBackups: 1 });

  const names = result.steps.map((s) => s.name);
  assert.deepEqual(names, [
    "wal-checkpoint",
    "integrity-before",
    "backup",
    "backup-verify",
    "vacuum",
    "journal-wal",
    "integrity-after",
    "backup-rotate",
  ]);
  assert.ok(result.steps.every((s) => s.ok), "all steps ok");

  // backup exists and is a real database (newest one kept)
  const backups = fs.readdirSync(backupDir).filter((f) => f.endsWith(".db")).sort();
  assert.equal(backups.length, 1, "rotation keeps only newest");
  assert.ok(backups[0].startsWith("opencode-20"), "timestamped name");
  const bdb = openDatabase(path.join(backupDir, backups[0]), { readOnly: true });
  assert.equal(Object.values(bdb.prepare("PRAGMA integrity_check").get())[0], "ok");
  bdb.close();

  // physical effects
  assert.equal(result.autoVacuum, 2, "auto_vacuum = INCREMENTAL");
  const db2 = openDatabase(dbPath, { readOnly: true });
  assert.equal(Object.values(db2.prepare("PRAGMA journal_mode").get())[0], "wal", "WAL restored");
  const fl = db2.prepare("PRAGMA freelist_count").get().freelist_count;
  db2.close();
  assert.equal(fl, 0, "freelist reclaimed");
  assert.ok(result.freedBytes > 0, "file actually shrank");
});

test("no-backup mode skips backup steps but still vacuums", () => {
  const db = openDatabase(dbPath);
  growFreelist(db);
  db.close();
  const result = runVacuumSequence(dbPath, { backupDir, makeBackup: false });
  const names = result.steps.map((s) => s.name);
  assert.ok(names.includes("vacuum"));
  const backupStep = result.steps.find((s) => s.name === "backup");
  assert.ok(backupStep.ok && /skipped/.test(backupStep.detail), "backup step recorded as skipped");
  assert.equal(result.backupPath, null);
  assert.ok(!fs.existsSync(backupDir), "no backup dir created");
  assert.ok(result.freedBytes > 0, "vacuum still reclaimed free pages");
});

test("failure mid-sequence: step is named and pre-existing backups are preserved", () => {
  const db = openDatabase(dbPath);
  growFreelist(db);
  db.close();
  fs.mkdirSync(backupDir, { recursive: true });
  fs.writeFileSync(path.join(backupDir, "opencode-2020-01-01T00-00-00.db"), "old1");

  const bombOpen = (p, o) => {
    const real = openDatabase(p, o);
    if (o?.readOnly) return real; // backup-verify still works
    // explicit delegation (a Proxy would break node:sqlite internal slots)
    return {
      exec: (sql) => {
        if (/^VACUUM\b/i.test(sql)) throw new Error("boom during VACUUM");
        return real.exec(sql);
      },
      prepare: (...a) => real.prepare(...a),
      close: (...a) => real.close(...a),
    };
  };

  assert.throws(() => runVacuumSequence(dbPath, { backupDir, keepBackups: 1 }, { open: bombOpen }), (err) => err instanceof VacuumError && err.step === "vacuum");

  // backup made before the failure must still exist (not rotated away)
  const backups = fs.readdirSync(backupDir).filter((f) => f.endsWith(".db"));
  assert.equal(backups.length, 2, "old backup + new backup both preserved");
});

test("freelist report math is internally consistent", () => {
  const db = openDatabase(dbPath);
  growFreelist(db);
  const rep = freelistReport(db, dbPath);
  db.close();
  assert.equal(rep.liveBytes + rep.freelistBytes, rep.pageCount * rep.pageSize);
  assert.ok(rep.freelistPct > 0);
  assert.equal(rep.journalMode, "wal");
});
