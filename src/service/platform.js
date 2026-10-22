import fs from "node:fs";
import { loadConfig } from "../shared/config.js";
import { logEvent } from "../shared/log.js";
import { atomicWriteFile } from "../shared/utils.js";
import {
  SERVICE_LABEL,
  WIN_TASK_NAME,
  aerialLogPath,
  buildSchtasksArgs,
  buildWindowsTaskRegistrationScript,
  cliEntry,
  darwinWrapperPath,
  explicitConfigDir,
  nodeBinary,
  plistPath,
  renderDarwinWrapper,
  renderPlist,
  renderWindowsWrapper,
  stdioLogPath,
  uidString,
  winWrapperPath,
  wrapperLogConfig
} from "./wrapper-render.js";

export function isUnsupportedPlatform() {
  return process.platform !== "darwin" && process.platform !== "win32";
}

export function unsupportedError(action) {
  const platform = process.platform;
  return new Error(`aerial service ${action}: unsupported platform (${platform}). Service management is implemented for macOS (launchd) and Windows (Task Scheduler). On ${platform}, run \`aerial start\` directly or wrap it in your own init system.`);
}

function darwinServiceState(ctx) {
  const r = ctx.run("launchctl", ["list", SERVICE_LABEL]);
  const installed = fs.existsSync(plistPath());
  if (!installed) return { installed: false, loaded: false };
  if (r.status !== 0) return { installed: true, loaded: false };
  const pidMatch = /"PID"\s*=\s*(\d+)/.exec(r.stdout);
  const lastExitMatch = /"LastExitStatus"\s*=\s*(-?\d+)/.exec(r.stdout);
  return {
    installed: true,
    loaded: true,
    pid: pidMatch ? Number(pidMatch[1]) : undefined,
    lastExitStatus: lastExitMatch ? Number(lastExitMatch[1]) : undefined
  };
}

export function windowsServiceState(ctx) {
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$scheduler = New-Object -ComObject 'Schedule.Service'",
    "$scheduler.Connect()",
    `$tasks = @($scheduler.GetFolder('\\').GetTasks(1) | Where-Object { $_.Name -eq '${WIN_TASK_NAME}' })`,
    "if ($tasks.Count -eq 0) {",
    "  @{ installed = $false } | ConvertTo-Json -Compress",
    "} else {",
    "  $task = $tasks[0]",
    "  @{ installed = $true; state = [int]$task.State } | ConvertTo-Json -Compress",
    "}"
  ].join("\r\n");
  const r = ctx.run("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")]);
  if (r.status !== 0) throw new Error(`Could not read Windows scheduled task state. No service action was performed. ${r.stderr || r.error?.message || `PowerShell exited ${r.status}`}`);
  let result;
  try { result = JSON.parse(r.stdout); } catch { /* Reject ambiguous state. */ }
  if (result?.installed === false) return { installed: false, loaded: false };
  const states = { 1: "Disabled", 2: "Queued", 3: "Ready", 4: "Running" };
  if (result?.installed !== true || !Number.isInteger(result.state) || !states[result.state]) {
    throw new Error("Could not read Windows scheduled task state: invalid numeric state. No service action was performed.");
  }
  return { installed: true, loaded: result.state === 4 || result.state === 2, status: states[result.state], state: result.state };
}

function windowsStop(ctx) {
  // /End only terminates the action process, leaving its children running.
  // Ask Task Scheduler for this task's root PIDs instead of matching processes
  // by name or port, then terminate each complete tree before ending the task.
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$scheduler = New-Object -ComObject 'Schedule.Service'",
    "$scheduler.Connect()",
    `$task = $scheduler.GetFolder('\\').GetTask('${WIN_TASK_NAME}')`,
    "$roots = @($task.GetInstances(0) | ForEach-Object {",
    "  $root = Get-Process -Id $_.EnginePID -ErrorAction SilentlyContinue",
    "  if ($null -ne $root) {",
    "    if ($root.ProcessName -notin @('wscript', 'powershell')) { throw 'Unexpected Aerial task process; refusing to terminate it.' }",
    "    $root.Id",
    "  }",
    "})",
    "ConvertTo-Json -InputObject $roots -Compress"
  ].join("\r\n");
  const query = ctx.run("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")]);
  if (query.status !== 0) return query;
  let roots;
  try {
    roots = JSON.parse(query.stdout || "[]");
    if (!Array.isArray(roots) || !roots.every((pid) => Number.isSafeInteger(pid) && pid > 0)) throw new Error();
  } catch {
    return { status: 1, stderr: "Could not read Aerial task process IDs; service was not stopped." };
  }
  for (const pid of roots) {
    const stopped = ctx.run("taskkill.exe", ["/PID", String(pid), "/T", "/F"]);
    if (stopped.status !== 0) return stopped;
  }
  return ctx.run("schtasks.exe", buildSchtasksArgs("end"));
}

