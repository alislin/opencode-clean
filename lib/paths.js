import os from "node:os";
import path from "node:path";

/** Stable location for runtime artifacts (logs, reports, backups, config). */
export function defaultDataDir() {
  return path.join(os.homedir(), ".opencode", "ocgc");
}

/** Default OpenCode database location (same on Windows/macOS/Linux). */
export function defaultDbPath() {
  return path.join(os.homedir(), ".local", "share", "opencode", "opencode.db");
}
