#!/usr/bin/env node
import { startDeviceFlow, pollDeviceFlow } from "./auth.js";
import { ensureApiKey, loadConfig, saveConfig } from "./config.js";
import { startServer } from "./server.js";
import { setupClaude, setupCodex } from "./setup.js";
import { doctor } from "./doctor.js";

function printHelp() {
  console.log(`Aerial local Copilot proxy

Usage:
  aerial login
  aerial key generate
  aerial key print
  aerial start [--host 127.0.0.1] [--port 18181]
  aerial setup codex [--model <id>]
  aerial setup claude
  aerial setup all [--model <id>]
  aerial doctor

MVP routes:
  GET  /health
  GET  /v1/models
  POST /v1/responses
  POST /v1/messages
  POST /v1/messages/count_tokens`);
}

function argValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  const [command, subcommand, ...rest] = args;
  if (!command || command === "--help" || command === "-h") return printHelp();

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
        console.log(result.apiKey);
        console.error("Save this value as AERIAL_API_KEY. It will not be shown again by config.");
      } else {
        console.error("Aerial API key already configured. Use AERIAL_API_KEY env or rotate by editing config.");
      }
      return;
    }
    if (subcommand === "print") {
      const result = ensureApiKey();
      if (process.env.AERIAL_API_KEY) console.log(process.env.AERIAL_API_KEY);
      else if (result.apiKey) console.log(result.apiKey);
      else throw new Error("Raw API key is not stored. Set AERIAL_API_KEY in your environment.");
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
      return;
    }
    if (subcommand === "claude") {
      const result = setupClaude();
      console.log(`Updated Claude settings: ${result.file}`);
      if (result.backup) console.log(`Backup: ${result.backup}`);
      return;
    }
    if (subcommand === "all") {
      const codex = setupCodex({ model: argValue(rest, "--model") });
      const claude = setupClaude();
      console.log(`Updated Codex config: ${codex.file}`);
      console.log(`Updated Claude settings: ${claude.file}`);
      return;
    }
  }

  if (command === "doctor") {
    const result = doctor();
    for (const check of result.checks) {
      console.log(`${check.ok ? "OK" : "FAIL"} ${check.name}: ${check.detail}`);
    }
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (command === "config") {
    const config = loadConfig();
    if (subcommand === "set") {
      const [key, value] = rest;
      if (!key || value === undefined) throw new Error("Usage: aerial config set <key> <value>");
      if (!["host", "port", "defaultModel", "logLevel", "promptCacheRetention"].includes(key)) throw new Error(`Unsupported config key: ${key}`);
      if (key === "promptCacheRetention" && !["in_memory", "24h", "off"].includes(value)) throw new Error("promptCacheRetention must be one of: in_memory, 24h, off");
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