function darwinWriteDefinition() {
  const wrapper = darwinWrapperPath();
  const config = loadConfig();
  const logCfg = wrapperLogConfig();
  const wrapperContent = renderDarwinWrapper({
    nodePath: nodeBinary(),
    cliPath: cliEntry(),
    host: config.host,
    port: config.port,
    stdioLog: stdioLogPath(),
    aerialLog: aerialLogPath(),
    configDir: explicitConfigDir(),
    maxBytes: logCfg.maxBytes,
    backups: logCfg.backups
  });
  atomicWriteFile(wrapper, wrapperContent, { mode: 0o755 });
  const file = plistPath();
  const plistContent = renderPlist({ wrapperPath: wrapper });
  atomicWriteFile(file, plistContent, { mode: 0o644 });
  return { file, wrapper };
}

function darwinBootstrap(ctx) {
  const file = plistPath();
  const existing = ctx.run("launchctl", ["list", SERVICE_LABEL]);
  if (existing.status === 0) {
    ctx.run("launchctl", ["bootout", `gui/${uidString()}`, file], { stdio: "ignore" });
  }
  return ctx.run("launchctl", ["bootstrap", `gui/${uidString()}`, file]);
}

function darwinBootout(ctx) {
  const file = plistPath();
  return ctx.run("launchctl", ["bootout", `gui/${uidString()}`, file]);
}

function windowsConfigureRecovery(ctx) {
  // Update only Settings so the registered user, logon trigger, and hidden
  // launcher stay intact when refreshing a running service definition.
  // Suppress progress and write failures directly to avoid EncodedCommand's CLIXML stderr.
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "$ProgressPreference = 'SilentlyContinue'",
    "try {",
    `  $task = Get-ScheduledTask -TaskName '${WIN_TASK_NAME}' -TaskPath '\\'`,
    "  $settings = $task.Settings",
    "  $settings.RestartInterval = 'PT1M'",
    "  $settings.RestartCount = 999",
    "  $settings.ExecutionTimeLimit = 'PT0S'",
    "  $settings.DisallowStartIfOnBatteries = $false",
    "  $settings.StopIfGoingOnBatteries = $false",
    `  Set-ScheduledTask -TaskName '${WIN_TASK_NAME}' -TaskPath '\\' -Settings $settings | Out-Null`,
    "} catch {",
    "  [Console]::Error.WriteLine(($_ | Out-String).TrimEnd())",
    "  exit 1",
    "}"
  ].join("\r\n");
  return ctx.run("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")]);
}

