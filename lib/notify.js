import { spawnSync } from "node:child_process";

/**
 * Desktop notification, gated to avoid fatigue:
 *  - FAILED or PARTIAL always notify
 *  - SUCCESS notifies only when freedMB >= minFreedMB
 *  - disabled config never notifies
 * Zero dependencies: WinRT toast via built-in PowerShell (tray balloon as
 * fallback), osascript on macOS, notify-send on Linux.
 */

const PS_TOAST = (title, body) => `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType=WindowsRuntime] | Out-Null;
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType=WindowsRuntime] | Out-Null;
$t = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02);
$x = $t.GetElementsByTagName('text');
$x.Item(0).AppendChild($t.CreateTextNode('${escPs(title)}')) | Out-Null;
$x.Item(1).AppendChild($t.CreateTextNode('${escPs(body)}')) | Out-Null;
$n = [Windows.UI.Notifications.ToastNotification]::new($t);
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier('{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe').Show($n);
`;

const PS_BALLOON = (title, body) => `
Add-Type -AssemblyName System.Windows.Forms | Out-Null;
Add-Type -AssemblyName System.Drawing | Out-Null;
$n = New-Object System.Windows.Forms.NotifyIcon;
$n.Icon = [System.Drawing.SystemIcons]::Information;
$n.Visible = $true;
$n.ShowBalloonTip(8000, '${escPs(title)}', '${escPs(body)}', [System.Windows.Forms.ToolTipIcon]::Info);
Start-Sleep -Seconds 9;
$n.Dispose();
`;

function escPs(s) {
  return String(s).replace(/'/g, "''");
}

function singleLine(s) {
  return String(s).replace(/\s*\n\s*/g, " ").trim();
}

/** Should we notify for this run? */
export function shouldNotify({ state, freedMB = 0, enabled = true, minFreedMB = 100 }) {
  if (!enabled) return false;
  if (state === "FAILED" || state === "PARTIAL") return true;
  if (state === "SUCCESS") return freedMB >= minFreedMB;
  return false;
}

/** Fire a desktop notification. Returns { ok, detail }. Never throws. */
export function notify({ title, body }, { platform = process.platform, runner = spawnSync } = {}) {
  try {
    title = singleLine(title);
    body = singleLine(body);
    if (platform === "win32") {
      let r = runner("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", PS_TOAST(title, body)], {
        windowsHide: true,
        timeout: 20000,
      });
      if (r.status === 0) return { ok: true, channel: "toast" };
      r = runner("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", PS_BALLOON(title, body)], {
        windowsHide: true,
        timeout: 20000,
      });
      return { ok: r.status === 0, channel: "balloon" };
    }
    if (platform === "darwin") {
      const script = `display notification ${qq(body)} with title ${qq(title)}`;
      const r = runner("osascript", ["-e", script], { timeout: 10000 });
      return { ok: r.status === 0, channel: "osascript" };
    }
    // linux & everything else
    const r = runner("notify-send", [title, body], { timeout: 10000 });
    return { ok: r.status === 0, channel: "notify-send" };
  } catch (err) {
    return { ok: false, channel: "none", error: err.message };
  }
}

function qq(s) {
  return `"${String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
