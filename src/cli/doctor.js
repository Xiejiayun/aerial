import { setupStatus } from "../setup/index.js";
import { serviceStatus } from "../service/index.js";
import { computeAppStatus } from "./app-status.js";
import { readConfigFileStatus } from "../shared/config.js";

const REPAIRS = Object.freeze({
  CONFIG_RESET: Object.freeze({ command: "aerial", args: ["config", "reset"] }),
  LOGIN: Object.freeze({ command: "aerial", args: ["login"] }),
  SETUP_CODEX: Object.freeze({ command: "aerial", args: ["setup", "codex"] }),
  SERVICE_INSTALL: Object.freeze({ command: "aerial", args: ["service", "install"] }),
  SERVICE_STATUS_JSON: Object.freeze({ command: "aerial", args: ["service", "status", "--json"] })
});

function buildConfigChecks(configFile) {
  if (!configFile.ok) {
    return [{
      id: "config.file",
      ok: false,
      severity: "fail",
      message: `Aerial config file is not valid JSON: ${configFile.error}. Reset it to defaults, then rerun setup if needed.`,
      repair: REPAIRS.CONFIG_RESET
    }];
  }
  if (!configFile.exists) {
    return [{ id: "config.file", ok: true, severity: "info", message: "Aerial config file has not been created yet." }];
  }
  return [{ id: "config.file", ok: true, severity: "info", message: "Aerial config file is valid JSON." }];
}

function buildAuthChecks(setup) {
  const checks = [];
  const apiKey = setup.auth.api_key;
  if (!apiKey.exists) {
    checks.push({
      id: "auth.api_key",
      ok: false,
      severity: "fail",
      message: "Aerial local API key is missing. Run setup for the client you use; this repair shows the Codex path.",
      repair: REPAIRS.SETUP_CODEX
    });
  } else {
    checks.push({ id: "auth.api_key", ok: true, severity: "info", message: "Aerial local API key is present." });
  }
  const gh = setup.auth.github_token;
  if (gh.source === "missing") {
    checks.push({
      id: "auth.github_token",
      ok: false,
      severity: "fail",
      message: "GitHub token is not configured. Aerial cannot reach Copilot until you log in.",
      repair: REPAIRS.LOGIN
    });
  } else if (gh.source === "env") {
    checks.push({
      id: "auth.github_token",
      ok: true,
      severity: "warn",
      message: "AERIAL_GITHUB_TOKEN is set in this shell only. The background service does not inherit it; run `aerial login` to persist a service-readable token.",
      repair: REPAIRS.LOGIN
    });
  } else {
    checks.push({ id: "auth.github_token", ok: true, severity: "info", message: "GitHub token is present in the persisted credential file." });
  }
  return checks;
}

function buildClientChecks(setup) {
  const checks = [];
  const codex = setup.clients.codex;
  const claude = setup.clients.claude;
  const aerialCodex = codex.state === "aerial";
  const aerialClaude = claude.state === "aerial";
  if (!aerialCodex && !aerialClaude) {
    checks.push({
      id: "clients.aerial_client",
      ok: false,
      severity: "fail",
      message: "No client is wired to Aerial. Run setup for the client you use; this repair shows the Codex path.",
      repair: REPAIRS.SETUP_CODEX
    });
  } else {
    const wired = [aerialCodex && "codex", aerialClaude && "claude"].filter(Boolean).join(", ");
    checks.push({ id: "clients.aerial_client", ok: true, severity: "info", message: `Client wired to Aerial: ${wired}.` });
  }
  return checks;
}

