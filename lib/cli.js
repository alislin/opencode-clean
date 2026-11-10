import fs from "node:fs";
import { openDatabase, existingTables } from "./db.js";
import { freelistReport, vacuumDecision, tableCounts } from "./analyze.js";
import { purgePlan, executePurge, formatMB } from "./purge.js";
import { scanOrphans, removeOrphans, scanSnapshots } from "./orphans.js";
import { detectProcessRunning, dbActivity, isDbQuiet, waitForIdle } from "./idle.js";
import { runVacuumSequence, freeDiskBytes } from "./vacuum.js";
import { buildReport, appendLog, writeLastReport, saveState, loadState, isStale, SUCCESS, PARTIAL, FAILED } from "./report.js";
import { shouldNotify, notify } from "./notify.js";
import { DEFAULTS } from "./config.js";

const MB = 1024 * 1024;

/** Resolve final paths from CLI opts. */
export function resolvePaths(opts) {
  const dataDir = opts.dataDir ?? path_join(os_home(), ".opencode", "ocgc");
  const dbPath = opts.db ?? path_join(os_home(), ".local", "share", "opencode", "opencode.db");
  return { dbPath, dataDir, backupDir: path_join(dataDir, "backup"), storageRoot: path_join(path.dirname(dbPath)) };
}

// small indirections so this module has no other import burden in tests
import os from "node:os";
import path from "node:path";
const os_home = os.homedir;
const path_join = path.join;

/**
 * The whole pipeline, with injectable deps for tests.
 * Returns the report object { state, exitCode, text, json, title }.
 */
