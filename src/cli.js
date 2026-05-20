#!/usr/bin/env node
import { startDeviceFlow, pollDeviceFlow } from "./auth.js";
import { ensureApiKey, loadConfig, saveConfig } from "./config.js";
import { startServer } from "./server.js";
import { setupClaude, setupCodex, setupStatus, restoreClient, restoreAllClients } from "./setup.js";
import { doctor } from "./doctor.js";
import { runProbe, formatProbeReport } from "./probe.js";
import { printVersion } from "./version.js";

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
      const result = setupCodex({ model: argValue(rest, "--model") });
      console.log(`Updated Codex config: ${result.file}`);
      if (result.backup) console.log(`Backup: ${result.backup}`);
      if (result.env?.persisted) console.log(`Configured ${result.env.name} for new user sessions.`);
      else if (result.env?.reason) console.log(`Note: ${result.env.name} is available in this process, but was not persisted (${result.env.reason}).`);
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
      const codex = setupCodex({ model });
      const claude = setupClaude({ model });
      console.log(`Updated Codex config: ${codex.file}`);
      if (codex.env?.persisted) console.log(`Configured ${codex.env.name} for new user sessions.`);
      else if (codex.env?.reason) console.log(`Note: ${codex.env.name} is available in this process, but was not persisted (${codex.env.reason}).`);
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
    console.log("service uninstall: not available until service support is installed");
    process.exitCode = ok ? 0 : 1;
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