function windowsWriteDefinition(ctx) {
  const wrapper = winWrapperPath();
  const config = loadConfig();
  const logCfg = wrapperLogConfig();
  const wrapperContent = renderWindowsWrapper({
    nodePath: nodeBinary(),
    cliPath: cliEntry(),
    host: config.host,
    port: config.port,
    stdioLog: stdioLogPath(),
    aerialLog: aerialLogPath(),
    configDir: explicitConfigDir(),
    maxBytes: logCfg.maxBytes,
    backups: logCfg.backups
  });
  atomicWriteFile(wrapper, wrapperContent);
  const script = buildWindowsTaskRegistrationScript({ wrapperPath: wrapper });
  const create = ctx.run("powershell.exe", ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")]);
  const recovery = create.status === 0 ? windowsConfigureRecovery(ctx) : undefined;
  return { wrapper, create, recovery };
}

export function removeFileIfExists(file) {
  if (!fs.existsSync(file)) return false;
  try {
    fs.unlinkSync(file);
    return true;
  } catch {
    return false;
  }
}

function darwinUninstall(ctx, state) {
  const file = plistPath();
  const wrapper = darwinWrapperPath();
  if (state.loaded) {
    const bootout = darwinBootout(ctx);
    if (bootout.status !== 0) {
      logEvent("service_uninstall", { platform: "darwin", ok: false, reason: "bootout_failed", status: bootout.status });
      return {
        ok: false,
        action: "uninstall",
        platform: "darwin",
        reason: "bootout_failed",
        file,
        wrapper,
        bootout: { status: bootout.status, stderr: bootout.stderr },
        message: `launchctl bootout failed (status ${bootout.status}). Service is still loaded; plist and wrapper were preserved. Retry with \`aerial service uninstall\`.`
      };
    }
    removeFileIfExists(file);
    removeFileIfExists(wrapper);
    logEvent("service_uninstall", { platform: "darwin", ok: true });
    return { ok: true, action: "uninstall", platform: "darwin", file, wrapper, bootout: { status: bootout.status, stderr: bootout.stderr } };
  }
  removeFileIfExists(file);
  removeFileIfExists(wrapper);
  logEvent("service_uninstall", { platform: "darwin", ok: true });
  return { ok: true, action: "uninstall", platform: "darwin", file, wrapper, bootout: { status: 0, skipped: "not_loaded" } };
}

function windowsUninstall(ctx, state) {
  if (state.loaded) {
    const stop = windowsStop(ctx);
    if (stop.status !== 0) {
      return {
        ok: false, action: "uninstall", platform: "win32", reason: "stop_failed",
        stop: { status: stop.status, stderr: stop.stderr },
        message: "Could not stop the Aerial process tree. Task and wrapper were preserved. Retry with `aerial service uninstall`."
      };
    }
  }
  const del = ctx.run("schtasks.exe", buildSchtasksArgs("delete"));
  const wrapper = winWrapperPath();
  const wrapperRemoved = del.status === 0 ? removeFileIfExists(wrapper) : false;
  logEvent("service_uninstall", { platform: "win32", ok: del.status === 0 });
  return {
    ok: del.status === 0,
    action: "uninstall",
    platform: "win32",
    taskName: WIN_TASK_NAME,
    wrapper,
    wrapperRemoved,
    delete: { status: del.status, stderr: del.stderr },
    ...(del.status === 0 ? {} : { reason: "delete_failed", message: `schtasks /Delete failed (status ${del.status}). Task and wrapper were preserved. Retry with \`aerial service uninstall\`.` })
  };
}

export function serviceAdapter(ctx) {
  if (process.platform === "darwin") {
    return {
      platform: "darwin",
      wrapperPath: darwinWrapperPath,
      state: () => darwinServiceState(ctx),
      writeDefinition: () => {
        const written = darwinWriteDefinition();
        return {
          ok: true,
          info: { file: written.file, wrapper: written.wrapper, label: SERVICE_LABEL }
        };
      },
      triggerStart: () => darwinBootstrap(ctx),
      triggerStop: () => darwinBootout(ctx),
      startFailureReason: "bootstrap_failed",
      startResultKey: "bootstrap",
      uninstall: (state) => darwinUninstall(ctx, state)
    };
  }
  if (process.platform === "win32") {
    return {
      platform: "win32",
      wrapperPath: winWrapperPath,
      state: () => windowsServiceState(ctx),
      writeDefinition: () => {
        const written = windowsWriteDefinition(ctx);
        const info = {
          taskName: WIN_TASK_NAME,
          wrapper: written.wrapper,
          create: { status: written.create.status, stderr: written.create.stderr },
          ...(written.recovery ? { recovery: { status: written.recovery.status, stderr: written.recovery.stderr } } : {})
        };
        const recoveryFailed = written.create.status === 0 && written.recovery?.status !== 0;
        return {
          ok: written.create.status === 0 && !recoveryFailed,
          ...(recoveryFailed ? {
            reason: "recovery_configuration_failed",
            message: "Task was registered, but its recovery settings could not be applied. Service was not started. Resolve the PowerShell error and rerun `aerial service install`."
          } : {}),
          info
        };
      },
      triggerStart: () => ctx.run("schtasks.exe", buildSchtasksArgs("run")),
      triggerStop: () => windowsStop(ctx),
      startFailureReason: "run_failed",
      startResultKey: "run",
      uninstall: (state) => windowsUninstall(ctx, state)
    };
  }
  return undefined;
}

export function serviceState(ctx) {
  const adapter = serviceAdapter(ctx);
  if (adapter) return adapter.state();
  return { installed: false, loaded: false, reason: "unsupported_platform" };
}

export function requireServiceAdapter(ctx, action) {
  const adapter = serviceAdapter(ctx);
  if (!adapter) throw unsupportedError(action);
  return adapter;
}
