import fs from "node:fs";
import { githubTokenPath } from "../shared/paths.js";
import { loadConfig } from "../shared/config.js";
import { logEvent } from "../shared/log.js";
import { defaultHealthFetch, classifyHealth, pollForAerialUp } from "./health.js";
import { defaultRunCommand } from "./runner.js";
import { requireServiceAdapter } from "./platform.js";
import { aerialLogPath, stdioLogPath } from "./wrapper-render.js";
import { readWrapperNodePath } from "./status.js";

function tokenWarning() {
  const tokenFile = githubTokenPath();
  if (fs.existsSync(tokenFile)) {
    try {
      const data = fs.readFileSync(tokenFile, "utf8");
      if (data && data.trim()) return undefined;
    } catch {}
  }
  const envToken = process.env.AERIAL_GITHUB_TOKEN;
  const envOnly = envToken && envToken.trim();
  const message = envOnly
    ? "AERIAL_GITHUB_TOKEN is set in this shell only; the background service does not inherit it. Run `aerial login` to persist a service-readable GitHub token, otherwise proxy requests return 503."
    : "GitHub token is not configured. Service will start, but proxy requests return 503 until you run `aerial login`.";
  return { level: "warning", code: "github_token_missing", message };
}

function healthFailedDiagnostics({ wrapper, probe, attempts, elapsedMs }) {
  const out = {
    stdioLog: stdioLogPath(),
    aerialLog: aerialLogPath(),
    wrapperNode: readWrapperNodePath(wrapper),
    health: { attempts, elapsedMs }
  };
  if (probe && probe.error) out.health.lastError = probe.error;
  if (probe && probe.status !== undefined) out.health.lastStatus = probe.status;
  return out;
}

function commandResultBlock(key, result) {
  return { [key]: { status: result.status, stderr: result.stderr } };
}

function buildDefinitionRefreshFailure({ adapter, supervisor, config, definition }) {
  const isManaged = supervisor === "service-managed";
  const status = definition.info.create?.status;
  const reason = isManaged ? "managed_definition_refresh_failed" : "foreground_definition_refresh_failed";
  const message = isManaged
    ? `schtasks /Create failed (status ${status}) while refreshing the managed-service definition. The running service was not disturbed, but wrapper/env changes were NOT applied. Resolve the underlying schtasks error and rerun \`aerial service install\`.`
    : `Aerial is already running in the foreground on port ${config.port}. The wrapper was rewritten but schtasks /Create failed (status ${status}), so the Task Scheduler definition was NOT refreshed. Resolve the underlying schtasks error and rerun \`aerial service install\`.`;
  return {
    ok: false,
    action: "install",
    platform: adapter.platform,
    reason,
    ...(isManaged ? {} : { definitionUpdated: false }),
    message,
    warning: tokenWarning(),
    ...definition.info
  };
}

function buildRunningDefinitionResult({ adapter, supervisor, config, definition }) {
  const managed = supervisor === "service-managed";
  return {
    ok: managed,
    action: "install",
    platform: adapter.platform,
    ...(managed
      ? {
          note: "already running (service-managed); definition refreshed; run `aerial service restart` to apply wrapper/env changes"
        }
      : {
          reason: "foreground_running",
          message: `Aerial is already running in the foreground on port ${config.port}. The service definition has been updated, but the service was NOT started to avoid running two instances. Next step: stop the foreground process, then run \`aerial service start\`.`
        }),
    definitionUpdated: true,
    warning: tokenWarning(),
    ...definition.info
  };
}

async function confirmStarted({ action, result, config, wrapper, healthFetch, healthDeadlineMs }) {
  if (!result.ok) return result;
  if (process.env.AERIAL_SERVICE_DRYRUN === "1") {
    return { ...result, health: { ok: true, attempts: 0, elapsedMs: 0, dryRun: true } };
  }
  const poll = await pollForAerialUp(config.host, config.port, healthFetch, healthDeadlineMs);
  if (poll.cls.mode === "aerial_running") {
    return { ...result, health: { ok: true, attempts: poll.attempts, elapsedMs: poll.elapsedMs } };
  }
  const diagnostics = healthFailedDiagnostics({
    wrapper,
    probe: poll.probe,
    attempts: poll.attempts,
    elapsedMs: poll.elapsedMs
  });
  if (poll.cls.mode === "port_conflict") {
    const prefix = action === "install" ? "After install" : "After start";
    return {
      ...result,
      ok: false,
      reason: "port_conflict",
      message: `${prefix}, port ${config.port} is responding as a non-Aerial process: ${poll.cls.reason}. Free the port and rerun.`,
      diagnostics
    };
  }
  const message = action === "install"
    ? `Service definition was written and start was triggered, but /health did not become Aerial within ${poll.elapsedMs}ms (${poll.attempts} attempts). Inspect logs and rerun \`aerial service status --json\`.`
    : `Start was triggered, but /health did not become Aerial within ${poll.elapsedMs}ms (${poll.attempts} attempts). Inspect logs and rerun \`aerial service status --json\`.`;
  return {
    ...result,
    ok: false,
    reason: "health_check_failed",
    ...(action === "install" ? { definitionWritten: true } : {}),
    startAttempted: true,
    message,
    diagnostics
  };
}

async function describeRunning(adapter, host, port, healthFetch, knownState) {
  const probe = await (healthFetch || defaultHealthFetch)(host, port);
  const cls = classifyHealth(probe);
  if (cls.mode !== "aerial_running") return { cls, probe };
  const state = knownState || adapter.state();
  const supervisor = state.installed && state.loaded ? "service-managed" : "foreground";
  return { cls, probe, supervisor };
}

