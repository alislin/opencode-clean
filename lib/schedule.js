import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

/**
 * Scheduling per platform, all entry points being:
 *   <node.exe> <this script> --yes [--extra]
 * so the task never depends on PATH or shell quoting.
 *
 *  Windows : schtasks + generated XML (weekly Sunday 03:00, StartWhenAvailable)
 *  macOS   : launchd LaunchAgent plist (StartCalendarInterval)
 *  Linux   : crontab lines tagged with a marker (weekly + @reboot --if-stale)
 */

export const WIN_TASK_NAME = "OpenCode Clean";
export const TASK_LABEL = "com.opencode.clean";
const MARKER = `# ${TASK_LABEL}`;

// ---------- pure builders (unit-tested) ----------

export function windowsTaskXml({ nodePath, scriptPath, extraArgs = ["--yes"] }) {
  const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const args = [`"${esc(scriptPath)}"`, ...extraArgs].join(" ");
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo><Description>opencode-clean weekly maintenance (semantic purge + safe VACUUM)</Description></RegistrationInfo>
  <Triggers>
    <CalendarTrigger>
      <StartBoundary>2026-01-04T03:00:00</StartBoundary>
      <Enabled>true</Enabled>
      <ScheduleByWeek>
        <WeeksInterval>1</WeeksInterval>
        <DaysOfWeek><Sunday /></DaysOfWeek>
      </ScheduleByWeek>
    </CalendarTrigger>
  </Triggers>
  <Principal>
    <LogonType>InteractiveToken</LogonType>
    <RunLevel>LeastPrivilege</RunLevel>
  </Principal>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT1H</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${esc(nodePath)}</Command>
      <Arguments>${esc(args)}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

export function darwinPlist({ nodePath, scriptPath, extraArgs = ["--yes"] }) {
  const programArgs = [nodePath, scriptPath, ...extraArgs]
    .map((s) => `    <string>${String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${TASK_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${programArgs}
  </array>
  <key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key><integer>3</integer>
    <key>Minute</key><integer>0</integer>
    <key>Weekday</key><integer>0</integer>
  </dict>
  <key>StandardOutPath</key><string>/tmp/${TASK_LABEL}.out</string>
  <key>StandardErrorPath</key><string>/tmp/${TASK_LABEL}.err</string>
</dict>
</plist>
`;
}

export function crontabLines({ nodePath, scriptPath, extraArgs = ["--yes"] }) {
  const base = `${nodePath} ${scriptPath} ${extraArgs.join(" ")}`;
  return [
    `0 3 * * 0 ${base} ${MARKER}`,
    `@reboot ${base} --if-stale ${MARKER}-reboot`,
  ];
}

export function crontabHas(text) {
  return String(text).includes(MARKER);
}

/** Idempotent add: replaces any previous marker block, keeps unrelated lines. */
export function crontabAdd(text, lines) {
  const kept = String(text)
    .split("\n")
    .filter((l) => !l.includes(MARKER));
  while (kept.length && kept[kept.length - 1] === "") kept.pop();
  return [...kept, ...lines, ""].join("\n");
}

/** Remove all marker lines, keep everything else. */
export function crontabRemove(text) {
  return (
    String(text)
      .split("\n")
      .filter((l) => !l.includes(MARKER))
      .join("\n")
      .replace(/\n+$/, "\n")
  );
}

// ---------- side-effectful operations (deps injectable) ----------

const defaultDeps = () => ({
  exec: spawnSync,
  readFile: (p) => fs.readFileSync(p, "utf8"),
  writeFile: (p, c, o) => fs.writeFileSync(p, c, o),
  rm: (p) => fs.rmSync(p, { force: true }),
  exists: fs.existsSync,
  mkdir: (p) => fs.mkdirSync(p, { recursive: true }),
  homedir: os.homedir,
  scriptPath: null, // caller passes; see register()
});

function scriptArgs() {
  return ["--yes"];
}

export function register({ platform = process.platform, nodePath, scriptPath, dataDir }, deps = {}) {
  const d = { ...defaultDeps(), ...deps };
  if (platform === "win32") {
    const xmlPath = path.join(dataDir, "task.xml");
    d.mkdir(dataDir);
    d.writeFile(xmlPath, "\ufeff" + windowsTaskXml({ nodePath, scriptPath, extraArgs: scriptArgs() }), "utf16le");
    const r = d.exec("schtasks", ["/Create", "/F", "/TN", WIN_TASK_NAME, "/XML", xmlPath], { windowsHide: true });
    return { ok: r.status === 0, detail: r.stderr?.toString() || r.stdout?.toString() || "schtasks /Create" };
  }
  if (platform === "darwin") {
    const dir = path.join(d.homedir(), "Library", "LaunchAgents");
    d.mkdir(dir);
    const plistPath = path.join(dir, `${TASK_LABEL}.plist`);
    d.writeFile(plistPath, darwinPlist({ nodePath, scriptPath, extraArgs: scriptArgs() }));
    const uid = d.exec("id", ["-u"], { encoding: "utf8" }).stdout?.trim() || "501";
    d.exec("launchctl", ["bootout", `gui/${uid}/${TASK_LABEL}`], { windowsHide: true }); // ignore "not loaded"
    const r = d.exec("launchctl", ["bootstrap", `gui/${uid}`, plistPath], { windowsHide: true });
    return { ok: r.status === 0, detail: r.stderr?.toString() || `bootstrapped ${plistPath}` };
  }
  // linux
  const cur = d.exec("crontab", ["-l"], { encoding: "utf8", windowsHide: true });
  const curText = cur.status === 0 ? String(cur.stdout ?? "") : "";
  const next = crontabAdd(curText, crontabLines({ nodePath, scriptPath, extraArgs: scriptArgs() }));
  const r = d.exec("crontab", [], { input: next, encoding: "utf8", windowsHide: true });
  return { ok: r.status === 0, detail: r.stderr?.toString() || "crontab updated" };
}

export function unregister({ platform = process.platform, dataDir }, deps = {}) {
  const d = { ...defaultDeps(), ...deps };
  if (platform === "win32") {
    const r = d.exec("schtasks", ["/Delete", "/F", "/TN", WIN_TASK_NAME], { windowsHide: true });
    return { ok: r.status === 0, detail: r.stderr?.toString() || "schtasks /Delete" };
  }
  if (platform === "darwin") {
    const uid = d.exec("id", ["-u"], { encoding: "utf8" }).stdout?.trim() || "501";
    const r = d.exec("launchctl", ["bootout", `gui/${uid}/${TASK_LABEL}`], { windowsHide: true });
    const plistPath = path.join(d.homedir(), "Library", "LaunchAgents", `${TASK_LABEL}.plist`);
    d.rm(plistPath);
    return { ok: r.status === 0 || /not loaded/i.test(String(r.stderr)), detail: "bootout + plist removed" };
  }
  const cur = d.exec("crontab", ["-l"], { encoding: "utf8", windowsHide: true });
  const curText = cur.status === 0 ? String(cur.stdout ?? "") : "";
  if (!crontabHas(curText)) return { ok: true, detail: "no marker lines" };
  const r = d.exec("crontab", [], { input: crontabRemove(curText), encoding: "utf8", windowsHide: true });
  return { ok: r.status === 0, detail: r.stderr?.toString() || "crontab updated" };
}

export function status({ platform = process.platform, dataDir }, deps = {}) {
  const d = { ...defaultDeps(), ...deps };
  if (platform === "win32") {
    const r = d.exec("schtasks", ["/Query", "/TN", WIN_TASK_NAME], { windowsHide: true });
    return { registered: r.status === 0 };
  }
  if (platform === "darwin") {
    return { registered: d.exists(path.join(d.homedir(), "Library", "LaunchAgents", `${TASK_LABEL}.plist`)) };
  }
  const cur = d.exec("crontab", ["-l"], { encoding: "utf8", windowsHide: true });
  return { registered: cur.status === 0 && crontabHas(String(cur.stdout ?? "")) };
}