export async function runClean(opts, deps = {}) {
  const now = deps.now ?? (() => Date.now());
  const sleep = deps.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const open = deps.open ?? openDatabase;
  const detect = deps.detectProcess ?? detectProcessRunning;
  const log = deps.log ?? ((m) => (opts.json ? null : console.log(m)));
  const startedAt = now();
  const paths = resolvePaths(opts);
  const cfg = { ...DEFAULTS, ...opts };

  const finish = async (input) => {
    const durationMs = now() - startedAt;
    const rep = buildReport({ ...input, durationMs, dbPath: paths.dbPath, dryRun: opts.dryRun });
    writeLastReport(paths.dataDir, rep.text);
    if (!opts.dryRun) {
      appendLog(paths.dataDir, rep.state, rep.text);
      const freedMB = freedMBOf(rep);
      const st = loadState(paths.dataDir) ?? {};
      if (rep.state === SUCCESS) {
        saveState(paths.dataDir, { ...st, lastRunEnd: now(), lastSuccessEnd: now(), lastState: rep.state, lastMode: input.mode, freedMB });
      } else {
        saveState(paths.dataDir, { ...st, lastRunEnd: now(), lastState: rep.state, lastMode: input.mode });
      }
      if (shouldNotify({ state: rep.state, freedMB, enabled: opts.notify, minFreedMB: cfg.notifyMinFreedMB })) {
        notify({ title: rep.title, body: firstLines(rep.text) }, { runner: deps.runner });
      }
    }
    if (opts.json) console.log(JSON.stringify(rep.json, null, 2));
    else console.log(rep.text);
    return rep;
  };

  try {
    if (!fs.existsSync(paths.dbPath)) {
      return finish({ state: FAILED, error: new Error(`database not found: ${paths.dbPath}`) });
    }

    // stale gate (for @reboot --if-stale)
    if (opts.ifStale && !isStale(paths.dataDir, { staleDays: cfg.staleDays, now: now() })) {
      return finish({ state: SUCCESS, mode: "SKIPPED", reasons: ["上次成功清理距今不足 staleDays，跳过"] });
    }

    const readOnly = opts.dryRun;
    let db = open(paths.dbPath, { readOnly });
    const tables = existingTables(db);

    // ---- running-state decision ----
    const running = detect();
    let idleWait = null;
    let mode = "FULL";
    if (!opts.dryRun && running) {
      log(`OpenCode 正在运行，等待空闲（最长 ${cfg.waitMinutes} 分钟）...`);
      idleWait = await waitForIdle({
        check: () => {
          const a = dbActivity(db, tables, { now: now(), windowMs: cfg.activityWindowSec * 1000 });
          return { idle: !a.active };
        },
        intervalMs: cfg.pollSeconds * 1000,
        maxWaitMs: cfg.waitMinutes * 60000,
        sleep,
      });
      mode = idleWait.idle ? "FULL" : "PURGE_ONLY";
      log(idleWait.idle ? "已空闲，执行完整流程。" : "等待超时，执行 purge-only（物理维护推迟）。");
    } else if (running) {
      mode = "PREVIEW";
    }

    // ---- analyze before ----
    const beforeReport = freelistReport(db, paths.dbPath);
    log(`体检: 文件 ${formatMB(beforeReport.fileBytes)} MB | 活跃 ${formatMB(beforeReport.liveBytes)} MB | 空洞 ${formatMB(beforeReport.freelistBytes)} MB (${beforeReport.freelistPct.toFixed(1)}%)`);

    // ---- semantic purge ----
    const cutoff = now() - cfg.days * 86400000;
    const purgeResult = executePurge(db, tables, { cutoff, dryRun: opts.dryRun });
    const preview = opts.dryRun ? purgeResult.plan : null;
    if (opts.dryRun) {
      log(`预览: ${preview.totalRows} 行 ≈ ${formatMB(preview.totalBytes)} MB`);
    } else {
      log(`已删除 ${purgeResult.totalRows} 行 ≈ ${formatMB(purgeResult.totalBytes)} MB`);
    }

    // ---- orphan files ----
    let orphanStats = null;
    if (cfg.orphans || cfg.snapshots) {
      const scan = scanOrphans(db, tables, paths.storageRoot);
      const snapScan = cfg.snapshots ? scanSnapshots(paths.storageRoot) : { orphans: [], totalBytes: 0 };
      const merged = { orphans: [...scan.orphans, ...snapScan.orphans], totalBytes: scan.totalBytes + snapScan.totalBytes };
      orphanStats = removeOrphans(merged, { dryRun: opts.dryRun, snapshots: cfg.snapshots });
      log(`磁盘孤儿: ${orphanStats.removed} 个 ≈ ${formatMB(orphanStats.bytes)} MB`);
    }

    if (opts.dryRun) {
      const decision = vacuumDecision(beforeReport, { purgedBytes: preview.totalBytes, force: cfg.forceVacuum });
      log(`若实删，随后将 VACUUM: ${decision.should ? "是" : "否"}（${decision.reason}）`);
      db.close();
      return finish({ state: SUCCESS, mode: "PREVIEW", preview, orphanStats, beforeReport, running, vacuum: { skipped: true, reason: "dry-run 预览不执行" } });
    }

    // ---- physical phase (FULL mode only) ----
    let vacuum = { skipped: true, reason: mode === "PURGE_ONLY" ? "OpenCode 仍在执行，物理维护推迟到下次窗口" : "" };
    let afterReport = null;
    let reasons = [];

    if (mode === "FULL") {
      const quiet = isDbQuiet(db);
      if (!quiet) {
        vacuum = { skipped: true, skipKind: "deferred", reason: "数据库被其他连接占用（非静默），物理维护推迟" };
      } else {
        const postPurge = freelistReport(db, paths.dbPath);
        const decision = vacuumDecision(postPurge, { purgedBytes: purgeResult.totalBytes, freelistPct: cfg.vacuumFreelistPct, freelistMB: cfg.vacuumFreelistMB, force: cfg.forceVacuum });
        // need: backup (1x) + vacuum temp (1x) over current size, plus margin
        const needBytes = beforeReport.fileBytes * (cfg.keepBackups >= 1 ? 2 : 1) + 1;
        const freeBytes = freeDiskBytes(paths.dataDir, { statfs: deps.statfs });
        if (freeBytes < needBytes) {
          vacuum = { skipped: true, skipKind: "deferred", reason: `磁盘剩余 ${(freeBytes / MB).toFixed(0)} MB 不足（需约 ${(needBytes / MB).toFixed(0)} MB 含备份），物理维护推迟` };
        } else if (!decision.should) {
          vacuum = { skipped: true, skipKind: "not-needed", reason: decision.reason };
        } else {
          try {
            db.close();
            db = null;
            vacuum = runVacuumSequence(paths.dbPath, { backupDir: paths.backupDir, keepBackups: cfg.keepBackups, now, logger: log });
          } catch (err) {
            return finish({ state: FAILED, mode, error: err, purge: purgeResult, orphanStats, beforeReport, running, idleWait });
          }
        }
      }
    } else {
      reasons.push("purge-only：语义清理完成，VACUUM/备份推迟");
    }

    if (db) db.close();
    if (!vacuum?.skipped) {
      const post = open(paths.dbPath, { readOnly: true });
      afterReport = freelistReport(post, paths.dbPath);
      post.close();
    }
    if (vacuum?.skipped && vacuum.skipKind === "deferred") reasons.push(vacuum.reason);

    const state = mode === "PURGE_ONLY" || (vacuum?.skipped && vacuum.skipKind === "deferred") ? PARTIAL : SUCCESS;
    return finish({ state, mode, reasons, purge: purgeResult, orphanStats, beforeReport, afterReport, vacuum, backupPath: vacuum?.backupPath, running, idleWait });
  } catch (err) {
    return finish({ state: FAILED, error: err });
  }
}

function freedMBOf(rep) {
  const bytes = rep.json?.vacuum?.freedBytes ?? 0;
  return bytes / (1024 * 1024);
}
function firstLines(text, n = 6) {
  return text.split("\n").slice(0, n).join("\n");
}
