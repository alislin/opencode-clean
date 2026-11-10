import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { makeTempDir, createFixtureDb, NOW, DAY } from "./helpers/fixture.js";
import { parseArgs, DEFAULTS, loadConfig, saveConfig } from "../lib/config.js";
import { isStale, saveState } from "../lib/report.js";
import { runClean, resolvePaths } from "../lib/cli.js";

const cleanup = (dir) => fs.rmSync(dir, { recursive: true, force: true });

// ---------- parseArgs ----------

test("parseArgs defaults: dry-run on, no --yes", () => {
  const o = parseArgs([]);
  assert.equal(o.dryRun, true);
  assert.equal(o.yes, false);
  assert.equal(o.days, DEFAULTS.days);
  assert.equal(o.snapshots, false);
  assert.equal(o.orphans, true);
  assert.equal(o.json, false);
});

test("parseArgs: --yes flips dry-run off", () => {
  const o = parseArgs(["--yes"]);
  assert.equal(o.dryRun, false);
  assert.equal(o.yes, true);
});

test("parseArgs: explicit --dry-run always wins over --yes", () => {
  assert.equal(parseArgs(["--yes", "--dry-run"]).dryRun, true);
  assert.equal(parseArgs(["--dry-run", "--yes"]).dryRun, true);
});

test("parseArgs: numeric flags", () => {
  assert.equal(parseArgs(["--days", "7"]).days, 7);
  assert.equal(parseArgs(["--wait-minutes", "5"]).waitMinutes, 5);
  assert.throws(() => parseArgs(["--days"]), /requires a positive number/);
  assert.throws(() => parseArgs(["--days", "abc"]), /requires a positive number/);
});

test("parseArgs: paths and boolean switches", () => {
  const o = parseArgs(["--db", "C:\\x.db", "--data-dir", "C:\\d", "--snapshots", "--no-orphans", "--no-notify", "--if-stale", "--force-vacuum", "--json"]);
  assert.equal(o.db, "C:\\x.db");
  assert.equal(o.dataDir, "C:\\d");
  assert.equal(o.snapshots, true);
  assert.equal(o.orphans, false);
  assert.equal(o.notify, false);
  assert.equal(o.ifStale, true);
  assert.equal(o.forceVacuum, true);
  assert.equal(o.json, true);
});

test("parseArgs: unknown flag throws with the flag name", () => {
  assert.throws(() => parseArgs(["--bogus"]), /--bogus/);
});

// ---------- config ----------

test("loadConfig falls back to defaults on missing/broken file; saveConfig persists a patch", () => {
  const dir = makeTempDir();
  assert.deepEqual(loadConfig(dir), DEFAULTS);
  fs.writeFileSync(path.join(dir, "config.json"), "{ broken json");
  assert.deepEqual(loadConfig(dir), DEFAULTS);
  const next = saveConfig(dir, { days: 90 });
  assert.equal(next.days, 90);
  assert.equal(loadConfig(dir).days, 90);
  assert.equal(loadConfig(dir).waitMinutes, DEFAULTS.waitMinutes, "untouched keys keep defaults");
  cleanup(dir);
});

// ---------- runClean (integration on a fixture db) ----------

test("runClean dry-run: preview report, SUCCESS, no mutations", async () => {
  const dir = makeTempDir();
  const dataDir = path.join(dir, "data");
  const { db, dbPath } = createFixtureDb(dir);
  const before = ["session", "message", "part", "session_v2", "session_message", "blob", "job", "schedule"].map((t) => db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c);

  const rep = await runClean(
    { dryRun: true, json: true, db: dbPath, dataDir },
    { log: () => {}, now: () => NOW },
  );
  assert.equal(rep.state, "SUCCESS");
  assert.equal(rep.exitCode, 0);
  assert.equal(rep.json.preview.totalRows, 30);
  assert.equal(rep.json.mode, "PREVIEW");

  const after = ["session", "message", "part", "session_v2", "session_message", "blob", "job", "schedule"].map((t) => db.prepare(`SELECT COUNT(*) c FROM ${t}`).get().c);
  assert.deepEqual(after, before, "dry-run must not mutate");
  assert.ok(fs.existsSync(path.join(dataDir, "last-report.txt")), "report artifact written");
  assert.ok(!fs.existsSync(path.join(dataDir, "clean.log")), "no log on dry-run");

  db.close();
  cleanup(dir);
});

