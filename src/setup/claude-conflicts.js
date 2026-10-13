import { localBaseUrl } from "../shared/urls.js";
import { claudeModelSettingsKey, claudeNativeModel } from "./claude-model.js";

const PROVIDER_FLAGS = new Set([
  "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_MANTLE", "CLAUDE_CODE_USE_ANTHROPIC_AWS", "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST"
]);
const ENV_CONFLICTS = new Set([
  "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_MODEL", "ANTHROPIC_DEFAULT_MODEL", "ANTHROPIC_SMALL_FAST_MODEL",
  "CLAUDE_CODE_SUBAGENT_MODEL", "CLAUDE_CODE_EFFORT_LEVEL", "MAX_THINKING_TOKENS"
]);
const isProviderEnv = key => PROVIDER_FLAGS.has(key) || ENV_CONFLICTS.has(key)
  || /^ANTHROPIC_DEFAULT_(OPUS|SONNET|HAIKU|FABLE)_MODEL(?:_|$)/.test(key)
  || /^ANTHROPIC_CUSTOM_MODEL_OPTION(?:_|$)/.test(key)
  || /^ANTHROPIC_(AWS|BEDROCK|BEDROCK_MANTLE|VERTEX|FOUNDRY)_(BASE_URL|API_KEY|AUTH_TOKEN)$/.test(key);
const active = value => value !== undefined && value !== null && String(value).trim() !== "";
const enabled = value => active(value) && !/^(0|false|no)$/i.test(String(value));

export function claudeEnvironmentConflicts(env, config, source = "environment") {
  return Object.entries(env || {}).filter(([key, value]) => {
    if (!active(value)) return false;
    if (PROVIDER_FLAGS.has(key)) return enabled(value);
    if (key === "ANTHROPIC_BASE_URL") return value !== localBaseUrl(config);
    if (key === "CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY") return String(value) !== "1";
    return isProviderEnv(key);
  }).map(([key]) => ({ source, key }));
}

export function assertClaudeEnvironment(config, env = process.env) {
  const conflicts = claudeEnvironmentConflicts(env, config);
  if (conflicts.length) throw new Error(`Claude is overridden by the launching shell: ${conflicts.map(item => item.key).join(", ")}. Clear these variables in the shell that launches Claude, then rerun aerial setup claude. Client configuration was not changed.`);
}

export function claudeEnvForAerial(env, config) {
  return {
    ...Object.fromEntries(Object.entries(env || {}).filter(([key]) => !isProviderEnv(key))),
    ANTHROPIC_BASE_URL: localBaseUrl(config),
    CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY: "1"
  };
}

export function claudeSettingsConflicts(doc, config) {
  const conflicts = claudeEnvironmentConflicts(doc?.env, config, "settings.env");
  for (const key of ["maxEffortLevel", "availableModels", "enforceAvailableModels"]) {
    if (doc?.[key] !== undefined) conflicts.push({ source: "settings", key });
  }
  if (doc?.alwaysThinkingEnabled === false) conflicts.push({ source: "settings", key: "alwaysThinkingEnabled" });
  if (doc?.ultracode === true) conflicts.push({ source: "settings", key: "ultracode" });
  const modelKey = claudeModelSettingsKey(doc?.model);
  if (doc?.modelSettings?.[modelKey]?.maxEffortLevel !== undefined) conflicts.push({ source: "settings", key: `modelSettings.${modelKey}.maxEffortLevel` });
  return conflicts;
}

export function claudeModelOverrides(models, selectedModel) {
  const overrides = {};
  for (const entry of models || []) {
    const native = claudeNativeModel(entry.id);
    if (native && !Object.hasOwn(overrides, native)) overrides[native] = entry.id;
  }
  const native = claudeNativeModel(selectedModel);
  if (native) overrides[native] = selectedModel;
  return overrides;
}
