#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { startDeviceFlow, pollDeviceFlow } from "./auth.js";
import { ensureApiKey, loadConfig, saveConfig } from "./config.js";
import { startServer } from "./server.js";
import { setupClaude, setupCodex, setupStatus, restoreClient, restoreAllClients } from "./setup.js";
import { serviceInstall, serviceStart, serviceStop, serviceRestart, serviceUninstall, serviceStatus } from "./service.js";
import { doctor } from "./doctor.js";
import { runProbe, formatProbeReport } from "./probe.js";
import { printVersion } from "./version.js";

const CLI_ENTRY = fileURLToPath(import.meta.url);

function codexAuthCommand() {
  return {
    command: process.execPath,
    args: [CLI_ENTRY, "key", "print"],
    timeout_ms: 5000,
    refresh_interval_ms: 0
  };
}

function printHelp() {
  console.log(`Aerial local Copilot proxy

Usage:
  aerial --version
  aerial login
  aerial key generate
  aerial key print
  aerial start [--host 127.0.0.1] [--port 18181]
  aerial setup codex [--model <id>]
  aerial setup claude [--model <id>]
  aerial setup all [--model <id>]
  aerial setup status [--json]
  aerial setup restore <codex|claude|all> --latest
  aerial service install
  aerial service start
  aerial service stop
  aerial service restart
  aerial service status [--json]
  aerial service uninstall
  aerial disable
  aerial doctor
  aerial probe [--live] [--json]

MVP routes:
  GET  /health
  GET  /v1/models
  POST /v1/responses
  POST /v1/messages
  POST /v1/messages/count_tokens
  POST /v1/chat/completions`);
}

function argValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const [command, subcommand, ...rest] = args;
  if (!command || command === "--help" || command === "-h") return printHelp();
  if (command === "--version") return printVersion();

  if (command === "login") {
    const flow = await startDeviceFlow();
    console.log(`Open: ${flow.verification_uri}`);
    console.log(`Code: ${flow.user_code}`);
    console.log("Waiting for GitHub authorization...");
    await pollDeviceFlow(flow.device_code, flow.interval);
    console.log("GitHub login saved.");
    return;
  }

  if (command === "key") {
    if (subcommand === "generate") {
      const result = ensureApiKey();
      if (result.apiKey) {
        console.log("Local Aerial key generated and stored privately.");
      } else {
        console.log("Aerial API key already configured.");
      }
      return;
    }
    if (subcommand === "print") {
      const result = ensureApiKey();
      if (result.apiKey) console.log(result.apiKey);
      else throw new Error("Raw API key is not available. Run: aerial key generate");
      return;
    }
  }

  if (command === "start") {
    const config = loadConfig();
    const host = argValue(args, "--host") || config.host;
    const port = Number(argValue(args, "--port") || config.port);
    ensureApiKey();
    startServer({ host, port });
    return;
  }

  if (command === "setup") {
    if (subcommand === "codex") {
      const result = setupCodex({ model: argValue(rest, "--model"), authCommand: codexAuthCommand() });
      console.log(`Updated Codex config: ${result.file}`);
      if (result.backup) console.log(`Backup: ${result.backup}`);
      console.log("Configured Codex to read the local Aerial key automatically.");
      return;
    }
    if (subcommand === "claude") {
      const result = setupClaude({ model: argValue(rest, "--model") });
      console.log(`Updated Claude settings: ${result.file}`);
      if (result.model) console.log(`Configured Claude default model: ${result.model}`);
      if (result.backup) console.log(`Backup: ${result.backup}`);
      return;
    }
    if (subcommand === "all") {
      const model = argValue(rest, "--model");
      const codex = setupCodex({ model, authCommand: codexAuthCommand() });
      const claude = setupClaude({ model });
      console.log(`Updated Codex config: ${codex.file}`);
      console.log("Configured Codex to read the local Aerial key automatically.");
      console.log(`Updated Claude settings: ${claude.file}`);
      if (claude.model) console.log(`Configured Claude default model: ${claude.model}`);
      return;
    }
    if (subcommand === "status") {
      const status = setupStatus();
      if (rest.includes("--json")) {
        console.log(JSON.stringify(status, null, 2));
        return;
      }
      console.log(`Aerial: http://${status.config.host}:${status.config.port}  (platform: ${status.platform})`);
      console.log(`API key file:    ${status.auth.api_key.file}  (${status.auth.api_key.exists ? "present" : "missing"})`);
      console.log(`GitHub token:    ${status.auth.github_token.file}  (${status.auth.github_token.exists ? "present" : "missing"})`);
      for (const cs of Object.values(status.clients)) {
        const head = `${cs.target.padEnd(7)} state=${cs.state}`;
        console.log(`${head}  file=${cs.file}`);
        if (cs.backups.length) console.log(`         backups=${cs.backups.length}`);
        if (cs.error) console.log(`         error=${cs.error}`);
      }
      return;
    }
    if (subcommand === "restore") {
      const which = rest[0];
      if (!which) throw new Error("Usage: aerial setup restore <codex|claude|all> --latest");
      if (!rest.includes("--latest")) throw new Error("aerial setup restore: only --latest is supported in this release");
      if (which === "all") {
        const { ok, results } = restoreAllClients();
        for (const r of Object.values(results)) {
          if (r.restored) {
            console.log(`Restored ${r.target}: ${r.file} <- ${r.from}`);
            if (r.snapshot) console.log(`  pre-restore snapshot: ${r.snapshot}`);
          } else if (r.reason === "no_backup") {
            console.log(`Restored ${r.target}: no backup to restore`);
          } else if (r.error) {
            console.log(`Restored ${r.target}: FAILED  ${r.error}`);
          }
        }
        process.exitCode = ok ? 0 : 1;
        return;
      }
      if (which !== "codex" && which !== "claude") throw new Error(`Unknown restore target: ${which}. Use codex, claude, or all.`);
      const r = restoreClient(which);
      if (r.restored) {
        console.log(`Restored ${which}: ${r.file} <- ${r.from}`);
        if (r.snapshot) console.log(`  pre-restore snapshot: ${r.snapshot}`);
      } else if (r.reason === "no_backup") {
        console.log(`Restored ${which}: no backup to restore`);
      }
      return;
    }
  }

  if (command === "disable") {
    const { ok: restoreOk, results } = restoreAllClients();
    for (const r of Object.values(results)) {
      if (r.restored) {
        console.log(`Restored ${r.target}: ${r.file} <- ${r.from}`);
        if (r.snapshot) console.log(`  pre-restore snapshot: ${r.snapshot}`);
      } else if (r.reason === "no_backup") {
        console.log(`Restored ${r.target}: no backup to restore`);
      } else if (r.error) {
        console.log(`Restored ${r.target}: FAILED  ${r.error}`);
      }
    }
    if (!restoreOk) {
      console.log("service uninstall: skipped because client restore reported failures; resolve restore errors then rerun `aerial disable` or `aerial service uninstall`.");
      process.exitCode = 1;
      return;
    }
    try {
      const r = serviceUninstall();
      if (r.note === "no service installed") console.log("service uninstall: no service installed");
      else if (r.ok) console.log(`service uninstall: ok (${r.platform})`);
      else {
        console.log(`service uninstall: FAILED (${r.reason || "see stderr"})`);
        if (r.message) console.log(`  ${r.message}`);
        else console.log(`  Retry with: aerial service uninstall`);
      }
      if (r.bootout?.stderr) console.log(`  bootout stderr: ${r.bootout.stderr.trim()}`);
      if (r.delete?.stderr) console.log(`  schtasks stderr: ${r.delete.stderr.trim()}`);
      process.exitCode = r.ok ? 0 : 1;
    } catch (err) {
      if (/unsupported platform/.test(err.message)) {
        console.log(`service uninstall: skipped (${err.message})`);
        process.exitCode = 0;
      } else {
        console.log(`service uninstall: FAILED (${err.message})`);
        console.log(`  Retry with: aerial service uninstall`);
        process.exitCode = 1;
      }
    }
    return;
  }

  if (command === "service") {
    if (subcommand === "install") {
      try {
        const r = await serviceInstall();
        if (r.ok && r.note) console.log(`Service install: ${r.note} (${r.platform}).`);
        else if (r.ok) console.log(`Service installed (${r.platform}).`);
        else console.log(`Service install: FAILED (${r.reason || "unknown"}): ${r.message || ""}`);
        if (r.file) console.log(`  unit: ${r.file}`);
        if (r.taskName) console.log(`  task: ${r.taskName}`);
        if (r.wrapper) console.log(`  wrapper: ${r.wrapper}`);
        if (r.bootstrap?.stderr) console.log(`  bootstrap stderr: ${r.bootstrap.stderr.trim()}`);
        if (r.create?.stderr) console.log(`  schtasks stderr: ${r.create.stderr.trim()}`);
        if (r.run?.stderr) console.log(`  schtasks /Run stderr: ${r.run.stderr.trim()}`);
        if (r.warning) console.log(`  WARNING: ${r.warning.message}`);
        process.exitCode = r.ok ? 0 : 1;
      } catch (err) {
        console.error(err.message);
        process.exitCode = 1;
      }
      return;
    }
    if (subcommand === "start") {
      try {
        const r = await serviceStart();
        if (r.ok && r.note) console.log(`Service start: ${r.note} (${r.platform})`);
        else if (r.ok) console.log(`Service start: ok (${r.platform})`);
        else console.log(`Service start: FAILED (${r.reason || `status=${r.status}`})${r.message ? ": " + r.message : ""}`);
        if (r.stderr) console.log(`  ${r.stderr.trim()}`);
        if (r.warning) console.log(`  WARNING: ${r.warning.message}`);
        process.exitCode = r.ok ? 0 : 1;
      } catch (err) {
        console.error(err.message);
        process.exitCode = 1;
      }
      return;
    }
    if (subcommand === "stop") {
      try {
        const r = serviceStop();
        if (r.note) console.log(`Service stop: ${r.note} (${r.platform})`);
        else if (r.ok) console.log(`Service stop: ok (${r.platform})`);
        else console.log(`Service stop: FAILED (status=${r.status})`);
        if (r.stderr) console.log(`  ${r.stderr.trim()}`);
        process.exitCode = r.ok ? 0 : 1;
      } catch (err) {
        console.error(err.message);
        process.exitCode = 1;
      }
      return;
    }
    if (subcommand === "restart") {
      try {
        const r = await serviceRestart();
        if (!r.ok && r.reason === "stop_failed") console.log(`Service restart: FAILED on stop; start not attempted`);
        else if (r.ok) console.log(`Service restart: ok`);
        else console.log(`Service restart: FAILED`);
        if (r.stop?.stderr) console.log(`  stop: ${r.stop.stderr.trim()}`);
        if (r.start?.stderr) console.log(`  start: ${r.start.stderr.trim()}`);
        if (r.warning) console.log(`  WARNING: ${r.warning.message}`);
        process.exitCode = r.ok ? 0 : 1;
      } catch (err) {
        console.error(err.message);
        process.exitCode = 1;
      }
      return;
    }
    if (subcommand === "uninstall") {
      try {
        const r = serviceUninstall();
        if (r.note === "no service installed") console.log("Service uninstall: no service installed");
        else if (r.ok) console.log(`Service uninstall: ok (${r.platform})`);
        else {
          console.log(`Service uninstall: FAILED (${r.reason || "see stderr"})`);
          if (r.message) console.log(`  ${r.message}`);
          else console.log(`  Retry with: aerial service uninstall`);
        }
        if (r.delete?.stderr) console.log(`  schtasks stderr: ${r.delete.stderr.trim()}`);
        if (r.bootout?.stderr) console.log(`  bootout stderr: ${r.bootout.stderr.trim()}`);
        process.exitCode = r.ok ? 0 : 1;
      } catch (err) {
        console.error(err.message);
        process.exitCode = 1;
      }
      return;
    }
    if (subcommand === "status") {
      const status = await serviceStatus();
      if (rest.includes("--json")) {
        console.log(JSON.stringify(status, null, 2));
        process.exitCode = status.supported === false ? 1 : 0;
        return;
      }
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
      return;
    }
    console.error(`Unknown service subcommand: ${subcommand}. Use install, start, stop, restart, status, or uninstall.`);
    process.exitCode = 1;
    return;
  }

  if (command === "doctor") {
    const result = doctor();
    for (const check of result.checks) {
      console.log(`${check.ok ? "OK" : "FAIL"} ${check.name}: ${check.detail}`);
    }
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (command === "probe") {
    const report = await runProbe({ live: args.includes("--live") });
    if (args.includes("--json")) console.log(JSON.stringify(report, null, 2));
    else console.log(formatProbeReport(report));
    process.exitCode = report.ok ? 0 : 1;
    return;
  }

  if (command === "config") {
    const config = loadConfig();
    if (subcommand === "set") {
      const [key, value] = rest;
      if (!key || value === undefined) throw new Error("Usage: aerial config set <key> <value>");
      if (!["host", "port", "defaultModel", "logLevel", "promptCacheRetention", "promptCacheKey"].includes(key)) throw new Error(`Unsupported config key: ${key}`);
      if (key === "promptCacheRetention" && !["in_memory", "24h", "off"].includes(value)) throw new Error("promptCacheRetention must be one of: in_memory, 24h, off");
      if (key === "promptCacheKey" && !value.trim()) throw new Error("promptCacheKey must be auto, off, or a non-empty string");
      config[key] = key === "port" ? Number(value) : value;
      saveConfig(config);
      return;
    }
    console.log(JSON.stringify(config, null, 2));
    return;
  }

  printHelp();
  process.exitCode = 1;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
