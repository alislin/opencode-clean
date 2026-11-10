import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { makeTempDir } from "./helpers/fixture.js";
import { buildReport, appendLog, writeLastReport, saveState, loadState, isStale, SUCCESS, PARTIAL, FAILED, EXIT } from "../lib/report.js";

const cleanup = (dir) => fs.rmSync(dir, { recursive: true, force: true });

const base = {
  mode: "FULL",
  dryRun: false,
  dbPath: "/db/opencode.db",
  durationMs: 250000,
};

test("three states map to three exit codes", () => {
  assert.equal(EXIT[SUCCESS], 0);
  assert.equal(EXIT[PARTIAL], 1);
  assert.equal(EXIT[FAILED], 2);
  assert.equal(buildReport({ ...base, state: SUCCESS }).exitCode, 0);
  assert.equal(buildReport({ ...base, state: PARTIAL }).exitCode, 1);
  assert.equal(buildReport({ ...base, state: FAILED, error: new Error("x") }).exitCode, 2);
});

test("FAILED report names the error and the vacuum step", () => {
  const err = new Error("boom");
  err.step = "vacuum";
  const rep = buildReport({ ...base, state: FAILED, error: err, vacuum: { steps: [{ name: "vacuum", ok: false }] } });
  assert.ok(rep.text.includes("❌ 失败"));
  assert.ok(rep.text.includes("boom"));
  assert.ok(rep.text.includes("vacuum"));
});

test("PARTIAL report carries the deferral reasons", () => {
  const rep = buildReport({
    ...base,
    state: PARTIAL,
    mode: "PURGE_ONLY",
    reasons: ["purge-only：语义清理完成，VACUUM/备份推迟"],
    purge: { executed: true, totalRows: 24, totalBytes: 1000, stats: [{ target: "legacy:total", rows: 20, bytes: 600 }, { target: "v2:total", rows: 4, bytes: 400 }] },
  });
  assert.ok(rep.text.includes("⚠ 部分完成"));
  assert.ok(rep.text.includes("purge-only"));
  assert.ok(rep.text.includes("24 行"));
});

test("dry-run report shows preview counts and free size units", () => {
  const rep = buildReport({
    ...base,
    state: SUCCESS,
    dryRun: true,
    preview: {
      legacy: { sessions: 2, message: 4, part: 4, todo: 2, session_share: 2, event: 2, event_sequence: 2, bytes: 600 },
      v2: { sessions: 1, session_message: 2, bytes: 400, totalBytes: 400 },
      totalRows: 9,
      totalBytes: 1000,
    },
    orphanStats: { removed: 5, bytes: 2048, skipped: 1, dryRun: true },
    beforeReport: { fileBytes: 100 * 1024 * 1024, liveBytes: 90 * 1024 * 1024, freelistBytes: 10 * 1024 * 1024, freelistPct: 10, journalMode: "wal", autoVacuum: 0 },
    running: true,
  });
  assert.ok(rep.text.includes("✅ 预览"));
  assert.ok(rep.text.includes("9 行"));
  assert.ok(rep.text.includes("运行中"));
  assert.ok(rep.text.includes("空洞 10.0 MB"));
  assert.ok(rep.text.includes("跳过 1 个快照项"));
});

test("vacuum results land in the report with backup path", () => {
  const rep = buildReport({
    ...base,
    state: SUCCESS,
    vacuum: { beforeBytes: 100 * 1024 * 1024, afterBytes: 50 * 1024 * 1024, freedBytes: 50 * 1024 * 1024, backupPath: "/b/backup.db", steps: [{ name: "vacuum", ok: true }] },
    afterReport: { fileBytes: 50 * 1024 * 1024, liveBytes: 49 * 1024 * 1024, freelistBytes: 1024, freelistPct: 0.1, journalMode: "wal", autoVacuum: 2 },
  });
  assert.ok(rep.text.includes("100.0 MB → 50.0 MB（释放 50.0 MB）"));
  assert.ok(rep.text.includes("/b/backup.db"));
});

test("json payload is stable and carries the key numbers", () => {
  const rep = buildReport({
    ...base,
    state: SUCCESS,
    purge: { executed: true, totalRows: 5, totalBytes: 500, stats: [] },
    vacuum: { skipped: true, skipKind: "not-needed", reason: "freelist tiny" },
  });
  assert.equal(rep.json.state, SUCCESS);
  assert.equal(rep.json.purge.totalRows, 5);
  assert.equal(rep.json.vacuum.skipped, true);
  assert.equal(rep.json.vacuum.reason, "freelist tiny");
});

test("appendLog/writeLastReport/saveState/loadState roundtrip in a temp dir", () => {
  const dir = makeTempDir();
  appendLog(dir, SUCCESS, "===== 报告 =====\n结果:  ✅ 成功\n耗时: 3s");
  const log = fs.readFileSync(path.join(dir, "clean.log"), "utf8");
  assert.ok(log.includes("[20"));
  assert.ok(log.includes("✅ 成功"));

  writeLastReport(dir, "REPORT-TEXT");
  assert.equal(fs.readFileSync(path.join(dir, "last-report.txt"), "utf8"), "REPORT-TEXT");

  saveState(dir, { lastSuccessEnd: 123, lastMode: "FULL" });
  assert.deepEqual(loadState(dir), { lastSuccessEnd: 123, lastMode: "FULL" });
  cleanup(dir);
});

test("isStale: no state => stale; fresh success => not stale; old success => stale", () => {
  const dir = makeTempDir();
  const now = 1_700_000_000_000;
  assert.equal(isStale(dir, { now }), true, "never ran");
  saveState(dir, { lastSuccessEnd: now - 2 * 86400000 });
  assert.equal(isStale(dir, { staleDays: 7, now }), false);
  saveState(dir, { lastSuccessEnd: now - 8 * 86400000 });
  assert.equal(isStale(dir, { staleDays: 7, now }), true);
  cleanup(dir);
});
