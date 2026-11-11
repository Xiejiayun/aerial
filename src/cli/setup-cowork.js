import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { ensureApiKey, loadConfig, readConfigFileStatus, saveConfig } from "../shared/config.js";
import { configPath } from "../shared/paths.js";
import { localBaseUrl } from "../shared/urls.js";
import { readJsonSafely } from "../shared/utils.js";
import { coworkDirectory, openCoworkSession } from "../cowork/index.js";
import { verifyClaudeVersion } from "../cowork/launcher.js";
import { claudeApiKeyHelper, codexAuthCommand } from "../setup/auth-helper.js";
import { assertClaudeEnvironment } from "../setup/claude-conflicts.js";
import { DEFAULT_COWORK_EFFORT, COWORK_CLIENT_EFFORTS, readCoworkClaudeSettings, setupCoworkClaude } from "../setup/cowork-claude.js";
import { assertCoworkRuntime } from "./commands/cowork.js";
import { errorDetail } from "./errors.js";
import { requiredArgValue } from "./helpers.js";
import { printSetupCompletionSummary } from "./output.js";

function verifiedStatus(report, { model, directory, effort }) {
  if (report?.provider !== "cowork" || report.configured !== true || report.ready !== true
    || !/^cowork\/[a-z0-9._-]{1,180}$/.test(report.model || "")
    || (model !== report.model && model !== report.upstreamModel)
    || typeof report.profileDirectory !== "string" || !path.isAbsolute(report.profileDirectory) || path.resolve(report.profileDirectory) !== directory
    || report.effort !== effort || !Array.isArray(report.supportedEfforts) || !report.supportedEfforts.includes(effort)
    || !(report.cloudToolIsolation === "verified" || report.cloudToolIsolation === "unverified" && report.experimentalTrial === true)) {
    throw new Error("The Cowork service did not verify the selected model, profile, effort and isolation policy. Client configuration was not changed.");
  }
  return report;
}

