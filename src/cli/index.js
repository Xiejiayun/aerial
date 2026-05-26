#!/usr/bin/env node
import { printVersion } from "./version.js";
import { printHelp } from "./help.js";
import { appStatus } from "./status-command.js";
import { runConfigCli } from "./config-command.js";
import { runDisableCli } from "./disable-command.js";
import { runKeyCli } from "./key-command.js";
import { runLoginCli } from "./login-command.js";
import { runProxyCli } from "./proxy-command.js";
import { runServiceCli } from "./service-command.js";
import { runSetupCli } from "./setup-command.js";
import { runStartCli } from "./start-command.js";
import { doctor, renderDoctorText } from "./doctor.js";
import { formatProbeReport, runProbe } from "./probe.js";

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

  if (command === "disable") {
    runDisableCli();
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

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
