#!/usr/bin/env node
import { parseArgs, USAGE } from "../lib/config.js";
import { runClean } from "../lib/cli.js";

const argv = process.argv.slice(2);

if (argv.includes("-h") || argv.includes("--help")) {
  console.log(USAGE);
  process.exit(0);
}

let opts;
try {
  opts = parseArgs(argv);
} catch (err) {
  console.error(`参数错误: ${err.message}\n\n${USAGE}`);
  process.exit(2);
}

try {
  const report = await runClean(opts);
  process.exit(report.exitCode);
} catch (err) {
  console.error("未预期的错误:", err);
  process.exit(2);
}
