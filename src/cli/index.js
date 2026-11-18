#!/usr/bin/env node
import { printVersion } from "./helpers.js";
import { parseGlobalArgs, validateCliArgs } from "./args.js";
import { setStderrLogging } from "../shared/log.js";

async function printHelp(rawArgs = []) {
  const command = rawArgs[0] === "--config-dir" ? rawArgs[2] : rawArgs[0];
  if (command === "update" || command === "upgrade") {
    const { runUpdateCli } = await import("./commands/update.js");
    return runUpdateCli(["--help"]);
  }
  console.log(`Aerial local Copilot proxy

Usage:
  aerial --version
  aerial update [--check]
  aerial login [--force]
  aerial setup codex [--model <id>] [--effort <minimal|low|medium|high|xhigh|max|ultra>] [--configure-only] [--verbose]
  aerial setup claude [--model <id>] [--effort <low|medium|high|xhigh|max|ultracode>] [--configure-only] [--verbose]
  aerial service install|start|stop|restart|uninstall
  aerial status [--gateway] [--json]

Diagnostics and rollback:
  aerial setup status [--json]
  aerial setup restore <codex|claude|all> --latest
  aerial service status [--json]
  aerial teardown
  aerial doctor [--gateway] [--json]
  aerial probe [--live] [--json]

Debug:
  aerial start [--host 127.0.0.1] [--port 18181]
  aerial config
  aerial config set <key> <value>
  aerial config reset
  aerial key generate|print

Use aerial --config-dir <directory> <command> to select an Aerial configuration.
Setup verifies the running proxy and sends a brief upstream request before changing client settings.
Use --configure-only with --model to save unverified offline settings; --verbose shows paths and helpers.
Set AERIAL_DEBUG=1 for structured debug events on stderr, or AERIAL_LOG_FILE for file logging.
Add --help to any command to view help without making changes.`);
}

let longRunning = false;
async function main() {
  const rawArgs = process.argv.slice(2);
  if (rawArgs.includes("--help") || rawArgs.includes("-h")) return printHelp(rawArgs);
  const { args, configDir } = parseGlobalArgs(rawArgs);
  const [command, subcommand, ...rest] = args;
  if (validateCliArgs(args).help) return printHelp();
  if (configDir) process.env.AERIAL_CONFIG_DIR = configDir;
  if (command === "--version") return printVersion();
  setStderrLogging(command === "start" || process.env.AERIAL_DEBUG === "1");

  if (command === "update" || command === "upgrade") {
    const { runUpdateCli } = await import("./commands/update.js");
    runUpdateCli(args.slice(1));
    return;
  }

  if (command === "status") {
    const { appStatus } = await import("./commands/status.js");
    const status = await appStatus({ json: args.includes("--json"), gateway: args.includes("--gateway") });
    process.exitCode = status.ok ? 0 : 1;
    return;
  }

  if (command === "login") {
    const { runLoginCli } = await import("./commands/login.js");
    await runLoginCli(args.slice(1));
    return;
  }

  if (command === "key") {
    const { runKeyCli } = await import("./commands/key.js");
    return runKeyCli(subcommand);
  }

  if (command === "start") {
    const { runStartCli } = await import("./commands/start.js");
    runStartCli(args);
    longRunning = true;
    return;
  }

  if (command === "setup") {
    const { runSetupCli } = await import("./commands/setup.js");
    return runSetupCli(subcommand, rest);
  }

  if (command === "teardown") {
    const { runTeardownCli } = await import("./commands/teardown.js");
    runTeardownCli();
    return;
  }

  if (command === "service") {
    const { runServiceCli } = await import("./commands/service.js");
    await runServiceCli(subcommand, rest);
    return;
  }

  if (command === "doctor") {
    const { doctor, renderDoctorText } = await import("./doctor.js");
    const report = await doctor({ gateway: args.includes("--gateway") });
    if (args.includes("--json")) console.log(JSON.stringify(report, null, 2));
    else console.log(renderDoctorText(report));
    process.exitCode = report.ok ? 0 : 1;
    return;
  }

  if (command === "probe") {
    const { formatProbeReport, runProbe } = await import("./probe.js");
    const report = await runProbe({ live: args.includes("--live") });
    if (args.includes("--json")) console.log(JSON.stringify(report, null, 2));
    else console.log(formatProbeReport(report));
    process.exitCode = report.ok ? 0 : 1;
    return;
  }

  if (command === "config") {
    const { runConfigCli } = await import("./commands/config.js");
    runConfigCli(subcommand, rest);
    return;
  }

  await printHelp();
  process.exitCode = 1;
}

main()
  .then(() => {
    // One-shot commands may leave keep-alive sockets or stdin open, which keeps the event loop alive and hangs the CLI
    // after the work is done. `start` is the only long-running command, so for
    // everything else exit explicitly once main() resolves.
    if (!longRunning) process.exit(process.exitCode ?? 0);
  })
  .catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