function buildServiceChecks(service) {
  const checks = [];
  if (service.supported === false) {
    checks.push({
      id: "service.supported",
      ok: false,
      severity: "warn",
      message: `Background service is not supported on ${service.platform}; Aerial must run in the foreground.`
    });
    return checks;
  }
  const installed = Boolean(service.service?.installed);
  const loaded = Boolean(service.service?.loaded);
  const healthy = service.health?.aerial === true;
  if (healthy && !installed) {
    checks.push({
      id: "service.foreground_only",
      ok: true,
      severity: "warn",
      message: "Aerial is running in the foreground but no background service is installed; it will not start on reboot.",
      repair: REPAIRS.SERVICE_INSTALL
    });
  } else if (installed && !healthy) {
    checks.push({
      id: "service.health",
      ok: false,
      severity: "fail",
      message: loaded
        ? "Service manager reports the task running, but Aerial /health is not responding."
        : "Service is installed but not running.",
      repair: REPAIRS.SERVICE_STATUS_JSON
    });
  } else if (!installed && !healthy) {
    checks.push({
      id: "service.health",
      ok: false,
      severity: "fail",
      message: "Aerial is not running and no background service is installed.",
      repair: REPAIRS.SERVICE_INSTALL
    });
  } else {
    checks.push({ id: "service.health", ok: true, severity: "info", message: "Aerial /health is responding." });
  }
  if (service.health?.portConflict) {
    checks.push({
      id: "service.port_conflict",
      ok: false,
      severity: "fail",
      message: `Port ${service.config?.port} is held by a non-Aerial process: ${service.health.conflictReason || "unknown"}.`,
      repair: REPAIRS.SERVICE_STATUS_JSON
    });
  }
  const wrapper = service.service?.wrapper;
  if (wrapper && wrapper.stale === true) {
    const reasons = Array.isArray(wrapper.staleReasons) ? wrapper.staleReasons.join(", ") : "unknown";
    checks.push({
      id: "service.wrapper_stale",
      ok: true,
      severity: "warn",
      message: `Installed service wrapper is stale (${reasons}); reinstall to regenerate it.`,
      repair: REPAIRS.SERVICE_INSTALL
    });
  }
  return checks;
}

function summarize(ok, checks) {
  const fails = checks.filter((c) => c.severity === "fail").length;
  const warns = checks.filter((c) => c.severity === "warn").length;
  if (ok && warns === 0) return "All checks passed.";
  if (ok && warns > 0) return `Aerial is functional with ${warns} warning(s).`;
  return `${fails} check(s) failed; ${warns} warning(s).`;
}

export async function doctor({ run, healthFetch, setup, service } = {}) {
  const configFile = readConfigFileStatus();
  const setupOut = setup ?? setupStatus();
  const serviceOut = service ?? await serviceStatus({ ...(run ? { run } : {}), ...(healthFetch ? { healthFetch } : {}) });
  const app = computeAppStatus(setupOut, serviceOut);
  const checks = [
    ...buildConfigChecks(configFile),
    ...buildAuthChecks(setupOut),
    ...buildClientChecks(setupOut),
    ...buildServiceChecks(serviceOut)
  ];
  const ok = app.ok && checks.every((c) => c.severity !== "fail");
  return {
    schema: "aerial.doctor.v1",
    ok,
    summary: summarize(ok, checks),
    checks,
    status: {
      schema: app.schema,
      ok: app.ok,
      setup: app.setup,
      service: app.service
    }
  };
}

export function renderRepairCommand(repair) {
  if (!repair || typeof repair !== "object") return "";
  const args = Array.isArray(repair.args) ? repair.args : [];
  return [repair.command, ...args].join(" ");
}

export function renderDoctorText(report) {
  const lines = [];
  lines.push(`aerial doctor: ${report.summary}`);
  const groups = [
    ["fail", "Failures"],
    ["warn", "Warnings"],
    ["info", "Info"]
  ];
  for (const [severity, label] of groups) {
    const items = report.checks.filter((c) => c.severity === severity);
    if (items.length === 0) continue;
    lines.push("");
    lines.push(`${label}:`);
    for (const check of items) {
      const tag = severity.toUpperCase();
      let line = `  ${tag} ${check.id}: ${check.message}`;
      if (check.repair) line += ` -> run: ${renderRepairCommand(check.repair)}`;
      lines.push(line);
    }
  }
  return lines.join("\n");
}
