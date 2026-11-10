import fs from "node:fs";
import path from "node:path";

/**
 * Orphan detection on the filesystem storage left behind by older OpenCode
 * versions (pre-SQLite era) and interrupted purges:
 *
 *   storage/session/<sesId>.json        — kept while id exists in either schema
 *   storage/message/<sesId>/            — kept while session id exists
 *   storage/part/<msgId>/               — kept while message id exists
 *   storage/session_diff/<sesId>.json   — kept while session id exists
 *   snapshot/                           — flag-gated (whole dir, no id mapping)
 *
 * Nothing outside these five locations is ever touched.
 */

const MB = 1024 * 1024;

function idSet(db, tables, table) {
  if (!tables.has(table)) return new Set();
  return new Set(db.prepare(`SELECT id FROM "${table}"`).all().map((r) => r.id));
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function sizeOf(p, isDir) {
  try {
    if (isDir) {
      let n = 0;
      const stack = [p];
      while (stack.length) {
        const cur = stack.pop();
        for (const e of fs.readdirSync(cur, { withFileTypes: true })) {
          const fp = path.join(cur, e.name);
          if (e.isDirectory()) stack.push(fp);
          else n += fs.statSync(fp).size;
        }
      }
      return n;
    }
    return fs.statSync(p).size;
  } catch {
    return 0;
  }
}

const stripJson = (name) => (name.endsWith(".json") ? name.slice(0, -5) : name);

/** Scan for orphaned files/dirs. Read-only. */
export function scanOrphans(db, tables, storageRoot) {
  const sessionIds = new Set([...idSet(db, tables, "session"), ...idSet(db, tables, "session_v2")]);
  const messageIds = new Set([...idSet(db, tables, "message"), ...idSet(db, tables, "session_message")]);

  const orphans = [];
  const push = (p, kind, isDir) => orphans.push({ path: p, kind, isDir, bytes: sizeOf(p, isDir) });

  // storage/session/<id>.json
  for (const e of listDir(path.join(storageRoot, "storage", "session"))) {
    if (e.isFile() && !sessionIds.has(stripJson(e.name))) push(path.join(storageRoot, "storage", "session", e.name), "session", false);
  }
  // storage/message/<sesId>/
  for (const e of listDir(path.join(storageRoot, "storage", "message"))) {
    const isDir = e.isDirectory();
    if ((isDir || e.isFile()) && !sessionIds.has(e.name)) push(path.join(storageRoot, "storage", "message", e.name), "message", isDir);
  }
  // storage/part/<msgId>/
  for (const e of listDir(path.join(storageRoot, "storage", "part"))) {
    const isDir = e.isDirectory();
    if ((isDir || e.isFile()) && !messageIds.has(e.name)) push(path.join(storageRoot, "storage", "part", e.name), "part", isDir);
  }
  // storage/session_diff/<id>.json
  for (const e of listDir(path.join(storageRoot, "storage", "session_diff"))) {
    if (e.isFile() && !sessionIds.has(stripJson(e.name))) push(path.join(storageRoot, "storage", "session_diff", e.name), "session_diff", false);
  }

  const totalBytes = orphans.reduce((a, o) => a + o.bytes, 0);
  return { orphans, totalBytes };
}

/** Remove previously scanned orphans. snapshot paths require snapshots=true. */
export function removeOrphans(scanResult, { dryRun = true, snapshots = false } = {}) {
  let removed = 0;
  let bytes = 0;
  let skipped = 0;
  for (const o of scanResult.orphans) {
    if (o.kind === "snapshot" && !snapshots) {
      skipped++;
      continue;
    }
    if (!dryRun) {
      fs.rmSync(o.path, { recursive: o.isDir, force: true });
    }
    removed++;
    bytes += o.bytes;
  }
  return { removed, bytes, skipped, dryRun };
}

/** Scan the whole snapshot/ directory (flag-gated target). */
export function scanSnapshots(storageRoot) {
  const root = path.join(storageRoot, "snapshot");
  if (!fs.existsSync(root)) return { orphans: [], totalBytes: 0 };
  const entries = listDir(root).map((e) => ({
    path: path.join(root, e.name),
    kind: "snapshot",
    isDir: e.isDirectory(),
    bytes: sizeOf(path.join(root, e.name), e.isDirectory()),
  }));
  return { orphans: entries, totalBytes: entries.reduce((a, o) => a + o.bytes, 0) };
}

export function formatMB(bytes) {
  return (bytes / MB).toFixed(1);
}
