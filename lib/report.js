import fs from "node:fs";
import path from "node:path";

/** Report states. PARTIAL = purge done but physical maintenance deferred. */
export const SUCCESS = "SUCCESS";
export const PARTIAL = "PARTIAL";
export const FAILED = "FAILED";
export const EXIT = { [SUCCESS]: 0, [PARTIAL]: 1, [FAILED]: 2 };

/**
 * Build the run report.
 * shape: { state, exitCode, title, text, json }
 */
export function buildReport(input) {
  const {
    state,
    mode, // FULL | PURGE_ONLY | PREVIEW
    dryRun,
    reasons = [],
    preview, // purgePlan (dry-run)
    purge, // executed purge result
    orphanStats,
    beforeReport, // freelistReport before
    afterReport, // freelistReport after (real runs)
    vacuum, // runVacuumSequence result or { skipped: true, reason }
    backupPath,
    running,
    idleWait,
    durationMs,
    dbPath,
    error,
  } = input;
  const lines = [];
  lines.push(`===== OpenCode 清理报告 ${new Date().toISOString()} =====`);
  lines.push(`数据库: ${dbPath}`);

  if (error) {
    lines.push(`结果:  ❌ 失败 — ${error.message ?? error}`);
    if (error.step) lines.push(`失败步骤: ${error.step}`);
  } else if (dryRun) {
    lines.push(`结果:  ✅ 预览（dry-run，未删除任何数据）`);
  } else if (state === PARTIAL) {
    lines.push(`结果:  ⚠ 部分完成 — ${reasons.join("; ")}`);
  } else {
    lines.push(`结果:  ✅ 成功`);
  }

  if (running !== undefined) {
    lines.push(`OpenCode: ${running ? "运行中" : "未运行"}${idleWait ? `（等待空闲 ${Math.round(idleWait.waitedMs / 1000)}s${idleWait.timedOut ? "，超时" : ""}）` : ""}`);
  }

  if (preview) {
    lines.push("");
    lines.push("--- 将删除（预览） ---");
    if (preview.legacy) {
      lines.push(`旧表(有v2副本): 会话 ${preview.legacy.sessions}, message ${fmt(preview.legacy.message)}, part ${fmt(preview.legacy.part)}, todo ${fmt(preview.legacy.todo)}, share ${fmt(preview.legacy.session_share)}, event ${fmt(preview.legacy.event)}, event_sequence ${fmt(preview.legacy.event_sequence)} ≈ ${mb(preview.legacy.bytes)} MB`);
    }
    if (preview.v2) {
      lines.push(`v2子代理: 会话 ${preview.v2.sessions}, session_message ${fmt(preview.v2.session_message)}, session_part ${fmt(preview.v2.session_part)}, inbox ${fmt(preview.v2.session_inbox)}, instruction ${fmt(preview.v2.instruction_entry)}/${fmt(preview.v2.instruction_state)}, blob_ref ${fmt(preview.v2.blob_ref)}, blob孤儿 ${fmt(preview.v2.blob_orphan)}, job ${fmt(preview.v2.job)}, schedule ${fmt(preview.v2.schedule)} ≈ ${mb(preview.v2.bytes)} MB`);
    }
    lines.push(`合计: ${preview.totalRows} 行 ≈ ${mb(preview.totalBytes)} MB`);
  }

  if (purge?.executed) {
    lines.push("");
    lines.push("--- 已删除 ---");
    for (const s of purge.stats.filter((x) => x.target.endsWith(":total"))) {
      lines.push(`${s.target}: ${s.rows} 行 ≈ ${mb(s.bytes)} MB`);
    }
    lines.push(`合计: ${purge.totalRows} 行 ≈ ${mb(purge.totalBytes)} MB`);
  }

  if (orphanStats) {
    lines.push(`磁盘孤儿文件: ${orphanStats.removed} 个 ≈ ${mb(orphanStats.bytes)} MB${orphanStats.skipped ? `（跳过 ${orphanStats.skipped} 个快照项）` : ""}${orphanStats.dryRun ? "（预览）" : ""}`);
  }

  if (beforeReport) {
    lines.push("");
    lines.push(`数据库体检: 文件 ${mb(beforeReport.fileBytes)} MB | 活跃 ${mb(beforeReport.liveBytes)} MB | 空洞 ${mb(beforeReport.freelistBytes)} MB (${beforeReport.freelistPct.toFixed(1)}%)`);
  }
  if (vacuum?.skipped) {
    lines.push(`VACUUM: 跳过 — ${vacuum.reason}`);
  } else if (vacuum) {
    lines.push(`VACUUM: ${mb(vacuum.beforeBytes)} MB → ${mb(vacuum.afterBytes)} MB（释放 ${mb(vacuum.freedBytes)} MB）`);
    lines.push(`备份: ${vacuum.backupPath ?? "未创建"}`);
    const failed = vacuum.steps?.filter((s) => !s.ok) ?? [];
    if (failed.length) lines.push(`失败步骤: ${failed.map((s) => s.name).join(", ")}`);
  }
  if (afterReport) {
    lines.push(`清理后体检: 文件 ${mb(afterReport.fileBytes)} MB | 活跃 ${mb(afterReport.liveBytes)} MB | 空洞 ${mb(afterReport.freelistBytes)} MB (${afterReport.freelistPct.toFixed(1)}%)`);
  }
  if (durationMs !== undefined) lines.push(`耗时: ${(durationMs / 1000).toFixed(1)}s`);

  const exitCode = EXIT[state] ?? 2;
  const text = lines.join("\n") + "\n";
  return { state, exitCode, title: `OpenCode 清理 ${state}`, text, json: buildJson(input, state, exitCode) };
}

