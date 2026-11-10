import fs from "node:fs";
import path from "node:path";

/** Default configuration, overridable via dataDir/config.json and CLI flags. */
export const DEFAULTS = Object.freeze({
  days: 30, // retention window for v2 subagent sessions
  waitMinutes: 15, // max time to wait for OpenCode to go idle
  pollSeconds: 60, // idle re-probe interval
  activityWindowSec: 120, // DB writes within this window => "executing"
  keepBackups: 1,
  notify: true,
  notifyMinFreedMB: 100,
  snapshots: false, // delete snapshot/ directories
  orphans: true, // clean orphan session/message/part files
  staleDays: 7, // --if-stale: skip if last successful run is fresher than this
  vacuumFreelistPct: 20,
  vacuumFreelistMB: 100,
});

/** Load config.json from dataDir, merged over DEFAULTS. Missing/broken file => defaults. */
export function loadConfig(dataDir, deps = {}) {
  const readFile = deps.readFile ?? ((p) => fs.readFileSync(p, "utf8"));
  const exists = deps.exists ?? fs.existsSync;
  let user = {};
  try {
    const file = path.join(dataDir, "config.json");
    if (exists(file)) user = JSON.parse(readFile(file));
  } catch {
    user = {};
  }
  return { ...DEFAULTS, ...user };
}

/** Merge patch into config.json and persist it. */
export function saveConfig(dataDir, patch, deps = {}) {
  const fsd = deps.fs ?? fs;
  fsd.mkdirSync(dataDir, { recursive: true });
  const next = { ...loadConfig(dataDir, deps), ...patch };
  fsd.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(next, null, 2) + "\n");
  return next;
}

export const USAGE = `ocgc-clean — OpenCode storage cleaner

Usage:
  node ocgc-clean.js [options]

Options:
  --yes              really delete (default is dry-run preview)
  --days <N>         retention window for subagent sessions (default 30)
  --wait-minutes <N> max wait for OpenCode idle when running (default 15)
  --snapshots        also delete snapshot/ directories (default off)
  --no-orphans       skip orphan file cleanup (default on)
  --no-notify        disable desktop notification for this run
  --if-stale         run only when last successful run is older than staleDays
  --force-vacuum     run VACUUM sequence even when the freelist gate says skip
  --db <path>        database path override (default ~/.local/share/opencode/opencode.db)
  --data-dir <path>  runtime artifacts dir override (default ~/.opencode/ocgc)
  --dry-run          explicit preview (default when --yes absent)
  --json             print report as JSON to stdout
  -h, --help         this help

Exit codes: 0 success | 1 partial (physical maintenance deferred) | 2 failure
`;

/** Pure argv parser. Real deletion requires explicit --yes; otherwise dryRun stays true. */
export function parseArgs(argv) {
  const opts = {
    yes: false,
    days: DEFAULTS.days,
    waitMinutes: DEFAULTS.waitMinutes,
    snapshots: DEFAULTS.snapshots,
    orphans: DEFAULTS.orphans,
    notify: true,
    ifStale: false,
    forceVacuum: false,
    dryRun: true,
    json: false,
    help: false,
    db: undefined,
    dataDir: undefined,
  };
  let explicitDryRun = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--yes":
        opts.yes = true;
        break;
      case "--days":
      case "--wait-minutes": {
        const v = Number(argv[++i]);
        if (!Number.isFinite(v) || v <= 0) throw new Error(`flag ${a} requires a positive number`);
        if (a === "--days") opts.days = v;
        else opts.waitMinutes = v;
        break;
      }
      case "--snapshots":
        opts.snapshots = true;
        break;
      case "--no-orphans":
        opts.orphans = false;
        break;
      case "--no-notify":
        opts.notify = false;
        break;
      case "--if-stale":
        opts.ifStale = true;
        break;
      case "--force-vacuum":
        opts.forceVacuum = true;
        break;
      case "--db": {
        const v = argv[++i];
        if (!v) throw new Error("flag --db requires a path");
        opts.db = v;
        break;
      }
      case "--data-dir": {
        const v = argv[++i];
        if (!v) throw new Error("flag --data-dir requires a path");
        opts.dataDir = v;
        break;
      }
      case "--json":
        opts.json = true;
        break;
      case "--dry-run":
        opts.dryRun = true;
        explicitDryRun = true;
        break;
      case "-h":
      case "--help":
        opts.help = true;
        break;
      default:
        throw new Error(`unknown argument: ${a}`);
    }
  }
  // explicit --dry-run always wins: previewing must be possible even with --yes present
  opts.dryRun = explicitDryRun ? true : !opts.yes;
  return opts;
}
