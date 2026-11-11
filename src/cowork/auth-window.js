import { spawn } from "node:child_process";
import { coworkError } from "./profile.js";

// The owner has its own message loop. stdin is a lifetime lease: when the
// helper exits, EOF closes the window even if JavaScript cleanup never ran.
const WINDOW_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
try {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
public static class AerialAuthOwnerControl {
  [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr handle, int command);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr handle);
  public static Task<string> StartRead() {
    return Task.Run(() => Console.ReadLine());
  }
  public static bool ShowOwner(IntPtr handle) {
    ShowWindow(handle, 5);
    return IsWindowVisible(handle);
  }
}
'@
  [System.Windows.Forms.Application]::EnableVisualStyles()
  $form = New-Object System.Windows.Forms.Form
  $form.Text = 'Aerial — Microsoft sign-in'
  $form.ClientSize = New-Object System.Drawing.Size(400, 110)
  $form.StartPosition = 'CenterScreen'
  $form.FormBorderStyle = 'FixedDialog'
  $form.MaximizeBox = $false
  $form.MinimizeBox = $false
  $form.ShowIcon = $false
  $label = New-Object System.Windows.Forms.Label
  $label.Dock = 'Fill'
  $label.Padding = New-Object System.Windows.Forms.Padding(16)
  $label.Text = 'Complete Microsoft sign-in in the account dialog.' + [Environment]::NewLine + 'Close this window to cancel authentication.'
  $form.Controls.Add($label)
  $script:parentClosed = $false
  $script:visibilityFailed = $false
  # Console.In is a synchronized TextReader on .NET Framework; its
  # ReadLineAsync can block before the UI starts. Use a managed worker.
  $controlRead = [AerialAuthOwnerControl]::StartRead()
  $timer = New-Object System.Windows.Forms.Timer
  $timer.Interval = 200
  $timer.add_Tick({
    if ($controlRead.IsCompleted) {
      $script:parentClosed = $true
      $form.Close()
    }
  })
  $form.add_Shown({
    # windowsHide sets STARTUPINFO/SW_HIDE for the PowerShell console. Windows
    # can also apply it to the form's first ShowWindow, despite WinForms Shown.
    # A second explicit show affects only this owned form, never the console.
    if (-not [AerialAuthOwnerControl]::ShowOwner($form.Handle)) {
      $script:visibilityFailed = $true
      $form.Close()
      return
    }
    $form.Activate()
    [Console]::Out.WriteLine($form.Handle.ToInt64().ToString([Globalization.CultureInfo]::InvariantCulture))
    [Console]::Out.Flush()
  })
  $timer.Start()
  [System.Windows.Forms.Application]::Run($form)
  $timer.Stop()
  $timer.Dispose()
  $form.Dispose()
  if ($script:visibilityFailed) { exit 2 }
  if ($script:parentClosed) { exit 0 }
  exit 20
} catch {
  exit 2
}
`;

function parseHandle(value, arch) {
  if (!["ia32", "x64", "arm64"].includes(arch) || !/^[1-9][0-9]{0,19}$/.test(value)) throw coworkError("AUTH_WINDOW_FAILED", "The Microsoft sign-in owner returned an invalid window handle.");
  const number = BigInt(value);
  const bytes = arch === "ia32" ? 4 : 8;
  if (number > (bytes === 4 ? 0xffff_ffffn : 0x7fff_ffff_ffff_ffffn)) throw coworkError("AUTH_WINDOW_FAILED", "The Microsoft sign-in window handle does not fit the current architecture.");
  const handle = Buffer.alloc(bytes);
  if (bytes === 4) handle.writeUInt32LE(Number(number)); else handle.writeBigUInt64LE(number);
  return handle;
}

export async function openAuthWindow({
  signal, spawnProcess = spawn, platform = process.platform, arch = process.arch,
  startupTimeoutMs = 10_000, closeTimeoutMs = 2000
} = {}) {
  if (platform !== "win32") throw coworkError("AUTH_WINDOW_FAILED", "The Microsoft sign-in owner currently requires Windows.");
  signal?.throwIfAborted();
  let child;
  try {
    child = spawnProcess("powershell.exe", ["-NoProfile", "-STA", "-NonInteractive", "-Command", WINDOW_SCRIPT], {
      windowsHide: true, stdio: ["pipe", "pipe", "ignore"]
    });
  } catch { throw coworkError("AUTH_WINDOW_FAILED", "Unable to start the Microsoft sign-in owner."); }

  let resolveClosed;
  const closed = new Promise((resolve) => { resolveClosed = resolve; });
  let resolveStartup, rejectStartup;
  const startup = new Promise((resolve, reject) => { resolveStartup = resolve; rejectStartup = reject; });
  let finished = false;
  let ready = false;
  let output = "";
  let outputBytes = 0;
  let closeReason;
  let closePromise;
  let startupTimer;
  let forceTimer;
  let cleanupTimer;
  const failed = (message) => coworkError("AUTH_WINDOW_FAILED", message);

  const beginClose = (reason = "parent") => {
    if (closePromise) return closePromise;
    closeReason = reason;
    closePromise = new Promise((resolve, reject) => {
      closed.then(() => { clearTimeout(forceTimer); clearTimeout(cleanupTimer); resolve(); });
      if (finished) return;
      try { child.stdin.end("close\n"); } catch { child.kill(); }
      forceTimer = setTimeout(() => {
        child.kill();
        cleanupTimer = setTimeout(() => reject(failed("The Microsoft sign-in owner did not exit after shutdown.")), closeTimeoutMs);
      }, closeTimeoutMs);
    });
    return closePromise;
  };
  const onAbort = () => {
    rejectStartup(signal.reason || failed("Microsoft sign-in was canceled before its owner window opened."));
    beginClose("aborted").catch(() => {});
  };
  const failWindow = (message) => {
    rejectStartup(failed(message));
    beginClose("failed").catch(() => {});
  };

  child.once("error", () => {
    rejectStartup(failed("Unable to start the Microsoft sign-in owner."));
    if (!child.pid) {
      finished = true;
      clearTimeout(startupTimer);
      signal?.removeEventListener("abort", onAbort);
      resolveClosed({ reason: "failed" });
    } else beginClose("failed").catch(() => {});
  });
  child.once("close", (exitCode) => {
    finished = true;
    clearTimeout(startupTimer);
    clearTimeout(forceTimer);
    clearTimeout(cleanupTimer);
    signal?.removeEventListener("abort", onAbort);
    const reason = closeReason || (exitCode === 20 ? "user" : exitCode === 0 ? "parent" : "failed");
    if (!ready) rejectStartup(reason === "user"
      ? coworkError("AUTH_CANCELED", "The Microsoft sign-in owner was closed before authentication started.", { statusCode: 401 })
      : failed("The Microsoft sign-in owner exited before opening its window."));
    resolveClosed({ reason, exitCode });
  });
  child.stdin.on("error", () => { if (!finished && !closeReason) failWindow("The Microsoft sign-in owner's lifetime pipe failed."); });
  child.stdout.on("error", () => failWindow("Unable to read the Microsoft sign-in owner's window handle."));
  child.stdout.on("data", (chunk) => {
    if (finished) return;
    outputBytes += chunk.length;
    if (outputBytes > 128 || ready || [...chunk].some((byte) => byte !== 10 && byte !== 13 && (byte < 48 || byte > 57))) { failWindow("The Microsoft sign-in owner returned unexpected output."); return; }
    output += chunk.toString("ascii");
    const newline = output.indexOf("\n");
    if (newline < 0) return;
    if (newline !== output.length - 1) { failWindow("The Microsoft sign-in owner returned unexpected output."); return; }
    try {
      const handle = parseHandle(output.slice(0, newline).replace(/\r$/, ""), arch);
      ready = true;
      clearTimeout(startupTimer);
      resolveStartup(handle);
    } catch { failWindow("The Microsoft sign-in owner returned an invalid window handle."); }
  });
  startupTimer = setTimeout(() => failWindow("The Microsoft sign-in owner did not open within its startup deadline."), startupTimeoutMs);
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  try {
    const handle = await startup;
    return { handle, closed, close: () => beginClose("parent") };
  } catch (error) {
    await beginClose(closeReason || "failed");
    throw error;
  }
}
