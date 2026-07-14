#!/usr/bin/env node
import { printVersion } from "./helpers.js";
import { appStatus } from "./commands/status.js";
import { runConfigCli } from "./commands/config.js";
import { runTeardownCli } from "./commands/teardown.js";
import { runKeyCli } from "./commands/key.js";
import { runLoginCli } from "./commands/login.js";
import { runProxyCli } from "./commands/proxy.js";
import { runServiceCli } from "./commands/service.js";
import { runSetupCli } from "./commands/setup.js";
import { runStartCli } from "./commands/start.js";
import { doctor, renderDoctorText } from "./doctor.js";
import { formatProbeReport, runProbe } from "./probe.js";

function printHelp() {
  console.log(`Aerial local Copilot proxy

Usage:
  aerial --version
  aerial login
  aerial setup codex [--model <id>] [--effort <minimal|low|medium|high|xhigh|max|ultra>]
  aerial setup claude [--model <id>] [--effort <low|medium|high|xhigh|max>]
  aerial service install
  aerial status [--json]
  aerial proxy status|enable|disable [--json]

Diagnostics and rollback:
  aerial setup status [--json]
  aerial setup restore <codex|claude|all> --latest
  aerial service status [--json]
  aerial teardown
  aerial doctor
  aerial probe [--live] [--json]

Debug:
  aerial start [--host 127.0.0.1] [--port 18181]`);
}

async function main() {
  const args = process.argv.slice(2);
  const [command, subcommand, ...rest] = args;
  if (!command || command === "--help" || command === "-h") return printHelp();
  if (command === "--version") return printVersion();

  if (command === "status") {
    const status = await appStatus({ json: args.includes("--json") });
    process.exitCode = status.ok ? 0 : 1;
    return;
  }

  if (command === "proxy") {
    await runProxyCli(subcommand, rest);
    return;
  }

  if (command === "login") {
    await runLoginCli(args.slice(1));
    return;
  }

  if (command === "key") {
    if (runKeyCli(subcommand)) return;
  }

  if (command === "start") {
    runStartCli(args);
    return;
  }

  if (command === "setup") {
    if (["codex", "claude", "all", "status", "restore"].includes(subcommand)) {
      await runSetupCli(subcommand, rest);
      return;
    }
  }

  if (command === "teardown") {
    runTeardownCli();
    return;
  }

  if (command === "service") {
    await runServiceCli(subcommand, rest);
    return;
  }

  if (command === "doctor") {
    const report = await doctor();
    if (args.includes("--json")) console.log(JSON.stringify(report, null, 2));
    else console.log(renderDoctorText(report));
    process.exitCode = report.ok ? 0 : 1;
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
    runConfigCli(subcommand, rest);
    return;
  }

  printHelp();
  process.exitCode = 1;
}

main()
  .then(() => {
    // One-shot commands may leave keep-alive sockets (undici pools), a SOCKS5
    // bridge, or stdin open, which keeps the event loop alive and hangs the CLI
    // after the work is done. `start` is the only long-running command, so for
    // everything else exit explicitly once main() resolves.
    const command = process.argv[2];
    if (command !== "start") process.exit(process.exitCode ?? 0);
  })
  .catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
