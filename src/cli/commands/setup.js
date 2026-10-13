import fs from "node:fs";
import { loadConfig } from "../../shared/config.js";
import { configPath } from "../../shared/paths.js";
import { restoreAllClients, restoreClient, setupClaude, setupCodex, setupStatus } from "../../setup/index.js";
import {
  assertValidCodexEffort,
  assertValidEffort,
  chooseSetupEffort,
  chooseSetupModel,
  discoverModelsForRoute,
  formatEffortSelection,
  formatModelChoices
} from "../select.js";
import { requiredArgValue, claudeApiKeyHelper, codexAuthCommand } from "../helpers.js";
import { printRestoreResults, printSetupCompletionSummary } from "../output.js";
import { localBaseUrl } from "../../shared/urls.js";
import { verifySetupReadiness } from "../setup-readiness.js";
import { CLIENTS } from "../../setup/clients.js";
import { assertClaudeEnvironment } from "../../setup/claude-conflicts.js";

async function selectSetupOptions(target, route, args) {
  const configureOnly = args.includes("--configure-only");
  const explicitModel = requiredArgValue(args, "--model");
  if (configureOnly && !explicitModel) throw new Error("--configure-only requires --model <id>; offline setup cannot discover available models.");
  const explicitEffort = requiredArgValue(args, "--effort");
  if (explicitEffort !== undefined) {
    if (target === "Codex") assertValidCodexEffort(explicitEffort);
    else assertValidEffort(explicitEffort);
  }
  const selected = await chooseSetupModel({ target, route, explicitModel });
  if (!selected.displayed) {
    for (const line of formatModelChoices({ target, route, choices: selected.choices, selectedModel: selected.model, source: selected.source, recommended: selected.recommended })) {
      console.log(line);
    }
  } else {
    console.log(`Selected ${target} model: ${selected.model}`);
  }
  let selectedModel = selected.choices.find((choice) => choice.id === selected.model);
  if (!selectedModel && selected.source === "explicit" && !configureOnly) {
    selected.choices = await discoverModelsForRoute(route);
    selectedModel = selected.choices.find((choice) => choice.id === selected.model);
    if (!selectedModel) throw new Error(`${selected.model} does not advertise the ${route} route required by ${target}. Run aerial probe and select an available model. Client configuration was not changed.`);
  }
  const effortChoice = await chooseSetupEffort({
    target,
    explicitEffort,
    model: selected.model,
    supportedEfforts: selectedModel?.supportedEfforts
  });
  console.log(formatEffortSelection({
    target,
    effort: effortChoice.effort,
    requestedEffort: effortChoice.requestedEffort,
    reason: effortChoice.reason,
    source: effortChoice.source,
    supportedEfforts: effortChoice.supportedEfforts
  }));
  return {
    model: selected.model,
    effort: effortChoice.effort,
    modelSource: selected.source,
    effortSource: effortChoice.source,
    modelDisplayed: Boolean(selected.displayed),
    effortDisplayed: Boolean(effortChoice.displayed),
    models: selected.choices
  };
}

function printSetupStatus(status) {
  console.log(`Aerial: ${localBaseUrl(status.config)}  (platform: ${status.platform})`);
  console.log(`API key file:    ${status.auth.api_key.file}  (${status.auth.api_key.exists ? "present" : "missing"})`);
  const ghSourceText = status.auth.github_token.source === "missing"
    ? `(missing)`
    : status.auth.github_token.source === "env"
      ? `(present, source=env; file path ${status.auth.github_token.file} is not consulted while AERIAL_GITHUB_TOKEN is set)`
      : `${status.auth.github_token.file}  (present, source=file)`;
  console.log(`GitHub token:    ${ghSourceText}`);
  for (const cs of Object.values(status.clients)) {
    const head = `${cs.target.padEnd(7)} state=${cs.state}`;
    const effortText = ` effort=${cs.effort || "missing"}`;
    console.log(`${head}${effortText}  file=${cs.file}`);
    if (cs.backups.length) console.log(`         backups=${cs.backups.length}`);
    if (cs.error) console.log(`         error=${cs.error}`);
    for (const conflict of cs.conflicts || []) console.log(`         override: ${conflict.source}.${conflict.key}`);
    if (cs.migration) console.log(`         migration=${cs.migration}`);
  }
}

export async function runSetupCli(subcommand, rest) {
  if (subcommand === "codex" || subcommand === "claude") {
    const isCodex = subcommand === "codex";
    const cli = isCodex ? "Codex" : "Claude Code";
    const route = isCodex ? "responses" : "messages";
    if (!isCodex) assertClaudeEnvironment(loadConfig());
    const client = CLIENTS[subcommand];
    if (fs.existsSync(client.file())) {
      try { client.validateBackup(fs.readFileSync(client.file())); }
      catch (error) { throw new Error(error.message.replace("Restore aborted: backup", "Setup aborted: client configuration")); }
    }
    const options = await selectSetupOptions(cli, route, rest);
    let readiness = { verified: false };
    if (!rest.includes("--configure-only")) {
      console.log(`Checking the local proxy, key helper and ${route} route (one brief upstream request)...`);
      readiness = await verifySetupReadiness({ route, model: options.model, effort: options.effort });
    }
    const result = isCodex
      ? setupCodex({ model: options.model, effort: options.effort, authCommand: codexAuthCommand() })
      : setupClaude({ model: options.model, effort: options.effort, models: options.models, apiKeyHelper: claudeApiKeyHelper() });
    const config = loadConfig();
    printSetupCompletionSummary({
      heading: `Configured ${cli}`,
      cli,
      model: result.model,
      effort: result.effort || "client default",
      proxy: localBaseUrl(config, isCodex ? "/v1" : ""),
      configFile: result.file,
      aerialConfigFile: configPath(),
      aerialDefaultEffort: config.defaultEffort || "missing",
      backup: result.backup,
      auth: isCodex ? "command-backed local Aerial key" : "apiKeyHelper local Aerial key",
      readiness,
      verbose: rest.includes("--verbose"),
      notes: [readiness.verified
        ? `Restart ${cli}, then send a prompt to verify its active settings. Project or managed settings may override user settings.`
        : `Start Aerial, then rerun aerial setup ${subcommand} to verify before using the client.`]
    });
    return;
  }
  if (subcommand === "all") {
    throw new Error("aerial setup all has been removed. Run `aerial setup codex` and/or `aerial setup claude` instead.");
  }
  if (subcommand === "status") {
    const status = setupStatus();
    if (rest.includes("--json")) {
      console.log(JSON.stringify(status, null, 2));
      return;
    }
    printSetupStatus(status);
    return;
  }
  if (subcommand === "restore") {
    const which = rest[0];
    if (!which) throw new Error("Usage: aerial setup restore <codex|claude|all> --latest");
    if (!rest.includes("--latest")) throw new Error("aerial setup restore: only --latest is supported in this release");
    if (which === "all") {
      const { ok, results } = restoreAllClients();
      printRestoreResults(results);
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
