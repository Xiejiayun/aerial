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
import { runUpdateCli } from "./commands/update.js";
import { doctor, renderDoctorText } from "./doctor.js";
import { formatProbeReport, runProbe } from "./probe.js";
import { hasCliHelp, parseGlobalArgs, validateCliArgs } from "./args.js";
import { setStderrLogging } from "../shared/log.js";

function printHelp(rawArgs = []) {
  const command = rawArgs[0] === "--config-dir" ? rawArgs[2] : rawArgs[0];
  if (command === "update" || command === "upgrade") return runUpdateCli(["--help"]);
  console.log(`Aerial local Copilot proxy

Usage:
  aerial --version
  aerial update [--check]
  aerial login [--provider <github|cowork>] [--force]
  aerial setup codex [--model <id>] [--effort <minimal|low|medium|high|xhigh|max|ultra>] [--configure-only] [--verbose]
  aerial setup claude [--provider <github|cowork>] [--model <id>] [--effort <low|medium|high|xhigh|max|ultracode>] [--configure-only] [--verbose]
  aerial service install|start|stop|restart|uninstall
  aerial status [--json]
  aerial proxy status|enable|disable [--json]

Experimental Cowork sessions (Windows, Node.js 24+):
  aerial cowork configure --profile <json> [--allow-unverified-cloud-tools]
  aerial login --provider cowork [--force]
  aerial cowork auth [--interactive] [--origin <https-url>]
  aerial cowork doctor [--json]
  aerial cowork models [--json]
  aerial cowork probe --model <id> [--effort <low|medium|high|xhigh|max>]
  aerial cowork verify --model <id> --effort <low|medium|high|xhigh|max>
  aerial cowork operations [--json]
  aerial cowork release <operation-id>
  aerial cowork run --model <id> [--effort <low|medium|high|xhigh|max>] [--claude <path>] -- [Claude arguments]
  aerial setup claude --provider cowork --model <exact-id> [--effort <low|medium|high|xhigh|max>] [--verbose]

Diagnostics and rollback:
  aerial setup status [--json]
  aerial setup restore <codex|claude|all> --latest
  aerial service status [--json]
  aerial teardown
  aerial doctor [--json]
  aerial probe [--live] [--json]

Debug:
  aerial start [--host 127.0.0.1] [--port 18181]
  aerial config
  aerial config set <key> <value>
  aerial config reset
  aerial key generate|print

Use aerial --config-dir <directory> <command> to select an Aerial configuration.
Login defaults to GitHub. Cowork requires a configured authentication profile and uses the Microsoft Windows sign-in window.
Setup verifies the running proxy and sends a brief upstream request before changing client settings.
Setup defaults to GitHub. Cowork model/effort pairs require explicit route verification; Codex stays on GitHub.
Use --configure-only with --model for GitHub offline settings; --verbose shows paths and helpers.
Set AERIAL_DEBUG=1 for structured debug events on stderr, or AERIAL_LOG_FILE for file logging.
Add --help to any command to view help without making changes.`);
}

let longRunning = false;
async function main() {
  const rawArgs = process.argv.slice(2);
  if (hasCliHelp(rawArgs)) return printHelp(rawArgs);
  const { args, configDir } = parseGlobalArgs(rawArgs);
  const [command, subcommand, ...rest] = args;
  if (validateCliArgs(args).help) return printHelp();
  if (configDir) process.env.AERIAL_CONFIG_DIR = configDir;
  if (command === "--version") return printVersion();
  setStderrLogging(command === "start" || process.env.AERIAL_DEBUG === "1");

  if (command === "cowork") {
    const { runCoworkCli } = await import("./commands/cowork.js");
    process.exitCode = await runCoworkCli(subcommand, rest);
    return;
  }

  if (command === "update" || command === "upgrade") {
    runUpdateCli(args.slice(1));
    return;
  }

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
    process.exitCode = await runLoginCli(args.slice(1));
    return;
  }

  if (command === "key") {
    if (runKeyCli(subcommand)) return;
  }

  if (command === "start") {
    runStartCli(args);
    longRunning = true;
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
    // after the work is done. Cowork awaits its child and closes its gateway
    // before resolving; only the ordinary `start` server outlives main().
    if (!longRunning) process.exit(process.exitCode ?? 0);
  })
  .catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
