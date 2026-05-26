import { loadConfig } from "../shared/config.js";
import { configPath } from "../shared/paths.js";
import { restoreAllClients, restoreClient, setupClaude, setupCodex, setupStatus } from "../setup/index.js";
import { chooseSetupModel, formatModelChoices } from "./model-selection.js";
import { assertValidEffort, chooseSetupEffort, formatEffortSelection } from "./setup-selection.js";
import { requiredArgValue } from "./args.js";
import { claudeApiKeyHelper, codexAuthCommand } from "./runtime-auth.js";
import { printRestoreResults, printSetupCompletionSummary } from "./output.js";

async function selectSetupOptions(target, route, args) {
  const explicitEffort = requiredArgValue(args, "--effort");
  if (explicitEffort !== undefined) assertValidEffort(explicitEffort);
  const selected = await chooseSetupModel({ target, route, explicitModel: requiredArgValue(args, "--model") });
  if (!selected.displayed) {
    for (const line of formatModelChoices({ target, route, choices: selected.choices, selectedModel: selected.model, source: selected.source, recommended: selected.recommended })) {
      console.log(line);
    }
  } else {
    console.log(`Selected ${target} model: ${selected.model}`);
  }
  const effortChoice = await chooseSetupEffort({ target, explicitEffort });
  console.log(formatEffortSelection({ target, effort: effortChoice.effort, source: effortChoice.source }));
  return {
    model: selected.model,
    effort: effortChoice.effort,
    modelSource: selected.source,
    effortSource: effortChoice.source,
    modelDisplayed: Boolean(selected.displayed),
    effortDisplayed: Boolean(effortChoice.displayed)
  };
}

function printSetupStatus(status) {
  console.log(`Aerial: http://${status.config.host}:${status.config.port}  (platform: ${status.platform})`);
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
  }
}

export async function runSetupCli(subcommand, rest) {
  if (subcommand === "codex") {
    const options = await selectSetupOptions("Codex", "responses", rest);
    const result = setupCodex({ model: options.model, effort: options.effort, authCommand: codexAuthCommand() });
    const config = loadConfig();
    printSetupCompletionSummary({
      heading: "Configured Codex",
      cli: "Codex",
      model: result.model,
      effort: result.effort || "missing",
      proxy: `http://${config.host}:${config.port}/v1`,
      configFile: result.file,
      aerialConfigFile: configPath(),
      aerialDefaultEffort: config.defaultEffort || "missing",
      backup: result.backup,
      auth: "command-backed local Aerial key",
      notes: ["restart Codex if it was already running so it reloads the profile."]
    });
    return;
  }
  if (subcommand === "claude") {
    const options = await selectSetupOptions("Claude Code", "messages", rest);
    const result = setupClaude({ model: options.model, effort: options.effort, apiKeyHelper: claudeApiKeyHelper() });
    const config = loadConfig();
    printSetupCompletionSummary({
      heading: "Configured Claude Code",
      cli: "Claude Code",
      model: result.model || "preserved",
      effort: result.effort || config.defaultEffort || "missing",
      proxy: `http://${config.host}:${config.port}`,
      configFile: result.file,
      aerialConfigFile: configPath(),
      aerialDefaultEffort: config.defaultEffort || "missing",
      backup: result.backup,
      auth: "apiKeyHelper local Aerial key",
      notes: ["effort is applied via Aerial defaultEffort and proxy fallback; Claude settings.json does not store an effort value."]
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
