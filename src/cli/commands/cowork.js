import { requiredArgValue } from "../helpers.js";
import { launchCoworkClaude, validateClaudeArguments } from "../../cowork/launcher.js";
import { validateInvestigationEffort } from "../../cowork/transport.js";

export function assertCoworkRuntime({ platform = process.platform, nodeVersion = process.versions.node } = {}) {
  if (platform !== "win32") throw new Error("Cowork authentication currently requires Windows. Existing Aerial GitHub Copilot commands remain available on this platform.");
  const major = Number(String(nodeVersion).split(".")[0]);
  if (!Number.isInteger(major) || major < 24) throw new Error("Cowork commands require Node.js 24 or newer. Existing Aerial commands retain their current Node.js requirement.");
}

export async function runCoworkCli(command, args, {
  core, launch = launchCoworkClaude, runtime, print = console.log, warn = console.error
} = {}) {
  assertCoworkRuntime(runtime);
  const separator = args.indexOf("--");
  const options = separator < 0 ? args : args.slice(0, separator);
  const claudeArgs = separator < 0 ? [] : args.slice(separator + 1);
  const profile = command === "configure" ? requiredArgValue(options, "--profile") : undefined;
  if (command === "configure" && !profile?.trim()) throw new Error("aerial cowork configure requires --profile <json> containing the authorized-session protocol evidence.");
  let model;
  if (command === "run" || command === "probe") {
    model = requiredArgValue(options, "--model");
    if (!model?.trim()) throw new Error(`aerial cowork ${command} requires --model <id>. Run aerial cowork models and explicitly select an available route.`);
    if (command === "run") validateClaudeArguments(claudeArgs);
  }
  const effort = command === "probe" ? requiredArgValue(options, "--effort") : undefined;
  if (command === "probe") validateInvestigationEffort(effort);
  const origin = command === "auth" ? requiredArgValue(options, "--origin") : undefined;
  if (origin) {
    const url = new URL(origin);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("Cowork --origin must be an HTTPS origin without credentials, path, query or fragment.");
  }
  const api = core || await import("../../cowork/index.js");
  if (command === "configure") {
    await api.configureCowork({ file: profile });
    print("Cowork protocol profile saved. Run aerial cowork auth, then aerial cowork doctor to check its evidence and identity.");
    return 0;
  }
  if (command === "auth") {
    print("Opening the Microsoft Windows sign-in window. Complete account selection and MFA there; close the Aerial sign-in window to cancel.");
    await api.authenticateCowork({ interactive: true, ...(origin ? { origin } : {}) });
    print("Cowork identity saved. Run aerial cowork models to inspect the available routes.");
    return 0;
  }
  if (command === "doctor") {
    const report = await api.inspectCowork();
    if (options.includes("--json")) print(JSON.stringify(report, null, 2));
    else {
      print(`Cowork: ${report.ok ? "ready" : "not ready"}`);
      if (report.status) print(`  status: ${report.status}`);
      if (report.authentication || report.catalog) print(`  authentication: ${report.authentication || "unknown"}; catalog: ${report.catalog || "unknown"}`);
      for (const check of report.checks || []) print(`  ${check.ok ? "ok" : "failed"}: ${check.message || check.name || check.id}`);
      if (report.error) print(`  ${typeof report.error === "string" ? report.error : report.error.message || report.error.code}`);
      print("This check does not send an inference request.");
    }
    return report.ok ? 0 : 1;
  }
  if (command === "models") {
    const result = await api.listCoworkModels();
    if (options.includes("--json")) print(JSON.stringify(result, null, 2));
    else {
      const models = Array.isArray(result) ? result : result.models || result.data || [];
      for (const entry of models) print(`${entry.publicId || entry.id}  ${entry.displayName || entry.display_name || entry.name || ""}`.trimEnd());
      if (!models.length) print("No Cowork model routes are available for this identity.");
      print("Select an exact route with: aerial cowork run --model <id>");
    }
    return 0;
  }
  if (command === "run") {
    warn("Cowork compatibility mode: simulated tools, buffered output, and estimated usage. Model requests consume Cowork allowance.");
    const result = await launch({
      model, executable: requiredArgValue(options, "--claude"), args: claudeArgs,
      openSession: api.openCoworkSession, warn
    });
    return result.exitCode;
  }
  if (command === "probe") {
    warn("Sending one fixed synthetic Cowork text probe. This consumes Cowork allowance and does not establish Claude Code tool compatibility.");
    const report = await api.probeCowork({ model, ...(effort !== undefined ? { effort } : {}) });
    print(JSON.stringify(report, null, 2));
    return report.ok === false ? 1 : 0;
  }
  if (command === "operations") {
    const records = await api.listCoworkOperations();
    if (options.includes("--json")) print(JSON.stringify(records, null, 2));
    else {
      for (const record of records) print(`${record.id}  phase=${record.phase}  remote=${record.remoteState || "unknown"}  local=${record.localOutcome || "unknown"}`);
      if (!records.length) print("No Cowork operation records.");
    }
    return 0;
  }
  if (command === "release") {
    const id = options[0];
    if (!id?.trim()) throw new Error("aerial cowork release requires an operation ID from aerial cowork operations.");
    await api.releaseCoworkOperation({ id });
    print(`Released retry protection for ${id}. This does not cancel a remote task or send inference. A later retry can consume additional Cowork allowance.`);
    return 0;
  }
  throw new Error(`Unknown Cowork command: ${command}`);
}