test("runClean real purge on fixture: deletes rows, writes log/state, PARTIAL when busy times out", async () => {
  const dir = makeTempDir();
  const dataDir = path.join(dir, "data");
  const { db, dbPath } = createFixtureDb(dir);

  const rep = await runClean(
    {
      yes: true,
      dryRun: false,
      json: true,
      db: dbPath,
      dataDir,
      waitMinutes: 0.001, // 60ms real-clock budget
      pollSeconds: 0.005,
      activityWindowSec: 999999999, // fixture's 40d-old writes count as "recent" => never idle
    },
    {
      log: () => {},
      detectProcess: () => true,
      sleep: async () => {},
      now: () => NOW,
    },
  );

  assert.equal(rep.exitCode, 1);
  assert.equal(rep.state, "PARTIAL");
  assert.equal(rep.json.mode, "PURGE_ONLY");
  assert.equal(rep.json.purge.totalRows, 30, "purge still executed");
  assert.equal(db.prepare("SELECT COUNT(*) c FROM session_v2").get().c, 5, "v2 purge applied (kept: Vmain + L1/L2 copies + VsubNew + Vsusp)");
  assert.equal(db.prepare("SELECT COUNT(*) c FROM session").get().c, 1, "legacy purge applied (ses_L3 left)");
  assert.ok(fs.existsSync(path.join(dataDir, "clean.log")), "log written on real run");
  assert.ok(fs.existsSync(path.join(dataDir, "last-report.txt")));
  const st = JSON.parse(fs.readFileSync(path.join(dataDir, "state.json"), "utf8"));
  assert.equal(st.lastState, "PARTIAL", "partial run recorded");
  assert.ok(!st.lastSuccessEnd, "partial run does not count as a success for --if-stale");

  db.close();
  cleanup(dir);
});

test("runClean FULL path with vacuum when nothing is running and freelist is big", async () => {
  const dir = makeTempDir();
  const dataDir = path.join(dir, "data");
  const { db, dbPath } = createFixtureDb(dir, { wal: true });
  // create free pages so the vacuum gate fires after purge
  db.exec("CREATE TABLE junk (data TEXT)");
  const ins = db.prepare("INSERT INTO junk (data) VALUES (?)");
  db.exec("BEGIN");
  for (let i = 0; i < 3000; i++) ins.run("z".repeat(100));
  db.exec("COMMIT");
  db.exec("DELETE FROM junk");
  db.close();

  const rep = await runClean(
    { yes: true, dryRun: false, json: true, db: dbPath, dataDir },
    { log: () => {}, detectProcess: () => false, now: () => NOW },
  );

  assert.equal(rep.state, "SUCCESS");
  assert.equal(rep.exitCode, 0);
  assert.equal(rep.json.mode, "FULL");
  assert.ok(rep.json.vacuum && !rep.json.vacuum.skipped, `vacuum ran (state=${rep.state}, reasons=${JSON.stringify(rep.json.reasons)}, error=${JSON.stringify(rep.json.error)})`);
  assert.ok(rep.json.vacuum.freedBytes > 0, "freelist pages reclaimed");
  assert.ok(fs.existsSync(path.join(dataDir, "backup")), "backup dir created");
  const dbFiles = fs.readdirSync(path.join(dataDir, "backup")).filter((f) => f.endsWith(".db"));
  assert.equal(dbFiles.length, 1, "one rotated backup");

  const { openDatabase } = await import("../lib/db.js");
  const vdb = openDatabase(dbPath, { readOnly: true });
  assert.equal(vdb.prepare("SELECT COUNT(*) c FROM session_v2").get().c, 5, "kept: Vmain + L1/L2 copies + VsubNew + Vsusp");
  assert.equal(Object.values(vdb.prepare("PRAGMA journal_mode").get())[0], "wal");
  vdb.close();
  cleanup(dir);
});