export async function serviceInstall({ run = defaultRunCommand, healthFetch, healthDeadlineMs } = {}) {
  const ctx = { run };
  const adapter = requireServiceAdapter(ctx, "install");
  const config = loadConfig();
  const { cls, supervisor } = await describeRunning(adapter, config.host, config.port, healthFetch);
  if (cls.mode === "port_conflict") {
    logEvent("service_install", { platform: adapter.platform, ok: false, reason: "port_conflict" });
    return {
      ok: false,
      action: "install",
      platform: adapter.platform,
      reason: "port_conflict",
      message: `Port ${config.port} is already in use by a non-Aerial process: ${cls.reason}. Free the port and rerun.`
    };
  }
  if (cls.mode === "aerial_running") {
    const definition = adapter.writeDefinition();
    if (!definition.ok) {
      const failure = buildDefinitionRefreshFailure({ adapter, supervisor, config, definition });
      logEvent("service_install", {
        platform: adapter.platform,
        ok: false,
        reason: failure.reason,
        status: definition.info.create?.status
      });
      return failure;
    }
    const result = buildRunningDefinitionResult({ adapter, supervisor, config, definition });
    logEvent("service_install", {
      platform: adapter.platform,
      ok: result.ok,
      reason: result.reason,
      note: supervisor === "service-managed" ? "managed_refreshed" : undefined,
      definitionUpdated: true
    });
    return result;
  }

  const definition = adapter.writeDefinition();
  let result = {
    ok: definition.ok,
    action: "install",
    platform: adapter.platform,
    ...definition.info
  };
  if (!definition.ok) {
    result.reason = "create_failed";
  } else {
    const start = adapter.triggerStart();
    const triggerOk = start.status === 0;
    result = {
      ...result,
      ok: triggerOk,
      ...commandResultBlock(adapter.startResultKey, start),
      ...(triggerOk ? {} : { reason: adapter.startFailureReason })
    };
  }
  result = await confirmStarted({
    action: "install",
    result,
    config,
    wrapper: result.wrapper,
    healthFetch,
    healthDeadlineMs
  });
  result.warning = tokenWarning();
  logEvent("service_install", { platform: adapter.platform, ok: result.ok, reason: result.reason });
  return result;
}

export async function serviceStart({ run = defaultRunCommand, healthFetch, healthDeadlineMs } = {}) {
  const ctx = { run };
  const adapter = requireServiceAdapter(ctx, "start");
  const config = loadConfig();
  const state = adapter.state();
  if (!state.installed) {
    return {
      ok: false,
      action: "start",
      platform: adapter.platform,
      reason: "not_installed",
      message: "Service is not installed. Run `aerial service install` first."
    };
  }
  const { cls, supervisor } = await describeRunning(adapter, config.host, config.port, healthFetch, state);
  if (cls.mode === "port_conflict") {
    return {
      ok: false,
      action: "start",
      platform: adapter.platform,
      reason: "port_conflict",
      message: `Port ${config.port} is already in use by a non-Aerial process: ${cls.reason}. Free the port and rerun.`
    };
  }
  if (cls.mode === "aerial_running" && supervisor === "foreground") {
    return {
      ok: false,
      action: "start",
      platform: adapter.platform,
      reason: "foreground_running",
      message: `Aerial is already running in the foreground on port ${config.port}. Stop the foreground process before starting the service.`
    };
  }
  if (cls.mode === "aerial_running" && supervisor === "service-managed") {
    return {
      ok: true,
      action: "start",
      platform: adapter.platform,
      note: "already running (service-managed)",
      warning: tokenWarning()
    };
  }
  const r = adapter.triggerStart();
  const triggerOk = r.status === 0;
  let result = {
    ok: triggerOk,
    action: "start",
    platform: adapter.platform,
    status: r.status,
    stderr: r.stderr,
    warning: tokenWarning(),
    ...(triggerOk ? {} : { reason: adapter.startFailureReason })
  };
  if (!triggerOk) {
    logEvent("service_start", { platform: adapter.platform, status: r.status, reason: result.reason });
    return result;
  }
  result = await confirmStarted({
    action: "start",
    result,
    config,
    wrapper: adapter.wrapperPath(),
    healthFetch,
    healthDeadlineMs
  });
  logEvent("service_start", { platform: adapter.platform, status: r.status, ok: result.ok, reason: result.reason, dryRun: result.health?.dryRun });
  return result;
}

export function serviceStop({ run = defaultRunCommand } = {}) {
  const ctx = { run };
  const adapter = requireServiceAdapter(ctx, "stop");
  const state = adapter.state();
  if (!state.installed) {
    return { ok: true, action: "stop", platform: adapter.platform, note: "not installed" };
  }
  if (!state.loaded) {
    return { ok: true, action: "stop", platform: adapter.platform, note: "not running" };
  }
  const r = adapter.triggerStop();
  logEvent("service_stop", { platform: adapter.platform, status: r.status });
  return { ok: r.status === 0, action: "stop", platform: adapter.platform, status: r.status, stderr: r.stderr };
}

export async function serviceRestart(opts = {}) {
  const stop = serviceStop(opts);
  if (!stop.ok) {
    return { ok: false, action: "restart", platform: process.platform, stop, reason: "stop_failed" };
  }
  const start = await serviceStart(opts);
  return { ok: start.ok, action: "restart", platform: process.platform, stop, start, warning: start.warning };
}

export function serviceUninstall({ run = defaultRunCommand } = {}) {
  const ctx = { run };
  const adapter = requireServiceAdapter(ctx, "uninstall");
  const state = adapter.state();
  if (!state.installed) {
    return { ok: true, action: "uninstall", platform: adapter.platform, note: "no service installed" };
  }
  return adapter.uninstall(state);
}
