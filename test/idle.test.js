import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { detectProcessRunning, dbActivity, isDbQuiet, waitForIdle } from "../lib/idle.js";
import { createFixtureDb, makeTempDir, NOW } from "./helpers/fixture.js";

const cleanup = (dir) => fs.rmSync(dir, { recursive: true, force: true });

// ---------- process detection ----------

test("win32: tasklist line matching opencode images => running", () => {
  const exec = () => ({ status: 0, stdout: `"OpenCode.exe","1234"\r\n"node.exe","5678"\r\n` });
  assert.equal(detectProcessRunning({ platform: "win32", exec }), true);
});

test("win32: opencode-cli.exe matches too", () => {
  const exec = () => ({ status: 0, stdout: `"opencode-cli.exe","42"\r\n` });
  assert.equal(detectProcessRunning({ platform: "win32", exec }), true);
});

test("win32: no opencode images => not running", () => {
  const exec = () => ({ status: 0, stdout: `"explorer.exe","900"\r\n"node.exe","901"\r\n` });
  assert.equal(detectProcessRunning({ platform: "win32", exec }), false);
});

test("win32: unrelated names containing 'open' do not match", () => {
  const exec = () => ({ status: 0, stdout: `"openoffice.exe","7"\r\n` });
  assert.equal(detectProcessRunning({ platform: "win32", exec }), false);
});

test("win32: tasklist failure => assume not running", () => {
  const exec = () => ({ status: 1, stdout: "" });
  assert.equal(detectProcessRunning({ platform: "win32", exec }), false);
});

test("posix: self+parent pids filtered out", () => {
  const exec = () => ({ status: 0, stdout: "111\n222\n" });
  assert.equal(detectProcessRunning({ platform: "linux", selfPid: 111, parentPid: 222, exec }), false, "only self+parent => not running");
  const exec2 = () => ({ status: 0, stdout: "111\n999\n" });
  assert.equal(detectProcessRunning({ platform: "linux", selfPid: 111, parentPid: 222, exec: exec2 }), true);
});

test("posix: pgrep missing from PATH => assume not running", () => {
  const exec = () => {
    throw Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
  };
  assert.equal(detectProcessRunning({ platform: "linux", exec }), false);
});

// ---------- DB activity ----------

test("dbActivity: recent session_message write => active", () => {
  const dir = makeTempDir();
  const { db, tables } = createFixtureDb(dir);
  db.prepare("INSERT INTO session_v2 (id, parent_id, time_created, time_updated) VALUES ('ses_hot', NULL, ?, ?)").run(NOW, NOW);
  db.prepare("INSERT INTO session_message (id, session_id, seq, time_created, time_updated, data) VALUES ('hot_msg', 'ses_hot', 0, ?, ?, 'x')").run(NOW - 5000, NOW - 5000);
  const a = dbActivity(db, tables, { now: NOW, windowMs: 120000 });
  assert.equal(a.active, true);
  assert.equal(a.recentWrites, 1);
  assert.ok(a.lastWriteAgoSec < 120);
  db.close();
  cleanup(dir);
});

test("dbActivity: only old writes => inactive", () => {
  const dir = makeTempDir();
  const { db, tables } = createFixtureDb(dir);
  const a = dbActivity(db, tables, { now: NOW, windowMs: 120000 }); // fixture writes are 40d old
  assert.equal(a.active, false);
  db.close();
  cleanup(dir);
});

test("dbActivity: busy session marker counts as active", () => {
  const dir = makeTempDir();
  const { db, tables } = createFixtureDb(dir);
  db.prepare("INSERT INTO session_v2 (id, parent_id, time_created, time_updated, time_busy) VALUES ('ses_busy', NULL, ?, ?, ?)").run(NOW, NOW, NOW - 1000);
  const a = dbActivity(db, tables, { now: NOW, windowMs: 120000 });
  assert.equal(a.active, true);
  assert.equal(a.busySessions, 1);
  db.close();
  cleanup(dir);
});

// ---------- quiescence probe ----------

test("isDbQuiet on a fresh writable WAL db with no other connections", () => {
  const dir = makeTempDir();
  const { db } = createFixtureDb(dir, { wal: true });
  assert.equal(isDbQuiet(db), true);
  db.close();
  cleanup(dir);
});

// ---------- waitForIdle state machine ----------

test("waitForIdle returns immediately when already idle", async () => {
  let polls = 0;
  const r = await waitForIdle({ check: () => (polls++, { idle: true }), intervalMs: 1, maxWaitMs: 100, sleep: async () => {} });
  assert.equal(r.idle, true);
  assert.equal(r.timedOut, false);
  assert.equal(polls, 1);
});

test("waitForIdle keeps polling until idle", async () => {
  let polls = 0;
  const r = await waitForIdle({
    check: () => ({ idle: ++polls >= 3 }),
    intervalMs: 1,
    maxWaitMs: 10000,
    sleep: async () => {},
  });
  assert.equal(r.idle, true);
  assert.equal(polls, 3);
});

test("waitForIdle times out and reports PURGE_ONLY precondition", async () => {
  let polls = 0;
  const r = await waitForIdle({ check: () => (polls++, { idle: false }), intervalMs: 10, maxWaitMs: 50, sleep: async () => {} });
  assert.equal(r.idle, false);
  assert.equal(r.timedOut, true);
  assert.ok(polls >= 1);
});
