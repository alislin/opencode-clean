import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldNotify, notify } from "../lib/notify.js";

// ---------- gating ----------

test("FAILED and PARTIAL always notify when enabled", () => {
  assert.equal(shouldNotify({ state: "FAILED", freedMB: 0, enabled: true }), true);
  assert.equal(shouldNotify({ state: "PARTIAL", freedMB: 0, enabled: true }), true);
});

test("SUCCESS notifies only above the threshold", () => {
  assert.equal(shouldNotify({ state: "SUCCESS", freedMB: 99, enabled: true, minFreedMB: 100 }), false);
  assert.equal(shouldNotify({ state: "SUCCESS", freedMB: 100, enabled: true, minFreedMB: 100 }), true);
  assert.equal(shouldNotify({ state: "SUCCESS", freedMB: 1500, enabled: true, minFreedMB: 100 }), true);
});

test("disabled config never notifies", () => {
  assert.equal(shouldNotify({ state: "FAILED", freedMB: 9999, enabled: false }), false);
});

// ---------- platform dispatch (runner mocked) ----------

function recordingRunner() {
  const calls = [];
  const runner = (file, args, opts) => {
    calls.push({ file, args, opts });
    return { status: 0 };
  };
  return { calls, runner };
}

test("win32 uses built-in PowerShell toast with title/body", () => {
  const { calls, runner } = recordingRunner();
  const r = notify({ title: "清理完成", body: "释放 1400 MB" }, { platform: "win32", runner });
  assert.equal(r.ok, true);
  assert.equal(r.channel, "toast");
  assert.equal(calls.length, 1);
  assert.match(calls[0].file, /powershell\.exe$/i);
  const script = calls[0].args[calls[0].args.indexOf("-Command") + 1];
  assert.ok(script.includes("ToastNotificationManager"));
  assert.ok(script.includes("清理完成"));
  assert.ok(script.includes("释放 1400 MB"));
});

test("win32 toast failure falls back to tray balloon", () => {
  let n = 0;
  const runner = () => ({ status: n++ === 0 ? 1 : 0 });
  const r = notify({ title: "t", body: "b" }, { platform: "win32", runner });
  assert.equal(r.ok, true);
  assert.equal(r.channel, "balloon");
});

test("darwin uses osascript with quoted strings", () => {
  const { calls, runner } = recordingRunner();
  const r = notify({ title: 'he said "hi"', body: "done" }, { platform: "darwin", runner });
  assert.equal(r.ok, true);
  assert.equal(r.channel, "osascript");
  assert.equal(calls[0].file, "osascript");
  const script = calls[0].args[1];
  assert.ok(script.includes('display notification "done" with title "he said \\"hi\\""'));
});

test("linux uses notify-send with [title, body]", () => {
  const { calls, runner } = recordingRunner();
  const r = notify({ title: "T", body: "B" }, { platform: "linux", runner });
  assert.equal(r.ok, true);
  assert.equal(r.channel, "notify-send");
  assert.deepEqual(calls[0].args, ["T", "B"]);
});

test("multi-line body is flattened to a single line", () => {
  const { calls, runner } = recordingRunner();
  notify({ title: "t", body: "line1\nline2\nline3" }, { platform: "darwin", runner });
  const script = calls[0].args[1];
  assert.ok(!script.includes("\n"), "osascript arg must be single line");
});

test("PS single quotes are escaped in the toast script", () => {
  const { calls, runner } = recordingRunner();
  notify({ title: "it's fine", body: "b" }, { platform: "win32", runner });
  const script = calls[0].args[calls[0].args.indexOf("-Command") + 1];
  assert.ok(script.includes("it''s fine"), "single quote doubled");
  assert.ok(!script.includes("it's fine"));
});

test("runner throwing is swallowed and reported", () => {
  const runner = () => {
    throw new Error("no desktop");
  };
  const r = notify({ title: "t", body: "b" }, { platform: "linux", runner });
  assert.equal(r.ok, false);
  assert.ok(r.error);
});
