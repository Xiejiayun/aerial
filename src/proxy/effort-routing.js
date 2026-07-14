import { loadConfig } from "../shared/config.js";
import { logEvent } from "../shared/log.js";
import { EFFORT_VALUES, normalizeCodexEffort, normalizeEffort, resolveCodexEffort } from "../shared/effort.js";
import {
  canonicalClaudeFamily,
  findCompatibleModel as findCompatibleModelShared,
  supportedReasoningEfforts
} from "./model-catalog.js";
import { withDefaultAnthropicCache, withDefaultPromptCache } from "./cache-policy.js";

function openAIEffortRoute(model, effort, supportedEfforts) {
  if (effort === undefined) return undefined;
  const normalized = normalizeCodexEffort(effort);
  if (!normalized) return undefined;
  const requested = String(effort).trim().toLowerCase();
  const resolved = resolveCodexEffort(normalized, supportedEfforts);
  if (!resolved) return undefined;
  const hasSupportedEffortMetadata = Array.isArray(supportedEfforts)
    && supportedEfforts.some((value) => normalizeCodexEffort(value));
  if (!hasSupportedEffortMetadata && /^gpt-5-mini(?:-|$)/.test(model) && resolved.wireEffort === "xhigh") {
    return { effort: "high", reason: "model_compatibility" };
  }
  if (resolved.wireEffort === requested) return undefined;
  return { effort: resolved.wireEffort, reason: resolved.reason };
}

async function withSupportedOpenAIEffort(payload, loadModels) {
  const model = typeof payload?.model === "string" ? payload.model : "";
  const reasoningEffort = payload?.reasoning && typeof payload.reasoning === "object" ? payload.reasoning.effort : undefined;
  const flatEffort = payload?.reasoning_effort;
  const hasKnownEffort = normalizeCodexEffort(reasoningEffort) || normalizeCodexEffort(flatEffort);
  const models = hasKnownEffort && typeof loadModels === "function"
    ? await loadModels().catch(() => undefined)
    : undefined;
  const selectedModel = Array.isArray(models) ? models.find((entry) => entry?.id === model) : undefined;
  const supportedEfforts = selectedModel ? supportedReasoningEfforts(selectedModel) : undefined;
  const nextReasoningEffort = openAIEffortRoute(model, reasoningEffort, supportedEfforts);
  const nextFlatEffort = openAIEffortRoute(model, flatEffort, supportedEfforts);
  if (!nextReasoningEffort && !nextFlatEffort) return payload;

  const next = { ...payload };
  if (nextReasoningEffort) next.reasoning = { ...payload.reasoning, effort: nextReasoningEffort.effort };
  if (nextFlatEffort) next.reasoning_effort = nextFlatEffort.effort;
  logEvent("openai_effort_route", {
    model,
    effort: reasoningEffort ?? flatEffort,
    routedEffort: nextReasoningEffort?.effort ?? nextFlatEffort?.effort,
    reason: nextReasoningEffort?.reason ?? nextFlatEffort?.reason
  });
  return next;
}

export async function withOpenAIDefaults(payload, loadModels) {
  return withDefaultPromptCache(await withSupportedOpenAIEffort(payload, loadModels));
}

