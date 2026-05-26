import { serviceInstall, serviceRestart, serviceStart, serviceStatus, serviceStop, serviceUninstall } from "../service/index.js";
import { printServiceDiagnostics, printServiceWarning } from "./output.js";

export function printServiceUninstallResult(r, { prefix = "Service uninstall" } = {}) {
  if (r.note === "no service installed") console.log(`${prefix}: no service installed`);
  else if (r.ok) console.log(`${prefix}: ok (${r.platform})`);
  else {
    console.log(`${prefix}: FAILED (${r.reason || "see stderr"})`);
    if (r.message) console.log(`  ${r.message}`);
    else console.log(`  Retry with: aerial service uninstall`);
  }
  if (r.delete?.stderr) console.log(`  schtasks stderr: ${r.delete.stderr.trim()}`);
  if (r.bootout?.stderr) console.log(`  bootout stderr: ${r.bootout.stderr.trim()}`);
}

async function runServiceCliAction(action, render) {
  try {
    const result = await action();
    render(result);
    process.exitCode = result.ok ? 0 : 1;
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  }
}

function printServiceStatus(status) {
  console.log(`Aerial: http://${status.config.host}:${status.config.port}  (platform: ${status.platform})`);
  if (status.supported === false) {
    console.log(`service: unsupported on ${status.platform}`);
    console.log(`summary: ${status.summary}`);
    process.exitCode = 1;
    return;
  }
  const svc = status.service;
  const stateLine = svc.loaded ? "running" : (svc.installed ? "installed (not running)" : "not installed");
  console.log(`service: ${stateLine}`);
  if (svc.pid) console.log(`  pid: ${svc.pid}`);
  if (svc.status) console.log(`  win status: ${svc.status}`);
  if (svc.lastExitStatus !== undefined) console.log(`  last exit: ${svc.lastExitStatus}`);
  const h = status.health;
  let healthLine;
  if (h.aerial && h.supervisor === "service-managed") healthLine = "ok (Aerial, service-managed)";
  else if (h.aerial && h.supervisor === "foreground") healthLine = "ok (Aerial, foreground)";
  else if (h.portConflict) healthLine = `port conflict (${h.conflictReason})`;
  else if (h.ok) healthLine = "ok";
  else healthLine = `unreachable (${h.error || `http ${h.status}`})`;
  console.log(`health:  ${healthLine}`);
  console.log(`summary: ${status.summary}`);
  console.log(`logs:    ${status.logs.dir}`);
  console.log(`  primary: ${status.logs.primary.exists ? `${status.logs.primary.size} bytes` : "missing"}  ${status.logs.primary.file}`);
  console.log(`  stdio:   ${status.logs.stdio.exists ? `${status.logs.stdio.size} bytes` : "missing"}  ${status.logs.stdio.file}`);
  console.log(`auth:    api_key=${status.auth.api_key.state}  github_token=${status.auth.github_token.state}`);
}

export async function runServiceCli(subcommand, rest) {
  if (subcommand === "install") {
    await runServiceCliAction(serviceInstall, (r) => {
      if (r.ok && r.note) console.log(`Service install: ${r.note} (${r.platform}).`);
      else if (r.ok) console.log(`Service installed (${r.platform}).`);
      else console.log(`Service install: FAILED (${r.reason || "unknown"}): ${r.message || ""}`);
      if (r.file) console.log(`  unit: ${r.file}`);
      if (r.taskName) console.log(`  task: ${r.taskName}`);
      if (r.wrapper) console.log(`  wrapper: ${r.wrapper}`);
      if (r.bootstrap?.stderr) console.log(`  bootstrap stderr: ${r.bootstrap.stderr.trim()}`);
      if (r.create?.stderr) console.log(`  schtasks stderr: ${r.create.stderr.trim()}`);
      if (r.run?.stderr) console.log(`  schtasks /Run stderr: ${r.run.stderr.trim()}`);
      printServiceDiagnostics(r.diagnostics);
      printServiceWarning(r);
    });
    return;
  }
  if (subcommand === "start") {
    await runServiceCliAction(serviceStart, (r) => {
      if (r.ok && r.note) console.log(`Service start: ${r.note} (${r.platform})`);
      else if (r.ok) console.log(`Service start: ok (${r.platform})`);
      else console.log(`Service start: FAILED (${r.reason || `status=${r.status}`})${r.message ? ": " + r.message : ""}`);
      if (r.stderr) console.log(`  ${r.stderr.trim()}`);
      printServiceDiagnostics(r.diagnostics);
      printServiceWarning(r);
    });
    return;
  }
  if (subcommand === "stop") {
    await runServiceCliAction(serviceStop, (r) => {
      if (r.note) console.log(`Service stop: ${r.note} (${r.platform})`);
      else if (r.ok) console.log(`Service stop: ok (${r.platform})`);
      else console.log(`Service stop: FAILED (status=${r.status})`);
      if (r.stderr) console.log(`  ${r.stderr.trim()}`);
    });
    return;
  }
  if (subcommand === "restart") {
    await runServiceCliAction(serviceRestart, (r) => {
      if (!r.ok && r.reason === "stop_failed") console.log(`Service restart: FAILED on stop; start not attempted`);
      else if (r.ok) console.log(`Service restart: ok`);
      else console.log(`Service restart: FAILED`);
      if (r.stop?.stderr) console.log(`  stop: ${r.stop.stderr.trim()}`);
      if (r.start?.stderr) console.log(`  start: ${r.start.stderr.trim()}`);
      printServiceWarning(r);
    });
    return;
  }
  if (subcommand === "uninstall") {
    await runServiceCliAction(serviceUninstall, printServiceUninstallResult);
    return;
  }
  if (subcommand === "status") {
    const status = await serviceStatus();
    if (rest.includes("--json")) {
      console.log(JSON.stringify(status, null, 2));
      process.exitCode = status.supported === false ? 1 : 0;
      return;
    }
    printServiceStatus(status);
    return;
  }
  console.error(`Unknown service subcommand: ${subcommand}. Use install, start, stop, restart, status, or uninstall.`);
  process.exitCode = 1;
}