function buildJson(input, state, exitCode) {
  const { vacuum, purge, preview, orphanStats, beforeReport, afterReport, mode, dryRun, reasons, durationMs, running, idleWait } = input;
  return {
    state,
    exitCode,
    mode,
    dryRun,
    reasons,
    running,
    idleWait,
    durationMs,
    error: input.error ? { message: String(input.error.message ?? input.error), step: input.error.step } : undefined,
    preview: preview ?? undefined,
    purge: purge?.executed ? { totalRows: purge.totalRows, totalBytes: purge.totalBytes, stats: purge.stats } : undefined,
    orphans: orphanStats ?? undefined,
    before: beforeReport ?? undefined,
    after: afterReport ?? undefined,
    vacuum: vacuum
      ? vacuum.skipped
        ? { skipped: true, reason: vacuum.reason }
        : { beforeBytes: vacuum.beforeBytes, afterBytes: vacuum.afterBytes, freedBytes: vacuum.freedBytes, backupPath: vacuum.backupPath, steps: vacuum.steps }
      : undefined,
  };
}

const fmt = (v) => (v === null || v === undefined ? "n/a" : String(v));
const mb = (b) => ((b ?? 0) / (1024 * 1024)).toFixed(1);

/** Append a one-line summary to clean.log (created on demand). */
export function appendLog(dataDir, state, text, deps = {}) {
  const fsd = deps.fs ?? fs;
  fsd.mkdirSync(dataDir, { recursive: true });
  const firstLine = text.split("\n").find((l) => l.includes("结果:")) ?? text.split("\n")[0];
  const sizeMatch = [...text.matchAll(/（释放 ([\d.]+) MB）|释放 ([\d.]+) MB/g)];
  const line = `[${new Date().toISOString()}] ${state} ${firstLine.replace(/^结果:\s*/, "")}${sizeMatch.length ? ` freed≈${sizeMatch[0][1] ?? sizeMatch[0][2]}MB` : ""}\n`;
  fsd.appendFileSync(path.join(dataDir, "clean.log"), line);
  return line;
}

/** Persist last-report.txt (regenerated every run). */
export function writeLastReport(dataDir, text, deps = {}) {
  const fsd = deps.fs ?? fs;
  fsd.mkdirSync(dataDir, { recursive: true });
  fsd.writeFileSync(path.join(dataDir, "last-report.txt"), text);
}

/** state.json for --if-stale and status display. */
export function saveState(dataDir, state, deps = {}) {
  const fsd = deps.fs ?? fs;
  fsd.mkdirSync(dataDir, { recursive: true });
  fsd.writeFileSync(path.join(dataDir, "state.json"), JSON.stringify(state, null, 2) + "\n");
}

export function loadState(dataDir, deps = {}) {
  const readFile = deps.readFile ?? ((p) => fs.readFileSync(p, "utf8"));
  const exists = deps.exists ?? fs.existsSync;
  try {
    const file = path.join(dataDir, "state.json");
    return exists(file) ? JSON.parse(readFile(file)) : null;
  } catch {
    return null;
  }
}

/** --if-stale helper: should we run? true when never ran or last success is stale. */
export function isStale(dataDir, { staleDays = 7, now = Date.now() } = {}, deps = {}) {
  const st = loadState(dataDir, deps);
  if (!st?.lastSuccessEnd) return true;
  return now - st.lastSuccessEnd > staleDays * 86400000;
}
