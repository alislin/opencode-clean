import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createFixtureDb, makeTempDir, counts, EXPECT, NOW, DAY, OLD, RECENT } from "./helpers/fixture.js";
import { purgePlan, executePurge } from "../lib/purge.js";

let dir, ctx;

beforeEach(() => {
  dir = makeTempDir();
  ctx = createFixtureDb(dir);
});

afterEach(() => {
  ctx.db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const CUTOFF = NOW - 30 * DAY;

test("preview counts match fixture expectations exactly", () => {
  const plan = purgePlan(ctx.db, ctx.tables, { cutoff: CUTOFF });
  for (const [k, v] of Object.entries(EXPECT.legacy)) {
    assert.equal(plan.legacy[k], v, `legacy.${k}`);
  }
  for (const [k, v] of Object.entries(EXPECT.v2)) {
    assert.equal(plan.v2[k], v, `v2.${k}`);
  }
  assert.equal(plan.totalRows, 30, "totalRows");
  assert.equal(plan.totalBytes, EXPECT.legacy.bytes + EXPECT.v2.bytes, "totalBytes");
});

test("preview never mutates the database", () => {
  const before = ["session", "message", "part", "todo", "session_share", "event", "event_sequence", "session_v2", "session_message"].map((t) => counts(ctx.db, t));
  purgePlan(ctx.db, ctx.tables, { cutoff: CUTOFF });
  const after = ["session", "message", "part", "todo", "session_share", "event", "event_sequence", "session_v2", "session_message"].map((t) => counts(ctx.db, t));
  assert.deepEqual(after, before);
});

test("executePurge deletes exactly the previewed rows", () => {
  const plan = purgePlan(ctx.db, ctx.tables, { cutoff: CUTOFF });
  const result = executePurge(ctx.db, ctx.tables, { cutoff: CUTOFF, dryRun: false });

  assert.equal(result.executed, true);
  assert.equal(result.totalRows, plan.totalRows, "row totals must match preview");

  // legacy target groups
  assert.equal(counts(ctx.db, "session"), 1, "one legacy session left (ses_L3)");
  assert.equal(counts(ctx.db, "message"), 2, "ses_L3 messages kept");
  assert.equal(counts(ctx.db, "part"), 2, "ses_L3 parts kept");
  assert.equal(counts(ctx.db, "todo"), 1);
  assert.equal(counts(ctx.db, "session_share"), 1);
  assert.equal(counts(ctx.db, "event"), 1);
  assert.equal(counts(ctx.db, "event_sequence"), 1);

  // v2 target groups (kept: Vmain + migrated copies L1/L2 + VsubNew + Vsusp)
  assert.equal(counts(ctx.db, "session_v2"), 5, "Vmain, L1/L2 copies, VsubNew, Vsusp kept");
  assert.equal(counts(ctx.db, "session_message"), 3, "subnew+susp+main messages kept");
  assert.equal(counts(ctx.db, "session_part"), 0, "purged session's parts gone");
  assert.equal(counts(ctx.db, "session_inbox"), 0);
  assert.equal(counts(ctx.db, "instruction_entry"), 0);
  assert.equal(counts(ctx.db, "instruction_state"), 0);
  assert.equal(counts(ctx.db, "blob_ref"), 1, "b2 ref kept");
  assert.equal(counts(ctx.db, "blob"), 1, "b2 kept; b1 orphaned & deleted");
  assert.equal(counts(ctx.db, "job"), 0);
  assert.equal(counts(ctx.db, "schedule"), 0);
});

test("suspended subagent is never deleted even when old", () => {
  executePurge(ctx.db, ctx.tables, { cutoff: CUTOFF, dryRun: false });
  const row = ctx.db.prepare("SELECT id FROM session_v2 WHERE id = 'ses_Vsusp'").get();
  assert.ok(row, "suspended session survives");
  assert.equal(counts(ctx.db, "session_message"), 3, "its messages survive");
});

test("main sessions are never deleted regardless of age", () => {
  executePurge(ctx.db, ctx.tables, { cutoff: CUTOFF, dryRun: false });
  for (const id of ["ses_Vmain", "ses_L3"]) {
    assert.ok(ctx.db.prepare("SELECT 1 FROM session_v2 WHERE id = ?").get("ses_Vmain"), "v2 main kept");
  }
  assert.ok(ctx.db.prepare("SELECT 1 FROM session WHERE id = 'ses_L3'").get(), "legacy session without v2 copy kept");
  assert.ok(ctx.db.prepare("SELECT 1 FROM session WHERE id = 'ses_L1'").get() === undefined, "legacy session with v2 copy deleted");
});

test("recent v2 subagent survives the cutoff", () => {
  executePurge(ctx.db, ctx.tables, { cutoff: CUTOFF, dryRun: false });
  assert.ok(ctx.db.prepare("SELECT 1 FROM session_v2 WHERE id = 'ses_VsubNew'").get());
});

test("dry-run executePurge is identical to purgePlan and writes nothing", () => {
  const before = ["session", "message", "part", "session_v2", "session_message", "blob"].map((t) => counts(ctx.db, t));
  const r = executePurge(ctx.db, ctx.tables, { cutoff: CUTOFF, dryRun: true });
  assert.equal(r.executed, false);
  assert.equal(r.plan.totalRows, 30);
  const after = ["session", "message", "part", "session_v2", "session_message", "blob"].map((t) => counts(ctx.db, t));
  assert.deepEqual(after, before);
});

test("missing optional tables are handled gracefully (schema evolution)", () => {
  ctx.db.exec("DROP TABLE job");
  ctx.db.exec("DROP TABLE schedule");
  ctx.db.exec("DROP TABLE event");
  ctx.tables = new Set([...ctx.tables].filter((t) => !["job", "schedule", "event"].includes(t)));
  const plan = purgePlan(ctx.db, ctx.tables, { cutoff: CUTOFF });
  assert.equal(plan.v2.job, null);
  assert.equal(plan.v2.schedule, null);
  assert.equal(plan.legacy.event, null);
  const r = executePurge(ctx.db, ctx.tables, { cutoff: CUTOFF, dryRun: false });
  assert.equal(r.totalRows, 30 - 5, "job(2) + schedule(1) + event(2) rows are missing from the total");
});

test("legacy purge is a no-op when session_v2 table does not exist", () => {
  ctx.db.exec("DROP TABLE blob_ref");
  ctx.db.exec("DROP TABLE session_v2");
  ctx.tables = new Set([...ctx.tables].filter((t) => t !== "blob_ref" && t !== "session_v2"));
  const plan = purgePlan(ctx.db, ctx.tables, { cutoff: CUTOFF });
  assert.equal(plan.legacy.sessions, 0, "no candidates without copy verification");
  assert.equal(plan.v2, null);
  const before = counts(ctx.db, "session");
  executePurge(ctx.db, ctx.tables, { cutoff: CUTOFF, dryRun: false });
  assert.equal(counts(ctx.db, "session"), before, "nothing deleted");
});

test("cutoff boundary: session updated exactly at cutoff-1 is purged, at cutoff is kept", () => {
  ctx.db.prepare("INSERT INTO session_v2 (id, parent_id, time_created, time_updated) VALUES ('ses_B1', 'ses_Vmain', ?, ?)").run(OLD, CUTOFF - 1);
  ctx.db.prepare("INSERT INTO session_v2 (id, parent_id, time_created, time_updated) VALUES ('ses_B2', 'ses_Vmain', ?, ?)").run(OLD, CUTOFF);
  ctx.db.prepare("INSERT INTO session_message (id, session_id, seq, time_created, time_updated, data) VALUES ('b1m', 'ses_B1', 0, ?, ?, 'x')").run(CUTOFF - 1, CUTOFF - 1);
  ctx.db.prepare("INSERT INTO session_message (id, session_id, seq, time_created, time_updated, data) VALUES ('b2m', 'ses_B2', 0, ?, ?, 'x')").run(CUTOFF, CUTOFF);
  executePurge(ctx.db, ctx.tables, { cutoff: CUTOFF, dryRun: false });
  assert.ok(!ctx.db.prepare("SELECT 1 FROM session_v2 WHERE id='ses_B1'").get(), "just-before-cutoff purged");
  assert.ok(ctx.db.prepare("SELECT 1 FROM session_v2 WHERE id='ses_B2'").get(), "at-cutoff kept");
});
