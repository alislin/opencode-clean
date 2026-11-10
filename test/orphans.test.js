import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createFixtureDb, createStorageTree, makeTempDir, counts } from "./helpers/fixture.js";
import { scanOrphans, removeOrphans, scanSnapshots } from "../lib/orphans.js";

let dir, ctx, storageRoot, tree;

beforeEach(() => {
  dir = makeTempDir();
  ctx = createFixtureDb(dir);
  storageRoot = dir;
  tree = createStorageTree(storageRoot);
});

afterEach(() => {
  ctx.db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("scanOrphans finds exactly the known dead entries", () => {
  const scan = scanOrphans(ctx.db, ctx.tables, storageRoot);
  const names = scan.orphans.map((o) => path.basename(o.path)).sort();
  assert.deepEqual(names, ["ses_DEAD.json", "ses_DEAD2", "ses_DEAD3.json", "msg_DEAD4", "ses_DEAD5.json"].sort());
  assert.equal(scan.orphans.filter((o) => o.kind === "session").length, 1);
  assert.equal(scan.orphans.filter((o) => o.kind === "message").length, 2, "dead dir + dead file");
  assert.equal(scan.orphans.filter((o) => o.kind === "part").length, 1);
  assert.equal(scan.orphans.filter((o) => o.kind === "session_diff").length, 1);
  assert.ok(scan.totalBytes >= 0);
});

test("scanOrphans never flags entries whose ids exist in either schema", () => {
  const scan = scanOrphans(ctx.db, ctx.tables, storageRoot);
  const names = scan.orphans.map((o) => path.basename(o.path));
  assert.ok(!names.includes("ses_Vmain.json"), "legacy-schema id kept");
  assert.ok(!names.includes("ses_Vmain"), "v2-schema id kept");
  assert.ok(!names.includes("main_msg0"), "v2 message id kept");
});

test("removeOrphans dry-run deletes nothing but reports the same numbers", () => {
  const scan = scanOrphans(ctx.db, ctx.tables, storageRoot);
  const r = removeOrphans(scan, { dryRun: true, snapshots: false });
  assert.equal(r.removed, 5);
  for (const o of scan.orphans) assert.ok(fs.existsSync(o.path), `${o.path} still exists`);
});

test("removeOrphans real run removes exactly the dead entries", () => {
  const scan = scanOrphans(ctx.db, ctx.tables, storageRoot);
  removeOrphans(scan, { dryRun: false, snapshots: false });
  assert.ok(!fs.existsSync(tree.orphanSession));
  assert.ok(!fs.existsSync(tree.orphanMsgDir));
  assert.ok(!fs.existsSync(tree.orphanMsgFile));
  assert.ok(!fs.existsSync(tree.orphanPart));
  assert.ok(!fs.existsSync(tree.orphanDiff));
  assert.ok(fs.existsSync(tree.keeperSession));
  assert.ok(fs.existsSync(tree.keeperMsgDir));
  assert.ok(fs.existsSync(tree.keeperPart));
  assert.ok(fs.existsSync(tree.keeperDiff));
});

test("snapshot entries are skipped unless snapshots=true", () => {
  const scan = scanOrphans(ctx.db, ctx.tables, storageRoot);
  const snap = scanSnapshots(storageRoot);
  assert.equal(snap.orphans.length, 1);
  const merged = { orphans: [...scan.orphans, ...snap.orphans] };

  const skipped = removeOrphans(merged, { dryRun: false, snapshots: false });
  assert.ok(fs.existsSync(tree.snapshotFile), "snapshot kept without flag");
  assert.equal(skipped.skipped, 1);

  const done = removeOrphans(merged, { dryRun: false, snapshots: true });
  assert.ok(!fs.existsSync(tree.snapshotFile), "snapshot removed with flag");
  assert.equal(done.skipped, 0);
});

test("scan handles a completely missing storage root", () => {
  const scan = scanOrphans(ctx.db, ctx.tables, path.join(dir, "nonexistent"));
  assert.equal(scan.orphans.length, 0);
  const r = removeOrphans(scan, { dryRun: false, snapshots: true });
  assert.equal(r.removed, 0);
});
