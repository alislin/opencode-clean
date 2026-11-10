import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  windowsTaskXml,
  darwinPlist,
  crontabLines,
  crontabAdd,
  crontabRemove,
  crontabHas,
  register,
  unregister,
  status,
  WIN_TASK_NAME,
  TASK_LABEL,
} from "../lib/schedule.js";

const NODE = "C:\\Program Files\\node.exe";
const SCRIPT = "C:\\repos\\opencode-clean\\bin\\ocgc-clean.js";

// ---------- windows XML ----------

test("windows task XML: trigger, settings, and command line", () => {
  const xml = windowsTaskXml({ nodePath: NODE, scriptPath: SCRIPT });
  assert.ok(xml.includes("<Command>C:\\Program Files\\node.exe</Command>"));
  assert.ok(xml.includes(`&quot;`) === false);
  assert.ok(xml.includes('"C:\\repos\\opencode-clean\\bin\\ocgc-clean.js" --yes'), "script path quoted + --yes");
  assert.ok(xml.includes("<Sunday />"));
  assert.ok(xml.includes("2026-01-04T03:00:00"), "a Sunday at 03:00");
  assert.ok(xml.includes("<StartWhenAvailable>true</StartWhenAvailable>"), "catch-up after missed schedule");
  assert.ok(xml.includes("PT1H"), "execution time limit 1h");
  assert.ok(xml.includes("IgnoreNew"));
  assert.ok(xml.includes("InteractiveToken"));
});

test("windows task XML escapes XML-special characters in paths", () => {
  const xml = windowsTaskXml({ nodePath: "C:\\a<b>&c\\node.exe", scriptPath: SCRIPT });
  assert.ok(xml.includes("C:\\a&lt;b&gt;&amp;c\\node.exe"));
});

// ---------- crontab transforms ----------

test("crontab add into empty crontab produces weekly + reboot lines with markers", () => {
  const lines = crontabLines({ nodePath: "/usr/bin/node", scriptPath: "/home/u/.opencode/ocgc/ocgc-clean.js" });
  const out = crontabAdd("", lines);
  assert.equal(crontabHas(out), true);
  assert.ok(out.includes("0 3 * * 0 /usr/bin/node /home/u/.opencode/ocgc/ocgc-clean.js --yes"));
  assert.ok(out.includes("@reboot /usr/bin/node /home/u/.opencode/ocgc/ocgc-clean.js --yes --if-stale"));
  assert.ok(out.includes(`# ${TASK_LABEL}`));
});

test("crontab add is idempotent (double add yields one block)", () => {
  const lines = crontabLines({ nodePath: "/usr/bin/node", scriptPath: "/x.js" });
  const once = crontabAdd("", lines);
  const twice = crontabAdd(once, lines);
  const markerCount = twice.split("\n").filter((l) => l.includes(`# ${TASK_LABEL}`)).length;
  assert.equal(markerCount, 2, "weekly + reboot markers, not duplicated");
  assert.ok(!twice.endsWith("\n\n\n"));
});

test("crontab remove strips only marker lines, preserving user jobs", () => {
  const userJob = "5 4 * * * backup.sh";
  const withJob = crontabAdd(`${userJob}\n`, crontabLines({ nodePath: "/usr/bin/node", scriptPath: "/x.js" }));
  const out = crontabRemove(withJob);
  assert.equal(crontabHas(out), false);
  assert.ok(out.includes(userJob));
});

test("crontab remove on unrelated crontab is a no-op", () => {
  const text = "5 4 * * * backup.sh\n";
  assert.equal(crontabRemove(text), text);
});

// ---------- darwin plist ----------

test("darwin plist: label, program args, Sunday 03:00", () => {
  const plist = darwinPlist({ nodePath: "/usr/local/bin/node", scriptPath: "/Users/u/x.js" });
  assert.ok(plist.includes(`<string>${TASK_LABEL}</string>`));
  assert.ok(plist.includes("<string>/usr/local/bin/node</string>"));
  assert.ok(plist.includes("<string>/Users/u/x.js</string>"));
  assert.ok(plist.includes("<string>--yes</string>"));
  assert.ok(plist.includes("<key>Hour</key><integer>3</integer>"));
  assert.ok(plist.includes("<key>Weekday</key><integer>0</integer>"), "0 = Sunday in launchd");
});