function objectOrEmpty(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function closestSupportedEffort(model, requestedEffort) {
  const requestedRank = EFFORT_VALUES.indexOf(requestedEffort);
  if (requestedRank === -1) return undefined;
  const supported = supportedReasoningEfforts(model)
    .map((effort) => normalizeEffort(effort))
    .filter((effort, index, values) => effort && values.indexOf(effort) === index);
  if (supported.includes(requestedEffort)) return requestedEffort;
  if (supported.length === 0) return undefined;
  const ranked = supported
    .map((effort) => ({ effort, rank: EFFORT_VALUES.indexOf(effort) }))
    .filter((entry) => entry.rank !== -1)
    .sort((a, b) => a.rank - b.rank);
  const lowerOrEqual = ranked.filter((entry) => entry.rank <= requestedRank);
  return (lowerOrEqual.at(-1) || ranked[0])?.effort;
}

function preferredModel(models, modelId) {
  if (!Array.isArray(models)) return undefined;
  return models.find((model) => model?.id === modelId);
}

function fallbackModelForFamily(models, family, preferredId) {
  const exact = preferredModel(models, preferredId);
  if (exact) return exact;
  const base = preferredModel(models, family);
  if (!base) return undefined;
  return findCompatibleModelShared({
    models: [base],
    family,
    route: "/v1/messages",
    adaptiveThinking: true
  });
}

function withSupportedAnthropicEffort(payload, models) {
  const effort = payload?.output_config?.effort;
  if (effort === undefined) return payload;
  const model = typeof payload?.model === "string" ? payload.model : "";
  const family = canonicalClaudeFamily(model);
  if (!family) return payload;
  const nextEffort = normalizeEffort(effort);
  if (!nextEffort || !EFFORT_VALUES.includes(nextEffort)) return payload;
  let routedEffort = nextEffort;
  let routed = findCompatibleModelShared({
    models,
    family,
    route: "/v1/messages",
    adaptiveThinking: true,
    effort: routedEffort,
    preferredId: model
  });
  if (!routed) {
    const fallbackEffort = closestSupportedEffort(fallbackModelForFamily(models, family, model), nextEffort);
    if (fallbackEffort && fallbackEffort !== nextEffort) {
      routedEffort = fallbackEffort;
      routed = findCompatibleModelShared({
        models,
        family,
        route: "/v1/messages",
        adaptiveThinking: true,
        effort: routedEffort,
        preferredId: model
      });
    }
  }
  const nextModel = routed?.id || model;
  if (model === nextModel && effort === routedEffort) return payload;
  logEvent("anthropic_effort_route", { model, effort, routedModel: nextModel, routedEffort });
  return { ...payload, model: nextModel, output_config: { ...payload.output_config, effort: routedEffort } };
}

function legacyThinkingEffort(thinking) {
  if (typeof thinking?.effort === "string" && thinking.effort.trim()) return thinking.effort.trim();
  const budget = Number(thinking?.budget_tokens);
  if (!Number.isFinite(budget) || budget <= 0) return "medium";
  if (budget <= 4096) return "low";
  if (budget <= 16000) return "medium";
  if (budget <= 64000) return "high";
  return "xhigh";
}

function isLegacyThinkingEnabled(thinking) {
  if (!thinking || typeof thinking !== "object" || Array.isArray(thinking)) return false;
  if (thinking.type === "enabled") return true;
  return Boolean(thinking.type && typeof thinking.type === "object" && thinking.type.enabled);
}

function withSupportedAnthropicThinking(payload) {
  if (!isLegacyThinkingEnabled(payload?.thinking)) return payload;
  const outputConfig = objectOrEmpty(payload?.output_config);
  const effort = outputConfig.effort ?? legacyThinkingEffort(payload.thinking);
  logEvent("anthropic_thinking_route", { model: payload.model, routedType: "adaptive", routedEffort: effort });
  return {
    ...payload,
    thinking: { type: "adaptive" },
    output_config: { ...outputConfig, effort }
  };
}

function shouldLoadAnthropicCatalog(payload) {
  const effort = payload?.output_config?.effort;
  const model = typeof payload?.model === "string" ? payload.model : "";
  return effort !== undefined && Boolean(canonicalClaudeFamily(model));
}

function withDefaultAnthropicEffort(payload) {
  if (payload?.output_config?.effort !== undefined) return payload;
  if (payload?.thinking?.type === "adaptive") return payload;
  const model = typeof payload?.model === "string" ? payload.model : "";
  if (!canonicalClaudeFamily(model)) return payload;
  const config = loadConfig();
  const effort = config.defaultEffort || "medium";
  const outputConfig = objectOrEmpty(payload?.output_config);
  logEvent("anthropic_default_effort", { model, effort });
  return { ...payload, output_config: { ...outputConfig, effort } };
}

export async function withAnthropicDefaults(payload, loadModels) {
  const cached = withDefaultAnthropicCache(payload);
  const thinkingApplied = withSupportedAnthropicThinking(cached);
  const next = withDefaultAnthropicEffort(thinkingApplied);
  const models = shouldLoadAnthropicCatalog(next)
    ? await loadModels().catch(() => undefined)
    : undefined;
  return withSupportedAnthropicEffort(next, models);
}
