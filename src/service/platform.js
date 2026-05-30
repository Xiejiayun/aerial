import fs from "node:fs";
import { loadConfig } from "../shared/config.js";
import { logEvent } from "../shared/log.js";
import { atomicWriteFile } from "../shared/utils.js";
import {
  SERVICE_LABEL,
  WIN_TASK_NAME,
  aerialLogPath,
  buildSchtasksArgs,
  buildSchtasksCreateArgs,
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

function windowsServiceState(ctx) {
  const r = ctx.run("schtasks.exe", buildSchtasksArgs("query"));
  if (r.status !== 0) return { installed: false, loaded: false };
  const statusMatch = /Status:\s*(\S+)/i.exec(r.stdout);
  const status = statusMatch ? statusMatch[1].trim() : undefined;
  return { installed: true, loaded: status === "Running", status };
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
  const args = buildSchtasksCreateArgs({ wrapperPath: wrapper });
  const create = ctx.run("schtasks.exe", args);
  return { wrapper, create };
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
    ctx.run("schtasks.exe", buildSchtasksArgs("end"));
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
          create: { status: written.create.status, stderr: written.create.stderr }
        };
        return { ok: written.create.status === 0, info };
      },
      triggerStart: () => ctx.run("schtasks.exe", buildSchtasksArgs("run")),
      triggerStop: () => ctx.run("schtasks.exe", buildSchtasksArgs("end")),
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