// ---------- register/status/unregister with mocked exec+fs ----------

function fakeDeps() {
  const calls = [];
  const files = new Map();
  let cronText = "5 4 * * * backup.sh\n"; // stateful crontab
  return {
    calls,
    deps: {
      exec: (file, args, opts) => {
        calls.push({ file, args, opts });
        if (file === "schtasks" && args[0] === "/Query") return { status: 0, stdout: "" };
        if (file === "crontab" && args.length === 1 && args[0] === "-l") return { status: 0, stdout: cronText };
        if (file === "crontab" && args.length === 0) {
          cronText = opts?.input ?? cronText;
          return { status: 0, stdout: "" };
        }
        if (file === "id") return { status: 0, stdout: "501" };
        return { status: 0, stdout: "", stderr: "" };
      },
      writeFile: (p, c, o) => files.set(p, { c, o }),
      readFile: (p) => {
        if (!files.has(p)) throw new Error("enoent");
        return files.get(p).c;
      },
      exists: (p) => files.has(p),
      rm: (p) => files.delete(p),
      mkdir: () => {},
      homedir: () => "/Users/tester",
    },
    files,
  };
}

test("windows register writes UTF-16 XML and calls schtasks /Create; status and unregister follow", () => {
  const { calls, deps, files } = fakeDeps();
  const r = register({ platform: "win32", nodePath: NODE, scriptPath: SCRIPT, dataDir: "D:\\data" }, deps);
  assert.equal(r.ok, true);
  const xmlCall = calls.find((c) => c.file === "schtasks" && c.args[0] === "/Create");
  assert.ok(xmlCall, "schtasks /Create invoked");
  assert.deepEqual(xmlCall.args.slice(1), ["/F", "/TN", WIN_TASK_NAME, "/XML", path.join("D:\\data", "task.xml")]);
  const xmlEntry = [...files.values()][0];
  assert.equal(xmlEntry.o, "utf16le");
  assert.ok(xmlEntry.c.startsWith("\ufeff"), "BOM for UTF-16");

  assert.equal(status({ platform: "win32", dataDir: "D:\\data" }, deps).registered, true);

  calls.length = 0;
  const u = unregister({ platform: "win32", dataDir: "D:\\data" }, deps);
  assert.equal(u.ok, true);
  assert.ok(calls.some((c) => c.file === "schtasks" && c.args[0] === "/Delete"));
});

test("linux register appends to existing crontab preserving user jobs; unregister cleans up", () => {
  const { calls, deps } = fakeDeps();
  const r = register({ platform: "linux", nodePath: "/usr/bin/node", scriptPath: "/x.js", dataDir: "/tmp" }, deps);
  assert.equal(r.ok, true);
  const writeCall = calls.find((c) => c.file === "crontab" && c.args.length === 0);
  const written = writeCall.opts.input;
  assert.ok(written.includes("5 4 * * * backup.sh"), "user job preserved");
  assert.ok(written.includes("/x.js --yes"), "our job added");

  assert.equal(status({ platform: "linux", dataDir: "/tmp" }, deps).registered, true);

  const u = unregister({ platform: "linux", dataDir: "/tmp" }, deps);
  assert.equal(u.ok, true);
  const after = calls.filter((c) => c.file === "crontab" && c.args.length === 0).at(-1).opts.input;
  assert.ok(after.includes("backup.sh"));
  assert.ok(!after.includes(TASK_LABEL));
});

test("darwin register writes plist under ~/Library/LaunchAgents and bootstraps", () => {
  const { calls, deps, files } = fakeDeps();
  const r = register({ platform: "darwin", nodePath: "/usr/bin/node", scriptPath: "/x.js", dataDir: "/tmp" }, deps);
  assert.equal(r.ok, true);
  const plistPath = [...files.keys()].find((k) => k.endsWith(`${TASK_LABEL}.plist`));
  assert.ok(plistPath, "plist written");
  assert.ok(plistPath.includes(path.join("Library", "LaunchAgents")), "under ~/Library/LaunchAgents");
  assert.ok(calls.some((c) => c.file === "launchctl" && c.args[0] === "bootout"), "old agent unloaded first");
  assert.ok(calls.some((c) => c.file === "launchctl" && c.args[0] === "bootstrap"));
});