test("runClean PARTIAL when disk space is insufficient for backup+vacuum", async () => {
  const dir = makeTempDir();
  const dataDir = path.join(dir, "data");
  const { db, dbPath } = createFixtureDb(dir, { wal: true });
  db.close();

  const rep = await runClean(
    { yes: true, dryRun: false, json: true, db: dbPath, dataDir, forceVacuum: true },
    { log: () => {}, detectProcess: () => false, now: () => NOW, statfs: () => ({ bavail: 1, bsize: 4096 }) },
  );

  assert.equal(rep.state, "PARTIAL");
  assert.equal(rep.json.vacuum.skipped, true);
  assert.match(rep.json.vacuum.reason, /磁盘剩余/);
  cleanup(dir);
});

test("runClean --if-stale skips when the last success is fresh", async () => {
  const dir = makeTempDir();
  const dataDir = path.join(dir, "data");
  const { db, dbPath } = createFixtureDb(dir);
  saveState(dataDir, { lastSuccessEnd: Date.now() });

  const rep = await runClean({ yes: true, dryRun: false, json: true, db: dbPath, dataDir, ifStale: true }, { log: () => {}, detectProcess: () => false });
  assert.equal(rep.state, "SUCCESS");
  assert.equal(rep.json.mode, "SKIPPED");
  assert.equal(rep.json.purge, undefined, "nothing purged");
  db.close();
  cleanup(dir);
});

test("runClean FAILED when the database file is missing", async () => {
  const dir = makeTempDir();
  const rep = await runClean({ dryRun: true, json: true, db: path.join(dir, "nope.db"), dataDir: path.join(dir, "d") }, { log: () => {} });
  assert.equal(rep.state, "FAILED");
  assert.equal(rep.exitCode, 2);
  cleanup(dir);
});

// ---------- end-to-end smoke via the real bin ----------

test("bin/ocgc-clean.js --dry-run --json against a fixture db (child process)", () => {
  const dir = makeTempDir();
  const dataDir = path.join(dir, "data");
  const { db, dbPath } = createFixtureDb(dir);
  db.close();

  // real clock: fixture data (Nov 2023) is far in the past, so --days 1 makes
  // every non-suspended v2 subagent stale => legacy 18 + v2 14 = 32 rows
  const bin = fileURLToPath(new URL("../bin/ocgc-clean.js", import.meta.url));
  const r = spawnSync(process.execPath, [bin, "--dry-run", "--json", "--days", "1", "--db", dbPath, "--data-dir", dataDir], { encoding: "utf8", timeout: 60000 });
  assert.equal(r.status, 0, `stderr: ${r.stderr}`);
  const json = JSON.parse(r.stdout);
  assert.equal(json.state, "SUCCESS");
  assert.equal(json.preview.totalRows, 32);
  cleanup(dir);
});

test("bin/ocgc-clean.js rejects unknown flags with exit code 2", () => {
  const bin = fileURLToPath(new URL("../bin/ocgc-clean.js", import.meta.url));
  const r = spawnSync(process.execPath, [bin, "--bogus"], { encoding: "utf8", timeout: 30000 });
  assert.equal(r.status, 2);
  assert.ok(r.stderr.includes("--bogus"));
});

test("resolvePaths defaults land in the home directory", () => {
  const p = resolvePaths({});
  assert.ok(p.dataDir.includes(path.join(".opencode", "ocgc")));
  assert.ok(p.dbPath.endsWith(path.join(".local", "share", "opencode", "opencode.db")));
  assert.ok(p.backupDir.startsWith(p.dataDir));
});

test("stale gate cooperates with config staleDays", () => {
  const dir = makeTempDir();
  const now = Date.now();
  saveState(dir, { lastSuccessEnd: now - 3 * DAY });
  assert.equal(isStale(dir, { staleDays: 7, now }), false);
  assert.equal(isStale(dir, { staleDays: 1, now }), true);
  cleanup(dir);
});
