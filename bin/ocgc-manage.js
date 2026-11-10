#!/usr/bin/env node
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openDatabase, existingTables } from "../lib/db.js";
import { freelistReport, tableCounts, lastWriteAt, vacuumDecision } from "../lib/analyze.js";
import { purgePlan, formatMB } from "../lib/purge.js";
import { runClean, resolvePaths } from "../lib/cli.js";
import { loadState, loadConfig, saveConfig } from "../lib/config.js";
import * as schedule from "../lib/schedule.js";

const scriptPath = fileURLToPath(import.meta.url);
const nodePath = process.execPath;
const paths = resolvePaths({});

const rl = readline.createInterface({ input, output });
const ask = (q) => rl.question(q);

function statusLine(cfg) {
  const st = loadState(paths.dataDir);
  const reg = schedule.status({ platform: process.platform, dataDir: paths.dataDir });
  const last = st?.lastSuccessEnd ? new Date(st.lastSuccessEnd).toLocaleString() : "从未运行";
  return `数据目录: ${paths.dataDir}\n数据库:   ${paths.dbPath}\n上次成功: ${last} | 计划任务: ${reg.registered ? "已注册" : "未注册"} | 通知: ${cfg.notify ? "开" : "关"} | 保留天数: ${cfg.days}`;
}

async function main() {
  const cfg = loadConfig(paths.dataDir);
  console.log("========== OpenCode 自动清理管理 ==========");
  console.log(statusLine(cfg));
  console.log("-------------------------------------------");
  console.log(" [1] 数据库体检（只读）");
  console.log(" [2] 立即清理（先预览，确认后实删）");
  console.log(" [3] 注册每周自动清理任务（周日 03:00）");
  console.log(" [4] 移除自动清理任务");
  console.log(" [5] 查看上次报告");
  console.log(" [6] 通知开关");
  console.log(" [7] 修改保留天数");
  console.log(" [0] 退出");
  const choice = (await ask("选择: ")).trim();

  switch (choice) {
    case "1": {
      const db = openDatabase(paths.dbPath, { readOnly: true });
      const tables = existingTables(db);
      const rep = freelistReport(db, paths.dbPath);
      console.log(
        `文件 ${formatMB(rep.fileBytes)} MB | 活跃 ${formatMB(rep.liveBytes)} MB | 空洞 ${formatMB(rep.freelistBytes)} MB (${rep.freelistPct.toFixed(1)}%) | WAL=${rep.journalMode} | auto_vacuum=${rep.autoVacuum}`,
      );
      console.log("行数:", JSON.stringify(tableCounts(db, tables)));
      const lw = lastWriteAt(db, tables);
      console.log(`最近写入: ${lw ? `${Math.round((Date.now() - lw) / 1000)} 秒前` : "无记录"}`);
      console.log(`VACUUM 建议: ${JSON.stringify(vacuumDecision(rep, { purgedBytes: 0 }))}`);
      db.close();
      break;
    }
    case "2": {
      console.log("--- 第一步：预览 ---");
      const preview = await runClean({ ...cfg, dryRun: true });
      const answer = (await ask("按以上预览执行真实清理? [y/N]: ")).trim().toLowerCase();
      if (answer === "y" || answer === "yes") {
        console.log("--- 第二步：真实执行 ---");
        const rep = await runClean({ ...cfg, yes: true, dryRun: false });
        process.exit(rep.exitCode);
      }
      break;
    }
    case "3": {
      const r = schedule.register({ platform: process.platform, nodePath, scriptPath, dataDir: paths.dataDir });
      console.log(r.ok ? `✓ 已注册每周自动清理任务。详情: ${r.detail}` : `✗ 注册失败: ${r.detail}`);
      break;
    }
    case "4": {
      const r = schedule.unregister({ platform: process.platform, dataDir: paths.dataDir });
      console.log(r.ok ? "✓ 已移除计划任务。" : `✗ 移除失败: ${r.detail}`);
      break;
    }
    case "5": {
      try {
        const fs = await import("node:fs");
        console.log(fs.readFileSync(path.join(paths.dataDir, "last-report.txt"), "utf8"));
      } catch {
        console.log("暂无报告。");
      }
      break;
    }
    case "6": {
      const next = saveConfig(paths.dataDir, { notify: !cfg.notify });
      console.log(`桌面通知: ${next.notify ? "开" : "关"}`);
      break;
    }
    case "7": {
      const v = Number(await ask(`保留天数 [当前 ${cfg.days}]: `));
      if (Number.isFinite(v) && v > 0) {
        const next = saveConfig(paths.dataDir, { days: v });
        console.log(`保留天数: ${next.days}`);
      }
      break;
    }
    case "0":
      rl.close();
      return;
    default:
      console.log("无效选择。");
  }
  rl.close();
  await main();
}

main().catch((err) => {
  console.error("错误:", err);
  process.exit(2);
});