export async function setupCoworkProvider({ model, effort = DEFAULT_COWORK_EFFORT, configureOnly = false } = {}, {
  fetchImpl = globalThis.fetch, run = spawnSync, checkVersion = verifyClaudeVersion,
  checkRuntime = assertCoworkRuntime, openSession = openCoworkSession, directory = coworkDirectory(),
  writeClient = setupCoworkClaude
} = {}) {
  if (!model?.trim()) throw new Error("Cowork setup requires --model <exact-catalog-id>. Run aerial cowork models first.");
  if (!COWORK_CLIENT_EFFORTS.includes(effort)) throw new Error(`Unsupported Cowork effort. Choose ${COWORK_CLIENT_EFFORTS.join(", ")}; client configuration was not changed.`);
  if (configureOnly) throw new Error("Cowork setup requires a running proxy and verified profile; --configure-only is not supported. Client configuration was not changed.");
  checkRuntime();
  const claudeVersion = checkVersion();
  const fileStatus = readConfigFileStatus();
  if (!fileStatus.ok || fileStatus.exists && (!fileStatus.value || typeof fileStatus.value !== "object" || Array.isArray(fileStatus.value))) throw new Error("The Aerial configuration is unreadable. Correct it before Cowork setup; client configuration was not changed.");
  const initial = loadConfig();
  assertClaudeEnvironment(initial);
  const initialClient = readCoworkClaudeSettings();
  const base = localBaseUrl(initial);
  let health;
  try {
    const response = await fetchImpl(`${base}/health`, { signal: AbortSignal.timeout(3000), redirect: "error" });
    health = await readJsonSafely(response);
    if (!response.ok || health?.service !== "aerial" || health.ok !== true) throw new Error("The configured port is not a healthy Aerial proxy.");
  } catch (error) {
    throw new Error(`Aerial is not ready at ${base}: ${errorDetail(error)}. Start or restart Aerial, then retry. Client configuration was not changed.`);
  }
  ensureApiKey();
  const command = codexAuthCommand();
  const result = run(command.command, command.args, { encoding: "utf8", windowsHide: true, timeout: command.timeout_ms, env: process.env });
  const key = result.stdout?.trim();
  if (result.status !== 0 || !key) throw new Error("The Aerial key helper failed. Client configuration was not changed.");
  const headers = { authorization: `Bearer ${key}` };
  const status = async (reload = false) => {
    const response = await fetchImpl(`${base}/_aerial/cowork/${reload ? "reload" : "status"}`, { ...(reload ? { method: "POST" } : {}), headers, signal: AbortSignal.timeout(30000), redirect: "error" });
    const body = await readJsonSafely(response);
    if (!response.ok || body?.error) throw new Error(`Cowork service verification failed: ${errorDetail(body)}. Restart the updated Aerial service if required. Client configuration was not changed.`);
    if (body?.provider !== "cowork" || typeof body.configured !== "boolean") throw new Error("The running Aerial service does not provide Cowork status. Update and restart it before setup.");
    return body;
  };
  const absoluteDirectory = path.resolve(directory);
  const before = loadConfig().cowork;
  let report = await status();
  let selected, changed = false, reloadRequired = false;
  if (report.configured) {
    report = verifiedStatus(report, { model: before?.model, directory: absoluteDirectory, effort: before?.effort });
    if (!before || before.model !== report.model || path.resolve(before.profileDirectory) !== absoluteDirectory || before.effort !== report.effort) throw new Error("Cowork service and saved configuration differ. Restart Aerial before setup; client configuration was not changed.");
    selected = before;
    if (model !== report.model && model !== report.upstreamModel || effort !== report.effort) {
      const response = await fetchImpl(`${base}/_aerial/cowork/catalog`, { headers, signal: AbortSignal.timeout(30000), redirect: "error" });
      const catalog = await readJsonSafely(response);
      if (!response.ok || catalog?.provider !== "cowork" || catalog.configured !== true || catalog.profileDirectory !== absoluteDirectory || !Array.isArray(catalog.models)) throw new Error("The Cowork service could not provide its authenticated model catalog. Client configuration was not changed.");
      const route = catalog.models.find(item => item.publicId === model || item.upstreamId === model);
      if (!route || route.provider !== "anthropic" || !route.supportedEfforts?.includes(effort)) throw new Error("The requested Cowork model or effort is not advertised by its catalog. No fallback was used.");
      selected = { model: route.publicId, profileDirectory: absoluteDirectory, effort, ...(route.displayName ? { displayName: route.displayName } : {}) };
      reloadRequired = true;
    }
  } else {
    if (before) throw new Error("The running Aerial service has not loaded its Cowork configuration. Restart it before setup; client configuration was not changed.");
    const session = await openSession({ model, effort, directory: absoluteDirectory });
    try {
      report = verifiedStatus({ provider: "cowork", configured: true, ready: true, model: session.model,
        upstreamModel: session.route?.upstreamId, profileDirectory: absoluteDirectory,
        effort: session.capabilities?.clientEffort, supportedEfforts: session.capabilities?.supportedEfforts,
        cloudToolIsolation: session.capabilities?.cloudToolIsolation, experimentalTrial: session.capabilities?.experimentalTrial },
      { model, directory: absoluteDirectory, effort });
      selected = { model: report.model, profileDirectory: absoluteDirectory, effort,
        ...(session.route?.displayName ? { displayName: session.route.displayName } : {}) };
    } finally { await session.close(); }
  }
  if (!isDeepStrictEqual(selected, before)) {
    const current = loadConfig();
    if (!isDeepStrictEqual(current.cowork, before)) throw new Error("Cowork configuration changed during setup. Retry after reviewing the current configuration.");
    saveConfig({ ...current, cowork: selected });
    changed = true;
  }
  try {
    report = verifiedStatus(await status(reloadRequired), { model: selected.model, directory: absoluteDirectory, effort });
    const response = await fetchImpl(`${base}/v1/messages`, {
      method: "POST", signal: AbortSignal.timeout(120000), redirect: "error",
      headers: { ...headers, "content-type": "application/json", "anthropic-version": "2023-06-01", "idempotency-key": randomUUID() },
      body: JSON.stringify({ model: selected.model, max_tokens: 16, stream: false,
        messages: [{ role: "user", content: "Reply with OK." }], output_config: { effort } })
    });
    const body = await readJsonSafely(response);
    if (!response.ok || body?.error || body?.type !== "message" || !Array.isArray(body.content)) throw new Error(`Cowork route verification failed: ${errorDetail(body)}. Client configuration was not changed.`);
    const current = loadConfig();
    if (localBaseUrl(current) !== base || !isDeepStrictEqual(current.cowork, selected)) throw new Error("Aerial routing changed during setup. Client configuration was not changed; review the service configuration before retrying.");
    // Client writes are last; their backup and takeover journal preserve recovery.
    const client = writeClient({ model: selected.model, effort, apiKeyHelper: claudeApiKeyHelper() });
    return { ...client, claudeVersion, status: report,
      readiness: { verified: true, localProxy: true, authHelper: true, upstreamRoute: "messages", model: selected.model } };
  } catch (error) {
    if (changed) {
      let clientUnchanged = false;
      try {
        const currentClient = readCoworkClaudeSettings();
        clientUnchanged = currentClient.file === initialClient.file && currentClient.original === initialClient.original;
      } catch { /* An unreadable or partially written client file requires recovery. */ }
      if (!clientUnchanged) throw new Error(`${error.message} Claude settings changed during setup or could not be read. Cowork service configuration was retained; inspect the Claude backup and takeover journal before retrying.`, { cause: error });
      const current = loadConfig();
      if (isDeepStrictEqual(current.cowork, selected)) {
        if (before) {
          saveConfig({ ...current, cowork: before });
          try {
            let restored;
            try { restored = await status(); } catch { restored = await status(true); }
            verifiedStatus(restored, { model: before.model, directory: path.resolve(before.profileDirectory), effort: before.effort });
          } catch {
            throw new Error(`${error.message} Previous Cowork configuration was restored, but its service could not be verified. Restart Aerial before retrying.`, { cause: error });
          }
          throw new Error(`${error.message} Previous Cowork model and effort were restored; Claude settings were unchanged.`, { cause: error });
        }
        try {
          const response = await fetchImpl(`${base}/_aerial/cowork/close`, {
            method: "POST", headers, signal: AbortSignal.timeout(30000), redirect: "error"
          });
          const closed = await readJsonSafely(response);
          if (!response.ok || closed?.ok !== true || closed.provider !== "cowork" || closed.closed !== true) throw new Error("Cowork close was not confirmed.");
        } catch {
          throw new Error(`${error.message} The new Cowork session could not be closed. Its service configuration was retained so Aerial can shut it down; restart Aerial before retrying.`, { cause: error });
        }
        const latest = loadConfig();
        if (isDeepStrictEqual(latest.cowork, selected)) {
          if (before === undefined) delete latest.cowork;
          else latest.cowork = before;
          saveConfig(latest);
          throw new Error(`${error.message} The new Cowork session was closed and its configuration rolled back. Restart Aerial before retrying.`, { cause: error });
        }
      }
      throw new Error(`${error.message} Cowork configuration changed during setup and was preserved; review it before retrying.`, { cause: error });
    }
    throw error;
  }
}

export async function runCoworkSetupCli(args) {
  console.log("Checking the Cowork profile, local service and Claude version, then sending one brief Cowork request...");
  const result = await setupCoworkProvider({ model: requiredArgValue(args, "--model"), effort: requiredArgValue(args, "--effort"), configureOnly: args.includes("--configure-only") });
  const config = loadConfig();
  printSetupCompletionSummary({ heading: "Configured Claude Code for Cowork", cli: "Claude Code", model: result.model, effort: result.effort,
    proxy: localBaseUrl(config), configFile: result.file, aerialConfigFile: configPath(), aerialDefaultEffort: config.defaultEffort,
    backup: result.backup, auth: "apiKeyHelper local Aerial key", readiness: result.readiness, verbose: args.includes("--verbose"),
    notes: [...(result.status.experimentalTrial ? ["Cloud-tool isolation remains unverified; this profile explicitly enables an experimental trial."] : []),
      "Start claude normally. Project or managed settings may override user settings.",
      `Claude ${result.claudeVersion} was verified; rerun setup after changing Claude versions.`] });
  return result;
}
