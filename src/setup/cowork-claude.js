import fs from "node:fs";
import path from "node:path";
import { buildCoworkClaudeSettings, COWORK_CLIENT_EFFORTS } from "../cowork/launcher.js";
import { loadConfig } from "../shared/config.js";
import { claudeSettingsFile } from "../shared/paths.js";
import { localBaseUrl } from "../shared/urls.js";
import { logEvent } from "../shared/log.js";
import { claudeApiKeyHelper, isAerialKeyHelper } from "./auth-helper.js";
import { claudeEnvForAerial, claudeSettingsConflicts } from "./claude-conflicts.js";
import { backupIfExists, backupPathsFor } from "./restore.js";
import { writeClientTakeover } from "./takeover.js";
import { claudeSavedEffort } from "./claude-model.js";

export const DEFAULT_COWORK_EFFORT = "medium";
export { COWORK_CLIENT_EFFORTS };

export function readCoworkClaudeSettings() {
  const file = claudeSettingsFile();
  const original = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;
  let current;
  try { current = original === null ? {} : JSON.parse(original); }
  catch { throw new Error("Claude configuration is not valid JSON. Client configuration was not changed."); }
  if (!current || typeof current !== "object" || Array.isArray(current)) throw new Error("Claude configuration must be an object. Client configuration was not changed.");
  for (const field of ["env", "modelOverrides", "modelSettings"]) {
    if (current[field] !== undefined && (!current[field] || typeof current[field] !== "object" || Array.isArray(current[field]))) throw new Error(`Claude ${field} must be an object. Client configuration was not changed.`);
  }
  return { file, original, current };
}

export function persistentCoworkClaudeSettings({ model, effort = DEFAULT_COWORK_EFFORT, config, apiKeyHelper = claudeApiKeyHelper() }) {
  if (typeof model !== "string" || !/^cowork\/[a-z0-9._-]{1,180}$/.test(model)) throw new Error("Cowork setup requires an exact public Cowork model route.");
  if (!COWORK_CLIENT_EFFORTS.includes(effort)) throw new Error("Cowork effort must be low, medium, high, xhigh or max. No effort fallback was used.");
  // Reuse the tested client compatibility settings, replacing session-only auth
  // before anything is persisted. The local Aerial key stays in its key helper.
  const overlay = buildCoworkClaudeSettings({
    model, baseUrl: localBaseUrl(config), apiKey: "setup-placeholder-not-a-credential",
    capabilities: { clientEffort: effort }
  });
  for (const key of ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]) delete overlay.env[key];
  return { ...overlay, apiKeyHelper };
}

export function isCoworkClaudeSettings(doc) {
  return typeof doc?.model === "string" && doc.model.startsWith("cowork/");
}

export function coworkSavedEffort(doc) {
  const effort = doc?.env?.CLAUDE_CODE_EFFORT_LEVEL;
  if (effort === undefined) return claudeSavedEffort(doc);
  return { effort: COWORK_CLIENT_EFFORTS.includes(effort) ? effort : "missing", effortSource: "env",
    ...(!COWORK_CLIENT_EFFORTS.includes(effort) ? { invalidEffort: effort } : {}) };
}

export function environmentAfterCowork(doc, config) {
  if (!isCoworkClaudeSettings(doc) || doc.modelOverrides?.[doc.model] !== doc.model || !isAerialKeyHelper(doc.apiKeyHelper)) return doc.env;
  const savedEffort = coworkSavedEffort(doc).effort;
  // The GitHub environment normalizer always removes the effort selector;
  // the other compatibility values are identical across Cowork effort levels.
  const effort = COWORK_CLIENT_EFFORTS.includes(savedEffort) ? savedEffort : DEFAULT_COWORK_EFFORT;
  const expected = persistentCoworkClaudeSettings({ model: doc.model, effort, config }).env;
  // Only remove values still owned by Cowork. Preserve subsequent user edits;
  // full restoration of the pre-Aerial values remains the takeover journal's job.
  return Object.fromEntries(Object.entries(doc.env || {}).filter(([key, value]) => expected[key] !== value));
}

export function coworkClaudeSettingsConflicts(doc, config) {
  const effort = config.cowork?.effort;
  if (!COWORK_CLIENT_EFFORTS.includes(effort)) return [{ source: "aerial.cowork", key: "effort" }];
  let expected;
  try { expected = persistentCoworkClaudeSettings({ model: doc.model, effort, config }); }
  catch { return [{ source: "settings", key: "model" }]; }
  const conflicts = claudeSettingsConflicts(doc, config).filter(conflict => {
    if (conflict.source === "settings.env") return expected.env[conflict.key] !== doc.env?.[conflict.key];
    return conflict.key !== "alwaysThinkingEnabled";
  });
  if (config.cowork?.model !== doc.model) conflicts.push({ source: "aerial.cowork", key: "model" });
  for (const [key, value] of Object.entries(expected.env)) {
    if (doc.env?.[key] !== value) conflicts.push({ source: "settings.env", key });
  }
  for (const key of ["effortLevel", "alwaysThinkingEnabled"]) {
    if (doc[key] !== expected[key]) conflicts.push({ source: "settings", key });
  }
  if (doc.modelOverrides?.[doc.model] !== doc.model) conflicts.push({ source: "settings", key: "modelOverrides" });
  if (doc.modelSettings?.[doc.model]?.effortLevel !== (effort === "max" ? undefined : effort)) conflicts.push({ source: "settings", key: `modelSettings.${doc.model}.effortLevel` });
  return conflicts;
}

export function setupCoworkClaude({ model, effort = DEFAULT_COWORK_EFFORT, apiKeyHelper = claudeApiKeyHelper() }) {
  const config = loadConfig();
  const { file, original, current } = readCoworkClaudeSettings();
  const overlay = persistentCoworkClaudeSettings({ model, effort, config, apiKeyHelper });
  if (current.modelSettings?.[model] !== undefined && (!current.modelSettings[model] || typeof current.modelSettings[model] !== "object" || Array.isArray(current.modelSettings[model]))) throw new Error("Claude settings for the selected Cowork model must be an object. Client configuration was not changed.");
  const selectedSettings = { ...current.modelSettings?.[model] };
  delete selectedSettings.maxEffortLevel;
  delete selectedSettings.effortLevel;
  if (effort !== "max") selectedSettings.effortLevel = effort;
  const next = {
    ...current, ...overlay,
    env: { ...claudeEnvForAerial(current.env, config), ...overlay.env },
    modelSettings: { ...current.modelSettings, [model]: selectedSettings }
  };
  if (effort === "max") delete next.effortLevel;
  for (const key of ["maxEffortLevel", "availableModels", "enforceAvailableModels", "ultracode"]) delete next[key];
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const backup = backupIfExists(file);
  const takeover = writeClientTakeover({ target: "claude", file, original, next: `${JSON.stringify(next, null, 2)}\n`, backups: backupPathsFor(file) });
  logEvent("setup_write", { target: "claude", provider: "cowork", file, backup, model, effort });
  return { file, backup, ...takeover, model, clientModel: model, effort, apiKeyHelper };
}
