import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { ensureApiKey, loadConfig, saveConfig } from "../shared/config.js";
import { logEvent } from "../shared/log.js";
import { atomicWriteFile } from "../shared/file-utils.js";
import { assertValidEffort, normalizeEffort } from "../shared/effort.js";
import { backupIfExists, backupPathsFor } from "./backup.js";
import { setTomlRootString, upsertTomlSection, removeTomlSection } from "./toml.js";

const DEFAULT_CODEX_AUTH = Object.freeze({
  command: "aerial",
  args: ["key", "print"],
  timeout_ms: 5000,
  refresh_interval_ms: 0
});
const DEFAULT_CLAUDE_API_KEY_HELPER = "aerial key print";

function ensureParent(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function claudeEnvForAerial(currentEnv, config) {
  const {
    ANTHROPIC_API_KEY,
    ANTHROPIC_AUTH_TOKEN,
    ANTHROPIC_MODEL,
    ANTHROPIC_DEFAULT_SONNET_MODEL,
    ANTHROPIC_DEFAULT_OPUS_MODEL,
    ...rest
  } = currentEnv || {};
  return {
    ...rest,
    ANTHROPIC_BASE_URL: `http://${config.host}:${config.port}`,
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1"
  };
}

export function setupCodex({ model, effort, authCommand = DEFAULT_CODEX_AUTH } = {}) {
  const normalizedEffort = effort === undefined ? undefined : assertValidEffort(effort);
  ensureApiKey();
  const config = loadConfig();
  const selectedModel = model || config.defaultModel;
  if (!selectedModel) {
    throw new Error("setupCodex requires a model id; pass --model or let `aerial setup codex` select one from live Copilot models.");
  }
  const file = codexConfigFile();
  ensureParent(file);
  const backup = backupIfExists(file);
  let content = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  content = setTomlRootString(content, "model_provider", "aerial");
  content = setTomlRootString(content, "model", selectedModel);
  if (normalizedEffort) content = setTomlRootString(content, "model_reasoning_effort", normalizedEffort);
  content = upsertTomlSection(content, "model_providers.aerial", {
    name: "Aerial",
    base_url: `http://${config.host}:${config.port}/v1`,
    wire_api: "responses"
  });
  content = upsertTomlSection(content, "model_providers.aerial.auth", {
    command: authCommand.command,
    args: authCommand.args || [],
    timeout_ms: authCommand.timeout_ms || DEFAULT_CODEX_AUTH.timeout_ms,
    refresh_interval_ms: authCommand.refresh_interval_ms ?? DEFAULT_CODEX_AUTH.refresh_interval_ms
  });
  content = removeTomlSection(content, "profiles.aerial");
  atomicWriteFile(file, content);
  if (normalizedEffort && config.defaultEffort !== normalizedEffort) {
    saveConfig({ ...config, defaultEffort: normalizedEffort });
  }
  logEvent("setup_write", { target: "codex", file, backup, auth: "command", effort: normalizedEffort });
  return { file, backup, model: selectedModel, effort: normalizedEffort, auth: { type: "command", command: authCommand.command, args: authCommand.args || [] } };
}

export function setupClaude({ model, effort, apiKeyHelper = DEFAULT_CLAUDE_API_KEY_HELPER } = {}) {
  const normalizedEffort = effort === undefined ? undefined : assertValidEffort(effort);
  ensureApiKey();
  const config = loadConfig();
  const selectedModel = model || config.defaultModel;
  const file = claudeSettingsFile();
  ensureParent(file);
  const backup = backupIfExists(file);
  const current = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  const next = {
    ...current,
    apiKeyHelper,
    env: claudeEnvForAerial(current.env, config)
  };
  if (selectedModel) next.model = selectedModel;
  if (normalizedEffort) next.effortLevel = normalizedEffort;
  atomicWriteFile(file, `${JSON.stringify(next, null, 2)}\n`);
  if (normalizedEffort && config.defaultEffort !== normalizedEffort) {
    saveConfig({ ...config, defaultEffort: normalizedEffort });
  }
  logEvent("setup_write", { target: "claude", file, backup, model: selectedModel, effort: normalizedEffort });
  return { file, backup, model: selectedModel, effort: normalizedEffort, apiKeyHelper };
}

function codexConfigFile() {
  return path.join(os.homedir(), ".codex", "config.toml");
}

function claudeSettingsFile() {
  return path.join(os.homedir(), ".claude", "settings.json");
}

function codexStateFromDoc(doc, expectedBaseUrl) {
  const providerSection = doc && typeof doc === "object" ? doc.model_providers?.aerial : undefined;
  const providerSet = doc?.model_provider === "aerial";
  const authArgs = Array.isArray(providerSection?.auth?.args) ? providerSection.auth.args : [];
  const authLooksAerial = typeof providerSection?.auth?.command === "string"
    && providerSection.auth.command.trim()
    && authArgs.slice(-2).join(" ") === "key print";
  const providerShapeComplete = providerSection
    && providerSection.wire_api === "responses"
    && (authLooksAerial || providerSection.env_key === "AERIAL_API_KEY")
    && typeof providerSection.base_url === "string";
  const providerBaseMatches = providerSection?.base_url === expectedBaseUrl;
  if (!providerSection && !providerSet) return "not-aerial";
  if (providerSet && providerShapeComplete && providerBaseMatches) return "aerial";
  if (providerShapeComplete) return "aerial-stale";
  return "aerial-drift";
}

export function codexStatus() {
  const config = loadConfig();
  const expectedBaseUrl = `http://${config.host}:${config.port}/v1`;
  const file = codexConfigFile();
  const backups = backupPathsFor(file);
  if (!fs.existsSync(file)) return { target: "codex", state: "missing", file, backups, effort: "missing" };
  let content;
  try {
    content = fs.readFileSync(file, "utf8");
  } catch (err) {
    return { target: "codex", state: "invalid", file, backups, error: err.message, effort: "missing" };
  }
  let doc;
  try {
    doc = parseToml(content);
  } catch (err) {
    return { target: "codex", state: "invalid", file, backups, error: err.message, effort: "missing" };
  }
  const state = codexStateFromDoc(doc, expectedBaseUrl);
  const model = typeof doc?.model === "string" ? doc.model : undefined;
  const baseUrl = typeof doc?.model_providers?.aerial?.base_url === "string"
    ? doc.model_providers.aerial.base_url
    : undefined;
  const rootEffort = doc?.model_reasoning_effort;
  const effort = typeof rootEffort === "string" ? (normalizeEffort(rootEffort) || "missing") : "missing";
  const legacyProfile = doc?.profiles?.aerial && typeof doc.profiles.aerial === "object";
  const legacyProfileLooksAerial = legacyProfile
    && (doc.profiles.aerial.model_provider === "aerial"
      || typeof doc.profiles.aerial.model_reasoning_effort === "string");
  const needsMigration = legacyProfile && (state !== "not-aerial" || legacyProfileLooksAerial);
  return {
    target: "codex",
    state,
    file,
    backups,
    model,
    baseUrl,
    effort,
    ...(needsMigration ? { migration: "run aerial setup codex" } : {})
  };
}

function claudeStateFromDoc(doc, expectedBaseUrl) {
  const helperIsAerial = typeof doc?.apiKeyHelper === "string" && /\bkey\s+print\b/.test(doc.apiKeyHelper);
  const baseUrl = doc?.env?.ANTHROPIC_BASE_URL;
  const baseUrlMatches = baseUrl === expectedBaseUrl;
  const baseUrlAerialShape = typeof baseUrl === "string" && /^http:\/\/127\.0\.0\.1:\d+/.test(baseUrl);
  const hasAerialTrace = helperIsAerial || baseUrlAerialShape;
  if (!hasAerialTrace) return "not-aerial";
  if (helperIsAerial && baseUrlMatches) return "aerial";
  if (helperIsAerial && typeof baseUrl === "string" && !baseUrlMatches) return "aerial-stale";
  return "aerial-drift";
}

export function claudeStatus() {
  const config = loadConfig();
  const expectedBaseUrl = `http://${config.host}:${config.port}`;
  const file = claudeSettingsFile();
  const backups = backupPathsFor(file);
  const fallbackEffort = typeof config.defaultEffort === "string" && config.defaultEffort.trim() ? config.defaultEffort.trim() : "missing";
  if (!fs.existsSync(file)) return { target: "claude", state: "missing", file, backups, effort: fallbackEffort };
  let doc;
  try {
    doc = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    return { target: "claude", state: "invalid", file, backups, error: err.message, effort: fallbackEffort };
  }
  const state = claudeStateFromDoc(doc, expectedBaseUrl);
  const model = typeof doc?.model === "string" ? doc.model : undefined;
  const baseUrl = doc?.env?.ANTHROPIC_BASE_URL;
  const settingsEffort = typeof doc?.effortLevel === "string" ? normalizeEffort(doc.effortLevel) : undefined;
  const effort = settingsEffort || fallbackEffort;
  return { target: "claude", state, file, backups, model, baseUrl, effort };
}

function validateTomlBackup(content) {
  try {
    parseToml(content.toString("utf8"));
  } catch (err) {
    throw new Error(`Restore aborted: backup is not valid TOML (${err.message}). Live file left unchanged.`);
  }
}

function validateJsonBackup(content) {
  try {
    JSON.parse(content.toString("utf8"));
  } catch (err) {
    throw new Error(`Restore aborted: backup is not valid JSON (${err.message}). Live file left unchanged.`);
  }
}

export const CLIENTS = Object.freeze({
  codex: Object.freeze({
    target: "codex",
    file: codexConfigFile,
    status: codexStatus,
    validateBackup: validateTomlBackup
  }),
  claude: Object.freeze({
    target: "claude",
    file: claudeSettingsFile,
    status: claudeStatus,
    validateBackup: validateJsonBackup
  })
});
